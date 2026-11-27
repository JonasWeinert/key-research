// The review's marks in the full text: every passage attached as a source — evidence that a
// criterion is (not) met, evidence for include, a note, a value's source — is drawn in the reader
// at its stored place, coloured by what it is for, and listed by it. One mechanism for every kind:
// marks are derived from the evidence and sources themselves, so changing or removing (or undoing)
// one moves or removes its mark. They belong to the review's copy of the full text and never write
// to the library's highlights. A layer the user can hide, with a legend.
import { useEffect, useState } from "react";
import { Icon } from "../icons";
import type { ReaderMark } from "./review-reader";
import type { Criterion, Evidence, ExtractionView, Form, SourcePos } from "./review-api";

export const evidenceKey = (e: Evidence) => ["ev", e.kind ?? "", e.criterion ?? "", e.page ?? "", (e.quote || e.text || "").slice(0, 80)].join("|");

export function evidenceLabel(e: Evidence, criteria: Criterion[]): string {
  const c = criteria.find((x) => x.id === e.criterion);
  if (e.kind === "notMet") return c ? `Not met: ${c.label}` : e.note ? `Not met: ${e.note}` : "Not met";
  if (e.kind === "met") return `Met: ${c?.label ?? "a criterion"}`;
  if (e.kind === "include") return "For include";
  if (e.kind === "note") return e.note ? `Note: ${e.note}` : "Note";
  return "Evidence";
}

/** Screening: a mark for each passage of evidence. */
export function evidenceMarks(evidence: Evidence[], criteria: Criterion[]): ReaderMark[] {
  return evidence
    .filter((e) => (e.quote || e.text) && e.page != null)
    .map((e) => ({
      id: evidenceKey(e),
      page: e.page ?? -1,
      rects: e.rects ?? [],
      text: e.quote || e.text || "",
      tone: e.kind === "notMet" ? "notMet" : e.kind === "met" ? "met" : "evidence",
      label: evidenceLabel(e, criteria),
    }));
}

export const sourceKey = (formId: string, fieldId: string) => `src|${formId}/${fieldId}`;

/** Extraction: a mark for each value's source; values taken from one passage share one mark. */
export function sourceMarks(view: ExtractionView, forms: Form[]): { marks: ReaderMark[]; byField: Map<string, string> } {
  const marks: ReaderMark[] = [];
  const byField = new Map<string, string>();
  const shared = new Map<string, ReaderMark>();
  for (const form of forms) {
    for (const field of form.sections.flatMap((s) => s.fields)) {
      const slot = view.values[`${form.id}/${field.id}`];
      const pos: SourcePos | null | undefined = slot?.mine?.sourcePos;
      if (!pos || slot?.inactive || (!pos.text && !slot?.mine?.quote)) continue;
      const text = pos.text || slot?.mine?.quote || "";
      const place = `${pos.page}|${JSON.stringify(pos.rects ?? [])}|${text.slice(0, 80)}`;
      const same = shared.get(place);
      if (same) {
        same.label = `${same.label}, ${field.label}`;
        byField.set(`${form.id}/${field.id}`, same.id);
        continue;
      }
      const mark: ReaderMark = { id: sourceKey(form.id, field.id), page: pos.page, rects: pos.rects ?? [], text, tone: "source", label: `Source: ${field.label}` };
      shared.set(place, mark);
      byField.set(`${form.id}/${field.id}`, mark.id);
      marks.push(mark);
    }
  }
  return { marks, byField };
}

const KEY = "key.review.marks";
/** Whether the marks layer shows (remembered for the user). */
export function useMarksShown(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== "off";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      /* this session only */
    }
  }, [on]);
  return [on, setOn];
}

type Kind = "notMet" | "met" | "evidence" | "source";
const NAMES: Record<Kind, string> = { notMet: "Not met", met: "Met", evidence: "Evidence", source: "Source" };

/** The marks in the sidebar: the layer's switch, the legend (each colour filters the list) and
 *  the list itself; a row shows its passage in the text, × removes it where that is offered. */
export function MarksLegend({ kinds, shown, onShown, count, marks, onShow, onRemove }: { kinds: Kind[]; shown: boolean; onShown: (on: boolean) => void; count: number; marks?: ReaderMark[]; onShow?: (id: string) => void; onRemove?: (id: string) => void }) {
  const [only, setOnly] = useState<Kind | null>(null);
  const present = kinds.filter((k) => !marks || marks.some((m) => m.tone === k));
  const list = (marks ?? []).filter((m) => !only || m.tone === only);
  return (
    <section className="kx-rv-marks kx-rv-evidence-list" aria-label="Marks">
      <div className="kx-rv-marks-bar">
        <h4>Marks{count ? ` (${count})` : ""}</h4>
        <span className="ksm-legend" role="group" aria-label="Show only">
          {(marks ? present : kinds).map((k) => (
            <button key={k} type="button" data-tone={k} aria-pressed={only === k} title={only === k ? "Show all marks" : `Show only “${NAMES[k]}”`} onClick={() => setOnly(only === k ? null : k)}>
              {NAMES[k]}
              {marks && <small>{marks.filter((m) => m.tone === k).length}</small>}
            </button>
          ))}
        </span>
        <label className="kx-check kx-rv-marks-toggle" title="The review's marks in the full text (not your own highlights)">
          <input type="checkbox" checked={shown} onChange={(e) => onShown(e.target.checked)} />
          In the text
        </label>
      </div>
      {list.length > 0 && (
        <ul>
          {list.map((m) => (
            <li key={m.id} data-kind={m.tone}>
              <button type="button" className="kx-rv-evidence-jump" onClick={() => onShow?.(m.id)} title="Show it in the full text">
                <strong>{m.label}</strong>
                <span>“{m.text.slice(0, 200)}”</span>
                {m.page >= 0 && <small>p. {m.page + 1}</small>}
              </button>
              {onRemove && (
                <button type="button" className="kx-rv-icon" aria-label="Remove this mark" onClick={() => onRemove(m.id)}>
                  <Icon name="close" size={11} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The review's marks as the user's highlights on a library copy (Setup › rules › mirror). */
export const mirrorOf = (summary: { review: { id: string; name: string }; protocol: { rules: { mirrorMarks?: boolean } } }, marks: ReaderMark[]) => ({
  scope: summary.review.id,
  note: `review “${summary.review.name}”`,
  enabled: !!summary.protocol.rules.mirrorMarks,
  marks,
});

/** Brings a sidebar row (a criterion, a field) into view and flashes it. */
export function flashRow(selector: string) {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return;
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  el.classList.remove("kx-rv-flash");
  void el.offsetWidth;
  el.classList.add("kx-rv-flash");
  setTimeout(() => el.classList.remove("kx-rv-flash"), 1600);
}
