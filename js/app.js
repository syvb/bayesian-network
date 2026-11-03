(function () {
  "use strict";
  const M = globalThis.BNModel, P = globalThis.BNPyAgrum;
  const STORAGE_KEY = "bn-editor-network";
  const NODE_H = 50;
  const SVG_NS = "http://www.w3.org/2000/svg";

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

  // ------------------------------------------------------------ state & history

  function sample() {
    const n = M.createNetwork("Wet grass");
    const add = (name, labels, x, y) => M.addNode(n, { name, labels, x, y });
    const c = add("cloudy", ["no", "yes"], 300, 80);
    const s = add("sprinkler", ["off", "on"], 160, 200);
    const r = add("rain", ["no", "yes"], 440, 200);
    const w = add("wet_grass", ["no", "yes"], 300, 320);
    M.addArc(n, c.id, s.id); M.addArc(n, c.id, r.id); M.addArc(n, s.id, w.id); M.addArc(n, r.id, w.id);
    c.cpt = [0.5, 0.5];
    s.cpt = [0.5, 0.5, 0.9, 0.1];
    r.cpt = [0.8, 0.2, 0.2, 0.8];
    w.cpt = [1, 0, 0.1, 0.9, 0.1, 0.9, 0.01, 0.99];
    return n;
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.nodes)) return saved;
    } catch {}
    return sample();
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

  function toWorld(e) {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  }

  // Point where the segment from b's centre towards a leaves b's box (with margin).
  function boxExit(b, w, ax, ay, margin) {
    const dx = ax - b.x, dy = ay - b.y;
    const hw = w / 2 + margin, hh = NODE_H / 2 + margin;
    const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return t >= 1 ? { x: b.x, y: b.y } : { x: b.x + dx * t, y: b.y + dy * t };
  }

  function fit() {
    if (!net.nodes.length) { view = { x: 0, y: 0, k: 1 }; applyView(); return; }
    const r = svg.getBoundingClientRect();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of net.nodes) {
      const w = nodeWidth(n) / 2;
      x0 = Math.min(x0, n.x - w); x1 = Math.max(x1, n.x + w);
      y0 = Math.min(y0, n.y - NODE_H / 2); y1 = Math.max(y1, n.y + NODE_H / 2 + 10);
    }
    const pad = 50;
    const k = Math.min(1.4, (r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad) / (y1 - y0));
    view = { k, x: r.width / 2 - ((x0 + x1) / 2) * k, y: r.height / 2 - ((y0 + y1) / 2) * k };
    applyView();
  }

  function applyView() {
    viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
    svg.style.backgroundSize = `${20 * view.k}px ${20 * view.k}px`;
    svg.style.backgroundPosition = `${view.x}px ${view.y}px`;
    if (!inline.hidden) positionInline();
  }

  // ------------------------------------------------------------ rendering

  function render() {
    const parts = [];
    const widths = new Map(net.nodes.map((n) => [n.id, nodeWidth(n)]));
    for (const a of net.arcs) {
      const f = M.getNode(net, a.from), t = M.getNode(net, a.to);
      const p1 = boxExit(f, widths.get(f.id), t.x, t.y, 0);
      const p2 = boxExit(t, widths.get(t.id), f.x, f.y, 2);
      const sel = selArc && selArc.from === a.from && selArc.to === a.to;
      const d = `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
      parts.push(`<g class="arc${sel ? " selected" : ""}" data-from="${a.from}" data-to="${a.to}"><path class="hit" d="${d}"/><path class="line" d="${d}" marker-end="url(#${sel ? "arrow-sel" : "arrow"})"/></g>`);
    }
    for (const n of net.nodes) {
      const w = widths.get(n.id), h = NODE_H;
      const classes = ["node"];
      if (selNodes.has(n.id)) classes.push("selected");
      if (drag && drag.mode === "arc" && drag.target === n.id) classes.push("target");
      let states = n.labels.join(" · ");
      const maxW = w - 16;
      if (textWidth(states, "11px system-ui, sans-serif") > maxW) {
        while (states.length > 1 && textWidth(states + "…", "11px system-ui, sans-serif") > maxW) states = states.slice(0, -1);
        states += "…";
      }
      const bad = M.badRows(n).length > 0;
      parts.push(
        `<g class="${classes.join(" ")}" data-node="${n.id}" transform="translate(${n.x},${n.y})">` +
          `<title>${esc(n.name)}${n.description ? " — " + esc(n.description) : ""}\n${esc(n.labels.join(", "))}${bad ? "\nCPT rows do not sum to 1" : ""}</title>` +
          `<rect class="body" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="9"/>` +
          `<text class="name" text-anchor="middle" y="-3">${esc(n.name)}</text>` +
          `<text class="states" text-anchor="middle" y="14">${esc(states)}</text>` +
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
    if (!net.nodes.length) {
      viewport.innerHTML += `<text x="${(svg.clientWidth / 2 - view.x) / view.k}" y="${(svg.clientHeight / 2 - view.y) / view.k}" text-anchor="middle" fill="currentColor" opacity="0.45">Double-click anywhere to add a node</text>`;
    }
  }

  function rubberRect() {
    const a = drag.start, b = drag.pos;
    return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  }

  // ------------------------------------------------------------ canvas interaction

  function newNodeAt(p, opts = {}) {
    const name = M.uniqueName(net, opts.name || "X");
    let node;
    change(() => {
      node = M.addNode(net, { name, labels: ["no", "yes"], x: p.x, y: p.y });
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
      drag = {
        mode: "move", start: p, moved: false,
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
    const w = Math.max(nodeWidth(n), 120) * view.k;
    inline.style.width = w + "px";
    inline.style.left = view.x + n.x * view.k - w / 2 + "px";
    inline.style.top = view.y + (n.y - 14) * view.k + "px";
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
        <dt>Probabilities</dt><dd>Select a variable and edit its CPT in the table under the canvas: type in cells (auto-balance keeps rows summing to 1), drag the dividers in each row's bar, double-click a bar segment for 100%. Copy and paste work with spreadsheets; pasting one row into several selected rows repeats it. Click a parent cell to select its rows.</dd>
        <dt>Delete / duplicate</dt><dd><kbd>Del</kbd> / <kbd>Ctrl</kbd>+<kbd>D</kbd>. Undo with <kbd>Ctrl</kbd>+<kbd>Z</kbd>.</dd>
        <dt>pyAgrum</dt><dd>Export writes <code>import pyagrum as gum</code> code; <kbd>Ctrl</kbd>+<kbd>S</kbd> downloads it. Import accepts that code, hand-written <code>gum.BayesNet</code> code, and <code>gum.fastBN</code>. You can also drop a .py file on the canvas.</dd>
      </dl>`;
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
      <h3>Probabilities</h3>
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

  function fileName() {
    return (net.name || "network").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") + ".py";
  }

  function downloadPython() {
    const blob = new Blob([P.exportPython(net)], { type: "text/x-python" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function openExport() {
    $("#export-code").value = P.exportPython(net);
    $("#export-warnings").textContent = exportWarnings();
    $("#export-dialog").showModal();
  }

  function openImport() {
    $("#import-warnings").innerHTML = "";
    const btn = document.querySelector('[data-action="do-import"]');
    btn.textContent = "Import";
    btn.dataset.done = "";
    $("#import-dialog").showModal();
    $("#import-code").focus();
  }

  // Returns true when a network was loaded.
  function importCode(src) {
    const { net: imported, warnings } = P.importPython(src);
    $("#import-warnings").innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join("");
    if (!imported) return false;
    change(() => { net = imported; });
    select([]);
    fit();
    toast(`Imported ${net.nodes.length} variables${warnings.length ? ` with ${warnings.length} warning${warnings.length > 1 ? "s" : ""}` : ""}`);
    return true;
  }

  async function importFile(file) {
    const text = await file.text();
    $("#import-code").value = text;
    if (!$("#import-dialog").open) openImport();
    finishImport();
  }

  function finishImport() {
    const btn = document.querySelector('[data-action="do-import"]');
    if (btn.dataset.done) { $("#import-dialog").close(); return; }
    if (importCode($("#import-code").value)) {
      if ($("#import-warnings").children.length) { btn.textContent = "Done"; btn.dataset.done = "1"; }
      else $("#import-dialog").close();
    }
  }

  $("#import-code").addEventListener("input", () => {
    const btn = document.querySelector('[data-action="do-import"]');
    btn.textContent = "Import"; btn.dataset.done = "";
  });
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
      change(() => { net = M.createNetwork("BN"); });
      select([]);
    },
    import: openImport,
    export: openExport,
    undo, redo,
    add: () => addNodeShortcut(true),
    layout: () => { change(() => M.autoLayout(net)); fit(); },
    fit,
    "copy-export": async () => { await navigator.clipboard.writeText($("#export-code").value); toast("Copied to clipboard"); },
    "download-export": downloadPython,
    "do-import": finishImport,
  };
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
  });

  net = load();
  render();
  renderPanel();
  cpt.render(cptNodeId());
  updateButtons();
  requestAnimationFrame(fit);

  // Exposed for debugging from the console.
  globalThis.bnEditor = { get net() { return net; }, select, render };
})();
