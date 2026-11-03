// Loads the editor's scripts into this Node process, the way index.html loads them into the page,
// so tools can use globalThis.BNModel, BNPyAgrum, BNInference and BNDemos.
import fs from "node:fs";

const js = new URL("../js/", import.meta.url);
for (const f of ["model.js", "python.js", "pyagrum.js", "inference.js", "demos.js"]) {
  (0, eval)(fs.readFileSync(new URL(f, js), "utf8"));
}

export const { BNModel: M, BNPyAgrum: P, BNInference: I, BNDemos: demos } = globalThis;

// The python with pyAgrum installed, for the checks that compare against real pyAgrum.
export const python = process.env.PYTHON || "python3";

// The demos whose content is fixed (the random one changes on every build).
export const fixedDemos = () => demos.filter((d) => d.id !== "random");
