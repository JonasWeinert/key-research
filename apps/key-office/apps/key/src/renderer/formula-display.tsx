// How a formula's value looks in a table cell, the details and the builder's preview: its
// result type (worked out by the host when the formula is saved) and the display the user
// chose — a coloured label, a progress bar, a checkmark, a relative date, or plain.
import { Icon } from "./icons";
import { relativeDate } from "./library-api";
import "./formula-display.css";

export type FormulaDisplay = "plain" | "badge" | "progress" | "check" | "relative";

/** The displays that suit a result type, the first being its default. */
export function displaysFor(resultType?: string): { id: FormulaDisplay; label: string }[] {
  switch (resultType) {
    case "number":
      return [
        { id: "plain", label: "Number" },
        { id: "progress", label: "Progress bar" },
      ];
    case "boolean":
      return [
        { id: "check", label: "Checkmark" },
        { id: "plain", label: "Yes / no" },
      ];
    case "date":
      return [
        { id: "relative", label: "Relative" },
        { id: "plain", label: "Date" },
      ];
    case "text":
    case "select":
    case "list":
      return [
        { id: "plain", label: "Text" },
        { id: "badge", label: "Coloured label" },
      ];
    default:
      return [{ id: "plain", label: "Plain" }];
  }
}

/** A stable colour (0–5) for a label, so the same text always gets the same colour. */
export const labelTone = (text: string) => [...text].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) >>> 0, 7) % 6;

const days = (iso: string) => {
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? t : undefined;
};

/** A formula value; `{error}` shows as a quiet warning with the reason on hover. */
export function FormulaValue({ value, resultType, display }: { value: unknown; resultType?: string; display?: string }) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object" && !Array.isArray(value) && "error" in (value as object)) {
    const error = String((value as { error: unknown }).error);
    return (
      <span className="kx-fv-error" title={error}>
        <Icon name="warning" size={11} />
        <span>Error</span>
      </span>
    );
  }
  const shown = (display as FormulaDisplay) || displaysFor(resultType)[0]?.id || "plain";
  if (Array.isArray(value))
    return (
      <span className="kx-fv-list">
        {value.map((item, i) => (
          <span key={i} className="kx-fv-badge" data-tone={labelTone(String(item))}>
            {String(item)}
          </span>
        ))}
      </span>
    );
  if (typeof value === "boolean")
    return shown === "check" ? (
      value ? (
        <span className="kx-fv-check" aria-label="Yes">
          <Icon name="check" size={12} />
        </span>
      ) : (
        <span className="kx-fv-no" aria-label="No" />
      )
    ) : (
      <span>{value ? "Yes" : "No"}</span>
    );
  if (typeof value === "number") {
    if (shown === "progress") {
      const pct = Math.max(0, Math.min(100, value));
      return (
        <span className="kx-fv-progress" title={`${Math.round(value)}%`}>
          <span className="kx-fv-bar">
            <span style={{ width: `${pct}%` }} />
          </span>
          <small>{Math.round(value)}%</small>
        </span>
      );
    }
    return <span className="kx-fv-number">{Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>;
  }
  const text = String(value);
  if ((resultType === "date" || shown === "relative") && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const at = days(text);
    return shown === "relative" && at !== undefined ? <span title={text}>{relativeDate(at)}</span> : <span>{text}</span>;
  }
  if (shown === "badge")
    return (
      <span className="kx-fv-badge" data-tone={labelTone(text)}>
        {text}
      </span>
    );
  return <span>{text}</span>;
}
