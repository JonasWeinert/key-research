// Real Electron smoke: the status bar along the window's bottom. Native views end above it;
// a reader contributes items over the bridge and gets their clicks back; main-process errors
// show as a quiet notice (and in userData/logs/key.log) instead of a modal box; under a
// smoke run message boxes answer themselves with their cancel button.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-status-bar-"));
  const fixture = path.join(temp, "Status study.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  const profile = path.join(temp, "profile");
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: profile, KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  let page;
  const shot = async (name) => {
    const layers = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const out = [];
      for (const v of w.contentView.children) {
        if (!v.getVisible?.() || !v.webContents || v.webContents === w.webContents) continue;
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
  const until = async (check, what) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await page.waitForTimeout(100);
    }
    throw Error(`Timed out: ${what}`);
  };
  try {
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();

    // The bar: 24px along the bottom, the full width, with the shell's own items.
    const bar = page.getByRole("contentinfo", { name: "Status" });
    await bar.waitFor();
    const box = await bar.boundingBox();
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.equal(Math.round(box.height), 24);
    assert.equal(Math.round(box.y + box.height), size.height);
    assert.equal(Math.round(box.x), 0);
    assert.equal(Math.round(box.width), size.width);
    await bar.locator('[data-status-item="zotero"]').waitFor();
    await bar.locator('[data-status-item="workspace"]').waitFor();
    const sidebar = await page.locator(".key-sidebar-slot").boundingBox();
    assert(sidebar.y + sidebar.height <= box.y + 1, `the sidebar ends above the bar: ${sidebar.y + sidebar.height} vs ${box.y}`);

    // A reader ends above the bar.
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const [created] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    const source = await page.evaluate(({ ws, id }) => window.key.invoke("store_source", { id }, ws), { ws: ws.id, id: created.id });
    await page.evaluate(({ ws, s }) => window.key.openSource({ documentId: s.fileHash, documentHash: s.fileHash, title: s.title, workspaceId: ws }), { ws: ws.id, s: source });
    await until(async () => app.windows().some((p) => p.url().endsWith("/pdf.html")), "the reader opens");
    const reader = app.windows().find((p) => p.url().endsWith("/pdf.html"));
    await reader.waitForFunction(() => window.__PDFJS_READY__ === true);
    const bounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.find((v) => v.webContents?.getURL().endsWith("/pdf.html") && v.getVisible()).getBounds(),
    );
    assert.equal(bounds.y + bounds.height, size.height - 24, `the reader ends above the bar ${JSON.stringify(bounds)}`);

    // The reader's own items show on the right while it has focus; a click comes back to it.
    await reader.evaluate(() => {
      window.__statusClicks = [];
      window.key.onStatusItem((id) => window.__statusClicks.push(id));
      window.key.setStatusItems([
        { id: "details", label: "Details", icon: "info", active: true, title: "Show details" },
        { id: "refs", label: "References", icon: "quote" },
        { id: "bad" },
      ]);
    });
    const context = bar.locator(".kx-status-context");
    await context.locator('[data-status-item="refs"]').waitFor();
    assert.equal(await context.locator("[data-status-item]").count(), 2, "an item without a label or icon is dropped");
    assert.equal(await context.locator('[data-status-item="details"]').getAttribute("aria-pressed"), "true");
    await context.locator('[data-status-item="refs"]').click();
    await until(async () => (await reader.evaluate(() => window.__statusClicks)).includes("refs"), "the click reaches the reader");
    await shot("status-bar-reader-light");

    // Home has focus again: the reader's items leave the bar, and come back with it.
    const state = await page.evaluate(() => window.key.tabs());
    const home = state.tabs.find((t) => t.views[0].kind === "home");
    await page.evaluate((tabId) => window.key.tabAction("activate", { tabId }), home.id);
    await until(async () => (await context.locator("[data-status-item]").count()) === 0, "the items follow focus");
    const pdfTab = state.tabs.find((t) => t.views[0].kind === "pdf");
    await page.evaluate((tabId) => window.key.tabAction("activate", { tabId }), pdfTab.id);
    await context.locator('[data-status-item="refs"]').waitFor();

    // The library has no bar of its own: its count is one of the bar's items while it has
    // focus, and its content runs down to the bar.
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    const count = context.locator('[data-status-item="count"]');
    await until(async () => /^1 item$/.test((await count.innerText().catch(() => "")).trim()), "the library contributes its count");
    assert.equal(await count.evaluate((el) => el.tagName), "SPAN", "the count is plain text, not a button");
    assert.equal(await context.locator('[data-status-item="refs"]').count(), 0, "the reader's items left with its focus");
    assert.equal(await page.locator(".kx-status-bar").count(), 1, "one status bar, no scoped one");
    assert.equal(await page.locator(".kx-library footer").count(), 0, "the library has no footer strip");
    const libraryBottom = await page.locator(".kx-library-main").evaluate((el) => el.getBoundingClientRect().bottom);
    assert(Math.abs(libraryBottom - box.y) <= 1, `the library runs down to the bar: ${libraryBottom} vs ${box.y}`);
    await context.locator('[data-status-item="searchable"]').waitFor();

    // Indexing is one item (the shell's), with its panel as a popover above it, also from
    // the library: pause, then add a source so there is work waiting.
    await page.evaluate((id) => window.key.invoke("store_index_control", { action: "pause" }, id), ws.id);
    const second = path.join(temp, "Second status study.pdf");
    await writeFile(second, Buffer.concat([await readFile(fixture), Buffer.from("\n% second\n")]));
    await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [second] });
    const work = bar.locator('[data-status-item="work"]');
    await until(async () => /Indexing/.test(await work.innerText().catch(() => "")), "the bar shows the indexing work");
    await until(async () => /^2 items$/.test((await count.innerText().catch(() => "")).trim()), "the count follows");
    const indexing = await bar.locator("[data-status-item]").evaluateAll((els) => els.filter((el) => /Indexing/.test(el.textContent)).length);
    assert.equal(indexing, 1, "indexing shows once");
    await until(async () => (await context.locator('[data-status-item="searchable"]').count()) === 0, "no searchable count while work waits");
    await work.click();
    const popover = page.locator(".kx-status-popover");
    await popover.locator(".kx-activity-panel").waitFor();
    assert.equal(await work.getAttribute("aria-expanded"), "true");
    const [pop, anchor] = [await popover.boundingBox(), await work.boundingBox()];
    assert(pop.y + pop.height <= anchor.y, `the popover hangs above its item: ${JSON.stringify({ pop, anchor })}`);
    await page.waitForTimeout(300);
    await shot("status-bar-activity-light");
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "detached" });
    // Selecting two sources adds the selection.
    await page.waitForFunction(() => document.querySelectorAll(".kx-library .kx-row").length === 2);
    await page.locator(".kx-library .kx-row").nth(0).click();
    await page.locator(".kx-library .kx-row").nth(1).click({ modifiers: ["Shift"] });
    await context.locator('[data-status-item="selected"]', { hasText: "2 selected" }).waitFor();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(700);
    await shot("status-bar-library-dark");
    await page.emulateMedia({ colorScheme: null });
    await page.evaluate((id) => window.key.invoke("store_index_control", { action: "resume" }, id), ws.id);

    // Two groups: the bar follows the focused group's view.
    let groups = await page.evaluate(() => window.key.tabs());
    const libraryTab = groups.tabs.find((t) => t.views[0].content?.section === "sources");
    await page.evaluate((tabId) => window.key.tabAction("split-right", { tabId }), pdfTab.id);
    await until(async () => (await page.evaluate(() => window.key.tabs())).groups.length === 2, "two groups");
    await context.locator('[data-status-item="refs"]').waitFor();
    assert.equal(await count.count(), 0, "the library's items left with its focus");
    groups = await page.evaluate(() => window.key.tabs());
    const libraryGroup = groups.groups.find((g) => g.tabIds.includes(libraryTab.id));
    await page.evaluate((groupId) => window.key.tabAction("focus-group", { groupId }), libraryGroup.id);
    await count.waitFor();
    assert.equal(await context.locator('[data-status-item="refs"]').count(), 0, "the reader's items left with its focus");
    await shot("status-bar-split-light");

    // Short of room, the lowest-priority items go first and the bar never wraps.
    // The reader (focused again) asks for far more room than there is.
    const readerGroup = groups.groups.find((g) => g.tabIds.includes(pdfTab.id));
    await page.evaluate((groupId) => window.key.tabAction("focus-group", { groupId }), readerGroup.id);
    await reader.evaluate(() =>
      window.key.setStatusItems(
        Array.from({ length: 6 }, (_, i) => ({ id: `wide${i}`, label: `A long reader status item number ${i + 1} that wants plenty of room`, priority: 10 + i * 15 })),
      ),
    );
    await context.locator('[data-status-item="wide0"]').waitFor({ state: "attached" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 820));
    await until(async () => (await bar.locator("[data-status-item][hidden]").count()) > 0, "items give way");
    await page.waitForTimeout(200);
    const fit = await bar.evaluate((el) => {
      const items = [...el.querySelectorAll("[data-status-item]")].map((n) => ({ id: n.dataset.statusItem, priority: Number(n.dataset.priority ?? 50), hidden: n.hidden }));
      return {
        height: el.offsetHeight,
        overflow: [...el.children].some((c) => c.scrollWidth > c.clientWidth + 1),
        lowestShown: Math.min(...items.filter((i) => !i.hidden).map((i) => i.priority)),
        highestHidden: Math.max(...items.filter((i) => i.hidden).map((i) => i.priority)),
        workspace: items.find((i) => i.id === "workspace")?.hidden,
      };
    });
    assert.equal(fit.height, 24, "one line");
    assert.equal(fit.overflow, false, `nothing cut: ${JSON.stringify(fit)}`);
    assert(fit.highestHidden <= fit.lowestShown, `the lowest priorities go first: ${JSON.stringify(fit)}`);
    assert.equal(fit.workspace, false, "the workspace stays");
    await shot("status-bar-narrow-light");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
    await reader.evaluate(() => window.key.setStatusItems([{ id: "refs", label: "References", icon: "quote" }]));
    await until(async () => (await bar.locator("[data-status-item][hidden]").count()) === 0, "room again");

    // Zotero, not set up: a muted "Set up Zotero" that opens the Zotero sheet over any tab.
    const zotero = bar.locator('[data-status-item="zotero"]');
    assert.equal(await zotero.getAttribute("data-tone"), "off");
    assert.match(await zotero.innerText(), /Set up Zotero/);
    await zotero.click();
    await page.getByRole("heading", { name: "Bring in your Zotero library" }).waitFor();
    await shot("status-bar-zotero-sheet-light");
    await page.keyboard.press("Escape");
    await page.locator(".kx-zotero-import").waitFor({ state: "detached" });

    // An uncaught main-process error and an unhandled rejection: notices, not boxes.
    await app.evaluate(() => {
      setTimeout(() => {
        throw new Error("Smoke uncaught failure");
      }, 0);
      void Promise.reject(new Error("Smoke rejected promise"));
    });
    const notice = bar.locator(".kx-status-notice");
    await notice.waitFor();
    await until(async () => /Smoke/.test(await notice.innerText()), "the notice names the error");
    const log = await readFile(path.join(profile, "logs", "key.log"), "utf8");
    assert.match(log, /Smoke uncaught failure/);
    assert.match(log, /Smoke rejected promise/);
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForTimeout(400);
    await shot("status-bar-notice-dark");
    await page.evaluate(() => window.key.setAppSettings({ theme: "light" }));
    await shot("status-bar-notice-light");
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await notice.waitFor({ state: "detached" });

    // Under a smoke run a message box answers itself with its cancel button, and an error box
    // is a notice.
    const answer = await app.evaluate(({ dialog, BrowserWindow }) =>
      Promise.race([
        dialog.showMessageBox(BrowserWindow.getAllWindows()[0], { type: "warning", message: "Delete everything?", buttons: ["Cancel", "Delete"], defaultId: 1, cancelId: 0 }),
        new Promise((r) => setTimeout(() => r("blocked"), 3000)),
      ]),
    );
    assert.equal(answer.response, 0, `the box answered with Cancel: ${JSON.stringify(answer)}`);
    await app.evaluate(({ dialog }) => dialog.showErrorBox("Smoke error box", "nothing modal"));
    await until(async () => /Smoke error box/.test((await notice.innerText().catch(() => "")) || ""), "the error box is a notice");
    assert.match(await readFile(path.join(profile, "logs", "key.log"), "utf8"), /auto-answered "Delete everything\?"/);

    // A page's confirm() still reaches the test driver, which answers it.
    page.once("dialog", (dialog) => dialog.accept());
    assert.equal(await page.evaluate(() => window.confirm("Smoke confirm?")), true, "the driver accepts a confirm");
    assert.equal(await page.evaluate(() => window.confirm("Smoke confirm again?")), false, "an unanswered confirm is dismissed");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, bar: box, reader: bounds }));
  } catch (error) {
    await page?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error(temp);
    throw error;
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
