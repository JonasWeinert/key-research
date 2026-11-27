// Run serially: native windows and focus are shared with other GUI checks.
// Database search against the sample engine (KEY_DB_SEARCH_MOCK=1, no network): the Databases
// pill hands the search tab's words to the Database search tab; a two-concept query is built
// from blocks; each database's translation and counts appear; it runs on two databases; the
// results are de-duplicated (fewer than per database); selected works go to the library (to a
// collection, tagged) and to the Inbox; the search is saved and run again ("new since last
// run"); the report is exported. Nested Boolean logic is built with the blocks (operators are
// buttons) and typed in the text mode, which round-trips with the blocks and points at a
// problem where it is. A result row never shows Add to Inbox twice. Then, against the host's
// real engine and the recorded fixtures (connectors/fixtures, as smoke-database-search-host):
// a database that searches one term at a time gets a decomposed plan, the run reconstructs the
// full search on the records, and the exported search strategy (Markdown and JSON) writes out
// the queries, counts and reconstruction. Screenshots in light and dark.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, readFile, readdir } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-db-search-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"), KEY_DB_SEARCH_MOCK: process.env.KEY_DB_SEARCH_MOCK ?? "1" },
  });
  // Sheets and the tab pill animate in: shoot once they have settled.
  const shot = async (page, name) => (await page.waitForTimeout(450), page.screenshot({ path: path.join(temp, `${name}.png`) }));
  const downloads = path.join(temp, "downloads");
  try {
    await app.evaluate(({ session }, dir) => {
      session.defaultSession.on("will-download", (_e, item) => item.setSavePath(`${dir}/${item.getFilename()}`));
    }, downloads);
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const reviews = await call("store_collection_create", { name: "Review" });
    await call("store_create", { source: { kind: "reference", itemType: "article", title: "A tagged work", tags: ["mindfulness-based stress reduction"], collections: [] } });

    // The search tab's Databases pill opens Database search with the typed words.
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "search", workspaceId: id }), ws.id);
    const search = page.getByRole("region", { name: "Search", exact: true });
    await search.getByRole("combobox").first().fill("mindfulness");
    await page.keyboard.press("Escape");
    await search.getByRole("button", { name: "Databases" }).click();
    const db = page.getByRole("region", { name: "Database search" });
    await db.waitFor();
    await db.getByText("Sample data", { exact: true }).waitFor();
    const concepts = db.locator(".kx-db-concept");
    await concepts.first().locator(".kx-db-chip", { hasText: "mindfulness" }).waitFor();

    // Two concepts: a synonym in the first (from the library's tags), two terms in a second.
    const firstInput = concepts.first().getByRole("textbox", { name: /Add a term/ });
    await firstInput.fill("mindfulness-based");
    await page.locator(".kx-db-suggest .kx-suggest-item", { hasText: "mindfulness-based stress reduction" }).waitFor();
    await page.keyboard.press("Escape");
    await firstInput.fill("meditat*");
    await firstInput.press("Enter");
    await db.getByRole("button", { name: "Add concept" }).click();
    const second = concepts.nth(1);
    await second.getByRole("textbox", { name: "Name of concept 2" }).fill("Outcome");
    const secondInput = second.getByRole("textbox", { name: /Add a term/ });
    await secondInput.fill("anxiety");
    await secondInput.press("Enter");
    await secondInput.fill("depress*");
    await secondInput.press("Enter");
    // A pasted list adds one term per line.
    await secondInput.focus();
    await page.evaluate(() => {
      const input = document.activeElement;
      const data = new DataTransfer();
      data.setData("text/plain", "stress\nworry");
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await second.locator(".kx-db-chip", { hasText: "worry" }).waitFor();
    assert.equal(await second.locator(".kx-db-chip").count(), 4);
    // The term editor: a phrase field and truncation.
    await concepts.first().locator(".kx-db-chip", { hasText: "mindfulness" }).click();
    const editor = page.getByRole("dialog", { name: "Edit mindfulness" });
    await editor.getByLabel("Search in").selectOption("title");
    await page.keyboard.press("Escape");
    await concepts.first().locator(".kx-db-chip", { hasText: "mindfulness" }).locator(".kx-db-chip-field", { hasText: "Ti" }).waitFor();
    // Keyboard: ⌥→ moves a term to the next concept, ⌥← back.
    const worry = second.locator(".kx-db-chip", { hasText: "worry" });
    await worry.focus();
    await page.keyboard.press("Alt+ArrowLeft");
    await concepts.first().locator(".kx-db-chip", { hasText: "worry" }).waitFor();
    await page.keyboard.press("Alt+ArrowRight");
    await second.locator(".kx-db-chip", { hasText: "worry" }).waitFor();
    // Exclude a term and limit the years.
    await db.getByRole("button", { name: "Leave out…" }).click();
    await db.getByRole("textbox", { name: "Add a term to leave out" }).fill("protocol");
    await db.getByRole("textbox", { name: "Add a term to leave out" }).press("Enter");
    await db.getByRole("textbox", { name: "From year" }).fill("2015");
    await db.getByRole("textbox", { name: "To year" }).fill("2026");
    const sentence = await db.locator(".kx-db-sentence").textContent();
    assert.match(sentence, /\(mindfulness in the title|mindfulness/);
    assert.match(sentence, /and \(anxiety or depress\* or stress or worry\)/);
    assert.match(sentence, /but not protocol, published 2015–2026\./);

    // How each database will run it: PubMed and OpenAlex, native strings and counts.
    const pubmed = db.locator('.kx-db-how-item[data-connector="pubmed"]');
    const openalex = db.locator('.kx-db-how-item[data-connector="openalex"]');
    await pubmed.waitFor();
    await openalex.waitFor();
    await page.waitForFunction(() => /\[dp\]/.test(document.querySelector('.kx-db-how-item[data-connector="pubmed"] .kx-db-native')?.textContent ?? ""));
    assert.match(await pubmed.locator(".kx-db-native").textContent(), /mindfulness\[ti\].*meditat\*\[tiab\].*AND.*NOT protocol\[tiab\].*2015:2026\[dp\]/);
    await page.waitForFunction(() => /\d/.test(document.querySelector('.kx-db-how-item[data-connector="openalex"] .kx-db-how-count')?.textContent ?? ""));
    await pubmed.locator(".kx-db-how-concepts [data-narrowest]").waitFor();
    await concepts.first().locator(".kx-db-concept-count").waitFor();
    // An expert's own query for one database, marked and reset.
    await pubmed.getByRole("button", { name: "Edit the PubMed query" }).click();
    await pubmed.getByRole("textbox", { name: "PubMed query" }).fill("mindfulness[tiab] AND anxiety[tiab]");
    await pubmed.getByRole("button", { name: "Use this query" }).click();
    await pubmed.getByText("Customised").waitFor();
    await shot(page, "db-build-light");
    await pubmed.getByRole("button", { name: "Reset to Key's translation" }).click();
    await pubmed.getByText("Customised").waitFor({ state: "detached" });

    // The picker: groups, a key needed for Scopus, sets.
    await db.getByRole("button", { name: "Choose…" }).click();
    const picker = page.getByRole("dialog", { name: "Choose databases" });
    await picker.getByRole("region", { name: "Health & life sciences" }).waitFor();
    await picker.locator(".kx-db-option", { hasText: "Scopus" }).getByRole("button", { name: "Add key…" }).waitFor();
    await picker.locator(".kx-db-option", { hasText: "SSRN" }).getByText("Manual").waitFor();
    await shot(page, "db-picker-light");
    await picker.getByRole("button", { name: "Done" }).click();
    await picker.waitFor({ state: "detached" });

    // Run on the two databases.
    await db.getByRole("textbox", { name: "Name of this search" }).fill("Mindfulness and anxiety");
    await db.getByRole("button", { name: /^Search 2 databases/ }).click();
    const progress = db.locator(".kx-db-progress");
    await progress.waitFor();
    await page.locator('.kx-status-bar [data-status-item="db-run"]').waitFor();
    await progress.locator(".kx-db-progress-foot", { hasText: "Done." }).waitFor({ timeout: 30000 });
    const rows = db.locator(".kx-db-work-list > li.kx-source-item");
    await rows.first().waitFor();
    const dedupedCount = Number((await db.locator(".kx-db-results-count").textContent()).replace(/\D/g, ""));
    assert.ok(dedupedCount > 50, `found works (${dedupedCount})`);
    assert.ok((await rows.count()) < 60, "the list is virtualised");
    assert.ok((await db.locator(".kx-db-source-badge", { hasText: "OpenAlex" }).count()) > 0);
    const both = await page.evaluate(() => [...document.querySelectorAll(".kx-db-row-marks")].filter((m) => m.querySelectorAll(".kx-db-source-badge").length > 1).length);
    assert.ok(both > 0, "some works were found by both databases");
    await shot(page, "db-results-light");
    await db.getByRole("button", { name: "Per database" }).click();
    await page.waitForFunction((n) => Number(document.querySelector(".kx-db-results-count")?.textContent.replace(/\D/g, "")) > n, dedupedCount);
    await db.getByRole("button", { name: "Without duplicates" }).click();
    await page.waitForFunction((n) => Number(document.querySelector(".kx-db-results-count")?.textContent.replace(/\D/g, "")) === n, dedupedCount);

    // Preview, then three works to the library: into a collection, tagged with the search's name.
    await rows.first().locator(".kx-work-head").click();
    const preview = db.getByRole("complementary", { name: "Preview" });
    await preview.getByRole("heading", { name: "Where it was found" }).waitFor();
    for (let i = 0; i < 3; i++) await rows.nth(i).getByRole("checkbox").check();
    await db.getByText("3 works selected").waitFor();
    await db.getByRole("button", { name: "Add to library…" }).first().click();
    const add = page.locator(".kx-db-add-sheet");
    await add.getByLabel("Collection").selectOption(reviews.id);
    await add.locator(".kx-db-form-row", { hasText: "Tag" }).getByRole("checkbox").check();
    await add.locator(".kx-db-form-row", { hasText: "PDFs" }).getByRole("checkbox").uncheck();
    await shot(page, "db-add-light");
    await add.getByRole("button", { name: "Add 3 works" }).click();
    await add.waitFor({ state: "detached" });
    await page.getByText(/Added 3 works to the library/).waitFor();
    const sources = await call("store_sources", { collectionId: reviews.id, limit: 50 });
    const list = sources.items ?? sources.sources ?? sources;
    assert.equal(list.length, 3, "filed in the collection");
    assert.ok(list.every((s) => s.tags.includes("Mindfulness and anxiety")), "tagged with the search's name");
    await rows.nth(0).locator(".kx-work-badge", { hasText: "In library" }).waitFor();
    // A row, also opened (selected), offers Add to Inbox once.
    await rows.nth(6).locator(".kx-work-head").click();
    await page.waitForTimeout(200);
    assert.equal(await rows.nth(6).getByRole("button", { name: "Add to Inbox" }).count(), 1, "the opened row has one Add to Inbox button");
    assert.ok((await rows.nth(7).getByRole("button", { name: "Add to Inbox" }).count()) <= 1, "a closed row has at most one");

    // Two others to the Inbox.
    await rows.nth(4).getByRole("checkbox").check();
    await rows.nth(5).getByRole("checkbox").check();
    await db.getByRole("button", { name: "Add to Inbox" }).first().click();
    await page.getByText(/Added 2 works to the Inbox/).waitFor();
    // Sample runs are not on the host, so they cannot go to a review.
    assert.equal(await db.getByRole("button", { name: "Send to review…" }).count(), 0, "no Send to review for sample data");

    // The report: counts per database, exported as Markdown and CSV.
    await db.getByRole("button", { name: "Report…" }).click();
    const report = page.getByRole("dialog", { name: "Search report" });
    await report.locator(".kx-db-report-table tbody tr").nth(1).waitFor();
    assert.match(await report.locator(".kx-db-report-table").textContent(), /PubMed.*\[tiab\].*OpenAlex/s);
    await shot(page, "db-report-light");
    await report.getByRole("button", { name: "Markdown", exact: true }).click();
    await report.getByRole("button", { name: "CSV" }).click();
    await page.waitForFunction(async () => true);
    let files = [];
    for (let i = 0; i < 30 && files.length < 2; i++) {
      await page.waitForTimeout(200);
      files = await readdir(downloads).catch(() => []);
    }
    const md = files.find((f) => f.endsWith(".md"));
    assert.ok(md && files.some((f) => f.endsWith(".csv")), `report files saved (${files.join(", ")})`);
    const markdown = await readFile(path.join(downloads, md), "utf8");
    assert.match(markdown, /\| PubMed .*\| `.*\[tiab\].*` \|/);
    assert.match(markdown, /Duplicates removed: \d+/);
    await report.getByRole("button", { name: "Close" }).click();

    // Saved, then run again: the works new since the last run are marked.
    await db.getByRole("tab", { name: /Query/ }).click();
    await db.getByRole("button", { name: "Save search" }).click();
    await page.getByText("Saved “Mindfulness and anxiety”").waitFor();
    await db.getByRole("tab", { name: /Saved/ }).click();
    const saved = db.locator(".kx-db-saved-list li", { hasText: "Mindfulness and anxiety" });
    await saved.waitFor();
    await saved.getByRole("button", { name: "Run again" }).click();
    await progress.locator(".kx-db-progress-foot", { hasText: "Done." }).waitFor({ timeout: 30000 });
    await db.getByRole("tab", { name: /Saved/ }).click();
    await saved.getByRole("button", { name: "Run again" }).click();
    await progress.locator(".kx-db-progress-foot", { hasText: "Done." }).waitFor({ timeout: 30000 });
    await db.getByRole("button", { name: "New since last run" }).click();
    await rows.first().locator(".kx-db-badge", { hasText: "New" }).waitFor();
    await db.getByRole("tab", { name: /Saved/ }).click();
    await saved.locator(".kx-db-badge", { hasText: /new since last run/ }).waitFor();
    await shot(page, "db-saved-light");

    // Pasting a PubMed query reads it into blocks.
    await db.getByRole("tab", { name: /Query/ }).click();
    await concepts.first().getByRole("textbox", { name: /Add a term/ }).focus();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", '("sleep"[tiab] OR insomnia[tiab]) AND (adolescen*[tiab] OR "Adolescent"[MeSH Terms])');
      document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.getByText(/Read the pasted query as 2 blocks/).waitFor();
    await concepts.nth(1).locator(".kx-db-chip", { hasText: "Adolescent" }).locator(".kx-db-chip-field", { hasText: "MeSH" }).waitFor();

    // Nested logic with the blocks: (health OR doctor) AND ((AI OR ML) NOT regression).
    await db.getByRole("button", { name: "More" }).click();
    await page.getByRole("button", { name: "New query" }).click();
    const one = concepts.first().getByRole("textbox", { name: /Add a term/ });
    await one.fill("health,");
    await one.fill("doctor");
    await one.press("Enter");
    await db.getByRole("button", { name: "Add concept" }).click();
    const two = concepts.nth(1).getByRole("textbox", { name: /Add a term/ });
    for (const w of ["AI,", "ML,", "regression,"]) await two.fill(w);
    assert.equal(await concepts.nth(1).locator(".kx-db-chip").count(), 3, "a comma adds a term");
    // The word between ML and regression is a button: NOT brackets what comes before it.
    await concepts.nth(1).locator(".kx-db-joiner").nth(1).click();
    await page.getByRole("dialog", { name: "Operator" }).getByRole("menuitemradio", { name: /NOT/ }).click();
    await concepts.nth(1).locator(".kx-db-group").waitFor();
    await concepts.nth(1).locator('.kx-db-joiner[data-joiner="not"]').waitFor();
    assert.match(await db.locator(".kx-db-sentence").textContent(), /\(health or doctor\) and \(\(AI or ML\) but not regression\)/);
    // Each database's preview gets the nested string.
    await page.waitForFunction(() => /NOT regression/.test(document.querySelector('.kx-db-how-item[data-connector="pubmed"] .kx-db-native')?.textContent ?? ""));
    assert.match(await pubmed.locator(".kx-db-native").textContent(), /\(health\[tiab\] OR doctor\[tiab\]\) AND \(\(AI\[tiab\] OR ML\[tiab\]\) NOT regression\[tiab\]\)/);
    await shot(page, "db-nested-blocks-light");

    // The text mode shows the same search, and typing changes the blocks.
    await db.getByRole("radio", { name: "Text" }).or(db.getByRole("tab", { name: "Text" })).first().click();
    const textBox = db.getByRole("textbox", { name: "The search as text" });
    await page.waitForFunction(() => document.querySelector(".kx-db-text-input")?.value.includes("regression"));
    assert.equal(await textBox.inputValue(), "(health OR doctor) AND (AI OR ML) NOT regression", "the blocks as text");
    await textBox.fill('(nurse* OR midwife) AND (title:"hand hygiene" OR handwashing) NOT protocol');
    await concepts.first().locator(".kx-db-chip", { hasText: "midwife" }).waitFor();
    await concepts.nth(1).locator(".kx-db-chip", { hasText: "hand hygiene" }).locator(".kx-db-chip-field", { hasText: "Ti" }).waitFor();
    // A problem is named at its place, and the blocks keep the last good search.
    await textBox.fill("(nurse* OR midwife AND handwashing");
    const problem = db.locator(".kx-db-text-problem");
    await problem.waitFor();
    assert.match(await problem.textContent(), /never closed/);
    assert.equal(await problem.locator("mark").textContent(), "(");
    await concepts.first().locator(".kx-db-chip", { hasText: "midwife" }).waitFor();
    await shot(page, "db-text-problem-light");
    await textBox.fill("(nurse* OR midwife) AND handwashing");
    await problem.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelectorAll(".kx-db-concept").length === 2);

    // Dark.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(300);
    await shot(page, "db-build-dark");
    await db.getByRole("tab", { name: /Results/ }).click();
    await rows.first().waitFor();
    await shot(page, "db-results-dark");
    await db.getByRole("button", { name: "Choose…" }).waitFor({ state: "detached" }).catch(() => {});
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
  await enginePart(temp);
  console.log(`Database search smoke passed. Screenshots in ${temp}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ── Part 2: decomposed plans on the host's engine, answered from the recorded fixtures ──
async function enginePart(temp) {
  const fixtures = path.resolve(__dirname, "../../../../../connectors/fixtures");
  const exchanges = [];
  for (const dir of await readdir(fixtures)) {
    for (const file of await readdir(path.join(fixtures, dir)).catch(() => [])) {
      if (!file.endsWith(".json")) continue;
      const data = JSON.parse(await readFile(path.join(fixtures, dir, file), "utf8"));
      for (const e of data.exchanges ?? []) {
        const url = new URL(e.url);
        exchanges.push({ key: `/${url.host}${url.pathname}`, retmax0: url.searchParams.get("retmax") === "0", e });
      }
    }
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    const counting = url.searchParams.get("retmax") === "0";
    const hit = exchanges.find((x) => x.key === url.pathname && (!url.pathname.includes("esearch") || x.retmax0 === counting)) ?? exchanges.find((x) => x.key === url.pathname);
    if (!hit) return res.writeHead(404, { "content-type": "text/plain" }).end("not recorded");
    res.writeHead(hit.e.status, hit.e.headers);
    res.end(hit.e.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const downloads = path.join(temp, "engine-downloads");
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile-engine"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces-engine"), KEY_DB_SEARCH_MOCK: "0", KEY_CONNECTORS_MOCK: `http://127.0.0.1:${server.address().port}` },
  });
  const shot = async (page, name) => (await page.waitForTimeout(450), page.screenshot({ path: path.join(temp, `${name}.png`) }));
  try {
    await app.evaluate(({ session }, dir) => {
      session.defaultSession.on("will-download", (_e, item) => item.setSavePath(`${dir}/${item.getFilename()}`));
    }, downloads);
    const page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const connectors = await call("db_connectors");
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "databases", workspaceId: id }), ws.id);
    const db = page.getByRole("region", { name: "Database search" });
    await db.locator(".kx-db-concept").first().waitFor();
    // PubMed (full Boolean) and the Crossref series (one term at a time).
    await db.getByRole("button", { name: /^Choose/ }).click();
    const picker = page.getByRole("dialog", { name: "Choose databases" });
    for (const c of connectors) {
      const box = picker.locator(`.kx-db-option[data-connector="${c.id}"]`).getByRole("checkbox");
      if (["pubmed", "crossref-series"].includes(c.id)) await box.check();
      else if (await box.isChecked()) await box.uncheck();
    }
    await picker.getByRole("button", { name: "Done" }).click();
    await picker.waitFor({ state: "detached" });
    // Typed as text: nested logic with a NOT.
    await db.getByRole("radio", { name: "Text" }).or(db.getByRole("tab", { name: "Text" })).first().click();
    const textBox = db.getByRole("textbox", { name: "The search as text" });
    await textBox.fill("(vaccine OR vaccination OR immunisation) AND (hesitancy OR confidence) NOT influenza");
    await db.locator(".kx-db-concept").nth(1).locator(".kx-db-chip", { hasText: "confidence" }).waitFor();
    const series = db.locator('.kx-db-how-item[data-connector="crossref-series"]');
    const pubmed = db.locator('.kx-db-how-item[data-connector="pubmed"]');
    await series.locator(".kx-db-how-parts").waitFor();
    const parts = await series.locator(".kx-db-how-parts .kx-db-native").allTextContents();
    assert.ok(parts.length >= 2, `the series gets one query per term of a concept (${parts.join(" | ")})`);
    await series.locator(".kx-db-badge", { hasText: "Checked by Key" }).waitFor();
    await series.locator(".kx-db-plan summary").click();
    assert.match(await series.locator(".kx-db-plan").textContent(), /match the full search/);
    assert.equal(await pubmed.locator(".kx-db-how-parts").count(), 0, "PubMed runs the whole search as one query");
    assert.match(await pubmed.locator(".kx-db-native").textContent(), /\(vaccine\[tiab\] OR vaccination\[tiab\] OR immunisation\[tiab\]\) AND \(hesitancy\[tiab\] OR confidence\[tiab\]\)\) NOT influenza\[tiab\]/);
    await shot(page, "db-engine-plan-light");
    // The plan before running, as a strategy.
    const before = await call("db_strategy", { query: { expr: { type: "group", op: "and", items: [{ type: "term", text: "vaccine" }] } }, connectors: ["crossref-series"], format: "markdown" });
    assert.match(before.content, /### .*Crossref/);

    // Run, then the strategy of the run.
    await db.getByRole("textbox", { name: "Name of this search" }).fill("Vaccine hesitancy");
    await db.getByRole("button", { name: /^Search/ }).click();
    await db.locator(".kx-db-progress .kx-db-progress-foot", { hasText: /Done\.|Stopped\./ }).waitFor({ timeout: 60000 });
    const runs = await call("db_runs", { limit: 1 });
    const run = await call("db_run", { runId: runs[0].runId });
    const src = run.sources.find((s) => s.connector === "crossref-series");
    assert.ok(src.strategy.postFilter && src.chunks.length >= 2 && src.chunkRaw.length === src.chunks.length, "the run keeps each query's counts");
    assert.ok(src.raw >= src.fetched, "Key's check keeps at most what came back");

    // Send to review: with nothing selected the whole run is offered; a selection goes to the
    // review picked from the menu, which then opens beside the search.
    const rows = db.locator(".kx-db-work-list > li.kx-source-item");
    await rows.nth(1).waitFor();
    const runCount = Number((await db.locator(".kx-db-results-count").textContent()).replace(/\D/g, ""));
    const review = await call("review_create", { name: "Vaccine review", ownerName: "Smoke" });
    const dbTab = (await page.evaluate(() => window.key.tabs())).activeTabId;
    await db.getByRole("button", { name: "Send to review…" }).click();
    const sendMenu = page.getByRole("dialog", { name: "Send to review" });
    await sendMenu.getByText("Send all results to").waitFor();
    await sendMenu.getByRole("menuitem", { name: "Vaccine review" }).waitFor();
    await sendMenu.getByRole("menuitem", { name: "New review…" }).waitFor();
    await shot(page, "db-send-review-light");
    await page.keyboard.press("Escape");
    await sendMenu.waitFor({ state: "detached" });
    await rows.nth(0).getByRole("checkbox").check();
    await rows.nth(1).getByRole("checkbox").check();
    await db.getByText("2 works selected").waitFor();
    await db.getByRole("button", { name: "Send to review…" }).click();
    await sendMenu.getByText("Send 2 works to").waitFor();
    await sendMenu.getByRole("menuitem", { name: "Vaccine review" }).click();
    await page.getByText(/sent to the review/).waitFor();
    const sent = (await call("review_list")).find((r) => r.id === review.reviewId);
    assert.ok(sent.records >= 2 && sent.records < runCount, `the two works (every version of each) went to the review: ${sent.records}`);
    await page.waitForFunction((id) => window.key.tabs().then((t) => t.activeTabId !== id && t.tabs.find((x) => x.id === t.activeTabId)?.views[0]?.content?.section === "review"), dbTab);
    await page.evaluate((id) => window.key.tabAction("activate", { tabId: id }), dbTab);
    await db.waitFor();
    await db.getByRole("button", { name: "More" }).click();
    await page.getByRole("button", { name: /Copy \/ export search strategy/ }).click();
    const sheet = page.getByRole("dialog", { name: "Search strategy" });
    const text = sheet.getByLabel("The search strategy");
    await text.waitFor();
    const md = await text.textContent();
    for (const want of ["Full search: `(vaccine OR vaccination OR immunisation) AND (hesitancy OR confidence) NOT influenza`", "| 1 | `", "| 2 | `", "How Key reconstructed the full search:", "Records kept:"]) assert.ok(md.includes(want), `strategy has ${want}\n${md}`);
    await shot(page, "db-engine-strategy-light");
    await sheet.getByRole("button", { name: ".json" }).click();
    await sheet.getByRole("button", { name: ".md" }).click();
    let files = [];
    for (let i = 0; i < 30 && files.length < 2; i++) {
      await page.waitForTimeout(200);
      files = await readdir(downloads).catch(() => []);
    }
    const json = JSON.parse(await readFile(path.join(downloads, files.find((f) => f.endsWith(".json"))), "utf8"));
    assert.equal(json.format, "key-search-strategy");
    const db2 = json.databases.find((d) => d.connector === "crossref-series");
    assert.ok(db2.queries.length >= 2 && db2.queries.every((q) => q.native && typeof q.read === "number") && db2.reconstruction.length > 0, "the JSON has every query with its counts and the reconstruction");
    assert.deepEqual(json.rerun.connectors.sort(), ["crossref-series", "pubmed"]);
    assert.ok(files.some((f) => f.endsWith(".md")));
    // Dark.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await shot(page, "db-engine-strategy-dark");
    await sheet.getByRole("button", { name: "Close" }).click();
    await db.getByRole("tab", { name: /Query/ }).click();
    await series.locator(".kx-db-how-parts").waitFor();
    await shot(page, "db-engine-plan-dark");
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    server.close();
  }
}
