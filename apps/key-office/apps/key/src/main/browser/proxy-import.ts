// Library proxies brought in from Zotero: Zotero's own tables (`proxies`, `proxyHosts` in
// zotero.sqlite, from the days Zotero itself proxied) and the Zotero Connector's settings in
// the browsers on this Mac (Chrome-family extension storage, Firefox, Safari). Read-only and
// best effort: files are copied to a temporary folder first, nothing is ever written back,
// and whatever cannot be read is skipped.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fromConnector, fromZoteroDesktop, type LibraryProxy } from "./proxies";

/** The Zotero Connector in the Chrome Web Store, and in Edge's add-ons. */
const CONNECTOR_IDS = ["ekhagklcjbdpajgpjgmbionohlpdbjgc", "nmhdhpibnnopknkmonacoephklnflpho"];
const FIREFOX_ID = "zotero@chnm.gmu.edu";
/** Chrome-family browsers' data folders under ~/Library/Application Support. */
const CHROMIUM_ROOTS = [
  "Google/Chrome",
  "Google/Chrome Beta",
  "Google/Chrome Canary",
  "Chromium",
  "BraveSoftware/Brave-Browser",
  "Microsoft Edge",
  "Vivaldi",
  "Arc/User Data",
  "Opera Software/Opera Stable",
];

export interface ImportedFrom {
  /** Where they were found ("Chrome (Profile 1)", "Zotero"). */
  label: string;
  proxies: LibraryProxy[];
}

/** The home folder the browsers' data is looked for in (automated checks point it at fixtures). */
const home = () => process.env.KEY_PROXY_IMPORT_HOME || homedir();

/** Every proxy Zotero has on this Mac: its desktop app's (in `dataDir`) and its Connectors'. */
export async function importProxies({ zotero = true, connector = true, dataDir }: { zotero?: boolean; connector?: boolean; dataDir?: string } = {}) {
  const found: ImportedFrom[] = [];
  const directory = dataDir || process.env.KEY_ZOTERO_DATA_DIR || join(homedir(), "Zotero");
  if (zotero) {
    const desktop = await fromZoteroDatabase(directory).catch(() => undefined);
    if (desktop) found.push(desktop);
  }
  if (connector) found.push(...(await fromConnectors().catch(() => [])));
  return found;
}

/** Proxies from Zotero desktop's zotero.sqlite in `dataDir`, when it has any. */
export async function fromZoteroDatabase(dataDir: string): Promise<ImportedFrom | undefined> {
  const file = join(dataDir, "zotero.sqlite");
  if (!existsSync(file)) return undefined;
  const read = async (path: string) => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const has = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('proxies', 'proxyHosts')").get() as { n: number };
      if (Number(has.n) < 2) return [];
      const rows = db.prepare("SELECT proxyID, autoAssociate, scheme FROM proxies").all() as { proxyID: number; autoAssociate: number; scheme: string }[];
      const hosts = db.prepare("SELECT proxyID, hostname FROM proxyHosts").all() as { proxyID: number; hostname: string }[];
      return rows.flatMap((row) => {
        const proxy = fromZoteroDesktop(row, hosts.filter((h) => h.proxyID === row.proxyID).map((h) => h.hostname), `zotero-${row.proxyID}`);
        return proxy ? [proxy] : [];
      });
    } finally {
      db.close();
    }
  };
  let proxies: LibraryProxy[];
  try {
    proxies = await read(file);
  } catch {
    // Zotero holds the file: a copy reads the same (Zotero writes its journal back on close).
    const folder = await mkdtemp(join(tmpdir(), "key-zotero-proxies-"));
    try {
      await copyFile(file, join(folder, "zotero.sqlite"));
      proxies = await read(join(folder, "zotero.sqlite")).catch(() => []);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  return proxies.length ? { label: "Zotero", proxies } : undefined;
}

/** Proxies the Zotero Connector keeps in every browser profile on this Mac. */
export async function fromConnectors(): Promise<ImportedFrom[]> {
  const found: ImportedFrom[] = [];
  const support = join(home(), "Library", "Application Support");
  for (const root of CHROMIUM_ROOTS) {
    const browser = join(support, root);
    const profiles = await readdir(browser).catch(() => [] as string[]);
    for (const profile of profiles)
      for (const id of CONNECTOR_IDS) {
        const folder = join(browser, profile, "Local Extension Settings", id);
        if (!existsSync(folder)) continue;
        const value = await readLevelDbValue(folder, "proxies.proxies").catch(() => undefined);
        const proxies = connectorList(value, `${root}-${profile}`);
        if (proxies.length) found.push({ label: `${browserName(root)} (${profile})`, proxies });
      }
  }
  // Firefox: the extension's storage.js (older versions keep it there; newer ones use
  // IndexedDB, which is not read).
  const firefox = join(support, "Firefox", "Profiles");
  for (const profile of await readdir(firefox).catch(() => [] as string[])) {
    const file = join(firefox, profile, "browser-extension-data", FIREFOX_ID, "storage.js");
    const text = await readFile(file, "utf8").catch(() => "");
    if (!text) continue;
    try {
      const proxies = connectorList(JSON.parse(text)["proxies.proxies"] ?? JSON.parse(text)["pref-proxies.proxies"], `firefox-${profile}`);
      if (proxies.length) found.push({ label: `Firefox (${profile.replace(/^[^.]*\./, "")})`, proxies });
    } catch {
      /* not JSON */
    }
  }
  // Safari: the extension's preferences hold the Connector's prefs as one JSON string.
  for (const container of ["org.zotero.SafariExtensionApp.SafariExtension", "org.zotero.zotero.SafariExtension"]) {
    const file = join(home(), "Library", "Containers", container, "Data", "Library", "Preferences", `${container}.plist`);
    if (!existsSync(file)) continue;
    const raw = await new Promise<string>((resolve) =>
      execFile("/usr/bin/plutil", ["-extract", "ConnectorPrefs", "raw", "-o", "-", file], { timeout: 5000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout)),
    );
    try {
      const prefs = raw ? JSON.parse(raw) : {};
      const proxies = connectorList(prefs["proxies.proxies"], `safari-${container}`);
      if (proxies.length) found.push({ label: "Safari", proxies });
    } catch {
      /* unreadable */
    }
  }
  return found;
}

const browserName = (root: string) =>
  ({ "Arc/User Data": "Arc", "BraveSoftware/Brave-Browser": "Brave", "Opera Software/Opera Stable": "Opera" })[root] ?? root.split("/").at(-1)!;

function connectorList(value: unknown, prefix: string): LibraryProxy[] {
  let list = value;
  for (let i = 0; i < 2 && typeof list === "string"; i++)
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  if (!Array.isArray(list)) return [];
  return list.flatMap((p, i) => {
    const proxy = fromConnector(p, `${prefix}-${p?.id ?? i}`.toLowerCase().replace(/[^\w-]+/g, "-").slice(0, 64));
    return proxy ? [proxy] : [];
  });
}

// ── A minimal, read-only LevelDB reader (the log and the sorted tables) ──

/** The newest value of `key` in a LevelDB folder, read from a copy of its files. */
export async function readLevelDbValue(folder: string, key: string): Promise<string | undefined> {
  const names = (await readdir(folder)).filter((n) => /\.(log|ldb|sst)$/.test(n));
  const copy = await mkdtemp(join(tmpdir(), "key-leveldb-"));
  try {
    let best: { seq: bigint; value?: string } | undefined;
    const keep = (k: Buffer, seq: bigint, value: Buffer | undefined) => {
      if (!k.toString("latin1").endsWith(key)) return;
      if (best && best.seq > seq) return;
      best = { seq, value: value?.toString("utf8") };
    };
    for (const name of names) {
      const source = join(folder, name);
      if ((await stat(source)).size > 64 * 1024 * 1024) continue;
      await copyFile(source, join(copy, name));
      const bytes = await readFile(join(copy, name));
      try {
        if (name.endsWith(".log")) readLog(bytes, keep);
        else readTable(bytes, keep);
      } catch {
        /* a damaged or unknown file: skipped */
      }
    }
    return best?.value;
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

type Keep = (key: Buffer, seq: bigint, value: Buffer | undefined) => void;

function varint(bytes: Buffer, at: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (let i = at; i < bytes.length; i++) {
    const b = bytes[i];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [result, i + 1];
    shift += 7;
    if (shift > 63) break;
  }
  throw Error("Bad varint");
}

function readLog(bytes: Buffer, keep: Keep) {
  const BLOCK = 32768;
  let at = 0;
  let pending: Buffer[] = [];
  while (at + 7 <= bytes.length) {
    const left = BLOCK - (at % BLOCK);
    if (left < 7) {
      at += left;
      continue;
    }
    const length = bytes.readUInt16LE(at + 4);
    const type = bytes[at + 6];
    const data = bytes.subarray(at + 7, at + 7 + length);
    at += 7 + length;
    if (type === 0) continue;
    if (type === 1) batch(data, keep);
    else if (type === 2) pending = [data];
    else if (type === 3) pending.push(data);
    else if (type === 4) {
      pending.push(data);
      batch(Buffer.concat(pending), keep);
      pending = [];
    }
  }
}

function batch(data: Buffer, keep: Keep) {
  if (data.length < 12) return;
  let seq = data.readBigUInt64LE(0);
  const count = data.readUInt32LE(8);
  let at = 12;
  for (let i = 0; i < count && at < data.length; i++, seq++) {
    const tag = data[at++];
    let length: number;
    [length, at] = varint(data, at);
    const key = data.subarray(at, at + length);
    at += length;
    if (tag === 1) {
      [length, at] = varint(data, at);
      keep(key, seq, data.subarray(at, at + length));
      at += length;
    } else keep(key, seq, undefined);
  }
}

function readTable(bytes: Buffer, keep: Keep) {
  if (bytes.length < 48) return;
  const footer = bytes.length - 48;
  let at = footer;
  [, at] = varint(bytes, at);
  [, at] = varint(bytes, at);
  let indexOffset: number, indexSize: number;
  [indexOffset, at] = varint(bytes, at);
  [indexSize] = varint(bytes, at);
  for (const [, handle] of blockEntries(block(bytes, indexOffset, indexSize))) {
    let offset: number, size: number, p: number;
    [offset, p] = varint(handle, 0);
    [size] = varint(handle, p);
    for (const [internal, value] of blockEntries(block(bytes, offset, size))) {
      if (internal.length < 8) continue;
      const trailer = internal.readBigUInt64LE(internal.length - 8);
      keep(internal.subarray(0, internal.length - 8), trailer >> 8n, (trailer & 0xffn) === 1n ? value : undefined);
    }
  }
}

function block(bytes: Buffer, offset: number, size: number) {
  const contents = bytes.subarray(offset, offset + size);
  const compression = bytes[offset + size];
  return compression === 1 ? unsnappy(contents) : contents;
}

function* blockEntries(data: Buffer): Generator<[Buffer, Buffer]> {
  const restarts = data.readUInt32LE(data.length - 4);
  const end = data.length - 4 - restarts * 4;
  let at = 0;
  let last = Buffer.alloc(0);
  while (at < end) {
    let shared: number, unshared: number, length: number;
    [shared, at] = varint(data, at);
    [unshared, at] = varint(data, at);
    [length, at] = varint(data, at);
    const key = Buffer.concat([last.subarray(0, shared), data.subarray(at, at + unshared)]);
    at += unshared;
    const value = data.subarray(at, at + length);
    at += length;
    last = key;
    yield [key, value];
  }
}

/** Snappy's block format, decompressed. */
function unsnappy(input: Buffer) {
  let [length, at] = varint(input, 0);
  const out = Buffer.alloc(length);
  let o = 0;
  while (at < input.length) {
    const tag = input[at++];
    const kind = tag & 3;
    if (kind === 0) {
      let size = (tag >> 2) + 1;
      if (size > 60) {
        const extra = size - 60;
        size = input.readUIntLE(at, extra) + 1;
        at += extra;
      }
      input.copy(out, o, at, at + size);
      at += size;
      o += size;
      continue;
    }
    let size: number, offset: number;
    if (kind === 1) {
      size = 4 + ((tag >> 2) & 7);
      offset = ((tag >> 5) << 8) | input[at++];
    } else if (kind === 2) {
      size = (tag >> 2) + 1;
      offset = input.readUInt16LE(at);
      at += 2;
    } else {
      size = (tag >> 2) + 1;
      offset = input.readUInt32LE(at);
      at += 4;
    }
    if (!offset || offset > o) throw Error("Bad snappy copy");
    for (let i = 0; i < size; i++, o++) out[o] = out[o - offset];
  }
  return out;
}
