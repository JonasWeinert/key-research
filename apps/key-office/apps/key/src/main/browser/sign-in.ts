// Passkey sign-ins in Key's browser. Electron services WebAuthn without a browser's passkey
// dialog: a USB or NFC security key works (touch it when it blinks), this Mac's Touch ID only
// in a signed copy of Key (app.configureWebAuthn needs a keychain-access-groups entitlement),
// and "use a phone or tablet" (the QR code) and iCloud Keychain passkeys not at all: Chromium
// draws those in Chrome's own UI, which Electron does not have, and Apple gives the system
// passkey sheet for any site only to web browsers it has approved. So a page that asks for a
// passkey would wait in silence; instead the bar says so (web-signin preload), lets the person
// stop waiting (the site then offers its other ways to sign in), or finish the sign-in in their
// usual browser and bring that sign-in back: only the cookies of the sites this sign-in went
// through, read from that browser's profile after asking (cookie-import.ts).
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

export type SignInBrowser = "default" | BrowserId;
export interface SignInSettings {
  /** Say in the bar when a page waits for a passkey. */
  notice: boolean;
  /** The browser sign-ins are finished in ("default": the system's default browser). */
  browser: SignInBrowser;
}
/** What the bar shows about a sign-in (see BrowserBar's SignInNotice). */
export interface SignInBar {
  /** A page has waited for a passkey or security key for a moment. */
  waiting?: { site: string; kind: "get" | "create"; browser?: string };
  /** The sign-in went to another browser: bring it back once it is done there. */
  handoff?: { browser: string; site: string };
  /** Sites whose sign-in was just brought over. */
  imported?: { browser: string; sites: number };
}
export type SignInOp = "signin-stop" | "signin-browser" | "signin-import" | "signin-cancel" | "signin-dismiss";

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
/** Sign-in services and the usual names of a university's own sign-in pages. */
const IDENTITY_HOST =
  /(^|\.)(login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|account\.live\.com|accounts\.google\.com|okta\.com|oktapreview\.com|okta-emea\.com|auth0\.com|onelogin\.com|duosecurity\.com|pingone\.com|pingidentity\.com|myopenathens\.net|openathens\.net)$|(^|\.)(idp|sso|login|signin|auth|shibboleth|adfs|cas|wayf|weblogin)[0-9-]*\./i;
const TRAIL_MS = 20 * 60_000;

interface Pending {
  kind: "get" | "create";
  rpId: string;
  frame: WebFrameMain | null;
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
  handoff?: { browser?: BrowserInfo; appName: string; url: string; hosts: string[] };
  imported?: { browser: string; sites: number };
}

/** The part of the tab's recent trail this sign-in is: where it started (the page before the
 * sign-in pages) and every site it went through since. */
export function signInChain(trail: Array<{ url: string; host: string }>, current: string, rpId?: string) {
  const entries = trail.length ? trail : [{ url: current, host: siteHost(current) ?? "" }];
  const identity = (i: number) => IDENTITY_HOST.test(entries[i].host);
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

export class SignInService {
  private tabs = new Map<number, Tab>();
  private touchId: "on" | "unsigned" | "unsupported" = process.platform === "darwin" ? "unsigned" : "unsupported";
  constructor(private readonly settings: () => SignInSettings) {}

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
      const key = `${event.senderFrame?.routingId ?? 0}:${Number(message.id) || 0}`;
      if (message.state === "start") {
        tab.pending.set(key, { kind: message.kind === "create" ? "create" : "get", rpId: String(message.rpId ?? "").slice(0, 253), frame: event.senderFrame });
        clearTimeout(tab.timer);
        tab.timer = setTimeout(() => this.showWaiting(tab), Number(process.env.KEY_SIGNIN_NOTICE_MS) || 2500);
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
    void this.configureTouchId();
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

  attach(contents: WebContents, hooks: { changed(): void; window(): BaseWindow | undefined }) {
    const tab: Tab = { contents, ...hooks, pending: new Map(), trail: [] };
    this.tabs.set(contents.id, tab);
    const note = (url: string) => {
      const host = siteHost(url);
      if (!host || !/^https?:/i.test(url)) return;
      const now = Date.now();
      tab.trail = [...tab.trail.filter((e) => now - e.at < TRAIL_MS && e.url !== url), { url, host, at: now }].slice(-40);
    };
    contents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument) return;
      note(event.url);
      // A new page: whatever the old one waited for is gone.
      tab.pending.clear();
      this.clearWaiting(tab);
      if (tab.imported) {
        tab.imported = undefined;
        tab.changed();
      }
    });
    contents.on("did-redirect-navigation", (event) => event.isMainFrame && note(event.url));
    contents.once("destroyed", () => {
      clearTimeout(tab.timer);
      this.tabs.delete(contents.id);
    });
  }

  private showWaiting(tab: Tab) {
    const first = [...tab.pending.values()][0];
    if (!first || tab.contents.isDestroyed()) return;
    tab.waiting = first;
    if (this.settings().notice) tab.changed();
  }
  private clearWaiting(tab: Tab) {
    clearTimeout(tab.timer);
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

  /** The browser sign-ins go to: the setting, else the system's default browser. */
  private target(choice = this.settings().browser): { browser?: BrowserInfo; appName: string } {
    const browsers = knownBrowsers();
    if (choice !== "default") {
      const browser = browsers.find((b) => b.id === choice)!;
      return { browser, appName: browser.name };
    }
    const appName = app.getApplicationNameForProtocol("https://") || "your browser";
    const id = browserOfAppName(appName);
    return { browser: browsers.find((b) => b.id === id), appName: id ? browsers.find((b) => b.id === id)!.name : appName.replace(/\.app$/, "") };
  }

  barState(contents: WebContents | undefined): SignInBar | undefined {
    const tab = contents && this.tabs.get(contents.id);
    if (!tab) return undefined;
    if (tab.handoff) return { handoff: { browser: tab.handoff.appName, site: siteHost(tab.handoff.url) ?? "" } };
    if (tab.imported) return { imported: tab.imported };
    if (tab.waiting && this.settings().notice) return { waiting: { site: tab.waiting.rpId, kind: tab.waiting.kind, browser: this.target().appName } };
    return undefined;
  }

  /** What Settings › Web & browser › Sign-in shows. */
  info() {
    return { defaultBrowser: this.target("default").appName, touchId: this.touchId };
  }

  async op(contents: WebContents, op: SignInOp) {
    const tab = this.tabs.get(contents.id);
    if (!tab) return;
    if (op === "signin-stop") {
      this.stopRequests(tab);
      this.clearWaiting(tab);
    } else if (op === "signin-dismiss") {
      tab.imported = undefined;
      this.clearWaiting(tab);
    } else if (op === "signin-cancel") {
      tab.handoff = undefined;
    } else if (op === "signin-browser") {
      const chain = signInChain(tab.trail, contents.getURL(), tab.waiting?.rpId);
      const target = this.target();
      this.stopRequests(tab);
      this.clearWaiting(tab);
      tab.handoff = { ...target, url: chain.url, hosts: chain.hosts };
      await openIn(target.browser, chain.url);
    } else if (op === "signin-import") await this.importSignIn(tab);
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
    // After the load starts (which clears notices), say what happened.
    setTimeout(() => {
      tab.imported = { browser: browser.name, sites: sites.length };
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
