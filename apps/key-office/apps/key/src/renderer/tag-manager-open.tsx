// Opening the tag manager from anywhere (command palette, tag pages, after a Zotero
// import), and the quiet offer to organise tags once a library arrives with many.
import { useEffect, useState } from "react";
import { toast } from "./item-actions";
import type { Invoke } from "./library-api";
import { analyzeTagsAsync, plural, type TagIndex } from "./tag-analysis";
import TagManager from "./TagManager";

const EVENT = "key:open-tag-manager";

export function openTagManager(workspaceId: string, focus?: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { workspaceId, focus } }));
}

/** Mounted once by the shell: shows the manager when asked. */
export function TagManagerHost({ invoke }: { invoke: Invoke }) {
  const [open, setOpen] = useState<{ workspaceId: string; focus?: string }>();
  useEffect(() => {
    const listener = (e: Event) => {
      const detail = (e as CustomEvent).detail as { workspaceId?: string; focus?: string } | undefined;
      if (detail?.workspaceId) setOpen({ workspaceId: detail.workspaceId, focus: detail.focus });
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
  if (!open) return null;
  return <TagManager key={open.workspaceId} invoke={invoke} workspaceId={open.workspaceId} focus={open.focus} onClose={() => setOpen(undefined)} />;
}

/** After an import or a first sync: when the tags could use some care, say so with counts. */
export async function offerTagCleanup(invoke: Invoke, workspaceId: string) {
  const index = await invoke<TagIndex>("store_tag_index", {}, workspaceId);
  if (index.tags.length < 8) return;
  const dismissed = await invoke<string[] | null>("store_ui_get", { key: "tagManager.dismissed" }, workspaceId).catch(() => null);
  const suggestions = await analyzeTagsAsync(index, { dismissed: new Set(dismissed ?? []) });
  if (suggestions.length < 3) return;
  toast(`${plural(index.tags.length, "tag")}, ${plural(suggestions.length, "suggestion")} to tidy them`, undefined, {
    label: "Organise tags…",
    run: () => openTagManager(workspaceId),
  });
}
