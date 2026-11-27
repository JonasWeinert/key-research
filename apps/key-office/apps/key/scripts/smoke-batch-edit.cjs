// Batch edit and the operations journal: with several sources selected, the details panel
// is the "N sources selected" panel: an overview from the host (counts, years, authors,
// duplicates among them) and every bulk control, each action once, no horizontal scroll
// (mixed fields read "Mixed"); setting a field, starring all, adding a tag and
// taking a partial tag off apply to all; ⌘Z undoes the last operation with an "Undo: …"
// toast and ⇧⌘Z redoes it; trash is undoable the same way. Screenshots light and dark go to
// the printed temp folder.
const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-batch-edit-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_OPENALEX_ENABLED: "0", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const report = {};
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 840));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const seed = [
      ["Poverty traps and growth", 2006, "Journal of Growth", ["growth", "theory"]],
      ["Nudges in public health", 2015, "Health Policy", ["policy"]],
      ["Poverty traps and growth.", 2006, "Journal of Growth", ["growth"]],
      ["Cash transfers in Kenya", 2016, "", []],
    ];
    const ids = [];
    for (const [title, year, containerTitle, tags] of seed)
      ids.push((await call("store_create", { source: { kind: "reference", itemType: "article", title, year, containerTitle, tags, creators: [{ family: "Doe", given: "J", role: "author" }] } })).id);
    const source = async (id) => call("store_source", { id });

    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.getByRole("heading", { name: "All sources", exact: true }).waitFor();
    const row = (title) => page.locator(".kx-row").filter({ has: page.locator("strong").getByText(title, { exact: true }) });
    await row(seed[0][0]).click();
    await row(seed[1][0]).click({ modifiers: ["Meta"] });
    await row(seed[2][0]).click({ modifiers: ["Meta"] });
    const editor = page.getByLabel("3 sources selected", { exact: true });
    await editor.waitFor();
    await editor.getByRole("heading", { name: "3 sources selected" }).waitFor();
    // The overview: facts, the years, and the copy of the first source found among them.
    await editor.locator(".kx-selection-fact", { hasText: "Missing DOI" }).waitFor();
    assert.equal(await editor.locator(".kx-selection-fact", { hasText: "Missing DOI" }).locator("strong").textContent(), "3");
    assert.match(await editor.locator(".kx-selection-chart", { hasText: "Years" }).textContent(), /2006–2015/);
    await editor.locator(".kx-selection-dupes", { hasText: "2 of these look like the same work" }).waitFor();
    report.duplicates = true;
    // Mixed values read "Mixed"; the same value shows.
    assert.equal(await editor.locator(".kx-field-row", { hasText: "Published in" }).locator("input").getAttribute("placeholder"), "Mixed");
    assert.equal(await editor.locator(".kx-field-row", { hasText: "Year" }).locator("input").getAttribute("placeholder"), "Mixed");
    // Every action shows once (registered ones included), and the panel never scrolls sideways.
    const labels = await editor.locator(".kx-selection-button").allTextContents();
    assert.deepEqual(labels.filter((l, i) => labels.indexOf(l) !== i), [], `actions twice: ${labels}`);
    for (const label of ["Find PDFs (3)", "Refresh metadata…", "Look up", "Copy references", "Export…", "Send to Inbox", "Move to Trash"]) assert.ok(labels.includes(label), label);
    assert.equal(await page.locator(".kx-bulk-bar").count(), 0, "one place for bulk controls");
    const overflow = () => editor.evaluate((el) => el.scrollWidth - el.clientWidth);
    assert.ok((await overflow()) <= 0, "no horizontal scroll");
    report.actions = labels.length;
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(temp, "batch-light.png") });
    // Narrow: details float over the list, still nothing sideways.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 840));
    await page.waitForTimeout(400);
    assert.ok((await overflow()) <= 0, "no horizontal scroll when narrow");
    await page.screenshot({ path: path.join(temp, "batch-narrow.png") });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 840));
    await page.waitForTimeout(300);
    // Scrolled: the bar stays at the top with its title.
    await editor.evaluate((el) => (el.scrollTop = 400));
    await editor.locator('.kx-selection-bar[data-pinned="true"]').waitFor();
    await page.screenshot({ path: path.join(temp, "batch-scrolled.png") });
    await editor.evaluate((el) => (el.scrollTop = 0));

    // Star all, with an inline result and Undo.
    await editor.getByRole("button", { name: "Star all" }).click();
    await editor.locator(".kx-selection-notice", { hasText: "Star 3 sources" }).waitFor();
    await page.waitForFunction(async ({ ids, id }) => (await Promise.all(ids.map((s) => window.key.invoke("store_source", { id: s }, id)))).every((s) => s.starred), { ids: ids.slice(0, 3), id: ws.id });
    await editor.getByRole("button", { name: "Unstar all" }).waitFor();
    await editor.locator(".kx-selection-notice").getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(async ({ id, s }) => !(await window.key.invoke("store_source", { id: s }, id)).starred, { id: ws.id, s: ids[0] });
    report.star = true;

    // Set a field on all three.
    const publisher = editor.locator(".kx-field-row", { hasText: "Publisher" }).locator("input");
    await publisher.fill("MIT Press");
    await publisher.press("Enter");
    await page.waitForFunction(async ({ ids, id }) => {
      const all = await Promise.all(ids.map((s) => window.key.invoke("store_source", { id: s }, id)));
      return all.every((s) => s.publisher === "MIT Press");
    }, { ids: ids.slice(0, 3), id: ws.id });
    assert.equal((await source(ids[3])).publisher, undefined);
    assert.deepEqual((await source(ids[0])).editedFields, ["publisher"]);
    report.field = true;

    // Add a tag to all; take the partial "growth" off all.
    const tagInput = editor.getByLabel("Add a tag to all");
    await tagInput.fill("to read");
    await tagInput.press("Enter");
    await page.waitForFunction(async ({ id, s }) => (await window.key.invoke("store_source", { id: s }, id)).tags.includes("to read"), { id: ws.id, s: ids[1] });
    await editor.locator(".kx-tri-chip:not([data-partial])", { hasText: "to read" }).waitFor();
    const growth = editor.locator(".kx-tri-chip", { hasText: "growth" });
    assert.equal(await growth.getAttribute("data-partial"), "true");
    await growth.getByRole("button", { name: "Remove growth from all" }).click();
    await page.waitForFunction(async ({ id, s }) => !(await window.key.invoke("store_source", { id: s }, id)).tags.includes("growth"), { id: ws.id, s: ids[0] });
    report.tags = (await source(ids[0])).tags;
    assert.deepEqual(report.tags, ["theory", "to read"]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(temp, "batch-tags.png") });

    // ⌘Z from the list (no field focused) undoes the tag removal, with a toast.
    await page.locator(".kx-library-main .kx-page-title h1").click();
    await page.keyboard.press("Meta+z");
    await page.locator(".kx-toast", { hasText: "Undo: Change tags of 3 sources" }).waitFor();
    await page.waitForFunction(async ({ id, s }) => (await window.key.invoke("store_source", { id: s }, id)).tags.includes("growth"), { id: ws.id, s: ids[0] });
    await page.screenshot({ path: path.join(temp, "batch-undo.png") });
    // Twice more: the tag and the publisher are gone.
    await page.keyboard.press("Meta+z");
    await page.keyboard.press("Meta+z");
    await page.waitForFunction(async ({ id, s }) => (await window.key.invoke("store_source", { id: s }, id)).publisher === undefined, { id: ws.id, s: ids[1] });
    assert.deepEqual((await source(ids[1])).tags, ["policy"]);
    assert.equal((await source(ids[0])).editedFields, undefined);
    // ⇧⌘Z brings the publisher back.
    await page.keyboard.press("Meta+Shift+z");
    await page.locator(".kx-toast", { hasText: "Redo: Edit 3 sources" }).waitFor();
    await page.waitForFunction(async ({ id, s }) => (await window.key.invoke("store_source", { id: s }, id)).publisher === "MIT Press", { id: ws.id, s: ids[1] });
    report.undoRedo = true;


    // Trash and undo.
    await row(seed[3][0]).click();
    await page.keyboard.press("Backspace");
    await page.waitForFunction(async ({ id, s }) => !!(await window.key.invoke("store_source", { id: s }, id)).trashedAt, { id: ws.id, s: ids[3] });
    await page.locator(".kx-library-main .kx-page-title h1").click();
    await page.keyboard.press("Meta+z");
    await page.locator(".kx-toast", { hasText: "Undo: Move 1 source to the Trash" }).waitFor();
    await page.waitForFunction(async ({ id, s }) => !(await window.key.invoke("store_source", { id: s }, id)).trashedAt, { id: ws.id, s: ids[3] });
    assert.equal((await call("store_journal")).undo.label, "Edit 3 sources");
    report.trash = true;

    // Dark.
    await row(seed[0][0]).click();
    await row(seed[2][0]).click({ modifiers: ["Shift"] });
    await editor.waitFor();
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(temp, "batch-dark.png") });
    await page.evaluate(() => window.key.setAppSettings({ theme: "system" }));
    await page.emulateMedia({ colorScheme: "light" });

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, ...report }));
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
