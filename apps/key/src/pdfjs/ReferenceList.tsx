// The paper's reference list, as the side panel's References section shows it: the number,
// the reference as printed, its page, and what the host knows about it underneath.
import type { ReactNode } from 'react';
import './reference-list.css';

export interface ReferenceListItem {
  number: number;
  /** Where it is printed; none for a web page's list. */
  page?: number;
  text: string;
  xFraction?: number;
  yFraction?: number;
}

export function ReferenceList<T extends ReferenceListItem>({
  references,
  onSelect,
  aside,
  header,
  empty,
}: {
  references: T[] | undefined;
  onSelect: (reference: T) => void;
  aside?: (reference: T) => ReactNode;
  /** Above the list (how the paper was analysed …). */
  header?: ReactNode;
  /** Shown when `references` is an empty list; nothing while it is undefined (loading). */
  empty?: ReactNode;
}) {
  const strip = (reference: T) =>
    reference.text.replace(new RegExp(`^\\s*[[(]?${reference.number}[\\]).:]?\\s*`), '').trim() || reference.text;
  return (
    <div className="key-ref-list-host">
      {header}
      {references?.length ? (
        <ol className="key-ref-list" aria-label="References">
          {references.map(reference => (
            <li key={`${reference.number}-${reference.page}`}>
              <button
                type="button"
                title={reference.page == null ? `Go to reference ${reference.number}` : `Go to reference ${reference.number} on page ${reference.page + 1}`}
                onClick={() => onSelect(reference)}
              >
                <span className="key-ref-number">{reference.number}</span>
                <span className="key-ref-text">{strip(reference)}</span>
                {reference.page != null && <span className="key-ref-page">p. {reference.page + 1}</span>}
              </button>
              {aside?.(reference)}
            </li>
          ))}
        </ol>
      ) : references ? (
        empty ?? <p className="key-ref-empty">No reference list was found in this PDF.</p>
      ) : (
        <p className="key-ref-empty" role="status">Reading the reference list…</p>
      )}
    </div>
  );
}
