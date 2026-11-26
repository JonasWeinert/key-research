// Library proxies (EZproxy, OpenAthens, institutional redirects) for the in-app browser, without
// Electron: what a proxy is, how a URL goes through one and back, and how one is recognised
// from what a page answered. Modelled on how the Zotero Connector treats proxies.
//
// A scheme is a URL pattern with variables: %h the host, %p the path (with its query), %d the
// directory, %f the file name, %u the whole URL (encoded), %a anything. `scheme` is how a URL
// is sent through the proxy (often a login URL with %u); `properScheme`, when given, is what
// pages look like once they come through it (for EZproxy `%h.ezproxy.uni.edu/%p`), which is how
// the proper URL is found again.

import { sanitizeNetworks, type LearnedNetwork, type ProxyMode } from "./access-state";

export type ProxySource = "manual" | "detected" | "zotero" | "connector";
export type ProxyKind = "ezproxy" | "openathens" | "redirect" | "custom";
export interface LibraryProxy {
  id: string;
  name: string;
  kind: ProxyKind;
  /** How a URL is sent through the proxy. */
  scheme: string;
  /** What a page reached through the proxy looks like (when it differs from `scheme`). */
  properScheme?: string;
  /** Sites (host names) that go through this proxy. */
  hosts: string[];
  /** Sites visited through the proxy are added to `hosts`. */
  autoAssociate: boolean;
  /** Proxied host names use hyphens for dots (EZproxy's HttpsHyphens): www-jstor-org. */
  dotsToHyphens: boolean;
  enabled: boolean;
  source: ProxySource;
  /** When this proxy is used; unset follows the global mode. */
  mode?: ProxyMode;
  /** Not used when the network's domain (or the Mac's name) contains one of these, as in
   * Zotero Connector's "disable when my computer's domain name contains…". */
  campusDomains?: string[];
}
export interface ProxyPrefs {
  /** Sites of a proxy go through it on their own (false is the "never" mode of old). */
  transparent: boolean;
  /** When proxies are used: only when this network needs them (auto), always, or never
   * (a page that asks for a sign-in offers it). */
  mode: ProxyMode;
  /** In auto mode, a page that turns out to want a sign-in reloads through the proxy on its own. */
  autoReload: boolean;
  /** Proxies are noticed while browsing, and offered to keep. */
  autoRecognize: boolean;
  /** Sites never sent through a proxy (and never added to one). */
  excluded: string[];
  /** Zotero's proxies are brought in again as Zotero syncs. */
  followZotero: boolean;
}
export interface ProxyData {
  prefs: ProxyPrefs;
  proxies: LibraryProxy[];
  /** What each network has shown about access (see access-state.ts). */
  networks: LearnedNetwork[];
}
export const DEFAULT_PREFS: ProxyPrefs = { transparent: true, mode: "auto", autoReload: true, autoRecognize: true, excluded: [], followZotero: false };
const MODES: ProxyMode[] = ["auto", "always", "never"];
const cleanDomains = (list: unknown) =>
  [...new Set((Array.isArray(list) ? list : []).map((d) => String(d).trim().toLowerCase().replace(/^\.+|\.+$/g, "")).filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(d)))].slice(0, 20);

const VARIABLES = ["%h", "%p", "%d", "%f", "%u", "%a"] as const;
type Variable = (typeof VARIABLES)[number];

/** A scheme as stored: trimmed, `{url}` (link resolvers' placeholder) as %u. */
export function normalizeScheme(value: string) {
  return value.trim().replace(/\{url\}/gi, "%u").replace(/\{host\}/gi, "%h").replace(/\{path\}/gi, "%p");
}

/** Why a scheme cannot work, or undefined when it can. */
export function schemeProblem(value: string) {
  const scheme = normalizeScheme(value);
  if (!scheme) return "Enter the proxy’s address";
  if (/\s/.test(scheme)) return "The address cannot contain spaces";
  const has = (v: Variable) => scheme.includes(v);
  if (!has("%u") && !has("%h")) return "The address needs %h (the site) or %u (the whole link)";
  if (has("%h") && !has("%u") && !has("%p") && !(has("%d") && has("%f"))) return "The address needs %p (the page) with %h";
  try {
    new URL(withProtocol(scheme.replace(/%[hpdfua]/g, "x"), "https:"));
  } catch {
    return "This is not a web address";
  }
  return undefined;
}

const withProtocol = (scheme: string, protocol: string) => (/^[a-z]+:\/\//i.test(scheme) ? scheme : `${protocol}//${scheme}`);

interface Compiled {
  regex: RegExp;
  variables: Variable[];
}
const compiled = new Map<string, Compiled | null>();
/** A scheme as a pattern over whole URLs, one group per variable. */
function compile(scheme: string): Compiled | null {
  if (compiled.has(scheme)) return compiled.get(scheme)!;
  const variables: Variable[] = [];
  let source = "";
  let rest = scheme.replace(/%%/g, "");
  if (!/^[a-z]+:\/\//i.test(rest)) source = "^https?://";
  else {
    // http and https both match: proxies answer on either.
    const [, protocol, after] = rest.match(/^([a-z]+):\/\/(.*)$/i)!;
    source = /^https?$/i.test(protocol) ? "^https?://" : `^${protocol}://`;
    rest = after;
  }
  for (const part of rest.split(/(%[hpdfua])/)) {
    if ((VARIABLES as readonly string[]).includes(part)) {
      const v = part as Variable;
      variables.push(v);
      source +=
        v === "%h" ? "([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)" : v === "%f" ? "([^/?#]*)" : v === "%u" ? "(.+)" : "(.*?)";
    } else source += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  let result: Compiled | null;
  try {
    result = { regex: new RegExp(`${source}$`, "i"), variables };
  } catch {
    result = null;
  }
  if (compiled.size > 200) compiled.clear();
  compiled.set(scheme, result);
  return result;
}

/** www.jstor.org ⇄ www-jstor-org (EZproxy writes a hyphen of the name as two). */
export const hyphenate = (host: string) => host.replace(/-/g, "--").replace(/\./g, "-");
export const unhyphenate = (host: string) => host.replace(/--/g, "\u0000").replace(/-/g, ".").replace(/\u0000/g, "-");

const parse = (value: string) => {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
};
const hostOf = (value: string) => parse(value)?.hostname.toLowerCase();

/** The schemes a proxied URL may match, the one pages come back as first. */
const recognised = (proxy: LibraryProxy) => [proxy.properScheme, proxy.scheme].filter((s): s is string => !!s);

/** The proper URL behind `url` when it came through `proxy`, else undefined. */
export function toProper(proxy: LibraryProxy, url: string): string | undefined {
  const target = parse(url);
  if (!target) return undefined;
  const href = target.toString();
  for (const scheme of recognised(proxy)) {
    const pattern = compile(scheme);
    const match = pattern && href.match(pattern.regex);
    if (!match) continue;
    const value = (v: Variable) => {
      const index = pattern.variables.indexOf(v);
      return index < 0 ? undefined : match[index + 1];
    };
    const whole = value("%u");
    if (whole !== undefined) {
      let decoded = whole;
      for (let i = 0; i < 3 && /^https?%3A/i.test(decoded); i++)
        try {
          decoded = decodeURIComponent(decoded);
        } catch {
          break;
        }
      const proper = parse(decoded);
      if (proper) return proper.toString();
      continue;
    }
    let host = value("%h") ?? proxy.hosts[0];
    if (!host) continue;
    if (proxy.dotsToHyphens && !host.includes(".")) host = unhyphenate(host);
    else if (!host.includes(".") && host.includes("-")) host = unhyphenate(host);
    if (!host.includes(".")) continue;
    const path = value("%p") ?? [value("%d"), value("%f")].filter((p) => p !== undefined).join("/");
    const proper = parse(`${target.protocol}//${host.toLowerCase()}/${path.replace(/^\/+/, "")}`);
    if (proper) return proper.toString();
  }
  return undefined;
}

/** Whether `url` is already a page of `proxy` (proxied, or the proxy's own login). */
export function isProxied(proxy: LibraryProxy, url: string) {
  if (toProper(proxy, url)) return true;
  const own = proxyHost(proxy);
  return !!own && hostOf(url) === own;
}

/** The proxy's own host (its login page's, or its redirector's). */
export function proxyHost(proxy: LibraryProxy) {
  return hostOf(withProtocol(proxy.scheme.replace(/%[hpdfua]/g, "x"), "https:"));
}

/** A readable name for a proxy: its own host (EZproxy's base for host patterns). */
export function proxyName(scheme: string) {
  return proxyHost({ scheme: scheme.replace(/%h[.-]/g, "") } as LibraryProxy) ?? "";
}

/** `url` sent through `proxy`, or undefined when it cannot go (or is through it already). */
export function toProxy(proxy: LibraryProxy, url: string): string | undefined {
  const target = parse(url);
  if (!target || isProxied(proxy, url)) return undefined;
  const scheme = proxy.scheme;
  if (scheme.includes("%u")) return scheme.replace(/%u/g, encodeURIComponent(target.toString())).replace(/%a/g, "");
  // A site on a port of its own cannot be named by its host alone.
  if (target.port) return undefined;
  const host = proxy.dotsToHyphens ? hyphenate(target.hostname) : target.hostname;
  const path = `${target.pathname.replace(/^\//, "")}${target.search}${target.hash}`;
  const directory = target.pathname.replace(/^\//, "").replace(/\/?[^/]*$/, "");
  const file = `${target.pathname.replace(/^.*\//, "")}${target.search}${target.hash}`;
  const filled = scheme.replace(/%[hpdfa]/g, (v) => (v === "%h" ? host : v === "%p" ? path : v === "%d" ? directory : v === "%f" ? file : ""));
  const out = parse(withProtocol(filled, target.protocol));
  return out?.toString();
}

/** A host as kept in a proxy's list: lower case, no port, no "www." dropped (sites differ). */
export function cleanHost(value: string) {
  const text = value.trim().toLowerCase();
  const host = hostOf(/^[a-z]+:\/\//.test(text) ? text : `https://${text}`) ?? "";
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : "";
}

/** The enabled proxy a URL came through, with its proper URL. */
export function findProxied(proxies: LibraryProxy[], url: string) {
  for (const proxy of proxies) {
    if (!proxy.enabled) continue;
    const proper = toProper(proxy, url);
    if (proper) return { proxy, proper };
  }
  return undefined;
}

/** The URL a page should be known by: the proper one when it came through a proxy. */
export function properUrl(proxies: LibraryProxy[], url: string) {
  return findProxied(proxies, url)?.proper ?? url;
}

/** The enabled proxy a site goes through (its hosts, a subdomain of one counts). */
export function proxyForHost(proxies: LibraryProxy[], host: string) {
  const name = host.toLowerCase();
  return proxies.find((p) => p.enabled && p.hosts.some((h) => h === name));
}

/** Whether a proxy only forwards (a redirector or link prefix): the page itself ends up on the
 * proper site, so it goes through at most once in a while (or it would loop). */
export const forwardsOnly = (proxy: LibraryProxy) => proxy.scheme.includes("%u") && !proxy.properScheme;

// ── Recognising proxies while browsing ──

/** A proxy seen in a response, offered to keep. */
export interface ProxyProposal {
  name: string;
  kind: ProxyKind;
  scheme: string;
  properScheme?: string;
  hosts: string[];
  dotsToHyphens: boolean;
}
/** An EZproxy login with the page it leads to. */
export interface PendingLogin {
  login: string;
  parameter: "url" | "qurl";
  target: string;
}

const header = (headers: Record<string, string | string[] | undefined>, name: string) => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
};
export const isEzproxyServer = (headers: Record<string, string | string[] | undefined>) => /^\s*ezproxy\b/i.test(header(headers, "server") ?? "");

/** An EZproxy login URL (`…/login?url=…` or `?qurl=…`) answered by EZproxy. */
export function ezproxyLogin(url: string, headers: Record<string, string | string[] | undefined>): PendingLogin | undefined {
  const at = parse(url);
  if (!at || !isEzproxyServer(headers) || !/\/login\/?$/i.test(at.pathname)) return undefined;
  const parameter = at.searchParams.has("qurl") ? "qurl" : at.searchParams.has("url") ? "url" : undefined;
  if (!parameter) return undefined;
  // `url` is the rest of the query, unencoded; `qurl` is one encoded value.
  const raw = parameter === "qurl" ? at.searchParams.get("qurl")! : at.search.replace(/^\?(.*&)?url=/i, "");
  let target = raw;
  for (let i = 0; i < 2 && /^https?%3A/i.test(target); i++) target = decodeURIComponent(target);
  if (!parse(target)) return undefined;
  return { login: `${at.origin}${at.pathname}`, parameter, target: parse(target)!.toString() };
}

/** What a page that came after an EZproxy login shows about the proxy: its proxied host is
 * the target's host (dotted or hyphenated) followed by the proxy's own name. */
export function ezproxyLanding(pending: PendingLogin, url: string): ProxyProposal | undefined {
  const at = parse(url);
  const target = parse(pending.target);
  if (!at || !target) return undefined;
  const host = at.hostname.toLowerCase();
  const proper = target.hostname.toLowerCase();
  const port = at.port ? `:${at.port}` : "";
  for (const [form, hyphens] of [
    [proper, false],
    [hyphenate(proper), true],
  ] as const) {
    if (!host.startsWith(`${form}.`) || host.length <= form.length + 1) continue;
    const base = host.slice(form.length + 1);
    return {
      name: base,
      kind: "ezproxy",
      scheme: `${pending.login}?${pending.parameter}=%u`,
      properScheme: `${at.protocol}//%h.${base}${port}/%p`,
      hosts: [proper],
      dotsToHyphens: hyphens,
    };
  }
  return undefined;
}

/** A page answered by EZproxy on a hyphenated host (www-jstor-org.ezproxy.uni.edu) without a
 * login seen first: the site and the proxy are told apart by the hyphens. */
export function ezproxyHost(url: string, headers: Record<string, string | string[] | undefined>): ProxyProposal | undefined {
  const at = parse(url);
  if (!at || !isEzproxyServer(headers)) return undefined;
  const [first, ...rest] = at.hostname.toLowerCase().split(".");
  if (rest.length < 2 || !first.includes("-")) return undefined;
  const proper = unhyphenate(first);
  if (!cleanHost(proper)) return undefined;
  const base = rest.join(".");
  const port = at.port ? `:${at.port}` : "";
  return { name: base, kind: "ezproxy", scheme: `${at.protocol}//%h.${base}${port}/%p`, hosts: [proper], dotsToHyphens: true };
}

/** An OpenAthens redirector link (go.openathens.net/redirector/<domain>?url=…). */
export function openAthensRedirect(url: string): ProxyProposal | undefined {
  const at = parse(url);
  if (!at || at.hostname.toLowerCase() !== "go.openathens.net") return undefined;
  const domain = at.pathname.match(/^\/redirector\/([^/]+)\/?$/i)?.[1];
  const target = at.searchParams.get("url");
  const proper = target && hostOf(target);
  if (!domain || !proper) return undefined;
  return { name: `OpenAthens (${domain})`, kind: "openathens", scheme: `https://go.openathens.net/redirector/${domain}?url=%u`, hosts: [proper], dotsToHyphens: false };
}

/** The proxy among `proxies` that is the one proposed (same address, either way round). */
export function sameProxy(proxies: LibraryProxy[], proposal: Pick<ProxyProposal, "scheme" | "properScheme">) {
  const keys = new Set([proposal.scheme, proposal.properScheme].filter(Boolean).map((s) => s!.toLowerCase().replace(/^https?:\/\//, "")));
  return proxies.find((p) => [p.scheme, p.properScheme].some((s) => s && keys.has(s.toLowerCase().replace(/^https?:\/\//, ""))));
}

// ── Stored data ──

const KINDS: ProxyKind[] = ["ezproxy", "openathens", "redirect", "custom"];
const SOURCES: ProxySource[] = ["manual", "detected", "zotero", "connector"];
export function sanitizeProxy(input: Partial<LibraryProxy> & { id?: string }, fallbackId: string): LibraryProxy | undefined {
  if (!input || typeof input !== "object") return undefined;
  const scheme = normalizeScheme(String(input.scheme ?? ""));
  if (schemeProblem(scheme)) return undefined;
  const properScheme = input.properScheme ? normalizeScheme(String(input.properScheme)) : undefined;
  const hosts = [...new Set((Array.isArray(input.hosts) ? input.hosts : []).map((h) => cleanHost(String(h))).filter(Boolean))].slice(0, 2000);
  const kind = KINDS.includes(input.kind as ProxyKind) ? (input.kind as ProxyKind) : guessKind(scheme);
  return {
    id: typeof input.id === "string" && /^[\w-]{1,64}$/.test(input.id) ? input.id : fallbackId,
    name: String(input.name ?? "").trim().slice(0, 120) || proxyName(scheme) || "Library proxy",
    kind,
    scheme,
    ...(properScheme && !schemeProblem(properScheme) && properScheme !== scheme ? { properScheme } : {}),
    hosts,
    autoAssociate: input.autoAssociate !== false,
    dotsToHyphens: input.dotsToHyphens === true,
    enabled: input.enabled !== false,
    source: SOURCES.includes(input.source as ProxySource) ? (input.source as ProxySource) : "manual",
    ...(MODES.includes(input.mode as ProxyMode) ? { mode: input.mode } : {}),
    ...(cleanDomains(input.campusDomains).length ? { campusDomains: cleanDomains(input.campusDomains) } : {}),
  };
}
export function guessKind(scheme: string): ProxyKind {
  if (/go\.openathens\.net\/redirector/i.test(scheme)) return "openathens";
  if (/\/login\?q?url=%u/i.test(scheme) || scheme.includes("%h")) return "ezproxy";
  if (scheme.includes("%u")) return "redirect";
  return "custom";
}
export function sanitizeData(input: unknown, newId: () => string): ProxyData {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<ProxyData>;
  const prefs = (raw.prefs ?? {}) as Partial<ProxyPrefs>;
  const proxies: LibraryProxy[] = [];
  for (const p of Array.isArray(raw.proxies) ? raw.proxies.slice(0, 100) : []) {
    const clean = sanitizeProxy(p, newId());
    if (clean && !proxies.some((q) => q.id === clean.id)) proxies.push(clean);
  }
  // Files from before modes: "Use library proxies automatically" off was Never.
  const mode = MODES.includes(prefs.mode as ProxyMode) ? (prefs.mode as ProxyMode) : prefs.transparent === false ? "never" : "auto";
  return {
    prefs: {
      transparent: mode !== "never",
      mode,
      autoReload: prefs.autoReload !== false,
      autoRecognize: prefs.autoRecognize !== false,
      excluded: [...new Set((Array.isArray(prefs.excluded) ? prefs.excluded : []).map((h) => cleanHost(String(h))).filter(Boolean))].slice(0, 500),
      followZotero: prefs.followZotero === true,
    },
    proxies,
    networks: sanitizeNetworks((raw as { networks?: unknown }).networks, new Set(proxies.map((p) => p.id))),
  };
}

/** Proxies brought in from elsewhere, merged into `proxies`: one with the same address gains
 * the hosts it lacks; others are added. Answers how many were added and how many grew. */
export function mergeProxies(proxies: LibraryProxy[], incoming: LibraryProxy[]) {
  const next = proxies.map((p) => ({ ...p, hosts: [...p.hosts] }));
  let added = 0;
  let updated = 0;
  for (const proxy of incoming) {
    const existing = sameProxy(next, proxy);
    if (!existing) {
      next.push(proxy);
      added++;
      continue;
    }
    const fresh = proxy.hosts.filter((h) => !existing.hosts.includes(h));
    if (fresh.length || (!existing.properScheme && proxy.properScheme && proxy.properScheme !== existing.scheme)) updated++;
    existing.hosts.push(...fresh);
    // A login address learned for a proxy only known by its host pattern.
    if (!existing.scheme.includes("%u") && proxy.scheme.includes("%u") && proxy.properScheme) {
      existing.properScheme = existing.scheme;
      existing.scheme = proxy.scheme;
    }
  }
  return { proxies: next, added, updated };
}

/** A Zotero Connector proxy (`proxies.proxies`: toProxyScheme, toProperScheme, hosts). */
export function fromConnector(input: any, id: string): LibraryProxy | undefined {
  if (!input || typeof input !== "object") return undefined;
  const proper = typeof input.toProperScheme === "string" ? input.toProperScheme : typeof input.scheme === "string" ? input.scheme : "";
  const toProxyScheme = typeof input.toProxyScheme === "string" && input.toProxyScheme ? input.toProxyScheme : proper;
  const openathens = input.type === "openathens";
  return sanitizeProxy(
    {
      id,
      name: openathens ? `OpenAthens (${toProxyScheme.match(/redirector\/([^/?]+)/i)?.[1] ?? "library"})` : proxyName(proper || toProxyScheme),
      kind: openathens ? "openathens" : undefined,
      scheme: toProxyScheme,
      properScheme: openathens ? undefined : proper,
      hosts: input.hosts,
      autoAssociate: input.autoAssociate !== false,
      // The Connector reads hyphens back as dots on its own; Key keeps it as a flag.
      dotsToHyphens: proper.includes("%h"),
      source: "connector",
    },
    id,
  );
}

/** A proxy from Zotero desktop's own tables (proxies: scheme, autoAssociate; proxyHosts). */
export function fromZoteroDesktop(row: { scheme: string; autoAssociate?: number | boolean }, hosts: string[], id: string) {
  const scheme = String(row.scheme ?? "");
  return sanitizeProxy(
    {
      id,
      name: proxyName(scheme),
      scheme,
      hosts,
      autoAssociate: !!row.autoAssociate,
      dotsToHyphens: scheme.includes("%h"),
      source: "zotero",
    },
    id,
  );
}
