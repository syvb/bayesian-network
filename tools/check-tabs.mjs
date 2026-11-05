// Real-browser regression for focus-following, single-writer network editing.
// Usage: CHROME_BIN=/path/to/chrome node tools/check-tabs.mjs (requires playwright).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

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
  await page.waitForFunction(() => document.hasFocus() && !!globalThis.bnEditor?.net && !document.querySelector("main").inert);
};
const network = page => page.evaluate(() => JSON.parse(JSON.stringify(bnEditor.net)));
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
  await a.reload();
  await ready(a);
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
  console.log("PASS drags: probability divider and node movement saved on handover without pointerup");

  await b.locator('[data-action="networks"]').click();
  await b.locator('[data-action="new"]').click();
  await ready(b);
  await rename(b, "Separate network B");
  const secondId = await b.evaluate(() => sessionStorage.getItem("bn-editor-current"));
  await ready(a);
  await a.locator("#canvas").press("Escape");
  await rename(a, "Separate network A");
  await a.reload();
  await ready(a);
  assert.equal((await network(a)).name, "Separate network A");
  await ready(b);
  await b.reload();
  await ready(b);
  assert.equal((await network(b)).name, "Separate network B");
  assert.equal(await b.evaluate(() => sessionStorage.getItem("bn-editor-current")), secondId);
  await b.locator('[data-action="networks"]').click();
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

  // Real lock contention: an unresponsive owner cannot be bypassed. Closing it releases the lock.
  const holder = await context.newPage();
  await holder.goto(base + "?view");
  await ready(holder);
  await holder.evaluate(async id => {
    await new Promise(resolve => navigator.locks.request("bn-editor:network:" + id, async () => {
      resolve();
      await new Promise(release => { window.releaseTestLock = release; });
    }));
  }, firstId);
  await a.bringToFront();
  await a.waitForFunction(() => document.querySelector("main").inert);
  assert.match(await a.locator("#tab-status").innerText(), /Finishing changes in another tab/);
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
  await b.waitForFunction(id => !localStorage.getItem("bn-editor-net:" + id), firstId);
  await ready(a);
  assert.notEqual(await a.evaluate(() => sessionStorage.getItem("bn-editor-current")), firstId);
  assert.equal(await a.evaluate(id => localStorage.getItem("bn-editor-net:" + id), firstId), null);
  console.log("PASS deletion: parked tab moves to another network without resurrecting deleted data");

  assert.deepEqual(errors, []);
  await context.close();

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
  await old.reload();
  await ready(old);
  assert.equal((await network(old)).name, "Migrated and editable");
  console.log("PASS migration: viewer → editor retains legacy network, editable and reloadable");
  await legacy.close();

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
  await unsupported.close();
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
