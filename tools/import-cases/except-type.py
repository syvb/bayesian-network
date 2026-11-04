import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
try:
    x = {}["missing"]
except ValueError:
    bn.cpt("A").fillWith([0.9, 0.1])
except KeyError:
    bn.cpt("A").fillWith([0.4, 0.6])
