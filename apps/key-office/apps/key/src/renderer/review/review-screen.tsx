// Title & abstract and full-text screening. "Screen" shows one record at a time, keyboard first
// (I include, E exclude, M maybe, 1–9 reasons, N note, ⌘Z undo, J/K next/previous), with the
// review's keywords marked, rule and AI suggestions, and the next record as soon as a decision
// is made. "List" pages through every record with filters and batch decisions. "Conflicts" is
// the queue of records reviewers disagree on, for whoever may resolve them. At full text the
// record's PDF opens in Key's reader beside this tab, and its highlights can back a decision.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, Hint } from "../explain";
import { Icon } from "../icons";
import { bridge, type Source } from "../library-api";
import { findPdf } from "../find-pdf";
import { highlightPage, type Highlight } from "../item-actions";
import { GlobalDialog } from "../GlobalDrawer";
import { CHOICE_LABEL, ELEMENT_LABEL, STAGE_LABEL, plural, reasonText, type Choice, type Criterion, type DecisionInfo, type Evidence, type ListRow, type RecordView, type Stage } from "./review-api";
import { Btn, Highlighted, MenuButton, StatusPill, errorText, formatDate } from "./review-ui";
import type { StageProps } from "./ReviewPage";

type Mode = "screen" | "list" | "conflicts";

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function Screening(props: StageProps & { stage: Stage }) {
  const { summary, stage } = props;
  const counts = summary.stages[stage];
  const [mode, setMode] = useState<Mode>("screen");
  const [focus, setFocus] = useState<string>();
  const conflicts = counts.conflicts;
  if (!summary.active) {
    return <EmptyState help="empty.review.screen" icon="checklist" action={{ label: "Add records", icon: "plus", onClick: () => props.go("sources") }} learnMore="review.screening" />;
  }
  if (stage === "ft" && !counts.eligible) {
    return <EmptyState help="empty.review.fulltext" icon="filePdf" action={{ label: "Screen titles and abstracts", onClick: () => props.go("ta") }} learnMore="review.fulltext" />;
  }
  return (
    <div className="kx-rv-screening" data-mode={mode}>
      <div className="kx-rv-toolbar">
        <div className="kx-rv-seg" role="radiogroup" aria-label="Screening view">
          {(
            [
              ["screen", "Screen", ""],
              ["list", "List", ""],
              ["conflicts", "Conflicts", conflicts ? String(conflicts) : ""],
            ] as const
          ).map(([id, label, badge]) => (
            <button key={id} type="button" role="radio" aria-checked={mode === id} onClick={() => setMode(id)}>
              {label}
              {badge && <span className="kx-rv-seg-badge">{badge}</span>}
            </button>
          ))}
        </div>
        <Progress {...props} />
      </div>
      {mode === "list" ? (
        <RecordList
          {...props}
          onOpen={(id) => {
            setFocus(id);
            setMode("screen");
          }}
        />
      ) : (
        <SingleRecord key={mode} {...props} stage={stage} filter={mode === "conflicts" ? "conflicts" : ""} focus={focus} onFocused={() => setFocus(undefined)} />
      )}
    </div>
  );
}

function Progress({ summary, stage }: StageProps & { stage: Stage }) {
  const c = summary.stages[stage];
  const pct = c.eligible ? Math.round((c.done / c.eligible) * 100) : 0;
  return (
    <div className="kx-rv-progress" title={`${c.done} of ${c.eligible} decided · ${c.included} included · ${c.excluded} excluded${c.maybe ? ` · ${c.maybe} maybe` : ""}`}>
      <span className="kx-rv-progress-bar" aria-hidden="true">
        <span data-tone="green" style={{ width: `${c.eligible ? (c.included / c.eligible) * 100 : 0}%` }} />
        <span data-tone="amber" style={{ width: `${c.eligible ? (c.maybe / c.eligible) * 100 : 0}%` }} />
        <span data-tone="red" style={{ width: `${c.eligible ? (c.excluded / c.eligible) * 100 : 0}%` }} />
      </span>
      <span>
        {pct}% decided · <strong>{c.mine.toLocaleString()}</strong> waiting for you
        {c.partial ? ` · ${c.partial.toLocaleString()} need another reviewer` : ""}
      </span>
    </div>
  );
}

// ── One record at a time ───────────────────────────────────────────────────────────

function SingleRecord(props: StageProps & { stage: Stage; filter: string; focus?: string; onFocused: () => void }) {
  const { api, summary, viewer, stage, filter, active, notify, onChanged, workspaceId, invoke } = props;
  const protocol = summary.protocol;
  const rule = protocol.rules[stage];
  const [queue, setQueue] = useState<string[]>();
  const [index, setIndex] = useState(0);
  /** Records decided in this session, to step back to. */
  const [history, setHistory] = useState<string[]>([]);
  const [current, setCurrent] = useState<string>();
  const [view, setView] = useState<RecordView>();
  const [loading, setLoading] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [picking, setPicking] = useState<Choice>();
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [cheats, setCheats] = useState(false);
  const [askingAi, setAskingAi] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el?.closest(".kx-rv-stages, .kx-rv-seg")) el.blur();
  }, []);
  // The stage's criteria: what is shown beside the record and what an exclusion names.
  const reasonsFor = protocol.criteria.filter((c) => !c.stages.length || c.stages.includes(stage));

  const loadQueue = useCallback(
    (keep?: string) =>
      api.queue(stage, viewer, filter).then((q) => {
        setQueue(q);
        const at = keep ? q.indexOf(keep) : -1;
        setIndex(at >= 0 ? at : 0);
        return q;
      }),
    [api, stage, viewer, filter],
  );
  useEffect(() => {
    if (!viewer) return;
    void loadQueue().then((q) => {
      if (props.focus) {
        setCurrent(props.focus);
        props.onFocused();
      } else setCurrent(q[0]);
    }).catch((e) => notify(errorText(e), "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadQueue]);

  const load = useCallback(
    (id: string | undefined) => {
      if (!id) return setView(undefined);
      setLoading(true);
      api
        .record(id, stage, viewer)
        .then((v) => {
          setView(v);
          setReasons(v.mine?.reasons ?? []);
          setNote(v.mine?.note ?? "");
          setEvidence(v.mine?.evidence ?? []);
          setPicking(undefined);
        })
        .catch((e) => notify(errorText(e), "error"))
        .finally(() => setLoading(false));
    },
    [api, stage, viewer, notify],
  );
  useEffect(() => load(current), [current, load]);

  const advance = useCallback(
    (decided: string) => {
      setHistory((h) => [...h.filter((x) => x !== decided), decided].slice(-200));
      void loadQueue().then((q) => {
        // The next record after the one decided, in queue order.
        const old = queue ?? [];
        const from = old.indexOf(decided);
        const next = old.slice(from + 1).find((id) => q.includes(id)) ?? q[0];
        setCurrent(next);
        setIndex(Math.max(0, q.indexOf(next ?? "")));
      });
      onChanged();
    },
    [loadQueue, onChanged, queue],
  );

  // Reviewers who excluded for different criteria are not in conflict; at full text whoever may
  // resolve can settle which criterion is reported.
  const settling = stage === "ft" && !!view?.reasonsDiffer && summary.canResolve;
  const resolving = (view?.status.name === "conflict" || settling) && summary.canResolve;

  const decide = useCallback(
    async (value: Choice, chosen = reasons) => {
      if (!view || !current) return;
      const needs = value === "exclude" && reasonsFor.length ? rule.reasons : "none";
      if (value === "maybe" && !rule.maybe) return notify(`“Maybe” is off for ${STAGE_LABEL[stage].toLowerCase()} (Setup › Rules)`, "error");
      if (needs === "one" && chosen.length !== 1) {
        setPicking("exclude");
        setReasons(chosen.slice(0, 1));
        return;
      }
      if (needs === "all" && !chosen.length) {
        setPicking("exclude");
        return;
      }
      try {
        if (resolving) await api.resolve(current, stage, value, value === "exclude" ? chosen : [], note, viewer);
        else await api.decide([current], stage, value, value === "exclude" ? chosen : [], note, viewer, evidence);
        advance(current);
      } catch (e) {
        notify(errorText(e), "error");
      }
    },
    [view, current, rule, reasons, reasonsFor.length, note, evidence, resolving, api, stage, viewer, advance, notify],
  );

  const undo = useCallback(async () => {
    try {
      const back = await api.undo(viewer);
      if (!back) return notify("Nothing to undo");
      await loadQueue(back.recordId);
      setCurrent(back.recordId);
      onChanged();
      notify(`Took back your decision`, "ok");
    } catch (e) {
      notify(errorText(e), "error");
    }
  }, [api, viewer, loadQueue, onChanged, notify]);

  const step = useCallback(
    (by: number) => {
      if (!queue) return;
      if (by < 0 && history.length && (!current || queue.indexOf(current) <= 0)) {
        const prev = history.filter((h) => h !== current).at(-1);
        if (prev) return setCurrent(prev);
      }
      const at = current ? queue.indexOf(current) : -1;
      const next = at < 0 ? (by > 0 ? queue[0] : history.at(-1)) : queue[Math.min(queue.length - 1, Math.max(0, at + by))];
      if (next) {
        setCurrent(next);
        setIndex(queue.indexOf(next));
      }
    },
    [queue, current, history],
  );

  // Keys: only while this tab shows and nothing is being typed into.
  useEffect(() => {
    if (!active) return;
    const keys = { include: protocol.shortcuts.include || "i", exclude: protocol.shortcuts.exclude || "e", maybe: protocol.shortcuts.maybe || "m" };
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".key-global-drawer.key-modal")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !isTyping(e.target)) {
        e.preventDefault();
        void undo();
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === keys.include) void decide("include");
      else if (k === keys.exclude) void decide("exclude");
      else if (k === keys.maybe) void decide("maybe");
      else if (k === "j" || e.key === "ArrowRight") step(1);
      else if (k === "k" || e.key === "ArrowLeft") step(-1);
      else if (k === "u") void undo();
      else if (k === "n") {
        e.preventDefault();
        noteRef.current?.focus();
      } else if (k === "?") setCheats(true);
      else if (/^[1-9]$/.test(k)) {
        const r = reasonsFor[Number(k) - 1];
        if (!r) return;
        const next = reasons.includes(r.id) ? reasons.filter((x) => x !== r.id) : rule.reasons === "one" ? [r.id] : [...reasons, r.id];
        setReasons(next);
        // With one reason to choose, choosing it while excluding is the decision.
        if (picking === "exclude" && rule.reasons === "one") void decide("exclude", next);
      } else if (e.key === "Enter" && picking === "exclude") void decide("exclude");
      else if (e.key === "Escape" && picking) setPicking(undefined);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, decide, step, undo, reasons, picking, rule.reasons, reasonsFor, protocol.shortcuts]);

  if (!queue) return <div className="kx-rv-loading" aria-busy="true" />;
  if (!current || (!view && !loading)) {
    return <QueueDone {...props} stage={stage} filter={filter} onUndo={undo} canGoBack={history.length > 0} onBack={() => setCurrent(history.at(-1))} />;
  }
  const position = queue.indexOf(current);
  return (
    <div className="kx-rv-single" aria-busy={loading}>
      <article className="kx-rv-record" aria-label="Record">
        {view && <RecordCard {...props} view={view} />}
      </article>
      <aside className="kx-rv-decide" aria-label="Decision">
        <div className="kx-rv-decide-head">
          <span className="kx-rv-muted">{position >= 0 ? `${(position + 1).toLocaleString()} of ${queue.length.toLocaleString()}` : "Decided"}</span>
          <span className="kx-rv-nav">
            <button type="button" className="kx-rv-icon" aria-label="Previous record" title="Previous (K)" onClick={() => step(-1)}>
              <Icon name="chevronLeft" size={14} />
            </button>
            <button type="button" className="kx-rv-icon" aria-label="Next record" title="Next (J)" onClick={() => step(1)}>
              <Icon name="chevronRight" size={14} />
            </button>
            <button type="button" className="kx-rv-icon" aria-label="Undo last decision" title="Undo (⌘Z)" onClick={() => void undo()}>
              <Icon name="undo" size={14} />
            </button>
            <button type="button" className="kx-rv-icon" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setCheats(true)}>
              <Icon name="info" size={14} />
            </button>
          </span>
        </div>
        {view && (
          <>
            {view.status.name !== "undecided" && (
              <div className="kx-rv-state">
                <StatusPill status={view.status} />
                {view.pilot && <span className="kx-rv-pill" data-tone="info">{view.pilot.name}</span>}
                {view.flagged && <span className="kx-rv-pill" data-tone="amber" title="The protocol changed after this was decided">Re-screen</span>}
              </div>
            )}
            {resolving && !settling && <p className="kx-rv-resolve-note">Reviewers disagree. Your choice settles it{summary.protocol.rules.conflicts === "third" ? " as tie-breaker" : ""}.</p>}
            {settling && <p className="kx-rv-resolve-note" data-soft>Excluded by everyone, for different criteria. PRISMA reports the first in the list; choose the one to report to settle it.</p>}
            {(view.others.length > 0 || view.resolution) && <Decisions view={view} summary={summary} />}
            {view.suggestions.length > 0 && (
              <div className="kx-rv-suggestions">
                {view.suggestions.map((s) => (
                  <button
                    key={s.criterionId}
                    type="button"
                    className="kx-rv-suggestion"
                    title={s.auto ? "Applied automatically to undecided records; you can still decide otherwise" : "Choose to exclude with this reason"}
                    onClick={() => {
                      const r = s.reasonId ? [s.reasonId] : [];
                      setReasons(r);
                      void decide("exclude", r);
                    }}
                  >
                    <Icon name="function" size={11} />
                    <span>
                      <strong>Suggested: exclude</strong> {s.rule}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {view.ai && (
              <div className="kx-rv-ai" data-value={view.ai.value}>
                <Icon name="sparkle" size={11} />
                <span>
                  <strong>AI suggests {CHOICE_LABEL[view.ai.value].toLowerCase()}</strong>
                  {view.ai.score != null && ` · relevance ${Math.round(view.ai.score * 100)}%`} — {view.ai.rationale}
                </span>
              </div>
            )}
            <div className="kx-rv-choices" role="group" aria-label="Decide">
              <ChoiceButton value="include" mine={view.mine?.value} k={protocol.shortcuts.include || "I"} onClick={() => void decide("include")} />
              {rule.maybe && <ChoiceButton value="maybe" mine={view.mine?.value} k={protocol.shortcuts.maybe || "M"} onClick={() => void decide("maybe")} />}
              <ChoiceButton value="exclude" mine={view.mine?.value} k={protocol.shortcuts.exclude || "E"} picking={picking === "exclude"} onClick={() => void decide("exclude")} />
            </div>
            <CriteriaPicker
              criteria={reasonsFor}
              checks={view.checks}
              rule={rule.reasons}
              selected={reasons}
              picking={picking === "exclude"}
              onToggle={(id) => {
                const next = reasons.includes(id) ? reasons.filter((x) => x !== id) : rule.reasons === "one" ? [id] : [...reasons, id];
                setReasons(next);
                // With one criterion to name, naming it while excluding is the decision.
                if (picking === "exclude" && rule.reasons === "one") void decide("exclude", next);
              }}
              onConfirm={() => void decide("exclude")}
            />
            {stage === "ft" && <FullTextPanel {...props} view={view} evidence={evidence} setEvidence={setEvidence} reload={() => load(current)} />}
            <label className="kx-rv-note">
              <span>
                Note <kbd>N</kbd>
              </span>
              <textarea ref={noteRef} value={note} rows={2} placeholder="Why, or what to check" onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()} />
            </label>
            <Labels {...props} view={view} recordId={current} reload={() => load(current)} />
            {summary.protocol.rules.aiAssist && (
              <Btn
                small
                icon="sparkle"
                disabled={askingAi}
                title="Ask the AI model chosen in Key Settings › AI assistant for a suggestion. It is never a decision."
                onClick={() => {
                  setAskingAi(true);
                  api
                    .aiSuggest(current, stage)
                    .then(() => load(current))
                    .catch((e) => notify(errorText(e), "error"))
                    .finally(() => setAskingAi(false));
                }}
              >
                {askingAi ? "Asking…" : "Ask AI for a suggestion"}
              </Btn>
            )}
          </>
        )}
      </aside>
      {cheats && <CheatSheet onClose={() => setCheats(false)} shortcuts={protocol.shortcuts} />}
    </div>
  );
}

/** The stage's criteria: the rules beside the record and, when excluding, the choice of the
 * ones it fails (numbers 1–9 pick them). One list, in the protocol's order. */
function CriteriaPicker({ criteria, checks, rule, selected, picking, onToggle, onConfirm }: { criteria: Criterion[]; checks: RecordView["checks"]; rule: "none" | "one" | "all"; selected: string[]; picking: boolean; onToggle: (id: string) => void; onConfirm: () => void }) {
  if (!criteria.length) return <p className="kx-rv-muted kx-rv-no-criteria">No criteria for this stage yet: add them in Setup › Criteria, and excluding will ask which one a record fails.</p>;
  const grouped = criteria.length > 9;
  const hint = picking ? (rule === "one" ? "Which one does it fail? Press its number" : "Tick each it fails, then Enter") : rule === "none" ? "Excluding? Tick the ones it fails (optional)" : "Exclude, then pick the one it fails";
  let lastElement = "";
  return (
    <fieldset className="kx-rv-criteria-pick" data-picking={picking || undefined}>
      <legend>
        Criteria <span className="kx-rv-muted">· {hint}</span>
      </legend>
      {criteria.map((c, i) => {
        const check = checks.find((x) => x.criterionId === c.id);
        const state = !check ? undefined : check.met == null ? "unknown" : check.met ? "ok" : "fails";
        const on = selected.includes(c.id);
        const heading = grouped && c.element !== lastElement ? (ELEMENT_LABEL[c.element] ?? c.element) : null;
        lastElement = c.element;
        return (
          <div key={c.id} className="kx-rv-criteria-item">
            {heading && <h4>{heading}</h4>}
            <label title={c.guidance || undefined} data-state={state} data-on={on || undefined}>
              <input type={rule === "one" ? "radio" : "checkbox"} name="criterion" checked={on} onChange={() => onToggle(c.id)} />
              {i < 9 ? <kbd>{i + 1}</kbd> : <span className="kx-rv-kbd-space" />}
              <span>
                {c.label}
                {on ? <small>Reason: {reasonText(c)}</small> : check && <small>{check.met == null ? `${check.rule}: not known` : check.met ? check.rule : `Not met: ${check.rule}`}</small>}
              </span>
              {state && <Icon name={state === "ok" ? "check" : state === "fails" ? "close" : "info"} size={11} />}
            </label>
          </div>
        );
      })}
      {picking && rule === "all" && (
        <Btn primary small disabled={!selected.length} onClick={onConfirm}>
          Exclude
        </Btn>
      )}
    </fieldset>
  );
}

function ChoiceButton({ value, mine, k, onClick, picking }: { value: Choice; mine?: Choice; k: string; onClick: () => void; picking?: boolean }) {
  return (
    <button type="button" className="kx-rv-choice" data-value={value} aria-pressed={mine === value} data-picking={picking || undefined} onClick={onClick}>
      <Icon name={value === "include" ? "check" : value === "exclude" ? "close" : "minus"} size={14} />
      <span>{CHOICE_LABEL[value]}</span>
      <kbd>{k.toUpperCase()}</kbd>
    </button>
  );
}

function Decisions({ view, summary }: { view: RecordView; summary: StageProps["summary"] }) {
  const reason = (id: string) => {
    const c = summary.protocol.criteria.find((x) => x.id === id);
    return c ? reasonText(c) : id;
  };
  const row = (d: DecisionInfo, label?: string) => (
    <li key={d.event} data-value={d.value}>
      <span className="kx-rv-avatar" title={d.reviewerName}>
        {d.reviewer === "rules" ? <Icon name="function" size={10} /> : d.reviewerName.slice(0, 1)}
      </span>
      <span>
        <strong>{label ?? d.reviewerName}</strong> {CHOICE_LABEL[d.value].toLowerCase()}
        {d.reasons.length > 0 && `: ${d.reasons.map(reason).join(", ")}`}
        {d.note && <small>“{d.note}”</small>}
        {d.versionNumber != null && d.versionNumber !== summary.versionNumber && <small>under protocol version {d.versionNumber}</small>}
      </span>
    </li>
  );
  return (
    <ul className="kx-rv-decisions">
      {view.others.map((d) => row(d))}
      {view.resolution && row(view.resolution, view.resolution.auto ? "Rule" : `Resolved by ${view.resolution.reviewerName}`)}
    </ul>
  );
}

function RecordCard({ view, stage, summary }: { view: RecordView; stage: Stage } & StageProps) {
  const m = view.meta;
  const kw = summary.protocol.keywords;
  const [more, setMore] = useState(false);
  const abstract = m.abstractText ?? "";
  return (
    <>
      <div className="kx-rv-record-meta">
        {m.journal && <span>{m.journal}</span>}
        {m.year && <span>{m.year}</span>}
        {m.itemType && <span>{m.itemType.replace(/([A-Z])/g, " $1").toLowerCase()}</span>}
        {view.batch && <span title="Where this record came from">{view.batch.name}</span>}
      </div>
      <h2 className="kx-rv-record-title">
        <Highlighted text={m.title || "Untitled"} include={kw.include} exclude={kw.exclude} />
      </h2>
      {m.authors.length > 0 && <p className="kx-rv-authors">{m.authors.slice(0, more ? undefined : 8).join("; ")}{m.authors.length > 8 && !more && <button type="button" className="kx-link-button" onClick={() => setMore(true)}> +{m.authors.length - 8} more</button>}</p>}
      {abstract ? (
        <div className="kx-rv-abstract">
          {abstract.split(/\n{2,}/).map((para, i) => (
            <p key={i}>
              <Highlighted text={para} include={kw.include} exclude={kw.exclude} />
            </p>
          ))}
        </div>
      ) : (
        <p className="kx-rv-no-abstract">No abstract. Decide from the title, or keep it for full-text screening with Maybe.</p>
      )}
      {m.keywords && m.keywords.length > 0 && (
        <div className="kx-rv-keywords">
          {m.keywords.slice(0, 24).map((k) => (
            <span key={k}>{k}</span>
          ))}
        </div>
      )}
      <div className="kx-rv-ids">
        {m.doi && (
          <button type="button" className="kx-link-button" onClick={() => void bridge().tabAction("open-url", { url: `https://doi.org/${m.doi}` })}>
            doi:{m.doi}
          </button>
        )}
        {m.pmid && (
          <button type="button" className="kx-link-button" onClick={() => void bridge().tabAction("open-url", { url: `https://pubmed.ncbi.nlm.nih.gov/${m.pmid}/` })}>
            PMID {m.pmid}
          </button>
        )}
        {stage === "ft" && view.earlier?.resolution === null && view.earlier.decisions.length === 0 && view.earlier.mine && <span className="kx-rv-muted">Title & abstract: {CHOICE_LABEL[view.earlier.mine.value]}</span>}
      </div>
      {view.notes.length > 0 && (
        <ul className="kx-rv-notes">
          {view.notes.map((n) => (
            <li key={n.id}>
              <strong>{summary.team.find((t) => t.id === n.reviewer)?.name ?? n.reviewer}</strong> {n.text} <small>{formatDate(n.at)}</small>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Labels({ api, summary, view, recordId, viewer, reload, notify }: StageProps & { view: RecordView; recordId: string; reload: () => void }) {
  const all = [...new Set([...summary.protocol.labels, ...summary.labelsInUse])];
  if (!all.length && !view.labels.length) return null;
  return (
    <div className="kx-rv-labels" aria-label="Labels">
      {all.map((l) => {
        const on = view.labels.includes(l);
        return (
          <button
            key={l}
            type="button"
            className="kx-rv-label"
            aria-pressed={on}
            onClick={() =>
              void api
                .labels([recordId], on ? [] : [l], on ? [l] : [], viewer)
                .then(reload)
                .catch((e) => notify(errorText(e), "error"))
            }
          >
            {on && <Icon name="check" size={10} />}
            {l}
          </button>
        );
      })}
    </div>
  );
}

// ── Full text ───────────────────────────────────────────────────────────────────

/** Opens a library source's PDF (or saved page) in Key's reader, in a group beside this tab. */
export async function openFullText(invoke: StageProps["invoke"], workspaceId: string, sourceId: string) {
  const source = await invoke<Source | null>("store_source", { id: sourceId }, workspaceId);
  if (!source) throw Error("The library source is gone");
  const hash = source.fileHash;
  if (source.kind === "web") {
    await bridge().tabAction("open-content", { section: "webpage", workspaceId, sourceId, title: source.title });
    return true;
  }
  if (!hash) return false;
  await bridge().tabAction("open-source-page", { workspaceId, sourceId, title: source.title || "Untitled", read: true, pdf: { documentId: hash, documentHash: hash, title: source.title || "Untitled", pageCount: source.pageCount ?? 0, workspaceId } });
  await bridge().tabAction("split", { viewId: `pdf:${workspaceId}:${hash}`, edge: "right" });
  return true;
}

function FullTextPanel({ api, invoke, workspaceId, viewer, view, notify, evidence, setEvidence, reload, onChanged }: StageProps & { view: RecordView; evidence: Evidence[]; setEvidence: (e: Evidence[]) => void; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notRetrieved, setNotRetrieved] = useState(false);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [hasFile, setHasFile] = useState<boolean>();
  const sourceId = view.sourceId;
  const refreshSource = useCallback(() => {
    if (!sourceId) return;
    void invoke<Source | null>("store_source", { id: sourceId }, workspaceId).then((s) => setHasFile(!!s?.fileHash || s?.kind === "web")).catch(() => {});
    void invoke<Highlight[]>("library_annotations", { hash: sourceId }, workspaceId).then((h) => setHighlights((h ?? []).filter((x) => x.text))).catch(() => setHighlights([]));
  }, [invoke, workspaceId, sourceId]);
  useEffect(() => {
    refreshSource();
    const off = bridge().on?.("library-changed", refreshSource);
    window.addEventListener("focus", refreshSource);
    return () => {
      off?.();
      window.removeEventListener("focus", refreshSource);
    };
  }, [refreshSource]);
  const run = (task: () => Promise<unknown>) => {
    setBusy(true);
    task()
      .catch((e) => notify(errorText(e), "error"))
      .finally(() => setBusy(false));
  };
  const open = () =>
    run(async () => {
      let id = sourceId;
      if (!id) {
        const linked = await api.linkLibrary([view.meta.id], viewer);
        id = linked[view.meta.id];
        reload();
        onChanged();
      }
      if (!id) throw Error("Could not add the record to the library");
      const opened = await openFullText(invoke, workspaceId, id);
      if (!opened) {
        const result = await findPdf(invoke, workspaceId, { id, title: view.meta.title });
        if (result.status === "attached") {
          await api.fulltext(view.meta.id, { status: "retrieved" }, viewer);
          await openFullText(invoke, workspaceId, id);
        } else await api.fulltext(view.meta.id, { status: "sought" }, viewer);
        reload();
        onChanged();
      } else if (view.fulltext.status !== "retrieved") {
        await api.fulltext(view.meta.id, { status: "retrieved" }, viewer);
        onChanged();
      }
    });
  const attached = new Set(evidence.map((e) => e.annotationId));
  return (
    <section className="kx-rv-fulltext" aria-label="Full text">
      <div className="kx-rv-fulltext-row">
        <Btn icon="filePdf" primary={!view.fulltext.status || view.fulltext.status === "sought"} disabled={busy} onClick={open} title="Opens the PDF in Key's reader beside this tab; finds an open-access copy or opens the publisher's page when the library has none">
          {busy ? "Opening…" : sourceId && hasFile ? "Open full text beside" : "Find full text"}
        </Btn>
        {view.fulltext.status === "notRetrieved" ? (
          <Btn small onClick={() => run(() => api.fulltext(view.meta.id, { status: "sought" }, viewer).then(() => (reload(), onChanged())))}>Found it after all</Btn>
        ) : (
          <Btn small quiet onClick={() => setNotRetrieved(true)}>
            Not retrieved…
          </Btn>
        )}
      </div>
      {view.fulltext.status && (
        <p className="kx-rv-muted">
          {view.fulltext.status === "notRetrieved" ? `Not retrieved: ${view.fulltext.reason}` : view.fulltext.status === "retrieved" ? "Full text retrieved" : "Full text sought"}
        </p>
      )}
      {sourceId && (
        <details className="kx-rv-evidence" open={highlights.length > 0}>
          <summary>
            Evidence from highlights {evidence.length > 0 && <span className="kx-rv-seg-badge">{evidence.length}</span>}
          </summary>
          {highlights.length === 0 ? (
            <Hint help="review.evidence" />
          ) : (
            <ul>
              {highlights.slice(0, 40).map((h) => {
                const on = attached.has(h.id);
                return (
                  <li key={h.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setEvidence(on ? evidence.filter((e) => e.annotationId !== h.id) : [...evidence, { quote: h.text ?? "", page: highlightPage(h) ?? null, annotationId: h.id }])}
                      />
                      <span>
                        “{(h.text ?? "").slice(0, 220)}”{highlightPage(h) != null && <small> p. {(highlightPage(h) ?? 0) + 1}</small>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </details>
      )}
      {notRetrieved && <NotRetrievedSheet onClose={() => setNotRetrieved(false)} onSave={(reason) => api.fulltext(view.meta.id, { status: "notRetrieved", reason }, viewer).then(() => (reload(), onChanged()))} />}
    </section>
  );
}

function NotRetrievedSheet({ onClose, onSave }: { onClose: () => void; onSave: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState("Not available through the library or open access");
  const [error, setError] = useState("");
  const choices = ["Not available through the library or open access", "Author contacted, no reply", "Only a conference abstract exists", "Retracted or withdrawn"];
  return (
    <GlobalDialog label="Full text not retrieved" onClose={onClose}>
      <form
        className="kx-rv-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(reason).then(onClose).catch((err) => setError(errorText(err)));
        }}
      >
        <h2>Full text not retrieved</h2>
        <p>PRISMA reports these as “reports not retrieved”. They are not assessed for eligibility.</p>
        <div className="kx-rv-radio-list">
          {choices.map((c) => (
            <label key={c}>
              <input type="radio" checked={reason === c} onChange={() => setReason(c)} />
              {c}
            </label>
          ))}
        </div>
        <input className="kx-rv-input" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <button type="submit" className="kx-rv-btn" data-primary disabled={!reason.trim()}>
            Mark not retrieved
          </button>
        </div>
      </form>
    </GlobalDialog>
  );
}

function QueueDone({ summary, stage, filter, go, onUndo, canGoBack, onBack }: StageProps & { stage: Stage; filter: string; onUndo: () => void; canGoBack: boolean; onBack: () => void }) {
  const c = summary.stages[stage];
  const conflicts = filter === "conflicts";
  return (
    <div className="kx-rv-done">
      <span className="kx-empty-state-icon" aria-hidden="true">
        <Icon name="check" size={22} />
      </span>
      <h2>{conflicts ? "No conflicts" : "Nothing waiting for you"}</h2>
      <p>
        {conflicts
          ? "Records reviewers disagree on appear here once everyone needed has decided."
          : `${plural(c.done, "record")} decided at ${STAGE_LABEL[stage].toLowerCase()}${c.partial ? `, ${plural(c.partial, "record")} wait for another reviewer` : ""}${c.conflicts ? `, ${plural(c.conflicts, "conflict")} to resolve` : ""}.`}
      </p>
      <div className="kx-empty-state-actions">
        {canGoBack && <Btn icon="chevronLeft" onClick={onBack}>Last record</Btn>}
        <Btn icon="undo" onClick={onUndo}>Undo last decision</Btn>
        {stage === "ta" && c.included + c.maybe > 0 && !conflicts && (
          <Btn primary onClick={() => go("ft")}>
            Go to full text
          </Btn>
        )}
        {stage === "ft" && summary.included > 0 && (
          <Btn primary onClick={() => go("extract")}>
            Go to extraction
          </Btn>
        )}
      </div>
    </div>
  );
}

function CheatSheet({ onClose, shortcuts }: { onClose: () => void; shortcuts: Record<string, string> }) {
  const rows: [string, string][] = [
    [(shortcuts.include || "I").toUpperCase(), "Include"],
    [(shortcuts.exclude || "E").toUpperCase(), "Exclude (then a reason’s number)"],
    [(shortcuts.maybe || "M").toUpperCase(), "Maybe"],
    ["1 – 9", "Choose an exclusion reason"],
    ["Enter", "Confirm the reasons chosen"],
    ["J or →", "Next record"],
    ["K or ←", "Previous record"],
    ["⌘Z or U", "Undo your last decision"],
    ["N", "Write a note"],
    ["Esc", "Leave the note or the reasons"],
    ["?", "These shortcuts"],
  ];
  return (
    <GlobalDialog label="Screening shortcuts" onClose={onClose}>
      <div className="kx-rv-dialog kx-rv-cheats">
        <h2>Screening shortcuts</h2>
        <dl>
          {rows.map(([k, what]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <p className="kx-rv-muted">Change the decision keys in Setup › Rules.</p>
        <div className="kx-rv-dialog-actions">
          <Btn primary onClick={onClose}>
            Done
          </Btn>
        </div>
      </div>
    </GlobalDialog>
  );
}

// ── The list ────────────────────────────────────────────────────────────────────

const ROW = 58;
const PAGE = 200;

function RecordList(props: StageProps & { stage: Stage; onOpen: (id: string) => void }) {
  const { api, summary, viewer, stage, notify, onChanged } = props;
  const [filter, setFilter] = useState(summary.stages[stage].mine > 0 ? "mine" : "all");
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<Map<number, ListRow>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const box = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const loaded = useRef(new Set<number>());
  const query = useMemo(() => ({ stage, filter, text, label }), [stage, filter, text, label]);

  const fetchPage = useCallback(
    (page: number, gen: number) => {
      if (loaded.current.has(page)) return;
      loaded.current.add(page);
      api
        .records({ ...query, offset: page * PAGE, limit: PAGE }, viewer)
        .then((r) => {
          if (gen !== generation.current) return;
          setTotal(r.total);
          setRows((old) => {
            const next = new Map(old);
            r.rows.forEach((row, i) => next.set(page * PAGE + i, row));
            return next;
          });
        })
        .catch((e) => notify(errorText(e), "error"));
    },
    [api, query, viewer, notify],
  );
  const restart = useCallback(() => {
    const gen = ++generation.current;
    loaded.current = new Set();
    setRows(new Map());
    fetchPage(0, gen);
  }, [fetchPage]);
  useEffect(() => {
    const t = setTimeout(restart, text ? 200 : 0);
    return () => clearTimeout(t);
  }, [restart, text]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scrollTop / ROW) - 10);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW) + 10);
  useEffect(() => {
    for (let p = Math.floor(first / PAGE); p <= Math.floor(Math.max(first, last - 1) / PAGE); p++) fetchPage(p, generation.current);
  }, [first, last, fetchPage]);

  const batch = (value: Choice) => {
    const ids = [...selected];
    const rule = summary.protocol.rules[stage];
    if (value === "exclude" && rule.reasons !== "none") return notify("Excluding needs a reason at this stage: exclude these one at a time, or choose “reasons: none” in Setup", "error");
    api
      .decide(ids, stage, value, [], "", viewer)
      .then(() => {
        notify(`${CHOICE_LABEL[value]}d ${plural(ids.length, "record")}`, "ok");
        setSelected(new Set());
        restart();
        onChanged();
      })
      .catch((e) => notify(errorText(e), "error"));
  };
  const filters: [string, string][] = [
    ["mine", "Waiting for me"],
    ["all", "All records"],
    ["undecided", "Undecided"],
    ["partial", "Needs another reviewer"],
    ["conflicts", "Conflicts"],
    ["included", "Included"],
    ["maybe", "Maybe"],
    ["excluded", "Excluded"],
    ["auto", "Excluded by rules"],
    ["decidedByMe", "Decided by me"],
    ["flagged", "To re-screen"],
    ["suggested", "Suggested by rules"],
    ["ai", "With an AI suggestion"],
    ...(stage === "ft" ? ([["awaiting", "Awaiting full text"], ["notRetrieved", "Not retrieved"]] as [string, string][]) : []),
  ];
  const labels = [...new Set([...summary.protocol.labels, ...summary.labelsInUse])];
  const kw = summary.protocol.keywords;
  return (
    <div className="kx-rv-list">
      <div className="kx-rv-filters">
        <select className="kx-rv-select" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show">
          {filters.map(([id, l]) => (
            <option key={id} value={id}>
              {l}
            </option>
          ))}
        </select>
        <input className="kx-rv-input kx-rv-search" type="search" placeholder="Search titles, abstracts, authors" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search records" />
        {labels.length > 0 && (
          <select className="kx-rv-select" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label">
            <option value="">Any label</option>
            {labels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        )}
        <span className="kx-rv-muted">{plural(total, "record")}</span>
        {selected.size > 0 && (
          <span className="kx-rv-batch">
            <span>{selected.size} selected</span>
            <Btn small icon="check" onClick={() => batch("include")}>Include</Btn>
            {summary.protocol.rules[stage].maybe && <Btn small icon="minus" onClick={() => batch("maybe")}>Maybe</Btn>}
            <Btn small icon="close" onClick={() => batch("exclude")}>Exclude</Btn>
            <MenuButton
              label="Label selected"
              icon="tag"
              items={labels.map((l) => ({ label: l, run: () => void api.labels([...selected], [l], [], viewer).then(restart).catch((e) => notify(errorText(e), "error")) }))}
            />
            <Btn small quiet onClick={() => setSelected(new Set())}>Clear</Btn>
          </span>
        )}
      </div>
      <div className="kx-rv-rows" ref={box} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} role="list" aria-label="Records">
        {total === 0 ? (
          <p className="kx-rv-list-empty">{filter === "mine" ? "Nothing waiting for you here." : "No records match."}</p>
        ) : (
          <div style={{ height: total * ROW, position: "relative" }}>
            {Array.from({ length: last - first }, (_, i) => first + i).map((i) => {
              const row = rows.get(i);
              return (
                <div key={i} className="kx-rv-list-row" role="listitem" style={{ top: i * ROW, height: ROW }} data-selected={(row && selected.has(row.id)) || undefined}>
                  {row ? (
                    <>
                      <input
                        type="checkbox"
                        aria-label="Select"
                        checked={selected.has(row.id)}
                        onChange={() =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (n.has(row.id)) n.delete(row.id);
                            else n.add(row.id);
                            return n;
                          })
                        }
                      />
                      <button type="button" className="kx-rv-list-main" onClick={() => props.onOpen(row.id)}>
                        <span className="kx-rv-list-title">
                          <Highlighted text={row.title || "Untitled"} include={kw.include} exclude={kw.exclude} query={text} />
                        </span>
                        <span className="kx-rv-list-sub">
                          {[row.byline, row.journal].filter(Boolean).join(" · ")}
                          {!row.hasAbstract && " · no abstract"}
                          {row.suggestion && <em> · rule: {row.suggestion.label}</em>}
                        </span>
                      </button>
                      <span className="kx-rv-list-state">
                        {row.flagged && <span className="kx-rv-pill" data-tone="amber">Re-screen</span>}
                        {row.labels.map((l) => (
                          <span key={l} className="kx-rv-pill" data-tone="muted">
                            {l}
                          </span>
                        ))}
                        {row.mine && <span className="kx-rv-mine" data-value={row.mine} title={`You: ${CHOICE_LABEL[row.mine]}`}>{CHOICE_LABEL[row.mine].slice(0, 1)}</span>}
                        <StatusPill status={row.status} compact />
                      </span>
                    </>
                  ) : (
                    <span className="kx-rv-list-placeholder" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
