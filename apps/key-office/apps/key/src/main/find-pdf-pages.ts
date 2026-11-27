// Find PDF that ended on a publisher's web page instead of a PDF. The browser tab it opened
// carries a banner for the source (the renderer's FindPdfBanner): the PDF links the page has
// (read by the host, key-index landing.rs), whether it asks to sign in, and the ways on. On
// landing, the page is saved as a snapshot into a scratch folder kept for this attempt only (not
// in the library): when the person then gets the PDF from the page, the snapshot's HTML goes to
// the host to label the PDF's structure (key-index html_align.rs) and is deleted; when no PDF can
// be had, the snapshot can become the source's full text without loading the page again. Old
// snapshots go after a while like the browser's other scratch data.
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import { capturePage, type PageMeta } from "./browser/snapshot";
import { safeFileName } from "./browser/urls";
import { properUrlOf } from "./browser/proxy-service";

type Invoke = <T = unknown>(command: string, args: Record<string, unknown>, workspaceId: string) => Promise<T>;
export interface PdfFor {
  workspaceId: string;
  sourceId: string;
  title?: string;
}
export interface Landing {
  links: { url: string; label: string; why: string }[];
  wall: boolean;
  abstractOnly: boolean;
  fullText: boolean;
  signIn?: string;
  title?: string;
  doi?: string;
}
/** What the banner over the tab shows (viewSummary's `web.findPdf`). */
export interface FindPdfBanner {
  title: string;
  /** looking: the page is loading; landed: on a page, no PDF yet; attached: the PDF is the
   * source's; saved: the page became its full text. */
  stage: "looking" | "landed" | "attached" | "saved";
  links: { url: string; label: string }[];
  wall: boolean;
  signIn?: string;
  /** A library proxy covers the site and the page did not come through it. */
  proxy?: string;
  abstractOnly: boolean;
  /** A snapshot of the page is kept for this attempt. */
  snapshot: boolean;
  busy?: "saving";
  error?: string;
}
interface Kept {
  workspaceId: string;
  sourceId: string;
  title: string;
  url: string;
  meta: PageMeta;
  capturedAt: string;
  abstractOnly: boolean;
  fullText: boolean;
  /** When it was taken (ms). */
  at: number;
}

export const PAGE_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const keyOf = (workspaceId: string, sourceId: string) => safeFileName(`${workspaceId}--${sourceId}`).replace(/[^A-Za-z0-9_.-]/g, "_");

export function shortTitle(title: string | undefined) {
  const t = (title || "this source").replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57).replace(/\s+\S*$/, "")}…` : t;
}

export class FindPdfPages {
  private taking = new Map<string, Promise<unknown>>();
  constructor(
    readonly dir: string,
    private readonly invoke: Invoke,
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  private file(key: string, ext: "html" | "json") {
    return join(this.dir, `${key}.${ext}`);
  }

  /** The page this tab landed on: what the host reads in it, and its snapshot taken once. */
  async landed(pdfFor: PdfFor, contents: WebContents): Promise<Landing | undefined> {
    if (contents.isDestroyed()) return undefined;
    const page = (await contents.executeJavaScriptInIsolatedWorld(1999, [{ code: `({ html: document.documentElement.outerHTML, url: location.href, type: document.contentType })` }], false).catch(() => undefined)) as
      | { html?: string; url?: string; type?: string }
      | undefined;
    if (!page?.html || !/html/i.test(page.type ?? "html") || page.html.length > 32 * 1024 * 1024) return undefined;
    const url = String(page.url ?? contents.getURL());
    const landing = await this.invoke<Landing>("web_landing_page", { html: page.html, url }, pdfFor.workspaceId).catch(() => undefined);
    if (!landing) return undefined;
    const key = keyOf(pdfFor.workspaceId, pdfFor.sourceId);
    // The first page of the attempt that is the article's (not a bot check or a sign-in form).
    if (!this.taking.has(key) && !(await this.kept(pdfFor.workspaceId, pdfFor.sourceId)) && (landing.title || landing.doi || landing.abstractOnly || landing.fullText)) {
      const work = this.take(pdfFor, contents, landing).finally(() => this.taking.delete(key));
      this.taking.set(key, work);
      void work.then(this.changed, () => undefined);
    }
    return landing;
  }

  private async take(pdfFor: PdfFor, contents: WebContents, landing: Landing) {
    if (contents.isDestroyed()) return;
    const snapshot = await capturePage(contents);
    await mkdir(this.dir, { recursive: true });
    const key = keyOf(pdfFor.workspaceId, pdfFor.sourceId);
    await writeFile(this.file(key, "html"), snapshot.html, "utf8");
    const kept: Kept = {
      workspaceId: pdfFor.workspaceId,
      sourceId: pdfFor.sourceId,
      title: snapshot.meta.title || pdfFor.title || "Web page",
      url: snapshot.meta.url,
      meta: snapshot.meta,
      capturedAt: snapshot.capturedAt,
      abstractOnly: landing.abstractOnly,
      fullText: landing.fullText,
      at: this.now(),
    };
    await writeFile(this.file(key, "json"), JSON.stringify(kept), "utf8");
  }

  /** The snapshot kept for this source's attempt, if any. */
  async kept(workspaceId: string, sourceId: string): Promise<Kept | undefined> {
    const key = keyOf(workspaceId, sourceId);
    await this.taking.get(key)?.catch(() => undefined);
    try {
      const kept = JSON.parse(await readFile(this.file(key, "json"), "utf8")) as Kept;
      if (this.now() - kept.at > PAGE_TTL_MS) {
        await this.discard(workspaceId, sourceId);
        return undefined;
      }
      await stat(this.file(key, "html"));
      return kept;
    } catch {
      return undefined;
    }
  }

  async discard(workspaceId: string, sourceId: string) {
    const key = keyOf(workspaceId, sourceId);
    await rm(this.file(key, "html"), { force: true });
    await rm(this.file(key, "json"), { force: true });
  }

  /** The PDF came from the page: its snapshot labels the PDF's structure, then goes. */
  async fold(pdfFor: PdfFor) {
    const kept = await this.kept(pdfFor.workspaceId, pdfFor.sourceId);
    if (!kept) return undefined;
    try {
      const html = await readFile(this.file(keyOf(pdfFor.workspaceId, pdfFor.sourceId), "html"), "utf8");
      return await this.invoke<{ applied: boolean; pending: boolean }>("store_structure_hint", { id: pdfFor.sourceId, html, url: kept.url }, pdfFor.workspaceId);
    } finally {
      await this.discard(pdfFor.workspaceId, pdfFor.sourceId);
    }
  }

  /** A copy of the kept snapshot in a temporary folder of its own (the caller removes it). */
  async copyOut(workspaceId: string, sourceId: string) {
    const kept = await this.kept(workspaceId, sourceId);
    if (!kept) return undefined;
    const directory = await mkdtemp(join(tmpdir(), "key-web-page-"));
    const path = join(directory, `${safeFileName(kept.title).slice(0, 80) || "Web page"}.html`);
    await copyFile(this.file(keyOf(workspaceId, sourceId), "html"), path);
    return { kept, directory, path };
  }

  /** The page becomes the source's full text: its own file when it has none, else kept beside
   *  its PDF. The kept snapshot is used (not fetched again); `contents` snapshots a page now. */
  async saveAsFullText(pdfFor: PdfFor, contents?: WebContents) {
    let out = await this.copyOut(pdfFor.workspaceId, pdfFor.sourceId);
    if (!out && contents && !contents.isDestroyed()) {
      await this.take(pdfFor, contents, { links: [], wall: false, abstractOnly: false, fullText: false });
      out = await this.copyOut(pdfFor.workspaceId, pdfFor.sourceId);
    }
    if (!out) throw Error("Open the page first: no copy of it is kept");
    try {
      const source = await this.invoke<{ id: string; kind: string; filePath?: string } | null>("store_source", { id: pdfFor.sourceId }, pdfFor.workspaceId);
      if (!source) throw Error("The source is no longer in the library");
      const primary = !source.filePath;
      await this.invoke("store_full_text_add", { id: pdfFor.sourceId, path: out.path }, pdfFor.workspaceId);
      if (primary)
        await this.invoke(
          "store_web_page_apply",
          { id: pdfFor.sourceId, meta: out.kept.meta, capturedAt: out.kept.capturedAt, existingId: pdfFor.sourceId, existingKind: source.kind, existingHadFile: false },
          pdfFor.workspaceId,
        ).catch(() => undefined);
      await this.discard(pdfFor.workspaceId, pdfFor.sourceId);
      return { abstractOnly: out.kept.abstractOnly, primary };
    } finally {
      await rm(out.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** A snapshot of a page for someone else to keep (the review tool's full text): a file in a
   *  temporary folder of its own, no library source. */
  async captureTo(contents: WebContents, landing?: Landing) {
    const snapshot = await capturePage(contents);
    const directory = await mkdtemp(join(tmpdir(), "key-web-page-"));
    const path = join(directory, `${safeFileName(snapshot.meta.title || "Web page").slice(0, 80) || "Web page"}.html`);
    await writeFile(path, snapshot.html, "utf8");
    return { path, title: snapshot.meta.title, url: properUrlOf(snapshot.meta.url), capturedAt: snapshot.capturedAt, meta: snapshot.meta, abstractOnly: !!landing?.abstractOnly, fullText: !!landing?.fullText };
  }

  /** Removes snapshots older than the retention limit (and strays). */
  async cleanup(ttlMs = PAGE_TTL_MS) {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      try {
        const kept = JSON.parse(await readFile(join(this.dir, name), "utf8")) as Kept;
        if (this.now() - kept.at > ttlMs) await this.discard(kept.workspaceId, kept.sourceId);
      } catch {
        await rm(join(this.dir, name), { force: true });
      }
    }
    for (const name of names.filter((n) => n.endsWith(".html")))
      if (!names.includes(name.replace(/\.html$/, ".json"))) {
        const at = await stat(join(this.dir, name)).then((s) => s.mtimeMs, () => 0);
        if (this.now() - at > 60_000) await rm(join(this.dir, name), { force: true });
      }
  }
}
