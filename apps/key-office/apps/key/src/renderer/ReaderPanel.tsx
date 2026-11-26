import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { SidePanel } from "@key-reader/ui/SidePanel";
import { ReferenceList } from "@key-reader/pdfjs/ReferenceList";
import { Icon } from "./icons";
import { AnalysisStatus, working, type AnalysisReport } from "./reader-analysis";
import { readerLibraryWorks } from "./reader-library-works";
import { addFromSource } from "./add-from-source";
import { ReferenceAside } from "./ReferenceAside";
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
  const [collections, setCollections] = useState<string[]>([]);
  const refresh = useCallback(async () => {
    try {
      const found = await shellApi().invoke<{ items: { id: string; collections?: string[] }[] }>("store_sources", { ids: [documentHash], limit: 1, scope: "all" }, workspaceId);
      const id = found.items[0]?.id;
      setSourceId(id);
      setCollections(found.items[0]?.collections ?? []);
      setReport(id ? await shellApi().invoke<AnalysisReport>("store_analysis", { id }, workspaceId) : null);
    } catch {
      setReport(null);
    }
  }, [workspaceId, documentHash]);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    if (!working(report)) return;
    const timer = setTimeout(() => void refresh(), 1000);
    return () => clearTimeout(timer);
  }, [report, refresh]);
  const open = useCallback(
    (id: string) => void shellApi().tabAction("open-source-page", { workspaceId, sourceId: id }),
    [workspaceId],
  );
  // Add to library beside this PDF, in its collections (read when adding).
  const collectionsRef = useLatest(collections);
  const sourceIdRef = useLatest(sourceId);
  const works = useMemo(
    () =>
      readerLibraryWorks({
        invoke: <T,>(command: string, args?: Record<string, unknown>) => shellApi().invoke<T>(command, args, workspaceId),
        open,
        collections: async () => collectionsRef.current,
        addFrom: (work) => addFromSource((command, args, ws) => shellApi().invoke(command, args, ws ?? workspaceId), { workspaceId, sourceId: sourceIdRef.current ?? null }, work),
      }),
    [workspaceId, open, collectionsRef, sourceIdRef],
  );
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
      aside={(reference) => <ReferenceAside known={reference} works={sourceId ? works : undefined} onOpen={open} />}
    />
  );
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
