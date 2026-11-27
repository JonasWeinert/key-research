// Reading mode for saved web pages: the article of a saved snapshot shown as reflowed text by
// the shared reading mode (ReadingMode.tsx), assembled by the host (key-index web_reflow.rs).
// The host's page text is the reader's own text index; toggling keeps your place both ways; a
// highlight made on the page shows in reading mode; a selection in reading mode becomes a
// highlight at its exact place on the saved page and shows there; Find and the contents work; a
// search hit opens at its passage in reading mode; a paywalled stub says so and stays as saved.
// Fixtures (invented pages) are crates/key-index/tests/fixtures/web; screenshots of a news
// article, a journal article and a blog post in light and dark land in the folder it prints.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, mkdir, copyFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const FIXTURES = path.resolve(__dirname, "../../../../../crates/key-index/tests/fixtures/web");
const PAGES = {
  news: { file: "news-article.html", url: "https://coastal-ledger.example/2026/03/14/harbour-tidal-power", title: "Harbour town backs tidal power plan" },
  paper: { file: "journal-article.html", url: "https://journals.example.org/upland-ecology/article/10.5555/uel.2025.0412", title: "Soil moisture memory and the timing of first flowering in upland meadows" },
  blog: { file: "blog-post.html", url: "https://notes.example.net/2026/01/winter-sourdough", title: "Why my sourdough stopped rising in winter" },
  stub: { file: "paywall-stub.html", url: "https://weekly.example.com/deep-ocean", title: "Inside the race to map the deep ocean floor" },
};
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

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-web-reading-"));
  const shots = path.join(temp, "shots");
  await mkdir(shots);
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  if (process.env.KEY_SMOKE_VERBOSE) app.process().stderr.on("data", (d) => process.stderr.write(`[main] ${d}`));
  const report = {};
  let shell;
  try {
    shell = await app.firstWindow();
    shell.setDefaultTimeout(20000);
    const errors = [];
    shell.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 900));
    await shell.waitForFunction(() => window.key);
    await shell.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await shell.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => shell.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    // The saved pages, as "Save to library" keeps them: an HTML file made a web source.
    const sources = {};
    for (const [name, page] of Object.entries(PAGES)) {
      const file = path.join(temp, page.file);
      await copyFile(path.join(FIXTURES, page.file), file);
      const [created] = await call("store_import_files", { paths: [file] });
      await call("store_web_page_apply", { id: created.id, meta: { title: page.title, url: page.url, authors: [] }, capturedAt: "2026-03-15T09:00:00.000Z", existingId: null, existingKind: null, existingHadFile: false });
      sources[name] = await call("store_source", { id: created.id });
      assert.equal(sources[name].kind, "web", `${name} is a saved web page`);
      const reply = await call("store_web_reflow_document", { id: created.id });
      const kinds = {};
      for (const item of reply.document.items) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
      report[name] = { quality: reply.document.quality.level, kinds, headings: reply.document.outline.length };
    }
    console.log(JSON.stringify(report, null, 1));
    assert.equal(report.paper.quality, "good");
    assert.equal(report.news.quality, "good");
    assert.equal(report.blog.quality, "good");
    assert.notEqual(report.stub.quality, "good");

    const frameOf = async (marker) =>
      until(async () => {
        for (const f of shell.frames().filter((x) => x.url() === "about:srcdoc")) if (await f.evaluate((m) => document.body.textContent.includes(m), marker).catch(() => false)) return f;
      }, `the saved page with “${marker}”`);
    const openPage = async (name, marker) => {
      await shell.evaluate(({ id, source, title }) => window.key.tabAction("open-content", { section: "webpage", workspaceId: id, sourceId: source, title }), { id: ws.id, source: sources[name].id, title: PAGES[name].title });
      const reader = shell.locator(".kx-web-reader:visible");
      await reader.locator("iframe").waitFor();
      return { reader, frame: await frameOf(marker) };
    };
    const themes = async (name) => {
      for (const scheme of ["light", "dark"]) {
        await shell.evaluate((t) => window.key.setAppSettings({ theme: t }), scheme);
        await shell.emulateMedia({ colorScheme: scheme });
        await wait(450);
        await shell.screenshot({ path: path.join(shots, `${name}-${scheme}.png`) });
      }
      await shell.evaluate(() => window.key.setAppSettings({ theme: "light" }));
      await shell.emulateMedia({ colorScheme: "light" });
    };
    // The frame's text index (web-anchors.ts textIndex), and an offset's text.
    const INDEX = `(() => { const doc = [...document.querySelectorAll(".kx-web-reader iframe")].find((f) => f.offsetParent)?.contentDocument; const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA"]); const w = doc.createTreeWalker(doc.body, 4, { acceptNode: (n) => (n.parentElement && SKIP.has(n.parentElement.tagName) ? 2 : 1) }); let t = ""; for (let n = w.nextNode(); n; n = w.nextNode()) t += n.data; return t; })()`;

    // 1. The journal article: the host's text is the frame's, character for character.
    let { reader, frame } = await openPage("paper", "Soil moisture memory");
    const pageText = await shell.evaluate(INDEX);
    const host = await call("store_web_reflow_document", { id: sources.paper.id });
    assert.equal(host.text.length, pageText.length, "the host's page text has the reader's length");

    // A highlight made on the page (as the original view stores it).
    const quote = "snowmelt can stay high for weeks";
    const at = pageText.indexOf(quote);
    assert.ok(at > 0);
    const now = new Date().toISOString();
    await call("library_apply_annotations", {
      hash: sources.paper.id,
      upserts: [{ id: "page-highlight", documentId: sources.paper.id, text: quote, color: "green", createdAt: now, updatedAt: now, anchor: { version: 1, kind: "web", selectors: [{ type: "TextQuoteSelector", exact: quote, prefix: pageText.slice(at - 32, at), suffix: pageText.slice(at + quote.length, at + quote.length + 32) }, { type: "TextPositionSelector", start: at, end: at + quote.length }] } }],
      deleted: [],
    });

    // 2. Toggle at "3. Results": reading mode opens there.
    await frame.evaluate(() => document.getElementById("sec3").scrollIntoView({ block: "start" }));
    await wait(300);
    await reader.getByRole("button", { name: "Reading mode", exact: true }).click();
    await shell.locator(".kx-reading-article").waitFor();
    await wait(500);
    const topText = () =>
      shell.evaluate(() => {
        const view = document.querySelector(".kx-reading-scroll").getBoundingClientRect();
        const el = [...document.querySelectorAll(".kx-reading-article [data-item]")].find((e) => e.getBoundingClientRect().bottom > view.top + 70);
        return el?.textContent ?? "";
      });
    report.openedAt = (await topText()).slice(0, 60);
    assert.match(report.openedAt, /Results|wetter spring/, `reading mode opens at the page's place: ${report.openedAt}`);
    // The page's highlight shows on its words.
    await until(() => shell.evaluate(() => CSS.highlights.get("kx-reading-green")?.size > 0), "the page's highlight in reading mode");
    const shown = await shell.evaluate(() => [...CSS.highlights.get("kx-reading-green")].map((r) => r.toString()).join(""));
    assert.equal(shown, quote);
    await themes("paper-results");

    // 3. A selection in reading mode becomes a highlight at its exact place on the page.
    // Selects text in the reading view from `from` (or the phrase's start) to the phrase's end, as a
    // drag would; scrolled into view first, since scrolling closes the selection's toolbar.
    const selectPhrase = async (phrase, from = "") => {
      const find = `[...document.querySelectorAll(".kx-reading-article [data-text]")].find((e) => e.textContent.includes(${JSON.stringify(from || phrase)}) && e.textContent.includes(${JSON.stringify(phrase)}))`;
      await shell.evaluate(`${find}.scrollIntoView({ block: "center" })`);
      await wait(400);
      await shell.evaluate(
        ({ phrase, from, find }) => {
          const el = eval(find);
          const start = el.textContent.indexOf(from || phrase);
          const end = el.textContent.indexOf(phrase, start) + phrase.length;
          const walker = document.createTreeWalker(el, 4);
          let seen = 0;
          const range = document.createRange();
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const len = n.data.length;
            if (start >= seen && start < seen + len) range.setStart(n, start - seen);
            if (end > seen && end <= seen + len) range.setEnd(n, end - seen);
            seen += len;
          }
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        },
        { phrase, from, find },
      );
      await shell.locator(".kx-reading-selection").waitFor();
    };
    const phrase = "the soil stays wet longest";
    await selectPhrase(phrase);
    await wait(200);
    await themes("paper-selection");
    await shell.locator(".kx-reading-selection").getByRole("button", { name: "Highlight blue" }).click();
    const made = await until(async () => (await call("library_annotations", { hash: sources.paper.id })).find((a) => a.color === "blue"), "the new highlight stored");
    const position = made.anchor.selectors.find((s) => s.type === "TextPositionSelector");
    assert.equal(made.text, phrase);
    assert.equal(pageText.slice(position.start, position.end), phrase, "stored at the phrase's place on the page");
    await until(() => shell.evaluate(() => CSS.highlights.get("kx-reading-blue")?.size > 0), "the new highlight in reading mode");

    // A comment first: the selection's Comment makes a highlight with it; its mark opens it again.
    await selectPhrase("explained 61%");
    await shell.locator(".kx-reading-selection").getByRole("button", { name: "Add comment" }).click();
    await shell.locator(".kx-reading-comment-card textarea").fill("Compare with the north slope alone.");
    await themes("paper-comment-new");
    await shell.locator(".kx-reading-comment-card").getByRole("button", { name: "Save" }).click();
    const commented = await until(async () => (await call("library_annotations", { hash: sources.paper.id })).find((a) => a.comment === "Compare with the north slope alone."), "the comment stored");
    assert.equal(commented.text, "explained 61%");
    await shell.locator(".kx-web-reader:visible button.kx-reading-comment").first().click();
    await shell.locator(".kx-reading-comment-card textarea").fill("Compare with the north slope alone, and the valley.");
    await themes("paper-comment-edit");
    await shell.locator(".kx-reading-comment-card").getByRole("button", { name: "Save" }).click();
    await until(async () => (await call("library_annotations", { hash: sources.paper.id })).find((a) => a.id === commented.id && /valley/.test(a.comment ?? "")), "the comment edited");
    // A selection across inline maths is placed on the page too.
    await selectPhrase("as a function", "first flowering ");
    await shell.locator(".kx-reading-selection").getByRole("button", { name: "Highlight pink" }).click();
    const maths = await until(async () => (await call("library_annotations", { hash: sources.paper.id })).find((a) => a.color === "pink"), "the highlight across maths stored");
    report.acrossMaths = maths.text;
    assert.match(maths.text.replace(/\s+/g, " "), /^first flowering F/, `across the formula: ${maths.text}`);

    // 4. Contents and Find.
    await reader.getByRole("button", { name: "Contents", exact: true }).click();
    await shell.locator(".kx-reading-contents").waitFor();
    report.contents = await shell.locator(".kx-reading-contents-row").allInnerTexts();
    assert.ok(report.contents.some((t) => /4\. Discussion/.test(t)) && report.contents.some((t) => /References/.test(t)));
    await themes("paper-contents");
    await shell.locator(".kx-reading-contents-row", { hasText: "4. Discussion" }).click();
    await wait(900);
    assert.match(await topText(), /Discussion/, "Contents goes to the heading");
    await reader.getByRole("button", { name: "Find", exact: true }).click();
    await shell.getByRole("textbox", { name: "Find on page" }).fill("flowering");
    await until(() => shell.evaluate(() => CSS.highlights.get("kx-reading-find")?.size > 0), "find matches in reading mode");
    report.find = await shell.locator(".kx-web-find [role=status]").textContent();
    assert.match(report.find, /^1 of \d+/);
    await shell.getByRole("button", { name: "Close find" }).click();
    // Figures, the table, the equation and the references (screenshots).
    for (const kind of ["figure", "table", "equation"]) {
      const block = shell.locator(`.kx-reading-figure[data-kind="${kind}"]`).first();
      await block.evaluate((e) => e.scrollIntoView({ block: "center" }));
      if (kind === "figure") await until(() => block.locator("img").count(), "the figure's picture");
      await wait(300);
      await themes(`paper-${kind}`);
    }
    await shell.locator('.kx-reading-block[data-kind="references"]').first().evaluate((e) => e.scrollIntoView({ block: "center" }));
    await wait(300);
    await themes("paper-references");
    // A citation goes to its reference.
    await shell.locator(".kx-reading-cite").first().evaluate((e) => e.scrollIntoView({ block: "center" }));
    await shell.locator(".kx-reading-cite").first().click();
    await wait(900);
    assert.match(await shell.evaluate(() => document.querySelector('.kx-reading-block[data-kind="references"]').getBoundingClientRect().top < innerHeight ? "yes" : ""), /yes/, "the reference is in view");

    // 5. Back to the saved page at Discussion; the new highlight is drawn there.
    await shell.locator(".kx-reading-contents-row").count();
    await reader.getByRole("button", { name: "Contents", exact: true }).click();
    await shell.locator(".kx-reading-contents-row", { hasText: "4. Discussion" }).click();
    await wait(900);
    await reader.getByRole("button", { name: "Reading mode", exact: true }).click();
    await shell.locator(".kx-reading").waitFor({ state: "detached" });
    await wait(400);
    const heading = await frame.evaluate(() => document.querySelector("#sec4 h2").getBoundingClientRect().top);
    report.backAt = heading;
    assert.ok(heading > -40 && heading < 260, `the saved page opens at Discussion (${heading})`);
    assert.equal(await frame.evaluate(() => [...document.querySelectorAll('mark.key-hl[data-color="blue"]')].map((m) => m.textContent).join("")), phrase, "the highlight on the saved page");

    // 6. A search hit opens at its passage in reading mode (the view now remembered for pages).
    await shell.evaluate(() => window.key.setAppSettings({ readingMode: { pdf: false, web: true } }));
    await reader.getByRole("button", { name: "Reading mode", exact: true }).click();
    await shell.locator(".kx-reading-article").waitFor();
    await until(async () => (await call("store_source", { id: sources.paper.id }))?.indexStatus === "ready", "the page to be indexed", 60000);
    await shell.evaluate((id) => window.key.tabAction("open-content", { section: "search", workspaceId: id }), ws.id);
    const searchTab = shell.locator(".kx-search-page:not([hidden])");
    const field = searchTab.getByRole("combobox", { name: "Search everything" });
    await field.waitFor();
    await field.fill("hierarchical model borrow strength");
    await field.press("Escape");
    const hit = searchTab.locator('.kx-found-group[data-group="text"] .kx-found-hit', { hasText: "Soil moisture memory" });
    await hit.locator(".kx-passage").first().waitFor({ timeout: 20000 });
    await hit.locator(".kx-passage").first().click();
    const lit = await until(() => shell.evaluate(() => [...(CSS.highlights.get("kx-reading-passage") ?? [])].map((r) => r.toString()).join(" ")), "the passage lit in reading mode", 20000);
    report.searchHit = lit.slice(0, 80);
    assert.match(lit, /borrow strength|hierarchical/);
    await until(
      () =>
        shell.evaluate(() => {
          const r = [...CSS.highlights.get("kx-reading-passage")][0].getBoundingClientRect();
          const v = [...document.querySelectorAll(".kx-reading-scroll")].find((s) => s.clientHeight)?.getBoundingClientRect();
          return v && r.height && r.top >= v.top && r.bottom <= v.bottom;
        }),
      "the passage in view",
      8000,
    );
    await wait(400);
    await shell.screenshot({ path: path.join(shots, "paper-search-hit.png") });

    // 7. The news article and the blog post read well too; they open in reading mode now.
    for (const [name, marker, figure] of [["news", "Harbour town", true], ["blog", "sourdough", false]]) {
      ({ reader } = await openPage(name, marker));
      await shell.locator(".kx-web-reader:visible .kx-reading-article").waitFor();
      await wait(400);
      await themes(`${name}-top`);
      if (figure) {
        const block = shell.locator('.kx-web-reader:visible .kx-reading-figure[data-kind="figure"]').first();
        await until(() => block.locator("img").count(), "the photo");
        await shell.locator('.kx-web-reader:visible .kx-reading-text[data-kind="quote"]').first().evaluate((e) => e.scrollIntoView({ block: "center" }));
        await wait(300);
        await themes(`${name}-quote`);
      }
      const all = await shell.locator(".kx-web-reader:visible .kx-reading-article").innerText();
      for (const gone of ["We use cookies", "Newsletter", "Most read", "Older posts", "Advertisement"]) assert.ok(!all.toLowerCase().includes(gone.toLowerCase()), `${name}: no “${gone}”`);
    }
    // The typography popover is the PDF reader's.
    await reader.getByRole("button", { name: "Text options" }).click();
    await shell.locator('.kx-reading-popover[aria-label="Text options"]').waitFor();
    await shell.getByRole("tab", { name: "Sans serif" }).click();
    await themes("blog-typography");
    assert.equal(await shell.locator(".kx-web-reader:visible .kx-reading").getAttribute("data-font"), "sans");
    await shell.getByRole("tab", { name: "Serif", exact: true }).click();
    await shell.keyboard.press("Escape");

    // 8. A paywalled stub says so and stays as saved.
    ({ reader } = await openPage("stub", "deep ocean"));
    await shell.locator(".kx-web-reader:visible .kx-web-notice").waitFor();
    report.stubNotice = await shell.locator(".kx-web-reader:visible .kx-web-notice").innerText();
    assert.match(report.stubNotice, /paywall|sign-in/);
    assert.equal(await shell.locator(".kx-web-reader:visible .kx-reading").count(), 0);
    await shell.screenshot({ path: path.join(shots, "stub-notice.png") });
    await shell.evaluate(() => window.key.setAppSettings({ readingMode: { pdf: false, web: false } }));

    assert.deepEqual(errors, [], "no page errors");
    console.log(JSON.stringify(report, null, 1));
    console.log(`web reading mode smoke passed; screenshots in ${shots}`);
  } catch (e) {
    await shell?.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {});
    console.error(`screenshots in ${shots}`);
    throw e;
  } finally {
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
