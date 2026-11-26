// A saved web page's references in its reader: the host reads the list from the page's HTML
// (key-store `web_references.rs`, `store_web_references_detect`) and keeps it as the library
// keeps a PDF's analysis (looking each one up as it does a PDF's). Links in the page that point into the list show the same
// citation card as the PDF reader on hover; a click pins it, Details grows it in place.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CitationCardBody } from "@key-reader/pdfjs/CitationCard";
import { anchoredFloatingCardPosition } from "@key-reader/pdfjs/floating-card";
import type { ScholarlyMetadata, ScientificCitation, ScientificReference } from "@key-reader/engines/types";
import type { ScholarlyEntry } from "@key-reader/pdfjs/scholarly-metadata";
import { useDismiss } from "@key-reader/ui/dismiss";
import type { AnalysisReport } from "./reader-analysis";
import { working } from "./reader-analysis";
import type { Invoke, Source } from "./library-api";
import { bridge } from "./library-api";
import { webPageEvent, WEB_ANALYSIS_EVENT, WEB_REANALYZE_EVENT, WEB_REFERENCE_EVENT } from "./web-page-open";
import { readerLibraryWorks } from "./reader-library-works";
import { addFromSource } from "./add-from-source";
import "./web-reader-panel.css";

/** The host's reading of a page: its reference list and the in-text links to it. */
export interface WebReferenceScan {
  references: { number: number; text: string; anchor?: string; doi?: string; url?: string; title?: string; authors?: string[]; year?: number }[];
  citations: { anchor: string; numbers: number[] }[];
  method: "list" | "entries" | "meta" | "json-ld" | "none";
}

export type WebAnalysisReport = AnalysisReport & { references: (AnalysisReport["references"][number] & { seq?: number; error?: string | null })[] };

/** The stored analysis of a saved page, refreshed while its lookups run. */
export function useWebAnalysis(invoke: Invoke, workspaceId: string, sourceId: string) {
  const [report, setReport] = useState<WebAnalysisReport | null>();
  const refresh = useCallback(
    () =>
      invoke<WebAnalysisReport>("store_analysis", { id: sourceId }, workspaceId)
        .then((r) => setReport({ ...r, indexStatus: null }))
        .catch(() => setReport(null)),
    [invoke, workspaceId, sourceId],
  );
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    const listener = (event: Event) => (event as CustomEvent).detail?.sourceId === sourceId && void refresh();
    window.addEventListener(WEB_ANALYSIS_EVENT, listener);
    return () => window.removeEventListener(WEB_ANALYSIS_EVENT, listener);
  }, [sourceId, refresh]);
  useEffect(() => {
    if (!working(report)) return;
    const timer = setTimeout(() => void refresh(), 1500);
    return () => clearTimeout(timer);
  }, [report, refresh]);
  return [report, refresh] as const;
}

const normal = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** What the card knows of each reference: the lookup's answer, else what the page said. */
function entryOf(stored: WebAnalysisReport["references"][number] | undefined, busy: boolean): ScholarlyEntry {
  const meta = stored?.metadata as (ScholarlyMetadata & { source?: string }) | null | undefined;
  if (meta?.title && !(busy && meta.source === "page" && !stored?.error)) return { state: "ready", metadata: { ...meta, authors: meta.authors ?? [], source: meta.source ?? "page" } };
  if (busy) return { state: "loading" };
  return { state: "failed", error: stored?.error ?? "Not found" };
}

export function useWebReferences({
  doc,
  frame,
  source,
  invoke,
  workspaceId,
  sourceId,
  onFlash,
}: {
  doc: Document | null;
  frame: React.RefObject<HTMLIFrameElement | null>;
  source: Source | null;
  invoke: Invoke;
  workspaceId: string;
  sourceId: string;
  /** Lights up an element of the page (the reference gone to). */
  onFlash: (el: Element) => void;
}): ReactNode {
  const [report, refresh] = useWebAnalysis(invoke, workspaceId, sourceId);
  // A cited work's card: In library (or possibly), else Add to library through the collection
  // chooser, beside this page in its collections by default.
  const libraryWorks = useMemo(
    () =>
      readerLibraryWorks({
        invoke: <T,>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args, workspaceId),
        open: (id) => void bridge().tabAction("open-source-page", { workspaceId, sourceId: id }),
        collections: () => invoke<Source | null>("store_source", { id: sourceId }, workspaceId).then((s) => s?.collections ?? []),
        addFrom: (work) => addFromSource(invoke, { workspaceId, sourceId }, work),
      }),
    [invoke, workspaceId, sourceId],
  );
  // The host reads the saved page once the report is in; a page saved before references were
  // read (or read with another method) is stored now, and again when asked to re-analyse.
  const [scan, setScan] = useState<WebReferenceScan | null>(null);
  const read = useRef("");
  const store = useCallback(
    async (save: boolean) => {
      if (source?.kind !== "web") return;
      try {
        const answer = await invoke<{ scan: WebReferenceScan }>("store_web_references_detect", { id: sourceId, store: save }, workspaceId);
        setScan(answer.scan);
      } catch {
        setScan({ references: [], citations: [], method: "none" });
        return;
      }
      if (!save) return;
      await refresh();
      webPageEvent(WEB_ANALYSIS_EVENT, { sourceId });
    },
    [source?.kind, sourceId, invoke, workspaceId, refresh],
  );
  useEffect(() => {
    if (report === undefined || !doc || read.current === sourceId) return;
    read.current = sourceId;
    void store(!report?.analysis || report.analysis.engine !== "html");
  }, [report, doc, sourceId, store]);
  useEffect(() => {
    const listener = (event: Event) => (event as CustomEvent).detail?.sourceId === sourceId && void store(true);
    window.addEventListener(WEB_REANALYZE_EVENT, listener);
    return () => window.removeEventListener(WEB_REANALYZE_EVENT, listener);
  }, [sourceId, store]);

  // The page's references, as the card reads them, with what the library found for each.
  const busy = working(report);
  const { references, entries, anchors } = useMemo(() => {
    const list = report?.references ?? [];
    const byText = new Map(list.map((r) => [normal(r.text), r]));
    const found = scan?.references.length ? scan.references : list.map((r, i) => ({ number: r.number ?? i + 1, text: r.text, anchor: undefined }));
    const references = new Map<number, ScientificReference>();
    const entries = new Map<number, ScholarlyEntry>();
    const anchors = new Map<number, string>();
    found.forEach((r, i) => {
      const match = byText.get(normal(r.text)) ?? list[i];
      references.set(r.number, { number: r.number, page: -1, text: r.text, textRuns: [] });
      entries.set(r.number, entryOf(match, busy));
      if (r.anchor) anchors.set(r.number, r.anchor);
    });
    return { references, entries, anchors };
  }, [scan, report, busy]);

  const goTo = useCallback(
    (number: number) => {
      const anchor = anchors.get(number);
      const el = anchor && doc?.getElementById(anchor);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      onFlash(el);
    },
    [anchors, doc, onFlash],
  );
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail as { sourceId?: string; number?: number };
      if (detail?.sourceId === sourceId && detail.number != null) goTo(detail.number);
    };
    window.addEventListener(WEB_REFERENCE_EVENT, listener);
    return () => window.removeEventListener(WEB_REFERENCE_EVENT, listener);
  }, [sourceId, goTo]);

  // The card: over a citation link while hovered, pinned by a click, expanded by Details.
  const [card, setCard] = useState<{ link: HTMLAnchorElement; citation: ScientificCitation; pinned: boolean } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overrides, setOverrides] = useState<Map<number, ScholarlyMetadata>>(new Map());
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(card);
  latest.current = card;
  const close = useCallback(() => {
    clearTimeout(hideTimer.current);
    setCard(null);
    setExpanded(false);
    setActive(null);
  }, []);
  const scheduleHide = useCallback(() => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!latest.current?.pinned) close();
    }, 220);
  }, [close]);

  useEffect(() => {
    if (!doc || !scan?.citations.length) return;
    const win = doc.defaultView;
    const byAnchor = new Map(scan.citations.map((c) => [c.anchor, c.numbers]));
    const citationOf = (target: EventTarget | null) => {
      const link = (target as Element | null)?.closest?.("a[href*='#']") as HTMLAnchorElement | null;
      if (!link) return null;
      const href = link.getAttribute("href") ?? "";
      let id = href.slice(href.indexOf("#") + 1);
      try {
        id = decodeURIComponent(id);
      } catch {
        /* as written */
      }
      const numbers = byAnchor.get(id);
      if (!numbers) return null;
      const label = (link.textContent ?? "").replace(/\s+/g, " ").trim() || `[${numbers.join(", ")}]`;
      return { link, citation: { id, page: -1, start: 0, end: 0, bounds: { left: 0, top: 0, right: 0, bottom: 0 }, source: label, numbers } as ScientificCitation };
    };
    const over = (event: Event) => {
      const found = citationOf(event.target);
      if (!found) return;
      clearTimeout(hideTimer.current);
      if (latest.current?.pinned) return;
      if (latest.current?.link === found.link) return;
      clearTimeout(showTimer.current);
      showTimer.current = setTimeout(() => {
        setExpanded(false);
        setActive(null);
        setCard({ ...found, pinned: false });
      }, 160);
    };
    const out = (event: Event) => {
      if (citationOf(event.target)) scheduleHide();
    };
    // On the window, before the page's own link handling: a citation pins its card.
    const click = (event: MouseEvent) => {
      const found = citationOf(event.target);
      if (!found) {
        if (latest.current?.pinned && !(event.target as Element)?.closest?.("a[href]")) close();
        return;
      }
      if (doc.getSelection()?.isCollapsed === false) return;
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(showTimer.current);
      setCard({ ...found, pinned: true });
    };
    const scrolled = () => {
      if (!latest.current?.pinned) close();
      else setCard((c) => (c ? { ...c } : c));
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && latest.current && close();
    doc.addEventListener("keydown", key);
    doc.addEventListener("pointerover", over);
    doc.addEventListener("pointerout", out);
    win?.addEventListener("click", click, true);
    doc.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      doc.removeEventListener("keydown", key);
      doc.removeEventListener("pointerover", over);
      doc.removeEventListener("pointerout", out);
      win?.removeEventListener("click", click, true);
      doc.removeEventListener("scroll", scrolled);
    };
  }, [doc, scan, scheduleHide, close]);

  const cardRef = useRef<HTMLDivElement>(null);
  useDismiss(!!card?.pinned, { refs: [cardRef], kind: "passive", scroll: false, onDismiss: close });
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = cardRef.current;
    const f = frame.current?.getBoundingClientRect();
    if (!card || !el || !f || !card.link.isConnected) return setPosition(null);
    const r = card.link.getBoundingClientRect();
    const size = el.getBoundingClientRect();
    setPosition(
      anchoredFloatingCardPosition(
        { left: f.left + r.left, right: f.left + r.right, top: f.top + r.top, bottom: f.top + r.bottom },
        { width: window.innerWidth, height: window.innerHeight },
        { width: size.width, height: size.height },
        8,
      ),
    );
  }, [card, expanded, active, frame, report]);

  useEffect(() => bridge().on("dismiss-overlays", () => latest.current?.pinned && close()), [close]);

  if (!card) return null;
  const inLibrary = (number: number) => {
    const match = report?.references.find((r) => normal(r.text) === normal(references.get(number)?.text ?? ""));
    const id = match?.matchedSourceId;
    return id ? () => void bridge().tabAction("open-source-page", { workspaceId, sourceId: id }) : null;
  };
  return createPortal(
    <div
      ref={cardRef}
      className="pdfjs-cite-card kx-web-cite-card"
      data-expanded={expanded || undefined}
      role="dialog"
      aria-label={card.citation.numbers.length > 1 ? `${card.citation.numbers.length} cited works` : "Cited work"}
      style={{ left: position?.left ?? -9999, top: position?.top ?? -9999 }}
      onPointerEnter={() => clearTimeout(hideTimer.current)}
      onPointerLeave={() => !card.pinned && scheduleHide()}
    >
      <CitationCardBody
        citation={card.citation}
        active={active}
        onSelect={(n) => setActive(n)}
        reference={(n) => references.get(n)}
        entry={(n) => {
          const override = overrides.get(n);
          return override ? { state: "ready", metadata: override } : entries.get(n);
        }}
        onResolved={(n, metadata) => setOverrides((m) => new Map(m).set(n, metadata))}
        onGoToReference={(reference) => {
          close();
          goTo(reference.number);
        }}
        onShowMore={(n) => {
          setActive(n);
          setExpanded(true);
          setCard((c) => (c ? { ...c, pinned: true } : c));
        }}
        expanded={expanded}
        onCollapse={() => setExpanded(false)}
        libraryAction={inLibrary}
        libraryWorks={libraryWorks}
        onClose={card.pinned ? close : undefined}
        uiId={`web-${sourceId}`}
      />
    </div>,
    // Above the panes (a pane clips what it holds), placed in the window's coordinates.
    document.body,
  );
}
