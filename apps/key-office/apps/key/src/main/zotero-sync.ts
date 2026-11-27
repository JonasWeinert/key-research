// Zotero sync through the Key Sync plugin: asks each workspace set up to sync (the "Zotero"
// workspace or any other) to sync while Key
// runs and when a window gets focus. The host plans, merges and paces the sync (key-zotero
// `plugin::sync` and `next_delay`: steady while Zotero answers, backing off while it is not
// running or the plugin is missing); this only keeps the timer. Also finds and installs the
// plugin file Key carries.
import { app, ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { installPlugin, installStatus, openZotero, restartZotero, settleInstall } from "./zotero-install";

/** Until the host has said when to ask again. */
const FIRST = 15_000;
/** Without a Zotero workspace (no host to ask) the timer looks rarely; setting one up wakes it. */
const IDLE = 5 * 60_000;

type Workspace = { id: string; root: string };
export interface ZoteroSyncDeps {
  invoke: (command: string, args: Record<string, unknown>, workspaceId: string) => Promise<unknown>;
  /** The workspaces that may sync with Zotero (never created here). */
  workspaces: () => Promise<Workspace[]>;
  changed: () => void;
  /** A sync with Zotero starts (true) or ends (false). */
  syncing?: (running: boolean) => void;
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
  let delay = FIRST;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  /** The run going on now: a wake during it runs again after it (a workspace just set up
   * is not left to the next timer). */
  let current: Promise<void> | undefined;
  let lastRun = 0;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void tick(), delay);
  };
  const tick = (force = false): Promise<void> => {
    if (running) return current ?? Promise.resolve();
    current = run(force);
    return current;
  };
  const run = async (force: boolean) => {
    running = true;
    lastRun = Date.now();
    try {
      // Only workspaces that synced once (their host keeps zotero-sync.sqlite) are asked.
      const workspaces = (await deps.workspaces()).filter((w) => existsSync(join(w.root, ".key", "zotero-sync.sqlite")));
      if (!workspaces.length) {
        delay = IDLE;
        return;
      }
      let next = IDLE;
      deps.syncing?.(true);
      try {
        for (const workspace of workspaces) {
          const result = (await deps.invoke("store_zotero_plugin_sync", { force, schedule: true, $background: !force }, workspace.id).catch((e) => {
            console.warn(`Zotero sync (${workspace.root}):`, e);
            return { nextMs: FIRST };
          })) as { ran?: boolean; nextMs?: number } | null;
          if (result?.ran) deps.changed();
          // The soonest any workspace wants to be asked again.
          if (typeof result?.nextMs === "number" && result.nextMs > 0) next = Math.min(next, result.nextMs);
        }
      } finally {
        deps.syncing?.(false);
      }
      delay = next;
    } catch (e) {
      // The host itself did not answer (it is restarting): try again at the usual pace.
      console.warn("Zotero sync:", e);
      delay = FIRST;
    } finally {
      running = false;
      schedule();
    }
  };
  const wake = async () => {
    if (running) await current;
    await tick(true);
  };

  app.on("browser-window-focus", () => {
    if (Date.now() - lastRun < 5_000) return;
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
