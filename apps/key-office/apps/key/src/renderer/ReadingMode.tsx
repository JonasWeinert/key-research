// Reading mode: the PDF as clean, reflowed text. The host assembles the text from the
// structure layout analysis stored for the PDF (key-index reflow.rs) and maps places and
// selections back to the page (store_reflow_document, store_reflow_locate); this view only
// displays it, over the page view, which stays loaded underneath. Highlights show on their words
// (CSS Custom Highlights, so the text stays one node per block); a selection becomes a highlight
// stored at its real place in the PDF, or, when the host cannot place it for certain, the page
// view opens at that spot. Typography follows the user's choice; colours follow the app's theme
// (this is Key's rendering of the text; the page view itself is never re-themed).
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { PdfReaderHandle } from "@key-reader/pdfjs/PdfJsBenchmarkApp";
import { HIGHLIGHT_COLORS, type HighlightColor } from "@key-reader/pdfjs/reader-model";
import { useDismiss } from "@key-reader/ui/dismiss";
import { SegmentedTabs } from "@key-reader/ui/SegmentedTabs";
import { Icon } from "./icons";
import "./reading-mode.css";

type Rect = number[];
interface Run {
  start: number;
  end: number;
  page: number;
  rects: Rect[];
}
interface Item {
  id: number;
  kind: string;
  level?: number;
  text: string;
  page: number;
  runs: Run[];
  crop?: { page: number; rect: Rect };
  caption?: { text: string; runs: Run[] };
}
interface ReflowDocument {
  pageCount: number;
  engine: string;
  quality: { level: "good" | "poor" | "empty"; reason?: string };
  items: Item[];
  outline: { item: number; level: number; text: string; page: number }[];
}
interface Mark {
  annotationId: string;
  item: number;
  start: number;
  end: number;
  color: string;
  comment?: string;
}
interface Reply {
  status: "ready" | "missing" | "running" | "unsupported";
  running?: boolean;
  document?: ReflowDocument;
  marks?: Mark[];
  at?: number | null;
}
interface Located {
  certain: boolean;
  page: number;
  quote: string;
  text: string;
  range?: { start: { page: number; index: number }; end: { page: number; index: number } };
  rects?: Rect[];
}

export interface Typography {
  size: number;
  width: "narrow" | "medium" | "wide";
  spacing: "compact" | "normal" | "relaxed";
  font: "serif" | "sans";
}
/** Popovers hang in the reader's root, where its theme tokens are defined. */
const portalRoot = () => document.querySelector<HTMLElement>(".key-ui-root") ?? document.body;
const TYPOGRAPHY_KEY = "key.reading.typography";
const DEFAULT_TYPOGRAPHY: Typography = { size: 18, width: "medium", spacing: "normal", font: "serif" };
const MEASURE = { narrow: "34em", medium: "40em", wide: "50em" } as const;
const LEADING = { compact: 1.42, normal: 1.6, relaxed: 1.82 } as const;

/** The reader's typography, remembered for the user (every reader shares it). */
export function useTypography(): [Typography, (next: Typography) => void] {
  const [value, setValue] = useState<Typography>(() => {
    try {
      return { ...DEFAULT_TYPOGRAPHY, ...JSON.parse(localStorage.getItem(TYPOGRAPHY_KEY) ?? "{}") };
    } catch {
      return DEFAULT_TYPOGRAPHY;
    }
  });
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== TYPOGRAPHY_KEY || !event.newValue) return;
      try {
        setValue({ ...DEFAULT_TYPOGRAPHY, ...JSON.parse(event.newValue) });
      } catch {
        /* keep the current one */
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const update = useCallback((next: Typography) => {
    setValue(next);
    try {
      localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(next));
    } catch {
      /* remembered for this session only */
    }
  }, []);
  return [value, update];
}

/** The "Aa" popover: size, line width, spacing and font. */
export function TypographyPopover({ anchor, value, onChange, onClose }: { anchor: HTMLElement; value: Typography; onChange: (t: Typography) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  useDismiss(true, { refs: [box, anchorRef], onDismiss: onClose, scroll: false });
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left + r.width / 2 - 140, innerWidth - 288));
  return createPortal(
    <div ref={box} className="kx-reading-popover" role="dialog" aria-label="Text options" style={{ left, top: r.bottom + 8 }}>
      <div className="kx-reading-popover-row" role="group" aria-label="Text size">
        <button type="button" className="kx-reading-size" aria-label="Smaller text" disabled={value.size <= 13} onClick={() => onChange({ ...value, size: value.size - 1 })}>
          <span style={{ fontSize: 12 }}>A</span>
        </button>
        <span className="kx-reading-size-value" aria-live="polite">
          {value.size} pt
        </span>
        <button type="button" className="kx-reading-size" aria-label="Larger text" disabled={value.size >= 28} onClick={() => onChange({ ...value, size: value.size + 1 })}>
          <span style={{ fontSize: 18 }}>A</span>
        </button>
      </div>
      <label className="kx-reading-popover-label">Font</label>
      <SegmentedTabs
        size="small"
        label="Font"
        value={value.font}
        onChange={(font) => onChange({ ...value, font })}
        tabs={[
          { id: "serif", label: <span className="kx-reading-face" data-font="serif">Serif</span> },
          { id: "sans", label: <span className="kx-reading-face" data-font="sans">Sans serif</span> },
        ]}
      />
      <label className="kx-reading-popover-label">Line width</label>
      <SegmentedTabs
        size="small"
        label="Line width"
        value={value.width}
        onChange={(width) => onChange({ ...value, width })}
        tabs={[
          { id: "narrow", label: "Narrow" },
          { id: "medium", label: "Medium" },
          { id: "wide", label: "Wide" },
        ]}
      />
      <label className="kx-reading-popover-label">Line spacing</label>
      <SegmentedTabs
        size="small"
        label="Line spacing"
        value={value.spacing}
        onChange={(spacing) => onChange({ ...value, spacing })}
        tabs={[
          { id: "compact", label: "Compact" },
          { id: "normal", label: "Normal" },
          { id: "relaxed", label: "Relaxed" },
        ]}
      />
      <p className="kx-reading-popover-hint">Light or dark follows Key’s appearance. The page view always shows the PDF as printed.</p>
    </div>,
    portalRoot(),
  );
}

/** The outline in reading mode: headings, each scrolling to its place. */
export function ContentsPopover({ anchor, entries, onPick, onClose }: { anchor: HTMLElement; entries: ReflowDocument["outline"]; onPick: (item: number) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  useDismiss(true, { refs: [box, anchorRef], onDismiss: onClose, scroll: false });
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left + r.width / 2 - 160, innerWidth - 328));
  return createPortal(
    <div ref={box} className="kx-reading-popover kx-reading-contents" role="dialog" aria-label="Contents" style={{ left, top: r.bottom + 8 }}>
      {entries.length ? (
        <nav aria-label="Contents">
          {entries.map((entry) => (
            <button
              type="button"
              key={entry.item}
              className="kx-reading-contents-row"
              style={{ paddingLeft: 10 + (Math.min(entry.level, 4) - 1) * 14 }}
              onClick={() => {
                onPick(entry.item);
                onClose();
              }}
            >
              <span>{entry.text}</span>
              <span className="kx-reading-contents-page">{entry.page + 1}</span>
            </button>
          ))}
        </nav>
      ) : (
        <p className="kx-reading-popover-hint">Key found no headings in this PDF.</p>
      )}
    </div>,
    portalRoot(),
  );
}

export interface ReadingModeHandle {
  /** Where the top of the reading view is in the PDF (to open the page view there). */
  place(): { page: number; top: number } | null;
  setQuery(query: string): void;
  step(direction: number): void;
  scrollToItem(item: number): void;
}

export interface ReadingModeState {
  outline: ReflowDocument["outline"];
  /** The page (zero-based) at the top of the view. */
  page: number;
  searchCount: number;
  searchIndex: number;
  ready: boolean;
}

interface Props {
  hash: string;
  reader: RefObject<PdfReaderHandle | null>;
  /** Where the page view was when reading mode opened. */
  start: { page: number; fraction: number };
  typography: Typography;
  invoke: <T>(command: string, args?: unknown) => Promise<T>;
  /** Analyses the PDF again with layout analysis (user-triggered, high priority). */
  analyse?: () => Promise<void>;
  /** Back to the page view, at a place (and the passage to show there). */
  onExit(place?: { page: number; top?: number; quote?: string }): void;
  onState(state: ReadingModeState): void;
  onNotice(message: string): void;
  onCite?(passage: { text: string; page: number; rects: number[][]; color?: string }): void;
  onAddToNote?(passage: { text: string; page: number; color?: string }): void;
}

const fold = (s: string) => s.toLocaleLowerCase();

/** Which item and offset a DOM point in the article is at. */
function textTarget(node: Node | null): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node?.parentElement;
  return el?.closest<HTMLElement>("[data-text]") ?? null;
}
function offsetIn(el: HTMLElement, node: Node, offset: number) {
  if (node.nodeType === Node.TEXT_NODE) return offset;
  // An element boundary (a triple click): before or after the whole text.
  return offset === 0 ? 0 : (el.textContent ?? "").length;
}

/** A figure, table or formula: its region of the page, drawn when it comes near the view. */
function Crop({ item, reader, width }: { item: Item; reader: RefObject<PdfReaderHandle | null>; width: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const crop = item.crop!;
  // As wide as it was in its column, relative to the text's width (a column-wide figure fills it).
  width = Math.round(Math.min(width, Math.max(160, (crop.rect[2] / 65535) * width * 2.1)));
  const aspect = (crop.rect[3] / Math.max(1, crop.rect[2])) * 1.294;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let alive = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        void reader.current
          ?.renderRegion(crop.page, crop.rect, width)
          .then((url) => alive && setSrc(url))
          .catch(() => {});
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(el);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [crop.page, crop.rect, reader, width]);
  const label = item.kind === "table" ? "Table" : item.kind === "equation" ? "Formula" : item.kind === "algorithm" ? "Algorithm" : "Figure";
  return (
    <div ref={box} className="kx-reading-crop" data-kind={item.kind} data-ready={src ? true : undefined} style={src ? undefined : { aspectRatio: `1 / ${aspect || 0.5}`, maxHeight: "72vh" }}>
      {src ? <img src={src} style={{ width }} alt={item.caption?.text || `${label} on page ${crop.page + 1}`} draggable={false} /> : <span className="kx-reading-crop-wait">{label}</span>}
    </div>
  );
}

const ReadingMode = forwardRef<ReadingModeHandle, Props>(function ReadingMode(
  { hash, reader, start, typography, invoke, analyse, onExit, onState, onNotice, onCite, onAddToNote },
  ref,
) {
  const [reply, setReply] = useState<Reply>();
  const [error, setError] = useState("");
  const [showPoor, setShowPoor] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const startRef = useRef(start);
  const positioned = useRef(false);
  // The caller's functions may change identity on every render; reading them through refs keeps
  // the document from loading again each time.
  const call = useRef(invoke);
  call.current = invoke;

  const load = useCallback(
    (first = false) =>
      call.current<Reply>("store_reflow_document", { hash, ...(first ? { page: startRef.current.page, fraction: startRef.current.fraction } : {}) })
        .then((next) => {
          setError("");
          setReply((before) => (first || !before?.document || next.document ? next : { ...before, ...next, document: before.document }));
        })
        .catch((e) => setError(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ""))),
    [hash],
  );
  useEffect(() => {
    void load(true);
  }, [load]);
  // While the PDF is (re)analysed, ask again until its structure is in.
  useEffect(() => {
    if (reply?.status !== "running" && !(analysing && reply?.status === "missing")) return;
    const timer = setTimeout(() => void load(true), 1500);
    return () => clearTimeout(timer);
  }, [reply, analysing, load]);
  // Highlights made or removed elsewhere (the page view, another window).
  useEffect(() => {
    const bridge = (window as unknown as { key: { on(e: string, f: (v: unknown) => void): () => void } }).key;
    return bridge.on("annotations-changed", () => void load());
  }, [load]);

  const doc = reply?.status === "ready" ? reply.document : undefined;
  const items = doc?.items ?? [];
  const marks = reply?.marks ?? [];
  const usable = !!doc && (doc.quality.level === "good" || (doc.quality.level === "poor" && showPoor));

  // Open where the page view was.
  useLayoutEffect(() => {
    if (!usable || positioned.current) return;
    positioned.current = true;
    const at = reply?.at;
    if (at != null && at > 0) article.current?.querySelector(`[data-item="${at}"]`)?.scrollIntoView({ block: "start" });
  }, [usable, reply?.at]);

  // Highlights on their words.
  const textNode = useCallback((item: number) => article.current?.querySelector(`[data-text="${item}"]`)?.firstChild ?? null, []);
  useEffect(() => {
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!registry || !HighlightCtor || !usable) return;
    const byColor = new Map<string, Range[]>();
    for (const mark of marks) {
      const node = textNode(mark.item);
      if (!node) continue;
      const length = node.textContent?.length ?? 0;
      const range = document.createRange();
      range.setStart(node, Math.min(mark.start, length));
      range.setEnd(node, Math.min(mark.end, length));
      const color = HIGHLIGHT_COLORS.includes(mark.color as HighlightColor) ? mark.color : "orange";
      byColor.set(color, [...(byColor.get(color) ?? []), range]);
    }
    for (const color of HIGHLIGHT_COLORS) registry.set(`kx-reading-${color}`, new HighlightCtor(...(byColor.get(color) ?? [])));
    return () => {
      for (const color of HIGHLIGHT_COLORS) registry.delete(`kx-reading-${color}`);
    };
  }, [marks, usable, textNode]);

  // Find in reading mode: every match in the text, the active one brought into view.
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const q = fold(query.trim());
    if (q.length < 2) return [] as { item: number; start: number }[];
    const out: { item: number; start: number }[] = [];
    for (const item of items) {
      const text = fold(item.kind === "figure" ? item.text : item.kind === "table" || item.kind === "equation" || item.kind === "algorithm" ? (item.caption?.text ?? "") : item.text);
      for (let at = text.indexOf(q); at >= 0 && out.length < 5000; at = text.indexOf(q, at + q.length)) out.push({ item: item.id, start: at });
    }
    return out;
  }, [items, query]);
  useEffect(() => setActive(0), [matches]);
  useEffect(() => {
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!registry || !HighlightCtor) return;
    const length = query.trim().length;
    const rangeOf = (m: { item: number; start: number }) => {
      const node = textNode(m.item) ?? article.current?.querySelector(`[data-caption="${m.item}"]`)?.firstChild;
      if (!node) return null;
      const range = document.createRange();
      const max = node.textContent?.length ?? 0;
      range.setStart(node, Math.min(m.start, max));
      range.setEnd(node, Math.min(m.start + length, max));
      return range;
    };
    const all = matches.map(rangeOf).filter((r): r is Range => !!r);
    const current = matches[active] ? rangeOf(matches[active]) : null;
    registry.set("kx-reading-find", new HighlightCtor(...all));
    registry.set("kx-reading-find-active", new HighlightCtor(...(current ? [current] : [])));
    if (current) {
      const box = current.getBoundingClientRect();
      const view = scroller.current?.getBoundingClientRect();
      if (view && (box.top < view.top + 60 || box.bottom > view.bottom - 40)) scroller.current!.scrollBy({ top: box.top - view.top - view.height / 3 });
    }
    return () => {
      registry.delete("kx-reading-find");
      registry.delete("kx-reading-find-active");
    };
  }, [matches, active, query, textNode]);

  // The page at the top of the view, for the toolbar's page number.
  const [topPage, setTopPage] = useState(start.page);
  const place = useCallback((): { page: number; top: number } | null => {
    const view = scroller.current?.getBoundingClientRect();
    const host = article.current;
    if (!view || !host || !doc) return null;
    const y = view.top + 12;
    for (const el of host.querySelectorAll<HTMLElement>("[data-item]")) {
      const box = el.getBoundingClientRect();
      if (box.bottom <= y) continue;
      const item = items[Number(el.dataset.item)];
      if (!item) continue;
      if (item.crop && (item.kind !== "figure" || !item.runs.length)) return { page: item.crop.page, top: Math.max(0, item.crop.rect[1] / 65535 - 0.02) };
      const text = el.querySelector<HTMLElement>("[data-text]") ?? el;
      // The words at the top edge: their run's line on the page.
      const caret = (document as unknown as { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(box.left + 6, Math.max(box.top + 4, y));
      const offset = caret && text.contains(caret.startContainer) ? offsetIn(text, caret.startContainer, caret.startOffset) : 0;
      const run = item.runs.find((r) => offset >= r.start && offset < r.end) ?? item.runs[0];
      if (!run) return { page: item.page, top: 0 };
      const rect = run.rects[0];
      return { page: run.page, top: rect ? Math.max(0, rect[1] / 65535 - 0.02) : 0 };
    }
    return null;
  }, [doc, items]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !usable) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const p = place();
        if (p) setTopPage(p.page);
        setSelection(null);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [usable, place]);

  useEffect(() => {
    onState({ outline: doc?.outline ?? [], page: topPage, searchCount: matches.length, searchIndex: active, ready: usable });
  }, [doc, topPage, matches.length, active, usable, onState]);

  const scrollToItem = useCallback((item: number) => {
    article.current?.querySelector(`[data-item="${item}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      place,
      setQuery,
      step: (direction) => setActive((a) => (matches.length ? (a + direction + matches.length) % matches.length : 0)),
      scrollToItem,
    }),
    [place, matches.length, scrollToItem],
  );

  // A selection in one block: highlight, cite, add to the note, or show it on the page.
  const [selection, setSelection] = useState<{ item: number; caption: boolean; start: number; end: number; text: string; rect: DOMRect } | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = article.current;
    if (!host) return;
    const read = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return setSelection(null);
      const range = sel.getRangeAt(0);
      const el = textTarget(range.startContainer);
      if (!el || !host.contains(el)) return setSelection(null);
      const startOffset = offsetIn(el, range.startContainer, range.startOffset);
      const endOffset = el.contains(range.endContainer) ? offsetIn(el, range.endContainer, range.endOffset) : (el.textContent ?? "").length;
      const text = (el.textContent ?? "").slice(startOffset, endOffset);
      if (!text.trim()) return setSelection(null);
      const item = Number(el.dataset.text ?? el.dataset.caption);
      setSelection({ item, caption: el.dataset.caption !== undefined || items[item]?.kind === "figure", start: startOffset, end: endOffset, text: text.trim(), rect: range.getBoundingClientRect() });
    };
    const up = () => setTimeout(read);
    host.addEventListener("mouseup", up);
    host.addEventListener("keyup", up);
    return () => {
      host.removeEventListener("mouseup", up);
      host.removeEventListener("keyup", up);
    };
  }, [items, usable]);
  useDismiss(!!selection, { refs: [toolbar], onDismiss: () => setSelection(null), kind: "passive", scroll: false });

  const located = async () => {
    if (!selection) return null;
    return call.current<Located>("store_reflow_locate", { hash, item: selection.item, caption: selection.caption, start: selection.start, end: selection.end });
  };
  const uncertain = (found: Located) => {
    onNotice("Key could not place this passage exactly in the PDF, so the page view opens there. Highlight it on the page.");
    onExit({ page: found.page, quote: found.quote });
  };
  const highlight = async (color: HighlightColor) => {
    const chosen = selection;
    try {
      const found = await located();
      if (!found || !chosen) return;
      if (!found.certain || !found.range) return uncertain(found);
      const id = reader.current?.addHighlightAt(found.range, found.text, color);
      if (!id) return onNotice("The page view is not ready yet. Try again in a moment.");
      setReply((r) => r && { ...r, marks: [...(r.marks ?? []), { annotationId: id, item: chosen.item, start: chosen.start, end: chosen.end, color }] });
      document.getSelection()?.removeAllRanges();
      setSelection(null);
      setTimeout(() => void load(), 1200);
    } catch (e) {
      onNotice(`Could not highlight: ${String(e)}`);
    }
  };
  const cite = async () => {
    const found = await located().catch(() => null);
    if (!found) return;
    if (!found.certain || !found.rects?.length) return uncertain(found);
    onCite?.({ text: found.text, page: found.page, rects: found.rects });
    setSelection(null);
  };
  const addToNote = async () => {
    const found = await located().catch(() => null);
    if (!found) return;
    onAddToNote?.({ text: found.certain ? found.text : selection?.text ?? found.quote, page: found.page });
    setSelection(null);
  };
  const showInPage = async () => {
    const found = await located().catch(() => null);
    if (found) onExit({ page: found.page, quote: found.quote });
  };

  const style = {
    "--reading-size": `${typography.size}px`,
    "--reading-measure": MEASURE[typography.width],
    "--reading-leading": LEADING[typography.spacing],
  } as CSSProperties;

  const panel = (title: string, body: string, actions: ReactNode, busy = false) => (
    <div className="kx-reading-state" role="status">
      <Icon name={busy ? "sync" : "readingMode"} size={22} className={busy ? "kx-reading-spin" : undefined} />
      <h2>{title}</h2>
      <p>{body}</p>
      <div className="kx-reading-state-actions">{actions}</div>
    </div>
  );
  const back = (
    <button type="button" className="kx-reading-button" onClick={() => onExit()}>
      Back to page view
    </button>
  );

  let content: ReactNode;
  if (error)
    content = panel(
      "Reading mode is not available",
      /not in the library/i.test(error) ? "Reading mode works for PDFs in your library. Add this PDF to the library and it can be read as text." : error,
      back,
    );
  else if (!reply) content = panel("Preparing the text…", "Key is putting this PDF’s text together.", null, true);
  else if (reply.status === "unsupported") content = panel("Reading mode is for PDFs", "This source has no PDF layout to show as text.", back);
  else if (reply.status === "running" || (analysing && reply.status === "missing"))
    content = panel("Analysing this PDF…", "Key is reading the layout of this PDF: its columns, headings, figures and tables. Reading mode opens as soon as that is done.", back, true);
  else if (reply.status === "missing")
    content = panel(
      "This PDF has not been analysed for reading mode",
      "Reading mode shows the text Key finds when it analyses a PDF’s layout. This one was read before that was kept, or without layout analysis.",
      <>
        {analyse && (
          <button
            type="button"
            className="kx-reading-button"
            data-primary
            onClick={() => {
              setAnalysing(true);
              void analyse()
                .then(() => load(true))
                .catch((e) => {
                  setAnalysing(false);
                  onNotice(String(e));
                });
            }}
          >
            Analyse now
          </button>
        )}
        {back}
      </>,
    );
  else if (doc && !usable)
    content = panel(
      doc.quality.level === "empty" ? "There is no text to show" : "This PDF does not read well as text",
      doc.quality.reason ?? "",
      <>
        {back}
        {doc.quality.level === "poor" && (
          <button type="button" className="kx-reading-button" onClick={() => setShowPoor(true)}>
            Show the text anyway
          </button>
        )}
      </>,
    );
  else if (doc) {
    const commented = new Map<number, Mark[]>();
    for (const mark of marks) if (mark.comment) commented.set(mark.item, [...(commented.get(mark.item) ?? []), mark]);
    let lastPage = -1;
    content = (
      <article ref={article} className="kx-reading-article" aria-label="Reading mode text">
        {items.map((item) => {
          const firstPage = item.runs[0]?.page ?? item.crop?.page ?? item.page;
          const turned = firstPage !== lastPage;
          lastPage = item.runs.at(-1)?.page ?? item.crop?.page ?? item.page;
          const marker = (
            <button
              type="button"
              className="kx-reading-page"
              data-turn={turned || undefined}
              title={`Page ${firstPage + 1}: show in the page view`}
              aria-label={`Show page ${firstPage + 1} in the page view`}
              onClick={() => {
                const run = item.runs[0];
                const rect = run?.rects[0] ?? item.crop?.rect;
                onExit({ page: firstPage, top: rect ? Math.max(0, rect[1] / 65535 - 0.02) : 0 });
              }}
            >
              {firstPage + 1}
            </button>
          );
          const notes = commented.get(item.id);
          const comment = notes && (
            <span className="kx-reading-comment" title={notes.map((n) => n.comment).join("\n\n")} aria-label={`${notes.length === 1 ? "Comment" : `${notes.length} comments`}: ${notes.map((n) => n.comment).join(" · ")}`}>
              <Icon name="comment" size={13} />
            </span>
          );
          if (item.kind === "heading") {
            const level = Math.min(4, item.level ?? 2);
            const Tag = `h${level + 1}` as "h2";
            return (
              <div key={item.id} className="kx-reading-block" data-item={item.id} data-kind="heading">
                {marker}
                <Tag className="kx-reading-heading" data-level={level} data-text={item.id}>
                  {item.text}
                </Tag>
              </div>
            );
          }
          if (item.crop) {
            const caption = item.kind === "figure" ? item.text : item.caption?.text;
            return (
              <figure key={item.id} className="kx-reading-block kx-reading-figure" data-item={item.id} data-kind={item.kind}>
                {marker}
                {item.kind === "table" && caption && <figcaption data-caption={item.id}>{caption}</figcaption>}
                <Crop item={item} reader={reader} width={article.current?.querySelector(".kx-reading-text")?.clientWidth ?? 680} />
                {item.kind !== "table" && caption && (
                  <figcaption {...(item.kind === "figure" ? { "data-text": item.id } : { "data-caption": item.id })}>{caption}</figcaption>
                )}
                {comment}
              </figure>
            );
          }
          return (
            <div key={item.id} className="kx-reading-block" data-item={item.id} data-kind={item.kind}>
              {marker}
              <p className="kx-reading-text" data-kind={item.kind} data-text={item.id}>
                {item.text}
              </p>
              {comment}
            </div>
          );
        })}
      </article>
    );
  }

  return (
    <div className="kx-reading" data-font={typography.font} style={style}>
      <div ref={scroller} className="kx-reading-scroll" data-reading-scroll>
        {content}
      </div>
      {selection &&
        createPortal(
          <div
            ref={toolbar}
            className="kx-reading-selection"
            role="toolbar"
            aria-label="Selection"
            style={{ left: Math.max(8, Math.min(selection.rect.left + selection.rect.width / 2 - 150, innerWidth - 308)), top: Math.max(56, selection.rect.top - 46) }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {HIGHLIGHT_COLORS.map((color) => (
              <button key={color} type="button" className="kx-reading-swatch" data-color={color} aria-label={`Highlight ${color}`} title={`Highlight ${color}`} onClick={() => void highlight(color)} />
            ))}
            <span className="kx-reading-selection-divider" aria-hidden="true" />
            {onCite && (
              <button type="button" className="kx-reading-selection-action" aria-label="Cite" title="Copy as a quote that links back here" onClick={() => void cite()}>
                <Icon name="quote" size={14} />
              </button>
            )}
            {onAddToNote && (
              <button type="button" className="kx-reading-selection-action" aria-label="Add to note" title="Add to this source’s note" onClick={() => void addToNote()}>
                <Icon name="note" size={14} />
              </button>
            )}
            <button type="button" className="kx-reading-selection-action" aria-label="Show in page view" title="Show this passage in the page view" onClick={() => void showInPage()}>
              <Icon name="filePdf" size={14} />
            </button>
          </div>,
          portalRoot(),
        )}
    </div>
  );
});

export default ReadingMode;
