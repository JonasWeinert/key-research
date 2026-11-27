// Passkey sign-ins in Key's browser. Electron services WebAuthn without a browser's passkey
// dialog: a USB or NFC security key works (touch it when it blinks), this Mac's Touch ID only
// in a signed copy of Key (app.configureWebAuthn needs a keychain-access-groups entitlement),
// and "use a phone or tablet" (the QR code) and iCloud Keychain passkeys not at all: Chromium
// draws those in Chrome's own UI, which Electron does not have, and Apple gives the system
// passkey sheet for any site only to web browsers it has approved. So a page that asks for a
// passkey would wait in silence. Instead (web-signin preload, every frame) a card covers the
// page within a moment and offers the sign-in window (sign-in-window.ts): a small window of
// Chrome, Edge or Brave with a profile of Key's own, where the phone's QR code and saved
// passkeys work; Key brings the sign-in's cookies back from it by itself. Without such a
// browser the sign-in can be finished in Safari or Firefox and brought over from there
// (cookie-import.ts, after asking).
import { app, dialog, ipcMain, shell, webContents, type BaseWindow, type WebContents, type WebFrameMain } from "electron";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { browserSession } from "./profile";
import {
  browserOfAppName,
  chromiumKey,
  decrypt,
  electronCookie,
  findCookies,
  keychainPassword,
  knownBrowsers,
  locateCookies,
  needsKeychain,
  siteHost,
  summarize,
  type BrowserId,
  type BrowserInfo,
} from "./cookie-import";
import { chromiumApps, cookieSites, electronCookie as windowCookie, forgetSignInProfiles, isIdentityHost, SignInWindow, type ChromiumApp } from "./sign-in-window";

export type SignInBrowser = "default" | BrowserId;
export interface SignInSettings {
  /** Offer help when a page waits for a passkey. */
  notice: boolean;
  /** The browser sign-ins are finished in ("default": the best one on this Mac). */
  browser: SignInBrowser;
}
/** The card over a page whose sign-in needs a passkey (renderer's SignInCard). */
export interface SignInCard {
  /** offer: what is happening and the way on; open: the sign-in window is open; failed: it
   * ended without a sign-in. */
  stage: "offer" | "open" | "failed";
  site: string;
  /** window: Key's sign-in window in `browser`; handoff: finish in `browser`, bring it over. */
  way: "window" | "handoff";
  browser: string;
  problem?: string;
}
/** What the bar and the card show about a sign-in. */
export interface SignInBar {
  card?: SignInCard;
  /** A page waits for a passkey (the card was put aside). */
  waiting?: { site: string; kind: "get" | "create"; browser?: string; way?: "window" | "handoff" };
  /** A sign-in page: the sign-in window can be opened on it at any time. */
  offer?: { browser: string };
  /** The sign-in went to another browser: bring it back once it is done there. */
  handoff?: { browser: string; site: string };
  /** Sites whose sign-in was just brought over. */
  imported?: { browser: string; sites: number; names?: string[] };
}
export type SignInOp =
  | "signin-stop"
  | "signin-window"
  | "signin-done"
  | "signin-focus"
  | "signin-not-now"
  | "signin-get-browser"
  | "signin-browser"
  | "signin-import"
  | "signin-cancel"
  | "signin-dismiss";

type Way = { kind: "window"; app: ChromiumApp } | { kind: "handoff"; browser?: BrowserInfo; appName: string };

const BUNDLE: Record<BrowserId, string> = {
  chrome: "com.google.Chrome",
  edge: "com.microsoft.edgemac",
  brave: "com.brave.Browser",
  arc: "company.thebrowser.Browser",
  vivaldi: "com.vivaldi.Vivaldi",
  chromium: "org.chromium.Chromium",
  firefox: "org.mozilla.firefox",
  safari: "com.apple.Safari",
};
const TRAIL_MS = 20 * 60_000;
/** Where "Get Google Chrome" goes: the browser's official site, nothing is downloaded by Key. */
const GET_BROWSER_URL = "https://www.google.com/chrome/";

interface Pending {
  kind: "get" | "create";
  rpId: string;
  frame: WebFrameMain | null;
  host?: string;
}
interface Tab {
  contents: WebContents;
  changed(): void;
  window(): BaseWindow | undefined;
  pending: Map<string, Pending>;
  waiting?: Pending;
  timer?: ReturnType<typeof setTimeout>;
  /** Main-frame addresses the tab went through (navigations and redirects), oldest first. */
  trail: Array<{ url: string; host: string; at: number }>;
  card?: SignInCard;
  /** The card was put aside (Not now) for the request that waits now. */
  aside?: boolean;
  signInWindow?: SignInWindow;
  handoff?: { browser?: BrowserInfo; appName: string; url: string; hosts: string[] };
  imported?: { browser: string; sites: number; names?: string[] };
}

/** The part of the tab's recent trail this sign-in is: where it started (the page before the
 * sign-in pages) and every site it went through since. */
export function signInChain(trail: Array<{ url: string; host: string }>, current: string, rpId?: string) {
  const entries = trail.length ? trail : [{ url: current, host: siteHost(current) ?? "" }];
  const identity = (i: number) => isIdentityHost(entries[i].host);
  let end = entries.length - 1;
  while (end >= 0 && !identity(end)) end--;
  let first = entries.length - 1;
  if (end >= 0) {
    // The first sign-in page of the last run of them, and the page that sent the tab there
    // (a tab that opened straight onto a sign-in page starts at it).
    first = end;
    while (first > 0 && identity(first - 1)) first--;
    if (first > 0) first--;
  }
  const hosts = new Set(entries.slice(first).map((e) => e.host).filter(Boolean));
  const here = siteHost(current);
  if (here) hosts.add(here);
  if (rpId && /^[a-z0-9.-]+$/i.test(rpId)) hosts.add(rpId.toLowerCase());
  return { url: entries[first].url || current, hosts: [...hosts] };
}

/** How a passkey sign-in goes on from Key's browser: in Key's sign-in window when a Chromium
 * browser is installed (the chosen one, else the default browser if it is one, else the first),
 * otherwise handed to the chosen or default browser. */
export function chooseWay(choice: SignInBrowser, installed: ChromiumApp[], defaultBrowser: { id?: BrowserId; appName: string }, browsers: BrowserInfo[]): Way {
  const pick = (id?: BrowserId) => installed.find((a) => a.id === id);
  if (choice === "firefox" || choice === "safari") {
    const browser = browsers.find((b) => b.id === choice)!;
    return { kind: "handoff", browser, appName: browser.name };
  }
  const app = pick(choice === "default" ? defaultBrowser.id : choice) ?? pick(defaultBrowser.id) ?? installed[0];
  if (app) return { kind: "window", app };
  const id = defaultBrowser.id;
  const browser = browsers.find((b) => b.id === id);
  return { kind: "handoff", browser, appName: browser?.name ?? defaultBrowser.appName };
}

export class SignInService {
  private tabs = new Map<number, Tab>();
  private touchId: "on" | "unsigned" | "unsupported" = process.platform === "darwin" ? "unsigned" : "unsupported";
  private installed: ChromiumApp[] = [];
  constructor(private readonly settings: () => SignInSettings) {}

  /** Key's own profiles for sign-in windows, one per browser (never the person's own). */
  static profileRoot() {
    return join(app.getPath("userData"), "Sign-in window");
  }

  /** Watches every page of the browser profile; once, at startup. */
  install(preloadDir: string) {
    const ses = browserSession();
    ses.registerPreloadScript({ type: "frame", id: "key-web-signin", filePath: join(preloadDir, "web-signin.js") });
    ipcMain.on("key-browser:webauthn", (event, raw: unknown) => {
      if (event.sender.session !== ses) return;
      const tab = this.tabs.get(event.sender.id);
      if (!tab || typeof raw !== "string") return;
      let message: { id?: number; kind?: string; state?: string; rpId?: string };
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      const key = `${event.senderFrame?.processId ?? 0}:${event.senderFrame?.routingId ?? 0}:${Number(message.id) || 0}`;
      if (message.state === "start") {
        const host = siteHost(event.senderFrame?.url ?? "");
        tab.pending.set(key, { kind: message.kind === "create" ? "create" : "get", rpId: String(message.rpId ?? "").slice(0, 253), frame: event.senderFrame, host });
        clearTimeout(tab.timer);
        // Within a second: a page never just sits there waiting.
        tab.timer = setTimeout(() => void this.showWaiting(tab), Number(process.env.KEY_SIGNIN_NOTICE_MS) || 700);
      } else if (message.state === "end") {
        tab.pending.delete(key);
        if (!tab.pending.size) this.clearWaiting(tab);
      }
    });
    // More than one passkey on a security key for this site: the person picks one.
    ses.on("select-webauthn-account", (event, details, callback) => {
      event.preventDefault();
      const contents = details.frame ? webContents.fromFrame(details.frame) : undefined;
      const window = contents ? this.tabs.get(contents.id)?.window() : undefined;
      const accounts = details.accounts.slice(0, 8);
      const labels = accounts.map((a) => [a.displayName, a.name].filter(Boolean).join(" — ") || "Unnamed account");
      const options = { type: "question" as const, message: `Sign in to ${details.relyingPartyId} as…`, detail: "Your security key has more than one passkey for this site.", buttons: [...labels, "Cancel"], cancelId: labels.length, defaultId: 0 };
      void (window ? dialog.showMessageBox(window as Electron.BaseWindow, options) : dialog.showMessageBox(options))
        .then(({ response }) => callback(accounts[response]?.credentialId))
        .catch(() => callback());
    });
    // Sign-in windows Key opened close with it.
    app.on("will-quit", () => {
      for (const tab of this.tabs.values()) void tab.signInWindow?.close();
    });
    void this.refreshBrowsers();
    void this.configureTouchId();
  }

  private async refreshBrowsers() {
    this.installed = await chromiumApps().catch(() => []);
    return this.installed;
  }

  /** Touch ID passkeys need Key signed with a keychain group for them (see PACKAGING.md). */
  private async configureTouchId() {
    if (process.platform !== "darwin" || process.env.KEY_WEBAUTHN_TOUCHID === "0") return;
    const group = process.env.KEY_WEBAUTHN_KEYCHAIN_GROUP || (app.isPackaged ? await signedWebAuthnGroup() : undefined);
    if (!group) return;
    try {
      app.configureWebAuthn({ touchID: { keychainAccessGroup: group, promptReason: "sign in to $1" } });
      this.touchId = "on";
    } catch {
      /* an older runtime: no Touch ID */
    }
  }

  attach(contents: WebContents, hooks: { changed(): void; window(): BaseWindow | undefined; initialUrl?: string }) {
    const tab: Tab = { contents, changed: hooks.changed, window: hooks.window, pending: new Map(), trail: [] };
    this.tabs.set(contents.id, tab);
    const note = (url: string) => {
      const host = siteHost(url);
      if (!host || !/^https?:/i.test(url)) return;
      const now = Date.now();
      tab.trail = [...tab.trail.filter((e) => now - e.at < TRAIL_MS && e.url !== url), { url, host, at: now }].slice(-40);
    };
    // The tab's first page started loading before Key watched it: where the sign-in starts.
    if (hooks.initialUrl) note(hooks.initialUrl);
    contents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument) return;
      note(event.url);
      // A new page: whatever the old one waited for is gone (an open sign-in window stays).
      tab.pending.clear();
      tab.aside = false;
      const shown = (tab.card && tab.card.stage !== "open") || tab.imported;
      if (tab.card && tab.card.stage !== "open") tab.card = undefined;
      tab.imported = undefined;
      this.clearWaiting(tab);
      if (shown) tab.changed();
    });
    contents.on("did-redirect-navigation", (event) => event.isMainFrame && note(event.url));
    contents.once("destroyed", () => {
      clearTimeout(tab.timer);
      void tab.signInWindow?.close();
      this.tabs.delete(contents.id);
    });
  }

  /** Whether the tab's page is covered by the sign-in card (its view is hidden meanwhile). */
  covers(contents: WebContents | undefined) {
    const tab = contents && this.tabs.get(contents.id);
    return !!tab?.card;
  }

  private async showWaiting(tab: Tab) {
    const first = [...tab.pending.values()][0];
    if (!first || tab.contents.isDestroyed()) return;
    tab.waiting = first;
    if (this.settings().notice && !tab.aside && !tab.signInWindow && !tab.handoff) {
      const way = this.way(await this.refreshBrowsers());
      if (tab.waiting !== first) return;
      tab.card = { stage: "offer", site: first.rpId || first.host || siteHost(tab.contents.getURL()) || "", way: way.kind, browser: way.kind === "window" ? way.app.name : way.appName };
    }
    tab.changed();
  }
  private clearWaiting(tab: Tab) {
    clearTimeout(tab.timer);
    if (tab.card?.stage === "offer") tab.card = undefined;
    if (!tab.waiting) return;
    tab.waiting = undefined;
    tab.changed();
  }
  private stopRequests(tab: Tab) {
    for (const p of tab.pending.values())
      try {
        p.frame?.send("key-browser:webauthn-stop");
      } catch {
        /* the frame is gone */
      }
  }

  private way(installed = this.installed): Way {
    const appName = app.getApplicationNameForProtocol("https://") || "your browser";
    const id = browserOfAppName(appName);
    return chooseWay(this.settings().browser, installed, { id, appName: appName.replace(/\.app$/, "") }, knownBrowsers());
  }

  barState(contents: WebContents | undefined): SignInBar | undefined {
    const tab = contents && this.tabs.get(contents.id);
    if (!tab) return undefined;
    if (tab.card) return { card: tab.card };
    if (tab.handoff) return { handoff: { browser: tab.handoff.appName, site: siteHost(tab.handoff.url) ?? "" } };
    if (tab.imported) return { imported: tab.imported };
    const way = this.way();
    const browser = way.kind === "window" ? way.app.name : way.appName;
    if (tab.waiting && this.settings().notice) return { waiting: { site: tab.waiting.rpId, kind: tab.waiting.kind, browser, way: way.kind } };
    // On a sign-in page, the sign-in window is always at hand.
    const host = siteHost(contents.getURL());
    if (way.kind === "window" && host && isIdentityHost(host)) return { offer: { browser } };
    return undefined;
  }

  /** What Settings › Web & browser › Sign-in shows. */
  async info() {
    const installed = await this.refreshBrowsers();
    const way = this.way(installed);
    const appName = app.getApplicationNameForProtocol("https://") || "your browser";
    return {
      defaultBrowser: appName.replace(/\.app$/, ""),
      touchId: this.touchId,
      installed: installed.map((a) => ({ id: a.id, name: a.name })),
      way: way.kind === "window" ? { kind: "window" as const, browser: way.app.name } : { kind: "handoff" as const, browser: way.appName },
    };
  }

  /** Settings › Forget sign-ins: closes any sign-in window and removes Key's sign-in profiles. */
  async forget() {
    await Promise.all([...this.tabs.values()].map((t) => t.signInWindow?.close()));
    await forgetSignInProfiles(SignInService.profileRoot());
  }

  async op(contents: WebContents, op: SignInOp) {
    const tab = this.tabs.get(contents.id);
    if (!tab) return;
    if (op === "signin-stop") {
      this.stopRequests(tab);
      this.clearWaiting(tab);
    } else if (op === "signin-not-now") {
      tab.aside = true;
      tab.card = undefined;
    } else if (op === "signin-dismiss") {
      tab.imported = undefined;
      tab.card = undefined;
      this.clearWaiting(tab);
    } else if (op === "signin-cancel") {
      tab.handoff = undefined;
      tab.card = undefined;
      const window = tab.signInWindow;
      tab.signInWindow = undefined;
      await window?.close();
    } else if (op === "signin-window") void this.openWindow(tab);
    else if (op === "signin-done") tab.signInWindow?.signedInNow();
    else if (op === "signin-focus") await tab.signInWindow?.focus();
    else if (op === "signin-get-browser") {
      if (!process.env.KEY_BROWSER_SMOKE) void shell.openExternal(GET_BROWSER_URL);
    } else if (op === "signin-browser") {
      const chain = signInChain(tab.trail, contents.getURL(), tab.waiting?.rpId);
      const way = this.way();
      const target = way.kind === "handoff" ? way : { browser: knownBrowsers().find((b) => b.id === way.app.id), appName: way.app.name };
      this.stopRequests(tab);
      this.clearWaiting(tab);
      tab.card = undefined;
      tab.handoff = { browser: target.browser, appName: target.appName, url: chain.url, hosts: chain.hosts };
      await openIn(target.browser, chain.url);
    } else if (op === "signin-import") await this.importSignIn(tab);
    tab.changed();
  }

  /** Opens the sign-in window on the page that started this sign-in, waits for it to finish
   * there, then brings the sign-in's cookies over and reloads the page. */
  private async openWindow(tab: Tab) {
    const way = this.way(await this.refreshBrowsers());
    if (way.kind !== "window") {
      tab.card = { stage: "offer", site: siteHost(tab.contents.getURL()) ?? "", way: "handoff", browser: way.appName };
      return tab.changed();
    }
    const old = tab.signInWindow;
    if (old?.open) return void old.focus();
    // One window per profile: a sign-in still open in another tab gives way.
    for (const other of this.tabs.values())
      if (other.signInWindow) {
        const window = other.signInWindow;
        other.signInWindow = undefined;
        other.card = undefined;
        other.changed();
        await window.close();
      }
    const waiting = tab.waiting ?? [...tab.pending.values()][0];
    const chain = signInChain(tab.trail, tab.contents.getURL(), waiting?.rpId);
    // Where the page asked for the passkey is a sign-in page, whatever it is called.
    const identityHosts = [waiting?.host, waiting?.rpId].filter((h): h is string => !!h);
    const site = siteHost(chain.url) ?? "";
    this.stopRequests(tab);
    this.clearWaiting(tab);
    tab.handoff = undefined;
    tab.card = { stage: "open", site, way: "window", browser: way.app.name };
    tab.changed();
    const bounds = (() => {
      try {
        return (tab.window() as Electron.BaseWindow | undefined)?.getBounds();
      } catch {
        return undefined;
      }
    })();
    let window: SignInWindow;
    try {
      window = await SignInWindow.open({
        app: way.app,
        profileDir: join(SignInService.profileRoot(), way.app.id),
        url: chain.url,
        identityHosts,
        near: bounds,
        headless: !!process.env.KEY_SIGNIN_HEADLESS,
        virtualAuthenticator: !!(process.env.KEY_BROWSER_SMOKE && process.env.KEY_SIGNIN_VIRTUAL_AUTHENTICATOR),
      });
    } catch (error) {
      if (tab.card?.stage === "open") tab.card = { stage: "failed", site, way: "window", browser: way.app.name, problem: (error as Error).message };
      return tab.changed();
    }
    if (tab.card?.stage !== "open" || tab.contents.isDestroyed()) return void window.close();
    tab.signInWindow = window;
    const end = await window.ended;
    if (tab.signInWindow !== window) return; // cancelled, or the tab is gone
    tab.signInWindow = undefined;
    const fail = async (problem: string) => {
      await window.close();
      tab.card = { stage: "failed", site, way: "window", browser: way.app.name, problem };
      tab.changed();
    };
    if (end.kind !== "signed-in") return fail(end.kind === "failed" ? end.problem : "The sign-in window was closed before the sign-in was finished.");
    // The cookies of the sites this sign-in went through, in Key's tab and in the window.
    const hosts = new Set([...chain.hosts, ...window.hosts]);
    const cookies = await window.cookies(hosts).catch(() => []);
    await window.close();
    if (!cookies.length) return fail(`No sign-in came back from ${way.app.name}. Try again, and finish signing in there before you choose Done.`);
    const ses = browserSession();
    let set = 0;
    for (const cookie of cookies) await ses.cookies.set(windowCookie(cookie)).then(() => set++, () => undefined);
    await ses.cookies.flushStore().catch(() => undefined);
    if (!set) return fail("The sign-in came back, but Key’s browser did not accept it.");
    tab.card = undefined;
    const back = end.url && /^https?:/i.test(end.url) && !isIdentityHost(siteHost(end.url) ?? "") ? end.url : chain.url;
    void tab.contents.loadURL(back).catch(() => undefined);
    // After the load starts (which clears notices), say what happened.
    const names = cookieSites(cookies);
    setTimeout(() => {
      tab.imported = { browser: way.app.name, sites: names.length, names };
      tab.changed();
    }, 300);
    tab.changed();
  }

  /** Asks, then copies the sign-in's cookies from the other browser and reloads the page. */
  private async importSignIn(tab: Tab) {
    const handoff = tab.handoff;
    if (!handoff) return;
    const window = tab.window();
    const sheet = (options: Electron.MessageBoxOptions) => (window ? dialog.showMessageBox(window as Electron.BaseWindow, options) : dialog.showMessageBox(options));
    if (!handoff.browser) {
      await sheet({
        type: "info",
        message: `Key can’t read ${handoff.appName}’s sign-ins`,
        detail: "Key can bring sign-ins over from Chrome, Edge, Brave, Arc, Vivaldi, Firefox and Safari. Choose one of them under Settings › Web & browser › Sign-in, then try again.",
        buttons: ["OK"],
      });
      return;
    }
    const browser = handoff.browser;
    const source = await locateCookies(browser);
    if (source.problem === "no-access") {
      const { response } = await sheet({
        type: "info",
        message: "Key needs Full Disk Access to read Safari’s sign-ins",
        detail:
          "macOS keeps Safari’s cookies private. To bring this sign-in over, turn Key on under System Settings › Privacy & Security › Full Disk Access, reopen Key and try again. Or choose another browser under Settings › Web & browser › Sign-in.",
        buttons: ["Open Privacy & Security", "Cancel"],
        cancelId: 1,
      });
      if (response === 0) void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
      return;
    }
    const found = await findCookies(source, handoff.hosts).catch(() => undefined);
    const sites = found ? summarize(found) : [];
    if (!found || !sites.length) {
      await sheet({
        type: "info",
        message: `No sign-in found in ${browser.name} yet`,
        detail: `Finish signing in to ${siteHost(handoff.url) ?? "the site"} in ${browser.name} first${source.profile ? ` (profile “${source.profile}”)` : ""}, then choose Bring sign-in over again.`,
        buttons: ["OK"],
      });
      return;
    }
    const keychain = needsKeychain(found) && browser.keychain;
    const { response } = await sheet({
      type: "question",
      message: `Bring your sign-in over from ${browser.name}?`,
      detail: [
        `Key copies the cookies of these sites from ${browser.name}${source.profile ? ` (profile “${source.profile}”)` : ""} into its own browser, then opens the page again:`,
        "",
        ...sites.map((s) => `• ${s.site} (${s.count} ${s.count === 1 ? "cookie" : "cookies"})`),
        "",
        "Nothing else is read, and nothing in " + browser.name + " changes.",
        ...(keychain ? ["", `macOS will then ask whether Key may use “${keychain.service}”: the key ${browser.name} locks its cookies with. Choose Allow (or Always Allow).`] : []),
      ].join("\n"),
      buttons: ["Bring sign-in over", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    let key: Buffer | undefined;
    if (keychain) {
      try {
        key = chromiumKey(await keychainPassword(keychain));
      } catch {
        await sheet({ type: "info", message: "Nothing was brought over", detail: `macOS did not give Key access to “${keychain.service}”, so ${browser.name}’s cookies stay locked.`, buttons: ["OK"] });
        return;
      }
    }
    const cookies = decrypt(found, key);
    const ses = browserSession();
    let set = 0;
    for (const cookie of cookies) await ses.cookies.set(electronCookie(cookie)).then(() => set++, () => undefined);
    await ses.cookies.flushStore().catch(() => undefined);
    tab.handoff = undefined;
    if (!set) {
      await sheet({ type: "info", message: "Nothing was brought over", detail: `${browser.name}’s cookies for these sites could not be read.`, buttons: ["OK"] });
      return;
    }
    void tab.contents.loadURL(handoff.url).catch(() => undefined);
    setTimeout(() => {
      tab.imported = { browser: browser.name, sites: sites.length, names: sites.map((s) => s.site) };
      tab.changed();
    }, 300);
  }
}

/** Opens a page in a browser (the default one when Key cannot name it). */
async function openIn(browser: BrowserInfo | undefined, url: string) {
  // Smokes check where the sign-in would go without opening another browser.
  if (process.env.KEY_BROWSER_SMOKE) return void Object.assign(globalThis, { keySignInOpened: { browser: browser?.id, url } });
  if (!browser || process.platform !== "darwin") return shell.openExternal(url);
  await new Promise<void>((done) => execFile("/usr/bin/open", ["-b", BUNDLE[browser.id], url], (error) => (error ? void shell.openExternal(url).finally(done) : done())));
}

/** The `<team>.<bundle>.webauthn` keychain group Key is signed with, if any. */
function signedWebAuthnGroup() {
  const bundle = resolve(process.execPath, "..", "..", "..");
  return new Promise<string | undefined>((done) =>
    execFile("/usr/bin/codesign", ["-d", "--entitlements", ":-", bundle], { timeout: 5000 }, (error, stdout) => {
      if (error) return done(undefined);
      const groups = /<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(String(stdout))?.[1] ?? "";
      done([...groups.matchAll(/<string>([^<]+\.webauthn)<\/string>/g)][0]?.[1]);
    }),
  );
}
