# bayesian-network

A visual editor for discrete Bayesian networks that imports and exports [pyAgrum](https://pyagrum.readthedocs.io/) code.

It is a static site with no build step: serve the directory with any static file server (for example `python3 -m http.server`) or open `index.html` directly. It targets current browsers only.

## Editing

- **Add a node:** double-click empty space (or press `N`), type a name, press `Enter`.
- **Add an arc:** drag from the dot under a node onto another node, or `Shift`-drag a node. Dropping on empty space creates a new child node.
- **Rename:** double-click a node, or select it and press `Enter`.
- **States and CPTs:** edit them in the side panel. In the state list, `Enter` adds a state and `Backspace` on an empty state removes it. In the CPT table, `Tab`, `Enter` and the arrow keys move between cells. For binary variables, editing one entry sets the other to 1 − p. Rows that do not sum to 1 are flagged.
- **Select / move:** click a node; `Ctrl`-click adds to the selection; `Shift`-drag on empty space draws a selection box. Drag to move, or nudge with the arrow keys.
- **Delete / duplicate / undo:** `Del`, `Ctrl+D`, `Ctrl+Z` / `Ctrl+Shift+Z`.
- **View:** drag empty space to pan, scroll to zoom, `F` to fit.

Changing states or arcs keeps the existing CPT values wherever the states still exist.

The network is saved automatically in the browser's local storage.

## pyAgrum

The data model follows pyAgrum: `LabelizedVariable`, `RangeVariable`, `IntegerVariable` and `DiscretizedVariable`, arcs, and one CPT per node. Parents are ordered by arc insertion, as in pyAgrum.

**Export** (`Ctrl+S` downloads it) produces plain pyAgrum code:

```python
import pyagrum as gum

bn = gum.BayesNet("Wet grass")
bn.add(gum.LabelizedVariable("rain", "", ["no", "yes"]))
...
bn.addArc("rain", "wet_grass")
bn.cpt("rain").fillWith([0.8, 0.2])
bn.cpt("wet_grass")[{"sprinkler": "off", "rain": "no"}] = [1, 0]
# bn-editor-layout: {...}
```

The final comment stores node positions so that re-importing restores the layout.

**Import** (or drop a `.py` file on the canvas) reads a practical subset of Python:

- `gum.BayesNet(...)` and `gum.fastBN("a{x|y}->b[3]<-c", ...)`
- the variable constructors above, including `.addLabel(...)` chains
- `bn.add(var)`, `bn.add("name", n)`, `bn.addArc`, `bn.addArcs`, `bn.eraseArc`, `bn.reverseArc` and `bn.erase`, with node names or ids
- `bn.cpt(x).fillWith(...)`, `.normalizeAsCPT()`, `bn.cpt(x)[{...}] = ...`, `bn.cpt(x)[:] = ...` and numpy-style indices such as `bn.cpt(x)[1, 0, :] = ...`

Loops, functions and other control flow are skipped, and each skipped line is reported as a warning. `fastBN` CPTs are random, as they are in pyAgrum.
