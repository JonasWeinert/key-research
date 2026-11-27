// Extraction: the study's full text in Key's reader as the main panel, its forms in the sidebar.
// A passage selected in the reader goes into a field ("Use for ‹field›…": the field last focused,
// else a picker with type-ahead and numbers); numbers in it are read the way papers write them
// ("12.3 (4.5)", "n = 120", "45%", "0.52 (0.31 to 0.88)") and offered with a confirmation; a
// table's row can be filled from one selection. Every value keeps its source (page, position
// and quoted text), shown as a chip that brings the place back. Fields shown on other answers
// appear and disappear with them; their values stay (inactive) when hidden. Completing a form
// checks it in Rust: required answers, quotes, source positions and cross-field checks, for the
// fields shown. Keys: Tab moves through fields, ⌥S takes the reader's selection for the focused
// field, ⌥↓ / ⌥↑ go to the next and previous study.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, Hint } from "../explain";
import { downloadText } from "../db-ui";
import { GlobalDialog } from "../GlobalDrawer";
import { Icon } from "../icons";
import { plural, type ExtractionView, type Field, type Form, type SourcePos, type StudyRow } from "./review-api";
import { Btn, MenuButton, errorText, useLoad } from "./review-ui";
import type { ReaderSelectionAction, ReviewReaderHandle } from "./review-reader";
import type { StageProps } from "./ReviewPage";
// std-D: the conversion helper on outcome rows.
import { ConvertHost, ConvertedMark, openConvert } from "./review-convert";

const ReviewReader = lazy(() => import("./review-reader").then((m) => ({ default: m.ReviewReader })));

type Slot = ExtractionView["values"][string];
interface Passage {
  text: string;
  page: number;
  rects: number[][];
}
type Extra = { quote?: string; page?: number | null; sourcePos?: SourcePos | null; final?: boolean };

const display = (v: unknown): string => {
  if (v == null || v === "") return "";
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? Object.values(x as object).filter((y) => y !== "" && y != null).join(" / ") : String(x))).join("; ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
};

export function Extraction(props: StageProps) {
  const { api, summary, viewer, notify, active } = props;
  const studies = useLoad(() => api.studies(viewer), [api, viewer, summary.events]);
  const [current, setCurrent] = useState<string>();
  const list = studies.value?.studies ?? [];
  useEffect(() => {
    if (!current && list.length) setCurrent(list[0].id);
  }, [list, current]);
  const move = useCallback(
    (by: number) => {
      const i = list.findIndex((s) => s.id === current);
      const next = list[Math.min(list.length - 1, Math.max(0, i + by))];
      if (next) setCurrent(next.id);
    },
    [list, current],
  );
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        move(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, move]);
  const exportFile = (kind: string) => api.exportFile(kind, viewer).then((f) => downloadText(f.filename, f.content, f.mime)).catch((e) => notify(errorText(e), "error"));
  if (!summary.included) return <EmptyState help="empty.review.extraction" icon="table" action={{ label: "Go to full-text screening", onClick: () => props.go("ft") }} learnMore="review.extraction" />;
  const study = list.find((s) => s.id === current);
  const at = list.findIndex((s) => s.id === current);
  return (
    <div className="kx-rv-extract">
      <ConvertHost invoke={props.invoke} workspaceId={props.workspaceId} reviewId={props.reviewId} />
      <div className="kx-rv-toolbar kx-rv-extract-bar">
        <span className="kx-rv-nav">
          <button type="button" className="kx-rv-icon" aria-label="Previous study" title="Previous study (⌥↑)" onClick={() => move(-1)}>
            <Icon name="chevronLeft" size={14} />
          </button>
          <select className="kx-rv-select kx-rv-study-pick" value={current ?? ""} onChange={(e) => setCurrent(e.target.value)} aria-label="Study">
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                {(s.byline || s.title).slice(0, 80)}
                {s.missingRequired ? ` · ${s.missingRequired} left` : ""}
              </option>
            ))}
          </select>
          <button type="button" className="kx-rv-icon" aria-label="Next study" title="Next study (⌥↓)" onClick={() => move(1)}>
            <Icon name="chevronRight" size={14} />
          </button>
        </span>
        <span className="kx-rv-muted">
          {at + 1} of {plural(list.length, "study", "studies")}
          {study?.conflicts ? ` · ${study.conflicts} differ` : ""}
        </span>
        <span className="kx-rv-spacer" />
        <MenuButton
          label="Export extraction"
          icon="download"
          items={[
            { label: "Extraction table (CSV, one row per study, with sources)", run: () => void exportFile("extraction") },
            { label: "Long format (CSV, one row per value)", run: () => void exportFile("extraction-long") },
            { label: "Data dictionary (CSV: fields, types, options, show-when)", run: () => void exportFile("dictionary") },
            { label: "Outcome data for R (meta, metafor)", run: () => void exportFile("outcomes") },
            { label: "Outcome data (CSV for RevMan-style entry)", run: () => void exportFile("outcome-table") },
          ]}
        />
      </div>
      {study && <StudyWorkspace key={study.id} {...props} study={study} onSaved={studies.reload} />}
    </div>
  );
}

function StudyWorkspace(props: StageProps & { study: StudyRow; onSaved: () => void }) {
  const { api, viewer, study, notify, active } = props;
  const recordId = study.id;
  const view = useLoad(() => api.extraction(recordId, viewer), [api, recordId, viewer]);
  const record = useLoad(() => api.record(recordId, "ft", viewer), [api, recordId, viewer]);
  const [asking, setAsking] = useState(false);
  /** The field a passage goes to first: the last one focused. */
  const [focused, setFocused] = useState<{ form: Form; field: Field }>();
  const [using, setUsing] = useState<Passage>();
  const [mime, setMime] = useState<string>();
  const reader = useRef<ReviewReaderHandle>(null);
  const r = record.value;
  const version = r?.fulltext.file?.hash ?? r?.sourceId ?? "";
  useEffect(() => {
    if (!r?.hasFullText) return setMime("");
    api
      .fulltextInfo(recordId)
      .then((i) => setMime(i.exists ? i.mime : ""))
      .catch(() => setMime(""));
  }, [api, recordId, r?.hasFullText, version]);

  const save = useCallback(
    (form: Form, field: Field, value: unknown, extra: Extra) =>
      api
        .extract(recordId, form.id, field.id, value, { ...extra, sourceId: r?.sourceId ?? null }, viewer)
        .then(() => {
          view.reload();
          props.onSaved();
        })
        .catch((e) => notify(errorText(e), "error")),
    [api, recordId, r?.sourceId, viewer, view, props, notify],
  );

  const actions = useMemo<ReaderSelectionAction[]>(
    () => [{ id: "review-use", label: focused ? `Use for ${focused.field.label}…` : "Use for field…", title: "Put this passage (and its place) into a field", run: (p) => setUsing(p) }],
    [focused],
  );
  // ⌥S: the reader's selection for the focused field.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.altKey && e.code === "KeyS")) return;
      const p = selectionPassage();
      if (!p) return notify("Select a passage in the full text first");
      e.preventDefault();
      setUsing(p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, notify]);

  if (!view.value || !r) return <div className="kx-rv-loading" aria-busy="true" />;
  const v = view.value;
  const show = (pos: SourcePos | null | undefined, page?: number | null, quote?: string) => {
    if (pos && pos.page >= 0) reader.current?.show(pos.page, pos.text);
    else if (page) reader.current?.show(page - 1, quote);
  };
  const forms = (
    <div className="kx-rv-xforms">
      {props.summary.protocol.rules.aiAssist && (
        <div className="kx-rv-extract-tools">
          <MenuButton
            label="Suggest values with AI"
            icon="sparkle"
            title="Ask the AI model chosen in Key Settings for values from the abstract and full text, each with its quote and page. Suggestions are not values until you use them."
            items={v.forms.map((f) => ({
              label: f.name,
              run: () => {
                setAsking(true);
                api
                  .aiExtract(recordId, f.id)
                  .then((res) => {
                    notify(res.suggested ? `${plural(res.suggested, "suggestion")} from AI: check each, then use it` : "The AI found nothing to suggest", "ok");
                    view.reload();
                  })
                  .catch((e) => notify(errorText(e), "error"))
                  .finally(() => setAsking(false));
              },
            }))}
          >
            {asking ? "Asking AI…" : "Suggest with AI"}
          </MenuButton>
        </div>
      )}
      {v.forms.map((form) => (
        <FormView key={form.id} {...props} form={form} view={v} recordId={recordId} save={save} onFocus={(field) => setFocused({ form, field })} onShow={show} reload={view.reload} />
      ))}
      <Hint help="review.extraction.quotes" />
      {v.forms.some((f) => f.kind === "outcomes") && <Hint help="review.outcomes.table" />}
    </div>
  );
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
            <ReviewReader ref={reader} api={api} recordId={recordId} version={version} title={r.meta.title} mime={mime} actions={actions} onError={(t) => notify(t, "error")} />
          </Suspense>
        </section>
      ) : (
        <section className="kx-rv-reader-main kx-rv-reader-none">
          <h2 className="kx-rv-record-title">{r.meta.title}</h2>
          <p className="kx-rv-muted">No full text for this study yet: attach one at Full text › Full texts, then values can be picked from it with their place.</p>
          {r.meta.abstractText && <p className="kx-rv-compact-abstract">{r.meta.abstractText}</p>}
        </section>
      )}
      <aside className="kx-rv-xside" aria-label="Extraction form">
        {forms}
      </aside>
      {using && <UsePassage {...props} passage={using} forms={v} focused={focused} onClose={() => setUsing(undefined)} save={save} />}
    </div>
  );
}

/** The selection in the embedded reader, with its page and boxes (0–65535 of the page). */
function selectionPassage(): Passage | null {
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

function FormView(props: StageProps & { form: Form; view: ExtractionView; recordId: string; save: (form: Form, field: Field, value: unknown, extra: Extra) => Promise<void>; onFocus: (f: Field) => void; onShow: (pos: SourcePos | null | undefined, page?: number | null, quote?: string) => void; reload: () => void }) {
  const { form, view, api, recordId, viewer, notify, summary } = props;
  const state = view.formState?.[form.id];
  const visible = new Set(state?.visible ?? form.sections.flatMap((s) => s.fields.map((f) => f.id)));
  const issues = state?.issues ?? [];
  const inactive = form.sections.flatMap((s) => s.fields).filter((f) => view.values[`${form.id}/${f.id}`]?.inactive);
  const complete = () =>
    api
      .completeForm(recordId, form.id, viewer)
      .then(() => {
        notify(`${form.name} complete`, "ok");
        props.reload();
      })
      .catch((e) => notify(errorText(e), "error"));
  return (
    <div className="kx-rv-xform">
      <div className="kx-rv-xform-head">
        <h2>{form.name}</h2>
        {state?.completed ? (
          <span className="kx-rv-pill" data-tone="green">
            <Icon name="check" size={10} /> Complete
          </span>
        ) : (
          <Btn small onClick={complete} title="Checks required answers, quotes and source positions for the questions shown">
            Complete form
          </Btn>
        )}
      </div>
      {issues.length > 0 && !state?.completed && (
        <details className="kx-rv-issues">
          <summary>{plural(issues.length, "thing")} still needed</summary>
          <ul>
            {issues.map((i, n) => (
              <li key={n} data-kind={i.kind}>
                {i.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {form.sections.map((section) => {
        const fields = section.fields.filter((f) => visible.has(f.id));
        if (!fields.length) return null;
        return (
          <fieldset key={section.id} className="kx-rv-xsection">
            <legend>{section.title}</legend>
            {section.guidance && <p className="kx-rv-muted">{section.guidance}</p>}
            {fields.map((field) => (
              <FieldInput
                key={field.id}
                form={form}
                field={field}
                shownWhen={state?.shownWhen?.[field.id]}
                needQuote={field.quote || summary.protocol.rules.quoteRequired}
                slot={view.values[`${form.id}/${field.id}`]}
                extractors={view.extractors}
                onSave={(value, extra) => props.save(form, field, value, extra)}
                onFocus={() => props.onFocus(field)}
                onShow={props.onShow}
                canAgree={summary.canResolve || summary.protocol.rules.conflicts === "consensus"}
              />
            ))}
          </fieldset>
        );
      })}
      {inactive.length > 0 && (
        <p className="kx-rv-muted kx-rv-inactive" title={inactive.map((f) => f.label).join(", ")}>
          {plural(inactive.length, "answer")} kept for questions now hidden by other answers (not exported, not required).
        </p>
      )}
    </div>
  );
}

function SourceChip({ pos, page, quote, onShow }: { pos?: SourcePos | null; page?: number | null; quote?: string; onShow: () => void }) {
  const p = pos && pos.page >= 0 ? pos.page + 1 : page;
  const text = pos?.text || quote || "";
  if (!p && !text) return null;
  return (
    <button type="button" className="kx-rv-source-chip" data-placed={pos ? true : undefined} title={pos ? "Show it in the full text" : "Typed quote (no position)"} onClick={onShow}>
      <Icon name="quote" size={10} />
      {p ? `p. ${p}` : ""}
      {text && <span>“{text.slice(0, 60)}{text.length > 60 ? "…" : ""}”</span>}
    </button>
  );
}

function FieldInput({ field, slot, onSave, onFocus, onShow, extractors, canAgree, needQuote, shownWhen }: { form: Form; field: Field; needQuote: boolean; slot: Slot | undefined; shownWhen?: string; onSave: (value: unknown, extra: Extra) => void; onFocus: () => void; onShow: (pos: SourcePos | null | undefined, page?: number | null, quote?: string) => void; extractors: number; canAgree: boolean }) {
  const mine = slot?.mine;
  const empty = field.kind === "table" || field.kind === "multi" ? [] : "";
  const [value, setValue] = useState<unknown>(mine?.value ?? empty);
  const [quote, setQuote] = useState(mine?.quote ?? "");
  const [page, setPage] = useState<number | null>(mine?.page ?? null);
  const [quoting, setQuoting] = useState(false);
  useEffect(() => {
    setValue(mine?.value ?? empty);
    setQuote(mine?.quote ?? "");
    setPage(mine?.page ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine?.event]);
  const source = slot?.source ?? "none";
  const commit = (v = value, q = quote, p = page) => {
    if (JSON.stringify(v) === JSON.stringify(mine?.value ?? empty) && q === (mine?.quote ?? "") && p === (mine?.page ?? null)) return;
    // A typed change keeps the place it was taken from only while the quote stays the same.
    onSave(v, { quote: q, page: p, sourcePos: q === (mine?.quote ?? "") ? (mine?.sourcePos ?? null) : null });
  };
  const input = (() => {
    switch (field.kind) {
      case "longtext":
        return <textarea className="kx-rv-input" rows={3} value={String(value ?? "")} onFocus={onFocus} onChange={(e) => setValue(e.target.value)} onBlur={() => commit()} />;
      case "number":
        return (
          <span className="kx-rv-inline">
            <input className="kx-rv-input kx-rv-short" inputMode="decimal" value={String(value ?? "")} onFocus={onFocus} onChange={(e) => setValue(e.target.value)} onBlur={() => commit(value === "" ? "" : Number.isNaN(Number(value)) ? value : Number(value))} />
            {field.unit && <span className="kx-rv-muted">{field.unit}</span>}
          </span>
        );
      case "date":
        return <input className="kx-rv-input kx-rv-date" type="date" value={String(value ?? "")} onFocus={onFocus} onChange={(e) => (setValue(e.target.value), commit(e.target.value))} />;
      case "yesno":
        return (
          <span className="kx-rv-seg" role="radiogroup" aria-label={field.label}>
            {[
              [true, "Yes"],
              [false, "No"],
              ["unclear", "Unclear"],
            ].map(([v, l]) => (
              <button key={String(v)} type="button" role="radio" aria-checked={value === v} onFocus={onFocus} onClick={() => (setValue(v), commit(v))}>
                {String(l)}
              </button>
            ))}
          </span>
        );
      case "choice":
        return (
          <select className="kx-rv-select" aria-label={field.label} value={String(value ?? "")} onFocus={onFocus} onChange={(e) => (setValue(e.target.value), commit(e.target.value))}>
            <option value="">—</option>
            {field.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        );
      case "multi": {
        const list = Array.isArray(value) ? (value as string[]) : [];
        return (
          <span className="kx-rv-inline kx-rv-wrap">
            {field.options.map((o) => (
              <label key={o} className="kx-check">
                <input
                  type="checkbox"
                  checked={list.includes(o)}
                  onFocus={onFocus}
                  onChange={(e) => {
                    const next = e.target.checked ? [...list, o] : list.filter((x) => x !== o);
                    setValue(next);
                    commit(next);
                  }}
                />
                {o}
              </label>
            ))}
          </span>
        );
      }
      case "table":
        return <TableInput field={field} value={Array.isArray(value) ? (value as Record<string, unknown>[]) : []} onFocus={onFocus} onChange={(v) => setValue(v)} onCommit={(v) => commit(v)} />;
      default:
        return <input className="kx-rv-input" aria-label={field.label} value={String(value ?? "")} onFocus={onFocus} onChange={(e) => setValue(e.target.value)} onBlur={() => commit()} />;
    }
  })();
  const differs = slot?.differs && !slot.final;
  const placed = !!mine?.sourcePos;
  return (
    <div className="kx-rv-xfield" data-kind={field.kind} data-differs={differs || undefined} data-field={field.id}>
      <div className="kx-rv-xfield-label">
        <span>
          {field.label}
          {field.required && <span className="kx-rv-required" aria-label="required">*</span>}
          {source !== "none" && !placed && (
            <small className="kx-rv-source-need" data-required={source === "required" || undefined} title="Select the passage in the full text and choose Use for field (or ⌥S)">
              {source === "required" ? " · pick it from the document" : " · its place helps"}
            </small>
          )}
        </span>
        {shownWhen && <small className="kx-rv-rule-chip">{shownWhen}</small>}
        {field.guidance && <small>{field.guidance}</small>}
        {!(quote || quoting) && (
          <button type="button" className="kx-link-button kx-rv-quote-add" data-needed={needQuote || undefined} onClick={() => setQuoting(true)}>
            {needQuote ? "Add the quote (required)" : "Type a quote"}
          </button>
        )}
      </div>
      <div className="kx-rv-xfield-input">
        {input}
        {mine && <SourceChip pos={mine.sourcePos} page={mine.page} quote={mine.quote} onShow={() => onShow(mine.sourcePos, mine.page, mine.quote)} />}
        {(quoting || (quote && !placed)) && (
          <div className="kx-rv-quote">
            <textarea className="kx-rv-input" rows={2} placeholder="Quote from the paper" value={quote} onChange={(e) => setQuote(e.target.value)} onBlur={() => commit()} aria-label="Quote" />
            <input className="kx-rv-input kx-rv-page" placeholder="p." inputMode="numeric" value={page ?? ""} onChange={(e) => setPage(e.target.value ? Number(e.target.value) : null)} onBlur={() => commit()} aria-label="Page" />
          </div>
        )}
        {slot?.suggestion && !slot.final && JSON.stringify(slot.suggestion.value) !== JSON.stringify(mine?.value) && (
          <div className="kx-rv-xsuggestion">
            <Icon name="sparkle" size={11} />
            <span>
              <strong>AI suggests</strong> {display(slot.suggestion.value)}
              {slot.suggestion.quote ? <small>“{slot.suggestion.quote.slice(0, 160)}”{slot.suggestion.page ? ` p. ${slot.suggestion.page}` : ""}</small> : <small>No quote found in the text: check it</small>}
            </span>
            {slot.suggestion.page && (
              <Btn small quiet onClick={() => onShow(slot.suggestion!.sourcePos, slot.suggestion!.page, slot.suggestion!.quote)}>
                Show
              </Btn>
            )}
            <Btn
              small
              onClick={() => {
                const s = slot.suggestion!;
                setValue(s.value);
                setQuote(s.quote);
                setPage(s.page);
                // The suggestion's place: its page and quote, located in the text when shown.
                onSave(s.value, { quote: s.quote, page: s.page, sourcePos: s.sourcePos ?? (s.page ? { page: s.page - 1, rects: [], text: s.quote } : null) });
              }}
            >
              Accept
            </Btn>
          </div>
        )}
        {extractors > 1 && slot && (slot.others.length > 0 || slot.othersCount > 0 || slot.final) && (
          <div className="kx-rv-xothers">
            {slot.others.length === 0 && slot.othersCount > 0 && <span className="kx-rv-muted">Another extractor has a value (shown once you enter yours)</span>}
            {slot.others.map((o) => (
              <div key={o.reviewer} className="kx-rv-xother">
                <span>
                  <strong>{o.reviewerName}</strong> {display(o.value) || "—"}
                  <SourceChip pos={o.sourcePos} page={o.page} quote={o.quote} onShow={() => onShow(o.sourcePos, o.page, o.quote)} />
                </span>
                {differs && canAgree && (
                  <Btn small onClick={() => onSave(o.value, { quote: o.quote, page: o.page, sourcePos: o.sourcePos ?? null, final: true })}>
                    Agree on this
                  </Btn>
                )}
              </div>
            ))}
            {differs && canAgree && mine && (
              <Btn small onClick={() => onSave(mine.value, { quote: mine.quote, page: mine.page, sourcePos: mine.sourcePos ?? null, final: true })}>
                Agree on mine
              </Btn>
            )}
            {slot.final && (
              <span className="kx-rv-agreed">
                <Icon name="check" size={11} /> Agreed: {display(slot.final.value)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TableInput({ field, value, onChange, onCommit, onFocus }: { field: Field; value: Record<string, unknown>[]; onChange: (v: Record<string, unknown>[]) => void; onCommit: (v: Record<string, unknown>[]) => void; onFocus: () => void }) {
  const set = (i: number, col: string, v: unknown) => onChange(value.map((r, j) => (j === i ? { ...r, [col]: v } : r)));
  return (
    <div className="kx-rv-xtable-wrap">
      <table className="kx-rv-xtable">
        <thead>
          <tr>
            {field.columns.map((c) => (
              <th key={c.id} title={c.guidance}>
                {c.label}
              </th>
            ))}
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {value.map((row, i) => (
            <tr key={i}>
              {field.columns.map((c) => (
                <td key={c.id}>
                  {c.kind === "choice" ? (
                    <select className="kx-rv-select" value={String(row[c.id] ?? "")} onFocus={onFocus} onChange={(e) => onCommit(value.map((r, j) => (j === i ? { ...r, [c.id]: e.target.value } : r)))}>
                      <option value="">—</option>
                      {c.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="kx-rv-input"
                      inputMode={c.kind === "number" ? "decimal" : undefined}
                      value={String(row[c.id] ?? "")}
                      onFocus={onFocus}
                      onChange={(e) => set(i, c.id, c.kind === "number" && e.target.value !== "" && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value)}
                      onBlur={() => onCommit(value)}
                      aria-label={c.label}
                    />
                  )}
                  <ConvertedMark row={row} column={c.id} />
                </td>
              ))}
              <td>
                {field.role === "outcomes" && (
                  <button type="button" className="kx-rv-icon" aria-label="Convert reported statistics" title="Convert reported statistics (median and IQR, CI, p-value…)" onClick={() => openConvert({ row, apply: (next) => onCommit(value.map((r, j) => (j === i ? next : r))) })}>
                    <Icon name="function" size={11} />
                  </button>
                )}
                <button type="button" className="kx-rv-icon" aria-label="Remove row" onClick={() => onCommit(value.filter((_, j) => j !== i))}>
                  <Icon name="minus" size={11} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Btn small icon="plus" onClick={() => onChange([...value, {}])}>
        Row
      </Btn>
    </div>
  );
}

// ── A passage into a field ───────────────────────────────────────────────────────

type Parsed = Awaited<ReturnType<StageProps["api"]["parseSelection"]>>;

/** What a field gets from a passage: its text, an option it names, or a number read from it. */
function proposals(field: Field, text: string, parsed: Parsed | undefined): { label: string; value: unknown }[] {
  const out: { label: string; value: unknown }[] = [];
  const add = (label: string, value: unknown) => value !== undefined && value !== null && !out.some((o) => JSON.stringify(o.value) === JSON.stringify(value)) && out.push({ label, value });
  if (field.kind === "number") {
    const p = parsed ?? { numbers: [] };
    add(`n = ${p.n}`, p.n);
    add(`Mean ${p.mean}`, p.mean);
    add(`SD ${p.sd}`, p.sd);
    add(`${p.percent}%`, p.percent);
    add(`Events ${p.events}`, p.events);
    add(`Total ${p.total}`, p.total);
    add(`Estimate ${p.estimate}`, p.estimate);
    add(`Lower ${p.lower}`, p.lower);
    add(`Upper ${p.upper}`, p.upper);
    for (const n of p.numbers ?? []) add(String(n), n);
  } else if (field.kind === "choice" || field.kind === "multi") {
    const t = text.toLowerCase();
    for (const o of field.options) if (t.includes(o.toLowerCase())) add(o, field.kind === "multi" ? [o] : o);
    for (const o of field.options) add(o, field.kind === "multi" ? [o] : o);
  } else if (field.kind === "yesno") {
    add("Yes", true);
    add("No", false);
  } else if (field.kind !== "table") add("The passage", text);
  return out;
}

/** A table row from the passage: numbers in order into the number columns (editable). */
function rowFrom(field: Field, parsed: Parsed | undefined, text: string): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const nums = [...(parsed?.numbers ?? [])];
  const byName: Record<string, number | undefined> = { m1: parsed?.mean, sd1: parsed?.sd, n1: parsed?.n ?? parsed?.total, e1: parsed?.events, estimate: parsed?.estimate, lower: parsed?.lower, upper: parsed?.upper };
  for (const c of field.columns) {
    if (c.kind === "number") {
      if (byName[c.id] != null) row[c.id] = byName[c.id];
      else if (nums.length) row[c.id] = nums.shift();
    }
  }
  const textCol = field.columns.find((c) => c.kind === "text");
  if (textCol && !Object.keys(row).length) row[textCol.id] = text;
  return row;
}

function UsePassage({ api, passage, forms, focused, onClose, save }: StageProps & { passage: Passage; forms: ExtractionView; focused?: { form: Form; field: Field }; onClose: () => void; save: (form: Form, field: Field, value: unknown, extra: Extra) => Promise<void> }) {
  const visible = (f: Form) => new Set(forms.formState?.[f.id]?.visible ?? f.sections.flatMap((s) => s.fields.map((x) => x.id)));
  const all = forms.forms.flatMap((form) => {
    const shown = visible(form);
    return form.sections.flatMap((s) => s.fields.filter((f) => shown.has(f.id)).map((field) => ({ form, field })));
  });
  const [target, setTarget] = useState(focused && all.some((x) => x.field.id === focused.field.id && x.form.id === focused.form.id) ? focused : undefined);
  const [query, setQuery] = useState("");
  const [parsed, setParsed] = useState<Parsed>();
  const [row, setRow] = useState<Record<string, unknown>>();
  useEffect(() => {
    void api.parseSelection(passage.text).then(setParsed).catch(() => setParsed(undefined));
  }, [api, passage.text]);
  useEffect(() => {
    if (target?.field.kind === "table") setRow(rowFrom(target.field, parsed, passage.text));
  }, [target, parsed, passage.text]);
  const matches = all.filter((x) => !query || x.field.label.toLowerCase().includes(query.toLowerCase()));
  const pos: SourcePos = { page: passage.page, rects: passage.rects, text: passage.text };
  const extra: Extra = { quote: passage.text, page: passage.page >= 0 ? passage.page + 1 : null, sourcePos: pos };
  const use = (value: unknown) => {
    if (!target) return;
    void save(target.form, target.field, value, extra).then(onClose);
  };
  const addRow = () => {
    if (!target || !row) return;
    const key = `${target.form.id}/${target.field.id}`;
    const old = forms.values[key]?.mine?.value;
    void save(target.form, target.field, [...(Array.isArray(old) ? old : []), row], extra).then(onClose);
  };
  useEffect(() => {
    if (target) return;
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && matches[n - 1] && !(e.target instanceof HTMLInputElement && /\d/.test(e.key) && query)) {
        e.preventDefault();
        setTarget(matches[n - 1]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [target, matches, query]);
  return (
    <GlobalDialog label="Use the passage" onClose={onClose}>
      <div className="kx-rv-dialog kx-rv-use">
        <h2>{target ? `Use for ${target.field.label}` : "Use for which field?"}</h2>
        <blockquote>
          “{passage.text.slice(0, 400)}”{passage.page >= 0 && <small> p. {passage.page + 1}</small>}
        </blockquote>
        {!target ? (
          <>
            <input
              className="kx-rv-input"
              autoFocus
              placeholder="Type to find a field, or press its number"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches[0]) {
                  e.preventDefault();
                  setTarget(matches[0]);
                }
              }}
            />
            <ul className="kx-rv-radio-list">
              {matches.slice(0, 30).map((m, i) => (
                <li key={`${m.form.id}/${m.field.id}`}>
                  <button type="button" className="kx-rv-pick-row" onClick={() => setTarget(m)}>
                    {i < 9 && <kbd>{i + 1}</kbd>}
                    <span>
                      {m.field.label} <small>{m.form.name}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : target.field.kind === "table" ? (
          <>
            <p className="kx-rv-muted">A new row from this passage: check the numbers, then add it.</p>
            <table className="kx-rv-xtable">
              <thead>
                <tr>
                  {target.field.columns.map((c) => (
                    <th key={c.id}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {target.field.columns.map((c) => (
                    <td key={c.id}>
                      <input className="kx-rv-input" aria-label={c.label} value={String(row?.[c.id] ?? "")} onChange={(e) => setRow({ ...row, [c.id]: c.kind === "number" && e.target.value !== "" && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value })} />
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            <div className="kx-rv-dialog-actions">
              <Btn onClick={() => setTarget(undefined)}>Another field</Btn>
              <Btn primary onClick={addRow}>
                Add the row
              </Btn>
            </div>
          </>
        ) : (
          <>
            <p className="kx-rv-muted">Choose the value (its place in the document is kept with it).</p>
            <div className="kx-rv-use-values">
              {proposals(target.field, passage.text, parsed).map((p, i) => (
                <Btn key={i} primary={i === 0} onClick={() => use(p.value)} autoFocus={i === 0}>
                  {p.label.length > 80 ? `${p.label.slice(0, 80)}…` : p.label}
                </Btn>
              ))}
              <Btn quiet onClick={() => use(forms.values[`${target.form.id}/${target.field.id}`]?.mine?.value ?? "")} title="Keep the value, add this passage as its source">
                Only as its source
              </Btn>
            </div>
            <div className="kx-rv-dialog-actions">
              <Btn onClick={() => setTarget(undefined)}>Another field</Btn>
              <Btn onClick={onClose}>Cancel</Btn>
            </div>
          </>
        )}
      </div>
    </GlobalDialog>
  );
}
