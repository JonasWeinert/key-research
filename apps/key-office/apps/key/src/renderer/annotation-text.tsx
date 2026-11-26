// A highlight's words and its comment, wherever highlights are listed. With a comment, the
// comment is what the reader wrote and leads; the passage follows smaller and quieter.
// Without one, the passage is the highlight and stays primary.
import type { CSSProperties } from "react";
import "./annotation-text.css";

const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, " ").trim();

export function AnnotationText({
  text,
  comment,
  color,
  marked,
  className,
}: {
  text?: string | null;
  comment?: string | null;
  /** The highlight's colour (any CSS colour) for the quote's rule. */
  color?: string;
  /** Draws the words marked in the highlight's colour (`--kx-hl` on an ancestor). */
  marked?: boolean;
  className?: string;
}) {
  const words = oneLine(text ?? "");
  const note = (comment ?? "").trim();
  return (
    <div
      className={`kx-annotation${note ? " has-comment" : ""}${className ? ` ${className}` : ""}`}
      style={color ? ({ "--kx-annotation-color": color } as CSSProperties) : undefined}
    >
      {note && <p className="kx-annotation-comment">{note}</p>}
      {(words || !note) && (
        <blockquote className="kx-annotation-quote" title={words || undefined}>
          {marked && words ? <mark>{words}</mark> : words || "Highlight"}
        </blockquote>
      )}
    </div>
  );
}
