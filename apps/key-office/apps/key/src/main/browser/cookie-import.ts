// "Sign in with your browser": reads the cookies of a few named sites from another browser's
// profile on this Mac, so a sign-in finished there (a passkey Key's browser cannot use) carries
// over to Key's browser. Read-only: the cookie database is copied to a temporary folder and only
// rows for the given sites are read from the copy. Nothing here touches Electron, so it is tested
// with fixture profiles (KEY_COOKIE_IMPORT_HOME points every browser root at a test folder).
import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

export type BrowserId = "chrome" | "edge" | "brave" | "arc" | "vivaldi" | "chromium" | "firefox" | "safari";
export interface BrowserInfo {
  id: BrowserId;
  name: string;
  kind: "chromium" | "firefox" | "safari";
  /** The browser's data folder. */
  root: string;
  /** Chromium browsers keep the key to their cookies in the login keychain. */
  keychain?: { service: string; account: string };
}
export interface ImportedCookie {
  /** The cookie's domain as the browser stores it: `.example.edu` covers subdomains. */
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  /** Seconds since 1970; none for a session cookie. */
  expires?: number;
}

const CHROMIUM: Array<[BrowserId, string, string, string]> = [
  ["chrome", "Google Chrome", "Google/Chrome", "Chrome"],
  ["edge", "Microsoft Edge", "Microsoft Edge", "Microsoft Edge"],
  ["brave", "Brave", "BraveSoftware/Brave-Browser", "Brave"],
  ["arc", "Arc", "Arc/User Data", "Arc"],
  ["vivaldi", "Vivaldi", "Vivaldi", "Vivaldi"],
  ["chromium", "Chromium", "Chromium", "Chromium"],
];

/** The browsers Key knows how to read, wherever they keep their data (installed or not). */
export function knownBrowsers(env: NodeJS.ProcessEnv = process.env): BrowserInfo[] {
  const home = env.KEY_COOKIE_IMPORT_HOME || homedir();
  const support = join(home, "Library", "Application Support");
  return [
    ...CHROMIUM.map(([id, name, folder, keychain]): BrowserInfo => ({
      id,
      name,
      kind: "chromium",
      root: join(support, folder),
      keychain: { service: `${keychain} Safe Storage`, account: keychain },
    })),
    { id: "firefox", name: "Firefox", kind: "firefox", root: join(support, "Firefox") },
    { id: "safari", name: "Safari", kind: "safari", root: join(home, "Library") },
  ];
}

/** Which browser an app name is (`app.getApplicationNameForProtocol`), if Key can read it. */
export function browserOfAppName(name: string | undefined): BrowserId | undefined {
  const n = (name ?? "").toLowerCase();
  if (/chrome/.test(n) && !/chromium/.test(n)) return "chrome";
  if (/edge/.test(n)) return "edge";
  if (/brave/.test(n)) return "brave";
  if (/^arc\b/.test(n)) return "arc";
  if (/vivaldi/.test(n)) return "vivaldi";
  if (/chromium/.test(n)) return "chromium";
  if (/firefox/.test(n)) return "firefox";
  if (/safari/.test(n)) return "safari";
  return undefined;
}

/** A site's address without scheme, port or path, lowercased. */
export function siteHost(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** The stored cookie domains that apply to `hosts`: each host itself (host-only), and it and
 * every parent domain with a leading dot. Public suffixes never carry cookies, so asking for
 * `.ac.uk` finds nothing; single labels (`.edu`) are left out. */
export function cookieDomainsFor(hosts: string[]) {
  const out = new Set<string>();
  for (const raw of hosts) {
    const host = raw.toLowerCase().replace(/^\./, "");
    if (!host || /[^a-z0-9.-]/.test(host)) continue;
    out.add(host);
    const labels = host.split(".");
    for (let i = 0; i < labels.length - 1; i++) out.add(`.${labels.slice(i).join(".")}`);
  }
  return [...out];
}
const sqlList = (values: string[]) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");

function run(file: string, args: string[], timeout = 15_000) {
  return new Promise<string>((resolve, reject) =>
    execFile(file, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve(String(stdout)),
    ),
  );
}
/** Runs a query on a read-only copy of a SQLite database (macOS's own sqlite3). */
async function query<T>(file: string, sql: string): Promise<T[]> {
  const out = await run(process.env.KEY_SQLITE3 || "/usr/bin/sqlite3", ["-readonly", "-json", file, sql]);
  return out.trim() ? (JSON.parse(out) as T[]) : [];
}
/** Copies a database (and its journal) into a fresh temporary folder: the browser may be open. */
async function withCopy<T>(file: string, work: (copy: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "key-cookie-import-"));
  try {
    const copy = join(dir, basename(file));
    await copyFile(file, copy);
    for (const suffix of ["-wal", "-journal"]) await copyFile(file + suffix, copy + suffix).catch(() => undefined);
    return await work(copy);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const exists = (file: string) => stat(file).then((s) => s.isFile(), () => false);

export type ProfileProblem = "missing" | "no-access";
export interface CookieSource {
  browser: BrowserInfo;
  /** The cookie database (a SQLite file, or Safari's Cookies.binarycookies). */
  file?: string;
  /** The profile in use (Chromium and Firefox keep several). */
  profile?: string;
  problem?: ProfileProblem;
}

/** Finds the cookie file of the profile the browser used last. */
export async function locateCookies(browser: BrowserInfo): Promise<CookieSource> {
  if (browser.kind === "chromium") {
    let profile = "Default";
    try {
      const state = JSON.parse(await readFile(join(browser.root, "Local State"), "utf8"));
      if (typeof state?.profile?.last_used === "string" && state.profile.last_used) profile = state.profile.last_used;
    } catch {
      /* no Local State: the default profile */
    }
    for (const file of [join(browser.root, profile, "Cookies"), join(browser.root, profile, "Network", "Cookies")])
      if (await exists(file)) return { browser, file, profile };
    return { browser, profile, problem: "missing" };
  }
  if (browser.kind === "firefox") {
    const profile = await firefoxProfile(browser.root);
    const file = profile && join(profile, "cookies.sqlite");
    return file && (await exists(file)) ? { browser, file, profile: basename(profile) } : { browser, problem: "missing" };
  }
  for (const file of [
    join(browser.root, "Containers", "com.apple.Safari", "Data", "Library", "Cookies", "Cookies.binarycookies"),
    join(browser.root, "Cookies", "Cookies.binarycookies"),
  ]) {
    try {
      await readFile(file, { flag: "r" }).then((b) => b.subarray(0, 0));
      return { browser, file };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return { browser, file, problem: "no-access" };
    }
  }
  return { browser, problem: "missing" };
}

/** Firefox's profile in use: the install's default, else the profile marked default. */
export async function firefoxProfile(root: string) {
  let ini: string;
  try {
    ini = await readFile(join(root, "profiles.ini"), "utf8");
  } catch {
    return undefined;
  }
  const sections: Array<Record<string, string>> = [];
  for (const line of ini.split(/\r?\n/)) {
    const head = /^\[(.+)\]$/.exec(line.trim());
    if (head) sections.push({ __name: head[1] });
    else {
      const kv = /^([^=]+)=(.*)$/.exec(line.trim());
      if (kv && sections.length) sections[sections.length - 1][kv[1]] = kv[2];
    }
  }
  const resolve = (p: string, relative = "1") => (relative === "1" ? join(root, p) : p);
  const install = sections.find((s) => s.__name.startsWith("Install") && s.Default);
  if (install) return resolve(install.Default);
  const marked = sections.find((s) => s.__name.startsWith("Profile") && s.Default === "1" && s.Path) ?? sections.find((s) => s.__name.startsWith("Profile") && s.Path);
  return marked ? resolve(marked.Path, marked.IsRelative) : undefined;
}

interface ChromiumRow {
  host_key: string;
  name: string;
  value: string;
  ev: string;
  path: string;
  expires_utc: number;
  has_expires: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}
interface FirefoxRow {
  host: string;
  name: string;
  value: string;
  path: string;
  expiry: number;
  isSecure: number;
  isHttpOnly: number;
  sameSite: number;
}

const CHROMIUM_EPOCH_OFFSET_S = 11_644_473_600;
const SAME_SITE: Record<number, ImportedCookie["sameSite"]> = { 0: "no_restriction", 1: "lax", 2: "strict" };

/** What a source holds for the sites: Chromium values still encrypted (no keychain yet). */
export interface FoundCookies {
  source: CookieSource;
  /** Readable without the keychain: which site, how many. */
  cookies: Array<Omit<ImportedCookie, "value"> & { value?: string; encrypted?: Buffer }>;
  /** Chromium's cookie database version (24 and later prefix values with a hash of the host). */
  dbVersion?: number;
}

/** Reads the sites' cookies from a source. Chromium values stay encrypted until `decrypt`. */
export async function findCookies(source: CookieSource, hosts: string[]): Promise<FoundCookies> {
  const domains = cookieDomainsFor(hosts);
  if (!source.file || source.problem || !domains.length) return { source, cookies: [] };
  const file = source.file;
  if (source.browser.kind === "safari") {
    const all = parseBinaryCookies(await readFile(file));
    const wanted = new Set(domains);
    return { source, cookies: all.filter((c) => wanted.has(c.host.toLowerCase())) };
  }
  return withCopy(file, async (copy) => {
    if (source.browser.kind === "firefox") {
      const rows = await query<FirefoxRow>(
        copy,
        `select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite from moz_cookies where host in (${sqlList(domains)}) and originAttributes = ''`,
      );
      const now = Date.now() / 1000;
      return {
        source,
        cookies: rows
          .map((r) => ({
            host: r.host,
            name: r.name,
            value: r.value,
            path: r.path || "/",
            secure: !!r.isSecure,
            httpOnly: !!r.isHttpOnly,
            sameSite: SAME_SITE[r.sameSite] ?? "unspecified",
            // Newer Firefox stores milliseconds.
            expires: r.expiry > 1e11 ? Math.floor(r.expiry / 1000) : r.expiry,
          }))
          .filter((c) => !c.expires || c.expires > now),
      };
    }
    const version = await query<{ value: string }>(copy, "select value from meta where key = 'version'").catch(() => []);
    const base = `select host_key, name, value, hex(encrypted_value) as ev, path, expires_utc, has_expires, is_secure, is_httponly, samesite from cookies where host_key in (${sqlList(domains)})`;
    // Partitioned cookies (set inside another site's frame) stay where they are.
    const rows = await query<ChromiumRow>(copy, `${base} and top_frame_site_key = ''`).catch(() => query<ChromiumRow>(copy, base));
    const now = Date.now() / 1000;
    return {
      source,
      dbVersion: Number(version[0]?.value) || 0,
      cookies: rows
        .map((r) => {
          const expires = r.has_expires && r.expires_utc ? Math.floor(r.expires_utc / 1e6 - CHROMIUM_EPOCH_OFFSET_S) : undefined;
          const encrypted = r.ev ? Buffer.from(r.ev, "hex") : undefined;
          return {
            host: r.host_key,
            name: r.name,
            ...(encrypted?.length ? { encrypted } : { value: r.value }),
            path: r.path || "/",
            secure: !!r.is_secure,
            httpOnly: !!r.is_httponly,
            sameSite: SAME_SITE[r.samesite] ?? "unspecified",
            expires,
          };
        })
        .filter((c) => !c.expires || c.expires > now),
    };
  });
}

/** Sites and how many cookies each, for the question before anything is imported. */
export function summarize(found: FoundCookies) {
  const counts = new Map<string, number>();
  for (const c of found.cookies) {
    const site = c.host.replace(/^\./, "");
    counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  return [...counts].map(([site, count]) => ({ site, count })).sort((a, b) => a.site.localeCompare(b.site));
}

/** Chromium's cookie key on macOS, from the keychain password ("<Browser> Safe Storage"). */
export function chromiumKey(password: string) {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}
/** One Chromium cookie value: `v10` + AES-128-CBC (IV of spaces); version 24+ databases put
 * SHA-256(host) before the value. Undefined when it does not decrypt (another key, or an
 * unknown format). */
export function decryptChromiumValue(encrypted: Buffer, key: Buffer, host: string, dbVersion: number) {
  if (encrypted.subarray(0, 3).toString("latin1") !== "v10") return undefined;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    if (dbVersion >= 24 && plain.length >= 32 && plain.subarray(0, 32).equals(createHash("sha256").update(host).digest())) plain = plain.subarray(32);
    return plain.toString("utf8");
  } catch {
    return undefined;
  }
}

/** The keychain password a Chromium browser keeps its cookie key under. macOS asks the person
 * first ("security wants to use … Chrome Safe Storage"); refusing rejects. */
export async function keychainPassword(keychain: { service: string; account: string }) {
  const out = await run("/usr/bin/security", ["find-generic-password", "-w", "-s", keychain.service, "-a", keychain.account], 120_000);
  return out.replace(/\n$/, "");
}

/** Decrypts what was found (Chromium), dropping values that do not decrypt. */
export function decrypt(found: FoundCookies, key?: Buffer): ImportedCookie[] {
  const out: ImportedCookie[] = [];
  for (const c of found.cookies) {
    const { encrypted, ...rest } = c;
    const value = encrypted ? (key ? decryptChromiumValue(encrypted, key, c.host, found.dbVersion ?? 0) : undefined) : c.value;
    if (value !== undefined) out.push({ ...rest, value });
  }
  return out;
}
export const needsKeychain = (found: FoundCookies) => found.cookies.some((c) => c.encrypted);

/** Safari's Cookies.binarycookies: big-endian page table, little-endian pages of records. */
export function parseBinaryCookies(buffer: Buffer): ImportedCookie[] {
  if (buffer.length < 8 || buffer.subarray(0, 4).toString("latin1") !== "cook") throw Error("Not a binarycookies file");
  const pages = buffer.readUInt32BE(4);
  const sizes: number[] = [];
  for (let i = 0; i < pages; i++) sizes.push(buffer.readUInt32BE(8 + i * 4));
  const out: ImportedCookie[] = [];
  const MAC_EPOCH_OFFSET_S = 978_307_200;
  const now = Date.now() / 1000;
  let at = 8 + pages * 4;
  for (const size of sizes) {
    const page = buffer.subarray(at, at + size);
    at += size;
    if (page.length < 8 || page.readUInt32BE(0) !== 0x00000100) continue;
    const count = page.readUInt32LE(4);
    for (let i = 0; i < count; i++) {
      const offset = page.readUInt32LE(8 + i * 4);
      const record = page.subarray(offset, offset + page.readUInt32LE(offset));
      if (record.length < 56) continue;
      const text = (o: number) => {
        const start = record.readUInt32LE(o);
        if (!start || start >= record.length) return "";
        const end = record.indexOf(0, start);
        return record.subarray(start, end < 0 ? record.length : end).toString("utf8");
      };
      const flags = record.readUInt32LE(8);
      const expires = Math.floor(record.readDoubleLE(40) + MAC_EPOCH_OFFSET_S);
      if (expires && expires < now) continue;
      out.push({
        host: text(16),
        name: text(20),
        path: text(24) || "/",
        value: text(28),
        secure: (flags & 1) !== 0,
        httpOnly: (flags & 4) !== 0,
        sameSite: "unspecified",
        expires: expires || undefined,
      });
    }
  }
  return out;
}

/** The `cookies.set` details for one imported cookie (Electron's shape). */
export function electronCookie(c: ImportedCookie) {
  const host = c.host.replace(/^\./, "");
  return {
    url: `${c.secure ? "https" : "http"}://${host}${c.path.startsWith("/") ? c.path : `/${c.path}`}`,
    name: c.name,
    value: c.value,
    ...(c.host.startsWith(".") ? { domain: c.host } : {}),
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    ...(c.expires ? { expirationDate: c.expires } : {}),
  };
}
