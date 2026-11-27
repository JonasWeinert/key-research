// "Add to Inbox" for a work not in the library, wherever one is shown (a web result, a
// source's references, cited-by and related works, a database search, a browser page): the
// host keeps it as an Inbox item "saved by you" with where it was found (`inbox_save`), not
// repeated when the Inbox or the library has it already. From the Inbox it can be read, added
// to the library (into the collections of the source it was found in) or dismissed. States:
// Add to Inbox → In Inbox, and nothing once the work is in the library (Add to library is the
// main action; this one is secondary).
import { useEffect, useState } from "react";
import { feedsChanged, onFeedsChanged, openInbox } from "./feeds-ui";
import { Icon } from "./icons";
import { toast } from "./item-actions";
import type { Invoke } from "./library-api";

/** A work as web search describes it; extra fields are ignored. */
export interface InboxWork {
  title?: string | null;
  authors?: string[] | null;
  year?: number | null;
  venue?: string | null;
  abstract?: string | null;
  doi?: string | null;
  ids?: { openalex?: string | null; arxiv?: string | null; pmid?: string | null } | null;
  landingUrl?: string | null;
  pdfUrl?: string | null;
}
/** Where it was found: shown on the item as "Saved from …". */
export interface InboxOrigin {
  /** web-search | source | page | reader | browser | database | duplicates … */
  kind: string;
  label?: string | null;
  query?: string | null;
  /** The source it was found in: its collections are offered when it is added later. */
  sourceId?: string | null;
  url?: string | null;
}
export type InboxStateName = "none" | "inbox" | "library";
interface StateAnswer {
  state: InboxStateName;
  itemId?: string;
  sourceId?: string;
}

const keyOf = (w: InboxWork) => (w.doi ? `doi:${w.doi.toLowerCase()}` : w.ids?.openalex ? `oa:${w.ids.openalex}` : `t:${(w.title ?? "").toLowerCase()}|${w.year ?? ""}|${w.landingUrl ?? ""}`);

/** Keeps the work in the Inbox; answers where it is now. Says so in a toast. */
export async function saveToInbox(invoke: Invoke, workspaceId: string, work: InboxWork, origin: InboxOrigin, quiet = false): Promise<StateAnswer & { existed: boolean }> {
  let label = origin.label;
  if (!label && origin.sourceId) label = (await invoke<{ title?: string } | null>("store_source", { id: origin.sourceId }, workspaceId).catch(() => null))?.title;
  const out = await invoke<StateAnswer & { existed: boolean }>("inbox_save", { work, origin: { ...origin, label: label ?? null } }, workspaceId);
  states.delete(`${workspaceId}|${keyOf(work)}`);
  feedsChanged();
  if (!quiet) {
    if (out.state === "library") toast("Already in your library");
    else toast(out.existed ? "Already in your Inbox" : "Saved to your Inbox", undefined, { label: "Open Inbox", run: () => openInbox(workspaceId) });
  }
  return out;
}

// Lists ask for many works at once: one `inbox_state` per moment and workspace.
const states = new Map<string, StateAnswer>();
const pending = new Map<string, { work: InboxWork; resolve: (s: StateAnswer) => void }[]>();
function stateOf(invoke: Invoke, workspaceId: string, work: InboxWork): Promise<StateAnswer> {
  const cached = states.get(`${workspaceId}|${keyOf(work)}`);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const queue = pending.get(workspaceId) ?? [];
    queue.push({ work, resolve });
    if (queue.length > 1) return;
    pending.set(workspaceId, queue);
    setTimeout(() => {
      const batch = pending.get(workspaceId) ?? [];
      pending.delete(workspaceId);
      void invoke<StateAnswer[]>("inbox_state", { works: batch.map((b) => b.work) }, workspaceId)
        .catch(() => [] as StateAnswer[])
        .then((answers) =>
          batch.forEach((b, i) => {
            const answer = answers[i] ?? { state: "none" as const };
            states.set(`${workspaceId}|${keyOf(b.work)}`, answer);
            b.resolve(answer);
          }),
        );
    }, 40);
  });
}
if (typeof window !== "undefined") onFeedsChanged(() => states.clear());

export function useInboxState(invoke: Invoke, workspaceId: string | undefined, work: InboxWork | null | undefined) {
  const [state, setState] = useState<StateAnswer>();
  const key = work ? keyOf(work) : "";
  useEffect(() => {
    if (!work || !workspaceId || !work.title) return;
    let live = true;
    const read = () => void stateOf(invoke, workspaceId, work).then((s) => live && setState(s));
    read();
    const off = onFeedsChanged(read);
    return () => {
      live = false;
      off();
    };
    // `work` is identified by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, workspaceId, key]);
  return [state, setState] as const;
}

/** Add to Inbox → In Inbox (opens the Inbox); nothing when the library has the work. */
export function AddToInboxButton({
  invoke,
  workspaceId,
  work,
  origin,
  className = "kx-page-action",
  compact,
}: {
  invoke: Invoke;
  workspaceId: string | undefined;
  work: InboxWork | null | undefined;
  origin: InboxOrigin;
  className?: string;
  /** Icon and a short label, for tight rows. */
  compact?: boolean;
}) {
  const [state, setState] = useInboxState(invoke, workspaceId, work);
  const [busy, setBusy] = useState(false);
  if (!work?.title || !workspaceId || !state || state.state === "library") return null;
  const saved = state.state === "inbox";
  return (
    <button
      type="button"
      className={`${className} kx-inbox-save`}
      data-state={saved ? "inbox" : "none"}
      disabled={busy}
      title={saved ? "In your Inbox. Click to open the Inbox." : "Keep it in your Inbox to decide on later, without adding it to the library"}
      onClick={(e) => {
        e.stopPropagation();
        if (saved) return openInbox(workspaceId);
        setBusy(true);
        void saveToInbox(invoke, workspaceId, work, origin)
          .then((out) => setState({ state: out.state, itemId: out.itemId, sourceId: out.sourceId }))
          .catch((err) => toast(`Couldn't save it: ${String(err).replace(/^Error: /, "")}`))
          .finally(() => setBusy(false));
      }}
    >
      <Icon name={saved ? "check" : "inbox"} size={compact ? 11 : 12} />
      {busy ? "Saving…" : saved ? "In Inbox" : compact ? "Inbox" : "Add to Inbox"}
    </button>
  );
}
