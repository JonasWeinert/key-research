// Web pages as library sources: "Save page to library" snapshots a browser tab's page into
// one offline HTML file (see browser/snapshot.ts) kept as a `web` source with the page's
// metadata; the host indexes its text like any HTML file. Saved pages are read in the
// shell's web page reader (renderer/WebPageReader.tsx), which asks for the file's HTML here.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import { capturePage } from "./browser/snapshot";
import { safeFileName } from "./browser/urls";
import { ACCESS_DENIED, judgeLoadedPage, withLibraryAccess } from "./browser/proxy-service";

/** The live page as the host reads its references (key-store `web_references.rs`): its DOM
 * as HTML, JSON-LD and all, and its address. */
const LIVE_PAGE_SCRIPT = `({ html: document.documentElement.outerHTML, url: location.href })`;

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

// Which source a page is (its normalised address or DOI) and the fields its metadata fills
// are decided by the host (key-store `web_pages.rs`): `store_web_page_find`, `store_web_page_apply`.

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
    if (!url) return undefined;
    return (await this.invoke<Source | null>("store_web_page_find", { url, doi: doi ?? null }, workspaceId)) ?? undefined;
  }

  /** Snapshots the page and keeps it in the library: answers the source and whether it was
   * there. With `into`, the page becomes that source's file (a reference saved as a page). */
  async save(contents: WebContents, workspaceId: string, into?: string) {
    const snapshot = await capturePage(contents);
    const live = await this.livePage(contents);
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
      await this.invoke(
        "store_web_page_apply",
        { id, meta: snapshot.meta, capturedAt: snapshot.capturedAt, existingId: existing?.id ?? null, existingKind: existing?.kind ?? null, existingHadFile: !!existing?.filePath },
        workspaceId,
      );
      // The host reads the reference list from the live page and keeps it as an analysis.
      if (live) await this.invoke("store_web_references_detect", { id, html: live.html, url: live.url }, workspaceId).catch(() => undefined);
      this.changed();
      return { id, title: snapshot.meta.title, existing: !!existing };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The page as shown (its JSON-LD included), for the host to read its references from. */
  private async livePage(contents: WebContents): Promise<{ html: string; url: string } | undefined> {
    try {
      const page = (await contents.executeJavaScriptInIsolatedWorld(1999, [{ code: LIVE_PAGE_SCRIPT }], false)) as { html?: unknown; url?: unknown };
      return typeof page?.html === "string" && page.html.length < 64 * 1024 * 1024 ? { html: page.html, url: String(page.url ?? "") } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Saves the web page of a source that has no file: its address (or its DOI's landing
   * page), loaded with the browser's profile; directly first, and through the site's library
   * proxy when this network needs it (known, or the direct page wanted a sign-in). */
  async fetchInto(id: string, workspaceId: string) {
    const source = await this.invoke<Source | null>("store_source", { id }, workspaceId);
    if (!source) throw Error("The source is no longer in the library");
    if (source.filePath) throw Error("This source has a file already");
    const url = source.url && /^https?:/i.test(source.url) ? source.url : source.doi ? `https://doi.org/${source.doi}` : "";
    if (!url) throw Error("This source has no web address to save");
    if (!this.load) throw Error("The browser is not ready yet");
    const load = this.load;
    await withLibraryAccess(url, (target) =>
      load(target, async (contents) => {
        const access = await judgeLoadedPage(contents, target);
        if (access?.access === "denied") return ACCESS_DENIED;
        return { value: await this.save(contents, workspaceId, id), access: access ?? { access: "unknown" as const, reason: "", telling: false } };
      }),
    );
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
