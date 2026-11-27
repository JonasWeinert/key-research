// Risk of bias: each included study (and, for result-level tools such as RoB 2, each of its
// results) assessed with a tool's domains. The full text is the main panel, the assessment the
// sidebar, as in extraction. Keys: ↑ ↓ (or J K) move through the questions and judgements, a
// number answers, Enter takes Key's suggestion, ⌥S uses the reader's selection as support for
// the domain in focus, ⌘↩ marks the assessment complete, ⌥↓ ⌥↑ go to the next and previous
// study or result. Two assessors work blind until both are done; then differing judgements are
// conflicts, settled in the Conflicts view or right in the domain. Plots: the traffic-light and
// summary plots (weighted by an outcome's analysis). All judgements, suggestions and checks
// come from Rust (key_review::rob, certainty).
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, Explain, Hint } from "../explain";
import { downloadText } from "../db-ui";
import { GlobalDialog } from "../GlobalDrawer";
import { Icon } from "../icons";
import { RobMark, RobSummary, TrafficLight, type Mark } from "../charts/charts";
import { pngBlob, saveFile, svgMarkup } from "../charts/export";
import { plural } from "./review-api";
import { certaintyApi, type CertaintyApi, type RobAssessment, type RobDomain, type RobEvidence, type RobLevel, type RobOverview, type RobTool } from "./review-certainty-api";
import { Btn, MenuButton, Segmented, Toggle, errorText, useLoad } from "./review-ui";
import type { ReaderMark, ReaderMarkMenu, ReaderSelectionAction, ReaderSelectionMode, ReviewReaderHandle } from "./review-reader";
import { MarksLegend, flashRow, mirrorOf, useMarksShown } from "./review-marks";
import type { StageProps } from "./ReviewPage";
import "./review-rob.css";

const ReviewReader = lazy(() => import("./review-reader").then((m) => ({ default: m.ReviewReader })));

type View = "assess" | "conflicts" | "plots" | "tools";
const viewKey = (id: string) => `key.review.rob-view:${id}`;
const mark = (l: RobLevel | null | undefined): Mark | null => (l ? { tone: l.tone, symbol: l.symbol, label: l.label, title: l.label } : null);

/** A judgement level as a small disc with its symbol, then its label. */
export function LevelDot({ level, size = 14, label = true }: { level: RobLevel | null | undefined; size?: number; label?: boolean }) {
  if (!level) return null;
  return (
    <span className="kx-rob-dot" title={level.label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <RobMark mark={mark(level)!} x={size / 2} y={size / 2} r={size / 2 - 0.5} />
      </svg>
      {label && <span>{level.label}</span>}
    </span>
  );
}

export function RiskOfBias(props: StageProps) {
  const { invoke, workspaceId, reviewId, viewer, summary, notify } = props;
  const api = useMemo(() => certaintyApi(invoke, workspaceId, reviewId), [invoke, workspaceId, reviewId]);
  const overview = useLoad(() => api.overview(viewer), [api, viewer, summary.events]);
  const [view, setViewState] = useState<View>(() => {
    try {
      return (localStorage.getItem(viewKey(reviewId)) as View) || "assess";
    } catch {
      return "assess";
    }
  });
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(viewKey(reviewId), v);
    } catch {}
  };
  const [current, setCurrent] = useState<{ study: string; result: string }>();
  const o = overview.value;
  const items = useMemo(() => (o?.studies ?? []).flatMap((s) => s.results.map((r) => ({ study: s.id, result: r.key, label: s.label, resultLabel: r.label, study_: s, item: r }))), [o]);
  useEffect(() => {
    if (!items.length) return;
    if (!current || !items.some((i) => i.study === current.study && i.result === current.result)) {
      const same = current && items.find((i) => i.study === current.study);
      const first = same ?? items.find((i) => i.item.mine !== "complete") ?? items[0];
      setCurrent({ study: first.study, result: first.result });
    }
  }, [items, current]);
  const move = useCallback(
    (by: number) => {
      const i = items.findIndex((x) => x.study === current?.study && x.result === current?.result);
      const next = items[Math.min(items.length - 1, Math.max(0, i + by))];
      if (next) setCurrent({ study: next.study, result: next.result });
    },
    [items, current],
  );
  if (!summary.included) return <EmptyState help="empty.review.rob" icon="checklist" action={{ label: "Go to full-text screening", onClick: () => props.go("ft") }} learnMore="review.rob" />;
  if (!o) return overview.error ? <p className="kx-inline-error">{overview.error}</p> : <div className="kx-rv-loading" aria-busy="true" />;
  const migrate = () =>
    api
      .migrate(viewer)
      .then((r) => {
        notify(`${plural(r.studies, "study", "studies")} brought in from the extraction forms`, "ok");
        overview.reload();
      })
      .catch((e) => notify(errorText(e), "error"));
  const at = items.findIndex((x) => x.study === current?.study && x.result === current?.result);
  const it = items[at];
  const exportCsv = () => props.api.exportFile("rob-csv", viewer).then((f) => downloadText(f.filename, f.content, f.mime)).catch((e) => notify(errorText(e), "error"));
  return (
    <div className="kx-rv-extract kx-rob">
      <div className="kx-rv-toolbar kx-rv-extract-bar">
        <Segmented
          label="Risk of bias view"
          value={view}
          onChange={setView}
          options={[
            ["assess", "Assess"],
            ["conflicts", o.totals.conflicts ? `Conflicts (${o.totals.conflicts})` : "Conflicts"],
            ["plots", "Plots"],
            ["tools", "Tools and set-up"],
          ]}
        />
        {view === "assess" && it && (
          <span className="kx-rv-nav">
            <button type="button" className="kx-rv-icon" aria-label="Previous" title="Previous study or result (⌥↑)" onClick={() => move(-1)}>
              <Icon name="chevronLeft" size={14} />
            </button>
            <select className="kx-rv-select kx-rv-study-pick" aria-label="Study and result" value={`${it.study}\u0000${it.result}`} onChange={(e) => { const [study, result] = e.target.value.split("\u0000"); setCurrent({ study, result }); }}>
              {o.studies.map((s) => (
                <optgroup key={s.id} label={s.label}>
                  {s.results.map((r) => (
                    <option key={r.key} value={`${s.id}\u0000${r.key}`}>
                      {s.label} · {r.label}
                      {r.progress === "conflict" ? " · conflict" : r.mine === "complete" ? " · done" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button type="button" className="kx-rv-icon" aria-label="Next" title="Next study or result (⌥↓)" onClick={() => move(1)}>
              <Icon name="chevronRight" size={14} />
            </button>
          </span>
        )}
        <span className="kx-rv-muted">
          {o.totals.done} of {plural(o.totals.assessments, "assessment")} agreed{o.totals.mineLeft ? ` · ${o.totals.mineLeft} for you` : ""}
        </span>
        <span className="kx-rv-spacer" />
        <Explain help="review.rob" />
        <MenuButton label="Export risk of bias" icon="download" items={[{ label: "Judgements with support and quotes (CSV)", run: () => void exportCsv() }]} />
      </div>
      {o.migratable > 0 && (
        <div className="kx-rob-banner" role="status">
          <Icon name="info" size={14} />
          <span>{plural(o.migratable, "study has", "studies have")} risk-of-bias answers in extraction forms.</span>
          <Btn small primary onClick={migrate}>
            Bring them in
          </Btn>
        </div>
      )}
      {view === "assess" && it && <Assess key={`${it.study}|${it.result}`} {...props} capi={api} study={it.study} result={it.result} overview={o} onSaved={overview.reload} move={move} />}
      {view === "conflicts" && <Conflicts overview={o} open={(study, result) => { setCurrent({ study, result }); setView("assess"); }} />}
      {view === "plots" && <Plots {...props} capi={api} overview={o} />}
      {view === "tools" && <Tools {...props} capi={api} overview={o} onSaved={overview.reload} />}
    </div>
  );
}

// ── One assessment ──────────────────────────────────────────────────────────────────

interface Row {
  domain: string;
  question?: string;
}

function Assess(props: StageProps & { capi: CertaintyApi; study: string; result: string; overview: RobOverview; onSaved: () => void; move: (by: number) => void }) {
  const { capi, api, study, result, viewer, notify, active } = props;
  const view = useLoad(() => capi.assessment(study, result, viewer), [capi, study, result, viewer]);
  const record = useLoad(() => api.record(study, "ft", viewer), [api, study, viewer]);
  const [mime, setMime] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const reader = useRef<ReviewReaderHandle>(null);
  const side = useRef<HTMLElement>(null);
  const r = record.value;
  const a = view.value;
  const version = r?.fulltext.file?.hash ?? r?.sourceId ?? "";
  useEffect(() => {
    if (!r?.hasFullText) return setMime("");
    api
      .fulltextInfo(study)
      .then((i) => setMime(i.exists ? i.mime : ""))
      .catch(() => setMime(""));
  }, [api, study, r?.hasFullText, version]);
  const reload = useCallback(() => {
    view.reload();
    props.onSaved();
  }, [view, props]);
  const run = useCallback((p: Promise<unknown>, done?: string) => p.then(() => { if (done) notify(done, "ok"); reload(); }).catch((e) => notify(errorText(e), "error")), [notify, reload]);

  // The rows the keyboard walks: each question asked, then the domain's judgement; overall last.
  const rows = useMemo<Row[]>(() => {
    if (!a) return [];
    const out: Row[] = [];
    for (const d of a.tool.domains) {
      const given = Object.fromEntries(d.questions.map((q) => [q.id, a.mine.answers[`${d.id}/${q.id}`]]));
      for (const q of d.questions) if (!q.showIf || q.showIf.in.includes(given[q.showIf.question] ?? "")) out.push({ domain: d.id, question: q.id });
      out.push({ domain: d.id });
    }
    out.push({ domain: "overall" });
    return out;
  }, [a]);
  const at = rows[Math.min(cursor, rows.length - 1)];
  const focusDomain = at?.domain === "overall" ? undefined : a?.tool.domains.find((d) => d.id === at?.domain);
  const answer = useCallback((domain: string, question: string | null, value: string, extra?: { reason?: string; support?: string }) => run(capi.answer(study, result, domain, question, value, viewer, extra)), [capi, study, result, viewer, run]);
  const addEvidence = useCallback(
    (domain: RobDomain | undefined, p: { text: string; page: number; rects: number[][] }) => {
      if (!domain) return notify("Move to a domain first (↑ ↓), then use the passage");
      void run(capi.evidence(study, result, { domain: domain.id, text: p.text, page: p.page, rects: p.rects, hash: r?.fulltext.file?.hash ?? "" }, viewer), `Support for ${domain.name}`);
    },
    [capi, study, result, viewer, r, run, notify],
  );
  // The selection menu (SelectionMenu.tsx): the domain in focus first (S, or Enter), then every
  // domain by its number; the passages kept as support are marks in the page.
  const actions = useMemo<ReaderSelectionAction[]>(() => {
    const domains = a?.tool.domains ?? [];
    return [
      ...(focusDomain ? [{ id: "rob-support", label: `Use as support for ${focusDomain.name}`, prefix: focusDomain.short, title: "Keep this passage, with its place, as support for the domain in focus", icon: "quote" as const, tone: "evidence" as const, key: "s", run: (p: { text: string; page: number; rects: number[][] }) => addEvidence(focusDomain, p) }] : []),
      ...domains
        .filter((d) => d.id !== focusDomain?.id)
        .map((d, i) => ({ id: `rob-support-${d.id}`, label: d.name, prefix: d.short, title: `Keep this passage as support for ${d.name}`, tone: "evidence" as const, runLabel: "Support", key: i < 9 ? String(i + 1) : undefined, run: (p: { text: string; page: number; rects: number[][] }) => addEvidence(d, p) })),
    ];
  }, [a, focusDomain, addEvidence]);
  const robMode = useMemo<ReaderSelectionMode>(() => ({ id: "rob", label: "Use as support", filter: (a?.tool.domains.length ?? 0) > 5 ? "Filter domains" : undefined, hint: focusDomain ? "S the domain in focus · numbers another" : "Numbers pick the domain" }), [a, focusDomain]);
  const [marksShown, setMarksShown] = useMarksShown();
  const allMarks = useMemo<ReaderMark[]>(() => {
    if (!a) return [];
    const name = (id: string) => a.tool.domains.find((d) => d.id === id)?.name ?? id;
    return a.mine.evidence.filter((e) => e.text && e.page != null).map((e) => ({ id: `rob|${e.id}`, page: e.page ?? -1, rects: e.rects ?? [], text: e.text, tone: "evidence", label: `Support: ${name(e.domain)}` }));
  }, [a]);
  const marks = marksShown ? allMarks : [];
  const mirror = useMemo(() => mirrorOf(props.summary, allMarks), [props.summary, allMarks]);
  const markActions = useCallback(
    (mark: ReaderMark): ReaderMarkMenu | null => {
      const e = a?.mine.evidence.find((x) => `rob|${x.id}` === mark.id);
      if (!a || !e) return null;
      flashRow(`.kx-rob-domain[data-domain="${e.domain}"]`);
      return {
        title: mark.label,
        mode: { id: "rob-mark", label: mark.label },
        actions: [
          ...a.tool.domains
            .filter((d) => d.id !== e.domain)
            .map((d, i) => ({ id: `rob-move-${d.id}`, label: `Support for ${d.name} instead`, prefix: d.short, key: i < 9 ? String(i + 1) : undefined, run: () => void capi.evidence(study, result, { id: e.id, domain: e.domain }, viewer, true).then(() => addEvidence(d, { text: e.text, page: e.page ?? -1, rects: e.rects ?? [] })) })),
          { id: "rob-mark-remove", label: "Remove this support", icon: "trash" as const, tone: "danger" as const, secondary: true, key: "backspace", run: () => void run(capi.evidence(study, result, { id: e.id, domain: e.domain }, viewer, true), "Support removed") },
        ],
      };
    },
    [a, capi, study, result, viewer, run, addEvidence],
  );
  // Keyboard.
  useEffect(() => {
    if (!active || !a) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest("input, textarea, select, [contenteditable='true']");
      if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        return props.move(e.key === "ArrowDown" ? 1 : -1);
      }
      if (e.altKey && e.code === "KeyS") {
        const p = selectionPassage();
        if (!p) return notify("Select a passage in the full text first");
        e.preventDefault();
        return addEvidence(focusDomain, p);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        return void run(capi.complete(study, result, !a.mine.complete, viewer), a.mine.complete ? "Reopened" : "Assessment complete");
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setCursor((c) => Math.min(rows.length - 1, c + 1));
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (/^[1-9]$/.test(e.key) && at) {
        const n = Number(e.key) - 1;
        if (at.question) {
          const d = a.tool.domains.find((x) => x.id === at.domain)!;
          const q = d.questions.find((x) => x.id === at.question)!;
          const opt = a.tool.optionSets[q.options]?.[n];
          if (!opt) return;
          e.preventDefault();
          void answer(at.domain, at.question, opt.id);
          setCursor((c) => Math.min(rows.length - 1, c + 1));
        } else {
          const l = a.tool.levels[n];
          if (!l) return;
          e.preventDefault();
          void answer(at.domain, null, l.id);
        }
      } else if (e.key === "Enter" && at && !at.question) {
        const s = a.suggestions[at.domain];
        if (s) {
          e.preventDefault();
          void answer(at.domain, null, s.level);
          setCursor((c) => Math.min(rows.length - 1, c + 1));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, a, rows, at, answer, addEvidence, focusDomain, capi, study, result, viewer, run, notify, props]);
  useEffect(() => {
    side.current?.querySelector("[data-cursor]")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!a || !r) return <div className="kx-rv-loading" aria-busy="true" />;
  const show = (e: RobEvidence) => reader.current?.showMark(`rob|${e.id}`) || reader.current?.show(Math.max(0, e.page), e.text);
  const levelOf = (id?: string) => a.tool.levels.find((l) => l.id === id);
  const studyRow = props.overview.studies.find((s) => s.id === study);
  const toolUsed = studyRow?.results.some((x) => x.progress !== "notStarted");
  const domains = [...a.tool.domains, { id: "overall", short: "Overall", name: "Overall", prompt: a.tool.overall.note, questions: [], rule: { kind: a.tool.overall.kind, map: [], thresholds: [] }, applicability: false } as RobDomain];
  const rowOf = (domain: string, question?: string) => rows.findIndex((x) => x.domain === domain && x.question === question);
  return (
    <div className="kx-rv-extract-body" data-layout={mime ? "reader" : "form"}>
      {mime ? (
        <section className="kx-rv-reader-main" aria-label="Full text">
          <header className="kx-rv-compact">
            <div className="kx-rv-compact-main">
              <h2 className="kx-rv-record-title">{r.meta.title}</h2>
              <p className="kx-rv-compact-sub">{[r.meta.authors.slice(0, 3).join("; "), r.meta.journal, r.meta.year].filter(Boolean).join(" · ")}</p>
            </div>
          </header>
          <Suspense fallback={<div className="kx-rv-reader" aria-busy="true" />}>
            <ReviewReader
              ref={reader}
              api={api}
              recordId={study}
              version={version}
              title={r.meta.title}
              mime={mime}
              sourceId={r.fulltext.file ? null : r.sourceId}
              invoke={(command, args) => props.invoke(command, args as Record<string, unknown>, props.workspaceId)}
              actions={actions}
              mode={robMode}
              marks={marks}
              markActions={markActions}
              mirror={mirror}
              onError={(t) => notify(t, "error")}
            />
          </Suspense>
        </section>
      ) : (
        <section className="kx-rv-reader-main kx-rv-reader-none">
          <h2 className="kx-rv-record-title">{r.meta.title}</h2>
          <p className="kx-rv-muted">No full text for this study yet: attach one at Full text › Full texts to pick supporting passages from it with their place.</p>
          {r.meta.abstractText && <p className="kx-rv-compact-abstract">{r.meta.abstractText}</p>}
        </section>
      )}
      <aside className="kx-rv-xside kx-rob-side" aria-label="Risk-of-bias assessment" ref={side}>
        <div className="kx-rob-head">
          <div>
            <h2>{a.resultLabel === "Whole study" ? a.studyLabel : `${a.studyLabel} · ${a.resultLabel}`}</h2>
            <p className="kx-rv-muted">
              <select
                className="kx-rv-select kx-rob-tool"
                aria-label="Tool"
                value={a.tool.id}
                disabled={toolUsed}
                title={toolUsed ? "Judgements are recorded with this tool" : "The tool this study is assessed with"}
                onChange={(e) => void run(capi.studyPlan(study, { tool: e.target.value, results: null }, viewer))}
              >
                {props.overview.tools.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {a.tool.url && (
                <a href={a.tool.url} target="_blank" rel="noreferrer" title="The official tool and its guidance">
                  Official tool <Icon name="external" size={10} />
                </a>
              )}
            </p>
          </div>
          <ProgressPill a={a} />
        </div>
        {a.tool.domains.every((d) => !d.questions.length) && a.tool.url && (
          <p className="kx-rob-structure">Key provides the assessment structure; the questions are in the official tool. Answer them there and record each judgement, its basis and supporting passages here.</p>
        )}
        {a.need > 1 && (
          <p className="kx-rv-muted kx-rob-who">
            {a.completeCount} of {a.need} assessors done.
            {a.blind && !a.canSeeOthers ? " Blind: others' judgements show once everyone has finished." : ""}
          </p>
        )}
        {mime && <MarksLegend kinds={["evidence"]} shown={marksShown} onShown={setMarksShown} count={a.mine.evidence.length} marks={allMarks} onShow={(id) => reader.current?.showMark(id)} />}
        {domains.map((d) => {
          const isOverall = d.id === "overall";
          const mine = a.mine.judgements[d.id];
          const suggestion = a.suggestions[d.id];
          const differs = !!(suggestion && mine && mine.value !== suggestion.level);
          const final = a.finals[d.id];
          const agreed = a.agreed?.[d.id];
          const conflict = a.conflicts.includes(d.id);
          const evidence = a.mine.evidence.filter((e) => e.domain === d.id);
          const judgementRow = rowOf(d.id);
          return (
            <fieldset key={d.id} className="kx-rv-xsection kx-rob-domain" data-domain={d.id} data-conflict={conflict || undefined} data-focus={at?.domain === d.id || undefined}>
              <legend>
                {!isOverall && <span className="kx-rob-short">{d.short}</span>}
                {d.name}
                {d.applicability && <span className="kx-rv-pill">Applicability</span>}
                {agreed && <LevelDot level={levelOf(agreed)} label={false} />}
              </legend>
              {d.prompt && <p className="kx-rv-muted">{d.prompt}</p>}
              {!isOverall && !d.questions.length && a.tool.url && (
                <p className="kx-rob-official">
                  The questions for this domain are in the official tool.{" "}
                  <a href={a.tool.url} target="_blank" rel="noreferrer">
                    Open the official tool <Icon name="external" size={10} />
                  </a>
                </p>
              )}
              {d.questions.map((q) => {
                const idx = rowOf(d.id, q.id);
                if (idx < 0) return null;
                const value = a.mine.answers[`${d.id}/${q.id}`];
                const opts = a.tool.optionSets[q.options] ?? [];
                return (
                  <div key={q.id} className="kx-rob-q" data-cursor={idx === cursor || undefined} onClick={() => setCursor(idx)}>
                    <p>{q.text}</p>
                    <div className="kx-rob-opts" role="radiogroup" aria-label={q.text}>
                      {opts.map((opt, n) => (
                        <button key={opt.id} type="button" role="radio" aria-checked={value === opt.id} title={`${opt.label} (${n + 1})`} onClick={() => void answer(d.id, q.id, value === opt.id ? "" : opt.id)}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    {a.canSeeOthers &&
                      a.others
                        .filter((x) => x.answers?.[`${d.id}/${q.id}`] && x.answers[`${d.id}/${q.id}`] !== value)
                        .map((x) => (
                          <small key={x.id} className="kx-rob-other">
                            {x.name}: {opts.find((o) => o.id === x.answers![`${d.id}/${q.id}`])?.label}
                          </small>
                        ))}
                  </div>
                );
              })}
              <div className="kx-rob-judge" data-cursor={judgementRow === cursor || undefined} onClick={() => setCursor(judgementRow)}>
                <div className="kx-rob-judge-head">
                  <span>{isOverall ? "Overall judgement" : "Judgement"}</span>
                  {suggestion ? (
                    <button type="button" className="kx-rob-suggest" title={`${suggestion.why}. Enter takes it.`} onClick={(e) => { e.stopPropagation(); void answer(d.id, null, suggestion.level); }} data-taken={mine?.value === suggestion.level || undefined}>
                      Suggested <LevelDot level={levelOf(suggestion.level)} size={12} />
                    </button>
                  ) : (
                    d.questions.length > 0 && <span className="kx-rv-muted">Answer the questions for a suggestion</span>
                  )}
                </div>
                {suggestion && <p className="kx-rob-why">{suggestion.why}</p>}
                <div className="kx-rob-levels" role="radiogroup" aria-label={`${d.name} judgement`}>
                  {a.tool.levels.map((l, n) => (
                    <button key={l.id} type="button" role="radio" aria-checked={mine?.value === l.id} title={`${l.label} (${n + 1})`} onClick={() => void answer(d.id, null, mine?.value === l.id ? "" : l.id, { reason: mine?.reason, support: mine?.support })}>
                      <LevelDot level={l} size={12} />
                    </button>
                  ))}
                </div>
                {differs && (
                  <textarea
                    key={`reason-${mine?.event}`}
                    className="kx-rv-input kx-rob-reason"
                    rows={2}
                    placeholder="Why your judgement differs from the suggestion (required)"
                    defaultValue={mine?.reason ?? ""}
                    data-waiting={!mine?.reason || undefined}
                    onBlur={(e) => e.currentTarget.value.trim() !== (mine?.reason ?? "") && void answer(d.id, null, mine!.value, { reason: e.currentTarget.value, support: mine?.support })}
                  />
                )}
                {mine && (
                  <textarea
                    key={`support-${mine.event}`}
                    className="kx-rv-input kx-rob-support"
                    rows={2}
                    placeholder={d.questions.length || isOverall ? "Support for the judgement, in your words" : "Basis for the judgement: what the official tool's questions led you to"}
                    defaultValue={mine.support ?? ""}
                    onBlur={(e) => e.currentTarget.value.trim() !== (mine.support ?? "") && void answer(d.id, null, mine.value, { reason: mine.reason, support: e.currentTarget.value })}
                  />
                )}
              </div>
              {evidence.length > 0 && (
                <ul className="kx-rob-evidence">
                  {evidence.map((e) => (
                    <li key={e.id}>
                      <button type="button" className="kx-rv-source-chip" data-placed={e.page >= 0 || undefined} title="Show it in the full text" onClick={() => show(e)}>
                        <Icon name="quote" size={10} />
                        {e.page >= 0 ? `p. ${e.page + 1}` : ""}
                        <span>“{e.text.slice(0, 70)}{e.text.length > 70 ? "…" : ""}”</span>
                      </button>
                      <button type="button" className="kx-rv-icon" aria-label="Remove this support" onClick={() => void run(capi.evidence(study, result, { id: e.id, domain: d.id }, viewer, true))}>
                        <Icon name="close" size={10} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {a.canSeeOthers && a.others.length > 0 && (
                <div className="kx-rob-compare">
                  {a.others.map((x) => {
                    const j = x.judgements?.[d.id];
                    return (
                      <span key={x.id} className="kx-rob-other" data-differs={(j && j.value !== mine?.value) || undefined}>
                        {x.name}: {j ? <LevelDot level={levelOf(j.value)} size={12} /> : "not judged"}
                        {j?.support && <em title={j.support}> “{j.support.slice(0, 50)}”</em>}
                        {(x.evidence ?? []).filter((e) => e.domain === d.id).map((e) => (
                          <button key={e.id} type="button" className="kx-rv-source-chip" title={e.text} onClick={() => show(e)}>
                            <Icon name="quote" size={10} />
                            {e.page >= 0 ? `p. ${e.page + 1}` : "quote"}
                          </button>
                        ))}
                      </span>
                    );
                  })}
                </div>
              )}
              {(conflict || final) && (
                <div className="kx-rob-final">
                  {final ? (
                    <span>
                      Agreed: <LevelDot level={levelOf(final.value)} size={12} />
                      {final.support ? <em> {final.support}</em> : null}
                    </span>
                  ) : (
                    <span className="kx-rob-conflict-note">The assessors differ.</span>
                  )}
                  {a.canResolve && (
                    <MenuButton
                      label="Agree on a judgement"
                      icon="check"
                      items={a.tool.levels.map((l) => ({ label: l.label, checked: final?.value === l.id, run: () => void run(capi.final(study, result, d.id, l.id, "", viewer), `${d.name}: ${l.label}`) }))}
                    >
                      {final ? "Change" : "Agree on…"}
                    </MenuButton>
                  )}
                </div>
              )}
            </fieldset>
          );
        })}
        <div className="kx-rob-footer">
          {a.mine.complete ? (
            <Btn onClick={() => void run(capi.complete(study, result, false, viewer), "Reopened")}>Reopen</Btn>
          ) : (
            <Btn primary onClick={() => void run(capi.complete(study, result, true, viewer), "Assessment complete")} title="Checks every domain and the overall judgement (⌘↩)">
              Mark complete
            </Btn>
          )}
          <Btn quiet onClick={() => props.move(1)} title="⌥↓">
            Next
          </Btn>
        </div>
        <Hint help="review.rob.keys" />
      </aside>
    </div>
  );
}

function ProgressPill({ a }: { a: RobAssessment }) {
  const [tone, text] =
    a.progress === "done" ? ["green", "Agreed"] : a.progress === "conflict" ? ["red", "Conflict"] : a.mine.complete ? ["info", "Waiting for others"] : a.progress === "notStarted" ? ["", "Not started"] : ["amber", "In progress"];
  return (
    <span className="kx-rv-pill" data-tone={tone || undefined}>
      {text}
    </span>
  );
}

/** The selection in the embedded reader, with its page and boxes (0–65535 of the page). */
function selectionPassage(): { text: string; page: number; rects: number[][] } | null {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? "";
  if (!sel || !text || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const pageEl = node?.closest<HTMLElement>("[data-page-index]");
  if (!pageEl || !pageEl.closest(".kx-rv-reader")) return null;
  const page = Number(pageEl.dataset.pageIndex ?? 0);
  const box = pageEl.getBoundingClientRect();
  const unit = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 65535);
  const rects = [...range.getClientRects()].map((r) => [unit((r.left - box.left) / box.width), unit((r.top - box.top) / box.height), unit(r.width / box.width), unit(r.height / box.height)]);
  return { text, page, rects };
}

// ── Conflicts ───────────────────────────────────────────────────────────────────────

function Conflicts({ overview, open }: { overview: RobOverview; open: (study: string, result: string) => void }) {
  if (!overview.conflicts.length)
    return (
      <div className="kx-rob-pane">
        <EmptyState help="empty.review.rob.conflicts" icon="check" compact />
      </div>
    );
  return (
    <div className="kx-rob-pane">
      <table className="kx-rv-table kx-rob-conflicts">
        <thead>
          <tr>
            <th>Study</th>
            <th>Result</th>
            <th>Domains that differ</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {overview.conflicts.map((c) => (
            <tr key={`${c.study}|${c.result}`}>
              <td>{c.label}</td>
              <td>{c.resultLabel}</td>
              <td>{c.domains.join(", ")}</td>
              <td className="kx-rv-num">
                <Btn small onClick={() => open(c.study, c.result)}>
                  Settle
                </Btn>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Plots ───────────────────────────────────────────────────────────────────────────

function Plots(props: StageProps & { capi: CertaintyApi; overview: RobOverview }) {
  const { capi, api, overview, notify, summary } = props;
  const used = [...new Set(overview.studies.filter((s) => s.results.some((r) => r.overall)).map((s) => s.tool))];
  const [tool, setTool] = useState(used[0] ?? overview.setup.tool);
  const outcomes = useLoad(() => api.outcomes(), [api, summary.events]);
  const [result, setResult] = useState<string>("");
  const choice = outcomes.value?.find((o) => `${o.outcome}|${o.timepoint}` === result);
  const options = choice ? { measure: choice.kind === "continuous" ? "MD" : choice.kind === "generic" ? "GEN" : "RR", method: "reml", hartungKnapp: false, level: 0.95 } : undefined;
  const plots = useLoad(() => capi.plots(tool, result || null, options), [capi, tool, result, summary.events, choice?.kind]);
  const traffic = useRef<SVGSVGElement>(null);
  const bars = useRef<SVGSVGElement>(null);
  const weighted = useRef<SVGSVGElement>(null);
  const p = plots.value;
  const levels = (p?.tool.levels ?? []).map((l) => mark(l)!);
  const columns = p ? [...p.domains.map((d) => ({ short: d.short, name: d.name, id: d.id })), { short: "Overall", name: "Overall", id: "overall" }] : [];
  const exportItems = (ref: React.RefObject<SVGSVGElement | null>, name: string) => [
    { label: "SVG image", run: () => ref.current && saveFile(`${name}.svg`, svgMarkup(ref.current)) },
    { label: "PNG image", run: () => ref.current && void pngBlob(ref.current, 3).then((b) => saveFile(`${name}.png`, b)).catch((e) => notify(errorText(e), "error")) },
  ];
  const label = (d: { short: string; name: string }) => (d.short === "Overall" ? "Overall" : `${d.short} ${d.name}`);
  return (
    <div className="kx-rob-pane">
      <div className="kx-rv-analysis-controls">
        <label className="kx-rv-field">
          <span>Tool</span>
          <select className="kx-rv-select" value={tool} onChange={(e) => setTool(e.target.value)}>
            {overview.tools.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="kx-rv-field">
          <span>Result</span>
          <select className="kx-rv-select" value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="">Every assessment</option>
            {outcomes.value?.map((o) => (
              <option key={`${o.outcome}|${o.timepoint}`} value={`${o.outcome}|${o.timepoint}`}>
                {o.outcome}
                {o.timepoint ? ` · ${o.timepoint}` : ""}
              </option>
            ))}
          </select>
        </label>
        <Explain help="review.rob.plots" />
      </div>
      {plots.error && <p className="kx-inline-error">{plots.error}</p>}
      {p && !p.rows.length && <EmptyState help="empty.review.rob.plots" icon="activity" compact />}
      {p && p.rows.length > 0 && (
        <>
          <section className="kx-rv-section">
            <div className="kx-rv-section-head">
              <h2>Traffic-light plot</h2>
              <MenuButton label="Export traffic-light plot" icon="download" items={exportItems(traffic, `risk-of-bias-${tool}-traffic-light`)} />
            </div>
            <TrafficLight ref={traffic} title={`${p.tool.name}${choice ? `: ${choice.outcome}` : ""}`} columns={columns} rows={p.rows.map((r) => ({ id: `${r.study}|${r.result}`, label: r.label, marks: columns.map((c) => mark(r.cells[c.id])) }))} levels={levels} width={Math.max(520, 260 + columns.length * 26)} />
            {p.rows.some((r) => !r.done) && <p className="kx-rv-muted">Rows include judgements agreed so far; assessments still open show what is settled.</p>}
          </section>
          <div className="kx-rv-analysis-grid">
            <section className="kx-rv-section">
              <div className="kx-rv-section-head">
                <h2>Summary (share of studies)</h2>
                <MenuButton label="Export summary plot" icon="download" items={exportItems(bars, `risk-of-bias-${tool}-summary`)} />
              </div>
              <RobSummary ref={bars} levels={levels} bars={p.summary.map((s) => ({ label: label(s), shares: s.unweighted.map((x) => x.share) }))} />
            </section>
            <section className="kx-rv-section">
              <div className="kx-rv-section-head">
                <h2>Summary (share of the weight)</h2>
                {p.weighted && <MenuButton label="Export weighted summary plot" icon="download" items={exportItems(weighted, `risk-of-bias-${tool}-weighted-summary`)} />}
              </div>
              {p.weighted ? <RobSummary ref={weighted} levels={levels} bars={p.summary.map((s) => ({ label: label(s), shares: (s.weighted ?? s.unweighted).map((x) => x.share) }))} /> : <Hint help="review.rob.weighted" />}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

// ── Tools and set-up ────────────────────────────────────────────────────────────────

function Tools(props: StageProps & { capi: CertaintyApi; overview: RobOverview; onSaved: () => void }) {
  const { capi, overview, viewer, notify, summary } = props;
  const tools = useLoad(() => capi.tools(), [capi, summary.events]);
  const [editing, setEditing] = useState<RobTool>();
  const file = useRef<HTMLInputElement>(null);
  const setup = overview.setup;
  const save = (next: Partial<{ assessors: number | null; blind: boolean | null; tool: string }>) =>
    capi
      .setup({ assessors: setup.explicit.assessors, blind: setup.explicit.blind, tool: setup.explicit.tool, ...next }, viewer)
      .then(props.onSaved)
      .catch((e) => notify(errorText(e), "error"));
  const reload = () => {
    tools.reload();
    props.onSaved();
  };
  const remove = (t: RobTool) => capi.deleteTool(t.id, viewer).then(reload).catch((e) => notify(errorText(e), "error"));
  const importJson = async (f: File) => {
    try {
      const t = JSON.parse(await f.text()) as RobTool;
      setEditing({ ...t, builtin: false });
    } catch {
      notify("This is not a risk-of-bias tool file", "error");
    }
  };
  return (
    <div className="kx-rob-pane kx-rob-tools">
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>How assessments are done</h2>
          <Explain help="review.rob.dual" />
        </div>
        <div className="kx-rv-analysis-controls">
          <div className="kx-rv-field">
            <span>Independent assessors</span>
            <Segmented label="Independent assessors" value={setup.explicit.assessors ?? 0} options={[[0, `As extraction (${summary.protocol.rules.extractors})`], [1, "One"], [2, "Two"], [3, "Three"]]} onChange={(v) => void save({ assessors: v || null })} />
          </div>
          <label className="kx-rv-field kx-rv-field-toggle" title="Assessors do not see each other's answers until all have finished">
            <span>Blind</span>
            <Toggle label="Blind" checked={setup.blind} onChange={(v) => void save({ blind: v })} />
          </label>
          <label className="kx-rv-field">
            <span>New studies start with</span>
            <select className="kx-rv-select" value={setup.tool} onChange={(e) => void save({ tool: e.target.value })}>
              {overview.tools.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      <section className="kx-rv-section">
        <div className="kx-rv-section-head">
          <h2>Tools</h2>
          <span className="kx-rv-spacer" />
          <Btn small icon="upload" onClick={() => file.current?.click()} title="Import a tool definition (JSON), for example a fuller version of a tool you hold the rights to">
            Import tool definition…
          </Btn>
          <Btn small icon="plus" onClick={() => tools.value && setEditing({ ...tools.value.blank, id: `custom-${Date.now().toString(36)}` })}>
            New tool
          </Btn>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void importJson(e.target.files[0])} />
        </div>
        <Hint help="review.rob.licence" />
        <Hint help="review.rob.import" />
        <table className="kx-rv-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>For</th>
              <th>Rates</th>
              <th>Domains</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tools.value?.tools.map((t) => (
              <tr key={t.id}>
                <td>
                  <strong>{t.name}</strong>
                  <div className="kx-rv-muted">
                    {t.builtin ? "Shipped with Key" : tools.value!.shipped.some((s) => s.id === t.id) ? `Edited here · version ${t.version}` : `Custom · version ${t.version}`}
                    {t.url && (
                      <>
                        {" · "}
                        <a href={t.url} target="_blank" rel="noreferrer">
                          official tool
                        </a>
                      </>
                    )}
                  </div>
                </td>
                <td>{t.design}</td>
                <td>{t.level === "result" ? "Each result" : "Whole studies"}</td>
                <td>{t.domains.map((d) => d.short).join(" ")}</td>
                <td className="kx-rv-num">
                  <MenuButton
                    label={`${t.name} actions`}
                    items={[
                      { label: t.builtin ? "Edit a copy…" : "Edit…", icon: "pen", run: () => setEditing(structuredClone(t)) },
                      { label: "Export as JSON", icon: "download", run: () => downloadText(`${t.id}.json`, JSON.stringify({ ...t, builtin: undefined, inUse: undefined }, null, 2), "application/json") },
                      null,
                      { label: "Remove", icon: "trash", danger: true, disabled: t.builtin || t.inUse, run: () => void remove(t) },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {editing && <ToolEditor tool={editing} onClose={() => setEditing(undefined)} onSave={(t) => capi.saveTool(t, viewer).then(() => { setEditing(undefined); reload(); notify(`${t.name} saved`, "ok"); })} />}
    </div>
  );
}

const TONES: [RobLevel["tone"], string][] = [["green", "Green"], ["amber", "Amber"], ["red", "Red"], ["darkred", "Dark red"], ["muted", "Grey"]];
const SYMBOLS: [RobLevel["symbol"], string][] = [["plus", "Plus"], ["minus", "Minus"], ["cross", "Cross"], ["excl", "Exclamation"], ["query", "Question"]];
const COMMONS: [RobLevel["common"], string][] = [["low", "Low risk"], ["some", "Some concerns"], ["high", "High risk"], ["critical", "Critical"], ["unclear", "Unclear"]];

/** The custom tool builder: levels, domains and their questions, and the suggestion rules. */
function ToolEditor({ tool: initial, onClose, onSave }: { tool: RobTool; onClose: () => void; onSave: (t: RobTool) => Promise<unknown> }) {
  const [t, setT] = useState<RobTool>(initial);
  const [error, setError] = useState("");
  const set = (patch: Partial<RobTool>) => setT((x) => ({ ...x, ...patch }));
  const setDomain = (i: number, patch: Partial<RobDomain>) => set({ domains: t.domains.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  const sets = Object.keys(t.optionSets);
  const firstSet = sets[0] ?? "ynu";
  return (
    <GlobalDialog label="Risk-of-bias tool" onClose={onClose}>
      <div className="kx-rv-dialog kx-rob-editor">
        <h2>{initial.builtin ? `Edit a copy of ${initial.name}` : t.name || "New tool"}</h2>
        <div className="kx-rob-grid">
          <label className="kx-rv-field">
            <span>Name</span>
            <input className="kx-rv-input" value={t.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="kx-rv-field">
            <span>Short name</span>
            <input className="kx-rv-input kx-rv-short" value={t.short} onChange={(e) => set({ short: e.target.value })} />
          </label>
          <label className="kx-rv-field">
            <span>For</span>
            <input className="kx-rv-input" value={t.design} placeholder="Study design" onChange={(e) => set({ design: e.target.value })} />
          </label>
          <div className="kx-rv-field">
            <span>Rates</span>
            <Segmented label="Rates" value={t.level} options={[["study", "Whole studies"], ["result", "Each result"]]} onChange={(v) => set({ level: v })} />
          </div>
          <label className="kx-rv-field" data-wide>
            <span>Link to the official tool</span>
            <input className="kx-rv-input" value={t.url} placeholder="https://" onChange={(e) => set({ url: e.target.value })} />
          </label>
        </div>
        <h3>Judgement levels, best first</h3>
        {t.levels.map((l, i) => (
          <div key={i} className="kx-rob-level-row">
            <LevelDot level={l} label={false} />
            <input className="kx-rv-input" aria-label="Label" value={l.label} onChange={(e) => set({ levels: t.levels.map((x, j) => (j === i ? { ...x, label: e.target.value, id: x.id || e.target.value.toLowerCase().replace(/\W+/g, "-") } : x)) })} />
            <select className="kx-rv-select" aria-label="Colour" value={l.tone} onChange={(e) => set({ levels: t.levels.map((x, j) => (j === i ? { ...x, tone: e.target.value as RobLevel["tone"] } : x)) })}>
              {TONES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            </select>
            <select className="kx-rv-select" aria-label="Symbol" value={l.symbol} onChange={(e) => set({ levels: t.levels.map((x, j) => (j === i ? { ...x, symbol: e.target.value as RobLevel["symbol"] } : x)) })}>
              {SYMBOLS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            </select>
            <select className="kx-rv-select" aria-label="Counts in analyses as" title="What it counts as in analyses (sensitivity, subgroups, GRADE)" value={l.common} onChange={(e) => set({ levels: t.levels.map((x, j) => (j === i ? { ...x, common: e.target.value as RobLevel["common"] } : x)) })}>
              {COMMONS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            </select>
            <button type="button" className="kx-rv-icon" aria-label="Remove level" disabled={t.levels.length <= 2} onClick={() => set({ levels: t.levels.filter((_, j) => j !== i) })}>
              <Icon name="minus" size={12} />
            </button>
          </div>
        ))}
        <Btn small icon="plus" onClick={() => set({ levels: [...t.levels, { id: `level-${t.levels.length + 1}`, label: "New level", tone: "muted", symbol: "query", common: "unclear" }] })}>
          Level
        </Btn>
        <h3>Domains</h3>
        {t.domains.map((d, i) => (
          <fieldset key={i} className="kx-rv-xsection">
            <div className="kx-rob-level-row">
              <input className="kx-rv-input kx-rv-short" aria-label="Short name" value={d.short} onChange={(e) => setDomain(i, { short: e.target.value })} />
              <input className="kx-rv-input" aria-label="Domain name" value={d.name} onChange={(e) => setDomain(i, { name: e.target.value })} />
              <select className="kx-rv-select" aria-label="Suggestion" value={d.rule.kind} onChange={(e) => setDomain(i, { rule: { ...d.rule, kind: e.target.value, map: d.rule.map.length ? d.rule.map : t.levels.map((l) => l.id).slice(0, 3) } })}>
                <option value="worst">Suggest from the most concerning answer</option>
                <option value="manual">No suggestion</option>
                {d.rule.kind === "stars" && <option value="stars">Suggest from stars</option>}
              </select>
              <button type="button" className="kx-rv-icon" aria-label="Remove domain" disabled={t.domains.length <= 1 || initial.inUse} onClick={() => set({ domains: t.domains.filter((_, j) => j !== i) })}>
                <Icon name="trash" size={12} />
              </button>
            </div>
            <input className="kx-rv-input" aria-label="What the domain is about" placeholder="What this domain is about" value={d.prompt} onChange={(e) => setDomain(i, { prompt: e.target.value })} />
            {d.rule.kind === "worst" && (
              <p className="kx-rv-muted kx-rob-map">
                Concern none / some / serious suggests:{" "}
                {[0, 1, 2].map((n) => (
                  <select key={n} className="kx-rv-select" aria-label={`Concern ${n}`} value={d.rule.map[n] ?? ""} onChange={(e) => { const map = [...d.rule.map]; map[n] = e.target.value; setDomain(i, { rule: { ...d.rule, map } }); }}>
                    {t.levels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                ))}
              </p>
            )}
            {d.questions.map((q, k) => (
              <div key={k} className="kx-rob-qedit">
                <input className="kx-rv-input" aria-label="Question" value={q.text} onChange={(e) => setDomain(i, { questions: d.questions.map((x, j) => (j === k ? { ...x, text: e.target.value } : x)) })} />
                <span className="kx-rob-weights">
                  {(t.optionSets[q.options] ?? []).map((o) => (
                    <label key={o.id} title="Concern this answer raises: 0 none, 1 some, 2 serious">
                      {o.label}
                      <select className="kx-rv-select" value={q.weights[o.id] ?? 0} onChange={(e) => setDomain(i, { questions: d.questions.map((x, j) => (j === k ? { ...x, weights: { ...x.weights, [o.id]: Number(e.target.value) } } : x)) })}>
                        {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </label>
                  ))}
                </span>
                <button type="button" className="kx-rv-icon" aria-label="Remove question" onClick={() => setDomain(i, { questions: d.questions.filter((_, j) => j !== k) })}>
                  <Icon name="minus" size={12} />
                </button>
              </div>
            ))}
            <Btn small quiet icon="plus" onClick={() => setDomain(i, { questions: [...d.questions, { id: `q${d.questions.length + 1}-${Date.now().toString(36).slice(-3)}`, text: "", help: "", options: firstSet, weights: {}, points: {}, showIf: null }] })}>
              Question
            </Btn>
          </fieldset>
        ))}
        <Btn small icon="plus" onClick={() => set({ domains: [...t.domains, { id: `d${t.domains.length + 1}-${Date.now().toString(36).slice(-3)}`, short: `D${t.domains.length + 1}`, name: "New domain", prompt: "", questions: [], rule: { kind: "manual", map: [], thresholds: [] }, applicability: false }] })}>
          Domain
        </Btn>
        <div className="kx-rv-field kx-rob-overall-rule">
          <span>Overall judgement</span>
          <Segmented label="Overall judgement" value={t.overall.kind || "worst"} options={[["worst", "Suggest the least favourable domain"], ["manual", "No suggestion"]]} onChange={(v) => set({ overall: { ...t.overall, kind: v } })} />
        </div>
        {error && <p className="kx-inline-error">{error}</p>}
        <div className="kx-rv-dialog-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary onClick={() => onSave({ ...t, builtin: undefined, inUse: undefined }).catch((e) => setError(errorText(e)))}>
            Save tool
          </Btn>
        </div>
      </div>
    </GlobalDialog>
  );
}
