// The full text inside the review tab: the record's PDF (kept with the review, or its library
// source's file) in Key's reader, its reading mode when the PDF is a library source, or a saved
// web page. The review drives the reader's selection menu through its host API
// (@key-reader/ui/SelectionMenu.tsx): its actions, a mode (screening or extraction: the review's
// actions first) and its marks (evidence and value sources, drawn apart from the user's own
// highlights). The reader itself knows nothing about reviews.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import PdfJsBenchmarkApp, { type PdfReaderHandle, type ReaderFollowUp, type ReaderMark, type ReaderMarkMenu, type ReaderPassage, type ReaderSelectionAction, type ReaderSelectionActions, type ReaderSelectionMode } from "@key-reader/pdfjs/PdfJsBenchmarkApp";
import { SelectionMenu } from "@key-reader/ui/SelectionMenu";
import { findQuote, markAt, paintTextMarks, textMarkStyles } from "@key-reader/ui/text-marks";
import "@key-reader/styles.css";
import "../pdf-reader.css";
import "../pdf-ui-adapter.css";
import ReadingMode, { useTypography, type ReadingModeHandle } from "../ReadingMode";
import { Icon } from "../icons";
import type { ReviewApi } from "./review-api";
import { errorText } from "./review-ui";

export type { ReaderFollowUp, ReaderMark, ReaderMarkMenu, ReaderPassage, ReaderSelectionAction, ReaderSelectionActions, ReaderSelectionMode };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReaderAnnotationLike = any;

export interface ReviewReaderHandle {
  /** Brings a passage into view (page 0-based) and lights it up. */
  show(page: number, quote?: string): void;
  /** Brings one of the review's marks into view and lights it; false when it is not shown. */
  showMark(id: string): boolean;
}

interface Props {
  api: ReviewApi;
  recordId: string;
  /** Changes when the record's full text changes (a new file attached). */
  version: string;
  title: string;
  mime: string;
  /** The library source behind the PDF: reading mode reads its stored structure. */
  sourceId?: string | null;
  invoke?: <T>(command: string, args?: unknown) => Promise<T>;
  actions: ReaderSelectionActions;
  mode?: ReaderSelectionMode;
  marks?: ReaderMark[];
  markActions?: (mark: ReaderMark) => ReaderMarkMenu | null;
  pickSelection?: ((passage: ReaderPassage) => void) | null;
  /** The review's marks also kept as the user's highlights on a library copy (Setup › rules):
   *  all of them (shown or not), the review's id as their scope. */
  mirror?: { scope: string; note: string; enabled: boolean; marks: ReaderMark[] } | null;
  onError: (text: string) => void;
}

export const ReviewReader = forwardRef<ReviewReaderHandle, Props>(function ReviewReader(props, ref) {
  const { api, recordId, version, title, mime, actions, mode, marks, markActions, pickSelection, onError, sourceId, invoke, mirror } = props;
  const [file, setFile] = useState<File | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState("");
  const reader = useRef<PdfReaderHandle>(null);
  const reading = useRef<ReadingModeHandle>(null);
  const page = useRef<SavedPageHandle>(null);
  const [readingAt, setReadingAt] = useState<{ page: number; fraction: number } | null>(null);
  const [typography] = useTypography();
  const [notice, setNotice] = useState("");
  const canRead = !!sourceId && !!invoke && !mime.includes("html");
  // A library source's highlights are the library's: made here, they are there too.
  const annotationStore = useMemo(
    () =>
      sourceId && invoke
        ? {
            load: () => invoke<ReaderAnnotationLike[]>("library_annotations", { hash: sourceId }),
            save: (annotations: ReaderAnnotationLike[], deleted: string[]) => invoke<void>("library_apply_annotations", { hash: sourceId, upserts: annotations, deleted }),
          }
        : null,
    [sourceId, invoke],
  );
  useImperativeHandle(ref, () => ({
    show(p, quote) {
      if (readingAt) setReadingAt(null);
      if (reader.current) requestAnimationFrame(() => reader.current?.focusAnnotation(undefined, p, quote));
      else page.current?.show(quote ?? "");
    },
    showMark(id) {
      if (readingAt && reading.current?.showMark(id)) return true;
      if (reader.current) return reader.current.showMark(id);
      return page.current?.showMark(id) ?? false;
    },
  }));
  useEffect(() => {
    let live = true;
    setFile(null);
    setHtml(null);
    setFailed("");
    setReadingAt(null);
    api
      .fulltextBytes(recordId)
      .then((bytes) => {
        if (!live) return;
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
        if (mime.includes("html")) setHtml(new TextDecoder().decode(data));
        else setFile(new File([data.slice().buffer], `${title || "Full text"}.pdf`, { type: "application/pdf" }));
      })
      .catch((e) => {
        if (!live) return;
        setFailed(errorText(e));
        onError(errorText(e));
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, recordId, version, mime]);
  if (failed) return <div className="kx-rv-reader-empty"><p className="kx-inline-error">{failed}</p></div>;
  if (html != null) {
    return (
      <div className="kx-rv-reader" data-kind="page">
        <SavedPage ref={page} html={html} title={title} actions={actions} mode={mode} marks={marks} markActions={markActions} pickSelection={pickSelection} />
      </div>
    );
  }
  if (!file) return <div className="kx-rv-reader" aria-busy="true" />;
  return (
    <div className="kx-rv-reader" data-kind="pdf" data-reading={readingAt ? true : undefined}>
      <div className="key-pdf-reader kx-rv-pdf">
        <PdfJsBenchmarkApp
          ref={reader}
          key={`${recordId}:${version}`}
          embedded
          keyboardShortcuts={false}
          initialFile={file}
          paneTitle={title}
          selectionActions={actions}
          selectionMode={mode}
          marks={marks}
          markActions={markActions}
          mirrorMarks={sourceId && mirror ? mirror : null}
          annotationStore={annotationStore}
          pickSelection={readingAt ? null : pickSelection}
        />
        {readingAt && invoke && sourceId && (
          <ReadingMode
            ref={reading}
            hash={sourceId}
            reader={reader}
            start={readingAt}
            typography={typography}
            invoke={invoke}
            onExit={(place) => {
              setReadingAt(null);
              if (place?.quote) requestAnimationFrame(() => reader.current?.focusAnnotation(undefined, place.page, place.quote));
              else if (place) requestAnimationFrame(() => reader.current?.goTo(place.page, place.top ?? 0));
            }}
            onState={() => {}}
            onNotice={(m) => {
              setNotice(m);
              setTimeout(() => setNotice(""), 4000);
            }}
            selectionActions={actions}
            selectionMode={mode}
            marks={marks}
            markActions={markActions}
            pickSelection={pickSelection}
          />
        )}
        {canRead && (
          <div className="kx-rv-reader-tools">
            <button
              type="button"
              className="kx-rv-reader-tool"
              aria-pressed={!!readingAt}
              aria-label="Reading mode"
              title={readingAt ? "Back to the page view" : "Reading mode: the text, reflowed"}
              onClick={() => setReadingAt(readingAt ? null : { page: 0, fraction: 0 })}
            >
              <Icon name="readingMode" size={14} />
            </button>
          </div>
        )}
        {notice && (
          <div className="kx-rv-reader-notice" role="status">
            {notice}
          </div>
        )}
      </div>
    </div>
  );
});

interface SavedPageHandle {
  show(quote: string): void;
  showMark(id: string): boolean;
}

/** A saved page: shown as saved, scripts off. Its selection opens the same menu (page -1, no
 *  boxes) and the review's marks are painted on its words. */
const SavedPage = forwardRef<SavedPageHandle, { html: string; title: string; actions: ReaderSelectionActions; mode?: ReaderSelectionMode; marks?: ReaderMark[]; markActions?: Props["markActions"]; pickSelection?: Props["pickSelection"] }>(function SavedPage(
  { html, title, actions, mode, marks, markActions, pickSelection },
  ref,
) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(0);
  const [sel, setSel] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [markMenu, setMarkMenu] = useState<{ mark: ReaderMark; rect: DOMRect; menu: ReaderMarkMenu } | null>(null);
  const found = useRef(new Map<string, Range>());
  const latest = useRef({ marks, markActions, pickSelection });
  latest.current = { marks, markActions, pickSelection };
  /** A box in the frame → the window. */
  const toWindow = useCallback((r: DOMRect) => {
    const f = frame.current?.getBoundingClientRect();
    return new DOMRect(r.left + (f?.left ?? 0), r.top + (f?.top ?? 0), r.width, r.height);
  }, []);
  const flash = (range: Range) => {
    const doc = frame.current?.contentDocument;
    range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    const win = doc?.defaultView as (Window & { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (...r: Range[]) => unknown }) | null;
    if (!win?.CSS?.highlights || !win.Highlight) return;
    win.CSS.highlights.set("ksm-flash", new win.Highlight(range));
    setTimeout(() => win.CSS?.highlights?.delete("ksm-flash"), 1800);
  };
  useImperativeHandle(ref, () => ({
    show(quote) {
      const body = frame.current?.contentDocument?.body;
      const range = body && quote ? findQuote(body, quote) : null;
      if (range) flash(range);
    },
    showMark(id) {
      const range = found.current.get(id);
      if (!range) return false;
      flash(range);
      return true;
    },
  }));
  // The frame's selection and clicks.
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!doc || !loaded) return;
    const style = doc.createElement("style");
    const css = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    style.textContent = `${textMarkStyles({ notMet: token("--kx-red", "red"), met: token("--kx-green", "green"), evidence: token("--kx-accent", "blue"), source: token("--kx-indigo", "purple") })}\n::highlight(ksm-flash){background-color:${token("--kx-accent-soft", "yellow")};}`;
    doc.head?.appendChild(style);
    const up = () =>
      setTimeout(() => {
        const s = doc.getSelection();
        const text = s?.toString().trim() ?? "";
        if (!text || !s?.rangeCount) return setSel(null);
        const take = latest.current.pickSelection;
        if (take) {
          s.removeAllRanges();
          setSel(null);
          take({ text, page: -1, rects: [] });
          return;
        }
        setMarkMenu(null);
        setSel({ text, rect: toWindow(s.getRangeAt(0).getBoundingClientRect()) });
      });
    const click = (e: MouseEvent) => {
      if (doc.getSelection()?.isCollapsed === false) return;
      const hit = markAt(found.current, e.clientX, e.clientY);
      const mark = hit && latest.current.marks?.find((m) => m.id === hit.id);
      const menu = mark && latest.current.markActions?.(mark);
      if (hit && mark && menu) setMarkMenu({ mark, rect: toWindow(hit.rect), menu });
    };
    const down = () => {
      setSel(null);
    };
    const scroll = () => {
      setSel(null);
      setMarkMenu(null);
    };
    doc.addEventListener("mouseup", up);
    doc.addEventListener("click", click);
    doc.addEventListener("mousedown", down);
    doc.addEventListener("scroll", scroll, true);
    return () => {
      doc.removeEventListener("mouseup", up);
      doc.removeEventListener("click", click);
      doc.removeEventListener("mousedown", down);
      doc.removeEventListener("scroll", scroll, true);
      style.remove();
    };
  }, [loaded, toWindow]);
  useEffect(() => {
    const body = frame.current?.contentDocument?.body;
    if (body && loaded) found.current = paintTextMarks(body, marks ?? []);
  }, [marks, loaded]);
  const clear = () => {
    frame.current?.contentDocument?.getSelection()?.removeAllRanges();
    setSel(null);
  };
  return (
    <>
      <iframe ref={frame} className="kx-rv-reader-page" title={title} sandbox="allow-same-origin" srcDoc={html} onLoad={() => setLoaded((n) => n + 1)} />
      <SelectionMenu
        open={!!sel}
        anchor={sel?.rect ?? null}
        area={() => frame.current?.getBoundingClientRect()}
        label="Text selection actions"
        passage={() => (sel ? { text: sel.text, page: -1, rects: [] } : null)}
        actions={actions}
        mode={mode}
        tools={[{ id: "copy", label: "Copy", icon: "copy", run: () => void navigator.clipboard?.writeText(sel?.text ?? "").catch(() => {}) }]}
        onDone={clear}
        onClose={clear}
      />
      <SelectionMenu
        open={!!markMenu}
        anchor={markMenu?.rect ?? null}
        area={() => frame.current?.getBoundingClientRect()}
        title={markMenu?.menu.title}
        passage={() => (markMenu ? { text: markMenu.mark.text, page: -1, rects: [] } : null)}
        actions={markMenu?.menu.actions}
        mode={markMenu?.menu.mode}
        onDone={() => setMarkMenu(null)}
        onClose={() => setMarkMenu(null)}
      />
    </>
  );
});
