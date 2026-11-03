// Export a network to pyAgrum Python code, and import (a practical subset of) pyAgrum code.
(function () {
  "use strict";
  const M = globalThis.BNModel;
  const LAYOUT_TAG = "# bn-editor-layout:";
  const EVIDENCE_TAG = "# bn-editor-evidence:";

  // ---------------------------------------------------------------- export

  const py = (s) => JSON.stringify(String(s));
  const num = (x) => M.fmtNum(x);
  const list = (xs, f) => "[" + xs.map(f).join(", ") + "]";

  function variableCode(n) {
    switch (n.type) {
      case "range": return `gum.RangeVariable(${py(n.name)}, ${py(n.description)}, ${n.min}, ${n.max})`;
      case "integer": return `gum.IntegerVariable(${py(n.name)}, ${py(n.description)}, ${list(n.values, num)})`;
      case "discretized": return `gum.DiscretizedVariable(${py(n.name)}, ${py(n.description)}, ${list(n.ticks, num)})`;
      default: return `gum.LabelizedVariable(${py(n.name)}, ${py(n.description)}, ${list(n.labels, py)})`;
    }
  }

  // evidence: node id -> state index (hard), likelihoods (soft), or {target: probabilities}.
  function exportPython(net, evidence = new Map()) {
    const out = ["import pyagrum as gum", "", `bn = gum.BayesNet(${py(net.name)})`, ""];
    for (const n of net.nodes) out.push(`bn.add(${variableCode(n)})`);
    if (net.arcs.length) out.push("");
    for (const a of net.arcs) out.push(`bn.addArc(${py(M.getNode(net, a.from).name)}, ${py(M.getNode(net, a.to).name)})`);
    for (const n of net.nodes) {
      out.push("");
      const { parents, rows } = M.cptRows(net, n.id);
      const c = n.labels.length;
      const probs = (o) => list(n.cpt.slice(o, o + c), num);
      if (!parents.length) {
        out.push(`bn.cpt(${py(n.name)}).fillWith(${probs(0)})`);
        continue;
      }
      for (const r of rows) {
        const key = parents.map((p, k) => `${py(p.name)}: ${py(p.labels[r.idx[k]])}`).join(", ");
        out.push(`bn.cpt(${py(n.name)})[{${key}}] = ${probs(r.offset)}`);
      }
    }
    const layout = {};
    for (const n of net.nodes) layout[n.name] = [Math.round(n.x), Math.round(n.y)];
    out.push("", "# Node positions for the visual editor (ignored by pyAgrum).", LAYOUT_TAG + " " + JSON.stringify(layout));
    if (evidence.size) out.push("", ...evidenceCode(net, evidence));
    out.push("");
    return out.join("\n");
  }

  // The evidence twice: as pyAgrum calls that reproduce the editor's probabilities, and as a comment
  // the importer reads back exactly. pyAgrum's setEvidence takes a state or likelihoods; probabilities
  // set directly (Jeffrey's rule) become the likelihoods that give them, given the other evidence.
  function evidenceCode(net, evidence) {
    const saved = {}, calls = [], notes = [];
    const targets = [...evidence].some(([, v]) => v && v.target);
    const solved = targets && globalThis.BNInference ? globalThis.BNInference.posteriors(net, evidence) : null;
    for (const [id, v] of evidence) {
      const n = M.getNode(net, id);
      if (v && v.target) {
        saved[n.name] = { target: v.target };
        const lik = solved && solved.likelihoods && solved.likelihoods.get(id);
        if (lik) {
          calls.push(`${py(n.name)}: ${list(lik, (x) => num(+x.toPrecision(12)))}`);
          notes.push(`# ${n.name}: probabilities set to ${list(v.target, (x) => num(+x.toPrecision(6)))} in the editor; these likelihoods give them.`);
        }
      } else {
        saved[n.name] = Array.isArray(v) ? v : n.labels[v];
        calls.push(`${py(n.name)}: ${Array.isArray(v) ? list(v, num) : py(n.labels[v])}`);
      }
    }
    const out = ["# Evidence set in the editor. With it, pyAgrum computes the probabilities the editor shows."];
    // Skip the calls when the probabilities can't be reached: setEvidence would then apply only part of the evidence.
    if (calls.length && !(targets && !(solved && solved.likelihoods))) out.push(...notes, "ie = gum.LazyPropagation(bn)", `ie.setEvidence({${calls.join(", ")}})`, "ie.makeInference()");
    out.push(EVIDENCE_TAG + " " + JSON.stringify(saved));
    return out;
  }

  // ---------------------------------------------------------------- import

  // Import runs the script in MiniPy (js/python.js), a sandboxed Python interpreter written in
  // JavaScript, with the pyAgrum objects below standing in for the real library.
  const Py = globalThis.MiniPy;
  const { PyError, HostObject, Opaque, Builtin, NdArray, PyDict, Slice, tuple, isTuple, flatten, iterate, toNumber } = Py;
  const fn = (name, f) => new Builtin(name, f);

  // Other model kinds pyAgrum offers; the editor only handles Bayesian networks.
  const OTHER_MODELS = {
    InfluenceDiagram: "influence diagrams", fastID: "influence diagrams", MarkovRandomField: "Markov random fields",
    fastMRF: "Markov random fields", MarkovNet: "Markov networks", fastMN: "Markov networks", CredalNet: "credal networks",
    BNMixture: "BN mixtures", CLG: "CLG models", CTBN: "CTBNs",
  };

  // options.pick: which network to import when the script builds several (an index into the
  // returned `networks`); by default the largest.
  function importPython(src, options = {}) {
    const warnings = [];
    let modelChanged = false, randomCpts = false;
    let lineLabel = (l) => `Line ${l}`;
    const nb = notebookCode(src);
    if (nb) { src = nb.code; lineLabel = nb.label; }
    // IPython magics and shell escapes (%matplotlib, !pip ...) are never valid Python
    src = src.replace(/^[ \t]*[%!].*$/gm, "");

    const bns = [];
    const numerical = new WeakSet(); // NumericalDiscreteVariable nodes, stored as labelized
    const untouched = new Set(); // nodes whose CPT is still fastBN's random one
    const otherModels = new Set();
    // Aggregator and noisy-gate nodes (bn.addMAX, bn.addNoisyOR, ...). pyAgrum computes their CPT
    // from the parents; the importer does the same once the script has run.
    const generated = new WeakMap(); // node -> {kind, value, weights: Map(parent id -> weight)}
    const warnOnce = new Set();

    const varStr = (s) => {
      const kind = { labelized: "Labelized", range: "Range", integer: "Integer", discretized: "Discretized" }[s.type];
      if (s.type === "range") return `${s.name}:Range([${s.min},${s.max}])`;
      return `${s.name}:${s.numerical ? "NumericalDiscrete" : kind}({${s.labels.join("|")}})`;
    };

    // A variable not (yet) in a network: gum.LabelizedVariable(...) etc. Adding it copies it.
    class VarHost extends HostObject {
      constructor(spec) { super(); this.spec = spec; }
      get typeName() { return "DiscreteVariable"; }
      str() { return varStr(this.spec); }
      getattr(name) {
        const s = this.spec;
        const relabel = () => { if (s.type !== "labelized") s.labels = M.labelsFor(s); };
        switch (name) {
          case "addLabel":
            return fn(name, ([l]) => { if (s.type !== "labelized") throw new PyError(`${s.name} is not a LabelizedVariable`); s.labels.push(String(l)); return this; });
          case "changeLabel":
            return fn(name, ([i, l]) => { if (s.type !== "labelized") throw new PyError(`${s.name} is not a LabelizedVariable`); s.labels[toNumber(i)] = String(l); return null; });
          case "addTick":
            return fn(name, ([t]) => { s.ticks.push(toNumber(t)); s.ticks.sort((a, b) => a - b); relabel(); return this; });
          case "addValue":
            return fn(name, ([v]) => {
              if (s.numerical) { s.labels.push(M.fmtNum(toNumber(v))); s.labels.sort((a, b) => a - b); }
              else { s.values.push(toNumber(v)); s.values.sort((a, b) => a - b); relabel(); }
              return this;
            });
          case "setDescription": return fn(name, ([d]) => { s.description = String(d); return null; });
          case "setName": return fn(name, ([n]) => { s.name = String(n); return null; });
        }
        return readVar(s, name);
      }
    }

    // bn.variable(...), bn["name"]: a read-only view of a variable in a network, like pyAgrum's.
    class VarView extends HostObject {
      constructor(bn, node) { super(); this.bn = bn; this.node = node; }
      get typeName() { return "DiscreteVariable"; }
      get spec() { return Object.assign({ numerical: numerical.has(this.node) }, this.node); }
      str() { return varStr(this.spec); }
      getattr(name) {
        if (["addLabel", "changeLabel", "addTick", "addValue", "setName"].includes(name)) {
          throw new PyError(`'DiscreteVariable' object has no attribute '${name}' (variables can't be changed once they are in a network; use bn.changeVariableLabel or bn.changeVariableName)`);
        }
        return readVar(this.node, name);
      }
    }

    function readVar(s, name) {
      switch (name) {
        case "name": return fn(name, () => s.name);
        case "description": return fn(name, () => s.description);
        case "labels": return fn(name, () => tuple(s.labels.slice()));
        case "label": return fn(name, ([i]) => s.labels[toNumber(i)]);
        case "domainSize": return fn(name, () => s.labels.length);
        case "index": case "posLabel": return fn(name, ([l]) => { const i = s.labels.indexOf(String(l)); if (i < 0) throw new PyError(`${JSON.stringify(l)} is not a state of ${s.name}`); return i; });
        case "numerical": return fn(name, ([i]) => numericValue(s, toNumber(i)));
        case "isLabel": return fn(name, ([l]) => s.labels.includes(String(l)));
        case "toStringWithDescription": return fn(name, () => varStr(s));
        case "varType": return fn(name, () => s.type);
        case "minVal": return fn(name, () => numericValue(s, 0));
        case "maxVal": return fn(name, () => numericValue(s, s.labels.length - 1));
        case "ticks": return fn(name, () => tuple((s.ticks || []).slice()));
        case "integerDomain": case "numericalDomain": return fn(name, () => tuple(s.labels.map((_, i) => numericValue(s, i))));
      }
      throw new PyError(`'DiscreteVariable' object has no attribute '${name}'`);
    }

    // The number pyAgrum associates with a state (used by fillFromFunction).
    function numericValue(s, i) {
      switch (s.type) {
        case "range": return s.min + i;
        case "integer": return s.values[i];
        case "discretized": return (s.ticks[i] + s.ticks[i + 1]) / 2;
      }
      return s.numerical || numerical.has(s) ? Number(s.labels[i]) : i;
    }

    function varSpec(type, args, kwargs) {
      const arg = (i, key, def) => (args[i] !== undefined ? args[i] : kwargs.has(key) ? kwargs.get(key) : def);
      const name = arg(0, "aName");
      if (typeof name !== "string") throw new PyError("Variable name must be a string");
      const spec = { name, description: String(arg(1, "aDesc", "")), type };
      if (type === "labelized") {
        const l = arg(2, "nbrLabel", 2);
        spec.labels = typeof l === "number" ? Array.from({ length: l }, (_, i) => String(i)) : iterate(l).map(String);
      } else if (type === "range") {
        spec.min = toNumber(arg(2, "minVal", 0)); spec.max = toNumber(arg(3, "maxVal", 1));
        checkStates(spec.max - spec.min + 1, name);
        spec.labels = M.labelsFor(spec);
      } else if (type === "integer") {
        spec.values = flatten(arg(2, "domain", [])).map(toNumber).sort((a, b) => a - b);
        spec.labels = M.labelsFor(spec);
      } else if (type === "numerical") {
        spec.type = "labelized";
        spec.numerical = true;
        spec.labels = flatten(arg(2, "domain", [])).map(toNumber).sort((a, b) => a - b).map(M.fmtNum);
      } else if (type === "discretized") {
        spec.ticks = flatten(arg(2, "ticks", [])).map(toNumber).sort((a, b) => a - b);
        spec.labels = M.labelsFor(spec);
      }
      return new VarHost(spec);
    }

    // fastBN / fastVariable node syntax: name, name[n], name[min,max], name[t1,t2,...],
    // name[min:max:n], name{a|b|c} (labels, integers or numbers).
    function fastSpec(txt, domainSize) {
      const m = /^\s*([^[{]*?)\s*(\{[^}]*\}|\[[^\]]*\])?\s*$/.exec(txt);
      if (!m || !m[1]) throw new PyError(`Cannot read the fastBN variable ${JSON.stringify(txt.trim())}`);
      const name = m[1], dom = m[2];
      let s = { name, description: name, type: "range", min: 0, max: domainSize - 1 };
      if (dom && dom[0] === "{") {
        const labels = dom.slice(1, -1).split("|").map((x) => x.trim());
        const isNum = (l) => l !== "" && Number.isFinite(Number(l));
        if (labels.every((l) => /^-?\d+$/.test(l))) s = { name, description: name, type: "integer", values: labels.map(Number).sort((a, b) => a - b) };
        else if (labels.every(isNum)) s = { name, description: name, type: "labelized", numerical: true, labels: labels.map(Number).sort((a, b) => a - b).map(M.fmtNum) };
        else s = { name, description: name, type: "labelized", labels };
      } else if (dom) {
        const body = dom.slice(1, -1);
        if (body.includes(":")) {
          const [a, b, n] = body.split(":").map((x) => Number(x.trim()));
          checkStates(n, name);
          s = { name, description: name, type: "discretized", ticks: Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n) };
        } else {
          const parts = body.split(",").map((x) => Number(x.trim()));
          if (parts.some((x) => !Number.isFinite(x))) throw new PyError(`Cannot read the fastBN domain ${dom}`);
          if (parts.length === 1) s.max = parts[0] - 1;
          else if (parts.length === 2 && parts.every(Number.isInteger)) { s.min = parts[0]; s.max = parts[1]; }
          else s = { name, description: name, type: "discretized", ticks: parts.sort((a, b) => a - b) };
        }
      }
      checkStates(s.type === "range" ? s.max - s.min + 1 : s.type === "discretized" ? s.ticks.length - 1 : (s.labels || s.values).length, name);
      s.labels = s.labels || M.labelsFor(s);
      return s;
    }

    function makeBN(name) {
      const bn = new BNHost(M.createNetwork(name), []);
      bns.push(bn);
      return bn;
    }

    class BNHost extends HostObject {
      constructor(net, pyIds) { super(); this.net = net; this.pyIds = pyIds; }
      get typeName() { return "BayesNet"; }
      str() { return `BN{nodes: ${this.net.nodes.length}, arcs: ${this.net.arcs.length}}`; }
      len() { return this.net.nodes.length; }
      iter() { return this.liveIds(); }
      liveIds() { return this.pyIds.map((x, i) => (x === null ? null : i)).filter((x) => x !== null); }
      node(v) {
        let node;
        if (typeof v === "number") node = this.pyIds[v] != null ? M.getNode(this.net, this.pyIds[v]) : null;
        else if (typeof v === "string") node = M.nodeByName(this.net, v);
        else if (v instanceof VarHost || v instanceof VarView) node = M.nodeByName(this.net, v.spec.name);
        if (!node) throw new PyError(`Unknown variable ${typeof v === "string" ? JSON.stringify(v) : Py.str(v)}`);
        return node;
      }
      pyId(node) { return this.pyIds.indexOf(node.id); }
      add(spec) {
        if (M.nodeByName(this.net, spec.name)) throw new PyError(`A variable named ${JSON.stringify(spec.name)} already exists`);
        if (!spec.labels.length) throw new PyError(`Variable ${JSON.stringify(spec.name)} has no states`);
        if (spec.labels.length > 1e5) throw new PyError(`Variable ${JSON.stringify(spec.name)} has too many states (${spec.labels.length})`);
        const node = M.addNode(this.net, spec);
        node.cpt.fill(0); // like pyAgrum, CPT cells start at 0 until the script fills them
        if (spec.numerical) numerical.add(node);
        this.pyIds.push(node.id);
        return this.pyIds.length - 1;
      }
      arc(a, b) {
        const child = this.node(b);
        checkCptSize(this.net, child, this.node(a));
        const empty = child.cpt.every((v) => v === 0);
        const err = M.addArc(this.net, this.node(a).id, child.id);
        if (err) throw new PyError(`${err} (${this.node(a).name} → ${child.name})`);
        if (empty) child.cpt.fill(0);
      }
      getitem(k) { return new VarView(this, this.node(k)); }
      contains(k) { try { this.node(k); return true; } catch { return false; } }
      getattr(name) {
        modelChanged = true;
        const net = this.net;
        const names = (ids) => ids.map((id) => M.getNode(net, id).name);
        switch (name) {
          case "add": return fn(name, ([v, n]) => {
            if (v instanceof VarHost || v instanceof VarView) return this.add(structuredClone(v.spec));
            if (typeof v === "string") {
              const spec = { name: v, description: v, type: "range", min: 0, max: (n ?? 2) - 1 };
              spec.labels = M.labelsFor(spec);
              return this.add(spec);
            }
            throw new PyError("bn.add() expects a variable or a name");
          });
          case "addVariables": return fn(name, ([specs, n = 2]) => tuple(iterate(specs).map((s) => this.add(fastSpec(s, n)))));
          case "addArc": return fn(name, ([a, b]) => { this.arc(a, b); return null; });
          case "addArcs": return fn(name, ([pairs]) => { for (const pr of iterate(pairs)) { const [a, b] = iterate(pr); this.arc(a, b); } return null; });
          case "eraseArc": return fn(name, ([a, b]) => { M.removeArc(net, this.node(a).id, this.node(b).id); return null; });
          case "reverseArc": return fn(name, ([a, b]) => { const err = M.reverseArcBayes(net, this.node(a).id, this.node(b).id); if (err) throw new PyError(err); return null; });
          case "erase": return fn(name, ([v]) => { const n = this.node(v); M.removeNode(net, n.id); this.pyIds[this.pyId(n)] = null; return null; });
          case "cpt": return fn(name, ([v]) => new PotHost(this, this.node(v)));
          case "idFromName": case "nodeId": return fn(name, ([v]) => this.pyId(this.node(v)));
          case "variable": case "variableFromName": return fn(name, ([v]) => new VarView(this, this.node(v)));
          case "names": return fn(name, () => new Py.PySet(net.nodes.map((n) => n.name)));
          case "nodes": return fn(name, () => new Py.PySet(this.liveIds()));
          case "arcs": return fn(name, () => new Py.PySet(net.arcs.map((a) => tuple([this.pyId(M.getNode(net, a.from)), this.pyId(M.getNode(net, a.to))]))));
          case "parents": return fn(name, ([v]) => new Py.PySet(M.parentsOf(net, this.node(v).id).map((id) => this.pyIds.indexOf(id))));
          case "children": return fn(name, ([v]) => new Py.PySet(M.childrenOf(net, this.node(v).id).map((id) => this.pyIds.indexOf(id))));
          case "parentNames": case "parentsNames": return fn(name, ([v]) => names(M.parentsOf(net, this.node(v).id)));
          case "childrenNames": return fn(name, ([v]) => names(M.childrenOf(net, this.node(v).id)));
          case "size": return fn(name, () => net.nodes.length);
          case "sizeArcs": return fn(name, () => net.arcs.length);
          case "empty": return fn(name, () => !net.nodes.length);
          case "exists": return fn(name, ([v]) => this.contains(v));
          case "existsArc": return fn(name, ([a, b]) => M.hasArc(net, this.node(a).id, this.node(b).id));
          case "topologicalOrder": return fn(name, () => topoOrder(net).map((id) => this.pyIds.indexOf(id)));
          case "changeVariableName": return fn(name, ([v, n]) => {
            const node = this.node(v);
            if (M.nodeByName(net, String(n)) && node.name !== String(n)) throw new PyError(`A variable named ${JSON.stringify(n)} already exists`);
            node.name = String(n);
            return null;
          });
          case "changeVariableLabel": return fn(name, ([v, oldL, newL]) => {
            const node = this.node(v);
            if (node.type !== "labelized") throw new PyError(`${node.name} is not a LabelizedVariable`);
            const i = node.labels.indexOf(String(oldL));
            if (i < 0) throw new PyError(`${JSON.stringify(oldL)} is not a state of ${node.name}`);
            node.labels[i] = String(newL);
            return null;
          });
          case "setProperty": return fn(name, ([k, v]) => { if (k === "name") net.name = String(v); return null; });
          case "property": return fn(name, ([k]) => (k === "name" ? net.name : ""));
          case "setName": return fn(name, ([n]) => { net.name = String(n); return null; });
          case "generateCPTs": return fn(name, () => { for (const n of net.nodes) { M.randomizeCpt(n); untouched.add(n); } return null; });
          case "generateCPT": return fn(name, ([v]) => { const n = this.node(v); M.randomizeCpt(n); untouched.add(n); return null; });
          case "beginTopologyTransformation": case "endTopologyTransformation": return fn(name, () => null);
          case "addMAX": case "addMIN": case "addSUM": case "addAMPLITUDE": case "addMEDIAN": case "addOR": case "addAND":
          case "addCOUNT": case "addEXISTS": case "addFORALL":
          case "addNoisyOR": case "addNoisyORNet": case "addNoisyORCompound": case "addNoisyAND": case "addLogit":
            return fn(name, ([v, value], kw) => {
              if (!(v instanceof VarHost)) throw new PyError(`${name}() expects a variable`);
              const kind = name.slice(3);
              const binary = ["OR", "AND", "EXISTS", "FORALL", "NoisyOR", "NoisyORNet", "NoisyORCompound", "NoisyAND", "Logit"].includes(kind);
              if (binary && v.spec.labels.length !== 2) throw new PyError(`${name}(): ${v.spec.name} must have exactly 2 states`);
              const id = this.add(structuredClone(v.spec));
              const param = value ?? kw.get("external_weight") ?? kw.get("value") ?? kw.get("externalWeight");
              generated.set(M.getNode(net, this.pyIds[id]), { kind, value: param ?? (/^(COUNT|EXISTS|FORALL)$/.test(kind) ? 1 : 0), weights: new Map() });
              return id;
            });
          case "addWeightedArc": return fn(name, ([a, b, w]) => {
            const gen = generated.get(this.node(b));
            if (!gen || !/^(Noisy|Logit)/.test(gen.kind)) throw new PyError(`addWeightedArc(): ${this.node(b).name} is not a noisy-OR, noisy-AND or logit node`);
            this.arc(a, b);
            gen.weights.set(this.node(a).id, toNumber(w));
            return null;
          });
          case "saveBIF": case "saveDSL": case "saveNET": case "saveUAI": case "saveO3PRM": case "saveBIFXML": case "loadBIF": case "loadDSL":
            return fn(name, () => null);
        }
        return new Opaque(`bn.${name}`);
      }
    }

    function topoOrder(net) {
      const seen = new Set(), out = [];
      const visit = (id) => { if (seen.has(id)) return; seen.add(id); for (const p of M.parentsOf(net, id)) visit(p); out.push(id); };
      net.nodes.forEach((n) => visit(n.id));
      return out;
    }

    // bn.cpt(...): a CPT, indexed like pyAgrum's Tensor.
    class PotHost extends HostObject {
      constructor(bn, node) { super(); this.bn = bn; this.node = node; }
      get typeName() { return "Tensor"; }
      vars() { return [this.node.id].concat(M.parentsOf(this.bn.net, this.node.id)).map((id) => M.getNode(this.bn.net, id)); }
      str() { return `<CPT of ${this.node.name}>`; }
      len() { return this.vars().at(-1).labels.length; }
      binop() { throw new PyError("Arithmetic on CPTs is not supported"); }
      touched() { untouched.delete(this.node); }

      // For each variable position, the selected state indices (null = all). Positions fixed by
      // an integer or a dict key are listed in sel.drop: like numpy, they don't appear in reads.
      select(key) {
        const vars = this.vars();
        const sel = vars.map(() => null);
        sel.drop = new Set();
        if (key instanceof PyDict) {
          for (const [k, v] of key.entries()) {
            const pos = vars.findIndex((n) => n.name === (k instanceof VarHost || k instanceof VarView ? k.spec.name : k));
            if (pos < 0) throw new PyError(`${JSON.stringify(k)} is not in the CPT of ${this.node.name}`);
            const n = vars[pos];
            const idx = typeof v === "number" ? v : n.labels.indexOf(String(v));
            if (!(idx >= 0 && idx < n.labels.length)) throw new PyError(`${JSON.stringify(v)} is not a state of ${n.name}`);
            sel[pos] = [idx];
            sel.drop.add(pos);
          }
          return sel;
        }
        // numpy-style: axis 0 is the last variable of the CPT
        const items = isTuple(key) ? key : [key];
        if (items.length > vars.length) throw new PyError(`Too many indices for the CPT of ${this.node.name}`);
        items.forEach((it, axis) => {
          const pos = vars.length - 1 - axis;
          const c = vars[pos].labels.length;
          if (it instanceof Slice) {
            if (it.lo === null && it.hi === null && it.step === null) return;
            const step = it.step === null ? 1 : it.step;
            const norm = (x, d) => (x === null ? d : x < 0 ? Math.max(0, x + c) : Math.min(x, c));
            const out = [];
            for (let i = norm(it.lo, 0); i < norm(it.hi, c); i += step) out.push(i);
            sel[pos] = out;
          } else if (typeof it === "number") {
            if (!Number.isInteger(it) || it >= c || it < -c) throw new PyError(`Index ${it} is out of range for ${vars[pos].name}`);
            sel[pos] = [it < 0 ? c + it : it];
            sel.drop.add(pos);
          } else if (it === null) {
            // np.newaxis: ignore
          } else throw new PyError(`Unsupported CPT index ${Py.str(it)}`);
        });
        return sel;
      }

      // Offsets of the selected cells, in aGrUM order (the CPT variable varies fastest), and the
      // shape of the selection in numpy order.
      cells(sel) {
        const vars = this.vars();
        const cards = vars.map((n) => n.labels.length);
        const st = M.strides(cards);
        const lists = sel.map((s, k) => s || Array.from({ length: cards[k] }, (_, i) => i));
        let offs = [0];
        for (let k = vars.length - 1; k >= 0; k--) {
          const next = [];
          for (const o of offs) for (const i of lists[k]) next.push(o + i * st[k]);
          offs = next;
        }
        const shape = [];
        for (let k = vars.length - 1; k >= 0; k--) if (!sel.drop?.has(k)) shape.push(lists[k].length);
        return { offs, shape };
      }

      assign(sel, value) {
        const { offs } = this.cells(sel);
        const vals = value instanceof PotHost ? value.node.cpt.slice() : flatten(value instanceof NdArray ? value.data : value);
        if (vals.some((v) => !(typeof v === "number" || typeof v === "boolean"))) throw new PyError(`CPT values must be numbers (got ${Py.typeName(vals.find((v) => typeof v !== "number"))})`);
        if (!vals.length || offs.length % vals.length) throw new PyError(`Cannot put ${vals.length} values into ${offs.length} cells of the CPT of ${this.node.name}`);
        offs.forEach((o, i) => { this.node.cpt[o] = +vals[i % vals.length]; });
        this.touched();
      }

      read(sel) {
        const { offs, shape } = this.cells(sel);
        const vals = offs.map((o) => this.node.cpt[o]);
        if (!shape.length) return vals[0];
        const build = (off, dims) => {
          if (!dims.length) return vals[off];
          const [n, ...rest] = dims;
          const size = rest.reduce((a, b) => a * b, 1);
          return Array.from({ length: n }, (_, i) => build(off + i * size, rest));
        };
        // offs are in aGrUM order (last numpy axis fastest), which is numpy C order
        return new NdArray(build(0, shape));
      }

      getitem(key) { return this.read(this.select(key)); }
      setitem(key, value) { modelChanged = true; this.assign(this.select(key), value); }

      fillFrom(other) {
        const mine = this.vars(), theirs = other.vars();
        const same = mine.length === theirs.length && mine.every((n) => theirs.some((t) => t.name === n.name && t.labels.length === n.labels.length));
        if (!same) {
          if (other.node.cpt.length !== this.node.cpt.length) throw new PyError(`The CPTs of ${this.node.name} and ${other.node.name} have different variables`);
          this.node.cpt = other.node.cpt.slice();
          return;
        }
        // match variables by name, as pyAgrum does
        const pos = mine.map((n) => theirs.findIndex((t) => t.name === n.name));
        const cards = mine.map((n) => n.labels.length);
        const stTheirs = M.strides(theirs.map((n) => n.labels.length));
        const out = new Array(this.node.cpt.length);
        for (let o = 0; o < out.length; o++) {
          let rem = o, src = 0;
          for (let k = 0; k < cards.length; k++) { const i = rem % cards[k]; rem = Math.floor(rem / cards[k]); src += i * stTheirs[pos[k]]; }
          out[o] = other.node.cpt[src];
        }
        this.node.cpt = out;
      }

      fillFromFunction(formula) {
        if (typeof formula !== "string") throw new PyError("fillFromFunction() needs a formula string");
        const f = Py.compileFormula(formula);
        const vars = this.vars(), node = this.node;
        const parents = vars.slice(1);
        const c = node.labels.length;
        const childVals = node.labels.map((_, i) => numericValue(node, i));
        const env = new Map();
        const cards = parents.map((n) => n.labels.length);
        const rows = cards.reduce((a, b) => a * b, 1);
        const cpt = new Array(c * rows).fill(0);
        for (let r = 0; r < rows; r++) {
          let rem = r;
          parents.forEach((p, k) => { const i = rem % cards[k]; rem = Math.floor(rem / cards[k]); env.set(p.name, numericValue(p, i)); });
          const v = toNumber(f(env));
          let best = 0;
          for (let s = 1; s < c; s++) if (Math.abs(childVals[s] - v) < Math.abs(childVals[best] - v)) best = s;
          cpt[r * c + best] = 1;
        }
        node.cpt = cpt;
      }

      getattr(name) {
        modelChanged = true;
        const node = this.node;
        switch (name) {
          case "fillWith": return fn(name, ([v]) => {
            if (typeof v === "number") node.cpt.fill(v);
            else if (v instanceof PotHost) this.fillFrom(v);
            else if (v instanceof Opaque) throw new PyError(`Filling the CPT of ${node.name} from ${v.name} (an inference result or tensor) is not supported`);
            else this.assign(this.vars().map(() => null), v);
            this.touched();
            return this;
          });
          case "fillFromFunction": return fn(name, ([formula]) => { this.fillFromFunction(formula); this.touched(); return this; });
          case "normalizeAsCPT": return fn(name, () => { M.normalizeCpt(node); return this; });
          case "normalize": return fn(name, () => { const s = node.cpt.reduce((a, b) => a + b, 0); if (s > 0) node.cpt = node.cpt.map((v) => v / s); return this; });
          case "translate": return fn(name, ([x]) => { node.cpt = node.cpt.map((v) => v + toNumber(x)); return this; });
          case "scale": return fn(name, ([x]) => { node.cpt = node.cpt.map((v) => v * toNumber(x)); return this; });
          case "abs": return fn(name, () => { node.cpt = node.cpt.map(Math.abs); return this; });
          case "sq": return fn(name, () => { node.cpt = node.cpt.map((v) => v * v); return this; });
          case "random": case "randomCPT": case "randomDistribution": return fn(name, () => { M.randomizeCpt(node); this.touched(); return this; });
          case "uniformCPT": return fn(name, () => { M.uniformizeCpt(node); this.touched(); return this; });
          case "noising": return fn(name, ([alpha]) => {
            const a = toNumber(alpha);
            node.cpt = node.cpt.map((v) => (1 - a) * v + a * Math.random());
            M.normalizeCpt(node);
            return this;
          });
          case "names": case "var_names": return tuple(this.vars().map((n) => n.name));
          case "variable": return fn(name, ([i]) => new VarView(this.bn, typeof i === "number" ? this.vars()[i] : this.bn.node(i)));
          case "variablesSequence": return fn(name, () => this.vars().map((n) => new VarView(this.bn, n)));
          case "nbrDim": return fn(name, () => this.vars().length);
          case "domainSize": return fn(name, () => node.cpt.length);
          case "tolist": return fn(name, () => { const r = this.read(this.vars().map(() => null)); return r instanceof NdArray ? structuredClone(r.data) : r; });
          case "toarray": return fn(name, () => this.read(this.vars().map(() => null)));
          case "sum": return fn(name, () => node.cpt.reduce((a, b) => a + b, 0));
          case "max": return fn(name, () => Math.max(...node.cpt));
          case "min": return fn(name, () => Math.min(...node.cpt));
          case "isNonZeroMap": case "putFirst": case "extract": case "margSumOut": case "margSumIn": case "sumOut": case "sumIn": case "reorganize":
            return fn(name, () => new Opaque(`Tensor.${name}()`));
        }
        throw new PyError(`'Tensor' object has no attribute '${name}' (not supported here)`);
      }
    }

    function fastBN(spec, domainSize) {
      const bn = makeBN("BN");
      const net = bn.net;
      const getVar = (txt) => {
        const s = fastSpec(txt, domainSize);
        const existing = M.nodeByName(net, s.name);
        if (existing) return existing;
        bn.add(s);
        return M.nodeByName(net, s.name);
      };
      for (const chain of String(spec).split(/[;\n]/)) {
        if (!chain.trim()) continue;
        const parts = chain.split(/(->|<-|--)/);
        let prev = getVar(parts[0]);
        for (let i = 1; i < parts.length; i += 2) {
          const next = getVar(parts[i + 1]);
          if (parts[i] === "--") throw new PyError("Undirected edges (--) are not allowed in a BayesNet");
          const [a, b] = parts[i] === "->" ? [prev, next] : [next, prev];
          if (!M.hasArc(net, a.id, b.id)) {
            checkCptSize(net, b, a);
            const err = M.addArc(net, a.id, b.id);
            if (err) throw new PyError(`${err} (${a.name} → ${b.name})`);
          }
          prev = next;
        }
      }
      for (const n of net.nodes) { M.randomizeCpt(n); untouched.add(n); }
      return bn;
    }

    const gumAttrs = new Map([
      ["BayesNet", fn("BayesNet", ([a], kw) => {
        if (a instanceof BNHost) {
          const copy = makeBN(a.net.name);
          copy.net = structuredClone(a.net);
          copy.pyIds = a.pyIds.slice();
          copy.net.nodes.forEach((n, i) => {
            const orig = a.net.nodes[i];
            if (numerical.has(orig)) numerical.add(n);
            if (untouched.has(orig)) untouched.add(n);
            if (generated.has(orig)) {
              const g = generated.get(orig);
              generated.set(n, Object.assign({}, g, { weights: new Map(g.weights) }));
            }
          });
          return copy;
        }
        return makeBN(a ?? kw.get("name") ?? "BN");
      })],
      ["LabelizedVariable", fn("LabelizedVariable", (a, kw) => varSpec("labelized", a, kw))],
      ["RangeVariable", fn("RangeVariable", (a, kw) => varSpec("range", a, kw))],
      ["IntegerVariable", fn("IntegerVariable", (a, kw) => varSpec("integer", a, kw))],
      ["NumericalDiscreteVariable", fn("NumericalDiscreteVariable", (a, kw) => varSpec("numerical", a, kw))],
      ["DiscretizedVariable", fn("DiscretizedVariable", (a, kw) => varSpec("discretized", a, kw))],
      ["fastBN", fn("fastBN", ([s, n], kw) => fastBN(s, n ?? kw.get("domain_size") ?? kw.get("domainSize") ?? 2))],
      ["fastVariable", fn("fastVariable", ([s, n], kw) => new VarHost(fastSpec(String(s), n ?? kw.get("domain_size") ?? 2)))],
      ["loadBN", fn("loadBN", ([f]) => { throw new PyError(`loadBN(${Py.repr(f)}): reading network files isn't possible here; build the network in code instead`); })],
    ]);
    for (const [k, what] of Object.entries(OTHER_MODELS)) {
      gumAttrs.set(k, fn(k, () => { otherModels.add(what); return new Opaque(k); }));
    }

    class GumModule extends HostObject {
      get typeName() { return "module"; }
      getattr(name) { return gumAttrs.has(name) ? gumAttrs.get(name) : new Opaque(`gum.${name}`); }
      exports() { return gumAttrs; }
      str() { return "<module 'pyagrum'>"; }
    }
    const gum = new GumModule();

    function resolveModule(name) {
      if (/^py[aA]grum\.lib(\.|$)/.test(name)) return undefined; // notebook helpers, plotting
      if (/^py[aA]grum(\.|$)/.test(name)) return gum; // pyagrum, pyagrum.causal_model, ...
      return undefined;
    }

    let result;
    try {
      result = Py.runScript(src, {
        resolveModule,
        // random values only matter when they reach the network, e.g. random CPT entries
        afterStatement: ({ usedRandom }) => { if (usedRandom && modelChanged) randomCpts = true; modelChanged = false; },
        onStatementError: (msg, line) => warnings.push(line ? `${lineLabel(line)}: ${msg.replace(/ on line \d+$/, "")}` : msg),
      });
    } catch (err) {
      if (!(err instanceof PyError)) throw err;
      return { net: null, warnings: [err.message], layout: null };
    }

    // From here on, `warnings` collects summary notes; per-line problems go after them and are capped.
    const lineWarnings = warnings.splice(0);
    const converted = [];
    for (const b of bns) {
      for (const n of b.net.nodes) {
        const gen = generated.get(n);
        if (!gen) continue;
        try { n.cpt = generatedCpt(b.net, n, gen, numericValue); converted.push(`${n.name} (${gen.kind})`); }
        catch (err) { if (!(err instanceof PyError)) throw err; lineWarnings.push(`${n.name}: ${err.message}`); }
      }
    }

    let layout = null, evidence = null;
    for (const c of result.comments) {
      const tag = [LAYOUT_TAG, EVIDENCE_TAG].find((t) => c.text.startsWith(t));
      if (!tag) continue;
      let value;
      try { value = JSON.parse(c.text.slice(tag.length)); } catch { lineWarnings.push(`${lineLabel(c.line)}: could not read the ${tag === LAYOUT_TAG ? "layout" : "evidence"} comment`); continue; }
      if (tag === LAYOUT_TAG) layout = value; else evidence = value;
    }

    for (const what of otherModels) warnings.unshift(`This script builds ${what}, which the editor doesn't support (only Bayesian networks)`);
    if (!bns.length) {
      const builds = (f) => /"name":"(BayesNet|fastBN)"/.test(JSON.stringify(f.body));
      const funcs = [...result.globals].filter(([, v]) => v instanceof Py.PyFunction).sort(([, a], [, b]) => builds(b) - builds(a)).map(([k]) => k + "()");
      warnings.push("No Bayesian network was found (expected gum.BayesNet(...) or gum.fastBN(...))" +
        (funcs.length ? `. The script only defines functions (${funcs.slice(0, 5).join(", ")}${funcs.length > 5 ? ", …" : ""}); add a line that calls the one that builds the network, e.g. bn = ${funcs[0].replace("()", "(...)")}` : ""));
      return { net: null, warnings: warnings.concat(capWarnings(lineWarnings)), layout, networks: [], picked: -1 };
    }
    const nonEmpty = bns.filter((b) => b.net.nodes.length);
    const candidates = nonEmpty.length ? nonEmpty : bns;
    const varName = (b) => [...result.globals].find(([, v]) => v === b)?.[0];
    const networks = candidates.map((b) => ({ label: varName(b) || b.net.name, nodes: b.net.nodes.length, arcs: b.net.arcs.length }));
    networks.forEach((n, i) => { if (networks.some((m, j) => j < i && m.label === n.label)) n.label += ` (${networks.slice(0, i + 1).filter((m) => m.label === n.label).length})`; });
    let picked = candidates.reduce((best, b, i) => (b.net.nodes.length > candidates[best].net.nodes.length ? i : best), 0);
    if (Number.isInteger(options.pick) && candidates[options.pick]) picked = options.pick;
    const bn = candidates[picked];
    const net = bn.net;
    const random = net.nodes.filter((n) => untouched.has(n));
    if (random.length) warnings.push(`${random.length === net.nodes.length ? "All CPTs were" : `The CPT${random.length > 1 ? "s" : ""} of ${nameList(random.map((n) => n.name))} ${random.length > 1 ? "were" : "was"}`} left random by fastBN, so ${random.length > 1 ? "they" : "it"} won't match pyAgrum's random values`);
    const kept = converted.filter((c) => net.nodes.some((n) => c.startsWith(n.name + " (")));
    if (kept.length) warnings.push(`Aggregator and noisy-gate nodes became plain CPTs: ${nameList(kept)}`);
    if (randomCpts) warnings.push("The script builds the network with random numbers, so the values differ from a run in Python");
    const unfilled = net.nodes.filter((n) => n.cpt.every((v) => v === 0));
    for (const n of unfilled) M.uniformizeCpt(n);
    if (unfilled.length) warnings.push(`The CPT${unfilled.length > 1 ? "s" : ""} of ${nameList(unfilled.map((n) => n.name))} ${unfilled.length > 1 ? "were" : "was"} never filled, so ${unfilled.length > 1 ? "they were" : "it was"} set to uniform`);
    for (const n of net.nodes) {
      const bad = M.badRows(n).length;
      if (bad) warnings.push(`CPT of ${n.name}: ${bad} of ${n.cpt.length / n.labels.length} rows do not sum to 1`);
    }
    if (layout && net.nodes.every((n) => Array.isArray(layout[n.name]))) {
      for (const n of net.nodes) [n.x, n.y] = layout[n.name];
    } else M.autoLayout(net);
    // evidence: node name -> state label, likelihoods or {target}, as saved by exportPython
    return { net, warnings: warnings.concat(capWarnings(lineWarnings)), layout, evidence, networks, picked };
  }

  function nameList(names, max = 8) {
    return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
  }

  // Keeps the warning list readable when a script has many unsupported lines.
  function capWarnings(warnings, max = 20) {
    if (warnings.length <= max) return warnings;
    return warnings.slice(0, max - 1).concat([`…and ${warnings.length - max + 1} more`]);
  }

  function checkStates(n, name) {
    if (!(n <= 1e5)) throw new PyError(`Variable ${JSON.stringify(name)} has too many states (${n})`);
  }

  // Refuses an arc that would make the child's CPT unreasonably large for the editor.
  function checkCptSize(net, child, parent) {
    const size = M.parentsOf(net, child.id).reduce((acc, id) => acc * M.card(net, id), child.labels.length * parent.labels.length);
    if (size > 5e6) throw new PyError(`The CPT of ${child.name} would have ${size.toLocaleString("en")} cells, which is too large`);
  }

  // The CPT of an aggregator or noisy-gate node, following pyAgrum's definitions. Aggregators work
  // on the parents' values and pick the child state whose value is nearest (clamped to the domain).
  function generatedCpt(net, node, gen, numericValue) {
    const parents = M.parentsOf(net, node.id).map((id) => M.getNode(net, id));
    const c = node.labels.length;
    const num = numericValue;
    const childVals = node.labels.map((_, i) => num(node, i));
    const nearest = (v) => { let best = 0; for (let s = 1; s < c; s++) if (Math.abs(childVals[s] - v) < Math.abs(childVals[best] - v)) best = s; return best; };
    const cards = parents.map((p) => p.labels.length);
    const rows = cards.reduce((a, b) => a * b, 1);
    if (rows * c > 5e6) throw new PyError("its CPT would be too large");
    const cpt = new Array(rows * c).fill(0);
    const val = gen.value;
    for (let r = 0; r < rows; r++) {
      let rem = r;
      const idx = cards.map((k) => { const i = rem % k; rem = Math.floor(rem / k); return i; });
      const vals = parents.map((p, k) => num(p, idx[k]));
      let p1 = null, state = null;
      switch (gen.kind) {
        case "MAX": state = nearest(vals.length ? Math.max(...vals) : 0); break;
        case "MIN": state = nearest(vals.length ? Math.min(...vals) : 0); break;
        case "SUM": state = nearest(vals.reduce((a, b) => a + b, 0)); break;
        case "AMPLITUDE": state = nearest(vals.length ? Math.max(...vals) - Math.min(...vals) : 0); break;
        case "MEDIAN": {
          const sv = vals.slice().sort((a, b) => a - b), m = sv.length >> 1;
          state = nearest(!sv.length ? 0 : sv.length % 2 ? sv[m] : (sv[m - 1] + sv[m]) / 2);
          break;
        }
        case "COUNT": state = nearest(vals.filter((v) => v === val).length); break;
        case "OR": state = vals.some((v) => v === 1) ? 1 : 0; break;
        case "AND": state = vals.length && vals.every((v) => v === 1) ? 1 : 0; break;
        case "EXISTS": state = vals.some((v) => v === val) ? 1 : 0; break;
        case "FORALL": state = vals.length && vals.every((v) => v === val) ? 1 : 0; break;
        case "NoisyOR": case "NoisyORCompound": case "NoisyORNet": {
          const leak = val;
          let p0 = 1 - leak;
          parents.forEach((p, k) => {
            if (idx[k] === 0) return;
            const w = gen.weights.has(p.id) ? gen.weights.get(p.id) : 1;
            if (gen.kind === "NoisyORNet") p0 *= 1 - w;
            else {
              if (w < leak) throw new PyError(`a causal weight (${w}) cannot be lower than the leak (${leak})`);
              p0 *= (1 - w) / (1 - leak);
            }
          });
          p1 = 1 - p0;
          break;
        }
        case "NoisyAND": {
          p1 = val;
          parents.forEach((p, k) => { const w = gen.weights.has(p.id) ? gen.weights.get(p.id) : 1; p1 *= idx[k] !== 0 ? w : 1 - w; });
          break;
        }
        case "Logit": {
          let z = val;
          parents.forEach((p, k) => { z += (gen.weights.has(p.id) ? gen.weights.get(p.id) : 0) * vals[k]; });
          p1 = 1 / (1 + Math.exp(-z));
          break;
        }
      }
      if (p1 !== null) { cpt[r * c] = 1 - p1; cpt[r * c + 1] = p1; }
      else cpt[r * c + state] = 1;
    }
    return cpt;
  }

  // Jupyter notebooks: returns their code cells as one script (shell and magic lines dropped) and
  // a function that turns a script line into "Cell N, line M".
  function notebookCode(src) {
    if (!/^\s*\{/.test(src)) return null;
    let nb;
    try { nb = JSON.parse(src); } catch { return null; }
    if (!nb || !Array.isArray(nb.cells)) return null;
    const lines = [], where = [];
    let cellNo = 0;
    for (const cell of nb.cells) {
      if (cell.cell_type !== "code") continue;
      cellNo++;
      const text = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
      text.split("\n").forEach((l, i) => {
        lines.push(/^\s*[%!]/.test(l) ? "" : l);
        where.push([cellNo, i + 1]);
      });
      lines.push("");
      where.push([cellNo, 0]);
    }
    return { code: lines.join("\n"), label: (l) => (where[l - 1] ? `Cell ${where[l - 1][0]}, line ${where[l - 1][1]}` : `Line ${l}`) };
  }

  globalThis.BNPyAgrum = { exportPython, importPython };
})();
