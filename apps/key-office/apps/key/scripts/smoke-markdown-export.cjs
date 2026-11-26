// Markdown export of highlights: Settings › Markdown export (folder, template with a live
// preview), Export now, the user's own text (around Key's section and under a highlight)
// kept through a re-sync that brings in a new highlight, the automatic export on change,
// a hand edit inside Key's section giving a .conflict.md copy, the one-shot Export
// highlights sheet, the status bar item and a key:// link opened from another app.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rename } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-markdown-export-"));
  const pdf = path.join(temp, "growth.pdf");
  await copyFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf"), pdf);
  const vault = path.join(temp, "Vault", "Literature");
  await mkdir(vault, { recursive: true });
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"), KEY_OPENALEX_FIXTURES: path.resolve(__dirname, "../../../../../tests/fixtures/openalex") },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  const both = async (page, name) => {
    await page.evaluate(() => window.key.setAppSettings({ theme: "light" }));
    await page.waitForTimeout(300);
    await shot(page, `${name}-light`);
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForTimeout(300);
    await shot(page, `${name}-dark`);
    await page.evaluate(() => window.key.setAppSettings({ theme: "system" }));
  };
  const waitFor = async (check, what, tries = 100) => {
    for (let i = 0; i < tries; i++) {
      const value = await check().catch(() => false);
      if (value) return value;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out: ${what}`);
  };
  const highlight = (id, text, page, comment = "") => ({
    id,
    documentId: "doc",
    text,
    comment,
    color: "green",
    range: { start: { page, index: 10 }, end: { page, index: 40 } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  let page;
  try {
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await page.emulateMedia({ colorScheme: null });
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    const [created] = await call("store_import_files", { paths: [pdf] });
    await call("store_update", {
      id: created.id,
      byHand: true,
      patch: { title: "Growth and inequality", date: "2021", creators: [{ family: "Smith", given: "Ann", role: "author" }], tags: ["econ growth"] },
    });
    await call("store_citation_key_set", { id: created.id, key: "smith2021", pinned: true });
    const add = (h) => call("library_apply_annotations", { hash: created.hash, upserts: [h], deleted: [] });
    await add(highlight("h1", "Inequality rose as growth slowed.", 2, "Main claim"));
    await call("store_md_export_config", { config: { ...(await call("store_md_export_config")).config, folder: vault, mode: "demand" } });

    // ── Settings: folder, template and its live preview ──
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: "markdown" })));
    const preview = page.getByTestId("md-preview");
    await waitFor(async () => /Inequality rose as growth slowed\./.test(await preview.innerText()), "live preview from the real source");
    assert.match(await preview.innerText(), /^---\nkey-id: /);
    assert.match(await preview.innerText(), /citekey: smith2021/);
    await page.getByText("smith2021.md").first().waitFor();
    // An edit to the template shows at once; a broken one says where.
    const template = page.getByRole("textbox", { name: "Highlights template" });
    await template.fill(`${await template.inputValue()}\n{{#each groups}}`);
    await page.locator(".kx-md-error").waitFor();
    await page.getByRole("button", { name: "Reset" }).click();
    await page.locator(".kx-md-error").waitFor({ state: "detached" });
    await both(page, "settings-markdown");
    await page.getByRole("button", { name: "Export now" }).click();
    const file = path.join(vault, "smith2021.md");
    await waitFor(async () => existsSync(file), "file written");
    await page.getByTestId("md-last").filter({ hasText: /1 file written/ }).waitFor();
    const first = await readFile(file, "utf8");
    assert.match(first, /> Inequality rose as growth slowed\. \(\[p\. 3\]\(key:\/\/source\/[^)]+#highlight:h1\)\)/);
    assert.match(first, /tags:\n  - econ-growth\n/);
    assert.match(first, /\*\*Main claim\*\*/);

    // ── The user writes in the file; a new highlight comes in; their text stays ──
    const mine = first
      .replace("<!-- key:begin", "My summary: growth and inequality are linked.\n\n<!-- key:begin")
      .replace("<!-- key:notes -->\n", "<!-- key:notes -->\nCompare with Piketty.\n")
      + "\n## My thoughts\n\nKeep this paragraph.\n";
    await writeFile(file, mine);
    await add(highlight("h2", "Redistribution did not slow growth.", 4));
    await call("store_md_export_config", { config: { ...(await call("store_md_export_config")).config, mode: "change" } });
    await waitFor(async () => /Redistribution did not slow growth\./.test(await readFile(file, "utf8")), "automatic export brought in the new highlight", 100);
    const second = await readFile(file, "utf8");
    assert.ok(second.includes("My summary: growth and inequality are linked.\n\n<!-- key:begin"), "text above Key's section kept");
    assert.ok(second.endsWith("## My thoughts\n\nKeep this paragraph.\n"), "text below kept");
    assert.ok(second.includes("<!-- key:notes -->\nCompare with Piketty.\n"), "notes under the highlight kept");

    // ── Renamed and moved: found again by key-id ──
    const moved = path.join(temp, "Vault", "Literature", "Reading", "Smith on growth.md");
    await mkdir(path.dirname(moved), { recursive: true });
    await rename(file, moved);
    await add(highlight("h3", "A third passage.", 5));
    await waitFor(async () => /A third passage\./.test(await readFile(moved, "utf8")), "the moved file followed", 100);
    assert.ok(!existsSync(file), "no second file");

    // ── A hand edit inside Key's section: left alone, the new version goes beside it ──
    const edited = (await readFile(moved, "utf8")).replace("A third passage.", "A third passage, reworded by me.");
    await writeFile(moved, edited);
    await add(highlight("h4", "A fourth passage.", 6));
    const copy = path.join(path.dirname(moved), "Smith on growth.conflict.md");
    await waitFor(async () => existsSync(copy), "conflict copy written", 100);
    assert.equal(await readFile(moved, "utf8"), edited, "the edited file is not overwritten");
    assert.match(await readFile(copy, "utf8"), /A fourth passage\./);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:md-export-changed")));
    await page.locator(".kx-status-bar [data-status-item=md-export]", { hasText: /conflict/ }).waitFor();
    // Settings lists it; Key's version replaces its section, the user's text stays.
    await page.getByRole("button", { name: "Use Key’s version" }).waitFor();
    await both(page, "settings-conflict");
    await page.getByRole("button", { name: "Use Key’s version" }).click();
    await waitFor(async () => !existsSync(copy), "conflict resolved");
    const resolved = await readFile(moved, "utf8");
    assert.match(resolved, /A fourth passage\./);
    assert.ok(resolved.includes("Compare with Piketty.") && resolved.includes("Keep this paragraph."));
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:md-export-changed")));
    await page.locator(".kx-status-bar [data-status-item=md-export]", { hasText: /Markdown/ }).waitFor();

    // ── One shot: Export highlights for a selection ──
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent("key:open-highlight-export", { detail: { ids: [id], title: "Growth and inequality" } })), created.id);
    const sheet = page.locator(".kx-md-export");
    await sheet.waitFor();
    await both(page, "export-highlights-sheet");
    await sheet.getByRole("button", { name: /Copy Markdown/ }).click();
    await sheet.locator(".kx-bib-notice", { hasText: "Copied the highlights of 1 source" }).waitFor();
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.match(clip, /^# Growth and inequality/);
    assert.ok(!clip.includes("key:ann"), "no markers in a one-shot export");
    await sheet.getByRole("button", { name: "Done" }).click();

    // ── A key:// link from another app opens the source ──
    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].webContents.send("open-item-link", url), `key://source/${created.id}#highlight:h1`);
    await waitFor(async () => JSON.stringify(await page.evaluate(() => window.key.tabs())).includes("Growth and inequality"), "the link opened the source");
    await shot(page, "deep-link");

    console.log(JSON.stringify({ files: await readdir(path.dirname(moved)) }));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, screenshots: temp }));
  } catch (error) {
    if (page) await shot(page, "failure").catch(() => {});
    console.error(`Screenshots in ${temp}`);
    throw error;
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
