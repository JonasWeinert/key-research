// Title & abstract and full-text screening. "Screen" shows one record at a time, keyboard first:
// I include, E exclude, M maybe. When the stage asks for the criterion not met, E (or M) opens
// the criteria step: a number picks one (and records it when the rule wants just the first and
// auto-advance is on), Enter records, Esc backs out, 0 writes "Other…". Numbers can also come
// first, then E or M records. Label keys (B background, L check later …) toggle labels without
// moving on. ⌘Z or U undo, J/K next/previous. The counter walks the session's own list (2 of 120
// after the first decision). At full text the record's PDF or saved page is the main panel, in
// Key's reader, with the decision in the sidebar; a passage selected there can be marked as not
// meeting a criterion (evidence with its place) and the record excluded. "List" pages through
// every record with filters, labels and batch decisions; "Full texts" gathers the PDFs;
// "Conflicts" is the queue of disagreements.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, Hint } from "../explain";
import { Icon } from "../icons";
import { bridge, type Source } from "../library-api";
import { findPdf } from "../find-pdf";
import { highlightPage, type Highlight } from "../item-actions";
import { GlobalDialog } from "../GlobalDrawer";
import { CHOICE_LABEL, ELEMENT_LABEL, STAGE_LABEL, asks, plural, reasonText, type Choice, type Criterion, type DecisionInfo, type Evidence, type ListRow, type ReasonRule, type RecordView, type Stage } from "./review-api";
import { Btn, Highlighted, MenuButton, StatusPill, errorText, formatDate, type MenuItem } from "./review-ui";
import { afterDecision, boundKeys, counter, criterionKeys, current as sessionCurrent, finishesOnPick, mergeQueue, missing, onChoice, showRecord, startSession, step as sessionStep, toggle, type Session } from "./review-session";
import type { ReaderFollowUp, ReaderMark, ReaderMarkMenu, ReaderSelectionAction, ReaderSelectionMode, ReviewReaderHandle } from "./review-reader";
import { MarksLegend, evidenceKey, evidenceLabel, evidenceMarks, flashRow, useMarksShown } from "./review-marks";
import { FullTexts, attachFiles } from "./review-fulltexts";
import type { StageProps } from "./ReviewPage";

const ReviewReader = lazy(() => import("./review-reader").then((m) => ({ default: m.ReviewReader })));

type Mode = "screen" | "list" | "conflicts" | "fulltexts";

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function Screening(props: StageProps & { stage: Stage }) {
  const { summary, stage } = props;
  const counts = summary.stages[stage];
  const [mode, setMode] = useState<Mode>("screen");
  const [focus, setFocus] = useState<string>();
  const [queueFilter, setQueueFilter] = useState("");
  const conflicts = counts.conflicts;
  if (!summary.active) {
    return <EmptyState help="empty.review.screen" icon="checklist" action={{ label: "Add records", icon: "plus", onClick: () => props.go("sources") }} learnMore="review.screening" />;
  }
  if (stage === "ft" && !counts.eligible) {
    return <EmptyState help="empty.review.fulltext" icon="filePdf" action={{ label: "Screen titles and abstracts", onClick: () => props.go("ta") }} learnMore="review.fulltext" />;
  }
  const labels = Object.entries(summary.labelCounts ?? {}).filter(([, n]) => n > 0);
  const modes: [Mode, string, string][] = [
    ["screen", "Screen", ""],
    ["list", "List", ""],
    ...(stage === "ft" ? ([["fulltexts", "Full texts", summary.fulltexts?.need ? String(summary.fulltexts.need) : ""]] as [Mode, string, string][]) : []),
    ["conflicts", "Conflicts", conflicts ? String(conflicts) : ""],
  ];
  return (
    <div className="kx-rv-screening" data-mode={mode} data-stage={stage}>
      <div className="kx-rv-toolbar">
        <div className="kx-rv-seg" role="radiogroup" aria-label="Screening view">
          {modes.map(([id, label, badge]) => (
            <button key={id} type="button" role="radio" aria-checked={mode === id} onClick={() => setMode(id)}>
              {label}
              {badge && <span className="kx-rv-seg-badge">{badge}</span>}
            </button>
          ))}
        </div>
        {mode === "screen" && labels.length > 0 && (
          <select className="kx-rv-select kx-rv-queue-pick" value={queueFilter} onChange={(e) => setQueueFilter(e.target.value)} aria-label="Records to screen">
            <option value="">Waiting for me</option>
            {labels.map(([l, n]) => (
              <option key={l} value={`label:${l}`}>
                {l} ({n.toLocaleString()})
              </option>
            ))}
          </select>
        )}
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
      ) : mode === "fulltexts" ? (
        <FullTexts
          {...props}
          onOpen={(id) => {
            setFocus(id);
            setMode("screen");
          }}
        />
      ) : (
        <SingleRecord key={`${mode}:${queueFilter}`} {...props} stage={stage} filter={mode === "conflicts" ? "conflicts" : queueFilter} focus={focus} onFocused={() => setFocus(undefined)} />
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

type PassageKind = "notMet" | "met" | "include" | "note";
interface Passage {
  text: string;
  page: number;
  rects: number[][];
}

function SingleRecord(props: StageProps & { stage: Stage; filter: string; focus?: string; onFocused: () => void }) {
  const { api, summary, viewer, stage, filter, active, notify, onChanged } = props;
  const protocol = summary.protocol;
  const rule = protocol.rules[stage];
  const autoAdvance = protocol.rules.autoAdvance !== false;
  const [session, setSession] = useState<Session>();
  const [view, setView] = useState<RecordView>();
  const [loading, setLoading] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  /** The criteria step of a choice that needs them. */
  const [picking, setPicking] = useState<Choice>();
  /** Recorded here with auto-advance off: Enter or J goes on. */
  const [recorded, setRecorded] = useState(false);
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  /** Marks made in the full text since the record opened, newest last: ⌘Z takes one back. */
  const markUndo = useRef<Array<{ added: Evidence; removed?: Evidence; reasons: string[]; other: string }>>([]);
  const [marksShown, setMarksShown] = useMarksShown();
  /** A passage marked as not meeting a criterion: offer to exclude and go on. */
  const [offerExclude, setOfferExclude] = useState(false);
  const [cheats, setCheats] = useState(false);
  const [askingAi, setAskingAi] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const reader = useRef<ReviewReaderHandle>(null);
  useEffect(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el?.closest(".kx-rv-stages, .kx-rv-seg")) el.blur();
  }, []);
  // The stage's criteria: what is shown beside the record and what a decision names.
  const reasonsFor = useMemo(() => protocol.criteria.filter((c) => !c.stages.length || c.stages.includes(stage)), [protocol.criteria, stage]);
  // Each criterion's key: 1–9, then letters nothing else here uses (review-session.ts).
  const critKeys = useMemo(() => criterionKeys(reasonsFor.length, boundKeys(protocol.shortcuts, protocol.labelKeys ?? {})), [reasonsFor.length, protocol.shortcuts, protocol.labelKeys]);
  const current = session ? sessionCurrent(session) : undefined;

  useEffect(() => {
    if (!viewer) return;
    api
      .queue(stage, viewer, filter)
      .then((q) => {
        setSession(startSession(q, props.focus));
        if (props.focus) props.onFocused();
      })
      .catch((e) => notify(errorText(e), "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, stage, viewer, filter]);

  const load = useCallback(
    (id: string | undefined) => {
      if (!id) return setView(undefined);
      setLoading(true);
      api
        .record(id, stage, viewer)
        .then((v) => {
          setView(v);
          setReasons(v.mine?.reasons ?? []);
          setOther(v.mine?.other ?? "");
          setNote(v.mine?.note ?? "");
          setEvidence(v.mine?.evidence ?? []);
          markUndo.current = [];
          setPicking(undefined);
          setOtherOpen(false);
          setOfferExclude(false);
          setRecorded(false);
        })
        .catch((e) => notify(errorText(e), "error"))
        .finally(() => setLoading(false));
    },
    [api, stage, viewer, notify],
  );
  useEffect(() => load(current), [current, load]);

  const advance = useCallback(async () => {
    const q = await api.queue(stage, viewer, filter);
    setSession((s) => (s ? afterDecision(mergeQueue(s, q), q) : s));
  }, [api, stage, viewer, filter]);

  // Reviewers who excluded for different criteria are not in conflict; at full text whoever may
  // resolve can settle which criterion is reported.
  const settling = stage === "ft" && !!view?.reasonsDiffer && summary.canResolve;
  const resolving = (view?.status.name === "conflict" || settling) && summary.canResolve;

  const decide = useCallback(
    async (value: Choice, chosen = reasons, otherText = other) => {
      if (!view || !current) return;
      if (value === "maybe" && !rule.maybe) return notify(`“Maybe” is off for ${STAGE_LABEL[stage].toLowerCase()} (Setup › Rules)`, "error");
      const asked = asks(rule, value);
      if (onChoice(asked, value, reasonsFor.length, chosen, otherText) === "pick") {
        setPicking(value);
        // "The first one" with two chosen: start the choice again.
        if (asked === "first" && chosen.length + (otherText.trim() ? 1 : 0) > 1) {
          setReasons([]);
          setOther("");
        }
        return;
      }
      const named = value === "include" ? [] : chosen;
      const why = value === "include" ? "" : otherText.trim();
      try {
        if (resolving) await api.resolve(current, stage, value, named, note, viewer, why);
        else await api.decide([current], stage, value, named, note, viewer, evidence, why);
        onChanged();
        setPicking(undefined);
        setOfferExclude(false);
        if (autoAdvance) await advance();
        else {
          setRecorded(true);
          api.record(current, stage, viewer).then(setView).catch(() => {});
        }
      } catch (e) {
        notify(errorText(e), "error");
      }
    },
    [view, current, rule, reasons, other, reasonsFor.length, note, evidence, resolving, api, stage, viewer, advance, notify, onChanged, autoAdvance],
  );

  const undo = useCallback(async () => {
    try {
      const back = await api.undo(viewer);
      if (!back) return notify("Nothing to undo");
      setSession((s) => (s ? showRecord(s, back.recordId) : startSession([back.recordId])));
      load(back.recordId);
      onChanged();
      notify(`Took back your decision`, "ok");
    } catch (e) {
      notify(errorText(e), "error");
    }
  }, [api, viewer, load, onChanged, notify]);

  const step = useCallback((by: number) => setSession((s) => (s ? sessionStep(s, by) : s)), []);

  const toggleLabel = useCallback(
    (label: string) => {
      if (!view || !current) return;
      const on = view.labels.includes(label);
      api
        .labels([current], on ? [] : [label], on ? [label] : [], viewer)
        .then(() => {
          setView({ ...view, labels: on ? view.labels.filter((l) => l !== label) : [...view.labels, label] });
          onChanged();
        })
        .catch((e) => notify(errorText(e), "error"));
    },
    [api, view, current, viewer, onChanged, notify],
  );

  /** Picks a criterion by number (or click): while choosing, the rule decides whether that
   * is the decision; before a choice, it is remembered for E or M. */
  const pick = useCallback(
    (id: string) => {
      const asked: ReasonRule = picking ? asks(rule, picking) : asks(rule, "exclude") === "none" ? "all" : asks(rule, "exclude");
      const next = toggle(asked, reasons, id);
      setReasons(next);
      if (asked === "first") setOther("");
      if (picking && next.includes(id) && finishesOnPick(asked, autoAdvance)) void decide(picking, next, "");
    },
    [picking, rule, reasons, autoAdvance, decide],
  );

  const saveOther = useCallback(
    (text: string) => {
      setOtherOpen(false);
      const t = text.trim();
      if (!t) return;
      setOther(t);
      const asked: ReasonRule = picking ? asks(rule, picking) : "all";
      const chosen = asked === "first" ? [] : reasons;
      if (asked === "first") setReasons([]);
      // Enter on Other records the choice when that completes it.
      if (picking && !missing(asked, reasonsFor.length, chosen, t)) void decide(picking, chosen, t);
    },
    [picking, rule, reasons, reasonsFor.length, decide],
  );

  const undoMark = useCallback(() => {
    const last = markUndo.current.pop();
    if (!last) return;
    setEvidence((ev) => {
      const i = ev.map(evidenceKey).lastIndexOf(evidenceKey(last.added));
      const kept = i < 0 ? ev : [...ev.slice(0, i), ...ev.slice(i + 1)];
      return last.removed ? [...kept, last.removed] : kept;
    });
    setReasons(last.reasons);
    setOther(last.other);
    notify("Took back the last mark", "ok");
  }, [notify]);
  // Keys: only while this tab shows and nothing is being typed into.
  const labelKeys = protocol.labelKeys ?? {};
  useEffect(() => {
    if (!active) return;
    const keys = { include: protocol.shortcuts.include || "i", exclude: protocol.shortcuts.exclude || "e", maybe: protocol.shortcuts.maybe || "m" };
    const byKey = new Map(Object.entries(labelKeys).filter(([, k]) => k).map(([label, k]) => [k.toLowerCase(), label]));
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".key-global-drawer.key-modal")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !isTyping(e.target)) {
        e.preventDefault();
        // The last mark in the full text first, then the last decision.
        if (markUndo.current.length) undoMark();
        else void undo();
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "0") setOtherOpen(true);
      else if (k.length === 1 && critKeys.includes(k)) {
        const c = reasonsFor[critKeys.indexOf(k)];
        if (c) pick(c.id);
      } else if (/^[0-9]$/.test(k)) return;
      else if (e.key === "Enter") {
        if (picking) void decide(picking);
        else if (recorded) void advance();
        else return;
      } else if (e.key === "Escape") {
        if (picking) setPicking(undefined);
        else if (offerExclude) setOfferExclude(false);
        else if (reasons.length || other) {
          setReasons([]);
          setOther("");
        } else return;
      } else if (k === keys.include) void decide("include");
      else if (k === keys.exclude) void decide("exclude");
      else if (k === keys.maybe) void decide("maybe");
      else if (k === "j" || e.key === "ArrowRight") step(1);
      else if (k === "k" || e.key === "ArrowLeft") step(-1);
      else if (k === "u") void undo();
      else if (k === "n") {
        e.preventDefault();
        noteRef.current?.focus();
      } else if (k === "?") setCheats(true);
      else if (byKey.has(k)) toggleLabel(byKey.get(k)!);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, decide, step, undo, undoMark, reasons, other, picking, recorded, offerExclude, reasonsFor, protocol.shortcuts, labelKeys, pick, toggleLabel, advance, critKeys]);

  // Full-text screening in the reader: a selected passage is marked against a criterion right
  // from the selection menu (numbers: not met; Shift: met), stored as evidence on the pending
  // decision with its place, drawn in the page, and then excluding is one key away.
  const decideRef = useRef(decide);
  decideRef.current = decide;
  const rulesRef = useRef({ rule, reasons, other, reasonsFor });
  rulesRef.current = { rule, reasons, other, reasonsFor };
  /** Marks a passage; a "not met" names the criterion as the decision's reason (by the rule). */
  const markPassage = useCallback((kind: PassageKind, p: Passage, criterion?: Criterion, text = "", replacing?: Evidence): ReaderFollowUp | void => {
    const { rule: r, reasons: chosen, other: otherNow, reasonsFor: list } = rulesRef.current;
    const added: Evidence = { kind, ...(criterion ? { criterion: criterion.id } : {}), quote: p.text, text: p.text, page: p.page, rects: p.rects, ...(text ? { note: text } : {}) };
    markUndo.current.push({ added, removed: replacing, reasons: chosen, other: otherNow });
    setEvidence((ev) => [...ev.filter((e) => !replacing || evidenceKey(e) !== evidenceKey(replacing)), added]);
    if (kind !== "notMet") return;
    const asked = asks(r, "exclude");
    let nextReasons = chosen;
    let nextOther = otherNow;
    if (criterion) {
      nextReasons = chosen.includes(criterion.id) ? chosen : asked === "first" ? [criterion.id] : [...chosen, criterion.id];
      if (asked === "first") nextOther = "";
    } else if (text) {
      nextOther = text;
      if (asked === "first") nextReasons = [];
    }
    setReasons(nextReasons);
    setOther(nextOther);
    setOfferExclude(true);
    const ready = !missing(asked === "none" ? "all" : asked, list.length, nextReasons, nextOther);
    flashRow(criterion ? `[data-criterion="${criterion.id}"]` : ".kx-rv-other");
    return {
      message: criterion ? `Not met: ${criterion.label}` : `Not met: ${text}`,
      tone: "notMet",
      actions: [
        ...(ready ? [{ id: "exclude-next", label: "Exclude and go to next", primary: true, run: () => void decideRef.current("exclude", nextReasons, nextOther) }] : []),
        { id: "keep-reading", label: "Keep reading", key: "escape", run: () => {} },
      ],
    };
  }, []);
  const removeMark = useCallback(
    (e: Evidence) => {
      markUndo.current.push({ added: { ...e, quote: "", text: "" }, removed: e, reasons, other });
      setEvidence((ev) => ev.filter((x) => evidenceKey(x) !== evidenceKey(e)));
      // A reason that only this passage gave goes with it.
      if (e.kind === "notMet" && e.criterion && !evidence.some((x) => x !== e && x.kind === "notMet" && x.criterion === e.criterion)) setReasons((r) => r.filter((id) => id !== e.criterion));
    },
    [reasons, other, evidence],
  );
  /** The rows of the menu: each criterion with its two targets, then the other kinds. */
  const criteriaRows = useCallback(
    (onPick: (kind: PassageKind, c: Criterion | undefined, p: Passage, text?: string) => ReaderFollowUp | void, current?: Evidence): ReaderSelectionAction[] => {
      const many = reasonsFor.length > 9;
      const rows: ReaderSelectionAction[] = reasonsFor.map((c, i) => {
        const n = critKeys[i];
        return {
          id: `criterion-${c.id}`,
          label: c.label,
          title: c.guidance || c.label,
          detail: current?.criterion === c.id ? (current.kind === "met" ? "Marked met now" : "Marked not met now") : undefined,
          group: many ? (ELEMENT_LABEL[c.element] ?? c.element) : undefined,
          keywords: `${ELEMENT_LABEL[c.element] ?? ""} ${c.reason}`,
          tone: "notMet",
          runLabel: "Not met",
          key: n,
          run: (p) => onPick("notMet", c, p),
          quick: [{ id: `criterion-${c.id}-met`, label: "Met", key: n ? `shift+${n}` : undefined, tone: "met", run: (p) => onPick("met", c, p) }],
        };
      });
      rows.push(
        { id: "review-include", label: "Evidence for include", icon: "check", tone: "evidence", secondary: true, run: (p) => onPick("include", undefined, p) },
        { id: "review-note", label: "Note", icon: "note", secondary: true, input: { placeholder: "A note on this passage" }, run: (p, text) => onPick("note", undefined, p, text) },
        { id: "review-other", label: "Other reason…", icon: "close", tone: "notMet", secondary: true, key: "0", input: { placeholder: "Not met: the reason in your words" }, run: (p, text) => onPick("notMet", undefined, p, text) },
      );
      return rows;
    },
    [reasonsFor, critKeys],
  );
  const readerActions = useMemo(() => criteriaRows((kind, c, p, text) => markPassage(kind, p, c, text)), [criteriaRows, markPassage]);
  const screenMode = useMemo<ReaderSelectionMode>(
    () => ({ id: "screen", label: "Mark this passage", filter: reasonsFor.length > 4 ? "Filter criteria" : undefined, hint: reasonsFor.length ? `${reasonsFor.length > 9 ? "1–9, A…" : `1–${reasonsFor.length}`} not met · ⇧ and the key: met` : undefined, empty: "No criteria for this stage yet (Setup › Criteria)" }),
    [reasonsFor.length],
  );
  const marks = useMemo<ReaderMark[]>(() => (marksShown ? evidenceMarks(evidence, reasonsFor) : []), [marksShown, evidence, reasonsFor]);
  /** A mark clicked in the page: change its verdict or criterion, or remove it. */
  const markActions = useCallback(
    (mark: ReaderMark): ReaderMarkMenu | null => {
      const e = evidence.find((x) => evidenceKey(x) === mark.id);
      if (!e) return null;
      if (e.criterion) flashRow(`[data-criterion="${e.criterion}"]`);
      const passageOf = { text: e.quote || e.text || "", page: e.page ?? -1, rects: e.rects ?? [] };
      const rows = criteriaRows((kind, c, _p, text) => markPassage(kind, passageOf, c, text, e), e).filter((r) => r.id !== "review-note" || e.kind !== "note");
      rows.push({ id: "review-remove-mark", label: "Remove this mark", icon: "trash", tone: "danger", secondary: true, key: "backspace", run: () => removeMark(e) });
      return { title: evidenceLabel(e, reasonsFor), mode: { id: "screen-mark", label: evidenceLabel(e, reasonsFor), hint: "Change it, or remove it" }, actions: rows };
    },
    [evidence, criteriaRows, markPassage, removeMark, reasonsFor],
  );
  const showEvidence = (e: Evidence) => {
    if (!reader.current?.showMark(evidenceKey(e))) reader.current?.show(e.page ?? 0, e.quote);
  };

  if (!session) return <div className="kx-rv-loading" aria-busy="true" />;
  const count = counter(session);
  if (!current || count.done || (!view && !loading)) {
    return <QueueDone {...props} stage={stage} filter={filter} onUndo={undo} canGoBack={session.order.length > 0} onBack={() => step(-1)} />;
  }
  const askedNow: ReasonRule = asks(rule, picking ?? "exclude");
  const decision = view && (
    <>
      <div className="kx-rv-decide-head">
        <span className="kx-rv-muted kx-rv-counter" aria-live="polite">
          {count.position.toLocaleString()} of {count.total.toLocaleString()}
        </span>
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
      {view.status.name !== "undecided" && (
        <div className="kx-rv-state">
          <StatusPill status={view.status} />
          {view.pilot && <span className="kx-rv-pill" data-tone="info">{view.pilot.name}</span>}
          {view.flagged && <span className="kx-rv-pill" data-tone="amber" title="The protocol changed after this was decided">Re-screen</span>}
        </div>
      )}
      {recorded && (
        <p className="kx-rv-recorded" role="status">
          <Icon name="check" size={12} /> Recorded. <Btn small primary onClick={() => void advance()}>Next record</Btn> <kbd>Enter</kbd>
        </p>
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
              title={s.auto ? "Applied automatically to undecided records; you can still decide otherwise" : "Exclude as not meeting this criterion"}
              onClick={() => {
                const r = s.reasonId ? [s.reasonId] : [];
                setReasons(r);
                void decide("exclude", r, "");
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
      <div className="kx-rv-choices" role="group" aria-label="Decide" data-step={picking ? "criteria" : "choice"}>
        <ChoiceButton value="include" mine={view.mine?.value} k={protocol.shortcuts.include || "I"} onClick={() => void decide("include")} />
        {rule.maybe && <ChoiceButton value="maybe" mine={view.mine?.value} k={protocol.shortcuts.maybe || "M"} picking={picking === "maybe"} onClick={() => void decide("maybe")} />}
        <ChoiceButton value="exclude" mine={view.mine?.value} k={protocol.shortcuts.exclude || "E"} picking={picking === "exclude"} onClick={() => void decide("exclude")} />
      </div>
      {offerExclude && !picking && (
        <div className="kx-rv-offer" role="status">
          <span>Marked as not met.</span>
          <Btn small primary icon="close" onClick={() => void decide("exclude")}>
            Exclude and go to next
          </Btn>
          <Btn small quiet onClick={() => setOfferExclude(false)}>
            Not yet
          </Btn>
        </div>
      )}
      <CriteriaPicker
        criteria={reasonsFor}
        checks={view.checks}
        rule={askedNow}
        choice={picking}
        selected={reasons}
        other={other}
        otherOpen={otherOpen}
        onToggle={pick}
        keys={critKeys}
        evidence={stage === "ft" ? evidence : undefined}
        onShowEvidence={showEvidence}
        onOther={() => setOtherOpen(true)}
        onOtherSave={saveOther}
        onOtherCancel={() => setOtherOpen(false)}
        onOtherClear={() => setOther("")}
        onConfirm={() => picking && void decide(picking)}
        onBack={() => setPicking(undefined)}
      />
      {stage === "ft" && <EvidenceList evidence={evidence} criteria={reasonsFor} onShow={showEvidence} onRemove={(i) => removeMark(evidence[i])} />}
      {stage === "ft" && view.hasFullText && <MarksLegend kinds={["notMet", "met", "evidence"]} shown={marksShown} onShown={setMarksShown} count={evidence.length} />}
      <label className="kx-rv-note">
        <span>
          Note <kbd>N</kbd>
        </span>
        <textarea ref={noteRef} value={note} rows={2} placeholder="Why, or what to check" onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()} />
      </label>
      <Labels {...props} view={view} keys={labelKeys} onToggle={toggleLabel} />
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
  );
  return (
    <div className="kx-rv-single" aria-busy={loading} data-layout={stage === "ft" ? "reader" : "card"}>
      {stage === "ft" && view ? (
        <section className="kx-rv-reader-main" aria-label="Full text">
          <CompactHeader {...props} view={view} reload={() => load(current)} />
          {view.hasFullText ? (
            <ReaderFor {...props} view={view} readerRef={reader} actions={readerActions} mode={screenMode} marks={marks} markActions={markActions} />
          ) : (
            <NoFullText {...props} view={view} reload={() => load(current)} />
          )}
        </section>
      ) : (
        <article className="kx-rv-record" aria-label="Record">
          {view && <RecordCard {...props} view={view} />}
        </article>
      )}
      <aside className="kx-rv-decide" aria-label="Decision">
        {decision}
      </aside>
      {cheats && <CheatSheet keys={critKeys} onClose={() => setCheats(false)} shortcuts={protocol.shortcuts} labelKeys={labelKeys} rule={rule} autoAdvance={autoAdvance} />}
    </div>
  );
}

/** The stage's criteria: the rules beside the record and the step that names the ones not met
 * (numbers 1–9, 0 for Other…). One list, in the protocol's order. */
function CriteriaPicker(props: {
  criteria: Criterion[];
  checks: RecordView["checks"];
  rule: ReasonRule;
  choice?: Choice;
  selected: string[];
  other: string;
  otherOpen: boolean;
  onToggle: (id: string) => void;
  /** Each criterion's key (criterionKeys): undefined when it has none. */
  keys?: (string | undefined)[];
  /** Full-text evidence: each criterion shows its passages as chips (a click shows the place). */
  evidence?: Evidence[];
  onShowEvidence?: (e: Evidence) => void;
  onOther: () => void;
  onOtherSave: (text: string) => void;
  onOtherCancel: () => void;
  onOtherClear: () => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const { criteria, checks, rule, choice, selected, other, otherOpen } = props;
  const picking = !!choice;
  const list = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (picking) list.current?.scrollIntoView({ block: "nearest" });
  }, [picking]);
  if (!criteria.length && !picking) return <p className="kx-rv-muted kx-rv-no-criteria">No criteria for this stage yet: add them in Setup › Criteria, and excluding will ask which one a record does not meet.</p>;
  const grouped = criteria.length > 9;
  const verb = choice === "maybe" ? "Maybe" : "Exclude";
  const hint = picking
    ? rule === "first"
      ? "Choose the first criterion it does not meet"
      : "Choose every criterion it does not meet, then Enter"
    : "A criterion's key marks it not met; then E or M";
  let lastElement = "";
  return (
    <fieldset ref={list} className="kx-rv-criteria-pick" data-picking={picking || undefined}>
      <legend>
        {picking ? (
          <>
            <span className="kx-rv-step">{verb}</span> {hint}
          </>
        ) : (
          <>
            Criteria <span className="kx-rv-muted">· {hint}</span>
          </>
        )}
      </legend>
      {criteria.map((c, i) => {
        const check = checks.find((x) => x.criterionId === c.id);
        const state = !check ? undefined : check.met == null ? "unknown" : check.met ? "ok" : "fails";
        const on = selected.includes(c.id);
        const element = c.element || "other";
        const heading = grouped && element !== lastElement ? ELEMENT_LABEL[element] || element : null;
        lastElement = element;
        return (
          <div key={c.id} className="kx-rv-criteria-item" data-criterion={c.id}>
            {heading && <h4>{heading}</h4>}
            <label title={c.guidance || undefined} data-state={state} data-on={on || undefined}>
              <input type={rule === "first" ? "radio" : "checkbox"} name="criterion" checked={on} onChange={() => props.onToggle(c.id)} />
              {props.keys?.[i] ? <kbd>{props.keys[i]!.toUpperCase()}</kbd> : <span className="kx-rv-kbd-space" aria-hidden="true" />}
              <span>
                {c.label}
                {on ? <small>Not met: {reasonText(c)}</small> : check && <small>{check.met == null ? `${check.rule}: not known` : check.met ? check.rule : `Not met: ${check.rule}`}</small>}
              </span>
              {state && <Icon name={state === "ok" ? "check" : state === "fails" ? "close" : "info"} size={11} />}
            </label>
            {props.evidence?.some((e) => e.criterion === c.id) && (
              <span className="kx-rv-evidence-chips">
                {props.evidence
                  .filter((e) => e.criterion === c.id)
                  .map((e, n) => (
                    <button key={n} type="button" className="kx-rv-evidence-chip" data-kind={e.kind} title={`“${(e.quote || e.text || "").slice(0, 200)}”`} onClick={() => props.onShowEvidence?.(e)}>
                      <i aria-hidden="true" />
                      {e.kind === "notMet" ? "Not met" : "Met"}
                      {e.page != null && e.page >= 0 ? ` · p. ${e.page + 1}` : ""}
                    </button>
                  ))}
              </span>
            )}
          </div>
        );
      })}
      <div className="kx-rv-criteria-item kx-rv-other">
        {otherOpen ? (
          <OtherField initial={other} onSave={props.onOtherSave} onCancel={props.onOtherCancel} />
        ) : other ? (
          <label data-on>
            <input type="checkbox" checked onChange={props.onOtherClear} />
            <kbd>0</kbd>
            <span>
              Other: {other}
              <small>In your words; reported under “Other”</small>
            </span>
          </label>
        ) : (
          <button type="button" className="kx-rv-other-button" onClick={props.onOther}>
            <kbd>0</kbd>
            <span>Other…</span>
          </button>
        )}
      </div>
      {picking && (
        <div className="kx-rv-step-actions">
          <Btn small onClick={props.onBack} title="Back to the choice (Esc)">
            Back <kbd>Esc</kbd>
          </Btn>
          <Btn primary small disabled={!selected.length && !other} onClick={props.onConfirm}>
            {verb} <kbd>Enter</kbd>
          </Btn>
        </div>
      )}
    </fieldset>
  );
}

function OtherField({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <span className="kx-rv-other-field">
      <kbd>0</kbd>
      <input
        className="kx-rv-input"
        autoFocus
        value={text}
        placeholder="Other: the reason in your words"
        aria-label="Other reason"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            onSave(text);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
    </span>
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
        {(d.reasons.length > 0 || d.other) && `: ${[...d.reasons.map(reason), ...(d.other ? [`Other: ${d.other}`] : [])].join(", ")}`}
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
          {view.filled?.abstractText && <p className="kx-rv-muted kx-rv-provenance">Abstract filled in from {provenance(view.filled.abstractText)}</p>}
        </div>
      ) : (
        <p className="kx-rv-no-abstract">No abstract. Decide from the title, or keep it for full-text screening with Maybe. Sources › Find missing abstracts looks for one.</p>
      )}
      {m.keywords && m.keywords.length > 0 && (
        <div className="kx-rv-keywords">
          {m.keywords.slice(0, 24).map((k) => (
            <span key={k}>{k}</span>
          ))}
        </div>
      )}
      <Ids view={view} stage={stage} />
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

/** "duplicate in PubMed", "library:…", "OpenAlex" → words. */
export const provenance = (from: string) => (from.startsWith("library:") ? "the library" : from.startsWith("duplicate in ") ? `its duplicate in ${from.slice(13)}` : from || "elsewhere");

function Ids({ view, stage }: { view: RecordView; stage: Stage }) {
  const m = view.meta;
  return (
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
  );
}

function Labels({ summary, view, keys, onToggle }: StageProps & { view: RecordView; keys: Record<string, string>; onToggle: (label: string) => void }) {
  const all = [...new Set([...summary.protocol.labels, ...summary.labelsInUse])];
  if (!all.length && !view.labels.length) return null;
  return (
    <div className="kx-rv-labels" aria-label="Labels">
      {all.map((l) => {
        const on = view.labels.includes(l);
        const k = keys[l];
        return (
          <button key={l} type="button" className="kx-rv-label" aria-pressed={on} title={k ? `${l} (${k.toUpperCase()})` : l} onClick={() => onToggle(l)}>
            {on && <Icon name="check" size={10} />}
            {l}
            {k && <kbd>{k.toUpperCase()}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

/** Passages behind the decision, with where they are; a click shows the place. */
function EvidenceList({ evidence, criteria, onShow, onRemove }: { evidence: Evidence[]; criteria: Criterion[]; onShow: (e: Evidence) => void; onRemove: (i: number) => void }) {
  if (!evidence.length) return null;
  const label = (e: Evidence) => evidenceLabel(e, criteria);
  return (
    <section className="kx-rv-evidence-list" aria-label="Evidence">
      <h4>Evidence</h4>
      <ul>
        {evidence.map((e, i) => (
          <li key={i} data-kind={e.kind ?? "highlight"}>
            <button type="button" className="kx-rv-evidence-jump" onClick={() => onShow(e)} title="Show it in the full text">
              <strong>{label(e)}</strong>
              <span>“{(e.quote || e.text || "").slice(0, 200)}”</span>
              {e.page != null && e.page >= 0 && <small>p. {e.page + 1}</small>}
            </button>
            <button type="button" className="kx-rv-icon" aria-label="Remove this evidence" onClick={() => onRemove(i)}>
              <Icon name="close" size={11} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Full text inside the review ─────────────────────────────────────────────────

function CompactHeader(props: StageProps & { stage: Stage; view: RecordView; reload: () => void }) {
  const { view, summary, stage } = props;
  const m = view.meta;
  const kw = summary.protocol.keywords;
  const [abstract, setAbstract] = useState(false);
  return (
    <header className="kx-rv-compact">
      <div className="kx-rv-compact-main">
        <h2 className="kx-rv-record-title" title={m.title}>
          <Highlighted text={m.title || "Untitled"} include={kw.include} exclude={kw.exclude} />
        </h2>
        <p className="kx-rv-compact-sub">
          {[m.authors.slice(0, 3).join("; ") + (m.authors.length > 3 ? " et al." : ""), m.journal, m.year].filter(Boolean).join(" · ")}
          {view.batch && <span className="kx-rv-muted"> · {view.batch.name}</span>}
        </p>
        <Ids view={view} stage={stage} />
      </div>
      <div className="kx-rv-compact-tools">
        {m.abstractText && (
          <Btn small quiet aria-expanded={abstract} onClick={() => setAbstract(!abstract)}>
            Abstract
          </Btn>
        )}
        {view.hasFullText && <FullTextMenu {...props} />}
      </div>
      {abstract && <p className="kx-rv-compact-abstract">{m.abstractText}</p>}
    </header>
  );
}

function FullTextMenu({ api, view, viewer, notify, reload, onChanged, invoke, workspaceId }: StageProps & { view: RecordView; reload: () => void }) {
  const kept = !!view.fulltext.file;
  return (
    <MenuButton
      label="Full text actions"
      items={([
        kept && !view.sourceId
          ? {
              label: "Also add to library",
              icon: "plus",
              run: () =>
                void api
                  .toLibrary(view.meta.id, viewer)
                  .then(() => (notify("Added to the library", "ok"), reload(), onChanged()))
                  .catch((e) => notify(errorText(e), "error")),
            }
          : null,
        view.sourceId ? { label: "Open in Key's reader", icon: "filePdf", run: () => void openFullText(invoke, workspaceId, view.sourceId!).catch((e) => notify(errorText(e), "error")) } : null,
        {
          label: "Remove this full text",
          icon: "trash",
          run: () =>
            void api
              .detach(view.meta.id, viewer)
              .then(() => (notify("Full text removed from the record", "ok"), reload(), onChanged()))
              .catch((e) => notify(errorText(e), "error")),
        },
      ] as (MenuItem | null)[]).filter((x): x is MenuItem => !!x)}
    />
  );
}

function ReaderFor({ api, view, notify, readerRef, actions, mode, marks, markActions, invoke, workspaceId }: StageProps & { view: RecordView; readerRef: React.RefObject<ReviewReaderHandle | null>; actions: ReaderSelectionAction[]; mode?: ReaderSelectionMode; marks?: ReaderMark[]; markActions?: (mark: ReaderMark) => ReaderMarkMenu | null }) {
  const [mime, setMime] = useState<string>();
  const version = view.fulltext.file?.hash ?? view.sourceId ?? "";
  useEffect(() => {
    let live = true;
    api
      .fulltextInfo(view.meta.id)
      .then((info) => live && setMime(info.exists ? info.mime : ""))
      .catch(() => live && setMime(""));
    return () => {
      live = false;
    };
  }, [api, view.meta.id, version]);
  if (mime === undefined) return <div className="kx-rv-reader" aria-busy="true" />;
  if (!mime) return <div className="kx-rv-reader-empty"><p className="kx-inline-error">The full text's file is missing on this Mac.</p></div>;
  return (
    <Suspense fallback={<div className="kx-rv-reader" aria-busy="true" />}>
      <ReviewReader
        ref={readerRef}
        api={api}
        recordId={view.meta.id}
        version={version}
        title={view.meta.title}
        mime={mime}
        sourceId={view.fulltext.file ? null : view.sourceId}
        invoke={(command, args) => invoke(command, args as Record<string, unknown>, workspaceId)}
        actions={actions}
        mode={mode}
        marks={marks}
        markActions={markActions}
        onError={(t) => notify(t, "error")}
      />
    </Suspense>
  );
}

/** No full text yet: find it, attach a file, or mark it not retrieved. */
function NoFullText(props: StageProps & { view: RecordView; reload: () => void }) {
  const { api, invoke, workspaceId, viewer, view, notify, reload, onChanged } = props;
  const [busy, setBusy] = useState(false);
  const [notRetrieved, setNotRetrieved] = useState(false);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const run = (task: () => Promise<unknown>) => {
    setBusy(true);
    task()
      .catch((e) => notify(errorText(e), "error"))
      .finally(() => setBusy(false));
  };
  const sourceId = view.sourceId;
  useEffect(() => {
    if (!sourceId) return;
    void invoke<Highlight[]>("library_annotations", { hash: sourceId }, workspaceId).then((h) => setHighlights((h ?? []).filter((x) => x.text))).catch(() => setHighlights([]));
  }, [invoke, workspaceId, sourceId]);
  const find = () =>
    run(async () => {
      let id = sourceId;
      if (!id) {
        // Finding goes through the library's Find PDF, which needs a source for the record.
        const linked = await api.linkLibrary([view.meta.id], viewer);
        id = linked[view.meta.id];
      }
      if (!id) throw Error("Could not look for the full text");
      const result = await findPdf(invoke, workspaceId, { id, title: view.meta.title });
      await api.fulltext(view.meta.id, { status: result.status === "attached" ? "retrieved" : "sought" }, viewer);
      if (result.status !== "attached") notify("No PDF found automatically. Open the record's page, or attach a file you have.", "error");
      reload();
      onChanged();
    });
  return (
    <div className="kx-rv-reader-empty">
      <Icon name="filePdf" size={28} />
      <h3>No full text yet</h3>
      <p className="kx-rv-muted">{view.fulltext.status === "notRetrieved" ? `Not retrieved: ${view.fulltext.reason}` : "Find it, or attach a PDF or saved page you have. Files are kept with the review, not added to the library."}</p>
      <div className="kx-empty-state-actions">
        <Btn primary icon="search" disabled={busy} onClick={find} title="Looks for an open-access copy and the publisher's PDF">
          {busy ? "Looking…" : "Find full text"}
        </Btn>
        <Btn icon="link" disabled={busy} onClick={() => fileInput.current?.click()}>
          Attach file…
        </Btn>
        {(view.meta.doi || view.meta.url) && (
          <Btn icon="globe" onClick={() => void bridge().tabAction("open-url", { url: view.meta.doi ? `https://doi.org/${view.meta.doi}` : view.meta.url })} title="Opens the record's page in Key's browser; save the PDF or the page there">
            Open the record's page
          </Btn>
        )}
        {(view.meta.doi || view.meta.url) && (
          <Btn
            icon="globe"
            disabled={busy}
            title="Saves the record's web page (as Key's browser shows it, with your library access) as its full text, kept with the review"
            onClick={() =>
              run(async () => {
                const url = view.meta.doi ? `https://doi.org/${view.meta.doi}` : view.meta.url!;
                const page = await invoke<{ path: string; title: string; abstractOnly?: boolean }>("saved_page_capture", { url }, workspaceId);
                await api.attach(view.meta.id, page.path, `${(page.title || view.meta.title).slice(0, 80)}.html`, "snapshot", viewer, true);
                notify(page.abstractOnly ? "Saved the page; it may show only the abstract" : "Saved the page as the full text", page.abstractOnly ? "error" : "ok", { label: "Undo", run: () => void api.detach(view.meta.id, viewer).then(() => (reload(), onChanged())) });
                reload();
                onChanged();
              })
            }
          >
            Save the page as full text
          </Btn>
        )}
        {view.fulltext.status === "notRetrieved" ? (
          <Btn onClick={() => run(() => api.fulltext(view.meta.id, { status: "sought" }, viewer).then(() => (reload(), onChanged())))}>Found it after all</Btn>
        ) : (
          <Btn quiet onClick={() => setNotRetrieved(true)}>
            Not retrieved…
          </Btn>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        hidden
        accept=".pdf,.html,.htm,application/pdf,text/html"
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          if (!files.length) return;
          run(async () => {
            await attachFiles(api, viewer, [{ record: view.meta.id, file: files[0] }], "upload");
            notify("Full text attached", "ok", { label: "Undo", run: () => void api.detach(view.meta.id, viewer).then(() => (reload(), onChanged())) });
            reload();
            onChanged();
          });
        }}
      />
      {highlights.length > 0 && <Hint help="review.evidence" />}
      {notRetrieved && <NotRetrievedSheet onClose={() => setNotRetrieved(false)} onSave={(reason) => api.fulltext(view.meta.id, { status: "notRetrieved", reason }, viewer).then(() => (reload(), onChanged()))} />}
    </div>
  );
}

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

export function NotRetrievedSheet({ onClose, onSave }: { onClose: () => void; onSave: (reason: string) => Promise<unknown> }) {
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
  const label = filter.startsWith("label:") ? filter.slice(6) : "";
  return (
    <div className="kx-rv-done">
      <span className="kx-empty-state-icon" aria-hidden="true">
        <Icon name="check" size={22} />
      </span>
      <h2>{conflicts ? "No conflicts" : label ? `No more “${label}” records` : "Nothing waiting for you"}</h2>
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

const RULE_WORDS: Record<ReasonRule, string> = { none: "nothing more", first: "the first criterion it does not meet", all: "every criterion it does not meet" };

function CheatSheet({ onClose, shortcuts, labelKeys, rule, autoAdvance, keys = [] }: { onClose: () => void; shortcuts: Record<string, string>; labelKeys: Record<string, string>; rule: StageProps["summary"]["protocol"]["rules"]["ta"]; autoAdvance: boolean; keys?: (string | undefined)[] }) {
  const letters = keys.slice(9).filter(Boolean).map((k) => k!.toUpperCase());
  const rows: [string, string][] = [
    [(shortcuts.include || "I").toUpperCase(), "Include"],
    [(shortcuts.exclude || "E").toUpperCase(), `Exclude (asks for ${RULE_WORDS[asks(rule, "exclude")]})`],
    ...(rule.maybe ? ([[(shortcuts.maybe || "M").toUpperCase(), `Maybe (asks for ${RULE_WORDS[asks(rule, "maybe")]})`]] as [string, string][]) : []),
    [letters.length ? `1 – 9, ${letters.join(" ")}` : "1 – 9", autoAdvance && asks(rule, "exclude") === "first" ? "A criterion not met (while excluding: records it and goes on)" : "Mark a criterion not met"],
    ["0", "Other… (the reason in your words)"],
    ["Enter", "Record the choice; with auto-advance off, the next record"],
    ["Esc", "Back out of the criteria step, the note or Other"],
    ...Object.entries(labelKeys)
      .filter(([, k]) => k)
      .map(([l, k]) => [k.toUpperCase(), `Label “${l}” on or off (stays on this record)`] as [string, string]),
    ["J or →", "Next record"],
    ["K or ←", "Previous record"],
    ["⌘Z or U", "Undo your last decision"],
    ["N", "Write a note"],
    ["?", "These shortcuts"],
  ];
  return (
    <GlobalDialog label="Screening shortcuts" onClose={onClose}>
      <div className="kx-rv-dialog kx-rv-cheats">
        <h2>Screening shortcuts</h2>
        <p className="kx-rv-muted">Either press E (or M) and then the criterion's number, or the number first and then E or M.</p>
        <dl>
          {rows.map(([k, what]) => (
            <div key={k + what}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <p className="kx-rv-muted">Change the decision and label keys, and what each choice asks for, in Setup › Rules.</p>
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
    if (value !== "include" && asks(rule, value) !== "none") return notify(`${CHOICE_LABEL[value]} asks for the criterion not met at this stage: decide these one at a time, or change it in Setup › Rules`, "error");
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
  const counts = summary.labelCounts ?? {};
  return (
    <div className="kx-rv-list">
      {labels.length > 0 && (
        <div className="kx-rv-label-tabs" role="tablist" aria-label="Labels">
          <button type="button" role="tab" aria-selected={!label} onClick={() => setLabel("")}>
            All
          </button>
          {labels.map((l) => (
            <button key={l} type="button" role="tab" aria-selected={label === l} onClick={() => setLabel(label === l ? "" : l)}>
              {l} <span className="kx-rv-seg-badge">{(counts[l] ?? 0).toLocaleString()}</span>
            </button>
          ))}
          {label && <ExportLabel {...props} label={label} />}
        </div>
      )}
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

/** A label's records outside screening: to the library or one of its collections. */
function ExportLabel({ api, summary, viewer, label, notify, invoke, workspaceId, stage }: StageProps & { stage: Stage; label: string }) {
  const send = async (collection?: string) => {
    const ids: string[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await api.records({ stage, filter: "all", label, scope: "sources", offset, limit: 1000 }, viewer);
      ids.push(...page.rows.map((r) => r.id));
      if (ids.length >= page.total || !page.rows.length) break;
    }
    const linked = await api.linkLibrary(ids, viewer);
    const sources = Object.values(linked);
    if (collection) await invoke("store_collection_add", { collectionId: collection, sourceIds: sources }, workspaceId);
    notify(`${plural(sources.length, "record")} labelled “${label}” are in the library${collection ? " collection" : ""}`, "ok");
  };
  void summary;
  return (
    <MenuButton
      label={`Send “${label}” records`}
      icon="external"
      items={[{ label: "Add to library", icon: "plus", run: () => void send().catch((e) => notify(errorText(e), "error")) }]}
    />
  );
}
