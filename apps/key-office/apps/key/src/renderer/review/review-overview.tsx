// Overview: what to do next, progress per stage, and the PRISMA 2020 flow diagram from the
// review's real numbers (exportable as SVG, PNG or the numbers as CSV).
import { useRef, useState } from "react";
import { downloadText } from "../db-ui";
import { Explain } from "../explain";
import { Icon, type IconName } from "../icons";
import { pngBlob, saveFile, svgMarkup } from "../charts/export";
import { plural, type Summary } from "./review-api";
import { PrismaDiagram } from "./prisma-diagram";
import { Btn, Confirm, MenuButton, errorText, useLoad } from "./review-ui";
import { OriginSheet } from "./review-sources";
import type { StageId, StageProps } from "./ReviewPage";
// std-B
import { ConductPanel } from "./review-conduct";
// std-A: Overview's reporting views (PRISMA checklist, search report)
import { ChecklistPage, type OverviewView } from "./review-checklist";
import { SearchReportPage } from "./review-search-report";
import { takeFocus } from "./review-reporting-api";

function nextStep(s: Summary, viewer: string): { title: string; body: string; action: string; stage: StageId; icon: IconName } {
  const ta = s.stages.ta,
    ft = s.stages.ft;
  if (!s.records) return { title: "Add the records you found", body: "Import the files your database searches exported, run a Database search, or add records from your library.", action: "Add records", stage: "sources", icon: "upload" };
  if (s.openPairs) return { title: `Check ${plural(s.openPairs, "possible duplicate")}`, body: "Exact duplicates were removed. These look alike but differ slightly: keep one, or keep both.", action: "Check duplicates", stage: "sources", icon: "copy" };
  if (!s.protocol.criteria.length && ta.done === 0)
    return { title: "Choose the criteria", body: "Rules a study must meet, grouped by your question. Start from the suggestions in one click; excluding names the one a study does not meet.", action: "Set the criteria", stage: "setup", icon: "checklist" };
  if (s.pilots.some((p) => p.pilot.open && p.pilot.reviewers.includes(viewer) && p.done < p.pilot.records.length))
    return { title: "Screen the pilot round", body: "Every reviewer screens the same sample first, so the team can compare decisions and sharpen the criteria.", action: "Start screening", stage: "ta", icon: "checklist" };
  if (ta.mine) return { title: `Screen ${plural(ta.mine, "title")}`, body: "Include, exclude or keep as maybe from the title and abstract. Press I, E or M; the next record follows.", action: "Screen titles and abstracts", stage: "ta", icon: "checklist" };
  if (ta.conflicts && s.canResolve) return { title: `Resolve ${plural(ta.conflicts, "conflict")}`, body: "Reviewers disagree on these records. Discuss them, then record the decision.", action: "Resolve conflicts", stage: "ta", icon: "warning" };
  if (ft.mine) return { title: `Assess ${plural(ft.mine, "full text")}`, body: "Read each report beside its decision panel: include it, or exclude it with the criterion it fails.", action: "Screen full texts", stage: "ft", icon: "filePdf" };
  if (ft.conflicts && s.canResolve) return { title: `Resolve ${plural(ft.conflicts, "full-text conflict")}`, body: "Reviewers disagree on these reports.", action: "Resolve conflicts", stage: "ft", icon: "warning" };
  if (s.included && s.extraction.mine < s.included) return { title: `Extract data from ${plural(s.included - s.extraction.mine, "study", "studies")}`, body: "Fill in the forms for each included study, with a quote from the paper for each value.", action: "Extract data", stage: "extract", icon: "table" };
  if (s.included) return { title: "Analyse the outcomes", body: "Pool the extracted outcome data and look at the forest and funnel plots.", action: "Open analysis", stage: "analysis", icon: "activity" };
  if (ta.partial || ft.partial) return { title: "Waiting for other reviewers", body: `${plural(ta.partial + ft.partial, "record")} need another reviewer's decision.`, action: "See the list", stage: ta.partial ? "ta" : "ft", icon: "clock" };
  return { title: "Set the criteria", body: "Write the rules a study must meet, so everyone screens the same way. Excluding names the one a study does not meet.", action: "Open setup", stage: "setup", icon: "gear" };
}

function StageBar({ label, done, total, parts, onClick }: { label: string; done: number; total: number; parts: [number, string][]; onClick: () => void }) {
  return (
    <button type="button" className="kx-rv-stage-bar" onClick={onClick}>
      <span className="kx-rv-stage-bar-label">
        <strong>{label}</strong>
        <span className="kx-rv-muted">{total ? `${done.toLocaleString()} of ${total.toLocaleString()}` : "Nothing yet"}</span>
      </span>
      <span className="kx-rv-progress-bar" aria-hidden="true">
        {parts.map(([v, tone], i) => (
          <span key={i} data-tone={tone} style={{ width: `${total ? (v / total) * 100 : 0}%` }} />
        ))}
      </span>
    </button>
  );
}

// std-A: Overview shows the flow and progress, the PRISMA checklist or the search report.
const OVERVIEW_FOCUS = ["flow", "checklist", "search", "checklist:abstract", "checklist:prismas"] as const;
export function Overview(props: StageProps) {
  const [focus] = useState(() => takeFocus(props.reviewId, OVERVIEW_FOCUS));
  const [view, setView] = useState<OverviewView>(() => (focus?.startsWith("checklist") ? "checklist" : ((focus as OverviewView) ?? "flow")));
  const [list, setList] = useState(focus?.startsWith("checklist:") ? focus.slice(10) : undefined);
  const show = (v: string) => {
    if (v.startsWith("checklist:")) setList(v.slice(10));
    setView((v.startsWith("checklist") ? "checklist" : v) as OverviewView);
  };
  return (
    <div className="kx-rp-overview" data-view={view}>
      <div className="kx-rv-toolbar">
        <div className="kx-rv-seg" role="radiogroup" aria-label="Overview view">
          {(
            [
              ["flow", "Progress & flow"],
              ["checklist", "PRISMA checklist"],
              ["search", "Search report"],
            ] as [OverviewView, string][]
          ).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={view === id} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {view === "flow" && <FlowOverview {...props} />}
      {view === "checklist" && <ChecklistPage key={list} {...props} initialList={list} onView={show} />}
      {view === "search" && <SearchReportPage {...props} onView={show} />}
    </div>
  );
}

function FlowOverview(props: StageProps) {
  const { summary, api, viewer, go, notify } = props;
  const prisma = useLoad(() => api.prisma(), [api, summary.events]);
  const svg = useRef<SVGSVGElement>(null);
  // The figure for publication: drawn without the work-in-progress lines, off screen.
  const finalSvg = useRef<SVGSVGElement>(null);
  const [unfinished, setUnfinished] = useState<() => void>();
  const [fixing, setFixing] = useState(false);
  const publish = (run: () => void) => (prisma.value && !prisma.value.complete ? setUnfinished(() => run) : run());
  const p = prisma.value;
  const step = nextStep(summary, viewer);
  const ta = summary.stages.ta,
    ft = summary.stages.ft;
  const base = summary.review.name.replace(/[^\w]+/g, "-").toLowerCase() || "review";
  return (
    <div className="kx-rv-overview">
      <div className="kx-rv-overview-side">
        <section className="kx-rv-next">
          <span className="kx-rv-next-icon" aria-hidden="true">
            <Icon name={step.icon} size={18} />
          </span>
          <div>
            <h2>{step.title}</h2>
            <p>{step.body}</p>
            <Btn primary onClick={() => go(step.stage)}>
              {step.action}
            </Btn>
          </div>
        </section>
        <section className="kx-rv-section">
          <div className="kx-rv-section-head">
            <h2>Progress</h2>
            <Explain help="review.what" />
          </div>
          <StageBar label="Title & abstract" done={ta.done} total={ta.eligible} parts={[[ta.included, "green"], [ta.maybe, "amber"], [ta.excluded, "red"]]} onClick={() => go("ta")} />
          <StageBar label="Full text" done={ft.done} total={ft.eligible} parts={[[ft.included, "green"], [ft.excluded, "red"]]} onClick={() => go("ft")} />
          <StageBar label="Extraction" done={summary.extraction.started} total={summary.included} parts={[[summary.extraction.started, "accent"]]} onClick={() => go("extract")} />
          <dl className="kx-rv-facts">
            <div>
              <dt>Protocol</dt>
              <dd>
                Version {summary.versionNumber} · {plural(summary.protocol.criteria.length, "criterion", "criteria")}
              </dd>
            </div>
            <div>
              <dt>Team</dt>
              <dd>{summary.team.map((m) => m.name).join(", ")}</dd>
            </div>
            <div>
              <dt>Rules</dt>
              <dd>
                {summary.protocol.rules.ta.reviewers === 1 ? "One reviewer" : `${summary.protocol.rules.ta.reviewers} reviewers`} per record{summary.protocol.rules.blind && summary.protocol.rules.ta.reviewers > 1 ? ", blind" : ""}
              </dd>
            </div>
            {ta.conflicts + ft.conflicts > 0 && (
              <div>
                <dt>Conflicts</dt>
                <dd>{plural(ta.conflicts + ft.conflicts, "record")}</dd>
              </div>
            )}
          </dl>
        </section>
        {/* std-B: soft conduct warnings and AI use */}
        <ConductPanel {...props} />
      </div>
      <section className="kx-rv-section kx-rv-prisma-card">
        <div className="kx-rv-section-head">
          <h2>PRISMA 2020 flow</h2>
          <Explain help="review.prisma" />
          <MenuButton
            label="Export the flow diagram"
            icon="download"
            items={[
              { label: "SVG image", run: () => publish(() => finalSvg.current && saveFile(`${base}-prisma.svg`, svgMarkup(finalSvg.current))) },
              { label: "PNG image", run: () => publish(() => finalSvg.current && void pngBlob(finalSvg.current, 3).then((b) => saveFile(`${base}-prisma.png`, b)).catch((e) => notify(errorText(e), "error"))) },
              { label: "Numbers (CSV)", run: () => publish(() => void api.exportFile("prisma", viewer).then((f) => downloadText(f.filename, f.content, f.mime))) },
            ]}
          />
        </div>
        {summary.originsToCheck?.length > 0 && (
          <div className="kx-rv-missing-bar kx-rv-origin-bar" role="status">
            <span>
              {summary.originsToCheck.map((o) => (
                <span key={o.batchId} className="kx-rv-origin-line">
                  <strong>{plural(o.records, "record")}</strong> counted as “{o.name}”. {o.why}.
                </span>
              ))}
            </span>
            <Btn small primary onClick={() => setFixing(true)}>
              Where did these come from?
            </Btn>
          </div>
        )}
        {p ? <PrismaDiagram ref={svg} p={p} /> : <div className="kx-rv-loading" aria-busy="true" />}
        {p && !p.complete && (
          <p className="kx-rv-muted kx-rv-prisma-wip">
            Under way: {[p.screeningPending && `${p.screeningPending.toLocaleString()} still to screen`, p.main.pending && `${p.main.pending.toLocaleString()} still to assess`].filter(Boolean).join(", ")}. These lines disappear when screening is done and are never in the exported figure.
          </p>
        )}
        {p && (
          <div className="kx-rv-offscreen" aria-hidden="true">
            <PrismaDiagram ref={finalSvg} p={p} final />
          </div>
        )}
      </section>
      {unfinished && (
        <Confirm
          title="Screening is not finished"
          body={
            <p>
              {p?.screeningPending ? `${plural(p.screeningPending, "record")} still to screen` : ""}
              {p?.screeningPending && p?.main.pending ? " and " : ""}
              {p?.main.pending ? `${plural(p.main.pending, "report")} still to assess` : ""}. The figure would show numbers that will change. Export it anyway (without the “still to” lines)?
            </p>
          }
          confirm="Export anyway"
          onClose={() => setUnfinished(undefined)}
          onConfirm={() => {
            unfinished();
            setUnfinished(undefined);
          }}
        />
      )}
      {fixing && <OriginSheet {...props} batchId={summary.originsToCheck[0]?.batchId} onClose={() => setFixing(false)} />}
    </div>
  );
}
