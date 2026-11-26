// A workspace's own settings, kept in its library by the host (workspace_settings.rs): the
// citation style and lookups it may take from Key Settings instead, and how sources are added.
import type { Invoke } from "./library-api";

export type AddMode = "ask" | "origin" | "library";
export interface WorkspaceSettingsState {
  /** What the workspace set itself; null follows the app default. */
  own: { citationStyle: string | null; citationLocale: string | null; lookups: boolean | null; findPdfOnAdd: boolean | null; addFromSource: AddMode | null };
  /** Key Settings' defaults. */
  app: { citationStyle: string; citationLocale: string; lookups: boolean };
  effective: { citationStyle: string; citationLocale: string; lookups: boolean; findPdfOnAdd: boolean; addFromSource: AddMode };
}
export type WorkspaceSettingsPatch = Partial<{ citationStyle: string | null; citationLocale: string | null; lookups: boolean | null; findPdfOnAdd: boolean; addFromSource: AddMode }>;

export const workspaceSettings = (invoke: Invoke, workspaceId: string, patch?: WorkspaceSettingsPatch) =>
  invoke<WorkspaceSettingsState>("store_workspace_settings", patch ? { patch } : {}, workspaceId);
