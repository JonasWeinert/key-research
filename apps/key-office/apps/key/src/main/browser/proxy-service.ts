// Library proxies at work in the in-app browser: the stored list and preferences, the
// transparent redirect of a proxy's sites (main-frame navigations of browser tabs only), the
// proxies recognised from what pages answer, and what each tab's bar says about them.
// Like the Zotero Connector's transparent mode, with a quiet notice in place of its popups.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OnHeadersReceivedListenerDetails, WebContents } from "electron";
import { browserSession, observeResponses } from "./profile";
import {
  cleanHost,
  DEFAULT_PREFS,
  ezproxyHost,
  ezproxyLanding,
  ezproxyLogin,
  findProxied,
  forwardsOnly,
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
  /** The page came through a proxy: its name, and the page's proper address. */
  via?: { name: string; proper: string; host: string; /** Just sent through it by Key: Undo is offered. */ redirected?: boolean };
  /** A proxy seen on this page, offered to keep. */
  offer?: { name: string; host: string };
}
export type ProxyOp = "proxy-undo" | "proxy-off" | "proxy-remember" | "proxy-not-now" | "proxy-dismiss";

interface TabState {
  contents: WebContents;
  changed(): void;
  pending?: PendingLogin & { responses: number };
  offer?: ProxyProposal;
  /** The last transparent redirect: where from, when, and through what. */
  redirect?: { host: string; proper: string; proxyId: string; at: number; shown: boolean };
  /** A site this tab goes to without its proxy (Undo), until it goes elsewhere. */
  bypass?: string;
}

const LOOP_MS = 10_000;
const LOOP_HOLD_MS = 60 * 60_000;
const FORWARD_EVERY_MS = 12 * 60 * 60_000;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

let current: ProxyService | undefined;
/** The address a page should be known by: the proper one when it came through a proxy. */
export function properUrlOf(url: string): string;
export function properUrlOf(url: string | undefined): string | undefined;
export function properUrlOf(url: string | undefined) {
  if (!url || !current) return url;
  return findProxied(current.data.proxies, url)?.proper ?? url;
}
/** `url` through its site's proxy (for downloads made without a tab), else as it is. */
export function proxiedUrlOf(url: string) {
  return current?.through(url) ?? url;
}

export class ProxyService {
  data: ProxyData = { prefs: { ...DEFAULT_PREFS }, proxies: [] };
  private tabs = new Map<number, TabState>();
  private loopHeld = new Map<string, number>();
  private forwarded = new Map<string, number>();
  private declined = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(private readonly path: string) {
    current = this;
  }

  async load() {
    try {
      this.data = sanitizeData(JSON.parse(await readFile(this.path, "utf8")), randomUUID);
    } catch {
      this.data = { prefs: { ...DEFAULT_PREFS }, proxies: [] };
    }
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

  /** A browser tab's page: proxies apply to it, and its bar hears about them. */
  attach(contents: WebContents, changed: () => void) {
    const id = contents.id;
    this.tabs.set(id, { contents, changed });
    contents.once("destroyed", () => this.tabs.delete(id));
  }

  /** `url` through the proxy its site goes through, when it should go. */
  through(url: string) {
    const { prefs, proxies } = this.data;
    const host = hostOf(url);
    if (!host || prefs.excluded.includes(host) || findProxied(proxies, url)) return undefined;
    const proxy = proxyForHost(proxies, host);
    if (!proxy || forwardsOnly(proxy)) return undefined;
    return toProxy(proxy, url);
  }

  private redirectFor(tab: TabState, url: string) {
    const { prefs, proxies } = this.data;
    const host = hostOf(url);
    const now = Date.now();
    if (tab.bypass && tab.bypass !== host) tab.bypass = undefined;
    if (!prefs.transparent || !host || tab.bypass === host || prefs.excluded.includes(host)) return undefined;
    if (findProxied(proxies, url)) return undefined;
    const proxy = proxyForHost(proxies, host);
    if (!proxy || proxyHost(proxy) === host) return undefined;
    const last = tab.redirect;
    // Back on the site unproxied right after sending it through: the proxy sent it back (not
    // signed in, or not a site it serves). Not again for a while, or the tab would loop.
    if (last && last.host === host && now - last.at < LOOP_MS && !forwardsOnly(proxy)) {
      this.loopHeld.set(host, now + LOOP_HOLD_MS);
      tab.redirect = undefined;
      tab.changed();
      return undefined;
    }
    if ((this.loopHeld.get(host) ?? 0) > now) return undefined;
    // A redirector ends on the site itself: through it once in a while, not every page.
    if (forwardsOnly(proxy) && now - (this.forwarded.get(host) ?? 0) < FORWARD_EVERY_MS) return undefined;
    const target = toProxy(proxy, url);
    if (!target || (url.startsWith("https:") && target.startsWith("http:"))) return undefined;
    if (forwardsOnly(proxy)) this.forwarded.set(host, now);
    tab.redirect = { host, proper: url, proxyId: proxy.id, at: now, shown: true };
    setImmediate(() => tab.changed());
    return target;
  }

  private response(details: OnHeadersReceivedListenerDetails) {
    const tab = details.webContentsId === undefined ? undefined : this.tabs.get(details.webContentsId);
    if (!tab) return;
    const headers = details.responseHeaders ?? {};
    const { prefs, proxies } = this.data;
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
      const location = headers[Object.keys(headers).find((k) => k.toLowerCase() === "location") ?? ""]?.[0];
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
    if (seen) {
      const redirected = !!tab.redirect?.shown && tab.redirect.proxyId === seen.proxy.id && hostOf(seen.proper) === tab.redirect.host;
      state.via = { name: seen.proxy.name, proper: seen.proper, host: hostOf(seen.proper), ...(redirected ? { redirected } : {}) };
    } else if (tab.redirect?.shown && hostOf(url) === tab.redirect.host) {
      // A redirector (OpenAthens) lands on the site itself.
      const proxy = this.data.proxies.find((p) => p.id === tab.redirect!.proxyId);
      if (proxy && forwardsOnly(proxy)) state.via = { name: proxy.name, proper: url, host: tab.redirect.host, redirected: true };
    }
    if (tab.offer) state.offer = { name: tab.offer.name, host: tab.offer.hosts[0] ?? "" };
    return state.via || state.offer ? state : undefined;
  }

  /** The bar's buttons. */
  async op(contents: WebContents, url: string, op: ProxyOp) {
    const tab = this.tabs.get(contents.id);
    if (!tab) return;
    const seen = findProxied(this.data.proxies, url);
    const proper = seen?.proper ?? tab.redirect?.proper ?? url;
    const host = hostOf(proper);
    if (op === "proxy-dismiss") {
      if (tab.redirect) tab.redirect.shown = false;
    } else if (op === "proxy-undo") {
      tab.redirect = undefined;
      tab.bypass = host;
      void contents.loadURL(proper).catch(() => undefined);
    } else if (op === "proxy-off") {
      tab.redirect = undefined;
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

  // ── Settings ──

  snapshot() {
    return structuredClone(this.data);
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
}
