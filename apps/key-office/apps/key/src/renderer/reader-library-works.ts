// The library side of the readers' "Add to library" (see @key-reader/pdfjs/library-works): the
// web search's match and add (the same path as a search result's Add), with the DOI's OpenAlex
// record when there is one, into the collections the source being read is in.
import { LibraryWorks, type CitedWork } from "@key-reader/pdfjs/library-works";
import type { WebResult } from "../shared/web-search";

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

export function readerLibraryWorks({
  invoke,
  open,
  collections,
}: {
  invoke: Invoke;
  open: (sourceId: string) => void;
  /** The collections of the source being read: a work added from it goes there too. */
  collections: () => Promise<string[]>;
}) {
  return new LibraryWorks({
    match: (works) =>
      invoke<Record<string, string>>("web_library_match", {
        works: works.map((w) => ({ key: w.key, doi: bareDoi(w.doi), title: w.title, year: yearOf(w.year), ids: {} })),
      }),
    add: async (work) => {
      const doi = bareDoi(work.doi);
      const looked = doi
        ? await invoke<WebResult | undefined>("web_lookup", { provider: "openalex", id: doi }).catch(() => undefined)
        : undefined;
      const into = await collections().catch(() => [] as string[]);
      const { source, existed } = await invoke<{ source: { id: string }; existed: boolean }>("web_add_to_library", {
        work: looked?.title ? looked : webResultOf(work),
        collectionId: into[0] ?? null,
      });
      if (!existed)
        for (const collectionId of into.slice(1))
          await invoke("store_membership", { collectionId, ids: [source.id] }).catch(() => undefined);
      return { sourceId: source.id, existed };
    },
    open,
  });
}
