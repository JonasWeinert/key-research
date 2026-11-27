// Run serially: native windows and focus are shared with other GUI checks.
// Database search against the library host's real engine (crates/key-connectors), with every
// database answered by a loopback mock from the recorded fixtures (connectors/fixtures,
// KEY_CONNECTORS_MOCK): the connectors are listed from the host; PubMed's translation and count
// come from the engine; a search on PubMed and the Crossref series runs and its results are
// listed; works go to the library (tagged) and the Inbox; the run report comes from the host as
// Markdown. Needs a host built with the db_* commands (KEY_HOST_EXECUTABLE).
const { _electron: electron } = require("playwright-core");
const { mkdtemp, readFile, readdir } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const fixtures = path.resolve(__dirname, "../../../../../connectors/fixtures");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-db-host-"));
  // Every recorded exchange, answered by host and path (the query string is ignored).
  const exchanges = [];
  for (const dir of await readdir(fixtures)) {
    for (const file of await readdir(path.join(fixtures, dir)).catch(() => [])) {
      if (!file.endsWith(".json")) continue;
      const data = JSON.parse(await readFile(path.join(fixtures, dir, file), "utf8"));
      for (const e of data.exchanges ?? []) {
        const url = new URL(e.url);
        exchanges.push({ key: `/${url.host}${url.pathname}`, retmax0: url.searchParams.get("retmax") === "0", e });
      }
    }
  }
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    log.push(url.pathname + url.search);
    const counting = url.searchParams.get("retmax") === "0";
    const hit = exchanges.find((x) => x.key === url.pathname && (!url.pathname.includes("esearch") || x.retmax0 === counting)) ?? exchanges.find((x) => x.key === url.pathname);
    if (!hit) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not recorded");
    }
    res.writeHead(hit.e.status, hit.e.headers);
    res.end(hit.e.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mock = `http://127.0.0.1:${server.address().port}`;

  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"), KEY_DB_SEARCH_MOCK: "0", KEY_CONNECTORS_MOCK: mock },
  });
  const shot = async (page, name) => (await page.waitForTimeout(450), page.screenshot({ path: path.join(temp, `${name}.png`) }));
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const connectors = await call("db_connectors");
    const ids = connectors.map((c) => c.id);
    for (const id of ["pubmed", "crossref-series"]) assert.ok(ids.includes(id), `the host lists ${id} (${ids.join(", ")})`);
    const reviews = await call("store_collection_create", { name: "Review" });

    // The command opens the tab; the engine's connectors, not sample data.
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "databases", workspaceId: id }), ws.id);
    const db = page.getByRole("region", { name: "Database search" });
    await db.locator(".kx-db-concept").first().waitFor();
    assert.equal(await db.getByText("Sample data", { exact: true }).count(), 0, "the host's engine, not sample data");
    // Choose PubMed and the Crossref series.
    await db.getByRole("button", { name: /^Choose/ }).click();
    const picker = page.getByRole("dialog", { name: "Choose databases" });
    for (const c of connectors) {
      const box = picker.locator(".kx-db-option", { hasText: c.name }).first().getByRole("checkbox");
      if (["pubmed", "crossref-series"].includes(c.id)) await box.check();
      else if (await box.isChecked()) await box.uncheck();
    }
    await shot(page, "db-host-picker");
    await picker.getByRole("button", { name: "Done" }).click();
    await picker.waitFor({ state: "detached" });

    const concepts = db.locator(".kx-db-concept");
    const first = concepts.first().getByRole("textbox", { name: /Add a term/ });
    await first.fill("vaccine hesitancy");
    await first.press("Enter");
    await db.getByRole("button", { name: "Add concept" }).click();
    const second = concepts.nth(1).getByRole("textbox", { name: /Add a term/ });
    await second.fill("nurses");
    await second.press("Enter");
    const pubmed = db.locator('.kx-db-how-item[data-connector="pubmed"]');
    await page.waitForFunction(() => /nurses/.test(document.querySelector('.kx-db-how-item[data-connector="pubmed"] .kx-db-native')?.textContent ?? ""));
    const native = await pubmed.locator(".kx-db-native").textContent();
    assert.match(native, /"vaccine hesitancy"\[tiab\]/, native);
    await page.waitForFunction(() => /\d/.test(document.querySelector('.kx-db-how-item[data-connector="pubmed"] .kx-db-how-count')?.textContent ?? ""));
    await shot(page, "db-host-build");

    await db.getByRole("textbox", { name: "Name of this search" }).fill("Vaccine hesitancy");
    await db.getByRole("button", { name: /^Search/ }).click();
    const progress = db.locator(".kx-db-progress");
    await progress.locator(".kx-db-progress-foot", { hasText: /Done\.|Stopped\./ }).waitFor({ timeout: 60000 });
    const rows = db.locator(".kx-db-work-list > li.kx-source-item");
    await rows.first().waitFor();
    await shot(page, "db-host-results");
    const found = Number((await db.locator(".kx-db-results-count").textContent()).replace(/\D/g, ""));
    assert.ok(found > 0, "works found");

    // Two to the library, tagged, one to the Inbox.
    for (let i = 0; i < 2; i++) await rows.nth(i).getByRole("checkbox").check();
    await db.getByRole("button", { name: "Add to library…" }).first().click();
    const add = page.locator(".kx-db-add-sheet");
    await add.getByLabel("Collection").selectOption(reviews.id);
    await add.locator(".kx-db-form-row", { hasText: "Tag" }).getByRole("checkbox").check();
    await add.locator(".kx-db-form-row", { hasText: "PDFs" }).getByRole("checkbox").uncheck();
    await add.getByRole("button", { name: "Add 2 works" }).click();
    await add.waitFor({ state: "detached" });
    await page.getByText(/Added 2 works to the library/).waitFor();
    const sources = await call("store_sources", { collectionId: reviews.id, limit: 50 });
    const list = sources.items ?? sources.sources ?? sources;
    assert.equal(list.length, 2, "filed in the collection");
    assert.ok(list.every((s) => s.tags.includes("Vaccine hesitancy")), "tagged");
    await rows.nth(3).getByRole("checkbox").check();
    await db.getByRole("button", { name: "Add to Inbox" }).first().click();
    await page.getByText(/to the Inbox|Inbox/).first().waitFor();

    // The report, from the host.
    await db.getByRole("button", { name: "Report…" }).click();
    const report = page.getByRole("dialog", { name: "Search report" });
    await report.locator(".kx-db-report-table tbody tr").first().waitFor();
    await shot(page, "db-host-report");
    assert.match(await report.locator(".kx-db-report-table").textContent(), /PubMed/);
    await report.getByRole("button", { name: "Close" }).click();
    assert.deepEqual(errors, []);
    console.log(`Database search host smoke passed (${found} works, ${log.length} mock requests). Screenshots in ${temp}`);
  } finally {
    await app.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
