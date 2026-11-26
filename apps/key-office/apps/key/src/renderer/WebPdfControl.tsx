import { useEffect, useState } from "react";
import { Icon } from "./icons";
import "./web-pdf-control.css";

/** What the reader learns about a PDF from the web (main's reader-ready). */
/** `referrer` is the page that led to the PDF, which the source pill opens in the browser. */
/** `attachTo`: Find PDF opened the page for this source, so the PDF becomes its file. */
export type WebPdfInfo = { url: string; host: string; referrer?: string; inLibrary?: boolean; attachTo?: string } | { notice: "added" | "exists" };
interface WebPdfBridge {
  readerAddToLibrary?(): Promise<{ status: string }>;
  readerOpenInLibrary?(): Promise<void>;
  readerOpenPage?(): Promise<void>;
}
const bridge = () => (window as unknown as { key: WebPdfBridge }).key;
const message = (error: unknown) => String(error).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, "");

/** The floating pill over a PDF opened from the browser: where it came from, and Add to
 * library (or Open in library when the library has it). Once added, the tab becomes the
 * library's reader, which says so briefly. */
export function WebPdfControl({ info }: { info?: WebPdfInfo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [gone, setGone] = useState(false);
  const notice = info && "notice" in info ? info.notice : undefined;
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setGone(true), 3200);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!info) return null;
  if ("notice" in info)
    return (
      <div className="key-web-pdf" role="status" data-gone={gone || undefined}>
        <span className="key-web-pdf-done">
          <Icon name="check" size={13} />
          {info.notice === "added" ? "Added to library" : "In library"}
        </span>
      </div>
    );
  const run = (work: () => Promise<unknown> | undefined) => {
    setBusy(true);
    setError("");
    void Promise.resolve(work())
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="key-web-pdf" role="toolbar" aria-label="PDF from the web">
      <button type="button" className="key-web-pdf-source" title={info.referrer ? `Back to ${info.referrer}` : `Open ${info.host || "the site"} in the browser`} onClick={() => run(() => bridge().readerOpenPage?.())}>
        <Icon name="globe" size={13} />
        <span>{info.host || "Web"}</span>
      </button>
      {error ? (
        <span className="key-web-pdf-error" role="alert" title={error}>
          {error}
        </span>
      ) : null}
      {info.inLibrary ? (
        <>
          <span className="key-web-pdf-done">
            <Icon name="check" size={13} />
            In library
          </span>
          <button type="button" className="key-web-pdf-action" disabled={busy} onClick={() => run(() => bridge().readerOpenInLibrary?.())}>
            Open
          </button>
        </>
      ) : (
        <button
          type="button"
          className="key-web-pdf-action"
          disabled={busy}
          title={info.attachTo ? `Make this PDF the file of “${info.attachTo}”` : "Add this PDF to the library, with the page it came from"}
          onClick={() => run(() => bridge().readerAddToLibrary?.())}
        >
          <Icon name={info.attachTo ? "filePdf" : "plus"} size={12} />
          {busy ? (info.attachTo ? "Attaching…" : "Adding…") : info.attachTo ? "Attach to source" : "Add to library"}
        </button>
      )}
    </div>
  );
}
