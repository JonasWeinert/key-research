// Opening a saved web page in its reader (WebPageReader), optionally at a highlight or a
// quoted passage. The reader is a view of this window's renderer, so where to go is handed
// over here: kept until the reader takes it, and announced to one already open.
import { bridge } from "./library-api";

export interface WebFocus {
  sourceId: string;
  annotationId?: string;
  text?: string;
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

export function openWebPage(workspaceId: string, sourceId: string, focus?: Omit<WebFocus, "sourceId">, title?: string, where: Record<string, unknown> = {}) {
  if (focus?.annotationId || focus?.text) {
    pending.set(sourceId, { sourceId, ...focus });
    window.dispatchEvent(new CustomEvent(WEB_FOCUS_EVENT, { detail: sourceId }));
  }
  return bridge().tabAction("open-content", { section: "webpage", workspaceId, sourceId, title: title || "Web page", ...where });
}
