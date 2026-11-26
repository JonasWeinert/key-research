// The panel beside a saved web page in its tab, as the PDF reader's (ReaderPanel): the
// source's details and note, the page's highlights, and the references read from it.
import { useEffect, useState, type ReactElement } from "react";
import { SidePanel } from "@key-reader/ui/SidePanel";
import { ReferenceList } from "@key-reader/pdfjs/ReferenceList";
import { Icon } from "./icons";
import { bridge, type Invoke } from "./library-api";
import { AnalysisStatus } from "./reader-analysis";
import { PAGE_RGB, type WebAnnotation } from "./WebPageReader";
import { AnnotationText } from "./annotation-text";
import { focusWebPage, toggleWebPanel, webPageEvent, webPanelStatusItems, WEB_REANALYZE_EVENT, WEB_REFERENCE_EVENT } from "./web-page-open";
import { useStatusItems } from "./status-bar";
import { useWebAnalysis } from "./web-reader-references";
import "./reader-panel.css";
import "./web-page.css";
import "./web-reader-panel.css";

export type WebPanelTab = "details" | "highlights" | "references";

export function WebReaderPanel({
  invoke,
  viewId,
  readerId,
  workspaceId,
  sourceId,
  tab,
  details,
  onTab,
  onPopOut,
  onClose,
}: {
  invoke: Invoke;
  /** The panel's own view, and the reader it is docked beside. */
  viewId: string;
  readerId: string;
  workspaceId: string;
  sourceId: string;
  tab: WebPanelTab;
  details: ReactElement;
  onTab: (tab: WebPanelTab) => void;
  onPopOut: () => void;
  onClose: () => void;
}) {
  const [highlights, setHighlights] = useState<number>();
  const [report] = useWebAnalysis(invoke, workspaceId, sourceId);
  const count = report?.references.length;
  // With focus in the panel, the status bar keeps the reader's switch.
  useStatusItems(viewId, webPanelStatusItems(tab), (id) => void toggleWebPanel(readerId, id));
  return (
    <SidePanel
      label="Details, highlights and references"
      className="key-reader-panel kx-web-panel"
      active={tab}
      onActiveChange={(id) => onTab(id as WebPanelTab)}
      sections={[
        { id: "details", title: "Details", render: () => <>{details}</>, keepMounted: true },
        {
          id: "highlights",
          title: "Highlights",
          badge: highlights || undefined,
          render: () => <WebHighlights invoke={invoke} workspaceId={workspaceId} sourceId={sourceId} onCount={setHighlights} />,
          keepMounted: true,
        },
        {
          id: "references",
          title: "References",
          badge: count || undefined,
          render: () => <WebReferences invoke={invoke} workspaceId={workspaceId} sourceId={sourceId} />,
        },
      ]}
      actions={
        <>
          {tab === "details" && (
            <button type="button" title="Open in its own tab" aria-label="Open details and notes in their own tab" onClick={onPopOut}>
              <Icon name="detach" size={14} />
            </button>
          )}
          <button type="button" title="Hide the panel" aria-label="Hide details, highlights and references" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </>
      }
    />
  );
}

const formatDate = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const position = (a: WebAnnotation) => (a.anchor.selectors.find((s) => s.type === "TextPositionSelector") as { start: number } | undefined)?.start ?? Infinity;

/** The page's highlights in reading order; one shows it on the page. */
function WebHighlights({ invoke, workspaceId, sourceId, onCount }: { invoke: Invoke; workspaceId: string; sourceId: string; onCount: (n: number) => void }) {
  const [list, setList] = useState<WebAnnotation[]>();
  useEffect(() => {
    const load = () =>
      invoke<WebAnnotation[]>("library_annotations", { hash: sourceId }, workspaceId)
        .then((all) => setList(all.filter((a) => a?.anchor?.kind === "web").sort((x, y) => position(x) - position(y))))
        .catch(() => setList([]));
    void load();
    return bridge().on("annotations-changed", () => void load());
  }, [invoke, workspaceId, sourceId]);
  useEffect(() => onCount(list?.length ?? 0), [list?.length, onCount]);
  if (!list) return null;
  return (
    <div className="kx-web-reader-panel kx-web-highlights" aria-label="Highlights">
      {list.length === 0 ? (
        <p className="kx-web-reader-empty">Select text on the page to highlight it, add a comment or cite it in a note.</p>
      ) : (
        <ul>
          {list.map((a) => (
            <li key={a.id} data-color={a.color}>
              <button type="button" onClick={() => focusWebPage(sourceId, { annotationId: a.id })} title="Show on the page">
                <AnnotationText text={a.text} comment={a.comment} color={`rgb(${PAGE_RGB[a.color]})`} />
                <footer>{formatDate(a.updatedAt || a.createdAt)}</footer>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The references read from the page and what the library found for each; one takes the
 *  reader to it in the page's list. */
function WebReferences({ invoke, workspaceId, sourceId }: { invoke: Invoke; workspaceId: string; sourceId: string }) {
  const [report, refresh] = useWebAnalysis(invoke, workspaceId, sourceId);
  const references = report ? report.references.map((r, i) => ({ ...r, number: r.number ?? i + 1, page: undefined })) : report === null ? [] : undefined;
  return (
    <ReferenceList
      header={
        <AnalysisStatus
          subject="page"
          report={report}
          onRerun={() => {
            webPageEvent(WEB_REANALYZE_EVENT, { sourceId });
            setTimeout(() => void refresh(), 400);
          }}
        />
      }
      references={references}
      empty={<p className="key-ref-empty">No reference list was found on this page.</p>}
      onSelect={(reference) => webPageEvent(WEB_REFERENCE_EVENT, { sourceId, number: reference.number })}
      aside={(reference) => {
        const meta = reference.metadata;
        if (!meta?.title && !reference.matchedSourceId) return null;
        return (
          <div className="key-pdf-reference-aside">
            {meta?.title && (
              <span title={meta.doi ? `doi:${meta.doi}` : undefined}>
                {meta.title}
                {meta.year ? ` (${meta.year})` : ""}
              </span>
            )}
            {reference.matchedSourceId && (
              <button type="button" onClick={() => void bridge().tabAction("open-source-page", { workspaceId, sourceId: reference.matchedSourceId })}>
                In your library
                <Icon name="arrowRight" size={11} />
              </button>
            )}
          </div>
        );
      }}
    />
  );
}
