// Putting references in from outside the text: the library panel inserts at the cursor
// (citations and links inline, passages as quote blocks) and its rows drop in where they land.
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { insertSource } from "./menus";
import { insertDroppedItems } from "./mediaBehaviors";
import { readItemDrag, type QuoteInsert, type SourceRef } from "./types";

/** Marks an item drag whose sources should land as citations (the library panel's rows). */
export const CITE_DRAG_TYPE = "application/x-key-cite";
/** A passage dragged out of the library panel, as JSON `QuoteInsert`. */
export const QUOTE_DRAG_TYPE = "application/x-key-quote";

/** A citation or link at the selection, spaced off the word before it. */
export function insertReferenceAt(editor: Editor, ref: SourceRef, mode: "cite" | "link") {
  let { from, to } = editor.state.selection;
  const before = from > 1 ? editor.state.doc.textBetween(from - 1, from, "\n", "\n") : "";
  if (before && !/\s/.test(before)) {
    editor.chain().insertContentAt({ from, to }, " ").run();
    from += 1;
    to = from;
  }
  insertSource(editor, { from, to }, ref, mode);
}

/** A quote block with its source: in place of an empty paragraph, else after the block at
 *  `pos` (the selection by default), with an empty paragraph after it to keep writing in. */
export function insertQuoteAt(editor: Editor, quote: QuoteInsert, pos?: number) {
  const { doc } = editor.state;
  const $at = doc.resolve(Math.min(pos ?? editor.state.selection.from, doc.content.size));
  const node = {
    type: "sourceQuote",
    attrs: { source: quote.source, page: quote.page ?? null, color: quote.color ?? null },
    ...(quote.text.trim() ? { content: [{ type: "text", text: quote.text.trim() }] } : {}),
  };
  const empty = $at.depth >= 1 && $at.parent.type.name === "paragraph" && $at.parent.content.size === 0;
  const at = empty ? { from: $at.before(), to: $at.after() } : $at.depth >= 1 ? $at.after(1) : $at.pos;
  return editor.chain().focus().insertContentAt(at, [node, { type: "paragraph" }]).run();
}

/** The library panel's drags: rows land as citations, passages as quotes. Runs before the
 *  general item drop, which would make plain links of them. */
export const LibraryDrop = Extension.create({
  name: "noteLibraryDrop",
  priority: 1100,
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("noteLibraryDrop"),
        props: {
          handleDrop: (view, event, _slice, moved) => {
            const data = event.dataTransfer;
            if (moved || !data) return false;
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
            if (data.types.includes(QUOTE_DRAG_TYPE)) {
              try {
                const quote = JSON.parse(data.getData(QUOTE_DRAG_TYPE)) as QuoteInsert;
                if (!quote?.source) return false;
                event.preventDefault();
                insertQuoteAt(editor, quote, at);
                return true;
              } catch {
                return false;
              }
            }
            if (data.types.includes(CITE_DRAG_TYPE) && !event.altKey) {
              const items = readItemDrag(data);
              if (!items.length) return false;
              event.preventDefault();
              void insertDroppedItems(editor, items, at, "cite", false);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});
