// Run serially: native windows and focus are shared with other GUI checks.
// Overlays dismiss the same way everywhere (ui/dismiss.ts, main/dismiss-relay.ts): a press
// outside (in the shell, in the sidebar, or inside a PDF view, which is another webContents),
// scrolling away, Escape; scrolling inside one keeps it. Covers a sidebar context menu, the
// workspace switcher, a library column menu, the note editor's slash menu, the palette, and
// the PDF reader's selection toolbar (closed from the shell, and by scrolling the page).
const { electron } = require("./lib/launch.cjs");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-dismiss-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const report = {};
  let page;
  try {
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const sidebar = page.locator(".key-sidebar");
    const gone = (locator, what) => locator.waitFor({ state: "detached", timeout: 4000 }).catch(() => {
      throw Error(`${what} should have closed`);
    });
    const stays = async (locator, what) => {
      await page.waitForTimeout(250);
      assert.ok(await locator.isVisible(), `${what} should stay open`);
    };
    // A blank spot in the sidebar, under its rows.
    const sidebarBlank = async () => {
      const box = await page.locator(".kx-sidebar-scroll").boundingBox();
      return { x: box.x + box.width / 2, y: box.y + box.height - 24 };
    };

    await call("store_collection_create", { name: "Thesis", parentId: null });
    await call("store_note_save", { id: null, sourceId: null, title: "Draft", body: "Some text." });
    const source = await call("library_import_file", { path: path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf") });
    await page.reload();
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();

    // A sidebar context menu: a press in the content area closes it, and that press does
    // nothing else (the Search button under it does not open the palette).
    await sidebar.locator(".kx-library-row").getByRole("button", { name: "Show collections" }).click();
    const thesis = sidebar.locator(".kx-tree-label", { hasText: "Thesis" });
    const menu = page.locator(".kx-context-menu[aria-label='Thesis collection']");
    await thesis.click({ button: "right" });
    await menu.waitFor();
    await page.screenshot({ path: path.join(temp, "1-sidebar-menu.png") });
    await page.mouse.click(900, 500);
    await gone(menu, "the sidebar menu (press in the content)");
    await thesis.click({ button: "right" });
    await menu.waitFor();
    await sidebar.getByRole("button", { name: "Search" }).click();
    await gone(menu, "the sidebar menu (press in the sidebar)");
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".kx-palette").count(), 0, "the dismissing press is swallowed");
    // Scrolling inside keeps it; scrolling elsewhere closes it; a small nudge does not.
    await thesis.click({ button: "right" });
    await menu.waitFor();
    const menuBox = await menu.boundingBox();
    await page.mouse.move(menuBox.x + 20, menuBox.y + 10);
    await page.mouse.wheel(0, 400);
    await stays(menu, "the menu while scrolling inside it");
    await page.mouse.move(900, 500);
    await page.mouse.wheel(0, 8);
    await stays(menu, "the menu after a small nudge");
    await page.mouse.wheel(0, 200);
    await gone(menu, "the menu (scrolling away)");
    // Escape closes it and gives focus back.
    await thesis.click({ button: "right" });
    await menu.waitFor();
    await page.keyboard.press("Escape");
    await gone(menu, "the menu (Escape)");
    // The app going to the background closes it, as macOS menus do (in test mode only the
    // test sends that; the person switching apps does not).
    await thesis.click({ button: "right" });
    await menu.waitFor();
    await app.evaluate(() => globalThis.__keyTest.resignActive());
    await gone(menu, "the menu (app in the background)");
    report.sidebarMenu = true;

    // The workspace switcher: a press in the sidebar closes it; Escape returns focus to it.
    const trigger = page.locator(".kx-status-item[data-status-item=workspace]");
    const dropdown = page.locator(".key-workspace-dropdown");
    await trigger.click();
    await dropdown.waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(temp, "1b-workspace-menu.png") });
    // The menu rises from the status bar over the sidebar's foot: press above it.
    const blank = await sidebarBlank();
    const over = await dropdown.boundingBox();
    await page.mouse.click(blank.x, Math.min(blank.y, over.y - 24));
    await gone(dropdown, "the workspace switcher (press in the sidebar)");
    await trigger.click();
    await dropdown.waitFor();
    await page.keyboard.press("Escape");
    await gone(dropdown, "the workspace switcher (Escape)");
    assert.ok(await trigger.evaluate((el) => el === document.activeElement), "focus goes back to the switcher");
    // Its trigger toggles it shut rather than closing and reopening it.
    await trigger.click();
    await dropdown.waitFor();
    await trigger.click();
    await gone(dropdown, "the workspace switcher (its trigger)");
    report.switcher = true;

    // A library column menu: scrolling the table away closes it; the chevron toggles it.
    await sidebar.locator(".kx-library-row .kx-tree-label").click();
    await page.getByRole("button", { name: "Table", exact: true }).click();
    const columnButton = page.getByRole("button", { name: "Title column options" });
    const columnMenu = page.locator(".kx-context-menu[aria-label='Title column']");
    await columnButton.click();
    await columnMenu.waitFor();
    await page.screenshot({ path: path.join(temp, "2-column-menu.png") });
    await page.mouse.move(700, 600);
    await page.mouse.wheel(0, 120);
    await gone(columnMenu, "the column menu (scrolling away)");
    await columnButton.click();
    await columnMenu.waitFor();
    await columnButton.click();
    await gone(columnMenu, "the column menu (its button)");
    await page.waitForTimeout(200);
    assert.equal(await columnMenu.count(), 0, "the button does not reopen it");
    report.columnMenu = true;

    // The palette (a sheet): Escape and a press on the scrim close it.
    await sidebar.getByRole("button", { name: "Search" }).click();
    await page.locator(".kx-palette :is(input, textarea)").waitFor();
    await page.keyboard.press("Escape");
    await gone(page.locator(".kx-palette"), "the palette (Escape)");
    await sidebar.getByRole("button", { name: "Search" }).click();
    await page.locator(".kx-palette :is(input, textarea)").waitFor();
    await page.mouse.click(1380, 880);
    await gone(page.locator(".kx-palette"), "the palette (press on the scrim)");
    report.palette = true;

    // The note editor's slash menu: scrolling inside its list keeps it, a press in the
    // sidebar closes it and ends the suggestion (typing on doesn't bring it back).
    await sidebar.locator(".kx-nav-item", { hasText: "Draft" }).click();
    const prose = page.locator(".kx-note-page .ProseMirror");
    await prose.waitFor();
    await prose.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" /");
    const slash = page.locator(".ne-menu");
    await slash.waitFor();
    const slashBox = await slash.boundingBox();
    await page.mouse.move(slashBox.x + 40, slashBox.y + 60);
    await page.mouse.wheel(0, 300);
    await stays(slash, "the slash menu while scrolling its list");
    await page.screenshot({ path: path.join(temp, "3-slash-menu.png") });
    const blank2 = await sidebarBlank();
    await page.mouse.click(blank2.x, blank2.y);
    await gone(slash, "the slash menu (press in the sidebar)");
    await prose.click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");
    await page.waitForTimeout(250);
    assert.equal(await slash.count(), 0, "the suggestion ended");
    report.slashMenu = true;

    // A PDF beside the library: presses inside the PDF view (another webContents) close the
    // shell's menus, and presses in the shell close the reader's.
    const libraryTab = (await page.evaluate(() => window.key.tabs())).activeTabId;
    await page.evaluate(async (source) => {
      await window.key.openSource({ ...source, documentHash: source.hash });
      const state = await window.key.tabs();
      const pdf = state.activeViewId;
      await window.key.tabAction("split", { viewId: pdf });
    }, source);
    let pdf;
    for (let i = 0; i < 100 && !pdf; i++) {
      pdf = app.windows().find((w) => w.url().endsWith("/pdf.html"));
      if (!pdf) await new Promise((r) => setTimeout(r, 100));
    }
    await pdf.waitForFunction(() => window.__PDFJS_READY__ === true, undefined, { timeout: 30000 });
    await pdf.locator(".pdfjs-text-run").first().waitFor({ timeout: 30000 });
    const pdfBounds = await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) => v.webContents?.getURL().endsWith("/pdf.html"));
      return view.getBounds();
    });
    assert.ok(pdfBounds.width > 100, "the PDF view is shown");
    void libraryTab;
    await thesis.click({ button: "right" });
    await menu.waitFor();
    await pdf.mouse.click(Math.min(300, pdfBounds.width / 2), Math.min(400, pdfBounds.height / 2));
    await gone(menu, "the sidebar menu (press inside the PDF view)");
    await thesis.click({ button: "right" });
    await menu.waitFor();
    await pdf.mouse.move(Math.min(300, pdfBounds.width / 2), Math.min(400, pdfBounds.height / 2));
    await pdf.mouse.wheel(0, 300);
    await gone(menu, "the sidebar menu (scrolling the PDF)");
    report.pdfPressClosesShell = true;

    // The reader's selection toolbar: a press in the shell closes it; so does scrolling the page.
    const toolbar = pdf.locator(".pdfjs-selection-toolbar");
    const select = async () => {
      // Two runs of text well inside the view, a few lines apart.
      const [a, b] = await pdf.evaluate(() => {
        const boxes = [...document.querySelectorAll(".pdfjs-text-run")]
          .map((run) => run.getBoundingClientRect())
          .filter((r) => r.width > 40 && r.top > 80 && r.bottom < innerHeight - 120 && r.left > 0 && r.right < innerWidth);
        return [boxes[0], boxes[Math.min(3, boxes.length - 1)]].map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
      });
      await pdf.mouse.move(a.x + 1, a.y + a.height / 2);
      await pdf.mouse.down();
      await pdf.mouse.move((a.x + b.x + b.width) / 2, b.y + b.height / 2, { steps: 4 });
      await pdf.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 4 });
      await pdf.mouse.up();
      await toolbar.waitFor({ timeout: 5000 }).catch(async (e) => {
        await pdf.screenshot({ path: path.join(temp, "failure-pdf.png") });
        throw Error(`${e.message} ${JSON.stringify({ a, b })}`);
      });
    };
    await select();
    await pdf.screenshot({ path: path.join(temp, "4-reader-toolbar.png") });
    const blank3 = await sidebarBlank();
    await page.mouse.click(blank3.x, blank3.y);
    await gone(toolbar, "the reader's selection toolbar (press in the shell)");
    await select();
    await pdf.mouse.move(Math.min(300, pdfBounds.width / 2), Math.min(500, pdfBounds.height - 40));
    // It follows its passage while it scrolls and closes once the passage is out of view.
    await pdf.mouse.wheel(0, 1600);
    await gone(toolbar, "the reader's selection toolbar (scrolling the page)");
    report.readerToolbar = true;

    assert.equal(await page.evaluate(() => window.__keyOpenOverlays?.()), 0, "nothing is left registered");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, ...report }));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error(JSON.stringify({ ok: false, temp, report, error: String(error?.stack || error) }));
    process.exitCode = 1;
  } finally {
    await app.close();
  }
})();
