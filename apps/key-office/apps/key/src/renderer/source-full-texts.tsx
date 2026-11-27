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
import { DiffChip, LinkDiffSheet } from "./review/review-link-sync";
import { savedViewer } from "./review/review-api";

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

/** Where this source is in the workspace's reviews (linked records share its full text): each
 *  link with a quiet "N fields differ" chip that compares the two descriptions, and review
 *  records that may be this work, to confirm or reject here. Changes made here are undone with
 *  the library's ⌘Z (both sides together). */
export function ReviewLinks({ invoke, workspaceId, sourceId }: { invoke: Invoke; workspaceId: string; sourceId: string }) {
  type Link = { reviewId: string; reviewName: string; recordId: string; state: string; differ?: number };
  type Maybe = { reviewId: string; reviewName: string; recordId: string; kind: string; reason: string; record: { title: string; byline: string } };
  const [links, setLinks] = useState<Link[]>([]);
  const [maybe, setMaybe] = useState<Maybe[]>([]);
  const [comparing, setComparing] = useState<Link>();
  const [status, setStatus] = useState("");
  const load = useCallback(() => {
    void invoke<Link[]>("review_links_for_source", { sourceId }, workspaceId).then((l) => setLinks(l ?? []), () => setLinks([]));
    void invoke<Maybe[]>("review_link_suggestions_for_source", { sourceId }, workspaceId).then((l) => setMaybe(l ?? []), () => setMaybe([]));
  }, [invoke, workspaceId, sourceId]);
  useEffect(load, [load]);
  useEffect(() => onLibraryChanged(load), [load]);
  useEffect(() => {
    const on = (window as unknown as { key: { on?(e: string, f: () => void): () => void } }).key.on;
    const offs = ["review-changed", "source-metadata-changed", "library-changed"].map((e) => on?.(e, load));
    return () => offs.forEach((o) => o?.());
  }, [load]);
  const actor = (reviewId: string) => savedViewer(reviewId) ?? "library";
  const say = (text: string) => {
    setStatus(text);
    setTimeout(() => setStatus(""), 5000);
  };
  const decide = async (m: Maybe, yes: boolean) => {
    try {
      await invoke(yes ? "review_link_confirm" : "review_link_reject", { reviewId: m.reviewId, recordId: m.recordId, sourceId, origin: "library", actor: actor(m.reviewId) }, workspaceId);
      say(yes ? `Linked with the record in ${m.reviewName}. ⌘Z undoes it.` : "Marked as a different work. ⌘Z undoes it.");
      libraryChanged();
      load();
    } catch (e) {
      say(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ""));
    }
  };
  if (!links.length && !maybe.length) return null;
  const open = (reviewId: string, reviewName: string, recordId?: string) =>
    void (window as unknown as { key: { tabAction(a: string, p: unknown): Promise<unknown> } }).key.tabAction("open-content", { section: "review", workspaceId, entityId: reviewId, title: reviewName, recordId, stage: "ta" });
  return (
    <div className="kx-review-links-block">
      {links.length > 0 && (
        <p className="kx-review-links">
          {links.map((l) => (
            <span key={`${l.reviewId}:${l.recordId}`} className="kx-review-link-item">
              <button type="button" className="kx-review-link" title="Open the review (this record shares the source's full text)" onClick={() => open(l.reviewId, l.reviewName)}>
                <Icon name="checklist" size={11} />
                In review {l.reviewName} — {l.state}
              </button>
              <DiffChip count={l.differ ?? 0} onClick={() => setComparing(l)} />
            </span>
          ))}
        </p>
      )}
      {maybe.map((m) => (
        <div key={`${m.reviewId}:${m.recordId}`} className="kx-review-maybe" data-possible-source="">
          <Icon name="checklist" size={12} />
          <span>
            Possibly in review {m.reviewName}: <strong>{m.record.title || "Untitled"}</strong> <small>{m.record.byline}</small>
          </span>
          <button type="button" className="kx-page-action" onClick={() => void decide(m, false)}>
            Different work
          </button>
          <button type="button" className="kx-page-action kx-page-action-primary" onClick={() => void decide(m, true)}>
            Same work — link
          </button>
        </div>
      ))}
      {status && (
        <p className="kx-review-links-status" role="status">
          {status}
        </p>
      )}
      {comparing && (
        <LinkDiffSheet
          invoke={invoke}
          workspaceId={workspaceId}
          reviewId={comparing.reviewId}
          recordId={comparing.recordId}
          actor={actor(comparing.reviewId)}
          origin="library"
          onClose={() => setComparing(undefined)}
          onDone={(message) => {
            say(`${message}. ⌘Z undoes it.`);
            libraryChanged();
            load();
          }}
        />
      )}
    </div>
  );
}

/** No PDF yet, and Find PDF kept the publisher's page: save it as the full text. */
export function KeptPageOffer({ invoke, workspaceId, sourceId, onSaved, onKept }: { invoke: Invoke; workspaceId: string; sourceId: string; onSaved(): void; onKept?(kept: boolean): void }) {
  const [page, setPage] = useState<KeptPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => void invoke<KeptPage>("find_pdf_page", { sourceId }, workspaceId).then(setPage, () => setPage(undefined)), [invoke, workspaceId, sourceId]);
  useEffect(load, [load]);
  useEffect(() => onLibraryChanged(load), [load]);
  // Find PDF may be on the page in a tab now: its copy is kept a moment after it loads.
  const kept = !!page?.kept;
  useEffect(() => onKept?.(kept), [kept, onKept]);
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
        <span>{page.abstractOnly ? "Key kept a copy of the publisher’s page. It seems to contain only the abstract." : "Key kept a copy of the publisher’s page from Find PDF."}</span>
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
