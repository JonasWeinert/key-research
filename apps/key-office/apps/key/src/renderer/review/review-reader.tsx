// The full text inside the review tab: the record's PDF (kept with the review, or its library
// source's file) in Key's reader, or a saved web page. The review adds its own actions to the
// reader's selection toolbar through `selectionActions` (the reader's extension point), so the
// reader itself knows nothing about reviews.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import PdfJsBenchmarkApp, { type PdfReaderHandle, type ReaderSelectionAction } from "@key-reader/pdfjs/PdfJsBenchmarkApp";
import "@key-reader/styles.css";
import "../pdf-reader.css";
import "../pdf-ui-adapter.css";
import type { ReviewApi } from "./review-api";
import { errorText } from "./review-ui";

export type { ReaderSelectionAction };

export interface ReviewReaderHandle {
  /** Brings a passage into view (page 0-based) and lights it up. */
  show(page: number, quote?: string): void;
}

interface Props {
  api: ReviewApi;
  recordId: string;
  /** Changes when the record's full text changes (a new file attached). */
  version: string;
  title: string;
  mime: string;
  actions: ReaderSelectionAction[];
  onError: (text: string) => void;
}

export const ReviewReader = forwardRef<ReviewReaderHandle, Props>(function ReviewReader({ api, recordId, version, title, mime, actions, onError }, ref) {
  const [file, setFile] = useState<File | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState("");
  const reader = useRef<PdfReaderHandle>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  useImperativeHandle(ref, () => ({
    show(page, quote) {
      if (reader.current) reader.current.focusAnnotation(undefined, page, quote);
      else if (quote && frame.current?.contentWindow) (frame.current.contentWindow as Window & { find?: (s: string) => boolean }).find?.(quote.slice(0, 80));
    },
  }));
  useEffect(() => {
    let live = true;
    setFile(null);
    setHtml(null);
    setFailed("");
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
    // A saved page: shown as saved, scripts off. Its selection offers the same actions.
    return (
      <div className="kx-rv-reader" data-kind="page">
        <iframe ref={frame} className="kx-rv-reader-page" title={title} sandbox="allow-same-origin" srcDoc={html} onLoad={() => watchSelection(frame.current, actions)} />
      </div>
    );
  }
  if (!file) return <div className="kx-rv-reader" aria-busy="true" />;
  return (
    <div className="kx-rv-reader" data-kind="pdf">
      <PdfJsBenchmarkApp ref={reader} key={`${recordId}:${version}`} embedded keyboardShortcuts={false} initialFile={file} paneTitle={title} selectionActions={actions} />
    </div>
  );
});

/** A saved page's selection: a small toolbar with the review's actions (page -1, no boxes). */
function watchSelection(frame: HTMLIFrameElement | null, actions: ReaderSelectionAction[]) {
  const doc = frame?.contentDocument;
  if (!doc || !actions.length) return;
  let bar: HTMLDivElement | null = null;
  const hide = () => {
    bar?.remove();
    bar = null;
  };
  doc.addEventListener("mouseup", () => {
    const sel = doc.getSelection();
    const text = sel?.toString().trim() ?? "";
    hide();
    if (!text || !sel?.rangeCount) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    bar = doc.createElement("div");
    bar.setAttribute("style", "position:fixed;z-index:2147483647;display:flex;gap:4px;padding:4px;border-radius:8px;background:Canvas;color:CanvasText;box-shadow:0 2px 10px GrayText;font:12px system-ui");
    bar.style.left = `${Math.max(8, rect.left)}px`;
    bar.style.top = `${rect.bottom + 8}px`;
    for (const a of actions) {
      const b = doc.createElement("button");
      b.textContent = a.label;
      b.title = a.title ?? a.label;
      b.setAttribute("style", "font:inherit;padding:3px 8px;border-radius:6px;border:1px solid GrayText;background:Canvas;color:CanvasText;cursor:pointer");
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        a.run({ text, page: -1, rects: [] });
        hide();
      });
      bar.appendChild(b);
    }
    doc.body.appendChild(bar);
  });
  doc.addEventListener("mousedown", (e) => {
    if (bar && !bar.contains(e.target as Node)) hide();
  });
}
