// The sign-in window: a passkey sign-in Key's browser cannot do (the QR code for a phone,
// iCloud Keychain or a password manager's passkeys) is finished in a small window of a
// Chromium browser already on this Mac (Chrome, Edge, Brave…), which has the passkey dialogs
// Electron lacks. It is the browser's own program but never the person's own profile: Key gives
// it a profile folder of its own (0700, in Key's data folder) and drives it over a DevTools pipe
// (no port, so no other process can reach it). Key watches where the window goes; once it has
// been through the sign-in pages and lands back on a site, Key reads that profile's cookies for
// just the sites of this sign-in, copies them into its browser, closes the window and reloads
// the page. Nothing here reads, types or keeps a password, and nothing leaves the Mac.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readlink, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CdpPipe } from "./cdp-pipe";
import { isIdentityUrl } from "./sign-in-entry";

export type ChromiumId = "chrome" | "edge" | "brave" | "chromium" | "vivaldi";
export interface ChromiumApp {
  id: ChromiumId;
  name: string;
  /** The program inside the app bundle. */
  executable: string;
}
/** Chromium browsers whose command line Key can rely on, in the order Key prefers them. Arc is
 * left out: it ignores --user-data-dir and --app. */
const CHROMIUM_APPS: Array<{ id: ChromiumId; name: string; bundle: string }> = [
  { id: "chrome", name: "Google Chrome", bundle: "com.google.Chrome" },
  { id: "edge", name: "Microsoft Edge", bundle: "com.microsoft.edgemac" },
  { id: "brave", name: "Brave", bundle: "com.brave.Browser" },
  { id: "vivaldi", name: "Vivaldi", bundle: "com.vivaldi.Vivaldi" },
  { id: "chromium", name: "Chromium", bundle: "org.chromium.Chromium" },
];

export { isIdentityHost } from "./sign-in-entry";

const run = (file: string, args: string[]) =>
  new Promise<string>((done) => execFile(file, args, { timeout: 5000 }, (error, stdout) => done(error ? "" : String(stdout))));

let found: { at: number; apps: ChromiumApp[] } | undefined;
/** The Chromium browsers installed on this Mac (by bundle id, wherever they are). */
export async function chromiumApps(env: NodeJS.ProcessEnv = process.env): Promise<ChromiumApp[]> {
  // Smokes point Key at a browser program, or at none.
  // (A smoke may swap the program mid-run: globalThis.keySignInChromium.)
  const forced = (env.KEY_BROWSER_SMOKE && (globalThis as { keySignInChromium?: string }).keySignInChromium) || env.KEY_SIGNIN_CHROMIUM;
  if (forced) return forced === "none" ? [] : [{ id: "chrome", name: env.KEY_SIGNIN_CHROMIUM_NAME || "Google Chrome", executable: forced }];
  if (process.platform !== "darwin") return [];
  if (found && Date.now() - found.at < 60_000) return found.apps;
  const apps: ChromiumApp[] = [];
  for (const known of CHROMIUM_APPS) {
    const listed = (await run("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == "${known.bundle}"`])).split("\n").filter((p) => p.endsWith(".app"));
    const candidates = [...new Set([...listed, `/Applications/${known.name}.app`, join(process.env.HOME ?? "", "Applications", `${known.name}.app`)])]
      // Apps in the Trash, in another app or a disk image are not the installed one.
      .filter((p) => !/\/\.Trash\/|\.app\/.+\.app$|^\/Volumes\//.test(p))
      .sort((a, b) => Number(!a.startsWith("/Applications/")) - Number(!b.startsWith("/Applications/")));
    for (const bundle of candidates) {
      const plist = join(bundle, "Contents", "Info.plist");
      if ((await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist])).trim() !== known.bundle) continue;
      const name = (await run("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", plist])).trim();
      const executable = name && join(bundle, "Contents", "MacOS", name);
      if (executable && (await stat(executable).then((s) => s.isFile(), () => false))) {
        apps.push({ id: known.id, name: known.name, executable });
        break;
      }
    }
  }
  found = { at: Date.now(), apps };
  return apps;
}

/** A cookie as the DevTools protocol gives it. */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since 1970; -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: unknown;
}

/** Whether a cookie is sent to one of these hosts (a `.domain` cookie to its subdomains too). */
export function cookieMatches(domain: string, hosts: Iterable<string>) {
  const bare = domain.replace(/^\./, "").toLowerCase();
  const wide = domain.startsWith(".");
  for (const host of hosts) if (host === bare || (wide && host.endsWith(`.${bare}`))) return true;
  return false;
}
/** The cookies a sign-in over these hosts set: only those those hosts receive, and none kept
 * for one site inside another (partitioned). */
export function signInCookies(cookies: CdpCookie[], hosts: Iterable<string>) {
  const list = [...hosts].map((h) => h.toLowerCase());
  return cookies.filter((c) => c.name && !c.partitionKey && cookieMatches(c.domain, list));
}
/** The sites a set of cookies belongs to, for saying what was brought over. */
export function cookieSites(cookies: CdpCookie[]) {
  return [...new Set(cookies.map((c) => c.domain.replace(/^\./, "").toLowerCase()))].sort();
}
const SAME_SITE = { Strict: "strict", Lax: "lax", None: "no_restriction" } as const;
/** The cookie as Electron's `cookies.set` takes it. */
export function electronCookie(cookie: CdpCookie): Electron.CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, "");
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : {}),
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite ? SAME_SITE[cookie.sameSite] : "unspecified",
    ...(cookie.expires > 0 && !cookie.session ? { expirationDate: cookie.expires } : {}),
  };
}

/** How the window ended. `byPerson`: the person closed it (Key then tries with what it has). */
export type WindowEnd = { kind: "signed-in"; url?: string; reason?: string } | { kind: "closed"; byPerson?: boolean } | { kind: "failed"; problem: string };
export interface SignInWindowOptions {
  app: ChromiumApp;
  /** Key's own profile folder for this browser. */
  profileDir: string;
  url: string;
  /** Hosts that are sign-in pages (besides the usual sign-in services). */
  identityHosts?: Iterable<string>;
  /** Key's window, to put the sign-in window over its middle. */
  near?: { x: number; y: number; width: number; height: number };
  /** Test mode: no window on screen, and a virtual authenticator answers passkey requests. */
  headless?: boolean;
  virtualAuthenticator?: boolean;
  /** How long a site's page must stay before the sign-in counts as finished. */
  settleMs?: number;
  /** A window kept open to use a site in (it never ends by itself on a site's page). */
  keep?: boolean;
  /** What the window does, for a debug trace (addresses redacted by the listener). */
  onTrace?(event: string, detail: Record<string, unknown>): void;
}

/** After the sign-in pages, a site's page that has been shown this long ends the sign-in even
 * if it still loads or shows a sign-in frame. */
const FALLBACK_MS = 5000;
/** The bar Key puts at the top of a site's page in the window once the sign-in looks finished
 * (an isolated world: the page cannot see or change it; never on a sign-in page). */
const BAR = `(() => {
  if (document.getElementById("key-signin-bar")) return "there";
  const host = document.createElement("div");
  host.id = "key-signin-bar";
  host.style.cssText = "all:initial;position:fixed;inset:0 0 auto 0;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = \`<style>
    .bar{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#0a5cd5;color:#fff;font:13px/1.3 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;box-shadow:0 1px 8px rgba(0,0,0,.25)}
    .mark{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;background:rgba(255,255,255,.18);font-weight:700}
    .text{flex:1}
    button{border:0;border-radius:7px;padding:6px 12px;background:#fff;color:#0a5cd5;font:600 13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;cursor:pointer}
  </style><div class="bar" role="region" aria-label="Key"><span class="mark">K</span><span class="text"><b>Key</b> · Signed in? Key brings this sign-in back to its own browser.</span><button type="button">Return to Key</button></div>\`;
  root.querySelector("button").addEventListener("click", () => keySignInDone("done"));
  (document.body || document.documentElement).appendChild(host);
  window.__keySignInBar = root;
  return "shown";
})()`;

interface PageState {
  url: string;
  /** When the page got this address. */
  since: number;
  sessionId?: string;
  /** The address the bar was put on. */
  barUrl?: string;
}

/** One open sign-in window. `ended` resolves once it is signed in, closed or failed. It
 * follows every page of this browser instance (popups and new tabs too): the sign-in is done
 * once the newest page has been on a site, not a sign-in service, for a moment after the
 * sign-in pages, has loaded and shows no sign-in frame (or for FALLBACK_MS in any case). */
export class SignInWindow {
  /** Hosts of every page and frame the window loaded (redirects included). */
  readonly hosts = new Set<string>();
  visitedSignIn = false;
  lastUrl = "";
  ended: Promise<WindowEnd>;
  /** Which attempt this is (a window is reused for the next sign-in). */
  attempt = 1;
  private end!: (end: WindowEnd) => void;
  private done = false;
  private started = false;
  private pipe!: CdpPipe;
  private child!: ChildProcess;
  private mainTarget = "";
  private mainSession = "";
  private pages = new Map<string, PageState>();
  /** Page sessions → their target. */
  private sessions = new Map<string, string>();
  private poll?: ReturnType<typeof setInterval>;
  private checking = false;
  private reason = "";
  /** Hosts that served a sign-in page in this attempt. */
  private readonly learned = new Set<string>();
  private entry = "";
  private firstRequest?: string;
  private identity: (url: string) => boolean;
  /** A window kept to use a site in: it never ends by itself. */
  private keep = false;

  private constructor(private readonly options: SignInWindowOptions) {
    this.ended = new Promise((resolve) => (this.end = resolve));
    const extra = new Set([...(options.identityHosts ?? [])].map((h) => h.toLowerCase()));
    this.identity = (url) => isIdentityUrl(url, [...extra, ...this.learned]);
    this.keep = !!options.keep;
  }

  static async open(options: SignInWindowOptions) {
    const window = new SignInWindow(options);
    await window.launch();
    return window;
  }

  private trace(event: string, detail: Record<string, unknown> = {}) {
    this.options.onTrace?.(event, detail);
  }

  private finish(end: WindowEnd) {
    if (this.done) return;
    this.done = true;
    clearInterval(this.poll);
    this.end(end);
  }

  private async launch() {
    const { profileDir, app, near, headless } = this.options;
    await mkdir(dirname(profileDir), { recursive: true, mode: 0o700 });
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await chmod(dirname(profileDir), 0o700).catch(() => undefined);
    await chmod(profileDir, 0o700);
    const width = 500,
      height = 700;
    const x = near ? Math.round(near.x + (near.width - width) / 2) : undefined;
    const y = near ? Math.round(near.y + Math.max(40, (near.height - height) / 2)) : undefined;
    // Never a second browser process on Key's profile (it would hand its window to the first,
    // which Key may no longer control): a leftover one using this profile is ended first.
    await endStaleInstance(profileDir, (detail) => this.trace("window-stale", detail));
    const args = [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-pipe",
      // No welcome, default-browser, search-engine-choice or restore-pages screens.
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      "--hide-crash-restore-bubble",
      "--disable-default-apps",
      `--window-size=${width},${height}`,
      ...(x !== undefined && y !== undefined ? [`--window-position=${x},${y}`] : []),
      // Test mode never draws a window and never asks the login keychain; its mock sites open
      // their sign-in popups without a click.
      ...(headless ? ["--headless=new", "--use-mock-keychain", ...(this.options.virtualAuthenticator ? ["--disable-popup-blocking"] : []), "about:blank"] : ["--app=about:blank"]),
    ];
    this.child = spawn(app.executable, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    this.trace("window-start", { pid: this.child.pid, kind: headless ? "headless" : "app window" });
    this.pipe = new CdpPipe(this.child.stdio[3] as Writable, this.child.stdio[4] as Readable);
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.once("error", () => undefined);
    void exited.then(() => {
      this.pipe.close();
      this.finish({ kind: "closed" });
    });
    try {
      await this.pipe.send("Browser.getVersion", {}, undefined, Number(process.env.KEY_SIGNIN_LAUNCH_MS) || 20_000);
    } catch {
      this.kill();
      // Most often: this profile is already open in another window of the browser.
      throw Error(`${app.name} could not open the sign-in window. If one is still open, close it and try again.`);
    }
    this.pipe.on((method, params, sessionId) => void this.event(method, params, sessionId));
    await this.pipe.send("Target.setDiscoverTargets", { discover: true });
    // New pages (popups, tabs) are held until Key watches them, so no step of theirs is missed.
    await this.pipe.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => undefined);
    const page = await this.waitForPage();
    this.mainTarget = page;
    this.mainSession = await this.attachPage(page);
    this.started = true;
    await this.go(this.options.url);
  }

  /** Shows `url` (the entry) in the window's page: the only address it ever opens on. */
  private async go(url: string) {
    this.entry = url;
    this.firstRequest = undefined;
    try {
      await this.pipe.send("Page.navigate", { url }, this.mainSession);
    } catch (error) {
      await this.close();
      throw Error(`The sign-in window could not open ${siteOf(url)}: ${(error as Error).message}`);
    }
    clearInterval(this.poll);
    this.poll = setInterval(() => void this.check(), 400);
  }

  /** A new sign-in in the same window (one window per profile): on its own entry page. */
  async restart(url: string, identityHosts: Iterable<string> = []) {
    this.finish({ kind: "closed" });
    this.attempt++;
    this.done = false;
    this.keep = false;
    this.ended = new Promise((resolve) => (this.end = resolve));
    this.visitedSignIn = false;
    this.hosts.clear();
    this.reason = "";
    this.lastUrl = "";
    const extra = new Set([...identityHosts].map((h) => h.toLowerCase()));
    this.learned.clear();
    this.identity = (u) => isIdentityUrl(u, [...extra, ...this.learned]);
    // The person may have closed the window while the browser kept running: a new one.
    if (!this.pages.has(this.mainTarget)) {
      const { targetId } = await this.pipe.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true });
      this.mainTarget = targetId;
      this.mainSession = await this.attachPage(targetId);
    }
    for (const page of this.pages.values()) page.since = 0;
    await this.go(url);
  }

  /** The browser process is alive and Key still controls it. */
  get running() {
    return !this.pipe.closed && this.child.exitCode === null && this.child.signalCode === null;
  }
  get pid() {
    return this.child.pid;
  }

  /** The window Key asked for (`--app=about:blank`); any other page a profile restored or a
   * start page is closed, so nothing but the entry ever shows. */
  private async waitForPage() {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const { targetInfos } = await this.pipe.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>("Target.getTargets");
      const pages = targetInfos.filter((t) => t.type === "page");
      const blank = pages.find((t) => t.url === "about:blank" || t.url === "");
      if (blank) {
        for (const other of pages) if (other !== blank) await this.pipe.send("Target.closeTarget", { targetId: other.targetId }).catch(() => undefined);
        return blank.targetId;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw Error("The sign-in window did not open");
  }

  private page(targetId: string) {
    let page = this.pages.get(targetId);
    if (!page) this.pages.set(targetId, (page = { url: "", since: Date.now() }));
    return page;
  }

  /** Follows a page of the window (the first one, popups, new tabs). */
  private async attachPage(targetId: string) {
    const page = this.page(targetId);
    if (page.sessionId) return page.sessionId;
    const { sessionId } = await this.pipe.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    page.sessionId = sessionId;
    this.sessions.set(sessionId, targetId);
    await this.watch(sessionId, true);
    return sessionId;
  }
  /** Watches a page or frame: its document requests (redirects too) and navigations. */
  private async watch(sessionId: string, isPage = false) {
    const send = (method: string, params: Record<string, unknown> = {}) => this.pipe.send(method, params, sessionId).catch(() => undefined);
    await send("Network.enable");
    await send("Page.enable");
    if (isPage) {
      await send("Runtime.enable");
      await send("Runtime.addBinding", { name: "keySignInDone", executionContextName: "key-signin" });
    }
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    if (this.options.virtualAuthenticator) {
      await send("WebAuthn.enable", { enableUI: false });
      await send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
      });
    }
  }

  /** Notes an address the window loaded: its host, and whether it is a sign-in page. */
  private note(url: string, kind: string) {
    let host: string;
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return undefined;
      host = u.hostname.toLowerCase();
    } catch {
      return undefined;
    }
    this.hosts.add(host);
    const signIn = this.identity(url);
    if (signIn) {
      this.visitedSignIn = true;
      // The rest of that host is the sign-in service too ("Stay signed in?", consent pages),
      // unless it is the site the sign-in started on.
      if (host !== siteOf(this.entry)) this.learned.add(host);
    }
    this.trace("window-hop", { kind, url, host, signIn });
    return host;
  }

  /** A page of the window has a new address. */
  private moved(targetId: string, url: string, kind: string) {
    const page = this.page(targetId);
    if (page.url === url) return;
    page.url = url;
    page.since = Date.now();
    page.barUrl = undefined;
    this.note(url, kind);
    void this.check();
  }

  /** Says (once per change) why the sign-in is or is not finished yet. */
  private decide(reason: string) {
    if (reason === this.reason) return;
    this.reason = reason;
    this.trace("window-check", { reason });
  }

  /** Whether the sign-in is finished: see the class comment. */
  private async check() {
    if (this.done || !this.started || this.keep || this.checking) return;
    const pages = [...this.pages.entries()].filter(([, p]) => /^https?:/i.test(p.url)).sort((a, b) => b[1].since - a[1].since);
    if (!pages.length) return this.decide("no page yet");
    const [targetId, latest] = pages[0];
    this.lastUrl = latest.url;
    if (this.identity(latest.url)) return this.decide("on a sign-in page");
    if (!this.visitedSignIn) return this.decide("no sign-in page yet");
    void this.showBar(targetId, latest);
    const stable = Date.now() - latest.since;
    if (stable < (this.options.settleMs ?? (Number(process.env.KEY_SIGNIN_SETTLE_MS) || 1500))) return this.decide("on a site's page, settling");
    this.checking = true;
    let state: { ready?: string; frames?: Array<{ src: string; visible: boolean }> } = {};
    try {
      const answer = await this.pipe.send<{ result?: { value?: typeof state } }>(
        "Runtime.evaluate",
        {
          expression: `({ ready: document.readyState, frames: [...document.querySelectorAll("iframe")].map((f) => { const r = f.getBoundingClientRect(), s = getComputedStyle(f); return { src: f.src, visible: r.width >= 60 && r.height >= 60 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.1 }; }) })`,
          returnByValue: true,
        },
        latest.sessionId,
        3000,
      );
      state = answer.result?.value ?? {};
    } catch {
      /* the page is navigating */
    } finally {
      this.checking = false;
    }
    if (this.done || this.pages.get(targetId) !== latest || latest.url !== this.lastUrl) return;
    const signInFrame = (state.frames ?? []).some((f) => f.visible && this.identity(f.src));
    if (state.ready === "complete" && !signInFrame) return this.complete("on a site's page, loaded, no sign-in frame", latest.url);
    if (stable >= FALLBACK_MS) return this.complete(`on a site's page for ${Math.round(stable / 1000)} s`, latest.url);
    this.decide(signInFrame ? "a sign-in frame shows on the site's page" : "the site's page is still loading");
  }

  private complete(reason: string, url?: string) {
    this.trace("window-complete", { reason });
    this.finish({ kind: "signed-in", url, reason });
  }

  /** The "Return to Key" bar on the site's page (isolated world; never on a sign-in page). */
  private async showBar(targetId: string, page: PageState) {
    if (!page.sessionId || page.barUrl === page.url) return;
    page.barUrl = page.url;
    const sessionId = page.sessionId;
    try {
      const { executionContextId } = await this.pipe.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: targetId, worldName: "key-signin", grantUniveralAccess: false }, sessionId);
      await this.pipe.send("Runtime.evaluate", { expression: BAR, contextId: executionContextId }, sessionId);
      this.trace("window-bar", {});
      // Smokes press the bar's button as a person would.
      const store = globalThis as unknown as { keySignInClickBar?: boolean };
      if (process.env.KEY_BROWSER_SMOKE && store.keySignInClickBar) {
        store.keySignInClickBar = false;
        setTimeout(() => void this.pipe.send("Runtime.evaluate", { expression: `window.__keySignInBar.querySelector("button").click()`, contextId: executionContextId }, sessionId).catch(() => undefined), 300);
      }
    } catch {
      page.barUrl = undefined;
    }
  }

  private async event(method: string, params: Record<string, any>, sessionId?: string) {
    const info = params.targetInfo as { targetId: string; type: string; url: string } | undefined;
    if ((method === "Target.targetCreated" || method === "Target.targetInfoChanged") && info?.type === "page") {
      // Every page of this browser instance: the window, and popups or tabs it opens.
      if (!this.pages.get(info.targetId)?.sessionId && info.targetId !== this.mainTarget && this.started) void this.attachPage(info.targetId).catch(() => undefined);
      if (info.url && /^https?:/i.test(info.url)) this.moved(info.targetId, info.url, "page");
      return;
    }
    if (method === "Target.targetDestroyed" && this.pages.has(params.targetId)) {
      this.pages.delete(params.targetId);
      // The person closed the window (the browser itself keeps running on macOS).
      if (this.started && !this.pages.size) {
        this.trace("window-closed", {});
        this.finish({ kind: "closed", byPerson: true });
      } else void this.check();
      return;
    }
    if (method === "Target.attachedToTarget" && params.sessionId) {
      // Frames from other sites (and pages, when the browser attaches them itself).
      if (params.targetInfo?.type === "page") {
        const page = this.page(params.targetInfo.targetId);
        page.sessionId ??= params.sessionId;
        this.sessions.set(params.sessionId, params.targetInfo.targetId);
        await this.watch(params.sessionId, true);
      } else await this.watch(params.sessionId);
      if (params.waitingForDebugger) await this.pipe.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => undefined);
      return;
    }
    if (method === "Target.detachedFromTarget" && this.sessions.has(params.sessionId)) {
      const page = this.pages.get(this.sessions.get(params.sessionId)!);
      if (page && page.sessionId === params.sessionId) page.sessionId = undefined;
      this.sessions.delete(params.sessionId);
      return;
    }
    if (method === "Runtime.bindingCalled" && params.name === "keySignInDone") {
      this.trace("window-bar-clicked", {});
      return this.signedInNow("the person chose Return to Key");
    }
    if (method === "Network.requestWillBeSent" && params.type === "Document") {
      const url = String(params.request?.url ?? "");
      // The window's first page must be the entry Key chose (checked in the trace).
      if (this.firstRequest === undefined && sessionId === this.mainSession && params.frameId === this.mainTarget && !params.redirectResponse) {
        this.firstRequest = url;
        this.trace("window-first", { url, entry: url === this.entry });
      }
      this.note(url, params.redirectResponse ? "redirect" : "request");
      return;
    }
    if (method === "Page.frameNavigated" && sessionId && this.sessions.has(sessionId) && !params.frame?.parentId) {
      this.moved(this.sessions.get(sessionId)!, String(params.frame?.url ?? ""), "shown");
    }
  }

  /** The window's cookies for these hosts. */
  async cookies(hosts: Iterable<string>) {
    const { cookies } = await this.pipe.send<{ cookies: CdpCookie[] }>("Storage.getCookies");
    const list = [...hosts].map((h) => h.toLowerCase());
    const all = (cookies ?? []).filter((c) => c.name && cookieMatches(c.domain, list));
    // Partitioned cookies (kept for one site inside another) have no equivalent Key can set.
    return { cookies: signInCookies(all, list), partitioned: all.filter((c) => c.partitionKey) };
  }

  /** Brings the window to the front: restores it if it was minimised, makes it the browser's
   * front window, then activates this browser process (by its pid, never the person's own
   * instance of the same browser). */
  async focus() {
    if (this.options.headless) return;
    const target = [...this.pages.entries()].sort((a, b) => b[1].since - a[1].since)[0]?.[0] ?? this.mainTarget;
    const { windowId } = await this.pipe.send<{ windowId?: number }>("Browser.getWindowForTarget", { targetId: target }).catch(() => ({ windowId: undefined }));
    if (windowId !== undefined) await this.pipe.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => undefined);
    await this.pipe.send("Target.activateTarget", { targetId: target }).catch(() => undefined);
    if (process.platform === "darwin" && this.child.pid) await activateProcess(this.child.pid);
  }

  /** The person says they are done: decide now, with the newest site page if there is one. */
  signedInNow(reason = "the person chose I’m signed in") {
    const site = [...this.pages.values()].filter((p) => /^https?:/i.test(p.url) && !this.identity(p.url)).sort((a, b) => b.since - a.since)[0];
    this.complete(reason, site?.url);
  }

  /** Quits this browser instance (only the one Key started). */
  async close() {
    this.finish({ kind: "closed" });
    if (this.child.exitCode !== null) return;
    await this.pipe.send("Browser.close", {}, undefined, 3000).catch(() => undefined);
    const exited = new Promise<boolean>((resolve) => {
      if (this.child.exitCode !== null) return resolve(true);
      this.child.once("exit", () => resolve(true));
      setTimeout(() => resolve(false), 4000);
    });
    if (!(await exited)) this.kill();
  }
  private kill() {
    try {
      this.child.kill();
    } catch {
      /* gone */
    }
  }
  get open() {
    return !this.done;
  }
}

/** Activates an app by process id (AppKit through JXA: no Apple events, so no permission
 * prompt). macOS may decline an activation another app asks for; then, if this is the only
 * running copy of that browser, `open -a` (Launch Services) brings it forward instead. */
const ACTIVATE = `ObjC.import("AppKit");
function run(argv) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  if (!app || app.isNil()) return "gone";
  app.unhide;
  app.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps);
  delay(0.35);
  if (app.active) return "active";
  const copies = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(app.bundleIdentifier);
  return copies.count === 1 ? "open:" + ObjC.unwrap(app.bundleURL.path) : "inactive";
}`;
export async function activateProcess(pid: number) {
  const answer = (await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", ACTIVATE, String(pid)])).trim();
  if (answer.startsWith("open:")) await run("/usr/bin/open", ["-a", answer.slice(5)]);
  return answer;
}

const siteOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "the site";
  }
};

/** The process a Chromium profile's lock names (`SingletonLock` → "host-pid"), if any. */
export function lockPid(target: string) {
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

/** Ends a browser left running on Key's profile (Key lost its pipe: Key restarted or crashed),
 * and clears the profile's stale lock. Only a process whose command line names this very
 * profile folder is ended: never the person's own browser. */
export async function endStaleInstance(profileDir: string, note: (detail: Record<string, unknown>) => void = () => undefined) {
  const lock = join(profileDir, "SingletonLock");
  const target = await readlink(lock).catch(() => "");
  if (!target) return;
  const pid = lockPid(target);
  const command = pid ? (await run("/bin/ps", ["-o", "command=", "-p", String(pid)])).trim() : "";
  if (pid && command.includes(`--user-data-dir=${profileDir}`)) {
    note({ reason: "a browser is still running on Key's sign-in profile: ending it" });
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
    for (let i = 0; i < 30 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    if (alive())
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  } else note({ reason: "the sign-in profile's lock was stale" });
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) await rm(join(profileDir, name), { force: true }).catch(() => undefined);
}

/** Removes Key's sign-in profiles (every browser's). */
export async function forgetSignInProfiles(root: string) {
  await rm(root, { recursive: true, force: true });
}
