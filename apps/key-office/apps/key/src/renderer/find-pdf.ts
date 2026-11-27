// Find PDF for library sources without a file. The library host runs the chain (the stored
// open-access link, OpenAlex, Unpaywall with the contact email from Settings, arXiv, PubMed
// Central: crates/key-desktop-host/src/web_search/find_pdf.rs), checks that what it gets is a
// PDF and attaches it. When none can be had that way, the landing page opens in the in-app
// browser (through the library's proxy when one covers the site), where a PDF captured is
// attached to the same source.
import { useSyncExternalStore } from "react";
import { toast } from "./item-actions";
import { bridge, type Invoke, type Source } from "./library-api";
import { libraryChanged } from "./library-nav";
import { workspaceSettings } from "./workspace-settings-api";
import "./find-pdf.css";

export interface FindPdfResult {
  status: "attached" | "hasFile" | "browser" | "notFound";
  /** The source keeps a saved web page as its full text (and still has no PDF). */
  savedPage?: boolean;
  via?: "openalex" | "unpaywall" | "arxiv" | "pmc" | "source";
  url?: string;
  source?: Source;
  tried?: { url: string; via: string; reason: string }[];
}

const VIA: Record<string, string> = { openalex: "OpenAlex", unpaywall: "Unpaywall", arxiv: "arXiv", pmc: "PubMed Central", source: "the reference’s link" };

/** One sentence for what happened. */
export function findPdfMessage(result: FindPdfResult) {
  switch (result.status) {
    case "attached":
      return `Found an open-access PDF via ${VIA[result.via ?? ""] ?? "the web"}`;
    case "hasFile":
      return "This source has its file already";
    case "browser":
      return result.tried?.length
        ? "No open-access PDF could be downloaded. The publisher’s page is open: a PDF you open there is attached to this source."
        : "No open-access copy is known. The publisher’s page is open: a PDF you open there is attached to this source.";
    default:
      return "No PDF was found, and the source has no DOI or link to look further";
  }
}

export function findPdfRequest(invoke: Invoke, workspaceId: string, sourceId: string) {
  return invoke<FindPdfResult>("web_find_pdf", { id: sourceId }, workspaceId);
}

/** Opens the landing page in the in-app browser, set to attach the PDF captured there. */
export function browseForPdf(url: string, workspaceId: string, source: Pick<Source, "id" | "title">) {
  return bridge().tabAction("open-url", { url, pdfFor: { workspaceId, sourceId: source.id, title: source.title } });
}

/** Find PDF for one source: attached, or its landing page opened in the browser. */
export async function findPdf(invoke: Invoke, workspaceId: string, source: Pick<Source, "id" | "title">, options: { browse?: boolean; quiet?: boolean } = {}) {
  const result = await findPdfRequest(invoke, workspaceId, source.id);
  if (result.status === "attached") libraryChanged();
  if (result.status === "browser" && result.url && options.browse !== false) await browseForPdf(result.url, workspaceId, source).catch(() => undefined);
  if (!options.quiet) toast(findPdfMessage(result));
  return result;
}

// ── Several at once (the library's bulk action), with progress in the status bar ──

export interface FindPdfRun {
  done: number;
  total: number;
  found: number;
  running: boolean;
}
/** A source of the last bulk run that ended on its publisher's page (no tab is opened for it). */
export interface FindPdfPageRow {
  id: string;
  title: string;
  url: string;
  /** The source keeps a saved web page as its full text already. */
  savedPage?: boolean;
}
export interface FindPdfResults {
  workspaceId: string;
  found: number;
  total: number;
  pages: FindPdfPageRow[];
  /** Sources with no PDF that keep their saved page as the full text. */
  savedPages: number;
  notFound: number;
}
let run: FindPdfRun | undefined;
let results: FindPdfResults | undefined;
const listeners = new Set<() => void>();
const emitAll = () => {
  for (const l of listeners) l();
};
const set = (next: FindPdfRun | undefined) => {
  run = next;
  emitAll();
};
let cancelled = false;
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export function useFindPdfRun() {
  return useSyncExternalStore(subscribe, () => run);
}
/** What the last bulk run left to do: the sources whose publisher's page it landed on. */
export function useFindPdfResults() {
  return useSyncExternalStore(subscribe, () => results);
}
export const clearFindPdfResults = () => void ((results = undefined), emitAll());
/** One row is done with (its page opened and its PDF found there, or its page saved). */
export function settleFindPdfRow(id: string) {
  if (!results) return;
  results = { ...results, pages: results.pages.filter((p) => p.id !== id) };
  emitAll();
}
export const cancelFindPdfs = () => void (cancelled = true);

/** A source still without a PDF: no file, or a saved web page as its file. */
export const wantsPdf = (s: Pick<Source, "filePath"> & { kind?: string }) => !s.filePath || s.kind === "web";

/** Find PDF for each source without a PDF, one after another; never opens the browser. Those
 * that end on their publisher's page are listed (useFindPdfResults) to open one by one. */
export async function findPdfs(invoke: Invoke, workspaceId: string, sources: (Pick<Source, "id" | "title" | "filePath"> & { kind?: string })[]) {
  if (run?.running) return toast("Finding PDFs already");
  const wanted = sources.filter(wantsPdf);
  if (!wanted.length) return toast("Every selected source has its PDF already");
  cancelled = false;
  let found = 0;
  let savedPages = 0;
  let notFound = 0;
  const pages: FindPdfPageRow[] = [];
  set({ done: 0, total: wanted.length, found, running: true });
  for (const [i, source] of wanted.entries()) {
    if (cancelled) break;
    const result = await findPdfRequest(invoke, workspaceId, source.id).catch(() => undefined);
    if (result?.status === "attached") found++;
    else if (result?.savedPage) savedPages++;
    if (result?.status === "browser" && result.url) pages.push({ id: source.id, title: source.title || "Untitled", url: result.url, savedPage: result.savedPage });
    if (result?.status === "notFound" && !result.savedPage) notFound++;
    set({ done: i + 1, total: wanted.length, found, running: true });
  }
  set(undefined);
  results = { workspaceId, found, total: wanted.length, pages, savedPages, notFound };
  emitAll();
  if (found) libraryChanged();
  const parts = [
    found === wanted.length ? `Found ${found === 1 ? "a PDF" : `all ${found} PDFs`}` : `Found ${found} of ${wanted.length} PDFs`,
    pages.length ? `${pages.length} on the publisher’s page` : "",
    savedPages ? `${savedPages} keep${savedPages === 1 ? "s" : ""} a saved page` : "",
  ].filter(Boolean);
  toast(parts.join("; "));
  return { found, total: wanted.length, pages: pages.length, savedPages };
}

/** After an add: Find PDF when the workspace's settings say to (off by default). Silent. */
export async function findPdfAfterAdd(invoke: Invoke, workspaceId: string, sourceId: string) {
  const settings = await workspaceSettings(invoke, workspaceId)
    .then((r) => r.effective)
    .catch(() => undefined);
  if (!settings?.findPdfOnAdd) return;
  const result = await findPdfRequest(invoke, workspaceId, sourceId).catch(() => undefined);
  if (result?.status === "attached") libraryChanged();
}
