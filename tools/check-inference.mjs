// Checks the editor's exact inference against pyAgrum's LazyPropagation: posteriors of every
// variable and P(evidence), on the demos and on random networks, with no evidence, hard evidence
// likelihood (soft) evidence and target probabilities. Each case runs the editor's own export, whose
// setEvidence call carries the evidence, so this also checks the exported evidence. Usage: node tools/check-inference.mjs   (set PYTHON to pick the python)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { M, P, I, demos, fixedDemos, python } from "./load.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bn-check-inference-"));
const randomDemo = demos.find((d) => d.id === "random");
const nets = [...fixedDemos().map((d) => d.build()), ...Array.from({ length: 20 }, () => randomDemo.build())];
// B copies A, and both get the same target: compatible targets that depend on each other.
const copyNet = M.createNetwork("copy");
{
  const [a, b] = ["A", "B"].map((name) => M.addNode(copyNet, { name, labels: ["yes", "no"] }));
  M.addArc(copyNet, a.id, b.id);
  a.cpt = [0.5, 0.5];
  b.cpt = [1, 0, 0, 1];
  nets.push(copyNet);
}
// The same with a near-copy (B follows A 99.99% of the time), where fitting one target at a time
// converges far too slowly on its own.
const nearCopyNet = JSON.parse(JSON.stringify(copyNet));
nearCopyNet.name = "near copy";
nearCopyNet.nodes[1].cpt = [0.9999, 0.0001, 0.0001, 0.9999];
nets.push(nearCopyNet);
const shuffled = (xs) => xs.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

const cases = [];
nets.forEach((net, i) => {
  const evidences = [new Map()];
  for (const count of [1, 2]) evidences.push(new Map(shuffled(net.nodes).slice(0, count).map((n) => [n.id, Math.floor(Math.random() * n.labels.length)])));
  const soft = shuffled(net.nodes)[0];
  evidences.push(new Map([[soft.id, soft.labels.map(() => +Math.random().toFixed(3))]]));
  const [target, other] = shuffled(net.nodes);
  const q = target.labels.map(() => 0.05 + Math.random());
  evidences.push(new Map([[target.id, { target: q.map((x) => x / q.reduce((a, b) => a + b)) }], [other.id, Math.floor(Math.random() * other.labels.length)]]));
  if (net === copyNet || net === nearCopyNet) evidences.push(new Map(net.nodes.map((n) => [n.id, { target: [0.7, 0.3] }])));
  evidences.forEach((ev, j) => {
    const r = I.posteriors(net, ev);
    if ((net === copyNet || net === nearCopyNet) && j === evidences.length - 1 && r.error) { console.log("compatible targets were rejected:", r.error); process.exitCode = 1; }
    // target probabilities, when accepted, must be what the nodes end up with
    for (const [id, v] of ev) {
      if (!r.error && v && v.target && v.target.some((q, s) => Math.abs(q - r.marginals.get(id)[s]) > 1e-8)) { console.log("a target wasn't reached:", M.getNode(net, id).name, v.target, r.marginals.get(id)); process.exitCode = 1; }
    }
    const file = path.join(tmp, `net${i}-${j}.py`);
    fs.writeFileSync(file, P.exportPython(net, ev));
    const back = P.importPython(fs.readFileSync(file, "utf8")).evidence || {};
    const same = [...ev].every(([id, v]) => { const n = M.getNode(net, id); return JSON.stringify(back[n.name]) === JSON.stringify(typeof v === "number" ? n.labels[v] : v); });
    if (!same || Object.keys(back).length !== ev.size) { console.log("evidence didn't survive export and import:", file); process.exitCode = 1; }
    cases.push({
      file,
      // a state index becomes its label; a likelihood list stays a list, as pyAgrum's setEvidence takes both
      evidence: Object.fromEntries([...ev].map(([id, v]) => { const n = M.getNode(net, id); return [n.name, typeof v === "number" ? n.labels[v] : v]; })),
      error: r.error || null,
      pEvidence: r.pEvidence ?? null,
      marginals: r.marginals ? Object.fromEntries([...r.marginals].map(([id, p]) => [M.getNode(net, id).name, [...p]])) : null,
    });
  });
});
fs.writeFileSync(path.join(tmp, "cases.json"), JSON.stringify(cases));

// Checks with an independent oracle: brute-force enumeration of the joint distribution.
// P(x) = prod of CPT entries, times the likelihoods; an intervention do(X = s) replaces X's CPT
// row by certainty of s (whatever its parents).
function enumerate(net, lik = new Map(), doing = new Map()) {
  const ns = net.nodes, cards = ns.map((n) => n.labels.length), marg = ns.map((n) => n.labels.map(() => 0));
  const x = ns.map(() => 0);
  let total = 0;
  for (;;) {
    let p = 1;
    ns.forEach((n, i) => {
      const s = x[i];
      if (doing.has(n.id)) { p *= s === doing.get(n.id) ? 1 : 0; return; }
      const parents = M.parentsOf(net, n.id), st = M.strides([n.labels.length, ...parents.map((q) => M.card(net, q))]);
      let off = s;
      parents.forEach((q, k) => { off += x[ns.findIndex((m) => m.id === q)] * st[k + 1]; });
      p *= n.cpt[off] * (lik.has(n.id) ? lik.get(n.id)[s] : 1);
    });
    total += p;
    ns.forEach((n, i) => { marg[i][x[i]] += p; });
    let k = 0;
    while (k < ns.length && ++x[k] === cards[k]) x[k++] = 0;
    if (k === ns.length) break;
  }
  return { total, marginals: new Map(ns.map((n, i) => [n.id, marg[i].map((v) => v / total)])) };
}
const fail = (...msg) => { console.log(...msg); process.exitCode = 1; };
const maxDiff = (a, b) => Math.max(...[...b].map(([id, p]) => Math.max(...p.map((v, s) => Math.abs(v - a.get(id)[s])))));
let oracleCases = 0;
const smallNet = () => { let n; do n = randomDemo.build(); while (n.nodes.reduce((t, m) => t * m.labels.length, 1) > 5e4); return n; };
for (let k = 0; k < 40; k++) {
  const net = smallNet();
  const [a, b, c] = shuffled(net.nodes);
  // feasible targets: the marginals that known positive likelihoods on two nodes produce
  const lik = new Map([a, b].map((n) => [n.id, n.labels.map(() => 0.02 + Math.random())]));
  const doing = new Map([[c.id, Math.floor(Math.random() * c.labels.length)]]);
  for (const withDo of [false, true]) {
    const truth = enumerate(net, lik, withDo ? doing : new Map());
    const ev = new Map([a, b].map((n) => [n.id, { target: truth.marginals.get(n.id) }]));
    if (withDo) ev.set(c.id, { do: doing.get(c.id) });
    const r = I.posteriors(net, ev);
    oracleCases++;
    if (r.error) fail("feasible targets were rejected:", r.error);
    else if (maxDiff(r.marginals, truth.marginals) > 1e-7) fail("targets: posteriors differ from enumeration by", maxDiff(r.marginals, truth.marginals));
  }
  // likelihood evidence with an intervention
  const truth = enumerate(net, lik, doing);
  const r = I.posteriors(net, new Map([...lik, [c.id, { do: doing.get(c.id) }]]));
  oracleCases++;
  if (r.error) fail("likelihoods with an intervention were rejected:", r.error);
  else if (maxDiff(r.marginals, truth.marginals) > 1e-12) fail("do(): posteriors differ from enumeration by", maxDiff(r.marginals, truth.marginals));
}
// Targets whose likeliest state isn't the state with the largest likelihood (it once threw Newton
// off the nearly fitted likelihoods): A -> B, targets from likelihoods A [.5,.08,.14,.86], B [.02,.42,.65].
{
  const net = M.createNetwork("reference");
  const a = M.addNode(net, { name: "A", labels: ["0", "1", "2", "3"] }), b = M.addNode(net, { name: "B", labels: ["0", "1", "2"] });
  M.addArc(net, a.id, b.id);
  a.cpt = [0.09, 0.07, 0.69, 0.15];
  b.cpt = [0.36, 0.64, 0, 0.77, 0.06, 0.17, 0.05, 0.27, 0.68, 0.62, 0.38, 0];
  const truth = enumerate(net, new Map([[a.id, [0.5, 0.08, 0.14, 0.86]], [b.id, [0.02, 0.42, 0.65]]]));
  const r = I.posteriors(net, new Map([a, b].map((n) => [n.id, { target: truth.marginals.get(n.id) }])));
  oracleCases++;
  if (r.error || maxDiff(r.marginals, truth.marginals) > 1e-7) fail("reference-state targets failed:", r.error || maxDiff(r.marginals, truth.marginals));
}
// Numerical range: rare observations must neither underflow nor overflow.
{
  const net = M.createNetwork("range");
  const [a, b, c] = ["A", "B", "C"].map((name) => M.addNode(net, { name, labels: ["0", "1"] }));
  c.cpt = [0.1, 0.9];
  for (const [pa, pb] of [[1e-162, 1e-161], [1e-200, 1e-200]]) {
    a.cpt = [pa, 1 - pa]; b.cpt = [pb, 1 - pb];
    const r = I.posteriors(net, new Map([[a.id, 0], [b.id, 0]]));
    oracleCases++;
    if (r.error || Math.abs(r.marginals.get(c.id)[0] - 0.1) > 1e-15) fail(`observing states of probability ${pa} and ${pb}:`, r.error || r.marginals.get(c.id));
  }
  a.cpt = [0.5, 0.5]; b.cpt = [0.5, 0.5];
  const r = I.posteriors(net, new Map([[a.id, [1e200, 2e200]], [b.id, [1e200, 1e200]]]));
  oracleCases++;
  if (r.error || Math.abs(r.marginals.get(a.id)[0] - 1 / 3) > 1e-15) fail("huge likelihoods:", r.error || r.marginals.get(a.id));
  // invalid input is refused rather than given made-up probabilities
  for (const [what, setup, ev] of [
    ["a CPT of zeros", () => { c.cpt = [0, 0]; }, new Map()],
    ["a CPT row not adding up to 1", () => { c.cpt = [0.2, 0.2]; }, new Map([[a.id, [1, 1]]])],
    ["negative likelihoods", () => { c.cpt = [0.1, 0.9]; }, new Map([[a.id, [-1, 2]]])],
    ["infinite likelihoods", () => {}, new Map([[a.id, [Infinity, 1]]])],
  ]) {
    setup();
    oracleCases++;
    if (!I.posteriors(net, ev).error) fail(`${what} wasn't refused`);
  }
}
// Tiny probabilities: reversing an arc whose joint is 1e-170 * 1e-170 (below floating point) keeps
// P(A=0 | B=0) = 1e-170, and a target of 1e-12 is met as closely as any other.
{
  const net = M.createNetwork("tiny");
  const a = M.addNode(net, { name: "A", labels: ["0", "1"] }), b = M.addNode(net, { name: "B", labels: ["0", "1"] });
  M.addArc(net, a.id, b.id);
  a.cpt = [1e-170, 1]; b.cpt = [1e-170, 1, 1e-170, 1];
  M.reverseArc(net, a.id, b.id);
  const r = I.posteriors(net, new Map([[b.id, 0]]));
  oracleCases++;
  if (r.error || Math.abs(r.marginals.get(a.id)[0] / 1e-170 - 1) > 1e-12) fail("reversal with tiny probabilities:", r.error || r.marginals.get(a.id));
  a.cpt = [0.5, 0.5]; b.cpt = [0.9, 0.1, 0.1, 0.9];
  net.arcs = [{ from: a.id, to: b.id }];
  const t = I.posteriors(net, new Map([[a.id, { target: [1e-12, 1 - 1e-12] }], [b.id, { target: [0.3, 0.7] }]]));
  oracleCases++;
  if (t.error || Math.abs(t.marginals.get(a.id)[0] / 1e-12 - 1) > 1e-6) fail("tiny target:", t.error || t.marginals.get(a.id));
}
console.log(`${oracleCases} cases checked against brute-force enumeration`);

const check = `
import json, runpy, sys, pyagrum as gum
cases = json.load(open(sys.argv[1])); worst = 0; bad = 0
for c in cases:
    # pyAgrum has no target probabilities, so evidence the editor rejects because of them can't be compared
    if c["error"] and any(isinstance(v, dict) for v in c["evidence"].values()): continue
    g = runpy.run_path(c["file"])
    # the export sets the evidence itself, except evidence the editor found impossible
    ie = g.get("ie") or gum.LazyPropagation(g["bn"])
    if c["error"] and c["evidence"] and "ie" not in g:
        ev = {k: v for k, v in c["evidence"].items() if not isinstance(v, dict)}
        if ev: ie.setEvidence(ev)
    try:
        ie.makeInference()
    except Exception as e:
        if c["error"] is None: print("pyAgrum failed but the editor did not:", c["file"], c["evidence"], e); bad += 1
        continue
    if c["error"]:
        # pyAgrum may accept impossible evidence without raising; it agrees if P(evidence) is 0
        try: agree = ie.evidenceProbability() < 1e-12
        except Exception: agree = True
        if not agree: print("the editor failed but pyAgrum did not:", c["file"], c["evidence"], c["error"]); bad += 1
        continue
    hard = any(not isinstance(v, dict) for v in c["evidence"].values())
    # P(evidence) in the editor leaves out target probabilities; pyAgrum's includes their likelihoods
    if not any(isinstance(v, dict) for v in c["evidence"].values()):
        worst = max(worst, abs((ie.evidenceProbability() if hard else 1.0) - c["pEvidence"]))
    for name, p in c["marginals"].items():
        worst = max(worst, max(abs(a - b) for a, b in zip(p, ie.posterior(name).tolist())))
print(f"{len(cases)} cases, {bad} disagreements, largest probability difference {worst:.2e}")
sys.exit(1 if bad or worst > 1e-9 else 0)
`;
try {
  execFileSync(python, ["-c", check, path.join(tmp, "cases.json")], { stdio: "inherit" });
} catch {
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
