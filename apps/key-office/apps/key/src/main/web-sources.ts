// Web pages as library sources: "Save page to library" snapshots a browser tab's page into
// one offline HTML file (see browser/snapshot.ts) kept as a `web` source with the page's
// metadata; the host indexes its text like any HTML file. Saved pages are read in the
// shell's web page reader (renderer/WebPageReader.tsx), which asks for the file's HTML here.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import { capturePage, type PageMeta } from "./browser/snapshot";
import { safeFileName } from "./browser/urls";
import { proxiedUrlOf } from "./browser/proxy-service";
import { referenceInputs, WEB_REFERENCES_SCRIPT, type WebReferenceScan } from "../shared/web-references";

type Invoke = <T = unknown>(command: string, args: Record<string, unknown>, workspaceId: string) => Promise<T>;
type Source = {
  id: string;
  kind: string;
  url?: string;
  doi?: string;
  filePath?: string;
  fileHash?: string;
  title?: string;
  trashedAt?: number | null;
  properties?: Record<string, unknown>;
};

const COMMANDS = new Set(["saved_page_save", "saved_page_find", "saved_page_html", "saved_page_fetch"]);

/** A URL as pages are matched by: no fragment, no trailing slash, no tracking parameters. */
export function pageKey(url: string | undefined) {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";
    for (const name of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_)/i.test(name)) u.searchParams.delete(name);
    u.hostname = u.hostname.replace(/^www\./, "");
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
  } catch {
    return url;
  }
}

/** "Doe, Jane" or "Jane Doe" as a creator; organisations stay literal. */
function creator(name: string) {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.includes(",")) {
    const [family, given] = clean.split(",", 2).map((s) => s.trim());
    return { family, given, role: "author" };
  }
  const parts = clean.split(" ");
  if (parts.length < 2 || parts.length > 4) return { literal: clean, role: "author" };
  return { family: parts.at(-1), given: parts.slice(0, -1).join(" "), role: "author" };
}

/** The source fields a page's metadata fills. */
export function sourcePatch(meta: PageMeta, capturedAt: string) {
  const date = meta.date && !Number.isNaN(Date.parse(meta.date)) ? new Date(meta.date) : undefined;
  const site = meta.site || (() => {
    try {
      return new URL(meta.url).hostname.replace(/^www\./, "");
    } catch {
      return undefined;
    }
  })();
  const patch: Record<string, unknown> = {
    itemType: "webpage",
    title: meta.title || site || meta.url,
    url: meta.url,
    containerTitle: site,
    accessed: capturedAt.slice(0, 10),
    creators: meta.authors.map(creator),
  };
  if (date) {
    patch.date = meta.date!.slice(0, 10);
    patch.year = date.getUTCFullYear();
  }
  if (meta.doi) patch.doi = meta.doi;
  if (meta.description) patch.abstract = meta.description.slice(0, 4000);
  if (meta.language) patch.language = meta.language;
  patch.properties = { webSnapshot: { url: meta.url, canonical: meta.canonical, capturedAt } };
  return patch;
}

export class WebSources {
  constructor(
    private readonly invoke: Invoke,
    /** A browser tab's page by its view id. */
    private readonly page: (viewId: string) => WebContents | undefined,
    private readonly changed: () => void,
    /** Loads a page off screen with the browser's profile (and library proxies) for `work`. */
    private readonly load?: <T>(url: string, work: (contents: WebContents) => Promise<T>) => Promise<T>,
  ) {}

  handles(command: string) {
    return COMMANDS.has(command);
  }

  handle(command: string, args: any, workspaceId: string) {
    if (!workspaceId) throw Error("Choose a workspace");
    if (command === "saved_page_save") {
      const contents = this.page(String(args?.viewId ?? ""));
      if (!contents) throw Error("Open the page in a browser tab first");
      return this.save(contents, workspaceId, args?.sourceId ? String(args.sourceId) : undefined);
    }
    if (command === "saved_page_find")
      return this.find(String(args?.url ?? ""), workspaceId, args?.doi ? String(args.doi) : undefined).then((s) =>
        s ? { id: s.id, saved: !!s.filePath && s.kind === "web", ...(s.kind !== "web" ? { into: s.title || "this source" } : {}) } : null,
      );
    if (command === "saved_page_html") return this.html(String(args?.id ?? ""), workspaceId);
    if (command === "saved_page_fetch") return this.fetchInto(String(args?.id ?? ""), workspaceId);
    throw Error(`Unknown command ${command}`);
  }

  /** The library's web source for `url`, preferring one with a saved page; else a source
   * with no file yet that is this page (by its DOI or address), to save the page into. */
  async find(url: string, workspaceId: string, doi?: string): Promise<Source | undefined> {
    const key = pageKey(url);
    if (!key) return undefined;
    const page = await this.invoke<{ items: Source[] }>("store_sources", { kind: "web", limit: 2000, offset: 0 }, workspaceId);
    const matches = page.items.filter((s) => !s.trashedAt && pageKey(s.url) === key);
    const web = matches.find((s) => s.filePath) ?? matches[0];
    if (web) return web;
    const text = doi || url;
    const found = await this.invoke<{ items: Source[] }>("store_sources", { text: text.slice(0, 200), limit: 12, scope: "all" }, workspaceId).catch(() => ({ items: [] as Source[] }));
    return found.items.find(
      (s) => !s.trashedAt && !s.filePath && ((doi && s.doi?.toLowerCase() === doi.toLowerCase()) || (s.url && pageKey(s.url) === key)),
    );
  }

  /** Snapshots the page and keeps it in the library: answers the source and whether it was
   * there. With `into`, the page becomes that source's file (a reference saved as a page). */
  async save(contents: WebContents, workspaceId: string, into?: string) {
    const snapshot = await capturePage(contents);
    const scan = await this.scan(contents);
    const target = into ? await this.invoke<Source | null>("store_source", { id: into }, workspaceId) : undefined;
    if (into && (!target || target.filePath)) throw Error(target ? "This source has a file already" : "The source is no longer in the library");
    const existing = target ?? (await this.find(snapshot.meta.url, workspaceId));
    const directory = await mkdtemp(join(tmpdir(), "key-web-page-"));
    try {
      const name = `${safeFileName(snapshot.meta.title || "Web page").slice(0, 80) || "Web page"}.html`;
      const path = join(directory, name);
      await writeFile(path, snapshot.html, "utf8");
      let id: string;
      if (existing && !existing.filePath) {
        id = (await this.invoke<Source>("store_attach_file", { id: existing.id, path }, workspaceId)).id;
      } else {
        const [created] = await this.invoke<{ id: string; existing?: boolean }[]>("store_import_files", { paths: [path] }, workspaceId);
        id = created.id;
      }
      const patch = sourcePatch(snapshot.meta, snapshot.capturedAt);
      if (existing && existing.kind !== "web") {
        // A reference keeps what it is (an article, its title and authors); it gains the page.
        const keep: Record<string, unknown> = { properties: { ...(existing.properties ?? {}), webSnapshot: (patch.properties as Record<string, unknown>).webSnapshot } };
        if (!existing.url) keep.url = snapshot.meta.url;
        await this.invoke("store_update", { id, patch: keep }, workspaceId);
      } else {
        // A page saved again keeps the title and details someone may have edited.
        if (existing?.filePath && existing.id === id) for (const key of ["title", "creators", "containerTitle", "abstract"]) delete patch[key];
        await this.invoke("store_update", { id, patch }, workspaceId);
      }
      if (scan?.references.length) await this.invoke("store_web_references", { id, references: referenceInputs(scan) }, workspaceId).catch(() => undefined);
      this.changed();
      return { id, title: snapshot.meta.title, existing: !!existing };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The page's reference list, read where it is shown (its JSON-LD included). */
  private async scan(contents: WebContents): Promise<WebReferenceScan | undefined> {
    try {
      return (await contents.executeJavaScriptInIsolatedWorld(1999, [{ code: WEB_REFERENCES_SCRIPT }], false)) as WebReferenceScan;
    } catch {
      return undefined;
    }
  }

  /** Saves the web page of a source that has no file: its address (or its DOI's landing
   * page), loaded with the browser's profile and through a library proxy when one serves it. */
  async fetchInto(id: string, workspaceId: string) {
    const source = await this.invoke<Source | null>("store_source", { id }, workspaceId);
    if (!source) throw Error("The source is no longer in the library");
    if (source.filePath) throw Error("This source has a file already");
    const url = source.url && /^https?:/i.test(source.url) ? source.url : source.doi ? `https://doi.org/${source.doi}` : "";
    if (!url) throw Error("This source has no web address to save");
    if (!this.load) throw Error("The browser is not ready yet");
    await this.load(proxiedUrlOf(url), (contents) => this.save(contents, workspaceId, id));
    return this.invoke<Source>("store_source", { id }, workspaceId);
  }

  /** A saved page's HTML, for the reader. */
  async html(id: string, workspaceId: string) {
    const source = await this.invoke<Source | null>("store_source", { id }, workspaceId);
    if (!source?.filePath || source.kind !== "web") throw Error("This source has no saved page");
    if ((await stat(source.filePath)).size > 80 * 1024 * 1024) throw Error("The saved page is too large to show");
    return { html: await readFile(source.filePath, "utf8"), hash: source.fileHash };
  }
}
