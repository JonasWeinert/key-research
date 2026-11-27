// The frame of the "N selected" panel (SelectionPanel.tsx), the same for library sources and
// Inbox works: the sticky bar with the count, the heading, the notice that reports what an
// action did (with Undo and Stop), the overview's facts and charts, and the action buttons.
// The overview itself is read in Rust; `useOverview` asks for it again when the selection
// changes, a newer request superseding an older one.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import type { Invoke } from "./library-api";
import { BarChart, Histogram } from "./charts/charts";
import "./hygiene.css";
import "./selection-panel.css";

export interface Count {
  value: string;
  count: number;
}
export interface OverviewYears {
  min: number | null;
  max: number | null;
  histogram: { from: number; to: number; count: number }[];
  without: number;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const errorText = (e: unknown) => String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, "");

/** The overview `command` answers for `ids`, read again when they change or `version` does. */
export function useOverview<T>(invoke: Invoke, workspaceId: string, command: string, ids: string[], version = 0) {
  const [answer, setAnswer] = useState<{ key: string; overview: T }>();
  const key = useRef(`selection:${Math.random().toString(36).slice(2)}`);
  const idsKey = ids.join("\n");
  useEffect(() => {
    let live = true;
    // A short wait while the selection is still being extended (⇧-arrows, ⌘-clicks).
    const t = setTimeout(() => {
      void invoke<T>(command, { ids: idsKey ? idsKey.split("\n") : [], $supersede: key.current }, workspaceId)
        .then((overview) => live && setAnswer({ key: idsKey, overview }))
        .catch(() => {});
    }, 90);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [invoke, workspaceId, command, idsKey, version]);
  // An answer for an earlier selection stays shown (dimmed) until this one's arrives.
  return { overview: answer?.overview, stale: !!answer && answer.key !== idsKey };
}

export type Notice = { text: string; tone: "busy" | "done" | "error"; undo?: () => void; stop?: () => void };

/** The panel's notice and the helpers that set it around an action. */
export function useNotice() {
  const [notice, setNotice] = useState<Notice>();
  const say = (text: string, tone: Notice["tone"] = "done", undo?: () => void) => setNotice({ text, tone, undo });
  const attempt = async (busy: string, work: () => Promise<string | void>) => {
    setNotice({ text: busy, tone: "busy" });
    try {
      const text = await work();
      setNotice(text ? { text, tone: "done" } : undefined);
    } catch (e) {
      say(errorText(e), "error");
    }
  };
  return { notice, setNotice, say, attempt };
}

export function SelectionFrame({
  count,
  noun,
  label,
  summary,
  controls,
  notice,
  onNotice,
  onClear,
  overview,
  stale,
  children,
  footer,
}: {
  count: number;
  /** What is selected, singular (`source`, `work`). */
  noun: string;
  label: string;
  /** Under the heading: what kinds they are. */
  summary: string;
  /** In the sticky bar, before Clear. */
  controls?: ReactNode;
  notice?: Notice;
  onNotice: (notice?: Notice) => void;
  onClear: () => void;
  /** The overview's content; undefined while it is read. */
  overview?: ReactNode;
  stale?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const [pinned, setPinned] = useState(false);
  return (
    <div className="kx-selection" aria-label={label} onScroll={(e) => setPinned(e.currentTarget.scrollTop > 8)}>
      <header className="kx-selection-bar" data-pinned={pinned}>
        <span className="kx-selection-badge">
          <Icon name="layers" size={12} />
          {count.toLocaleString()}
        </span>
        <span className="kx-selection-bar-title">{pinned ? `${plural(count, noun)} selected` : ""}</span>
        {controls}
        <button className="kx-icon-button" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear}>
          <Icon name="close" size={13} />
        </button>
      </header>

      <div className="kx-selection-body">
        <div className="kx-selection-head">
          <h2>{plural(count, noun)} selected</h2>
          <p>{summary || " "}</p>
        </div>

        {notice && (
          <div className="kx-selection-notice" data-tone={notice.tone} role="status" aria-live="polite">
            {notice.tone === "busy" ? <span className="kx-search-spinner" /> : <Icon name={notice.tone === "error" ? "warning" : "check"} size={13} />}
            <span>{notice.text}</span>
            {notice.undo && <button onClick={notice.undo}>Undo</button>}
            {notice.tone === "busy" && notice.stop && <button onClick={notice.stop}>Stop</button>}
            {notice.tone !== "busy" && (
              <button className="kx-selection-notice-close" aria-label="Dismiss" onClick={() => onNotice(undefined)}>
                <Icon name="close" size={9} />
              </button>
            )}
          </div>
        )}

        <section className="kx-selection-section kx-selection-overview" aria-label="Overview" data-stale={stale || undefined}>
          {overview === undefined ? (
            <div className="kx-selection-loading">
              <div className="kx-skeleton-line" />
              <div className="kx-skeleton-line" />
            </div>
          ) : (
            overview
          )}
        </section>

        {children}

        {footer && <footer className="kx-selection-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export type Fact = [label: string, value: number, icon: IconName, tone?: "warn" | "muted"];

export function SelectionFacts({ facts }: { facts: Fact[] }) {
  return (
    <div className="kx-selection-facts">
      {facts.map(([label, value, icon, tone]) => (
        <div key={label} className="kx-selection-fact" data-tone={tone}>
          <Icon name={icon} size={12} />
          <strong>{value.toLocaleString()}</strong>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

/** Years, types, top authors and journals: the overview's charts. */
export function SelectionCharts({
  years,
  types,
  authors,
  authorCount,
  journals,
  journalCount,
  total,
  noun,
  children,
}: {
  years: OverviewYears;
  types: { label: string; value: number }[];
  authors: Count[];
  authorCount: number;
  journals: Count[];
  journalCount: number;
  total: number;
  /** Plural, for the charts' labels (`Sources by year`). */
  noun: string;
  /** More charts after the journals. */
  children?: ReactNode;
}) {
  const Noun = noun[0].toUpperCase() + noun.slice(1);
  return (
    <>
      {years.histogram.length > 0 && (
        <div className="kx-selection-chart">
          <h3>
            Years
            <span>
              {years.min === years.max ? years.min : `${years.min}–${years.max}`}
              {years.without > 0 ? ` · ${years.without.toLocaleString()} without a year` : ""}
            </span>
          </h3>
          {years.histogram.length > 1 && <Histogram bins={years.histogram} height={70} width={360} label={`${Noun} by year`} binFormat={(v) => String(Math.round(v))} />}
        </div>
      )}
      {types.length > 1 && (
        <div className="kx-selection-chart">
          <h3>Types</h3>
          <BarChart width={360} barHeight={12} label={`${Noun} by type`} items={types.slice(0, 6)} />
        </div>
      )}
      {authors.length > 0 && (
        <div className="kx-selection-chart">
          <h3>
            Top authors<span>{plural(authorCount, "author")}</span>
          </h3>
          <BarChart width={360} barHeight={12} max={total} label="Top authors" items={authors.slice(0, 5).map((a) => ({ label: a.value, value: a.count }))} />
        </div>
      )}
      {journals.length > 0 && (
        <div className="kx-selection-chart">
          <h3>
            Published in<span>{plural(journalCount, "venue")}</span>
          </h3>
          <BarChart width={360} barHeight={12} max={total} label="Top journals" items={journals.slice(0, 5).map((j) => ({ label: j.value, value: j.count, tone: "indigo" as const }))} />
        </div>
      )}
      {children}
    </>
  );
}

export function ActionButton({ icon, label, title, disabled, danger, primary, onClick }: { icon: IconName; label: string; title?: string; disabled?: boolean; danger?: boolean; primary?: boolean; onClick: () => void }) {
  return (
    <button className="kx-selection-button" data-danger={danger || undefined} data-primary={primary || undefined} title={title} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={13} />
      <span>{label}</span>
    </button>
  );
}
