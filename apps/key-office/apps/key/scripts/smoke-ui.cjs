// Real renderer actions against an isolated workspace/profile; never personal data.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const assert = require("node:assert/strict");
(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-electron-ui-"));
  await mkdir(path.join(temp, "profile"));
  const app = await electron.launch({
    args: [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
    },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.getByRole("button", { name: "Browse all sources", exact: true }).click();
    await page
      .getByRole("heading", { name: "All sources", exact: true })
      .waitFor({ timeout: 60000 });
    const widths = await page.evaluate(() => ({
      library: [...document.querySelectorAll(".kx-library")].find((el) => el.offsetParent).getBoundingClientRect()
        .width,
      content: [...document.querySelectorAll(".key-shell-content")]
        .find((el) => el.offsetParent)
        .getBoundingClientRect().width,
    }));
    assert(
      Math.abs(widths.library - widths.content) < 3,
      JSON.stringify(widths),
    );
    await page.screenshot({ path: path.join(temp, "full-width-home.png") });
    const workspaces = await page.evaluate(() => window.key.workspaces());
    assert(workspaces.length > 0);
    await page.locator(".kx-status-item[data-status-item=workspace]").click();
    await page.locator(`[data-workspace-id="${workspaces[0].id}"]`).click();
    await page
      .getByRole("button", { name: "Create item", exact: true })
      .click();
    // A page record: "New note" now makes a library note, which has no custom properties.
    await page.locator(".key-create-menu").getByRole("button", { name: "New page", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Page title", exact: true })
      .fill("Qualifying research note");
    await page
      .getByRole("textbox", { name: "Page content", exact: true })
      .fill("Canonical database UI validation.");
    // Properties are added through the property sheet: a name, a type and a value for this page.
    const addProperty = async (name, type, setValue) => {
      await page
        .locator("[data-content-view]:visible")
        .getByRole("region", { name: "Item properties", exact: true })
        .getByRole("button", { name: /Add property/ })
        .click();
      const sheet = page.getByRole("dialog", { name: "New property", exact: true });
      await sheet.waitFor();
      await sheet.getByRole("textbox", { name: "Property name", exact: true }).fill(name);
      await sheet.getByRole("group", { name: "Property type" }).getByRole("button", { name: type }).click();
      await sheet.getByRole("checkbox", { name: /Set a value on 1 selected item/ }).check();
      await setValue(sheet);
      await sheet.getByRole("button", { name: "Create property", exact: true }).click();
      await sheet.waitFor({ state: "detached" });
    };
    await addProperty("reviewed", /Checkbox$/, (sheet) =>
      sheet.getByRole("combobox", { name: "Value", exact: true }).selectOption("true"),
    );
    await addProperty("year", /Number$/, (sheet) =>
      sheet.locator('input[type="number"]').fill("2026"),
    );
    const properties = page.locator("[data-content-view]:visible .key-record-properties");
    assert.equal(await properties.getByRole("checkbox", { name: "reviewed", exact: true }).isChecked(), true);
    await properties.locator('.key-record-property-row', { hasText: "year" }).locator('input[type="number"]').waitFor();
    assert.equal(await properties.locator('.key-record-property-row', { hasText: "year" }).locator('input[type="number"]').inputValue(), "2026");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await page
      .locator("[data-content-view]:visible")
      .getByText("Saved", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Create item", exact: true })
      .click();
    await page
      .getByRole("button", { name: "New database", exact: true })
      .click();
    // The page's tab stays mounted (hidden): wait for the database's own view before filling.
    const databaseView = page.locator("[data-content-view]:visible").filter({ has: page.getByRole("combobox", { name: /Item type/ }) });
    await databaseView.waitFor();
    await databaseView
      .getByRole("textbox", { name: "Page title", exact: true })
      .fill("Reviewed notes");
    await page
      .getByRole("combobox", { name: /Item type/ })
      .selectOption("page");
    await page.getByLabel("Property name", { exact: true }).fill("reviewed");
    await page.getByLabel("Equals", { exact: true }).fill("true");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await page
      .locator("[data-content-view]:visible")
      .getByText("Saved", { exact: true })
      .waitFor();
    await page
      .locator(".key-record-browser")
      .getByRole("button", { name: "Qualifying research note", exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(temp, "saved-database.png") });
    const persisted = await page.evaluate(
      (id) =>
        window.key.invoke("workspace_records", { limit: 100, offset: 0 }, id),
      workspaces[0].id,
    );
    const db = persisted.find((r) => r.title === "Reviewed notes");
    assert.equal(db.kind, "database");
    assert.deepEqual(db.properties.view, {
      kind: "page",
      property: "reviewed",
      value: "true",
    });
    const note = persisted.find((r) => r.title === "Qualifying research note");
    assert.equal(note.properties.reviewed, true);
    assert.equal(note.properties.year, 2026);
    await page.reload();
    await page
      .getByRole("textbox", { name: "Page title", exact: true })
      .waitFor();
    await page.locator(".kx-status-item[data-status-item=workspace]").click();
    await page.locator(`[data-workspace-id="${workspaces[0].id}"]`).click();
    await page
      .locator(".key-sidebar")
      .getByRole("button", { name: "Reviewed notes", exact: false })
      .click();
    await page
      .locator(".key-record-browser")
      .getByRole("button", { name: "Qualifying research note", exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    const result = {
      passed: true,
      widths,
      noteId: note.id,
      databaseId: db.id,
      screenshots: [
        path.join(temp, "full-width-home.png"),
        path.join(temp, "saved-database.png"),
      ],
      errors,
    };
    await writeFile(
      path.join(temp, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error("UI FAILURE", e);
    const page = app.windows()[0];
    if (page) {
      await page
        .screenshot({ path: path.join(temp, "failure.png") })
        .catch(() => {});
      console.error(
        await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      );
    }
    throw e;
  } finally {
    await app
      .evaluate(() => {
        require("electron").app.exit(0);
      })
      .catch(() => {});
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
