// The workspaces window's sheets: a new workspace, a rename, a workspace's look, and the
// app-level settings it can change. Loaded on first use, so the window opens without them.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Drawer } from "../motion/Drawer";
import { Icon, type IconName } from "../icons";
import { COLORS, ICONS, folderName, join, launcher, ltr, message, tilde, type FolderKind, type LauncherState, type OpenAtLaunch, type Theme } from "./api";
import { WorkspaceIcon } from "./Launcher";
import { Hint } from "../explain";

export type Sheet =
  | { kind: "new"; name?: string }
  | { kind: "rename"; id: string }
  | { kind: "appearance"; id: string }
  | { kind: "settings" };

const LABELS: Record<Sheet["kind"], string> = { new: "New workspace", rename: "Rename workspace", appearance: "Customise workspace", settings: "Settings" };

export default function Sheets({ sheet, state, onClose }: { sheet?: Sheet; state: LauncherState; onClose: () => void }) {
  // The sheet that was open stays drawn while it animates out.
  const [shown, setShown] = useState(sheet);
  useEffect(() => {
    if (sheet) setShown(sheet);
  }, [sheet]);
  const content = shown && <Content key={JSON.stringify(shown)} sheet={shown} state={state} onClose={onClose} />;
  return (
    <Drawer open={!!sheet} presentation="sheet" label={shown ? LABELS[shown.kind] : "Sheet"} onClose={onClose} onExitComplete={() => setShown(undefined)}>
      {content}
    </Drawer>
  );
}

function Content({ sheet, state, onClose }: { sheet: Sheet; state: LauncherState; onClose: () => void }) {
  if (sheet.kind === "new") return <CreateSheet state={state} initialName={sheet.name} onClose={onClose} />;
  if (sheet.kind === "settings") return <SettingsSheet state={state} onClose={onClose} />;
  const workspace = state.workspaces.find((w) => w.id === sheet.id);
  if (!workspace) return null;
  if (sheet.kind === "rename") return <RenameSheet id={workspace.id} name={workspace.name} root={workspace.root} onClose={onClose} />;
  return <AppearanceSheet id={workspace.id} name={workspace.name} icon={workspace.icon ?? ""} color={workspace.color ?? COLORS[0]} onClose={onClose} />;
}

/** One sheet's frame: title, body, and Cancel beside the main button. */
function Frame({ title, lead, children, action, busy, disabled, error, onClose, onSubmit, view }: { title: string; lead?: ReactNode; children: ReactNode; action: string; busy?: boolean; disabled?: boolean; error?: string; onClose: () => void; onSubmit: () => void; view: string }) {
  return (
    <form
      className="kx-launcher-sheet"
      data-modal-view={view}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && !disabled) onSubmit();
      }}
    >
      <header>
        <h2>{title}</h2>
        {lead && <p>{lead}</p>}
      </header>
      <div className="kx-launcher-sheet-body">{children}</div>
      {error && <p className="kx-inline-error">{error}</p>}
      <footer>
        <button type="button" className="kx-settings-button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="kx-button-primary" disabled={busy || disabled}>
          {busy ? "Working…" : action}
        </button>
      </footer>
    </form>
  );
}

function Look({ icon, color, onIcon, onColor }: { icon: string; color: string; onIcon: (icon: string) => void; onColor: (color: string) => void }) {
  return (
    <div className="kx-launcher-look">
      <div className="kx-launcher-emoji" role="radiogroup" aria-label="Icon">
        {ICONS.map((i) => (
          <button key={i} type="button" role="radio" aria-checked={icon === i} aria-label={`Use ${i}`} onClick={() => onIcon(icon === i ? "" : i)}>
            {i}
          </button>
        ))}
      </div>
      <div className="kx-launcher-colors" role="radiogroup" aria-label="Colour">
        {COLORS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Colour ${c}`} style={{ background: c }} onClick={() => onColor(c)} />
        ))}
      </div>
    </div>
  );
}

const STARTS: [string, IconName, string, string][] = [
  ["empty", "layers", "Empty", "Add sources as you go"],
  ["zotero", "zotero", "Import from Zotero", "Items, collections, notes and PDFs"],
  ["files", "doc", "Add PDFs", "Choose files to start with"],
];

function CreateSheet({ state, initialName = "", onClose }: { state: LauncherState; initialName?: string; onClose: () => void }) {
  const [name, setName] = useState(initialName);
  const [parent, setParent] = useState(state.info.workspaceParent);
  const [icon, setIcon] = useState("");
  const [color, setColor] = useState(COLORS[1]);
  const [start, setStart] = useState("empty");
  const [found, setFound] = useState<FolderKind>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const folder = folderName(name);
  const path = folder ? join(parent, folder) : "";
  const asked = useRef(0);
  // What is at the path now: nothing (good), a workspace, or a folder with files.
  useEffect(() => {
    if (!path) return setFound("none");
    const ask = ++asked.current;
    const timer = setTimeout(() => void launcher<{ kind: FolderKind }>("inspect", { path }).then((r) => ask === asked.current && setFound(r.kind), () => {}), 120);
    return () => clearTimeout(timer);
  }, [path]);
  const create = async (adopt = false) => {
    setBusy(true);
    setError("");
    try {
      if (found === "workspace") await launcher("add-folder", { path });
      else await launcher("create", { name: name.trim(), path, icon, color, start, adopt });
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame
      view="new"
      title="New workspace"
      lead="A workspace is a folder that holds a library of its own."
      action={found === "workspace" ? "Open workspace" : "Create"}
      busy={busy}
      disabled={!folder || found === "file" || found === "folder"}
      error={error}
      onClose={onClose}
      onSubmit={() => void create()}
    >
      <label className="kx-launcher-field">
        <span>Name</span>
        <input autoFocus value={name} maxLength={200} placeholder="Thesis, Reading group, Project…" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="kx-launcher-field">
        <span>Location</span>
        <div className="kx-launcher-location">
          <code title={path || parent}>{ltr(tilde(path || join(parent, "…")))}</code>
          <button
            type="button"
            className="kx-settings-button"
            onClick={async () => {
              const chosen = await launcher<string | null>("choose-folder", { title: "Choose where the workspace folder goes", defaultPath: parent }).catch(() => null);
              if (chosen) setParent(chosen);
            }}
          >
            Change…
          </button>
        </div>
      </div>
      {found === "workspace" && (
        <p className="kx-launcher-note">
          <Icon name="info" size={13} /> This folder is already a Key workspace. Open it as it is.
        </p>
      )}
      {found === "folder" && (
        <p className="kx-launcher-note" data-kind="warning">
          <Icon name="warning" size={13} />
          <span>This folder already has files in it.</span>
          <button type="button" className="kx-settings-button" disabled={busy} onClick={() => void create(true)}>
            Use it as the workspace
          </button>
        </p>
      )}
      {found === "file" && (
        <p className="kx-launcher-note" data-kind="warning">
          <Icon name="warning" size={13} /> A file has this name. Choose another name or location.
        </p>
      )}
      {found !== "workspace" && (
        <>
          <div className="kx-launcher-field">
            <span>Look</span>
            <div className="kx-launcher-look-row">
              <WorkspaceIcon workspace={{ icon, color }} size={40} />
              <Look icon={icon} color={color} onIcon={setIcon} onColor={setColor} />
            </div>
          </div>
          <div className="kx-launcher-field">
            <span>Start with</span>
            <div className="kx-launcher-starts" role="radiogroup" aria-label="Start with">
              {STARTS.map(([id, glyph, label, detail]) => (
                <button key={id} type="button" role="radio" aria-checked={start === id} disabled={id === "zotero" && !state.info.zoteroFound} title={id === "zotero" && !state.info.zoteroFound ? "No Zotero library was found on this Mac" : undefined} onClick={() => setStart(id)}>
                  <Icon name={glyph} size={15} />
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </Frame>
  );
}

function RenameSheet({ id, name: current, root, onClose }: { id: string; name: string; root: string; onClose: () => void }) {
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Frame
      view="rename"
      title="Rename workspace"
      lead={<>The folder keeps its name ({tilde(root)}). To move the folder, use Move… instead.</>}
      action="Rename"
      busy={busy}
      disabled={!name.trim() || name.trim() === current}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        try {
          await launcher("rename", { id, name });
          onClose();
        } catch (e) {
          setError(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="kx-launcher-field">
        <span>Name</span>
        <input autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
      </label>
    </Frame>
  );
}

function AppearanceSheet({ id, name, icon: icon0, color: color0, onClose }: { id: string; name: string; icon: string; color: string; onClose: () => void }) {
  const [icon, setIcon] = useState(icon0);
  const [color, setColor] = useState(color0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Frame
      view="appearance"
      title={`Customise “${name}”`}
      lead="The icon and colour show here, in the window’s title bar and in the switcher."
      action="Save"
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        try {
          await launcher("appearance", { id, icon, color });
          onClose();
        } catch (e) {
          setError(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="kx-launcher-look-row">
        <WorkspaceIcon workspace={{ icon, color }} size={40} />
        <Look icon={icon} color={color} onIcon={setIcon} onColor={setColor} />
      </div>
    </Frame>
  );
}

const OPENING: [OpenAtLaunch, string, string][] = [
  ["workspaces", "Show workspaces", "This window, to choose where to start"],
  ["restore", "Reopen windows from last time", "Every window, with its tabs, as you left it"],
  ["last", "Open the last workspace", "Straight into the workspace you used last"],
];
const THEMES: [Theme, string, IconName][] = [
  ["system", "Automatic", "display"],
  ["light", "Light", "sun"],
  ["dark", "Dark", "moon"],
];

function SettingsSheet({ state, onClose }: { state: LauncherState; onClose: () => void }) {
  const [error, setError] = useState("");
  // Shown chosen at once; main saves it.
  const [opening, setOpening] = useState(state.openAtLaunch);
  const [theme, setTheme] = useState(state.theme);
  const save = (patch: { openAtLaunch?: OpenAtLaunch; theme?: Theme }) => {
    if (patch.openAtLaunch) setOpening(patch.openAtLaunch);
    if (patch.theme) setTheme(patch.theme);
    void launcher("settings", patch).catch((e) => setError(message(e)));
  };
  return (
    <form className="kx-launcher-sheet" data-modal-view="settings" onSubmit={(e) => (e.preventDefault(), onClose())}>
      <header>
        <h2>Settings</h2>
        <p>For Key as a whole. Each workspace has its own settings in its window.</p>
      </header>
      <div className="kx-launcher-sheet-body">
        <fieldset className="kx-launcher-choices" role="radiogroup" aria-label="When Key opens">
          <legend>When Key opens</legend>
          <Hint help="launcher.opening" />
          {OPENING.map(([id, label, detail]) => (
            <label key={id}>
              <input type="radio" name="open-at-launch" checked={opening === id} onChange={() => save({ openAtLaunch: id })} />
              <span>
                <strong>{label}</strong>
                <small>{detail}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="kx-launcher-field">
          <span>Appearance</span>
          <div className="kx-launcher-segmented" role="radiogroup" aria-label="Appearance">
            {THEMES.map(([id, label, glyph]) => (
              <button key={id} type="button" role="radio" aria-checked={theme === id} onClick={() => save({ theme: id })}>
                <Icon name={glyph} size={13} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {error && <p className="kx-inline-error">{error}</p>}
      <footer>
        <button type="submit" className="kx-button-primary" autoFocus>
          Done
        </button>
      </footer>
    </form>
  );
}
