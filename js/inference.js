// Exact inference by variable elimination.
// Factors store values with their first variable varying fastest, like aGrUM potentials and
// node CPTs, so a node's CPT is already a factor over [node, ...parents].
(function () {
  "use strict";
  const M = globalThis.BNModel;
  const MAX_FACTOR = 4e6; // entries; beyond this the network is too dense for exact inference here

  class InferenceError extends Error {}

  const product = (xs) => xs.reduce((a, b) => a * b, 1);

  function makeFactor(vars, cards, vals) {
    const size = product(cards);
    if (size > MAX_FACTOR) throw new InferenceError("This network is too densely connected for exact inference in the browser.");
    return { vars, cards, vals: vals || new Float64Array(size) };
  }

  // Strides of `f` laid out against the variable order `vars` (0 where f lacks the variable).
  function stridesIn(f, vars) {
    const own = M.strides(f.cards);
    return vars.map((v) => { const i = f.vars.indexOf(v); return i < 0 ? 0 : own[i]; });
  }

  function multiply(a, b) {
    const vars = a.vars.slice(), cards = a.cards.slice();
    b.vars.forEach((v, i) => { if (!vars.includes(v)) { vars.push(v); cards.push(b.cards[i]); } });
    const out = makeFactor(vars, cards);
    const sa = stridesIn(a, vars), sb = stridesIn(b, vars);
    const idx = new Array(vars.length).fill(0);
    let ia = 0, ib = 0;
    for (let i = 0; i < out.vals.length; i++) {
      out.vals[i] = a.vals[ia] * b.vals[ib];
      for (let k = 0; k < vars.length; k++) {
        idx[k]++; ia += sa[k]; ib += sb[k];
        if (idx[k] < cards[k]) break;
        ia -= sa[k] * cards[k]; ib -= sb[k] * cards[k]; idx[k] = 0;
      }
    }
    return out;
  }

  function sumOut(f, v) {
    const keep = f.vars.map((x, i) => i).filter((i) => f.vars[i] !== v);
    const out = makeFactor(keep.map((i) => f.vars[i]), keep.map((i) => f.cards[i]));
    const so = f.vars.map((x) => { const j = out.vars.indexOf(x); return j < 0 ? 0 : M.strides(out.cards)[j]; });
    const idx = new Array(f.vars.length).fill(0);
    let io = 0;
    for (let i = 0; i < f.vals.length; i++) {
      out.vals[io] += f.vals[i];
      for (let k = 0; k < f.vars.length; k++) {
        idx[k]++; io += so[k];
        if (idx[k] < f.cards[k]) break;
        io -= so[k] * f.cards[k]; idx[k] = 0;
      }
    }
    return out;
  }

  // Keeps only the entries where variable v is in state s, dropping v.
  function reduce(f, v, s) {
    const at = f.vars.indexOf(v);
    if (at < 0) return f;
    const own = M.strides(f.cards);
    const keep = f.vars.map((x, i) => i).filter((i) => i !== at);
    const out = makeFactor(keep.map((i) => f.vars[i]), keep.map((i) => f.cards[i]));
    const si = keep.map((i) => own[i]);
    const idx = new Array(keep.length).fill(0);
    let ii = s * own[at];
    for (let i = 0; i < out.vals.length; i++) {
      out.vals[i] = f.vals[ii];
      for (let k = 0; k < keep.length; k++) {
        idx[k]++; ii += si[k];
        if (idx[k] < out.cards[k]) break;
        ii -= si[k] * out.cards[k]; idx[k] = 0;
      }
    }
    return out;
  }

  function ancestorsOf(net, ids) {
    const seen = new Set(), stack = [...ids];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...M.parentsOf(net, id));
    }
    return seen;
  }

  // Sums every variable except `keep` out of the product of the factors, cheapest first.
  function eliminate(factors, keep) {
    let fs = factors.slice();
    const vars = new Set();
    for (const f of fs) for (const v of f.vars) if (v !== keep) vars.add(v);
    while (vars.size) {
      let best = null, bestCost = Infinity;
      for (const v of vars) {
        const scope = new Map();
        for (const f of fs) if (f.vars.includes(v)) f.vars.forEach((x, i) => scope.set(x, f.cards[i]));
        const cost = product([...scope.values()]);
        if (cost < bestCost) { best = v; bestCost = cost; }
      }
      const touching = fs.filter((f) => f.vars.includes(best));
      fs = fs.filter((f) => !f.vars.includes(best));
      fs.push(sumOut(touching.reduce(multiply), best));
      vars.delete(best);
    }
    return fs.reduce(multiply, makeFactor([], [], new Float64Array([1])));
  }

  // evidence: Map(node id -> state index).
  // Returns {marginals: Map(id -> number[]), pEvidence} or {error}.
  function posteriors(net, evidence = new Map()) {
    try {
      const cptFactor = (id) => {
        const n = M.getNode(net, id);
        const vars = [id].concat(M.parentsOf(net, id));
        let f = makeFactor(vars, vars.map((v) => M.card(net, v)), Float64Array.from(n.cpt));
        for (const [ev, s] of evidence) f = reduce(f, ev, s);
        return f;
      };
      const factorsFor = (ids) => [...ancestorsOf(net, [...ids, ...evidence.keys()])].map(cptFactor);

      let pEvidence = 1;
      if (evidence.size) {
        pEvidence = eliminate(factorsFor([]), null).vals[0];
        if (!(pEvidence > 0)) return { error: "This evidence is impossible: it has probability 0 in the model." };
      }
      const marginals = new Map();
      for (const n of net.nodes) {
        if (evidence.has(n.id)) {
          marginals.set(n.id, n.labels.map((_, s) => (s === evidence.get(n.id) ? 1 : 0)));
          continue;
        }
        const f = eliminate(factorsFor([n.id]), n.id);
        const total = f.vals.reduce((a, b) => a + b, 0);
        marginals.set(n.id, Array.from(f.vals, (v) => (total > 0 ? v / total : 1 / f.vals.length)));
      }
      return { marginals, pEvidence };
    } catch (err) {
      if (err instanceof InferenceError) return { error: err.message };
      throw err;
    }
  }

  globalThis.BNInference = { posteriors };
})();
