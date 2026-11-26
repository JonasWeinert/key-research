// The Zotero sheet's choices, apart from React: import once or keep in sync, and what —
// everything, chosen collections or chosen papers — with what comes along.
import type { ZoteroConnection, ZoteroItem, ZoteroOptions } from "./library-api";

export type Mode = "import" | "sync";
export type Scope = "library" | "collections" | "papers";
export type Bring = Omit<ZoteroOptions, "collectionKeys" | "itemKeys" | "dataDir">;

export const DEFAULT_BRING: Bring = { attachments: true, notes: true, annotations: true, mirrorCollections: true };

export interface Choice {
  scope: Scope;
  collections: Set<string>;
  papers: Set<string>;
  bring: Bring;
}

/** The options a choice sends to the host (key-zotero's ImportOptions). */
export function optionsOf(choice: Choice): ZoteroOptions {
  const options: ZoteroOptions = { ...choice.bring };
  if (choice.scope === "collections") options.collectionKeys = [...choice.collections];
  if (choice.scope === "papers") options.itemKeys = [...choice.papers];
  return options;
}

/** The choice a saved sync starts from, so its scope can be changed. */
export function choiceOf(options?: ZoteroOptions | null): Choice {
  const bring = options
    ? { attachments: options.attachments, notes: options.notes, annotations: options.annotations, mirrorCollections: options.mirrorCollections }
    : DEFAULT_BRING;
  const scope: Scope = options?.itemKeys ? "papers" : options?.collectionKeys ? "collections" : "library";
  return { scope, collections: new Set(options?.collectionKeys ?? []), papers: new Set(options?.itemKeys ?? []), bring };
}

/** Why the primary button is off, or null when it can go. */
export function blocker(mode: Mode, choice: Choice, connection?: ZoteroConnection | null): string | null {
  if (choice.scope === "collections" && choice.collections.size === 0) return "Choose at least one collection";
  if (choice.scope === "papers" && choice.papers.size === 0) return "Choose at least one paper";
  if (mode === "sync" && connection !== "ok") return "Zotero needs the Key Sync plugin";
  return null;
}

/** Papers matching a search over title, authors, year and type; all words must match. */
export function filterItems(items: ZoteroItem[], query: string): ZoteroItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((item) => {
    const text = `${item.title} ${item.creators} ${item.year ?? ""} ${item.itemType}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** "just now", "5 minutes ago", "yesterday at 14:02". */
export function ago(at: number | null | undefined, now = Date.now()): string {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A quiet line about the sync for Settings. */
export function syncLine(status: { configured: boolean; paused: boolean; connection?: ZoteroConnection | null; checkedAt?: number | null; syncedAt?: number | null; message?: string | null }, now = Date.now()): string {
  if (!status.configured) return "Not set up.";
  if (status.paused) return "Paused. Changes made in Zotero meanwhile come across when you resume.";
  switch (status.connection) {
    case "not-running":
      return `Zotero is not running. Key catches up when it is.${status.syncedAt ? ` Last synced ${ago(status.syncedAt, now)}.` : ""}`;
    case "plugin-missing":
      return "Zotero is running without the Key Sync plugin.";
    case "unpaired":
      return "Zotero did not accept the pairing code. Set up the sync again to pair.";
    case "error":
      return status.message || "The last sync did not finish. Key will try again.";
    default:
      return status.checkedAt ? `Up to date, checked ${ago(status.checkedAt, now)}.` : status.syncedAt ? `Last synced ${ago(status.syncedAt, now)}.` : "Waiting for the first sync.";
  }
}
