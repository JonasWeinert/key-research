// The passkey proxy: a page in Key's browser signs up and signs in with a passkey, and the
// login completes IN KEY. The ceremony runs in Key's Chrome (headless here, with Chrome's virtual
// authenticator standing in for the phone) on a blank document of the page's origin, and the
// answer comes back to the page as a PublicKeyCredential. The mock relying party verifies
// everything a real one does (challenge, origin, rpIdHash, flags, ES256 signature with the
// registered key), so a wrong clientDataJSON or signature fails. Cases: create and get
// (allowCredentials and discoverable, UV required), instanceof PublicKeyCredential, toJSON()
// accepted by the server, cancel → NotAllowedError, timeout, abort → AbortError, a request
// without a click (Key asks first), a cross-origin iframe, an rp ID the page may not use.
// Needs Google Chrome (or KEY_SIGNIN_CHROMIUM). Never shows a window; no real account.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, mkdir } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { createHash, createPublicKey, randomBytes, verify } = require("node:crypto");
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

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");
const sha256 = (data) => createHash("sha256").update(data).digest();

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>RP login</title></head>
<body style="font:15px system-ui;padding:24px"><h1>RP login</h1><button id="go">Go</button><p id="who"></p>
<script>
const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const api = async (p, body) => (await fetch(p, { method: "POST", body: JSON.stringify(body || {}) })).json();
window.register = async (uv = "required") => {
  const o = await api("/options/register");
  try {
    const c = await navigator.credentials.create({ publicKey: { challenge: dec(o.challenge), rp: { id: location.hostname, name: "RP" },
      user: { id: dec(o.userId), name: "student@example.invalid", displayName: "Student" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", userVerification: uv }, timeout: 60000 } });
    const instance = c instanceof PublicKeyCredential && c.response instanceof AuthenticatorAttestationResponse && c.rawId instanceof ArrayBuffer;
    return { ...(await api("/verify/register", c.toJSON())), instance };
  } catch (e) { return { error: e.name, message: e.message }; }
};
window.signin = async ({ discoverable = false, uv = "required", timeout, abortAfter, rpId } = {}) => {
  const o = await api("/options/login");
  const ctl = new AbortController();
  if (abortAfter) setTimeout(() => ctl.abort(), abortAfter);
  try {
    const c = await navigator.credentials.get({ publicKey: { challenge: dec(o.challenge), rpId: rpId || location.hostname,
      allowCredentials: discoverable ? [] : o.allow.map((id) => ({ type: "public-key", id: dec(id) })), userVerification: uv, ...(timeout ? { timeout } : {}) }, signal: ctl.signal });
    const instance = c instanceof PublicKeyCredential && c.response instanceof AuthenticatorAssertionResponse && c.response.signature instanceof ArrayBuffer;
    const result = await api("/verify/login" + (window.top !== window ? "?embedded=1" : ""), c.toJSON());
    if (result.ok) document.getElementById("who").textContent = "Signed in as " + result.user;
    return { ...result, instance };
  } catch (e) { return { error: e.name, message: e.message }; }
};
document.getElementById("go").onclick = async () => { window.out = undefined; window.out = await window.next(); };
if (location.pathname === "/auto") window.signin().then((r) => (window.out = r));
</script></body></html>`;

async function serve() {
  let base;
  const credentials = new Map(); // id → { key, user, counter }
  let challenge = "";
  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host || "").split(":")[0];
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (value) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(value)));
    const body = await new Promise((r) => {
      let s = "";
      req.on("data", (d) => (s += d));
      req.on("end", () => r(s ? JSON.parse(s) : {}));
    });
    if (host === "app.localhost" && url.pathname === "/embed")
      return res.end(`<!doctype html><title>Journal</title><h1>Journal</h1><iframe id="login" allow="publickey-credentials-get *" src="${base("rp")}/login" style="width:520px;height:320px"></iframe>`);
    if (host !== "rp.localhost") return (res.writeHead(404), res.end());
    const origin = base("rp");
    // What a relying party checks: the challenge it issued, the origin, its rp ID, presence and verification.
    const client = (cred, type, embedded) => {
      const data = JSON.parse(unb64u(cred.response.clientDataJSON).toString());
      if (data.type !== type) throw Error(`type ${data.type}`);
      if (data.challenge !== challenge) throw Error("challenge");
      if (data.origin !== origin) throw Error(`origin ${data.origin}`);
      if (!!data.crossOrigin !== !!embedded) throw Error(`crossOrigin ${data.crossOrigin}`);
      return data;
    };
    const auth = (authData) => {
      if (!authData.subarray(0, 32).equals(sha256("rp.localhost"))) throw Error("rpIdHash");
      const flags = authData[32];
      if (!(flags & 1) || !(flags & 4)) throw Error(`flags ${flags}`);
      return authData.readUInt32BE(33);
    };
    try {
      if (url.pathname === "/login" || url.pathname === "/auto") return (res.writeHead(200, { "content-type": "text/html" }), res.end(PAGE));
      if (url.pathname === "/options/register") {
        challenge = b64u(randomBytes(32));
        return json({ challenge, userId: b64u(randomBytes(16)) });
      }
      if (url.pathname === "/verify/register") {
        client(body, "webauthn.create", false);
        auth(unb64u(body.response.authenticatorData));
        if (body.response.publicKeyAlgorithm !== -7 || !body.response.publicKey) throw Error("public key");
        credentials.set(body.id, { key: createPublicKey({ key: unb64u(body.response.publicKey), format: "der", type: "spki" }), user: "student", counter: 0 });
        return json({ ok: true, id: body.id });
      }
      if (url.pathname === "/options/login") {
        challenge = b64u(randomBytes(32));
        return json({ challenge, allow: [...credentials.keys()] });
      }
      if (url.pathname === "/verify/login") {
        const stored = credentials.get(body.id);
        if (!stored) throw Error("unknown credential");
        const data = client(body, "webauthn.get", url.searchParams.get("embedded") === "1");
        const authData = unb64u(body.response.authenticatorData);
        auth(authData);
        const signed = Buffer.concat([authData, sha256(unb64u(body.response.clientDataJSON))]);
        if (!verify("sha256", signed, { key: stored.key, dsaEncoding: "der" }, unb64u(body.response.signature))) throw Error("signature");
        return json({ ok: true, user: stored.user, crossOrigin: !!data.crossOrigin });
      }
    } catch (error) {
      return json({ ok: false, error: String(error.message) });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = (name) => `http://${name}.localhost:${server.address().port}`;
  return { server, base };
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-passkey-proxy-smoke-"));
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
    const open = (url) => shell.evaluate((url) => window.key.tabAction("open-url", { url }), url);
    const tabAt = (prefix) => until(() => app.windows().find((p) => p.url().startsWith(prefix)), `a tab at ${prefix}`);
    const presence = (on) => app.evaluate((_, on) => globalThis.keyPasskeyPresence?.(on), on);
    /** Clicks Go on the page (a person's click: user activation) to run `call` there. */
    const run = async (page, call, arg) => {
      await page.evaluate(([call, arg]) => (window.next = () => window[call](arg)), [call, arg]);
      await page.click("#go");
      return until(() => page.evaluate(() => window.out), `the page's ${call}`, 45000);
    };

    await open(`${base("rp")}/login`);
    const rp = await tabAt(`${base("rp")}/login`);
    await rp.waitForFunction(() => typeof window.register === "function");
    // 1. Sign up: a passkey is created through the proxy and the server verifies it.
    const created = await run(rp, "register");
    assert(created.ok && created.instance, `a passkey is created, as a PublicKeyCredential: ${JSON.stringify(created)}`);
    // 2. Sign in with it (allowCredentials, UV required): verified signature, signed in in Key.
    const used = await run(rp, "signin");
    assert(used.ok && used.instance, `signed in with the passkey: ${JSON.stringify(used)}`);
    assert((await rp.textContent("#who")) === "Signed in as student", "the page in Key is signed in");
    // 3. Discoverable (no allowCredentials).
    const discoverable = await run(rp, "signin", { discoverable: true });
    assert(discoverable.ok, `discoverable sign-in: ${JSON.stringify(discoverable)}`);
    report.ceremonies = { created: created.ok, used: used.ok, discoverable: discoverable.ok };

    // 4. Cancel in Key's card → NotAllowedError (nobody touches the authenticator).
    await presence(false);
    await rp.evaluate(() => (window.next = () => window.signin()));
    await rp.click("#go");
    await until(async () => (await signin())?.card?.stage === "passkey-busy", "the card while the passkey window is open");
    await shell.waitForSelector(".key-web-signin[data-passkey=passkey-busy]");
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "1-busy.png") });
    await shell.click(".key-web-signin[data-passkey] button:has-text('Cancel')");
    const cancelled = await until(() => rp.evaluate(() => window.out), "the cancelled request");
    assert(cancelled.error === "NotAllowedError", `cancel → NotAllowedError: ${JSON.stringify(cancelled)}`);
    // 5. Timeout and abort.
    const timedOut = await run(rp, "signin", { timeout: 1500 });
    assert(timedOut.error === "NotAllowedError", `timeout → NotAllowedError: ${JSON.stringify(timedOut)}`);
    const abortedRequest = await run(rp, "signin", { abortAfter: 700 });
    assert(abortedRequest.error === "AbortError", `abort → AbortError: ${JSON.stringify(abortedRequest)}`);
    await presence(true);
    report.stops = { cancelled: cancelled.error, timedOut: timedOut.error, aborted: abortedRequest.error };

    // 6. An rp ID the page may not use is refused before any window.
    const wrong = await run(rp, "signin", { rpId: "other.localhost" });
    assert(wrong.error === "SecurityError", `a foreign rp ID → SecurityError: ${JSON.stringify(wrong)}`);

    // 7. A request without a click (a page that asks on load): Key asks first.
    await open(`${base("rp")}/auto`);
    await until(async () => (await signin())?.card?.stage === "passkey", "Key's question before the passkey window", 15000);
    await shell.waitForSelector(".key-web-signin[data-passkey=passkey]");
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "2-ask.png") });
    await shell.click(".key-web-signin[data-passkey] button:has-text('Use passkey')");
    const auto = await tabAt(`${base("rp")}/auto`);
    const autoResult = await until(() => auto.evaluate(() => window.out), "the sign-in after Use passkey", 45000);
    assert(autoResult.ok, `signed in after Use passkey: ${JSON.stringify(autoResult)}`);

    // 8. A login page in a cross-origin frame: reproduced as such (clientData crossOrigin true).
    await open(`${base("app")}/embed`);
    const embed = await tabAt(`${base("app")}/embed`);
    const frame = await until(() => embed.frames().find((f) => f.url().startsWith(`${base("rp")}/login`)), "the login frame");
    await frame.waitForFunction(() => typeof window.signin === "function");
    await frame.evaluate(() => (window.next = () => window.signin()));
    await frame.click("#go");
    const framed = await until(() => frame.evaluate(() => window.out), "the framed sign-in", 45000);
    assert(framed.ok && framed.crossOrigin === true && framed.instance, `signed in inside the frame: ${JSON.stringify(framed)}`);
    report.frame = framed;

    const trace = await app.evaluate(() => (globalThis.keySignInTrace ?? []).filter((t) => /passkey/.test(t.event)).map((t) => ({ event: t.event, host: t.host, origin: t.origin, reason: t.reason })));
    report.trace = trace.slice(-12);
    console.log(JSON.stringify({ ok: true, shots, ...report }, null, 2));
  } catch (error) {
    console.error(JSON.stringify((await app.evaluate(() => (globalThis.keySignInTrace ?? []).filter((t) => /passkey/.test(t.event))).catch(() => [])), null, 2));
    throw error;
  } finally {
    await app.close().catch(() => undefined);
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
