// A review record and the library source it is linked to describe the same work twice. The host
// compares them (key-review library_sync.rs: trivial differences folded away) and runs every
// change on both sides as one undoable operation. Here: the quiet "N fields differ" chip, the
// sheet that compares the two field by field ("Take from library / Take from review / Keep as
// they are"), the "Possibly in your library" matches to confirm or reject, and the hook that
// tells open review views which linked records changed in the library (the change log).
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { bridge } from "../library-api";
import { GlobalDialog } from "../GlobalDrawer";
import { Btn, errorText } from "./review-ui";
import "./review-link-sync.css";

import type { Invoke } from "../library-api";
export type Choice = "library" | "review" | "keep";
export type FieldDiff = { field: string; label: string; review: unknown; library: unknown; state: "differ" | "reviewOnly" | "libraryOnly"; decided: Choice | null; pending: boolean };
export type LinkDiff = { recordId: string; sourceId: string; policy: "ask" | "library" | "review"; fields: FieldDiff[]; pending: number };
export type Suggestion = {
  recordId: string;
  sourceId: string;
  kind: "exact" | "likely";
  score: number;
  reason: string;
  record: { title: string; byline: string; journal?: string; year?: number | null; doi?: string };
  source: { title: string; byline: string; journal?: string; year?: number | null; doi?: string; hasFile?: boolean };
};
/** Where a change is made: undone from there (the review's ⌘Z, or the library's). */
export type Origin = "review" | "library";

export function linkApi(invoke: Invoke, workspaceId: string, reviewId: string) {
  const call = <T,>(command: string, args: Record<string, unknown> = {}) => invoke<T>(command, { reviewId, ...args }, workspaceId);
  return {
    diff: (recordId: string) => call<{ diff: LinkDiff; sourceTitle: string; trashed: boolean } | null>("review_link_diff", { recordId }),
    pending: () => call<Record<string, number>>("review_link_pending"),
    take: (recordId: string, fields: { field: string; choice: Choice }[], origin: Origin, actor: string) => call<{ op: string; label: string }>("review_link_take", { recordId, fields, origin, actor }),
    suggestions: () => call<{ count: number; suggestions: Suggestion[] }>("review_link_suggestions"),
    confirm: (recordId: string, sourceId: string, origin: Origin, actor: string) => call<{ op: string; conflict: unknown }>("review_link_confirm", { recordId, sourceId, origin, actor }),
    reject: (recordId: string, sourceId: string, origin: Origin, actor: string) => call<{ op: string }>("review_link_reject", { recordId, sourceId, origin, actor }),
    unlink: (recordId: string, origin: Origin, actor: string) => call<{ op: string }>("review_link_unlink", { recordId, origin, actor }),
    undo: (actor: string, redo = false) => call<{ recordId: string; label: string } | null>("review_link_undo", { actor, redo }),
    highlights: (recordId: string) => call<unknown[]>("review_highlights", { recordId }),
    applyHighlights: (recordId: string, upserts: unknown[], deleted: string[], actor: string) => call("review_highlights_apply", { recordId, upserts, deleted, actor }),
    carry: (recordId: string, carry: boolean, actor: string) => call<{ count: number; op?: string }>("review_highlights_carry", { recordId, carry, actor }),
  };
}

/** Undoes a link change where it was made: the review's link undo, or the library's ⌘Z. */
export function undoLink(invoke: Invoke, workspaceId: string, reviewId: string, origin: Origin, actor: string) {
  return origin === "library" ? invoke("store_undo", {}, workspaceId) : linkApi(invoke, workspaceId, reviewId).undo(actor);
}

const LIBRARY_EVENTS = ["library-changed", "library-sources-changed", "source-metadata-changed"];

/** Linked records whose library source changed (details, file, link) since this view last
 *  asked: no polling — library events, debounced so bulk edits and imports ask once. */
export function useLinkChanges(invoke: Invoke, workspaceId: string, reviewId: string, onChange: (records: Record<string, string[]>, all: boolean) => void) {
  const since = useRef(-1);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () =>
      void invoke<{ latest: number; records: Record<string, string[]>; all: boolean }>("review_link_changes", { reviewId, since: since.current }, workspaceId)
        .then((r) => {
          if (!live) return;
          const first = since.current < 0;
          since.current = Math.max(r.latest ?? 0, 0);
          if (!first && (r.all || Object.keys(r.records ?? {}).length)) latest.current(r.records ?? {}, !!r.all);
        })
        .catch(() => {});
    ask();
    const kick = (p?: unknown) => {
      const ws = (p as { workspaceId?: string } | undefined)?.workspaceId;
      if (ws && ws !== workspaceId) return;
      clearTimeout(timer);
      timer = setTimeout(ask, 250);
    };
    const offs = LIBRARY_EVENTS.map((e) => bridge().on?.(e, kick));
    return () => {
      live = false;
      clearTimeout(timer);
      offs.forEach((off) => off?.());
    };
  }, [invoke, workspaceId, reviewId]);
}

/** The quiet chip: how many details still differ from the library (nothing when none do). */
export function DiffChip({ count, onClick }: { count: number; onClick: () => void }) {
  if (!count) return null;
  return (
    <button type="button" className="kx-link-diff-chip" onClick={onClick} title="This record and your library describe the work differently. Compare them.">
      {count === 1 ? "1 field differs" : `${count} fields differ`}
    </button>
  );
}

const show = (v: unknown) => (v == null ? "" : Array.isArray(v) ? v.join("; ") : String(v));

/** One field's value, long ones (an abstract) folded until clicked. */
function Value({ v, empty }: { v: unknown; empty: string }) {
  const [open, setOpen] = useState(false);
  const text = show(v);
  if (!text) return <span className="kx-link-diff-empty">{empty}</span>;
  const long = text.length > 220;
  return (
    <span className="kx-link-diff-value" data-open={open || !long || undefined} onClick={() => long && setOpen(!open)} title={long && !open ? "Show all" : undefined}>
      {text}
    </span>
  );
}

const CHOICES: [Choice, string][] = [
  ["library", "Library"],
  ["review", "Review"],
  ["keep", "Keep"],
];

/** The two descriptions side by side, field by field, with a choice for each (and for all).
 *  Choices are remembered for the pair, so decided fields stay quiet until a value changes. */
export function LinkDiffSheet({ invoke, workspaceId, reviewId, recordId, actor, origin, onClose, onDone }: { invoke: Invoke; workspaceId: string; reviewId: string; recordId: string; actor: string; origin: Origin; onClose: () => void; onDone: (message: string, undo?: () => void) => void }) {
  const api = useMemo(() => linkApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const [data, setData] = useState<{ diff: LinkDiff; sourceTitle: string } | null>();
  const [picks, setPicks] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api.diff(recordId).then(
      (d) => {
        if (!live) return;
        setData(d);
        const start: Record<string, Choice> = {};
        for (const f of d?.diff.fields ?? []) {
          if (f.decided) start[f.field] = f.decided;
          else if (f.state === "libraryOnly") start[f.field] = "library";
          else if (f.state === "reviewOnly") start[f.field] = "review";
        }
        setPicks(start);
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [api, recordId]);
  const fields = data?.diff.fields ?? [];
  const changed = fields.filter((f) => picks[f.field] && picks[f.field] !== f.decided);
  const all = (c: Choice) => setPicks(Object.fromEntries(fields.map((f) => [f.field, c])));
  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      const done = await api.take(recordId, changed.map((f) => ({ field: f.field, choice: picks[f.field] })), origin, actor);
      onDone(done.label, () => void undoLink(invoke, workspaceId, reviewId, origin, actor));
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    setBusy(true);
    try {
      await api.unlink(recordId, origin, actor);
      onDone("Unlinked from the library", () => void undoLink(invoke, workspaceId, reviewId, origin, actor));
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <GlobalDialog label="Compare with your library" onClose={onClose} busy={busy}>
      <div className="kx-rv-dialog kx-link-diff" data-link-diff="">
        <h2>Compare with your library</h2>
        <p>
          This record and {data?.sourceTitle ? <>“{data.sourceTitle}” in your library</> : "its library source"} are the same work. Choose which description each place keeps; differences in case,
          punctuation, accents, name order or DOI form are not shown.
        </p>
        {data === undefined && !error && <p className="kx-rv-muted">Comparing…</p>}
        {data === null && <p className="kx-rv-muted">This record is not linked to your library.</p>}
        {data && !fields.length && <p className="kx-rv-muted">Both describe the work the same way.</p>}
        {fields.length > 0 && (
          <div className="kx-link-diff-grid" role="table" aria-label="Fields that differ">
            <div className="kx-link-diff-head" role="row">
              <span role="columnheader">Field</span>
              <span role="columnheader">In the review</span>
              <span role="columnheader">In your library</span>
              <span role="columnheader" className="kx-link-diff-all">
                <span>All:</span>
                {CHOICES.map(([c, label]) => (
                  <button key={c} type="button" className="kx-link-diff-all-btn" onClick={() => all(c)} title={c === "library" ? "Take every field from the library" : c === "review" ? "Take every field from the review" : "Keep every field as it is on each side"}>
                    {label}
                  </button>
                ))}
              </span>
            </div>
            {fields.map((f) => (
              <div key={f.field} className="kx-link-diff-row" role="row" data-field={f.field} data-pending={f.pending || undefined}>
                <span className="kx-link-diff-label" role="cell">
                  {f.label}
                  {f.decided && !f.pending && <small>{f.decided === "keep" ? "kept as they are" : "decided"}</small>}
                </span>
                <span role="cell" data-side="review" data-chosen={picks[f.field] === "review" || undefined}>
                  <Value v={f.review} empty="Not in the review" />
                </span>
                <span role="cell" data-side="library" data-chosen={picks[f.field] === "library" || undefined}>
                  <Value v={f.library} empty="Not in your library" />
                </span>
                <span role="cell">
                  <span className="kx-rv-seg kx-link-diff-seg" role="radiogroup" aria-label={`${f.label}: take from`}>
                    {CHOICES.map(([c, label]) => (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={picks[f.field] === c}
                        title={c === "library" ? "Take from library" : c === "review" ? "Take from review" : "Keep as they are"}
                        disabled={(c === "library" && f.state === "reviewOnly") || (c === "review" && f.state === "libraryOnly")}
                        onClick={() => setPicks((p) => ({ ...p, [f.field]: c }))}
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          {data ? (
            <Btn quiet small icon="link" onClick={() => void unlink()} disabled={busy} title="Not the same work after all: the record keeps a copy of the full text and is not linked again">
              Unlink…
            </Btn>
          ) : (
            <span />
          )}
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn primary onClick={() => void apply()} disabled={busy || !changed.length}>
            {changed.length > 1 ? `Apply ${changed.length} choices` : "Apply"}
          </Btn>
        </div>
      </div>
    </GlobalDialog>
  );
}

/** Records that are likely in the library already, one pair at a time: confirm (they are
 *  linked and share one full text) or reject (never suggested again). Nothing links itself. */
export function PossibleMatchesSheet({ invoke, workspaceId, reviewId, actor, onClose, onChanged, notify }: { invoke: Invoke; workspaceId: string; reviewId: string; actor: string; onClose: () => void; onChanged: () => void; notify: (text: string, tone?: "error" | "ok", action?: { label: string; run: () => void }) => void }) {
  const api = useMemo(() => linkApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const [list, setList] = useState<Suggestion[]>();
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api.suggestions().then(
      (r) => setList(r.suggestions),
      (e) => notify(errorText(e), "error"),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  const pair = list?.[Math.min(at, (list?.length ?? 1) - 1)];
  const decide = async (yes: boolean) => {
    if (!pair) return;
    setBusy(true);
    try {
      if (yes) await api.confirm(pair.recordId, pair.sourceId, "review", actor);
      else await api.reject(pair.recordId, pair.sourceId, "review", actor);
      notify(yes ? "Linked: one full text for both" : "Marked as a different work", "ok", { label: "Undo", run: () => void api.undo(actor).then(() => (onChanged(), void load())) });
      onChanged();
      setList((l) => l?.filter((s) => s !== pair));
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const side = (title: string, w: Suggestion["record"], extra?: string) => (
    <div className="kx-rv-pair-side">
      <small>{title}</small>
      <strong>{w.title || "Untitled"}</strong>
      <small>{[w.byline, w.journal].filter(Boolean).join(" · ")}</small>
      {w.doi && <small>DOI {w.doi}</small>}
      {extra && <small className="kx-link-match-extra">{extra}</small>}
    </div>
  );
  return (
    <GlobalDialog label="Possibly in your library" onClose={onClose} busy={busy}>
      <div className="kx-rv-dialog kx-link-matches" data-possible-matches="">
        <h2>Possibly in your library</h2>
        <p>These records look like works your library has. Confirm a pair to link them — they then share one full text and their details can be compared — or say they are different works.</p>
        {list === undefined && <p className="kx-rv-muted">Looking through your library…</p>}
        {list?.length === 0 && <p className="kx-rv-muted">No more possible matches.</p>}
        {pair && (
          <>
            <div className="kx-link-match-why">
              <span>
                {Math.min(at, list!.length - 1) + 1} of {list!.length}
              </span>
              <span className="kx-link-match-reason">{pair.kind === "exact" ? "Same identifiers" : pair.reason || "Similar title, year and first author"}</span>
            </div>
            <div className="kx-rv-pair">
              {side("In the review", pair.record)}
              {side("In your library", pair.source, pair.source.hasFile ? "Has a full text" : undefined)}
            </div>
            <div className="kx-rv-dialog-actions">
              <span className="kx-link-match-nav">
                <Btn quiet small icon="chevronLeft" aria-label="Previous pair" disabled={busy || at <= 0} onClick={() => setAt(at - 1)} />
                <Btn quiet small icon="chevronRight" aria-label="Next pair" disabled={busy || at >= list!.length - 1} onClick={() => setAt(at + 1)} />
              </span>
              <Btn onClick={() => void decide(false)} disabled={busy}>
                Different works
              </Btn>
              <Btn primary onClick={() => void decide(true)} disabled={busy}>
                Same work — link
              </Btn>
            </div>
          </>
        )}
        {list?.length === 0 && (
          <div className="kx-rv-dialog-actions">
            <Btn primary onClick={onClose}>
              Done
            </Btn>
          </div>
        )}
      </div>
    </GlobalDialog>
  );
}

/** How many records may be in the library (refreshed with the library and the review). */
export function usePossibleCount(invoke: Invoke, workspaceId: string, reviewId: string, revision: unknown) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => void linkApi(invoke, workspaceId, reviewId).suggestions().then((r) => live && setCount(r.count), () => {});
    load();
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    };
    const offs = ["library-changed", "review-changed"].map((e) => bridge().on?.(e, kick));
    return () => {
      live = false;
      clearTimeout(timer);
      offs.forEach((o) => o?.());
    };
  }, [invoke, workspaceId, reviewId, revision]);
  return count;
}

/** The chip in the Records toolbar that opens the matches. */
export function PossibleChip({ count, onClick }: { count: number; onClick: () => void }) {
  if (!count) return null;
  return (
    <button type="button" className="kx-link-possible-chip" onClick={onClick} data-possible-chip="" title="Records that look like works already in your library: confirm or reject each">
      <Icon name="books" size={11} /> Possibly in your library ({count})
    </button>
  );
}
