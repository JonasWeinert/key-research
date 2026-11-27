// The workspaces window: Key's mark and the ways to start on the left, the workspaces on the
// right. Sheets (create, rename, look, settings) load on first use (sheets.tsx).
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../icons";
import appIcon from "../../../../../../key/src-tauri/icons/icon.png";
import { Explain } from "../explain";
import { key, launcher, ltr, message, tilde, type LauncherState, type LauncherWorkspace } from "./api";
import type { Sheet } from "./sheets";

const Sheets = lazy(() => import("./sheets"));

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function opened(at?: number) {
  if (!at) return "Not opened yet";
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days < 7) return `Opened ${relative.format(-days, "day")}`;
  return `Opened ${new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(days > 300 ? { year: "numeric" } : {}) })}`;
}
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const textField = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

export default function Launcher() {
  const [state, setState] = useState<LauncherState>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [sheet, setSheet] = useState<Sheet>();
  const [error, setError] = useState("");
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Sheets stay mounted once used, so they can animate out.
  const sheetsUsed = useRef(false);
  if (sheet) sheetsUsed.current = true;

  const refresh = useCallback(() => launcher<LauncherState>("state").then(setState, (e) => setError(message(e))), []);
  useEffect(() => {
    void refresh();
    return key().on("launcher-changed", () => void refresh());
  }, [refresh]);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(""), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const workspaces = state?.workspaces ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? workspaces.filter((w) => w.name.toLowerCase().includes(q) || w.root.toLowerCase().includes(q)) : workspaces;
  }, [workspaces, query]);
  const current = shown[Math.min(selected, shown.length - 1)];
  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, shown.length]);

  const run = useCallback(async (work: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, []);
  const open = useCallback(
    (w: LauncherWorkspace | undefined, newWindow = false) => {
      if (!w) return;
      if (w.missing) return void run(() => launcher("locate", { id: w.id }));
      void run(() => launcher("open", { id: w.id, newWindow }));
    },
    [run],
  );
  const addFolder = () => void run(() => launcher("add-folder"));
  const importZotero = () => void run(() => launcher("import-zotero"));

  // Commands from the app menu, the Dock menu and the row's context menu.
  useEffect(
    () =>
      key().on("launcher-command", (value) => {
        const { command, id, message: text } = (value ?? {}) as { command?: string; id?: string; message?: string };
        if (command === "error") setError(text ?? "");
        else if (command === "new") setSheet({ kind: "new" });
        else if (command === "settings") setSheet({ kind: "settings" });
        else if (command === "add-folder") addFolder();
        else if ((command === "rename" || command === "appearance") && id) setSheet({ kind: command, id });
      }),
    [],
  );

  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (sheet || e.defaultPrevented) return;
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!shown.length) return;
        setSelected((i) => Math.max(0, Math.min(shown.length - 1, Math.min(i, shown.length - 1) + (e.key === "ArrowDown" ? 1 : -1))));
      } else if (e.key === "Enter") {
        e.preventDefault();
        // The first run's main button is the default one.
        if (!workspaces.length) document.querySelector<HTMLButtonElement>(".kx-launcher-welcome .kx-button-primary")?.click();
        else open(current, meta);
      } else if (meta && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setSheet({ kind: "new" });
      } else if (meta && e.key.toLowerCase() === "f") {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      } else if ((e.key === "Backspace" || e.key === "Delete") && current && (meta || !textField(e.target) || !query)) {
        e.preventDefault();
        void run(() => launcher("remove", { id: current.id }));
      } else if (e.key === "Escape" && query) {
        setQuery("");
      } else if (!meta && !e.altKey && e.key.length === 1 && !textField(e.target)) {
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [sheet, shown, current, query, open, run, workspaces.length]);

  // A folder dragged onto the window joins the list.
  const drop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const paths = Array.from(e.dataTransfer.files).map((f) => key().pathForFile(f)).filter(Boolean);
    await run(async () => {
      let added: { id: string } | null = null;
      for (const path of paths) added = await launcher<{ id: string } | null>("add-folder", { path, open: false });
      await refresh();
      if (added) setQuery("");
    });
  };

  const info = state?.info;
  const empty = !!state && !workspaces.length;
  return (
    <div
      className="kx-launcher"
      data-dropping={dropping || undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => void drop(e)}
    >
      <aside className="kx-launcher-side">
        <div className="kx-launcher-brand">
          <img src={appIcon} alt="" width={72} height={72} draggable={false} />
          <h1>Key</h1>
          <p>{info ? `Version ${info.version}` : " "}</p>
        </div>
        <nav className="kx-launcher-actions" aria-label="Start">
          <Action icon="plus" label="New workspace…" hint="⌘N" onClick={() => setSheet({ kind: "new" })} />
          <Action icon="folder" label="Open folder as workspace…" hint="⌘O" onClick={addFolder} />
          <Action icon="zotero" label="Import from Zotero…" disabled={busy || (info && !info.zoteroFound)} title={info && !info.zoteroFound ? "No Zotero library was found on this Mac" : undefined} onClick={importZotero} />
        </nav>
        <footer className="kx-launcher-links">
          <button type="button" onClick={() => setSheet({ kind: "settings" })}>
            <Icon name="gear" size={13} />
            Settings
          </button>
          <button type="button" disabled={!info?.notices} onClick={() => void run(() => launcher("acknowledgements"))}>
            Acknowledgements
          </button>
        </footer>
      </aside>
      <main className="kx-launcher-main" aria-label="Workspaces">
        {empty ? (
          <Welcome
            busy={busy}
            zotero={!!info?.zoteroFound}
            onCreate={() =>
              // The first library goes where Key has always put it; the welcome in its window takes over.
              void run(() => launcher("create", { name: "Personal", path: `${info!.workspaceParent}/Personal`, adopt: true }))
            }
            onChoose={() => setSheet({ kind: "new", name: "Personal" })}
            onOpen={addFolder}
            onZotero={importZotero}
          />
        ) : (
          <>
            <header className="kx-launcher-header">
              <label className="kx-launcher-search">
                <Icon name="search" size={13} />
                <input ref={search} autoFocus type="search" aria-label="Find a workspace" placeholder="Find a workspace" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <Explain help="launcher.workspaces" className="kx-launcher-explain" />
            </header>
            {!!state?.pendingFiles.length && (
              <div className="kx-launcher-banner" role="status">
                <Icon name="doc" size={14} />
                <span>
                  Choose a workspace for {state.pendingFiles.length === 1 ? `“${state.pendingFiles[0]}”` : `${state.pendingFiles.length} files`}
                </span>
                <button type="button" className="kx-settings-button" onClick={() => void launcher("discard-files")}>
                  Cancel
                </button>
              </div>
            )}
            <div ref={list} className="kx-launcher-list" role="listbox" aria-label="Workspaces" tabIndex={-1}>
              {shown.map((w, i) => (
                <Row
                  key={w.id}
                  workspace={w}
                  selected={w === current}
                  onSelect={() => setSelected(i)}
                  onOpen={(newWindow) => open(w, newWindow)}
                  onLocate={() => void run(() => launcher("locate", { id: w.id }))}
                  onMenu={() => {
                    setSelected(i);
                    void launcher("context-menu", { id: w.id }).catch((e) => setError(message(e)));
                  }}
                />
              ))}
              {!shown.length && <p className="kx-launcher-none">No workspace matches “{query}”</p>}
            </div>
            <footer className="kx-launcher-keys">
              <span aria-hidden="true">↩ Open</span>
              <span aria-hidden="true">⌘↩ Open in new window</span>
              <span aria-hidden="true">⌫ Remove from list</span>
              <span className="kx-launcher-keys-help">
                <Explain help="launcher.remove" label="Removing" />
                <Explain help="launcher.move" label="Moving" />
              </span>
            </footer>
          </>
        )}
        {error && (
          <p className="kx-launcher-error" role="alert">
            <Icon name="warning" size={13} />
            {error}
          </p>
        )}
      </main>
      {dropping && (
        <div className="kx-launcher-drop" aria-hidden="true">
          <Icon name="folder" size={28} />
          <strong>Drop a folder to add it as a workspace</strong>
        </div>
      )}
      <Suspense fallback={null}>
        {state && (sheet || sheetsUsed.current) && <Sheets sheet={sheet} state={state} onClose={() => setSheet(undefined)} />}
      </Suspense>
    </div>
  );
}

function Action({ icon, label, hint, title, disabled, onClick }: { icon: IconName; label: string; hint?: string; title?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="kx-launcher-action" title={title} disabled={disabled} onClick={onClick}>
      <span className="kx-launcher-action-icon">
        <Icon name={icon} size={15} />
      </span>
      <span>{label}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  );
}

export function WorkspaceIcon({ workspace, size = 36 }: { workspace: Pick<LauncherWorkspace, "icon" | "color">; size?: number }) {
  const color = workspace.color || "var(--kx-text-2)";
  return (
    <span className="kx-launcher-icon" style={{ width: size, height: size, color, background: `color-mix(in srgb, ${color} 14%, transparent)`, fontSize: Math.round(size * 0.5) }}>
      {workspace.icon || <Icon name="books" size={Math.round(size * 0.45)} />}
    </span>
  );
}

function Row({
  workspace: w,
  selected,
  onSelect,
  onOpen,
  onLocate,
  onMenu,
}: {
  workspace: LauncherWorkspace;
  selected: boolean;
  onSelect: () => void;
  onOpen: (newWindow: boolean) => void;
  onLocate: () => void;
  onMenu: () => void;
}) {
  const counts = [w.sources !== undefined && plural(w.sources, "source", "sources"), w.notes !== undefined && plural(w.notes, "note", "notes")].filter(Boolean).join(" · ");
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={w.name}
      data-workspace-id={w.id}
      data-missing={w.missing || undefined}
      className="kx-launcher-row"
      title={w.missing ? `${w.root} is missing` : w.open ? `${w.name} is open: show its window` : `Open ${w.name} · ⌘-click to keep this window open`}
      onMouseDown={onSelect}
      onClick={(e) => (w.missing ? onLocate() : onOpen(e.metaKey))}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu();
      }}
    >
      <WorkspaceIcon workspace={w} />
      <div className="kx-launcher-row-text">
        <strong>
          <span>{w.name}</span>
          {w.open && (
            <span className="kx-launcher-badge" data-kind="open">
              Open
            </span>
          )}
          {w.missing && (
            <span className="kx-launcher-badge" data-kind="missing">
              Folder missing
            </span>
          )}
        </strong>
        <small title={w.root}>{ltr(tilde(w.root))}</small>
      </div>
      <div className="kx-launcher-row-meta">
        {w.missing ? (
          <button
            type="button"
            className="kx-settings-button"
            onClick={(e) => {
              e.stopPropagation();
              onLocate();
            }}
          >
            Locate…
          </button>
        ) : (
          <>
            <span>{opened(w.lastOpened)}</span>
            {counts && <span>{counts}</span>}
          </>
        )}
      </div>
    </div>
  );
}

function Welcome({ busy, zotero, onCreate, onChoose, onOpen, onZotero }: { busy: boolean; zotero: boolean; onCreate: () => void; onChoose: () => void; onOpen: () => void; onZotero: () => void }) {
  return (
    <section className="kx-launcher-welcome" aria-label="Welcome">
      <div className="kx-launcher-welcome-art" aria-hidden="true">
        <span>
          <Icon name="books" size={26} />
        </span>
      </div>
      <h2>Welcome to Key</h2>
      <p>A workspace is a folder on this Mac that holds a library: sources, notes and highlights. Start with one; you can add more any time.</p>
      <button type="button" className="kx-button-primary" disabled={busy} onClick={onCreate}>
        {busy ? "Creating…" : "Create your first workspace"}
      </button>
      <div className="kx-launcher-welcome-more">
        <button type="button" onClick={onChoose}>
          Choose a name and place…
        </button>
        <button type="button" onClick={onOpen}>
          Open a folder…
        </button>
        {zotero && (
          <button type="button" onClick={onZotero}>
            Import from Zotero…
          </button>
        )}
      </div>
      <Explain help="launcher.workspaces" label className="kx-launcher-welcome-explain" />
    </section>
  );
}
