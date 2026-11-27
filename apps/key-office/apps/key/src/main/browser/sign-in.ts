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
// The window never starts on a sign-in page's address (its one-time request is bound to this
// browser's cookies, and would be stale there): it starts on the page of the site the person
// was going to (sign-in-entry.ts), and Key goes back there once the sign-in is brought over.
// A tab that arrives at a sign-in service is offered the window at once, before anything is
// typed; the choice is remembered per sign-in service, and where a passkey was asked for
// before, the window opens by itself.
import { app, dialog, ipcMain, shell, webContents, type BaseWindow, type WebContents, type WebFrameMain } from "electron";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isIdentityUrl, redactUrl, signInEntry, type Hop } from "./sign-in-entry";
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
import { chromiumApps, cookieSites, electronCookie as windowCookie, forgetSignInProfiles, SignInWindow, type ChromiumApp } from "./sign-in-window";

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
  /** arrival: the tab just reached a sign-in service (first time there): window or here?;
   * where: Key cannot tell which site the sign-in is for, the person picks; loop: the sign-in
   * came back but the site sent Key's browser to the sign-in page again. */
  stage: "offer" | "open" | "failed" | "arrival" | "where" | "loop";
  site: string;
  /** window: Key's sign-in window in `browser`; handoff: finish in `browser`, bring it over. */
  way: "window" | "handoff";
  browser: string;
  problem?: string;
  /** The sign-in service (for "Key remembers this for …"). */
  host?: string;
  /** The window opened by itself (a remembered choice). */
  auto?: boolean;
  /** Pages of this tab the person may have been going to (stage where). */
  entries?: Array<{ url: string; label: string }>;
  /** Cookies that could not be brought over (names only, with why). */
  failed?: string[];
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
  | "signin-dismiss"
  | "signin-here"
  | "signin-key-instead"
  | "signin-pick"
  | "signin-keep";

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
  trail: Hop[];
  /** The page that opened this tab (a sign-in in a new tab or popup). */
  opener?: string;
  /** When the current page was shown. */
  shownAt?: number;
  /** Key is taking the tab back to the site after bringing a sign-in over: a sign-in page now
   * means the site did not accept it. */
  returning?: { entry: string; site: string; until: number; failed: string[]; browser: string; timer?: ReturnType<typeof setTimeout>; shown?: boolean };
  /** Where the site was entered, for "Use the window for this site" after a loop. */
  loopEntry?: string;
  card?: SignInCard;
  /** The card was put aside (Not now) for the request that waits now. */
  aside?: boolean;
  signInWindow?: SignInWindow;
  handoff?: { browser?: BrowserInfo; appName: string; url: string; hosts: string[] };
  imported?: { browser: string; sites: number; names?: string[] };
}

/** The sites of this sign-in in the tab: the entry's and every one the tab went through since,
 * the page now and the passkey's relying party. */
export function chainHosts(trail: Hop[], entry: string | undefined, current: string, rpId?: string) {
  const from = entry ? trail.map((h) => h.url).lastIndexOf(entry) : -1;
  const hosts = new Set<string>();
  for (const hop of trail.slice(Math.max(0, from))) {
    const host = siteHost(hop.url);
    if (host) hosts.add(host);
  }
  for (const url of [entry, current]) {
    const host = url && siteHost(url);
    if (host) hosts.add(host);
  }
  if (rpId && /^[a-z0-9.-]+$/i.test(rpId)) hosts.add(rpId.toLowerCase());
  return [...hosts];
}

/** Remembered per sign-in service: the person's choice (window or here), and whether it asked
 * for a passkey before. Kept in Key's data folder (sign-in-hosts.json). */
export type HostChoice = "window" | "here";
export class SignInHosts {
  private data: { hosts: Record<string, HostChoice>; passkey: string[] } = { hosts: {}, passkey: [] };
  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      for (const [host, choice] of Object.entries(raw?.hosts ?? {})) if (choice === "window" || choice === "here") this.data.hosts[host] = choice;
      this.data.passkey = Array.isArray(raw?.passkey) ? raw.passkey.filter((h: unknown) => typeof h === "string").slice(-200) : [];
    } catch {
      /* none yet */
    }
  }
  choice(host: string): HostChoice | undefined {
    return this.data.hosts[host];
  }
  askedForPasskey(host: string) {
    return this.data.passkey.includes(host);
  }
  /** The window opens by itself here: chosen, or a passkey was asked for and "here" was not. */
  automatic(host: string) {
    const choice = this.choice(host);
    return choice === "window" || (choice !== "here" && this.askedForPasskey(host));
  }
  passkeyHosts() {
    return this.data.passkey;
  }
  set(host: string, choice: HostChoice | undefined) {
    if (choice) this.data.hosts[host] = choice;
    else {
      delete this.data.hosts[host];
      this.data.passkey = this.data.passkey.filter((h) => h !== host);
    }
    void this.save();
  }
  notePasskey(host: string) {
    if (!host || this.data.passkey.includes(host)) return;
    this.data.passkey = [...this.data.passkey, host].slice(-200);
    void this.save();
  }
  list() {
    const hosts = new Set([...Object.keys(this.data.hosts), ...this.data.passkey]);
    return [...hosts].sort().map((host) => ({ host, choice: this.choice(host), passkey: this.askedForPasskey(host), automatic: this.automatic(host) }));
  }
  clear() {
    this.data = { hosts: {}, passkey: [] };
    void this.save();
  }
  private async save() {
    await mkdir(dirname(this.file), { recursive: true }).catch(() => undefined);
    await writeFile(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 }).catch(() => undefined);
  }
}

/** A debug trace of sign-ins (KEY_SIGNIN_TRACE=1, and in smokes): addresses without their
 * query values, never cookie values or tokens. */
function trace(event: string, detail: Record<string, unknown> = {}) {
  if (!process.env.KEY_SIGNIN_TRACE && !process.env.KEY_BROWSER_SMOKE) return;
  const line = { at: Date.now(), event, ...detail };
  if (process.env.KEY_BROWSER_SMOKE) {
    const store = globalThis as unknown as { keySignInTrace?: unknown[] };
    (store.keySignInTrace ??= []).push(line);
  }
  if (process.env.KEY_SIGNIN_TRACE) console.error("[sign-in]", JSON.stringify(line));
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
  private hostsStore?: SignInHosts;
  /** Sign-in windows kept open for a site that would not take the sign-in in Key. */
  private kept = new Set<SignInWindow>();
  constructor(private readonly settings: () => SignInSettings) {}

  private get hosts() {
    return (this.hostsStore ??= new SignInHosts(join(app.getPath("userData"), "sign-in-hosts.json")));
  }

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
        // Remembered: next time the sign-in window opens by itself on this sign-in service
        // (and on the one the tab arrived at for this sign-in). Only sign-in services: a site
        // that asks for a passkey on its own page is not one to open the window on.
        if (host && isIdentityUrl(event.senderFrame?.url ?? "")) this.hosts.notePasskey(host);
        const arrived = this.signInHost(tab);
        if (arrived) this.hosts.notePasskey(arrived);
        trace("passkey-request", { page: redactUrl(event.senderFrame?.url ?? ""), returning: !!tab.returning });
        // Back from a sign-in, the site asked for a passkey again: it did not take the sign-in.
        if (tab.returning?.shown) return void this.loop(tab);
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
      for (const window of this.kept) void window.close();
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

  attach(contents: WebContents, hooks: { changed(): void; window(): BaseWindow | undefined; initialUrl?: string; openerUrl?: string }) {
    const tab: Tab = { contents, changed: hooks.changed, window: hooks.window, pending: new Map(), trail: [] };
    if (hooks.openerUrl && /^https?:/i.test(hooks.openerUrl)) tab.opener = hooks.openerUrl;
    this.tabs.set(contents.id, tab);
    const push = (url: string, committed = false, redirect = false) => {
      if (!/^https?:/i.test(url)) return;
      const now = Date.now();
      tab.trail = [...tab.trail.filter((h) => now - h.at < TRAIL_MS), { url, at: now, committed, ...(redirect ? { redirect } : {}) }].slice(-40);
    };
    // The tab's first page started loading before Key watched it.
    if (hooks.initialUrl) push(hooks.initialUrl);
    contents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument) return;
      const last = tab.trail.at(-1);
      // How long the page before was shown: a page left at once is a step on the way.
      if (last?.committed && last.dwell === undefined && tab.shownAt) last.dwell = Date.now() - tab.shownAt;
      if (!(last && !last.committed && last.url === event.url)) push(event.url);
      // A new page: whatever the old one waited for is gone (an open sign-in window stays).
      tab.pending.clear();
      tab.aside = false;
      const card = tab.card?.stage;
      const drop = card === "offer" || card === "failed" || card === "where";
      const shown = drop || (tab.imported && !tab.returning);
      if (drop) tab.card = undefined;
      if (!tab.returning) tab.imported = undefined;
      if (tab.returning) clearTimeout(tab.returning.timer);
      this.clearWaiting(tab);
      if (shown) tab.changed();
    });
    contents.on("did-redirect-navigation", (event) => event.isMainFrame && push(event.url, false, true));
    contents.on("did-navigate", (_event, url) => {
      const now = Date.now();
      const hop = [...tab.trail].reverse().find((h) => h.url === url && !h.committed);
      if (hop) hop.committed = true;
      else push(url, true);
      tab.shownAt = now;
      this.arrived(tab, url);
    });
    contents.once("destroyed", () => {
      clearTimeout(tab.timer);
      if (tab.returning) clearTimeout(tab.returning.timer);
      void tab.signInWindow?.close();
      this.tabs.delete(contents.id);
    });
  }

  /** The sign-in service the tab arrived at for the sign-in it is in now (the first sign-in page
   * of the current run), if it is in one. */
  private signInHost(tab: Tab) {
    let host: string | undefined;
    for (let i = tab.trail.length - 1; i >= 0; i--) {
      const url = tab.trail[i].url;
      if (isIdentityUrl(url)) host = siteHost(url);
      else if (tab.trail[i].committed && (tab.trail[i].dwell ?? Infinity) >= 1000) break;
    }
    return host;
  }

  /** A page was shown in the tab. At the first sign-in page of a sign-in, offer the sign-in
   * window right away (or open it, as remembered); back from a sign-in, watch for the site
   * sending the tab to its sign-in page again. */
  private arrived(tab: Tab, url: string) {
    trace("page", { url: redactUrl(url), returning: !!tab.returning });
    if (tab.returning) return this.returnStep(tab, url);
    const identity = isIdentityUrl(url);
    if (!identity) {
      if (tab.card?.stage === "arrival") {
        tab.card = undefined;
        tab.changed();
      }
      return;
    }
    // Only where a sign-in starts: not on the sign-in service's own next pages.
    const shown = tab.trail.filter((h) => h.committed);
    const before = shown.at(-2);
    if (before && isIdentityUrl(before.url)) return;
    if (!this.settings().notice || tab.signInWindow || tab.card || tab.handoff) return;
    const way = this.way();
    if (way.kind !== "window") return;
    const host = siteHost(url) ?? "";
    if (this.hosts.automatic(host)) {
      trace("auto-window", { host });
      return void this.openWindow(tab, { auto: true });
    }
    if (this.hosts.choice(host) === "here") return;
    tab.card = { stage: "arrival", site: host, host, way: "window", browser: way.app.name };
    tab.changed();
  }

  /** Back on the site after bringing a sign-in over: a sign-in page that stays (or asks for a
   * passkey) means the site did not take the sign-in; a site page that stays means it did. */
  private returnStep(tab: Tab, url: string) {
    const returning = tab.returning!;
    clearTimeout(returning.timer);
    returning.shown = true;
    if (Date.now() > returning.until) {
      tab.returning = undefined;
      return;
    }
    const identity = isIdentityUrl(url);
    returning.timer = setTimeout(
      () => {
        if (tab.returning !== returning) return;
        if (identity) return this.loop(tab);
        trace("returned", { url: redactUrl(url) });
        tab.returning = undefined;
      },
      identity ? Number(process.env.KEY_SIGNIN_LOOP_MS) || 2500 : 3000,
    );
  }

  /** The site sent Key's browser to the sign-in page again after the sign-in came back: stop,
   * and say so (it may tie sign-ins to the browser they were made in). */
  private loop(tab: Tab) {
    const returning = tab.returning;
    if (!returning) return;
    clearTimeout(returning.timer);
    tab.returning = undefined;
    trace("loop", { entry: redactUrl(returning.entry), failed: returning.failed });
    this.stopRequests(tab);
    tab.pending.clear();
    clearTimeout(tab.timer);
    tab.waiting = undefined;
    tab.contents.stop();
    tab.imported = undefined;
    tab.card = { stage: "loop", site: returning.site, way: "window", browser: returning.browser, failed: returning.failed, host: this.signInHost(tab) };
    tab.loopEntry = returning.entry;
    tab.changed();
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
    if (this.settings().notice && !tab.aside && !tab.signInWindow && !tab.handoff && !tab.card) {
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
    if (way.kind === "window" && isIdentityUrl(contents.getURL())) return { offer: { browser } };
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
      hosts: this.hosts.list(),
    };
  }

  /** Settings: change or forget what is remembered for a sign-in service. */
  setHost(host: string, choice: HostChoice | null) {
    if (typeof host !== "string" || !host) return;
    this.hosts.set(host.toLowerCase(), choice === "window" || choice === "here" ? choice : undefined);
  }

  /** Settings › Forget sign-ins: closes any sign-in window and removes Key's sign-in profiles. */
  async forget() {
    await Promise.all([...this.tabs.values()].map((t) => t.signInWindow?.close()));
    await Promise.all([...this.kept].map((w) => w.close()));
    this.kept.clear();
    await forgetSignInProfiles(SignInService.profileRoot());
  }

  async op(contents: WebContents, op: SignInOp, url?: string) {
    const tab = this.tabs.get(contents.id);
    if (!tab) return;
    const card = tab.card;
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
    } else if (op === "signin-here") {
      // Arrival: sign in in Key's own browser (a password works here), remembered.
      if (card?.host) this.hosts.set(card.host, "here");
      tab.card = undefined;
      // The page already asks for a passkey: the usual card follows.
      if (tab.pending.size) tab.timer = setTimeout(() => void this.showWaiting(tab), 300);
    } else if (op === "signin-key-instead") {
      // The window opened by itself: close it, sign in here, and remember that.
      const host = card?.host ?? this.signInHost(tab);
      if (host) this.hosts.set(host, "here");
      const window = tab.signInWindow;
      tab.signInWindow = undefined;
      tab.card = undefined;
      await window?.close();
    } else if (op === "signin-cancel") {
      tab.handoff = undefined;
      tab.card = undefined;
      const window = tab.signInWindow;
      tab.signInWindow = undefined;
      await window?.close();
    } else if (op === "signin-window") {
      // Chosen here (arrival or a page waiting for a passkey): remembered for the service.
      const host = card?.host ?? this.signInHost(tab);
      if (host && card?.stage !== "failed" && card?.stage !== "where") this.hosts.set(host, "window");
      void this.openWindow(tab);
    } else if (op === "signin-pick") {
      const picked = card?.stage === "where" ? card.entries?.find((e) => e.url === url) : undefined;
      if (picked) void this.openWindow(tab, { entry: picked.url });
    } else if (op === "signin-keep") void this.keepWindow(tab);
    else if (op === "signin-done") tab.signInWindow?.signedInNow();
    else if (op === "signin-focus") await tab.signInWindow?.focus();
    else if (op === "signin-get-browser") {
      if (!process.env.KEY_BROWSER_SMOKE) void shell.openExternal(GET_BROWSER_URL);
    } else if (op === "signin-browser") {
      const entry = signInEntry(tab.trail, tab.opener, this.pendingHosts(tab)) ?? contents.getURL();
      const hosts = chainHosts(tab.trail, entry, contents.getURL(), tab.waiting?.rpId);
      const way = this.way();
      const target = way.kind === "handoff" ? way : { browser: knownBrowsers().find((b) => b.id === way.app.id), appName: way.app.name };
      this.stopRequests(tab);
      this.clearWaiting(tab);
      tab.card = undefined;
      tab.handoff = { browser: target.browser, appName: target.appName, url: entry, hosts };
      await openIn(target.browser, entry);
    } else if (op === "signin-import") await this.importSignIn(tab);
    tab.changed();
  }

  /** Hosts where this tab's pages asked for a passkey: sign-in pages, whatever they are called. */
  private pendingHosts(tab: Tab) {
    const pending = [tab.waiting, ...tab.pending.values()].filter((p): p is Pending => !!p);
    return [...new Set(pending.flatMap((p) => [p.host, p.rpId]).filter((h): h is string => !!h))];
  }

  private bounds(tab: Tab) {
    try {
      return (tab.window() as Electron.BaseWindow | undefined)?.getBounds();
    } catch {
      return undefined;
    }
  }

  /** After a loop: the site is used in the sign-in window, which stays open (until Key quits). */
  private async keepWindow(tab: Tab) {
    const way = this.way(await this.refreshBrowsers());
    const entry = tab.loopEntry;
    tab.card = undefined;
    tab.changed();
    if (way.kind !== "window" || !entry) return;
    const window = await SignInWindow.open({
      app: way.app,
      profileDir: join(SignInService.profileRoot(), way.app.id),
      url: entry,
      near: this.bounds(tab),
      headless: !!process.env.KEY_SIGNIN_HEADLESS || process.env.KEY_TEST_MODE === "1",
      keep: true,
    }).catch(() => undefined);
    if (!window) return;
    this.kept.add(window);
    void window.ended.then(() => this.kept.delete(window));
  }

  /** Opens the sign-in window on the page of the site this sign-in is for (never on a sign-in
   * page's address), waits for the sign-in there, brings its cookies over and takes the tab
   * back to that page. */
  private async openWindow(tab: Tab, options: { auto?: boolean; entry?: string } = {}) {
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
    const known = this.pendingHosts(tab);
    const current = tab.contents.getURL();
    const host = this.signInHost(tab);
    const entry = options.entry ?? signInEntry(tab.trail, tab.opener, known);
    trace("window-entry", {
      entry: entry ? redactUrl(entry) : null,
      current: redactUrl(current),
      opener: tab.opener ? redactUrl(tab.opener) : null,
      hops: tab.trail.map((h) => `${h.committed ? "page" : "redirect"}${h.dwell !== undefined ? `(${h.dwell}ms)` : ""} ${redactUrl(h.url)}`),
    });
    if (!entry) {
      // Key cannot tell which site this sign-in is for, and must not start on the sign-in
      // page's own address: the person says where they were going.
      const seen = new Set<string>();
      const entries = [...tab.trail]
        .reverse()
        .map((h) => h.url)
        .concat(tab.opener ? [tab.opener] : [])
        // The site a sign-in request says it returns to: its home page (never the request).
        .concat(tab.trail.map((h) => returnSite(h.url)).filter((u): u is string => !!u))
        .filter((u) => !isIdentityUrl(u, known) && !seen.has(u) && (seen.add(u), true))
        .slice(0, 5)
        .map((u) => ({ url: u, label: pageLabel(u) }));
      tab.card = { stage: "where", site: host ?? siteHost(current) ?? "", way: "window", browser: way.app.name, entries, host };
      return tab.changed();
    }
    const site = siteHost(entry) ?? "";
    this.stopRequests(tab);
    this.clearWaiting(tab);
    tab.handoff = undefined;
    tab.card = { stage: "open", site, way: "window", browser: way.app.name, auto: options.auto, host };
    tab.changed();
    let window: SignInWindow;
    try {
      window = await SignInWindow.open({
        app: way.app,
        profileDir: join(SignInService.profileRoot(), way.app.id),
        url: entry,
        identityHosts: known,
        near: this.bounds(tab),
        // Test runs (main/test-mode.ts) never put a window on screen.
        headless: !!process.env.KEY_SIGNIN_HEADLESS || process.env.KEY_TEST_MODE === "1",
        virtualAuthenticator: !!(process.env.KEY_BROWSER_SMOKE && process.env.KEY_SIGNIN_VIRTUAL_AUTHENTICATOR),
        onHop: (url) => trace("window-hop", { url: redactUrl(url) }),
      });
    } catch (error) {
      if (tab.card?.stage === "open") tab.card = { stage: "failed", site, way: "window", browser: way.app.name, problem: (error as Error).message };
      return tab.changed();
    }
    if (tab.card?.stage !== "open" || tab.contents.isDestroyed()) return void window.close();
    tab.signInWindow = window;
    const end = await window.ended;
    trace("window-end", { kind: end.kind, url: "url" in end && end.url ? redactUrl(end.url) : null });
    if (tab.signInWindow !== window) return; // cancelled, or the tab is gone
    tab.signInWindow = undefined;
    const fail = async (problem: string) => {
      await window.close();
      tab.card = { stage: "failed", site, way: "window", browser: way.app.name, problem };
      tab.changed();
    };
    if (end.kind !== "signed-in") return fail(end.kind === "failed" ? end.problem : "The sign-in window was closed before the sign-in was finished.");
    // The cookies of the sites this sign-in went through, in Key's tab and in the window.
    const hosts = new Set([...chainHosts(tab.trail, entry, current, waiting?.rpId), ...window.hosts]);
    const found = await window.cookies(hosts).catch(() => ({ cookies: [], partitioned: [] }));
    await window.close();
    if (!found.cookies.length) return fail(`No sign-in came back from ${way.app.name}. Try again, and finish signing in there before you choose I’m signed in.`);
    const ses = browserSession();
    const failed = found.partitioned.map((c) => `${c.name} (partitioned)`);
    let set = 0;
    for (const cookie of found.cookies)
      await ses.cookies.set(windowCookie(cookie)).then(
        () => set++,
        () => failed.push(`${cookie.name} (not accepted)`),
      );
    await ses.cookies.flushStore().catch(() => undefined);
    trace("cookies", { set, failed, sites: cookieSites(found.cookies) });
    if (!set) return fail("The sign-in came back, but Key’s browser did not accept it.");
    tab.card = undefined;
    // Back to the site, where it started: it sees the sign-in and lets the tab in.
    tab.returning = { entry, site, until: Date.now() + 30_000, failed, browser: way.app.name };
    void tab.contents.loadURL(entry).catch(() => undefined);
    const names = cookieSites(found.cookies);
    setTimeout(() => {
      if (tab.card) return;
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

/** The home page of the site a sign-in request returns to (OAuth `redirect_uri`, WS-Fed
 * `wreply`), if the address names one. */
export function returnSite(url: string) {
  try {
    const u = new URL(url);
    const back = u.searchParams.get("redirect_uri") || u.searchParams.get("wreply");
    if (!back) return undefined;
    const site = new URL(back);
    return /^https?:$/.test(site.protocol) && !isIdentityUrl(site.origin + "/") ? `${site.origin}/` : undefined;
  } catch {
    return undefined;
  }
}

/** A page for the "where were you going" list: its site and path, without the query. */
function pageLabel(url: string) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : "";
    return `${u.hostname.replace(/^www\./, "")}${path.length > 40 ? path.slice(0, 39) + "…" : path}`;
  } catch {
    return url;
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
