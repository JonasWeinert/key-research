// Ctrl-Tab: a quick tap toggles between the two most recent tabs without showing anything;
// holding shows the window's tabs (most recent first, numbered); Tab moves, a digit jumps,
// W closes, Esc cancels, letting go of Ctrl switches. It works with focus in a PDF reader,
// a note editor (the shell's DOM) and a web page, and "Show all tabs" opens it from the
// command palette. Keys are sent to each webContents the way the keyboard would.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const http = require("node:http");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-tab-switcher-"));
  const fixtures = ["Switch study A.pdf", "Switch study B.pdf"].map((name) => path.join(temp, name));
  await writeFile(fixtures[0], await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  await writeFile(fixtures[1], await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/scientific-unlinked.pdf")));
  const server = http.createServer((_req, res) => res.end(`<!doctype html><title>Switch page</title><body style="font:15px system-ui;padding:24px"><h1>Switch page</h1><input id="field">`));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const until = async (check, what, tries = 100) => {
    for (let i = 0; i < tries; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error(`Timed out: ${what}`);
  };
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.emulateMedia({ colorScheme: null });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const tabs = () => page.evaluate(() => window.key.tabs());
    const active = async () => {
      const t = await tabs();
      return t.tabs.find((x) => x.id === t.activeTabId);
    };
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const created = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: fixtures });
    const sources = await Promise.all(created.map((s) => page.evaluate(({ ws, id }) => window.key.invoke("store_source", { id }, ws), { ws: ws.id, id: s.id })));
    const openPdf = (s) => page.evaluate(({ ws, s }) => window.key.openSource({ documentId: s.fileHash, documentHash: s.fileHash, title: s.title, workspaceId: ws }), { ws: ws.id, s });
    const note = await page.evaluate((id) => window.key.invoke("store_note_save", { id: null, sourceId: null, title: "Switch note", body: "Some words to edit." }, id), ws.id);

    // Tabs, oldest use first: Home, the web page, the note, PDF A, PDF B.
    await page.evaluate((url) => window.key.tabAction("open-url", { url }), `${base}/`);
    await until(async () => (await active())?.title === "Switch page", "the web page");
    await page.evaluate(({ id, noteId }) => window.key.tabAction("open-content", { section: "note", workspaceId: id, noteId, title: "Switch note" }), { id: ws.id, noteId: note.id });
    await until(async () => (await active())?.views[0].kind === "note", "the note");
    await openPdf(sources[0]);
    await openPdf(sources[1]);
    await until(async () => app.windows().filter((p) => p.url().endsWith("/pdf.html")).length >= 2, "two readers");
    await until(async () => (await active())?.title === sources[1].title, "PDF B in front");
    const titleOf = async (id) => (await tabs()).tabs.find((t) => t.id === id)?.title;

    // Keys as the keyboard sends them, to one webContents: the shell, or the native view whose page matches.
    const target = async (which) =>
      app.evaluate(({ BrowserWindow }, which) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (which === "shell") return w.webContents.id;
        const view = w.contentView.children.find((v) => v.getVisible?.() && v.webContents && v.webContents !== w.webContents && v.webContents.getURL().includes(which));
        return view?.webContents.id;
      }, which);
    const send = (id, events) =>
      app.evaluate(async ({ webContents }, { id, events }) => {
        const contents = webContents.fromId(id);
        for (const e of events) {
          if (e.wait) await new Promise((r) => setTimeout(r, e.wait));
          else contents.sendInputEvent(e);
        }
      }, { id, events });
    const ctrlDown = { type: "keyDown", keyCode: "Control", modifiers: ["control"] };
    const ctrlUp = { type: "keyUp", keyCode: "Control" };
    const tab = (shift = false) => [
      { type: "keyDown", keyCode: "Tab", modifiers: shift ? ["control", "shift"] : ["control"] },
      { type: "keyUp", keyCode: "Tab", modifiers: shift ? ["control", "shift"] : ["control"] },
    ];
    // Ctrl-Tab goes down where focus is; the switcher then moves focus to the shell, which gets the rest.
    const begin = async (where) => {
      await send(where, [ctrlDown, tab()[0]]);
      await send(await target("shell"), [tab()[1]]);
    };
    const key = (keyCode) => [{ type: "keyDown", keyCode, modifiers: ["control"] }, { type: "char", keyCode, modifiers: ["control"] }, { type: "keyUp", keyCode, modifiers: ["control"] }];
    const overlay = page.locator(".kx-switcher");
    const rows = page.locator(".kx-switcher-row");
    const selectedTitle = () => page.locator('.kx-switcher-row[aria-selected="true"] .kx-switcher-title').textContent();

    // 1. Inside the PDF reader: a quick tap goes back to the note, with no overlay; a second tap returns.
    let reader = await target("pdf.html");
    assert(reader, "the reader's webContents");
    let shownDuringTap = false;
    const watch = page.evaluate(() => new Promise((r) => {
      const seen = { shown: false };
      const obs = new MutationObserver(() => document.querySelector(".kx-switcher") && (seen.shown = true));
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => (obs.disconnect(), r(seen.shown)), 900);
    }));
    await begin(reader);
    await send(await target("shell"), [ctrlUp]);
    shownDuringTap = await watch;
    assert.equal(shownDuringTap, false, "a quick tap shows no overlay");
    await until(async () => (await active())?.views[0].kind === "pdf" && (await active()).title === sources[0].title, "quick tap: PDF A");
    reader = await target("pdf.html");
    await begin(reader);
    await send(await target("shell"), [ctrlUp]);
    await until(async () => (await active())?.title === sources[1].title, "quick tap again: back to PDF B");
    console.log("quick toggle in the reader: ok");

    // 2. Held: the overlay lists every tab, most recent first, numbered.
    reader = await target("pdf.html");
    await begin(reader);
    await overlay.waitFor();
    assert.equal(await rows.count(), 5);
    const listed = await page.locator(".kx-switcher-title").allTextContents();
    assert.deepEqual(listed.slice(0, 2), [sources[1].title, sources[0].title], "most recent first");
    assert.equal(listed[2], "Switch note");
    assert.deepEqual(await page.locator(".kx-switcher-badge").allTextContents(), ["1", "2", "3", "4", "5"]);
    assert.equal(await selectedTitle(), sources[0].title, "the previous tab is selected");
    // The reader stands still as a picture under the overlay.
    assert(await page.locator(".key-native-overlay-frame").count() >= 1, "native views shown as pictures");
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(temp, "switcher-light.png") });
    // Tab moves on, Shift-Tab back; then "3" jumps straight to the note.
    await send(await target("shell"), tab());
    await until(async () => (await selectedTitle()) === "Switch note", "Tab moves the selection");
    await send(await target("shell"), tab(true));
    await until(async () => (await selectedTitle()) === sources[0].title, "Shift-Tab moves back");
    await send(await target("shell"), [...key("3")]);
    await overlay.waitFor({ state: "detached" });
    await until(async () => (await active())?.views[0].kind === "note", "3 jumps to the note");
    await send(await target("shell"), [ctrlUp]);
    console.log("hold, Tab, Shift-Tab and digits: ok");

    // 3. Inside the note editor (the shell's DOM): hold, move with the arrow keys, let go.
    const editor = page.locator(".ProseMirror:visible").first();
    await editor.click();
    await page.waitForFunction(() => document.activeElement?.closest(".ProseMirror"));
    const shell = await target("shell");
    await send(shell, [ctrlDown, ...tab(), { wait: 400 }]);
    await overlay.waitFor();
    assert.equal(await selectedTitle(), sources[1].title, "from the note, the previous tab is PDF B");
    await send(shell, key("Down"));
    await until(async () => (await selectedTitle()) === sources[0].title, "arrow down");
    await send(shell, [ctrlUp]);
    await overlay.waitFor({ state: "detached" });
    await until(async () => (await active())?.title === sources[0].title, "release switches to PDF A");
    const noteText = await page.evaluate(() => document.querySelector(".kx-note-page .ProseMirror")?.textContent ?? "");
    assert(!/[3w]$/.test(noteText.trim()), "no key reached the editor");
    console.log("note editor focus: ok");

    // 4. Inside a web page: Esc cancels; W closes the selected tab and the list follows.
    const order = (await tabs()).tabs;
    const web = order.find((t) => t.views[0].kind === "web");
    await page.evaluate((tabId) => window.key.tabAction("activate", { tabId }), web.id);
    await until(async () => (await active())?.id === web.id, "the web page in front");
    const webContents = await target(base);
    assert(webContents, "the web page's webContents");
    await begin(webContents);
    await overlay.waitFor();
    await send(await target("shell"), key("Escape"));
    await overlay.waitFor({ state: "detached" });
    await send(await target("shell"), [ctrlUp]);
    assert.equal((await active())?.id, web.id, "Esc keeps the tab");
    await begin(await target(base));
    await overlay.waitFor();
    const doomed = await selectedTitle();
    await send(await target("shell"), key("W"));
    await until(async () => (await rows.count()) === 4, "W closes the selected tab");
    assert(!(await tabs()).tabs.some((t) => t.title === doomed), "the closed tab is gone");
    const next = await selectedTitle();
    await send(await target("shell"), [ctrlUp]);
    await overlay.waitFor({ state: "detached" });
    await until(async () => (await active())?.title === next, "release after W switches to the selection");
    console.log("web page focus, Esc and W: ok");

    // 5. "Show all tabs" from the command palette waits for a pick.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("command", "palette"));
    const field = page.getByPlaceholder("Type a command or search…");
    await field.waitFor();
    await field.fill("Show all tabs");
    await page.locator(".kx-spot-row", { hasText: "Show all tabs" }).first().waitFor({ timeout: 60000 });
    await page.locator("button.kx-spot-row", { hasText: "Show all tabs" }).first().click();
    await overlay.waitFor();
    assert.equal(await overlay.getAttribute("data-sticky"), "true");
    await page.waitForTimeout(300);
    assert(await overlay.isVisible(), "stays without Ctrl held");
    const pick = (await page.locator(".kx-switcher-title").allTextContents())[2];
    await page.locator(".kx-switcher-row").nth(2).click();
    await overlay.waitFor({ state: "detached" });
    await until(async () => (await active())?.title === pick, "a click picks");
    console.log("palette and click: ok");

    // 6. Fifty tabs stay instant: the list is on screen within a frame of being shown.
    for (let i = 0; i < 48; i++) await page.evaluate(() => window.key.tabAction("new"));
    await until(async () => (await tabs()).tabs.length >= 52, "52 tabs");
    await page.evaluate(() => {
      window.__switcherShown = 0;
      new MutationObserver(() => {
        if (!window.__switcherShown && document.querySelectorAll(".kx-switcher-row").length >= 52) window.__switcherShown = performance.now();
      }).observe(document.body, { childList: true, subtree: true });
    });
    const shell2 = await target("shell");
    const sentAt = await page.evaluate(() => performance.now());
    await send(shell2, [ctrlDown, ...tab()]);
    await page.waitForFunction(() => window.__switcherShown > 0);
    const latency = (await page.evaluate(() => window.__switcherShown)) - sentAt;
    console.log(`52 tabs: overlay after ${Math.round(latency)} ms (hold delay included)`);
    assert(latency < 600, `overlay with 52 tabs took ${latency} ms`);
    assert.deepEqual((await page.locator(".kx-switcher-badge").allTextContents()).slice(8, 11), ["9", "0", ""]);
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForFunction(() => matchMedia("(prefers-color-scheme: dark)").matches);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(temp, "switcher-dark.png") });
    await page.evaluate(() => window.key.setAppSettings({ theme: "light" }));
    await send(shell2, [ctrlUp]);
    await overlay.waitFor({ state: "detached" });

    // Existing tab shortcuts still go through: Cmd-1 shows the first tab.
    const accel = await app.evaluate(({ Menu }) => {
      const find = (items) => {
        for (const i of items) {
          if (i.label === "Tab 1") return i;
          const inner = i.submenu && find(i.submenu.items);
          if (inner) return inner;
        }
      };
      const item = find(Menu.getApplicationMenu().items);
      item.click();
      return item.accelerator;
    });
    assert.equal(accel, "CmdOrCtrl+1");
    await until(async () => {
      const t = await tabs();
      return t.activeTabId === t.groups[0].tabIds[0];
    }, "Cmd-1 still works");
    assert.deepEqual(errors, []);
    if (process.env.KEY_SHOTS) for (const f of ["switcher-light.png", "switcher-dark.png"]) await writeFile(path.join(process.env.KEY_SHOTS, f), await readFile(path.join(temp, f)));
    console.log(`tab switcher smoke passed; screenshots in ${temp}`);
  } finally {
    server.close();
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
