// How notes reach the library: find sources for @-links and embeds, describe them for
// cards and quotes, and open them (at a page when a quote has one).
import { retractionOf } from "./library-hygiene";
import { bridge, shortCreators, type Invoke, type Source, type SourcePage } from "./library-api";
import type { ItemLink, NoteCheckIssue, NoteCiteRequest, NoteCiteResult, NoteMediaHost, SourceRef } from "./note-editor";
import type { Found } from "./unified-search";

type OpenSource = (source: unknown, hit?: unknown) => Promise<unknown>;

export function sourceRef(source: Source): SourceRef {
  return {
    id: source.id,
    title: source.title || "Untitled",
    detail: [shortCreators(source.creators), source.year].filter(Boolean).join(" "),
    kind: source.kind,
    flag: retractionOf(source),
  };
}

/** A search entry as the note pickers show and insert it. */
function foundRef(found: Found): SourceRef {
  return {
    id: found.id,
    title: found.title,
    detail: found.where,
    kind: found.sourceKind,
    itemKind: found.kind,
    anchor: found.anchor,
    color: found.color,
    page: found.anchor?.startsWith("page:") ? Number(found.anchor.slice(5)) : undefined,
    group: found.group,
    where: found.group === "titles" && !found.snippet ? undefined : found.where,
    snippet: found.snippet,
  };
}

export function noteSources(invoke: Invoke, workspaceId: string) {
  const cache = new Map<string, Promise<Source | undefined>>();
  const load = (id: string) => {
    if (!cache.has(id)) cache.set(id, invoke<Source | null>("store_source", { id }, workspaceId).then((s) => s ?? undefined).catch(() => undefined));
    return cache.get(id)!;
  };
  // Notes keep images as `media/<sha256>.<ext>` in the workspace; the shell serves them.
  const media: NoteMediaHost = {
    save: async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = await invoke<{ src: string }>("store_media_save", { name: file.name || null, mime: file.type || null, __binary: bytes }, workspaceId);
      return saved.src;
    },
    url: (src) => (/^media\/[0-9a-f]+\.[a-z0-9]+$/.test(src) ? `key-media://${workspaceId.toLowerCase()}/${src.slice("media/".length)}` : src),
  };
  return {
    media,
    // The pickers search everything: titles and details at once, the text and meaning after.
    searchItems: async (query: string): Promise<SourceRef[]> => {
      const { searchTitles } = await import("./unified-search");
      return (await searchTitles(invoke, workspaceId, query, { limit: 6 })).map(foundRef);
    },
    searchItemsMore: async (query: string): Promise<SourceRef[]> => {
      const { searchText, mergeFound } = await import("./unified-search");
      const merged = mergeFound([], await searchText(invoke, workspaceId, query, { limit: 8 }));
      return [...merged.titles, ...merged.text, ...merged.meaning].map(foundRef);
    },
    citeLabel: async (ref: SourceRef, page?: number) => {
      const { describeItem, inTextCitation } = await import("./item-actions");
      const info = await describeItem(invoke, workspaceId, { kind: "source", id: ref.id, anchor: ref.anchor });
      return info.source ? inTextCitation(invoke, workspaceId, info.source, page ?? info.highlight?.page) : undefined;
    },
    // A note's citations in one call (numbering and disambiguation across the note).
    formatCitations: async (cites: { id: string; page?: number }[]) => {
      const { renderCitations } = await import("./cite");
      const out = await renderCitations(invoke, workspaceId, {
        citations: cites.map((c) => ({ items: [{ id: c.id, locator: c.page === undefined || c.page < 0 ? undefined : String(c.page + 1) }] })),
        bibliography: false,
      });
      return out.citations.map((c) => c.text);
    },
    // The note's citations and its reference list together, in the note's style when it has one.
    renderCitations: async (request: NoteCiteRequest): Promise<NoteCiteResult> => {
      const { renderCitations } = await import("./cite");
      const out = await renderCitations(invoke, workspaceId, {
        citations: request.citations,
        ids: request.ids,
        bibliography: request.bibliography,
        style: request.style,
        locale: request.locale,
      });
      return { citations: out.citations.map((c) => c.text), bibliography: out.bibliography && { entries: out.bibliography.entries, hangingIndent: out.bibliography.hangingIndent }, style: out.style };
    },
    checkCitations: async (request: { citations: NoteCiteRequest["citations"]; bibliographyIds?: string[]; style?: string; locale?: string }) =>
      (await invoke<{ issues: NoteCheckIssue[] }>("store_cite_check", request, workspaceId)).issues,
    listCitationStyles: async () => {
      const { listStyles } = await import("./cite");
      return listStyles(invoke, workspaceId);
    },
    restoreSource: async (id: string) => {
      await invoke("store_trash", { ids: [id], trashed: false }, workspaceId);
      cache.delete(id);
    },
    formatBibliography: async (ids: string[]) => {
      const { bibliography } = await import("./cite");
      const bib = await bibliography(invoke, workspaceId, ids);
      return bib && { entries: bib.entries, hangingIndent: bib.hangingIndent };
    },
    onOpenItem: (item: ItemLink) => void import("./item-links").then(({ openItem }) => openItem(invoke, workspaceId, item)),
    searchSources: async (query: string): Promise<SourceRef[]> => {
      const page = await invoke<SourcePage>("store_sources", { text: query.trim() || null, limit: 8, offset: 0, sort: query.trim() ? "title" : "added", descending: !query.trim() }, workspaceId);
      return page.items.map(sourceRef);
    },
    resolveSource: async (id: string) => {
      const source = await load(id);
      return source && sourceRef(source);
    },
    onOpenSource: (id: string, page?: number, annotationId?: string, quote?: string) => {
      void (async () => {
        const source = await load(id);
        if (!source) return;
        if (source.filePath && source.kind === "pdf") {
          const documentHash = source.fileHash ?? source.id;
          const key = (window as unknown as { key: { openSource: OpenSource; tabAction(action: string, payload?: unknown): Promise<unknown> } }).key;
          await key.openSource({
            documentId: documentHash,
            documentHash,
            title: source.title || "Untitled",
            status: "indexed",
            pageCount: source.pageCount ?? 0,
            completed: 0,
            total: 0,
            workspaceId,
          });
          // A place in the PDF (a highlight or a quoted page): scroll there and light it up.
          if (page !== undefined || annotationId) await key.tabAction("reader-focus", { workspaceId, documentHash, page, annotationId, text: quote });
        } else if (source.filePath && source.kind === "web") {
          // A saved web page opens in its reader, at the highlight or the quoted passage.
          const { openWebPage } = await import("./web-page-open");
          await openWebPage(workspaceId, source.id, { annotationId, text: quote }, source.title);
        } else if (source.filePath) await bridge().openPath(source.filePath);
        else if (source.url || source.doi) window.open(source.url || `https://doi.org/${source.doi}`, "_blank");
      })();
    },
  };
}
