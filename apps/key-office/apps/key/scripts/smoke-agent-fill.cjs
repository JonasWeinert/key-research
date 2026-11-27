// Fill with AI against a mock OpenAI-compatible provider: Key Settings › AI assistant set up
// in three steps (provider, address and test, model); a starter recipe chosen in the fill
// sheet, its sources and answer shape, a test on three sources with the passages each answer
// came from; a run over a collection with the estimate up front; the review (accept one,
// edit one, accept the rest); a value the user typed is never proposed over; undo the run.
// Screenshots go to the printed temp folder.
const { _electron: electron } = require("playwright-core");
const { mkdtemp } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const ABSTRACTS = {
  "Teaching at the right level": "We ran a randomised controlled trial in 120 schools in India with 4,000 children.",
  "Deworming and school attendance": "A randomised evaluation of mass deworming in Kenya across 75 schools.",
  "Long-run effects of microcredit": "We follow a cohort of 2,000 borrowers in Bangladesh over ten years.",
  "Village savings groups": "A cohort study of savings groups in Malawi, with 800 households.",
  "Theory of poverty traps": "We develop a model of poverty traps without data.",
};

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-agent-fill-"));
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (c) => (body += c));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url.endsWith("/models")) return response.end(JSON.stringify({ data: [{ id: "mock-small" }, { id: "mock-large" }] }));
      const parsed = JSON.parse(body || "{}");
      const prompt = parsed.messages?.find((m) => m.role === "user")?.content ?? "";
      requests.push({ model: parsed.model, prompt });
      const title = Object.keys(ABSTRACTS).find((t) => prompt.includes(t));
      const text = ABSTRACTS[title] ?? "";
      const value = /randomi[sz]ed/i.test(text) ? "Randomised controlled trial" : /cohort/i.test(text) ? "Cohort study" : "Modelling or simulation";
      const quote = text.split(" ").slice(0, 6).join(" ");
      const answer = { value, confidence: 0.86, evidence: [{ passage: "P2", quote }] };
      response.end(JSON.stringify({ model: parsed.model, choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 420, completion_tokens: 30 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://localhost:${server.address().port}/v1`;

  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: { ...process.env, KEY_SKIP_ONBOARDING: "1", KEY_OPENALEX_ENABLED: "0", KEY_USER_DATA: path.join(temp, "profile"), KEY_WORKSPACE_PARENT: path.join(temp, "workspaces") },
  });
  const report = {};
  const page = await app.firstWindow();
  try {
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 880));
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });

    // 1. Key Settings › AI assistant: choose, connect, pick a model.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
    const settings = page.locator(".kx-settings");
    await settings.getByRole("button", { name: "AI assistant" }).click();
    await settings.getByRole("radio", { name: /Other \(OpenAI-compatible\)/ }).click();
    const address = settings.getByRole("textbox", { name: "Server address" });
    await address.fill(base);
    await settings.getByRole("button", { name: "Save address" }).click();
    await settings.locator("[data-ai-test]", { hasText: "answered" }).waitFor();
    await settings.getByRole("combobox", { name: "Another model" }).selectOption("mock-small");
    await settings.locator("[data-ai-ready]").waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(temp, "ai-setup.png") });
    report.setup = await call("ai_status");
    assert.equal(report.setup.configured, true);
    assert.equal(report.setup.model, "mock-small");
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "detached" });

    // Sources, a collection, and a value the user typed.
    const ids = {};
    for (const [title, abstract] of Object.entries(ABSTRACTS)) ids[title] = (await call("store_create", { source: { kind: "reference", itemType: "article", title, abstract, year: 2020, creators: [{ family: "Doe", given: "J", role: "author" }] } })).id;
    const trials = await call("store_collection_create", { name: "Field studies" });
    const collectionId = trials.id ?? trials.collection?.id;
    for (const title of ["Deworming and school attendance", "Long-run effects of microcredit", "Village savings groups", "Theory of poverty traps"])
      await call("store_membership", { collectionId, ids: [ids[title]], present: true }).catch(() => call("store_edit", { ids: [ids[title]], edit: { collectionsAdd: [collectionId] } }));
    await call("workspace_save_attribute", { name: "Study design", config: { type: "select", options: ["Randomised controlled trial", "Cohort study", "Case-control study", "Cross-sectional study", "Systematic review", "Meta-analysis", "Qualitative study", "Case report", "Laboratory experiment", "Modelling or simulation", "Other"] } });
    await call("store_edit", { ids: [ids["Theory of poverty traps"]], edit: { patch: { properties: { "Study design": "Other" } } } });

    // 2. The fill sheet, from the selection bar.
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "sources", workspaceId: id }), ws.id);
    await page.getByRole("heading", { name: "All sources", exact: true }).waitFor();
    await page.locator(".kx-row", { hasText: "Teaching at the right level" }).first().click();
    await page.locator(".kx-row", { hasText: "Village savings groups" }).first().click({ modifiers: ["Meta"] });
    await page.getByRole("button", { name: "Fill with AI" }).click();
    const sheet = page.getByRole("dialog", { name: "Fill a property" });
    await sheet.waitFor();
    await sheet.locator('[data-recipe="Study design"]').click();
    assert.equal(await sheet.getByLabel("Property to fill").inputValue(), "Study design");
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(temp, "fill-what.png") });
    await sheet.getByRole("button", { name: "Continue" }).click();
    // Where from: metadata, abstract and the methods section; the privacy line says so.
    await sheet.locator(".kx-fill-privacy", { hasText: "metadata, abstract, sections of the pdf" }).waitFor();
    await sheet.locator('[data-input="sections"] input').uncheck();
    await page.screenshot({ path: path.join(temp, "fill-where.png") });
    await sheet.getByRole("button", { name: "Continue" }).click();
    // The answer: the property is a select, so the shape is fixed to one of its options.
    assert.equal(await sheet.locator('[data-shape="select"]').getAttribute("aria-checked"), "true");
    assert.equal(await sheet.locator('[data-shape="number"]').isDisabled(), true);
    await sheet.getByRole("button", { name: "Continue" }).click();

    // 3. Test on three sources: answers with their evidence, nothing saved.
    await sheet.getByRole("button", { name: "Test on 3 sources" }).click();
    await sheet.locator(".kx-fill-item[data-status=proposed]").nth(2).waitFor();
    await sheet.locator(".kx-fill-quote[data-verified]").first().waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(temp, "fill-test.png") });
    assert.equal((await call("store_source", { id: ids["Teaching at the right level"] })).properties["Study design"], undefined);
    report.testRequests = requests.length;
    await sheet.getByRole("button", { name: "Continue" }).click();

    // 4. Run on the collection; the estimate counts what it sends and skips the typed value.
    await sheet.getByRole("combobox", { name: "Run on" }).selectOption(`collection:${collectionId}`);
    await sheet.locator(".kx-fill-estimate", { hasText: "3 sources" }).waitFor();
    await sheet.locator(".kx-fill-estimate", { hasText: "1 keep the value you entered" }).waitFor();
    await sheet.locator(".kx-fill-estimate", { hasText: "tokens" }).waitFor();
    await page.screenshot({ path: path.join(temp, "fill-run.png") });
    await sheet.getByRole("button", { name: /^Fill 3 sources/ }).click();

    // 5. Review: progress, then accept one, edit one, accept the rest.
    const review = sheet.locator(".kx-fill-review");
    await review.waitFor();
    await sheet.locator('.kx-fill-review[data-status="done"]').waitFor();
    await sheet.locator(".kx-fill-item[data-status=proposed]").nth(2).waitFor();
    await page.screenshot({ path: path.join(temp, "fill-review.png") });
    const row = (title) => sheet.locator(".kx-fill-item", { hasText: title });
    await row("Deworming and school attendance").getByRole("button", { name: "Accept" }).click();
    await sheet.locator(".kx-fill-message", { hasText: "Saved 1 value" }).waitFor();
    await row("Village savings groups").getByRole("button", { name: "Edit" }).click();
    const edit = sheet.getByRole("textbox", { name: "Edit the value for Village savings groups" });
    await edit.fill("Cross-sectional study");
    await edit.press("Enter");
    const value = async (title) => (await call("store_source", { id: ids[title] })).properties["Study design"];
    for (let i = 0; i < 50 && (await value("Village savings groups")) !== "Cross-sectional study"; i++) await page.waitForTimeout(100);
    report.messageAfterEdit = await sheet.locator(".kx-fill-message").innerText().catch(() => "");
    await sheet.getByRole("button", { name: /^Accept all/ }).click();
    for (let i = 0; i < 50 && (await value("Long-run effects of microcredit")) !== "Cohort study"; i++) await page.waitForTimeout(100);
    assert.equal(await value("Deworming and school attendance"), "Randomised controlled trial");
    assert.equal(await value("Village savings groups"), "Cross-sectional study");
    assert.equal(await value("Long-run effects of microcredit"), "Cohort study");
    assert.equal(await value("Theory of poverty traps"), "Other", "a typed value is never proposed over");
    assert.equal(await value("Teaching at the right level"), undefined, "outside the collection");
    report.saved = true;

    // 6. Undo the whole run.
    await sheet.getByRole("button", { name: "Undo run" }).click();
    await sheet.locator(".kx-fill-message", { hasText: "Undid the run" }).waitFor();
    assert.equal(await value("Deworming and school attendance"), undefined);
    assert.equal(await value("Village savings groups"), undefined);
    assert.equal(await value("Theory of poverty traps"), "Other");
    report.undone = true;
    const recipes = await call("store_fill_recipes");
    assert.ok(recipes.some((r) => r.name === "Study design"), "the recipe was saved");
    assert.ok(requests.every((r) => r.model === "mock-small"));
    report.requests = requests.length;
    await page.screenshot({ path: path.join(temp, "fill-undone.png") });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, report }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error("failure screenshot:", path.join(temp, "failure.png"));
    throw error;
  } finally {
    await app.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
