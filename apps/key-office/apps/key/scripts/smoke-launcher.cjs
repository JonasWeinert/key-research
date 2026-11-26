// Run serially: native windows and focus are shared with other GUI checks.
// The workspaces window (KEY_LAUNCHER=1; other smokes open a workspace window directly): it is
// the first window, and fast; the first-run welcome; creating a workspace opens it and the
// launcher steps aside; closing the last workspace window brings it back with the workspace's
// cached counts; a second launch shows it again; rename, the look and Remove from list (the
// folder stays); keyboard opening; "Reopen windows from last time" restores as before.
// Screenshots (light and dark, small and large) go to the temp folder printed at the end.
const { _electron: electron } = require("playwright-core");
const { spawn } = require("node:child_process");
const { mkdtemp, mkdir, access, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-launcher-"));
  const parent = path.join(temp, "workspaces");
  const env = { ...process.env, KEY_LAUNCHER: "1", KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: parent };
  const appPath = path.resolve(__dirname, "..");
  const launch = () => electron.launch({ executablePath: process.env.KEY_ELECTRON_EXECUTABLE, args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [appPath], env });
  const isLauncher = (p) => /launcher\.html$/.test(p.url());
  const isShell = (p) => /index\.html$/.test(p.url());
  const windows = (app) =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), url: w.webContents.getURL().split("/").pop(), visible: w.isVisible() })));
  const waitFor = async (app, test, what) => {
    for (let i = 0; i < 150; i++) {
      const found = app.windows().find(test);
      if (found) return found;
      await delay(100);
    }
    throw Error(`No ${what} window: ${JSON.stringify(await windows(app))}`);
  };
  const closeShells = (app) =>
    app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().endsWith("index.html")) w.close();
    });
  // Playwright pins the page's colour scheme, so the page follows it too.
  const theme = async (app, value, page) => {
    await app.evaluate(({ nativeTheme }, v) => (nativeTheme.themeSource = v), value);
    for (const p of page ? [page] : app.windows()) await p.emulateMedia({ colorScheme: value === "system" ? null : value }).catch(() => {});
  };
  // A page capture has no window vibrancy behind it: shots use the opaque sidebar colour.
  const shot = async (page, name) => {
    await page.evaluate(() => document.documentElement.classList.remove("kx-vibrancy"));
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(temp, `${name}.png`) });
  };

  const t0 = Date.now();
  let app = await launch();
  const result = { temp };
  try {
    // 1. The workspaces window comes first, fast, with the welcome for a first run.
    let launcher = await app.firstWindow();
    launcher.setDefaultTimeout(20000);
    assert(isLauncher(launcher), `the first window is the workspaces window: ${launcher.url()}`);
    await launcher.getByRole("region", { name: "Welcome" }).waitFor();
    result.launcherVisibleMs = Date.now() - t0;
    const marks = await app.evaluate(() => globalThis.__keyStartup ?? {});
    result.mainMarks = marks;
    assert.deepEqual((await windows(app)).map((w) => w.url), ["launcher.html"], "no workspace window, so no library host");
    const errors = [];
    launcher.on("pageerror", (e) => errors.push(String(e)));
    for (const mode of ["light", "dark"]) {
      await theme(app, mode);
      await shot(launcher, `welcome-${mode}`);
    }
    await theme(app, "system");

    // 2. Create a workspace through the sheet: it opens, and the launcher steps aside.
    await launcher.keyboard.press("Meta+N");
    const sheet = launcher.getByRole("dialog", { name: "New workspace" });
    await sheet.waitFor();
    await sheet.getByRole("textbox", { name: "Name" }).fill("Thesis");
    await launcher.waitForFunction(() => document.querySelector(".kx-launcher-location code")?.textContent?.replace(/\u200e/g, "").endsWith("/Thesis"));
    await sheet.getByRole("radio", { name: "Use 🔬" }).click();
    await sheet.getByRole("radio", { name: "Colour #7c3aed" }).click();
    for (const mode of ["light", "dark"]) {
      await theme(app, mode);
      await shot(launcher, `create-sheet-${mode}`);
    }
    await theme(app, "system");
    const opening = app.waitForEvent("window", isShell);
    await sheet.getByRole("button", { name: "Create", exact: true }).click().catch(() => {});
    let shell = await opening;
    shell.setDefaultTimeout(30000);
    await shell.getByRole("region", { name: "Home", exact: true }).or(shell.locator(".key-sidebar")).first().waitFor();
    await access(path.join(parent, "Thesis", ".key"));
    const thesis = (await shell.evaluate(() => window.key.workspaces())).find((w) => w.name === "Thesis");
    assert(thesis, "the new workspace is registered");
    assert.equal(thesis.icon, "🔬");
    for (let i = 0; i < 50 && (await windows(app)).some((w) => w.url === "launcher.html"); i++) await delay(100);
    assert.deepEqual((await windows(app)).map((w) => w.url), ["index.html"], "the launcher closed once the workspace opened");
    // A note, so the cached summary has something to count.
    await shell.evaluate((id) => window.key.invoke("store_note_save", { id: null, sourceId: null, title: "First thought", body: "" }, id), thesis.id);

    // 3. Closing the last workspace window brings the launcher back; the app keeps running.
    const back = app.waitForEvent("window", isLauncher);
    await closeShells(app);
    launcher = await back;
    launcher.setDefaultTimeout(20000);
    launcher.on("pageerror", (e) => errors.push(String(e)));
    const row = launcher.getByRole("option", { name: "Thesis" });
    await row.waitFor();
    await launcher.waitForFunction(() => /1 note/.test(document.querySelector('[role="option"]')?.textContent ?? ""));
    assert.match(await row.textContent(), /Opened today/);

    // A folder dropped (or chosen) joins the list without opening.
    const other = path.join(temp, "Elsewhere", "Reading group");
    await mkdir(other, { recursive: true });
    await launcher.evaluate((p) => window.key.launcher("add-folder", { path: p, open: false }), other);
    await launcher.getByRole("option", { name: "Reading group" }).waitFor();
    for (const [mode, size] of [
      ["light", [860, 540]],
      ["dark", [860, 540]],
      ["light", [1200, 760]],
      ["dark", [720, 460]],
    ]) {
      await theme(app, mode);
      await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s[0], s[1]), size);
      await shot(launcher, `list-${mode}-${size[0]}`);
    }
    await theme(app, "system");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 540));

    // 4. Rename (the folder keeps its name) and customise, through the sheets the row menu opens.
    const send = (command, id) =>
      app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("launcher.html")).webContents.send("launcher-command", value), { command, id });
    await send("rename", thesis.id);
    const rename = launcher.getByRole("dialog", { name: "Rename workspace" });
    await rename.getByRole("textbox", { name: "Name" }).fill("Doctoral thesis");
    await shot(launcher, "rename-sheet");
    await rename.getByRole("button", { name: "Rename", exact: true }).click();
    await launcher.getByRole("option", { name: "Doctoral thesis" }).waitFor();
    await access(path.join(parent, "Thesis", ".key"));
    await rename.waitFor({ state: "detached" });
    await send("appearance", thesis.id);
    const look = launcher.getByRole("dialog", { name: "Customise workspace" });
    await look.getByRole("radio", { name: "Use 🧠" }).click();
    await look.getByRole("button", { name: "Save", exact: true }).click();
    await look.waitFor({ state: "detached" });
    await launcher.waitForFunction(() => document.querySelector('[role="option"]')?.textContent?.includes("🧠"));

    // 5. Remove from list (confirmed): the folder stays on disk.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await launcher.getByRole("option", { name: "Reading group" }).hover();
    await launcher.locator("body").click({ position: { x: 5, y: 300 } });
    const options = () => launcher.getByRole("option").evaluateAll((rows) => rows.map((r) => [r.getAttribute("aria-label"), r.getAttribute("aria-selected")]));
    await launcher.keyboard.press("ArrowDown");
    assert.deepEqual((await options()).find(([, s]) => s === "true")[0], "Reading group");
    await launcher.keyboard.press("Meta+Backspace");
    await launcher.getByRole("option", { name: "Reading group" }).waitFor({ state: "detached" });
    await access(other);

    // 6. A second launch with no workspace window open shows the launcher (single instance).
    await launcher.evaluate(() => window.close());
    for (let i = 0; i < 50 && (await windows(app)).length; i++) await delay(100);
    assert.equal((await windows(app)).length, 0, "the app keeps running with no windows");
    const electronPath = process.env.KEY_ELECTRON_EXECUTABLE ?? require("electron");
    const appearing = app.waitForEvent("window", isLauncher);
    const second = spawn(electronPath, process.env.KEY_ELECTRON_EXECUTABLE ? [] : [appPath], { env, stdio: "ignore" });
    const code = await new Promise((resolve) => second.once("exit", resolve));
    assert.equal(code, 0, "the second instance hands over and exits");
    launcher = await appearing;
    launcher.setDefaultTimeout(20000);

    // 7. Keyboard: Return opens the selected workspace again, with its arrangement.
    await launcher.getByRole("option", { name: "Doctoral thesis" }).waitFor();
    const reopening = app.waitForEvent("window", isShell);
    // The launcher steps aside as the workspace opens, possibly before the key press returns.
    await launcher.keyboard.press("Enter").catch(() => {});
    shell = await reopening;
    shell.setDefaultTimeout(30000);
    await shell.locator(".key-sidebar").waitFor();
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("index.html")).getTitle()), "Doctoral thesis");
    // Window › Workspaces brings the launcher over an open workspace; it marks the open one.
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label === "Window").submenu.items.find((i) => i.label === "Workspaces").click());
    launcher = await waitFor(app, isLauncher, "launcher");
    await launcher.locator('[data-workspace-id] .kx-launcher-badge[data-kind="open"]').waitFor();
    await shot(launcher, "launcher-over-workspace");
    // One list: a rename here reaches the open workspace window at once (its switcher, its title).
    await launcher.evaluate((id) => window.key.launcher("rename", { id, name: "Dissertation" }), thesis.id);
    await shell.waitForFunction(() => document.querySelector(".key-workspace-home strong")?.textContent === "Dissertation");
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("index.html")).getTitle()), "Dissertation");

    // 8. "Reopen windows from last time": the next launch restores as before.
    await send("settings");
    const settings = launcher.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("radio", { name: /Reopen windows from last time/ }).check();
    await shot(launcher, "settings-sheet");
    await settings.getByRole("button", { name: "Done" }).click();
    await settings.waitFor({ state: "detached" });
    assert.equal(JSON.parse(await readFile(path.join(temp, "profile", "app-settings.json"), "utf8")).openAtLaunch, "restore");
    await app.close();
    app = await launch();
    const restored = await app.firstWindow();
    restored.setDefaultTimeout(30000);
    assert(isShell(restored), `the workspace window comes back first: ${restored.url()}`);
    await restored.locator(".key-sidebar").waitFor();
    assert.equal((await restored.evaluate(() => window.key.tabs())).workspaceId, thesis.id);
    assert.deepEqual(errors, []);

    // 9. Idle: the launcher alone uses next to no CPU.
    const opened = app.waitForEvent("window", isLauncher);
    await closeShells(app);
    launcher = await opened;
    await launcher.locator(".kx-launcher-list").waitFor();
    await delay(3000);
    const cpu = await app.evaluate(async ({ app }) => {
      app.getAppMetrics();
      await new Promise((r) => setTimeout(r, 3000));
      return app.getAppMetrics().map((m) => ({ type: m.type, cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10 }));
    });
    result.idleCpu = cpu;
    const total = cpu.reduce((sum, m) => sum + m.cpu, 0);
    assert(total < 3, `idle CPU ${total}% (${JSON.stringify(cpu)})`);
    console.log(JSON.stringify({ ok: true, ...result }, null, 1));
  } finally {
    await app.close().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
