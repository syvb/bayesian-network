// Browser regression: a real opaque-origin sandbox must load and explore a shared network,
// then open a full-page viewer with the reader's evidence intact. Requires Playwright.
// Usage: node tools/check-embed.mjs (CHROME_BIN optionally selects an installed Chromium).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { P, demos } from "./load.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const code = P.exportPython(demos.find(d => d.id === "wet-grass").build());
const hash = "#net=" + deflateRawSync(code).toString("base64url");
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (url.pathname === "/article") {
    const src = url.searchParams.has("src") ? "?view&src=/network.py" : "?view" + hash;
    res.setHeader("Content-Type", "text/html");
    res.end(`<iframe id="network" sandbox="allow-scripts allow-popups" src="/${src}" width="800" height="600"></iframe>`);
  } else if (url.pathname === "/network.py") res.end(code);
  else {
    try {
      const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html");
      res.end(await readFile(new URL("../" + path, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN });
  for (const source of ["hash", "src"]) {
    const context = await browser.newContext();
    const errors = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    const page = await context.newPage();
    await page.goto(base + "/article" + (source === "src" ? "?src" : ""));
    const frame = page.frames()[1];
    await frame.waitForFunction(() => document.querySelectorAll(".node").length === 4);
    for (const key of ["localStorage", "sessionStorage"]) {
      assert.equal(await frame.evaluate(key => {
        try { window[key]; return false; } catch (e) { return e.name === "SecurityError"; }
      }, key), true);
    }
    const rain = frame.locator('.node[data-node="3"] [data-state="0"]');
    await rain.click();
    const evidence = await frame.locator("#evidence-bar").textContent();
    assert.match(evidence, /rain = yes/);
    assert.equal(await frame.locator('.node[data-node="1"] [data-state="0"] .pct').textContent(), "80.0%");
    await frame.locator('[data-click-mode="intervene"]').click();
    await frame.locator('[data-click-mode="observe"]').click();
    await frame.locator("[data-soft-mode]").check();
    await rain.click();
    await frame.locator('[data-soft-kind="probabilities"]').click();
    await frame.locator('[data-soft-kind="likelihoods"]').click();
    await frame.locator("[data-soft-close]").last().click();
    await frame.locator("[data-soft-mode]").uncheck();
    // Restore hard evidence after exercising both soft-evidence preferences.
    await frame.locator('[data-clear-ev="all"]').click();
    await rain.click();
    const popupPromise = page.waitForEvent("popup");
    await frame.locator('[data-action="open-viewer"]').click();
    const popup = await popupPromise;
    await popup.waitForFunction(() => document.querySelectorAll(".node").length === 4);
    assert.equal(await popup.evaluate(() => document.body.classList.contains("viewer")), true);
    assert.equal(await popup.locator("#evidence-bar").textContent(), evidence);
    assert.equal(await popup.evaluate(() => window.opener === null), true);
    assert.equal(await popup.locator('[data-action="open-viewer"]').isVisible(), false);
    assert.equal(await popup.evaluate(() => location.hash.startsWith("#net=")), true);
    await popup.reload();
    await popup.waitForFunction(() => document.querySelectorAll(".node").length === 4);
    assert.equal(await popup.locator("#evidence-bar").textContent(), evidence);
    assert.deepEqual(errors, []);
    console.log(`PASS ${source}: storage-blocked embed → full-page viewer; evidence retained after reload`);
    await context.close();
  }
} finally {
  await browser?.close();
  server.close();
}
