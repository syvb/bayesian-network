import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
ie = gum.LazyPropagation(bn)
if ie.posterior("A")[0] > 0.1:
    bn.cpt("A").fillWith([0.5,0.5])
