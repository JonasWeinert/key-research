// "Follow something": one search box for what people want to follow, not how feeds work.
// Typing asks the host (`feeds_suggest`) for journals, people and topics from OpenAlex (with
// how many of each the library has), arXiv listings and a saved search; a pasted address is
// previewed as a feed. Before anything is followed it is previewed (`feeds_preview`): the
// latest items it would have brought, how often it posts, and a plain sentence of what will
// happen. Below the box: one-click picks from the library, new citations of a collection,
// arXiv listings and OPML import.
import { useEffect, useRef, useState } from "react";
import { FEED_KIND_ICON, KIND_LABEL, cadence, defaultInterval, feedsChanged, intervalLabel, intervalPhrase, INTERVALS, openInbox, type FeedKind, type FeedWork, type Subscription } from "./feeds-ui";
import { Icon } from "./icons";
import { toast } from "./item-actions";
import type { Collection, Invoke } from "./library-api";
import { EmptyState, Explain, Hint } from "./explain";
import { hintText } from "./help-content";

export interface Suggestion {
  kind: FeedKind;
  title: string;
  config: Record<string, unknown>;
  following: boolean;
  publisher?: string;
  issn?: string;
  worksCount?: number;
  inLibrary?: number;
  count?: number;
  affiliation?: string;
  orcid?: string;
  field?: string;
  level?: string;
  name?: string;
  code?: string;
}
interface Suggestions {
  query: string;
  address?: boolean;
  journals?: Suggestion[];
  people?: Suggestion[];
  topics?: Suggestion[];
  arxiv?: Suggestion[];
  searches?: Suggestion[];
  error?: string | null;
}
interface Preview {
  kind: FeedKind;
  title?: string;
  config: Record<string, unknown>;
  items: FeedWork[];
  count?: number;
  perWeek?: number | null;
  perYear?: number | null;
  latest?: string | null;
  alternative?: { url: string; title?: string | null; count: number } | null;
  following: boolean;
}

export const errorText = (e: unknown) => String(e).replace(/^Error: /, "").replace(/^Error invoking remote method '[^']+': /, "").replace(/^Error: /, "");
const n = (v?: number) => (v == null ? "" : v.toLocaleString());
const works = (v?: number) => v != null && `${n(v)} ${v === 1 ? "work" : "works"}`;

function detail(s: Suggestion) {
  switch (s.kind) {
    case "venue":
      return [s.publisher, s.issn && `ISSN ${s.issn}`, works(s.worksCount)].filter(Boolean).join(" · ");
    case "author":
      return [s.affiliation, works(s.worksCount), s.orcid && `ORCID ${s.orcid}`].filter(Boolean).join(" · ");
    case "topic":
      return [s.field, works(s.worksCount)].filter(Boolean).join(" · ");
    case "openalex":
      return "New works matching these words, from OpenAlex";
    case "pubmed":
      return "New records matching these words in PubMed (medicine and life sciences)";
    case "rss":
      return s.code ? `arXiv listing ${s.code}` : "A feed";
    default:
      return "";
  }
}
/** "New articles in this journal": what following it brings. */
function promise(s: { kind: FeedKind; title: string }) {
  switch (s.kind) {
    case "venue":
      return `New articles in ${s.title}`;
    case "author":
      return `New works by ${s.title}`;
    case "topic":
      return `New works on ${s.title}`;
    case "openalex":
      return `New results for “${s.title}”`;
    case "pubmed":
      return `New PubMed records for “${s.title.replace(/^PubMed: /, "")}”`;
    case "citing":
      return `New works citing ${s.title.replace(/^Citing /, "")}`;
    default:
      return `New items from ${s.title}`;
  }
}
const nounOf = (kind: FeedKind) => (kind === "rss" ? "items" : kind === "venue" ? "articles" : "works");

function SuggestionRow({ s, onPick, inLibraryLabel }: { s: Suggestion; onPick: (s: Suggestion) => void; inLibraryLabel?: string }) {
  const library = s.inLibrary ?? s.count;
  return (
    <li>
      <button type="button" className="kx-follow-option" onClick={() => onPick(s)} data-following={s.following || undefined}>
        <span className="kx-feeds-kind" aria-hidden="true">
          <Icon name={FEED_KIND_ICON[s.kind]} size={13} />
        </span>
        <span className="kx-follow-option-text">
          <span className="kx-follow-option-title">{s.kind === "rss" && s.name ? `${s.name}` : s.title}</span>
          <small>{detail(s)}</small>
        </span>
        {!!library && <span className="kx-follow-badge" title={inLibraryLabel}>{`${n(library)} in your library`}</span>}
        {s.following ? (
          <span className="kx-follow-badge" data-on>
            <Icon name="check" size={10} /> Following
          </span>
        ) : (
          <span className="kx-follow-go">
            Preview <Icon name="chevronRight" size={10} />
          </span>
        )}
      </button>
    </li>
  );
}

function Group({ title, items, onPick }: { title: string; items?: Suggestion[]; onPick: (s: Suggestion) => void }) {
  if (!items?.length) return null;
  return (
    <section className="kx-follow-group" aria-label={title}>
      <h4>{title}</h4>
      <ul>
        {items.map((s) => (
          <SuggestionRow key={`${s.kind}:${JSON.stringify(s.config)}`} s={s} onPick={onPick} />
        ))}
      </ul>
    </section>
  );
}

/** What following it would bring, and Follow. */
function FollowPreview({ invoke, workspaceId, pick, collections, onBack, onFollowed }: { invoke: Invoke; workspaceId: string; pick: Suggestion; collections: Collection[]; onBack: () => void; onFollowed: (s: Subscription) => void }) {
  const [target, setTarget] = useState(pick);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState("");
  const [interval, setEvery] = useState(() => defaultInterval(pick.kind));
  const [collection, setCollection] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setPreview(undefined);
    setError("");
    void invoke<Preview>("feeds_preview", { kind: target.kind, config: target.config }, workspaceId)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, target]);
  const title = target.kind === "rss" ? (preview?.title ?? target.title) : target.title;
  const into = collections.find((c) => c.id === collection);
  const follow = () => {
    setBusy(true);
    const config = { ...(preview?.config ?? target.config), ...(collection ? { autoCollection: collection } : {}) };
    void invoke<{ subscription: Subscription; added: number; existed: boolean; error?: string | null }>("feeds_subscribe", { kind: target.kind, title, config, intervalMinutes: interval }, workspaceId)
      .then((out) => {
        feedsChanged();
        const what = out.subscription.title;
        if (out.error) toast(`Following ${what}. ${out.error}`);
        else if (out.existed) toast(`Already following ${what}`);
        else toast(out.added ? `Following ${what}: ${out.added} ${out.added === 1 ? "item" : "items"} in the Inbox` : `Following ${what}`, undefined, { label: "Open Inbox", run: () => openInbox(workspaceId) });
        onFollowed(out.subscription);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  const noun = nounOf(target.kind);
  const rate = preview ? cadence(preview, noun) : "";
  return (
    <div className="kx-follow-preview" aria-label={`Preview of ${title}`} role="group">
      <header>
        <button type="button" className="kx-follow-back" onClick={onBack} aria-label="Back to the results">
          <Icon name="chevronLeft" size={11} />
        </button>
        <span className="kx-feeds-kind" aria-hidden="true">
          <Icon name={FEED_KIND_ICON[target.kind]} size={13} />
        </span>
        <div>
          <strong>{promise({ kind: target.kind, title })}</strong>
          <small>{[KIND_LABEL[target.kind], detail(target)].filter(Boolean).join(" · ")}</small>
        </div>
      </header>
      {pick.kind === "venue" && target.kind === "venue" && preview?.alternative && (
        <p className="kx-follow-alt">
          <Hint help="feeds.journal-feed" />
          <button type="button" className="kx-settings-button" onClick={() => setTarget({ kind: "rss", title: preview.alternative!.title || title, config: { url: preview.alternative!.url }, following: false })}>
            Use the journal’s own feed
          </button>
        </p>
      )}
      {target !== pick && (
        <p className="kx-follow-alt">
          <span>Previewing the journal’s own feed.</span>
          <button type="button" className="kx-settings-button" onClick={() => setTarget(pick)}>
            Use OpenAlex instead
          </button>
        </p>
      )}
      {error ? (
        <p className="kx-inline-error" role="alert">
          {error}
        </p>
      ) : !preview ? (
        <div className="kx-follow-items kx-skeleton" role="status" aria-label="Loading the preview">
          <div className="kx-skeleton-line" />
          <div className="kx-skeleton-line" />
          <div className="kx-skeleton-line short" />
        </div>
      ) : (
        <>
          <p className="kx-follow-rate">
            {rate || `${preview.items.length} recent ${noun}`}
            {preview.latest && ` · latest ${new Date(preview.latest).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`}
          </p>
          {preview.items.length ? (
            <ol className="kx-follow-items" aria-label="Latest items">
              {preview.items.map((w, i) => (
                <li key={`${i}:${w.title}`}>
                  <span>{w.title}</span>
                  <small>{[w.authors?.slice(0, 3).join(", "), w.venue && target.kind !== "venue" ? w.venue : "", w.published ?? w.year].filter(Boolean).join(" · ")}</small>
                </li>
              ))}
            </ol>
          ) : (
            <p className="kx-follow-empty">{hintText("feeds.preview-empty")}</p>
          )}
        </>
      )}
      <div className="kx-settings-rows kx-follow-options">
        <div className="kx-settings-row">
          <div>
            <span>Check</span>
            <small>{hintText("feeds.interval")}</small>
          </div>
          <div className="kx-settings-control">
            <select className="kx-settings-select" aria-label="How often to check" value={interval} onChange={(e) => setEvery(Number(e.target.value))}>
              {INTERVALS.map((m) => (
                <option key={m} value={m}>
                  {intervalLabel(m)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="kx-settings-row">
          <div>
            <span>Also add to a collection</span>
            <small>{hintText("feeds.auto-collection")}</small>
          </div>
          <div className="kx-settings-control">
            <select className="kx-settings-select" aria-label="Also add new items to a collection" value={collection} onChange={(e) => setCollection(e.target.value)}>
              <option value="">Off</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <p className="kx-follow-sentence">
        Key checks {intervalPhrase(interval)} while it is open. New {noun} appear in your Inbox
        {into ? ` and are also added to “${into.name}”.` : "; nothing goes into your library unless you add it."}
      </p>
      <footer>
        <button type="button" className="kx-settings-button" onClick={onBack}>
          Cancel
        </button>
        <button type="button" className="kx-button-primary" disabled={busy || (!!error && !preview) || preview?.following} onClick={follow}>
          <Icon name={preview?.following ? "check" : "bell"} size={12} /> {preview?.following ? "Following" : busy ? "Following…" : "Follow"}
        </button>
      </footer>
    </div>
  );
}

/** The search box, its suggestions, the library's picks and the simple pickers. */
export function FollowFinder({ invoke, workspaceId, onImportOpml }: { invoke: Invoke; workspaceId: string; onImportOpml: () => void }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Suggestions>();
  const [searching, setSearching] = useState(false);
  const [pick, setPick] = useState<Suggestion>();
  const [library, setLibrary] = useState<Suggestion[]>();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [arxiv, setArxiv] = useState<{ code: string; name: string; url: string }[]>([]);
  const asked = useRef(0);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void invoke<Suggestion[]>("feeds_from_library", {}, workspaceId).then(setLibrary).catch(() => setLibrary([]));
    void invoke<Collection[]>("store_collections", {}, workspaceId).then(setCollections).catch(() => {});
    void invoke<{ code: string; name: string; url: string }[]>("feeds_arxiv_categories", {}, workspaceId).then(setArxiv).catch(() => {});
  }, [invoke, workspaceId, pick]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return setFound(undefined);
    const at = ++asked.current;
    setSearching(true);
    const timer = setTimeout(() => {
      void invoke<Suggestions>("feeds_suggest", { query: q }, workspaceId)
        .then((s) => {
          if (at !== asked.current) return;
          setFound(s);
          // A pasted address goes straight to its preview.
          if (s.address) setPick({ kind: "rss", title: q, config: { url: q }, following: false });
        })
        .catch((e) => at === asked.current && setFound({ query: q, error: errorText(e) }))
        .finally(() => at === asked.current && setSearching(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [invoke, workspaceId, query]);

  if (pick)
    return (
      <FollowPreview
        invoke={invoke}
        workspaceId={workspaceId}
        pick={pick}
        collections={collections}
        onBack={() => {
          setPick(undefined);
          if (found?.address) setQuery("");
          setTimeout(() => box.current?.focus(), 0);
        }}
        onFollowed={() => {
          setPick(undefined);
          setQuery("");
        }}
      />
    );
  const nothing = found && !found.address && !found.error && !found.journals?.length && !found.people?.length && !found.topics?.length && !found.arxiv?.length;
  return (
    <div className="kx-follow">
      <label className="kx-follow-search">
        <Icon name="search" size={13} />
        <input
          ref={box}
          value={query}
          placeholder="Follow a journal, author, topic or search…"
          aria-label="Follow a journal, author, topic or search"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        {searching && <span className="kx-search-spinner" aria-label="Searching" />}
      </label>
      <Hint help="feeds.follow-search" />
      {found && !found.address ? (
        <div className="kx-follow-results" aria-label="Things to follow">
          {found.error && <p className="kx-inline-error">{found.error}</p>}
          {nothing && <EmptyState help="empty.follow-results" icon="search" compact />}
          <Group title="Journals" items={found.journals} onPick={setPick} />
          <Group title="People" items={found.people} onPick={setPick} />
          <Group title="Topics" items={found.topics} onPick={setPick} />
          <Group title="arXiv listings" items={found.arxiv} onPick={setPick} />
          <Group title="Or follow these words as a search" items={found.searches} onPick={setPick} />
        </div>
      ) : (
        <div className="kx-follow-start">
          {!!library?.length && (
            <section className="kx-follow-group" aria-label="From your library">
              <h4>
                From your library <Explain help="feeds.from-library" />
              </h4>
              <div className="kx-follow-chips">
                {library.map((s) => (
                  <button key={`${s.kind}:${JSON.stringify(s.config)}`} type="button" className="kx-follow-chip" data-following={s.following || undefined} disabled={s.following} title={s.following ? "Following" : `${promise(s)}: ${s.count} in your library`} onClick={() => setPick(s)}>
                    <Icon name={s.following ? "check" : FEED_KIND_ICON[s.kind]} size={11} />
                    {s.title}
                  </button>
                ))}
              </div>
            </section>
          )}
          <div className="kx-settings-rows">
            <div className="kx-settings-row">
              <div>
                <span>New citations of a collection</span>
                <small>{hintText("feeds.citing")}</small>
              </div>
              <div className="kx-settings-control">
                <select
                  className="kx-settings-select"
                  aria-label="Follow new citations of"
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    const c = collections.find((x) => x.id === id);
                    setPick({ kind: "citing", title: c ? `Citing ${c.name}` : "Citing my library", config: c ? { collectionId: c.id } : {}, following: false });
                  }}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="library">The whole library</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="kx-settings-row">
              <div>
                <span>An arXiv listing</span>
                <small>{hintText("feeds.arxiv")}</small>
              </div>
              <div className="kx-settings-control">
                <select
                  className="kx-settings-select"
                  aria-label="Follow an arXiv listing"
                  value=""
                  onChange={(e) => {
                    const a = arxiv.find((x) => x.code === e.target.value);
                    if (a) setPick({ kind: "rss", title: `arXiv ${a.code}: ${a.name}`, config: { url: a.url, arxiv: a.code }, following: false });
                  }}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  {arxiv.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.name} ({a.code})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="kx-settings-row">
              <div>
                <span>From another feed reader</span>
                <small>{hintText("feeds.opml")}</small>
              </div>
              <div className="kx-settings-control">
                <button type="button" className="kx-settings-button" onClick={onImportOpml}>
                  <Icon name="download" size={12} /> Import OPML…
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
