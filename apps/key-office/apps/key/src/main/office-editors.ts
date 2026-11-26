/** GenOffice's editors, loaded on demand: their main-process code (Docs, Sheets, Slides,
 * Markdown, HTML and the document engines) is about two thirds of the main bundle and most
 * sessions never open an Office tab. The implementation lives in office-impl.ts; this facade
 * keeps what the shell sets before it loads and hands it over when it does. */
import type { BrowserWindow, WebContentsView } from "electron";
import { registerHtmlSchemes } from "../../../html/src/main/preview-protocol";
import type { OfficeCallbacks, OfficeKind, OfficeRecord } from "./office-impl";
export type { OfficeCallbacks, OfficeKind, OfficeRecord } from "./office-impl";

// Electron requires scheme privileges to be declared before app.whenReady().
registerHtmlSchemes();

type Impl = typeof import("./office-impl");
let impl: Impl | null = null;
let loading: Promise<Impl> | null = null;
let configuration: { window: BrowserWindow; hooks: OfficeCallbacks } | null = null;
let shellWindow: BrowserWindow | null = null;

export const officeLoaded = () => !!impl;

/** Loads the editors (once); resolves when Office views can be created. */
export function loadOffice(): Promise<Impl> {
  loading ??= import("./office-impl").then((m) => {
    if (configuration) m.configureOfficeEditors(configuration.window, configuration.hooks);
    if (shellWindow) m.setOfficeShellWindow(shellWindow);
    impl = m;
    return m;
  });
  return loading;
}

export function configureOfficeEditors(window: BrowserWindow, hooks: OfficeCallbacks): void {
  configuration = { window, hooks };
  impl?.configureOfficeEditors(window, hooks);
}

export function setOfficeShellWindow(window: BrowserWindow): void {
  shellWindow = window;
  impl?.setOfficeShellWindow(window);
}

/** Only once loaded (see `officeLoaded`): the shell creates Office views after `loadOffice`. */
export function createOfficeView(kind: OfficeKind, path?: string, options?: { newBlank?: boolean }): WebContentsView {
  if (!impl) throw new Error("Office editors are still loading");
  return impl.createOfficeView(kind, path, options);
}

export function activateOfficeView(kind: OfficeKind | null, view: WebContentsView | null): void {
  if (impl) impl.activateOfficeView(kind, view);
  // No editor can be active before they load; the app menu is the base one.
  else configuration?.hooks.installBaseMenu?.();
}

export function canCloseOfficeView(record: OfficeRecord): Promise<boolean> {
  return impl ? impl.canCloseOfficeView(record) : Promise.resolve(true);
}

export function closeOfficeView(record: OfficeRecord, approved = false): Promise<boolean> {
  return impl ? impl.closeOfficeView(record, approved) : Promise.resolve(true);
}

export function saveOfficeTextView(record: OfficeRecord, saveAs = false): Promise<boolean> {
  return impl ? impl.saveOfficeTextView(record, saveAs) : Promise.resolve(false);
}
