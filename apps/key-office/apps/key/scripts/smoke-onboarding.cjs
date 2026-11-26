// Run serially: native windows and focus are shared with other GUI checks.
// First run shows the welcome (welcome, library, sources, appearance); its library colour and
// appearance choice apply and persist, it fits a small window; finishing opens the library.
// Settings opens from the sidebar: every section, keyboard and search, and indexing control.
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
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 520));
    await page.waitForTimeout(500);
    await shot(page, "5-appearance-small-dark");
    const box = await welcome.boundingBox();
    const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    assert.ok(box && box.y >= 0 && box.y + box.height <= view.h && box.x >= 0 && box.x + box.width <= view.w, `welcome leaves the window: ${JSON.stringify({ box, view })}`);
    await welcome.getByRole("button", { name: "Start using Key" }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await welcome.getByRole("button", { name: "Start using Key" }).click();
    await page.getByRole("heading", { name: /^(All sources|Sources)$/ }).waitFor();
    await welcome.waitFor({ state: "detached" });
    const [first] = await page.evaluate(() => window.key.workspaces());
    assert.ok(first.color, "the library keeps the colour chosen in the welcome");
    const stored = JSON.parse(await readFile(path.join(temp, "profile", "app-settings.json"), "utf8"));
    // The welcome's choices are stored; other settings keep their defaults and are not pinned here.
    assert.deepEqual({ theme: stored.theme, onboarded: stored.onboarded, layoutModel: stored.layoutModel }, { theme: "dark", onboarded: true, layoutModel: true });

    // Settings: sidebar button, sections, search, pause indexing, appearance back to automatic.
    await page.locator(".key-sidebar").getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("heading", { name: "General" }).waitFor();
    await page.waitForTimeout(300);
    await shot(page, "6-settings-general-dark");
    await settings.getByRole("radio", { name: /Automatic/ }).click();
    await page.emulateMedia({ colorScheme: "light" });
    const nav = settings.getByRole("navigation", { name: "Settings sections" });
    await nav.getByRole("button", { name: "Libraries" }).click();
    await settings.getByText(/sources ·/).first().waitFor();
    await page.waitForTimeout(300);
    await shot(page, "7-settings-libraries");
    await nav.getByRole("button", { name: "Zotero", exact: true }).click();
    await settings.getByText("Import from Zotero").waitFor();
    await shot(page, "7b-settings-zotero");
    await nav.getByRole("button", { name: "Search & indexing" }).click();
    await settings.getByRole("checkbox", { name: "Pause indexing" }).check();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    await page.waitForFunction(async (id) => (await window.key.invoke("store_status", {}, id)).activity.paused, ws.id);
    await page.waitForTimeout(300);
    await shot(page, "8-settings-search");
    await settings.getByRole("checkbox", { name: "Pause indexing" }).uncheck();
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
    await settings.getByRole("searchbox", { name: "Search settings" }).fill("proxy");
    await settings.getByRole("heading", { name: "Web & browser" }).waitFor();
    assert.equal(await nav.getByRole("button").count(), 1);
    await shot(page, "11-settings-search-proxy");
    await settings.getByRole("searchbox", { name: "Search settings" }).fill("");
    await page.emulateMedia({ colorScheme: null });
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "detached" });
    assert.equal(JSON.parse(await readFile(path.join(temp, "profile", "app-settings.json"), "utf8")).theme, "system");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, welcome: true, darkApplied: true, persisted: true, settings: true }));
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
