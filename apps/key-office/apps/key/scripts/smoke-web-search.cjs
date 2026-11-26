// Run serially: native windows and focus are shared with other GUI checks.
// Web search against a local mock of OpenAlex and Semantic Scholar (no real network): an
// ordinary search asks neither; the Web pill asks both and merges what they find; a 429
// from Semantic Scholar shows a skeleton and is retried; a provider that stays down gets a
// quiet "Couldn't reach … Retry" while the other's results stay; Load more pages on; a work
// whose DOI is in the library shows "In library"; Add to library makes a reference with its
// details and fetches the open-access PDF.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const fixtures = path.resolve(__dirname, "../../../../../crates/key-desktop-host/src/web_search/fixtures");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-web-search-"));
  const noOpenAlex = path.join(temp, "no-openalex");
  await mkdir(noOpenAlex);
  const pdf = await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf"));
  const openalexPage = JSON.parse(await readFile(path.join(fixtures, "openalex-search.json"), "utf8"));
  const s2Page = JSON.parse(await readFile(path.join(fixtures, "s2-search.json"), "utf8"));

  // The mock: every request is logged; Semantic Scholar answers 429 once per new query
  // ("rate") and is down for "outage"; OpenAlex has a second page.
  const log = [];
  const limited = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    log.push(url.pathname + url.search);
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const base = `http://127.0.0.1:${server.address().port}`;
    const local = (body) => JSON.parse(JSON.stringify(body).replace(/https:\/\/(arxiv\.org\/pdf|aclanthology\.org)\/[^"]+/g, `${base}/files/paper.pdf`));
    if (url.pathname === "/files/paper.pdf") {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length });
      return res.end(pdf);
    }
    if (url.pathname === "/works") {
      const q = url.searchParams.get("search");
      if (url.searchParams.get("cursor") !== "*")
        return json(200, {
          meta: { count: 4, next_cursor: null },
          results: [{ ...openalexPage.results[2], id: "https://openalex.org/W4000000004", doi: "https://doi.org/10.5555/page-two", display_name: `Page two about ${q}` }],
        });
      return json(200, local(openalexPage));
    }
    if (url.pathname === "/graph/v1/paper/search") {
      const q = url.searchParams.get("query");
      if (q.includes("outage")) return json(503, { message: "down" });
      if (q.includes("rate") && !limited.has(q)) {
        limited.add(q);
        return json(429, { message: "Too Many Requests" }, { "retry-after": "2" });
      }
      return json(200, local(s2Page));
    }
    json(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mock = `http://127.0.0.1:${server.address().port}`;
  const webRequests = () => log.filter((l) => !l.startsWith("/files/"));

  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      // The library's own OpenAlex lookups stay offline too.
      KEY_OPENALEX_FIXTURES: noOpenAlex,
      KEY_WEB_OPENALEX_URL: mock,
      KEY_WEB_S2_URL: mock,
    },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 940));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const theme = (value) => page.emulateMedia({ colorScheme: value });

    // BERT is already in the library (by its DOI, written differently).
    await call("store_create", { source: { kind: "reference", itemType: "article", title: "BERT (my copy)", doi: "https://doi.org/10.18653/V1/N19-1423", year: 2019 } });
    // GPT-3 by its title only (no identifier): "Possibly in library", and adding stays open.
    await call("store_create", { source: { kind: "reference", itemType: "article", title: "Language models are few-shot learners.", year: 2020, creators: [{ given: "Tom", family: "Brown" }] } });

    await page.evaluate((id) => window.key.tabAction("open-content", { section: "search", workspaceId: id }), ws.id);
    const tab = page.locator(".kx-search-page");
    await tab.waitFor();
    const field = tab.getByRole("combobox", { name: "Search everything" });
    await field.fill("attention rate");
    await field.press("Escape");
    await page.waitForTimeout(1500);
    assert.deepEqual(webRequests(), [], "an ordinary search never reaches the web");

    // The Web pill: OpenAlex answers, Semantic Scholar is limited once (skeleton), then answers.
    const pill = tab.locator('.kx-web-pill button[data-kind="web"]');
    await pill.click();
    assert.equal(await pill.getAttribute("aria-pressed"), "true");
    assert.equal(await tab.locator('.kx-kind-chips button[aria-pressed="true"]').count(), 1, "only Web is chosen");
    const web = tab.locator(".kx-web");
    await web.locator(".kx-web-skeleton[aria-label='Searching Semantic Scholar']").waitFor();
    await web.locator(".kx-web-hit", { hasText: "Highly accurate protein" }).waitFor();
    await shot(page, "web-skeleton-light");
    const attention = web.locator(".kx-web-hit", { hasText: "Attention Is All You Need" });
    await attention.locator('.kx-web-badge[data-provider="s2"]').waitFor({ timeout: 15000 });
    await web.locator(".kx-web-skeleton").waitFor({ state: "detached" });
    assert.equal(await attention.locator(".kx-web-badge").count(), 2, "found by both, shown once");
    assert.equal(await web.locator(".kx-web-hit", { hasText: "Attention" }).count(), 1);
    await web.locator(".kx-web-hit", { hasText: "Language Models are Few-Shot Learners" }).waitFor();
    const s2Calls = webRequests().filter((l) => l.startsWith("/graph/v1/paper/search"));
    assert.equal(s2Calls.length, 2, `Semantic Scholar retried once after the 429, got ${s2Calls.length}`);
    assert.ok(webRequests().some((l) => l.includes("mailto=")), "OpenAlex is asked with the polite pool");
    assert.equal(await attention.locator(".kx-web-oa").count(), 1, "open access is marked");

    // Already in the library, by DOI.
    const bert = web.locator(".kx-web-hit", { hasText: "BERT: Pre-training" });
    await bert.locator(".kx-web-in").waitFor();
    assert.equal(await bert.locator(".kx-web-in[data-possible]").count(), 0, "a DOI match is certain");
    const gpt = web.locator(".kx-web-hit", { hasText: "Language Models are Few-Shot Learners" });
    await gpt.locator(".kx-web-in[data-possible]", { hasText: "Possibly in library" }).waitFor();
    assert.equal(await gpt.locator(".kx-web-add").textContent(), "Add anyway", "a title match never blocks adding");
    await gpt.scrollIntoViewIfNeeded();
    await shot(page, "web-possibly-light");

    // The query's words are marked in each result's details, as in passages.
    assert.equal(await attention.locator(".kx-hit-title mark").first().textContent(), "Attention", "title match marked");
    assert.ok((await web.locator(".kx-web-abstract mark").count()) > 0, "abstract matches marked");

    // A click shows the work beside the results, not in a new tab; arrows step through the rows.
    const tabsBefore = await page.evaluate(async () => (await window.key.tabs()).tabs.length);
    const proteinRow = web.locator(".kx-web-hit", { hasText: "Highly accurate protein" });
    await proteinRow.locator(".kx-found-open").click();
    const preview = tab.locator(".kx-web-preview");
    await preview.waitFor();
    await preview.locator(".kx-web-preview-title", { hasText: "Highly accurate protein" }).waitFor();
    await preview.locator(".kx-web-add").waitFor();
    await preview.getByRole("button", { name: "Open page" }).waitFor();
    assert.ok(await preview.locator(".kx-web-preview-facts", { hasText: "10.1038/s41586-021-03819-2" }).count(), "the DOI is shown");
    assert.equal(await proteinRow.getAttribute("data-previewed"), "true");
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(async () => (await window.key.tabs()).tabs.length), tabsBefore, "no new tab");
    await shot(page, "web-preview-light");
    const previewedTitle = () => preview.locator(".kx-web-preview-title").textContent();
    const first = await previewedTitle();
    await tab.locator(".kx-search-page-results").focus();
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction((t) => document.querySelector(".kx-web-preview-title")?.textContent !== t, first);
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction((t) => document.querySelector(".kx-web-preview-title")?.textContent === t, first);
    await theme("dark");
    await page.waitForTimeout(300);
    await shot(page, "web-preview-dark");
    await theme("light");
    // Bert is in the library: the preview says so and opens it from there.
    await bert.locator(".kx-found-open").click();
    await preview.locator(".kx-web-in").waitFor();
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "detached" });

    // Add to library: a reference with full details, then its open-access PDF.
    await attention.locator(".kx-web-add").click();
    await attention.locator(".kx-web-in").waitFor({ timeout: 30000 });
    const alpha = web.locator(".kx-web-hit", { hasText: "Highly accurate protein" });
    await alpha.locator(".kx-web-add").click();
    await alpha.locator(".kx-web-in").waitFor();
    await shot(page, "web-added-light");
    const { items } = await call("store_sources", { scope: "all", limit: 20 });
    const added = items.find((s) => s.title === "Attention Is All You Need");
    assert.ok(added, "the work is in the library");
    assert.equal(added.openalexId, "W2963403868");
    assert.equal(added.arxivId, "1706.03762");
    assert.equal(added.year, 2017);
    assert.deepEqual(added.creators.map(({ given, family }) => [given, family]), [["Ashish", "Vaswani"], ["Noam", "Shazeer"], ["Niki", "Parmar"]]);
    for (let i = 0; i < 80; i++) {
      const s = await call("store_source", { id: added.id });
      if (s.fileHash || s.filePath) break;
      await page.waitForTimeout(250);
    }
    const withPdf = await call("store_source", { id: added.id });
    assert.ok(withPdf.fileHash || withPdf.filePath, "the open-access PDF is attached");
    assert.ok(log.includes("/files/paper.pdf"), "the PDF came from the open-access link");
    const protein = items.find((s) => s.title === "Highly accurate protein structure prediction with AlphaFold");
    assert.equal(protein?.doi, "10.1038/s41586-021-03819-2");
    assert.equal(protein?.pmid, "34265844");
    assert.equal(items.filter((s) => (s.doi ?? "").toLowerCase().includes("n19-1423")).length, 1, "nothing added twice");
    // A new search finds them in the library.
    await field.fill("attention again");
    await field.press("Escape");
    await web.locator(".kx-web-hit", { hasText: "Attention Is All You Need" }).locator(".kx-web-in").waitFor();
    await web.locator(".kx-web-hit", { hasText: "Highly accurate protein" }).locator(".kx-web-in").waitFor();

    // Load more: OpenAlex's next page joins the list.
    await web.locator(".kx-web-more").click();
    await web.locator(".kx-web-hit", { hasText: "Page two about attention again" }).waitFor();
    assert.ok(webRequests().some((l) => l.startsWith("/works") && !l.includes("cursor=*")), "asked with the cursor");

    // Filters: an author token goes to OpenAlex as a filter and is checked on Semantic
    // Scholar's results; a full-text token cannot apply to the web, so it is greyed (and kept).
    await field.fill("Vaswani");
    await tab.locator(".kx-suggest-item", { hasText: "Author contains" }).click();
    await field.fill("deep");
    await tab.locator(".kx-suggest-item", { hasText: "Full text contains" }).click();
    const authorToken = tab.locator('.kx-token[data-field="creator"]');
    const fullText = tab.locator('.kx-token[data-field="fulltext"]');
    await fullText.waitFor();
    assert.equal(await authorToken.getAttribute("data-inactive"), null, "the author applies to the web");
    assert.equal(await fullText.getAttribute("data-inactive"), "true", "full text is not for the web");
    assert.match(await fullText.getAttribute("title"), /Not available for web search/);
    await page.waitForFunction(() => document.querySelectorAll(".kx-web-hit").length > 0 && !document.querySelector(".kx-web-skeleton"));
    await page.waitForTimeout(600);
    const filtered = webRequests().filter((l) => l.startsWith("/works") && l.includes("filter="));
    assert.ok(filtered.some((l) => decodeURIComponent(l).includes("raw_author_name.search:Vaswani")), `OpenAlex asked with the author filter: ${filtered}`);
    assert.ok(filtered.every((l) => !new URL(l, "http://x").searchParams.has("search")), "filters alone need no words");
    const s2Filtered = webRequests().filter((l) => l.startsWith("/graph/v1/paper/search") && l.includes("Vaswani"));
    assert.ok(s2Filtered.length, "Semantic Scholar searched by the author's name");
    assert.ok((await web.locator(".kx-web-hit .kx-hit-meta mark", { hasText: "Vaswani" }).count()) > 0, "the author filter is marked in results");
    await shot(page, "web-filters-light");
    await theme("dark");
    await page.waitForTimeout(300);
    await shot(page, "web-filters-dark");
    await theme("light");
    // Back to the workspace's results: every token applies again.
    await pill.click();
    await page.waitForFunction(() => !document.querySelector(".kx-token[data-inactive]"));
    await pill.click();
    await tab.locator(".kx-search-clear").click();
    assert.equal(await tab.locator(".kx-token").count(), 0);

    // The Web pill is remembered for the workspace.
    assert.equal(await page.evaluate((id) => localStorage.getItem(`key.search.web:${id}`), ws.id), "only");
    await page.reload();
    await tab.waitFor();
    assert.equal(await pill.getAttribute("aria-pressed"), "true", "still on after a reload");

    // Semantic Scholar stays down: OpenAlex's results stay, with a quiet note and Retry.
    await field.fill("outage");
    await field.press("Escape");
    await web.locator(".kx-web-hit", { hasText: "Highly accurate protein" }).waitFor();
    const note = web.locator('.kx-web-note[data-provider="s2"]');
    await note.waitFor({ timeout: 20000 });
    assert.match(await note.textContent(), /Couldn't reach Semantic Scholar/);
    await shot(page, "web-error-light");
    const before = webRequests().length;
    await note.getByRole("button", { name: "Retry" }).click();
    await web.locator(".kx-web-skeleton[aria-label='Searching Semantic Scholar']").waitFor();
    await note.waitFor({ timeout: 20000 });
    assert.ok(webRequests().length > before, "Retry asks again");

    // Dark.
    await theme("dark");
    await page.waitForTimeout(300);
    await shot(page, "web-error-dark");
    await field.fill("attention rate dark");
    await field.press("Escape");
    await web.locator(".kx-web-skeleton[aria-label='Searching Semantic Scholar']").waitFor();
    await shot(page, "web-skeleton-dark");
    await web.locator(".kx-web-hit", { hasText: "Attention Is All You Need" }).locator('.kx-web-badge[data-provider="s2"]').waitFor({ timeout: 15000 });
    await shot(page, "web-results-dark");
    await theme("light");

    // Settings: Semantic Scholar turned off is no longer asked.
    await page.locator(".key-sidebar").getByText("Settings", { exact: true }).click();
    const settings = page.locator(".kx-settings");
    await settings.getByRole("button", { name: "Web & browser" }).click();
    const s2Switch = settings.getByRole("checkbox", { name: "Search Semantic Scholar" });
    await s2Switch.scrollIntoViewIfNeeded();
    await s2Switch.waitFor();
    // Keys live under Services & API keys now, not next to the switch.
    assert.equal(await settings.getByRole("textbox", { name: "Semantic Scholar API key" }).count(), 0);
    await shot(page, "settings-web-light");
    await s2Switch.click();
    await page.waitForFunction(async () => (await window.key.appSettings()).settings.webProviders?.s2?.enabled === false);
    await settings.getByRole("button", { name: "Close settings" }).click();
    await pill.click();
    await pill.click();
    const s2Before = webRequests().filter((l) => l.startsWith("/graph")).length;
    await field.fill("only openalex now");
    await field.press("Escape");
    await web.locator(".kx-web-hit", { hasText: "Highly accurate protein" }).waitFor();
    await page.waitForTimeout(800);
    assert.equal(webRequests().filter((l) => l.startsWith("/graph")).length, s2Before, "a provider turned off is not asked");
    assert.equal(await web.locator(".kx-web-source").count(), 1);

    // Off again: back to the workspace's own results, and no more requests.
    await pill.click();
    const count = webRequests().length;
    await field.fill("attention after");
    await field.press("Escape");
    await page.waitForTimeout(1200);
    assert.equal(webRequests().length, count, "no web requests once the pill is off");
    assert.equal(await tab.locator(".kx-web").count(), 0);

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, noNetworkByDefault: true, merged: true, retried429: true, inLibrary: true, added: true, pdf: true, loadMore: true, providerDown: true }));
  } catch (e) {
    await app.windows()[0]?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
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
