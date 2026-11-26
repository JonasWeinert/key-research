/** The Zotero library Key imported into: the workspace in a folder named Zotero. */
export const zoteroWorkspaceOf = <W extends { root: string }>(workspaces: W[]) => workspaces.find((w) => /\/Zotero$/.test(w.root));
