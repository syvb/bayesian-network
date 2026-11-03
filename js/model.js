// Network data model. Mirrors pyAgrum: discrete variables with labels, arcs, and one CPT per node.
// A CPT is a flat array in aGrUM order: the node's own state varies fastest, then its parents
// in arc-insertion order (the same order as bn.cpt(name).fillWith(...)).
(function () {
  "use strict";

  const TYPES = ["labelized", "range", "integer", "discretized"];

  function fmtNum(x) {
    return String(+(+x).toPrecision(12));
  }

  // Labels pyAgrum derives for each variable type.
  function labelsFor(v) {
    switch (v.type) {
      case "range": {
        const out = [];
        for (let i = v.min; i <= v.max; i++) out.push(String(i));
        return out;
      }
      case "integer":
        return v.values.map(fmtNum);
      case "discretized": {
        const t = v.ticks, out = [];
        for (let i = 0; i + 1 < t.length; i++) {
          out.push("[" + fmtNum(t[i]) + ";" + fmtNum(t[i + 1]) + (i + 2 === t.length ? "]" : "["));
        }
        return out;
      }
      default:
        return v.labels.slice();
    }
  }

  function createNetwork(name) {
    return { name: name || "BN", nextId: 1, nodes: [], arcs: [] };
  }

  function getNode(net, id) {
    return net.nodes.find((n) => n.id === id);
  }

  function nodeByName(net, name) {
    return net.nodes.find((n) => n.name === name);
  }

  function parentsOf(net, id) {
    return net.arcs.filter((a) => a.to === id).map((a) => a.from);
  }

  function childrenOf(net, id) {
    return net.arcs.filter((a) => a.from === id).map((a) => a.to);
  }

  function card(net, id) {
    return getNode(net, id).labels.length;
  }

  function uniqueName(net, base) {
    if (!nodeByName(net, base)) return base;
    for (let i = 2; ; i++) if (!nodeByName(net, base + i)) return base + i;
  }

  // spec: {name, description, type, labels | min,max | values | ticks, x, y}
  function addNode(net, spec) {
    const node = {
      id: net.nextId++,
      name: spec.name,
      description: spec.description || "",
      type: spec.type || "labelized",
      labels: [],
      x: spec.x || 0,
      y: spec.y || 0,
      cpt: [],
    };
    setDomain(node, spec);
    node.cpt = uniformCpt(node.labels.length, 1);
    net.nodes.push(node);
    return node;
  }

  // Copies type-specific domain fields from spec onto node and recomputes labels.
  function setDomain(node, spec) {
    node.type = spec.type || node.type;
    delete node.min; delete node.max; delete node.values; delete node.ticks;
    if (node.type === "range") { node.min = spec.min; node.max = spec.max; }
    else if (node.type === "integer") node.values = spec.values.slice();
    else if (node.type === "discretized") node.ticks = spec.ticks.slice();
    node.labels = node.type === "labelized" ? spec.labels.slice() : labelsFor(node);
  }

  function uniformCpt(c, rows) {
    const out = new Array(c * rows);
    for (let i = 0; i < out.length; i++) out[i] = 1 / c;
    return out;
  }

  function wouldCycle(net, from, to) {
    if (from === to) return true;
    const stack = [to], seen = new Set();
    while (stack.length) {
      const n = stack.pop();
      if (n === from) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const c of childrenOf(net, n)) stack.push(c);
    }
    return false;
  }

  function hasArc(net, from, to) {
    return net.arcs.some((a) => a.from === from && a.to === to);
  }

  // Maps each new state index to an old state index (-1 when the state is new).
  // Matches by label first; a label that disappeared is treated as renamed in place.
  function stateMap(oldLabels, newLabels) {
    const kept = new Set(newLabels);
    return newLabels.map((l, i) => {
      const j = oldLabels.indexOf(l);
      if (j >= 0) return j;
      if (i < oldLabels.length && !kept.has(oldLabels[i])) return i;
      return -1;
    });
  }

  function snapshotShape(net) {
    const shape = new Map();
    for (const n of net.nodes) shape.set(n.id, { labels: n.labels.slice(), parents: [], cpt: n.cpt });
    for (const a of net.arcs) shape.get(a.to)?.parents.push(a.from);
    return shape;
  }

  // Runs fn (which may change arcs, labels, or remove nodes) and then remaps every affected CPT so
  // that existing probabilities are kept wherever the state/parent still exists.
  function restructure(net, fn) {
    const before = snapshotShape(net);
    const result = fn();
    const after = snapshotShape(net);
    const relabeled = new Set();
    for (const [id, n] of after) {
      const o = before.get(id);
      if (!o || o.labels.length !== n.labels.length || o.labels.some((l, i) => l !== n.labels[i])) relabeled.add(id);
    }
    for (const node of net.nodes) {
      const o = before.get(node.id);
      if (!o) continue;
      const n = after.get(node.id);
      const changed =
        relabeled.has(node.id) ||
        n.parents.length !== o.parents.length ||
        n.parents.some((v, i) => v !== o.parents[i] || relabeled.has(v));
      if (changed) node.cpt = remapCpt(before, after, node.id, o.parents, n.parents);
    }
    return result;
  }

  function remapCpt(before, after, id, oldParents, newParents) {
    const oldVars = [id].concat(oldParents);
    const newVars = [id].concat(newParents);
    const oldCards = oldVars.map((v) => before.get(v).labels.length);
    const newCards = newVars.map((v) => after.get(v).labels.length);
    const maps = newVars.map((v) => (before.has(v) ? stateMap(before.get(v).labels, after.get(v).labels) : null));
    const oldStrides = strides(oldCards);
    const oldCpt = before.get(id).cpt;
    const c = newCards[0];
    const rows = newCards.slice(1).reduce((a, b) => a * b, 1);
    const out = new Array(c * rows).fill(0);
    const idx = new Array(newVars.length).fill(0);
    for (let r = 0; r < rows; r++) {
      // parent indices for this row (first parent fastest)
      let rem = r;
      for (let k = 1; k < newVars.length; k++) { idx[k] = rem % newCards[k]; rem = Math.floor(rem / newCards[k]); }
      let base = 0, rowKnown = true;
      for (let k = 1; k < oldVars.length; k++) {
        const nk = newVars.indexOf(oldVars[k]);
        let oi = 0;
        if (nk >= 0) {
          oi = maps[nk] ? maps[nk][idx[nk]] : -1;
          if (oi < 0) { rowKnown = false; oi = 0; }
        }
        base += oi * oldStrides[k];
      }
      let sum = 0;
      if (rowKnown) {
        for (let s = 0; s < c; s++) {
          const os = maps[0][s];
          const v = os >= 0 ? oldCpt[base + os] : 0;
          out[r * c + s] = v;
          sum += v;
        }
      }
      if (!rowKnown || !(sum > 0)) for (let s = 0; s < c; s++) out[r * c + s] = 1 / c;
    }
    // Rows that lost a state are renormalised so they remain distributions.
    if (maps[0].filter((m) => m >= 0).length < oldCards[0]) {
      for (let r = 0; r < rows; r++) {
        let sum = 0;
        for (let s = 0; s < c; s++) sum += out[r * c + s];
        if (sum > 0) for (let s = 0; s < c; s++) out[r * c + s] /= sum;
      }
    }
    return out;
  }

  function strides(cards) {
    const s = [];
    let acc = 1;
    for (const c of cards) { s.push(acc); acc *= c; }
    return s;
  }

  function addArc(net, from, to) {
    if (hasArc(net, from, to)) return "That arc already exists";
    if (wouldCycle(net, from, to)) return "That arc would create a cycle";
    restructure(net, () => net.arcs.push({ from, to }));
    return null;
  }

  // Puts id's parents in `order` (a permutation of its parent ids). Parent order is the order of
  // the node's incoming arcs; the CPT is remapped so every probability stays with its row.
  function setParentOrder(net, id, order) {
    restructure(net, () => {
      const sorted = order.map((p) => net.arcs.find((a) => a.to === id && a.from === p));
      let k = 0;
      net.arcs = net.arcs.map((a) => (a.to === id ? sorted[k++] : a));
    });
  }

  function removeArc(net, from, to) {
    restructure(net, () => { net.arcs = net.arcs.filter((a) => !(a.from === from && a.to === to)); });
  }

  // Checked before anything changes: removing the arc first would remap the child's CPT, and
  // putting the arc back can't restore the rows that remapping dropped.
  function reversalError(net, from, to) {
    if (!hasArc(net, from, to)) return "There is no such arc";
    const without = { ...net, arcs: net.arcs.filter((a) => !(a.from === from && a.to === to)) };
    return wouldCycle(without, to, from) ? "That arc would create a cycle" : null;
  }

  // pyAgrum's bn.reverseArc: flips the arc and keeps the joint distribution, by giving each of the
  // two nodes the other's parents and recomputing both CPTs with Bayes' rule (Shachter 1986).
  // Parent order: existing parents first, new ones after (pyAgrum's order depends on its internals).
  function reverseArc(net, from, to) {
    const err = reversalError(net, from, to);
    if (err) return err;
    const nf = getNode(net, from), nt = getNode(net, to);
    const cardOf = (id) => getNode(net, id).labels.length;
    const old = { [from]: { pa: parentsOf(net, from), cpt: nf.cpt }, [to]: { pa: parentsOf(net, to), cpt: nt.cpt } };
    const val = (id, a) => {
      const { pa, cpt } = old[id];
      let off = 0, s = 1;
      for (const p of pa) { off += a.get(p) * s; s *= cardOf(p); }
      return cpt[off * cardOf(id) + a.get(id)];
    };
    net.arcs = net.arcs.filter((a) => !(a.from === from && a.to === to));
    for (const p of old[to].pa) if (p !== from && !hasArc(net, p, from)) net.arcs.push({ from: p, to: from });
    net.arcs.push({ from: to, to: from });
    for (const p of old[from].pa) if (!hasArc(net, p, to)) net.arcs.push({ from: p, to });
    // Calls f(assignment) for every cell of id's CPT, in CPT order (state fastest, then parents).
    const cells = (id, f) => {
      const vars = [id].concat(parentsOf(net, id)), cards = vars.map(cardOf), a = new Map();
      const total = cards.reduce((x, y) => x * y, 1), out = new Array(total);
      for (let i = 0; i < total; i++) {
        let rem = i;
        vars.forEach((v, k) => { a.set(v, rem % cards[k]); rem = Math.floor(rem / cards[k]); });
        out[i] = f(a);
      }
      return out;
    };
    const joint = (a) => val(from, a) * val(to, a);
    const marginal = (a) => { const keep = a.get(from); let t = 0; for (let f = 0; f < nf.labels.length; f++) { a.set(from, f); t += joint(a); } a.set(from, keep); return t; };
    nt.cpt = cells(to, (a) => { a.set(from, 0); return marginal(a); });
    nf.cpt = cells(from, (a) => { const m = marginal(a); return m > 0 ? joint(a) / m : 1 / nf.labels.length; });
    return null;
  }

  function removeNode(net, id) {
    restructure(net, () => {
      net.nodes = net.nodes.filter((n) => n.id !== id);
      net.arcs = net.arcs.filter((a) => a.from !== id && a.to !== id);
    });
  }

  function updateDomain(net, id, spec) {
    restructure(net, () => setDomain(getNode(net, id), spec));
  }

  // Parent configurations in display order (first parent slowest), each with its CPT offset.
  function cptRows(net, id) {
    const node = getNode(net, id);
    const parents = parentsOf(net, id).map((p) => getNode(net, p));
    const c = node.labels.length;
    const cards = parents.map((p) => p.labels.length);
    const rows = [];
    const total = cards.reduce((a, b) => a * b, 1);
    const st = strides(cards);
    for (let r = 0; r < total; r++) {
      let rem = r;
      const idx = new Array(cards.length);
      for (let k = cards.length - 1; k >= 0; k--) { idx[k] = rem % cards[k]; rem = Math.floor(rem / cards[k]); }
      let off = 0;
      for (let k = 0; k < cards.length; k++) off += idx[k] * st[k];
      rows.push({ idx, offset: off * c });
    }
    return { node, parents, rows };
  }

  function normalizeRow(cpt, offset, c) {
    let sum = 0;
    for (let s = 0; s < c; s++) sum += Math.max(0, +cpt[offset + s] || 0);
    for (let s = 0; s < c; s++) cpt[offset + s] = sum > 0 ? Math.max(0, +cpt[offset + s] || 0) / sum : 1 / c;
  }

  function normalizeCpt(node) {
    const c = node.labels.length;
    for (let o = 0; o < node.cpt.length; o += c) normalizeRow(node.cpt, o, c);
  }

  function randomizeCpt(node) {
    for (let i = 0; i < node.cpt.length; i++) node.cpt[i] = Math.random() + 1e-3;
    normalizeCpt(node);
  }

  function uniformizeCpt(node) {
    node.cpt = uniformCpt(node.labels.length, node.cpt.length / node.labels.length);
  }

  // Rows (by offset) whose entries do not sum to one.
  function badRows(node) {
    const c = node.labels.length, out = [];
    for (let o = 0; o < node.cpt.length; o += c) {
      let sum = 0;
      for (let s = 0; s < c; s++) sum += node.cpt[o + s];
      if (Math.abs(sum - 1) > 1e-6 || node.cpt.slice(o, o + c).some((v) => !(v >= 0))) out.push(o);
    }
    return out;
  }

  // Simple layered layout (longest path from roots, barycentric ordering).
  function autoLayout(net) {
    const layer = new Map();
    const visit = (id) => {
      if (layer.has(id)) return layer.get(id);
      let l = 0;
      for (const p of parentsOf(net, id)) l = Math.max(l, visit(p) + 1);
      layer.set(id, l);
      return l;
    };
    net.nodes.forEach((n) => visit(n.id));
    const layers = [];
    for (const n of net.nodes) (layers[layer.get(n.id)] ||= []).push(n);
    const pos = new Map();
    layers.forEach((ls, li) => {
      if (li > 0) {
        const bary = (n) => {
          const ps = parentsOf(net, n.id);
          return ps.length ? ps.reduce((a, p) => a + pos.get(p), 0) / ps.length : 0;
        };
        ls.sort((a, b) => bary(a) - bary(b));
      }
      ls.forEach((n, i) => pos.set(n.id, i - (ls.length - 1) / 2));
    });
    for (const n of net.nodes) {
      n.x = 400 + pos.get(n.id) * 170;
      n.y = 80 + layer.get(n.id) * 120;
    }
  }

  const api = {
    TYPES, fmtNum, labelsFor, createNetwork, getNode, nodeByName, parentsOf, childrenOf, card, uniqueName, setParentOrder,
    addNode, setDomain, uniformCpt, wouldCycle, hasArc, stateMap, restructure, addArc, removeArc, reverseArc,
    removeNode, updateDomain, cptRows, normalizeRow, normalizeCpt, randomizeCpt, uniformizeCpt, badRows,
    autoLayout, strides,
  };
  globalThis.BNModel = api;
})();
