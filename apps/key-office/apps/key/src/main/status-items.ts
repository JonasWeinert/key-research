// Status bar items that native views (the PDF reader, browser pages)
// contribute over IPC. See shared/status-items.ts for the contract. A view's items live
// until it replaces them or its web contents go away; the shell shows the focused view's.
import { ipcMain, type WebContents } from "electron";
import { sanitizeStatusItems, type StatusItem } from "../shared/status-items";

export function serveStatusItems(deps: {
  /** The view a native web contents shows, by its id. */
  viewOf(sender: WebContents): string | undefined;
  /** The web contents showing a view, to send its item clicks to. */
  contentsOf(viewId: string): WebContents | undefined;
  shells(): WebContents[];
}) {
  const items = new Map<string, StatusItem[]>();
  const broadcast = (viewId: string) => {
    for (const shell of deps.shells()) if (!shell.isDestroyed()) shell.send("status-items", { viewId, items: items.get(viewId) ?? [] });
  };
  const watched = new WeakSet<WebContents>();
  ipcMain.on("key:status-items", (event, value: unknown) => {
    const viewId = deps.viewOf(event.sender);
    if (!viewId) return;
    const next = sanitizeStatusItems(value);
    if (next.length) items.set(viewId, next);
    else items.delete(viewId);
    if (!watched.has(event.sender)) {
      watched.add(event.sender);
      event.sender.once("destroyed", () => {
        if (items.delete(viewId)) broadcast(viewId);
      });
    }
    broadcast(viewId);
  });
  ipcMain.handle("key:status-items", () => Object.fromEntries(items));
  ipcMain.handle("key:status-item-invoke", (_event, viewId: unknown, id: unknown) => {
    if (typeof viewId !== "string" || typeof id !== "string") return;
    const contents = deps.contentsOf(viewId);
    if (contents && !contents.isDestroyed()) contents.send("status-item-invoke", { id });
  });
}
