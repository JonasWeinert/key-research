// Run serially: native windows and focus are shared with other GUI checks.
// The shipped CSL styles and locales are data files beside the app (KEY_CITATION_DATA_DIR).
// Pointed at a folder that does not exist, Key still formats citations with its own basic
// author–date style, and Settings › Citations says the styles were not found. Screenshots in
// the temp folder.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-citations-missing-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_OPENALEX_ENABLED: "0",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_CITATION_DATA_DIR: path.join(temp, "no-citation-data"),
    },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    const styles = await call("store_cite_styles");
    assert.equal(styles.data.available, false);
    assert.match(styles.data.error, /^Citation styles not found/);
    assert.deepEqual(styles.styles.map((s) => s.id), ["key-author-date"]);
    assert.equal(styles.style, "key-author-date");
    assert.deepEqual(styles.locales.map((l) => l.code), ["en-US"]);

    const source = await call("store_create", {
      source: { kind: "reference", itemType: "article", title: "Measuring attention in reading", creators: [{ family: "Doe", given: "Jane", role: "author" }], year: 2020, containerTitle: "Cognition", volume: "201", pages: "104-118" },
    });
    // Even a style asked for by name renders with the basic one.
    const out = await call("store_cite_render", { style: "apa", locale: "de-DE", citations: [{ items: [{ id: source.id, locator: "4" }] }], bibliography: true });
    assert.equal(out.citations[0].text, "(Doe, 2020, p. 4)");
    assert.match(out.bibliography.entries[0].text, /^Doe, J\. \(2020\)\. Measuring attention in reading\./);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
    await page.locator(".kx-settings-nav button[data-section=citations]").click();
    await page.locator(".kx-cite-missing", { hasText: "Citation styles not found" }).waitFor();
    await page.getByRole("button", { name: "Citation style" }).filter({ hasText: "Basic author–date" }).waitFor();
    await page.locator("[data-preview=citation]", { hasText: "(Narang et al., 2021, p. 626)" }).waitFor();
    await shot(page, "1-settings-missing");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(200);
    await shot(page, "2-settings-missing-dark");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp }));
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
