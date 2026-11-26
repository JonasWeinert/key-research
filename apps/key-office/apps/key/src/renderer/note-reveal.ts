// Opening a note at a passage (a highlight's "Used in" row): the shell opens or focuses the
// note's tab and announces the words; the note scrolls to them and selects them, once.
import { bridge } from "./library-api";

export const NOTE_REVEAL_EVENT = "key:note-reveal";
const pending = new Map<string, string>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  try {
    bridge().on("note-reveal", (value) => {
      const { noteId, text } = (value ?? {}) as { noteId?: string; text?: string };
      if (!noteId || !text) return;
      pending.set(noteId, text);
      window.dispatchEvent(new CustomEvent(NOTE_REVEAL_EVENT, { detail: noteId }));
    });
  } catch {
    /* outside the shell */
  }
}
listen();

/** The passage a note should show, once. */
export function takeNoteReveal(noteId: string) {
  const text = pending.get(noteId);
  pending.delete(noteId);
  return text;
}

/** Opens a note (in a tab, or the tab it is in) at the words `text`. */
export function openNoteAt(workspaceId: string, noteId: string, text: string | undefined, title?: string) {
  return bridge().tabAction("open-content", { section: "note", workspaceId, noteId, title, ...(text ? { reveal: text.slice(0, 600) } : {}) });
}
