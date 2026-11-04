import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
x = np.array([[1.,2.], [3.,4.]])
bn.add(gum.LabelizedVariable("B", "", 2))
bn.cpt("A").fillWith(np.sum(x, 0))
bn.cpt("A").normalizeAsCPT()
bn.cpt("B").fillWith(np.mean(x, axis=1))
bn.cpt("B").normalizeAsCPT()
