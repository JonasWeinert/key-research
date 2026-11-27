// Run serially: native windows and focus are shared with other GUI checks.
// Find PDF and Add by identifier against a local mock of OpenAlex, Unpaywall, Open Library,
// arXiv and PubMed (no real network):
//   - a reference with a stored open-access link gets its PDF from the source page's Find PDF;
//   - one with only a DOI gets it through Unpaywall (with the contact email from Settings);
//   - one with no copy to be had opens its landing page in the in-app browser, and the PDF
//     opened there is attached to it ("Attach to source");
//   - the library's bulk Find PDFs reports what it found;
//   - Add by identifier takes a pasted list (DOI, ISBN, arXiv, PMID, one already in the
//     library, one unknown, one not an identifier) and lists what became of each;
//   - a DOI pasted into the library search offers "Add … to library".
const { _electron: electron } = require("playwright-core");
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

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-find-pdf-"));
  const noOpenAlex = path.join(temp, "no-openalex");
  await mkdir(noOpenAlex);
  const pdf = await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf"));
  const bert = JSON.parse(await readFile(path.join(fixtures, "openalex-search.json"), "utf8")).results[1];
  const log = [];
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
    if (url.pathname === "/landing-c") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><html><head><title>Publisher page</title></head><body style="font:15px system-ui;padding:24px"><h1>A paywalled article</h1><p><a id="pdf" href="/files/c.pdf">Download PDF</a></p></body></html>`);
    }
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
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
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
    const c = await create({ title: "Only on the publisher's page", doi: "10.5555/landing-c", url: `${mock}/landing-c` });

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
    const landing = await until(async () => app.windows().find((p) => p.url() === `${mock}/landing-c`), "the landing page in the browser");
    await cCard.locator("span[role=status]", { hasText: "publisher’s page is open" }).waitFor().catch(() => {});
    await landing.waitForSelector("#pdf");
    await landing.click("#pdf");
    const reader = await until(async () => {
      for (const p of app.windows().filter((p) => p.url().endsWith("/pdf.html"))) {
        const info = await p.evaluate(() => window.key.readerReady?.()).catch(() => undefined);
        if (info?.web?.url?.endsWith("/files/c.pdf")) return { p, info };
      }
    }, "the PDF from the publisher's page");
    assert.equal(reader.info.web.attachTo, "Only on the publisher's page", "the reader knows which source it is for");
    const attach = reader.p.locator(".key-web-pdf-action", { hasText: "Attach to source" });
    await attach.waitFor();
    await reader.p.screenshot({ path: path.join(temp, "attach-to-source.png") });
    await attach.click();
    await until(() => hasFile(c.id), "the browser's PDF attached to the source");
    await until(async () => (await activeView())?.id?.startsWith(`pdf:${ws.id}:`), "the library's reader of it");
    report.browserFallback = true;

    // 4. Bulk Find PDFs from the library: one found, one with nothing to be had.
    const d = await create({ title: "Bulk with a link", oaUrl: `${mock}/files/d.pdf` });
    const e = await create({ title: "Bulk without any copy", doi: "10.5555/nothing-e" });
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.getByRole("heading", { name: "All sources", exact: true }).waitFor();
    await page.locator(".kx-row", { hasText: "Bulk with a link" }).click();
    await page.locator(".kx-row", { hasText: "Bulk without any copy" }).click({ modifiers: ["Meta"] });
    const bulk = page.locator(".kx-selection");
    await bulk.waitFor();
    await bulk.getByRole("button", { name: /^Find PDFs/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".kx-toast")].some((t) => t.textContent.includes("Found 1 of 2 PDFs")), undefined, { timeout: 30000 });
    await bulk.locator(".kx-selection-notice", { hasText: "Found 1 PDF for 2 sources" }).waitFor();
    await shot(page, "bulk-find-pdfs-light");
    assert.ok(await hasFile(d.id));
    assert.ok(!(await hasFile(e.id)));
    report.bulk = true;

    // 5. Add by identifier: many at once, each with its outcome.
    await call("store_create", { source: { kind: "reference", itemType: "article", title: "Mine already", doi: "10.1234/mine" } });
    await page.locator("summary[aria-label='More ways to add']").click();
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
