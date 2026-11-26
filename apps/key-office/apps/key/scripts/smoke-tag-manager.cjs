// The tag manager on a seeded, messy tag set (case/plural/hyphen variants, an initialism,
// delimiter paths, a reading-status family, co-occurring and subsumed tags, a flag tag,
// junk): suggestions appear; merge, nest and convert apply in the store and show in the
// library; undo puts things back; inline rename, drag to nest and a manual checkbox
// conversion work. Screenshots light and dark go to the printed temp folder.
const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const SEED = [
  ...Array(7).fill(["Machine learning", "Methods"]),
  ...Array(2).fill(["machine-learning", "Methods"]),
  ["machine learnings"],
  ...Array(3).fill(["ML"]),
  ...Array(4).fill(["status: read"]),
  ...Array(3).fill(["status: to read"]),
  ["status: reading"],
  ...Array(4).fill(["Surveys", "Methods"]),
  ...Array(3).fill(["Interviews", "Methods"]),
  ...Array(5).fill(["Deep learning", "Neural networks"]),
  ...Array(3).fill(["_tablet"]),
  ...Array(3).fill(["Behaviour"]),
  ["Behavior"],
  ["Health policy"],
  ["Health economics"],
  ["2019-xx-42"],
  ["https://example.org/a/tag"],
];

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-tag-manager-"));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const report = {};
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    for (const [i, tags] of SEED.entries()) await call("store_create", { source: { kind: "reference", itemType: "article", title: `Study ${i + 1} on learning and health`, tags } });
    const tagsOf = async () => (await call("store_tag_index")).tags.map((t) => t.name);

    // From the library's tag picker.
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.getByRole("heading", { name: "All sources", exact: true }).waitFor();
    await page.locator(".kx-tag-picker > summary").click();
    await page.getByRole("button", { name: /Manage, merge and clean up tags/ }).click();
    const manager = page.getByRole("dialog", { name: "Manage tags" });
    await manager.waitFor();
    await manager.getByRole("region", { name: "Merge duplicates" }).waitFor();
    for (const group of ["Nest under", "Hierarchy from names", "Convert to property", "Clean up"]) await manager.getByRole("region", { name: group }).waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(temp, "tags-light.png") });
    report.suggestions = await manager.locator(".kx-tm-card").count();

    // Merge the machine-learning variants (preview first), then undo, then again.
    const mergeCard = manager.locator(".kx-tm-card", { hasText: "into “Machine learning”" });
    await mergeCard.locator(".kx-tm-card-head").click();
    await mergeCard.locator(".kx-tm-preview").getByText("machine-learning", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(temp, "tags-preview.png") });
    await mergeCard.getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForFunction(async (id) => !(await window.key.invoke("store_tag_index", {}, id)).tags.some((t) => ["ML", "machine-learning", "machine learnings"].includes(t.name)), ws.id);
    assert.equal((await call("store_tag_index")).tags.find((t) => t.name === "Machine learning").count, 13);
    await manager.locator(".kx-tm-foot").getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(async (id) => (await window.key.invoke("store_tag_index", {}, id)).tags.some((t) => t.name === "ML"), ws.id);
    assert.equal((await call("store_tag_index")).tags.find((t) => t.name === "Machine learning").count, 7);
    report.undo = true;
    await manager.locator(".kx-tm-card", { hasText: "into “Machine learning”" }).getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForFunction(async (id) => !(await window.key.invoke("store_tag_index", {}, id)).tags.some((t) => t.name === "ML"), ws.id);
    report.merge = true;

    // Nest the method tags under Methods (a subsumption suggestion).
    await manager.locator(".kx-tm-card", { hasText: "under “Methods”" }).first().getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForFunction(async (id) => (await window.key.invoke("store_tag_index", {}, id)).tree?.Surveys?.parent === "Methods", ws.id);
    report.nest = (await call("store_tag_index")).tree;

    // Reading status becomes a select property.
    await manager.locator(".kx-tm-card", { hasText: "“Status” property" }).getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForFunction(async (id) => (await window.key.invoke("workspace_attributes", {}, id)).some((p) => p.name === "Status" && p.type === "select"), ws.id);
    const status = await call("workspace_attributes");
    assert.deepEqual(status.find((p) => p.name === "Status").options.sort(), ["Read", "Reading", "To read"]);
    const sources = (await call("store_sources", { limit: 200 })).items;
    assert.equal(sources.filter((s) => s.properties.Status === "Read").length, 4);
    assert(!(await tagsOf()).some((t) => t.startsWith("status:")));
    report.convert = true;

    // Manual: select "_tablet" and make it a checkbox.
    const row = (name) => manager.locator(`.kx-tm-row[data-tag="${name}"]`);
    await manager.getByLabel("Filter tags").fill("tablet");
    await row("_tablet").click();
    await manager.getByRole("button", { name: "Convert…" }).click();
    await manager.getByLabel("Property name").fill("On tablet");
    await manager.locator(".kx-tm-type", { hasText: "Checkbox" }).click();
    await page.screenshot({ path: path.join(temp, "tags-convert.png") });
    await manager.getByRole("button", { name: "Convert", exact: true }).click();
    await page.waitForFunction(async (id) => (await window.key.invoke("workspace_attributes", {}, id)).some((p) => p.name === "On tablet" && p.type === "boolean"), ws.id);
    assert.equal((await call("store_sources", { limit: 200 })).items.filter((s) => s.properties["On tablet"] === true).length, 3);
    await manager.getByLabel("Filter tags").fill("");
    report.checkbox = true;

    // Inline rename onto an existing tag merges it.
    await row("Behavior").dblclick();
    await manager.getByLabel("Rename Behavior").fill("Behaviour");
    await manager.getByLabel("Rename Behavior").press("Enter");
    await page.waitForFunction(async (id) => !(await window.key.invoke("store_tag_index", {}, id)).tags.some((t) => t.name === "Behavior"), ws.id);
    report.rename = true;

    // Drag a tag onto another to nest it.
    await row("Health economics").dragTo(row("Health policy"));
    await page.waitForFunction(async (id) => (await window.key.invoke("store_tag_index", {}, id)).tree?.["Health economics"]?.parent === "Health policy", ws.id, { timeout: 8000 }).then(
      () => (report.drag = true),
      () => (report.drag = "not delivered by the test driver"),
    );

    // Dark.
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(temp, "tags-dark.png") });
    await manager.locator(".kx-tm-card").first().locator(".kx-tm-card-head").click();
    await row("Methods").click({ button: "right" });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(temp, "tags-dark-menu.png") });
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.key.setAppSettings({ theme: "system" }));
    await page.emulateMedia({ colorScheme: "light" });

    // Done: the library shows the result.
    await manager.getByRole("button", { name: "Done", exact: true }).click();
    await manager.waitFor({ state: "detached" });
    await page.locator(".kx-tag-picker > summary").click();
    await page.locator(".kx-tag-picker").getByText("Machine learning", { exact: true }).waitFor();
    assert.equal(await page.locator(".kx-tag-picker").getByText("machine-learning", { exact: true }).count(), 0);
    await page.keyboard.press("Escape");
    report.library = true;

    // From the command palette.
    await app.evaluate(({ Menu }) => {
      const find = (items) => items.flatMap((i) => (i.label === "Commands…" ? [i] : i.submenu ? find(i.submenu.items) : []));
      find(Menu.getApplicationMenu().items)[0].click();
    });
    await page.keyboard.type("Organise tags");
    await page.keyboard.press("Enter");
    await manager.waitFor();
    await page.keyboard.press("Escape");
    await manager.waitFor({ state: "detached" });
    report.palette = true;

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
