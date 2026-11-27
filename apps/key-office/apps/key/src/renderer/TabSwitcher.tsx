// The Ctrl-Tab overlay: the window's tabs, most recently used first, each with a number to jump
// to. Main reads the keys (main/tab-switcher.ts) wherever focus is and sends what to draw; this
// draws it and reports clicks. While it shows, native views stand still as pictures under it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { TabKindIcon } from "./tab-strip";
import { rowBadge } from "../shared/tab-switcher";
import "./tab-switcher.css";

type Frame = { id: string; x: number; y: number; width: number; height: number; image: string };

export interface SwitcherTab {
  id: string;
  groupId: string;
  pinned?: boolean;
  title: string;
  views: { kind: string; title: string; favicon?: string; web?: { host?: string } }[];
}

type Shown = { order: string[]; selected: number; sticky: boolean; frames: Frame[] };

const bridge = () =>
  (window as unknown as { key: { on(event: string, cb: (value: unknown) => void): () => void; tabAction(action: string, args?: Record<string, unknown>): Promise<unknown> } }).key;

const KIND_LABEL: Record<string, string> = {
  pdf: "PDF",
  web: "Web page",
  note: "Note",
  canvas: "Canvas",
  search: "Search",
  library: "Library",
  records: "Library",
  database: "Database",
  inbox: "Inbox",
  source: "Source",
  page: "Page",
  home: "Home",
};

function contextLine(tab: SwitcherTab, groups: string[], current: boolean) {
  const view = tab.views[0];
  const parts = [view?.kind === "web" && view.web?.host ? view.web.host : (KIND_LABEL[view?.kind ?? ""] ?? "Page")];
  if (groups.length > 1) {
    const at = groups.indexOf(tab.groupId);
    parts.push(groups.length === 2 ? (at === 0 ? "Left group" : "Right group") : `Group ${at + 1}`);
  }
  if (tab.pinned) parts.push("Pinned");
  if (current) parts.push("Current tab");
  return parts.join(" · ");
}

export function TabSwitcher({ tabs, groups }: { tabs: SwitcherTab[]; groups: string[] }) {
  const [shown, setShown] = useState<Shown>();
  const list = useRef<HTMLDivElement>(null);
  // Main reads the keys of a session (it cannot cancel them without losing Ctrl's key-up), so
  // the page swallows them here, before an editor or the page's own shortcuts see them.
  const running = useRef(false);
  useEffect(() => {
    const swallow = (event: KeyboardEvent) => {
      const start = event.type === "keydown" && event.key === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey;
      if (!running.current && !start) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    for (const type of ["keydown", "keypress", "keyup", "beforeinput"]) window.addEventListener(type, swallow as EventListener, true);
    return () => {
      for (const type of ["keydown", "keypress", "keyup", "beforeinput"]) window.removeEventListener(type, swallow as EventListener, true);
    };
  }, []);
  useEffect(
    () =>
      bridge().on("tab-switcher", (value) => {
        const event = value as { phase: string; order?: string[]; selected?: number; sticky?: boolean; frames?: Frame[] };
        if (event.phase === "start") return void (running.current = true);
        if (event.phase === "end") {
          // Ctrl's key-up and the last key's arrive after the session: swallow those too.
          setTimeout(() => (running.current = false), 60);
          return setShown(undefined);
        }
        running.current = true;
        setShown((before) => ({
          order: event.order ?? before?.order ?? [],
          selected: event.selected ?? 0,
          sticky: Boolean(event.sticky),
          frames: event.phase === "show" ? (event.frames ?? []) : (before?.frames ?? []),
        }));
      }),
    [],
  );
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [shown?.selected, shown?.order]);
  if (!shown) return null;
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const rows = shown.order.map((id) => byId.get(id)).filter((t): t is SwitcherTab => !!t);
  const act = (op: string, args: Record<string, unknown> = {}) => void bridge().tabAction("tab-switcher", { op, ...args }).catch(() => {});
  return createPortal(
    <>
      {shown.frames.map((frame) => (
        <img key={frame.id} className="key-native-overlay-frame" alt="" draggable={false} src={frame.image} style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }} />
      ))}
      <div className="kx-switcher-backdrop" onPointerDown={() => act("cancel")} />
      <div className="kx-switcher" role="dialog" aria-label="Open tabs" data-sticky={shown.sticky || undefined}>
        <div className="kx-switcher-head">
          <span>{rows.length === 1 ? "1 open tab" : `${rows.length} open tabs`}</span>
        </div>
        <div ref={list} className="kx-switcher-list" role="listbox" aria-label="Tabs, most recent first">
          {rows.map((tab, index) => {
            const view = tab.views[0];
            const badge = rowBadge(index);
            return (
              <div
                key={tab.id}
                className="kx-switcher-row"
                role="option"
                data-tab-id={tab.id}
                aria-selected={index === shown.selected}
                onPointerMove={() => index !== shown.selected && act("select", { index })}
                onClick={() => act("pick", { tabId: tab.id })}
              >
                <span className="kx-switcher-badge" aria-hidden={!badge}>
                  {badge}
                </span>
                <span className="kx-switcher-glyph" aria-hidden="true">
                  {view?.favicon ? <img src={view.favicon} alt="" draggable={false} /> : <TabKindIcon kind={view?.kind ?? "home"} />}
                </span>
                <span className="kx-switcher-text">
                  <span className="kx-switcher-title">{tab.title}</span>
                  <span className="kx-switcher-context">{contextLine(tab, groups, index === 0)}</span>
                </span>
                {!tab.pinned && (
                  <button
                    type="button"
                    className="kx-switcher-close"
                    tabIndex={-1}
                    title="Close tab (W)"
                    aria-label={`Close ${tab.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      act("close-tab", { tabId: tab.id });
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="kx-switcher-foot">
          {shown.sticky ? (
            <>
              <span><kbd>↑↓</kbd> move</span>
              <span><kbd>↩</kbd> open</span>
            </>
          ) : (
            <>
              <span><kbd>⇥</kbd> next</span>
              <span>release <kbd>⌃</kbd> to open</span>
            </>
          )}
          <span><kbd>1</kbd>–<kbd>0</kbd> jump</span>
          <span><kbd>W</kbd> close</span>
          <span><kbd>esc</kbd> cancel</span>
        </div>
      </div>
    </>,
    document.body,
  );
}
