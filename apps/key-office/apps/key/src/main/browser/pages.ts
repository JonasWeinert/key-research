// Pages on the browser profile, attached to a window or not. `harden` is what every one of
// them gets; `BrowserService` routes downloads and offers a headless API (no window needed):
// fetchPage reads a page, downloadPdf fetches a PDF with the profile's cookies and logins.
import { app, shell, WebContentsView, type DownloadItem, type WebContents, type WebPreferences } from "electron";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { browserSession } from "./profile";
import { isPdfFile } from "./temp-pdfs";
import { citationPdfUrl, looksLikePdf, navigable, pdfTitle, safeFileName, systemUrl, uniqueName, webUrl } from "./urls";

/** Web content on the browser profile: sandboxed, isolated, no Node, no app bridge. */
export function pagePreferences(): WebPreferences {
  return {
    session: browserSession(),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    plugins: false,
    safeDialogs: true,
    navigateOnDragDrop: false,
    spellcheck: true,
    autoplayPolicy: "document-user-activation-required",
  };
}

let creating = false;
/** A new view on the browser profile. While it is made, `creatingPage()` says so, for
 * app-wide handlers that must leave browser pages alone. */
export function newPageView() {
  creating = true;
  try {
    return new WebContentsView({ webPreferences: pagePreferences() });
  } finally {
    creating = false;
  }
}
export const creatingPage = () => creating;

/** Keeps a page on the web: new windows go to `open` (denied without it), navigation to
 * files or app schemes is refused, mail links go to the system, bad certificates fail. */
export function harden(contents: WebContents, open?: (url: string, disposition: string) => void) {
  contents.setWindowOpenHandler(({ url, disposition }) => {
    const web = webUrl(url);
    if (web) open?.(web, disposition);
    else if (systemUrl(url)) void shell.openExternal(systemUrl(url)!);
    return { action: "deny" };
  });
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (navigable(url) || /^(data|blob):/i.test(url)) return;
    event.preventDefault();
    const external = systemUrl(url);
    if (external) void shell.openExternal(external);
  };
  contents.on("will-navigate", (event) => guard(event, event.url));
  contents.on("will-redirect", (event) => guard(event, event.url));
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !/^(https?|about|data|blob):/i.test(event.url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("certificate-error", (event, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
  });
}

type Claim = { directory: string; resolve(file: { path: string; url: string; filename: string }): void; reject(error: Error): void };
export interface DownloadHooks {
  /** A PDF a page downloaded (a link, or a navigation to it), saved at `path`. */
  pdf(contents: WebContents | undefined, file: { path: string; url: string; filename: string }): void;
  /** Any other download, saved in Downloads (`ok` false when it failed or was cancelled). */
  file?(contents: WebContents | undefined, path: string, ok: boolean): void;
}
export class BrowserService {
  private claims = new Map<number, Claim>();
  constructor(
    private readonly incomingPath: (id: string) => string,
    private readonly hooks: DownloadHooks,
  ) {
    browserSession().on("will-download", (_event, item, contents) => this.download(item, contents ?? undefined));
  }
  private download(item: DownloadItem, contents?: WebContents) {
    const url = item.getURL();
    const filename = item.getFilename();
    const claim = contents && this.claims.get(contents.id);
    if (claim) {
      this.claims.delete(contents.id);
      const path = join(claim.directory, safeFileName(filename));
      item.setSavePath(path);
      item.once("done", (_event, state) =>
        state === "completed" ? claim.resolve({ path, url, filename }) : claim.reject(Error(`Download ${state}`)),
      );
      return;
    }
    if (looksLikePdf(item.getMimeType(), filename)) {
      const path = this.incomingPath(randomUUID());
      item.setSavePath(path);
      item.once("done", (_event, state) => {
        if (state === "completed") this.hooks.pdf(contents, { path, url, filename });
        else void rm(path, { force: true });
      });
      return;
    }
    const folder = app.getPath("downloads");
    const path = join(folder, uniqueName(safeFileName(filename), (name) => existsSync(join(folder, name))));
    item.setSavePath(path);
    item.once("done", (_event, state) => {
      if (state === "completed" && process.platform === "darwin") app.dock?.downloadFinished(path);
      this.hooks.file?.(contents, path, state === "completed");
    });
  }

  /** Loads a page without showing it: its final URL, title, HTML and text. */
  async fetchPage(url: string, { timeoutMs = 30_000 } = {}) {
    const web = webUrl(url);
    if (!web) throw Error("Use an HTTP or HTTPS URL");
    return withPage(timeoutMs, async (contents) => {
      await contents.loadURL(web);
      const [html, text] = await contents.executeJavaScript("[document.documentElement.outerHTML, document.body ? document.body.innerText : '']", false);
      return { finalUrl: contents.getURL(), title: contents.getTitle(), html: String(html), text: String(text) };
    });
  }

  /** Downloads a PDF with the profile (its cookies and logins), into a fresh temporary
   * folder: the URL itself, or the PDF an article page names (citation_pdf_url). */
  async downloadPdf(url: string, { timeoutMs = 120_000 } = {}) {
    const web = webUrl(url);
    if (!web) throw Error("Use an HTTP or HTTPS URL");
    const directory = await mkdtemp(join(tmpdir(), "key-browser-pdf-"));
    try {
      const file = await withPage(timeoutMs, async (contents) => {
        const attempt = async (target: string) => {
          const downloaded = new Promise<{ path: string; url: string; filename: string }>((resolve, reject) =>
            this.claims.set(contents.id, { directory, resolve, reject }),
          );
          const loaded = contents.loadURL(target).then(
            () => "page" as const,
            // A download ends the load (ERR_ABORTED or ERR_FAILED), sometimes before it is announced.
            (error) => wait(2000).then(() => (this.claims.has(contents.id) ? Promise.reject(error) : ("download" as const))),
          );
          const first = await Promise.race([downloaded, loaded]);
          if (typeof first === "object") return first;
          if (first === "download") return downloaded;
          this.claims.delete(contents.id);
          return undefined;
        };
        const direct = await attempt(web);
        if (direct) return direct;
        const html = String(await contents.executeJavaScript("document.documentElement.outerHTML", false));
        const named = citationPdfUrl(html, contents.getURL());
        const viaPage = named && (await attempt(named));
        if (!viaPage) throw Error("The page has no PDF to download");
        return viaPage;
      });
      if (!(await isPdfFile(file.path))) throw Error("The download is not a PDF");
      return { ...file, directory, title: pdfTitle(file.filename, file.url) };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Runs `work` on an unattached page of the profile, closed afterwards. */
async function withPage<T>(timeoutMs: number, work: (contents: WebContents) => Promise<T>): Promise<T> {
  const view = newPageView();
  const contents = view.webContents;
  harden(contents);
  contents.setAudioMuted(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(contents),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("The page took too long")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (!contents.isDestroyed()) contents.close();
  }
}
