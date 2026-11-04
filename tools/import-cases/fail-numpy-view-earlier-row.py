import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
x = np.array([[0.2, 0.8]])
row = x[0]
y = x[:]
row[0] = 0.8
bn.cpt("A").fillWith(y[0])
bn.cpt("A").normalizeAsCPT()
