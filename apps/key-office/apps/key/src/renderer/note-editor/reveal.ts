// Finding a passage in a note (a quoted highlight) and bringing it into view, selected.
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

const fold = (c: string) => (/[“”"‘’]/.test(c) ? "" : /\s/.test(c) ? " " : c.toLowerCase());

/** The document's text with one position per character, whitespace runs as one space. */
function flatten(editor: Editor) {
  let flat = "";
  const at: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.isBlock && flat && !flat.endsWith(" ")) {
      flat += " ";
      at.push(pos);
    }
    if (!node.isText) return;
    const text = node.text ?? "";
    for (let i = 0; i < text.length; i++) {
      const c = fold(text[i]);
      if (!c || (c === " " && flat.endsWith(" "))) continue;
      flat += c;
      at.push(pos + i);
    }
  });
  return { flat, at };
}

export function revealText(editor: Editor, text: string) {
  const probe = [...text].map(fold).join("").replace(/ +/g, " ").trim();
  if (!probe) return false;
  const { flat, at } = flatten(editor);
  // The whole passage, else its opening words (the quote may have been trimmed or edited).
  let length = Math.min(probe.length, 160);
  let start = flat.indexOf(probe.slice(0, length));
  if (start < 0 && probe.length > 24) {
    length = 24;
    start = flat.indexOf(probe.slice(0, length));
  }
  if (start < 0) return false;
  const from = at[start];
  const to = (at[Math.min(at.length - 1, start + length - 1)] ?? from) + 1;
  const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, Math.min(to, editor.state.doc.content.size)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  // Centre it: ProseMirror only brings it to the edge.
  requestAnimationFrame(() => {
    const dom = editor.view.domAtPos(from).node;
    (dom instanceof Element ? dom : dom.parentElement)?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  return true;
}
