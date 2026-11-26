// The window's status bar (contract in shared/status-items.ts). Left: Zotero sync, background
// work and the workspace, plus the latest error notice (main/app-notices.ts). Right: the
// focused view's items, from native views over IPC or from DOM views via useStatusItems.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "@key-reader/ui/dismiss";
import "./status-bar.css";
import { Icon, isIconName, type IconName } from "./icons";
import { ActivityPanel, activityLabel, isActive, olderSources, ProgressRing, useLibraryStatus } from "./index-activity";
import type { Invoke, LibraryStatus, ZoteroSyncStatus } from "./library-api";
import { ago } from "./zotero-sheet-model";
import { overflowingStatusItems, sanitizeStatusItems, STATUS_BAR_HEIGHT, type StatusItem } from "../shared/status-items";

interface Notice {
  id: number;
  level: "error" | "warning" | "info";
  message: string;
  detail?: string;
  at: number;
}
type Frame = { id: string; x: number; y: number; width: number; height: number; image: string };
interface StatusBridge {
  tabAction(action: string, payload: unknown): Promise<unknown>;
  statusItems(): Promise<Record<string, StatusItem[]>>;
  invokeStatusItem(viewId: string, id: string): Promise<void>;
  notices(): Promise<Notice[]>;
  on(event: string, callback: (value: unknown) => void): () => void;
}
const bridge = () => (window as unknown as { key: StatusBridge }).key;

// DOM views' items, by view id, with what a click does and what hangs above them.
const domItems = new Map<string, { items: StatusItem[]; invoke?: (id: string) => void; popover?: (id: string) => ReactNode }>();
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

/** A shell (DOM) view's items in the status bar while it has focus. An item `popover`
 * returns content for opens that content above the item (closing like any other popover)
 * instead of calling `onInvoke`. Without a `viewId` the view contributes nothing. */
export function useStatusItems(
  viewId: string | undefined,
  items: StatusItem[],
  onInvoke?: (id: string) => void,
  popover?: (id: string) => ReactNode,
) {
  const invoke = useRef(onInvoke);
  invoke.current = onInvoke;
  const pop = useRef(popover);
  pop.current = popover;
  const key = JSON.stringify(items);
  useEffect(() => {
    if (!viewId) return;
    domItems.set(viewId, { items: sanitizeStatusItems(items), invoke: (id) => invoke.current?.(id), popover: (id) => pop.current?.(id) });
    changed();
    return () => {
      domItems.delete(viewId);
      changed();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId, key]);
}

const iconName = (name?: string): IconName | undefined => (isIconName(name) ? name : undefined);

interface ItemProps {
  item: StatusItem;
  onClick?: (anchor: HTMLElement) => void;
  className?: string;
  hidden?: boolean;
  /** The item opens a popover: true while it is open. */
  expanded?: boolean;
}

function Item({ item, onClick, className = "", hidden, expanded }: ItemProps) {
  const icon = iconName(item.icon);
  const content = (
    <>
      {item.progress !== undefined || item.busy ? (
        <ProgressRing fraction={item.busy ? undefined : item.progress} size={12} />
      ) : item.tone && item.tone !== "off" ? (
        <span className="kx-status-light" aria-hidden="true" />
      ) : (
        icon && <Icon name={icon} size={12} />
      )}
      {item.label && <span className="kx-status-label">{item.label}</span>}
    </>
  );
  const common = {
    className: `kx-status-item ${className}`,
    "data-status-item": item.id,
    "data-priority": item.priority,
    "data-tone": item.tone,
    title: item.title ?? item.label,
    hidden,
  };
  return onClick && !item.text ? (
    <button
      type="button"
      {...common}
      aria-pressed={expanded === undefined ? (item.active ?? undefined) : undefined}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      onClick={(e) => onClick(e.currentTarget)}
    >
      {content}
    </button>
  ) : (
    <span {...common} data-text={item.text || undefined} data-active={item.active || undefined}>
      {content}
    </span>
  );
}

/** A popover hanging above a bar item, closed by the shared dismiss layer. */
function StatusPopover({ anchor, label, onClose, children }: { anchor: HTMLElement; label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  useDismiss(true, { refs: [box, anchorRef], onDismiss: onClose, scroll: false });
  const [left, setLeft] = useState<number>();
  // Native views (a PDF, a web page) draw above the shell: while the popover is open they
  // stand still as pictures, as under the drawer, so it can hang over them.
  const [frames, setFrames] = useState<Frame[]>([]);
  useEffect(() => {
    const id = `status-popover-${crypto.randomUUID()}`;
    let open = true;
    void (bridge().tabAction?.("global-overlay-open", { id }) as Promise<{ frames?: Frame[] }> | undefined)
      ?.then((result) => open && setFrames(result?.frames ?? []))
      .catch(() => {});
    const off = bridge().on("global-overlay-frames", (value) => {
      const result = value as { id: string; frames: Frame[] };
      if (result.id === id) setFrames(result.frames);
    });
    return () => {
      open = false;
      off();
      void bridge().tabAction?.("global-overlay-close", { id })?.catch(() => {});
    };
  }, []);
  useLayoutEffect(() => {
    const width = box.current?.offsetWidth ?? 0;
    const rect = anchor.getBoundingClientRect();
    // Under the item's leading edge, inside the window.
    setLeft(Math.max(8, Math.min(rect.left, innerWidth - width - 8)));
  }, [anchor]);
  return createPortal(
    <>
      {frames.map((frame) => (
        <img
          key={frame.id}
          className="key-native-overlay-frame"
          alt=""
          draggable={false}
          src={frame.image}
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
        />
      ))}
      <div ref={box} className="kx-status-popover" role="dialog" aria-label={label} style={{ left: left ?? -9999, bottom: STATUS_BAR_HEIGHT + 6 }}>
        {children}
      </div>
    </>,
    document.body,
  );
}

/** The Zotero library's sync status: polled gently, again after each sync, and whether a
 * sync is running now (main/zotero-sync.ts says so; only one that lasts shows). */
function useZoteroSync(invoke: Invoke, workspaceId: string | undefined) {
  const [sync, setSync] = useState<ZoteroSyncStatus>();
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    if (!workspaceId) return setSync(undefined);
    let stopped = false;
    let shown: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      void invoke<ZoteroSyncStatus>("store_zotero_plugin_status", {}, workspaceId)
        .then((s) => !stopped && setSync(s))
        .catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    const off = bridge().on("zotero-syncing", (running) => {
      clearTimeout(shown);
      if (running) shown = setTimeout(() => !stopped && setSyncing(true), 600);
      else {
        setSyncing(false);
        load();
      }
    });
    const reload = () => load();
    window.addEventListener("key:zotero-changed", reload);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(shown);
      off();
      window.removeEventListener("key:zotero-changed", reload);
    };
  }, [invoke, workspaceId]);
  return { sync, syncing };
}

/** The Zotero item: a quiet light for how sync stands, the details in its tooltip. */
export function zoteroItem(sync: ZoteroSyncStatus | undefined, syncing: boolean, now: number): StatusItem {
  const base = { id: "zotero", icon: "sync" };
  if (!sync?.configured)
    return { ...base, label: "Set up Zotero", tone: "off", title: "Zotero sync is not set up. Click to import from Zotero or keep a workspace in sync with it." };
  const synced = sync.syncedAt ?? null;
  const details = [
    sync.libraryName && `Library: ${sync.libraryName}`,
    `${sync.items.toLocaleString()} ${sync.items === 1 ? "item" : "items"} synced`,
    synced ? `Last synced ${ago(synced, now)} (${new Date(synced).toLocaleString()})` : "Not synced yet",
    sync.checkedAt && sync.checkedAt !== synced ? `Last checked ${ago(sync.checkedAt, now)}` : "",
    [sync.zoteroVersion && `Zotero ${sync.zoteroVersion}`, sync.pluginVersion && `Key Sync ${sync.pluginVersion}`].filter(Boolean).join(" · "),
  ].filter(Boolean);
  const title = (head: string, extra?: string | null) => [head, extra, ...details, "Click to see or change what syncs."].filter(Boolean).join("\n");
  if (syncing) return { ...base, label: "Syncing Zotero…", busy: true, title: title("Syncing with Zotero now") };
  if (sync.paused) return { ...base, label: "Zotero paused", icon: "pause", tone: "off", title: title("Zotero sync is paused") };
  switch (sync.connection) {
    case "not-running":
      return { ...base, label: "Zotero closed", tone: "idle", title: title("Zotero is not running. Key catches up when it runs.") };
    case "plugin-missing":
      return { ...base, label: "Zotero needs Key Sync", tone: "warning", title: title("Install the Key Sync plugin in Zotero to keep syncing.", sync.message) };
    case "unpaired":
      return { ...base, label: "Zotero not connected", tone: "warning", title: title("Key Sync in Zotero needs to be connected to Key again.", sync.message) };
    case "error":
      return { ...base, label: "Zotero sync failed", tone: "error", title: title("The last sync did not finish.", sync.message) };
    case "off":
      return { ...base, label: "Zotero sync off", tone: "off", title: title("Zotero sync is turned off") };
    default:
      return { ...base, label: synced ? `Zotero · ${ago(synced, now)}` : "Zotero", tone: "ready", title: title(synced ? "In sync with Zotero" : "Waiting for the first sync") };
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
  const { sync, syncing } = useZoteroSync(invoke, zoteroWorkspaceId);
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

  const work = workItem(status);
  const pauseIndexing = (paused: boolean) => void invoke("store_index_control", { action: paused ? "pause" : "resume" }, workspaceId).catch(() => {});

  const dom = activeViewId ? domItems.get(activeViewId) : undefined;
  const viewItems = activeViewId ? (dom?.items ?? native[activeViewId] ?? []) : [];

  // One popover at a time, above the item that opened it; a view's goes with its focus.
  const [popover, setPopover] = useState<{ key: string; anchor: HTMLElement; label: string }>();
  const toggle = (key: string, anchor: HTMLElement, label: string) => setPopover((open) => (open?.key === key ? undefined : { key, anchor, label }));
  useEffect(() => setPopover((open) => (open?.key.startsWith("view:") ? undefined : open)), [activeViewId]);
  const workPanel = status?.activity ? (
    <ActivityPanel activity={status.activity} modelReady={status.model.state === "ready"} onPause={pauseIndexing} backfill={status.backfill} />
  ) : undefined;
  const popoverContent = popover?.key === "work" ? workPanel : popover?.key.startsWith("view:") ? dom?.popover?.(popover.key.slice(5)) : undefined;
  const invokeView = (item: StatusItem, anchor: HTMLElement) => {
    if (!activeViewId) return;
    if (dom?.popover?.(item.id)) return toggle(`view:${item.id}`, anchor, item.title ?? item.label);
    if (dom) dom.invoke?.(item.id);
    else void bridge().invokeStatusItem(activeViewId, item.id);
  };

  // Short of room, the lowest-priority items go first (the shell's own included); nothing wraps.
  // Fixed items first, so they do not move when work comes and goes.
  const left: StatusItem[] = [
    ...(workspaceName ? [{ id: "workspace", label: workspaceName, icon: "folder", title: "Switch workspace", priority: 70 }] : []),
    { ...zoteroItem(sync, syncing, now), priority: 40 },
    ...(work ? [work] : []),
  ];
  const bar = useRef<HTMLElement>(null);
  const widths = useRef(new Map<string, number>());
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [, setRoom] = useState(0);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setRoom(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const fits = [...left, ...viewItems];
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    for (const node of el.querySelectorAll<HTMLElement>(".kx-status-side > [data-status-item]"))
      if (!node.hidden) widths.current.set(node.dataset.statusItem!, node.offsetWidth);
    const notice = el.querySelector<HTMLElement>(".kx-status-notice")?.offsetWidth ?? 0;
    const style = getComputedStyle(el);
    // Less the padding, the gap between the two sides and the notice (which always stays).
    const space = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.columnGap || "0") - notice - 8;
    const next = overflowingStatusItems(
      fits.map((item) => ({ id: item.id, width: widths.current.get(item.id) ?? 0, priority: item.priority })),
      space,
      2,
    );
    if ([...next].join() !== [...hidden].join()) setHidden(next);
  });

  return (
    <footer ref={bar} className="kx-status-bar" role="contentinfo" aria-label="Status" style={{ height: STATUS_BAR_HEIGHT }}>
      <div className="kx-status-side">
        {left.map((item) => (
          <Item
            key={item.id}
            item={item}
            hidden={hidden.has(item.id)}
            className={item.id === "work" ? "kx-status-work" : ""}
            expanded={item.id === "work" && workPanel ? popover?.key === "work" : undefined}
            onClick={(anchor) =>
              item.id === "zotero"
                ? onOpenZotero()
                : item.id === "workspace"
                  ? onOpenWorkspace()
                  : workPanel
                    ? toggle("work", anchor, "Indexing activity")
                    : onOpenLibrary()
            }
          />
        ))}
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
          <Item
            key={item.id}
            item={item}
            hidden={hidden.has(item.id)}
            expanded={dom?.popover?.(item.id) ? popover?.key === `view:${item.id}` : undefined}
            onClick={(anchor) => invokeView(item, anchor)}
          />
        ))}
      </div>
      {popover && popoverContent && (
        <StatusPopover key={popover.key} anchor={popover.anchor} label={popover.label} onClose={() => setPopover(undefined)}>
          {popoverContent}
        </StatusPopover>
      )}
    </footer>
  );
}

/** Background work in the library: indexing (with its progress), a pause, or OpenAlex lookups. */
function workItem(status: LibraryStatus | undefined): StatusItem | undefined {
  const activity = status?.activity;
  if (!status) return undefined;
  if (activity && (isActive(activity) || (activity.paused && olderSources(status.backfill) > 0))) {
    const { label, fraction } = activityLabel(activity);
    return {
      id: "work",
      label,
      ...(activity.paused ? { icon: "pause" } : fraction === undefined ? { busy: true } : { progress: fraction }),
      title: activity.paused ? "Indexing is paused" : (activity.reading?.title ?? activity.embedding?.title ?? "Indexing sources"),
      priority: 90,
    };
  }
  if (status.enrichment)
    return {
      id: "work",
      label: `Looking up ${status.enrichment.toLocaleString()}`,
      icon: "globe",
      title: `${status.enrichment.toLocaleString()} sources waiting for an OpenAlex lookup`,
      priority: 90,
    };
  return undefined;
}
