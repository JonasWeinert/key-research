// Run serially: native windows and focus are shared with other GUI checks.
// First run starts in the workspaces window, whose "Create your first workspace" hands over to
// the welcome in the new workspace's window (welcome, library, sources, appearance); its library colour and
// appearance choice apply and persist, it fits a small window; finishing opens the library.
// Key Settings opens from the sidebar: every section, keyboard and search, a search that
// finds Workspace Settings; Workspace Settings edits one workspace of two, the other unchanged.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-onboarding-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const launcher = await app.firstWindow();
    launcher.setDefaultTimeout(20000);
    assert.match(launcher.url(), /launcher\.html$/, "a first run starts in the workspaces window");
    await launcher.getByRole("region", { name: "Welcome" }).waitFor();
    await shot(launcher, "0-workspaces-first-run");
    const opening = app.waitForEvent("window", (p) => /index\.html$/.test(p.url()));
    // The launcher steps aside as the workspace opens, possibly before the click returns.
    await launcher.getByRole("button", { name: "Create your first workspace" }).click().catch(() => {});
    const page = await opening;
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("index.html")).setSize(1440, 900));
    // Playwright pins a light colour scheme by default; follow the app's own setting instead.
    await page.emulateMedia({ colorScheme: null });

    const welcome = page.getByRole("dialog", { name: "Welcome to Key", exact: true });
    await welcome.getByRole("heading", { name: "Welcome to Key" }).waitFor();
    await page.waitForTimeout(500);
    await shot(page, "1-welcome");
    await welcome.getByRole("button", { name: "Get started" }).click();
    await welcome.getByRole("heading", { name: "Your library" }).waitFor();
    await welcome.locator(".kx-onboarding-card").getByText("Personal", { exact: true }).waitFor();
    // A colour for the library is stored with it.
    await welcome.getByRole("radiogroup", { name: "Library colour" }).getByRole("radio").nth(2).click();
    await page.waitForTimeout(400);
    await shot(page, "2-library");
    await welcome.getByRole("button", { name: "Continue" }).click();
    await welcome.getByRole("heading", { name: "Bring in your sources" }).waitFor();
    await page.waitForTimeout(400);
    await shot(page, "3-sources");
    // Back and forward keep the place.
    await welcome.getByRole("button", { name: "Back" }).click();
    await welcome.getByRole("heading", { name: "Your library" }).waitFor();
    await welcome.getByRole("button", { name: "Continue" }).click();
    await welcome.getByRole("button", { name: "Continue" }).click();
    await welcome.getByRole("radio", { name: /Dark/ }).click();
    // The choice reaches every view through prefers-color-scheme.
    await page.waitForFunction(() => matchMedia("(prefers-color-scheme: dark)").matches);
    await page.waitForTimeout(400);
    await shot(page, "4-appearance-dark");
    // A small window drops the drawing and keeps the copy and buttons inside.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("index.html")).setSize(760, 520));
    await page.waitForTimeout(500);
    await shot(page, "5-appearance-small-dark");
    const box = await welcome.boundingBox();
    const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    assert.ok(box && box.y >= 0 && box.y + box.height <= view.h && box.x >= 0 && box.x + box.width <= view.w, `welcome leaves the window: ${JSON.stringify({ box, view })}`);
    await welcome.getByRole("button", { name: "Start using Key" }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("index.html")).setSize(1440, 900));
    await welcome.getByRole("button", { name: "Start using Key" }).click();
    await page.getByRole("heading", { name: /^(All sources|Sources)$/ }).waitFor();
    await welcome.waitFor({ state: "detached" });
    const [first] = await page.evaluate(() => window.key.workspaces());
    assert.ok(first.color, "the library keeps the colour chosen in the welcome");
    const stored = JSON.parse(await readFile(path.join(temp, "profile", "app-settings.json"), "utf8"));
    // The welcome's choices are stored; other settings keep their defaults and are not pinned here.
    assert.deepEqual({ theme: stored.theme, onboarded: stored.onboarded, layoutModel: stored.layoutModel }, { theme: "dark", onboarded: true, layoutModel: true });

    // Key Settings: sidebar button, sections, search, appearance back to automatic.
    await page.locator(".key-sidebar").getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Key Settings", exact: true });
    await settings.getByRole("heading", { name: "General" }).waitFor();
    assert.equal(await settings.locator("[data-settings-scope]").textContent(), "Applies to Key on this Mac");
    await page.waitForTimeout(300);
    await shot(page, "6-settings-general-dark");
    await settings.getByRole("radio", { name: /Automatic/ }).click();
    await page.emulateMedia({ colorScheme: "light" });
    const nav = settings.getByRole("navigation", { name: "Key Settings sections" });
    // No workspace pickers inside Key Settings: what belongs to one workspace is elsewhere.
    for (const section of ["Workspaces", "Citations", "Search & indexing", "Privacy & network"]) {
      await nav.getByRole("button", { name: section, exact: true }).click();
      await settings.getByRole("heading", { name: section, level: 1 }).waitFor();
      assert.equal(await settings.getByRole("combobox", { name: "Library" }).count(), 0, `${section} has no library picker`);
    }
    await nav.getByRole("button", { name: "Workspaces" }).click();
    await settings.getByText(/sources ·/).first().waitFor();
    await page.waitForTimeout(300);
    await shot(page, "7-settings-workspaces");
    await nav.getByRole("button", { name: "Search & indexing" }).click();
    await settings.getByRole("checkbox", { name: "Use the layout model" }).waitFor();
    await shot(page, "8-settings-search");
    await nav.getByRole("button", { name: "Privacy & network" }).click();
    await settings.getByRole("checkbox", { name: "Look up new sources automatically" }).waitFor();
    await shot(page, "8a-settings-privacy");
    await nav.getByRole("button", { name: "Web & browser" }).click();
    await settings.getByRole("heading", { name: "Library access" }).waitFor();
    await page.waitForTimeout(300);
    await shot(page, "8b-settings-web");
    await nav.getByRole("button", { name: "Services & API keys" }).click();
    await settings.getByRole("heading", { name: "Storage" }).waitFor();
    await shot(page, "8c-settings-services");
    await nav.getByRole("button", { name: "AI assistant" }).click();
    await settings.getByRole("textbox", { name: "Model" }).waitFor();
    await shot(page, "9-settings-ai");
    // Arrow keys move through the sections; the search narrows them and opens the first match.
    await nav.getByRole("button", { name: "AI assistant" }).focus();
    await page.keyboard.press("ArrowDown");
    await settings.getByText(/^Version /).waitFor();
    await shot(page, "10-settings-about");
    const search = settings.getByRole("searchbox", { name: "Search Key Settings" });
    await search.fill("proxy");
    await settings.getByRole("heading", { name: "Web & browser" }).waitFor();
    assert.equal(await nav.locator("button[data-section]").count(), 1);
    await shot(page, "11-settings-search-proxy");
    // A search that matches the other window says so, and goes there.
    await search.fill("pause");
    const elsewhere = nav.getByRole("group", { name: "Found in Workspace Settings" });
    await elsewhere.getByRole("button", { name: /Indexing & lookups/ }).waitFor();
    await shot(page, "11b-settings-search-elsewhere");
    await elsewhere.getByRole("button", { name: /Indexing & lookups/ }).click();
    const wsSettings = page.getByRole("dialog", { name: "Workspace Settings", exact: true });
    await wsSettings.getByRole("heading", { name: "Indexing & lookups" }).waitFor();
    await settings.waitFor({ state: "detached" });

    // Workspace Settings: for the window's workspace, named in its head, with indexing control.
    const [ws] = await page.evaluate(() => window.key.workspaces());
    assert.equal(await wsSettings.locator("[data-settings-scope]").textContent(), `Applies to ${ws.name}`);
    await wsSettings.getByRole("checkbox", { name: "Pause indexing" }).check();
    await page.waitForFunction(async (id) => (await window.key.invoke("store_status", {}, id)).activity.paused, ws.id);
    await page.waitForTimeout(300);
    await shot(page, "12-workspace-indexing");
    await wsSettings.getByRole("checkbox", { name: "Pause indexing" }).uncheck();
    await page.keyboard.press("Escape");
    await wsSettings.waitFor({ state: "detached" });

    // Two workspaces: what changes in one stays out of the other.
    const zotero = await page.evaluate(() => window.key.zoteroWorkspace());
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: { window: "workspace", section: "indexing" } })));
    await wsSettings.getByRole("heading", { name: "Indexing & lookups" }).waitFor();
    await wsSettings.getByRole("combobox", { name: "Workspace to edit" }).selectOption(zotero.id);
    await page.waitForFunction((name) => document.querySelector("[data-settings-scope]")?.textContent === `Applies to ${name}`, zotero.name);
    await wsSettings.getByRole("checkbox", { name: "Find PDFs automatically when adding" }).check();
    // Lookups follow Key Settings until the workspace chooses its own.
    const lookups = wsSettings.locator(".kx-settings-row", { hasText: "Look up new sources in OpenAlex" });
    await lookups.getByText("Using app default · On").waitFor();
    await lookups.getByRole("button", { name: "Change" }).click();
    await lookups.getByRole("checkbox", { name: "Look up new sources in OpenAlex" }).uncheck();
    await page.waitForTimeout(300);
    await shot(page, "13-workspace-override");
    const nav2 = wsSettings.getByRole("navigation", { name: "Workspace Settings sections" });
    await nav2.getByRole("button", { name: "Citations & export" }).click();
    await wsSettings.locator(".kx-settings-row", { hasText: "Style" }).getByRole("button", { name: "Change" }).first().click();
    await wsSettings.getByRole("button", { name: "Citation style" }).click();
    await wsSettings.getByRole("searchbox", { name: "Search citation styles" }).fill("ieee");
    await wsSettings.locator(".kx-cite-list button[data-style=ieee]").click();
    await page.waitForFunction(async (id) => (await window.key.invoke("store_workspace_settings", {}, id)).own.citationStyle === "ieee", zotero.id);
    await shot(page, "14-workspace-citations");
    const own = (id) => page.evaluate((id) => window.key.invoke("store_workspace_settings", {}, id), id);
    const [mine, theirs] = [await own(zotero.id), await own(ws.id)];
    assert.deepEqual([mine.own.findPdfOnAdd, mine.own.lookups, mine.effective.citationStyle], [true, false, "ieee"]);
    assert.deepEqual([theirs.own.findPdfOnAdd, theirs.own.lookups, theirs.effective.citationStyle], [false, null, "apa"], "the other workspace is unchanged");
    // The app file stays as it was: nothing workspace-scoped is written there.
    const app2 = JSON.parse(await readFile(path.join(temp, "profile", "app-settings.json"), "utf8"));
    assert.ok(app2.findPdfOnAdd !== true && app2.citationStyle !== "ieee" && app2.openalex !== false, "workspace settings stay out of app-settings.json");
    // Back to the app default.
    await wsSettings.getByRole("button", { name: "Use app default" }).click();
    await page.waitForFunction(async (id) => (await window.key.invoke("store_workspace_settings", {}, id)).own.citationStyle === null, zotero.id);
    await page.emulateMedia({ colorScheme: "dark" });
    await nav2.getByRole("button", { name: "General" }).click();
    await wsSettings.getByRole("textbox", { name: "Workspace name" }).waitFor();
    await page.waitForTimeout(300);
    await shot(page, "15-workspace-general-dark");
    await page.emulateMedia({ colorScheme: null });
    await page.keyboard.press("Escape");
    await wsSettings.waitFor({ state: "detached" });
    assert.equal(JSON.parse(await readFile(path.join(temp, "profile", "app-settings.json"), "utf8")).theme, "system");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, welcome: true, darkApplied: true, persisted: true, settings: true }));
  } catch (e) {
    await app.windows().at(-1)?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
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
