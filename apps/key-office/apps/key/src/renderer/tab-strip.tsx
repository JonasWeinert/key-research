// The main window's tab strips: one per editor group, side by side in the title bar's band.
// Drag logic lives in tab-drag.ts; this file measures, renders and talks to main.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons";
import { hasItemDrag, readItemDrag } from "./item-links";
import { openItemAt } from "./item-actions";
import { dragHint, follow, isOverContent, moveTo, pressTab, release, shiftFor, type DropTarget, type StripGeometry, type TabDrag, type TabDrop } from "./tab-drag";
import "./tab-strip.css";
import { FirstUseTip } from "./explain";

export type { DropTarget, TabDrop } from "./tab-drag";

export type TabKind =
  | "library"
  | "records"
  | "search"
  | "inbox"
  | "note"
  | "canvas"
  | "page"
  | "database"
  | "source"
  | "home"
  | "docs"
  | "sheets"
  | "slides"
  | "pdf"
  | "markdown"
  | "html"
  | "web";

export interface TabSummary {
  id: string;
  title: string;
  kind: TabKind;
  /** A browser tab's site icon (a data URL), shown in place of the kind's icon. */
  favicon?: string;
  /** The tab its group shows. */
  active: boolean;
  closable: boolean;
  /** Pinned tabs sit first, show only their icon, and have no close button. */
  pinned?: boolean;
}

/** A group's strip talks to main through this. */
export interface TabsApi {
  activate(id: string): Promise<unknown>;
  close(id: string): Promise<unknown>;
  reorder(id: string, index: number): Promise<unknown>;
  dropTab?(drop: TabDrop): Promise<unknown>;
  /** The "+" button: a new tab in this group. */
  showNewMenu(x: number, y: number): Promise<unknown>;
  /** The strip's tab list. */
  showMenu(x: number, y: number): Promise<unknown>;
  /** Right-click on a tab: split, move it to another group or window, close it. */
  showTabMenu?(id: string, x: number, y: number): Promise<unknown>;
  notifyChromePressed?(): void;
  /** A tab dropped outside the window: open it in a new one. */
  tearOff?(tabId: string): Promise<unknown>;
}

const KIND_GLYPH: Record<TabKind, IconName> = {
  home: "home",
  library: "books",
  records: "layers",
  search: "search",
  inbox: "inbox",
  note: "note",
  canvas: "canvas",
  page: "doc",
  database: "database",
  source: "link",
  docs: "fileDoc",
  sheets: "fileSheet",
  slides: "fileSlides",
  pdf: "filePdf",
  markdown: "fileMarkdown",
  html: "fileHtml",
  web: "globe",
};

/** The icon a tab shows for a view of `kind`. */
export function TabKindIcon({ kind }: { kind: string }) {
  return <Icon name={KIND_GLYPH[kind as TabKind] ?? "doc"} size={15} />;
}

/** How long an item dragged in from elsewhere rests on a tab before that tab opens. */
const SPRING_DELAY = 650;

function measure(list: HTMLElement, tabs: TabSummary[]): StripGeometry {
  const box = list.getBoundingClientRect();
  const spans = [...list.querySelectorAll<HTMLElement>(".kx-tab")].map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, width: r.width };
  });
  return { left: box.left, right: box.right, bottom: box.bottom, spans, pinned: tabs.filter((t) => t.pinned).length };
}

/** Clears transitions for two frames after a committed reorder, so the swap from transforms to
 * the new layout happens in one paint instead of animating back. */
function useSettle(): [boolean, () => void] {
  const [settling, setSettling] = useState(false);
  useLayoutEffect(() => {
    if (!settling) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setSettling(false));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [settling]);
  return [settling, useCallback(() => setSettling(true), [])];
}

interface TabProps {
  tab: TabSummary;
  index: number;
  shift: number;
  dragged: boolean;
  focusable: boolean;
  onKey(event: ReactKeyboardEvent<HTMLDivElement>, tab: TabSummary, index: number): void;
  onClose(tab: TabSummary): void;
  onMenu(tab: TabSummary, x: number, y: number): void;
}

/** One tab: presentational, its press and drag handled by the strip. */
function Tab({ tab, index, shift, dragged, focusable, onKey, onClose, onMenu }: TabProps) {
  return (
    <div
      className="kx-tab"
      role="tab"
      data-tab-id={tab.id}
      data-pinned={tab.pinned || undefined}
      data-dragging={dragged || undefined}
      aria-selected={tab.active}
      aria-label={tab.title}
      title={tab.pinned ? `${tab.title} (pinned)` : tab.title}
      tabIndex={focusable ? 0 : -1}
      style={shift ? { transform: `translateX(${shift}px)` } : undefined}
      onKeyDown={(event) => onKey(event, tab, index)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(tab, event.clientX, event.clientY);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onClose(tab);
      }}
    >
      <span className="kx-tab-glyph" aria-hidden="true">
        {tab.favicon ? <img src={tab.favicon} alt="" draggable={false} /> : <TabKindIcon kind={tab.kind} />}
      </span>
      {!tab.pinned && <span className="kx-tab-label">{tab.title}</span>}
      {tab.closable && (
        <button
          type="button"
          className="kx-tab-close"
          tabIndex={-1}
          title="Close tab"
          aria-label={`Close ${tab.title}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose(tab);
          }}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

/** What a drag draws over the whole window: the hint, a drop preview and an insertion marker. */
function DragOverlay({ drag }: { drag: TabDrag & { pointerX: number } }) {
  const target = drag.phase.mode === "away" ? drag.phase.target : undefined;
  const hint = dragHint(drag);
  return createPortal(
    <>
      {hint && (
        <div className="kx-tab-drag-hint" role="status" aria-live="polite" style={{ left: Math.max(12, Math.min(window.innerWidth - 280, drag.pointerX - 110)) }}>
          <span>{hint}</span>
          <span className="kx-tab-drag-hint-key">Esc to cancel</span>
        </div>
      )}
      {target?.preview && (
        <div
          className="key-pane-drop-preview"
          aria-hidden="true"
          style={{ left: target.preview.x + 4, top: target.preview.y + 4, width: Math.max(0, target.preview.width - 8), height: Math.max(0, target.preview.height - 8) }}
        />
      )}
      {target?.marker && <div className="key-tab-insert-marker" aria-hidden="true" style={{ left: target.marker.x - 1 }} />}
    </>,
    document.body,
  );
}

export interface GroupTabStripProps {
  api: TabsApi;
  groupId: string;
  tabs: TabSummary[];
  /** The group with focus: new tabs open here, and its active tab is drawn strongest. */
  focused?: boolean;
  /** Leading control (the sidebar toggle when the sidebar is collapsed). */
  chromeControl?: ReactNode;
  trailingControls?: ReactNode;
  /** What releasing the dragged tab at a point outside this strip would do. */
  locateDrop?: (x: number, y: number, drag: { tabId: string; groupId: string }) => DropTarget | undefined;
  /** Called when a drag enters (true) or leaves the content area, and when it ends (false). */
  onContentDrag?: (dragging: boolean) => void;
  onFocusGroup?: () => void;
  /** The only tab of the only window: it cannot be torn off. */
  lone?: boolean;
  /** The leftmost strip, which makes room for the traffic lights when the sidebar is hidden. */
  first?: boolean;
  style?: CSSProperties;
}

/** One editor group's tab strip. */
export function GroupTabStrip({
  api,
  groupId,
  tabs: incoming,
  focused = true,
  chromeControl,
  trailingControls,
  locateDrop,
  onContentDrag,
  onFocusGroup,
  lone = false,
  first = true,
  style,
}: GroupTabStripProps) {
  // Shown order: a committed reorder applies here at once, before main's broadcast confirms it.
  const [tabs, setTabs] = useState(incoming);
  useEffect(() => setTabs(incoming), [incoming]);
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<TabDrag | null>(null);
  const [drag, setDrag] = useState<(TabDrag & { pointerX: number }) | null>(null);
  const [settling, settle] = useSettle();
  const [itemOver, setItemOver] = useState(false);
  const spring = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const [focusId, setFocusId] = useState<string>();

  const activeId = tabs.find((t) => t.active)?.id;
  const revealActive = useCallback(() => {
    listRef.current?.querySelector('.kx-tab[aria-selected="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, []);
  // New tabs open at the end: keep the active one in view (not mid-press, which would move the
  // tabs under the pointer).
  useEffect(() => {
    if (!dragRef.current) revealActive();
  }, [activeId, revealActive]);

  // Document tabs are sibling native views that see neither this press nor a focus change:
  // relay it so they dismiss their popovers. The first strip listens for the window.
  useEffect(() => {
    if (!first) return;
    const relay = () => api.notifyChromePressed?.();
    document.addEventListener("pointerdown", relay, true);
    return () => document.removeEventListener("pointerdown", relay, true);
  }, [api, first]);

  // A mouse's vertical wheel scrolls the strip sideways (trackpads already do). React's wheel
  // listener is passive, hence the native one.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onWheel = (event: WheelEvent) => {
      if (list.scrollWidth <= list.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, []);

  const end = useCallback(
    (commit: boolean) => {
      const current = dragRef.current;
      if (!current) return;
      dragRef.current = null;
      if (isOverContent(current.phase)) onContentDrag?.(false);
      const outcome = commit ? release(current) : { kind: "cancel" as const };
      if (current.phase.mode === "pressed") {
        setDrag(null);
        revealActive();
        return;
      }
      settle();
      if (outcome.kind === "reorder") {
        setTabs((shown) => moveTo(shown, current.tabId, outcome.index));
        void api.reorder(current.tabId, outcome.index);
      }
      setDrag(null);
      if (outcome.kind === "drop") void api.dropTab?.(outcome.drop);
      if (outcome.kind === "tear-off") void api.tearOff?.(current.tabId);
    },
    [api, onContentDrag, revealActive, settle],
  );

  // Esc cancels a drag wherever focus is.
  useEffect(() => {
    if (!drag) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      end(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag, end]);

  // The dragged tab closed mid-drag (⌘W): drop the drag.
  useEffect(() => {
    const current = dragRef.current;
    if (current && !tabs.some((t) => t.id === current.tabId)) {
      dragRef.current = null;
      if (isOverContent(current.phase)) onContentDrag?.(false);
      setDrag(null);
    }
  }, [tabs, onContentDrag]);

  const close = (tab: TabSummary) => {
    if (tab.closable) void api.close(tab.id);
  };
  const openMenu = (tab: TabSummary, x: number, y: number) => void api.showTabMenu?.(tab.id, x, y);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 1) event.preventDefault();
    if (event.button !== 0) return;
    const el = (event.target as HTMLElement).closest<HTMLElement>(".kx-tab");
    const list = listRef.current;
    const index = el ? tabs.findIndex((t) => t.id === el.dataset.tabId) : -1;
    if (!el || !list || index < 0) return;
    const tab = tabs[index];
    // Pressing a tab shows it at once, so showing never waits for a click a drag would eat.
    const shownBefore = tabs.find((t) => t.active)?.id;
    if (!tab.active || !focused) void api.activate(tab.id);
    dragRef.current = pressTab({ pointerId: event.pointerId, tabId: tab.id, groupId, origin: index, start: { x: event.clientX, y: event.clientY }, geometry: measure(list, tabs), shownBefore });
    list.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const env = {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      lone,
      canTearOff: Boolean(api.tearOff),
      locate: locateDrop ? (x: number, y: number) => locateDrop(x, y, { tabId: current.tabId, groupId }) : undefined,
    };
    const wasOver = isOverContent(current.phase);
    if (current.phase.mode === "pressed") {
      if (follow(current, event.clientX, event.clientY, env).mode === "pressed") return;
      // Measure again as the drag really starts: the press's activation may have moved tabs.
      if (listRef.current) current.geometry = measure(listRef.current, tabs);
    }
    current.phase = follow(current, event.clientX, event.clientY, env);
    const over = isOverContent(current.phase);
    if (over !== wasOver) {
      onContentDrag?.(over);
      // Over the content, the group shows what it showed before the press.
      if (over && current.shownBefore && current.shownBefore !== current.tabId && tabs.length > 1) void api.activate(current.shownBefore);
    }
    setDrag({ ...current, pointerX: event.clientX });
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    if (dragRef.current?.pointerId === event.pointerId) end(commit);
  };

  const focusTab = (index: number) => {
    const target = tabs[(index + tabs.length) % tabs.length];
    if (!target) return;
    setFocusId(target.id);
    listRef.current?.querySelector<HTMLElement>(`.kx-tab[data-tab-id="${CSS.escape(target.id)}"]`)?.focus();
  };

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>, tab: TabSummary, index: number) => {
    const { key, altKey, metaKey, shiftKey } = event;
    if ((key === "ArrowLeft" || key === "ArrowRight") && altKey) {
      event.preventDefault();
      void api.reorder(tab.id, index + (key === "ArrowLeft" ? -1 : 1));
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      focusTab(index + (key === "ArrowLeft" ? -1 : 1));
    } else if (key === "Home" || key === "End") {
      event.preventDefault();
      focusTab(key === "Home" ? 0 : tabs.length - 1);
    } else if (key === "Enter" || key === " ") {
      event.preventDefault();
      void api.activate(tab.id);
    } else if ((key === "Delete" || key === "Backspace") && !metaKey) {
      event.preventDefault();
      close(tab);
    } else if (key === "ContextMenu" || (key === "F10" && shiftKey)) {
      event.preventDefault();
      const r = event.currentTarget.getBoundingClientRect();
      openMenu(tab, Math.round(r.left), Math.round(r.bottom));
    }
  };

  // Roving focus: the tab last moved to by arrow keys, else the active one.
  const focusable = tabs.some((t) => t.id === focusId) ? focusId : activeId;
  const menuAt = (event: ReactMouseEvent<HTMLButtonElement>, open: (x: number, y: number) => Promise<unknown>) => {
    const r = event.currentTarget.getBoundingClientRect();
    void open(Math.round(r.left), Math.round(r.bottom));
  };

  return (
    <div
      className="kx-tabs"
      data-group-strip={groupId}
      data-focused={focused || undefined}
      data-first={first || undefined}
      style={style}
      onPointerDownCapture={() => {
        if (!focused) onFocusGroup?.();
      }}
    >
      <div className="kx-tabs-inset" />
      {chromeControl}
      {first && <FirstUseTip help="tip.split-tabs" anchor='.kx-tabs[data-first] [role="tablist"]' when={tabs.length > 2} delay={2500} />}
      <div
        ref={listRef}
        className="kx-tabs-list"
        role="tablist"
        aria-label="Tabs"
        aria-orientation="horizontal"
        data-dragging={drag ? drag.phase.mode : undefined}
        data-settling={settling || undefined}
        data-item-drop={itemOver || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => onPointerEnd(event, true)}
        onPointerCancel={(event) => onPointerEnd(event, false)}
        onLostPointerCapture={(event) => onPointerEnd(event, false)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocusId(undefined);
        }}
        // Items dragged from elsewhere in the app: resting on a tab opens it (so they can be
        // dropped inside it); dropped on the strip, they open in new tabs.
        onDragOver={(event) => {
          if (!hasItemDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setItemOver(true);
          const over = (event.target as HTMLElement).closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
          if (over === spring.current?.id) return;
          clearTimeout(spring.current?.timer);
          spring.current = over ? { id: over, timer: setTimeout(() => void api.activate(over), SPRING_DELAY) } : undefined;
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setItemOver(false);
          clearTimeout(spring.current?.timer);
          spring.current = undefined;
        }}
        onDrop={(event) => {
          setItemOver(false);
          clearTimeout(spring.current?.timer);
          spring.current = undefined;
          const items = readItemDrag(event.dataTransfer);
          if (!items.length) return;
          event.preventDefault();
          if (!focused) onFocusGroup?.();
          for (const item of items.slice(0, 8)) openItemAt(item, "tab", item.title);
        }}
      >
        {tabs.map((tab, index) => (
          <Tab
            key={tab.id}
            tab={tab}
            index={index}
            shift={drag && drag.tabId === tab.id ? (drag.phase.mode === "reorder" ? drag.phase.offset : 0) : drag ? shiftFor(drag, index) : 0}
            dragged={drag?.tabId === tab.id && drag.phase.mode !== "pressed"}
            focusable={tab.id === focusable}
            onKey={onKey}
            onClose={close}
            onMenu={openMenu}
          />
        ))}
        <button type="button" className="kx-tabs-button kx-tabs-add" title="New tab" aria-label="New tab" onClick={(event) => menuAt(event, (x, y) => api.showNewMenu(x, y))}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {trailingControls}
      <button type="button" className="kx-tabs-button kx-tabs-all" title="All tabs in this group" aria-label="All tabs in this group" onClick={(event) => menuAt(event, (x, y) => api.showMenu(x, y))}>
        <Icon name="tabs" size={16} />
      </button>
      {drag && drag.phase.mode !== "pressed" && <DragOverlay drag={drag} />}
    </div>
  );
}
