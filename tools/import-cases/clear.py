import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
bn.clear()
bn.add(gum.LabelizedVariable("B", "", 2))
bn.cpt("B").fillWith([0.7, 0.3])
