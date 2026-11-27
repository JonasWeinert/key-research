// Library proxies in the in-app browser, against a local fake EZproxy: a login through it is
// recognised and offered, Remember keeps it, the journal's pages then go through it on their
// own ("Via …" with Undo and Don't proxy this site), a site visited through it joins it, Add to
// library and a PDF download work through it and keep the journal's own address, and proxies
// import from a fixture zotero.sqlite and fixture Zotero Connector storage (Chrome, Firefox).
// Need-based use: off campus a journal first loads directly, asks for a sign-in and reopens
// through the proxy (the network is then known to need it); on a "campus" network (the fake
// publisher lets everyone in, the fake EZproxy bounces straight to the site) nothing is
// redirected and the bar says the page loaded directly; switching networks relearns, and Find
// PDF's publisher page goes direct on campus and through the proxy off it. Networks are the
// app's simulated ones (KEY_SIMULATED_NETWORK, keyBrowser.network()).
// Every *.test host resolves to the local server (Chromium's host resolver rules).
const { electron } = require("./lib/launch.cjs");
const { execFileSync } = require("node:child_process");
const { mkdtemp, mkdir, readFile, writeFile } = require("node:fs/promises");
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
  const pdf = (n) => Buffer.concat([base, Buffer.from(`\n%key-proxy-smoke-${n}\n`)]);
  const page = (title, body = "", head = "") =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body style="font:15px system-ui;padding:24px;margin:0">${body}</body></html>`;
  const article = (host) =>
    page(
      "Proxied smoke article | Journal of Proxies",
      `<h1>Proxied smoke article</h1><p>Full text, through the library.</p><p><a id="pdf" href="/pdf/2.pdf">Download PDF</a></p>`,
      `<meta name="citation_title" content="Proxied smoke article"><meta name="citation_author" content="Grace Hopper">
       <meta name="citation_doi" content="10.5555/key-proxy-smoke"><meta name="citation_publication_date" content="2024/06/01">
       <meta name="citation_journal_title" content="Journal of Proxies"><meta name="citation_pdf_url" content="http://${host}/pdf/1.pdf">`,
    );
  const log = [];
  // On campus: the publisher lets everyone in, and EZproxy sends campus addresses straight on.
  const state = { campus: false };
  const journals = new Set(["journal.test", "other.test", "third.test"]);
  const paywall = () =>
    page(
      "Paywall | Journal of Proxies",
      `<h1>Sign in through your library</h1><p>Abstract only.</p><p><a href="/action/showLogin?uri=%2Farticle">Access through your institution</a> <button>Get access</button></p>`,
      `<meta name="citation_title" content="Proxied smoke article"><meta name="citation_doi" content="10.5555/key-proxy-smoke">`,
    );
  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const url = new URL(req.url, `http://${host}`);
    log.push(`${host}${url.pathname}`);
    const send = (body, type = "text/html") => {
      res.setHeader("content-type", type);
      res.end(body);
    };
    // The proxy: its login sends on to the proxied host (www-site-test.proxy.test).
    if (host === "login.proxy.test" && url.pathname === "/login") {
      res.setHeader("server", "EZproxy");
      const target = new URL(url.searchParams.get("qurl") ?? url.search.replace(/^\?url=/, ""));
      res.statusCode = 302;
      if (state.campus) {
        res.setHeader("location", target.toString());
        return res.end();
      }
      res.setHeader("location", `http://${target.hostname.replace(/-/g, "--").replace(/\./g, "-")}.proxy.test${target.pathname}${target.search}`);
      return res.end();
    }
    if (host.endsWith(".proxy.test")) {
      res.setHeader("server", "EZproxy");
      if (url.pathname === "/article") return send(article(host));
      if (url.pathname === "/paper") return send(page("Another paper", "<h1>Another paper</h1>"));
      const m = url.pathname.match(/^\/pdf\/(\d+)\.pdf$/);
      if (m) return send(pdf(m[1]), "application/pdf");
    }
    // The journal itself: a paywall without the proxy, the full text on campus.
    if (journals.has(host)) {
      const m = url.pathname.match(/^\/pdf\/(\d+)\.pdf$/);
      if (state.campus && m) return send(pdf(`direct-${m[1]}`), "application/pdf");
      if (state.campus && url.pathname === "/article") return send(article(host));
      if (url.pathname.startsWith("/pdf/")) {
        res.statusCode = 403;
        return send(page("Forbidden"));
      }
      if (url.pathname.startsWith("/action/showLogin")) return send(page("Sign in", `<form><input type="password"></form>`));
      return send(paywall());
    }
    res.statusCode = 404;
    send(page("Not found"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, log, state };
}

/** A LevelDB log with one record putting `key` = `value` (what Chrome's extension storage holds). */
function levelDbLog(key, value) {
  const varint = (n) => {
    const out = [];
    while (n > 0x7f) {
      out.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    out.push(n);
    return Buffer.from(out);
  };
  const k = Buffer.from(key);
  const v = Buffer.from(value);
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(7n, 0);
  head.writeUInt32LE(1, 8);
  const batch = Buffer.concat([head, Buffer.from([1]), varint(k.length), k, varint(v.length), v]);
  const record = Buffer.alloc(7);
  record.writeUInt16LE(batch.length, 4);
  record[6] = 1;
  return Buffer.concat([record, batch]);
}

async function fixturesIn(temp) {
  // Zotero desktop: its legacy proxy tables.
  const zotero = path.join(temp, "zotero");
  await mkdir(zotero, { recursive: true });
  execFileSync("/usr/bin/sqlite3", [
    path.join(zotero, "zotero.sqlite"),
    `CREATE TABLE proxies (proxyID INTEGER PRIMARY KEY, multiHost INT, autoAssociate INT, scheme TEXT);
     CREATE TABLE proxyHosts (hostID INTEGER PRIMARY KEY, proxyID INTEGER, hostname TEXT);
     INSERT INTO proxies VALUES (1, 1, 1, 'https://%h.ezproxy.desktop-uni.edu/%p');
     INSERT INTO proxyHosts VALUES (1, 1, 'www.jstor.org'), (2, 1, 'www.nature.com');`,
  ]);
  // The Connector in Chrome (extension storage) and in Firefox (storage.js).
  const home = path.join(temp, "home");
  const chrome = path.join(home, "Library/Application Support/Google/Chrome/Default/Local Extension Settings/ekhagklcjbdpajgpjgmbionohlpdbjgc");
  await mkdir(chrome, { recursive: true });
  const connector = [{ id: 1, autoAssociate: true, hosts: ["www.tandfonline.com", "link.springer.com"], toProperScheme: "%h.idm.connector-uni.org/%p", toProxyScheme: "https://connector-uni.idm.oclc.org/login?qurl=%u" }];
  await writeFile(path.join(chrome, "000003.log"), levelDbLog("proxies.proxies", JSON.stringify(connector)));
  const firefox = path.join(home, "Library/Application Support/Firefox/Profiles/abcd.default-release/browser-extension-data/zotero@chnm.gmu.edu");
  await mkdir(firefox, { recursive: true });
  await writeFile(
    path.join(firefox, "storage.js"),
    JSON.stringify({ "proxies.proxies": [{ id: 2, type: "openathens", autoAssociate: true, hosts: ["www.sciencedirect.com"], toProxyScheme: "https://go.openathens.net/redirector/firefox-uni.ac.uk?url=%u" }] }),
  );
  return { zotero, home };
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-proxies-"));
  await mkdir(path.join(temp, "profile"));
  const shots = path.join(temp, "shots");
  await mkdir(shots);
  const { zotero, home } = await fixturesIn(temp);
  const { server, port, log, state } = await serve();
  const report = {};
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: [...(process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")]), `--host-resolver-rules=MAP *.test 127.0.0.1:${port}`],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_BROWSER_SMOKE: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_ZOTERO_DATA_DIR: zotero,
      KEY_PROXY_IMPORT_HOME: home,
      KEY_SIMULATED_NETWORK: "Home network",
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
    const proxies = () => shell.evaluate(() => window.key.proxies("get"));
    const open = (url) => shell.evaluate((u) => window.key.tabAction("open-url", { url: u }), url);
    const pageOf = (pattern) => until(async () => app.windows().find((p) => pattern.test(p.url())), `a page at ${pattern}`);
    const shot = (name) => shell.screenshot({ path: path.join(shots, `${name}.png`) });

    // 1. A link through the library's login: EZproxy is recognised and offered in the bar.
    await open("http://login.proxy.test/login?qurl=http%3A%2F%2Fjournal.test%2Farticle");
    await pageOf(/^http:\/\/journal-test\.proxy\.test\/article$/);
    await until(async () => (await activeView())?.web?.proxy?.offer, "the offer to remember the proxy");
    await shell.locator(".key-web-proxy[data-offer]").waitFor();
    await shot("offer");
    await shell.getByRole("button", { name: "Remember" }).click();
    const kept = await until(async () => (await proxies()).proxies[0], "the remembered proxy");
    report.remembered = kept;
    assert(kept.scheme === "http://login.proxy.test/login?qurl=%u" && kept.properScheme === "http://%h.proxy.test/%p", "the proxy's login and host pattern");
    assert(kept.dotsToHyphens && kept.hosts.join() === "journal.test" && kept.source === "detected", "hyphens, the journal, recognised");
    await until(async () => (await activeView())?.web?.proxy?.via && !(await activeView()).web.proxy.offer, "the bar says Via");
    // The bar names the journal by its own address now.
    assert((await activeView()).web.url === "http://journal.test/article", "the bar shows the proper URL");
    await shot("remembered");

    // 2. Off campus on a network not seen before: the journal loads directly, asks for a
    // sign-in, and reopens through the proxy on its own; the network is remembered as needing it.
    const proxyId = kept.id;
    const learnedHere = async (access) => {
      const data = await proxies();
      const here = data.networks.find((n) => n.id === data.network?.id);
      return here?.proxies[proxyId]?.access === access && here;
    };
    log.length = 0;
    await open("http://journal.test/article");
    const signin = await until(async () => {
      const via = (await activeView())?.web?.proxy?.via;
      return via?.redirected && via;
    }, "the reload through the proxy after the sign-in page");
    assert(signin.why === "signin", `opened through the proxy because of the sign-in (${signin.why})`);
    assert(log.includes("journal.test/article"), "the journal was tried directly first");
    await shell.locator(".key-web-proxy", { hasText: "the site asked you to sign in" }).waitFor();
    await shot("signin-light");
    report.offCampus = await until(() => learnedHere("proxy"), "this network learned as needing the proxy");
    // Known now: the next visit goes through the proxy up front.
    log.length = 0;
    await open("http://journal.test/article");
    await until(async () => (await activeView())?.web?.proxy?.via?.why === "network", "the up-front redirect on a known network");
    assert(!log.includes("journal.test/article"), "no direct try on a network known to need the proxy");
    const viaPage = await until(async () => app.windows().find((p) => p.url() === "http://journal-test.proxy.test/article" && p !== undefined), "the proxied page");
    await shell.locator(".key-web-proxy", { hasText: "Undo" }).waitFor();
    await shot("via-light");
    await shell.emulateMedia({ colorScheme: "dark" });
    await shell.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await wait(400);
    await shot("via-dark");
    await shell.evaluate(() => window.key.setAppSettings({ theme: "system" }));
    await shell.emulateMedia({ colorScheme: "light" });

    // 3. Add to library: the article (and its PDF through the proxy) keep the journal's address.
    const [workspace] = await shell.evaluate(() => window.key.workspaces());
    await until(async () => (await activeView())?.web?.article?.doi === "10.5555/key-proxy-smoke", "the article detected");
    await shell.locator(".key-web-article", { hasText: "Add to library" }).click();
    await until(async () => (await activeView())?.web?.article?.inLibrary, "the article in the library", 60000);
    const source = await until(async () => {
      const found = await shell.evaluate((id) => window.key.invoke("store_sources", { text: "Proxied smoke article", limit: 5, scope: "all" }, id), workspace.id);
      return found.items.find((s) => s.title === "Proxied smoke article" && (s.fileHash || s.hash));
    }, "the article with its PDF", 60000);
    report.article = { url: source.url, doi: source.doi, hasPdf: !!(source.fileHash || source.hash) };
    assert(!source.url || !/proxy\.test/.test(source.url), "the source's URL is not the proxy's");
    assert(log.includes("journal-test.proxy.test/pdf/1.pdf"), "the PDF came through the proxy");

    // 4. A PDF link on the proxied page: the reader keeps the journal's own address.
    await viaPage.click("#pdf");
    const entry = await until(async () => (await app.evaluate(() => globalThis.keyBrowser.temp.list())).find((e) => e.url.endsWith("/pdf/2.pdf")), "the downloaded PDF");
    report.download = { url: entry.url, referrer: entry.referrer };
    assert(entry.url === "http://journal.test/pdf/2.pdf" && entry.referrer === "http://journal.test/article", "the temporary PDF has proper URLs");
    // The reader opens (and takes the front) a moment after the download is listed: wait for it,
    // or it lands on top of the tab the next step opens.
    await until(async () => {
      const view = await activeView();
      return view?.kind === "pdf" && view.temp;
    }, "the downloaded PDF open in the reader");

    // 5. Undo: this tab goes to the journal itself, and stays there.
    await open("http://journal.test/article");
    await until(async () => (await activeView())?.web?.proxy?.via?.redirected, "the second redirect");
    await shell.getByRole("button", { name: "Undo" }).click();
    await until(async () => (await activeView())?.title?.startsWith("Paywall"), "the unproxied page after Undo");
    await wait(500);
    assert(!(await activeView()).web.proxy?.via, "after Undo the page is not proxied");
    // Undo is kept for this site on this network; Settings can forget it.
    const undone = await until(async () => {
      const data = await proxies();
      return data.networks.find((n) => n.id === data.network?.id)?.hosts["journal.test"];
    }, "the Undo remembered");
    assert(undone.access === "direct" && undone.how === "user", "Undo kept as a choice for the site here");
    const here = (await proxies()).network.id;
    await shell.evaluate((p) => window.key.proxies("network", p), { op: "choose-site", id: here, host: "journal.test" });

    // 6. Don't proxy this site: the journal leaves the proxy for good.
    await open("http://journal.test/article");
    await until(async () => (await activeView())?.web?.proxy?.via?.redirected, "the third redirect");
    await shell.getByRole("button", { name: "Don’t proxy this site" }).click();
    await until(async () => (await proxies()).prefs.excluded.includes("journal.test"), "the site excluded");
    assert(!(await proxies()).proxies[0].hosts.includes("journal.test"), "the site left the proxy's hosts");
    await open("http://journal.test/article");
    await until(async () => (await activeView())?.title?.startsWith("Paywall"), "the journal unproxied in a new tab");
    await wait(800);
    assert(!(await activeView()).web.proxy?.via, "an excluded site is not sent through the proxy");

    // 7. A site visited through the proxy joins it.
    await open("http://other-test.proxy.test/paper");
    await until(async () => (await proxies()).proxies[0].hosts.includes("other.test"), "the visited site associated");
    report.hostsAfterVisit = (await proxies()).proxies[0].hosts;

    // 9. On campus: the publisher lets this network in. A site of the proxy loads directly
    // (the probe sees EZproxy bounce straight to the site, the page shows the full text), and
    // the network is learned as direct: nothing is redirected there.
    await shell.evaluate((p) => window.key.proxies("save", p), { ...(await proxies()).proxies[0], hosts: ["other.test", "third.test"] });
    state.campus = true;
    await app.evaluate(() => globalThis.keyBrowser.network("uni.ac.uk"));
    log.length = 0;
    await open("http://other.test/article");
    await until(async () => (await activeView())?.web?.proxy?.direct, "the direct notice on campus");
    assert(!(await activeView()).web.proxy.via && (await activeView()).web.url === "http://other.test/article", "on campus the site is not proxied");
    report.campus = await until(() => learnedHere("direct"), "the campus network learned as direct");
    log.length = 0;
    await open("http://third.test/article");
    await until(async () => (await activeView())?.web?.proxy?.direct?.why === "network", "a direct load on the known campus network");
    await shell.locator(".key-web-proxy[data-direct]", { hasText: "you seem to be on your library’s network" }).waitFor();
    assert(!log.some((l) => l.includes("proxy.test")), "nothing went through the proxy on campus");
    await shot("direct-light");
    await shell.emulateMedia({ colorScheme: "dark" });
    await shell.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await wait(400);
    await shot("direct-dark");
    await shell.evaluate(() => window.key.setAppSettings({ theme: "system" }));
    await shell.emulateMedia({ colorScheme: "light" });
    // Find PDF's publisher page goes direct on campus.
    const findSource = await shell.evaluate((id) => window.key.invoke("store_create", { source: { kind: "reference", itemType: "article", indexStatus: "skipped", title: "Find PDF through the network", url: "http://third.test/article" } }, id), workspace.id);
    const browseFor = async () => {
      const found = await shell.evaluate(({ id, ws }) => window.key.invoke("web_find_pdf", { id }, ws), { id: findSource.id, ws: workspace.id });
      assert(found.status === "browser" && found.url === "http://third.test/article", `Find PDF hands the publisher's page to the browser (${JSON.stringify(found)})`);
      await shell.evaluate(({ url, ws, id }) => window.key.tabAction("open-url", { url, pdfFor: { workspaceId: ws, sourceId: id, title: "Find PDF through the network" } }), { url: found.url, ws: workspace.id, id: findSource.id });
    };
    log.length = 0;
    await browseFor();
    await until(async () => (await activeView())?.title?.startsWith("Proxied smoke article"), "Find PDF's page loaded directly on campus");
    assert(!(await activeView()).web.proxy?.via && !log.some((l) => l.includes("proxy.test")), "Find PDF went direct on campus");
    report.findPdfCampus = "direct";

    // 10. Back home: the network is known to need the proxy, so pages (and Find PDF's) go
    // through it up front.
    state.campus = false;
    await app.evaluate(() => globalThis.keyBrowser.network("Home network"));
    log.length = 0;
    await browseFor();
    await until(async () => (await activeView())?.web?.proxy?.via?.why === "network", "Find PDF's page through the proxy at home");
    assert(log.includes("third-test.proxy.test/article") && !log.includes("third.test/article"), "Find PDF went through the proxy off campus");
    report.findPdfHome = "proxy";

    // 11. A new network (a café): nothing known, so it tries directly and relearns.
    await app.evaluate(() => globalThis.keyBrowser.network("Cafe"));
    log.length = 0;
    await open("http://other.test/article");
    await until(async () => (await activeView())?.web?.proxy?.via?.why === "signin", "the café relearns: sign-in, then the proxy");
    assert(log.includes("other.test/article"), "tried directly on the new network");
    await until(() => learnedHere("proxy"), "the café learned as needing the proxy");
    // Back on campus: remembered as direct straight away.
    state.campus = true;
    await app.evaluate(() => globalThis.keyBrowser.network("uni.ac.uk"));
    log.length = 0;
    await open("http://other.test/article");
    await until(async () => (await activeView())?.web?.proxy?.direct?.why === "network", "campus remembered as direct");
    assert(!log.some((l) => l.includes("proxy.test")), "no proxy on the remembered campus");
    report.networks = (await proxies()).networks.map((n) => ({ label: n.label, proxies: n.proxies, hosts: Object.keys(n.hosts) }));
    state.campus = false;
    await app.evaluate(() => globalThis.keyBrowser.network("Home network"));

    // 8. Settings › Library access: import from Zotero and its Connectors, and the edit sheet.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
    const settings = shell.locator(".kx-settings");
    await settings.getByRole("button", { name: "Web & browser", exact: true }).click();
    await settings.getByText("Library access").scrollIntoViewIfNeeded();
    await settings.getByRole("button", { name: "Import from Zotero" }).click();
    await until(async () => (await proxies()).proxies.length >= 4, "the imported proxies");
    const all = await proxies();
    report.imported = all.proxies.map((p) => ({ name: p.name, source: p.source, scheme: p.scheme, hosts: p.hosts }));
    assert(all.proxies.some((p) => p.source === "zotero" && p.hosts.includes("www.jstor.org")), "Zotero desktop's proxy");
    assert(all.proxies.some((p) => p.source === "connector" && p.scheme.includes("connector-uni") && p.hosts.includes("link.springer.com")), "the Chrome Connector's proxy");
    assert(all.proxies.some((p) => p.source === "connector" && p.kind === "openathens"), "the Firefox Connector's OpenAthens");
    await settings.getByRole("heading", { name: "Library proxies" }).scrollIntoViewIfNeeded();
    await wait(300);
    await shot("settings-light");
    await settings.getByText("uni.ac.uk", { exact: true }).waitFor();
    await settings.getByRole("heading", { name: "Networks" }).scrollIntoViewIfNeeded();
    await wait(200);
    await shot("networks-light");
    // Always proxy here, from the networks list.
    const campusRow = settings.locator(".kx-proxy-network", { hasText: "uni.ac.uk" });
    await campusRow.getByRole("combobox").selectOption("proxy");
    await until(async () => (await proxies()).networks.find((n) => n.label === "uni.ac.uk")?.proxies[proxyId]?.how === "user", "Always proxy here chosen");
    await campusRow.getByRole("button", { name: "Forget" }).click();
    await until(async () => !(await proxies()).networks.some((n) => n.label === "uni.ac.uk"), "the campus network forgotten");
    await settings.locator(".kx-proxy-row").first().getByRole("button", { name: "Edit…" }).click();
    await shell.locator(".kx-proxy-sheet").waitFor();
    await wait(300);
    await shot("sheet-light");
    await shell.emulateMedia({ colorScheme: "dark" });
    await shell.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await wait(400);
    await shot("sheet-dark");
    await shell.getByRole("button", { name: "Cancel" }).click();
    await wait(200);
    await shot("settings-dark");
    await shell.evaluate(() => window.key.setAppSettings({ theme: "system" }));
    // Adding one by hand with a preset.
    await settings.getByRole("button", { name: "Add proxy…" }).click();
    await shell.getByRole("radio", { name: "OpenAthens" }).click();
    await shell.locator(".kx-proxy-fields input").first().fill("manual-uni.ac.uk");
    await shell.getByRole("button", { name: "Add proxy", exact: true }).click();
    await until(async () => (await proxies()).proxies.some((p) => p.source === "manual" && p.scheme === "https://go.openathens.net/redirector/manual-uni.ac.uk?url=%u"), "the manual proxy");
    report.count = (await proxies()).proxies.length;

    console.log("PROXY SMOKE", JSON.stringify(report, null, 1));
    console.log("SCREENSHOTS", shots);
  } finally {
    await app.close().catch(() => undefined);
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
