// "Add to library" for a web result, in its row and in the preview beside the results. One
// place owns adding (and the open-access PDF that follows), so a shared "add from source"
// chooser can take this over without touching the rows.
import { useCallback, useState } from "react";
import type { WebHit } from "../shared/web-search";
import { Icon } from "./icons";
import { openItemAt, toast } from "./item-actions";
import type { Invoke, Source } from "./library-api";
import { errorText, type WebSearchState } from "./web-search";
import { findPdfAfterAdd } from "./find-pdf";

export type Adding = "adding" | "pdf";

export function useWebAdd(web: WebSearchState, invoke: Invoke, workspaceId: string, collectionId?: string) {
  const [adding, setAdding] = useState<Record<string, Adding>>({});
  const add = useCallback(
    async (hit: WebHit) => {
      setAdding((a) => ({ ...a, [hit.key]: "adding" }));
      try {
        const { source, existed } = await invoke<{ source: Source; existed: boolean }>("web_add_to_library", { work: hit, collectionId: collectionId ?? null }, workspaceId);
        web.noted(hit.key, source.id);
        if (!existed && hit.pdfUrl) {
          // The PDF follows in the background; the reference is already in the library.
          setAdding((a) => ({ ...a, [hit.key]: "pdf" }));
          await invoke("library_download_pdf", { url: hit.pdfUrl, sourceId: source.id }, workspaceId).catch((e) => toast(`Added without the PDF: ${errorText(e)}`));
        } else if (existed) toast("Already in your library");
        else void findPdfAfterAdd(invoke, workspaceId, source.id);
      } catch (e) {
        toast(`Couldn't add it: ${errorText(e)}`);
      } finally {
        setAdding(({ [hit.key]: _, ...rest }) => rest);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [invoke, workspaceId, collectionId, web.noted],
  );
  const openSource = useCallback(
    (hit: WebHit, newTab = false) => openItemAt({ kind: "source", id: web.inLibrary[hit.key] ?? web.possible[hit.key] }, newTab ? "tab" : "split", hit.title, workspaceId, invoke),
    [web.inLibrary, web.possible, workspaceId, invoke],
  );
  return { adding, add, openSource };
}

export type WebAdd = ReturnType<typeof useWebAdd>;

/** Adding…, In library · Open, or Add to library. */
export function WebAddButton({ hit, web, adder, large }: { hit: WebHit; web: WebSearchState; adder: WebAdd; large?: boolean }) {
  const sourceId = web.inLibrary[hit.key];
  const state = adder.adding[hit.key];
  if (state)
    return (
      <span className="kx-web-progress" role="status">
        <span className="kx-search-spinner" aria-hidden="true" />
        {state === "pdf" ? "Fetching PDF…" : "Adding…"}
      </span>
    );
  if (sourceId)
    return (
      <button type="button" className="kx-web-in" data-large={large || undefined} title="In your library: open it (⌘-click: in a new tab)" onClick={(e) => (e.stopPropagation(), adder.openSource(hit, e.metaKey))}>
        <Icon name="check" size={11} />
        In library
        <span className="kx-web-in-open">Open</span>
      </button>
    );
  const add = (
    <button type="button" className="kx-web-add" data-large={large || undefined} onClick={(e) => (e.stopPropagation(), void adder.add(hit))}>
      <Icon name="plus" size={11} />
      {web.possible[hit.key] ? "Add anyway" : "Add to library"}
    </button>
  );
  // Only the title matched: the library's copy is one click away, and adding stays possible.
  if (web.possible[hit.key])
    return (
      <span className="kx-web-possible">
        <button type="button" className="kx-web-in" data-possible data-large={large || undefined} title="A work with this title is in your library: open it (⌘-click: in a new tab)" onClick={(e) => (e.stopPropagation(), adder.openSource(hit, e.metaKey))}>
          Possibly in library
          <span className="kx-web-in-open">Open</span>
        </button>
        {add}
      </span>
    );
  return add;
}
