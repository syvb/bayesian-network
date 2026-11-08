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
  } else if (url.pathname === "/widget-image-article") {
    // Like a LessWrong widget: the embed code in a srcdoc frame sandboxed with only allow-scripts.
    res.setHeader("Content-Type", "text/html");
    res.end(`<iframe sandbox="allow-scripts" width="800" height="700" srcdoc="${imageEmbed.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`);
  } else if (images.has(url.pathname)) {
    res.setHeader("Content-Type", url.pathname.endsWith(".svg") ? "image/svg+xml" : "image/png");
    res.end(images.get(url.pathname));
  } else if (url.pathname === "/article") {
    const src = url.searchParams.has("src") ? "?view&src=/network.py" : "?view" + hash;
    res.setHeader("Content-Type", "text/html");
    const sandbox = "allow-scripts allow-popups" + (url.searchParams.has("escape") ? " allow-popups-to-escape-sandbox" : "");
    res.end(`<iframe id="network" sandbox="${sandbox}" src="/${src}" width="800" height="600"></iframe>`);
  } else if (url.pathname === "/broken") {
    res.setHeader("Content-Type", "text/html");
    // default-size (300×150) frames, smaller than the viewer's padding
    res.end(`<iframe sandbox="allow-scripts allow-popups" src="/?view#net=damaged"></iframe><iframe sandbox="allow-scripts allow-popups" src="/?view&src=/missing.py"></iframe><iframe sandbox="allow-scripts allow-popups" src="/?view${hash}"></iframe>`);
  } else if (url.pathname === "/paste.py") {
    // Like api.pastes.dev: CORS headers only for requests with an Origin, yet publicly cacheable.
    res.removeHeader("Access-Control-Allow-Origin");
    if (req.headers.origin) { res.setHeader("Access-Control-Allow-Origin", req.headers.origin); res.setHeader("Vary", "Origin"); }
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.end(code);
  } else if (url.pathname === "/cached-image-first") {
    // The article's <img> caches the file without CORS headers before the viewer fetches it.
    const paste = `http://localhost:${server.address().port}/paste.py?${url.searchParams.get("n")}`;
    res.setHeader("Content-Type", "text/html");
    // (Unsandboxed: Chromium gives an opaque-origin frame a cache of its own.)
    res.end(`<img src="${paste}" onerror="document.body.insertAdjacentHTML('beforeend', '<iframe src=&quot;/?view&amp;src=' + encodeURIComponent('${paste}') + '&quot; width=&quot;800&quot; height=&quot;600&quot;></iframe>')">`);
  } else if (url.pathname === "/tall") {
    // an embed partway down a long page
    res.setHeader("Content-Type", "text/html");
    res.end(`<meta name="viewport" content="width=device-width"><div style="height:300px"></div><iframe sandbox="allow-scripts allow-popups" src="/?view${url.searchParams.has("page-scroll") ? "&page-scroll" : ""}${hash}" width="100%" height="500"></iframe><div style="height:2000px"></div>`);
  } else if (url.pathname === "/missing.py") res.writeHead(404).end();
  else if (url.pathname === "/network.py") res.end(code);
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
  // (Local network access checks would block the routed https page from framing this loopback server.)
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ["--disable-features=LocalNetworkAccessChecks"] });
  for (const site of ["https://www.lesswrong.com/posts/x", "https://example.com/post"]) {
    // A LessWrong widget is a srcdoc frame sandboxed with only allow-scripts, so the viewer
    // inside it can't open tabs and mustn't offer to; the same frame elsewhere still does.
    const page = await browser.newPage();
    await page.route(site, route => route.fulfill({ contentType: "text/html", body: `<iframe sandbox="allow-scripts" srcdoc="&lt;iframe src='${base}/?view${hash}'&gt;&lt;/iframe&gt;"></iframe>` }));
    await page.goto(site);
    await page.waitForFunction(() => document.querySelector("iframe").contentWindow.frames.length === 1);
    const frame = page.frames().find(f => f.url().startsWith(base));
    await frame.waitForFunction(() => document.querySelectorAll(".node").length === 4);
    assert.equal(await frame.locator('[data-action="open-viewer"]').isVisible(), !site.includes("lesswrong"));
    await page.close();
  }
  console.log("PASS LessWrong widget: no new-tab buttons there; other sites keep Full screen");
  {
    // An embed whose link can't be opened shows why, not the demo or any other network.
    const page = await browser.newPage();
    await page.goto(base + "/broken");
    for (const [i, reason] of [[1, /damaged/], [2, /HTTP 404/]]) {
      const frame = page.frames()[i];
      await frame.waitForSelector("#load-error");
      assert.match(await frame.locator("#load-error").textContent(), reason);
      assert.equal(await frame.locator("svg, .node").count(), 0);
    }
    await page.frames()[3].waitForFunction(() => document.querySelectorAll(".node").length === 4);
    if (process.env.CAPTURE_DIR) await page.screenshot({ path: `${process.env.CAPTURE_DIR}/embed-broken.png` });
    await page.close();
    console.log("PASS broken embed: damaged hash and failed download show only the reason; a default-size embed loads");
  }

  {
    const page = await browser.newPage();
    await page.goto(base + "/cached-image-first?n=" + Date.now());
    await page.waitForSelector("iframe");
    const frame = page.frames()[1];
    await frame.waitForFunction(() => document.querySelectorAll(".node").length === 4 || document.querySelector("#load-error"));
    assert.equal(await frame.locator("#load-error").count(), 0);
    await page.close();
    console.log("PASS cached copy without CORS headers: the viewer refetches it instead of failing");
  }

  for (const pageScroll of [false, true]) {
    // Loading must not scroll the host page. With ?page-scroll, the wheel and one-finger drags
    // scroll the page instead of the network; Ctrl+wheel (a trackpad pinch) and pinching still zoom.
    const context = await browser.newContext({ viewport: { width: 400, height: 700 }, hasTouch: true });
    const page = await context.newPage();
    await page.goto(base + "/tall" + (pageScroll ? "?page-scroll" : ""));
    const frame = page.frames()[1];
    await frame.waitForFunction(() => document.querySelectorAll(".node").length === 4 && !document.body.classList.contains("viewer-loading"));
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => scrollY), 0);
    const transform = () => frame.evaluate(() => document.querySelector("#viewport").getAttribute("transform"));
    const t0 = await transform();
    await page.mouse.move(200, 600);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => scrollY) > 0, pageScroll);
    assert.equal(await transform() !== t0, !pageScroll);
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(100);
    const t1 = await transform();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await page.waitForTimeout(200);
    assert.notEqual(await transform(), t1);
    assert.equal(await page.evaluate(() => scrollY), 0);
    const cdp = await context.newCDPSession(page);
    const touch = async (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    const t2 = await transform();
    await touch("touchStart", [[200, 650]]);
    for (let i = 1; i <= 10; i++) { await touch("touchMove", [[200, 650 - i * 20]]); await page.waitForTimeout(16); }
    await touch("touchEnd", []);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => scrollY) > 0, pageScroll);
    assert.equal(await transform() !== t2, !pageScroll);
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(100);
    const t3 = await transform();
    await touch("touchStart", [[180, 600], [220, 600]]);
    for (let i = 1; i <= 10; i++) { await touch("touchMove", [[180 - i * 8, 600], [220 + i * 8, 600]]); await page.waitForTimeout(16); }
    await touch("touchEnd", []);
    await page.waitForTimeout(300);
    assert.notEqual(await transform(), t3);
    if (pageScroll) {
      // An open node card that fits mustn't become a scroll area that swallows the page's drag.
      await page.evaluate(() => scrollTo(0, 0));
      await frame.locator('[data-action="fit"]').click();
      const name = await frame.locator('.node[data-node="3"] text.name').boundingBox();
      await page.touchscreen.tap(name.x + name.width / 2, name.y + name.height / 2);
      await frame.locator("#node-sheet summary").click();
      const card = await frame.locator("#node-sheet").boundingBox();
      const x = card.x + card.width / 2, y = card.y + card.height / 2;
      await touch("touchStart", [[x, y]]);
      for (let i = 1; i <= 10; i++) { await touch("touchMove", [[x, y - i * 15]]); await page.waitForTimeout(16); }
      await touch("touchEnd", []);
      await page.waitForTimeout(300);
      assert.ok(await page.evaluate(() => scrollY) > 0);
    }
    await context.close();
    console.log(`PASS ${pageScroll ? "page-scroll" : "default"} embed on a long page: no jump on load; ${pageScroll ? "scrolling and dragging scroll the page" : "scrolling and dragging move the network"}; pinch zooms`);
  }

  for (const source of ["hash", "src"]) {
    const context = await browser.newContext();
    const errors = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    const page = await context.newPage();
    await page.goto(base + "/article" + (source === "src" ? "?src" : ""));
    const frame = page.frames()[1];
    await frame.waitForFunction(() => document.querySelectorAll(".node").length === 4);
    // no "Loading <url>…" message at the bottom of an embed
    assert.equal(await frame.locator("#toast").textContent(), "");
    for (const key of ["localStorage", "sessionStorage"]) {
      assert.equal(await frame.evaluate(key => {
        try { window[key]; return false; } catch (e) { return e.name === "SecurityError"; }
      }, key), true);
    }
    // Without storage the editor can't work, so nothing offers it; Full screen still does.
    assert.equal(await frame.locator('[data-action="open-editor"]').isVisible(), false);
    assert.equal(await frame.locator('[data-action="open-viewer"]').isVisible(), true);
    // Hovering a node shows its probability table; Reset is off until something changes.
    const wet = await frame.locator('.node[data-node="4"] text.name').boundingBox();
    await page.mouse.move(wet.x + wet.width / 2, wet.y + wet.height / 2, { steps: 4 });
    await frame.locator("#node-tip .tip-cpt").waitFor();
    assert.equal(await frame.locator("#node-tip .tip-cpt tbody tr").count(), 4);
    assert.match(await frame.locator("#node-tip .tip-cpt tbody tr").first().textContent(), /onyes99\.0%1\.0%/);
    await page.mouse.move(2, 2);
    const reset = frame.locator('[data-action="reset-viewer"]');
    assert.equal(await reset.isDisabled(), true);
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
    // Reset returns to the link's state: no evidence, observing, soft evidence off.
    await frame.locator('[data-click-mode="intervene"]').click();
    assert.equal(await reset.isDisabled(), false);
    await reset.click();
    assert.equal(await frame.locator(".ev-chip").count(), 0);
    assert.equal(await frame.locator('[data-click-mode="observe"]').evaluate(el => el.classList.contains("on")), true);
    assert.equal(await reset.isDisabled(), true);
    // Restore hard evidence after exercising both soft-evidence preferences.
    await rain.click();
    // Safari blocks a popup opened after an await in a sandboxed frame: it must open during the click.
    await frame.evaluate(() => {
      const open = window.open;
      window.open = (...args) => { window.openedDuring = window.event?.type; return open.apply(window, args); };
    });
    await frame.waitForTimeout(100);
    const popupPromise = page.waitForEvent("popup");
    await frame.locator('[data-action="open-viewer"]').click();
    const popup = await popupPromise;
    assert.equal(await frame.evaluate(() => window.openedDuring), "click");
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
    await editorPage.waitForFunction(() => !document.body.classList.contains("viewer")); // ownership is acquired asynchronously
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
  for (const id of ["export-dialog", "import-dialog", "embed-dialog", "gist-dialog"]) {
    const dialog = editor.locator("#" + id);
    await dialog.evaluate(el => el.showModal());
    await dialog.locator("h2").click();
    assert.equal(await dialog.isVisible(), true, `${id}: content click stays open`);
    const box = await dialog.boundingBox();
    await editor.mouse.click(box.x + 5, box.y + 5);
    assert.equal(await dialog.isVisible(), true, `${id}: padding click stays open`);
    const field = dialog.locator("textarea, p").first();
    await field.click();
    assert.equal(await dialog.isVisible(), true, `${id}: field or text click stays open`);
    await editor.mouse.move(box.x + 5, box.y + 5);
    await editor.mouse.down();
    await editor.mouse.move(5, 5);
    await editor.mouse.up();
    assert.equal(await dialog.isVisible(), true, `${id}: drag out stays open`);
    await editor.mouse.click(5, 5);
    assert.equal(await dialog.isVisible(), false, `${id}: backdrop click closes`);
    await dialog.evaluate(el => el.showModal());
    await editor.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), false, `${id}: Escape still closes`);
  }
  console.log("PASS all four dialogs: inside clicks and drags stay open; backdrop clicks and Escape close");
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
  {
    // Inside an opaque-origin sandbox the viewer's ready message comes from "null", and still reveals it.
    const article = await context.newPage();
    await article.goto(base.replace("127.0.0.1", "localhost") + "/widget-image-article");
    const widget = article.frameLocator("iframe");
    await widget.locator("iframe").waitFor({ state: "visible" });
    assert.equal(await widget.locator("a").evaluate(link => link.inert), true);
    const frame = article.frames().find(f => f.url().startsWith(base));
    assert.equal(await frame.evaluate(() => window.origin), "null");
    assert.match(await frame.locator("#evidence-bar").textContent(), /rain = yes/);
    await article.close();
    console.log("PASS data URL in a LessWrong-style widget: viewer replaces the image");
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
  // never taller than the reader's screen (with the browser's toolbars showing)
  assert.match(await editor.locator("#embed-code").inputValue(), /max-height: 85svh/);
  await editor.locator("#embed-page-scroll").check();
  assert.match(await editor.locator("#embed-code").inputValue(), /&amp;page-scroll/);
  await editor.locator("#embed-page-scroll").uncheck();
  assert.doesNotMatch(await editor.locator("#embed-code").inputValue(), /page-scroll/);
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
