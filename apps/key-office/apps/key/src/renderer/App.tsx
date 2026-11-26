import { Button, Input } from "@key/design-system";
import { Icon, type IconName } from "./icons";
import { ModelProgressPill, useModelProgress } from "./model-progress";
import Onboarding from "./Onboarding";
import { notesChanged } from "./NotePage";
import { markdownToPlainText } from "./note-editor";
import Settings, { type SettingsSection } from "./Settings";
import { bridge, type AppInfo, type AppSettings, type Note } from "./library-api";
import { GlobalDrawerHost, GlobalDialog } from "./GlobalDrawer";
import type { SearchPreviewState } from "./search-preview";
import { TabBar, type DropTarget, type TabDrop, type TabSummary, type TabsApi } from "./TabBar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LibrarySource, type LibraryHit } from "./LibraryHome";
import "./shell.css";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import CollectionTree from "./CollectionTree";
import { sidebarClick } from "./sidebar-intent";
import { dismissAll, useDismiss, within } from "@key-reader/ui/dismiss";
import { ROW_PX } from "./sidebar-budget";
import WorkspaceSection, { type WorkspaceEntry } from "./WorkspaceSection";
import { hasExternalDrop, hasItemDrag, importDrop, inboxCollection, readItemDrag, setItemDrag } from "./item-links";
import { describeCount, sendToCanvas, sendToNote, setShellContext, toast } from "./item-actions";
import { ItemLayer, onShowInInspector, selectItems, useSelectedItems } from "./item-ui";
import Inspector from "./Inspector";
import CommandCenter from "./CommandCenter";
import type { DraggedItem } from "./note-editor";
import WorkspaceContent, { type ContentSpec } from "./WorkspaceContent";
import { BrowserBar, type WebBarState } from "./BrowserBar";
import { GROUP_GAP, MAX_GROUPS, TAB_STRIP_HEIGHT, dragGroupSash, groupBody, layoutGroups, layoutPanel, type Rect } from "../shared/tab-model";
interface Workspace {
  id: string;
  name: string;
  root: string;
  icon?: string;
  color?: string;
}
interface Project {
  id: string;
  name: string;
  folder: string;
}
interface RecordItem {
  id: string;
  kind: string;
  documentHash?: string;
  title: string;
  body: string;
  properties: Record<string, unknown>;
  revision: number;
  workspaceId?: string;
}
interface ViewState {
  id: string;
  title: string;
  kind: string;
  workspaceId?: string;
  content?: ContentSpec;
  /** Titles of what this view showed before (oldest first), and the next one forward. */
  back?: string[];
  forward?: string;
  /** Bumped each time a link is followed in this view (or Back/Forward). */
  nav?: number;
  /** A browser tab: its bar, and the site's icon for its tab. */
  web?: WebBarState;
  favicon?: string;
}
/** Main's snapshot of this window (see `snapshot` in main/index.ts). */
interface TabState {
  searchPreview?: SearchPreviewState;
  /** The workspace this window shows; other windows' workspaces for the switcher. */
  workspaceId?: string;
  windowId?: string;
  windowCount?: number;
  windows?: { windowId: string; workspaceId: string }[];
  /** Editor groups, left to right. */
  groups: { id: string; size: number; activeTabId: string | null; tabIds: string[] }[];
  activeGroupId?: string;
  /** Every group's tabs; each shows one view, and a reader may carry its details-and-notes panel. */
  tabs: {
    id: string;
    groupId: string;
    pinned?: boolean;
    title: string;
    views: ViewState[];
    panel?: ViewState & { ratio: number };
  }[];
  /** The focused group's tab, and the view with focus (that tab's view, or its panel). */
  activeTabId: string;
  activeViewId: string;
}
const api = () =>
  (
    window as unknown as {
      key: {
        invoke: <T>(
          command: string,
          args?: Record<string, unknown>,
          workspaceId?: string,
        ) => Promise<T>;
        workspaces: () => Promise<Workspace[]>;
        addWorkspace: () => Promise<Workspace | null>;
        openSources: (workspaceId?: string) => Promise<void>;
        openSource: (
          source: LibrarySource,
          hit?: LibraryHit,
          results?: LibraryHit[],
        ) => Promise<void>;
        tabs: () => Promise<TabState>;
        tabAction: (
          action: string,
          payload?: Record<string, unknown>,
        ) => Promise<void>;
        on: (
          event: string,
          callback: (...args: unknown[]) => void,
        ) => () => void;
      };
    }
  ).key;
// The sidebar can be dragged between these widths; below the minimum its rows stop being readable.
const SIDEBAR_MIN = 180,
  SIDEBAR_MAX = 360,
  SIDEBAR_DEFAULT = 240;
const clampSidebar = (width: number) => Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width)));

const emptyTabs: TabState = { groups: [], tabs: [], activeTabId: "", activeViewId: "" };
/** A third of a group, at most this many pixels, from its side opens a new group there. */
const EDGE_BAND = 140;
const SASH_STEP = 0.025;
const INSPECTOR_WIDTH = 300;

/** The item a content pane shows, for the inspector when nothing is selected. */
function paneItem(content?: ContentSpec, title?: string): DraggedItem | undefined {
  if (!content) return undefined;
  const name = title ?? "Untitled";
  if (content.section === "note" && content.noteId) return { kind: "note", id: content.noteId, title: name };
  if (content.section === "canvas" && content.canvasId) return { kind: "canvas", id: content.canvasId, title: name };
  if (content.section === "source" && content.sourceId) return { kind: "source", id: content.sourceId, title: name };
  if (content.section === "record" && content.record?.id) return { kind: "record", id: content.record.id, title: name };
  if (content.section === "file" && content.fileId) return { kind: "file", id: content.fileId, title: name };
  if ((content.section === "person" || content.section === "venue" || content.section === "topic") && content.entityId) return { kind: content.section, id: content.entityId, title: name };
  return undefined;
}
/** What a pane shows, so the selection follows it when that changes. */
const contentIdentity = (content?: ContentSpec) =>
  content ? [content.section, content.noteId ?? content.canvasId ?? content.sourceId ?? content.entityId ?? content.record?.id ?? content.workspaceId ?? ""].join(":") : "";

/** Each group's strip, as its TabBar shows it. */
const groupSummaries = (state: TabState) =>
  new Map(
    state.groups.map((group) => [
      group.id,
      state.tabs
        .filter((tab) => tab.groupId === group.id)
        .map(
          (tab): TabSummary => ({
            id: tab.id,
            title: tab.title,
            kind: (tab.views[0]?.kind as TabSummary["kind"]) || "home",
            favicon: tab.views[0]?.favicon,
            active: tab.id === group.activeTabId,
            closable: !tab.pinned,
            pinned: Boolean(tab.pinned),
          }),
        ),
    ]),
  );
const groupApis = new Map<string, TabsApi>();
/** A group's strip acts on main through this (one object per group, so effects keyed on it stay put). */
function groupApi(groupId: string): TabsApi {
  let made = groupApis.get(groupId);
  if (!made) {
    made = {
      activate: (tabId) => api().tabAction("activate", { tabId }),
      close: (tabId) => api().tabAction("close", { tabId }),
      reorder: (tabId, index) => api().tabAction("reorder", { tabId, index }),
      showNewMenu: () => api().tabAction("new", { groupId }),
      showMenu: (x, y) => api().tabAction("tab-menu", { x, y, groupId }),
      showTabMenu: (tabId, x, y) => api().tabAction("tab-context-menu", { tabId, x, y }),
      dropTab: (drop) => api().tabAction("drop-tab", drop as unknown as Record<string, unknown>),
      tearOff: (tabId) => api().tabAction("tear-off", { tabId }),
      notifyChromePressed: () => {
        void api().tabAction("chrome-pressed");
      },
    };
    groupApis.set(groupId, made);
  }
  return made;
}
export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [workspaceId, setWorkspaceId] = useState<string>();
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState<string>();
  const [records, setRecords] = useState<RecordItem[]>([]),
    [tabs, setTabs] = useState<TabState>(emptyTabs);
  const [section, setSection] = useState("sources"),
    [record, setRecord] = useState<RecordItem>();
  const [error, setError] = useState(""),
    [refreshKey, setRefreshKey] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("key.sidebar.collapsed") === "true",
  );
  const sidebarSlot = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(sidebarCollapsed ? 0 : 240);
  // The open width the user dragged to, remembered; the slot animates between it and 0.
  const [sidebarSize, setSidebarSize] = useState(() =>
    clampSidebar(Number(localStorage.getItem("key.sidebar.width")) || SIDEBAR_DEFAULT),
  );
  const [sidebarResizing, setSidebarResizing] = useState(false);
  useEffect(() => {
    localStorage.setItem("key.sidebar.width", String(sidebarSize));
  }, [sidebarSize]);
  useEffect(() => {
    localStorage.setItem("key.sidebar.collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  useEffect(() => {
    const node = sidebarSlot.current;
    if (!node) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = Math.round(node.getBoundingClientRect().width);
        setSidebarWidth(width);
        void api().tabAction("sidebar-width", { width });
      });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  // The content area's size, which native views and DOM panes share.
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  // A sash being dragged (between groups, or a reader and its panel): what is shown until
  // main confirms it. Main moves native views once per frame meanwhile.
  const [dragSizes, setDragSizes] = useState<number[]>();
  const [dragPanel, setDragPanel] = useState<{ tabId: string; viewId: string; ratio: number }>();
  const sashFrame = useRef<number | null>(null);
  const sashPending = useRef<() => void>(undefined);
  const sashDragging = useRef(false);
  /** Sends the latest sash position to main at most once a frame. */
  const sendSash = (send: () => void) => {
    sashPending.current = send;
    if (sashFrame.current === null)
      sashFrame.current = requestAnimationFrame(() => {
        sashFrame.current = null;
        sashPending.current?.();
      });
  };
  const [createMenu, setCreateMenu] = useState(false),
    [dialog, setDialog] = useState<"project" | "folder" | null>(null),
    [dialogValue, setDialogValue] = useState("");

  useDismiss(createMenu, {
    refs: [],
    inside: (target) => within(target, ".key-create-menu, [aria-label='Create item']"),
    anchor: () => document.querySelector("[aria-label='Create item']"),
    onDismiss: () => setCreateMenu(false),
  });
  const invoke = useCallback(
    <T,>(command: string, args?: Record<string, unknown>, id?: string) =>
      api().invoke<T>(command, args, id),
    [],
  );
  const task = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    }
  };
  const action = (name: string, payload?: Record<string, unknown>) =>
    void task(() => api().tabAction(name, payload));
  // App preferences, Settings and the first-run welcome.
  const [prefs, setPrefs] = useState<{ settings: AppSettings; info: AppInfo }>();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>();
  const [welcome, setWelcome] = useState(false);
  useEffect(() => {
    void bridge()
      .appSettings()
      .then((loaded) => {
        setPrefs(loaded);
        if (!loaded.settings.onboarded) setWelcome(true);
      })
      .catch((e) => setError(String(e)));
    return api().on("open-settings", () => setSettingsSection("general"));
  }, []);
  const updatePrefs = (patch: Partial<AppSettings>) =>
    void bridge()
      .setAppSettings(patch)
      .then((settings) => setPrefs((p) => p && { ...p, settings }))
      .catch((e) => setError(String(e)));
  const refreshWorkspaces = () => void api().workspaces().then(setWorkspaces).catch(() => {});
  useEffect(() => {
    void task(async () => {
      setWorkspaces(await api().workspaces());
      setTabs(await api().tabs());
    });
    const a = api().on("tabs-changed", () => {
      void api()
        .tabs()
        .then(setTabs)
        .catch((e) => setError(String(e)));
    });
    const b = api().on("library-changed", () => {
      setRefreshKey((k) => k + 1);
      void api().workspaces().then(setWorkspaces).catch(() => {});
    });
    return () => {
      a();
      b();
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setProjects([]);
    setRecords([]);
    if (!workspaceId) return;
    void Promise.all([
      invoke<Project[]>("workspace_projects", {}, workspaceId),
      invoke<RecordItem[]>(
        "workspace_records",
        { projectId: projectId || null, limit: 500, offset: 0 },
        workspaceId,
      ),
    ])
      .then(([p, r]) => {
        if (!cancelled) {
          setProjects(p);
          setRecords(r);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [invoke, workspaceId, projectId, refreshKey]);
  const chooseScope = (id?: string, project?: string) => {
    setWorkspaceId(id);
    setProjectId(project);
    action("open-content", {
      section: "sources",
      workspaceId: id,
      projectId: project,
    });
  };
  const selectRecord = (r: RecordItem) => {
    if (r.documentHash) {
      void task(() =>
        api().openSource({
          documentId: r.documentHash!,
          documentHash: r.documentHash!,
          title: r.title,
          status: "indexed",
          pageCount: 0,
          completed: 0,
          total: 0,
          workspaceId: r.workspaceId || workspaceId,
        }),
      );
      return;
    }
    if (r.properties?.path && r.properties?.editor) {
      action("open-office-record", {
        recordId: r.id,
        workspaceId: r.workspaceId || workspaceId,
      });
      return;
    }
    action("open-content", {
      section: "record",
      workspaceId: r.workspaceId || workspaceId,
      projectId,
      record: r,
    });
  };
  // Standalone notes (key-store), listed in the sidebar and opened as tabs.
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    if (!workspaceId) return setNotes([]);
    const load = () => void invoke<Note[]>("store_notes", {}, workspaceId).then(setNotes).catch(() => setNotes([]));
    load();
    window.addEventListener("key:notes-changed", load);
    return () => window.removeEventListener("key:notes-changed", load);
  }, [invoke, workspaceId, refreshKey]);
  const openNote = (note: Pick<Note, "id" | "title">) =>
    action("open-content", { section: "note", workspaceId, noteId: note.id, title: note.title });
  const newNote = async () => {
    setCreateMenu(false);
    if (!workspaceId) throw Error("Choose a workspace to create a note.");
    const note = await invoke<Note>("store_note_save", { id: null, sourceId: null, title: "", body: "" }, workspaceId);
    notesChanged();
    openNote(note);
    return note;
  };
  const createNote = () => void task(async () => void (await newNote()));
  // Canvases (key-store), listed under the notes and opened as tabs.
  const [canvases, setCanvases] = useState<{ id: string; title: string; updatedAt?: number }[]>([]);
  useEffect(() => {
    if (!workspaceId) return setCanvases([]);
    const load = () => void invoke<{ id: string; title: string }[]>("store_canvases", {}, workspaceId).then(setCanvases).catch(() => setCanvases([]));
    load();
    window.addEventListener("key:canvases-changed", load);
    return () => window.removeEventListener("key:canvases-changed", load);
  }, [invoke, workspaceId, refreshKey]);
  const openCanvas = (canvas: { id: string; title: string }) =>
    action("open-content", { section: "canvas", workspaceId, canvasId: canvas.id, title: canvas.title });
  const createCanvas = () =>
    void task(async () => {
      setCreateMenu(false);
      if (!workspaceId) throw Error("Choose a workspace to create a canvas.");
      const canvas = await invoke<{ id: string; title: string }>("store_canvas_save", { id: null, title: "", doc: { version: 1, nodes: [], edges: [] } }, workspaceId);
      window.dispatchEvent(new Event("key:canvases-changed"));
      openCanvas(canvas);
    });
  const createRecord = (kind: string) => {
    if (kind === "note") return createNote();
    if (kind === "canvas") return createCanvas();
    setCreateMenu(false);
    if (!workspaceId) {
      setError("Choose a workspace to create an item.");
      return;
    }
    action("open-content", {
      section: "record",
      workspaceId,
      projectId,
      record: {
        id: "",
        kind,
        title: "",
        body: "",
        properties: {},
        revision: 0,
      },
    });
  };
  // The model is shared by every workspace, so any host can report it.
  const model = useModelProgress(invoke, workspaceId || workspaces[0]?.id);
  const selectedWorkspace = workspaces.find((w) => w.id === workspaceId),
    selectedProject = projects.find((p) => p.id === projectId);
  // Once main has the sizes a sash was dragged to, its snapshot takes over again.
  useEffect(() => {
    if (sashDragging.current) return;
    setDragSizes(undefined);
    setDragPanel(undefined);
  }, [tabs]);
  const summaries = useMemo(() => groupSummaries(tabs), [tabs]);
  const activeTab = tabs.tabs.find((t) => t.id === tabs.activeTabId),
    activeView = activeTab && [activeTab.views[0], activeTab.panel].find((v) => v?.id === tabs.activeViewId);
  // The sidebar shows the window's workspace; the focused view only picks the project
  // and highlights its row (a view from another workspace changes neither).
  useEffect(() => {
    if (tabs.workspaceId) setWorkspaceId(tabs.workspaceId);
  }, [tabs.workspaceId]);
  useEffect(() => {
    const own = (activeView?.content?.workspaceId ?? activeView?.workspaceId) === tabs.workspaceId;
    if (activeView?.content) {
      setProjectId(own ? activeView.content.projectId : undefined);
      setSection(activeView.content.section);
      setRecord(activeView.content.record);
    } else if (activeView) {
      setProjectId(undefined);
      setRecord(undefined);
      setSection("");
    }
  }, [activeView?.id, activeView?.content?.record?.id, tabs.workspaceId]);
  // A sidebar canvas or note takes dropped items without being opened.
  const [dropOver, setDropOver] = useState<string>();
  const [inboxDrop, setInboxDrop] = useState(false);
  const dropTarget = (target: { kind: "canvas" | "note"; id: string; title: string }) => ({
    "data-drop-over": dropOver === `${target.kind}:${target.id}` || undefined,
    "data-drop-label": target.kind === "canvas" ? `Add to ${target.title}` : `Link in ${target.title} · ⌥ embed · ⌘ cite`,
    onDragOver: (e: React.DragEvent) => {
      if (!hasItemDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropOver(`${target.kind}:${target.id}`);
    },
    onDragLeave: (e: React.DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropOver(undefined),
    onDrop: (e: React.DragEvent) => {
      setDropOver(undefined);
      const items = readItemDrag(e.dataTransfer).filter((item) => !(item.kind === target.kind && item.id === target.id));
      if (!items.length || !workspaceId) return;
      e.preventDefault();
      const mode = e.altKey ? "embed" : e.metaKey || items.every((i) => i.anchor?.startsWith("highlight:")) ? "cite" : "link";
      void (target.kind === "canvas" ? sendToCanvas(invoke, workspaceId, target.id, items) : sendToNote(invoke, workspaceId, target.id, items, mode))
        .then((undo) => toast(`${target.kind === "canvas" ? "Added" : mode === "embed" ? "Embedded" : mode === "cite" ? "Cited" : "Linked"} ${describeCount(items)} ${target.kind === "canvas" ? "to" : "in"} ${target.title}`, undo))
        .catch((error) => toast(String(error)));
    },
  });
  // The shared item layer acts in this window's workspace and focused pane.
  useEffect(() => setShellContext({ invoke, workspaceId, viewId: tabs.activeViewId }), [invoke, workspaceId, tabs.activeViewId]);
  // Switching a group's tab (by keyboard, menu or code) closes menus and popovers.
  const shownTabs = tabs.groups.map((g) => g.activeTabId).join();
  useEffect(() => dismissAll("switch"), [shownTabs]);
  // A pane that gains focus is what's selected until something inside it is.
  useEffect(() => {
    const own = paneItem(activeView?.content, activeView?.title?.replace(/ •$/, ""));
    selectItems(own ? [own] : []);
  }, [activeView?.id, contentIdentity(activeView?.content)]);
  const selected = useSelectedItems();
  const [inspectorOpen, setInspectorOpen] = useState(() => localStorage.getItem("key.inspector.open") === "true");
  const inspectorWidth = inspectorOpen ? INSPECTOR_WIDTH : 0;
  useEffect(() => {
    localStorage.setItem("key.inspector.open", String(inspectorOpen));
    void api().tabAction("inspector-width", { width: inspectorWidth });
  }, [inspectorOpen, inspectorWidth]);
  useEffect(() => onShowInInspector(() => setInspectorOpen(true)), []);
  // The browser's quiet notes: a finished download, a PDF that could not be opened.
  useEffect(() => api().on("browser-notice", (value) => toast(String((value as { message?: string })?.message ?? ""))), []);
  useEffect(() => api().on("toggle-inspector", () => setInspectorOpen((open) => !open)), []);
  const switchWorkspace = (id: string, newWindow = false) =>
    task(() => api().tabAction("switch-workspace", { workspaceId: id, newWindow }));
  const [switcherRequest, setSwitcherRequest] = useState(0);
  useEffect(() => api().on("open-workspace-switcher", () => setSwitcherRequest((n) => n + 1)), []);
  // Cmd-Option-arrows into a DOM pane: focus lands inside it.
  useEffect(
    () =>
      api().on("focus-pane", (id) => {
        const pane = document.querySelector<HTMLElement>(`[data-content-view="${id}"]`);
        const target =
          pane?.querySelector<HTMLElement>("input, textarea, [contenteditable='true'], button, [tabindex]:not([tabindex='-1'])") ?? pane;
        target?.focus({ preventScroll: true });
      }),
    [],
  );
  // Editor groups side by side, in pixels from the content area's left edge (right of the
  // sidebar) and the window's top. Main places native views with the same function and numbers.
  const contentWidth = Math.max(0, viewport.width - sidebarWidth - inspectorWidth);
  const laidOut = layoutGroups(
    tabs.groups.map((g, i) => ({ id: g.id, size: dragSizes?.[i] ?? g.size })),
    { x: 0, y: 0, width: contentWidth, height: viewport.height },
  );
  const groupRect = (groupId: string) => laidOut.groups.find((g) => g.id === groupId);
  /** Where each shown tab's view (and a reader's panel) sits. */
  const placed = new Map<string, Rect>();
  const panels: { tabId: string; readerId: string; panelId: string; sash: Rect; body: Rect; ratio: number }[] = [];
  for (const group of tabs.groups) {
    const rect = groupRect(group.id);
    const tab = tabs.tabs.find((t) => t.id === group.activeTabId);
    if (!rect || !tab?.views[0]) continue;
    const body = groupBody(rect);
    if (tab.panel) {
      const ratio = dragPanel?.tabId === tab.id ? dragPanel.ratio : tab.panel.ratio;
      const split = layoutPanel(body, ratio);
      placed.set(tab.views[0].id, split.main);
      placed.set(tab.panel.id, split.panel);
      panels.push({ tabId: tab.id, readerId: tab.views[0].id, panelId: tab.panel.id, sash: split.sash, body, ratio });
    } else placed.set(tab.views[0].id, body);
  }
  /** What releasing a tab dragged out of its strip at (x, y) would do: join another group's
   * strip, move into another group, or open a group of its own beside one. */
  const locateDrop = (x: number, y: number, drag: { tabId: string; groupId: string }): DropTarget | undefined => {
    if (y <= TAB_STRIP_HEIGHT + 4) {
      const strip = [...document.querySelectorAll<HTMLElement>("[data-group-strip]")].find((el) => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x < r.right;
      });
      const groupId = strip?.dataset.groupStrip;
      if (!strip || !groupId || groupId === drag.groupId) return undefined;
      const rects = Array.from(strip.querySelectorAll<HTMLElement>(".tab-item"), (el) => el.getBoundingClientRect());
      const found = rects.findIndex((r) => x < r.left + r.width / 2);
      const index = found < 0 ? rects.length : found;
      const marker = index < rects.length ? rects[index].left - 1 : (rects.at(-1)?.right ?? strip.getBoundingClientRect().left + 8) + 1;
      return { drop: { kind: "move", tabId: drag.tabId, groupId, index }, label: "Release to move to this group", marker: { x: marker } };
    }
    const cx = x - sidebarWidth;
    const rect = laidOut.groups.find((g) => cx >= g.x && cx < g.x + g.width);
    if (!rect) return undefined;
    const body = groupBody(rect);
    const onScreen = { ...body, x: body.x + sidebarWidth };
    const source = tabs.groups.find((g) => g.id === drag.groupId);
    const own = rect.id === drag.groupId;
    // A group's only tab cannot leave it for a group beside it: that would empty it.
    const canSplit = !(own && (source?.tabIds.length ?? 0) < 2) && (tabs.groups.length < MAX_GROUPS || (!own && source?.tabIds.length === 1));
    const band = Math.min(EDGE_BAND, body.width / 3);
    const side = cx < body.x + band ? "left" : cx >= body.x + body.width - band ? "right" : undefined;
    if (side && canSplit) {
      const half = { ...onScreen, width: onScreen.width / 2, x: side === "left" ? onScreen.x : onScreen.x + onScreen.width / 2 };
      return { drop: { kind: "split", tabId: drag.tabId, groupId: rect.id, side }, label: `Release to open in a new group on the ${side}`, preview: half, content: true };
    }
    if (own) return { label: "Drag to a side to open a new group", content: true };
    const index = tabs.tabs.filter((t) => t.groupId === rect.id).length;
    return { drop: { kind: "move", tabId: drag.tabId, groupId: rect.id, index } satisfies TabDrop, label: "Release to move to this group", preview: onScreen, content: true };
  };
  // While a drag is over the content, native views are swapped for still frames so the
  // drop preview can be drawn over them.
  type Frame = { id: string; x: number; y: number; width: number; height: number; image: string };
  const [dragFrames, setDragFrames] = useState<Frame[]>([]);
  const dragOverlay = useRef<string | undefined>(undefined);
  // Main recaptures when what is shown changes mid-drag (the dragged-from tab comes back).
  useEffect(
    () =>
      api().on("global-overlay-frames", (result) => {
        const { id, frames } = result as { id: string; frames: Frame[] };
        if (id === dragOverlay.current) setDragFrames(frames);
      }),
    [],
  );
  const contentDragging = (dragging: boolean) => {
    if (dragging && !dragOverlay.current) {
      const id = `tab-drag-${crypto.randomUUID()}`;
      dragOverlay.current = id;
      void (api().tabAction("global-overlay-open", { id }) as unknown as Promise<{ frames?: Frame[] }>)
        .then((result) => {
          if (dragOverlay.current === id) setDragFrames(result?.frames ?? []);
        })
        .catch(() => {});
    } else if (!dragging && dragOverlay.current) {
      const id = dragOverlay.current;
      dragOverlay.current = undefined;
      setDragFrames([]);
      void api().tabAction("global-overlay-close", { id });
    }
  };
  const totalTabs = tabs.tabs.length;
  const recordIcon = (r: RecordItem): IconName =>
    r.kind === "note" ? "note" : r.kind === "database" ? "database" : "doc";
  // The Workspace section lists notes, canvases, pages and documents together.
  const noteTitle = (n: Note) => n.title || markdownToPlainText(n.body).split("\n")[0] || "Untitled note";
  const workspaceEntries: WorkspaceEntry[] = [
    ...notes.map((n): WorkspaceEntry => ({
      key: `note:${n.id}`,
      kind: "note",
      id: n.id,
      title: noteTitle(n),
      icon: "note",
      type: "note",
      updatedAt: n.updatedAt,
      // Dropped into another app, a note is its text.
      text: [n.title && `# ${n.title}`, n.body].filter(Boolean).join("\n\n"),
    })),
    ...canvases.map((c): WorkspaceEntry => ({ key: `canvas:${c.id}`, kind: "canvas", id: c.id, title: c.title || "Untitled canvas", icon: "canvas", type: "canvas", updatedAt: c.updatedAt })),
    ...records
      .filter((r) => r.kind !== "source")
      .map((r): WorkspaceEntry => ({
        key: `record:${r.id}`,
        kind: "record",
        id: r.id,
        title: r.title || "Untitled",
        icon: recordIcon(r),
        type: r.properties?.editor ? "document" : "page",
      })),
  ];
  const currentEntry = activeView?.content?.noteId
    ? `note:${activeView.content.noteId}`
    : activeView?.content?.canvasId
      ? `canvas:${activeView.content.canvasId}`
      : record?.id
        ? `record:${record.id}`
        : undefined;
  // Collections take at most half the sidebar's height before "Show more" (steady sidebar).
  const [sidebarHeight, setSidebarHeight] = useState(0);
  const sidebarScroll = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    new ResizeObserver(([entry]) => setSidebarHeight(entry.contentRect.height)).observe(el);
  }, []);
  const collectionsBudget = sidebarHeight ? Math.max(0, sidebarHeight / 2 - 2 * ROW_PX) : undefined;
  const sidebarToggle = (
    <button
      className="key-sidebar-toggle"
      aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!sidebarCollapsed}
      title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
      onClick={() => setSidebarCollapsed((v) => !v)}
    >
      <Icon name="sidebar" />
    </button>
  );
  const navItem = (
    label: string,
    icon: IconName,
    current: boolean,
    onClick: () => void,
    disabled = false,
  ) => (
    <button
      className="kx-nav-item"
      aria-current={current ? "page" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
  return (
    <div
      className="key-shell"
      data-sidebar={sidebarCollapsed ? "collapsed" : "open"}
      data-inbox-drop={inboxDrop || undefined}
      // Files and links dropped where nothing else takes them go to the library's Inbox.
      onDragOver={(e) => {
        if (e.defaultPrevented || !workspaceId || !hasExternalDrop(e.dataTransfer)) return setInboxDrop(false);
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setInboxDrop(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setInboxDrop(false)}
      onDrop={(e) => {
        setInboxDrop(false);
        if (e.defaultPrevented || !workspaceId || !hasExternalDrop(e.dataTransfer)) return;
        e.preventDefault();
        void importDrop(invoke, workspaceId, e.dataTransfer, () => inboxCollection(invoke, workspaceId))
          .then((items) => items.length && toast(`Added ${describeCount(items)} to the Inbox`))
          .catch((error) => setError(String(error)));
      }}
    >
      <GlobalDrawerHost />
      <ItemLayer />
      <CommandCenter
        invoke={invoke}
        workspaceId={workspaceId}
        section={section}
        commands={[
          { id: "new-note", label: "New note", icon: "note", run: createNote },
          { id: "new-canvas", label: "New canvas", icon: "canvas", run: createCanvas },
          { id: "library", label: "Show library", icon: "books", run: () => action("open-content", { section: "sources", workspaceId }) },
          { id: "highlights", label: "All highlights", icon: "quote", shortcut: "⌘⇧H", run: () => action("open-content", { section: "highlights", workspaceId }) },
          { id: "inspector", label: inspectorOpen ? "Hide inspector" : "Show inspector", icon: "panelRight", shortcut: "⌘⇧I", run: () => setInspectorOpen((o) => !o) },
          { id: "sidebar", label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar", icon: "sidebar", run: () => setSidebarCollapsed((v) => !v) },
          { id: "split", label: "Split right", icon: "split", shortcut: "⌘\\", run: () => action("split-right") },
          { id: "capture", label: "Quick capture", icon: "plus", shortcut: "⌃⌥Space", run: () => action("quick-capture") },
          { id: "settings", label: "Settings", icon: "gear", shortcut: "⌘,", run: () => setSettingsSection("general") },
          { id: "shortcuts", label: "Keyboard shortcuts", icon: "info", shortcut: "⌘/", run: () => window.dispatchEvent(new CustomEvent("key:shortcuts")) },
        ]}
      />
      {prefs && settingsSection && !welcome && (
        <Settings
          section={settingsSection}
          invoke={invoke}
          workspaces={workspaces}
          settings={prefs.settings}
          info={prefs.info}
          onSettings={updatePrefs}
          onClose={() => setSettingsSection(undefined)}
          onShowWelcome={() => {
            setSettingsSection(undefined);
            setWelcome(true);
          }}
          onOpenLibrary={(id) => {
            setSettingsSection(undefined);
            if (id === tabs.workspaceId) action("open-content", { section: "sources", workspaceId: id });
            else void switchWorkspace(id);
          }}
          onWorkspacesChanged={refreshWorkspaces}
        />
      )}
      {prefs && welcome && (
        <Onboarding
          invoke={invoke}
          workspaces={workspaces}
          info={prefs.info}
          theme={prefs.settings.theme}
          onTheme={(theme) => updatePrefs({ theme })}
          onFinish={(id) => {
            setWelcome(false);
            updatePrefs({ onboarded: true });
            refreshWorkspaces();
            if (id && id !== tabs.workspaceId) void switchWorkspace(id);
            else if (id) action("open-content", { section: "sources", workspaceId: id });
          }}
        />
      )}
      <div
        ref={sidebarSlot}
        className={`key-sidebar-slot ${sidebarCollapsed ? "collapsed" : ""}`}
        data-resizing={sidebarResizing || undefined}
        style={{ "--kx-sidebar-width": `${sidebarSize}px` } as React.CSSProperties}
      >
        <aside
          className="key-sidebar key-ui-root"
          style={
            {
              "--workspace-accent": selectedWorkspace?.color || "#64748b",
            } as React.CSSProperties
          }
          inert={sidebarCollapsed}
          aria-hidden={sidebarCollapsed}
        >
          {/* The workspace sits in the title bar, between the traffic lights and the toggle. */}
          <div className="kx-sidebar-titlebar">
            <WorkspaceSwitcher
              workspaces={workspaces}
              selectedId={workspaceId}
              openElsewhere={(tabs.windows ?? []).filter((w) => w.windowId !== tabs.windowId).map((w) => w.workspaceId)}
              openRequest={switcherRequest}
              onHome={() => action("open-home")}
              onSettings={() => setSettingsSection("libraries")}
              onSelect={(id, newWindow) =>
                // Choosing the workspace this window already shows goes Home.
                id === tabs.workspaceId && !newWindow ? action("open-home") : void switchWorkspace(id, newWindow)
              }
              onAdd={async () => {
                const added = await api().addWorkspace();
                setWorkspaces(await api().workspaces());
                return added;
              }}
              onSave={async (id, icon, color) => {
                await api().invoke(
                  "workspace_set_appearance",
                  { icon, color },
                  id,
                );
                setWorkspaces(await api().workspaces());
              }}
            />
            {sidebarToggle}
          </div>
          <div className="kx-sidebar-scroll" ref={sidebarScroll}>
            <nav className="kx-nav" aria-label="Main">
              <button className="kx-nav-item kx-search-row" disabled={!workspaceId} onClick={() => window.dispatchEvent(new Event("key:search"))}>
                <Icon name="search" />
                <span>Search</span>
                <kbd>⌘⇧F</kbd>
              </button>
            </nav>
            {!workspaceId && (
              <p className="key-sidebar-hint">
                Choose a workspace to see its library and pages.
              </p>
            )}
            {/* Library: the row opens the library; its disclosure folds the collections. */}
            {workspaceId && (
              <CollectionTree
                invoke={invoke}
                workspaceId={workspaceId}
                sourcesCurrent={section === "sources"}
                budget={collectionsBudget}
                onOpenLibrary={() => action("open-content", { section: "sources", workspaceId, projectId })}
                onShowSources={() => action("open-content", { section: "sources", workspaceId, projectId })}
              />
            )}
            <WorkspaceSection
              invoke={invoke}
              workspaceId={workspaceId}
              name={selectedWorkspace?.name ?? "Workspace"}
              entries={workspaceEntries}
              currentKey={currentEntry}
              onOpen={(entry) =>
                sidebarClick({ kind: entry.kind, id: entry.id, title: entry.title }, () => {
                  if (entry.kind === "note") openNote(entry);
                  else if (entry.kind === "canvas") openCanvas(entry);
                  else {
                    const r = records.find((r) => r.id === entry.id);
                    if (r) selectRecord(r);
                  }
                })
              }
              itemDrop={(entry) => dropTarget({ kind: entry.kind as "note" | "canvas", id: entry.id, title: entry.title })}
              onNewNote={() => newNote().catch((e) => void setError(String(e)))}
              createMenu={
                <>
                  <button
                    disabled={!workspaceId}
                    aria-label="Create item"
                    title="New note, canvas, page or document"
                    aria-expanded={createMenu}
                    onClick={() => setCreateMenu(!createMenu)}
                  >
                    <Icon name="plus" size={14} />
                  </button>
                  {createMenu && (
                    <div className="key-create-menu">
                      {(
                        [
                          ["note", "Note", "note"],
                          ["canvas", "Canvas", "canvas"],
                          ["page", "Page", "doc"],
                          ["database", "Database", "database"],
                        ] as const
                      ).map(([kind, label, icon]) => (
                        <button
                          key={kind}
                          onClick={() => createRecord(kind)}
                        >
                          <Icon name={icon} />
                          New {label.toLowerCase()}
                        </button>
                      ))}
                      <button
                        onClick={() => {
                          setCreateMenu(false);
                          window.dispatchEvent(new Event("key:link-folder"));
                        }}
                      >
                        <Icon name="link" />
                        Link a folder…
                      </button>
                      <hr />
                      {["docs", "sheets", "slides", "markdown", "html"].map(
                        (kind) => (
                          <button
                            key={kind}
                            onClick={() => {
                              setCreateMenu(false);
                              action("create-office", { kind, workspaceId });
                            }}
                          >
                            <Icon name="doc" />
                            New {kind === "docs" ? "document" : kind}
                          </button>
                        ),
                      )}
                    </div>
                  )}
                </>
              }
            />
          </div>
          <div className="key-sidebar-footer">
            <ModelProgressPill progress={model} />
            {projectId && (
              <button
                className="kx-nav-item"
                onClick={() =>
                  action("link-folder", { workspaceId, projectId })
                }
              >
                <Icon name="link" />
                <span>Link folder…</span>
              </button>
            )}
            <div className="kx-sidebar-foot-row">
              <button className="kx-nav-item" onClick={() => setSettingsSection("general")}>
                <Icon name="gear" />
                <span>Settings</span>
              </button>
              {(() => {
                const where = selectedWorkspace ? "Stored on this Mac" : `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"} on this Mac`;
                return (
                  <span className="kx-sidebar-storage" title={where} aria-label={where} role="img">
                    <Icon name="disk" size={13} />
                  </span>
                );
              })()}
            </div>
          </div>
        </aside>
        {!sidebarCollapsed && (
          <div
            className="kx-sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            aria-valuenow={sidebarSize}
            title="Drag to resize · double-click to reset"
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              setSidebarResizing(true);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) setSidebarSize(clampSidebar(e.clientX));
            }}
            onPointerUp={() => setSidebarResizing(false)}
            onPointerCancel={() => setSidebarResizing(false)}
            onDoubleClick={() => setSidebarSize(SIDEBAR_DEFAULT)}
          />
        )}
      </div>
      <div className="kx-main">
      {/* One strip per editor group, at the height of the window's title bar. */}
      <div className="key-group-strips">
        {tabs.groups.map((group, index) => {
          const rect = groupRect(group.id);
          if (!rect) return null;
          return (
            <TabBar
              key={group.id}
              api={groupApi(group.id)}
              groupId={group.id}
              tabs={summaries.get(group.id) ?? []}
              first={index === 0}
              focused={tabs.groups.length < 2 || group.id === tabs.activeGroupId}
              lone={totalTabs < 2 && (tabs.windowCount ?? 1) < 2}
              style={{ position: "absolute", top: 0, left: rect.x, width: rect.width }}
              locateDrop={locateDrop}
              onContentDrag={contentDragging}
              onFocusGroup={() => action("focus-group", { groupId: group.id })}
              chromeControl={index === 0 && sidebarCollapsed ? sidebarToggle : undefined}
              trailingControls={
                <div className="key-chrome-layout-controls">
                  <button
                    title="Split right (⌘\)"
                    aria-label="Split right"
                    disabled={tabs.groups.length >= MAX_GROUPS}
                    onClick={() => action("split-right", { tabId: group.activeTabId })}
                  >
                    <Icon name="split" />
                  </button>
                </div>
              }
            />
          );
        })}
      </div>
      <div className="key-shell-body key-ui-root">
        <div className="key-content-panes">
          {tabs.tabs
            .flatMap((t) => [{ view: t.views[0], docked: undefined as string | undefined }, ...(t.panel ? [{ view: t.panel as ViewState, docked: t.views[0]?.id }] : [])])
            .filter(({ view }) => view?.content)
            .map(({ view: v, docked }) => {
              const rect = placed.get(v.id);
              return (
                <div
                  key={v.id}
                  data-content-view={v.id}
                  data-panel={docked ? "" : undefined}
                  className="key-content-pane"
                  tabIndex={-1}
                  hidden={!rect}
                  onPointerDownCapture={() => {
                    if (tabs.activeViewId !== v.id) action("focus", { viewId: v.id });
                  }}
                  onFocusCapture={() => {
                    if (tabs.activeViewId !== v.id) action("focus", { viewId: v.id });
                  }}
                  style={rect && { left: rect.x, top: rect.y - TAB_STRIP_HEIGHT, width: rect.width, height: rect.height }}
                >
                  {!!(v.back?.length || v.forward) && (
                    <nav className="key-pane-history" aria-label="History">
                      <button disabled={!v.back?.length} title={v.back?.length ? `Back to ${v.back.at(-1)} (⌘[)` : undefined} aria-label="Back" onClick={() => action("history", { viewId: v.id, step: -1 })}>
                        <Icon name="chevronRight" size={13} style={{ transform: "scaleX(-1)" }} />
                      </button>
                      <button disabled={!v.forward} title={v.forward ? `Forward to ${v.forward} (⌘])` : undefined} aria-label="Forward" onClick={() => action("history", { viewId: v.id, step: 1 })}>
                        <Icon name="chevronRight" size={13} />
                      </button>
                      <ol className="key-pane-crumbs">
                        {(v.back ?? []).map((title, i, all) => (
                          <li key={i}>
                            <button onClick={() => { for (let n = 0; n < all.length - i; n++) action("history", { viewId: v.id, step: -1 }); }}>{title}</button>
                          </li>
                        ))}
                        <li aria-current="page">{v.title.replace(/ •$/, "")}</li>
                      </ol>
                    </nav>
                  )}
                  <WorkspaceContent
                    key={v.nav ?? 0}
                    viewId={v.id}
                    spec={v.content || { section: "sources" }}
                    visible={!!rect}
                    tabs={tabs}
                    docked={
                      docked
                        ? {
                            onPopOut: () => action("panel-pop-out", { viewId: docked }),
                            onClose: () => action("panel-close", { viewId: docked }),
                          }
                        : undefined
                    }
                  />
                </div>
              );
            })}
          {/* Browser tabs: the bar above the page (the page is a native view below it). */}
          {tabs.tabs.map((t) => {
            const v = t.views[0];
            const rect = v?.web && placed.get(v.id);
            if (!v?.web || !rect) return null;
            return (
              <BrowserBar
                key={v.id}
                state={v.web}
                style={{ left: rect.x, top: rect.y - TAB_STRIP_HEIGHT, width: rect.width }}
                onStep={(step) => action("history", { viewId: v.id, step })}
                onPage={(op) => action("web-page", { viewId: v.id, op })}
              />
            );
          })}
          {error && (
            <div className="key-shell-error" role="alert">
              <span>{error}</span>
              <Button onClick={() => setError("")}>Dismiss</Button>
            </div>
          )}
        </div>
      </div>
      </div>
      {inspectorOpen && (
        <div style={{ "--kx-inspector-width": `${INSPECTOR_WIDTH}px` } as React.CSSProperties}>
          <Inspector invoke={invoke} workspaceId={workspaceId} items={selected} onClose={() => setInspectorOpen(false)} />
        </div>
      )}
      {/* Sashes between groups: drag to resize the two beside it, double-click to even all out. */}
      {laidOut.sashes.map((sash) => {
        const sizes = () => dragSizes ?? tabs.groups.map((g) => g.size);
        const resize = (next: number[], done = false) => {
          setDragSizes(next);
          if (done) action("resize-groups", { sizes: next, done: true });
          else sendSash(() => void api().tabAction("resize-groups", { sizes: next }));
        };
        const left = tabs.groups[sash.index],
          share = sizes()[sash.index] / (sizes().reduce((a, b) => a + b, 0) || 1);
        return (
          <div
            key={`${left?.id}-sash`}
            className="key-group-sash"
            role="separator"
            aria-label="Resize groups"
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(share * 100)}
            title="Drag to resize · double-click to make all groups the same width"
            tabIndex={0}
            data-sash-index={sash.index}
            style={{ left: sidebarWidth + sash.x, width: sash.width }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              sashDragging.current = true;
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) resize(dragGroupSash(sizes(), sash.index, e.clientX - sidebarWidth, contentWidth));
            }}
            onPointerUp={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              e.currentTarget.releasePointerCapture(e.pointerId);
              sashDragging.current = false;
              resize(sizes(), true);
            }}
            onPointerCancel={() => {
              sashDragging.current = false;
              setDragSizes(undefined);
            }}
            onDoubleClick={() => action("equalize-groups")}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const at = laidOut.groups[sash.index + 1].x - GROUP_GAP + (e.key === "ArrowLeft" ? -1 : 1) * SASH_STEP * contentWidth;
              resize(dragGroupSash(sizes(), sash.index, at, contentWidth), true);
            }}
          />
        );
      })}
      {/* A reader's panel: the sash between them sets the panel's share of the tab. */}
      {panels.map((p) => {
        const ratioAt = (x: number) => (p.body.x + p.body.width - (x - sidebarWidth) - GROUP_GAP) / Math.max(1, p.body.width - 2 * GROUP_GAP);
        const resize = (ratio: number, done = false) => {
          const clamped = Math.min(0.8, Math.max(0.2, ratio));
          setDragPanel({ tabId: p.tabId, viewId: p.readerId, ratio: clamped });
          if (done) action("panel-resize", { viewId: p.readerId, ratio: clamped, done: true });
          else sendSash(() => void api().tabAction("panel-resize", { viewId: p.readerId, ratio: clamped }));
        };
        return (
          <div
            key={`${p.tabId}-panel-sash`}
            className="key-group-sash key-panel-sash"
            role="separator"
            aria-label="Resize details and notes"
            aria-orientation="vertical"
            aria-valuemin={20}
            aria-valuemax={80}
            aria-valuenow={Math.round(p.ratio * 100)}
            title="Drag to resize · double-click to reset"
            tabIndex={0}
            style={{ left: sidebarWidth + p.sash.x, top: p.sash.y, width: p.sash.width, height: p.sash.height }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              sashDragging.current = true;
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) resize(ratioAt(e.clientX));
            }}
            onPointerUp={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              e.currentTarget.releasePointerCapture(e.pointerId);
              sashDragging.current = false;
              resize(ratioAt(e.clientX), true);
            }}
            onPointerCancel={() => {
              sashDragging.current = false;
              setDragPanel(undefined);
            }}
            onDoubleClick={() => resize(0.4, true)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              resize(p.ratio + (e.key === "ArrowLeft" ? SASH_STEP : -SASH_STEP), true);
            }}
          />
        );
      })}
      {dragFrames.map((frame) => (
        <img
          key={frame.id}
          className="key-native-overlay-frame"
          alt=""
          draggable={false}
          src={frame.image}
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
        />
      ))}{" "}
      {dialog && (
        <GlobalDialog label={dialog === "project" ? "New project" : "Link a folder"} onClose={()=>setDialog(null)}>
          <form
            className="key-shell-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              if (!workspaceId) return;
              void task(async () => {
                if (dialog === "project") {
                  const p = await invoke<Project>(
                    "workspace_create_project",
                    { name: dialogValue },
                    workspaceId,
                  );
                  chooseScope(workspaceId, p.id);
                } else {
                  const folder = await invoke<{ id: string }>(
                    "workspace_link_folder",
                    { projectId, path: dialogValue },
                    workspaceId,
                  );
                  await invoke(
                    "workspace_scan_linked_folder",
                    { id: folder.id },
                    workspaceId,
                  );
                }
                setDialog(null);
                setRefreshKey((k) => k + 1);
              });
            }}
          >
            <h2>{dialog === "project" ? "New project" : "Link a folder"}</h2>
            <p>
              {dialog === "project"
                ? "Projects are subfolders and filtered views of this workspace."
                : "Files stay in their original folder. Their metadata is added to this project and supported sources are indexed."}
            </p>
            <label>
              {dialog === "project" ? "Project name" : "Absolute folder path"}
              <Input
                autoFocus
                required
                value={dialogValue}
                onChange={(e) => setDialogValue(e.target.value)}
              />
            </label>
            <div>
              <Button type="button" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button type="submit">
                {dialog === "project" ? "Create project" : "Link and scan"}
              </Button>
            </div>
          </form>
        </GlobalDialog>
      )}
    </div>
  );
}
