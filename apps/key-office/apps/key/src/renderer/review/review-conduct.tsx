// Overview's quiet panels (std-B): Conduct, soft warnings from the review's state against the
// conduct standards (Cochrane MECIR, Campbell, MAER-Net; paraphrased, linked), each dismissible
// with a recorded reason; and AI use, shown once AI made suggestions: the log, human–AI
// agreement, the blind audit sample and the statement for the manuscript. Rust decides
// everything (key-review conduct.rs, ai_audit.rs); this file draws it.
import { useMemo, useState } from "react";
import { downloadText } from "../db-ui";
import { Explain } from "../explain";
import { GlobalDrawer, GlobalDialog } from "../GlobalDrawer";
import { Icon } from "../icons";
import { plural, STAGE_LABEL, type Stage } from "./review-api";
import { conductApi, fixed, percent, type AiUse, type Confusion, type Warning } from "./review-conduct-api";
import { Btn, Segmented, errorText, formatDate, useLoad } from "./review-ui";
import type { StageProps } from "./ReviewPage";
import "./review-std-b.css";

/** One-shot hints for where a panel's button leads (a Sources view, a sheet in Extraction). */
let pending: { sourcesView?: string; extract?: string } = {};
export const takeSourcesView = () => {
  const v = pending.sourcesView;
  pending.sourcesView = undefined;
  return v;
};
export const takeExtractSheet = () => {
  const v = pending.extract;
  pending.extract = undefined;
  return v;
};

const TYPE_LABEL: Record<string, string> = { systematic: "systematic review", scoping: "scoping review", rapid: "rapid review", living: "living review" };

export function ConductPanel(props: StageProps) {
  const { invoke, workspaceId, reviewId, viewer, notify, onChanged, go, summary } = props;
  const api = useMemo(() => conductApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const conduct = useLoad(() => api.conduct(), [api, summary.events]);
  const [dismissing, setDismissing] = useState<Warning>();
  const [showDismissed, setShowDismissed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const [all, setAll] = useState(false);
  const c = conduct.value;
  if (!c) return null;
  const open = c.warnings.filter((w) => !w.dismissed).sort((a, b) => Number(b.severity === "warn") - Number(a.severity === "warn"));
  const shown = all ? open : open.slice(0, 4);
  const dismissed = c.warnings.filter((w) => w.dismissed);
  const act = (w: Warning) => {
    if (w.action === "retractions") {
      setChecking(true);
      api
        .retractions(viewer)
        .then((r) => {
          notify(r.flagged.length ? `${plural(r.flagged.length, "included study", "included studies")} with a retraction or correction notice` : `Checked ${plural(r.checked, "study", "studies")}: no notices${r.withoutDoi ? ` (${r.withoutDoi} without a DOI not checked)` : ""}`, r.flagged.length ? "error" : "ok");
          onChanged();
        })
        .catch((e) => notify(errorText(e), "error"))
        .finally(() => setChecking(false));
    } else if (w.action === "chase") {
      pending.sourcesView = "chase";
      go("sources");
    } else if (w.action === "xpilot") {
      pending.extract = "pilot";
      go("extract");
    } else if (w.action === "audit") setAiOpen(true);
    else go(w.action as never);
  };
  const ACTION: Record<string, string> = { chase: "Search citations", xpilot: "Start a pilot", audit: "Open AI use", setup: "Open Setup", sources: "Open Sources", ta: "Open screening", ft: "Open Full text", extract: "Open Extraction" };
  const actionLabel = (w: Warning) => (w.action === "retractions" ? (checking ? "Checking…" : "Check now") : (ACTION[w.action] ?? "Open"));
  const lastCheck = c.retractionChecks.at(-1);
  return (
    <section className="kx-rv-section kx-sb-conduct" aria-label="Conduct">
      <div className="kx-rv-section-head">
        <h2>Conduct</h2>
        <Explain help="review.conduct" />
        {open.length > 0 && <span className="kx-rv-seg-badge">{open.length}</span>}
      </div>
      <p className="kx-rv-muted kx-sb-small">Checked against Cochrane’s and Campbell’s conduct standards for a {TYPE_LABEL[c.reviewType] ?? "systematic review"}. Suggestions only: nothing is blocked.</p>
      {open.length === 0 ? (
        <p className="kx-sb-ok">
          <Icon name="check" size={13} />
          Nothing to look at now.
        </p>
      ) : (
        <ul className="kx-sb-warnings">
          {shown.map((w) => (
            <li key={w.id} data-severity={w.severity} data-check={w.id} data-expanded={expanded === w.id || undefined}>
              <span className="kx-sb-dot" aria-hidden="true" />
              <div className="kx-sb-warning-text">
                <button type="button" className="kx-sb-warning-title" aria-expanded={expanded === w.id} onClick={() => setExpanded(expanded === w.id ? undefined : w.id)}>
                  <strong>{w.title}</strong>
                  <span className="kx-sb-standard-tag">{w.standard.split(" · ")[0]}</span>
                </button>
                {expanded === w.id && (
                  <>
                    <p>{w.message}</p>
                    <p className="kx-sb-fix">{w.fix}.</p>
                    <div className="kx-sb-warning-actions">
                      <Btn small onClick={() => act(w)} disabled={w.action === "retractions" && checking}>
                        {actionLabel(w)}
                      </Btn>
                      <Btn small quiet onClick={() => setDismissing(w)}>
                        Not for this review…
                      </Btn>
                      <a className="kx-sb-standard" href={w.link} target="_blank" rel="noreferrer" title="Open the standard">
                        {w.standard}
                        <Icon name="external" size={10} />
                      </a>
                    </div>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {open.length > shown.length && (
        <button type="button" className="kx-sb-link" onClick={() => setAll(true)}>
          {open.length - shown.length} more
        </button>
      )}
      {lastCheck && (
        <p className="kx-rv-muted kx-sb-small">
          Retractions checked {formatDate(lastCheck.at)}: {plural(lastCheck.checked, "study", "studies")}
          {lastCheck.flagged.length ? `, ${lastCheck.flagged.length} with a notice (${lastCheck.flagged.map((f) => f.kind).join(", ")})` : ", no notices"}.
        </p>
      )}
      {dismissed.length > 0 && (
        <button type="button" className="kx-sb-link" aria-expanded={showDismissed} onClick={() => setShowDismissed(!showDismissed)}>
          {showDismissed ? "Hide" : "Show"} {plural(dismissed.length, "dismissed check")}
        </button>
      )}
      {showDismissed && (
        <ul className="kx-sb-warnings" data-dismissed>
          {dismissed.map((w) => (
            <li key={w.id} data-check={w.id}>
              <span className="kx-sb-dot" aria-hidden="true" />
              <div className="kx-sb-warning-text">
                <strong>{w.title}</strong>
                <p>
                  “{w.dismissed!.reason}” · {formatDate(w.dismissed!.at)}
                </p>
                <div className="kx-sb-warning-actions">
                  <Btn small quiet onClick={() => void api.dismiss(w.id, "", false, viewer).then(onChanged).catch((e) => notify(errorText(e), "error"))}>
                    Show again
                  </Btn>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {dismissing && (
        <DismissSheet
          warning={dismissing}
          onClose={() => setDismissing(undefined)}
          onDismiss={(reason) =>
            api.dismiss(dismissing.id, reason, true, viewer).then(() => {
              notify("Dismissed; the reason is kept with the review", "ok");
              onChanged();
            })
          }
        />
      )}
      <AiUsePanel {...props} open={aiOpen} setOpen={setAiOpen} />
    </section>
  );
}

function DismissSheet({ warning, onClose, onDismiss }: { warning: Warning; onClose: () => void; onDismiss: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  return (
    <GlobalDialog label="Dismiss a conduct check" onClose={onClose}>
      <form
        className="kx-rv-dialog kx-sb-dismiss"
        onSubmit={(e) => {
          e.preventDefault();
          onDismiss(reason)
            .then(onClose)
            .catch((err) => setError(errorText(err)));
        }}
      >
        <h2>Why does “{warning.title.toLowerCase()}” not apply?</h2>
        <p>The reason is kept in the review’s audit trail, so the methods can say why the review differs from the standard ({warning.standard}).</p>
        <label className="kx-rv-field" data-wide>
          <span>Reason</span>
          <textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: a rapid review agreed with the commissioner" aria-label="Reason" />
        </label>
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary disabled={!reason.trim()}>
            Dismiss
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

// ── AI use ────────────────────────────────────────────────────────────────────────────

function AiUsePanel(props: StageProps & { open: boolean; setOpen: (v: boolean) => void }) {
  const { invoke, workspaceId, reviewId, summary, open, setOpen } = props;
  const api = useMemo(() => conductApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const use = useLoad(() => api.aiUse(), [api, summary.events]);
  const u = use.value;
  if (!u || (!u.suggestions && !u.on)) return null;
  const ta = u.screening.find((s) => s.stage === "ta")?.agreement;
  return (
    <div className="kx-sb-ai" aria-label="AI use">
      <div className="kx-sb-ai-head">
        <Icon name="sparkle" size={13} />
        <strong>AI use</strong>
        <span className="kx-rv-muted">
          {u.suggestions ? `${plural(u.suggestions, "suggestion")} logged` : "On, nothing asked yet"}
          {ta && ta.n > 0 ? ` · agreement ${ta.percent?.toFixed(0)} %, κ ${fixed(ta.kappa)}` : ""}
        </span>
        <Btn small onClick={() => setOpen(true)}>
          Details
        </Btn>
      </div>
      {open && <AiUseSheet {...props} use={u} reload={use.reload} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ConfusionTable({ c }: { c: Confusion }) {
  return (
    <div className="kx-sb-confusion">
      <table className="kx-sb-table" aria-label="AI against the reviewers">
        <thead>
          <tr>
            <th />
            <th>Reviewers include</th>
            <th>Reviewers exclude</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>AI include</th>
            <td>{c.tp}</td>
            <td>{c.fp}</td>
          </tr>
          <tr>
            <th>AI exclude</th>
            <td data-tone={c.fn ? "warn" : undefined}>{c.fn}</td>
            <td>{c.tn}</td>
          </tr>
        </tbody>
      </table>
      <dl className="kx-sb-stats">
        <div>
          <dt>Agreement</dt>
          <dd>{c.percent == null ? "–" : `${c.percent.toFixed(0)} %`}</dd>
        </div>
        <div>
          <dt>Cohen’s κ</dt>
          <dd>
            {fixed(c.kappa)} {c.band && <span className="kx-rv-muted">{c.band}</span>}
          </dd>
        </div>
        <div>
          <dt>Sensitivity</dt>
          <dd>{percent(c.sensitivity)}</dd>
        </div>
        <div>
          <dt>Specificity</dt>
          <dd>{percent(c.specificity)}</dd>
        </div>
        <div>
          <dt>False-negative rate</dt>
          <dd>{percent(c.falseNegativeRate)}</dd>
        </div>
      </dl>
    </div>
  );
}

const OUTCOME: Record<string, string> = { accepted: "Accepted", changed: "Changed", rejected: "Rejected", pending: "Not decided yet" };

function AiUseSheet(props: StageProps & { use: AiUse; reload: () => void; onClose: () => void }) {
  const { invoke, workspaceId, reviewId, viewer, notify, onChanged, use, reload, onClose, summary } = props;
  const api = useMemo(() => conductApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const [stage, setStage] = useState<Stage>("ta");
  const [task, setTask] = useState<"screening" | "extraction">("screening");
  const [pct, setPct] = useState(task === "extraction" ? use.defaults.extraction[0] : use.defaults.screening[0]);
  const [minimum, setMinimum] = useState(use.defaults.screening[1]);
  const [busy, setBusy] = useState(false);
  const agreement = use.screening.find((s) => s.stage === stage);
  const openAudit = use.audits.find((a) => a.audit.open);
  const exportFile = (kind: string) =>
    props.api
      .exportFile(kind, viewer)
      .then((f) => downloadText(f.filename, f.content, f.mime))
      .catch((e) => notify(errorText(e), "error"));
  const draw = () => {
    setBusy(true);
    api
      .auditDraw(task, stage, pct, minimum, viewer)
      .then((a) => {
        notify(`${plural(a.records.length, task === "extraction" ? "study" : "record", task === "extraction" ? "studies" : "records")} drawn: screen them without the AI’s suggestion`, "ok");
        reload();
        onChanged();
      })
      .catch((e) => notify(errorText(e), "error"))
      .finally(() => setBusy(false));
  };
  return (
    <GlobalDrawer presentation="window" label="AI use" onClose={onClose}>
      <div className="kx-sb-sheet" data-modal-view="ai-use">
        <header className="kx-sb-sheet-head">
          <h2>AI use</h2>
          <Explain help="review.ai.audit" />
          <div className="kx-sb-sheet-tools">
            <Btn small icon="download" onClick={() => void exportFile("ai-statement")}>
              AI use statement
            </Btn>
            <Btn small icon="table" onClick={() => void exportFile("ai-log")}>
              Log (CSV)
            </Btn>
            <Btn small onClick={onClose}>
              Done
            </Btn>
          </div>
        </header>
        <p className="kx-rv-muted">AI suggestions are never decisions and the AI never counts as a reviewer. Every suggestion is logged with the model, its version as the provider reported it, the date and the prompt.</p>
        {use.statement && (
          <section className="kx-sb-statement" aria-label="Statement for the manuscript">
            <h3>For the methods section</h3>
            <p>{use.statement}</p>
            {use.results && <p>{use.results}</p>}
          </section>
        )}
        <section aria-label="Agreement">
          <div className="kx-sb-row-head">
            <h3>AI against the reviewers’ final decisions</h3>
            <Segmented label="Stage" value={stage} options={(["ta", "ft"] as Stage[]).map((s) => [s, STAGE_LABEL[s]])} onChange={setStage} />
          </div>
          {agreement && agreement.agreement.n > 0 ? <ConfusionTable c={agreement.agreement} /> : <p className="kx-rv-muted">No record with an AI suggestion has a final decision at this stage yet.</p>}
          {use.extraction.length > 0 && (
            <table className="kx-sb-table" aria-label="Extraction agreement">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Compared</th>
                  <th>Same value</th>
                </tr>
              </thead>
              <tbody>
                {use.extraction.map((f) => (
                  <tr key={`${f.formId}/${f.fieldId}`}>
                    <td>{f.label}</td>
                    <td>{f.n}</td>
                    <td>{f.percent == null ? "–" : `${f.percent.toFixed(0)} %`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section aria-label="Audit">
          <h3>Blind audit</h3>
          <p className="kx-rv-muted">A random sample of the records the AI assessed, screened by a person who does not see the AI’s suggestion. MAER-Net (2026) asks for the larger of 10 % or 100 records for screening and of 10 % or 20 studies for coding, and for the false-negative rate.</p>
          {openAudit ? (
            <div className="kx-sb-audit" data-open>
              <span>
                <strong>{plural(openAudit.audit.records.length, openAudit.audit.task === "extraction" ? "study" : "record", openAudit.audit.task === "extraction" ? "studies" : "records")}</strong> in the open sample · {openAudit.done} done
                {openAudit.audit.records.length < openAudit.audit.target && ` · ${openAudit.audit.target} planned, fewer were undecided`}
              </span>
              <Btn
                small
                onClick={() =>
                  void api
                    .auditClose(openAudit.audit.id, viewer)
                    .then(() => {
                      reload();
                      onChanged();
                    })
                    .catch((e) => notify(errorText(e), "error"))
                }
              >
                Close the audit
              </Btn>
            </div>
          ) : (
            <div className="kx-sb-audit-form">
              <Segmented
                label="What to audit"
                value={task}
                options={[
                  ["screening", "Screening"],
                  ["extraction", "Coding"],
                ]}
                onChange={(t) => {
                  setTask(t);
                  setPct(use.defaults[t][0]);
                  setMinimum(use.defaults[t][1]);
                }}
              />
              <label className="kx-sb-inline">
                <input type="number" min={1} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} aria-label="Percent" />
                <span>% or at least</span>
                <input type="number" min={1} value={minimum} onChange={(e) => setMinimum(Number(e.target.value))} aria-label="At least" />
                <span>{task === "extraction" ? "studies" : "records"}</span>
              </label>
              <Btn primary small disabled={busy} onClick={draw}>
                Draw the sample
              </Btn>
            </div>
          )}
          {use.audits
            .filter((a) => !a.audit.open)
            .map((a) => (
              <div key={a.audit.id} className="kx-sb-audit">
                <span>
                  {formatDate(a.audit.at)}: {plural(a.audit.records.length, a.audit.task === "extraction" ? "study" : "record", a.audit.task === "extraction" ? "studies" : "records")} of {a.audit.population}
                </span>
                <span className="kx-rv-muted">{a.agreement ? `false-negative rate ${percent(a.agreement.falseNegativeRate)}, κ ${fixed(a.agreement.kappa)}` : a.percent != null ? `${a.percent.toFixed(0)} % of fields the same` : ""}</span>
              </div>
            ))}
        </section>
        <section aria-label="Log">
          <h3>Log</h3>
          <table className="kx-sb-table kx-sb-log">
            <thead>
              <tr>
                <th>When</th>
                <th>Task</th>
                <th>Model</th>
                <th>Prompt</th>
                <th>Suggested</th>
                <th>Reviewer</th>
              </tr>
            </thead>
            <tbody>
              {use.log.slice(0, 200).map(({ log, outcome }) => (
                <tr key={log.event}>
                  <td>{formatDate(log.at)}</td>
                  <td>{log.task === "extraction" ? `Extraction · ${log.fieldId}` : STAGE_LABEL[log.stage ?? "ta"]}</td>
                  <td title={`${log.providerName || log.provider} · asked for ${log.model}`}>{log.modelReported || log.model || "–"}</td>
                  <td title={log.promptHash}>
                    {log.promptId ? `${log.promptId} v${log.promptVersion}` : "–"}
                  </td>
                  <td>{typeof log.output === "string" ? log.output : JSON.stringify(log.output)}</td>
                  <td data-outcome={outcome}>{OUTCOME[outcome]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {summary.protocol.rules.aiAssist ? null : <p className="kx-rv-muted">AI assistance is now off for this review (Setup › Team and rules).</p>}
        </section>
      </div>
    </GlobalDrawer>
  );
}
