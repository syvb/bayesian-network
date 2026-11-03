// Demo networks for trying out the editor. Most are pyAgrum code, loaded through the importer.
(function () {
  "use strict";
  const M = globalThis.BNModel, P = globalThis.BNPyAgrum;

  const fromCode = (code) => () => P.importPython(code).net;

  const WET_GRASS = `import pyagrum as gum

bn = gum.BayesNet("Wet grass")
bn.add(gum.LabelizedVariable("cloudy", "", ["yes", "no"]))
bn.add(gum.LabelizedVariable("sprinkler", "", ["on", "off"]))
bn.add(gum.LabelizedVariable("rain", "", ["yes", "no"]))
bn.add(gum.LabelizedVariable("wet grass", "", ["yes", "no"]))
bn.addArc("cloudy", "sprinkler")
bn.addArc("cloudy", "rain")
bn.addArc("sprinkler", "wet grass")
bn.addArc("rain", "wet grass")
bn.cpt("cloudy").fillWith([0.5, 0.5])
bn.cpt("sprinkler")[{"cloudy": "no"}] = [0.5, 0.5]
bn.cpt("sprinkler")[{"cloudy": "yes"}] = [0.1, 0.9]
bn.cpt("rain")[{"cloudy": "no"}] = [0.2, 0.8]
bn.cpt("rain")[{"cloudy": "yes"}] = [0.8, 0.2]
bn.cpt("wet grass")[{"sprinkler": "off", "rain": "no"}] = [0, 1]
bn.cpt("wet grass")[{"sprinkler": "off", "rain": "yes"}] = [0.9, 0.1]
bn.cpt("wet grass")[{"sprinkler": "on", "rain": "no"}] = [0.9, 0.1]
bn.cpt("wet grass")[{"sprinkler": "on", "rain": "yes"}] = [0.99, 0.01]
# bn-editor-layout: {"cloudy":[300,80],"sprinkler":[160,200],"rain":[440,200],"wet grass":[300,320]}
`;

  // Lauritzen & Spiegelhalter (1988), "chest clinic".
  const ASIA = `import pyagrum as gum

bn = gum.BayesNet("Asia")
bn.add(gum.LabelizedVariable("asia", "Visit to Asia", ["yes", "no"]))
bn.add(gum.LabelizedVariable("smoke", "Smoker", ["yes", "no"]))
bn.add(gum.LabelizedVariable("tub", "Tuberculosis", ["yes", "no"]))
bn.add(gum.LabelizedVariable("lung", "Lung cancer", ["yes", "no"]))
bn.add(gum.LabelizedVariable("bronc", "Bronchitis", ["yes", "no"]))
bn.add(gum.LabelizedVariable("either", "Tuberculosis or lung cancer", ["yes", "no"]))
bn.add(gum.LabelizedVariable("xray", "Positive X-ray", ["yes", "no"]))
bn.add(gum.LabelizedVariable("dysp", "Dyspnoea", ["yes", "no"]))
bn.addArc("asia", "tub")
bn.addArc("smoke", "lung")
bn.addArc("smoke", "bronc")
bn.addArc("tub", "either")
bn.addArc("lung", "either")
bn.addArc("either", "xray")
bn.addArc("bronc", "dysp")
bn.addArc("either", "dysp")
bn.cpt("asia").fillWith([0.01, 0.99])
bn.cpt("smoke").fillWith([0.5, 0.5])
bn.cpt("tub")[{"asia": "no"}] = [0.01, 0.99]
bn.cpt("tub")[{"asia": "yes"}] = [0.05, 0.95]
bn.cpt("lung")[{"smoke": "no"}] = [0.01, 0.99]
bn.cpt("lung")[{"smoke": "yes"}] = [0.1, 0.9]
bn.cpt("bronc")[{"smoke": "no"}] = [0.3, 0.7]
bn.cpt("bronc")[{"smoke": "yes"}] = [0.6, 0.4]
bn.cpt("either")[{"tub": "no", "lung": "no"}] = [0, 1]
bn.cpt("either")[{"tub": "no", "lung": "yes"}] = [1, 0]
bn.cpt("either")[{"tub": "yes", "lung": "no"}] = [1, 0]
bn.cpt("either")[{"tub": "yes", "lung": "yes"}] = [1, 0]
bn.cpt("xray")[{"either": "no"}] = [0.05, 0.95]
bn.cpt("xray")[{"either": "yes"}] = [0.98, 0.02]
bn.cpt("dysp")[{"bronc": "no", "either": "no"}] = [0.1, 0.9]
bn.cpt("dysp")[{"bronc": "no", "either": "yes"}] = [0.7, 0.3]
bn.cpt("dysp")[{"bronc": "yes", "either": "no"}] = [0.8, 0.2]
bn.cpt("dysp")[{"bronc": "yes", "either": "yes"}] = [0.9, 0.1]
# bn-editor-layout: {"asia":[160,80],"smoke":[480,80],"tub":[160,200],"lung":[380,200],"bronc":[580,200],"either":[270,320],"xray":[170,440],"dysp":[480,440]}
`;

  // Explaining away: observe late for work = yes, then rain = yes, and overslept drops back down.
  const LATE_FOR_WORK = `import pyagrum as gum

bn = gum.BayesNet("Late for work")
for name in ["stayed up late", "rain", "overslept", "traffic jam", "late for work", "missed meeting", "boss annoyed"]:
    bn.add(gum.LabelizedVariable(name, "", ["yes", "no"]))
bn.addArc("stayed up late", "overslept")
bn.addArc("rain", "traffic jam")
bn.addArc("overslept", "late for work")
bn.addArc("traffic jam", "late for work")
bn.addArc("late for work", "missed meeting")
bn.addArc("missed meeting", "boss annoyed")
bn.cpt("stayed up late").fillWith([0.3, 0.7])
bn.cpt("rain").fillWith([0.3, 0.7])
bn.cpt("overslept")[{"stayed up late": "yes"}] = [0.4, 0.6]
bn.cpt("overslept")[{"stayed up late": "no"}] = [0.05, 0.95]
bn.cpt("traffic jam")[{"rain": "yes"}] = [0.8, 0.2]
bn.cpt("traffic jam")[{"rain": "no"}] = [0.1, 0.9]
bn.cpt("late for work")[{"overslept": "yes", "traffic jam": "yes"}] = [0.95, 0.05]
bn.cpt("late for work")[{"overslept": "yes", "traffic jam": "no"}] = [0.7, 0.3]
bn.cpt("late for work")[{"overslept": "no", "traffic jam": "yes"}] = [0.7, 0.3]
bn.cpt("late for work")[{"overslept": "no", "traffic jam": "no"}] = [0.03, 0.97]
bn.cpt("missed meeting")[{"late for work": "yes"}] = [0.5, 0.5]
bn.cpt("missed meeting")[{"late for work": "no"}] = [0.02, 0.98]
bn.cpt("boss annoyed")[{"missed meeting": "yes"}] = [0.7, 0.3]
bn.cpt("boss annoyed")[{"missed meeting": "no"}] = [0.1, 0.9]
# bn-editor-layout: {"stayed up late":[160,80],"rain":[460,80],"overslept":[160,200],"traffic jam":[460,200],"late for work":[310,320],"missed meeting":[310,440],"boss annoyed":[310,560]}
`;

  // Narrowing down a cause: observe drooping = yes (too much and too little water both become
  // likelier), then soil feels wet = yes (too much water, and root rot becomes likely). Winter makes
  // overwatering and dim light likelier; a pot with no drainage hole makes root rot likelier.
  // Yellow leaves plus dim light shows explaining away: the dim light accounts for the yellowing.
  const HOUSEPLANT = `import pyagrum as gum

bn = gum.BayesNet("Dying houseplant")
yn = ["yes", "no"]
bn.add(gum.LabelizedVariable("winter", "", yn))
bn.add(gum.LabelizedVariable("drainage hole", "Does the pot have a drainage hole?", yn))
bn.add(gum.LabelizedVariable("light", "How much light the plant gets", ["bright", "dim"]))
bn.add(gum.LabelizedVariable("watering", "How much the plant is watered for this time of year", ["too much", "about right", "too little"]))
bn.add(gum.LabelizedVariable("soil feels wet", "", yn))
bn.add(gum.LabelizedVariable("root rot", "", yn))
bn.add(gum.LabelizedVariable("drooping", "", yn))
bn.add(gum.LabelizedVariable("yellow leaves", "", yn))
for a, b in [("winter", "light"), ("winter", "watering"), ("watering", "soil feels wet"), ("drainage hole", "soil feels wet"),
             ("watering", "root rot"), ("drainage hole", "root rot"), ("watering", "drooping"), ("root rot", "drooping"),
             ("root rot", "yellow leaves"), ("light", "yellow leaves")]:
    bn.addArc(a, b)
bn.cpt("winter").fillWith([0.25, 0.75])
bn.cpt("drainage hole").fillWith([0.8, 0.2])
bn.cpt("light")[{"winter": "yes"}] = [0.4, 0.6]
bn.cpt("light")[{"winter": "no"}] = [0.75, 0.25]
bn.cpt("watering")[{"winter": "yes"}] = [0.4, 0.5, 0.1]
bn.cpt("watering")[{"winter": "no"}] = [0.2, 0.6, 0.2]
bn.cpt("soil feels wet")[{"watering": "too much", "drainage hole": "yes"}] = [0.85, 0.15]
bn.cpt("soil feels wet")[{"watering": "too much", "drainage hole": "no"}] = [0.97, 0.03]
bn.cpt("soil feels wet")[{"watering": "about right", "drainage hole": "yes"}] = [0.3, 0.7]
bn.cpt("soil feels wet")[{"watering": "about right", "drainage hole": "no"}] = [0.6, 0.4]
bn.cpt("soil feels wet")[{"watering": "too little", "drainage hole": "yes"}] = [0.02, 0.98]
bn.cpt("soil feels wet")[{"watering": "too little", "drainage hole": "no"}] = [0.05, 0.95]
bn.cpt("root rot")[{"watering": "too much", "drainage hole": "yes"}] = [0.3, 0.7]
bn.cpt("root rot")[{"watering": "too much", "drainage hole": "no"}] = [0.6, 0.4]
bn.cpt("root rot")[{"watering": "about right", "drainage hole": "yes"}] = [0.02, 0.98]
bn.cpt("root rot")[{"watering": "about right", "drainage hole": "no"}] = [0.1, 0.9]
bn.cpt("root rot")[{"watering": "too little", "drainage hole": "yes"}] = [0.01, 0.99]
bn.cpt("root rot")[{"watering": "too little", "drainage hole": "no"}] = [0.01, 0.99]
bn.cpt("drooping")[{"watering": "too much", "root rot": "yes"}] = [0.85, 0.15]
bn.cpt("drooping")[{"watering": "too much", "root rot": "no"}] = [0.3, 0.7]
bn.cpt("drooping")[{"watering": "about right", "root rot": "yes"}] = [0.85, 0.15]
bn.cpt("drooping")[{"watering": "about right", "root rot": "no"}] = [0.05, 0.95]
bn.cpt("drooping")[{"watering": "too little", "root rot": "yes"}] = [0.95, 0.05]
bn.cpt("drooping")[{"watering": "too little", "root rot": "no"}] = [0.8, 0.2]
bn.cpt("yellow leaves")[{"root rot": "yes", "light": "bright"}] = [0.7, 0.3]
bn.cpt("yellow leaves")[{"root rot": "yes", "light": "dim"}] = [0.8, 0.2]
bn.cpt("yellow leaves")[{"root rot": "no", "light": "bright"}] = [0.05, 0.95]
bn.cpt("yellow leaves")[{"root rot": "no", "light": "dim"}] = [0.35, 0.65]
# bn-editor-layout: {"winter":[440,60],"watering":[240,190],"light":[800,190],"soil feels wet":[440,300],"drainage hole":[640,300],"root rot":[440,440],"drooping":[240,560],"yellow leaves":[640,560]}
`;

  // The host never opens your door or the car's door. Set your choice and host opens as evidence:
  // switching wins 2/3 of the time.
  const MONTY_HALL = `import pyagrum as gum

doors = ["door 1", "door 2", "door 3"]
bn = gum.BayesNet("Monty Hall")
bn.add(gum.LabelizedVariable("your choice", "The door you pick first", doors))
bn.add(gum.LabelizedVariable("car", "Where the car is", doors))
bn.add(gum.LabelizedVariable("host opens", "The door the host opens", doors))
bn.addArc("your choice", "host opens")
bn.addArc("car", "host opens")
bn.cpt("your choice").fillWith([1 / 3, 1 / 3, 1 / 3])
bn.cpt("car").fillWith([1 / 3, 1 / 3, 1 / 3])
for choice in doors:
    for car in doors:
        options = [d for d in doors if d != choice and d != car]
        bn.cpt("host opens")[{"your choice": choice, "car": car}] = [1 / len(options) if d in options else 0 for d in doors]
# bn-editor-layout: {"your choice":[180,90],"car":[460,90],"host opens":[320,240]}
`;

  // One variable of each pyAgrum type; CPTs are random, as with gum.fastBN.
  const VARIABLE_TYPES = `import pyagrum as gum

bn = gum.fastBN("season{winter|spring|summer|autumn}->temperature[-10,0,10,20,35]->ice creams[0,4]<-visitors{0|10|50|100};season->visitors")
`;

  // A random DAG: each node gets up to three parents among the earlier nodes.
  function randomNetwork(count = 12) {
    const net = M.createNetwork("Random");
    const labelSets = [["yes", "no"], ["low", "medium", "high"], ["a", "b", "c", "d"], ["on", "off"]];
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

  // The first demo is what a first-time visitor sees.
  globalThis.BNDemos = [
    { id: "houseplant", label: "Dying houseplant", detail: "8 variables; observe drooping, then wet soil", build: fromCode(HOUSEPLANT) },
    { id: "wet-grass", label: "Wet grass", detail: "4 binary variables", build: fromCode(WET_GRASS) },
    { id: "asia", label: "Asia (chest clinic)", detail: "8 variables, classic textbook network", build: fromCode(ASIA) },
    { id: "late-for-work", label: "Late for work", detail: "7 variables; observe being late, then rain", build: fromCode(LATE_FOR_WORK) },
    { id: "monty-hall", label: "Monty Hall", detail: "3 variables; observe your door and the opened one", build: fromCode(MONTY_HALL) },
    { id: "types", label: "All variable types", detail: "labelized, range, integer, discretized", build: fromCode(VARIABLE_TYPES) },
    { id: "random", label: "Random network", detail: "12 variables, random arcs and CPTs", build: () => randomNetwork() },
  ];
})();
