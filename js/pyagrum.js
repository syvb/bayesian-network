// Export a network to pyAgrum Python code, and import (a practical subset of) pyAgrum code.
(function () {
  "use strict";
  const M = globalThis.BNModel;
  const LAYOUT_TAG = "# bn-editor-layout:";

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

  function exportPython(net) {
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
    out.push("", "# Node positions for the visual editor (ignored by pyAgrum).", LAYOUT_TAG + " " + JSON.stringify(layout), "");
    return out.join("\n");
  }

  // ---------------------------------------------------------------- tokenizer

  class PyError extends Error {}

  function tokenize(src) {
    const toks = [];
    let i = 0, line = 1, depth = 0;
    const push = (type, value) => toks.push({ type, value, line });
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\n") {
        if (depth === 0 && toks.length && toks[toks.length - 1].type !== "nl") push("nl");
        line++; i++; continue;
      }
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f") { i++; continue; }
      if (ch === "\\" && src[i + 1] === "\n") { i += 2; line++; continue; }
      if (ch === "#") {
        const end = src.indexOf("\n", i);
        const text = src.slice(i, end < 0 ? src.length : end);
        push("comment", text);
        i = end < 0 ? src.length : end;
        continue;
      }
      if (ch === ";") { if (depth === 0) push("nl"); i++; continue; }
      const sm = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(src.slice(i, i + 5));
      if (sm && (sm[1] === "" || /^[A-Za-z]/.test(ch))) {
        const prefix = sm[1].toLowerCase(), q = sm[2];
        let j = i + sm[0].length, s = "";
        const raw = prefix.includes("r");
        for (;;) {
          if (j >= src.length) throw new PyError(`Unterminated string on line ${line}`);
          if (src.startsWith(q, j)) { j += q.length; break; }
          const c = src[j];
          if (c === "\n") { if (q.length === 1) throw new PyError(`Unterminated string on line ${line}`); line++; }
          if (c === "\\" && !raw) {
            const e = src[j + 1];
            const simple = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0", "\n": "" };
            if (e in simple) { s += simple[e]; j += 2; if (e === "\n") line++; continue; }
            if (e === "x") { s += String.fromCharCode(parseInt(src.substr(j + 2, 2), 16)); j += 4; continue; }
            if (e === "u") { s += String.fromCharCode(parseInt(src.substr(j + 2, 4), 16)); j += 6; continue; }
            if (e === "U") { s += String.fromCodePoint(parseInt(src.substr(j + 2, 8), 16)); j += 10; continue; }
            s += c; j++; continue;
          }
          s += c; j++;
        }
        push("str", s);
        i = j;
        continue;
      }
      const nm = /^(?:\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
      if (nm) { push("num", parseFloat(nm[0].replace(/_/g, ""))); i += nm[0].length; continue; }
      const id = /^[A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff]*/.exec(src.slice(i, i + 256));
      if (id) { push("name", id[0]); i += id[0].length; continue; }
      const op = /^(\*\*|\/\/|==|!=|<=|>=|->|:=|[-+*\/%()\[\]{},:.=<>@~&|^!])/.exec(src.slice(i, i + 2));
      if (op) {
        if ("([{".includes(op[0])) depth++;
        if (")]}".includes(op[0])) depth = Math.max(0, depth - 1);
        push("op", op[0]); i += op[0].length; continue;
      }
      throw new PyError(`Unexpected character ${JSON.stringify(ch)} on line ${line}`);
    }
    push("nl");
    return toks;
  }

  // ---------------------------------------------------------------- parser

  // Splits the token stream into statements; each is parsed on its own so one bad line does not
  // stop the import.
  function splitStatements(toks) {
    const stmts = [];
    let cur = [];
    for (const t of toks) {
      if (t.type === "comment") { stmts.push({ comment: t }); continue; }
      if (t.type === "nl") { if (cur.length) stmts.push({ toks: cur }); cur = []; continue; }
      cur.push(t);
    }
    return stmts;
  }

  function parseStatement(toks) {
    let p = 0;
    const peek = () => toks[p];
    const isOp = (v) => toks[p] && toks[p].type === "op" && toks[p].value === v;
    const expect = (v) => {
      if (!isOp(v)) throw new PyError(`Expected '${v}' on line ${(toks[p] || toks[p - 1]).line}`);
      p++;
    };

    function expr() {
      let left = term();
      while (isOp("+") || isOp("-")) { const op = toks[p++].value; left = { t: "bin", op, left, right: term() }; }
      return left;
    }
    function term() {
      let left = unary();
      while (isOp("*") || isOp("/")) { const op = toks[p++].value; left = { t: "bin", op, left, right: unary() }; }
      return left;
    }
    function unary() {
      if (isOp("-")) { p++; return { t: "neg", e: unary() }; }
      if (isOp("+")) { p++; return unary(); }
      return postfix();
    }
    function postfix() {
      let e = atom();
      for (;;) {
        if (isOp(".")) { p++; const n = toks[p++]; if (!n || n.type !== "name") throw new PyError("Expected attribute name"); e = { t: "attr", obj: e, name: n.value }; }
        else if (isOp("(")) {
          p++;
          const args = [], kwargs = {};
          while (!isOp(")")) {
            if (peek().type === "name" && toks[p + 1] && toks[p + 1].type === "op" && toks[p + 1].value === "=") {
              const k = toks[p].value; p += 2; kwargs[k] = expr();
            } else args.push(expr());
            if (!isOp(")")) expect(",");
          }
          p++;
          e = { t: "call", fn: e, args, kwargs };
        } else if (isOp("[")) {
          p++;
          const items = [];
          let tuple = false;
          while (!isOp("]")) {
            items.push(sliceItem());
            if (!isOp("]")) { expect(","); tuple = true; }
          }
          p++;
          e = { t: "index", obj: e, key: tuple || items.length !== 1 ? { t: "tuple", items } : items[0] };
        } else return e;
      }
    }
    function sliceItem() {
      if (isOp(":")) { p++; if (!isOp(",") && !isOp("]")) expr(); return { t: "slice" }; }
      const e = expr();
      if (isOp(":")) { p++; if (!isOp(",") && !isOp("]")) expr(); return { t: "slice", partial: true }; }
      return e;
    }
    function seq(close) {
      const items = [];
      let comma = false;
      while (!isOp(close)) {
        items.push(expr());
        if (!isOp(close)) { expect(","); comma = true; }
      }
      p++;
      return { items, comma };
    }
    function atom() {
      const t = toks[p++];
      if (!t) throw new PyError("Unexpected end of statement");
      if (t.type === "num") return { t: "lit", v: t.value };
      if (t.type === "str") {
        let s = t.value;
        while (peek() && peek().type === "str") s += toks[p++].value;
        return { t: "lit", v: s };
      }
      if (t.type === "name") {
        if (t.value === "True") return { t: "lit", v: true };
        if (t.value === "False") return { t: "lit", v: false };
        if (t.value === "None") return { t: "lit", v: null };
        return { t: "name", name: t.value, line: t.line };
      }
      if (t.type === "op" && t.value === "(") {
        const { items, comma } = seq(")");
        return comma || items.length !== 1 ? { t: "list", items } : items[0];
      }
      if (t.type === "op" && t.value === "[") {
        if (toks.some((x) => x.type === "name" && x.value === "for")) throw new PyError("List comprehensions are not supported");
        return { t: "list", items: seq("]").items };
      }
      if (t.type === "op" && t.value === "{") {
        const entries = [];
        while (!isOp("}")) {
          const k = expr();
          expect(":");
          entries.push([k, expr()]);
          if (!isOp("}")) expect(",");
        }
        p++;
        return { t: "dict", entries };
      }
      throw new PyError(`Unexpected '${t.value}' on line ${t.line}`);
    }

    const first = expr();
    let stmt;
    if (isOp("=")) {
      p++;
      const targets = [first];
      let value = expr();
      while (isOp("=")) { p++; targets.push(value); value = expr(); }
      stmt = { t: "assign", targets, value };
    } else stmt = { t: "expr", e: first };
    if (p < toks.length) throw new PyError(`Unsupported syntax near '${toks[p].value}' on line ${toks[p].line}`);
    return stmt;
  }

  // ---------------------------------------------------------------- evaluator

  const SKIP_KEYWORDS = new Set(["import", "from", "try", "except", "finally", "else", "pass", "print", "assert", "del", "raise", "return", "global", "nonlocal"]);
  const BLOCK_KEYWORDS = new Set(["if", "elif", "for", "while", "def", "class", "with", "lambda"]);

  function flatten(v, out = []) {
    if (Array.isArray(v)) for (const x of v) flatten(x, out);
    else out.push(v);
    return out;
  }

  function importPython(src) {
    const warnings = [];
    let layout = null;
    const bns = [];

    const module = { kind: "module" };
    const np = { kind: "np" };
    const env = new Map([["gum", module], ["pyagrum", module], ["pyAgrum", module], ["np", np], ["numpy", np]]);

    function makeBN(name) {
      const bn = { kind: "bn", net: M.createNetwork(name), pyIds: [] };
      bns.push(bn);
      return bn;
    }

    function nodeRef(bn, v) {
      let node;
      if (typeof v === "number") node = M.getNode(bn.net, bn.pyIds[v]);
      else if (typeof v === "string") node = M.nodeByName(bn.net, v);
      else if (v && v.kind === "var") node = M.nodeByName(bn.net, v.spec.name);
      if (!node) throw new PyError(`Unknown variable ${JSON.stringify(v && v.spec ? v.spec.name : v)}`);
      return node;
    }

    function addVar(bn, spec) {
      if (M.nodeByName(bn.net, spec.name)) throw new PyError(`Variable ${JSON.stringify(spec.name)} already exists`);
      if (!spec.labels || !spec.labels.length) throw new PyError(`Variable ${JSON.stringify(spec.name)} has no states`);
      const node = M.addNode(bn.net, spec);
      bn.pyIds.push(node.id);
      return bn.pyIds.length - 1;
    }

    function varSpec(type, args) {
      const [name, description = ""] = args;
      if (typeof name !== "string") throw new PyError("Variable name must be a string");
      const spec = { name, description: String(description), type };
      if (type === "labelized") {
        const l = args[2] === undefined ? 2 : args[2];
        spec.labels = Array.isArray(l) ? l.map(String) : Array.from({ length: l }, (_, i) => String(i));
      } else if (type === "range") {
        spec.min = args[2] ?? 0; spec.max = args[3] ?? 1;
        spec.labels = M.labelsFor(spec);
      } else if (type === "integer") {
        spec.values = (args[2] || []).map(Number).sort((a, b) => a - b);
        spec.labels = M.labelsFor(spec);
      } else if (type === "numerical") {
        spec.type = "labelized";
        spec.labels = (args[2] || []).map(Number).sort((a, b) => a - b).map(M.fmtNum);
      } else if (type === "discretized") {
        spec.ticks = (args[2] || []).map(Number).sort((a, b) => a - b);
        spec.labels = M.labelsFor(spec);
      }
      return { kind: "var", spec };
    }

    function refreshLabels(spec) {
      if (spec.type !== "labelized") spec.labels = M.labelsFor(spec);
    }

    // Assigns `value` to the CPT cells selected by `fixed` (a map from potential-variable position
    // to state index). Cells are visited in aGrUM order, which is also numpy's C order.
    function setCells(bn, node, fixed, value) {
      const vars = [node.id].concat(M.parentsOf(bn.net, node.id));
      const cards = vars.map((v) => M.card(bn.net, v));
      const st = M.strides(cards);
      const cells = [];
      for (let o = 0; o < node.cpt.length; o++) {
        if (vars.every((_, k) => !fixed.has(k) || Math.floor(o / st[k]) % cards[k] === fixed.get(k))) cells.push(o);
      }
      const vals = flatten(value).map(Number);
      if (!vals.length || cells.length % vals.length) throw new PyError(`Cannot assign ${vals.length} values to ${cells.length} CPT cells of ${node.name}`);
      cells.forEach((o, i) => { node.cpt[o] = vals[i % vals.length]; });
    }

    function potentialKey(bn, node, key) {
      const vars = [node.id].concat(M.parentsOf(bn.net, node.id));
      const fixed = new Map();
      if (key && key.kind === "dict") {
        for (const [k, v] of key.map) {
          const target = M.nodeByName(bn.net, k);
          const pos = target ? vars.indexOf(target.id) : -1;
          if (pos < 0) throw new PyError(`${JSON.stringify(k)} is not in the CPT of ${node.name}`);
          const idx = typeof v === "number" ? v : target.labels.indexOf(String(v));
          if (idx < 0 || idx >= target.labels.length) throw new PyError(`${JSON.stringify(v)} is not a state of ${k}`);
          fixed.set(pos, idx);
        }
      } else if (key && key.kind === "slice") {
        if (key.partial) throw new PyError("Partial slices are not supported");
      } else {
        // numpy-style indexing: axis 0 is the last variable of the potential
        const items = Array.isArray(key) ? key : [key];
        items.forEach((it, axis) => {
          if (it && it.kind === "slice") { if (it.partial) throw new PyError("Partial slices are not supported"); return; }
          if (typeof it !== "number") throw new PyError("Unsupported CPT index");
          const pos = vars.length - 1 - axis;
          fixed.set(pos, it < 0 ? M.card(bn.net, vars[pos]) + it : it);
        });
      }
      return fixed;
    }

    function callMethod(obj, name, args, kwargs) {
      if (obj === module) {
        switch (name) {
          case "BayesNet": return makeBN(args[0] ?? kwargs.name ?? "BN");
          case "LabelizedVariable": return varSpec("labelized", args);
          case "RangeVariable": return varSpec("range", args);
          case "IntegerVariable": return varSpec("integer", args);
          case "NumericalDiscreteVariable": return varSpec("numerical", args);
          case "DiscretizedVariable": return varSpec("discretized", args);
          case "fastBN": return fastBN(args[0], args[1] ?? kwargs.domain_size ?? 2);
        }
      }
      if (obj === np && (name === "array" || name === "asarray")) return args[0];
      if (obj && obj.kind === "var") {
        if (name === "addLabel") { obj.spec.labels.push(String(args[0])); return obj; }
        if (name === "addTick") { obj.spec.ticks.push(Number(args[0])); obj.spec.ticks.sort((a, b) => a - b); refreshLabels(obj.spec); return obj; }
        if (name === "addValue") { obj.spec.values.push(Number(args[0])); obj.spec.values.sort((a, b) => a - b); refreshLabels(obj.spec); return obj; }
        if (name === "setDescription") { obj.spec.description = String(args[0]); return null; }
        if (name === "name") return obj.spec.name;
        if (name === "labels") return obj.spec.labels.slice();
      }
      if (obj && obj.kind === "bn") {
        const net = obj.net;
        switch (name) {
          case "add":
            if (args[0] && args[0].kind === "var") return addVar(obj, structuredClone(args[0].spec));
            if (typeof args[0] === "string") {
              const n = args[1] ?? 2;
              return addVar(obj, { name: args[0], description: args[0], type: "range", min: 0, max: n - 1 });
            }
            throw new PyError("Unsupported bn.add arguments");
          case "addArc": case "addArcs": {
            const pairs = name === "addArc" ? [args] : args[0];
            for (const [a, b] of pairs) {
              const err = M.addArc(net, nodeRef(obj, a).id, nodeRef(obj, b).id);
              if (err) throw new PyError(err);
            }
            return null;
          }
          case "eraseArc": M.removeArc(net, nodeRef(obj, args[0]).id, nodeRef(obj, args[1]).id); return null;
          case "reverseArc": { const err = M.reverseArc(net, nodeRef(obj, args[0]).id, nodeRef(obj, args[1]).id); if (err) throw new PyError(err); return null; }
          case "erase": { const n = nodeRef(obj, args[0]); M.removeNode(net, n.id); obj.pyIds = obj.pyIds.map((x) => (x === n.id ? null : x)); return null; }
          case "cpt": return { kind: "pot", bn: obj, node: nodeRef(obj, args[0]) };
          case "idFromName": return obj.pyIds.indexOf(nodeRef(obj, args[0]).id);
          case "variable": return { kind: "var", spec: structuredClone(nodeRef(obj, args[0])) };
          case "setProperty": case "generateCPTs": case "generateCPT": return null;
        }
      }
      if (obj && obj.kind === "pot") {
        const node = obj.node;
        switch (name) {
          case "fillWith": {
            if (typeof args[0] === "number") node.cpt.fill(args[0]);
            else setCells(obj.bn, node, new Map(), args[0] && args[0].kind === "pot" ? args[0].node.cpt : args[0]);
            return obj;
          }
          case "normalizeAsCPT": M.normalizeCpt(node); return obj;
          case "normalize": { const s = node.cpt.reduce((a, b) => a + b, 0); if (s > 0) node.cpt = node.cpt.map((v) => v / s); return obj; }
          case "fillFromDistribution": return obj;
        }
      }
      throw new PyError(`Unsupported call .${name}()`);
    }

    function fastBN(spec, domainSize) {
      const bn = makeBN("BN");
      const net = bn.net;
      const getVar = (txt) => {
        const m = /^\s*([^\s{}\[\]<>;-]+)\s*(\{[^}]*\}|\[[^\]]*\])?\s*$/.exec(txt);
        if (!m) throw new PyError(`Cannot parse fastBN node ${JSON.stringify(txt)}`);
        const name = m[1];
        const existing = M.nodeByName(net, name);
        if (existing) return existing;
        let s = { name, description: name, type: "range", min: 0, max: domainSize - 1 };
        const dom = m[2];
        if (dom && dom[0] === "{") {
          const labels = dom.slice(1, -1).split("|").map((x) => x.trim());
          const nums = labels.map(Number);
          if (labels.every((l) => l !== "" && /^-?\d+$/.test(l))) s = { name, description: name, type: "integer", values: nums };
          else s = { name, description: name, type: "labelized", labels };
        } else if (dom) {
          const parts = dom.slice(1, -1).split(",").map((x) => Number(x.trim()));
          if (parts.length === 1) s.max = parts[0] - 1;
          else if (parts.length === 2) { s.min = Math.trunc(parts[0]); s.max = Math.trunc(parts[1]); }
          else s = { name, description: name, type: "discretized", ticks: parts };
        }
        s.labels = s.labels || M.labelsFor(s);
        addVar(bn, s);
        return M.nodeByName(net, name);
      };
      for (const chain of String(spec).split(/[;\n]/)) {
        if (!chain.trim()) continue;
        const parts = chain.split(/(->|<-)/);
        let prev = getVar(parts[0]);
        for (let i = 1; i < parts.length; i += 2) {
          const next = getVar(parts[i + 1]);
          const [a, b] = parts[i] === "->" ? [prev, next] : [next, prev];
          if (!M.hasArc(net, a.id, b.id)) {
            const err = M.addArc(net, a.id, b.id);
            if (err) throw new PyError(err);
          }
          prev = next;
        }
      }
      for (const n of net.nodes) M.randomizeCpt(n);
      return bn;
    }

    function evaluate(e) {
      switch (e.t) {
        case "lit": return e.v;
        case "name":
          if (!env.has(e.name)) throw new PyError(`Unknown name '${e.name}'`);
          return env.get(e.name);
        case "neg": return -evaluate(e.e);
        case "bin": {
          const a = evaluate(e.left), b = evaluate(e.right);
          if (e.op === "+") return Array.isArray(a) ? a.concat(b) : a + b;
          if (e.op === "-") return a - b;
          if (e.op === "*") return Array.isArray(a) ? Array.from({ length: a.length * b }, (_, i) => a[i % a.length]) : a * b;
          return a / b;
        }
        case "list": return e.items.map(evaluate);
        case "dict": return { kind: "dict", map: new Map(e.entries.map(([k, v]) => [evaluate(k), evaluate(v)])) };
        case "slice": return { kind: "slice", partial: e.partial };
        case "tuple": return e.items.map(evaluate);
        case "attr": return { kind: "bound", obj: evaluate(e.obj), name: e.name };
        case "call": {
          const args = e.args.map(evaluate);
          const kwargs = Object.fromEntries(Object.entries(e.kwargs).map(([k, v]) => [k, evaluate(v)]));
          if (e.fn.t === "attr") return callMethod(evaluate(e.fn.obj), e.fn.name, args, kwargs);
          if (e.fn.t === "name" && env.get(e.fn.name) && env.get(e.fn.name).kind === "fromimport") {
            return callMethod(module, env.get(e.fn.name).name, args, kwargs);
          }
          if (e.fn.t === "name" && (e.fn.name === "list" || e.fn.name === "tuple")) return Array.from(args[0]);
          if (e.fn.t === "name" && e.fn.name === "range") {
            const [a, b] = args.length > 1 ? args : [0, args[0]];
            return Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
          }
          throw new PyError("Unsupported function call");
        }
        case "index": {
          const obj = evaluate(e.obj), key = evaluate(e.key);
          if (Array.isArray(obj) && typeof key === "number") return obj[key < 0 ? obj.length + key : key];
          if (obj && obj.kind === "dict") return obj.map.get(key);
          throw new PyError("Reading CPT entries is not supported");
        }
      }
      throw new PyError("Unsupported expression");
    }

    function assign(target, value) {
      if (target.t === "name") { env.set(target.name, value); return; }
      if (target.t === "list") {
        if (!Array.isArray(value) || value.length !== target.items.length) throw new PyError("Cannot unpack value");
        target.items.forEach((t, i) => assign(t, value[i]));
        return;
      }
      if (target.t === "index") {
        const obj = evaluate(target.obj);
        if (obj && obj.kind === "pot") {
          setCells(obj.bn, obj.node, potentialKey(obj.bn, obj.node, evaluate(target.key)), value);
          return;
        }
      }
      throw new PyError("Unsupported assignment target");
    }

    let tokens;
    try {
      tokens = tokenize(src);
    } catch (err) {
      return { net: null, warnings: [err.message], layout: null };
    }
    for (const st of splitStatements(tokens)) {
      if (st.comment) {
        const text = st.comment.value;
        if (text.startsWith(LAYOUT_TAG)) {
          try { layout = JSON.parse(text.slice(LAYOUT_TAG.length)); } catch { warnings.push(`Line ${st.comment.line}: could not read layout comment`); }
        }
        continue;
      }
      const head = st.toks[0];
      if (head.type === "name" && head.value === "import") {
        // import pyagrum as gum / import pyAgrum as gum
        for (let k = 1; k < st.toks.length; k++) {
          const t = st.toks[k];
          if (t.type === "name" && /^py[aA]grum$|^numpy$/.test(t.value)) {
            const alias = st.toks[k + 1] && st.toks[k + 1].value === "as" ? st.toks[k + 2].value : t.value;
            env.set(alias, t.value === "numpy" ? np : module);
          }
        }
        continue;
      }
      if (head.type === "name" && head.value === "from") {
        const imp = st.toks.findIndex((t) => t.type === "name" && t.value === "import");
        if (imp > 0 && /^py[aA]grum$/.test(st.toks[1].value)) {
          for (let k = imp + 1; k < st.toks.length; k++) {
            const t = st.toks[k];
            if (t.type !== "name") continue;
            if (st.toks[k + 1] && st.toks[k + 1].value === "as") { env.set(st.toks[k + 2].value, { kind: "fromimport", name: t.value }); k += 2; }
            else env.set(t.value, { kind: "fromimport", name: t.value });
          }
        }
        continue;
      }
      if (head.type === "name" && SKIP_KEYWORDS.has(head.value)) continue;
      if (head.type === "name" && BLOCK_KEYWORDS.has(head.value)) {
        warnings.push(`Line ${head.line}: '${head.value}' blocks are not supported; the header was skipped and the body lines were read as plain statements`);
        continue;
      }
      try {
        const stmt = parseStatement(st.toks);
        if (stmt.t === "assign") {
          const value = evaluate(stmt.value);
          for (const t of stmt.targets) assign(t, value);
        } else evaluate(stmt.e);
      } catch (err) {
        if (!(err instanceof PyError)) throw err;
        warnings.push(`Line ${head.line}: ${err.message} (skipped)`);
      }
    }

    if (!bns.length) {
      warnings.push("No BayesNet was found (expected gum.BayesNet(...) or gum.fastBN(...))");
      return { net: null, warnings, layout };
    }
    const bn = bns.reduce((a, b) => (b.net.nodes.length > a.net.nodes.length ? b : a));
    if (bns.length > 1) warnings.push(`Found ${bns.length} networks; imported the largest one`);
    const net = bn.net;
    for (const n of net.nodes) {
      if (M.badRows(n).length) warnings.push(`CPT of ${n.name} has rows that do not sum to 1`);
    }
    if (layout && net.nodes.every((n) => Array.isArray(layout[n.name]))) {
      for (const n of net.nodes) [n.x, n.y] = layout[n.name];
    } else M.autoLayout(net);
    return { net, warnings, layout };
  }

  globalThis.BNPyAgrum = { exportPython, importPython, tokenize };
})();
