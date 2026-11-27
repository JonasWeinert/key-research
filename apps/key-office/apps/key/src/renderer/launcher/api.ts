// What the workspaces window reads and asks of main (main/launcher.ts).
import { plainError } from "../../shared/plain-error";
export interface LauncherWorkspace {
  id: string;
  name: string;
  root: string;
  icon?: string | null;
  color?: string | null;
  missing: boolean;
  open: boolean;
  lastOpened?: number;
  sources?: number;
  notes?: number;
}
export type OpenAtLaunch = "workspaces" | "restore" | "last";
export type Theme = "system" | "light" | "dark";
export interface LauncherState {
  workspaces: LauncherWorkspace[];
  info: { version: string; workspaceParent: string; zoteroFound: boolean; notices: string | null };
  openAtLaunch: OpenAtLaunch;
  theme: Theme;
  pendingFiles: string[];
}
export type FolderKind = "none" | "empty" | "workspace" | "folder" | "file";

type Bridge = {
  launcher: <T = unknown>(action: string, payload?: unknown) => Promise<T>;
  on: (event: string, callback: (value: unknown) => void) => () => void;
  pathForFile: (file: File) => string;
};
export const key = () => (window as unknown as { key: Bridge }).key;
export const launcher = <T = unknown,>(action: string, payload?: unknown) => key().launcher<T>(action, payload);
/** An IPC error without Electron's "Error invoking remote method …" wrapping. */
export const message = (e: unknown) => plainError(e);
export const tilde = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");
/** A path for a field that cuts it short at the start (CSS direction: rtl), kept left to right. */
export const ltr = (text: string) => `\u200e${text}\u200e`;
/** A folder name from a workspace name. */
export const folderName = (name: string) => name.trim().replace(/[/:\\]/g, "-").replace(/^\.+/, "").slice(0, 120);
export const join = (parent: string, name: string) => `${parent.replace(/\/+$/, "")}/${name}`;
export { WORKSPACE_COLORS as COLORS, WORKSPACE_ICONS as ICONS } from "../workspace-look";
