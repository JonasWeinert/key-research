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

type Invoke = <T = unknown>(command: string, args: Record<string, unknown>, workspaceId: string) => Promise<T>;
type Source = { id: string; kind: string; url?: string; filePath?: string; fileHash?: string; title?: string; trashedAt?: number | null };

const COMMANDS = new Set(["saved_page_save", "saved_page_find", "saved_page_html"]);

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
  ) {}

  handles(command: string) {
    return COMMANDS.has(command);
  }

  handle(command: string, args: any, workspaceId: string) {
    if (!workspaceId) throw Error("Choose a workspace");
    if (command === "saved_page_save") {
      const contents = this.page(String(args?.viewId ?? ""));
      if (!contents) throw Error("Open the page in a browser tab first");
      return this.save(contents, workspaceId);
    }
    if (command === "saved_page_find") return this.find(String(args?.url ?? ""), workspaceId).then((s) => (s ? { id: s.id, saved: !!s.filePath } : null));
    if (command === "saved_page_html") return this.html(String(args?.id ?? ""), workspaceId);
    throw Error(`Unknown command ${command}`);
  }

  /** The library's web source for `url`, preferring one with a saved page. */
  async find(url: string, workspaceId: string): Promise<Source | undefined> {
    const key = pageKey(url);
    if (!key) return undefined;
    const page = await this.invoke<{ items: Source[] }>("store_sources", { kind: "web", limit: 2000, offset: 0 }, workspaceId);
    const matches = page.items.filter((s) => !s.trashedAt && pageKey(s.url) === key);
    return matches.find((s) => s.filePath) ?? matches[0];
  }

  /** Snapshots the page and keeps it in the library: answers the source and whether it was there. */
  async save(contents: WebContents, workspaceId: string) {
    const snapshot = await capturePage(contents);
    const existing = await this.find(snapshot.meta.url, workspaceId);
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
      // A page saved again keeps the title and details someone may have edited.
      const patch = sourcePatch(snapshot.meta, snapshot.capturedAt);
      if (existing?.filePath && existing.id === id) for (const key of ["title", "creators", "containerTitle", "abstract"]) delete patch[key];
      await this.invoke("store_update", { id, patch }, workspaceId);
      this.changed();
      return { id, title: snapshot.meta.title, existing: !!existing };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** A saved page's HTML, for the reader. */
  async html(id: string, workspaceId: string) {
    const source = await this.invoke<Source | null>("store_source", { id }, workspaceId);
    if (!source?.filePath || source.kind !== "web") throw Error("This source has no saved page");
    if ((await stat(source.filePath)).size > 80 * 1024 * 1024) throw Error("The saved page is too large to show");
    return { html: await readFile(source.filePath, "utf8"), hash: source.fileHash };
  }
}
