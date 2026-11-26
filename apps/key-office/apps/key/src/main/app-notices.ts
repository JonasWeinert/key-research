// Errors never stop the app with a modal box. Uncaught exceptions, unhandled rejections,
// crashed renderers and child processes, and `dialog.showErrorBox` all become quiet notices
// in the shell's status bar, and lines in userData/logs/key.log (and the console).
// Under smoke and test runs (KEY_SKIP_ONBOARDING=1 or KEY_TEST=1) no native modal dialog can
// block either: message boxes resolve to their cancel (or default) button, open/save panels
// to "canceled", and each is logged. Smokes that stub `dialog.*` themselves still win.
import { app, dialog, ipcMain, type WebContents } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AppNotice {
  id: number;
  level: "error" | "warning" | "info";
  message: string;
  detail?: string;
  at: number;
}

export const isTestRun = () => process.env.KEY_SKIP_ONBOARDING === "1" || Boolean(process.env.KEY_TEST);

let logDir: string | undefined;
function logFile() {
  if (!logDir) {
    try {
      logDir = join(app.getPath("userData"), "logs");
      mkdirSync(logDir, { recursive: true });
    } catch {
      return undefined;
    }
  }
  return join(logDir, "key.log");
}
export function logLine(level: string, message: string) {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  const file = logFile();
  try {
    if (file) appendFileSync(file, line);
  } catch {}
}

const recent: AppNotice[] = [];
let nextId = 0;
let targets: () => WebContents[] = () => [];
/** Errors that repeat (a failing poll) show once a minute, not once each. */
const lastShown = new Map<string, number>();

const describe = (error: unknown) =>
  error instanceof Error ? { message: error.message || error.name, detail: error.stack } : { message: String(error) };

/** Logs and shows a notice in every shell window. */
export function notify(level: AppNotice["level"], message: string, detail?: string) {
  logLine(level, detail ? `${message}\n${detail}` : message);
  (level === "error" ? console.error : console.warn)(`[key] ${message}`);
  const now = Date.now();
  if (now - (lastShown.get(message) ?? 0) < 60_000) return;
  lastShown.set(message, now);
  const notice: AppNotice = { id: ++nextId, level, message: message.slice(0, 400), detail: detail?.slice(0, 4000), at: now };
  recent.push(notice);
  recent.splice(0, Math.max(0, recent.length - 20));
  for (const contents of targets()) if (!contents.isDestroyed()) contents.send("app-notice", notice);
}
export function reportError(context: string, error: unknown) {
  const { message, detail } = describe(error);
  notify("error", `${context}: ${message}`, detail);
}

let installed = false;
/** Call first thing in main: a listener for uncaughtException also keeps Electron's own
 * "A JavaScript error occurred in the main process" box away. */
export function installErrorHandlers() {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (error) => reportError("Unexpected error", error));
  process.on("unhandledRejection", (reason) => reportError("Unhandled error", reason));
  app.on("render-process-gone", (_event, contents, details) => {
    if (details.reason === "clean-exit") return;
    let url = "";
    try {
      url = contents.getURL();
    } catch {}
    notify(details.reason === "killed" ? "warning" : "error", `A view stopped (${details.reason})`, `${url} exit code ${details.exitCode}`);
  });
  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || details.reason === "killed") return;
    notify("warning", `${details.name || details.type} process stopped (${details.reason})`, `exit code ${details.exitCode}`);
  });
  guardDialogs();
}

const original = {
  showErrorBox: dialog.showErrorBox.bind(dialog),
};
/** For when nothing else can show it (no window yet): real users still get the box. */
export function fatal(title: string, error: unknown) {
  reportError(title, error);
  if (!isTestRun()) original.showErrorBox(title, String(error));
}

type BoxOptions = Electron.MessageBoxOptions;
const safeResponse = (options: BoxOptions | undefined) => {
  const response = options?.cancelId ?? options?.defaultId ?? 0;
  return { response, checkboxChecked: Boolean(options?.checkboxChecked) };
};
const boxOptions = (args: unknown[]) => (args.find((a) => a && typeof a === "object" && "message" in (a as object)) as BoxOptions | undefined);

function guardDialogs() {
  dialog.showErrorBox = (title: string, content: string) => notify("error", title, content);
  const test = isTestRun();
  const showMessageBox = dialog.showMessageBox.bind(dialog) as (...args: unknown[]) => Promise<Electron.MessageBoxReturnValue>;
  const showMessageBoxSync = dialog.showMessageBoxSync.bind(dialog) as (...args: unknown[]) => number;
  // An error message box with nothing to choose is only a report: show it as a notice.
  const reportOnly = (options?: BoxOptions) => options?.type === "error" && (options.buttons?.length ?? 0) <= 1;
  dialog.showMessageBox = ((...args: unknown[]) => {
    const options = boxOptions(args);
    // A page's alert()/confirm() (Electron shows those through here, with an abort signal):
    // a test driver (Playwright) answers it over the devtools protocol, which aborts this
    // box. Give it a moment, then cancel, so nothing waits on a box nobody sees.
    if (test && options?.signal) {
      const signal = options.signal;
      return new Promise<Electron.MessageBoxReturnValue>((resolve) => {
        const timer = setTimeout(() => {
          logLine("dialog", `auto-canceled the page dialog "${options.message}"`);
          resolve(safeResponse(options));
        }, 5000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(safeResponse(options));
        });
      });
    }
    if (test || reportOnly(options)) {
      if (reportOnly(options)) notify("error", options!.message, options!.detail);
      else logLine("dialog", `auto-answered "${options?.message}" with button ${safeResponse(options).response}`);
      return Promise.resolve(safeResponse(options));
    }
    return showMessageBox(...args);
  }) as typeof dialog.showMessageBox;
  dialog.showMessageBoxSync = ((...args: unknown[]) => {
    const options = boxOptions(args);
    if (test || reportOnly(options)) {
      if (reportOnly(options)) notify("error", options!.message, options!.detail);
      else logLine("dialog", `auto-answered "${options?.message}" with button ${safeResponse(options).response}`);
      return safeResponse(options).response;
    }
    return showMessageBoxSync(...args);
  }) as typeof dialog.showMessageBoxSync;
  if (!test) return;
  dialog.showOpenDialog = (async () => {
    logLine("dialog", "auto-canceled an open panel");
    return { canceled: true, filePaths: [] };
  }) as typeof dialog.showOpenDialog;
  dialog.showOpenDialogSync = (() => {
    logLine("dialog", "auto-canceled an open panel");
    return undefined;
  }) as typeof dialog.showOpenDialogSync;
  dialog.showSaveDialog = (async () => {
    logLine("dialog", "auto-canceled a save panel");
    return { canceled: true, filePath: "" };
  }) as typeof dialog.showSaveDialog;
  dialog.showSaveDialogSync = (() => {
    logLine("dialog", "auto-canceled a save panel");
    return "";
  }) as typeof dialog.showSaveDialogSync;
}

/** Shell windows get notices as they happen and can ask for the recent ones on load. */
export function serveNotices(shells: () => WebContents[]) {
  targets = shells;
  ipcMain.handle("key:notices", () => recent);
  // Uncaught errors in a page (shell or view): logged only, the page shows its own failures.
  ipcMain.on("key:report-error", (event, value: { message?: unknown; detail?: unknown }) => {
    let url = "";
    try {
      url = event.sender.getURL();
    } catch {}
    logLine("renderer", `${String(value?.message ?? "Error").slice(0, 400)} (${url})${value?.detail ? `\n${String(value.detail).slice(0, 4000)}` : ""}`);
  });
}
