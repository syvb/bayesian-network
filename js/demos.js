// Demo networks for trying out the editor. Most are pyAgrum code, loaded through the importer.
(function () {
  "use strict";
  const M = globalThis.BNModel, P = globalThis.BNPyAgrum;

  const fromCode = (code) => () => P.importPython(code).net;

  const WET_GRASS = `import pyagrum as gum

bn = gum.BayesNet("Wet grass")
bn.add(gum.LabelizedVariable("cloudy", "", ["no", "yes"]))
bn.add(gum.LabelizedVariable("sprinkler", "", ["off", "on"]))
bn.add(gum.LabelizedVariable("rain", "", ["no", "yes"]))
bn.add(gum.LabelizedVariable("wet_grass", "", ["no", "yes"]))
bn.addArc("cloudy", "sprinkler")
bn.addArc("cloudy", "rain")
bn.addArc("sprinkler", "wet_grass")
bn.addArc("rain", "wet_grass")
bn.cpt("cloudy").fillWith([0.5, 0.5])
bn.cpt("sprinkler")[{"cloudy": "no"}] = [0.5, 0.5]
bn.cpt("sprinkler")[{"cloudy": "yes"}] = [0.9, 0.1]
bn.cpt("rain")[{"cloudy": "no"}] = [0.8, 0.2]
bn.cpt("rain")[{"cloudy": "yes"}] = [0.2, 0.8]
bn.cpt("wet_grass")[{"sprinkler": "off", "rain": "no"}] = [1, 0]
bn.cpt("wet_grass")[{"sprinkler": "off", "rain": "yes"}] = [0.1, 0.9]
bn.cpt("wet_grass")[{"sprinkler": "on", "rain": "no"}] = [0.1, 0.9]
bn.cpt("wet_grass")[{"sprinkler": "on", "rain": "yes"}] = [0.01, 0.99]
# bn-editor-layout: {"cloudy":[300,80],"sprinkler":[160,200],"rain":[440,200],"wet_grass":[300,320]}
`;

  // Lauritzen & Spiegelhalter (1988), "chest clinic".
  const ASIA = `import pyagrum as gum

bn = gum.BayesNet("Asia")
bn.add(gum.LabelizedVariable("asia", "Visit to Asia", ["no", "yes"]))
bn.add(gum.LabelizedVariable("smoke", "Smoker", ["no", "yes"]))
bn.add(gum.LabelizedVariable("tub", "Tuberculosis", ["no", "yes"]))
bn.add(gum.LabelizedVariable("lung", "Lung cancer", ["no", "yes"]))
bn.add(gum.LabelizedVariable("bronc", "Bronchitis", ["no", "yes"]))
bn.add(gum.LabelizedVariable("either", "Tuberculosis or lung cancer", ["no", "yes"]))
bn.add(gum.LabelizedVariable("xray", "Positive X-ray", ["no", "yes"]))
bn.add(gum.LabelizedVariable("dysp", "Dyspnoea", ["no", "yes"]))
bn.addArc("asia", "tub")
bn.addArc("smoke", "lung")
bn.addArc("smoke", "bronc")
bn.addArc("tub", "either")
bn.addArc("lung", "either")
bn.addArc("either", "xray")
bn.addArc("bronc", "dysp")
bn.addArc("either", "dysp")
bn.cpt("asia").fillWith([0.99, 0.01])
bn.cpt("smoke").fillWith([0.5, 0.5])
bn.cpt("tub")[{"asia": "no"}] = [0.99, 0.01]
bn.cpt("tub")[{"asia": "yes"}] = [0.95, 0.05]
bn.cpt("lung")[{"smoke": "no"}] = [0.99, 0.01]
bn.cpt("lung")[{"smoke": "yes"}] = [0.9, 0.1]
bn.cpt("bronc")[{"smoke": "no"}] = [0.7, 0.3]
bn.cpt("bronc")[{"smoke": "yes"}] = [0.4, 0.6]
bn.cpt("either")[{"tub": "no", "lung": "no"}] = [1, 0]
bn.cpt("either")[{"tub": "no", "lung": "yes"}] = [0, 1]
bn.cpt("either")[{"tub": "yes", "lung": "no"}] = [0, 1]
bn.cpt("either")[{"tub": "yes", "lung": "yes"}] = [0, 1]
bn.cpt("xray")[{"either": "no"}] = [0.95, 0.05]
bn.cpt("xray")[{"either": "yes"}] = [0.02, 0.98]
bn.cpt("dysp")[{"bronc": "no", "either": "no"}] = [0.9, 0.1]
bn.cpt("dysp")[{"bronc": "no", "either": "yes"}] = [0.3, 0.7]
bn.cpt("dysp")[{"bronc": "yes", "either": "no"}] = [0.2, 0.8]
bn.cpt("dysp")[{"bronc": "yes", "either": "yes"}] = [0.1, 0.9]
# bn-editor-layout: {"asia":[160,80],"smoke":[480,80],"tub":[160,200],"lung":[380,200],"bronc":[580,200],"either":[270,320],"xray":[170,440],"dysp":[480,440]}
`;

  // One variable of each pyAgrum type; CPTs are random, as with gum.fastBN.
  const VARIABLE_TYPES = `import pyagrum as gum

bn = gum.fastBN("season{winter|spring|summer|autumn}->temperature[-10,0,10,20,35]->ice_creams[0,4]<-visitors{0|10|50|100};season->visitors")
`;

  // A random DAG: each node gets up to three parents among the earlier nodes.
  function randomNetwork(count = 12) {
    const net = M.createNetwork("Random");
    const labelSets = [["no", "yes"], ["low", "medium", "high"], ["a", "b", "c", "d"], ["off", "on"]];
    const nodes = [];
    for (let i = 0; i < count; i++) {
      const labels = labelSets[Math.floor(Math.random() * labelSets.length)];
      const node = M.addNode(net, { name: "X" + (i + 1), labels });
      const parents = nodes.filter(() => Math.random() < Math.min(0.5, 2 / Math.max(1, nodes.length))).slice(-3);
      for (const p of parents) M.addArc(net, p.id, node.id);
      nodes.push(node);
    }
    for (const n of net.nodes) M.randomizeCpt(n);
    M.autoLayout(net);
    return net;
  }

  globalThis.BNDemos = [
    { id: "wet-grass", label: "Wet grass", detail: "4 binary variables", build: fromCode(WET_GRASS) },
    { id: "asia", label: "Asia (chest clinic)", detail: "8 variables, classic textbook network", build: fromCode(ASIA) },
    { id: "types", label: "All variable types", detail: "labelized, range, integer, discretized", build: fromCode(VARIABLE_TYPES) },
    { id: "random", label: "Random network", detail: "12 variables, random arcs and CPTs", build: () => randomNetwork() },
  ];
})();
