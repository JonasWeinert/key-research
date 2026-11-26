// What a typed or pasted query looks like (a DOI, an arXiv id, a PMID, an ISBN, a link, a
// year or a range of years, a citation, a quoted title, a kind of item, or the name of a tag
// or collection), as the host reads it: key-store `smart_query.rs`, `store_parse_query`.
// Each reading is only offered: the search field lists it above its suggestions and the
// query stays as typed until one is picked.
import type { Invoke } from "./library-api";
import type { SearchFilter } from "./search-suggest";

/** A kind of item the search tab narrows to (see global-search's FindKind). */
export type DetectedKind = "source" | "note" | "record" | "canvas" | "highlight";

export interface Detection {
  /** Stable id of the reading, for keys and tests ("doi", "years", "citation" …). */
  id: string;
  filters: SearchFilter[];
  /** Kinds the search tab should show (only offered where kinds can be picked). */
  kinds?: DetectedKind[];
  /** The query once the detected part is taken out (what is still searched as text). */
  rest: string;
  /** The query is only this identifier: the library can offer to add the work it names. */
  add?: { kind: "doi" | "arxiv" | "pmid" | "pmcid" | "isbn"; value: string };
  /** What picking it does, in words (typed-out filters: "Only sources: Rating more than 3"). */
  explain?: string;
}

/** Every reading of `text`, best first; the workspace's tag and collection names included. */
export function parseQuery(invoke: Invoke, workspaceId: string, text: string, kinds: boolean): Promise<Detection[]> {
  if (text.trim().length < 3) return Promise.resolve([]);
  return invoke<Detection[]>("store_parse_query", { text, kinds }, workspaceId);
}
