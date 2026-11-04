import pyagrum as gum
bn = gum.BayesNet()
a = bn.add(gum.LabelizedVariable("A", "", 2), 5)
bn.cpt(a).fillWith([a/10, 1-a/10])
b = bn.add(gum.LabelizedVariable("B", "", 2), 0)
bn.cpt(b).fillWith([0.1, 0.9])
