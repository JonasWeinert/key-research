// Formula properties are evaluated by the host (key-store's formula.rs): listed sources
// carry their formula values as `formulaValues`, and the property editors preview a
// formula being typed through `store_formula_evaluate`.
import { useEffect, useState } from "react";
import type { Invoke } from "./library-api";

export interface FormulaResult {
  value?: unknown;
  /** The value as text. */
  text?: string;
  /** number | text | boolean | date | list | empty */
  type?: string;
  error?: string;
  hint?: string;
}
export type FormulaEval = (formula: string) => Promise<FormulaResult>;

/** Evaluates formulas over one source (by id) or over given values. */
export function formulaEvaluator(invoke: Invoke, workspaceId: string | undefined, target: { id?: string; properties?: Record<string, unknown> }): FormulaEval {
  return (formula) =>
    invoke<FormulaResult>("store_formula_evaluate", { formula, id: target.id ?? null, properties: target.id ? null : scalars(target.properties ?? {}) }, workspaceId).catch((e) => ({ error: String(e).replace(/^Error: /, "") }));
}

/** Only values a formula can read (others would make every formula fail). */
function scalars(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v)));
}

/** A stored formula value as the table shows it: text, or "⚠ reason". */
export function formulaText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object" && "error" in (value as object)) return `⚠ ${(value as { error: string }).error}`;
  return String(value);
}

/** The result of `formula` as it is typed (newest wins, after a short pause); a change of
 * `inputs` (what the evaluator reads) runs it again. */
export function useFormulaPreview(evaluate: FormulaEval | undefined, formula: string, inputs?: unknown): FormulaResult | undefined {
  const inputsKey = JSON.stringify(inputs ?? null);
  const [result, setResult] = useState<FormulaResult>();
  useEffect(() => {
    if (!evaluate || !formula.trim()) {
      setResult(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => void evaluate(formula).then((r) => current && setResult(r)), 120);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // The evaluator is recreated on render; the formula is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formula, !evaluate, inputsKey]);
  return result;
}
