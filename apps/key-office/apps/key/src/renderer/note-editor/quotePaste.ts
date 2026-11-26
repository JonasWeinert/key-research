// Pasting a quote copied with "Cite" in the PDF reader: it becomes a source quote that links
// back to its page, not plain text. Anything else pastes as before.
import { Extension } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { quoteBody, readQuote, type QuotePayload } from "../quote-clipboard";

/** The source quote node for a pasted quote; null when the quote does not name a source. */
export function sourceQuoteNode(schema: Schema, quote: QuotePayload): PMNode | null {
  const type = schema.nodes.sourceQuote;
  const text = quoteBody(quote.text);
  if (!type || !quote.sourceId || !text) return null;
  return type.create({ source: quote.sourceId, page: quote.page >= 0 ? quote.page : null, color: quote.color ?? null }, schema.text(text));
}

/** Puts the quote where the cursor is: in place of an empty paragraph, else after the block. */
export function insertQuote(view: EditorView, quote: QuotePayload): boolean {
  const node = sourceQuoteNode(view.state.schema, quote);
  if (!node) return false;
  const { $from } = view.state.selection;
  let tr = view.state.tr;
  if ($from.parent.isTextblock && $from.parent.content.size === 0 && $from.depth > 0) {
    tr = tr.replaceWith($from.before(), $from.after(), node);
  } else {
    tr = tr.replaceSelectionWith(node);
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

export const QuotePaste = Extension.create({
  name: "quotePaste",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("quotePaste"),
        props: {
          handlePaste: (view, event) => {
            const quote = readQuote(event.clipboardData);
            return quote ? insertQuote(view, quote) : false;
          },
        },
      }),
    ];
  },
});
