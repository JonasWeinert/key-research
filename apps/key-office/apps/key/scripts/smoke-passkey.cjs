// The passkey sign-in window, end to end against local mock sites and a mock sign-in service
// whose requests are one-time and bound to the cookies of the browser that made them (like
// Shibboleth's `execution=e1s1` and `ss:mem:` state, or an OAuth `state`): replayed in another
// browser they are stale. The service also ties its sign-in to the browser (user agent).
// A. a passkey request in a cross-site iframe covers the page with the card within a second;
//    Not now puts it aside (the bar keeps Stop waiting, which ends the request);
// B. app.localhost → (one-time hop) → gateway.localhost/idp/profile/…: the tab ARRIVES at the
//    sign-in service and is offered the sign-in window at once; Continue here is remembered; the
//    page asks for a passkey and the card offers the window again; the window starts on the
//    site's page (never the stale sign-in address), the real WebAuthn ceremony (Chrome headless,
//    virtual authenticator for the phone) completes there, the sign-in's cookies come over and
//    Key goes back to the site's page, signed in. No request is ever stale.
// C. the choice is listed in Settings › Web & browser › Sign-in;
// D. another site on the same sign-in service: the window opens by itself on arrival;
// E. a site whose session cookie cannot be brought over (partitioned): Key goes back, the site
//    sends it to the sign-in again, Key stops and says so, naming the cookie;
// F. Forget sign-ins removes Key's sign-in profile.
// Needs Google Chrome (or KEY_SIGNIN_CHROMIUM=<a Chromium program>). Never opens a window on
// screen and never touches a real browser profile: Chrome runs headless with a temp profile.
const { electron } = require("./lib/launch.cjs");
const { mkdtemp, mkdir, stat } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { createHash, randomBytes } = require("node:crypto");
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
const PASSKEY_PAGE = html(
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
    const next = await (await fetch("/idp/verify", { method: "POST", body: used.id })).text();
    location.href = next;
  } catch (e) {
    document.getElementById("state").textContent = "error: " + e.name;
  }
})();
</script>`,
);

const cookies = (req) => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]));
const id = () => randomBytes(6).toString("hex");
const uaTag = (req) => createHash("sha1").update(String(req.headers["user-agent"])).digest("hex").slice(0, 10);
const headless = (req) => /HeadlessChrome/.test(String(req.headers["user-agent"]));

async function serve() {
  let base;
  const log = { stale: [], served: [] };
  const flows = new Map(); // JSESSIONID → { request, service, used }
  const relays = new Map(); // relay id → used
  const stale = (req, res, what) => {
    log.stale.push({ what, by: headless(req) ? "window" : "key" });
    res.setHeader("content-type", "text/html");
    res.end(html("Stale Request", `<h1>Stale Request</h1><p>${what}</p>`));
  };
  const server = http.createServer((req, res) => {
    const host = (req.headers.host || "").split(":")[0];
    const url = new URL(req.url, `http://${req.headers.host}`);
    const jar = cookies(req);
    const page = (body, headers = {}) => (res.writeHead(200, { "content-type": "text/html", ...headers }), res.end(body));
    const go = (location, headers = {}) => (res.writeHead(302, { location, ...headers }), res.end());
    log.served.push(`${headless(req) ? "window" : "key"} ${host}${url.pathname}`);
    // Two ordinary services (app, app2): a page that sends you to your institution after a moment.
    if (host === "app.localhost" || host === "app2.localhost") {
      const service = host.split(".")[0];
      if (url.pathname === "/article") {
        if (jar.sp_session === "ok") return page(html("Article", `<h1 id="who">Signed in as student</h1>`));
        const relay = id();
        relays.set(relay, false);
        return page(html("Article", `<h1>Article</h1><p>Redirecting to your institution…</p><script>setTimeout(() => location.href = "/Shibboleth.sso/Login?target=" + encodeURIComponent("ss:mem:${relay}"), 1600)</script>`), {
          "set-cookie": `sp_relay=${relay}; Path=/; HttpOnly`,
        });
      }
      if (url.pathname === "/Shibboleth.sso/Login") {
        const relay = String(url.searchParams.get("target") || "").replace(/^ss:mem:/, "");
        if (jar.sp_relay !== relay || relays.get(relay) !== false) return stale(req, res, "service relay state");
        return go(`${base("gateway")}/idp/profile/SAML2/Redirect/SSO?SAMLRequest=${relay}&RelayState=${service}`);
      }
      if (url.pathname === "/Shibboleth.sso/SAML2/POST") {
        const relay = url.searchParams.get("relay");
        if (jar.sp_relay !== relay || relays.get(relay) !== false) return stale(req, res, "service response");
        relays.set(relay, true);
        return go("/article", { "set-cookie": "sp_session=ok; Path=/; HttpOnly; SameSite=Lax" });
      }
      if (url.pathname === "/embedded") return page(html("Embedded", `<h1>Journal</h1><iframe allow="publickey-credentials-get *" src="${base("gateway")}/widget" style="width:400px;height:200px"></iframe>`));
    }
    // A service whose session cookie is partitioned (it cannot be brought over).
    if (host === "strict.localhost") {
      if (url.pathname === "/home") {
        if (jar.strict_session === "ok") return page(html("Strict", `<h1 id="who">Signed in to strict</h1>`));
        const relay = id();
        relays.set(relay, false);
        return go(`${base("gateway")}/idp/profile/SAML2/Redirect/SSO?SAMLRequest=${relay}&RelayState=strict`, { "set-cookie": `strict_relay=${relay}; Path=/; HttpOnly` });
      }
      if (url.pathname === "/acs") {
        const relay = url.searchParams.get("relay");
        if (jar.strict_relay !== relay || relays.get(relay) !== false) return stale(req, res, "strict response");
        relays.set(relay, true);
        return go("/home", { "set-cookie": "strict_session=ok; Path=/; Secure; SameSite=None; Partitioned" });
      }
    }
    // More services on the same sign-in service, each ending its sign-in differently:
    // discovery → … → portal (a different host than the entry; "Stay signed in?" last, an
    // auto-POST, a meta refresh, background polling and a hidden sign-in frame on the landing page);
    // popup (the sign-in runs in a second window); kiosk (a visible sign-in frame on the landing
    // page); stuck (never finishes).
    if (host === "discovery.localhost" && url.pathname === "/find") return go(`${base("gateway")}/idp/profile/SAML2/Redirect/SSO?SAMLRequest=${id()}&RelayState=portal`);
    if (host === "portal.localhost") {
      if (url.pathname === "/acs" && req.method === "POST")
        return page(html("Signing in", `<p>Signing you in…</p><meta http-equiv="refresh" content="0.4;url=/home">`), { "set-cookie": "portal_session=ok; Path=/; HttpOnly; SameSite=Lax" });
      if (url.pathname === "/home") {
        if (jar.portal_session !== "ok") return go(`${base("discovery")}/find?inst=uni`);
        return page(
          html("Portal", `<h1 id="who">Signed in to the portal</h1><iframe src="${base("gateway")}/idp/profile/SAML2/Redirect/SSO?silent=1" style="width:0;height:0;border:0"></iframe>
            <script>setInterval(() => fetch("/ping").catch(() => {}), 300)</script>`),
        );
      }
      if (url.pathname === "/ping") return (res.writeHead(204), res.end());
    }
    if (host === "popup.localhost") {
      if (url.pathname === "/start") {
        if (jar.popup_session === "ok") return page(html("Popup app", `<h1 id="who">Signed in to the popup app</h1>`));
        const relay = id();
        relays.set(relay, false);
        return page(html("Popup app", `<p>Signing in in a popup…</p><script>setTimeout(() => window.open(${JSON.stringify(`${base("gateway")}/idp/profile/SAML2/Redirect/SSO?SAMLRequest=${relay}&RelayState=popup`)}, "signin", "popup,width=420,height=600"), 300)</script>`), {
          "set-cookie": `popup_relay=${relay}; Path=/; HttpOnly`,
        });
      }
      if (url.pathname === "/acs") {
        const relay = url.searchParams.get("relay");
        if (jar.popup_relay !== relay || relays.get(relay) !== false) return stale(req, res, "popup response");
        relays.set(relay, true);
        return page(html("Done", `<p>Done</p><script>if (opener) opener.location.href = "/start"; setTimeout(() => window.close(), 200)</script>`), { "set-cookie": "popup_session=ok; Path=/; HttpOnly; SameSite=Lax" });
      }
    }
    if (host === "kiosk.localhost") {
      if (url.pathname === "/start") return jar.kiosk_session === "ok" ? go("/home") : go(`${base("gateway")}/idp/profile/SAML2/Redirect/SSO?SAMLRequest=${id()}&RelayState=kiosk`);
      if (url.pathname === "/acs") return go("/home", { "set-cookie": "kiosk_session=ok; Path=/; HttpOnly; SameSite=Lax" });
      if (url.pathname === "/home")
        return page(html("Kiosk", `<h1 id="who">Signed in to the kiosk</h1><iframe src="${base("gateway")}/idp/profile/account" style="width:420px;height:260px"></iframe>`));
    }
    if (host === "stuck.localhost" && url.pathname === "/start") return go(`${base("gateway")}/idp/profile/SAML2/Redirect/SSO?SAMLRequest=${id()}&RelayState=stuck`);
    // The sign-in service: one-time requests bound to its JSESSIONID cookie, sessions bound to the browser.
    if (host === "gateway.localhost") {
      const acs = (service, relay) =>
        service === "strict" ? `${base("strict")}/acs?relay=${relay}`
        : service === "portal" ? `${base("gateway")}/idp/profile/kmsi?relay=${relay}`
        : service === "popup" ? `${base("popup")}/acs?relay=${relay}`
        : service === "kiosk" ? `${base("kiosk")}/acs?relay=${relay}`
        : service === "stuck" ? `${base("gateway")}/idp/profile/wait`
        : `${base(service)}/Shibboleth.sso/SAML2/POST?relay=${relay}&SAMLResponse=ok`;
      // "Stay signed in?": answered after a moment (as a person would), then an auto-POST to the site.
      if (url.pathname === "/idp/profile/kmsi")
        return page(html("Stay signed in?", `<h1>Stay signed in?</h1><button id="yes">Yes</button><script>setTimeout(() => location.href = "/idp/profile/post", 1200)</script>`));
      if (url.pathname === "/idp/profile/post")
        return page(html("Working…", `<form method="post" action="${base("portal")}/acs"><input type="hidden" name="SAMLResponse" value="ok"></form><script>document.forms[0].submit()</script>`));
      if (url.pathname === "/idp/profile/wait") return page(html("Please wait", `<p>Please wait…</p>`));
      if (url.pathname === "/idp/profile/account") return page(html("Account", `<p>Your account</p>`));
      if (url.pathname === "/idp/profile/SAML2/Redirect/SSO") {
        if (url.searchParams.get("silent")) return page(html("Silent", "ok"));
        if (url.searchParams.has("SAMLRequest")) {
          const request = url.searchParams.get("SAMLRequest");
          const service = url.searchParams.get("RelayState");
          if (jar.idp_session && jar.idp_session === uaTag(req)) return go(acs(service, request));
          const session = id();
          flows.set(session, { request, service, used: false });
          return go("/idp/profile/SAML2/Redirect/SSO?execution=e1s1", { "set-cookie": `JSESSIONID=${session}; Path=/idp; HttpOnly` });
        }
        const flow = flows.get(jar.JSESSIONID);
        if (url.searchParams.get("execution") !== "e1s1" || !flow || flow.used) return stale(req, res, "sign-in request (execution=e1s1)");
        return page(PASSKEY_PAGE);
      }
      if (url.pathname === "/idp/verify" && req.method === "POST") {
        const flow = flows.get(jar.JSESSIONID);
        if (!flow || flow.used) return (res.writeHead(400), res.end("stale"));
        flow.used = true;
        res.writeHead(200, { "content-type": "text/plain", "set-cookie": `idp_session=${uaTag(req)}; Path=/; HttpOnly; Max-Age=86400; SameSite=None; Secure` });
        return res.end(acs(flow.service, flow.request));
      }
      if (url.pathname === "/widget")
        return page(
          html("Widget", `<script>navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: location.hostname } }).then(() => "ok", (e) => e.name).then((r) => parent.postMessage("frame:" + r, "*"));</script>`),
        );
      if (url.pathname === "/pixel-from-tracker") return go(`${base("tracker")}/pixel`);
    }
    if (host === "tracker.localhost" && url.pathname === "/pixel") {
      res.writeHead(200, { "set-cookie": `track=${headless(req) ? "window" : "key"}; Path=/; SameSite=None; Secure`, "content-type": "image/gif" });
      return res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  base = (name) => `http://${name}.localhost:${port}`;
  return { server, base, log };
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-passkey-smoke-"));
  await mkdir(path.join(temp, "profile"));
  const shots = path.join(temp, "shots");
  await mkdir(shots);
  const { server, base, log } = await serve();
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
      KEY_SIGNIN_LOOP_MS: "1500",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
    },
  });
  if (process.env.KEY_SMOKE_VERBOSE) app.process().stderr.on("data", (d) => process.stderr.write(`[main] ${d}`));
  const report = {};
  const traceOf = () => app.evaluate(() => globalThis.keySignInTrace ?? []).catch(() => []);
  try {
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => window.key);
    const signin = async () => {
      const t = await shell.evaluate(() => window.key.tabs());
      return t.tabs.find((x) => x.id === t.activeTabId)?.views[0]?.web?.signin;
    };
    const open = (url) => shell.evaluate((url) => window.key.tabAction("open-url", { url }), url);
    const tabAt = (prefix) => until(() => app.windows().find((p) => p.url().startsWith(prefix)), `a tab at ${prefix}`);
    const signedIn = async (prefix, what) => {
      const page = await tabAt(prefix);
      await until(() => page.evaluate(() => document.getElementById("who")?.textContent).catch(() => ""), what, 30000);
    };
    const waitForWindow = async (what) =>
      until(async () => {
        const s = await signin();
        if (s?.card?.stage === "failed") throw Error(`${what}: ${s.card.problem}`);
        if (log.stale.some((x) => x.by === "window")) return { staleInWindow: true };
        return s?.imported || s?.card?.stage === "loop" ? s : undefined;
      }, what, 45000);

    // A. A passkey request inside a cross-site frame: the card covers the page.
    await open(`${base("app")}/embedded`);
    const embedded = await tabAt(`${base("app")}/embedded`);
    const result = embedded.evaluate(() => new Promise((r) => addEventListener("message", (e) => String(e.data).startsWith("frame:") && r(e.data))));
    const started = Date.now();
    const card = await until(async () => (await signin())?.card, "the card for a frame's passkey request", 10000);
    report.frameCardMs = Date.now() - started;
    assert(card.stage === "offer" && card.way === "window" && card.site === "gateway.localhost", `the card offers the sign-in window: ${JSON.stringify(card)}`);
    await shell.click(".kx-signin-card button:has-text('Not now')");
    await until(async () => (await signin())?.waiting, "the bar's notice after Not now");
    await shell.click(".key-web-signin[data-waiting] button:has-text('Stop waiting')");
    assert((await result) === "frame:NotAllowedError", "Stop waiting ends the frame's request");

    // B. Arrival at the sign-in service, Continue here, then the passkey: the window, from the site's page.
    await open(`${base("app")}/article`);
    const arrival = await until(async () => ((await signin())?.card?.stage === "arrival" ? (await signin()).card : undefined), "the card on arrival at the sign-in service", 8000).catch(() => undefined);
    report.arrival = arrival ? { host: arrival.host } : "missing";
    if (arrival) {
      assert(arrival.host === "gateway.localhost", `the arrival card names the sign-in service: ${JSON.stringify(arrival)}`);
      await shell.waitForSelector(".kx-signin-card-layer[data-stage=arrival]");
      await wait(300);
      await shell.screenshot({ path: path.join(shots, "1-arrival.png") });
      await shell.click(".kx-signin-card button:has-text('Continue here')");
    }
    await until(async () => (await signin())?.card?.stage === "offer", "the card when the page asks for a passkey", 10000);
    await shell.click(".kx-signin-card button[data-primary]");
    const back = await waitForWindow("the sign-in to come back");
    const trace = await traceOf();
    const entry = trace.filter((t) => t.event === "window-entry").at(-1);
    report.windowEntry = entry?.entry;
    // The failure the owner saw: the window replayed a one-time sign-in request.
    assert(!log.stale.some((s) => s.by === "window"), `no stale request in the sign-in window: ${JSON.stringify(log.stale)} (window started on ${entry?.entry ?? entry?.current})`);
    assert(arrival, "the tab is offered the sign-in window when it arrives at the sign-in service");
    assert(entry?.entry === `${base("app")}/article`, `the window starts on the site's page: ${JSON.stringify(entry)}`);
    assert(back.imported?.names?.includes("app.localhost") && back.imported.names.includes("gateway.localhost") && !back.imported.names.includes("tracker.localhost"), `brought over for the chain's sites: ${JSON.stringify(back)}`);
    await signedIn(`${base("app")}/article`, "the site's page signed in, in Key");
    const jar = await app.evaluate(async ({ session }) => (await session.fromPartition("persist:key-browser").cookies.get({})).map((c) => `${c.domain}:${c.name}=${c.value}`));
    assert(!jar.some((c) => c.includes("track=window")), `no cookie of a site outside the sign-in: ${jar}`);
    await shell.waitForSelector(".key-web-signin[data-imported]");
    await shell.screenshot({ path: path.join(shots, "2-signed-in.png") });
    const profile = path.join(temp, "profile", "Sign-in window", "chrome");
    assert(((await stat(profile)).mode & 0o777) === 0o700, "the sign-in profile is private");

    // C. Remembered: Continue here, then the window from the passkey card → the window.
    const info = await shell.evaluate(() => window.key.signInInfo());
    const remembered = info.hosts.find((h) => h.host === "gateway.localhost");
    assert(remembered?.choice === "window" && remembered.passkey && remembered.automatic, `the choice is remembered: ${JSON.stringify(info.hosts)}`);
    report.remembered = info.hosts;

    // D. Another site on the same sign-in service: the window opens by itself on arrival.
    const staleBefore = log.stale.length;
    await open(`${base("app2")}/article`);
    const auto = await until(async () => ((await signin())?.card?.stage === "open" ? (await signin()).card : undefined), "the window to open by itself", 10000);
    assert(auto.auto === true && auto.site === "app2.localhost", `it says so: ${JSON.stringify(auto)}`);
    await shell.waitForSelector(".kx-signin-card-layer[data-stage=open]");
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "3-auto.png") });
    await waitForWindow("the automatic sign-in to come back");
    await signedIn(`${base("app2")}/article`, "app2 signed in, in Key");
    assert(log.stale.length === staleBefore, `no stale request: ${JSON.stringify(log.stale)}`);

    // E. A site that does not take the brought-over sign-in: Key stops and says so.
    await open(`${base("strict")}/home`);
    const loop = await waitForWindow("the loop to be noticed");
    assert(loop.card?.stage === "loop" && loop.card.failed?.some((f) => /strict_session \(partitioned\)/.test(f)), `the loop card names what could not come over: ${JSON.stringify(loop)}`);
    await shell.waitForSelector(".kx-signin-card-layer[data-stage=loop]");
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "4-loop.png") });
    report.loop = loop.card.failed;
    await shell.click(".kx-signin-card button:has-text('Not now')");

    const traceSince = async (from) => (await traceOf()).slice(from);
    const completeReason = (lines) => lines.filter((t) => t.event === "window-complete").map((t) => t.reason).at(-1);

    // G. Ends on another host than the entry, after "Stay signed in?", an auto-POST and a meta
    //    refresh, on a page that polls and carries a hidden sign-in frame.
    let mark = (await traceOf()).length;
    await open(`${base("discovery")}/find?inst=uni`);
    const portal = await waitForWindow("the portal sign-in to come back");
    assert(portal.imported?.names?.includes("portal.localhost"), `the portal's sign-in came back: ${JSON.stringify(portal)}`);
    await signedIn(`${base("portal")}/home`, "the portal page signed in, in Key (the window's landing page)");
    report.portal = completeReason(await traceSince(mark));

    // H. The sign-in runs in a second window (a popup) and the first page lands signed in.
    mark = (await traceOf()).length;
    await open(`${base("popup")}/start`);
    const popup = await waitForWindow("the popup sign-in to come back");
    assert(popup.imported?.names?.includes("popup.localhost"), `the popup app's sign-in came back: ${JSON.stringify(popup)}`);
    await signedIn(`${base("popup")}/start`, "the popup app signed in, in Key");
    report.popup = completeReason(await traceSince(mark));

    // I. A visible sign-in frame on the landing page: Return to Key (the bar in the window) ends it.
    mark = (await traceOf()).length;
    await app.evaluate(() => (globalThis.keySignInClickBar = true));
    await open(`${base("kiosk")}/start`);
    await waitForWindow("the kiosk sign-in to come back");
    await signedIn(`${base("kiosk")}/home`, "the kiosk signed in, in Key");
    const kioskTrace = await traceSince(mark);
    assert(kioskTrace.some((t) => t.event === "window-bar") && kioskTrace.some((t) => t.event === "window-bar-clicked"), `the bar was shown and used: ${JSON.stringify(kioskTrace.filter((t) => /bar|complete|check/.test(t.event)))}`);
    report.kiosk = completeReason(kioskTrace);

    // J. A second attempt while the first window is still open reuses it (one process).
    mark = (await traceOf()).length;
    await open(`${base("stuck")}/start`);
    await until(async () => (await signin())?.card?.stage === "open", "the stuck sign-in window", 15000);
    await wait(1500);
    await app.evaluate(async ({ session }) => {
      const ses = session.fromPartition("persist:key-browser");
      for (const c of await ses.cookies.get({})) if (/app\.localhost|gateway\.localhost/.test(c.domain ?? "")) await ses.cookies.remove(`http://${c.domain.replace(/^\./, "")}${c.path}`, c.name);
    });
    await open(`${base("app")}/article`);
    await waitForWindow("the second attempt to come back");
    await signedIn(`${base("app")}/article`, "the article signed in again, in Key");
    const reuse = await traceSince(mark);
    assert(reuse.filter((t) => t.event === "window-start").length === 1 && reuse.some((t) => t.event === "window-reuse"), `one browser process, reused: ${JSON.stringify(reuse.filter((t) => /window-(start|reuse)/.test(t.event)))}`);
    const firsts = reuse.filter((t) => t.event === "window-first");
    assert(firsts.length >= 2 && firsts.every((t) => t.entry === true), `the window only ever opened on the entry: ${JSON.stringify(firsts)}`);

    // K. A second attempt after the first browser process was killed: a fresh one, on the entry.
    mark = (await traceOf()).length;
    await open(`${base("stuck")}/start`);
    await until(async () => (await signin())?.card?.stage === "open", "the stuck sign-in window again", 15000);
    const first = await until(async () => (await traceSince(mark)).find((t) => t.event === "window-start"), "the window process");
    await wait(1000);
    process.kill(first.pid, "SIGKILL");
    await until(async () => (await signin())?.card?.stage === "failed", "the card to say the window closed", 15000);
    await shell.click(".kx-signin-card button[data-primary]");
    await until(async () => (await signin())?.card?.stage === "open", "the window to open again", 15000);
    const again = await until(async () => {
      const lines = await traceSince(mark);
      return lines.filter((t) => t.event === "window-first").length >= 2 ? lines : undefined;
    }, "the new window's first page", 20000);
    const starts = again.filter((t) => t.event === "window-start");
    assert(starts.length === 2 && starts[1].pid !== first.pid, `a new process: ${JSON.stringify(starts)}`);
    assert(again.filter((t) => t.event === "window-first").every((t) => t.entry === true), "the new window opened on the entry");
    report.retryAfterKill = again.filter((t) => t.event === "window-entry").map((t) => ({ entry: t.entry, retry: t.retry }));
    await shell.click(".kx-signin-card button:has-text('Cancel')");

    // L. The browser program cannot be driven (no DevTools pipe): a plain error, no window left.
    await app.evaluate(() => (globalThis.keySignInChromium = "/usr/bin/false"));
    await open(`${base("stuck")}/start`);
    const broken = await until(async () => ((await signin())?.card?.stage === "failed" ? (await signin()).card : undefined), "the card to say the window could not open", 30000);
    assert(/could not open the sign-in window/.test(broken.problem), `it says so: ${JSON.stringify(broken)}`);
    await shell.waitForSelector(".kx-signin-card-layer[data-stage=failed]");
    await wait(300);
    await shell.screenshot({ path: path.join(shots, "6-failed.png") });
    await app.evaluate(() => (globalThis.keySignInChromium = undefined));
    await shell.click(".kx-signin-card button:has-text('Not now')");

    // F. Settings: the remembered service is listed; Forget sign-ins removes the profile.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
    const settings = await until(async () => {
      for (const w of app.windows()) if (await w.locator(".kx-settings-nav button[data-section=web]").count().catch(() => 0)) return w;
    }, "Key Settings");
    await settings.locator(".kx-settings-nav button[data-section=web]").click();
    const group = settings.locator(".kx-settings-group", { has: settings.locator("h3", { hasText: "Sign-in" }) });
    await group.waitFor();
    await group.scrollIntoViewIfNeeded();
    await group.locator("text=gateway.localhost").waitFor();
    await group.screenshot({ path: path.join(shots, "5-settings.png") });
    const forget = group.locator("button", { hasText: "Forget sign-ins" });
    await forget.click();
    await forget.click();
    await until(() => !existsSync(profile), "the sign-in profile to be removed");
    report.traceSample = (await traceOf()).filter((t) => t.event === "window-entry").map((t) => ({ entry: t.entry, current: t.current }));
    console.log(JSON.stringify({ ok: true, shots, ...report }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ stale: log.stale, trace: (await traceOf()).filter((t) => /window|loop|cookies|returned/.test(t.event)) }, null, 2));
    throw error;
  } finally {
    await app.close().catch(() => undefined);
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
