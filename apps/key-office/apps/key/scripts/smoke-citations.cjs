// Run serially: native windows and focus are shared with other GUI checks.
// Citations through the host's CSL engine: Settings › Citations (searchable style picker,
// language, live preview), the Go menu's Copy Reference (⌘⇧C) and Copy In-Text Citation
// (⌘⇧A) putting text, HTML and RTF on the clipboard, a style switch changing what is copied,
// installing a custom .csl file and removing it, a collection's bibliography, and a note's
// citations and Bibliography block following the chosen style. Screenshots in the temp folder.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const HOUSE_STYLE = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="en-US">
  <info>
    <title>Key smoke house style</title>
    <id>http://www.zotero.org/styles/key-smoke-house</id>
    <category citation-format="author-date"/>
    <updated>2024-01-01T00:00:00+00:00</updated>
  </info>
  <citation>
    <layout prefix="[" suffix="]" delimiter="; ">
      <group delimiter=" ">
        <names variable="author"><name form="short" and="text" et-al-min="3" et-al-use-first="1"/></names>
        <date variable="issued"><date-part name="year"/></date>
      </group>
    </layout>
  </citation>
  <bibliography>
    <sort><key macro="sort-author"/></sort>
    <layout suffix=".">
      <group delimiter=". ">
        <names variable="author"><name name-as-sort-order="all" sort-separator=", " initialize-with="." delimiter="; "/></names>
        <text variable="title" font-style="italic"/>
      </group>
    </layout>
  </bibliography>
  <macro name="sort-author"><names variable="author"><name name-as-sort-order="all"/></names></macro>
</style>
`;

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-citations-"));
  const styleFile = path.join(temp, "house.csl");
  await writeFile(styleFile, HOUSE_STYLE);
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_OPENALEX_ENABLED: "0", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  const result = {};
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    const add = (fields) => call("store_create", { source: { kind: "reference", ...fields } });
    const narang = await add({
      itemType: "article",
      title: "Utility of a deep-learning algorithm to guide novices to acquire echocardiograms for limited diagnostic use",
      creators: [
        { family: "Narang", given: "Akhil", role: "author" },
        { family: "Bae", given: "Richard", role: "author" },
        { family: "Hong", given: "Ha", role: "author" },
      ],
      year: 2021,
      containerTitle: "JAMA Cardiology",
      volume: "6",
      issue: "6",
      pages: "624-632",
      doi: "10.1001/jamacardio.2021.0185",
    });
    const kahneman = await add({ itemType: "book", title: "Thinking, fast and slow", creators: [{ family: "Kahneman", given: "Daniel", role: "author" }], year: 2011, publisher: "Farrar, Straus and Giroux", place: "New York" });
    const doe = await add({ itemType: "article", title: "Measuring attention in reading", creators: [{ family: "Doe", given: "Jane", role: "author" }], year: 2020, containerTitle: "Cognition", volume: "201", pages: "104-118" });
    const shelf = await call("store_collection_create", { name: "Reading list" });
    await call("store_membership", { collectionId: shelf.id, ids: [kahneman.id, doe.id] });
    // The sidebar reads collections when it loads.
    await page.reload();
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();

    const clip = () => app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF() }));
    const clearClip = () => app.evaluate(({ clipboard }) => clipboard.clear());
    const menu = (label) =>
      app.evaluate(({ Menu }, label) => {
        const find = (items) => {
          for (const item of items) {
            if (item.label === label) return item;
            const inner = item.submenu && find(item.submenu.items);
            if (inner) return inner;
          }
        };
        const item = find(Menu.getApplicationMenu().items);
        if (!item) throw Error(`No menu item ${label}`);
        item.click();
      }, label);
    const copied = async (label) => {
      await clearClip();
      await menu(label);
      for (let i = 0; i < 50; i++) {
        const c = await clip();
        if (c.text) return c;
        await page.waitForTimeout(100);
      }
      throw Error(`${label} put nothing on the clipboard`);
    };

    // The library with Narang selected.
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    const row = page.locator(".kx-row", { hasText: "Utility of a deep-learning" }).first();
    await row.waitFor();
    await row.click({ position: { x: 24, y: 14 } });

    // 1. APA by default: the reference with HTML italics and RTF; the in-text citation.
    let c = await copied("Copy Reference");
    assert.equal(
      c.text,
      "Narang, A., Bae, R., & Hong, H. (2021). Utility of a deep-learning algorithm to guide novices to acquire echocardiograms for limited diagnostic use. JAMA Cardiology, 6(6), 624–632. https://doi.org/10.1001/jamacardio.2021.0185",
    );
    assert.match(c.html, /<i>JAMA Cardiology<\/i>/);
    assert.match(c.rtf, /^\{\\rtf1/);
    assert.match(c.rtf, /\{\\i JAMA Cardiology/);
    c = await copied("Copy In-Text Citation");
    assert.equal(c.text, "(Narang et al., 2021)");
    result.apa = true;

    // 2. Settings › Citations: the picker searches, the preview follows, IEEE is chosen.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
    await page.locator(".kx-settings-nav button[data-section=citations]").click();
    const styleButton = page.getByRole("button", { name: "Citation style" });
    await styleButton.waitFor();
    await styleButton.filter({ hasText: "APA Style 7th edition" }).waitFor();
    await page.locator("[data-preview=citation]", { hasText: "(Narang et al., 2021, p. 626)" }).waitFor();
    await shot(page, "1-settings-citations");
    await styleButton.click();
    const search = page.getByRole("searchbox", { name: "Search citation styles" });
    await search.fill("ieee");
    assert.equal(await page.locator(".kx-cite-list [role=option]").count(), 1, "the search narrows the list");
    await shot(page, "2-style-picker");
    await search.press("Enter");
    await page.locator("[data-preview=citation]", { hasText: "[1, p. 626]" }).waitFor();
    await styleButton.filter({ hasText: "IEEE" }).waitFor();
    await page.getByRole("combobox", { name: "Citation language" }).selectOption("de-DE");
    await page.locator("[data-preview=citation]", { hasText: "[1, S. 626]" }).waitFor();
    await page.getByRole("combobox", { name: "Citation language" }).selectOption("en-US");
    await page.locator("[data-preview=citation]", { hasText: "[1, p. 626]" }).waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".kx-settings").waitFor({ state: "detached" });

    // 3. The style switch changes what is copied.
    await row.click({ position: { x: 24, y: 14 } });
    c = await copied("Copy Reference");
    assert.match(c.text, /^\[1\] A\. Narang, R\. Bae, and H\. Hong, “Utility of a deep-learning algorithm/);
    c = await copied("Copy In-Text Citation");
    assert.equal(c.text, "[1]");
    result.styleSwitch = true;

    // 4. A collection's bibliography from the sidebar (IEEE numbers it in the list's order, by title).
    const show = page.getByRole("button", { name: "Show collections" });
    if (await show.count()) await show.first().click();
    await page.locator(".kx-library-collections").getByText("Reading list").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy bibliography" }).click();
    for (let i = 0; i < 50 && !(await clip()).text.includes("Kahneman"); i++) await page.waitForTimeout(100);
    c = await clip();
    assert.match(c.text, /^\[2\] D\. Kahneman, Thinking, fast and slow/m);
    assert.match(c.text, /^\[1\] J\. Doe, “Measuring attention in reading,”/m);
    assert.ok(!c.text.includes("Narang"), "only the collection's sources");
    result.collection = true;

    // 5. Install a custom .csl file; it becomes the style; then remove it.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
    await page.locator(".kx-settings-nav button[data-section=citations]").click();
    await page.locator('input[type=file][aria-label="Style file"]').setInputFiles(styleFile);
    await page.getByRole("button", { name: "Remove Key smoke house style" }).waitFor();
    await page.locator("[data-preview=citation]", { hasText: "[Narang et al. 2021]" }).waitFor();
    await page.getByRole("button", { name: "Citation style" }).filter({ hasText: "Key smoke house style" }).waitFor();
    await shot(page, "3-installed-style");
    await page.keyboard.press("Escape");
    await page.locator(".kx-settings").waitFor({ state: "detached" });
    await row.click({ position: { x: 24, y: 14 } });
    c = await copied("Copy In-Text Citation");
    assert.equal(c.text, "[Narang et al. 2021]");
    c = await copied("Copy Reference");
    assert.equal(c.text, "Narang, A.; Bae, R.; Hong, H. Utility of a deep-learning algorithm to guide novices to acquire echocardiograms for limited diagnostic use.");
    assert.match(c.html, /<i>Utility of a deep-learning/);
    result.install = true;

    // 6. A note's citation and Bibliography block follow the style.
    const note = await call("store_note_save", {
      id: null,
      sourceId: null,
      title: "Draft",
      body: `Novices can acquire images [(Narang et al., 2021)](key://source/${narang.id}) and intuition misleads [(Kahneman, 2011)](key://source/${kahneman.id}).\n\n\`\`\`bibliography\nReferences\n\`\`\``,
    });
    await page.evaluate(({ id, noteId }) => window.key.tabAction("open-content", { section: "note", workspaceId: id, noteId, title: "Draft" }), { id: ws.id, noteId: note.id });
    const editor = page.locator(".kx-note-page .ProseMirror").last();
    await editor.waitFor();
    await editor.locator(".ne-bibliography-list p").first().waitFor();
    await editor.locator("a", { hasText: "[Narang et al. 2021]" }).waitFor();
    const bibText = await editor.locator(".ne-bibliography-list").innerText();
    assert.match(bibText, /Kahneman, D\. Thinking, fast and slow\./);
    assert.match(bibText, /Narang, A\.; Bae, R\.; Hong, H\. Utility/);
    await shot(page, "4-note-house-style");
    // Back to APA (and the custom style removed): the note's citations and list follow.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
    await page.locator(".kx-settings-nav button[data-section=citations]").click();
    await page.getByRole("button", { name: "Remove Key smoke house style" }).click();
    // The style picker's own row may still name the style for a moment: watch the installed row.
    await page.getByRole("button", { name: "Remove Key smoke house style" }).waitFor({ state: "detached" });
    await page.locator("[data-preview=citation]", { hasText: "(Narang et al., 2021, p. 626)" }).waitFor();
    const styles = await call("store_cite_styles");
    assert.ok(!styles.styles.some((s) => s.id === "key-smoke-house"), "the style is gone");
    assert.equal(styles.style, "apa");
    assert.equal(styles.data?.available, true, "the shipped styles are found in the data folder");
    await page.keyboard.press("Escape");
    await page.locator(".kx-settings").waitFor({ state: "detached" });
    await editor.locator("a", { hasText: "(Narang et al., 2021)" }).waitFor();
    await editor.locator(".ne-bibliography-list p", { hasText: "Kahneman, D. (2011). Thinking, fast and slow." }).waitFor();
    await shot(page, "5-note-apa");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(200);
    await shot(page, "6-note-apa-dark");
    await page.emulateMedia({ colorScheme: "light" });
    let body = "";
    for (let i = 0; i < 40 && !body.includes("(Narang et al., 2021)"); i++) {
      await page.waitForTimeout(150);
      body = (await call("store_note", { id: note.id }))?.body ?? "";
    }
    assert.match(body, /\[\(Narang et al\., 2021\)\]\(key:\/\/source\//, "the note keeps its citations as text");
    assert.match(body, /```bibliography\nReferences\n```/);
    result.notes = true;

    // 6b. The citation picker: cite with a locator and prefix, edit, a style for this note only,
    // the reference checker with its fixes, and the source page's "Cited in".
    await editor.locator("p").first().click({ position: { x: 4, y: 8 } });
    await page.waitForFunction(() => {
      const sel = window.getSelection();
      return !!sel && sel.rangeCount > 0 && !!sel.anchorNode && !!document.querySelector(".kx-note-page .ProseMirror")?.contains(sel.anchorNode);
    });
    // Not on a citation: a click there opens it in the picker.
    await editor.locator("p").first().click({ position: { x: 4, y: 8 } });
    await page.keyboard.press("Home");
    await page.keyboard.type("Attention matters ");
    await page.keyboard.press("Control+Meta+c");
    const picker = page.locator(".ne-cite-picker");
    await picker.waitFor();
    await picker.getByRole("textbox", { name: "Search the library" }).fill("Measuring attention");
    await picker.getByRole("option", { name: /Measuring attention/ }).click();
    await picker.getByRole("textbox", { name: "Locator" }).fill("7-9");
    await picker.getByRole("textbox", { name: "Prefix" }).fill("see");
    await shot(page, "7-picker");
    await picker.getByRole("button", { name: "Cite", exact: true }).click();
    const doeCite = editor.locator("a", { hasText: "see Doe, 2020, pp. 7–9" });
    await doeCite.waitFor();
    // Clicking a citation edits it: the author is named in the sentence.
    await doeCite.click();
    await picker.waitFor();
    assert.equal(await picker.getAttribute("aria-label"), "Edit citation");
    await picker.getByRole("checkbox", { name: /Leave out the author/ }).check();
    await picker.getByRole("button", { name: "Update" }).click();
    await editor.locator("a", { hasText: "(see 2020, pp. 7–9)" }).waitFor();
    // A style for this note alone, kept with the note.
    await editor.locator(".ne-bibliography").hover();
    await editor.locator("select[aria-label='Citation style for this note']").selectOption("ieee");
    await editor.locator("a", { hasText: /^\[2\]$/ }).first().waitFor();
    await editor.locator("a", { hasText: "see [1, pp. 7–9]" }).waitFor();
    await editor.locator(".ne-bibliography-list p").first().waitFor();
    await shot(page, "8-note-own-style");
    let saved;
    for (let i = 0; i < 40; i++) {
      saved = await call("store_note", { id: note.id });
      if (saved?.appearance?.citationStyle === "ieee" && saved.body.includes("?cite=")) break;
      await page.waitForTimeout(150);
    }
    assert.equal(saved.appearance.citationStyle, "ieee", "the note keeps its own style");
    assert.match(saved.body, /key:\/\/source\/[^)]*\?cite=/, "the citation keeps its locator in the link");
    // The checker: a trashed source (restored in one click) and a locator written differently.
    await call("store_trash", { ids: [kahneman.id], trashed: true });
    await editor.locator(".ne-bibliography").hover();
    await editor.locator(".ne-bibliography-style").first().selectOption("");
    const issues = editor.locator(".ne-bibliography-issues");
    await issues.waitFor();
    await issues.click();
    const panel = page.locator(".ne-check-panel");
    await panel.locator(".ne-check-issue", { hasText: "is in the trash" }).waitFor();
    await panel.locator(".ne-check-issue", { hasText: "Locator “7-9”" }).waitFor();
    await shot(page, "9-check-references");
    await panel.locator(".ne-check-issue", { hasText: "is in the trash" }).getByRole("button", { name: "Restore" }).click();
    await panel.locator(".ne-check-issue", { hasText: "Locator “7-9”" }).getByRole("button", { name: "Use “7–9”" }).click();
    for (let i = 0; i < 40; i++) {
      const s = await call("store_source", { id: kahneman.id });
      if (!s.trashedAt) break;
      await page.waitForTimeout(150);
    }
    assert.ok(!(await call("store_source", { id: kahneman.id })).trashedAt, "restored from the trash");
    await panel.locator(".ne-check-issue", { hasText: "is in the trash" }).waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    result.picker = true;
    // Where the source is cited: its page counts the note's citation.
    await page.evaluate(({ id, sourceId }) => window.key.tabAction("open-source-page", { workspaceId: id, sourceId }), { id: ws.id, sourceId: doe.id });
    const citedIn = page.locator(".kx-linked-from").last();
    await citedIn.locator("h3", { hasText: "Cited in" }).waitFor();
    await citedIn.locator(".kx-linked-from-row", { hasText: "1 citation" }).waitFor();
    await shot(page, "10-cited-in");
    result.citedIn = true;

    // 7. A whole document's citations in one call: numbering and disambiguation.
    const doc = await call("store_cite_render", {
      style: "ieee",
      citations: [{ items: [{ id: doe.id }] }, { items: [{ id: narang.id, locator: "12" }] }, { items: [{ id: doe.id }] }],
      bibliography: true,
    });
    assert.deepEqual(
      doc.citations.map((x) => x.text),
      ["[1]", "[2, p. 12]", "[1]"],
    );
    assert.equal(doc.bibliography.entries.length, 2);
    result.batch = true;

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, ...result }));
  } catch (e) {
    await app.windows()[0]?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error("Artifacts", temp);
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
