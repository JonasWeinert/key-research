import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PdfJsBenchmarkApp, {
  type PdfJsViewState,
  type PdfReaderChromeState,
  type PdfReaderHandle,
  type PdfReaderRail,
} from "@key-reader/pdfjs/PdfJsBenchmarkApp";
import {
  registerManagedSource,
  type ManagedSource,
} from "@key-reader/pdfjs/reader-model";
import "@key-reader/styles.css";
import "./pdf-reader.css";
import "./pdf-ui-adapter.css";
import { Icon } from "./icons";
import { PdfRail } from "./PdfRail";
import { AnalysisStatus, working, type AnalysisReport } from "./reader-analysis";
import { writeQuoteClipboard } from "./quote-clipboard";
import { useFloatingChrome } from "./reader-chrome";
import { WebPdfControl, type WebPdfInfo } from "./WebPdfControl";
import { readerLibraryWorks } from "./reader-library-works";
import { ReferenceAside } from "./ReferenceAside";
import { highlightUsage } from "./highlight-usage";
import type { HighlightUsage } from "@key-reader/pdfjs/HighlightInfo";


type Target = {
  id: string;
  documentHash: string;
  page: number;
  rects: number[][];
  targetText: string;
};
type Focus = { page?: number; top?: number; annotationId?: string; text?: string };
/** What the panel beside the PDF shows, or false while it is closed. */
type PanelTab = false | "details" | "references";
const asPanelTab = (value: unknown): PanelTab => (value === "references" ? "references" : value ? "details" : false);
type StatusItem = { id: string; label: string; icon?: string; active?: boolean; title?: string };
interface Ready {
  source: ManagedSource;
  workspaceId?: string;
  focus?: Focus;
  notesOpen?: boolean;
  panelTab?: "details" | "references";
  viewState?: PdfJsViewState;
  searchTarget?: Target;
  searchNavigation?: Navigation;
  /** A PDF opened from the in-app browser (or one just added from there). */
  web?: WebPdfInfo;
}
type Navigation = { index: number; total: number; shared?: boolean; query?: string };
interface ReaderBridge {
  readerReady(): Promise<Ready>;
  readerState(state: PdfJsViewState): void;
  on(event: string, listener: (payload: unknown) => void): () => void;
  readerBack?(): void;
  readerDismiss?(): Promise<void>;
  readerNotes?(tab?: "details" | "references"): Promise<string | boolean>;
  /** The window's status bar (when the shell has one): items this view contributes, and presses on them. */
  setStatusItems?(items: StatusItem[]): void;
  onStatusItem?(listener: (id: string) => void): () => void;
  readerAddToNote?(passage: { text: string; page: number; color?: string }): Promise<void>;
  invoke?<T>(command: string, args?: unknown): Promise<T>;
  readerAnalysis?(): Promise<AnalysisReport | null>;
  readerReanalyze?(): Promise<void>;
  readerOpenSource?(sourceId: string): Promise<void>;
  readerOpenItem?(item: { kind: string; id: string; title?: string; reveal?: string }): Promise<void>;
  readerResult?(direction: number): Promise<void>;
}
const bridge = () => (window as unknown as { key: ReaderBridge }).key;

/** Where a quote copied with Cite is from: the library's record of this PDF. */
interface CiteSource {
  sourceId?: string;
  authors: string[];
  year?: number | string;
  title?: string;
}
type Creator = { family?: string; literal?: string; given?: string; role?: string };
const surname = (creator: Creator) => creator.family || creator.literal?.split(/\s+/).at(-1) || creator.given || "";

/** Pages start this far further down, below the floating toolbar. */
const CHROME_INSET = 30;

export default function PdfReader() {
  const reader = useRef<PdfReaderHandle>(null);
  const [document, setDocument] = useState<{ file: File; initial: Ready }>();
  const [error, setError] = useState("");
  const [chrome, setChrome] = useState<PdfReaderChromeState>();
  const [target, setTarget] = useState<Target>();
  const [navigation, setNavigation] = useState<Navigation>({ index: -1, total: 0 });
  const [navigating, setNavigating] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const [page, setPage] = useState(1);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [panelTab, setPanelTab] = useState<PanelTab>(false);
  const [notice, setNotice] = useState("");
  const [report, setReport] = useState<AnalysisReport | null>();
  // The outline lives on the rail (or, without one, the headings analysis found); its full
  // list opens from the rail's footer.
  const detected = report?.sections;
  const renderRail = useCallback((rail: PdfReaderRail) => <PdfRail rail={rail} detected={detected} />, [detected]);
  // "Show in PDF": go to the place once the document is ready. Annotations load just after
  // the document, so a second try lights the highlight up if the first was too early.
  const [focus, setFocus] = useState<Focus>();
  useEffect(() => bridge().on("reader-focus", (payload) => setFocus({ ...(payload as Focus) })), []);
  // The panel also opens and closes from the shell (its own buttons, Add to note).
  useEffect(() => bridge().on("reader-notes", (open) => setPanelTab(asPanelTab(open))), []);
  useEffect(() => {
    if (!focus || !chrome?.ready) return;
    const go = () =>
      focus.top !== undefined && focus.page !== undefined && !focus.annotationId && !focus.text
        ? reader.current?.goTo(focus.page, focus.top)
        : reader.current?.focusAnnotation(focus.annotationId, focus.page, focus.text);
    go();
    setTimeout(go, 700);
    setFocus(undefined);
  }, [focus, chrome?.ready]);
  const refreshAnalysis = useCallback(() => {
    void bridge()
      .readerAnalysis?.()
      .then((next) => setReport(next ?? null))
      .catch(() => setReport(null));
  }, []);
  useEffect(() => {
    if (!document) return;
    refreshAnalysis();
  }, [document, refreshAnalysis]);
  // Poll while the library is still analysing this PDF.
  useEffect(() => {
    if (!working(report)) return;
    const timer = setTimeout(refreshAnalysis, 1000);
    return () => clearTimeout(timer);
  }, [report, refreshAnalysis]);
  const rerun = () => {
    setReport((r) => (r ? { ...r, analysis: null, references: [], indexStatus: "pending" } : r));
    void bridge()
      .readerReanalyze?.()
      .then(refreshAnalysis)
      .catch((e) => setNotice(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, "")));
  };
  // Cite: who wrote this PDF, read once from the library.
  const citeSource = useRef<Promise<CiteSource> | null>(null);
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 1600);
    return () => clearTimeout(timer);
  }, [toast]);
  const cite = useCallback(
    async (passage: { text: string; page: number; rects: number[][]; color?: string }) => {
      const initial = document?.initial;
      if (!initial) return;
      citeSource.current ??= (async (): Promise<CiteSource> => {
        const fallback: CiteSource = { authors: [], title: initial.source.title };
        try {
          const found = await bridge().invoke?.<{ items: { id: string; title?: string; year?: number; creators?: Creator[] }[] }>(
            "store_sources",
            { ids: [initial.source.hash], limit: 1, scope: "all" },
          );
          const source = found?.items[0];
          if (!source) return fallback;
          const authors = (source.creators ?? []).filter((c) => !c.role || c.role === "author").map(surname).filter(Boolean);
          return { sourceId: source.id, authors, year: source.year, title: source.title || initial.source.title };
        } catch {
          return fallback;
        }
      })();
      const source = await citeSource.current;
      try {
        await writeQuoteClipboard({
          v: 1,
          text: passage.text,
          workspaceId: initial.workspaceId,
          sourceId: source.sourceId,
          documentHash: initial.source.hash,
          page: passage.page,
          rects: passage.rects,
          color: passage.color,
          citation: { authors: source.authors, year: source.year, title: source.title },
        });
        setToast("Quote copied");
      } catch (e) {
        setNotice(`Could not copy the quote: ${String(e)}`);
        setTimeout(() => setNotice(""), 4000);
      }
    },
    [document],
  );
  // Add to library from a citation card or a reference: into this window's library, beside
  // this PDF in its collections. A PDF from the web is not in the library, so it offers none.
  const libraryWorks = useMemo(() => {
    const initial = document?.initial;
    const call = bridge().invoke;
    if (!initial || (initial.web && "url" in initial.web) || !call || !bridge().readerOpenSource) return undefined;
    return readerLibraryWorks({
      invoke: <T,>(command: string, args?: Record<string, unknown>) => call<T>(command, args),
      open: (sourceId) => void bridge().readerOpenSource?.(sourceId),
      collections: () =>
        call<{ items: { collections?: string[] }[] }>("store_sources", { ids: [initial.source.hash], limit: 1, scope: "all" }).then(
          (found) => found.items[0]?.collections ?? [],
        ),
    });
  }, [document]);
  // A highlight's info card: the notes and canvases that use it, each opening there.
  const usage = useMemo(() => {
    const initial = document?.initial;
    const call = bridge().invoke;
    if (!initial || (initial.web && "url" in initial.web) || !call || !bridge().readerOpenItem) return undefined;
    const invoke = <T,>(command: string, args?: Record<string, unknown>) => call<T>(command, args);
    let sourceId: Promise<string | undefined> | undefined;
    return async (annotation: { id: string; text: string }): Promise<HighlightUsage[]> => {
      sourceId ??= invoke<{ items: { id: string }[] }>("store_sources", { ids: [initial.source.hash], limit: 1, scope: "all" }).then((found) => found.items[0]?.id);
      const id = await sourceId;
      if (!id) return [];
      const uses = await highlightUsage(invoke, initial.workspaceId ?? "", id, annotation);
      return uses.map((use) => ({
        ...use,
        open: () => void bridge().readerOpenItem?.({ kind: use.kind, id: use.id, title: use.title, reveal: use.kind === "note" ? annotation.text : undefined }),
      }));
    };
  }, [document]);
  const latestState = useRef<PdfJsViewState | undefined>(undefined);
  const stateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    let alive = true;
    const stop = bridge().on("search-target", (payload) => {
      if (alive) {
        setTarget(payload as Target | undefined);
        if (!payload) reader.current?.closeSearch();
      }
    });
    const stopNavigation = bridge().on("search-navigation", (payload) => {
      if (alive) setNavigation(payload as Navigation);
    });
    void bridge()
      .readerReady()
      .then((initial) => {
        if (!alive) return;
        const file = new File(
          [],
          /\.pdf$/i.test(initial.source.title)
            ? initial.source.title
            : `${initial.source.title}.pdf`,
          { type: "application/pdf", lastModified: 0 },
        );
        registerManagedSource(file, initial.source);
        setDocument({ file, initial });
        setPanelTab(initial.panelTab ?? (initial.notesOpen ? "details" : false));
        if (initial.focus) setFocus(initial.focus);
        setTarget((current) => current ?? initial.searchTarget);
        if (initial.searchNavigation) setNavigation(initial.searchNavigation);
        setPage((initial.viewState?.pageIndex ?? 0) + 1);
      })
      .catch((error) => {
        if (alive) setError(String(error));
      });
    return () => {
      alive = false;
      stop();
      stopNavigation();
      clearTimeout(stateTimer.current);
      if (latestState.current) bridge().readerState(latestState.current);
    };
  }, []);
  const viewChanged = useCallback((state: PdfJsViewState) => {
    latestState.current = state;
    setPage(state.pageIndex + 1);
    bridge().readerState(state);
  }, []);
  // A library PDF's details and references share the panel beside it (the shell's); a PDF
  // from the web has only references, in the reader's own panel.
  const docks = !!bridge().readerNotes && !!document && !(document.initial.web && "url" in document.initial.web);
  const showPanel = useCallback(
    (tab: "details" | "references") => {
      if (!docks) {
        if (tab === "references") reader.current?.togglePanel("references");
        return;
      }
      void bridge()
        .readerNotes?.(tab)
        .then((open) => setPanelTab(asPanelTab(open)))
        .catch((e) => {
          setNotice(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ""));
          setTimeout(() => setNotice(""), 4000);
        });
    },
    [docks],
  );
  // The status bar's switch between the two (when the shell has a status bar).
  const showPanelRef = useRef(showPanel);
  showPanelRef.current = showPanel;
  const referencesShown = docks ? panelTab === "references" : chrome?.activePanel === "references";
  useEffect(() => {
    if (!document) return;
    bridge().setStatusItems?.([
      ...(docks ? [{ id: "details", label: "Details", icon: "panelRight", active: panelTab === "details", title: "Show or hide this source’s details and note" }] : []),
      { id: "references", label: "References", icon: "book", active: referencesShown, title: "Show or hide the references cited in this PDF" },
    ]);
  }, [document, docks, panelTab, referencesShown]);
  useEffect(
    () =>
      bridge().onStatusItem?.((id) => {
        if (id === "details" || id === "references") showPanelRef.current(id);
      }),
    [],
  );
  const navigate = async (direction: number) => {
    setNavigating(true);
    setNavigationError("");
    try {
      await bridge().readerResult?.(direction);
    } catch (e) {
      setNavigationError(String(e));
    } finally {
      setNavigating(false);
    }
  };
  const closeSearch = () => {
    reader.current?.closeSearch();
    setShowSearch(false);
    setQuery("");
  };
  const surface = useRef<HTMLElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const chromeHidden = useFloatingChrome(surface, chromeRef, showSearch || !!target, !!document);
  if (error)
    return (
      <main className="key-ui-root key-pdf-error">
        <h2>Unable to open PDF</h2>
        <p>{error}</p>
        <button type="button" className="key-pdf-details" onClick={() => location.reload()}>
          Retry
        </button>
      </main>
    );
  if (!document)
    return (
      <main className="key-ui-root key-pdf-loading" role="status">
        Opening PDF…
      </main>
    );
  return (
    <main className="key-ui-root key-pdf-reader">
      <section className="key-pdf-surface" ref={surface}>
        {/* One floating stack over the top of the page: the controls, Find, a search result. */}
        <div ref={chromeRef} className="key-pdf-chrome" data-hidden={chromeHidden || undefined}>
          <header className="key-pdf-toolbar" aria-label="PDF controls">
            <span className="key-pdf-page" aria-label={`Page ${page} of ${chrome?.pageCount || "…"}`}>
              {page}
              <span> / {chrome?.pageCount || "…"}</span>
            </span>
            <span className="key-pdf-toolbar-divider" aria-hidden="true" />
            <span className="key-pdf-seg">
              <button className="key-pdf-tool" aria-label="Zoom out" title="Zoom out (⌘−)" onClick={() => reader.current?.zoomOut()}>
                <Icon name="minus" />
              </button>
              <button className="key-pdf-tool key-pdf-zoom" title="Actual size (⌘0)" onClick={() => reader.current?.actualSize()}>
                {Math.round((chrome?.zoom ?? 1) * 100)}%
              </button>
              <button className="key-pdf-tool" aria-label="Zoom in" title="Zoom in (⌘+)" onClick={() => reader.current?.zoomIn()}>
                <Icon name="plus" />
              </button>
              <button className="key-pdf-tool" aria-label="Fit width" title="Fit width" onClick={() => reader.current?.fitWidth()}>
                <Icon name="fitWidth" />
              </button>
            </span>
            <span className="key-pdf-toolbar-divider" aria-hidden="true" />
            <span className="key-pdf-seg">
              <button
                className="key-pdf-tool"
                aria-label="Find"
                title="Find in this PDF (⌘F)"
                aria-pressed={showSearch}
                onClick={() => {
                  setShowSearch(!showSearch);
                  if (showSearch) closeSearch();
                }}
              >
                <Icon name="search" />
              </button>
              <button
                className="key-pdf-tool key-pdf-tool-label"
                aria-label="References"
                title="References cited in this PDF"
                aria-pressed={referencesShown}
                onClick={() => showPanel("references")}
              >
                <Icon name="book" />
                {chrome?.referenceCount ? <span className="key-pdf-count">{chrome.referenceCount}</span> : null}
              </button>
              {docks && (
                <button
                  className="key-pdf-tool"
                  aria-label="Details & notes"
                  aria-pressed={panelTab === "details"}
                  title="Show or hide this source’s details and note beside the PDF"
                  onClick={() => showPanel("details")}
                >
                  <Icon name="panelRight" filled={panelTab === "details"} />
                </button>
              )}
            </span>
          </header>
          {showSearch && (
            <form
              className="key-pdf-find"
              onSubmit={(event) => {
                event.preventDefault();
                reader.current?.nextSearchResult();
              }}
            >
              <Icon name="search" className="key-pdf-find-icon" />
              <input
                autoFocus
                spellCheck={false}
                aria-label="Find in PDF"
                placeholder="Find in this PDF"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  reader.current?.setSearchQuery(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeSearch();
                  }
                }}
              />
              <span role="status">
                {chrome?.searching
                  ? "Searching…"
                  : query
                    ? `${chrome?.searchCount ? chrome.activeSearchIndex + 1 : 0} of ${chrome?.searchCount ?? 0}`
                    : ""}
              </span>
              <button type="button" className="key-pdf-tool" aria-label="Previous match" title="Previous match (⇧⌘G)" onClick={() => reader.current?.previousSearchResult()}>
                <Icon name="chevronUp" />
              </button>
              <button type="submit" className="key-pdf-tool" aria-label="Next match" title="Next match (⌘G)">
                <Icon name="chevronDown" />
              </button>
              <button type="button" className="key-pdf-tool" aria-label="Close find" title="Close" onClick={closeSearch}>
                <Icon name="close" />
              </button>
            </form>
          )}
          {target && (
            <div className="key-pdf-result" role="toolbar" aria-label="Search result">
              {bridge().readerBack && (
                <button className="key-pdf-result-back" onClick={() => bridge().readerBack?.()} title="Back to the search results">
                  <Icon name="arrowLeft" />
                  <span>Back to search</span>
                </button>
              )}
              <span className="key-pdf-result-label" title={navigation.query}>
                {navigation.query ? <strong>“{navigation.query}”</strong> : <strong>Search passage</strong>}
                <span>p. {target.page + 1}</span>
              </span>
              {navigation.total > 0 && (
                <span className="key-pdf-result-steps">
                  <button aria-label="Previous result" title="Previous result" disabled={navigating || navigation.index <= 0} onClick={() => void navigate(-1)}>
                    <Icon name="chevronUp" />
                  </button>
                  <span className="key-pdf-result-count">
                    {navigation.index + 1} / {navigation.total}
                  </span>
                  <button
                    aria-label="Next result"
                    title="Next result"
                    disabled={navigating || navigation.index >= navigation.total - 1}
                    onClick={() => void navigate(1)}
                  >
                    <Icon name="chevronDown" />
                  </button>
                </span>
              )}
              {navigationError && <span role="alert" className="key-pdf-result-error">{navigationError}</span>}
              <button
                className="key-pdf-result-close"
                aria-label="Close search result"
                title="Close: keep the document, drop the highlight"
                onClick={() => {
                  setTarget(undefined);
                  reader.current?.closeSearch();
                  void bridge().readerDismiss?.();
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          )}
        </div>
        <WebPdfControl info={document.initial.web} />
        {notice && (
          <div className="key-pdf-notice" role="alert">
            {notice}
          </div>
        )}
        {toast && (
          <div className="key-pdf-toast" role="status">
            <Icon name="check" />
            {toast}
          </div>
        )}
        <PdfJsBenchmarkApp
          ref={reader}
          embedded
          topInset={CHROME_INSET}
          initialFile={document.file}
          paneTitle={document.initial.source.title}
          initialViewState={document.initial.viewState}
          searchTarget={target}
          onViewStateChange={viewChanged}
          onChromeStateChange={setChrome}
          renderRail={renderRail}
          onRequestControlMode={(mode) => {
            setShowSearch(mode === "search");
          }}
          references={
            report?.references.length || ["done", "none", "failed"].includes(report?.analysis?.referencesStatus ?? "")
              ? report!.references
                  .filter((r) => r.number != null && r.page != null)
                  .map((r) => ({
                    number: r.number!,
                    page: r.page!,
                    xFraction: r.rects?.[0] ? r.rects[0][0] / 65535 : undefined,
                    yFraction: r.rects?.[0] ? r.rects[0][1] / 65535 : undefined,
                    text: r.text,
                  }))
              : undefined
          }
          referencesHeader={bridge().readerAnalysis ? <AnalysisStatus report={report} onRerun={rerun} /> : undefined}
          referenceAside={(reference) => (
            <ReferenceAside
              known={report?.references.find((r) => r.number === reference.number)}
              works={libraryWorks}
              onOpen={(id) => void bridge().readerOpenSource?.(id)}
            />
          )}
          libraryWorks={libraryWorks}
          highlightUsage={usage}
          referenceInLibrary={(number) => {
            const id = report?.references.find((r) => r.number === number)?.matchedSourceId;
            return id && bridge().readerOpenSource ? () => void bridge().readerOpenSource?.(id) : null;
          }}
          onCite={bridge().invoke ? (passage) => void cite(passage) : undefined}
          onAddToNote={
            bridge().readerAddToNote
              ? (passage) =>
                  void bridge()
                    .readerAddToNote?.(passage)
                    .then(() => setPanelTab("details"))
                    .catch((e) => {
                      setNotice(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ""));
                      setTimeout(() => setNotice(""), 4000);
                    })
              : undefined
          }
        />
      </section>
    </main>
  );
}
