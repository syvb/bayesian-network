# bayesian-network

A visual editor for discrete Bayesian networks that imports and exports [pyAgrum](https://pyagrum.readthedocs.io/) code.

It is a static site with no build step: serve the directory with any static file server (for example `python3 -m http.server`) or open `index.html` directly. It targets current browsers only.

## Editing

- **Add a node:** double-click empty space (or press `N`), type a name, press `Enter`.
- **Add an arc:** drag from the dot under a node onto another node, or `Shift`-drag a node. Dropping on empty space creates a new child node.
- **Rename:** double-click a node, or select it and press `Enter`.
- **States:** edit them in the side panel. `Enter` adds a state and `Backspace` on an empty state removes it.
- **Probabilities:** the selected variable's CPT appears in a resizable table under the canvas (press `C` to jump to it). It works like a spreadsheet:
  - Type in a cell to replace its value; `0.3`, `30%` and `1/3` are all accepted. `Enter`, `Tab` and the arrow keys move between cells, and `Shift`+arrows extend the selection.
  - With **Auto-balance** on, the other states in the row are rescaled so the row still sums to 1. States you have already typed in that row are kept, so typing all but one state fills in the last.
  - Drag the dividers in a row's bar to move probability between neighbouring states (hold `Shift` for finer steps). Double-click a bar segment to give that state 100%.
  - `Ctrl+C` / `Ctrl+V` work with Excel and Google Sheets. Pasting a smaller block into a larger selection repeats it, so you can copy one row and paste it into many. `Ctrl+D` fills down and `Delete` sets cells to 0.
  - Click a parent cell to select all the rows under it, or a state header to select its column. Filters in the parent headers narrow down large tables.
  - Normalize, Uniform and Random apply to the selected rows (or all rows). Rows that do not sum to 1 are flagged, with a one-click fix.
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
