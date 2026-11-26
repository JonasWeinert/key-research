// Live indexing progress: what is being read and indexed now, what comes next and why,
// and how long the batch has left. Shared by the Sources footer, its banner, rows,
// the inspector and Home.
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { jobProgress, referencesProgress, stageLabel } from "./analysis-progress";
import { KIND_ICON, type IndexActivity, type IndexJob, type Invoke, type LibraryStatus } from "./library-api";

/** Polls the host's library status: quickly while indexing, gently otherwise. */
export function useLibraryStatus(invoke: Invoke, workspaceId: string | undefined, active = true) {
  const [status, setStatus] = useState<LibraryStatus>();
  useEffect(() => {
    if (!workspaceId || !active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let next: LibraryStatus | undefined;
      try {
        next = await invoke<LibraryStatus>("store_status", {}, workspaceId);
      } catch {}
      if (stopped) return;
      if (next) setStatus(next);
      const working = !!next && (next.busy || next.counts.indexing > 0 || !!next.references);
      timer = setTimeout(poll, working ? 900 : 4000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [invoke, workspaceId, active]);
  return status;
}

export { jobProgress, referencesProgress, stageLabel } from "./analysis-progress";

const PRIORITY_LABEL = { opened: "You opened this", selected: "Selected", visible: "On screen" } as const;

function remaining(activity: IndexActivity) {
  const left = Math.max(0, activity.batchTotal - activity.batchDone);
  const seconds = activity.secondsPerSource ? left * activity.secondsPerSource : undefined;
  return { left, eta: timeLeft(seconds) };
}
function timeLeft(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  if (seconds < 50) return "less than a minute left";
  if (seconds < 90 * 60) return `about ${Math.max(1, Math.round(seconds / 60))} min left`;
  return `about ${Math.round(seconds / 360) / 10} h left`;
}
export const isActive = (a?: IndexActivity) => !!a && (a.batchTotal > a.batchDone || !!a.reading || !!a.embedding);

/** A small determinate ring; spins softly while the fraction is unknown. */
export function ProgressRing({ fraction, size = 16 }: { fraction?: number; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const known = fraction !== undefined;
  return (
    <svg className="kx-ring" data-indeterminate={!known} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} className="kx-ring-track" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="kx-ring-value"
        strokeDasharray={c}
        strokeDashoffset={known ? c * (1 - Math.max(0.04, fraction)) : c * 0.7}
      />
    </svg>
  );
}

function JobRow({ job, activity }: { job: IndexJob; activity: IndexActivity }) {
  const progress = jobProgress(activity, job.id);
  return (
    <li className="kx-activity-job">
      {progress ? <ProgressRing fraction={progress.fraction} size={18} /> : <Icon name={KIND_ICON[job.kind] ?? "doc"} size={14} />}
      <span>
        <strong>{job.title || "Untitled"}</strong>
        <small>
          {progress ? progress.label : "Waiting"}
          {job.priority && <em>{PRIORITY_LABEL[job.priority]}</em>}
        </small>
      </span>
    </li>
  );
}

function ReferencesRow({ references }: { references: NonNullable<LibraryStatus["references"]> }) {
  const progress = referencesProgress(references)!;
  return (
    <li className="kx-activity-job" data-stage={references.stage}>
      <ProgressRing fraction={progress.fraction} size={18} />
      <span>
        <strong>{references.title || "Untitled"}</strong>
        <small>{progress.label}</small>
      </span>
    </li>
  );
}

/** The full picture: overall batch, the two pipeline stages, and the queue. */
export function ActivityPanel({
  activity,
  modelReady,
  onPause,
  backfill,
  references,
}: {
  activity: IndexActivity;
  modelReady: boolean;
  onPause: (paused: boolean) => void;
  backfill?: LibraryStatus["backfill"];
  /** The source whose references are being found or looked up now. */
  references?: LibraryStatus["references"];
}) {
  const { left, eta } = remaining(activity);
  const older = olderSources(backfill);
  const now = [activity.reading, activity.embedding].filter((j): j is IndexJob => !!j);
  const total = activity.batchTotal;
  return (
    <div className="kx-activity-panel">
      <header>
        <div>
          <strong>{activity.paused ? "Indexing paused" : left ? "Making your library searchable" : references ? "Analysing references" : "All caught up"}</strong>
          <span>
            {total ? `${activity.batchDone.toLocaleString()} of ${total.toLocaleString()} sources` : "Every source is searchable"}
            {eta && !activity.paused ? ` · ${eta}` : ""}
          </span>
          {older > 0 && (
            <span className="kx-activity-backfill">
              {activity.paused ? "Paused: " : ""}Looking up {older.toLocaleString()} older {older === 1 ? "source" : "sources"} when idle
            </span>
          )}
        </div>
        {(left > 0 || activity.paused || older > 0) && (
          <button className="kx-activity-pause" onClick={() => onPause(!activity.paused)}>
            <Icon name={activity.paused ? "play" : "pause"} size={12} />
            {activity.paused ? "Resume" : "Pause"}
          </button>
        )}
      </header>
      {total > 0 && (
        <div className="kx-meter" aria-hidden="true">
          <span style={{ width: `${(activity.batchDone / total) * 100}%` }} />
        </div>
      )}
      {now.length > 0 && (
        <section>
          <h3>Now</h3>
          <ul>
            {now.map((job) => (
              <JobRow key={`${job.stage}:${job.id}`} job={job} activity={activity} />
            ))}
          </ul>
        </section>
      )}
      {references && (
        <section>
          <h3>References</h3>
          <ul>
            <ReferencesRow references={references} />
          </ul>
        </section>
      )}
      {activity.upNext.length > 0 && (
        <section>
          <h3>Up next</h3>
          <ul>
            {activity.upNext.map((job) => (
              <JobRow key={job.id} job={job} activity={activity} />
            ))}
          </ul>
        </section>
      )}
      <p className="kx-activity-note">
        {activity.vectorsPending > 0 && !modelReady
          ? `${activity.vectorsPending.toLocaleString()} passages are searchable by words now and gain meaning search once the search model is ready.`
          : "Sources you open, select or scroll to are indexed first."}
      </p>
    </div>
  );
}

/** Older PDFs still to identify or look up in the background. */
export const olderSources = (backfill?: LibraryStatus["backfill"]) => (backfill ? backfill.identify + backfill.lookup : 0);

/** The status bar's line for the batch: "Indexing · 12 left · about 3 min", and its progress. */
export function activityLabel(activity: IndexActivity): { label: string; fraction?: number } {
  if (activity.paused) return { label: "Indexing paused" };
  const { left, eta } = remaining(activity);
  return {
    label: `Indexing · ${left.toLocaleString()} left${eta ? ` · ${eta.replace(" left", "")}` : ""}`,
    fraction: activity.batchTotal ? activity.batchDone / activity.batchTotal : undefined,
  };
}

/** A banner while a larger batch runs (Sources), or any batch (Home). */
export function ActivityBanner({ status, minimum = 1, onPause }: { status?: LibraryStatus; minimum?: number; onPause?: (paused: boolean) => void }) {
  const activity = status?.activity;
  if (!activity || !isActive(activity)) return null;
  const { left, eta } = remaining(activity);
  if (left < minimum && !activity.paused) return null;
  const current = activity.reading ?? activity.embedding;
  const fraction = activity.batchTotal ? activity.batchDone / activity.batchTotal : 0;
  return (
    <section className="kx-activity-banner" role="status" aria-label="Indexing progress">
      <ProgressRing fraction={fraction} size={30} />
      <div className="kx-activity-banner-text">
        <strong>
          {activity.paused ? "Indexing paused" : "Making your library searchable"}
          <span>
            {activity.batchDone.toLocaleString()} of {activity.batchTotal.toLocaleString()}
            {eta && !activity.paused ? ` · ${eta}` : ""}
          </span>
        </strong>
        {current && !activity.paused ? (
          <small>
            {stageLabel(current)} · <em>{current.title || "Untitled"}</em>
          </small>
        ) : (
          <small>Search covers each source as soon as it finishes.</small>
        )}
        <div className="kx-meter" aria-hidden="true">
          <span style={{ width: `${fraction * 100}%` }} />
        </div>
      </div>
      {onPause && (
        <button className="kx-activity-pause" onClick={() => onPause(!activity.paused)}>
          <Icon name={activity.paused ? "play" : "pause"} size={12} />
          {activity.paused ? "Resume" : "Pause"}
        </button>
      )}
    </section>
  );
}
