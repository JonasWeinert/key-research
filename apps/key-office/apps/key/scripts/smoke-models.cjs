// Run serially: native windows and focus are shared with other GUI checks.
// On-device models come on demand from a (mock) Hugging Face: with the layout model missing a
// PDF is read without it and nothing downloads by itself (test runs); Settings › Search &
// indexing lists each model, Download shows progress there and in the status bar, the model
// becomes ready and the PDF is analysed again with it; Remove frees the disk and the model
// returns to "Not downloaded". Needs the dev cache: node tools/models/fetch.mjs.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { manifest, devCache, isReady, mockHub } = require("../../../../../tools/models/models.cjs");

const LAYOUT = "pp-doclayoutv3-fp16";

(async () => {
  const spec = manifest().find((m) => m.id === LAYOUT);
  if (!isReady(devCache(), spec)) throw Error(`The layout model is not in the dev cache (${devCache()}): node tools/models/fetch.mjs ${LAYOUT}`);
  const hub = await mockHub({ ids: [LAYOUT], delayMs: 150 });
  const temp = await mkdtemp(path.join(tmpdir(), "key-models-"));
  const models = path.join(temp, "models");
  const fixture = path.join(temp, "Paper.pdf");
  await writeFile(fixture, await readFile(path.resolve(__dirname, "../../../../../tests/fixtures/PUBMED_16226083.pdf")));
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_MODEL_DIR: models,
      KEY_MODELS_BASE_URL: hub.url,
      KEY_INDEX_EMBEDDINGS: "0",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
    },
  });
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    // Playwright pins a light colour scheme by default; follow the app's own setting instead.
    await page.emulateMedia({ colorScheme: null });
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const until = async (what, test, seconds = 120) => {
      for (let i = 0; i < seconds * 4; i++) {
        const value = await test();
        if (value) return value;
        await page.waitForTimeout(250);
      }
      throw Error(`Timed out waiting for ${what}`);
    };
    const layoutModel = async () => (await call("store_models")).models.find((m) => m.id === LAYOUT);

    // Missing model: the PDF is read without it; a test run never downloads by itself.
    const [created] = await page.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [fixture] });
    const first = await until("analysis without the model", async () => {
      const r = await call("store_analysis", { id: created.id });
      return r.analysis && r.indexStatus === "ready" && r;
    });
    assert.equal(first.analysis.engine, "layout", "read without the layout model");
    assert.equal(first.layoutModelState, "missing");
    assert.equal((await layoutModel()).state, "missing");
    assert.equal(hub.requests.length, 0, "nothing downloaded on its own");

    // Settings › Search & indexing lists the models with source, licence and state.
    await page.locator(".key-sidebar").getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Key Settings", exact: true });
    await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Search & indexing" }).click();
    const row = settings.locator(`.kx-models-row[data-model="${LAYOUT}"]`);
    await row.getByText("Not downloaded").waitFor();
    await settings.getByText("On-device models").waitFor();
    assert.ok(await row.getByRole("link", { name: "Apache-2.0" }).count());
    assert.match(await row.getByRole("link", { name: "Source" }).getAttribute("href"), /huggingface\.co\/JonasWeinert\/key-pp-doclayoutv3-onnx/);
    await page.waitForTimeout(300);
    await shot(page, "1-models-missing");

    // Download: progress in the row and in the status bar, then ready.
    await row.getByRole("button", { name: "Download" }).click();
    await row.getByText(/Downloading \d+%/).waitFor();
    await page.locator(".kx-status-work").filter({ hasText: /PDF layout model \d+%/ }).waitFor();
    await shot(page, "2-models-downloading");
    await row.getByText("Ready").waitFor({ timeout: 120000 });
    await shot(page, "3-models-ready");
    assert.ok(hub.requests.every((r) => /^bytes=\d+-\d+$/.test(r.range ?? "")), "fetched in byte ranges");
    assert.equal((await layoutModel()).state, "ready");
    // The waiting PDF is analysed again, now with the model.
    const second = await until("analysis with the model", async () => {
      const r = await call("store_analysis", { id: created.id });
      return r.analysis?.engine === "layout-onnx" && r.indexStatus === "ready" && r;
    }, 300);
    assert.equal(second.layoutModelState, "ready");

    // Dark appearance, then Remove: the files go and the state returns to Not downloaded.
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForTimeout(400);
    await shot(page, "4-models-ready-dark");
    await page.evaluate(() => window.key.setAppSettings({ theme: "system" }));
    await row.getByRole("button", { name: "Remove" }).click();
    await row.getByText("Not downloaded").waitFor();
    assert.equal(existsSync(path.join(models, LAYOUT)), false, "the model's folder is gone");
    assert.equal((await layoutModel()).state, "missing");
    await shot(page, "5-models-removed");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, requests: hub.requests.length }));
  } catch (e) {
    await app.windows()[0]?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error("Artifacts", temp);
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await hub.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
