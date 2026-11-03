// Exports every demo (and each pyAgrum script given as an argument) to pyAgrum code, imports that
// code again, and checks the network came back identical with no warnings.
// Usage: node tools/roundtrip.mjs [script.py ...]
import fs from "node:fs";
import { M, P, demos } from "./load.mjs";

const sig = (net) => JSON.stringify(net.nodes.map((n) => [
  n.name, n.type, n.description, n.labels, n.min, n.max, n.values, n.ticks, Math.round(n.x), Math.round(n.y),
  M.parentsOf(net, n.id).map((id) => M.getNode(net, id).name), n.cpt.map((v) => +v.toPrecision(12)),
]));

const cases = process.argv.slice(2).map((f) => [f, () => P.importPython(fs.readFileSync(f, "utf8")).net]);
for (const d of demos) cases.push(["demo " + d.id, d.build]);

let fails = 0;
for (const [name, build] of cases) {
  const a = build();
  const r = a && P.importPython(P.exportPython(a));
  if (!a || !r.net || sig(r.net) !== sig(a) || r.warnings.length) {
    fails++;
    console.log("FAIL", name, a ? r.warnings.slice(0, 3) : "imported no network");
  }
}
console.log(`${cases.length - fails}/${cases.length} round trips identical`);
process.exitCode = fails ? 1 : 0;
