// A review record linked to its library source (the same work): one full text for both, kept in
// step by the host (key-desktop-host review_commands/library_links.rs). Here: the "In your
// library" chip on the record, following library changes live, and the choice when the review and
// the library hold different files for the same work.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "../icons";
import { bridge } from "../library-api";
import { onLibraryChanged } from "../library-nav";
import { GlobalDialog } from "../GlobalDrawer";
import type { RecordView } from "./review-api";
import { Btn, errorText } from "./review-ui";
import type { StageProps } from "./ReviewPage";
import { fullTextChanged } from "./review-browser";

type Conflict = { recordId: string; sourceId: string; libraryMime?: string };
let asking: Conflict | undefined;
const listeners = new Set<() => void>();
const set = (next: Conflict | undefined) => {
  asking = next;
  for (const l of listeners) l();
};

/** After a full text was attached to a record: when the linked library source holds another
 *  file, ask which one the work keeps. */
export function afterAttach(result: unknown, recordId: string) {
  const conflict = (result as { conflict?: { sourceId: string; libraryMime?: string } | null } | undefined)?.conflict;
  if (conflict?.sourceId) set({ recordId, sourceId: conflict.sourceId, libraryMime: conflict.libraryMime });
  fullTextChanged();
}

/** The record's link to the library, and live updates from it: a file attached, replaced or
 *  removed there (or the source merged) shows here at once. */
export function LibraryLink({ view, reload, invoke, workspaceId, reviewId, viewer, notify }: StageProps & { view: RecordView; reload: () => void }) {
  const ask = useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => asking,
  );
  const [busy, setBusy] = useState(false);
  const sourceId = view.sourceId;
  const recordId = view.meta.id;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // The library changed: links follow it (merges, newly added works), then the record.
        void invoke<{ linked: number; repointed: number; shared: number; conflicts: Conflict[] }>("review_links_refresh", { reviewId, actor: viewer }, workspaceId)
          .catch(() => undefined)
          .then((r) => {
            // A record linked with a different file of its own: which one does the work keep?
            const conflict = r?.conflicts?.find((c) => c.recordId === recordId);
            if (conflict) set(conflict);
            reload();
            fullTextChanged();
          });
      }, 150);
    };
    follow();
    const off = bridge().on?.("library-changed", follow);
    const offHere = onLibraryChanged(follow);
    return () => {
      clearTimeout(timer);
      off?.();
      offHere();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, reviewId, viewer, workspaceId, recordId]);
  const decide = async (choice: "library" | "review" | "both") => {
    if (!ask) return;
    setBusy(true);
    try {
      await invoke("review_fulltext_reconcile", { reviewId, recordId: ask.recordId, choice, actor: viewer }, workspaceId);
      notify(choice === "library" ? "Using the library's file" : choice === "review" ? "The library now uses this file too" : "Both files kept", "ok");
      set(undefined);
      reload();
      fullTextChanged();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {sourceId && (
        <button
          type="button"
          className="kx-rv-library-chip"
          title="This work is in your library: its full text is shared. Open its page."
          onClick={() => void bridge().tabAction("open-source-page", { workspaceId, sourceId, title: view.meta.title })}
        >
          <Icon name="books" size={11} /> In your library
        </button>
      )}
      {ask && ask.recordId === view.meta.id && (
        <GlobalDialog label="Two full texts for this work" onClose={() => set(undefined)} busy={busy}>
          <div className="kx-rv-dialog">
            <h2>Two full texts for this work</h2>
            <p className="kx-rv-muted">Your library already has a different {ask.libraryMime?.includes("html") ? "saved page" : "file"} for this work. Choose which one both places use. No file is deleted.</p>
            <div className="kx-rv-dialog-actions">
              <Btn onClick={() => void decide("both")} disabled={busy} title="The review keeps the file you just added; the library keeps its own">
                Keep both
              </Btn>
              <Btn onClick={() => void decide("library")} disabled={busy}>
                Use the library’s file
              </Btn>
              <Btn primary onClick={() => void decide("review")} disabled={busy} title="The library takes this file as its main full text and keeps its own beside it">
                Use the review’s file
              </Btn>
            </div>
          </div>
        </GlobalDialog>
      )}
    </>
  );
}
