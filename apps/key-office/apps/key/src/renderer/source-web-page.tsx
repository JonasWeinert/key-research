// A reference with no PDF to be had keeps its web page instead: main loads the reference's
// address (or its DOI's landing page) with the browser's profile and library proxies, saves
// it offline (as "Save to library" does) and makes it that source's file.
import { Icon } from "./icons";
import type { Invoke, Source } from "./library-api";
import { libraryChanged } from "./library-nav";
import "./web-reader-panel.css";

export async function saveSourceWebPage(invoke: Invoke, workspaceId: string, sourceId: string) {
  const next = await invoke<Source>("saved_page_fetch", { id: sourceId }, workspaceId);
  libraryChanged();
  return next;
}

/** Offered under "No open-access PDF was found": save the web page instead. */
export function SavePageOffer({ busy, onSave }: { busy: boolean; onSave: () => void }) {
  return (
    <p className="kx-save-page-offer" role="status">
      <Icon name="globe" size={13} />
      <span>{busy ? "Saving the web page…" : "Keep the reference’s web page instead, readable offline."}</span>
      {!busy && (
        <button type="button" className="kx-page-action" onClick={onSave}>
          Save web page
        </button>
      )}
    </p>
  );
}
