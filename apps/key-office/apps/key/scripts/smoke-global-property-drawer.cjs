const { _electron: electron } = require("playwright-core");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-global-property-"));
  const app = await electron.launch({
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
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // Page details start folded; the property's Configure button lives in them.
    await page.evaluate(() => localStorage.setItem("key.page.details.open", "1"));
    await page.getByRole("button", { name: "Browse all sources", exact: true }).click();
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    await page.locator(".kx-status-item[data-status-item=workspace]").click();
    await page.locator(`[data-workspace-id="${ws.id}"]`).click();
    // Switching workspace navigates asynchronously; settle on this workspace's Sources tab.
    let owner;
    for (let i = 0; i < 30 && !owner; i++) {
      await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
      await page.waitForTimeout(200);
      const t = await page.evaluate(() => window.key.tabs());
      const view = t.tabs.find((x) => x.id === t.activeTabId)?.views.find((v) => v.id === t.activeViewId);
      if (view?.content?.section === "sources" && view.content.workspaceId === ws.id) owner = t.activeTabId;
    }
    await page.getByRole("heading", { name: /^(All sources|Sources)$/ }).waitFor();
    await page.evaluate(
      async ({ workspaceId, file, owner }) => {
        await window.key.invoke(
          "workspace_save_attribute",
          { name: "Review", config: { type: "text" } },
          workspaceId,
        );
        const source = await window.key.invoke(
          "library_import_file",
          { path: file },
          workspaceId,
        );
        await window.key.openSource({
          ...source,
          documentHash: source.hash,
          workspaceId,
        });
        const state = await window.key.tabs();
        const pdf = state.activeViewId;
        await window.key.tabAction("activate", { tabId: owner });
        await window.key.tabAction("split", { viewId: pdf });
      },
      {
        workspaceId: ws.id,
        file: path.resolve(
          __dirname,
          "../../../../../tests/fixtures/interaction.pdf",
        ),
        owner,
      },
    );
    let pdf;
    for (let i = 0; i < 100; i++) {
      pdf = app.windows().find((w) => w.url().endsWith("/pdf.html"));
      if (pdf) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await pdf.waitForFunction(() => window.__PDFJS_READY__ === true);
    const before = await page.evaluate(() => window.key.tabs());
    await page.locator(".kx-row:visible").first().click({ position: { x: 24, y: 20 } });
    await page
      .getByRole("button", { name: "Configure Review property", exact: true })
      .click();
    const drawer = page.getByRole("dialog", {
      name: "Edit property",
      exact: true,
    });
    await drawer.waitFor();
    // The property editor is a sheet: centred on the window, just below the toolbar.
    await page.waitForFunction(() => {
      const box = document.querySelector(".key-global-drawer").getBoundingClientRect();
      return Math.abs(box.x + box.width / 2 - innerWidth / 2) < 2 && box.y >= 40;
    });
    const bounds = await drawer.boundingBox();
    assert(bounds.y >= 40 && bounds.y < 60);
    assert(bounds.width > 400);
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.filter((v) =>
            v.getVisible(),
          ).length,
      ),
      0,
      "Native PDF cannot paint over global drawer",
    );
    await page.locator(".key-native-overlay-frame").waitFor();
    assert(
      await page
        .locator(".key-native-overlay-frame")
        .evaluate((el) => el.naturalWidth > 100),
    );
    assert.equal(
      await page.locator(".key-shell-body").evaluate((el) => el.inert),
      true,
    );
    await page.screenshot({ path: path.join(temp, "property-over-split.png") });
    // Tab switching retains the globally owned property and its workspace scope.
    // The modal dims and disables the tab bar, so switch through the shell API (as ⌘⇧] would).
    const home = before.tabs.find((t) => t.id !== owner);
    if (home) {
      assert.ok((await page.locator(".kx-tabs").evaluateAll((els) => els.map((el) => el.inert))).every(Boolean), "every group's tab strip is inert");
      await page.evaluate((tabId) => window.key.tabAction("activate", { tabId }), home.id);
      await drawer.waitFor();
      assert.equal(
        await drawer
          .getByRole("textbox", { name: "Property name", exact: true })
          .inputValue(),
        "Review",
      );
      await page.evaluate((tabId) => window.key.tabAction("activate", { tabId }), owner);
    }
    // Configure agent fill saves the property and opens the fill sheet for it, over the window.
    const sheet = page.locator(".key-global-drawer");
    await sheet.getByRole("button", { name: "Configure agent fill", exact: false }).click();
    const fill = page.getByRole("dialog", { name: "Fill a property", exact: true });
    await fill.waitFor();
    assert.equal(await fill.getByLabel("Property to fill").inputValue(), "Review");
    await page.screenshot({ path: path.join(temp, "agent-detail.png") });
    await fill.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(".key-global-drawer").waitFor({ state: "detached" });
    await page.waitForFunction(
      () => !document.querySelector(".key-shell-body").inert,
    );
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.filter((v) =>
            v.getVisible(),
          ).length,
      ),
      1,
    );
    assert.equal(await page.locator(".key-native-overlay-frame").count(), 0);
    const after = await page.evaluate(() => window.key.tabs());
    assert.deepEqual(
      after.tabs.find((t) => t.id === owner).views.map((v) => v.id),
      before.tabs.find((t) => t.id === owner).views.map((v) => v.id),
    );
    const defs = await page.evaluate(
      (id) => window.key.invoke("workspace_attributes", {}, id),
      ws.id,
    );
    assert.ok(defs.some((d) => d.name === "Review"));
    assert.deepEqual(errors, []);
    const report = {
      ok: true,
      temp,
      globalBounds: bounds,
      nativeLayering: true,
      tabSwitchPreservesProperty: true,
      fillSheetOpens: true,
      nativeViewsRestored: true,
    };
    await writeFile(
      path.join(temp, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } catch (e) {
    console.error("Artifacts", temp);
    await app
      .windows()[0]
      ?.screenshot({ path: path.join(temp, "failure.png") })
      .catch(() => {});
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
