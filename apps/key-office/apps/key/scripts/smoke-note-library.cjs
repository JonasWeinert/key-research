// Run serially: native windows and focus are shared with other GUI checks.
// A note's library: the button at the note's top left fades while you write and comes back
// when the pointer nears it; ⇧⌘L opens the panel on the note's left with the search focused
// and every reference listed. Arrow keys and Enter put a citation in at the cursor and the
// panel stays; a passage found in a PDF goes in as a quote with its source and page; a row
// dragged into the note cites it where it lands. Esc clears the search, then closes the
// panel and the cursor is back in the note. A narrow pane gets the panel over the note.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-note-library-"));
  const fixture = path.join(temp, "Interaction study.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf")));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    // Two references: a PDF with text to quote, and a reference without a file.
    const [pdf] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    await call("store_update", { id: pdf.id, patch: { creators: [{ given: "Marco", family: "Palma" }], year: 2022 } });
    await call("store_create", { source: { kind: "reference", title: "Health versus income", year: 2019, creators: [{ given: "Ada", family: "Okafor" }] } }).catch(() => undefined);
    const reference = (await call("store_sources", { limit: 10, offset: 0 })).items.find((s) => s.title === "Health versus income");
    assert.ok(reference, "the reference was created");
    const note = await call("store_note_save", { id: null, sourceId: null, title: "Reading notes", body: "Income matters" });
    await page.evaluate(({ id, noteId }) => window.key.tabAction("open-content", { section: "note", workspaceId: id, noteId, title: "Reading notes" }), { id: ws.id, noteId: note.id });
    const notePage = page.locator(".kx-note-shell:visible").filter({ has: page.locator("input[value='Reading notes']") });
    const prose = notePage.locator(".ne-prose");
    await prose.waitFor();
    const fab = notePage.getByRole("button", { name: "Library", exact: true });
    const opacity = () => fab.evaluate((el) => Number(getComputedStyle(el).opacity));
    const body = async (test) => {
      for (let i = 0; i < 60; i++) {
        const saved = await call("store_note", { id: note.id });
        if (test(saved.body)) return saved.body;
        await page.waitForTimeout(150);
      }
      return (await call("store_note", { id: note.id })).body;
    };

    // The button fades while you write and comes back when the pointer nears it.
    assert.match(await fab.getAttribute("title"), /⇧⌘L/, "the tooltip names the shortcut");
    await prose.locator("p").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" a lot");
    await page.waitForFunction((el) => Number(getComputedStyle(el).opacity) < 0.4, await fab.elementHandle());
    await shot(page, "1-button-faded");
    const box = await fab.boundingBox();
    await page.mouse.move(box.x + 60, box.y + 40);
    await page.waitForFunction((el) => Number(getComputedStyle(el).opacity) > 0.95, await fab.elementHandle());
    await page.mouse.move(box.x + 700, box.y + 500);

    // ⇧⌘L opens the panel with the search focused and the library listed.
    await prose.locator("p").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Meta+Shift+L");
    const panel = notePage.getByRole("complementary", { name: "Library" });
    await panel.waitFor();
    const search = panel.getByRole("combobox", { name: "Search the library" });
    await page.waitForFunction(() => document.activeElement?.closest(".kx-note-library") && document.activeElement.matches(".kx-search-input"));
    await panel.locator(".kx-found-hit", { hasText: "Health versus income" }).waitFor();
    await panel.locator(".kx-found-hit", { hasText: "Interaction study" }).waitFor();
    await panel.locator(".kx-found-hit", { hasText: "Okafor · 2019" }).waitFor();
    assert.equal(await fab.getAttribute("aria-expanded"), "true");
    const docked = await panel.evaluate((el) => getComputedStyle(el).position);
    assert.equal(docked, "relative", "a wide pane docks the panel beside the note");
    await shot(page, "2-panel-wide");

    // Search, arrow into the results, Enter: a citation at the cursor; the panel stays.
    await search.fill("Health");
    await panel.locator(".kx-found-hit", { hasText: "Health versus income" }).first().waitFor();
    // The first Esc only closes the field's filter suggestions.
    await search.press("Escape");
    assert.equal(await search.inputValue(), "Health");
    await search.press("ArrowDown");
    await page.waitForFunction(() => document.activeElement?.classList.contains("kx-note-library-results"));
    assert.equal(await panel.locator('.kx-found-hit[aria-selected="true"]').count(), 1);
    await page.keyboard.press("Enter");
    await prose.locator(`a[href^="key://source/${reference.id}"]`).waitFor();
    await page.waitForFunction(() => document.activeElement?.classList.contains("ProseMirror"));
    assert.ok(await panel.isVisible(), "the panel stays open after inserting");
    let saved = await body((b) => b.includes(`key://source/${reference.id}`) && b.includes("Okafor"));
    assert.match(saved, /^Income matters a lot \[[^\]]*Okafor[^\]]*\]\(key:\/\/source\//, `cited after the cursor: ${saved}`);
    // The cursor stayed after the citation: typing goes on from there.
    await prose.locator(`a[href^="key://source/${reference.id}"]`, { hasText: "(Okafor, 2019)" }).waitFor();
    await page.keyboard.type("and more");
    saved = await body((b) => b.includes("and more"));
    assert.match(saved, /\(key:\/\/source\/[^)]+\) and more/, `typing continues after the citation: ${saved}`);

    // A passage found in the PDF goes in as a quote with its source and page.
    for (let i = 0; i < 120 && (await call("store_source", { id: pdf.id })).indexStatus !== "ready"; i++) await page.waitForTimeout(250);
    await page.keyboard.press("Meta+Shift+L");
    await page.waitForFunction(() => document.activeElement?.closest(".kx-note-library") && document.activeElement.matches(".kx-search-input"));
    await search.fill("compare exactly");
    await search.press("Escape");
    const passage = panel.locator(".kx-found-hit", { hasText: "Interaction study" }).locator(".kx-passage").first();
    await passage.waitFor();
    await shot(page, "3-panel-passage");
    await passage.click();
    await prose.locator(".ne-squote").waitFor();
    assert.match(await prose.locator(".ne-squote-text").textContent(), /compare exactly/);
    saved = await body((b) => b.includes(`\`\`\`quote source="${pdf.id}"`));
    assert.match(saved, new RegExp(`\`\`\`quote source="${pdf.id}" page="0"\\n[^\\n]*compare exactly`), `quoted with its page: ${saved}`);

    // A row dragged into the note cites it where it lands.
    await search.fill("");
    const row = panel.locator(".kx-found-hit", { hasText: "Health versus income" }).first();
    await row.waitFor();
    const before = await prose.locator(`a[href^="key://source/${reference.id}"]`).count();
    await row.dragTo(prose.locator("p").first(), { targetPosition: { x: 2, y: 8 } });
    await page.waitForFunction(
      ({ id, before }) => document.querySelectorAll(`.kx-note-shell .ne-prose a[href^="key://source/${id}"]`).length > before,
      { id: reference.id, before },
    );

    // Esc closes the filter suggestions, clears the search, then closes the panel; the cursor is back in the note.
    await search.click();
    await search.fill("zzz");
    await search.press("Escape");
    await search.press("Escape");
    assert.equal(await search.inputValue(), "");
    assert.ok(await panel.isVisible());
    await search.press("Escape");
    await panel.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("ProseMirror"));
    assert.equal(await fab.getAttribute("aria-expanded"), "false");
    // The button opens it too, and ⇧⌘L inside the panel closes it.
    await fab.click();
    await panel.waitFor();
    await page.keyboard.press("Meta+Shift+L");
    await panel.waitFor({ state: "detached" });

    // A narrow pane: the panel lies over the note instead of pushing it.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 800));
    await page.waitForTimeout(300);
    await fab.click();
    await panel.waitFor();
    await page.waitForTimeout(300);
    assert.equal(await panel.evaluate((el) => getComputedStyle(el).position), "absolute", "a narrow pane overlays the panel");
    await shot(page, "4-panel-narrow");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(200);
    await shot(page, "5-panel-narrow-dark");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.waitForTimeout(300);
    await shot(page, "6-panel-wide-dark");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, fade: true, open: true, cite: true, quote: true, drag: true, keyboard: true, narrow: true }));
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
