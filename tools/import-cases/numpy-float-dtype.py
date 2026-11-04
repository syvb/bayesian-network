import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
x = np.array([1.0, 3.0], dtype=float)
x *= 0.5
y = np.zeros(2)
y[0] = 0.25
y[1] = 0.75
bn.cpt("A").fillWith(x + y)
bn.cpt("A").normalizeAsCPT()
