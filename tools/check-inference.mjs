// Checks the editor's exact inference against pyAgrum's LazyPropagation: posteriors of every
// variable and P(evidence), on the demos and on random networks, with no evidence, hard evidence
// and likelihood (soft) evidence. Usage: node tools/check-inference.mjs   (set PYTHON to pick the python)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { M, P, I, demos, fixedDemos, python } from "./load.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bn-check-inference-"));
const randomDemo = demos.find((d) => d.id === "random");
const nets = [...fixedDemos().map((d) => d.build()), ...Array.from({ length: 20 }, () => randomDemo.build())];
const shuffled = (xs) => xs.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

const cases = [];
nets.forEach((net, i) => {
  const file = path.join(tmp, `net${i}.py`);
  fs.writeFileSync(file, P.exportPython(net));
  const evidences = [new Map()];
  for (const count of [1, 2]) evidences.push(new Map(shuffled(net.nodes).slice(0, count).map((n) => [n.id, Math.floor(Math.random() * n.labels.length)])));
  const soft = shuffled(net.nodes)[0];
  evidences.push(new Map([[soft.id, soft.labels.map(() => +Math.random().toFixed(3))]]));
  for (const ev of evidences) {
    const r = I.posteriors(net, ev);
    cases.push({
      file,
      // a state index becomes its label; a likelihood list stays a list, as pyAgrum's setEvidence takes both
      evidence: Object.fromEntries([...ev].map(([id, v]) => { const n = M.getNode(net, id); return [n.name, Array.isArray(v) ? v : n.labels[v]]; })),
      error: r.error || null,
      pEvidence: r.pEvidence ?? null,
      marginals: r.marginals ? Object.fromEntries([...r.marginals].map(([id, p]) => [M.getNode(net, id).name, [...p]])) : null,
    });
  }
});
fs.writeFileSync(path.join(tmp, "cases.json"), JSON.stringify(cases));

const check = `
import json, runpy, sys, pyagrum as gum
cases = json.load(open(sys.argv[1])); worst = 0; bad = 0
for c in cases:
    ie = gum.LazyPropagation(runpy.run_path(c["file"])["bn"])
    if c["evidence"]: ie.setEvidence(c["evidence"])
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
    worst = max(worst, abs((ie.evidenceProbability() if c["evidence"] else 1.0) - c["pEvidence"]))
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
