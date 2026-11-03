# Runs a pyAgrum script with real pyAgrum and writes every BayesNet left in its globals as JSON:
# {"error": str | null, "bns": {global name: [{name, labels, parents, cpt}]}}, CPTs first variable fastest.
# Plotting and notebook modules are stubbed out, and %magic / !shell lines are dropped, so notebook
# exports run headless. Usage: python3 tools/pyagrum_truth.py script.py out.json
import sys, json, types, random, importlib.abc, importlib.machinery

random.seed(0)
STUB_PREFIXES = ("pyagrum.lib", "pyAgrum.lib", "matplotlib", "seaborn", "IPython", "pylab", "pandas", "sklearn",
                 "openturns", "otagrum", "graphviz", "pydot")


class Anything(types.ModuleType):
    def __init__(self, name="stub"): super().__init__(name); self.__path__ = []
    def __getattr__(self, k):
        if k.startswith("__") and k != "__call__": raise AttributeError(k)
        return Anything(k)
    def __call__(self, *a, **k): return Anything()
    def __iter__(self): return iter([])
    def __getitem__(self, k): return Anything()
    def __setitem__(self, k, v): pass


class Stubs(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, name, path, target=None):
        if name.startswith(STUB_PREFIXES): return importlib.machinery.ModuleSpec(name, self, is_package=True)
    def create_module(self, spec): return Anything(spec.name)
    def exec_module(self, m): pass


sys.meta_path.insert(0, Stubs())
import pyagrum as gum
sys.modules["pyAgrum"] = gum

src_path, out_path = sys.argv[1], sys.argv[2]
src = "\n".join(l for l in open(src_path).read().split("\n") if not l.lstrip().startswith(("%", "!")))
g = {"__name__": "__main__"}
err = None
try:
    exec(compile(src, src_path, "exec"), g)
except Exception as e:
    err = f"{type(e).__name__}: {e}"

out = {"error": err, "bns": {}}
for k, v in list(g.items()):
    if type(v) is gum.BayesNet:
        nodes = []
        for nid in sorted(v.nodes()):
            var, p = v.variable(nid), v.cpt(nid)
            inst, vals = gum.Instantiation(p), []
            inst.setFirst()
            while not inst.end(): vals.append(p.get(inst)); inst.inc()
            nodes.append({"name": var.name(), "labels": list(var.labels()), "parents": list(p.names[1:]), "cpt": vals})
        out["bns"][k] = nodes
json.dump(out, open(out_path, "w"))
