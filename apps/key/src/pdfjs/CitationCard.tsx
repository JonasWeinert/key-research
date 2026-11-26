// The card shown over an in-text citation ("[12]", "(Smith 2020)", "[3, 7–9]") and over a
// scholarly link: compact, in the manner of a macOS popover. A clamped title, one quiet line
// of authors · year · venue, an optional one-line summary, and a small row of actions. Several
// works show as chips that scroll sideways inside the card, never past it. While metadata is
// on its way (or a provider is rate limited and the lookup is being retried) the text is a
// skeleton; a work no index knows shows the reference as printed.
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ScholarlyMetadata, ScientificCitation, ScientificReference } from '../engines/types';
import { Icon } from '../ui/Icon';
import { citationAuthorsSnippet, citationLinks, citationSummary, isNumberedCitation } from './citation-details';
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

function ActionLink({ href, icon, children }: { href: string; icon: 'external' | 'document'; children: ReactNode }) {
  return (
    <a className="pdfjs-cite-action" href={href} target="_blank" rel="noreferrer">
      <Icon name={icon} />
      {children}
    </a>
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
  const strip = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const element = strip.current;
    if (!element) return;
    const start = element.scrollLeft > 1;
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setEdges(current => (current.start === start && current.end === end ? current : { start, end }));
  }, []);
  useLayoutEffect(measure, [measure, citation.id]);
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [active, measure]);
  const numbered = isNumberedCitation(citation.source);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = citation.numbers.indexOf(active ?? citation.numbers[0]);
    const next = citation.numbers[(index + (event.key === 'ArrowRight' ? 1 : -1) + citation.numbers.length) % citation.numbers.length];
    onSelect(next);
    requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };
  return (
    <div
      ref={strip}
      className="pdfjs-cite-chips"
      role="tablist"
      aria-label="Works in this citation"
      data-fade-start={edges.start || undefined}
      data-fade-end={edges.end || undefined}
      onScroll={measure}
      onKeyDown={onKeyDown}
    >
      {citation.numbers.map((number, position) => (
        <button
          type="button"
          key={number}
          role="tab"
          aria-selected={active === number}
          aria-controls={idFor(number)}
          tabIndex={active === number ? 0 : -1}
          onClick={() => onSelect(number)}
        >
          {chipLabel(number, numbered, position, metadataFor(number))}
        </button>
      ))}
    </div>
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
  const link = citationLinks(metadata).find(candidate => candidate.url.includes('doi.org')) ?? citationLinks(metadata)[0];
  const openInLibrary = number === null ? null : libraryAction?.(number);
  const id = (value: number) => `${uiId}-cite-${value}`;
  return (
    <>
      {(several || onClose) && (
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
          {onClose && (
            <button type="button" className="pdfjs-cite-close" aria-label="Close citation" onClick={onClose}>
              <Icon name="close" />
            </button>
          )}
        </header>
      )}
      {reference && number !== null ? (
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
                  p. {reference.page + 1}
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
}: {
  url: string;
  onResolved: (metadata: ScholarlyMetadata | null) => void;
  onShowMore: () => void;
  onClose: () => void;
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
        <button type="button" className="pdfjs-cite-close" aria-label="Close linked research" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
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
    </>
  );
}
