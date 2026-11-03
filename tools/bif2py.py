# Writes a pyAgrum script that builds a .bif (or other pyAgrum-readable) network by hand: variables,
# arcs and CPTs, so it can be opened in the editor or with ?src=.
# style "rows" (default) writes one bn.cpt(x)[{parent: label, ...}] = [...] per row; "flat" one fillWith.
# Usage: python3 tools/bif2py.py network.bif out.py [rows|flat]
import sys, json, os, pyagrum as gum

src, dst = sys.argv[1], sys.argv[2]
style = sys.argv[3] if len(sys.argv) > 3 else "rows"
bn = gum.loadBN(src)
order = bn.topologicalOrder()
q = json.dumps
lines = ["import pyagrum as gum", "", f"bn = gum.BayesNet({q(os.path.splitext(os.path.basename(src))[0])})"]
for n in order:
    v = bn.variable(n)
    lines.append(f"bn.add(gum.LabelizedVariable({q(v.name())}, {q(v.description())}, {q(list(v.labels()))}))")
for n in order:
    p = bn.cpt(n)
    for parent in p.names[1:]:
        lines.append(f"bn.addArc({q(parent)}, {q(p.names[0])})")
for n in order:
    p = bn.cpt(n)
    name, card = p.names[0], bn.variable(n).domainSize()
    inst, vals = gum.Instantiation(p), []
    inst.setFirst()
    while not inst.end(): vals.append(p.get(inst)); inst.inc()
    if style == "flat" or len(p.names) == 1:
        lines.append(f"bn.cpt({q(name)}).fillWith({q(vals)})")
        continue
    parents = [bn.variable(x) for x in p.names[1:]]
    for r in range(len(vals) // card):
        rem, key = r, {}
        for pv in parents:
            key[pv.name()] = pv.label(rem % pv.domainSize()); rem //= pv.domainSize()
        lines.append(f"bn.cpt({q(name)})[{q(key)}] = {q(vals[r * card:(r + 1) * card])}")
open(dst, "w").write("\n".join(lines) + "\n")
print(f"{dst}: {bn.size()} variables, {bn.sizeArcs()} arcs")
