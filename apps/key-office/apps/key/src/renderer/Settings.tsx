// Settings: a window-sized sheet with a sidebar of sections in groups, like macOS System
// Settings, with a search over the sections. Styles in settings.css.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon, type IconName } from "./icons";
import { ActivityPanel, olderSources, useLibraryStatus } from "./index-activity";
import { bridge, type AppInfo, type AppSettings, type Invoke, type MergeSuggestion, type Theme, type WorkspaceSummary, type ZoteroOptions } from "./library-api";
import "./entity.css";
import "./settings.css";
import MergeReview from "./MergeReview";
import { ZoteroImport } from "./ZoteroImport";
import { ZoteroSettings } from "./ZoteroSyncSettings";
import { ADD_MODES } from "./add-from-source";
import type { Mode as ZoteroMode } from "./zotero-sheet-model";
import { ModelProgressCard, useModelProgress } from "./model-progress";
import WebSearchSettings from "./WebSearchSettings";
import BrowserSettings from "./BrowserSettings";
import ServiceKeys from "./ServiceKeys";
import CitationSettings from "./CitationSettings";
import { CitationKeySettings } from "./citation-keys";
import { MarkdownExportSettings } from "./markdown-export";
import { FileSettings } from "./file-names";
import { FeedsSettings } from "./FeedsManager";

export type SettingsSection = "general" | "libraries" | "zotero" | "citations" | "export" | "markdown" | "files" | "search" | "web" | "feeds" | "services" | "ai" | "about";
interface SectionInfo {
  id: SettingsSection;
  label: string;
  icon: IconName;
  /** Words a settings search finds this section by, besides its label. */
  keywords: string;
}
/** The sidebar, in groups. */
const GROUPS: SectionInfo[][] = [
  [{ id: "general", label: "General", icon: "gear", keywords: "appearance theme light dark automatic welcome tour keyboard shortcuts" }],
  [
    { id: "libraries", label: "Libraries", icon: "books", keywords: "workspace folder finder add library adding sources collections" },
    { id: "zotero", label: "Zotero", icon: "zotero", keywords: "import sync plugin conflicts" },
    { id: "citations", label: "Citations", icon: "quote", keywords: "citation style csl apa chicago mla harvard ieee vancouver bibliography reference locale language install quick copy" },
    { id: "export", label: "Citation keys & export", icon: "upload", keywords: "bibtex biblatex ris csl json csv citekey pattern auto-export overleaf latex pandoc" },
    { id: "markdown", label: "Markdown export", icon: "fileMarkdown", keywords: "obsidian logseq vault highlights annotations notes template front matter yaml sync pandoc" },
    { id: "files", label: "Files", icon: "folder", keywords: "file names rename rules template mirror folder hard links finder devonthink ipad drag" },
  ],
  [
    { id: "search", label: "Search & indexing", icon: "search", keywords: "model embedding index pause retry layout analysis pdf openalex email duplicates people metadata" },
    { id: "web", label: "Web & browser", icon: "globe", keywords: "web search providers semantic scholar crossref browsing data cookies library access proxy ezproxy openathens" },
    { id: "feeds", label: "Feeds & alerts", icon: "feed", keywords: "inbox rss atom opml journal table of contents arxiv blog follow author alert citations subscriptions" },
  ],
  [
    { id: "services", label: "Services & API keys", icon: "key", keywords: "api key keychain serpapi openalex google scholar usage" },
    { id: "ai", label: "AI assistant", icon: "sparkle", keywords: "provider openai ollama lm studio endpoint model" },
  ],
  [{ id: "about", label: "About Key", icon: "info", keywords: "version data folder electron" }],
];
const SECTIONS = GROUPS.flat();
const matches = (s: SectionInfo, query: string) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${s.label} ${s.keywords}`.toLowerCase();
  return words.every((w) => hay.includes(w));
};

export default function Settings({
  section: initial = "general",
  invoke,
  workspaces,
  settings,
  info,
  onSettings,
  onClose,
  onShowWelcome,
  onOpenLibrary,
  onWorkspacesChanged,
}: {
  section?: SettingsSection;
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  settings: AppSettings;
  info: AppInfo;
  onSettings: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
  onShowWelcome: () => void;
  onOpenLibrary: (workspaceId: string) => void;
  onWorkspacesChanged: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initial);
  const [query, setQuery] = useState("");
  const nav = useRef<HTMLElement>(null);
  const visible = query.trim() ? SECTIONS.filter((s) => matches(s, query)) : SECTIONS;
  // Searching moves to the first section that matches, as System Settings does.
  useEffect(() => {
    if (query.trim() && visible.length && !visible.some((s) => s.id === section)) setSection(visible[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  const step = (by: number) => {
    const list = visible.map((s) => s.id);
    const next = list[(list.indexOf(section) + by + list.length) % list.length];
    if (!next) return;
    setSection(next);
    nav.current?.querySelector<HTMLButtonElement>(`[data-section="${next}"]`)?.focus();
  };
  const current = SECTIONS.find((s) => s.id === section)!;
  return (
    <GlobalDrawer presentation="window" label="Settings" onClose={onClose}>
      <div className="kx-settings" data-modal-view={section}>
        <nav
          ref={nav}
          className="kx-settings-nav"
          aria-label="Settings sections"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              step(e.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          <label className="kx-settings-search">
            <Icon name="search" size={12} />
            <input
              type="search"
              placeholder="Search"
              aria-label="Search settings"
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  setQuery("");
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  e.stopPropagation();
                  nav.current?.querySelector<HTMLButtonElement>("button[aria-current]")?.focus();
                }
              }}
            />
          </label>
          {GROUPS.map((group, i) => {
            const shown = group.filter((s) => visible.includes(s));
            if (!shown.length) return null;
            return (
              <div className="kx-settings-nav-group" key={i}>
                {shown.map(({ id, label, icon }) => (
                  <button key={id} data-section={id} aria-current={section === id ? "page" : undefined} tabIndex={section === id ? 0 : -1} onClick={() => setSection(id)}>
                    <span className="kx-settings-glyph" data-section={id}>
                      <Icon name={icon} size={12} />
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            );
          })}
          {!visible.length && <p className="kx-settings-nav-empty">No results</p>}
        </nav>
        <div className="kx-settings-body">
          <header>
            <h1>{current.label}</h1>
            <button className="kx-sheet-close" aria-label="Close settings" onClick={onClose}>
              <Icon name="close" size={10} />
            </button>
          </header>
          <div className="kx-settings-scroll" key={section}>
            {section === "general" && <General settings={settings} onSettings={onSettings} onShowWelcome={onShowWelcome} onClose={onClose} />}
            {section === "libraries" && (
              <Libraries invoke={invoke} workspaces={workspaces} settings={settings} onSettings={onSettings} onOpenLibrary={onOpenLibrary} onChanged={onWorkspacesChanged} />
            )}
            {section === "zotero" && <Zotero invoke={invoke} workspaces={workspaces} info={info} settings={settings} onSettings={onSettings} onChanged={onWorkspacesChanged} />}
            {section === "citations" && <CitationSettings invoke={invoke} workspaceId={workspaces[0]?.id} settings={settings} onSettings={onSettings} />}
            {section === "export" && <CitationKeySettings invoke={invoke} workspaces={workspaces} />}
            {section === "markdown" && <MarkdownExportSettings invoke={invoke} workspaces={workspaces} />}
            {section === "files" && <FileSettings invoke={invoke} workspaces={workspaces} />}
            {section === "search" && <SearchSettings invoke={invoke} workspaces={workspaces} info={info} settings={settings} onSettings={onSettings} />}
            {section === "web" && (
              <>
                <WebSearchSettings invoke={invoke} settings={settings} onSettings={onSettings} />
                <BrowserSettings />
              </>
            )}
            {section === "feeds" && <FeedsSettings invoke={invoke} workspaces={workspaces} />}
            {section === "services" && <ServiceKeys invoke={invoke} />}
            {section === "ai" && <AiSettings invoke={invoke} workspaceId={workspaces[0]?.id} />}
            {section === "about" && <About info={info} />}
          </div>
        </div>
      </div>
    </GlobalDrawer>
  );
}

/** A titled, rounded group of rows. */
export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="kx-settings-group">
      {title && <h3>{title}</h3>}
      <div className="kx-settings-rows">{children}</div>
      {footer && <p className="kx-settings-footnote">{footer}</p>}
    </section>
  );
}
/** A setting: its label and a quiet line beneath. A `path` line stays on one line, cut at
 *  the end, with the whole path on hover. */
export function Row({ label, detail, children, path }: { label: ReactNode; detail?: ReactNode; children?: ReactNode; path?: boolean }) {
  return (
    <div className="kx-settings-row">
      <div>
        <span>{label}</span>
        {detail && (
          <small className={path ? "kx-settings-path" : undefined} title={path && typeof detail === "string" ? detail : undefined}>
            {detail}
          </small>
        )}
      </div>
      {children && <div className="kx-settings-control">{children}</div>}
    </div>
  );
}

const THEMES: [Theme, string, IconName][] = [
  ["system", "Automatic", "display"],
  ["light", "Light", "sun"],
  ["dark", "Dark", "moon"],
];

/** Appearance tiles, shared with onboarding. */
export function ThemePicker({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  return (
    <div className="kx-theme-picker" role="radiogroup" aria-label="Appearance">
      {THEMES.map(([id, label, icon]) => (
        <button key={id} role="radio" aria-checked={value === id} onClick={() => onChange(id)}>
          <span className="kx-theme-preview" data-theme-preview={id}>
            <span />
            <span />
          </span>
          <span>
            <Icon name={icon} size={12} />
            {label}
          </span>
        </button>
      ))}
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Search everything", "⌘⇧F"],
  ["Open quickly", "⌘P"],
  ["New tab", "⌘T"],
  ["Commands", "⌘K"],
  ["Settings", "⌘,"],
];

function General({
  settings,
  onSettings,
  onShowWelcome,
  onClose,
}: {
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
  onShowWelcome: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <Group title="Appearance" footer="Documents keep their own colours.">
        <div className="kx-settings-row kx-settings-row-wide">
          <ThemePicker value={settings.theme} onChange={(theme) => onSettings({ theme })} />
        </div>
      </Group>
      <Group title="Keyboard">
        <div className="kx-settings-row kx-settings-row-wide">
          <dl className="kx-settings-keys">
            {SHORTCUTS.map(([label, keys]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <kbd>{keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <Row label="All keyboard shortcuts">
          <button
            className="kx-settings-button"
            onClick={() => {
              onClose();
              window.dispatchEvent(new CustomEvent("key:shortcuts"));
            }}
          >
            Show all
          </button>
        </Row>
      </Group>
      <Group title="Getting started">
        <Row label="Welcome tour" detail="Set up a library, Zotero and appearance again.">
          <button className="kx-settings-button" onClick={onShowWelcome}>
            Show welcome
          </button>
        </Row>
      </Group>
    </>
  );
}

function Libraries({
  invoke,
  workspaces,
  settings,
  onSettings,
  onOpenLibrary,
  onChanged,
}: {
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
  onOpenLibrary: (workspaceId: string) => void;
  onChanged: () => void;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    for (const w of workspaces)
      void invoke<{ counts: { all: number } }>("store_status", {}, w.id)
        .then((s) => setCounts((c) => ({ ...c, [w.id]: s.counts.all })))
        .catch(() => {});
  }, [invoke, workspaces]);
  return (
    <>
      <Group title="Your libraries" footer="Each library is a folder on this Mac. Files stay where they are.">
        {workspaces.map((w) => (
          <Row
            key={w.id}
            label={
              <>
                <span className="kx-settings-swatch" style={{ background: w.color || undefined }}>
                  {w.icon || w.name.slice(0, 1)}
                </span>
                {w.name}
              </>
            }
            path
            detail={`${counts[w.id] === undefined ? "…" : `${counts[w.id].toLocaleString()} sources`} · ${w.root.replace(/^\/Users\/[^/]+/, "~")}`}
          >
            <button className="kx-settings-button" onClick={() => void bridge().revealPath(w.root)}>
              Show in Finder
            </button>
            <button className="kx-settings-button" onClick={() => onOpenLibrary(w.id)}>
              Open
            </button>
          </Row>
        ))}
        <div className="kx-settings-row kx-settings-row-action">
          <button className="kx-settings-link" onClick={() => void bridge().addWorkspace().then((added) => added && onChanged())}>
            <Icon name="plus" size={11} />
            Add library…
          </button>
        </div>
      </Group>
      <Group title="Adding sources">
        <Row label="Works added from a source" detail="From its references, related works or a citation in its PDF.">
          <select className="kx-settings-select" aria-label="Where sources added from another source go" value={settings.addFromSource ?? "ask"} onChange={(e) => onSettings({ addFromSource: e.target.value as AppSettings["addFromSource"] })}>
            {ADD_MODES.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Find PDFs automatically" detail="Look for an open-access PDF when a reference without one is added.">
          <input
            type="checkbox"
            className="kx-switch"
            aria-label="Find PDFs automatically when adding"
            checked={settings.findPdfOnAdd === true}
            onChange={(e) => onSettings({ findPdfOnAdd: e.target.checked })}
          />
        </Row>
      </Group>
    </>
  );
}

function Zotero({
  invoke,
  workspaces,
  info,
  settings,
  onSettings,
  onChanged,
}: {
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  info: AppInfo;
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
  onChanged: () => void;
}) {
  const [importing, setImporting] = useState<{ mode?: ZoteroMode; current?: ZoteroOptions | null } | null>(null);
  // One sheet at a time: the import dialogue takes the place of this page.
  if (importing)
    return (
      <div className="kx-settings-group kx-settings-zotero-import">
        <ZoteroImport invoke={invoke} workspaceId={workspaces[0]?.id} initialMode={importing.mode} current={importing.current} onClose={() => setImporting(null)} onDone={() => onChanged()} />
      </div>
    );
  return <ZoteroSettings invoke={invoke} workspaces={workspaces} info={info} settings={settings} onSettings={onSettings} onOpen={(mode, current) => setImporting({ mode, current })} />;
}

function SearchSettings({
  invoke,
  workspaces,
  info,
  settings,
  onSettings,
}: {
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  info: AppInfo;
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id);
  const status = useLibraryStatus(invoke, workspaceId);
  const model = useModelProgress(invoke, workspaceId);
  const [message, setMessage] = useState("");
  // The switch answers at once; the next status poll confirms it.
  const [pausing, setPausing] = useState<boolean>();
  const paused = pausing ?? !!status?.activity?.paused;
  useEffect(() => setPausing(undefined), [status?.activity?.paused]);
  const setPaused = (value: boolean) => {
    setPausing(value);
    void invoke("store_index_control", { action: value ? "pause" : "resume" }, workspaceId);
  };
  // PDFs read before the current analysis (or with the other layout setting).
  const [outdated, setOutdated] = useState<number>();
  useEffect(() => {
    void invoke<{ outdated: number }>("store_analysis_options", {}, workspaceId)
      .then((o) => setOutdated(o.outdated))
      .catch(() => setOutdated(undefined));
  }, [invoke, workspaceId, settings.layoutModel]);
  const references = (status as { references?: { title?: string; stage: string; done: number; total: number } | null } | undefined)?.references;
  const accelerator = (status?.model as { accelerator?: string } | undefined)?.accelerator;
  const counts = status?.counts;
  const failed = counts?.attention ?? 0;
  return (
    <>
      <Group title="Search model" footer="Runs on this Mac. Your sources and searches never leave it.">
        {model && ["downloading", "missing", "failed"].includes(model.state) ? (
          <div className="kx-settings-row kx-settings-row-wide">
            <ModelProgressCard progress={model} compact />
          </div>
        ) : (
          <Row label="EmbeddingGemma 2" detail={accelerator ? `768 dimensions · ${accelerator}` : "768 dimensions"}>
            {model?.state === "ready" ? (
              <span className="kx-settings-ok">
                <Icon name="check" size={12} /> Ready
              </span>
            ) : (
              <span className="kx-settings-state">{model ? "Starting…" : "Checking…"}</span>
            )}
          </Row>
        )}
        <Row label="Model folder" path detail={info.modelDir.replace(/^\/Users\/[^/]+/, "~")}>
          <button className="kx-settings-button" onClick={() => void bridge().revealPath(info.modelDir)}>
            Show in Finder
          </button>
        </Row>
      </Group>
      {workspaces.length > 1 && (
        <Group>
          <Row label="Library">
            <select className="kx-settings-select" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Row>
        </Group>
      )}
      <Group title="Indexing" footer={message || "Sources you open or scroll to are indexed first."}>
        {counts && (
          <div className="kx-settings-stats">
            <div>
              <strong>{counts.ready.toLocaleString()}</strong>
              <span>searchable</span>
            </div>
            <div>
              <strong>{counts.indexing.toLocaleString()}</strong>
              <span>waiting</span>
            </div>
            <div>
              <strong>{(status?.vectors ?? 0).toLocaleString()}</strong>
              <span>passages</span>
            </div>
            <div data-tone={failed ? "attention" : undefined}>
              <strong>{failed.toLocaleString()}</strong>
              <span>need attention</span>
            </div>
          </div>
        )}
        {status?.activity && (status.activity.batchTotal > 0 || status.activity.paused || olderSources(status.backfill) > 0) && (
          <div className="kx-settings-row kx-settings-row-wide">
            <ActivityPanel
              activity={status.activity}
              modelReady={status.model.state === "ready"}
              onPause={setPaused}
              backfill={status.backfill}
            />
          </div>
        )}
        {references && (
          <Row
            label={references.stage === "detecting" ? "Finding references" : "Looking up references"}
            detail={`${references.title || "Untitled"}${references.total ? ` · ${references.done} of ${references.total}` : ""}`}
          >
            <span className="kx-search-spinner" aria-hidden="true" />
          </Row>
        )}
        <Row label="Pause indexing" detail="Search keeps working.">
          <input
            type="checkbox"
            className="kx-switch"
            aria-label="Pause indexing"
            checked={paused}
            onChange={(e) => setPaused(e.target.checked)}
          />
        </Row>
        <Row label="Retry failed sources" detail={failed ? `${failed.toLocaleString()} could not be read` : "None failed"}>
          <button
            className="kx-settings-button"
            disabled={!failed}
            onClick={async () => {
              const count = await invoke<number>("store_index_control", { action: "retry_failed" }, workspaceId);
              setMessage(count ? `Queued ${count} ${count === 1 ? "source" : "sources"} again.` : "Nothing to retry.");
            }}
          >
            Retry
          </button>
        </Row>
      </Group>
      <Group title="PDF analysis">
        <Row label="Use the layout model" detail="Better reading order, tables and columns; about a second per page.">
          <input
            type="checkbox"
            className="kx-switch"
            aria-label="Use the layout model"
            checked={settings.layoutModel}
            onChange={(e) => onSettings({ layoutModel: e.target.checked })}
          />
        </Row>
        <Row
          label="Analyse PDFs again"
          detail={
            outdated === undefined
              ? "Read PDFs again with the current settings."
              : outdated
                ? `${outdated.toLocaleString()} ${outdated === 1 ? "PDF uses" : "PDFs use"} an older analysis`
                : "Every PDF is up to date"
          }
        >
          <button
            className="kx-settings-button"
            disabled={!outdated}
            onClick={async () => {
              const result = await invoke<{ outdated: number }>("store_analysis_options", { reanalyzeOutdated: true }, workspaceId);
              setMessage(`Queued ${outdated?.toLocaleString()} PDFs for analysis.`);
              setOutdated(result.outdated);
            }}
          >
            Analyse
          </button>
        </Row>
      </Group>
      <Group title="Metadata" footer="Only identifiers and titles are sent to OpenAlex and Crossref, never your files or notes.">
        <Row label="Look up new sources in OpenAlex" detail={
            !settings.openalex
              ? "Only when you ask"
              : status?.enrichment
                ? `${status.enrichment.toLocaleString()} waiting`
                : olderSources(status?.backfill)
                  ? `${olderSources(status?.backfill).toLocaleString()} older sources when idle`
                  : "Authors, journal, topics, citations and retractions"
          }>
          <input
            type="checkbox"
            className="kx-switch"
            aria-label="Look up new sources in OpenAlex"
            checked={settings.openalex}
            onChange={(e) => onSettings({ openalex: e.target.checked })}
          />
        </Row>
        <Row label="Contact email" detail="OpenAlex asks for one for heavy use.">
          <input
            className="kx-settings-select"
            type="email"
            aria-label="OpenAlex contact email"
            placeholder="you@example.org"
            defaultValue={settings.openalexMailto}
            onBlur={(e) => e.target.value.trim() !== settings.openalexMailto && onSettings({ openalexMailto: e.target.value.trim() })}
          />
        </Row>
        <PossibleDuplicates invoke={invoke} workspaceId={workspaceId} />
      </Group>
    </>
  );
}

/** People whose names might be one person: reviewed side by side, merged only when the user says so. */
function PossibleDuplicates({ invoke, workspaceId }: { invoke: Invoke; workspaceId?: string }) {
  const [count, setCount] = useState<number>();
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    if (workspaceId) void invoke<MergeSuggestion[]>("store_merge_suggestions", {}, workspaceId).then((list) => setCount(list.length)).catch(() => setCount(0));
  }, [invoke, workspaceId]);
  useEffect(load, [load]);
  return (
    <>
      <Row label="Possible duplicate people" detail={count ? `${count} to review` : "None to review"}>
        <button className="kx-settings-button" disabled={!count} onClick={() => setOpen(true)}>
          Review…
        </button>
      </Row>
      {open && workspaceId && (
        <MergeReview
          invoke={invoke}
          workspaceId={workspaceId}
          onClose={() => {
            setOpen(false);
            load();
          }}
        />
      )}
    </>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  codex: "Codex",
  anthropic: "Anthropic",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  openai: "OpenAI",
  kimi: "Kimi",
  glm: "GLM",
  custom: "Custom endpoint",
};

function AiSettings({ invoke, workspaceId }: { invoke: Invoke; workspaceId?: string }) {
  const [status, setStatus] = useState<{ available: boolean; provider?: string; model?: string; reason?: string }>();
  const [endpoint, setEndpoint] = useState("http://localhost:11434/v1");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void invoke<typeof status>("agent_fill_status", {}, workspaceId).then(setStatus).catch(() => {});
  }, [invoke, workspaceId]);
  return (
    <>
      <Group title="Provider" footer="Used only when you ask, with just the passages a task needs.">
        <Row
          label={status?.available ? `${PROVIDER_LABEL[status.provider ?? ""] ?? status.provider} · ${status.model}` : "Not connected"}
          detail={status ? (status.available ? "Connected" : status.reason || "Connect a provider below") : "Checking…"}
        >
          {status?.available ? (
            <span className="kx-settings-ok">
              <Icon name="check" size={12} /> Ready
            </span>
          ) : null}
        </Row>
      </Group>
      <Group title="OpenAI-compatible provider" footer="Ollama, LM Studio or any hosted API over HTTPS. The key stays on this Mac.">
        <form
          className="kx-settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              setStatus(await invoke("agent_fill_configure", { baseUrl: endpoint, model, apiKey: apiKey || undefined }, workspaceId));
              setApiKey("");
            } catch (err) {
              setError(String(err).replace(/^Error: /, ""));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            <span>Endpoint</span>
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://api.example.com/v1" />
          </label>
          <label>
            <span>Model</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="llama3.1:8b" />
          </label>
          <label>
            <span>API key</span>
            <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Optional for local servers" />
          </label>
          {error && <p className="kx-inline-error">{error}</p>}
          <div>
            <button type="submit" className="kx-button-primary" disabled={busy || !model.trim() || !endpoint.trim()}>
              {busy ? "Connecting…" : "Save provider"}
            </button>
          </div>
        </form>
      </Group>
    </>
  );
}

function About({ info }: { info: AppInfo }) {
  const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
  return (
    <>
      <div className="kx-settings-about">
        <span className="kx-settings-appicon">
          <Icon name="books" size={30} />
        </span>
        <div>
          <strong>Key</strong>
          <span>
            Version {info.version} · Electron {info.electron}
          </span>
        </div>
      </div>
      <Group title="Where your data lives">
        {[
          ["App settings", info.userData],
          ["Libraries", info.workspaceParent],
          ["Search model", info.modelDir],
        ].map(([label, path]) => (
          <Row key={label} label={label} path detail={home(path)}>
            <button className="kx-settings-button" onClick={() => void bridge().revealPath(path)}>
              Show in Finder
            </button>
          </Row>
        ))}
      </Group>
      <Group title="Licences">
        <Row label="Key" detail="MIT licence. The Office editors derive from GenOffice and stay under Apache 2.0." />
        <Row label="Acknowledgements" detail="Open-source software, fonts, models and citation styles Key includes.">
          <button className="kx-settings-button" disabled={!info.notices} onClick={() => info.notices && void bridge().openPath(info.notices)}>
            Open
          </button>
        </Row>
      </Group>
    </>
  );
}
