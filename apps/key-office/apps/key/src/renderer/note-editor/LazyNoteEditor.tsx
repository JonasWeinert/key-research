// The note editor (Tiptap/ProseMirror, about a megabyte of script) loads on first use, so the
// shell and the PDF views start without it. The shell preloads it when idle; once loaded it
// renders synchronously like a plain import.
import { useEffect, useState, type ComponentType, type JSX } from "react";
import type { NoteEditorProps } from "./types";

type Editor = ComponentType<NoteEditorProps>;
let loaded: Editor | null = null;
let loading: Promise<Editor> | null = null;

export function loadNoteEditor(): Promise<Editor> {
  loading ??= import("./NoteEditor").then((m) => (loaded = m.default));
  return loading;
}

/** Loads the editor once the page has settled (call from a shell that will likely need it). */
export function preloadNoteEditorWhenIdle(delay = 1500) {
  if (loaded || loading) return;
  const start = () => void loadNoteEditor().catch(() => (loading = null));
  setTimeout(() => ("requestIdleCallback" in window ? requestIdleCallback(start, { timeout: 5000 }) : start()), delay);
}

export default function NoteEditor(props: NoteEditorProps): JSX.Element | null {
  const [Editor, setEditor] = useState<Editor | null>(() => loaded);
  useEffect(() => {
    if (Editor) return;
    let live = true;
    void loadNoteEditor().then((e) => live && setEditor(() => e));
    return () => {
      live = false;
    };
  }, [Editor]);
  return Editor ? <Editor {...props} /> : <div className="ne-loading" aria-busy="true" />;
}
