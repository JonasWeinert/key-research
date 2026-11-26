// The editor component is loaded on first use (LazyNoteEditor); everything else here is light
// and never pulls Tiptap into the importing chunk.
export { default, default as NoteEditor, loadNoteEditor, preloadNoteEditorWhenIdle } from "./LazyNoteEditor";
export { markdownToPlainText } from "./plainText";
export type { NoteCheckIssue, NoteCiteItem, NoteCiteRequest, NoteCiteResult, NoteCiteStyle } from "./types";
export type { DraggedItem, ItemKind, ItemLink, NoteEditorHandle, NoteEditorProps, NoteMediaHost, QuoteInsert, SourceRef } from "./types";
export { CITE_DRAG_TYPE, QUOTE_DRAG_TYPE } from "./types";
export { ITEM_DRAG_TYPE, hasItemDrag, itemFromHref, itemHref, readItemDrag, setItemDrag } from "./types";
export { EmbedDepth, setEmbedRenderer, setMapCenterSearch, type EmbedRenderer, type EmbedView } from "./embeds";
export { editorTargetIn, onEditorTargets, type EditorTarget } from "./targets";
