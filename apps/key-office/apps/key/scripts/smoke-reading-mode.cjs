// Reading mode: a PDF shown as reflowed text, assembled by the host from the structure layout
// analysis stored for it. Toggling keeps your place both ways; highlights made on the page show
// on their words; a selection in the text becomes a highlight stored at its real place in the
// PDF; Find, the contents and the typography popover work; and the text reads well (screenshots
// in light and dark) for a two-column paper, a paper with tables and figures, and a simple
// single-column document. KEY_READING_PDFS=a.pdf,b.pdf picks other fixtures.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, copyFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const FIXTURES = (process.env.KEY_READING_PDFS || "PUBMED_33599681.pdf,scientific-unlinked.pdf,interaction.pdf").split(",");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-reading-mode-"));
  const files = [];
  for (const name of FIXTURES) {
    const file = path.join(temp, name);
    await copyFile(path.resolve(__dirname, "../../../../../tests/fixtures", name), file);
    files.push(file);
  }
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const until = async (check, what, tries = 600) => {
    for (let i = 0; i < tries; i++) {
      const value = await check();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw Error(`Timed out: ${what}`);
  };
  const shots = [];
  try {
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => window.key);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 900));
    const [ws] = await shell.evaluate(() => window.key.workspaces());
    const call = (command, args) => shell.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const sources = [];
    for (const file of files) sources.push(await call("library_import_file", { path: file }));
    // Analysis runs in the background; reading mode needs its structure.
    const docs = [];
    for (const source of sources) {
      const reply = await until(async () => {
        const r = await call("store_reflow_document", { hash: source.hash });
        return r.status === "ready" ? r : null;
      }, `the structure of ${source.title}`);
      const kinds = {};
      for (const item of reply.document.items) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
      console.log(`${source.title}: ${reply.document.pageCount} pages, ${reply.document.engine}, quality ${reply.document.quality.level}, ${JSON.stringify(kinds)}, ${reply.document.outline.length} headings`);
      docs.push(reply.document);
    }

    const openReader = async (source) => {
      const before = new Set(app.windows());
      await shell.evaluate((s) => window.key.openSource(s), { ...source, documentHash: source.hash, workspaceId: ws.id });
      const pdf = await until(() => app.windows().find((p) => p.url().endsWith("/pdf.html") && !before.has(p)), "the reader");
      pdf.on("pageerror", (e) => console.error("PDF ERROR", e));
      await pdf.getByRole("button", { name: "Reading mode", exact: true }).waitFor({ timeout: 30000 });
      await pdf.waitForFunction(() => document.querySelectorAll(".pdfjs-page canvas").length > 0, null, { timeout: 30000 });
      await pdf.waitForTimeout(600);
      return pdf;
    };
    const themes = async (pdf, name) => {
      for (const scheme of ["light", "dark"]) {
        await shell.evaluate((t) => window.key.setAppSettings({ theme: t }), scheme);
        await pdf.emulateMedia({ colorScheme: scheme });
        await pdf.waitForTimeout(500);
        const file = path.join(temp, `${name}-${scheme}.png`);
        await pdf.screenshot({ path: file });
        shots.push(file);
      }
      await shell.evaluate(() => window.key.setAppSettings({ theme: "light" }));
      await pdf.emulateMedia({ colorScheme: "light" });
    };
    const toolbarPage = (pdf) => pdf.locator(".key-pdf-page").evaluate((e) => Number(e.firstChild.textContent));

    // 1. The two-column paper: toggling keeps the place, both ways.
    let pdf = await openReader(sources[0]);
    const target = Math.min(3, docs[0].pageCount);
    // Pages are laid out evenly (the reader creates their elements as they come near).
    await pdf.evaluate(({ page, count }) => {
      const scroll = document.querySelector(".pdfjs-scroll");
      scroll.scrollTo({ top: (scroll.scrollHeight / count) * (page - 1 + 0.3), behavior: "instant" });
    }, { page: target, count: docs[0].pageCount });
    await until(async () => (await toolbarPage(pdf)) === target, `page ${target} in the page view`);
    await pdf.getByRole("button", { name: "Reading mode", exact: true }).click();
    await pdf.locator(".kx-reading-article").waitFor();
    await pdf.waitForTimeout(400);
    const readingPage = await toolbarPage(pdf);
    assert(Math.abs(readingPage - target) <= 1, `reading mode opened near page ${target} (at ${readingPage})`);
    console.log(`page view p.${target} -> reading mode p.${readingPage}`);
    await themes(pdf, "two-column");
    // Further down in the text, then back: the page view opens where the text was.
    await pdf.evaluate(() => {
      const scroll = document.querySelector(".kx-reading-scroll");
      scroll.scrollBy({ top: scroll.clientHeight * 2.5, behavior: "instant" });
    });
    await pdf.waitForTimeout(300);
    const readTo = await toolbarPage(pdf);
    await pdf.getByRole("button", { name: "Reading mode", exact: true }).click();
    await pdf.locator(".kx-reading").waitFor({ state: "detached" });
    await until(async () => Math.abs((await toolbarPage(pdf)) - readTo) <= 1, `back in the page view near page ${readTo}`);
    console.log(`reading mode p.${readTo} -> page view p.${await toolbarPage(pdf)}`);

    // 2. A selection in the text becomes a highlight at its place in the PDF.
    await pdf.getByRole("button", { name: "Reading mode", exact: true }).click();
    await pdf.locator(".kx-reading-article").waitFor();
    const chosen = await pdf.evaluate(() => {
      const paragraphs = [...document.querySelectorAll('.kx-reading-text[data-kind="paragraph"]')].filter((p) => p.textContent.length > 200);
      const p = paragraphs[Math.min(2, paragraphs.length - 1)];
      p.scrollIntoView({ block: "center" });
      const text = p.firstChild;
      const start = text.textContent.indexOf(" ", 40) + 1;
      const end = text.textContent.indexOf(" ", start + 60);
      return { item: Number(p.dataset.text), start, end, text: text.textContent.slice(start, end) };
    });
    // Select as a person would: press, drag, release over the words.
    const box = await pdf.evaluate(({ item, start, end }) => {
      const node = document.querySelector(`[data-text="${item}"]`).firstChild;
      const r = document.createRange();
      r.setStart(node, start);
      r.setEnd(node, end);
      const rects = r.getClientRects();
      const a = rects[0], b = rects[rects.length - 1];
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
    }, chosen);
    await pdf.mouse.move(box.x1, box.y1);
    await pdf.mouse.down();
    await pdf.mouse.move(box.x2, box.y2, { steps: 8 });
    await pdf.mouse.up();
    await pdf.locator(".kx-reading-selection").waitFor();
    const selected = await pdf.evaluate(() => document.getSelection().toString());
    await themes(pdf, "selection");
    await pdf.getByRole("button", { name: "Highlight green" }).click();
    const saved = await until(async () => {
      const all = await call("library_annotations", { hash: sources[0].hash });
      return all.find((a) => a.color === "green");
    }, "the highlight saved");
    assert.equal(saved.text.replace(/\s+/g, " ").trim(), selected.replace(/\s+/g, " ").trim(), "the highlight keeps the selected words");
    // Its range is in the PDF's own text, on the page the words came from.
    const run = docs[0].items[chosen.item].runs.find((r) => chosen.start >= r.start && chosen.start < r.end);
    assert.equal(saved.range.start.page, run.page, "stored on the page the words are on");
    const pageText = await pdf.evaluate(async ({ hash, page }) => window.key.invoke("native_text", { id: hash, page }), { hash: sources[0].hash, page: saved.range.start.page }).catch(() => null);
    if (pageText && saved.range.start.page === saved.range.end.page) {
      const words = pageText.characters.slice(saved.range.start.index, saved.range.end.index + 1).map((c) => c.value).join("");
      const fold = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      assert.equal(fold(words), fold(selected), "the stored range covers exactly the selected words");
      console.log("highlight range matches the PDF text");
    }
    // It shows in the text (the reader keeps it), and on the page.
    await until(() => pdf.evaluate(() => CSS.highlights.get("kx-reading-green")?.size > 0), "the highlight in reading mode");
    await themes(pdf, "highlighted");
    await pdf.getByRole("button", { name: "Reading mode", exact: true }).click();
    await pdf.locator(".kx-reading").waitFor({ state: "detached" });
    await until(() => pdf.evaluate(() => document.querySelectorAll("[data-annotation-id], .pdfjs-annotation, .pdfjs-highlight").length > 0), "the highlight on the page");

    // 3. Find and the contents in reading mode.
    await pdf.getByRole("button", { name: "Reading mode", exact: true }).click();
    await pdf.locator(".kx-reading-article").waitFor();
    const word = chosen.text.split(" ").find((w) => w.length > 6)?.replace(/[^\p{L}]/gu, "") || "the";
    await pdf.getByRole("button", { name: "Find", exact: true }).click();
    await pdf.getByRole("textbox", { name: "Find in PDF" }).fill(word);
    await until(() => pdf.evaluate(() => CSS.highlights.get("kx-reading-find")?.size > 0), "find matches in reading mode");
    const status = await pdf.locator(".key-pdf-find [role=status]").textContent();
    assert.match(status, /^1 of \d+/);
    await pdf.getByRole("button", { name: "Close find" }).click();
    if (docs[0].outline.length) {
      await pdf.getByRole("button", { name: "Contents", exact: true }).click();
      await pdf.locator(".kx-reading-contents").waitFor();
      await themes(pdf, "contents");
      await pdf.locator(".kx-reading-contents-row").last().click();
    }
    await pdf.getByRole("button", { name: "Text options" }).click();
    await pdf.locator('.kx-reading-popover[aria-label="Text options"]').waitFor();
    await pdf.getByRole("tab", { name: "Sans serif" }).click();
    await pdf.getByRole("button", { name: "Larger text" }).click();
    await themes(pdf, "typography");
    assert.equal(await pdf.locator(".kx-reading").getAttribute("data-font"), "sans");
    await pdf.getByRole("tab", { name: "Serif", exact: true }).click();
    await pdf.getByRole("button", { name: "Smaller text" }).click();
    await pdf.keyboard.press("Escape");
    // Figures and tables: their page's own drawing, with the caption as text.
    for (const kind of ["figure", "table"]) {
      const block = pdf.locator(`.kx-reading-figure[data-kind="${kind}"]`).first();
      if (!(await block.count())) continue;
      await block.evaluate((e) => e.scrollIntoView({ block: "center" }));
      await until(() => block.locator("img").count(), `a ${kind} drawn`);
      await pdf.waitForTimeout(300);
      await themes(pdf, `two-column-${kind}`);
    }

    // 4. The other documents read well too (screenshots).
    for (let i = 1; i < sources.length; i++) {
      pdf = await openReader(sources[i]);
      await pdf.getByRole("button", { name: "Reading mode", exact: true }).click();
      await pdf.locator(".kx-reading-article, .kx-reading-state").first().waitFor();
      await pdf.waitForTimeout(500);
      // A figure or table, when there is one, drawn from its page.
      const figure = pdf.locator(".kx-reading-figure").first();
      if (await figure.count()) {
        await figure.scrollIntoViewIfNeeded();
        await until(() => figure.locator("img").count(), "a figure drawn");
        await pdf.evaluate(() => document.querySelector(".kx-reading-scroll").scrollBy({ top: -120, behavior: "instant" }));
      }
      await themes(pdf, `doc-${i}`);
    }
    console.log(`reading mode smoke passed; screenshots:\n${shots.join("\n")}`);
  } finally {
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
