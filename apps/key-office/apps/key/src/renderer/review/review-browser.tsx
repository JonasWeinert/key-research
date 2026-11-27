// Key's browser inside the review, in the full-text pane where the reader sits: looking for one
// record's full text. The page itself is a native view main places over `.kx-rv-browser-page`
// (main/index.ts "embedded-browser-*"); the bar, the Find PDF banner and the questions are drawn
// here. The attempt lasts while this is open: across pages, sign-ins and proxies, until a PDF is
// caught or the person closes it. A caught PDF is checked (is it this record's work, more than a
// preview page?) and attached to the record (kept with the review), and the reader takes over.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { bridge } from "../library-api";
import { BrowserBar, type WebBarState, type WebPageOp } from "../BrowserBar";
import { FindPdfBanner, type FindPdfBannerOp, type FindPdfBannerState } from "../FindPdfBanner";
import type { RecordView } from "./review-api";
import { Btn, errorText } from "./review-ui";
import type { StageProps } from "./ReviewPage";
import { afterAttach } from "./review-library-link";
import "./review-browser.css";

// ── Requests from elsewhere in the review (the Full texts list) and live updates ──

export interface BrowseRequest {
  recordId: string;
  url: string;
  /** Opened from a list of records needing a full text: offer the next one after. */
  fromList?: boolean;
}
let pending: BrowseRequest | undefined;
let opener: ((recordId: string) => void) | undefined;
let queue: { id: string; url: string }[] = [];
/** The Full texts list asks the record's view to open its browser (the record opens next). */
export function requestBrowse(request: BrowseRequest, open: (recordId: string) => void, list: { id: string; url: string }[]) {
  pending = request;
  opener = open;
  queue = list;
}
export function takeBrowse(recordId: string) {
  if (pending?.recordId !== recordId) return undefined;
  const found = pending;
  pending = undefined;
  return found;
}
const listeners = new Set<() => void>();
/** A record's full text changed here: lists showing it reload. */
export function fullTextChanged() {
  for (const l of listeners) l();
}
export function onFullTextChanged(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

type State = { id: string; web?: WebBarState & { findPdf?: FindPdfBannerState }; pdf?: { name: string; size: number; url: string }; request?: string; closed?: boolean };
type Question = { kind: "other" | "preview" | "large"; text: string; detail?: string };

const tab = (action: string, payload: Record<string, unknown>) => bridge().tabAction(action, payload) as Promise<any>;
const LARGE = 150 * 1024 * 1024;

export function ReviewBrowser(props: StageProps & { view: RecordView; url: string; fromList?: boolean; onClose: () => void; onAttached: () => void }) {
  const { api, invoke, workspaceId, reviewId, viewer, view, url, active, notify, onClose, onAttached } = props;
  const [state, setState] = useState<State>();
  const [address, setAddress] = useState(url);
  const [question, setQuestion] = useState<Question>();
  const [busy, setBusy] = useState("");
  const page = useRef<HTMLDivElement>(null);
  const id = state?.id;
  const handled = useRef("");

  // Open on mount, close (ending the attempt) on unmount.
  useEffect(() => {
    let live = true;
    let opened = "";
    void tab("embedded-browser-open", { url, review: { workspaceId, reviewId, recordId: view.meta.id, title: view.meta.title } })
      .then((r: { id: string; state: State }) => {
        opened = r.id;
        if (live) setState(r.state);
        else void tab("embedded-browser-close", { id: r.id });
      })
      .catch((e) => notify(errorText(e), "error"));
    const off = bridge().on("embedded-browser", (value) => {
      const next = value as State;
      if (!opened || next.id !== opened) return;
      if (next.closed) return setState(undefined);
      setState(next);
    });
    return () => {
      live = false;
      off?.();
      if (opened) void tab("embedded-browser-close", { id: opened });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.meta.id, url]);

  // The page goes where the placeholder is, while the review shows it.
  useEffect(() => {
    if (!id) return;
    let last = "";
    const send = () => {
      const el = page.current;
      const r = el?.getBoundingClientRect();
      const rect = active && r && r.width > 0 && r.height > 0 && el!.offsetParent ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
      const key = JSON.stringify(rect);
      if (key === last) return;
      last = key;
      void tab("embedded-browser-bounds", { id, rect });
    };
    send();
    const timer = setInterval(send, 250);
    const observer = new ResizeObserver(send);
    if (page.current) observer.observe(page.current);
    window.addEventListener("resize", send);
    return () => {
      clearInterval(timer);
      observer.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [id, active]);

  // Esc closes (when the focus is in the review, not in the page).
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !question && !(e.target as HTMLElement)?.closest?.("input, textarea") && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, question]);

  const finish = useCallback(
    (text: string, tone: "ok" | "error" = "ok") => {
      fullTextChanged();
      const next = props.fromList ? queue.find((q) => q.id !== view.meta.id) : undefined;
      notify(text, tone, next && opener ? { label: "Next record needing full text", run: () => (requestBrowse({ recordId: next.id, url: next.url, fromList: true }, opener!, queue.filter((q) => q.id !== view.meta.id)), opener!(next.id)) } : undefined);
      onAttached();
    },
    [notify, onAttached, props.fromList, view.meta.id],
  );

  /** Attaches the caught PDF to the record (kept with the review; the temp copy goes). */
  const attach = useCallback(
    async (path: string, name: string) => {
      setQuestion(undefined);
      const done = await api.attach(view.meta.id, path, name, "browser", viewer, true);
      afterAttach(done, view.meta.id);
      queue = queue.filter((q) => q.id !== view.meta.id);
      finish((done as { same?: boolean }).same ? "This full text was attached already" : "Full text added");
    },
    [api, finish, view.meta.id, viewer],
  );

  // A PDF arrived: is it this record's, and more than a preview page?
  useEffect(() => {
    const pdf = state?.pdf;
    if (!id || !pdf || handled.current === `${id}:${pdf.url}:${pdf.size}`) return;
    handled.current = `${id}:${pdf.url}:${pdf.size}`;
    void (async () => {
      try {
        const caught = await invoke<{ path: string; name: string; size: number; base64: string | null }>("embedded_browser_pdf", { id }, workspaceId);
        if (caught.size > LARGE || !caught.base64) return setQuestion({ kind: "large", text: `This PDF is large (${Math.round(caught.size / 1024 / 1024)} MB).`, detail: "Attach it anyway, or keep looking for a smaller copy." });
        const { pdfFirstPages } = await import("@key-reader/pdfjs/pdf-first-pages");
        const bytes = Uint8Array.from(atob(caught.base64), (c) => c.charCodeAt(0));
        const read = await pdfFirstPages(bytes.buffer as ArrayBuffer).catch(() => ({ title: "", text: "", pages: 0 }));
        const doi = /\b10\.\d{4,9}\/[^\s"<>]+/.exec(read.text)?.[0]?.replace(/[.,;)\]]+$/, "") ?? "";
        const check = await invoke<{ verdict: string; foundTitle: string; foundDoi: string; otherRecord?: { title: string } }>(
          "review_fulltext_check",
          { reviewId, recordId: view.meta.id, file: { name: "", path: caught.path, title: read.title, doi, text: read.text } },
          workspaceId,
        ).catch(() => ({ verdict: "unknown", foundTitle: "", foundDoi: "", otherRecord: undefined }));
        if (check.verdict === "other")
          return setQuestion({
            kind: "other",
            text: "This PDF seems to be a different work.",
            detail: [check.otherRecord ? `It looks like “${check.otherRecord.title}”, another record.` : check.foundTitle ? `Its title: “${check.foundTitle}”.` : "", check.foundDoi ? `Its DOI: ${check.foundDoi}.` : ""].filter(Boolean).join(" "),
          });
        if (read.pages === 1) return setQuestion({ kind: "preview", text: "Only one page came: this may be a preview of the article.", detail: "Keep looking for the full PDF, or attach this page anyway." });
        await attach(caught.path, caught.name);
      } catch (e) {
        notify(errorText(e), "error");
        void tab("embedded-browser-reject", { id, why: errorText(e) });
      }
    })();
  }, [id, state?.pdf, invoke, workspaceId, reviewId, view.meta.id, attach, notify]);

  const keepLooking = (why?: string) => {
    setQuestion(undefined);
    handled.current = "";
    void tab("embedded-browser-reject", { id, why });
  };
  const attachAnyway = () =>
    void invoke<{ path: string; name: string }>("embedded_browser_pdf", { id, bytes: false }, workspaceId)
      .then((caught) => attach(caught.path, caught.name))
      .catch((e) => notify(errorText(e), "error"));

  /** The page itself as the full text (a saved snapshot, kept with the review). */
  const savePage = useCallback(async () => {
    if (!id) return;
    setBusy("saving");
    try {
      const saved = await invoke<{ path: string; title: string; abstractOnly?: boolean }>("saved_page_capture", { viewId: id }, workspaceId);
      const done = await api.attach(view.meta.id, saved.path, `${(saved.title || view.meta.title).slice(0, 80)}.html`, "snapshot", viewer, true);
      afterAttach(done, view.meta.id);
      queue = queue.filter((q) => q.id !== view.meta.id);
      finish((done as { same?: boolean }).same ? "This page was attached already" : saved.abstractOnly ? "Saved the page; it may show only the abstract" : "Saved the page as the full text", saved.abstractOnly ? "error" : "ok");
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy("");
    }
  }, [api, finish, id, invoke, notify, view.meta.id, view.meta.title, viewer, workspaceId]);

  // The banner's More menu (drawn by main) asks the review to save the page or give up.
  useEffect(() => {
    if (!state?.request) return;
    if (state.request === "save") void savePage();
    else if (state.request === "unavailable") onClose();
    setState((s) => (s ? { ...s, request: undefined } : s));
  }, [state?.request, savePage, onClose]);

  // The address follows the page (unless the person is typing one).
  const shownUrl = state?.web?.url;
  useEffect(() => {
    if (shownUrl && document.activeElement?.getAttribute("aria-label") !== "Address") setAddress(shownUrl);
  }, [shownUrl]);

  const onBanner = (op: FindPdfBannerOp, link?: string, at?: { x: number; y: number }) => {
    if (op === "save") return void savePage();
    if (op === "unavailable") return onClose();
    void tab("find-pdf-banner", { viewId: id, op, url: link, ...at });
  };
  const web = state?.web;
  return (
    <div className="kx-rv-browser" aria-label="Find the full text" data-busy={busy || undefined}>
      <div className="kx-rv-browser-head">
        <Icon name="globe" size={13} />
        <form
          className="kx-rv-browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            if (id && address.trim()) void tab("embedded-browser-navigate", { id, url: address });
          }}
        >
          <input aria-label="Address" value={address} spellCheck={false} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        </form>
        <Btn small quiet onClick={onClose} title="Close the browser (Esc); the record keeps needing its full text">
          <Icon name="close" size={11} /> Close
        </Btn>
      </div>
      {web && <BrowserBar state={web} style={{ width: "100%" }} onStep={(step) => void tab("history", { viewId: id, step })} onPage={(op: WebPageOp) => void tab("web-page", { viewId: id, op })} />}
      {web?.findPdf && !question && <FindPdfBanner state={web.findPdf} style={{ width: "100%" }} onOp={onBanner} />}
      {question && (
        <div className="kx-rv-browser-question" role="alert" data-kind={question.kind}>
          <Icon name="warning" size={14} />
          <div>
            <strong>{question.text}</strong>
            {question.detail && <span>{question.detail}</span>}
          </div>
          <Btn small onClick={() => keepLooking(question.kind === "other" ? "That PDF seemed to be another work; Key is still watching for this record’s." : "Key is still watching for the full PDF.")}>
            Keep looking
          </Btn>
          <Btn small primary onClick={attachAnyway}>
            Attach anyway
          </Btn>
        </div>
      )}
      <div ref={page} className="kx-rv-browser-page" />
    </div>
  );
}
