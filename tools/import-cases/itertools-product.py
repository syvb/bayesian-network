import pyagrum as gum
import numpy as np
bn = gum.BayesNet()
bn.add(gum.LabelizedVariable("A", "", 2))
bn.cpt("A").fillWith([0.2, 0.8])
from itertools import product
for a in product([0, 1], repeat=1):
    bn.cpt("A")[a[0]] = 0.5
