(function () {
  "use strict";
  const M = globalThis.BNModel, P = globalThis.BNPyAgrum;
  const STORAGE_KEY = "bn-editor-network";
  const EVIDENCE_KEY = "bn-editor-evidence";
  const PROBS_KEY = "bn-editor-show-probabilities";
  const SOFT_KEY = "bn-editor-soft-evidence";
  const SOFT_KIND_KEY = "bn-editor-soft-kind";
  const SRC_KEY = "bn-editor-loaded-src";
  const NODE_H = 50;
  // probability view: header, then one row per state with a bar
  const PROB_HEAD = 30, PROB_ROW = 18, PROB_BAR = 64, PROB_PCT = 44, PROB_LABEL_MAX = 110;

  const $ = (s) => document.querySelector(s);
  const svg = $("#canvas"), viewport = $("#viewport"), panel = $("#panel"), inline = $("#inline-edit");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  let net;
  let selNodes = new Set();
  let selArc = null; // {from, to}
  let view = { x: 0, y: 0, k: 1 };
  let undoStack = [], redoStack = [];
  let drag = null;
  let lastPointer = null; // world coordinates of the pointer, used by the N shortcut
  let showProbs = localStorage.getItem(PROBS_KEY) !== "0";
  // node id -> observed state label (hard evidence), one likelihood per state (soft evidence), or
  // {target: probabilities} (soft evidence that sets the node's probabilities).
  // Editor state, not part of undo.
  let evidence = new Map();
  try { evidence = new Map(JSON.parse(localStorage.getItem(EVIDENCE_KEY)) || []); } catch {}
  let inferenceCache = null;
  let softMode = localStorage.getItem(SOFT_KEY) === "1";
  let softId = null; // node whose soft evidence editor is open
  // How the soft evidence editor enters evidence: "likelihoods" or "probabilities" (targets).
  let softKind = localStorage.getItem(SOFT_KIND_KEY) === "probabilities" ? "probabilities" : "likelihoods";
  const isTarget = (v) => !!(v && v.target);

  // ------------------------------------------------------------ state & history

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.nodes)) return saved;
    } catch {}
    return BNDemos[0].build();
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(net));
  }

  // Records the current state for undo. Call before mutating `net`.
  function checkpoint() {
    undoStack.push(JSON.stringify(net));
    if (undoStack.length > 300) undoStack.shift();
    redoStack = [];
    updateButtons();
  }

  function change(fn) {
    checkpoint();
    const result = fn();
    refresh();
    return result;
  }

  function refresh() {
    pruneSelection();
    inferenceCache = null;
    save();
    render();
    cpt.render(cptNodeId());
    schedulePanel();
    updateButtons();
  }

  const cptNodeId = () => (!selArc && selNodes.size === 1 ? [...selNodes][0] : null);

  // The panel is rebuilt after the current event finishes, so that a click which blurred (and
  // committed) one panel field can still move focus to the field that was clicked.
  let panelTimer = null;
  function schedulePanel() {
    if (panelTimer === null) panelTimer = setTimeout(() => { panelTimer = null; renderPanel(); });
  }

  // Renders a pending panel update now, for edits made from the keyboard or a click inside the
  // panel, so keys typed right after them reach the re-rendered fields.
  function flushPanel() {
    if (panelTimer === null) return;
    clearTimeout(panelTimer);
    panelTimer = null;
    renderPanel();
  }

  function restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(net));
    net = JSON.parse(from.pop());
    refresh();
  }
  const undo = () => restore(undoStack, redoStack);
  const redo = () => restore(redoStack, undoStack);

  function updateButtons() {
    document.querySelector('[data-action="undo"]').disabled = !undoStack.length;
    document.querySelector('[data-action="redo"]').disabled = !redoStack.length;
  }

  function pruneSelection() {
    for (const id of selNodes) if (!M.getNode(net, id)) selNodes.delete(id);
    if (selArc && !M.hasArc(net, selArc.from, selArc.to)) selArc = null;
  }

  function select(ids, arc = null) {
    selNodes = new Set(ids);
    selArc = arc;
    render();
    renderPanel();
    cpt.render(cptNodeId());
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ------------------------------------------------------------ geometry

  const measureCtx = document.createElement("canvas").getContext("2d");
  function textWidth(s, font) {
    measureCtx.font = font;
    return measureCtx.measureText(s).width;
  }
  function nodeWidth(n) {
    return Math.max(84, Math.ceil(textWidth(n.name, "600 14px system-ui, sans-serif")) + 30);
  }
  function labelWidth(n) {
    return Math.min(PROB_LABEL_MAX, Math.max(...n.labels.map((l) => Math.ceil(textWidth(l, "12px system-ui, sans-serif")))));
  }
  function nodeSize(n) {
    if (!showProbs) return { w: nodeWidth(n), h: NODE_H };
    return {
      w: Math.max(nodeWidth(n), 10 + labelWidth(n) + 8 + PROB_BAR + PROB_PCT + 6),
      h: PROB_HEAD + n.labels.length * PROB_ROW + 8,
    };
  }
  function truncate(text, font, maxW) {
    if (textWidth(text, font) <= maxW) return text;
    while (text.length > 1 && textWidth(text + "…", font) > maxW) text = text.slice(0, -1);
    return text + "…";
  }

  function toWorld(e) {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  }

  // Point where the segment from b's centre towards a leaves b's box (with margin).
  function boxExit(b, size, ax, ay, margin) {
    const dx = ax - b.x, dy = ay - b.y;
    const hw = size.w / 2 + margin, hh = size.h / 2 + margin;
    const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return t >= 1 ? { x: b.x, y: b.y } : { x: b.x + dx * t, y: b.y + dy * t };
  }

  function fit() {
    if (!net.nodes.length) { view = { x: 0, y: 0, k: 1 }; applyView(); return; }
    const r = svg.getBoundingClientRect();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of net.nodes) {
      const { w, h } = nodeSize(n);
      x0 = Math.min(x0, n.x - w / 2); x1 = Math.max(x1, n.x + w / 2);
      y0 = Math.min(y0, n.y - h / 2); y1 = Math.max(y1, n.y + h / 2 + 10);
    }
    const pad = 50, top = showProbs ? 50 : 0; // room for the evidence bar
    const k = Math.min(1.4, (r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad - top) / (y1 - y0));
    view = { k, x: r.width / 2 - ((x0 + x1) / 2) * k, y: (r.height + top) / 2 - ((y0 + y1) / 2) * k };
    applyView();
  }

  function applyView() {
    viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
    // The dot grid lives in the SVG, so it moves exactly with the nodes. Zoomed out, every 2nd
    // (4th, ...) dot is kept so the dots stay at least 14px apart instead of blurring together.
    let step = 20 * view.k;
    while (step < 14) step *= 2;
    const dots = $("#grid-dots");
    dots.setAttribute("width", step);
    dots.setAttribute("height", step);
    dots.setAttribute("x", view.x - step / 2);
    dots.setAttribute("y", view.y - step / 2);
    dots.firstElementChild.setAttribute("cx", step / 2);
    dots.firstElementChild.setAttribute("cy", step / 2);
    if (!inline.hidden) positionInline();
    positionSoftEditor();
  }

  // ------------------------------------------------------------ rendering

  function render() {
    const parts = [];
    const widths = new Map(net.nodes.map((n) => [n.id, nodeSize(n)]));
    const inf = showProbs ? inference() : null;
    for (const a of net.arcs) {
      const f = M.getNode(net, a.from), t = M.getNode(net, a.to);
      const p1 = boxExit(f, widths.get(f.id), t.x, t.y, 0);
      const p2 = boxExit(t, widths.get(t.id), f.x, f.y, 2);
      const sel = selArc && selArc.from === a.from && selArc.to === a.to;
      const d = `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
      parts.push(`<g class="arc${sel ? " selected" : ""}" data-from="${a.from}" data-to="${a.to}"><path class="hit" d="${d}"/><path class="line" d="${d}" marker-end="url(#${sel ? "arrow-sel" : "arrow"})"/></g>`);
    }
    for (const n of net.nodes) {
      const { w, h } = widths.get(n.id);
      const classes = ["node"];
      if (selNodes.has(n.id)) classes.push("selected");
      if (drag && drag.mode === "arc" && drag.target === n.id) classes.push("target");
      const observed = inf ? evidenceIndices().get(n.id) : undefined;
      if (observed !== undefined) classes.push(typeof observed === "object" ? "soft-observed" : "observed");
      const bad = M.badRows(n).length > 0;
      let content;
      if (inf) {
        const probs = inf.marginals && inf.marginals.get(n.id);
        const lw = labelWidth(n), barX = -w / 2 + 10 + lw + 8;
        content = `<text class="name" text-anchor="middle" y="${-h / 2 + 20}">${esc(n.name)}</text>` +
          n.labels.map((l, s) => {
            const y = -h / 2 + PROB_HEAD + s * PROB_ROW;
            const p = probs ? probs[s] : null;
            const pct = p === null ? "–" : p >= 0.9995 ? "100%" : (p * 100).toFixed(1) + "%";
            return `<g class="state-row${observed === s ? " observed" : ""}" data-state="${s}">` +
              `<rect class="row-hit" x="${-w / 2 + 4}" y="${y}" width="${w - 8}" height="${PROB_ROW}" rx="3"/>` +
              `<text class="slabel" x="${-w / 2 + 10}" y="${y + 13}">${esc(truncate(l, "12px system-ui, sans-serif", lw))}</text>` +
              `<rect class="pbar-bg" x="${barX}" y="${y + 4}" width="${PROB_BAR}" height="10" rx="2"/>` +
              (p ? `<rect class="pbar" x="${barX}" y="${y + 4}" width="${PROB_BAR * p}" height="10" rx="2"/>` : "") +
              `<text class="pct" x="${w / 2 - 8}" y="${y + 13}" text-anchor="end">${pct}</text></g>`;
          }).join("");
      } else {
        content = `<text class="name" text-anchor="middle" y="-3">${esc(n.name)}</text>` +
          `<text class="states" text-anchor="middle" y="14">${esc(truncate(n.labels.join(" · "), "11px system-ui, sans-serif", w - 16))}</text>`;
      }
      const tip = !showProbs ? "" : softMode ? "\nClick a state to enter soft evidence for this node" : "\nClick a state to set or clear it as evidence";
      parts.push(
        `<g class="${classes.join(" ")}" data-node="${n.id}" transform="translate(${n.x},${n.y})">` +
          `<title>${esc(n.name)}${n.description ? " — " + esc(n.description) : ""}\n${esc(n.labels.join(", "))}${bad ? "\nCPT rows do not sum to 1" : ""}${tip}</title>` +
          `<rect class="body" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="9"/>` +
          content +
          (bad ? `<circle class="bad" cx="${w / 2 - 8}" cy="${-h / 2 + 8}" r="4"/>` : "") +
          `<circle class="port" data-port="${n.id}" cx="0" cy="${h / 2}" r="6"/>` +
        `</g>`
      );
    }
    if (drag && drag.mode === "arc" && drag.moved) {
      const f = M.getNode(net, drag.from);
      const t = drag.target ? M.getNode(net, drag.target) : null;
      const p2 = t ? boxExit(t, widths.get(t.id), f.x, f.y, 2) : drag.pos;
      const p1 = boxExit(f, widths.get(f.id), p2.x, p2.y, 0);
      parts.push(`<path class="ghost" d="M${p1.x},${p1.y} L${p2.x},${p2.y}" marker-end="url(#arrow-sel)"/>`);
    }
    if (drag && drag.mode === "rubber") {
      const r = rubberRect();
      parts.push(`<rect class="rubber" x="${r.x0}" y="${r.y0}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}"/>`);
    }
    viewport.innerHTML = parts.join("");
    renderEvidenceBar(inf);
    positionSoftEditor();
    if (!net.nodes.length) {
      viewport.innerHTML += `<text x="${(svg.clientWidth / 2 - view.x) / view.k}" y="${(svg.clientHeight / 2 - view.y) / view.k}" text-anchor="middle" fill="currentColor" opacity="0.45">Double-click anywhere to add a node, or load one from Demo</text>`;
    }
  }

  // ------------------------------------------------------------ inference & evidence

  // Evidence as node id -> state index (hard), likelihood array or {target} (soft), skipping entries
  // whose node or state no longer exists, or whose values no longer match the node's states.
  function evidenceIndices(labels = evidence) {
    const out = new Map();
    for (const [id, v] of labels) {
      const n = M.getNode(net, id);
      if (!n) continue;
      if (Array.isArray(v)) {
        if (v.length === n.labels.length && v.some((x) => x > 0)) out.set(id, v.slice());
      } else if (isTarget(v)) {
        const sum = v.target.reduce((a, b) => a + b, 0);
        if (v.target.length === n.labels.length && sum > 0) out.set(id, { target: v.target.map((q) => q / sum) });
      } else {
        const s = n.labels.indexOf(v);
        if (s >= 0) out.set(id, s);
      }
    }
    return out;
  }

  function inference() {
    if (!inferenceCache) inferenceCache = BNInference.posteriors(net, evidenceIndices());
    return inferenceCache;
  }

  function saveEvidence() {
    localStorage.setItem(EVIDENCE_KEY, JSON.stringify([...evidenceIndices()].map(([id, v]) => [id, typeof v === "object" ? v : M.getNode(net, id).labels[v]])));
  }

  function setEvidence(next) {
    const result = BNInference.posteriors(net, evidenceIndices(next));
    if (result.error && /impossible/.test(result.error)) { toast(result.error); return false; }
    evidence = next;
    inferenceCache = result;
    saveEvidence();
    render();
    return true;
  }

  function toggleEvidence(id, s) {
    const n = M.getNode(net, id);
    const next = new Map(evidence);
    if (next.get(id) === n.labels[s]) next.delete(id);
    else next.set(id, n.labels[s]);
    setEvidence(next);
  }

  function clearEvidence() {
    hideSoftEditor();
    evidence = new Map();
    inferenceCache = null;
    saveEvidence();
  }

  function toggleProbs() {
    showProbs = !showProbs;
    localStorage.setItem(PROBS_KEY, showProbs ? "1" : "0");
    document.querySelector('[data-action="probs"]').setAttribute("aria-pressed", showProbs);
    render();
    if (!inline.hidden) positionInline();
  }

  const fmtPct = (q) => +(q * 100).toPrecision(3) + "%";
  const onlyTargets = (ev) => [...ev.values()].every(isTarget);

  const evidenceBar = $("#evidence-bar");
  function renderEvidenceBar(inf) {
    evidenceBar.hidden = !inf || !net.nodes.length;
    if (evidenceBar.hidden) return;
    const ev = evidenceIndices();
    const fmtP = (p) => (p >= 0.001 ? +p.toPrecision(3) : p.toExponential(2));
    const toggle = `<label class="check" title="Off: clicking a state observes it for certain. On: clicking a state opens an editor where you either set the node's probabilities directly, or give likelihoods: how likely the observation is under each of the node's states, as in pyAgrum's setEvidence({&quot;x&quot;: [0.2, 0.8]}).">` +
      `<input type="checkbox" data-soft-mode${softMode ? " checked" : ""}> Soft evidence</label>`;
    let body;
    if (inf.error) {
      body = `<span class="warn">${esc(inf.error)}</span>`;
    } else if (!ev.size) {
      body = `<span class="muted">${softMode
        ? "Click a state in any node to enter soft evidence (probabilities or likelihoods) for that node."
        : "Click a state in any node to observe it; every other node then shows its updated probabilities."}</span>`;
    } else {
      const chip = ([id, v]) => {
        const n = M.getNode(net, id);
        if (isTarget(v)) {
          const pcts = v.target.map(fmtPct).join(" : ");
          return `<span class="ev-chip soft" data-edit-ev="${id}" title="Soft evidence: the probabilities of ${esc(n.labels.join(" : "))} are set to ${pcts}. Click to edit.">${esc(n.name)} → ${pcts}<button class="icon" data-clear-ev="${id}" title="Remove this evidence">✕</button></span>`;
        }
        if (!Array.isArray(v)) return `<span class="ev-chip">${esc(n.name)} = ${esc(n.labels[v])}<button class="icon" data-clear-ev="${id}" title="Remove this evidence">✕</button></span>`;
        const lik = v.map((x) => +x.toPrecision(2)).join(" : ");
        return `<span class="ev-chip soft" data-edit-ev="${id}" title="Soft evidence: likelihood of the observation for ${esc(n.labels.join(" : "))}. Click to edit.">${esc(n.name)} ≈ ${lik}<button class="icon" data-clear-ev="${id}" title="Remove this evidence">✕</button></span>`;
      };
      body = `<span class="ev-label">Evidence</span>` + [...ev].map(chip).join("") +
        (onlyTargets(ev) ? "" : `<span class="muted" title="Probability of all the evidence together, before observing it${[...ev.values()].some(isTarget) ? " (probabilities you set directly aren't observations, so they aren't included)" : ""}">P(evidence) = ${fmtP(inf.pEvidence)}</span>`) +
        `<button class="small" data-clear-ev="all">Clear all</button>`;
    }
    evidenceBar.innerHTML = body + `<span class="sep"></span>` + toggle;
  }
  evidenceBar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-clear-ev]");
    if (b) {
      const next = new Map(evidence);
      if (b.dataset.clearEv === "all") next.clear();
      else next.delete(+b.dataset.clearEv);
      if (b.dataset.clearEv === "all" || +b.dataset.clearEv === softId) hideSoftEditor();
      setEvidence(next);
      return;
    }
    const chip = e.target.closest("[data-edit-ev]");
    if (chip) openSoftEditor(+chip.dataset.editEv);
  });
  evidenceBar.addEventListener("change", (e) => {
    if (!e.target.matches("[data-soft-mode]")) return;
    softMode = e.target.checked;
    localStorage.setItem(SOFT_KEY, softMode ? "1" : "0");
    if (!softMode) closeSoftEditor();
    render();
  });

  // ------------------------------------------------------------ soft evidence editor

  const softEditor = $("#soft-editor");
  const isNeutral = (lik) => lik.every((x) => Math.abs(x - lik[0]) <= 1e-9 * Math.max(...lik));

  // The values the editor shows for the node, in the given kind. Switching kinds converts the
  // current evidence, so the node's probabilities stay the same.
  function softValues(id, kind = softKind) {
    const n = M.getNode(net, id);
    const cur = evidenceIndices().get(id);
    if (kind === "probabilities") {
      if (isTarget(cur)) return cur.target;
      const p = inference().marginals?.get(id);
      return p ? p.slice() : n.labels.map(() => 1 / n.labels.length);
    }
    if (Array.isArray(cur)) return cur;
    if (isTarget(cur)) return inference().likelihoods?.get(id) || n.labels.map(() => 1);
    if (typeof cur === "number") return n.labels.map((_, s) => (s === cur ? 1 : 0));
    return n.labels.map(() => 1);
  }

  const softEntry = (vals) => (softKind === "probabilities" ? { target: vals } : vals);
  // Probabilities are shown in percent.
  const softShown = (v) => (softKind === "probabilities" ? +(v * 100).toPrecision(4) : +v.toPrecision(4));

  function openSoftEditor(id, focusState = 0) {
    if (softId !== null && softId !== id) closeSoftEditor();
    const n = M.getNode(net, id);
    const cur = evidenceIndices().get(id);
    if (Array.isArray(cur)) softKind = "likelihoods";
    else if (isTarget(cur)) softKind = "probabilities";
    softId = id;
    const vals = softValues(id);
    const probs = softKind === "probabilities";
    const kindButton = (k, label, title) => `<button type="button" class="small${softKind === k ? " on" : ""}" data-soft-kind="${k}" title="${title}">${label}</button>`;
    softEditor.innerHTML = `
      <div class="soft-head"><b>${esc(n.name)}</b><span class="muted">soft evidence</span><span class="grow"></span><button class="icon" data-soft-close title="Close (Esc)">✕</button></div>
      <div class="seg-toggle soft-kind">${kindButton("probabilities", "Probabilities", "Set what the node's probabilities should be after all the evidence (Jeffrey's rule)")}${kindButton("likelihoods", "Likelihoods", "Say how likely the observation is under each state, as in pyAgrum's setEvidence")}</div>
      <p class="muted">${probs
        ? `What should the probabilities of <b>${esc(n.name)}</b> be? They always add up to 100%: changing one rescales the others. The rest of the network updates to match.`
        : `How likely is what you observed if <b>${esc(n.name)}</b> is in each state? Only the ratios matter: 1 : 0 is the same as observing the first state for certain, and equal values mean no evidence.`}</p>
      ${n.labels.map((l, s) => `<div class="soft-row">
        <span class="slabel" title="${esc(l)}">${esc(l)}</span>
        <input type="range" min="0" max="${probs ? 100 : 1}" step="${probs ? 1 : 0.01}" data-lik="${s}" value="${softShown(vals[s])}">
        <span class="soft-num"><input type="number" min="0"${probs ? ' max="100"' : ""} step="${probs ? 1 : 0.01}" data-lik="${s}" value="${softShown(vals[s])}">${probs ? "%" : ""}</span>
      </div>`).join("")}
      <div class="soft-actions"><button class="small" data-soft-reset>Reset</button><button class="small danger" data-soft-remove>Remove</button><span class="grow"></span><button class="small primary" data-soft-close>Done</button></div>`;
    softEditor.hidden = false;
    const next = new Map(evidence);
    next.set(id, softEntry(vals.slice()));
    setEvidence(next); // renders, which positions the editor
    const input = softEditor.querySelector(`input[type="number"][data-lik="${focusState}"]`);
    if (input) { input.focus(); input.select(); }
  }

  function syncSoftInputs(except) {
    const vals = softValues(softId);
    softEditor.querySelectorAll("[data-lik]").forEach((input) => {
      if (input !== except) input.value = softShown(vals[+input.dataset.lik]);
    });
  }

  function hideSoftEditor() {
    softEditor.hidden = true;
    softId = null;
  }

  // Closes the editor; equal likelihoods carry no information, so they are dropped.
  function closeSoftEditor() {
    if (softId === null) return;
    const id = softId;
    hideSoftEditor();
    const cur = evidence.get(id);
    const lik = isTarget(cur) ? inference().likelihoods?.get(id) : cur;
    if (Array.isArray(lik) && isNeutral(lik)) {
      const next = new Map(evidence);
      next.delete(id);
      setEvidence(next);
    }
  }

  function positionSoftEditor() {
    if (softId === null) return;
    const n = M.getNode(net, softId);
    if (!n || !showProbs) { hideSoftEditor(); return; }
    const { w, h } = nodeSize(n);
    const wrap = $("#canvas-wrap").getBoundingClientRect();
    const ew = softEditor.offsetWidth, eh = softEditor.offsetHeight;
    let x = view.x + (n.x + w / 2) * view.k + 10;
    if (x + ew > wrap.width - 8) x = view.x + (n.x - w / 2) * view.k - ew - 10;
    const y = view.y + (n.y - h / 2) * view.k;
    softEditor.style.left = Math.max(8, Math.min(wrap.width - ew - 8, x)) + "px";
    softEditor.style.top = Math.max(8, Math.min(wrap.height - eh - 8, y)) + "px";
  }

  softEditor.addEventListener("input", (e) => {
    if (e.target.dataset.lik === undefined || softId === null) return;
    const v = parseFloat(e.target.value);
    if (!(v >= 0)) return;
    const s = +e.target.dataset.lik;
    let vals = softValues(softId).slice();
    if (softKind === "probabilities") {
      // set this state, and rescale the others so the probabilities still add up to 1
      const q = Math.min(1, v / 100);
      const others = vals.reduce((a, x, i) => (i === s ? a : a + x), 0);
      vals = vals.map((x, i) => (i === s ? q : others > 0 ? (x * (1 - q)) / others : (1 - q) / (vals.length - 1)));
    } else {
      vals[s] = v;
      if (!vals.some((x) => x > 0)) { toast("At least one state needs a likelihood above 0"); syncSoftInputs(); return; }
    }
    const next = new Map(evidence);
    next.set(softId, softEntry(vals));
    syncSoftInputs(setEvidence(next) ? e.target : null);
  });
  softEditor.addEventListener("click", (e) => {
    const kind = e.target.closest("[data-soft-kind]");
    if (kind) {
      if (kind.dataset.softKind === softKind) return;
      const id = softId, vals = softValues(id, kind.dataset.softKind);
      softKind = kind.dataset.softKind;
      localStorage.setItem(SOFT_KIND_KEY, softKind);
      const next = new Map(evidence);
      next.set(id, softEntry(vals));
      setEvidence(next);
      openSoftEditor(id);
    } else if (e.target.closest("[data-soft-close]")) closeSoftEditor();
    else if (e.target.closest("[data-soft-reset]")) {
      // back to no information: equal likelihoods, or the node's probabilities without this evidence
      const next = new Map(evidence);
      next.delete(softId);
      const vals = softKind === "probabilities" ? BNInference.posteriors(net, evidenceIndices(next)).marginals?.get(softId) : null;
      next.set(softId, softEntry(vals || M.getNode(net, softId).labels.map(() => 1)));
      setEvidence(next);
      syncSoftInputs();
    } else if (e.target.closest("[data-soft-remove]")) {
      const next = new Map(evidence);
      next.delete(softId);
      hideSoftEditor();
      setEvidence(next);
    }
  });
  softEditor.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || (e.key === "Enter" && e.target.type === "number")) { e.preventDefault(); closeSoftEditor(); svg.focus(); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (softId !== null && !e.target.closest("#soft-editor, #evidence-bar")) closeSoftEditor();
  });

  function rubberRect() {
    const a = drag.start, b = drag.pos;
    return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  }

  // ------------------------------------------------------------ canvas interaction

  function newNodeAt(p, opts = {}) {
    const name = M.uniqueName(net, opts.name || "X");
    let node;
    change(() => {
      node = M.addNode(net, { name, labels: ["yes", "no"], x: p.x, y: p.y });
      if (opts.parent) M.addArc(net, opts.parent, node.id);
    });
    select([node.id]);
    startInlineEdit(node.id, true);
    return node;
  }

  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    commitInline();
    svg.focus({ preventScroll: true });
    const p = toWorld(e);
    const port = e.target.closest("[data-port]");
    const nodeEl = e.target.closest("[data-node]");
    const arcEl = e.target.closest(".arc");
    if (e.button === 1) {
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    } else if (port || (nodeEl && e.shiftKey)) {
      const id = +(port ? port.dataset.port : nodeEl.dataset.node);
      drag = { mode: "arc", from: id, start: p, pos: p, target: null, moved: false };
    } else if (nodeEl) {
      const id = +nodeEl.dataset.node;
      if (e.ctrlKey || e.metaKey) {
        const s = new Set(selNodes);
        s.has(id) ? s.delete(id) : s.add(id);
        select(s);
        return;
      }
      if (!selNodes.has(id)) select([id]);
      const stateEl = showProbs && e.target.closest("[data-state]");
      drag = {
        mode: "move", start: p, moved: false,
        state: stateEl ? { id, s: +stateEl.dataset.state } : null,
        origin: [...selNodes].map((sid) => { const n = M.getNode(net, sid); return { n, x: n.x, y: n.y }; }),
      };
    } else if (arcEl) {
      select([], { from: +arcEl.dataset.from, to: +arcEl.dataset.to });
      return;
    } else if (e.shiftKey) {
      drag = { mode: "rubber", start: p, pos: p, base: new Set(selNodes), moved: false };
    } else {
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    }
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener("pointermove", (e) => {
    lastPointer = toWorld(e);
    if (!drag) return;
    const p = lastPointer;
    if (drag.mode === "pan") {
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      svg.classList.add("panning");
      view.x = drag.vx + dx; view.y = drag.vy + dy;
      applyView();
    } else if (drag.mode === "move") {
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) * view.k < 3) return;
      if (!drag.moved) { checkpoint(); drag.moved = true; }
      for (const o of drag.origin) { o.n.x = o.x + dx; o.n.y = o.y + dy; }
      render();
    } else if (drag.mode === "arc") {
      if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * view.k < 8) return;
      drag.moved = true;
      drag.pos = p;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const t = el && el.closest("[data-node]");
      drag.target = t && +t.dataset.node !== drag.from ? +t.dataset.node : null;
      render();
    } else if (drag.mode === "rubber") {
      drag.moved = true;
      drag.pos = p;
      const r = rubberRect();
      const s = new Set(drag.base);
      for (const n of net.nodes) if (n.x >= r.x0 && n.x <= r.x1 && n.y >= r.y0 && n.y <= r.y1) s.add(n.id);
      selNodes = s;
      render();
    }
  });

  function endDrag(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    svg.classList.remove("panning");
    if (d.mode === "pan" && !d.moved) select([]);
    else if (d.mode === "move" && d.moved) { save(); render(); }
    else if (d.mode === "move" && d.state) {
      if (softMode) openSoftEditor(d.state.id, d.state.s);
      else toggleEvidence(d.state.id, d.state.s);
    }
    else if (d.mode === "arc") {
      if (d.target) {
        if (M.hasArc(net, d.from, d.target)) { toast("That arc already exists"); render(); return; }
        if (M.wouldCycle(net, d.from, d.target)) { toast("That arc would create a cycle"); render(); return; }
        change(() => M.addArc(net, d.from, d.target));
        select([d.target]);
      } else if (d.moved && e.type === "pointerup") {
        newNodeAt(d.pos, { parent: d.from });
      } else render();
    } else if (d.mode === "rubber") { render(); renderPanel(); }
  }
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  svg.addEventListener("dblclick", (e) => {
    // The canvas is re-rendered on every click, so look up what is under the pointer now.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const nodeEl = el && el.closest("[data-node]");
    if (nodeEl && el.closest("[data-state]")) return; // its two clicks already toggled evidence on and off
    if (nodeEl) startInlineEdit(+nodeEl.dataset.node);
    else if (!(el && el.closest(".arc"))) newNodeAt(toWorld(e));
  });

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
    const k = Math.min(3, Math.max(0.2, view.k * factor));
    view.x = mx - ((mx - view.x) / view.k) * k;
    view.y = my - ((my - view.y) / view.k) * k;
    view.k = k;
    applyView();
  }, { passive: false });

  window.addEventListener("resize", () => render());

  // ------------------------------------------------------------ inline rename

  let inlineId = null;
  function startInlineEdit(id, isNew = false) {
    const n = M.getNode(net, id);
    inlineId = id;
    inline.value = n.name;
    inline.hidden = false;
    inline.dataset.isNew = isNew ? "1" : "";
    positionInline();
    inline.focus();
    inline.select();
  }
  function positionInline() {
    const n = M.getNode(net, inlineId);
    if (!n) { inline.hidden = true; return; }
    const w = Math.max(nodeSize(n).w, 120) * view.k;
    inline.style.width = w + "px";
    inline.style.left = view.x + n.x * view.k - w / 2 + "px";
    inline.style.top = view.y + (n.y - nodeSize(n).h / 2 + (showProbs ? 4 : 11)) * view.k + "px";
    inline.style.fontSize = 14 * view.k + "px";
  }
  function commitInline() {
    if (inline.hidden) return;
    const id = inlineId;
    inline.hidden = true;
    inlineId = null;
    renameNode(id, inline.value);
  }
  inline.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitInline(); svg.focus(); }
    else if (e.key === "Escape") { inline.hidden = true; inlineId = null; svg.focus(); }
    e.stopPropagation();
  });
  inline.addEventListener("blur", commitInline);

  function renameNode(id, name) {
    const n = M.getNode(net, id);
    name = name.trim();
    if (!n || name === n.name) return true;
    if (!name) { toast("Names cannot be empty"); renderPanel(); return false; }
    if (M.nodeByName(net, name)) { toast(`There is already a node called “${name}”`); renderPanel(); return false; }
    change(() => { n.name = name; });
    return true;
  }

  // ------------------------------------------------------------ keyboard

  document.addEventListener("keydown", (e) => {
    const inField = e.target.closest("input, textarea, select, dialog");
    const inGrid = e.target.closest(".cpt-scroll");
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); downloadPython(); return; }
    if (inGrid && !inField && mod && !cpt.isEditing()) {
      // the CPT grid handles its own keys, but undo/redo stay global
      if (e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      return;
    }
    if (inField || inGrid) return;
    if (e.target.closest("button") && (e.key === "Enter" || e.key === " ")) return;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); select(net.nodes.map((n) => n.id)); }
    else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelection(); }
    else if (mod) return;
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); }
    else if (e.key === "Escape") select([]);
    else if (e.key === "f" || e.key === "F") fit();
    else if (e.key === "p" || e.key === "P") toggleProbs();
    else if ((e.key === "c" || e.key === "C") && cptNodeId() != null) { e.preventDefault(); cpt.focus(); }
    else if (e.key === "n" || e.key === "N") { e.preventDefault(); addNodeShortcut(); }
    else if (e.key === "Enter" && selNodes.size === 1) { e.preventDefault(); startInlineEdit([...selNodes][0]); }
    else if (e.key.startsWith("Arrow") && selNodes.size) {
      e.preventDefault();
      const step = e.shiftKey ? 50 : 10;
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      change(() => { for (const id of selNodes) { const n = M.getNode(net, id); n.x += dx; n.y += dy; } });
    }
  });

  function addNodeShortcut(atCenter) {
    const r = svg.getBoundingClientRect();
    const center = { x: (r.width / 2 - view.x) / view.k, y: (r.height / 2 - view.y) / view.k };
    const p = (!atCenter && lastPointer) || center;
    newNodeAt({ x: p.x, y: p.y });
  }

  function deleteSelection() {
    if (selArc) { const a = selArc; change(() => M.removeArc(net, a.from, a.to)); return; }
    if (!selNodes.size) return;
    const ids = [...selNodes];
    change(() => ids.forEach((id) => M.removeNode(net, id)));
  }

  function duplicateSelection() {
    if (!selNodes.size) return;
    const ids = [...selNodes];
    const created = [];
    change(() => {
      for (const id of ids) {
        const n = M.getNode(net, id);
        const copy = M.addNode(net, { ...structuredClone(n), name: M.uniqueName(net, n.name + "_copy"), x: n.x + 30, y: n.y + 30 });
        created.push(copy.id);
      }
      // keep arcs between duplicated nodes, and arcs from outside parents
      for (const a of net.arcs.slice()) {
        const ti = ids.indexOf(a.to);
        if (ti < 0) continue;
        const fi = ids.indexOf(a.from);
        M.addArc(net, fi >= 0 ? created[fi] : a.from, created[ti]);
      }
      ids.forEach((id, i) => { M.getNode(net, created[i]).cpt = M.getNode(net, id).cpt.slice(); });
    });
    select(created);
  }

  // ------------------------------------------------------------ side panel

  let focusAfterRender = null;

  const focusKeys = ["id", "data-cell", "data-state", "data-dom"];
  function renderPanel() {
    const active = panel.contains(document.activeElement) ? document.activeElement : null;
    const key = active && focusKeys.find((k) => active.hasAttribute(k));
    if (key && !focusAfterRender) focusAfterRender = { sel: `[${key}="${CSS.escape(active.getAttribute(key))}"]` };
    renderPanelContent();
    if (focusAfterRender) {
      const el = panel.querySelector(focusAfterRender.sel);
      if (el) { el.focus(); if (focusAfterRender.select) el.select(); }
      focusAfterRender = null;
    }
  }

  function renderPanelContent() {
    if (selArc) return renderArcPanel();
    if (selNodes.size === 1) return renderNodePanel(M.getNode(net, [...selNodes][0]));
    if (selNodes.size > 1) {
      panel.innerHTML = `<h2>${selNodes.size} nodes selected</h2>
        <p class="muted">Drag to move them together. <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates, <kbd>Del</kbd> deletes.</p>
        <button class="danger" data-act="delete">Delete ${selNodes.size} nodes</button>`;
      panel.querySelector('[data-act="delete"]').onclick = deleteSelection;
      return;
    }
    renderNetworkPanel();
  }

  function renderNetworkPanel() {
    const bad = net.nodes.filter((n) => M.badRows(n).length);
    panel.innerHTML = `
      <h2>Network</h2>
      <div class="field"><label for="net-name">Name</label><input id="net-name" type="text" value="${esc(net.name)}"></div>
      <p class="muted">${net.nodes.length} variables, ${net.arcs.length} arcs.</p>
      ${bad.length ? `<h3>Problems</h3><ul class="warn">${bad.map((n) => `<li><span class="link" data-select="${n.id}">${esc(n.name)}</span>: CPT rows do not sum to 1</li>`).join("")}</ul>` : ""}
      <h3>Editing</h3>
      <dl class="help">
        <dt>Add a node</dt><dd>Double-click empty space, or press <kbd>N</kbd>. Type its name and press <kbd>Enter</kbd>.</dd>
        <dt>Add an arc</dt><dd>Drag from the dot under a node onto another node (or <kbd>Shift</kbd>-drag a node). Drop on empty space to create a new child.</dd>
        <dt>Rename</dt><dd>Double-click a node, or select it and press <kbd>Enter</kbd>.</dd>
        <dt>Select</dt><dd>Click; <kbd>Ctrl</kbd>-click to add; <kbd>Shift</kbd>-drag on empty space for a box; <kbd>Ctrl</kbd>+<kbd>A</kbd> for all.</dd>
        <dt>Move</dt><dd>Drag nodes, or nudge with arrow keys. Drag empty space to pan, scroll to zoom, <kbd>F</kbd> to fit.</dd>
        <dt>CPTs</dt><dd>Select a variable and edit its CPT in the table under the canvas: type in cells (with “Keep rows summing to 1” on, the rest of the row is adjusted for you), drag the dividers in each row's bar, double-click a bar segment for 100%. Copy and paste work with spreadsheets; pasting one row into several selected rows repeats it. Click a parent cell to select its rows.</dd>
        <dt>Probabilities &amp; evidence</dt><dd>With <b>Probabilities</b> on (<kbd>P</kbd>), every node shows the probability of each of its states, computed exactly from the CPTs. Click a state to observe it (for example “the grass is wet”); all other nodes update to the probabilities given that evidence. Click it again, or use the evidence bar, to clear it. Turn on <b>Soft evidence</b> in the evidence bar to set a node's probabilities directly, or to enter likelihoods for its states, instead of a certain observation.</dd>
        <dt>Delete / duplicate</dt><dd><kbd>Del</kbd> / <kbd>Ctrl</kbd>+<kbd>D</kbd>. Undo with <kbd>Ctrl</kbd>+<kbd>Z</kbd>.</dd>
        <dt>pyAgrum</dt><dd>Export writes <code>import pyagrum as gum</code> code; <kbd>Ctrl</kbd>+<kbd>S</kbd> downloads it. Import accepts that code, hand-written <code>gum.BayesNet</code> code, and <code>gum.fastBN</code>. Export can also save a PNG or SVG picture of the canvas (with probabilities, if shown) that has the network embedded, so the picture can be imported again. You can drop a .py, .png or .svg file on the canvas. To share a network, host one of those files somewhere that allows cross-origin downloads (e.g. a GitHub repo or gist) and link to this page with <code>?src=</code> followed by the file's URL.</dd>
      </dl>
      <p class="panel-foot muted"><a href="https://github.com/syvb/bayesian-network" target="_blank" rel="noopener">Source on GitHub</a> · Apache 2.0</p>`;
    const nameInput = panel.querySelector("#net-name");
    nameInput.onchange = () => change(() => { net.name = nameInput.value; });
    panel.querySelectorAll("[data-select]").forEach((el) => (el.onclick = () => select([+el.dataset.select])));
  }

  function renderArcPanel() {
    const f = M.getNode(net, selArc.from), t = M.getNode(net, selArc.to);
    panel.innerHTML = `
      <h2>Arc</h2>
      <p><span class="link" data-select="${f.id}">${esc(f.name)}</span> → <span class="link" data-select="${t.id}">${esc(t.name)}</span></p>
      <p class="muted">Reversing keeps both CPTs' existing values: the node that gains a parent repeats its old distribution for every parent state, and the node that loses one keeps the rows for that parent's first state.</p>
      <button data-act="reverse">Reverse</button> <button class="danger" data-act="delete">Delete</button>`;
    panel.querySelectorAll("[data-select]").forEach((el) => (el.onclick = () => select([+el.dataset.select])));
    panel.querySelector('[data-act="delete"]').onclick = deleteSelection;
    panel.querySelector('[data-act="reverse"]').onclick = () => {
      const a = selArc;
      const err = change(() => M.reverseArc(net, a.from, a.to));
      if (err) toast(err);
      else select([], { from: a.to, to: a.from });
    };
  }

  function domainEditor(n) {
    if (n.type === "labelized") {
      return `<div class="states-list">${n.labels.map((l, i) =>
        `<div class="state-row"><span class="idx">${i}</span><input type="text" data-state="${i}" value="${esc(l)}"><button class="icon" data-remove-state="${i}" title="Remove state">✕</button></div>`).join("")}
        </div><button class="small" data-act="add-state" style="margin-top:4px">+ Add state</button>
        <p class="muted">Enter adds a state below; Backspace in an empty state removes it.</p>`;
    }
    if (n.type === "range") {
      return `<div class="field"><label>Min</label><input type="number" step="1" data-dom="min" value="${n.min}"></div>
              <div class="field"><label>Max</label><input type="number" step="1" data-dom="max" value="${n.max}"></div>`;
    }
    const key = n.type === "integer" ? "values" : "ticks";
    return `<div class="field"><label>${n.type === "integer" ? "Values" : "Ticks"}</label><input type="text" data-dom="${key}" value="${esc(n[key].map(M.fmtNum).join(", "))}"></div>
            <p class="muted">Comma-separated numbers${n.type === "discretized" ? " (at least two; states are the intervals between them)" : ""}.</p>`;
  }

  function convertType(n, type) {
    const c = n.labels.length;
    if (type === "labelized") return { type, labels: n.labels.slice() };
    if (type === "range") return { type, min: 0, max: c - 1 };
    if (type === "integer") return { type, values: n.labels.every((l) => /^-?\d+$/.test(l)) ? n.labels.map(Number) : [...Array(c).keys()] };
    return { type, ticks: [...Array(c + 1).keys()] };
  }

  function setDomain(n, spec) {
    const labels = spec.type === "labelized" ? spec.labels : M.labelsFor(spec);
    if (!labels.length) { toast("A variable needs at least one state"); renderPanel(); return; }
    if (new Set(labels).size !== labels.length) { toast("State names must be unique"); renderPanel(); return; }
    change(() => M.updateDomain(net, n.id, spec));
    flushPanel();
  }

  function renderNodePanel(n) {
    const parents = M.parentsOf(net, n.id).map((id) => M.getNode(net, id));
    const children = M.childrenOf(net, n.id).map((id) => M.getNode(net, id));
    const chip = (o, role) => `<span class="chip" data-select="${o.id}">${esc(o.name)}<button class="icon" data-remove-arc="${role === "parent" ? o.id + ">" + n.id : n.id + ">" + o.id}" title="Remove arc">✕</button></span>`;
    panel.innerHTML = `
      <h2>Variable</h2>
      <div class="field"><label for="n-name">Name</label><input id="n-name" type="text" value="${esc(n.name)}"></div>
      <div class="field"><label for="n-desc">Description</label><input id="n-desc" type="text" value="${esc(n.description)}"></div>
      <div class="field"><label for="n-type">Type</label><select id="n-type">
        ${[["labelized", "Labelized"], ["range", "Range (integers)"], ["integer", "Integer values"], ["discretized", "Discretized"]]
          .map(([v, l]) => `<option value="${v}"${v === n.type ? " selected" : ""}>${l}</option>`).join("")}
      </select></div>
      <h3>States</h3>
      ${domainEditor(n)}
      <h3>Parents</h3>
      <div class="chips">${parents.map((p) => chip(p, "parent")).join("") || '<span class="muted">None</span>'}</div>
      <h3>Children</h3>
      <div class="chips">${children.map((c) => chip(c, "child")).join("") || '<span class="muted">None</span>'}</div>
      <h3>CPT</h3>
      <p class="muted">Edit this variable's CPT in the table below the canvas (press <kbd>C</kbd> to jump there).</p>
      <p style="margin-top:16px"><button class="danger" data-act="delete">Delete variable</button></p>`;

    const name = panel.querySelector("#n-name");
    name.onchange = () => renameNode(n.id, name.value);
    name.onkeydown = (e) => { if (e.key === "Enter") name.blur(); };
    const desc = panel.querySelector("#n-desc");
    desc.onchange = () => change(() => { n.description = desc.value; });
    panel.querySelector("#n-type").onchange = (e) => setDomain(n, convertType(n, e.target.value));

    // labelized state list
    panel.querySelectorAll("[data-state]").forEach((input) => {
      const i = +input.dataset.state;
      const labelsWith = (fn) => { const l = n.labels.slice(); fn(l); return l; };
      input.onchange = () => {
        const v = input.value.trim();
        if (v === n.labels[i]) return;
        if (!v) { input.value = n.labels[i]; return; }
        setDomain(n, { type: "labelized", labels: labelsWith((l) => (l[i] = v)) });
      };
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const v = input.value.trim() || n.labels[i];
          const labels = labelsWith((l) => { l[i] = v; l.splice(i + 1, 0, M.uniqueName({ nodes: l.map((x) => ({ name: x })) }, "state")); });
          focusAfterRender = { sel: `[data-state="${i + 1}"]`, select: true };
          setDomain(n, { type: "labelized", labels });
        } else if (e.key === "Backspace" && input.value === "" && n.labels.length > 1) {
          e.preventDefault();
          focusAfterRender = { sel: `[data-state="${Math.max(0, i - 1)}"]` };
          setDomain(n, { type: "labelized", labels: labelsWith((l) => l.splice(i, 1)) });
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const next = panel.querySelector(`[data-state="${i + (e.key === "ArrowDown" ? 1 : -1)}"]`);
          if (next) { e.preventDefault(); next.focus(); }
        }
      };
    });
    panel.querySelectorAll("[data-remove-state]").forEach((b) => (b.onclick = () => {
      if (n.labels.length < 2) return toast("A variable needs at least one state");
      const l = n.labels.slice(); l.splice(+b.dataset.removeState, 1);
      setDomain(n, { type: "labelized", labels: l });
    }));
    const addState = panel.querySelector('[data-act="add-state"]');
    if (addState) addState.onclick = () => {
      focusAfterRender = { sel: `[data-state="${n.labels.length}"]`, select: true };
      setDomain(n, { type: "labelized", labels: n.labels.concat(M.uniqueName({ nodes: n.labels.map((x) => ({ name: x })) }, "state")) });
    };
    panel.querySelectorAll("[data-dom]").forEach((input) => (input.onchange = () => {
      const spec = { type: n.type, min: n.min, max: n.max, values: n.values, ticks: n.ticks };
      const k = input.dataset.dom;
      if (k === "min" || k === "max") {
        spec[k] = Math.trunc(+input.value);
        if (!(spec.max >= spec.min)) { toast("Max must be at least min"); return renderPanel(); }
      } else {
        const nums = input.value.split(/[,\s]+/).filter(Boolean).map(Number);
        if (nums.some((x) => !Number.isFinite(x)) || (k === "values" && nums.some((x) => !Number.isInteger(x)))) { toast("Enter comma-separated numbers"); return renderPanel(); }
        spec[k] = [...new Set(nums)].sort((a, b) => a - b);
        if (k === "ticks" && spec.ticks.length < 2) { toast("Discretized variables need at least two ticks"); return renderPanel(); }
      }
      setDomain(n, spec);
    }));

    panel.querySelectorAll("[data-select]").forEach((el) => (el.onclick = (e) => { if (!e.target.closest("button")) select([+el.dataset.select]); }));
    panel.querySelectorAll("[data-remove-arc]").forEach((b) => (b.onclick = () => {
      const [from, to] = b.dataset.removeArc.split(">").map(Number);
      change(() => M.removeArc(net, from, to));
    }));
    panel.querySelector('[data-act="delete"]').onclick = deleteSelection;
  }

  // ------------------------------------------------------------ import / export

  function exportWarnings() {
    const bad = net.nodes.filter((n) => M.badRows(n).length).map((n) => n.name);
    return bad.length ? `Warning: CPT rows of ${bad.join(", ")} do not sum to 1.` : "";
  }

  function fileName(ext) {
    return ((net.name || "network").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "network") + ext;
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function downloadPython() {
    download(new Blob([P.exportPython(net)], { type: "text/x-python" }), fileName(".py"));
  }

  // The canvas as it is shown now (with probabilities and evidence when that view is on), minus
  // the selection, with the pyAgrum code embedded so the image can be imported again.
  async function downloadImage(kind) {
    if (!net.nodes.length) { toast("The network is empty"); return; }
    const code = P.exportPython(net);
    const saved = { nodes: selNodes, arc: selArc };
    selNodes = new Set();
    selArc = null;
    render();
    let caption = null;
    const ev = showProbs ? evidenceIndices() : new Map();
    if (ev.size) {
      const text = "Evidence: " + [...ev].map(([id, v]) => {
        const n = M.getNode(net, id);
        if (isTarget(v)) return `${n.name} → ${v.target.map(fmtPct).join(" : ")}`;
        return Array.isArray(v) ? `${n.name} ≈ ${v.map((x) => +x.toPrecision(2)).join(" : ")}` : `${n.name} = ${n.labels[v]}`;
      }).join(", ");
      caption = { text, width: textWidth(text, "13px system-ui, sans-serif") };
    }
    const css = getComputedStyle(document.documentElement);
    let image;
    try {
      image = BNImage.buildSvg(svg, viewport, {
        code, caption,
        background: css.getPropertyValue("--bg").trim(),
        captionColor: css.getPropertyValue("--text").trim(),
      });
    } finally {
      selNodes = saved.nodes;
      selArc = saved.arc;
      render();
    }
    if (kind === "svg") download(new Blob([image.svg], { type: "image/svg+xml" }), fileName(".svg"));
    else download(await BNImage.svgToPng(image, code), fileName(".png"));
  }

  function openExport() {
    $("#export-code").value = P.exportPython(net);
    $("#export-warnings").textContent = exportWarnings();
    $("#export-dialog").showModal();
  }

  function openImport() {
    $("#import-warnings").innerHTML = "";
    $("#import-networks").hidden = true;
    const btn = document.querySelector('[data-action="do-import"]');
    btn.textContent = "Import";
    btn.dataset.done = "";
    $("#import-dialog").showModal();
    $("#import-code").focus();
  }

  // Returns true when a network was loaded. `pick` chooses among several networks built by the code.
  function importCode(src, pick) {
    const { net: imported, warnings, networks = [], picked } = P.importPython(src, { pick });
    $("#import-warnings").innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join("");
    const multiple = networks.length > 1;
    $("#import-networks").hidden = !multiple;
    if (multiple) {
      $("#import-pick").innerHTML = networks.map((n, i) =>
        `<option value="${i}"${i === picked ? " selected" : ""}>${esc(n.label)} (${n.nodes} variable${n.nodes === 1 ? "" : "s"}, ${n.arcs} arc${n.arcs === 1 ? "" : "s"})</option>`).join("");
      $("#import-networks-note").textContent = `The code builds ${networks.length} networks; pick the one to import.`;
    }
    if (!imported) return false;
    clearEvidence();
    change(() => { net = imported; });
    select([]);
    fit();
    toast(`Imported ${net.nodes.length} variables${warnings.length ? ` with ${warnings.length} warning${warnings.length > 1 ? "s" : ""}` : ""}`);
    return true;
  }

  // Returns true when a network was loaded.
  async function importFile(file) {
    let text = await BNImage.codeFromFile(file);
    if (text === null) { toast("This image doesn't contain a network exported from this editor"); return false; }
    if (text === undefined) text = await file.text();
    $("#import-code").value = text;
    if (!$("#import-dialog").open) openImport();
    return finishImport();
  }

  function finishImport() {
    const btn = document.querySelector('[data-action="do-import"]');
    if (btn.dataset.done) { $("#import-dialog").close(); return false; }
    if (!importCode($("#import-code").value)) return false;
    if ($("#import-warnings").children.length || !$("#import-networks").hidden) { btn.textContent = "Done"; btn.dataset.done = "1"; }
    else $("#import-dialog").close();
    return true;
  }

  // ------------------------------------------------------------ ?src= links

  // GitHub "blob" and gist page URLs don't allow cross-origin downloads; their raw versions do.
  function rawUrl(url) {
    const blob = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/.exec(url);
    if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}`;
    const gist = /^https:\/\/gist\.github\.com\/([^/]+\/[0-9a-f]+)\/?$/i.exec(url);
    if (gist) return `https://gist.githubusercontent.com/${gist[1]}/raw`;
    return url;
  }

  // Loads the network from the file named by ?src=<url> (.py, or a .png/.svg exported here).
  // Reloading the same tab keeps local edits instead of fetching the file again.
  async function loadFromLink() {
    const src = new URLSearchParams(location.search).get("src");
    if (!src || sessionStorage.getItem(SRC_KEY) === src) return;
    sessionStorage.setItem(SRC_KEY, src);
    let url;
    try { url = new URL(rawUrl(src), location.href); } catch { toast("The link's src isn't a valid URL"); return; }
    toast(`Loading ${url.href}…`);
    let res;
    try {
      res = await fetch(url);
    } catch {
      toast("Couldn't download the linked network. The server may not allow cross-origin downloads (CORS).");
      return;
    }
    if (!res.ok) { toast(`Couldn't download the linked network (HTTP ${res.status})`); return; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Name the file by its content so the importer knows how to read it.
    const head = new TextDecoder().decode(bytes.subarray(0, 512));
    const name = bytes[0] === 0x89 && head.startsWith("PNG", 1) ? "network.png"
      : /^\s*(<\?xml[^>]*>\s*)?<svg\b/.test(head) ? "network.svg" : "network.py";
    if (await importFile(new File([bytes], name))) {
      toast(`Loaded ${net.nodes.length} variables from the link (Ctrl+Z to go back)`);
    }
  }

  $("#import-code").addEventListener("input", () => {
    const btn = document.querySelector('[data-action="do-import"]');
    btn.textContent = "Import"; btn.dataset.done = "";
  });
  $("#import-pick").addEventListener("change", (e) => importCode($("#import-code").value, +e.target.value));
  $("#import-file").addEventListener("change", (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ""; });

  const wrap = $("#canvas-wrap");
  wrap.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); wrap.classList.add("dropping"); } });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("dropping"));
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    wrap.classList.remove("dropping");
    if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
  });

  // ------------------------------------------------------------ toolbar

  const actions = {
    new: () => {
      if (net.nodes.length && !confirm("Start a new empty network? (You can undo this.)")) return;
      clearEvidence();
      change(() => { net = M.createNetwork("BN"); });
      select([]);
    },
    import: openImport,
    demo: () => toggleDemoMenu(),
    probs: toggleProbs,
    export: openExport,
    undo, redo,
    add: () => addNodeShortcut(true),
    layout: () => { change(() => M.autoLayout(net)); fit(); },
    fit,
    "copy-export": async () => { await navigator.clipboard.writeText($("#export-code").value); toast("Copied to clipboard"); },
    "download-export": downloadPython,
    "download-svg": () => downloadImage("svg"),
    "download-png": () => downloadImage("png"),
    "do-import": finishImport,
  };
  const demoMenu = $("#demo-menu");
  demoMenu.innerHTML = BNDemos.map((d) => `<button role="menuitem" data-demo="${d.id}"><b>${esc(d.label)}</b><span>${esc(d.detail)}</span></button>`).join("");
  function toggleDemoMenu(open = demoMenu.hidden) {
    demoMenu.hidden = !open;
    document.querySelector('[data-action="demo"]').setAttribute("aria-expanded", open);
    if (open) demoMenu.querySelector("button").focus();
  }
  demoMenu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-demo]");
    if (!b) return;
    const demo = BNDemos.find((d) => d.id === b.dataset.demo);
    toggleDemoMenu(false);
    clearEvidence();
    change(() => { net = demo.build(); });
    select([]);
    fit();
    toast(`Loaded the ${demo.label} demo (Ctrl+Z to go back)`);
  });
  demoMenu.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep arrow keys from moving selected nodes
    const items = [...demoMenu.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === "Escape") {
      toggleDemoMenu(false);
      document.querySelector('[data-action="demo"]').focus();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!demoMenu.hidden && !e.target.closest("#demo-menu, [data-action='demo']")) toggleDemoMenu(false);
  });

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-action]");
    if (b && actions[b.dataset.action]) { e.preventDefault(); actions[b.dataset.action](); }
  });

  // ------------------------------------------------------------ start

  const cpt = BNCptEditor.createCptEditor($("#cpt-dock"), {
    getNet: () => net,
    change,
    checkpoint,
    afterDirectEdit: () => { save(); render(); cpt.render(cptNodeId()); schedulePanel(); },
    toast,
    onEscape: () => svg.focus(),
    onResize: () => render(),
    onLiveEdit: () => { inferenceCache = null; render(); },
  });

  net = load();
  document.querySelector('[data-action="probs"]').setAttribute("aria-pressed", showProbs);
  render();
  renderPanel();
  cpt.render(cptNodeId());
  updateButtons();
  requestAnimationFrame(fit);
  loadFromLink();

  // Exposed for debugging from the console.
  globalThis.bnEditor = { get net() { return net; }, select, render };
})();
