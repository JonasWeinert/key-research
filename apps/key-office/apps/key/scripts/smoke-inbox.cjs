// Run serially: native windows and focus are shared with other GUI checks.
// Feeds and alerts against a local mock feed and a mock OpenAlex (no real network): search
// "journal of ecology", choose the journal, preview it (its latest works, how often it
// publishes, and its own feed found from its home page), follow its own feed, and its items
// arrive in the Inbox; a new item arrives on the
// next check (asked conditionally); the status bar says so while elsewhere; keyboard triage
// adds one to the library (through the collection chooser) and dismisses another; following
// an author asks OpenAlex; items group by where they came from and say why they are there; a
// web search result goes to the Inbox with Add to Inbox, shows under Saved with where it was
// found, and is added to the library from there; OPML exports and imports back the same
// subscriptions.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, mkdir, readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const fixtures = path.resolve(__dirname, "../../../../../crates/key-desktop-host/src/web_search/fixtures");
const feedFixtures = path.resolve(__dirname, "../../../../../crates/key-desktop-host/src/feeds/fixtures");

const item = (n, doi) => `<item><title>Inbox work number ${n} on cell tracking</title><link>http://journal.test/articles/${n}</link><description>&lt;p&gt;Summary of work ${n}.&lt;/p&gt;</description><dc:creator>Ada Lovelace</dc:creator><pubDate>Tue, 1${n} Jun 2025 04:00:00 +0000</pubDate>${doi ? `<prism:doi>${doi}</prism:doi>` : ""}</item>`;

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-inbox-"));
  const noOpenAlex = path.join(temp, "no-openalex");
  await mkdir(noOpenAlex);
  const openalexPage = JSON.parse(await readFile(path.join(fixtures, "openalex-search.json"), "utf8"));
  const recorded = Object.fromEntries(
    await Promise.all(["sources", "authors", "topics"].map(async (name) => [name, JSON.parse(await readFile(path.join(feedFixtures, `openalex-${name}.json`), "utf8"))])),
  );
  // A web search's one result, not among the author's works.
  const webWork = { ...openalexPage.results[0], id: "https://openalex.org/W4999000001", doi: "https://doi.org/10.5555/web-inbox", display_name: "Smoke web result on reef ecology", title: "Smoke web result on reef ecology", ids: { openalex: "https://openalex.org/W4999000001", doi: "https://doi.org/10.5555/web-inbox" }, primary_location: null, best_oa_location: null, locations: [] };
  let items = [item(1, "10.5555/inbox-1"), item(2, "10.5555/inbox-2")];
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    log.push({ path: url.pathname + url.search, etag: req.headers["if-none-match"] });
    if (url.pathname === "/journal") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<html><head><title>Journal</title><link rel="alternate" type="application/rss+xml" title="Latest" href="/feed.xml"></head><body>Journal</body></html>`);
    }
    if (url.pathname === "/feed.xml") {
      const etag = `"v${items.length}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/rss+xml", etag });
      return res.end(
        `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/"><channel><title>Journal of Smoke Tests</title>${[...items].reverse().join("")}</channel></rss>`,
      );
    }
    if (url.pathname === "/works") {
      res.writeHead(200, { "content-type": "application/json" });
      // A web search (words, no alert filter) finds the one web result.
      if (url.searchParams.get("search") && !url.searchParams.get("filter")) return res.end(JSON.stringify({ meta: { count: 1, next_cursor: null }, results: [webWork] }));
      return res.end(JSON.stringify(openalexPage));
    }
    if (["/sources", "/authors", "/topics"].includes(url.pathname)) {
      res.writeHead(200, { "content-type": "application/json" });
      // The journal's home page is the mock's, which links to its own feed.
      return res.end(JSON.stringify(recorded[url.pathname.slice(1)]).replaceAll("http://www.journalofecology.org/", `http://127.0.0.1:${server.address().port}/journal`));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mock = `http://127.0.0.1:${server.address().port}`;

  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_OPENALEX_FIXTURES: noOpenAlex,
      KEY_WEB_OPENALEX_URL: mock,
      KEY_WEB_S2_URL: mock,
      KEY_FEEDS_ALLOW_LOOPBACK: "1",
      KEY_FEEDS_START_DELAY_MS: "500",
      KEY_FEEDS_TICK_MS: "1000",
    },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const changed = () => page.evaluate(() => window.dispatchEvent(new Event("key:feeds-changed")));
    // A collection, so adding asks where.
    const reading = await call("store_collection_create", { name: "Reading group" });

    // The sidebar's Inbox row, under Library: nothing followed yet.
    const row = page.locator(".kx-inbox-row button");
    await row.waitFor();
    await row.click();
    const inbox = page.locator(".kx-inbox");
    await inbox.getByRole("heading", { name: "Nothing followed yet" }).waitFor();
    await shot(page, "inbox-empty-light");

    // Follow a journal found by its name: suggestions, a preview, then its own feed.
    await inbox.getByRole("button", { name: "Follow something…" }).click();
    const sheet = page.getByRole("dialog", { name: "Feeds and alerts" });
    await sheet.getByLabel("Follow a journal, author, topic or search").fill("journal of ecology");
    const journals = sheet.getByRole("region", { name: "Journals" });
    const option = journals.locator(".kx-follow-option", { hasText: "Journal of Ecology" }).first();
    await option.waitFor();
    assert.match(await option.textContent(), /Wiley · ISSN 0022-0477 · 10,970 works/);
    await sheet.getByRole("region", { name: "People" }).locator(".kx-follow-option", { hasText: "Yoshua Bengio" }).first().waitFor();
    assert.ok(log.some((l) => l.path.startsWith("/sources") && l.path.includes("search=journal")), "OpenAlex sources search");
    await shot(page, "feeds-suggestions-light");
    await option.click();
    const preview = sheet.getByRole("group", { name: /Preview of Journal of Ecology/ });
    await preview.getByText("New articles in Journal of Ecology").waitFor();
    await preview.locator(".kx-follow-items li").first().waitFor();
    assert.equal(await preview.locator(".kx-follow-items li").count(), 3, "the latest works");
    assert.match(await preview.locator(".kx-follow-rate").textContent(), /About 3 new articles a year/);
    assert.match(await preview.locator(".kx-follow-sentence").textContent(), /Key checks about every 12 hours while it is open/);
    assert.ok(log.some((l) => l.path.startsWith("/works") && l.path.includes("primary_location.source.id%3AS11271929")), "previewed by its OpenAlex id");
    await shot(page, "feeds-preview-light");
    // Its home page links to its own feed: offered, previewed, followed.
    await preview.getByRole("button", { name: "Use the journal’s own feed" }).click();
    const own = sheet.getByRole("group", { name: /Preview of Journal of Smoke Tests/ });
    await own.locator(".kx-follow-items li").nth(1).waitFor();
    await own.getByLabel("How often to check").selectOption("1440");
    assert.match(await own.locator(".kx-follow-sentence").textContent(), /about once a day/);
    assert.equal((await call("feeds_subscriptions")).length, 0, "nothing followed before Follow");
    await own.getByRole("button", { name: "Follow", exact: true }).click();
    await sheet.locator(".kx-feeds-row", { hasText: "Journal of Smoke Tests" }).waitFor();
    assert.equal((await call("feeds_subscriptions"))[0].intervalMinutes, 1440);
    await shot(page, "feeds-sheet-light");
    await sheet.getByRole("button", { name: "Close" }).click();
    await sheet.waitFor({ state: "detached" });
    const rows = inbox.locator(".kx-inbox-list > li");
    await rows.first().waitFor();
    assert.equal(await rows.count(), 2, "both items arrived");
    assert.equal(await rows.first().locator(".kx-work-title").textContent(), "Inbox work number 2 on cell tracking");
    await page.locator(".kx-inbox-row small", { hasText: "2" }).waitFor();

    // A new item on the next check; unchanged checks are answered 304.
    await inbox.getByRole("button", { name: "Check now" }).click();
    await page.waitForTimeout(800);
    assert.ok(log.some((l) => l.path === "/feed.xml" && l.etag === '"v2"'), "asked with the ETag");
    items = [...items, item(3, "10.5555/inbox-3")];
    // While the Inbox is not in front, the status bar says what is new.
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.waitForTimeout(500);
    const refreshed = await call("feeds_refresh", {});
    assert.equal(refreshed.added, 1, "the new item came in");
    await changed();
    const status = page.locator('.kx-status-bar [data-status-item="inbox"]');
    await status.waitFor();
    assert.match(await status.textContent(), /1 new in Inbox/);
    await shot(page, "inbox-status-light");
    await status.click();
    await inbox.waitFor();
    await status.waitFor({ state: "detached" });
    await rows.nth(2).waitFor();
    assert.equal(await rows.first().locator(".kx-work-title").textContent(), "Inbox work number 3 on cell tracking");

    // Keyboard triage: j moves, a adds (asking which collections), e dismisses.
    await inbox.locator(".kx-inbox-list").focus();
    await page.keyboard.press("j");
    assert.equal(await rows.nth(1).getAttribute("data-selected"), "true");
    await page.keyboard.press("a");
    const chooser = page.getByRole("dialog", { name: "Add to library" });
    await chooser.waitFor();
    await chooser.locator("label", { hasText: "Reading group" }).click();
    await shot(page, "inbox-add-light");
    await chooser.getByRole("button", { name: "Add", exact: true }).click();
    await rows.nth(1).locator(".kx-work-badge", { hasText: "In library" }).waitFor();
    const found = await call("store_match_identifiers", { works: [{ key: "w", doi: "10.5555/inbox-2" }] });
    assert.equal(found.length, 1, "the work is in the library");
    const source = await call("store_source", { id: found[0].sourceId });
    assert.deepEqual(source.collections, [reading.id], "filed where chosen");
    const queued = await call("store_sources", { scope: "toread" });
    assert.equal(queued.items.length, 1, "added from the Inbox: on the reading list");
    await inbox.locator(".kx-inbox-list").focus();
    await page.keyboard.press("k");
    assert.equal(await rows.first().getAttribute("data-selected"), "true");
    await page.keyboard.press("e");
    await page.locator(".kx-toast", { hasText: "Dismissed" }).first().waitFor({ state: "attached" });
    assert.equal((await call("feeds_items", { view: "dismissed" })).total, 1);
    await page.waitForTimeout(300);
    assert.equal(await rows.count(), 2, "the dismissed item left the list");

    // An author alert asks OpenAlex (its polite pool) and brings works in.
    const followed = await call("feeds_subscribe", { kind: "author", title: "Ashish Vaswani", config: { openalexId: "A5001" } });
    assert.equal(followed.added, 3);
    assert.ok(log.some((l) => l.path.startsWith("/works") && l.path.includes("author.id%3AA5001") && l.path.includes("mailto=")));
    await changed();
    await inbox.locator(".kx-work-title", { hasText: "Attention Is All You Need" }).waitFor();
    // Filter by subscription.
    await inbox.locator(".kx-inbox-filter").first().click();
    await page.getByRole("menuitemradio", { name: /Ashish Vaswani/ }).click();
    await page.waitForTimeout(400);
    assert.equal(await rows.count(), 3, "only the author's works");
    await shot(page, "inbox-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(200);
    await shot(page, "inbox-dark");
    await page.emulateMedia({ colorScheme: "light" });

    // Group by where items came from, and say why each is here.
    await inbox.locator(".kx-inbox-filter").first().click();
    await page.getByRole("menuitemradio", { name: /Everything/ }).click();
    await inbox.getByRole("tab", { name: /^All/ }).click();
    await inbox.locator(".kx-inbox-filter").nth(1).click();
    await page.getByRole("menuitemradio", { name: "By where it came from" }).click();
    await inbox.locator(".kx-inbox-group", { hasText: "Ashish Vaswani" }).waitFor();
    await inbox.locator(".kx-inbox-group", { hasText: "Journal of Smoke Tests" }).waitFor();
    await inbox.locator(".kx-work-head", { hasText: "Attention Is All You Need" }).click();
    await inbox.locator(".kx-inbox-why", { hasText: "new work by Ashish Vaswani, whom you follow" }).waitFor();
    // Bulk: x picks two (j/k keep the picks), the selection panel opens beside the list, s saves both.
    await inbox.locator(".kx-inbox-list").focus();
    await page.keyboard.press("x");
    await page.keyboard.press("k");
    await page.keyboard.press("x");
    const side = page.locator(".kx-inbox-side");
    await side.getByRole("heading", { name: "2 works selected" }).waitFor();
    await shot(page, "inbox-grouped-light");
    await page.keyboard.press("s");
    await page.waitForTimeout(400);
    assert.equal((await call("feeds_items", { view: "saved" })).total, 2, "both saved");
    await inbox.locator(".kx-inbox-list").focus();
    await page.keyboard.press("Escape");
    await side.waitFor({ state: "detached" });
    await inbox.locator(".kx-inbox-filter").nth(1).click();
    await page.getByRole("menuitemradio", { name: "No grouping" }).click();

    // Multi-select as in the library: ⇧-click a range, ⌘-click one more, ⌘A all.
    const heads = rows.locator(".kx-work-head");
    const shown = await rows.count();
    assert.ok(shown >= 4, `enough items to select (${shown})`);
    await heads.nth(0).click();
    await heads.nth(2).click({ modifiers: ["Shift"] });
    await side.getByRole("heading", { name: "3 works selected" }).waitFor();
    await heads.nth(3).click({ modifiers: ["Meta"] });
    await side.getByRole("heading", { name: "4 works selected" }).waitFor();
    assert.equal(await rows.locator(".kx-work-body").count(), 1, "⌘- and ⇧-clicks pick rows instead of opening them");
    // The context menu acts on the picked rows.
    await heads.nth(1).click({ button: "right" });
    const rowMenu = page.getByRole("menu", { name: "Inbox items" });
    await rowMenu.getByRole("menuitem", { name: "Add 4 to library…" }).waitFor();
    await rowMenu.getByRole("menuitem", { name: "Dismiss 4" }).waitFor();
    await page.keyboard.press("Escape");
    await rowMenu.waitFor({ state: "detached" });
    await inbox.locator(".kx-inbox-list").focus();
    await page.keyboard.press("Meta+a");
    await side.getByRole("heading", { name: `${shown} works selected` }).waitFor();

    // The overview, read in Rust: the one added earlier is in the library; where they came from.
    const fact = (label) => side.locator(".kx-selection-fact", { hasText: label }).locator("strong");
    await fact("In library").waitFor();
    assert.equal(await fact("In library").first().textContent(), "1");
    await side.locator(".kx-selection-found", { hasText: "Journal of Smoke Tests" }).waitFor();
    await side.locator(".kx-selection-found", { hasText: "Ashish Vaswani" }).waitFor();
    const overview = await call("inbox_selection_overview", { ids: (await call("feeds_items", { view: "all" })).items.map((i) => i.id) });
    assert.equal(overview.total, shown);
    assert.equal(overview.inLibrary, 1);
    // Each action once, the primary Add counting the ones not in the library yet.
    for (const label of ["Copy references", "Copy BibTeX", "Open all in the browser", "Send to review…", "Dismiss", "Find PDFs"]) {
      assert.equal(await side.locator(".kx-selection-button", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).count(), 1, `${label} once`);
    }
    assert.equal(await side.getByRole("button", { name: `Add ${shown - 1} to library…` }).count(), 1);
    assert.equal(await side.getByRole("button", { name: /Fill with AI/ }).count(), 0, "library-only actions stay in the library");
    const sideways = () => side.locator(".kx-selection").evaluate((el) => el.scrollWidth - el.clientWidth);
    assert.ok((await sideways()) <= 0, "no sideways scroll");
    await shot(page, "inbox-selection-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(200);
    await shot(page, "inbox-selection-dark");
    await page.emulateMedia({ colorScheme: "light" });
    // Narrow: the panel floats over the list, still without sideways scroll.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 800));
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".kx-inbox-shell").getAttribute("data-overlay"), "true");
    assert.ok((await sideways()) <= 0, "no sideways scroll when narrow");
    await shot(page, "inbox-selection-narrow-light");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await page.waitForTimeout(300);
    // BibTeX for works not in the library, keyed by the library's pattern (asked directly: no clipboard).
    const bib = await call("store_biblio_copy", { sources: await call("inbox_works", { ids: (await call("feeds_items", { view: "all" })).items.map((i) => i.id) }), format: "bibtex" });
    assert.ok(bib.startsWith("@") && (bib.match(/^@/gm) ?? []).length === shown, "a BibTeX entry each");

    // Add all: the collection chooser, then one skipped (in the library already), Undo.
    const inReading = async () => (await call("store_sources", { collectionId: reading.id })).items.length;
    const filedBefore = await inReading();
    const started = Date.now();
    await side.getByRole("button", { name: `Add ${shown - 1} to library…` }).click();
    await chooser.waitFor();
    await chooser.locator("label", { hasText: "Reading group" }).click();
    await chooser.getByRole("button", { name: "Add", exact: true }).click();
    const notice = side.locator(".kx-selection-notice");
    await notice.filter({ hasText: `Added ${shown - 1} works to Reading group · 1 already in the library, skipped` }).waitFor();
    console.log(`Bulk add of ${shown - 1} took ${Date.now() - started} ms`);
    assert.equal(await inReading(), filedBefore + shown - 1, "filed where chosen");
    assert.equal(await fact("In library").first().textContent(), String(shown));
    await shot(page, "inbox-selection-added-light");
    await notice.getByRole("button", { name: "Undo" }).click();
    await notice.filter({ hasText: `Took the add back: ${shown - 1} sources moved to the Trash` }).waitFor();
    assert.equal(await inReading(), filedBefore, "undone");
    await side.locator(".kx-selection-fact", { hasText: "In library" }).locator("strong", { hasText: /^1$/ }).waitFor();

    // Dismiss all, then Undo brings them back.
    await side.locator(".kx-selection-foot").getByRole("button", { name: "Dismiss" }).click();
    await side.waitFor({ state: "detached" });
    const undoDismiss = page.locator(".kx-toast", { hasText: `Dismissed ${shown}` }).getByRole("button", { name: "Undo" });
    await undoDismiss.click();
    await rows.nth(shown - 1).waitFor();
    assert.equal(await rows.count(), shown, "back after Undo");

    // A web search result kept for later: Add to Inbox, then Saved, then the library.
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "search", workspaceId: id }), ws.id);
    const search = page.locator(".kx-search-page");
    await search.waitFor();
    const field = search.getByRole("combobox", { name: "Search everything" });
    await field.fill("reef ecology");
    await field.press("Escape");
    await search.locator('.kx-web-pill button[data-kind="web"]').click();
    const hit = search.locator(".kx-web-hit", { hasText: "Smoke web result on reef ecology" });
    await hit.waitFor();
    const keep = hit.locator(".kx-inbox-save");
    await keep.waitFor();
    assert.equal(await keep.getAttribute("data-state"), "none");
    await keep.click();
    await hit.locator('.kx-inbox-save[data-state="inbox"]', { hasText: "In Inbox" }).waitFor();
    await shot(page, "web-add-to-inbox-light");
    assert.equal((await call("feeds_counts", {})).unread, (await call("feeds_items", { view: "unread" })).total, "saved by you is not unread news");
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "inbox", workspaceId: id }), ws.id);
    await inbox.getByRole("tab", { name: /^Saved/ }).click();
    const kept = rows.filter({ hasText: "Smoke web result on reef ecology" });
    await kept.waitFor();
    assert.match(await kept.locator(".kx-inbox-aside").textContent(), /Saved from web search “reef ecology”/);
    await kept.locator(".kx-work-head").click();
    await kept.locator(".kx-inbox-why", { hasText: "You saved it from web search" }).waitFor();
    await shot(page, "inbox-saved-light");
    await inbox.locator(".kx-inbox-list").focus();
    await page.keyboard.press("a");
    await chooser.waitFor();
    await chooser.getByRole("button", { name: "Add", exact: true }).click();
    await kept.locator(".kx-work-badge", { hasText: "In library" }).waitFor();
    assert.equal((await call("store_match_identifiers", { works: [{ key: "w", doi: "10.5555/web-inbox" }] })).length, 1, "added from the Inbox");
    assert.equal((await call("inbox_state", { works: [{ title: "Smoke web result on reef ecology", doi: "10.5555/web-inbox" }] }))[0].state, "library");

    // OPML: out, everything removed, back in.
    const before = await call("feeds_subscriptions");
    const file = path.join(temp, "feeds.opml");
    assert.equal((await call("feeds_opml_export", { path: file })).count, 2);
    const text = await readFile(file, "utf8");
    assert.ok(text.includes(`xmlUrl="${mock}/feed.xml"`) && text.includes('key:kind="author"'));
    for (const s of before) await call("feeds_unsubscribe", { id: s.id });
    assert.equal((await call("feeds_subscriptions")).length, 0);
    assert.deepEqual(await call("feeds_opml_import", { path: file }), { added: 2, existing: 0 });
    const after = await call("feeds_subscriptions");
    assert.deepEqual(after.map((s) => [s.kind, s.title, s.config.url ?? s.config.openalexId]).sort(), before.map((s) => [s.kind, s.title, s.config.url ?? s.config.openalexId]).sort());

    // Settings › Feeds & alerts shows the same manager.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: "feeds" })));
    await page.locator(".kx-feeds-row", { hasText: "Ashish Vaswani" }).waitFor();
    await page.waitForTimeout(700);
    await shot(page, "settings-feeds-light");
    await page.keyboard.press("Escape");

    assert.deepEqual(errors, []);
    console.log(`Inbox smoke passed. Screenshots in ${temp}`);
  } finally {
    await app.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
