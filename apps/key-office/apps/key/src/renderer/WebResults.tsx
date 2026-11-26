// The Web pill and its results on the search page: works found by the web providers,
// merged, each with who found it, whether it is free to read, and "Add to library". A click
// shows the work in the preview beside the results (WebPreview); its page opens only when asked.
import type { WebFilterKey } from "../shared/web-filters";
import { shortAuthors, snippetOf, type WebHit } from "../shared/web-search";
import { apa, type CitableSource } from "./citation";
import { Icon, type IconName } from "./icons";
import { toast } from "./item-actions";
import { Highlight } from "./search-highlight";
import { WebAddButton, type WebAdd } from "./WebAddButton";
import { openWebLink, type WebSearchState } from "./web-search";
import "./web-search.css";

export function WebPill({ pressed, onClick }: { pressed: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <div className="kx-kind-chips kx-web-pill" role="group" aria-label="Search the web">
      <button type="button" data-kind="web" aria-pressed={pressed} title="Search OpenAlex, Semantic Scholar … (⌘-click: with your own results)" onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
        <Icon name="globe" size={12} />
        Web
      </button>
    </div>
  );
}

const ITEM_TYPE: Record<string, string> = { preprint: "preprint", book: "book", "book-chapter": "chapter", "proceedings-article": "conference-paper", dissertation: "thesis", report: "report", dataset: "dataset" };
const citable = (hit: WebHit): CitableSource => ({
  id: hit.key,
  kind: "reference",
  itemType: ITEM_TYPE[hit.type ?? ""] ?? "article",
  title: hit.title,
  creators: hit.authors.map((name) => {
    const parts = name.trim().split(/\s+/);
    return parts.length > 1 ? { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1], role: "author" } : { literal: name, role: "author" };
  }),
  year: hit.year,
  containerTitle: hit.venue,
  doi: hit.doi,
  url: hit.doi ? undefined : hit.landingUrl,
});

export async function copyCitation(hit: WebHit) {
  const source = citable(hit);
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/plain": new Blob([apa(source)], { type: "text/plain" }), "text/html": new Blob([`<p>${apa(source, true)}</p>`], { type: "text/html" }) }),
    ]);
  } catch {
    await navigator.clipboard.writeText(apa(source));
  }
  toast("Citation copied");
}

/** The work's page: its DOI, else the provider's landing page. */
export const webLink = (hit: WebHit) => hit.landingUrl ?? (hit.doi ? `https://doi.org/${hit.doi}` : undefined);

export const FILTER_NAME: Record<WebFilterKey, string> = {
  year: "year",
  author: "author",
  title: "title",
  venue: "journal",
  doi: "DOI",
  arxiv: "arXiv id",
  pmid: "PubMed id",
  pmcid: "PMC id",
  openAccess: "open access",
  type: "work type",
  citations: "citations",
  abstract: "abstract",
  language: "language",
  retracted: "retraction",
};

export default function WebResults({
  web,
  adder,
  query,
  pattern,
  offset,
  current,
  previewKey,
  onActive,
  onOpen,
}: {
  web: WebSearchState;
  adder: WebAdd;
  query: string;
  /** Query words and filter values, marked in each result. */
  pattern?: RegExp;
  /** Rows are numbered from here, after the workspace's own results. */
  offset: number;
  current: number;
  /** The work shown in the preview. */
  previewKey?: string;
  onActive: (index: number) => void;
  /** Show the work in the preview beside the results. */
  onOpen: (hit: WebHit) => void;
}) {
  const label = (id: string) => web.providers.find((p) => p.info.id === id)?.info.label ?? id;
  const names = web.providers.map((p) => p.info.label).join(" and ");

  const loading = web.providers.filter((p) => p.status === "loading");
  const failed = web.providers.filter((p) => p.error && p.status !== "loading");
  const done = web.providers.filter((p) => p.status === "done");
  const skipped = done.filter((p) => p.skipped?.length);
  const skipNote = (keys: WebFilterKey[]) => keys.map((k) => FILTER_NAME[k]).join(" or ");

  return (
    <section className="kx-found-group kx-web" data-group="web" aria-label="On the web">
      <div className="kx-search-head kx-web-head">
        <Icon name="globe" size={11} />
        <span>On the web</span>
        <span className="kx-count">{web.hits.length || (loading.length ? "…" : 0)}</span>
        <span className="kx-web-sources">
          {web.providers.map((p) => (
            <span key={p.info.id} className="kx-web-source" data-status={p.skipped?.length ? "skipped" : p.status} title={p.error ?? (p.skipped?.length ? `Not asked: it can't filter by ${skipNote(p.skipped)}` : undefined)}>
              {p.info.label}
              {p.status === "loading" && <span className="kx-search-spinner" aria-hidden="true" />}
            </span>
          ))}
        </span>
      </div>
      {!web.online ? (
        <p className="kx-web-note">You're offline. Web results come back when you reconnect.</p>
      ) : web.none ? (
        <p className="kx-web-note">Every web source is turned off in Settings.</p>
      ) : query.trim().length < 2 && !web.filtered ? (
        <p className="kx-web-note">Type to search {names || "the web"}.</p>
      ) : (
        <>
          {web.hits.map((hit, i) => {
            const index = offset + i;
            const sourceId = web.inLibrary[hit.key];
            const meta = [shortAuthors(hit.authors), hit.year, hit.venue].filter(Boolean);
            const link = webLink(hit);
            return (
              <article
                key={hit.key}
                role="option"
                aria-selected={index === current}
                data-index={index}
                data-previewed={hit.key === previewKey || undefined}
                className="kx-hit kx-found-hit kx-web-hit"
                data-web-key={hit.key}
                data-in-library={!!sourceId}
                onMouseMove={() => index !== current && onActive(index)}
                onClick={(e) => !(e.target as HTMLElement).closest("button, a") && !window.getSelection()?.toString() && onOpen(hit)}
              >
                <span className="kx-row-kind" data-kind="web">
                  <Icon name={(hit.type === "book" ? "book" : "doc") as IconName} size={15} />
                </span>
                <div className="kx-hit-body">
                  <button
                    type="button"
                    className="kx-found-open"
                    title={sourceId ? "Show details (⌘-click: open it from your library in a new tab)" : link ? `Show details (⌘-click: open ${link})` : "Show details"}
                    onClick={(e) => {
                      if (e.metaKey && sourceId) adder.openSource(hit, true);
                      else if (e.metaKey && link) openWebLink(link);
                      else onOpen(hit);
                    }}
                  >
                    <strong className="kx-hit-title">
                      <Highlight text={hit.title} pattern={pattern} />
                    </strong>
                  </button>
                  {meta.length > 0 && (
                    <span className="kx-hit-meta">
                      {meta.map((m, i) => (
                        <span key={i}>
                          <Highlight text={String(m)} pattern={pattern} />
                        </span>
                      ))}
                    </span>
                  )}
                  {hit.abstract && (
                    <p className="kx-web-abstract">
                      <Highlight text={snippetOf(hit.abstract, 260)} pattern={pattern} />
                    </p>
                  )}
                  <div className="kx-web-facts">
                    {hit.foundBy.map((id) => (
                      <span key={id} className="kx-web-badge" data-provider={id}>
                        {label(id)}
                      </span>
                    ))}
                    {hit.openAccess && (
                      <span className="kx-web-oa" title={hit.pdfUrl ? "Free to read; the PDF comes along when you add it" : "Free to read"}>
                        <Icon name="unlock" size={10} />
                        Open access
                      </span>
                    )}
                    {hit.citedBy != null && hit.citedBy > 0 && <span className="kx-web-fact">{hit.citedBy.toLocaleString()} citations</span>}
                    {hit.doi && (
                      <button type="button" className="kx-web-link" title={`Open https://doi.org/${hit.doi}`} onClick={() => openWebLink(`https://doi.org/${hit.doi}`)}>
                        <Highlight text={hit.doi} pattern={pattern} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="kx-web-actions">
                  <WebAddButton hit={hit} web={web} adder={adder} />
                  <span className="kx-web-tools">
                    <button type="button" aria-label="Copy citation" title="Copy citation" onClick={() => void copyCitation(hit)}>
                      <Icon name="quote" size={12} />
                    </button>
                    {link && (
                      <button type="button" aria-label="Open the web page" title={`Open ${link}`} onClick={() => openWebLink(link)}>
                        <Icon name="external" size={12} />
                      </button>
                    )}
                  </span>
                </div>
              </article>
            );
          })}
          {loading.map((p) => (
            <div key={p.info.id} className="kx-web-skeleton kx-skeleton" aria-label={`Searching ${p.info.label}`} role="status">
              {[0, 1].map((i) => (
                <div key={i} className="kx-web-skeleton-row">
                  <span className="kx-web-skeleton-icon" />
                  <span className="kx-web-skeleton-lines">
                    <span className="kx-skeleton-line" />
                    <span className="kx-skeleton-line short" />
                  </span>
                </div>
              ))}
            </div>
          ))}
          {failed.map((p) => (
            <p key={p.info.id} className="kx-web-note" data-provider={p.info.id} role="status">
              <span>Couldn't reach {p.info.label}</span>
              {p.error && !/^couldn't reach/i.test(p.error) && <small>{p.error}</small>}
              <button type="button" onClick={() => web.retry(p.info.id)}>
                Retry
              </button>
            </p>
          ))}
          {skipped.map((p) => (
            <p key={p.info.id} className="kx-web-note" data-provider={p.info.id} data-skipped role="status">
              <span>
                {p.info.label} can't filter by {skipNote(p.skipped!)}, so it wasn't asked.
              </span>
            </p>
          ))}
          {!loading.length && !web.hits.length && !failed.length && done.length > skipped.length && <p className="kx-web-note">Nothing found on the web.</p>}
          {(web.canLoadMore || web.loadingMore) && web.hits.length > 0 && !loading.length && (
            <button type="button" className="kx-web-more" disabled={web.loadingMore} onClick={web.loadMore}>
              {web.loadingMore ? <span className="kx-search-spinner" aria-hidden="true" /> : null}
              {web.loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
