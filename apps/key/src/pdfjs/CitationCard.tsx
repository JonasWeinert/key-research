// The card shown over an in-text citation ("[12]", "(Smith 2020)", "[3, 7–9]") and over a
// scholarly link: compact, in the manner of a macOS popover. A clamped title, one quiet line
// of authors · year · venue, an optional one-line summary, and a small row of actions. Several
// works show as chips that scroll sideways inside the card, never past it. While metadata is
// on its way (or a provider is rate limited and the lookup is being retried) the text is a
// skeleton; a work no index knows shows the reference as printed. Expanded (Details), the
// same card grows in place into the work's details: summary, abstract, identifiers and links;
// it then stays until a press outside it or Escape.
import { invoke } from '@tauri-apps/api/core';
import { SegmentedTabs } from '../ui/SegmentedTabs';
import { useEffect, useState, type ReactNode } from 'react';
import type { ScholarlyMetadata, ScientificCitation, ScientificReference } from '../engines/types';
import { Icon } from '../ui/Icon';
import { citationAuthorsSnippet, citationLinks, citationSummary, isNumberedCitation, type CitationLink } from './citation-details';
import { isTauri } from './reader-model';
import { classifyLookupError, lookupFaultPending } from './remote-retry';
import type { ScholarlyEntry } from './scholarly-metadata';
import { useRetryingLookup, type RetryingLookup } from './use-retrying-lookup';
import './citation-card.css';

export type WorkCardState = 'ready' | 'loading' | 'missing' | 'unavailable';

/** "Narang, Bae et al. · 2021 · JAMA Cardiol" */
export function workByline(metadata?: ScholarlyMetadata) {
  if (!metadata) return '';
  const surnames = metadata.authors.map(author => author.trim().split(/\s+/).at(-1) ?? author);
  return [citationAuthorsSnippet(surnames, 2), metadata.year, metadata.journalShort ?? metadata.journal]
    .filter(Boolean)
    .join(' · ');
}

/** A chip's label: "Narang 2021" when known, else the list number (or the work's position). */
export function chipLabel(number: number, numbered: boolean, position: number, metadata?: ScholarlyMetadata) {
  const surname = metadata?.authors[0]?.trim().split(/\s+/).at(-1);
  const identity = [surname, metadata?.year].filter(Boolean).join(' ');
  if (!numbered) return identity || `Work ${position + 1}`;
  return identity ? `${number} · ${identity}` : String(number);
}

/** Where the go-to-reference action leads: its page, or the list on a page without pages. */
const referencePlace = (reference: ScientificReference) => (reference.page >= 0 ? `p. ${reference.page + 1}` : 'References');

/** The reference as printed, without its list number. */
export function printedReference(reference: ScientificReference) {
  return reference.text.replace(new RegExp(`^\\s*[[(]?${reference.number}[\\]).:]?\\s*`), '').trim();
}

function Skeleton() {
  return (
    <div className="pdfjs-cite-skeleton" role="status" aria-label="Looking up this work">
      <i style={{ width: '92%' }} />
      <i style={{ width: '64%' }} />
      <i className="pdfjs-cite-skeleton-meta" style={{ width: '48%' }} />
    </div>
  );
}

/** The body every card shares: title, byline, summary, then the action row. */
function WorkBody({
  state,
  title,
  byline,
  summary,
  onRetry,
  actions,
}: {
  state: WorkCardState;
  title: string;
  byline?: string;
  summary?: string;
  onRetry?: () => void;
  actions?: ReactNode;
}) {
  return (
    <>
      {state === 'loading' ? (
        <Skeleton />
      ) : (
        <div className="pdfjs-cite-copy">
          <h2 title={title}>{title}</h2>
          {state === 'ready' && byline && <p className="pdfjs-cite-byline">{byline}</p>}
          {state === 'missing' && <p className="pdfjs-cite-byline">Not found in OpenAlex, Crossref or Semantic Scholar</p>}
          {state === 'unavailable' && (
            <p className="pdfjs-cite-byline pdfjs-cite-unavailable">
              Couldn’t load details
              {onRetry && (
                <button type="button" onClick={onRetry}>
                  <Icon name="retry" />
                  Retry
                </button>
              )}
            </p>
          )}
          {state === 'ready' && summary && <p className="pdfjs-cite-summary">{summary}</p>}
        </div>
      )}
      {actions && <footer className="pdfjs-cite-actions">{actions}</footer>}
    </>
  );
}

function ActionLink({ href, icon, children, primary }: { href: string; icon: 'external' | 'document'; children: ReactNode; primary?: boolean }) {
  return (
    <a className={`pdfjs-cite-action${primary ? ' pdfjs-cite-primary' : ''}`} href={href} target="_blank" rel="noreferrer">
      <Icon name={icon} />
      {children}
    </a>
  );
}

const sourcesOf = (metadata: ScholarlyMetadata) => (metadata.sources?.length ? metadata.sources : [metadata.source]).join(', ');

/** The expanded card: everything known about the work, scrolling inside the card. */
function WorkDetails({
  metadata,
  title,
  printed,
  page,
}: {
  metadata?: ScholarlyMetadata;
  title: string;
  /** The reference as the paper prints it. */
  printed?: string;
  /** Where the reference list has it, 0-based. */
  page?: number;
}) {
  const authors = metadata?.authors ?? [];
  const venue = [metadata?.journal ?? metadata?.journalShort, metadata?.year].filter(Boolean).join(' · ');
  const facts: Array<[string, ReactNode]> = [];
  if (metadata?.doi)
    facts.push([
      'DOI',
      <a href={`https://doi.org/${metadata.doi}`} target="_blank" rel="noreferrer">
        {metadata.doi}
      </a>,
    ]);
  if (metadata?.openAccess !== undefined) facts.push(['Access', metadata.openAccess ? 'Open access' : 'Not marked open access']);
  if (page !== undefined) facts.push(['In this PDF', `Reference list, page ${page + 1}`]);
  if (metadata) facts.push(['Found in', `${sourcesOf(metadata)}${metadata.certainty ? ` · ${metadata.certainty} confidence` : ''}`]);
  return (
    <div className="pdfjs-cite-details">
      <h2>{title}</h2>
      {authors.length > 0 && (
        <p className="pdfjs-cite-authors" title={authors.join(', ')}>
          {citationAuthorsSnippet(authors, 6)}
        </p>
      )}
      {venue && <p className="pdfjs-cite-venue">{venue}</p>}
      {metadata?.tldrText?.trim() && (
        <section className="pdfjs-cite-section">
          <h3>TLDR</h3>
          <p>{metadata.tldrText.trim()}</p>
        </section>
      )}
      {metadata?.abstractText?.trim() && (
        <section className="pdfjs-cite-section">
          <h3>Abstract</h3>
          <p>{metadata.abstractText.trim()}</p>
        </section>
      )}
      {facts.length > 0 && (
        <dl className="pdfjs-cite-facts">
          {facts.map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {printed && printed !== title && (
        <section className="pdfjs-cite-section">
          <h3>As cited</h3>
          <p className="pdfjs-cite-printed">{printed}</p>
        </section>
      )}
    </div>
  );
}

/** The expanded card's links, the full text first. */
function DetailLinks({ links }: { links: CitationLink[] }) {
  return (
    <>
      {links.slice(0, 3).map(link => (
        <ActionLink key={link.url} href={link.url} icon="external" primary={link.emphasis === 'primary'}>
          {link.label}
        </ActionLink>
      ))}
    </>
  );
}

function ExpandToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="pdfjs-cite-close"
      aria-label={expanded ? 'Show less' : 'Show details'}
      title={expanded ? 'Show less' : 'Details'}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <Icon name={expanded ? 'collapse' : 'expand'} />
    </button>
  );
}

/** Looks a reference up now when the card needs it, again while its provider is rate limited. */
function useReferenceLookup(
  reference: ScientificReference | undefined,
  entry: ScholarlyEntry | undefined,
  onResolved: (number: number, metadata: ScholarlyMetadata) => void,
): [RetryingLookup<ScholarlyMetadata>, () => void, boolean, ScholarlyEntry | undefined] {
  // Smokes simulate a rate-limited provider; the stored result then waits behind the lookup.
  const [simulated] = useState(() => lookupFaultPending('scholarly'));
  if (simulated && entry?.state === 'ready') entry = { state: 'failed', error: 'HTTP 429' };
  // Still queued behind the paper's other references, or failed for a while: ask now, at the
  // front of the queue (the host shares one request per work), and keep asking while it is
  // rate limited.
  const transient =
    simulated ||
    entry?.state === 'loading' ||
    (entry?.state === 'failed' && classifyLookupError(entry.error) === 'transient');
  const key = reference && transient && isTauri() ? `${reference.number}\u0000${reference.text}` : null;
  const [lookup, retry] = useRetryingLookup<ScholarlyMetadata>(
    key,
    () => invoke<ScholarlyMetadata>('scholarly_lookup_resource', { resource: reference!.text }),
    { channel: 'scholarly' },
  );
  useEffect(() => {
    if (lookup.status === 'ready' && reference) onResolved(reference.number, lookup.value);
  }, [lookup, onResolved, reference]);
  return [lookup, retry, key !== null, entry];
}

/** Chips for several works: one row that scrolls sideways, fading at whichever edge has more. */
function WorkChips({
  citation,
  active,
  onSelect,
  metadataFor,
  idFor,
}: {
  citation: ScientificCitation;
  active: number | null;
  onSelect: (number: number) => void;
  metadataFor: (number: number) => ScholarlyMetadata | undefined;
  idFor: (number: number) => string;
}) {
  const numbered = isNumberedCitation(citation.source);
  return (
    <SegmentedTabs
      className="pdfjs-cite-chips"
      size="small"
      label="Works in this citation"
      value={String(active ?? citation.numbers[0])}
      onChange={id => onSelect(Number(id))}
      panelId={id => idFor(Number(id))}
      tabs={citation.numbers.map((number, position) => ({
        id: String(number),
        label: chipLabel(number, numbered, position, metadataFor(number)),
      }))}
    />
  );
}

export interface CitationCardProps {
  citation: ScientificCitation;
  active: number | null;
  onSelect: (number: number) => void;
  reference: (number: number) => ScientificReference | undefined;
  entry: (number: number) => ScholarlyEntry | undefined;
  /** A lookup retried from the card succeeded: keep its result. */
  onResolved: (number: number, metadata: ScholarlyMetadata) => void;
  onGoToReference: (reference: ScientificReference) => void;
  onShowMore: (number: number) => void;
  /** Opens the work in the library when the host knows it is there. */
  libraryAction?: (number: number) => (() => void) | null | undefined;
  onClose?: () => void;
  /** Grown into the work's details (after Show details). */
  expanded?: boolean;
  onCollapse?: () => void;
  uiId: string;
}

/** The body of the hover card over an in-text citation. */
export function CitationCardBody({
  citation,
  active,
  onSelect,
  reference: referenceFor,
  entry: entryFor,
  onResolved,
  onGoToReference,
  onShowMore,
  libraryAction,
  onClose,
  expanded = false,
  onCollapse,
  uiId,
}: CitationCardProps) {
  const number = active ?? citation.numbers[0] ?? null;
  const reference = number === null ? undefined : referenceFor(number);
  const [lookup, retry, retrying, entry] = useReferenceLookup(
    reference,
    number === null ? undefined : entryFor(number),
    onResolved,
  );
  const metadata = entry?.state === 'ready' ? entry.metadata : lookup.status === 'ready' ? lookup.value : undefined;
  const state: WorkCardState = metadata
    ? 'ready'
    : retrying
      ? lookup.status === 'missing'
        ? 'missing'
        : lookup.status === 'unavailable'
          ? 'unavailable'
          : 'loading'
      : !entry || entry.state === 'loading'
        ? 'loading'
        : 'missing';
  const several = citation.numbers.length > 1;
  const summary = citationSummary(metadata)?.text;
  const links = citationLinks(metadata);
  const link = links.find(candidate => candidate.url.includes('doi.org')) ?? links[0];
  const openInLibrary = number === null ? null : libraryAction?.(number);
  const id = (value: number) => `${uiId}-cite-${value}`;
  return (
    <>
      {(several || onClose || expanded) && (
        <header className="pdfjs-cite-head">
          {several ? (
            <WorkChips
              citation={citation}
              active={number}
              onSelect={onSelect}
              idFor={id}
              metadataFor={value => {
                const candidate = entryFor(value);
                return candidate?.state === 'ready' ? candidate.metadata : undefined;
              }}
            />
          ) : (
            <span className="pdfjs-cite-kicker">{citation.source}</span>
          )}
          {expanded && onCollapse && <ExpandToggle expanded onToggle={onCollapse} />}
          {onClose && (
            <button type="button" className="pdfjs-cite-close" aria-label="Close citation" onClick={onClose}>
              <Icon name="close" />
            </button>
          )}
        </header>
      )}
      {reference && number !== null && expanded ? (
        <article className="pdfjs-cite-body" id={id(number)} role={several ? 'tabpanel' : undefined} key={number}>
          {state === 'loading' ? (
            <Skeleton />
          ) : (
            <WorkDetails
              metadata={metadata}
              title={metadata?.title ?? printedReference(reference)}
              printed={printedReference(reference)}
              page={reference.page >= 0 ? reference.page : undefined}
            />
          )}
          <footer className="pdfjs-cite-actions">
            {openInLibrary && (
              <button type="button" className="pdfjs-cite-action" onClick={openInLibrary}>
                <Icon name="book" />
                In library
              </button>
            )}
            <DetailLinks links={links} />
            <span className="pdfjs-cite-spacer" />
            <button type="button" className="pdfjs-cite-action" title="Go to the reference list" onClick={() => onGoToReference(reference)}>
              {referencePlace(reference)}
              <Icon name="next" />
            </button>
          </footer>
        </article>
      ) : reference && number !== null ? (
        <article className="pdfjs-cite-body" id={id(number)} role={several ? 'tabpanel' : undefined} key={number}>
          <WorkBody
            state={state}
            title={metadata?.title ?? printedReference(reference)}
            byline={workByline(metadata)}
            summary={summary}
            onRetry={retry}
            actions={
              <>
                {openInLibrary && (
                  <button type="button" className="pdfjs-cite-action" onClick={openInLibrary}>
                    <Icon name="book" />
                    In library
                  </button>
                )}
                {link && <ActionLink href={link.url} icon="external">{link.url.includes('doi.org') ? 'DOI' : 'Open'}</ActionLink>}
                <span className="pdfjs-cite-spacer" />
                <button
                  type="button"
                  className="pdfjs-cite-action"
                  title="Go to the reference list"
                  onClick={() => onGoToReference(reference)}
                >
                  {referencePlace(reference)}
                  <Icon name="next" />
                </button>
                {metadata && (
                  <button
                    type="button"
                    className="pdfjs-cite-action pdfjs-cite-icon"
                    aria-label="Show details"
                    title="Details"
                    onClick={() => onShowMore(number)}
                  >
                    <Icon name="expand" />
                  </button>
                )}
              </>
            }
          />
        </article>
      ) : (
        <article className="pdfjs-cite-body">
          <div className="pdfjs-cite-copy">
            <h2>Reference not in the list</h2>
            <p className="pdfjs-cite-byline">This citation could not be matched to the paper’s references.</p>
          </div>
        </article>
      )}
    </>
  );
}

/** The body of the card for a DOI or publisher link: looked up when opened, retried while rate limited. */
export function ExternalWorkCardBody({
  url,
  onResolved,
  onShowMore,
  onClose,
  expanded = false,
  onCollapse,
}: {
  url: string;
  onResolved: (metadata: ScholarlyMetadata | null) => void;
  onShowMore: () => void;
  onClose: () => void;
  expanded?: boolean;
  onCollapse?: () => void;
}) {
  const [lookup, retry] = useRetryingLookup<ScholarlyMetadata>(
    isTauri() ? url : null,
    () => invoke<ScholarlyMetadata>('scholarly_lookup_resource', { resource: url }),
    { channel: 'scholarly' },
  );
  useEffect(() => onResolved(lookup.status === 'ready' ? lookup.value : null), [lookup, onResolved]);
  const metadata = lookup.status === 'ready' ? lookup.value : undefined;
  const state: WorkCardState =
    lookup.status === 'ready'
      ? 'ready'
      : lookup.status === 'missing'
        ? 'missing'
        : lookup.status === 'unavailable'
          ? 'unavailable'
          : 'loading';
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // Not a URL: shown as is.
  }
  return (
    <>
      <header className="pdfjs-cite-head">
        <span className="pdfjs-cite-kicker">{host}</span>
        {expanded && onCollapse && <ExpandToggle expanded onToggle={onCollapse} />}
        <button type="button" className="pdfjs-cite-close" aria-label="Close linked research" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      {expanded && metadata ? (
        <article className="pdfjs-cite-body">
          <WorkDetails metadata={metadata} title={metadata.title} />
          <footer className="pdfjs-cite-actions">
            <DetailLinks links={citationLinks(metadata)} />
            <span className="pdfjs-cite-spacer" />
            <ActionLink href={url} icon="external">Open link</ActionLink>
          </footer>
        </article>
      ) : (
      <article className="pdfjs-cite-body">
        <WorkBody
          state={state}
          title={metadata?.title ?? (state === 'missing' ? url : 'Linked research')}
          byline={workByline(metadata)}
          summary={citationSummary(metadata)?.text}
          onRetry={retry}
          actions={
            <>
              <ActionLink href={url} icon="external">Open link</ActionLink>
              <span className="pdfjs-cite-spacer" />
              {metadata && (
                <button
                  type="button"
                  className="pdfjs-cite-action pdfjs-cite-icon"
                  aria-label="Show details"
                  title="Details"
                  onClick={onShowMore}
                >
                  <Icon name="expand" />
                </button>
              )}
            </>
          }
        />
      </article>
      )}
    </>
  );
}
