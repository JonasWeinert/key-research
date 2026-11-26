// File naming rules: Settings › Files (rule with live examples from the library), renaming
// linked files in place behind a confirmation (and Undo putting the names back), the
// selection's Rename files sheet, readable names for a managed file dragged out, and the
// mirror folder by collection.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, copyFile, appendFile, rm } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { tmpdir, homedir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-file-names-"));
  // Files in the temp folder are copied into Key's storage; linked files must live elsewhere.
  const docs = await mkdtemp(path.join(homedir(), "Library", "Caches", "key-file-names-smoke-"));
  const fixture = path.resolve(__dirname, "../../../../../tests/fixtures/interaction.pdf");
  // Three different files (the same bytes would be one source).
  for (const [i, file] of [path.join(docs, "scan0001.pdf"), path.join(docs, "scan0002.pdf"), path.join(temp, "download.pdf")].entries()) {
    await copyFile(fixture, file);
    await appendFile(file, `\n%${i}\n`);
  }
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
    const theory = await call("store_collection_create", { name: "Theory" });
    const created = await call("store_import_files", { paths: [path.join(docs, "scan0001.pdf"), path.join(docs, "scan0002.pdf"), path.join(temp, "download.pdf")] });
    const meta = [
      ["Müller", "Évolution des inégalités: une histoire", "2019"],
      ["Smith", "Growth and inequality", "2021"],
      ["Lee", "A stored paper", "2018"],
    ];
    for (const [i, [family, title, date]] of meta.entries())
      await call("store_update", { id: created[i].id, byHand: true, patch: { title, date, creators: [{ family, given: "A", role: "author" }] } });
    await call("store_membership", { collectionId: theory.id, ids: [created[1].id], present: true });

    // ── Settings › Files: the rule and its examples ──
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: "files" })));
    const examples = page.getByTestId("file-examples");
    await examples.getByText("Smith - 2021 - Growth and inequality.pdf").waitFor();
    await examples.getByText("Müller - 2019 - Évolution des inégalités - une histoire.pdf").waitFor();
    await page.getByRole("checkbox", { name: "Remove accents" }).check();
    await examples.getByText("Muller - 2019 - Evolution des inegalites - une histoire.pdf").waitFor();
    const rule = page.getByRole("textbox", { name: "File name rule" });
    await rule.fill("{{firstCreator}} {{year}} {{title | truncate 12}}");
    await examples.getByText("Smith 2021 Growth and.pdf").waitFor();
    await rule.fill("{{firstCreator}} - {{year}} - {{title | truncate 60}}");
    await examples.getByText("Smith - 2021 - Growth and inequality.pdf").waitFor();
    await both(page, "settings-files");

    // ── Rename linked files: confirmation, then Undo ──
    await page.getByRole("button", { name: "Rename…" }).click();
    const confirm = page.getByRole("dialog", { name: "Rename files" });
    await confirm.getByText("Rename 2 files on disk?").waitFor();
    assert.match(await confirm.innerText(), /1 stored by Key/);
    await both(page, "settings-files-confirm");
    await confirm.getByRole("button", { name: "Rename 2 files" }).click();
    const renamed = path.join(docs, "Smith - 2021 - Growth and inequality.pdf");
    await waitFor(async () => existsSync(renamed) && existsSync(path.join(docs, "Muller - 2019 - Evolution des inegalites - une histoire.pdf")), "files renamed on disk");
    assert.ok(!existsSync(path.join(docs, "scan0002.pdf")));
    const smith = (await call("store_sources", { limit: 10 })).items.find((s) => s.id === created[1].id);
    assert.equal(smith.filePath, renamed);
    await call("store_undo");
    await waitFor(async () => existsSync(path.join(docs, "scan0002.pdf")) && !existsSync(renamed), "undo put the names back");

    // ── The mirror folder ──
    const mirror = path.join(temp, "Mirror");
    const result = await call("store_file_mirror", { config: { enabled: true, folder: mirror, byCollection: true } });
    assert.equal(result.last.files, 3);
    assert.ok(existsSync(path.join(mirror, "Theory", "Smith - 2021 - Growth and inequality.pdf")));
    assert.ok(existsSync(path.join(mirror, "Unfiled", "Lee - 2018 - A stored paper.pdf")));
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.locator(".kx-settings").waitFor({ state: "detached" });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: "files" })));
    await page.getByText(/3 files \(3 linked/).waitFor();
    await both(page, "settings-files-mirror");
    await page.getByRole("button", { name: "Close settings" }).click();

    // ── A managed file dragged out gets its readable name ──
    const [readable] = await call("store_file_readable_paths", { ids: [created[2].id] });
    assert.equal(path.basename(readable), "Lee - 2018 - A stored paper.pdf");

    // ── The selection's Rename files sheet ──
    await page.evaluate((ids) => window.dispatchEvent(new CustomEvent("key:open-file-rename", { detail: { ids } })), [created[1].id]);
    const sheet = page.locator(".kx-files-rename");
    await sheet.getByText("Rename 1 file?").waitFor();
    await both(page, "rename-sheet");
    await sheet.getByRole("button", { name: "Rename", exact: true }).click();
    await waitFor(async () => existsSync(renamed), "renamed from the sheet");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, screenshots: temp }));
  } catch (error) {
    if (page) await shot(page, "failure").catch(() => {});
    console.error(`Screenshots in ${temp}`);
    throw error;
  } finally {
    await app.close();
    await rm(docs, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
