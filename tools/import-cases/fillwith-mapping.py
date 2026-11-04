import pyagrum as gum
bn = gum.fastBN("A[3]->B[3];C[3]->D[3]")
bn.cpt("A").fillWith([0.2, 0.3, 0.5])
bn.cpt("C").fillWith([0.2, 0.3, 0.5])
bn.cpt("B").fillWith([0.1,0.2,0.7, 0.3,0.4,0.3, 0.6,0.4,0])
bn.cpt("D").fillWith(bn.cpt("B"), {"D":"A", "C":"B"})
