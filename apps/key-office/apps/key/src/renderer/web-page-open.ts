// Opening a saved web page in its reader (WebPageReader), optionally at a highlight or a
// quoted passage. The reader is a view of this window's renderer, so where to go is handed
// over here: kept until the reader takes it, and announced to one already open.
import { bridge } from "./library-api";

export interface WebFocus {
  sourceId: string;
  annotationId?: string;
  text?: string;
  /** Shorter texts to look for when `text` is not on the page as written (a search hit's
   *  snippet, then its matched words). */
  fallback?: string[];
  /** Keep the passage lit until the reader is clicked (a search hit), not for a moment. */
  keep?: boolean;
}
const pending = new Map<string, WebFocus>();
export const WEB_FOCUS_EVENT = "key:web-page-focus";

/** The place a reader of `sourceId` should show, once. */
export function takeWebFocus(sourceId: string) {
  const focus = pending.get(sourceId);
  pending.delete(sourceId);
  return focus;
}

/** Shows a highlight or passage in a reader of `sourceId` that is open already (its panel's
 * highlights list), without going through the tabs. */
export function focusWebPage(sourceId: string, focus: Omit<WebFocus, "sourceId">) {
  pending.set(sourceId, { sourceId, ...focus });
  window.dispatchEvent(new CustomEvent(WEB_FOCUS_EVENT, { detail: sourceId }));
}

/** The reader's references, between it and its panel: go to one, read the page again, or
 *  (from the reader) the stored analysis changed. */
export const WEB_REFERENCE_EVENT = "key:web-page-reference";
export const WEB_REANALYZE_EVENT = "key:web-page-reanalyze";
export const WEB_ANALYSIS_EVENT = "key:web-page-analysis";
export const webPageEvent = (name: string, detail: { sourceId: string; number?: number }) => window.dispatchEvent(new CustomEvent(name, { detail }));

/** The status bar's switch for a saved page's panel, from its reader or the panel itself. */
export function webPanelStatusItems(panelTab: string | undefined) {
  return [
    { id: "details", label: "Details", icon: "panelRight", active: panelTab === "details", title: "Show or hide this source’s details and note" },
    { id: "highlights", label: "Highlights", icon: "pen", active: panelTab === "highlights", title: "Show or hide this page’s highlights" },
    { id: "references", label: "References", icon: "book", active: panelTab === "references", title: "Show or hide the references cited on this page" },
  ];
}
export const toggleWebPanel = (readerViewId: string, tab: string) => bridge().tabAction("web-panel", { viewId: readerViewId, tab });

export function openWebPage(workspaceId: string, sourceId: string, focus?: Omit<WebFocus, "sourceId">, title?: string, where: Record<string, unknown> = {}) {
  if (focus?.annotationId || focus?.text || focus?.fallback?.length) {
    pending.set(sourceId, { sourceId, ...focus });
    window.dispatchEvent(new CustomEvent(WEB_FOCUS_EVENT, { detail: sourceId }));
  }
  return bridge().tabAction("open-content", { section: "webpage", workspaceId, sourceId, title: title || "Web page", ...where });
}

/** A search hit in a saved page: its reader opens at the matching passage, lit up. */
export function openWebSearchHit(
  workspaceId: string,
  hit: { id: string; title?: string; passageText?: string; snippet?: string },
  where: Record<string, unknown> = {},
) {
  const snippet = hit.snippet?.replace(/\[\[|\]\]/g, "").replace(/^\s*…\s*|\s*…\s*$/g, "").trim();
  const matched = [...(hit.snippet ?? "").matchAll(/\[\[(.+?)\]\]/g)].map((m) => m[1]);
  // The snippet's longest stretch without an ellipsis is still a passage on the page.
  const pieces = (snippet ?? "").split("…").map((p) => p.trim()).filter((p) => p.length > 12).sort((a, b) => b.length - a.length);
  const texts = [hit.passageText?.trim(), snippet, ...pieces, ...matched].filter((t): t is string => !!t);
  const [text, ...fallback] = [...new Set(texts)];
  return openWebPage(workspaceId, hit.id, { text, fallback, keep: true }, hit.title, where);
}
