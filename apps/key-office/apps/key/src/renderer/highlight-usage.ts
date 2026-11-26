// Where a highlight is used: notes that quote or link it, canvases that hold it. The host
// answers it (key-store `highlight_uses`, from the links notes and canvases write and the
// source's own notes, searched for the highlight's link or its words).
import type { Invoke } from "./library-api";

export interface HighlightUse {
  kind: "note" | "canvas" | string;
  id: string;
  title: string;
  context?: string;
}

export function highlightUsage(invoke: Invoke, workspaceId: string, sourceId: string, highlight: { id: string; text: string }): Promise<HighlightUse[]> {
  return invoke<HighlightUse[]>("store_highlight_uses", { sourceId, highlightId: highlight.id }, workspaceId);
}
