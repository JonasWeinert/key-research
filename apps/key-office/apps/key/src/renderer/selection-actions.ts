// Actions on a selection of library sources that other features add: the library's
// "N sources selected" panel and the sources' context menu render every registered action
// whose `when` accepts the selection. A feature registers once at module load (or in an
// effect, using the returned function to take it away again):
//
//   registerSelectionAction({ id: "review.send", label: "Send to review…", icon: "checklist",
//     group: "organise", run: ({ workspaceId, sourceIds }) => openReview(workspaceId, sourceIds) });
import { useSyncExternalStore } from "react";
import type { IconName } from "./icons";

export interface SelectionContext {
  workspaceId: string;
  sourceIds: string[];
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
  return actions.filter((a) => (!group || (a.group ?? "other") === group) && (!a.when || safely(() => a.when!(ctx))));
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
