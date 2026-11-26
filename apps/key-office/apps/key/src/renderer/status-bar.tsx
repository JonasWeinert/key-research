// The window's status bar (contract in shared/status-items.ts). Left: Zotero sync, background
// work and the workspace, plus the latest error notice (main/app-notices.ts). Right: the
// focused view's items, from native views over IPC or from DOM views via useStatusItems.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import "./status-bar.css";
import { Icon, isIconName, type IconName } from "./icons";
import { isActive, useLibraryStatus } from "./index-activity";
import type { Invoke, ZoteroSyncStatus } from "./library-api";
import { ago } from "./zotero-sheet-model";
import { sanitizeStatusItems, STATUS_BAR_HEIGHT, type StatusItem } from "../shared/status-items";

interface Notice {
  id: number;
  level: "error" | "warning" | "info";
  message: string;
  detail?: string;
  at: number;
}
interface StatusBridge {
  statusItems(): Promise<Record<string, StatusItem[]>>;
  invokeStatusItem(viewId: string, id: string): Promise<void>;
  notices(): Promise<Notice[]>;
  on(event: string, callback: (value: unknown) => void): () => void;
}
const bridge = () => (window as unknown as { key: StatusBridge }).key;

// DOM views' items, by view id, with what a click does.
const domItems = new Map<string, { items: StatusItem[]; invoke?: (id: string) => void }>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** A shell (DOM) view's items in the status bar while it has focus. */
export function useStatusItems(viewId: string | undefined, items: StatusItem[], onInvoke?: (id: string) => void) {
  const invoke = useRef(onInvoke);
  invoke.current = onInvoke;
  const key = JSON.stringify(items);
  useEffect(() => {
    if (!viewId) return;
    domItems.set(viewId, { items: sanitizeStatusItems(items), invoke: (id) => invoke.current?.(id) });
    changed();
    return () => {
      domItems.delete(viewId);
      changed();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId, key]);
}

const iconName = (name?: string): IconName | undefined => (isIconName(name) ? name : undefined);

function Item({ item, onClick, className = "" }: { item: StatusItem; onClick?: () => void; className?: string }) {
  const icon = iconName(item.icon);
  const content = (
    <>
      {icon && <Icon name={icon} size={12} />}
      {item.label && <span className="kx-status-label">{item.label}</span>}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={`kx-status-item ${className}`}
      data-status-item={item.id}
      aria-pressed={item.active ?? undefined}
      title={item.title ?? item.label}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <span className={`kx-status-item ${className}`} data-status-item={item.id} data-active={item.active || undefined} title={item.title ?? item.label}>
      {content}
    </span>
  );
}

/** The Zotero library's sync status, gently polled. */
function useZoteroSync(invoke: Invoke, workspaceId: string | undefined) {
  const [sync, setSync] = useState<ZoteroSyncStatus>();
  useEffect(() => {
    if (!workspaceId) return setSync(undefined);
    let stopped = false;
    const load = () =>
      void invoke<ZoteroSyncStatus>("store_zotero_plugin_status", {}, workspaceId)
        .then((s) => !stopped && setSync(s))
        .catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [invoke, workspaceId]);
  return sync;
}

function zoteroItem(sync: ZoteroSyncStatus | undefined, now: number): StatusItem {
  if (!sync?.configured) return { id: "zotero", label: "Zotero", icon: "sync", title: "Zotero sync is not set up. Click to set it up." };
  if (sync.paused) return { id: "zotero", label: "Zotero paused", icon: "pause", title: "Zotero sync is paused" };
  const synced = sync.syncedAt ?? sync.checkedAt;
  switch (sync.connection) {
    case "not-running":
      return { id: "zotero", label: "Zotero not running", icon: "sync", title: `Key catches up when Zotero runs.${synced ? ` Last synced ${ago(synced, now)}.` : ""}` };
    case "plugin-missing":
    case "unpaired":
    case "error":
      return { id: "zotero", label: "Zotero needs attention", icon: "sync", title: sync.message || "The last sync did not finish" };
    default:
      return { id: "zotero", label: synced ? `Zotero synced ${ago(synced, now)}` : "Zotero", icon: "sync", title: synced ? `Last synced ${new Date(synced).toLocaleString()}` : "Waiting for the first sync" };
  }
}

export function StatusBar({
  invoke,
  workspaceId,
  workspaceName,
  zoteroWorkspaceId,
  activeViewId,
  onOpenZotero,
  onOpenWorkspace,
  onOpenLibrary,
}: {
  invoke: Invoke;
  workspaceId?: string;
  workspaceName?: string;
  /** The workspace Zotero syncs into, if any. */
  zoteroWorkspaceId?: string;
  activeViewId?: string | null;
  onOpenZotero: () => void;
  onOpenWorkspace: () => void;
  onOpenLibrary: () => void;
}) {
  const status = useLibraryStatus(invoke, workspaceId);
  const sync = useZoteroSync(invoke, zoteroWorkspaceId);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Native views' items.
  const [native, setNative] = useState<Record<string, StatusItem[]>>({});
  useEffect(() => {
    void bridge()
      .statusItems?.()
      .then((all) => setNative(all ?? {}))
      .catch(() => {});
    return bridge().on("status-items", (value) => {
      const { viewId, items } = value as { viewId: string; items: StatusItem[] };
      setNative((all) => {
        const next = { ...all };
        if (items.length) next[viewId] = items;
        else delete next[viewId];
        return next;
      });
    });
  }, []);
  useSyncExternalStore(subscribe, () => version);

  // Error notices: the latest stays until dismissed.
  const [notices, setNotices] = useState<Notice[]>([]);
  useEffect(() => {
    void bridge()
      .notices?.()
      .then((list) => setNotices((list ?? []).filter((n) => Date.now() - n.at < 10 * 60_000)))
      .catch(() => {});
    return bridge().on("app-notice", (value) => setNotices((list) => [...list.slice(-19), value as Notice]));
  }, []);
  const notice = notices.at(-1);

  const activity = status?.activity;
  const work: StatusItem | undefined = isActive(activity)
    ? {
        id: "work",
        label: activity!.batchTotal > 1 ? `Indexing ${Math.min(activity!.batchDone + 1, activity!.batchTotal)} of ${activity!.batchTotal}` : "Indexing",
        icon: "activity",
        title: activity!.paused ? "Indexing is paused" : (activity!.reading?.title ?? activity!.embedding?.title ?? "Indexing sources"),
      }
    : status?.enrichment
      ? { id: "work", label: `Looking up ${status.enrichment.toLocaleString()}`, icon: "globe", title: `${status.enrichment.toLocaleString()} sources waiting for an OpenAlex lookup` }
      : undefined;

  const viewItems = activeViewId ? (domItems.get(activeViewId)?.items ?? native[activeViewId] ?? []) : [];
  const invokeView = (id: string) => {
    if (!activeViewId) return;
    const dom = domItems.get(activeViewId);
    if (dom) dom.invoke?.(id);
    else void bridge().invokeStatusItem(activeViewId, id);
  };

  return (
    <footer className="kx-status-bar" role="contentinfo" aria-label="Status" style={{ height: STATUS_BAR_HEIGHT }}>
      <div className="kx-status-side">
        <Item item={zoteroItem(sync, now)} onClick={onOpenZotero} />
        {work && <Item item={work} onClick={onOpenLibrary} className="kx-status-work" />}
        {workspaceName && (
          <Item
            item={{ id: "workspace", label: workspaceName, icon: "folder", title: "Switch workspace" }}
            onClick={onOpenWorkspace}
          />
        )}
        {notice && (
          <span className="kx-status-notice" data-level={notice.level} role="status" aria-live="polite">
            <button
              type="button"
              className="kx-status-item"
              title={`${[notice.message, notice.detail].filter(Boolean).join("\n\n")}\n\nClick to copy. Details are in the log (Key › logs › key.log).`}
              onClick={() => void navigator.clipboard?.writeText([notice.message, notice.detail].filter(Boolean).join("\n\n")).catch(() => {})}
            >
              <Icon name={notice.level === "info" ? "info" : "warning"} size={12} />
              <span className="kx-status-label">{notice.message}</span>
              {notices.length > 1 && <span className="kx-status-count">{notices.length}</span>}
            </button>
            <button type="button" className="kx-status-dismiss" aria-label="Dismiss" title="Dismiss" onClick={() => setNotices([])}>
              <Icon name="close" size={10} />
            </button>
          </span>
        )}
      </div>
      <div className="kx-status-side kx-status-context" data-view={activeViewId ?? undefined}>
        {viewItems.map((item) => (
          <Item key={item.id} item={item} onClick={() => invokeView(item.id)} />
        ))}
      </div>
    </footer>
  );
}
