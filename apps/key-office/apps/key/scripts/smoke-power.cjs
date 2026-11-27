// Indexing on battery: with the Mac reported on battery at 10% (as Electron main reports it,
// `store_power_state`), bulk indexing waits and the status bar says "Indexing paused on
// battery"; a PDF the user opens is still indexed; "Continue anyway" in the activity panel
// lets the rest run. Workspace Settings › Indexing & lookups offers the policy.
// Screenshots (light and dark) land in the temp folder it prints.
//
//   node scripts/smoke-power.cjs
const assert = require("node:assert/strict");
const { mkdtemp, readFile, writeFile, readdir } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { launch, close, FIXTURES } = require("./perf-lib.cjs");

const until = async (check, what, timeout = 30000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-smoke-power-"));
  const { app, shell } = await launch({ profile: path.join(temp, "profile"), workspaces: path.join(temp, "ws"), env: { KEY_OPENALEX_FIXTURES: temp, KEY_WEB_OPENALEX_URL: "http://127.0.0.1:9" } });
  const result = { temp };
  const shot = async (name) => {
    for (const scheme of ["light", "dark"]) {
      await shell.evaluate((t) => window.key.setAppSettings({ theme: t }), scheme);
      await shell.emulateMedia({ colorScheme: scheme });
      await shell.waitForTimeout(300);
      await shell.screenshot({ path: path.join(temp, `${name}-${scheme}.png`) });
    }
    await shell.evaluate(() => window.key.setAppSettings({ theme: "system" }));
    await shell.emulateMedia({ colorScheme: "light" });
  };
  try {
    const [ws] = await shell.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => shell.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    // On battery at 10%, before anything is added.
    const held = await call("store_power_state", { onBattery: true, level: 0.1, lowPower: false });
    assert.equal(held.held, "battery", "the default policy holds bulk work on a low battery");
    const names = (await readdir(FIXTURES)).filter((n) => /^PUBMED_.*\.pdf$/.test(n)).slice(0, 4);
    const files = [];
    for (const [i, name] of names.entries()) {
      const file = path.join(temp, `battery-${i}.pdf`);
      await writeFile(file, Buffer.concat([await readFile(path.join(FIXTURES, name)), Buffer.from(`\n%key-power ${i}\n`)]));
      files.push(file);
    }
    const created = await call("store_import_files", { paths: files });
    await shell.waitForTimeout(3000);
    const status = await call("store_status");
    assert.ok(status.activity.held, "indexing is held");
    const pending = async () => (await Promise.all(created.map((c) => call("store_source", { id: c.id })))).filter((s) => s.indexStatus !== "ready").length;
    assert.equal(await pending(), created.length, "nothing was indexed in bulk");
    const item = shell.locator(".kx-status-item", { hasText: "Indexing paused on battery" });
    await item.waitFor({ timeout: 15000 });
    await shot("status-held");
    // What the user opens is still indexed.
    await call("store_index_priority", { ids: [created[0].id], reason: "opened" });
    await until(async () => (await call("store_source", { id: created[0].id })).indexStatus === "ready", "the opened PDF to be indexed", 120000);
    assert.equal(await pending(), created.length - 1, "only the opened PDF was indexed");
    // The panel explains and offers Continue anyway.
    await item.click();
    const panel = shell.locator(".kx-activity-panel");
    await panel.waitFor();
    assert.match(await panel.innerText(), /save battery/);
    await shot("panel-held");
    await panel.getByRole("button", { name: "Continue anyway" }).click();
    await until(async () => (await pending()) === 0, "the rest to be indexed after Continue anyway", 240000);
    result.continued = true;
    await shell.keyboard.press("Escape");
    // Plugged in, the override is spent; Low Power Mode holds again.
    let state = await call("store_power_state", { onBattery: false, level: 0.5, lowPower: false });
    assert.equal(state.held, null);
    assert.equal(state.continued, false);
    state = await call("store_power_state", { onBattery: false, level: 0.5, lowPower: true });
    assert.equal(state.held, "low-power");
    // The policy in Workspace Settings.
    const never = await call("store_workspace_settings", { patch: { battery: "never" } });
    assert.equal(never.effective.battery, "never");
    assert.equal((await call("store_power_status")).held, null, "Keep indexing never holds");
    await call("store_workspace_settings", { patch: { battery: "low" } });
    await call("store_power_state", { onBattery: false, level: 1, lowPower: false });
    console.log(JSON.stringify({ ok: true, ...result }, null, 1));
  } catch (error) {
    await shell.screenshot({ path: path.join(temp, "failure.png") }).catch(() => undefined);
    console.error(error);
    console.log(JSON.stringify({ ok: false, ...result }, null, 1));
    process.exitCode = 1;
  } finally {
    await close(app);
  }
})();
