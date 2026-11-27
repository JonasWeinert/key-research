// The review's marks in the full text: every passage attached as a source — evidence that a
// criterion is (not) met, evidence for include, a note, a value's source — is drawn in the reader
// at its stored place, coloured by what it is for, and listed by it. One mechanism for every kind:
// marks are derived from the evidence and sources themselves, so changing or removing (or undoing)
// one moves or removes its mark. They belong to the review's copy of the full text and never write
// to the library's highlights. A layer the user can hide, with a legend.
import { useEffect, useState } from "react";
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

/** The legend and the layer's switch, beside the evidence or the form. */
export function MarksLegend({ kinds, shown, onShown, count }: { kinds: Array<"notMet" | "met" | "evidence" | "source">; shown: boolean; onShown: (on: boolean) => void; count: number }) {
  const names = { notMet: "Not met", met: "Met", evidence: "Evidence", source: "Source" } as const;
  return (
    <div className="kx-rv-marks-bar">
      <label className="kx-check kx-rv-marks-toggle" title="The review's marks in the full text (not your own highlights)">
        <input type="checkbox" checked={shown} onChange={(e) => onShown(e.target.checked)} />
        Marks in the text{count ? ` (${count})` : ""}
      </label>
      {shown && (
        <span className="ksm-legend" aria-label="What the colours mean">
          {kinds.map((k) => (
            <span key={k} data-tone={k}>
              {names[k]}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

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
