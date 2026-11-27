// A systematic review's tab: its name, who is screening, the stages as a bar (Overview · Setup ·
// Sources · Title & abstract · Full text · Extraction · Analysis) with live counts, and the
// stage. Everything it shows comes from the review host (review-api.ts); every change goes
// back as an event and the summary reloads.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SegmentedTabs } from "@key-reader/ui/SegmentedTabs";
import { downloadText } from "../db-ui";
import { Explain } from "../explain";
import { Icon } from "../icons";
import { bridge, type Invoke } from "../library-api";
import { reviewApi, savedViewer, saveViewer, type Summary } from "./review-api";
import { Confirm, MenuButton, errorText, useLoad, useNotice } from "./review-ui";
import { Overview } from "./review-overview";
import { Setup } from "./review-setup";
import { Sources } from "./review-sources";
import { Screening } from "./review-screen";
import { Extraction } from "./review-extract";
import { AnalysisView } from "./review-analysis";
// std-C: risk of bias and certainty of evidence.
import { RiskOfBias } from "./review-rob";
import { Certainty } from "./review-grade";
// end std-C
import "./review.css";
// std-A
import { setFocus } from "./review-reporting-api";

export type StageId = "overview" | "setup" | "sources" | "ta" | "ft" | "extract" | "analysis" | /* std-C */ "rob" | "certainty";
const stageKey = (id: string) => `key.review.stage:${id}`;

export interface StageProps {
  api: ReturnType<typeof reviewApi>;
  summary: Summary;
  viewer: string;
  invoke: Invoke;
  workspaceId: string;
  reviewId: string;
  active: boolean;
  onChanged: () => void;
  notify: (text: string, tone?: "error" | "ok", action?: { label: string; run: () => void }) => void;
  go: (stage: StageId) => void;
}

export default function ReviewPage({ invoke, workspaceId, reviewId, viewId, active }: { invoke: Invoke; workspaceId: string; reviewId: string; viewId: string; active: boolean }) {
  const api = useMemo(() => reviewApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const [viewer, setViewerState] = useState(() => savedViewer(reviewId) ?? "");
  const { value: summary, error, reload } = useLoad(() => api.summary(viewer), [api, viewer]);
  const [stage, setStageState] = useState<StageId>(() => {
    try {
      return (localStorage.getItem(stageKey(reviewId)) as StageId) || "overview";
    } catch {
      return "overview";
    }
  });
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // std-A: opening a view of the stage already shown (the PRISMA checklist from the menu).
  const [opened, setOpened] = useState(0);
  const { show, view: notice, clear } = useNotice();
  const setStage = useCallback(
    (s: StageId) => {
      setStageState(s);
      clear();
      try {
        localStorage.setItem(stageKey(reviewId), s);
      } catch {}
    },
    [reviewId, clear],
  );
  const setViewer = (id: string) => {
    saveViewer(reviewId, id);
    setViewerState(id);
  };
  // Who screens: the saved profile, else the review's first owner.
  useEffect(() => {
    if (!summary) return;
    if (!viewer || !summary.team.some((m) => m.id === viewer)) {
      const first = summary.team.find((m) => m.roles.includes("owner")) ?? summary.team[0];
      if (first) setViewer(first.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.team]);
  // Changes made elsewhere (another window, an imported review file) show here too: the main
  // process tells every window when a review command changed something; the stamp says whether
  // this tab has seen it already.
  const seen = summary?.events;
  const seenRef = useRef(seen);
  seenRef.current = seen;
  useEffect(() => {
    const check = () =>
      void invoke<{ events: number }>("review_stamp", { reviewId }, workspaceId)
        .then((s) => seenRef.current !== undefined && s.events !== seenRef.current && reload())
        .catch(() => {});
    const off = bridge().on?.("review-changed", (v) => {
      const id = (v as { reviewId?: string } | undefined)?.reviewId;
      if (!id || id === reviewId) check();
    });
    // A tab coming back into view catches up too.
    if (active) check();
    return () => off?.();
  }, [active, invoke, reviewId, workspaceId, reload]);
  // The tab shows the review's name.
  useEffect(() => {
    if (summary?.review.name) void (window as any).key?.tabAction?.("content-title", { viewId, title: summary.review.name });
  }, [summary?.review.name, viewId]);

  if (error && !summary) return <div className="kx-rv-page kx-rv-missing"><p className="kx-inline-error">{error}</p></div>;
  if (!summary) return <div className="kx-rv-page" aria-busy="true" />;

  const ta = summary.stages.ta;
  const ft = summary.stages.ft;
  const remaining = (n: number) => (n > 0 ? n.toLocaleString() : undefined);
  const tabs: { id: StageId; label: string; badge?: string; title?: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "setup", label: "Setup", title: `Protocol version ${summary.versionNumber}` },
    { id: "sources", label: "Sources", badge: summary.active ? summary.active.toLocaleString() : undefined, title: `${summary.active} records after removing duplicates` },
    { id: "ta", label: "Title & abstract", badge: remaining(ta.mine + ta.conflicts * Number(summary.canResolve)), title: `${ta.mine} waiting for you, ${ta.conflicts} conflicts` },
    { id: "ft", label: "Full text", badge: remaining(ft.mine + ft.conflicts * Number(summary.canResolve)), title: `${ft.mine} waiting for you, ${ft.conflicts} conflicts` },
    { id: "extract", label: "Extraction", badge: summary.included ? `${summary.extraction.mine}/${summary.included}` : undefined, title: `${summary.included} included studies` },
    { id: "analysis", label: "Analysis" },
  ];
  // std-C: Risk of bias before Analysis, Certainty after it.
  tabs.splice(tabs.findIndex((t) => t.id === "analysis"), 0, { id: "rob", label: "Risk of bias", title: "Risk of bias of the included studies and their results" });
  tabs.splice(tabs.findIndex((t) => t.id === "analysis") + 1, 0, { id: "certainty", label: "Certainty", title: "Certainty of the evidence (GRADE) and the Summary of findings" });
  // end std-C
  const props: StageProps = { api, summary, viewer, invoke, workspaceId, reviewId, active, onChanged: reload, notify: show, go: setStage };
  const exportFile = (kind: string) =>
    api
      .exportFile(kind, viewer)
      .then((f) => downloadText(f.filename, f.content, f.mime))
      .catch((e) => show(errorText(e), "error"));
  return (
    <div className="kx-rv-page" data-stage={stage}>
      <header className="kx-rv-head">
        <div className="kx-rv-title">
          <Icon name="checklist" size={18} />
          {renaming ? (
            <input
              className="kx-rv-title-input"
              autoFocus
              defaultValue={summary.review.name}
              aria-label="Review name"
              onBlur={(e) => {
                setRenaming(false);
                const name = e.currentTarget.value.trim();
                if (name && name !== summary.review.name) void api.rename(name, viewer).then(reload).catch((err) => show(errorText(err), "error"));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <h1 onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
              {summary.review.name}
            </h1>
          )}
          {summary.review.archived && <span className="kx-rv-pill" data-tone="muted">Archived</span>}
        </div>
        <div className="kx-rv-head-tools">
          <label className="kx-rv-viewer" title="Decisions are recorded under this person. Add people in Setup › Team.">
            <span>Screening as</span>
            <select value={viewer} onChange={(e) => setViewer(e.target.value)} aria-label="Screening as">
              {summary.team.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <Explain help="review.what" />
          <MenuButton
            label="Review actions"
            items={[
              { label: "Rename…", icon: "pen", run: () => setRenaming(true) },
              null,
              { label: "Export review file…", icon: "download", run: () => void exportFile("review") },
              { label: "Export screening decisions (CSV)", icon: "table", run: () => void exportFile("screening") },
              { label: "Export audit trail (CSV)", icon: "clock", run: () => void exportFile("audit") },
              { label: "Save protocol as template…", icon: "copy", run: () => void exportFile("template") },
              // std-A: reporting
              null,
              { label: "PRISMA checklist…", icon: "checklist", run: () => (setFocus(reviewId, "checklist"), setOpened((n) => n + 1), setStage("overview")) },
              { label: "Export PRISMA checklist (Markdown)", icon: "fileMarkdown", run: () => void exportFile("prisma-checklist") },
              { label: "Export methods draft (Markdown)", icon: "doc", run: () => void exportFile("methods-draft") },
              { label: "Export protocol (PRISMA-P)", icon: "fileMarkdown", run: () => void exportFile("protocol") },
              { label: "Export search report (PRISMA-S)", icon: "fileMarkdown", run: () => void exportFile("search-report") },
              null,
              { label: summary.review.archived ? "Restore review" : "Archive review", icon: "disk", run: () => void api.archive(!summary.review.archived, viewer).then(reload) },
              { label: "Delete review…", icon: "trash", danger: true, run: () => setDeleting(true) },
            ]}
          />
        </div>
      </header>
      <SegmentedTabs className="kx-rv-stages" label="Review stages" value={stage} onChange={setStage} minTabWidth={92} tabs={tabs} />
      <main className="kx-rv-body" key={`${stage}:${opened}`}>
        {stage === "overview" && <Overview {...props} />}
        {stage === "setup" && <Setup {...props} />}
        {stage === "sources" && <Sources {...props} />}
        {(stage === "ta" || stage === "ft") && <Screening {...props} stage={stage} />}
        {stage === "extract" && <Extraction {...props} />}
        {stage === "analysis" && <AnalysisView {...props} />}
        {/* std-C */}
        {stage === "rob" && <RiskOfBias {...props} />}
        {stage === "certainty" && <Certainty {...props} />}
      </main>
      {notice}
      {deleting && (
        <Confirm
          title={`Delete “${summary.review.name}”?`}
          body={<p>Every decision, note, extracted value and the audit trail of this review are deleted from this Mac. This cannot be undone. Export the review file first to keep a copy. Library sources stay.</p>}
          confirm="Delete review"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={() => api.remove().then(() => (window as any).key?.tabAction?.("close-view", { viewId }))}
        />
      )}
    </div>
  );
}
