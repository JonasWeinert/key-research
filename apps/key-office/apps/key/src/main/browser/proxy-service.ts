// Library proxies at work in the in-app browser: the stored list and preferences, sending a
// proxy's sites through it when this network needs it (main-frame navigations of browser
// tabs only), the proxies recognised from what pages answer, and what each tab's bar says.
//
// Need-based: in the Automatic mode a site goes through its proxy only where this network
// needs it. On a network not seen before a page loads directly first; when it turns out to
// want a sign-in (access.ts reads the answer and the page) it reloads through the proxy and
// the network is remembered as needing it. Where pages load directly (on campus, a
// university VPN) the network is remembered as direct and nothing is redirected there.
// Downloads made without a tab (an article's PDF, a saved page) go the same way.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { net, powerMonitor, type OnHeadersReceivedListenerDetails, type WebContents } from "electron";
import { browserSession, observeResponses } from "./profile";
import { classifyPage, classifyProbe, classifyResponse, pageFacts, PAGE_ACCESS_SCRIPT, sameSite, signInPage, type AccessVerdict } from "./access";
import { choose, decide, learn, mayProbe, newNetwork, type Decision, type DecisionWhy, type LearnedNetwork, type ProxyMode, type Route } from "./access-state";
import { currentNetwork, watchNetwork, type NetworkInfo } from "./network";
import {
  cleanHost,
  DEFAULT_PREFS,
  ezproxyHost,
  ezproxyLanding,
  ezproxyLogin,
  findProxied,
  forwardsOnly,
  isProxied,
  mergeProxies,
  openAthensRedirect,
  proxyForHost,
  proxyHost,
  sameProxy,
  sanitizeData,
  sanitizeProxy,
  toProxy,
  type LibraryProxy,
  type PendingLogin,
  type ProxyData,
  type ProxyPrefs,
  type ProxyProposal,
} from "./proxies";

/** What a browser tab's bar shows about proxies. */
export interface ProxyBarState {
  /** The page came through a proxy: its name, and the page's proper address. `redirected`:
   * just sent through it by Key (Undo is offered); `why` says what made it go. */
  via?: { name: string; proper: string; host: string; redirected?: boolean; why?: "network" | "signin" | "always" | "user"; reason?: string };
  /** Loaded directly where the proxy could have been used: why, with "Use the proxy" offered. */
  direct?: { name: string; host: string; why: "network" | "domain" | "site" | "bounce" };
  /** The page loaded directly wants a sign-in: the proxy is offered. */
  suggest?: { name: string; host: string; reason: string };
  /** A proxy seen on this page, offered to keep. */
  offer?: { name: string; host: string };
}
export type ProxyOp = "proxy-undo" | "proxy-off" | "proxy-remember" | "proxy-not-now" | "proxy-dismiss" | "proxy-use";

interface Attempt {
  host: string;
  url: string;
  proxyId: string;
  at: number;
  decision: Decision;
  because: DecisionWhy["because"];
}
interface TabState {
  contents: WebContents;
  changed(): void;
  pending?: PendingLogin & { responses: number };
  offer?: ProxyProposal;
  /** The last redirect through a proxy: where from, when, through what and why. */
  redirect?: { host: string; proper: string; proxyId: string; at: number; shown: boolean; why: NonNullable<ProxyBarState["via"]>["why"]; reason?: string };
  /** A page loaded directly that could have gone through a proxy, until it is judged. */
  attempt?: Attempt;
  /** What the bar says about a direct load. */
  notice?: { kind: "direct"; host: string; proxyId: string; why: NonNullable<ProxyBarState["direct"]>["why"] } | { kind: "suggest"; host: string; proxyId: string; url: string; reason: string };
  /** Hosts whose "loaded directly" notice this tab has shown (once each). */
  told: Set<string>;
  /** A site this tab goes to without its proxy (Undo), until it goes elsewhere. */
  bypass?: string;
}

const LOOP_MS = 10_000;
const LOOP_HOLD_MS = 60 * 60_000;
const FORWARD_EVERY_MS = 12 * 60 * 60_000;
const ATTEMPT_MS = 60_000;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};
const DENIED = Symbol("denied");
/** What a download made without a tab answers: what it got, and what that says about access. */
export type AccessRun<T> = { value: T; access: AccessVerdict } | typeof DENIED;
export const ACCESS_DENIED: typeof DENIED = DENIED;

let current: ProxyService | undefined;
/** The address a page should be known by: the proper one when it came through a proxy. */
export function properUrlOf(url: string): string;
export function properUrlOf(url: string | undefined): string | undefined;
export function properUrlOf(url: string | undefined) {
  if (!url || !current) return url;
  return findProxied(current.data.proxies, url)?.proper ?? url;
}
/** `url` through its site's proxy when this network is known to need it, else as it is. */
export function proxiedUrlOf(url: string) {
  return current?.through(url) ?? url;
}
/** Runs a download made without a tab the need-based way: directly first (unless this
 * network is known to need the proxy), once more through the proxy when the publisher
 * refused. `run` answers ACCESS_DENIED (or throws) when what came back was not the thing. */
export function withLibraryAccess<T>(url: string, run: (target: string) => Promise<AccessRun<T>>) {
  if (!current) return unwrap(run(url));
  return current.withAccess(url, run);
}
async function unwrap<T>(result: Promise<AccessRun<T>>) {
  const done = await result;
  if (done === DENIED) throw Error("The publisher asked for a sign-in");
  return done.value;
}
/** Judges a page loaded off screen (a saved page): its access, learned for the network. */
export function judgeLoadedPage(contents: WebContents, requested: string) {
  return current?.judgePage(contents, requested) ?? Promise.resolve(undefined);
}

export class ProxyService {
  data: ProxyData = { prefs: { ...DEFAULT_PREFS }, proxies: [], networks: [] };
  /** The network now (undefined while offline or not yet known). */
  network?: NetworkInfo;
  private tabs = new Map<number, TabState>();
  private loopHeld = new Map<string, number>();
  private forwarded = new Map<string, number>();
  private declined = new Set<string>();
  private listeners = new Set<() => void>();
  private probing = new Set<string>();

  constructor(private readonly path: string) {
    current = this;
  }

  async load() {
    try {
      this.data = sanitizeData(JSON.parse(await readFile(this.path, "utf8")), randomUUID);
    } catch {
      this.data = { prefs: { ...DEFAULT_PREFS }, proxies: [], networks: [] };
    }
    await this.refreshNetwork();
    watchNetwork(
      () => void this.refreshNetwork(),
      (listener) => {
        powerMonitor.on("resume", listener);
        powerMonitor.on("unlock-screen", listener);
      },
    );
    const ses = browserSession();
    ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      if (details.resourceType !== "mainFrame" || details.method !== "GET" || details.webContentsId === undefined) return callback({});
      const tab = this.tabs.get(details.webContentsId);
      if (!tab) return callback({});
      let redirectURL: string | undefined;
      try {
        redirectURL = this.redirectFor(tab, details.url);
      } catch {
        /* never in the way of a page */
      }
      callback(redirectURL ? { redirectURL } : {});
    });
    observeResponses((details) => {
      try {
        this.response(details);
      } catch {
        /* recognising is best effort */
      }
    });
    return this;
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data, null, 2));
    await rename(temporary, this.path);
    for (const listener of this.listeners) listener();
  }
  private commit(next: Partial<ProxyData>) {
    this.data = sanitizeData({ ...this.data, ...next }, randomUUID);
    for (const tab of this.tabs.values()) tab.changed();
    return this.save();
  }

  // ── Networks ──

  /** Looks at the network again; a different one starts from what it has learned (if any). */
  async refreshNetwork() {
    const next = await currentNetwork().catch(() => undefined);
    if (next?.id === this.network?.id) return;
    this.network = next;
    for (const tab of this.tabs.values()) {
      tab.attempt = undefined;
      tab.told.clear();
      tab.changed();
    }
    for (const listener of this.listeners) listener();
  }
  /** What this network has learned. */
  private learned(): LearnedNetwork | undefined {
    return this.network && this.data.networks.find((n) => n.id === this.network!.id);
  }
  /** Changes this network's entry (made on first use), and keeps it. */
  private updateNetwork(change: (network: LearnedNetwork) => LearnedNetwork, id = this.network?.id): Promise<void> {
    if (!id) return Promise.resolve();
    const now = Date.now();
    const existing = this.data.networks.find((n) => n.id === id);
    if (!existing && id !== this.network?.id) return Promise.resolve();
    const label = this.network?.suffix ?? `Network at ${new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const next = change(existing ?? newNetwork(id, label, now));
    return this.commit({ networks: [next, ...this.data.networks.filter((n) => n.id !== id)] });
  }
  private modeOf(proxy: LibraryProxy): ProxyMode {
    return proxy.mode ?? this.data.prefs.mode;
  }
  private domainMatch(proxy: LibraryProxy) {
    const domains = this.network?.domains ?? [];
    return !!proxy.campusDomains?.some((d) => domains.some((own) => own.includes(d)));
  }
  /** How `host` (a site of `proxy`) goes on this network. */
  private decision(proxy: LibraryProxy, host: string) {
    return decide({ mode: this.modeOf(proxy), network: this.learned(), offline: !this.network, proxyId: proxy.id, host, domainMatch: this.domainMatch(proxy) });
  }
  private teach(proxy: LibraryProxy, host: string | undefined, access: Route, how: "page" | "fetch" | "bounce" | "probe") {
    if (!this.network || this.modeOf(proxy) !== "auto") return;
    void this.updateNetwork((n) => learn(n, { proxyId: proxy.id, host, access, how, now: Date.now() }));
  }

  /** One cheap look at whether this network is on campus: the proxy's login asked, without
   * cookies, for one of its sites. At most once a day per network and proxy, on first need. */
  private probe(proxy: LibraryProxy, host: string) {
    const network = this.network;
    if (!network || forwardsOnly(proxy) || this.probing.has(proxy.id)) return;
    const entry = this.learned();
    if (entry && !mayProbe(entry, proxy.id, Date.now())) return;
    const target = `https://${host}/`;
    const url = toProxy(proxy, target);
    if (!url) return;
    this.probing.add(proxy.id);
    void this.updateNetwork((n) => ({ ...n, probed: { ...n.probed, [proxy.id]: Date.now() } }));
    const done = (facts?: { status: number; location?: string; contentType?: string }) => {
      this.probing.delete(proxy.id);
      if (!facts || this.network?.id !== network.id) return;
      const result = classifyProbe({ ...facts, url }, target, (u) => isProxied(proxy, u));
      if (result !== "unknown") this.teach(proxy, undefined, result, "probe");
    };
    try {
      // No cookies (useSessionCookies is off): a signed-in proxy session would say nothing.
      const request = net.request({ url, method: "GET", session: browserSession(), redirect: "manual" });
      const timer = setTimeout(() => (request.abort(), done()), 8000);
      request.on("redirect", (status, _method, location) => {
        clearTimeout(timer);
        request.abort();
        done({ status, location });
      });
      request.on("response", (response) => {
        clearTimeout(timer);
        const type = response.headers["content-type"];
        done({ status: response.statusCode, contentType: Array.isArray(type) ? type[0] : type });
        request.abort();
      });
      request.on("error", () => (clearTimeout(timer), done()));
      request.end();
    } catch {
      done();
    }
  }

  // ── Tabs ──

  /** A browser tab's page: proxies apply to it, and its bar hears about them. */
  attach(contents: WebContents, changed: () => void) {
    const id = contents.id;
    const tab: TabState = { contents, changed, told: new Set() };
    this.tabs.set(id, tab);
    contents.once("destroyed", () => this.tabs.delete(id));
    // A page loaded directly is judged once it has loaded (a moment later: some publishers
    // draw their access box after load).
    contents.on("did-finish-load", () => {
      if (!tab.attempt) return;
      const attempt = tab.attempt;
      setTimeout(() => {
        if (tab.attempt !== attempt || contents.isDestroyed()) return;
        void this.judgeTab(tab, attempt);
      }, 600);
    });
  }

  /** `url` through the proxy its site goes through, when this network needs it. */
  through(url: string) {
    const { prefs, proxies } = this.data;
    const host = hostOf(url);
    if (!host || prefs.excluded.includes(host) || findProxied(proxies, url)) return undefined;
    const proxy = proxyForHost(proxies, host);
    if (!proxy || forwardsOnly(proxy) || this.decision(proxy, host).decision !== "proxy") return undefined;
    return toProxy(proxy, url);
  }

  private redirectFor(tab: TabState, url: string) {
    const { prefs, proxies } = this.data;
    const host = hostOf(url);
    const now = Date.now();
    if (tab.bypass && tab.bypass !== host) tab.bypass = undefined;
    if (tab.attempt && (tab.attempt.host !== host || now - tab.attempt.at > ATTEMPT_MS) && !signInPage(url)) tab.attempt = undefined;
    if (tab.notice && tab.notice.host !== host) tab.notice = undefined;
    if (!host || tab.bypass === host || prefs.excluded.includes(host)) return undefined;
    if (findProxied(proxies, url)) return undefined;
    const proxy = proxyForHost(proxies, host);
    if (!proxy || proxyHost(proxy) === host) return undefined;
    const last = tab.redirect;
    // Back on the site unproxied right after sending it through: the proxy sent it back. On
    // campus EZproxy does that (the network is direct); otherwise the proxy does not serve the
    // site. Not again for a while, or the tab would loop.
    if (last && last.host === host && now - last.at < LOOP_MS && !forwardsOnly(proxy)) {
      this.loopHeld.set(host, now + LOOP_HOLD_MS);
      tab.redirect = undefined;
      if (this.modeOf(proxy) === "auto" && this.decision(proxy, host).because !== "user") {
        this.teach(proxy, host, "direct", "bounce");
        tab.notice = { kind: "direct", host, proxyId: proxy.id, why: "bounce" };
      }
      setImmediate(() => tab.changed());
      return undefined;
    }
    if ((this.loopHeld.get(host) ?? 0) > now) return undefined;
    const { decision, because } = this.decision(proxy, host);
    if (decision !== "proxy") {
      tab.attempt = { host, url, proxyId: proxy.id, at: now, decision, because };
      if (decision === "direct" && because !== "user" && !tab.told.has(host)) {
        tab.told.add(host);
        tab.notice = { kind: "direct", host, proxyId: proxy.id, why: because === "domain" ? "domain" : because === "site" ? "site" : "network" };
        setImmediate(() => tab.changed());
      }
      if (decision === "try") this.probe(proxy, host);
      return undefined;
    }
    // A redirector ends on the site itself: through it once in a while, not every page.
    if (forwardsOnly(proxy) && now - (this.forwarded.get(host) ?? 0) < FORWARD_EVERY_MS) return undefined;
    const target = toProxy(proxy, url);
    if (!target || (url.startsWith("https:") && target.startsWith("http:"))) return undefined;
    if (forwardsOnly(proxy)) this.forwarded.set(host, now);
    tab.attempt = undefined;
    tab.redirect = { host, proper: url, proxyId: proxy.id, at: now, shown: true, why: because === "always" ? "always" : because === "user" ? "user" : "network" };
    setImmediate(() => tab.changed());
    return target;
  }

  /** The page loaded directly: granted, denied, or nothing to say. */
  private async judgeTab(tab: TabState, attempt: Attempt) {
    const url = tab.contents.getURL();
    // Gone elsewhere (another site, a captive portal): nothing to learn.
    if (!sameSite(hostOf(url), attempt.host) && !signInPage(url)) return void (tab.attempt = undefined);
    let verdict: AccessVerdict | undefined;
    try {
      const facts = pageFacts(await tab.contents.executeJavaScriptInIsolatedWorld(1998, [{ code: PAGE_ACCESS_SCRIPT }], false));
      verdict = facts && classifyPage(facts);
    } catch {
      verdict = undefined;
    }
    if (tab.attempt !== attempt) return;
    tab.attempt = undefined;
    if (verdict?.access === "denied") return this.denied(tab, attempt, verdict);
    if (verdict?.access === "granted") this.granted(tab, attempt, verdict);
  }

  private granted(tab: TabState, attempt: Attempt, verdict: AccessVerdict) {
    const proxy = this.data.proxies.find((p) => p.id === attempt.proxyId);
    if (!proxy || !verdict.telling) return;
    this.teach(proxy, attempt.host, "direct", "page");
    if (attempt.decision === "try" && !tab.told.has(attempt.host)) {
      tab.told.add(attempt.host);
      tab.notice = { kind: "direct", host: attempt.host, proxyId: proxy.id, why: "site" };
      tab.changed();
    }
  }

  private denied(tab: TabState, attempt: Attempt, verdict: AccessVerdict) {
    const proxy = this.data.proxies.find((p) => p.id === attempt.proxyId);
    if (!proxy) return;
    tab.attempt = undefined;
    if (attempt.because !== "user") this.teach(proxy, attempt.host, "proxy", "page");
    const target = toProxy(proxy, attempt.url);
    const automatic = this.modeOf(proxy) === "auto" && this.data.prefs.autoReload && attempt.because !== "user";
    if (target && automatic && !(attempt.url.startsWith("https:") && target.startsWith("http:"))) {
      const now = Date.now();
      if (forwardsOnly(proxy)) this.forwarded.set(attempt.host, now);
      tab.notice = undefined;
      tab.redirect = { host: attempt.host, proper: attempt.url, proxyId: proxy.id, at: now, shown: true, why: "signin", reason: verdict.reason };
      void tab.contents.loadURL(target).catch(() => undefined);
    } else tab.notice = { kind: "suggest", host: attempt.host, proxyId: proxy.id, url: attempt.url, reason: verdict.reason };
    tab.changed();
  }

  private response(details: OnHeadersReceivedListenerDetails) {
    const tab = details.webContentsId === undefined ? undefined : this.tabs.get(details.webContentsId);
    if (!tab) return;
    const headers = details.responseHeaders ?? {};
    const header = (name: string) => headers[Object.keys(headers).find((k) => k.toLowerCase() === name) ?? ""]?.[0];
    const { prefs, proxies } = this.data;
    // The direct answer itself: a 401/403, or a redirect to a sign-in, settles it at once.
    const attempt = tab.attempt;
    if (attempt && sameSite(hostOf(details.url), attempt.host)) {
      const verdict = classifyResponse({ url: details.url, status: details.statusCode, location: header("location"), contentType: header("content-type") });
      if (verdict.access === "denied") setImmediate(() => tab.attempt === attempt && this.denied(tab, attempt, verdict));
    }
    // Sites seen through a proxy join it (autoAssociate), as in the Connector.
    const seen = findProxied(proxies, details.url);
    if (seen && seen.proxy.autoAssociate) {
      const host = hostOf(seen.proper);
      if (host && cleanHost(host) && !seen.proxy.hosts.includes(host) && !prefs.excluded.includes(host) && host !== proxyHost(seen.proxy))
        void this.commit({ proxies: proxies.map((p) => (p.id === seen.proxy.id ? { ...p, hosts: [...p.hosts, host] } : p)) });
    }
    if (!prefs.autoRecognize) return;
    const login = ezproxyLogin(details.url, headers);
    if (login) {
      tab.pending = { ...login, responses: 0 };
      const location = header("location");
      const landed = location && ezproxyLanding(login, new URL(location, details.url).toString());
      if (landed) this.propose(tab, landed);
      return;
    }
    if (tab.pending) {
      const landed = ezproxyLanding(tab.pending, details.url);
      if (landed) {
        tab.pending = undefined;
        return this.propose(tab, landed);
      }
      if (++tab.pending.responses > 20) tab.pending = undefined;
    }
    const athens = openAthensRedirect(details.url);
    if (athens) return this.propose(tab, athens);
    if (!seen) {
      const guessed = ezproxyHost(details.url, headers);
      if (guessed) this.propose(tab, guessed);
    }
  }

  /** A proxy seen while browsing: a known one learns the site (and a login address it
   * lacked); a new one is offered in the bar. */
  private propose(tab: TabState, proposal: ProxyProposal) {
    const { proxies, prefs } = this.data;
    const known = sameProxy(proxies, proposal);
    const hosts = proposal.hosts.filter((h) => !prefs.excluded.includes(h));
    if (known) {
      const incoming = sanitizeProxy({ ...proposal, hosts: known.autoAssociate ? hosts : [], source: "detected" }, randomUUID());
      if (!incoming) return;
      const merged = mergeProxies(proxies, [incoming]);
      if (merged.updated) void this.commit({ proxies: merged.proxies });
      return;
    }
    const key = (proposal.properScheme ?? proposal.scheme).toLowerCase();
    if (this.declined.has(key)) return;
    tab.offer = { ...proposal, hosts };
    tab.changed();
  }

  /** What the bar of the tab showing `url` says. */
  barState(contents: WebContents | undefined, url: string): ProxyBarState | undefined {
    const tab = contents && this.tabs.get(contents.id);
    if (!tab) return undefined;
    const state: ProxyBarState = {};
    const seen = findProxied(this.data.proxies, url);
    const redirect = tab.redirect;
    if (seen) {
      const redirected = !!redirect?.shown && redirect.proxyId === seen.proxy.id && hostOf(seen.proper) === redirect.host;
      state.via = { name: seen.proxy.name, proper: seen.proper, host: hostOf(seen.proper), ...(redirected ? { redirected, why: redirect!.why, ...(redirect!.reason ? { reason: redirect!.reason } : {}) } : {}) };
    } else if (redirect?.shown && hostOf(url) === redirect.host) {
      // A redirector (OpenAthens) lands on the site itself.
      const proxy = this.data.proxies.find((p) => p.id === redirect.proxyId);
      if (proxy && forwardsOnly(proxy)) state.via = { name: proxy.name, proper: url, host: redirect.host, redirected: true, why: redirect.why, ...(redirect.reason ? { reason: redirect.reason } : {}) };
    }
    const notice = tab.notice;
    const noticeProxy = notice && this.data.proxies.find((p) => p.id === notice.proxyId);
    if (!state.via && notice && noticeProxy && sameSite(hostOf(url), notice.host)) {
      if (notice.kind === "direct") state.direct = { name: noticeProxy.name, host: notice.host, why: notice.why };
      else state.suggest = { name: noticeProxy.name, host: notice.host, reason: notice.reason };
    }
    if (tab.offer) state.offer = { name: tab.offer.name, host: tab.offer.hosts[0] ?? "" };
    return state.via || state.offer || state.direct || state.suggest ? state : undefined;
  }

  /** The bar's buttons. A choice made here is kept for this site on this network. */
  async op(contents: WebContents, url: string, op: ProxyOp) {
    const tab = this.tabs.get(contents.id);
    if (!tab) return;
    const seen = findProxied(this.data.proxies, url);
    const proper = seen?.proper ?? tab.redirect?.proper ?? url;
    const host = hostOf(proper);
    const remember = (access: Route) => void this.updateNetwork((n) => choose(n, { host }, access, Date.now()));
    if (op === "proxy-dismiss") {
      if (tab.redirect) tab.redirect.shown = false;
      tab.notice = undefined;
    } else if (op === "proxy-undo") {
      const proxy = this.data.proxies.find((p) => p.id === tab.redirect?.proxyId);
      tab.redirect = undefined;
      tab.bypass = host;
      tab.told.add(host);
      if (proxy && this.modeOf(proxy) === "auto") remember("direct");
      void contents.loadURL(proper).catch(() => undefined);
    } else if (op === "proxy-use") {
      const proxy = proxyForHost(this.data.proxies, host) ?? this.data.proxies.find((p) => p.id === tab.notice?.proxyId);
      const target = proxy && toProxy(proxy, tab.notice?.kind === "suggest" ? tab.notice.url : proper);
      tab.notice = undefined;
      tab.attempt = undefined;
      if (proxy && target) {
        if (this.modeOf(proxy) === "auto") remember("proxy");
        tab.redirect = { host, proper, proxyId: proxy.id, at: Date.now(), shown: true, why: "user" };
        void contents.loadURL(target).catch(() => undefined);
      }
    } else if (op === "proxy-off") {
      tab.redirect = undefined;
      tab.notice = undefined;
      tab.bypass = host;
      const { prefs, proxies } = this.data;
      await this.commit({
        prefs: { ...prefs, excluded: [...prefs.excluded, host] },
        proxies: proxies.map((p) => ({ ...p, hosts: p.hosts.filter((h) => h !== host) })),
      });
      void contents.loadURL(proper).catch(() => undefined);
    } else if (op === "proxy-remember" && tab.offer) {
      const proxy = sanitizeProxy({ ...tab.offer, enabled: true, autoAssociate: true, source: "detected" }, randomUUID());
      tab.offer = undefined;
      if (proxy) await this.commit({ proxies: mergeProxies(this.data.proxies, [proxy]).proxies });
    } else if (op === "proxy-not-now" && tab.offer) {
      this.declined.add((tab.offer.properScheme ?? tab.offer.scheme).toLowerCase());
      tab.offer = undefined;
    }
    tab.changed();
  }

  // ── Downloads without a tab ──

  async withAccess<T>(url: string, run: (target: string) => Promise<AccessRun<T>>): Promise<T> {
    const host = hostOf(url);
    const { prefs, proxies } = this.data;
    const proxy = !host || prefs.excluded.includes(host) || findProxied(proxies, url) ? undefined : proxyForHost(proxies, host);
    const proxied = proxy && !forwardsOnly(proxy) ? toProxy(proxy, url) : undefined;
    if (!proxy || !proxied) return unwrap(run(url));
    const { decision, because } = this.decision(proxy, host);
    if (decision === "proxy") return unwrap(run(proxied));
    if (decision === "try") this.probe(proxy, host);
    const direct = await run(url).catch((error): AccessRun<T> => {
      if (/took too long|cancel/i.test(String(error?.message ?? error))) throw error;
      return DENIED;
    });
    if (direct !== DENIED) {
      if (direct.access.access === "granted" && direct.access.telling) this.teach(proxy, host, "direct", "fetch");
      return direct.value;
    }
    if (because !== "user") this.teach(proxy, host, "proxy", "fetch");
    if (decision === "ask" || because === "user") throw Error("The publisher asked for a sign-in");
    return unwrap(run(proxied));
  }

  /** A page loaded off screen, judged (and learned from) like a tab's. */
  async judgePage(contents: WebContents, requested: string) {
    try {
      const facts = pageFacts(await contents.executeJavaScriptInIsolatedWorld(1998, [{ code: PAGE_ACCESS_SCRIPT }], false));
      if (!facts) return undefined;
      if (!sameSite(hostOf(facts.url), hostOf(requested)) && !signInPage(facts.url) && !findProxied(this.data.proxies, facts.url)) return undefined;
      return classifyPage(facts);
    } catch {
      return undefined;
    }
  }

  // ── Settings ──

  snapshot() {
    return { ...structuredClone(this.data), network: this.network ? { id: this.network.id, suffix: this.network.suffix } : undefined };
  }
  async setPrefs(patch: Partial<ProxyPrefs>) {
    await this.commit({ prefs: { ...this.data.prefs, ...patch } });
    return this.snapshot();
  }
  async saveProxy(input: Partial<LibraryProxy>) {
    const existing = this.data.proxies.find((p) => p.id === input.id);
    const proxy = sanitizeProxy({ ...existing, ...input, source: existing?.source ?? "manual" }, randomUUID());
    if (!proxy) throw Error("This proxy address does not work");
    const proxies = existing ? this.data.proxies.map((p) => (p.id === proxy.id ? proxy : p)) : [...this.data.proxies, proxy];
    await this.commit({ proxies });
    return this.snapshot();
  }
  async removeProxy(id: string) {
    await this.commit({ proxies: this.data.proxies.filter((p) => p.id !== id) });
    return this.snapshot();
  }
  async merge(incoming: LibraryProxy[]) {
    const merged = mergeProxies(this.data.proxies, incoming);
    if (merged.added || merged.updated) await this.commit({ proxies: merged.proxies });
    return { added: merged.added, updated: merged.updated };
  }
  /** Settings' learned networks: forget one, or choose for a proxy there (direct, proxy, or
   * undefined to forget what it learned). */
  async networkOp(input: { op?: string; id?: string; proxyId?: string; host?: string; access?: Route }) {
    const id = String(input.id ?? "");
    const access = input.access === "direct" || input.access === "proxy" ? input.access : undefined;
    if (!this.data.networks.some((n) => n.id === id) && id !== this.network?.id) throw Error("This network is not known");
    if (input.op === "forget") await this.commit({ networks: this.data.networks.filter((n) => n.id !== id) });
    else if (input.op === "choose" && input.proxyId) await this.updateNetwork((n) => choose(n, { proxyId: input.proxyId }, access, Date.now()), id);
    else if (input.op === "choose-site" && input.host) await this.updateNetwork((n) => choose(n, { host: String(input.host) }, access, Date.now()), id);
    else throw Error("Unknown network action");
    for (const tab of this.tabs.values()) tab.told.clear();
    return this.snapshot();
  }
}
