import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
import pyagrum.lib.notebook as gnb
ie = gum.LazyPropagation(bn)
ie.makeInference()
print(ie.posterior("A"))
gnb.showInference(bn)
