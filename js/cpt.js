// CPT editor docked under the canvas: a spreadsheet-like grid with one distribution bar per row.
(function () {
  "use strict";
  const M = globalThis.BNModel;
  const PALETTE = [
    ["#4e79a7", "#fff"], ["#f28e2b", "#fff"], ["#59a14f", "#fff"], ["#e15759", "#fff"], ["#76b7b2", "#13202a"],
    ["#edc948", "#13202a"], ["#b07aa1", "#fff"], ["#ff9da7", "#13202a"], ["#9c755f", "#fff"], ["#bab0ac", "#13202a"],
  ];
  const PREFS_KEY = "bn-editor-cpt-prefs";
  const MAX_ROWS = 1000;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const round = (v) => +v.toPrecision(12);
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  // Green and red are kept for states that read as yes/no; every other state takes the remaining
  // palette colours, so a colour never suggests a meaning the label doesn't have.
  const GREEN = PALETTE[2], RED = PALETTE[3];
  const OTHER = PALETTE.filter((c) => c !== GREEN && c !== RED);
  function stateColors(labels) {
    const kind = labels.map((l) => (M.isTrueLabel(l) ? GREEN : M.isFalseLabel(l) ? RED : null));
    let i = 0;
    return kind.map((c) => c || OTHER[i++ % OTHER.length]);
  }

  // The number formats: probabilities (0.25), percentages (25%), or log-odds: the natural log
  // of the state's odds against the row's other states, ln(p / (1 - p)), so 0 is 50%, +2.2 is 90%
  // and -2.2 is 10%; 0 and 1 are -inf and +inf.
  const logit = (p) => (p <= 0 ? -Infinity : p >= 1 ? Infinity : Math.log(p / (1 - p)));
  const sigmoid = (x) => (x === Infinity ? 1 : x === -Infinity ? 0 : 1 / (1 + Math.exp(-x)));

  // Accepts 0.3, .3, 30%, 1/3 (and in percent format, 30 means 30%). In log-odds format a plain
  // number (negative too) or inf / -inf is log-odds; 30% and 1/3 are still probabilities.
  // "30" percent as the number nearest to 0.30 (dividing by 100 would give 1e-7% as 9.99e-10)
  const fromPercent = (x) => { const [mant, ex = "0"] = x.toLowerCase().split("e"); return Number(`${mant}e${Number(ex) - 2}`); };

  function parseProb(text, format) {
    const t = String(text).trim().replace(/\s+/g, "").replace(/[−–]/g, "-");
    if (!t) return NaN;
    let m;
    if ((m = /^([\d.]+(?:e-?\d+)?)%$/i.exec(t))) return fromPercent(m[1]);
    if ((m = /^([\d.]+)\/([\d.]+)$/.exec(t))) return +m[2] > 0 ? +m[1] / +m[2] : NaN;
    if (format === "logodds") {
      if ((m = /^([+-]?)(?:inf|infinity|∞)$/i.exec(t))) return m[1] === "-" ? 0 : 1;
      return /^[+-]?[\d.]+(?:e[+-]?\d+)?$/i.test(t) && Number.isFinite(+t) ? sigmoid(+t) : NaN;
    }
    if (!/^[\d.]+(?:e-?\d+)?$/i.test(t)) return NaN;
    return format === "pct" ? fromPercent(t) : +t;
  }

  // Exact decimals: "12.5e-3" as [m, e], meaning m / 10^e; their difference, sum and ×100; and
  // [m, e] as text and as the nearest number.
  const dec = (x) => {
    const [mant, ex = "0"] = x.toLowerCase().split("e"), [i, f = ""] = mant.split(".");
    let e = f.length - Number(ex), m = BigInt((i + f) || "0");
    if (e < 0) { m *= M.pow10(-e); e = 0; }
    return [m, e];
  };
  const minus = ([a, b], [c, d]) => { const e = Math.max(b, d); return [a * M.pow10(e - b) - c * M.pow10(e - d), e]; };
  const plus = (a, [m, e]) => minus(a, [-m, e]);
  const times100 = ([m, e]) => (e >= 2 ? [m, e - 2] : [m * M.pow10(2 - e), 0]);
  const decText = ([m, e]) => { const s = String(m).padStart(e + 1, "0"); return e ? `${s.slice(0, -e)}.${s.slice(-e)}`.replace(/\.?0+$/, "") : s; };
  const decNum = ([m, e]) => (m < 0n ? -M.ratio(-m, M.pow10(e)) : M.ratio(m, M.pow10(e)));

  // parseProb(text, format) as an exact decimal when the text is one (0.3 or 30%), else null.
  function exactProb(text, format) {
    const m = /^([\d.]+(?:e-?\d+)?)(%?)$/i.exec(String(text).trim().replace(/\s+/g, ""));
    if (!m || (!m[2] && format === "logodds")) return null;
    const [n, e] = dec(m[1]);
    return m[2] || format === "pct" ? [n, e + 2] : [n, e];
  }

  // 1 - parseProb(text, format), computed from the typed digits rather than from the rounded
  // probability, so typing 0.99999999999999999999 (which floating point stores as 1) leaves 1e-20
  // for the rest of the row instead of 0. NaN when the text isn't a probability.
  function parseComplement(text, format) {
    const t = String(text).trim().replace(/\s+/g, "").replace(/[−–]/g, "-");
    const p = parseProb(text, format);
    if (!(p >= 0)) return NaN;
    const x = exactProb(text, format);
    if (x) return decNum(minus([1n, 0], x));
    let m;
    if ((m = /^([\d.]+)\/([\d.]+)$/.exec(t))) { const a = dec(m[1]), b = dec(m[2]); const [n, e] = minus(b, a); return decNum([n, e]) / decNum(b); }
    return /inf|∞/i.test(t) ? 1 - p : sigmoid(-t);
  }

  function createCptEditor(dock, opts) {
    const prefs = { format: "prob", balance: true, cumulative: false, height: 300, collapsed: false };
    try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch {}
    if (prefs.percent) prefs.format = "pct"; // saved before log-odds existed
    delete prefs.percent;
    const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));

    let nodeId = null;
    let filters = new Map(); // parent id -> state index
    let rows = []; // visible rows: {idx, offset}
    let sel = null; // {ar, ac, fr, fc}: anchor and focus cell, in visible-row / state indices
    let edit = null; // {r, c, input, overwrite}
    let pins = { offset: -1, set: new Set() }; // states typed in the current row (kept when balancing)
    let lastAdjust = null; // {offset, cols}: cells changed for you by the last edit, highlighted once
    let mouseSelecting = false;
    let barDrag = null;
    let hot = null; // {r0, r1}: rows under the pointer (or being dragged), highlighted across the table
    let curParents = [];

    dock.innerHTML = `<div class="dock-resize" title="Drag to resize"></div><header class="dock-head"></header><div class="cpt-scroll" tabindex="0"></div>
      <div id="balance-help" class="help-popover" popover>
        <h3>Keep rows summing to 1</h3>
        <p>Each CPT row is a probability distribution, so it has to add up to 1. With this option on, when you type a value the <b>other states in that row are adjusted for you</b>:</p>
        <ul>
          <li>Start with the row <code>0.5 · 0.3 · 0.2</code> and type <code>0.8</code> in the first cell. The other two shrink to <code>0.12 · 0.08</code>, keeping their 3 : 2 ratio.</li>
          <li>Then type <code>0.15</code> in the second cell. Your <code>0.8</code> is kept and the last cell becomes <code>0.05</code>. Values you typed in a row stay put while you're still in that row, so typing all but one state fills in the last.</li>
        </ul>
        <p>Cells changed for you flash briefly. Turn the option off to edit cells independently, for example to enter raw weights and then press Normalize. Dragging a bar's dividers always keeps the row at 1.</p>
      </div>`;
    const head = dock.querySelector(".dock-head");
    const grid = dock.querySelector(".cpt-scroll");

    const node = () => (nodeId == null ? null : M.getNode(opts.getNet(), nodeId));
    const card = () => node().labels.length;
    // `rest` is the sum of the row's other states, when known: log-odds are then ln(v / rest), which
    // stays finite for a state of 1 - 1e-20 that floating point stores as 1 (the other state keeps
    // the 1e-20), and a value that only rounds to 1 isn't shown as certain.
    const logOdds = (v, rest) => (rest === undefined ? logit(v) : v <= 0 ? -Infinity : rest <= 0 ? Infinity : Math.log(v / rest));
    const fmtLogit = (v, rest) => {
      const x = logOdds(v, rest);
      return x === Infinity ? "+∞" : x === -Infinity ? "−∞" : (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(2);
    };
    const fmt = (v, format = prefs.format, rest) => {
      if (!Number.isFinite(v)) return "?";
      const notCertain = v < 1 || rest > 0;
      if (format === "logodds") return v > 1 || v < 0 ? "?" : fmtLogit(v, rest);
      if (format === "pct") {
        if (v > 0 && v < 1e-4) return +(v * 100).toPrecision(3) + "%";
        const t = +(v * 100).toFixed(2);
        return t === 100 && notCertain ? ">99.99%" : t + "%";
      }
      if (v !== 0 && Math.abs(v) < 1e-4) return v.toExponential(1);
      const t = +v.toFixed(4);
      return t === 1 && notCertain ? ">0.9999" : String(t);
    };
    // log-odds cells name their probability on hover
    const cellTitle = (v) => (prefs.format === "logodds" && Number.isFinite(v) ? `${fmt(v, "pct")} (${M.fmtNum(v)})` : M.fmtNum(v));
    const restOf = (vals, s) => vals.reduce((a, x, i) => (i === s ? a : a + Math.max(0, x)), 0);
    const rowVals = (r) => node().cpt.slice(rows[r].offset, rows[r].offset + card());
    // The cumulative view has a column per state but the last, P(≤ state), and needs 3 states to
    // say anything a column per state doesn't.
    const cumulative = () => prefs.cumulative && card() > 2;
    const cols = () => (cumulative() ? card() - 1 : card());
    // The name of cumulative column c: "≤ 2028", or for a discretized variable "< 5", since its
    // state c is an interval [a;5[ and P(≤ [a;5[) is P(value < 5).
    const upTo = (c) => (node().type === "discretized" ? `< ${M.fmtNum(node().ticks[c + 1])}` : `≤ ${node().labels[c]}`);
    // The values a row shows, one per column, each with `rest` (see logOdds): the state's
    // probability and the sum of its other states, or P(≤ state) and the sum of the states after
    // it, added from the far end so a tiny state there isn't lost.
    function shownVals(vals) {
      if (!cumulative()) return vals.map((v, s) => ({ v, rest: restOf(vals, s) }));
      const out = [];
      for (let s = 0, below = 0; s < vals.length - 1; s++) out.push({ v: (below += vals[s]) });
      for (let s = vals.length - 2, above = 0; s >= 0; s--) out[s].rest = above += vals[s + 1];
      return out;
    }
    // The first state at which P(≤ state) reaches 50%, for a row that sums to 1.
    const median = (vals) => node().labels[shownVals(vals).findIndex(({ v, rest }) => round(v) >= round(rest))] ?? node().labels.at(-1);
    const range = () => ({
      r0: Math.min(sel.ar, sel.fr), r1: Math.max(sel.ar, sel.fr),
      c0: Math.min(sel.ac, sel.fc), c1: Math.max(sel.ac, sel.fc),
    });
    const rowBad = (vals) => Math.abs(sum(vals) - 1) > 1e-6 || vals.some((v) => !(v >= 0));

    // ------------------------------------------------------------ rendering

    function render(id) {
      if (id !== nodeId) {
        nodeId = id;
        filters = new Map();
        sel = null;
        pins = { offset: -1, set: new Set() };
        grid.scrollTop = 0;
      }
      edit = null;
      dock.classList.toggle("collapsed", prefs.collapsed);
      dock.style.height = prefs.collapsed ? "" : prefs.height + "px";
      const n = node();
      if (!n) {
        nodeId = null;
        head.innerHTML = `<span class="dock-title">Probabilities</span><span class="grow"></span>${collapseButton()}`;
        grid.innerHTML = `<p class="dock-empty">Select a variable to edit its conditional probability table.</p>`;
        return;
      }
      const { parents, rows: all } = M.cptRows(opts.getNet(), n.id);
      for (const [pid, s] of filters) {
        const p = parents.find((x) => x.id === pid);
        if (!p || s >= p.labels.length) filters.delete(pid);
      }
      rows = all.filter((r) => parents.every((p, k) => !filters.has(p.id) || filters.get(p.id) === r.idx[k]));
      if (sel) {
        const clampR = (r) => Math.min(r, Math.min(rows.length, MAX_ROWS) - 1);
        const clampC = (c) => Math.min(c, cols() - 1);
        sel = rows.length ? { ar: clampR(sel.ar), fr: clampR(sel.fr), ac: clampC(sel.ac), fc: clampC(sel.fc) } : null;
      }
      head.innerHTML = headerHTML(n, parents, all.length);
      curParents = parents;
      grid.innerHTML = tableHTML(n, parents);
      paintHot();
      showAdjustment();
      paintSelection();
    }

    // The header uses one line with full labels if that fits, else one line with compact labels
    // (row actions in a "Rows" menu), else wraps with full labels.
    function fitHeader() {
      const overflows = () => head.scrollWidth > head.clientWidth + 1;
      head.classList.remove("compact");
      head.classList.add("single");
      if (overflows()) {
        head.classList.add("compact");
        if (overflows()) head.classList.remove("compact", "single");
      }
      dock.classList.toggle("compact", head.classList.contains("compact"));
    }
    let headWidth = 0;
    new ResizeObserver(() => {
      if (head.clientWidth !== headWidth) { headWidth = head.clientWidth; fitHeader(); }
    }).observe(head);

    function setRowMenu(open) {
      const actions = head.querySelector(".row-actions");
      if (!actions) return;
      actions.classList.toggle("open", open);
      head.querySelector('[data-cpt="row-menu"]').setAttribute("aria-expanded", open);
    }
    document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".row-actions")) setRowMenu(false); });
    head.addEventListener("keydown", (e) => { if (e.key === "Escape") setRowMenu(false); });

    function collapseButton() {
      return `<button class="icon collapse" data-cpt="collapse" title="${prefs.collapsed ? "Expand" : "Collapse"}">${prefs.collapsed ? "▴" : "▾"}</button>`;
    }

    function headerHTML(n, parents, total) {
      const bad = M.badRows(n).length, cum = cumulative();
      const given = parents.length ? ` <span class="given">|</span> ${parents.map((p) => esc(p.name)).join(", ")}` : "";
      return `
        <span class="dock-title">P(<b>${esc(n.name)}</b>${given})</span>
        ${n.gate ? `<span class="dock-gate" title="Computed from the parents; editing a cell turns this into an ordinary table">${n.gate.toUpperCase()} of parents</span>` : ""}
        <span class="dock-status${bad ? " bad" : ""}">${bad
          ? `${bad} of ${total} row${total > 1 ? "s" : ""} ${bad > 1 ? "don't" : "doesn't"} sum to 1 · <button class="linkish" data-cpt="fix-all">Normalize ${bad > 1 ? "them" : "it"}</button>`
          : `<span title="${total > 1 ? `All ${total} rows sum` : "Sums"} to 1">✓<span class="full-only"> ${total > 1 ? `All ${total} rows sum` : "Sums"} to 1</span></span>`}</span>
        <span class="dock-tools">
        <span class="row-actions">
          <button class="small compact-only" data-cpt="row-menu" aria-haspopup="true" aria-expanded="false" title="Normalize, uniform or random rows">Rows ▾</button>
          <span class="row-action-list"><span class="scope muted"></span>
          <button class="small" data-cpt="normalize" title="Scale each row so it sums to 1">Normalize</button>
          <button class="small" data-cpt="uniform">Uniform</button>
          <button class="small" data-cpt="random">Random</button></span>
        </span>
        <span class="sep full-only"></span>
        <span class="seg-toggle" role="group" aria-label="Number format">
          <button class="small${prefs.format === "prob" ? " on" : ""}" data-cpt="mode-prob" title="Show probabilities">0.25</button><button class="small${prefs.format === "pct" ? " on" : ""}" data-cpt="mode-pct" title="Show percentages">25%</button><button class="small${prefs.format === "logodds" ? " on" : ""}" data-cpt="mode-logodds" title="Show log-odds: ln(p / (1 − p)), the natural log of each state's odds against the rest of its row. 0 is 50%, +2.2 is 90%, −2.2 is 10%, +4.6 is 99%. Type inf or −inf for 1 or 0, or a percentage such as 30%.">ln odds</button>
        </span>
        ${n.labels.length > 2 ? `<span class="seg-toggle" role="group" aria-label="Columns">
          <button class="small${cum ? "" : " on"}" data-cpt="view-each" aria-label="Each state" title="A column per state: the probability of each state"><span class="full-only">Each state</span><span class="compact-only">Each</span></button><button class="small${cum ? " on" : ""}" data-cpt="view-cumulative" aria-label="Cumulative" title="Cumulative, for states in order such as years: each column is P(≤ state), the probability of that state or an earlier one, such as 55% by 2028. Typing a value moves the divider after that state in the row's bar, so rows always sum to 1."><span class="full-only">Cumulative</span><span class="compact-only">≤</span></button>
        </span>` : ""}
        <span class="nowrap">${cum ? "" : `<label class="check" title="When you type a value, the other states in that row are adjusted so the row still sums to ${prefs.format === "pct" ? "100%" : "1"}">
          <input type="checkbox" data-cpt="balance"${prefs.balance ? " checked" : ""}> <span class="full-only">Keep rows summing to ${prefs.format === "pct" ? "100%" : "1"}</span><span class="compact-only">Auto-sum</span>
        </label>
        <button class="help-button" popovertarget="balance-help" title="How does this work?" aria-label="How keeping rows summing to 1 works">?</button>`}
        ${collapseButton()}</span>
        </span>`;
    }

    function barHTML(vals) {
      const scale = Math.max(1, sum(vals.map((v) => Math.max(0, v))));
      let acc = 0, segs = "", handles = "";
      const colors = stateColors(node().labels), cum = cumulative();
      vals.forEach((v, s) => {
        const w = (Math.max(0, v) / scale) * 100;
        const [bg, fg] = colors[s];
        const corners = `${s === 0 ? "5px" : "0"} ${s === vals.length - 1 ? "5px 5px" : "0 0"} ${s === 0 ? "5px" : "0"}`;
        // the cumulative view's cells don't show each state's share, so neither does its bar
        segs += `<div class="seg" data-seg="${s}" title="${Math.round(v * 1000) / 10}%" style="left:${acc}%;width:${w}%;background:${bg};color:${fg};border-radius:${corners}">${w >= 9 && !cum ? Math.round(v * 100) + "%" : ""}</div>`;
        acc += w;
        if (s < vals.length - 1) handles += `<div class="handle" data-h="${s}" style="left:${acc}%"></div>`;
      });
      return segs + handles;
    }

    function statusHTML(vals) {
      if (!rowBad(vals)) return "";
      return `<span class="row-sum">Σ ${fmt(round(sum(vals)), prefs.format === "logodds" ? "pct" : prefs.format)}</span> <button class="linkish" data-fix>fix</button>`;
    }

    // Every state header has the − / + buttons, shown only on the selected column (see
    // paintSelection), so selecting a column never changes the table's layout.
    const NUDGE = `<span class="nudge"><button class="small" data-nudge="-1" tabindex="-1">−</button><button class="small" data-nudge="1" tabindex="-1">+</button></span>`;

    function tableHTML(n, parents) {
      const shown = rows.slice(0, MAX_ROWS);
      // rowspans: a parent cell spans the following rows that share it and every parent to its left
      const spans = parents.map((_, k) => {
        const out = new Array(shown.length).fill(0);
        let start = 0;
        for (let r = 1; r <= shown.length; r++) {
          const same = r < shown.length && shown[r].idx.slice(0, k + 1).every((v, j) => v === shown[r - 1].idx[j]);
          if (!same) { out[start] = r - start; start = r; }
        }
        return out;
      });
      const headCells =
        parents.map((p) => `<th class="pcol"><div class="pname">${esc(p.name)}</div><select data-filter="${p.id}" title="Show only rows where ${esc(p.name)} has this state">
            <option value="">all</option>${p.labels.map((l, i) => `<option value="${i}"${filters.get(p.id) === i ? " selected" : ""}>${esc(l)}</option>`).join("")}
          </select></th>`).join("") +
        `<th class="bar-h" data-selall title="Select all rows">Distribution <span class="muted dist-hint">drag dividers · double-click a state for 100%</span></th>` +
        (cumulative()
          ? n.labels.slice(0, -1).map((l, c) => `<th class="state" data-col="${c}" title="P(${esc(n.name)} ${esc(upTo(c))}): select this column">${NUDGE}${esc(upTo(c))}</th>`).join("") +
            `<th class="median-h" title="The first state at which P(≤ state) reaches 50%">Median</th>`
          : n.labels.map((l, s) => `<th class="state" data-col="${s}" title="Select this column">${NUDGE}<i class="sw" style="background:${stateColors(n.labels)[s][0]}"></i>${esc(l)}</th>`).join("")) +
        `<th class="status-h"></th>`;
      const body = shown.map((row, r) => {
        const vals = n.cpt.slice(row.offset, row.offset + n.labels.length);
        const pcells = parents.map((p, k) => spans[k][r]
          ? `<td class="pcell" rowspan="${spans[k][r]}" data-r="${r}" data-span="${spans[k][r]}" title="Select ${spans[k][r] > 1 ? "these rows" : "this row"}">${esc(p.labels[row.idx[k]])}</td>`
          : "").join("");
        const cells = shownVals(vals).map(({ v, rest }, c) => `<td class="cell" data-r="${r}" data-c="${c}" title="${esc(cellTitle(v))}">${fmt(v, prefs.format, rest)}</td>`).join("") +
          (cumulative() ? `<td class="median">${rowBad(vals) ? "" : esc(median(vals))}</td>` : "");
        const cls = [rowBad(vals) && "bad", r > 0 && parents.length > 1 && spans[0][r] && "group-start", r % 2 && "odd"].filter(Boolean).join(" ");
        return `<tr data-r="${r}"${cls ? ` class="${cls}"` : ""}>${pcells}<td class="bar-cell"><div class="bar" data-row="${r}">${barHTML(vals)}</div></td>${cells}<td class="status">${statusHTML(vals)}</td></tr>`;
      }).join("");
      const more = rows.length > MAX_ROWS ? `<p class="dock-empty">Showing ${MAX_ROWS} of ${rows.length} rows. Use the filters in the parent columns to see the rest.</p>` : "";
      const none = !rows.length ? `<p class="dock-empty">No rows match the filters.</p>` : "";
      return `<table class="cpt-grid"><thead><tr>${headCells}</tr></thead><tbody>${body}</tbody></table>${more}${none}`;
    }

    // Highlights the hovered (or dragged) rows, including the merged parent cells they belong to.
    function setHot(next) {
      if (hot && next && hot.r0 === next.r0 && hot.r1 === next.r1) return;
      hot = next;
      paintHot();
    }
    function paintHot() {
      grid.querySelectorAll(".hot").forEach((el) => el.classList.remove("hot"));
      if (!hot) return;
      for (let r = hot.r0; r <= hot.r1; r++) grid.querySelector(`tr[data-r="${r}"]`)?.classList.add("hot");
      grid.querySelectorAll("td.pcell").forEach((td) => {
        const a = +td.dataset.r, b = a + +td.dataset.span - 1;
        if (a <= hot.r1 && b >= hot.r0) td.classList.add("hot");
      });
    }
    grid.addEventListener("mouseover", (e) => {
      if (barDrag) return;
      const pcell = e.target.closest("td.pcell");
      const tr = e.target.closest("tbody tr");
      if (pcell) setHot({ r0: +pcell.dataset.r, r1: +pcell.dataset.r + +pcell.dataset.span - 1 });
      else if (tr) setHot({ r0: +tr.dataset.r, r1: +tr.dataset.r });
      else setHot(null);
    });
    grid.addEventListener("mouseleave", () => { if (!barDrag) setHot(null); });

    // Floating label next to the pointer while dragging a divider: which row, and what changes.
    const tip = document.createElement("div");
    tip.className = "drag-tip";
    tip.hidden = true;
    document.body.appendChild(tip);
    function showTip(e, d) {
      const n = node(), row = rows[d.r];
      const cond = curParents.length ? curParents.map((p, k) => `${esc(p.name)} = <b>${esc(p.labels[row.idx[k]])}</b>`).join(", ") : "No parents";
      const now = rowVals(d.r);
      const pct = (v) => +(v * 100).toFixed(1) + "%";
      const change = cumulative()
        ? `<span>${esc(upTo(d.i))} ${pct(sum(d.vals.slice(0, d.i + 1)))} → <b>${pct(sum(now.slice(0, d.i + 1)))}</b></span>`
        : [d.i, d.i + 1].map((s) => `<span><i class="sw" style="background:${stateColors(n.labels)[s][0]}"></i>${esc(n.labels[s])} ${pct(d.vals[s])} → <b>${pct(now[s])}</b></span>`).join("");
      tip.innerHTML = `<div class="tip-cond">${cond}</div><div class="tip-change">${change}</div>`;
      tip.hidden = false;
      const x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14);
      const y = e.clientY - tip.offsetHeight - 14;
      tip.style.left = x + "px";
      tip.style.top = (y < 8 ? e.clientY + 18 : y) + "px";
    }

    // Briefly highlights the cells the last typed value changed besides the one typed in.
    function showAdjustment() {
      const adj = lastAdjust;
      lastAdjust = null;
      const r = adj ? rows.findIndex((row) => row.offset === adj.offset) : -1;
      const tr = r >= 0 && grid.querySelector(`tr[data-r="${r}"]`);
      if (!tr) return;
      for (const c of adj.cols) tr.querySelector(`td.cell[data-c="${c}"]`)?.classList.add("adjusted");
    }

    // Refreshes one row in place (used while dragging, where a full re-render would lose the pointer).
    function updateRow(r) {
      const tr = grid.querySelector(`tr[data-r="${r}"]`);
      if (!tr) return;
      const vals = rowVals(r);
      tr.querySelector(".bar").innerHTML = barHTML(vals);
      shownVals(vals).forEach(({ v, rest }, c) => {
        const td = tr.querySelector(`td.cell[data-c="${c}"]`);
        td.textContent = fmt(v, prefs.format, rest);
        td.title = cellTitle(v);
      });
      const med = tr.querySelector(".median");
      if (med) med.textContent = rowBad(vals) ? "" : median(vals);
      tr.querySelector(".status").innerHTML = statusHTML(vals);
      tr.classList.toggle("bad", rowBad(vals));
    }

    function scopeRows() {
      if (sel) {
        const { r0, r1 } = range();
        if (r1 > r0) return { list: rows.slice(r0, r1 + 1), label: `${r1 - r0 + 1} selected rows` };
      }
      const list = rows.slice(0, MAX_ROWS);
      return { list, label: filters.size ? `${list.length} filtered rows` : list.length > 1 ? `all ${list.length} rows` : "" };
    }

    function paintSelection() {
      // auto-balance only remembers typed states while you stay in the same row
      if (sel && rows[sel.ar] && rows[sel.ar].offset !== pins.offset) pins = { offset: -1, set: new Set() };
      grid.querySelectorAll("td.sel, td.active, th.nudging").forEach((td) => td.classList.remove("sel", "active", "nudging"));
      const scope = head.querySelector(".scope");
      if (scope) {
        const { label } = scopeRows();
        scope.textContent = label ? `Applies to ${label}:` : "";
        fitHeader(); // the label's length can change which header layout fits
      }
      if (!sel) return;
      const { r0, r1, c0, c1 } = range();
      // the − / + buttons go on the column you're in, and name what they change
      const th = grid.querySelector(`th.state[data-col="${sel.fc}"]`);
      if (th) {
        th.classList.add("nudging");
        const names = node().labels.slice(c0, c1 + 1).map((l, i) => (cumulative() ? `P(${upTo(c0 + i)})` : l));
        const what = names.length > 2 ? `${names[0]} to ${names.at(-1)}` : names.join(" and ");
        const where = r1 > r0 ? `the ${r1 - r0 + 1} selected rows` : "this row";
        const label = (b, text) => { b.title = text; b.setAttribute("aria-label", text); };
        label(th.querySelector('[data-nudge="1"]'), `More ${what} in ${where}: odds ×1.25 (Alt+↑; with Shift, ×1.05)`);
        label(th.querySelector('[data-nudge="-1"]'), `Less ${what} in ${where}: odds ÷1.25 (Alt+↓; with Shift, ÷1.05)`);
      }
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const td = grid.querySelector(`td.cell[data-r="${r}"][data-c="${c}"]`);
          if (td) td.classList.add("sel");
        }
      }
      const active = grid.querySelector(`td.cell[data-r="${sel.fr}"][data-c="${sel.fc}"]`);
      if (active) active.classList.add("active");
    }

    function scrollToFocus() {
      const td = sel && grid.querySelector(`td.cell[data-r="${sel.fr}"][data-c="${sel.fc}"]`);
      if (!td) return;
      // keep the cell clear of the sticky header
      const g = grid.getBoundingClientRect(), t = td.getBoundingClientRect();
      const headH = grid.querySelector("thead").getBoundingClientRect().height;
      if (t.top < g.top + headH) grid.scrollTop -= g.top + headH - t.top;
      else if (t.bottom > g.bottom) grid.scrollTop += t.bottom - g.bottom;
      if (t.left < g.left) grid.scrollLeft -= g.left - t.left;
      else if (t.right > g.right) grid.scrollLeft += t.right - g.right;
    }

    // ------------------------------------------------------------ edits

    // Editing a logic gate's table makes it an ordinary table (so you can, say, add a leak).
    function ungate() {
      const n = node();
      if (!n.gate) return;
      opts.toast(`${n.name} is now an ordinary table rather than ${n.gate === "and" ? "an AND" : "an OR"} of its parents`);
      delete n.gate;
    }
    // One undoable CPT edit; a gate whose values it changes stops being a gate.
    function editCpt(fn) {
      opts.change(() => {
        const before = node().cpt.join();
        fn();
        if (node().cpt.join() !== before) ungate();
      });
    }

    function mutateRows(offsets, fn) {
      editCpt(() => {
        const n = node(), c = n.labels.length;
        for (const o of offsets) fn(n.cpt, o, c);
      });
    }

    // Sets one cell. With auto-balance, the row's other states absorb the difference, except
    // those already typed in this row, so typing all but one state of a row fills in the last.
    // `comp`, when known, is 1 - v computed exactly from what was typed (see parseComplement).
    function setValue(r, c, v, comp = 1 - v) {
      const o = rows[r].offset;
      if (pins.offset !== o) pins = { offset: o, set: new Set() };
      editCpt(() => {
        const cpt = node().cpt, k = card();
        cpt[o + c] = v;
        if (!prefs.balance || k < 2) return;
        const others = [...Array(k).keys()].filter((s) => s !== c);
        let free = others.filter((s) => !pins.set.has(s));
        let pinned = sum(others.filter((s) => !free.includes(s)).map((s) => cpt[o + s]));
        // When the typed values no longer fit under 1 (or nothing is left to adjust), the new value
        // wins and every other state in the row is rescaled.
        if (!free.length || v + pinned > 1 + 1e-9) { free = others; pinned = 0; pins.set = new Set(); }
        const rem = comp - pinned, cur = sum(free.map((s) => cpt[o + s]));
        const before = free.map((s) => cpt[o + s]);
        for (const s of free) cpt[o + s] = round(rem <= 0 ? 0 : cur > 0 ? (cpt[o + s] * rem) / cur : rem / free.length);
        const changed = free.filter((s, i) => Math.abs(cpt[o + s] - before[i]) > 1e-12);
        lastAdjust = changed.length ? { offset: o, cols: changed } : null;
      });
      pins.set.add(c);
    }

    // A row's states as exact decimals (see dec), the digits they show; null for a row that
    // doesn't sum to 1, which has no exact P(≤ state).
    const rowDecs = (vals) => (rowBad(vals) ? null : vals.map((x) => dec(M.fmtNum(x))));
    const decSum = (xs) => xs.reduce(plus, [0n, 0]);

    // Gives the states, walked in from one end of a row, a total: each keeps its value while it
    // still fits, the first one that doesn't (or the last one) takes what's left, and any after it
    // drop to 0. The total is a number, or an exact decimal (see dec) when it was typed or copied
    // as one. It's then worked out with the states' decimals, so a total of 0.40000000000000000001
    // after a state of 0.4 leaves 1e-20, where floating point leaves 0; and states that already
    // add up to the total to within `slack` (see setDividers) are left as they are.
    function share(cpt, o, states, total, slack) {
      let done = false;
      if (Array.isArray(total)) {
        const decs = states.map((s) => dec(M.fmtNum(cpt[o + s])));
        const off = minus(total, decSum(decs));
        if (slack && minus(slack, [off[0] < 0n ? -off[0] : off[0], off[1]])[0] >= 0n) return;
        let left = total;
        states.forEach((s, i) => {
          if (done) cpt[o + s] = 0;
          else if (i < states.length - 1 && minus(left, decs[i])[0] >= 0n) left = minus(left, decs[i]);
          else { cpt[o + s] = left[0] > 0n ? round(decNum(left)) : 0; done = true; }
        });
        return;
      }
      let left = total;
      states.forEach((s, i) => {
        if (done) cpt[o + s] = 0;
        else if (i < states.length - 1 && cpt[o + s] <= left) left -= cpt[o + s];
        else {
          // a remainder within rounding of the total counts as nothing
          cpt[o + s] = left > 1e-12 * total ? round(left) : 0;
          done = true;
        }
      });
    }

    // Puts dividers c0..c1 of the row at offset o in place (divider c comes after state c): the
    // states up to c0 then add up to `below`, the states after c1 to `above` (each a number or an
    // exact decimal, see share), and the states between get `between`. Walking in from each end
    // of the row (see share), the states beside the outer dividers take up the difference, and a
    // divider that passes others pushes them along, so the states it passes drop to 0. With
    // c0 = c1 and above = 1 - below, that moves one divider to `below`, and a row that didn't sum
    // to 1 does afterwards.
    function setDividers(cpt, o, c0, c1, below, between, above) {
      const k = card(), decs = rowDecs(cpt.slice(o, o + k));
      // how far the row's decimals miss 1 (a 1e-20 state makes it 1 + 1e-20): an outer divider
      // put back where it is to within that stays put, so pasting a row's values back changes nothing
      const slack = decs && minus([1n, 0], decSum(decs));
      if (slack && slack[0] < 0n) slack[0] = -slack[0];
      between.forEach((p, i) => (cpt[o + c0 + 1 + i] = p));
      share(cpt, o, [...Array(c0 + 1).keys()], below, slack);
      share(cpt, o, [...Array(k - c1 - 1).keys()].map((i) => k - 1 - i), above, slack);
    }

    // Sets one cell of the cumulative view, P(≤ state c), to v, with comp 1 - v; see setDividers.
    function setCumulative(r, c, v, comp) {
      editCpt(() => {
        const before = shownVals(rowVals(r));
        setDividers(node().cpt, rows[r].offset, c, c, v, [], comp);
        const changed = shownVals(rowVals(r)).flatMap(({ v: now }, j) => {
          const was = before[j].v;
          return j !== c && Math.abs(now - was) > 1e-12 * Math.max(now, was) ? [j] : [];
        });
        lastAdjust = changed.length ? { offset: rows[r].offset, cols: changed } : null;
      });
    }

    // Nudges the selected cells up (dir 1) or down (-1) in every selected row: the odds of the
    // selected states against the rest of their row are multiplied by 1.25 (1.05 for a fine step),
    // so rows keep their differences and a state at 0 or 1 stays there. In the cumulative view each
    // selected divider moves by that factor instead, so selecting every column shifts whole rows
    // earlier or later.
    function nudge(dir, fine) {
      if (!sel) return;
      const { r0, r1, c0, c1 } = range(), cum = cumulative(), n = card();
      if (!cum && c0 === 0 && c1 === n - 1) {
        opts.toast("A row always sums to 1: select some of its states to nudge them");
        return;
      }
      const k = (fine ? 1.05 : 1.25) ** dir, picked = (s) => s >= c0 && s <= c1;
      let changed = null; // stays null when the edit isn't allowed
      editCpt(() => {
        const cpt = node().cpt, before = cpt.join();
        for (let r = r0; r <= Math.min(r1, rows.length - 1); r++) {
          const o = rows[r].offset;
          if (cum) {
            // Worked out on the row scaled to sum to 1 (and scaled back by its total T), so the
            // weights of a row that doesn't sum to 1, such as 1e-200 · 2e-200, neither underflow
            // nor overflow. With a = k·L + R at a divider with P(≤) = L and P(>) = R, its L
            // becomes k·L / a. Each changed state is worked out from its own probability p rather
            // than by subtracting new L's, which would lose a 1e-20 (or leave rounding residue
            // where there was 0): between two selected dividers p becomes k·p / (a₁·a₂); just below
            // the first one, after an unselected divider at L₀ = 1 − R₀,
            // ((k − 1)·L₀·R₀ + p·(k·R₀ + L₀)) / a; just above the last one, before an unselected
            // divider at 1 − R₂, (p + (1 − k)·L·R₂) / a. When one of those comes out negative,
            // the divider passes unselected ones and pushes them along (see share).
            const vals = rowVals(r), T = sum(vals);
            if (!(T > 0 && T < Infinity)) continue;
            const q = vals.map((x) => x / T), shown = shownVals(q);
            const a = (c) => k * shown[c].v + shown[c].rest;
            const [L0, R0] = c0 ? [shown[c0 - 1].v, shown[c0 - 1].rest] : [0, 1];
            const R2 = c1 + 1 < n - 1 ? shown[c1 + 1].rest : 0;
            const first = ((k - 1) * L0 * R0 + q[c0] * (k * R0 + L0)) / a(c0);
            const next = (q[c1 + 1] + (1 - k) * shown[c1].v * R2) / a(c1);
            q.slice(c0 + 1, c1 + 1).forEach((p, i) => (cpt[o + c0 + 1 + i] = round(T * ((k * p) / (a(c0 + i) * a(c0 + i + 1))))));
            if (first >= 0) cpt[o + c0] = round(T * first);
            else share(cpt, o, [...Array(c0 + 1).keys()], T * ((k * shown[c0].v) / a(c0)));
            if (next >= 0) cpt[o + c1 + 1] = round(T * next);
            else share(cpt, o, [...Array(n - c1 - 1).keys()].map((i) => n - 1 - i), T * (shown[c1].rest / a(c1)));
          } else {
            let g = 0, h = 0;
            for (let s = 0; s < n; s++) picked(s) ? (g += cpt[o + s]) : (h += cpt[o + s]);
            if (!(g > 0 && h > 0)) continue;
            const scale = (g + h) / (k * g + h); // keeps the row's total
            for (let s = 0; s < n; s++) cpt[o + s] = round(cpt[o + s] * (picked(s) ? k : 1) * scale);
          }
        }
        changed = cpt.join() !== before;
      });
      if (changed === false) opts.toast("Nothing to nudge: states at 0% or 100% stay there, since a nudge multiplies odds");
    }

    // Writes a block of values the way the table shows them: states, or P(≤ state) in the
    // cumulative view. Each is { v, comp, exact }, with comp 1 - v when it's known more exactly
    // (see parseComplement) and exact the value as an exact decimal when it was typed as one (see
    // exactProb). A row's P(≤ state) values in order set their dividers together, each state between
    // two of them being the difference of their exact decimals, so a 1e-20 there survives a copy
    // and paste; out of order, each moves its divider in turn, left to right, pushing the others.
    function setBlock(r0, c0, matrix) {
      editCpt(() => {
        const cpt = node().cpt, cum = cumulative();
        matrix.forEach((full, i) => {
          if (r0 + i >= rows.length) return;
          const o = rows[r0 + i].offset, line = full.slice(0, cols() - c0);
          if (!cum) return line.forEach(({ v }, j) => (cpt[o + c0 + j] = v));
          const below = (x) => x.exact || x.v, above = (x) => (x.exact ? minus([1n, 0], x.exact) : x.comp >= 0 ? x.comp : 1 - x.v);
          if (line.every((x, j) => !j || x.v >= line[j - 1].v)) {
            const between = line.slice(1).map((x, j) => round(Math.max(0, x.exact && line[j].exact ? decNum(minus(x.exact, line[j].exact)) : x.v - line[j].v)));
            setDividers(cpt, o, c0, c0 + line.length - 1, below(line[0]), between, above(line.at(-1)));
          } else line.forEach((x, j) => setDividers(cpt, o, c0 + j, c0 + j, below(x), [], above(x)));
        });
      });
    }

    function startEdit(r, c, initial) {
      const td = grid.querySelector(`td.cell[data-r="${r}"][data-c="${c}"]`);
      if (!td) return;
      sel = { ar: r, ac: c, fr: r, fc: c };
      paintSelection();
      const { v, rest } = shownVals(rowVals(r))[c];
      const input = document.createElement("input");
      input.className = "cell-edit";
      input.inputMode = "decimal";
      const x = logOdds(v, rest);
      input.value = initial ?? (prefs.format === "pct" ? M.fmtNum(v * 100)
        : prefs.format === "logodds" ? (x === Infinity ? "inf" : x === -Infinity ? "-inf" : M.fmtNum(+x.toPrecision(12))) : M.fmtNum(v));
      td.textContent = "";
      td.appendChild(input);
      edit = { r, c, input, overwrite: initial != null };
      input.focus();
      if (initial == null) input.select();
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        const k = e.key;
        if (k === "Enter") { e.preventDefault(); if (commitEdit()) move(e.shiftKey ? -1 : 1, 0); }
        else if (k === "Tab") { e.preventDefault(); if (commitEdit()) moveTab(e.shiftKey); }
        else if (k === "Escape") { e.preventDefault(); cancelEdit(); }
        else if (edit && edit.overwrite && k.startsWith("Arrow")) {
          e.preventDefault();
          if (commitEdit()) move(...{ ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[k]);
        }
      });
      input.addEventListener("blur", () => commitEdit());
    }

    function commitEdit() {
      if (!edit) return true;
      const { r, c, input } = edit;
      edit = null;
      const v = parseProb(input.value, prefs.format), cum = cumulative();
      if (!(v >= 0) || (cum && v > 1)) {
        opts.toast(cum && v > 1 ? `P(${upTo(c)}) can't be more than ${prefs.format === "pct" ? "100%" : "1"}`
          : prefs.format === "logodds" ? "Enter log-odds such as 2.2 or -1.5, inf or -inf, or a probability such as 30%" : "Enter a probability such as 0.3, 30% or 1/3");
        render(nodeId);
        grid.focus({ preventScroll: true });
        return false;
      }
      const { v: old, rest } = shownVals(rowVals(r))[c], comp = parseComplement(input.value, prefs.format);
      // Unchanged up to the 12 digits the edit box shows. Relative, so 1e-20 → 3e-20 is a change, and
      // with auto-sum or in the cumulative view the rest of the row counts too: typing 1 - 1e-20 over
      // a 1 (the same number in floating point) still changes the other states to 1e-20.
      const same = (a, b) => Math.abs(a - b) <= 1e-11 * Math.max(a, b);
      if (same(old, v) && (!(cum || prefs.balance) || card() < 2 || !(comp >= 0) || same(rest, comp))) render(nodeId);
      else if (cum) {
        const x = exactProb(input.value, prefs.format);
        setCumulative(r, c, x || v, x ? minus([1n, 0], x) : comp >= 0 ? comp : 1 - v);
      } else setValue(r, c, v, comp >= 0 ? comp : undefined);
      grid.focus({ preventScroll: true });
      return true;
    }

    function cancelEdit() {
      edit = null;
      render(nodeId);
      grid.focus({ preventScroll: true });
    }

    function move(dr, dc, extend = false) {
      if (!rows.length) return;
      const maxR = Math.min(rows.length, MAX_ROWS) - 1, maxC = cols() - 1;
      if (!sel) sel = { ar: 0, ac: 0, fr: 0, fc: 0 };
      const r = Math.max(0, Math.min(maxR, (extend ? sel.fr : sel.ar) + dr));
      const c = Math.max(0, Math.min(maxC, (extend ? sel.fc : sel.ac) + dc));
      if (extend) { sel.fr = r; sel.fc = c; } else sel = { ar: r, ac: c, fr: r, fc: c };
      paintSelection();
      scrollToFocus();
    }

    function moveTab(back) {
      if (!sel) return move(0, 0);
      const maxC = cols() - 1, maxR = Math.min(rows.length, MAX_ROWS) - 1;
      let r = sel.ar, c = sel.ac + (back ? -1 : 1);
      if (c > maxC) { c = 0; r = Math.min(maxR, r + 1); }
      if (c < 0) { c = maxC; r = Math.max(0, r - 1); }
      sel = { ar: r, ac: c, fr: r, fc: c };
      paintSelection();
      scrollToFocus();
    }

    function selectAll() {
      if (!rows.length) return;
      sel = { ar: 0, ac: 0, fr: Math.min(rows.length, MAX_ROWS) - 1, fc: cols() - 1 };
      paintSelection();
    }

    const normalizeRow = (cpt, o, c) => M.normalizeRow(cpt, o, c);
    const uniformRow = (cpt, o, c) => { for (let s = 0; s < c; s++) cpt[o + s] = 1 / c; };
    const randomRow = (cpt, o, c) => { for (let s = 0; s < c; s++) cpt[o + s] = Math.random() + 1e-3; M.normalizeRow(cpt, o, c); };

    function deterministic(r, s) {
      mutateRows([rows[r].offset], (cpt, o, c) => { for (let i = 0; i < c; i++) cpt[o + i] = i === s ? 1 : 0; });
    }

    function fillDown() {
      if (!sel) return;
      let { r0, r1, c0, c1 } = range();
      let src = r0;
      if (r0 === r1) { if (r0 === 0) return; src = r0 - 1; } else r0++;
      const vals = rowVals(src);
      if (cumulative()) {
        // the source row's dividers, exact when it can have them, with the states between them
        // copied as they are
        const shown = shownVals(vals), decs = rowDecs(vals);
        const below = decs ? decSum(decs.slice(0, c0 + 1)) : shown[c0].v, above = decs ? decSum(decs.slice(c1 + 1)) : shown[c1].rest;
        editCpt(() => {
          for (let r = r0; r <= r1; r++) setDividers(node().cpt, rows[r].offset, c0, c1, below, vals.slice(c0 + 1, c1 + 1), above);
        });
      } else setBlock(r0, c0, Array.from({ length: r1 - r0 + 1 }, () => vals.slice(c0, c1 + 1).map((v) => ({ v }))));
    }

    function clearSelection() {
      if (!sel) return;
      const { r0, r1, c0, c1 } = range();
      setBlock(r0, c0, Array.from({ length: r1 - r0 + 1 }, () => new Array(c1 - c0 + 1).fill({ v: 0, comp: 1 })));
    }

    // ------------------------------------------------------------ clipboard

    document.addEventListener("copy", (e) => {
      if (document.activeElement !== grid || !sel) return;
      const { r0, r1, c0, c1 } = range();
      const lines = [];
      for (let r = r0; r <= r1; r++) {
        const line = [], vals = rowVals(r), shown = shownVals(vals), pct = prefs.format !== "prob";
        // P(≤ state c) as an exact decimal, so the states between copied dividers paste back as
        // they were (see setBlock), where 0.4 + 1e-20 as a number is 0.4: the states up to c, or
        // 1 minus the states after c. Those differ by however much the row's decimals miss 1 (a
        // 1e-20 state makes it 1 + 1e-20), so the copy takes the first up to some divider m and
        // the second from there on, putting that difference where rounding hides it rather than
        // where it would take a 1e-20 with it: on the largest of the states between the copied
        // dividers, the states before the first one (m = c0), and the states after the last one.
        const decs = cumulative() && rowDecs(vals);
        const mass = (j) => (j === c0 ? shown[c0].v : j === c1 + 1 ? shown[c1].rest : vals[j]);
        let m = c0;
        for (let j = c0 + 1; j <= c1 + 1; j++) if (mass(j) >= mass(m)) m = j;
        for (let c = c0; c <= c1; c++) {
          const { v } = shown[c];
          // percentages carry their % sign, so pasting reads them back the same in any format (log-odds
          // are copied as percentages too: bare log-odds would be misread as probabilities elsewhere).
          let text = M.fmtNum(pct ? v * 100 : v);
          if (decs) {
            // (either way, kept from 0 to 1)
            const lower = decSum(decs.slice(0, c + 1)), upper = minus([1n, 0], decSum(decs.slice(c + 1)));
            const exact = c >= m ? (upper[0] >= 0n ? upper : lower) : minus([1n, 0], lower)[0] >= 0n ? lower : upper;
            const want = pct ? times100(exact) : exact;
            if (minus(dec(text), want)[0] !== 0n) text = decText(want); // the short form when it's exact
          }
          line.push(pct ? text + "%" : text);
        }
        lines.push(line.join("\t"));
      }
      e.clipboardData.setData("text/plain", lines.join("\n"));
      e.preventDefault();
      opts.toast(`Copied ${(r1 - r0 + 1) * (c1 - c0 + 1)} values`);
    });

    document.addEventListener("paste", (e) => {
      if (document.activeElement !== grid || !sel || !rows.length) return;
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain").replace(/\r/g, "").replace(/\n+$/, "");
      if (!text) return;
      const matrix = text.split("\n").map((line) => line.split(line.includes("\t") ? "\t" : /[;,\s]+/).filter((x) => x.trim() !== "").map((x) => ({ v: parseProb(x, prefs.format), comp: parseComplement(x, prefs.format), exact: exactProb(x, prefs.format) })));
      // (P(≤ state) can't be more than 1, so the cumulative view takes only probabilities)
      if (!matrix.length || matrix.some((l) => !l.length || l.some(({ v }) => !(v >= 0) || (cumulative() && v > 1)))) {
        opts.toast("The clipboard does not contain a table of probabilities");
        return;
      }
      const mh = matrix.length, mw = Math.max(...matrix.map((l) => l.length));
      const { r0, r1, c0, c1 } = range();
      const h = r1 - r0 + 1, w = c1 - c0 + 1;
      let block = matrix;
      // Like a spreadsheet: a smaller block that divides the selection is repeated to fill it.
      if ((h > mh || w > mw) && h % mh === 0 && w % mw === 0 && matrix.every((l) => l.length === mw)) {
        block = Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => matrix[i % mh][j % mw]));
      }
      setBlock(r0, c0, block);
      const maxR = Math.min(rows.length, MAX_ROWS) - 1;
      sel = { ar: r0, ac: c0, fr: Math.min(maxR, r0 + block.length - 1), fc: Math.min(cols() - 1, c0 + Math.max(...block.map((l) => l.length)) - 1) };
      paintSelection();
    });

    // ------------------------------------------------------------ pointer

    grid.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !node()) return;
      // the − / + buttons leave focus (and an unfinished cell edit) where it is until the click
      if (e.target.closest("[data-nudge]")) { e.preventDefault(); return; }
      if (e.target.closest("select, input, button, .handle")) return;
      const cell = e.target.closest("td.cell");
      const pcell = e.target.closest("td.pcell");
      const colHead = e.target.closest("th.state");
      const seg = e.target.closest(".seg");
      const bar = e.target.closest(".bar");
      if (!commitEdit()) return;
      const maxR = Math.min(rows.length, MAX_ROWS) - 1;
      if (cell) {
        const r = +cell.dataset.r, c = +cell.dataset.c;
        if (e.shiftKey && sel) { sel.fr = r; sel.fc = c; } else sel = { ar: r, ac: c, fr: r, fc: c };
        mouseSelecting = true;
      } else if (pcell) {
        const r = +pcell.dataset.r;
        sel = { ar: r, ac: 0, fr: r + +pcell.dataset.span - 1, fc: cols() - 1 };
      } else if (colHead) {
        const c = +colHead.dataset.col;
        sel = { ar: 0, ac: c, fr: maxR, fc: c };
      } else if (e.target.closest("[data-selall]")) {
        selectAll();
      } else if (bar) {
        const r = +bar.dataset.row, c = seg ? Math.min(+seg.dataset.seg, cols() - 1) : 0;
        sel = { ar: r, ac: c, fr: r, fc: c };
      } else return;
      e.preventDefault();
      grid.focus({ preventScroll: true });
      paintSelection();
    });
    grid.addEventListener("mouseover", (e) => {
      if (!mouseSelecting || !sel) return;
      const cell = e.target.closest("td.cell");
      if (!cell) return;
      sel.fr = +cell.dataset.r;
      sel.fc = +cell.dataset.c;
      paintSelection();
    });
    document.addEventListener("mouseup", () => { mouseSelecting = false; });

    grid.addEventListener("dblclick", (e) => {
      const cell = e.target.closest("td.cell");
      if (cell && !edit) { startEdit(+cell.dataset.r, +cell.dataset.c); return; }
      const seg = e.target.closest(".seg");
      if (seg) deterministic(+seg.closest(".bar").dataset.row, +seg.dataset.seg);
    });

    // Dragging a divider moves probability between the two states on either side of it.
    grid.addEventListener("pointerdown", (e) => {
      const handle = e.target.closest(".handle");
      if (!handle || e.button !== 0) return;
      if (!commitEdit()) return;
      e.preventDefault();
      const barEl = handle.closest(".bar");
      const r = +barEl.dataset.row, h = +handle.dataset.h;
      const vals = rowVals(r);
      const cum = []; // cum[i] = position of divider i (end of state i)
      vals.reduce((a, v, i) => (cum[i] = a + Math.max(0, v)), 0);
      // Dividers at the same spot (zero-probability states) are resolved by drag direction.
      let lo = h, hi = h;
      while (lo > 0 && Math.abs(cum[lo - 1] - cum[h]) < 1e-12) lo--;
      while (hi < vals.length - 2 && Math.abs(cum[hi + 1] - cum[h]) < 1e-12) hi++;
      barDrag = { r, vals, cum, lo, hi, i: lo === hi ? lo : null, rect: barEl.getBoundingClientRect(), scale: Math.max(1, cum[cum.length - 1]), started: false };
      sel = { ar: r, ac: h, fr: r, fc: h };
      paintSelection();
      setHot({ r0: r, r1: r });
      grid.classList.add("dragging");
      grid.focus({ preventScroll: true });
      grid.setPointerCapture(e.pointerId);
    });
    grid.addEventListener("pointermove", (e) => {
      const d = barDrag;
      if (!d) return;
      let b = Math.max(0, Math.min(1, (e.clientX - d.rect.left) / d.rect.width)) * d.scale;
      if (d.i === null) {
        if (Math.abs(b - d.cum[d.lo]) * d.rect.width < 2) return;
        d.i = b > d.cum[d.lo] ? d.hi : d.lo;
      }
      const i = d.i;
      const start = i > 0 ? d.cum[i - 1] : 0, end = d.cum[i + 1];
      const step = e.shiftKey ? 0.001 : 0.01;
      b = Math.max(start, Math.min(end, Math.round(b / step) * step));
      if (!d.started) { opts.checkpoint(); ungate(); d.started = true; }
      const cpt = node().cpt, o = rows[d.r].offset;
      cpt[o + i] = round(b - start);
      cpt[o + i + 1] = round(end - b);
      updateRow(d.r);
      opts.onLiveEdit();
      sel = { ar: d.r, ac: i, fr: d.r, fc: i };
      paintSelection();
      showTip(e, d);
    });
    const endBarDrag = () => {
      if (!barDrag) return;
      const started = barDrag.started;
      barDrag = null;
      tip.hidden = true;
      grid.classList.remove("dragging");
      if (started) opts.afterDirectEdit();
    };
    grid.addEventListener("pointerup", endBarDrag);
    grid.addEventListener("pointercancel", endBarDrag);

    // ------------------------------------------------------------ keyboard

    grid.addEventListener("keydown", (e) => {
      if (edit || e.target !== grid || !node() || !rows.length) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key;
      const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (e.altKey && !mod && (k === "ArrowUp" || k === "ArrowDown")) {
        if (!sel) move(0, 0);
        nudge(k === "ArrowUp" ? 1 : -1, e.shiftKey);
      } else if (arrows[k]) {
        let [dr, dc] = arrows[k];
        if (mod) { dr *= rows.length; dc *= card(); }
        move(dr, dc, e.shiftKey);
      } else if (k === "Tab") moveTab(e.shiftKey);
      else if (k === "Enter" || k === "F2") { if (!sel) move(0, 0); startEdit(sel.fr, sel.fc); }
      else if (k === "Delete" || k === "Backspace") clearSelection();
      else if (k === "Escape") opts.onEscape();
      else if (mod && k.toLowerCase() === "a") selectAll();
      else if (mod && k.toLowerCase() === "d") fillDown();
      else if (!mod && !e.altKey && k.length === 1 && /[\d.\/%]/.test(k)) {
        if (!sel) move(0, 0);
        startEdit(sel.fr, sel.fc, k);
      } else return;
      e.preventDefault();
    });

    // ------------------------------------------------------------ header controls

    head.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cpt]");
      if (!b || !node()) {
        if (b && b.dataset.cpt === "collapse") toggleCollapse();
        return;
      }
      if (b.dataset.cpt === "row-menu") { setRowMenu(!head.querySelector(".row-actions").classList.contains("open")); return; }
      setRowMenu(false);
      const offsets = scopeRows().list.map((r) => r.offset);
      switch (b.dataset.cpt) {
        case "normalize": mutateRows(offsets, normalizeRow); break;
        case "uniform": mutateRows(offsets, uniformRow); break;
        case "random": mutateRows(offsets, randomRow); break;
        case "fix-all": mutateRows(M.badRows(node()), normalizeRow); break;
        case "mode-prob": prefs.format = "prob"; savePrefs(); render(nodeId); break;
        case "mode-pct": prefs.format = "pct"; savePrefs(); render(nodeId); break;
        case "mode-logodds": prefs.format = "logodds"; savePrefs(); render(nodeId); break;
        case "view-each": case "view-cumulative":
          prefs.cumulative = b.dataset.cpt === "view-cumulative";
          savePrefs();
          render(nodeId);
          break;
        case "collapse": toggleCollapse(); break;
      }
    });
    head.addEventListener("change", (e) => {
      if (e.target.dataset.cpt === "balance") { prefs.balance = e.target.checked; savePrefs(); }
    });
    grid.addEventListener("change", (e) => {
      const f = e.target.closest("[data-filter]");
      if (!f) return;
      if (f.value === "") filters.delete(+f.dataset.filter);
      else filters.set(+f.dataset.filter, +f.value);
      sel = null;
      render(nodeId);
    });
    grid.addEventListener("click", (e) => {
      const fix = e.target.closest("[data-fix]");
      if (fix) mutateRows([rows[+fix.closest("tr").dataset.r].offset], normalizeRow);
      const step = e.target.closest("[data-nudge]");
      if (step && commitEdit()) {
        nudge(+step.dataset.nudge, e.shiftKey);
        grid.focus({ preventScroll: true });
      }
    });

    function toggleCollapse() {
      prefs.collapsed = !prefs.collapsed;
      savePrefs();
      render(nodeId);
      opts.onResize();
    }

    // ------------------------------------------------------------ resizing

    dock.querySelector(".dock-resize").addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (prefs.collapsed) { prefs.collapsed = false; render(nodeId); }
      const startY = e.clientY, startH = dock.getBoundingClientRect().height;
      const max = dock.parentElement.getBoundingClientRect().height - 120;
      const onMove = (ev) => {
        prefs.height = Math.round(Math.max(90, Math.min(max, startH + startY - ev.clientY)));
        dock.style.height = prefs.height + "px";
        opts.onResize();
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        savePrefs();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    function focus() {
      if (!node() || !rows.length) return;
      if (prefs.collapsed) toggleCollapse();
      if (!sel) sel = { ar: 0, ac: 0, fr: 0, fc: 0 };
      paintSelection();
      grid.focus({ preventScroll: true });
      scrollToFocus();
    }

    return {
      render: (id) => render(id), focus, isEditing: () => !!edit || !!barDrag,
      finishEditing: () => { commitEdit(); endBarDrag(); mouseSelecting = false; },
    };
  }

  globalThis.BNCptEditor = { createCptEditor, parseProb };
})();
