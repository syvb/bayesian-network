import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
x = np.array([[1., 2.], [3., 4.]]) + np.array([10., 20.])
bn.cpt("A").fillWith(x[0])
bn.cpt("A").normalizeAsCPT()
