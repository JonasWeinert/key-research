// Reading mode: a PDF or a saved web page as clean, reflowed text. The host assembles the text:
// a PDF's from the structure layout analysis stored for it (key-index reflow.rs;
// store_reflow_document, store_reflow_locate), a web page's from its saved snapshot (key-index
// web_reflow.rs; store_web_reflow_*), in one document shape. This view only displays it, over
// the original view, which stays loaded underneath. Highlights show on their words (CSS Custom
// Highlights, so the text stays the item's own); a selection becomes a highlight stored at its
// real place in the original, or, when the host cannot place it for certain, the original view
// opens at that spot. Typography follows the user's choice (one setting for every reader);
// colours follow the app's theme (this is Key's rendering of the text; the original is never
// re-themed).
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { PdfReaderHandle } from "@key-reader/pdfjs/PdfJsBenchmarkApp";
import { HIGHLIGHT_COLORS, HIGHLIGHT_COLOR_RGB, type HighlightColor } from "@key-reader/pdfjs/reader-model";
import { useDismiss } from "@key-reader/ui/dismiss";
import { SegmentedTabs } from "@key-reader/ui/SegmentedTabs";
import { SelectionMenu, type ReaderMark, type ReaderMarkMenu, type ReaderPassage, type ReaderSelectionActions, type ReaderSelectionMode } from "@key-reader/ui/SelectionMenu";
import { markAt, paintTextMarks } from "@key-reader/ui/text-marks";
import { Icon } from "./icons";
import "./reading-mode.css";

type Rect = number[];
interface Run {
  start: number;
  end: number;
  page: number;
  rects: Rect[];
  /** A web page's: where the run's text starts in the page's text. */
  at?: number;
}
export interface Span {
  start: number;
  end: number;
  kind: "em" | "strong" | "code" | "sup" | "sub" | "link" | "cite" | "math" | "image";
  href?: string;
  target?: number;
  math?: string;
  resource?: number;
  alt?: string;
}
interface Cell {
  text: string;
  runs: Run[];
  spans?: Span[];
  header: boolean;
  colspan?: number;
  rowspan?: number;
}
interface Item {
  id: number;
  kind: string;
  level?: number;
  text: string;
  page: number;
  runs: Run[];
  crop?: { page: number; rect: Rect };
  caption?: { text: string; runs: Run[]; spans?: Span[] };
  spans?: Span[];
  images?: { resource?: number; alt: string; width?: number; height?: number }[];
  table?: { rows: Cell[][] };
  math?: string;
  marker?: string;
  anchors?: string[];
}
interface ReflowDocument {
  pageCount: number;
  engine: string;
  quality: { level: "good" | "poor" | "empty"; reason?: string };
  items: Item[];
  outline: { item: number; level: number; text: string; page: number }[];
  meta?: { title?: string; byline?: string; date?: string; site?: string; url?: string };
}
interface Mark {
  annotationId: string;
  item: number;
  part?: string;
  start: number;
  end: number;
  color: string;
  comment?: string;
}
export interface ReadingReply {
  status: "ready" | "missing" | "running" | "unsupported";
  running?: boolean;
  document?: ReflowDocument;
  marks?: Mark[];
  at?: number | null;
  /** A web page's text: its length and checksum, to compare with the reader's own. */
  text?: { length: number; hash: number };
}
interface Located {
  certain: boolean;
  page: number;
  quote: string;
  text: string;
  range?: { start: { page: number; index: number }; end: { page: number; index: number } };
  rects?: Rect[];
}
/** A stretch of reading-mode text: an item's own text (part "") or its "caption" or a table
 *  cell ("cell:row:column"), with UTF-16 offsets. */
export interface Stretch {
  item: number;
  part?: string;
  start: number;
  end: number;
}
export interface ReadingSelection extends Stretch {
  part: string;
  text: string;
}

/** What a saved web page's reader does for reading mode (WebPageReader.tsx). */
export interface WebReadingBackend {
  load(first: boolean): Promise<ReadingReply>;
  /** A picture of the page, by its resource number (the page's own inlined copy). */
  resource(n: number): Promise<string>;
  /** Highlights the selection on the page: its id, or null when Key cannot place it for certain. */
  highlight(selection: ReadingSelection, color: HighlightColor, comment?: string): Promise<string | null>;
  /** A highlight's colour or comment changed, or it is removed. */
  updateAnnotation(id: string, patch: { color?: HighlightColor; comment?: string }): Promise<void>;
  removeAnnotation(id: string): Promise<void>;
  cite(selection: ReadingSelection): Promise<void>;
  copy(selection: ReadingSelection): Promise<void>;
  openLink(href: string): void;
}

// An action a reader's host adds to the selection menu (a review's "Evidence", say), its mode and
// marks: @key-reader/ui/SelectionMenu.tsx (for a web page `page` is -1 and `rects` empty).
export type { ReaderMark, ReaderMarkMenu, ReaderSelectionAction, ReaderSelectionActions, ReaderSelectionMode } from "@key-reader/ui/SelectionMenu";

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
export function TypographyPopover({ anchor, value, onChange, onClose, original = "PDF" }: { anchor: HTMLElement; value: Typography; onChange: (t: Typography) => void; onClose: () => void; original?: "PDF" | "web page" }) {
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
      <p className="kx-reading-popover-hint">
        {original === "PDF" ? "Light or dark follows Key’s appearance. The page view always shows the PDF as printed." : "Light or dark follows Key’s appearance. The original view always shows the page as it was saved."}
      </p>
    </div>,
    portalRoot(),
  );
}

/** The outline in reading mode: headings, each scrolling to its place. */
export function ContentsPopover({ anchor, entries, onPick, onClose, original = "PDF" }: { anchor: HTMLElement; entries: ReflowDocument["outline"]; onPick: (item: number) => void; onClose: () => void; original?: "PDF" | "web page" }) {
  const box = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  useDismiss(true, { refs: [box, anchorRef], onDismiss: onClose, scroll: false });
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left + r.width / 2 - 160, innerWidth - 328));
  const pages = original === "PDF";
  return createPortal(
    <div ref={box} className="kx-reading-popover kx-reading-contents" role="dialog" aria-label="Contents" style={{ left, top: r.bottom + 8 }}>
      {entries.length ? (
        <nav aria-label="Contents">
          {entries.map((entry) => (
            <button
              type="button"
              key={entry.item}
              className="kx-reading-contents-row"
              data-level={Math.min(entry.level, 4)}
              style={{ paddingLeft: 10 + (Math.min(entry.level, 4) - 1) * 14 }}
              onClick={() => {
                onPick(entry.item);
                onClose();
              }}
            >
              <span>{entry.text}</span>
              {pages && <span className="kx-reading-contents-page">{entry.page + 1}</span>}
            </button>
          ))}
        </nav>
      ) : (
        <p className="kx-reading-popover-hint">Key found no headings in this {original}.</p>
      )}
    </div>,
    portalRoot(),
  );
}

export interface ReadingModeHandle {
  /** Where the top of the reading view is in the original (to open it there): a PDF's page and
   *  fraction down it; a web page's offset into its text. */
  place(): { page: number; top: number; offset?: number } | null;
  setQuery(query: string): void;
  step(direction: number): void;
  scrollToItem(item: number): void;
  /** Brings stretches of the text into view and lights them (a search hit, a highlight). */
  showPassage(stretches: Stretch[], keep?: boolean): boolean;
  /** Brings a host mark into view and lights it up; false when the text does not have it. */
  showMark(id: string): boolean;
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
  /** A PDF: its hash and page view. */
  hash?: string;
  reader?: RefObject<PdfReaderHandle | null>;
  /** A saved web page: its reader's side of reading mode. */
  web?: WebReadingBackend;
  /** Where the page view was when reading mode opened. */
  start: { page: number; fraction: number };
  typography: Typography;
  invoke: <T>(command: string, args?: unknown) => Promise<T>;
  /** Analyses the PDF again with layout analysis (user-triggered, high priority). */
  analyse?: () => Promise<void>;
  /** Back to the original view, at a place (and the passage to show there). */
  onExit(place?: { page: number; top?: number; quote?: string; offset?: number }): void;
  onState(state: ReadingModeState): void;
  onNotice(message: string): void;
  /** The text does not read well: say why (the caller stays in the original view). Without it,
   *  reading mode says so itself and offers the text anyway. */
  onUnreadable?(reason: string): void;
  onCite?(passage: { text: string; page: number; rects: number[][]; color?: string }): void;
  onAddToNote?(passage: { text: string; page: number; color?: string }): void;
  /** Actions the reader's host adds to the selection menu, after Cite. */
  selectionActions?: ReaderSelectionActions;
  /** With it, the host's actions are the selection menu (SelectionMenu.tsx). */
  selectionMode?: ReaderSelectionMode;
  /** The host's marks, found in the text by their quotes; a click opens `markActions`. */
  marks?: ReaderMark[];
  markActions?: (mark: ReaderMark) => ReaderMarkMenu | null;
  /** While set, the next selection goes straight here (no menu). */
  pickSelection?: ((passage: ReaderPassage) => void) | null;
}

/** Case and no-break spaces aside, as Find compares. */
const fold = (s: string) => s.toLocaleLowerCase().replace(/ /g, " ");

/** The texts of an item a reader can find, select and highlight in. */
function textParts(item: Item, web: boolean): { part: string; text: string }[] {
  if (!web) {
    const captioned = item.kind === "table" || item.kind === "equation" || item.kind === "algorithm";
    return captioned ? [{ part: "caption", text: item.caption?.text ?? "" }] : [{ part: "", text: item.text }];
  }
  const out = [{ part: "", text: item.text }];
  if (item.caption) out.push({ part: "caption", text: item.caption.text });
  item.table?.rows.forEach((row, r) => row.forEach((cell, c) => out.push({ part: `cell:${r}:${c}`, text: cell.text })));
  return out.filter((p) => p.text);
}
function partOf(item: Item | undefined, part: string): { text: string; runs: Run[] } | undefined {
  if (!item) return undefined;
  if (!part) return item;
  if (part === "caption") return item.caption;
  const [, r, c] = part.split(":").map(Number);
  return item.table?.rows[r]?.[c];
}

/** The element holding an item's text (or caption, or a cell). */
function textTarget(node: Node | null): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node?.parentElement;
  return el?.closest<HTMLElement>("[data-text], [data-caption]") ?? null;
}
/** Characters of an element's text: its text nodes, and pictures standing for one character. */
function countChars(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length;
  if (node instanceof Element && node.hasAttribute("data-char")) return 1;
  let n = 0;
  for (const child of node.childNodes) n += countChars(child);
  return n;
}
/** The offset of a DOM point in an element's text. */
function offsetIn(el: HTMLElement, node: Node, offset: number) {
  if (!el.contains(node)) return countChars(el);
  const range = document.createRange();
  range.setStart(el, 0);
  try {
    range.setEnd(node, offset);
  } catch {
    return 0;
  }
  return countChars(range.cloneContents());
}
/** A DOM range for offsets into an element's text. */
function rangeIn(el: Element, start: number, end: number): Range | null {
  const range = document.createRange();
  let seen = 0;
  let started = false;
  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE || (node instanceof Element && node.hasAttribute("data-char"))) {
      const length = node.nodeType === Node.TEXT_NODE ? (node as Text).data.length : 1;
      const text = node.nodeType === Node.TEXT_NODE;
      if (!started && start < seen + length) {
        if (text) range.setStart(node, start - seen);
        else range.setStartBefore(node);
        started = true;
      }
      if (started && end <= seen + length) {
        if (text) range.setEnd(node, Math.max(0, end - seen));
        else if (end > seen) range.setEndAfter(node);
        else range.setEndBefore(node);
        return true;
      }
      seen += length;
      return false;
    }
    for (const child of node.childNodes) if (walk(child)) return true;
    return false;
  };
  const done = walk(el);
  if (!started) return null;
  if (!done) range.setEnd(el, el.childNodes.length);
  return range;
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

/** A web page's picture, from its own saved copy, loaded when it comes near the view. */
function Picture({ resource, alt, width, height, web, inline }: { resource?: number; alt: string; width?: number; height?: number; web: WebReadingBackend; inline?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || resource == null) return;
    let alive = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        void web
          .resource(resource)
          .then((url) => alive && setSrc(url))
          .catch(() => {});
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(el);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [resource, web]);
  if (inline)
    return src ? (
      <img ref={box as RefObject<HTMLImageElement>} className="kx-reading-inline-image" data-char="" src={src} alt={alt} draggable={false} />
    ) : (
      <span ref={box as RefObject<HTMLSpanElement>} className="kx-reading-inline-image" data-char="" role="img" aria-label={alt} />
    );
  if (resource == null)
    return (
      <div className="kx-reading-picture" data-missing>
        <span className="kx-reading-crop-wait">This picture was not saved with the page</span>
      </div>
    );
  const aspect = width && height ? `${width} / ${height}` : undefined;
  return (
    <div ref={box as RefObject<HTMLDivElement>} className="kx-reading-picture" data-ready={src ? true : undefined} style={src ? undefined : { aspectRatio: aspect ?? "16 / 9" }}>
      {src ? <img src={src} alt={alt} style={width ? { width } : undefined} draggable={false} /> : <span className="kx-reading-crop-wait">Figure</span>}
    </div>
  );
}

/** Text with its inline markup: emphasis, code, links, citations, maths and small pictures. */
function rich(text: string, spans: Span[] | undefined, web: WebReadingBackend | undefined, onTarget: (item: number) => void): ReactNode {
  if (!spans?.length || !web) return text;
  const cuts = new Set<number>([0, text.length]);
  for (const s of spans) {
    cuts.add(Math.max(0, Math.min(text.length, s.start)));
    cuts.add(Math.max(0, Math.min(text.length, s.end)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const atoms = spans.filter((s) => s.kind === "math" || s.kind === "image");
  const out: ReactNode[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const atom = atoms.find((s) => s.start <= a && a < s.end);
    if (atom) {
      if (atom.start === a) {
        out.push(
          atom.kind === "math" ? (
            <span key={`m${a}`} className="kx-reading-math-inline" dangerouslySetInnerHTML={{ __html: atom.math ?? "" }} />
          ) : (
            <Picture key={`i${a}`} inline resource={atom.resource} alt={atom.alt ?? ""} web={web} />
          ),
        );
      }
      continue;
    }
    let node: ReactNode = text.slice(a, b);
    const covering = spans.filter((s) => s.start <= a && b <= s.end && s.kind !== "math" && s.kind !== "image").sort((x, y) => y.start - x.start || x.end - y.end);
    for (const s of covering) {
      const key = `${s.kind}${a}`;
      if (s.kind === "em") node = <em key={key}>{node}</em>;
      else if (s.kind === "strong") node = <strong key={key}>{node}</strong>;
      else if (s.kind === "code") node = <code key={key}>{node}</code>;
      else if (s.kind === "sup") node = <sup key={key}>{node}</sup>;
      else if (s.kind === "sub") node = <sub key={key}>{node}</sub>;
      else if (s.kind === "link" || s.kind === "cite")
        node = (
          <a
            key={key}
            className={s.kind === "cite" ? "kx-reading-cite" : "kx-reading-link"}
            href={s.href ?? `#item-${s.target}`}
            title={s.href ?? (s.kind === "cite" ? "Go to the reference" : "Go there")}
            draggable={false}
            onClick={(event) => {
              event.preventDefault();
              if (document.getSelection()?.isCollapsed === false) return;
              if (s.target != null) onTarget(s.target);
              else if (s.href) web.openLink(s.href);
            }}
          >
            {node}
          </a>
        );
    }
    out.push(node);
  }
  return out;
}

const ReadingMode = forwardRef<ReadingModeHandle, Props>(function ReadingMode(
  { hash, reader, web, start, typography, invoke, analyse, onExit, onState, onNotice, onUnreadable, onCite, onAddToNote, selectionActions, selectionMode, marks: hostMarks, markActions, pickSelection },
  ref,
) {
  const [reply, setReply] = useState<ReadingReply>();
  const [error, setError] = useState("");
  const [showPoor, setShowPoor] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const startRef = useRef(start);
  const positioned = useRef(false);
  const isWeb = !!web;
  const original = isWeb ? "original view" : "page view";
  // The caller's functions may change identity on every render; reading them through refs keeps
  // the document from loading again each time.
  const call = useRef(invoke);
  call.current = invoke;
  const webRef = useRef(web);
  webRef.current = web;

  const load = useCallback(
    (first = false) =>
      (webRef.current
        ? webRef.current.load(first)
        : call.current<ReadingReply>("store_reflow_document", { hash, ...(first ? { page: startRef.current.page, fraction: startRef.current.fraction } : {}) })
      )
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
  // Highlights made or removed elsewhere (the original view, another window).
  useEffect(() => {
    const bridge = (window as unknown as { key: { on(e: string, f: (v: unknown) => void): () => void } }).key;
    return bridge.on("annotations-changed", () => void load());
  }, [load]);

  const doc = reply?.status === "ready" ? reply.document : undefined;
  const items = useMemo(() => doc?.items ?? [], [doc]);
  const marks = reply?.marks ?? [];
  const usable = !!doc && (doc.quality.level === "good" || (doc.quality.level === "poor" && showPoor));
  // A web page that does not read well: the reader says so and stays in the original view.
  const unreadable = useRef(onUnreadable);
  unreadable.current = onUnreadable;
  useEffect(() => {
    if (doc && doc.quality.level !== "good" && unreadable.current) unreadable.current(doc.quality.reason ?? "This page does not read well as text.");
  }, [doc]);

  // Open where the original view was.
  useLayoutEffect(() => {
    if (!usable || positioned.current) return;
    positioned.current = true;
    const at = reply?.at;
    if (at != null && at > 0) article.current?.querySelector(`[data-item="${at}"]`)?.scrollIntoView({ block: "start" });
  }, [usable, reply?.at]);

  // A PDF analysed without the layout model: the model finds its figures and tables in the
  // background (pages near this place first) and they come in as crops of the page. The text
  // in view stays where it is while they do.
  const [regions, setRegions] = useState<{ status: string; version: number; analysed?: number; pageCount?: number }>();
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const topPageRef = useRef(start.page);
  const blockKey = (el: HTMLElement) => `${el.dataset.kind}|${(el.textContent ?? "").slice(0, 80)}`;
  useEffect(() => {
    if (isWeb || !hash || reply?.status !== "ready") return;
    let alive = true;
    let timer = 0;
    let seen = -1;
    const poll = async () => {
      const r = await call.current<{ status: string; version: number; analysed?: number; pageCount?: number }>("store_reflow_regions", { hash, page: topPageRef.current }).catch(() => null);
      if (!alive || !r) return;
      setRegions(r);
      if (seen >= 0 && r.version !== seen) {
        // Keep the block at the top of the view where it is when the text changes under it.
        const view = scroller.current?.getBoundingClientRect();
        const top = view && [...(article.current?.querySelectorAll<HTMLElement>("[data-item]") ?? [])].find((el) => el.getBoundingClientRect().bottom > view.top + 12);
        if (view && top) anchor.current = { key: blockKey(top), offset: top.getBoundingClientRect().top - view.top };
        void load();
      }
      seen = r.version ?? 0;
      if (r.status === "running" || r.status === "held") timer = window.setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [reply?.status, hash, isWeb, load]);
  useLayoutEffect(() => {
    const keep = anchor.current;
    const view = scroller.current?.getBoundingClientRect();
    if (!keep || !view || !doc) return;
    anchor.current = null;
    const el = [...(article.current?.querySelectorAll<HTMLElement>("[data-item]") ?? [])].find((e) => blockKey(e) === keep.key);
    if (el) scroller.current!.scrollTop += el.getBoundingClientRect().top - view.top - keep.offset;
  }, [doc]);
  // Tables shown as the analyser's text instead of their crop, on request.
  const [asText, setAsText] = useState<Set<number>>(new Set());

  /** The element holding a part of an item's text. */
  const partElement = useCallback(
    (item: number, part = "") =>
      article.current?.querySelector<HTMLElement>(isWeb ? `[data-text="${item}"][data-part="${part}"]` : part === "caption" ? `[data-caption="${item}"]` : `[data-text="${item}"]`) ?? null,
    [isWeb],
  );
  const rangeOf = useCallback(
    (s: Stretch) => {
      const el = partElement(s.item, s.part ?? "") ?? (isWeb ? null : partElement(s.item, "caption"));
      return el ? rangeIn(el, s.start, s.end) : null;
    },
    [partElement, isWeb],
  );

  // Highlights on their words.
  useEffect(() => {
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!registry || !HighlightCtor || !usable) return;
    const byColor = new Map<string, Range[]>();
    for (const mark of marks) {
      const range = rangeOf(mark);
      if (!range) continue;
      const color = HIGHLIGHT_COLORS.includes(mark.color as HighlightColor) ? mark.color : "orange";
      byColor.set(color, [...(byColor.get(color) ?? []), range]);
    }
    for (const color of HIGHLIGHT_COLORS) registry.set(`kx-reading-${color}`, new HighlightCtor(...(byColor.get(color) ?? [])));
    return () => {
      for (const color of HIGHLIGHT_COLORS) registry.delete(`kx-reading-${color}`);
    };
  }, [marks, usable, rangeOf]);

  // Find in reading mode: every match in the text, the active one brought into view.
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const q = fold(query.trim());
    if (q.length < 2) return [] as Stretch[];
    const out: Stretch[] = [];
    for (const item of items) {
      for (const { part, text } of textParts(item, isWeb)) {
        const t = fold(text);
        for (let at = t.indexOf(q); at >= 0 && out.length < 5000; at = t.indexOf(q, at + q.length)) out.push({ item: item.id, part, start: at, end: at + q.length });
      }
    }
    return out;
  }, [items, query, isWeb]);
  useEffect(() => setActive(0), [matches]);
  const bringIntoView = useCallback((range: Range) => {
    const box = range.getBoundingClientRect();
    const view = scroller.current?.getBoundingClientRect();
    if (view && (box.top < view.top + 60 || box.bottom > view.bottom - 40)) scroller.current!.scrollBy({ top: box.top - view.top - view.height / 3 });
  }, []);
  useEffect(() => {
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!registry || !HighlightCtor) return;
    const all = matches.map(rangeOf).filter((r): r is Range => !!r);
    const current = matches[active] ? rangeOf(matches[active]) : null;
    registry.set("kx-reading-find", new HighlightCtor(...all));
    registry.set("kx-reading-find-active", new HighlightCtor(...(current ? [current] : [])));
    if (current) bringIntoView(current);
    return () => {
      registry.delete("kx-reading-find");
      registry.delete("kx-reading-find-active");
    };
  }, [matches, active, rangeOf, bringIntoView]);

  // A passage shown on request (a search hit, a highlight from the panel).
  const passageTimer = useRef(0);
  const showPassage = useCallback(
    (stretches: Stretch[], keep = false) => {
      const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
      const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
      const ranges = stretches.map(rangeOf).filter((r): r is Range => !!r);
      if (!ranges.length) return false;
      // The view may still be hidden (its tab coming to the front): scroll once it is laid out.
      const bring = (tries: number) => {
        const el = scroller.current;
        if (!el) return;
        if (!el.clientHeight && tries > 0) return void setTimeout(() => bring(tries - 1), 50);
        const box = ranges[0].getBoundingClientRect();
        const view = el.getBoundingClientRect();
        el.scrollBy({ top: box.top - view.top - view.height / 3 });
      };
      bring(60);
      if (registry && HighlightCtor) {
        registry.set("kx-reading-passage", new HighlightCtor(...ranges));
        clearTimeout(passageTimer.current);
        const clear = () => registry.delete("kx-reading-passage");
        if (keep) scroller.current?.addEventListener("pointerdown", clear, { once: true });
        else passageTimer.current = window.setTimeout(clear, 2600);
      }
      return true;
    },
    [rangeOf],
  );

  // The page at the top of the view, for the toolbar's page number.
  const [topPage, setTopPage] = useState(start.page);
  const place = useCallback((): { page: number; top: number; offset?: number } | null => {
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
      // The words at the top edge: their run's line on the page (a web page: their place in its text).
      const caret = (document as unknown as { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(box.left + 6, Math.max(box.top + 4, y));
      const offset = caret && text.contains(caret.startContainer) ? offsetIn(text, caret.startContainer, caret.startOffset) : 0;
      const runs = isWeb && !item.runs.length ? (partOf(item, "caption")?.runs ?? item.table?.rows.flat().find((c) => c.runs.length)?.runs ?? []) : item.runs;
      const run = runs.find((r) => offset >= r.start && offset < r.end) ?? runs[0];
      if (isWeb) {
        if (!run) continue;
        return { page: 0, top: 0, offset: (run.at ?? 0) + Math.max(0, Math.min(offset, run.end) - run.start) };
      }
      if (!run) return { page: item.page, top: 0 };
      const rect = run.rects[0];
      return { page: run.page, top: rect ? Math.max(0, rect[1] / 65535 - 0.02) : 0 };
    }
    return null;
  }, [doc, items, isWeb]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !usable) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!isWeb) {
          const p = place();
          if (p) {
            setTopPage(p.page);
            topPageRef.current = p.page;
          }
        }
        setSelection(null);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [usable, place, isWeb]);

  useEffect(() => {
    onState({ outline: doc?.outline ?? [], page: topPage, searchCount: matches.length, searchIndex: active, ready: usable });
  }, [doc, topPage, matches.length, active, usable, onState]);

  const scrollToItem = useCallback((item: number, flash = false) => {
    const el = article.current?.querySelector<HTMLElement>(`[data-item="${item}"]`);
    el?.scrollIntoView({ block: flash ? "center" : "start", behavior: "smooth" });
    if (flash && el) el.animate?.([{ backgroundColor: "var(--kx-reading-flash)" }, { backgroundColor: "transparent" }], { duration: 1600, easing: "ease-out" });
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      place,
      setQuery,
      step: (direction) => setActive((a) => (matches.length ? (a + direction + matches.length) % matches.length : 0)),
      scrollToItem,
      showPassage,
      showMark: (id) => {
        const range = markRanges.current.get(id);
        const el = range?.startContainer.parentElement;
        if (!range || !el) return false;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        if (article.current) {
          const flash = document.createElement("div");
          flash.className = "kx-reading-mark-flash";
          article.current.append(flash);
          const place = () => {
            const b = range.getBoundingClientRect();
            const h = article.current!.getBoundingClientRect();
            Object.assign(flash.style, { left: `${b.left - h.left - 3}px`, top: `${b.top - h.top - 2}px`, width: `${b.width + 6}px`, height: `${b.height + 4}px` });
          };
          place();
          setTimeout(place, 400);
          setTimeout(() => flash.remove(), 1800);
        }
        return true;
      },
    }),
    [place, matches.length, scrollToItem, showPassage],
  );

  // A selection in one block: highlight, cite, add to the note, or show it in the original.
  const [selection, setSelection] = useState<(ReadingSelection & { caption: boolean; rect: DOMRect }) | null>(null);
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
      const item = Number(el.dataset.text ?? el.dataset.caption);
      const part = el.dataset.part ?? (el.dataset.caption !== undefined ? "caption" : "");
      const full = partOf(items[item], isWeb ? part : el.dataset.caption !== undefined ? "caption" : "")?.text ?? el.textContent ?? "";
      const startOffset = offsetIn(el, range.startContainer, range.startOffset);
      const endOffset = el.contains(range.endContainer) ? offsetIn(el, range.endContainer, range.endOffset) : countChars(el);
      const text = full.slice(startOffset, endOffset).replace(/￼/g, "");
      if (!text.trim()) return setSelection(null);
      setSelection({ item, part, caption: el.dataset.caption !== undefined || items[item]?.kind === "figure", start: startOffset, end: endOffset, text: text.trim(), rect: range.getBoundingClientRect() });
    };
    const up = () => setTimeout(read);
    host.addEventListener("mouseup", up);
    host.addEventListener("keyup", up);
    return () => {
      host.removeEventListener("mouseup", up);
      host.removeEventListener("keyup", up);
    };
  }, [items, usable, isWeb]);
  useDismiss(!!selection, { refs: [toolbar], inside: (t) => t instanceof Element && !!t.closest(".ksm"), onDismiss: () => setSelection(null), kind: "passive", scroll: false });

  const located = async (chosen = selection) => {
    if (!chosen) return null;
    return call.current<Located>("store_reflow_locate", { hash, item: chosen.item, caption: chosen.caption, start: chosen.start, end: chosen.end });
  };
  const uncertain = (found: { page: number; quote: string }) => {
    onNotice(
      isWeb
        ? "Key could not place this passage exactly on the saved page, so the original view opens there. Highlight it on the page."
        : "Key could not place this passage exactly in the PDF, so the page view opens there. Highlight it on the page.",
    );
    onExit({ page: found.page, quote: found.quote });
  };
  const highlight = async (color: HighlightColor, comment?: string, chosen = selection) => {
    try {
      if (!chosen) return;
      let id: string | null | undefined;
      if (web) {
        id = await web.highlight(chosen, color, comment);
        if (!id) return uncertain({ page: 0, quote: chosen.text });
      } else {
        const found = await located(chosen);
        if (!found) return;
        if (!found.certain || !found.range) return uncertain(found);
        id = reader?.current?.addHighlightAt(found.range, found.text, color, comment);
        if (!id) return onNotice("The page view is not ready yet. Try again in a moment.");
      }
      const made = id;
      setReply((r) => r && { ...r, marks: [...(r.marks ?? []), { annotationId: made, item: chosen.item, part: chosen.part || undefined, start: chosen.start, end: chosen.end, color, ...(comment?.trim() ? { comment: comment.trim() } : {}) }] });
      document.getSelection()?.removeAllRanges();
      setSelection(null);
      setTimeout(() => void load(), 1200);
    } catch (e) {
      onNotice(`Could not highlight: ${String(e)}`);
    }
  };
  const cite = async () => {
    if (web && selection) {
      await web.cite(selection).catch((e) => onNotice(String(e)));
      return setSelection(null);
    }
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
  const showInOriginal = async () => {
    if (web && selection) return onExit({ page: 0, quote: selection.text });
    const found = await located().catch(() => null);
    if (found) onExit({ page: found.page, quote: found.quote });
  };
  /** The passage for the host: placed in the PDF when Key can (else its words, no boxes), a
   *  web page's as text. */
  const passageOf = async (chosen = selection): Promise<ReaderPassage | null> => {
    if (!chosen) return null;
    if (web) return { text: chosen.text, page: -1, rects: [] };
    const found = await located(chosen).catch(() => null);
    return { text: found?.certain ? found.text : chosen.text, page: found?.page ?? 0, rects: found?.certain ? (found.rects ?? []) : [] };
  };
  // A field's "pick": the next selection goes to the host with no menu.
  const pickRef = useRef(pickSelection);
  pickRef.current = pickSelection;
  useEffect(() => {
    const take = pickRef.current;
    if (!selection || !take) return;
    const chosen = selection;
    setSelection(null);
    document.getSelection()?.removeAllRanges();
    void passageOf(chosen).then((p) => p && take(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  // The host's marks in the text: found by their words, painted without touching the markup;
  // a click on one opens the host's menu for it.
  const markRanges = useRef(new Map<string, Range>());
  const [markMenu, setMarkMenu] = useState<{ mark: ReaderMark; rect: DOMRect; menu: ReaderMarkMenu } | null>(null);
  useEffect(() => {
    const host = article.current;
    if (!host) return;
    markRanges.current = paintTextMarks(host, hostMarks ?? []);
  }, [hostMarks, reply, usable, typography]);
  useEffect(() => () => void paintTextMarks(document.body, []), []);
  useEffect(() => {
    const host = article.current;
    if (!host || !markActions) return;
    const click = (event: MouseEvent) => {
      if (document.getSelection()?.isCollapsed === false) return;
      const hit = markAt(markRanges.current, event.clientX, event.clientY);
      const mark = hit && hostMarks?.find((m) => m.id === hit.id);
      const menu = mark && markActions(mark);
      if (!hit || !mark || !menu) return;
      event.stopPropagation();
      setMarkMenu({ mark, rect: hit.rect, menu });
    };
    host.addEventListener("click", click, true);
    return () => host.removeEventListener("click", click, true);
  }, [hostMarks, markActions, usable]);

  // Comments: a new one on the selection (a highlight with its comment), or a highlight's own,
  // opened by clicking its words or the comment mark beside them.
  const [draft, setDraft] = useState<{ chosen: NonNullable<typeof selection>; comment: string } | null>(null);
  const [card, setCard] = useState<{ id: string; rect: DOMRect } | null>(null);
  const cardMark = card ? marks.find((m) => m.annotationId === card.id) : undefined;
  const editAnnotation = async (id: string, patch: { color?: HighlightColor; comment?: string } | null) => {
    try {
      if (web) await (patch ? web.updateAnnotation(id, patch) : web.removeAnnotation(id));
      else if (!(patch ? reader?.current?.updateAnnotation(id, patch) : reader?.current?.removeAnnotation(id))) return onNotice("The page view is not ready yet. Try again in a moment.");
      setReply((r) =>
        r && {
          ...r,
          marks: patch
            ? (r.marks ?? []).map((m) => (m.annotationId === id ? { ...m, ...(patch.color ? { color: patch.color } : {}), ...(patch.comment !== undefined ? { comment: patch.comment.trim() || undefined } : {}) } : m))
            : (r.marks ?? []).filter((m) => m.annotationId !== id),
        },
      );
      setTimeout(() => void load(), 1200);
    } catch (e) {
      onNotice(`Could not change the highlight: ${String(e)}`);
    }
  };
  useEffect(() => {
    const host = article.current;
    if (!host) return;
    const click = (event: MouseEvent) => {
      if (document.getSelection()?.isCollapsed === false || (event.target as Element).closest?.("a, button")) return;
      const caret = (document as unknown as { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(event.clientX, event.clientY);
      const el = caret && textTarget(caret.startContainer);
      if (!caret || !el) return;
      const item = Number(el.dataset.text ?? el.dataset.caption);
      const part = el.dataset.part ?? (el.dataset.caption !== undefined ? "caption" : "");
      const offset = offsetIn(el, caret.startContainer, caret.startOffset);
      const hit = marks.find((m) => m.item === item && (m.part ?? "") === part && m.start <= offset && offset < m.end);
      if (hit) setCard({ id: hit.annotationId, rect: rangeIn(el, hit.start, hit.end)?.getBoundingClientRect() ?? el.getBoundingClientRect() });
    };
    host.addEventListener("click", click);
    return () => host.removeEventListener("click", click);
  }, [marks, usable]);

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
      Back to {original}
    </button>
  );

  const onTarget = useCallback((target: number) => scrollToItem(target, true), [scrollToItem]);

  let content: ReactNode;
  if (error)
    content = panel(
      "Reading mode is not available",
      /not in the library/i.test(error) ? `Reading mode works for ${isWeb ? "saved pages" : "PDFs"} in your library. Add this ${isWeb ? "page" : "PDF"} to the library and it can be read as text.` : error,
      back,
    );
  else if (!reply) content = panel("Preparing the text…", isWeb ? "Key is finding the article on this saved page." : "Key is putting this PDF’s text together.", null, true);
  else if (reply.status === "unsupported") content = panel(isWeb ? "Reading mode is for saved web pages" : "Reading mode is for PDFs", "This source has no text to show this way.", back);
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
      doc.quality.level === "empty" ? "There is no text to show" : isWeb ? "This page does not read well as text" : "This PDF does not read well as text",
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
    const meta = doc.meta;
    const dateline = isWeb && meta && [meta.site, meta.date].filter(Boolean).join(" · ");
    const hasByline = items.some((i) => i.kind === "byline");
    const textProps = (item: Item, part = "") => (isWeb ? { "data-text": item.id, "data-part": part } : { "data-text": item.id });
    content = (
      <article ref={article} className="kx-reading-article" aria-label="Reading mode text" data-source={isWeb ? "web" : "pdf"}>
        {items.map((item, index) => {
          const firstPage = item.runs[0]?.page ?? item.crop?.page ?? item.page;
          const turned = firstPage !== lastPage;
          lastPage = item.runs.at(-1)?.page ?? item.crop?.page ?? item.page;
          const marker = isWeb ? null : (
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
            <button
              type="button"
              className="kx-reading-comment"
              title={notes.map((n) => n.comment).join("\n\n")}
              aria-label={`${notes.length === 1 ? "Comment" : `${notes.length} comments`}: ${notes.map((n) => n.comment).join(" · ")}`}
              onClick={(event) => setCard({ id: notes[0].annotationId, rect: event.currentTarget.getBoundingClientRect() })}
            >
              <Icon name="comment" size={13} />
            </button>
          );
          const body = (text: string, spans?: Span[]) => rich(text, spans, web, onTarget);
          // Under a web page's title (and byline): its site and date.
          const after =
            isWeb && dateline && ((item.kind === "byline") || (!hasByline && index === 0 && item.kind === "heading")) ? (
              <p className="kx-reading-dateline" key={`d${item.id}`}>
                {!hasByline && meta?.byline ? <span>{meta.byline}</span> : null}
                {dateline}
              </p>
            ) : null;
          if (item.kind === "heading") {
            const level = Math.min(4, item.level ?? 2);
            const Tag = `h${level + 1}` as "h2";
            return [
              <div key={item.id} className="kx-reading-block" data-item={item.id} data-kind="heading">
                {marker}
                <Tag className="kx-reading-heading" data-level={level} {...textProps(item)}>
                  {body(item.text, item.spans)}
                </Tag>
              </div>,
              after,
            ];
          }
          if (item.kind === "byline")
            return [
              <div key={item.id} className="kx-reading-block" data-item={item.id} data-kind="byline">
                <p className="kx-reading-byline" {...textProps(item)}>
                  {body(item.text, item.spans)}
                </p>
              </div>,
              after,
            ];
          if (item.crop) {
            const caption = item.kind === "figure" ? item.text : item.caption?.text;
            return (
              <figure key={item.id} className="kx-reading-block kx-reading-figure" data-item={item.id} data-kind={item.kind}>
                {marker}
                {item.kind === "table" && asText.has(item.id) ? (
                  <p className="kx-reading-text kx-reading-table-text" data-kind="table" data-text={item.id}>
                    {item.text}
                  </p>
                ) : (
                  reader && <Crop key={item.crop.rect.join(",")} item={item} reader={reader} width={article.current?.querySelector(".kx-reading-text")?.clientWidth ?? 680} />
                )}
                {caption && <figcaption {...(item.kind === "figure" ? { "data-text": item.id } : { "data-caption": item.id })}>{caption}</figcaption>}
                {item.kind === "table" && item.text.trim() && (
                  <button
                    type="button"
                    className="kx-reading-as-text"
                    aria-pressed={asText.has(item.id)}
                    onClick={() =>
                      setAsText((s) => {
                        const next = new Set(s);
                        if (!next.delete(item.id)) next.add(item.id);
                        return next;
                      })
                    }
                  >
                    {asText.has(item.id) ? "Show as on the page" : "Show as text"}
                  </button>
                )}
                {comment}
              </figure>
            );
          }
          if (isWeb && web && (item.kind === "figure" || item.kind === "equation" || item.kind === "table")) {
            const caption = item.kind === "figure" ? (item.text ? { text: item.text, spans: item.spans, part: "" } : null) : item.caption ? { text: item.caption.text, spans: item.caption.spans, part: "caption" } : null;
            const captionNode = caption && (
              <figcaption data-text={item.id} data-part={caption.part}>
                {body(caption.text, caption.spans)}
              </figcaption>
            );
            return (
              <figure key={item.id} className="kx-reading-block kx-reading-figure" data-item={item.id} data-kind={item.kind}>
                {item.kind === "table" && captionNode}
                {item.kind === "figure" && (
                  <div className="kx-reading-pictures" data-count={item.images?.length ?? 0}>
                    {(item.images ?? []).map((image, k) => (
                      <Picture key={k} resource={image.resource} alt={image.alt} width={image.width} height={image.height} web={web} />
                    ))}
                  </div>
                )}
                {item.kind === "equation" && (
                  <div className="kx-reading-equation">
                    {item.math ? <div className="kx-reading-math" dangerouslySetInnerHTML={{ __html: item.math }} /> : (item.images ?? []).map((image, k) => <Picture key={k} resource={image.resource} alt={image.alt} web={web} />)}
                    {caption && (
                      <span className="kx-reading-equation-label" data-text={item.id} data-part="caption">
                        {caption.text}
                      </span>
                    )}
                  </div>
                )}
                {item.kind === "table" && item.table && (
                  <div className="kx-reading-table-wrap">
                    <table className="kx-reading-table">
                      <tbody>
                        {item.table.rows.map((row, r) => (
                          <tr key={r}>
                            {row.map((cell, c) => {
                              const Cell = cell.header ? "th" : "td";
                              return (
                                <Cell key={c} colSpan={cell.colspan} rowSpan={cell.rowspan} data-text={item.id} data-part={`cell:${r}:${c}`}>
                                  {body(cell.text, cell.spans)}
                                </Cell>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {item.kind === "figure" && captionNode}
                {comment}
              </figure>
            );
          }
          if (item.kind === "code")
            return (
              <div key={item.id} className="kx-reading-block" data-item={item.id} data-kind="code">
                <pre className="kx-reading-code" {...textProps(item)}>
                  {item.text}
                </pre>
                {comment}
              </div>
            );
          return (
            <div key={item.id} className="kx-reading-block" data-item={item.id} data-kind={item.kind} data-level={item.kind === "list" ? item.level : undefined}>
              {marker}
              {isWeb && item.marker && (
                <span className="kx-reading-marker" aria-hidden="true">
                  {item.marker}
                </span>
              )}
              <p className="kx-reading-text" data-kind={item.kind} {...textProps(item)}>
                {body(item.text, item.spans)}
              </p>
              {comment}
            </div>
          );
        })}
      </article>
    );
  }

  return (
    <div className="kx-reading" data-font={typography.font} data-source={isWeb ? "web" : "pdf"} style={style}>
      <div ref={scroller} className="kx-reading-scroll" data-reading-scroll>
        {content}
      </div>
      {usable && (regions?.status === "running" || regions?.status === "held") && (
        <div className="kx-reading-progress" role="status">
          {regions.status === "held" ? <Icon name="readingMode" size={12} /> : <Icon name="sync" size={12} className="kx-reading-spin" />}
          {regions.status === "held"
            ? "Figures and tables wait for power (on battery)"
            : `Finding figures and tables… ${regions.analysed ?? 0} of ${regions.pageCount ?? "?"} pages`}
        </div>
      )}
      <SelectionMenu
        open={!!selection && !pickSelection}
        anchor={selection?.rect ?? null}
        area={() => scroller.current?.getBoundingClientRect()}
        className="kx-reading-selection"
        label="Selection"
        passage={() => passageOf()}
        actions={selectionActions}
        mode={selectionActions ? selectionMode : undefined}
        colors={HIGHLIGHT_COLORS.map((color) => ({ id: color, label: `Highlight ${color}`, rgb: HIGHLIGHT_COLOR_RGB[color], run: () => void highlight(color) }))}
        tools={[
          ...(web && selection ? [{ id: "copy", label: "Copy", icon: "copy" as const, run: () => void web.copy(selection).then(() => setSelection(null)) }] : []),
          {
            id: "comment",
            label: "Add comment",
            title: "Highlight with a comment",
            icon: "comment" as const,
            run: () => {
              if (!selection) return;
              setDraft({ chosen: selection, comment: "" });
              setSelection(null);
            },
          },
          ...(onCite || web ? [{ id: "cite", label: "Cite", title: web ? "Copy as a quote with its source" : "Copy as a quote that links back here", icon: "quote" as const, run: () => void cite() }] : []),
          ...(onAddToNote ? [{ id: "to-note", label: "Add to note", title: "Add to this source’s note", icon: "note" as const, run: () => void addToNote() }] : []),
          { id: "original", label: web ? "Show in original view" : "Show in page view", title: web ? "Show this passage on the saved page" : "Show this passage in the page view", icon: (web ? "globe" : "filePdf") as "globe" | "filePdf", run: () => void showInOriginal() },
        ]}
        portal={portalRoot()}
        onDone={() => {
          document.getSelection()?.removeAllRanges();
          setSelection(null);
        }}
        onClose={() => {
          document.getSelection()?.removeAllRanges();
          setSelection(null);
        }}
      />
      <SelectionMenu
        open={!!markMenu}
        anchor={markMenu?.rect ?? null}
        area={() => scroller.current?.getBoundingClientRect()}
        title={markMenu?.menu.title}
        passage={() => (markMenu ? { text: markMenu.mark.text, page: markMenu.mark.page, rects: markMenu.mark.rects } : null)}
        actions={markMenu?.menu.actions}
        mode={markMenu?.menu.mode}
        portal={portalRoot()}
        onDone={() => setMarkMenu(null)}
        onClose={() => setMarkMenu(null)}
      />
      {draft && (
        <CommentPopover
          rect={draft.chosen.rect}
          quote={draft.chosen.text}
          comment={draft.comment}
          onChange={(comment) => setDraft({ ...draft, comment })}
          onCancel={() => setDraft(null)}
          onSave={() => {
            const { chosen, comment } = draft;
            setDraft(null);
            if (comment.trim()) void highlight("orange", comment, chosen);
          }}
        />
      )}
      {card && cardMark && (
        <CommentPopover
          key={card.id}
          rect={card.rect}
          comment={cardMark.comment ?? ""}
          color={cardMark.color}
          editing
          onColor={(color) => void editAnnotation(card.id, { color })}
          onCancel={() => setCard(null)}
          onSave={(comment) => {
            setCard(null);
            if ((comment ?? "") !== (cardMark.comment ?? "")) void editAnnotation(card.id, { comment: comment ?? "" });
          }}
          onDelete={() => {
            setCard(null);
            void editAnnotation(card.id, null);
          }}
        />
      )}
    </div>
  );
});

/** A comment on a new highlight (quote and text), or a highlight's colour, comment and delete. */
function CommentPopover({
  rect,
  quote,
  comment,
  color,
  editing,
  onChange,
  onColor,
  onCancel,
  onSave,
  onDelete,
}: {
  rect: DOMRect;
  quote?: string;
  comment: string;
  color?: string;
  editing?: boolean;
  onChange?(comment: string): void;
  onColor?(color: HighlightColor): void;
  onCancel(): void;
  onSave(comment?: string): void;
  onDelete?(): void;
}) {
  const box = useRef<HTMLFormElement>(null);
  const [text, setText] = useState(comment);
  const value = onChange ? comment : text;
  useDismiss(true, { refs: [box], onDismiss: onCancel, scroll: false });
  const width = 320;
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, innerWidth - width - 8));
  const below = rect.bottom + 10;
  const top = below + 220 < innerHeight ? below : Math.max(8, rect.top - 230);
  return createPortal(
    <form
      ref={box}
      className="kx-reading-popover kx-reading-comment-card"
      role="dialog"
      aria-label={editing ? "Highlight" : "Add comment"}
      style={{ left, top, width }}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(value);
      }}
    >
      {editing && (
        <div className="kx-reading-comment-colors" role="group" aria-label="Colour">
          {HIGHLIGHT_COLORS.map((c) => (
            <button key={c} type="button" className="kx-reading-swatch" data-color={c} aria-pressed={c === color} aria-label={`Make it ${c}`} title={c} onClick={() => onColor?.(c)} />
          ))}
        </div>
      )}
      {quote && <blockquote>{quote}</blockquote>}
      <textarea
        autoFocus
        aria-label="Comment"
        placeholder={editing ? "Add a comment…" : "Your comment…"}
        value={value}
        onChange={(event) => (onChange ? onChange(event.target.value) : setText(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSave(value);
          }
          if (event.key === "Escape") onCancel();
        }}
      />
      <footer>
        {onDelete && (
          <button type="button" className="kx-reading-button" data-danger onClick={onDelete}>
            Delete highlight
          </button>
        )}
        <span className="kx-reading-spacer" />
        <button type="button" className="kx-reading-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="kx-reading-button" data-primary disabled={!editing && !value.trim()}>
          Save
        </button>
      </footer>
    </form>,
    portalRoot(),
  );
}

export default ReadingMode;
