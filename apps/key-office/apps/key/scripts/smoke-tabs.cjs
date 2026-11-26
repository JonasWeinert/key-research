// Tabs within editor groups: Chrome-style drag-to-reorder (neighbours slide, nothing
// oscillates after the drop, no view is recreated), native readers flush with the sidebar,
// the sash and the window edge as the sidebar collapses and the sash moves, keyboard reorder,
// the menu's shortcuts, next/previous tab and Cmd-1…9 within the focused group, and pinned
// tabs surviving Close Other Tabs (which leaves other groups alone).
const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-tabs-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.key);
    const tabsNow = () => page.evaluate(() => window.key.tabs());
    const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const until = async (check, what) => {
      for (let i = 0; i < 100; i++) {
        if (await check()) return;
        await page.waitForTimeout(100);
      }
      throw Error(`Timed out: ${what}`);
    };
    const menuItem = (...labels) =>
      app.evaluate(({ Menu }, labels) => {
        let items = Menu.getApplicationMenu().items;
        let item;
        for (const label of labels) {
          item = items.find((i) => i.label === label);
          items = item?.submenu?.items ?? [];
        }
        return item ? { accelerator: item.accelerator ?? null } : null;
      }, labels);
    const clickMenu = (...labels) =>
      app.evaluate(({ Menu }, labels) => {
        let items = Menu.getApplicationMenu().items;
        let item;
        for (const label of labels) {
          item = items.find((i) => i.label === label);
          items = item?.submenu?.items ?? [];
        }
        item.click();
      }, labels);
    await page.evaluate(async () => {
      await window.key.tabAction("new");
      await window.key.tabAction("new");
    });
    const files = ["interaction.pdf", "scientific-unlinked.pdf"].map((f) => path.resolve(__dirname, "../../../../../tests/fixtures", f));
    await page.evaluate(async (files) => {
      const [w] = await window.key.workspaces();
      for (const path of files) {
        const source = await window.key.invoke("library_import_file", { path }, w.id);
        await window.key.openSource({ ...source, documentHash: source.hash, workspaceId: w.id });
      }
      // The second reader moves into a group of its own on the right.
      await window.key.tabAction("split-right");
    }, files);
    // Wait for both readers to finish attaching; their initial focus/layout
    // work must not interrupt the pointer capture being measured below.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (app.windows().filter((p) => p.url().endsWith("/pdf.html")).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const pdf of app.windows().filter((p) => p.url().endsWith("/pdf.html"))) await pdf.waitForFunction(() => window.__PDFJS_READY__ === true);
    const before = await tabsNow();
    assert.equal(before.groups.length, 2);
    const [leftGroup, rightGroup] = before.groups;
    const readerTab = before.tabs.find((t) => t.groupId === leftGroup.id && t.views[0].kind === "pdf");
    assert(readerTab, "the first reader stays in the left group");
    assert.equal(leftGroup.activeTabId, readerTab.id, "the left group shows the reader beside the one that left");
    const ids = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.id).sort());

    // Drag the reader's tab to the front of its strip.
    const source = page.locator(`[data-tab-id="${readerTab.id}"]`);
    const box = await source.boundingBox();
    const first = await page.locator(`[data-group-strip="${leftGroup.id}"] .kx-tab`).first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(first.x + 8, box.y + 12, { steps: 18 });
    assert.equal(await page.locator(".kx-tab[data-dragging]").count(), 1);
    assert(
      await page
        .locator(`[data-group-strip="${leftGroup.id}"] .kx-tab:not([data-dragging])`)
        .evaluateAll((nodes) => nodes.some((n) => n.style.transform.includes("translateX"))),
      "neighbours slide aside",
    );
    // Sample from the first animation frame after release; a final snapshot
    // alone misses the old neighbour snap-back followed by a second slide.
    await page.evaluate(() => {
      window.__tabReleaseFrames = new Promise((resolve) => {
        document.addEventListener(
          "pointerup",
          () => {
            const frames = [];
            const sample = () => {
              frames.push(Object.fromEntries([...document.querySelectorAll(".kx-tab")].map((n) => [n.dataset.tabId, n.getBoundingClientRect().left])));
              if (frames.length === 30) resolve(frames);
              else requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          },
          { once: true, capture: true },
        );
      });
    });
    await page.mouse.up();
    const releaseFrames = await page.evaluate(() => window.__tabReleaseFrames);
    for (const id of Object.keys(releaseFrames.at(-1))) {
      if (id === readerTab.id) continue;
      const xs = releaseFrames.map((f) => f[id]);
      let direction = 0;
      for (let i = 1; i < xs.length; i++) {
        const delta = xs[i] - xs[i - 1];
        if (Math.abs(delta) <= 2) continue;
        const next = Math.sign(delta);
        assert(!direction || direction === next, `Neighbour ${id} oscillated after drop: ${xs}`);
        direction = next;
      }
      const settled = xs.slice(2);
      assert(Math.max(...settled) - Math.min(...settled) <= 2, `Settled neighbour ${id} moved more than 2px after drop: ${xs}`);
    }
    await until(async () => (await tabsNow()).groups[0].tabIds[0] === readerTab.id, "the reader's tab leads its strip");
    assert.deepEqual(await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.id).sort()), ids, "no view was recreated");
    await page.screenshot({ path: path.join(temp, "settled.png"), clip: { x: 0, y: 0, width: 1440, height: 96 } });

    async function verifyNativeBounds(label) {
      await settle();
      const expected = await page.evaluate(() => ({
        sidebar: document.querySelector(".key-sidebar-slot").getBoundingClientRect().right,
        sash: document.querySelector(".key-group-sash").getBoundingClientRect().toJSON(),
        width: innerWidth,
        // Native views end at the status bar.
        height: document.querySelector(".kx-status-bar").getBoundingClientRect().top,
      }));
      const actual = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.filter((v) => v.webContents?.getURL().endsWith("/pdf.html") && v.getVisible())
          .map((v) => v.getBounds())
          .sort((a, b) => a.x - b.x),
      );
      assert.equal(actual.length, 2, `${label}: both PDF views shown`);
      const [left, right] = actual;
      assert(Math.abs(left.x - expected.sidebar) <= 1, `${label}: PDF overlaps sidebar`);
      assert(Math.abs(left.x + left.width - expected.sash.x) <= 1, `${label}: left group edge`);
      assert(Math.abs(right.x - expected.sash.right) <= 1, `${label}: right group edge`);
      assert.equal(right.x + right.width, expected.width, `${label}: right window edge`);
      for (const v of actual) assert.equal(v.y + v.height, expected.height, `${label}: bottom edge`);
      return { label, expected, actual };
    }
    const nativeBounds = [await verifyNativeBounds("expanded sidebar")];
    // Expanded: the toggle sits in the sidebar's titlebar, right of the traffic lights.
    const toggleBox = await page.locator(".key-sidebar .key-sidebar-toggle").boundingBox();
    assert(toggleBox.x >= 78 && toggleBox.x + toggleBox.width <= 240 && toggleBox.y < 10, "Sidebar toggle belongs in the sidebar titlebar");
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".key-sidebar-slot").getBoundingClientRect().width === 0);
    nativeBounds.push(await verifyNativeBounds("collapsed sidebar"));
    // Collapsed: the toggle moves into the first group's strip, beside the traffic lights.
    const collapsedToggle = await page.locator(".kx-tabs[data-first] .key-sidebar-toggle").boundingBox();
    assert(collapsedToggle.x >= 78 && collapsedToggle.x < 120 && collapsedToggle.y < 10, "Collapsed sidebar toggle belongs beside traffic lights");
    assert.equal(await page.locator(".key-sidebar-rail").count(), 0);
    await page.screenshot({ path: path.join(temp, "collapsed-sidebar.png") });
    const sash = page.getByRole("separator", { name: "Resize groups" });
    const sashBox = await sash.boundingBox();
    await page.mouse.move(sashBox.x + 3, sashBox.y + 300);
    await page.mouse.down();
    await page.mouse.move(sashBox.x + 130, sashBox.y + 300, { steps: 12 });
    await page.mouse.up();
    await until(async () => (await tabsNow()).groups[0].size > 0.55, "the sash's sizes reach main");
    nativeBounds.push(await verifyNativeBounds("resized groups"));
    await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".key-sidebar-slot").getBoundingClientRect().width === 240);
    nativeBounds.push(await verifyNativeBounds("restored sidebar"));
    // Keyboard: Option-arrows move a focused tab within its strip.
    await page.locator(`[data-tab-id="${readerTab.id}"]`).focus();
    await page.keyboard.press("Alt+ArrowRight");
    await until(async () => (await tabsNow()).groups[0].tabIds[1] === readerTab.id, "Option-Right moves the tab");

    const shortcuts = {
      splitRight: await menuItem("View", "Split Right"),
      focusLeft: await menuItem("View", "Focus Group", "Left"),
      moveRight: await menuItem("View", "Move Tab to Group", "Right"),
      close: await menuItem("File", "Close Tab"),
      tab1: await menuItem("View", "Go to Tab", "Tab 1"),
      nextTab: await menuItem("View", "Show Next Tab"),
      switchWorkspace: await menuItem("File", "Switch Workspace…"),
    };
    assert.deepEqual(Object.fromEntries(Object.entries(shortcuts).map(([k, v]) => [k, v?.accelerator])), {
      splitRight: "CmdOrCtrl+\\",
      focusLeft: "CmdOrCtrl+Alt+Left",
      moveRight: "CmdOrCtrl+Alt+Shift+Right",
      close: "CmdOrCtrl+W",
      tab1: "CmdOrCtrl+1",
      nextTab: "CmdOrCtrl+Shift+]",
      switchWorkspace: "CmdOrCtrl+Shift+O",
    });
    // Focus moves between groups; next tab and ⌘1 stay within the focused one.
    await page.evaluate((groupId) => window.key.tabAction("focus-group", { groupId }), rightGroup.id);
    await clickMenu("View", "Focus Group", "Left");
    await until(async () => (await tabsNow()).activeGroupId === leftGroup.id, "Focus Group › Left");
    const leftIds = (await tabsNow()).groups[0].tabIds;
    await clickMenu("View", "Go to Tab", "Tab 1");
    await until(async () => (await tabsNow()).activeTabId === leftIds[0], "⌘1 within the left group");
    await clickMenu("View", "Show Next Tab");
    await until(async () => (await tabsNow()).activeTabId === leftIds[1], "next tab within the group");
    await clickMenu("View", "Go to Tab", "Last Tab");
    await clickMenu("View", "Show Next Tab");
    await until(async () => (await tabsNow()).activeTabId === leftIds[0], "next tab wraps within the group");
    assert.equal((await tabsNow()).groups[1].activeTabId, rightGroup.activeTabId, "the right group is untouched");

    // Pinned tabs survive Close Other Tabs; other groups are not touched.
    await page.evaluate((tabId) => window.key.tabAction("pin", { tabId, pinned: true }), leftIds.at(-1));
    await page.evaluate((tabId) => window.key.tabAction("close-tabs", { tabId, which: "others" }), readerTab.id);
    let state = await tabsNow();
    assert.deepEqual(state.groups[0].tabIds, [leftIds.at(-1), readerTab.id]);
    assert.equal(state.groups[1].tabIds.length, 1);
    assert.ok(state.tabs.find((t) => t.id === leftIds.at(-1)).pinned);
    nativeBounds.push(await verifyNativeBounds("after closing others"));
    console.log(JSON.stringify({ ok: true, temp, reorderedWithoutRecreating: true, releaseFrames: releaseFrames.length, nativeBounds, shortcuts }));
  } finally {
    await app.evaluate(({ app }) => app.exit(0));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
