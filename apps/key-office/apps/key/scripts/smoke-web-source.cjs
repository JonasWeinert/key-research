// Saved web pages against a local server: "Save to library" in the browser bar snapshots the
// page (metadata, inlined styles and images, no scripts) as a web source and says "In
// library"; the saved copy reads offline in the web page reader (server stopped), text is
// highlighted and commented from the selection toolbar, the highlights come back after the
// reader reopens, show in the panel and on the source's page, and Cite pastes into a note as
// a source quote whose link scrolls the reader to the passage. Screenshots land in the temp
// folder it prints.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, readFile } = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { tmpdir } = require("node:os");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await wait(150);
  }
}
function assert(value, message) {
  if (!value) throw Error(`Assertion failed: ${message}`);
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mNkYPhfz0AEYBxVSF+FjP8ZGBgYGBgYRhVSFwAAeCAPEf7ZJqYAAAAASUVORK5CYII=", "base64");
const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rivers and cities | Field Notes</title>
<meta name="citation_title" content="How rivers shaped early cities">
<meta name="citation_author" content="Okafor, Adaeze"><meta name="citation_author" content="Lindqvist, Erik">
<meta name="citation_publication_date" content="2021-05-04"><meta name="citation_doi" content="10.5555/rivers.2021.17">
<meta property="og:site_name" content="Field Notes"><meta name="description" content="Why settlements grew along water.">
<link rel="stylesheet" href="/style.css"></head>
<body><header class="masthead">Field Notes</header><article>
<h1>How rivers shaped early cities</h1><p class="byline">Adaeze Okafor and Erik Lindqvist</p>
<img id="figure" src="/figure.png" width="64" height="64" alt="A figure">
<p id="one">Rivers supplied water, food and a road for trade. Settlements that grew along them could feed far more people than those inland.</p>
<p id="two">Floods were a hazard, but they also renewed the soil every year, which made the floodplain the most fertile land for miles.</p>
<p id="three">Bridges and fords decided where roads crossed, so markets formed at the crossings and towns followed the markets.</p>
<p><a id="live" href="/elsewhere">Read more on the site</a></p>
</article><script>document.body.dataset.ran = "yes"; document.getElementById("three").insertAdjacentHTML("afterend", '<p id="added">Added by a script on the live page.</p>');</script></body></html>`;
const CSS = `@import url("/extra.css"); body{font:17px/1.6 Georgia,serif;max-width:680px;margin:32px auto;padding:0 24px;color:rgb(34, 34, 34)} h1{color:rgb(120, 40, 20);font-size:30px} .masthead{background:url("/figure.png") no-repeat left center;padding-left:24px;color:rgb(90, 90, 90);font:600 13px system-ui}`;

async function serve() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/article") return res.end(ARTICLE);
    if (req.url === "/style.css") return res.setHeader("content-type", "text/css"), res.end(CSS);
    if (req.url === "/extra.css") return res.setHeader("content-type", "text/css"), res.end("p{letter-spacing:0.1px}");
    if (req.url === "/figure.png") return res.setHeader("content-type", "image/png"), res.end(PNG);
    res.statusCode = 404;
    res.end("Not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, hits, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-web-source-smoke-"));
  await mkdir(path.join(temp, "profile"));
  const shots = path.join(temp, "shots");
  await mkdir(shots);
  const { server, hits, base } = await serve();
  const report = {};
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_BROWSER_SMOKE: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  if (process.env.KEY_SMOKE_VERBOSE) app.process().stderr.on("data", (d) => process.stderr.write(`[main] ${d}`));
  let failShot;
  try {
    const shell = await app.firstWindow();
    failShot = () => shell.screenshot({ path: path.join(shots, "failure.png") });
    shell.setDefaultTimeout(20000);
    const errors = [];
    shell.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await shell.waitForFunction(() => window.key);
    await shell.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await shell.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => shell.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    // 1. Save the live page from the browser bar.
    await shell.evaluate((url) => window.key.tabAction("open-url", { url }), `${base}/article`);
    const save = shell.locator(".key-web-bar .key-web-save", { hasText: "Save to library" });
    await save.waitFor();
    await until(async () => !(await save.isDisabled()), "the page to load");
    await shell.screenshot({ path: path.join(shots, "1-browser-bar.png") });
    await save.click();
    await shell.locator(".key-web-bar .key-web-save", { hasText: "In library" }).waitFor({ timeout: 30000 });
    await shell.screenshot({ path: path.join(shots, "2-browser-bar-saved.png") });
    const { items } = await call("store_sources", { kind: "web", limit: 10, offset: 0 });
    assert(items.length === 1, `one web source (${items.length})`);
    const source = items[0];
    report.source = { title: source.title, url: source.url, doi: source.doi, date: source.date, site: source.containerTitle, creators: source.creators.map((c) => `${c.given} ${c.family}`), file: path.basename(source.filePath) };
    assert(source.title === "How rivers shaped early cities", "title from citation_title");
    assert(source.url === `${base}/article`, "the page URL");
    assert(source.doi === "10.5555/rivers.2021.17", "the DOI");
    assert(source.year === 2021 && source.containerTitle === "Field Notes", "year and site");
    assert(source.creators.length === 2 && source.creators[0].family === "Okafor", "authors");
    assert(source.filePath.endsWith(".html"), "an HTML snapshot");
    const html = await readFile(source.filePath, "utf8");
    assert(!/<script/i.test(html), "no scripts in the snapshot");
    assert(/Content-Security-Policy/.test(html), "the snapshot carries its no-network policy");
    assert(!html.includes(`${base}/figure.png`) && html.includes("data:image/png;base64"), "images inlined");
    assert(html.includes("rgb(120, 40, 20)") && html.includes("letter-spacing"), "stylesheets and their imports inlined");
    report.snapshotBytes = html.length;
    // The text is indexed for search.
    await until(async () => (await call("store_source", { id: source.id }))?.indexStatus === "ready", "the page to be indexed", 60000);
    const found = await call("store_search", { text: "floodplain fertile", limit: 5 }).catch((e) => ({ error: String(e) }));
    report.search = Array.isArray(found?.hits ?? found) ? (found.hits ?? found).length : found;

    // 2. Read it offline: the server is gone.
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
    const hitsBefore = hits.length;
    await shell.locator(".key-web-bar .key-web-save", { hasText: "In library" }).click();
    const reader = shell.locator(".kx-web-reader");
    await reader.locator("iframe").waitFor();
    const frame = await until(async () => {
      const f = shell.frames().find((x) => x.url() === "about:srcdoc");
      return f && (await f.evaluate(() => !!document.querySelector("#two"))) && f;
    }, "the saved page in the reader");
    const page = await frame.evaluate(() => ({
      scripts: document.scripts.length,
      h1: getComputedStyle(document.querySelector("h1")).color,
      image: document.querySelector("#figure").src.slice(0, 22),
      imageLoaded: document.querySelector("#figure").naturalWidth,
      added: !!document.querySelector("#added"),
      ranHere: document.body.dataset.ran,
    }));
    report.offline = page;
    assert(page.scripts === 0, "no scripts in the reader");
    assert(page.h1 === "rgb(120, 40, 20)", "the page's styles apply offline");
    assert(page.image.startsWith("data:image/png") && page.imageLoaded === 16, "the image shows offline");
    assert(page.added, "the page as it was shown, after its scripts ran");
    assert(hits.length === hitsBefore, "no requests to the site while reading");
    const header = await reader.locator(".kx-web-reader-title").innerText();
    assert(/How rivers shaped early cities/.test(header) && /127\.0\.0\.1/.test(header) && /Saved/.test(header), `the reader's bar: ${header}`);
    await shell.screenshot({ path: path.join(shots, "3-reader.png") });

    // 3. Highlight and comment from the selection toolbar.
    const select = (id, text) =>
      frame.evaluate(
        ({ id, text }) => {
          const node = document.getElementById(id).firstChild;
          const at = node.data.indexOf(text);
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + text.length);
          const selection = document.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        },
        { id, text },
      );
    const toolbar = shell.locator(".kx-web-toolbar");
    await select("one", "Rivers supplied water, food and a road for trade.");
    await toolbar.waitFor();
    await shell.screenshot({ path: path.join(shots, "4-selection-toolbar.png") });
    await toolbar.getByRole("button", { name: "green highlight" }).click();
    await until(() => frame.evaluate(() => document.querySelectorAll('mark.key-hl[data-color="green"]').length === 1), "the green highlight");
    await select("two", "renewed the soil every year");
    await toolbar.getByRole("button", { name: "Add comment" }).click();
    const comment = shell.locator(".kx-web-comment textarea");
    await comment.fill("Annual floods as fertiliser.");
    await shell.screenshot({ path: path.join(shots, "5-comment.png") });
    await shell.locator(".kx-web-comment").getByRole("button", { name: "Save" }).click();
    await until(() => frame.evaluate(() => document.querySelectorAll("mark.key-hl[data-comment]").length === 1), "the commented highlight");
    const stored = await until(async () => {
      const list = await call("library_annotations", { hash: source.id });
      return list.length === 2 && list;
    }, "two stored annotations");
    report.annotations = stored.map((a) => ({ text: a.text, color: a.color, comment: a.comment, selectors: a.anchor.selectors.map((s) => s.type) }));
    assert(stored.every((a) => a.anchor.kind === "web" && a.anchor.selectors.length === 2), "text quote and position selectors");
    await reader.locator(".kx-web-reader-panel li").nth(1).waitFor();
    await shell.screenshot({ path: path.join(shots, "6-highlights-light.png") });
    await shell.emulateMedia({ colorScheme: "dark" });
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "6-highlights-dark.png") });
    await shell.emulateMedia({ colorScheme: "light" });
    // With a comment, the comment leads the row and the quote steps back.
    const row = reader.locator(".kx-web-reader-panel li .kx-annotation.has-comment");
    await row.waitFor();
    const emphasis = await row.evaluate((el) => {
      const size = (q) => parseFloat(getComputedStyle(el.querySelector(q)).fontSize);
      return { first: el.firstElementChild.className, comment: size(".kx-annotation-comment"), quote: size(".kx-annotation-quote") };
    });
    assert(emphasis.first === "kx-annotation-comment" && emphasis.quote < emphasis.comment, `comment leads: ${JSON.stringify(emphasis)}`);
    // A margin marker beside each highlight.
    report.markers = await frame.evaluate(() => document.querySelectorAll(".key-hl-bar").length);
    assert(report.markers === 2, `two margin markers, got ${report.markers}`);

    // The selection toolbar follows a small scroll and closes once the passage leaves the view.
    await frame.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.id = "spacer";
      spacer.style.height = "3000px";
      document.body.append(spacer);
    });
    await select("three", "markets formed at the crossings");
    await toolbar.waitFor();
    const before = await toolbar.boundingBox();
    await frame.evaluate(() => window.scrollBy(0, 20));
    await wait(200);
    const after = await toolbar.boundingBox();
    assert(after && Math.abs(before.y - after.y - 20) < 4, `the toolbar follows the selection: ${before?.y} -> ${after?.y}`);
    await frame.evaluate(() => window.scrollBy(0, 2000));
    await until(async () => !(await toolbar.count()), "the toolbar to close once its passage is out of view");
    await frame.evaluate(() => {
      document.getSelection().removeAllRanges();
      document.getElementById("spacer").remove();
      window.scrollTo(0, 0);
    });
    report.toolbarScroll = true;

    // 4. Reopen the reader: the highlights find their places again.
    const tabs = await shell.evaluate(() => window.key.tabs());
    const readerTab = tabs.tabs.find((t) => t.views[0]?.content?.section === "webpage");
    await shell.evaluate((id) => window.key.tabAction("close", { tabId: id }), readerTab.id);
    await until(async () => !(await shell.locator(".kx-web-reader").count()), "the reader to close");
    await shell.evaluate(({ id, sourceId }) => window.key.tabAction("open-content", { section: "webpage", workspaceId: id, sourceId }), { id: ws.id, sourceId: source.id });
    const reopened = await until(async () => {
      const f = shell.frames().find((x) => x.url() === "about:srcdoc");
      return f && (await f.evaluate(() => document.querySelectorAll("mark.key-hl").length >= 2)) && f;
    }, "highlights restored after reopening");
    report.restored = await reopened.evaluate(() => [...document.querySelectorAll("mark.key-hl")].map((m) => `${m.dataset.color}:${m.textContent}`));

    // 5. The highlights on the source's page.
    // 6. Cite a highlight, paste it into a note, follow its link back.
    await reopened.evaluate(() => document.querySelector('mark.key-hl[data-color="green"]').click());
    const info = shell.locator(".key-highlight-info");
    await info.waitFor();
    await info.getByRole("button", { name: "Cite" }).click();
    await until(async () => (await app.evaluate(({ clipboard }) => clipboard.readHTML())).includes("data-key-quote"), "the quote on the clipboard");
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    report.cite = clip;
    assert(/^“Rivers supplied water, food and a road for trade\.” — Okafor & Lindqvist \(2021\), How rivers shaped early cities$/.test(clip), `cite text: ${clip}`);
    const note = await call("store_note_save", { id: null, sourceId: null, title: "River notes", body: "Draft." });
    await shell.evaluate(({ id, noteId }) => window.key.tabAction("open-content", { section: "note", workspaceId: id, noteId, title: "River notes" }), { id: ws.id, noteId: note.id });
    const editor = shell.locator(".kx-note-page .ProseMirror, .ProseMirror").last();
    await editor.waitFor();
    await editor.click();
    await shell.keyboard.press("Meta+ArrowDown");
    await shell.keyboard.press("Enter");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
    const quote = shell.locator(".ne-squote").last();
    await quote.waitFor({ timeout: 8000 });
    report.pasted = (await quote.innerText()).replace(/\s+/g, " ");
    await shell.screenshot({ path: path.join(shots, "7-note-quote.png") });
    await quote.locator(".ne-squote-link").click();
    await until(async () => {
      const f = shell.frames().find((x) => x.url() === "about:srcdoc");
      return f && (await f.evaluate(() => !!document.querySelector("mark.key-passage, mark.key-hl.key-flash")));
    }, "the reader to show the quoted passage", 15000);
    await wait(400);
    await shell.screenshot({ path: path.join(shots, "8-quote-followed.png") });

    // The highlight's margin marker opens its card, which knows the note that quotes it;
    // its row opens the note at the quote.
    const followed = shell.frames().find((x) => x.url() === "about:srcdoc");
    await followed.evaluate(() => document.querySelector('.key-hl-bar[data-color="green"]').click());
    await info.waitFor();
    await info.locator(".key-highlight-info-uses li", { hasText: "River notes" }).waitFor({ timeout: 8000 });
    report.usedIn = await info.locator(".key-highlight-info-uses li").allInnerTexts();
    report.infoStyle = await info.evaluate((el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, opacity: s.opacity, color: s.color }; });
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "8b-highlight-info-light.png") });
    await shell.emulateMedia({ colorScheme: "dark" });
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "8b-highlight-info-dark.png") });
    await shell.emulateMedia({ colorScheme: "light" });
    await info.locator(".key-highlight-info-uses li button").first().click();
    await until(async () => /Rivers supplied water/.test(await shell.evaluate(() => String(window.getSelection()))), "the note to open at the quote", 8000);
    await shell.screenshot({ path: path.join(shots, "8c-note-at-quote.png") });

    // The source's page lists the highlights with "Show on page".
    await shell.evaluate(({ id, sourceId }) => window.key.tabAction("open-source-page", { workspaceId: id, sourceId, title: "Rivers", read: false }), { id: ws.id, sourceId: source.id });
    await shell.locator(".kx-page-highlights li").nth(1).waitFor();
    report.sourcePageHighlights = await shell.locator(".kx-page-highlights li").count();
    await shell.locator(".kx-page-highlights").getByRole("button", { name: "Show on page" }).first().waitFor();
    await shell.screenshot({ path: path.join(shots, "9-source-page.png") });

    assert(!errors.length, `page errors: ${errors.join("; ")}`);
    console.log(JSON.stringify({ ok: true, shots, ...report }, null, 2));
  } catch (error) {
    await failShot?.().catch(() => undefined);
    console.error(error);
    console.error(JSON.stringify({ ok: false, shots, ...report }, null, 2));
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => undefined);
    server.close();
  }
})();
