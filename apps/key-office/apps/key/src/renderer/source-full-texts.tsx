// A source's full texts on its page: a PDF, a saved web page or both, one of them primary (what
// Read opens and what is indexed; key-store full_text.rs), and the copy of the publisher's page a
// Find PDF attempt kept (main/find-pdf-pages.ts), offered as the full text when no PDF came.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "./icons";
import { Explain } from "./explain";
import { hintText } from "./help-content";
import { libraryChanged, onLibraryChanged } from "./library-nav";
import type { Invoke } from "./library-api";
import "./source-full-texts.css";

export interface FullText {
  hash: string;
  path: string;
  mime?: string;
  kind: "pdf" | "web" | "file";
  size?: number;
  primary: boolean;
  addedAt?: number;
}
export interface KeptPage {
  kept: boolean;
  title?: string;
  url?: string;
  capturedAt?: string;
  abstractOnly?: boolean;
}

const LABEL: Record<string, string> = { pdf: "PDF", web: "Saved web page", file: "File" };

export function useFullTexts(invoke: Invoke, workspaceId: string, sourceId: string, fileHash?: string) {
  const [all, setAll] = useState<FullText[]>([]);
  const load = useCallback(() => void invoke<FullText[]>("store_full_texts", { id: sourceId }, workspaceId).then(setAll, () => setAll([])), [invoke, workspaceId, sourceId]);
  useEffect(load, [load, fileHash]);
  useEffect(() => onLibraryChanged(load), [load]);
  return all;
}

/** The other full texts beside the file card: each with Make primary and Read. */
export function FullTextList({ invoke, workspaceId, sourceId, fullTexts, onChanged, onRead }: { invoke: Invoke; workspaceId: string; sourceId: string; fullTexts: FullText[]; onChanged(): void; onRead(): void }) {
  const [busy, setBusy] = useState("");
  if (fullTexts.length < 2) return null;
  const run = async (command: string, hash: string) => {
    setBusy(hash);
    try {
      await invoke(command, { id: sourceId, hash }, workspaceId);
      libraryChanged();
      onChanged();
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="kx-full-texts" role="list" aria-label="Full texts">
      <div className="kx-full-texts-head">
        <span>Full text</span>
        <Explain help="source.full-text" />
      </div>
      {fullTexts.map((f) => (
        <div key={f.hash} className="kx-full-text" role="listitem" data-primary={f.primary || undefined}>
          <Icon name={f.kind === "pdf" ? "filePdf" : f.kind === "web" ? "fileHtml" : "doc"} size={13} />
          <span className="kx-full-text-name">{LABEL[f.kind] ?? "File"}</span>
          {f.primary ? (
            <>
              <span className="kx-full-text-badge">Primary</span>
              <button type="button" className="kx-full-text-action" onClick={onRead}>
                Read
              </button>
            </>
          ) : (
            <>
              <button type="button" className="kx-full-text-action" disabled={!!busy} title="Read, index and search this one instead" onClick={() => void run("store_full_text_primary", f.hash)}>
                {busy === f.hash ? "Switching…" : "Make primary"}
              </button>
              <button type="button" className="kx-icon-button" disabled={!!busy} title="Remove this copy from the source" aria-label={`Remove the ${LABEL[f.kind] ?? "file"}`} onClick={() => void run("store_full_text_remove", f.hash)}>
                <Icon name="close" size={11} />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** No PDF yet, and Find PDF kept the publisher's page: save it as the full text. */
export function KeptPageOffer({ invoke, workspaceId, sourceId, onSaved }: { invoke: Invoke; workspaceId: string; sourceId: string; onSaved(): void }) {
  const [page, setPage] = useState<KeptPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => void invoke<KeptPage>("find_pdf_page", { sourceId }, workspaceId).then(setPage, () => setPage(undefined)), [invoke, workspaceId, sourceId]);
  useEffect(load, [load]);
  useEffect(() => onLibraryChanged(load), [load]);
  // Find PDF may be on the page in a tab now: its copy is kept a moment after it loads.
  const kept = !!page?.kept;
  useEffect(() => {
    if (kept) return;
    let left = 30;
    const timer = setInterval(() => (--left < 0 ? clearInterval(timer) : load()), 3000);
    return () => clearInterval(timer);
  }, [kept, load]);
  if (!page?.kept) return null;
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await invoke("find_pdf_page_save", { sourceId }, workspaceId);
      libraryChanged();
      onSaved();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kx-kept-page" role="group" aria-label="Saved copy of the publisher’s page">
      <Icon name="fileHtml" size={14} />
      <div className="kx-kept-page-text">
        <span>{page.abstractOnly ? "This page seems to contain only the abstract." : "Key kept a copy of the publisher’s page."}</span>
        {error && <span className="kx-inline-error">{error}</span>}
      </div>
      <button type="button" className="kx-page-action" disabled={busy} title={hintText("source.no-pdf.page")} onClick={() => void save()}>
        {busy ? "Saving…" : "Save this page as the full text"}
      </button>
      <button type="button" className="kx-icon-button" title="Delete the kept copy" aria-label="Delete the kept copy" onClick={() => void invoke("find_pdf_page_discard", { sourceId }, workspaceId).then(load)}>
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}
