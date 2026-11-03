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
bn.add(gum.LabelizedVariable("wet_grass", "", ["yes", "no"]))
bn.addArc("cloudy", "sprinkler")
bn.addArc("cloudy", "rain")
bn.addArc("sprinkler", "wet_grass")
bn.addArc("rain", "wet_grass")
bn.cpt("cloudy").fillWith([0.5, 0.5])
bn.cpt("sprinkler")[{"cloudy": "no"}] = [0.5, 0.5]
bn.cpt("sprinkler")[{"cloudy": "yes"}] = [0.1, 0.9]
bn.cpt("rain")[{"cloudy": "no"}] = [0.2, 0.8]
bn.cpt("rain")[{"cloudy": "yes"}] = [0.8, 0.2]
bn.cpt("wet_grass")[{"sprinkler": "off", "rain": "no"}] = [0, 1]
bn.cpt("wet_grass")[{"sprinkler": "off", "rain": "yes"}] = [0.9, 0.1]
bn.cpt("wet_grass")[{"sprinkler": "on", "rain": "no"}] = [0.9, 0.1]
bn.cpt("wet_grass")[{"sprinkler": "on", "rain": "yes"}] = [0.99, 0.01]
# bn-editor-layout: {"cloudy":[300,80],"sprinkler":[160,200],"rain":[440,200],"wet_grass":[300,320]}
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

  // Explaining away: observe late_for_work = yes, then rain = yes, and overslept drops back down.
  const LATE_FOR_WORK = `import pyagrum as gum

bn = gum.BayesNet("Late for work")
for name in ["stayed_up_late", "rain", "overslept", "traffic_jam", "late_for_work", "missed_meeting", "boss_annoyed"]:
    bn.add(gum.LabelizedVariable(name, "", ["yes", "no"]))
bn.addArc("stayed_up_late", "overslept")
bn.addArc("rain", "traffic_jam")
bn.addArc("overslept", "late_for_work")
bn.addArc("traffic_jam", "late_for_work")
bn.addArc("late_for_work", "missed_meeting")
bn.addArc("missed_meeting", "boss_annoyed")
bn.cpt("stayed_up_late").fillWith([0.3, 0.7])
bn.cpt("rain").fillWith([0.3, 0.7])
bn.cpt("overslept")[{"stayed_up_late": "yes"}] = [0.4, 0.6]
bn.cpt("overslept")[{"stayed_up_late": "no"}] = [0.05, 0.95]
bn.cpt("traffic_jam")[{"rain": "yes"}] = [0.8, 0.2]
bn.cpt("traffic_jam")[{"rain": "no"}] = [0.1, 0.9]
bn.cpt("late_for_work")[{"overslept": "yes", "traffic_jam": "yes"}] = [0.95, 0.05]
bn.cpt("late_for_work")[{"overslept": "yes", "traffic_jam": "no"}] = [0.7, 0.3]
bn.cpt("late_for_work")[{"overslept": "no", "traffic_jam": "yes"}] = [0.7, 0.3]
bn.cpt("late_for_work")[{"overslept": "no", "traffic_jam": "no"}] = [0.03, 0.97]
bn.cpt("missed_meeting")[{"late_for_work": "yes"}] = [0.5, 0.5]
bn.cpt("missed_meeting")[{"late_for_work": "no"}] = [0.02, 0.98]
bn.cpt("boss_annoyed")[{"missed_meeting": "yes"}] = [0.7, 0.3]
bn.cpt("boss_annoyed")[{"missed_meeting": "no"}] = [0.1, 0.9]
# bn-editor-layout: {"stayed_up_late":[160,80],"rain":[460,80],"overslept":[160,200],"traffic_jam":[460,200],"late_for_work":[310,320],"missed_meeting":[310,440],"boss_annoyed":[310,560]}
`;

  // Gathering one more clue: observe drooping = yes (both watering problems become likelier),
  // then soil_wet = yes (overwatering is the culprit).
  const HOUSEPLANT = `import pyagrum as gum

bn = gum.BayesNet("Dying houseplant")
for name in ["overwatered", "underwatered", "too_little_light", "soil_wet", "drooping", "yellow_leaves"]:
    bn.add(gum.LabelizedVariable(name, "", ["yes", "no"]))
bn.addArc("overwatered", "soil_wet")
bn.addArc("underwatered", "soil_wet")
bn.addArc("overwatered", "drooping")
bn.addArc("underwatered", "drooping")
bn.addArc("overwatered", "yellow_leaves")
bn.addArc("too_little_light", "yellow_leaves")
bn.cpt("overwatered").fillWith([0.2, 0.8])
bn.cpt("underwatered").fillWith([0.2, 0.8])
bn.cpt("too_little_light").fillWith([0.25, 0.75])
bn.cpt("soil_wet")[{"overwatered": "yes", "underwatered": "yes"}] = [0.5, 0.5]
bn.cpt("soil_wet")[{"overwatered": "yes", "underwatered": "no"}] = [0.95, 0.05]
bn.cpt("soil_wet")[{"overwatered": "no", "underwatered": "yes"}] = [0.03, 0.97]
bn.cpt("soil_wet")[{"overwatered": "no", "underwatered": "no"}] = [0.4, 0.6]
bn.cpt("drooping")[{"overwatered": "yes", "underwatered": "yes"}] = [0.9, 0.1]
bn.cpt("drooping")[{"overwatered": "yes", "underwatered": "no"}] = [0.7, 0.3]
bn.cpt("drooping")[{"overwatered": "no", "underwatered": "yes"}] = [0.8, 0.2]
bn.cpt("drooping")[{"overwatered": "no", "underwatered": "no"}] = [0.05, 0.95]
bn.cpt("yellow_leaves")[{"overwatered": "yes", "too_little_light": "yes"}] = [0.85, 0.15]
bn.cpt("yellow_leaves")[{"overwatered": "yes", "too_little_light": "no"}] = [0.6, 0.4]
bn.cpt("yellow_leaves")[{"overwatered": "no", "too_little_light": "yes"}] = [0.5, 0.5]
bn.cpt("yellow_leaves")[{"overwatered": "no", "too_little_light": "no"}] = [0.05, 0.95]
# bn-editor-layout: {"underwatered":[60,80],"overwatered":[380,80],"too_little_light":[640,80],"soil_wet":[220,200],"drooping":[220,340],"yellow_leaves":[560,240]}
`;

  // The host never opens your door or the car's door. Set your_choice and host_opens as evidence:
  // switching wins 2/3 of the time.
  const MONTY_HALL = `import pyagrum as gum

doors = ["door 1", "door 2", "door 3"]
bn = gum.BayesNet("Monty Hall")
bn.add(gum.LabelizedVariable("your_choice", "The door you pick first", doors))
bn.add(gum.LabelizedVariable("car", "Where the car is", doors))
bn.add(gum.LabelizedVariable("host_opens", "The door the host opens", doors))
bn.addArc("your_choice", "host_opens")
bn.addArc("car", "host_opens")
bn.cpt("your_choice").fillWith([1 / 3, 1 / 3, 1 / 3])
bn.cpt("car").fillWith([1 / 3, 1 / 3, 1 / 3])
for choice in doors:
    for car in doors:
        options = [d for d in doors if d != choice and d != car]
        bn.cpt("host_opens")[{"your_choice": choice, "car": car}] = [1 / len(options) if d in options else 0 for d in doors]
# bn-editor-layout: {"your_choice":[180,90],"car":[460,90],"host_opens":[320,240]}
`;

  // One variable of each pyAgrum type; CPTs are random, as with gum.fastBN.
  const VARIABLE_TYPES = `import pyagrum as gum

bn = gum.fastBN("season{winter|spring|summer|autumn}->temperature[-10,0,10,20,35]->ice_creams[0,4]<-visitors{0|10|50|100};season->visitors")
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

  globalThis.BNDemos = [
    { id: "wet-grass", label: "Wet grass", detail: "4 binary variables", build: fromCode(WET_GRASS) },
    { id: "asia", label: "Asia (chest clinic)", detail: "8 variables, classic textbook network", build: fromCode(ASIA) },
    { id: "late-for-work", label: "Late for work", detail: "7 variables; observe being late, then rain", build: fromCode(LATE_FOR_WORK) },
    { id: "houseplant", label: "Dying houseplant", detail: "6 variables; observe drooping, then wet soil", build: fromCode(HOUSEPLANT) },
    { id: "monty-hall", label: "Monty Hall", detail: "3 variables; observe your door and the opened one", build: fromCode(MONTY_HALL) },
    { id: "types", label: "All variable types", detail: "labelized, range, integer, discretized", build: fromCode(VARIABLE_TYPES) },
    { id: "random", label: "Random network", detail: "12 variables, random arcs and CPTs", build: () => randomNetwork() },
  ];
})();
