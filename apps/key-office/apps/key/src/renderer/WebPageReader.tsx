// A saved web page, read offline and annotated like a PDF. The page is shown in a sandboxed
// frame that runs no scripts (none are kept, and the frame may not run any) and makes no
// requests (its Content-Security-Policy allows only inlined data). The reader reaches into
// the frame's document to select, highlight and scroll; highlights are the library's
// annotations, anchored by text quote and position (web-anchors.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { bridge, type Invoke, type Source } from "./library-api";
import { openItemAt, toast } from "./item-actions";
import { describeRange, locate, rangeFor, textIndex, unwrap, wrapRange, type WebAnchor } from "./web-anchors";
import { takeWebFocus, webPanelStatusItems, WEB_FOCUS_EVENT } from "./web-page-open";
import { writeQuoteClipboard } from "./quote-clipboard";
import { AnnotationText } from "./annotation-text";
import { drawHighlightMarkers, inFrameView } from "./web-highlight-markers";
import { highlightUsage } from "./highlight-usage";
import { openNoteAt } from "./note-reveal";
import { HighlightInfo } from "@key-reader/pdfjs/HighlightInfo";
import { useStatusItems } from "./status-bar";
import { useWebReferences } from "./web-reader-references";
import "./web-page.css";

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
  `@keyframes key-flash{0%,30%{background:rgb(var(--key-hl, 255 185 60) / .85)}}` +
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
        toast(`Could not save the highlight: ${String(e).replace(/^Error: /, "")}`);
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
  /** Goes to a highlight, or to a quoted passage and lights it up for a moment. */
  const goTo = useCallback(
    (d: Document, focus: { annotationId?: string; text?: string }) => {
      setContext(null);
      setDraft(null);
      if (focus.annotationId && flash(d, focus.annotationId)) return;
      if (!focus.text) return;
      const index = textIndex(d.body);
      const at = locate(index, undefined, focus.text);
      if (!at) return toast("That passage is not on the saved page");
      const marks = wrapRange(index, at.start, at.end, () => {
        const m = d.createElement("mark");
        m.className = "key-passage";
        return m;
      });
      marks[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => unwrap(marks), 2600);
    },
    [flash],
  );
  useEffect(() => {
    if (!doc) return;
    const take = () => {
      const focus = takeWebFocus(sourceId);
      // After the highlights are drawn.
      if (focus) setTimeout(() => goTo(doc, focus), 60);
    };
    take();
    const listener = (event: Event) => (event as CustomEvent).detail === sourceId && take();
    window.addEventListener(WEB_FOCUS_EVENT, listener);
    return () => window.removeEventListener(WEB_FOCUS_EVENT, listener);
  }, [doc, sourceId, goTo]);

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
    setDoc(d);
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
  const cite = async () => {
    if (!source || !contextText.trim()) return;
    const authors = (source.creators ?? []).map((c) => c.family || c.literal || c.given || "").filter(Boolean);
    await writeQuoteClipboard({
      v: 1,
      text: contextText,
      workspaceId,
      sourceId,
      documentHash: source.fileHash ?? sourceId,
      page: -1,
      rects: [],
      color: active?.color,
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
        {url && (
          <button type="button" className="kx-web-reader-action" title={`Open the live page: ${url}`} onClick={() => window.open(url, "_blank")}>
            <Icon name="external" size={13} />
            <span>Live page</span>
          </button>
        )}
        <button type="button" className="kx-icon-button" title="Details and notes" aria-label="Details and notes" aria-pressed={panelTab === "details"} data-active={panelTab === "details" || undefined} onClick={() => showPanel("details")}>
          <Icon name="info" size={14} />
        </button>
        <button type="button" className="kx-icon-button" title={panelTab ? "Hide the panel" : "Show highlights"} aria-label="Highlights" aria-pressed={panelTab === "highlights"} data-active={panelTab === "highlights" || undefined} onClick={() => showPanel(panelTab ? panelTab : "highlights")}>
          <Icon name="panelRight" size={14} />
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
