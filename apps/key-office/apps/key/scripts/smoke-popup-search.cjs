// Run serially: native windows and focus are shared with other GUI checks.
// The search window (⌘⇧F, ⌘P): sized to the app window at two sizes and steady while
// typing; results grouped by kind with the highlighted one previewed beside them (one pane
// when narrow); typed filters offered as chips and applied with ⇥ (a custom property with a
// number comparison, a select property by name, a negated tag), the filter builder making
// the same token; the Web pill asking a local mock of OpenAlex and Semantic Scholar (never
// without it), "In library" badges, Add to library and Add to Inbox.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const fixtures = path.resolve(__dirname, "../../../../../crates/key-desktop-host/src/web_search/fixtures");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-popup-search-"));
  const noOpenAlex = path.join(temp, "no-openalex");
  await mkdir(noOpenAlex);
  const openalexPage = JSON.parse(await readFile(path.join(fixtures, "openalex-search.json"), "utf8"));
  const s2Page = JSON.parse(await readFile(path.join(fixtures, "s2-search.json"), "utf8"));
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    log.push(url.pathname + url.search);
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/works") return json(url.searchParams.get("cursor") === "*" ? openalexPage : { meta: { count: 0, next_cursor: null }, results: [] });
    if (url.pathname === "/graph/v1/paper/search") return json(s2Page);
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mock = `http://127.0.0.1:${server.address().port}`;

  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_OPENALEX_FIXTURES: noOpenAlex,
      KEY_WEB_OPENALEX_URL: mock,
      KEY_WEB_S2_URL: mock,
    },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
    await size(1600, 1000);
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const command = (name) => app.evaluate(({ BrowserWindow }, name) => BrowserWindow.getAllWindows()[0].webContents.send("command", name), name);

    // A rated source, a less rated one, one tagged draft, a note; and BERT already in the library.
    await call("workspace_save_attribute", { name: "Rating", config: { type: "number" } });
    await call("workspace_save_attribute", { name: "Reading status", config: { type: "select", options: ["To read", "Done"] } });
    await call("store_create", { source: { kind: "reference", itemType: "article", title: "Interaction budgets in trials", year: 2022, properties: { Rating: 5, "Reading status": "Done" }, abstract: "We study interaction budgets across trials." } });
    await call("store_create", { source: { kind: "reference", itemType: "article", title: "Interaction effects revisited", year: 2018, properties: { Rating: 2, "Reading status": "To read" }, tags: ["draft"] } });
    await call("store_create", { source: { kind: "reference", itemType: "article", title: "BERT (my copy)", doi: "https://doi.org/10.18653/V1/N19-1423", year: 2019 } });
    await call("store_note_save", { id: null, sourceId: null, title: "Interaction notes", body: "Interaction effects need a second look." });

    // Large window: the popup takes min(1100px, 80vw) by about 80vh, two panes.
    const t0 = Date.now();
    await command("search");
    const popup = page.locator(".kx-spot");
    await popup.waitFor();
    const openMs = Date.now() - t0;
    const field = popup.getByRole("combobox");
    await field.waitFor();
    const frame = () => page.locator(".key-modal:has(.kx-spot)").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight };
    });
    let box = await frame();
    assert.ok(Math.abs(box.w - Math.min(1100, box.vw * 0.8)) <= 4, `width ${box.w} for ${box.vw}`);
    assert.ok(box.h >= Math.min(box.vh * 0.8, 860) - 8, `height ${box.h} for ${box.vh}`);
    await popup.locator(".kx-spot-preview").waitFor();
    const typedAt = Date.now();
    await page.keyboard.type("Interaction");
    await popup.locator('.kx-spot-group[data-group="source"] .kx-spot-row', { hasText: "Interaction budgets in trials" }).waitFor();
    const firstMs = Date.now() - typedAt;
    await popup.locator('.kx-spot-group[data-group="note"] .kx-spot-row', { hasText: "Interaction notes" }).waitFor();
    assert.equal((await frame()).h, box.h, "the height holds while typing");
    // The highlighted result is previewed; ⌘2 jumps to the second group.
    await popup.locator(".kx-spot-preview .kx-item-head").waitFor();
    await page.keyboard.press("Meta+2");
    await popup.locator('.kx-spot-group[data-group="note"] .kx-spot-row--item:has([aria-selected="true"])').waitFor();
    await shot(page, "1-popup-large");
    // No web search without the pill: only the offer to search.
    await popup.locator(".kx-spot-row", { hasText: "Search the web for" }).waitFor();
    assert.deepEqual(log, [], "nothing asked of the web while Web is off");

    // Typed filters: a custom number property with a comparison, applied with ⇥.
    await field.fill("rating>3");
    const chip = popup.locator(".kx-suggest-chip[data-detected]").first();
    await chip.waitFor();
    assert.match(await chip.textContent(), /Rating.*more than 3/);
    await field.press("Tab");
    await popup.locator('.kx-token[data-field="property"]', { hasText: "more than 3" }).waitFor();
    assert.equal(await field.inputValue(), "");
    await popup.locator(".kx-spot-row", { hasText: "Interaction budgets in trials" }).waitFor();
    assert.equal(await popup.locator(".kx-spot-row", { hasText: "Interaction effects revisited" }).count(), 0, "rating 2 is left out");
    await shot(page, "2-popup-filter-chip");
    // A select property by a name with spaces, and a negated tag.
    await popup.locator(".kx-search-clear").click();
    await field.fill('"reading status":"to read" -tag:draft');
    await popup.locator(".kx-suggest-chip[data-detected]").first().waitFor();
    await field.press("Tab");
    await popup.locator('.kx-token[data-negate]', { hasText: "draft" }).waitFor();
    // The last query's rows stay until the new one answers: wait for it to settle.
    await page.waitForFunction(() => {
      const spot = document.querySelector(".kx-spot");
      const empty = spot?.querySelector(".kx-found-empty")?.textContent ?? "";
      return !!spot && !spot.querySelector(".kx-search-spinner") && !empty.startsWith("Searching") && !!spot.querySelector(".kx-found-empty, .kx-spot-row") && !spot.querySelector('.kx-spot-group[data-group="source"] .kx-spot-row');
    }, null, { timeout: 10000 }).catch(() => {});
    assert.equal(await popup.locator(".kx-spot-group[data-group=source] .kx-spot-row").count(), 0, "to read and not draft: none");
    await popup.locator(".kx-search-clear").click();

    // The filter builder makes the same token by clicking.
    await popup.getByRole("button", { name: "Add a filter" }).click();
    const builder = page.locator(".kx-filter-builder");
    await builder.waitFor();
    await builder.getByRole("combobox", { name: "Field" }).selectOption({ label: "Rating" });
    await builder.getByRole("combobox", { name: "Operator" }).selectOption("gte");
    await builder.getByRole("spinbutton", { name: "Value" }).fill("4");
    assert.equal(await builder.locator(".kx-filter-builder-typed").textContent(), "rating>=4");
    await shot(page, "3-filter-builder");
    await builder.getByRole("button", { name: "Add filter" }).click();
    await popup.locator('.kx-token[data-field="property"]', { hasText: "at least 4" }).waitFor();
    await builder.waitFor({ state: "detached" });
    await popup.locator(".kx-search-clear").click();

    // The Web pill: the mock is asked, BERT shows "In library", the others can be added.
    await field.fill("attention");
    await popup.locator('.kx-web-pill button[data-kind="web"]').click();
    const webGroup = popup.locator('.kx-spot-group[data-group="web"]');
    const attention = webGroup.locator(".kx-spot-row--web", { hasText: "Attention Is All You Need" });
    await attention.waitFor();
    assert.ok(log.some((l) => l.startsWith("/works")), "OpenAlex asked");
    await webGroup.locator(".kx-spot-row--web", { hasText: "BERT" }).locator(".kx-spot-badge[data-state=in]").waitFor();
    await attention.hover();
    const preview = popup.locator(".kx-spot-preview .kx-spot-web");
    await preview.locator(".kx-web-preview-title", { hasText: "Attention Is All You Need" }).waitFor();
    await shot(page, "4-popup-web");
    // Add to Inbox (the host's Inbox, when this build has it).
    const hasInbox = await call("inbox_state", { works: [] }).then(() => true, () => false);
    await preview.getByRole("button", { name: /Add to Inbox/ }).click();
    if (hasInbox) await preview.getByRole("button", { name: /In Inbox|In library/ }).waitFor();
    else await page.locator(".kx-toast", { hasText: "Inbox" }).waitFor();
    // Add to library.
    await preview.locator(".kx-web-add, button", { hasText: "Add to library" }).first().click();
    await webGroup.locator(".kx-spot-row--web", { hasText: "Attention Is All You Need" }).locator(".kx-spot-badge[data-state=in]").waitFor({ timeout: 20000 });
    const sources = await call("store_sources", { text: "Attention Is All You Need" }).catch(() => call("store_search", { text: "Attention Is All You Need" }));
    assert.ok(JSON.stringify(sources).includes("Attention Is All You Need"), "added to the library");
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "detached" });

    // Narrow window: one pane, still sized to the window.
    await size(900, 700);
    await page.waitForTimeout(300);
    await command("quick-open");
    await popup.waitFor();
    box = await frame();
    assert.ok(box.w < 760 && box.w >= Math.min(box.vw * 0.8, box.vw - 48) - 4, `narrow width ${box.w} for ${box.vw}`);
    assert.equal(await popup.locator(".kx-spot-preview").count(), 0, "one pane when narrow");
    await page.keyboard.type("Interaction");
    await popup.locator(".kx-spot-row", { hasText: "Interaction budgets in trials" }).waitFor();
    await shot(page, "5-popup-narrow");
    await page.emulateMedia({ colorScheme: "dark" });
    await size(1600, 1000);
    await page.waitForTimeout(400);
    await shot(page, "6-popup-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.keyboard.press("Escape");

    assert.deepEqual(errors, []);
    console.log(`smoke-popup-search ok (open ${openMs} ms, first results ${firstMs} ms) — screenshots in ${temp}`);
  } finally {
    await app.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
