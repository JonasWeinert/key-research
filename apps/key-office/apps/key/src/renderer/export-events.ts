// Opening the Export highlights and Rename files sheets from anywhere (menus, toolbars);
// markdown-export.tsx and file-names.tsx mount them.
export interface HighlightExportRequest {
  workspaceId?: string;
  ids?: string[];
  collectionId?: string;
  title?: string;
}
export const openHighlightExport = (request: HighlightExportRequest) => window.dispatchEvent(new CustomEvent("key:open-highlight-export", { detail: request }));

export interface FileRenameRequest {
  workspaceId?: string;
  ids: string[];
}
export const openFileRename = (request: FileRenameRequest) => window.dispatchEvent(new CustomEvent("key:open-file-rename", { detail: request }));
