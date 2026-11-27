// Passkey sign-ins in the in-app browser, against a local WebAuthn page:
// 1. a request no authenticator answers shows the bar's notice instead of an endless wait, and
//    Stop waiting ends it (the page hears NotAllowedError);
// 2. with Chromium's virtual authenticator (CDP, standing in for a security key) a passkey is
//    created and used, with no notice;
// 3. Continue in browser + Bring sign-in over copies only the sign-in's cookies from a fixture
//    Firefox profile (KEY_COOKIE_IMPORT_HOME; never a real profile) and reopens the page.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir } = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { tmpdir } = require("node:os");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await wait(150);
  }
}
function assert(value, message) {
  if (!value) throw Error(`Assertion failed: ${message}`);
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Passkey test</title></head>
<body style="font:15px system-ui;padding:24px"><h1>Passkey test</h1><p id="cookies"></p><pre id="out"></pre>
<script>
document.getElementById("cookies").textContent = "cookies: " + document.cookie;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
window.ceremony = async (kind, uv = "preferred") => {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    if (kind === "create") {
      const c = await navigator.credentials.create({ publicKey: { challenge, rp: { id: "localhost", name: "Key smoke" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "smoke@example.invalid", displayName: "Smoke" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "required", userVerification: uv } } });
      window.created = c.rawId;
      return { ok: true, id: c.id, type: c.type };
    }
    const allow = window.created ? [{ type: "public-key", id: window.created }] : [];
    const a = await navigator.credentials.get({ publicKey: { challenge, rpId: "localhost", allowCredentials: allow, userVerification: uv } });
    return { ok: true, id: a.id, signature: a.response.signature.byteLength > 0 };
  } catch (e) {
    return { error: e.name };
  }
};
</script></body></html>`;

async function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/start") {
      res.statusCode = 302;
      res.setHeader("location", "/signin");
      return res.end();
    }
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // WebAuthn needs a secure context and a domain for its relying party: localhost is both.
  return { server, base: `http://localhost:${server.address().port}` };
}

/** A Firefox profile with a cookie for the test site and one for a site the sign-in never saw. */
function firefoxFixture(home) {
  const root = path.join(home, "Library", "Application Support", "Firefox");
  const profile = path.join(root, "Profiles", "smoke.default-release");
  execFileSync("mkdir", ["-p", profile]);
  require("node:fs").writeFileSync(path.join(root, "profiles.ini"), "[Install0]\nDefault=Profiles/smoke.default-release\n");
  const db = path.join(profile, "cookies.sqlite");
  const future = Math.floor(Date.now() / 1000) + 86400;
  execFileSync("/usr/bin/sqlite3", [
    db,
    `create table moz_cookies(originAttributes text, name text, value text, host text, path text, expiry integer, isSecure integer, isHttpOnly integer, sameSite integer);
     insert into moz_cookies values('', 'signedin', 'from-firefox', 'localhost', '/', ${future}, 0, 0, 1);
     insert into moz_cookies values('', 'other', 'never', '.unrelated.example', '/', ${future}, 0, 0, 1);`,
  ]);
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-signin-smoke-"));
  await mkdir(path.join(temp, "profile"));
  const shots = path.join(temp, "shots");
  await mkdir(shots);
  firefoxFixture(path.join(temp, "home"));
  const { server, base } = await serve();
  const app = await electron.launch({
    args: [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_BROWSER_SMOKE: "1",
      KEY_SIGNIN_NOTICE_MS: "800",
      KEY_COOKIE_IMPORT_HOME: path.join(temp, "home"),
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
    },
  });
  if (process.env.KEY_SMOKE_VERBOSE) app.process().stderr.on("data", (d) => process.stderr.write(`[main] ${d}`));
  const report = {};
  try {
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => window.key);
    // Sheets are answered "yes" and recorded (the real ones are native macOS sheets).
    await app.evaluate(({ dialog }) => {
      globalThis.smokeSheets = [];
      dialog.showMessageBox = async (...args) => {
        globalThis.smokeSheets.push(args[args.length - 1]);
        return { response: 0, checkboxChecked: false };
      };
    });
    await shell.evaluate(() => window.key.setAppSettings({ signInBrowser: "firefox" }));
    await shell.evaluate((url) => window.key.tabAction("open-url", { url }), `${base}/start`);
    const page = await until(() => app.windows().find((p) => p.url().startsWith(base)), "the test page");
    await page.waitForFunction(() => typeof window.ceremony === "function");
    const signin = async () => {
      const t = await shell.evaluate(() => window.key.tabs());
      return t.tabs.find((x) => x.id === t.activeTabId)?.views[0]?.web?.signin;
    };

    // 1. Nothing answers: the notice appears, Stop waiting ends the request.
    const pending = page.evaluate(() => window.ceremony("get", "required"));
    const waiting = await until(signin, "the passkey notice", 10000);
    assert(waiting.waiting?.site === "localhost" && waiting.waiting.browser === "Firefox", `notice says what waits: ${JSON.stringify(waiting)}`);
    await shell.waitForSelector(".key-web-signin[data-waiting]");
    await shell.screenshot({ path: path.join(shots, "1-waiting.png") });
    const started = Date.now();
    await shell.click(".key-web-signin[data-waiting] button:has-text('Stop waiting')");
    const stopped = await pending;
    assert(stopped.error === "NotAllowedError", `the page hears NotAllowedError: ${JSON.stringify(stopped)}`);
    assert(Date.now() - started < 5000, "stopping is immediate");
    await until(async () => !(await signin()), "the notice to go");
    report.stop = stopped;

    // 2. A security key (Chromium's virtual authenticator): create and use a passkey, no notice.
    await app.evaluate(async ({ webContents }, base) => {
      const contents = webContents.getAllWebContents().find((c) => c.getURL().startsWith(base));
      contents.debugger.attach("1.3");
      await contents.debugger.sendCommand("WebAuthn.enable", { enableUI: false });
      await contents.debugger.sendCommand("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
      });
    }, base);
    const created = await page.evaluate(() => window.ceremony("create", "required"));
    assert(created.ok && created.type === "public-key", `a passkey is created: ${JSON.stringify(created)}`);
    const used = await page.evaluate(() => window.ceremony("get", "required"));
    assert(used.ok && used.id === created.id && used.signature, `and used: ${JSON.stringify(used)}`);
    await wait(1200);
    assert(!(await signin()), "no notice when an authenticator answers");
    report.virtualAuthenticator = { created: created.id.slice(0, 12), used: used.ok };
    await app.evaluate(async ({ webContents }, base) => {
      const contents = webContents.getAllWebContents().find((c) => c.getURL().startsWith(base));
      await contents.debugger.sendCommand("WebAuthn.disable");
      contents.debugger.detach();
    }, base);

    // 3. Continue in the browser, then bring the sign-in over from the fixture Firefox profile.
    const again = page.evaluate(() => window.ceremony("get", "required"));
    await until(async () => (await signin())?.waiting, "the notice again", 10000);
    await shell.click(".key-web-signin[data-waiting] button[data-primary]");
    const opened = await until(() => app.evaluate(() => globalThis.keySignInOpened), "the hand-off");
    assert(opened.browser === "firefox" && opened.url === `${base}/signin`, `the sign-in opens on the page that asked: ${JSON.stringify(opened)}`);
    assert((await again).error === "NotAllowedError", "handing off ends the page's wait");
    await shell.waitForSelector(".key-web-signin[data-handoff]");
    await shell.screenshot({ path: path.join(shots, "2-handoff.png") });
    await shell.click(".key-web-signin[data-handoff] button[data-primary]");
    await until(async () => (await signin())?.imported, "the imported notice", 15000);
    const sheets = await app.evaluate(() => globalThis.smokeSheets);
    const ask = sheets.find((s) => /Bring your sign-in over/.test(s.message));
    assert(ask && /localhost \(1 cookie\)/.test(ask.detail) && !/unrelated/.test(ask.detail), `the question lists only the sign-in's sites: ${JSON.stringify(sheets)}`);
    const reopened = await until(() => app.windows().find((p) => p.url().startsWith(base)), "the reopened page");
    await until(() => reopened.evaluate(() => document.cookie.includes("signedin=from-firefox")).catch(() => false), "the imported cookie in the page");
    const cookies = await app.evaluate(async ({ session }) => (await session.fromPartition("persist:key-browser").cookies.get({})).map((c) => c.name));
    assert(!cookies.includes("other"), "no other site's cookie was imported");
    await shell.waitForSelector(".key-web-signin[data-imported]");
    await shell.screenshot({ path: path.join(shots, "3-imported.png") });
    // Settings › Web & browser › Sign-in.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
    const settings = await until(async () => {
      for (const w of app.windows()) if (await w.locator(".kx-settings-nav button[data-section=web]").count().catch(() => 0)) return w;
    }, "Key Settings");
    await settings.locator(".kx-settings-nav button[data-section=web]").click();
    const group = settings.locator(".kx-settings-group", { has: settings.locator("h3", { hasText: "Sign-in" }) });
    await group.waitFor();
    await group.scrollIntoViewIfNeeded();
    await group.screenshot({ path: path.join(shots, "4-settings.png") });
    await group.locator("select").selectOption("safari");
    await until(async () => (await settings.evaluate(() => window.key.appSettings())).settings?.signInBrowser === "safari", "the browser choice to be saved");
    report.import = { question: ask.message, cookies: cookies.filter((n) => n === "signedin") };
    console.log(JSON.stringify({ ok: true, shots, ...report }, null, 2));
  } finally {
    await app.close().catch(() => undefined);
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
