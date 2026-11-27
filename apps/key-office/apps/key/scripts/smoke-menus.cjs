// Run serially: native windows and focus are shared with other GUI checks.
// Every menu and palette surface opens and shares one look (menu.css): the same radius,
// row height, highlight and separators. Opens each in light and dark, checks the shared
// metrics, and keeps a close-up screenshot of each (KEY_MENU_SHOTS=<dir> to collect them).
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-menus-"));
  const shots = process.env.KEY_MENU_SHOTS || temp;
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const report = { opened: [], failed: {}, metrics: {} };
  let page;
  try {
    page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    await call("store_collection_create", { name: "Thesis", parentId: null });
    await call("store_note_save", { id: null, sourceId: null, title: "Draft", body: "Some text to select in the note." });
    await call("library_import_file", { path: path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf") });
    await page.reload();
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const sidebar = page.locator(".key-sidebar");
    const send = (event, value) => app.evaluate(({ BrowserWindow }, [event, value]) => BrowserWindow.getAllWindows()[0].webContents.send(event, value), [event, value]);
    const theme = (dark) => page.evaluate((dark) => window.key.setAppSettings({ theme: dark ? "dark" : "light" }), dark);
    const closeAll = async () => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    };
    // A close-up of one surface, with a margin of the page around it.
    const capture = async (name, locator, mode) => {
      await locator.first().waitFor();
      await page.waitForTimeout(260);
      const box = await locator.first().boundingBox();
      const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      const x = Math.max(0, box.x - 24);
      const y = Math.max(0, box.y - 24);
      await page.screenshot({ path: path.join(shots, `${name}-${mode}.png`), clip: { x, y, width: Math.min(view.w - x, box.width + 48), height: Math.min(view.h - y, box.height + 48) } });
      if (mode === "light")
        report.metrics[name] = await locator.first().evaluate((el) => {
          const s = getComputedStyle(el);
          const row = el.querySelector(":scope [data-menu-row], :scope [role^=menuitem], :scope [role=option], :scope > button, :scope button");
          return { radius: s.borderRadius, row: row ? Math.round(row.getBoundingClientRect().height) : null };
        });
    };
    const surfaces = [
      [
        "sidebar-context",
        async () => {
          await sidebar.locator(".kx-library-row").getByRole("button", { name: "Show collections" }).click().catch(() => {});
          await sidebar.locator(".kx-tree-label", { hasText: "Thesis" }).click({ button: "right" });
          return page.locator(".kx-context-menu");
        },
      ],
      [
        "create-menu",
        async () => {
          await sidebar.getByRole("button", { name: "Create item" }).first().click();
          return page.locator(".key-create-menu");
        },
      ],
      [
        "workspace-switcher",
        async () => {
          await page.locator(".kx-status-item[data-status-item=workspace]").click();
          return page.locator(".key-workspace-dropdown");
        },
      ],
      [
        "commands",
        async () => {
          await send("command", "palette");
          return page.locator(".key-modal");
        },
      ],
      [
        "search-palette",
        async () => {
          await sidebar.getByRole("button", { name: "Search" }).click();
          await page.locator(".kx-palette :is(input, textarea)").fill("dra");
          await page.waitForTimeout(500);
          return page.locator(".key-modal");
        },
      ],
      [
        "library-add",
        async () => {
          await sidebar.locator(".kx-library-row .kx-tree-label").click();
          await page.locator(".kx-add .kx-menu > summary").first().click();
          return page.locator(".kx-add .kx-menu-popover");
        },
      ],
      [
        "library-suggest",
        async () => {
          const field = page.locator(".kx-search-field :is(input, textarea)").first();
          await field.click();
          await field.fill("inter");
          return page.locator(".kx-suggest");
        },
      ],
      [
        "columns",
        async () => {
          await page.getByRole("button", { name: "Table", exact: true }).click();
          await page.getByRole("button", { name: "Columns", exact: true }).click();
          return page.locator(".kx-columns-popover");
        },
      ],
      [
        "item-context",
        async () => {
          await page.getByRole("button", { name: "List", exact: true }).click().catch(() => {});
          await page.locator("[data-item-id], .kx-row, [role=row]").filter({ hasText: /interaction|Interaction/ }).first().click({ button: "right" });
          return page.locator(".kx-item-menu, .kx-context-menu");
        },
      ],
      [
        "column-menu",
        async () => {
          await page.getByRole("button", { name: "Table", exact: true }).click();
          await page.getByRole("button", { name: "Title column options" }).click();
          return page.locator(".kx-context-menu[aria-label='Title column']");
        },
      ],
      [
        "sort-menu",
        async () => {
          await page.getByRole("button", { name: /^Sort|Date added/ }).first().click();
          return page.locator(".kx-sort-popover");
        },
      ],
      [
        "status-popover",
        async () => {
          await page.locator(".kx-status-item").filter({ hasText: /Looking up|Indexing|searchable/ }).first().click();
          return page.locator(".kx-status-popover");
        },
      ],
      [
        "slash-menu",
        async () => {
          await sidebar.locator(".kx-nav-item", { hasText: "Draft" }).click();
          const prose = page.locator(".kx-note-page .ProseMirror");
          await prose.click();
          await page.waitForFunction(() => !!getSelection()?.rangeCount);
          await page.keyboard.press("End");
          await page.keyboard.type(" /");
          return page.locator(".ne-menu");
        },
      ],
      [
        "note-bubble",
        async () => {
          const prose = page.locator(".kx-note-page .ProseMirror");
          await prose.click();
          await page.waitForFunction(() => !!getSelection()?.rangeCount);
          await page.keyboard.press("Home");
          await page.keyboard.press("Shift+End");
          return page.locator(".ne-bubble");
        },
      ],
    ];
    for (const mode of ["light", "dark"]) {
      await theme(mode === "dark");
      await page.emulateMedia({ colorScheme: mode });
      await page.waitForTimeout(300);
      for (const [name, open] of surfaces) {
        try {
          // One retry: a surface may still be closing from the one before.
          const surface = await open().catch(async () => {
            await closeAll();
            return open();
          });
          await capture(name, surface, mode);
          if (mode === "light") report.opened.push(name);
        } catch (e) {
          report.failed[`${name}-${mode}`] = String(e.message).split("\n")[0];
          await page.screenshot({ path: path.join(shots, `failed-${name}-${mode}.png`) }).catch(() => {});
        }
        await closeAll();
      }
    }
    await theme(false);
    // The shared look: one radius for every menu, one row height for plain menus.
    const plain = ["sidebar-context", "create-menu", "library-add", "item-context", "column-menu"];
    for (const name of plain) if (report.metrics[name]) assert.equal(report.metrics[name].radius, "10px", `${name} radius`);
    for (const name of plain) if (report.metrics[name]?.row) assert.ok(Math.abs(report.metrics[name].row - 24) <= 1, `${name} row height ${report.metrics[name].row}`);
    assert.deepEqual(errors, []);
    // Nothing stays floating once its view is left (the note's bubble, a menu).
    await sidebar.locator(".kx-library-row .kx-tree-label").click();
    await page.waitForTimeout(400);
    const left = await page.locator(".ne-bubble:visible, .kx-context-menu, .kx-item-menu").evaluateAll((els) => els.map((el) => el.className));
    const debug = await page.evaluate(() => {
      const r = (el) => el && JSON.stringify(el.getBoundingClientRect());
      return { editor: r(document.querySelector(".ProseMirror")), bubble: r(document.querySelector(".ne-bubble")), cls: document.querySelector(".ne-bubble")?.className, style: document.querySelector(".ne-bubble")?.getAttribute("style"), active: document.activeElement?.className };
    });
    assert.deepEqual(left, [], `a menu or bubble outlived its view ${JSON.stringify(debug)}`);
    assert.deepEqual(report.failed, {});
    console.log(JSON.stringify({ ok: true, temp, shots, ...report }));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error(JSON.stringify({ ok: false, temp, report, error: String(error?.stack || error) }));
    process.exitCode = 1;
  } finally {
    await app.close();
  }
})();
