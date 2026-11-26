// The two settings windows' sections, kept together so each window's search can point at
// the other's ("Found in Workspace Settings"), and the one way to open either from anywhere.
//
//   Key Settings (⌘,)          — Key on this Mac: every workspace, stored in app-settings.json,
//                                 the secret store or the browser profile.
//   Workspace Settings (⌥⌘,)   — one workspace, stored in that workspace's own library.
import type { IconName } from "./icons";

export type SettingsSection = "general" | "workspaces" | "citations" | "search" | "privacy" | "web" | "services" | "ai" | "about";
export type WorkspaceSettingsSection = "workspace" | "zotero" | "indexing" | "citations" | "markdown" | "files" | "feeds";

export interface SectionInfo<Id extends string = string> {
  id: Id;
  label: string;
  icon: IconName;
  /** Words a settings search finds this section by, besides its label. */
  keywords: string;
}

/** Key Settings' sidebar, in groups. */
export const APP_GROUPS: SectionInfo<SettingsSection>[][] = [
  [{ id: "general", label: "General", icon: "gear", keywords: "appearance theme light dark automatic welcome tour keyboard shortcuts startup when key opens launch reopen windows" }],
  [
    { id: "workspaces", label: "Workspaces", icon: "books", keywords: "library libraries folder add workspace list open" },
    { id: "citations", label: "Citations", icon: "quote", keywords: "default citation style csl apa chicago mla harvard ieee vancouver bibliography reference locale language install styles quick copy" },
    { id: "search", label: "Search & indexing", icon: "search", keywords: "model models embedding download hugging face layout analysis pdf model folder" },
  ],
  [
    { id: "privacy", label: "Privacy & network", icon: "lock", keywords: "privacy network leaves mac openalex crossref automatic lookups metadata default contact email" },
    { id: "web", label: "Web & browser", icon: "globe", keywords: "web search providers semantic scholar crossref browsing data cookies library access proxy ezproxy openathens" },
    { id: "services", label: "Services & API keys", icon: "key", keywords: "api key keychain serpapi openalex google scholar usage integrations" },
    { id: "ai", label: "AI assistant", icon: "sparkle", keywords: "provider openai ollama lm studio endpoint model" },
  ],
  [{ id: "about", label: "About Key", icon: "info", keywords: "version data folder electron licences licenses acknowledgements" }],
];

/** Workspace Settings' sidebar, in groups. */
export const WORKSPACE_GROUPS: SectionInfo<WorkspaceSettingsSection>[][] = [
  [{ id: "workspace", label: "General", icon: "folder", keywords: "name rename icon colour color location folder finder adding sources collections tags organise remove danger" }],
  [
    { id: "zotero", label: "Zotero", icon: "zotero", keywords: "import sync plugin conflicts" },
    { id: "indexing", label: "Indexing & lookups", icon: "search", keywords: "index pause retry analyse again openalex metadata automatic lookups doi older sources retractions find pdfs automatically duplicates people" },
  ],
  [
    { id: "citations", label: "Citations & export", icon: "upload", keywords: "citation style override bibtex biblatex ris csl json csv citekey citation keys pattern auto-export overleaf latex pandoc" },
    { id: "markdown", label: "Markdown export", icon: "fileMarkdown", keywords: "obsidian logseq vault highlights annotations notes template front matter yaml sync pandoc" },
    { id: "files", label: "Files", icon: "doc", keywords: "file names rename rules template mirror folder hard links finder devonthink ipad drag" },
    { id: "feeds", label: "Feeds & alerts", icon: "feed", keywords: "inbox rss atom opml journal table of contents arxiv blog follow author alert citations subscriptions" },
  ],
];

export const APP_SECTIONS = APP_GROUPS.flat();
export const WORKSPACE_SECTIONS = WORKSPACE_GROUPS.flat();

export const matches = (s: SectionInfo, query: string) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${s.label} ${s.keywords}`.toLowerCase();
  return words.every((w) => hay.includes(w));
};

export type SettingsTarget = { window: "app"; section: SettingsSection } | { window: "workspace"; section: WorkspaceSettingsSection; workspaceId?: string };

/** Section ids from before the split (and from either window) to where they live now. */
const LEGACY: Record<string, SettingsTarget> = {
  libraries: { window: "workspace", section: "workspace" },
  export: { window: "workspace", section: "citations" },
  zotero: { window: "workspace", section: "zotero" },
  markdown: { window: "workspace", section: "markdown" },
  files: { window: "workspace", section: "files" },
  feeds: { window: "workspace", section: "feeds" },
  indexing: { window: "workspace", section: "indexing" },
  workspace: { window: "workspace", section: "workspace" },
};

/** Where a `key:open-settings-section` request goes: a section id (old or new), or a target. */
export function settingsTarget(detail: unknown): SettingsTarget {
  if (detail && typeof detail === "object" && "section" in detail) {
    const d = detail as { window?: string; section: string; workspaceId?: string };
    if (d.window === "workspace" && WORKSPACE_SECTIONS.some((s) => s.id === d.section)) return { window: "workspace", section: d.section as WorkspaceSettingsSection, workspaceId: d.workspaceId };
    if (d.window !== "workspace" && APP_SECTIONS.some((s) => s.id === d.section)) return { window: "app", section: d.section as SettingsSection };
    return { ...(LEGACY[d.section] ?? { window: "app", section: "general" }), ...(d.workspaceId ? { workspaceId: d.workspaceId } : {}) } as SettingsTarget;
  }
  const id = typeof detail === "string" ? detail : "general";
  if (LEGACY[id]) return LEGACY[id];
  if (APP_SECTIONS.some((s) => s.id === id)) return { window: "app", section: id as SettingsSection };
  return { window: "app", section: "general" };
}

/** Opens Key Settings at a section. */
export const openKeySettings = (section: SettingsSection = "general") =>
  window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: { window: "app", section } }));

/** Opens Workspace Settings at a section, for the window's workspace unless one is given. */
export const openWorkspaceSettings = (section: WorkspaceSettingsSection = "workspace", workspaceId?: string) =>
  window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: { window: "workspace", section, workspaceId } }));
