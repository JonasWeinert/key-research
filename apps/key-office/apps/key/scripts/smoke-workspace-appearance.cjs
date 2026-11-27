const { electron } = require("./lib/launch.cjs");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-workspace-look-"));
  const launch = () =>
    electron.launch({
      executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
      args: process.env.KEY_ELECTRON_EXECUTABLE
        ? []
        : [path.resolve(__dirname, "..")],
      env: {
        ...process.env,
        KEY_SKIP_ONBOARDING: "1",
        KEY_USER_DATA: path.join(temp, "profile"),
        KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page
      .locator(".kx-status-item[data-status-item=workspace]")
      .waitFor();
    const [workspace] = await page.evaluate(() => window.key.workspaces());
    assert.equal(await page.locator(".key-navbar").count(), 0);
    const sidebar = await page.locator(".key-sidebar").evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        background: s.backgroundColor,
        shadow: s.boxShadow,
        border: s.borderTopWidth,
      };
    });
    assert.deepEqual(sidebar, {
      background: "rgba(0, 0, 0, 0)",
      shadow: "none",
      border: "0px",
    });
    await page.locator(".kx-status-item[data-status-item=workspace]").click();
    await page.locator(`[data-workspace-id="${workspace.id}"]`).click();
    await page.locator(".kx-status-item[data-status-item=workspace]").click();
    await page.getByRole("menuitem", { name: "Customize workspace…" }).click();
    await page.getByRole("button", { name: "Use 🔬", exact: true }).click();
    await page
      .getByRole("button", { name: "Use colour #7c3aed", exact: true })
      .click();
    await page.screenshot({ path: path.join(temp, "appearance-editor.png") });
    // The display name changes with it (the folder keeps its name).
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed library");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".key-workspace-dropdown").waitFor({ state: "hidden" });
    const saved = await page.evaluate(
      (id) => window.key.invoke("workspace_info", {}, id),
      workspace.id,
    );
    assert.equal(saved.icon, "🔬");
    assert.equal(saved.color, "#7c3aed");
    assert.equal(saved.name, "Renamed library");
    assert((await page.evaluate(() => window.key.workspaces())).some((w) => w.name === "Renamed library"), "the registry follows the rename");
    await page.screenshot({ path: path.join(temp, "sidebar.png") });
    const addedPath = path.join(temp, "Second workspace");
    await mkdir(addedPath);
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, addedPath);
    await page.locator(".kx-status-item[data-status-item=workspace]").click();
    await page
      .getByRole("menuitem", { name: "Add workspace…", exact: true })
      .click();
    // A newly added workspace asks where to open; stay in this one.
    await page.locator(".key-workspace-choice").waitFor();
    await page.getByRole("menuitem", { name: "Cancel", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.locator(".key-workspace-dropdown").waitFor({ state: "hidden" });
    const entries = await page.evaluate(() => window.key.workspaces());
    assert.equal(entries.find((w) => w.id === workspace.id).icon, "🔬");
    assert.equal(entries.find((w) => w.id !== workspace.id).icon, null);
    await app.evaluate(({ app }) => app.exit(0));
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page
      .locator(".kx-status-item[data-status-item=workspace]")
      .waitFor();
    const restored = await page.evaluate(() => window.key.workspaces());
    assert.equal(restored.find((w) => w.id === workspace.id).color, "#7c3aed");
    await page.locator(".kx-status-item[data-status-item=workspace]").click();
    assert(
      await page
        .locator(`[data-workspace-id="${workspace.id}"]`)
        .innerText()
        .then((t) => t.includes("🔬")),
    );
    await page.locator(`[data-workspace-id="${workspace.id}"]`).click();
    await page.evaluate(
      async ({ file, id }) => {
        const s = await window.key.invoke(
          "library_import_file",
          { path: file },
          id,
        );
        await window.key.openSource({
          ...s,
          documentHash: s.hash,
          workspaceId: id,
        });
      },
      {
        file: path.resolve(
          __dirname,
          "../../../../../tests/fixtures/interaction.pdf",
        ),
        id: workspace.id,
      },
    );
    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".key-sidebar-slot").getBoundingClientRect()
          .width === 0,
    );
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    const bounds = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return {
        views: w.contentView.children
          .filter((v) => v.webContents?.getURL().endsWith("/pdf.html"))
          .map((v) => v.getBounds()),
        size: w.getContentSize(),
      };
    });
    assert.equal(bounds.views.length, 1);
    assert.equal(bounds.views[0].x, 0);
    assert.equal(bounds.views[0].y, 40);
    assert.equal(bounds.views[0].height, bounds.size[1] - 40 - 24, "above the status bar");
    const report = {
      ok: true,
      temp,
      canonicalAppearance: saved.icon,
      color: saved.color,
      creationInDropdown: true,
      restartPersistence: true,
      sidebar,
      nativeBounds: bounds,
    };
    await writeFile(
      path.join(temp, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } catch (e) {
    console.error(e);
    await app
      .windows()[0]
      ?.screenshot({ path: path.join(temp, "failure.png") })
      .catch(() => {});
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch(() => (process.exitCode = 1));
