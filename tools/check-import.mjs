// Checks the importer against real pyAgrum: runs each script with pyAgrum (tools/pyagrum_truth.py),
// imports it with the editor, and compares labels, parents and CPTs of the matching network.
// Without arguments it checks the exported code of every demo, which also checks that the export
// runs under pyAgrum, and the scripts in tools/import-cases. CPTs that fastBN left random are
// compared by structure only (pyAgrum's random values differ).
// The contract is faithful import or none: a script that fails in pyAgrum must import nothing, and
// so must the scripts named fail-*.py, which run in pyAgrum but use things the importer can't follow.
// Usage: node tools/check-import.mjs [script.py|notebook.py ...]   (set PYTHON to pick the python)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { M, P, python, fixedDemos } from "./load.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bn-check-import-"));
let files = process.argv.slice(2);
if (!files.length) {
  files = fixedDemos().map((d) => {
    const f = path.join(tmp, d.id + ".py");
    fs.writeFileSync(f, P.exportPython(d.build()));
    return f;
  });
  const cases = new URL("import-cases/", import.meta.url).pathname;
  files.push(...fs.readdirSync(cases).filter((f) => f.endsWith(".py")).sort().map((f) => path.join(cases, f)));
}

function compare(net, truthNodes, skip) {
  const diffs = [];
  for (const tn of truthNodes) {
    const n = M.nodeByName(net, tn.name);
    const parents = M.parentsOf(net, n.id).map((id) => M.getNode(net, id).name);
    const short = (x) => { const s = JSON.stringify(x); return s.length > 80 ? s.slice(0, 77) + "..." : s; };
    if (JSON.stringify(n.labels) !== JSON.stringify(tn.labels)) diffs.push(`${tn.name}: labels ${short(n.labels)} vs ${short(tn.labels)}`);
    else if (JSON.stringify([...parents].sort()) !== JSON.stringify([...tn.parents].sort())) diffs.push(`${tn.name}: parents ${parents} vs ${tn.parents}`);
    else if (!skip(tn.name)) {
      // The parent order may differ (pyAgrum's after reverseArc depends on its internals), so
      // read pyAgrum's value for each of the editor's cells.
      const cards = [n.labels.length, ...parents.map((p) => M.nodeByName(net, p).labels.length)];
      const truthOrder = [tn.name, ...tn.parents];
      const truthStrides = M.strides(truthOrder.map((name) => cards[[n.name, ...parents].indexOf(name)]));
      const d = n.cpt.reduce((m, v, i) => {
        let rem = i, j = 0;
        [n.name, ...parents].forEach((name, k) => { j += (rem % cards[k]) * truthStrides[truthOrder.indexOf(name)]; rem = Math.floor(rem / cards[k]); });
        return Math.max(m, Math.abs(v - tn.cpt[j]));
      }, 0);
      if (!(d < 1e-9)) diffs.push(`${tn.name}: CPT differs by up to ${d.toPrecision(3)}`);
    }
  }
  return diffs;
}

let bad = 0;
for (const file of files) {
  const name = path.basename(file);
  const truthFile = path.join(tmp, name + ".json");
  execFileSync(python, [new URL("pyagrum_truth.py", import.meta.url).pathname, file, truthFile], { stdio: "ignore", cwd: tmp }); // the script's own output is noise here
  const truth = JSON.parse(fs.readFileSync(truthFile, "utf8"));
  const { net, warnings } = P.importPython(fs.readFileSync(file, "utf8"));
  // Nodes whose CPT the importer left random (fastBN, never filled): pyAgrum's random values differ.
  // A long name list ends in "and N more", so then every CPT is compared by structure only.
  const random = new Set();
  let allRandom = false;
  for (const w of warnings) {
    const m = /^(?:All CPTs were|The CPTs? of (.*) (?:was|were)) left random/.exec(w);
    if (!m) continue;
    if (!m[1] || / and \d+ more$/.test(m[1])) allRandom = true;
    else m[1].split(", ").forEach((x) => random.add(x));
  }
  const skip = (n) => allRandom || random.has(n);

  let verdict;
  const mustFail = name.startsWith("fail-") ? "the importer can't follow it" : truth.error ? `pyAgrum raised ${truth.error.split("\n")[0]}` : null;
  if (mustFail) verdict = net ? `FAIL: imported a network, but ${mustFail}` : `ok (imported nothing: ${mustFail})`;
  else if (!net) verdict = `FAIL: the editor imported no network (${warnings[0]})`;
  else {
    const names = net.nodes.map((n) => n.name).sort().join("|");
    const candidates = Object.entries(truth.bns).filter(([, ns]) => ns.map((n) => n.name).sort().join("|") === names);
    if (!candidates.length) verdict = `FAIL: no pyAgrum network has the same variables${truth.error ? ` (pyAgrum: ${truth.error.split("\n")[0]})` : ""}`;
    else {
      const best = candidates.map(([k, ns]) => [k, compare(net, ns, skip)]).sort((a, b) => a[1].length - b[1].length)[0];
      verdict = best[1].length ? `FAIL vs ${best[0]}:\n    ${best[1].slice(0, 6).join("\n    ")}` : `ok (${net.nodes.length} variables${random.size || allRandom ? ", random CPTs skipped" : ""})`;
    }
  }
  if (verdict.startsWith("FAIL")) bad++;
  console.log(`${name}: ${verdict}${warnings.length ? `  [${warnings.length} import warning(s)]` : ""}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${files.length - bad}/${files.length} match pyAgrum`);
process.exitCode = bad ? 1 : 0;
