import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
x = np.array([1.0, 3.0])
x *= 0.5
bn.cpt("A").fillWith(x)
bn.cpt("A").normalizeAsCPT()
