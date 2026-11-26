// Slash menu items, the @ source picker, and the Suggestion plugins that drive them.
import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { Suggestion } from "@tiptap/suggestion";
import type { SuggestionProps } from "@tiptap/suggestion";
import type { IconName } from "../icons";
import { insertVideo, pickImageFiles } from "./mediaBehaviors";
import { placeCitation } from "./citations";
import { getRuntime } from "./runtime";
import type { PickMode } from "./runtime";
import { mentionLabel, rememberSource, sourceLine } from "./sourceCache";
import { itemHref, refItem } from "./types";
import type { SourceRef } from "./types";

export type SlashGroup = "Basic blocks" | "Lists" | "Research" | "Media";
export const SLASH_GROUPS: readonly SlashGroup[] = ["Basic blocks", "Lists", "Research", "Media"];

export interface SlashItem {
  id: string;
  label: string;
  hint: string;
  group: SlashGroup;
  icon: IconName | { glyph: string } | "warning";
  keywords: string[];
  run: (editor: Editor, range: Range) => void;
}

function clear(editor: Editor, range: Range) {
  return editor.chain().focus().deleteRange(range);
}

/** Types a picker's trigger so it opens: "[[" links, "![[" embeds, "@" cites (or quotes). */
function openPicker(editor: Editor, range: Range, mode: PickMode) {
  const runtime = getRuntime(editor);
  if (runtime && (mode === "quote" || mode === "cite" || mode === "map")) runtime.pickMode = mode;
  clear(editor, range).insertContent(mode === "link" ? "[[" : mode === "embed" ? "![[" : "@").run();
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: "text", label: "Text", hint: "Plain paragraph", group: "Basic blocks", icon: { glyph: "T" }, keywords: ["paragraph", "plain", "p"], run: (e, r) => clear(e, r).setParagraph().run() },
  { id: "h1", label: "Heading 1", hint: "Large section title", group: "Basic blocks", icon: { glyph: "H1" }, keywords: ["title", "#"], run: (e, r) => clear(e, r).setHeading({ level: 1 }).run() },
  { id: "h2", label: "Heading 2", hint: "Medium section title", group: "Basic blocks", icon: { glyph: "H2" }, keywords: ["subtitle", "##"], run: (e, r) => clear(e, r).setHeading({ level: 2 }).run() },
  { id: "h3", label: "Heading 3", hint: "Small section title", group: "Basic blocks", icon: { glyph: "H3" }, keywords: ["###"], run: (e, r) => clear(e, r).setHeading({ level: 3 }).run() },
  { id: "quote", label: "Quote", hint: "Indented quotation", group: "Basic blocks", icon: { glyph: "”" }, keywords: ["blockquote", ">"], run: (e, r) => clear(e, r).setBlockquote().run() },
  { id: "divider", label: "Divider", hint: "Horizontal rule", group: "Basic blocks", icon: { glyph: "—" }, keywords: ["hr", "rule", "line", "---"], run: (e, r) => clear(e, r).setHorizontalRule().run() },
  { id: "code", label: "Code", hint: "Code block with syntax", group: "Basic blocks", icon: { glyph: "</>" }, keywords: ["codeblock", "```", "snippet"], run: (e, r) => clear(e, r).setCodeBlock().run() },
  { id: "table", label: "Table", hint: "Simple grid", group: "Basic blocks", icon: "table", keywords: ["grid", "columns"], run: (e, r) => clear(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: "bullet", label: "Bulleted list", hint: "Simple list", group: "Lists", icon: "list", keywords: ["ul", "unordered", "-"], run: (e, r) => clear(e, r).toggleBulletList().run() },
  { id: "numbered", label: "Numbered list", hint: "Ordered steps", group: "Lists", icon: { glyph: "1." }, keywords: ["ol", "ordered", "1."], run: (e, r) => clear(e, r).toggleOrderedList().run() },
  { id: "todo", label: "To-do list", hint: "Checkboxes to tick off", group: "Lists", icon: "check", keywords: ["task", "checkbox", "[]"], run: (e, r) => clear(e, r).toggleTaskList().run() },
  { id: "callout", label: "Callout", hint: "Highlighted note box", group: "Research", icon: "info", keywords: ["note", "tip", "warning", "admonition", "box"], run: (e, r) => clear(e, r).wrapIn("callout", { tone: "info" }).run() },
  { id: "toggle", label: "Toggle", hint: "Collapsible section", group: "Research", icon: "chevronRight", keywords: ["collapse", "details", "fold"], run: (e, r) => clear(e, r).wrapIn("toggle", { title: "" }).run() },
  { id: "link-source", label: "Link to anything", hint: "Note, source, highlight or canvas, like [[", group: "Research", icon: "link", keywords: ["mention", "reference", "[[", "note", "canvas", "highlight", "backlink"], run: (e, r) => openPicker(e, r, "link") },
  {
    id: "cite-source",
    label: "Cite sources",
    hint: "Citation with pages, prefix and suffix (⌃⌘C); @ cites one quickly",
    group: "Research",
    icon: "quote",
    keywords: ["citation", "cite", "reference", "@", "apa", "page", "locator"],
    run: (e, r) => {
      clear(e, r).run();
      getRuntime(e)?.pickCitation({ from: r.from, to: r.from });
    },
  },
  {
    id: "check-references",
    label: "Check references",
    hint: "Missing, retracted or duplicate sources, gaps in details",
    group: "Research",
    icon: "check",
    keywords: ["citations", "references", "retracted", "duplicates", "bibliography", "checker"],
    run: (e, r) => {
      clear(e, r).run();
      getRuntime(e)?.openCheck();
    },
  },
  { id: "embed-source", label: "Embed anything", hint: "A live note, highlight, canvas or source, like ![[", group: "Research", icon: "books", keywords: ["card", "transclude", "include", "paper", "![["], run: (e, r) => openPicker(e, r, "embed") },
  {
    id: "relation-map",
    label: "Relation map",
    hint: "How a topic, person, journal or tag relates to the rest of the library",
    group: "Research",
    icon: "relations",
    keywords: ["graph", "network", "map", "connections", "topics", "authors"],
    run: (e, r) => openPicker(e, r, "map"),
  },
  { id: "quote-source", label: "Quote from a source", hint: "Quotation with attribution", group: "Research", icon: "quote", keywords: ["citation", "excerpt", "cite"], run: (e, r) => openPicker(e, r, "quote") },
  {
    id: "bibliography",
    label: "Bibliography",
    hint: "The sources this note cites, in your citation style",
    group: "Research",
    icon: "list",
    keywords: ["references", "works cited", "reference list", "citations", "sources"],
    run: (e, r) => clear(e, r).insertContent([{ type: "noteBibliography", attrs: { title: "References" } }, { type: "paragraph" }]).run(),
  },
  {
    id: "image",
    label: "Image",
    hint: "Upload from your Mac",
    group: "Media",
    icon: "image",
    keywords: ["picture", "photo", "img", "upload", "file"],
    run: (e, r) => {
      clear(e, r).run();
      if (getRuntime(e)?.saveImage) pickImageFiles(e);
      else promptImageUrl(e);
    },
  },
  {
    id: "image-url",
    label: "Image from URL",
    hint: "Embed by link",
    group: "Media",
    icon: "link",
    keywords: ["picture", "photo", "img", "url", "web"],
    run: (e, r) => {
      clear(e, r).run();
      promptImageUrl(e);
    },
  },
  {
    id: "video",
    label: "Video",
    hint: "YouTube, Vimeo or a video link",
    group: "Media",
    icon: "video",
    keywords: ["youtube", "vimeo", "embed", "movie", "film"],
    run: (e, r) => {
      clear(e, r).run();
      getRuntime(e)?.promptUrl({
        title: "Video link",
        placeholder: "https://www.youtube.com/watch?v=…",
        submit: (url) => {
          if (!insertVideo(e, url)) e.chain().focus().insertContent(url).run();
        },
      });
    },
  },
];

import { fuzzyScore } from "./fuzzy";
export { fuzzyScore };

export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim();
  if (!q) return items;
  const scored = items
    .map((item) => ({
      item,
      score: Math.max(fuzzyScore(q, item.label), fuzzyScore(q, item.id), ...item.keywords.map((k) => fuzzyScore(q, k) - 50)),
    }))
    .filter((s) => s.score >= 0);
  // keep the group order, best match first inside each group
  return SLASH_GROUPS.flatMap((group) =>
    scored
      .filter((s) => s.item.group === group)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.item),
  );
}

// ── Suggestion plumbing ────────────────────────────────────────────────────

export type MenuKind = "slash" | "source";

export interface MenuState {
  kind: MenuKind;
  items: Array<SlashItem | SourceRef>;
  query: string;
  rect: DOMRect | null;
  mode: PickMode;
  loading: boolean;
  /** The text and meaning sections are still being searched. */
  more?: boolean;
  command: (item: SlashItem | SourceRef) => void;
}

export interface MenuController {
  onOpen(state: MenuState): void;
  onUpdate(state: MenuState): void;
  onKeyDown(event: KeyboardEvent): boolean;
  onClose(): void;
}

function notInCode(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  return !$from.parent.type.spec.code && !editor.isActive("code");
}

export const slashPluginKey = new PluginKey("noteSlash");
export const sourcePluginKey = new PluginKey("noteSourcePicker");
export const linkPluginKey = new PluginKey("noteLinkPicker");
export const embedPluginKey = new PluginKey("noteEmbedPicker");

/** "[[smith]]" typed whole: the closing brackets are not part of the search. */
const cleanQuery = (query: string) => query.replace(/\]\]?$/, "").trim();
/** A citation's page: "smith p. 12" searches "smith" and cites page 12. */
export function splitLocator(query: string, mode: PickMode): { text: string; page?: number } {
  if (mode !== "cite") return { text: query };
  const match = /^(.*?)[\s,]+(?:p{1,2}\.?|page)\s*(\d+)\s*$/i.exec(query);
  return match ? { text: match[1].trim(), page: Number(match[2]) - 1 } : { text: query };
}

export const NoteMenus = Extension.create<{ controller: MenuController | null }>({
  name: "noteMenus",

  addOptions() {
    return { controller: null };
  },

  addProseMirrorPlugins() {
    const controller = () => this.options.controller;
    const editor = this.editor;

    const slashState = (props: SuggestionProps<SlashItem, SlashItem>): MenuState => ({
      kind: "slash",
      items: props.items,
      query: props.query,
      rect: props.clientRect?.() ?? null,
      mode: "link",
      loading: false,
      command: (item) => props.command(item as SlashItem),
    });

    const sourceState = (props: SuggestionProps<SourceRef, SourceRef>, mode: PickMode, items = props.items): MenuState => {
      const runtime = getRuntime(editor);
      return {
        kind: "source",
        items,
        query: props.query,
        rect: props.clientRect?.() ?? null,
        mode,
        loading: runtime?.lastSourceQuery !== props.query,
        more: !!runtime && runtime.moreQuery === props.query && runtime.morePending,
        command: (item) => props.command(item as SourceRef),
      };
    };

    /** A picker opened by `char`; "@" takes the mode the slash menu asked for, else cites. */
    const picker = (char: string, key: PluginKey, fixed?: PickMode) => {
      let last: SuggestionProps<SourceRef, SourceRef> | null = null;
      const modeNow = () => fixed ?? getRuntime(editor)?.pickMode ?? "cite";
      return Suggestion<SourceRef, SourceRef>({
        editor,
        pluginKey: key,
        char,
        allowSpaces: true,
        debounce: 120,
        // "[[" inside "![[" belongs to the embed picker.
        allow: ({ editor: e, range }) => notInCode(e) && !(char === "[[" && e.state.doc.textBetween(Math.max(0, range.from - 1), range.from) === "!"),
        items: async ({ query }) => {
          const runtime = getRuntime(editor);
          if (!runtime) return [];
          const mode = modeNow();
          const { text } = splitLocator(cleanQuery(query), mode);
          try {
            const found = (await runtime.search(text, mode)).slice(0, 12);
            // The text and meaning sections follow when the library search answers.
            runtime.moreQuery = query;
            runtime.morePending = text.length >= 2;
            if (runtime.morePending)
              void runtime
                .searchMore(text, mode)
                .catch(() => [])
                .then((more) => {
                  if (runtime.moreQuery !== query || !last) return;
                  runtime.morePending = false;
                  const seen = new Set(found.map((f) => `${f.itemKind ?? "source"}:${f.id}:${f.anchor ?? ""}`));
                  const extra = more.filter((m) => !seen.has(`${m.itemKind ?? "source"}:${m.id}:${m.anchor ?? ""}`));
                  controller()?.onUpdate(sourceState(last, mode, [...last.items, ...extra]));
                });
            return found;
          } catch {
            return [];
          } finally {
            runtime.lastSourceQuery = query;
          }
        },
        command: ({ editor: e, range, props: ref }) => {
          const runtime = getRuntime(e);
          const mode = modeNow();
          if (runtime) runtime.pickMode = "cite";
          const { page } = splitLocator(cleanQuery(last?.query ?? ""), mode);
          insertSource(e, range, ref, mode, page);
        },
        render: () => ({
          onStart: (props) => {
            last = props;
            controller()?.onOpen(sourceState(props, modeNow()));
          },
          onUpdate: (props) => {
            last = props;
            controller()?.onUpdate(sourceState(props, modeNow()));
          },
          onKeyDown: ({ event }) => (event.key === "Escape" ? false : (controller()?.onKeyDown(event) ?? false)),
          onExit: () => {
            last = null;
            const runtime = getRuntime(editor);
            if (runtime) {
              runtime.pickMode = "cite";
              runtime.lastSourceQuery = null;
              runtime.moreQuery = null;
            }
            controller()?.onClose();
          },
        }),
      });
    };

    return [
      Suggestion<SlashItem, SlashItem>({
        editor,
        pluginKey: slashPluginKey,
        char: "/",
        allow: ({ editor: e }) => notInCode(e),
        items: ({ query }) => filterSlashItems(SLASH_ITEMS, query),
        command: ({ editor: e, range, props }) => props.run(e, range),
        render: () => ({
          onStart: (props) => controller()?.onOpen(slashState(props)),
          onUpdate: (props) => controller()?.onUpdate(slashState(props)),
          onKeyDown: ({ event }) => (event.key === "Escape" ? false : (controller()?.onKeyDown(event) ?? false)),
          onExit: () => controller()?.onClose(),
        }),
      }),
      picker("@", sourcePluginKey),
      picker("[[", linkPluginKey, "link"),
      picker("![[", embedPluginKey, "embed"),
    ];
  },
});

function promptImageUrl(editor: Editor) {
  getRuntime(editor)?.promptUrl({
    title: "Image URL",
    placeholder: "https://…",
    submit: (src) => editor.chain().focus().setImage({ src }).run(),
  });
}

export function insertSource(editor: Editor, range: Range, ref: SourceRef, mode: PickMode, page?: number) {
  const item = refItem(ref);
  const wholeSource = item.kind === "source" && !item.anchor;
  // The cache holds whole sources; a highlight shares its source's id.
  if (wholeSource) rememberSource(ref);
  if (mode === "map") {
    const node = { type: "itemEmbed", attrs: { href: itemHref(item), label: `Relation map of ${ref.title}`, view: "map" } };
    editor.chain().focus().deleteRange(range).insertContent(node).run();
    return;
  }
  if (mode === "embed") {
    const node = wholeSource ? { type: "sourceEmbed", attrs: { id: ref.id, label: sourceLine(ref) } } : { type: "itemEmbed", attrs: { href: itemHref(item), label: ref.title } };
    editor.chain().focus().deleteRange(range).insertContent(node).run();
    return;
  }
  if (mode === "quote") {
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .setNode("sourceQuote", { source: ref.id, page: typeof ref.page === "number" ? ref.page : null })
      .run();
    return;
  }
  // A whole source is cited as the picker cites it: its page is the citation's locator.
  if (mode === "cite" && wholeSource) {
    if (ref.flag) void import("../item-actions").then(({ toast }) => toast(`${ref.title.slice(0, 60)}: ${ref.flag!.toLowerCase()}. Check it before citing.`));
    placeCitation(editor, range, [{ id: ref.id, ...(page !== undefined && page >= 0 ? { locator: String(page + 1) } : {}) }]);
    return;
  }
  // A cited page is part of the link, so it opens there.
  const at = mode === "cite" && wholeSource && page !== undefined ? { ...item, anchor: `page:${page}` } : item;
  const label = mentionLabel(ref);
  const href = itemHref(at);
  // Citing a retracted (or flagged) work: say so once, quietly.
  const flag = ref.flag;
  if (flag && item.kind === "source")
    void import("../item-actions").then(({ toast }) => toast(`${ref.title.slice(0, 60)}: ${flag.toLowerCase()}. Check it before citing.`));
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: "text", text: label, marks: [{ type: "link", attrs: { href } }] },
      { type: "text", text: " " },
    ])
    .run();
  // Sources and highlights are cited "(Palma et al., 2022, p. 4)" once their details load.
  const runtime = getRuntime(editor);
  if (mode !== "cite" || item.kind !== "source" || !runtime) return;
  const from = range.from;
  const anchorPage = page ?? (item.anchor?.startsWith("page:") ? Number(item.anchor.slice(5)) : undefined);
  void runtime.cite(ref, anchorPage).then((cite) => {
    if (!cite || editor.isDestroyed) return;
    const to = from + label.length;
    if (editor.state.doc.textBetween(from, Math.min(to, editor.state.doc.content.size)) !== label) return;
    const text = item.anchor?.startsWith("highlight:") && ref.title ? `“${ref.title}” ${cite}` : cite;
    editor
      .chain()
      // The cursor stays where the writer is (mapped past the longer label), not at the link's end.
      .insertContentAt({ from, to }, [{ type: "text", text, marks: [{ type: "link", attrs: { href } }] }], { updateSelection: false })
      .run();
  });
}
