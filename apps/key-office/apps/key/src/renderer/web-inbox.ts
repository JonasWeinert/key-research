// "Add to Inbox" for a work found on the web: kept to look at later without filing it in
// the library. The host owns the Inbox (`inbox_save`, de-duplicated against the Inbox and
// the library); this is the one place the search window calls it.
import type { WebHit } from "../shared/web-search";
import type { Invoke } from "./library-api";

export interface InboxSaved {
  state: "inbox" | "library";
  itemId?: string;
  sourceId?: string;
  existed: boolean;
}

export function addToInbox(invoke: Invoke, workspaceId: string, hit: WebHit, query: string): Promise<InboxSaved> {
  const origin = { kind: "web-search", label: query.trim() || "a web search", query: query.trim() || undefined, url: hit.landingUrl };
  return invoke<InboxSaved>("inbox_save", { work: hit, origin }, workspaceId).then((saved) => {
    window.dispatchEvent(new Event("key:feeds-changed"));
    return saved;
  });
}
