// Real-browser regression for focus-following, single-writer network editing.
// Usage: CHROME_BIN=/path/to/chrome node tools/check-tabs.mjs (requires playwright).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { P, demos as demoFixtures } from "./load.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html");
    res.end(await readFile(new URL("../" + (path === "/" ? "index.html" : path.slice(1)), import.meta.url)));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}`;
let browser;
const sessions = new WeakMap();
const ready = async page => {
  // Playwright otherwise emulates focus in every tab simultaneously, unlike a real browser.
  // It reapplies that emulation on reload, so disable it on every activation.
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  const cdp = sessions.get(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await page.bringToFront();
  // A real tab switch fires focus. Playwright skips it when it already (wrongly) reports focus,
  // for example after sending mouse input to a background tab.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => document.hasFocus() && !!globalThis.bnEditor?.net && !document.querySelector("main").inert);
  // Panel changes can refit the canvas in ResizeObserver; wait for layout before measuring drags.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
const network = page => page.evaluate(() => JSON.parse(JSON.stringify(bnEditor.net)));
const reload = async page => {
  // CDP Page.reload can discard the page without waiting for asynchronous autosave.
  // Test reload of committed data; the browser's real unsaved-reload warning is tested below.
  await page.waitForFunction(async () => {
    const record = await (await BNStorage.open()).get(sessionStorage.getItem("bn-editor-current"));
    return JSON.stringify(record?.net) === JSON.stringify(bnEditor.net);
  });
  await page.reload();
  await ready(page);
};
const switchTo = async (page, id) => {
  await ready(page);
  await page.locator('[data-action="networks"]').click();
  await page.locator(`[data-net="${id}"]`).click();
  await ready(page);
};
const rename = async (page, name) => {
  await page.locator("#net-name").fill(name);
  await page.locator("#net-name").press("Tab");
};

try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const errors = [];
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  const a = await context.newPage();
  await a.goto(base);
  await ready(a);
  const firstId = await a.evaluate(() => sessionStorage.getItem("bn-editor-current"));
  const b = await context.newPage();
  await b.goto(base);
  await ready(b);

  // Returning to a text field must not route typing into destructive canvas shortcuts.
  await ready(a);
  await a.locator('.node[data-node="1"] .body').click({ position: { x: 20, y: 12 } });
  await a.locator("#n-desc").fill("Description xyz");
  await ready(b);
  await ready(a);
  await a.keyboard.press("Backspace");
  assert.equal((await network(a)).nodes.length, 8);
  assert.equal(await a.locator("#n-desc").inputValue(), "Description xy");
  await a.keyboard.type("n");
  await a.keyboard.press("ArrowLeft");
  await a.keyboard.press("Enter");
  assert.equal((await network(a)).nodes.length, 8);
  assert.equal(await a.locator("#n-desc").inputValue(), "Description xyn");
  assert.equal(await a.locator("#inline-edit").isHidden(), true);
  await a.locator("#n-desc").fill("Description xyz");
  await ready(b);
  await rename(b, "Changed while editing Description");
  await ready(a);
  assert.equal((await network(a)).name, "Changed while editing Description");
  assert.deepEqual(await a.evaluate(() => ({ id: document.activeElement.id, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd })), { id: "n-desc", start: 15, end: 15 });
  await a.keyboard.press("Backspace");
  assert.equal((await network(a)).nodes.length, 8);
  assert.equal(await a.locator("#n-desc").inputValue(), "Description xy");
  if (process.env.CAPTURE_DIR) await a.screenshot({ path: `${process.env.CAPTURE_DIR}/tabs-focus-external.png` });
  await a.locator("#canvas").press("Escape");
  console.log("PASS keyboard focus: Backspace, N, arrows and Enter stay in Description, including after external changes");

  // Leave a real, uncommitted field edit: the handover must commit it before B reads storage.
  await ready(a);
  await a.locator("#net-name").fill("Houseplant — edited in A");
  await ready(b);
  assert.equal((await network(b)).name, "Houseplant — edited in A");
  assert.equal(await a.locator("main").evaluate(el => el.inert), true);
  if (process.env.CAPTURE_DIR) await a.screenshot({ path: `${process.env.CAPTURE_DIR}/tabs-parked.png` });
  await b.locator('.node[data-node="1"] .body').click({ position: { x: 20, y: 12 } });
  await b.locator("#canvas").press("Enter");
  await b.locator("#inline-edit").fill("winter renamed in B");
  await b.locator("#inline-edit").press("Enter");
  await ready(a);
  assert.equal((await network(a)).nodes[0].name, "winter renamed in B");
  assert.equal(await a.locator('[data-action="undo"]').isDisabled(), true);
  await rename(a, "Combined changes");
  await reload(a);
  assert.equal((await network(a)).nodes[0].name, "winter renamed in B");
  assert.equal((await network(a)).name, "Combined changes");
  console.log("PASS same network: unfinished field commits; unrelated edits survive handover and reload; stale undo cleared");

  // With no external change, focus loss must not wipe undo (including trips to browser chrome).
  await rename(a, "Undo survives focus");
  await ready(b);
  await ready(a);
  assert.equal(await a.locator('[data-action="undo"]').isDisabled(), false);
  await a.locator('[data-action="undo"]').click();
  assert.equal((await network(a)).name, "Combined changes");
  console.log("PASS unchanged network: undo survives focus round trip");

  // Evidence is reloaded with ownership, rather than silently replaced by a stale tab's map.
  await a.locator('[data-node="1"] [data-state="0"]').click();
  await ready(b);
  assert.match(await b.locator("#evidence-bar").innerText(), /winter renamed in B = yes/);
  await b.locator('[data-node="2"] [data-state="0"]').click();
  await ready(a);
  assert.match(await a.locator("#evidence-bar").innerText(), /drainage hole = yes/);
  assert.match(await a.locator("#evidence-bar").innerText(), /winter renamed in B = yes/);
  console.log("PASS evidence: observations from both tabs retained");

  // A CPT input without Enter is also committed before release.
  await a.locator('[data-clear-ev="all"]').click();
  await a.locator('.node[data-node="1"] .body').click({ position: { x: 20, y: 12 } });
  await a.locator('.cell[data-r="0"][data-c="0"]').dblclick();
  await a.locator(".cpt-scroll input").fill("0.37");
  await ready(b);
  assert.equal((await network(b)).nodes[0].cpt[0], 0.37);
  console.log("PASS CPT: unfinished probability input saved before handover");

  // End live drags on blur, even when their pointerup is delivered to a different tab.
  await ready(a);
  const bar = await a.locator('.bar[data-row="0"]').boundingBox();
  const handle = await a.locator('.bar[data-row="0"] .handle').boundingBox();
  await a.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await a.mouse.down();
  await a.mouse.move(bar.x + bar.width * 0.61, bar.y + bar.height / 2, { steps: 5 });
  await ready(b);
  assert.equal((await network(b)).nodes[0].cpt[0], 0.61);
  await a.mouse.up();
  await ready(a);
  assert.equal(await a.locator(".cpt-scroll").evaluate(el => el.classList.contains("dragging")), false);
  const beforeMove = (await network(a)).nodes[1];
  const body = await a.locator('.node[data-node="2"] .body').boundingBox();
  await a.mouse.move(body.x + 20, body.y + 12);
  await a.mouse.down();
  await a.mouse.move(body.x + 90, body.y + 42, { steps: 5 });
  await ready(b);
  assert.notEqual((await network(b)).nodes[1].x, beforeMove.x);
  await a.mouse.up();
  // Playwright gave A focus for its mouse input (a real browser wouldn't), so A claims the
  // network back; let that finish, then switch to B as a user would.
  await a.waitForTimeout(300);
  await ready(b);
  console.log("PASS drags: probability divider and node movement saved on handover without pointerup");

  await b.locator('[data-action="networks"]').click();
  await b.locator('[data-action="new"]').click();
  await ready(b);
  await rename(b, "Separate network B");
  const secondId = await b.evaluate(() => sessionStorage.getItem("bn-editor-current"));
  await ready(a);
  await a.locator("#canvas").press("Escape");
  await rename(a, "Separate network A");
  await reload(a);
  assert.equal((await network(a)).name, "Separate network A");
  await ready(b);
  await reload(b);
  assert.equal((await network(b)).name, "Separate network B");
  assert.equal(await b.evaluate(() => sessionStorage.getItem("bn-editor-current")), secondId);
  await b.locator('[data-action="networks"]').click();
  await b.locator("#networks-menu").waitFor({ state: "visible" });
  assert.match(await b.locator("#networks-menu").innerText(), /Separate network A/);
  await b.locator('[data-action="networks"]').click();
  console.log("PASS different networks: both edits and per-tab selections survive reload; menu stays current");

  // Returning to a previously visited network must not resurrect stale history.
  await switchTo(b, firstId);
  await rename(b, "External change while A is elsewhere");
  await switchTo(a, secondId);
  await switchTo(a, firstId);
  assert.equal(await a.locator('[data-action="undo"]').isDisabled(), true);
  console.log("PASS network switching: cached stale undo history discarded");

  // Hold a real storage transaction open, rather than delaying a mocked save promise.
  const busy = await context.newPage();
  await busy.goto(base + "?view");
  await ready(busy);
  await ready(a);
  await busy.evaluate(async () => {
    const db = await new Promise(resolve => { indexedDB.open("bn-editor").onsuccess = e => resolve(e.target.result); });
    await new Promise(resolve => {
      const tx = db.transaction("networks", "readwrite"), store = tx.objectStore("networks");
      tx.oncomplete = () => db.close();
      const keepAlive = () => {
        store.get("busy-test").onsuccess = () => { resolve(); if (!window.finishStorage) keepAlive(); };
      };
      keepAlive();
    });
  });
  await rename(a, "First queued edit");
  await rename(a, "Latest queued edit");
  await b.bringToFront();
  await b.waitForFunction(() => document.hasFocus() && document.querySelector("main").inert);
  await busy.evaluate(() => { window.finishStorage = true; });
  await ready(b);
  assert.equal((await network(b)).name, "Latest queued edit");
  await busy.close();
  console.log("PASS busy storage: handover waits for all queued edits, not just the first transaction");

  // Real lock contention: an unresponsive owner cannot be bypassed. Closing it releases the lock.
  const holder = await context.newPage();
  await holder.goto(base + "?view");
  await ready(holder);
  await holder.evaluate(async id => {
    // Ask the tab that has the network for it, the way an editor tab does, then never let go.
    new BroadcastChannel("bn-editor-tabs").postMessage({ want: id, at: Date.now() });
    await new Promise(resolve => navigator.locks.request("bn-editor:network:" + id, async () => {
      resolve();
      await new Promise(release => { window.releaseTestLock = release; });
    }));
  }, firstId);
  await a.bringToFront();
  await a.evaluate(() => window.dispatchEvent(new Event("focus")));
  // coming back to A takes the network back; the holder never lets go, so A waits
  await a.waitForFunction(() => document.querySelector("main").inert && /Waiting for another tab/.test(document.querySelector("#tab-status").textContent));
  if (process.env.CAPTURE_DIR) await a.screenshot({ path: `${process.env.CAPTURE_DIR}/tabs-waiting.png` });
  await b.bringToFront(); // cancel A's queued acquisition; it must not steal ownership later
  await a.bringToFront();
  await a.waitForFunction(() => document.querySelector("main").inert);
  await holder.close();
  await ready(a);
  assert.equal(await a.locator("#tab-status").isHidden(), true);
  if (process.env.CAPTURE_DIR) await a.screenshot({ path: `${process.env.CAPTURE_DIR}/tabs-editing.png` });
  console.log("PASS delayed handover: editing blocked until real Web Lock is released; close recovers automatically");

  // Deleting a network open in a parked tab must not let that tab recreate it on focus.
  await switchTo(b, secondId);
  b.once("dialog", dialog => dialog.accept());
  await b.locator('[data-action="networks"]').click();
  await b.locator(`[data-delete-net="${firstId}"]`).click();
  await b.waitForFunction(async id => !(await (await BNStorage.open()).get(id)), firstId);
  await ready(a);
  assert.notEqual(await a.evaluate(() => sessionStorage.getItem("bn-editor-current")), firstId);
  assert.equal(await a.evaluate(async id => (await BNStorage.open()).get(id), firstId), undefined);
  console.log("PASS deletion: parked tab moves to another network without resurrecting deleted data");

  assert.deepEqual(errors, []);
  await context.close();

  const quota = await browser.newContext();
  const writer = await quota.newPage();
  await writer.goto(base);
  await ready(writer);
  const reader = await quota.newPage();
  await reader.goto(base);
  await ready(reader);
  const independent = await quota.newPage();
  await independent.goto(base);
  await ready(independent);
  await independent.locator('[data-action="networks"]').click();
  await independent.locator('[data-action="new"]').click();
  await ready(independent);
  const independentId = await independent.evaluate(() => sessionStorage.getItem("bn-editor-current"));
  await ready(writer);
  const unsavedId = await writer.evaluate(() => sessionStorage.getItem("bn-editor-current"));
  await writer.evaluate(() => {
    window.restoreStorage = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = window.restoreStorage.apply(this, args);
      // The request succeeds but the transaction fails: ownership must not be released.
      if (this.name === "networks") request.addEventListener("success", () => this.transaction.abort());
      return request;
    };
  });
  await rename(writer, "Unsaved but not lost");
  await writer.locator('[data-node="1"] [data-state="0"]').click();
  await reader.bringToFront();
  await reader.waitForFunction(() => document.hasFocus());
  await ready(writer);
  assert.equal((await network(writer)).name, "Unsaved but not lost");
  assert.match(await writer.locator("#evidence-bar").innerText(), /winter = yes/);
  assert.equal(await writer.locator('[data-action="undo"]').isDisabled(), false);
  await switchTo(writer, independentId);
  assert.equal(await writer.evaluate(() => sessionStorage.getItem("bn-editor-current")), unsavedId);
  assert.equal((await network(writer)).name, "Unsaved but not lost");
  assert.match(await writer.locator("#tab-status").innerText(), /Changes aren't saved.*Keep this tab open/);
  const warning = writer.waitForEvent("dialog");
  const reloadAttempt = writer.evaluate(() => location.reload());
  const dialog = await warning;
  assert.equal(dialog.type(), "beforeunload");
  await dialog.dismiss();
  await reloadAttempt;
  await ready(writer);
  assert.equal((await network(writer)).name, "Unsaved but not lost");
  if (process.env.CAPTURE_DIR) await writer.screenshot({ path: `${process.env.CAPTURE_DIR}/tabs-unsaved.png` });
  await ready(independent);
  await rename(independent, "Different network still editable");
  assert.equal((await network(independent)).name, "Different network still editable");
  await reader.bringToFront();
  await reader.waitForFunction(() => document.hasFocus() && document.querySelector("main").inert);
  if (process.env.CAPTURE_DIR) await reader.screenshot({ path: `${process.env.CAPTURE_DIR}/tabs-unsaved-waiting.png` });
  // Startup links create independent networks, even if the remembered network can't save.
  const sharedCode = P.exportPython(demoFixtures.find(d => d.id === "wet-grass").build());
  for (const format of ["hash", "src"]) {
    const link = await quota.newPage();
    await link.addInitScript(id => sessionStorage.setItem("bn-editor-current", id), unsavedId);
    await link.route("**/shared.py", route => route.fulfill({ contentType: "text/plain", body: sharedCode }));
    const url = format === "hash" ? base + "#net=" + deflateRawSync(sharedCode).toString("base64url")
      : base + "?src=" + encodeURIComponent(base + "/shared.py");
    await link.goto(url);
    await link.waitForFunction(() => globalThis.bnEditor?.net.nodes.length === 4 && !document.querySelector("main").inert, null, { timeout: 5000 });
    await ready(link);
    await rename(link, `Independent ${format} link`);
    await link.waitForFunction(async name => {
      const id = sessionStorage.getItem("bn-editor-current");
      return (await (await BNStorage.open()).get(id))?.net.name === name;
    }, `Independent ${format} link`);
    assert.notEqual(await link.evaluate(() => sessionStorage.getItem("bn-editor-current")), unsavedId);
    console.log(`PASS blocked startup ${format} link: imports and saves independently of an unsaved owner's lock`);
  }
  const damaged = await quota.newPage();
  await damaged.addInitScript(id => sessionStorage.setItem("bn-editor-current", id), unsavedId);
  await damaged.goto(base + "#net=damaged");
  await damaged.waitForFunction(() => document.body.textContent.includes("This link's network is damaged"));
  assert.equal(await damaged.locator("main").evaluate(el => el.inert), true);
  await writer.evaluate(() => { IDBObjectStore.prototype.put = window.restoreStorage; });
  await ready(writer);
  await ready(damaged);
  assert.equal((await network(damaged)).name, "Unsaved but not lost");
  console.log("PASS damaged startup link: reports failure and resumes the saved network after its owner recovers");
  await ready(reader);
  assert.equal((await network(reader)).name, "Unsaved but not lost");
  assert.match(await reader.locator("#evidence-bar").innerText(), /winter = yes/);
  assert.equal(await reader.evaluate(async id => (await (await BNStorage.open()).get(id)).edited, unsavedId), true);
  await reload(reader);
  assert.equal((await network(reader)).name, "Unsaved but not lost");
  assert.match(await reader.locator("#evidence-bar").innerText(), /winter = yes/);
  console.log("PASS storage recovery: unsaved model, evidence and undo survive focus; handover waits for persistence");
  await quota.close();

  const demos = await browser.newContext();
  const demoPage = await demos.newPage();
  await demoPage.goto(base);
  await ready(demoPage);
  await demoPage.locator('[data-action="demo"]').click();
  await demoPage.locator('[data-demo="random"]').click();
  await ready(demoPage);
  const randomId = await demoPage.evaluate(() => sessionStorage.getItem("bn-editor-current"));
  const firstRandom = await network(demoPage);
  await demoPage.locator('[data-action="demo"]').click();
  await demoPage.locator('[data-demo="houseplant"]').click();
  await ready(demoPage);
  await demoPage.locator('[data-action="demo"]').click();
  await demoPage.locator('[data-demo="random"]').click();
  await ready(demoPage);
  await demoPage.waitForFunction(id => sessionStorage.getItem("bn-editor-current") === id && !document.querySelector("main").inert, randomId);
  assert.notDeepEqual(await network(demoPage), firstRandom);
  console.log("PASS demos: reopening an unedited Random network rebuilds it without accumulating copies");

  await demoPage.locator('[data-action="demo"]').click();
  await demoPage.locator('[data-demo="houseplant"]').click();
  await ready(demoPage);
  const demoWriter = await demos.newPage();
  await demoWriter.goto(base + "?view");
  await ready(demoWriter);
  await demoWriter.evaluate(async id => {
    await new Promise(resolve => navigator.locks.request("bn-editor:network:" + id, async () => {
      resolve();
      await new Promise(release => { window.finishDemoEdit = release; });
    }));
  }, randomId);
  await ready(demoPage);
  await demoPage.locator('[data-action="demo"]').click();
  await demoPage.locator('[data-demo="random"]').click();
  await demoPage.waitForFunction(() => document.querySelector("main").inert);
  // A lock-holding writer finishes an edit after the opener has selected the unedited copy.
  await demoWriter.evaluate(async id => {
    const db = await BNStorage.open(), record = await db.get(id);
    record.name = record.net.name = "Edited while reopening";
    record.edited = true;
    await db.put(record);
    window.finishDemoEdit();
  }, randomId);
  await demoPage.waitForFunction(id => sessionStorage.getItem("bn-editor-current") !== id && !document.querySelector("main").inert, randomId);
  assert.equal((await network(demoPage)).name, "Random");
  await switchTo(demoPage, randomId);
  assert.equal((await network(demoPage)).name, "Edited while reopening");
  console.log("PASS demo contention: an edit made while ownership is pending survives; a new demo copy opens instead");
  await demos.close();

  // An existing installation's old menu migrates without changing IDs, evidence or network data.
  const legacy = await browser.newContext();
  await legacy.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("bn-editor-networks", JSON.stringify([{ id: "legacy", name: "Existing network", nodes: 0, updated: 1, edited: true }]));
    localStorage.setItem("bn-editor-net:legacy", JSON.stringify({ name: "Existing network", nodes: [], arcs: [], nextId: 1 }));
    localStorage.setItem("bn-editor-last", "legacy");
  });
  const old = await legacy.newPage();
  await old.goto(base + "?view");
  await ready(old);
  await old.locator('[data-action="open-editor"]').click();
  await old.waitForFunction(() => !document.body.classList.contains("viewer"));
  await switchTo(old, "legacy");
  assert.equal((await network(old)).name, "Existing network");
  await rename(old, "Migrated and editable");
  await reload(old);
  assert.equal((await network(old)).name, "Migrated and editable");
  console.log("PASS migration: viewer → editor retains legacy network, editable and reloadable");
  old.once("dialog", dialog => dialog.accept());
  await old.locator('[data-action="networks"]').click();
  await old.locator('[data-delete-net="legacy"]').click();
  await old.waitForFunction(() => sessionStorage.getItem("bn-editor-current") !== "legacy" && !document.querySelector("main").inert);
  await reload(old);
  assert.equal((await network(old)).nodes.length, 0);
  await old.locator('[data-action="networks"]').click();
  await old.locator("#networks-menu").waitFor({ state: "visible" });
  assert.equal(await old.locator('[data-net="legacy"]').count(), 0);
  assert.notEqual(await old.evaluate(() => localStorage.getItem("bn-editor-net:legacy")), null);
  console.log("PASS migration backup: deleting the last migrated network does not resurrect its old keys on reload");
  await legacy.close();

  for (const format of ["per-network", "single-network"]) {
    const migration = await browser.newContext();
    await migration.addInitScript(format => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      const n = { name: "Legacy rain", nextId: 2, nodes: [{ id: 1, name: "rain", type: "labelized", labels: ["wet", "dry"], cpt: [0.23, 0.77], x: 0, y: 0 }], arcs: [] };
      const evidence = [[1, "dry"]];
      if (format === "per-network") {
        localStorage.setItem("bn-editor-entry:rain", JSON.stringify({ id: "rain", name: n.name, nodes: 1, edited: true, updated: 3 }));
        localStorage.setItem("bn-editor-net:rain", JSON.stringify(n));
        localStorage.setItem("bn-editor-evidence:rain", JSON.stringify(evidence));
        // Abort after request success: neither the records nor the migration marker may commit.
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          const request = put.apply(this, args);
          if (this.name === "networks") request.addEventListener("success", () => this.transaction.abort());
          return request;
        };
      } else {
        localStorage.setItem("bn-editor-network", JSON.stringify(n));
        localStorage.setItem("bn-editor-evidence", JSON.stringify(evidence));
      }
    }, format);
    const page = await migration.newPage();
    await page.goto(base);
    if (format === "per-network") {
      await page.waitForFunction(() => document.querySelector("#tab-status").textContent.startsWith("Couldn't open your saved networks"));
      assert.equal(await page.locator("main").evaluate(el => el.inert), true);
      await page.reload(); // New realm removes the injected failure; retry the original data.
    }
    await ready(page);
    const migrated = await network(page);
    assert.equal(migrated.name, "Legacy rain");
    assert.deepEqual(migrated.nodes[0].cpt, [0.23, 0.77]);
    assert.match(await page.locator("#evidence-bar").innerText(), /rain = dry/);
    await reload(page);
    assert.match(await page.locator("#evidence-bar").innerText(), /rain = dry/);
    console.log(`PASS ${format} migration: CPT and evidence retained${format === "per-network" ? "; aborted migration retries atomically" : ""}`);
    await migration.close();
  }

  const links = await browser.newContext();
  const linked = await links.newPage();
  const shared = demoFixtures.find(d => d.id === "wet-grass").build();
  shared.name = "Shared rain";
  await linked.goto(base + "#net=" + deflateRawSync(P.exportPython(shared)).toString("base64url"));
  await ready(linked);
  await linked.waitForFunction(() => bnEditor.net.name === "Shared rain" && !document.querySelector("main").inert);
  const fallbackId = await linked.evaluate(() => sessionStorage.getItem("bn-editor-current"));
  const other = await links.newPage();
  await other.goto(base);
  await ready(other);
  assert.equal((await network(other)).nodes.length, 8); // The unedited link is not saved yet.
  await ready(linked);
  await linked.locator('[data-node="3"] [data-state="0"]').click();
  const linkedId = await linked.evaluate(() => sessionStorage.getItem("bn-editor-current"));
  assert.notEqual(linkedId, fallbackId);
  assert.equal(new URL(linked.url()).hash, "");
  await switchTo(other, linkedId);
  assert.equal((await network(other)).name, "Shared rain");
  assert.equal((await network(other)).nodes.length, 4);
  assert.match(await other.locator("#evidence-bar").innerText(), /rain = yes/);
  await reload(linked);
  assert.equal((await network(linked)).name, "Shared rain");
  assert.match(await linked.locator("#evidence-bar").innerText(), /rain = yes/);
  console.log("PASS linked import: first edit saves a separate network with evidence; handover and reload retain it");
  await links.close();

  const fresh = await browser.newContext();
  const first = await fresh.newPage(), second = await fresh.newPage();
  await Promise.all([first.goto(base), second.goto(base)]);
  for (const page of [first, second]) {
    const cdp = await fresh.newCDPSession(page);
    sessions.set(page, cdp);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  }
  await ready(first);
  const id = await first.evaluate(() => sessionStorage.getItem("bn-editor-current"));
  await ready(second);
  assert.equal(await second.evaluate(() => sessionStorage.getItem("bn-editor-current")), id);
  console.log("PASS simultaneous first visit: both tabs use one initial network");
  await fresh.close();

  const unsupported = await browser.newContext();
  await unsupported.addInitScript(() => Object.defineProperty(navigator, "locks", { value: undefined }));
  const noLocks = await unsupported.newPage();
  await noLocks.goto(base);
  await noLocks.locator("#tab-status").waitFor({ state: "visible" });
  assert.match(await noLocks.locator("#tab-status").innerText(), /requires a browser with Web Locks/);
  assert.equal(await noLocks.locator("main").evaluate(el => el.inert), true);
  if (process.env.CAPTURE_DIR) await noLocks.screenshot({ path: `${process.env.CAPTURE_DIR}/tabs-unsupported.png` });
  await noLocks.goto(base + "?view");
  await noLocks.waitForFunction(() => document.querySelectorAll(".node").length > 0);
  assert.equal(await noLocks.locator("main").evaluate(el => el.inert), false);
  console.log("PASS unsupported Web Locks: editor safely blocked with explanation; viewer still usable");

  {
    const noChannel = await browser.newContext();
    await noChannel.addInitScript(() => { delete window.BroadcastChannel; });
    const page = await noChannel.newPage();
    await page.goto(base);
    await page.locator("#tab-status").waitFor({ state: "visible" });
    assert.match(await page.locator("#tab-status").innerText(), /BroadcastChannel/);
    assert.equal(await page.locator("main").evaluate(el => el.inert), true);
    await noChannel.close();
    console.log("PASS unsupported BroadcastChannel: editor blocked with explanation instead of later tabs waiting forever");
  }

  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const open = async (url = base, init) => {
      const page = await ctx.newPage();
      sessions.set(page, await ctx.newCDPSession(page));
      if (init) await page.addInitScript(...init);
      await page.goto(url);
      return page;
    };
    const current = page => page.evaluate(() => sessionStorage.getItem("bn-editor-current"));
    const editable = page => page.waitForFunction(() => !document.querySelector("main").inert, null, { timeout: 8000 });
    const A = await open(); await ready(A);
    const x = await current(A);

    // A waiting tab that never gets focus (Safari) asks for the network when you click in it.
    const W = await open(base, [x => {
      sessionStorage.setItem("bn-editor-current", x);
      Document.prototype.hasFocus = () => false;
      window.addEventListener("focus", e => e.stopImmediatePropagation(), true);
    }, x]);
    await W.waitForFunction(() => document.querySelector("main").inert && /Waiting/.test(document.querySelector("#tab-status").textContent));
    await W.waitForTimeout(300);
    assert.equal(await W.locator("main").evaluate(el => el.inert), true);
    await W.mouse.click(600, 400);
    await editable(W);
    assert.equal(await current(W), x);
    await W.close();
    console.log("PASS waiting tab: a click asks for the network even without focus events");

    // A clock set back can't leave the tab you're using waiting forever.
    await ready(A);
    const B = await open(base, [x => sessionStorage.setItem("bn-editor-current", x), x]);
    await B.evaluate(() => { const now = Date.now; Date.now = () => now() - 3600e3; });
    await ready(B);
    assert.equal(await current(B), x);
    console.log("PASS clock set back: the tab in use still takes the network");

    // Deleting a network another tab has open asks that tab for it instead of freezing.
    await B.locator('[data-action="networks"]').click();
    await B.locator('[data-action="new"]').click();
    await ready(B);
    await ready(A); // A has x again
    await ready(B);
    B.once("dialog", d => d.accept());
    await B.locator('[data-action="networks"]').click();
    await B.locator(`[data-delete-net="${x}"]`).click();
    await B.waitForFunction(async id => !(await (await BNStorage.open()).get(id)), x, { timeout: 5000 });
    await editable(B);
    await ready(A);
    await A.waitForFunction(x => sessionStorage.getItem("bn-editor-current") !== x && !document.querySelector("main").inert, x, { timeout: 5000 });
    console.log("PASS deletion: a network open in another tab is handed over and deleted, without freezing");

    // ...and when that tab can't save, deletion gives up with a message instead of freezing.
    await ready(B);
    await B.keyboard.press("Escape"); // the menu stays open after a deletion
    await B.locator('[data-action="networks"]').click();
    await B.locator('[data-action="new"]').click();
    await ready(B);
    await rename(B, "B's own network");
    const C = await open(); await ready(C);
    await C.locator('[data-action="networks"]').click();
    await C.locator('[data-action="new"]').click();
    await ready(C);
    await rename(C, "Owned by C");
    const z = await current(C);
    await C.waitForFunction(async id => (await (await BNStorage.open()).get(id))?.net.name === "Owned by C", z);
    await C.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) { const r = put.apply(this, args); if (this.name === "networks") r.addEventListener("success", () => this.transaction.abort()); return r; };
    });
    await rename(C, "Can't be saved");
    await ready(B);
    B.once("dialog", d => d.accept());
    await B.locator('[data-action="networks"]').click();
    await B.locator(`[data-delete-net="${z}"]`).click();
    await B.waitForFunction(() => /Couldn't delete it/.test(document.querySelector("#toast")?.textContent), null, { timeout: 9000 });
    await editable(B);
    assert.ok(await B.evaluate(async id => !!(await (await BNStorage.open()).get(id)), z));
    assert.equal((await network(C)).name, "Can't be saved");
    await ctx.close();
    console.log("PASS deletion refused: a tab that can't save keeps its network; the deleting tab says so and stays usable");
  }

  {
    // Safari can open a link in a new window that reports no focus and never fires a focus
    // event. With only one tab there is nothing to hand over: the link must open and be
    // editable at once, without the startup demo appearing first.
    const fresh = await browser.newContext();
    const page = await fresh.newPage();
    await page.addInitScript(() => {
      Document.prototype.hasFocus = () => false;
      window.addEventListener("focus", e => e.stopImmediatePropagation(), true);
      window.shown = new Set();
      setInterval(() => { const n = globalThis.bnEditor?.net; if (n?.nodes.length && getComputedStyle(document.querySelector("#canvas-wrap")).visibility !== "hidden") window.shown.add(n.name); }, 5);
    });
    const code = P.exportPython(demoFixtures.find(d => d.id === "wet-grass").build());
    await page.route("**/unfocused.py", route => route.fulfill({ contentType: "text/plain", body: code }));
    await page.goto(base + "?src=" + encodeURIComponent(base + "/unfocused.py"));
    await page.waitForFunction(() => bnEditor.net.nodes.length === 4 && !document.querySelector("main").inert, null, { timeout: 5000 });
    await rename(page, "Edited in an unfocused window");
    assert.equal((await network(page)).name, "Edited in an unfocused window");
    assert.deepEqual(await page.evaluate(() => [...window.shown].filter(n => n !== "Edited in an unfocused window")), [P.importPython(code).net.name]);
    await fresh.close();
    console.log("PASS unfocused window: a link opens and is editable without focus, and no other network flashes first");
  }
  await unsupported.close();
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
