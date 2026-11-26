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

(async () => {
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
    const zoteroWorkspace = async () => (await page.evaluate(() => window.key.workspaces())).find((w) => /\/Zotero$/.test(w.root));
    const call = async (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: (await zoteroWorkspace()).id });
    const sourceOf = async (key) => {
      const index = await call("store_sources", {}).catch(() => null);
      const list = Array.isArray(index) ? index : (index?.sources ?? index?.items ?? []);
      return list.find((s) => s.originKey === key);
    };
    const openSheet = async () => {
      await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
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
    await sheet.getByRole("tab", { name: "Collections" }).click();
    await sheet.getByRole("checkbox", { name: "Thesis" }).check();
    await sheet.getByRole("button", { name: "Expand Thesis" }).click();
    await sheet.locator(".kx-zotero-count", { hasText: "1 item" }).waitFor();
    await shot("3-import-collections-light");
    await sheet.getByRole("tab", { name: "Papers" }).click();
    await sheet.getByRole("searchbox", { name: "Search papers" }).fill("rossi");
    await sheet.getByRole("checkbox", { name: "Reading in groups" }).check();
    await sheet.getByRole("searchbox", { name: "Search papers" }).fill("");
    await sheet.locator(".kx-zotero-count", { hasText: "1 item" }).waitFor();
    await shot("4-import-papers-light");
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

    // 4. Settings: status, Zotero not running, pause.
    const openSettings = async () => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
      await page.getByRole("button", { name: "Libraries" }).click();
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
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
