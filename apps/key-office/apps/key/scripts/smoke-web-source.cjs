// Saved web pages against a local server: "Save to library" in the browser bar snapshots the
// page (metadata, inlined styles and images, no scripts) as a web source and says "In
// library"; the saved copy reads offline in the web page reader (server stopped), text is
// highlighted and commented from the selection toolbar, the highlights come back after the
// reader reopens, show in the panel and on the source's page, and Cite pastes into a note as
// a source quote whose link scrolls the reader to the passage. Screenshots land in the temp
// folder it prints.
const { electron } = require("./lib/launch.cjs");
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
<p id="cites">Earlier surveys agree <a href="#ref-1">[1]</a>, though some dispute the timing <a href="#ref-2">[2]</a>.</p>
<p><a id="live" href="/elsewhere">Read more on the site</a></p>
<section><h2>References</h2><ol class="references">
<li id="ref-1">Okafor A. (2019). Water and settlement in the Niger basin. Journal of River Studies 12: 33–51. <a href="https://doi.org/10.5555/rivers.2019.3">https://doi.org/10.5555/rivers.2019.3</a></li>
<li id="ref-2">Lindqvist E, Moreau C. (2016). “Fords, bridges and the first market towns”. Urban History Review 8: 101–19.</li>
</ol></section>
</article><script>document.body.dataset.ran = "yes"; document.getElementById("three").insertAdjacentHTML("afterend", '<p id="added">Added by a script on the live page.</p>');</script></body></html>`;
const CSS = `@import url("/extra.css"); body{font:17px/1.6 Georgia,serif;max-width:680px;margin:32px auto;padding:0 24px;color:rgb(34, 34, 34)} h1{color:rgb(120, 40, 20);font-size:30px} .masthead{background:url("/figure.png") no-repeat left center;padding-left:24px;color:rgb(90, 90, 90);font:600 13px system-ui}`;

// A paper the library knows as a reference (by its DOI), and a landing page a reference's URL names.
const PAPER = `<!doctype html><html><head><meta charset="utf-8"><title>Delta towns</title><meta name="citation_title" content="Delta towns and their markets">
<meta name="citation_doi" content="10.5555/delta.2020.9"></head><body><h1>Delta towns and their markets</h1><p>Markets followed the water.</p></body></html>`;
const LANDING = `<!doctype html><html><head><meta charset="utf-8"><title>Floodplain soils</title></head><body><h1>Floodplain soils</h1><p>Silt renews the land each spring.</p></body></html>`;

async function serve() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/article") return res.end(ARTICLE);
    if (req.url === "/style.css") return res.setHeader("content-type", "text/css"), res.end(CSS);
    if (req.url === "/extra.css") return res.setHeader("content-type", "text/css"), res.end("p{letter-spacing:0.1px}");
    if (req.url === "/paper") return res.end(PAPER);
    if (req.url === "/landing") return res.end(LANDING);
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

    // A work the page cites is in the library already; so is the paper of step 1b, without its file.
    const cited = await call("store_create", { source: { kind: "reference", itemType: "article", title: "Water and settlement in the Niger basin", doi: "10.5555/rivers.2019.3" } });
    const paperRef = await call("store_create", { source: { kind: "reference", itemType: "article", title: "Delta towns and their markets", doi: "10.5555/delta.2020.9" } });
    const landingRef = await call("store_create", { source: { kind: "reference", itemType: "article", title: "Floodplain soils", url: `${base}/landing` } });

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

    // 1a. Its reference list was read from the page and stored as a PDF's analysis is; the
    // lookups run (the network may or may not answer), and the cited work in the library is linked.
    const analysis = await until(async () => {
      const a = await call("store_analysis", { id: source.id });
      report.analysisSeen = a && { analysis: a.analysis, references: a.references.map((r) => ({ text: r.text.slice(0, 30), meta: r.metadata, error: r.error, matched: r.matchedSourceId })) };
      return a?.analysis?.engine === "html" && a.references.length === 2 && a.references[0].matchedSourceId && a;
    }, "the page's references, looked up and linked", 120000);
    report.references = analysis.references.map((r) => ({ text: r.text.slice(0, 40), doi: r.metadata?.doi, matched: !!r.matchedSourceId }));
    report.referencesStatus = analysis.analysis.referencesStatus;
    assert(analysis.references[0].matchedSourceId === cited.id, "the cited work links to its library source");
    assert(/^Okafor A\. \(2019\)/.test(analysis.references[0].text) && !/doi\.org.*doi\.org/.test(analysis.references[0].text), "the reference as printed");

    // 1b. A page the library has as a reference without a file: the bar saves the page into it.
    await shell.evaluate((url) => window.key.tabAction("open-url", { url }), `${base}/paper`);
    const into = shell.locator(".key-web-bar .key-web-save[data-into]");
    await into.waitFor();
    report.saveInto = await into.innerText();
    assert(/Save page to Delta towns and their markets/.test(report.saveInto), `the bar offers the source: ${report.saveInto}`);
    await shell.screenshot({ path: path.join(shots, "1b-save-into-light.png") });
    await shell.emulateMedia({ colorScheme: "dark" });
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "1b-save-into-dark.png") });
    await shell.emulateMedia({ colorScheme: "light" });
    await until(async () => !(await into.isDisabled()), "the paper page to load");
    await into.click();
    await shell.locator(".key-web-bar .key-web-save", { hasText: "In library" }).waitFor({ timeout: 30000 });
    const paper = await call("store_source", { id: paperRef.id });
    report.savedInto = { kind: paper.kind, title: paper.title, itemType: paper.itemType, file: paper.filePath && path.basename(paper.filePath) };
    assert(paper.kind === "web" && paper.filePath?.endsWith(".html"), "the page became the reference's file");
    assert(paper.title === "Delta towns and their markets" && paper.itemType === "article", "the reference keeps what it is");
    const sameDoi = (await call("store_sources", { text: "10.5555/delta.2020.9", limit: 10, scope: "all" })).items.filter((s) => s.doi === "10.5555/delta.2020.9");
    assert(sameDoi.length === 1, `no duplicate source (${sameDoi.length})`);

    // 1c. A reference with no PDF: its source page saves its web page instead.
    await shell.evaluate(({ id, sourceId }) => window.key.tabAction("open-source-page", { workspaceId: id, sourceId, title: "Floodplain soils", read: false }), { id: ws.id, sourceId: landingRef.id });
    const more = shell.locator(".kx-source-more").last();
    await more.locator("summary").click();
    await more.getByRole("button", { name: "Save web page" }).click();
    await until(async () => (await call("store_source", { id: landingRef.id }))?.filePath, "the landing page saved into the reference", 60000);
    const landing = await call("store_source", { id: landingRef.id });
    report.landing = { kind: landing.kind, title: landing.title, file: path.basename(landing.filePath) };
    assert(landing.kind === "web" && landing.title === "Floodplain soils", "the landing page is the reference's file");
    assert(/Silt renews the land/.test(await readFile(landing.filePath, "utf8")), "the landing page's content");
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "1c-source-saved-page.png") });
    // Back to the article's tab.
    const back = (await shell.evaluate(() => window.key.tabs())).tabs.find((t) => t.views[0]?.web?.url === `${base}/article`);
    if (back) await shell.evaluate((tabId) => window.key.tabAction("activate", { tabId }), back.id);
    else await shell.evaluate((url) => window.key.tabAction("open-url", { url }), `${base}/article`);

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
    // The shared selection menu (SelectionMenu.tsx) in the saved page's reader.
    const toolbar = shell.locator(".ksm.kx-web-selection");
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
    // The panel docks beside the page in the same tab, as a PDF's: highlights, details, references.
    const tabsBefore = (await shell.evaluate(() => window.key.tabs())).tabs.length;
    await reader.getByRole("button", { name: "Highlights" }).click();
    const panel = shell.locator(".kx-web-panel");
    await panel.locator(".kx-web-highlights li").nth(1).waitFor();
    const docked = (await shell.evaluate(() => window.key.tabs())).tabs;
    assert(docked.length === tabsBefore, "no new tab for the panel");
    assert(docked.find((t) => t.views[0]?.content?.section === "webpage")?.panel?.tab === "highlights", "the panel docks in the reader's tab");
    await shell.screenshot({ path: path.join(shots, "6-highlights-light.png") });
    await shell.emulateMedia({ colorScheme: "dark" });
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "6-highlights-dark.png") });
    await shell.emulateMedia({ colorScheme: "light" });
    // With a comment, the comment leads the row and the quote steps back.
    const row = panel.locator(".kx-web-highlights li .kx-annotation.has-comment");
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
    // A highlight in the list shows it on the page.
    await panel.locator(".kx-web-highlights li button").first().click();
    await until(() => frame.evaluate(() => !!document.querySelector("mark.key-hl.key-flash")), "the highlight shown from the panel");
    // The status bar switches the panel too.
    const statusRefs = shell.locator('.kx-status-bar [data-status-item="references"]');
    await statusRefs.click();
    const refList = panel.locator(".key-ref-list li");
    await refList.nth(1).waitFor();
    report.panelReferences = await refList.allInnerTexts();
    assert(await panel.getByRole("button", { name: /In your library/ }).count(), "the cited work is marked in the library");
    assert(await panel.locator(".key-pdf-analysis").count(), "the analysis status");
    await shell.screenshot({ path: path.join(shots, "6b-references-light.png") });
    await shell.emulateMedia({ colorScheme: "dark" });
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "6b-references-dark.png") });
    await shell.emulateMedia({ colorScheme: "light" });
    await refList.nth(1).locator("button").first().click();
    await until(() => frame.evaluate(() => document.getElementById("ref-2").getAnimations().length > 0 || Math.abs(document.getElementById("ref-2").getBoundingClientRect().top) < innerHeight), "the reference shown on the page");
    // Details: the source's page in the same panel.
    await panel.getByRole("tab", { name: "Details" }).or(panel.getByRole("radio", { name: "Details" })).or(panel.getByRole("button", { name: "Details", exact: true })).first().click();
    await panel.locator(".key-shell-content").first().waitFor();
    await wait(400);
    await shell.screenshot({ path: path.join(shots, "6c-details-light.png") });

    // In-text citations: the PDF reader's card over the link, pinned by a click.
    await frame.evaluate(() => document.getElementById("cites").scrollIntoView({ block: "center" }));
    await wait(200);
    const link = await frame.evaluate(() => {
      const r = document.querySelector('a[href$="#ref-1"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const box = await reader.locator("iframe").boundingBox();
    await shell.mouse.move(box.x + link.x, box.y + link.y);
    const card = shell.locator(".kx-web-cite-card");
    await card.waitFor({ timeout: 5000 });
    await shell.mouse.click(box.x + link.x, box.y + link.y);
    await card.getByRole("button", { name: "Close citation" }).waitFor();
    report.card = (await card.innerText()).replace(/\s+/g, " ");
    assert(await card.getByRole("button", { name: /In library/ }).count(), "the card knows the work is in the library");
    await shell.screenshot({ path: path.join(shots, "6d-citation-card-light.png") });
    await shell.emulateMedia({ colorScheme: "dark" });
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "6d-citation-card-dark.png") });
    await shell.emulateMedia({ colorScheme: "light" });
    const details = card.getByRole("button", { name: "Show details" });
    if (await details.count()) {
      await details.click();
      await shell.locator(".kx-web-cite-card[data-expanded]").waitFor();
      await shell.screenshot({ path: path.join(shots, "6e-citation-expanded.png") });
    }
    await shell.keyboard.press("Escape");
    await until(async () => !(await card.count()), "the card to close");
    // Hide the panel again.
    await panel.getByRole("button", { name: /Hide details, highlights and references/ }).click();
    await until(async () => !(await panel.count()), "the panel to close");

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
    // A quote left on the clipboard (an earlier run) must not pass for this one.
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await info.getByRole("button", { name: "Cite" }).click();
    await until(async () => (await app.evaluate(({ clipboard }) => clipboard.readHTML())).includes("data-key-quote"), "the quote on the clipboard");
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    report.cite = clip;
    // Attributed in the chosen citation style (APA by default).
    assert(/^“Rivers supplied water, food and a road for trade\.” — Okafor & Lindqvist, 2021$/.test(clip), `cite text: ${clip}`);
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

    // 10. A search hit in the saved page opens its reader at the passage, lit until clicked.
    await shell.evaluate((id) => window.key.tabAction("open-content", { section: "search", workspaceId: id }), ws.id);
    const searchTab = shell.locator(".kx-search-page:not([hidden])");
    const field = searchTab.getByRole("combobox", { name: "Search everything" });
    await field.waitFor();
    await field.fill("fertile floodplain");
    await field.press("Escape");
    const hit = searchTab.locator('.kx-found-group[data-group="text"] .kx-found-hit', { hasText: "How rivers shaped early cities" });
    await hit.locator(".kx-passage").first().waitFor({ timeout: 20000 });
    await hit.locator(".kx-passage").first().click();
    const lit = await until(async () => {
      for (const f of shell.frames().filter((x) => x.url() === "about:srcdoc")) {
        const text = await f.evaluate(() => [...document.querySelectorAll("mark.key-passage-kept")].map((m) => m.textContent).join("")).catch(() => "");
        if (text) return { f, text };
      }
    }, "the reader at the search hit's passage", 20000);
    report.searchHit = lit.text.slice(0, 80);
    assert(/fertile/.test(lit.text), `the lit passage holds the match: ${lit.text}`);
    await wait(2800);
    assert(await lit.f.evaluate(() => document.querySelectorAll("mark.key-passage-kept").length > 0), "the passage stays lit");
    const visible = await lit.f.evaluate(() => { const r = document.querySelector("mark.key-passage-kept").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
    assert(visible, "the passage is scrolled into view");
    await shell.screenshot({ path: path.join(shots, "10-search-hit-light.png") });
    await shell.emulateMedia({ colorScheme: "dark" });
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "10-search-hit-dark.png") });
    await shell.emulateMedia({ colorScheme: "light" });

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
