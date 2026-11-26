// The workspaces window ("Key — Workspaces"): a small window that belongs to no workspace and
// starts no library host. It lists the known workspaces with a summary cached when each one's
// window closed, creates and opens them, and is what Key shows on launch and when the last
// workspace window closes (see `launcherEnabled`). Renderer: src/renderer/launcher/.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { access, mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Registry, WorkspaceInfo } from "./workspaces";
import type { AppSettingsStore, OpenAtLaunch, Theme } from "./app-settings";

/** Automated runs open a workspace window directly, as before, unless they ask for the launcher. */
export const launcherEnabled = () => process.env.KEY_LAUNCHER === "1" || !(process.env.KEY_SKIP_ONBOARDING || process.env.KEY_TEST);

interface Meta {
  lastOpened?: number;
  sources?: number;
  notes?: number;
}
export interface LauncherWorkspace extends WorkspaceInfo {
  missing: boolean;
  open: boolean;
  lastOpened?: number;
  sources?: number;
  notes?: number;
}
type OpenOptions = { newWindow?: boolean; command?: string; files?: string[] };
export interface LauncherOptions {
  registry: () => Registry;
  settings: () => AppSettingsStore;
  preload: string;
  renderer: string;
  workspaceParent: () => string;
  /** Workspace ids open in windows now. */
  openWorkspaces: () => string[];
  /** Workspace ids, most recently used first. */
  recent: () => string[];
  /** Opens (or brings forward) a window on the workspace. */
  openWorkspace: (id: string, options: OpenOptions) => Promise<void>;
  /** The registry changed (titles and menus follow). */
  workspacesChanged: () => Promise<unknown>;
  /** The "Zotero" workspace, created on first use. */
  zoteroWorkspace: () => Promise<WorkspaceInfo>;
  info: () => Promise<{ version: string; workspaceParent: string; zoteroFound: boolean; notices: string | null }>;
  /** The app menu should be rebuilt (the launcher came forward or went away). */
  menuChanged: () => void;
}

/** Moves a workspace's folder; only within one disk, so nothing is copied half-way. */
export async function moveFolder(from: string, to: string) {
  await rename(from, to).catch((e: NodeJS.ErrnoException) => {
    throw Error(e.code === "EXDEV" ? "Key can only move a workspace within the same disk. Move it in Finder, then use Locate… in the workspaces window." : e.message);
  });
}
const exists = (path: string) => access(path).then(() => true, () => false);
const tilde = (path: string) => path.replace(homedir(), "~");

export class Launcher {
  private window?: BrowserWindow;
  private meta: Record<string, Meta> = {};
  private loaded?: Promise<void>;
  /** Files given to Key (Dock, Finder) while no workspace window was open: they wait for one. */
  private pendingFiles: string[] = [];
  constructor(private readonly file: string, private readonly o: LauncherOptions) {}

  private load() {
    return (this.loaded ??= readFile(this.file, "utf8").then(
      (text) => {
        const data = JSON.parse(text);
        if (data?.version === 1 && data.workspaces && typeof data.workspaces === "object") this.meta = data.workspaces;
      },
      () => undefined,
    ));
  }
  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, workspaces: this.meta }));
    } finally {
      await handle.close();
    }
    await rename(temp, this.file);
  }
  private async patch(id: string, value: Meta) {
    await this.load();
    this.meta[id] = { ...this.meta[id], ...value };
    await this.save().catch(() => undefined);
    this.changed();
  }
  /** A window opened on the workspace. */
  touched(id: string) {
    if (id) void this.patch(id, { lastOpened: Date.now() });
  }
  /** Remembers the workspace's counts while its host is still running (as its window closes). */
  async cacheSummary(id: string) {
    const registry = this.o.registry();
    if (!id || !registry.isRunning(id)) return;
    try {
      const summary = await registry.invoke<{ sources: number; notes: number }>("store_summary", {}, id, { timeoutMs: 4000 });
      await this.patch(id, { sources: summary.sources, notes: summary.notes });
    } catch {
      /* An older host, or one already gone: the row shows no counts. */
    }
  }
  /** Asks the window to read its list again. */
  changed() {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send("launcher-changed");
  }
  isOpen() {
    return !!this.window && !this.window.isDestroyed();
  }
  isFocused() {
    return this.isOpen() && this.window!.isFocused();
  }
  get browserWindow() {
    return this.window;
  }
  close() {
    if (this.isOpen()) this.window!.close();
  }
  show() {
    if (this.isOpen()) {
      const w = this.window!;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      this.changed();
      return w;
    }
    const window = (this.window = new BrowserWindow({
      width: 860,
      height: 540,
      minWidth: 720,
      minHeight: 460,
      show: false,
      center: true,
      title: "Key — Workspaces",
      fullscreenable: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 18 },
      ...(process.platform === "darwin" ? { vibrancy: "sidebar" as const, visualEffectState: "followWindow" as const, backgroundColor: "#00000000" } : {}),
      webPreferences: { preload: this.o.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    }));
    window.on("page-title-updated", (event) => event.preventDefault());
    window.once("ready-to-show", () => window.show());
    window.on("focus", () => this.o.menuChanged());
    window.on("closed", () => {
      if (this.window === window) this.window = undefined;
      this.o.menuChanged();
    });
    if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/launcher.html`);
    else void window.loadFile(join(this.o.renderer, "launcher.html"));
    return window;
  }

  /** Files opened with Key while no workspace window is open: the launcher asks where they go. */
  takeFiles(paths: string[]) {
    this.pendingFiles.push(...paths);
    this.show();
    this.changed();
  }

  async state() {
    await this.load();
    const registry = this.o.registry();
    const open = new Set(this.o.openWorkspaces());
    const recent = this.o.recent();
    const list = await registry.known();
    const workspaces: LauncherWorkspace[] = await Promise.all(
      list.map(async (w) => ({ ...w, missing: !(await exists(w.root)), open: open.has(w.id), ...this.meta[w.id] })),
    );
    // Most recently opened first; ones never opened keep the registry's order after them.
    const rank = (w: LauncherWorkspace) => {
      const at = recent.indexOf(w.id);
      return at < 0 ? recent.length + list.findIndex((k) => k.id === w.id) : at;
    };
    workspaces.sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0) || rank(a) - rank(b));
    const settings = this.o.settings().get();
    return { workspaces, info: await this.o.info(), openAtLaunch: settings.openAtLaunch, theme: settings.theme, pendingFiles: this.pendingFiles.map((p) => basename(p)) };
  }

  /** Recent workspaces for File › Open Workspace and the Dock menu. */
  recentItems(limit = 10): MenuItemConstructorOptions[] {
    const list = this.lastKnown;
    const order = this.o.recent();
    const sorted = [...list].sort((a, b) => (this.meta[b.id]?.lastOpened ?? 0) - (this.meta[a.id]?.lastOpened ?? 0) || order.indexOf(a.id) - order.indexOf(b.id));
    return sorted.slice(0, limit).map((w) => ({ label: w.name, click: () => void this.open(w.id, {}) }));
  }
  private lastKnown: WorkspaceInfo[] = [];
  /** Keeps the menus' list in step with the registry. */
  async refreshKnown() {
    await this.load();
    this.lastKnown = await this.o.registry().known();
    this.updateDock();
  }
  updateDock() {
    if (process.platform !== "darwin" || !app.dock) return;
    app.dock.setMenu(
      Menu.buildFromTemplate([
        ...this.recentItems(8),
        ...(this.lastKnown.length ? [{ type: "separator" as const }] : []),
        { label: "Workspaces…", click: () => this.show() },
        { label: "New Workspace…", click: () => this.request("new") },
      ]),
    );
  }
  /** Shows the window and asks it to start something (the create sheet …). */
  request(command: string, id?: string) {
    const window = this.show();
    const send = () => window.webContents.send("launcher-command", { command, id });
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", () => setTimeout(send, 150));
    else send();
  }

  async open(id: string, options: OpenOptions) {
    const files = this.pendingFiles.splice(0);
    await this.o.openWorkspace(id, { ...options, files: [...(options.files ?? []), ...files] });
    // Like Xcode's welcome window: it steps aside once a workspace is open, unless asked to stay.
    if (!options.newWindow) this.close();
  }

  private async add(root: string, name = basename(root)) {
    const added = await this.o.registry().add(root, name);
    await this.o.workspacesChanged();
    await this.refreshKnown();
    this.changed();
    return added;
  }
  private dialogParent() {
    return this.isOpen() ? this.window! : undefined;
  }
  private async chooseFolder(title: string, defaultPath?: string, buttonLabel = "Choose") {
    const options = { title, defaultPath, buttonLabel, properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
    const parent = this.dialogParent();
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }
  /** What is at `path`: nothing, an empty folder, a Key workspace, a folder with files, or a file. */
  private async inspect(path: string) {
    const target = resolve(path);
    const info = await stat(target).catch(() => undefined);
    if (!info) return { kind: "none" as const, path: target };
    if (!info.isDirectory()) return { kind: "file" as const, path: target };
    if (await exists(join(target, ".key"))) return { kind: "workspace" as const, path: target };
    const entries = (await readdir(target).catch(() => [])).filter((n) => !n.startsWith("."));
    return { kind: entries.length ? ("folder" as const) : ("empty" as const), path: target };
  }
  private async confirm(message: string, detail: string, button: string) {
    const options = { type: "warning" as const, message, detail, buttons: [button, "Cancel"], defaultId: 0, cancelId: 1 };
    const parent = this.dialogParent();
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return result.response === 0;
  }
  private find(id: string) {
    const w = this.lastKnown.find((k) => k.id === id);
    if (!w) throw Error("This workspace is no longer in the list");
    return w;
  }

  /** Actions of the window's renderer (`window.key.launcher`). */
  async handle(action: string, p: any): Promise<unknown> {
    if (action !== "state") await this.refreshKnown();
    switch (action) {
      case "state":
        await this.refreshKnown();
        return this.state();
      case "open":
        if (typeof p?.id !== "string") throw Error("Choose a workspace");
        if (!(await exists(this.find(p.id).root))) throw Error("The workspace’s folder is missing. Locate it first.");
        return this.open(p.id, { newWindow: p.newWindow === true });
      case "inspect":
        return this.inspect(String(p?.path ?? ""));
      case "choose-folder":
        return this.chooseFolder(p?.title ?? "Choose a location", p?.defaultPath ? String(p.defaultPath) : undefined);
      case "create": {
        const name = String(p?.name ?? "").trim();
        if (!name) throw Error("Enter a name");
        const found = await this.inspect(String(p?.path ?? ""));
        if (found.kind === "file") throw Error("A file has that name. Choose another location.");
        if (found.kind === "folder" && p?.adopt !== true) throw Error("This folder already has files in it.");
        const added = await this.add(found.path, name);
        if (p?.icon || p?.color) await this.o.registry().setAppearance(added.id, String(p.icon ?? ""), String(p.color ?? "#64748b")).catch(() => undefined);
        await this.o.workspacesChanged();
        const start = p?.start;
        await this.open(added.id, { command: start === "zotero" ? "import-zotero" : start === "files" ? "add-files" : undefined });
        return added;
      }
      case "add-folder": {
        const root = typeof p?.path === "string" ? p.path : await this.chooseFolder("Open a folder as a workspace", undefined, "Open");
        if (!root) return null;
        const found = await this.inspect(root);
        if (found.kind === "file" || found.kind === "none") throw Error("Choose a folder");
        const added = await this.add(found.path);
        if (p?.open !== false) await this.open(added.id, {});
        return added;
      }
      case "import-zotero": {
        const workspace = await this.o.zoteroWorkspace();
        await this.o.workspacesChanged();
        await this.open(workspace.id, { command: "import-zotero" });
        return workspace;
      }
      case "rename": {
        const renamed = await this.o.registry().rename(String(p?.id), String(p?.name ?? ""));
        await this.o.workspacesChanged();
        await this.refreshKnown();
        this.changed();
        return renamed;
      }
      case "appearance": {
        const updated = await this.o.registry().setAppearance(String(p?.id), String(p?.icon ?? ""), String(p?.color ?? ""));
        await this.o.workspacesChanged();
        this.changed();
        return updated;
      }
      case "remove": {
        const w = this.find(String(p?.id));
        if (this.o.openWorkspaces().includes(w.id)) throw Error(`Close “${w.name}” first`);
        if (p?.confirmed !== true && !(await this.confirm(`Remove “${w.name}” from the list?`, `The folder ${tilde(w.root)} and everything in it stay on this Mac. Open it again any time with Open Folder as Workspace.`, "Remove")))
          return false;
        await this.o.registry().forget(w.id);
        delete this.meta[w.id];
        await this.save().catch(() => undefined);
        await this.o.workspacesChanged();
        await this.refreshKnown();
        this.changed();
        return true;
      }
      case "reveal": {
        const w = this.find(String(p?.id));
        if (await exists(w.root)) shell.showItemInFolder(w.root);
        else throw Error("The folder is missing");
        return;
      }
      case "locate": {
        const w = this.find(String(p?.id));
        const root = typeof p?.path === "string" ? p.path : await this.chooseFolder(`Locate “${w.name}”`, dirname(w.root), "Choose");
        if (!root) return null;
        const moved = await this.o.registry().relocate(w.id, root);
        await this.o.workspacesChanged();
        await this.refreshKnown();
        this.changed();
        return moved;
      }
      case "move": {
        const w = this.find(String(p?.id));
        if (this.o.openWorkspaces().includes(w.id)) throw Error(`Close “${w.name}” before moving it`);
        const parent = typeof p?.path === "string" ? p.path : await this.chooseFolder(`Move “${w.name}” to…`, dirname(w.root), "Move Here");
        if (!parent) return null;
        const target = join(resolve(parent), basename(w.root));
        if (target === w.root) return null;
        if (await exists(target)) throw Error(`${tilde(parent)} already has a “${basename(w.root)}”`);
        const moved = await this.o.registry().relocate(w.id, target, moveFolder);
        await this.o.workspacesChanged();
        await this.refreshKnown();
        this.changed();
        return moved;
      }
      case "context-menu":
        return this.contextMenu(String(p?.id));
      case "settings": {
        const patch: { openAtLaunch?: OpenAtLaunch; theme?: Theme } = {};
        if (p?.openAtLaunch) patch.openAtLaunch = p.openAtLaunch;
        if (p?.theme) patch.theme = p.theme;
        await this.o.settings().update(patch);
        this.changed();
        return;
      }
      case "acknowledgements": {
        const notices = (await this.o.info()).notices;
        if (!notices) throw Error("This build has no acknowledgements file");
        const error = await shell.openPath(notices);
        if (error) throw Error(error);
        return;
      }
      case "discard-files":
        this.pendingFiles = [];
        this.changed();
        return;
    }
    throw Error("Unknown launcher action");
  }

  /** The row's menu, native like Finder's. */
  private contextMenu(id: string) {
    const w = this.find(id);
    const open = this.o.openWorkspaces().includes(id);
    return new Promise<void>((done) => {
      const run = (fn: () => Promise<unknown>) => () => void fn().catch((e) => this.window?.webContents.send("launcher-command", { command: "error", message: String(e?.message ?? e) }));
      Menu.buildFromTemplate([
        { label: open ? "Show Window" : "Open", click: run(() => this.handle("open", { id })) },
        { label: "Open in New Window", enabled: !open, click: run(() => this.handle("open", { id, newWindow: true })) },
        { type: "separator" },
        { label: "Show in Finder", click: run(() => this.handle("reveal", { id })) },
        { type: "separator" },
        { label: "Rename…", click: () => this.request("rename", id) },
        { label: "Customise Icon and Colour…", click: () => this.request("appearance", id) },
        { label: "Move…", enabled: !open, click: run(() => this.handle("move", { id })) },
        { type: "separator" },
        { label: "Remove from List…", enabled: !open, click: run(() => this.handle("remove", { id })) },
      ]).popup({ window: this.window, callback: () => done() });
      void w;
    });
  }

  /** IPC for the window (and "show" for workspace windows' "All workspaces…"). */
  serve() {
    ipcMain.handle("key:launcher", async (event, action: string, payload: unknown) => {
      if (action === "show") {
        this.show();
        return;
      }
      if (!this.isOpen() || event.sender !== this.window!.webContents) throw Error("Only the workspaces window can do this");
      return this.handle(action, payload);
    });
  }

  /** The app menu while the workspaces window is the only one. */
  menu(base: { editMenu: MenuItemConstructorOptions; openSettings: () => void }): MenuItemConstructorOptions[] {
    return [
      {
        label: "Key",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => this.request("settings") },
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
          { label: "New Workspace…", accelerator: "CmdOrCtrl+N", click: () => this.request("new") },
          { label: "Open Folder as Workspace…", accelerator: "CmdOrCtrl+O", click: () => this.request("add-folder") },
          { label: "Open Workspace", submenu: this.openWorkspaceMenu() },
          { type: "separator" },
          { label: "Close Window", accelerator: "CmdOrCtrl+W", role: "close" },
        ],
      },
      base.editMenu,
      this.windowMenu(),
    ];
  }
  openWorkspaceMenu(): MenuItemConstructorOptions[] {
    const items = this.recentItems(12);
    return items.length ? items : [{ label: "No workspaces", enabled: false }];
  }
  windowMenu(): MenuItemConstructorOptions {
    return {
      label: "Window",
      role: "windowMenu",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { label: "Workspaces", accelerator: "CmdOrCtrl+Shift+0", click: () => this.show() },
        { type: "separator" },
        { role: "front" },
      ],
    };
  }
}
