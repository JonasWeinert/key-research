// Run serially: native windows and focus are shared with other GUI checks.
// Sources around the library (recorded OpenAlex responses, no network): the details panel's
// bar stays pinned with its close button while it scrolls; the file card opens the PDF; a
// reference added from a source asks which collections (the source's by default), "Don't ask
// again" makes it silent, Settings asks again; a native view asks through the bridge; topic
// pages list sources with the shared row; Zotero marks on the Library row, rows and details.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-library-sources-"));
  const fixture = path.join(temp, "Health versus income.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_OPENALEX_FIXTURES: path.resolve(__dirname, "../../../../../tests/fixtures/openalex"),
    },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  const both = async (page, name) => {
    await page.evaluate(() => window.key.setAppSettings({ theme: "light" }));
    await page.waitForTimeout(300);
    await shot(page, `${name}-light`);
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForTimeout(300);
    await shot(page, `${name}-dark`);
    await page.evaluate(() => window.key.setAppSettings({ theme: "system" }));
  };
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 940));
    await page.emulateMedia({ colorScheme: null });
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const tabAction = (action, payload) => page.evaluate(({ action, payload }) => window.key.tabAction(action, payload), { action, payload });
    const activeTab = async () => {
      const t = await page.evaluate(() => window.key.tabs());
      return t.tabs.find((x) => x.id === t.activeTabId);
    };

    // A collection with a paper in it, looked up in OpenAlex (from the fixtures).
    const reading = await call("store_collection_create", { name: "Reading" });
    await call("store_collection_create", { name: "Methods" });
    const paper = await call("store_create", { source: { kind: "reference", itemType: "article", title: "The state of OA", doi: "10.7717/peerj.4375", collections: [reading.id] } });
    for (let i = 0; i < 80 && (await call("store_source", { id: paper.id })).enrichStatus !== "done"; i++) await page.waitForTimeout(250);
    const [pdf] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    await call("store_update", { id: pdf.id, patch: { abstract: "People value health and income. ".repeat(40), year: 2022, creators: [{ given: "Marco", family: "Palma" }] } });
    // An item from Zotero, with sync set up (paused: nothing to reach).
    const fromZotero = await call("store_create", { source: { kind: "reference", itemType: "article", title: "Synced from Zotero", origin: "zotero", originKey: "ABCD2345" } });
    await call("store_zotero_plugin_configure", { paused: true, libraryID: 1 });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:zotero-changed")));

    // ── Add from a source: the chooser offers the source's collection ──
    await tabAction("open-source-page", { workspaceId: ws.id, sourceId: paper.id, title: "The state of OA", read: false });
    const sourcePage = page.locator(".kx-source-page[data-side=false]");
    await sourcePage.locator(".kx-work-references").waitFor();
    await sourcePage.getByRole("button", { name: /Show all/ }).click();
    const reference = sourcePage.locator(".kx-work-list li", { hasText: "The Development of Open Access Journal Publishing" });
    await reference.locator(".kx-work-head").click();
    await reference.getByRole("button", { name: "Add to library" }).click();
    const chooser = page.getByRole("dialog", { name: "Add to library" });
    await chooser.waitFor();
    assert.equal(await chooser.getByRole("checkbox", { name: /Reading/ }).isChecked(), true, "the source's collection is chosen");
    assert.equal(await chooser.getByRole("checkbox", { name: /Methods/ }).isChecked(), false);
    await chooser.getByRole("checkbox", { name: /Methods/ }).check();
    await both(page, "chooser");
    await chooser.getByRole("button", { name: "Add", exact: true }).click();
    await chooser.waitFor({ state: "detached" });
    await reference.locator(".kx-work-badge", { hasText: "In library" }).waitFor();
    let added = (await call("store_sources", { text: "The Development of Open Access Journal Publishing", limit: 5 })).items.find((s) => /Development of Open Access/.test(s.title));
    for (let i = 0; i < 20 && !added; i++) {
      await page.waitForTimeout(200);
      added = (await call("store_sources", { limit: 50 })).items.find((s) => /Development of Open Access/.test(s.title || ""));
    }
    assert.ok(added, "the reference is in the library");
    assert.deepEqual([...added.collections].sort(), [reading.id, (await call("store_collections")).find((c) => c.name === "Methods").id].sort(), "in both chosen collections");

    // "Don't ask again": the next one goes to the source's collection without asking.
    const second = sourcePage.locator('.kx-work-list li[data-in-library="false"]').first();
    await second.locator(".kx-work-head").click();
    await second.getByRole("button", { name: "Add to library" }).click();
    await chooser.waitFor();
    await chooser.getByRole("checkbox", { name: "Don’t ask again" }).check();
    await chooser.getByRole("button", { name: "Add", exact: true }).click();
    await chooser.waitFor({ state: "detached" });
    for (let i = 0; i < 20 && (await page.evaluate(() => window.key.appSettings())).settings.addFromSource !== "origin"; i++) await page.waitForTimeout(100);
    assert.equal((await page.evaluate(() => window.key.appSettings())).settings.addFromSource, "origin");
    const thirdTitle = (await sourcePage.locator('.kx-work-list li[data-in-library="false"] .kx-work-title').first().textContent()).trim();
    const third = sourcePage.locator(".kx-work-list li", { hasText: thirdTitle });
    await third.locator(".kx-work-head").click();
    await third.getByRole("button", { name: "Add to library" }).click();
    await third.locator(".kx-work-badge", { hasText: "In library" }).waitFor();
    assert.equal(await chooser.count(), 0, "no chooser once asked not to");
    const silent = (await call("store_sources", { limit: 100 })).items.find((s) => s.title === thirdTitle);
    assert.deepEqual(silent?.collections, [reading.id], "silently into the source's collection");

    // Settings › Libraries asks again.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:open-settings", { detail: "libraries" })));
    await page.evaluate(() => window.key.setAppSettings({ addFromSource: "ask" }));

    // A native view asks through the bridge: the shell shows the chooser over it.
    const pdfSource = await call("store_source", { id: pdf.id });
    const hash = pdfSource.fileHash ?? pdf.id;
    await tabAction("open-source-page", { workspaceId: ws.id, sourceId: pdf.id, title: "Health versus income", read: true, pdf: { documentHash: hash, documentId: hash, title: "Health versus income", workspaceId: ws.id, pageCount: pdfSource.pageCount ?? 0 } });
    let reader;
    for (let i = 0; i < 200 && !reader; i++) {
      reader = app.windows().find((w) => w.url().endsWith("/pdf.html"));
      if (!reader) await page.waitForTimeout(100);
    }
    await reader.waitForFunction(() => !!window.key?.addFromSource);
    await call("store_membership", { collectionId: reading.id, ids: [pdf.id], present: true });
    const asked = reader.evaluate(
      ({ ws, origin }) => window.key.addFromSource({ origin: { workspaceId: ws, sourceId: origin }, work: { title: "A work cited in the PDF", doi: "10.1000/cited.1", year: 2019 } }),
      { ws: ws.id, origin: pdf.id },
    );
    await chooser.waitFor();
    assert.equal(await chooser.getByRole("checkbox", { name: /Reading/ }).isChecked(), true);
    await shot(page, "chooser-from-reader");
    await chooser.getByRole("button", { name: "Add", exact: true }).click();
    const fromReader = await asked;
    assert.equal(fromReader?.title, "A work cited in the PDF");
    assert.deepEqual(fromReader.collections, [reading.id]);

    // ── The details panel: the bar stays, with the close button, while it scrolls ──
    await tabAction("open-content", { section: "sources", workspaceId: ws.id });
    const library = page.locator(".kx-library:visible");
    await library.locator(".kx-row", { hasText: "Health versus income" }).click();
    const side = page.locator(".kx-source-page[data-side=true]");
    await side.locator(".kx-source-page-title").waitFor();
    if ((await side.locator(".kx-page-details-toggle").getAttribute("aria-expanded")) !== "true") await side.locator(".kx-page-details-toggle").click();
    await side.locator(".kx-page-abstract-preview").click();
    const close = side.getByRole("button", { name: "Close details" });
    const before = await close.boundingBox();
    await side.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await side.locator('.kx-item-page-toprow[data-pinned="true"]').waitFor();
    await page.waitForTimeout(300);
    const after = await close.boundingBox();
    assert.ok(after && Math.abs(after.y - before.y) < 16, `the close button stays put (${before?.y} → ${after?.y})`);
    assert.ok(await side.locator(".kx-bar-title").evaluate((el) => getComputedStyle(el).opacity === "1"), "the bar shows the title once it has scrolled away");
    await both(page, "details-pinned");
    await side.evaluate((el) => el.scrollTo({ top: 0 }));

    // The file card opens the PDF.
    const card = side.locator(".kx-file-card[data-openable]");
    await card.scrollIntoViewIfNeeded();
    await card.hover();
    await shot(page, "file-card-hover");
    await card.click({ position: { x: 30, y: 14 } });
    for (let i = 0; i < 60 && !(await activeTab())?.views.some((v) => v.kind === "pdf"); i++) await page.waitForTimeout(150);
    assert.ok((await activeTab()).views.some((v) => v.kind === "pdf"), "the PDF opens from the file card");

    // ── Zotero marks: the Library row, the source's row and its details ──
    await tabAction("open-content", { section: "sources", workspaceId: ws.id });
    await page.locator(".kx-library-row .kx-zotero-mark").waitFor();
    await library.locator(".kx-row", { hasText: "Synced from Zotero" }).locator(".kx-zotero-mark").waitFor();
    assert.equal(await library.locator(".kx-row", { hasText: "Health versus income" }).locator(".kx-zotero-mark").count(), 0, "only Zotero's items");
    await library.locator(".kx-row", { hasText: "Synced from Zotero" }).click();
    if ((await side.locator(".kx-page-details-toggle").getAttribute("aria-expanded")) !== "true") await side.locator(".kx-page-details-toggle").click();
    const zoteroRow = side.locator('.kx-research-row[data-research="Zotero"]');
    await zoteroRow.getByText("Sync paused").or(zoteroRow.getByText("sync paused")).first().waitFor();
    await zoteroRow.getByRole("link", { name: "Open in Zotero" }).waitFor();
    assert.equal(await zoteroRow.getByRole("link", { name: "Open in Zotero" }).getAttribute("href"), "zotero://select/library/items/ABCD2345");
    await both(page, "zotero-marks");

    // ── A topic's sources: the shared row, opened in place ──
    const graph = await call("store_source_graph", { id: paper.id });
    const topic = graph.topics[0];
    await tabAction("open-content", { section: "topic", workspaceId: ws.id, entityId: topic.id, title: topic.name });
    const topicPage = page.locator(".kx-entity-page:visible");
    const row = topicPage.locator(".kx-source-item", { hasText: "The state of OA" });
    await row.locator(".kx-work-head").click();
    await row.getByRole("button", { name: "Open to the side" }).waitFor();
    await row.getByRole("button", { name: "Open", exact: true }).waitFor();
    await both(page, "topic-sources");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, chooser: true, dontAsk: true, bridge: true, pinnedBar: true, fileCard: true, zotero: true, topicRows: true }));
  } catch (e) {
    await app.windows()[0]?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error("Artifacts", temp);
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
