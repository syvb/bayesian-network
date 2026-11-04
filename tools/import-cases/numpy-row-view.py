import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
x = np.array([[0.2,0.8],[0.5,0.5]])
y = x[0]
y[0] = 0.8
y += 0.1
bn.cpt("A").fillWith(x[0])
bn.cpt("A").normalizeAsCPT()
