// PDFs opened from the browser: kept in an app-managed folder and analysed in a hidden
// scratch library (layout, outline, references; no embeddings), never in the user's library.
// Unopened ones are removed after a while, and the oldest when the folder grows too large.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TempPdf {
  hash: string;
  /** Where the browser found it. */
  url: string;
  title: string;
  /** The PDF in the cache folder. */
  file: string;
  size: number;
  addedAt: number;
  lastOpened: number;
  /** Its source in the scratch library. */
  sourceId?: string;
}
/** The scratch library, as the registry reaches it. */
export interface ScratchLibrary {
  workspace(): Promise<{ id: string; root: string }>;
  invoke<T = any>(command: string, args: Record<string, unknown>, workspaceId: string): Promise<T>;
}
export const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_TTL = 7 * DAY;
export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

export async function fileSha256(path: string) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part as Buffer);
  return hash.digest("hex");
}
/** Whether the file starts like a PDF (a header may follow a little junk). */
export async function isPdfFile(path: string) {
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(1024);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead).includes(Buffer.from("%PDF-"));
  } finally {
    await file.close();
  }
}

export class TempPdfs {
  private entries: Record<string, TempPdf> = {};
  private loaded?: Promise<void>;
  private writing: Promise<unknown> = Promise.resolve();
  constructor(
    readonly dir: string,
    private readonly library: ScratchLibrary,
    private readonly now: () => number = Date.now,
  ) {}
  get pdfDir() {
    return join(this.dir, "pdfs");
  }
  /** A fresh path for a download in progress (inside the cache, so cleanup finds strays). */
  incomingPath(id: string) {
    return join(this.dir, "incoming", `${id}.pdf`);
  }
  private load() {
    this.loaded ??= (async () => {
      await mkdir(this.pdfDir, { recursive: true });
      await mkdir(join(this.dir, "incoming"), { recursive: true });
      try {
        const data = JSON.parse(await readFile(join(this.dir, "manifest.json"), "utf8"));
        if (data?.version === 1 && data.entries && typeof data.entries === "object")
          for (const [hash, entry] of Object.entries<any>(data.entries))
            if (/^[0-9a-f]{64}$/.test(hash) && typeof entry?.file === "string" && typeof entry?.url === "string") this.entries[hash] = entry;
      } catch {
        /* none yet, or unreadable: start over */
      }
      // Downloads cut short by a quit.
      await rm(join(this.dir, "incoming"), { recursive: true, force: true });
      await mkdir(join(this.dir, "incoming"), { recursive: true });
    })();
    return this.loaded;
  }
  private save() {
    const write = async () => {
      const temporary = join(this.dir, `manifest.${process.pid}.tmp`);
      await writeFile(temporary, JSON.stringify({ version: 1, entries: this.entries }, null, 1));
      await rename(temporary, join(this.dir, "manifest.json"));
    };
    const next = this.writing.then(write, write);
    this.writing = next.catch(() => undefined);
    return next;
  }
  async get(hash: string) {
    await this.load();
    const entry = this.entries[hash];
    return entry ? { ...entry } : undefined;
  }
  async list() {
    await this.load();
    return Object.values(this.entries).map((e) => ({ ...e }));
  }
  /** Takes a finished download into the cache and the scratch library. The file is moved. */
  async add(downloaded: string, url: string, title: string) {
    await this.load();
    if (!(await isPdfFile(downloaded))) {
      await rm(downloaded, { force: true });
      throw Error("The download is not a PDF");
    }
    const hash = await fileSha256(downloaded);
    const file = join(this.pdfDir, `${hash}.pdf`);
    if (this.entries[hash] && (await exists(file))) await rm(downloaded, { force: true });
    else await rename(downloaded, file);
    const { size } = await stat(file);
    const at = this.now();
    this.entries[hash] = { ...(this.entries[hash] ?? { addedAt: at }), hash, url, title, file, size, lastOpened: at };
    await this.analyse(hash);
    await this.save();
    return { ...this.entries[hash] };
  }
  /** Makes sure the scratch library has the PDF and is analysing it; answers its workspace. */
  async analyse(hash: string) {
    await this.load();
    const entry = this.entries[hash];
    if (!entry || !(await exists(entry.file))) throw Error("This PDF is no longer kept");
    const { id } = await this.library.workspace();
    const imported = await this.library.invoke<{ hash: string; id: string; existing?: boolean }>("library_import_file", { path: entry.file }, id);
    if (imported.hash !== hash) throw Error("The kept PDF changed on disk");
    entry.sourceId = imported.id;
    // The file is named by its hash; the source takes the name it had on the web instead
    // (identification may find the work's own title later).
    if (!imported.existing) await this.library.invoke("store_update", { id: imported.id, patch: { title: entry.title } }, id).catch(() => undefined);
    // Analysis (layout, outline, references) runs through the library's processing queue.
    await this.library.invoke("library_processing_control", { hash, action: "resume" }, id).catch(() => undefined);
    return id;
  }
  async touch(hash: string) {
    await this.load();
    const entry = this.entries[hash];
    if (!entry) return;
    entry.lastOpened = this.now();
    await this.save();
  }
  async setTitle(hash: string, title: string) {
    await this.load();
    const entry = this.entries[hash];
    if (!entry || !title || entry.title === title) return;
    entry.title = title.slice(0, 200);
    await this.save();
  }
  /** Removes PDFs not opened within `ttlMs`, then the least recently opened while the cache
   * holds more than `maxBytes`. PDFs in `keep` (open in a tab) are never removed. */
  async cleanup({ ttlMs = DEFAULT_TTL, maxBytes = DEFAULT_MAX_BYTES, keep = new Set<string>() }: { ttlMs?: number; maxBytes?: number; keep?: Set<string> } = {}) {
    await this.load();
    const now = this.now();
    const removed: string[] = [];
    const all = Object.values(this.entries).sort((a, b) => a.lastOpened - b.lastOpened);
    for (const entry of all) if (!keep.has(entry.hash) && now - entry.lastOpened > ttlMs) removed.push(entry.hash);
    let total = all.filter((e) => !removed.includes(e.hash)).reduce((sum, e) => sum + e.size, 0);
    for (const entry of all) {
      if (total <= maxBytes) break;
      if (keep.has(entry.hash) || removed.includes(entry.hash)) continue;
      removed.push(entry.hash);
      total -= entry.size;
    }
    for (const hash of removed) await this.remove(hash);
    if (removed.length) await this.save();
    return removed;
  }
  /** Every kept PDF that is not open. */
  async clear(keep = new Set<string>()) {
    await this.load();
    const removed = Object.keys(this.entries).filter((hash) => !keep.has(hash));
    for (const hash of removed) await this.remove(hash);
    await this.save();
    return removed;
  }
  private async remove(hash: string) {
    const entry = this.entries[hash];
    delete this.entries[hash];
    if (!entry) return;
    try {
      const { id, root } = await this.library.workspace();
      if (entry.sourceId) await this.library.invoke("store_delete", { ids: [entry.sourceId] }, id).catch(() => undefined);
      // A library copies files from temporary folders into its own `files` folder.
      await rm(join(root, ".key", "files", `${hash}.pdf`), { force: true });
    } catch {
      /* the scratch library is unavailable: its rows go with the next clean start */
    }
    await rm(entry.file, { force: true });
  }
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
