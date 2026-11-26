/** Lets the sidebar list refresh when a note is created, renamed or deleted. */
export const notesChanged = () => window.dispatchEvent(new Event("key:notes-changed"));
/** A note's text was saved; canvases showing it re-read it. */
export const noteSaved = (id: string) => window.dispatchEvent(new CustomEvent("key:note-saved", { detail: id }));
