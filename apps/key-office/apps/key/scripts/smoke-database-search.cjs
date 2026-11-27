// Run serially: native windows and focus are shared with other GUI checks.
// Database search against the sample engine (KEY_DB_SEARCH_MOCK=1, no network): the Databases
// pill hands the search tab's words to the Database search tab; a two-concept query is built
// from blocks; each database's translation and counts appear; it runs on two databases; the
// results are de-duplicated (fewer than per database); selected works go to the library (to a
// collection, tagged) and to the Inbox; the search is saved and run again ("new since last
// run"); the report is exported. Screenshots in light and dark.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, readdir } = require("node:fs/promises");
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

    // Two others to the Inbox.
    await rows.nth(4).getByRole("checkbox").check();
    await rows.nth(5).getByRole("checkbox").check();
    await db.getByRole("button", { name: "Add to Inbox" }).first().click();
    await page.getByText(/Added 2 works to the Inbox/).waitFor();

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
    await page.getByText(/Read the pasted query as 2 concepts/).waitFor();
    await concepts.nth(1).locator(".kx-db-chip", { hasText: "Adolescent" }).locator(".kx-db-chip-field", { hasText: "MeSH" }).waitFor();

    // Dark.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(300);
    await shot(page, "db-build-dark");
    await db.getByRole("tab", { name: /Results/ }).click();
    await rows.first().waitFor();
    await shot(page, "db-results-dark");
    await db.getByRole("button", { name: "Choose…" }).waitFor({ state: "detached" }).catch(() => {});
    assert.deepEqual(errors, []);
    console.log(`Database search smoke passed. Screenshots in ${temp}`);
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
