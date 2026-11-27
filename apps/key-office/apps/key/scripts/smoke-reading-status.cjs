// Run serially: native windows and focus are shared with other GUI checks.
// Reading status and history, and related sources: opening a library PDF moves it to "in
// progress" and records when it was opened; reaching its last page reads it; a status chosen
// by hand on the source page is never overridden by reading; "To read" and "Recently read"
// list them; the batch editor sets status for several; status:/read: search tokens are read
// by the host; two sources linked as related show on each other's page, and undo unlinks.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, mkdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const fixture = path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-reading-"));
  const noOpenAlex = path.join(temp, "no-openalex");
  await mkdir(noOpenAlex);
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"), KEY_OPENALEX_FIXTURES: noOpenAlex },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 940));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const [pdf] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    const other = await call("store_create", { source: { kind: "reference", itemType: "article", title: "A companion paper on interaction", year: 2021 } });
    const third = await call("store_create", { source: { kind: "reference", itemType: "article", title: "A third paper", year: 2020 } });
    assert.equal((await call("store_reading", { id: pdf.id })).status, "unread");

    // Opening the PDF: in progress, opened now.
    await page.evaluate(({ id, hash }) => window.key.openSource({ hash, documentHash: hash, workspaceId: id, title: "PDF" }), { id: ws.id, hash: pdf.hash ?? pdf.id });
    let reading;
    for (let i = 0; i < 80; i++) {
      reading = await call("store_reading", { id: pdf.id });
      if (reading.status !== "unread") break;
      await page.waitForTimeout(250);
    }
    assert.equal(reading.status, "reading", "opening it starts reading");
    assert.ok(reading.openedAt && reading.readAt, "when it was opened and read");
    const reader = app.windows().find((p) => p.url().endsWith("/pdf.html"));
    if (reader) {
      await reader.locator(".key-pdf-read").waitFor();
      await shot(reader, "reader-toolbar");
    }

    // The last page reads it (as the reader reports pages).
    const pages = reading.pageCount || (await call("store_source", { id: pdf.id })).pageCount || 1;
    assert.equal((await call("store_reading_event", { id: pdf.id, kind: "page", page: pages - 1, pageCount: pages })).status, "read");

    // Chosen by hand on the source page: Unread. Reading again does not change it.
    await page.evaluate(({ id, sourceId }) => window.key.tabAction("open-source-page", { workspaceId: id, sourceId }), { id: ws.id, sourceId: pdf.id });
    const sourcePage = page.locator(".kx-source-page").last();
    const control = sourcePage.locator(".kx-source-page-bar .kx-reading-status");
    await control.waitFor();
    assert.equal(await control.getAttribute("data-status"), "read");
    await control.click();
    await page.getByRole("menuitemradio", { name: "Unread" }).click();
    await sourcePage.locator('.kx-source-page-bar .kx-reading-status[data-status="unread"]').waitFor();
    assert.equal((await call("store_reading_event", { id: pdf.id, kind: "page", page: pages - 1 })).status, "unread", "a manual status is kept");
    assert.equal((await call("store_reading", { id: pdf.id })).manual, true);
    await sourcePage.locator(".kx-reading-summary").waitFor();

    // Related: link from the page with the picker; it shows on both pages, both ways.
    await sourcePage.getByRole("button", { name: "Add related…" }).click();
    const picker = page.getByRole("dialog", { name: "Add a related source" });
    await picker.getByLabel("Find a source").fill("companion");
    await picker.getByRole("option", { name: /companion paper/ }).click();
    await sourcePage.locator(".kx-related .kx-work-title", { hasText: "A companion paper on interaction" }).waitFor();
    await sourcePage.locator(".kx-related").scrollIntoViewIfNeeded();
    await shot(page, "related-light");
    assert.equal((await call("store_related", { id: other.id })).manual[0].id, pdf.id, "both ways");
    await call("store_link_related", { a: third.id, b: other.id });
    assert.equal((await call("store_related", { id: other.id })).manual.length, 2);
    await call("store_undo");
    assert.equal((await call("store_related", { id: other.id })).manual.length, 1, "undo unlinks");

    // Views: To read (marked unread by hand, or in progress) and Recently read.
    await call("store_set_reading_status", { ids: [other.id], status: "reading" });
    const toRead = (await call("store_sources", { scope: "toread" })).items.map((s) => s.id).sort();
    assert.deepEqual(toRead, [pdf.id, other.id].sort());
    const recent = (await call("store_sources", { scope: "recent", sorts: [{ field: "lastRead", descending: true }] })).items.map((s) => s.id);
    assert.deepEqual(recent, [pdf.id]);
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    const library = page.locator(".kx-library, .key-reference-library").first();
    const tabs = page.getByRole("tablist", { name: "Library views" });
    await tabs.getByRole("tab", { name: /To read/ }).click();
    await page.locator(".kx-row", { hasText: "companion paper" }).waitFor();
    await shot(page, "library-to-read-light");
    await tabs.getByRole("tab", { name: /Recently read/ }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".kx-row", { hasText: "companion paper" }).count(), 0);

    // Search tokens: status: and read: are read by the host.
    const [status] = await call("store_parse_query", { text: "status:reading interaction", kinds: false });
    assert.equal(status.filters[0].field, "status");
    const filtered = await call("store_sources", { filters: [{ field: "status", op: "is", value: "reading" }] });
    assert.deepEqual(filtered.items.map((s) => s.id), [other.id]);
    const since = await call("store_sources", { filters: [{ field: "read", op: "gt", value: "2020-01-01" }] });
    assert.deepEqual(since.items.map((s) => s.id), [pdf.id]);

    // Batch edit: several selected, a mixed status, set at once.
    await tabs.getByRole("tab", { name: "All" }).click();
    await page.locator(".kx-row").first().waitFor();
    await page.locator(".kx-row").first().click({ position: { x: 30, y: 20 } });
    await page.keyboard.press("Meta+a");
    const batch = page.locator(".kx-selection");
    await batch.waitFor();
    const mixed = batch.locator('.kx-reading-status[data-status="mixed"]');
    await mixed.waitFor();
    await shot(page, "batch-status-light");
    await mixed.click();
    await page.getByRole("menuitemradio", { name: "Read", exact: true }).click();
    await batch.locator('.kx-reading-status[data-status="read"]').waitFor();
    for (const s of [pdf, other, third]) assert.equal((await call("store_reading", { id: s.id })).status, "read");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "batch-status-dark");
    void library;

    assert.deepEqual(errors, []);
    console.log(`Reading status smoke passed. Screenshots in ${temp}`);
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
