// The Zotero sheet. First: import once, or keep in sync through the Key Sync plugin. Then,
// for either: everything, chosen collections (a tree with item counts) or chosen papers (a
// searchable list), and what comes along; then progress and a summary. Importing again
// updates what was imported before and keeps edits made in Key. Opened again once Zotero is
// set up, the sheet starts on an overview of what is set up instead: the mode, how Zotero is
// reached, what is synced and when, with ways to change it, sync now, pause or stop.
import { Button } from "@key/design-system";
import { SegmentedTabs } from "@key-reader/ui/SegmentedTabs";
import { useEffect, useMemo, useRef, useState } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon, type IconName } from "./icons";
import {
  bridge,
  type Invoke,
  type WorkspaceSummary,
  type ZoteroInstall,
  type ZoteroItem,
  type ZoteroOptions,
  type ZoteroPreview,
  type ZoteroProbe,
  type ZoteroProgress,
  type ZoteroReport,
  type ZoteroStatus,
  type ZoteroSyncOutcome,
  type ZoteroSyncStatus,
} from "./library-api";
import { ago, blocker, choiceOf, filterItems, optionsOf, syncLine, type Choice, type Mode, type Scope } from "./zotero-sheet-model";
import "./zotero-import.css";

type Collection = ZoteroPreview["collections"][number];

const n = (value: number) => value.toLocaleString();
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;
const message = (e: unknown) => String(e).replace(/^Error: /, "");
/** Papers shown at once; a search narrows the rest. */
const PAPERS_SHOWN = 300;

export function ZoteroImportSheet(props: Omit<Props, "onDone"> & { onDone?: Props["onDone"] }) {
  const [busy, setBusy] = useState(false);
  return (
    <GlobalDrawer onClose={props.onClose} busy={busy} presentation="sheet" label="Zotero">
      <ZoteroImport overview {...props} onDone={props.onDone ?? (() => {})} onBusy={setBusy} />
    </GlobalDrawer>
  );
}

interface Props {
  invoke: Invoke;
  /** A workspace whose host reads the Zotero library for the preview. */
  workspaceId?: string;
  onClose: () => void;
  /** After a finished import or a first sync, with the workspace it went into. */
  onDone: (workspace: WorkspaceSummary, report: ZoteroReport, mode: Mode) => void;
  onBusy?: (busy: boolean) => void;
  /** Opens on the second step in this mode. */
  initialMode?: Mode;
  /** The sync's current options, when changing what it covers. */
  current?: ZoteroOptions | null;
  /** Start on what is already set up (when anything is), not on the first step. */
  overview?: boolean;
}

/** What Zotero is already set up as: the sync (through the plugin) and the last import. */
interface Existing {
  workspace: WorkspaceSummary;
  sync?: ZoteroSyncStatus;
  imported?: ZoteroStatus;
}

/** Tells the shell (the status bar) that Zotero's setup changed. */
const zoteroChanged = () => window.dispatchEvent(new CustomEvent("key:zotero-changed"));

export function ZoteroImport({ invoke, workspaceId, onClose, onDone, onBusy, initialMode, current: given, overview }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode ?? "import");
  const [step, setStep] = useState<"checking" | "overview" | "mode" | "scope">(initialMode ? "scope" : overview ? "checking" : "mode");
  const [current, setCurrent] = useState(given);
  const [existing, setExisting] = useState<Existing>();
  const [choice, setChoice] = useState<Choice>(() => choiceOf(given));
  const [preview, setPreview] = useState<ZoteroPreview>();
  const [items, setItems] = useState<ZoteroItem[]>();
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<ZoteroProgress | "starting">();
  const [result, setResult] = useState<{ workspace: WorkspaceSummary; report: ZoteroReport }>();
  const [probe, setProbe] = useState<ZoteroProbe>();
  const [token, setToken] = useState("");
  const [library, setLibrary] = useState<number>();
  /** Zotero's library proxies go to Key's browser too (not part of the host's options). */
  const [proxies, setProxies] = useState(true);
  const request = useMemo(() => optionsOf(choice), [choice]);
  const changing = !!current && mode === "sync";

  // What is set up already, read from the Zotero workspace (there once anything came across).
  const readExisting = async (): Promise<Existing | undefined> => {
    const zotero = (await bridge().workspaces?.().catch(() => []))?.find((w) => /\/Zotero$/.test(w.root));
    if (!zotero) return undefined;
    const [sync, imported] = await Promise.all([
      invoke<ZoteroSyncStatus>("store_zotero_plugin_status", {}, zotero.id).catch(() => undefined),
      invoke<ZoteroStatus>("store_zotero_status", {}, zotero.id).catch(() => undefined),
    ]);
    return sync?.configured || imported?.at ? { workspace: zotero, sync, imported } : undefined;
  };
  useEffect(() => {
    if (step !== "checking") return;
    let stale = false;
    void readExisting().then((found) => {
      if (stale) return;
      setExisting(found);
      if (!found) return setStep("mode");
      // The overview counts what the sync (or the last import) covers.
      const options = found.sync?.configured ? found.sync.options : found.imported?.options;
      setMode(found.sync?.configured ? "sync" : "import");
      setChoice(choiceOf(options));
      setStep("overview");
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  const refresh = async () => {
    const found = await readExisting();
    setExisting(found);
    zoteroChanged();
    if (!found) {
      setCurrent(undefined);
      setChoice(choiceOf(undefined));
      setMode("import");
      setStep("mode");
    }
  };
  const [acting, setActing] = useState<string>();
  const act = async (what: string, work: () => Promise<unknown>) => {
    setActing(what);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      await refresh();
      setActing(undefined);
    }
  };
  /** From the overview to the pickers, with what is set up ticked. */
  const change = (to: Mode) => {
    const options = existing?.sync?.configured ? existing.sync.options : existing?.imported?.options;
    setMode(to);
    setCurrent(to === "sync" && existing?.sync?.configured ? existing.sync.options : undefined);
    setChoice(choiceOf(options));
    setStep("scope");
  };

  // The counts follow every change of choice; the library is read once and kept by the host.
  useEffect(() => {
    if (step === "checking") return;
    let stale = false;
    const timer = setTimeout(() => {
      void invoke<ZoteroPreview>("store_zotero_preview", request as unknown as Record<string, unknown>, workspaceId)
        .then((p) => !stale && (setPreview(p), setError("")))
        .catch((e) => !stale && setError(message(e)));
    }, preview ? 150 : 0);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke, workspaceId, request, step === "checking"]);

  // The paper list, the first time it is needed.
  useEffect(() => {
    if (choice.scope !== "papers" || items) return;
    void invoke<ZoteroItem[]>("store_zotero_items", {}, workspaceId)
      .then(setItems)
      .catch((e) => setError(message(e)));
  }, [invoke, workspaceId, choice.scope, items]);

  // Sync: whether Zotero runs with the plugin, checked again until it does.
  const probeNow = async (given?: string) => {
    const zotero = (await bridge().workspaces?.().catch(() => []))?.find((w) => /\/Zotero$/.test(w.root));
    const answer = await invoke<ZoteroProbe>("store_zotero_plugin_probe", given ? { token: given } : {}, zotero?.id ?? workspaceId).catch(
      (e): ZoteroProbe => ({ connection: "error", message: message(e), libraries: [] }),
    );
    setProbe(answer);
    return answer;
  };
  const connected = probe?.connection === "ok";
  useEffect(() => {
    if (mode !== "sync" || step !== "scope" || connected) return;
    let stopped = false;
    const check = () => void probeNow(token || undefined).then(() => !stopped && undefined);
    check();
    const timer = setInterval(check, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, step, connected, invoke, workspaceId]);

  const running = progress !== undefined && !result;
  useEffect(() => onBusy?.(running), [running, onBusy]);

  const pollProgress = (workspace: string) => {
    let polling = true;
    void (async () => {
      while (polling) {
        const p = await invoke<ZoteroProgress | null>("store_zotero_progress", {}, workspace).catch(() => null);
        if (polling && p) setProgress(p);
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    return () => (polling = false);
  };

  const start = async () => {
    setError("");
    setProgress("starting");
    let stop = () => {};
    try {
      const workspace = await bridge().zoteroWorkspace();
      stop = pollProgress(workspace.id);
      if (mode === "import") {
        const done = await bridge().importZotero({ ...request, ...(proxies ? { proxies: true } : {}) } as typeof request);
        zoteroChanged();
        setResult(done);
        onDone(done.workspace, done.report, mode);
        return;
      }
      await invoke(
        "store_zotero_plugin_configure",
        {
          options: request,
          paused: false,
          ...(probe?.tokenSource === "given" && token ? { token } : {}),
          ...(library ?? probe?.defaultLibraryID ? { libraryID: library ?? probe?.defaultLibraryID } : {}),
        },
        workspace.id,
      );
      const outcome = await invoke<ZoteroSyncOutcome>("store_zotero_plugin_sync", { force: true }, workspace.id);
      if (outcome.connection !== "ok" || !outcome.report) throw new Error(outcome.message || "Zotero did not answer. Key will try again on its own.");
      void bridge().zoteroPlugin?.("wake").catch(() => {});
      zoteroChanged();
      if (proxies) void (window as unknown as { key: { proxies?(action: string, payload?: unknown): Promise<unknown> } }).key.proxies?.("import", { follow: true }).catch(() => {});
      setResult({ workspace, report: outcome.report });
      onDone(workspace, outcome.report, mode);
    } catch (e) {
      setProgress(undefined);
      setError(message(e));
    } finally {
      stop();
    }
  };

  const blocked = blocker(mode, choice, probe?.connection);
  const verb = mode === "import" ? "import" : "sync";
  const syncing = !!existing?.sync?.configured;
  const title = step === "overview" || step === "checking"
    ? "Zotero"
    : step === "mode"
      ? "Bring in your Zotero library"
      : changing ? "Change what Key syncs" : mode === "import" ? "Import from Zotero" : "Keep in sync with Zotero";
  const lede =
    step === "checking"
      ? ""
      : step === "overview"
        ? syncing
          ? `“${existing!.workspace.name}” is kept in sync with Zotero. Key only reads from Zotero.`
          : `Imported into “${existing!.workspace.name}” ${ago(existing?.imported?.at, Date.now())}. Key only reads from Zotero.`
        : step === "mode"
      ? "Key only reads from Zotero; nothing there is changed."
      : mode === "import"
        ? preview
          ? `From ${preview.dataDir.replace(/^\/Users\/[^/]+/, "~")}. Importing again later updates what came across.`
          : "Reading your Zotero library…"
        : "Changes made in Zotero come to Key while both apps are open; edits made in Key are kept.";
  return (
    <div className="key-property-editor kx-zotero-import" role="dialog" aria-label={title} data-step={result || running ? "done" : step} data-scope={choice.scope}>
      <header>
        <h2>{title}</h2>
        <p>{lede}</p>
        <button className="kx-sheet-close" aria-label="Close" disabled={running} onClick={onClose}>
          <Icon name="close" size={10} />
        </button>
      </header>
      <div className="key-property-body">
        {result ? (
          <Summary report={result.report} workspace={result.workspace} mode={mode} />
        ) : running ? (
          <ProgressView progress={progress} preview={preview} mode={mode} />
        ) : step === "checking" ? (
          <div className="kx-zotero-checking" aria-busy="true" />
        ) : step === "overview" && existing ? (
          <Overview existing={existing} choice={choice} preview={preview} />
        ) : step === "mode" ? (
          <div className="kx-zotero-modes" role="radiogroup" aria-label="How to bring it in">
            <ModeCard
              icon="download"
              title="Import once"
              detail="Copies items, notes and highlights into Key now. Later changes in Zotero stay in Zotero until you import again."
              note="Works on its own"
              checked={mode === "import"}
              onChoose={() => setMode("import")}
            />
            <ModeCard
              icon="sync"
              title="Keep in sync"
              detail="Follows what you add, change, move and delete in Zotero, and catches up on what happened while Key was closed."
              note="Uses the Key Sync plugin for Zotero"
              checked={mode === "sync"}
              onChoose={() => setMode("sync")}
            />
          </div>
        ) : (
          <div className="kx-zotero-scope">
            {mode === "sync" && (
              <PluginPanel
                probe={probe}
                token={token}
                onToken={setToken}
                onPair={() => void probeNow(token.trim())}
                onCheck={() => void probeNow(token.trim() || undefined)}
              />
            )}
            <section className="kx-form-section kx-zotero-what">
              <div className="kx-zotero-scope-head">
                <h3>What to {verb}</h3>
                {mode === "sync" && connected && probe!.libraries.length > 1 && (
                  <select className="kx-zotero-library" aria-label="Zotero library" value={library ?? probe?.defaultLibraryID ?? ""} onChange={(e) => setLibrary(Number(e.target.value))}>
                    {probe!.libraries.map((l) => (
                      <option key={l.libraryID} value={l.libraryID}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <ScopePicker scope={choice.scope} preview={preview} onChange={(scope) => setChoice({ ...choice, scope })} />
              {choice.scope === "collections" && preview && (
                <CollectionTree collections={preview.collections} chosen={choice.collections} onChange={(collections) => setChoice({ ...choice, collections })} />
              )}
              {choice.scope === "papers" && <PaperPicker items={items} chosen={choice.papers} onChange={(papers) => setChoice({ ...choice, papers })} />}
            </section>
            <section className="kx-form-section kx-zotero-bring">
              <h3>Bring along</h3>
              <div className="kx-form-group">
                <Toggle label="PDFs and other files" detail="Linked where Zotero keeps them; nothing is copied." checked={choice.bring.attachments} onChange={(attachments) => setChoice({ ...choice, bring: { ...choice.bring, attachments } })} />
                <Toggle label="Notes" detail="Converted to Markdown, with highlights as quotes." checked={choice.bring.notes} onChange={(notes) => setChoice({ ...choice, bring: { ...choice.bring, notes } })} />
                <Toggle label="PDF annotations" detail="Each PDF’s highlights and comments, as a note of quotes." checked={choice.bring.annotations} onChange={(annotations) => setChoice({ ...choice, bring: { ...choice.bring, annotations } })} />
                <Toggle label="Zotero collections" detail="Recreated as Key collections, with items filed in them." checked={choice.bring.mirrorCollections} onChange={(mirrorCollections) => setChoice({ ...choice, bring: { ...choice.bring, mirrorCollections } })} />
                <Toggle label="Library proxies" detail="Your EZproxy or OpenAthens access from Zotero and its Connector, for Key’s browser." checked={proxies} onChange={setProxies} />
              </div>
            </section>
          </div>
        )}
        {error && !running && <p className="kx-inline-error">{error}</p>}
      </div>
      <footer>
        {step === "scope" && !result && !running && (
          <span className="kx-zotero-count" aria-live="polite">
            {blocked && (choice.scope !== "library" || mode === "sync") ? blocked : preview ? <Counts counts={preview.selected} /> : null}
          </span>
        )}
        {step === "overview" && existing && !result && !running && (
          <Button
            type="button"
            className="kx-zotero-stop"
            disabled={!!acting}
            onClick={() => {
              if (!syncing) return change("sync");
              if (window.confirm("Stop keeping this library in sync with Zotero? What came from Zotero stays in Key."))
                void act("stop", () => invoke("store_zotero_plugin_configure", { remove: true }, existing.workspace.id).then(() => bridge().zoteroPlugin?.("wake")));
            }}
          >
            {syncing ? "Stop syncing" : "Keep in sync instead…"}
          </Button>
        )}
        <span className="kx-footer-spacer" />
        {result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : step === "checking" ? (
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        ) : step === "overview" && existing ? (
          syncing ? (
            <>
              <Button
                type="button"
                disabled={!!acting}
                onClick={() => void act("pause", () => invoke("store_zotero_plugin_configure", { paused: !existing.sync!.paused }, existing.workspace.id).then(() => bridge().zoteroPlugin?.("wake")))}
              >
                {existing.sync!.paused ? "Resume" : "Pause"}
              </Button>
              {!existing.sync!.paused && (
                <Button
                  type="button"
                  disabled={!!acting}
                  onClick={() => void act("sync", () => invoke("store_zotero_plugin_sync", { force: true }, existing.workspace.id))}
                >
                  {acting === "sync" ? "Syncing…" : "Sync now"}
                </Button>
              )}
              <Button variant="primary" className="key-property-primary" disabled={!!acting} onClick={() => change("sync")}>
                Change what syncs…
              </Button>
            </>
          ) : (
            <>
              <Button type="button" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" className="key-property-primary" onClick={() => change("import")}>
                Import again…
              </Button>
            </>
          )
        ) : step === "mode" ? (
          <>
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" className="key-property-primary" onClick={() => setStep("scope")}>
              Continue
            </Button>
          </>
        ) : (
          <>
            {!initialMode ? (
              <Button type="button" disabled={running} onClick={() => setStep(existing ? "overview" : "mode")}>
                Back
              </Button>
            ) : (
              <Button type="button" disabled={running} onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button
              variant="primary"
              className="key-property-primary"
              disabled={running || !!blocked || (mode === "import" && (!preview || !preview.selected.items))}
              onClick={() => void start()}
            >
              {running ? (mode === "import" ? "Importing…" : "Syncing…") : changing ? "Save and sync" : mode === "import" ? "Import" : "Start syncing"}
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}

/** What is set up: the mode, how Zotero is reached, what is covered and when it last ran. */
function Overview({ existing, choice, preview }: { existing: Existing; choice: Choice; preview?: ZoteroPreview }) {
  const now = Date.now();
  const { sync, imported } = existing;
  const syncing = !!sync?.configured;
  const names = (keys: Set<string>) =>
    preview?.collections
      .filter((c) => keys.has(c.key))
      .map((c) => c.name)
      .sort((a, b) => a.localeCompare(b)) ?? [];
  const chosen = names(choice.collections);
  const what =
    choice.scope === "library"
      ? "Everything"
      : choice.scope === "collections"
        ? `${plural(choice.collections.size, "collection")}${chosen.length ? `: ${chosen.slice(0, 4).join(", ")}${chosen.length > 4 ? ` and ${n(chosen.length - 4)} more` : ""}` : ""}`
        : plural(choice.papers.size, "chosen paper");
  const bring = [
    choice.bring.attachments && "PDFs and files",
    choice.bring.notes && "notes",
    choice.bring.annotations && "PDF annotations",
    choice.bring.mirrorCollections && "collections",
  ].filter(Boolean) as string[];
  const report = syncing ? sync!.report : imported?.report;
  const tone = !syncing ? "off" : sync!.paused ? "off" : sync!.connection === "ok" || !sync!.connection ? "ready" : sync!.connection === "not-running" ? "idle" : "warning";
  return (
    <div className="kx-zotero-overview">
      <div className="kx-zotero-state" data-tone={tone} role="status">
        <span className="kx-zotero-state-light" aria-hidden="true" />
        <div>
          <strong>{syncing ? (sync!.paused ? "Sync paused" : "Keeping in sync") : "Imported once"}</strong>
          <span>{syncing ? syncLine(sync!, now) : `Last import ${ago(imported?.at, now)}. Later changes in Zotero come across when you import again.`}</span>
          {syncing && (sync!.zoteroVersion || sync!.pluginVersion) && (
            <small>{[sync!.libraryName, sync!.zoteroVersion && `Zotero ${sync!.zoteroVersion}`, sync!.pluginVersion && `Key Sync ${sync!.pluginVersion}`].filter(Boolean).join(" · ")}</small>
          )}
        </div>
      </div>
      <dl className="kx-zotero-facts">
        <dt>{syncing ? "Syncing" : "Imported"}</dt>
        <dd data-fact="scope">
          {what}
          {preview && (
            <small>
              <Counts counts={preview.selected} />
            </small>
          )}
        </dd>
        <dt>In Key</dt>
        <dd data-fact="items">
          {plural(syncing ? sync!.items : (report?.items ?? 0), "item")} in “{existing.workspace.name}”
          {syncing && <small>{sync!.syncedAt ? `Last synced ${ago(sync!.syncedAt, now)}` : "Not synced yet"}</small>}
        </dd>
        <dt>Brought along</dt>
        <dd data-fact="bring">{bring.length ? bring.join(", ").replace(/^./, (c) => c.toUpperCase()) : "Items only"}</dd>
        {report && (
          <>
            <dt>Last run</dt>
            <dd data-fact="report">
              {[
                report.added ? `${plural(report.added, "item")} added` : "",
                report.updated ? `${plural(report.updated, "item")} updated` : "",
                report.unchanged ? `${n(report.unchanged)} up to date` : "",
              ]
                .filter(Boolean)
                .join(" · ") || "Nothing changed"}
            </dd>
          </>
        )}
      </dl>
      {!!report?.conflictCount && <Conflicts report={report} />}
    </div>
  );
}

function ModeCard({ icon, title, detail, note, checked, onChoose }: { icon: IconName; title: string; detail: string; note: string; checked: boolean; onChoose: () => void }) {
  return (
    <button className="kx-zotero-mode" role="radio" aria-checked={checked} onClick={onChoose}>
      <span className="kx-zotero-mode-icon">
        <Icon name={icon} size={18} />
      </span>
      <span className="kx-zotero-mode-text">
        <strong>{title}</strong>
        <span>{detail}</span>
        <small>{note}</small>
      </span>
      <span className="kx-zotero-mode-check" aria-hidden="true">
        {checked && <Icon name="check" size={11} />}
      </span>
    </button>
  );
}

const SCOPES: [Scope, string][] = [
  ["library", "Everything"],
  ["collections", "Collections"],
  ["papers", "Papers"],
];

function ScopePicker({ scope, preview, onChange }: { scope: Scope; preview?: ZoteroPreview; onChange: (scope: Scope) => void }) {
  const detail =
    scope === "library"
      ? preview
        ? `The whole library: ${plural(preview.library.items, "item")} in ${plural(preview.collections.length, "collection")}.`
        : "The whole library."
      : scope === "collections"
        ? "Items in the collections you tick. Ticking one includes the collections inside it."
        : "Only the papers you tick.";
  return (
    <>
      <SegmentedTabs
        className="kx-zotero-scope-tabs"
        label="Scope"
        value={scope}
        onChange={onChange}
        tabs={SCOPES.map(([id, label]) => ({ id, label, disabled: id === "collections" && !!preview && !preview.collections.length }))}
      />
      <p className="kx-zotero-scope-detail">{detail}</p>
    </>
  );
}

/** What Zotero needs before Key can sync with it, and a quiet confirmation once it can. */
function PluginPanel({ probe, token, onToken, onPair, onCheck }: { probe?: ZoteroProbe; token: string; onToken: (token: string) => void; onPair: () => void; onCheck: () => void }) {
  const state = probe?.connection;
  if (state === "ok")
    return (
      <div className="kx-zotero-plugin kx-zotero-plugin-ok" role="status">
        <Icon name="check" size={13} />
        <span>
          Connected to Zotero {probe?.zoteroVersion ?? ""} · Key Sync {probe?.pluginVersion ?? ""}
        </span>
      </div>
    );
  return (
    <div className="kx-zotero-plugin" role="status" aria-live="polite">
      <span className="kx-zotero-plugin-icon">
        <Icon name="puzzle" size={16} />
      </span>
      <div className="kx-zotero-plugin-text">
        {state === undefined ? (
          <strong>Looking for Zotero…</strong>
        ) : state === "unpaired" ? (
          <>
            <strong>Pair Key with Zotero</strong>
            <span>Copy the pairing code from Zotero → Settings → Key Sync.</span>
            <div className="kx-zotero-token">
              <input type="text" aria-label="Pairing code" placeholder="Pairing code" spellCheck={false} value={token} onChange={(e) => onToken(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onPair()} />
              <button className="kx-settings-button" disabled={!token.trim()} onClick={onPair}>
                Pair
              </button>
            </div>
          </>
        ) : state === "error" ? (
          <>
            <strong>Zotero did not answer</strong>
            <span>{probe?.message}</span>
            <div className="kx-zotero-plugin-actions">
              <button className="kx-settings-button" onClick={onCheck}>
                Check again
              </button>
            </div>
          </>
        ) : (
          <PluginInstall probe={probe} onCheck={onCheck} />
        )}
      </div>
    </div>
  );
}

type InstallAction = "install" | "restart" | "open";

/** Installing Key Sync into Zotero from here: install, then restart or open Zotero. */
function PluginInstall({ probe, onCheck }: { probe?: ZoteroProbe; onCheck: () => void }) {
  const [install, setInstall] = useState<ZoteroInstall>();
  const [busy, setBusy] = useState<InstallAction>();
  const [error, setError] = useState("");
  const [manual, setManual] = useState(false);
  // Read again after every probe: Zotero may have been started, quit or restarted meanwhile.
  useEffect(() => {
    if (busy) return;
    let stale = false;
    void bridge()
      .zoteroPlugin?.("status")
      .then((r) => !stale && r?.install && setInstall(r.install))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [probe, busy]);
  const act = async (action: InstallAction) => {
    setBusy(action);
    setError("");
    try {
      const r = await bridge().zoteroPlugin?.(action);
      if (r?.install) setInstall(r.install);
      if (r?.error) {
        setError(r.error);
        if (action === "install") setManual(true);
      }
    } catch (e) {
      setError(message(e));
      if (action === "install") setManual(true);
    } finally {
      setBusy(undefined);
      onCheck();
    }
  };
  const reveal = async () => {
    const plugin = await bridge().zoteroPlugin?.();
    if (plugin?.file) await bridge().revealPath(plugin.file);
  };
  const running = probe?.connection === "plugin-missing" || !!install?.running;
  const s = install?.state;
  const version = install?.bundledVersion ? ` ${install.bundledVersion}` : "";
  let title: string;
  let detail: string;
  let primary: { action: InstallAction; label: string } | undefined;
  if (!install) {
    title = running ? "Install the Key Sync plugin in Zotero" : "Open Zotero to keep it in sync";
    detail = "Checking Zotero…";
  } else if (s === "no-zotero") {
    title = "Zotero is not set up on this Mac";
    detail = "Key could not find a Zotero profile. Install Zotero and open it once, or add the plugin by hand.";
  } else if (s === "not-installed" || s === "outdated") {
    title = s === "outdated" ? `Update Key Sync to${version}` : "Install the Key Sync plugin in Zotero";
    detail =
      s === "outdated"
        ? `Zotero has Key Sync ${install.installedVersion ?? ""}. The update comes with Key.`
        : "It tells Key what changes in Zotero. Key adds it to Zotero for you; it only reads your library.";
    primary = { action: "install", label: s === "outdated" ? "Update in Zotero" : "Install in Zotero" };
  } else if (s === "pending") {
    title = running ? "Restart Zotero to finish" : "Open Zotero to finish";
    detail = running ? "Key Sync is in place. Zotero turns it on when it starts again; it may ask you to save first." : "Key Sync is in place. Zotero turns it on when it starts.";
    primary = running ? { action: "restart", label: "Restart Zotero" } : { action: "open", label: "Open Zotero" };
  } else if (s === "disabled") {
    title = "Turn on Key Sync in Zotero";
    detail = "The plugin is installed but switched off. In Zotero, choose Tools → Plugins and enable Key Sync.";
    if (!running) primary = { action: "open", label: "Open Zotero" };
  } else if (running) {
    title = "Zotero is starting Key Sync…";
    detail = "Key Sync is installed. If this does not change, restart Zotero.";
    primary = { action: "restart", label: "Restart Zotero" };
  } else {
    title = "Open Zotero to keep it in sync";
    detail = "Key Sync is installed. Key reaches Zotero while it runs.";
    primary = { action: "open", label: "Open Zotero" };
  }
  const label = busy === "install" ? "Installing…" : busy === "restart" ? "Restarting Zotero…" : busy === "open" ? "Opening Zotero…" : primary?.label;
  return (
    <>
      <strong>{title}</strong>
      <span>{detail}</span>
      {(manual || s === "no-zotero") && (
        <ol>
          <li>Show the plugin file in Finder.</li>
          <li>In Zotero, choose Tools → Plugins and drag “key-sync.xpi” onto that window.</li>
          <li>Come back here. Key notices the plugin by itself.</li>
        </ol>
      )}
      {error && <span className="kx-zotero-plugin-error">{error}</span>}
      <div className="kx-zotero-plugin-actions">
        {primary && (
          <button className="kx-settings-button kx-zotero-plugin-primary" disabled={!!busy} onClick={() => void act(primary!.action)}>
            {label}
          </button>
        )}
        <button className="kx-settings-button" disabled={!!busy} onClick={() => void reveal()}>
          Show plugin file
        </button>
        <button className="kx-settings-button" disabled={!!busy} onClick={onCheck}>
          Check again
        </button>
      </div>
    </>
  );
}

/** A searchable list of the library's papers, each with a checkbox. */
function PaperPicker({ items, chosen, onChange }: { items?: ZoteroItem[]; chosen: Set<string>; onChange: (chosen: Set<string>) => void }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterItems(items ?? [], query), [items, query]);
  const visible = shown.slice(0, PAPERS_SHOWN);
  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen);
    on ? next.add(key) : next.delete(key);
    onChange(next);
  };
  return (
    <div className="kx-zotero-tree kx-zotero-papers">
      <div className="kx-zotero-search">
        <Icon name="search" size={13} />
        <input type="search" aria-label="Search papers" placeholder="Search titles, authors and years" value={query} onChange={(e) => setQuery(e.target.value)} />
        {chosen.size > 0 && (
          <button onClick={() => onChange(new Set())} title="Clear the choice">
            {n(chosen.size)} chosen
          </button>
        )}
      </div>
      <div role="listbox" aria-label="Zotero papers" aria-multiselectable="true">
        {!items ? (
          <p className="kx-zotero-empty">Reading your Zotero library…</p>
        ) : !shown.length ? (
          <p className="kx-zotero-empty">No papers match “{query}”.</p>
        ) : (
          visible.map((item) => (
            <label key={item.key} className="kx-zotero-paper" role="option" aria-selected={chosen.has(item.key)}>
              <input type="checkbox" aria-label={item.title} checked={chosen.has(item.key)} onChange={(e) => toggle(item.key, e.target.checked)} />
              <span className="kx-zotero-paper-text">
                <span className="kx-zotero-name">{item.title}</span>
                <small>{[item.creators, item.year].filter(Boolean).join(" · ") || item.itemType}</small>
              </span>
              {item.hasFile && <Icon name="doc" size={12} aria-label="Has a file" />}
            </label>
          ))
        )}
        {shown.length > visible.length && <p className="kx-zotero-empty">Showing {n(visible.length)} of {n(shown.length)}. Search to find the rest.</p>}
      </div>
    </div>
  );
}

function Counts({ counts }: { counts: ZoteroPreview["selected"] }) {
  const parts = [plural(counts.items, "item")];
  if (counts.files) parts.push(plural(counts.files, "file"));
  if (counts.notes) parts.push(plural(counts.notes, "note"));
  if (counts.annotations) parts.push(plural(counts.annotations, "annotation"));
  return <>{parts.join(" · ")}</>;
}

function Toggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="kx-form-row kx-zotero-toggle">
      <span>
        {label}
        <small>{detail}</small>
      </span>
      <input type="checkbox" className="kx-switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Collections as a tree. Choosing one chooses everything inside it. */
export function CollectionTree({ collections, chosen, onChange }: { collections: Collection[]; chosen: Set<string>; onChange: (chosen: Set<string>) => void }) {
  const children = useMemo(() => {
    const map = new Map<string | null, Collection[]>();
    const known = new Set(collections.map((c) => c.key));
    for (const c of collections) {
      const parent = c.parentKey && known.has(c.parentKey) ? c.parentKey : null;
      map.set(parent, [...(map.get(parent) ?? []), c]);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [collections]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const descendants = (key: string): string[] => (children.get(key) ?? []).flatMap((c) => [c.key, ...descendants(c.key)]);
  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen);
    for (const k of [key, ...descendants(key)]) on ? next.add(k) : next.delete(k);
    onChange(next);
  };
  const rows = (parent: string | null, depth: number): React.ReactNode[] =>
    (children.get(parent) ?? []).flatMap((c) => {
      const inner = descendants(c.key);
      const some = inner.some((k) => chosen.has(k));
      const expanded = open.has(c.key);
      return [
        <div key={c.key} className="kx-zotero-collection" style={{ paddingLeft: 8 + depth * 18 }} role="treeitem" aria-level={depth + 1} aria-expanded={inner.length ? expanded : undefined}>
          {inner.length ? (
            <button
              className="kx-zotero-disclosure"
              aria-label={expanded ? `Collapse ${c.name}` : `Expand ${c.name}`}
              data-open={expanded || undefined}
              onClick={() => {
                const next = new Set(open);
                expanded ? next.delete(c.key) : next.add(c.key);
                setOpen(next);
              }}
            >
              <Icon name="chevronRight" size={10} />
            </button>
          ) : (
            <span className="kx-zotero-disclosure" />
          )}
          <label>
            <TriState checked={chosen.has(c.key)} mixed={!chosen.has(c.key) && some} onChange={(on) => toggle(c.key, on)} label={c.name} />
            <Icon name="folder" size={13} />
            <span className="kx-zotero-name">{c.name}</span>
            <span className="kx-zotero-items">{n(c.total)}</span>
          </label>
        </div>,
        ...(expanded ? rows(c.key, depth + 1) : []),
      ];
    });
  const all = collections.length > 0 && collections.every((c) => chosen.has(c.key));
  return (
    <div className="kx-zotero-tree">
      <div className="kx-zotero-tree-tools">
        <button onClick={() => onChange(all ? new Set() : new Set(collections.map((c) => c.key)))}>{all ? "Choose none" : "Choose all"}</button>
        <button onClick={() => setOpen(open.size ? new Set() : new Set(collections.map((c) => c.key)))}>{open.size ? "Collapse all" : "Expand all"}</button>
      </div>
      <div role="tree" aria-label="Zotero collections" aria-multiselectable="true">
        {rows(null, 0)}
      </div>
    </div>
  );
}

function TriState({ checked, mixed, onChange, label }: { checked: boolean; mixed: boolean; onChange: (on: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return <input ref={ref} type="checkbox" aria-label={label} aria-checked={mixed ? "mixed" : checked} checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

const STAGES: Record<string, string> = {
  starting: "Preparing…",
  reading: "Reading your Zotero library…",
  fetching: "Fetching from Zotero",
  items: "Bringing items across",
  notes: "Converting notes",
  saving: "Finishing…",
};

function ProgressView({ progress, preview, mode }: { progress: ZoteroProgress | "starting" | undefined; preview?: ZoteroPreview; mode: Mode }) {
  const p = typeof progress === "object" ? progress : undefined;
  const stage = p?.stage ?? "starting";
  return (
    <div className="kx-zotero-progress" aria-live="polite">
      <strong>{STAGES[stage] ?? (mode === "import" ? "Importing…" : "Syncing…")}</strong>
      {p && p.total > 0 ? <progress max={p.total} value={p.done} /> : <progress />}
      <small>{p && p.total > 0 ? `${n(p.done)} of ${n(p.total)}` : preview ? <Counts counts={preview.selected} /> : null}</small>
    </div>
  );
}

function Summary({ report, workspace, mode }: { report: ZoteroReport; workspace: WorkspaceSummary; mode: Mode }) {
  const lines = [
    report.added && `${plural(report.added, "item")} added`,
    report.updated && `${plural(report.updated, "item")} updated`,
    report.unchanged && `${plural(report.unchanged, "item")} already up to date`,
    report.collections && `${plural(report.collections, "collection")} created`,
    report.notes && `${plural(report.notes, "note")} added`,
    report.notesUpdated && `${plural(report.notesUpdated, "note")} converted or updated`,
    report.linkedFiles && `${plural(report.linkedFiles, "file")} linked`,
    report.missingFiles && `${plural(report.missingFiles, "file")} not found on this Mac`,
    report.keptDeleted && `${plural(report.keptDeleted, "item")} you deleted in Key left out`,
    report.unlinked && `${plural(report.unlinked, "item")} outside the new choice kept, no longer synced`,
  ].filter(Boolean) as string[];
  return (
    <div className="kx-zotero-summary">
      <span className="kx-zotero-done">
        <Icon name={mode === "sync" ? "sync" : "check"} size={16} />
      </span>
      <strong>{mode === "sync" ? `“${workspace.name}” is in sync with Zotero` : `Imported into “${workspace.name}”`}</strong>
      <ul>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {mode === "sync" && <small>Key keeps following Zotero while both are open. Pause or change the sync from Zotero in the status bar.</small>}
      {report.conflictCount > 0 && <Conflicts report={report} />}
    </div>
  );
}

/** Values kept in Key although Zotero changed them too. */
export function Conflicts({ report }: { report: ZoteroReport }) {
  return (
    <details className="kx-zotero-conflicts">
      <summary>
        {plural(report.conflictCount, "edit")} made in Key {report.conflictCount === 1 ? "was" : "were"} kept over Zotero’s
      </summary>
      <ul>
        {report.conflicts.map((c, i) => (
          <li key={i}>
            <strong>{c.title || "Untitled"}</strong> · {c.what}
            <small>{c.detail}</small>
          </li>
        ))}
      </ul>
    </details>
  );
}
