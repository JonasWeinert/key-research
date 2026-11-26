// One search for everywhere something is looked up — the link and citation pickers in
// notes, Open Quickly, Send to…, adding to a canvas — in the same three sections as the
// library's search: matches in titles and details first, then in the text, then related
// by meaning. The host finds, ranks and merges (key-store find.rs, `store_find`); title
// matches come back at once, the full-text search follows in a second call.
import { useEffect, useRef, useState } from "react";
import type { Invoke } from "./library-api";
import type { DraggedItem, ItemKind } from "./note-editor";

export type SearchGroup = "titles" | "text" | "meaning";
export const GROUP_LABEL: Record<SearchGroup, string> = {
  titles: "Titles and details",
  text: "In the text",
  meaning: "Related by meaning",
};
export const GROUPS: SearchGroup[] = ["titles", "text", "meaning"];

export interface Found extends DraggedItem {
  group: SearchGroup;
  /** Where it matched: "p. 4", "Abstract", "Note on …". */
  where?: string;
  /** A passage with `[[match]]` markers. */
  snippet?: string;
  /** A source's kind (pdf, web …), for the icon. */
  sourceKind?: string;
  /** Authors and year of a source, for the result row. */
  byline?: string;
  /** A matching passage of a document: its id (to open the reader there) and the document. */
  passageId?: string;
  documentHash?: string;
  /** The whole passage the snippet is cut from, for quoting it. */
  passageText?: string;
}

export interface Found3 {
  titles: Found[];
  text: Found[];
  meaning: Found[];
  /** The full-text search is still running. */
  pending: boolean;
  semantic: boolean;
}
export const EMPTY_FOUND: Found3 = { titles: [], text: [], meaning: [], pending: false, semantic: false };

export interface SearchOptions {
  /** Only these kinds (a highlight is a source with an anchor; "highlight" asks for those). */
  kinds?: (ItemKind | "highlight")[];
  /** Leave out the full-text search (titles only). */
  titlesOnly?: boolean;
  limit?: number;
  /** Library filters (as the store takes them) for the text search; standalone notes then drop out. */
  filters?: { field: string; op?: string; value: string; key?: string }[];
}

/** What `store_find` answers. */
export interface HostFind extends Found3 {
  counts: Record<string, number>;
  all: number;
}

/** One call of the host's search; `phase: "titles"` answers before the full-text search. */
export function findOnHost(invoke: Invoke, workspaceId: string, args: Record<string, unknown>): Promise<HostFind> {
  return invoke<HostFind>("store_find", args, workspaceId);
}

const optionArgs = (query: string, options: SearchOptions) => ({ text: query, kinds: options.kinds ?? null, titlesOnly: !!options.titlesOnly, limit: options.limit ?? null, filters: options.filters ?? [] });

/** Titles and details: names of notes, sources, highlights, canvases and pages, ranked. */
export async function searchTitles(invoke: Invoke, workspaceId: string, query: string, options: SearchOptions = {}): Promise<Found[]> {
  return (await findOnHost(invoke, workspaceId, { ...optionArgs(query.trim(), options), phase: "titles" })).titles;
}

/** Everything: titles, details, passages in the text and by meaning, merged without repeats. */
export async function searchAll(invoke: Invoke, workspaceId: string, query: string, options: SearchOptions = {}): Promise<Found3> {
  return findOnHost(invoke, workspaceId, optionArgs(query.trim(), options));
}

/** Searches as the query changes: titles at once, the text after (newest query wins). */
export function useUnifiedSearch(invoke: Invoke | undefined, workspaceId: string | undefined, query: string, options: SearchOptions = {}) {
  const [found, setFound] = useState<Found3>(EMPTY_FOUND);
  const request = useRef(0);
  const optionsKey = JSON.stringify(options);
  useEffect(() => {
    if (!invoke || !workspaceId) return;
    const id = ++request.current;
    const current = () => id === request.current;
    const timer = setTimeout(async () => {
      const args = optionArgs(query, options);
      const first = await findOnHost(invoke, workspaceId, { ...args, phase: "titles" }).catch(() => undefined);
      if (!current()) return;
      setFound(first ?? EMPTY_FOUND);
      if (!first?.pending) return;
      const all = await findOnHost(invoke, workspaceId, args).catch(() => undefined);
      if (current()) setFound(all ?? { ...first, pending: false });
    }, query ? 120 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, workspaceId, query, optionsKey]);
  return found;
}
