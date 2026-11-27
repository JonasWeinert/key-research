// std-A: Overview › Search report. The review's searches reported the PRISMA-S way: every
// source with its platform, coverage, date, strategy as run (Key's own runs from their log),
// limits and filters; other methods; update searches; reused prior work; the strategies' peer
// review; totals before and after de-duplication. What an import still lacks is asked for in
// plain words, and the PRISMA-S checklist below is filled from it. Exports: an appendix
// (Markdown, or HTML for Word), a CSV and the machine-readable JSON.
import { useMemo, useState } from "react";
import { downloadText } from "../db-ui";
import { Explain } from "../explain";
import { GlobalDialog } from "../GlobalDrawer";
import { Icon } from "../icons";
import { Btn, MenuButton, Row, errorText, formatDate, useLoad } from "./review-ui";
import { reportingApi, type Filter, type Limit, type PeerReview, type PriorWork, type SourceRow } from "./review-reporting-api";
import { ChecklistItems, useGoTo } from "./review-checklist";
import type { StageProps } from "./ReviewPage";

const GROUP: Record<string, string> = { databases: "Database", registers: "Register", other: "Other method" };

function SourceSheet({ row, onClose, onSave }: { row: SourceRow; onClose: () => void; onSave: (detail: Record<string, unknown>) => Promise<unknown> }) {
  const [platform, setPlatform] = useState(row.keyRun ? "" : row.platform);
  const [coverage, setCoverage] = useState(row.coverage);
  const [searched, setSearched] = useState(/^\d{4}-\d{2}-\d{2}$/.test(row.searched) ? row.searched : "");
  const [strategy, setStrategy] = useState(row.keyRun ? "" : row.strategy);
  const [limits, setLimits] = useState<Limit[]>(row.limits.length ? row.limits : []);
  const [noLimits, setNoLimits] = useState(row.noLimits && !row.limits.length);
  const [filters, setFilters] = useState<Filter[]>(row.filters);
  const [notes, setNotes] = useState(row.notes);
  const [searcher, setSearcher] = useState(row.searcher);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const other = row.group === "other";
  return (
    <GlobalDialog label={`Details of ${row.name}`} onClose={onClose} busy={busy}>
      <form
        className="kx-rv-dialog kx-rp-sheet"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          const detail: Record<string, unknown> = { batchId: row.batchId, source: row.source, coverage, notes, searcher, limits: limits.filter((l) => l.value.trim()), noLimits, filters: filters.filter((f) => f.name.trim()) };
          if (!row.keyRun || platform.trim()) detail.platform = platform;
          if (!row.keyRun) detail.strategy = strategy;
          if (searched !== row.searched) detail.searchedAt = searched;
          onSave(detail)
            .then(onClose)
            .catch((err) => setError(errorText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>{row.name}</h2>
        <p className="kx-rv-muted">
          {row.keyRun ? "Searched with Key's Database search: the strategy, dates and counts come from its log. Add what the log cannot know." : other ? "Say what was done, when, and by whom, so another team could repeat it." : "An imported file knows only its records. Add how it was searched, as PRISMA-S asks."}
        </p>
        {row.missing.length > 0 && (
          <p className="kx-rp-missing">
            <Icon name="warning" size={12} /> Still needed: {row.missing.join(", ")}.
          </p>
        )}
        {!other && (
          <Row label="Platform or interface" hint={row.keyRun ? row.platform : "For example Ovid, EBSCOhost, Web of Science, the database's own site."}>
            <input className="kx-rv-input" value={platform} placeholder={row.keyRun ? "As above" : "Ovid"} onChange={(e) => setPlatform(e.target.value)} aria-label="Platform" />
          </Row>
        )}
        {!other && (
          <Row label="Coverage" hint="The years the database covers, as its platform states.">
            <input className="kx-rv-input" value={coverage} placeholder="1946 to present" onChange={(e) => setCoverage(e.target.value)} aria-label="Coverage" />
          </Row>
        )}
        <Row label={other ? "Date done" : "Date searched"}>
          <input className="kx-rv-input" type="date" value={searched} onChange={(e) => setSearched(e.target.value)} aria-label="Date searched" />
        </Row>
        {!row.keyRun && !other && (
          <Row label="Strategy as run" hint="Paste it exactly as the database ran it, line numbers and all." wide>
            <textarea className="kx-rv-input kx-rp-mono" rows={6} value={strategy} onChange={(e) => setStrategy(e.target.value)} aria-label="Strategy as run" />
          </Row>
        )}
        {other && (
          <Row label="What was done" hint="Websites: addresses and how they were browsed. Contacts: whom you asked. Citation searching: seed studies and direction." wide>
            <textarea className="kx-rv-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="What was done" />
          </Row>
        )}
        {!other && (
          <Row label="Limits" hint="Dates, languages or publication types the search was restricted to, each with the reason (Cochrane asks for it)." wide>
            <div className="kx-rp-pairs">
              {limits.map((l, i) => (
                <div key={i} className="kx-rp-pair">
                  <input className="kx-rv-input" value={l.value} placeholder="2000 onwards" onChange={(e) => setLimits(limits.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} aria-label="Limit" />
                  <input className="kx-rv-input" value={l.justification} placeholder="Why" onChange={(e) => setLimits(limits.map((x, j) => (j === i ? { ...x, justification: e.target.value } : x)))} aria-label="Reason for the limit" />
                  <button type="button" className="kx-rv-icon" aria-label="Remove limit" onClick={() => setLimits(limits.filter((_, j) => j !== i))}>
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
              <div className="kx-rp-pair-tools">
                <Btn small icon="plus" onClick={() => setLimits([...limits, { kind: "other", value: "", justification: "" }])}>
                  Add a limit
                </Btn>
                {!limits.length && (
                  <label className="kx-check">
                    <input type="checkbox" checked={noLimits} onChange={(e) => setNoLimits(e.target.checked)} /> No limits were used
                  </label>
                )}
              </div>
            </div>
          </Row>
        )}
        {!other && (
          <Row label="Search filters" hint="A published filter (for example for randomised trials): name and citation." wide>
            <div className="kx-rp-pairs">
              {filters.map((f, i) => (
                <div key={i} className="kx-rp-pair">
                  <input className="kx-rv-input" value={f.name} placeholder="Cochrane RCT filter" onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Filter" />
                  <input className="kx-rv-input" value={f.citation} placeholder="Citation" onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, citation: e.target.value } : x)))} aria-label="Filter citation" />
                  <label className="kx-check" title="Changed from the published version">
                    <input type="checkbox" checked={f.modified} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, modified: e.target.checked } : x)))} /> Changed
                  </label>
                  <button type="button" className="kx-rv-icon" aria-label="Remove filter" onClick={() => setFilters(filters.filter((_, j) => j !== i))}>
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
              <Btn small icon="plus" onClick={() => setFilters([...filters, { name: "", citation: "", modified: false }])}>
                Add a filter
              </Btn>
            </div>
          </Row>
        )}
        <Row label="Searched by">
          <input className="kx-rv-input" value={searcher} placeholder="Name" onChange={(e) => setSearcher(e.target.value)} aria-label="Searched by" />
        </Row>
        {!other && (
          <Row label="Notes" wide>
            <textarea className="kx-rv-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" />
          </Row>
        )}
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary="true" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

function PeerReviewSheet({ entry, onClose, onSave }: { entry: Partial<PeerReview>; onClose: () => void; onSave: (e: Partial<PeerReview>) => Promise<unknown> }) {
  const [v, setV] = useState<Partial<PeerReview>>({ tool: "PRESS 2015", ...entry });
  const [error, setError] = useState("");
  const set = (k: keyof PeerReview) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <GlobalDialog label="Peer review of the search" onClose={onClose}>
      <form
        className="kx-rv-dialog kx-rp-sheet"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(v)
            .then(onClose)
            .catch((err) => setError(errorText(err)));
        }}
      >
        <h2>Peer review of the search</h2>
        <p className="kx-rv-muted">A second searcher, often a librarian, checks the strategies before they are run. PRESS 2015 is the usual checklist: translation of the question, Boolean and proximity operators, subject headings, text words, spelling and syntax, limits and filters.</p>
        <Row label="Reviewed by">
          <input className="kx-rv-input" value={v.by ?? ""} onChange={set("by")} placeholder="Name and role" aria-label="Reviewed by" autoFocus />
        </Row>
        <Row label="Date">
          <input className="kx-rv-input" type="date" value={v.date ?? ""} onChange={set("date")} aria-label="Date of the peer review" />
        </Row>
        <Row label="Checklist or tool">
          <input className="kx-rv-input" value={v.tool ?? ""} onChange={set("tool")} aria-label="Checklist or tool" />
        </Row>
        <Row label="Outcome" hint="What changed because of it." wide>
          <textarea className="kx-rv-input" rows={2} value={v.outcome ?? ""} onChange={set("outcome")} aria-label="Outcome of the peer review" />
        </Row>
        <Row label="Notes" wide>
          <textarea className="kx-rv-input" rows={2} value={v.notes ?? ""} onChange={set("notes")} aria-label="Notes on the peer review" />
        </Row>
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary="true">
            Save
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

function PriorSheet({ entry, onClose, onSave }: { entry: Partial<PriorWork>; onClose: () => void; onSave: (e: Partial<PriorWork>) => Promise<unknown> }) {
  const [v, setV] = useState<Partial<PriorWork>>({ how: "Strategy adapted from", ...entry });
  const [error, setError] = useState("");
  return (
    <GlobalDialog label="Prior work reused" onClose={onClose}>
      <form
        className="kx-rv-dialog kx-rp-sheet"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(v)
            .then(onClose)
            .catch((err) => setError(errorText(err)));
        }}
      >
        <h2>Prior work reused</h2>
        <p className="kx-rv-muted">A search strategy taken or adapted from an earlier review or a published filter collection.</p>
        <Row label="How it was used">
          <input className="kx-rv-input" value={v.how ?? ""} onChange={(e) => setV({ ...v, how: e.target.value })} aria-label="How it was used" />
        </Row>
        <Row label="Citation" wide>
          <textarea className="kx-rv-input" rows={2} value={v.citation ?? ""} onChange={(e) => setV({ ...v, citation: e.target.value })} aria-label="Citation" autoFocus />
        </Row>
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary="true">
            Save
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

function SourcesTable({ rows, onEdit, other }: { rows: SourceRow[]; onEdit: (r: SourceRow) => void; other?: boolean }) {
  return (
    <table className="kx-rp-table">
      <thead>
        <tr>
          <th>{other ? "Method" : "Source"}</th>
          {!other && <th>Platform</th>}
          <th>{other ? "Date" : "Searched"}</th>
          <th className="kx-rp-num-col">Records</th>
          <th>PRISMA-S</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.batchId}:${r.source}`} data-source={r.name}>
            <td>
              <strong>{r.name}</strong>
              <small>
                {GROUP[r.group] ?? "Database"}
                {r.update ? " · update" : ""}
                {other && (r.notes || r.strategy) ? ` · ${r.notes || r.strategy}` : ""}
              </small>
            </td>
            {!other && <td className="kx-rp-platform">{r.platform || <span className="kx-rv-muted">Not stated</span>}</td>}
            <td>{r.searched || <span className="kx-rv-muted">Not stated</span>}</td>
            <td className="kx-rp-num-col">{r.records.toLocaleString()}</td>
            <td>{r.missing.length ? <span className="kx-rv-pill" data-tone="amber" title={`Still needed: ${r.missing.join(", ")}`}>Needs {r.missing.length === 1 ? r.missing[0].split(" (")[0] : `${r.missing.length} details`}</span> : <span className="kx-rv-pill" data-tone="green">Complete</span>}</td>
            <td>
              <Btn small onClick={() => onEdit(r)}>
                {r.missing.length ? "Complete…" : "Details…"}
              </Btn>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SearchReportPage(props: StageProps & { onView: (view: string) => void }) {
  const { invoke, workspaceId, reviewId, summary, viewer, notify, onChanged } = props;
  const rapi = useMemo(() => reportingApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const data = useLoad(() => rapi.searchReport(), [rapi, summary.events]);
  const [editing, setEditing] = useState<SourceRow>();
  const [review, setReview] = useState<Partial<PeerReview>>();
  const [prior, setPrior] = useState<Partial<PriorWork>>();
  const go = useGoTo(props, props.onView);
  const done = () => {
    data.reload();
    onChanged();
  };
  const exportKind = (kind: string) =>
    rapi
      .exportFile(kind)
      .then((f) => downloadText(f.filename, f.content, f.mime))
      .catch((e) => notify(errorText(e), "error"));
  const r = data.value;
  if (data.error && !r) return <p className="kx-inline-error">{data.error}</p>;
  if (!r) return <div className="kx-rv-loading" aria-busy="true" />;
  const incomplete = [...r.sources, ...r.otherMethods].filter((s) => s.missing.length).length;
  return (
    <div className="kx-rp-page" data-testid="search-report">
      <div className="kx-rp-head">
        <h2>Search report</h2>
        <Explain help="review.searchreport" />
        <span className="kx-rp-spacer" />
        <MenuButton
          label="Export search report"
          icon="download"
          items={[
            { label: "Appendix (Markdown)", icon: "fileMarkdown", run: () => void exportKind("search-report") },
            { label: "Appendix for Word (HTML)", icon: "fileDoc", run: () => void exportKind("search-report-html") },
            { label: "Sources and counts (CSV)", icon: "table", run: () => void exportKind("search-report-csv") },
            { label: "Machine-readable (JSON)", icon: "database", run: () => void exportKind("search-report-json") },
          ]}
        />
      </div>
      <dl className="kx-rp-totals">
        <div>
          <dt>Identified</dt>
          <dd>{r.totals.identified.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Duplicates removed</dt>
          <dd>{r.totals.duplicates.toLocaleString()}</dd>
        </div>
        <div>
          <dt>After de-duplication</dt>
          <dd>{r.totals.afterDedup.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Other methods</dt>
          <dd>{r.totals.otherMethods.toLocaleString()}</dd>
        </div>
      </dl>
      {incomplete > 0 && (
        <p className="kx-rp-missing">
          <Icon name="warning" size={12} /> {incomplete === 1 ? "One source needs" : `${incomplete} sources need`} details PRISMA-S asks for. Use Complete… beside each.
        </p>
      )}
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Databases and registers</h2>
        </div>
        {r.sources.length ? <SourcesTable rows={r.sources} onEdit={setEditing} /> : <p className="kx-rv-muted">No searches imported yet. Run one in Sources › Database searches, or import a file your search exported.</p>}
      </section>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Other methods</h2>
        </div>
        {r.otherMethods.length ? <SourcesTable rows={r.otherMethods} onEdit={setEditing} other /> : <p className="kx-rv-muted">None recorded. Import reference-list checks, citation searches, websites or contacts as an other-method import (Sources › Imports).</p>}
      </section>
      {r.updates.length > 0 && (
        <section className="kx-rv-section">
          <div className="kx-rv-section-head">
            <h2>Update searches</h2>
          </div>
          <ul className="kx-rp-plain">
            {r.updates.map((u, i) => (
              <li key={i}>
                {u.search}, {formatDate(u.at)}: {u.added.toLocaleString()} new, {u.known.toLocaleString()} already in the review
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="kx-rp-two">
        <section className="kx-rv-section">
          <div className="kx-rv-section-head">
            <h2>Peer review of the search</h2>
            <Btn small icon="plus" onClick={() => setReview({})}>
              Record…
            </Btn>
          </div>
          {r.peerReviews.length ? (
            <ul className="kx-rp-plain">
              {r.peerReviews.map((p) => (
                <li key={p.id}>
                  <button type="button" className="kx-rp-textbtn" onClick={() => setReview(p)}>
                    {p.by}, {p.date} ({p.tool || "PRESS 2015"})
                  </button>
                  {p.outcome && <small>{p.outcome}</small>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="kx-rv-muted">Not recorded. A second searcher's check with PRESS 2015 is recommended.</p>
          )}
        </section>
        <section className="kx-rv-section">
          <div className="kx-rv-section-head">
            <h2>Prior work reused</h2>
            <Btn small icon="plus" onClick={() => setPrior({})}>
              Add…
            </Btn>
          </div>
          {r.prior.length ? (
            <ul className="kx-rp-plain">
              {r.prior.map((p) => (
                <li key={p.id}>
                  <button type="button" className="kx-rp-textbtn" onClick={() => setPrior(p)}>
                    {p.how}: {p.citation}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="kx-rv-muted">None. Add a citation when a strategy comes from earlier work.</p>
          )}
        </section>
      </div>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>De-duplication</h2>
        </div>
        <p className="kx-rp-para">{r.dedupMethod}</p>
      </section>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>PRISMA-S checklist</h2>
        </div>
        <ChecklistItems
          items={r.items}
          go={go}
          notify={notify}
          filter="all"
          save={(item, location, text) =>
            void rapi
              .note(item.list, item.id, location, text, viewer)
              .then(done)
              .catch((e) => notify(errorText(e), "error"))
          }
        />
      </section>
      {editing && <SourceSheet row={editing} onClose={() => setEditing(undefined)} onSave={(d) => rapi.setSource(d as never, viewer).then(done)} />}
      {review && <PeerReviewSheet entry={review} onClose={() => setReview(undefined)} onSave={(e) => rapi.setPeerReview(e, viewer).then(done)} />}
      {prior && <PriorSheet entry={prior} onClose={() => setPrior(undefined)} onSave={(e) => rapi.setPrior(e, viewer).then(done)} />}
    </div>
  );
}
