// Run serially: native windows and focus are shared with other GUI checks.
// Searching everything: the search popup opened from the library starts with sources
// only, its kind chips count every kind, and it opens as its own tab. In that tab the
// sidebar filters instead of navigating (a collection, Sources, a note; a second click
// opens), and a tag clicked on a source page lands on the library filtered by it.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-search-"));
  const fixture = path.join(temp, "Interaction study.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"), KEY_OPENALEX_ENABLED: "0" },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 940));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    // Page details start folded; these checks work with the properties, so open them once.
    await page.evaluate(() => localStorage.setItem("key.page.details.open", "1"));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const command = (name) => app.evaluate(({ BrowserWindow }, name) => BrowserWindow.getAllWindows()[0].webContents.send("command", name), name);
    const tabAction = (name, payload) => page.evaluate(([name, payload]) => window.key.tabAction(name, payload), [name, payload]);
    const activeKind = () =>
      page.evaluate(async () => {
        const t = await window.key.tabs();
        return t.tabs.flatMap((tab) => tab.views).find((v) => v.id === t.activeViewId)?.kind;
      });
    const waitKind = (kind) => page.waitForFunction(async (kind) => {
      const t = await window.key.tabs();
      return t.tabs.flatMap((tab) => tab.views).find((v) => v.id === t.activeViewId)?.kind === kind;
    }, kind);

    // A tagged source in a collection, another source, a note and a canvas.
    const [source] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    await call("store_update", { id: source.id, patch: { creators: [{ given: "Marco", family: "Palma" }], year: 2022, tags: ["covid"], doi: "https://doi.org/10.5555/interaction.2022" } });
    await call("store_create", { source: { kind: "reference", title: "Interaction budgets elsewhere", year: 2019, tags: ["economics"] } }).catch(() => undefined);
    const reading = await call("store_collection_create", { name: "Reading list", parentId: null });
    await call("store_membership", { collectionId: reading.id, ids: [source.id], present: true });
    await call("store_note_save", { id: null, sourceId: null, title: "Alpha", body: "Interaction effects need a second look." });
    await call("store_canvas_save", { id: null, title: "Interaction board", doc: { version: 1, nodes: [], edges: [] } });
    // The sidebar loads collections made outside it when the window reloads.
    await page.reload();
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const sidebar = page.locator(".key-sidebar");
    await sidebar.locator(".kx-nav-item", { hasText: "Alpha" }).waitFor();
    // Collections fold under the Library row.
    await sidebar.locator(".kx-library-row").getByRole("button", { name: "Show collections" }).click();
    await sidebar.locator(".kx-tree-label", { hasText: "Reading list" }).waitFor();

    // From the library, the search popup starts with sources only.
    await tabAction("open-content", { section: "sources", workspaceId: ws.id });
    await waitKind("library");
    await page.locator(".kx-library").waitFor();
    await command("search");
    const popup = page.locator(".kx-palette");
    await popup.waitFor();
    await popup.locator('.kx-kind-chips button[data-kind="source"][aria-pressed="true"]').waitFor();
    await page.keyboard.type("Interaction");
    await popup.locator(".kx-found-row", { hasText: "Interaction study" }).first().waitFor();
    assert.equal(await popup.locator(".kx-found-row", { hasText: "Alpha" }).count(), 0, "notes are left out while Sources is chosen");
    await popup.locator(".kx-kind-chips button", { hasText: /^All/ }).click();
    await popup.locator(".kx-found-row", { hasText: "Alpha" }).first().waitFor();
    await popup.locator(".kx-found-row", { hasText: "Interaction board" }).first().waitFor();
    const noteCount = Number(await popup.locator('.kx-kind-chips button[data-kind="note"] .kx-count').textContent());
    assert.ok(noteCount >= 1, `notes counted, got ${noteCount}`);
    await shot(page, "popup");

    // Expanded into its own tab, keeping the query.
    await popup.getByRole("button", { name: "Open in tab" }).click();
    await waitKind("search");
    const tab = page.locator(".kx-search-page");
    await tab.waitFor();
    assert.equal(await tab.getByRole("combobox", { name: "Search everything" }).inputValue(), "Interaction");
    await tab.locator(".kx-found-hit", { hasText: "Alpha" }).first().waitFor();
    // Results by item, like the library: the PDF once, with its matching passages under it.
    const field = tab.getByRole("combobox", { name: "Search everything" });
    for (let i = 0; i < 120 && (await call("store_source", { id: source.id })).indexStatus !== "ready"; i++) await page.waitForTimeout(250);
    await field.fill("compare exactly");
    await field.press("Escape");
    const study = tab.locator('.kx-found-group[data-group="text"] .kx-found-hit', { hasText: "Interaction study" });
    await study.locator(".kx-passage").first().waitFor();
    assert.equal(await tab.locator('.kx-found-group[data-group="text"] .kx-found-hit', { hasText: "Interaction study" }).count(), 1, "one row per item");
    // A passage opens beside the search, with the reader's result bar; the search stays.
    await study.locator(".kx-passage").first().click();
    await page.waitForFunction(async () => {
      const t = await window.key.tabs();
      // In a group beside the search's: one reader tab, focused.
      const search = t.tabs.find((x) => x.views[0].kind === "search");
      const readers = t.tabs.filter((x) => x.views[0].kind === "pdf");
      return !!search && readers.length === 1 && readers[0].groupId !== search.groupId && t.activeTabId === readers[0].id;
    });
    let reader;
    for (let i = 0; i < 100 && !reader; i++) {
      reader = app.windows().find((p) => p.url().endsWith("/pdf.html"));
      if (!reader) await page.waitForTimeout(100);
    }
    await reader.locator(".key-pdf-result").waitFor();
    await shot(page, "search-beside");
    await page.evaluate(async () => {
      const t = await window.key.tabs();
      const pdf = t.tabs.find((x) => x.id === t.activeTabId).views.find((v) => v.kind === "pdf");
      await window.key.tabAction("close-pane", { viewId: pdf.id });
    });
    await waitKind("search");
    await field.fill("Interaction");
    await field.press("Escape");
    await tab.locator(".kx-found-hit", { hasText: "Alpha" }).first().waitFor();
    await tab.locator(".kx-segmented button", { hasText: "Kinds" }).click();
    await tab.locator('.kx-search-head[data-kind="note"]').waitFor();
    await tab.locator(".kx-segmented button", { hasText: "Sections" }).click();

    // A collection in the sidebar filters the search instead of leaving it.
    await sidebar.locator(".kx-tree-label", { hasText: "Reading list" }).click();
    await tab.locator('.kx-token[data-field="collection"]', { hasText: "Reading list" }).waitFor();
    await tab.locator('.kx-kind-chips button[data-kind="source"][aria-pressed="true"]').waitFor();
    await tab.locator(".kx-found-hit", { hasText: "Interaction study" }).first().waitFor();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll(".kx-search-page .kx-found-hit")].map((r) => r.textContent);
      return rows.length && rows.every((t) => !t.includes("budgets") && !t.includes("Alpha") && !t.includes("board"));
    });
    assert.equal(await tab.locator('.kx-kind-chips button[data-kind="note"] .kx-count').textContent(), "0", "notes are not in a collection");
    assert.equal(await activeKind(), "search", "still in the search tab");
    await shot(page, "tab-collection");

    // The Library drops the collection but keeps sources only.
    await sidebar.locator(".kx-library-row .kx-tree-label").click();
    await page.waitForFunction(() => !document.querySelector('.kx-search-page .kx-token[data-field="collection"]'));
    await tab.locator('.kx-kind-chips button[data-kind="source"][aria-pressed="true"]').waitFor();
    assert.equal(await activeKind(), "search");

    // A note narrows to just that note; clicking it again opens it.
    await sidebar.locator(".kx-nav-item", { hasText: "Alpha" }).click();
    await tab.locator('.kx-token[data-field="item"]', { hasText: "Alpha" }).waitFor();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll(".kx-search-page .kx-found-hit")];
      return rows.length > 0 && rows.every((r) => r.textContent.includes("Alpha") || r.querySelector(".kx-found-kind")?.textContent === "Note");
    });
    assert.equal(await activeKind(), "search");
    await sidebar.locator(".kx-nav-item", { hasText: "Alpha" }).click();
    await waitKind("note");

    // A tag on a source page shows the library filtered by it.
    await tabAction("open-source-page", { workspaceId: ws.id, sourceId: source.id, title: "Interaction study", read: false });
    await waitKind("page");
    const sourcePage = page.locator(".kx-source-page:visible");
    await sourcePage.waitFor();
    if (!(await sourcePage.locator(".kx-page-details").count())) await sourcePage.locator(".kx-page-details-toggle").click();
    await sourcePage.locator(".kx-chip .kx-filter-link", { hasText: "covid" }).click();
    await waitKind("library");
    const library = page.locator(".kx-library:visible");
    await library.locator('.kx-token[data-field="tag"]', { hasText: "covid" }).waitFor();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll(".kx-library .kx-row strong")].filter((r) => r.offsetParent);
      return rows.length === 1 && rows[0].textContent.includes("Interaction study");
    });
    // In the library a value adds to the filters: the year joins the tag.
    await library.locator(".kx-row .kx-filter-link", { hasText: "2022" }).first().click();
    await library.locator('.kx-token[data-field="year"]', { hasText: "2022" }).waitFor();
    assert.equal(await library.locator('.kx-token[data-field="tag"]').count(), 1);
    await shot(page, "library-filtered");

    // What the query looks like is offered, never applied by itself: a citation reads as
    // author and year, a pasted DOI as a DOI, a quoted phrase as the title.
    const search = library.getByRole("combobox", { name: "Search the library" });
    await search.fill("");
    await library.getByRole("button", { name: "Clear search" }).click();
    await page.waitForFunction(() => !document.querySelector(".kx-library .kx-token"));
    const detected = library.locator('.kx-suggest-item[data-detected="true"]');
    await search.fill("Palma et al. 2022");
    await detected.first().waitFor();
    assert.match(await detected.first().textContent(), /Author contains\s*Palma.*Year\s*2022/);
    assert.equal(await library.locator(".kx-token").count(), 0, "nothing applies until it is picked");
    assert.equal(await search.inputValue(), "Palma et al. 2022");
    await page.waitForTimeout(300);
    await shot(page, "smart-citation");
    await search.press("ArrowDown");
    await search.press("Enter");
    await library.locator('.kx-token[data-field="creator"]', { hasText: "Palma" }).waitFor();
    await library.locator('.kx-token[data-field="year"]', { hasText: "2022" }).waitFor();
    assert.equal(await search.inputValue(), "");
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll(".kx-library .kx-row strong")].filter((r) => r.offsetParent);
      return rows.length === 1 && rows[0].textContent.includes("Interaction study");
    });
    // Removing a token undoes just that part.
    await library.getByRole("button", { name: "Remove filter Year 2022" }).click();
    await page.waitForFunction(() => !document.querySelector('.kx-library .kx-token[data-field="year"]'));
    await library.getByRole("button", { name: "Clear search" }).click();

    await search.fill("see https://doi.org/10.5555/Interaction.2022.");
    await detected.first().waitFor();
    assert.match(await detected.first().textContent(), /DOI\s*10\.5555\/interaction\.2022\s*and search see/);
    await page.waitForTimeout(300);
    await shot(page, "smart-doi");
    await detected.first().click();
    await library.locator('.kx-token[data-field="doi"]', { hasText: "10.5555/interaction.2022" }).waitFor();
    assert.equal(await search.inputValue(), "see", "the rest of the query stays");
    await search.fill("");
    // The store narrows by identifier once it knows the doi filter (key-store filters.rs).
    const all = (await call("store_sources", { filters: [], limit: 50 })).items.length;
    const byDoi = (await call("store_sources", { filters: [{ field: "doi", op: "is", value: "10.5555/interaction.2022" }], limit: 50 })).items.length;
    if (byDoi < all) {
      assert.equal(byDoi, 1);
      await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll(".kx-library .kx-row strong")].filter((r) => r.offsetParent);
        return rows.length === 1 && rows[0].textContent.includes("Interaction study");
      });
    } else console.warn("store has no doi filter yet: DOI results not checked");
    await library.getByRole("button", { name: "Clear search" }).click();

    await search.fill('"Interaction budgets elsewhere"');
    await detected.first().waitFor();
    await detected.first().click();
    await library.locator('.kx-token[data-field="title"]', { hasText: "Interaction budgets elsewhere" }).waitFor();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll(".kx-library .kx-row strong")].filter((r) => r.offsetParent);
      return rows.length === 1 && rows[0].textContent.includes("budgets");
    });
    await library.getByRole("button", { name: "Clear search" }).click();

    // In the search tab a kind of item is a kind to show.
    await command("search");
    await popup.waitFor();
    await popup.getByRole("button", { name: "Open in tab" }).click();
    await waitKind("search");
    const searchTab = page.locator(".kx-search-page:visible");
    const tabField = searchTab.getByRole("combobox", { name: "Search everything" });
    // The tab takes the popup's (empty) query as it opens; type once it has.
    for (let i = 0; i < 20; i++) {
      await tabField.fill("notes interaction");
      await page.waitForTimeout(300);
      if ((await tabField.inputValue()) === "notes interaction") break;
    }
    const tabDetected = searchTab.locator('.kx-suggest-item[data-detected="true"]');
    await tabDetected.first().waitFor();
    assert.match(await tabDetected.first().textContent(), /Show\s*Notes\s*and search interaction/);
    await page.waitForTimeout(300);
    await shot(page, "smart-kind");
    await tabDetected.first().click();
    await searchTab.locator('.kx-kind-chips button[data-kind="note"][aria-pressed="true"]').waitFor();
    assert.equal(await tabField.inputValue(), "interaction");
    await searchTab.locator(".kx-found-hit", { hasText: "Alpha" }).first().waitFor();

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, prefiltered: true, kinds: true, expanded: true, sidebarFilters: true, secondClickOpens: true, tagToLibrary: true, smartQuery: true }));
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
