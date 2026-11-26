// Search across everything (sources, notes, pages, canvases and highlights) for the
// search popup and the search tab: the same three sections as everywhere, counted and
// narrowed by kind, by the library's filter tokens and by one item picked in the sidebar.
import { useEffect, useRef, useState } from "react";
import { bridge, type Invoke } from "./library-api";
import type { SidebarTarget } from "./sidebar-intent";
import { storeFilters, type SearchFilter } from "./search-suggest";
import { EMPTY_FOUND, findOnHost, type Found, type Found3, type HostFind } from "./unified-search";

export type FindKind = "source" | "note" | "record" | "canvas" | "highlight";
export const FIND_KINDS: FindKind[] = ["source", "note", "record", "canvas", "highlight"];
export const KIND_LABEL: Record<FindKind, string> = { source: "Sources", note: "Notes", record: "Pages", canvas: "Canvases", highlight: "Highlights" };

export interface FindState {
  text: string;
  /** Only these kinds; none means all. */
  kinds: FindKind[];
  /** Library filter tokens, plus at most one `item` token ("only this note"). */
  filters: SearchFilter[];
}
export const EMPTY_FIND: FindState = { text: "", kinds: [], filters: [] };

export const kindOf = (found: Pick<Found, "kind" | "anchor">): FindKind => (found.anchor?.startsWith("highlight:") ? "highlight" : (found.kind as FindKind));

/** A sidebar item as a filter token: results only from that note, canvas, page or source. */
export const itemFilter = (kind: FindKind, id: string, title: string): SearchFilter => ({ field: "item", op: "is", key: kind, value: id, label: title || "Untitled" });
export const isItemFilter = (filter: SearchFilter) => filter.field === "item";

export interface FindResult {
  found: Found3;
  /** Per kind, before the kind chips narrow the results. */
  counts: Record<FindKind, number>;
  all: number;
}
const noCounts = (): Record<FindKind, number> => ({ source: 0, note: 0, record: 0, canvas: 0, highlight: 0 });
export const EMPTY_RESULT: FindResult = { found: EMPTY_FOUND, counts: noCounts(), all: 0 };

/** The host's search for a search state (key-store find.rs ranks, merges, counts and narrows). */
function findArgs(state: FindState, limit: number) {
  const item = state.filters.find(isItemFilter);
  return {
    text: state.text.trim(),
    counted: true,
    limit,
    filters: storeFilters(state.filters.filter((f) => !isItemFilter(f))),
    item: item ? { kind: item.key, id: item.value, label: item.label } : null,
    show: state.kinds,
  };
}

const asResult = (found: HostFind): FindResult => ({
  found: { titles: found.titles, text: found.text, meaning: found.meaning, semantic: found.semantic, pending: found.pending },
  counts: { ...noCounts(), ...found.counts },
  all: found.all,
});

/** Searches as the state changes: titles at once, the text after (newest search wins). */
export function useFind(invoke: Invoke | undefined, workspaceId: string | undefined, state: FindState, limit = 10): FindResult {
  const [result, setResult] = useState<FindResult>(EMPTY_RESULT);
  const request = useRef(0);
  const supersede = useRef(`find:${Math.random().toString(36).slice(2)}`);
  const searchKey = JSON.stringify([state.text.trim(), state.filters, state.kinds]);
  useEffect(() => {
    if (!invoke || !workspaceId) return;
    const id = ++request.current;
    const current = () => id === request.current;
    const args = findArgs(state, limit);
    const timer = setTimeout(async () => {
      // A newer keystroke's search replaces this one on the host (each phase by its own key).
      const first = await findOnHost(invoke, workspaceId, { ...args, phase: "titles", $supersede: `${supersede.current}:titles` }).catch(() => undefined);
      if (!current()) return;
      if (first) setResult(asResult(first));
      if (!first?.pending) return;
      const all = await findOnHost(invoke, workspaceId, { ...args, $supersede: `${supersede.current}:full` }).catch(() => undefined);
      if (current() && all) setResult(asResult(all));
    }, args.text ? 50 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, workspaceId, searchKey, limit]);
  return result;
}

// ── The sidebar while a search tab is focused ────────────────────────────────

const same = (a: FindKind[], b: FindKind[]) => a.length === b.length && a.every((k) => b.includes(k));
const without = (filters: SearchFilter[], ...fields: string[]) => filters.filter((f) => !fields.includes(f.field));

/** The search a sidebar click turns this one into; undefined when it already is that,
 * so a second click opens the item as usual. */
export function sidebarFilter(state: FindState, target: SidebarTarget): FindState | undefined {
  const item = state.filters.find(isItemFilter);
  switch (target.kind) {
    case "sources": {
      if (target.collectionId) {
        if (state.filters.some((f) => f.field === "collection" && f.value === target.collectionId)) return undefined;
        const collection: SearchFilter = { field: "collection", op: "is", value: target.collectionId, label: target.title || "Collection" };
        return { ...state, kinds: ["source"], filters: [...without(state.filters, "collection", "item"), collection] };
      }
      if (same(state.kinds, ["source"]) && !item && !state.filters.some((f) => f.field === "collection")) return undefined;
      return { ...state, kinds: ["source"], filters: without(state.filters, "collection", "item") };
    }
    case "highlights":
    case "records": {
      const kinds: FindKind[] = [target.kind === "highlights" ? "highlight" : "record"];
      if (same(state.kinds, kinds) && !item) return undefined;
      // Library filters only match sources; pages need them gone.
      return { ...state, kinds, filters: target.kind === "records" ? [] : without(state.filters, "item") };
    }
    default: {
      if (item?.value === target.id) return undefined;
      // A note, canvas or page has none of the library's details, so its filters go.
      return { ...state, kinds: [], filters: [itemFilter(target.kind, target.id, target.title)] };
    }
  }
}

// ── Opening the search tab ───────────────────────────────────────────────────

const pending = new Map<string, FindState>();
const pendingListeners = new Set<(workspaceId: string) => void>();

/** Opens (or brings forward) the workspace's search tab showing `state`. */
export function openSearchTab(workspaceId: string, state: FindState) {
  pending.set(workspaceId, state);
  pendingListeners.forEach((listener) => listener(workspaceId));
  void bridge().tabAction("open-content", { section: "search", workspaceId });
}
/** The state a new search tab starts with, once. */
export function takePendingFind(workspaceId: string) {
  const state = pending.get(workspaceId);
  pending.delete(workspaceId);
  return state;
}
/** An open search tab takes what is sent to it later. */
export function onPendingFind(workspaceId: string, apply: (state: FindState) => void) {
  const listener = (id: string) => {
    const state = id === workspaceId ? takePendingFind(id) : undefined;
    if (state) apply(state);
  };
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}
