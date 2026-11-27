// Sources › Citation searching (std-B): from the included studies (or any chosen), the works they
// cite and the works citing them, through OpenAlex in the background. Counts first (found,
// already in the review, new), then the new ones go in as one "Citation searching" import
// under PRISMA's other methods. Rounds repeat on newly included studies; a round that adds
// nothing says so. All logic is in Rust (key-review chasing.rs).
import { useEffect, useMemo, useRef, useState } from "react";
import { Explain } from "../explain";
import { Icon } from "../icons";
import { plural } from "./review-api";
import { conductApi, type ChaseStatus, type Direction } from "./review-conduct-api";
import { Btn, Segmented, errorText, formatDate, useLoad } from "./review-ui";
import type { StageProps } from "./ReviewPage";
import "./review-std-b.css";

const PHASE: Record<string, string> = { seeds: "Finding the studies in OpenAlex", references: "Reading their reference lists", citing: "Finding works that cite them", done: "Counting" };
const VIA: Record<string, string> = { doi: "found by DOI", title: "found by title, year and author", fulltext: "not in OpenAlex: its full text's reference list was used", none: "not found in OpenAlex" };
const DIRECTION: Record<Direction, string> = { both: "Both ways", backward: "Reference lists", forward: "Citing works" };

export function CitationSearching(props: StageProps) {
  const { invoke, workspaceId, reviewId, viewer, notify, onChanged, summary } = props;
  const api = useMemo(() => conductApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const view = useLoad(() => api.chaseView(), [api, summary.events]);
  const [chosen, setChosen] = useState<Set<string>>();
  const [direction, setDirection] = useState<Direction>("both");
  const [job, setJob] = useState<string>();
  const [status, setStatus] = useState<ChaseStatus>();
  const [ordered, setOrdered] = useState(true);
  const [busy, setBusy] = useState(false);
  const v = view.value;
  const seeds = chosen ?? new Set(v?.defaultSeeds ?? []);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!job) return;
    let stop = false;
    const poll = () =>
      api
        .chaseStatus(job)
        .then((s) => {
          if (stop) return;
          setStatus(s);
          if (s.state === "running") timer.current = setTimeout(poll, 400);
        })
        .catch((e) => !stop && notify(errorText(e), "error"));
    poll();
    return () => {
      stop = true;
      clearTimeout(timer.current);
    };
  }, [api, job, notify]);

  if (view.error) return <p className="kx-inline-error">{view.error}</p>;
  if (!v) return <div className="kx-rv-loading" aria-busy="true" />;
  const running = status?.state === "running";
  const p = status?.preview;
  const toggle = (id: string) => {
    const next = new Set(seeds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };
  const start = () => {
    setStatus(undefined);
    api
      .chaseStart([...seeds], direction)
      .then((r) => setJob(r.jobId))
      .catch((e) => notify(errorText(e), "error"));
  };
  const importNew = () => {
    if (!job) return;
    setBusy(true);
    api
      .chaseImport(job, ordered, viewer)
      .then((r) => {
        notify(r.round.new ? `${plural(r.round.new, "new record")} added as “Citation searching”` : "Nothing new: the round is recorded", "ok");
        setJob(undefined);
        setStatus(undefined);
        setChosen(undefined);
        onChanged();
        view.reload();
      })
      .catch((e) => notify(errorText(e), "error"))
      .finally(() => setBusy(false));
  };
  return (
    <div className="kx-sb-chase" data-state={status?.state ?? "idle"}>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Citation searching</h2>
          <Explain help="review.chase" />
        </div>
        <p className="kx-rv-muted kx-sb-lede">
          The works your studies cite and the works that cite them, looked up in OpenAlex. You see how many are new before anything is added; they are screened like every record and counted under PRISMA’s other methods.
        </p>
        {v.hint && (
          <p className="kx-sb-hint" role="status">
            <Icon name="info" size={13} />
            {v.hint}
          </p>
        )}
        {v.included.length === 0 ? (
          <p className="kx-rv-muted">No study is included after full-text screening yet. Citation searching starts from the included studies.</p>
        ) : (
          <>
            <div className="kx-sb-chase-head">
              <strong>Start from</strong>
              <span className="kx-rv-muted">{plural(seeds.size, "study", "studies")} chosen</span>
              <button type="button" className="kx-sb-link" onClick={() => setChosen(new Set(v.included.map((s) => s.id)))}>
                All included
              </button>
              <button type="button" className="kx-sb-link" onClick={() => setChosen(new Set(v.defaultSeeds))}>
                Not chased yet
              </button>
            </div>
            <ul className="kx-sb-seeds" aria-label="Studies to start from">
              {v.included.map((s) => (
                <li key={s.id}>
                  <label>
                    <input type="checkbox" checked={seeds.has(s.id)} onChange={() => toggle(s.id)} disabled={running} />
                    <span className="kx-sb-seed-title">{s.title || "Untitled"}</span>
                    <span className="kx-rv-muted">{s.byline}</span>
                    {s.chased && <span className="kx-rv-pill" data-tone="muted">Chased</span>}
                    {!s.doi && <span className="kx-rv-pill" data-tone="muted" title="Matched by title, year and first author">No DOI</span>}
                  </label>
                </li>
              ))}
            </ul>
            <div className="kx-sb-chase-run">
              <Segmented label="Direction" value={direction} options={(["both", "backward", "forward"] as Direction[]).map((d) => [d, DIRECTION[d]])} onChange={setDirection} />
              {running ? (
                <Btn onClick={() => job && void api.chaseCancel(job)}>Stop</Btn>
              ) : (
                <Btn primary icon="search" disabled={!seeds.size} onClick={start}>
                  Search citations
                </Btn>
              )}
            </div>
          </>
        )}
        {running && (
          <div className="kx-sb-progress" role="progressbar" aria-label="Citation searching" aria-valuemin={0} aria-valuemax={status?.progress?.total || 1} aria-valuenow={status?.progress?.done ?? 0}>
            <span>{PHASE[status?.progress?.phase ?? "seeds"]}…</span>
            <span className="kx-rv-progress-bar" aria-hidden="true">
              <span data-tone="accent" style={{ width: `${status?.progress?.total ? (status.progress.done / status.progress.total) * 100 : 8}%` }} />
            </span>
          </div>
        )}
        {status?.state === "failed" && <p className="kx-inline-error">{status.error}</p>}
      </section>
      {p && status && (
        <section className="kx-rv-section kx-sb-chase-result" aria-label="What was found">
          <div className="kx-sb-tiles">
            <div>
              <strong>{p.found.toLocaleString()}</strong>
              <span>found</span>
            </div>
            <div>
              <strong>{p.inReview.toLocaleString()}</strong>
              <span>already in the review</span>
            </div>
            <div data-tone="accent">
              <strong>{p.new.toLocaleString()}</strong>
              <span>new</span>
            </div>
          </div>
          {status.state === "cancelled" && <p className="kx-rv-muted">Stopped early: these are the records found until then.</p>}
          {p.possibleDuplicates > 0 && <p className="kx-rv-muted">{plural(p.possibleDuplicates, "new record")} look like records already here and will be offered under Duplicates.</p>}
          <ul className="kx-sb-seed-outcomes">
            {status.seeds?.map((s) => (
              <li key={s.recordId} data-via={s.via}>
                <span className="kx-sb-seed-title">{s.title}</span>
                <span className="kx-rv-muted">
                  {VIA[s.via]}
                  {s.via !== "none" && ` · ${s.backward} cited, ${s.forward} citing`}
                </span>
              </li>
            ))}
          </ul>
          {!!status.candidates?.length && (
            <ol className="kx-sb-candidates" aria-label="Records found">
              {status.candidates.slice(0, 60).map((c, i) => (
                <li key={i} data-known={c.known || undefined}>
                  <span className="kx-sb-links" title={`Linked to ${plural(c.links, "starting study", "starting studies")}`}>
                    {c.links}
                  </span>
                  <span className="kx-sb-cand-text">
                    <span>{c.title}</span>
                    <span className="kx-rv-muted">
                      {c.byline}
                      {c.direction === "backward" ? " · cited" : c.direction === "forward" ? " · citing" : " · cited and citing"}
                    </span>
                  </span>
                  {c.known && <span className="kx-rv-pill" data-tone="muted">In the review</span>}
                </li>
              ))}
            </ol>
          )}
          <div className="kx-sb-chase-import">
            <label className="kx-sb-check">
              <input type="checkbox" checked={ordered} onChange={(e) => setOrdered(e.target.checked)} />
              <span>
                Screen the most linked first
                <small>Works cited by, or citing, several of your studies come first (co-citation and bibliographic coupling).</small>
              </span>
            </label>
            <Btn primary disabled={busy || running} onClick={importNew}>
              {p.new ? `Add ${plural(p.new, "new record")}` : "Record this round"}
            </Btn>
          </div>
        </section>
      )}
      {v.rounds.length > 0 && (
        <section className="kx-rv-section">
          <div className="kx-rv-section-head">
            <h2>Rounds</h2>
          </div>
          <table className="kx-sb-table">
            <thead>
              <tr>
                <th>Round</th>
                <th>Date</th>
                <th>Direction</th>
                <th>From</th>
                <th>Found</th>
                <th>New</th>
                <th>Screened</th>
                <th>Included</th>
              </tr>
            </thead>
            <tbody>
              {v.rounds.map((r) => (
                <tr key={`${r.round.round}-${r.round.batchId}`}>
                  <td>{r.round.round}</td>
                  <td>{formatDate(r.round.at)}</td>
                  <td>{DIRECTION[r.round.direction] ?? r.round.direction}</td>
                  <td>{plural(r.round.seeds.length, "study", "studies")}</td>
                  <td>{r.round.found}</td>
                  <td>{r.round.new}</td>
                  <td>{r.screened}</td>
                  <td>{r.included}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
