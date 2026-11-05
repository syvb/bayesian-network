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
const images = new Map();
let imageEmbed = "";
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (url.pathname === "/image-article") {
    res.setHeader("Content-Type", "text/html");
    res.end(imageEmbed);
  } else if (images.has(url.pathname)) {
    res.setHeader("Content-Type", url.pathname.endsWith(".svg") ? "image/svg+xml" : "image/png");
    res.end(images.get(url.pathname));
  } else if (url.pathname === "/article") {
    const src = url.searchParams.has("src") ? "?view&src=/network.py" : "?view" + hash;
    res.setHeader("Content-Type", "text/html");
    const sandbox = "allow-scripts allow-popups" + (url.searchParams.has("escape") ? " allow-popups-to-escape-sandbox" : "");
    res.end(`<iframe id="network" sandbox="${sandbox}" src="/${src}" width="800" height="600"></iframe>`);
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
    // Without storage the editor can't work, so nothing offers it; Full screen still does.
    assert.equal(await frame.locator('[data-action="open-editor"]').isVisible(), false);
    assert.equal(await frame.locator('[data-action="open-viewer"]').isVisible(), true);
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
    // the popup inherits the sandbox (no allow-popups-to-escape-sandbox), so no editor there either
    assert.equal(await popup.locator('[data-action="open-editor"]').isVisible(), false);
    assert.equal(await popup.evaluate(() => location.hash.startsWith("#net=")), true);
    await popup.reload();
    await popup.waitForFunction(() => document.querySelectorAll(".node").length === 4);
    assert.equal(await popup.locator("#evidence-bar").textContent(), evidence);
    assert.deepEqual(errors, []);
    console.log(`PASS ${source}: storage-blocked embed → full-page viewer; evidence retained after reload`);
    await context.close();
  }

  {
    // With allow-popups-to-escape-sandbox, the full-page viewer has storage and offers the editor.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base + "/article?escape");
    const frame = page.frames()[1];
    await frame.waitForFunction(() => document.querySelectorAll(".node").length === 4);
    const popupPromise = page.waitForEvent("popup");
    await frame.locator('[data-action="open-viewer"]').click();
    const popup = await popupPromise;
    await popup.waitForFunction(() => document.querySelectorAll(".node").length === 4);
    assert.equal(await popup.locator('[data-action="open-editor"]').isVisible(), true);
    console.log("PASS escaped popup: full-page viewer offers the editor");

    // Opening the editor from the viewer uses the saved settings, except those the reader changed.
    const editorPage = await context.newPage();
    await editorPage.goto(base + "/");
    await editorPage.evaluate(() => {
      localStorage.setItem("bn-editor-soft-evidence", "1");
      localStorage.setItem("bn-editor-click-mode", "intervene");
    });
    await editorPage.goto(base + "/?view" + hash);
    await editorPage.waitForFunction(() => document.querySelectorAll(".node").length === 4 && !document.body.classList.contains("viewer-loading"));
    assert.equal(await editorPage.locator("[data-soft-mode]").isChecked(), false);
    await editorPage.locator('[data-click-mode="intervene"]').click();
    await editorPage.locator('[data-click-mode="observe"]').click(); // the reader's own choice
    await editorPage.locator('[data-action="open-editor"]').click();
    assert.equal(await editorPage.locator("[data-soft-mode]").isChecked(), true);
    assert.match(await editorPage.locator('[data-click-mode="observe"]').getAttribute("class"), /\bon\b/);
    console.log("PASS open editor: saved settings restored, reader's choices kept");
    await context.close();
  }

  const context = await browser.newContext();
  const editor = await context.newPage();
  // Exercise the real exports and copy menu rather than manufacturing a preview or snippet.
  await editor.addInitScript(() => {
    navigator.clipboard.writeText = async text => { window.copied = text; };
  });
  await editor.goto(base + "/?view" + hash);
  await editor.waitForFunction(() => document.querySelectorAll(".node").length === 4 && !document.body.classList.contains("viewer-loading"));
  await editor.locator('[data-action="open-editor"]').click();
  await editor.locator('[data-action="share"]').click();
  assert.equal(await editor.locator('#share-menu [data-action*="embed"]').count(), 1);
  await editor.locator('[data-action="copy-embed"]').click();
  await editor.locator("#embed-dialog").waitFor({ state: "visible" });
  assert.equal(await editor.locator("#embed-image").isEnabled(), true);
  for (const height of ["199", "2001", "600.5", ""]) {
    await editor.locator("#embed-height").fill(height);
    assert.equal(await editor.locator('[data-action="do-copy-embed"]').isDisabled(), true);
    assert.equal(await editor.locator("#embed-code").inputValue(), "");
  }
  for (const height of ["200", "2000", "731"]) {
    await editor.locator("#embed-height").fill(height);
    assert.equal(await editor.locator('[data-action="do-copy-embed"]').isDisabled(), false);
    assert.match(await editor.locator("#embed-code").inputValue(), new RegExp(`height="${height}"`));
  }
  await editor.locator("#embed-height").press("Enter");
  await editor.waitForFunction(() => window.copied === document.querySelector("#embed-code").value);
  assert.equal(await editor.locator("#embed-dialog").isVisible(), true);
  assert.match(await editor.evaluate(() => window.copied), /\?view#net=/);
  await editor.keyboard.press("Escape");
  assert.equal(await editor.evaluate(() => document.activeElement.dataset.action), "share");
  console.log("PASS embed dialog: one menu item, custom height, invalid sizes refused, Enter copies without closing");
  await editor.locator('[data-action="export"]').click();
  for (const kind of ["svg", "png"]) {
    const pending = editor.waitForEvent("download");
    await editor.locator(`[data-action="download-${kind}"]`).click();
    const download = await pending;
    images.set(`/network.${kind}`, await readFile(await download.path()));
  }
  for (const kind of ["svg", "png"]) {
    await editor.goto(base + "/?src=" + encodeURIComponent(base + `/network.${kind}?a=1&b=2`));
    await editor.waitForFunction(() => document.querySelectorAll(".node").length === 4);
    await editor.locator('[data-action="share"]').click();
    await editor.locator('[data-action="copy-embed"]').click();
    await editor.locator("#embed-dialog").waitFor({ state: "visible" });
    assert.equal(await editor.locator("#embed-image").isEnabled(), true);
    assert.equal(await editor.locator("#embed-image").isChecked(), false);
    assert.match(await editor.locator("#embed-code").inputValue(), /^<iframe /);
    await editor.locator("#embed-height").fill("583");
    await editor.locator("#embed-image").check();
    assert.match(await editor.locator("#embed-code").inputValue(), /height: 583px/);
    await editor.locator("#embed-image").uncheck();
    assert.match(await editor.locator("#embed-code").inputValue(), /^<iframe .*height="583"/);
    await editor.locator("#embed-image").check();
    await editor.locator('[data-action="do-copy-embed"]').click();
    imageEmbed = await editor.evaluate(() => window.copied);
    assert.equal(imageEmbed, await editor.locator("#embed-code").inputValue());
    assert.match(imageEmbed, /a=1&amp;b=2/);
    await editor.locator('[data-action="close-embed"]').click();
    const article = await context.newPage();
    // Hold the actual image fetch in the app, not the ordinary <img> download.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await article.route("**/network.*", async route => {
      if (route.request().resourceType() === "fetch") await gate;
      await route.continue();
    });
    // The host page and app have different origins, as on a real blog.
    await article.goto(base.replace("127.0.0.1", "localhost") + "/image-article");
    await article.waitForFunction(() => document.querySelector("img")?.naturalWidth > 0);
    assert.equal(await article.locator("iframe").isVisible(), false);
    // A ready message from the wrong window must not reveal an unready app.
    await article.evaluate(() => window.postMessage("bn-viewer-ready", "*"));
    await article.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      source: document.querySelector("iframe").contentWindow, origin: "https://unrelated.example", data: "bn-viewer-ready",
    })));
    assert.equal(await article.locator("img").isVisible(), true);
    release();
    await article.locator("iframe").waitFor({ state: "visible" });
    assert.equal(await article.locator("a").evaluate(link => link.inert), true);
    assert.equal(await article.locator("iframe").getAttribute("aria-hidden"), null);
    const frame = article.frames()[1];
    await frame.waitForFunction(() => getComputedStyle(document.documentElement).opacity === "1");
    await frame.locator('.node[data-node="3"] [data-state="0"]').click();
    assert.match(await frame.locator("#evidence-bar").textContent(), /rain = yes/);
    assert.equal(await frame.locator('.node[data-node="1"] [data-state="0"] .pct').textContent(), "80.0%");
    await article.close();

    // Edits, including new evidence, must not offer an out-of-date image as their preview.
    await editor.locator('.node[data-node="3"] [data-state="0"]').click();
    await editor.locator('[data-action="share"]').click();
    await editor.locator('[data-action="copy-embed"]').click();
    await editor.locator("#embed-dialog").waitFor({ state: "visible" });
    assert.equal(await editor.locator("#embed-image").isEnabled(), true);
    assert.equal(await editor.locator("#embed-image-url").inputValue(), "");
    assert.equal(await editor.locator("#embed-image").isChecked(), false);
    assert.match(await editor.locator("#embed-code").inputValue(), /^<iframe /);
    await editor.locator('[data-action="close-embed"]').click();
    console.log(`PASS ${kind}: real export → image-first copy → preview during import → interactive evidence; no stale preview after edits`);
  }
  for (const failure of ["app", "fetch", "metadata", "no-scripts"]) {
    const article = await context.newPage();
    if (failure === "app") await article.route("**/js/app.js", route => route.abort());
    if (failure === "fetch") await article.route("**/network.png*", route =>
      route.request().resourceType() === "fetch" ? route.abort() : route.continue());
    if (failure === "metadata") await article.route("**/network.png*", route =>
      route.request().resourceType() === "fetch"
        ? route.fulfill({ body: '<svg xmlns="http://www.w3.org/2000/svg"/>', contentType: "image/svg+xml" }) : route.continue());
    if (failure === "no-scripts") await article.route("**/image-article", route =>
      route.fulfill({ body: imageEmbed, contentType: "text/html", headers: { "Content-Security-Policy": "script-src 'none'" } }));
    await article.goto(base + "/image-article");
    await article.waitForFunction(() => document.querySelector("img")?.naturalWidth > 0);
    if (failure === "fetch" || failure === "metadata") {
      await article.frames()[1].waitForFunction(() => !document.body.classList.contains("viewer-loading"));
    }
    assert.equal(await article.locator("img").isVisible(), true);
    assert.equal(await article.locator("iframe").isVisible(), false);
    assert.match(await article.locator("a").getAttribute("href"), /view&src=/);
    await article.close();
    console.log(`PASS ${failure}: image fallback survives failed enhancement`);
  }
  await editor.goto(base + "/?src=/network.py");
  await editor.waitForFunction(() => document.querySelectorAll(".node").length === 4);
  await editor.locator('[data-action="share"]').click();
  await editor.locator('[data-action="copy-embed"]').click();
  await editor.locator("#embed-dialog").waitFor({ state: "visible" });
  assert.equal(await editor.locator("#embed-image").isEnabled(), true);
  await editor.keyboard.press("Escape");
  console.log("PASS Python source: image options available without an existing image");

  const snapshotName = 'Wet grass — 雨 & "sun"';
  await editor.locator("#net-name").fill(snapshotName);
  await editor.locator("#net-name").press("Tab");
  await editor.locator('.node[data-node="3"] [data-state="0"]').click();
  assert.equal(new URL(editor.url()).searchParams.has("src"), false);
  await editor.locator('[data-action="share"]').click();
  await editor.locator('[data-action="copy-embed"]').click();
  await editor.locator("#embed-dialog").waitFor({ state: "visible" });
  assert.doesNotMatch(await editor.locator("#embed-dialog").textContent(), /readers can set evidence but can't edit/);
  await editor.locator("#embed-image").check();
  for (const url of ["", "not a URL", "javascript:alert(1)", "ftp://example.com/a.svg", "data:image/svg+xml,test"]) {
    await editor.locator("#embed-image-url").fill(url);
    assert.equal(await editor.locator('[data-action="do-copy-embed"]').isDisabled(), true);
  }
  const pendingImage = editor.waitForEvent("download");
  await editor.locator('[data-action="embed-download-image"]').click();
  images.set("/uploaded.svg", await readFile(await (await pendingImage).path()));
  await editor.locator("#embed-image-url").fill(base + "/uploaded.svg?a=1&b=2");
  await editor.locator('[data-action="do-copy-embed"]').click();
  imageEmbed = await editor.evaluate(() => window.copied);
  assert.match(imageEmbed, /uploaded.svg\?a=1&amp;b=2/);
  const uploaded = await context.newPage();
  await uploaded.goto(base.replace("127.0.0.1", "localhost") + "/image-article");
  await uploaded.locator("iframe").waitFor({ state: "visible" });
  assert.equal(await uploaded.frames()[1].locator("#viewer-title").textContent(), snapshotName);
  assert.match(await uploaded.frames()[1].locator("#evidence-bar").textContent(), /rain = yes/);
  assert.equal(await uploaded.frames()[1].locator('.node[data-node="1"] [data-state="0"] .pct').textContent(), "80.0%");
  await uploaded.close();
  console.log("PASS new hosted image: dialog download → hosted SVG → URL entry → viewer retains Unicode title and evidence");

  await editor.locator("#embed-image-source").selectOption("data");
  assert.equal(await editor.locator("#embed-image-url").isDisabled(), true);
  await editor.locator('[data-action="do-copy-embed"]').click();
  imageEmbed = await editor.evaluate(() => window.copied);
  assert.match(imageEmbed, /<img src="data:image\/svg\+xml;charset=utf-8,/);
  assert.match(imageEmbed, /data-src="[^\"]+\?view&amp;image-first#net=/);
  for (const [fail, reducedMotion] of [[false, false], [true, false], [false, true]]) {
    const article = await context.newPage();
    await article.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
    const imageRequests = [];
    article.on("request", r => { if (r.resourceType() === "image" && /^https?:/.test(r.url())) imageRequests.push(r.url()); });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await article.route("**/js/app.js", async route => {
      if (fail) await route.abort();
      else { await gate; await route.continue(); }
    });
    await article.goto(base.replace("127.0.0.1", "localhost") + "/image-article", { waitUntil: "domcontentloaded" });
    await article.waitForFunction(() => document.querySelector("img")?.naturalWidth > 0);
    assert.equal(await article.locator("iframe").isVisible(), false);
    assert.equal(await article.locator("img").evaluate(img => getComputedStyle(img.closest("div")).backgroundColor), "rgb(246, 247, 249)");
    const imageCode = await article.locator("img").getAttribute("src");
    const snapshot = P.importPython(await editor.evaluate(url => BNImage.codeFromSvg(decodeURIComponent(url.slice(url.indexOf(",") + 1))), imageCode));
    assert.equal(snapshot.net.name, snapshotName);
    assert.equal(snapshot.evidence.rain, "yes");
    release();
    if (!fail) {
      await article.locator("iframe").waitFor({ state: "visible" });
      assert.equal(await article.locator("a").evaluate(link => link.inert), true);
      await article.frames()[1].waitForFunction(() => getComputedStyle(document.documentElement).opacity === "1");
      if (reducedMotion) assert.equal(await article.frames()[1].evaluate(() => document.documentElement.getAnimations().length), 0);
      assert.equal(await article.frames()[1].locator("#viewer-title").textContent(), snapshotName);
      assert.match(await article.frames()[1].locator("#evidence-bar").textContent(), /rain = yes/);
    } else await article.waitForLoadState("load");
    assert.deepEqual(imageRequests, []);
    await article.close();
    console.log(`PASS data URL: ${fail ? "app failure retains image" : reducedMotion ? "reduced motion skips fade" : "preview fades to hash viewer"}; no hosted image request, title and evidence retained`);
  }
  // Themes: by default the embed follows the reader's system (both images, light-dark background);
  // a chosen theme is fixed for every reader.
  for (const [theme, scheme, bg] of [["", "dark", "rgb(22, 25, 31)"], ["", "light", "rgb(246, 247, 249)"], ["dark", "light", "rgb(22, 25, 31)"], ["light", "dark", "rgb(246, 247, 249)"]]) {
    await editor.locator("#embed-theme").selectOption(theme);
    await editor.locator('[data-action="do-copy-embed"]').click();
    imageEmbed = await editor.evaluate(() => window.copied);
    assert.equal(imageEmbed.includes("&amp;theme="), !!theme);
    assert.equal(imageEmbed.includes("<picture"), !theme);
    const article = await context.newPage();
    await article.emulateMedia({ colorScheme: scheme });
    await article.goto(base.replace("127.0.0.1", "localhost") + "/image-article");
    await article.waitForFunction(() => document.querySelector("img")?.naturalWidth > 0);
    assert.equal(await article.locator("img").evaluate(img => getComputedStyle(img.closest("div")).backgroundColor), bg);
    const shown = await article.locator("img").evaluate(img => decodeURIComponent(img.currentSrc));
    assert.ok(shown.includes(`fill="${bg === "rgb(22, 25, 31)" ? "#16191f" : "#f6f7f9"}"`) || shown.includes(bg), `image in the ${theme || scheme} theme`);
    await article.locator("iframe").waitFor({ state: "visible" });
    assert.equal(await article.frames()[1].evaluate(() => getComputedStyle(document.body).backgroundColor), bg);
    await article.close();
  }
  await editor.locator("#embed-theme").selectOption("");
  console.log("PASS themes: reader's system by default (both images), or a fixed light or dark theme");
  await editor.locator("#embed-image-source").selectOption("url");
  assert.equal(await editor.locator("#embed-image-url").inputValue(), base + "/uploaded.svg?a=1&b=2");
  await editor.locator("#embed-image").uncheck();
  assert.match(await editor.locator("#embed-code").inputValue(), /^<iframe /);
  await editor.locator('[data-action="close-embed"]').click();
  // Seed the result of a Gist publish, without publishing anything to GitHub.
  const gistLink = base + "/?src=" + encodeURIComponent(base + "/network.py?revision=known");
  await editor.evaluate(link => {
    document.querySelector("#gist-link").value = link;
    document.querySelector("#gist-intro").hidden = true;
    document.querySelector("#gist-result").hidden = false;
    document.querySelector("#gist-dialog").showModal();
  }, gistLink);
  await editor.locator('[data-action="gist-copy-embed"]').click();
  await editor.locator("#embed-dialog").waitFor({ state: "visible" });
  await editor.locator('[data-action="do-copy-embed"]').click();
  assert.ok((await editor.evaluate(() => window.copied)).includes(gistLink.replace("?src=", "?view&amp;src=")));
  assert.equal(await editor.locator("#embed-image").isEnabled(), true);
  assert.equal(await editor.locator("#embed-image-url").inputValue(), "");
  await editor.locator('[data-action="close-embed"]').click();
  assert.equal(await editor.locator("#gist-dialog").isVisible(), true);
  console.log("PASS Gist result: same embed dialog, hosted revision retained, returns to Gist dialog");
  await context.close();
} finally {
  await browser?.close();
  server.close();
}
