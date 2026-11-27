// Run serially. A review record's full text found in Key's browser INSIDE the review tab (no app
// tab of its own), against a mock publisher (journal.example, served locally; no network):
//   - Find full text on a record with no open copy opens the browser in the reader's place;
//   - the attempt is tracked through two intermediate pages and a mock sign-in hop;
//   - clicking the page's own PDF link attaches it to the review record (no library source),
//     the reader shows it at once and the Full texts row says so;
//   - closing the browser without a PDF ends the attempt and leaves the record needing one;
//   - a PDF of another work is held back with "Attach anyway?";
//   - records linked to a library source (the same work) share one full text: a PDF attached
//     in the library shows in the open review record at once, one found in the review goes to
//     the library source (whose page then says it is in the review), and when both hold
//     different files the person chooses which one the work keeps.
const { electron } = require("./lib/launch.cjs");
const { mkdir, mkdtemp, writeFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await wait(200);
  }
}

const RIVERS = "Rivers and the growth of market towns";
const BRIDGES = "Bridges and ferry crossings on lowland rivers";
const HARBOUR = "Harbour tolls and the river trade of small ports";
const CANALS = "Canal building and the decline of river ports";
const GLACIERS = "Glaciers and alpine farming in the northern valleys";
const prose = (topic, n) => Array.from({ length: n }, (_, i) => `${topic} paragraph ${i}: the records of the valleys were read and compared with care, season by season, across many years of trade and travel.`).join(" ");
const pdfHtml = (title, authors = "Ada Example, Ben Sample") => `<!doctype html><html><head><title>${title}</title><style>body{font:11pt Times,serif;margin:0} .p{page-break-after:always}</style></head><body>
<div class="p"><h1>${title}</h1><p>${authors}</p><p>${prose(title.split(" ")[0], 14)}</p></div><div><h2>Results</h2><p>${prose("Results", 10)}</p></div></body></html>`;
const page = (title, body) => `<!doctype html><html><head><title>${title}</title><meta name="citation_title" content="${title}"></head><body style="font:15px system-ui;padding:24px">${body}</body></html>`;

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-review-browser-"));
  const pdfs = {};
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    log.push(url.pathname);
    // The sign-in hop: a POST that sets a cookie and goes on.
    if (req.method === "POST") {
      req.resume();
      res.writeHead(303, { location: url.searchParams.get("next") ?? "/", "set-cookie": "session=ok; Path=/" });
      return res.end();
    }
    const html = (body, headers = {}) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    if (url.pathname === "/rivers") return html(page(RIVERS, `<h1>${RIVERS}</h1><p>Abstract: river access and market towns.</p><p><a id="next" href="/rivers/issue">Read the article</a></p>`));
    if (url.pathname === "/rivers/issue") return html(page("Issue 12", `<h1>Issue 12</h1><p><a id="next" href="/signin?next=/rivers/full">Sign in to read</a></p>`));
    if (url.pathname === "/signin") return html(page("Sign in", `<h1>Sign in</h1><form method="post" action="/signin?next=${encodeURIComponent(url.searchParams.get("next") ?? "/")}"><input name="user" value="ana"><button id="go">Sign in</button></form>`));
    if (url.pathname === "/rivers/full") return html(page(RIVERS, `<h1>${RIVERS}</h1><p>Full article view.</p><p><a id="pdf" href="/files/rivers.pdf">Download PDF</a></p>`));
    if (url.pathname === "/glaciers") return html(page(GLACIERS, `<h1>${GLACIERS}</h1><p><a id="pdf" href="/files/wrong.pdf">Download PDF</a></p>`));
    if (url.pathname === "/bridges") return html(page(BRIDGES, `<h1>${BRIDGES}</h1><p><a id="pdf" href="/files/bridges.pdf">Download PDF</a></p>`));
    if (url.pathname === "/closing") return html(page("A page with nothing", `<h1>Nothing to download here</h1>`));
    const file = url.pathname.match(/^\/files\/(rivers|wrong|bridges)\.pdf$/);
    if (file && pdfs[file[1]]) {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": pdfs[file[1]].length });
      return res.end(pdfs[file[1]]);
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mock = `http://127.0.0.1:${server.address().port}`;

  const app = await electron.launch({
    args: [path.resolve(__dirname, ".."), `--host-resolver-rules=MAP journal.example 127.0.0.1:${server.address().port}`],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_BROWSER_SMOKE: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_WEB_OPENALEX_URL: mock,
      KEY_WEB_UNPAYWALL_URL: mock,
    },
  });
  const report = {};
  let shell;
  const consoleErrors = [];
  const errors = [];
  try {
    shell = await app.firstWindow();
    shell.setDefaultTimeout(20000);
    shell.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 400)));
    shell.on("pageerror", (e) => errors.push(String(e)));
    await shell.getByRole("region", { name: "Home", exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    const shot = async (name) => {
      await wait(350);
      for (const notice of await shell.locator(".kx-rv-notice").all()) await notice.click({ position: { x: 4, y: 4 } }).catch(() => {});
      await shell.screenshot({ path: path.join(temp, `${name}.png`) });
    };
    const [ws] = await shell.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => shell.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    // Two invented PDFs, printed by the app: the record's, and another work's.
    const print = (html) =>
      app.evaluate(async ({ BrowserWindow }, html) => {
        const w = new BrowserWindow({ show: false, width: 800, height: 1000 });
        try {
          await w.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString("base64")}`);
          return (await w.webContents.printToPDF({ pageSize: "A4" })).toString("base64");
        } finally {
          w.destroy();
        }
      }, html);
    pdfs.rivers = Buffer.from(await print(pdfHtml(RIVERS)), "base64");
    pdfs.bridges = Buffer.from(await print(pdfHtml(BRIDGES)), "base64");
    const files = {};
    for (const [name, title] of [["harbour", HARBOUR], ["canalsA", CANALS], ["canalsB", `${CANALS}: a second copy`]]) {
      const dir = path.join(temp, `pdf-${name}`);
      await mkdir(dir);
      files[name] = path.join(dir, `${name}.pdf`);
      await writeFile(files[name], Buffer.from(await print(pdfHtml(title)), "base64"));
    }
    pdfs.wrong = Buffer.from(await print(pdfHtml("Harbour fees and coastal shipping routes", "Dora Other")), "base64");

    // A review with three records at full text, none with an open copy.
    const reviewId = (await call("review_create", { name: "Rivers review (smoke)", ownerName: "Ana Example" })).reviewId;
    const ana = (await call("review_get", { reviewId, viewer: "" })).team[0].id;
    await call("review_import_records", {
      reviewId,
      records: [
        { title: RIVERS, authors: ["Example, Ada"], year: 2024, url: "http://journal.example/rivers", abstractText: "River access and market towns." },
        { title: GLACIERS, authors: ["Sample, Ben"], year: 2021, url: "http://journal.example/glaciers", abstractText: "Glaciers and farms." },
        { title: "Ferries and fairs in coastal villages", authors: ["Coast, Cy"], year: 2019, url: "http://journal.example/closing", abstractText: "Ferries." },
        { title: HARBOUR, authors: ["Port, Pia"], year: 2018, doi: "10.5555/harbour-tolls", abstractText: "Harbour tolls." },
        { title: BRIDGES, authors: ["Ford, Fay"], year: 2017, doi: "10.5555/bridges", url: "http://journal.example/bridges", abstractText: "Bridges." },
        { title: CANALS, authors: ["Lock, Lu"], year: 2016, doi: "10.5555/canals", abstractText: "Canals." },
      ],
      batch: { group: "databases", name: "Mock" },
      actor: ana,
    });
    const all = (await call("review_records", { reviewId, viewer: ana, query: { stage: "ta", filter: "all", text: "" } })).rows;
    await call("review_decide", { reviewId, recordIds: all.map((r) => r.id), stage: "ta", value: "include", reasons: [], note: "", actor: ana });
    const idOf = (re) => all.find((r) => re.test(r.title)).id;
    const sourcesBefore = (await call("store_sources", { scope: "all", limit: 100 })).items.length;

    await shell.evaluate(({ ws, id }) => window.key.tabAction("open-content", { section: "review", workspaceId: ws, entityId: id, title: "Rivers review (smoke)" }), { ws: ws.id, id: reviewId });
    await shell.getByRole("heading", { name: "Rivers review (smoke)" }).waitFor();
    await shell.getByRole("tab", { name: /Full text/ }).click();
    const tabsBefore = (await shell.evaluate(() => window.key.tabs())).tabs.length;
    const openRecord = async (title) => {
      await shell.getByRole("radio", { name: /Full texts/ }).click();
      await shell.locator(".kx-rv-fulltext-table button", { hasText: title }).click();
      await shell.locator(".kx-rv-compact .kx-rv-record-title", { hasText: title }).waitFor();
    };
    const webPage = (re) => until(async () => app.windows().find((p) => re.test(p.url())), `the page ${re}`);
    const browser = shell.locator(".kx-rv-browser");
    const banner = browser.locator(".kx-find-pdf-banner");

    // 1. Find full text: no open copy, so the publisher's page opens in the review's browser.
    await openRecord(RIVERS);
    await shell.getByRole("button", { name: "Find full text" }).click();
    await browser.waitFor();
    await banner.waitFor();
    assert.equal((await shell.evaluate(() => window.key.tabs())).tabs.length, tabsBefore, "no app tab of its own");
    let web = await webPage(/journal\.example\/rivers$/);
    await web.waitForSelector("#next");
    await shot("browser-in-review-light");
    await shell.emulateMedia({ colorScheme: "dark" });
    await shot("browser-in-review-dark");
    await shell.emulateMedia({ colorScheme: "light" });
    // Two intermediate pages and a sign-in hop: still the same attempt.
    await web.click("#next");
    web = await webPage(/\/rivers\/issue$/);
    await banner.waitFor();
    await (await web.waitForSelector("#next")).click();
    web = await webPage(/\/signin/);
    await (await web.waitForSelector("#go")).click();
    web = await webPage(/\/rivers\/full$/);
    await banner.getByRole("button", { name: "Show me" }).waitFor();
    await until(() => web.evaluate(() => !!document.querySelector("[data-key-pdf-pointer]")), "the halo on the PDF link");
    await web.screenshot({ path: path.join(temp, "embedded-page-pointer.png") });
    report.tracked = ["/rivers", "/rivers/issue", "/signin", "/rivers/full"].every((p) => log.includes(p));
    // The page's own link: the PDF is attached to the record and the reader takes over.
    await web.click("#pdf");
    await shell.locator(".kx-rv-reader[data-kind=pdf]").waitFor({ timeout: 40000 });
    await browser.waitFor({ state: "detached" });
    const rivers = (await call("review_fulltexts", { reviewId })).rows.find((r) => r.id === idOf(/Rivers/));
    assert.equal(rivers.state, "have");
    assert.equal(rivers.file?.origin, "browser");
    assert.equal(rivers.sourceId, null, "kept with the review");
    assert.equal((await call("store_sources", { scope: "all", limit: 100 })).items.length, sourcesBefore, "no library source");
    await shot("reader-after-pdf-light");
    await shell.getByRole("radio", { name: /Full texts/ }).click();
    await shell.getByRole("radio", { name: "All at full text" }).click();
    await shell.locator(".kx-rv-fulltext-table tr[data-state=have]", { hasText: RIVERS }).waitFor();
    report.attached = true;

    // 2. A PDF of another work is held back.
    await shell.getByRole("radio", { name: "Still needed" }).click();
    await openRecord(GLACIERS);
    await shell.getByRole("button", { name: "Find full text" }).click();
    await browser.waitFor();
    web = await webPage(/\/glaciers$/);
    await (await web.waitForSelector("#pdf")).click();
    const question = browser.locator(".kx-rv-browser-question[data-kind=other]");
    await question.waitFor({ timeout: 40000 });
    assert.match(await question.textContent(), /different work/);
    await shot("wrong-work-light");
    await question.getByRole("button", { name: "Keep looking" }).click();
    await question.waitFor({ state: "detached" });
    assert.equal((await call("review_fulltexts", { reviewId })).rows.find((r) => r.id === idOf(/Glaciers/)).state, "need");
    report.wrongWork = true;

    // 3. Closing the browser without a PDF ends the attempt; the record still needs one.
    await browser.getByRole("button", { name: /Close/ }).click();
    await browser.waitFor({ state: "detached" });
    await until(async () => !app.windows().some((p) => /\/glaciers$/.test(p.url())), "the browser page gone");
    await openRecord("Ferries and fairs");
    await shell.getByRole("button", { name: "Open the record's page" }).click();
    await browser.waitFor();
    await webPage(/\/closing$/);
    await shell.keyboard.press("Escape");
    await browser.waitFor({ state: "detached" });
    await until(async () => !app.windows().some((p) => /\/closing$/.test(p.url())), "the closed browser's page gone");
    assert.equal((await call("review_fulltexts", { reviewId })).rows.find((r) => /Ferries/.test(r.title)).state, "need");
    report.closed = true;

    // 4. Linked with the library: one full text for the same work, live both ways.
    const source = (fields) => call("store_create", { source: { kind: "reference", itemType: "article", indexStatus: "skipped", ...fields } });
    const harbourSource = await source({ title: HARBOUR, doi: "10.5555/harbour-tolls" });
    const bridgesSource = await source({ title: BRIDGES, doi: "10.5555/bridges" });
    // The review kept its own file for Canals before the library had the work, with another file.
    await call("review_fulltext_attach", { reviewId, recordId: idOf(/Canal/), path: files.canalsB, name: "canals-review.pdf", origin: "upload", ownedTemp: false, actor: ana });
    const canalsSource = await source({ title: CANALS, doi: "10.5555/canals" });
    await call("store_attach_file", { id: canalsSource.id, path: files.canalsA });
    await openRecord(HARBOUR);
    const chip = shell.locator(".kx-rv-library-chip");
    await chip.waitFor();
    await shell.getByRole("button", { name: "Find full text" }).waitFor();
    // a. A PDF attached in the library shows in the open review record, no reload.
    await call("store_attach_file", { id: harbourSource.id, path: files.harbour });
    await shell.locator(".kx-rv-reader[data-kind=pdf]").waitFor({ timeout: 30000 });
    await shot("linked-library-file-light");
    report.libraryToReview = true;
    // b. A PDF found in the review goes to the linked library source.
    await shell.getByRole("radio", { name: /Full texts/ }).click();
    await shell.getByRole("radio", { name: "Still needed" }).click();
    await openRecord(BRIDGES);
    await shell.getByRole("button", { name: "Find full text" }).click();
    await browser.waitFor();
    web = await webPage(/\/bridges$/);
    await (await web.waitForSelector("#pdf")).click();
    await shell.locator(".kx-rv-reader[data-kind=pdf]").waitFor({ timeout: 40000 });
    await until(async () => (await call("store_source", { id: bridgesSource.id }))?.filePath, "the review's PDF in the library source");
    assert.equal((await call("review_fulltexts", { reviewId })).rows.find((r) => r.id === idOf(/Bridges/)).file, null, "one file, the library's");
    await shell.evaluate(({ ws, id }) => window.key.tabAction("open-source-page", { workspaceId: ws, sourceId: id }), { ws: ws.id, id: bridgesSource.id });
    await shell.locator(".kx-review-link", { hasText: "In review Rivers review (smoke)" }).waitFor();
    await shot("source-in-review-light");
    report.reviewToLibrary = true;
    // c. Both hold different files: the person chooses; the review's goes to the library too.
    await shell.evaluate(({ ws, id }) => window.key.tabAction("open-content", { section: "review", workspaceId: ws, entityId: id }), { ws: ws.id, id: reviewId });
    await shell.getByRole("radio", { name: /Full texts/ }).click();
    await shell.getByRole("radio", { name: "All at full text" }).click();
    await shell.locator(".kx-rv-fulltext-table button", { hasText: CANALS }).click();
    const reconcile = shell.getByRole("dialog", { name: "Two full texts for this work" });
    await reconcile.waitFor();
    await shot("reconcile-light");
    await reconcile.getByRole("button", { name: "Use the review’s file" }).click();
    await reconcile.waitFor({ state: "detached" });
    const texts = await call("store_full_texts", { id: canalsSource.id });
    assert.equal(texts.length, 2, "the library keeps its own file beside the review's");
    assert.equal((await call("review_fulltexts", { reviewId })).rows.find((r) => r.id === idOf(/Canal/)).file, null);
    report.reconciled = true;

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, ...report }));
  } catch (e) {
    const first = shell;
    console.error("SHELL", shell?.url(), await shell?.evaluate(() => document.body.innerHTML.slice(0, 600)).catch((e) => String(e)));
    console.error("CONSOLE", JSON.stringify(consoleErrors.slice(-8)), JSON.stringify(errors.slice(-4)));
    console.error("UI", JSON.stringify(await first.locator(".kx-rv-notice, .kx-rv-browser").allInnerTexts().catch(() => [])));
    await first.screenshot({ path: path.join(temp, "failure-shell.png") }).catch(() => {});
    for (const [i, p] of app.windows().entries()) await p.screenshot({ path: path.join(temp, `failure-${i}.png`) }).catch(() => {});
    console.error("Artifacts", temp, "requests", JSON.stringify(log));
    throw e;
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
