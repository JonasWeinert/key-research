// The in-app browser against a local server: links from the shell and from pages open as
// browser tabs, back/forward, PDFs (inline and as attachments) open in the reader as
// temporary PDFs analysed in the hidden scratch library, Add to library, clean-up of
// unopened ones, the headless API, and a cookie that survives a relaunch.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, mkdir, readFile, readdir } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { tmpdir } = require("node:os");

const fixtures = path.resolve(__dirname, "../../../../../tests/fixtures");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await wait(150);
  }
}
function assert(value, message) {
  if (!value) throw Error(`Assertion failed: ${message}`);
}

async function serve() {
  const inline = await readFile(path.join(fixtures, "PUBMED_33599681.pdf"));
  const attached = await readFile(path.join(fixtures, "scientific-unlinked.pdf"));
  const page = (title, body = "") =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="/favicon.png"></head><body style="font:15px system-ui;padding:24px">${body}</body></html>`;
  const favicon = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mNkYPhfz0AEYBxVSF+FjP8ZGBgYGBgYRhVSFwAAeCAPEf7ZJqYAAAAASUVORK5CYII=",
    "base64",
  );
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/")
      return res.end(
        page(
          "Smoke home",
          `<h1>Smoke home</h1><p><a id="next" href="/two">Page two</a></p><p><a id="blank" target="_blank" href="/three">Page three in a new tab</a></p>
           <p><a id="inline" href="/paper.pdf">Inline PDF</a></p><p><a id="attach" href="/attach">PDF attachment</a></p>
           <p><a id="cookie" href="/set-cookie">Set cookies</a></p><p><a id="mail" href="mailto:nobody@example.invalid">Mail</a></p>
           <p><a id="file" href="file:///etc/hosts">A file link</a></p>
           <meta name="citation_pdf_url" content="/paper.pdf">`,
        ),
      );
    if (url.pathname === "/favicon.png") {
      res.setHeader("content-type", "image/png");
      return res.end(favicon);
    }
    if (url.pathname === "/two") return res.end(page("Page two", "<h1>Page two</h1>"));
    if (url.pathname === "/three") return res.end(page("Page three", "<h1>Page three</h1>"));
    if (url.pathname === "/paper.pdf") {
      res.setHeader("content-type", "application/pdf");
      return res.end(inline);
    }
    if (url.pathname === "/attach") {
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", 'attachment; filename="attached-paper.pdf"');
      return res.end(attached);
    }
    if (url.pathname === "/set-cookie") {
      res.setHeader("set-cookie", ["kept=1; Max-Age=2592000; Path=/", "session=1; Path=/"]);
      return res.end(page("Cookies set", "<h1>Cookies set</h1>"));
    }
    if (url.pathname === "/cookies") return res.end(page(`Cookies: ${req.headers.cookie ?? "none"}`, `<h1>${req.headers.cookie ?? "none"}</h1>`));
    res.statusCode = 404;
    res.end(page("Not found"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function launch(temp, extra = {}) {
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_BROWSER_SMOKE: "1",
      KEY_BROWSER_TEMP_TTL_MS: "6000",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      ...extra,
    },
  });
  if (process.env.KEY_SMOKE_VERBOSE) {
    app.process().stderr.on("data", (d) => process.stderr.write(`[main] ${d}`));
    app.process().stdout.on("data", (d) => process.stderr.write(`[main] ${d}`));
  }
  const shell = await app.firstWindow();
  await shell.waitForFunction(() => window.key);
  shell.on("console", (m) => m.type() === "error" && console.error("SHELL CONSOLE", m.text()));
  return { app, shell };
}
const tabs = (shell) => shell.evaluate(() => window.key.tabs());
const webPage = (app, prefix) => until(() => app.windows().find((p) => p.url().startsWith(prefix)), `a page at ${prefix}`);
const readerPages = (app) => app.windows().filter((p) => p.url().endsWith("/pdf.html"));
async function activeView(shell) {
  const t = await tabs(shell);
  return t.tabs.find((x) => x.id === t.activeTabId)?.views[0];
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-browser-smoke-"));
  await mkdir(path.join(temp, "profile"));
  const shots = path.join(temp, "shots");
  await mkdir(shots);
  const { server, base } = await serve();
  const report = {};
  let { app, shell } = await launch(temp);
  try {
    // A link from the shell (any web link in the app) opens a browser tab.
    await shell.evaluate((url) => window.key.tabAction("open-url", { url }), `${base}/`);
    const home = await webPage(app, `${base}/`);
    await until(async () => (await activeView(shell))?.title === "Smoke home", "the home tab's title");
    let view = await activeView(shell);
    assert(view.kind === "web" && view.web.host === "127.0.0.1", "browser tab kind and host");
    await until(async () => (await activeView(shell))?.favicon?.startsWith("data:image/png"), "the favicon");
    // Following a link, then back and forward from the bar.
    await home.click("#next");
    await until(async () => (await activeView(shell))?.web?.canGoBack && (await activeView(shell)).title === "Page two", "page two");
    await shell.click('.key-web-bar button[aria-label="Back"]');
    await until(async () => (await activeView(shell))?.title === "Smoke home", "back to home");
    view = await activeView(shell);
    assert(view.web.canGoForward, "forward is possible after back");
    await shell.click('.key-web-bar button[aria-label="Forward"]');
    await until(async () => (await activeView(shell))?.title === "Page two", "forward to page two");
    await shell.evaluate(() => window.key.tabAction("history", { step: -1 }));
    await until(async () => (await activeView(shell))?.title === "Smoke home", "back again");
    await shell.screenshot({ path: path.join(shots, "browser-bar-light.png") });
    await home.screenshot({ path: path.join(shots, "browser-page.png") });
    // target=_blank opens a tab of its own, next to this one.
    const before = (await tabs(shell)).tabs.length;
    await home.click("#blank");
    await until(async () => (await tabs(shell)).tabs.some((t) => t.title === "Page three"), "the new tab");
    assert((await tabs(shell)).tabs.length === before + 1, "one new tab");
    // file: links are refused; the page stays.
    await home.click("#file");
    await wait(500);
    assert(home.url() === `${base}/`, "file: navigation refused");
    // A window.open from the shell itself also becomes a browser tab (never an Electron window).
    const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await shell.evaluate((url) => window.open(url, "_blank"), `${base}/two`);
    await until(async () => (await tabs(shell)).tabs.filter((t) => t.title === "Page two").length === 1, "shell window.open as a tab");
    assert((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === windowsBefore, "no extra window");
    // Cookies, for the relaunch.
    await shell.evaluate(async () => {
      const t = await window.key.tabs();
      const tab = t.tabs.find((x) => x.title === "Smoke home");
      await window.key.tabAction("activate", { tabId: tab.id });
    });
    await home.click("#cookie");
    await until(async () => (await activeView(shell))?.title === "Cookies set", "cookies set");
    await home.goBack().catch(() => undefined);
    await until(async () => (await activeView(shell))?.title === "Smoke home", "home after cookies");

    // An inline PDF: downloaded with the profile, opened in the reader as a temporary PDF.
    await home.click("#inline");
    const reader = await until(() => readerPages(app)[0], "the reader").catch(async (error) => {
      console.error("PAGES", app.windows().map((p) => p.url()), await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((c) => c.getURL())));
      console.error("TABS", JSON.stringify((await tabs(shell)).tabs.map((t) => [t.title, t.views[0]?.kind])), "TOASTS", await shell.locator("[role=status], .kx-toast").allInnerTexts().catch(() => []));
      throw error;
    });
    await reader.locator(".key-web-pdf").waitFor({ timeout: 30000 });
    await reader.waitForFunction(() => document.querySelectorAll("canvas").length > 0, undefined, { timeout: 30000 });
    view = await activeView(shell);
    assert(view.kind === "pdf" && view.temp, "a temporary PDF tab");
    const tempId = view.id;
    const scratchId = tempId.split(":")[1];
    const workspaces = await shell.evaluate(() => window.key.workspaces());
    assert(!workspaces.some((w) => w.id === scratchId), "the scratch library is not listed");
    let blocked = await shell.evaluate((id) => window.key.invoke("store_sources", {}, id).then(() => "reached", (e) => String(e)), scratchId);
    assert(/not registered/.test(blocked), "the shell cannot reach the scratch library");
    // Analysis runs there (no embeddings): the reader's analysis report fills in.
    const analysis = await until(
      () => reader.evaluate(() => window.key.readerAnalysis()).then((r) => (r && r.indexStatus && !["pending", "indexing"].includes(r.indexStatus) ? r : undefined)),
      "analysis of the temporary PDF",
      120000,
    );
    report.analysis = { indexStatus: analysis.indexStatus, engine: analysis.analysis?.engine, references: analysis.references?.length, sections: analysis.sections?.length };
    await wait(600);
    await reader.screenshot({ path: path.join(shots, "temp-pdf-light.png") });
    await reader.emulateMedia({ colorScheme: "dark" });
    await shell.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await wait(500);
    await reader.screenshot({ path: path.join(shots, "temp-pdf-dark.png") });
    await shell.emulateMedia({ colorScheme: "dark" });
    await shell.screenshot({ path: path.join(shots, "shell-dark.png") });
    await shell.evaluate(() => window.key.setAppSettings({ theme: "system" }));
    await reader.emulateMedia({ colorScheme: "light" });
    await shell.emulateMedia({ colorScheme: "light" });

    // A PDF served as an attachment opens too (beside the page that linked it).
    await shell.evaluate(async () => {
      const t = await window.key.tabs();
      await window.key.tabAction("activate", { tabId: t.tabs.find((x) => x.title === "Smoke home").id });
    });
    await home.click("#attach");
    await until(async () => (await tabs(shell)).tabs.filter((t) => t.views[0]?.temp).length === 2, "the attachment's reader");
    const attachedId = (await tabs(shell)).tabs.find((t) => t.views[0]?.temp && t.views[0].id !== tempId).views[0].id;

    // The headless API: a page and a PDF without any window.
    report.headless = await app.evaluate(async (_electron, base) => {
      const { service } = globalThis.keyBrowser;
      const page = await service.fetchPage(`${base}/two`);
      const direct = await service.downloadPdf(`${base}/attach`);
      const viaPage = await service.downloadPdf(`${base}/`);
      return { title: page.title, text: page.text.trim(), direct: direct.filename, viaPage: viaPage.filename };
    }, base);
    assert(report.headless.title === "Page two" && report.headless.viaPage, "headless fetch and download");

    // Add to library: the temporary tab becomes the library's reader of it.
    await shell.evaluate(async (id) => {
      const t = await window.key.tabs();
      await window.key.tabAction("focus", { viewId: id });
    }, tempId);
    const tempReader = await until(async () => {
      for (const p of readerPages(app)) if (await p.locator(".key-web-pdf-action").count()) return p;
    }, "the temporary reader");
    const hash = tempId.split(":").at(-1);
    await tempReader.click(".key-web-pdf-action");
    const [workspace] = workspaces;
    await until(async () => (await activeView(shell))?.id === `pdf:${workspace.id}:${hash}`, "the library reader in its place");
    const libraryReader = await until(async () => {
      for (const p of readerPages(app)) if (await p.locator(".key-web-pdf-done").count()) return p;
    }, "the added notice");
    await libraryReader.screenshot({ path: path.join(shots, "added-to-library.png") });
    const added = await shell.evaluate(async ({ id, hash }) => (await window.key.invoke("store_sources", { ids: [hash], limit: 1, scope: "all" }, id)).items[0], { id: workspace.id, hash });
    assert(added && added.fields?.url !== undefined ? true : added, "in the library");
    report.added = { title: added.title ?? added.fields?.title, url: added.url ?? added.fields?.url };

    // Clean-up: the added one is no longer open, so it goes; the open attachment stays.
    const cache = path.join(temp, "profile", "browser-cache", "pdfs");
    await until(() => !existsSync(path.join(cache, `${hash}.pdf`)), "the clean-up of the added PDF", 20000);
    assert(existsSync(path.join(cache, `${attachedId.split(":").at(-1)}.pdf`)), "the open temporary PDF is kept");
    report.cacheAfterCleanup = await readdir(cache);

    // Persistence: quit, relaunch, the cookies come back with the tabs.
    await app.close();
    ({ app, shell } = await launch(temp));
    const restored = await until(async () => {
      const t = await tabs(shell);
      return t.tabs.some((x) => x.views[0]?.kind === "web") && t;
    }, "restored browser tabs");
    report.restored = restored.tabs.map((t) => `${t.views[0]?.kind}:${t.title}`);
    await shell.evaluate((url) => window.key.tabAction("open-url", { url }), `${base}/cookies`);
    const cookies = await until(async () => {
      const v = await activeView(shell);
      return v?.title?.startsWith("Cookies:") && v.title;
    }, "the cookie page");
    report.cookies = cookies;
    assert(/kept=1/.test(cookies) && /session=1/.test(cookies), "persistent and session cookies survive a relaunch");
    console.log("BROWSER SMOKE", JSON.stringify(report, null, 1));
    console.log("SCREENSHOTS", shots);
  } finally {
    await app.close().catch(() => undefined);
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
