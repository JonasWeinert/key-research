import { contextBridge, ipcRenderer, webUtils } from "electron";
contextBridge.exposeInMainWorld("key", {
  invoke: (
    command: string,
    args?: unknown,
    workspaceId?: string,
    options?: unknown,
  ) => ipcRenderer.invoke("key:invoke", command, args, workspaceId, options),
  workspaces: () => ipcRenderer.invoke("key:workspaces"),
  addWorkspace: () => ipcRenderer.invoke("key:add-workspace"),
  appSettings: () => ipcRenderer.invoke("key:app-settings"),
  setAppSettings: (patch: unknown) => ipcRenderer.invoke("key:set-app-settings", patch),
  tabs: () => ipcRenderer.invoke("key:tabs"),
  openSources: (id?: string) => ipcRenderer.invoke("key:open-sources", id),
  importZotero: (options?: unknown) => ipcRenderer.invoke("key:import-zotero", options),
  zoteroWorkspace: () => ipcRenderer.invoke("key:zotero-workspace"),
  syncZotero: () => ipcRenderer.invoke("key:sync-zotero"),
  zoteroPlugin: (action?: "wake" | "status" | "install" | "restart" | "open") => ipcRenderer.invoke("key:zotero-plugin", action),
  addFiles: (workspaceId: string, collectionId?: string) =>
    ipcRenderer.invoke("key:add-files", workspaceId, collectionId),
  importPaths: (workspaceId: string, paths: string[], collectionId?: string) =>
    ipcRenderer.invoke("key:import-paths", workspaceId, paths, collectionId),
  openPath: (path: string) => ipcRenderer.invoke("key:open-path", path),
  revealPath: (path: string) => ipcRenderer.invoke("key:reveal-path", path),
  thumbnail: (path: string, size?: number) => ipcRenderer.invoke("key:thumbnail", path, size),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  startFileDrag: (paths: string[]) => ipcRenderer.send("key:start-file-drag", paths),
  captureSave: (text: string) => ipcRenderer.invoke("key:capture-save", text),
  openSource: (source: unknown, hit?: unknown, results?: unknown[]) =>
    ipcRenderer.invoke("key:open-source", source, hit, results),
  tabAction: (action: string, payload?: unknown) =>
    ipcRenderer.invoke("key:tab-action", action, payload),
  readerBack: () => ipcRenderer.invoke("key:reader-back"),
  readerDismiss: () => ipcRenderer.invoke("key:reader-dismiss"),
  readerNotes: (tab?: string) => ipcRenderer.invoke("key:reader-notes", tab),
  readerAddToNote: (passage: unknown) => ipcRenderer.invoke("key:reader-add-to-note", passage),
  readerSendTo: (highlight: unknown) => ipcRenderer.invoke("key:reader-send-to", highlight),
  readerAnalysis: () => ipcRenderer.invoke("key:reader-analysis"),
  readerReanalyze: () => ipcRenderer.invoke("key:reader-reanalyze"),
  readerOpenSource: (sourceId: string) => ipcRenderer.invoke("key:reader-open-source", sourceId),
  readerOpenItem: (item: unknown) => ipcRenderer.invoke("key:reader-open-item", item),
  readerResult: (direction: number) =>
    ipcRenderer.invoke("key:reader-result", direction),
  readerReady: () => ipcRenderer.invoke("key:reader-ready"),
  // A PDF opened from the web (see main/browser).
  readerAddToLibrary: () => ipcRenderer.invoke("key:reader-add-to-library"),
  readerOpenInLibrary: () => ipcRenderer.invoke("key:reader-open-in-library"),
  readerOpenPage: () => ipcRenderer.invoke("key:reader-open-page"),
  clearBrowsingData: () => ipcRenderer.invoke("key:clear-browsing-data"),
  proxies: (action: string, payload?: unknown) => ipcRenderer.invoke("key:proxies", action, payload),
  readerState: (state: unknown) => ipcRenderer.send("key:reader-state", state),
  // The status bar (shared/status-items.ts): a native view's own items, and their clicks.
  setStatusItems: (items: unknown) => ipcRenderer.send("key:status-items", items),
  onStatusItem: (callback: (id: string) => void) => {
    const listener = (_: unknown, value: { id?: unknown }) => typeof value?.id === "string" && callback(value.id);
    ipcRenderer.on("status-item-invoke", listener);
    return () => ipcRenderer.removeListener("status-item-invoke", listener);
  },
  statusItems: () => ipcRenderer.invoke("key:status-items"),
  invokeStatusItem: (viewId: string, id: string) => ipcRenderer.invoke("key:status-item-invoke", viewId, id),
  notices: () => ipcRenderer.invoke("key:notices"),
  on: (event: string, callback: (value: unknown) => void) => {
    if (
      ![
        "tabs-changed",
        "global-overlay-frames",
        "zotero-syncing",
        "save-content",
        "property-definitions-changed",
        "library-changed",
        "open-settings",
        "note-changed",
        "links-changed",
        "linked-folders-changed",
        "note-append",
        "note-reveal",
        "annotations-changed",
        "search-target",
        "reader-focus",
        "reader-notes",
        "search-navigation",
        "operation-error",
        "focus-pane",
        "open-workspace-switcher",
        "toggle-inspector",
        "command",
        "send-items",
        "browser-notice",
        "dismiss-overlays",
        "status-items",
        "app-notice",
        "proxies-changed",
      ].includes(event)
    )
      throw Error("Unknown event");
    const listener = (_: unknown, value: unknown) => callback(value);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
// Uncaught page errors go to the log (main/app-notices.ts).
const reportError = (message: unknown, detail?: unknown) =>
  ipcRenderer.send("key:report-error", { message: String(message), detail: detail === undefined ? undefined : String(detail) });
window.addEventListener("error", (event) => reportError(event.message, (event.error as Error | undefined)?.stack));
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as Error | undefined;
  reportError(reason?.message ?? reason, reason?.stack);
});
