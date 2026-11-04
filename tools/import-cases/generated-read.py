import pyagrum as gum
bn = gum.BayesNet()
bn.add(gum.RangeVariable("A", "", 0, 1))
bn.cpt("A").fillWith([0.2, 0.8])
bn.addOR(gum.RangeVariable("B", "", 0, 1))
bn.addArc("A", "B")
bn.add(gum.RangeVariable("C", "", 0, 1))
p = bn.cpt("B")[{"A": 1, "B": 1}]
bn.cpt("C").fillWith([1-p, p])
bn.add(gum.RangeVariable("D", "", 0, 1))
bn.addArc("A", "D")
bn.cpt("D").fillWith(bn.cpt("B"), {"D": "B", "A": "A"})
