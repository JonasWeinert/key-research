// "Check references": what the reference checker found in the note, each issue with a way to
// the citation it is about and, where it is safe, a fix in one click.
import { useEffect, useReducer, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useDismiss } from "@key-reader/ui/dismiss";
import { Icon } from "../icons";
import { usePopoverPosition } from "./SuggestionMenu";
import { checkCitations, citeState, noteCitations, rewriteCitations, scheduleRefresh, subscribeCites } from "./citations";
import { getRuntime } from "./runtime";
import type { NoteCheckFix, NoteCheckIssue } from "./types";

/** Selects the citation and brings it into view. */
export function showCitation(editor: Editor, index: number) {
  const citation = noteCitations(editor.state.doc)[index];
  if (!citation) return;
  editor.chain().focus().setTextSelection({ from: citation.from, to: citation.to }).scrollIntoView().run();
}

export function applyFix(editor: Editor, fix: NoteCheckFix) {
  const runtime = getRuntime(editor);
  switch (fix.action) {
    case "replace":
      rewriteCitations(editor, (item) => (item.id === fix.from ? { ...item, id: fix.to } : item));
      break;
    case "locator":
      rewriteCitations(editor, (item, c, i) => (c === fix.citation && i === fix.item ? { ...item, locator: fix.locator, label: fix.locatorLabel } : item));
      break;
    case "insertBibliography":
      editor
        .chain()
        .insertContentAt(editor.state.doc.content.size, [{ type: "noteBibliography", attrs: { title: "References" } }, { type: "paragraph" }])
        .run();
      scheduleRefresh(editor);
      break;
    case "restore":
      void runtime?.restoreSource?.(fix.id).then(() => scheduleRefresh(editor));
      break;
  }
}

const SEVERITY_LABEL = { error: "Problem", warning: "Warning", info: "Note" } as const;

export function CheckPanel({ editor, rect, onClose }: { editor: Editor; rect: DOMRect | null; onClose: () => void }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [checking, setChecking] = useState(true);
  useEffect(() => subscribeCites(editor, bump), [editor]);
  useEffect(() => {
    void checkCitations(editor).finally(() => setChecking(false));
  }, [editor]);
  const issues: NoteCheckIssue[] = citeState(editor).issues ?? [];
  const { ref, style } = usePopoverPosition(rect, [issues.length, checking]);
  useDismiss(true, { refs: [ref], scroll: false, onDismiss: onClose });
  const canFix = (fix: NoteCheckFix) => fix.action !== "restore" || !!getRuntime(editor)?.restoreSource;
  return (
    <div ref={ref} className="ne-popover ne-check-panel" style={style} role="dialog" aria-label="Check references">
      <div className="ne-menu-heading">Check references</div>
      {issues.length === 0 ? (
        <div className="ne-check-clean">
          {checking ? (
            "Checking…"
          ) : (
            <>
              <Icon name="check" size={14} /> No problems found
            </>
          )}
        </div>
      ) : (
        <ul className="ne-check-list">
          {issues.map((issue, i) => (
            <li key={`${issue.kind}-${issue.sourceId ?? ""}-${i}`} className="ne-check-issue" data-severity={issue.severity}>
              <span className="ne-check-icon" title={SEVERITY_LABEL[issue.severity]}>
                <Icon name={issue.severity === "info" ? "info" : "warning"} size={13} />
              </span>
              <span className="ne-check-text">
                <span className="ne-check-message">{issue.message}</span>
                <span className="ne-check-actions">
                  {issue.citations.length > 0 && (
                    <button type="button" onClick={() => showCitation(editor, issue.citations[0])}>
                      {issue.citations.length > 1 ? `Show (${issue.citations.length})` : "Show"}
                    </button>
                  )}
                  {issue.fix && canFix(issue.fix) && (
                    <button type="button" className="ne-check-fix" onClick={() => applyFix(editor, issue.fix!)}>
                      {issue.fix.label}
                    </button>
                  )}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
