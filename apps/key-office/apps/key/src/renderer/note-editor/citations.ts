// Citations in a note follow the citation style: the in-text citations (links to sources
// whose text is a citation) are rendered together by the engine, so numbering and
// disambiguation hold across the note, and again when the order or the style changes.
// The Bibliography block lists what the note cites (see nodeViews' BibliographyView).
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { getRuntime } from "./runtime";
import { itemFromHref } from "./types";

/** Fired on window when the chosen citation style or language changes. */
export const CITATION_STYLE_EVENT = "key:citation-style-changed";

export interface CitationLink {
  from: number;
  to: number;
  id: string;
  /** 0-based page from the link's anchor. */
  page?: number;
  text: string;
}

/** "(Palma et al., 2022, p. 4)", "[3]", "[3, p. 4]", "³": text that is a citation, not a title. */
export const looksLikeCitation = (text: string) => {
  const t = text.trim();
  return /^\(.+\)$/.test(t) || /^\[[^\]]{1,40}\]$/.test(t) || /^[\d,–-]{1,12}$/.test(t);
};

const pageOf = (anchor?: string) => (anchor?.startsWith("page:") ? Number(anchor.slice(5)) : undefined);

/** Links to sources in document order, adjacent text with the same link joined. */
export function sourceLinks(doc: PMNode): CitationLink[] {
  const out: CitationLink[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const link = node.marks.find((m) => m.type.name === "link");
    const item = itemFromHref(link?.attrs.href);
    if (!item || item.kind !== "source") return;
    const last = out[out.length - 1];
    if (last && last.to === pos && last.id === item.id && last.page === pageOf(item.anchor)) {
      last.to = pos + node.nodeSize;
      last.text += node.text ?? "";
      return;
    }
    out.push({ from: pos, to: pos + node.nodeSize, id: item.id, page: pageOf(item.anchor), text: node.text ?? "" });
  });
  return out;
}

/** Every source the note refers to, in order of first mention (links, quotes, embeds). */
export function citedSources(doc: PMNode): string[] {
  const ids: string[] = [];
  const add = (id?: unknown) => typeof id === "string" && id && !ids.includes(id) && ids.push(id);
  doc.descendants((node) => {
    if (node.type.name === "sourceQuote") add(node.attrs.source);
    else if (node.type.name === "sourceEmbed") add(node.attrs.id);
    else if (node.isText) {
      const item = itemFromHref(node.marks.find((m) => m.type.name === "link")?.attrs.href);
      if (item?.kind === "source") add(item.id);
    }
  });
  return ids;
}

const citationKey = (links: CitationLink[]) => links.map((l) => `${l.id}@${l.page ?? ""}`).join("|");

/** Renders the note's citations again and puts the new text in place where it changed. */
export async function refreshCitations(editor: Editor) {
  const runtime = getRuntime(editor);
  if (!runtime?.citeMany || !editor.isEditable || editor.isDestroyed) return;
  const links = sourceLinks(editor.state.doc).filter((l) => looksLikeCitation(l.text));
  if (!links.length) return;
  const key = citationKey(links);
  const texts = await runtime.citeMany(links.map((l) => ({ id: l.id, page: l.page }))).catch(() => undefined);
  if (!texts || editor.isDestroyed) return;
  // The note changed while the engine worked: the next pass picks it up.
  const now = sourceLinks(editor.state.doc).filter((l) => looksLikeCitation(l.text));
  if (citationKey(now) !== key) return;
  const { tr, schema } = editor.state;
  let changed = false;
  for (let i = now.length - 1; i >= 0; i--) {
    const link = now[i];
    const text = texts[i]?.trim();
    if (!text || text === link.text || !looksLikeCitation(text)) continue;
    const marks = editor.state.doc.nodeAt(link.from)?.marks ?? [];
    tr.replaceWith(link.from, link.to, schema.text(text, marks));
    changed = true;
  }
  if (changed) editor.view.dispatch(tr.setMeta("addToHistory", false));
}

export const CitationRefresh = Extension.create({
  name: "noteCitationRefresh",
  onCreate() {
    const editor = this.editor;
    let timer: number | undefined;
    let last = "";
    const schedule = (force: boolean, delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const key = citationKey(sourceLinks(editor.state.doc).filter((l) => looksLikeCitation(l.text)));
        if (!force && key === last) return;
        last = key;
        void refreshCitations(editor);
      }, delay);
    };
    const onStyle = () => schedule(true, 50);
    const onUpdate = () => schedule(false, 1200);
    window.addEventListener(CITATION_STYLE_EVENT, onStyle);
    editor.on("update", onUpdate);
    schedule(true, 300);
    (this.storage as { stop?: () => void }).stop = () => {
      window.clearTimeout(timer);
      window.removeEventListener(CITATION_STYLE_EVENT, onStyle);
      editor.off("update", onUpdate);
    };
  },
  onDestroy() {
    (this.storage as { stop?: () => void }).stop?.();
  },
  addStorage() {
    return {} as { stop?: () => void };
  },
});
