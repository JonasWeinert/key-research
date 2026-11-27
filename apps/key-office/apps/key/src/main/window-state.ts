import { mkdir, open, readFile, rename } from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/** Enough to open a view again: never its live content or drafts. */
export type SavedView =
  | { type: "home" }
  | {
      type: "content";
      section: "sources" | "records" | "record" | "note" | "source" | "webpage" | "canvas" | "search" | "inbox" | "databases" | "file" | "person" | "venue" | "topic" | "tag" | "review";
      workspaceId?: string;
      projectId?: string;
      noteId?: string;
      canvasId?: string;
      fileId?: string;
      entityId?: string;
      sourceId?: string;
      recordId?: string;
      title: string;
    }
  | { type: "pdf"; workspaceId: string; hash: string; title: string }
  | { type: "office"; kind: string; path: string; workspaceId?: string }
  /** A browser tab, and a PDF opened from the browser (kept for a while, not in a library). */
  | { type: "web"; url: string; title: string }
  | { type: "web-pdf"; url: string; hash: string; title: string };
export interface SavedTab {
  view: SavedView;
  pinned?: boolean;
  /** A reader's docked details-and-notes panel, and its share of the tab. */
  panel?: { view: SavedView; ratio: number };
}
export interface SavedGroup {
  tabs: SavedTab[];
  /** Which tab the group showed. */
  active: number;
  /** The group's share of the window's width. */
  size: number;
}
export interface SavedTabs {
  /** Editor groups, left to right. */
  groups: SavedGroup[];
  /** Which group had focus. */
  active: number;
}
export interface SavedWindow {
  workspaceId: string;
  bounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
  fullScreen?: boolean;
  sidebarWidth?: number;
  tabs: SavedTabs;
}
export interface WindowState {
  version: 2;
  /** Open windows, front-most first. */
  windows: SavedWindow[];
  /** The arrangement last left behind in each workspace, for switching back. */
  layouts: Record<string, SavedTabs>;
  /** Workspace ids, most recently used first. */
  recent: string[];
}

const empty = (): WindowState => ({ version: 2, windows: [], layouts: {}, recent: [] });
const MAX_DEPTH = 8;

const validView = (value: any): value is SavedView => !!value && typeof value === "object" && typeof value.type === "string";
const validTab = (t: any): t is SavedTab =>
  !!t && validView(t.view) && (t.panel === undefined || (validView(t.panel?.view) && Number.isFinite(t.panel.ratio)));
/** The views of a version 1 tab, which could hold a split of views, in reading order. */
function legacyViews(value: any, depth = 0): SavedView[] | undefined {
  if (!value || typeof value !== "object" || depth > MAX_DEPTH) return undefined;
  if ("view" in value) return validView(value.view) ? [value.view] : undefined;
  if (value.split !== "row" && value.split !== "column") return undefined;
  const a = legacyViews(value.a, depth + 1),
    b = legacyViews(value.b, depth + 1);
  return a && b ? [...a, ...b] : undefined;
}
/** A saved arrangement, or undefined when it is unreadable. A version 1 split tab comes back
 * as its views, each a tab of its own, in its place. */
export function readSavedTabs(value: any): SavedTabs | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value.groups)) {
    const groups: SavedGroup[] = value.groups
      .filter((g: any) => g && Array.isArray(g.tabs) && g.tabs.length <= 200 && g.tabs.every(validTab))
      .slice(0, 16)
      .map((g: any) => ({
        tabs: g.tabs,
        active: Number.isInteger(g.active) ? g.active : 0,
        size: Number.isFinite(g.size) && g.size > 0 ? g.size : 1,
      }));
    return groups.length ? { groups, active: Number.isInteger(value.active) ? value.active : 0 } : undefined;
  }
  if (!Array.isArray(value.tabs) || value.tabs.length > 200) return undefined;
  const tabs: SavedTab[] = [];
  let active = 0;
  for (const [index, t] of value.tabs.entries()) {
    const views = t && legacyViews(t.layout);
    if (!views) return undefined;
    if (index === value.active) active = tabs.length + Math.min(Math.max(0, Number(t.active) || 0), views.length - 1);
    for (const view of views) tabs.push({ view, ...(t.pinned === true ? { pinned: true } : {}) });
  }
  return { groups: [{ tabs, active, size: 1 }], active: 0 };
}

/** `window-state.json`: written atomically shortly after changes, and synchronously at quit. */
export class WindowStateStore {
  private state = empty();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: () => WindowState;
  constructor(private readonly file: string) {}
  async load(): Promise<WindowState> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      if (data?.version !== 1 && data?.version !== 2) throw Error("Unknown window state version");
      this.state = {
        version: 2,
        windows: (Array.isArray(data.windows) ? data.windows : [])
          .flatMap((w: any) => {
            const tabs = w && typeof w.workspaceId === "string" ? readSavedTabs(w.tabs) : undefined;
            return tabs ? [{ ...w, tabs }] : [];
          })
          .slice(0, 16),
        layouts: Object.fromEntries(
          Object.entries(data.layouts ?? {}).flatMap(([id, value]) => {
            const tabs = readSavedTabs(value);
            return tabs ? [[id, tabs]] : [];
          }),
        ) as Record<string, SavedTabs>,
        recent: (Array.isArray(data.recent) ? data.recent : []).filter((id: unknown) => typeof id === "string").slice(0, 32),
      };
    } catch {
      // A missing or unreadable file starts fresh; it is only a convenience.
      this.state = empty();
    }
    return this.get();
  }
  get(): WindowState {
    return structuredClone(this.state);
  }
  /** Replaces the state; `build` runs when the debounced write happens, so it sees the latest windows. */
  schedule(build: () => WindowState) {
    this.pending = build;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 400);
  }
  async flush() {
    clearTimeout(this.timer);
    const build = this.pending;
    this.pending = undefined;
    if (!build) return;
    this.state = build();
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(this.state));
    } finally {
      await handle.close();
    }
    await rename(temp, this.file);
  }
  /** At quit there is no time for async work. */
  writeNow(state: WindowState) {
    clearTimeout(this.timer);
    this.pending = undefined;
    this.state = state;
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch {
      // Losing the arrangement must never block quitting.
    }
  }
}
