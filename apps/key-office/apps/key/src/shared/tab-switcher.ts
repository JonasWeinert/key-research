// The Ctrl-Tab tab switcher, as a small state machine main drives from key events of any of a
// window's webContents (shell, readers, web pages). Holding Ctrl and pressing Tab walks the
// window's tabs in most-recently-used order; releasing Ctrl shows the selection. A quick tap
// toggles between the two most recent tabs, as the overlay only appears after a short hold.

/** How long Ctrl must stay down after Tab before the overlay shows. */
export const SWITCHER_SHOW_DELAY = 160;

export interface SwitcherSession {
  /** Tab ids, most recently used first. */
  order: string[];
  selected: number;
  /** Opened from the command palette: no key is held, so Enter or a click picks. */
  sticky: boolean;
}

/** What a key does to the session. */
export type SwitcherEffect =
  | { kind: "none" }
  | { kind: "move" }
  | { kind: "commit"; tabId: string }
  | { kind: "cancel" }
  | { kind: "close"; tabId: string }
  /** Not the switcher's key: let it through (and the session ends). */
  | { kind: "pass" };

/** The subset of Electron's `Input` the switcher reads. */
export interface SwitcherInput {
  type: "keyDown" | "keyUp" | string;
  key: string;
  code?: string;
  control?: boolean;
  shift?: boolean;
  meta?: boolean;
  alt?: boolean;
}

/** `id` moves to the front of the most-recently-used list, which keeps only `known` tabs. */
export function touchMru(mru: string[], id: string | null | undefined, known?: Set<string>): string[] {
  const rest = mru.filter((t) => t !== id && (!known || known.has(t)));
  return id && (!known || known.has(id)) ? [id, ...rest] : rest;
}

/** The order the switcher lists: the recent ones first, then any tab never shown, left to right. */
export function switcherOrder(mru: string[], tabs: string[]): string[] {
  const known = new Set(tabs);
  const recent = mru.filter((id) => known.has(id));
  const seen = new Set(recent);
  return [...recent, ...tabs.filter((id) => !seen.has(id))];
}

/** Ctrl-Tab (or Ctrl-Shift-Tab) starts a session on the next (or the last) tab. */
export function startSwitcher(order: string[], options: { reverse?: boolean; sticky?: boolean } = {}): SwitcherSession | undefined {
  if (!order.length) return undefined;
  const selected = options.sticky ? Math.min(1, order.length - 1) : options.reverse ? order.length - 1 : Math.min(1, order.length - 1);
  return { order, selected, sticky: Boolean(options.sticky) };
}

const wrap = (n: number, length: number) => ((n % length) + length) % length;

/** Digit `1`…`9` picks that row, `0` the tenth. */
export function digitIndex(key: string): number | undefined {
  if (!/^[0-9]$/.test(key)) return undefined;
  const n = Number(key);
  return n === 0 ? 9 : n - 1;
}

/** Is this Ctrl-Tab (the key that starts a session)? */
export function isSwitcherStart(input: SwitcherInput) {
  return input.type === "keyDown" && input.key === "Tab" && Boolean(input.control) && !input.meta && !input.alt;
}

/** Applies one key event to a running session. */
export function switcherKey(session: SwitcherSession, input: SwitcherInput): { session: SwitcherSession; effect: SwitcherEffect } {
  const { order } = session;
  const at = (selected: number) => ({ session: { ...session, selected: wrap(selected, order.length) }, effect: { kind: "move" } as const });
  const commit = (index = session.selected) => {
    const tabId = order[wrap(index, order.length)];
    return { session, effect: tabId ? ({ kind: "commit", tabId } as const) : ({ kind: "cancel" } as const) };
  };
  if (input.type === "keyUp") {
    // Letting go of Ctrl picks the selection (a palette-opened switcher waits for Enter).
    if (input.key === "Control" && !session.sticky) return commit();
    return { session, effect: { kind: "none" } };
  }
  if (input.type !== "keyDown" && input.type !== "rawKeyDown") return { session, effect: { kind: "none" } };
  const key = input.key;
  if (key === "Control" || key === "Shift" || key === "Meta" || key === "Alt") return { session, effect: { kind: "none" } };
  if (key === "Tab") return at(session.selected + (input.shift ? -1 : 1));
  if (key === "ArrowDown" || key === "ArrowRight") return at(session.selected + 1);
  if (key === "ArrowUp" || key === "ArrowLeft") return at(session.selected - 1);
  if (key === "Home") return at(0);
  if (key === "End") return at(order.length - 1);
  if (key === "Escape") return { session, effect: { kind: "cancel" } };
  if (key === "Enter" || key === " ") return commit();
  const digit = digitIndex(key);
  if (digit !== undefined) return digit < order.length ? commit(digit) : { session, effect: { kind: "none" } };
  if (key.toLowerCase() === "w") {
    const tabId = order[session.selected];
    return tabId ? { session, effect: { kind: "close", tabId } } : { session, effect: { kind: "none" } };
  }
  // Without Ctrl held (it was let go while another app had focus) the session is over.
  if (!session.sticky && !input.control) return commit();
  return { session, effect: { kind: "none" } };
}

/** The session after the tab `tabId` closed (undefined once no tab is left). */
export function withoutTab(session: SwitcherSession, tabId: string): SwitcherSession | undefined {
  const index = session.order.indexOf(tabId);
  if (index < 0) return session;
  const order = session.order.filter((id) => id !== tabId);
  if (!order.length) return undefined;
  const selected = Math.min(index < session.selected ? session.selected - 1 : session.selected, order.length - 1);
  return { ...session, order, selected };
}

/** The badge a row shows: 1…9, then 0 for the tenth, none after. */
export function rowBadge(index: number): string | undefined {
  return index < 9 ? String(index + 1) : index === 9 ? "0" : undefined;
}
