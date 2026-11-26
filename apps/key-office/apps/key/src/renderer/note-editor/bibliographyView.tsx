// The Bibliography block: the note's reference list, rendered by the citation engine in the
// same call as the note's citations (citations.ts), in the note's own style when it has one.
// Its header picks that style and shows what the reference checker found.
import { useEffect, useReducer, useState } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import { Icon } from "../icons";
import { getRuntime } from "./runtime";
import { citeState, scheduleRefresh, subscribeCites } from "./citations";

type StyleList = Awaited<ReturnType<NonNullable<NonNullable<ReturnType<typeof getRuntime>>["listStyles"]>>>;

export function BibliographyView({ node, editor, selected, updateAttributes }: ReactNodeViewProps) {
  const title = String(node.attrs.title || "References");
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const stop = subscribeCites(editor, bump);
    // A block just inserted: render now rather than after the typing pause.
    scheduleRefresh(editor, 60);
    return stop;
  }, [editor]);
  const runtime = getRuntime(editor);
  const state = citeState(editor);
  const entries = state.bibliography?.entries;
  const issues = state.issues ?? [];
  const flagged = new Map<string, string>();
  for (const issue of issues) if (issue.sourceId && issue.severity !== "info" && !flagged.has(issue.sourceId)) flagged.set(issue.sourceId, issue.message);
  const [styles, setStyles] = useState<StyleList>();
  const own = runtime?.citationStyle() ?? {};
  const canChoose = !!runtime?.setCitationStyle && !!runtime.listStyles && editor.isEditable;
  useEffect(() => {
    if (canChoose) void runtime!.listStyles!().then(setStyles).catch(() => undefined);
  }, [canChoose]);
  const styleName = state.style?.shortTitle || state.style?.title;
  return (
    <NodeViewWrapper className={`ne-bibliography${selected ? " is-selected" : ""}`} data-drag-handle="">
      <div contentEditable={false}>
        <div className="ne-bibliography-head">
          <input
            className="ne-bibliography-title"
            aria-label="Bibliography heading"
            value={title}
            readOnly={!editor.isEditable}
            onChange={(e) => updateAttributes({ title: e.target.value })}
          />
          {issues.length > 0 && editor.isEditable && (
            <button type="button" className="ne-bibliography-issues" onClick={() => runtime?.openCheck()} title="Check references">
              <Icon name="warning" size={12} />
              {issues.length === 1 ? "1 issue" : `${issues.length} issues`}
            </button>
          )}
          {canChoose && styles ? (
            <select
              className="ne-bibliography-style"
              aria-label="Citation style for this note"
              data-own={own.style ? "" : undefined}
              title="Citation style for this note"
              value={own.style ?? ""}
              onChange={(e) => {
                runtime!.setCitationStyle!({ ...own, style: e.target.value || undefined });
                scheduleRefresh(editor, 20);
              }}
            >
              <option value="">Settings ({styles.styles.find((s) => s.id === styles.style)?.title ?? styles.style})</option>
              {styles.styles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          ) : (
            styleName && <span className="ne-bibliography-stylename">{styleName}</span>
          )}
          {canChoose && styles && (
            <select
              className="ne-bibliography-style ne-bibliography-locale"
              aria-label="Citation language for this note"
              data-own={own.locale ? "" : undefined}
              title="Citation language for this note"
              value={own.locale ?? ""}
              onChange={(e) => {
                runtime!.setCitationStyle!({ ...own, locale: e.target.value || undefined });
                scheduleRefresh(editor, 20);
              }}
            >
              <option value="">Default language</option>
              {styles.locales.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {state.failed ? (
          <p className="ne-bibliography-empty">The reference list couldn’t be formatted.</p>
        ) : entries === undefined ? (
          <p className="ne-bibliography-empty">Formatting…</p>
        ) : entries.length ? (
          <div className="ne-bibliography-list" data-hanging={state.bibliography?.hangingIndent || undefined}>
            {entries.map((entry) => (
              <p key={entry.id} data-source={entry.id} data-flagged={flagged.has(entry.id) || undefined} title={flagged.get(entry.id)}>
                {/* The engine escapes the text it formats; this is its markup (italics, links). */}
                <span dangerouslySetInnerHTML={{ __html: entry.html }} />
                {flagged.has(entry.id) && (
                  <span className="ne-bibliography-flag" aria-label={flagged.get(entry.id)}>
                    <Icon name="warning" size={11} />
                  </span>
                )}
              </p>
            ))}
          </div>
        ) : (
          <p className="ne-bibliography-empty">Cite sources in this note (type @ or ⌃⌘C) and they are listed here.</p>
        )}
      </div>
    </NodeViewWrapper>
  );
}
