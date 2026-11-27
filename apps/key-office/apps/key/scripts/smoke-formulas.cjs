// Formula properties: New property › Formula opens the builder; a building block starts the
// formula, its parts change through their pickers, the preview shows real sources, Text
// shows the same formula with highlighting and a plain-language error, and the saved
// property shows as a column of coloured labels that sorts and filters by its value.
// Screenshots (light and dark) go to the printed temp folder.
const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-formulas-"));
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const seed = [
      ["Poverty traps and growth", 2006, ["growth"]],
      ["Nudges in public health", 2015, ["policy", "to read"]],
      ["Microfinance experiments", 2019, ["growth"]],
      ["Cash transfers in Kenya", 2004, []],
    ];
    for (const [title, year, tags] of seed)
      await call("store_create", { source: { kind: "reference", itemType: "article", title, year, tags, creators: [{ family: "Doe", given: "J", role: "author" }] } });

    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.getByRole("heading", { name: "All sources", exact: true }).waitFor();
    await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Table" }).click();
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.getByRole("button", { name: "New property…" }).click();
    const sheet = page.getByRole("dialog", { name: "New property", exact: true });
    await sheet.waitFor();
    await sheet.getByRole("textbox", { name: "Property name" }).fill("Era");
    await sheet.getByRole("button", { name: /Formula/ }).click();

    // The builder opens, window-sized, with templates and blocks.
    const builder = page.getByRole("dialog", { name: "Formula builder", exact: true });
    await builder.waitFor();
    await builder.locator(".kx-fb-template").first().waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(temp, "builder-empty.png") });
    await builder.locator('[data-block="If … then … else"]').click();
    await builder.locator(".kx-fb-tree .kx-fb-group[data-kind='fn']").first().waitFor();
    // Change the number in the condition: 2020 → 2010.
    const number = builder.getByRole("textbox", { name: "Number" });
    await number.fill("2010");
    await number.press("Enter");
    // And the two labels.
    const texts = builder.getByRole("textbox", { name: "Text" });
    await texts.nth(0).fill("Recent");
    await texts.nth(0).press("Enter");
    await texts.nth(1).fill("Earlier");
    await texts.nth(1).press("Enter");
    await builder.locator(".kx-fb-summary", { hasText: 'if({Year} > 2010, "Recent", "Earlier")' }).waitFor();
    // The preview works it out on the library's sources.
    await builder.locator(".kx-fb-rows tr", { hasText: "Microfinance experiments" }).locator("text=Recent").waitFor();
    await builder.locator(".kx-fb-rows tr", { hasText: "Cash transfers in Kenya" }).locator("text=Earlier").waitFor();
    await builder.getByRole("button", { name: "Coloured label", exact: true }).click();
    await builder.locator(".kx-fb-rows .kx-fv-badge").first().waitFor();
    report.blocks = true;
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(temp, "builder-blocks.png") });

    // Text: the same formula, highlighted; a mistake gets a plain-language message.
    await builder.getByRole("group", { name: "Edit as" }).getByRole("button", { name: "Text", exact: true }).click();
    const text = builder.getByRole("textbox", { name: "Formula text" });
    assert.equal(await text.inputValue(), 'if({Year} > 2010, "Recent", "Earlier")');
    await builder.locator('.kx-fb-code [data-hl="function"]', { hasText: "if" }).waitFor();
    await text.fill('if({Yeer} > 2010, "Recent", "Earlier"');
    await builder.getByRole("alert").filter({ hasText: "A bracket is never closed" }).waitFor();
    report.error = await builder.getByRole("alert").innerText();
    await page.screenshot({ path: path.join(temp, "builder-error.png") });
    // Completion: typing `{Yea` offers Year.
    await text.fill('if({Yea');
    await builder.getByRole("listbox", { name: "Suggestions" }).getByText("Year", { exact: true }).waitFor();
    await text.press("Enter");
    assert.equal(await text.inputValue(), "if({Year}");
    await text.fill('if({Year} > 2010, "Recent", "Earlier")');
    await builder.locator(".kx-fb-problem").waitFor({ state: "detached" });
    // The function reference is one click away, with examples.
    await builder.getByRole("button", { name: "Functions" }).click();
    await builder.getByLabel("Function reference").locator(".kx-fb-ref-item", { hasText: "days_since(date)" }).waitFor();
    await page.screenshot({ path: path.join(temp, "builder-text.png") });
    report.text = true;
    await builder.getByRole("button", { name: "Use formula" }).click();

    // Back on the property sheet: save it.
    await sheet.waitFor();
    await sheet.locator(".key-formula-summary", { hasText: "if({Year} > 2010" }).waitFor();
    await sheet.getByRole("button", { name: "Create property" }).click();
    await sheet.waitFor({ state: "detached" });
    const definition = (await call("workspace_attributes")).find((d) => d.name === "Era");
    assert.equal(definition.resultType, "text");
    assert.equal(definition.display, "badge");

    // The column: coloured labels, sortable and filterable by the formula's value.
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    const columnToggle = page.getByRole("dialog", { name: "Columns" }).getByText("Era", { exact: true });
    await columnToggle.click();
    await page.keyboard.press("Escape");
    await page.locator(".kx-cell-property .kx-fv-badge", { hasText: "Recent" }).nth(1).waitFor();
    assert.equal(await page.locator(".kx-cell-property .kx-fv-badge", { hasText: "Earlier" }).count(), 2);
    const sorted = await call("store_sources", { sorts: [{ field: "property:Era" }, { field: "year" }] });
    assert.deepEqual(
      sorted.items.map((s) => s.title),
      ["Cash transfers in Kenya", "Poverty traps and growth", "Nudges in public health", "Microfinance experiments"],
    );
    const filtered = await call("store_sources", { filters: [{ field: "property", key: "Era", op: "is", value: "Recent" }] });
    assert.equal(filtered.total, 2);
    report.sortFilter = true;
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(temp, "column-light.png") });
    await page.evaluate(() => window.key.setTheme?.("dark"));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(temp, "column-dark.png") });

    // Edit it again as text from the column's property sheet: days since added, as a number.
    const edited = await call("workspace_save_attribute", { name: "Waiting", config: { type: "formula", formula: "days_since({Date added})" } });
    void edited;
    const waiting = (await call("workspace_attributes")).find((d) => d.name === "Waiting");
    assert.equal(waiting.resultType, "number");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, report }, null, 2));
  } catch (error) {
    await (await app.firstWindow()).screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error("failure screenshot:", path.join(temp, "failure.png"));
    throw error;
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
