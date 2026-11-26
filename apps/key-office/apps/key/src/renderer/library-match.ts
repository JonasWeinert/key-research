// "Already in library" for works shown anywhere (web results, readers' cited works, related
// works, the browser's article page): one host command, key-store `matching.rs`
// (`store_match_identifiers`), which normalises DOIs, arXiv ids, PMIDs, ISBNs and links and
// says how it recognised each work. A title-only match is "possibly" in the library.
import { useEffect, useState } from "react";
import { bridge, type Invoke } from "./library-api";

export interface MatchWork {
  key: string;
  doi?: string | null;
  url?: string | null;
  pmid?: string | null;
  pmcid?: string | null;
  arxiv?: string | null;
  isbn?: string | null;
  openalex?: string | null;
  title?: string | null;
  year?: number | string | null;
  firstAuthor?: string | null;
}

export interface LibraryMatch {
  key: string;
  sourceId: string;
  title: string;
  kind: "doi" | "arxiv" | "pmid" | "pmcid" | "isbn" | "openalex" | "url" | "title";
  /** False for a title match ("Possibly in library"), which never stops adding. */
  certain: boolean;
  hasFile: boolean;
}

/** Which of these works the library has: key → match (unmatched keys are absent). */
export async function matchLibrary(invoke: Invoke, workspaceId: string, works: MatchWork[]): Promise<Record<string, LibraryMatch>> {
  if (!works.length) return {};
  const hits = await invoke<LibraryMatch[]>("store_match_identifiers", { works }, workspaceId);
  return Object.fromEntries((hits ?? []).map((h) => [h.key, h]));
}

/** The words a badge shows for a match. */
export const matchLabel = (m: Pick<LibraryMatch, "certain">) => (m.certain ? "In library" : "Possibly in library");

// Rows that each ask about one work (related works, cited-by lists, the relation map) are
// asked together: requests within a moment go to the host as one batch, and answers are kept
// until the library changes.
type Pending = { work: MatchWork; resolve: (m: LibraryMatch | null) => void };
const queues = new Map<string, { invoke: Invoke; items: Pending[]; timer?: ReturnType<typeof setTimeout> }>();
const answers = new Map<string, LibraryMatch | null>();
let generation = 0;
const cacheKey = (workspaceId: string, w: MatchWork) => `${workspaceId}|${JSON.stringify([w.doi, w.url, w.arxiv, w.pmid, w.pmcid, w.isbn, w.openalex, w.title, w.year, w.firstAuthor])}`;

/** Forgets every answer (the library changed). */
export function forgetLibraryMatches() {
  answers.clear();
  generation++;
}

/** One work's match, asked with the others asked at the same moment. */
export function matchOne(invoke: Invoke, workspaceId: string, work: Omit<MatchWork, "key">): Promise<LibraryMatch | null> {
  const full = { ...work, key: "" };
  const key = cacheKey(workspaceId, full);
  if (answers.has(key)) return Promise.resolve(answers.get(key) ?? null);
  return new Promise((resolve) => {
    const queue = queues.get(workspaceId) ?? { invoke, items: [] };
    queues.set(workspaceId, queue);
    queue.items.push({ work: full, resolve });
    queue.timer ??= setTimeout(() => {
      queues.delete(workspaceId);
      const asked = generation;
      const works = queue.items.map((p, i) => ({ ...p.work, key: String(i) }));
      void matchLibrary(queue.invoke, workspaceId, works)
        .then((found) =>
          queue.items.forEach((p, i) => {
            const hit = found[String(i)] ?? null;
            if (asked === generation) answers.set(cacheKey(workspaceId, p.work), hit);
            p.resolve(hit);
          }),
        )
        .catch(() => queue.items.forEach((p) => p.resolve(null)));
    }, 30);
  });
}

/** A row's "In library" / "Possibly in library", refreshed when the library changes. */
export function useLibraryMatch(invoke: Invoke, workspaceId: string, work: Omit<MatchWork, "key"> | null | undefined): LibraryMatch | null {
  const [match, setMatch] = useState<LibraryMatch | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(
    () =>
      bridge().on("library-changed", () => {
        forgetLibraryMatches();
        setTick((n) => n + 1);
      }),
    [],
  );
  const query = work ? JSON.stringify(work) : "";
  useEffect(() => {
    if (!query || !workspaceId) return setMatch(null);
    let live = true;
    void matchOne(invoke, workspaceId, JSON.parse(query)).then((m) => live && setMatch(m));
    return () => {
      live = false;
    };
    // `invoke` is stable per page; the query is the work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, workspaceId, tick]);
  return match;
}
