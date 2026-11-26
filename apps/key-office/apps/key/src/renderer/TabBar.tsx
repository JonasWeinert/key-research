// SPDX-License-Identifier: Apache-2.0
// Derived from GenOffice's apps/shell/src/renderer/src/TabBar.tsx (Copyright 2026 Mainfunc, Inc.,
// Apache-2.0; see ../../../../LICENSE and NOTICE). Modified by Key: wired to Key's tab groups,
// splits, item drags and movable Home tabs. This file stays Apache-2.0; the rest of @key/electron is MIT.
import { hasItemDrag, readItemDrag } from "./item-links";
import { openItemAt } from "./item-actions";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import "./tabbar.css";
import { Icon } from "./icons";
import type { GroupSide, Rect } from "../shared/tab-model";
export interface TabSummary {
  id: string;
  title: string;
  kind:
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
/** Where a dragged tab lands: in a group's strip at `index`, or in a new group on `side` of a group. */
export type TabDrop =
  | { kind: "move"; tabId: string; groupId: string; index: number }
  | { kind: "split"; tabId: string; groupId: string; side: GroupSide };
/** A drop outside the dragged tab's own strip, with what to draw while it is offered. */
export interface DropTarget {
  /** Nothing to drop here (a group's own content away from its sides). */
  drop?: TabDrop;
  label: string;
  /** Over a group's content: the rectangle the tab will take (native views show still frames). */
  preview?: Rect;
  content?: boolean;
  /** Over another strip: where the tab will be inserted. */
  marker?: { x: number };
}
// Adapted from Gen Office's Apache-licensed TabBar: Key's main process retains ownership.

const KIND_ICON: Record<TabSummary["kind"], ReactElement> = {
  home: <Icon name="home" size={15} />,
  library: <Icon name="books" size={15} />,
  records: <Icon name="layers" size={15} />,
  search: <Icon name="search" size={15} />,
  inbox: <Icon name="inbox" size={15} />,
  note: <Icon name="note" size={15} />,
  canvas: <Icon name="canvas" size={15} />,
  page: <Icon name="doc" size={15} />,
  database: <Icon name="database" size={15} />,
  source: <Icon name="link" size={15} />,
  docs: <Icon name="fileDoc" size={15} />,
  sheets: <Icon name="fileSheet" size={15} />,
  slides: <Icon name="fileSlides" size={15} />,
  pdf: <Icon name="filePdf" size={15} />,
  markdown: <Icon name="fileMarkdown" size={15} />,
  html: <Icon name="fileHtml" size={15} />,
  web: <Icon name="globe" size={15} />,
};

/** The icon a tab shows for a view of `kind`. */
export function TabKindIcon({ kind }: { kind: string }) {
  return KIND_ICON[kind as TabSummary["kind"]] || KIND_ICON.page;
}

/** One editor group's tab strip. Every group has one; the first sits beside the traffic
 * lights (or the sidebar), the others at the same height above their own content. */
export function TabBar({
  api,
  groupId,
  tabs: shown,
  focused = true,
  chromeControl,
  trailingControls,
  locateDrop,
  onContentDrag,
  onFocusGroup,
  lone = false,
  first = true,
  style,
}: {
  api: TabsApi;
  groupId: string;
  tabs: TabSummary[];
  /** The group with focus: new tabs open here, and its active tab is drawn strongest. */
  focused?: boolean;
  chromeControl?: ReactNode;
  trailingControls?: ReactNode;
  /** What releasing the dragged tab at a point outside this strip would do: join another
   * group's strip, or open a group of its own beside a group's content. */
  locateDrop?: (x: number, y: number, drag: { tabId: string; groupId: string }) => DropTarget | undefined;
  /** Called when a drag enters (true) or leaves the content area, and when it ends (false). */
  onContentDrag?: (dragging: boolean) => void;
  onFocusGroup?: () => void;
  /** The only tab of the only window: it cannot be torn off. */
  lone?: boolean;
  /** The leftmost strip, which makes room for the traffic lights when the sidebar is hidden. */
  first?: boolean;
  style?: CSSProperties;
}) {
  const t = (key: string) => ({ closeTab: "Close tab", newTab: "New tab", tabList: "All tabs in this group" })[key] ?? key;
  // The order shown, ahead of main's confirmation after a reorder.
  const [tabs, setTabs] = useState<TabSummary[]>(shown);
  useEffect(() => setTabs(shown), [shown]);
  const stripRef = useRef<HTMLDivElement>(null);

  // Chrome-style drag-to-reorder: the grabbed tab tracks the pointer 1:1 while
  // its neighbours slide aside live; the final order is committed on release.
  // Out of the strip it can join another group, open a group of its own, or a window.
  interface DragInfo {
    pointerId: number;
    id: string;
    from: number;
    startX: number;
    startY: number;
    strip: DOMRect;
    /** viewport-x left edge + width of every tab, sampled at drag start */
    lefts: number[];
    widths: number[];
    target: number;
    started: boolean;
    /** The tab that was active before this press, shown again when the drag reaches the content. */
    previous?: string;
    drop?: TabDrop;
    overContent?: boolean;
    tearOff?: boolean;
  }
  const dragRef = useRef<DragInfo | null>(null);
  const [itemOver, setItemOver] = useState(false);
  const springTab = useRef<{ id: string; timer: ReturnType<typeof setTimeout> }>(undefined);
  const [dragVisual, setDragVisual] = useState<{
    id: string;
    dx: number;
    from: number;
    target: number;
    width: number;
    pointerX: number;
    away: boolean;
    target2?: DropTarget;
    tearOff?: boolean;
  } | null>(null);

  const [settling, setSettling] = useState(false);
  useLayoutEffect(() => {
    if (!settling) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setSettling(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [settling]);
  const finishDrag = (pointerId: number, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag || pointerId !== drag.pointerId) return;
    dragRef.current = null;
    if (drag.overContent) onContentDrag?.(false);
    if (!drag.started) {
      // plain click: the in-view scroll was suppressed while the press was
      // held (dragRef was set), so honor it now that the press is over
      stripRef.current?.querySelector(".tab-item.active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
      return;
    }
    setSettling(true);
    setDragVisual(null);
    if (commit && drag.tearOff && api.tearOff) {
      void api.tearOff(drag.id);
      return;
    }
    if (commit && drag.drop && api.dropTab) {
      void api.dropTab(drag.drop);
      return;
    }
    if (commit && drag.target !== drag.from) {
      // optimistic local reorder so clearing the transforms causes no flash;
      // the main-process broadcast arrives with the identical order
      setTabs((prev) => {
        // look the tab up by id — the list may have changed mid-drag (e.g.
        // Cmd+W), which would make the indices captured at pointer-down stale
        const fromIdx = prev.findIndex((tb) => tb.id === drag.id);
        if (fromIdx < 0) return prev;
        const next = [...prev];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(Math.min(Math.max(drag.target, 0), next.length), 0, moved);
        return next;
      });
      void api.reorder(drag.id, drag.target);
    }
  };

  // document tabs are sibling WebContentsViews: they see neither this press
  // nor a focus change, so relay it for them to dismiss open popovers
  // (once per window: the first strip listens for all of them)
  useEffect(() => {
    if (!first) return;
    const notify = (): void => api.notifyChromePressed?.();
    document.addEventListener("pointerdown", notify, true);
    return () => document.removeEventListener("pointerdown", notify, true);
  }, [api, first]);

  // if the dragged tab is closed mid-drag (e.g. Cmd+W) its element unmounts
  // and pointerup/pointercancel never fire — clear the drag state ourselves
  useEffect(() => {
    const drag = dragRef.current;
    if (drag && !tabs.some((t) => t.id === drag.id)) {
      dragRef.current = null;
      setDragVisual(null);
    }
  }, [tabs]);

  // Trackpads scroll the strip natively; map a mouse's vertical wheel to
  // horizontal scrolling. Native listener because React registers wheel as
  // passive, which forbids preventDefault.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [api]);

  // keep the active tab in view — new tabs open at the far end of the strip
  const activeId = tabs.find((tab) => tab.active)?.id;
  useEffect(() => {
    // pointer-down activation runs while the user is pressing that tab — it is
    // already visible, and scrolling the strip mid-press would invalidate the
    // drag geometry sampled at pointer-down
    if (dragRef.current) return;
    stripRef.current?.querySelector(".tab-item.active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId]);

  const feedback = dragVisual
    ? dragVisual.tearOff
      ? "Release to open in a new window"
      : dragVisual.target2
        ? dragVisual.target2.label
        : dragVisual.away
          ? "Drop on a tab bar, or at the side of a group to split"
          : dragVisual.target !== dragVisual.from
            ? "Release to reorder"
            : "Drag to reorder, or to another group"
    : "";

  return (
    <div
      className="tab-bar"
      data-group-strip={groupId}
      data-focused={focused || undefined}
      data-first={first || undefined}
      style={style}
      onPointerDownCapture={() => {
        if (!focused) onFocusGroup?.();
      }}
    >
      <div className="tab-bar-drag-spacer" />
      {chromeControl}
      <div
        className={`tab-strip ${dragVisual ? "dragging" : ""} ${settling ? "settling" : ""} ${dragVisual?.away ? "targeting" : ""}`}
        ref={stripRef}
        role="tablist"
        aria-label="Tabs"
        data-item-drop={itemOver || undefined}
        // Items dragged from anywhere in the app: resting on a tab switches to it (so they can
        // be dropped inside it); dropped on the bar, they open in new tabs.
        onDragOver={(event) => {
          if (!hasItemDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setItemOver(true);
          const over = (event.target as HTMLElement).closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
          if (over !== springTab.current?.id) {
            clearTimeout(springTab.current?.timer);
            springTab.current = over ? { id: over, timer: setTimeout(() => void api.activate(over), 650) } : undefined;
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setItemOver(false);
          clearTimeout(springTab.current?.timer);
          springTab.current = undefined;
        }}
        onDrop={(event) => {
          setItemOver(false);
          clearTimeout(springTab.current?.timer);
          springTab.current = undefined;
          const items = readItemDrag(event.dataTransfer);
          if (!items.length) return;
          event.preventDefault();
          if (!focused) onFocusGroup?.();
          for (const item of items.slice(0, 8)) openItemAt(item, "tab", item.title);
        }}
      >
        {tabs.map((tab, index) => {
          // live transforms: the grabbed tab tracks the pointer; tabs between
          // the origin and the current target slide aside by the grabbed width
          let dragStyle: CSSProperties | undefined;
          if (dragVisual && !dragVisual.away) {
            if (dragVisual.id === tab.id) {
              dragStyle = { transform: `translateX(${dragVisual.dx}px)` };
            } else if (dragVisual.target <= index && index < dragVisual.from) {
              dragStyle = { transform: `translateX(${dragVisual.width}px)` };
            } else if (dragVisual.from < index && index <= dragVisual.target) {
              dragStyle = { transform: `translateX(-${dragVisual.width}px)` };
            }
          }
          return (
            <div
              key={tab.id}
              className={`tab-item ${tab.pinned ? "tab-pinned" : ""} ${tab.active ? "active" : ""} ${dragVisual?.id === tab.id ? "drag-source" : ""}`}
              role="tab"
              aria-selected={tab.active}
              aria-label={tab.title}
              tabIndex={tab.active ? 0 : -1}
              data-tab-id={tab.id}
              onKeyDown={(event) => {
                if (event.key === "Escape" && dragRef.current) {
                  event.preventDefault();
                  finishDrag(dragRef.current.pointerId, false);
                  return;
                }
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void api.activate(tab.id);
                }
                if ((event.key === "Delete" || event.key === "Backspace") && !event.metaKey) {
                  event.preventDefault();
                  if (tab.closable) void api.close(tab.id);
                }
                if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                  event.preventDefault();
                  void api.reorder(tab.id, index + (event.key === "ArrowLeft" ? -1 : 1));
                }
              }}
              title={tab.pinned ? `${tab.title} (pinned)` : tab.title}
              style={dragStyle}
              onContextMenu={(event) => {
                if (!api.showTabMenu) return;
                event.preventDefault();
                void api.showTabMenu(tab.id, event.clientX, event.clientY);
              }}
              // Middle-click closes the tab.
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                if (tab.closable) void api.close(tab.id);
              }}
              onPointerDown={(event) => {
                if (event.button === 1) event.preventDefault();
                if (event.button !== 0) return;
                if ((event.target as HTMLElement).closest(".tab-close")) return;
                // Chrome-style: pressing a tab activates it immediately, so
                // activation never depends on the click that a drag would eat
                const previous = tabs.find((t) => t.active)?.id;
                if (!tab.active || !focused) void api.activate(tab.id);
                const strip = stripRef.current;
                if (!strip) return;
                const rects = Array.from(strip.querySelectorAll<HTMLElement>(".tab-item"), (el) => el.getBoundingClientRect());
                dragRef.current = {
                  pointerId: event.pointerId,
                  previous,
                  startY: event.clientY,
                  strip: strip.getBoundingClientRect(),
                  id: tab.id,
                  from: index,
                  startX: event.clientX,
                  lefts: rects.map((r) => r.left),
                  widths: rects.map((r) => r.width),
                  target: index,
                  started: false,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag || event.pointerId !== drag.pointerId) return;
                let dx = event.clientX - drag.startX;
                // 5px dead zone so plain clicks never wiggle the tab
                if (!drag.started) {
                  if (Math.hypot(dx, event.clientY - drag.startY) < 5) return;
                  // re-sample geometry the moment the drag really starts — the
                  // pointer-down activation re-renders and could have moved tabs
                  const strip = stripRef.current;
                  if (strip) {
                    const rects = Array.from(strip.querySelectorAll<HTMLElement>(".tab-item"), (el) => el.getBoundingClientRect());
                    drag.lefts = rects.map((r) => r.left);
                    drag.widths = rects.map((r) => r.width);
                    drag.strip = strip.getBoundingClientRect();
                  }
                  drag.started = true;
                }
                const outside = event.clientX < 0 || event.clientY < 0 || event.clientX > window.innerWidth || event.clientY > window.innerHeight;
                // In this strip (with a little slack below it): reorder.
                const inStrip =
                  !outside &&
                  event.clientY <= drag.strip.bottom + 8 &&
                  event.clientX >= drag.strip.left - 8 &&
                  event.clientX <= drag.strip.right + 8;
                // keep the tab inside the strip
                const last = drag.lefts.length - 1;
                const minDx = drag.lefts[0] - drag.lefts[drag.from];
                const maxDx = drag.lefts[last] + drag.widths[last] - drag.widths[drag.from] - drag.lefts[drag.from];
                dx = Math.min(Math.max(dx, minDx), Math.max(minDx, maxDx));
                let target = drag.from;
                if (inStrip) {
                  for (let i = 0; event.clientX < drag.startX && i < drag.from; i++) {
                    if (event.clientX < drag.lefts[i] + drag.widths[i] / 2) {
                      target = i;
                      break;
                    }
                  }
                  for (let i = last; event.clientX > drag.startX && i > drag.from; i--) {
                    if (event.clientX > drag.lefts[i] + drag.widths[i] / 2) {
                      target = i;
                      break;
                    }
                  }
                  // Pinned tabs reorder among themselves, the others after them.
                  const pinnedCount = tabs.filter((tb) => tb.pinned).length;
                  target = tabs[drag.from]?.pinned ? Math.min(target, pinnedCount - 1) : Math.max(target, pinnedCount);
                }
                // Elsewhere in the window: another group's strip, or a group's content.
                const located = !inStrip && !outside ? locateDrop?.(event.clientX, event.clientY, { tabId: drag.id, groupId }) : undefined;
                const overContent = Boolean(located?.content);
                if (overContent !== Boolean(drag.overContent)) {
                  drag.overContent = overContent;
                  onContentDrag?.(overContent);
                  // Over the content, the group shows the tab it showed before this drag.
                  if (overContent && drag.previous && drag.previous !== drag.id && tabs.length > 1) void api.activate(drag.previous);
                }
                // Out of the window: a tab of its own in a new window (not the window's only tab).
                drag.tearOff = outside && Boolean(api.tearOff) && !lone;
                drag.drop = drag.tearOff ? undefined : located?.drop;
                drag.target = target;
                setDragVisual({
                  id: drag.id,
                  dx: inStrip ? dx : 0,
                  from: drag.from,
                  target,
                  width: drag.widths[drag.from],
                  pointerX: event.clientX,
                  away: !inStrip,
                  target2: drag.tearOff ? undefined : located,
                  tearOff: drag.tearOff,
                });
              }}
              onPointerUp={(event) => finishDrag(event.pointerId, true)}
              onPointerCancel={(event) => finishDrag(event.pointerId, false)}
              onLostPointerCapture={(event) => finishDrag(event.pointerId, false)}
            >
              {/* highlight plate behind the content — hover capsule / active body */}
              <span className="tab-plate" aria-hidden="true" />
              <span className="tab-icon">{tab.favicon ? <img className="key-favicon" src={tab.favicon} alt="" draggable={false} /> : KIND_ICON[tab.kind] || KIND_ICON.page}</span>
              {!tab.pinned && <span className="tab-title">{tab.title}</span>}
              {tab.closable && (
                <button
                  className="tab-close"
                  title={t("closeTab")}
                  aria-label={t("closeTab")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void api.close(tab.id);
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
          );
        })}
        <button
          className="tab-new-btn"
          title={t("newTab")}
          aria-label={t("newTab")}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            void api.showNewMenu(Math.round(rect.left), Math.round(rect.bottom));
          }}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {trailingControls}
      <button
        className="tab-overflow-btn"
        title={t("tabList")}
        aria-label={t("tabList")}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          void api.showMenu(Math.round(rect.left), Math.round(rect.bottom));
        }}
      >
        <Icon name="tabs" size={16} />
      </button>
      {dragVisual &&
        createPortal(
          <>
            <div
              className="tab-drop-feedback"
              role="status"
              aria-live="polite"
              style={{ left: Math.max(12, Math.min(window.innerWidth - 280, dragVisual.pointerX - 110)) }}
            >
              {feedback}
              <small>Esc to cancel</small>
            </div>
            {/* Out of the strip's stacking context, above the still frames of native views. */}
            {dragVisual.target2?.preview && (
              <div
                className="key-pane-drop-preview"
                aria-hidden="true"
                style={{
                  left: dragVisual.target2.preview.x + 4,
                  top: dragVisual.target2.preview.y + 4,
                  width: Math.max(0, dragVisual.target2.preview.width - 8),
                  height: Math.max(0, dragVisual.target2.preview.height - 8),
                }}
              />
            )}
            {dragVisual.target2?.marker && (
              <div className="key-tab-insert-marker" aria-hidden="true" style={{ left: dragVisual.target2.marker.x - 1 }} />
            )}
          </>,
          document.body,
        )}
    </div>
  );
}
