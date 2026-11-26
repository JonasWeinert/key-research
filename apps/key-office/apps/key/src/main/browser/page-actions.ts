// What a browser tab does about the page it loaded: a PDF embedded as the page's content
// goes to the app's reader, and an article page can be added to the library (by its DOI's
// metadata, with its PDF when the page or OpenAlex names one).
import { randomUUID } from "node:crypto";
import { copyFile, rm, writeFile } from "node:fs/promises";
import type { WebContents } from "electron";
import type { WebResult } from "../../shared/web-search";
import type { BrowserService } from "./pages";
import { wasPdfFrame } from "./profile";
import type { PageScan, ScholarlyArticle } from "./scan";
import type { WebTabState } from "./tab";
import { webUrl } from "./urls";

/** The part of a browser tab's record these actions read and write. */
export interface PageRecord {
  id: string;
  web?: WebTabState;
  view?: { webContents: WebContents };
  articleState?: { key: string; sourceId?: string; busy?: boolean };
}
export interface PageActionDeps {
  service(): BrowserService | undefined;
  incomingPath(id: string): string;
  /** Opens a downloaded PDF in the reader from this page's tab; `replace` puts it in the tab's place. */
  openPdf(contents: WebContents, file: { path: string; url: string; filename: string }, replace: boolean): Promise<void>;
  /** The library the tab's window shows. */
  workspaceOf(record: PageRecord): string | undefined;
  invoke<T = any>(command: string, args: Record<string, unknown>, workspaceId: string): Promise<T>;
  lookupDoi(doi: string, workspaceId: string): Promise<WebResult | undefined>;
  addWork(workspaceId: string, work: WebResult): Promise<{ source: { id: string }; existed: boolean }>;
  changed(record: PageRecord): void;
  emit(event: string, value?: unknown): void;
}

const articleKey = (a: ScholarlyArticle) => (a.doi ? `doi:${a.doi.toLowerCase()}` : `title:${(a.title ?? "").toLowerCase()}`);
const MAX_INLINE_PDF = 100 * 1024 * 1024;

export class PageActions {
  private handled = new WeakMap<object, string>();
  constructor(private readonly deps: PageActionDeps) {}

  scanned(record: PageRecord, scan: PageScan) {
    const contents = record.view?.webContents;
    const framed = contents && scan.bigFrames?.find((url) => wasPdfFrame(contents.id, url));
    const pdf = scan.embeddedPdf ?? framed;
    if (pdf) void this.embedded(record, pdf);
    const article = record.web?.article;
    if (!article) {
      record.articleState = undefined;
      return;
    }
    const key = articleKey(article);
    if (record.articleState?.key === key) return;
    record.articleState = { key };
    void this.lookup(record, article).catch(() => undefined);
  }

  /** Whether the library has the article already (by DOI, else by title). */
  private async lookup(record: PageRecord, article: ScholarlyArticle) {
    const workspaceId = this.deps.workspaceOf(record);
    if (!workspaceId) return;
    const key = articleKey(article);
    const text = article.doi ?? article.title?.slice(0, 200);
    if (!text) return;
    const found = await this.deps.invoke<{ items: { id: string; doi?: string; title?: string }[] }>("store_sources", { text, limit: 8, scope: "all" }, workspaceId);
    const match = found.items?.find((s) => (article.doi ? s.doi?.toLowerCase() === article.doi.toLowerCase() : s.title?.toLowerCase() === article.title?.toLowerCase()));
    if (match && record.articleState?.key === key) {
      record.articleState.sourceId = match.id;
      this.deps.changed(record);
    }
  }

  /** Adds the tab's article to its window's library; answers the source. */
  async addArticle(record: PageRecord) {
    const article = record.web?.article;
    const workspaceId = this.deps.workspaceOf(record);
    if (!article || !workspaceId) throw Error("This page is not an article");
    const state = (record.articleState = { key: articleKey(article), busy: true } as NonNullable<PageRecord["articleState"]>);
    this.deps.changed(record);
    try {
      const pageUrl = webUrl(record.web?.url);
      const looked = article.doi ? await this.deps.lookupDoi(article.doi, workspaceId).catch(() => undefined) : undefined;
      const work: WebResult = looked ?? {
        provider: "web",
        providerId: pageUrl ?? article.doi ?? "",
        title: article.title || article.doi || "Untitled",
        authors: article.authors ?? [],
        year: article.year,
        venue: article.venue,
        doi: article.doi?.toLowerCase(),
        ids: {},
        landingUrl: pageUrl,
      };
      if (!work.title) throw Error("This page has no title to add");
      const { source, existed } = await this.deps.addWork(workspaceId, work);
      state.sourceId = source.id;
      if (!existed) void this.attachPdf(workspaceId, source.id, article.pdfUrl ?? work.pdfUrl);
      return { sourceId: source.id, existed };
    } finally {
      state.busy = false;
      this.deps.changed(record);
    }
  }

  /** Fetches the article's PDF with the browser's profile (its logins) and attaches it. */
  private async attachPdf(workspaceId: string, sourceId: string, url: string | undefined) {
    const service = this.deps.service();
    if (!url || !webUrl(url) || !service) return;
    try {
      const file = await service.downloadPdf(url, { timeoutMs: 90_000 });
      try {
        await this.deps.invoke("store_attach_file", { id: sourceId, path: file.path }, workspaceId);
        this.deps.emit("library-changed");
      } finally {
        await rm(file.directory, { recursive: true, force: true });
      }
    } catch {
      /* the reference stays without its PDF; the library can find one later */
    }
  }

  /** A blob or data URL read by the page that made it, saved for the reader when it is a PDF. */
  private async pageBytes(contents: WebContents, url: string) {
    const base64 = await contents.executeJavaScriptInIsolatedWorld(1999, [
      {
        code: `fetch(${JSON.stringify(url)}).then((r) => r.blob()).then((b) => b.size > ${MAX_INLINE_PDF} ? "" : new Promise((res) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(",")[1] || ""); f.readAsDataURL(b); }))`,
      },
    ]);
    const bytes = Buffer.from(String(base64 ?? ""), "base64");
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) return undefined;
    const path = this.deps.incomingPath(randomUUID());
    await writeFile(path, bytes);
    return path;
  }

  /** The page is going to a blob or data URL: when that is a PDF, the reader opens it (beside
   * the page, which stays) and the navigation is not made. False: it is no PDF, go ahead. */
  async inlinePdf(record: PageRecord, url: string) {
    const contents = record.view?.webContents;
    if (!contents || contents.isDestroyed()) return false;
    try {
      const path = await this.pageBytes(contents, url);
      if (!path) return false;
      await this.deps.openPdf(contents, { path, url: record.web?.url ?? "", filename: "" }, false);
      return true;
    } catch {
      return false;
    }
  }

  /** A page whose content is one embedded PDF: the PDF opens in the reader, and the page
   * goes (back to the page before it, or the reader takes its tab). */
  private async embedded(record: PageRecord, url: string) {
    const contents = record.view?.webContents;
    const page = record.web?.url ?? "";
    if (!contents || contents.isDestroyed() || this.handled.get(record) === `${page} ${url}`) return;
    this.handled.set(record, `${page} ${url}`);
    try {
      let file: { path: string; url: string; filename: string };
      if (/^(blob|data):/i.test(url)) {
        const path = await this.pageBytes(contents, url);
        if (!path) return;
        file = { path, url: page, filename: "" };
      } else {
        const service = this.deps.service();
        if (!service) return;
        const downloaded = await service.downloadPdf(url);
        const path = this.deps.incomingPath(randomUUID());
        try {
          await copyFile(downloaded.path, path);
        } finally {
          await rm(downloaded.directory, { recursive: true, force: true });
        }
        file = { path, url: downloaded.url, filename: downloaded.filename };
      }
      if (contents.isDestroyed()) return void rm(file.path, { force: true });
      const back = contents.navigationHistory.canGoBack();
      await this.deps.openPdf(contents, file, !back);
      if (back && !contents.isDestroyed()) contents.navigationHistory.goBack();
    } catch (error) {
      console.warn("Key browser: an embedded PDF did not open", url.slice(0, 200), error);
      this.deps.emit("browser-notice", { message: `Could not open the PDF on this page: ${String(error).replace(/^Error: /, "")}` });
    }
  }
}
