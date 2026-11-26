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

export function openWebPage(workspaceId: string, sourceId: string, focus?: Omit<WebFocus, "sourceId">, title?: string, where: Record<string, unknown> = {}) {
  if (focus?.annotationId || focus?.text) {
    pending.set(sourceId, { sourceId, ...focus });
    window.dispatchEvent(new CustomEvent(WEB_FOCUS_EVENT, { detail: sourceId }));
  }
  return bridge().tabAction("open-content", { section: "webpage", workspaceId, sourceId, title: title || "Web page", ...where });
}
