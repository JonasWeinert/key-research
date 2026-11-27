// A highlight, opened from its margin marker or by clicking it: its colour and actions, its
// comment (leading) and passage, when it was made, and the notes and canvases that use it.
// Shared by the PDF reader and the shell's saved web page reader.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import './highlight-info.css';

export interface HighlightUsage {
  kind: string;
  id: string;
  title: string;
  /** The sentence or quote that uses the highlight there. */
  context?: string;
  open(): void;
}

const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, ' ').trim();

/** A highlight's comment and passage: with a comment, the comment leads and the passage steps back. */
export function AnnotationText({ text, comment, rgb, renderComment }: { text?: string; comment?: string; rgb?: string; renderComment?: (comment: string) => ReactNode }) {
  const words = oneLine(text ?? '');
  const note = (comment ?? '').trim();
  return (
    <div className={`key-annotation-text${note ? ' has-comment' : ''}`} style={rgb ? ({ '--annotation-color': rgb } as CSSProperties) : undefined}>
      {note && <div className="key-annotation-comment">{renderComment ? renderComment(note) : note}</div>}
      {(words || !note) && <blockquote className="key-annotation-quote" title={words || undefined}>{words || 'Highlight'}</blockquote>}
    </div>
  );
}

const formatDate = (iso?: string) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const COLOR_NAME: Record<string, string> = { orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', pink: 'Pink', purple: 'Purple', red: 'Red' };

export interface HighlightInfoProps {
  text: string;
  comment?: string;
  color: string;
  /** Colour name to "r g b", for the swatches. */
  colors: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
  /** "p. 4"; left out for pages without pages. */
  place?: string;
  usage?: () => Promise<HighlightUsage[]>;
  onColor(color: string): void;
  onComment(): void;
  onCopy(): void;
  onCite?: () => void;
  onDelete(): void;
  renderComment?: (comment: string) => ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function HighlightInfo({ text, comment, color, colors, createdAt, updatedAt, place, usage, onColor, onComment, onCopy, onCite, onDelete, renderComment, className, style }: HighlightInfoProps) {
  const [uses, setUses] = useState<HighlightUsage[] | null | undefined>(usage ? undefined : null);
  useEffect(() => {
    if (!usage) return setUses(null);
    let live = true;
    setUses(undefined);
    usage().then(
      found => live && setUses(found),
      () => live && setUses(null),
    );
    return () => {
      live = false;
    };
  }, [usage]);
  const created = formatDate(createdAt);
  const edited = formatDate(updatedAt);
  return (
    <div
      className={`key-highlight-info${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-label="Highlight"
      style={{ ...style, '--annotation-color': colors[color] } as CSSProperties}
      onPointerDown={event => event.stopPropagation()}
    >
      <div className="key-highlight-info-bar" role="toolbar" aria-label="Annotation actions">
        {Object.entries(colors).map(([name, rgb]) => (
          <button
            key={name}
            type="button"
            className="key-highlight-info-swatch"
            style={{ '--swatch': rgb } as CSSProperties}
            aria-label={`${name} highlight`}
            aria-pressed={color === name}
            title={COLOR_NAME[name] ?? name}
            onClick={() => onColor(name)}
          />
        ))}
        <span className="key-highlight-info-gap" />
        <button type="button" className="key-highlight-info-action" aria-label="Copy selected text" title="Copy" onClick={onCopy}>
          <Icon name="copy" />
        </button>
        {onCite && (
          <button type="button" className="key-highlight-info-action" aria-label="Cite" title="Copy as a quote with its source" onClick={onCite}>
            <Icon name="quote" />
          </button>
        )}
        <button type="button" className="key-highlight-info-action" aria-label={comment ? 'Edit comment' : 'Add comment'} title={comment ? 'Edit comment' : 'Add comment'} onClick={onComment}>
          <Icon name="note" />
        </button>
        <button type="button" className="key-highlight-info-action" data-danger aria-label="Delete annotation" title="Delete highlight" onClick={onDelete}>
          <Icon name="delete" />
        </button>
      </div>
      <div className="key-highlight-info-body">
        <AnnotationText text={text} comment={comment} rgb={colors[color]} renderComment={renderComment} />
        <p className="key-highlight-info-meta">
          {[COLOR_NAME[color] ?? color, place, created && `Created ${created}`, edited && edited !== created ? `Edited ${edited}` : ''].filter(Boolean).join(' · ')}
        </p>
      </div>
      {uses !== null && (
        <section className="key-highlight-info-uses" aria-label="Used in">
          <h4>Used in{uses?.length ? <span>{uses.length}</span> : null}</h4>
          {uses === undefined ? (
            <p className="key-highlight-info-quiet">Looking through notes and canvases…</p>
          ) : uses.length === 0 ? (
            <p className="key-highlight-info-quiet">Not quoted in a note or placed on a canvas yet.</p>
          ) : (
            <ul>
              {uses.map(use => (
                <li key={`${use.kind}:${use.id}`}>
                  <button type="button" onClick={use.open} title={`Open ${use.kind === 'canvas' ? 'the canvas' : use.kind === 'review' ? 'the review at this record and passage' : 'the note'} there`}>
                    <Icon name={use.kind === 'canvas' ? 'split' : use.kind === 'review' ? 'checklist' : 'note'} />
                    <span>
                      <strong>{use.title || 'Untitled'}</strong>
                      {use.context && <small>{oneLine(use.context)}</small>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
