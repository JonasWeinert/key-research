// The library side of the readers' "Add to library" (see @key-reader/pdfjs/library-works): the
// library host's identifier matcher (`store_match_identifiers`, a title alone is "possibly in
// library"), and the add through the shared collection chooser (add-from-source.tsx) with the
// source being read as the origin. Without a chooser, the work goes in as a search result's
// Add does, with the DOI's OpenAlex record when there is one, into the source's collections.
import { LibraryWorks, type CitedWork, type LibraryMatch } from "@key-reader/pdfjs/library-works";
import type { WebResult } from "../shared/web-search";
import type { AddWork } from "./add-from-source";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const bareDoi = (doi?: string) => doi?.trim().toLowerCase().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/, "") || undefined;
const yearOf = (year: CitedWork["year"]) => {
  const n = typeof year === "number" ? year : Number.parseInt(String(year ?? ""), 10);
  return Number.isFinite(n) ? n : undefined;
};

/** The work as a web result, for when no catalogue has a fuller record. */
export function webResultOf(work: CitedWork): WebResult {
  const doi = bareDoi(work.doi);
  return {
    provider: "reader",
    providerId: doi ?? work.url ?? work.title,
    title: work.title.trim(),
    authors: work.authors ?? [],
    year: yearOf(work.year),
    venue: work.venue,
    doi,
    ids: {},
    landingUrl: work.url ?? (doi ? `https://doi.org/${doi}` : undefined),
  };
}

/** The work as the collection chooser adds it. */
export function addWorkOf(work: CitedWork): AddWork {
  const doi = bareDoi(work.doi);
  return {
    title: work.title.trim(),
    doi: doi ?? null,
    year: yearOf(work.year) ?? null,
    url: work.url ?? null,
    authors: work.authors ?? [],
    byline: work.authors?.slice(0, 3).join(", ") || null,
    container: work.venue ?? null,
  };
}

export function readerLibraryWorks({
  invoke,
  open,
  collections,
  addFrom,
}: {
  invoke: Invoke;
  open: (sourceId: string) => void;
  /** The collections of the source being read: a work added from it goes there too. */
  collections: () => Promise<string[]>;
  /** Adds through the collection chooser (null: cancelled). */
  addFrom?: (work: AddWork) => Promise<{ id: string } | null>;
}) {
  return new LibraryWorks({
    match: async (works) => {
      const hits = await invoke<{ key: string; sourceId: string; certain: boolean }[]>("store_match_identifiers", {
        works: works.map((w) => ({ key: w.key, doi: bareDoi(w.doi), url: w.url, title: w.title, year: yearOf(w.year), firstAuthor: w.authors?.[0] })),
      });
      return Object.fromEntries((hits ?? []).map((h) => [h.key, { sourceId: h.sourceId, certain: h.certain } satisfies LibraryMatch]));
    },
    add: async (work) => {
      if (addFrom) {
        const source = await addFrom(addWorkOf(work));
        return source ? { sourceId: source.id } : null;
      }
      const into = await collections().catch(() => [] as string[]);
      // The host looks the DOI up in OpenAlex first and adds that record when there is one.
      const { source, existed } = await invoke<{ source: { id: string }; existed: boolean }>("web_add_to_library", {
        work: webResultOf(work),
        collectionId: into[0] ?? null,
        lookup: true,
      });
      if (!existed)
        for (const collectionId of into.slice(1))
          await invoke("store_membership", { collectionId, ids: [source.id] }).catch(() => undefined);
      return { sourceId: source.id, existed };
    },
    open,
  });
}
