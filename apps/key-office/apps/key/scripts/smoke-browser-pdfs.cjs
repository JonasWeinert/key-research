// PDFs never show in Chromium's viewer: every way a page can lead to one (a link, a full-page
// embed, iframe or object, a blob, a form POST, a publisher's online reader, a pdf.js viewer)
// ends in the app's reader as a temporary PDF that knows the page it came from. Annotations
// made on a temporary PDF carry over when it is added to the library. Article pages offer
// Add to library in the bar, and a bot check that stalls offers a reload.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, readFile } = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { tmpdir } = require("node:os");

const fixtures = path.resolve(__dirname, "../../../../../tests/fixtures");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await wait(150);
  }
}
function assert(value, message) {
  if (!value) throw Error(`Assertion failed: ${message}`);
}

async function serve() {
  const base = await readFile(path.join(fixtures, "PUBMED_33599681.pdf"));
  // Distinct files (distinct hashes): the same PDF with a different trailing comment.
  const pdf = (n) => Buffer.concat([base, Buffer.from(`\n%key-smoke-${n}\n`)]);
  const page = (title, body = "", head = "") =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body style="font:15px system-ui;padding:24px;margin:0">${body}</body></html>`;
  const full = "position:fixed;inset:0;width:100%;height:100%;border:0";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (body) => res.end(body);
    const pdfMatch = url.pathname.match(/^\/p\/(\d+)\.pdf$/);
    if (pdfMatch) {
      res.setHeader("content-type", "application/pdf");
      return send(pdf(pdfMatch[1]));
    }
    switch (url.pathname) {
      case "/":
        return send(
          page(
            "Smoke home",
            `<h1>Smoke home</h1>
             <p><a id="direct" href="/p/1.pdf">A PDF link</a></p>
             <p><a id="wrapper" href="/wrapper">A page that is one embedded PDF</a></p>
             <p><a id="iframe" href="/iframe">A page that is one iframe PDF</a></p>
             <p><a id="blob" href="/blob">A blob PDF</a></p>
             <p><a id="blob-embed" href="/blob-embed">A blob PDF embedded</a></p>
             <p><a id="epdf" href="/doi/epdf/10.5555/smoke7">An online reader</a></p>
             <form id="post" method="post" action="/post"><input name="x" value="1"><button>POST</button></form>
             <p><a id="article" href="/article">An article page</a></p>
             <p><a id="nohint" href="/iframe-nohint">A page that is one iframe PDF, without .pdf</a></p>
             <p><a id="small"href="/small-embed">A page with a small PDF preview</a></p>`,
          ),
        );
      case "/wrapper":
        return send(page("Wrapper", `<embed type="application/pdf" src="/p/2.pdf" style="${full}">`));
      case "/iframe":
        return send(page("Iframe wrapper", `<iframe src="/p/8.pdf" style="${full}"></iframe>`));
      case "/iframe-nohint":
        return send(page("Iframe without a hint", `<iframe src="/raw-pdf" style="${full}"></iframe>`));
      case "/raw-pdf":
        res.setHeader("content-type", "application/pdf");
        return send(pdf(11));
      case "/small-embed":
        return send(page("Small embed", `<h1>Supplement</h1><iframe src="/p/10.pdf" style="width:200px;height:150px"></iframe>`));
      case "/blob":
        return send(page("Blob", `<script>fetch("/p/3.pdf").then(r=>r.blob()).then(b=>{location.href=URL.createObjectURL(new Blob([b],{type:"application/pdf"}))})</script>`));
      case "/blob-embed":
        return send(
          page(
            "Blob embed",
            `<script>fetch("/p/4.pdf").then(r=>r.blob()).then(b=>{const e=document.createElement("embed");e.type="application/pdf";e.style.cssText="${full}";e.src=URL.createObjectURL(new Blob([b],{type:"application/pdf"}));document.body.append(e)})</script>`,
          ),
        );
      case "/post":
        res.setHeader("content-type", "application/pdf");
        return send(pdf(5));
      case "/viewer/web/viewer.html":
        return send(page("PDF.js viewer", "<h1>A viewer that should never show</h1>"));
      case "/doi/epdf/10.5555/smoke7":
        return send(page("Online reader", "<h1>A reader that should never show</h1>"));
      case "/doi/pdf/10.5555/smoke7":
        res.setHeader("content-type", "application/pdf");
        return send(pdf(7));
      case "/article":
        return send(
          page(
            "A smoke article | Journal of Smokes",
            "<h1>A smoke article about browser PDFs</h1><p>Abstract.</p>",
            `<meta name="citation_title" content="A smoke article about browser PDFs"><meta name="citation_author" content="Ada Lovelace">
             <meta name="citation_doi" content="10.5555/key-smoke-article"><meta name="citation_publication_date" content="2024/05/01">
             <meta name="citation_journal_title" content="Journal of Smokes"><meta name="citation_pdf_url" content="/p/9.pdf">`,
          ),
        );
      case "/challenge":
        return send(page("Just a moment...", `<div id="challenge-stage"><h1>Checking your browser</h1></div>`));
    }
    res.statusCode = 404;
    send(page("Not found"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-browser-pdfs-"));
  await mkdir(path.join(temp, "profile"));
  const shots = path.join(temp, "shots");
  await mkdir(shots);
  const { server, base } = await serve();
  const report = {};
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_BROWSER_SMOKE: "1",
      KEY_BROWSER_STALL_MS: "1500",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
    },
  });
  if (process.env.KEY_SMOKE_VERBOSE) app.process().stderr.on("data", (d) => process.stderr.write(`[main] ${d}`));
  try {
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => window.key);
    const tabs = () => shell.evaluate(() => window.key.tabs());
    const activeView = async () => {
      const t = await tabs();
      return t.tabs.find((x) => x.id === t.activeTabId)?.views[0];
    };
    const kept = () => app.evaluate(() => globalThis.keyBrowser.temp.list());
    const readerTabs = async () => (await tabs()).tabs.filter((t) => t.views[0]?.temp).length;
    const activateHome = () =>
      shell.evaluate(async () => {
        const t = await window.key.tabs();
        await window.key.tabAction("activate", { tabId: t.tabs.find((x) => x.title === "Smoke home").id });
      });
    const noChromiumViewer = () =>
      app.evaluate(({ webContents }) => webContents.getAllWebContents().every((c) => !/^chrome-extension:\/\/mhjfbmdgcfjbbpaeojofohoefgiehjai/.test(c.getURL()) && !/\.pdf($|\?)/.test(c.getURL())));

    await shell.evaluate((url) => window.key.tabAction("open-url", { url }), `${base}/`);
    const home = await until(async () => app.windows().find((p) => p.url() === `${base}/`), "the home page");
    await until(async () => (await activeView())?.title === "Smoke home", "home's title");
    const sizes = {};
    // Each way to a PDF: it lands in the reader (a new temporary PDF), never in Chromium.
    const step = async (name, act, expect) => {
      const before = (await kept()).length;
      await activateHome();
      await act();
      const entry = await until(async () => {
        const list = await kept();
        return list.length > before && list.find(expect);
      }, `the reader for ${name}`).catch(async (error) => {
        console.error("CONTENTS", await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((c) => c.getURL().slice(0, 100))));
        console.error("KEPT", (await kept()).map((e) => e.url));
        throw error;
      });
      await wait(300);
      assert(await noChromiumViewer(), `${name}: no page shows a PDF in Chromium`);
      sizes[name] = { url: entry.url.replace(base, ""), referrer: entry.referrer?.replace(base, ""), title: entry.title };
      return entry;
    };
    const direct = await step("link", () => home.click("#direct"), (e) => e.url.endsWith("/p/1.pdf"));
    assert(direct.referrer === `${base}/`, "a PDF linked from a page records that page as its referrer");
    await step("embed", () => home.click("#wrapper"), (e) => e.url.endsWith("/p/2.pdf"));
    // The wrapper page goes: the home tab is back on home.
    await until(async () => home.url() === `${base}/`, "the wrapper page left for home");
    await step("iframe", () => home.click("#iframe"), (e) => e.url.endsWith("/p/8.pdf"));
    await until(async () => home.url() === `${base}/`, "the iframe page left for home");
    await step("iframe without a hint", () => home.click("#nohint"), (e) => e.url.endsWith("/raw-pdf"));
    await until(async () => home.url() === `${base}/`, "the second iframe page left for home");
    await step("blob", () => home.click("#blob"), (e) => e.url.startsWith("blob:") || e.url.endsWith("/blob"));
    await activateHome();
    if (home.url() !== `${base}/`) await home.goto(`${base}/`);
    await step("blob embed", () => home.click("#blob-embed"), (e) => e.url.endsWith("/blob-embed"));
    await until(async () => home.url() === `${base}/`, "the blob page left for home");
    await step("form POST", () => home.click("#post button"), (e) => e.url.endsWith("/post"));
    await step("online reader", () => home.click("#epdf"), (e) => e.url.includes("/doi/pdf/10.5555/smoke7"));
    const tabsBefore = (await tabs()).tabs.length;
    await step("pdf.js viewer", () => shell.evaluate((url) => window.key.tabAction("open-url", { url }), `${base}/viewer/web/viewer.html?file=%2Fp%2F6.pdf`), (e) => e.url.endsWith("/p/6.pdf"));
    await until(async () => (await tabs()).tabs.length === tabsBefore + 1 && (await activeView())?.temp, "the viewer's tab became the reader");
    // A small PDF preview on a page is left alone.
    const keptBefore = (await kept()).length;
    await activateHome();
    await home.click("#small");
    await until(async () => (await activeView())?.title === "Small embed", "the small embed page");
    await wait(2500);
    assert((await kept()).length === keptBefore, "a small embedded PDF does not open the reader");
    assert(!home.frames().some((f) => f.url().startsWith("chrome-extension:")), "nor does Chromium's viewer show it in the page");
    await home.screenshot({ path: path.join(shots, "small-embed.png") });
    await home.goBack();
    report.pdfs = sizes;
    report.readerTabs = await readerTabs();

    // Annotations made on a temporary PDF carry over when it is added to the library.
    const directView = (await tabs()).tabs.map((t) => t.views[0]).find((v) => v?.temp && v.id.endsWith(direct.hash));
    await shell.evaluate((id) => window.key.tabAction("focus", { viewId: id }), directView.id);
    // Its reader: the one whose PDF is the direct link's.
    const target = await until(async () => {
      for (const p of app.windows().filter((p) => p.url().endsWith("/pdf.html"))) {
        const info = await p.evaluate(() => window.key.readerReady?.()).catch(() => undefined);
        if (info?.web?.url?.endsWith("/p/1.pdf")) return p;
      }
    }, "the direct PDF's reader");
    const scratchId = directView.id.split(":")[1];
    const highlight = { id: "smoke-carry", text: "Carried over", comment: "A comment on the web PDF", color: "yellow", range: { start: { page: 0, index: 0 }, end: { page: 0, index: 10 } }, anchor: { pages: [{ page: 0, bounds: [] }] } };
    await target.evaluate(({ id, hash, h }) => window.key.invoke("library_apply_annotations", { hash, upserts: [h], deleted: [] }, id), { id: scratchId, hash: direct.hash, h: highlight });
    const [workspace] = await shell.evaluate(() => window.key.workspaces());
    const info = await target.evaluate(() => window.key.readerReady());
    report.readerInfo = { url: info.web.url.replace(base, ""), referrer: info.web.referrer?.replace(base, ""), host: info.web.host };
    await target.screenshot({ path: path.join(shots, "temp-pdf.png") });
    await target.click(".key-web-pdf-action");
    await until(async () => (await activeView())?.id === `pdf:${workspace.id}:${direct.hash}`, "the library reader");
    const carried = await shell.evaluate(({ id, hash }) => window.key.invoke("library_annotations", { hash }, id), { id: workspace.id, hash: direct.hash });
    assert(carried.some((a) => a.id === "smoke-carry" && a.comment === highlight.comment), "the annotation is on the library item");
    report.carried = carried.map((a) => ({ id: a.id, text: a.text, comment: a.comment }));

    // An article page: a source with its title (but no DOI) makes it "Possibly in library",
    // which still offers Add; Add to library adds it (with its PDF), then says In library.
    await shell.evaluate((id) => window.key.invoke("store_create", { source: { kind: "reference", itemType: "article", title: "A smoke article about browser PDFs", year: 2024 } }, id), workspace.id);
    await activateHome();
    await home.click("#article");
    await until(async () => (await activeView())?.web?.article?.doi === "10.5555/key-smoke-article", "the article detected");
    await until(async () => (await activeView())?.web?.article?.possiblyInLibrary, "the title match");
    await shell.locator(".key-web-article[data-possible]", { hasText: "Possibly in library" }).waitFor();
    await shell.locator(".key-web-article:not([data-possible])", { hasText: "Add anyway" }).waitFor();
    await shell.screenshot({ path: path.join(shots, "article-bar.png") });
    await shell.click(".key-web-article:not([data-possible])");
    await until(async () => (await activeView())?.web?.article?.inLibrary, "the article in the library", 60000);
    const article = await until(async () => {
      const found = await shell.evaluate((id) => window.key.invoke("store_sources", { text: "10.5555/key-smoke-article", limit: 5, scope: "all" }, id), workspace.id);
      return found.items.find((s) => s.title?.startsWith("A smoke article") && (s.hash || s.file || s.kind === "pdf" || s.fileHash || s.attachment)) ?? undefined;
    }, "the article with its PDF", 60000).catch(async () => (await shell.evaluate((id) => window.key.invoke("store_sources", { text: "smoke article", limit: 5, scope: "all" }, id), workspace.id)).items[0]);
    report.article = article && { title: article.title, doi: article.doi, kind: article.kind, hasPdf: !!(article.hash || article.fileHash) };
    await shell.screenshot({ path: path.join(shots, "article-in-library.png") });

    // A bot check that does not move on: the bar offers a reload.
    await shell.evaluate((url) => window.key.tabAction("open-url", { url }), `${base}/challenge`);
    await until(async () => (await activeView())?.web?.stalled, "the stalled check", 15000);
    await shell.locator(".key-web-stalled").waitFor();
    await shell.screenshot({ path: path.join(shots, "challenge-stalled.png") });
    await shell.emulateMedia({ colorScheme: "dark" });
    await shell.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await wait(400);
    await shell.screenshot({ path: path.join(shots, "challenge-stalled-dark.png") });
    await shell.evaluate(() => window.key.setAppSettings({ theme: "system" }));

    console.log("BROWSER PDF SMOKE", JSON.stringify(report, null, 1));
    console.log("SCREENSHOTS", shots);
  } finally {
    await app.close().catch(() => undefined);
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
