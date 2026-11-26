// Run serially: native windows and focus are shared with other GUI checks.
// User API keys against local mocks of OpenAlex and SerpApi (no real network): a plaintext
// OpenAlex key from an older settings file moves into the secret store; a SerpApi key pasted
// in Settings › Services & API keys is tested against the free account endpoint; a web search
// whose keyless OpenAlex request gets 429 is retried with the key and succeeds; Semantic
// Scholar being down makes Google Scholar (via SerpApi) answer in its place; Settings then
// shows the usage. Neither key appears in anything the renderer is given, in the library
// host's environment, in the app's output or anywhere in its data folder.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, readFile, readdir, stat, writeFile } = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const fixtures = path.resolve(__dirname, "../../../../../crates/key-desktop-host/src/web_search/fixtures");
const OPENALEX_KEY = "oa-smoke-key-7f3a9c21b8d4";
const SERPAPI_KEY = "serp-smoke-key-5e6d7c8b9a01";

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-api-keys-"));
  const profile = path.join(temp, "profile");
  const noOpenAlex = path.join(temp, "no-openalex");
  await mkdir(noOpenAlex);
  await mkdir(profile);
  // An older settings file with the key in plain JSON.
  await writeFile(path.join(profile, "app-settings.json"), JSON.stringify({ theme: "system", onboarded: true, openalexApiKey: OPENALEX_KEY, webProviders: {} }));
  const openalexPage = JSON.parse(await readFile(path.join(fixtures, "openalex-search.json"), "utf8"));
  const scholarPage = JSON.parse(await readFile(path.join(fixtures, "serpapi-scholar.json"), "utf8"));

  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://mock");
    log.push(url.pathname + url.search);
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/works") {
      // The anonymous pool is used up; a request with the user's key gets through.
      if (url.searchParams.get("api_key") !== OPENALEX_KEY) return json(429, { error: "Rate limit exceeded" });
      return json(200, openalexPage, { "x-ratelimit-remaining": "99987" });
    }
    if (url.pathname === "/graph/v1/paper/search") return json(503, { message: "down" });
    if (url.pathname === "/account.json") {
      if (url.searchParams.get("api_key") !== SERPAPI_KEY) return json(401, { error: "Invalid API key." });
      return json(200, { plan_searches_left: 249, total_searches_left: 249, this_month_usage: 1 });
    }
    if (url.pathname === "/search.json") {
      if (url.searchParams.get("api_key") !== SERPAPI_KEY) return json(401, { error: "Invalid API key." });
      return json(200, scholarPage);
    }
    json(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mock = `http://127.0.0.1:${server.address().port}`;

  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_USER_DATA: profile,
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_OPENALEX_FIXTURES: noOpenAlex,
      KEY_WEB_OPENALEX_URL: mock,
      KEY_WEB_S2_URL: mock,
      KEY_WEB_SERPAPI_URL: mock,
      KEY_WEB_MAX_RETRY_WAIT_MS: "1",
    },
  });
  let output = "";
  app.process().stdout?.on("data", (d) => (output += d));
  app.process().stderr?.on("data", (d) => (output += d));
  const shot = (page, name) => page.screenshot({ path: path.join(temp, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 940));
    await page.getByRole("region", { name: "Home", exact: true }).waitFor();
    const [ws] = await page.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => page.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const visible = [];
    const seen = (label, value) => {
      visible.push([label, JSON.stringify(value)]);
      return value;
    };

    // The old plaintext key moved into the secret store and out of the settings file.
    const settingsFile = await readFile(path.join(profile, "app-settings.json"), "utf8");
    assert.ok(!settingsFile.includes(OPENALEX_KEY), "the settings file no longer holds the key");
    const secretsFile = await readFile(path.join(profile, "secrets.json"), "utf8");
    assert.equal(JSON.parse(secretsFile).backend, "local", "smokes never use the Keychain");
    assert.equal((await stat(path.join(profile, "secrets.json"))).mode & 0o777, 0o600);
    const listed = seen("services_list", await call("services_list"));
    const openalex = listed.services.find((s) => s.id === "openalex");
    assert.deepEqual([openalex.key.set, openalex.key.hint, openalex.mode], [true, OPENALEX_KEY.slice(-4), "fallback"]);
    seen("appSettings", await page.evaluate(() => window.key.appSettings()));

    // The library host was told the key over its IPC channel, not its environment.
    const pids = execFileSync("/usr/bin/pgrep", ["-f", `key-desktop-host.*${path.basename(temp)}`], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
    const hosts = pids.map((pid) => execFileSync("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", pid], { encoding: "utf8", maxBuffer: 1 << 24 }));
    assert.ok(hosts.length >= 1, "a library host for this profile is running");
    for (const line of hosts) assert.ok(!line.includes(OPENALEX_KEY) && !line.includes("KEY_OPENALEX_API_KEY"), "the host's environment carries no key");

    // Settings › Services & API keys: paste the SerpApi key, save, and it is tested at once.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
    const settings = page.locator(".kx-settings");
    await settings.getByRole("button", { name: "Services & API keys" }).click();
    await settings.getByRole("heading", { name: "Google Scholar via SerpApi" }).waitFor();
    await shot(page, "services-empty-light");
    const field = settings.getByLabel("Google Scholar API key");
    await field.fill("serp-wrong-key-0000");
    await settings.locator('[data-service="scholar-serpapi"]').locator("xpath=..").getByRole("button", { name: "Test" }).click();
    await settings.getByText("SerpApi refused this key").waitFor();
    await field.fill(SERPAPI_KEY);
    await settings.locator('[data-service="scholar-serpapi"]').locator("xpath=..").getByRole("button", { name: "Save" }).click();
    await settings.getByText("SerpApi accepted the key").waitFor();
    await settings.getByText("249", { exact: true }).waitFor();
    assert.ok(log.some((l) => l.startsWith("/account.json")), "the key was tested against the account endpoint");
    assert.ok(!log.some((l) => l.startsWith("/search.json")), "testing a key does not spend a search");
    await shot(page, "services-saved-light");
    await settings.getByRole("button", { name: "Close Key Settings" }).click();

    // Web search: OpenAlex is limited without a key (429) → asked again with it → results.
    // Semantic Scholar is down → Google Scholar answers in its place, once.
    await page.evaluate((id) => window.key.tabAction("open-content", { section: "search", workspaceId: id }), ws.id);
    const tab = page.locator(".kx-search-page");
    await tab.waitFor();
    const search = tab.getByRole("combobox", { name: "Search everything" });
    await tab.locator('.kx-web-pill button[data-kind="web"]').click();
    await search.click();
    await search.fill("attention");
    await page.waitForFunction(() => document.querySelector('.kx-search-page [role=combobox]')?.value === "attention");
    const web = tab.locator(".kx-web");
    await web.locator(".kx-web-hit", { hasText: "Highly accurate protein" }).waitFor({ timeout: 30000 });
    await web.locator('.kx-web-badge[data-provider="scholar"]').first().waitFor({ timeout: 30000 });
    const works = log.filter((l) => l.startsWith("/works?"));
    assert.ok(works.length >= 2, `OpenAlex asked twice, got ${works.length}`);
    assert.ok(!works[0].includes("api_key="), "the first OpenAlex request goes without the key");
    assert.ok(works.some((l) => l.includes(`api_key=${OPENALEX_KEY}`)), "the retry carries the key");
    assert.equal(log.filter((l) => l.startsWith("/search.json")).length, 1, "one Scholar search for the failed provider");
    assert.equal(await web.locator('.kx-web-badge[data-provider="scholar"]', { hasText: "Google Scholar" }).count() > 0, true, "labelled Google Scholar");
    await shot(page, "search-with-keys-light");

    // Usage in Settings.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
    await settings.getByRole("button", { name: "Services & API keys" }).click();
    const usage = settings.getByLabel("OpenAlex key usage");
    await usage.waitFor();
    await usage.getByText("just now").waitFor({ timeout: 10000 });
    const today = await usage.locator("dt:has-text('Today') + dd").textContent();
    assert.ok(Number(today) >= 1, `requests with the OpenAlex key today: ${today}`);
    const scholarUsage = await settings.getByLabel("Google Scholar key usage").locator("dt:has-text('Today') + dd").textContent();
    assert.equal(Number(scholarUsage), 1);
    await shot(page, "services-usage-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await page.waitForTimeout(400);
    await shot(page, "services-usage-dark");
    await page.evaluate(() => window.key.setAppSettings({ theme: "system" }));
    const after = seen("services_list", await call("services_list"));
    assert.equal(after.services.find((s) => s.id === "scholar-serpapi").usage.remaining, 249);
    seen("web_providers", await call("web_providers"));
    seen("appSettings", await page.evaluate(() => window.key.appSettings()));

    // Nothing the renderer was given, nothing the app printed, no file it wrote holds a key.
    for (const [label, value] of visible) for (const key of [OPENALEX_KEY, SERPAPI_KEY]) assert.ok(!value.includes(key), `${label} carries no key`);
    const dom = await page.content();
    for (const key of [OPENALEX_KEY, SERPAPI_KEY]) assert.ok(!dom.includes(key), "the page holds no key");
    await app.evaluate(({ app }) => app.emit("before-quit"));
    await page.waitForTimeout(500);
    const files = [...(await filesUnder(profile)), ...(await filesUnder(path.join(temp, "workspaces")))];
    const leaks = [];
    for (const file of files) {
      const bytes = await readFile(file).catch(() => Buffer.alloc(0));
      for (const key of [OPENALEX_KEY, SERPAPI_KEY]) if (bytes.includes(Buffer.from(key))) leaks.push(`${path.relative(temp, file)} holds ${key.slice(0, 8)}…`);
    }
    assert.deepEqual(leaks, [], "no file under the profile or workspaces holds a key");
    for (const key of [OPENALEX_KEY, SERPAPI_KEY]) assert.ok(!output.includes(key), "the app's output holds no key");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, temp, migrated: true, keychain: false, retriedWithKey: true, scholarFallback: true, usageShown: true, filesChecked: files.length, noLeaks: true }));
  } catch (e) {
    await app.windows()[0]?.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error("Artifacts", temp, "requests", JSON.stringify(log));
    throw e;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
