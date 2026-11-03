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
