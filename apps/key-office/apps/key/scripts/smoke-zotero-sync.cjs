// Zotero import and sync end to end, without Zotero: a fixture zotero.sqlite (for the
// preview, the paper list and "Import once") and the mock Key Sync plugin (for "Keep in
// sync"). Covers the sheet's two steps and three scopes, installing and pairing the plugin,
// the first sync, deltas (edit, new item, trash, leaving the scope), "Zotero is not
// running" and pause in Settings. Screenshots in light and dark.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, copyFile, writeFile, readFile, access } = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { startMockZotero } = require("./mock-zotero-plugin.cjs");

const SCHEMA = `
CREATE TABLE itemTypes(itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
CREATE TABLE items(itemID INTEGER PRIMARY KEY, itemTypeID INT, dateAdded TEXT DEFAULT '2026-01-02 03:04:05', dateModified TEXT, libraryID INT DEFAULT 1, key TEXT);
CREATE TABLE fields(fieldID INTEGER PRIMARY KEY, fieldName TEXT);
CREATE TABLE itemDataValues(valueID INTEGER PRIMARY KEY, value TEXT UNIQUE);
CREATE TABLE itemData(itemID INT, fieldID INT, valueID INT, PRIMARY KEY(itemID, fieldID));
CREATE TABLE creators(creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT);
CREATE TABLE creatorTypes(creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
CREATE TABLE itemCreators(itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);
CREATE TABLE tags(tagID INTEGER PRIMARY KEY, name TEXT UNIQUE);
CREATE TABLE itemTags(itemID INT, tagID INT);
CREATE TABLE collections(collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INT, key TEXT);
CREATE TABLE deletedCollections(collectionID INTEGER PRIMARY KEY);
CREATE TABLE collectionItems(collectionID INT, itemID INT, orderIndex INT DEFAULT 0);
CREATE TABLE itemAttachments(itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT, contentType TEXT, path TEXT);
CREATE TABLE itemNotes(itemID INTEGER PRIMARY KEY, parentItemID INT, note TEXT, title TEXT);
CREATE TABLE itemAnnotations(itemID INTEGER PRIMARY KEY, parentItemID INT, type INT, text TEXT, comment TEXT, color TEXT, pageLabel TEXT, sortIndex TEXT, position TEXT);
CREATE TABLE deletedItems(itemID INTEGER PRIMARY KEY);
INSERT INTO itemTypes VALUES (1, 'journalArticle'), (2, 'book'), (3, 'report'), (14, 'attachment'), (26, 'note'), (40, 'annotation');
INSERT INTO fields VALUES (1, 'title'), (2, 'publicationTitle'), (3, 'date');
INSERT INTO creatorTypes VALUES (1, 'author');
INSERT INTO collections VALUES (1, 'Thesis', NULL, 'COLLTHES'), (2, 'Chapter 2', 1, 'COLLCHAP'), (3, 'Methods', NULL, 'COLLMETH');
INSERT INTO items(itemID, itemTypeID, key) VALUES (1, 1, 'ITEMAAAA'), (2, 14, 'ATTAAAAA'), (3, 26, 'NOTEAAAA'), (4, 40, 'ANNOAAAA'), (5, 2, 'ITEMBBBB'), (6, 3, 'ITEMCCCC');
INSERT INTO itemDataValues(valueID, value) VALUES (1, 'Health versus income'), (2, 'Social Science & Medicine'), (3, '2022-03-01'), (4, 'Reading in groups'), (5, '2019'), (6, 'Annual report on literacy');
INSERT INTO itemData VALUES (1, 1, 1), (1, 2, 2), (1, 3, 3), (5, 1, 4), (5, 3, 5), (6, 1, 6);
INSERT INTO creators VALUES (1, 'Marco', 'Palma', 0), (2, 'Ada', 'Rossi', 0), (3, 'Bea', 'Bianchi', 0);
INSERT INTO itemCreators VALUES (1, 1, 1, 0), (5, 2, 1, 0), (5, 3, 1, 1);
INSERT INTO collectionItems(collectionID, itemID) VALUES (2, 1), (3, 5);
INSERT INTO itemAttachments VALUES (2, 1, 0, 'application/pdf', 'storage:paper.pdf');
INSERT INTO itemNotes VALUES (3, 1, '<p><strong>Bold</strong> idea</p>', 'Bold idea');
INSERT INTO itemAnnotations VALUES (4, 2, 1, 'A highlighted sentence', 'Worth citing', '#ffd400', '3', '00002|000100|00200', '{"pageIndex":2}');
`;

// The same library as the plugin serves it.
const library = (pdf) => ({
  collections: [
    { key: "COLLTHES", name: "Thesis", parentKey: null },
    { key: "COLLCHAP", name: "Chapter 2", parentKey: "COLLTHES" },
    { key: "COLLMETH", name: "Methods", parentKey: null },
  ],
  items: [
    {
      key: "ITEMAAAA",
      itemType: "journalArticle",
      fields: { title: "Health versus income", publicationTitle: "Social Science & Medicine", date: "2022-03-01" },
      creators: [{ creatorType: "author", firstName: "Marco", lastName: "Palma" }],
      collections: ["COLLCHAP"],
      attachments: [
        { key: "ATTAAAAA", contentType: "application/pdf", linkMode: 0, path: pdf, annotations: [{ key: "ANNOAAAA", type: 1, text: "A highlighted sentence", comment: "Worth citing", color: "#ffd400", pageIndex: 2, sortIndex: "00002|000100|00200" }] },
      ],
      notes: [{ key: "NOTEAAAA", title: "Bold idea", html: "<p><strong>Bold</strong> idea</p>" }],
    },
    { key: "ITEMBBBB", itemType: "book", fields: { title: "Reading in groups", date: "2019" }, creators: [{ creatorType: "author", firstName: "Ada", lastName: "Rossi" }, { creatorType: "author", firstName: "Bea", lastName: "Bianchi" }], collections: ["COLLMETH"] },
    { key: "ITEMCCCC", itemType: "report", fields: { title: "Annual report on literacy" } },
  ],
});

async function single() {
  const temp = await mkdtemp(path.join(tmpdir(), "key-zotero-sync-"));
  const zotero = path.join(temp, "Zotero");
  await mkdir(path.join(zotero, "storage/ATTAAAAA"), { recursive: true });
  const pdf = path.join(zotero, "storage/ATTAAAAA/paper.pdf");
  await copyFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf"), pdf);
  execFileSync("python3", ["-I", "-c", "import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.commit()", path.join(zotero, "zotero.sqlite"), SCHEMA]);
  // Zotero with the plugin's protocol, at first without the plugin itself.
  let mock = await startMockZotero({ library: library(pdf) });
  mock.setMode("missing");
  const shots = path.join(temp, "shots");
  await mkdir(shots);
  // A fake Zotero profile for the one-click install; the real one is never touched.
  const zoteroRoot = path.join(temp, "zotero-profiles");
  const profile = path.join(zoteroRoot, "Profiles/fake.default");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(zoteroRoot, "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/fake.default\nDefault=1\n");
  await writeFile(path.join(profile, "prefs.js"), 'user_pref("extensions.lastAppBuildId", "20260707110915");\nuser_pref("extensions.lastAppVersion", "9.0.6");\n');
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_ZOTERO_DATA_DIR: zotero,
      KEY_ZOTERO_PORT: String(mock.port),
      KEY_ZOTERO_PROFILE_ROOT: zoteroRoot,
      KEY_ZOTERO_APP: path.join(temp, "NoZotero.app"),
    },
  });
  const report = { shots };
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const sheet = page.locator(".kx-zotero-import");
    const shot = async (name) => {
      await page.waitForTimeout(250);
      await sheet.screenshot({ path: path.join(shots, `${name}.png`) });
    };
    // The scope bar is one row (never stretched into an oval), the same size in every scope,
    // its labels whole, and what the scope lists sits below it.
    const scopeBar = async () => {
      const m = await sheet.evaluate((root) => {
        const bar = root.querySelector(".kx-zotero-scope-tabs").getBoundingClientRect();
        const labels = [...root.querySelectorAll(".kx-zotero-scope-tabs [role=tab]")].map((t) => ({ text: t.textContent, clipped: t.scrollWidth > t.clientWidth || t.querySelector(".key-segmented-label").scrollWidth > t.querySelector(".key-segmented-label").clientWidth, inside: t.getBoundingClientRect().left >= bar.left - 0.5 && t.getBoundingClientRect().right <= bar.right + 0.5 }));
        const list = root.querySelector(".kx-zotero-tree")?.getBoundingClientRect();
        const sheetBox = root.closest(".key-global-drawer")?.getBoundingClientRect() ?? root.getBoundingClientRect();
        return { height: bar.height, width: bar.width, top: bar.top, labels, list: list && { top: list.top, height: list.height }, sheet: { height: sheetBox.height } };
      });
      assert.ok(m.height > 0 && m.height <= 40, `scope bar is one row (${m.height}px)`);
      for (const l of m.labels) assert.ok(!l.clipped && l.inside, `scope label "${l.text}" is whole`);
      if (m.list) assert.ok(m.list.top >= m.top + m.height && m.list.height > 100, "the list shows below the scope bar");
      return m;
    };
    const scopeBarsMatch = (a, b, c) => {
      assert.equal(a.height, b.height, "scope bar keeps its height across scopes");
      assert.equal(b.height, c.height, "scope bar keeps its height across scopes");
      assert.equal(a.width, b.width, "scope bar keeps its width across scopes");
      assert.equal(b.width, c.width, "scope bar keeps its width across scopes");
      assert.ok(Math.abs(a.sheet.height - b.sheet.height) < 2 && Math.abs(b.sheet.height - c.sheet.height) < 2, `the sheet keeps its height across scopes (${a.sheet.height}, ${b.sheet.height}, ${c.sheet.height})`);
    };
    const zoteroWorkspace = async () => (await page.evaluate(() => window.key.workspaces())).find((w) => /\/Zotero$/.test(w.root));
    const call = async (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: (await zoteroWorkspace()).id });
    const sourceOf = async (key) => {
      const index = await call("store_sources", {}).catch(() => null);
      const list = Array.isArray(index) ? index : (index?.sources ?? index?.items ?? []);
      return list.find((s) => s.originKey === key);
    };
    // The sheet sets up the window's own workspace: here the dedicated "Zotero" one (as the
    // workspaces window's "Import from Zotero…" opens it).
    const dedicated = await page.evaluate(() => window.key.zoteroWorkspace());
    const openSheet = async () => {
      await page.evaluate((id) => window.key.tabAction("switch-workspace", { workspaceId: id }), dedicated.id);
      await page.waitForTimeout(300);
      await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), dedicated.id);
      await page.locator('summary[aria-label="More ways to add"]').click();
      await page.getByRole("button", { name: "Import from Zotero…" }).click();
      await sheet.waitFor();
    };

    // 1. Import once, chosen papers: no plugin needed.
    await openSheet();
    await page.getByRole("heading", { name: "Bring in your Zotero library" }).waitFor();
    await shot("1-mode-light");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Import from Zotero" }).waitFor();
    await sheet.locator(".kx-zotero-count", { hasText: "3 items" }).waitFor();
    await shot("2-import-everything-light");
    const barEverything = await scopeBar();
    await sheet.getByRole("tab", { name: "Collections" }).click();
    await sheet.getByRole("checkbox", { name: "Thesis" }).check();
    await sheet.getByRole("button", { name: "Expand Thesis" }).click();
    await sheet.locator(".kx-zotero-count", { hasText: "1 item" }).waitFor();
    await shot("3-import-collections-light");
    const barCollections = await scopeBar();
    assert.ok(barCollections.list, "the collection list shows");
    await sheet.getByRole("tab", { name: "Papers" }).click();
    await sheet.getByRole("searchbox", { name: "Search papers" }).fill("rossi");
    await sheet.getByRole("checkbox", { name: "Reading in groups" }).check();
    await sheet.getByRole("searchbox", { name: "Search papers" }).fill("");
    await sheet.locator(".kx-zotero-count", { hasText: "1 item" }).waitFor();
    await shot("4-import-papers-light");
    scopeBarsMatch(barEverything, barCollections, await scopeBar());
    await sheet.getByRole("button", { name: "Import", exact: true }).click();
    await sheet.getByText("Imported into “Zotero”").waitFor();
    await sheet.getByRole("button", { name: "Done" }).click();
    assert.ok(await sourceOf("ITEMBBBB"), "the chosen paper was imported");
    assert.equal(await sourceOf("ITEMAAAA"), undefined, "papers not chosen stay out");
    report.importPapers = true;

    // Opened again, the sheet starts on what is set up: the import, its papers, what came along.
    await openSheet();
    const overview = sheet.locator(".kx-zotero-overview");
    await overview.getByText("Imported once").waitFor();
    await overview.locator('[data-fact="scope"]', { hasText: "1 chosen paper" }).waitFor();
    await overview.locator('[data-fact="bring"]', { hasText: "PDFs and files" }).waitFor();
    await shot("4b-overview-imported-light");
    report.overviewImport = true;

    // 2. Keep in sync: the plugin is missing, then installed, then paired with a code.
    await sheet.getByRole("button", { name: "Keep in sync instead…" }).click();
    await page.getByRole("heading", { name: "Keep in sync with Zotero" }).waitFor();
    await sheet.getByText("Install the Key Sync plugin in Zotero").waitFor();
    assert.equal(await sheet.locator(".key-property-primary").isDisabled(), true);
    await shot("5-sync-plugin-missing-light");
    const plugin = await page.evaluate(() => window.key.zoteroPlugin());
    assert.match(plugin.file, /key-sync\.xpi$/);
    // One-click install into the fake profile: the file lands, Zotero is told to look for it.
    await sheet.getByRole("button", { name: "Install in Zotero" }).click();
    await sheet.getByText("Restart Zotero to finish").waitFor();
    await access(path.join(profile, "extensions/key-sync@key.dev.xpi"));
    await shot("5b-sync-plugin-installed-light");
    const prefs = await readFile(path.join(profile, "prefs.js"), "utf8");
    assert.doesNotMatch(prefs, /lastAppBuildId/, "Zotero rescans its extensions at the next start");
    assert.match(prefs, /"extensions\.autoDisableScopes", 14\)/);
    assert.match(prefs, /"extensions\.key-sync\.restoreAutoDisableScopes", -1\)/);
    const status = await page.evaluate(() => window.key.zoteroPlugin("status"));
    assert.equal(status.install.state, "pending");
    report.install = true;
    mock.setMode("ok");
    await sheet.getByRole("button", { name: "Check again" }).click();
    await sheet.getByText("Pair Key with Zotero").waitFor();
    await sheet.getByRole("textbox", { name: "Pairing code" }).fill(mock.token);
    await shot("6-sync-pair-light");
    await sheet.getByRole("button", { name: "Pair" }).click();
    await sheet.getByText(/Connected to Zotero 9\.0\.6/).waitFor();
    await sheet.getByRole("tab", { name: "Collections" }).click();
    await sheet.getByRole("checkbox", { name: "Thesis" }).check();
    await shot("7-sync-collections-light");
    await sheet.getByRole("button", { name: "Start syncing" }).click();
    await sheet.getByText("is in sync with Zotero").waitFor();
    await shot("8-sync-done-light");
    await sheet.getByRole("button", { name: "Done" }).click();
    const article = await sourceOf("ITEMAAAA");
    assert.equal(article?.title, "Health versus income");
    // The paper imported before is outside the sync: it stays, unfollowed.
    assert.ok(await sourceOf("ITEMBBBB"));
    report.firstSync = true;
    // The status bar shows the sync with its light, and opens the same sheet on what is set up.
    const zoteroItem = page.getByRole("contentinfo", { name: "Status" }).locator('[data-status-item="zotero"]');
    await page.waitForFunction(() => document.querySelector('[data-status-item="zotero"]')?.dataset.tone === "ready", null, { timeout: 40000 });
    assert.match(await zoteroItem.innerText(), /Zotero/);
    assert.match(await zoteroItem.getAttribute("title"), /In sync with Zotero/);
    await zoteroItem.click();
    await overview.getByText("Keeping in sync").waitFor();
    await overview.locator('[data-fact="scope"]', { hasText: "Thesis" }).waitFor();
    await overview.locator('[data-fact="items"]', { hasText: /Last synced/ }).waitFor();
    await shot("8b-overview-sync-light");
    await sheet.getByRole("button", { name: "Change what syncs…" }).click();
    await sheet.getByRole("heading", { name: "Change what Key syncs" }).waitFor();
    assert.equal(await sheet.getByRole("tab", { name: "Collections" }).getAttribute("aria-selected"), "true", "the synced scope is picked");
    assert.equal(await sheet.getByRole("checkbox", { name: "Thesis" }).isChecked(), true, "the synced collection is ticked");
    const syncCollections = await scopeBar();
    assert.ok(syncCollections.list, "the collection list shows below the scope bar");
    await shot("8c-change-sync-collections-light");
    await sheet.getByRole("tab", { name: "Everything" }).click();
    const syncEverything = await scopeBar();
    await shot("8d-change-sync-everything-light");
    await sheet.getByRole("tab", { name: "Papers" }).click();
    const syncPapers = await scopeBar();
    await shot("8e-change-sync-papers-light");
    scopeBarsMatch(syncEverything, syncCollections, syncPapers);
    await sheet.getByRole("tab", { name: "Collections" }).click();
    await sheet.getByRole("button", { name: "Back" }).click();
    await overview.waitFor();
    await sheet.getByRole("button", { name: "Close" }).first().click();
    await sheet.waitFor({ state: "detached" });
    report.overviewSync = true;

    // 3. Changes in Zotero arrive: an edit, a new item in a synced collection, one moved out.
    mock.edit("ITEMAAAA", (r) => (r.fields.title = "Health and income"));
    mock.put({ key: "ITEMDDDD", itemType: "journalArticle", fields: { title: "A new paper in the thesis" }, collections: ["COLLTHES"] });
    await page.evaluate(() => window.key.zoteroPlugin("wake"));
    await page.waitForFunction(
      async (id) => {
        const all = await window.key.invoke("store_sources", {}, id);
        const list = Array.isArray(all) ? all : (all?.sources ?? all?.items ?? []);
        return list.some((s) => s.originKey === "ITEMDDDD") && list.some((s) => s.title === "Health and income");
      },
      (await zoteroWorkspace()).id,
    );
    mock.edit("ITEMAAAA", (r) => (r.deleted = true));
    await page.evaluate(() => window.key.zoteroPlugin("wake"));
    await page.waitForFunction(
      async (id) => {
        const all = await window.key.invoke("store_sources", { scope: "trashed" }, id);
        const list = Array.isArray(all) ? all : (all?.sources ?? all?.items ?? []);
        return list.some((s) => s.originKey === "ITEMAAAA" && s.trashedAt);
      },
      (await zoteroWorkspace()).id,
    ).catch(async () => {
      const status = await call("store_zotero_plugin_status");
      throw new Error(`Trash did not follow: ${JSON.stringify(status.report)}`);
    });
    report.deltas = true;

    // 4. Workspace Settings of the Zotero workspace: status, Zotero not running, pause.
    const openSettings = async () => {
      const id = (await zoteroWorkspace()).id;
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: { window: "workspace", section: "zotero", workspaceId: id } })), id);
      await page.getByRole("dialog", { name: "Workspace Settings" }).getByRole("heading", { name: "Zotero", level: 1 }).waitFor();
    };
    await openSettings();
    const group = page.locator(".kx-settings-group", { has: page.getByText("Keep in sync with Zotero") }).last();
    await group.getByText(/Syncing 1 collections|Syncing .* collections/).waitFor();
    await group.getByText(/Up to date/).waitFor();
    await group.screenshot({ path: path.join(shots, "9-settings-synced-light.png") });
    await mock.close();
    await group.getByRole("button", { name: "Sync now" }).click();
    await group.getByText(/Zotero is not running/).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-status-item="zotero"]')?.dataset.tone === "idle", null, { timeout: 40000 });
    assert.match(await zoteroItem.innerText(), /Zotero closed/);
    await group.screenshot({ path: path.join(shots, "10-settings-not-running-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(400);
    await group.screenshot({ path: path.join(shots, "11-settings-not-running-dark.png") });
    await group.getByRole("button", { name: "Pause" }).click();
    await group.getByText(/Paused/).waitFor();
    await page.waitForFunction(() => /Zotero paused/.test(document.querySelector('[data-status-item="zotero"]')?.textContent ?? ""), null, { timeout: 40000 });
    await group.getByRole("button", { name: "Resume" }).click();
    report.settings = true;

    // 4b. Another workspace can import from Zotero or sync too (its own set-up).
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: { window: "workspace", section: "zotero", workspaceId: id } })), ws.id);
    const other = page.locator(".kx-settings-group", { has: page.getByText(/Keep “.*” in sync/) }).last();
    await other.waitFor();
    await other.getByText(/Zotero syncs into “Zotero”/).waitFor();
    await other.getByRole("button", { name: "Set up…" }).waitFor();
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(300);
    await other.screenshot({ path: path.join(shots, "11b-settings-other-workspace-light.png") });
    report.anyWorkspace = true;
    await page.emulateMedia({ colorScheme: "dark" });
    await openSettings();

    // 5. Zotero back: changing the scope from Settings, in dark.
    mock = await startMockZotero({ port: mock.port, token: mock.token, library: library(pdf) });
    await group.getByRole("button", { name: "Change…" }).click();
    await sheet.getByRole("heading", { name: "Change what Key syncs" }).waitFor();
    await sheet.getByText(/Connected to Zotero/).waitFor();
    await shot("12-sync-change-dark");
    await sheet.getByRole("tab", { name: "Papers" }).click();
    await sheet.getByRole("checkbox", { name: "Annual report on literacy" }).waitFor();
    await shot("13-sync-papers-dark");
    await sheet.getByRole("button", { name: "Cancel" }).click();
    // Settings closes; the sheet in dark, on its own.
    await page.keyboard.press("Escape");
    await page.locator(".kx-settings-group").first().waitFor({ state: "detached" }).catch(() => {});
    await openSheet();
    await overview.getByText("Keeping in sync").waitFor();
    await shot("14-overview-dark");
    await sheet.getByRole("button", { name: "Change what syncs…" }).click();
    await sheet.getByText(/Connected to Zotero/).waitFor();
    await shot("15-sync-collections-dark");
    await page.keyboard.press("Escape");
    await page.emulateMedia({ colorScheme: null });

    assert.deepEqual(errors, []);
    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    await app
      .windows()[0]
      ?.screenshot({ path: path.join(temp, "failure.png") })
      .catch(() => {});
    console.error(`Failed; screenshots in ${temp}`);
    throw e;
  } finally {
    await app.close();
    await mock.close().catch(() => {});
  }
}

/** A fixture Zotero library (zotero.sqlite, its storage and the mock plugin) and a fake Zotero
 * profile; the real ones are never read. */
async function fixture(prefix) {
  const temp = await mkdtemp(path.join(tmpdir(), prefix));
  const zotero = path.join(temp, "Zotero");
  await mkdir(path.join(zotero, "storage/ATTAAAAA"), { recursive: true });
  const pdf = path.join(zotero, "storage/ATTAAAAA/paper.pdf");
  await copyFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf"), pdf);
  execFileSync("python3", ["-I", "-c", "import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.commit()", path.join(zotero, "zotero.sqlite"), SCHEMA]);
  const zoteroRoot = path.join(temp, "zotero-profiles");
  const profile = path.join(zoteroRoot, "Profiles/fake.default");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(zoteroRoot, "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/fake.default\nDefault=1\n");
  // Without the pairing code in prefs.js: it is typed once and carried to every workspace.
  await writeFile(path.join(profile, "prefs.js"), 'user_pref("extensions.lastAppVersion", "9.0.6");\n');
  const shots = path.join(temp, "shots");
  await mkdir(shots);
  return { temp, zotero, pdf, zoteroRoot, shots };
}

/** Several workspaces keep the same Zotero library in sync, with nested and overlapping
 * scopes set up in either order, from the sheet (in the workspace's own window) and from
 * Workspace Settings: each gets its own scope, and Zotero's changes reach every workspace
 * whose scope holds them. */
async function workspaces() {
  const { temp, zotero, pdf, zoteroRoot, shots } = await fixture("key-zotero-workspaces-");
  const mock = await startMockZotero({ library: library(pdf) });
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_ZOTERO_DATA_DIR: zotero,
      KEY_ZOTERO_PORT: String(mock.port),
      KEY_ZOTERO_PROFILE_ROOT: zoteroRoot,
      KEY_ZOTERO_APP: path.join(temp, "NoZotero.app"),
    },
  });
  const report = { shots };
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [home] = await page.evaluate(() => window.key.workspaces());
    // Three more workspaces, added through the workspaces window without opening them.
    const opening = app.waitForEvent("window", (w) => w.url().includes("launcher.html"));
    await page.evaluate(() => window.key.launcher("show"));
    const launcher = await opening;
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      await mkdir(path.join(temp, "elsewhere", name), { recursive: true });
      await launcher.evaluate((p) => window.key.launcher("add-folder", { path: p, open: false }), path.join(temp, "elsewhere", name));
    }
    await launcher.close().catch(() => {});
    const all = await page.evaluate(() => window.key.workspaces());
    const byName = (name) => all.find((w) => w.name === name);
    const [alpha, beta, gamma] = ["Alpha", "Beta", "Gamma"].map(byName);
    assert.ok(alpha && beta && gamma, "the workspaces are registered");
    const keysOf = async (w, scope) => {
      const index = await page.evaluate(({ id, scope }) => window.key.invoke("store_sources", scope ? { scope } : {}, id), { id: w.id, scope });
      const list = Array.isArray(index) ? index : (index?.sources ?? index?.items ?? []);
      return list.filter((s) => s.originKey && !s.trashedAt).map((s) => s.originKey).sort();
    };
    const sheet = page.locator(".kx-zotero-import");
    const status = page.getByRole("contentinfo", { name: "Status" }).locator('[data-status-item="zotero"]');
    const into = async (w) => {
      await page.evaluate((id) => window.key.tabAction("switch-workspace", { workspaceId: id }), w.id);
      await page.waitForFunction((name) => document.querySelector('[data-status-item="workspace"]')?.textContent?.includes(name) ?? true, w.name).catch(() => {});
      await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), w.id);
      await page.waitForTimeout(400);
    };
    const pick = async (names) => {
      await sheet.getByRole("tab", { name: "Collections" }).click();
      await sheet.getByRole("button", { name: "Expand all" }).click();
      for (const name of names) await sheet.getByRole("checkbox", { name, exact: true }).check();
    };
    const finish = async (w) => {
      await sheet.getByText(/Connected to Zotero/).waitFor();
      await sheet.getByRole("button", { name: "Start syncing" }).click();
      await sheet.getByText(`“${w.name}” is in sync with Zotero`).waitFor();
      await sheet.getByRole("button", { name: "Done" }).click();
      await sheet.waitFor({ state: "detached" }).catch(() => {});
    };
    // The library list of the window's workspace shows the items, without a reload.
    const listed = async (titles) => {
      for (const title of titles) await page.locator("[data-content-view]").getByText(title, { exact: true }).first().waitFor({ timeout: 20000 });
    };
    const fromSheet = async (w, names, shot) => {
      await into(w);
      await page.locator('summary[aria-label="More ways to add"]').click();
      await page.getByRole("button", { name: "Import from Zotero…" }).click();
      await sheet.waitFor();
      // The sheet sets up the window's own workspace, not another one that syncs already.
      await page.getByRole("heading", { name: "Bring in your Zotero library" }).waitFor();
      await sheet.getByText(`into “${w.name}”`).first().waitFor();
      if (shot) await sheet.screenshot({ path: path.join(shots, `${shot}.png`) });
      await sheet.getByRole("radio", { name: /Keep in sync/ }).click();
      await sheet.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("heading", { name: "Keep in sync with Zotero" }).waitFor();
      return names ? pick(names) : undefined;
    };
    const fromSettings = async (w, names) => {
      await into(w);
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: { window: "workspace", section: "zotero", workspaceId: id } })), w.id);
      const group = page.locator(".kx-settings-group", { has: page.getByText(`Keep “${w.name}” in sync`) }).last();
      await group.getByRole("button", { name: "Set up…" }).click();
      await page.getByRole("heading", { name: "Keep in sync with Zotero" }).waitFor();
      if (names) await pick(names);
    };
    const closeSettings = async () => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    };

    // 1. The home workspace syncs one sub-collection (narrow first), paired with a code.
    await fromSheet(home, ["Chapter 2"], "w1-mode-light");
    await sheet.getByText("Pair Key with Zotero").waitFor();
    await sheet.getByRole("textbox", { name: "Pairing code" }).fill(mock.token);
    await sheet.getByRole("button", { name: "Pair" }).click();
    await finish(home);
    assert.deepEqual(await keysOf(home), ["ITEMAAAA"]);
    await listed(["Health versus income"]);
    // 2. Alpha syncs the whole library (encompassing, later), through its own window's sheet:
    // the pairing code comes along.
    await fromSheet(alpha, null);
    await finish(alpha);
    assert.deepEqual(await keysOf(alpha), ["ITEMAAAA", "ITEMBBBB", "ITEMCCCC"], "Alpha has the whole library");
    await listed(["Health versus income", "Reading in groups", "Annual report on literacy"]);
    // Its status bar item is Alpha's own sync.
    await page.waitForFunction(() => /\b3 items synced/.test(document.querySelector('[data-status-item="zotero"]')?.getAttribute("title") ?? ""), null, { timeout: 40000 });
    // 3. Beta syncs a collection the others hold (Thesis, with Chapter 2), from Settings.
    await fromSettings(beta, ["Thesis"]);
    await finish(beta);
    await closeSettings();
    assert.deepEqual(await keysOf(beta), ["ITEMAAAA"], "Beta has Thesis");
    // 4. Gamma overlaps: Chapter 2 and Methods.
    await fromSettings(gamma, ["Chapter 2", "Methods"]);
    await finish(gamma);
    await closeSettings();
    assert.deepEqual(await keysOf(gamma), ["ITEMAAAA", "ITEMBBBB"], "Gamma has Chapter 2 and Methods");
    await into(gamma);
    await listed(["Health versus income", "Reading in groups"]);
    report.setUp = true;
    // Everything a sync brings for one paper, in each workspace: its PDF, note and highlights.
    for (const w of [home, alpha, beta, gamma]) {
      const index = await page.evaluate((id) => window.key.invoke("store_sources", {}, id), w.id);
      const article = (Array.isArray(index) ? index : (index?.sources ?? index?.items ?? [])).find((s) => s.originKey === "ITEMAAAA");
      assert.equal(article.fields?.filePath ?? article.filePath, pdf, `${w.name}: the PDF is linked`);
      const notes = await page.evaluate(({ id, source }) => window.key.invoke("store_notes", { sourceId: source }, id), { id: w.id, source: article.id });
      const bodies = JSON.stringify(notes);
      assert.match(bodies, /Bold/, `${w.name}: the note came along`);
      assert.match(bodies, /A highlighted sentence/, `${w.name}: the highlights came along`);
    }

    // 5. Changes in Zotero reach every workspace whose scope holds them.
    mock.edit("ITEMAAAA", (r) => (r.fields.title = "Health and income"));
    mock.put({ key: "ITEMEEEE", itemType: "journalArticle", fields: { title: "New in chapter two" }, collections: ["COLLCHAP"] });
    mock.put({ key: "ITEMFFFF", itemType: "book", fields: { title: "New in methods" }, collections: ["COLLMETH"] });
    await page.evaluate(() => window.key.zoteroPlugin("wake"));
    const expected = [
      [home, ["ITEMAAAA", "ITEMEEEE"]],
      [alpha, ["ITEMAAAA", "ITEMBBBB", "ITEMCCCC", "ITEMEEEE", "ITEMFFFF"]],
      [beta, ["ITEMAAAA", "ITEMEEEE"]],
      [gamma, ["ITEMAAAA", "ITEMBBBB", "ITEMEEEE", "ITEMFFFF"]],
    ];
    for (const [w, keys] of expected) {
      for (let i = 0; i < 120 && JSON.stringify(await keysOf(w)) !== JSON.stringify(keys); i++) await page.waitForTimeout(250);
      assert.deepEqual(await keysOf(w), keys, `${w.name} follows Zotero`);
    }
    // The open library (Gamma's) shows them without a reload.
    await listed(["Health and income", "New in chapter two", "New in methods"]);
    report.deltas = true;

    // 6. Each workspace's sheet and status item show its own sync.
    await into(beta);
    await page.waitForFunction(() => /\b2 items synced/.test(document.querySelector('[data-status-item="zotero"]')?.getAttribute("title") ?? ""), null, { timeout: 40000 });
    await status.click();
    await sheet.locator(".kx-zotero-overview").getByText("Keeping in sync").waitFor();
    await sheet.getByText("“Beta” is kept in sync with Zotero").waitFor();
    await sheet.locator('.kx-zotero-overview [data-fact="scope"]', { hasText: "Thesis" }).waitFor();
    await sheet.screenshot({ path: path.join(shots, "w2-overview-beta-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(300);
    await sheet.screenshot({ path: path.join(shots, "w3-overview-beta-dark.png") });
    await page.keyboard.press("Escape");
    await page.emulateMedia({ colorScheme: null });
    report.ownState = true;

    assert.deepEqual(errors, []);
    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    await app
      .windows()[0]
      ?.screenshot({ path: path.join(temp, "failure.png") })
      .catch(() => {});
    console.error(`Failed; screenshots in ${temp}`);
    throw e;
  } finally {
    await app.close();
    await mock.close().catch(() => {});
  }
}

// KEY_SMOKE_PART=single|workspaces runs one part.
(async () => {
  const part = process.env.KEY_SMOKE_PART;
  if (!part || part === "single") await single();
  if (!part || part === "workspaces") await workspaces();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
