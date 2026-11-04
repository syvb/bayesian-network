# bayesian-network

A visual editor for discrete Bayesian networks that imports and exports [pyAgrum](https://pyagrum.readthedocs.io/) code.

It is a static site with no build step: serve the directory with any static file server (for example `python3 -m http.server`) or open `index.html` directly. It targets current browsers only.

## Editing

- **Demo networks:** the **Demo** menu loads a ready-made network for testing: Dying houseplant (shown on a first visit), Wet grass, Asia, Late for work, Monty Hall, one with every variable type, or a random 12-variable network. `Ctrl+Z` brings back what you had.

- **Add a node:** double-click empty space (or press `N`), type a name, press `Enter`.
- **Add an arc:** drag from the dot under a node onto another node, or `Shift`-drag a node. Dropping on empty space creates a new child node.
- **Rename:** double-click a node, or select it and press `Enter`.
- **States:** edit them in the side panel. `Enter` adds a state and `Backspace` on an empty state removes it.
- **CPTs:** the selected variable's CPT appears in a resizable table under the canvas (press `C` to jump to it). It works like a spreadsheet:
  - Type in a cell to replace its value; `0.3`, `30%` and `1/3` are all accepted. The header switches the table between probabilities (`0.25`), percentages (`25%`) and natural-log odds (`ln odds`: ln(p / (1 − p)) of each state against the rest of its row, so `0` is 50%, `+2.2` is 90% and `inf` / `-inf` are 1 / 0). The format only changes display and typing; CPTs and exports stay probabilities. `Enter`, `Tab` and the arrow keys move between cells, and `Shift`+arrows extend the selection.
  - With **Keep rows summing to 1** on (the default), typing a value rescales the row's other states so the row still sums to 1. For example, typing `0.8` into `0.5 · 0.3 · 0.2` gives `0.8 · 0.12 · 0.08`. Values you have typed in a row are kept while you stay in it, so typing all but one state fills in the last. The adjusted cells flash, and the `?` button next to the option explains it.
  - Drag the dividers in a row's bar to move probability between neighbouring states (hold `Shift` for finer steps). Double-click a bar segment to give that state 100%.
  - `Ctrl+C` / `Ctrl+V` work with Excel and Google Sheets. Pasting a smaller block into a larger selection repeats it, so you can copy one row and paste it into many. `Ctrl+D` fills down and `Delete` sets cells to 0.
  - Click a parent cell to select all the rows under it, or a state header to select its column. Filters in the parent headers narrow down large tables.
  - Normalize, Uniform and Random apply to the selected rows (or all rows). Rows that do not sum to 1 are flagged, with a one-click fix.
- **Select / move:** click a node; `Ctrl`-click adds to the selection; `Shift`-drag on empty space draws a selection box. Drag to move, or nudge with the arrow keys.
- **Delete / duplicate / undo:** `Del`, `Ctrl+D`, `Ctrl+Z` / `Ctrl+Shift+Z`.
- **View:** drag empty space to pan, scroll to zoom, `F` to fit.

Changing states or arcs keeps the existing CPT values wherever the states still exist.

**Several networks:** the button next to the title shows the network you're editing; its menu lists every saved network (most recently edited first), switches between them, starts a new one, and deletes ones you don't need. Everything is saved automatically in the browser's local storage, along with each network's evidence. Opening a demo or a link adds a network instead of replacing yours; reopening the same demo reuses its copy only while that copy is unedited. A network opened from a link isn't saved until you change it (an edit or evidence): until then the link stays in the address bar, so reloading opens it again, and switching to another network forgets it. Once changed it's saved like any other network and the link is removed from the address bar. Each tab can work on a different network, and reloading keeps the tab on its network. Undo history is kept per network until the tab is closed.

## Probabilities and evidence

With **Probabilities** on (toolbar button or `P`), every node shows the probability of each of its states, computed exactly in the browser by variable elimination. The results match pyAgrum's `LazyPropagation`.

The arithmetic is exact: each CPT entry and likelihood is read as the decimal it was written as (0.1 is 1/10, not the nearest floating-point number), and products and sums use rational numbers with big-integer numerators and denominators, so nothing underflows, overflows or rounds until the final probabilities are shown. A probability of 0 is really 0, and a very unlikely observation (say 10⁻³⁰⁰) is still handled. Two things remain approximate. Probabilities set directly (soft evidence by target) are turned into likelihoods numerically, to within 10⁻⁹ of each target, and if no likelihoods are found the evidence is refused with a message saying so; that doesn't prove the targets contradict each other. CPTs that pyAgrum computes with exponentials (`addLogit`) or from noisy weights are as precise as floating point. While any CPT has a row that doesn't add up to 1, or evidence is invalid, no probabilities are shown until it's fixed.

Click a state in a node to observe it, e.g. "the grass is wet". Every other node then shows its probabilities given the evidence. Click the state again to clear it. The evidence bar at the top of the canvas lists what you've observed, shows P(evidence), and has **Clear all**. Impossible evidence (probability 0) is refused. Probabilities also update live while you edit CPTs.

**Soft evidence** is off by default. Tick **Soft evidence** in the evidence bar, and clicking a state opens a small editor with a slider and number per state, in one of two kinds:

- **Probabilities:** say what the node's probabilities should be, e.g. "70% sure it rained". The values always add up to 100% (changing one rescales the others), and the rest of the network updates to match (Jeffrey's rule). Several nodes can have target probabilities at once; the editor finds the likelihoods that satisfy them all, or tells you when they contradict each other.
- **Likelihoods:** how likely the observation is if the node is in each state. This is the same as pyAgrum's `setEvidence({"rain": [0.2, 0.8]})`. Only the ratios matter, and equal values mean no evidence.

Switching kinds converts the current evidence, so nothing changes until you edit a value; the editor remembers the kind you last used. Soft evidence shows as a dashed chip (`rain → 30% : 70%` for probabilities, `rain ≈ 0.2 : 0.8` for likelihoods), which you can click to edit, and a dashed node outline. Hard and soft evidence can be combined. P(evidence) leaves out probabilities you set directly, since they aren't observations.

Evidence belongs to the editor session, not the network: it isn't undone with `Ctrl+Z` and isn't exported.

## pyAgrum

The data model follows pyAgrum: `LabelizedVariable`, `RangeVariable`, `IntegerVariable` and `DiscretizedVariable`, arcs, and one CPT per node. Parents are ordered by arc insertion, as in pyAgrum.

**Export** (`Ctrl+S` downloads it) produces plain pyAgrum code:

```python
import pyagrum as gum

bn = gum.BayesNet("Wet grass")
bn.add(gum.LabelizedVariable("rain", "", ["yes", "no"]))
...
bn.addArc("rain", "wet grass")
bn.cpt("rain").fillWith([0.2, 0.8])
bn.cpt("wet grass")[{"sprinkler": "off", "rain": "no"}] = [0, 1]
# bn-editor-layout: {...}
```

**Pictures:** the Export dialog can also download the canvas as a **PNG** or **SVG**, exactly as it's shown. With Probabilities on, that includes each node's probability bars and a line listing the evidence. The pyAgrum code is embedded in the file (an SVG `<metadata>` element or a PNG `iTXt` chunk), so Import, or dropping the image on the canvas, restores the network.

**Copy link:** the toolbar's Copy link button copies a URL with the whole network (layout and evidence included) compressed into its `#net=` hash, so no file has to be hosted. The hash never reaches a server. Big networks make long links (ALARM's is about 4,000 characters); for those, use `?src=` below, or Gist sharing.

**Viewer links:** Share ▾ › Copy viewer link (and Copy viewer link after a Gist publish) adds `?view` to the link. It opens a full-screen view of the network with its probabilities and evidence, without the toolbar, side panel or table. Readers can click states to set evidence, use soft evidence, pan, zoom and fit, but can't edit, and nothing is saved. **Open in editor** switches to the full editor with the reader's evidence kept. The viewer also works on phones and tablets: pinch to zoom, drag to pan, and tap a node to open a card along the bottom with its description and a large button per state. (The editor itself is meant for a desktop.)

**Embedding:** Share ▾ › Copy embed code (and Copy embed code after a Gist publish) copies an `<iframe>` of the viewer link, sized to the network's shape, to paste into a web page or blog post. Readers can set evidence inside it; **Open in editor ↗** opens the network, with their evidence, in the full editor in a new tab. Gist embeds load the gist's file, so they stay short; hash embeds carry the whole network in the `src`.

**Publish to GitHub Gist:** when configured, the Share menu can publish the network as a new secret gist on the user's GitHub account and copy a short `?src=` link to that exact revision. Secret gists are unlisted, not private: anyone with the link can open them. The browser creates the gist itself; a small Cloudflare Worker only exchanges the GitHub sign-in code for a token, which expires after 8 hours. Setup and details: [`worker/README.md`](worker/README.md).

**Sharing by link:** open the editor with `?src=<url>` to load a `.py`, `.ipynb`, `.png` or `.svg` file from anywhere, e.g. `index.html?src=https://raw.githubusercontent.com/me/models/main/asia.py`. Encode the URL if it contains `&` or `#` (`encodeURIComponent`). The file's server has to allow cross-origin downloads (CORS); GitHub raw files and gists do, and GitHub `…/blob/…` and gist page URLs are converted to their raw versions automatically. The code runs in the editor's own sandboxed Python interpreter (see below), never in a real Python, so opening an untrusted link is safe. A link opens as a network of its own, so your other networks are untouched. It's saved once you change it, and from then on reloading the tab keeps your edits rather than fetching the file again.

**Interventions:** in the evidence bar, *Click a state to: Observe | Intervene*. In Intervene mode a click sets do(node = state), Pearl's do-operator: the arcs into the node are cut (drawn dashed) and it's fixed to that state, so the probabilities show the causal effect of setting it, not what observing it would imply about its causes. Interventions combine with observations. The export runs them in pyAgrum on a copy of the network, `bn_do`, with those arcs erased and the CPTs fixed; importing skips that copy and restores the interventions from the `# bn-editor-evidence:` comment.

The final comment stores node positions so that re-importing restores the layout. When evidence is set, the export ends with it too: a `gum.LazyPropagation` with `ie.setEvidence({...})`, so running the script in pyAgrum gives the probabilities the editor shows, and a `# bn-editor-evidence:` comment that re-importing reads back. Probabilities set directly (soft evidence by target) have no pyAgrum equivalent, so `setEvidence` gets the likelihoods that produce them given the rest of the evidence.

**Import** (or drop a file on the canvas) accepts pyAgrum scripts, Jupyter notebooks (`.ipynb`, code cells only) and pictures exported from this editor. Scripts run in a small Python interpreter written in JavaScript (`js/python.js`): it has no access to files, the network or the page, and stops runaway loops and oversized values. It covers what model-building code usually needs: functions, loops, conditionals, comprehensions, f-strings and `%` formatting, lists, dicts, sets, and a little of `numpy`, `math` and `random`. Plotting, notebook display and inference calls (`gnb.*`, `plt.*`, `gum.LazyPropagation`, ...) are accepted and ignored, as long as the network doesn't depend on their results.

On the pyAgrum side it supports:

- `gum.BayesNet(...)` (including copies, `gum.BayesNet(other)`), `gum.fastBN("a{x|y}->b[3]<-c", ...)` and `gum.fastVariable`
- the variable constructors above plus `NumericalDiscreteVariable`, with `.addLabel`, `.changeLabel`, `.addTick` and `.addValue`
- `bn.add`, `bn.addArc(s)`, `bn.eraseArc`, `bn.reverseArc`, `bn.erase`, `bn.changeVariableName`, `bn.changeVariableLabel`, and lookups such as `bn.idFromName`, `bn.variable`, `bn.parents`, `bn.names`
- CPTs: `fillWith`, `fillFromFunction("...")`, `normalize`, `normalizeAsCPT`, `translate`, `scale`, `bn.cpt(x)[{...}] = ...` and numpy-style indices such as `bn.cpt(x)[1, :] = ...`
- aggregators and noisy gates (`addMAX`, `addMIN`, `addSUM`, `addAMPLITUDE`, `addMEDIAN`, `addCOUNT`, `addEXISTS`, `addFORALL`, `addOR`, `addAND`, `addNoisyOR`, `addNoisyORNet`, `addNoisyAND`, `addLogit`, `addWeightedArc`), whose CPTs are computed the way pyAgrum does and imported as plain CPTs

When the code builds several networks, the Import dialog lets you choose which one to load (by default the largest; the first one built if several are equally large).

An import is faithful or it doesn't happen: if a line raises an error (as it would in Python), uses something the importer doesn't implement or can't follow (an unknown `BayesNet` method, a condition or loop on an inference result, writing through a NumPy view), or the result isn't a valid Bayesian network (a CPT never filled, or rows that don't add up to 1), nothing is imported and the dialog says which line or CPT is the problem. The one exception is `fastBN`'s and `generateCPTs()`'s random CPTs, which are random here too, with a warning that they differ from pyAgrum's. Influence diagrams, Markov random fields and `gum.loadBN(file)` aren't supported.

The importer is checked against pyAgrum itself: scripts and notebooks from pyAgrum's documentation and GitHub, and the bnlearn benchmark networks (alarm, hailfinder, andes, pathfinder, link, munin with 1,041 variables, ...) written out as pyAgrum code, import to exactly the CPTs pyAgrum computes.

## Development tools

The site needs no build; serve the repository root with any static server (`python3 -m http.server`). The scripts in `tools/` check the editor from Node; the pyAgrum checks need `pip install pyagrum` (set `PYTHON` to use a particular interpreter).

- `node tools/roundtrip.mjs [script.py ...]`: exports every demo (and each given script) to pyAgrum code, imports it again and checks nothing changed.
- `node tools/check-import.mjs [script.py ...]`: runs each script with real pyAgrum and imports it with the editor, then compares variables, parents and CPTs; a script that fails in pyAgrum must import nothing. With no arguments it checks the demos' exported code and the small scripts in `tools/import-cases/` (those named `fail-*.py` run in pyAgrum but must be refused).
- `node tools/check-inference.mjs`: compares the editor's probabilities with pyAgrum's `LazyPropagation` on the demos and random networks, with hard and likelihood evidence, and with brute-force enumeration for target probabilities, interventions, extreme probabilities and invalid input.
- `python3 tools/bif2py.py network.bif out.py`: writes a `.bif` network (such as the [bnlearn repository](https://www.bnlearn.com/bnrepository/)'s) as a pyAgrum script, to import or check.
- `tools/og-image.sh`: regenerates `og-image.png`, the social preview (needs `agent-browser`, ImageMagick and `zopflipng`).

## License

[Apache License 2.0](LICENSE).
