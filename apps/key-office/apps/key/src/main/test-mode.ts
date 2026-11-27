// Test mode (KEY_TEST_MODE=1, set by scripts/lib/launch.cjs for every smoke): the app runs
// as it does for a person, but nothing of it reaches the person at the keyboard, and nothing
// they do reaches it.
// - Windows are never shown on screen and never take OS focus; the app is not in the Dock or
//   Cmd-Tab. Visibility and focus are virtual: show/focus/hide/blur/minimize/full screen
//   update a model the app's own checks read (isVisible, isFocused, getFocusedWindow) and
//   emit the same window and app events, so the app behaves as with a frontmost window.
// - Pages render and run timers and animations at full rate (no background throttling).
// - The clipboard is per run and in memory, for main (`clipboard`) and pages (copy/cut/paste,
//   navigator.clipboard; preload/test-clipboard.ts).
// - Native context menus, global shortcuts, OS drags, opening other apps (shell.*) and the
//   Dock are recorded in `globalThis.__keyTest` instead of happening.
// - Chromium keeps no secrets in the login Keychain (--use-mock-keychain).
// Must be imported first in main/index.ts: it sets Chromium switches before the app is ready.
import { app, BaseWindow, BrowserWindow, Menu, clipboard, globalShortcut, ipcMain, nativeImage, session, shell, type NativeImage } from "electron";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export const testMode = process.env.KEY_TEST_MODE === "1";

type Clip = { types: Record<string, string>; image?: NativeImage };
interface TestState {
  /** What a native menu would have shown: the latest last. `pick(label)` runs an item. */
  menus: { labels: string[]; pick(label: string): boolean }[];
  /** URLs and paths the app asked the OS to open or reveal. */
  opened: { kind: string; target: string }[];
  shortcuts: string[];
  drags: string[][];
  clipboard: Clip;
  /** The app losing the foreground (as when the person switches apps): dismisses overlays. */
  resignActive(): void;
}

const state: TestState = {
  menus: [],
  opened: [],
  shortcuts: [],
  drags: [],
  clipboard: { types: {} },
  resignActive: () => app.emit("did-resign-active"),
};

/** Extra BrowserWindow options in test mode: created hidden (shown virtually after). */
export const testWindowOptions: { show?: boolean } = testMode ? { show: false } : {};

function note(line: string) {
  const dir = process.env.KEY_TEST_RUN_DIR;
  if (!dir) return;
  try {
    appendFileSync(join(dir, "test-mode.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

// ── Virtual windows ──
const shown = new WeakSet<BaseWindow>();
const minimized = new WeakSet<BaseWindow>();
const fullScreen = new WeakSet<BaseWindow>();
let focused: BaseWindow | undefined;
const alive = (w: BaseWindow | undefined) => !!w && !w.isDestroyed();

function setFocus(next: BaseWindow | undefined) {
  if (focused === next) return;
  const previous = focused;
  focused = next;
  // As from the OS: the events come after the call (a window shown as it is created has its
  // listeners by then).
  setImmediate(() => focusEvents(previous, next));
}
function focusEvents(previous: BaseWindow | undefined, next: BaseWindow | undefined) {
  if (alive(previous)) {
    previous!.emit("blur");
    if (previous instanceof BrowserWindow) app.emit("browser-window-blur", {}, previous);
  }
  if (alive(next)) {
    next!.emit("focus");
    if (next instanceof BrowserWindow) app.emit("browser-window-focus", {}, next);
  }
}
/** The front-most other shown window, as macOS picks one when a window goes away. */
function nextWindow(except: BaseWindow) {
  return BaseWindow.getAllWindows().find((w) => w !== except && alive(w) && shown.has(w) && !minimized.has(w));
}

function installWindows() {
  const proto = BaseWindow.prototype as unknown as Record<string, (...args: any[]) => any>;
  const show = function (this: BaseWindow, focus: boolean) {
    const was = shown.has(this);
    shown.add(this);
    minimized.delete(this);
    if (!was) this.emit("show");
    if (focus) setFocus(this);
  };
  proto.show = function (this: BaseWindow) {
    show.call(this, true);
  };
  proto.showInactive = function (this: BaseWindow) {
    show.call(this, false);
  };
  proto.focus = function (this: BaseWindow) {
    show.call(this, true);
  };
  proto.hide = function (this: BaseWindow) {
    if (!shown.delete(this)) return;
    this.emit("hide");
    if (focused === this) setFocus(nextWindow(this));
  };
  proto.blur = function (this: BaseWindow) {
    if (focused === this) setFocus(undefined);
  };
  proto.isVisible = function (this: BaseWindow) {
    return alive(this) && shown.has(this) && !minimized.has(this);
  };
  proto.isFocused = function (this: BaseWindow) {
    return alive(this) && focused === this;
  };
  proto.minimize = function (this: BaseWindow) {
    if (minimized.has(this)) return;
    minimized.add(this);
    this.emit("minimize");
    if (focused === this) setFocus(nextWindow(this));
  };
  proto.restore = function (this: BaseWindow) {
    if (!minimized.delete(this)) return;
    this.emit("restore");
    show.call(this, true);
  };
  proto.isMinimized = function (this: BaseWindow) {
    return minimized.has(this);
  };
  // Native full screen would open a Space on the person's screen: the events alone.
  proto.setFullScreen = function (this: BaseWindow, flag: boolean) {
    if (fullScreen.has(this) === !!flag) return;
    if (flag) fullScreen.add(this);
    else fullScreen.delete(this);
    this.emit(flag ? "enter-full-screen" : "leave-full-screen");
  };
  proto.isFullScreen = function (this: BaseWindow) {
    return fullScreen.has(this);
  };
  proto.setSimpleFullScreen = proto.setFullScreen;
  proto.isSimpleFullScreen = proto.isFullScreen;
  proto.moveTop = function () {};
  proto.flashFrame = function () {};
  proto.setAlwaysOnTop = function () {};
  (BrowserWindow as unknown as { getFocusedWindow(): BrowserWindow | null }).getFocusedWindow = () =>
    alive(focused) && focused instanceof BrowserWindow ? focused : null;
  app.on("browser-window-created", (_event, window) => {
    window.once("closed", () => {
      if (focused === window) setFocus(nextWindow(window));
    });
  });
  // Pages run at full rate although their window is never on screen.
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
}

// ── The OS: Dock, activation, shortcuts, menus, other apps ──
function installOs() {
  if (process.platform === "darwin") {
    const background = () => {
      try {
        app.setActivationPolicy("accessory");
        app.dock?.hide();
      } catch {}
    };
    background();
    void app.whenReady().then(background);
    if (app.dock) {
      app.dock.show = async () => {};
      app.dock.bounce = () => 0;
      app.dock.setBadge = () => {};
    }
  }
  app.focus = () => {};
  globalShortcut.register = (accelerator: string) => (state.shortcuts.push(accelerator), true);
  globalShortcut.registerAll = (accelerators: string[]) => void state.shortcuts.push(...accelerators);
  Menu.prototype.popup = function (this: Menu, options?: Electron.PopupOptions) {
    const items = this.items;
    state.menus.push({
      labels: items.map((i) => i.label).filter(Boolean),
      pick: (label) => {
        const item = items.find((i) => i.label === label);
        if (!item || !item.enabled) return false;
        item.click(undefined, undefined as never, undefined as never);
        return true;
      },
    });
    note(`menu: ${items.map((i) => i.label).filter(Boolean).join(" | ")}`);
    // The menu "closes" at once; a test can still pick an item afterwards.
    if (options?.callback) setImmediate(options.callback);
  };
  const record = (kind: string) => async (target: string) => {
    state.opened.push({ kind, target: String(target) });
    note(`${kind}: ${target}`);
    return "";
  };
  shell.openExternal = record("openExternal") as unknown as typeof shell.openExternal;
  shell.openPath = record("openPath") as typeof shell.openPath;
  shell.showItemInFolder = (path: string) => void record("showItemInFolder")(path);
  shell.beep = () => {};
  app.on("web-contents-created", (_event, contents) => {
    contents.startDrag = (item: Electron.Item) => void state.drags.push(item.files ?? [item.file]);
  });
}

// ── Clipboard ──
const MIME = { text: "text/plain", html: "text/html", rtf: "text/rtf" } as const;
function legacy() {
  // The shape smokes read since KEY_TEST_CLIPBOARD (smoke-citations).
  const t = state.clipboard.types;
  (globalThis as { __keyClipboard?: unknown }).__keyClipboard = { text: t[MIME.text] ?? "", html: t[MIME.html] ?? "", rtf: t[MIME.rtf] ?? "" };
}
export function writeTestClipboard(types: Record<string, string>, image?: NativeImage) {
  state.clipboard = { types: { ...types }, image };
  legacy();
}
function installClipboard() {
  const c = clipboard as unknown as Record<string, unknown>;
  const types = () => state.clipboard.types;
  c.readText = () => types()[MIME.text] ?? "";
  c.writeText = (text: string) => writeTestClipboard({ [MIME.text]: String(text) });
  c.readHTML = () => types()[MIME.html] ?? "";
  c.writeHTML = (html: string) => writeTestClipboard({ [MIME.html]: String(html) });
  c.readRTF = () => types()[MIME.rtf] ?? "";
  c.writeRTF = (rtf: string) => writeTestClipboard({ [MIME.rtf]: String(rtf) });
  c.readImage = () => state.clipboard.image ?? nativeImage.createEmpty();
  c.writeImage = (image: NativeImage) => writeTestClipboard({}, image);
  c.readBookmark = () => ({ title: "", url: "" });
  c.writeBookmark = (title: string, url: string) => writeTestClipboard({ [MIME.text]: url, "text/uri-list": url, "x-title": title });
  c.readFindText = () => "";
  c.writeFindText = () => {};
  c.write = (data: { text?: string; html?: string; rtf?: string; image?: NativeImage; bookmark?: string }) => {
    const next: Record<string, string> = {};
    if (data.text !== undefined) next[MIME.text] = data.text;
    if (data.html !== undefined) next[MIME.html] = data.html;
    if (data.rtf !== undefined) next[MIME.rtf] = data.rtf;
    writeTestClipboard(next, data.image);
  };
  c.read = (format: string) => types()[format] ?? "";
  c.readBuffer = (format: string) => Buffer.from(types()[format] ?? "");
  c.writeBuffer = (format: string, buffer: Buffer) => writeTestClipboard({ ...types(), [format]: buffer.toString() });
  c.has = (format: string) => format in types();
  c.availableFormats = () => [...Object.keys(types()), ...(state.clipboard.image ? ["image/png"] : [])];
  c.clear = () => writeTestClipboard({});
  // Pages: preload/test-clipboard.ts in every session.
  ipcMain.on("key:test-clipboard-read", (event) => void (event.returnValue = types()));
  ipcMain.on("key:test-clipboard-write", (event, next: unknown) => {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries((next as Record<string, unknown>) ?? {})) if (typeof v === "string") clean[k] = v;
    writeTestClipboard(clean);
    event.returnValue = true;
  });
  const preload = join(__dirname, "../preload/test-clipboard.js");
  const add = (s: Electron.Session) => {
    try {
      s.registerPreloadScript({ type: "frame", id: "key-test-clipboard", filePath: preload });
    } catch {}
  };
  app.on("session-created", add);
  void app.whenReady().then(() => add(session.defaultSession));
}

// ── Network: scripts/lib/launch.cjs lets Chromium resolve loopback only; what a run tried to
// reach anyway goes to the run's log ("network:" lines), which the launch helper reports. ──
const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|[\w.-]+\.localhost)$/i;
function installNetwork() {
  const seen = new Set<string>();
  const watch = (s: Electron.Session) =>
    s.webRequest.onErrorOccurred({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details) => {
      let host = "";
      try {
        host = new URL(details.url).hostname;
      } catch {}
      if (!host || loopback.test(host) || details.error !== "net::ERR_NAME_NOT_RESOLVED" || seen.has(host)) return;
      seen.add(host);
      note(`network: ${host} ${details.url.slice(0, 200)}`);
    });
  app.on("session-created", watch);
  void app.whenReady().then(() => watch(session.defaultSession));
}

/** A test app whose driver died (a killed smoke, a crashed runner) quits itself: no test app
 *  outlives its run. KEY_TEST_PARENT_PID is the driver (scripts/lib/launch.cjs). */
function watchParent() {
  const parent = Number(process.env.KEY_TEST_PARENT_PID) || process.ppid;
  const timer = setInterval(() => {
    try {
      process.kill(parent, 0);
      return;
    } catch {}
    clearInterval(timer);
    note("driver gone: quitting");
    // Its hosts and helpers first, then the app itself.
    try {
      const rows = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((l) => l.trim().split(/\s+/).map(Number));
      const mine = new Set([process.pid]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const [pid, ppid] of rows)
          if (mine.has(ppid) && !mine.has(pid)) {
            mine.add(pid);
            grew = true;
          }
      }
      mine.delete(process.pid);
      for (const pid of mine) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    } catch {}
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 3000).unref();
    app.exit(0);
  }, 1000);
  timer.unref();
}

if (testMode) {
  watchParent();
  // Timers, animations and painting as for a front-most window, whatever the OS thinks.
  for (const s of ["disable-renderer-backgrounding", "disable-backgrounding-occluded-windows", "disable-background-timer-throttling", "use-mock-keychain"]) app.commandLine.appendSwitch(s);
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion,MacWebContentsOcclusion");
  installWindows();
  installOs();
  installClipboard();
  installNetwork();
  (globalThis as { __keyTest?: TestState }).__keyTest = state;
  legacy();
  note("test mode on");
}
