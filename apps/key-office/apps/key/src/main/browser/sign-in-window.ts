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
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CdpPipe } from "./cdp-pipe";

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

/** Sign-in services and the usual names of a university's own sign-in pages. */
const IDENTITY_HOST =
  /(^|\.)(login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|account\.live\.com|accounts\.google\.com|okta\.com|oktapreview\.com|okta-emea\.com|auth0\.com|onelogin\.com|duosecurity\.com|pingone\.com|pingidentity\.com|myopenathens\.net|openathens\.net|appleid\.apple\.com|idp\.apple\.com)$|(^|\.)(idp|sso|login|signin|auth|shibboleth|adfs|cas|wayf|weblogin)[0-9-]*\./i;
export const isIdentityHost = (host: string) => IDENTITY_HOST.test(host);

const run = (file: string, args: string[]) =>
  new Promise<string>((done) => execFile(file, args, { timeout: 5000 }, (error, stdout) => done(error ? "" : String(stdout))));

let found: { at: number; apps: ChromiumApp[] } | undefined;
/** The Chromium browsers installed on this Mac (by bundle id, wherever they are). */
export async function chromiumApps(env: NodeJS.ProcessEnv = process.env): Promise<ChromiumApp[]> {
  // Smokes point Key at a browser program, or at none.
  const forced = env.KEY_SIGNIN_CHROMIUM;
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

export type WindowEnd = { kind: "signed-in" | "closed"; url?: string } | { kind: "failed"; problem: string };
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
  settleMs?: number;
}

/** One open sign-in window. `ended` resolves once it is signed in, closed or failed. */
export class SignInWindow {
  /** Hosts of every page and frame the window loaded (redirects included). */
  readonly hosts = new Set<string>();
  visitedSignIn = false;
  lastUrl = "";
  readonly ended: Promise<WindowEnd>;
  private end!: (end: WindowEnd) => void;
  private done = false;
  private pipe!: CdpPipe;
  private child!: ChildProcess;
  private mainTarget = "";
  private mainSession = "";
  private settle?: ReturnType<typeof setTimeout>;
  private readonly identity: (host: string) => boolean;

  private constructor(private readonly options: SignInWindowOptions) {
    this.ended = new Promise((resolve) => (this.end = resolve));
    const extra = new Set([...(options.identityHosts ?? [])].map((h) => h.toLowerCase()));
    this.identity = (host) => isIdentityHost(host) || extra.has(host);
  }

  static async open(options: SignInWindowOptions) {
    const window = new SignInWindow(options);
    await window.launch();
    return window;
  }

  private finish(end: WindowEnd) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.settle);
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
    const args = [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      `--window-size=${width},${height}`,
      ...(x !== undefined && y !== undefined ? [`--window-position=${x},${y}`] : []),
      // Test mode never draws a window and never asks the login keychain.
      ...(headless ? ["--headless=new", "--use-mock-keychain", "about:blank"] : ["--app=about:blank"]),
    ];
    this.child = spawn(app.executable, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    this.pipe = new CdpPipe(this.child.stdio[3] as Writable, this.child.stdio[4] as Readable);
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.once("error", () => undefined);
    void exited.then(() => {
      this.pipe.close();
      this.finish(this.verdict());
    });
    try {
      await this.pipe.send("Browser.getVersion", {}, undefined, 20_000);
    } catch {
      this.kill();
      // Most often: this profile is already open in another window of the browser.
      throw Error(`${app.name} could not open the sign-in window. If one is still open, close it and try again.`);
    }
    this.pipe.on((method, params, sessionId) => void this.event(method, params, sessionId));
    const page = await this.waitForPage();
    this.mainTarget = page;
    this.mainSession = await this.attach(page);
    await this.pipe.send("Page.navigate", { url: this.options.url }, this.mainSession);
  }

  private async waitForPage() {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const { targetInfos } = await this.pipe.send<{ targetInfos: Array<{ targetId: string; type: string }> }>("Target.getTargets");
      const page = targetInfos.find((t) => t.type === "page");
      if (page) return page.targetId;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw Error("The sign-in window did not open");
  }

  /** Watches a page or frame: its document requests (redirects too) and navigations. */
  private async attach(targetId: string) {
    const { sessionId } = await this.pipe.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await this.watch(sessionId);
    return sessionId;
  }
  private async watch(sessionId: string) {
    const send = (method: string, params: Record<string, unknown> = {}) => this.pipe.send(method, params, sessionId).catch(() => undefined);
    await send("Network.enable");
    await send("Page.enable");
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    if (this.options.virtualAuthenticator) {
      await send("WebAuthn.enable", { enableUI: false });
      await send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
      });
    }
  }

  private note(url: string) {
    let host: string;
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return undefined;
      host = u.hostname.toLowerCase();
    } catch {
      return undefined;
    }
    this.hosts.add(host);
    if (this.identity(host)) this.visitedSignIn = true;
    return host;
  }

  /** Signed in: it went through the sign-in pages and is now on a site that is not one. */
  private verdict(): WindowEnd {
    let host = "";
    try {
      host = new URL(this.lastUrl).hostname.toLowerCase();
    } catch {
      /* no page yet */
    }
    return this.visitedSignIn && host && !this.identity(host) ? { kind: "signed-in", url: this.lastUrl } : { kind: "closed" };
  }

  private async event(method: string, params: Record<string, any>, sessionId?: string) {
    if (method === "Target.attachedToTarget" && params.sessionId) {
      // Frames from other sites, and pages the window opens.
      await this.watch(params.sessionId);
      return;
    }
    if (method === "Target.detachedFromTarget" && params.sessionId === this.mainSession) {
      // The person closed the window (the browser itself keeps running on macOS).
      this.finish(this.verdict());
      return;
    }
    if (method === "Network.requestWillBeSent" && params.type === "Document") {
      this.note(String(params.request?.url ?? ""));
      if (sessionId === this.mainSession && params.frameId === this.mainTarget) clearTimeout(this.settle);
      return;
    }
    if (method === "Page.frameStartedLoading" && sessionId === this.mainSession && params.frameId === this.mainTarget) {
      clearTimeout(this.settle);
      return;
    }
    if (method === "Page.frameNavigated" && sessionId === this.mainSession && !params.frame?.parentId) {
      const url = String(params.frame?.url ?? "");
      const host = this.note(url);
      if (!host) return;
      this.lastUrl = url;
      clearTimeout(this.settle);
      // Settled on a site after the sign-in pages (no further redirect for a moment): done.
      this.settle = setTimeout(() => {
        const verdict = this.verdict();
        if (verdict.kind === "signed-in") this.finish(verdict);
      }, this.options.settleMs ?? (Number(process.env.KEY_SIGNIN_SETTLE_MS) || 1500));
    }
  }

  /** The window's cookies for these hosts. */
  async cookies(hosts: Iterable<string>) {
    const { cookies } = await this.pipe.send<{ cookies: CdpCookie[] }>("Storage.getCookies");
    return signInCookies(cookies ?? [], hosts);
  }

  /** Brings the window to the front: restores it if it was minimised, makes it the browser's
   * front window, then activates this browser process (by its pid, never the person's own
   * instance of the same browser). */
  async focus() {
    if (this.options.headless) return;
    const { windowId } = await this.pipe.send<{ windowId?: number }>("Browser.getWindowForTarget", { targetId: this.mainTarget }).catch(() => ({ windowId: undefined }));
    if (windowId !== undefined) await this.pipe.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }).catch(() => undefined);
    await this.pipe.send("Target.activateTarget", { targetId: this.mainTarget }).catch(() => undefined);
    await this.pipe.send("Page.bringToFront", {}, this.mainSession).catch(() => undefined);
    if (process.platform === "darwin" && this.child.pid) await activateProcess(this.child.pid);
  }

  /** The person says they are done: decide now. */
  signedInNow() {
    this.finish({ kind: "signed-in", url: this.verdict().kind === "signed-in" ? this.lastUrl : undefined });
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

/** Removes Key's sign-in profiles (every browser's). */
export async function forgetSignInProfiles(root: string) {
  await rm(root, { recursive: true, force: true });
}
