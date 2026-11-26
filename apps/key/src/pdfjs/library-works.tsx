// "Add to library" for works the reader shows (a cited work's card, a reference list row): the
// host says which works the library has and adds one; the reader keeps each work's state so
// every place showing it agrees (Add to library → Adding… → In library, which opens it).
import { useEffect, useSyncExternalStore } from 'react';
import { Icon } from '../ui/Icon';
import './library-works.css';

/** A work as the reader knows it: from a lookup (OpenAlex …) or the library's analysis. */
export interface CitedWork {
  title: string;
  doi?: string;
  authors?: string[];
  year?: number | string;
  venue?: string;
  url?: string;
}

/** A library match: the source, and whether it is certain (an identifier or link) or only a
 *  title match ("Possibly in library", which never stops adding). */
export type LibraryMatch = string | { sourceId: string; certain?: boolean };

export interface LibraryWorksHost {
  /** Which of these works the library has already: key → source id (or match). */
  match(works: Array<CitedWork & { key: string }>): Promise<Record<string, LibraryMatch>>;
  /** Adds the work; null when the person cancelled (the collection chooser). */
  add(work: CitedWork): Promise<{ sourceId: string; existed?: boolean } | null>;
  open(sourceId: string): void;
}

export type LibraryWorkState =
  | { status: 'checking' }
  | { status: 'absent' }
  | { status: 'adding' }
  | { status: 'present'; sourceId: string }
  | { status: 'possible'; sourceId: string }
  | { status: 'failed'; error: string };

const CHECKING: LibraryWorkState = { status: 'checking' };
const bareDoi = (doi: string) => doi.trim().toLowerCase().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/, '');

/** One key per work: its DOI, else its title and year. */
export function workKey(work: CitedWork) {
  if (work.doi?.trim()) return `doi:${bareDoi(work.doi)}`;
  return `title:${work.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}|${work.year ?? ''}`;
}

export class LibraryWorks {
  private states = new Map<string, LibraryWorkState>();
  private listeners = new Set<() => void>();
  private queue = new Map<string, CitedWork>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly host: LibraryWorksHost) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  state(key: string) {
    return this.states.get(key) ?? CHECKING;
  }

  private set(key: string, state: LibraryWorkState) {
    this.states.set(key, state);
    for (const listener of this.listeners) listener();
  }

  /** The host knows the library has it (e.g. the analysis matched the reference). */
  known(work: CitedWork, sourceId: string) {
    const key = workKey(work);
    const current = this.states.get(key);
    if (current?.status !== 'present' || current.sourceId !== sourceId) this.set(key, { status: 'present', sourceId });
  }

  /** Asks the host, with the other works shown at the same moment, whether the library has it. */
  check(work: CitedWork) {
    const key = workKey(work);
    if (this.states.has(key) || this.queue.has(key)) return;
    this.queue.set(key, work);
    this.timer ??= setTimeout(() => void this.flush(), 30);
  }

  private async flush() {
    this.timer = undefined;
    const batch = [...this.queue].map(([key, work]) => ({ ...work, key }));
    this.queue.clear();
    let found: Record<string, LibraryMatch> = {};
    try {
      found = await this.host.match(batch);
    } catch {
      // Unknown: offer the add; adding answers the existing source when there is one.
    }
    for (const { key } of batch) {
      if (this.states.has(key)) continue;
      const match = found[key];
      if (!match) this.set(key, { status: 'absent' });
      else if (typeof match === 'string' || match.certain !== false) this.set(key, { status: 'present', sourceId: typeof match === 'string' ? match : match.sourceId });
      else this.set(key, { status: 'possible', sourceId: match.sourceId });
    }
  }

  async add(work: CitedWork) {
    const key = workKey(work);
    const before = this.state(key);
    if (before.status === 'adding') return;
    this.set(key, { status: 'adding' });
    try {
      const added = await this.host.add(work);
      if (!added) return this.set(key, before.status === 'checking' ? { status: 'absent' } : before);
      this.set(key, { status: 'present', sourceId: added.sourceId });
    } catch (error) {
      this.set(key, { status: 'failed', error: String(error).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '') });
    }
  }

  open(sourceId: string) {
    this.host.open(sourceId);
  }
}

export function useLibraryWork(works: LibraryWorks | undefined, work: CitedWork | undefined, knownSourceId?: string | null) {
  const key = work ? workKey(work) : '';
  useEffect(() => {
    if (!works || !work) return;
    if (knownSourceId) works.known(work, knownSourceId);
    else works.check(work);
    // `work` is identified by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [works, key, knownSourceId]);
  const subscribe = works?.subscribe ?? noSubscribe;
  return useSyncExternalStore(subscribe, () => (works && key ? works.state(key) : CHECKING));
}
const noSubscribe = () => () => {};

/** The one-click add, then the way to the library's copy. `variant` fits a card's action row
 *  or a reference list row. */
export function AddToLibraryButton({
  works,
  work,
  knownSourceId,
  variant = 'card',
}: {
  works: LibraryWorks | undefined;
  work: CitedWork | undefined;
  knownSourceId?: string | null;
  variant?: 'card' | 'row';
}) {
  const state = useLibraryWork(works, work, knownSourceId);
  if (!works || !work?.title.trim()) return null;
  const className = variant === 'card' ? 'pdfjs-cite-action key-work-add' : 'key-work-add key-work-add-row';
  if (state.status === 'checking') return <span className={`${className} key-work-add-checking`} aria-hidden="true" />;
  if (state.status === 'present')
    return (
      <button
        type="button"
        className={className}
        data-state="present"
        title="Open it in your library"
        onClick={event => {
          event.stopPropagation();
          works.open(state.sourceId);
        }}
      >
        <Icon name="book" />
        In library
      </button>
    );
  // Only the title matched: shown as such, and adding stays one click away.
  if (state.status === 'possible')
    return (
      <span className="key-work-possible" data-variant={variant}>
        <button
          type="button"
          className={className}
          data-state="possible"
          title="A work with this title is in your library: open it"
          onClick={event => {
            event.stopPropagation();
            works.open(state.sourceId);
          }}
        >
          <Icon name="book" />
          Possibly in library
        </button>
        <button
          type="button"
          className={`${className} key-work-add-anyway`}
          data-state="absent"
          title="Add this work to your library anyway"
          aria-label="Add to library anyway"
          onClick={event => {
            event.stopPropagation();
            void works.add(work);
          }}
        >
          <Icon name="add" />
        </button>
      </span>
    );
  if (state.status === 'adding')
    return (
      <button type="button" className={className} data-state="adding" disabled aria-live="polite">
        <i className="key-work-add-spinner" aria-hidden="true" />
        Adding…
      </button>
    );
  return (
    <button
      type="button"
      className={className}
      data-state={state.status}
      title={state.status === 'failed' ? `Could not add it: ${state.error}. Try again.` : 'Add this work to your library'}
      onClick={event => {
        event.stopPropagation();
        void works.add(work);
      }}
    >
      <Icon name={state.status === 'failed' ? 'retry' : 'add'} />
      {state.status === 'failed' ? 'Try again' : 'Add to library'}
    </button>
  );
}
