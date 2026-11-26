// The Bibliography block: the note's reference list, rendered by the citation engine from
// what the note cites, and again when the note's sources or the citation style change.
import { useEffect, useReducer, useState } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import { getRuntime } from "./runtime";
import { CITATION_STYLE_EVENT, citedSources } from "./citations";

export function BibliographyView({ node, editor, selected, updateAttributes }: ReactNodeViewProps) {
  const title = String(node.attrs.title || "References");
  const [ids, setIds] = useState(() => citedSources(editor.state.doc));
  const [entries, setEntries] = useState<{ id: string; html: string }[] | null>(null);
  const [hanging, setHanging] = useState(true);
  const [style, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let timer: number | undefined;
    const onUpdate = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = citedSources(editor.state.doc);
        setIds((now) => (now.join("|") === next.join("|") ? now : next));
      }, 400);
    };
    const onStyle = () => bump();
    editor.on("update", onUpdate);
    window.addEventListener(CITATION_STYLE_EVENT, onStyle);
    return () => {
      window.clearTimeout(timer);
      editor.off("update", onUpdate);
      window.removeEventListener(CITATION_STYLE_EVENT, onStyle);
    };
  }, [editor]);
  useEffect(() => {
    const runtime = getRuntime(editor);
    if (!ids.length || !runtime?.bibliography) {
      setEntries([]);
      return;
    }
    let live = true;
    void runtime
      .bibliography(ids)
      .then((bib) => {
        if (!live) return;
        setEntries(bib?.entries ?? []);
        setHanging(bib?.hangingIndent ?? true);
      })
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [editor, ids, style]);
  return (
    <NodeViewWrapper className={`ne-bibliography${selected ? " is-selected" : ""}`} data-drag-handle="">
      <div contentEditable={false}>
        <input
          className="ne-bibliography-title"
          aria-label="Bibliography heading"
          value={title}
          readOnly={!editor.isEditable}
          onChange={(e) => updateAttributes({ title: e.target.value })}
        />
        {entries === null ? (
          <p className="ne-bibliography-empty">Formatting…</p>
        ) : entries.length ? (
          <div className="ne-bibliography-list" data-hanging={hanging || undefined}>
            {entries.map((entry) => (
              // The engine escapes the text it formats; this is its markup (italics, links).
              <p key={entry.id} data-source={entry.id} dangerouslySetInnerHTML={{ __html: entry.html }} />
            ))}
          </div>
        ) : (
          <p className="ne-bibliography-empty">Cite sources in this note (type @) and they are listed here.</p>
        )}
      </div>
    </NodeViewWrapper>
  );
}
