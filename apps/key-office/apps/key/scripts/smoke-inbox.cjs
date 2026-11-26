// Run serially: native windows and focus are shared with other GUI checks.
// Feeds and alerts against a local mock feed and a mock OpenAlex (no real network): follow a
// journal's page (its feed is found), its items arrive in the Inbox; a new item arrives on the
// next check (asked conditionally); the status bar says so while elsewhere; keyboard triage
// adds one to the library (through the collection chooser) and dismisses another; following
// an author asks OpenAlex; OPML exports and imports back the same subscriptions.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const fixtures = path.resolve(__dirname, "../../../../../crates/key-desktop-host/src/web_search/fixtures");

const item = (n, doi) => `<item><title>Inbox work number ${n} on cell tracking</title><link>http://journal.test/articles/${n}</link><description>&lt;p&gt;Summary of work ${n}.&lt;/p&gt;</description><dc:creator>Ada Lovelace</dc:creator><pubDate>Tue, 1${n} Jun 2025 04:00:00 +0000</pubDate>${doi ? `<prism:doi>${doi}</prism:doi>` : ""}</item>`;

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-inbox-"));
  const noOpenAlex = path.join(temp, "no-openalex");
  await mkdir(noOpenAlex);
  const openalexPage = JSON.parse(await readFile(path.join(fixtures, "openalex-search.json"), "utf8"));
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
      return res.end(JSON.stringify(openalexPage));
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

    // Follow the journal by its page's address: its feed is found and read.
    await inbox.getByRole("button", { name: "Add a feed…" }).click();
    const sheet = page.getByRole("dialog", { name: "Feeds and alerts" });
    await sheet.getByLabel("Feed or page address").fill(`${mock}/journal`);
    await sheet.getByRole("button", { name: "Follow", exact: true }).click();
    await sheet.locator(".kx-feeds-row", { hasText: "Journal of Smoke Tests" }).waitFor();
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
    await inbox.locator(".kx-inbox-filter").click();
    await page.getByRole("menuitemradio", { name: /Ashish Vaswani/ }).click();
    await page.waitForTimeout(400);
    assert.equal(await rows.count(), 3, "only the author's works");
    await shot(page, "inbox-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(200);
    await shot(page, "inbox-dark");
    await page.emulateMedia({ colorScheme: "light" });

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
