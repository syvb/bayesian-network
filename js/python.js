// A small Python interpreter for reading pyAgrum scripts. It walks the syntax tree in JavaScript:
// nothing is executed natively, there is no file or network access, and runaway loops are cut off.
// It covers the parts of Python that model-building scripts use: functions, loops, conditionals,
// comprehensions, f-strings, % formatting, lists, tuples, dicts, sets, and a little numpy, math and
// random. Modules the host does not provide become inert stand-ins, so plotting and inference calls
// are ignored instead of failing.
(function () {
  "use strict";

  class PyError extends Error {
    // The Python exception type, when the message names one ("KeyError: 'x'"); errors without one
    // can't be caught by an except clause, as Python might not raise anything there.
    get pyType() { return /^([A-Z]\w*(?:Error|Exception|Iteration|Interrupt|Exit)):/.exec(this.message)?.[1] ?? null; }
  }
  // Built-in exception types and their bases, for matching except clauses.
  const EXCEPTION_BASES = {
    Exception: "BaseException", ArithmeticError: "Exception", ZeroDivisionError: "ArithmeticError", OverflowError: "ArithmeticError",
    LookupError: "Exception", KeyError: "LookupError", IndexError: "LookupError", ValueError: "Exception", TypeError: "Exception",
    AssertionError: "Exception", NameError: "Exception", AttributeError: "Exception", RuntimeError: "Exception",
    NotImplementedError: "RuntimeError", StopIteration: "Exception", KeyboardInterrupt: "BaseException", SystemExit: "BaseException",
  };
  function catches(handlerTypes, err) {
    if (!(err instanceof PyError) || err instanceof UnsupportedError || !err.pyType) return false;
    if (!handlerTypes) return true; // bare except
    return handlerTypes.some((t) => { for (let x = err.pyType; x; x = EXCEPTION_BASES[x]) if (x === t) return true; return false; });
  }

  // ---------------------------------------------------------------- tokenizer

  const KEYWORDS = new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
    "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
    "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]);
  const OPS = ["**=", "//=", ">>=", "<<=", "...", "->", ":=", "**", "//", "==", "!=", "<=", ">=", "<<", ">>", "+=", "-=", "*=", "/=",
    "%=", "&=", "|=", "^=", "@=", "+", "-", "*", "/", "%", "@", "<", ">", "=", "(", ")", "[", "]", "{", "}", ",", ":", ".", ";", "~", "&", "|", "^"];

  const ESCAPES = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0", a: "\x07", b: "\b", f: "\f", v: "\v" };

  function unescape(s) {
    return s.replace(/\\(\n|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|N\{[^}]*\}|.)/gs, (m, e) => {
      if (e === "\n") return "";
      if (e[0] === "x" || e[0] === "u" || e[0] === "U") return String.fromCodePoint(parseInt(e.slice(1), 16));
      if (e in ESCAPES) return ESCAPES[e];
      return m;
    });
  }

  // Returns {toks, comments}. Tokens: name, kw, num, str {value, f, raw}, op, nl, indent, dedent, end.
  function tokenize(src) {
    const toks = [], comments = [];
    const indents = [0];
    let i = 0, line = 1, depth = 0, atLineStart = true;
    const push = (type, value, extra) => toks.push(Object.assign({ type, value, line }, extra));
    while (i < src.length) {
      if (atLineStart && depth === 0) {
        let col = 0, j = i;
        for (; j < src.length; j++) {
          if (src[j] === " ") col++;
          else if (src[j] === "\t") col = (Math.floor(col / 8) + 1) * 8;
          else if (src[j] === "\f" || src[j] === "\r") continue;
          else break;
        }
        const c = src[j];
        if (c === "\n" || c === "#" || j >= src.length) { i = j; atLineStart = false; if (c !== "#") continue; }
        else {
          i = j; atLineStart = false;
          if (col > indents[indents.length - 1]) { indents.push(col); push("indent"); }
          else {
            while (col < indents[indents.length - 1]) { indents.pop(); push("dedent"); }
            if (col !== indents[indents.length - 1]) throw new PyError(`Inconsistent indentation on line ${line}`);
          }
        }
      }
      const ch = src[i];
      if (ch === "\n") {
        if (depth === 0 && toks.length && !["nl", "indent", "dedent"].includes(toks[toks.length - 1].type)) push("nl");
        line++; i++; atLineStart = depth === 0; continue;
      }
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f") { i++; continue; }
      if (ch === "\\" && (src[i + 1] === "\n" || (src[i + 1] === "\r" && src[i + 2] === "\n"))) { i += src[i + 1] === "\r" ? 3 : 2; line++; continue; }
      if (ch === "#") {
        const end = src.indexOf("\n", i);
        comments.push({ line, text: src.slice(i, end < 0 ? src.length : end) });
        i = end < 0 ? src.length : end;
        continue;
      }
      const sm = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(src.slice(i, i + 5));
      if (sm && (sm[1] === "" || !/[\w]/.test(src[i - 1] || ""))) {
        const prefix = sm[1].toLowerCase(), q = sm[2];
        const startLine = line;
        let j = i + sm[0].length;
        const begin = j;
        for (;;) {
          if (j >= src.length) throw new PyError(`Unterminated string on line ${startLine}`);
          if (src.startsWith(q, j)) break;
          const c = src[j];
          if (c === "\n") { if (q.length === 1) throw new PyError(`Unterminated string on line ${startLine}`); line++; }
          if (c === "\\") { if (src[j + 1] === "\n") line++; j += 2; continue; }
          j++;
        }
        const body = src.slice(begin, j);
        const raw = prefix.includes("r"), f = prefix.includes("f");
        toks.push({ type: "str", line: startLine, f, raw, value: f ? body : raw ? body : unescape(body) });
        i = j + q.length;
        continue;
      }
      const rest = src.slice(i, i + 80);
      const nm = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[jJ]?/.exec(rest);
      if (nm && /[\d.]/.test(ch) && nm[0] !== ".") {
        const t = nm[0].replace(/_/g, "");
        if (/[jJ]$/.test(t)) throw new PyError(`Complex numbers are not supported (line ${line})`);
        const v = /^0[xX]/.test(t) ? parseInt(t.slice(2), 16) : /^0[oO]/.test(t) ? parseInt(t.slice(2), 8) : /^0[bB]/.test(t) ? parseInt(t.slice(2), 2) : parseFloat(t);
        push("num", v);
        i += nm[0].length;
        continue;
      }
      const id = /^[A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff]*/.exec(rest);
      if (id) { push(KEYWORDS.has(id[0]) ? "kw" : "name", id[0]); i += id[0].length; continue; }
      const op = OPS.find((o) => src.startsWith(o, i));
      if (op) {
        if ("([{".includes(op)) depth++;
        if (")]}".includes(op)) depth = Math.max(0, depth - 1);
        if (op === ";" && depth === 0) push("nl");
        else push("op", op);
        i += op.length;
        continue;
      }
      throw new PyError(`Unexpected character ${JSON.stringify(ch)} on line ${line}`);
    }
    if (toks.length && toks[toks.length - 1].type !== "nl") push("nl");
    while (indents.length > 1) { indents.pop(); push("dedent"); }
    push("end");
    return { toks, comments };
  }

  // ---------------------------------------------------------------- parser

  const AUG = new Set(["+=", "-=", "*=", "/=", "//=", "%=", "**=", "&=", "|=", "^=", "@=", "<<=", ">>="]);

  // Parses a whole module into a list of statements. Each statement records its first line.
  function parse(toks) {
    let p = 0;
    const peek = (o = 0) => toks[p + o];
    const at = (type, value) => toks[p].type === type && (value === undefined || toks[p].value === value);
    const isOp = (v) => at("op", v);
    const isKw = (v) => at("kw", v);
    const fail = (msg) => { throw new PyError(`${msg} on line ${toks[p].line}`); };
    const describe = (t) => t.type === "nl" ? "end of line" : t.type === "end" ? "end of file" : t.type === "indent" || t.type === "dedent" ? "indentation" : `'${t.type === "str" ? "string" : t.value}'`;
    function expectOp(v) { if (!isOp(v)) fail(`Expected '${v}' but found ${describe(toks[p])}`); p++; }
    function expectKw(v) { if (!isKw(v)) fail(`Expected '${v}' but found ${describe(toks[p])}`); p++; }
    function expectName() { if (!at("name")) fail(`Expected a name but found ${describe(toks[p])}`); return toks[p++].value; }

    // Parses the module. A statement that fails to parse becomes an "error" statement (reported
    // when reached) and parsing resumes at the next top-level line.
    function module() {
      const body = [];
      while (!at("end")) {
        if (at("nl")) { p++; continue; }
        const start = p;
        try {
          if (at("indent")) fail("Unexpected indentation");
          body.push(...statement());
        } catch (err) {
          if (!(err instanceof PyError)) throw err;
          body.push({ t: "error", line: toks[start].line, message: err.message });
          p = start;
          let level = 0;
          for (; !at("end"); p++) {
            if (at("indent")) level++;
            else if (at("dedent")) level--;
            else if (at("nl") && level <= 0 && !(toks[p + 1] && toks[p + 1].type === "indent")) { p++; break; }
          }
          while (at("dedent")) p++;
        }
      }
      return body;
    }

    // A block after ':' — either statements on the same line or an indented suite.
    function suite() {
      if (!at("nl")) return simpleStatements();
      p++;
      while (at("nl")) p++;
      if (!at("indent")) fail("Expected an indented block");
      p++;
      const body = [];
      while (!at("dedent") && !at("end")) {
        if (at("nl")) { p++; continue; }
        body.push(...statement());
      }
      if (at("dedent")) p++;
      return body;
    }

    function statement() {
      const line = toks[p].line;
      const t = toks[p];
      if (t.type === "op" && t.value === "@") {
        while (isOp("@")) { p++; expr(); if (at("nl")) p++; }
        return statement();
      }
      if (t.type === "kw") {
        const s = compound(t.value, line);
        if (s) return [s];
      }
      return simpleStatements();
    }

    function compound(kw, line) {
      switch (kw) {
        case "if": {
          p++;
          const branches = [];
          const test = namedExpr(); expectOp(":");
          branches.push({ test, body: suite() });
          let orelse = null;
          for (;;) {
            if (isKw("elif")) { p++; const tst = namedExpr(); expectOp(":"); branches.push({ test: tst, body: suite() }); }
            else if (isKw("else")) { p++; expectOp(":"); orelse = suite(); break; }
            else break;
          }
          return { t: "if", line, branches, orelse };
        }
        case "while": {
          p++;
          const test = namedExpr(); expectOp(":");
          const body = suite();
          let orelse = null;
          if (isKw("else")) { p++; expectOp(":"); orelse = suite(); }
          return { t: "while", line, test, body, orelse };
        }
        case "for": {
          p++;
          const target = targetList(); expectKw("in");
          const iter = exprList(); expectOp(":");
          const body = suite();
          let orelse = null;
          if (isKw("else")) { p++; expectOp(":"); orelse = suite(); }
          return { t: "for", line, target, iter, body, orelse };
        }
        case "def": {
          p++;
          const name = expectName();
          expectOp("(");
          const params = paramList(")");
          expectOp(")");
          if (isOp("->")) { p++; expr(); }
          expectOp(":");
          return { t: "def", line, name, params, body: suite() };
        }
        case "class": {
          p++;
          const name = expectName();
          if (isOp("(")) { p++; let d = 1; while (d && !at("end")) { if (isOp("(")) d++; if (isOp(")")) d--; p++; } }
          expectOp(":");
          return { t: "class", line, name, body: suite() };
        }
        case "try": {
          p++; expectOp(":");
          const body = suite();
          const handlers = [];
          let orelse = null, final = null;
          while (isKw("except")) {
            p++;
            let name = null, types = null;
            if (isOp("*")) p++;
            if (!isOp(":")) {
              // the exception types, by name (ValueError, gum.NotFound, (KeyError, IndexError))
              const e = expr();
              const names = (x) => (x.t === "tuple" ? x.items.flatMap(names) : x.t === "name" ? [x.name] : x.t === "attr" ? [x.name] : ["?"]);
              types = names(e);
              if (isKw("as")) { p++; name = expectName(); }
            }
            expectOp(":");
            handlers.push({ name, types, body: suite() });
          }
          if (isKw("else")) { p++; expectOp(":"); orelse = suite(); }
          if (isKw("finally")) { p++; expectOp(":"); final = suite(); }
          return { t: "try", line, body, handlers, orelse, final };
        }
        case "with": {
          p++;
          const items = [];
          const paren = isOp("(") && withParenthesized();
          if (paren) p++;
          do {
            if (items.length) p++;
            const e = expr();
            let target = null;
            if (isKw("as")) { p++; target = targetAtom(); }
            items.push({ e, target });
          } while (isOp(","));
          if (paren) expectOp(")");
          expectOp(":");
          return { t: "with", line, items, body: suite() };
        }
        case "async": p++; return compound(toks[p].value, line);
      }
      return null;
    }

    // `with (a as b, c as d):` — distinguishes the parenthesized form from `with (expr):`.
    function withParenthesized() {
      let d = 0;
      for (let k = p; k < toks.length; k++) {
        const t = toks[k];
        if (t.type === "op" && "([{".includes(t.value)) d++;
        if (t.type === "op" && ")]}".includes(t.value)) { d--; if (d === 0) return toks[k + 1] && toks[k + 1].type === "op" && toks[k + 1].value === ":" && toks.slice(p, k).some((x) => x.type === "kw" && x.value === "as"); }
        if (t.type === "nl") return false;
      }
      return false;
    }

    function paramList(close) {
      const params = [];
      let kind = "pos";
      while (!isOp(close)) {
        if (isOp("/")) { p++; }
        else if (isOp("**")) { p++; params.push({ name: expectName(), kind: "varkw" }); if (isOp(":") && close === ")") { p++; expr(); } }
        else if (isOp("*")) {
          p++;
          if (at("name")) { params.push({ name: expectName(), kind: "varargs" }); if (isOp(":") && close === ")") { p++; expr(); } }
          kind = "kwonly";
        } else {
          const name = expectName();
          if (isOp(":") && close === ")") { p++; expr(); }
          let def = null;
          if (isOp("=")) { p++; def = expr(); }
          params.push({ name, kind, def });
        }
        if (!isOp(close)) expectOp(",");
      }
      return params;
    }

    function simpleStatements() {
      const out = [simpleStatement()];
      while (!at("nl") && !at("end") && !at("dedent")) fail(`Unexpected ${describe(toks[p])}`);
      if (at("nl")) p++;
      return out;
    }

    function simpleStatement() {
      const line = toks[p].line;
      if (at("kw")) {
        const kw = toks[p].value;
        switch (kw) {
          case "pass": p++; return { t: "pass", line };
          case "break": p++; return { t: "break", line };
          case "continue": p++; return { t: "continue", line };
          case "return": p++; return { t: "return", line, value: at("nl") || at("end") || at("dedent") ? null : exprList() };
          case "raise": p++; { const value = at("nl") || at("end") ? null : expr(); if (isKw("from")) { p++; expr(); } return { t: "raise", line, value }; }
          case "global": case "nonlocal": {
            p++;
            const names = [expectName()];
            while (isOp(",")) { p++; names.push(expectName()); }
            return { t: kw, line, names };
          }
          case "del": p++; return { t: "del", line, targets: exprList() };
          case "assert": { p++; const test = expr(); let msg = null; if (isOp(",")) { p++; msg = expr(); } return { t: "assert", line, test, msg }; }
          case "import": {
            p++;
            const names = [];
            do {
              if (names.length) p++;
              const parts = [expectName()];
              while (isOp(".")) { p++; parts.push(expectName()); }
              let alias = null;
              if (isKw("as")) { p++; alias = expectName(); }
              names.push({ module: parts.join("."), alias });
            } while (isOp(","));
            return { t: "import", line, names };
          }
          case "from": {
            p++;
            let mod = "";
            while (isOp(".") || isOp("...")) mod += toks[p++].value;
            if (at("name")) { mod += expectName(); while (isOp(".")) { p++; mod += "." + expectName(); } }
            expectKw("import");
            const names = [];
            const paren = isOp("(");
            if (paren) p++;
            if (isOp("*")) { p++; names.push({ name: "*", alias: null }); }
            else {
              while (at("name")) {
                const name = expectName();
                let alias = null;
                if (isKw("as")) { p++; alias = expectName(); }
                names.push({ name, alias });
                if (isOp(",")) p++; else break;
              }
            }
            if (paren) expectOp(")");
            return { t: "from", line, module: mod, names };
          }
        }
      }
      const first = starExprList();
      if (isOp("=")) {
        const targets = [first];
        let value;
        for (;;) {
          p++;
          value = isKw("yield") ? fail("Generators are not supported") : starExprList();
          if (!isOp("=")) break;
          targets.push(value);
        }
        targets.forEach(checkTarget);
        return { t: "assign", line, targets, value };
      }
      if (at("op") && AUG.has(toks[p].value)) {
        const op = toks[p++].value.slice(0, -1);
        checkTarget(first);
        return { t: "augassign", line, target: first, op, value: exprList() };
      }
      if (isOp(":")) {
        // annotated assignment: x: int = 3
        p++; expr();
        checkTarget(first);
        if (isOp("=")) { p++; return { t: "assign", line, targets: [first], value: exprList() }; }
        return { t: "pass", line };
      }
      return { t: "expr", line, e: first };
    }

    function checkTarget(e) {
      if (e.t === "name" || e.t === "attr" || e.t === "index") return;
      if (e.t === "tuple" || e.t === "list") { e.items.forEach((x) => checkTarget(x.t === "star" ? x.e : x)); return; }
      throw new PyError(`Cannot assign to this expression on line ${e.line || "?"}`);
    }

    // ------------------------------------------------ expressions

    function exprList() {
      const first = expr();
      if (!isOp(",")) return first;
      const items = [first];
      while (isOp(",")) { p++; if (endsList()) break; items.push(expr()); }
      return { t: "tuple", items };
    }
    function starExprList() {
      const one = () => (isOp("*") ? (p++, { t: "star", e: bitOr() }) : isKw("yield") ? fail("Generators are not supported") : expr());
      const first = one();
      if (!isOp(",")) return first;
      const items = [first];
      while (isOp(",")) { p++; if (endsList() || isOp("=")) break; items.push(one()); }
      return { t: "tuple", items };
    }
    function endsList() { return at("nl") || at("end") || isOp(")") || isOp("]") || isOp("}") || isOp(":") || isOp("=") || isKw("in"); }
    function targetList() {
      const one = () => (isOp("*") ? (p++, { t: "star", e: targetAtom() }) : targetAtom());
      const first = one();
      if (!isOp(",")) return first;
      const items = [first];
      while (isOp(",")) { p++; if (isKw("in") || isOp("=")) break; items.push(one()); }
      return { t: "tuple", items };
    }
    function targetAtom() { return bitOr(); }

    function namedExpr() {
      if (at("name") && peek(1).type === "op" && peek(1).value === ":=") {
        const name = toks[p].value; p += 2;
        return { t: "walrus", name, value: expr() };
      }
      return expr();
    }

    function expr() {
      if (isKw("lambda")) {
        p++;
        const params = paramList(":");
        expectOp(":");
        return { t: "lambda", params, body: expr() };
      }
      const e = orTest();
      if (isKw("if")) {
        p++;
        const test = orTest();
        expectKw("else");
        return { t: "ifexp", test, body: e, orelse: expr() };
      }
      return e;
    }
    function orTest() {
      let e = andTest();
      while (isKw("or")) { p++; e = { t: "or", left: e, right: andTest() }; }
      return e;
    }
    function andTest() {
      let e = notTest();
      while (isKw("and")) { p++; e = { t: "and", left: e, right: notTest() }; }
      return e;
    }
    function notTest() {
      if (isKw("not")) { p++; return { t: "not", e: notTest() }; }
      return comparison();
    }
    function comparison() {
      const first = bitOr();
      const ops = [], values = [first];
      for (;;) {
        let op = null;
        if (at("op") && ["<", ">", "==", ">=", "<=", "!="].includes(toks[p].value)) op = toks[p++].value;
        else if (isKw("in")) { p++; op = "in"; }
        else if (isKw("not") && peek(1).type === "kw" && peek(1).value === "in") { p += 2; op = "not in"; }
        else if (isKw("is")) { p++; op = "is"; if (isKw("not")) { p++; op = "is not"; } }
        if (!op) break;
        ops.push(op);
        values.push(bitOr());
      }
      return ops.length ? { t: "cmp", ops, values } : first;
    }
    function binLevel(next, ops) {
      return function level() {
        let e = next();
        while (at("op") && ops.includes(toks[p].value)) { const op = toks[p++].value; e = { t: "bin", op, left: e, right: next() }; }
        return e;
      };
    }
    function unary() {
      if (isOp("-") || isOp("+") || isOp("~")) { const op = toks[p++].value; return { t: "unary", op, e: unary() }; }
      if (isKw("await")) { p++; return unary(); }
      return power();
    }
    const term = binLevel(unary, ["*", "/", "//", "%", "@"]);
    const arith = binLevel(term, ["+", "-"]);
    const shift = binLevel(arith, ["<<", ">>"]);
    const bitAnd = binLevel(shift, ["&"]);
    const bitXor = binLevel(bitAnd, ["^"]);
    const bitOr = binLevel(bitXor, ["|"]);
    function power() {
      const e = postfix();
      if (isOp("**")) { p++; return { t: "bin", op: "**", left: e, right: unary() }; }
      return e;
    }
    function postfix() {
      let e = atom();
      for (;;) {
        const line = toks[p].line;
        if (isOp(".")) { p++; e = { t: "attr", obj: e, name: expectName(), line }; }
        else if (isOp("(")) {
          p++;
          const args = [];
          while (!isOp(")")) {
            if (isOp("**")) { p++; args.push({ kind: "**", e: expr() }); }
            else if (isOp("*")) { p++; args.push({ kind: "*", e: expr() }); }
            else if (at("name") && peek(1).type === "op" && peek(1).value === "=") { const name = toks[p].value; p += 2; args.push({ kind: "kw", name, e: expr() }); }
            else {
              const a = namedExpr();
              if (isKw("for")) { args.push({ kind: "pos", e: comprehension("genexp", a, ")") }); break; }
              args.push({ kind: "pos", e: a });
            }
            if (!isOp(")")) expectOp(",");
          }
          expectOp(")");
          e = { t: "call", fn: e, args, line };
        } else if (isOp("[")) {
          p++;
          const items = [];
          let tuple = false;
          while (!isOp("]")) {
            items.push(subscript());
            if (!isOp("]")) { expectOp(","); tuple = true; }
          }
          p++;
          e = { t: "index", obj: e, key: tuple || items.length !== 1 ? { t: "tuple", items } : items[0], line };
        } else return e;
      }
    }
    function subscript() {
      const part = () => (isOp(":") || isOp(",") || isOp("]") ? null : expr());
      const lo = part();
      if (!isOp(":")) return lo;
      p++;
      const hi = part();
      let step = null;
      if (isOp(":")) { p++; step = part(); }
      return { t: "slice", lo, hi, step };
    }
    function comprehension(kind, elt, close, value) {
      const gens = [];
      while (isKw("for") || isKw("async")) {
        if (isKw("async")) p++;
        p++;
        const target = targetList();
        expectKw("in");
        const iter = orTest();
        const ifs = [];
        while (isKw("if")) { p++; ifs.push(orTest()); }
        gens.push({ target, iter, ifs });
      }
      if (!isOp(close)) fail(`Expected '${close}'`);
      return { t: "comp", kind, elt, value, gens };
    }
    function atom() {
      const t = toks[p];
      const line = t.line;
      if (t.type === "num") { p++; return { t: "lit", v: t.value }; }
      if (t.type === "str") {
        const parts = [];
        while (at("str")) {
          const s = toks[p++];
          if (s.f) parts.push(...fstringParts(s.value, s.raw, s.line));
          else parts.push(s.value);
        }
        if (parts.every((x) => typeof x === "string")) return { t: "lit", v: parts.join("") };
        return { t: "fstr", parts };
      }
      if (t.type === "name") { p++; return { t: "name", name: t.value, line }; }
      if (t.type === "kw") {
        if (t.value === "True") { p++; return { t: "lit", v: true }; }
        if (t.value === "False") { p++; return { t: "lit", v: false }; }
        if (t.value === "None") { p++; return { t: "lit", v: null }; }
        if (t.value === "yield") fail("Generators are not supported");
      }
      if (t.type === "op") {
        if (t.value === "...") { p++; return { t: "lit", v: null }; }
        if (t.value === "(") {
          p++;
          if (isOp(")")) { p++; return { t: "tuple", items: [] }; }
          const first = isOp("*") ? (p++, { t: "star", e: bitOr() }) : namedExpr();
          if (isKw("for")) { const c = comprehension("genexp", first, ")"); p++; return c; }
          if (isOp(")")) { p++; return first.t === "star" ? { t: "tuple", items: [first] } : first; }
          const items = [first];
          while (isOp(",")) { p++; if (isOp(")")) break; items.push(isOp("*") ? (p++, { t: "star", e: bitOr() }) : namedExpr()); }
          expectOp(")");
          return { t: "tuple", items };
        }
        if (t.value === "[") {
          p++;
          const items = [];
          while (!isOp("]")) {
            const item = isOp("*") ? (p++, { t: "star", e: bitOr() }) : namedExpr();
            if (isKw("for") && !items.length) { const c = comprehension("list", item, "]"); p++; return c; }
            items.push(item);
            if (!isOp("]")) expectOp(",");
          }
          p++;
          return { t: "list", items };
        }
        if (t.value === "{") {
          p++;
          if (isOp("}")) { p++; return { t: "dict", entries: [] }; }
          if (isOp("**")) return dictRest([]);
          const first = isOp("*") ? (p++, { t: "star", e: bitOr() }) : namedExpr();
          if (isOp(":")) {
            p++;
            const v = expr();
            if (isKw("for")) { const c = comprehension("dict", first, "}", v); p++; return c; }
            return dictRest([[first, v]]);
          }
          if (isKw("for")) { const c = comprehension("set", first, "}"); p++; return c; }
          const items = [first];
          while (isOp(",")) { p++; if (isOp("}")) break; items.push(isOp("*") ? (p++, { t: "star", e: bitOr() }) : expr()); }
          expectOp("}");
          return { t: "set", items };
        }
      }
      fail(`Unexpected ${describe(t)}`);
    }
    function dictRest(entries) {
      for (;;) {
        if (entries.length) { if (!isOp(",")) break; p++; }
        if (isOp("}")) break;
        if (isOp("**")) { p++; entries.push([null, bitOr()]); continue; }
        const k = expr(); expectOp(":");
        entries.push([k, expr()]);
      }
      expectOp("}");
      return { t: "dict", entries };
    }

    function fstringParts(body, raw, line) {
      const parts = [];
      let i = 0, lit = "";
      const flush = () => { if (lit) parts.push(raw ? lit : unescape(lit)); lit = ""; };
      while (i < body.length) {
        const c = body[i];
        if (c === "{" && body[i + 1] === "{") { lit += "{"; i += 2; continue; }
        if (c === "}" && body[i + 1] === "}") { lit += "}"; i += 2; continue; }
        if (c !== "{") { lit += c; i++; continue; }
        flush();
        // find the matching close brace, skipping nested brackets and strings
        let j = i + 1, d = 0, q = null, exprEnd = -1, conv = null;
        for (; j < body.length; j++) {
          const ch = body[j];
          if (q) { if (ch === q) q = null; continue; }
          if (ch === "'" || ch === '"') { q = ch; continue; }
          if ("([{".includes(ch)) d++;
          else if (")]".includes(ch)) d--;
          else if (ch === "}") { if (d === 0) break; d--; }
          else if (d === 0 && exprEnd < 0 && ch === "!" && body[j + 1] !== "=") exprEnd = j;
          else if (d === 0 && ch === ":" && exprEnd < 0) { exprEnd = j; break; }
        }
        let k = j;
        if (exprEnd < 0) exprEnd = j;
        let src = body.slice(i + 1, exprEnd);
        if (body[exprEnd] === "!") { conv = body[exprEnd + 1]; k = exprEnd + 2; }
        else k = exprEnd;
        let spec = null;
        if (body[k] === ":") {
          let e = k + 1, dd = 0;
          for (; e < body.length; e++) { if (body[e] === "{") dd++; else if (body[e] === "}") { if (dd === 0) break; dd--; } }
          spec = fstringParts(body.slice(k + 1, e), raw, line);
          k = e;
        } else {
          while (k < body.length && body[k] !== "}") k++;
        }
        if (k >= body.length) throw new PyError(`Unterminated f-string expression on line ${line}`);
        const selfDoc = /=\s*$/.test(src) && !/[=!<>]=\s*$/.test(src);
        if (selfDoc) { parts.push(src); src = src.replace(/=\s*$/, ""); if (!conv && !spec) conv = "r"; }
        const sub = tokenize(src.trim());
        const ast = parseExpression(sub.toks, line);
        parts.push({ e: ast, conv, spec });
        i = k + 1;
      }
      flush();
      return parts;
    }

    return { module, exprOnly: () => { const e = exprList(); while (at("nl")) p++; if (!at("end")) fail("Unexpected text after expression"); return e; } };
  }

  function parseExpression(toks, line) {
    toks.forEach((t) => { t.line = line; });
    return parse(toks).exprOnly();
  }

  // ---------------------------------------------------------------- values

  // Lists are JS arrays; tuples are JS arrays marked with TUPLE.
  const TUPLE = Symbol("tuple");
  const tuple = (arr) => { arr[TUPLE] = true; return arr; };
  const isTuple = (v) => Array.isArray(v) && v[TUPLE] === true;

  function hashKey(k) {
    if (k === null) return "N";
    if (typeof k === "boolean") return "n" + (k ? 1 : 0);
    if (typeof k === "number") return "n" + k;
    if (typeof k === "string") return "s" + k;
    if (isTuple(k)) return "t(" + k.map(hashKey).join(",") + ")";
    if (Array.isArray(k) || k instanceof PyDict || k instanceof PySet) throw new PyError(`unhashable type: '${typeName(k)}'`);
    if (!k.__hash) Object.defineProperty(k, "__hash", { value: "o" + (++hashCounter) });
    return k.__hash;
  }
  let hashCounter = 0;

  class PyDict {
    constructor(entries = []) { this.m = new Map(); for (const [k, v] of entries) this.set(k, v); }
    set(k, v) { const h = hashKey(k); const e = this.m.get(h); if (e) e[1] = v; else this.m.set(h, [k, v]); }
    get(k) { const e = this.m.get(hashKey(k)); return e ? e[1] : undefined; }
    has(k) { return this.m.has(hashKey(k)); }
    delete(k) { return this.m.delete(hashKey(k)); }
    keys() { return [...this.m.values()].map((e) => e[0]); }
    values() { return [...this.m.values()].map((e) => e[1]); }
    entries() { return [...this.m.values()]; }
    get size() { return this.m.size; }
  }
  class PySet {
    constructor(items = []) { this.m = new Map(); for (const x of items) this.add(x); }
    add(x) { this.m.set(hashKey(x), x); }
    has(x) { return this.m.has(hashKey(x)); }
    delete(x) { return this.m.delete(hashKey(x)); }
    values() { return [...this.m.values()]; }
    get size() { return this.m.size; }
  }

  // A numpy array, stored as nested JS arrays.
  // A numpy array as nested JS arrays. dtype is "float", "int", "bool" or "num". Numbers here are
  // JS numbers, so 1 and 1.0 look the same: an array of whole numbers whose int or float type
  // isn't known for certain is "num", and whatever would come out differently for the two (a
  // fractional result written into it) is refused. Values written into an int or bool array are
  // converted, as numpy does.
  class NdArray {
    constructor(data, dtype = "float") { this.data = data; this.dtype = dtype; }
  }
  // The dtype of numbers from Python values: whole numbers might be ints or floats.
  function inferDtype(data) {
    const flat = flatten(data);
    if (flat.length && flat.every((v) => typeof v === "boolean")) return "bool";
    return flat.every((v) => typeof v === "boolean" || Number.isInteger(v)) ? "num" : "float";
  }
  const AMBIGUOUS = "The array holds whole numbers, and the importer can't tell whether they are ints or floats (1 or 1.0), which changes this result; make the type explicit, for example np.array([...], dtype=float)";

  class PyFunction {
    constructor(name, params, body, closure, isLambda) { Object.assign(this, { name, params, body, closure, isLambda }); }
  }

  // A function implemented in JavaScript: fn(args, kwargs).
  class Builtin {
    constructor(name, fn) { this.name = name; this.fn = fn; }
  }

  // Base class for objects provided by the host (pyAgrum objects, modules). Subclasses override
  // what they support; the defaults raise Python-style errors.
  class HostObject {
    get typeName() { return "object"; }
    getattr(name) { throw new PyError(`'${this.typeName}' object has no attribute '${name}'`); }
    setattr(name) { throw new PyError(`Cannot set attribute '${name}' on '${this.typeName}'`); }
    getitem() { throw new PyError(`'${this.typeName}' object is not subscriptable`); }
    setitem() { throw new PyError(`'${this.typeName}' object does not support item assignment`); }
    call() { throw new PyError(`'${this.typeName}' object is not callable`); }
    iter() { throw new PyError(`'${this.typeName}' object is not iterable`); }
    len() { throw new PyError(`object of type '${this.typeName}' has no len()`); }
    str() { return `<${this.typeName}>`; }
    binop() { return undefined; }
  }

  // Stands in for anything outside the model: plotting, notebooks, inference engines, unknown
  // modules. Calls, attributes, indexing and arithmetic give more stand-ins, so presentation code
  // (gnb.showInference(bn), print(ie.posterior("A"))) runs without effect. Whatever would need its
  // actual value (a condition, a loop, a number, a length) raises an OpaqueError instead, since
  // the script might then build a different network than it does in Python.
  class Opaque extends HostObject {
    constructor(name) { super(); this.name = name; }
    get typeName() { return this.name; }
    getattr(name) { return new Opaque(`${this.name}.${name}`); }
    setattr() {}
    getitem() { return new Opaque(`${this.name}[]`); }
    setitem() {}
    call() { return new Opaque(`${this.name}()`); }
    iter() { throw opaqueUse(this, "loop over"); }
    len() { throw opaqueUse(this, "take the length of"); }
    binop() { return this; }
    // marked, so that the importer can refuse it as a name or label
    str() { return `${OPAQUE_MARK}<${this.name}>${OPAQUE_MARK}`; }
  }
  const OPAQUE_MARK = "\u2063";
  // An error the script can't catch: it isn't a Python error but a limit of the importer.
  class UnsupportedError extends PyError {}
  const opaqueUse = (o, what) => new UnsupportedError(`Can't ${what} ${o.name.replace(/^<|>$/g, "")}: the importer doesn't compute it (it isn't part of building the network)`);

  function typeName(v) {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (isTuple(v)) return "tuple";
    if (Array.isArray(v)) return "list";
    if (v instanceof PyDict) return "dict";
    if (v instanceof PySet) return "set";
    if (v instanceof NdArray) return "numpy.ndarray";
    if (v instanceof PyFunction || v instanceof Builtin) return "function";
    if (v instanceof HostObject) return v.typeName;
    return "object";
  }

  function truthy(v) {
    if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof PyDict || v instanceof PySet) return v.size > 0;
    if (v instanceof NdArray) {
      const flat = flatten(v.data);
      if (flat.length !== 1) throw new PyError("The truth value of an array with more than one element is ambiguous");
      return truthy(flat[0]);
    }
    if (v instanceof Opaque) throw opaqueUse(v, "decide on");
    return true;
  }

  function fmtFloat(x) {
    if (Number.isNaN(x)) return "nan";
    if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
    const s = String(x);
    if (Math.abs(x) >= 1e16 || (x !== 0 && Math.abs(x) < 1e-4)) {
      return x.toExponential().replace(/e([+-])(\d)$/, "e$10$2").replace(/\.0+e/, "e");
    }
    return s;
  }

  function repr(v) {
    if (typeof v === "string") return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n") + "'";
    return str(v, true);
  }
  function str(v, nested) {
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "number") return fmtFloat(v);
    if (typeof v === "string") return nested ? repr(v) : v;
    if (isTuple(v)) return "(" + v.map(repr).join(", ") + (v.length === 1 ? ",)" : ")");
    if (Array.isArray(v)) return "[" + v.map(repr).join(", ") + "]";
    if (v instanceof PyDict) return "{" + v.entries().map(([k, x]) => repr(k) + ": " + repr(x)).join(", ") + "}";
    if (v instanceof PySet) return v.size ? "{" + v.values().map(repr).join(", ") + "}" : "set()";
    if (v instanceof NdArray) return "[" + (Array.isArray(v.data) ? v.data.map((x) => str(new NdArray(x))).join(" ") : str(v.data)) + "]";
    if (v instanceof PyFunction || v instanceof Builtin) return `<function ${v.name}>`;
    if (v instanceof HostObject) return v.str();
    return String(v);
  }

  function eq(a, b) {
    if (a === b) return true;
    if (typeof a === "boolean") a = +a;
    if (typeof b === "boolean") b = +b;
    if (typeof a === "number" && typeof b === "number") return a === b;
    if (Array.isArray(a) && Array.isArray(b)) return isTuple(a) === isTuple(b) && a.length === b.length && a.every((x, i) => eq(x, b[i]));
    if (a instanceof PyDict && b instanceof PyDict) return a.size === b.size && a.entries().every(([k, v]) => b.has(k) && eq(v, b.get(k)));
    if (a instanceof PySet && b instanceof PySet) return a.size === b.size && a.values().every((x) => b.has(x));
    return false;
  }

  function compare(a, b) {
    if (typeof a === "boolean") a = +a;
    if (typeof b === "boolean") b = +b;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = compare(a[i], b[i]); if (c) return c; }
      return a.length - b.length;
    }
    throw new PyError(`'<' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
  }

  function flatten(v, out = []) {
    if (Array.isArray(v)) for (const x of v) flatten(x, out);
    else if (v instanceof NdArray) flatten(v.data, out);
    else out.push(v);
    return out;
  }

  function toNumber(v) {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return +v;
    throw new PyError(`Expected a number but got '${typeName(v)}'`);
  }

  function pyMod(a, b) {
    if (b === 0) throw new PyError("ZeroDivisionError: modulo by zero");
    const r = a % b;
    return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
  }

  function numOp(op, a, b) {
    a = toNumber(a); b = toNumber(b);
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": if (b === 0) throw new PyError("ZeroDivisionError: division by zero"); return a / b;
      case "//": if (b === 0) throw new PyError("ZeroDivisionError: integer division by zero"); return Math.floor(a / b);
      case "%": return pyMod(a, b);
      case "**": return a ** b;
      case "&": return a & b;
      case "|": return a | b;
      case "^": return a ^ b;
      case "<<": return a << b;
      case ">>": return a >> b;
    }
    throw new PyError(`Unsupported operator ${op}`);
  }

  // The shape of nested arrays, refusing ragged ones (numpy would make an object array).
  function shapeOf(d) {
    if (!Array.isArray(d)) return [];
    const inner = d.length ? shapeOf(d[0]) : [];
    for (const x of d) {
      const sx = shapeOf(x);
      if (sx.length !== inner.length || sx.some((n, i) => n !== inner[i])) throw new UnsupportedError("Arrays with rows of different lengths aren't supported");
    }
    return [d.length, ...inner];
  }

  // f applied elementwise with numpy broadcasting: shapes are aligned from the last axis, and an
  // axis of length 1 (or a missing leading axis) stretches to match the other operand.
  function broadcast(f, A, B) {
    const sa = shapeOf(A), sb = shapeOf(B), n = Math.max(sa.length, sb.length);
    const pa = Array(n - sa.length).fill(1).concat(sa), pb = Array(n - sb.length).fill(1).concat(sb);
    const out = pa.map((x, i) => {
      if (x !== pb[i] && x !== 1 && pb[i] !== 1) throw new PyError(`ValueError: operands could not be broadcast together with shapes (${sa}) (${sb})`);
      return Math.max(x, pb[i]);
    });
    checkSize(out.reduce((x, y) => x * y, 1));
    const rec = (x, y, k) => {
      if (k === n) return f(x, y);
      const xs = k >= n - sa.length, ys = k >= n - sb.length; // does this axis exist in x / y?
      return Array.from({ length: out[k] }, (_, i) => rec(xs ? x[pa[k] === 1 ? 0 : i] : x, ys ? y[pb[k] === 1 ? 0 : i] : y, k + 1));
    };
    return rec(A, B, 0);
  }

  const dtypeOf = (v) => (v instanceof NdArray ? v.dtype : Array.isArray(v) ? inferDtype(v) : typeof v === "boolean" ? "bool" : Number.isInteger(v) ? "num" : "float");
  // numpy's result type for arithmetic, with "num" (int or float, unknown) where it depends on that
  function resultDtype(op, a, b) {
    const da = dtypeOf(a), db = dtypeOf(b);
    if (da === "float" || db === "float" || op === "/" || op === "**") return "float";
    if (da === "num" || db === "num") return "num";
    return "int";
  }

  // Elementwise numpy arithmetic and comparisons, with broadcasting.
  function elementwise(op, a, b) {
    const cmp = ["==", "!=", "<", ">", "<=", ">="].includes(op);
    const f = cmp
      ? (x, y) => { x = toNumber(x); y = toNumber(y); return op === "==" ? x === y : op === "!=" ? x !== y : op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y; }
      : (x, y) => numOp(op, x, y);
    return new NdArray(broadcast(f, ndData(a), ndData(b)), cmp ? "bool" : resultDtype(op, a, b));
  }

  function binop(op, a, b) {
    if (a instanceof HostObject) { const r = a.binop(op, a, b); if (r !== undefined) return r; }
    if (b instanceof HostObject) { const r = b.binop(op, a, b); if (r !== undefined) return r; }
    if (a instanceof NdArray || b instanceof NdArray) return elementwise(op, a, b);
    if (op === "+") {
      if (typeof a === "string" && typeof b === "string") { checkSize(a.length + b.length); return a + b; }
      if (Array.isArray(a) && Array.isArray(b)) { checkSize(a.length + b.length); const r = a.concat(b); return isTuple(a) ? tuple(r) : r; }
    }
    if (op === "*") {
      if ((typeof a === "string" || Array.isArray(a)) && typeof b === "number") return repeat(a, b);
      if ((typeof b === "string" || Array.isArray(b)) && typeof a === "number") return repeat(b, a);
    }
    if (op === "%" && typeof a === "string") return percentFormat(a, b);
    if (op === "|" && a instanceof PyDict && b instanceof PyDict) return new PyDict([...a.entries(), ...b.entries()]);
    if ((op === "|" || op === "&" || op === "-") && a instanceof PySet && b instanceof PySet) {
      if (op === "|") return new PySet([...a.values(), ...b.values()]);
      if (op === "&") return new PySet(a.values().filter((x) => b.has(x)));
      return new PySet(a.values().filter((x) => !b.has(x)));
    }
    if (op === "@") throw new PyError("Matrix multiplication is not supported");
    if ((typeof a === "number" || typeof a === "boolean") && (typeof b === "number" || typeof b === "boolean")) return numOp(op, a, b);
    throw new PyError(`unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
  }

  // Keeps scripts from building huge values (a hostile ?src= link must not exhaust memory).
  const MAX_SIZE = 5e6;
  function checkSize(n) { if (n > MAX_SIZE) throw new PyError("The script builds a value that is too large"); }

  function repeat(a, n) {
    n = Math.max(0, Math.floor(n));
    checkSize(a.length * n);
    if (typeof a === "string") return a.repeat(n);
    const out = [];
    for (let i = 0; i < n; i++) out.push(...a);
    return isTuple(a) ? tuple(out) : out;
  }

  // ---------------------------------------------------------------- formatting

  function formatSpec(v, spec) {
    if (!spec) return str(v);
    const m = /^(?:(.)?([<>^=]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/.exec(spec);
    if (!m) throw new PyError(`Invalid format specifier '${spec}'`);
    let [, fill = " ", align, sign = "-", , zero, width, group, prec, type] = m;
    let s;
    if (typeof v === "number" || typeof v === "boolean") {
      let x = +v;
      const p = prec === undefined ? 6 : +prec;
      switch (type) {
        case "d": case "n": if (!Number.isInteger(x)) throw new PyError("Unknown format code 'd' for float"); s = String(Math.abs(x)); break;
        case "f": case "F": s = toFixed(Math.abs(x), p); break;
        case "e": case "E": s = Math.abs(x).toExponential(p).replace(/e([+-])(\d)$/, "e$10$2"); if (type === "E") s = s.toUpperCase(); break;
        case "%": s = toFixed(Math.abs(x) * 100, p) + "%"; break;
        case "g": case "G": s = String(+Math.abs(x).toPrecision(p || 1)); break;
        case "x": s = Math.abs(x).toString(16); break;
        case "X": s = Math.abs(x).toString(16).toUpperCase(); break;
        case "o": s = Math.abs(x).toString(8); break;
        case "b": s = Math.abs(x).toString(2); break;
        case "c": s = String.fromCodePoint(x); break;
        case "s": throw new PyError("Unknown format code 's' for number");
        default: s = prec !== undefined ? String(+Math.abs(x).toPrecision(+prec)) : fmtFloat(Math.abs(x));
      }
      if (group) { const [ip, fp] = s.split("."); s = ip.replace(/\B(?=(\d{3})+(?!\d))/g, group) + (fp !== undefined ? "." + fp : ""); }
      const neg = x < 0 || Object.is(x, -0) && type === "f";
      const signStr = neg ? "-" : sign === "+" ? "+" : sign === " " ? " " : "";
      if (zero && !align) { fill = "0"; align = "="; }
      if (align === "=") {
        const w = +(width || 0) - signStr.length;
        return signStr + (s.length < w ? fill.repeat(w - s.length) + s : s);
      }
      s = signStr + s;
      align = align || ">";
    } else {
      s = str(v);
      if (prec !== undefined) s = s.slice(0, +prec);
      align = align || "<";
    }
    const w = +(width || 0);
    if (s.length >= w) return s;
    const padN = w - s.length;
    if (align === "<") return s + fill.repeat(padN);
    if (align === ">") return fill.repeat(padN) + s;
    const left = Math.floor(padN / 2);
    return fill.repeat(left) + s + fill.repeat(padN - left);
  }

  // Like Number#toFixed, but exact ties round to even as in Python.
  function toFixed(x, p) {
    const scaled = x * 10 ** p;
    if (Number.isFinite(scaled) && Math.abs(scaled) < 2 ** 52 && scaled % 1 === 0.5 && (scaled / 10 ** p) === x) {
      const down = Math.floor(scaled);
      return ((down % 2 === 0 ? down : down + 1) / 10 ** p).toFixed(p);
    }
    return x.toFixed(p);
  }

  function percentFormat(fmt, arg) {
    const args = isTuple(arg) ? arg.slice() : [arg];
    const byKey = arg instanceof PyDict;
    let k = 0;
    const next = () => { if (k >= args.length) throw new PyError("not enough arguments for format string"); return args[k++]; };
    const out = fmt.replace(/%(\([^)]*\))?([#0\- +]*)(\*|\d+)?(?:\.(\d+))?([diouxXeEfFgGcrsa%])/g, (m, key, flags, width, prec, conv) => {
      if (conv === "%") return "%";
      if (width === "*") width = String(next());
      const v = key ? arg.get(key.slice(1, -1)) : byKey ? arg : next();
      const left = flags.includes("-");
      let spec = left ? "<" : "";
      if (flags.includes("+")) spec += "+";
      else if (flags.includes(" ")) spec += " ";
      if (flags.includes("0") && !left && !"srac".includes(conv)) spec += "0";
      if (width) spec += width;
      if (prec !== undefined) spec += "." + prec;
      if (conv === "s" || conv === "a") return formatSpec(str(v), spec.replace(/[+ 0]/g, ""));
      if (conv === "r") return formatSpec(repr(v), spec.replace(/[+ 0]/g, ""));
      if (conv === "c") return typeof v === "string" ? v : String.fromCodePoint(v);
      if (conv === "i" || conv === "u") conv = "d";
      return formatSpec(conv === "d" ? Math.trunc(toNumber(v)) : v, spec + conv);
    });
    if (!byKey && k < args.length) throw new PyError("not all arguments converted during string formatting");
    return out;
  }

  function strFormat(fmt, args, kwargs) {
    let auto = 0;
    return fmt.replace(/\{\{|\}\}|\{([^{}!:]*)(?:!([rsa]))?(?::([^{}]*))?\}/g, (m, field, conv, spec) => {
      if (m === "{{") return "{";
      if (m === "}}") return "}";
      let v;
      const path = field.split(/(?=[.[])/);
      const head = path.shift();
      if (head === "") v = args[auto++];
      else if (/^\d+$/.test(head)) v = args[+head];
      else v = kwargs.get(head);
      for (const part of path) {
        if (part[0] === ".") v = getAttr(v, part.slice(1));
        else { const key = part.slice(1, -1); v = getItem(v, /^\d+$/.test(key) ? +key : key); }
      }
      if (v === undefined) throw new PyError(`Missing format argument '${field}'`);
      if (conv === "r") v = repr(v);
      else if (conv) v = str(v);
      return formatSpec(v, spec);
    });
  }

  // ---------------------------------------------------------------- sequences

  function len(v) {
    if (typeof v === "string" || Array.isArray(v)) return v.length;
    if (v instanceof PyDict || v instanceof PySet) return v.size;
    if (v instanceof NdArray) return Array.isArray(v.data) ? v.data.length : 0;
    if (v instanceof HostObject) return v.len();
    throw new PyError(`object of type '${typeName(v)}' has no len()`);
  }

  function iterate(v) {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === "string") return [...v];
    if (v instanceof PyDict) return v.keys();
    if (v instanceof PySet) return v.values();
    if (v instanceof NdArray) return Array.isArray(v.data) ? v.data.map((x) => (Array.isArray(x) ? new NdArray(x, v.dtype) : x)) : [v.data];
    if (v instanceof HostObject) return v.iter();
    throw new PyError(`'${typeName(v)}' object is not iterable`);
  }
  // Data that a slice, transpose or reshape copied (and the copy). In numpy those are views of
  // the same memory, but here they're copies, so writing to any part of either, under whatever
  // name (a row taken by x[0] before or after, a loop variable), is refused.
  const sharedData = new WeakSet();
  const markShared = (d) => { if (Array.isArray(d) && !sharedData.has(d)) { sharedData.add(d); d.forEach(markShared); } };
  function viewOf(base, data) {
    markShared(base.data);
    markShared(data);
    return new NdArray(data, base.dtype);
  }

  function sliceIndices(n, sl) {
    const step = sl.step === null || sl.step === undefined ? 1 : toNumber(sl.step);
    if (step === 0) throw new PyError("slice step cannot be zero");
    const norm = (x, def) => {
      if (x === null || x === undefined) return def;
      x = toNumber(x);
      if (x < 0) x += n;
      return step > 0 ? Math.min(Math.max(x, 0), n) : Math.min(Math.max(x, -1), n - 1);
    };
    const lo = norm(sl.lo, step > 0 ? 0 : n - 1), hi = norm(sl.hi, step > 0 ? n : -1);
    const out = [];
    for (let i = lo; step > 0 ? i < hi : i > hi; i += step) out.push(i);
    return out;
  }

  function normIndex(i, n) {
    i = toNumber(i);
    if (!Number.isInteger(i)) throw new PyError("indices must be integers");
    const j = i < 0 ? i + n : i;
    if (j < 0 || j >= n) throw new PyError("IndexError: index out of range");
    return j;
  }

  class Slice { constructor(lo, hi, step) { Object.assign(this, { lo, hi, step }); } }

  // The indices an array index key selects along one axis, and whether it removes the axis.
  function axisIndices(k, n) {
    if (k instanceof Slice) return { idx: sliceIndices(n, k), keep: true };
    if (Array.isArray(k)) {
      if (k.some((i) => typeof i === "boolean")) throw new UnsupportedError("Boolean mask indexing of arrays isn't supported");
      return { idx: k.map((i) => normIndex(i, n)), keep: true };
    }
    return { idx: [normIndex(k, n)], keep: false };
  }
  function ndGet(data, keys) {
    if (!keys.length) return data;
    const [k, ...rest] = keys;
    if (!Array.isArray(data)) throw new PyError("IndexError: too many indices for array");
    const { idx, keep } = axisIndices(k, data.length);
    return keep ? idx.map((i) => ndGet(data[i], rest)) : ndGet(data[idx[0]], rest);
  }
  // numpy assignment: value broadcasts to the selected region, and it's written into the existing
  // rows, so that rows taken earlier by integer index (views) see the change.
  function ndSet(data, keys, value, dtype) {
    const conv = (x) => {
      if (Array.isArray(x)) throw new PyError("ValueError: setting an array element with a sequence");
      if (dtype === "num" && !Number.isInteger(toNumber(x))) throw new UnsupportedError(AMBIGUOUS);
      return dtype === "int" ? Math.trunc(toNumber(x)) : dtype === "bool" ? truthy(x) : toNumber(x);
    };
    // the part of v that goes to element j of an axis of length n, in a region with `dims` axes
    const part = (v, dims, n, j) => {
      const vd = shapeOf(v).length;
      if (vd < dims) return v;
      if (vd > dims) { if (v.length !== 1) throw new PyError("ValueError: could not broadcast the value into the array"); return part(v[0], dims, n, j); }
      if (v.length === n) return v[j];
      if (v.length === 1) return v[0];
      throw new PyError(`ValueError: could not broadcast a sequence of length ${v.length} into ${n} elements`);
    };
    const into = (target, v) => {
      const dims = shapeOf(target).length;
      target.forEach((t, j) => { const pv = part(v, dims, target.length, j); if (Array.isArray(t)) into(t, pv); else target[j] = conv(pv); });
    };
    const region = (d, ks) => {
      if (!ks.length) return shapeOf(d).length;
      const { idx, keep } = axisIndices(ks[0], d.length);
      return (keep ? 1 : 0) + (idx.length ? region(d[idx[0]], ks.slice(1)) : shapeOf(d).length - 1);
    };
    const set = (d, ks, v) => {
      if (!Array.isArray(d)) throw new PyError("IndexError: too many indices for array");
      const [k, ...rest] = ks;
      const { idx, keep } = axisIndices(k, d.length);
      const dims = region(d, ks);
      idx.forEach((i, n) => {
        const pv = keep ? part(v, dims, idx.length, n) : v;
        if (rest.length) set(d[i], rest, pv);
        else if (Array.isArray(d[i])) into(d[i], pv);
        else d[i] = conv(shapeOf(pv).length ? (flatten(pv).length === 1 ? flatten(pv)[0] : pv) : pv);
      });
    };
    set(data, keys, ndData(value));
  }
  const refuseShared = (a) => {
    if (sharedData.has(a.data)) throw new UnsupportedError("Changing a NumPy array that shares its data with a slice, transpose or reshape of it isn't supported (use .copy())");
  };

  function getItem(obj, key) {
    if (obj instanceof HostObject) return obj.getitem(key);
    if (obj instanceof PyDict) {
      const v = obj.get(key);
      if (v === undefined) throw new PyError(`KeyError: ${repr(key)}`);
      return v;
    }
    if (obj instanceof NdArray) {
      const keys = isTuple(key) ? key : [key];
      const r = ndGet(obj.data, keys);
      if (!Array.isArray(r)) return r;
      // integer indices give the row itself (a view); fancy indexing a copy; slices a view,
      // which this copy only stands in for until something writes to either array
      if (keys.some(Array.isArray)) return new NdArray(structuredClone(r), obj.dtype);
      if (keys.some((k) => k instanceof Slice)) return viewOf(obj, structuredClone(r));
      return new NdArray(r, obj.dtype);
    }
    if (Array.isArray(obj) || typeof obj === "string") {
      if (key instanceof Slice) {
        const idx = sliceIndices(obj.length, key);
        if (typeof obj === "string") return idx.map((i) => obj[i]).join("");
        const r = idx.map((i) => obj[i]);
        return isTuple(obj) ? tuple(r) : r;
      }
      return obj[normIndex(key, obj.length)];
    }
    throw new PyError(`'${typeName(obj)}' object is not subscriptable`);
  }

  function setItem(obj, key, value) {
    if (obj instanceof HostObject) return obj.setitem(key, value);
    if (obj instanceof PyDict) return obj.set(key, value);
    if (obj instanceof NdArray) { refuseShared(obj); return ndSet(obj.data, isTuple(key) ? key : [key], value, obj.dtype); }
    if (Array.isArray(obj) && !isTuple(obj)) {
      if (key instanceof Slice) {
        const vals = iterate(value);
        if (key.step === null || key.step === undefined || key.step === 1) {
          const idx = sliceIndices(obj.length, key);
          const lo = idx.length ? idx[0] : Math.min(Math.max(key.lo === null ? 0 : key.lo < 0 ? key.lo + obj.length : key.lo, 0), obj.length);
          obj.splice(lo, idx.length, ...vals);
        } else {
          const idx = sliceIndices(obj.length, key);
          if (idx.length !== vals.length) throw new PyError("attempt to assign sequence of wrong size to extended slice");
          idx.forEach((i, n) => { obj[i] = vals[n]; });
        }
        return;
      }
      obj[normIndex(key, obj.length)] = value;
      return;
    }
    throw new PyError(`'${typeName(obj)}' object does not support item assignment`);
  }

  // ---------------------------------------------------------------- methods of built-in types

  function method(name, fn) { return new Builtin(name, fn); }
  const noKw = (kwargs, name) => { if (kwargs.size) throw new PyError(`${name}() got unexpected keyword arguments`); };

  function sortList(arr, kwargs, call) {
    const key = kwargs.get("key"), rev = truthy(kwargs.get("reverse") ?? false);
    const keyed = arr.map((v) => [key && key !== null ? call(key, [v]) : v, v]);
    keyed.sort((a, b) => compare(a[0], b[0]));
    if (rev) keyed.reverse();
    return keyed.map((x) => x[1]);
  }

  function strMethod(s, name, call) {
    const m = {
      format: (a, kw) => strFormat(s, a, kw),
      join: ([it]) => iterate(it).map((x) => { if (typeof x !== "string") throw new PyError("sequence item: expected str instance"); return x; }).join(s),
      split: ([sep = null, max = -1]) => {
        let parts = sep === null ? s.trim().split(/\s+/).filter((x) => x !== "") : s.split(sep);
        if (max >= 0 && parts.length > max + 1) parts = parts.slice(0, max).concat([parts.slice(max).join(sep === null ? " " : sep)]);
        return parts;
      },
      rsplit: ([sep = null]) => (sep === null ? s.trim().split(/\s+/) : s.split(sep)),
      splitlines: () => s.split(/\r?\n/),
      strip: ([c = null]) => stripChars(s, c, true, true),
      lstrip: ([c = null]) => stripChars(s, c, true, false),
      rstrip: ([c = null]) => stripChars(s, c, false, true),
      upper: () => s.toUpperCase(),
      lower: () => s.toLowerCase(),
      capitalize: () => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
      title: () => s.toLowerCase().replace(/(^|[^A-Za-z])([a-z])/g, (x, a, b) => a + b.toUpperCase()),
      replace: ([a, b, n = -1]) => { let out = s, k = 0; if (n < 0) return s.split(a).join(b); while (k < n && out.includes(a)) { out = out.replace(a, b); k++; } return out; },
      startswith: ([p]) => (isTuple(p) ? p.some((x) => s.startsWith(x)) : s.startsWith(p)),
      endswith: ([p]) => (isTuple(p) ? p.some((x) => s.endsWith(x)) : s.endsWith(p)),
      find: ([x]) => s.indexOf(x),
      index: ([x]) => { const i = s.indexOf(x); if (i < 0) throw new PyError("substring not found"); return i; },
      count: ([x]) => s.split(x).length - 1,
      zfill: ([w]) => (s[0] === "-" ? "-" + s.slice(1).padStart(w - 1, "0") : s.padStart(w, "0")),
      center: ([w, f = " "]) => formatSpec(s, `${f}^${w}`),
      ljust: ([w, f = " "]) => s.padEnd(w, f),
      rjust: ([w, f = " "]) => s.padStart(w, f),
      isdigit: () => /^\d+$/.test(s),
      isnumeric: () => /^\d+$/.test(s),
      isalpha: () => /^[A-Za-z]+$/.test(s),
      isalnum: () => /^[A-Za-z0-9]+$/.test(s),
      isupper: () => s === s.toUpperCase() && s !== s.toLowerCase(),
      islower: () => s === s.toLowerCase() && s !== s.toUpperCase(),
      encode: () => s,
      decode: () => s,
    }[name];
    if (!m) throw new PyError(`'str' object has no attribute '${name}'`);
    return method(name, m);
  }
  function stripChars(s, chars, left, right) {
    const set = chars === null ? " \t\n\r\f\v" : chars;
    let a = 0, b = s.length;
    if (left) while (a < b && set.includes(s[a])) a++;
    if (right) while (b > a && set.includes(s[b - 1])) b--;
    return s.slice(a, b);
  }

  function listMethod(l, name, call) {
    const tupleOnly = new Set(["index", "count"]);
    if (isTuple(l) && !tupleOnly.has(name)) throw new PyError(`'tuple' object has no attribute '${name}'`);
    const m = {
      append: ([x]) => { l.push(x); return null; },
      extend: ([x]) => { l.push(...iterate(x)); return null; },
      insert: ([i, x]) => { l.splice(i < 0 ? Math.max(0, l.length + i) : i, 0, x); return null; },
      pop: ([i = -1]) => { if (!l.length) throw new PyError("pop from empty list"); return l.splice(normIndex(i, l.length), 1)[0]; },
      remove: ([x]) => { const i = l.findIndex((y) => eq(x, y)); if (i < 0) throw new PyError("list.remove(x): x not in list"); l.splice(i, 1); return null; },
      index: ([x]) => { const i = l.findIndex((y) => eq(x, y)); if (i < 0) throw new PyError(`${repr(x)} is not in list`); return i; },
      count: ([x]) => l.filter((y) => eq(x, y)).length,
      reverse: () => { l.reverse(); return null; },
      sort: (a, kw) => { const s = sortList(l, kw, call); l.splice(0, l.length, ...s); return null; },
      copy: () => l.slice(),
      clear: () => { l.length = 0; return null; },
    }[name];
    if (!m) throw new PyError(`'${typeName(l)}' object has no attribute '${name}'`);
    return method(name, m);
  }

  function dictMethod(d, name) {
    const m = {
      items: () => d.entries().map(([k, v]) => tuple([k, v])),
      keys: () => d.keys(),
      values: () => d.values(),
      get: ([k, def = null]) => (d.has(k) ? d.get(k) : def),
      pop: ([k, def]) => { if (d.has(k)) { const v = d.get(k); d.delete(k); return v; } if (def === undefined) throw new PyError(`KeyError: ${repr(k)}`); return def; },
      setdefault: ([k, def = null]) => { if (!d.has(k)) d.set(k, def); return d.get(k); },
      update: ([other], kw) => { if (other) for (const [k, v] of toDictEntries(other)) d.set(k, v); for (const [k, v] of kw) d.set(k, v); return null; },
      copy: () => new PyDict(d.entries()),
      clear: () => { d.m.clear(); return null; },
    }[name];
    if (!m) throw new PyError(`'dict' object has no attribute '${name}'`);
    return method(name, m);
  }
  function toDictEntries(v) {
    if (v instanceof PyDict) return v.entries();
    return iterate(v).map((pair) => { const p = iterate(pair); if (p.length !== 2) throw new PyError("dictionary update sequence element has wrong length"); return p; });
  }

  function setMethod(s, name) {
    const m = {
      add: ([x]) => { s.add(x); return null; },
      update: ([x]) => { for (const v of iterate(x)) s.add(v); return null; },
      remove: ([x]) => { if (!s.delete(x)) throw new PyError(`KeyError: ${repr(x)}`); return null; },
      discard: ([x]) => { s.delete(x); return null; },
      union: ([x]) => new PySet([...s.values(), ...iterate(x)]),
      intersection: ([x]) => { const o = new PySet(iterate(x)); return new PySet(s.values().filter((v) => o.has(v))); },
      difference: ([x]) => { const o = new PySet(iterate(x)); return new PySet(s.values().filter((v) => !o.has(v))); },
      copy: () => new PySet(s.values()),
    }[name];
    if (!m) throw new PyError(`'set' object has no attribute '${name}'`);
    return method(name, m);
  }

  function ndShape(d) { const s = []; while (Array.isArray(d)) { s.push(d.length); d = d[0]; } return s; }
  function reshape(flat, shape) {
    const total = flat.length;
    const known = shape.filter((x) => x !== -1).reduce((a, b) => a * b, 1);
    shape = shape.map((x) => (x === -1 ? total / known : x));
    if (shape.reduce((a, b) => a * b, 1) !== total) throw new PyError(`cannot reshape array of size ${total} into shape ${str(tuple(shape))}`);
    const build = (off, dims) => {
      if (!dims.length) return flat[off];
      const [n, ...rest] = dims;
      const size = rest.reduce((a, b) => a * b, 1);
      return Array.from({ length: n }, (_, i) => build(off + i * size, rest));
    };
    return build(0, shape);
  }

  function ndMethod(a, name) {
    const m = {
      tolist: () => structuredClone(a.data),
      flatten: () => new NdArray(flatten(a.data), a.dtype),
      ravel: () => viewOf(a, flatten(a.data)),
      copy: () => new NdArray(structuredClone(a.data), a.dtype),
      astype: ([t]) => astype(a, t),
      reshape: (args) => viewOf(a, reshape(flatten(a.data), (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map(toNumber))),
      sum: (args, kw) => reduceAxis(a, args[0] ?? kw.get("axis") ?? null, "sum"),
      mean: (args, kw) => reduceAxis(a, args[0] ?? kw.get("axis") ?? null, "mean"),
      max: (args, kw) => reduceAxis(a, args[0] ?? kw.get("axis") ?? null, "max"),
      min: (args, kw) => reduceAxis(a, args[0] ?? kw.get("axis") ?? null, "min"),
      item: () => flatten(a.data)[0],
    }[name];
    if (name === "shape") return tuple(ndShape(a.data));
    if (name === "size") return flatten(a.data).length;
    if (name === "ndim") return ndShape(a.data).length;
    if (name === "T") return viewOf(a, transpose(a.data));
    if (name === "dtype") return a.dtype === "float" ? "float64" : a.dtype === "int" ? "int64" : "bool";
    if (!m) throw new PyError(`'numpy.ndarray' object has no attribute '${name}'`);
    return method(name, m);
  }
  function transpose(d) {
    const shape = ndShape(d);
    if (shape.length < 2) return structuredClone(d);
    if (shape.length > 2) throw new PyError("Transposing arrays with more than two axes is not supported");
    return Array.from({ length: shape[1] }, (_, j) => d.map((row) => row[j]));
  }
  // dtype conversion: int truncates toward zero, bool tests for nonzero.
  function astype(a, t) {
    const name = t instanceof Builtin ? t.name : String(t);
    const kind = /^(int|int8|int16|int32|int64|uint8|uint32|uint64)$/.test(name) ? "int" : /^(float|float16|float32|float64|double)$/.test(name) ? "float" : /^(bool|bool_)$/.test(name) ? "bool" : null;
    if (!kind) throw new UnsupportedError(`astype(${name}) isn't supported`);
    const conv = kind === "int" ? (v) => Math.trunc(toNumber(v)) : kind === "bool" ? (v) => toNumber(v) !== 0 : (v) => toNumber(v);
    return new NdArray(flatMap(a.data, conv), kind);
  }
  // sum, mean, max or min over all elements (axis None) or along one axis, as numpy does.
  function reduceAxis(a, axis, op) {
    const d = ndData(a);
    const f = (xs) => {
      xs = xs.map(toNumber);
      if (!xs.length && (op === "max" || op === "min")) throw new PyError("ValueError: zero-size array to reduction operation");
      return op === "sum" ? xs.reduce((x, y) => x + y, 0) : op === "mean" ? xs.reduce((x, y) => x + y, 0) / xs.length : op === "max" ? Math.max(...xs) : Math.min(...xs);
    };
    if (axis === null || axis === undefined) return f(flatten(d));
    const shape = shapeOf(d);
    if (!Number.isInteger(axis)) throw new UnsupportedError("Reducing over several axes at once isn't supported");
    const ax = axis < 0 ? axis + shape.length : axis;
    if (ax < 0 || ax >= shape.length) throw new PyError(`AxisError: axis ${axis} is out of bounds for array of dimension ${shape.length}`);
    const rec = (x, k) => {
      if (k === ax) {
        // collect the elements along this axis for each position of the remaining axes
        const gather = (items) => (Array.isArray(items[0]) ? items[0].map((_, i) => gather(items.map((r) => r[i]))) : f(items));
        return x.length ? gather(x) : f([]);
      }
      return x.map((y) => rec(y, k + 1));
    };
    const out = rec(d, 0);
    return Array.isArray(out) ? new NdArray(out, op === "mean" ? "float" : dtypeOf(a) === "bool" && op === "sum" ? "int" : dtypeOf(a)) : out;
  }


  // ---------------------------------------------------------------- interpreter

  class BreakSignal {}
  class StopScript {}
  class ContinueSignal {}
  class ReturnSignal { constructor(v) { this.value = v; } }

  class Scope {
    constructor(parent, globals) {
      this.vars = new Map();
      this.parent = parent;
      this.globals = globals || this;
      this.declared = null; // names declared global/nonlocal
    }
    lookup(name) {
      for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
      return undefined;
    }
    assign(name, value) {
      if (this.declared && this.declared.has(name)) {
        const target = this.declared.get(name);
        target.vars.set(name, value);
        return;
      }
      this.vars.set(name, value);
    }
  }

  // Runs `src`. Options:
  //   resolveModule(name) -> value or undefined (undefined: an inert stand-in is used)
  //   builtins: extra builtin names
  //   onStatementError(error, line): called when a top-level statement fails; execution continues
  //   maxSteps: execution budget
  // Returns {globals: Map, comments}.
  function run(src, options = {}) {
    const { toks, comments } = tokenize(src);
    let program;
    try { program = parse(toks).module(); }
    catch (err) { if (err instanceof RangeError) throw new PyError("The script is too deeply nested to read"); throw err; }
    // Budgets: each top-level statement may take maxSteps; the whole script maxTotalSteps.
    const maxSteps = options.maxSteps || 2e6, maxTotal = options.maxTotalSteps || 1e7;
    let steps = 0, total = 0, depth = 0;
    const tick = () => {
      if (++steps > maxSteps) throw new PyError("This statement ran too long and was stopped (an endless loop?)");
      if (++total > maxTotal) throw new StopScript();
    };

    const builtins = makeBuiltins(callValue);
    globalCall = callValue;
    if (options.builtins) for (const [k, v] of Object.entries(options.builtins)) builtins.set(k, v);
    const globals = new Scope(null);
    globals.vars.set("__name__", "__main__");
    const modules = new Map();
    const handling = []; // exceptions being handled, innermost last, for a bare raise

    function importModule(name) {
      if (modules.has(name)) return modules.get(name);
      let m = options.resolveModule ? options.resolveModule(name) : undefined;
      if (m === undefined) m = stdModule(name);
      if (m === undefined) m = new Opaque(name);
      modules.set(name, m);
      return m;
    }

    function lookup(scope, name, line) {
      const v = scope.lookup(name);
      if (v !== undefined) return v;
      if (builtins.has(name)) return builtins.get(name);
      throw new PyError(`Unknown name '${name}'${line ? ` on line ${line}` : ""}`);
    }

    function evalExpr(e, scope) {
      switch (e.t) {
        case "lit": return e.v;
        case "name": return lookup(scope, e.name, e.line);
        case "fstr": return e.parts.map((part) => {
          if (typeof part === "string") return part;
          let v = evalExpr(part.e, scope);
          if (part.conv === "r") v = repr(v);
          else if (part.conv) v = str(v);
          const spec = part.spec ? part.spec.map((x) => (typeof x === "string" ? x : str(evalExpr(x.e, scope)))).join("") : "";
          return formatSpec(v, spec);
        }).join("");
        case "tuple": return tuple(evalItems(e.items, scope));
        case "list": return evalItems(e.items, scope);
        case "set": return new PySet(evalItems(e.items, scope));
        case "dict": {
          const d = new PyDict();
          for (const [k, v] of e.entries) {
            if (k === null) { for (const [kk, vv] of toDictEntries(evalExpr(v, scope))) d.set(kk, vv); }
            else d.set(evalExpr(k, scope), evalExpr(v, scope));
          }
          return d;
        }
        case "comp": return evalComp(e, scope);
        case "attr": return getAttr(evalExpr(e.obj, scope), e.name);
        case "index": {
          const obj = evalExpr(e.obj, scope);
          return getItem(obj, evalKey(e.key, scope));
        }
        case "slice": return new Slice(e.lo && evalExpr(e.lo, scope), e.hi && evalExpr(e.hi, scope), e.step && evalExpr(e.step, scope));
        case "call": {
          const fn = evalExpr(e.fn, scope);
          const args = [], kwargs = new Map();
          for (const a of e.args) {
            if (a.kind === "pos") args.push(evalExpr(a.e, scope));
            else if (a.kind === "*") args.push(...iterate(evalExpr(a.e, scope)));
            else if (a.kind === "**") for (const [k, v] of toDictEntries(evalExpr(a.e, scope))) kwargs.set(k, v);
            else kwargs.set(a.name, evalExpr(a.e, scope));
          }
          return callValue(fn, args, kwargs);
        }
        case "bin": return binop(e.op, evalExpr(e.left, scope), evalExpr(e.right, scope));
        case "unary": {
          const v = evalExpr(e.e, scope);
          if (v instanceof NdArray) return elementwise(e.op === "-" ? "*" : "+", v, e.op === "-" ? -1 : 0);
          if (v instanceof Opaque) return v;
          if (v instanceof HostObject) { const r = v.binop(e.op === "-" ? "neg" : e.op, v, null); if (r !== undefined) return r; }
          const n = toNumber(v);
          return e.op === "-" ? -n : e.op === "~" ? ~n : n;
        }
        case "and": { const a = evalExpr(e.left, scope); return truthy(a) ? evalExpr(e.right, scope) : a; }
        case "or": { const a = evalExpr(e.left, scope); return truthy(a) ? a : evalExpr(e.right, scope); }
        case "not": return !truthy(evalExpr(e.e, scope));
        case "cmp": {
          let left = evalExpr(e.values[0], scope);
          for (let i = 0; i < e.ops.length; i++) {
            const right = evalExpr(e.values[i + 1], scope);
            const r = compareOp(e.ops[i], left, right);
            // a single comparison returns its result as is: an array of booleans, or a stand-in
            if (e.ops.length === 1) return r;
            if (!truthy(r)) return false;
            left = right;
          }
          return true;
        }
        case "ifexp": return truthy(evalExpr(e.test, scope)) ? evalExpr(e.body, scope) : evalExpr(e.orelse, scope);
        case "lambda": return new PyFunction("<lambda>", evalDefaults(e.params, scope), e.body, scope, true);
        case "walrus": { const v = evalExpr(e.value, scope); scope.assign(e.name, v); return v; }
        case "star": throw new PyError("Starred expression is not allowed here");
      }
      throw new PyError(`Unsupported expression ${e.t}`);
    }

    function evalKey(key, scope) {
      if (key.t === "tuple") return tuple(key.items.map((k) => evalExpr(k, scope)));
      return evalExpr(key, scope);
    }

    function evalItems(items, scope) {
      const out = [];
      for (const it of items) {
        if (it.t === "star") out.push(...iterate(evalExpr(it.e, scope)));
        else out.push(evalExpr(it, scope));
      }
      return out;
    }

    function evalComp(e, scope) {
      const inner = new Scope(scope, scope.globals);
      const out = e.kind === "dict" ? new PyDict() : e.kind === "set" ? new PySet() : [];
      const loop = (g) => {
        if (g === e.gens.length) {
          if (e.kind === "dict") out.set(evalExpr(e.elt, inner), evalExpr(e.value, inner));
          else if (e.kind === "set") out.add(evalExpr(e.elt, inner));
          else out.push(evalExpr(e.elt, inner));
          return;
        }
        const gen = e.gens[g];
        // the first iterable is evaluated in the enclosing scope, like Python
        for (const v of iterate(evalExpr(gen.iter, g === 0 ? scope : inner))) {
          tick();
          assignTarget(gen.target, v, inner);
          if (gen.ifs.every((c) => truthy(evalExpr(c, inner)))) loop(g + 1);
        }
      };
      loop(0);
      return out;
    }

    function compareOp(op, a, b) {
      if ((a instanceof Opaque || b instanceof Opaque) && op !== "is" && op !== "is not") {
        if (op === "in" || op === "not in") throw opaqueUse(a instanceof Opaque ? a : b, "search");
        return a instanceof Opaque ? a : b;
      }
      // numpy compares elementwise, giving an array of booleans
      if ((a instanceof NdArray || b instanceof NdArray) && ["==", "!=", "<", ">", "<=", ">="].includes(op)) return elementwise(op, a, b);
      switch (op) {
        case "==": return eq(a, b);
        case "!=": return !eq(a, b);
        case "<": return compare(a, b) < 0;
        case ">": return compare(a, b) > 0;
        case "<=": return compare(a, b) <= 0;
        case ">=": return compare(a, b) >= 0;
        case "is": return a === b || (a === null && b === undefined) || (a === undefined && b === null);
        case "is not": return !compareOp("is", a, b);
        case "in": return contains(b, a);
        case "not in": return !contains(b, a);
      }
      throw new PyError(`Unsupported comparison ${op}`);
    }

    function contains(container, x) {
      if (typeof container === "string") return container.includes(x);
      if (Array.isArray(container)) return container.some((y) => eq(x, y));
      if (container instanceof PyDict || container instanceof PySet) return container.has(x);
      if (container instanceof NdArray) return flatten(container.data).some((y) => eq(x, y));
      if (container instanceof HostObject) return container.contains ? container.contains(x) : iterate(container).some((y) => eq(x, y));
      throw new PyError(`argument of type '${typeName(container)}' is not iterable`);
    }

    function evalDefaults(params, scope) {
      return params.map((p) => Object.assign({}, p, { defVal: p.def ? evalExpr(p.def, scope) : undefined }));
    }

    function callValue(fn, args, kwargs = new Map()) {
      tick();
      if (fn instanceof Builtin) return fn.fn(args, kwargs);
      if (fn instanceof PyFunction) {
        if (++depth > 150) throw new PyError("Maximum recursion depth exceeded");
        try {
          const scope = new Scope(fn.closure, fn.closure.globals);
          bindParams(fn, args, kwargs, scope);
          if (fn.isLambda) return evalExpr(fn.body, scope);
          try { execBlock(fn.body, scope, false); } catch (sig) { if (sig instanceof ReturnSignal) return sig.value; throw sig; }
          return null;
        } finally { depth--; }
      }
      if (fn instanceof HostObject) return fn.call(args, kwargs);
      throw new PyError(`'${typeName(fn)}' object is not callable`);
    }

    function bindParams(fn, args, kwargs, scope) {
      const kw = new Map(kwargs);
      let ai = 0;
      for (const p of fn.params) {
        if (p.kind === "varargs") { scope.vars.set(p.name, tuple(args.slice(ai))); ai = args.length; continue; }
        if (p.kind === "varkw") { scope.vars.set(p.name, new PyDict([...kw])); kw.clear(); continue; }
        let v;
        if (p.kind === "pos" && ai < args.length) v = args[ai++];
        else if (kw.has(p.name)) { v = kw.get(p.name); kw.delete(p.name); }
        else if (p.defVal !== undefined) v = p.defVal;
        else throw new PyError(`${fn.name}() missing required argument '${p.name}'`);
        scope.vars.set(p.name, v);
      }
      if (ai < args.length) throw new PyError(`${fn.name}() takes ${ai} positional arguments but ${args.length} were given`);
      if (kw.size) throw new PyError(`${fn.name}() got an unexpected keyword argument '${[...kw.keys()][0]}'`);
    }

    function assignTarget(t, value, scope) {
      switch (t.t) {
        case "name": scope.assign(t.name, value); return;
        case "tuple": case "list": {
          if (value instanceof Opaque) { t.items.forEach((x) => assignTarget(x.t === "star" ? x.e : x, value, scope)); return; }
          const vals = iterate(value);
          const star = t.items.findIndex((x) => x.t === "star");
          if (star < 0) {
            if (vals.length !== t.items.length) throw new PyError(`Cannot unpack ${vals.length} values into ${t.items.length} names`);
            t.items.forEach((x, i) => assignTarget(x, vals[i], scope));
          } else {
            const after = t.items.length - star - 1;
            if (vals.length < t.items.length - 1) throw new PyError("Not enough values to unpack");
            t.items.slice(0, star).forEach((x, i) => assignTarget(x, vals[i], scope));
            assignTarget(t.items[star].e, vals.slice(star, vals.length - after), scope);
            t.items.slice(star + 1).forEach((x, i) => assignTarget(x, vals[vals.length - after + i], scope));
          }
          return;
        }
        case "index": setItem(evalExpr(t.obj, scope), evalKey(t.key, scope), value); return;
        case "attr": {
          const obj = evalExpr(t.obj, scope);
          if (obj instanceof HostObject) obj.setattr(t.name, value);
          else throw new PyError(`Cannot set attribute '${t.name}' on '${typeName(obj)}'`);
          return;
        }
      }
      throw new PyError("Unsupported assignment target");
    }

    // Runs statements. With `recover`, a failing statement is reported and the next one runs —
    // used for module-level code so one unsupported line does not stop the import.
    function execBlock(stmts, scope, recover) {
      for (const s of stmts) {
        if (!recover) { exec(s, scope, false); continue; }
        steps = 0;
        depth = 0;
        const randomBefore = randomCount;
        try { exec(s, scope, true); }
        catch (err) {
          if (!(err instanceof PyError) && !(err instanceof RangeError)) throw err;
          const msg = err instanceof RangeError ? "This statement is too deeply nested or builds a value that is too large" : err.message;
          if (options.onStatementError) options.onStatementError(msg, s.line);
          // names this statement would have set become inert, so later lines using them run quietly
          for (const name of boundNames(s)) if (scope.lookup(name) === undefined) scope.assign(name, new Opaque(`<failed line ${s.line}>`));
        } finally {
          if (options.afterStatement) options.afterStatement({ line: s.line, usedRandom: randomCount !== randomBefore });
        }
      }
    }

    function boundNames(s) {
      const out = [];
      const fromTarget = (t) => {
        if (t.t === "name") out.push(t.name);
        else if (t.t === "tuple" || t.t === "list") t.items.forEach((x) => fromTarget(x.t === "star" ? x.e : x));
      };
      const blocks = [];
      if (s.t === "assign") s.targets.forEach(fromTarget);
      else if (s.t === "augassign") fromTarget(s.target);
      else if (s.t === "def" || s.t === "class") out.push(s.name);
      else if (s.t === "for") { fromTarget(s.target); blocks.push(s.body); }
      else if (s.t === "while") blocks.push(s.body);
      else if (s.t === "with") { s.items.forEach((it) => it.target && fromTarget(it.target)); blocks.push(s.body); }
      else if (s.t === "if") blocks.push(...s.branches.map((b) => b.body));
      else if (s.t === "try") blocks.push(s.body, ...s.handlers.map((h) => h.body));
      if (s.orelse) blocks.push(s.orelse);
      for (const b of blocks) for (const x of b) out.push(...boundNames(x));
      return out;
    }

    function exec(s, scope, recover) {
      tick();
      switch (s.t) {
        case "expr": evalExpr(s.e, scope); return;
        case "assign": {
          const v = evalExpr(s.value, scope);
          for (const t of s.targets) assignTarget(t, v, scope);
          return;
        }
        case "augassign": {
          const t = s.target;
          let cur, set;
          if (t.t === "name") { cur = lookup(scope, t.name); set = (v) => scope.assign(t.name, v); }
          else if (t.t === "index") { const o = evalExpr(t.obj, scope), k = evalKey(t.key, scope); cur = getItem(o, k); set = (v) => setItem(o, k, v); }
          else if (t.t === "attr") { const o = evalExpr(t.obj, scope); cur = getAttr(o, t.name); set = (v) => assignTarget(t, v, scope); }
          else throw new PyError("Unsupported augmented assignment");
          const v = evalExpr(s.value, scope);
          if (s.op === "+" && Array.isArray(cur) && !isTuple(cur)) { cur.push(...iterate(v)); set(cur); return; }
          // numpy arrays are updated in place (other names for the same array see the change)
          if (cur instanceof NdArray && Array.isArray(cur.data)) {
            refuseShared(cur);
            const r = binop(s.op, cur, v);
            // numpy keeps the array's dtype, and refuses to cast a float result into an int array
            if (cur.dtype === "int" && r.dtype === "float") throw new PyError(`UFuncTypeError: Cannot cast ufunc output from dtype('float64') to dtype('int64') with casting rule 'same_kind'`);
            if ((cur.dtype === "int" && r.dtype === "num") || (cur.dtype === "num" && r.dtype === "float")) throw new UnsupportedError(AMBIGUOUS);
            if (shapeOf(r.data).join() !== shapeOf(cur.data).join()) throw new PyError("ValueError: non-broadcastable output operand");
            ndSet(cur.data, [new Slice(null, null, null)], r, cur.dtype);
            return;
          }
          set(binop(s.op, cur, v));
          return;
        }
        case "pass": return;
        case "error": throw new PyError(s.message.replace(/ on line \d+$/, ""));
        case "if": {
          for (const b of s.branches) {
            if (truthy(evalExpr(b.test, scope))) { execBlock(b.body, scope, recover); return; }
          }
          if (s.orelse) execBlock(s.orelse, scope, recover);
          return;
        }
        case "for": {
          const items = iterate(evalExpr(s.iter, scope));
          let broke = false;
          for (const v of items) {
            tick();
            assignTarget(s.target, v, scope);
            try { execBlock(s.body, scope, false); }
            catch (sig) {
              if (sig instanceof BreakSignal) { broke = true; break; }
              if (sig instanceof ContinueSignal) continue;
              throw sig;
            }
          }
          if (!broke && s.orelse) execBlock(s.orelse, scope, recover);
          return;
        }
        case "while": {
          let broke = false;
          while (truthy(evalExpr(s.test, scope))) {
            tick();
            try { execBlock(s.body, scope, false); }
            catch (sig) {
              if (sig instanceof BreakSignal) { broke = true; break; }
              if (sig instanceof ContinueSignal) continue;
              throw sig;
            }
          }
          if (!broke && s.orelse) execBlock(s.orelse, scope, recover);
          return;
        }
        case "break": throw new BreakSignal();
        case "continue": throw new ContinueSignal();
        case "return": throw new ReturnSignal(s.value ? evalExpr(s.value, scope) : null);
        case "def": scope.assign(s.name, new PyFunction(s.name, evalDefaults(s.params, scope), s.body, scope, false)); return;
        case "class": scope.assign(s.name, new Opaque(s.name)); throw new PyError(`Class definitions are not supported (class ${s.name})`);
        case "global": case "nonlocal": {
          if (!scope.declared) scope.declared = new Map();
          for (const n of s.names) {
            let target = scope.globals;
            if (s.t === "nonlocal") { for (let sc = scope.parent; sc; sc = sc.parent) if (sc.vars.has(n)) { target = sc; break; } }
            scope.declared.set(n, target);
          }
          return;
        }
        case "del": {
          const targets = s.targets.t === "tuple" ? s.targets.items : [s.targets];
          for (const t of targets) {
            if (t.t === "name") scope.vars.delete(t.name);
            else if (t.t === "index") {
              const o = evalExpr(t.obj, scope), k = evalKey(t.key, scope);
              if (o instanceof PyDict) o.delete(k);
              else if (Array.isArray(o)) o.splice(normIndex(k, o.length), 1);
              else if (o instanceof HostObject && o.delitem) o.delitem(k);
            }
          }
          return;
        }
        case "raise": {
          if (!s.value) { if (handling.length) throw handling.at(-1); throw new PyError("RuntimeError: No active exception to reraise"); }
          const v = evalExpr(s.value, scope);
          // ValueError("x") evaluates to "ValueError: x"; a bare ValueError is the builtin
          if (v instanceof Builtin && EXCEPTION_BASES[v.name]) throw new PyError(`${v.name}: `);
          if (typeof v === "string" && /^[A-Z]\w*: /.test(v)) throw new PyError(v);
          throw new PyError(`TypeError: exceptions must derive from BaseException (raised ${str(v)})`);
        }
        case "assert": {
          if (!truthy(evalExpr(s.test, scope))) throw new PyError(`AssertionError: ${s.msg ? str(evalExpr(s.msg, scope)) : `the assert on line ${s.line} failed`}`);
          return;
        }
        case "import": {
          for (const { module: name, alias } of s.names) {
            if (alias) scope.assign(alias, importModule(name));
            else {
              const top = name.split(".")[0];
              scope.assign(top, importModule(top));
            }
          }
          return;
        }
        case "from": {
          const mod = importModule(s.module);
          for (const { name, alias } of s.names) {
            if (name === "*") {
              if (mod instanceof HostObject && mod.exports) for (const [k, v] of mod.exports()) scope.assign(k, v);
              continue;
            }
            let v;
            try { v = getAttr(mod, name); } catch { v = importModule(`${s.module}.${name}`); }
            scope.assign(alias || name, v);
          }
          return;
        }
        case "try": {
          let failed = false;
          try {
            try { execBlock(s.body, scope, false); }
            catch (err) {
              const h = s.handlers.find((x) => catches(x.types, err));
              if (!h) throw err;
              failed = true;
              if (h.name) scope.assign(h.name, err.message.replace(/^\w+: /, ""));
              handling.push(err);
              try { execBlock(h.body, scope, recover); } finally { handling.pop(); }
            }
            if (!failed && s.orelse) execBlock(s.orelse, scope, recover);
          } finally {
            if (s.final) execBlock(s.final, scope, recover);
          }
          return;
        }
        case "with": {
          for (const it of s.items) {
            const v = evalExpr(it.e, scope);
            if (it.target) assignTarget(it.target, v, scope);
          }
          execBlock(s.body, scope, recover);
          return;
        }
      }
      throw new PyError(`Unsupported statement ${s.t}`);
    }

    try {
      execBlock(program, globals, true);
    } catch (sig) {
      if (sig instanceof StopScript) {
        if (options.onStatementError) options.onStatementError("The script ran too long and was stopped", 0);
      } else if (sig instanceof ReturnSignal || sig instanceof BreakSignal || sig instanceof ContinueSignal) {
        if (options.onStatementError) options.onStatementError("'return', 'break' or 'continue' outside a function or loop", 0);
      } else throw sig;
    }
    return { globals: globals.vars, comments, callValue };
  }

  function getAttr(obj, name) {
    if (obj instanceof HostObject) return obj.getattr(name);
    if (typeof obj === "string") return strMethod(obj, name);
    if (Array.isArray(obj)) return listMethod(obj, name, globalCall);
    if (obj instanceof PyDict) return dictMethod(obj, name);
    if (obj instanceof PySet) return setMethod(obj, name);
    if (obj instanceof NdArray) return ndMethod(obj, name);
    if (typeof obj === "number") {
      if (name === "is_integer") return method(name, () => Number.isInteger(obj));
      if (name === "real") return obj;
      if (name === "imag") return 0;
    }
    if ((obj instanceof PyFunction || obj instanceof Builtin) && name === "__name__") return obj.name;
    throw new PyError(`'${typeName(obj)}' object has no attribute '${name}'`);
  }
  // list.sort(key=...) needs to call Python functions; set while a script runs.
  let globalCall = null;

  // ---------------------------------------------------------------- builtins and standard modules

  function toInt(v, base) {
    if (typeof v === "string") {
      const n = base ? parseInt(v.trim(), base) : Number(v.trim().replace(/_/g, ""));
      if (!Number.isFinite(n) || (!base && !/^[+-]?\d[\d_]*$/.test(v.trim()))) throw new PyError(`invalid literal for int(): ${repr(v)}`);
      return n;
    }
    return Math.trunc(toNumber(v));
  }
  function toFloat(v) {
    if (typeof v === "string") {
      const t = v.trim().toLowerCase();
      if (t === "inf" || t === "+inf" || t === "infinity") return Infinity;
      if (t === "-inf" || t === "-infinity") return -Infinity;
      if (t === "nan") return NaN;
      const n = Number(t.replace(/_/g, ""));
      if (t === "" || !Number.isFinite(n)) throw new PyError(`could not convert string to float: ${repr(v)}`);
      return n;
    }
    return toNumber(v);
  }

  function pyRound(x, nd) {
    x = toNumber(x);
    if (nd === undefined || nd === null) {
      const r = Math.round(x);
      return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
    }
    const f = 10 ** nd;
    const y = x * f;
    let r = Math.round(y);
    if (Math.abs(y % 1) === 0.5 && r % 2 !== 0) r -= 1;
    return +(r / f).toFixed(Math.max(0, nd));
  }

  function makeBuiltins(call) {
    const b = new Map();
    const def = (name, fn) => b.set(name, new Builtin(name, fn));
    const noop = () => null;
    def("print", noop); def("display", noop); def("help", noop);
    def("len", ([x]) => len(x));
    def("range", (a) => {
      const [start, stop, step = 1] = a.length > 1 ? a.map(toNumber) : [0, toNumber(a[0])];
      if (step === 0) throw new PyError("range() arg 3 must not be zero");
      const n = Math.max(0, Math.ceil((stop - start) / step));
      checkSize(n);
      return Array.from({ length: n }, (_, i) => start + i * step);
    });
    def("enumerate", ([it, start = 0]) => iterate(it).map((v, i) => tuple([i + start, v])));
    def("zip", (args) => {
      const lists = args.map(iterate);
      const n = lists.length ? Math.min(...lists.map((l) => l.length)) : 0;
      return Array.from({ length: n }, (_, i) => tuple(lists.map((l) => l[i])));
    });
    def("sum", ([it, start = 0]) => iterate(it).reduce((a, v) => binop("+", a, v), start));
    const minmax = (sign) => (args, kw) => {
      const items = args.length === 1 ? iterate(args[0]) : args;
      if (!items.length) { if (kw.has("default")) return kw.get("default"); throw new PyError("arg is an empty sequence"); }
      const key = kw.get("key");
      let best = items[0], bk = key ? call(key, [best]) : best;
      for (const v of items.slice(1)) { const k = key ? call(key, [v]) : v; if (compare(k, bk) * sign > 0) { best = v; bk = k; } }
      return best;
    };
    def("min", minmax(-1)); def("max", minmax(1));
    def("abs", ([x]) => (x instanceof NdArray ? new NdArray(flatMap(x.data, (v) => Math.abs(toNumber(v))), x.dtype === "bool" ? "int" : x.dtype) : Math.abs(toNumber(x))));
    def("round", ([x, nd]) => pyRound(x, nd));
    def("pow", ([a, c]) => toNumber(a) ** toNumber(c));
    def("divmod", ([a, c]) => tuple([Math.floor(a / c), pyMod(a, c)]));
    def("str", ([x = ""]) => str(x));
    def("repr", ([x]) => repr(x));
    def("int", ([x = 0, base]) => toInt(x, base));
    def("float", ([x = 0]) => toFloat(x));
    def("bool", ([x = false]) => truthy(x));
    def("list", ([x = []]) => iterate(x));
    def("tuple", ([x = []]) => tuple(iterate(x)));
    def("set", ([x = []]) => new PySet(iterate(x)));
    def("frozenset", ([x = []]) => new PySet(iterate(x)));
    def("dict", ([x], kw) => { const d = new PyDict(x ? toDictEntries(x) : []); for (const [k, v] of kw) d.set(k, v); return d; });
    def("sorted", ([x], kw) => sortList(iterate(x), kw, call));
    def("reversed", ([x]) => iterate(x).reverse());
    def("map", ([f, ...its]) => {
      const lists = its.map(iterate);
      const n = Math.min(...lists.map((l) => l.length));
      return Array.from({ length: n }, (_, i) => call(f, lists.map((l) => l[i])));
    });
    def("filter", ([f, it]) => iterate(it).filter((v) => truthy(f === null ? v : call(f, [v]))));
    def("any", ([it]) => iterate(it).some(truthy));
    def("all", ([it]) => iterate(it).every(truthy));
    def("isinstance", ([v, t]) => {
      const types = isTuple(t) ? t : [t];
      const tn = typeName(v);
      return types.some((ty) => ty instanceof Builtin && (ty.name === tn || (ty.name === "float" && tn === "int") || (ty.name === "int" && tn === "bool")));
    });
    def("type", ([v]) => { const t = typeName(v); return b.has(t) && b.get(t) instanceof Builtin ? b.get(t) : new Opaque(t); });
    def("hasattr", ([o, n]) => { try { getAttr(o, n); return true; } catch { return false; } });
    def("getattr", ([o, n, d]) => { try { return getAttr(o, n); } catch (err) { if (d !== undefined) return d; throw err; } });
    def("chr", ([n]) => String.fromCodePoint(n));
    def("ord", ([s]) => s.codePointAt(0));
    def("iter", ([x]) => iterate(x));
    def("next", ([x, d]) => { if (Array.isArray(x) && x.length) return x.shift(); if (d !== undefined) return d; throw new PyError("StopIteration: "); });
    def("id", ([x]) => hashKey(x));
    def("hash", ([x]) => hashKey(x));
    for (const name of ["open", "exec", "eval", "compile", "input", "__import__"]) {
      def(name, () => { throw new PyError(`${name}() is not supported here`); });
    }
    for (const name of Object.keys(EXCEPTION_BASES).concat("BaseException")) {
      def(name, ([msg = ""]) => `${name}: ${str(msg)}`);
    }
    return b;
  }

  function flatMap(d, f) { return Array.isArray(d) ? d.map((x) => flatMap(x, f)) : f(d); }

  // Deterministic random numbers (seeded by random.seed / np.random.seed) so an import is repeatable.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Module extends HostObject {
    constructor(name, attrs) { super(); this.name = name; this.attrs = attrs; }
    get typeName() { return "module"; }
    getattr(name) {
      if (this.attrs.has(name)) return this.attrs.get(name);
      return new Opaque(`${this.name}.${name}`);
    }
    exports() { return this.attrs; }
    str() { return `<module '${this.name}'>`; }
  }

  // Shared state for the random/numpy.random stand-ins; reset per run.
  let rng = mulberry32(12345);
  let randomCount = 0;

  function stdModule(name) {
    const fn = (n, f) => [n, new Builtin(n, f)];
    const rand = () => { randomCount++; return rng(); };
    if (name === "math") {
      const attrs = new Map([
        ["pi", Math.PI], ["e", Math.E], ["inf", Infinity], ["nan", NaN], ["tau", 2 * Math.PI],
        ...["sqrt", "exp", "log10", "log2", "sin", "cos", "tan", "asin", "acos", "atan", "floor", "ceil", "fabs", "trunc", "tanh", "sinh", "cosh"].map((n) =>
          fn(n, ([x]) => Math[n === "fabs" ? "abs" : n](toNumber(x)))),
        fn("log", ([x, base]) => (base === undefined ? Math.log(x) : Math.log(x) / Math.log(base))),
        fn("pow", ([a, b]) => a ** b),
        fn("atan2", ([a, b]) => Math.atan2(a, b)),
        fn("factorial", ([n]) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }),
        fn("comb", ([n, k]) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); }),
        fn("isclose", ([a, b], kw) => Math.abs(a - b) <= Math.max((kw.get("rel_tol") ?? 1e-9) * Math.max(Math.abs(a), Math.abs(b)), kw.get("abs_tol") ?? 0)),
        fn("isnan", ([x]) => Number.isNaN(x)),
        fn("erf", ([x]) => erf(x)),
      ]);
      return new Module("math", attrs);
    }
    if (name === "random") {
      return new Module("random", new Map([
        fn("seed", ([s = 0]) => { rng = mulberry32(typeof s === "number" ? s : hashString(str(s))); return null; }),
        fn("random", () => rand()),
        fn("uniform", ([a, b]) => a + (b - a) * rand()),
        fn("randint", ([a, b]) => a + Math.floor(rand() * (b - a + 1))),
        fn("randrange", (args) => { const [a, b] = args.length > 1 ? args : [0, args[0]]; return a + Math.floor(rand() * (b - a)); }),
        fn("choice", ([seq]) => { const l = iterate(seq); return l[Math.floor(rand() * l.length)]; }),
        fn("shuffle", ([l]) => { for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; } return null; }),
        fn("gauss", ([mu = 0, s = 1]) => mu + s * gaussian(rand)),
        fn("normalvariate", ([mu = 0, s = 1]) => mu + s * gaussian(rand)),
      ]));
    }
    if (name === "numpy") return numpyModule(rand);
    if (name === "numpy.random") return numpyModule(rand).getattr("random");
    if (name === "itertools") {
      const product = (lists, repeat) => {
        const pools = []; for (let r = 0; r < repeat; r++) pools.push(...lists);
        let out = [[]];
        for (const pool of pools) { out = out.flatMap((pre) => pool.map((x) => pre.concat([x]))); checkSize(out.length); }
        return out.map(tuple);
      };
      const combos = (l, k, perm) => {
        const out = [];
        const rec = (start, used, cur) => {
          if (cur.length === k) { out.push(tuple(cur.slice())); checkSize(out.length); return; }
          for (let i = perm ? 0 : start; i < l.length; i++) {
            if (used.has(i)) continue;
            used.add(i); cur.push(l[i]); rec(i + 1, used, cur); cur.pop(); used.delete(i);
          }
        };
        rec(0, new Set(), []);
        return out;
      };
      return new Module("itertools", new Map([
        fn("product", (args, kw) => product(args.map(iterate), toNumber(kw.get("repeat") ?? 1))),
        fn("chain", (args) => args.flatMap(iterate)),
        fn("combinations", ([it, k]) => combos(iterate(it), toNumber(k), false)),
        fn("permutations", ([it, k]) => { const l = iterate(it); return combos(l, k === undefined || k === null ? l.length : toNumber(k), true); }),
        fn("repeat", ([x, n]) => { if (n === undefined) throw new UnsupportedError("itertools.repeat() without a count isn't supported"); checkSize(n); return Array(toNumber(n)).fill(x); }),
      ]));
    }
    if (name === "fractions") return new Module("fractions", new Map([fn("Fraction", ([a, b = 1]) => a / b)]));
    return undefined;
  }

  function hashString(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
  function gaussian(rand) { const u = 1 - rand(), v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function erf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  }

  function shapeArg(s) { return (Array.isArray(s) ? s : [s]).map(toNumber); }
  function filled(shape, f) {
    checkSize(shape.reduce((a, b) => a * b, 1));
    return fill(shape, f);
  }
  function fill(shape, f) { return shape.length ? Array.from({ length: shape[0] }, () => fill(shape.slice(1), f)) : f(); }
  function ndData(v) { return v instanceof NdArray ? v.data : Array.isArray(v) ? v.map(ndData) : v; }

  function numpyModule(rand) {
    const fn = (n, f) => [n, new Builtin(n, f)];
    const unaryNp = (n, f) => fn(n, ([x]) => (x instanceof NdArray || Array.isArray(x) ? new NdArray(flatMap(ndData(x), (v) => f(toNumber(v)))) : f(toNumber(x))));
    const random = new Module("numpy.random", new Map([
      fn("seed", ([s = 0]) => { rng = mulberry32(s); return null; }),
      fn("random", ([size]) => (size === undefined || size === null ? rand() : new NdArray(filled(shapeArg(size), rand)))),
      fn("rand", (dims) => (dims.length ? new NdArray(filled(dims.map(toNumber), rand)) : rand())),
      fn("uniform", ([a = 0, b = 1, size]) => (size === undefined ? a + (b - a) * rand() : new NdArray(filled(shapeArg(size), () => a + (b - a) * rand())))),
      fn("randint", ([a, b, size]) => {
        const lo = b === undefined || b === null ? 0 : a, hi = b === undefined || b === null ? a : b;
        const one = () => lo + Math.floor(rand() * (hi - lo));
        return size === undefined ? one() : new NdArray(filled(shapeArg(size), one), "int");
      }),
      fn("choice", ([seq]) => { const l = typeof seq === "number" ? Array.from({ length: seq }, (_, i) => i) : iterate(seq); return l[Math.floor(rand() * l.length)]; }),
      fn("dirichlet", ([alpha]) => {
        const a = flatten(ndData(alpha));
        const g = a.map((x) => gammaSample(x, rand));
        const s = g.reduce((p, q) => p + q, 0);
        return new NdArray(g.map((x) => x / s));
      }),
      fn("normal", ([mu = 0, s = 1, size]) => (size === undefined ? mu + s * gaussian(rand) : new NdArray(filled(shapeArg(size), () => mu + s * gaussian(rand))))),
    ]));
    random.getattr = function (name) {
      if (name === "default_rng") return new Builtin(name, () => this);
      return Module.prototype.getattr.call(this, name);
    };
    return new Module("numpy", new Map([
      fn("array", ([x, dt], kw) => { const d = dt ?? kw.get("dtype"); const a = new NdArray(structuredClone(ndData(x)), x instanceof NdArray ? x.dtype : inferDtype(ndData(x))); shapeOf(a.data); return d === undefined || d === null ? a : astype(a, d); }),
      fn("asarray", ([x]) => (x instanceof NdArray ? x : new NdArray(structuredClone(ndData(x)), inferDtype(ndData(x))))),
      fn("zeros", ([s]) => new NdArray(filled(shapeArg(s), () => 0))),
      fn("empty", ([s]) => new NdArray(filled(shapeArg(s), () => 0))),
      fn("ones", ([s]) => new NdArray(filled(shapeArg(s), () => 1))),
      fn("full", ([s, v]) => new NdArray(filled(shapeArg(s), () => v), inferDtype([v]))),
      fn("zeros_like", ([a]) => new NdArray(flatMap(ndData(a), () => 0), dtypeOf(a))),
      fn("ones_like", ([a]) => new NdArray(flatMap(ndData(a), () => 1), dtypeOf(a))),
      fn("arange", (a) => {
        const [start, stop, step = 1] = a.length > 1 ? a : [0, a[0]];
        const n = Math.max(0, Math.ceil((stop - start) / step));
        checkSize(n);
        return new NdArray(Array.from({ length: n }, (_, i) => start + i * step), inferDtype([start, stop, step]));
      }),
      fn("linspace", ([a, b, n = 50]) => checkSize(n) || new NdArray(Array.from({ length: n }, (_, i) => (n === 1 ? a : a + ((b - a) * i) / (n - 1))))),
      fn("sum", ([a, axis], kw) => reduceAxis(a, axis ?? kw.get("axis") ?? null, "sum")),
      fn("mean", ([a, axis], kw) => reduceAxis(a, axis ?? kw.get("axis") ?? null, "mean")),
      fn("max", ([a, axis], kw) => reduceAxis(a, axis ?? kw.get("axis") ?? null, "max")),
      fn("min", ([a, axis], kw) => reduceAxis(a, axis ?? kw.get("axis") ?? null, "min")),
      fn("amax", ([a, axis], kw) => reduceAxis(a, axis ?? kw.get("axis") ?? null, "max")),
      fn("amin", ([a, axis], kw) => reduceAxis(a, axis ?? kw.get("axis") ?? null, "min")),
      fn("prod", ([a, axis], kw) => { if ((axis ?? kw.get("axis") ?? null) !== null) throw new UnsupportedError("np.prod with an axis isn't supported"); return flatten(ndData(a)).reduce((x, y) => x * y, 1); }),
      fn("concatenate", ([arrs]) => {
        const parts = iterate(arrs), types = new Set(parts.map(dtypeOf));
        return new NdArray(parts.flatMap((x) => structuredClone(ndData(x))), types.has("float") ? "float" : types.size === 1 ? [...types][0] : "num");
      }),
      fn("reshape", ([a, s]) => (a instanceof NdArray ? viewOf(a, reshape(flatten(a.data), shapeArg(s))) : new NdArray(reshape(flatten(ndData(a)), shapeArg(s)), inferDtype(ndData(a))))),
      fn("transpose", ([a]) => (a instanceof NdArray ? viewOf(a, transpose(a.data)) : new NdArray(transpose(ndData(a)), inferDtype(ndData(a))))),
      fn("round", ([a, nd = 0]) => (a instanceof NdArray ? new NdArray(flatMap(a.data, (v) => pyRound(v, nd)), a.dtype) : pyRound(a, nd))),
      fn("clip", ([a, lo, hi]) => (a instanceof NdArray ? new NdArray(flatMap(a.data, (v) => Math.min(Math.max(v, lo), hi)), resultDtype("+", a, resultDtype("+", lo, hi) === "float" ? 0.5 : 0)) : Math.min(Math.max(a, lo), hi))),
      fn("isclose", ([a, b]) => Math.abs(a - b) <= 1e-8 + 1e-5 * Math.abs(b)),
      fn("maximum", ([a, b]) => (a instanceof NdArray || b instanceof NdArray || Array.isArray(a) || Array.isArray(b) ? new NdArray(broadcast((x, y) => Math.max(toNumber(x), toNumber(y)), ndData(a), ndData(b)), resultDtype("+", a, b)) : Math.max(a, b))),
      fn("minimum", ([a, b]) => (a instanceof NdArray || b instanceof NdArray || Array.isArray(a) || Array.isArray(b) ? new NdArray(broadcast((x, y) => Math.min(toNumber(x), toNumber(y)), ndData(a), ndData(b)), resultDtype("+", a, b)) : Math.min(a, b))),
      unaryNp("exp", Math.exp), unaryNp("log", Math.log), unaryNp("sqrt", Math.sqrt),
      fn("abs", ([x]) => (x instanceof NdArray || Array.isArray(x) ? new NdArray(flatMap(ndData(x), (v) => Math.abs(toNumber(v))), dtypeOf(x) === "bool" ? "int" : dtypeOf(x)) : Math.abs(toNumber(x)))),
      unaryNp("floor", Math.floor), unaryNp("ceil", Math.ceil), unaryNp("log10", Math.log10), unaryNp("log2", Math.log2),
      unaryNp("sin", Math.sin), unaryNp("cos", Math.cos), unaryNp("tanh", Math.tanh),
      ["pi", Math.PI], ["e", Math.E], ["inf", Infinity], ["nan", NaN],
      ["float64", new Builtin("float64", ([x]) => toFloat(x))], ["float32", new Builtin("float32", ([x]) => toFloat(x))],
      ["int64", new Builtin("int64", ([x]) => toInt(x))], ["int32", new Builtin("int32", ([x]) => toInt(x))],
      ["random", random],
    ]));
  }

  function gammaSample(k, rand) {
    if (k < 1) return gammaSample(k + 1, rand) * rand() ** (1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = gaussian(rand); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = rand();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  // Runs a script with fresh, seeded random state.
  function runScript(src, options = {}) {
    rng = mulberry32(12345);
    const prev = globalCall;
    try {
      return run(src, options);
    } finally {
      globalCall = prev;
    }
  }

  // Compiles one expression (such as a pyAgrum fillFromFunction formula). The returned function
  // evaluates it with the given variable bindings (a Map).
  function compileFormula(src) {
    const { toks } = tokenize(src);
    const ast = parseExpression(toks, 1);
    return (vars) => formulaEval(ast, vars);
  }

  // A tiny evaluator for formula expressions: arithmetic, comparisons, conditionals and math calls.
  function formulaEval(e, vars) {
    const b = formulaBuiltins || (formulaBuiltins = makeBuiltins(() => { throw new PyError("Functions are not supported in formulas"); }));
    const ev = (x) => formulaEval(x, vars);
    switch (e.t) {
      case "lit": return e.v;
      case "name": {
        if (vars.has(e.name)) return vars.get(e.name);
        if (b.has(e.name)) return b.get(e.name);
        const m = formulaMath || (formulaMath = stdModule("math"));
        if (m.attrs.has(e.name)) return m.attrs.get(e.name);
        throw new PyError(`Unknown name '${e.name}' in formula`);
      }
      case "bin": return binop(e.op, ev(e.left), ev(e.right));
      case "unary": { const n = toNumber(ev(e.e)); return e.op === "-" ? -n : e.op === "~" ? ~n : n; }
      case "and": { const a = ev(e.left); return truthy(a) ? ev(e.right) : a; }
      case "or": { const a = ev(e.left); return truthy(a) ? a : ev(e.right); }
      case "not": return !truthy(ev(e.e));
      case "ifexp": return truthy(ev(e.test)) ? ev(e.body) : ev(e.orelse);
      case "cmp": {
        let left = ev(e.values[0]);
        for (let i = 0; i < e.ops.length; i++) {
          const right = ev(e.values[i + 1]);
          const op = e.ops[i];
          const ok = op === "==" ? eq(left, right) : op === "!=" ? !eq(left, right) : op === "<" ? compare(left, right) < 0 : op === ">" ? compare(left, right) > 0 : op === "<=" ? compare(left, right) <= 0 : op === ">=" ? compare(left, right) >= 0 : false;
          if (!ok) return false;
          left = right;
        }
        return true;
      }
      case "call": {
        const f = ev(e.fn);
        const args = e.args.map((a) => ev(a.e));
        if (f instanceof Builtin) return f.fn(args, new Map());
        throw new PyError("Only built-in functions can be called in formulas");
      }
      case "attr": return getAttr(ev(e.obj), e.name);
      case "tuple": return tuple(e.items.map(ev));
    }
    throw new PyError("Unsupported formula");
  }
  let formulaBuiltins = null, formulaMath = null;

  globalThis.MiniPy = {
    PyError, UnsupportedError, OPAQUE_MARK, HostObject, Opaque, Builtin, PyFunction, NdArray, PyDict, PySet, Slice,
    runScript, tokenize, compileFormula,
    tuple, isTuple, iterate, flatten, str, repr, truthy, toNumber, len, typeName,
  };
})();
