// A saved web page, read offline and annotated like a PDF. The page is shown in a sandboxed
// frame that runs no scripts (none are kept, and the frame may not run any) and makes no
// requests (its Content-Security-Policy allows only inlined data). The reader reaches into
// the frame's document to select, highlight and scroll; highlights are the library's
// annotations, anchored by text quote and position (web-anchors.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { bridge, type Invoke, type Source } from "./library-api";
import { openItemAt, toast } from "./item-actions";
import { describeRange, locate, offsetOf, rangeFor, textIndex, unwrap, wrapRange, type WebAnchor } from "./web-anchors";
import { takeWebFocus, webPanelStatusItems, WEB_FOCUS_EVENT, type WebFocus } from "./web-page-open";
import ReadingMode, { ContentsPopover, TypographyPopover, useTypography, type ReadingModeHandle, type ReadingModeState, type ReadingReply, type ReadingSelection, type Stretch, type WebReadingBackend } from "./ReadingMode";
import { opensInReadingMode, rememberReadingMode } from "./reading-preference";
import { writeQuoteClipboard } from "./quote-clipboard";
import { quoteAttribution } from "./cite";
import { AnnotationText } from "./annotation-text";
import { drawHighlightMarkers, inFrameView } from "./web-highlight-markers";
import { highlightUsage } from "./highlight-usage";
import { openNoteAt } from "./note-reveal";
import { HighlightInfo } from "@key-reader/pdfjs/HighlightInfo";
import { useStatusItems } from "./status-bar";
import { useWebReferences } from "./web-reader-references";
import "./web-page.css";
import { FirstUseTip } from "./explain";
import { couldNot } from "../shared/plain-error";

export const HIGHLIGHT_COLORS = ["orange", "green", "blue", "pink", "purple"] as const;
type Color = (typeof HIGHLIGHT_COLORS)[number];
/** Highlight colours on the page: document content, the same in both themes (as the PDF reader's). */
export const PAGE_RGB: Record<Color, string> = { orange: "255 185 60", green: "94 210 129", blue: "80 158 255", pink: "244 104 172", purple: "164 110 244" };

export interface WebAnnotation {
  id: string;
  documentId: string;
  text: string;
  color: Color;
  comment?: string;
  anchor: WebAnchor;
  createdAt: string;
  updatedAt: string;
}

const SNAPSHOT_CSP = "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline' data:; form-action 'none'";
const MARK = "key-hl";

/** The saved HTML made safe to show again, whatever it holds: no scripts, frames, plugins,
 * handlers, refreshes or base URL, and the no-network policy first in its head. */
export function sanitizeSnapshot(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, noscript, iframe, frame, frameset, object, embed, applet, portal, base, meta[http-equiv], link").forEach((el) => el.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith("on") || (/^(href|src|action|formaction|xlink:href)$/.test(n) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
  });
  const snapshot = doc.querySelector('meta[name="key-snapshot"]');
  let info: { url?: string; capturedAt?: string } = {};
  try {
    info = JSON.parse(snapshot?.getAttribute("content") ?? "{}");
  } catch {
    /* an older or foreign file */
  }
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = SNAPSHOT_CSP;
  doc.head.prepend(csp);
  return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, info };
}

const pageStyle = () =>
  `mark.${MARK}{color:inherit;background:rgb(var(--key-hl) / .36);border-radius:2px;padding:0;margin:0;cursor:pointer;box-decoration-break:clone;-webkit-box-decoration-break:clone;transition:background .12s}` +
  Object.entries(PAGE_RGB).map(([c, rgb]) => `mark.${MARK}[data-color="${c}"]{--key-hl:${rgb}}`).join("") +
  `mark.${MARK}[data-comment]{box-shadow:inset 0 -2px rgb(var(--key-hl) / .95)}` +
  `mark.${MARK}[data-active]{background:rgb(var(--key-hl) / .6)}` +
  `mark.${MARK}.key-flash{animation:key-flash 1.6s ease-out}` +
  `mark.key-passage{color:inherit;background:rgb(255 185 60 / .45);border-radius:2px;animation:key-flash 2.4s ease-out forwards}` +
  `mark.key-passage-kept{animation:key-flash 2.4s ease-out}` +
  `@keyframes key-flash{0%,30%{background:rgb(var(--key-hl, 255 185 60) / .85)}}` +
  `::highlight(key-find){background-color:rgb(255 185 60 / .38)}::highlight(key-find-active){background-color:rgb(255 150 30 / .8)}` +
  `::selection{background:rgb(80 158 255 / .35)}`;

type Context =
  | { kind: "selection"; rect: DOMRect; anchor: WebAnchor; text: string }
  | { kind: "annotation"; rect: DOMRect; id: string };
type Draft = { id?: string; anchor?: WebAnchor; text: string; comment: string; color: Color; rect: DOMRect };

const formatDate = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const host = (url?: string) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

type PanelTab = "details" | "highlights" | "references";

/** The reader's text, checked against the host's (FNV-1a over UTF-16 units, web_reflow.rs). */
const fingerprint = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return { length: text.length, hash: h };
};

/** The page's text offset at the top of the frame's view. */
function topOffset(d: Document) {
  const w = d.defaultView;
  if (!w || w.scrollY < 4) return 0;
  const index = textIndex(d.body);
  const caret = (x: number, y: number) => (d as unknown as { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(x, y);
  for (const y of [12, 48, 96, 160, 240])
    for (const x of [w.innerWidth / 2, w.innerWidth / 3, (w.innerWidth * 2) / 3, 48]) {
      const range = caret(x, y);
      if (range?.startContainer.nodeType === 3) {
        const at = offsetOf(index, range.startContainer, range.startOffset);
        if (at >= 0) return at;
      }
    }
  return 0;
}

/** The frame shows nothing readable (a page hidden until its scripts ran, which a saved copy
 *  never runs). */
function looksBlank(d: Document) {
  const view = d.defaultView;
  if (!view || !d.body) return true;
  const hidden = (el: Element) => {
    const s = view.getComputedStyle(el);
    return s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05;
  };
  return hidden(d.documentElement) || hidden(d.body) || d.body.innerText.trim().length < 40;
}

export function WebPageReader({
  invoke,
  workspaceId,
  sourceId,
  viewId,
  panelTab,
}: {
  invoke: Invoke;
  workspaceId: string;
  sourceId: string;
  viewId?: string;
  /** What the panel docked beside the reader in its tab shows (see WebReaderPanel). */
  panelTab?: PanelTab;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const [page, setPage] = useState<{ html: string; info: { url?: string; capturedAt?: string } } | null>(null);
  const [error, setError] = useState("");
  const [annotations, setAnnotations] = useState<WebAnnotation[]>([]);
  const [context, setContext] = useState<Context | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [order, setOrder] = useState<Map<string, number>>(new Map());
  const frame = useRef<HTMLIFrameElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const latest = useRef(annotations);
  latest.current = annotations;

  // Reading mode (ReadingMode.tsx): the article as reflowed text over the saved page, which
  // stays loaded underneath (its text index is what highlights are anchored to).
  const readingRef = useRef<ReadingModeHandle>(null);
  const [reading, setReading] = useState<{ offset: number } | null>(null);
  const [readingState, setReadingState] = useState<ReadingModeState>();
  const [typography, setTypography] = useTypography();
  const [popover, setPopover] = useState<{ kind: "type" | "contents"; anchor: HTMLElement }>();
  const [notice, setNotice] = useState("");
  const [preference, setPreference] = useState<boolean>();
  const [pendingFocus, setPendingFocus] = useState<WebFocus>();
  const readingOn = useRef(false);
  readingOn.current = !!reading;
  const docRef = useRef<Document | null>(null);
  const hostText = useRef<{ length: number; hash: number } | undefined>(undefined);
  const pictures = useRef(new Map<number, Promise<string>>());
  useEffect(() => {
    pictures.current = new Map();
    void opensInReadingMode("web").then((on) => {
      setPreference(on);
      if (on) setReading((r) => r ?? { offset: 0 });
    });
  }, [sourceId]);
  const say = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((m) => (m === message ? "" : m)), 6500);
  }, []);

  useEffect(() => {
    let live = true;
    setError("");
    void Promise.all([
      invoke<Source | null>("store_source", { id: sourceId }, workspaceId),
      invoke<{ html: string }>("saved_page_html", { id: sourceId }, workspaceId),
    ])
      .then(([s, file]) => {
        if (!live) return;
        setSource(s);
        setPage(sanitizeSnapshot(file.html));
      })
      .catch((e) => live && setError(String(e).replace(/^Error: /, "")));
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, sourceId]);
  const loadAnnotations = useCallback(
    () =>
      invoke<WebAnnotation[]>("library_annotations", { hash: sourceId }, workspaceId)
        .then((list) => setAnnotations(list.filter((a) => a?.anchor?.kind === "web")))
        .catch(() => undefined),
    [invoke, workspaceId, sourceId],
  );
  useEffect(() => {
    void loadAnnotations();
    return bridge().on("annotations-changed", () => void loadAnnotations());
  }, [loadAnnotations]);
  useEffect(() => {
    if (source && viewId) void bridge().tabAction("content-title", { viewId, title: source.title || "Web page" });
  }, [source?.title, viewId]);

  const save = useCallback(
    async (upserts: WebAnnotation[], deleted: string[] = []) => {
      setAnnotations((list) => [...list.filter((a) => !deleted.includes(a.id) && !upserts.some((u) => u.id === a.id)), ...upserts]);
      try {
        await invoke("library_apply_annotations", { hash: sourceId, upserts, deleted }, workspaceId);
      } catch (e) {
        toast(`${couldNot("save the highlight", e)} It is shown again as it was saved.`);
        void loadAnnotations();
      }
    },
    [invoke, workspaceId, sourceId, loadAnnotations],
  );

  /** A rectangle in the frame, in the reader body's coordinates. */
  const toBody = useCallback((rect: DOMRect) => {
    const f = frame.current!.getBoundingClientRect();
    const b = body.current!.getBoundingClientRect();
    return new DOMRect(rect.left + f.left - b.left, rect.top + f.top - b.top, rect.width, rect.height);
  }, []);
  const marksOf = (d: Document, id: string) => [...d.querySelectorAll<HTMLElement>(`mark.${MARK}[data-annotation="${CSS.escape(id)}"]`)];

  // Highlights drawn into the page: all marks taken out and put back after every change.
  useEffect(() => {
    if (!doc) return;
    unwrap(doc.querySelectorAll(`mark.${MARK}`));
    const index = textIndex(doc.body);
    const placed = new Map<string, number>();
    const located = annotations
      .map((a) => ({ a, at: locate(index, a.anchor, a.text) }))
      .filter((x): x is { a: WebAnnotation; at: { start: number; end: number } } => !!x.at)
      .sort((x, y) => y.at.start - x.at.start);
    // From the end backwards, so earlier offsets stay valid as text nodes split.
    for (const { a, at } of located) {
      placed.set(a.id, at.start);
      wrapRange(textIndex(doc.body), at.start, at.end, () => {
        const mark = doc.createElement("mark");
        mark.className = MARK;
        mark.dataset.annotation = a.id;
        mark.dataset.color = a.color;
        if (a.comment) mark.dataset.comment = "";
        return mark;
      });
    }
    setOrder(placed);
    return drawHighlightMarkers(doc, MARK, PAGE_RGB, (id, rect) => {
      setDraft(null);
      setContext({ kind: "annotation", id, rect: toBody(rect) });
    });
  }, [doc, annotations, toBody]);
  useEffect(() => {
    if (!doc) return;
    doc.querySelectorAll(`mark.${MARK}[data-active]`).forEach((m) => m.removeAttribute("data-active"));
    if (context?.kind === "annotation") marksOf(doc, context.id).forEach((m) => m.setAttribute("data-active", ""));
  }, [doc, context, annotations]);

  const flash = useCallback((d: Document, id: string) => {
    const marks = marksOf(d, id);
    if (!marks.length) return false;
    marks[0].scrollIntoView({ block: "center", behavior: "smooth" });
    for (const m of marks) {
      m.classList.remove("key-flash");
      void m.offsetWidth;
      m.classList.add("key-flash");
    }
    return true;
  }, []);
  /** Goes to a highlight, or to a quoted passage and lights it up for a moment (a search
   *  hit's stays lit until the page is clicked). */
  const lit = useRef<Element[]>([]);
  const goTo = useCallback(
    (d: Document, focus: { annotationId?: string; text?: string; fallback?: string[]; keep?: boolean }) => {
      setContext(null);
      setDraft(null);
      unwrap(lit.current);
      lit.current = [];
      if (focus.annotationId && flash(d, focus.annotationId)) return;
      const index = textIndex(d.body);
      let at: { start: number; end: number } | undefined;
      for (const text of [focus.text, ...(focus.fallback ?? [])]) {
        if (text && (at = locate(index, undefined, text))) break;
      }
      if (!at) return focus.text || focus.fallback?.length ? toast("That passage is not on the saved page") : undefined;
      const marks = wrapRange(index, at.start, at.end, () => {
        const m = d.createElement("mark");
        m.className = focus.keep ? "key-passage key-passage-kept" : "key-passage";
        return m;
      });
      marks[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
      if (!focus.keep) return void setTimeout(() => unwrap(marks), 2600);
      lit.current = marks;
      d.addEventListener(
        "pointerdown",
        () => {
          if (lit.current !== marks) return;
          unwrap(marks);
          lit.current = [];
        },
        { once: true },
      );
    },
    [flash],
  );
  useEffect(() => {
    // Which view opens decides where the passage shows: wait for it.
    if (!doc || preference === undefined) return;
    const take = () => {
      const focus = takeWebFocus(sourceId);
      if (!focus) return;
      if (readingOn.current) setPendingFocus(focus);
      // After the highlights are drawn.
      else setTimeout(() => goTo(doc, focus), 60);
    };
    take();
    const listener = (event: Event) => (event as CustomEvent).detail === sourceId && take();
    window.addEventListener(WEB_FOCUS_EVENT, listener);
    return () => window.removeEventListener(WEB_FOCUS_EVENT, listener);
  }, [doc, sourceId, goTo, preference]);

  // The frame's document: selection, clicks on highlights and links, scrolling.
  const onLoad = () => {
    const d = frame.current?.contentDocument;
    if (!d?.body) return;
    const style = d.createElement("style");
    style.textContent = pageStyle();
    d.head.append(style);
    const selected = () => {
      const selection = d.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
      const range = selection.getRangeAt(0);
      const anchor = describeRange(textIndex(d.body), range);
      if (!anchor) return false;
      const rect = range.getBoundingClientRect();
      const text = (anchor.selectors[0] as { exact: string }).exact;
      setDraft(null);
      setContext({ kind: "selection", rect: toBody(rect), anchor, text });
      return true;
    };
    d.addEventListener("mouseup", () => setTimeout(() => selected(), 0));
    d.addEventListener("keyup", (e) => e.shiftKey && selected());
    d.addEventListener("keydown", (e) => {
      // The reader.s shortcuts work with the focus in the page.
      if (e.metaKey && !e.altKey && ((e.shiftKey && e.key.toLowerCase() === "r") || (!e.shiftKey && e.key.toLowerCase() === "f"))) {
        e.preventDefault();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, metaKey: true, shiftKey: e.shiftKey }));
        return;
      }
      if (e.key === "Escape") {
        d.getSelection()?.removeAllRanges();
        setContext(null);
        setDraft(null);
      }
    });
    d.addEventListener(
      "click",
      (e) => {
        const target = e.target as Element;
        const link = target.closest?.("a[href]") as HTMLAnchorElement | null;
        const mark = target.closest?.(`mark.${MARK}`) as HTMLElement | null;
        if (d.getSelection()?.isCollapsed === false) {
          if (link) e.preventDefault();
          return;
        }
        if (mark) {
          e.preventDefault();
          setDraft(null);
          setContext({ kind: "annotation", id: mark.dataset.annotation!, rect: toBody(mark.getBoundingClientRect()) });
          return;
        }
        if (link) {
          e.preventDefault();
          const href = link.getAttribute("href") ?? "";
          const here = (u: string) => u.split("#")[0];
          const hash = href.split("#")[1];
          // A link within the page scrolls there; any other opens live in a browser tab.
          if (hash && (href.startsWith("#") || here(href) === here(page?.info.url ?? source?.url ?? ""))) d.getElementById(decodeURIComponent(hash))?.scrollIntoView({ behavior: "smooth" });
          else if (/^https?:/i.test(href)) window.open(href, "_blank");
          return;
        }
        setContext(null);
      },
      true,
    );
    d.addEventListener("submit", (e) => e.preventDefault(), true);
    let following = 0;
    d.addEventListener(
      "scroll",
      () => {
        if (following) return;
        following = requestAnimationFrame(() => {
          following = 0;
          follow.current(d);
        });
      },
      { passive: true },
    );
    docRef.current = d;
    setDoc(d);
    // The page shows nothing as saved: its article in reading mode instead.
    if (looksBlank(d)) setReading((r) => r ?? { offset: 0 });
  };

  const byId = useMemo(() => new Map(annotations.map((a) => [a.id, a])), [annotations]);
  // The toolbar or card follows its passage while it scrolls and closes once it is out of view.
  const follow = useRef((_: Document) => {});
  follow.current = (d: Document) => {
    if (!context) return;
    const range = context.kind === "selection" ? (d.getSelection()?.rangeCount ? d.getSelection()!.getRangeAt(0) : null) : null;
    const rect = context.kind === "selection" ? range?.getBoundingClientRect() : marksOf(d, context.id)[0]?.getBoundingClientRect();
    if (!rect || !inFrameView(d, rect)) return setContext(null);
    setContext({ ...context, rect: toBody(rect) });
  };
  const usage = useMemo(() => {
    const a = context?.kind === "annotation" ? annotations.find((x) => x.id === context.id) : undefined;
    if (!a) return undefined;
    return () =>
      highlightUsage(invoke, workspaceId, sourceId, a).then((uses) =>
        uses.map((use) => ({
          ...use,
          open: () => (use.kind === "note" ? void openNoteAt(workspaceId, use.id, a.text, use.title) : openItemAt({ kind: use.kind as "canvas", id: use.id }, "tab", use.title, workspaceId, invoke)),
        })),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context?.kind === "annotation" ? context.id : "", invoke, workspaceId, sourceId]);
  const active = context?.kind === "annotation" ? byId.get(context.id) : undefined;
  const contextText = context?.kind === "selection" ? context.text : (active?.text ?? "");
  const clearSelection = () => doc?.getSelection()?.removeAllRanges();

  const highlight = (color: Color, comment?: string) => {
    const now = new Date().toISOString();
    if (context?.kind === "selection") {
      const created: WebAnnotation = { id: crypto.randomUUID(), documentId: sourceId, text: context.text, color, anchor: context.anchor, createdAt: now, updatedAt: now, ...(comment ? { comment } : {}) };
      void save([created]);
      clearSelection();
      setContext(null);
      return created;
    }
    if (active) {
      void save([{ ...active, color, updatedAt: now }]);
      setContext({ ...context!, kind: "annotation", id: active.id } as Context);
    }
    return active;
  };
  const copy = async () => {
    await navigator.clipboard.writeText(contextText.trim());
    toast("Copied");
  };
  const cite = async (text = contextText, color: Color | undefined = active?.color) => {
    if (!source || !text.trim()) return;
    const authors = (source.creators ?? []).map((c) => c.family || c.literal || c.given || "").filter(Boolean);
    const attribution = sourceId ? await quoteAttribution(invoke, workspaceId, sourceId).then((a) => a.text).catch(() => undefined) : undefined;
    await writeQuoteClipboard({
      v: 1,
      attribution,
      text,
      workspaceId,
      sourceId,
      documentHash: source.fileHash ?? sourceId,
      page: -1,
      rects: [],
      color,
      citation: { authors: authors.length ? authors : [source.containerTitle || host(source.url)].filter(Boolean), year: source.year ?? undefined, title: source.title },
    });
    toast("Quote copied: paste it into a note");
  };
  const openComment = () => {
    if (!context) return;
    const rect = context.rect;
    if (context.kind === "selection") setDraft({ anchor: context.anchor, text: context.text, comment: "", color: "orange", rect });
    else if (active) setDraft({ id: active.id, text: active.text, comment: active.comment ?? "", color: active.color, rect });
    setContext(null);
  };
  const saveDraft = () => {
    if (!draft) return;
    const now = new Date().toISOString();
    const comment = draft.comment.trim();
    if (draft.id) {
      const a = byId.get(draft.id);
      if (a) void save([{ ...a, comment: comment || undefined, updatedAt: now }]);
    } else if (draft.anchor) {
      void save([{ id: crypto.randomUUID(), documentId: sourceId, text: draft.text, color: draft.color, anchor: draft.anchor, createdAt: now, updatedAt: now, ...(comment ? { comment } : {}) }]);
      clearSelection();
    }
    setDraft(null);
  };
  const remove = (id: string) => {
    void save([], [id]);
    setContext(null);
  };
  const url = page?.info.url || source?.url || "";
  const captured = (source?.properties?.webSnapshot as { capturedAt?: string } | undefined)?.capturedAt ?? page?.info.capturedAt;
  const place = (rect: DOMRect, width: number, height: number) => {
    const b = body.current?.getBoundingClientRect();
    const maxX = (b?.width ?? 800) - width - 12;
    const left = Math.max(12, Math.min(maxX, rect.left + rect.width / 2 - width / 2));
    const below = rect.bottom + 10;
    const top = below + height < (b?.height ?? 600) ? below : Math.max(8, rect.top - height - 10);
    return { left, top };
  };

  // The panel beside the page in its tab: details, highlights, references (as a PDF's).
  const showPanel = (tab: PanelTab) => {
    if (viewId) void bridge().tabAction("web-panel", { viewId, tab });
  };
  useStatusItems(viewId, webPanelStatusItems(panelTab), (id) => showPanel(id as PanelTab));
  const citationCard = useWebReferences({
    doc,
    frame,
    source,
    invoke,
    workspaceId,
    sourceId,
    onFlash: (el) => void (el as HTMLElement).animate?.([{ backgroundColor: "rgb(255 185 60 / 0.45)" }, { backgroundColor: "transparent" }], { duration: 1800, easing: "ease-out" }),
  });

  // Reading mode's side of the page: the document (opened where the page was), its pictures
  // from the page's own copies, and a selection made a highlight at its place on the page.
  const startOffset = reading?.offset ?? 0;
  const startRef = useRef(startOffset);
  startRef.current = startOffset;
  const saveRef = useRef(save);
  saveRef.current = save;
  const citeRef = useRef(cite);
  citeRef.current = cite;
  const backend = useMemo<WebReadingBackend>(
    () => ({
      load: (first) =>
        invoke<ReadingReply>("store_web_reflow_document", { id: sourceId, ...(first ? { offset: startRef.current } : {}) }, workspaceId).then((reply) => {
          hostText.current = reply.text;
          return reply;
        }),
      resource: (n) => {
        let found = pictures.current.get(n);
        if (!found) {
          found = invoke<{ src: string }>("store_web_reflow_resource", { id: sourceId, resource: n }, workspaceId).then((r) => r.src);
          pictures.current.set(n, found);
        }
        return found;
      },
      highlight: async (selection: ReadingSelection, color) => {
        const d = docRef.current;
        if (!d?.body) return null;
        const index = textIndex(d.body);
        // The host's text must be the reader's, or no place it gives is certain.
        const mine = fingerprint(index.text);
        if (!hostText.current || hostText.current.length !== mine.length || hostText.current.hash !== mine.hash) return null;
        const found = await invoke<{ certain: boolean; start?: number; end?: number; exact?: string; prefix?: string; suffix?: string }>(
          "store_web_reflow_locate",
          { id: sourceId, item: selection.item, part: selection.part, start: selection.start, end: selection.end },
          workspaceId,
        );
        if (!found.certain || found.start == null || found.end == null || !found.exact || index.text.slice(found.start, found.end) !== found.exact) return null;
        const now = new Date().toISOString();
        const anchor: WebAnchor = {
          version: 1,
          kind: "web",
          selectors: [
            { type: "TextQuoteSelector", exact: found.exact, prefix: found.prefix ?? "", suffix: found.suffix ?? "" },
            { type: "TextPositionSelector", start: found.start, end: found.end },
          ],
        };
        const created: WebAnnotation = { id: crypto.randomUUID(), documentId: sourceId, text: found.exact, color: color as Color, anchor, createdAt: now, updatedAt: now };
        await saveRef.current([created]);
        return created.id;
      },
      cite: (selection) => citeRef.current(selection.text, undefined),
      copy: async (selection) => {
        await navigator.clipboard.writeText(selection.text);
        toast("Copied");
      },
      // As a link in the saved page: Key's browser, in a tab.
      openLink: (href) => void window.open(href, "_blank"),
    }),
    [invoke, workspaceId, sourceId],
  );

  /** Scrolls the saved page so that text offset `offset` is at the top. */
  const scrollPageTo = useCallback((offset: number) => {
    const d = docRef.current;
    const w = d?.defaultView;
    if (!d?.body || !w) return;
    const range = rangeFor(textIndex(d.body), offset, offset + 1);
    const rect = range?.getBoundingClientRect();
    if (rect) w.scrollTo({ top: Math.max(0, rect.top + w.scrollY - 56), behavior: "instant" as ScrollBehavior });
  }, []);
  const enterReading = useCallback(() => {
    setContext(null);
    setDraft(null);
    setPopover(undefined);
    setReading({ offset: docRef.current ? topOffset(docRef.current) : 0 });
  }, []);
  const exitReading = useCallback(
    (place?: { page: number; top?: number; quote?: string; offset?: number } | null) => {
      const at: { quote?: string; offset?: number } | null = place ?? readingRef.current?.place() ?? null;
      setReading(null);
      setReadingState(undefined);
      setPopover(undefined);
      readingRef.current?.setQuery("");
      if (!at) return;
      requestAnimationFrame(() => {
        const d = docRef.current;
        if (at.quote && d) goTo(d, { text: at.quote });
        else if (at.offset != null) scrollPageTo(at.offset);
      });
    },
    [goTo, scrollPageTo],
  );
  // The user switching views: remembered for saved pages (Key Settings › General › Reading).
  const toggleReading = useCallback(() => {
    void rememberReadingMode("web", !reading);
    if (reading) exitReading();
    else enterReading();
  }, [reading, enterReading, exitReading]);

  // A passage asked for while reading (a search hit, a highlight in the panel): shown in the
  // text once it is there; text reading mode leaves out is shown on the saved page instead.
  useEffect(() => {
    const d = docRef.current;
    if (!pendingFocus || !reading || !readingState?.ready || !d?.body) return;
    const focus = pendingFocus;
    setPendingFocus(undefined);
    const index = textIndex(d.body);
    let at: { start: number; end: number } | undefined;
    const annotation = focus.annotationId ? latest.current.find((a) => a.id === focus.annotationId) : undefined;
    if (annotation) at = locate(index, annotation.anchor, annotation.text);
    for (const text of [focus.text, ...(focus.fallback ?? [])]) {
      if (at) break;
      if (text) at = locate(index, undefined, text);
    }
    if (!at) return void toast("That passage is not on the saved page");
    const range = at;
    void invoke<Stretch[][]>("store_web_reflow_project", { id: sourceId, ranges: [range] }, workspaceId)
      .then(([stretches]) => {
        if (stretches?.length && readingRef.current?.showPassage(stretches, focus.keep)) return;
        exitReading(null);
        setTimeout(() => goTo(d, focus), 120);
      })
      .catch(() => goTo(d, focus));
  }, [pendingFocus, reading, readingState?.ready, invoke, sourceId, workspaceId, exitReading, goTo]);

  // Find, in either view: in reading mode its text; on the saved page the frame's own.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [pageFind, setPageFind] = useState({ count: 0, index: 0 });
  const pageMatches = useRef<Range[]>([]);
  const findInput = useRef<HTMLInputElement>(null);
  const showPageMatch = useCallback((index: number) => {
    const d = docRef.current;
    const registry = (d?.defaultView as unknown as { CSS?: { highlights?: Map<string, unknown> } } | null)?.CSS?.highlights;
    const HighlightCtor = (d?.defaultView as unknown as { Highlight?: new (...ranges: Range[]) => unknown } | null)?.Highlight;
    const ranges = pageMatches.current;
    if (!registry || !HighlightCtor) return;
    registry.set("key-find", new HighlightCtor(...ranges));
    registry.set("key-find-active", new HighlightCtor(...(ranges[index] ? [ranges[index]] : [])));
    const rect = ranges[index]?.getBoundingClientRect();
    const w = d?.defaultView;
    if (rect && w && (rect.top < 60 || rect.bottom > w.innerHeight - 40)) w.scrollBy({ top: rect.top - w.innerHeight / 3 });
    setPageFind({ count: ranges.length, index });
  }, []);
  const findOnPage = useCallback(
    (text: string) => {
      const d = docRef.current;
      pageMatches.current = [];
      const q = text.trim().toLocaleLowerCase();
      if (d?.body && q.length >= 2) {
        const index = textIndex(d.body);
        const hay = index.text.toLocaleLowerCase().replace(/ /g, " ");
        for (let at = hay.indexOf(q); at >= 0 && pageMatches.current.length < 5000; at = hay.indexOf(q, at + q.length)) {
          const range = rangeFor(index, at, at + q.length);
          if (range && range.getClientRects().length) pageMatches.current.push(range);
        }
      }
      showPageMatch(0);
    },
    [showPageMatch],
  );
  const runFind = (text: string) => {
    setQuery(text);
    if (reading) readingRef.current?.setQuery(text);
    else findOnPage(text);
  };
  const stepFind = (direction: number) => {
    if (reading) return readingRef.current?.step(direction);
    const n = pageMatches.current.length;
    if (n) showPageMatch((pageFind.index + direction + n) % n);
  };
  const closeFind = () => {
    setFinding(false);
    setQuery("");
    readingRef.current?.setQuery("");
    findOnPage("");
  };
  // The find moves with the view.
  useEffect(() => {
    if (!finding || !query) return;
    if (reading) {
      findOnPage("");
      const timer = setTimeout(() => readingRef.current?.setQuery(query), 50);
      return () => clearTimeout(timer);
    }
    findOnPage(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading, readingState?.ready]);

  // Shift-Cmd-R as Safari's Reader; Cmd-F finds.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey && key === "r") {
        event.preventDefault();
        toggleReading();
      } else if (!event.shiftKey && key === "f") {
        event.preventDefault();
        setFinding(true);
        requestAnimationFrame(() => findInput.current?.select());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleReading]);

  if (error) return <div className="kx-web-reader"><p className="kx-web-reader-error">{error}</p></div>;
  return (
    <div className="kx-web-reader">
      <header className="kx-web-reader-bar">
        <Icon name="globe" size={13} className="kx-web-reader-kind" />
        <div className="kx-web-reader-title">
          <strong title={source?.title}>{source?.title || "Web page"}</strong>
          <span>
            {host(url)}
            {captured && <> · Saved {formatDate(captured)}</>}
          </span>
        </div>
        <span className="kx-spacer" />
        <span className="kx-web-reader-tools">
          {reading && (
            <>
              <button
                type="button"
                className="kx-icon-button"
                aria-label="Text options"
                title="Text size, font, line width and spacing"
                aria-pressed={popover?.kind === "type"}
                onClick={(event) => setPopover(popover?.kind === "type" ? undefined : { kind: "type", anchor: event.currentTarget })}
              >
                <Icon name="typography" size={14} />
              </button>
              <button
                type="button"
                className="kx-icon-button kx-web-reader-count"
                aria-label="Contents"
                title="Headings of this page"
                aria-pressed={popover?.kind === "contents"}
                disabled={!readingState?.ready}
                onClick={(event) => setPopover(popover?.kind === "contents" ? undefined : { kind: "contents", anchor: event.currentTarget })}
              >
                <Icon name="list" size={14} />
                {readingState?.outline.length ? <span>{readingState.outline.length}</span> : null}
              </button>
            </>
          )}
          <button type="button" className="kx-icon-button" aria-label="Reading mode" title={reading ? "Back to the saved page (⇧⌘R)" : "Reading mode: the article as text (⇧⌘R)"} aria-pressed={!!reading} onClick={toggleReading}>
            <Icon name="readingMode" size={14} />
          </button>
          <button
            type="button"
            className="kx-icon-button"
            aria-label="Find"
            title="Find on this page (⌘F)"
            aria-pressed={finding}
            onClick={() => {
              if (finding) closeFind();
              else {
                setFinding(true);
                requestAnimationFrame(() => findInput.current?.focus());
              }
            }}
          >
            <Icon name="search" size={14} />
          </button>
        </span>
        <span className="kx-web-reader-divider" aria-hidden="true" />
        {url && (
          <button type="button" className="kx-web-reader-action" title={`Open the live page: ${url}`} onClick={() => window.open(url, "_blank")}>
            <Icon name="external" size={13} />
            <span>Live page</span>
          </button>
        )}
        <button type="button" className="kx-icon-button" title="Details and notes" aria-label="Details and notes" aria-pressed={panelTab === "details"} data-active={panelTab === "details" || undefined} onClick={() => showPanel("details")}>
          <Icon name="info" size={14} filled={panelTab === "details"} />
        </button>
        <button type="button" className="kx-icon-button" title={panelTab ? "Hide the panel" : "Show highlights"} aria-label="Highlights" aria-pressed={panelTab === "highlights"} data-active={panelTab === "highlights" || undefined} onClick={() => showPanel(panelTab ? panelTab : "highlights")}>
          <Icon name="panelRight" size={14} filled={!!panelTab} />
        </button>
      </header>
      <div className="kx-web-reader-body" ref={body}>
        <div className="kx-web-reader-page">
          {page && (
            <iframe
              ref={frame}
              title={source?.title || "Saved web page"}
              sandbox="allow-same-origin"
              referrerPolicy="no-referrer"
              srcDoc={page.html}
              onLoad={onLoad}
            />
          )}
        </div>
        {reading && (
          <ReadingMode
            ref={readingRef}
            web={backend}
            start={{ page: 0, fraction: 0 }}
            typography={typography}
            invoke={(command, args) => invoke(command, args as Record<string, unknown>, workspaceId)}
            onExit={exitReading}
            onState={setReadingState}
            onNotice={say}
            onUnreadable={(reason) => {
              exitReading(null);
              say(`Reading mode is not available for this page. ${reason}`);
            }}
          />
        )}
        {reading && popover?.kind === "type" && <TypographyPopover original="web page" anchor={popover.anchor} value={typography} onChange={setTypography} onClose={() => setPopover(undefined)} />}
        {reading && popover?.kind === "contents" && (
          <ContentsPopover original="web page" anchor={popover.anchor} entries={readingState?.outline ?? []} onPick={(item) => readingRef.current?.scrollToItem(item)} onClose={() => setPopover(undefined)} />
        )}
        {finding && (
          <form
            className="kx-web-find"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              stepFind(1);
            }}
          >
            <Icon name="search" size={13} className="kx-web-find-icon" />
            <input
              ref={findInput}
              autoFocus
              spellCheck={false}
              aria-label="Find on page"
              placeholder={reading ? "Find in the article" : "Find on this page"}
              value={query}
              onChange={(event) => runFind(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeFind();
                }
              }}
            />
            <span role="status">
              {query.trim().length >= 2
                ? reading
                  ? `${readingState?.searchCount ? readingState.searchIndex + 1 : 0} of ${readingState?.searchCount ?? 0}`
                  : `${pageFind.count ? pageFind.index + 1 : 0} of ${pageFind.count}`
                : ""}
            </span>
            <button type="button" className="kx-icon-button" aria-label="Previous match" title="Previous match" onClick={() => stepFind(-1)}>
              <Icon name="chevronUp" size={13} />
            </button>
            <button type="submit" className="kx-icon-button" aria-label="Next match" title="Next match">
              <Icon name="chevronDown" size={13} />
            </button>
            <button type="button" className="kx-icon-button" aria-label="Close find" title="Close" onClick={closeFind}>
              <Icon name="close" size={13} />
            </button>
          </form>
        )}
        {notice && (
          <div className="kx-web-notice" role="alert">
            {notice}
          </div>
        )}
        {citationCard}
        {context && !draft && active && (
          <HighlightInfo
            className="kx-web-highlight-info"
            text={active.text}
            comment={active.comment}
            color={active.color}
            colors={PAGE_RGB}
            createdAt={active.createdAt}
            updatedAt={active.updatedAt}
            usage={usage}
            style={{ position: "absolute", ...place(context.rect, 312, 260) }}
            onColor={(color) => highlight(color as Color)}
            onComment={openComment}
            onCopy={() => void copy()}
            onCite={() => void cite()}
            onDelete={() => remove(active.id)}
          />
        )}
        {context && !draft && !active && (
          <div className="kx-web-toolbar" role="toolbar" aria-label={context.kind === "selection" ? "Text selection actions" : "Highlight actions"} style={place(context.rect, 300, 36)} onPointerDown={(e) => e.preventDefault()}>
            {HIGHLIGHT_COLORS.map((color) => (
              <button key={color} type="button" className="kx-web-swatch" data-color={color} aria-label={`${color} highlight`} onClick={() => highlight(color)} />
            ))}
            <span className="kx-web-toolbar-divider" />
            <button type="button" className="kx-web-toolbar-action" aria-label="Copy" title="Copy" onClick={() => void copy()}>
              <Icon name="copy" size={15} />
            </button>
            <button type="button" className="kx-web-toolbar-action" aria-label="Cite" title="Copy as a quote with its source" onClick={() => void cite()}>
              <Icon name="quote" size={15} />
            </button>
            <FirstUseTip help="tip.cite" anchor='.kx-web-toolbar-action[aria-label="Cite"]' side="above" delay={600} />
            <button type="button" className="kx-web-toolbar-action" aria-label="Add comment" title="Add comment" onClick={openComment}>
              <Icon name="note" size={15} />
            </button>
          </div>
        )}
        {draft && (
          <form
            className="kx-web-comment"
            style={place(draft.rect, 320, 170)}
            onSubmit={(e) => {
              e.preventDefault();
              saveDraft();
            }}
          >
            <blockquote>{draft.text.replace(/\s+/g, " ").trim()}</blockquote>
            <textarea
              autoFocus
              aria-label="Comment"
              placeholder="Add a comment…"
              value={draft.comment}
              onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveDraft();
                if (e.key === "Escape") setDraft(null);
              }}
            />
            <footer>
              <span className="kx-spacer" />
              <button type="button" className="kx-web-comment-cancel" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button type="submit" className="kx-web-comment-save">
                Save
              </button>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}
