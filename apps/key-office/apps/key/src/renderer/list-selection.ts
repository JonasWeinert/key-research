// How lists select rows, the same in the library and the Inbox: a click selects one row (the
// focus, with nothing picked), ⌘-click adds or takes away one, ⇧-click picks the range from
// the anchor, ↑/↓ move the focus and ⇧↑/⇧↓ extend, ⌘A picks every row. `selected` holds the
// picked rows only; with none picked, the focused row is the selection.

export interface ListSelection {
  selected: Set<string>;
  /** Where a ⇧-click range starts. */
  anchor?: string;
  /** The row the keyboard is on. */
  focus?: string;
}

type Modifiers = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };

/** The selection after a click on `id` with these modifiers; `order` is the rows as listed. */
export function clickSelection(state: ListSelection, order: readonly string[], id: string, event: Modifiers): ListSelection {
  if (event.shiftKey && state.anchor) {
    const a = order.indexOf(state.anchor);
    const b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [from, to] = a < b ? [a, b] : [b, a];
      return { ...state, selected: new Set(order.slice(from, to + 1)), focus: id };
    }
  }
  if (event.metaKey || event.ctrlKey) {
    const next = new Set(state.selected);
    if (!next.size && state.focus) next.add(state.focus);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchor: id, focus: id };
  }
  return { selected: new Set(), anchor: id, focus: id };
}

/** The selection after ↑/↓ (`delta` -1/1), extending it with ⇧; unchanged at an empty list. */
export function moveSelection(state: ListSelection, order: readonly string[], delta: number, extend: boolean): ListSelection {
  if (!order.length) return state;
  const at = state.focus ? order.indexOf(state.focus) : -1;
  const index = Math.max(0, Math.min(order.length - 1, at + delta));
  const next = order[index];
  if (extend) {
    const set = new Set(state.selected.size ? state.selected : state.focus ? [state.focus] : []);
    set.add(next);
    return { ...state, selected: set, focus: next };
  }
  return { selected: new Set(), anchor: next, focus: next };
}

/** ⌘A: every row. */
export const selectAllRows = (state: ListSelection, order: readonly string[]): ListSelection => ({ ...state, selected: new Set(order) });

/** What actions apply to: the picked rows, else the focused one. */
export const selectionIds = (state: ListSelection) => (state.selected.size ? [...state.selected] : state.focus ? [state.focus] : []);
