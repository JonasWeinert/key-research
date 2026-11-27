import { startupMark } from "./startup-marks";
import { placeSearchResultBeside, placeSearchResultTab } from "../shared/search-preview-model";
import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  dialog,
  Menu,
  screen,
  shell as systemShell,
  clipboard,
  nativeImage,
  globalShortcut,
  type MenuItemConstructorOptions,
} from "electron";
import { existsSync } from "node:fs";
import { join, resolve, basename, dirname, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AiService } from "./ai/service";
import { secrets as secretStore } from "./services/setup";
import { AppSettingsStore, appInfo } from "./app-settings";
import { downloadPdf } from "./download-pdf";
import { dismissOnBlur, dismissOnMove, relayDismiss } from "./dismiss-relay";
import { LinkedFolders } from "./linked-folders";
import { WebSearch } from "./web-search";
import { publicSettings, type KeyedServices } from "./services";
import { hostKeyRequests, onWebProvidersChanged, pushHostKeys, startKeyedServices } from "./services/setup";
import { startZoteroPluginSync } from "./zotero-sync";
import { registerAddFromSource } from "./add-from-source";
import { Registry, type WorkspaceInfo } from "./workspaces";
import { Launcher, launcherEnabled, moveFolder } from "./launcher";
import { fatal, installErrorHandlers, notify, serveNotices } from "./app-notices";
import { serveStatusItems } from "./status-items";
import { STATUS_BAR_HEIGHT } from "../shared/status-items";
import { registerMediaScheme, routeEmbeddedMedia, serveNoteMedia } from "./note-media";
import { deliverDeepLinks, listenForDeepLinks } from "./deep-links";
import { BrowserService, creatingPage } from "./browser/pages";
import { browserSession, clearBrowsingData } from "./browser/profile";
import { createWebTab, type WebTabState } from "./browser/tab";
import { SignInService, type SignInOp } from "./browser/sign-in";
import { properUrlOf, ProxyService, withLibraryAccess, type ProxyOp } from "./browser/proxy-service";
import { simulateNetwork } from "./browser/network";
import { importProxies } from "./browser/proxy-import";
import { WebSources } from "./web-sources";
import { PageActions } from "./browser/page-actions";
import { DEFAULT_MAX_BYTES, DEFAULT_TTL, TempPdfs, type TempPdf } from "./browser/temp-pdfs";
import { hostLabel, pdfTitle, safeFileName, systemUrl, webUrl } from "./browser/urls";
import { webPageRect } from "../shared/browser-layout";
import { feedsEnvironmentRequest, watchFeedsEnvironment } from "./feeds-environment";
import { forgetReading, reportReading } from "./reading-events";
import { TabSwitcher } from "./tab-switcher";
import { switcherOrder, touchMru } from "../shared/tab-switcher";
import { WindowStateStore, type SavedGroup, type SavedTab, type SavedTabs, type SavedView, type SavedWindow, type WindowState } from "./window-state";
import {
  activateWorkspaceTab,
  activeGroup,
  activeWorkspaceTab,
  addGroupWithTab,
  addWorkspaceTab,
  allTabs,
  closeWorkspaceTab,
  emptyTabsState,
  equalizeGroups,
  findTab,
  findViewTab,
  focusGroup,
  groupBody,
  layoutGroups,
  layoutPanel,
  moveWorkspaceTab,
  neighbourGroup,
  newTabGroup,
  normalizeTabs,
  pinWorkspaceTab,
  reorderWorkspaceTab,
  replaceWorkspaceView,
  setGroupSizes,
  shownTabs,
  singleWorkspaceTab,
  splitWorkspaceTab,
  tabsState,
  tabsToClose,
  MAX_GROUPS,
  PANEL_RATIO,
  type GroupSide,
  type TabGroup,
  type WorkspaceTab,
  type WorkspaceTabsState,
} from "../shared/tab-model";

type OwnedView = {
  id: string;
  title: string;
  /** "home" views are drawn by the shell's renderer; every other kind is a native view (see `nativeKinds`). */
  kind: "home" | "pdf" | "web";
  /** A browser tab's page: where it is and what its bar shows. */
  web?: WebTabState;
  /** The title of the page a browser tab was opened from. */
  referrer?: string;
  /** The address of that page. */
  referrerUrl?: string;
  /** A browser tab on an article page: the library source it is (once looked up), and an add in progress. */
  articleState?: { key: string; sourceId?: string; busy?: boolean; possible?: boolean };
  /** A PDF opened from the browser: kept for a while in the browser's cache, not in a library.
   * `referrer` is the page that led to it. */
  temp?: { url: string; hash: string; referrer?: string };
  /** Find PDF sent this browser tab (or the tab that led to this PDF) for a library source
   * without a file: a PDF captured from it is attached to that source. */
  pdfFor?: { workspaceId: string; sourceId: string; title?: string };
  /** Says once, when the reader opens, that this PDF was just added to (or found in) the library. */
  libraryNotice?: "added" | "exists";
  /** A reader's details-and-notes panel: the source's page, docked beside it in the same tab. */
  panel?: { viewId: string; ratio: number; focused?: boolean; tab?: PanelTab };
  /** The panel's share when it was last open, so it comes back the same size. */
  panelRatio?: number;
  /** A Home tab opened by Split Right: what it opens takes its place. */
  launcher?: boolean;
  content?: {
    section: string;
    workspaceId?: string;
    projectId?: string;
    record?: any;
    noteId?: string;
    sourceId?: string;
    canvasId?: string;
    fileId?: string;
    /** A person, venue or topic of the library's metadata graph. */
    entityId?: string;
  };
  contentKey?: string;
  /** What this pane showed before a link was followed in place, and after going back. */
  back?: PaneEntry[];
  forward?: PaneEntry[];
  /** Counts links followed in place, so the renderer knows to show the pane afresh. */
  nav?: number;
  returnViewId?: string;
  searchPreviewOwner?: string;
  sharedSearchNavigation?: boolean;
  dirty?: boolean;
  workspaceId?: string;
  source?: any;
  searchTarget?: any;
  /** Where the reader should go once it is ready: a page, and the annotation to light up. */
  pendingFocus?: { page?: number; annotationId?: string; text?: string };
  searchResults?: {
    id: string;
    documentHash: string;
    documentTitle?: string;
    workspaceId: string;
  }[];
  searchIndex?: number;
  viewState?: any;
  view?: WebContentsView;
  lastUsed: number;
  /** The window whose content view currently holds this view's native WebContentsView. */
  host?: ShellWindow;
};
type PaneEntry = Pick<OwnedView, "title" | "contentKey" | "content">;
/** One window: one workspace, its own tabs, sidebar width and modal overlay. Every window
 * talks to the same registry, Rust hosts and view records, so a document is never open twice. */
type ShellWindow = {
  id: string;
  window: BrowserWindow;
  /** The library this window's sidebar, new items and title belong to. */
  workspaceId: string;
  state: WorkspaceTabsState;
  sidebarWidth: number;
  /** The inspector panel at the right edge, 0 while it is closed. */
  inspectorWidth?: number;
  globalOverlay?: string;
  overlayCaptureSequence: number;
  overlayCaptureKey: string;
  /** Tab ids, most recently shown first (for Ctrl-Tab). */
  mru?: string[];
  closed?: boolean;
};
const shells = new Map<string, ShellWindow>();
let lastFocusedShell: ShellWindow | undefined;
let quitRequested = false;
function liveShells() {
  return [...shells.values()].filter((w) => !w.closed && !w.window.isDestroyed());
}
function shellBySender(sender: number) {
  return liveShells().find((w) => w.window.webContents.id === sender);
}
/** What a reader's panel shows: the source's details and note, or the PDF's references. */
type PanelTab = "details" | "references" | "highlights";
const panelTab = (value: unknown): PanelTab | undefined => (value === "details" || value === "references" || value === "highlights" ? value : undefined);
/** The reader whose panel shows `viewId`, if it is a docked panel. */
function panelHost(viewId: string) {
  for (const v of views.values()) if (v.panel?.viewId === viewId) return v;
  return undefined;
}
/** The view whose tab holds `viewId`: itself, or the reader it is docked in. */
const tabViewId = (viewId: string) => panelHost(viewId)?.id ?? viewId;
function shellOfView(viewId: string) {
  const id = tabViewId(viewId);
  return liveShells().find((w) => findViewTab(w.state, id));
}
/** Every view a window holds: its tabs' views and their panels. */
function windowViewIds(w: ShellWindow) {
  return allTabs(w.state).flatMap((t) => withPanel(t.viewId));
}
const withPanel = (viewId: string) => {
  const panel = views.get(viewId)?.panel;
  return panel ? [viewId, panel.viewId] : [viewId];
};
/** What a window shows now: each group's tab, with its panel. */
function shownViewIds(w: ShellWindow) {
  return shownTabs(w.state).flatMap((t) => withPanel(t.viewId));
}
/** The view with keyboard focus: the focused group's tab, or its panel. */
function activeViewId(w: ShellWindow) {
  const tab = activeWorkspaceTab(w.state);
  const panel = tab && views.get(tab.viewId)?.panel;
  return panel?.focused ? panel.viewId : tab?.viewId;
}
/** The window a menu command or new document should go to. */
function focusedShell(): ShellWindow {
  const focused = BrowserWindow.getFocusedWindow();
  return (
    liveShells().find((w) => w.window === focused) ??
    (lastFocusedShell && !lastFocusedShell.closed && !lastFocusedShell.window.isDestroyed() ? lastFocusedShell : undefined) ??
    liveShells()[0]
  );
}
let registry: Registry;
/** The workspaces window (main/launcher.ts); with it on, closing the last workspace window shows it. */
let launcher: Launcher | undefined;
const launcherMode = launcherEnabled();
let ai: AiService;
let appSettings: AppSettingsStore;
const views = new Map<string, OwnedView>();
const readerCalls = new Map<number, Set<Promise<unknown>>>();
const readerReleases = new Map<string, Promise<void>>();
function disposePdf(record: OwnedView) {
  forgetReading(record.id);
  const view = record.view;
  if (!view) return;
  const calls = [...(readerCalls.get(view.webContents.id) ?? [])];
  readerCalls.delete(view.webContents.id);
  if (record.host && !record.host.window.isDestroyed()) record.host.window.contentView.removeChildView(view);
  record.host = undefined;
  view.webContents.close();
  record.view = undefined;
  const previous = readerReleases.get(record.id);
  const release = (async () => {
    await previous;
    await Promise.allSettled(calls);
    await Promise.allSettled([
      registry.invoke(
        "release_disposable_document",
        { id: record.source.hash },
        record.workspaceId,
      ),
      registry.invoke(
        "native_close",
        { id: record.source.hash },
        record.workspaceId,
      ),
    ]);
  })();
  readerReleases.set(record.id, release);
  void release.finally(() => {
    if (readerReleases.get(record.id) === release)
      readerReleases.delete(record.id);
  });
}
type SearchResultRef = {
  id: string;
  documentHash: string;
  documentTitle?: string;
  workspaceId: string;
  page: number;
};
type SearchPreviewSession = {
  sourceViewId: string;
  previewViewId?: string;
  hits: SearchResultRef[];
  index: number;
  query: string;
  busy: boolean;
  error?: string;
  sequence: number;
  dismissed: boolean;
  /** Results show beside the search in its tab (the search tab), not in a tab of their own. */
  beside?: boolean;
};
const searchPreviews = new Map<string, SearchPreviewSession>();
// The search bar belongs to the tab showing a result (results open in their own tab).
function activeSearchPreview(w: ShellWindow) {
  const shown = new Set(shownTabs(w.state).map((t) => t.viewId));
  return [...searchPreviews.values()].find(
    (session) =>
      !session.dismissed &&
      (session.previewViewId && shown.has(session.previewViewId)
        ? true
        : (session.busy || Boolean(session.error)) && shown.has(session.sourceViewId)),
  );
}
function searchPreviewSnapshot(w: ShellWindow) {
  const session = activeSearchPreview(w);
  if (!session) return undefined;
  return {
    sourceViewId: session.sourceViewId,
    previewViewId: session.previewViewId,
    index: session.index,
    total: session.hits.length,
    query: session.query,
    busy: session.busy,
    error: session.error,
    hit: session.hits[session.index],
  };
}
async function showSearchPreview(session: SearchPreviewSession, index: number) {
  const hit = session.hits[index];
  const w = shellOfView(session.sourceViewId);
  if (!hit || !w || !views.has(session.sourceViewId)) return;
  const sequence = ++session.sequence;
  session.busy = true;
  session.error = undefined;
  session.dismissed = false;
  layout(w);
  try {
    const cachedSource = views.get(
      `pdf:${hit.workspaceId}:${hit.documentHash}`,
    )?.source;
    const [info, target] = await Promise.all([
      cachedSource
        ? Promise.resolve(cachedSource)
        : registry.invoke(
            "library_source_info",
            { hash: hit.documentHash },
            hit.workspaceId,
          ),
      registry.invoke("resolve_search_target", { id: hit.id }, hit.workspaceId),
    ]);
    if (
      session.sequence !== sequence ||
      session.dismissed ||
      !views.has(session.sourceViewId)
    )
      return;
    // Only follow through while the user is still on the results or on the result's tab.
    const current = shownTabs(w.state).map((t) => t.viewId);
    if (!current.includes(session.sourceViewId) && !current.includes(session.previewViewId ?? "")) {
      session.busy = false;
      session.dismissed = true;
      return;
    }
    const id = `pdf:${hit.workspaceId}:${hit.documentHash}`;
    let preview = views.get(id);
    if (!preview) {
      preview = {
        id,
        kind: "pdf",
        title: hit.documentTitle || (info as any).title,
        workspaceId: hit.workspaceId,
        source: info,
        lastUsed: Date.now(),
        searchPreviewOwner: session.sourceViewId,
      };
      views.set(id, preview);
    }
    const old = views.get(session.previewViewId || "");
    const replaceable =
      old?.searchPreviewOwner === session.sourceViewId ? old.id : undefined;
    w.state = (session.beside ? placeSearchResultBeside : placeSearchResultTab)(w.state, session.sourceViewId, id, replaceable);
    if (
      old &&
      old.id !== id &&
      replaceable &&
      !liveShells().some((s) => findViewTab(s.state, old.id))
    ) {
      disposePdf(old);
      views.delete(old.id);
    }
    preview.searchTarget = target;
    preview.returnViewId = session.sourceViewId;
    preview.sharedSearchNavigation = true;
    preview.searchResults = session.hits;
    preview.searchIndex = index;
    session.hits[index] = {
      ...hit,
      documentTitle: preview.title,
      page: (target as any).page,
    };
    session.previewViewId = id;
    session.index = index;
    session.busy = false;
    preview.view?.webContents.send("search-target", target);
    preview.view?.webContents.send("search-navigation", {
      index,
      total: session.hits.length,
      shared: true,
      query: session.query,
    });
    layout(w);
  } catch (e) {
    if (session.sequence !== sequence) return;
    session.busy = false;
    session.error = String(e);
    layout(w);
  }
}
function dismissSearchPreview(sourceViewId: string) {
  const session = searchPreviews.get(sourceViewId);
  if (!session) return;
  session.dismissed = true;
  session.busy = false;
  ++session.sequence;
  const preview = views.get(session.previewViewId || "");
  if (preview) {
    preview.searchTarget = undefined;
    preview.searchPreviewOwner = undefined;
    preview.view?.webContents.send("search-target", undefined);
  }
  const w = shellOfView(sourceViewId);
  if (w) layout(w);
}
const preload = join(__dirname, "../preload/index.js");
const renderer = join(__dirname, "../renderer");
/** The icon kind a view's tab shows. */
function viewKind(v: OwnedView | undefined) {
  const section = v?.content?.section;
  if (section === "record") return v?.content?.record?.kind || "page";
  if (!v?.contentKey) return v?.kind;
  if (section === "sources") return "library";
  if (section === "note" || section === "canvas" || section === "search" || section === "inbox") return section;
  if (section === "databases") return "database";
  if (section === "webpage") return "web";
  if (section === "source" || section === "file" || ENTITY_SECTIONS.includes(section ?? "")) return "page";
  return "records";
}
function viewSummary(id: string) {
  const v = views.get(id);
  return {
    id,
    title: `${v?.title ?? "Key"}${v?.dirty ? " •" : ""}`,
    workspaceId: v?.workspaceId,
    kind: viewKind(v),
    content: v?.content,
    back: v?.back?.map((e) => e.title).slice(-3),
    forward: v?.forward?.at(-1)?.title,
    nav: v?.nav,
    favicon: v?.web?.favicon,
    web: v?.web && {
      // A page that came through a library proxy is shown by its own address.
      host: hostLabel(properUrlOf(v.web.url)),
      url: properUrlOf(v.web.url),
      proxy: proxyService?.barState(v.view?.webContents, v.web.url),
      signin: signInService?.barState(v.view?.webContents),
      loading: v.web.loading,
      canGoBack: v.web.canGoBack,
      canGoForward: v.web.canGoForward,
      stalled: v.web.stalled || undefined,
      article: v.web.article && { title: v.web.article.title, doi: v.web.article.doi, inLibrary: !!v.articleState?.sourceId && !v.articleState.possible, possiblyInLibrary: !!v.articleState?.possible, busy: !!v.articleState?.busy },
    },
    temp: v?.temp ? true : undefined,
  };
}
/** What the window's renderer draws: groups and their tabs (each tab shows one view, and a
 * reader may carry its panel). `tabs` lists every group's tabs, left to right. */
function snapshot(w: ShellWindow) {
  const state = w.state;
  return {
    windowId: w.id,
    workspaceId: w.workspaceId,
    windowCount: liveShells().length,
    /** Which workspaces other windows show, for the switcher. */
    windows: liveShells().map((s) => ({ windowId: s.id, workspaceId: s.workspaceId })),
    searchPreview: searchPreviewSnapshot(w),
    groups: state.groups.map((g) => ({ id: g.id, size: g.size, activeTabId: g.activeTabId, tabIds: g.tabs.map((t) => t.id) })),
    activeGroupId: state.activeGroupId,
    tabs: state.groups.flatMap((g) =>
      g.tabs.map((t) => {
        const view = viewSummary(t.viewId);
        const panel = views.get(t.viewId)?.panel;
        return {
          id: t.id,
          groupId: g.id,
          pinned: Boolean(t.pinned),
          title: view.title,
          views: [view],
          ...(panel && views.has(panel.viewId) ? { panel: { ...viewSummary(panel.viewId), ratio: panel.ratio, tab: panel.tab ?? "details" } } : {}),
        };
      }),
    ),
    activeTabId: activeWorkspaceTab(state)?.id ?? null,
    activeViewId: activeViewId(w),
  };
}
/** Library-wide events reach every window. */
function emit(event: string, value?: unknown) {
  for (const w of liveShells()) w.window.webContents.send(event, value);
}
function emitTo(w: ShellWindow, event: string, value?: unknown) {
  if (!w.window.isDestroyed()) w.window.webContents.send(event, value);
}
/** Library readers of a workspace whose source changed elsewhere (a title edited in the
 * library) take its new title and details. */
async function refreshReaderTitles(workspaceId: string) {
  for (const v of views.values()) {
    if (v.kind !== "pdf" || v.temp || v.workspaceId !== workspaceId) continue;
    const hash = v.source?.hash ?? v.id.split(":").at(-1);
    const info: any = await registry.invoke("library_source_info", { hash }, workspaceId).catch(() => undefined);
    if (!info || (info.title === v.title && info.title === v.source?.title)) continue;
    v.source = info;
    if (info.title) v.title = info.title;
    const w = shellOfView(v.id);
    if (w) tabsChanged(w);
  }
}
function tabsChanged(w: ShellWindow) {
  emitTo(w, "tabs-changed", snapshot(w));
  saveWindows();
}
function homeView(): OwnedView {
  const record: OwnedView = {
    id: randomUUID(),
    title: "Home",
    content: { section: "home" },
    kind: "home",
    lastUsed: Date.now(),
  };
  views.set(record.id, record);
  return record;
}
/** A Home tab in a group (the focused one by default). */
function home(w: ShellWindow = focusedShell(), groupId?: string) {
  w.state = addWorkspaceTab(w.state, singleWorkspaceTab(homeView().id), { groupId });
  layout(w);
}
/** Split Right: the tab moves into a new group to the right of its own. A group's only tab
 * stays, and the new group opens on a Home launcher instead (what it opens takes its place). */
function splitRight(w: ShellWindow, tabId = activeWorkspaceTab(w.state)?.id) {
  const found = tabId ? findTab(w.state, tabId) : undefined;
  if (!found) return home(w);
  if (w.state.groups.length >= MAX_GROUPS) return;
  if (found.group.tabs.length > 1) w.state = splitWorkspaceTab(w.state, found.tab.id, found.group.id, "right");
  else {
    const record = homeView();
    record.launcher = true;
    w.state = addGroupWithTab(w.state, singleWorkspaceTab(record.id), found.group.id, "right");
  }
  layout(w);
  focusShown(w);
}
/** Moves the focused tab into the group on `side`; past the last group, into a new one. */
function moveToGroup(w: ShellWindow, side: GroupSide) {
  const tab = activeWorkspaceTab(w.state);
  const found = tab && findTab(w.state, tab.id);
  if (!found) return;
  const next = neighbourGroup(w.state, found.group.id, side);
  w.state = next ? moveWorkspaceTab(w.state, found.tab.id, next.id) : splitWorkspaceTab(w.state, found.tab.id, found.group.id, side);
  layout(w);
  focusShown(w);
}
/** Focus moves to the group on `side` of the focused one. */
function focusGroupBeside(w: ShellWindow, side: GroupSide) {
  const next = neighbourGroup(w.state, activeGroup(w.state).id, side);
  if (!next) return;
  w.state = focusGroup(w.state, next.id);
  layout(w);
  focusShown(w);
}
/** Keyboard focus follows the focused group: native views take it themselves, DOM views
 * are focused by the shell. */
function focusShown(w: ShellWindow) {
  const id = activeViewId(w);
  if (!id) return;
  const view = views.get(id)?.view;
  if (view) view.webContents.focus();
  else {
    w.window.webContents.focus();
    emitTo(w, "focus-pane", id);
  }
}
/** How a native tab kind makes its WebContentsView and lets it go. Kinds not listed ("home")
 * are drawn by the shell's renderer. A new kind adds itself to `OwnedView["kind"]`, registers
 * here, and opens as a tab of the focused group with `add(record, w)`. */
interface NativeKind {
  /** False while the kind's code is still loading: the view is created on the next layout. */
  ready?(): boolean;
  create(record: OwnedView): WebContentsView;
  /** Asked before the tab closes; false keeps it open. */
  canClose?(record: OwnedView): Promise<boolean>;
  /** Releases the view (and what stands behind it) for good; false keeps the tab. */
  dispose(record: OwnedView): Promise<boolean> | boolean;
}
const nativeKinds: Record<string, NativeKind> = {};
function registerNativeKind(kind: string, impl: NativeKind) {
  nativeKinds[kind] = impl;
}
registerNativeKind("pdf", {
  create(record) {
    const view = new WebContentsView({
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const load = async () => {
      await readerReleases.get(record.id);
      if (record.view !== view || view.webContents.isDestroyed()) return;
      if (process.env.ELECTRON_RENDERER_URL) await view.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL}/pdf.html`);
      else await view.webContents.loadFile(join(renderer, "pdf.html"));
    };
    // `load` awaits first, so `record.view` is set by the time it checks it.
    void load().catch((error) => emit("operation-error", String(error)));
    return view;
  },
  dispose(record) {
    disposePdf(record);
    return true;
  },
});
// ── In-app browser: browser tabs, every web link in the app, PDFs found on the web ──
registerNativeKind("web", {
  create(record) {
    const web = record.web!;
    const tab = createWebTab(web.url, {
      changed(patch) {
        Object.assign(web, patch);
        if (patch.title !== undefined || patch.url !== undefined) record.title = (web.title || hostLabel(web.url) || "New tab").slice(0, 200);
        const w = shellOfView(record.id);
        if (w) tabsChanged(w);
      },
      open(url, background) {
        const w = shellOfView(record.id) ?? focusedShell();
        const found = w && findViewTab(w.state, record.id);
        const from = { background, referrer: record.title, referrerUrl: webUrl(web.url), pdfFor: record.pdfFor };
        openLink(url, w, found ? { ...from, groupId: found.group.id, index: found.index + 1 } : from);
      },
      external: (url) => void systemShell.openExternal(url),
      window: () => record.host?.window,
      scanned: (scan) => browserPages.scanned(record, scan),
      inlinePdf: (url) => browserPages.inlinePdf(record, url),
    });
    // Library proxies apply to browser tabs (and only to them).
    proxyService?.attach(tab.webContents, () => {
      const w = shellOfView(record.id);
      if (w) tabsChanged(w);
    });
    signInService?.attach(tab.webContents, {
      changed: () => {
        const w = shellOfView(record.id);
        if (w) tabsChanged(w);
      },
      window: () => record.host?.window,
    });
    return tab;
  },
  dispose(record) {
    const view = record.view;
    if (view) {
      if (record.host && !record.host.window.isDestroyed()) record.host.window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    record.host = undefined;
    record.view = undefined;
    return true;
  },
});
function webView(url: string, title?: string): OwnedView {
  return {
    id: randomUUID(),
    kind: "web",
    title: (title || hostLabel(url) || "New tab").slice(0, 200),
    lastUsed: Date.now(),
    web: { url, title: title ?? "", canGoBack: false, canGoForward: false, loading: true, committed: false },
  };
}
/** Every web link in the app comes here: http(s) opens as a browser tab in the focused group
 * (or at `options`), mail and phone links go to the system, anything else is ignored. */
function openLink(url: unknown, w: ShellWindow | undefined = focusedShell(), options: { groupId?: string; index?: number; background?: boolean; referrer?: string; referrerUrl?: string; pdfFor?: OwnedView["pdfFor"] } = {}) {
  const web = webUrl(url);
  if (!web) {
    const external = systemUrl(url);
    if (external) void systemShell.openExternal(external);
    return;
  }
  if (!w) return void systemShell.openExternal(web);
  const previous = options.background ? activeWorkspaceTab(w.state)?.id : undefined;
  const record = webView(web);
  record.referrer = options.referrer;
  record.referrerUrl = options.referrerUrl;
  record.pdfFor = options.pdfFor;
  add(record, w, { groupId: options.groupId, index: options.index });
  if (previous && findTab(w.state, previous)) {
    w.state = activateWorkspaceTab(w.state, previous);
    layout(w);
  }
}
/** Where the browser keeps what it downloads for the reader, and the hidden library that analyses it. */
const browserCache = () => join(app.getPath("userData"), "browser-cache");
let scratchLibrary: Promise<WorkspaceInfo> | undefined;
const scratchWorkspace = () =>
  (scratchLibrary ??= registry.addHidden(join(browserCache(), "library"), "Web PDFs", { KEY_INDEX_EMBEDDINGS: "0" }).catch((error) => {
    scratchLibrary = undefined;
    throw error;
  }));
let tempPdfs: TempPdfs;
let webSources: WebSources;
let browserService: BrowserService;
let proxyService: ProxyService | undefined;
let signInService: SignInService | undefined;
let webSearchService: WebSearch | undefined;
let keyedServices: KeyedServices | undefined;
/** Embedded PDFs and article pages in browser tabs (see browser/page-actions.ts). */
const browserPages = new PageActions({
  service: () => browserService,
  incomingPath: (id) => tempPdfs.incomingPath(id),
  openPdf: (contents, file, replace) => openDownloadedPdf(contents, file, replace),
  workspaceOf: (record) => (shellOfView(record.id) ?? focusedShell())?.workspaceId,
  invoke: (command, args, workspaceId) => registry.invoke(command, args, workspaceId),
  addWork: async (workspaceId, work) => {
    if (!webSearchService) throw Error("The library is still starting");
    return webSearchService.add(workspaceId, work, true);
  },
  changed: (record) => {
    const w = shellOfView(record.id);
    if (w) tabsChanged(w);
  },
  emit,
});
/** A reader for a PDF kept from the browser, analysed in the scratch library. */
async function tempPdfView(entry: TempPdf): Promise<OwnedView> {
  const workspaceId = await tempPdfs.analyse(entry.hash);
  const info: any = await registry.invoke("library_source_info", { hash: entry.hash }, workspaceId);
  return {
    id: `pdf:${workspaceId}:${entry.hash}`,
    kind: "pdf",
    title: entry.title || info.title,
    workspaceId,
    source: info,
    temp: { url: entry.url, hash: entry.hash, referrer: entry.referrer },
    lastUsed: Date.now(),
  };
}
/** A PDF a page downloaded opens in the reader as a tab of its own; a tab that opened
 * straight onto the PDF (it never showed a page) becomes that reader. */
async function openDownloadedPdf(contents: Electron.WebContents | undefined, file: { path: string; url: string; filename: string }, replace = false) {
  const from = contents && [...views.values()].find((v) => v.kind === "web" && v.view?.webContents === contents);
  const w = (from && shellOfView(from.id)) ?? focusedShell();
  // The tab in front while the PDF is analysed: when the person moves to another tab
  // meanwhile, the reader opens behind it instead of taking it away.
  const frontBefore = w && activeWorkspaceTab(w.state)?.id;
  try {
    const page = from && (from.web?.committed ? from.web.title : from.referrer);
    // The landing page that led to the PDF (the tab's page, or the page that opened the tab).
    // Both by their own addresses when they came through a library proxy.
    const referrer = from && webUrl(properUrlOf(from.web?.committed ? from.web.url : from.referrerUrl));
    const url = properUrlOf(file.url);
    const entry = await tempPdfs.add(file.path, url, pdfTitle(file.filename, url, page), referrer !== url ? referrer : undefined);
    const record = await tempPdfView(entry);
    record.pdfFor = from?.pdfFor;
    if (!w || w.closed) return;
    if (views.has(record.id) && shellOfView(record.id)) return focus(record.id);
    const found = from && findViewTab(w.state, from.id);
    if (from && found && (!from.web?.committed || replace)) {
      views.set(record.id, record);
      w.state = replaceWorkspaceView(w.state, from.id, record.id);
      nativeKinds.web.dispose(from);
      views.delete(from.id);
      layout(w);
      focusShown(w);
      return;
    }
    const front = activeWorkspaceTab(w.state)?.id;
    add(record, w, found ? { groupId: found.group.id, index: found.index + 1 } : {});
    if (front && front !== frontBefore && findTab(w.state, front)) {
      w.state = activateWorkspaceTab(w.state, front);
      layout(w);
    }
    focusShown(w);
  } catch (error) {
    await rm(file.path, { force: true }).catch(() => undefined);
    emit("browser-notice", { message: `Could not open the PDF: ${String(error).replace(/^Error: /, "")}` });
  }
}
/** Swaps a temporary PDF's tab for the library's own reader of it, at the same place. */
async function swapToLibrary(temp: OwnedView, workspaceId: string, hash: string, notice: "added" | "exists") {
  const id = `pdf:${workspaceId}:${hash}`;
  const w = shellOfView(temp.id) ?? focusedShell();
  if (views.has(id) && shellOfView(id)) return focus(id);
  const info: any = await registry.invoke("library_source_info", { hash }, workspaceId);
  const record: OwnedView = { id, kind: "pdf", title: info.title, workspaceId, source: info, viewState: temp.viewState, libraryNotice: notice, lastUsed: Date.now() };
  views.set(id, record);
  w.state = replaceWorkspaceView(w.state, temp.id, id);
  disposePdf(temp);
  views.delete(temp.id);
  layout(w);
  focusShown(w);
}
/** What the person did on a temporary PDF goes with it into the library: its annotations
 * (highlights, comments, ink) and the notes written on it. The reading position travels
 * with the tab (see swapToLibrary). */
async function carryTempWork(entry: TempPdf, workspaceId: string, sourceId: string) {
  const scratch = await scratchWorkspace();
  const annotations = await registry.invoke<any[]>("library_annotations", { hash: entry.hash }, scratch.id).catch(() => []);
  if (annotations?.length) await registry.invoke("library_apply_annotations", { hash: entry.hash, upserts: annotations, deleted: [] }, workspaceId);
  if (!entry.sourceId) return;
  const notes = await registry.invoke<any[]>("store_notes", { sourceId: entry.sourceId }, scratch.id).catch(() => []);
  for (const note of notes ?? [])
    if (note?.body?.trim()) await registry.invoke("store_note_save", { id: null, sourceId, title: note.title ?? "", body: note.body }, workspaceId);
}
/** Adds a temporary PDF to the window's library through the usual import (identification,
 * metadata, analysis and indexing follow), with the page it came from as its URL. */
async function addTempToLibrary(temp: OwnedView) {
  const w = shellOfView(temp.id) ?? focusedShell();
  const workspaceId = w.workspaceId;
  const entry = temp.temp && (await tempPdfs.get(temp.temp.hash));
  if (!entry || !existsSync(entry.file)) throw Error("This PDF is no longer kept; open it from the page again");
  // Find PDF opened the page this came from: the PDF becomes that source's file.
  if (temp.pdfFor && temp.pdfFor.workspaceId === workspaceId) {
    const directory = await mkdtemp(join(tmpdir(), "key-web-pdf-"));
    try {
      const path = join(directory, `${safeFileName(temp.pdfFor.title || temp.title || entry.title).replace(/\.pdf$/i, "")}.pdf`);
      await copyFile(entry.file, path);
      await registry.invoke("store_attach_file", { id: temp.pdfFor.sourceId, path }, workspaceId);
      await carryTempWork(entry, workspaceId, temp.pdfFor.sourceId);
      emit("library-changed");
      await swapToLibrary(temp, workspaceId, entry.hash, "added");
      return { status: "attached" };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const known = await registry.invoke<{ items: any[] }>("store_sources", { ids: [entry.hash], limit: 1, scope: "all" }, workspaceId);
  if (known.items[0]) {
    await carryTempWork(entry, workspaceId, known.items[0].id);
    await swapToLibrary(temp, workspaceId, entry.hash, "exists");
    return { status: "exists" };
  }
  // A copy in the system's temporary folder: the library keeps a file of its own.
  const directory = await mkdtemp(join(tmpdir(), "key-web-pdf-"));
  try {
    const path = join(directory, `${safeFileName(temp.title || entry.title).replace(/\.pdf$/i, "")}.pdf`);
    await copyFile(entry.file, path);
    // The scratch library analysed this PDF already: the library takes that analysis over.
    const scratch = await scratchWorkspace().catch(() => undefined);
    const imported: any = await registry.invoke("library_import_file", { path, carryFrom: scratch ? join(scratch.root, ".key") : null }, workspaceId);
    if (imported.hash !== entry.hash) throw Error("The PDF changed while it was added");
    if (!imported.existing) await registry.invoke("store_update", { id: imported.id, patch: { url: entry.url } }, workspaceId).catch(() => undefined);
    await carryTempWork(entry, workspaceId, imported.id);
    void registry
      .invoke("library_processing_control", { hash: imported.hash, action: "resume" }, workspaceId)
      .then(() => emit("library-changed"))
      .catch((e) => emit("operation-error", String(e)));
    emit("library-changed");
    await swapToLibrary(temp, workspaceId, entry.hash, imported.existing ? "exists" : "added");
    return { status: imported.existing ? "exists" : "added" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
/** When a plain download of a PDF URL fails (a login wall, a page instead of the PDF), the
 * browser's profile tries: its cookies and logins apply, and an article page's PDF is followed. */
async function libraryDownloadWithBrowser(workspaceId: string, url: string, sourceId: string | undefined, first: unknown) {
  if (!webUrl(url) || !browserService) throw first;
  const file = await withLibraryAccess(url, async (target) => ({ value: await browserService.downloadPdf(target, { timeoutMs: 60_000 }), access: { access: "granted", reason: "sent the PDF", telling: true } })).catch(() =>
    Promise.reject(first),
  );
  try {
    if (sourceId) return await registry.invoke("store_attach_file", { id: sourceId, path: file.path }, workspaceId);
    const result: any = await registry.invoke("library_import_file", { path: file.path }, workspaceId);
    await registry.invoke("library_processing_control", { hash: result.hash, action: "resume" }, workspaceId);
    return result;
  } finally {
    await rm(file.directory, { recursive: true, force: true });
  }
}
/** Removes temporary PDFs not opened for a while (never one open in a tab). */
function cleanTempPdfs() {
  const keep = new Set([...views.values()].flatMap((v) => (v.temp ? [v.temp.hash] : [])));
  return tempPdfs.cleanup({
    ttlMs: Number(process.env.KEY_BROWSER_TEMP_TTL_MS) || DEFAULT_TTL,
    maxBytes: Number(process.env.KEY_BROWSER_TEMP_MAX_BYTES) || DEFAULT_MAX_BYTES,
    keep,
  });
}
/** Creates the native view on first show, or moves it to the window that now shows it. */
function attach(record: OwnedView, w: ShellWindow) {
  const kind = nativeKinds[record.kind];
  if (!kind) return;
  if (record.view) {
    if (record.host !== w) {
      if (record.host && !record.host.window.isDestroyed()) record.host.window.contentView.removeChildView(record.view);
      w.window.contentView.addChildView(record.view);
      record.host = w;
    }
    return;
  }
  if (kind.ready && !kind.ready()) return;
  const view = kind.create(record);
  record.view = view;
  relayDismiss(view.webContents, () => record.host?.window);
  tabSwitcher.attach(view.webContents, () => record.host);
  w.window.contentView.addChildView(view);
  record.host = w;
  view.webContents.on("focus", () => {
    const owner = shellOfView(record.id);
    const found = owner && findViewTab(owner.state, record.id);
    if (owner && found) {
      owner.state = activateWorkspaceTab(owner.state, found.tab.id);
      if (record.panel) record.panel.focused = false;
      tabsChanged(owner);
    }
  });
  // Links a reader or an editor opens come back as browser tabs (a browser tab handles its own).
  if (record.kind !== "web")
    view.webContents.setWindowOpenHandler(({ url }) => {
      openLink(url, shellOfView(record.id));
      return { action: "deny" };
    });
}
/** The content area's groups, in window pixels; the renderer lays out strips, DOM views and
 * sashes with the same function and numbers. */
function laidOutGroups(w: ShellWindow) {
  const [width, height] = w.window.getContentSize();
  return layoutGroups(w.state.groups, {
    x: w.sidebarWidth,
    y: 0,
    width: Math.max(0, width - w.sidebarWidth - (w.inspectorWidth ?? 0)),
    // The status bar runs along the window's bottom, below every group.
    height: Math.max(0, height - STATUS_BAR_HEIGHT),
  }).groups;
}
function placeViews(w: ShellWindow) {
  if (w.window.isDestroyed()) return;
  for (const rect of laidOutGroups(w)) {
    const group = w.state.groups.find((g) => g.id === rect.id);
    const tab = group?.tabs.find((t) => t.id === group.activeTabId);
    const record = tab && views.get(tab.viewId);
    if (!record?.view) continue;
    const body = groupBody(rect);
    // A reader with its panel open keeps the left part; the panel is the renderer's.
    record.view.setBounds(record.panel ? layoutPanel(body, record.panel.ratio).main : record.kind === "web" ? webPageRect(body) : body);
  }
}
/** Which native views show where: when it changes, still frames are captured again. */
const overlayKey = (w: ShellWindow) => JSON.stringify(shownTabs(w.state).map((t) => [t.viewId, views.get(t.viewId)?.view?.getBounds()]));
async function captureOverlayFrames(w: ShellWindow) {
  const ids = shownTabs(w.state).map((t) => t.viewId);
  return Promise.all(
    ids.flatMap((id) => {
      const view = views.get(id)?.view;
      if (!view || view.webContents.isDestroyed()) return [];
      const bounds = view.getBounds();
      return [
        (async () => {
          try {
            const capture = await view.webContents.capturePage(undefined, {
              stayHidden: true,
            });
            return {
              id,
              ...bounds,
              image: capture
                .resize({ width: Math.max(1, bounds.width) })
                .toDataURL(),
            };
          } catch {
            return null;
          }
        })(),
      ];
    }),
  ).then((frames) => frames.filter(Boolean));
}
function refreshOverlayFrames(w: ShellWindow) {
  if (!w.globalOverlay) return;
  const key = overlayKey(w);
  if (key === w.overlayCaptureKey) return;
  w.overlayCaptureKey = key;
  const id = w.globalOverlay,
    sequence = ++w.overlayCaptureSequence;
  emitTo(w, "global-overlay-frames", { id, frames: [] });
  void captureOverlayFrames(w).then((frames) => {
    if (w.globalOverlay === id && sequence === w.overlayCaptureSequence)
      emitTo(w, "global-overlay-frames", { id, frames });
  });
}
function layout(w: ShellWindow = focusedShell()) {
  if (!w || w.window.isDestroyed()) return;
  w.state = normalizeTabs(w.state);
  const shown = new Set(shownViewIds(w));
  for (const id of shown) {
    const record = views.get(id);
    if (!record) continue;
    record.lastUsed = Date.now();
    attach(record, w);
  }
  // Views hosted here that this window no longer shows are hidden (they may now be in another window).
  for (const record of views.values())
    if (record.view && record.host === w) record.view.setVisible(!w.globalOverlay && shown.has(record.id));
  placeViews(w);
  refreshOverlayFrames(w);
  const shownTab = activeWorkspaceTab(w.state)?.id;
  if (shownTab && w.mru?.[0] !== shownTab) w.mru = touchMru(w.mru ?? [], shownTab, new Set(allTabs(w.state).map((t) => t.id)));
  // Only the two most recently used PDF renderers retain their raster/GPU caches, across all windows.
  const visible = new Set(liveShells().flatMap((s) => shownViewIds(s)));
  const pdfs = [...views.values()].filter((v) => v.kind === "pdf" && v.view);
  const keep = Math.max(0, 2 - pdfs.filter((v) => visible.has(v.id)).length);
  const inactive = pdfs
    .filter((v) => !visible.has(v.id))
    .sort((a, b) => b.lastUsed - a.lastUsed);
  for (const record of inactive.slice(keep)) {
    if (!visible.has(record.id) && record.view) {
      disposePdf(record);
    }
  }
  tabsChanged(w);
}
/** Shows a view wherever it is open (in its group, which takes focus), bringing its window forward. */
function focus(id: string) {
  const w = shellOfView(id);
  const host = panelHost(id);
  const found = w && findViewTab(w.state, host?.id ?? id);
  if (w && found) {
    w.state = activateWorkspaceTab(w.state, found.tab.id);
    if (host?.panel) host.panel.focused = true;
    else {
      const panel = views.get(id)?.panel;
      if (panel) panel.focused = false;
    }
    layout(w);
    if (!w.window.isFocused()) w.window.focus();
  }
}
/** Where the next `add` puts its view: beside a pane, or in a pane's place (with history). */
let placement: { mode: "split" | "here"; viewId: string } | undefined;
async function withPlacement(p: any, open: () => Promise<unknown>) {
  placement = p.placement === "split" || p.placement === "here" ? { mode: p.placement, viewId: String(p.fromViewId ?? "") } : undefined;
  try {
    await open();
  } finally {
    placement = undefined;
  }
}
const paneEntry = (v: OwnedView): PaneEntry => ({ title: v.title, contentKey: v.contentKey, content: v.content });
/** Follows a link inside a DOM pane: it shows `record`'s content and remembers what it showed. */
function navigateInPlace(w: ShellWindow, pane: OwnedView, record: OwnedView) {
  views.delete(record.id);
  pane.back = [...(pane.back ?? []), paneEntry(pane)].slice(-50);
  pane.forward = [];
  Object.assign(pane, { title: record.title, contentKey: record.contentKey, content: record.content, workspaceId: record.workspaceId, dirty: false, nav: (pane.nav ?? 0) + 1 });
  focus(pane.id);
  tabsChanged(w);
}
/** Back (-1) or forward (1) in a pane's history; an entry open elsewhere is focused there. */
function stepHistory(w: ShellWindow, viewId: string, step: number) {
  const pane = views.get(viewId);
  if (pane?.kind === "web") {
    const history = pane.view?.webContents.navigationHistory;
    if (step < 0 ? history?.canGoBack() : history?.canGoForward()) step < 0 ? history!.goBack() : history!.goForward();
    return;
  }
  if (!pane || pane.dirty) return;
  const from = step < 0 ? pane.back : pane.forward;
  const entry = from?.pop();
  if (!entry) return;
  const elsewhere = [...views.values()].find((v) => v !== pane && v.contentKey === entry.contentKey);
  if (elsewhere && shellOfView(elsewhere.id)) return focus(elsewhere.id);
  (step < 0 ? (pane.forward ??= []) : (pane.back ??= [])).push(paneEntry(pane));
  Object.assign(pane, entry, { dirty: false, nav: (pane.nav ?? 0) + 1 });
  tabsChanged(w);
}
/** Opens `record` as a new tab: in the focused group of `w` by default, in `options.groupId`
 * when given, or beside / in place of a view while a `placement` is pending. This is how
 * every kind of view opens. */
function add(record: OwnedView, w: ShellWindow = focusedShell(), options: { groupId?: string; index?: number } = {}) {
  const target = placement && views.get(placement.viewId);
  const mode = placement?.mode;
  placement = undefined;
  // A docked panel keeps showing its source: links followed from it open as tabs.
  const docked = target && panelHost(target.id);
  if (mode === "here" && !docked && target?.kind === "home" && target.content && !target.dirty && record.kind === "home" && shellOfView(target.id) === w) {
    navigateInPlace(w, target, record);
    return undefined;
  }
  views.set(record.id, record);
  const tab = singleWorkspaceTab(record.id);
  // Beside: in the group right of the one showing `target`, or a new group there.
  const from = mode === "split" && target ? findViewTab(w.state, tabViewId(target.id)) : undefined;
  if (from) {
    const right = neighbourGroup(w.state, from.group.id, "right");
    w.state = right ? addWorkspaceTab(w.state, tab, { groupId: right.id }) : addGroupWithTab(w.state, tab, from.group.id, "right");
    layout(w);
    return record.view;
  }
  // A launcher (the Home tab Split Right opened) is replaced by what it opens.
  const current = !options.groupId ? activeWorkspaceTab(w.state) : undefined;
  const launcher = current ? views.get(current.viewId) : undefined;
  if (launcher?.launcher && launcher.content?.section === "home" && !launcher.back?.length) {
    w.state = replaceWorkspaceView(w.state, launcher.id, record.id);
    views.delete(launcher.id);
    layout(w);
    return record.view;
  }
  w.state = addWorkspaceTab(w.state, tab, options);
  layout(w);
  return record.view;
}
/** Closes a tab (and a reader's panel with it) after unsaved-change checks. Returns false if
 * the user kept it. `windowClosing` leaves an emptied window empty instead of opening Home. */
async function closeTab(w: ShellWindow, id: string, windowClosing = false): Promise<boolean> {
  const found = findTab(w.state, id);
  if (!found) return true;
  if (!(await closeViews(w, withPanel(found.tab.viewId)))) return false;
  if (windowClosing) return true;
  afterClose(w);
  return true;
}
/** Closes the tab showing `viewId`, or the panel when it is a docked panel. */
async function closeView(w: ShellWindow, viewId: string): Promise<boolean> {
  const host = panelHost(viewId);
  if (host) {
    closePanel(host);
    layout(w);
    return true;
  }
  const found = findViewTab(w.state, viewId);
  return found ? closeTab(w, found.tab.id) : true;
}
/** Closes several tabs in turn; stops at the first one the user keeps. */
async function closeTabs(w: ShellWindow, ids: string[]) {
  for (const id of ids) if (!(await closeTab(w, id))) return;
}
function pinTab(w: ShellWindow, tabId: string, pinned: boolean) {
  w.state = pinWorkspaceTab(w.state, tabId, pinned);
  tabsChanged(w);
}
// An emptied extra window closes; the last window keeps a Home tab.
function afterClose(w: ShellWindow) {
  const empty = !allTabs(w.state).length;
  if (empty && liveShells().length > 1) w.window.close();
  else if (empty) home(w);
  else layout(w);
}
/** Docks a source's page in its reader's tab, as the reader's details-and-notes panel. The
 * page leaves any tab it had (from any window). */
function dockPanel(pdf: OwnedView, page: OwnedView) {
  if (pdf.panel?.viewId !== page.id) {
    if (pdf.panel) closePanel(pdf);
    const owner = shellOfView(page.id);
    const found = owner && findViewTab(owner.state, page.id);
    if (owner && found) {
      owner.state = closeWorkspaceTab(owner.state, found.tab.id);
      if (owner !== shellOfView(pdf.id)) afterClose(owner);
    }
    pdf.panel = { viewId: page.id, ratio: pdf.panelRatio ?? PANEL_RATIO };
  }
  pdf.panel.tab = "details";
  pdf.view?.webContents.send("reader-notes", "details");
  focus(pdf.id);
}
/** A saved web page's reader: its source's details (or its highlights, its references)
 * docked beside it in the same tab, as a PDF's are. Shows `wanted`, or hides the panel when
 * it shows that already. Answers what the panel shows then, or false. */
function toggleWebPanel(w: ShellWindow, reader: OwnedView, wanted?: PanelTab) {
  const sourceId = reader.content?.sourceId;
  const workspaceId = reader.content?.workspaceId ?? reader.workspaceId;
  if (reader.content?.section !== "webpage" || !sourceId || !workspaceId) throw Error("Not a web page reader");
  if (reader.panel && wanted && (reader.panel.tab ?? "details") !== wanted) {
    reader.panel.tab = wanted;
    tabsChanged(w);
    return wanted;
  }
  if (reader.panel) {
    closePanel(reader);
    layout(w);
    return false;
  }
  const key = JSON.stringify(["source", workspaceId, null, sourceId]);
  let page = [...views.values()].find((v) => v.contentKey === key);
  if (!page) {
    page = {
      id: randomUUID(),
      kind: "home",
      title: String(reader.title || "Untitled").slice(0, 200),
      workspaceId,
      lastUsed: Date.now(),
      contentKey: key,
      content: { section: "source", workspaceId, sourceId },
    };
    views.set(page.id, page);
  }
  dockPanel(reader, page);
  reader.panel!.tab = wanted ?? "details";
  layout(w);
  return reader.panel!.tab;
}
/** Hides a reader's panel; its page is let go (the note saves as it is written). */
function closePanel(pdf: OwnedView) {
  const panel = pdf.panel;
  if (!panel) return;
  pdf.panel = undefined;
  pdf.panelRatio = panel.ratio;
  views.delete(panel.viewId);
  pdf.view?.webContents.send("reader-notes", false);
}
/** The panel's page moves into a tab of its own, right after its reader's. */
function popOutPanel(w: ShellWindow, pdf: OwnedView) {
  const panel = pdf.panel;
  const found = findViewTab(w.state, pdf.id);
  if (!panel || !found || !views.has(panel.viewId)) return;
  pdf.panel = undefined;
  pdf.panelRatio = panel.ratio;
  pdf.view?.webContents.send("reader-notes", false);
  w.state = addWorkspaceTab(w.state, singleWorkspaceTab(panel.viewId), { groupId: found.group.id, index: found.index + 1 });
  layout(w);
}
/** Closed tabs, newest last, for Reopen Closed Tab. */
const closedViews: SavedView[] = [];
async function reopenClosed(w: ShellWindow) {
  while (closedViews.length) {
    const record = await restoredView(closedViews.pop()!);
    if (record) return void add(record, w);
  }
}
/** Checks every view for unsaved changes before disposing any, then disposes them all
 * (with the tabs showing them). */
async function closeViews(w: ShellWindow, ids: string[]): Promise<boolean> {
  for (const viewId of ids) {
    // A panel goes with its reader: reopening the reader is enough.
    const saved = panelHost(viewId) ? undefined : savedView(viewId);
    if (saved && saved.type !== "home") closedViews.push(saved);
  }
  closedViews.splice(0, Math.max(0, closedViews.length - 20));
  for (const viewId of ids) {
    const record = views.get(viewId);
    if (record?.dirty) {
      const result = await dialog.showMessageBox(w.window, {
        type: "warning",
        message: `Discard unsaved changes to ${record.title}?`,
        detail: "Return to the tab and save to keep your changes.",
        buttons: ["Cancel", "Discard"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) {
        focus(viewId);
        return false;
      }
    }
    const kind = record && nativeKinds[record.kind];
    if (record && kind?.canClose && !(await kind.canClose(record))) {
      focus(viewId);
      return false;
    }
  }
  const dropTab = (viewId: string) => {
    const found = findViewTab(w.state, viewId);
    if (found) w.state = closeWorkspaceTab(w.state, found.tab.id);
  };
  for (const viewId of [...ids]) {
    const record = views.get(viewId);
    if (!record) {
      dropTab(viewId);
      continue;
    }
    const kind = nativeKinds[record.kind];
    if (kind && !(await kind.dispose(record))) return false;
    views.delete(viewId);
    if (searchPreviews.has(viewId)) {
      const session = searchPreviews.get(viewId)!;
      session.dismissed = true;
      ++session.sequence;
      searchPreviews.delete(viewId);
    }
    dropTab(viewId);
  }
  return true;
}
/** Files Key has no editor for (Word, Excel and PowerPoint files saved by earlier versions)
 * open in their default app, with a note saying why. */
async function openInDefaultApp(path: string) {
  if (!existsSync(path)) throw Error(`This file is no longer at ${path}`);
  const error = await systemShell.openPath(path);
  if (error) throw Error(error);
  notify("info", `Key can't edit ${basename(path)} yet, so it opened in its default app.`);
}
async function sourceOpen(source: any, hit?: any, results?: any[], w: ShellWindow = focusedShell()) {
  const origin = views.get(activeViewId(w) ?? "");
  const returnViewId = origin?.content ? origin.id : origin?.returnViewId;
  const workspaceId = source.workspaceId ?? hit?.workspaceId ?? w.workspaceId;
  if (!workspaceId) throw Error("Choose a workspace");
  const hash = source.documentHash ?? source.hash;
  const id = `pdf:${workspaceId}:${hash}`;
  const info = await registry.invoke(
    "library_source_info",
    { hash },
    workspaceId,
  );
  let target = hit
    ? await registry.invoke(
        "resolve_search_target",
        { id: hit.id },
        workspaceId,
      )
    : undefined;
  const searchResults =
    hit && Array.isArray(results)
      ? results.slice(0, 1000).map((h) => ({
          id: h.id,
          documentHash: h.documentHash,
          documentTitle: h.documentTitle,
          workspaceId: h.workspaceId ?? workspaceId,
        }))
      : undefined;
  const searchIndex = searchResults?.findIndex(
    (h) => h.id === hit.id && h.workspaceId === workspaceId,
  );
  const existing = views.get(id);
  if (existing) {
    existing.sharedSearchNavigation = false;
    existing.returnViewId = returnViewId ?? existing.returnViewId;
    existing.searchTarget = target;
    existing.searchResults = searchResults;
    existing.searchIndex = searchIndex;
    focus(id);
    if (target) existing.view?.webContents.send("search-target", target);
    existing.view?.webContents.send("search-navigation", {
      shared: false,
      index: searchIndex ?? -1,
      total: searchResults?.length ?? 0,
    });
    return;
  }
  add({
    id,
    title: source.title ?? source.documentTitle ?? (info as any).title,
    kind: "pdf",
    returnViewId,
    workspaceId,
    source: info,
    searchTarget: target,
    searchResults,
    searchIndex,
    lastUsed: Date.now(),
  }, w);
}
async function importSources(workspaceId?: string, w: ShellWindow = focusedShell()) {
  workspaceId ??= w.workspaceId;
  const result = await dialog.showOpenDialog(w.window, {
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "PDFs",
        extensions: ["pdf"],
      },
    ],
  });
  for (const path of result.filePaths) {
    const info: any = await registry.invoke(
      "library_import_file",
      { path },
      workspaceId,
    );
    emit("library-changed");
    void registry
      .invoke(
        "library_processing_control",
        { hash: info.hash, action: "resume" },
        workspaceId,
      )
      .then(() => emit("library-changed"))
      .catch((e) => emit("operation-error", String(e)));
  }
  emit("library-changed");
}
let workspaceParent = "";
/** The "Zotero" workspace beside the default one, created on first use. */
const dedicatedZoteroWorkspace = () => registry.add(join(workspaceParent, "Zotero"), "Zotero");
/** The workspace Zotero imports into or syncs with: the one asked for (any workspace can),
 * else the dedicated "Zotero" workspace as before. */
async function zoteroWorkspace(workspaceId?: unknown) {
  if (typeof workspaceId === "string" && workspaceId) {
    const found = (await registry.known()).find((w) => w.id === workspaceId);
    if (found) return found;
  }
  return dedicatedZoteroWorkspace();
}
/** Every workspace that syncs with Zotero: the dedicated "Zotero" workspace (when it exists)
 * and any other whose host keeps a sync state. Only asks what is registered: looking
 * must not create the default workspace (the workspaces window shows a first run as empty). */
async function zoteroLinkedWorkspaces() {
  const dedicated = await realpath(join(workspaceParent, "Zotero")).catch(() => "");
  return (await registry.known()).filter((w) => w.root === dedicated || existsSync(join(w.root, ".key", "zotero-sync.sqlite")));
}
/** Imports the Zotero library into the chosen workspace (by default its own "Zotero" one). */
async function importZotero(options?: Record<string, unknown>) {
  const { proxies, workspaceId, ...rest } = options ?? {};
  const workspace = await zoteroWorkspace(workspaceId);
  const report = await registry.invoke("store_import_zotero", rest, workspace.id);
  emit("library-changed");
  if (proxies) await importLibraryProxies({ dataDir: typeof rest.dataDir === "string" ? rest.dataDir : undefined, follow: true }).catch(() => undefined);
  return { workspace, report };
}
/** Zotero's library proxies (its desktop tables and its Connectors), merged into the browser's. */
let proxiesImportedAt = 0;
async function importLibraryProxies({ zotero = true, connector = true, dataDir, follow }: { zotero?: boolean; connector?: boolean; dataDir?: string; follow?: boolean } = {}) {
  if (!proxyService) throw Error("The browser is still starting");
  proxiesImportedAt = Date.now();
  const found = await importProxies({ zotero, connector, dataDir });
  const merged = await proxyService.merge(found.flatMap((f) => f.proxies));
  if (follow && !proxyService.data.prefs.followZotero) await proxyService.setPrefs({ followZotero: true });
  return { found: found.map((f) => ({ label: f.label, count: f.proxies.length })), ...merged, data: proxyService.snapshot() };
}
/** While Zotero sync is on, asks the Zotero workspace to sync; its host only reads
 *  zotero.sqlite again when the file changed. Nothing runs before a first import. */
let zoteroSyncing = false;
async function syncZotero(force = false) {
  if (zoteroSyncing || !appSettings?.get().zoteroSync) return;
  zoteroSyncing = true;
  try {
    for (const workspace of await zoteroLinkedWorkspaces()) {
      const result: any = await registry.invoke("store_zotero_sync", { force }, workspace.id).catch((e) => console.warn("Zotero sync:", e));
      if (result?.ran) emit("library-changed");
    }
    // Proxies added in Zotero (or its Connector) follow, now and then.
    if (proxyService?.data.prefs.followZotero && Date.now() - proxiesImportedAt > 60 * 60_000) void importLibraryProxies().catch(() => undefined);
  } catch (e) {
    console.warn("Zotero sync:", e);
  } finally {
    zoteroSyncing = false;
  }
}
/** Quick capture (⌃⌥Space from anywhere): a small window for a thought or a link. */
let captureWindow: BrowserWindow | undefined;
function quickCapture() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.show();
    captureWindow.focus();
    return;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = 560,
    height = 236;
  captureWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height * 0.22),
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: "Quick capture",
    ...(process.platform === "darwin" ? { vibrancy: "hud" as const, visualEffectState: "active" as const, backgroundColor: "#00000000", roundedCorners: true } : {}),
    webPreferences: WINDOW_OPTIONS.webPreferences,
  });
  const win = captureWindow;
  win.once("ready-to-show", () => win.show());
  win.on("blur", () => !win.isDestroyed() && win.close());
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#capture`);
  else void win.loadFile(join(renderer, "index.html"), { hash: "capture" });
}
/** Saves a capture to the focused window's workspace: a link joins the Inbox, text becomes a note. */
async function saveCapture(text: string) {
  const workspaceId = focusedShell()?.workspaceId || knownWorkspaces[0]?.id;
  if (!workspaceId || !text.trim()) return;
  const value = text.trim();
  if (/^https?:\/\/\S+$/i.test(value)) {
    const collections = await registry.invoke<{ id: string; name: string; parentId: string | null }[]>("store_collections", {}, workspaceId);
    const inbox =
      collections.find((c) => !c.parentId && c.name === "Inbox")?.id ??
      (await registry.invoke<{ id: string }>("store_collection_create", { name: "Inbox", parentId: null }, workspaceId)).id;
    await registry.invoke("store_create", { source: { kind: "web", itemType: "webpage", title: value, url: value, collections: [inbox] } }, workspaceId);
  } else {
    const [first, ...rest] = value.split("\n");
    await registry.invoke("store_note_save", { id: null, sourceId: null, title: first.slice(0, 200), body: rest.join("\n").trim() }, workspaceId);
  }
  emit("library-changed");
}

const WINDOW_OPTIONS = {
  width: 1440,
  height: 960,
  minWidth: 850,
  minHeight: 600,
  title: "Key",
  titleBarStyle: "hiddenInset" as const,
  trafficLightPosition: { x: 16, y: 14 },
  // The renderer leaves the sidebar translucent; the content column stays opaque.
  ...(process.platform === "darwin"
    ? {
        vibrancy: "sidebar" as const,
        visualEffectState: "followWindow" as const,
        backgroundColor: "#00000000",
      }
    : {}),
  webPreferences: {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
};
/** Opens a window on a workspace. With `tabs`, it starts with those (moved) tabs in one group;
 * with `saved`, it takes that window's frame and restores its tabs; otherwise it shows Home. */
function createShell(
  options: { workspaceId?: string; tabs?: WorkspaceTab[]; saved?: SavedWindow; load?: boolean } = {},
): ShellWindow {
  const previous = focusedShell();
  const frame = options.saved?.bounds && visibleBounds(options.saved.bounds);
  const window = new BrowserWindow({
    ...WINDOW_OPTIONS,
    ...(frame
      ? frame
      : // New windows cascade from the one they came from.
        previous
        ? (() => {
            const [x, y] = previous.window.getPosition();
            const [width, height] = previous.window.getSize();
            return { x: x + 28, y: y + 28, width, height };
          })()
        : {}),
  });
  if (options.saved?.maximized) window.maximize();
  if (options.saved?.fullScreen) window.setFullScreen(true);
  const w: ShellWindow = {
    id: randomUUID(),
    window,
    workspaceId: options.saved?.workspaceId ?? options.workspaceId ?? previous?.workspaceId ?? knownWorkspaces[0]?.id ?? "",
    state: options.tabs?.length ? tabsState(options.tabs) : emptyTabsState(),
    sidebarWidth: options.saved?.sidebarWidth ?? previous?.sidebarWidth ?? 240,
    overlayCaptureSequence: 0,
    overlayCaptureKey: "",
  };
  shells.set(w.id, w);
  focusOrder.unshift(w.id);
  titleWindow(w);
  touchRecent(w.workspaceId);
  // The window's title names its workspace, not the page.
  window.on("page-title-updated", (event) => event.preventDefault());
  relayDismiss(window.webContents, () => window);
  tabSwitcher.attach(window.webContents, () => w, true);
  // Ctrl let go while another app had focus: no switch. (Smokes: other apps take the foreground.)
  if (process.env.KEY_SKIP_ONBOARDING !== "1") window.on("blur", () => tabSwitcher.cancel(w));
  dismissOnBlur(window);
  dismissOnMove(window);
  window.webContents.on("did-start-loading", () => {
    if (w.globalOverlay) {
      w.globalOverlay = undefined;
      w.overlayCaptureKey = "";
      ++w.overlayCaptureSequence;
      layout(w);
    }
  });
  window.on("resize", () => layout(w));
  // In native full screen the traffic lights are gone, so the chrome drops their inset.
  window.on("enter-full-screen", () => emitTo(w, "full-screen", true));
  window.on("leave-full-screen", () => emitTo(w, "full-screen", false));
  window.on("move", () => saveWindows());
  window.on("focus", () => {
    lastFocusedShell = w;
    focusOrder.splice(focusOrder.indexOf(w.id) >>> 0, 1);
    focusOrder.unshift(w.id);
    refreshMenu();
  });
  window.on("close", (event) => {
    if (w.closed) return;
    event.preventDefault();
    // Quitting, or closing the last window, keeps every window for the next launch;
    // closing one of several keeps its arrangement for the next visit to its workspace.
    const ending = quitRequested || liveShells().length === 1;
    // The workspaces window keeps the app open: the workspace's arrangement waits for its next visit.
    const staying = launcherMode && !quitRequested;
    void launcher?.cacheSummary(w.workspaceId);
    if (ending && staying) windowState.layouts[w.workspaceId] = savedTabs(w);
    if (ending) freezeWindows();
    else windowState.layouts[w.workspaceId] = savedTabs(w);
    void (async () => {
      for (const tab of allTabs(w.state)) {
        if (!(await closeTab(w, tab.id, true))) {
          quitRequested = false;
          frozen = false;
          layout(w);
          return;
        }
      }
      w.closed = true;
      shells.delete(w.id);
      focusOrder.splice(focusOrder.indexOf(w.id) >>> 0, 1);
      if (lastFocusedShell === w) lastFocusedShell = undefined;
      for (const other of liveShells()) tabsChanged(other);
      if (!liveShells().length && staying && !quitRequested) {
        window.destroy();
        frozen = false;
        launcher?.show();
        refreshMenu();
        return;
      }
      if (!liveShells().length) {
        await registry.close();
        window.destroy();
        app.quit();
        return;
      }
      window.destroy();
      if (quitRequested) app.quit();
      else saveWindows();
    })();
  });
  if (options.load !== false) {
    void (async () => {
      if (options.saved) await restoreTabs(w, options.saved.tabs);
      if (!allTabs(w.state).length) home(w);
      await loadShell(w);
      layout(w);
      for (const other of liveShells()) if (other !== w) tabsChanged(other);
    })().catch((error) => emit("operation-error", String(error)));
  }
  return w;
}
async function loadShell(w: ShellWindow) {
  if (process.env.ELECTRON_RENDERER_URL) await w.window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await w.window.loadFile(join(renderer, "index.html"));
}
/** A saved frame, if it still shows enough of itself on a connected display. */
function visibleBounds(bounds: { x: number; y: number; width: number; height: number }) {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return undefined;
  const width = Math.max(WINDOW_OPTIONS.minWidth, Math.round(bounds.width)),
    height = Math.max(WINDOW_OPTIONS.minHeight, Math.round(bounds.height));
  const fits = screen.getAllDisplays().some(({ workArea: a }) => {
    const across = Math.min(bounds.x + width, a.x + a.width) - Math.max(bounds.x, a.x);
    const down = Math.min(bounds.y + height, a.y + a.height) - Math.max(bounds.y, a.y);
    return across >= 120 && down >= 80 && bounds.y >= a.y - 4;
  });
  return fits ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width, height } : { width, height };
}

// Workspaces, as last listed by the registry, for titles and menus.
let knownWorkspaces: WorkspaceInfo[] = [];
async function refreshWorkspaces() {
  // The workspaces window can show an empty list; workspace windows always have one.
  const before = JSON.stringify(knownWorkspaces);
  knownWorkspaces = launcherMode && !liveShells().length ? await registry.known() : await registry.list();
  await launcher?.refreshKnown();
  // One list for every window: the switcher, Workspace Settings' picker and the workspaces window.
  if (JSON.stringify(knownWorkspaces) !== before) {
    emit("workspaces-changed");
    launcher?.changed();
  }
  for (const w of liveShells()) titleWindow(w);
  refreshMenu();
  return knownWorkspaces;
}
function titleWindow(w: ShellWindow) {
  if (w.window.isDestroyed()) return;
  const workspace = knownWorkspaces.find((k) => k.id === w.workspaceId);
  w.window.setTitle(workspace?.name ?? "Key");
  // macOS shows the folder in the Window menu and Mission Control.
  if (process.platform === "darwin" && workspace) w.window.setRepresentedFilename(workspace.root);
}
function touchRecent(workspaceId: string) {
  if (!workspaceId) return;
  windowState.recent = [workspaceId, ...windowState.recent.filter((id) => id !== workspaceId)].slice(0, 32);
  launcher?.touched(workspaceId);
}

/** Opens `workspaceId`: in place in `w`, or in a window of its own. A window already
 * showing it comes forward instead, so switching never opens one library twice. */
async function switchWorkspace(w: ShellWindow, workspaceId: string, newWindow = false) {
  if (!knownWorkspaces.some((k) => k.id === workspaceId)) await refreshWorkspaces();
  if (!knownWorkspaces.some((k) => k.id === workspaceId)) throw Error("This workspace is no longer available");
  if (w.workspaceId === workspaceId && !newWindow) return;
  const showing = liveShells().find((s) => s.workspaceId === workspaceId);
  if (showing) {
    if (showing.window.isMinimized()) showing.window.restore();
    showing.window.focus();
    return;
  }
  const remembered = windowState.layouts[workspaceId];
  if (newWindow) {
    createShell({ workspaceId, saved: remembered ? { workspaceId, tabs: remembered } : undefined });
    touchRecent(workspaceId);
    return;
  }
  // Leaving: check for unsaved work first, then remember the arrangement and close it.
  const leaving = savedTabs(w);
  if (!(await closeViews(w, windowViewIds(w)))) {
    layout(w);
    return;
  }
  windowState.layouts[w.workspaceId] = leaving;
  w.workspaceId = workspaceId;
  touchRecent(workspaceId);
  titleWindow(w);
  w.state = emptyTabsState();
  if (remembered) await restoreTabs(w, remembered);
  if (!allTabs(w.state).length) {
    // A workspace seen for the first time opens on its library.
    await openContent(w, { section: "sources", workspaceId });
  }
  refreshMenu();
  layout(w);
}

/** A `key://` link from another app: shown by the front workspace window, or, with none open,
 * by the most recent workspace, opened for it (the link waits until that window listens). */
function sendItemLink(url: string) {
  const w = focusedShell();
  if (!w || w.window.isDestroyed()) {
    const id = windowState.recent.find((r) => knownWorkspaces.some((k) => k.id === r)) ?? knownWorkspaces[0]?.id;
    if (launcherMode && id) void openFromLauncher(id, {}).then(() => launcher?.close(), () => launcher?.show());
    else launcher?.show();
    return false;
  }
  if (w.window.webContents.isLoading()) return false;
  w.window.show();
  w.window.focus();
  emitTo(w, "open-item-link", url);
  return true;
}
/** The window to open `workspaceId` in: last time's frame, with its latest arrangement. */
function lastWindow(workspaceId: string): SavedWindow {
  const saved = windowState.windows.find((s) => s.workspaceId === workspaceId);
  const tabs = windowState.layouts[workspaceId] ?? saved?.tabs ?? { groups: [], active: 0 };
  return { ...saved, workspaceId, tabs };
}
/** Opens a workspace from the workspaces window (or a link): brings its window forward, or
 * opens one, then runs what was asked for there (the Zotero sheet, adding files …). */
async function openFromLauncher(workspaceId: string, options: { newWindow?: boolean; command?: string; files?: string[] }) {
  if (!knownWorkspaces.some((k) => k.id === workspaceId)) await refreshWorkspaces();
  if (!knownWorkspaces.some((k) => k.id === workspaceId)) throw Error("This workspace is no longer available");
  let w = liveShells().find((s) => s.workspaceId === workspaceId);
  if (w) {
    if (w.window.isMinimized()) w.window.restore();
    w.window.show();
    w.window.focus();
  } else {
    // Only the first window takes last time's frame; others cascade from the front one.
    const saved = lastWindow(workspaceId);
    w = createShell({ workspaceId, saved: liveShells().length ? { workspaceId, tabs: saved.tabs } : saved.tabs.groups.length || saved.bounds ? saved : undefined });
  }
  const target = w;
  const then = async () => {
    deliverDeepLinks(sendItemLink);
    if (options.files?.length) {
      await registry.invoke("store_import_files", { paths: options.files, collectionId: null }, workspaceId);
      emit("library-changed");
      await openContent(target, { section: "sources", workspaceId });
      layout(target);
    }
    if (options.command === "add-files") {
      const picked = await dialog.showOpenDialog(target.window, { title: "Add sources", properties: ["openFile", "multiSelections"] });
      if (!picked.canceled && picked.filePaths.length) {
        await registry.invoke("store_import_files", { paths: picked.filePaths, collectionId: null }, workspaceId);
        emit("library-changed");
      }
      await openContent(target, { section: "sources", workspaceId });
      layout(target);
    } else if (options.command) emitTo(target, "command", options.command);
  };
  const run = () => void then().catch((e) => emitTo(target, "operation-error", String(e)));
  if (target.window.webContents.isLoading() || !target.window.webContents.getURL()) target.window.webContents.once("did-finish-load", () => setTimeout(run, 1200));
  else run();
}

// Persistence: every window's workspace, frame and tabs, saved as view descriptors.
let windowState: WindowState = { version: 2, windows: [], layouts: {}, recent: [] };
let windowStore: WindowStateStore;
/** Window ids, front-most first. */
const focusOrder: string[] = [];
/** Set while windows close for quitting, so their emptying tabs are not saved. */
let frozen = false;
function savedView(id: string): SavedView | undefined {
  const v = views.get(id);
  if (!v) return undefined;
  if (v.temp) return { type: "web-pdf", url: v.temp.url, hash: v.temp.hash, title: v.title };
  if (v.kind === "web") return v.web ? { type: "web", url: v.web.url, title: v.title } : undefined;
  if (v.kind === "pdf")
    return v.workspaceId ? { type: "pdf", workspaceId: v.workspaceId, hash: v.source?.hash ?? v.id.split(":").at(-1)!, title: v.title } : undefined;
  const c = v.content;
  if (!c || c.section === "home") return { type: "home" };
  // A record that was never saved has nothing to reopen.
  if (c.section === "record" && !c.record?.id) return undefined;
  if (!["sources", "records", "record", "note", "source", "webpage", "canvas", "search", "inbox", "databases", "file", ...ENTITY_SECTIONS].includes(c.section)) return undefined;
  return {
    type: "content",
    section: c.section as "sources",
    workspaceId: c.workspaceId,
    projectId: c.projectId,
    noteId: c.noteId,
    sourceId: c.sourceId,
    canvasId: c.canvasId,
    fileId: c.fileId,
    entityId: c.entityId,
    recordId: c.record?.id,
    title: v.title,
  };
}
function savedTabs(w: ShellWindow): SavedTabs {
  const groups: SavedGroup[] = [];
  let active = 0;
  for (const group of w.state.groups) {
    const tabs: SavedTab[] = [];
    let shown = 0;
    for (const tab of group.tabs) {
      const view = savedView(tab.viewId);
      if (!view) continue;
      if (tab.id === group.activeTabId) shown = tabs.length;
      const panel = views.get(tab.viewId)?.panel;
      const panelView = panel && savedView(panel.viewId);
      tabs.push({ view, ...(tab.pinned ? { pinned: true } : {}), ...(panel && panelView ? { panel: { view: panelView, ratio: panel.ratio } } : {}) });
    }
    if (!tabs.length) continue;
    if (group.id === w.state.activeGroupId) active = groups.length;
    groups.push({ tabs, active: shown, size: group.size });
  }
  return { groups, active };
}
function windowStateNow(): WindowState {
  const ordered = focusOrder.map((id) => shells.get(id)).filter((w): w is ShellWindow => !!w && !w.closed && !w.window.isDestroyed());
  return {
    ...windowState,
    // With no workspace window open (only the workspaces window), last time's windows stay.
    windows: !ordered.length ? windowState.windows : ordered.map((w) => ({
      workspaceId: w.workspaceId,
      bounds: w.window.getNormalBounds(),
      maximized: w.window.isMaximized(),
      fullScreen: w.window.isFullScreen(),
      sidebarWidth: w.sidebarWidth,
      tabs: savedTabs(w),
    })),
  };
}
function saveWindows() {
  if (!frozen && windowStore) windowStore.schedule(windowStateNow);
}
function freezeWindows() {
  if (frozen || !windowStore) return;
  windowState = windowStateNow();
  windowStore.writeNow(windowState);
  frozen = true;
}

/** People, journals and topics open as pages of their own; the host command that reads each. */
const ENTITY_SECTIONS = ["person", "venue", "topic", "tag"];
const ENTITY_COMMAND: Record<string, string> = { person: "store_person", venue: "store_venue", topic: "store_topic", tag: "store_tag" };
const contentKey = (section: string, workspaceId?: string, projectId?: string, id?: string | null) =>
  section === "record" && id
    ? JSON.stringify(["record", workspaceId, id])
    : JSON.stringify([section, workspaceId || null, projectId || null, id ?? null]);
/** Opens (or focuses) a library list, record, note or source page in `w`. */
async function openContent(w: ShellWindow, p: any) {
  if (!["sources", "records", "record", "note", "canvas", "highlights", "search", "inbox", "databases", "file", "webpage", ...ENTITY_SECTIONS].includes(p.section))
    throw Error("Invalid content view");
  if (p.section === "webpage" && (typeof p.sourceId !== "string" || !p.sourceId))
    throw Error("Choose a saved page");
  if (ENTITY_SECTIONS.includes(p.section) && (typeof p.entityId !== "string" || !p.entityId))
    throw Error("Choose a person, journal or topic");
  if (p.section === "note" && (typeof p.noteId !== "string" || !p.noteId))
    throw Error("Choose a note");
  if (p.section === "canvas" && (typeof p.canvasId !== "string" || !p.canvasId))
    throw Error("Choose a canvas");
  if (p.section === "file" && (typeof p.fileId !== "string" || !p.fileId))
    throw Error("Choose a file");
  if (p.section !== "sources" && !p.workspaceId)
    throw Error("Choose a workspace");
  // A library without a workspace is this window's library.
  if (p.section === "sources" && !p.workspaceId) p.workspaceId = w.workspaceId;
  // Records have one global owner even when opened through another project.
  const recordKey = contentKey(
    p.section,
    p.workspaceId,
    p.projectId,
    p.section === "record" ? p.record?.id || randomUUID() : p.section === "note" ? p.noteId : p.section === "canvas" ? p.canvasId : p.section === "file" ? p.fileId : p.section === "webpage" ? p.sourceId : ENTITY_SECTIONS.includes(p.section) ? p.entityId : null,
  );
  const existing = [...views.values()].find((v) => v.contentKey === recordKey);
  if (existing) {
    focus(existing.id);
    return;
  }
  if (p.section === "record" && p.record?.id) {
    p.record = await registry.invoke("workspace_record", { id: p.record.id }, p.workspaceId);
    if (!p.record) throw Error("This item no longer exists");
  }
  const workspace = (await registry.list()).find((k) => k.id === p.workspaceId);
  const scope = p.projectId
    ? (await registry.invoke<any[]>("workspace_projects", {}, p.workspaceId)).find((project) => project.id === p.projectId)?.name
    : workspace?.name;
  const owner = [...views.values()].find((v) => v.contentKey === recordKey);
  if (owner) {
    focus(owner.id);
    return;
  }
  add({
    id: randomUUID(),
    kind: "home",
    title:
      p.section === "record"
        ? p.record?.title || `Untitled ${p.record?.kind || "page"}`
        : p.section === "note"
          ? String(p.title || "Untitled note").slice(0, 200)
          : p.section === "canvas" || p.section === "file" || p.section === "webpage" || ENTITY_SECTIONS.includes(p.section)
            ? String(p.title || (p.section === "file" ? "File" : p.section === "canvas" ? "Untitled canvas" : p.section === "person" ? "Person" : p.section === "venue" ? "Journal" : p.section === "tag" ? "Tag" : "Topic")).slice(0, 200)
            : p.section === "highlights"
              ? "Highlights"
              : p.section === "inbox"
                ? "Inbox"
              : p.section === "databases"
                ? "Database search"
              : p.section === "search"
                ? "Search"
                : `${p.section === "records" ? "All items" : "Sources"}${scope ? ` · ${scope}` : ""}`,
    workspaceId: p.workspaceId,
    lastUsed: Date.now(),
    contentKey: recordKey,
    content: {
      section: p.section,
      workspaceId: p.workspaceId,
      projectId: p.projectId,
      record: p.record,
      noteId: p.section === "note" ? p.noteId : undefined,
      canvasId: p.section === "canvas" ? p.canvasId : undefined,
      fileId: p.section === "file" ? p.fileId : undefined,
      sourceId: p.section === "webpage" ? p.sourceId : undefined,
      entityId: ENTITY_SECTIONS.includes(p.section) ? p.entityId : undefined,
    },
  }, w);
}
/** A view for a saved descriptor, registered but not yet placed; undefined when it cannot
 * be opened any more or is already open elsewhere (one owner per document). */
async function restoredView(saved: SavedView): Promise<OwnedView | undefined> {
  try {
    if (saved.type === "home") return homeView();
    // An Office tab saved by an earlier version: Key has no editor for it any more.
    if (saved.type === "office") return undefined;
    if (saved.type === "web") {
      const url = webUrl(saved.url);
      if (!url) return undefined;
      const record = webView(url, saved.title);
      views.set(record.id, record);
      return record;
    }
    // A kept PDF reopens in the reader; one cleaned up since opens its page again, which
    // downloads it afresh.
    if (saved.type === "web-pdf") {
      const entry = await tempPdfs.get(String(saved.hash));
      const record = entry && existsSync(entry.file) ? await tempPdfView(entry).catch(() => undefined) : undefined;
      if (record && views.has(record.id)) return undefined;
      const url = webUrl(saved.url);
      const view = record ?? (url ? webView(url, saved.title) : undefined);
      if (view) views.set(view.id, view);
      return view;
    }
    if (saved.type === "pdf") {
      const id = `pdf:${saved.workspaceId}:${saved.hash}`;
      if (views.has(id)) return undefined;
      const info: any = await registry.invoke("library_source_info", { hash: saved.hash }, saved.workspaceId);
      const record: OwnedView = { id, kind: "pdf", title: saved.title || info.title, workspaceId: saved.workspaceId, source: info, lastUsed: Date.now() };
      views.set(id, record);
      return record;
    }
    const { section, workspaceId, projectId } = saved;
    let record: any;
    if (section === "record") {
      record = await registry.invoke("workspace_record", { id: saved.recordId }, workspaceId);
      if (!record) return undefined;
    }
    if (section === "note" && !(await registry.invoke("store_note", { id: saved.noteId }, workspaceId))) return undefined;
    if (section === "canvas" && !(await registry.invoke("store_canvas", { id: saved.canvasId }, workspaceId))) return undefined;
    if ((section === "source" || section === "webpage") && !(await registry.invoke("store_source", { id: saved.sourceId }, workspaceId))) return undefined;
    if (section === "file" && !(await registry.invoke("store_linked_file", { id: saved.fileId }, workspaceId))) return undefined;
    if (ENTITY_SECTIONS.includes(section) && !(await registry.invoke(ENTITY_COMMAND[section], { id: saved.entityId }, workspaceId))) return undefined;
    const key =
      section === "source"
        ? JSON.stringify(["source", workspaceId, null, saved.sourceId])
        : contentKey(section, workspaceId, projectId, section === "record" ? saved.recordId : section === "note" ? saved.noteId : section === "canvas" ? saved.canvasId : section === "file" ? saved.fileId : section === "webpage" ? saved.sourceId : ENTITY_SECTIONS.includes(section) ? saved.entityId : null);
    if ([...views.values()].some((v) => v.contentKey === key)) return undefined;
    const view: OwnedView = {
      id: randomUUID(),
      kind: "home",
      title: (record?.title ?? saved.title ?? "Untitled").slice(0, 200),
      workspaceId,
      lastUsed: Date.now(),
      contentKey: key,
      content: { section, workspaceId, projectId, record, noteId: saved.noteId, sourceId: saved.sourceId, canvasId: saved.canvasId, fileId: saved.fileId, entityId: saved.entityId },
    };
    views.set(view.id, view);
    return view;
  } catch {
    return undefined;
  }
}
/** A saved tab's view, with its reader's panel when it had one open. */
async function restoredTab(saved: SavedTab): Promise<WorkspaceTab | undefined> {
  const view = await restoredView(saved.view);
  if (!view) return undefined;
  if (saved.panel && (view.kind === "pdf" || view.content?.section === "webpage")) {
    const panel = await restoredView(saved.panel.view);
    if (panel) view.panel = { viewId: panel.id, ratio: Math.min(0.8, Math.max(0.2, saved.panel.ratio)) };
  }
  return { ...singleWorkspaceTab(view.id), ...(saved.pinned === true ? { pinned: true } : {}) };
}
/** Adds a saved arrangement's groups to `w` (after any it has), skipping what can no longer be opened. */
async function restoreTabs(w: ShellWindow, saved: SavedTabs) {
  const restored = await Promise.all(saved.groups.map((g) => Promise.all(g.tabs.map(restoredTab))));
  if (w.closed) return;
  const groups: TabGroup[] = [];
  let focused: string | undefined;
  restored.forEach((tabs, index) => {
    const kept = tabs.filter((t): t is WorkspaceTab => !!t);
    if (!kept.length) return;
    const group = newTabGroup(kept, saved.groups[index].size);
    group.activeTabId = (tabs[saved.groups[index].active] ?? kept[0]).id;
    groups.push(group);
    if (index === saved.active || !focused) focused = group.id;
  });
  if (!groups.length) return;
  const existing = w.state.groups.filter((g) => g.tabs.length);
  // Groups already here keep their share; the restored ones share what is left.
  const scale = existing.length ? 0.5 : 1;
  w.state = normalizeTabs({
    groups: [...existing.map((g) => ({ ...g, size: g.size * (1 - scale) })), ...groups.map((g) => ({ ...g, size: g.size * scale }))],
    activeGroupId: focused!,
  });
}
/** Moves a tab, with its live views, to another window (a new one by default). */
function moveTab(from: ShellWindow, tabId: string, to?: ShellWindow, at?: { x: number; y: number }) {
  const found = findTab(from.state, tabId);
  if (!found) return;
  if (!to && allTabs(from.state).length === 1 && liveShells().length === 1) return;
  from.state = closeWorkspaceTab(from.state, tabId);
  const tab = { ...found.tab };
  if (to) {
    to.state = addWorkspaceTab(to.state, tab);
    layout(to);
    to.window.focus();
  } else {
    const opened = createShell({ tabs: [tab], workspaceId: from.workspaceId });
    if (at) opened.window.setPosition(Math.round(at.x), Math.round(at.y));
  }
  if (!allTabs(from.state).length) from.window.close();
  else layout(from);
}
/** Saves the focused browser tab's page to the window's library, offline (see web-sources.ts). */
async function savePageToLibrary() {
  const w = focusedShell();
  const v = w && views.get(activeViewId(w) ?? "");
  if (v?.kind !== "web" || !v.view || !w.workspaceId) return;
  try {
    const saved = await webSources.save(v.view.webContents, w.workspaceId);
    emitTo(w, "browser-notice", { message: saved.existing ? "Saved again to your library" : "Saved to your library" });
  } catch (error) {
    emitTo(w, "browser-notice", { message: `Could not save the page: ${String(error).replace(/^Error: /, "")}` });
  }
}
/** Passages sent from a PDF selection to a source's note, until its page takes them. */
const pendingAppends = new Map<string, { text: string; page: number; color?: string }[]>();
async function openSourcePage(
  w: ShellWindow,
  p: { workspaceId: string; sourceId: string; title?: string; read?: boolean; pdf?: any },
) {
  const key = JSON.stringify(["source", p.workspaceId, null, p.sourceId]);
  let page = [...views.values()].find((v) => v.contentKey === key);
  if (!page) {
    page = {
      id: randomUUID(),
      kind: "home",
      title: String(p.title || "Untitled").slice(0, 200),
      workspaceId: p.workspaceId,
      lastUsed: Date.now(),
      contentKey: key,
      content: { section: "source", workspaceId: p.workspaceId, sourceId: p.sourceId },
    };
    views.set(page.id, page);
  }
  if (!p.read || !p.pdf?.documentHash) {
    if (shellOfView(page.id)) focus(page.id);
    else add(page, w);
    return;
  }
  await sourceOpen({ ...p.pdf, workspaceId: p.workspaceId }, undefined, undefined, w);
  const pdf = views.get(`pdf:${p.workspaceId}:${p.pdf.documentHash}`);
  // The page joins the reader's tab as its panel, leaving any tab it had.
  if (pdf && shellOfView(pdf.id)) dockPanel(pdf, page);
}
function windowLabel(w: ShellWindow) {
  const name = knownWorkspaces.find((k) => k.id === w.workspaceId)?.name ?? "Key";
  const titles = allTabs(w.state).map((t) => views.get(t.viewId)?.title ?? "Key");
  return `${name}: ${titles.slice(0, 3).join(", ")}${titles.length > 3 ? "…" : ""}`;
}
/** Runs a tab command on the focused window's focused group's active tab. */
function onActiveTab(run: (w: ShellWindow, tabId: string, viewId: string) => void) {
  return () => {
    const w = focusedShell();
    const tab = w && activeWorkspaceTab(w.state);
    if (tab) run(w, tab.id, activeViewId(w) ?? tab.viewId);
  };
}
/** Cmd-1…9: a tab of the focused group (negative: its last). */
function selectTab(index: number) {
  const w = focusedShell();
  const tabs = w ? activeGroup(w.state).tabs : [];
  const tab = index < 0 ? tabs.at(-1) : tabs[index];
  if (!w || !tab) return;
  w.state = activateWorkspaceTab(w.state, tab.id);
  layout(w);
}
/** Ctrl-Tab: the window's tabs in most-recently-used order (main/tab-switcher.ts). */
const tabSwitcher = new TabSwitcher<ShellWindow>({
  order: (w) => switcherOrder(w.mru ?? [], allTabs(w.state).map((t) => t.id)),
  activate: (w, tabId) => {
    if (!findTab(w.state, tabId)) return;
    w.state = activateWorkspaceTab(w.state, tabId);
    layout(w);
    focusShown(w);
  },
  close: (w, tabId) => closeTab(w, tabId),
  restoreFocus: (w) => focusShown(w),
  focusShell: (w) => w.window.webContents.focus(),
  send: (w, event) => emitTo(w, "tab-switcher", event),
  capture: (w) => (w.globalOverlay ? Promise.resolve([]) : captureOverlayFrames(w)),
  cover: (w, covered) => {
    if (covered ? w.globalOverlay : w.globalOverlay !== "tab-switcher") return;
    w.globalOverlay = covered ? "tab-switcher" : undefined;
    w.overlayCaptureKey = covered ? overlayKey(w) : "";
    if (!covered) ++w.overlayCaptureSequence;
    layout(w);
  },
});
/** Previous / next tab of the focused group. */
function stepTab(delta: number) {
  const w = focusedShell();
  const group = w && activeGroup(w.state);
  if (!group?.tabs.length) return;
  const at = group.tabs.findIndex((t) => t.id === group.activeTabId);
  selectTab((at + delta + group.tabs.length) % group.tabs.length);
}
function refreshMenu() {
  baseMenu();
}
function baseMenu() {
  // The workspaces window, in front or alone, has a menu of its own: nothing here acts on a
  // workspace window behind it.
  if (launcher && (launcher.isFocused() || !liveShells().length)) {
    Menu.setApplicationMenu(Menu.buildFromTemplate(launcher.menu({ editMenu: { role: "editMenu" }, openSettings: () => launcher?.request("settings") })));
    launcher.updateDock();
    return;
  }
  launcher?.updateDock();
  const recent = [
    ...windowState.recent.map((id) => knownWorkspaces.find((k) => k.id === id)).filter((k): k is WorkspaceInfo => !!k),
    ...knownWorkspaces.filter((k) => !windowState.recent.includes(k.id)),
  ];
  const current = focusedShell()?.workspaceId;
  const workspaceItems = (newWindow: boolean): MenuItemConstructorOptions[] =>
    recent.length
      ? recent.map((k) => ({
          label: k.name,
          type: newWindow ? ("normal" as const) : ("radio" as const),
          checked: !newWindow && k.id === current,
          click: () => {
            const w = focusedShell();
            if (w) void switchWorkspace(w, k.id, newWindow).catch((e) => emit("operation-error", String(e)));
          },
        }))
      : [{ label: "No workspaces", enabled: false }];
  const pane = (label: string, accelerator: string | undefined, run: (w: ShellWindow, tabId: string, viewId: string) => void): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: onActiveTab(run),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Key",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Key Settings…", accelerator: "CmdOrCtrl+,", click: () => emitTo(focusedShell(), "open-settings") },
          { label: "Workspace Settings…", accelerator: "CmdOrCtrl+Alt+,", click: () => emitTo(focusedShell(), "open-workspace-settings") },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "File",
        submenu: [
          { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => home() },
          { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => void createShell() },
          { type: "separator" },
          { label: "Switch Workspace…", accelerator: "CmdOrCtrl+Shift+O", click: () => emitTo(focusedShell(), "open-workspace-switcher") },
          { label: "Switch to Workspace", submenu: workspaceItems(false) },
          { label: "Open Workspace in New Window", submenu: workspaceItems(true) },
          { label: "Workspace Settings…", click: () => emitTo(focusedShell(), "open-workspace-settings") },
          ...(launcher
            ? [
                { label: "New Workspace…", click: () => launcher?.request("new") },
                { label: "Open Workspace", submenu: launcher.openWorkspaceMenu() },
                { label: "All Workspaces…", click: () => launcher?.show() },
              ]
            : []),
          { type: "separator" },
          {
            label: "Open…",
            accelerator: "CmdOrCtrl+O",
            click: () => void importSources(),
          },
          {
            label: "Save",
            accelerator: "CmdOrCtrl+S",
            click: () => {
              const w = focusedShell();
              const id = activeViewId(w);
              if (views.get(id ?? "")?.content?.section === "record") emitTo(w, "save-content", id);
            },
          },
          { label: "Save Page to Library", accelerator: "CmdOrCtrl+D", click: () => void savePageToLibrary() },
          { type: "separator" },
          {
            label: "Move Tab to New Window",
            click: () => {
              const w = focusedShell();
              const tab = activeWorkspaceTab(w.state);
              if (tab) moveTab(w, tab.id);
            },
          },
          { type: "separator" },
          pane("Close Tab", "CmdOrCtrl+W", (w, tabId) => void closeTab(w, tabId)),
          pane("Close Other Tabs", undefined, (w, tabId) => void closeTabs(w, tabsToClose(w.state, tabId, "others"))),
          {
            label: "Close Group",
            accelerator: "CmdOrCtrl+Alt+W",
            click: () => {
              const w = focusedShell();
              if (w) void closeTabs(w, activeGroup(w.state).tabs.map((t) => t.id));
            },
          },
          { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", click: () => focusedShell()?.window.close() },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          // Editor groups side by side, like VS Code's.
          pane("Split Right", "CmdOrCtrl+\\", (w, tabId) => splitRight(w, tabId)),
          {
            label: "Focus Group",
            submenu: (
              [
                ["Left", "left"],
                ["Right", "right"],
              ] as const
            ).map(([label, side]) => ({ label, accelerator: `CmdOrCtrl+Alt+${label}`, click: () => focusedShell() && focusGroupBeside(focusedShell(), side) })),
          },
          {
            label: "Move Tab to Group",
            submenu: (
              [
                ["Left", "left"],
                ["Right", "right"],
              ] as const
            ).map(([label, side]) => pane(label, `CmdOrCtrl+Alt+Shift+${label}`, (w) => moveToGroup(w, side))),
          },
          {
            label: "Equalize Group Widths",
            click: () => {
              const w = focusedShell();
              if (!w) return;
              w.state = equalizeGroups(w.state);
              layout(w);
            },
          },
          { type: "separator" },
          pane("Back", "CmdOrCtrl+[", (w, _tab, viewId) => stepHistory(w, viewId, -1)),
          pane("Forward", "CmdOrCtrl+]", (w, _tab, viewId) => stepHistory(w, viewId, 1)),
          { type: "separator" },
          { label: "Show Previous Tab", accelerator: "CmdOrCtrl+Shift+[", click: () => stepTab(-1) },
          { label: "Show Next Tab", accelerator: "CmdOrCtrl+Shift+]", click: () => stepTab(1) },
          // Ctrl-Tab itself is read from key events (main/tab-switcher.ts); the menu only shows it.
          { label: "Show All Tabs", accelerator: "Ctrl+Tab", registerAccelerator: false, click: () => focusedShell() && tabSwitcher.open(focusedShell()) },
          pane("Pin Tab", undefined, (w, tabId) => pinTab(w, tabId, !findTab(w.state, tabId)?.tab.pinned)),
          {
            label: "Go to Tab",
            submenu: [
              ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, click: () => selectTab(n - 1) })),
              { label: "Last Tab", accelerator: "CmdOrCtrl+9", click: () => selectTab(-1) },
            ],
          },
          { type: "separator" },
          {
            label: "Reload",
            accelerator: "CmdOrCtrl+R",
            click: () => {
              // A browser tab reloads its page; anywhere else, the window.
              const w = focusedShell();
              const active = w && views.get(activeViewId(w) ?? "");
              if (active?.kind === "web" && active.view) active.view.webContents.reload();
              else (BrowserWindow.getFocusedWindow() ?? w?.window)?.webContents.reload();
            },
          },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Go",
        submenu: [
          { label: "Open Quickly…", accelerator: "CmdOrCtrl+P", click: () => emitTo(focusedShell(), "command", "quick-open") },
          { label: "Commands…", accelerator: "CmdOrCtrl+K", click: () => emitTo(focusedShell(), "command", "palette") },
          { label: "Search Everything…", accelerator: "CmdOrCtrl+Shift+F", click: () => emitTo(focusedShell(), "command", "search") },
          { type: "separator" },
          { label: "Copy Link", accelerator: "CmdOrCtrl+L", click: () => emitTo(focusedShell(), "command", "copy-link") },
          { label: "Copy Reference", accelerator: "CmdOrCtrl+Shift+C", click: () => emitTo(focusedShell(), "command", "copy-citation") },
          { label: "Copy In-Text Citation", accelerator: "CmdOrCtrl+Shift+A", click: () => emitTo(focusedShell(), "command", "copy-in-text") },
          { label: "Send To…", accelerator: "CmdOrCtrl+Shift+S", click: () => emitTo(focusedShell(), "command", "send-to") },
          { type: "separator" },
          { label: "Show Inspector", accelerator: "CmdOrCtrl+Shift+I", click: () => emitTo(focusedShell(), "toggle-inspector") },
          { label: "All Highlights", accelerator: "CmdOrCtrl+Shift+H", click: () => emitTo(focusedShell(), "command", "highlights") },
          { label: "Reopen Closed Tab", accelerator: "CmdOrCtrl+Shift+T", click: () => void reopenClosed(focusedShell()) },
          { type: "separator" },
          { label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", click: () => emitTo(focusedShell(), "command", "shortcuts") },
        ],
      },
      launcher ? launcher.windowMenu() : { role: "windowMenu" },
    ]),
  );
}
startupMark("main-evaluated");
app.setName("Key");
registerMediaScheme();
listenForDeepLinks();
if (process.env.KEY_USER_DATA)
  app.setPath("userData", process.env.KEY_USER_DATA);
installErrorHandlers();
app.on("second-instance", () => {
  const w = focusedShell();
  if (!w && launcher) launcher.show();
  else if (w) {
    if (w.window.isMinimized()) w.window.restore();
    w.window.show();
    w.window.focus();
  }
});
// Hosts still running for the workspaces window's sake (a summary) end with the app.
app.on("will-quit", () => {
  if (!liveShells().length) registry?.close();
});
app.on("before-quit", () => {
  quitRequested = true;
  // Before any window starts closing its tabs.
  freezeWindows();
});
if (!app.requestSingleInstanceLock()) app.quit();
else
  app
    .whenReady()
    .then(async () => {
      startupMark("ready");
      const root = resolve(app.getAppPath(), "../../../..");
      workspaceParent =
        process.env.KEY_WORKSPACE_PARENT ?? join(app.getPath("documents"), "Key");
      // Library hosts read the chosen citation style from the settings file and keep
      // installed styles in one app-wide folder.
      process.env.KEY_APP_SETTINGS_FILE = join(app.getPath("userData"), "app-settings.json");
      process.env.KEY_CITATION_STYLES_DIR = join(app.getPath("userData"), "citation-styles");
      // The shipped CSL styles and locales (CC BY-SA data files, read by the host on demand).
      process.env.KEY_CITATION_DATA_DIR ??= app.isPackaged ? join(process.resourcesPath, "citation") : join(root, "data/citation");
      registry = new Registry({
        registryDir: join(app.getPath("userData"), "workspaces"),
        defaultWorkspaceParent: workspaceParent,
        hostExecutable:
          process.env.KEY_HOST_EXECUTABLE ??
          (app.isPackaged
            ? join(process.resourcesPath, "backend/key-desktop-host")
            : join(root, "apps/key/src-tauri/target/debug/key-desktop-host")),
        pdfiumPath:
          process.env.PDFIUM_DYNAMIC_LIB_PATH ??
          (app.isPackaged
            ? join(process.resourcesPath, "backend/libpdfium.dylib")
            : join(root, "vendor/pdfium/lib/libpdfium.dylib")),
        prelude: () => [...hostKeyRequests(), feedsEnvironmentRequest()],
        // Background lookups filled sources in: open views refresh (the host throttles it).
        onHostEvent: (workspaceId, name) => {
          if (name === "library-changed") {
            emit("library-sources-changed", { workspaceId });
            void refreshReaderTitles(workspaceId);
          }
        },
      });
      watchFeedsEnvironment((command, args) => void registry.broadcast(command, args).catch(() => undefined));
      serveNoteMedia(registry);
      tempPdfs = new TempPdfs(browserCache(), { workspace: scratchWorkspace, invoke: (c, a, id) => registry.invoke(c, a, id) });
      void tempPdfs.list().catch(() => undefined);
      browserService = new BrowserService((id) => tempPdfs.incomingPath(id), {
        pdf: (contents, file) => void openDownloadedPdf(contents, file),
        file: (_contents, path, ok) => emit("browser-notice", { message: ok ? `Downloaded “${basename(path)}” to Downloads` : `The download of “${basename(path)}” did not finish`, path: ok ? path : undefined }),
      });
      proxyService = await new ProxyService(join(app.getPath("userData"), "library-proxies.json")).load();
      proxyService.onChange(() => emit("proxies-changed"));
      // Passkey sign-ins in browser tabs (browser/sign-in.ts).
      signInService = new SignInService(() => ({ notice: appSettings.get().signInNotice, browser: appSettings.get().signInBrowser }));
      signInService.install(join(__dirname, "../preload"));
      // Smokes drive the headless API directly.
      if (process.env.KEY_BROWSER_SMOKE)
        Object.assign(globalThis, {
          keyBrowser: { service: browserService, temp: tempPdfs, clean: cleanTempPdfs, network: (name: string | null) => (simulateNetwork(name), proxyService?.refreshNetwork()) },
        });
      // Pages of the app itself (the shell, readers, editors) never become browsers: a link
      // they open, or follow away from the app, opens as a browser tab.
      app.on("web-contents-created", (_event, contents) => {
        if (creatingPage() || contents.session === browserSession()) return;
        contents.setWindowOpenHandler(({ url }) => {
          openLink(url);
          return { action: "deny" };
        });
        contents.on("will-navigate", (event) => {
          if (!webUrl(event.url)) return;
          try {
            if (new URL(contents.getURL()).origin === new URL(event.url).origin) return;
          } catch {
            /* no page yet */
          }
          event.preventDefault();
          openLink(event.url);
        });
      });
      const cleanupEvery = Math.max(1000, Math.min(60 * 60_000, (Number(process.env.KEY_BROWSER_TEMP_TTL_MS) || DEFAULT_TTL) / 2));
      setTimeout(() => void cleanTempPdfs().catch(() => undefined), Math.min(15_000, cleanupEvery));
      setInterval(() => void cleanTempPdfs().catch(() => undefined), cleanupEvery).unref();
      const linkedFolders = new LinkedFolders((c, a, w) => registry.invoke(c, a, w), () => liveShells().map((w) => w.workspaceId), (v) => emit("linked-folders-changed", v));
      webSources = new WebSources(
        (c, a, w) => registry.invoke(c, a, w),
        (id) => {
          const v = views.get(id);
          return v?.kind === "web" && v.view && !v.view.webContents.isDestroyed() ? v.view.webContents : undefined;
        },
        () => emit("library-changed"),
        (url, work) => browserService.withLoadedPage(url, work),
      );
      const webSearch = (webSearchService = new WebSearch({
        invoke: (c, a, w, o) => registry.invoke(c, a, w, o),
        emit,
        anyWorkspace: () => focusedShell()?.workspaceId,
      }));
      routeEmbeddedMedia();
      ai = new AiService({
        settingsPath: join(app.getPath("userData"), "ai-settings.json"),
        secrets: secretStore,
        invoke: (command, args, workspaceId) => registry.invoke(command, args as Record<string, unknown>, workspaceId),
        emit: (event, value) => {
          emit(event, value);
          if (event === "fill-progress" && (value as { run?: { status?: string } })?.run?.status === "done") emit("library-changed");
        },
        openExternal: (url) => void systemShell.openExternal(url),
        notify: (message) => notify("error", message),
      });
      appSettings = new AppSettingsStore(join(app.getPath("userData"), "app-settings.json"));
      await appSettings.load();
      startupMark("settings-loaded");
      keyedServices = await startKeyedServices({ registry: () => registry, appSettings });
      onWebProvidersChanged(() => emit("web-providers-changed"));
      startupMark("keys-loaded");
      windowStore = new WindowStateStore(join(app.getPath("userData"), "window-state.json"));
      windowState = await windowStore.load();
      launcher = new Launcher(join(app.getPath("userData"), "launcher.json"), {
        registry: () => registry,
        settings: () => appSettings,
        preload,
        renderer,
        workspaceParent: () => workspaceParent,
        openWorkspaces: () => liveShells().map((w) => w.workspaceId),
        recent: () => windowState.recent,
        openWorkspace: openFromLauncher,
        workspacesChanged: refreshWorkspaces,
        zoteroWorkspace,
        info: () => appInfo(workspaceParent),
        menuChanged: () => refreshMenu(),
      });
      launcher.serve();
      await refreshWorkspaces();
      // Windows reopen where they were, on workspaces that still exist. With the workspaces
      // window on, that is one of three choices (Settings › When Key opens).
      const launchWith = launcherMode ? appSettings.get().openAtLaunch : "restore";
      const lastWorkspace = windowState.recent.find((id) => knownWorkspaces.some((k) => k.id === id));
      const restoring =
        process.env.KEY_NO_WINDOW_RESTORE || launchWith === "workspaces"
          ? []
          : launchWith === "last"
            ? lastWorkspace
              ? [lastWindow(lastWorkspace)]
              : []
            : windowState.windows.filter((saved) => knownWorkspaces.some((k) => k.id === saved.workspaceId));
      startupMark("state-loaded");
      const first = launcherMode && !restoring.length ? undefined : createShell({ load: false, workspaceId: knownWorkspaces[0]?.id, saved: restoring[0] });
      if (!first) launcher.show();
      startupMark("window-created");
      // key:// links from other apps, once the shell has had a moment to listen.
      if (first) first.window.webContents.once("did-finish-load", () => setTimeout(() => deliverDeepLinks(sendItemLink), 1200));
      else deliverDeepLinks(sendItemLink);
      const bound = (sender: number) =>
        [...views.values()].find((v) => v.view?.webContents.id === sender);
      serveNotices(() => liveShells().map((s) => s.window.webContents));
      serveStatusItems({
        viewOf: (sender) => bound(sender.id)?.id,
        contentsOf: (viewId) => views.get(viewId)?.view?.webContents,
        shells: () => liveShells().map((s) => s.window.webContents),
      });
      const shell = (sender: number) => {
        const w = shellBySender(sender);
        if (!w) throw Error("Only the workspace shell can perform this operation");
        return w;
      };
      ipcMain.handle(
        "key:invoke",
        async (event, command, args, workspaceId, options) => {
          const record = bound(event.sender.id);
          const from = record ? shellOfView(record.id) : shellBySender(event.sender.id);
          if (!record && !from) throw Error("Unknown view");
          const targetWorkspace = record?.workspaceId ?? workspaceId;
          // The browser's scratch library is the readers' own; the shell never reaches it.
          if (!record && registry.isHidden(workspaceId)) throw Error("Workspace is not registered");
          if (command === "workspace_set_appearance") {
            shell(event.sender.id);
            const updated = await registry.setAppearance(workspaceId, args.icon, args.color);
            launcher?.changed();
            return updated;
          }
          // The display name; the registry keeps it for titles, menus and the workspaces window.
          if (command === "workspace_rename") {
            shell(event.sender.id);
            const renamed = await registry.rename(workspaceId, String(args?.name ?? ""));
            await refreshWorkspaces();
            launcher?.changed();
            return renamed;
          }
          if (ai.handles(command)) return ai.handle(command, args, targetWorkspace);
          if (command === "library_download_pdf") {
            if (record) throw Error("Download requires the library view");
            const info = await downloadPdf(registry, targetWorkspace, args.url, args.sourceId).catch((error) => libraryDownloadWithBrowser(targetWorkspace, args.url, args.sourceId, error));
            emit("library-changed");
            return info;
          }
          if (command === "library_relink") {
            if (record) throw Error("Relink requires the library view");
            const selected = await dialog.showOpenDialog((from ?? focusedShell()).window, {
              title: "Relink original PDF — content must match",
              properties: ["openFile"],
              filters: [{ name: "PDF", extensions: ["pdf"] }],
            });
            if (selected.canceled) return { canceled: true };
            const result = await registry.invoke(
              "library_import_file",
              { path: selected.filePaths[0], expectedHash: args.hash },
              targetWorkspace,
            );
            emit("library-changed");
            return result;
          }
          if (linkedFolders.handles(command)) return linkedFolders.handle(command, args, targetWorkspace, (from ?? focusedShell()).window);
          if (webSearch.handles(command)) return webSearch.handle(command, args, targetWorkspace);
          if (keyedServices?.handles(command)) return keyedServices.handle(command, args);
          if (webSources.handles(command)) {
            if (record) throw Error("Saved pages are read by the shell");
            return webSources.handle(command, args, targetWorkspace);
          }
          const operation = registry.invoke(
            command,
            args,
            record?.workspaceId ?? workspaceId,
            options,
          );
          if (record?.kind === "pdf") {
            const id = event.sender.id;
            const calls = readerCalls.get(id) ?? new Set<Promise<unknown>>();
            calls.add(operation);
            readerCalls.set(id, calls);
            void operation
              .finally(() => calls.delete(operation))
              .catch(() => {});
          }
          const result = await operation;
          if (
            [
              "workspace_save_attribute",
              "workspace_delete_attribute",
              "workspace_rename_attribute",
            ].includes(command)
          )
            emit("property-definitions-changed", {
              workspaceId: targetWorkspace,
              name: args?.name,
              newName:
                command === "workspace_rename_attribute"
                  ? args?.newName
                  : undefined,
            });
          if (
            [
              "workspace_save_record",
              "workspace_save_entry",
              "workspace_set_project_membership",
              "store_tag_apply",
              "store_tag_apply_many",
              "store_tag_restore",
              // Journaled too: ⌘Z can bring these back.
              "store_collection_create",
              "store_collection_update",
              "store_collection_reorder",
              "store_collection_delete",
              "store_note_delete",
              // The operations journal, merges and metadata updates (see the host's hygiene.rs).
              "store_undo",
              "store_redo",
              "store_edit",
              "store_merge_sources",
              "store_merge_exact",
              "store_apply_metadata",
            ].includes(command)
          )
            emit("library-changed");
          // Tags turned into a property define (or undefine) it.
          if ((command === "store_tag_apply" && args?.operation?.property) || (command === "store_tag_restore" && args?.snapshot?.definition))
            emit("property-definitions-changed", { workspaceId: targetWorkspace, name: args?.operation?.property?.name ?? args?.snapshot?.definition?.[0] });
          // Several operations at once, or an undo that may take a definition back.
          if ((command === "store_tag_apply_many" && args?.operations?.some?.((o: any) => o?.property)) || command === "store_undo" || command === "store_redo")
            emit("property-definitions-changed", { workspaceId: targetWorkspace });
          // Every view showing a note or a PDF's highlights stays in step with edits made elsewhere.
          if (command === "store_note_save" || command === "store_note_meta" || command === "store_note_delete")
            emit("note-changed", { workspaceId: targetWorkspace, noteId: (result as any)?.id ?? args?.id, sourceId: (result as any)?.sourceId ?? args?.sourceId });
          // Backlinks are rewritten by these saves, and titles they show change with renames.
          if (["store_note_save", "store_note_delete", "store_canvas_save", "store_canvas_delete", "store_update", "store_delete", "store_undo", "store_redo", "store_merge_sources", "store_merge_exact", "library_apply_annotations", "library_save_annotations"].includes(command))
            emit("links-changed", { workspaceId: targetWorkspace, command });
          if (["library_apply_annotations", "library_save_annotations", "library_import_annotations"].includes(command))
            emit("annotations-changed", { workspaceId: targetWorkspace });
          return result;
        },
      );
      ipcMain.handle("key:app-settings", async (event) => {
        shell(event.sender.id);
        const settings = publicSettings(appSettings.get());
        // Automated checks run on fresh profiles; onboarding would cover what they test.
        if (process.env.KEY_SKIP_ONBOARDING) settings.onboarded = true;
        return { settings, info: await appInfo(workspaceParent) };
      });
      ipcMain.handle("key:set-app-settings", async (event, patch) => {
        shell(event.sender.id);
        const before = appSettings.get();
        // Keys never stay in the settings file: an older Settings page's key goes to the secret store.
        if (patch && typeof patch.openalexApiKey === "string") {
          if (patch.openalexApiKey.trim()) await keyedServices?.handle("services_set_key", { id: "openalex", key: patch.openalexApiKey });
          delete patch.openalexApiKey;
        }
        if (patch?.webProviders) for (const entry of Object.values(patch.webProviders as Record<string, { apiKey?: string }>)) delete entry.apiKey;
        const next = await appSettings.update(patch ?? {});
        // Every view shows the same tips (explain.tsx keeps a copy).
        if (JSON.stringify(before.tips) !== JSON.stringify(next.tips)) emit("tips-changed", next.tips);
        if (!before.zoteroSync && next.zoteroSync) void syncZotero(true);
        // Running library hosts pick up the layout setting at once.
        if (before.layoutModel !== next.layoutModel)
          for (const workspace of await registry.list())
            void registry.invoke("store_analysis_options", { layoutModel: next.layoutModel }, workspace.id).catch(() => {});
        if (before.modelsOwnSourcesOnly !== next.modelsOwnSourcesOnly)
          for (const workspace of await registry.list())
            void registry.invoke("store_models_options", { ownSourcesOnly: next.modelsOwnSourcesOnly }, workspace.id).catch(() => {});
        if (before.modelsAutoDownload !== next.modelsAutoDownload)
          for (const workspace of await registry.list())
            void registry.invoke("store_models_options", { autoDownload: next.modelsAutoDownload }, workspace.id).catch(() => {});
        if (before.openalexMailto !== next.openalexMailto || JSON.stringify(before.webProviders) !== JSON.stringify(next.webProviders) || JSON.stringify(before.webEngines) !== JSON.stringify(next.webEngines)) void pushHostKeys();
        if (before.openalex !== next.openalex || before.openalexMailto !== next.openalexMailto)
          for (const workspace of await registry.list())
            void registry
              .invoke("store_enrich_options", { auto: next.openalex, mailto: next.openalexMailto, apiKey: keyedServices?.key("openalex") ?? "", keyMode: keyedServices?.mode("openalex") }, workspace.id)
              .catch(() => {});
        return publicSettings(next);
      });
      ipcMain.handle("key:workspaces", async (event) => {
        shell(event.sender.id);
        // Kept current for window titles and the File menu (onboarding and imports add workspaces).
        const list = await registry.list();
        if (JSON.stringify(list) !== JSON.stringify(knownWorkspaces)) void refreshWorkspaces();
        return list;
      });
      ipcMain.handle("key:add-workspace", async (event) => {
        const w = shell(event.sender.id);
        const result = await dialog.showOpenDialog(w.window, {
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled) return null;
        const added = await registry.add(result.filePaths[0], basename(result.filePaths[0]));
        await refreshWorkspaces();
        return added;
      });
      // Workspace Settings › Remove from Key: the folder and its files stay where they are.
      // The asking window moves to another workspace first; another window showing it stops it.
      ipcMain.handle("key:remove-workspace", async (event, workspaceId: string) => {
        const w = shell(event.sender.id);
        const list = await registry.list();
        if (!list.some((k) => k.id === workspaceId)) throw Error("This workspace is no longer available");
        if (liveShells().some((s) => s !== w && s.workspaceId === workspaceId)) throw Error("Close the other window showing this workspace first");
        const other = list.find((k) => k.id !== workspaceId);
        if (!other) throw Error("Key needs at least one workspace");
        if (w.workspaceId === workspaceId) {
          await switchWorkspace(w, other.id);
          if (w.workspaceId === workspaceId) throw Error("Close the open tabs first");
        }
        await registry.forget(workspaceId);
        launcher?.changed();
        windowState.recent = windowState.recent.filter((id) => id !== workspaceId);
        delete windowState.layouts[workspaceId];
        await refreshWorkspaces();
        return { workspaceId: w.workspaceId };
      });
      // Workspace Settings › Location › Move…: the folder moves on the same disk; the window's
      // tabs on it close first (asking about unsaved work) and come back afterwards.
      ipcMain.handle("key:move-workspace", async (event, workspaceId: string) => {
        const w = shell(event.sender.id);
        const workspace = (await registry.known()).find((k) => k.id === workspaceId);
        if (!workspace) throw Error("This workspace is no longer available");
        if (liveShells().some((s) => s !== w && s.workspaceId === workspaceId)) throw Error("Close the other window showing this workspace first");
        const picked = await dialog.showOpenDialog(w.window, { title: `Move “${workspace.name}” to…`, buttonLabel: "Move Here", defaultPath: dirname(workspace.root), properties: ["openDirectory", "createDirectory"] });
        if (picked.canceled || !picked.filePaths[0]) return null;
        const target = join(picked.filePaths[0], basename(workspace.root));
        if (target === workspace.root) return null;
        if (await access(target).then(() => true, () => false)) throw Error(`That folder already has a “${basename(workspace.root)}”`);
        const showing = w.workspaceId === workspaceId;
        const arrangement = savedTabs(w);
        if (showing) {
          if (!(await closeViews(w, windowViewIds(w)))) {
            layout(w);
            return null;
          }
          w.state = emptyTabsState();
        }
        try {
          return await registry.relocate(workspaceId, target, moveFolder);
        } finally {
          await refreshWorkspaces();
          if (showing) {
            await restoreTabs(w, arrangement);
            if (!allTabs(w.state).length) await openContent(w, { section: "sources", workspaceId });
            layout(w);
          }
        }
      });
      ipcMain.handle("key:tabs", (event) => snapshot(shell(event.sender.id)));
      ipcMain.handle("key:reader-back", (event) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf") throw Error("Not a PDF reader");
        if (v.returnViewId && views.has(v.returnViewId)) {
          focus(v.returnViewId);
          return;
        }
        const w = shellOfView(v.id) ?? focusedShell();
        const tab = allTabs(w.state).find((t) => views.get(t.viewId)?.content?.section === "sources");
        if (tab) {
          w.state = activateWorkspaceTab(w.state, tab.id);
          layout(w);
        } else home(w);
      });
      // A file to read or write (bibliography import, export and auto-export targets).
      ipcMain.handle("key:choose-path", async (event, request: { mode: "open" | "save" | "folder"; title?: string; defaultPath?: string; extensions?: string[]; filterName?: string; allowFolders?: boolean }) => {
        const w = shell(event.sender.id);
        if (request.mode === "folder") {
          const result = await dialog.showOpenDialog(w.window, { title: request.title, defaultPath: request.defaultPath, buttonLabel: "Choose", properties: ["openDirectory", "createDirectory"] });
          return result.canceled ? null : result.filePaths[0] ?? null;
        }
        const filters = request.extensions?.length ? [{ name: request.filterName ?? "Bibliography", extensions: request.extensions }, { name: "All files", extensions: ["*"] }] : undefined;
        if (request.mode === "save") {
          const result = await dialog.showSaveDialog(w.window, { title: request.title, defaultPath: request.defaultPath, filters, properties: ["createDirectory", "showOverwriteConfirmation"] });
          return result.canceled ? null : result.filePath ?? null;
        }
        const result = await dialog.showOpenDialog(w.window, { title: request.title, defaultPath: request.defaultPath, filters, properties: request.allowFolders ? ["openFile", "openDirectory"] : ["openFile"] });
        return result.canceled ? null : result.filePaths[0] ?? null;
      });
      ipcMain.handle("key:add-files", async (event, workspaceId, collectionId) => {
        const w = shell(event.sender.id);
        const result = await dialog.showOpenDialog(w.window, {
          title: "Add sources",
          properties: ["openFile", "multiSelections"],
          filters: [
            {
              name: "Sources",
              extensions: ["pdf", "html", "htm", "txt", "md", "mp4", "mov", "m4v", "webm", "mp3", "m4a", "wav", "aac", "flac", "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"],
            },
            { name: "All files", extensions: ["*"] },
          ],
        });
        if (result.canceled) return [];
        const created = await registry.invoke(
          "store_import_files",
          { paths: result.filePaths, collectionId: collectionId ?? null },
          workspaceId,
        );
        emit("library-changed");
        return created;
      });
      ipcMain.handle("key:import-paths", async (event, workspaceId, paths, collectionId) => {
        shell(event.sender.id);
        const created = await registry.invoke(
          "store_import_files",
          { paths, collectionId: collectionId ?? null },
          workspaceId,
        );
        emit("library-changed");
        return created;
      });
      ipcMain.handle("key:open-path", async (event, path) => {
        shell(event.sender.id);
        const error = await systemShell.openPath(String(path));
        if (error) throw Error(error);
      });
      // Quick Look thumbnails for the library's grid; small, so they come back as data URLs.
      ipcMain.handle("key:thumbnail", async (event, path, size) => {
        shell(event.sender.id);
        const edge = Math.max(32, Math.min(800, Number(size) || 320));
        const image = await nativeImage.createThumbnailFromPath(String(path), { width: edge, height: edge });
        return image.isEmpty() ? null : image.toDataURL();
      });
      // Citations go on the clipboard as plain text, HTML and RTF (word processors take RTF).
      ipcMain.handle("key:write-clipboard", (event, data: { text?: unknown; html?: unknown; rtf?: unknown }) => {
        shell(event.sender.id);
        const text = typeof data?.text === "string" ? data.text : "";
        const html = typeof data?.html === "string" ? data.html : undefined;
        const rtf = typeof data?.rtf === "string" ? data.rtf : undefined;
        // Smokes run side by side: with KEY_TEST_CLIPBOARD each app keeps its copies to itself.
        if (process.env.KEY_TEST_CLIPBOARD === "1") return void ((globalThis as { __keyClipboard?: unknown }).__keyClipboard = { text, html: html ?? "", rtf: rtf ?? "" });
        clipboard.write({ text, ...(html ? { html } : {}), ...(rtf ? { rtf } : {}) });
      });
      ipcMain.handle("key:reveal-path", (event, path) => {
        shell(event.sender.id);
        systemShell.showItemInFolder(String(path));
      });
      ipcMain.handle("key:import-zotero", async (event, options) => {
        shell(event.sender.id);
        return importZotero(options);
      });
      // Library proxies for the in-app browser (Settings › Library access).
      ipcMain.handle("key:proxies", async (event, action, payload) => {
        shell(event.sender.id);
        if (!proxyService) throw Error("The browser is still starting");
        if (action === "get") return proxyService.snapshot();
        if (action === "prefs") return proxyService.setPrefs(payload ?? {});
        if (action === "save") return proxyService.saveProxy(payload ?? {});
        if (action === "remove") return proxyService.removeProxy(String(payload));
        if (action === "network") return proxyService.networkOp(payload ?? {});
        if (action === "import") return importLibraryProxies(payload ?? {});
        throw Error("Unknown proxy action");
      });
      ipcMain.handle("key:zotero-workspace", (event, workspaceId?: unknown) => {
        shell(event.sender.id);
        return zoteroWorkspace(workspaceId);
      });
      ipcMain.handle("key:sync-zotero", async (event) => {
        shell(event.sender.id);
        await syncZotero(true);
      });
      setInterval(() => void syncZotero(), 30_000);
      startZoteroPluginSync({
        invoke: (command, args, workspaceId) => registry.invoke(command, args as Record<string, unknown>, workspaceId),
        workspaces: zoteroLinkedWorkspaces,
        changed: () => emit("library-changed"),
        syncing: (running) => emit("zotero-syncing", running),
        check: (sender) => void shell(sender),
      });
      registerAddFromSource({
        shellFor: (sender) => {
          const record = bound(sender);
          return (record ? shellOfView(record.id) : shellBySender(sender))?.window.webContents;
        },
        check: (sender) => void shell(sender),
      });
      ipcMain.handle("key:open-sources", (event, id) => {
        return importSources(id, shell(event.sender.id));
      });
      ipcMain.handle("key:open-source", (event, source, hit, results) => {
        return sourceOpen(source, hit, results, shell(event.sender.id));
      });
      // The search session a reader is showing a result of, if any.
      const sessionOf = (viewId: string) =>
        [...searchPreviews.values()].find((s) => s.previewViewId === viewId && !s.dismissed);
      ipcMain.handle("key:reader-result", async (event, direction) => {
        const v = bound(event.sender.id);
        const session = v && v.sharedSearchNavigation ? sessionOf(v.id) : undefined;
        if (session && [-1, 1].includes(direction)) {
          if (!session.busy) await showSearchPreview(session, session.index + direction);
          return;
        }
        if (
          v?.kind !== "pdf" ||
          !v.searchResults ||
          ![-1, 1].includes(direction)
        )
          throw Error("Invalid search navigation");
        const index = (v.searchIndex ?? -1) + direction;
        const hit = v.searchResults[index];
        if (!hit) return;
        return sourceOpen(hit, hit, v.searchResults, shellOfView(v.id));
      });
      // The reader's "Details & notes" button: show or hide the source's page as the panel
      // beside the PDF, in the same tab. A page open as a tab of its own comes back into it.
      // With a tab ("details", "references") it shows that one, and hides the panel when it
      // shows that already. Resolves to what the panel shows then, or false.
      ipcMain.handle("key:reader-notes", async (event, wanted?: unknown) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf" || !v.workspaceId) throw Error("Not a PDF reader");
        if (v.temp) throw Error("Add this PDF to your library first");
        const w = shellOfView(v.id) ?? focusedShell();
        const tab = panelTab(wanted);
        if (v.panel && tab && (v.panel.tab ?? "details") !== tab) {
          v.panel.tab = tab;
          v.view?.webContents.send("reader-notes", tab);
          tabsChanged(w);
          return tab;
        }
        if (v.panel) {
          closePanel(v);
          layout(w);
          return false;
        }
        const hash = v.source?.hash ?? v.id.split(":").at(-1);
        const page = await registry.invoke<{ items: any[] }>("store_sources", { ids: [hash], limit: 1, scope: "all" }, v.workspaceId);
        const source = page.items[0];
        if (!source) throw Error("This PDF is not in the library");
        await openSourcePage(w, {
          workspaceId: v.workspaceId,
          sourceId: source.id,
          title: source.title,
          read: true,
          pdf: { documentHash: hash, documentId: hash, title: v.title, workspaceId: v.workspaceId },
        });
        // Docking the page (just now) set it on the details.
        const docked = (v as OwnedView).panel;
        if (docked && tab && tab !== "details") {
          docked.tab = tab;
          v.view?.webContents.send("reader-notes", tab);
          tabsChanged(w);
        }
        return docked?.tab ?? false;
      });
      // "Add to note" on a PDF selection: the passage waits here until the source's page
      // (opened beside the PDF when needed) takes it, appends it and scrolls to it.
      ipcMain.handle("key:reader-add-to-note", async (event, passage: { text: string; page: number; color?: string }) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf" || !v.workspaceId) throw Error("Not a PDF reader");
        if (v.temp) throw Error("Add this PDF to your library first");
        if (!String(passage?.text ?? "").trim()) return;
        const hash = v.source?.hash ?? v.id.split(":").at(-1);
        const found = await registry.invoke<{ items: any[] }>("store_sources", { ids: [hash], limit: 1, scope: "all" }, v.workspaceId);
        const source = found.items[0];
        if (!source) throw Error("This PDF is not in the library");
        const queued = pendingAppends.get(source.id) ?? [];
        queued.push({ text: String(passage.text), page: Number(passage.page) || 0, color: passage.color });
        pendingAppends.set(source.id, queued);
        const w = shellOfView(v.id) ?? focusedShell();
        // A page shown in another group already sits beside the reader: it is brought
        // forward there. Otherwise it docks as the reader's panel.
        const key = JSON.stringify(["source", v.workspaceId, null, source.id]);
        const pageView = [...views.values()].find((x) => x.contentKey === key);
        const pageTab = pageView && findViewTab(w.state, pageView.id);
        const readerTab = findViewTab(w.state, v.id);
        if (pageTab && readerTab && pageTab.group.id !== readerTab.group.id) {
          w.state = { ...activateWorkspaceTab(w.state, pageTab.tab.id), activeGroupId: w.state.activeGroupId };
          layout(w);
        } else
          await openSourcePage(w, {
            workspaceId: v.workspaceId,
            sourceId: source.id,
            title: source.title,
            read: true,
            pdf: { documentHash: hash, documentId: hash, title: v.title, workspaceId: v.workspaceId },
          });
        emit("note-append", { sourceId: source.id });
      });
      ipcMain.handle("key:capture-save", async (event, text: unknown) => {
        if (!captureWindow || event.sender !== captureWindow.webContents) throw Error("Not the capture window");
        await saveCapture(String(text ?? ""));
        captureWindow.close();
      });
      globalShortcut.register("Control+Alt+Space", quickCapture);
      app.on("will-quit", () => globalShortcut.unregisterAll());
      // ⌥-dragging a source out of the library: the files themselves, as Finder drags them.
      ipcMain.on("key:start-file-drag", (event, paths: unknown) => {
        const files = (Array.isArray(paths) ? paths : []).map(String).filter((path) => existsSync(path));
        if (!files.length) return;
        void app
          .getFileIcon(files[0], { size: "normal" })
          .then((icon) => event.sender.startDrag({ file: files[0], files, icon }))
          .catch(() => {});
      });
      // "Send to…" on a PDF highlight: the window it is in asks where to put it.
      ipcMain.handle("key:reader-send-to", async (event, highlight: { annotationId: string; text: string; page: number; color?: string }) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf" || !v.workspaceId) throw Error("Not a PDF reader");
        if (v.temp) throw Error("Add this PDF to your library first");
        const hash = v.source?.hash ?? v.id.split(":").at(-1);
        const found = await registry.invoke<{ items: any[] }>("store_sources", { ids: [hash], limit: 1, scope: "all" }, v.workspaceId);
        const source = found.items[0];
        if (!source) throw Error("This PDF is not in the library");
        const w = shellOfView(v.id) ?? focusedShell();
        w.window.webContents.focus();
        emitTo(w, "send-items", [
          { kind: "source", id: source.id, anchor: `highlight:${String(highlight.annotationId)}`, title: String(highlight.text ?? "").trim() || "Highlight", detail: source.title, color: highlight.color },
        ]);
      });
      // The References panel: how this PDF was analysed, its references and what they
      // link to; Re-run analyses it again; a linked reference opens beside the reader.
      const readerSource = async (sender: number) => {
        const v = bound(sender);
        if (v?.kind !== "pdf" || !v.workspaceId) throw Error("Not a PDF reader");
        const hash = v.source?.hash ?? v.id.split(":").at(-1);
        const found = await registry.invoke<{ items: any[] }>("store_sources", { ids: [hash], limit: 1, scope: "all" }, v.workspaceId);
        return { v, source: found.items[0] as { id: string; title?: string } | undefined };
      };
      ipcMain.handle("key:reader-analysis", async (event) => {
        const { v, source } = await readerSource(event.sender.id);
        if (!source) return null;
        // A PDF from the web takes the title identification finds for it.
        if (v.temp && source.title && source.title !== v.title && !/\.pdf$/i.test(source.title) && !/^[0-9a-f]{64}$/.test(source.title)) {
          v.title = source.title.slice(0, 200);
          void tempPdfs.setTitle(v.temp.hash, v.title);
          const w = shellOfView(v.id);
          if (w) tabsChanged(w);
        }
        return registry.invoke("store_analysis", { id: source.id }, v.workspaceId);
      });
      ipcMain.handle("key:reader-reanalyze", async (event) => {
        const { v, source } = await readerSource(event.sender.id);
        if (!source) throw Error("This PDF is not in the library");
        await registry.invoke("store_reanalyze", { id: source.id }, v.workspaceId);
      });
      ipcMain.handle("key:reader-open-source", async (event, sourceId: string) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf" || !v.workspaceId) throw Error("Not a PDF reader");
        if (v.temp) throw Error("Add this PDF to your library first");
        await openSourcePage(shellOfView(v.id) ?? focusedShell(), { workspaceId: v.workspaceId, sourceId: String(sourceId) });
      });
      // A highlight's "Used in" row: the note (at the quote) or canvas that uses it.
      ipcMain.handle("key:reader-open-item", async (event, item: { kind?: string; id?: string; title?: string; reveal?: string }) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf" || !v.workspaceId) throw Error("Not a PDF reader");
        const w = shellOfView(v.id) ?? focusedShell();
        if (!w || typeof item?.id !== "string" || !["note", "canvas"].includes(String(item.kind))) throw Error("Choose a note or canvas");
        const p = item.kind === "note" ? { section: "note", noteId: item.id } : { section: "canvas", canvasId: item.id };
        await openContent(w, { ...p, workspaceId: v.workspaceId, title: item.title });
        if (item.kind === "note" && typeof item.reveal === "string" && item.reveal) emitTo(w, "note-reveal", { noteId: item.id, text: item.reveal.slice(0, 600) });
      });
      // × in the reader's result bar: end the search session but keep the document.
      ipcMain.handle("key:reader-dismiss", (event) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf") throw Error("Not a PDF reader");
        const session = sessionOf(v.id);
        if (session) dismissSearchPreview(session.sourceViewId);
        v.searchTarget = undefined;
      });
      ipcMain.handle("key:reader-ready", async (event) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf") throw Error("Not a PDF reader");
        const focus = v.pendingFocus;
        v.pendingFocus = undefined;
        if (v.temp) void tempPdfs.touch(v.temp.hash);
        const notice = v.libraryNotice;
        v.libraryNotice = undefined;
        // A PDF from the web: whether the window's library has it already.
        const inLibrary = v.temp
          ? await registry
              .invoke<{ items: any[] }>("store_sources", { ids: [v.temp.hash], limit: 1, scope: "all" }, (shellOfView(v.id) ?? focusedShell()).workspaceId)
              .then((page) => Boolean(page.items[0]))
              .catch(() => false)
          : false;
        return {
          web: v.temp
            ? { url: v.temp.url, referrer: v.temp.referrer, host: hostLabel(v.temp.referrer ?? v.temp.url), inLibrary, attachTo: v.pdfFor && !inLibrary ? (v.pdfFor.title ?? "the source") : undefined }
            : notice
              ? { notice }
              : undefined,
          focus,
          notesOpen: !!v.panel,
          panelTab: v.panel ? (v.panel.tab ?? "details") : undefined,
          source: v.source,
          workspaceId: v.workspaceId,
          viewState: v.viewState,
          searchTarget: v.searchTarget,
          searchNavigation: {
            query: sessionOf(v.id)?.query,
            shared: v.sharedSearchNavigation,
            index: v.searchIndex ?? -1,
            total: v.searchResults?.length ?? 0,
          },
        };
      });
      // The floating control over a PDF from the web: add it to the window's library, or open
      // the library's copy; either way the tab becomes the library's reader of it.
      ipcMain.handle("key:reader-add-to-library", async (event) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf" || !v.temp) throw Error("This PDF is in a library already");
        return addTempToLibrary(v);
      });
      ipcMain.handle("key:reader-open-in-library", async (event) => {
        const v = bound(event.sender.id);
        if (v?.kind !== "pdf" || !v.temp) throw Error("This PDF is in a library already");
        const w = shellOfView(v.id) ?? focusedShell();
        await swapToLibrary(v, w.workspaceId, v.temp.hash, "exists");
      });
      ipcMain.handle("key:reader-open-page", (event) => {
        const v = bound(event.sender.id);
        if (!v?.temp) return;
        // The page that led to the PDF (the browser records it), else the site it is on; not
        // the PDF again, which would only download it once more.
        let page = v.temp.referrer;
        if (!page)
          try {
            page = new URL(v.temp.url).origin + "/";
          } catch {
            page = v.temp.url;
          }
        const w = shellOfView(v.id);
        const open = [...views.values()].find((x) => x.kind === "web" && x.web?.url === page && w && shellOfView(x.id) === w);
        if (open) focus(open.id);
        else openLink(page, w);
      });
      ipcMain.handle("key:sign-in-info", (event) => {
        shell(event.sender.id);
        return signInService?.info();
      });
      ipcMain.handle("key:clear-browsing-data", async (event) => {
        shell(event.sender.id);
        await clearBrowsingData();
        await tempPdfs.clear(new Set([...views.values()].flatMap((v) => (v.temp ? [v.temp.hash] : []))));
      });
      ipcMain.on("key:reader-state", (event, value) => {
        const v = bound(event.sender.id);
        if (v?.kind === "pdf") {
          v.viewState = value;
          // Reading status and history (reading-events.ts).
          reportReading((c, a, id) => registry.invoke(c, a, id), v, value, () => emit("library-changed"));
        }
      });
      ipcMain.handle("key:tab-action", async (event, action, p = {}) => {
        const w = shell(event.sender.id);
        switch (action) {
          case "global-overlay-open": {
            w.globalOverlay = String(p.id);
            w.overlayCaptureKey = "";
            const frames = await captureOverlayFrames(w);
            if (w.globalOverlay === p.id) {
              w.overlayCaptureKey = overlayKey(w);
              layout(w);
            }
            return { frames };
          }
          case "full-screen-state":
            return w.window.isFullScreen();
          case "global-overlay-close": {
            if (w.globalOverlay === p.id) {
              w.globalOverlay = undefined;
              w.overlayCaptureKey = "";
              ++w.overlayCaptureSequence;
              layout(w);
            }
            return;
          }
          case "preview-result": {
            const source = views.get(p.sourceViewId);
            if (!source?.content || !p.hit?.id || !p.hit?.documentHash)
              throw Error("Invalid search preview");
            const hitWorkspace =
              p.hit.workspaceId ?? p.source?.workspaceId ?? source.workspaceId;
            if (!hitWorkspace) throw Error("Choose a workspace");
            const all = (Array.isArray(p.results) ? p.results : []).map(
              (h: any) => ({
                id: h.id,
                documentHash: h.documentHash,
                documentTitle: h.documentTitle,
                workspaceId: h.workspaceId ?? hitWorkspace,
                page: h.page,
              }),
            );
            const selected = all.findIndex(
              (h: SearchResultRef) =>
                h.id === p.hit.id && h.workspaceId === hitWorkspace,
            );
            const start = selected >= 1000 ? selected - 500 : 0;
            const hits: SearchResultRef[] = all.slice(start, start + 1000);
            let index = hits.findIndex(
              (h) => h.id === p.hit.id && h.workspaceId === hitWorkspace,
            );
            if (index < 0) {
              hits.unshift({ ...p.hit, workspaceId: hitWorkspace });
              index = 0;
            }
            const previous = searchPreviews.get(source.id);
            if (previous) ++previous.sequence;
            const session: SearchPreviewSession = {
              sourceViewId: source.id,
              previewViewId: previous?.previewViewId,
              hits,
              index,
              query: String(p.query || ""),
              busy: false,
              sequence: 0,
              dismissed: false,
              beside: p.beside === true,
            };
            searchPreviews.set(source.id, session);
            await showSearchPreview(session, index);
            return snapshot(w);
          }
          case "preview-step": {
            const session = activeSearchPreview(w);
            if (session && !session.busy && [-1, 1].includes(p.direction))
              await showSearchPreview(session, session.index + p.direction);
            return snapshot(w);
          }
          case "preview-dismiss":
            dismissSearchPreview(
              p.sourceViewId ?? activeSearchPreview(w)?.sourceViewId,
            );
            return snapshot(w);
          case "preview-focus-list": {
            const session = activeSearchPreview(w);
            if (session) focus(session.sourceViewId);
            return snapshot(w);
          }
          // A new Home tab, in the given group or the focused one.
          case "new":
            home(w, typeof p.groupId === "string" ? p.groupId : undefined);
            break;
          case "quick-capture":
            quickCapture();
            return snapshot(w);
          case "open-home": {
            const existing =
              allTabs(w.state).find((t) => views.get(t.viewId)?.content?.section === "home")?.viewId ??
              [...views.values()].find((v) => v.content?.section === "home" && shellOfView(v.id))?.id;
            if (existing) focus(existing); else home(w);
            break;
          }
          case "open-content":
            await withPlacement(p, () => openContent(w, p));
            // A note opened at a passage (renderer/note-reveal.ts).
            if (p.section === "note" && typeof p.reveal === "string" && p.reveal) emitTo(w, "note-reveal", { noteId: p.noteId, text: p.reveal.slice(0, 600) });
            break;
          case "history":
            stepHistory(w, String(p.viewId ?? activeViewId(w) ?? ""), Number(p.step) < 0 ? -1 : 1);
            return snapshot(w);
          // A browser tab's bar: reload, and Add to library / In library on an article page.
          case "web-page": {
            const view = views.get(String(p.viewId ?? activeViewId(w) ?? ""));
            if (view?.kind !== "web" || !view.view) throw Error("Not a browser tab");
            if (p.op === "reload") view.view.webContents.reload();
            else if (p.op === "add-article") await browserPages.addArticle(view);
            else if (String(p.op).startsWith("proxy-")) await proxyService?.op(view.view.webContents, view.web?.url ?? "", p.op as ProxyOp);
            else if (String(p.op).startsWith("signin-")) await signInService?.op(view.view.webContents, p.op as SignInOp);
            else if (p.op === "open-article" && view.articleState?.sourceId) await openSourcePage(w, { workspaceId: w.workspaceId, sourceId: view.articleState.sourceId });
            return snapshot(w);
          }
          // A note's tab follows its title as it is edited.
          case "content-title": {
            const view = views.get(p.viewId);
            if (!["note", "source", "webpage", "canvas", ...ENTITY_SECTIONS].includes(view?.content?.section ?? "")) throw Error("Not a note, source or canvas page");
            view!.title = String(p.title || (view!.content!.section === "note" ? "Untitled note" : view!.content!.section === "canvas" ? "Untitled canvas" : "Untitled")).slice(0, 200);
            tabsChanged(w);
            return snapshot(w);
          }
          case "content-saved": {
            const view = views.get(p.viewId);
            if (view?.content?.section !== "record")
              throw Error("Not a record view");
            const saved = await registry.invoke<any>(
              "workspace_record",
              { id: p.recordId },
              view.workspaceId,
            );
            if (!saved) throw Error("Saved item is missing");
            view.content.record = saved;
            view.contentKey = JSON.stringify([
              "record",
              view.workspaceId,
              saved.id,
            ]);
            view.title = saved.title;
            view.dirty = false;
            tabsChanged(w);
            return snapshot(w);
          }
          case "content-state": {
            const record = views.get(p.viewId);
            if (record?.kind !== "home" || record.content?.section !== "record")
              return snapshot(w);
            const changed =
              record.title !== p.title || record.dirty !== Boolean(p.dirty);
            record.title = String(p.title || "Untitled");
            record.dirty = Boolean(p.dirty);
            if (p.recordId && record.content.record) {
              record.content.record.id = p.recordId;
              record.content.record.title = record.title;
            }
            if (p.recordId)
              record.contentKey = JSON.stringify([
                "record",
                record.workspaceId,
                p.recordId,
              ]);
            if (changed) tabsChanged(w);
            return snapshot(w);
          }
          case "open-url": {
            // "Open in Zotero" on a synced source: selects the item in Zotero.
            if (/^zotero:\/\/select\/library\/items\/[A-Z0-9]{8}$/.test(String(p.url))) return void (await systemShell.openExternal(String(p.url)));
            if (!webUrl(p.url) && !systemUrl(p.url)) throw Error("Unsupported link");
            if (p.external) await systemShell.openExternal(String(webUrl(p.url) ?? systemUrl(p.url)));
            // Find PDF's last step: the landing page (through the library's proxy when this
            // network needs it, as any page), where a PDF captured is attached to the source.
            else if (p.pdfFor && typeof p.pdfFor.sourceId === "string" && webUrl(p.url))
              openLink(String(webUrl(p.url)), w, {
                pdfFor: { workspaceId: String(p.pdfFor.workspaceId || w.workspaceId), sourceId: p.pdfFor.sourceId, title: typeof p.pdfFor.title === "string" ? p.pdfFor.title.slice(0, 200) : undefined },
              });
            // Beside the view that asked (the Inbox's "o"), when it says so.
            else await withPlacement(p, async () => openLink(p.url, w, { background: Boolean(p.background) }));
            return snapshot(w);
          }
          case "sidebar-width":
            w.sidebarWidth = Number.isFinite(Number(p.width))
              ? Math.max(0, Math.min(360, Number(p.width)))
              : 240;
            placeViews(w);
            return snapshot(w);
          case "inspector-width":
            w.inspectorWidth = Math.max(0, Math.min(480, Number(p.width) || 0));
            placeViews(w);
            return snapshot(w);
          // A tab dropped from a drag: into a group's strip at `index`, or into a new group
          // on a group's `side` (see tab-strip.tsx).
          case "drop-tab": {
            const tabId = String(p.tabId),
              groupId = String(p.groupId);
            if (p.kind === "move") w.state = moveWorkspaceTab(w.state, tabId, groupId, Number.isFinite(Number(p.index)) ? Number(p.index) : undefined);
            else if (p.kind === "split" && (p.side === "left" || p.side === "right")) w.state = splitWorkspaceTab(w.state, tabId, groupId, p.side);
            layout(w);
            focusShown(w);
            return snapshot(w);
          }
          case "split-right":
            splitRight(w, typeof p.tabId === "string" ? p.tabId : undefined);
            return snapshot(w);
          case "focus-group":
            w.state = focusGroup(w.state, String(p.groupId));
            layout(w);
            if (p.keyboard) focusShown(w);
            return snapshot(w);
          case "resize-groups":
            w.state = setGroupSizes(w.state, Array.isArray(p.sizes) ? p.sizes.map(Number) : []);
            placeViews(w);
            if (p.done) tabsChanged(w);
            return;
          case "equalize-groups":
            w.state = equalizeGroups(w.state);
            break;
          // A reader's panel: resized, popped out into a tab of its own, or closed.
          case "panel-resize": {
            const pdf = views.get(tabViewId(String(p.viewId)));
            if (pdf?.panel && Number.isFinite(Number(p.ratio))) pdf.panel.ratio = Math.min(0.8, Math.max(0.2, Number(p.ratio)));
            placeViews(w);
            if (p.done) tabsChanged(w);
            return;
          }
          case "panel-pop-out": {
            const pdf = views.get(tabViewId(String(p.viewId)));
            if (pdf) popOutPanel(w, pdf);
            return snapshot(w);
          }
          case "panel-tab": {
            const pdf = views.get(tabViewId(String(p.viewId)));
            const tab = panelTab(p.tab);
            if (pdf?.panel && tab) {
              pdf.panel.tab = tab;
              pdf.view?.webContents.send("reader-notes", tab);
            }
            tabsChanged(w);
            return snapshot(w);
          }
          case "web-panel": {
            const reader = views.get(tabViewId(String(p.viewId)));
            if (!reader) return false;
            return toggleWebPanel(w, reader, panelTab(p.tab));
          }
          case "panel-close": {
            const pdf = views.get(tabViewId(String(p.viewId)));
            if (pdf) closePanel(pdf);
            break;
          }
          case "reorder":
            w.state = reorderWorkspaceTab(w.state, p.tabId, Number(p.index));
            tabsChanged(w);
            return snapshot(w);
          // A press on the tab strip: the dismiss relay already closes other views' menus.
          case "chrome-pressed":
            return snapshot(w);
          // The strip's tab list: a group's tabs.
          case "tab-menu": {
            const group = w.state.groups.find((g) => g.id === p.groupId) ?? activeGroup(w.state);
            Menu.buildFromTemplate(
              group.tabs.map((tab) => ({
                label: views.get(tab.viewId)?.title ?? "Key",
                type: "radio" as const,
                checked: tab.id === group.activeTabId,
                click: () => {
                  w.state = activateWorkspaceTab(w.state, tab.id);
                  layout(w);
                },
              })),
            ).popup({ window: w.window, x: Math.round(p.x), y: Math.round(p.y) });
            return snapshot(w);
          }
          case "take-note-appends": {
            const queued = pendingAppends.get(String(p.sourceId)) ?? [];
            pendingAppends.delete(String(p.sourceId));
            return queued;
          }
          // "Show in PDF" on a highlight or quote: no search session, just go there.
          case "reader-focus": {
            const v = views.get(`pdf:${p.workspaceId}:${p.documentHash}`);
            if (v?.kind !== "pdf") throw Error("The PDF is not open");
            const target = {
              page: typeof p.page === "number" ? p.page : undefined,
              top: typeof p.top === "number" && Number.isFinite(p.top) ? p.top : undefined,
              annotationId: p.annotationId ? String(p.annotationId) : undefined,
              text: typeof p.text === "string" && p.text.trim() ? p.text.slice(0, 4000) : undefined,
            };
            v.pendingFocus = target;
            v.view?.webContents.send("reader-focus", target);
            return snapshot(w);
          }
          case "open-source-page":
            if (!p.workspaceId || !p.sourceId) throw Error("Choose a source");
            await withPlacement(p.read ? {} : p, () => openSourcePage(w, p));
            return snapshot(w);
          // Multiple windows: move a tab out to a new window or into another one.
          case "pop-out":
            moveTab(w, String(p.tabId ?? activeWorkspaceTab(w.state)?.id));
            return snapshot(w);
          case "move-to-window": {
            const target = liveShells().find((s) => s.id === p.windowId);
            if (target && target !== w) moveTab(w, String(p.tabId), target);
            return snapshot(w);
          }
          case "tab-context-menu": {
            const tabId = String(p.tabId);
            const found = findTab(w.state, tabId);
            if (!found) return snapshot(w);
            const { tab, group, index } = found;
            const others = liveShells().filter((s) => s !== w);
            const full = w.state.groups.length >= MAX_GROUPS;
            const left = neighbourGroup(w.state, group.id, "left"),
              right = neighbourGroup(w.state, group.id, "right");
            const moveTo = (target: TabGroup) => () => {
              w.state = moveWorkspaceTab(w.state, tabId, target.id);
              layout(w);
            };
            // A browser tab, or a PDF from the web: its page in the system's browser.
            const viewed = views.get(tab.viewId);
            const page = viewed?.web?.url ?? viewed?.temp?.url;
            Menu.buildFromTemplate([
              ...(page
                ? [
                    { label: "Open in Default Browser", click: () => void systemShell.openExternal(page) },
                    { label: "Copy Link", click: () => clipboard.writeText(page) },
                    { type: "separator" as const },
                  ]
                : []),
              { label: "New Tab to the Right", click: () => { w.state = addWorkspaceTab(w.state, singleWorkspaceTab(homeView().id), { groupId: group.id, index: index + 1 }); layout(w); } },
              { type: "separator" as const },
              { label: tab.pinned ? "Unpin Tab" : "Pin Tab", click: () => pinTab(w, tabId, !tab.pinned) },
              { type: "separator" as const },
              { label: "Split Right", enabled: !full, click: () => splitRight(w, tabId) },
              ...(left ? [{ label: "Move to Left Group", click: moveTo(left) }] : []),
              ...(right ? [{ label: "Move to Right Group", click: moveTo(right) }] : []),
              { type: "separator" as const },
              { label: "Move to New Window", enabled: allTabs(w.state).length > 1 || others.length > 0, click: () => moveTab(w, tabId) },
              ...(others.length
                ? [
                    {
                      label: "Move to Window",
                      submenu: others.map((s) => ({
                        label: windowLabel(s),
                        click: () => moveTab(w, tabId, s),
                      })),
                    },
                  ]
                : []),
              { type: "separator" as const },
              { label: "Close Tab", click: () => void closeTab(w, tabId) },
              { label: "Close Other Tabs", enabled: tabsToClose(w.state, tabId, "others").length > 0, click: () => void closeTabs(w, tabsToClose(w.state, tabId, "others")) },
              { label: "Close Tabs to the Right", enabled: tabsToClose(w.state, tabId, "right").length > 0, click: () => void closeTabs(w, tabsToClose(w.state, tabId, "right")) },
            ]).popup({ window: w.window, x: Math.round(p.x), y: Math.round(p.y) });
            return snapshot(w);
          }
          case "activate":
            w.state = activateWorkspaceTab(w.state, p.tabId);
            break;
          // The tab switcher's overlay: "Show all tabs", a row clicked or hovered, a close button, the backdrop.
          case "tab-switcher":
            if (p.op === "open") tabSwitcher.open(w);
            else if (p.op === "pick") tabSwitcher.pick(w, String(p.tabId));
            else if (p.op === "select") tabSwitcher.select(w, Number(p.index));
            else if (p.op === "close-tab") await tabSwitcher.closeTab(w, String(p.tabId));
            else tabSwitcher.cancel(w);
            return snapshot(w);
          case "focus":
            focus(p.viewId);
            break;
          case "close":
            await closeTab(w, p.tabId);
            break;
          // The tab showing `viewId` moves beside the focused group (a group of its own on `edge`).
          case "split": {
            const found = findViewTab(w.state, String(p.viewId));
            if (found) w.state = splitWorkspaceTab(w.state, found.tab.id, activeGroup(w.state).id, p.edge === "left" ? "left" : "right");
            break;
          }
          // Closes the tab showing `viewId`, or the panel when it is one.
          case "close-view":
            await closeView(w, String(p.viewId ?? activeViewId(w)));
            return snapshot(w);
          case "pin":
            pinTab(w, String(p.tabId), Boolean(p.pinned));
            return snapshot(w);
          case "close-tabs":
            if (p.which === "others" || p.which === "right") await closeTabs(w, tabsToClose(w.state, String(p.tabId), p.which));
            return snapshot(w);
          // Workspaces: in place, or (newWindow) beside this window.
          case "switch-workspace":
            await switchWorkspace(w, String(p.workspaceId), Boolean(p.newWindow));
            break;
          // A tab dragged out of the window opens in a new window near the pointer.
          case "tear-off": {
            const found = findTab(w.state, String(p.tabId));
            if (!found || (allTabs(w.state).length === 1 && liveShells().length === 1)) break;
            const at = screen.getCursorScreenPoint();
            moveTab(w, found.tab.id, undefined, { x: at.x - 120, y: at.y - 20 });
            return snapshot(w);
          }
          // A workspace record that stands for a file (a document saved by an earlier
          // version's Office editors) opens in the file's default app.
          case "open-record-file": {
            const item: any = await registry.invoke("workspace_record", { id: p.recordId }, p.workspaceId);
            if (!item?.properties?.path) throw Error("No file is linked to this item");
            await openInDefaultApp(String(item.properties.path));
            break;
          }
          case "link-folder": {
            const result = await dialog.showOpenDialog(w.window, {
              properties: ["openDirectory"],
            });
            if (!result.canceled) {
              const linked: any = await registry.invoke(
                "workspace_link_folder",
                { projectId: p.projectId, path: result.filePaths[0] },
                p.workspaceId,
              );
              await registry.invoke(
                "workspace_scan_linked_folder",
                { id: linked.id, maxEntries: 10000 },
                p.workspaceId,
              );
              emit("library-changed");
            }
            break;
          }
        }
        layout(w);
        return snapshot(w);
      });
      if (!first) return;
      // Tabs exist before the page loads, so nothing opened early lands in front of them.
      if (restoring[0]) await restoreTabs(first, restoring[0].tabs);
      if (!allTabs(first.state).length) home(first);
      startupMark("shell-load");
      await loadShell(first);
      startupMark("shell-loaded");
      layout(first);
      for (const saved of restoring.slice(1)) createShell({ saved });
      if (restoring.length > 1) first.window.focus();
    })
    .catch((error) => {
      fatal("Key could not start", error);
      app.quit();
    });
// On a Mac, Key stays open with the workspaces window closed too (the Dock icon brings it back).
app.on("window-all-closed", () => {
  if (!launcherMode || process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (launcherMode && launcher && !liveShells().length && !launcher.isOpen()) launcher.show();
});
// Files given to Key (dropped on the Dock icon): added to the front workspace, or, with none
// open, the workspaces window asks which one.
app.on("open-file", (event, path) => {
  event.preventDefault();
  void app.whenReady().then(() => setTimeout(() => {
    const w = focusedShell();
    if (w?.workspaceId)
      void registry
        .invoke("store_import_files", { paths: [path], collectionId: null }, w.workspaceId)
        .then(() => {
          emit("library-changed");
          void openContent(w, { section: "sources", workspaceId: w.workspaceId }).then(() => layout(w));
        })
        .catch((e) => emit("operation-error", String(e)));
    else launcher?.takeFiles([path]);
  }, launcher ? 0 : 1500));
});
