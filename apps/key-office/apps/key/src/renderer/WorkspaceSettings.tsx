// Workspace Settings: what belongs to one workspace (its name and folder, Zotero, indexing and
// lookups, citations and exports, file names, feeds), in the same frame as Key Settings. Every
// value here is stored in that workspace's own library; where Key Settings holds a default
// (citation style, lookups) the workspace uses it until it chooses its own.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "./icons";
import { ActivityPanel, olderSources, useLibraryStatus } from "./index-activity";
import { bridge, type AppInfo, type AppSettings, type Invoke, type MergeSuggestion, type WorkspaceSummary, type ZoteroOptions, type ZoteroStatus, type ZoteroSyncStatus } from "./library-api";
import { Group, Overridable, Row, SettingsFrame } from "./Settings";
import { APP_SECTIONS, WORKSPACE_GROUPS, WORKSPACE_SECTIONS, openKeySettings, type WorkspaceSettingsSection } from "./settings-catalog";
import { workspaceSettings, type BatteryMode, type WorkspaceSettingsPatch, type WorkspaceSettingsState } from "./workspace-settings-api";
import { ADD_MODES } from "./add-from-source";
import CitationSettings from "./CitationSettings";
import { CitationKeySettings } from "./citation-keys";
import { MarkdownExportSettings } from "./markdown-export";
import { FileSettings } from "./file-names";
import { FeedsManager } from "./FeedsManager";
import MergeReview from "./MergeReview";
import { ZoteroImport } from "./ZoteroImport";
import { ZoteroSettings, zoteroWorkspaceOf } from "./ZoteroSyncSettings";
import { openTagManager } from "./tag-manager-open";
import { WORKSPACE_COLORS, WORKSPACE_ICONS } from "./WorkspaceSwitcher";
import type { Mode as ZoteroMode } from "./zotero-sheet-model";

/** Bulk indexing on battery: what each choice does, in plain words. */
const BATTERY_MODES: [BatteryMode, string, string][] = [
  ["low", "Pause when the battery is low", "Pauses below 30% battery and in Low Power Mode. What you open is still indexed."],
  ["battery", "Pause on battery", "Waits until this Mac is plugged in. What you open is still indexed."],
  ["never", "Keep indexing", "Indexes on battery too, which uses more power."],
];

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** The workspace's settings from its host, and a way to change them. */
function useWorkspaceSettings(invoke: Invoke, workspaceId: string) {
  const [state, setState] = useState<WorkspaceSettingsState>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setState(undefined);
    void workspaceSettings(invoke, workspaceId)
      .then((s) => live && setState(s))
      .catch((e) => live && setError(String(e).replace(/^Error: /, "")));
    return () => {
      live = false;
    };
  }, [invoke, workspaceId]);
  const patch = async (change: WorkspaceSettingsPatch) => {
    setError("");
    // The control answers at once; the host's answer replaces this.
    setState((s) => {
      if (!s) return s;
      const app = s.app as Record<string, unknown>;
      const effective = { ...s.effective } as Record<string, unknown>;
      for (const [key, value] of Object.entries(change)) effective[key] = value ?? app[key];
      return { ...s, own: { ...s.own, ...change }, effective: effective as WorkspaceSettingsState["effective"] };
    });
    try {
      setState(await workspaceSettings(invoke, workspaceId, change));
      // Open notes render their citations again in the workspace's style.
      if ("citationStyle" in change || "citationLocale" in change) window.dispatchEvent(new Event("key:citation-style-changed"));
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  };
  return { state, patch, error };
}

export default function WorkspaceSettings({
  section,
  onSection,
  workspaceId,
  onWorkspace,
  invoke,
  workspaces,
  settings,
  info,
  onSettings,
  onClose,
  onWorkspacesChanged,
  onRemoved,
}: {
  section: WorkspaceSettingsSection;
  onSection: (section: WorkspaceSettingsSection) => void;
  /** The workspace being edited (the window's own unless another was picked). */
  workspaceId: string;
  onWorkspace: (workspaceId: string) => void;
  invoke: Invoke;
  workspaces: WorkspaceSummary[];
  settings: AppSettings;
  info: AppInfo;
  onSettings: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
  onWorkspacesChanged: () => void;
  /** After Remove from Key: the workspace the window now shows. */
  onRemoved: (shown: string) => void;
}) {
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];
  const ws = useWorkspaceSettings(invoke, workspace?.id ?? "");
  if (!workspace) return null;
  const id = workspace.id;
  const current = WORKSPACE_SECTIONS.some((s) => s.id === section) ? section : "workspace";
  return (
    <SettingsFrame
      label="Workspace Settings"
      title={
        <label className="kx-settings-picker" title="Choose which workspace to edit">
          <span className="kx-settings-swatch" style={{ background: workspace.color || undefined }}>
            {workspace.icon || workspace.name.slice(0, 1)}
          </span>
          <strong>{workspace.name}</strong>
          {workspaces.length > 1 && <Icon name="chevronUpDown" size={10} />}
          {workspaces.length > 1 && (
            <select aria-label="Workspace to edit" value={id} onChange={(e) => onWorkspace(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
        </label>
      }
      scope={`Applies to ${workspace.name}`}
      scopeHelp="settings.scope.workspace"
      groups={WORKSPACE_GROUPS}
      section={current}
      onSection={onSection}
      elsewhere={{ label: "Key Settings", sections: APP_SECTIONS, open: (s) => openKeySettings(s as never) }}
      onClose={onClose}
    >
      <div key={id} className="kx-settings-workspace" data-workspace={id}>
        {ws.error && (
          <p className="kx-settings-footnote kx-cite-error" role="alert">
            {ws.error}
          </p>
        )}
        {current === "workspace" && <General invoke={invoke} workspace={workspace} ws={ws} onClose={onClose} onChanged={onWorkspacesChanged} onRemoved={onRemoved} />}
        {current === "zotero" && <Zotero invoke={invoke} workspace={workspace} workspaces={workspaces} info={info} settings={settings} onSettings={onSettings} onWorkspace={onWorkspace} onChanged={onWorkspacesChanged} />}
        {current === "indexing" && <Indexing invoke={invoke} workspaceId={id} ws={ws} />}
        {current === "citations" && (
          <>
            <CitationStyle invoke={invoke} workspaceId={id} ws={ws} />
            <CitationKeySettings invoke={invoke} workspaceId={id} />
          </>
        )}
        {current === "markdown" && <MarkdownExportSettings invoke={invoke} workspaceId={id} />}
        {current === "files" && <FileSettings invoke={invoke} workspaceId={id} />}
        {current === "feeds" && <FeedsManager invoke={invoke} workspaceId={id} />}
      </div>
    </SettingsFrame>
  );
}

type Ws = ReturnType<typeof useWorkspaceSettings>;

function General({ invoke, workspace, ws, onClose, onChanged, onRemoved }: { invoke: Invoke; workspace: WorkspaceSummary; ws: Ws; onClose: () => void; onChanged: () => void; onRemoved: (shown: string) => void }) {
  const [name, setName] = useState(workspace.name);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  useEffect(() => setName(workspace.name), [workspace.name]);
  const rename = async () => {
    const next = name.trim();
    if (!next || next === workspace.name) return setName(workspace.name);
    setError("");
    try {
      await invoke("workspace_rename", { name: next }, workspace.id);
      onChanged();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  };
  const [moveError, setMoveError] = useState("");
  const look = async (icon: string, color: string) => {
    setError("");
    try {
      await invoke("workspace_set_appearance", { icon, color }, workspace.id);
      onChanged();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  };
  const icon = workspace.icon || WORKSPACE_ICONS[0];
  const color = workspace.color || WORKSPACE_COLORS[0];
  const remove = async () => {
    if (!window.confirm(`Remove “${workspace.name}” from Key?\n\nIts folder and every file in it stay on this Mac. Add the folder again to bring it back.`)) return;
    setRemoving(true);
    setError("");
    try {
      const result = await bridge().removeWorkspace?.(workspace.id);
      onChanged();
      if (result) onRemoved(result.workspaceId);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setRemoving(false);
    }
  };
  return (
    <>
      <Group title="Workspace">
        <Row label="Name">
          <input
            className="kx-settings-select"
            aria-label="Workspace name"
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape" && name !== workspace.name) {
                e.stopPropagation();
                setName(workspace.name);
              }
            }}
          />
        </Row>
        <Row label="Icon">
          <span className="kx-settings-swatches" role="radiogroup" aria-label="Workspace icon">
            {WORKSPACE_ICONS.map((i) => (
              <button key={i} role="radio" aria-checked={i === workspace.icon} aria-label={i} onClick={() => void look(i, color)}>
                {i}
              </button>
            ))}
          </span>
        </Row>
        <Row label="Colour">
          <span className="kx-settings-swatches" role="radiogroup" aria-label="Workspace colour">
            {WORKSPACE_COLORS.map((c) => (
              <button key={c} role="radio" aria-checked={c === color} aria-label={c} className="kx-settings-colour" style={{ background: c }} onClick={() => void look(icon, c)} />
            ))}
          </span>
        </Row>
      </Group>
      <Group title="Location" footer="Move… takes the folder and everything in it to another folder on the same disk; its tabs close and reopen.">
        <Row label="Folder" path detail={home(workspace.root)}>
          <button className="kx-settings-button" onClick={() => void bridge().revealPath(workspace.root)}>
            Show in Finder
          </button>
          <button
            className="kx-settings-button"
            onClick={() =>
              void bridge()
                .moveWorkspace(workspace.id)
                .then((moved) => moved && onChanged())
                .catch((e: unknown) => setMoveError(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")))
            }
          >
            Move…
          </button>
        </Row>
        {moveError && <p className="kx-settings-footnote kx-cite-error" role="alert">{moveError}</p>}
      </Group>
      <Group title="Adding sources">
        <Row label="Works added from a source" help="settings.libraries.add-from-source" detail="From its references, related works or a citation in its PDF: which collections they join.">
          <select
            className="kx-settings-select"
            aria-label="Where sources added from another source go"
            value={ws.state?.effective.addFromSource ?? "ask"}
            disabled={!ws.state}
            onChange={(e) => void ws.patch({ addFromSource: e.target.value as (typeof ADD_MODES)[number][0] })}
          >
            {ADD_MODES.map(([mode, label]) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <Group title="Organise">
        <Row label="Tags" detail="Rename, merge and tidy this workspace’s tags.">
          <button
            className="kx-settings-button"
            onClick={() => {
              onClose();
              openTagManager(workspace.id);
            }}
          >
            Organise tags…
          </button>
        </Row>
      </Group>
      <Group title="Remove">
        <Row label="Remove from Key" detail="Only Key forgets the workspace. Nothing in its folder is deleted.">
          <button className="kx-settings-button kx-settings-danger" disabled={removing} onClick={() => void remove()}>
            Remove…
          </button>
        </Row>
      </Group>
      {error && (
        <p className="kx-settings-footnote kx-cite-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** Zotero imports into, and syncs with, any workspace: the dedicated one (the folder named
 * Zotero, as before) or this one. */
function Zotero({
  invoke,
  workspace,
  workspaces,
  info,
  settings,
  onSettings,
  onWorkspace,
  onChanged,
}: {
  invoke: Invoke;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  info: AppInfo;
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
  onWorkspace: (id: string) => void;
  onChanged: () => void;
}) {
  const [importing, setImporting] = useState<{ mode?: ZoteroMode; current?: ZoteroOptions | null; target?: string } | null>(null);
  const zotero = zoteroWorkspaceOf(workspaces);
  // Whether this workspace has Zotero's items of its own (imported or kept in sync).
  const [own, setOwn] = useState<boolean>();
  useEffect(() => {
    let live = true;
    void Promise.all([
      invoke<ZoteroSyncStatus>("store_zotero_plugin_status", {}, workspace.id).catch(() => undefined),
      invoke<ZoteroStatus>("store_zotero_status", {}, workspace.id).catch(() => undefined),
    ]).then(([sync, imported]) => live && setOwn(!!sync?.configured || !!imported?.at));
    return () => {
      live = false;
    };
  }, [invoke, workspace.id, importing]);
  // One sheet at a time: the import dialogue takes the place of this page.
  if (importing)
    return (
      <div className="kx-settings-group kx-settings-zotero-import">
        <ZoteroImport
          invoke={invoke}
          workspaceId={importing.target ?? zotero?.id ?? workspace.id}
          target={importing.target}
          initialMode={importing.mode}
          current={importing.current}
          onClose={() => setImporting(null)}
          onDone={() => onChanged()}
        />
      </div>
    );
  if (zotero?.id === workspace.id)
    return <ZoteroSettings invoke={invoke} workspaces={[workspace]} info={info} settings={settings} onSettings={onSettings} onOpen={(mode, current) => setImporting({ mode, current })} />;
  if (own)
    return (
      <ZoteroSettings
        invoke={invoke}
        workspaces={[workspace]}
        target={workspace}
        info={info}
        settings={settings}
        onSettings={onSettings}
        onOpen={(mode, current) => setImporting({ mode, current, target: workspace.id })}
      />
    );
  const found = info.zoteroFound;
  return (
    <Group title="Zotero" help="zotero.import-vs-sync" intro="settings.zotero.intro" footer="Key only reads from Zotero. A workspace of its own keeps Zotero’s items apart; this workspace can take them too.">
      {zotero && (
        <Row label={`Zotero syncs into “${zotero.name}”`} detail={home(zotero.root)} path>
          <button className="kx-settings-button" onClick={() => onWorkspace(zotero.id)}>
            Edit its settings
          </button>
        </Row>
      )}
      {!zotero && (
        <Row label="Import into a Zotero workspace" detail={found ? "Creates a workspace named Zotero for what comes from Zotero" : "No Zotero library found on this Mac"}>
          <button className="kx-settings-button" disabled={!found} onClick={() => setImporting({ mode: "import" })}>
            Import…
          </button>
        </Row>
      )}
      <Row label={`Import into “${workspace.name}”`} help="zotero.this-workspace" detail={found ? "Adds Zotero’s items to this workspace; what is here already stays" : "No Zotero library found on this Mac"}>
        <button className="kx-settings-button" disabled={!found} onClick={() => setImporting({ mode: "import", target: workspace.id })}>
          Import…
        </button>
      </Row>
      <Row label={`Keep “${workspace.name}” in sync`} detail={found ? "Follows what you change in Zotero, through the Key Sync plugin" : "No Zotero library found on this Mac"}>
        <button className="kx-settings-button" disabled={!found} onClick={() => setImporting({ mode: "sync", target: workspace.id })}>
          Set up…
        </button>
      </Row>
    </Group>
  );
}

function Indexing({ invoke, workspaceId, ws }: { invoke: Invoke; workspaceId: string; ws: Ws }) {
  const status = useLibraryStatus(invoke, workspaceId);
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
  }, [invoke, workspaceId]);
  const references = (status as { references?: { title?: string; stage: string; done: number; total: number } | null } | undefined)?.references;
  const counts = status?.counts;
  const failed = counts?.attention ?? 0;
  const lookups = ws.state?.effective.lookups ?? true;
  const ownLookups = ws.state?.own.lookups;
  return (
    <>
      <Group title="Indexing" help="settings.search.indexing" footer={message || "Indexing reads each source once so search can find it. Sources you open or scroll to go first."}>
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
            <ActivityPanel activity={status.activity} modelReady={status.model.state === "ready"} onPause={setPaused} backfill={status.backfill} />
          </div>
        )}
        {references && (
          <Row label={references.stage === "detecting" ? "Finding references" : "Looking up references"} detail={`${references.title || "Untitled"}${references.total ? ` · ${references.done} of ${references.total}` : ""}`}>
            <span className="kx-search-spinner" aria-hidden="true" />
          </Row>
        )}
        <Row label="Pause indexing" detail="Stops reading new sources until Key quits. Search keeps working on what is already indexed.">
          <input type="checkbox" className="kx-switch" aria-label="Pause indexing" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
        </Row>
        <Row label="On battery" help="settings.indexing.battery" detail={BATTERY_MODES.find(([mode]) => mode === (ws.state?.effective.battery ?? "low"))?.[2]}>
          <select
            className="kx-settings-select"
            aria-label="Indexing on battery"
            value={ws.state?.effective.battery ?? "low"}
            disabled={!ws.state}
            onChange={(e) => void ws.patch({ battery: e.target.value as BatteryMode })}
          >
            {BATTERY_MODES.map(([mode, label]) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Retry failed sources" detail={failed ? `${failed.toLocaleString()} could not be read, often a damaged or password-protected PDF` : "None failed"}>
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
      <Group title="Lookups" help="settings.search.metadata" footer="Only identifiers and titles are sent to OpenAlex and Crossref, never your files or notes.">
        <Row
          label="Look up new sources in OpenAlex"
          detail={
            !lookups
              ? "Only when you ask"
              : status?.enrichment
                ? `${status.enrichment.toLocaleString()} waiting`
                : olderSources(status?.backfill)
                  ? `${olderSources(status?.backfill).toLocaleString()} older sources when idle`
                  : "Authors, journal, topics, citations and retraction checks"
          }
        >
          {ws.state && (
            <Overridable own={ownLookups != null} fallback={ws.state.app.lookups ? "On" : "Off"} onOwn={() => void ws.patch({ lookups: ws.state!.app.lookups })} onReset={() => void ws.patch({ lookups: null })}>
              <input type="checkbox" className="kx-switch" aria-label="Look up new sources in OpenAlex" checked={lookups} onChange={(e) => void ws.patch({ lookups: e.target.checked })} />
            </Overridable>
          )}
        </Row>
        <Row label="Find PDFs automatically" help="settings.libraries.find-pdf" detail="Look for a free, legal (open-access) PDF when a reference without one is added.">
          <input
            type="checkbox"
            className="kx-switch"
            aria-label="Find PDFs automatically when adding"
            disabled={!ws.state}
            checked={ws.state?.effective.findPdfOnAdd === true}
            onChange={(e) => void ws.patch({ findPdfOnAdd: e.target.checked })}
          />
        </Row>
        <PossibleDuplicates invoke={invoke} workspaceId={workspaceId} />
      </Group>
    </>
  );
}

/** People whose names might be one person: reviewed side by side, merged only when the user says so. */
function PossibleDuplicates({ invoke, workspaceId }: { invoke: Invoke; workspaceId: string }) {
  const [count, setCount] = useState<number>();
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    void invoke<MergeSuggestion[]>("store_merge_suggestions", {}, workspaceId)
      .then((list) => setCount(list.length))
      .catch(() => setCount(0));
  }, [invoke, workspaceId]);
  useEffect(load, [load]);
  return (
    <>
      <Row label="Possible duplicate people" help="settings.search.people" detail={count ? `${count} to review. Nothing is merged until you choose.` : "None to review"}>
        <button className="kx-settings-button" disabled={!count} onClick={() => setOpen(true)}>
          Review…
        </button>
      </Row>
      {open && (
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

/** The workspace's citation style: Key Settings' default, or one of its own. */
function CitationStyle({ invoke, workspaceId, ws }: { invoke: Invoke; workspaceId: string; ws: Ws }) {
  const [title, setTitle] = useState<string>();
  const state = ws.state;
  const own = !!state && (state.own.citationStyle != null || state.own.citationLocale != null);
  useEffect(() => {
    if (!state || own) return;
    void invoke<{ styles: { id: string; title: string }[] }>("store_cite_styles", {}, workspaceId)
      .then((l) => setTitle(l.styles.find((s) => s.id === state.app.citationStyle)?.title ?? state.app.citationStyle))
      .catch(() => setTitle(state.app.citationStyle));
  }, [invoke, workspaceId, state, own]);
  if (!state) return null;
  if (!own)
    return (
      <Group title="Citation style" footer="Citations, bibliographies and quotes in this workspace use Key Settings’ style unless it has its own.">
        <Row label="Style">
          <Overridable own={false} fallback={title ?? "…"} onOwn={() => void ws.patch({ citationStyle: state.app.citationStyle, citationLocale: state.app.citationLocale })} onReset={() => {}}>
            {null}
          </Overridable>
        </Row>
        <Row label="Default style for every workspace">
          <button className="kx-settings-link" onClick={() => openKeySettings("citations")}>
            Key Settings › Citations
          </button>
        </Row>
      </Group>
    );
  return (
    <>
      <CitationSettings
        invoke={invoke}
        workspaceId={workspaceId}
        style={state.effective.citationStyle}
        locale={state.effective.citationLocale}
        installed={false}
        title="Citation style for this workspace"
        footer="Citations, bibliographies and quotes in this workspace use this style instead of Key Settings’ default."
        onChange={(patch) => void ws.patch(patch)}
      />
      <Group>
        <Row label="Use Key Settings’ default instead">
          <button className="kx-settings-button" onClick={() => void ws.patch({ citationStyle: null, citationLocale: null })}>
            Use app default
          </button>
        </Row>
      </Group>
    </>
  );
}
