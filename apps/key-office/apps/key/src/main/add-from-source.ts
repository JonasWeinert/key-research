// "Add to library" from inside a native view (a PDF's citation card or reference list, a web
// result opened from a source): the view asks over `key:add-from-source`, its window's shell
// shows the collection chooser (renderer/add-from-source.tsx) and answers over
// `key:add-from-source-done` with the added source, or null when the user cancelled.
import { ipcMain, type WebContents } from "electron";
import { randomUUID } from "node:crypto";

const WAIT = 10 * 60_000;

export interface AddFromSourceDeps {
  /** The shell whose chooser should ask for this sender (a view in it, or the shell itself). */
  shellFor: (sender: number) => WebContents | undefined;
  /** Throws unless the sender is a Key shell window. */
  check: (sender: number) => void;
}

const text = (value: unknown, max = 2000) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);

export function registerAddFromSource(deps: AddFromSourceDeps) {
  const pending = new Map<string, (result: { source?: unknown; error?: string } | null) => void>();
  ipcMain.handle("key:add-from-source", (event, request: { origin?: { workspaceId?: unknown; sourceId?: unknown }; work?: Record<string, unknown> } | undefined) => {
    const shell = deps.shellFor(event.sender.id);
    if (!shell || shell.isDestroyed()) throw Error("There is no window to add it from");
    const workspaceId = text(request?.origin?.workspaceId, 200);
    if (!workspaceId) throw Error("Which library to add to is missing");
    const w = request?.work ?? {};
    const year = Number(w.year);
    const work = {
      openalexId: text(w.openalexId, 64),
      doi: text(w.doi, 300),
      title: text(w.title),
      year: Number.isInteger(year) && year > 0 ? year : undefined,
      url: text(w.url),
      byline: text(w.byline, 500),
      container: text(w.container, 500),
    };
    if (!work.openalexId && !work.doi && !work.title && !work.url) throw Error("Nothing to add");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(null), WAIT);
      const finish = (result: { source?: unknown; error?: string } | null) => {
        clearTimeout(timer);
        pending.delete(requestId);
        if (result?.error) reject(Error(result.error));
        else resolve(result?.source ?? null);
      };
      pending.set(requestId, finish);
      shell.send("add-from-source", { requestId, origin: { workspaceId, sourceId: text(request?.origin?.sourceId, 200) ?? null }, work });
    });
  });
  ipcMain.handle("key:add-from-source-done", (event, requestId: unknown, result: unknown) => {
    deps.check(event.sender.id);
    if (typeof requestId === "string") pending.get(requestId)?.((result as { source?: unknown; error?: string }) ?? null);
  });
}
