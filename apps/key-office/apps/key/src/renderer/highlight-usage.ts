// Where a highlight is used: notes that quote or link it, canvases that hold it. Read from
// the links notes and canvases already write (`store_links`), plus the source's own notes,
// which the link list leaves out, searched for the highlight's link or its words.
import { itemLinks } from "./item-links";
import type { Invoke, Note } from "./library-api";
import { markdownToPlainText } from "./note-editor/plainText";

export interface HighlightUse {
  kind: "note" | "canvas" | string;
  id: string;
  title: string;
  context?: string;
}

const norm = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
/** The first words of a passage: enough to recognise a quote of it, short enough to survive edits. */
const probeOf = (text: string) => {
  const words = norm(text).replace(/[“”"‘’]/g, "");
  return words.length >= 12 ? words.slice(0, 48) : "";
};

/** The sentence around `probe` in `text`, for the row's second line. */
function around(text: string, probe: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().replace(/[“”"‘’]/g, " ").indexOf(probe.slice(0, 24));
  if (at < 0) return flat.slice(0, 140);
  const start = Math.max(0, at - 30);
  return `${start ? "…" : ""}${flat.slice(start, at + 140)}${at + 140 < flat.length ? "…" : ""}`;
}

export async function highlightUsage(invoke: Invoke, workspaceId: string, sourceId: string, highlight: { id: string; text: string }): Promise<HighlightUse[]> {
  const anchor = `highlight:${highlight.id}`;
  const probe = probeOf(highlight.text);
  const [links, notes] = await Promise.all([
    itemLinks(invoke, workspaceId, { kind: "source", id: sourceId }).catch(() => ({ backlinks: [] as Awaited<ReturnType<typeof itemLinks>>["backlinks"] })),
    invoke<Note[]>("store_notes", { sourceId }, workspaceId).catch(() => [] as Note[]),
  ]);
  const uses = new Map<string, HighlightUse>();
  for (const link of links.backlinks) {
    if (link.broken) continue;
    const quoted = !!probe && !!link.context && norm(link.context).replace(/[“”"‘’]/g, "").includes(probe.slice(0, 32));
    if (link.to.anchor !== anchor && !quoted) continue;
    const owner = link.via ?? link.from;
    const key = `${owner.kind}:${owner.id}`;
    if (!uses.has(key)) uses.set(key, { kind: owner.kind, id: owner.id, title: owner.title, context: link.context ?? undefined });
  }
  for (const note of notes) {
    const key = `note:${note.id}`;
    if (uses.has(key)) continue;
    const linked = note.body.includes(anchor) || note.body.includes(encodeURIComponent(anchor));
    const plain = markdownToPlainText(note.body);
    const quoted = !!probe && norm(plain).replace(/[“”"‘’]/g, "").includes(probe);
    if (!linked && !quoted) continue;
    uses.set(key, { kind: "note", id: note.id, title: note.title || plain.split("\n").find(Boolean)?.slice(0, 80) || "Note", context: quoted ? around(plain, probe) : undefined });
  }
  return [...uses.values()];
}
