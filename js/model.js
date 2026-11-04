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
  // A node's size in the probabilities view, estimated from its text (the editor passes exact
  // sizes; this is for layouts made outside the page, such as on import).
  function estimateSize(n) {
    const nameW = n.name.length * 8.4, lines = Math.min(3, Math.max(1, Math.ceil(nameW / 200)));
    const labelW = Math.min(110, Math.max(...n.labels.map((l) => l.length * 6.6)));
    return { w: Math.max(84, Math.min(200, nameW) + 30, 10 + labelW + 8 + 64 + 44 + 6), h: 30 + (lines - 1) * 17 + n.labels.length * 18 + 8 };
  }

  // Layered layout (Sugiyama): parents above children, each arc pointing down.
  //  1. Layers: longest path from the roots, then nodes with more children than parents (roots
  //     in particular) are pulled down to just above their highest child, so they sit next to
  //     what they cause instead of all at the top.
  //  2. Arcs spanning several layers get a placeholder in each layer they cross, so other nodes
  //     leave a gap for them and they're ordered like nodes.
  //  3. Order within layers: barycenter sweeps down and up, keeping the order with the fewest
  //     crossings. The starting order follows the current x positions, so re-running the
  //     layout keeps the network's left-to-right arrangement where it can.
  //  4. x positions: each node is pulled towards the average of its neighbours, with the
  //     spacing its width needs (solved exactly per layer); placeholders line up so long arcs
  //     run straight. Layers are as tall as their tallest node.
  // Separate pieces of the network are laid out on their own and packed side by side; lone
  // nodes go in a grid. sizeOf(node) gives {w, h}.
  function autoLayout(net, sizeOf = estimateSize) {
    if (!net.nodes.length) return;
    const size = new Map(net.nodes.map((n) => [n.id, sizeOf(n)]));
    const near = new Map(net.nodes.map((n) => [n.id, []]));
    for (const a of net.arcs) { near.get(a.from).push(a.to); near.get(a.to).push(a.from); }
    const seen = new Set(), pieces = [], lone = [];
    for (const n of net.nodes) {
      if (seen.has(n.id)) continue;
      const piece = [], stack = [n.id];
      seen.add(n.id);
      while (stack.length) {
        const id = stack.pop();
        piece.push(id);
        for (const m of near.get(id)) if (!seen.has(m)) { seen.add(m); stack.push(m); }
      }
      (piece.length > 1 ? pieces : lone).push(piece);
    }
    const blocks = pieces.sort((a, b) => b.length - a.length).map((p) => layoutPiece(net, new Set(p), size));
    if (lone.length) blocks.push(gridBlock(net, lone.flat(), size));

    // Pack the blocks in rows, left to right, no wider than the widest block (or 1400px).
    const GAP = 80, maxW = Math.max(1400, ...blocks.map((b) => b.w));
    let x = 0, y = 0, rowH = 0;
    for (const b of blocks) {
      if (x > 0 && x + b.w > maxW) { x = 0; y += rowH + GAP; rowH = 0; }
      for (const [id, p] of b.pos) {
        const n = getNode(net, id);
        n.x = Math.round(100 + x + p.x);
        n.y = Math.round(60 + y + p.y);
      }
      x += b.w + GAP;
      rowH = Math.max(rowH, b.h);
    }
  }

  function gridBlock(net, ids, size) {
    const cols = Math.ceil(Math.sqrt(ids.length)), pos = new Map();
    const colW = [], rowH = [];
    ids.forEach((id, i) => {
      const { w, h } = size.get(id), c = i % cols, r = Math.floor(i / cols);
      colW[c] = Math.max(colW[c] || 0, w);
      rowH[r] = Math.max(rowH[r] || 0, h);
    });
    const GAP_X = 40, GAP_Y = 40;
    ids.forEach((id, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const x = colW.slice(0, c).reduce((a, b) => a + b + GAP_X, 0) + colW[c] / 2;
      const y = rowH.slice(0, r).reduce((a, b) => a + b + GAP_Y, 0) + rowH[r] / 2;
      pos.set(id, { x, y });
    });
    return { pos, w: colW.reduce((a, b) => a + b + GAP_X, -GAP_X), h: rowH.reduce((a, b) => a + b + GAP_Y, -GAP_Y) };
  }

  function layoutPiece(net, ids, size) {
    const H_GAP = 40, DUMMY_GAP = 14, DUMMY_W = 14, V_GAP = 70, SWEEPS = 24;
    const xNow = new Map(net.nodes.filter((n) => ids.has(n.id)).map((n) => [n.id, n.x || 0]));
    const parents = new Map(), children = new Map();
    for (const id of ids) { parents.set(id, []); children.set(id, []); }
    for (const a of net.arcs) if (ids.has(a.from)) { children.get(a.from).push(a.to); parents.get(a.to).push(a.from); }

    // 1. layers
    const topo = [], indeg = new Map([...ids].map((id) => [id, parents.get(id).length]));
    const queue = [...ids].filter((id) => !indeg.get(id));
    while (queue.length) {
      const id = queue.shift();
      topo.push(id);
      for (const c of children.get(id)) { indeg.set(c, indeg.get(c) - 1); if (!indeg.get(c)) queue.push(c); }
    }
    const layer = new Map();
    for (const id of topo) layer.set(id, Math.max(-1, ...parents.get(id).map((p) => layer.get(p))) + 1);
    // Moving a node down shortens its arcs to children and lengthens those from parents, so a
    // node moves only when it has more children than parents (roots always do).
    for (let i = topo.length - 1; i >= 0; i--) {
      const ch = children.get(topo[i]);
      if (ch.length > parents.get(topo[i]).length) layer.set(topo[i], Math.min(...ch.map((c) => layer.get(c))) - 1);
    }

    // 2. the layered graph, with placeholders ("d…") along long arcs
    const up = new Map(), down = new Map(), lay = new Map(layer);
    const vertex = (v, l) => { up.set(v, []); down.set(v, []); lay.set(v, l); };
    for (const id of ids) vertex(id, layer.get(id));
    let dn = 0;
    for (const a of net.arcs) {
      if (!ids.has(a.from)) continue;
      let prev = a.from;
      for (let l = layer.get(a.from) + 1; l < layer.get(a.to); l++) {
        const d = "d" + dn++;
        vertex(d, l);
        down.get(prev).push(d); up.get(d).push(prev);
        prev = d;
      }
      down.get(prev).push(a.to); up.get(a.to).push(prev);
    }
    const isDummy = (v) => typeof v === "string";
    const nLayers = Math.max(...layer.values()) + 1;
    const layers = Array.from({ length: nLayers }, () => []);

    // starting order: depth-first from the roots, everything taken in current x order
    const byX = (a, b) => xOf(a) - xOf(b);
    const xOf = (v) => (isDummy(v) ? xOf(up.get(v)[0]) : xNow.get(v));
    const placed = new Set();
    const visit = (v) => {
      if (placed.has(v)) return;
      placed.add(v);
      layers[lay.get(v)].push(v);
      for (const c of [...down.get(v)].sort(byX)) visit(c);
    };
    [...ids].filter((id) => !parents.get(id).length).sort(byX).forEach(visit);

    // 3. crossing reduction
    const rank = new Map();
    const setRanks = () => layers.forEach((l) => l.forEach((v, i) => rank.set(v, i)));
    setRanks();
    const crossingsBetween = (upper) => {
      // count inversions among the arcs between layers upper and upper + 1 (Fenwick tree)
      const edges = [];
      for (const v of layers[upper]) for (const c of down.get(v)) edges.push([rank.get(v), rank.get(c)]);
      edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const n = layers[upper + 1].length, tree = new Array(n + 1).fill(0);
      let count = 0, total = 0;
      for (const [, b] of edges) {
        let greater = total;
        for (let i = b + 1; i > 0; i -= i & -i) greater -= tree[i];
        count += greater;
        for (let i = b + 1; i <= n; i += i & -i) tree[i]++;
        total++;
      }
      return count;
    };
    const crossings = () => { let c = 0; for (let l = 0; l + 1 < nLayers; l++) c += crossingsBetween(l); return c; };
    const reorder = (l, nbrs) => {
      const vs = layers[l];
      const bary = new Map();
      for (const v of vs) {
        const ns = nbrs.get(v);
        if (ns.length) bary.set(v, ns.reduce((s, u) => s + rank.get(u), 0) / ns.length);
      }
      // vertices with no neighbours on that side keep their slot
      const movable = vs.filter((v) => bary.has(v)).sort((a, b) => bary.get(a) - bary.get(b) || rank.get(a) - rank.get(b));
      let k = 0;
      layers[l] = vs.map((v) => (bary.has(v) ? movable[k++] : v));
      layers[l].forEach((v, i) => rank.set(v, i));
    };
    // Crossings between the arcs of u and v (u left of v) towards one side.
    const pairCross = (u, v, nbrs) => {
      let c = 0;
      for (const a of nbrs.get(u)) for (const b of nbrs.get(v)) if (rank.get(a) > rank.get(b)) c++;
      return c;
    };
    // Swaps neighbours in a layer while that reduces crossings (the "transpose" step).
    const transpose = () => {
      for (let pass = 0, improved = true; improved && pass < 8; pass++) {
        improved = false;
        for (const vs of layers) {
          for (let i = 0; i + 1 < vs.length; i++) {
            const u = vs[i], v = vs[i + 1];
            const now = pairCross(u, v, up) + pairCross(u, v, down), swapped = pairCross(v, u, up) + pairCross(v, u, down);
            if (swapped < now) {
              vs[i] = v; vs[i + 1] = u;
              rank.set(v, i); rank.set(u, i + 1);
              improved = true;
            }
          }
        }
      }
    };
    let best = layers.map((l) => l.slice()), bestCount = crossings();
    for (let it = 0; it < SWEEPS && bestCount > 0; it++) {
      if (it % 2 === 0) for (let l = 1; l < nLayers; l++) reorder(l, up);
      else for (let l = nLayers - 2; l >= 0; l--) reorder(l, down);
      transpose();
      const c = crossings();
      if (c < bestCount) { bestCount = c; best = layers.map((l) => l.slice()); }
    }
    best.forEach((l, i) => { layers[i] = l; });
    setRanks();

    // 4. x positions
    const width = (v) => (isDummy(v) ? DUMMY_W : size.get(v).w);
    const sep = (a, b) => (width(a) + width(b)) / 2 + (isDummy(a) || isDummy(b) ? DUMMY_GAP : H_GAP);
    const x = new Map();
    for (const vs of layers) {
      let at = 0;
      vs.forEach((v, i) => { if (i) at += sep(vs[i - 1], v); x.set(v, at); });
      vs.forEach((v) => x.set(v, x.get(v) - at / 2));
    }
    // Moves layer l's vertices as close as possible to `want` (least squares) while keeping
    // their order and spacing: pool-adjacent-violators on positions minus the minimum offsets.
    const place = (vs, want) => {
      const off = [0];
      for (let i = 1; i < vs.length; i++) off[i] = off[i - 1] + sep(vs[i - 1], vs[i]);
      const pools = [];
      vs.forEach((v, i) => {
        const w = isDummy(v) ? 2 : 1;
        pools.push({ s: w * (want(v) - off[i]), w, n: 1 });
        while (pools.length > 1 && pools[pools.length - 2].s / pools[pools.length - 2].w >= pools[pools.length - 1].s / pools[pools.length - 1].w) {
          const b = pools.pop(), a = pools[pools.length - 1];
          a.s += b.s; a.w += b.w; a.n += b.n;
        }
      });
      let i = 0;
      for (const p of pools) for (let k = 0; k < p.n; k++, i++) x.set(vs[i], p.s / p.w + off[i]);
    };
    const mean = (ns, v) => (ns.length ? ns.reduce((s, u) => s + x.get(u), 0) / ns.length : x.get(v));
    for (let it = 0; it < 12; it++) {
      if (it % 2 === 0) for (let l = 1; l < nLayers; l++) place(layers[l], (v) => mean(up.get(v), v));
      else for (let l = nLayers - 2; l >= 0; l--) place(layers[l], (v) => mean(down.get(v), v));
    }
    for (let it = 0; it < 4; it++) {
      for (let l = 0; l < nLayers; l++) place(layers[l], (v) => mean(up.get(v).concat(down.get(v)), v));
    }

    // y: each layer as tall as its tallest node, nodes centred in it
    const pos = new Map();
    let top = 0, x0 = Infinity, x1 = -Infinity;
    for (const vs of layers) {
      const h = Math.max(20, ...vs.filter((v) => !isDummy(v)).map((v) => size.get(v).h));
      for (const v of vs) {
        if (isDummy(v)) continue;
        pos.set(v, { x: x.get(v), y: top + h / 2 });
        x0 = Math.min(x0, x.get(v) - width(v) / 2);
        x1 = Math.max(x1, x.get(v) + width(v) / 2);
      }
      top += h + V_GAP;
    }
    for (const v of layers.flat()) if (isDummy(v)) { x0 = Math.min(x0, x.get(v)); x1 = Math.max(x1, x.get(v)); }
    for (const p of pos.values()) p.x -= x0;
    return { pos, w: x1 - x0, h: top - V_GAP };
  }

  const api = {
    TYPES, fmtNum, labelsFor, createNetwork, getNode, nodeByName, parentsOf, childrenOf, card, uniqueName, setParentOrder,
    addNode, setDomain, uniformCpt, wouldCycle, hasArc, stateMap, restructure, addArc, removeArc, reverseArc,
    removeNode, updateDomain, cptRows, normalizeRow, normalizeCpt, randomizeCpt, uniformizeCpt, badRows,
    autoLayout, strides,
  };
  globalThis.BNModel = api;
})();
