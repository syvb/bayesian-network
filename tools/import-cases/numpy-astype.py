import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
x = np.array([0.9,1.9]).astype(int).tolist()
bn.cpt("A").fillWith(x)
bn.cpt("A").normalizeAsCPT()
