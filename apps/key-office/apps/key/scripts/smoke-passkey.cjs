// The passkey sign-in window, end to end against a local mock site and sign-in service:
// 1. a passkey request in a cross-site iframe covers the page with the sign-in card within a
//    second; Not now puts it aside (the bar keeps Stop waiting, which ends the request);
// 2. a sign-in that redirects app.localhost → idp.localhost asks for a passkey: the card offers
//    the sign-in window; the window (the installed Chrome, headless, with a profile of Key's own
//    and Chrome's virtual authenticator standing in for the phone) does a real WebAuthn
//    ceremony against the mock service and lands back on the site; Key copies just that
//    sign-in's cookies, closes the window and the page in Key is signed in;
// 3. Settings › Forget sign-ins removes Key's sign-in profile.
// Needs Google Chrome (or KEY_SIGNIN_CHROMIUM=<a Chromium program>). Never opens a window on
// screen and never touches a real browser profile: Chrome runs headless with a temp profile.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, stat } = require("node:fs/promises");
const { existsSync } = require("node:fs");
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
    await wait(100);
  }
}
function assert(value, message) {
  if (!value) throw Error(`Assertion failed: ${message}`);
}

const CHROME = process.env.KEY_SIGNIN_CHROMIUM || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(CHROME)) {
  console.log(JSON.stringify({ ok: true, skipped: `no Chromium browser at ${CHROME}` }));
  process.exit(0);
}

const html = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:15px system-ui;padding:24px">${body}</body></html>`;
// The sign-in service's page: asks for a passkey as soon as it opens (as Microsoft's does).
const IDP_PAGE = (ret) =>
  html(
    "Uni sign-in",
    `<h1>Uni sign-in</h1><p id="state">Waiting for your passkey…</p><img src="/pixel-from-tracker" alt="">
<script>
window.askedAt = Date.now();
(async () => {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    const made = await navigator.credentials.create({ publicKey: { challenge, rp: { id: location.hostname, name: "Uni" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "student@example.invalid", displayName: "Student" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "required", userVerification: "preferred" } } });
    const used = await navigator.credentials.get({ publicKey: { challenge, rpId: location.hostname, allowCredentials: [{ type: "public-key", id: made.rawId }] } });
    await fetch("/verify", { method: "POST", body: used.id });
    location.href = ${JSON.stringify(ret)} + "?ticket=ok";
  } catch (e) {
    document.getElementById("state").textContent = "error: " + e.name;
    window.failed = e.name;
  }
})();
</script>`,
  );

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => c.split("=")));
}

async function serve() {
  let base;
  const server = http.createServer((req, res) => {
    const host = (req.headers.host || "").split(":")[0];
    const url = new URL(req.url, `http://${req.headers.host}`);
    const page = (body) => (res.setHeader("content-type", "text/html"), res.end(body));
    if (host === "app.localhost") {
      if (url.pathname === "/library") {
        if (cookies(req).sp_session === "signed-in") return page(html("Library", `<h1 id="who">Signed in as student</h1>`));
        res.writeHead(302, { location: `${base("idp")}/login?return=${encodeURIComponent(`${base("app")}/acs`)}` });
        return res.end();
      }
      if (url.pathname === "/acs" && url.searchParams.get("ticket") === "ok") {
        res.writeHead(302, { "set-cookie": "sp_session=signed-in; Path=/; HttpOnly; SameSite=Lax", location: "/library" });
        return res.end();
      }
      if (url.pathname === "/embedded") return page(html("Embedded", `<h1>Journal</h1><iframe id="f" allow="publickey-credentials-get *" src="${base("idp")}/frame" style="width:400px;height:200px"></iframe>`));
    }
    if (host === "idp.localhost") {
      if (url.pathname === "/login") return page(IDP_PAGE(url.searchParams.get("return") || `${base("app")}/library`));
      if (url.pathname === "/verify") {
        res.writeHead(200, { "set-cookie": ["idp_session=fresh; Path=/; HttpOnly; SameSite=None; Secure", `idp_remember=yes; Path=/; Max-Age=86400`] });
        return res.end("ok");
      }
      if (url.pathname === "/frame")
        return page(
          html(
            "Frame",
            `<script>window.result = navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: location.hostname } }).then(() => "ok", (e) => e.name);
             window.result.then((r) => parent.postMessage("frame:" + r, "*"));</script>`,
          ),
        );
      if (url.pathname === "/pixel-from-tracker") {
        res.writeHead(302, { location: `${base("tracker")}/pixel` });
        return res.end();
      }
    }
    if (host === "tracker.localhost" && url.pathname === "/pixel") {
      // Which browser loaded it: the (headless) sign-in window, or Key's own.
      const who = /HeadlessChrome/.test(req.headers["user-agent"] || "") ? "window" : "key";
      res.writeHead(200, { "set-cookie": `track=${who}; Path=/; SameSite=None; Secure`, "content-type": "image/gif" });
      return res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  base = (name) => `http://${name}.localhost:${port}`;
  return { server, base };
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-passkey-smoke-"));
  await mkdir(path.join(temp, "profile"));
  const shots = path.join(temp, "shots");
  await mkdir(shots);
  const { server, base } = await serve();
  const app = await electron.launch({
    args: [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_BROWSER_SMOKE: "1",
      KEY_SIGNIN_CHROMIUM: CHROME,
      KEY_SIGNIN_HEADLESS: "1",
      KEY_SIGNIN_VIRTUAL_AUTHENTICATOR: "1",
      KEY_SIGNIN_SETTLE_MS: "600",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
    },
  });
  if (process.env.KEY_SMOKE_VERBOSE) app.process().stderr.on("data", (d) => process.stderr.write(`[main] ${d}`));
  const report = {};
  try {
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => window.key);
    const signin = async () => {
      const t = await shell.evaluate(() => window.key.tabs());
      return t.tabs.find((x) => x.id === t.activeTabId)?.views[0]?.web?.signin;
    };

    // 1. A passkey request inside a cross-site frame: the card covers the page.
    await shell.evaluate((url) => window.key.tabAction("open-url", { url }), `${base("app")}/embedded`);
    const embedded = await until(() => app.windows().find((p) => p.url().startsWith(`${base("app")}/embedded`)), "the embedding page");
    const result = embedded.evaluate(() => new Promise((r) => addEventListener("message", (e) => String(e.data).startsWith("frame:") && r(e.data))));
    const started = Date.now();
    const card = await until(async () => (await signin())?.card, "the card for a frame's passkey request", 10000);
    report.cardAfterMs = Date.now() - started;
    assert(card.stage === "offer" && card.way === "window" && card.site === "idp.localhost", `the card offers the sign-in window: ${JSON.stringify(card)}`);
    await shell.waitForSelector(".kx-signin-card-layer[data-stage=offer]");
    await wait(400);
    await shell.screenshot({ path: path.join(shots, "1-card-light.png") });
    await shell.emulateMedia({ colorScheme: "dark" });
    await shell.evaluate(() => window.key.setAppSettings({ theme: "dark" }));
    await wait(500);
    await shell.screenshot({ path: path.join(shots, "1-card-dark.png") });
    await shell.emulateMedia({ colorScheme: "light" });
    await shell.evaluate(() => window.key.setAppSettings({ theme: "light" }));
    await shell.click(".kx-signin-card button:has-text('Not now')");
    await until(async () => (await signin())?.waiting, "the bar's notice after Not now");
    await shell.waitForSelector(".key-web-signin[data-waiting]");
    await shell.screenshot({ path: path.join(shots, "2-bar-waiting.png") });
    await shell.click(".key-web-signin[data-waiting] button:has-text('Stop waiting')");
    assert((await result) === "frame:NotAllowedError", "Stop waiting ends the frame's request");
    report.frame = "detected, stopped";

    // 2. The sign-in window: a redirect chain whose sign-in page asks for a passkey.
    await shell.evaluate((url) => window.key.tabAction("open-url", { url }), `${base("app")}/library`);
    const login = await until(() => app.windows().find((p) => p.url().startsWith(`${base("idp")}/login`)), "the sign-in page");
    await until(async () => (await signin())?.card?.stage === "offer", "the card on the sign-in page", 10000);
    const asked = await login.evaluate(() => window.askedAt);
    report.cardWithinMs = Date.now() - asked;
    assert(report.cardWithinMs < 2500, `the card appears within a moment (${report.cardWithinMs} ms)`);
    await shell.click(".kx-signin-card button[data-primary]");
    const opened = await until(async () => {
      const s = await signin();
      return s?.card?.stage === "open" ? s.card : s?.imported ? { site: "(done)" } : undefined;
    }, "the sign-in window to open", 10000);
    // The window starts on the page that sent the tab to the sign-in, not on the sign-in page.
    assert(opened.site === "app.localhost" || opened.site === "(done)", `the window opens where the sign-in started: ${JSON.stringify(opened)}`);
    await shell.screenshot({ path: path.join(shots, "3-window-open.png") }).catch(() => undefined);
    const done = await until(async () => {
      const s = await signin();
      if (s?.card?.stage === "failed") throw Error(`The sign-in failed: ${s.card.problem}`);
      return s?.imported;
    }, "the sign-in to come back", 45000);
    assert(done.names.includes("app.localhost") && done.names.includes("idp.localhost") && !done.names.includes("tracker.localhost"), `brought over for the chain's sites only: ${JSON.stringify(done)}`);
    const library = await until(() => app.windows().find((p) => p.url() === `${base("app")}/library`), "the page reloaded in Key");
    await until(() => library.evaluate(() => document.getElementById("who")?.textContent).catch(() => ""), "the page signed in");
    const jar = await app.evaluate(async ({ session }) => (await session.fromPartition("persist:key-browser").cookies.get({})).map((c) => `${c.domain}:${c.name}=${c.value}`));
    assert(jar.some((c) => c.includes(":sp_session=")) && jar.some((c) => c.includes(":idp_session=")), `the sign-in's cookies are in Key's browser: ${jar}`);
    // Key's own load of the sign-in page set its own tracker cookie; the window's is not copied.
    assert(!jar.some((c) => c.includes("track=window")), `no cookie of a site outside the sign-in: ${jar}`);
    await shell.waitForSelector(".key-web-signin[data-imported]");
    await shell.screenshot({ path: path.join(shots, "4-signed-in.png") });
    const profile = path.join(temp, "profile", "Sign-in window", "chrome");
    const mode = (await stat(profile)).mode & 0o777;
    assert(mode === 0o700, `the sign-in profile is private (${mode.toString(8)})`);
    report.signedIn = { names: done.names, cookies: jar.filter((c) => /sp_session|idp_session|idp_remember/.test(c)), profileMode: mode.toString(8) };

    // 3. Settings › Web & browser › Sign-in: Forget sign-ins removes Key's sign-in profile.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
    const settings = await until(async () => {
      for (const w of app.windows()) if (await w.locator(".kx-settings-nav button[data-section=web]").count().catch(() => 0)) return w;
    }, "Key Settings");
    await settings.locator(".kx-settings-nav button[data-section=web]").click();
    const group = settings.locator(".kx-settings-group", { has: settings.locator("h3", { hasText: "Sign-in" }) });
    await group.waitFor();
    await group.scrollIntoViewIfNeeded();
    await until(async () => (await group.locator("select option").allTextContents()).some((t) => /window/.test(t)), "the installed browser in the list");
    await group.screenshot({ path: path.join(shots, "5-settings.png") });
    const forget = group.locator("button", { hasText: "Forget sign-ins" });
    await forget.click();
    await forget.click();
    await until(() => !existsSync(profile), "the sign-in profile to be removed");
    report.forgotten = true;
    console.log(JSON.stringify({ ok: true, shots, ...report }, null, 2));
  } finally {
    await app.close().catch(() => undefined);
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
