// A reference with no PDF to be had keeps its web page instead: main loads the reference's
// address (or its DOI's landing page) with the browser's profile and library proxies, saves
// it offline (as "Save to library" does) and makes it that source's file. When that fails, or
// when the user picks one, a page reader turned on under Web search engines (Firecrawl, Jina)
// reads the page instead (the host's web_read_page).
import { useEffect, useState } from "react";
import type { WebProviderInfo } from "../shared/web-search";
import { Icon } from "./icons";
import type { Invoke, Source } from "./library-api";
import { libraryChanged } from "./library-nav";
import "./web-reader-panel.css";

export async function saveSourceWebPage(invoke: Invoke, workspaceId: string, sourceId: string, reader?: string) {
  const next = await invoke<Source>("saved_page_fetch", { id: sourceId, ...(reader ? { reader } : {}) }, workspaceId);
  libraryChanged();
  return next;
}

/** The page readers that are on (Firecrawl, Jina …), in the user's order. */
function useReaders(invoke?: Invoke) {
  const [readers, setReaders] = useState<WebProviderInfo[]>([]);
  useEffect(() => {
    if (!invoke) return;
    let live = true;
    void invoke<WebProviderInfo[]>("web_providers", {})
      .then((all) => {
        const order = all.find((p) => p.kind === "chain")?.chain?.on ?? [];
        live && setReaders(order.map((id) => all.find((p) => p.id === id)).filter((p): p is WebProviderInfo => !!p?.engine?.reader));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [invoke]);
  return readers;
}

/** Offered under "No open-access PDF was found": save the web page instead. */
export function SavePageOffer({ busy, onSave, invoke }: { busy: boolean; onSave: (reader?: string) => void; invoke?: Invoke }) {
  const readers = useReaders(invoke);
  return (
    <p className="kx-save-page-offer" role="status">
      <Icon name="globe" size={13} />
      <span>{busy ? "Saving the web page…" : readers.length ? `Keep the reference’s web page instead, readable offline. If Key cannot open it, ${readers[0].label} reads it.` : "Keep the reference’s web page instead, readable offline."}</span>
      {!busy && (
        <button type="button" className="kx-page-action" onClick={() => onSave()}>
          Save web page
        </button>
      )}
      {!busy &&
        readers.map((r) => (
          <button key={r.id} type="button" className="kx-page-action" title={`${r.label} reads the page with your key (uses some of its credits)`} onClick={() => onSave(r.id)}>
            With {r.label}
          </button>
        ))}
    </p>
  );
}
