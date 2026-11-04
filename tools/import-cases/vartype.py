import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
if bn.variable("A").varType() == gum.VarType_LABELIZED:
    bn.cpt("A").fillWith([0.4,0.6])
