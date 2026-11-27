// Extraction: the study's full text in Key's reader as the main panel, its forms in the sidebar.
// Selecting a passage opens the reader's menu in extraction mode: where the passage can go, the
// focused field first ("Use for ‹field›", Enter), then the fields it fits (Rust reads the numbers
// the way papers write them: "12.3 (4.5)" → mean and SD, "45/120", "n = 120", CIs; words go to
// text and choice fields with the closest option), new and existing rows of repeating groups.
// Choosing fills the field(s) with the passage as their source, marks it in the page and moves
// focus to the next empty field: select → Enter → select → Enter. A field's pick button (or ⌥P)
// makes the next selection fill it with no menu. ⌘Z takes the last fill back. Every value keeps its source (page, position
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
import { plural, type ExtractionView, type Field, type Form, type SelectionTarget, type SourcePos, type StudyRow } from "./review-api";
import { Btn, MenuButton, errorText, useLoad } from "./review-ui";
import type { ReaderMark, ReaderMarkMenu, ReaderPassage, ReaderSelectionAction, ReaderSelectionMode, ReviewReaderHandle } from "./review-reader";
import { MarksLegend, flashRow, mirrorOf, sourceMarks, useMarksShown } from "./review-marks";
import type { StageProps } from "./ReviewPage";
// std-B
import { ExtractionTools } from "./review-xpilot";
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
        {/* std-B: extraction pilot and contacts with authors */}
        <ExtractionTools {...props} studyId={current} onPick={setCurrent} />
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
  /** A field waiting for the next selection (no menu). */
  const [pick, setPick] = useState<{ form: Form; field: Field }>();
  const [mime, setMime] = useState<string>();
  const [marksShown, setMarksShown] = useMarksShown();
  const reader = useRef<ReviewReaderHandle>(null);
  /** Fills made from the text, newest last: what each field had before. */
  const fills = useRef<Array<Array<{ form: Form; field: Field; before: Slot["mine"] }>>>([]);
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

  const latest = useRef({ v: view.value, focused });
  latest.current = { v: view.value, focused };
  /** The visible fields in the forms' order. */
  const order = (v: ExtractionView) =>
    v.forms.flatMap((form) => {
      const shown = new Set(v.formState?.[form.id]?.visible ?? form.sections.flatMap((x) => x.fields.map((f) => f.id)));
      return form.sections.flatMap((x) => x.fields.filter((f) => shown.has(f.id)).map((field) => ({ form, field })));
    });
  const focusField = (formId: string, fieldId: string) => {
    const el = document.querySelector<HTMLElement>(`.kx-rv-xfield[data-form="${formId}"][data-field="${fieldId}"]`);
    el?.querySelector<HTMLElement>("input:not([type=checkbox]), select, textarea, button[role=radio], input")?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  /** A target chosen in the menu (or by a pick): the field(s) filled, the passage their source. */
  const fill = useCallback(
    async (t: SelectionTarget, p: ReaderPassage, sourceOnly = false) => {
      const v = latest.current.v;
      const form = v?.forms.find((f) => f.id === t.formId);
      const field = form?.sections.flatMap((x) => x.fields).find((f) => f.id === t.fieldId);
      if (!v || !form || !field) return;
      const extra: Extra = { quote: p.text, page: p.page >= 0 ? p.page + 1 : null, sourcePos: { page: p.page, rects: p.rects, text: p.text } };
      const mine = (id: string) => v.values[`${form.id}/${id}`]?.mine ?? null;
      const done: Array<{ form: Form; field: Field; before: Slot["mine"] }> = [];
      if (sourceOnly || !t.fills.length) {
        // The passage as the field's source; its value stays.
        done.push({ form, field, before: mine(field.id) });
        await save(form, field, mine(field.id)?.value ?? (field.kind === "table" || field.kind === "multi" ? [] : ""), extra);
      } else if (t.kind === "table") {
        const rows = [...((Array.isArray(mine(field.id)?.value) ? mine(field.id)!.value : []) as Record<string, unknown>[])];
        const cells = Object.fromEntries(t.fills.map((f) => [f.fieldId, f.value]));
        if (t.newRow || t.row == null) rows.push(cells);
        else rows[t.row] = { ...rows[t.row], ...cells };
        done.push({ form, field, before: mine(field.id) });
        await save(form, field, rows, extra);
      } else {
        for (const f of t.fills) {
          const target = form.sections.flatMap((x) => x.fields).find((x) => x.id === f.fieldId);
          if (!target) continue;
          done.push({ form, field: target, before: mine(target.id) });
          await save(form, target, f.value, extra);
        }
      }
      fills.current.push(done);
      flashRow(`.kx-rv-xfield[data-form="${form.id}"][data-field="${done[0].field.id}"]`);
      notify(`${done.map((d) => d.field.label).join(", ")}: ${sourceOnly || !t.fills.length ? "source added" : "filled from the text"}`, "ok", { label: "Undo", run: () => void undoRef.current() });
      // On to the next empty field, ready for the next selection.
      const list = order(v);
      const at = Math.max(...done.map((d) => list.findIndex((x) => x.form.id === d.form.id && x.field.id === d.field.id)));
      const filled = new Set(done.map((d) => `${d.form.id}/${d.field.id}`));
      const next = list.slice(at + 1).find((x) => x.field.kind !== "table" && !filled.has(`${x.form.id}/${x.field.id}`) && (v.values[`${x.form.id}/${x.field.id}`]?.mine?.value ?? "") === "");
      if (next) {
        setFocused(next);
        setTimeout(() => focusField(next.form.id, next.field.id), 60);
      }
    },
    [save, notify],
  );
  const targetsFor = useCallback(
    (text: string, focus?: { form: Form; field: Field }) => {
      const v = latest.current.v;
      if (!v) return Promise.resolve([] as SelectionTarget[]);
      const values = Object.fromEntries(Object.entries(v.values).flatMap(([k, slot]) => (slot.mine && !slot.inactive ? [[k, slot.mine.value]] : [])));
      return api.selectionTargets(text, v.forms, values, focus ? { formId: focus.form.id, fieldId: focus.field.id } : undefined).then((res) => res.targets);
    },
    [api],
  );
  // The menu for a selection: where it can go, worked out in Rust for the passage.
  const actions = useCallback(
    async (p: ReaderPassage): Promise<ReaderSelectionAction[]> => {
      const focus = latest.current.focused;
      const targets = await targetsFor(p.text, focus);
      const v = latest.current.v;
      const many = (v?.forms.length ?? 0) > 1;
      const icon = (t: SelectionTarget) => (t.kind === "table" ? (t.newRow ? "plus" : "table") : t.kind === "number" ? "hash" : t.kind === "choice" || t.kind === "multi" ? "list" : t.kind === "date" ? "clock" : t.kind === "yesno" ? "check" : "text");
      return targets.slice(0, 60).map((t) => {
        const value = t.kind === "table" && t.fills.length > 1 ? `${t.fills.length} cells` : (t.fills[0]?.display ?? "");
        // A field that has a value shows what changes: old → new (Enter replaces, Esc keeps).
        const was = t.sourceOnly || t.kind === "table" ? "" : display(v?.values[`${t.formId}/${t.fills[0]?.fieldId ?? t.fieldId}`]?.mine?.value);
        return {
          id: `use-${t.id}`,
          label: t.label,
          prefix: many ? `${t.form} · ${t.section}` : t.section,
          title: t.sourceOnly ? `Keep ${t.label}'s value and add this passage as its source` : `Fill ${t.label} and keep this passage as its source`,
          aside: t.sourceOnly ? "source only" : was && was !== value ? `${was} → ${value}` : value,
          // What comes with it: the SD with a mean, the end of a range, a row's cells.
          detail: t.kind === "table" ? t.fills.map((f) => `${f.label} ${f.display}`).join(" · ") : t.fills.length > 1 ? `with ${t.fills.slice(1).map((f) => `${f.label} ${f.display}`).join(", ")}` : undefined,
          icon: icon(t),
          tone: "source",
          folded: t.sourceOnly,
          keywords: `${t.form} ${t.section} ${t.fills.map((f) => f.label).join(" ")}`,
          quick: t.sourceOnly ? undefined : [{ id: `source-${t.id}`, label: "Source", key: "alt+enter", quiet: true, title: "Keep the value, add this passage as its source", run: (pp: ReaderPassage) => void fill(t, pp, true) }],
          run: (pp: ReaderPassage) => void fill(t, pp, t.sourceOnly),
        } satisfies ReaderSelectionAction;
      });
    },
    [targetsFor, fill],
  );
  const mode = useMemo<ReaderSelectionMode>(() => ({ id: "extract", label: "Extract to the form", filter: "Filter fields", empty: "No field fits this passage", hint: "↩ fill and keep as source · ⌥↩ source only", folded: "Other fields: as source only" }), []);
  const pickSelection = useMemo(
    () =>
      pick
        ? (p: ReaderPassage) => {
            setPick(undefined);
            void targetsFor(p.text, pick).then((ts) => {
              const t = ts.find((x) => x.focused && x.formId === pick.form.id && x.fieldId === pick.field.id);
              if (t) void fill(t, p);
              else notify(`Nothing in that passage fits ${pick.field.label}`, "error");
            });
          }
        : null,
    [pick, targetsFor, fill, notify],
  );
  const undoRef = useRef<() => boolean>(() => false);
  const undoFill = useCallback(() => {
    const last = fills.current.pop();
    if (!last) return false;
    for (const { form, field, before } of last) void save(form, field, before?.value ?? (field.kind === "table" || field.kind === "multi" ? [] : ""), { quote: before?.quote ?? "", page: before?.page ?? null, sourcePos: before?.sourcePos ?? null });
    notify(`Took back ${last.map((d) => d.field.label).join(", ")}`, "ok");
    return true;
  }, [save, notify]);
  undoRef.current = undoFill;
  // ⌥S: the reader's selection for the focused field; ⌥P: pick the next one; ⌘Z: undo a fill;
  // Esc ends a pick.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing && fills.current.length) {
        e.preventDefault();
        undoFill();
        return;
      }
      if (e.key === "Escape" && pick) {
        setPick(undefined);
        return;
      }
      if (e.altKey && e.code === "KeyP" && latest.current.focused) {
        e.preventDefault();
        setPick(latest.current.focused);
        return;
      }
      if (!(e.altKey && e.code === "KeyS")) return;
      const p = selectionPassage();
      if (!p) return notify("Select a passage in the full text first");
      const focus = latest.current.focused;
      if (!focus) return notify("Focus a field first");
      e.preventDefault();
      void targetsFor(p.text, focus).then((ts) => {
        const t = ts.find((x) => x.focused);
        if (t) void fill(t, p);
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, notify, pick, undoFill, targetsFor, fill]);

  // The values' sources as marks in the page (one per passage); a click shows the field(s).
  const sources = useMemo(() => (view.value ? sourceMarks(view.value, view.value.forms) : { marks: [], byField: new Map<string, string>() }), [view.value]);
  const marks = marksShown ? sources.marks : [];
  const mirror = useMemo(() => mirrorOf(props.summary, sources.marks), [props.summary, sources.marks]);
  const markActions = useCallback(
    (mark: ReaderMark): ReaderMarkMenu | null => {
      const v = latest.current.v;
      if (!v) return null;
      const keys = [...sources.byField].filter(([, id]) => id === mark.id).map(([k]) => k);
      const fields = keys.flatMap((k) => {
        const [formId, fieldId] = k.split("/");
        const form = v.forms.find((f) => f.id === formId);
        const field = form?.sections.flatMap((x) => x.fields).find((f) => f.id === fieldId);
        return form && field ? [{ form, field }] : [];
      });
      if (!fields.length) return null;
      flashRow(`.kx-rv-xfield[data-form="${fields[0].form.id}"][data-field="${fields[0].field.id}"]`);
      const slot = (x: (typeof fields)[number]) => v.values[`${x.form.id}/${x.field.id}`]?.mine;
      return {
        title: mark.label,
        mode: { id: "source-mark", label: mark.label },
        actions: [
          ...fields.map((x) => ({ id: `show-${x.field.id}`, label: `Show ${x.field.label} in the form`, icon: "arrowRight" as const, detail: slot(x) ? display(slot(x)!.value) : undefined, run: () => (flashRow(`.kx-rv-xfield[data-form="${x.form.id}"][data-field="${x.field.id}"]`), focusField(x.form.id, x.field.id)) })),
          {
            id: "source-remove",
            label: fields.length > 1 ? "Remove this source (keep the values)" : "Remove this source (keep the value)",
            icon: "close",
            secondary: true,
            run: () => {
              fills.current.push(fields.map((x) => ({ ...x, before: slot(x) ?? null })));
              for (const x of fields) void save(x.form, x.field, slot(x)?.value ?? "", { quote: "", page: null, sourcePos: null });
            },
          },
          {
            id: "value-remove",
            label: fields.length > 1 ? "Remove the values" : "Remove the value",
            icon: "trash",
            tone: "danger",
            secondary: true,
            run: () => {
              fills.current.push(fields.map((x) => ({ ...x, before: slot(x) ?? null })));
              for (const x of fields) void save(x.form, x.field, x.field.kind === "table" || x.field.kind === "multi" ? [] : "", { quote: "", page: null, sourcePos: null });
            },
          },
        ],
      };
    },
    [sources, save],
  );

  if (!view.value || !r) return <div className="kx-rv-loading" aria-busy="true" />;
  const v = view.value;
  const show = (pos: SourcePos | null | undefined, page?: number | null, quote?: string, key?: string) => {
    const mark = key ? sources.byField.get(key) : undefined;
    if (mark && reader.current?.showMark(mark)) return;
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
        <FormView
          key={form.id}
          {...props}
          form={form}
          view={v}
          recordId={recordId}
          save={save}
          focusedId={focused?.form.id === form.id ? focused.field.id : undefined}
          pickingId={pick?.form.id === form.id ? pick.field.id : undefined}
          onFocus={(field) => setFocused({ form, field })}
          onPick={mime ? (field) => setPick(pick?.field.id === field.id ? undefined : { form, field }) : undefined}
          onShow={show}
          reload={view.reload}
        />
      ))}
      {mime && <MarksLegend kinds={["source"]} shown={marksShown} onShown={setMarksShown} count={sources.marks.length} marks={sources.marks} onShow={(id) => reader.current?.showMark(id)} />}
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
          {pick && (
            <div className="kx-rv-pick-banner" role="status">
              <Icon name="cursor" size={12} />
              <span>
                Select the passage for <strong>{pick.field.label}</strong>
              </span>
              <Btn small quiet onClick={() => setPick(undefined)}>
                Cancel <kbd>Esc</kbd>
              </Btn>
            </div>
          )}
          <Suspense fallback={<div className="kx-rv-reader" aria-busy="true" />}>
            <ReviewReader
              ref={reader}
              api={api}
              recordId={recordId}
              version={version}
              title={r.meta.title}
              mime={mime}
              sourceId={r.fulltext.file ? null : r.sourceId}
              invoke={(command, args) => props.invoke(command, args as Record<string, unknown>, props.workspaceId)}
              actions={actions}
              mode={mode}
              marks={marks}
              markActions={markActions}
              mirror={mirror}
              pickSelection={pickSelection}
              onError={(t) => notify(t, "error")}
            />
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

function FormView(props: StageProps & { form: Form; view: ExtractionView; recordId: string; save: (form: Form, field: Field, value: unknown, extra: Extra) => Promise<void>; focusedId?: string; pickingId?: string; onFocus: (f: Field) => void; onPick?: (f: Field) => void; onShow: (pos: SourcePos | null | undefined, page?: number | null, quote?: string, key?: string) => void; reload: () => void }) {
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
                focused={props.focusedId === field.id}
                picking={props.pickingId === field.id}
                onPick={props.onPick ? () => props.onPick!(field) : undefined}
                onShow={(pos, page, quote) => props.onShow(pos, page, quote, `${form.id}/${field.id}`)}
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

function FieldInput({ form, field, slot, onSave, onFocus, onShow, onPick, focused, picking, extractors, canAgree, needQuote, shownWhen }: { form: Form; field: Field; needQuote: boolean; slot: Slot | undefined; shownWhen?: string; onSave: (value: unknown, extra: Extra) => void; onFocus: () => void; onPick?: () => void; focused?: boolean; picking?: boolean; onShow: (pos: SourcePos | null | undefined, page?: number | null, quote?: string) => void; extractors: number; canAgree: boolean }) {
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
        // Papers give dates to a month or a year as often as to a day: 2015, 2015-03, 2015-03-12.
        return <input className="kx-rv-input kx-rv-date" aria-label={field.label} placeholder="yyyy-mm-dd" value={String(value ?? "")} onFocus={onFocus} onChange={(e) => setValue(e.target.value)} onBlur={() => commit()} />;
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
    <div className="kx-rv-xfield" data-kind={field.kind} data-differs={differs || undefined} data-form={form.id} data-field={field.id} data-focused={focused || undefined} data-picking={picking || undefined}>
      <div className="kx-rv-xfield-label">
        <span>
          {field.label}
          {field.required && <span className="kx-rv-required" aria-label="required">*</span>}
          {onPick && (
            <button type="button" className="kx-rv-icon kx-rv-pick" aria-pressed={!!picking} aria-label={`Pick ${field.label} from the text`} title="Pick from the text: the next passage you select fills this field (⌥P)" onClick={onPick}>
              <Icon name="cursor" size={11} />
            </button>
          )}
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
