// Library proxies in the in-app browser, against a local fake EZproxy: a login through it is
// recognised and offered, Remember keeps it, the journal's pages then go through it on their
// own ("Via …" with Undo and Don't proxy this site), a site visited through it joins it, Add to
// library and a PDF download work through it and keep the journal's own address, and proxies
// import from a fixture zotero.sqlite and fixture Zotero Connector storage (Chrome, Firefox).
// Every *.test host resolves to the local server (Chromium's host resolver rules).
const { _electron: electron } = require("playwright-core");
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
    // The journal itself: a paywall without the proxy.
    if (host === "journal.test" || host === "other.test") {
      if (url.pathname.startsWith("/pdf/")) {
        res.statusCode = 403;
        return send(page("Forbidden"));
      }
      return send(page("Paywall | Journal of Proxies", "<h1>Sign in through your library</h1>"));
    }
    res.statusCode = 404;
    send(page("Not found"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, log };
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
  const { server, port, log } = await serve();
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

    // 2. The journal's own address now goes through the proxy on its own.
    await open("http://journal.test/article");
    await until(async () => (await activeView())?.web?.proxy?.via?.redirected, "the transparent redirect");
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
    await shell.locator(".key-web-article").click();
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

    // 5. Undo: this tab goes to the journal itself, and stays there.
    await open("http://journal.test/article");
    await until(async () => (await activeView())?.web?.proxy?.via?.redirected, "the second redirect");
    await shell.getByRole("button", { name: "Undo" }).click();
    await until(async () => (await activeView())?.title?.startsWith("Paywall"), "the unproxied page after Undo");
    await wait(500);
    assert(!(await activeView()).web.proxy?.via, "after Undo the page is not proxied");

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
