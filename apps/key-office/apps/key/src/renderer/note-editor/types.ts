import type { Ref } from "react";

/** What a link can point at. Highlights and pages are a source with an anchor; `file` is a
 * file in a linked folder. */
export type ItemKind = "source" | "note" | "canvas" | "record" | "file" | "person" | "venue" | "topic" | "tag";
export const ITEM_KINDS: readonly ItemKind[] = ["source", "note", "canvas", "record", "file", "person", "venue", "topic", "tag"];

export interface ItemLink {
  kind: ItemKind;
  id: string;
  /** A place inside the item: `page:3`, `highlight:<id>`, `heading:<slug>`, `node:<id>`. */
  anchor?: string;
}

export interface SourceRef {
  id: string;
  title: string;
  detail?: string;
  /** For a source, its kind (pdf, web, book …), used for the icon. */
  kind?: string;
  page?: number;
  /** Set when the picker offers something other than a whole source. */
  itemKind?: ItemKind;
  anchor?: string;
  /** A highlight's colour. */
  color?: string;
  /** "Retracted", "Withdrawn" or "Expression of concern": cited with a warning. */
  flag?: string;
  /** Which search section it came from: titles and details, the text, or related by meaning. */
  group?: "titles" | "text" | "meaning";
  /** Where it matched ("p. 4", "Abstract") and the passage, with `[[match]]` markers. */
  where?: string;
  snippet?: string;
}

/** Where a note's images live: the workspace stores files and shows them back. */
export interface NoteMediaHost {
  /** Stores an image file in the workspace; answers the `media/…` path the note keeps. */
  save(file: File): Promise<string>;
  /** A URL the editor can load for a stored path (other URLs pass through). */
  url(src: string): string;
}

/** A passage quoted from a source, with the page it is on and a highlight's colour. */
export interface QuoteInsert {
  source: string;
  page?: number | null;
  color?: string | null;
  text: string;
}

/** What a host can do with a mounted editor (the note's library panel). */
export interface NoteEditorHandle {
  /** A citation (sources and highlights) or a link at the cursor, or where it last was. */
  insertReference(ref: SourceRef, mode: "cite" | "link"): void;
  /** A quote block after the cursor's block (or in place of an empty line). */
  insertQuote(quote: QuoteInsert): void;
  focus(): void;
  /** Scrolls to the first place the words `text` appear and selects them; false when absent. */
  reveal(text: string): boolean;
}

/** One cited work in a citation: where in it, and the words around it. */
export interface NoteCiteItem {
  id: string;
  /** "12", "12–14" */
  locator?: string;
  /** page (default), chapter, section, paragraph, figure, … */
  label?: string;
  prefix?: string;
  suffix?: string;
  /** "(2021)": the author is named in the sentence. */
  suppressAuthor?: boolean;
}
export interface NoteCiteStyle {
  style?: string;
  locale?: string;
}
export interface NoteCiteRequest extends NoteCiteStyle {
  citations: { items: NoteCiteItem[] }[];
  /** Listed in the reference list as well (quoted or embedded sources). */
  ids: string[];
  bibliography: boolean;
}
export interface NoteCiteResult {
  citations: string[];
  bibliography?: { entries: { id: string; html: string; text: string }[]; hangingIndent: boolean };
  /** The style used, for the Bibliography block's header. */
  style?: { id: string; title: string; shortTitle?: string; class?: string };
}
export interface NoteCheckRequest extends NoteCiteStyle {
  citations: { items: NoteCiteItem[] }[];
  /** What the Bibliography block lists; absent when the note has none. */
  bibliographyIds?: string[];
}
export type NoteCheckFix =
  | { action: "replace"; from: string; to: string; label: string }
  | { action: "locator"; citation: number; item: number; locator: string; locatorLabel: string; label: string }
  | { action: "insertBibliography"; label: string }
  | { action: "restore"; id: string; label: string };
export interface NoteCheckIssue {
  kind: string;
  severity: "error" | "warning" | "info";
  message: string;
  sourceId?: string;
  citations: number[];
  fix?: NoteCheckFix;
}

export interface NoteEditorProps {
  /** Markdown (GFM plus the note fences). */
  value: string;
  /** Called debounced (~400 ms) and on blur/unmount when there are unsaved edits. */
  onChange: (markdown: string) => void;
  searchSources: (query: string) => Promise<SourceRef[]>;
  /** Used by source cards, source quotes and mention chips. */
  resolveSource: (id: string) => Promise<SourceRef | undefined>;
  /** `quote`: a quoted passage to find and centre on that page. */
  onOpenSource: (id: string, page?: number, annotationId?: string, quote?: string) => void;
  /** Without it, images can only be linked by URL. */
  media?: NoteMediaHost;
  /** The @ picker in link mode: any item (notes, highlights, canvases …). Falls back to searchSources. */
  searchItems?: (query: string) => Promise<SourceRef[]>;
  /** Opens a link to something other than a whole source. */
  onOpenItem?: (item: ItemLink) => void;
  /** The picker's slower sections (matches in the text and by meaning), after `searchItems`. */
  searchItemsMore?: (query: string) => Promise<SourceRef[]>;
  /** The "Relation map" block's picker: people, journals, topics and tags to centre a map on. */
  searchMapCenters?: (query: string) => Promise<SourceRef[]>;
  /** An in-text citation for a picked source or highlight, e.g. "(Palma et al., 2022, p. 4)". */
  citeLabel?: (ref: SourceRef, page?: number) => Promise<string | undefined>;
  /** All of a note's citations at once, so numbering and disambiguation hold (`page` 0-based). */
  formatCitations?: (cites: { id: string; page?: number }[]) => Promise<string[]>;
  /** The Bibliography block's entries for these sources. */
  formatBibliography?: (ids: string[]) => Promise<{ entries: { id: string; html: string; text: string }[]; hangingIndent: boolean } | undefined>;
  /** The note's citations and reference list in one call, in the note's style (one batch:
   *  numbering, ibid and disambiguation hold). Preferred over formatCitations/formatBibliography. */
  renderCitations?: (request: NoteCiteRequest) => Promise<NoteCiteResult>;
  /** The reference checker over the note's citations. */
  checkCitations?: (request: NoteCheckRequest) => Promise<NoteCheckIssue[]>;
  /** The note's own citation style and language (empty: Settings › Citations). */
  citationStyle?: NoteCiteStyle;
  /** Saves the note's own style; omitted where the note has no page to keep it on. */
  onCitationStyle?: (style: NoteCiteStyle) => void;
  /** Styles and languages to choose from. */
  listCitationStyles?: () => Promise<{ styles: { id: string; title: string; shortTitle?: string }[]; locales: { code: string; name: string }[]; style: string; locale?: string }>;
  /** Takes a source out of the trash (a checker fix). */
  restoreSource?: (id: string) => Promise<void>;
  placeholder?: string;
  autoFocus?: boolean;
  /** Shows the note without editing it (a canvas card); links and media still work. */
  readOnly?: boolean;
  /** Narrow inspector panel: smaller type, gutter tucked closer. */
  compact?: boolean;
  className?: string;
  /** Receives the editor's handle once it is mounted. */
  apiRef?: Ref<NoteEditorHandle>;
}

export type CalloutTone = "info" | "tip" | "warning" | "note";
export const CALLOUT_TONES: readonly CalloutTone[] = ["info", "tip", "warning", "note"];

export const SOURCE_HREF_PREFIX = "key://source/";

export function sourceIdFromHref(href: string | null | undefined): string | null {
  if (!href || !href.startsWith(SOURCE_HREF_PREFIX)) return null;
  const id = decodeURIComponent(href.slice(SOURCE_HREF_PREFIX.length).replace(/[?#].*$/, ""));
  return id || null;
}

export function sourceHref(id: string): string {
  return SOURCE_HREF_PREFIX + encodeURIComponent(id);
}

export const ITEM_HREF_PREFIX = "key://";

/** `key://note/<id>`, `key://source/<id>#page:3`. */
export function itemHref(item: ItemLink): string {
  return `${ITEM_HREF_PREFIX}${item.kind}/${encodeURIComponent(item.id)}${item.anchor ? `#${encodeURIComponent(item.anchor)}` : ""}`;
}

/** A citation's page ("p. 3", "3–5") as the anchor it opens at: its first work's locator. */
function citedPageAnchor(href: string): string | undefined {
  const raw = href.split("#")[0].split("?")[1]?.split("&").find((p) => p.startsWith("cite="))?.slice(5);
  if (!raw) return undefined;
  try {
    const first = (JSON.parse(decodeURIComponent(raw)) as { locator?: unknown; label?: unknown }[])?.[0];
    if (!first || (first.label && first.label !== "page")) return undefined;
    const page = /^\s*(\d+)/.exec(String(first.locator ?? ""))?.[1];
    return page && Number(page) > 0 ? `page:${Number(page) - 1}` : undefined;
  } catch {
    return undefined;
  }
}

export function itemFromHref(href: string | null | undefined): ItemLink | null {
  if (!href || !href.startsWith(ITEM_HREF_PREFIX)) return null;
  // `?page=3` from older notes; `?cite=…` on citations (see citations.ts).
  const match = /^([a-z]+)\/([^?#]+)(?:\?(?:page=(\d+)|[^#]*))?(?:#(.+))?$/.exec(href.slice(ITEM_HREF_PREFIX.length));
  if (!match || !(ITEM_KINDS as readonly string[]).includes(match[1])) return null;
  const anchor = match[4] ? decodeURIComponent(match[4]) : match[3] ? `page:${match[3]}` : match[1] === "source" ? citedPageAnchor(href) : undefined;
  return { kind: match[1] as ItemKind, id: decodeURIComponent(match[2]), ...(anchor ? { anchor } : {}) };
}

// Items dragged anywhere in the app (library rows, the sidebar, canvas cards) carry this
// type; a canvas places them as cards and a note links them where they land.
export const ITEM_DRAG_TYPE = "application/x-key-items";
/** Marks an item drag whose sources should land as citations (the library panel's rows). */
export const CITE_DRAG_TYPE = "application/x-key-cite";
/** A passage dragged out of the library panel, as JSON `QuoteInsert`. */
export const QUOTE_DRAG_TYPE = "application/x-key-quote";

export interface DraggedItem extends ItemLink {
  title: string;
  /** A source's kind, or a highlight's text. */
  detail?: string;
  color?: string;
}

/** "3 sources", "a note and 2 highlights", for the badge a drag of several items shows. */
function countLabel(items: DraggedItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const kind = item.anchor?.startsWith("highlight:") ? "highlight" : item.kind === "record" ? "page" : item.kind;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
}

export function setItemDrag(data: DataTransfer, items: DraggedItem[]) {
  if (!items.length) return;
  if (items.length > 1 && typeof document !== "undefined") {
    const badge = document.createElement("div");
    badge.className = "kx-drag-badge";
    badge.textContent = countLabel(items);
    document.body.append(badge);
    data.setDragImage(badge, -10, -10);
    setTimeout(() => badge.remove());
  }
  data.setData(ITEM_DRAG_TYPE, JSON.stringify(items));
  data.setData("text/uri-list", items.map(itemHref).join("\r\n"));
  data.setData("text/plain", items.map((item) => item.title || "Untitled").join("\n"));
}

export const hasItemDrag = (data: DataTransfer | null | undefined) => !!data?.types.includes(ITEM_DRAG_TYPE);

export function readItemDrag(data: DataTransfer | null | undefined): DraggedItem[] {
  try {
    const items = JSON.parse(data?.getData(ITEM_DRAG_TYPE) || "[]") as DraggedItem[];
    return Array.isArray(items) ? items.filter((i) => i && (ITEM_KINDS as readonly string[]).includes(i.kind) && typeof i.id === "string") : [];
  } catch {
    return [];
  }
}

/** The link a picked entry makes. */
export function refItem(ref: SourceRef): ItemLink {
  return { kind: ref.itemKind ?? "source", id: ref.id, ...(ref.anchor ? { anchor: ref.anchor } : {}) };
}
