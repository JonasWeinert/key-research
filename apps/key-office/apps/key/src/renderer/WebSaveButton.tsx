import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { bridge } from "./library-api";
import { shellContext, toast } from "./item-actions";
import { openWebPage } from "./web-page-open";
import "./web-page.css";

/** The browser bar's "Save to library": saves the page offline as a source; on a page that
 * is saved already it says so, and opens the saved copy. */
export function WebSaveButton({ viewId, url, loading }: { viewId: string; url: string; loading?: boolean }) {
  const [found, setFound] = useState<{ id: string; saved: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const workspaceId = shellContext().workspaceId;
  useEffect(() => bridge().on("library-changed", () => setRevision((r) => r + 1)), []);
  useEffect(() => {
    if (!workspaceId || !/^https?:/i.test(url)) return setFound(null);
    let live = true;
    void shellContext()
      .invoke!("saved_page_find", { url }, workspaceId)
      .then((value) => live && setFound((value as { id: string; saved: boolean } | null) ?? null))
      .catch(() => live && setFound(null));
    return () => {
      live = false;
    };
  }, [url, workspaceId, revision]);
  if (!workspaceId || !/^https?:/i.test(url)) return null;
  const save = async () => {
    setBusy(true);
    try {
      const saved = (await shellContext().invoke!("saved_page_save", { viewId }, workspaceId)) as { id: string };
      setFound({ id: saved.id, saved: true });
      toast("Saved to your library");
    } catch (error) {
      toast(`Could not save the page: ${String(error).replace(/^Error: /, "")}`);
    } finally {
      setBusy(false);
    }
  };
  if (found?.saved)
    return (
      <span className="key-web-saved">
        <button type="button" className="key-web-save" data-saved title="Open the saved copy" onClick={() => openWebPage(workspaceId, found.id)}>
          <Icon name="bookmark" size={12} fill="currentColor" />
          <span>In library</span>
        </button>
        <button type="button" className="key-web-save key-web-resave" title="Save the page again as it is now" aria-label="Save again" disabled={busy} onClick={() => void save()}>
          <Icon name="retry" size={12} />
        </button>
      </span>
    );
  return (
    <button type="button" className="key-web-save" title="Save this page to your library, readable offline (⌘D)" disabled={busy || loading} aria-busy={busy || undefined} onClick={() => void save()}>
      <Icon name="bookmark" size={12} />
      <span>{busy ? "Saving…" : "Save to library"}</span>
    </button>
  );
}
