// Zotero sync through the Key Sync plugin: asks the Zotero workspace's host to sync every
// 15 seconds while Key runs and when a window gets focus, backing off while Zotero is not
// running or the plugin is missing. Also finds the plugin file Key carries.
import { app, ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { installPlugin, installStatus, openZotero, restartZotero, settleInstall } from "./zotero-install";

const BASE = 15_000;
const MAX = 5 * 60_000;
/** Without a sync set up the host is asked rarely; setting one up wakes the timer. */
const IDLE = 5 * 60_000;

type Workspace = { id: string; root: string };
export interface ZoteroSyncDeps {
  invoke: (command: string, args: Record<string, unknown>, workspaceId: string) => Promise<unknown>;
  /** The Zotero workspace, if it exists (never created here). */
  workspace: () => Promise<Workspace | undefined>;
  changed: () => void;
  /** Throws unless the IPC sender is a Key window. */
  check: (sender: number) => void;
}

/** The bundled Key Sync plugin (.xpi), built on demand in development. */
export function zoteroPluginFile(): string | null {
  if (app.isPackaged) {
    const file = join(process.resourcesPath, "zotero/key-sync.xpi");
    return existsSync(file) ? file : null;
  }
  const root = resolve(app.getAppPath(), "../../../../integrations/zotero-key-sync");
  const file = join(root, "dist/key-sync.xpi");
  if (!existsSync(file) && existsSync(join(root, "build.mjs"))) {
    try {
      execFileSync(process.execPath, [join(root, "build.mjs")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore" });
    } catch (e) {
      console.warn("Could not build the Key Sync plugin:", e);
    }
  }
  return existsSync(file) ? file : null;
}

export function startZoteroPluginSync(deps: ZoteroSyncDeps) {
  let delay = BASE;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let lastRun = 0;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void tick(), delay);
  };
  const tick = async (force = false) => {
    if (running) return;
    running = true;
    lastRun = Date.now();
    try {
      const workspace = await deps.workspace();
      // No Zotero workspace, or one that never synced: nothing to ask.
      if (!workspace || !existsSync(join(workspace.root, ".key", "zotero-sync.sqlite"))) {
        delay = IDLE;
        return;
      }
      const result = (await deps.invoke("store_zotero_plugin_sync", { force, $background: !force }, workspace.id)) as {
        ran?: boolean;
        connection?: string;
      } | null;
      if (result?.ran) deps.changed();
      const connection = result?.connection;
      if (connection === "ok" || connection === undefined) delay = BASE;
      else if (connection === "off" || connection === "paused") delay = IDLE;
      else delay = Math.min(MAX, Math.max(BASE, delay * 2));
    } catch (e) {
      console.warn("Zotero sync:", e);
      delay = Math.min(MAX, Math.max(BASE, delay * 2));
    } finally {
      running = false;
      schedule();
    }
  };
  const wake = () => {
    delay = BASE;
    return tick(true);
  };

  app.on("browser-window-focus", () => {
    if (Date.now() - lastRun < 5_000) return;
    delay = BASE;
    void tick();
  });
  ipcMain.handle("key:zotero-plugin", async (event, action: unknown) => {
    deps.check(event.sender.id);
    if (action === "wake") {
      await wake();
      return null;
    }
    const file = zoteroPluginFile();
    if (action === "status") return { file, install: settleInstall(file) };
    if (action === "install" || action === "restart" || action === "open") {
      try {
        const install = action === "install" ? installPlugin(file) : action === "restart" ? await restartZotero(file) : await openZotero(file);
        return { file, install };
      } catch (e) {
        return { file, install: installStatus(file), error: e instanceof Error ? e.message : String(e) };
      }
    }
    return { file };
  });
  timer = setTimeout(() => void tick(), 4_000);
  return { wake };
}
