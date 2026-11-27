// File naming rules and the readable mirror folder (key-biblio filenames.rs, file_mirror.rs
// in the host): Workspace Settings › Files, the rename confirmation (in Settings, or a sheet for the
// library's selection), and readable names for files dragged out of the app.
import { openWorkspaceSettings } from "./settings-catalog";
import { Button } from "@key/design-system";
import { useEffect, useState } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import type { FileRenameRequest } from "./export-events";
import { Icon } from "./icons";
import { toast } from "./item-actions";
import { libraryChanged } from "./library-nav";
import { bridge, type Invoke } from "./library-api";
import { ago } from "./markdown-export";
import { Group, Row } from "./Settings";
import "./markdown-export.css";

export interface NamingRules {
  template: string;
  ascii: boolean;
  case: "keep" | "lower" | "upper";
  separator: string;
  maxLength: number;
  collision: string;
}
interface Example {
  id: string;
  title: string;
  from: string;
  name: string;
}
interface Rename {
  id: string;
  title: string;
  from: string;
  to: string;
}
interface Plan {
  renames: Rename[];
  unchanged: number;
  managed: number;
  inFolders: number;
  missing: number;
}
interface MirrorConfig {
  enabled: boolean;
  folder?: string | null;
  byCollection: boolean;
}
interface MirrorSummary {
  at: number;
  files: number;
  linked: number;
  copied: number;
  added: number;
  removed: number;
  errors: string[];
}
interface LinkedFolder {
  id: string;
  name: string;
  path: string;
}

const message = (e: unknown) => String(e).replace(/^Error: /, "");
const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;
const base = (path: string) => path.split("/").pop() ?? path;
const home = (path?: string | null) => (path ?? "").replace(/^\/Users\/[^/]+/, "~");

/** Paths to drag out: managed files under their readable names. */
export async function readablePaths(invoke: Invoke, workspaceId: string | undefined, ids: string[], fallback: string[]) {
  try {
    const paths = await invoke<string[]>("store_file_readable_paths", { ids }, workspaceId);
    return paths.length ? paths : fallback;
  } catch {
    return fallback;
  }
}

function RenameList({ plan, limit = 12 }: { plan: Plan; limit?: number }) {
  return (
    <ul className="kx-files-examples" aria-label="Changes">
      {plan.renames.slice(0, limit).map((r) => (
        <li key={r.id} title={`${r.from}\n→ ${r.to}`}>
          <span className="kx-files-from">{base(r.from)}</span>
          <Icon name="arrowRight" size={11} />
          <span className="kx-files-name">{base(r.to)}</span>
        </li>
      ))}
      {plan.renames.length > limit && (
        <li>
          <span className="kx-files-from">and {plural(plan.renames.length - limit, "more file")}</span>
        </li>
      )}
    </ul>
  );
}

const skipped = (plan: Plan) =>
  [
    plan.unchanged && `${plan.unchanged.toLocaleString()} already named so`,
    plan.managed && `${plan.managed.toLocaleString()} stored by Key (shown, dragged and exported under the new name; storage keeps its name)`,
    plan.inFolders && `${plan.inFolders.toLocaleString()} in linked folders left alone`,
    plan.missing && `${plan.missing.toLocaleString()} missing`,
  ]
    .filter(Boolean)
    .join(" · ");

async function applyRenames(invoke: Invoke, workspaceId: string | undefined, plan: Plan) {
  await invoke("store_file_rename_apply", { renames: plan.renames }, workspaceId);
  libraryChanged();
  toast(`Renamed ${plural(plan.renames.length, "file")}`, () =>
    void invoke("store_undo", {}, workspaceId).then(() => (libraryChanged(), toast("File names put back"))),
  );
}

/** Workspace Settings › Files. */
/** For one workspace (Workspace Settings keys it by workspace, so state starts fresh). */
export function FileSettings({ invoke, workspaceId }: { invoke: Invoke; workspaceId?: string }) {
  const [rules, setRules] = useState<NamingRules>();
  const [fallback, setFallback] = useState<NamingRules>();
  const [examples, setExamples] = useState<Example[]>([]);
  const [error, setError] = useState("");
  const [folders, setFolders] = useState<LinkedFolder[]>([]);
  const [optIn, setOptIn] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan>();
  const [busy, setBusy] = useState(false);
  const [mirror, setMirror] = useState<{ config: MirrorConfig; last?: MirrorSummary | null }>();
  useEffect(() => {
    if (!workspaceId) return;
    void invoke<{ rules: NamingRules; default: NamingRules }>("store_file_naming", {}, workspaceId).then((r) => (setRules(r.rules), setFallback(r.default)));
    void invoke<LinkedFolder[]>("store_linked_folders", {}, workspaceId).then(setFolders).catch(() => {});
    void invoke<typeof mirror>("store_file_mirror_config", {}, workspaceId).then(setMirror).catch(() => {});
  }, [workspaceId, invoke]);
  // Live examples from the library as the rules change; saved once they are valid.
  useEffect(() => {
    if (!rules || !workspaceId) return;
    const timer = setTimeout(async () => {
      try {
        setExamples(await invoke<Example[]>("store_file_naming_preview", { rules }, workspaceId));
        await invoke("store_file_naming", { rules }, workspaceId);
        setError("");
      } catch (e) {
        setError(message(e));
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [rules, workspaceId, invoke]);
  if (!rules || !fallback) return <div className="kx-settings-loading">Loading…</div>;
  const set = (patch: Partial<NamingRules>) => setRules({ ...rules, ...patch });
  const preview = async () => {
    setBusy(true);
    setError("");
    try {
      setPlan(await invoke<Plan>("store_file_rename_plan", { rules, folders: optIn }, workspaceId));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const saveMirror = async (config: MirrorConfig) => {
    setBusy(true);
    setError("");
    try {
      setMirror(await invoke<typeof mirror>("store_file_mirror", { config }, workspaceId));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const last = mirror?.last;
  return (
    <div className="kx-files-settings">
      {plan && (
        <section className="kx-files-confirm" role="dialog" aria-label="Rename files">
          <h3>{plan.renames.length ? `Rename ${plural(plan.renames.length, "file")} on disk?` : "No files to rename"}</h3>
          <p className="kx-files-rename-note">{plan.renames.length ? "Linked files are renamed where they are, in their folders. Undo (⌘Z) puts every name back." : "Every linked file already follows the rule."}</p>
          {!!plan.renames.length && (
            <div className="kx-files-rename-list">
              <RenameList plan={plan} />
            </div>
          )}
          {skipped(plan) && <p className="kx-files-rename-note">{skipped(plan)}</p>}
          <div className="kx-files-confirm-actions">
            <button className="kx-settings-button" onClick={() => setPlan(undefined)}>
              {plan.renames.length ? "Cancel" : "Close"}
            </button>
            {!!plan.renames.length && (
              <button
                className="kx-settings-button kx-settings-primary"
                disabled={busy}
                onClick={() =>
                  void applyRenames(invoke, workspaceId, plan)
                    .then(() => setPlan(undefined))
                    .catch((e) => setError(message(e)))
                }
              >
                Rename {plural(plan.renames.length, "file")}
              </button>
            )}
          </div>
        </section>
      )}
      <Group
        title="File names"
        help="settings.files.what"
        footer={
          <>
            Fields: <code>{"{{firstCreator}}"}</code> (Smith, Smith and Jones, Smith et al.), <code>{"{{year}}"}</code>, <code>{"{{title}}"}</code>, <code>{"{{shortTitle}}"}</code>, <code>{"{{citekey}}"}</code>, <code>{"{{journal}}"}</code>, <code>{"{{itemType}}"}</code>; filters such as{" "}
            <code>{"{{title | truncate 60}}"}</code> and <code>{"| lower"}</code>. Files Key stores itself keep names made from their contents; they are shown, dragged out and mirrored under these names. Characters other systems cannot use are replaced, and a taken name gets a number.
          </>
        }
      >
        <Row label="Rule" detail={error ? <span className="kx-citekey-error">{error}</span> : undefined}>
          <input className="kx-settings-select kx-files-template" aria-label="File name rule" value={rules.template} placeholder={fallback.template} spellCheck={false} onChange={(e) => set({ template: e.target.value })} />
        </Row>
        <Row label="Characters">
          <div className="kx-files-options">
            <label className="kx-settings-link">
              <input type="checkbox" checked={rules.ascii} onChange={(e) => set({ ascii: e.target.checked })} /> Remove accents
            </label>
            <select className="kx-settings-select" aria-label="Letter case" value={rules.case} onChange={(e) => set({ case: e.target.value as NamingRules["case"] })}>
              <option value="keep">Case as written</option>
              <option value="lower">lowercase</option>
              <option value="upper">UPPERCASE</option>
            </select>
            <select className="kx-settings-select" aria-label="Between words" value={rules.separator} onChange={(e) => set({ separator: e.target.value })}>
              <option value="">Spaces</option>
              <option value="_">Underscores</option>
              <option value="-">Hyphens</option>
            </select>
          </div>
        </Row>
        <Row label="Longest name" detail="Characters, before the extension">
          <select className="kx-settings-select" aria-label="Longest name" value={rules.maxLength} onChange={(e) => set({ maxLength: Number(e.target.value) })}>
            {[60, 80, 100, 120, 160, 200].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Taken names" detail={`A second “Smith - 2020 - Title” becomes “Smith - 2020 - Title${rules.collision || " "}2”`}>
          <select className="kx-settings-select" aria-label="Taken names" value={rules.collision} onChange={(e) => set({ collision: e.target.value })}>
            <option value=" ">Title 2</option>
            <option value="-">Title-2</option>
            <option value="_">Title_2</option>
          </select>
        </Row>
        <div className="kx-settings-row kx-settings-row-wide" data-testid="file-examples">
          {examples.length ? (
            <ul className="kx-files-examples" aria-label="Examples from your library">
              {examples.map((x) => (
                <li key={x.id} title={x.title}>
                  <span className="kx-files-from">{x.from}</span>
                  <Icon name="arrowRight" size={11} />
                  <span className="kx-files-name">{x.name}</span>
                </li>
              ))}
            </ul>
          ) : (
            <small className="kx-files-rename-note">Add files to the library to see examples here.</small>
          )}
        </div>
      </Group>
      <Group title="Rename linked files" footer="Files Key links where they are (added from Finder) can take these names on disk too. Key renames nothing on its own; files in linked folders are renamed only in the folders you tick.">
        {folders.map((f) => (
          <Row key={f.id} label={`Include “${f.name}”`} detail={home(f.path)} path>
            <input type="checkbox" className="kx-switch" aria-label={`Rename files in ${f.name}`} checked={optIn.includes(f.id)} onChange={(e) => setOptIn(e.target.checked ? [...optIn, f.id] : optIn.filter((id) => id !== f.id))} />
          </Row>
        ))}
        <Row label="Apply to all files" detail="Shows the changes first">
          <button className="kx-settings-button" disabled={busy || !!error} onClick={() => void preview()}>
            Rename…
          </button>
        </Row>
      </Group>
      <Group
        title="Mirror folder"
        help="settings.files.mirror"
        footer="A folder of readable copies organised by collection, kept in step with the library, for Finder, DEVONthink or an iPad through a cloud folder. On the same disk the mirror uses hard links: the same file under a second name, taking no space (editing one edits the other). On another disk it makes copies. Key only ever changes files it put there."
      >
        <Row label="Keep a mirror folder">
          <input
            type="checkbox"
            className="kx-switch"
            aria-label="Keep a mirror folder"
            disabled={busy}
            checked={!!mirror?.config.enabled}
            onChange={async (e) => {
              const config = { ...(mirror?.config ?? { byCollection: true }), enabled: e.target.checked } as MirrorConfig;
              if (config.enabled && !config.folder) {
                const folder = await bridge().choosePath?.({ mode: "folder", title: "Mirror the library to" });
                if (!folder) return;
                config.folder = folder;
              }
              void saveMirror(config);
            }}
          />
        </Row>
        {mirror?.config.enabled && (
          <>
            <Row label="Location" detail={home(mirror.config.folder)} path>
              <button className="kx-settings-button" aria-label="Show the mirror folder in Finder" onClick={() => mirror.config.folder && void bridge().revealPath(mirror.config.folder)}>
                <Icon name="folder" size={12} />
              </button>
              <button className="kx-settings-button" onClick={() => void bridge().choosePath?.({ mode: "folder", title: "Mirror the library to" }).then((folder) => void (folder && saveMirror({ ...mirror.config, folder })))}>
                Change…
              </button>
            </Row>
            <Row label="Folders by collection" detail="Sources in no collection go to “Unfiled”">
              <input type="checkbox" className="kx-switch" aria-label="Folders by collection" checked={mirror.config.byCollection} onChange={(e) => void saveMirror({ ...mirror.config, byCollection: e.target.checked })} />
            </Row>
            <Row
              label="Last updated"
              detail={
                last
                  ? `${plural(last.files, "file")} (${last.linked.toLocaleString()} linked, ${last.copied.toLocaleString()} copied) · ${ago(last.at)}${last.errors.length ? ` · ${plural(last.errors.length, "error")}` : ""}`
                  : "Not yet"
              }
            >
              <button className="kx-settings-button" disabled={busy} onClick={() => void invoke<MirrorSummary>("store_file_mirror_run", {}, workspaceId).then((s) => setMirror({ ...mirror, last: s }), (e) => setError(message(e)))}>
                Update now
              </button>
            </Row>
          </>
        )}
      </Group>
    </div>
  );
}

// ── Rename the selection's files (from the library) ───────────────────────────

type RenameRequest = FileRenameRequest;

function RenameSheet({ invoke, workspaceId, ids, onClose }: { invoke: Invoke; workspaceId?: string; ids: string[]; onClose: () => void }) {
  const [plan, setPlan] = useState<Plan>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void invoke<Plan>("store_file_rename_plan", { ids }, workspaceId).then(setPlan, (e) => setError(message(e)));
  }, [invoke, workspaceId, ids]);
  return (
    <GlobalDrawer onClose={onClose} busy={busy} presentation="sheet" label="Rename files">
      <div className="key-property-editor kx-files-rename" role="dialog" aria-label="Rename files" data-modal-view="rename">
        <header>
          <h2>{plan?.renames.length ? `Rename ${plural(plan.renames.length, "file")}?` : "Rename files"}</h2>
          <p>By the rule in Workspace Settings › Files. Linked files are renamed where they are; Undo puts the names back.</p>
          <button className="kx-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="key-property-body">
          {!plan && !error && <div className="kx-settings-loading">Looking at the files…</div>}
          {plan && plan.renames.length > 0 && (
            <div className="kx-files-rename-list">
              <RenameList plan={plan} limit={40} />
            </div>
          )}
          {plan && !plan.renames.length && <p className="kx-files-rename-note">Nothing to rename.</p>}
          {plan && skipped(plan) && <p className="kx-files-rename-note">{skipped(plan)}</p>}
          {error && <p className="kx-inline-error">{error}</p>}
        </div>
        <footer>
          <Button type="button" onClick={() => (onClose(), openWorkspaceSettings("files", workspaceId))}>
            Change the rule…
          </Button>
          <span className="kx-footer-spacer" />
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="key-property-primary"
            disabled={busy || !plan?.renames.length}
            onClick={async () => {
              setBusy(true);
              try {
                await applyRenames(invoke, workspaceId, plan!);
                onClose();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Rename
          </Button>
        </footer>
      </div>
    </GlobalDrawer>
  );
}

/** Mounted once by the shell. */
export function FileRenameHost({ invoke, workspaceId }: { invoke: Invoke; workspaceId?: string }) {
  const [request, setRequest] = useState<RenameRequest>();
  useEffect(() => {
    const open = (e: Event) => setRequest((e as CustomEvent<RenameRequest>).detail);
    window.addEventListener("key:open-file-rename", open);
    return () => window.removeEventListener("key:open-file-rename", open);
  }, []);
  return request ? <RenameSheet invoke={invoke} workspaceId={request.workspaceId ?? workspaceId} ids={request.ids} onClose={() => setRequest(undefined)} /> : null;
}
