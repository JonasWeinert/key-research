// The Web pill and its results on the search page: works found by the web providers,
// merged, each with who found it, whether it is free to read, and "Add to library".
import { useState } from "react";
import { shortAuthors, snippetOf, type WebHit } from "../shared/web-search";
import { apa, type CitableSource } from "./citation";
import { Icon, type IconName } from "./icons";
import { openItemAt, toast } from "./item-actions";
import type { Invoke, Source } from "./library-api";
import { errorText, openWebLink, type WebSearchState } from "./web-search";
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

async function copyCitation(hit: WebHit) {
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

type Adding = "adding" | "pdf";

export default function WebResults({
  web,
  invoke,
  workspaceId,
  collectionId,
  query,
}: {
  web: WebSearchState;
  invoke: Invoke;
  workspaceId: string;
  /** New references go into this collection (the search's collection filter). */
  collectionId?: string;
  query: string;
}) {
  const [adding, setAdding] = useState<Record<string, Adding>>({});
  const label = (id: string) => (web.providers.find((p) => p.info.id === id)?.info ?? web.infos.find((p) => p.id === id))?.label ?? id;
  const names = web.providers.map((p) => p.info.label).join(" and ");

  const add = async (hit: WebHit) => {
    setAdding((a) => ({ ...a, [hit.key]: "adding" }));
    try {
      const { source, existed } = await invoke<{ source: Source; existed: boolean }>("web_add_to_library", { work: hit, collectionId: collectionId ?? null }, workspaceId);
      web.noted(hit.key, source.id);
      if (!existed && hit.pdfUrl) {
        // The PDF follows in the background; the reference is already in the library.
        setAdding((a) => ({ ...a, [hit.key]: "pdf" }));
        await invoke("library_download_pdf", { url: hit.pdfUrl, sourceId: source.id }, workspaceId).catch((e) => toast(`Added without the PDF: ${errorText(e)}`));
      } else if (existed) toast("Already in your library");
    } catch (e) {
      toast(`Couldn't add it: ${errorText(e)}`);
    } finally {
      setAdding(({ [hit.key]: _, ...rest }) => rest);
    }
  };
  const openSource = (hit: WebHit, newTab = false) => openItemAt({ kind: "source", id: web.inLibrary[hit.key] }, newTab ? "tab" : "split", hit.title, workspaceId, invoke);

  const loading = web.providers.filter((p) => p.status === "loading");
  const failed = web.providers.filter((p) => p.error && p.status !== "loading");
  const done = web.providers.filter((p) => p.status === "done");

  return (
    <section className="kx-found-group kx-web" data-group="web" aria-label="On the web">
      <div className="kx-search-head kx-web-head">
        <Icon name="globe" size={11} />
        <span>On the web</span>
        <span className="kx-count">{web.hits.length || (loading.length ? "…" : 0)}</span>
        <span className="kx-web-sources">
          {web.providers.map((p) => (
            <span key={p.info.id} className="kx-web-source" data-status={p.status} title={p.error}>
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
      ) : query.trim().length < 2 ? (
        <p className="kx-web-note">Type to search {names || "the web"}.</p>
      ) : (
        <>
          {web.hits.map((hit) => {
            const sourceId = web.inLibrary[hit.key];
            const state = adding[hit.key];
            const meta = [shortAuthors(hit.authors), hit.year, hit.venue].filter(Boolean);
            const link = hit.landingUrl ?? (hit.doi ? `https://doi.org/${hit.doi}` : undefined);
            return (
              <article key={hit.key} className="kx-hit kx-found-hit kx-web-hit" data-web-key={hit.key} data-in-library={!!sourceId}>
                <span className="kx-row-kind" data-kind="web">
                  <Icon name={(hit.type === "book" ? "book" : "doc") as IconName} size={15} />
                </span>
                <div className="kx-hit-body">
                  <button
                    type="button"
                    className="kx-found-open"
                    title={sourceId ? "Open in your library (⌘-click: in a new tab)" : link ? `Open ${link}` : undefined}
                    onClick={(e) => (sourceId ? openSource(hit, e.metaKey) : link && openWebLink(link))}
                  >
                    <strong className="kx-hit-title">{hit.title}</strong>
                  </button>
                  {meta.length > 0 && (
                    <span className="kx-hit-meta">
                      {meta.map((m, i) => (
                        <span key={i}>{m}</span>
                      ))}
                    </span>
                  )}
                  {hit.abstract && <p className="kx-web-abstract">{snippetOf(hit.abstract, 260)}</p>}
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
                      <button type="button" className="kx-web-link" onClick={() => openWebLink(`https://doi.org/${hit.doi}`)}>
                        {hit.doi}
                      </button>
                    )}
                  </div>
                </div>
                <div className="kx-web-actions">
                  {state ? (
                    <span className="kx-web-progress" role="status">
                      <span className="kx-search-spinner" aria-hidden="true" />
                      {state === "pdf" ? "Fetching PDF…" : "Adding…"}
                    </span>
                  ) : sourceId ? (
                    <button type="button" className="kx-web-in" title="In your library: open it" onClick={(e) => openSource(hit, e.metaKey)}>
                      <Icon name="check" size={11} />
                      In library
                      <span className="kx-web-in-open">Open</span>
                    </button>
                  ) : (
                    <button type="button" className="kx-web-add" onClick={() => void add(hit)}>
                      <Icon name="plus" size={11} />
                      Add to library
                    </button>
                  )}
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
          {!loading.length && !web.hits.length && !failed.length && done.length > 0 && <p className="kx-web-note">Nothing found on the web.</p>}
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
