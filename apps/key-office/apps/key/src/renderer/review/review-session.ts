// A screening session's order and the steps of one decision, as plain functions (the screen
// keeps the state; tests run these directly).
//
// The counter shows the position in the session's own list: the queue as it was when the session
// began, with records decided kept in place, so after the first decision it reads "2 of 120",
// not "1 of 119". Going back to a decided record and forward again walks the same list.
import type { Choice, ReasonRule } from "./review-api";

export interface Session {
  /** Records in the order they are screened this session (decided ones stay). */
  order: string[];
  /** The record shown. */
  at: number;
}

export function startSession(queue: string[], focus?: string): Session {
  const order = focus && !queue.includes(focus) ? [focus, ...queue] : [...queue];
  return { order, at: Math.max(0, focus ? order.indexOf(focus) : 0) };
}

/** The live queue changed (someone else decided, a new import): records not in the session
 * yet join at the end; nothing already in it moves. */
export function mergeQueue(s: Session, queue: string[]): Session {
  const known = new Set(s.order);
  const added = queue.filter((id) => !known.has(id));
  return added.length ? { ...s, order: [...s.order, ...added] } : s;
}

export const current = (s: Session): string | undefined => s.order[s.at];

/** After deciding the shown record: the next record still waiting, else the end. `waiting`
 * is the live queue after the decision. */
export function afterDecision(s: Session, waiting: string[]): Session {
  const live = new Set(waiting);
  for (let i = s.at + 1; i < s.order.length; i++) if (live.has(s.order[i])) return { ...s, at: i };
  // Nothing after it waits: an earlier skipped record that still waits, else past the end.
  for (let i = 0; i < s.at; i++) if (live.has(s.order[i])) return { ...s, at: i };
  return { ...s, at: s.order.length };
}

/** J/K and the arrows: one step through the session list, decided records included. */
export function step(s: Session, by: number): Session {
  const at = Math.min(s.order.length - 1, Math.max(0, s.at + by));
  return { ...s, at };
}

/** Undo brought `record` back: show it where it is in the list. */
export function showRecord(s: Session, record: string): Session {
  const i = s.order.indexOf(record);
  if (i >= 0) return { ...s, at: i };
  return { order: [...s.order.slice(0, s.at), record, ...s.order.slice(s.at)], at: s.at };
}

/** "2 of 120" */
export function counter(s: Session): { position: number; total: number; done: boolean } {
  return { position: Math.min(s.at + 1, s.order.length), total: s.order.length, done: s.at >= s.order.length };
}

// ── One decision's steps ───────────────────────────────────────────────────────

/** What a choice still needs before it is recorded, by the stage's rule for that choice:
 * nothing (null), or a message for the criteria step. */
export function missing(rule: ReasonRule, criteria: number, chosen: string[], other: string): string | null {
  if (!criteria && !other.trim()) return null;
  const given = chosen.length + (other.trim() ? 1 : 0);
  if (rule === "first") {
    if (given === 0) return "Choose the first criterion it does not meet";
    if (given > 1) return "Choose one: the first criterion it does not meet";
  }
  if (rule === "all" && given === 0) return "Choose every criterion it does not meet";
  return null;
}

/** A criterion's number toggled while choosing (with "first", choosing replaces). */
export function toggle(rule: ReasonRule, chosen: string[], id: string): string[] {
  if (chosen.includes(id)) return chosen.filter((x) => x !== id);
  return rule === "first" ? [id] : [...chosen, id];
}

/** Pressing a choice's key (or button): record it now, or open the criteria step.
 * Route a: E (or M) first opens the step when the rule asks for criteria. Route b: numbers
 * first, then E/M records it when what was chosen satisfies the rule. */
export function onChoice(rule: ReasonRule, value: Choice, criteria: number, chosen: string[], other: string): "commit" | "pick" {
  if (value === "include") return "commit";
  if (rule === "none") return "commit";
  return missing(rule, criteria, chosen, other) ? "pick" : "commit";
}

/** While choosing: does picking this criterion finish the decision (the rule wants just the
 * first one and auto-advance is on)? */
export const finishesOnPick = (rule: ReasonRule, autoAdvance: boolean) => rule === "first" && autoAdvance;
