// Settings › About Key shows Key's licence and opens the bundled third-party notices.
// shell.openPath is stubbed, so nothing opens outside the app.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-acknowledgements-"));
  const profile = path.join(temp, "profile");
  await mkdir(profile);
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: profile, KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    await app.evaluate(({ shell }) => {
      globalThis.__opened = [];
      shell.openPath = async (p) => (globalThis.__opened.push(p), "");
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
    const settings = page.locator(".kx-settings");
    await settings.getByRole("button", { name: "About Key" }).click();
    await settings.getByText("MIT licence", { exact: false }).waitFor();
    const open = settings.locator(".kx-settings-row", { hasText: "Acknowledgements" }).getByRole("button", { name: "Open" });
    assert.ok(await open.isEnabled(), "the notices file is present in this build");
    if (process.env.KEY_SMOKE_SHOTS) await page.screenshot({ path: path.join(process.env.KEY_SMOKE_SHOTS, "about-licences.png") });
    await open.click();
    let opened = [];
    for (let i = 0; i < 50 && opened.length === 0; i++) {
      opened = await app.evaluate(() => globalThis.__opened);
      if (opened.length === 0) await page.waitForTimeout(100);
    }
    assert.equal(opened.length, 1);
    assert.match(opened[0], /THIRD-PARTY-NOTICES\.txt$/);
    console.log(`acknowledgements smoke passed: ${opened[0]}`);
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
