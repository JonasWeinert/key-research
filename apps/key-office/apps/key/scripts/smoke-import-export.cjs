// Bibliography import and export: a .bib with a linked PDF through the import sheet
// (preview, import, summary, undo), a pasted RIS file, export and re-import giving the
// same file, citation keys (kept from the file, unique, in the column and the details),
// the export sheet and Settings, and an auto-export file that follows an edit.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, readFile, writeFile, copyFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-import-export-"));
  // Outside the temp folder's direct reach the PDF would be linked in place; either way it is attached.
  const pdf = path.join(temp, "smith2020.pdf");
  await copyFile(path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf"), pdf);
  const bib = path.join(temp, "refs.bib");
  await writeFile(
    bib,
    `@article{smith2020,
  author = {Smith, John and van der Berg, Anna and others},
  title = {The {$\\alpha$}-Helix in {DNA} Binding},
  journal = {Nature},
  year = {2020},
  volume = {580},
  pages = {1--10},
  doi = {10.1038/s41586-020-0001-x},
  keywords = {proteins, structure},
  file = {Full Text:${pdf}:PDF},
  annote = {Read this first.},
  addendum = {Corrected version},
}

@book{who2019,
  author = {{World Health Organization}},
  title = {World Malaria Report 2019},
  publisher = {WHO},
  address = {Gen{\\\`e}ve},
  year = {2019},
}

@inproceedings{Schr2001,
  author = {Schr{\\"o}dinger, Erwin},
  title = {Broken entry,
  year = {2001},
}

@inproceedings{lamport1978,
  author = {Lamport, Leslie},
  title = {Time, Clocks, and the Ordering of Events},
  booktitle = {Communications of the ACM},
  year = {1978},
}
`,
  );
  const ris = `TY  - JOUR
AU  - Palma, Michelle A.
AU  - Huseynov, Samir
TI  - Health information and
  dietary choices
T2  - Journal of Health Economics
PY  - 2022/03/15/
DO  - 10.1016/j.jhealeco.2021.102565
KW  - nutrition
ER  -

TY  - BOOK
AU  - Knuth, Donald E.
TI  - The Art of Computer Programming
PB  - Addison-Wesley
PY  - 1968
ER  -
`;
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
      const value = await check();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out: ${what}`);
  };
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
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.getByRole("heading", { name: "All sources", exact: true }).waitFor();
    const reading = await call("store_collection_create", { name: "Reading" });

    // ── The .bib through the sheet (as when it is dropped on the library) ──
    await page.evaluate((paths) => window.dispatchEvent(new CustomEvent("key:open-bib-import", { detail: { paths } })), [bib]);
    const sheet = page.locator(".kx-bib-import");
    await sheet.waitFor();
    await sheet.locator(".kx-bib-row", { hasText: "Helix" }).waitFor();
    assert.match(await sheet.locator("header p").innerText(), /BibTeX · 3 entries from refs\.bib/);
    assert.match(await sheet.locator(".kx-bib-facts").innerText(), /1 file found/);
    assert.match(await sheet.locator(".kx-bib-facts").innerText(), /1 problem/);
    await sheet.getByRole("button", { name: /1 problem/ }).click();
    assert.match(await sheet.locator(".kx-bib-warnings").innerText(), /Line \d+/);
    await sheet.getByRole("checkbox", { name: "Reading" }).check();
    await both(page, "import-preview");
    await sheet.getByRole("button", { name: /^Import 3 entries/ }).click();
    const done = page.locator(".kx-bib-import[data-step=done]");
    await done.waitFor();
    const summary = await done.locator(".kx-bib-summary").innerText();
    assert.match(summary, /3 sources added/);
    assert.match(summary, /1 file attached/);
    assert.match(summary, /1 note added/);
    await both(page, "import-summary");
    // Undo the whole import, then do it again.
    await done.getByRole("button", { name: /Undo import/ }).click();
    await page.locator(".kx-bib-import[aria-label=\"Import undone\"]").waitFor();
    assert.equal((await call("store_sources", { limit: 50 })).total, 0, "undo removed everything");
    await page.locator(".kx-bib-import[aria-label=\"Import undone\"]").getByRole("button", { name: "Done" }).click();
    await sheet.waitFor({ state: "detached" });
    const first = await call("store_biblio_import", { path: bib, options: { collectionIds: [reading.id], files: true, notes: true, groups: true, duplicates: "skip" } });
    assert.equal(first.added, 3);
    const sources = (await call("store_sources", { limit: 50 })).items;
    const smith = sources.find((s) => /Helix/.test(s.title));
    assert.equal(smith.citationKey, "smith2020", "the file's key is kept");
    assert.equal(smith.title, "The α-Helix in DNA Binding");
    assert.equal(smith.kind, "pdf", "the linked PDF is attached");
    assert.ok(smith.filePath, "file path stored");
    assert.deepEqual(smith.collections, [reading.id]);
    assert.equal(smith.properties["bibtex.addendum"], "Corrected version", "unknown fields are kept as properties");
    assert.equal((await call("store_citation_key", { id: smith.id })).pinned, true, "imported keys are pinned");

    // ── RIS, pasted ──
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:open-bib-import", { detail: {} })));
    await sheet.waitFor();
    await sheet.getByRole("textbox", { name: "References to import" }).fill(ris);
    await both(page, "import-source");
    await sheet.getByRole("button", { name: "Continue" }).click();
    await sheet.locator(".kx-bib-row", { hasText: "Health information and dietary choices" }).waitFor();
    assert.match(await sheet.locator("header p").innerText(), /RIS · 2 entries/);
    await sheet.getByRole("button", { name: /^Import 2 entries/ }).click();
    await done.waitFor();
    assert.match(await done.locator(".kx-bib-summary").innerText(), /2 sources added/);
    await done.getByRole("button", { name: "Done" }).click();
    await sheet.waitFor({ state: "detached" });
    // Importing the same file again skips what has an identifier and flags the rest.
    const again = await call("store_biblio_import", { path: bib, options: { files: false, duplicates: "skip" } });
    assert.equal(again.skipped, 1);
    assert.equal(again.flagged.length, 2);
    await call("store_biblio_undo", { id: again.id });

    // ── Keys: generated for the RIS entries, unique, searchable ──
    const all = (await call("store_sources", { limit: 50 })).items;
    assert.equal(all.length, 5);
    await waitFor(async () => (await call("store_sources", { limit: 50 })).items.every((s) => s.citationKey), "keys for every source");
    const keys = (await call("store_sources", { limit: 50 })).items.map((s) => s.citationKey);
    assert.equal(new Set(keys.map((k) => k.toLowerCase())).size, keys.length, "keys are unique");
    assert.ok(keys.includes("palma2022"), keys.join(", "));
    const byKey = await call("store_sources", { filters: [{ field: "citationKey", op: "is", value: "who2019" }] });
    assert.equal(byKey.total, 1, "filter by key");
    const parsed = await call("store_parse_query", { text: "@who2019" });
    assert.equal(parsed[0].id, "citationKey");

    // ── Export and re-import gives the same file ──
    const exported = await call("store_biblio_export", { format: "bibtex", options: { abstracts: true, keywords: true, notes: false, files: false, encoding: "unicode" } });
    assert.equal(exported.count, 5);
    const ids = (await call("store_biblio_history")).map((r) => r.id);
    for (const id of ids) await call("store_biblio_undo", { id }).catch(() => {});
    assert.equal((await call("store_sources", { limit: 50 })).total, 0);
    await call("store_biblio_import", { text: exported.text, options: {} });
    const reexported = await call("store_biblio_export", { format: "bibtex", options: { abstracts: true, keywords: true, notes: false, files: false, encoding: "unicode" } });
    assert.equal(reexported.text, exported.text, "export → import → export is stable");
    for (const format of ["biblatex", "ris", "csl-json", "csv"]) {
      const out = await call("store_biblio_export", { format });
      assert.equal(out.count, 5, format);
      const preview = await call("store_biblio_preview", { text: out.text, format: format === "biblatex" ? "bibtex" : format });
      assert.equal(preview.total, 5, `${format} reads back`);
    }
    // Quick copy formats.
    const who = (await call("store_sources", { limit: 50 })).items.find((s) => s.citationKey === "who2019");
    assert.equal(await call("store_biblio_copy", { ids: [who.id], format: "pandoc" }), "[@who2019]");
    assert.equal(await call("store_biblio_copy", { ids: [who.id], format: "latex" }), "\\cite{who2019}");

    // ── The citation key column and the details row ──
    // The sources were replaced through host commands: show another view and back to reload.
    await page.getByRole("tab", { name: /Trash/ }).click();
    await page.getByRole("tab", { name: /^All/ }).click();
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.getByRole("checkbox", { name: "Show Citation key", exact: true }).check();
    await page.keyboard.press("Escape");
    await page.locator(".kx-table-head [role=columnheader]", { hasText: "Citation key" }).waitFor();
    await page.locator(".kx-table-row .kx-cell-mono", { hasText: "who2019" }).waitFor();
    await page.locator(".kx-table-row", { hasText: "World Malaria Report" }).click();
    const keyInput = page.getByRole("textbox", { name: "Citation key" });
    await page.getByText("Details", { exact: true }).first().click();
    await keyInput.waitFor();
    assert.equal(await keyInput.inputValue(), "who2019");
    await keyInput.fill("palma2022");
    await keyInput.press("Enter");
    await page.locator(".kx-citekey-error", { hasText: "already the key" }).waitFor();
    await keyInput.fill("whoMalaria2019");
    await keyInput.press("Enter");
    await waitFor(async () => (await call("store_citation_key", { id: who.id })).key === "whoMalaria2019", "edited key saved");
    await both(page, "citation-key-column");

    // ── Auto-export follows an edit ──
    const target = path.join(temp, "overleaf", "library.bib");
    await require("node:fs/promises").mkdir(path.dirname(target), { recursive: true });
    const saved = await call("store_autoexport_save", { target: { id: "", collectionId: null, format: "bibtex", path: target, options: {} } });
    assert.equal(saved.lastError ?? null, null);
    const before = await readFile(target, "utf8");
    assert.match(before, /@book\{whoMalaria2019,/);
    await call("store_update", { id: who.id, patch: { volume: "42" } });
    await waitFor(async () => /volume = \{42\}/.test(await readFile(target, "utf8")), "auto-export rewrote the file", 60);
    const after = await readFile(target, "utf8");
    const old = new Set(before.split("\n"));
    const changed = after.split("\n").filter((line) => !old.has(line)).length + Math.max(0, before.split("\n").length - after.split("\n").length);
    assert.ok(changed <= 3, `small diff (${changed} lines)`);

    // ── The export sheet and Settings ──
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:open-bib-export", { detail: {} })));
    const exportSheet = page.locator(".kx-bib-export");
    await exportSheet.waitFor();
    await exportSheet.getByRole("radio", { name: "BibLaTeX" }).click();
    await both(page, "export-sheet");
    await exportSheet.getByRole("button", { name: /Copy/ }).click();
    await exportSheet.locator(".kx-bib-notice", { hasText: "Copied 5 references" }).waitFor();
    await exportSheet.getByRole("button", { name: "Close" }).click();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: "export" })));
    await page.getByText("library.bib").first().waitFor();
    await page.getByRole("textbox", { name: "Citation key pattern" }).fill("auth.lower + year + shorttitle(1)");
    await page.getByText(/who2019World|whoWorld|2019/).first().waitFor();
    await both(page, "settings-export");
    // A failing target shows in the status bar.
    await call("store_autoexport_save", { target: { ...saved, path: path.join(temp, "missing-folder", "x.bib") } }).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:autoexport-changed")));
    await page.keyboard.press("Escape");
    await page.locator(".kx-status-bar [data-status-item=autoexport]").waitFor();
    await shot(page, "status-failure");

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
