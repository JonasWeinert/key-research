// Run serially: native windows and focus are shared with other GUI checks.
// Editor groups, like VS Code's: Split Right (menu, strip button, context menu) moves a tab
// into a group of its own; native readers follow group and sash geometry (also while the
// sash is dragged); double-click evens the groups out; the focused group gets new tabs and
// Cmd-1…9; tabs drag between strips and to a group's side to open another group; a group
// closes with its last tab; an open document is focused where it is; a reader's details and
// notes are a panel in its own tab that pops out into a tab and docks back; and the
// arrangement survives a relaunch, as do the split tabs of an older version (as tabs).
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-tab-groups-"));
  const fixtures = ["Group study A.pdf", "Group study B.pdf"].map((name) => path.join(temp, name));
  await writeFile(fixtures[0], await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  await writeFile(fixtures[1], await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/scientific-unlinked.pdf")));
  const profile = path.join(temp, "profile");
  const launch = () =>
    electron.launch({
      executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
      args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
      env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: profile, KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
    });
  let app = await launch();
  let page;
  // The shell page with the native views composited where they sit, as the window shows it.
  const shot = async (name) => {
    const layers = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const out = [];
      for (const v of w.contentView.children) {
        if (!v.getVisible?.() || !v.webContents || v.webContents === w.webContents) continue;
        // Capturing fails now and then (UnknownVizError) while other windows are busy: try again.
        let image;
        for (let i = 0; !image; i++) {
          try { image = await v.webContents.capturePage(); }
          catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 300)); }
        }
        out.push({ ...v.getBounds(), image: image.toDataURL() });
      }
      return out;
    });
    const base = await page.screenshot();
    const png = await page.evaluate(
      async ({ base, layers }) => {
        const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
        const first = await load(base);
        const scale = first.width / innerWidth;
        const canvas = document.createElement("canvas");
        canvas.width = first.width;
        canvas.height = first.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(first, 0, 0);
        for (const l of layers) ctx.drawImage(await load(l.image), l.x * scale, l.y * scale, l.width * scale, l.height * scale);
        return canvas.toDataURL("image/png").split(",")[1];
      },
      { base: `data:image/png;base64,${base.toString("base64")}`, layers },
    );
    await writeFile(path.join(temp, `${name}.png`), Buffer.from(png, "base64"));
  };
  const tabs = () => page.evaluate(() => window.key.tabs());
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const until = async (check, what) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await page.waitForTimeout(100);
    }
    throw Error(`Timed out: ${what}`);
  };
  const clickMenu = (...labels) =>
    app.evaluate(({ Menu }, labels) => {
      let items = Menu.getApplicationMenu().items;
      let item;
      for (const label of labels) {
        item = items.find((i) => i.label === label);
        items = item?.submenu?.items ?? [];
      }
      if (!item) throw Error(`No menu item ${labels.join(" › ")}`);
      item.click();
      return item.accelerator ?? null;
    }, labels);
  const pdfBounds = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]
        .contentView.children.filter((v) => v.webContents?.getURL().endsWith("/pdf.html") && v.getVisible())
        .map((v) => ({ url: v.webContents.id, ...v.getBounds() }))
        .sort((a, b) => a.x - b.x),
    );
  const dom = () =>
    page.evaluate(() => ({
      sidebar: document.querySelector(".key-sidebar-slot").getBoundingClientRect().right,
      sashes: [...document.querySelectorAll(".key-group-sash:not(.key-panel-sash)")].map((s) => s.getBoundingClientRect().toJSON()),
      strips: [...document.querySelectorAll("[data-group-strip]")].map((s) => s.getBoundingClientRect().toJSON()),
      width: innerWidth,
      height: innerHeight,
    }));
  const near = (a, b, what, slack = 1) => assert(Math.abs(a - b) <= slack, `${what}: ${a} vs ${b}`);
  try {
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.emulateMedia({ colorScheme: null });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const created = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: fixtures });
    const sources = await Promise.all(created.map((s) => page.evaluate(({ ws, id }) => window.key.invoke("store_source", { id }, ws), { ws: ws.id, id: s.id })));
    const openPdf = (source) =>
      page.evaluate(({ ws, s }) => window.key.openSource({ documentId: s.fileHash, documentHash: s.fileHash, title: s.title, workspaceId: ws }), { ws: ws.id, s: source });
    await openPdf(sources[0]);
    await openPdf(sources[1]);
    let state = await tabs();
    assert.equal(state.groups.length, 1);
    assert.deepEqual(state.tabs.map((t) => t.views[0].kind), ["home", "pdf", "pdf"]);
    for (let i = 0; i < 100 && app.windows().filter((p) => p.url().endsWith("/pdf.html")).length < 2; i++) await page.waitForTimeout(100);
    for (const reader of app.windows().filter((p) => p.url().endsWith("/pdf.html"))) await reader.waitForFunction(() => window.__PDFJS_READY__ === true);

    // View › Split Right (⌘\): the focused tab moves into a new group to the right.
    assert.equal(await clickMenu("View", "Split Right"), "CmdOrCtrl+\\");
    await until(async () => (await tabs()).groups.length === 2, "two groups");
    state = await tabs();
    const [left, right] = state.groups;
    assert.deepEqual(left.tabIds.length, 2);
    assert.deepEqual(right.tabIds.length, 1);
    assert.equal(state.activeGroupId, right.id, "the new group has focus");
    assert.deepEqual(state.groups.map((g) => g.size), [0.5, 0.5]);
    // Both groups show a reader: the left shows the first PDF again.
    await page.evaluate((tabId) => window.key.tabAction("activate", { tabId }), state.tabs.find((t) => t.groupId === left.id && t.views[0].kind === "pdf").id);
    await page.evaluate((groupId) => window.key.tabAction("focus-group", { groupId }), right.id);
    async function verifyGroups(label) {
      await settle();
      const [d, views] = [await dom(), await pdfBounds()];
      assert.equal(views.length, 2, `${label}: both readers shown ${JSON.stringify(views)}`);
      const [a, b] = views;
      near(a.x, d.sidebar, `${label}: left reader starts at the sidebar`);
      near(a.x + a.width, d.sashes[0].left, `${label}: left reader meets the sash`);
      near(b.x, d.sashes[0].right, `${label}: right reader starts after the sash`);
      near(b.x + b.width, d.width, `${label}: right reader reaches the window edge`);
      for (const v of views) {
        near(v.y, 40, `${label}: reader below the strips`);
        near(v.y + v.height, d.height - 24, `${label}: reader reaches the status bar`);
      }
      near(d.strips[0].right, d.sashes[0].left, `${label}: first strip ends at the sash`);
      near(d.strips[1].left, d.sashes[0].right, `${label}: second strip starts after it`);
      near(d.strips[1].top, d.strips[0].top, `${label}: strips share one height`);
      return { label, views, sashes: d.sashes };
    }
    const geometry = [await verifyGroups("split")];
    await shot("two-groups-light");
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForTimeout(400);
    await shot("two-groups-dark");
    await page.evaluate(() => window.key.setAppSettings({ theme: "light" }));

    // Dragging the sash moves the native readers with it, frame by frame.
    const sash = page.locator(".key-group-sash").first();
    const box = await sash.boundingBox();
    await page.mouse.move(box.x + 3, 300);
    await page.mouse.down();
    await page.mouse.move(box.x - 60, 300, { steps: 4 });
    await settle();
    await page.waitForTimeout(80);
    const midDrag = await pdfBounds();
    const midSash = (await dom()).sashes[0];
    near(midDrag[0].x + midDrag[0].width, midSash.left, "mid-drag: the reader follows the sash", 2);
    await page.mouse.move(box.x - 150, 300, { steps: 6 });
    await page.mouse.up();
    await until(async () => (await tabs()).groups[0].size < 0.45, "the sizes reach main");
    geometry.push(await verifyGroups("dragged sash"));
    assert(geometry[1].views[0].width < geometry[0].views[0].width - 100, "the left group narrowed");
    await sash.dblclick();
    await until(async () => (await tabs()).groups.every((g) => Math.abs(g.size - 0.5) < 0.001), "double-click evens the groups");
    geometry.push(await verifyGroups("equalized"));

    // Focus: clicking the left strip focuses its group; a new tab opens there; ⌘1 acts there.
    await page.locator(`[data-group-strip="${left.id}"] .kx-tabs-list`).click({ position: { x: 5, y: 5 }, force: true });
    await until(async () => (await tabs()).activeGroupId === left.id, "the left group takes focus");
    await page.evaluate(() => window.key.tabAction("new"));
    state = await tabs();
    assert.equal(state.tabs.filter((t) => t.groupId === left.id).length, 3, "a new tab opens in the focused group");
    assert.equal(await clickMenu("View", "Go to Tab", "Tab 1"), "CmdOrCtrl+1");
    await until(async () => {
      const s = await tabs();
      return s.groups[0].activeTabId === s.groups[0].tabIds[0];
    }, "⌘1 shows the focused group's first tab");
    assert.equal((await tabs()).groups[1].activeTabId, right.activeTabId, "the other group keeps its tab");

    // A tab dragged onto the other group's strip moves there.
    const homeTab = (await tabs()).groups[0].tabIds.at(-1);
    const from = await page.locator(`[data-tab-id="${homeTab}"]`).boundingBox();
    const target = await page.locator(`[data-group-strip="${right.id}"] .kx-tab`).first().boundingBox();
    await page.mouse.move(from.x + 30, from.y + 14);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width + 20, target.y + 14, { steps: 16 });
    const marker = page.locator(".key-tab-insert-marker");
    for (let i = 0; i < 60 && !(await marker.isVisible()); i++) await page.mouse.move(target.x + target.width + 20 + (i % 2) * 3, target.y + 14, { steps: 2 });
    await marker.waitFor();
    await page.mouse.up();
    await until(async () => (await tabs()).groups[1].tabIds.includes(homeTab), "the tab joins the right group");
    state = await tabs();
    assert.equal(state.activeGroupId, right.id);
    assert.equal(state.groups[1].activeTabId, homeTab);

    // Dragged to a group's right side, a tab opens a third group there.
    const pdfTab = state.groups[1].tabIds.find((id) => state.tabs.find((t) => t.id === id).views[0].kind === "pdf");
    const pdfBox = await page.locator(`[data-tab-id="${pdfTab}"]`).boundingBox();
    const d = await dom();
    await page.mouse.move(pdfBox.x + 30, pdfBox.y + 14);
    await page.mouse.down();
    await page.mouse.move(d.width - 40, 500, { steps: 20 });
    // Under load the drag starts after the pointer got there: keep the pointer moving over
    // the side until the preview shows (it follows pointer moves, not time).
    const preview = page.locator(".key-pane-drop-preview");
    for (let i = 0; i < 60 && !(await preview.isVisible()); i++) await page.mouse.move(d.width - 40 - (i % 2) * 4, 500 + (i % 3), { steps: 2 });
    await preview.waitFor();
    await shot("drop-preview");
    await page.mouse.up();
    await until(async () => (await tabs()).groups.length === 3, "three groups");
    state = await tabs();
    assert.deepEqual(state.groups[2].tabIds, [pdfTab]);
    assert.equal(state.activeGroupId, state.groups[2].id);
    await settle();
    const three = await dom();
    assert.equal(three.sashes.length, 2);
    await shot("three-groups-light");
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForTimeout(400);
    await shot("three-groups-dark");
    await page.evaluate(() => window.key.setAppSettings({ theme: "light" }));

    // An open document is focused where it is, not opened twice.
    await page.evaluate((groupId) => window.key.tabAction("focus-group", { groupId }), state.groups[0].id);
    await openPdf(sources[1]);
    state = await tabs();
    assert.equal(state.activeGroupId, state.groups[2].id, "the document's group takes focus");
    assert.equal(state.tabs.filter((t) => t.views[0].kind === "pdf").length, 2);

    // The group closes with its last tab; its width goes to its neighbour.
    await page.evaluate((tabId) => window.key.tabAction("close", { tabId }), pdfTab);
    await until(async () => (await tabs()).groups.length === 2, "the emptied group closes");
    state = await tabs();
    assert.ok(Math.abs(state.groups.reduce((s, g) => s + g.size, 0) - 1) < 1e-9);

    // Dragging a tab along its own strip reorders it.
    const drag = async (fromBox, x, y, waitFor) => {
      await page.mouse.move(fromBox.x + 30, fromBox.y + 14);
      await page.mouse.down();
      await page.mouse.move(x, y, { steps: 18 });
      if (waitFor) await page.locator(waitFor).waitFor();
      await page.mouse.up();
    };
    const [firstTab, secondTab] = state.groups[0].tabIds;
    const second = await page.locator(`[data-tab-id="${secondTab}"]`).boundingBox();
    await drag(await page.locator(`[data-tab-id="${firstTab}"]`).boundingBox(), second.x + second.width - 8, second.y + 14);
    await until(async () => (await tabs()).groups[0].tabIds.indexOf(firstTab) === 1, "the tab moves after its neighbour");

    // A group's last tab dropped on another group's content joins it, and its group closes.
    state = await tabs();
    assert.equal(state.groups[1].tabIds.length, 1);
    const lastTab = state.groups[1].tabIds[0];
    let d2 = await dom();
    await drag(await page.locator(`[data-tab-id="${lastTab}"]`).boundingBox(), (d2.sidebar + d2.sashes[0].left) / 2, 420, ".key-pane-drop-preview");
    await until(async () => (await tabs()).groups.length === 1, "the emptied group closes");
    state = await tabs();
    assert.equal(state.groups[0].tabIds.at(-1), lastTab, "the tab joins the other group at its end");
    assert.equal(state.groups[0].activeTabId, lastTab);
    await settle();
    assert.equal((await page.locator(".key-native-overlay-frame").count()), 0, "the still frames go when the drag ends");

    // Dropped at the left side of a group's content, a tab opens a group of its own there.
    d2 = await dom();
    await drag(await page.locator(`[data-tab-id="${lastTab}"]`).boundingBox(), d2.sidebar + 24, 420, ".key-pane-drop-preview");
    await until(async () => (await tabs()).groups.length === 2, "a group opens on the left");
    state = await tabs();
    assert.deepEqual(state.groups[0].tabIds, [lastTab], "the new group is on the left");
    // Put it back on the right (by strip drag and a split), as the rest of this smoke expects.
    d2 = await dom();
    await drag(await page.locator(`[data-tab-id="${lastTab}"]`).boundingBox(), d2.width - 24, 420, ".key-pane-drop-preview");
    await until(async () => {
      const s = await tabs();
      return s.groups.length === 2 && s.groups[1].tabIds.join() === lastTab;
    }, "the tab's group moves to the right");
    state = await tabs();

    // A reader's details and notes: a panel inside the reader's own tab.
    await page.evaluate((groupId) => window.key.tabAction("focus-group", { groupId }), state.groups[0].id);
    await openPdf(sources[0]);
    state = await tabs();
    const readerTab = state.tabs.find((t) => t.id === state.activeTabId);
    assert.equal(readerTab.views[0].kind, "pdf");
    const tabCount = state.tabs.length;
    // (The reader's own Details & notes button is exercised by smoke-source-page.)
    await page.evaluate(
      ({ ws, s }) => window.key.tabAction("open-source-page", { workspaceId: ws, sourceId: s.id, title: s.title, read: true, pdf: { documentHash: s.fileHash, documentId: s.fileHash, title: s.title, workspaceId: ws } }),
      { ws: ws.id, s: sources[0] },
    );
    await until(async () => (await tabs()).tabs.find((t) => t.id === readerTab.id)?.panel, "the panel opens in the reader's tab");
    state = await tabs();
    assert.equal(state.tabs.length, tabCount, "no tab is added for the panel");
    const panel = state.tabs.find((t) => t.id === readerTab.id).panel;
    await page.locator(`[data-content-view="${panel.id}"] .kx-source-page-title`).waitFor();
    await settle();
    const withPanel = await pdfBounds();
    const panelBox = await page.locator(`[data-content-view="${panel.id}"]`).boundingBox();
    const panelSash = await page.locator(".key-panel-sash").boundingBox();
    const leftReader = withPanel[0];
    near(leftReader.x + leftReader.width, panelSash.x, "the reader meets the panel's sash");
    near(panelBox.x, panelSash.x + panelSash.width, "the panel starts after it");
    near(panelBox.x + panelBox.width, (await dom()).sashes[0].left, "the panel ends at the group's edge");
    near(panelBox.y, 40, "the panel sits below the strip");
    await shot("panel-light");
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForTimeout(400);
    await shot("panel-dark");
    await page.evaluate(() => window.key.setAppSettings({ theme: "light" }));

    // Pop out: the panel's page becomes a tab of its own, right after the reader's.
    await page.locator(`[data-content-view="${panel.id}"]`).getByRole("button", { name: "Open details and notes in their own tab" }).click();
    await until(async () => !(await tabs()).tabs.find((t) => t.id === readerTab.id)?.panel, "the panel leaves the reader");
    state = await tabs();
    const group0 = state.groups.find((g) => g.tabIds.includes(readerTab.id));
    const at = group0.tabIds.indexOf(readerTab.id);
    const popped = state.tabs.find((t) => t.id === group0.tabIds[at + 1]);
    assert.equal(popped.views[0].id, panel.id, "the page is the tab after the reader");
    assert.equal(state.activeTabId, popped.id);
    await page.locator(`[data-content-view="${panel.id}"] .kx-source-page-title`).waitFor();
    await shot("popped-out-light");
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForTimeout(400);
    await shot("popped-out-dark");
    await page.evaluate(() => window.key.setAppSettings({ theme: "light" }));

    // And back: the reader's Details & notes docks the page again; its tab goes.
    await page.evaluate(
      ({ ws, s }) => window.key.tabAction("open-source-page", { workspaceId: ws, sourceId: s.id, title: s.title, read: true, pdf: { documentHash: s.fileHash, documentId: s.fileHash, title: s.title, workspaceId: ws } }),
      { ws: ws.id, s: sources[0] },
    );
    await until(async () => (await tabs()).tabs.find((t) => t.id === readerTab.id)?.panel?.id === panel.id, "the page docks back");
    assert(!(await tabs()).tabs.some((t) => t.id === popped.id), "its tab closed");

    // Relaunch: groups, their sizes and the reader's panel come back.
    await page.evaluate(() => window.key.tabAction("resize-groups", { sizes: [0.6, 0.4], done: true }));
    await page.waitForTimeout(600);
    const before = await tabs();
    assert.deepEqual(errors, []);
    let closed = app.waitForEvent("close");
    await app.evaluate(({ app }) => app.quit());
    await closed;
    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.emulateMedia({ colorScheme: null });
    await until(async () => (await tabs().catch(() => null))?.groups?.length === 2, "two groups again");
    const after = await tabs();
    assert.deepEqual(
      after.groups.map((g) => [g.tabIds.length, Math.round(g.size * 100)]),
      before.groups.map((g) => [g.tabIds.length, Math.round(g.size * 100)]),
    );
    assert.deepEqual(
      after.tabs.map((t) => [t.views[0].kind, !!t.panel]),
      before.tabs.map((t) => [t.views[0].kind, !!t.panel]),
    );
    await until(async () => (await pdfBounds()).length >= 1, "a reader is shown");
    await shot("relaunched");

    // An older version's split tab comes back as tabs of their own, in its place.
    closed = app.waitForEvent("close");
    await app.evaluate(({ app }) => app.quit());
    await closed;
    const legacy = {
      version: 1,
      windows: [
        {
          workspaceId: ws.id,
          tabs: {
            tabs: [
              { layout: { view: { type: "home" } }, active: 0 },
              {
                layout: { split: "row", ratio: 0.5, a: { view: { type: "content", section: "sources", workspaceId: ws.id, title: "Sources" } }, b: { view: { type: "pdf", workspaceId: ws.id, hash: sources[0].fileHash, title: "A" } } },
                active: 1,
              },
            ],
            active: 1,
          },
        },
      ],
      layouts: {},
      recent: [ws.id],
    };
    await writeFile(path.join(profile, "window-state.json"), JSON.stringify(legacy));
    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.emulateMedia({ colorScheme: null });
    await until(async () => (await tabs().catch(() => null))?.tabs?.length === 3, "the split tab's views come back as tabs");
    const migrated = await tabs();
    assert.deepEqual(migrated.tabs.map((t) => t.views[0].kind), ["home", "library", "pdf"]);
    assert.equal(migrated.tabs.find((t) => t.id === migrated.activeTabId).views[0].kind, "pdf", "the split's focused view is the active tab");
    await shot("migrated");

    console.log(JSON.stringify({ ok: true, temp, geometry, splitRight: true, sash: true, focus: true, dragBetweenStrips: true, dragToSide: true, closeGroup: true, panel: true, popOut: true, dockBack: true, relaunch: true, legacy: true }));
  } catch (e) {
    await page?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
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
