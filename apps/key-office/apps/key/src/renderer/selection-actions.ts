// Actions on a selection that other features add: the library's "N sources selected" panel,
// the sources' context menu and the Inbox's "N works selected" panel render every registered
// action whose `kinds` include the selection's kind and whose `when` accepts it. A feature
// registers once at module load (or in an effect, using the returned function to take it
// away again):
//
//   registerSelectionAction({ id: "review.send", label: "Send to review…", icon: "checklist",
//     group: "organise", kinds: ["library", "inbox"], run: ({ workspaceId, sourceIds }) => … });
import { useSyncExternalStore } from "react";
import type { IconName } from "./icons";

/** What is selected: library sources, or Inbox works that are not in the library yet. */
export type SelectionKind = "library" | "inbox";

export interface SelectionContext {
  workspaceId: string;
  /** Library sources (default), or Inbox works. */
  kind?: SelectionKind;
  /** The selected sources; for Inbox works, the library sources some of them already are. */
  sourceIds: string[];
  /** The selected Inbox items (kind "inbox"). */
  itemIds?: string[];
}

/** Where an action shows among the panel's built-in ones. */
export type SelectionGroup = "organise" | "metadata" | "ai" | "cite" | "open" | "other";

export interface SelectionAction {
  /** Unique, namespaced by feature (`review.send`, `fill.run`). Registering an id again replaces it. */
  id: string;
  label: string;
  icon?: IconName;
  group?: SelectionGroup;
  /** Hover text. */
  title?: string;
  /** The selections it is offered for (default: library sources only). */
  kinds?: SelectionKind[];
  /** Shown only when this answers true (default: always). */
  when?: (ctx: SelectionContext) => boolean;
  run: (ctx: SelectionContext) => void | Promise<unknown>;
}

let actions: SelectionAction[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Adds (or replaces) an action; the returned function removes it. */
export function registerSelectionAction(action: SelectionAction): () => void {
  actions = [...actions.filter((a) => a.id !== action.id), action];
  notify();
  return () => {
    if (!actions.includes(action)) return;
    actions = actions.filter((a) => a !== action);
    notify();
  };
}

/** Every registered action, in registration order. */
export function selectionActions(): readonly SelectionAction[] {
  return actions;
}

/** The actions that apply to this selection, optionally of one group. */
export function selectionActionsFor(ctx: SelectionContext, group?: SelectionGroup): SelectionAction[] {
  const kind = ctx.kind ?? "library";
  return actions.filter((a) => (a.kinds ?? ["library"]).includes(kind) && (!group || (a.group ?? "other") === group) && (!a.when || safely(() => a.when!(ctx))));
}

function safely(test: () => boolean) {
  try {
    return test();
  } catch {
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The registered actions, re-rendering when one is added or removed. */
export function useSelectionActions(): readonly SelectionAction[] {
  return useSyncExternalStore(subscribe, selectionActions, selectionActions);
}
