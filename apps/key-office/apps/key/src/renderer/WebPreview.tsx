// A web result in full, beside the search results: what the providers know about the work,
// its links, and "Add to library". Opening its page in the browser is a button of its own.
import { SidePanel } from "@key-reader/ui/SidePanel";
import type { WebHit } from "../shared/web-search";
import { Icon } from "./icons";
import { itemTypeLabel } from "./library-api";
import { Highlight } from "./search-highlight";
import { WebAddButton, type WebAdd } from "./WebAddButton";
import { copyCitation, webLink } from "./WebResults";
import { openWebLink, type WebSearchState } from "./web-search";
import { webWorkType } from "../shared/web-filters";

const OA: Record<string, string> = { gold: "Gold", green: "Green", hybrid: "Hybrid", bronze: "Bronze", diamond: "Diamond" };

export default function WebPreview({ hit, web, adder, pattern, onClose }: { hit: WebHit; web: WebSearchState; adder: WebAdd; pattern?: RegExp; onClose: () => void }) {
  const link = webLink(hit);
  const label = (id: string) => web.providers.find((p) => p.info.id === id)?.info.label ?? id;
  const type = webWorkType(hit.type);
  const ids: [string, string, string][] = [
    hit.ids.arxiv ? ["arXiv", hit.ids.arxiv, `https://arxiv.org/abs/${hit.ids.arxiv}`] : undefined,
    hit.ids.pmid ? ["PubMed", hit.ids.pmid, `https://pubmed.ncbi.nlm.nih.gov/${hit.ids.pmid}/`] : undefined,
    hit.ids.pmcid ? ["PMC", hit.ids.pmcid, `https://www.ncbi.nlm.nih.gov/pmc/articles/${hit.ids.pmcid.replace(/^(?!PMC)/, "PMC")}/`] : undefined,
    hit.ids.openalex ? ["OpenAlex", hit.ids.openalex, `https://openalex.org/${hit.ids.openalex}`] : undefined,
    hit.ids.s2 ? ["Semantic Scholar", hit.ids.s2.slice(0, 10) + "…", `https://www.semanticscholar.org/paper/${hit.ids.s2}`] : undefined,
  ].filter((x): x is [string, string, string] => !!x);
  return (
    <SidePanel
      label="Web result"
      className="kx-web-preview"
      storageKey="key.search.webPreview"
      resizable={{ min: 300, max: 620, initial: 380 }}
      sections={[
        {
          id: "details",
          title: "Details",
          render: () => (
            <div className="kx-web-preview-body" data-web-key={hit.key}>
              <h2 className="kx-web-preview-title">
                <Highlight text={hit.title} pattern={pattern} />
              </h2>
              {hit.authors.length > 0 && (
                <p className="kx-web-preview-authors">
                  {hit.authors.slice(0, 30).map((name, i) => (
                    <span key={i}>
                      <Highlight text={name} pattern={pattern} />
                    </span>
                  ))}
                  {hit.authors.length > 30 && <span>and {hit.authors.length - 30} more</span>}
                </p>
              )}
              <p className="kx-web-preview-meta">
                {[hit.venue, hit.year, type && itemTypeLabel(type === "review" ? "article" : type)].filter(Boolean).map((part, i) => (
                  <span key={i}>
                    <Highlight text={String(part)} pattern={pattern} />
                  </span>
                ))}
              </p>
              <div className="kx-web-preview-actions">
                <WebAddButton hit={hit} web={web} adder={adder} large />
                {link && (
                  <button type="button" className="kx-web-preview-button" title={`Open ${link} in the browser`} onClick={() => openWebLink(link)}>
                    <Icon name="external" size={12} />
                    Open page
                  </button>
                )}
                <button type="button" className="kx-web-preview-button" aria-label="Copy citation" title="Copy citation" onClick={() => void copyCitation(hit)}>
                  <Icon name="quote" size={12} />
                </button>
              </div>
              <dl className="kx-web-preview-facts">
                {hit.doi && (
                  <div>
                    <dt>DOI</dt>
                    <dd>
                      <button type="button" className="kx-web-link" onClick={() => openWebLink(`https://doi.org/${hit.doi}`)}>
                        <Highlight text={hit.doi} pattern={pattern} />
                      </button>
                    </dd>
                  </div>
                )}
                {(hit.openAccess || hit.pdfUrl) && (
                  <div>
                    <dt>Open access</dt>
                    <dd>
                      <span className="kx-web-oa">
                        <Icon name="unlock" size={10} />
                        {OA[hit.oaStatus ?? ""] ?? "Free to read"}
                      </span>
                      {hit.pdfUrl && (
                        <button type="button" className="kx-web-link" title={hit.pdfUrl} onClick={() => openWebLink(hit.pdfUrl!)}>
                          PDF
                        </button>
                      )}
                    </dd>
                  </div>
                )}
                {hit.citedBy != null && (
                  <div>
                    <dt>Cited by</dt>
                    <dd>{hit.citedBy.toLocaleString()}</dd>
                  </div>
                )}
                {ids.map(([name, value, url]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>
                      <button type="button" className="kx-web-link" title={url} onClick={() => openWebLink(url)}>
                        {value}
                      </button>
                    </dd>
                  </div>
                ))}
                <div>
                  <dt>Found by</dt>
                  <dd>
                    {hit.foundBy.map((id) => (
                      <span key={id} className="kx-web-badge" data-provider={id}>
                        {label(id)}
                      </span>
                    ))}
                  </dd>
                </div>
              </dl>
              {hit.abstract ? (
                <section className="kx-web-preview-abstract" aria-label="Abstract">
                  <h3>Abstract</h3>
                  <p>
                    <Highlight text={hit.abstract} pattern={pattern} />
                  </p>
                </section>
              ) : (
                <p className="kx-web-preview-none">No abstract from {hit.foundBy.map(label).join(" or ")}.</p>
              )}
            </div>
          ),
        },
      ]}
      actions={
        <button type="button" title="Close (Esc)" aria-label="Close the preview" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      }
    />
  );
}
