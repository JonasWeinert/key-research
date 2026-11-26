// What Key has learned about library access per network: for each proxy, whether this
// network reaches its sites directly (on campus, a university VPN) or needs the proxy, and
// per site where a split tunnel or a choice made in the bar differs. No Electron here.
//
// A network is known only by a hash of what it looks like (see network.ts) and a label for
// the settings list. Nothing here leaves the machine.

export type ProxyMode = "auto" | "always" | "never";
export type Route = "direct" | "proxy";
/** How an outcome was learned. */
export type LearnedHow = "probe" | "page" | "fetch" | "bounce" | "user";

export interface ProxyOutcome {
  /** "pending": one site loaded directly, not yet enough to decide. */
  access: Route | "pending";
  how: LearnedHow;
  at: number;
  /** Sites that loaded directly on this network (two are needed to call it "direct"). */
  granted?: string[];
  /** Sites that wanted the proxy while the network was "direct" (a split tunnel). */
  denied?: string[];
}
export interface HostOutcome {
  access: Route;
  how: LearnedHow;
  at: number;
}
export interface LearnedNetwork {
  /** A hash of the network's look (gateway, DNS); never the details themselves. */
  id: string;
  label: string;
  firstSeen: number;
  lastSeen: number;
  /** By proxy id. */
  proxies: Record<string, ProxyOutcome>;
  /** By host name. */
  hosts: Record<string, HostOutcome>;
  /** When each proxy was last probed here (by proxy id). */
  probed?: Record<string, number>;
}

/** How a page or fetch should go. "try" loads directly and checks; "ask" loads directly and
 * offers the proxy when the page wants a sign-in (the Never mode). */
export type Decision = "direct" | "proxy" | "try" | "ask";
export interface DecisionWhy {
  decision: Decision;
  /** What the bar can say about it. */
  because: "always" | "never" | "user" | "domain" | "learned" | "site" | "unknown" | "offline";
}

const MAX_NETWORKS = 40;
const MAX_HOSTS = 400;
const GRANTS_FOR_DIRECT = 2;
const DENIALS_FOR_PROXY = 3;
export const PROBE_EVERY_MS = 24 * 60 * 60_000;

/** How a page of `host` (a site of `proxyId`) goes on `network`. */
export function decide(input: {
  mode: ProxyMode;
  network?: LearnedNetwork;
  /** The network is offline or could not be told (no learning, no redirect guessing). */
  offline?: boolean;
  proxyId: string;
  host: string;
  /** The machine's domain matches one the proxy is set to skip (Zotero's option). */
  domainMatch?: boolean;
}): DecisionWhy {
  const { mode, network, proxyId, host } = input;
  if (mode === "always") return { decision: "proxy", because: "always" };
  if (mode === "never") return { decision: "ask", because: "never" };
  const site = network?.hosts[host];
  if (site?.how === "user") return { decision: site.access, because: "user" };
  const raw = network?.proxies[proxyId];
  const outcome = raw && raw.access !== "pending" ? (raw as ProxyOutcome & { access: Route }) : undefined;
  if (outcome?.how === "user") return { decision: outcome.access, because: "user" };
  if (input.domainMatch) return { decision: "direct", because: "domain" };
  if (site) return { decision: site.access, because: "site" };
  if (outcome) return { decision: outcome.access, because: "learned" };
  return { decision: "try", because: input.offline ? "offline" : "unknown" };
}

/** A new network entry. */
export function newNetwork(id: string, label: string, now: number): LearnedNetwork {
  return { id, label, firstSeen: now, lastSeen: now, proxies: {}, hosts: {} };
}

const capHosts = (hosts: Record<string, HostOutcome>) => {
  const entries = Object.entries(hosts);
  if (entries.length <= MAX_HOSTS) return hosts;
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_HOSTS));
};
const add = (list: string[] | undefined, host: string) => [...new Set([...(list ?? []), host])].slice(-8);

/** What one direct attempt (or a probe, or a proxy bouncing straight back) teaches. Returns
 * the network as it is now; the input is not changed. */
export function learn(network: LearnedNetwork, event: { proxyId: string; host?: string; access: Route; how: Exclude<LearnedHow, "user">; now: number }): LearnedNetwork {
  const { proxyId, host, access, how, now } = event;
  const next: LearnedNetwork = { ...network, lastSeen: now, proxies: { ...network.proxies }, hosts: { ...network.hosts } };
  if (host && next.hosts[host]?.how !== "user") next.hosts[host] = { access, how, at: now };
  next.hosts = capHosts(next.hosts);
  const outcome = next.proxies[proxyId];
  if (outcome?.how === "user") return next;
  if (access === "direct") {
    const granted = host ? add(outcome?.granted, host) : outcome?.granted;
    // A probe or a bounce speaks for the whole network; pages count once two sites agree
    // (one open site, or a split tunnel, is not the network).
    const direct = how === "probe" || how === "bounce" || (granted?.length ?? 0) >= GRANTS_FOR_DIRECT;
    if (direct) next.proxies[proxyId] = { access: "direct", how, at: now, ...(granted ? { granted } : {}) };
    else if (outcome) next.proxies[proxyId] = { ...outcome, ...(granted ? { granted } : {}) };
    else if (granted) next.proxies[proxyId] = { access: "pending", how, at: now, granted };
    return next;
  }
  // Denied directly.
  if (outcome?.access === "direct" && host && how !== "probe") {
    const denied = add(outcome.denied, host);
    next.proxies[proxyId] = denied.length >= DENIALS_FOR_PROXY ? { access: "proxy", how, at: now } : { ...outcome, denied };
    return next;
  }
  next.proxies[proxyId] = { access: "proxy", how, at: now };
  return next;
}

/** A choice made in the bar or in Settings: for one site on this network, or for the proxy
 * on the whole network; `undefined` forgets it. */
export function choose(network: LearnedNetwork, target: { proxyId?: string; host?: string }, access: Route | undefined, now: number): LearnedNetwork {
  const next: LearnedNetwork = { ...network, proxies: { ...network.proxies }, hosts: { ...network.hosts } };
  if (target.host) {
    if (access) next.hosts[target.host] = { access, how: "user", at: now };
    else delete next.hosts[target.host];
  } else if (target.proxyId) {
    if (access) next.proxies[target.proxyId] = { access, how: "user", at: now };
    else {
      delete next.proxies[target.proxyId];
      // Forgetting the proxy here forgets what its sites learned too (not what you chose).
      for (const [host, outcome] of Object.entries(next.hosts)) if (outcome.how !== "user") delete next.hosts[host];
      if (next.probed) next.probed = Object.fromEntries(Object.entries(next.probed).filter(([id]) => id !== target.proxyId));
    }
  }
  return next;
}

/** Whether the proxy may be probed on this network now (at most once a day). */
export const mayProbe = (network: LearnedNetwork, proxyId: string, now: number) => network.probed?.[proxyId] === undefined || now - network.probed[proxyId] >= PROBE_EVERY_MS;

/** Networks as stored: checked, the most recently seen first, a bounded number. */
export function sanitizeNetworks(input: unknown, proxyIds?: Set<string>): LearnedNetwork[] {
  if (!Array.isArray(input)) return [];
  const routes = (v: unknown): v is ProxyOutcome["access"] => v === "direct" || v === "proxy" || v === "pending";
  const hows = new Set(["probe", "page", "fetch", "bounce", "user"]);
  const out: LearnedNetwork[] = [];
  for (const raw of input.slice(0, MAX_NETWORKS * 2)) {
    if (!raw || typeof raw !== "object") continue;
    const n = raw as Partial<LearnedNetwork>;
    if (typeof n.id !== "string" || !/^[a-f0-9]{8,64}$/.test(n.id) || out.some((o) => o.id === n.id)) continue;
    const proxies: Record<string, ProxyOutcome> = {};
    for (const [id, o] of Object.entries(n.proxies ?? {})) {
      if (!o || !routes(o.access) || !hows.has(o.how) || (proxyIds && !proxyIds.has(id))) continue;
      const hostsOf = (list: unknown) => (Array.isArray(list) ? list.filter((h): h is string => typeof h === "string").slice(-8) : undefined);
      proxies[id] = { access: o.access, how: o.how, at: Number(o.at) || 0, ...(hostsOf(o.granted)?.length ? { granted: hostsOf(o.granted) } : {}), ...(hostsOf(o.denied)?.length ? { denied: hostsOf(o.denied) } : {}) };
    }
    const hosts: Record<string, HostOutcome> = {};
    for (const [host, o] of Object.entries(n.hosts ?? {})) {
      if (!o || (o.access !== "direct" && o.access !== "proxy") || !hows.has(o.how) || !/^[a-z0-9.-]+$/.test(host)) continue;
      hosts[host] = { access: o.access, how: o.how, at: Number(o.at) || 0 };
    }
    const probed: Record<string, number> = {};
    for (const [id, at] of Object.entries(n.probed ?? {})) if (Number.isFinite(Number(at))) probed[id] = Number(at);
    out.push({
      id: n.id,
      label: String(n.label ?? "").slice(0, 80) || "Network",
      firstSeen: Number(n.firstSeen) || 0,
      lastSeen: Number(n.lastSeen) || 0,
      proxies,
      hosts: capHosts(hosts),
      ...(Object.keys(probed).length ? { probed } : {}),
    });
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_NETWORKS);
}
