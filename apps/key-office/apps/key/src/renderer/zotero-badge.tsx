// Quiet marks for what Zotero keeps in step: the sidebar's Library row, collections mirrored
// from Zotero, sources that came from it, and a line in a source's details saying which
// Zotero library it syncs with, when it last synced, and a link that selects it in Zotero.
// Read from the sync's own status (`store_zotero_plugin_status`) and the stored origin keys.
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import "./zotero-badge.css";
import { bridge, type Collection, type Invoke, type Source, type ZoteroSyncStatus } from "./library-api";

const cache = new Map<string, Promise<ZoteroSyncStatus | null>>();
const listeners = new Set<() => void>();
let wired = false;
const forget = () => {
  cache.clear();
  listeners.forEach((l) => l());
};
function wire() {
  if (wired) return;
  wired = true;
  window.addEventListener("key:zotero-changed", forget);
  try {
    // A sync that ends may have changed what is synced and when.
    bridge().on("zotero-syncing", (running) => !running && forget());
  } catch {}
}

/** The workspace's Zotero sync, or null when it has none. Shared by every badge on screen. */
export function useZoteroSync(invoke: Invoke, workspaceId?: string) {
  const [status, setStatus] = useState<ZoteroSyncStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    wire();
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  useEffect(() => {
    if (!workspaceId) return setStatus(null);
    let live = true;
    let request = cache.get(workspaceId);
    if (!request) {
      request = invoke<ZoteroSyncStatus>("store_zotero_plugin_status", {}, workspaceId).catch(() => null);
      cache.set(workspaceId, request);
    }
    void request.then((s) => live && setStatus(s?.configured ? s : null));
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, tick]);
  return status;
}

/** "just now", "4 min ago", "2 h ago", "3 Nov". */
export function syncedAgo(at?: number | null) {
  if (!at) return "not yet";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export const isZoteroSource = (source: Pick<Source, "origin">) => source.origin === "zotero";
export const isZoteroCollection = (collection: Pick<Collection, "originKey">) => !!collection.originKey?.startsWith("zotero:");

/** "Synced with Zotero · My Library · 2 min ago". */
export function syncTitle(status: ZoteroSyncStatus | null, what: string) {
  if (!status) return `${what} from Zotero`;
  return [
    `${what} synced with Zotero`,
    status.libraryName,
    status.paused ? "Sync paused" : `Last synced ${syncedAgo(status.syncedAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A small Zotero mark; `synced` false shows it fainter (imported once, not kept in step). */
export function ZoteroMark({ status, what = "Kept", size = 11, className }: { status: ZoteroSyncStatus | null; what?: string; size?: number; className?: string }) {
  const title = syncTitle(status, what);
  return (
    <span className={`kx-zotero-mark${className ? ` ${className}` : ""}`} data-synced={!!status} title={title} aria-label={title} role="img">
      <Icon name="zotero" size={size} />
    </span>
  );
}

/** `zotero://select/…` for an item of the user's own library (group items have no stable link here). */
export function zoteroSelectUrl(key: string | null | undefined, status: ZoteroSyncStatus | null) {
  if (!key || !/^[A-Z0-9]{8}$/.test(key)) return undefined;
  if (status?.libraryID && status.libraryID !== 1) return undefined;
  return `zotero://select/library/items/${key}`;
}

/** The line in a source's details: which Zotero library, when it last synced, open in Zotero. */
export function ZoteroSourceLine({ source, status }: { source: Source; status: ZoteroSyncStatus | null }) {
  if (!isZoteroSource(source)) return null;
  const url = zoteroSelectUrl(source.originKey, status);
  return (
    <span className="kx-zotero-line">
      <ZoteroMark status={status} what="Item" />
      <span>{status ? `Synced with ${status.libraryName || "Zotero"}` : "Imported from Zotero"}</span>
      {status && <small>{status.paused ? "sync paused" : `synced ${syncedAgo(status.syncedAt)}`}</small>}
      {url && (
        <a href={url} onClick={(e) => (e.preventDefault(), void bridge().tabAction("open-url", { url }))} title="Select this item in Zotero">
          Open in Zotero
        </a>
      )}
    </span>
  );
}
