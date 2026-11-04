// Exact inference by variable elimination, in exact rational arithmetic.
// Each probability the model holds (CPT entries, likelihoods) is read as the shortest decimal that
// round-trips its floating-point value, the digits that were typed or written in the script, so
// 0.1 means exactly 1/10. A factor stores BigInt numerators over one BigInt denominator shared by
// all its entries, so products and sums are exact: no rounding, underflow or overflow, and a
// probability is 0 only when it really is 0. Results are turned into floating-point numbers only at
// the end, as exactly rounded ratios.
// Factors store values with their first variable varying fastest, like aGrUM potentials and
// node CPTs, so a node's CPT is already a factor over [node, ...parents].
(function () {
  "use strict";
  const M = globalThis.BNModel;
  const MAX_FACTOR = 4e6; // entries; beyond this the network is too dense for exact inference here

  class InferenceError extends Error {}

  const product = (xs) => xs.reduce((a, b) => a * b, 1);

  // ------------------------------------------------------------ exact numbers

  const { pow10, decimal, ratio } = M;
  const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

  // Numbers x[i] as integers over one denominator 10^e.
  function decimals(xs) {
    const ds = Array.from(xs, decimal);
    const e = ds.reduce((m, [, k]) => Math.max(m, k), 0);
    return { ints: ds.map(([m, k]) => (k < e ? m * pow10(e - k) : m)), den: pow10(e) };
  }

  // a / b (a > 0, b > 0) in scientific notation to `digits` significant digits, such as "1.23e-400",
  // for numbers too small or big for floating point.
  function scientific(a, b, digits = 3) {
    let e = a.toString().length - b.toString().length;
    const scaled = (k) => (k >= 0 ? (a * pow10(k)) / b : a / (b * pow10(-k)));
    if (scaled(digits - 1 - e) < pow10(digits - 1)) e--;
    let q = (scaled(digits - e) + 5n) / 10n; // rounded to `digits` digits
    if (q === pow10(digits)) { q = pow10(digits - 1); e++; }
    const t = q.toString();
    return `${t[0]}${digits > 1 ? "." + t.slice(1, digits) : ""}e${e < 0 ? "" : "+"}${e}`;
  }

  // ------------------------------------------------------------ factors

  function makeFactor(vars, cards, vals, den = 1n) {
    const size = product(cards);
    if (size > MAX_FACTOR) throw new InferenceError("This network is too densely connected for exact inference in the browser.");
    return { vars, cards, vals: vals || new Array(size).fill(0n), den };
  }

  // A node's CPT as a factor. Each row is divided by its exact sum (rows are checked to add up to
  // 1 to within rounding before inference), so that rows like 1/3, 1/3, 1/3 typed as decimals are
  // exact distributions; a row that already adds up to 1 exactly is unchanged.
  function cptFactor(vars, cards, cpt) {
    const { ints } = decimals(cpt);
    const c = cards[0], sums = [];
    for (let o = 0; o < ints.length; o += c) { let t = 0n; for (let s = 0; s < c; s++) t += ints[o + s]; sums.push(t); }
    const den = sums.reduce((l, t) => (l % t === 0n ? l : (l / gcd(l, t)) * t), 1n);
    const vals = ints.map((v, i) => v * (den / sums[Math.floor(i / c)]));
    return makeFactor(vars, cards, vals, den);
  }

  // Strides of `f` laid out against the variable order `vars` (0 where f lacks the variable).
  function stridesIn(f, vars) {
    const own = M.strides(f.cards);
    return vars.map((v) => { const i = f.vars.indexOf(v); return i < 0 ? 0 : own[i]; });
  }

  function multiply(a, b) {
    const vars = a.vars.slice(), cards = a.cards.slice();
    b.vars.forEach((v, i) => { if (!vars.includes(v)) { vars.push(v); cards.push(b.cards[i]); } });
    const out = makeFactor(vars, cards, null, a.den * b.den);
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
    const out = makeFactor(keep.map((i) => f.vars[i]), keep.map((i) => f.cards[i]), null, f.den);
    const os = M.strides(out.cards);
    const so = f.vars.map((x) => { const j = out.vars.indexOf(x); return j < 0 ? 0 : os[j]; });
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
    const out = makeFactor(keep.map((i) => f.vars[i]), keep.map((i) => f.cards[i]), null, f.den);
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
    return fs.reduce(multiply, makeFactor([], [], [1n]));
  }

  // Exact marginals given hard and likelihood evidence. With `only`, marginals are computed just for
  // those node ids. Returns {marginals, pEvidence} or {error}. Expects valid input (see problem()).
  // Only the evidence nodes' ancestors matter for a node's marginal: the CPT rows of the others add
  // up to exactly 1, so summing them out changes nothing.
  function exact(net, evidence, only) {
    try {
      const hard = new Map(), soft = new Map();
      for (const [id, v] of evidence) (typeof v === "number" ? hard : soft).set(id, v);
      const factors = new Map();
      const factorOf = (id) => {
        if (factors.has(id)) return factors.get(id);
        const n = M.getNode(net, id);
        const vars = [id].concat(M.parentsOf(net, id));
        let f = cptFactor(vars, vars.map((v) => M.card(net, v)), n.cpt);
        for (const [ev, s] of hard) f = reduce(f, ev, s);
        factors.set(id, f);
        return f;
      };
      // Soft evidence multiplies its node's distribution by the likelihoods.
      const likelihoods = [...soft].map(([id, lik]) => { const { ints, den } = decimals(lik); return makeFactor([id], [lik.length], ints, den); });
      const factorsFor = (ids) => [...ancestorsOf(net, [...ids, ...evidence.keys()])].map(factorOf).concat(likelihoods);

      let pEvidence = 1, pEvidenceText;
      if (evidence.size) {
        const f = eliminate(factorsFor([]), null);
        if (f.vals[0] === 0n) return { error: "This evidence is impossible: it has probability 0 in the model.", evidenceError: true };
        pEvidence = ratio(f.vals[0], f.den);
        // exact, for when it's beyond floating point (likelihoods needn't be at most 1)
        if (!(pEvidence >= 1e-300 && pEvidence < 1e300)) pEvidenceText = scientific(f.vals[0], f.den);
      }
      const marginals = new Map();
      for (const n of net.nodes) {
        if (only && !only.has(n.id)) continue;
        if (hard.has(n.id)) {
          marginals.set(n.id, n.labels.map((_, s) => (s === hard.get(n.id) ? 1 : 0)));
          continue;
        }
        const f = eliminate(factorsFor([n.id]), n.id);
        const total = f.vals.reduce((a, b) => a + b, 0n);
        marginals.set(n.id, f.vals.map((v) => ratio(v, total)));
      }
      return { marginals, pEvidence, pEvidenceText };
    } catch (err) {
      if (err instanceof InferenceError) return { error: err.message };
      throw err;
    }
  }

  // What's wrong with the model or the evidence for inference, or null. Evidence problems come
  // back with evidenceError, so the editor can refuse that evidence rather than store it.
  function problem(net, evidence) {
    for (const n of net.nodes) {
      const rows = M.parentsOf(net, n.id).reduce((r, p) => r * M.card(net, p), 1);
      if (n.cpt.length !== rows * n.labels.length || n.cpt.some((v) => !(Number.isFinite(v) && v >= 0)) || M.badRows(n).length) {
        return { error: `Probabilities can't be computed until every CPT is valid: ${n.name} has rows that don't add up to 1.` };
      }
    }
    const bad = (n, why) => ({ error: `The evidence on ${n.name} is invalid: ${why}.`, evidenceError: true });
    for (const [id, v] of evidence) {
      const n = M.getNode(net, id);
      if (!n) return { error: "There is evidence on a variable that isn't in the network.", evidenceError: true };
      const c = n.labels.length;
      const isState = (s) => Number.isInteger(s) && s >= 0 && s < c;
      const isValues = (xs) => Array.isArray(xs) && xs.length === c && xs.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0);
      if (typeof v === "number") { if (!isState(v)) return bad(n, "no such state"); }
      else if (Array.isArray(v)) {
        if (!isValues(v)) return bad(n, `it needs ${c} finite likelihoods, none negative`);
        if (!v.some((x) => x > 0)) return { error: `This evidence is impossible: every likelihood for ${n.name} is 0.`, evidenceError: true };
      } else if (v && v.target) {
        if (!isValues(v.target) || Math.abs(v.target.reduce((a, b) => a + b, 0) - 1) > 1e-6) return bad(n, `its target probabilities must be ${c} numbers, none negative, adding up to 1`);
      } else if (v && v.do !== undefined) { if (!isState(v.do)) return bad(n, "no such state to intervene on"); }
      else return bad(n, "unknown kind of evidence");
    }
    return null;
  }

  // evidence: Map(node id -> one of
  //   a state index: hard evidence;
  //   an array with one likelihood per state: soft (likelihood) evidence, as in pyAgrum's
  //     ie.setEvidence({"x": [0.2, 0.8]});
  //   {target: [...]}: the node's probabilities after all the evidence should be exactly these
  //     (Jeffrey's rule)).
  // Target evidence is turned into the likelihoods that produce it, found by iterative
  // proportional fitting, one target at a time (one step for a single target), finished with damped
  // Newton steps when the targets are strongly coupled.
  //   {do: state index}: an intervention, do(node = state): the node is set from outside, so
  //     the arcs into it are cut and it's fixed to that state (Pearl's graph surgery). Unlike an
  //     observation, it tells nothing about the node's causes.
  // Returns {marginals: Map(id -> number[]), pEvidence, likelihoods: Map(id -> number[])} or
  // {error, evidenceError?}. pEvidence covers only the hard and likelihood evidence (given the
  // interventions). Everything is exact except target evidence: its likelihoods are found
  // numerically, to within a relative 1e-9 of each target probability (so a target of 1e-12 is met
  // as closely as one of 0.5), and the result is exact for those likelihoods.
  function posteriors(net, evidence = new Map()) {
    const wrong = problem(net, evidence);
    if (wrong) return wrong;
    const isDo = (v) => v && v.do !== undefined;
    if ([...evidence.values()].some(isDo)) {
      net = intervene(net, new Map([...evidence].filter(([, v]) => isDo(v)).map(([id, v]) => [id, v.do])));
      evidence = new Map([...evidence].filter(([, v]) => !isDo(v)));
    }
    const targets = [...evidence].filter(([, v]) => v && v.target);
    if (!targets.length) return exact(net, evidence);
    const plain = new Map([...evidence].filter(([, v]) => !(v && v.target)));
    const base = exact(net, plain, new Set());
    if (base.error) return base;
    const ev = new Map(plain);
    for (const [id, { target }] of targets) ev.set(id, target.map((q) => (q > 0 ? 1 : 0)));
    const targetIds = new Set(targets.map(([id]) => id));
    // First fit one target at a time against fresh marginals (iterative proportional fitting).
    // Adjusting all of them from the same marginals overshoots when targets depend on each other.
    const fitted = (r) => targets.every(([id, { target }]) => r.marginals.get(id).every((p, s) => Math.abs(p - target[s]) <= 1e-9 * target[s]));
    let converged = false;
    for (let it = 0; it < 30 && !converged; it++) {
      for (const [id, { target }] of targets) {
        const r = exact(net, ev, targetIds);
        if (r.error) return r.evidenceError ? impossibleTargets(net, targets) : r;
        const p = r.marginals.get(id), lik = ev.get(id).slice();
        for (let s = 0; s < lik.length; s++) {
          // p[s] is exactly 0 only when the state is ruled out (exact arithmetic doesn't underflow)
          if (target[s] > 0 && !(p[s] > 0)) return impossibleTargets(net, [[id, { target }]]);
          lik[s] = target[s] > 0 ? Math.min(Number.MAX_VALUE, (lik[s] * target[s]) / p[s]) : 0;
        }
        const max = Math.max(...lik);
        ev.set(id, lik.map((x) => x / max));
      }
      const r = exact(net, ev, targetIds);
      if (r.error) return r.evidenceError ? impossibleTargets(net, targets) : r;
      converged = fitted(r);
    }
    // Strongly coupled targets (a node that almost copies another) make that fitting crawl, so
    // finish with damped Newton steps on the log-likelihoods.
    if (!converged) {
      const res = newtonFit(net, ev, targets, targetIds);
      if (res.error) return res.evidenceError ? impossibleTargets(net, targets) : res;
      converged = res.converged;
    }
    // Not reaching the targets doesn't prove that they contradict each other, only that no
    // likelihoods were found for them.
    if (!converged) return { error: "No likelihoods were found that give all these target probabilities: they may contradict each other or the other evidence.", evidenceError: true };
    const r = exact(net, ev);
    if (r.error) return r;
    r.pEvidence = base.pEvidence;
    r.pEvidenceText = base.pEvidenceText;
    r.likelihoods = new Map(targets.map(([id]) => [id, ev.get(id)]));
    return r;
  }

  // Levenberg-Marquardt on x = log-likelihoods of the target states with nonzero target, except
  // one reference state per node (only likelihood ratios matter). The residual is marginal minus
  // target for the same states; d marginal(i,s) / d x(j,u) = P(i=s, j=u) - P(i=s) P(j=u), with the
  // joint read from posteriors given j = u. Works in place on `ev`.
  function newtonFit(net, ev, targets, targetIds) {
    const vars = []; // [node id, state] per unknown
    for (const [id, { target }] of targets) {
      const ref = target.indexOf(Math.max(...target));
      target.forEach((q, s) => { if (q > 0 && s !== ref) vars.push([id, s]); });
    }
    const goal = new Map(targets.map(([id, { target }]) => [id, target]));
    const n = vars.length;
    if (!n) return { converged: true };
    // relative to the reference state that apply() fixes at 1, so that the starting point is the
    // likelihoods already found
    const refOf = (target) => target.indexOf(Math.max(...target));
    let x = vars.map(([id, s]) => Math.log(ev.get(id)[s] / ev.get(id)[refOf(goal.get(id))]));
    const apply = (xs) => {
      for (const [id, { target }] of targets) {
        const ref = refOf(target);
        ev.set(id, target.map((q, s) => (s === ref ? 1 : 0)));
      }
      vars.forEach(([id, s], k) => { ev.get(id)[s] = Math.exp(Math.max(-700, Math.min(700, xs[k]))); });
    };
    const residual = () => {
      const r = exact(net, ev, targetIds);
      if (r.error) return r;
      // relative errors, so that tiny targets count as much as large ones
      const f = vars.map(([id, s]) => r.marginals.get(id)[s] / goal.get(id)[s] - 1);
      const worst = Math.max(...targets.map(([id, { target }]) => Math.max(...r.marginals.get(id).map((p, s) => (target[s] > 0 ? Math.abs(p / target[s] - 1) : p > 0 ? Infinity : 0)))));
      return { r, f, norm: f.reduce((a, b) => a + b * b, 0), worst };
    };
    apply(x);
    let cur = residual();
    if (cur.error) return cur;
    let mu = 1e-3;
    for (let it = 0; it < 200 && cur.worst > 1e-9; it++) {
      // Jacobian
      const q = cur.r.marginals, J = vars.map(() => new Array(n).fill(0));
      const byNode = new Map();
      vars.forEach(([id, u], k) => { if (!byNode.has(id)) byNode.set(id, []); byNode.get(id).push([u, k]); });
      for (const [j, cols] of byNode) {
        const saved = ev.get(j);
        for (const [u, k] of cols) {
          ev.set(j, u);
          const c = exact(net, ev, targetIds);
          ev.set(j, saved);
          if (c.error) continue; // P(j = u) is 0 here, so the column is 0
          vars.forEach(([i, s], row) => { J[row][k] = (q.get(j)[u] * c.marginals.get(i)[s] - q.get(i)[s] * q.get(j)[u]) / goal.get(i)[s]; });
        }
      }
      const JtJ = vars.map((_, a) => vars.map((_, b) => J.reduce((t, row) => t + row[a] * row[b], 0)));
      const Jtf = vars.map((_, a) => J.reduce((t, row, k) => t + row[a] * cur.f[k], 0));
      let accepted = false;
      for (let tries = 0; tries < 30 && !accepted; tries++) {
        const A = JtJ.map((row, a) => row.map((v, b) => v + (a === b ? mu * (JtJ[a][a] + 1e-12) + 1e-15 : 0)));
        const d = solve(A, Jtf.map((v) => -v));
        const nx = x.map((v, k) => v + Math.max(-20, Math.min(20, d[k])));
        apply(nx);
        const next = residual();
        if (!next.error && next.norm < cur.norm) { x = nx; cur = next; mu = Math.max(1e-12, mu / 4); accepted = true; }
        else mu *= 4;
      }
      if (!accepted) { apply(x); break; }
    }
    apply(x);
    return { converged: cur.worst <= 1e-9 };
  }

  // Gaussian elimination with partial pivoting.
  function solve(A, b) {
    const n = b.length, m = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      [m[c], m[p]] = [m[p], m[c]];
      if (!m[c][c]) continue;
      for (let r = c + 1; r < n; r++) { const f = m[r][c] / m[c][c]; for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let t = m[r][n];
      for (let k = r + 1; k < n; k++) t -= m[r][k] * x[k];
      x[r] = m[r][r] ? t / m[r][r] : 0;
    }
    return x;
  }

  function impossibleTargets(net, targets) {
    const names = targets.map(([id]) => M.getNode(net, id).name).join(", ");
    return { error: `This evidence is impossible: the target probabilities for ${names} give probability to a state that the rest of the model rules out.`, evidenceError: true };
  }

  // The network after the interventions in `doing` (node id -> state index): no arcs into those
  // nodes, and each one's CPT is certain of its state. Shares everything else with `net`.
  function intervene(net, doing) {
    return {
      ...net,
      nodes: net.nodes.map((n) => (doing.has(n.id) ? { ...n, cpt: n.labels.map((_, s) => (s === doing.get(n.id) ? 1 : 0)) } : n)),
      arcs: net.arcs.filter((a) => !doing.has(a.to)),
    };
  }

  globalThis.BNInference = { posteriors, intervene };
})();
