// Citations in a note follow the citation style. A citation is a link to a source whose text
// is the rendered citation: `[(Doe, 2020, p. 4)](key://source/<id>?cite=<items>)`, where the
// `cite` parameter keeps the cited works with their locators, prefixes, suffixes and whether
// the author is left out (older notes have no parameter; their page anchor is the locator).
// All of a note's citations and its Bibliography block are rendered in one call to the
// engine, so numbering, ibid and disambiguation hold across the note, and again whenever the
// citations, the order or the style change. The reference checker runs after each render.
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { getRuntime } from "./runtime";
import { itemFromHref, SOURCE_HREF_PREFIX } from "./types";
import type { NoteCheckIssue, NoteCiteItem, NoteCiteResult } from "./types";

/** Fired on window when the chosen citation style or language changes. */
export const CITATION_STYLE_EVENT = "key:citation-style-changed";

export interface CitationLink {
  from: number;
  to: number;
  id: string;
  /** 0-based page from the link's anchor. */
  page?: number;
  text: string;
  href: string;
  /** The works cited (the link's `cite` parameter, or its source and page). */
  items: NoteCiteItem[];
  /** Written by the picker (has a `cite` parameter), not only recognised by its text. */
  explicit: boolean;
}

/** "(Palma et al., 2022, p. 4)", "[3]", "[3, p. 4]", "³": text that is a citation, not a title. */
export const looksLikeCitation = (text: string) => {
  const t = text.trim();
  return /^\(.+\)$/.test(t) || /^\[[^\]]{1,40}\]$/.test(t) || /^[\d,–-]{1,12}$/.test(t);
};

const pageOf = (anchor?: string) => (anchor?.startsWith("page:") ? Number(anchor.slice(5)) : undefined);

// ── The `cite` parameter ──────────────────────────────────────────────────────

const encode = (text: string) => encodeURIComponent(text).replace(/[()'!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Only what is set, so plain citations stay short. */
function compact(item: NoteCiteItem): NoteCiteItem {
  const out: NoteCiteItem = { id: item.id };
  for (const key of ["locator", "label", "prefix", "suffix"] as const) {
    const value = item[key]?.trim();
    if (value && !(key === "label" && value === "page")) out[key] = value;
  }
  if (item.suppressAuthor) out.suppressAuthor = true;
  return out;
}

/** The link a citation of these works makes. */
export function citeHref(items: NoteCiteItem[]): string {
  const list = items.filter((i) => i.id).map(compact);
  if (!list.length) throw Error("A citation needs a source");
  return `${SOURCE_HREF_PREFIX}${encodeURIComponent(list[0].id)}?cite=${encode(JSON.stringify(list))}`;
}

/** The works a citation link's `cite` parameter names, if it has one. */
export function citeItemsOf(href: string | null | undefined): NoteCiteItem[] | null {
  const query = href?.split("#")[0].split("?")[1];
  const raw = query?.split("&").find((p) => p.startsWith("cite="))?.slice(5);
  if (!raw) return null;
  try {
    const items = JSON.parse(decodeURIComponent(raw)) as NoteCiteItem[];
    const valid = Array.isArray(items) ? items.filter((i) => i && typeof i.id === "string" && i.id) : [];
    return valid.length ? valid : null;
  } catch {
    return null;
  }
}

// ── Finding citations ─────────────────────────────────────────────────────────

/** Links to sources in document order, adjacent text with the same link joined. */
export function sourceLinks(doc: PMNode): CitationLink[] {
  const out: CitationLink[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const href = node.marks.find((m) => m.type.name === "link")?.attrs.href as string | undefined;
    const item = itemFromHref(href);
    if (!item || item.kind !== "source" || !href) return;
    const last = out[out.length - 1];
    if (last && last.to === pos && last.href === href) {
      last.to = pos + node.nodeSize;
      last.text += node.text ?? "";
      return;
    }
    const page = pageOf(item.anchor);
    const items = citeItemsOf(href);
    out.push({
      from: pos,
      to: pos + node.nodeSize,
      id: item.id,
      page,
      text: node.text ?? "",
      href,
      items: items ?? [{ id: item.id, ...(page !== undefined && page >= 0 ? { locator: String(page + 1) } : {}) }],
      explicit: !!items,
    });
  });
  return out;
}

/** The note's citations, in order: links written as citations, or whose text is one. */
export const noteCitations = (doc: PMNode) => sourceLinks(doc).filter((l) => l.explicit || looksLikeCitation(l.text));

/** The citation at a document position, if any. */
export function citationAt(doc: PMNode, pos: number): CitationLink | undefined {
  return noteCitations(doc).find((c) => pos >= c.from && pos <= c.to);
}

/** Every source the note refers to, in order of first mention (citations, links, quotes, embeds). */
export function citedSources(doc: PMNode): string[] {
  const ids: string[] = [];
  const add = (id?: unknown) => typeof id === "string" && id && !ids.includes(id) && ids.push(id);
  doc.descendants((node) => {
    if (node.type.name === "sourceQuote") add(node.attrs.source);
    else if (node.type.name === "sourceEmbed") add(node.attrs.id);
    else if (node.isText) {
      const href = node.marks.find((m) => m.type.name === "link")?.attrs.href;
      const item = itemFromHref(href);
      if (item?.kind !== "source") return;
      const cited = citeItemsOf(href);
      if (cited) cited.forEach((i) => add(i.id));
      else add(item.id);
    }
  });
  return ids;
}

export function hasBibliography(doc: PMNode) {
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === "noteBibliography") found = true;
    return !found;
  });
  return found;
}

// ── What the last render and check found, per editor ─────────────────────────

export interface CiteState {
  bibliography?: NoteCiteResult["bibliography"];
  style?: NoteCiteResult["style"];
  issues?: NoteCheckIssue[];
  /** The render failed (the engine is unavailable): the block says so. */
  failed?: boolean;
}
const states = new WeakMap<Editor, { state: CiteState; listeners: Set<() => void> }>();
function entry(editor: Editor) {
  let found = states.get(editor);
  if (!found) states.set(editor, (found = { state: {}, listeners: new Set() }));
  return found;
}
export const citeState = (editor: Editor): CiteState => entry(editor).state;
export function subscribeCites(editor: Editor, listener: () => void) {
  const { listeners } = entry(editor);
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
function publish(editor: Editor, patch: Partial<CiteState>) {
  const e = entry(editor);
  e.state = { ...e.state, ...patch };
  e.listeners.forEach((l) => l());
}

const citationKey = (doc: PMNode, style: unknown) =>
  JSON.stringify([noteCitations(doc).map((l) => l.items), citedSources(doc), hasBibliography(doc), style]);

/** Renders the note's citations and reference list again and puts the new text in place. */
export async function refreshCitations(editor: Editor) {
  const runtime = getRuntime(editor);
  if (!runtime?.renderNote || editor.isDestroyed) return;
  const style = runtime.citationStyle();
  const links = noteCitations(editor.state.doc);
  const ids = citedSources(editor.state.doc);
  const bibliography = hasBibliography(editor.state.doc);
  if (!links.length && !(bibliography && ids.length)) {
    publish(editor, { bibliography: bibliography ? { entries: [], hangingIndent: true } : undefined, issues: [], failed: false });
    return;
  }
  const key = citationKey(editor.state.doc, style);
  let out: NoteCiteResult;
  try {
    out = await runtime.renderNote({ ...style, citations: links.map((l) => ({ items: l.items })), ids, bibliography });
  } catch {
    if (!editor.isDestroyed) publish(editor, { failed: true });
    return;
  }
  if (editor.isDestroyed) return;
  publish(editor, { bibliography: out.bibliography, style: out.style, failed: false });
  // The note changed while the engine worked: the next pass picks it up.
  if (citationKey(editor.state.doc, runtime.citationStyle()) !== key) return;
  if (editor.isEditable) {
    const now = noteCitations(editor.state.doc);
    const { tr, schema } = editor.state;
    let changed = false;
    for (let i = now.length - 1; i >= 0; i--) {
      const link = now[i];
      const text = out.citations[i]?.trim();
      if (!text || text === link.text || (!link.explicit && !looksLikeCitation(text))) continue;
      const marks = editor.state.doc.nodeAt(link.from)?.marks ?? [];
      tr.replaceWith(link.from, link.to, schema.text(text, marks));
      changed = true;
    }
    if (changed) editor.view.dispatch(tr.setMeta("addToHistory", false));
  }
  void checkCitations(editor);
}

/** The reference checker over the note as it is now. */
export async function checkCitations(editor: Editor) {
  const runtime = getRuntime(editor);
  if (!runtime?.checkNote || editor.isDestroyed) return;
  const doc = editor.state.doc;
  const citations = noteCitations(doc).map((l) => ({ items: l.items }));
  const listed = hasBibliography(doc) ? (citeState(editor).bibliography?.entries.map((e) => e.id) ?? citedSources(doc)) : undefined;
  if (!citations.length && !listed?.length) return publish(editor, { issues: [] });
  const issues = await runtime.checkNote({ ...runtime.citationStyle(), citations, bibliographyIds: listed }).catch(() => undefined);
  if (issues && !editor.isDestroyed) publish(editor, { issues });
}

// ── Editing ───────────────────────────────────────────────────────────────────

/** Puts a citation of `items` at `range` (the picker's trigger, or the citation edited). */
export function placeCitation(editor: Editor, range: { from: number; to: number }, items: NoteCiteItem[], text?: string) {
  const href = citeHref(items);
  const label = text?.trim() || "(…)";
  const replacing = !!citationAt(editor.state.doc, range.from) && range.to > range.from;
  editor
    .chain()
    .focus()
    .insertContentAt(range, [{ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] }, ...(replacing ? [] : [{ type: "text", text: " " }])])
    .run();
  scheduleRefresh(editor, 30);
}

export function removeCitation(editor: Editor, range: { from: number; to: number }) {
  const { doc } = editor.state;
  // The space left behind goes too.
  const after = doc.textBetween(range.to, Math.min(range.to + 1, doc.content.size));
  const before = range.from > 0 ? doc.textBetween(range.from - 1, range.from) : "";
  const to = after === " " && (before === " " || before === "") ? range.to + 1 : range.to;
  const from = after !== " " && before === " " ? range.from - 1 : range.from;
  editor.chain().focus().deleteRange({ from, to }).run();
}

/** Rewrites citations: each item `fn` returns changed (null drops it). */
export function rewriteCitations(editor: Editor, fn: (item: NoteCiteItem, citation: number, index: number) => NoteCiteItem | null) {
  const links = noteCitations(editor.state.doc);
  const { tr, schema } = editor.state;
  let changed = false;
  for (let c = links.length - 1; c >= 0; c--) {
    const link = links[c];
    const next: NoteCiteItem[] = [];
    link.items.forEach((item, i) => {
      const out = fn(item, c, i);
      if (out && !next.some((n) => n.id === out.id)) next.push(out);
    });
    if (JSON.stringify(next) === JSON.stringify(link.items)) continue;
    changed = true;
    if (!next.length) tr.delete(link.from, link.to);
    else {
      const marks = (editor.state.doc.nodeAt(link.from)?.marks ?? []).filter((m) => m.type.name !== "link");
      tr.replaceWith(link.from, link.to, schema.text(link.text || "(…)", [...marks, schema.marks.link.create({ href: citeHref(next) })]));
    }
  }
  if (changed) editor.view.dispatch(tr);
  scheduleRefresh(editor, 30);
  return changed;
}

const refreshers = new WeakMap<Editor, (force: boolean, delay: number) => void>();
/** Renders again soon (after an edit the picker or a fix made). */
export const scheduleRefresh = (editor: Editor, delay = 50) => refreshers.get(editor)?.(true, delay);

export const CitationRefresh = Extension.create({
  name: "noteCitationRefresh",
  onCreate() {
    const editor = this.editor;
    let timer: number | undefined;
    let last = "";
    const schedule = (force: boolean, delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const key = citationKey(editor.state.doc, getRuntime(editor)?.citationStyle());
        if (!force && key === last) return;
        last = key;
        void refreshCitations(editor);
      }, delay);
    };
    refreshers.set(editor, schedule);
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
  addKeyboardShortcuts() {
    // ⌃⌘C: cite here, or change the citation the cursor is in (⌘⇧C copies a reference app-wide).
    return {
      "Ctrl-Mod-c": () => {
        const runtime = getRuntime(this.editor);
        if (!runtime || !this.editor.isEditable) return false;
        const { from, to } = this.editor.state.selection;
        // A selection stays: the citation goes after it.
        const at = citationAt(this.editor.state.doc, from);
        runtime.pickCitation(at ? { from: at.from, to: at.to } : { from: to, to });
        return true;
      },
    };
  },
  addStorage() {
    return {} as { stop?: () => void };
  },
});
