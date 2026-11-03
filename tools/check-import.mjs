// Checks the importer against real pyAgrum: runs each script with pyAgrum (tools/pyagrum_truth.py),
// imports it with the editor, and compares labels, parents and CPTs of the matching network.
// Without arguments it checks the exported code of every demo, which also checks that the export
// runs under pyAgrum. CPTs the importer reports as random or unfilled are compared by structure only.
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
}

function compare(net, truthNodes, skip) {
  const diffs = [];
  for (const tn of truthNodes) {
    const n = M.nodeByName(net, tn.name);
    const parents = M.parentsOf(net, n.id).map((id) => M.getNode(net, id).name);
    const short = (x) => { const s = JSON.stringify(x); return s.length > 80 ? s.slice(0, 77) + "..." : s; };
    if (JSON.stringify(n.labels) !== JSON.stringify(tn.labels)) diffs.push(`${tn.name}: labels ${short(n.labels)} vs ${short(tn.labels)}`);
    else if (JSON.stringify(parents) !== JSON.stringify(tn.parents)) diffs.push(`${tn.name}: parents ${parents} vs ${tn.parents}`);
    else if (!skip(tn.name)) {
      const d = tn.cpt.reduce((m, v, i) => Math.max(m, Math.abs(v - n.cpt[i])), 0);
      if (!(d < 1e-9)) diffs.push(`${tn.name}: CPT differs by up to ${d.toPrecision(3)}`);
    }
  }
  return diffs;
}

let bad = 0;
for (const file of files) {
  const name = path.basename(file);
  const truthFile = path.join(tmp, name + ".json");
  execFileSync(python, [new URL("pyagrum_truth.py", import.meta.url).pathname, file, truthFile], { stdio: "ignore" }); // the script's own output is noise here
  const truth = JSON.parse(fs.readFileSync(truthFile, "utf8"));
  const { net, warnings } = P.importPython(fs.readFileSync(file, "utf8"));
  // Nodes whose CPT the importer left random (fastBN, never filled): pyAgrum's random values differ.
  // A long name list ends in "and N more", so then every CPT is compared by structure only.
  const random = new Set();
  let allRandom = false;
  for (const w of warnings) {
    const m = /^(?:All CPTs were|The CPTs? of (.*) (?:was|were)) (?:left random|never filled)/.exec(w);
    if (!m) continue;
    if (!m[1] || / and \d+ more$/.test(m[1])) allRandom = true;
    else m[1].split(", ").forEach((x) => random.add(x));
  }
  const skip = (n) => allRandom || random.has(n);

  let verdict;
  if (!net) verdict = "FAIL: the editor imported no network";
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
