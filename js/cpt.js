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
  const color = (s) => PALETTE[s % PALETTE.length];

  // Accepts 0.3, .3, 30%, 1/3 (and in percent mode, 30 means 30%).
  function parseProb(text, percent) {
    const t = String(text).trim().replace(/\s+/g, "");
    if (!t) return NaN;
    let m;
    if ((m = /^([\d.]+(?:e-?\d+)?)%$/i.exec(t))) return +m[1] / 100;
    if ((m = /^([\d.]+)\/([\d.]+)$/.exec(t))) return +m[2] > 0 ? +m[1] / +m[2] : NaN;
    if (!/^[\d.]+(?:e-?\d+)?$/i.test(t)) return NaN;
    return percent ? +t / 100 : +t;
  }

  function createCptEditor(dock, opts) {
    const prefs = { percent: false, balance: true, height: 300, collapsed: false };
    try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch {}
    const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));

    let nodeId = null;
    let filters = new Map(); // parent id -> state index
    let rows = []; // visible rows: {idx, offset}
    let sel = null; // {ar, ac, fr, fc}: anchor and focus cell, in visible-row / state indices
    let edit = null; // {r, c, input, overwrite}
    let pins = { offset: -1, set: new Set() }; // states typed in the current row (kept when balancing)
    let lastAdjust = null; // {offset, states}: cells changed by the last balancing, highlighted once
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
    const fmt = (v) => {
      if (!Number.isFinite(v)) return "?";
      if (prefs.percent) return +(v * 100).toFixed(2) + "%";
      if (v !== 0 && Math.abs(v) < 1e-4) return v.toExponential(1);
      return String(+v.toFixed(4));
    };
    const rowVals = (r) => node().cpt.slice(rows[r].offset, rows[r].offset + card());
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
        const clampC = (c) => Math.min(c, n.labels.length - 1);
        sel = rows.length ? { ar: clampR(sel.ar), fr: clampR(sel.fr), ac: clampC(sel.ac), fc: clampC(sel.fc) } : null;
      }
      head.innerHTML = headerHTML(n, parents, all.length);
      curParents = parents;
      grid.innerHTML = tableHTML(n, parents);
      paintHot();
      showAdjustment();
      paintSelection();
    }

    function collapseButton() {
      return `<button class="icon collapse" data-cpt="collapse" title="${prefs.collapsed ? "Expand" : "Collapse"}">${prefs.collapsed ? "▴" : "▾"}</button>`;
    }

    function headerHTML(n, parents, total) {
      const bad = M.badRows(n).length;
      const given = parents.length ? ` <span class="given">|</span> ${parents.map((p) => esc(p.name)).join(", ")}` : "";
      return `
        <span class="dock-title">P(<b>${esc(n.name)}</b>${given})</span>
        <span class="dock-status${bad ? " bad" : ""}">${bad
          ? `${bad} of ${total} row${total > 1 ? "s" : ""} ${bad > 1 ? "don't" : "doesn't"} sum to 1 · <button class="linkish" data-cpt="fix-all">Normalize ${bad > 1 ? "them" : "it"}</button>`
          : `✓ ${total > 1 ? `All ${total} rows sum` : "Sums"} to 1`}</span>
        <span class="dock-tools">
        <span class="nowrap"><span class="scope muted"></span>
        <button class="small" data-cpt="normalize" title="Scale each row so it sums to 1">Normalize</button>
        <button class="small" data-cpt="uniform">Uniform</button>
        <button class="small" data-cpt="random">Random</button></span>
        <span class="sep"></span>
        <span class="seg-toggle" role="group" aria-label="Number format">
          <button class="small${prefs.percent ? "" : " on"}" data-cpt="mode-prob" title="Show probabilities">0.25</button><button class="small${prefs.percent ? " on" : ""}" data-cpt="mode-pct" title="Show percentages">25%</button>
        </span>
        <span class="nowrap"><label class="check" title="When you type a value, the other states in that row are adjusted so the row still sums to ${prefs.percent ? "100%" : "1"}">
          <input type="checkbox" data-cpt="balance"${prefs.balance ? " checked" : ""}> Keep rows summing to ${prefs.percent ? "100%" : "1"}
        </label>
        <button class="help-button" popovertarget="balance-help" title="How does this work?" aria-label="How keeping rows summing to 1 works">?</button></span>
        ${collapseButton()}
        </span>`;
    }

    function barHTML(vals) {
      const scale = Math.max(1, sum(vals.map((v) => Math.max(0, v))));
      let acc = 0, segs = "", handles = "";
      vals.forEach((v, s) => {
        const w = (Math.max(0, v) / scale) * 100;
        const [bg, fg] = color(s);
        const corners = `${s === 0 ? "5px" : "0"} ${s === vals.length - 1 ? "5px 5px" : "0 0"} ${s === 0 ? "5px" : "0"}`;
        segs += `<div class="seg" data-seg="${s}" title="${Math.round(v * 1000) / 10}%" style="left:${acc}%;width:${w}%;background:${bg};color:${fg};border-radius:${corners}">${w >= 6 ? Math.round(v * 100) + "%" : ""}</div>`;
        acc += w;
        if (s < vals.length - 1) handles += `<div class="handle" data-h="${s}" style="left:${acc}%"></div>`;
      });
      return segs + handles;
    }

    function statusHTML(vals) {
      if (!rowBad(vals)) return "";
      return `<span class="row-sum">Σ ${fmt(round(sum(vals)))}</span> <button class="linkish" data-fix>fix</button>`;
    }

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
        `<th class="bar-h" data-selall title="Select all rows">Distribution <span class="muted">drag dividers · double-click a state for 100%</span></th>` +
        n.labels.map((l, s) => `<th class="state" data-col="${s}" title="Select this column"><i class="sw" style="background:${color(s)[0]}"></i>${esc(l)}</th>`).join("") +
        `<th class="status-h"></th>`;
      const body = shown.map((row, r) => {
        const vals = n.cpt.slice(row.offset, row.offset + n.labels.length);
        const pcells = parents.map((p, k) => spans[k][r]
          ? `<td class="pcell" rowspan="${spans[k][r]}" data-r="${r}" data-span="${spans[k][r]}" title="Select ${spans[k][r] > 1 ? "these rows" : "this row"}">${esc(p.labels[row.idx[k]])}</td>`
          : "").join("");
        const cells = vals.map((v, s) => `<td class="cell" data-r="${r}" data-c="${s}" title="${esc(M.fmtNum(v))}">${fmt(v)}</td>`).join("");
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
      const change = [d.i, d.i + 1].map((s) => `<span><i class="sw" style="background:${color(s)[0]}"></i>${esc(n.labels[s])} ${pct(d.vals[s])} → <b>${pct(now[s])}</b></span>`).join("");
      tip.innerHTML = `<div class="tip-cond">${cond}</div><div class="tip-change">${change}</div>`;
      tip.hidden = false;
      const x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14);
      const y = e.clientY - tip.offsetHeight - 14;
      tip.style.left = x + "px";
      tip.style.top = (y < 8 ? e.clientY + 18 : y) + "px";
    }

    // Briefly highlights the cells the last typed value rescaled.
    function showAdjustment() {
      const adj = lastAdjust;
      lastAdjust = null;
      const r = adj ? rows.findIndex((row) => row.offset === adj.offset) : -1;
      const tr = r >= 0 && grid.querySelector(`tr[data-r="${r}"]`);
      if (!tr) return;
      for (const s of adj.states) tr.querySelector(`td.cell[data-c="${s}"]`).classList.add("adjusted");
    }

    // Refreshes one row in place (used while dragging, where a full re-render would lose the pointer).
    function updateRow(r) {
      const tr = grid.querySelector(`tr[data-r="${r}"]`);
      if (!tr) return;
      const vals = rowVals(r);
      tr.querySelector(".bar").innerHTML = barHTML(vals);
      vals.forEach((v, s) => {
        const td = tr.querySelector(`td.cell[data-c="${s}"]`);
        td.textContent = fmt(v);
        td.title = M.fmtNum(v);
      });
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
      grid.querySelectorAll("td.sel, td.active").forEach((td) => td.classList.remove("sel", "active"));
      const scope = head.querySelector(".scope");
      if (scope) {
        const { label } = scopeRows();
        scope.textContent = label ? `Applies to ${label}:` : "";
      }
      if (!sel) return;
      const { r0, r1, c0, c1 } = range();
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

    function mutateRows(offsets, fn) {
      opts.change(() => {
        const n = node(), c = n.labels.length;
        for (const o of offsets) fn(n.cpt, o, c);
      });
    }

    // Sets one cell. With auto-balance, the row's other states absorb the difference, except
    // those already typed in this row, so typing all but one state of a row fills in the last.
    function setValue(r, c, v) {
      const o = rows[r].offset;
      if (pins.offset !== o) pins = { offset: o, set: new Set() };
      opts.change(() => {
        const cpt = node().cpt, k = card();
        cpt[o + c] = v;
        if (!prefs.balance || k < 2) return;
        const others = [...Array(k).keys()].filter((s) => s !== c);
        let free = others.filter((s) => !pins.set.has(s));
        if (!free.length) free = others;
        const kept = v + sum(others.filter((s) => !free.includes(s)).map((s) => cpt[o + s]));
        const rem = 1 - kept, cur = sum(free.map((s) => cpt[o + s]));
        const before = free.map((s) => cpt[o + s]);
        for (const s of free) cpt[o + s] = round(rem <= 0 ? 0 : cur > 0 ? (cpt[o + s] * rem) / cur : rem / free.length);
        const changed = free.filter((s, i) => Math.abs(cpt[o + s] - before[i]) > 1e-12);
        lastAdjust = changed.length ? { offset: o, states: changed } : null;
      });
      pins.set.add(c);
    }

    function setBlock(r0, c0, matrix) {
      opts.change(() => {
        const cpt = node().cpt;
        matrix.forEach((line, i) => line.forEach((v, j) => {
          if (r0 + i < rows.length && c0 + j < card()) cpt[rows[r0 + i].offset + c0 + j] = v;
        }));
      });
    }

    function startEdit(r, c, initial) {
      const td = grid.querySelector(`td.cell[data-r="${r}"][data-c="${c}"]`);
      if (!td) return;
      sel = { ar: r, ac: c, fr: r, fc: c };
      paintSelection();
      const v = node().cpt[rows[r].offset + c];
      const input = document.createElement("input");
      input.className = "cell-edit";
      input.inputMode = "decimal";
      input.value = initial ?? (prefs.percent ? M.fmtNum(v * 100) : M.fmtNum(v));
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
      const v = parseProb(input.value, prefs.percent);
      if (!(v >= 0)) {
        opts.toast("Enter a probability such as 0.3, 30% or 1/3");
        render(nodeId);
        grid.focus({ preventScroll: true });
        return false;
      }
      const old = node().cpt[rows[r].offset + c];
      if (Math.abs(old - v) < 1e-15) render(nodeId);
      else setValue(r, c, v);
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
      const maxR = Math.min(rows.length, MAX_ROWS) - 1, maxC = card() - 1;
      if (!sel) sel = { ar: 0, ac: 0, fr: 0, fc: 0 };
      const r = Math.max(0, Math.min(maxR, (extend ? sel.fr : sel.ar) + dr));
      const c = Math.max(0, Math.min(maxC, (extend ? sel.fc : sel.ac) + dc));
      if (extend) { sel.fr = r; sel.fc = c; } else sel = { ar: r, ac: c, fr: r, fc: c };
      paintSelection();
      scrollToFocus();
    }

    function moveTab(back) {
      if (!sel) return move(0, 0);
      const maxC = card() - 1, maxR = Math.min(rows.length, MAX_ROWS) - 1;
      let r = sel.ar, c = sel.ac + (back ? -1 : 1);
      if (c > maxC) { c = 0; r = Math.min(maxR, r + 1); }
      if (c < 0) { c = maxC; r = Math.max(0, r - 1); }
      sel = { ar: r, ac: c, fr: r, fc: c };
      paintSelection();
      scrollToFocus();
    }

    function selectAll() {
      if (!rows.length) return;
      sel = { ar: 0, ac: 0, fr: Math.min(rows.length, MAX_ROWS) - 1, fc: card() - 1 };
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
      const cpt = node().cpt;
      const vals = [];
      for (let c = c0; c <= c1; c++) vals.push(cpt[rows[src].offset + c]);
      const matrix = [];
      for (let r = r0; r <= r1; r++) matrix.push(vals);
      setBlock(r0, c0, matrix);
    }

    function clearSelection() {
      if (!sel) return;
      const { r0, r1, c0, c1 } = range();
      setBlock(r0, c0, Array.from({ length: r1 - r0 + 1 }, () => new Array(c1 - c0 + 1).fill(0)));
    }

    // ------------------------------------------------------------ clipboard

    document.addEventListener("copy", (e) => {
      if (document.activeElement !== grid || !sel) return;
      const { r0, r1, c0, c1 } = range();
      const cpt = node().cpt;
      const lines = [];
      for (let r = r0; r <= r1; r++) {
        const line = [];
        for (let c = c0; c <= c1; c++) line.push(M.fmtNum(cpt[rows[r].offset + c]));
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
      const matrix = text.split("\n").map((line) => line.split(line.includes("\t") ? "\t" : /[;,\s]+/).filter((x) => x.trim() !== "").map((x) => parseProb(x, prefs.percent)));
      if (!matrix.length || matrix.some((l) => !l.length || l.some((v) => !(v >= 0)))) {
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
      sel = { ar: r0, ac: c0, fr: Math.min(maxR, r0 + block.length - 1), fc: Math.min(card() - 1, c0 + Math.max(...block.map((l) => l.length)) - 1) };
      paintSelection();
    });

    // ------------------------------------------------------------ pointer

    grid.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !node()) return;
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
        sel = { ar: r, ac: 0, fr: r + +pcell.dataset.span - 1, fc: card() - 1 };
      } else if (colHead) {
        const c = +colHead.dataset.col;
        sel = { ar: 0, ac: c, fr: maxR, fc: c };
      } else if (e.target.closest("[data-selall]")) {
        selectAll();
      } else if (bar) {
        const r = +bar.dataset.row, c = seg ? +seg.dataset.seg : 0;
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
      if (!d.started) { opts.checkpoint(); d.started = true; }
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
      if (arrows[k]) {
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
      const offsets = scopeRows().list.map((r) => r.offset);
      switch (b.dataset.cpt) {
        case "normalize": mutateRows(offsets, normalizeRow); break;
        case "uniform": mutateRows(offsets, uniformRow); break;
        case "random": mutateRows(offsets, randomRow); break;
        case "fix-all": mutateRows(M.badRows(node()), normalizeRow); break;
        case "mode-prob": prefs.percent = false; savePrefs(); render(nodeId); break;
        case "mode-pct": prefs.percent = true; savePrefs(); render(nodeId); break;
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

    return { render: (id) => render(id), focus, isEditing: () => !!edit || !!barDrag };
  }

  globalThis.BNCptEditor = { createCptEditor, parseProb };
})();
