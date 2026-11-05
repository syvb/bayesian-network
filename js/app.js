(function () {
  "use strict";
  const M = globalThis.BNModel, P = globalThis.BNPyAgrum;
  // Legacy localStorage keys are read only during migration to IndexedDB.
  const INDEX_KEY = "bn-editor-networks";
  const netKey = (id) => "bn-editor-net:" + id;
  const evidenceKey = (id) => "bn-editor-evidence:" + id;
  const CURRENT_KEY = "bn-editor-current"; // sessionStorage: this tab's network, kept on reload
  const LAST_KEY = "bn-editor-last"; // the network a new tab opens
  const OLD_NET_KEY = "bn-editor-network";
  const OLD_EVIDENCE_KEY = "bn-editor-evidence";
  const PROBS_KEY = "bn-editor-show-probabilities";
  const SOFT_KEY = "bn-editor-soft-evidence";
  const SOFT_KIND_KEY = "bn-editor-soft-kind";
  const CLICK_KEY = "bn-editor-click-mode";
  const PANEL_KEY = "bn-editor-panel-collapsed";
  const NODE_H = 50;
  // probability view: header, then one row per state with a bar
  const PROB_HEAD = 30, PROB_ROW = 18, PROB_BAR = 64, PROB_PCT = 44, PROB_LABEL_MAX = 110;

  const $ = (s) => document.querySelector(s);
  const svg = $("#canvas"), viewport = $("#viewport"), panel = $("#panel"), inline = $("#inline-edit");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  let viewer = new URLSearchParams(location.search).has("view");
  // ?theme=light or dark (set by embed code) fixes the colours; otherwise they follow the system.
  let forcedTheme = /^(light|dark)$/.exec(new URLSearchParams(location.search).get("theme") || "")?.[0];
  if (forcedTheme) document.documentElement.classList.add("theme-" + forcedTheme);
  // Viewers are independent of browser storage, including in opaque-origin sandboxed frames.
  // Settings a reader changes in the viewer are remembered here, and kept if they open the editor.
  const viewerChoices = new Set();
  function preference(key) {
    if (viewer) return null;
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function savePreference(key, value) {
    if (viewer) viewerChoices.add(key);
    else try { localStorage.setItem(key, value); } catch { /* optional preference */ }
  }
  // The editor keeps networks in browser storage, which a sandboxed frame (or a tab it opened
  // without allow-popups-to-escape-sandbox) can't use; there, nothing offers to open the editor.
  const storageWorks = (() => {
    try {
      localStorage.setItem("bn-editor-probe", "1");
      localStorage.removeItem("bn-editor-probe");
      sessionStorage.getItem("bn-editor-probe");
      return true;
    } catch { return false; }
  })();
  const tabsSupported = () => !!navigator.locks && typeof BroadcastChannel === "function";
  if (!storageWorks || !tabsSupported()) document.body.classList.add("no-storage");

  let net = M.createNetwork("Untitled"); // renderable while asynchronous startup owns storage
  let selNodes = new Set();
  let selArc = null; // {from, to}
  let view = { x: 0, y: 0, k: 1 };
  let fitted = true; // the view is the one Fit chose (no pan or zoom since), so resizing re-fits it
  let undoStack = [], redoStack = [];
  let drag = null;
  let lastPointer = null; // world coordinates of the pointer, used by the N shortcut
  let showProbs = preference(PROBS_KEY) !== "0";
  // node id -> observed state label (hard evidence), one likelihood per state (soft evidence), or
  // {target: probabilities} (soft evidence that sets the node's probabilities).
  // Editor state, not part of undo.
  let evidence = new Map();
  let inferenceCache = null;
  let softMode = preference(SOFT_KEY) === "1";
  let softId = null; // node whose soft evidence editor is open
  // How the soft evidence editor enters evidence: "likelihoods" or "probabilities" (targets).
  let softKind = preference(SOFT_KIND_KEY) === "probabilities" ? "probabilities" : "likelihoods";
  const isTarget = (v) => !!(v && v.target);
  const isDo = (v) => !!(v && v.do !== undefined);
  // What clicking a state does: "observe" (evidence) or "intervene" (do(node = state)).
  let clickMode = preference(CLICK_KEY) === "intervene" ? "intervene" : "observe";

  // ?view opens the viewer: full screen probabilities without the editing tools, for sharing a
  // scenario. Readers can set evidence; nothing they do is saved until they open the editor.
  let embedded = false;
  try { embedded = window.self !== window.top; } catch { embedded = true; }
  if (embedded) {
    document.body.classList.add("embedded");
    const b = document.querySelector('[data-action="open-editor"]');
    b.textContent = "Open in editor ↗";
    b.title = "Open this network, with the evidence set here, in the full editor in a new tab";
  }
  let viewerEvidenceChanged = false;
  if (viewer) {
    showProbs = true;
    document.body.classList.add("viewer");
  }
  if (/[?&]src=/.test(location.search) || location.hash.startsWith("#net=")) document.body.classList.add("viewer-loading");

  // ------------------------------------------------------------ state & history

  let netId = null; // the id of the network being edited
  // Undo history of the other networks edited in this tab: id -> {undo, redo}.
  const histories = new Map();
  let storage, records = new Map(), record = null;
  let saveVersion = 0, savedVersion = 0, saveJob = null, saveFailed = false;

  let started = false, ownedId = null, releaseLock = null, pendingLock = null;
  let leaving = null, switching = false;
  let focusOnReturn = null;
  // A tab keeps its network, focused or not, until another tab asks for it: ownership only
  // changes hands when two tabs have the same network open. `parked` means this tab gave its
  // network to another tab, and takes it back only when you come back to this tab.
  let parked = false;
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("bn-editor-tabs") : null;
  const linkOnStart = !viewer && (/[?&]src=/.test(location.search) || location.hash.startsWith("#net="));
  const tabStatus = document.createElement("div");
  tabStatus.id = "tab-status";
  tabStatus.setAttribute("role", "status");
  tabStatus.hidden = true;
  document.body.append(tabStatus);
  const canEdit = () => viewer || (!leaving && ownedId !== null && ownedId === netId);

  function ownershipUI(message = saveFailed ? "Changes aren't saved. Keep this tab open; free browser storage, then return here to retry." : "") {
    tabStatus.textContent = message;
    tabStatus.hidden = !message;
    for (const el of document.body.children) {
      if (el !== tabStatus && el.tagName !== "SCRIPT") el.inert = !viewer && (switching || !canEdit());
    }
  }

  // Finish edits while we still own the network. No saves or undo snapshots from this tab
  // may escape into the next owner's session, including a drag whose pointerup never arrives.
  function leaveOwnership() {
    pendingLock?.abort();
    pendingLock = null;
    if (leaving) return leaving;
    if (releaseLock) {
      const focused = document.activeElement;
      // A background tab can report the caret at 0, so use where it was when the tab lost focus.
      const selection = caretOnBlur && (caretOnBlur.element === focused || (focused.id && caretOnBlur.element?.id === focused.id)) ? caretOnBlur.selection : [focused.selectionStart, focused.selectionEnd, focused.selectionDirection];
      const key = panel.contains(focused) && focusKeys.find(k => focused.hasAttribute(k));
      document.activeElement?.blur();
      commitInline();
      cpt.finishEditing();
      if (drag) {
        if (drag.mode === "move" && drag.moved) save();
        drag = null;
        touches.clear();
        svg.classList.remove("panning");
        render();
      }
      // A field's change handler can rebuild the panel. Remember its replacement, not the
      // detached input, and don't leave text editing focused on BODY after the handover.
      flushPanel();
      if (!focusOnReturn || focused !== document.body) {
        focusOnReturn = { element: key ? panel.querySelector(`[${key}="${CSS.escape(focused.getAttribute(key))}"]`) : focused, selection };
      }
      // Never hand another writer an older stored copy while this tab has the only copy of
      // an edit. Retain the lock and retry on focus, rather than merging conflicting edits.
      leaving = (async () => {
        if (!await flushSaves()) return false;
        const release = releaseLock;
        releaseLock = null;
        ownedId = null;
        release();
        return true;
      })().finally(() => {
        leaving = null;
        ownershipUI(saveFailed ? undefined : pausedMessage());
      });
      ownershipUI("Saving changes before switching…");
      return leaving;
    }
    ownershipUI(pausedMessage());
    return Promise.resolve(true);
  }

  const pausedMessage = () => (parked ? "This network is open in another tab, which is editing it. Click here to edit it here instead." : "");

  // Another tab wants a network: give it up if it's ours (after saving), and don't take it back
  // until this tab is used again.
  // A tab gives way (whether it has the network or is waiting for it) only to a newer claim, so
  // the tab you used last ends up with it and a stale request can't steal it. Claims are ordered
  // by a token that is never below any token this tab has seen (so a clock set back can't make a
  // new claim look old), with ties broken by a random per-tab tag.
  const tabTag = Math.random();
  let claimedAt = 0, seen = 0;
  const nextToken = () => (claimedAt = seen = Math.max(Date.now(), seen + 1));
  const beats = (at, tag) => at > claimedAt || (at === claimedAt && tag > tabTag);
  const want = (id) => channel?.postMessage({ want: id, at: claimedAt, tag: tabTag });
  channel?.addEventListener("message", (e) => {
    const d = e.data;
    if (typeof d?.at === "number") seen = Math.max(seen, d.at);
    if (!started || viewer) return;
    if (d?.refused != null) {
      // The owner thought its own claim was newer (say, the clock went back). If you're using
      // this tab, claim again: the new token is above the owner's, which this tab has now seen.
      if (d.to === tabTag && d.refused === netId && pendingLock && document.hasFocus() && !document.hidden) claim();
      return;
    }
    if (d?.want == null || d.want !== netId || (ownedId !== netId && !pendingLock)) return;
    if (!beats(d.at, d.tag)) {
      if (ownedId === netId) channel.postMessage({ refused: netId, at: claimedAt, to: d.tag });
      return;
    }
    parked = true;
    leaveOwnership();
  });

  // You came back to this tab (focus, switching to it, or a click or key in it): take its
  // network back from whichever tab has it.
  function claim() {
    if (viewer || !started) return;
    nextToken();
    if (parked) { parked = false; window.dispatchEvent(new Event("bn-claim")); }
    takeOwnership();
  }

  function resumeOwnership() {
    ownershipUI();
    const previous = focusOnReturn?.element;
    const el = previous?.isConnected ? previous : previous?.id ? panel.querySelector("#" + CSS.escape(previous.id)) : null;
    if (el) {
      el.focus();
      if (focusOnReturn.selection[0] != null) el.setSelectionRange(...focusOnReturn.selection);
    }
    focusOnReturn = null;
  }

  function takeOwnership() {
    if (viewer) return Promise.resolve(true);
    if (!started || !netId || parked) return Promise.resolve(false);
    if (leaving) return leaving.then(() => !switching && !parked ? takeOwnership() : false);
    if (ownedId === netId) {
      return flushSaves().then(() => {
        if (!switching) resumeOwnership();
        return true;
      });
    }
    if (pendingLock) {
      want(netId);
      return pendingLock.ready;
    }
    if (!tabsSupported()) return Promise.resolve(false);
    const id = netId, controller = new AbortController();
    let acquired;
    controller.ready = new Promise(resolve => { acquired = resolve; });
    pendingLock = controller;
    navigator.locks.request("bn-editor:network:" + id, { signal: controller.signal }, async () => {
      if (controller.signal.aborted || id !== netId) return;
      // A fresh transaction, after acquiring the lock, is the handover's source of truth.
      // Dirty memory belongs to a newly created network that has not been saved yet.
      if (!unsaved && savedVersion === saveVersion) {
        const latestRecord = await storage.get(id);
        if (controller.signal.aborted || id !== netId) return;
        const latest = latestRecord?.net;
        if (!latest) {
          pendingLock = null;
          netId = null;
          record = null;
          undoStack = [];
          redoStack = [];
          if (!switching) queueMicrotask(() => navigate(nextNetwork));
          toast("This network was deleted in another tab.");
          return;
        }
        record = latestRecord;
        records.set(id, record);
        const changed = JSON.stringify(latest) !== JSON.stringify(net);
        const latestEvidence = new Map(record.evidence);
        const evidenceChanged = JSON.stringify([...latestEvidence]) !== JSON.stringify([...evidence]);
        if (changed || evidenceChanged) {
          net = latest;
          evidence = latestEvidence;
          if (changed) {
            undoStack = [];
            redoStack = [];
            importBefore = null;
            $("#import-dialog").close();
          }
          hideSoftEditor();
          inferenceCache = null;
          pruneSelection();
          render();
          renderPanel();
          cpt.render(cptNodeId());
          updateButtons();
          updateNetworkButton();
          toast(changed ? "Updated from another tab. Undo history was cleared." : "Evidence updated from another tab.");
        }
      }
      if (controller.signal.aborted || id !== netId) return;
      pendingLock = null;
      ownedId = id;
      const held = new Promise(resolve => { releaseLock = resolve; });
      await flushSaves();
      if (!leaving && !switching) {
        resumeOwnership();
      }
      acquired(true);
      await held;
    }).catch(error => {
      if (error.name !== "AbortError") {
        leaveOwnership();
        ownershipUI("Couldn't acquire editing ownership. Reload this tab to retry.");
      }
    }).finally(() => {
      if (pendingLock === controller) pendingLock = null;
      acquired(false);
    });
    // Usually the lock is free and this resolves at once. Otherwise another tab has this
    // network: ask it to hand over (it parks until you use it again).
    setTimeout(() => {
      if (pendingLock !== controller) return;
      ownershipUI(parked ? pausedMessage() : "Waiting for another tab to save this network…");
      // only a tab in use asks (a background tab's timer can fire long after it was used)
      if (document.hasFocus() && !document.hidden) want(id);
    }, 50);
    return controller.ready;
  }

  async function editingReady(id = netId) {
    if (viewer) return true;
    while (id === netId) {
      if (!tabsSupported()) return false;
      if (parked) await new Promise(resolve => window.addEventListener("bn-claim", resolve, { once: true }));
      if (id !== netId) return false;
      if (await takeOwnership() && id === netId && canEdit()) return true;
      if (!parked) return false;
    }
    return false;
  }

  // Losing focus keeps the network: it's handed over only when another tab asks for it.
  let caretOnBlur = null;
  window.addEventListener("blur", () => {
    const el = document.activeElement;
    caretOnBlur = { element: el, selection: [el?.selectionStart, el?.selectionEnd, el?.selectionDirection] };
    if (started && !viewer && releaseLock) flushSaves();
  });
  const focusOwnership = () => { if (!switching) claim(); };
  window.addEventListener("focus", focusOwnership);
  window.addEventListener("pagehide", () => { if (started && !viewer) leaveOwnership(); });
  window.addEventListener("pageshow", focusOwnership);
  window.addEventListener("beforeunload", e => {
    // IndexedDB cannot finish an asynchronous save after the page is destroyed. Commit a
    // pending field while it is still alive and warn if its transaction has not completed.
    if (canEdit() && !viewer) {
      document.activeElement?.blur();
      commitInline();
      cpt.finishEditing();
      if (drag?.mode === "move" && drag.moved) save();
    }
    if (!viewer && savedVersion !== saveVersion) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!started || viewer) return;
    if (document.hidden) { if (releaseLock) flushSaves(); }
    else focusOwnership();
  });
  // inert blocks controls; the capture guard also blocks document-level keyboard shortcuts.
  for (const type of ["keydown", "pointerdown", "click", "dblclick", "drop", "paste"]) {
    document.addEventListener(type, e => {
      if (!viewer && (switching || !canEdit())) {
        e.preventDefault();
        e.stopImmediatePropagation();
        // Using a tab whose network another tab has (or is still saving) asks for it.
        if ((parked || pendingLock) && !switching && (type === "pointerdown" || type === "keydown")) claim();
      }
    }, true);
  }

  // Editing stays synchronous. Coalesce edits while a transaction is in flight, and don't
  // release ownership until every version has committed (request success is not enough).
  function flushSaves() {
    if (saveJob) return saveJob;
    saveJob = (async () => {
      while (savedVersion !== saveVersion) {
        const version = saveVersion;
        try {
          await storage.put(record);
          savedVersion = version;
          saveFailed = false;
        } catch {
          if (!saveFailed) toast("Changes couldn't be saved to browser storage. Keep this tab open and free storage before returning here to retry.");
          saveFailed = true;
          return false;
        }
      }
      return true;
    })().finally(() => {
      saveJob = null;
      if (ownedId === netId && !leaving && !switching) ownershipUI();
    });
    return saveJob;
  }

  // The saved networks: [{id, name, nodes, updated, source, edited}]. `source` names the link or
  // demo a network was opened from; `edited` says whether it changed since.
  function readIndex() {
    return viewer ? [] : [...records.values()];
  }
  async function reloadNetworks() {
    records = new Map((await storage.list()).map(r => [r.id, r]));
    if (ownedId && record) records.set(ownedId, record);
  }
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const byRecent = (list) => [...list].sort((a, b) => b.updated - a.updated);
  const makeRecord = (id, n, source = null) => ({ id, net: n, evidence: [], name: n.name, nodes: n.nodes.length, updated: Date.now(), source, edited: false });

  // Called under the startup lock, including when a viewer becomes an editor.
  async function migrateIndex() {
    storage ||= await BNStorage.open();
    if (await storage.isMigrated()) { await reloadNetworks(); return; }
    const legacy = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
    const oldIndex = legacy(INDEX_KEY);
    const entries = new Map((Array.isArray(oldIndex) ? oldIndex : []).map(e => [e.id, e]));
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("bn-editor-entry:")) {
        const entry = legacy(key);
        if (entry?.id) entries.set(entry.id, entry);
      }
    }
    const imported = [];
    for (const entry of entries.values()) {
      const n = legacy(netKey(entry.id));
      if (Array.isArray(n?.nodes)) imported.push({ ...makeRecord(entry.id, n), edited: true, ...entry, net: n, evidence: legacy(evidenceKey(entry.id)) || [] });
    }
    const old = legacy(OLD_NET_KEY);
    if (!imported.length && Array.isArray(old?.nodes)) imported.push({ ...makeRecord(newId(), old), edited: true, evidence: legacy(OLD_EVIDENCE_KEY) || [] });
    await storage.migrate(imported);
    await reloadNetworks();
  }

  // This tab's network from before a reload, else the one last used in any tab, else the newest.
  const rememberedNetwork = () => [sessionStorage.getItem(CURRENT_KEY), localStorage.getItem(LAST_KEY), ...byRecent(readIndex()).map((e) => e.id)].find(id => id && records.has(id));

  // Picks the network this tab starts with, creating the first one on a first visit.
  async function startNetwork() {
    if (viewer) {
      netId = newId();
      net = BNDemos[0].build();
      return;
    }
    // A link opens as a network of its own, so don't load (or on a first visit create) another
    // one first: it would only flash up before the link's network replaces it.
    if (linkOnStart) return;
    if (!readIndex().length) {
      const first = makeRecord(newId(), BNDemos[0].build(), "demo:" + BNDemos[0].id);
      await storage.put(first);
      records.set(first.id, first);
    }
    await enterNetwork(rememberedNetwork());
  }

  // Makes network `id` the one being edited, keeping the undo history of the one it replaces.
  // The caller has already flushed and released the previous network.
  async function enterNetwork(id, initial = null) {
    const next = initial || await storage.get(id);
    if (!next) return false;
    focusOnReturn = null;
    if (netId && netId !== id && !unsaved) histories.set(netId, { undo: undoStack, redo: redoStack, snapshot: JSON.stringify(net) });
    discardLinkedNetwork();
    const history = histories.get(id);
    ({ undo: undoStack, redo: redoStack } = history?.snapshot === JSON.stringify(next.net) ? history : { undo: [], redo: [] });
    histories.delete(id);
    netId = id;
    record = next;
    records.set(id, record);
    net = record.net;
    evidence = new Map(record.evidence);
    saveVersion = initial ? 1 : 0;
    savedVersion = 0;
    saveFailed = false;
    sessionStorage.setItem(CURRENT_KEY, id);
    savePreference(LAST_KEY, id);
    hideSoftEditor();
    importBefore = null;
    inferenceCache = null;
    selNodes = new Set();
    selArc = null;
    refreshNetwork();
    return true;
  }

  // All navigation shares this departure boundary. Focus events cannot reacquire the old
  // network halfway through a switch (including a native confirmation dialog's focus event).
  async function navigate(action) {
    if (switching) return false;
    switching = true;
    try {
      if (!await leaveOwnership()) return false;
      return await action();
    } catch {
      toast("Couldn't open or change your saved networks. Check browser storage and try again.");
      return false;
    } finally {
      switching = false;
      if (!parked) await takeOwnership();
      else ownershipUI(pausedMessage());
    }
  }

  // The most recent network that no other tab has open (taking one from a tab you're using
  // would only pause that tab), or a new one.
  async function nextNetwork() {
    await reloadNetworks();
    for (const e of byRecent(readIndex())) {
      if (e.id === netId) continue;
      const free = await navigator.locks.request("bn-editor:network:" + e.id, { ifAvailable: true }, (lock) => !!lock);
      if (free) return enterNetwork(e.id);
    }
    const id = newId();
    return enterNetwork(id, makeRecord(id, M.createNetwork(untitledName())));
  }

  // Switches the editor to another saved network. A blank network being left (no variables and
  // nothing to undo) is deleted rather than kept in the list.
  async function switchNetwork(id) {
    if (id === netId) return;
    return navigate(async () => {
      const left = netId;
      const blank = !net.nodes.length && !undoStack.length && !redoStack.length;
      if (!await enterNetwork(id)) { toast("This network was deleted in another tab."); return false; }
      if (blank && left) await removeNetwork(left, true);
      return true;
    });
  }

  function refreshNetwork() {
    render();
    renderPanel();
    cpt.render(cptNodeId());
    updateButtons();
    updateNetworkButton();
    fit();
  }

  // Deletes network `id` (with onlyBlank, only if it's still blank and unedited). Returns false
  // when another tab has it open and doesn't hand it over: blank clean-up then just skips it, and
  // a deletion asks that tab for it but gives up after a few seconds (it may be unable to save).
  async function removeNetwork(id, onlyBlank = false) {
    const remove = async () => {
      const current = await storage.get(id);
      if (onlyBlank && (current?.net.nodes.length || current?.edited)) return;
      await storage.remove(id);
      records.delete(id);
      histories.delete(id);
    };
    if (ownedId === id) { await remove(); return true; }
    const name = "bn-editor:network:" + id;
    if (await navigator.locks.request(name, { ifAvailable: true }, async (lock) => lock && (await remove(), true))) return true;
    if (onlyBlank) return false;
    // Ask for it, and ask again with a newer token if the owner says its own claim is newer.
    const retry = (e) => { if (e.data?.refused === id && e.data.to === tabTag) { nextToken(); want(id); } };
    channel.addEventListener("message", retry);
    nextToken();
    want(id);
    try {
      await navigator.locks.request(name, { signal: AbortSignal.timeout(5000) }, remove);
      return true;
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") return false;
      throw error;
    } finally {
      channel.removeEventListener("message", retry);
    }
  }

  function untitledName() {
    const names = new Set(readIndex().map((e) => e.name));
    for (let i = 1; ; i++) if (!names.has(i === 1 ? "Untitled" : `Untitled ${i}`)) return i === 1 ? "Untitled" : `Untitled ${i}`;
  }

  // Opens `n` as a network of its own, leaving the current one saved. It takes the place of the
  // current network when that one is blank, or of an unedited copy opened from the same
  // `source` (a link or demo), so reopening a link doesn't pile up copies.
  async function openNetwork(n, source = null) {
    return navigate(async () => {
      await reloadNetworks();
      const left = netId;
      const blank = netId && !unsaved && !net.nodes.length && !undoStack.length && !redoStack.length;
      const reuse = (source && readIndex().find(e => e.source === source && !e.edited)) || (blank ? records.get(netId) : null);
      if (blank && left !== reuse?.id) await removeNetwork(left, true);
      let reusable = false;
      if (reuse && await enterNetwork(reuse.id) && await editingReady(reuse.id)) {
        // Enumeration selects a candidate, not permission to overwrite it. Revalidate the
        // atomic record read after acquiring its lock, not a cached menu entry.
        reusable = !record.edited && (record.source === source || !net.nodes.length);
        if (!reusable && !await leaveOwnership()) return false;
      }
      if (!reusable) {
        const id = newId();
        await enterNetwork(id, makeRecord(id, n, source));
        if (!await editingReady(id)) return false;
      } else {
        net = n;
        evidence = new Map();
        record.source = source;
        record.edited = false;
        save();
      }
      undoStack = [];
      redoStack = [];
      histories.delete(netId);
      inferenceCache = null;
      selNodes = new Set();
      selArc = null;
      refreshNetwork();
      return true;
    });
  }

  async function deleteNetwork(id) {
    const entry = readIndex().find((e) => e.id === id);
    if (!entry || !confirm(`Delete “${entry.name || "Untitled"}”? This can't be undone.`)) return;
    return navigate(async () => {
      if (!await removeNetwork(id)) {
        toast("Couldn't delete it: another tab has it open and hasn't saved its changes. Try again, or close that tab.");
        return false;
      }
      if (id !== netId) return true;
      netId = null;
      record = null;
      undoStack = [];
      redoStack = [];
      return nextNetwork();
    });
  }

  // A network opened from a link and not changed yet: {source, importing}. It isn't in storage.
  let unsaved = null;

  // The linked network was changed: store it, and take the link out of the address bar, so
  // reloading shows the saved copy rather than opening the link again.
  function saveLinkedNetwork() {
    const { source } = unsaved;
    unsaved = null;
    record = { ...makeRecord(netId, net, source), edited: true };
    records.set(netId, record);
    save();
    sessionStorage.setItem(CURRENT_KEY, netId);
    savePreference(LAST_KEY, netId);
    dropLinkFromUrl();
    updateNetworkButton();
  }

  // Leaving an unchanged linked network forgets it; opening the link again brings it back.
  function discardLinkedNetwork() {
    if (!unsaved) return;
    unsaved = null;
    netId = null;
    undoStack = [];
    redoStack = [];
    dropLinkFromUrl();
  }

  function dropLinkFromUrl() {
    const url = new URL(location.href);
    url.searchParams.delete("src");
    if (url.hash.startsWith("#net=")) url.hash = "";
    history.replaceState(null, "", url.href);
  }

  function save() {
    if (viewer) return;
    if (!canEdit()) return;
    if (unsaved) { updateNetworkButton(); return; }
    Object.assign(record, { net, name: net.name, nodes: net.nodes.length, updated: Date.now(), evidence: [...evidenceIndices()].map(([id, v]) => [id, isDo(v) ? { do: M.getNode(net, id).labels[v.do] } : typeof v === "object" ? v : M.getNode(net, id).labels[v]]) });
    saveVersion++;
    flushSaves();
    updateNetworkButton();
  }

  // Records the current state for undo. Call before mutating `net`.
  function checkpoint(snapshot = JSON.stringify(net)) {
    undoStack.push(snapshot);
    if (undoStack.length > 300) undoStack.shift();
    redoStack = [];
    if (unsaved) {
      if (!unsaved.importing) saveLinkedNetwork();
    } else record.edited = true;
    updateButtons();
  }

  // Runs fn, which mutates `net`, as one undo step. Nothing is recorded when fn leaves the network
  // as it was (for example a refused arc reversal), so Undo and Redo keep what they had.
  function change(fn) {
    if (!canEdit()) return;
    const before = JSON.stringify(net), labels = labelsById();
    const result = fn();
    // Logic-gate CPTs follow the change: new or removed parents, renamed or reordered states.
    const dropped = M.applyGates(net);
    if (dropped.length) toast(`${dropped.join(", ")} ${dropped.length > 1 ? "are" : "is"} no longer an AND/OR gate: a gate needs exactly two states. ${dropped.length > 1 ? "Their tables were" : "Its table was"} kept.`);
    if (JSON.stringify(net) !== before) checkpoint(before);
    remapEvidence(labels);
    refresh();
    return result;
  }

  const labelsById = () => new Map(net.nodes.map((n) => [n.id, n.labels]));

  // Keeps the evidence on the same states when a variable's states change (from an edit, undo or
  // redo), matching them the way CPTs are remapped (M.stateMap: by name, or renamed in place).
  // Evidence that can't be carried over, such as likelihoods when a state is added, is cleared,
  // with a message, rather than read against the wrong states.
  function remapEvidence(before) {
    if (!evidence.size) return;
    const next = new Map(), cleared = [];
    for (const [id, v] of evidence) {
      const n = M.getNode(net, id), old = before.get(id);
      if (!n || !old || (old.length === n.labels.length && old.every((l, i) => l === n.labels[i]))) { next.set(id, v); continue; }
      const map = M.stateMap(old, n.labels); // new state -> old state, or -1 for a new state
      const moved = (label) => { const j = old.indexOf(label), i = j < 0 ? -1 : map.indexOf(j); return i < 0 ? null : n.labels[i]; };
      const added = map.includes(-1);
      let w = null;
      if (isDo(v)) { const l = moved(v.do); if (l !== null) w = { do: l }; }
      else if (Array.isArray(v)) { if (!added && map.some((j) => v[j] > 0)) w = map.map((j) => v[j]); }
      else if (isTarget(v)) { if (!added && v.target.every((q, j) => !(q > 0) || map.includes(j))) w = { target: map.map((j) => v.target[j]) }; }
      else w = moved(v);
      if (w === null) cleared.push(n.name);
      else next.set(id, w);
    }
    evidence = next;
    if (cleared.length) {
      if (cleared.includes(M.getNode(net, softId)?.name)) hideSoftEditor();
      toast(`Cleared the evidence on ${cleared.join(", ")}: its states changed`);
    }
    saveEvidence();
  }

  function refresh() {
    pruneSelection();
    inferenceCache = null;
    save();
    render();
    cpt.render(cptNodeId());
    schedulePanel();
    updateButtons();
  }

  const cptNodeId = () => (!selArc && selNodes.size === 1 ? [...selNodes][0] : null);

  // The panel is rebuilt after the current event finishes, so that a click which blurred (and
  // committed) one panel field can still move focus to the field that was clicked.
  let panelTimer = null;
  function schedulePanel() {
    if (panelTimer === null) panelTimer = setTimeout(() => { panelTimer = null; renderPanel(); });
  }

  // Renders a pending panel update now, for edits made from the keyboard or a click inside the
  // panel, so keys typed right after them reach the re-rendered fields.
  function flushPanel() {
    if (panelTimer === null) return;
    clearTimeout(panelTimer);
    panelTimer = null;
    renderPanel();
  }

  function restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(net));
    const labels = labelsById();
    net = JSON.parse(from.pop());
    remapEvidence(labels);
    refresh();
  }
  const undo = () => restore(undoStack, redoStack);
  const redo = () => restore(redoStack, undoStack);

  function updateButtons() {
    document.querySelector('[data-action="undo"]').disabled = !undoStack.length;
    document.querySelector('[data-action="redo"]').disabled = !redoStack.length;
  }

  function pruneSelection() {
    for (const id of selNodes) if (!M.getNode(net, id)) selNodes.delete(id);
    if (selArc && !M.hasArc(net, selArc.from, selArc.to)) selArc = null;
  }

  function select(ids, arc = null) {
    selNodes = new Set(ids);
    selArc = arc;
    render();
    renderPanel();
    cpt.render(cptNodeId());
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ------------------------------------------------------------ geometry

  const measureCtx = document.createElement("canvas").getContext("2d");
  function textWidth(s, font) {
    measureCtx.font = font;
    return measureCtx.measureText(s).width;
  }
  // A long name wraps onto up to NAME_LINES lines of at most NAME_MAX px; the last line gets an
  // ellipsis if it still doesn't fit (the full name is in the node's tooltip).
  const NAME_FONT = "600 14px system-ui, sans-serif", NAME_MAX = 200, NAME_LINES = 3, NAME_LH = 17;
  const nameCache = new Map();
  function nameLines(name) {
    if (nameCache.has(name)) return nameCache.get(name);
    const lines = [];
    let line = "";
    for (const word of name.split(/\s+/).filter(Boolean)) {
      const next = line ? line + " " + word : word;
      if (!line || textWidth(next, NAME_FONT) <= NAME_MAX) line = next;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
    const out = lines.slice(0, NAME_LINES);
    if (lines.length > NAME_LINES) out[NAME_LINES - 1] += " " + lines.slice(NAME_LINES).join(" ");
    for (let i = 0; i < out.length; i++) out[i] = truncate(out[i], NAME_FONT, NAME_MAX);
    if (nameCache.size > 2000) nameCache.clear();
    nameCache.set(name, out);
    return out;
  }
  function nodeWidth(n) {
    return Math.max(84, ...nameLines(n.name).map((l) => Math.ceil(textWidth(l, NAME_FONT)) + 30));
  }
  // The name as <tspan> lines, the first line's baseline at y.
  function nameSvg(n, y) {
    return `<text class="name" text-anchor="middle" y="${y}">` +
      nameLines(n.name).map((l, i) => `<tspan x="0" dy="${i ? NAME_LH : 0}">${esc(l)}</tspan>`).join("") + `</text>`;
  }
  function labelWidth(n) {
    return Math.min(PROB_LABEL_MAX, Math.max(...n.labels.map((l) => Math.ceil(textWidth(l, "12px system-ui, sans-serif")))));
  }
  function nodeSize(n, probs = showProbs) {
    const extra = (nameLines(n.name).length - 1) * NAME_LH;
    if (!probs) return { w: nodeWidth(n), h: NODE_H + extra };
    return {
      w: Math.max(nodeWidth(n), 10 + labelWidth(n) + 8 + PROB_BAR + PROB_PCT + 6),
      h: PROB_HEAD + extra + n.labels.length * PROB_ROW + 8,
    };
  }
  function truncate(text, font, maxW) {
    if (textWidth(text, font) <= maxW) return text;
    while (text.length > 1 && textWidth(text + "…", font) > maxW) text = text.slice(0, -1);
    return text + "…";
  }

  function toWorld(e) {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  }

  // Point where the segment from b's centre towards a leaves b's box (with margin).
  function boxExit(b, size, ax, ay, margin) {
    const dx = ax - b.x, dy = ay - b.y;
    const hw = size.w / 2 + margin, hh = size.h / 2 + margin;
    const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return t >= 1 ? { x: b.x, y: b.y } : { x: b.x + dx * t, y: b.y + dy * t };
  }

  function fit() {
    fitted = true;
    if (!net.nodes.length) { view = { x: 0, y: 0, k: 1 }; applyView(); return; }
    const r = svg.getBoundingClientRect();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of net.nodes) {
      const { w, h } = nodeSize(n);
      x0 = Math.min(x0, n.x - w / 2); x1 = Math.max(x1, n.x + w / 2);
      y0 = Math.min(y0, n.y - h / 2); y1 = Math.max(y1, n.y + h / 2 + 10);
    }
    const pad = 24; // leave room for the evidence bar, with half a pad below it
    const top = evidenceBar.hidden ? 0 : evidenceBar.getBoundingClientRect().bottom - r.top - pad / 2;
    // on narrow screens the watch panel goes along the bottom, so leave room for it too
    const bottom = !watchPanel.hidden && watchPanel.offsetWidth > r.width / 2 ? watchPanel.offsetHeight + 8 : 0;
    const k = Math.min(1.4, (r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad - top - bottom) / (y1 - y0));
    view = { k, x: r.width / 2 - ((x0 + x1) / 2) * k, y: (r.height + top - bottom) / 2 - ((y0 + y1) / 2) * k };
    applyView();
  }

  function applyView() {
    viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
    // The dot grid lives in the SVG, so it moves exactly with the nodes. Zoomed out, every 2nd
    // (4th, ...) dot is kept so the dots stay at least 14px apart instead of blurring together.
    let step = 20 * view.k;
    while (step < 14) step *= 2;
    const dots = $("#grid-dots");
    dots.setAttribute("width", step);
    dots.setAttribute("height", step);
    dots.setAttribute("x", view.x - step / 2);
    dots.setAttribute("y", view.y - step / 2);
    dots.firstElementChild.setAttribute("cx", step / 2);
    dots.firstElementChild.setAttribute("cy", step / 2);
    if (!inline.hidden) positionInline();
    positionSoftEditor();
  }

  // ------------------------------------------------------------ rendering

  function render() {
    const parts = [];
    const widths = new Map(net.nodes.map((n) => [n.id, nodeSize(n)]));
    const inf = showProbs ? inference() : null;
    for (const a of net.arcs) {
      const f = M.getNode(net, a.from), t = M.getNode(net, a.to);
      const p1 = boxExit(f, widths.get(f.id), t.x, t.y, 0);
      const p2 = boxExit(t, widths.get(t.id), f.x, f.y, 2);
      const sel = selArc && selArc.from === a.from && selArc.to === a.to;
      const d = `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
      const cut = inf && isDo(evidenceIndices().get(a.to));
      // arcs into or out of a selected node are lightly highlighted
      const near = !sel && (selNodes.has(a.from) || selNodes.has(a.to));
      parts.push(`<g class="arc${sel ? " selected" : ""}${near ? " near" : ""}${cut ? " cut" : ""}" data-from="${a.from}" data-to="${a.to}"><path class="hit" d="${d}"/><path class="line" d="${d}" marker-end="url(#${sel ? "arrow-sel" : near ? "arrow-near" : "arrow"})"/></g>`);
    }
    for (const n of net.nodes) {
      const { w, h } = widths.get(n.id);
      const classes = ["node"];
      if (selNodes.has(n.id)) classes.push("selected");
      if (drag && drag.mode === "arc" && drag.target === n.id) classes.push("target");
      const observed = inf ? evidenceIndices().get(n.id) : undefined;
      if (observed !== undefined) classes.push(isDo(observed) ? "intervened" : typeof observed === "object" ? "soft-observed" : "observed");
      const bad = M.badRows(n).length > 0;
      let content;
      if (inf) {
        const probs = inf.marginals && inf.marginals.get(n.id);
        // The bars take whatever width the name leaves over, instead of leaving a gap.
        const lw = labelWidth(n), barX = -w / 2 + 10 + lw + 8, barW = w - 10 - lw - 8 - PROB_PCT - 6;
        const head = PROB_HEAD + (nameLines(n.name).length - 1) * NAME_LH;
        content = nameSvg(n, -h / 2 + 20) +
          n.labels.map((l, s) => {
            const y = -h / 2 + head + s * PROB_ROW;
            const p = probs ? probs[s] : null;
            const pct = p === null ? "–" : pctText(p, probs);
            return `<g class="state-row${observed === s ? " observed" : isDo(observed) && observed.do === s ? " intervened" : ""}" data-state="${s}">` +
              `<rect class="row-hit" x="${-w / 2 + 4}" y="${y}" width="${w - 8}" height="${PROB_ROW}" rx="3"/>` +
              `<text class="slabel" x="${-w / 2 + 10}" y="${y + 13}">${esc(truncate(l, "12px system-ui, sans-serif", lw))}</text>` +
              `<rect class="pbar-bg" x="${barX}" y="${y + 4}" width="${barW}" height="10" rx="2"/>` +
              (p ? `<rect class="pbar" x="${barX}" y="${y + 4}" width="${barW * p}" height="10" rx="2"/>` : "") +
              `<text class="pct" x="${w / 2 - 8}" y="${y + 13}" text-anchor="end">${pct}</text></g>`;
          }).join("");
      } else {
        const lines = nameLines(n.name).length;
        content = nameSvg(n, -3 - (lines - 1) * NAME_LH / 2) +
          `<text class="states" text-anchor="middle" y="${14 + (lines - 1) * NAME_LH / 2}">${esc(truncate(n.labels.join(" · "), "11px system-ui, sans-serif", w - 16))}</text>`;
      }
      const tip = showProbs ? "\n" + clickHint() : "";
      parts.push(
        `<g class="${classes.join(" ")}" data-node="${n.id}" transform="translate(${n.x},${n.y})">` +
          // A node with a description gets the hover card instead of the browser's slower tooltip.
          (n.description ? "" : `<title>${esc(n.name)}\n${esc(n.labels.join(", "))}${bad ? "\nCPT rows do not sum to 1" : ""}${tip}</title>`) +
          `<rect class="body" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="9"/>` +
          content +
          (bad ? `<circle class="bad" cx="${w / 2 - 8}" cy="${-h / 2 + 8}" r="4"/>` : "") +
          (n.gate ? `<text class="gate" x="${w / 2 - 7}" y="${-h / 2 + 12}" text-anchor="end">${n.gate.toUpperCase()}</text>` : "") +
          (n.description ? `<g class="info" transform="translate(${-w / 2 + 10},${-h / 2 + 10})"><circle r="6"/><text text-anchor="middle" y="3.5">i</text></g>` : "") +
          `<circle class="port" data-port="${n.id}" cx="0" cy="${h / 2}" r="6"/>` +
        `</g>`
      );
    }
    if (drag && drag.mode === "arc" && drag.moved) {
      const f = M.getNode(net, drag.from);
      const t = drag.target ? M.getNode(net, drag.target) : null;
      const p2 = t ? boxExit(t, widths.get(t.id), f.x, f.y, 2) : drag.pos;
      const p1 = boxExit(f, widths.get(f.id), p2.x, p2.y, 0);
      parts.push(`<path class="ghost" d="M${p1.x},${p1.y} L${p2.x},${p2.y}" marker-end="url(#arrow-sel)"/>`);
    }
    if (drag && drag.mode === "rubber") {
      const r = rubberRect();
      parts.push(`<rect class="rubber" x="${r.x0}" y="${r.y0}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}"/>`);
    }
    viewport.innerHTML = parts.join("");
    renderEvidenceBar(inf);
    renderWatchPanel(inf);
    renderNodeSheet(inf);
    positionSoftEditor();
    $("#empty-hint").toggleAttribute("hidden", net.nodes.length > 0);
  }

  // ------------------------------------------------------------ inference & evidence

  // Evidence as node id -> state index (hard), likelihood array or {target} (soft), skipping entries
  // whose node or state no longer exists, or whose values no longer match the node's states.
  function evidenceIndices(labels = evidence) {
    const out = new Map();
    for (const [id, v] of labels) {
      const n = M.getNode(net, id);
      if (!n) continue;
      if (isDo(v)) {
        const s = n.labels.indexOf(v.do);
        if (s >= 0) out.set(id, { do: s });
      } else if (Array.isArray(v)) {
        if (v.length === n.labels.length && v.some((x) => x > 0)) out.set(id, v.slice());
      } else if (isTarget(v)) {
        const sum = v.target.reduce((a, b) => a + b, 0);
        if (v.target.length === n.labels.length && sum > 0) out.set(id, { target: v.target.map((q) => q / sum) });
      } else {
        const s = n.labels.indexOf(v);
        if (s >= 0) out.set(id, s);
      }
    }
    return out;
  }

  function inference() {
    if (!inferenceCache) inferenceCache = BNInference.posteriors(net, evidenceIndices());
    return inferenceCache;
  }

  function saveEvidence() {
    if (viewer) { viewerEvidenceChanged = true; return; }
    if (!canEdit()) return;
    if (unsaved) {
      if (unsaved.importing) return;
      saveLinkedNetwork(); // stores the evidence too
      return;
    }
    record.edited = true;
    save();
  }

  function setEvidence(next) {
    const result = BNInference.posteriors(net, evidenceIndices(next));
    // Evidence that is invalid, impossible or unreachable is refused; a model error (such as a
    // CPT being edited) only suspends the results until it's fixed.
    if (result.evidenceError) { toast(result.error); return false; }
    evidence = next;
    inferenceCache = result;
    saveEvidence();
    render();
    return true;
  }

  function toggleIntervention(id, s) {
    const n = M.getNode(net, id);
    const next = new Map(evidence);
    const cur = next.get(id);
    if (isDo(cur) && cur.do === n.labels[s]) next.delete(id);
    else next.set(id, { do: n.labels[s] });
    if (softId === id) hideSoftEditor();
    setEvidence(next);
  }

  // A click on state s of node id, in the current click mode.
  function clickState(id, s) {
    if (clickMode === "intervene") toggleIntervention(id, s);
    else if (softMode) openSoftEditor(id, s);
    else toggleEvidence(id, s);
  }

  function toggleEvidence(id, s) {
    const n = M.getNode(net, id);
    const next = new Map(evidence);
    if (next.get(id) === n.labels[s]) next.delete(id);
    else next.set(id, n.labels[s]);
    setEvidence(next);
  }

  function clearEvidence() {
    hideSoftEditor();
    evidence = new Map();
    inferenceCache = null;
    saveEvidence();
  }

  function toggleProbs() {
    showProbs = !showProbs;
    savePreference(PROBS_KEY, showProbs ? "1" : "0");
    document.querySelector('[data-action="probs"]').setAttribute("aria-pressed", showProbs);
    render();
    schedulePanel();
    if (!inline.hidden) positionInline();
  }

  // A probability as a short percentage that never rounds a possible state to 0% or a
  // not-quite-certain one to 100%: 1e-9 shows as 1e-7%, 0.9999 as >99.9%. `all` is the whole
  // distribution: a state whose rounded probability is 1 isn't certain while another is possible.
  const pctText = (p, all = [p]) => p === 0 ? "0%" : p === 1 && all.every((q) => q === 0 || q === 1) ? "100%" : p < 0.0005 ? +(p * 100).toPrecision(2) + "%" : p >= 0.9995 ? ">99.9%" : (p * 100).toFixed(1) + "%";
  const fmtPct = (q) => +(q * 100).toPrecision(3) + "%";
  // What clicking a state does in the current mode, for the side panel (and the viewer).
  // A touchscreen: in the viewer, tapping a node opens its card (the bars are too small to tap).
  const touchScreen = matchMedia("(pointer: coarse)").matches;
  function clickModeText() {
    if (touchScreen && viewer) {
      return clickMode === "intervene"
        ? "Tap a node, then one of its states, to make it true from outside, do(node = state): you see only its effects, not what its causes would imply. Pinch to zoom."
        : "Tap a node, then one of its states, to observe it; every other node then shows its updated probabilities. Pinch to zoom.";
    }
    return clickMode === "intervene"
      ? "Click a state to make it true from outside, do(node = state): the arcs into the node are cut, so you see only its effects, not what its causes would imply."
      : softMode
      ? "Click a state in any node to enter soft evidence (probabilities or likelihoods) for that node."
      : "Click a state in any node to observe it; every other node then shows its updated probabilities.";
  }

  function clickHint() {
    return clickMode === "intervene" ? "Click a state to set it by intervention, do(node = state)"
      : softMode ? "Click a state to enter soft evidence for this node" : "Click a state to set or clear it as evidence";
  }
  // No observations: only probabilities set directly and interventions, so no P(evidence).
  const onlyTargets = (ev) => [...ev.values()].every((v) => isTarget(v) || isDo(v));

  const evidenceBar = $("#evidence-bar");
  function renderEvidenceBar(inf) {
    evidenceBar.hidden = !inf || !net.nodes.length;
    if (evidenceBar.hidden) return;
    const ev = evidenceIndices();
    const fmtP = (p) => (p >= 0.001 ? +p.toPrecision(3) : p.toExponential(2));
    const mode = (m, label, title) => `<button type="button" class="small${clickMode === m ? " on" : ""}" data-click-mode="${m}" title="${title}">${label}</button>`;
    const modes = `<span class="muted click-label">${touchScreen ? "Tap" : "Click"} a state to</span><span class="seg-toggle">` +
      mode("observe", "Observe", "Clicking a state observes it: you learn that it's true, which also tells you about its causes") +
      mode("intervene", "Intervene", "Clicking a state sets it from outside, do(node = state): the arcs into it are cut, so it changes only what it causes. Use it to ask what would happen if you made something true") +
      `</span>`;
    const toggle = clickMode === "intervene" ? "" : `<label class="check" title="Off: clicking a state observes it for certain. On: clicking a state opens an editor where you either set the node's probabilities directly, or give likelihoods: how likely the observation is under each of the node's states, as in pyAgrum's setEvidence({&quot;x&quot;: [0.2, 0.8]}).">` +
      `<input type="checkbox" data-soft-mode${softMode ? " checked" : ""}> Soft evidence</label>`;
    let body;
    if (inf.error) {
      body = `<span class="warn">${esc(inf.error)}</span>`;
    } else if (!ev.size) {
      // The editor explains clicking states in the side panel; the viewer has no side panel.
      body = viewer ? `<span class="muted ev-hint">${clickModeText()}</span>` : "";
    } else {
      const chip = ([id, v]) => {
        const n = M.getNode(net, id);
        if (isDo(v)) {
          return `<span class="ev-chip do" title="Intervention: ${esc(n.name)} is set to ${esc(n.labels[v.do])} from outside. The arcs into it are cut, so this says nothing about its causes.">do(${esc(n.name)} = ${esc(n.labels[v.do])})<button class="icon" data-clear-ev="${id}" title="Remove this intervention">✕</button></span>`;
        }
        if (isTarget(v)) {
          const pcts = v.target.map(fmtPct).join(" : ");
          return `<span class="ev-chip soft" data-edit-ev="${id}" title="Soft evidence: the probabilities of ${esc(n.labels.join(" : "))} are set to ${pcts}. Click to edit.">${esc(n.name)} → ${pcts}<button class="icon" data-clear-ev="${id}" title="Remove this evidence">✕</button></span>`;
        }
        if (!Array.isArray(v)) return `<span class="ev-chip">${esc(n.name)} = ${esc(n.labels[v])}<button class="icon" data-clear-ev="${id}" title="Remove this evidence">✕</button></span>`;
        const lik = v.map((x) => +x.toPrecision(2)).join(" : ");
        return `<span class="ev-chip soft" data-edit-ev="${id}" title="Soft evidence: likelihood of the observation for ${esc(n.labels.join(" : "))}. Click to edit.">${esc(n.name)} ≈ ${lik}<button class="icon" data-clear-ev="${id}" title="Remove this evidence">✕</button></span>`;
      };
      body = `<span class="ev-label">Evidence</span>` + [...ev].map(chip).join("") +
        (onlyTargets(ev) ? "" : `<span class="muted" title="Probability of all the observations together, before observing them${[...ev.values()].some(isDo) ? ", given the interventions" : ""}${[...ev.values()].some(isTarget) ? " (probabilities you set directly aren't observations, so they aren't included)" : ""}">P(evidence) = ${inf.pEvidenceText || fmtP(inf.pEvidence)}</span>`) +
        `<button class="small" data-clear-ev="all">Clear all</button>`;
    }
    evidenceBar.innerHTML = (body ? body + `<span class="sep"></span>` : "") + modes + toggle;
  }
  evidenceBar.addEventListener("click", (e) => {
    const m = e.target.closest("[data-click-mode]");
    if (m) {
      clickMode = m.dataset.clickMode;
      savePreference(CLICK_KEY, clickMode);
      if (clickMode === "intervene") closeSoftEditor();
      render();
      schedulePanel();
      return;
    }
    const b = e.target.closest("[data-clear-ev]");
    if (b) {
      const next = new Map(evidence);
      if (b.dataset.clearEv === "all") next.clear();
      else next.delete(+b.dataset.clearEv);
      if (b.dataset.clearEv === "all" || +b.dataset.clearEv === softId) hideSoftEditor();
      setEvidence(next);
      return;
    }
    const chip = e.target.closest("[data-edit-ev]");
    if (chip) openSoftEditor(+chip.dataset.editEv);
  });
  evidenceBar.addEventListener("change", (e) => {
    if (!e.target.matches("[data-soft-mode]")) return;
    softMode = e.target.checked;
    savePreference(SOFT_KEY, softMode ? "1" : "0");
    if (!softMode) closeSoftEditor();
    render();
    schedulePanel();
  });

  // ------------------------------------------------------------ soft evidence editor

  const softEditor = $("#soft-editor");
  const isNeutral = (lik) => lik.every((x) => Math.abs(x - lik[0]) <= 1e-9 * Math.max(...lik));

  // The values the editor shows for the node, in the given kind. Switching kinds converts the
  // current evidence, so the node's probabilities stay the same.
  function softValues(id, kind = softKind) {
    const n = M.getNode(net, id);
    const cur = evidenceIndices().get(id);
    if (kind === "probabilities") {
      if (isTarget(cur)) return cur.target;
      const p = inference().marginals?.get(id);
      return p ? p.slice() : n.labels.map(() => 1 / n.labels.length);
    }
    if (Array.isArray(cur)) return cur;
    if (isTarget(cur)) return inference().likelihoods?.get(id) || n.labels.map(() => 1);
    if (typeof cur === "number") return n.labels.map((_, s) => (s === cur ? 1 : 0));
    return n.labels.map(() => 1);
  }

  const softEntry = (vals) => (softKind === "probabilities" ? { target: vals } : vals);
  // Probabilities are shown in percent.
  const softShown = (v) => (softKind === "probabilities" ? +(v * 100).toPrecision(4) : +v.toPrecision(4));

  function openSoftEditor(id, focusState = 0) {
    if (softId !== null && softId !== id) closeSoftEditor();
    const n = M.getNode(net, id);
    const cur = evidenceIndices().get(id);
    if (Array.isArray(cur)) softKind = "likelihoods";
    else if (isTarget(cur)) softKind = "probabilities";
    softId = id;
    const vals = softValues(id);
    const probs = softKind === "probabilities";
    const kindButton = (k, label, title) => `<button type="button" class="small${softKind === k ? " on" : ""}" data-soft-kind="${k}" title="${title}">${label}</button>`;
    softEditor.innerHTML = `
      <div class="soft-head"><b>${esc(n.name)}</b><span class="muted">soft evidence</span><span class="grow"></span><button class="icon" data-soft-close title="Close (Esc)">✕</button></div>
      <div class="seg-toggle soft-kind">${kindButton("probabilities", "Probabilities", "Set what the node's probabilities should be after all the evidence (Jeffrey's rule)")}${kindButton("likelihoods", "Likelihoods", "Say how likely the observation is under each state, as in pyAgrum's setEvidence")}</div>
      <p class="muted">${probs
        ? `What should the probabilities of <b>${esc(n.name)}</b> be? They always add up to 100%: changing one rescales the others. The rest of the network updates to match.`
        : `How likely is what you observed if <b>${esc(n.name)}</b> is in each state? Only the ratios matter: 1 : 0 is the same as observing the first state for certain, and equal values mean no evidence.`}</p>
      ${n.labels.map((l, s) => `<div class="soft-row">
        <span class="slabel" title="${esc(l)}">${esc(l)}</span>
        <input type="range" min="0" max="${probs ? 100 : 1}" step="${probs ? 1 : 0.01}" data-lik="${s}" value="${softShown(vals[s])}">
        <span class="soft-num"><input type="number" min="0"${probs ? ' max="100"' : ""} step="${probs ? 1 : 0.01}" data-lik="${s}" value="${softShown(vals[s])}">${probs ? "%" : ""}</span>
      </div>`).join("")}
      <div class="soft-actions"><button class="small" data-soft-reset>Reset</button><button class="small danger" data-soft-remove>Remove</button><span class="grow"></span><button class="small primary" data-soft-close>Done</button></div>`;
    softEditor.hidden = false;
    const next = new Map(evidence);
    next.set(id, softEntry(vals.slice()));
    setEvidence(next); // renders, which positions the editor
    const input = softEditor.querySelector(`input[type="number"][data-lik="${focusState}"]`);
    if (input) { input.focus(); input.select(); }
  }

  function syncSoftInputs(except) {
    const vals = softValues(softId);
    softEditor.querySelectorAll("[data-lik]").forEach((input) => {
      if (input !== except) input.value = softShown(vals[+input.dataset.lik]);
    });
  }

  function hideSoftEditor() {
    softEditor.hidden = true;
    softId = null;
  }

  // Closes the editor; equal likelihoods carry no information, so they are dropped.
  function closeSoftEditor() {
    if (softId === null) return;
    const id = softId;
    hideSoftEditor();
    const cur = evidence.get(id);
    const lik = isTarget(cur) ? inference().likelihoods?.get(id) : cur;
    if (Array.isArray(lik) && isNeutral(lik)) {
      const next = new Map(evidence);
      next.delete(id);
      setEvidence(next);
    }
  }

  function positionSoftEditor() {
    if (softId === null) return;
    const n = M.getNode(net, softId);
    if (!n || !showProbs) { hideSoftEditor(); return; }
    const { w, h } = nodeSize(n);
    const wrap = $("#canvas-wrap").getBoundingClientRect();
    const ew = softEditor.offsetWidth, eh = softEditor.offsetHeight;
    // A node that's off screen (opened from its watch card) gets the editor next to the card.
    const sx0 = view.x + (n.x - w / 2) * view.k, sx1 = view.x + (n.x + w / 2) * view.k;
    const sy0 = view.y + (n.y - h / 2) * view.k, sy1 = view.y + (n.y + h / 2) * view.k;
    const card = watchPanel.querySelector(`[data-watch="${n.id}"]`);
    if (card && (sx1 < 0 || sx0 > wrap.width || sy1 < 0 || sy0 > wrap.height)) {
      const r = card.getBoundingClientRect();
      softEditor.style.left = Math.max(8, r.left - wrap.left - ew - 10) + "px";
      softEditor.style.top = Math.max(8, Math.min(wrap.height - eh - 8, r.top - wrap.top)) + "px";
      return;
    }
    let x = view.x + (n.x + w / 2) * view.k + 10;
    if (x + ew > wrap.width - 8) x = view.x + (n.x - w / 2) * view.k - ew - 10;
    const y = view.y + (n.y - h / 2) * view.k;
    softEditor.style.left = Math.max(8, Math.min(wrap.width - ew - 8, x)) + "px";
    softEditor.style.top = Math.max(8, Math.min(wrap.height - eh - 8, y)) + "px";
  }

  softEditor.addEventListener("input", (e) => {
    if (e.target.dataset.lik === undefined || softId === null) return;
    const v = parseFloat(e.target.value);
    if (!(v >= 0)) return;
    const s = +e.target.dataset.lik;
    let vals = softValues(softId).slice();
    if (softKind === "probabilities") {
      // set this state, and rescale the others so the probabilities still add up to 1
      const q = Math.min(1, v / 100);
      const others = vals.reduce((a, x, i) => (i === s ? a : a + x), 0);
      vals = vals.map((x, i) => (i === s ? q : others > 0 ? (x * (1 - q)) / others : (1 - q) / (vals.length - 1)));
    } else {
      vals[s] = v;
      if (!vals.some((x) => x > 0)) { toast("At least one state needs a likelihood above 0"); syncSoftInputs(); return; }
    }
    const next = new Map(evidence);
    next.set(softId, softEntry(vals));
    syncSoftInputs(setEvidence(next) ? e.target : null);
  });
  softEditor.addEventListener("click", (e) => {
    const kind = e.target.closest("[data-soft-kind]");
    if (kind) {
      if (kind.dataset.softKind === softKind) return;
      const id = softId, vals = softValues(id, kind.dataset.softKind);
      softKind = kind.dataset.softKind;
      savePreference(SOFT_KIND_KEY, softKind);
      const next = new Map(evidence);
      next.set(id, softEntry(vals));
      setEvidence(next);
      openSoftEditor(id);
    } else if (e.target.closest("[data-soft-close]")) closeSoftEditor();
    else if (e.target.closest("[data-soft-reset]")) {
      // back to no information: equal likelihoods, or the node's probabilities without this evidence
      const next = new Map(evidence);
      next.delete(softId);
      const vals = softKind === "probabilities" ? BNInference.posteriors(net, evidenceIndices(next)).marginals?.get(softId) : null;
      next.set(softId, softEntry(vals || M.getNode(net, softId).labels.map(() => 1)));
      setEvidence(next);
      syncSoftInputs();
    } else if (e.target.closest("[data-soft-remove]")) {
      const next = new Map(evidence);
      next.delete(softId);
      hideSoftEditor();
      setEvidence(next);
    }
  });
  softEditor.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || (e.key === "Enter" && e.target.type === "number")) { e.preventDefault(); closeSoftEditor(); svg.focus(); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (softId !== null && !e.target.closest("#soft-editor, #evidence-bar")) closeSoftEditor();
  });

  function rubberRect() {
    const a = drag.start, b = drag.pos;
    return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  }

  // ------------------------------------------------------------ canvas interaction

  function newNodeAt(p, opts = {}) {
    const name = M.uniqueName(net, opts.name || "X");
    let node;
    change(() => {
      node = M.addNode(net, { name, labels: ["yes", "no"], x: p.x, y: p.y });
      if (opts.parent) M.addArc(net, opts.parent, node.id);
    });
    select([node.id]);
    startInlineEdit(node.id, true);
    return node;
  }

  // Fingers on the canvas, for pinch zoom: pointer id -> position.
  const touches = new Map();
  const pinchState = () => {
    const [a, b] = [...touches.values()], r = svg.getBoundingClientRect();
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top };
  };

  svg.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size >= 2) {
      // a second finger: pinch to zoom (and pan), unless the first one is already moving nodes
      if (drag && drag.mode === "move" && drag.moved) return;
      drag = { mode: "pinch", start: pinchState(), view: { ...view } };
      svg.setPointerCapture(e.pointerId);
      showNodeTip(null);
      return;
    }
    if (e.button !== 0 && e.button !== 1) return;
    commitInline();
    svg.focus({ preventScroll: true });
    const p = toWorld(e);
    const port = e.target.closest("[data-port]");
    const nodeEl = e.target.closest("[data-node]");
    const arcEl = e.target.closest(".arc");
    if (viewer) {
      // The viewer only pans, and a click on a state sets evidence.
      const st = showProbs && nodeEl && e.target.closest("[data-state]");
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, state: st ? { id: +nodeEl.dataset.node, s: +st.dataset.state } : null,
        touch: e.pointerType === "touch", node: nodeEl ? +nodeEl.dataset.node : null };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 1) {
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    } else if (port || (nodeEl && e.shiftKey)) {
      const id = +(port ? port.dataset.port : nodeEl.dataset.node);
      drag = { mode: "arc", from: id, start: p, pos: p, target: null, moved: false };
    } else if (nodeEl) {
      const id = +nodeEl.dataset.node;
      if (e.ctrlKey || e.metaKey) {
        const s = new Set(selNodes);
        s.has(id) ? s.delete(id) : s.add(id);
        select(s);
        return;
      }
      if (!selNodes.has(id)) select([id]);
      const stateEl = showProbs && e.target.closest("[data-state]");
      drag = {
        mode: "move", start: p, moved: false,
        state: stateEl ? { id, s: +stateEl.dataset.state } : null,
        origin: [...selNodes].map((sid) => { const n = M.getNode(net, sid); return { n, x: n.x, y: n.y }; }),
      };
    } else if (arcEl) {
      select([], { from: +arcEl.dataset.from, to: +arcEl.dataset.to });
      return;
    } else if (e.shiftKey) {
      drag = { mode: "rubber", start: p, pos: p, base: new Set(selNodes), moved: false };
    } else {
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    }
    svg.setPointerCapture(e.pointerId);
  });

  // Hovering a node that has a description shows it in a card under the node.
  const nodeTip = $("#node-tip");
  let tipId = null;
  function showNodeTip(id) {
    const n = id === null ? null : M.getNode(net, id);
    if (!n || !n.description || drag) { nodeTip.hidden = true; tipId = null; return; }
    if (tipId !== id) {
      const hint = showProbs ? clickHint() : "";
      nodeTip.innerHTML = `<b>${esc(n.name)}</b><p>${esc(n.description)}</p>` + (M.badRows(n).length ? `<p class="warn">CPT rows do not sum to 1</p>` : "") + (hint ? `<p class="muted">${hint}</p>` : "");
      tipId = id;
    }
    nodeTip.hidden = false;
    const { h } = nodeSize(n), wrapW = svg.clientWidth, tw = nodeTip.offsetWidth, th = nodeTip.offsetHeight;
    const cx = view.x + n.x * view.k;
    let top = view.y + (n.y + h / 2) * view.k + 8;
    if (top + th > svg.clientHeight - 4) top = view.y + (n.y - h / 2) * view.k - th - 8;
    nodeTip.style.left = Math.max(4, Math.min(wrapW - tw - 4, cx - tw / 2)) + "px";
    nodeTip.style.top = Math.max(4, top) + "px";
  }
  svg.addEventListener("pointerover", (e) => { if (e.pointerType === "touch") return; const el = e.target.closest("[data-node]"); showNodeTip(el ? +el.dataset.node : null); });
  svg.addEventListener("pointerleave", () => showNodeTip(null));
  svg.addEventListener("pointerdown", () => showNodeTip(null));
  svg.addEventListener("wheel", () => showNodeTip(null), { passive: true });

  svg.addEventListener("pointermove", (e) => {
    lastPointer = toWorld(e);
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;
    const p = lastPointer;
    if (drag.mode === "pinch") {
      if (touches.size < 2) return;
      const now = pinchState(), s = drag.start, v = drag.view;
      // the world point that was under the fingers' midpoint stays under it
      const k = Math.min(3, Math.max(0.2, v.k * (now.d / s.d)));
      view = { k, x: now.cx - ((s.cx - v.x) / v.k) * k, y: now.cy - ((s.cy - v.y) / v.k) * k };
      fitted = false;
      applyView();
    } else if (drag.mode === "pan") {
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      svg.classList.add("panning");
      view.x = drag.vx + dx; view.y = drag.vy + dy;
      fitted = false;
      applyView();
    } else if (drag.mode === "move") {
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) * view.k < 3) return;
      if (!drag.moved) { checkpoint(); drag.moved = true; }
      for (const o of drag.origin) { o.n.x = o.x + dx; o.n.y = o.y + dy; }
      render();
    } else if (drag.mode === "arc") {
      if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * view.k < 8) return;
      drag.moved = true;
      drag.pos = p;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const t = el && el.closest("[data-node]");
      drag.target = t && +t.dataset.node !== drag.from ? +t.dataset.node : null;
      render();
    } else if (drag.mode === "rubber") {
      drag.moved = true;
      drag.pos = p;
      const r = rubberRect();
      const s = new Set(drag.base);
      for (const n of net.nodes) if (n.x >= r.x0 && n.x <= r.x1 && n.y >= r.y0 && n.y <= r.y1) s.add(n.id);
      selNodes = s;
      render();
    }
  });

  function endDrag(e) {
    touches.delete(e.pointerId);
    if (!drag) return;
    const d = drag;
    drag = null;
    svg.classList.remove("panning");
    if (d.mode === "pinch") return; // the other finger lifting does nothing either
    if (d.mode === "pan" && !d.moved && d.touch) openNodeSheet(d.node);
    else if (d.mode === "pan" && !d.moved && d.state) clickState(d.state.id, d.state.s);
    else if (d.mode === "pan" && !d.moved) select([]);
    else if (d.mode === "move" && d.moved) { save(); render(); }
    else if (d.mode === "move" && d.state) clickState(d.state.id, d.state.s);
    else if (d.mode === "arc") {
      if (d.target) {
        if (M.hasArc(net, d.from, d.target)) { toast("That arc already exists"); render(); return; }
        if (M.wouldCycle(net, d.from, d.target)) { toast("That arc would create a cycle"); render(); return; }
        change(() => M.addArc(net, d.from, d.target));
        select([d.target]);
      } else if (d.moved && e.type === "pointerup") {
        newNodeAt(d.pos, { parent: d.from });
      } else render();
    } else if (d.mode === "rubber") { render(); renderPanel(); }
  }
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  svg.addEventListener("dblclick", (e) => {
    if (viewer) return;
    // The canvas is re-rendered on every click, so look up what is under the pointer now.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const nodeEl = el && el.closest("[data-node]");
    if (nodeEl && el.closest("[data-state]")) return; // its two clicks already toggled evidence on and off
    if (nodeEl) startInlineEdit(+nodeEl.dataset.node);
    else if (!(el && el.closest(".arc"))) newNodeAt(toWorld(e));
  });

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
    const k = Math.min(3, Math.max(0.2, view.k * factor));
    view.x = mx - ((mx - view.x) / view.k) * k;
    view.y = my - ((my - view.y) / view.k) * k;
    view.k = k;
    fitted = false;
    applyView();
  }, { passive: false });

  window.addEventListener("resize", () => render());
  // When the canvas changes size (window, side panel or table resized), a fitted view is fitted
  // again; otherwise what was at the centre of the canvas stays at its centre, at the same zoom.
  let canvasSize = null;
  new ResizeObserver(() => {
    const { width, height } = svg.getBoundingClientRect();
    if (canvasSize && width && height && (width !== canvasSize.width || height !== canvasSize.height)) {
      if (fitted) fit();
      else {
        view.x += (width - canvasSize.width) / 2;
        view.y += (height - canvasSize.height) / 2;
        applyView();
      }
    }
    canvasSize = { width, height };
  }).observe(svg);

  // ------------------------------------------------------------ inline rename

  let inlineId = null;
  function startInlineEdit(id, isNew = false) {
    const n = M.getNode(net, id);
    inlineId = id;
    inline.value = n.name;
    inline.hidden = false;
    inline.dataset.isNew = isNew ? "1" : "";
    positionInline();
    inline.focus();
    inline.select();
  }
  function positionInline() {
    const n = M.getNode(net, inlineId);
    if (!n) { inline.hidden = true; return; }
    const w = Math.max(nodeSize(n).w, 120) * view.k;
    inline.style.width = w + "px";
    inline.style.left = view.x + n.x * view.k - w / 2 + "px";
    inline.style.top = view.y + (n.y - nodeSize(n).h / 2 + (showProbs ? 4 : 11)) * view.k + "px";
    inline.style.fontSize = 14 * view.k + "px";
  }
  function commitInline() {
    if (inline.hidden) return;
    const id = inlineId;
    inline.hidden = true;
    inlineId = null;
    renameNode(id, inline.value);
  }
  inline.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitInline(); svg.focus(); }
    else if (e.key === "Escape") { inline.hidden = true; inlineId = null; svg.focus(); }
    e.stopPropagation();
  });
  inline.addEventListener("blur", commitInline);

  function renameNode(id, name) {
    const n = M.getNode(net, id);
    name = name.trim();
    if (!n || name === n.name) return true;
    if (!name) { toast("Names cannot be empty"); renderPanel(); return false; }
    if (M.nodeByName(net, name)) { toast(`There is already a node called “${name}”`); renderPanel(); return false; }
    change(() => { n.name = name; });
    return true;
  }

  // ------------------------------------------------------------ keyboard

  document.addEventListener("keydown", (e) => {
    const inField = e.target.closest("input, textarea, select, dialog");
    const inGrid = e.target.closest(".cpt-scroll");
    const mod = e.ctrlKey || e.metaKey;
    if (viewer) {
      if (!inField && !mod && (e.key === "f" || e.key === "F")) fit();
      return;
    }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); downloadPython(); return; }
    if (inGrid && !inField && mod && !cpt.isEditing()) {
      // the CPT grid handles its own keys, but undo/redo stay global
      if (e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      return;
    }
    if (inField || inGrid) return;
    if (e.target.closest("button") && (e.key === "Enter" || e.key === " ")) return;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); select(net.nodes.map((n) => n.id)); }
    else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelection(); }
    else if (mod) return;
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); }
    else if (e.key === "Escape") select([]);
    else if (e.key === "f" || e.key === "F") fit();
    else if (e.key === "p" || e.key === "P") toggleProbs();
    else if ((e.key === "c" || e.key === "C") && cptNodeId() != null) { e.preventDefault(); cpt.focus(); }
    else if (e.key === "n" || e.key === "N") { e.preventDefault(); addNodeShortcut(); }
    else if ((e.key === "w" || e.key === "W") && selNodes.size) { e.preventDefault(); toggleWatch([...selNodes]); }
    else if (e.key === "Enter" && selNodes.size === 1) { e.preventDefault(); startInlineEdit([...selNodes][0]); }
    else if (e.key.startsWith("Arrow") && selNodes.size) {
      e.preventDefault();
      const step = e.shiftKey ? 50 : 10;
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      change(() => { for (const id of selNodes) { const n = M.getNode(net, id); n.x += dx; n.y += dy; } });
    }
  });

  function addNodeShortcut(atCenter) {
    const r = svg.getBoundingClientRect();
    const center = { x: (r.width / 2 - view.x) / view.k, y: (r.height / 2 - view.y) / view.k };
    const p = (!atCenter && lastPointer) || center;
    newNodeAt({ x: p.x, y: p.y });
  }

  function deleteSelection() {
    if (selArc) { const a = selArc; change(() => M.removeArc(net, a.from, a.to)); return; }
    if (!selNodes.size) return;
    const ids = [...selNodes];
    change(() => ids.forEach((id) => M.removeNode(net, id)));
  }

  function duplicateSelection() {
    if (!selNodes.size) return;
    const ids = [...selNodes];
    const created = [];
    change(() => {
      for (const id of ids) {
        const n = M.getNode(net, id);
        const copy = M.addNode(net, { ...structuredClone(n), name: M.uniqueName(net, n.name + "_copy"), x: n.x + 30, y: n.y + 30 });
        created.push(copy.id);
      }
      // keep arcs between duplicated nodes, and arcs from outside parents
      for (const a of net.arcs.slice()) {
        const ti = ids.indexOf(a.to);
        if (ti < 0) continue;
        const fi = ids.indexOf(a.from);
        M.addArc(net, fi >= 0 ? created[fi] : a.from, created[ti]);
      }
      ids.forEach((id, i) => { M.getNode(net, created[i]).cpt = M.getNode(net, id).cpt.slice(); });
    });
    select(created);
  }

  // ------------------------------------------------------------ watch panel

  // net.watch: ids of the nodes pinned to the watch panel, in the order they were pinned. It's
  // part of the network (saved, undoable, exported) so shared links keep it.
  const watchPanel = $("#watch-panel");
  const watchList = () => (net.watch || []).filter((id) => M.getNode(net, id));
  const watched = (id) => watchList().includes(id);

  // Pins the nodes, or unpins them when they're all pinned already.
  function toggleWatch(ids) {
    const list = watchList();
    const all = ids.every((id) => list.includes(id));
    change(() => { net.watch = all ? list.filter((id) => !ids.includes(id)) : [...list, ...ids.filter((id) => !list.includes(id))]; });
    toast(all ? (ids.length > 1 ? `Stopped watching ${ids.length} variables` : `Stopped watching ${M.getNode(net, ids[0]).name}`)
      : `Watching ${ids.length > 1 ? ids.length + " variables" : M.getNode(net, ids[0]).name}: see the panel in the corner`);
  }

  function renderWatchPanel(inf) {
    const list = inf ? watchList() : [];
    watchPanel.hidden = !list.length;
    if (!list.length) { watchPanel.innerHTML = ""; return; }
    const ev = evidenceIndices();
    watchPanel.innerHTML = `<div class="watch-head"${viewer ? "" : ' title="Select a variable and press W to add it here"'}><b>Watching</b></div>` + list.map((id) => {
      const n = M.getNode(net, id);
      return stateCard(n, inf, ev, `<button class="link-button" data-watch-go="${id}" title="Show ${esc(n.name)} on the canvas">${esc(n.name)}</button>${viewer ? "" : `<button class="icon" data-unwatch="${id}" title="Stop watching">✕</button>`}`);
    }).join("");
  }

  // A card with a node's probabilities, one button per state, as in the watch panel and the
  // viewer's node card. `head` is the HTML of its title line.
  function stateCard(n, inf, ev, head, extra = "") {
    const probs = inf.marginals && inf.marginals.get(n.id), observed = ev.get(n.id);
    const kind = observed === undefined ? "" : isDo(observed) ? " intervened" : typeof observed === "object" ? " soft-observed" : " observed";
    return `<div class="watch-card${kind}${selNodes.has(n.id) ? " selected" : ""}" data-watch="${n.id}">
      <div class="watch-name">${head}</div>${extra}
      ${n.labels.map((l, s) => {
        const p = probs ? probs[s] : null;
        const pct = p === null ? "–" : pctText(p, probs);
        const on = observed === s ? " observed" : isDo(observed) && observed.do === s ? " intervened" : "";
        return `<button class="watch-row${on}" data-watch-state="${s}" title="${esc(clickHint())}"><span class="wl">${esc(l)}</span><span class="wbar"><span style="width:${(p || 0) * 100}%"></span></span><span class="wp">${pct}</span></button>`;
      }).join("")}
    </div>`;
  }

  // ------------------------------------------------------------ viewer node card (touchscreens)

  // On a touchscreen the viewer's state bars are too small to tap, and there's no hover for
  // descriptions, so tapping a node opens this card at the bottom of the canvas instead, with
  // the node's description and a large button per state.
  const nodeSheet = $("#node-sheet");
  let sheetId = null;
  function openNodeSheet(id) {
    sheetId = id;
    select(id === null ? [] : [id]);
  }
  function renderNodeSheet(inf) {
    const n = sheetId === null ? null : M.getNode(net, sheetId);
    nodeSheet.hidden = !n || !inf || !viewer;
    document.body.classList.toggle("sheet-open", !nodeSheet.hidden);
    if (nodeSheet.hidden) { nodeSheet.innerHTML = ""; return; }
    nodeSheet.innerHTML = stateCard(n, inf, evidenceIndices(), `<b>${esc(n.name)}</b><button class="icon" data-sheet-close title="Close">✕</button>`,
      n.description ? `<p class="sheet-desc">${esc(n.description)}</p>` : "");
  }
  nodeSheet.addEventListener("click", (e) => {
    if (e.target.closest("[data-sheet-close]")) { openNodeSheet(null); return; }
    const row = e.target.closest("[data-watch-state]");
    if (row) clickState(sheetId, +row.dataset.watchState);
  });

  watchPanel.addEventListener("click", (e) => {
    const un = e.target.closest("[data-unwatch]");
    if (un) { toggleWatch([+un.dataset.unwatch]); return; }
    const go = e.target.closest("[data-watch-go]");
    if (go) {
      const n = M.getNode(net, +go.dataset.watchGo);
      // centre the node, keeping the zoom
      view.x = svg.clientWidth / 2 - n.x * view.k;
      view.y = svg.clientHeight / 2 - n.y * view.k;
      fitted = false;
      applyView();
      if (!viewer) select([n.id]);
      return;
    }
    const row = e.target.closest("[data-watch-state]");
    if (row) clickState(+row.closest("[data-watch]").dataset.watch, +row.dataset.watchState);
  });
  // keep wheel and drag on the panel from reaching the canvas
  watchPanel.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  // ------------------------------------------------------------ side panel

  let focusAfterRender = null;

  const focusKeys = ["id", "data-cell", "data-state", "data-dom"];
  function renderPanel() {
    const active = panel.contains(document.activeElement) ? document.activeElement : null;
    const key = active && focusKeys.find((k) => active.hasAttribute(k));
    if (key && !focusAfterRender) focusAfterRender = { sel: `[${key}="${CSS.escape(active.getAttribute(key))}"]` };
    renderPanelContent();
    if (focusAfterRender) {
      const el = panel.querySelector(focusAfterRender.sel);
      if (el) { el.focus(); if (focusAfterRender.select) el.select(); }
      focusAfterRender = null;
    }
  }

  const side = $("#side"), panelStrip = $("#panel-strip");
  function setPanelCollapsed(collapsed) {
    side.classList.toggle("collapsed", collapsed);
    $("#panel-toggle").setAttribute("aria-expanded", !collapsed);
    savePreference(PANEL_KEY, collapsed ? "1" : "0");
  }
  $("#panel-toggle").addEventListener("click", () => setPanelCollapsed(true));
  panelStrip.addEventListener("click", () => setPanelCollapsed(false));
  setPanelCollapsed(preference(PANEL_KEY) === "1");

  function renderPanelContent() {
    const one = selNodes.size === 1 ? M.getNode(net, [...selNodes][0]) : null;
    panelStrip.textContent = one ? `Variable: ${one.name}` : selNodes.size > 1 ? `${selNodes.size} variables selected` : selArc ? "Arc" : `Network: ${net.name}`;
    if (selArc) return renderArcPanel();
    if (selNodes.size === 1) return renderNodePanel(M.getNode(net, [...selNodes][0]));
    if (selNodes.size > 1) {
      panel.innerHTML = `<h2>${selNodes.size} nodes selected</h2>
        <p class="muted">Drag to move them together. <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates, <kbd>Del</kbd> deletes.</p>
        <button class="danger" data-act="delete">Delete ${selNodes.size} nodes</button> <button data-act="watch" title="Pin these variables to the watch panel (W)">${[...selNodes].every(watched) ? "Unwatch" : "Watch"} ${selNodes.size} nodes</button>`;
      panel.querySelector('[data-act="delete"]').onclick = deleteSelection;
      panel.querySelector('[data-act="watch"]').onclick = () => toggleWatch([...selNodes]);
      return;
    }
    renderNetworkPanel();
  }

  function renderNetworkPanel() {
    const bad = net.nodes.filter((n) => M.badRows(n).length);
    panel.innerHTML = `
      <h2>Network</h2>
      <div class="field"><label for="net-name">Name</label><input id="net-name" type="text" value="${esc(net.name)}"></div>
      <p class="muted">A Bayesian network with ${net.nodes.length} variables and ${net.arcs.length} arcs.</p>
      ${bad.length ? `<h3>Problems</h3><ul class="warn">${bad.map((n) => `<li><span class="link" data-select="${n.id}">${esc(n.name)}</span>: CPT rows do not sum to 1</li>`).join("")}</ul>` : ""}
      ${showProbs && net.nodes.length ? `<p class="click-mode-help${clickMode === "intervene" ? " intervene" : ""}">${clickModeText()}</p>` : ""}
      <h3>Editing</h3>
      <dl class="help">
        <dt>Add a node</dt><dd>Double-click empty space, or press <kbd>N</kbd>. Type its name and press <kbd>Enter</kbd>.</dd>
        <dt>Add an arc</dt><dd>Drag from the dot under a node onto another node (or <kbd>Shift</kbd>-drag a node). Drop on empty space to create a new child.</dd>
        <dt>Rename</dt><dd>Double-click a node, or select it and press <kbd>Enter</kbd>.</dd>
        <dt>Select</dt><dd>Click; <kbd>Ctrl</kbd>-click to add; <kbd>Shift</kbd>-drag on empty space for a box; <kbd>Ctrl</kbd>+<kbd>A</kbd> for all.</dd>
        <dt>Move</dt><dd>Drag nodes, or nudge with arrow keys. Drag empty space to pan, scroll to zoom, <kbd>F</kbd> to fit.</dd>
        <dt>CPTs</dt><dd>Select a variable and edit its CPT in the table under the canvas: type in cells (with “Keep rows summing to 1” on, the rest of the row is adjusted for you), drag the dividers in each row's bar, double-click a bar segment for 100%. Copy and paste work with spreadsheets; pasting one row into several selected rows repeats it. Click a parent cell to select its rows.</dd>
        <dt>Probabilities &amp; evidence</dt><dd>With <b>Probabilities</b> on (<kbd>P</kbd>), every node shows the probability of each of its states, computed exactly from the CPTs. Click a state to observe it (for example “the grass is wet”); all other nodes update to the probabilities given that evidence. Click it again, or use the evidence bar, to clear it. Turn on <b>Soft evidence</b> in the evidence bar to set a node's probabilities directly, or to enter likelihoods for its states, instead of a certain observation.</dd>
        <dt>Watching</dt><dd>Select a variable and press <kbd>W</kbd> (or <b>☆ Watch</b> in this panel) to pin its probabilities to a panel in the corner of the canvas. It stays in view however you pan or zoom, so you can set evidence at one end of a big network and see the effect at the other. Click a state in a card to set evidence there too, or its name to jump to the node.</dd>
        <dt>Interventions</dt><dd>To ask what happens if you <i>make</i> something true, rather than learn that it is, switch the evidence bar to <b>Intervene</b> and click a state. That sets do(node = state): the arcs into the node are cut (shown dashed), so it changes only what it causes and says nothing about its causes. For example, do(law passed = yes) shows the law's own effect on crime, without the public sentiment that makes laws pass. Interventions and observations can be combined.</dd>
        <dt>Delete / duplicate</dt><dd><kbd>Del</kbd> / <kbd>Ctrl</kbd>+<kbd>D</kbd>. Undo with <kbd>Ctrl</kbd>+<kbd>Z</kbd>.</dd>
        <dt>pyAgrum</dt><dd>Export writes <code>import pyagrum as gum</code> code; <kbd>Ctrl</kbd>+<kbd>S</kbd> downloads it. Import accepts that code, hand-written <code>gum.BayesNet</code> code, and <code>gum.fastBN</code>. Export can also save a PNG or SVG picture of the canvas (with probabilities, if shown) that has the network embedded, so the picture can be imported again. You can drop a .py, .png or .svg file on the canvas. To share a network, host one of those files somewhere that allows cross-origin downloads (e.g. a GitHub repo or gist) and link to this page with <code>?src=</code> followed by the file's URL.</dd>
      </dl>
      <p class="panel-foot muted"><a href="https://github.com/syvb/bayesian-network" target="_blank" rel="noopener">Source on GitHub</a> · Apache 2.0</p>`;
    const nameInput = panel.querySelector("#net-name");
    nameInput.onchange = () => change(() => { net.name = nameInput.value; });
    panel.querySelectorAll("[data-select]").forEach((el) => (el.onclick = () => select([+el.dataset.select])));
  }

  function renderArcPanel() {
    const f = M.getNode(net, selArc.from), t = M.getNode(net, selArc.to);
    panel.innerHTML = `
      <h2>Arc</h2>
      <p><span class="link" data-select="${f.id}">${esc(f.name)}</span> → <span class="link" data-select="${t.id}">${esc(t.name)}</span></p>
      <p class="muted">Reversing keeps every probability the same, as pyAgrum's <code>reverseArc</code> does: both CPTs are recomputed with Bayes' rule, and each node also gets the other's parents, which can add arcs.</p>
      <button data-act="reverse">Reverse</button> <button class="danger" data-act="delete">Delete</button>`;
    panel.querySelectorAll("[data-select]").forEach((el) => (el.onclick = () => select([+el.dataset.select])));
    panel.querySelector('[data-act="delete"]').onclick = deleteSelection;
    panel.querySelector('[data-act="reverse"]').onclick = () => {
      const a = selArc;
      const arcs = net.arcs.length;
      const err = change(() => M.reverseArc(net, a.from, a.to));
      if (err) { toast(err); return; }
      select([], { from: a.to, to: a.from });
      const added = net.arcs.length - arcs;
      if (added) toast(`Reversed; added ${added} arc${added > 1 ? "s" : ""} so the probabilities stay the same`);
    };
  }

  function domainEditor(n) {
    if (n.type === "labelized") {
      return `<div class="states-list">${n.labels.map((l, i) =>
        `<div class="state-row"><span class="idx">${i}</span><input type="text" data-state="${i}" value="${esc(l)}"><button class="icon" data-remove-state="${i}" title="Remove state">✕</button></div>`).join("")}
        </div><button class="small" data-act="add-state" style="margin-top:4px">+ Add state</button>
        <p class="muted">Enter adds a state below; Backspace in an empty state removes it.</p>`;
    }
    if (n.type === "range") {
      return `<div class="field"><label>Min</label><input type="number" step="1" data-dom="min" value="${n.min}"></div>
              <div class="field"><label>Max</label><input type="number" step="1" data-dom="max" value="${n.max}"></div>`;
    }
    const key = n.type === "integer" ? "values" : "ticks";
    return `<div class="field"><label>${n.type === "integer" ? "Values" : "Ticks"}</label><input type="text" data-dom="${key}" value="${esc(n[key].map(M.fmtNum).join(", "))}"></div>
            <p class="muted">Comma-separated numbers${n.type === "discretized" ? " (at least two; states are the intervals between them)" : ""}.</p>`;
  }

  function convertType(n, type) {
    const c = n.labels.length;
    if (type === "labelized") return { type, labels: n.labels.slice() };
    if (type === "range") return { type, min: 0, max: c - 1 };
    if (type === "integer") return { type, values: n.labels.every((l) => /^-?\d+$/.test(l)) ? n.labels.map(Number) : [...Array(c).keys()] };
    return { type, ticks: [...Array(c + 1).keys()] };
  }

  function setDomain(n, spec) {
    const labels = spec.type === "labelized" ? spec.labels : M.labelsFor(spec);
    if (!labels.length) { toast("A variable needs at least one state"); renderPanel(); return; }
    if (new Set(labels).size !== labels.length) { toast("State names must be unique"); renderPanel(); return; }
    change(() => M.updateDomain(net, n.id, spec));
    flushPanel();
  }

  function renderNodePanel(n) {
    const parents = M.parentsOf(net, n.id).map((id) => M.getNode(net, id));
    const children = M.childrenOf(net, n.id).map((id) => M.getNode(net, id));
    const reorder = parents.length > 1;
    const chip = (o, role) => `<span class="chip"${role === "parent" && reorder ? ` draggable="true" tabindex="0" data-parent="${o.id}" title="Drag (or Alt+←/→) to reorder; the probability table's columns follow this order"` : ""} data-select="${o.id}">${esc(o.name)}<button class="icon" data-remove-arc="${role === "parent" ? o.id + ">" + n.id : n.id + ">" + o.id}" title="Remove arc">✕</button></span>`;
    panel.innerHTML = `
      <div class="panel-title"><h2>Variable</h2><button class="small${watched(n.id) ? " on" : ""}" data-act="watch" title="Pin this variable's probabilities to the watch panel in the corner of the canvas, so you can see them wherever you are in the network (W)">${watched(n.id) ? "★ Watching" : "☆ Watch"}</button></div>
      <div class="field"><label for="n-name">Name</label><input id="n-name" type="text" value="${esc(n.name)}"></div>
      <div class="field"><label for="n-desc">Description</label><input id="n-desc" type="text" value="${esc(n.description)}"></div>
      <div class="field"><label for="n-type">Type</label><select id="n-type">
        ${[["labelized", "Labelized"], ["range", "Range (integers)"], ["integer", "Integer values"], ["discretized", "Discretized"]]
          .map(([v, l]) => `<option value="${v}"${v === n.type ? " selected" : ""}>${l}</option>`).join("")}
      </select></div>
      <h3>States</h3>
      ${domainEditor(n)}
      <h3>Parents</h3>
      <div class="chips" id="parent-chips">${parents.map((p) => chip(p, "parent")).join("") || '<span class="muted">None</span>'}</div>
      ${reorder ? '<p class="muted chips-note">Drag to reorder. The probability table lists parents in this order, the first one in the leftmost column.</p>' : ""}
      <h3>Children</h3>
      <div class="chips">${children.map((c) => chip(c, "child")).join("") || '<span class="muted">None</span>'}</div>
      <h3>CPT</h3>
      <div class="seg-toggle" role="group" aria-label="How the CPT is set">
        ${[["", "Table", "Set the probabilities yourself in the table below the canvas"],
           ["and", "AND", "True exactly when every parent is true"],
           ["or", "OR", "True when at least one parent is true"]]
          .map(([g, l, t]) => `<button class="small${(n.gate || "") === g ? " on" : ""}" data-gate="${g}" title="${t}"${g && n.labels.length !== 2 ? " disabled" : ""}>${l}</button>`).join("")}
      </div>
      <p class="muted">${n.gate
        ? `${esc(n.name)} is <b>${esc(n.labels[M.trueState(n.labels)])}</b> when ${n.gate === "and" ? "all" : "any"} of its parents ${n.gate === "and" ? "are" : "is"} true, otherwise <b>${esc(n.labels[1 - M.trueState(n.labels)])}</b>. A parent counts as true in its ${parents.length ? parents.map((p) => `<b>${esc(p.labels[M.trueState(p.labels)])}</b>`).filter((x, i, a) => a.indexOf(x) === i).join(" / ") : "yes / true / first"} state. The table updates as you add parents; editing it turns this back into an ordinary table.`
        : n.labels.length === 2
          ? `Edit this variable's CPT in the table below the canvas (press <kbd>C</kbd> to jump there), or make it an AND or OR of its parents.`
          : `Edit this variable's CPT in the table below the canvas (press <kbd>C</kbd> to jump there). AND and OR need a variable with two states.`}</p>
      <p style="margin-top:16px"><button class="danger" data-act="delete">Delete variable</button></p>`;

    const name = panel.querySelector("#n-name");
    name.onchange = () => renameNode(n.id, name.value);
    name.onkeydown = (e) => { if (e.key === "Enter") name.blur(); };
    const desc = panel.querySelector("#n-desc");
    desc.onchange = () => change(() => { n.description = desc.value; });
    panel.querySelector("#n-type").onchange = (e) => setDomain(n, convertType(n, e.target.value));

    // labelized state list
    panel.querySelectorAll("[data-state]").forEach((input) => {
      const i = +input.dataset.state;
      const labelsWith = (fn) => { const l = n.labels.slice(); fn(l); return l; };
      input.onchange = () => {
        const v = input.value.trim();
        if (v === n.labels[i]) return;
        if (!v) { input.value = n.labels[i]; return; }
        setDomain(n, { type: "labelized", labels: labelsWith((l) => (l[i] = v)) });
      };
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const v = input.value.trim() || n.labels[i];
          const labels = labelsWith((l) => { l[i] = v; l.splice(i + 1, 0, M.uniqueName({ nodes: l.map((x) => ({ name: x })) }, "state")); });
          focusAfterRender = { sel: `[data-state="${i + 1}"]`, select: true };
          setDomain(n, { type: "labelized", labels });
        } else if (e.key === "Backspace" && input.value === "" && n.labels.length > 1) {
          e.preventDefault();
          focusAfterRender = { sel: `[data-state="${Math.max(0, i - 1)}"]` };
          setDomain(n, { type: "labelized", labels: labelsWith((l) => l.splice(i, 1)) });
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const next = panel.querySelector(`[data-state="${i + (e.key === "ArrowDown" ? 1 : -1)}"]`);
          if (next) { e.preventDefault(); next.focus(); }
        }
      };
    });
    panel.querySelectorAll("[data-remove-state]").forEach((b) => (b.onclick = () => {
      if (n.labels.length < 2) return toast("A variable needs at least one state");
      const l = n.labels.slice(); l.splice(+b.dataset.removeState, 1);
      setDomain(n, { type: "labelized", labels: l });
    }));
    const addState = panel.querySelector('[data-act="add-state"]');
    if (addState) addState.onclick = () => {
      focusAfterRender = { sel: `[data-state="${n.labels.length}"]`, select: true };
      setDomain(n, { type: "labelized", labels: n.labels.concat(M.uniqueName({ nodes: n.labels.map((x) => ({ name: x })) }, "state")) });
    };
    panel.querySelectorAll("[data-dom]").forEach((input) => (input.onchange = () => {
      const spec = { type: n.type, min: n.min, max: n.max, values: n.values, ticks: n.ticks };
      const k = input.dataset.dom;
      if (k === "min" || k === "max") {
        spec[k] = Math.trunc(+input.value);
        if (!(spec.max >= spec.min)) { toast("Max must be at least min"); return renderPanel(); }
      } else {
        const nums = input.value.split(/[,\s]+/).filter(Boolean).map(Number);
        if (nums.some((x) => !Number.isFinite(x)) || (k === "values" && nums.some((x) => !Number.isInteger(x)))) { toast("Enter comma-separated numbers"); return renderPanel(); }
        spec[k] = [...new Set(nums)].sort((a, b) => a - b);
        if (k === "ticks" && spec.ticks.length < 2) { toast("Discretized variables need at least two ticks"); return renderPanel(); }
      }
      setDomain(n, spec);
    }));

    panel.querySelectorAll("[data-select]").forEach((el) => (el.onclick = (e) => { if (!e.target.closest("button")) select([+el.dataset.select]); }));
    panel.querySelectorAll("[data-remove-arc]").forEach((b) => (b.onclick = () => {
      const [from, to] = b.dataset.removeArc.split(">").map(Number);
      change(() => M.removeArc(net, from, to));
    }));
    panel.querySelector('[data-act="delete"]').onclick = deleteSelection;
    panel.querySelector('[data-act="watch"]').onclick = () => toggleWatch([n.id]);
    panel.querySelectorAll("[data-gate]").forEach((b) => (b.onclick = () => change(() => {
      if (b.dataset.gate) n.gate = b.dataset.gate; else delete n.gate;
    })));

    // Reordering parents: drag a chip before or after another, or Alt+←/→ on a focused chip.
    const order = parents.map((p) => p.id);
    const moveParent = (id, to) => {
      const next = order.filter((x) => x !== id);
      next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
      if (next.every((x, i) => x === order[i])) return;
      focusAfterRender = { sel: `[data-parent="${id}"]` };
      change(() => M.setParentOrder(net, n.id, next));
      flushPanel();
    };
    const box = panel.querySelector("#parent-chips");
    let dragged = null;
    const dropSlot = (e) => {
      // the slot (0..length) whose gap is nearest the pointer
      const chips = [...box.querySelectorAll("[data-parent]")];
      const i = chips.findIndex((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.bottom && e.clientX < r.left + r.width / 2; });
      return i < 0 ? chips.length : i;
    };
    const clearMarks = () => box.querySelectorAll(".drop-before, .drop-after").forEach((c) => c.classList.remove("drop-before", "drop-after"));
    box.querySelectorAll("[data-parent]").forEach((el) => {
      const id = +el.dataset.parent;
      el.addEventListener("dragstart", (e) => { dragged = id; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", el.textContent); });
      el.addEventListener("dragend", () => { dragged = null; el.classList.remove("dragging"); clearMarks(); });
      el.addEventListener("keydown", (e) => {
        if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        e.stopPropagation();
        moveParent(id, order.indexOf(id) + (e.key === "ArrowLeft" ? -1 : 1));
      });
    });
    box.addEventListener("dragover", (e) => {
      if (dragged === null) return;
      e.preventDefault();
      clearMarks();
      const chips = [...box.querySelectorAll("[data-parent]")], slot = dropSlot(e);
      if (slot < chips.length) chips[slot].classList.add("drop-before");
      else chips[chips.length - 1].classList.add("drop-after");
    });
    box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) clearMarks(); });
    box.addEventListener("drop", (e) => {
      if (dragged === null) return;
      e.preventDefault();
      const slot = dropSlot(e), from = order.indexOf(dragged);
      moveParent(dragged, slot > from ? slot - 1 : slot);
    });
  }

  // ------------------------------------------------------------ import / export

  function exportWarnings() {
    const bad = net.nodes.filter((n) => M.badRows(n).length).map((n) => n.name);
    return bad.length ? `Warning: CPT rows of ${bad.join(", ")} do not sum to 1.` : "";
  }

  function fileName(ext) {
    return ((net.name || "network").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "network") + ext;
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // pyAgrum code for the network, with the current evidence (as setEvidence calls and a comment).
  function exportCode() {
    return P.exportPython(net, evidenceIndices());
  }

  function downloadPython() {
    download(new Blob([exportCode()], { type: "text/x-python" }), fileName(".py"));
  }

  // The canvas as it is shown now (with probabilities and evidence when that view is on), minus
  // the selection, with the pyAgrum code embedded so the image can be imported again.
  function exportImage() {
    const code = exportCode();
    const saved = { nodes: selNodes, arc: selArc };
    selNodes = new Set();
    selArc = null;
    render();
    let caption = null;
    const ev = showProbs ? evidenceIndices() : new Map();
    if (ev.size) {
      const text = "Evidence: " + [...ev].map(([id, v]) => {
        const n = M.getNode(net, id);
        if (isDo(v)) return `do(${n.name} = ${n.labels[v.do]})`;
        if (isTarget(v)) return `${n.name} → ${v.target.map(fmtPct).join(" : ")}`;
        return Array.isArray(v) ? `${n.name} ≈ ${v.map((x) => +x.toPrecision(2)).join(" : ")}` : `${n.name} = ${n.labels[v]}`;
      }).join(", ");
      caption = { text, width: textWidth(text, "13px system-ui, sans-serif") };
    }
    const css = getComputedStyle(document.documentElement);
    let image;
    try {
      image = BNImage.buildSvg(svg, viewport, {
        code, caption,
        background: css.getPropertyValue("--bg").trim(),
        captionColor: css.getPropertyValue("--text").trim(),
      });
    } finally {
      selNodes = saved.nodes;
      selArc = saved.arc;
      render();
    }
    return { image, code };
  }

  // Runs fn with the page in the light or dark theme (or as it is, for ""), for exports.
  function withTheme(theme, fn) {
    const root = document.documentElement, was = root.className;
    if (theme) { root.classList.remove("theme-light", "theme-dark"); root.classList.add("theme-" + theme); }
    try { return fn(); } finally { root.className = was; }
  }
  const themeColor = (theme, name) => withTheme(theme, () => getComputedStyle(document.documentElement).getPropertyValue(name).trim());

  async function downloadImage(kind, theme = "") {
    if (!net.nodes.length) { toast("The network is empty"); return; }
    const { image, code } = withTheme(theme, exportImage);
    if (kind === "svg") download(new Blob([image.svg], { type: "image/svg+xml" }), fileName(".svg"));
    else download(await BNImage.svgToPng(image, code), fileName(".png"));
  }

  function openExport() {
    $("#export-code").value = exportCode();
    $("#export-warnings").textContent = exportWarnings();
    $("#export-dialog").showModal();
  }

  // While the import dialog shows a result, how to take the import back: the undo depth before it
  // and the evidence it replaced.
  let importBefore = null;

  function openImport() {
    importBefore = null;
    showImportResult(null);
    $("#import-dialog").showModal();
    $("#import-code").focus();
  }

  // result: null (nothing imported yet), {error, warnings} or {summary, warnings}.
  function showImportResult(result) {
    const box = $("#import-result");
    box.hidden = !result;
    box.className = "import-result " + (result && result.error ? "failed" : "ok");
    if (result) {
      const head = result.error ? `<b>Nothing was imported.</b> ${esc(result.error)}`
        : `<b>✓ ${esc(result.summary)}</b>${result.warnings.length ? ` · ${result.warnings.length} warning${result.warnings.length > 1 ? "s" : ""}` : ""}`;
      box.innerHTML = `<p>${head}</p>` + (result.warnings.length ? `<ul>${result.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "");
    }
    const done = !!(result && !result.error);
    document.querySelector('[data-action="do-import"]').textContent = done ? "Close" : "Import";
    document.querySelector('[data-action="do-import"]').dataset.done = done ? "1" : "";
    $("#import-cancel").hidden = done;
    $("#import-undo").hidden = !done;
  }

  // Returns true when a network was loaded. `pick` chooses among several networks built by the code.
  function importCode(src, pick) {
    const { net: imported, warnings, evidence: savedEvidence, networks = [], picked } = P.importPython(src, { pick });
    const multiple = networks.length > 1;
    $("#import-networks").hidden = !multiple;
    if (multiple) {
      $("#import-pick").innerHTML = networks.map((n, i) =>
        `<option value="${i}"${i === picked ? " selected" : ""}>${esc(n.label)} (${n.nodes} variable${n.nodes === 1 ? "" : "s"}, ${n.arcs} arc${n.arcs === 1 ? "" : "s"})</option>`).join("");
      $("#import-networks-note").textContent = `The code builds ${networks.length} networks; pick the one to import.`;
    }
    if (!imported) {
      const [first = "The code doesn't build a network.", ...rest] = warnings;
      showImportResult({ error: first, warnings: rest });
      return false;
    }
    // Picking another network re-imports, so only the first import in this dialog records the state to go back to.
    if (!importBefore) importBefore = { net: JSON.stringify(net), evidence };
    clearEvidence();
    change(() => { net = imported; });
    if (savedEvidence) {
      const byName = new Map(net.nodes.map((n) => [n.name, n.id]));
      const next = new Map(Object.entries(savedEvidence).filter(([name]) => byName.has(name)).map(([name, v]) => [byName.get(name), v]));
      if (next.size && !setEvidence(next)) warnings.push(`The saved evidence wasn't applied: ${BNInference.posteriors(net, evidenceIndices(next)).error}`);
    }
    select([]);
    fit();
    const plural = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
    const evCount = evidence.size;
    const summary = `Imported ${net.name ? `“${net.name}”: ` : ""}${plural(net.nodes.length, "variable")}, ${plural(net.arcs.length, "arc")}` +
      (evCount ? `, evidence on ${plural(evCount, "variable")}` : "");
    showImportResult({ summary, warnings });
    if (!viewer) toast(summary + (warnings.length ? ` with ${plural(warnings.length, "warning")}` : ""));
    return true;
  }

  function undoImport() {
    if (!importBefore) return;
    // Restores the saved network rather than undoing a counted number of steps: the history may
    // be full, and then the import didn't make it any longer.
    const saved = importBefore.net;
    evidence = new Map(); // the imported network's, replaced below
    change(() => { net = JSON.parse(saved); });
    setEvidence(importBefore.evidence);
    fit();
    importBefore = null;
    $("#import-dialog").close();
    toast("Import undone");
  }

  // Returns true when a network was loaded.
  async function importFile(file) {
    const id = netId;
    let text = await BNImage.codeFromFile(file);
    if (text === null) { toast("This image doesn't contain a network exported from this editor"); return false; }
    if (text === undefined) text = await file.text();
    if (!await editingReady(id)) return false;
    $("#import-code").value = text;
    if (!$("#import-dialog").open) openImport();
    else showImportResult(null);
    return finishImport();
  }

  // The dialog stays open to show warnings or a network picker; a clean import just closes it.
  function finishImport() {
    const btn = document.querySelector('[data-action="do-import"]');
    if (btn.dataset.done) { $("#import-dialog").close(); return false; }
    importBefore = null;
    if (!importCode($("#import-code").value)) return false;
    if (!$("#import-result ul") && $("#import-networks").hidden) $("#import-dialog").close();
    return true;
  }

  // ------------------------------------------------------------ ?src= links

  let linkedImage = null; // the successfully imported image, usable until this network changes

  // GitHub "blob" and gist page URLs don't allow cross-origin downloads; their raw versions do.
  function rawUrl(url) {
    const blob = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/.exec(url);
    if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}`;
    const gist = /^https:\/\/gist\.github\.com\/([^/]+\/[0-9a-f]+)\/?$/i.exec(url);
    if (gist) return `https://gist.githubusercontent.com/${gist[1]}/raw`;
    return url;
  }

  // ------------------------------------------------------------ #net= links

  // The network travels in the URL hash as its pyAgrum export (with layout and evidence),
  // deflate-compressed and base64url-encoded. The hash never reaches a server.
  const toBase64Url = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const fromBase64Url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

  // A link with the current network (and evidence) in its hash; ?view opens it in the viewer.
  async function netLink(asViewer) {
    const packed = await pipe(new TextEncoder().encode(exportCode()), new CompressionStream("deflate-raw"));
    return location.href.replace(/[?#].*$/, "") + (asViewer ? "?view" + (forcedTheme ? "&theme=" + forcedTheme : "") : "") + "#net=" + toBase64Url(packed);
  }

  // At about 800px wide, sized to the network's shape, plus title and evidence bars.
  function embedHeight() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of net.nodes) {
      const { w, h } = nodeSize(n, true);
      x0 = Math.min(x0, n.x - w / 2); x1 = Math.max(x1, n.x + w / 2);
      y0 = Math.min(y0, n.y - h / 2); y1 = Math.max(y1, n.y + h / 2);
    }
    return Math.round(Math.max(360, Math.min(900, 800 * (y1 - y0) / Math.max(1, x1 - x0) + 140)));
  }

  // HTML that embeds the viewer, optionally showing an image until ready. `theme` is "light",
  // "dark" or "" to follow the reader's system; `image` is an image URL, or {light, dark} URLs to
  // pick from by the reader's system.
  function embedCode(url, image, height, theme) {
    const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const color = (name) => (theme ? themeColor(theme, name) : `light-dark(${themeColor("light", name)}, ${themeColor("dark", name)})`);
    const frame = `color-scheme: ${theme || "light dark"}; border: 1px solid ${color("--border")}; border-radius: 8px;`;
    const title = attr(net.name || "Bayesian network");
    const imgStyle = "display: block; width: 100%; height: 100%; object-fit: contain;";
    const img = typeof image === "object" && image
      ? `<picture style="display: block; height: 100%;"><source media="(prefers-color-scheme: dark)" srcset="${attr(image.dark)}"><img src="${attr(image.light)}" alt="${title}" style="${imgStyle}"></picture>`
      : `<img src="${attr(image)}" alt="${title}" style="${imgStyle}">`;
    if (image) return `<div style="position: relative; height: ${height}px; background: ${color("--bg")}; ${frame} overflow: hidden;">
  <a href="${attr(url)}" target="_blank" rel="noopener" style="display: block; height: 100%;">${img}</a>
  <iframe data-src="${attr(url)}" title="${title}" aria-hidden="true" tabindex="-1" style="position: absolute; inset: 0; width: 100%; height: 100%; border: 0; visibility: hidden;"></iframe>
  <script>
    (function () {
      var box = document.currentScript.parentElement, frame = box.querySelector('iframe');
      var origin = new URL(frame.dataset.src).origin;
      function ready(event) {
        if (event.source !== frame.contentWindow || event.origin !== origin || event.data !== 'bn-viewer-ready') return;
        box.querySelector('a').inert = true;
        frame.style.visibility = 'visible';
        frame.removeAttribute('aria-hidden');
        frame.removeAttribute('tabindex');
        window.removeEventListener('message', ready);
      }
      window.addEventListener('message', ready);
      frame.src = frame.dataset.src;
    })();
  </script>
</div>`;
    return `<iframe src="${attr(url)}" title="${title}" width="100%" height="${height}" style="${frame}" loading="lazy"></iframe>`;
  }

  let embedUrl = "", embedImageData = {};
  async function openEmbed(url) {
    if (!net.nodes.length) { toast("The network is empty"); return; }
    embedUrl = url || await netLink(true);
    embedImageData = {};
    $("#embed-height").value = embedHeight();
    $("#embed-image").checked = false;
    $("#embed-image-source").value = "url";
    $("#embed-image-url").value = !url && unsaved && linkedImage?.netId === netId ? linkedImage.url : "";
    updateEmbedCode();
    $("#embed-dialog").showModal();
  }

  // A data: URL of the canvas as an SVG in the light or dark theme, made once per dialog.
  const embedImage = (theme) => (embedImageData[theme] ??= "data:image/svg+xml;charset=utf-8," + encodeURIComponent(withTheme(theme, exportImage).image.svg));

  function updateEmbedCode() {
    const showImage = $("#embed-image").checked;
    const hosted = showImage && $("#embed-image-source").value === "url";
    const theme = $("#embed-theme").value;
    $("#embed-image-settings").hidden = !showImage;
    $("#embed-image-hosted").hidden = !hosted;
    const input = $("#embed-image-url");
    input.disabled = !hosted;
    input.setCustomValidity("");
    if (hosted && input.checkValidity() && !/^https?:$/.test(new URL(input.value).protocol)) {
      input.setCustomValidity("Enter an http:// or https:// image URL.");
    }
    $("#embed-source-note").textContent = hosted
      ? `Download the SVG, upload it unchanged to a host that allows cross-origin downloads (CORS), then paste its URL. The viewer will load the network from that image.${theme ? ` Download SVG uses the ${theme} theme.` : " An image has one set of colours, so readers whose system theme differs from it see the image's colours until the viewer loads; pick Light or Dark to match it."}`
      : `Includes a snapshot of this network directly in the HTML${theme ? "" : ", in both light and dark colours"}. No image upload or download is needed, but the code is larger and your site must allow data: images.`;
    const valid = $("#embed-height").checkValidity() && input.checkValidity();
    document.querySelector('[data-action="do-copy-embed"]').disabled = !valid;
    document.querySelector('[data-action="do-copy-embed"]').textContent = "Copy embed code";
    const image = !showImage || !valid ? null
      : hosted ? new URL(rawUrl(input.value)).href
      : theme ? embedImage(theme) : { light: embedImage("light"), dark: embedImage("dark") };
    const url = new URL(embedUrl);
    if (hosted && image) {
      url.search = "?view&src=" + encodeURIComponent(image);
      url.hash = "";
    }
    if (image) url.search += "&image-first";
    if (theme) url.search += "&theme=" + theme;
    $("#embed-code").value = valid ? embedCode(url.href, image, +$("#embed-height").value, theme) : "";
  }
  $("#embed-theme").addEventListener("change", updateEmbedCode);
  $("#embed-height").addEventListener("input", updateEmbedCode);
  $("#embed-image").addEventListener("change", updateEmbedCode);
  $("#embed-image-source").addEventListener("change", updateEmbedCode);
  $("#embed-image-url").addEventListener("input", updateEmbedCode);

  async function copyEmbed() {
    if (!$("#embed-dialog form").reportValidity()) return;
    const code = $("#embed-code").value;
    try {
      await navigator.clipboard.writeText(code);
      document.querySelector('[data-action="do-copy-embed"]').textContent = "Copied!";
      toast("Copied the embed code: paste it into a web page's HTML");
    } catch {
      prompt("Copy this embed code:", code);
    }
  }

  async function shareLink(asViewer = false) {
    if (!net.nodes.length) { toast("The network is empty"); return; }
    const url = await netLink(asViewer);
    try {
      await navigator.clipboard.writeText(url);
      const long = url.length > 8000 && BNGist.available() ? ". That's long: Share ▾ › Publish to GitHub Gist makes a short one" : "";
      toast(`Copied a ${asViewer ? "viewer " : ""}link with the network in it (${url.length.toLocaleString()} characters)${long}`);
    } catch {
      prompt("Copy this link:", url);
    }
  }

  // Loads the network from #net=... . The hash stays in the address bar until the network is
  // changed and saved (see importLink).
  async function loadFromHash() {
    const hash = location.hash;
    if (!hash.startsWith("#net=")) return;
    let code;
    try {
      code = new TextDecoder().decode(await pipe(fromBase64Url(hash.slice(5)), new DecompressionStream("deflate-raw")));
    } catch {
      toast("This link's network is damaged (it may have been cut short when it was copied)");
      return;
    }
    // The source names the link by a hash of it, since the link itself can be very long.
    let h = 2166136261;
    for (let i = 0; i < hash.length; i++) h = Math.imul(h ^ hash.charCodeAt(i), 16777619);
    return importLink(new File([code], "network.py"), "net:" + (h >>> 0).toString(36));
  }
  window.addEventListener("hashchange", loadFromHash);

  // ------------------------------------------------------------ GitHub gists

  function openGist() {
    if (!net.nodes.length) { toast("The network is empty"); return; }
    showGist({});
    $("#gist-dialog").showModal();
    $("#gist-publish").focus();
  }

  // state: {} (about to publish), {busy}, {error} or {done: {gistUrl, link, copied}}.
  function showGist(state) {
    const done = state.done;
    $("#gist-intro").hidden = !!done;
    $("#gist-result").hidden = !done;
    const status = $("#gist-status");
    const msg = state.busy || state.error || (done && (done.copied ? "✓ Published, and the link is copied to the clipboard." : "✓ Published. Copy the link below."));
    status.hidden = !msg;
    status.className = "import-result " + (state.error ? "failed" : "ok");
    status.innerHTML = done ? `<b>${esc(msg)}</b>` : esc(msg || "");
    if (done) {
      $("#gist-link").value = done.link;
      $("#gist-page").href = done.gistUrl;
    }
    const publish = $("#gist-publish");
    publish.hidden = !!done;
    publish.disabled = !!state.busy;
    publish.textContent = (BNGist.signedIn() ? "Publish" : "Sign in with GitHub and publish") + (state.error ? " again" : "");
    $("#gist-close").textContent = done ? "Close" : "Cancel";
    $("#gist-sign-out").hidden = !BNGist.signedIn();
  }

  // Publishes `share` (the current network by default), signing in first if needed, which
  // leaves the page; finishGistSignIn picks up when GitHub sends the user back.
  async function publishGist(share = { code: exportCode(), filename: fileName(".py"), description: `${net.name || "Network"}: a Bayesian network shared from the BN Editor` }) {
    if (!BNGist.signedIn()) {
      showGist({ busy: "Opening GitHub…" });
      await BNGist.signInAndShare(share);
      return;
    }
    showGist({ busy: "Publishing…" });
    try {
      const { gistUrl, rawUrl } = await BNGist.publish(share);
      const link = BNGist.linkFor(rawUrl);
      let copied = true;
      try { await navigator.clipboard.writeText(link); } catch { copied = false; }
      showGist({ done: { gistUrl, link, copied } });
      $("#gist-link").select();
    } catch (e) {
      if (!(e instanceof BNGist.ShareError)) throw e;
      showGist({ error: e.message });
    }
  }

  async function finishGistSignIn() {
    if (viewer) return;
    const result = await BNGist.finishSignIn();
    if (!result) return;
    $("#gist-dialog").showModal();
    if (result.error) showGist({ error: result.error });
    else await publishGist(result.share);
  }

  // Loads the network from the file named by ?src=<url> (.py, or a .png/.svg exported here).
  async function loadFromLink() {
    const src = new URLSearchParams(location.search).get("src");
    if (!src) return;
    let url;
    try { url = new URL(rawUrl(src), location.href); } catch { toast("The link's src isn't a valid URL"); return; }
    toast(`Loading ${url.href}…`);
    let res;
    try {
      res = await fetch(url);
    } catch {
      toast("Couldn't download the linked network. The server may not allow cross-origin downloads (CORS).");
      return;
    }
    if (!res.ok) { toast(`Couldn't download the linked network (HTTP ${res.status})`); return; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Name the file by its content so the importer knows how to read it.
    const head = new TextDecoder().decode(bytes.subarray(0, 512));
    const name = bytes[0] === 0x89 && head.startsWith("PNG", 1) ? "network.png"
      : /^\s*(<\?xml[^>]*>\s*)?<svg\b/.test(head) ? "network.svg" : "network.py";
    const ok = await importLink(new File([bytes], name), "src:" + src);
    if (ok && name !== "network.py" && /^https?:$/.test(url.protocol)) linkedImage = { url: url.href, netId };
    return ok;
  }

  // Imports a linked file as a network of its own, so opening a link never replaces other work.
  // It's kept in memory only, with the link left in the address bar so reloading opens it
  // again, until it's changed: then saveLinkedNetwork stores it like any other network.
  async function importLink(file, source) {
    const load = () => importLinkedFile(file, source);
    return viewer ? load() : navigate(load);
  }

  async function importLinkedFile(file, source) {
    const before = netId;
    const beforeBlank = !viewer && netId && !unsaved && !net.nodes.length && !undoStack.length && !redoStack.length;
    hideSoftEditor();
    importBefore = null;
    if (unsaved) discardLinkedNetwork();
    else if (netId) histories.set(netId, { undo: undoStack, redo: redoStack, snapshot: JSON.stringify(net) });
    netId = newId();
    record = null;
    saveVersion = savedVersion = 0;
    focusOnReturn = null;
    unsaved = { source, importing: true };
    undoStack = [];
    redoStack = [];
    net = M.createNetwork(untitledName());
    evidence = new Map();
    inferenceCache = null;
    selNodes = new Set();
    selArc = null;
    refreshNetwork();
    const ok = await importFile(file);
    unsaved.importing = false;
    if (viewer) {
      // The viewer doesn't show import details: a failure becomes a short message.
      const failed = !ok && $("#import-result p")?.textContent;
      $("#import-dialog").close();
      if (failed) toast(failed.replace("Nothing was imported.", "Couldn't open the linked network:"));
    }
    if (!ok) {
      // Nothing was imported: go back to the network that was open.
      if (viewer) {
        net = M.createNetwork("Untitled");
        refreshNetwork();
        return;
      }
      await leaveOwnership();
      discardLinkedNetwork();
      // A link opened at startup had no network before it: fall back to the one this tab would
      // have started with.
      await reloadNetworks();
      const back = before && records.has(before) ? before : rememberedNetwork();
      if (back) await enterNetwork(back);
      else await nextNetwork();
      return;
    }
    if (beforeBlank) await removeNetwork(before, true);
    undoStack = [];
    redoStack = [];
    importBefore = null;
    $("#import-undo").hidden = true;
    updateButtons();
    updateNetworkButton();
    if (!viewer) toast(`Opened “${net.name}” from the link (${net.nodes.length} variables). It's saved to your networks once you change it.`);
    return true;
  }

  // Editing the code after an import offers to import it again.
  $("#import-code").addEventListener("input", () => { if (importBefore) showImportResult(null); });
  $("#import-pick").addEventListener("change", (e) => importCode($("#import-code").value, +e.target.value));
  $("#import-file").addEventListener("change", (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ""; });

  const wrap = $("#canvas-wrap");
  wrap.addEventListener("dragover", (e) => { if (!viewer && e.dataTransfer.types.includes("Files")) { e.preventDefault(); wrap.classList.add("dropping"); } });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("dropping"));
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    if (viewer) return;
    wrap.classList.remove("dropping");
    if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
  });

  // ------------------------------------------------------------ toolbar

  const actions = {
    networks: () => toggleNetworksMenu(),
    new: () => {
      toggleNetworksMenu(false);
      openNetwork(M.createNetwork(untitledName()));
      toast(`Started “${net.name}”. Your other networks are saved in this menu.`);
    },
    import: openImport,
    demo: () => toggleDemoMenu(),
    probs: toggleProbs,
    export: openExport,
    share: () => toggleShareMenu(),
    "copy-link": () => { toggleShareMenu(false); shareLink(); },
    "copy-viewer-link": () => { toggleShareMenu(false); shareLink(true); },
    "copy-embed": () => {
      toggleShareMenu(false);
      document.querySelector('[data-action="share"]').focus();
      openEmbed();
    },
    "do-copy-embed": copyEmbed,
    "embed-download-image": () => downloadImage("svg", $("#embed-theme").value),
    "close-embed": () => $("#embed-dialog").close(),
    "gist-copy-embed": () => openEmbed($("#gist-link").value.replace("?src=", "?view&src=")),
    "open-viewer": async () => window.open(await netLink(true), "_blank", "noopener"),
    "open-editor": openEditor,
    "gist-copy-viewer": async () => { await navigator.clipboard.writeText($("#gist-link").value.replace("?src=", "?view&src=")); toast("Copied the viewer link"); },
    gist: () => { toggleShareMenu(false); openGist(); },
    "gist-publish": () => publishGist(),
    "gist-copy": async () => { await navigator.clipboard.writeText($("#gist-link").value); toast("Copied the link"); },
    "gist-sign-out": () => { BNGist.signOut(); showGist({}); toast("Forgot the GitHub sign-in"); },
    undo, redo,
    add: () => addNodeShortcut(true),
    layout: () => toggleLayoutMenu(),
    "layout-down": () => autoLayoutNet("down"),
    "layout-right": () => autoLayoutNet("right"),
    fit,
    "copy-export": async () => { await navigator.clipboard.writeText($("#export-code").value); toast("Copied to clipboard"); },
    "download-export": downloadPython,
    "download-svg": () => downloadImage("svg"),
    "download-png": () => downloadImage("png"),
    "do-import": finishImport,
    "undo-import": undoImport,
  };
  const demoMenu = $("#demo-menu");
  demoMenu.innerHTML = BNDemos.map((d) => `<button role="menuitem" data-demo="${d.id}"><b>${esc(d.label)}</b><span>${esc(d.detail)}</span></button>`).join("");
  // A toolbar menu: its button toggles it, arrow keys move through it, Escape or clicking
  // elsewhere closes it.
  function menu(el, action) {
    const button = document.querySelector(`[data-action="${action}"]`);
    const toggle = (open = el.hidden) => {
      el.hidden = !open;
      button.setAttribute("aria-expanded", open);
      if (open) el.querySelector("button").focus();
    };
    el.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep arrow keys from moving selected nodes
      const items = [...el.querySelectorAll("button")].filter((b) => !b.hidden);
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
      } else if (e.key === "Escape") {
        toggle(false);
        button.focus();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!el.hidden && !el.contains(e.target) && !button.contains(e.target)) toggle(false);
    });
    return toggle;
  }
  const toggleDemoMenu = menu(demoMenu, "demo");

  // The network menu lists the saved networks, most recently edited first. It's rebuilt from
  // storage each time it opens, so it shows networks other tabs have added.
  const networksMenu = $("#networks-menu");
  const toggleNetworksMenuRaw = menu(networksMenu, "networks");
  async function toggleNetworksMenu(open = networksMenu.hidden) {
    if (open) {
      try { await reloadNetworks(); }
      catch { toast("Couldn't read your saved networks. Check browser storage and try again."); return; }
      if (!canEdit() || switching) return;
      renderNetworksMenu();
    }
    toggleNetworksMenuRaw(open);
  }
  const ago = (t) => {
    const s = (Date.now() - t) / 1000;
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (s < 60) return "just now";
    if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
    if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
    return rtf.format(-Math.round(s / 86400), "day");
  };
  function renderNetworksMenu() {
    const rows = byRecent(readIndex()).map((e) => {
      const current = e.id === netId;
      const from = e.source && e.source.startsWith("demo:") ? "demo" : e.source ? "from a link" : "";
      const meta = [`${e.nodes} variable${e.nodes === 1 ? "" : "s"}`, from, `edited ${ago(e.updated)}`].filter(Boolean).join(" · ");
      return `<div class="net-row${current ? " current" : ""}">
        <button role="menuitemradio" aria-checked="${current}" data-net="${esc(e.id)}"><b>${esc(e.name || "Untitled")}</b><span>${esc(meta)}</span></button>
        <button class="net-delete" data-delete-net="${esc(e.id)}" title="Delete this network" aria-label="Delete ${esc(e.name || "Untitled")}">✕</button>
      </div>`;
    });
    if (unsaved) {
      rows.unshift(`<div class="net-row current">
        <button role="menuitemradio" aria-checked="true" data-net="${esc(netId)}"><b>${esc(net.name || "Untitled")}</b><span>${net.nodes.length} variables · from a link · saved once you change it</span></button>
      </div>`);
    }
    networksMenu.innerHTML = `<button role="menuitem" data-action="new"><b>New network</b><span>Start an empty one; the others stay saved</span></button><div class="menu-sep"></div>` + rows.join("");
  }
  networksMenu.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-delete-net]");
    if (del) {
      await deleteNetwork(del.dataset.deleteNet);
      if (readIndex().length) { renderNetworksMenu(); networksMenu.querySelector("button").focus(); }
      return;
    }
    const b = e.target.closest("[data-net]");
    if (!b) return;
    toggleNetworksMenu(false);
    switchNetwork(b.dataset.net);
  });
  function updateNetworkButton() {
    $("#net-switch-name").textContent = net.name || "Untitled";
    $("#viewer-title").textContent = net.name || "Untitled";
    document.querySelector('[data-action="networks"]').title = `${net.name || "Untitled"}: switch between your saved networks, or start a new one`;
  }
  const toggleShareMenu = menu($("#share-menu"), "share");
  const toggleLayoutMenu = menu($("#layout-menu"), "layout");
  function autoLayoutNet(direction) {
    toggleLayoutMenu(false);
    change(() => M.autoLayout(net, (n) => nodeSize(n, true), direction));
    fit();
  }
  document.querySelector('[data-action="gist"]').hidden = !BNGist.available();
  demoMenu.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-demo]");
    if (!b) return;
    const demo = BNDemos.find((d) => d.id === b.dataset.demo);
    toggleDemoMenu(false);
    if (await openNetwork(demo.build(), "demo:" + demo.id)) {
      toast(`Opened the ${demo.label} demo. Your other networks are saved in the network menu.`);
    }
  });

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-action]");
    if (b && actions[b.dataset.action]) { e.preventDefault(); actions[b.dataset.action](); }
  });

  // ------------------------------------------------------------ start

  const cpt = BNCptEditor.createCptEditor($("#cpt-dock"), {
    getNet: () => net,
    change,
    checkpoint,
    afterDirectEdit: () => { save(); render(); cpt.render(cptNodeId()); schedulePanel(); },
    toast,
    onEscape: () => svg.focus(),
    onResize: () => render(),
    onLiveEdit: () => { inferenceCache = null; render(); },
  });

  async function start() {
    if (!viewer) {
      ownershipUI("Opening your networks…");
      if (!tabsSupported()) {
        ownershipUI("Safe multi-tab editing requires a browser with Web Locks and BroadcastChannel. Open this page over HTTPS or localhost in a current browser.");
        return;
      }
      // Serialize first-visit creation and migration, even when several tabs open at once.
      await navigator.locks.request("bn-editor:startup", async () => {
        await migrateIndex();
        await startNetwork();
      });
    } else await startNetwork();
    started = true;
    claimedAt = Date.now();
    if (!viewer) takeOwnership();
    updateNetworkButton();
    document.querySelector('[data-action="probs"]').setAttribute("aria-pressed", showProbs);
    render();
    renderPanel();
    cpt.render(cptNodeId());
    updateButtons();
    requestAnimationFrame(fit);
    finishGistSignIn();
    // Linked imports acquire their own network's lock. Don't wait for the unrelated
    // startup network, whose owner may be keeping unsaved changes in memory.
    // A startup link that couldn't be opened (unreachable, damaged) leaves no network: open the
    // one this tab would have started with.
    const fallBack = () => {
      if (viewer || netId) return;
      navigate(async () => { await reloadNetworks(); const id = rememberedNetwork(); return id ? enterNetwork(id) : nextNetwork(); });
    };
    Promise.all([loadFromLink(), loadFromHash()]).then((loaded) => {
      fallBack();
      document.body.classList.remove("viewer-loading");
      if (viewer) fit();
      // A frame's load event can precede the asynchronous import. Only replace an image after
      // a successful import and a rendered, fitted viewer; failures leave the fallback intact.
      if (viewer && embedded && loaded.some(Boolean) && net.nodes.length) {
        let fade;
        if (new URLSearchParams(location.search).has("image-first") && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
          fade = document.documentElement.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 50, easing: "ease-out" });
          fade.pause();
        }
        // Hidden cross-origin frames may not receive animation frames until they are visible.
        window.parent.postMessage("bn-viewer-ready", "*");
        // Announce readiness first, then begin the crossfade when the revealed frame can paint.
        if (fade) requestAnimationFrame(() => fade.play());
      }
    }).catch(() => {
      fallBack();
      document.body.classList.remove("viewer-loading");
      toast("Couldn't open the linked network");
    });
  }
  start().catch(() => ownershipUI("Couldn't open your saved networks. Check browser storage permissions and reload."));

  // Leaves the viewer for the full editor, keeping the evidence the reader set. From here the
  // network follows the editor's usual rules (a linked one is saved once it's changed).
  async function openEditor() {
    // Embedded in another page, the editor opens in a new tab, with the reader's evidence.
    if (embedded) { window.open(await netLink(false), "_blank", "noopener"); return; }
    if (!storageWorks || !tabsSupported()) return;
    try { await navigator.locks.request("bn-editor:startup", migrateIndex); }
    catch { toast("Couldn't open your saved networks. Check browser storage permissions and try again."); return; }
    viewer = false;
    if (!unsaved) unsaved = { source: null, importing: false };
    ownershipUI("Opening the editor…");
    if (!await editingReady()) return;
    // The editor uses your saved settings, except any the reader just changed in the viewer.
    // Probabilities stay shown: the reader was looking at them.
    const saved = (key) => (viewerChoices.has(key) ? null : preference(key));
    const was = [softMode, softKind, clickMode].join();
    if (saved(SOFT_KEY) !== null) softMode = saved(SOFT_KEY) === "1";
    if (saved(SOFT_KIND_KEY) !== null) softKind = saved(SOFT_KIND_KEY) === "probabilities" ? "probabilities" : "likelihoods";
    if (saved(CLICK_KEY) !== null) clickMode = saved(CLICK_KEY) === "intervene" ? "intervene" : "observe";
    if ([softMode, softKind, clickMode].join() !== was) closeSoftEditor(); // it was opened for the old settings
    if (saved(PANEL_KEY) !== null) setPanelCollapsed(saved(PANEL_KEY) === "1");
    document.body.classList.remove("viewer");
    const url = new URL(location.href);
    url.searchParams.delete("view");
    // the editor follows your system's theme, not the one an embed chose
    url.searchParams.delete("theme");
    if (forcedTheme) { document.documentElement.classList.remove("theme-" + forcedTheme); forcedTheme = undefined; }
    history.replaceState(null, "", url.href.replace("?#", "#").replace(/\?$/, ""));
    if (viewerEvidenceChanged) saveEvidence();
    render();
    renderPanel();
    cpt.render(cptNodeId());
    updateButtons();
    requestAnimationFrame(fit);
  }

  // Exposed for debugging from the console.
  globalThis.bnEditor = { get net() { return net; }, select, render };
})();
