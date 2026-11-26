// Which network this Mac is on, for library access: a hash of the default gateway (its
// address and hardware address), the DNS servers and search domains, and the local IPv4
// subnets. No location services, no Wi-Fi name (macOS asks for location access to read it),
// nothing sent anywhere; only the hash and a label are kept. A change of interfaces, or the
// Mac waking, looks again.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";

export interface NetworkInfo {
  /** The hash that names the network. */
  id: string;
  /** For the settings list: the DNS search domain when there is one. */
  suffix?: string;
  /** Search domains and the Mac's own name, for "skip the proxy on these domains" (not stored). */
  domains: string[];
}

const run = (command: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(command, args, { timeout: 2500, maxBuffer: 1 << 20 }, (error, stdout) => resolve(error ? "" : String(stdout))));

/** The local IPv4 subnets (address & mask), not the addresses themselves (leases change). */
function subnets() {
  const out: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== "IPv4" || a.address.startsWith("169.254.")) continue;
      const ip = a.address.split(".").map(Number);
      const mask = a.netmask.split(".").map(Number);
      out.push(`${name.replace(/\d+$/, "")}:${ip.map((b, i) => b & mask[i]).join(".")}/${a.netmask}`);
    }
  }
  return out.sort();
}
/** A cheap look at the interfaces, to notice a change without running anything. */
export const interfacesSignature = () => subnets().join("|");

async function gateway(): Promise<{ ip?: string; mac?: string }> {
  let ip: string | undefined;
  if (process.platform === "darwin") ip = (await run("/sbin/route", ["-n", "get", "default"])).match(/gateway:\s*(\S+)/)?.[1];
  else if (process.platform === "linux") {
    const table = await readFile("/proc/net/route", "utf8").catch(() => "");
    const hex = table.split("\n").map((l) => l.trim().split(/\s+/)).find((f) => f[1] === "00000000")?.[2];
    if (hex) ip = [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join(".");
  }
  if (!ip || !/^[\d.]+$/.test(ip)) return { ip };
  const arp = process.platform === "darwin" ? await run("/usr/sbin/arp", ["-n", ip]) : await readFile("/proc/net/arp", "utf8").catch(() => "");
  const mac = arp.match(new RegExp(`${ip.replace(/\./g, "\\.")}\\D[^\\n]*?(([0-9a-f]{1,2}:){5}[0-9a-f]{1,2})`, "i"))?.[1]?.toLowerCase();
  return { ip, mac };
}

async function dns(): Promise<{ servers: string[]; search: string[] }> {
  let text = "";
  if (process.platform === "darwin") text = await run("/usr/sbin/scutil", ["--dns"]);
  else text = await readFile("/etc/resolv.conf", "utf8").catch(() => "");
  const servers = new Set<string>();
  const search = new Set<string>();
  for (const line of text.split("\n")) {
    const server = line.match(/^\s*(?:nameserver(?:\[\d+\])?\s*:?\s*)(\S+)/i)?.[1];
    if (server && !/^(127\.|::1|fe80)/i.test(server)) servers.add(server);
    const domain = line.match(/^\s*(?:search domain\[\d+\]|domain)\s*:\s*(\S+)/i)?.[1] ?? line.match(/^\s*(?:search|domain)\s+(.+)$/i)?.[1];
    for (const d of (domain ?? "").split(/\s+/)) if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d) && !/\.(local|arpa)$/i.test(d)) search.add(d.toLowerCase());
  }
  return { servers: [...servers].sort(), search: [...search] };
}

let simulated: NetworkInfo | null | undefined;
/** The smokes stand in a network of their own (a name, or null for offline). */
export function simulateNetwork(name: string | null) {
  simulated = name === null ? null : { id: createHash("sha256").update(`key-net-sim|${name}`).digest("hex").slice(0, 20), suffix: /\./.test(name) ? name : undefined, domains: /\./.test(name) ? [name] : [] };
}
if (process.env.KEY_BROWSER_SMOKE && process.env.KEY_SIMULATED_NETWORK) simulateNetwork(process.env.KEY_SIMULATED_NETWORK);

/** The network now, or undefined when offline. */
export async function currentNetwork(): Promise<NetworkInfo | undefined> {
  if (simulated !== undefined) return simulated ?? undefined;
  const nets = subnets();
  if (!nets.length) return undefined;
  const [gw, names] = await Promise.all([gateway(), dns()]);
  if (!gw.ip && !names.servers.length) return undefined;
  const id = createHash("sha256")
    .update(["key-net-v1", gw.ip ?? "", gw.mac ?? "", names.servers.join(","), names.search.join(","), nets.join(",")].join("|"))
    .digest("hex")
    .slice(0, 20);
  const own = hostname().toLowerCase();
  return { id, suffix: names.search[0], domains: [...names.search, ...(own.includes(".") ? [own] : [])] };
}

/** Calls `changed` when the interfaces change (checked every few seconds, cheaply) or the
 * Mac wakes; answers a stop function. */
export function watchNetwork(changed: () => void, wake?: (listener: () => void) => void) {
  let last = interfacesSignature();
  let pending: ReturnType<typeof setTimeout> | undefined;
  const soon = (ms: number) => {
    clearTimeout(pending);
    pending = setTimeout(changed, ms);
  };
  const timer = setInterval(() => {
    if (simulated !== undefined) return;
    const now = interfacesSignature();
    if (now !== last) {
      last = now;
      soon(3000);
    }
  }, 10_000);
  timer.unref?.();
  wake?.(() => soon(4000));
  return () => {
    clearInterval(timer);
    clearTimeout(pending);
  };
}
