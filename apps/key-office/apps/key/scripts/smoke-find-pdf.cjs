// Run serially: native windows and focus are shared with other GUI checks.
// Find PDF and Add by identifier against a local mock of OpenAlex, Unpaywall, Open Library,
// arXiv and PubMed (no real network):
//   - a reference with a stored open-access link gets its PDF from the source page's Find PDF;
//   - one with only a DOI gets it through Unpaywall (with the contact email from Settings);
//   - one with no copy to be had opens its publisher's page (a mock journal.example) in the
//     in-app browser with the Find PDF banner: the page's PDF link is offered, the PDF opened
//     there attaches to that source by itself, the page's snapshot kept meanwhile labels the
//     PDF's structure (headings, captions, references) and is deleted;
//   - one whose page has no PDF (an abstract behind a sign-in): the banner offers Sign in, the
//     page is kept, and the source page saves it as the full text (searchable); with a PDF too,
//     the source page lists both full texts, one primary;
//   - the library's bulk Find PDFs reports what it found and lists the publisher pages it ended
//     on, each to open (with the banner) or to save as the full text;
//   - Add by identifier takes a pasted list (DOI, ISBN, arXiv, PMID, one already in the
//     library, one unknown, one not an identifier) and lists what became of each;
//   - a DOI pasted into the library search offers "Add … to library".
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, mkdir, readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const fixtures = path.resolve(__dirname, "../../../../../crates/key-desktop-host/src/web_search/fixtures");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await wait(200);
  }
}

const ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry>
<id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12T17:57:34Z</published><title>Attention Is All You Need</title>
<summary>The dominant sequence transduction models.</summary><author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author></entry></feed>`;
const BOOK = {
  "ISBN:9780262033848": {
    title: "Introduction to Algorithms",
    subtitle: "Third edition",
    authors: [{ name: "Thomas H. Cormen" }, { name: "Charles E. Leiserson" }],
    publish_date: "2009",
    publishers: [{ name: "MIT Press" }],
  },
};
const PUBMED = {
  result: {
    uids: ["33599681"],
    33599681: { title: "Use of deep learning to guide novices in echocardiography.", pubdate: "2021 Jun 1", fulljournalname: "JAMA cardiology", authors: [{ name: "Narang A" }], articleids: [{ idtype: "doi", value: "10.1001/jamacardio.2021.0185" }] },
  },
};

// An invented article (no real paper): its publisher's page, and the same text printed as a
// two-column PDF in the app (see `printArticle`).
const words = (seed, n) => {
  const pool = "river market town trade boat valley archive record stall ledger harbour canal ferry bridge mill grain wool salt toll guild charter fair season cargo barge quay merchant route map distance soil climate railway port village county".split(" ");
  return Array.from({ length: n }, (_, i) => pool[(seed * 7 + i * 3 + ((i * i) % 5)) % pool.length]).join(" ");
};
const para = (seed) => `${seed % 2 ? "Towns" : "Markets"} ${words(seed, 34)} studied ${seed}.`;
const ARTICLE = {
  title: "Rivers and the growth of market towns",
  authors: ["Ada Example", "Ben Sample"],
  abstract: "We ask whether river access explains the size of historical market towns, using archival records from twelve valleys and moraine fields.",
  sections: [
    ["1. Introduction", [para(1), para(2)]],
    ["2. Data and methods", [para(3), para(4), para(5)]],
    ["3. Results", [para(6), para(7)]],
    ["4. Discussion", [para(8), para(9)]],
  ],
  figure: "Figure 1. Market towns and navigable rivers in the twelve valleys studied.",
  references: [
    "Abbott, C. (1990). Boats and barter in early river trade. Journal of Old Markets 12, 1-20.",
    "Bell, D., and Cole, E. (2001). Water, soil and the size of towns. Rural History Review 4, 33-51.",
    "Dunn, F. (2015). Railways and the decline of river ports. Transport Past 9, 100-118.",
    "Evans, G. (2019). Mapping navigable rivers from historical charts. Cartography Quarterly 30, 5-22.",
  ],
};
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const publisherPage = (doi) => `<!doctype html><html><head><title>${ARTICLE.title} | Journal of Examples</title>
<meta name="citation_title" content="${ARTICLE.title}"><meta name="citation_doi" content="${doi}">
${ARTICLE.authors.map((a) => `<meta name="citation_author" content="${a}">`).join("")}
<meta name="citation_abstract" content="${ARTICLE.abstract}"></head>
<body style="font:15px system-ui;margin:0"><nav style="padding:8px 24px;background:#eef"><a href="/">Journal of Examples</a> · <a href="/about">About</a></nav>
<main style="padding:16px 24px;max-width:760px"><div style="height:1500px;background:linear-gradient(#f4f4f6,#fff)">Journal home · Issue 12 · Rivers</div><div class="tools"><a class="btn" id="pdf" href="/article/rivers.pdf">Download PDF</a> · <a href="/supplement/c.pdf">Supplementary material (PDF)</a></div>
<article><h1>${ARTICLE.title}</h1><section><h2>Abstract</h2><p>${ARTICLE.abstract}</p></section>
${ARTICLE.sections.map(([h, ps], i) => `<h2>${h}</h2>${ps.map((p) => `<p>${p}</p>`).join("")}${i === 1 ? `<figure><img src="${PIXEL}" width="200" height="100" alt="map"><figcaption>${ARTICLE.figure}</figcaption></figure>` : ""}`).join("")}
<section class="references"><h2>References</h2><ol>${ARTICLE.references.map((r) => `<li>${r}</li>`).join("")}</ol></section></article></main></body></html>`;
const articlePrint = () => `<!doctype html><html><head><style>
body{font:10pt Times,serif;margin:0} h1{font-size:20pt;margin:0 0 8pt} .abs{font-size:10pt;margin:0 0 12pt}
.cols{column-count:2;column-gap:18pt} h2{font-size:13pt;margin:10pt 0 4pt} p{margin:0 0 6pt;text-align:justify}
.fig{height:90pt;background:#ccc;margin:6pt 0 2pt} .cap{font-size:9pt} ol{padding-left:14pt;font-size:9pt}
</style></head><body><h1>${ARTICLE.title}</h1><p>${ARTICLE.authors.join(", ")}</p><p class="abs">${ARTICLE.abstract}</p><div class="cols">
${ARTICLE.sections.map(([h, ps], i) => `<h2>${h.replace(".", "")}</h2>${ps.map((p) => `<p>${p}</p>`).join("")}${i === 1 ? `<div class="fig"></div><p class="cap">${ARTICLE.figure}</p>` : ""}`).join("")}
<h2>References</h2><ol>${ARTICLE.references.map((r) => `<li>${r}</li>`).join("")}</ol></div></body></html>`;
const ABSTRACT_PAGE = `<!doctype html><html><head><title>Glaciers and alpine farming</title><meta name="citation_title" content="Glaciers and alpine farming"><meta name="citation_abstract" content="Glaciers shape the moraine valleys where alpine farmers keep herds through summer."></head>
<body style="font:15px system-ui;padding:24px"><h1>Glaciers and alpine farming</h1><h2>Abstract</h2><p>Glaciers shape the moraine valleys where alpine farmers keep herds through summer, and the ice margin sets the season.</p>
<p>Access through your institution to read the full article. <a href="/action/login">Sign in</a></p></body></html>`;
const BULK_PAGE = `<!doctype html><html><head><title>Bulk publisher page</title><meta name="citation_title" content="Bulk publisher page"></head><body style="font:15px system-ui;padding:24px"><h1>Bulk publisher page</h1><h2>Abstract</h2><p>A short abstract about canals and ferries for the bulk run of Find PDFs.</p></body></html>`;

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-find-pdf-"));
  const noOpenAlex = path.join(temp, "no-openalex");
  await mkdir(noOpenAlex);
  const pdf = await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf"));
  const bert = JSON.parse(await readFile(path.join(fixtures, "openalex-search.json"), "utf8")).results[1];
  const log = [];
  let articlePdf;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    log.push(url.pathname + url.search);
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const file = url.pathname.match(/^\/files\/([a-z0-9-]+)\.pdf$/);
    if (file) {
      // Each its own file (its own hash).
      const body = Buffer.concat([pdf, Buffer.from(`\n%find-pdf-${file[1]}\n`)]);
      res.writeHead(200, { "content-type": "application/pdf", "content-length": body.length });
      return res.end(body);
    }
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    if (url.pathname === "/article/rivers.pdf" && articlePdf) {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": articlePdf.length });
      return res.end(articlePdf);
    }
    if (url.pathname === "/landing-c") return html(publisherPage("10.5555/landing-c"));
    if (url.pathname === "/landing-f") return html(ABSTRACT_PAGE);
    if (url.pathname === "/landing-g") return html(BULK_PAGE);
    if (url.pathname === "/epdf-h")
      return html(`<!doctype html><html><head><title>Reader | Journal of Examples</title><meta name="citation_title" content="A viewer page"></head><body style="margin:0;font:14px system-ui">
<div style="display:flex;gap:8px;padding:8px 12px;background:#2b2b30"><button id="dl" aria-label="Download PDF" onclick="location.href='/files/h.pdf'" style="width:28px;height:28px">&#8595;</button><button>Print</button></div>
<div id="viewer" style="height:900px;background:#55555a;color:#fff;padding:40px">Page 1 of the article</div></body></html>`);
    if (url.pathname === "/action/login") return html(`<!doctype html><html><body><h1>Sign in</h1><form><input type="password"></form></body></html>`);
    if (url.pathname === "/works/doi:10.18653/v1/n19-1423") return json(200, JSON.parse(JSON.stringify(bert).replace(/https:\/\/aclanthology\.org\/[^"]+/g, `${base}/files/bert.pdf`)));
    if (url.pathname.startsWith("/works")) return json(404, { error: "not found" });
    if (url.pathname === "/v2/10.5555/unpaywall-b") return json(200, { best_oa_location: { url_for_pdf: `${base}/files/b.pdf`, url_for_landing_page: `${base}/landing-b` } });
    if (url.pathname.startsWith("/v2/")) return json(404, { error: "not found" });
    if (url.pathname === "/api/books") return json(200, url.searchParams.get("bibkeys") === "ISBN:9780262033848" ? BOOK : {});
    if (url.pathname === "/api/query") {
      res.writeHead(200, { "content-type": "application/atom+xml" });
      return res.end(url.searchParams.get("id_list") === "1706.03762" ? ATOM : `<feed xmlns="http://www.w3.org/2005/Atom"></feed>`);
    }
    if (url.pathname.startsWith("/entrez")) return json(200, url.searchParams.get("id") === "33599681" ? PUBMED : { result: {} });
    json(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mock = `http://127.0.0.1:${server.address().port}`;

  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    // The mock journal's pages (journal.example) come from the local server.
    args: [...(process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")]), `--host-resolver-rules=MAP journal.example 127.0.0.1:${server.address().port}`],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_BROWSER_SMOKE: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_OPENALEX_FIXTURES: noOpenAlex,
      KEY_WEB_OPENALEX_URL: mock,
      KEY_WEB_UNPAYWALL_URL: mock,
      KEY_WEB_OPENLIBRARY_URL: mock,
      KEY_WEB_ARXIV_URL: mock,
      KEY_WEB_NCBI_URL: mock,
      KEY_WEB_CROSSREF_URL: mock,
    },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  const report = {};
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 940));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    await page.evaluate(() => window.key.setAppSettings({ openalexMailto: "smoke@example.org" }));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const create = (source) => call("store_create", { source: { kind: "reference", itemType: "article", indexStatus: "skipped", ...source } });
    const hasFile = async (id) => !!(await call("store_source", { id }))?.filePath;
    const tabs = () => page.evaluate(() => window.key.tabs());
    const activeView = async () => {
      const t = await tabs();
      return t.tabs.find((x) => x.id === t.activeTabId)?.views[0];
    };

    const a = await create({ title: "Stored open access link", doi: "10.5555/oa-a", oaUrl: `${mock}/files/a.pdf` });
    const b = await create({ title: "Found through Unpaywall", doi: "10.5555/unpaywall-b" });
    const c = await create({ title: "Only on the publisher's page", doi: "10.5555/landing-c", url: "http://journal.example/landing-c" });
    // The article's PDF: its text printed in two columns by the app itself.
    articlePdf = Buffer.from(
      await app.evaluate(async ({ BrowserWindow }, html) => {
        const w = new BrowserWindow({ show: false, width: 800, height: 1000 });
        try {
          await w.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString("base64")}`);
          return (await w.webContents.printToPDF({ pageSize: "A4", margins: { marginType: "default" } })).toString("base64");
        } finally {
          w.destroy();
        }
      }, articlePrint()),
      "base64",
    );

    // 1. The source page: No PDF yet · Find PDF, then the PDF from the stored link.
    const openSource = (id) => page.evaluate(({ ws, id }) => window.key.tabAction("open-source-page", { workspaceId: ws, sourceId: id }), { ws: ws.id, id });
    await openSource(a.id);
    const card = page.locator(".kx-find-pdf").last();
    await card.waitFor();
    await shot(page, "source-no-pdf-light");
    await card.getByRole("button", { name: "Find PDF" }).click();
    await until(() => hasFile(a.id), "the stored open-access PDF attached");
    assert.ok(log.includes("/files/a.pdf"));
    report.storedLink = true;

    // 2. Unpaywall by DOI, asked with the contact email.
    await openSource(b.id);
    await page.locator(".kx-find-pdf").last().getByRole("button", { name: "Find PDF" }).click();
    await until(() => hasFile(b.id), "the Unpaywall PDF attached");
    assert.ok(log.some((l) => l.startsWith("/v2/10.5555/unpaywall-b?email=smoke%40example.org")), "Unpaywall asked with the contact email");
    report.unpaywall = true;

    // 3. Nothing open: the publisher's page opens in the browser; its PDF attaches to the source.
    await openSource(c.id);
    const cCard = page.locator(".kx-find-pdf").last();
    await cCard.getByRole("button", { name: "Find PDF" }).click();
    const landing = await until(async () => app.windows().find((p) => p.url() === "http://journal.example/landing-c"), "the landing page in the browser");
    await landing.waitForSelector("#pdf");
    // The banner's nudge: click the page's own PDF link, which Key points at on the page.
    const banner = page.locator(".kx-find-pdf-banner", { hasText: "Only on the publisher" });
    await banner.getByRole("button", { name: "Show me" }).waitFor();
    assert.match(await banner.textContent(), /Click the highlighted PDF link on this page/);
    const pointed = () => landing.evaluate(() => !!document.querySelector("[data-key-pdf-pointer]"));
    await until(pointed, "the halo on the page's PDF link");
    const inView = () => landing.evaluate(() => { const r = document.querySelector("#pdf").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
    // Off screen at first (below the fold) it is scrolled to; "Show me" brings it back.
    await until(inView, "the PDF link scrolled into view");
    await landing.screenshot({ path: path.join(temp, "page-pointer-light.png") });
    await landing.evaluate(() => scrollTo(0, 0));
    await wait(200);
    assert.equal(await inView(), false, "the link is below the fold");
    await landing.screenshot({ path: path.join(temp, "page-above-fold-light.png") });
    await banner.getByRole("button", { name: "Show me" }).click();
    await until(inView, "Show me scrolled to the PDF link");
    await until(async () => (await call("find_pdf_page", { sourceId: c.id })).kept, "the page's snapshot kept for the attempt");
    await wait(300);
    await shot(page, "banner-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await wait(300);
    await shot(page, "banner-dark");
    await page.emulateMedia({ colorScheme: "light" });
    // The person clicks the page's own link: the PDF attaches to this source by itself.
    await landing.click("#pdf");
    await until(async () => !(await pointed()), "the halo gone once the link is clicked");
    await until(() => hasFile(c.id), "the PDF from the page attached to the source");
    const attached = await call("store_source", { id: c.id });
    assert.equal(attached.kind, "pdf");
    // The PDF opens beside the page; back on the page, the banner confirms.
    await page.getByRole("tab", { name: /Rivers and the/ }).first().click().catch(() => {});
    await banner.locator("text=The PDF is saved to").waitFor({ timeout: 30000 });
    await shot(page, "banner-attached-light");
    assert.equal((await call("find_pdf_page", { sourceId: c.id })).kept, false, "the temp snapshot is gone");
    const total = (await call("store_sources", { scope: "all", limit: 100 })).items.length;
    // The page labelled the PDF's structure once it was analysed.
    const alignment = await until(async () => call("store_structure_alignment", { id: c.id }), "the page aligned to the PDF's structure", 180000);
    report.alignment = { accepted: alignment.accepted, confidence: alignment.confidence, headings: alignment.report?.headings, captions: alignment.report?.captions, references: alignment.report?.references };
    assert.ok(alignment.accepted, JSON.stringify(alignment.report));
    assert.ok(alignment.report.headings.matched >= 3, JSON.stringify(alignment.report.headings));
    const reading = await until(async () => {
      const r = await call("store_reflow_document", { hash: attached.fileHash });
      return r.status === "ready" && r;
    }, "reading mode of the PDF");
    const outline = reading.document.outline.map((o) => o.text);
    assert.ok(outline.some((t) => /Data and methods/.test(t)), JSON.stringify(outline));
    assert.equal((await call("store_sources", { scope: "all", limit: 100 })).items.length, total, "no new source");
    report.browserFallback = true;

    // 3b. A page with no PDF (an abstract behind a sign-in): Sign in is offered, the page kept,
    // and the source page saves it as the full text.
    const f = await create({ title: "Glaciers and alpine farming", url: "http://journal.example/landing-f" });
    await openSource(f.id);
    await page.locator(".kx-find-pdf").last().getByRole("button", { name: "Find PDF" }).click();
    const fBanner = page.locator(".kx-find-pdf-banner", { hasText: "Glaciers" });
    await fBanner.getByRole("button", { name: "Sign in" }).waitFor();
    assert.match(await fBanner.textContent(), /Look for a PDF or Download button on this page/);
    // One primary action (the likely next step); the rest wait in More.
    assert.equal(await fBanner.locator(".kx-button-primary").count(), 1);
    assert.equal(await fBanner.getByRole("button", { name: "Show me" }).count(), 0);
    await fBanner.getByRole("button", { name: "More" }).waitFor();
    await until(async () => (await call("find_pdf_page", { sourceId: f.id })).kept, "the abstract page kept");
    await shot(page, "banner-no-pdf-light");
    await openSource(f.id);
    const kept = page.locator(".kx-kept-page").last();
    await kept.waitFor();
    assert.match(await kept.textContent(), /only the abstract/);
    await shot(page, "source-kept-page-light");
    await kept.getByRole("button", { name: "Save this page as the full text" }).click();
    await until(async () => (await call("store_source", { id: f.id }))?.kind === "web", "the page saved as the source's full text");
    const found = await until(async () => {
      const r = await call("store_search", { text: "moraine", mode: "keyword", limit: 10 });
      return r.hits?.some((h) => (h.source?.id ?? h.sourceId ?? h.id) === f.id) && r;
    }, "the saved page found by search", 60000);
    assert.ok(found);
    assert.equal((await call("find_pdf_page", { sourceId: f.id })).kept, false, "the kept copy became the full text");
    // A PDF comes too (Find PDF still looks for one beside the saved page): both full texts, the PDF primary.
    await call("store_update", { id: f.id, patch: { oaUrl: `${mock}/files/f.pdf` } });
    await openSource(f.id);
    const fCard = page.locator(".kx-find-pdf").last();
    assert.match(await fCard.textContent(), /saved page is the full text/);
    await fCard.getByRole("button", { name: "Find PDF" }).click();
    await until(async () => (await call("store_source", { id: f.id }))?.kind === "pdf", "the PDF found beside the saved page");
    const texts = await call("store_full_texts", { id: f.id });
    assert.deepEqual(texts.map((t) => [t.kind, t.primary]), [["pdf", true], ["web", false]]);
    await openSource(f.id);
    const toggle = page.locator(".key-content-pane:not([hidden]) .kx-page-details-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const list = page.locator(".key-content-pane:not([hidden]) .kx-full-texts");
    await list.waitFor();
    await list.scrollIntoViewIfNeeded();
    await shot(page, "source-full-texts-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await wait(300);
    await shot(page, "source-full-texts-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await list.getByRole("button", { name: "Make primary" }).click();
    await until(async () => (await call("store_source", { id: f.id }))?.kind === "web", "the saved page primary again");
    report.savedPage = true;

    // 3c. A PDF viewer page: its Download button (no address, a script) is pointed at.
    const h = await create({ title: "Read in the journal's viewer" });
    await page.evaluate(({ ws, id }) => window.key.tabAction("open-url", { url: "http://journal.example/epdf-h", pdfFor: { workspaceId: ws, sourceId: id, title: "Read in the journal's viewer" } }), { ws: ws.id, id: h.id });
    const viewer = await until(async () => app.windows().find((p) => p.url() === "http://journal.example/epdf-h"), "the viewer page");
    await until(() => viewer.evaluate(() => !!document.querySelector("[data-key-pdf-pointer]")), "the halo on the viewer's Download button");
    await page.locator(".kx-find-pdf-banner", { hasText: "Read in the journal" }).getByRole("button", { name: "Show me" }).waitFor();
    await viewer.screenshot({ path: path.join(temp, "viewer-pointer-light.png") });
    await viewer.click("#dl");
    await until(() => hasFile(h.id), "the viewer's PDF attached to its source");
    report.viewer = true;

    // 4. Bulk Find PDFs from the library: one found, one with nothing to be had.
    const d = await create({ title: "Bulk with a link", oaUrl: `${mock}/files/d.pdf` });
    const e = await create({ title: "Bulk without any copy", doi: "10.5555/nothing-e" });
    const g = await create({ title: "Bulk publisher page", url: "http://journal.example/landing-g" });
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.getByRole("heading", { name: "All sources", exact: true }).waitFor();
    await page.locator(".kx-row", { hasText: "Bulk with a link" }).click();
    await page.locator(".kx-row", { hasText: "Bulk without any copy" }).click({ modifiers: ["Meta"] });
    await page.locator(".kx-row", { hasText: "Bulk publisher page" }).click({ modifiers: ["Meta"] });
    const bulk = page.locator(".kx-selection");
    await bulk.waitFor();
    await bulk.getByRole("button", { name: /^Find PDFs/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".kx-toast")].some((t) => t.textContent.includes("Found 1 of 3 PDFs; 2 on the publisher’s page")), undefined, { timeout: 30000 });
    await bulk.locator(".kx-selection-notice", { hasText: "Found 1 PDF for 3 sources" }).waitFor();
    // No tabs opened; the pages it ended on are listed, each to open or to save.
    const rows = bulk.locator(".kx-find-pdf-results");
    await rows.waitFor();
    assert.match(await rows.locator("header").textContent(), /2 sources landed on the publisher’s page/);
    await shot(page, "bulk-find-pdfs-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await wait(300);
    await shot(page, "bulk-find-pdfs-dark");
    await page.emulateMedia({ colorScheme: "light" });
    assert.ok(await hasFile(d.id));
    assert.ok(!(await hasFile(e.id)));
    const gRow = rows.locator("li", { hasText: "Bulk publisher page" });
    await gRow.getByRole("button", { name: "Save page as full text" }).click();
    await until(async () => (await call("store_source", { id: g.id }))?.kind === "web", "the bulk row's page saved as its full text", 60000);
    await rows.locator("li", { hasText: "Bulk publisher page" }).waitFor({ state: "detached" });
    // Open page: the tab shows the banner for that source.
    await rows.locator("li", { hasText: "Bulk without any copy" }).getByRole("button", { name: "Open page" }).click();
    await page.locator(".kx-find-pdf-banner", { hasText: "Bulk without any copy" }).waitFor();
    await page.getByRole("tab", { name: /^Sources/ }).first().click();
    report.bulk = true;

    // 5. Add by identifier: many at once, each with its outcome.
    await call("store_create", { source: { kind: "reference", itemType: "article", title: "Mine already", doi: "10.1234/mine" } });
    await page.locator(".key-content-pane:not([hidden]) summary[aria-label='More ways to add']").click();
    await page.getByRole("button", { name: /^Add by identifier/ }).click();
    const sheet = page.locator(".kx-identifier-sheet");
    await sheet.waitFor();
    await sheet.getByRole("textbox", { name: "Identifiers" }).fill("10.18653/v1/N19-1423\nISBN 0-262-03384-4, arXiv:1706.03762\nPMID 33599681\n10.1234/mine\n10.9999/nothing\nhello world");
    await sheet.locator(".kx-identifier-meta [role=status]", { hasText: "2 DOIs" }).waitFor().catch(() => {});
    await shot(page, "identifier-pasted-light");
    await sheet.getByRole("button", { name: /^Add \d+$/ }).click();
    const results = sheet.locator(".kx-identifier-results li");
    await results.first().waitFor({ timeout: 60000 });
    const statuses = await results.evaluateAll((rows) => rows.map((r) => r.dataset.status));
    assert.deepEqual(statuses, ["added", "added", "added", "added", "exists", "notFound", "invalid"], JSON.stringify(await results.allInnerTexts()));
    // The DOI and the ISBN are counted once though written differently.
    assert.equal(await sheet.locator(".kx-identifier-tally").textContent(), "4 added · 1 already in library · 2 not added");
    await shot(page, "identifier-results-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await wait(300);
    await shot(page, "identifier-results-dark");
    await page.emulateMedia({ colorScheme: "light" });
    const all = (await call("store_sources", { scope: "all", limit: 50 })).items;
    const book = all.find((s) => s.isbn === "9780262033848");
    assert.equal(book?.itemType, "book");
    assert.equal(book?.publisher, "MIT Press");
    assert.ok(all.find((s) => s.arxivId === "1706.03762" && s.title === "Attention Is All You Need"));
    assert.ok(all.find((s) => s.pmid === "33599681"));
    const bertSource = all.find((s) => (s.doi ?? "").includes("n19-1423"));
    await until(() => hasFile(bertSource.id), "Find PDF ran for the added DOI");
    await sheet.getByRole("button", { name: "Done" }).click();
    report.identifiers = statuses;

    // 6. A DOI pasted into the library search offers to add it.
    const search = page.getByRole("combobox").first();
    await search.click();
    await search.fill("https://doi.org/10.5555/pasted-doi");
    const offer = page.locator(".kx-suggest-item", { hasText: "to library" });
    await offer.waitFor();
    assert.match(await offer.textContent(), /Add DOI 10\.5555\/pasted-doi to library/);
    await shot(page, "search-add-identifier-light");
    await offer.click();
    await page.locator(".kx-identifier-sheet textarea").waitFor();
    assert.equal(await page.locator(".kx-identifier-sheet textarea").inputValue(), "10.5555/pasted-doi");
    report.searchOffer = true;
    await page.locator(".kx-identifier-sheet").getByRole("button", { name: "Cancel" }).click();
    await page.locator(".kx-identifier-sheet").waitFor({ state: "detached" });

    // 7. Workspace Settings: the automatic Find PDF switch (off by default, per workspace).
    const [workspace] = await page.evaluate(() => window.key.workspaces());
    const own = await page.evaluate((id) => window.key.invoke("store_workspace_settings", {}, id), workspace.id);
    assert.equal(own.effective.findPdfOnAdd, false);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: { window: "workspace", section: "indexing" } })));
    const findSwitch = page.getByRole("dialog", { name: "Workspace Settings" }).getByRole("checkbox", { name: "Find PDFs automatically when adding" });
    await findSwitch.waitFor();
    assert.equal(await findSwitch.isChecked(), false);
    await page.keyboard.press("Escape");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, ...report }));
  } catch (e) {
    for (const [i, p] of app.windows().entries()) await p.screenshot({ path: path.join(temp, `failure-${i}.png`) }).catch(() => {});
    console.error("Artifacts", temp, "requests", JSON.stringify(log));
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
