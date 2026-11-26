// Key Settings: a window-sized sheet with a sidebar of sections in groups, like macOS System
// Settings, with a search over the sections. Everything here applies to Key on this Mac;
// what belongs to one workspace is in Workspace Settings (WorkspaceSettings.tsx), which uses
// the same frame. Sections are listed in settings-catalog.ts. Styles in settings.css.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon, type IconName } from "./icons";
import { bridge, type AppInfo, type AppSettings, type Invoke, type Theme, type WorkspaceSummary } from "./library-api";
import "./entity.css";
import "./settings.css";
import { ModelsGroup, type ModelsListing } from "./models-ui";
import { useLibraryStatus } from "./index-activity";
import WebSearchSettings from "./WebSearchSettings";
import BrowserSettings from "./BrowserSettings";
import ServiceKeys from "./ServiceKeys";
import CitationSettings from "./CitationSettings";
import { APP_GROUPS, APP_SECTIONS, WORKSPACE_SECTIONS, matches, openWorkspaceSettings, type SectionInfo, type SettingsSection } from "./settings-catalog";
import { Explain, Glossary, Hint, resetTips, setTipsShown, useTips } from "./explain";
import { hintText, type ExplainId, type HintId } from "./help-content";

export type { SettingsSection } from "./settings-catalog";

/** The frame both settings windows share: the sidebar (window title, scope caption, search,
 *  sections, and the other window's matches) and the content pane. */
export function SettingsFrame<Id extends string>({
  label,
  title,
  scope,
  scopeHelp,
  groups,
  section,
  onSection,
  elsewhere,
  onClose,
  children,
}: {
  label: string;
  /** The window's name in the sidebar's head (Workspace Settings puts its picker here). */
  title: ReactNode;
  /** Who the settings apply to: "Applies to Key on this Mac" / "Applies to Thesis". */
  scope: string;
  /** What that scope means, one click away. */
  scopeHelp?: ExplainId;
  groups: SectionInfo<Id>[][];
  section: Id;
  onSection: (id: Id) => void;
  /** The other window's sections, offered when a search matches them. */
  elsewhere: { label: string; sections: SectionInfo[]; open: (id: string) => void };
  onClose: () => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const nav = useRef<HTMLElement>(null);
  const all = groups.flat();
  const visible = query.trim() ? all.filter((s) => matches(s, query)) : all;
  const other = query.trim() ? elsewhere.sections.filter((s) => matches(s, query)) : [];
  // Searching moves to the first section that matches, as System Settings does.
  useEffect(() => {
    if (query.trim() && visible.length && !visible.some((s) => s.id === section)) onSection(visible[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  const step = (by: number) => {
    const list = visible.map((s) => s.id);
    const next = list[(list.indexOf(section) + by + list.length) % list.length];
    if (!next) return;
    onSection(next);
    nav.current?.querySelector<HTMLButtonElement>(`[data-section="${next}"]`)?.focus();
  };
  const current = all.find((s) => s.id === section) ?? all[0];
  return (
    <GlobalDrawer presentation="window" label={label} onClose={onClose}>
      <div className="kx-settings" data-modal-view={section}>
        <nav
          ref={nav}
          className="kx-settings-nav"
          aria-label={`${label} sections`}
          onKeyDown={(e) => {
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (e.target as HTMLElement).tagName !== "SELECT") {
              e.preventDefault();
              step(e.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          <div className="kx-settings-scope">
            {title}
            <small data-settings-scope>
              {scope}
              {scopeHelp && <Explain help={scopeHelp} />}
            </small>
          </div>
          <label className="kx-settings-search">
            <Icon name="search" size={12} />
            <input
              type="search"
              placeholder="Search"
              aria-label={`Search ${label}`}
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
          {groups.map((group, i) => {
            const shown = group.filter((s) => visible.includes(s));
            if (!shown.length) return null;
            return (
              <div className="kx-settings-nav-group" key={i}>
                {shown.map(({ id, label, icon }) => (
                  <button key={id} data-section={id} aria-current={section === id ? "page" : undefined} tabIndex={section === id ? 0 : -1} onClick={() => onSection(id)}>
                    <SectionGlyph id={id} icon={icon} />
                    {label}
                  </button>
                ))}
              </div>
            );
          })}
          {!visible.length && !other.length && <p className="kx-settings-nav-empty">No results</p>}
          {!!other.length && (
            <div className="kx-settings-nav-group kx-settings-elsewhere" role="group" aria-label={`Found in ${elsewhere.label}`}>
              <h4>Found in {elsewhere.label}</h4>
              {other.map(({ id, label, icon }) => (
                <button key={id} data-elsewhere={id} tabIndex={-1} onClick={() => elsewhere.open(id)}>
                  <SectionGlyph id={id} icon={icon} />
                  {label}
                  <Icon name="arrowRight" size={10} />
                </button>
              ))}
            </div>
          )}
        </nav>
        <div className="kx-settings-body">
          <header>
            <h1>{current.label}</h1>
            <button className="kx-sheet-close" aria-label={`Close ${label}`} onClick={onClose}>
              <Icon name="close" size={10} />
            </button>
          </header>
          <div className="kx-settings-scroll" key={section}>
            {children}
          </div>
        </div>
      </div>
    </GlobalDrawer>
  );
}

const SectionGlyph = ({ id, icon }: { id: string; icon: IconName }) => (
  <span className="kx-settings-glyph" data-section={id}>
    <Icon name={icon} size={12} />
  </span>
);

/** A setting a workspace can take its own value for, else the app's default: "Using app
 *  default · Change", or its own control with a way back to the default. */
export function Overridable({ own, fallback, onOwn, onReset, children }: { own: boolean; fallback: ReactNode; onOwn: () => void; onReset: () => void; children: ReactNode }) {
  return own ? (
    <>
      {children}
      <button className="kx-settings-link kx-settings-reset" onClick={onReset}>
        Use app default
      </button>
    </>
  ) : (
    <span className="kx-settings-default" data-default>
      <span>Using app default · {fallback}</span>
      <Explain help="settings.override" />
      <button className="kx-settings-button" onClick={onOwn}>
        Change
      </button>
    </span>
  );
}

export default function Settings({
  section,
  onSection,
  invoke,
  workspaceId,
  workspaces,
  settings,
  info,
  onSettings,
  onClose,
  onShowWelcome,
  onOpenLibrary,
  onWorkspacesChanged,
}: {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  invoke: Invoke;
  /** The window's workspace: the one whose host formats previews and answers status. */
  workspaceId?: string;
  workspaces: WorkspaceSummary[];
  settings: AppSettings;
  info: AppInfo;
  onSettings: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
  onShowWelcome: () => void;
  onOpenLibrary: (workspaceId: string) => void;
  onWorkspacesChanged: () => void;
}) {
  const host = workspaceId ?? workspaces[0]?.id;
  return (
    <SettingsFrame
      label="Key Settings"
      title={
        <strong className="kx-settings-title">
          <Icon name="gear" size={13} />
          Key Settings
        </strong>
      }
      scope="Applies to Key on this Mac"
      scopeHelp="settings.scope.app"
      groups={APP_GROUPS}
      section={APP_SECTIONS.some((s) => s.id === section) ? section : "general"}
      onSection={onSection}
      elsewhere={{ label: "Workspace Settings", sections: WORKSPACE_SECTIONS, open: (id) => openWorkspaceSettings(id as never) }}
      onClose={onClose}
    >
      {section === "general" && <General settings={settings} onSettings={onSettings} onShowWelcome={onShowWelcome} onClose={onClose} />}
      {section === "workspaces" && <Workspaces invoke={invoke} workspaces={workspaces} onOpenLibrary={onOpenLibrary} onChanged={onWorkspacesChanged} />}
      {section === "citations" && <CitationSettings invoke={invoke} workspaceId={host} style={settings.citationStyle || "apa"} locale={settings.citationLocale || "en-US"} onChange={(patch) => onSettings(patch)} />}
      {section === "search" && <SearchSettings invoke={invoke} workspaceId={host} info={info} settings={settings} onSettings={onSettings} />}
      {section === "privacy" && <PrivacySettings settings={settings} onSettings={onSettings} />}
      {section === "web" && (
        <>
          <WebSearchSettings invoke={invoke} settings={settings} onSettings={onSettings} />
          <BrowserSettings settings={settings} onSettings={onSettings} />
        </>
      )}
      {section === "services" && <ServiceKeys invoke={invoke} />}
      {section === "ai" && <AiSettings invoke={invoke} workspaceId={host} />}
      {section === "about" && <About info={info} />}
    </SettingsFrame>
  );
}

/** A titled, rounded group of rows. */
export function Group({ title, footer, children, help, intro }: { title?: string; footer?: ReactNode; children: ReactNode; help?: ExplainId; intro?: HintId }) {
  return (
    <section className="kx-settings-group">
      {title && (
        <h3>
          {title}
          {help && <Explain help={help} />}
        </h3>
      )}
      {!title && help && <Explain help={help} label className="kx-settings-group-explain" />}
      {intro && <Hint help={intro} />}
      <div className="kx-settings-rows">{children}</div>
      {footer && <p className="kx-settings-footnote">{footer}</p>}
    </section>
  );
}
/** A setting: its label and a quiet line beneath. A `path` line stays on one line, cut at
 *  the end, with the whole path on hover. */
export function Row({ label, detail, children, path, help }: { label: ReactNode; detail?: ReactNode; children?: ReactNode; path?: boolean; help?: ExplainId }) {
  return (
    <div className="kx-settings-row">
      <div>
        <span>
          {label}
          {help && <Explain help={help} />}
        </span>
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
  ["Key Settings", "⌘,"],
  ["Workspace Settings", "⌥⌘,"],
];

type OpenAtLaunch = "workspaces" | "restore" | "last";
const OPEN_AT_LAUNCH: [OpenAtLaunch, string][] = [
  ["workspaces", "Show workspaces"],
  ["restore", "Reopen windows from last time"],
  ["last", "Open the last workspace"],
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
  // Added by the workspace launcher; older builds' settings files do not have it.
  const openAtLaunch = (settings as AppSettings & { openAtLaunch?: OpenAtLaunch }).openAtLaunch ?? "workspaces";
  return (
    <>
      <Group title="Appearance" intro="settings.general.appearance">
        <div className="kx-settings-row kx-settings-row-wide">
          <ThemePicker value={settings.theme} onChange={(theme) => onSettings({ theme })} />
        </div>
      </Group>
      <Group title="Startup">
        <Row label="When Key opens">
          <select className="kx-settings-select" aria-label="When Key opens" value={openAtLaunch} onChange={(e) => onSettings({ openAtLaunch: e.target.value } as Partial<AppSettings>)}>
            {OPEN_AT_LAUNCH.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Row>
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
        <TipsRow />
      </Group>
      <Group title="Glossary" intro="settings.general.glossary">
        <div className="kx-settings-row kx-settings-row-wide kx-settings-glossary">
          <Glossary />
        </div>
      </Group>
    </>
  );
}

/** First-use tips: on or off for the whole app, and the ones already seen shown again. */
function TipsRow() {
  const tips = useTips();
  return (
    <Row label="Show tips" detail={hintText("settings.general.tips")}>
      <button className="kx-settings-button" disabled={tips.off || !tips.seen.length} onClick={resetTips}>
        Show again
      </button>
      <input type="checkbox" className="kx-switch" aria-label="Show tips" checked={!tips.off} onChange={(e) => setTipsShown(e.target.checked)} />
    </Row>
  );
}

/** Every workspace on this Mac; what belongs to one is in its Workspace Settings. */
function Workspaces({
  invoke,
  workspaces,
  onOpenLibrary,
  onChanged,
}: {
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
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
    <Group title="Your workspaces" help="settings.libraries.what" intro="settings.libraries.intro" footer="Each workspace is a folder on this Mac with its own settings. Files you link stay where they are.">
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
          <button className="kx-settings-button" aria-label={`Settings for ${w.name}`} onClick={() => openWorkspaceSettings("workspace", w.id)}>
            Settings…
          </button>
          <button className="kx-settings-button" onClick={() => onOpenLibrary(w.id)}>
            Open
          </button>
        </Row>
      ))}
      <div className="kx-settings-row kx-settings-row-action">
        <button className="kx-settings-link" onClick={() => void bridge().addWorkspace().then((added) => added && onChanged())}>
          <Icon name="plus" size={11} />
          Add workspace…
        </button>
      </div>
    </Group>
  );
}

/** The models and how PDFs are read: installed once on this Mac, used by every workspace. */
function SearchSettings({
  invoke,
  workspaceId,
  info,
  settings,
  onSettings,
}: {
  invoke: Invoke;
  workspaceId?: string;
  info: AppInfo;
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
}) {
  const status = useLibraryStatus(invoke, workspaceId);
  // Fresh on open and after each action; the status poll keeps progress moving.
  const [fetched, setFetched] = useState<ModelsListing>();
  const refreshModels = useCallback(() => {
    void invoke<ModelsListing>("store_models", {}, workspaceId).then(setFetched).catch(() => {});
  }, [invoke, workspaceId]);
  useEffect(refreshModels, [refreshModels]);
  const statusModels = (status as { models?: ModelsListing } | undefined)?.models;
  useEffect(() => {
    if (statusModels) setFetched(statusModels);
  }, [statusModels]);
  const accelerator = (status?.model as { accelerator?: string } | undefined)?.accelerator;
  return (
    <>
      <ModelsGroup
        invoke={invoke}
        workspaceId={workspaceId}
        listing={fetched}
        autoDownload={settings.modelsAutoDownload !== false}
        onAutoDownload={(value) => onSettings({ modelsAutoDownload: value })}
        accelerator={accelerator}
        onChanged={refreshModels}
      />
      <Group title="PDF analysis">
        <Row label="Use the layout model" help="settings.search.layout" detail="Better reading order, tables and columns; about a second per page, on this Mac.">
          <input
            type="checkbox"
            className="kx-switch"
            aria-label="Use the layout model"
            checked={settings.layoutModel}
            onChange={(e) => onSettings({ layoutModel: e.target.checked })}
          />
        </Row>
      </Group>
      <Group footer="Indexing progress, pausing and analysing PDFs again are per workspace.">
        <Row label="Indexing in this workspace">
          <button className="kx-settings-button" onClick={() => openWorkspaceSettings("indexing")}>
            Workspace Settings…
          </button>
        </Row>
      </Group>
    </>
  );
}

/** What leaves this Mac, and the default for automatic lookups. */
function PrivacySettings({ settings, onSettings }: { settings: AppSettings; onSettings: (patch: Partial<AppSettings>) => void }) {
  return (
    <>
      <Group title="Metadata lookups" help="settings.search.metadata" footer="Only identifiers and titles are sent to OpenAlex and Crossref, never your files or notes.">
        <Row label="Look up new sources automatically" detail="Fills in authors, journal, topics, citation counts and retractions. The default for every workspace; a workspace can choose its own.">
          <input
            type="checkbox"
            className="kx-switch"
            aria-label="Look up new sources automatically"
            checked={settings.openalex}
            onChange={(e) => onSettings({ openalex: e.target.checked })}
          />
        </Row>
        <Row label="Contact email" help="settings.search.email" detail="Optional. OpenAlex answers faster when requests carry one.">
          <input
            className="kx-settings-select"
            type="email"
            aria-label="OpenAlex contact email"
            placeholder="you@example.org"
            defaultValue={settings.openalexMailto}
            onBlur={(e) => e.target.value.trim() !== settings.openalexMailto && onSettings({ openalexMailto: e.target.value.trim() })}
          />
        </Row>
      </Group>
      <Group title="What leaves this Mac">
        <Row label="Your files, notes and searches" detail="Stay on this Mac. Search runs on a local model." />
        <Row label="Identifiers and titles" detail="To OpenAlex and Crossref, when lookups are on or you ask." />
        <Row label="Web searches" detail="To the providers turned on in Web & browser." />
        <Row label="AI assistant" detail="Only when you ask, with just the passages a task needs." />
      </Group>
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
      <Group title="Provider" help="settings.ai.provider" footer="Used only when you ask, with just the passages a task needs.">
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
      <Group title="OpenAI-compatible provider" help="settings.ai.endpoint" footer="Ollama, LM Studio or any hosted API over HTTPS. The key stays on this Mac.">
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
        <Row label="Key" detail="MIT licence." />
        <Row label="Acknowledgements" detail="Open-source software, fonts, models and citation styles Key includes.">
          <button className="kx-settings-button" disabled={!info.notices} onClick={() => info.notices && void bridge().openPath(info.notices)}>
            Open
          </button>
        </Row>
      </Group>
    </>
  );
}
