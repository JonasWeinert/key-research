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
let run: FindPdfRun | undefined;
const listeners = new Set<() => void>();
const set = (next: FindPdfRun | undefined) => {
  run = next;
  for (const l of listeners) l();
};
let cancelled = false;

export function useFindPdfRun() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => run,
  );
}
export const cancelFindPdfs = () => void (cancelled = true);

/** Find PDF for each source without a file, one after another; never opens the browser. */
export async function findPdfs(invoke: Invoke, workspaceId: string, sources: Pick<Source, "id" | "title" | "filePath">[]) {
  if (run?.running) return toast("Finding PDFs already");
  const wanted = sources.filter((s) => !s.filePath);
  if (!wanted.length) return toast("Every selected source has its file already");
  cancelled = false;
  let found = 0;
  let pages = 0;
  set({ done: 0, total: wanted.length, found, running: true });
  for (const [i, source] of wanted.entries()) {
    if (cancelled) break;
    const result = await findPdfRequest(invoke, workspaceId, source.id).catch(() => undefined);
    if (result?.status === "attached") found++;
    if (result?.status === "browser") pages++;
    set({ done: i + 1, total: wanted.length, found, running: true });
  }
  set(undefined);
  if (found) libraryChanged();
  const rest = wanted.length - found;
  toast(
    found === wanted.length
      ? `Found ${found === 1 ? "a PDF" : `all ${found} PDFs`}`
      : `Found ${found} of ${wanted.length} PDFs${rest && pages ? `; ${pages === 1 ? "one needs" : `${pages} need`} the publisher’s page (Find PDF on each)` : ""}`,
  );
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
