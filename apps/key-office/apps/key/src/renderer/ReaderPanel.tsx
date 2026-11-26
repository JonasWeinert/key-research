import { useCallback, useEffect, useState, type ReactElement } from "react";
import { SidePanel } from "@key-reader/ui/SidePanel";
import { ReferenceList } from "@key-reader/pdfjs/ReferenceList";
import { Icon } from "./icons";
import { AnalysisStatus, working, type AnalysisReport } from "./reader-analysis";
import "./reader-panel.css";

type Invoke = <T>(command: string, args?: Record<string, unknown>, workspaceId?: string) => Promise<T>;
const shellApi = () =>
  (window as unknown as { key: { invoke: Invoke; tabAction(action: string, payload?: unknown): Promise<unknown> } }).key;

export type ReaderPanelTab = "details" | "references";

/** The reader's panel beside a PDF in its tab: the source's details and note, and the PDF's
 *  references, switched in the header. `readerId` is the PDF's view (`pdf:<workspace>:<hash>`). */
export function ReaderPanel({
  readerId,
  tab,
  details,
  onTab,
  onPopOut,
  onClose,
}: {
  readerId: string;
  tab: ReaderPanelTab;
  details: ReactElement;
  onTab: (tab: ReaderPanelTab) => void;
  onPopOut: () => void;
  onClose: () => void;
}) {
  const [, workspaceId, documentHash] = readerId.split(":");
  const [count, setCount] = useState<number>();
  return (
    <SidePanel
      label="Details and references"
      className="key-reader-panel"
      active={tab}
      onActiveChange={(id) => onTab(id as ReaderPanelTab)}
      sections={[
        { id: "details", title: "Details", render: () => <>{details}</>, keepMounted: true },
        {
          id: "references",
          title: "References",
          badge: count || undefined,
          render: () => <ReaderReferences workspaceId={workspaceId} documentHash={documentHash} onCount={setCount} />,
        },
      ]}
      actions={
        <>
          {tab === "details" && (
            <button type="button" title="Open in its own tab" aria-label="Open details and notes in their own tab" onClick={onPopOut}>
              <Icon name="detach" size={14} />
            </button>
          )}
          <button type="button" title="Hide the panel" aria-label="Hide details and references" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </>
      }
    />
  );
}

/** The library's analysis of the PDF: its status (and Re-run), then the references; one
 *  takes the reader there. */
function ReaderReferences({ workspaceId, documentHash, onCount }: { workspaceId: string; documentHash: string; onCount: (n: number) => void }) {
  const [report, setReport] = useState<AnalysisReport | null>();
  const [sourceId, setSourceId] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const found = await shellApi().invoke<{ items: { id: string }[] }>("store_sources", { ids: [documentHash], limit: 1, scope: "all" }, workspaceId);
      const id = found.items[0]?.id;
      setSourceId(id);
      setReport(id ? await shellApi().invoke<AnalysisReport>("store_analysis", { id }, workspaceId) : null);
    } catch {
      setReport(null);
    }
  }, [workspaceId, documentHash]);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    if (!working(report)) return;
    const timer = setTimeout(() => void refresh(), 2000);
    return () => clearTimeout(timer);
  }, [report, refresh]);
  const references = report
    ? report.references
        .filter((r) => r.number != null && r.page != null)
        .map((r) => ({ ...r, number: r.number!, page: r.page!, yFraction: r.rects?.[0] ? r.rects[0][1] / 65535 : undefined }))
    : report === null
      ? []
      : undefined;
  useEffect(() => onCount(references?.length ?? 0), [references?.length, onCount]);
  const done = !report || ["done", "none", "failed"].includes(report.analysis?.referencesStatus ?? "");
  return (
    <ReferenceList
      header={
        <AnalysisStatus
          report={report}
          onRerun={() => {
            if (!sourceId) return;
            setReport((r) => (r ? { ...r, analysis: null, references: [], indexStatus: "pending" } : r));
            void shellApi()
              .invoke("store_reanalyze", { id: sourceId }, workspaceId)
              .then(refresh);
          }}
        />
      }
      references={references?.length || done ? references : undefined}
      onSelect={(reference) =>
        void shellApi().tabAction("reader-focus", { workspaceId, documentHash, page: reference.page, top: reference.yFraction })
      }
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
              <button
                type="button"
                onClick={() => void shellApi().tabAction("open-source-page", { workspaceId, sourceId: reference.matchedSourceId })}
              >
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
