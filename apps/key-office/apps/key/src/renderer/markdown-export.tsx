// Markdown export of highlights and notes (key-biblio md_export.rs in the host): Settings ›
// Markdown export, the "Export highlights" sheet for a selection or collection, the status
// bar item, and key:// links opened from other apps (an Obsidian note's highlight links).
import { Button } from "@key/design-system";
import { SegmentedTabs } from "@key-reader/ui/SegmentedTabs";
import { useEffect, useRef, useState } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import type { HighlightExportRequest } from "./export-events";
import { Icon } from "./icons";
import { openItemAt } from "./item-actions";
import { bridge, type Collection, type Invoke, type WorkspaceSummary } from "./library-api";
import { itemFromHref } from "./note-editor/types";
import { Group, Row } from "./Settings";
import type { StatusItem } from "../shared/status-items";
import "./markdown-export.css";

type Mode = "off" | "change" | "demand";
export interface MarkdownConfig {
  folder?: string | null;
  filePattern: string;
  template?: string | null;
  frontMatter: string[];
  groupBy: "page" | "color" | "tag" | "none";
  sortBy: "page" | "created";
  mode: Mode;
  yourNotes: boolean;
  deleted: "mark" | "remove";
  collectionId?: string | null;
  exportNotes: boolean;
  notesFolder?: string | null;
  pandoc: boolean;
}
interface Problem {
  id: string;
  title: string;
  path?: string | null;
  conflict?: string | null;
  message: string;
}
interface Summary {
  at: number;
  written: number;
  unchanged: number;
  conflicts: Problem[];
  errors: Problem[];
  files: string[];
}
interface Status {
  mode: Mode;
  folder?: string | null;
  last?: Summary | null;
  conflicts: Problem[];
}
interface Preview {
  empty?: boolean;
  sourceId?: string;
  title?: string;
  fileName?: string;
  text?: string;
  annotationCount?: number;
}

const FIELD_LABEL: Record<string, string> = {
  title: "Title",
  authors: "Authors",
  year: "Year",
  citekey: "Citation key",
  itemType: "Item type",
  journal: "Journal",
  doi: "DOI",
  url: "URL",
  tags: "Tags",
  collections: "Collections",
  reference: "Reference",
  exported: "Export date",
  annotationCount: "Highlight count",
};
const VARIABLES =
  "title, citekey, authors, firstCreator, year, date, journal, doi, url, tags, collections, reference, link, annotations, groups (name, annotations), notes. Per highlight: text, comment, color, colorName, page, pageLabel, link, created, tags, image.";

const message = (e: unknown) => String(e).replace(/^Error: /, "");
const home = (path?: string | null) => (path ?? "").replace(/^\/Users\/[^/]+/, "~");
const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;
export const ago = (at?: number | null) => {
  if (!at) return "never";
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
};
const changed = () => window.dispatchEvent(new CustomEvent("key:md-export-changed"));
export const describe = (s: Summary) =>
  [
    s.written ? `${plural(s.written, "file")} written` : "Up to date",
    s.unchanged && s.written ? `${s.unchanged.toLocaleString()} unchanged` : "",
    s.conflicts.length ? plural(s.conflicts.length, "conflict") : "",
    s.errors.length ? plural(s.errors.length, "error") : "",
  ]
    .filter(Boolean)
    .join(" · ");

async function chooseFolder(title: string, current?: string | null) {
  return bridge().choosePath?.({ mode: "folder", title, defaultPath: current ?? undefined });
}

/** Settings › Markdown export. */
export function MarkdownExportSettings({ invoke, workspaces }: { invoke: Invoke; workspaces: WorkspaceSummary[] }) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id);
  const [config, setConfig] = useState<MarkdownConfig>();
  const [defaults, setDefaults] = useState<{ template: string; pattern: string; fields: string[] }>();
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [previewError, setPreviewError] = useState("");
  const [status, setStatus] = useState<Status>();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const loadStatus = () => workspaceId && void invoke<Status>("store_md_export_status", {}, workspaceId).then(setStatus).catch(() => {});
  useEffect(() => {
    if (!workspaceId) return;
    void invoke<{ config: MarkdownConfig; defaults: typeof defaults }>("store_md_export_config", {}, workspaceId).then((r) => {
      setConfig(r.config);
      setDefaults(r.defaults);
      setDraft(r.config.template || r.defaults!.template);
    });
    void invoke<Collection[]>("store_collections", {}, workspaceId).then(setCollections).catch(() => {});
    loadStatus();
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Automatic exports run in the background: the last one and any conflicts stay current.
  useEffect(() => {
    const timer = setInterval(loadStatus, 5000);
    window.addEventListener("key:md-export-changed", loadStatus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("key:md-export-changed", loadStatus);
    };
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The preview follows the template as it is typed.
  useEffect(() => {
    if (!config || !workspaceId) return;
    const timer = setTimeout(
      () =>
        void invoke<Preview>("store_md_export_preview", { config: { ...config, template: draft } }, workspaceId)
          .then((p) => (setPreview(p), setPreviewError("")))
          .catch((e) => setPreviewError(message(e))),
      180,
    );
    return () => clearTimeout(timer);
  }, [draft, config, workspaceId, invoke]);
  const save = async (patch: Partial<MarkdownConfig>) => {
    if (!config) return;
    const next = { ...config, ...patch };
    setError("");
    try {
      const r = await invoke<{ config: MarkdownConfig }>("store_md_export_config", { config: next }, workspaceId);
      setConfig(r.config);
      changed();
    } catch (e) {
      setError(message(e));
    }
  };
  // The template is saved a moment after typing stops, when it parses.
  const saved = useRef("");
  useEffect(() => {
    if (!config || previewError) return;
    const value = draft === defaults?.template ? null : draft;
    if ((config.template ?? null) === value || saved.current === draft) return;
    const timer = setTimeout(() => {
      saved.current = draft;
      void save({ template: value });
    }, 600);
    return () => clearTimeout(timer);
  }, [draft, previewError]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (force = false) => {
    setRunning(true);
    setError("");
    try {
      await invoke<Summary>("store_md_export_run", { notes: true, force }, workspaceId);
    } catch (e) {
      setError(message(e));
    } finally {
      setRunning(false);
      loadStatus();
      changed();
    }
  };
  if (!config || !defaults) return <div className="kx-settings-loading">Loading…</div>;
  const last = status?.last;
  const toggleField = (field: string) =>
    void save({ frontMatter: config.frontMatter.includes(field) ? config.frontMatter.filter((f) => f !== field) : [...defaults.fields.filter((f) => f === field || config.frontMatter.includes(f))] });
  return (
    <div className="kx-md-settings">
      {workspaces.length > 1 && (
        <Group>
          <Row label="Library">
            <select className="kx-settings-select" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} aria-label="Library">
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Row>
        </Group>
      )}
      <Group
        title="Highlights"
        help="settings.markdown.what"
        footer="One Markdown file per source with highlights, for Obsidian, Logseq or any folder of notes. Key only rewrites its own section of each file; what you write around it, and under each highlight, stays. Files you rename or move inside the folder are found again."
      >
        <Row label="Folder" detail={config.folder ? home(config.folder) : "Choose your vault or a folder in it"} path>
          {config.folder && (
            <button className="kx-settings-button" aria-label="Show the folder in Finder" onClick={() => void bridge().revealPath(config.folder!)}>
              <Icon name="folder" size={12} />
            </button>
          )}
          <button className="kx-settings-button" onClick={() => void chooseFolder("Export highlights to", config.folder).then((folder) => void (folder && save({ folder })))}>
            Choose…
          </button>
        </Row>
        <Row label="Export" detail={config.mode === "change" ? "A moment after highlights or details change" : config.mode === "demand" ? "When you choose Export now or Export highlights" : "Turned off"}>
          <SegmentedTabs
            label="When to export"
            value={config.mode}
            onChange={(mode) => void save({ mode: mode as Mode })}
            tabs={[
              { id: "off", label: "Off" },
              { id: "change", label: "On change" },
              { id: "demand", label: "On demand" },
            ]}
          />
        </Row>
        <Row label="Sources" detail="Which sources' highlights are kept exported">
          <select className="kx-settings-select" aria-label="Sources to export" value={config.collectionId ?? ""} onChange={(e) => void save({ collectionId: e.target.value || null })}>
            <option value="">All sources with highlights</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="Last export"
          detail={
            last ? (
              <span data-testid="md-last">
                {describe(last)} · {ago(last.at)}
              </span>
            ) : (
              "Not exported yet"
            )
          }
        >
          <button className="kx-settings-button kx-settings-primary" disabled={!config.folder || running} onClick={() => void run()}>
            {running ? "Exporting…" : "Export now"}
          </button>
        </Row>
      </Group>
      {!!status?.conflicts.length && (
        <Group title="Conflicts" footer="Key's section of these files was edited by hand, so Key left them as they are and wrote its new version beside them (.conflict.md). Merge by hand, or let Key's version replace its section; your text outside it stays either way.">
          {status.conflicts.map((c) => (
            <Row key={c.id} label={c.title} detail={home(c.path)} path>
              <button className="kx-settings-button" onClick={() => c.conflict && void bridge().revealPath(c.conflict)}>
                Show
              </button>
              <button className="kx-settings-button" onClick={() => void invoke("store_md_export_run", { ids: [c.id], force: true }, workspaceId).then(() => (loadStatus(), changed()))}>
                Use Key’s version
              </button>
            </Row>
          ))}
        </Group>
      )}
      <Group title="Files">
        <Row label="File name" detail={preview?.fileName ? <code className="kx-md-code">{preview.fileName}</code> : "Without a citation key, the title is used"}>
          <input
            className="kx-settings-select kx-md-pattern"
            aria-label="File name pattern"
            defaultValue={config.filePattern}
            placeholder={defaults.pattern}
            spellCheck={false}
            onBlur={(e) => e.target.value !== config.filePattern && void save({ filePattern: e.target.value || defaults.pattern })}
          />
        </Row>
        <Row label="Front matter" detail="Properties at the top of each file; tags become a YAML list">
          <div className="kx-md-fields" role="group" aria-label="Front matter fields">
            {defaults.fields.map((f) => (
              <button key={f} type="button" aria-pressed={config.frontMatter.includes(f)} onClick={() => toggleField(f)}>
                {FIELD_LABEL[f] ?? f}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Group highlights">
          <select className="kx-settings-select" aria-label="Group highlights by" value={config.groupBy} onChange={(e) => void save({ groupBy: e.target.value as MarkdownConfig["groupBy"] })}>
            <option value="page">By page</option>
            <option value="color">By colour</option>
            <option value="tag">By tag</option>
            <option value="none">Not grouped</option>
          </select>
          <select className="kx-settings-select" aria-label="Order highlights by" value={config.sortBy} onChange={(e) => void save({ sortBy: e.target.value as MarkdownConfig["sortBy"] })}>
            <option value="page">In page order</option>
            <option value="created">In the order made</option>
          </select>
        </Row>
        <Row label="Your notes under highlights" detail="A place under each highlight for your own notes, kept on every export">
          <input type="checkbox" className="kx-switch" aria-label="Your notes under highlights" checked={config.yourNotes} onChange={(e) => void save({ yourNotes: e.target.checked })} />
        </Row>
        <Row label="Highlights deleted in Key" detail={config.deleted === "mark" ? "Kept at the end, marked “Removed in Key”" : "Taken out, unless you wrote notes under them"}>
          <select className="kx-settings-select" aria-label="Highlights deleted in Key" value={config.deleted} onChange={(e) => void save({ deleted: e.target.value as MarkdownConfig["deleted"] })}>
            <option value="mark">Keep, marked</option>
            <option value="remove">Remove</option>
          </select>
        </Row>
      </Group>
      <Group title="Template" footer={<>Handlebars-style: <code>{"{{title}}"}</code>, <code>{"{{#each groups}}…{{/each}}"}</code>, <code>{"{{#if comment}}…{{/if}}"}</code>, filters such as <code>{"{{text | quote}}"}</code>, <code>{"{{title | truncate 60}}"}</code>, <code>{"{{tags | join \", \"}}"}</code>. Fields: {VARIABLES}</>}>
        <div className="kx-settings-row kx-settings-row-wide">
          <div className="kx-md-template">
            <div className="kx-md-pane">
              <div className="kx-md-pane-head">
                <span>Template</span>
                <button className="kx-settings-link" disabled={draft === defaults.template} onClick={() => setDraft(defaults.template)}>
                  Reset
                </button>
              </div>
              <textarea aria-label="Highlights template" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />
              {previewError && (
                <p className="kx-md-error" role="alert">
                  {previewError}
                </p>
              )}
            </div>
            <div className="kx-md-pane">
              <div className="kx-md-pane-head">
                <span>{preview?.title ? `Preview · ${preview.title}` : "Preview"}</span>
              </div>
              <pre className="kx-md-preview" data-testid="md-preview">
                {preview?.empty ? "Highlight a PDF or web page to see a preview here." : (preview?.text ?? "")}
              </pre>
            </div>
          </div>
        </div>
      </Group>
      <Group title="Notes" footer="Key's notes as Markdown files too, in their own folder. With Pandoc citations, links to sources become [@citekey] (with the page) so the files work with Pandoc, Zotero-free writing tools and Obsidian's Pandoc plugins.">
        <Row label="Export notes">
          <input type="checkbox" className="kx-switch" aria-label="Export notes" checked={config.exportNotes} onChange={(e) => void save({ exportNotes: e.target.checked })} />
        </Row>
        {config.exportNotes && (
          <>
            <Row label="Notes folder" detail={config.notesFolder ? home(config.notesFolder) : "Choose a folder"} path>
              <button className="kx-settings-button" onClick={() => void chooseFolder("Export notes to", config.notesFolder ?? config.folder).then((notesFolder) => void (notesFolder && save({ notesFolder })))}>
                Choose…
              </button>
            </Row>
            <Row label="Pandoc citations" detail="[label](key://source/…) becomes [@key, p. 3]">
              <input type="checkbox" className="kx-switch" aria-label="Pandoc citations" checked={config.pandoc} onChange={(e) => void save({ pandoc: e.target.checked })} />
            </Row>
          </>
        )}
      </Group>
      {error && <p className="kx-inline-error">{error}</p>}
    </div>
  );
}

// ── Export highlights (one shot, or to the folder) ────────────────────────────

type ExportRequest = HighlightExportRequest;

function HighlightExportSheet({ invoke, workspaceId, request, onClose }: { invoke: Invoke; workspaceId: string; request: ExportRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [folder, setFolder] = useState<string | null>();
  useEffect(() => {
    void invoke<{ config: MarkdownConfig }>("store_md_export_config", {}, workspaceId).then((r) => setFolder(r.config.folder ?? null));
  }, [invoke, workspaceId]);
  const scope = { ids: request.ids ?? null, collectionId: request.collectionId ?? null };
  const what = request.title ?? (request.ids ? plural(request.ids.length, "source") : "this collection");
  const act = async (how: "copy" | "save" | "folder") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (how === "copy") {
        const r = await invoke<{ text: string; count: number }>("store_md_export_render", scope, workspaceId);
        await navigator.clipboard.writeText(r.text);
        setNotice(`Copied the highlights of ${plural(r.count, "source")} as Markdown`);
      } else if (how === "save") {
        const name = (request.title ?? "Highlights").replace(/[/:]/g, "-");
        const path = await bridge().choosePath?.({ mode: "save", title: "Export highlights", defaultPath: `${name}.md`, extensions: ["md"] });
        if (!path) return;
        const r = await invoke<{ count: number }>("store_md_export_render", { ...scope, path }, workspaceId);
        setNotice(`Saved the highlights of ${plural(r.count, "source")}`);
      } else {
        const s = await invoke<Summary>("store_md_export_run", scope, workspaceId);
        setNotice(describe(s));
        if (s.conflicts.length || s.errors.length) setError([...s.conflicts, ...s.errors].map((p) => `${p.title}: ${p.message}`).join("\n"));
        changed();
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <GlobalDrawer onClose={onClose} busy={busy} presentation="sheet" label="Export highlights">
      <div className="key-property-editor kx-md-export" role="dialog" aria-label="Export highlights" data-modal-view="highlights">
        <header>
          <h2>Export highlights</h2>
          <p>The highlights and comments of {what} as Markdown, from the template in Settings › Markdown export.</p>
          <button className="kx-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="key-property-body">
          <div className="kx-md-export-choices">
            <button type="button" disabled={busy || folder === undefined} onClick={() => (folder ? void act("folder") : (onClose(), window.dispatchEvent(new CustomEvent("key:open-settings-section", { detail: "markdown" }))))}>
              <Icon name="folder" size={16} />
              <span>
                <strong>{folder ? "Update in the export folder" : "Set up an export folder…"}</strong>
                <small>{folder ? `${home(folder)} — one file per source, kept in sync` : "Keep highlights in sync with an Obsidian or Logseq vault"}</small>
              </span>
            </button>
            <button type="button" disabled={busy} onClick={() => void act("save")}>
              <Icon name="fileMarkdown" size={16} />
              <span>
                <strong>Save as a file…</strong>
                <small>Everything in one Markdown file</small>
              </span>
            </button>
          </div>
          {notice && (
            <p className="kx-bib-notice" role="status">
              <Icon name="check" size={12} /> {notice}
            </p>
          )}
          {error && <p className="kx-inline-error kx-md-pre">{error}</p>}
        </div>
        <footer>
          <span className="kx-footer-spacer" />
          <Button type="button" onClick={onClose}>
            Done
          </Button>
          <Button variant="primary" className="key-property-primary" disabled={busy} onClick={() => void act("copy")}>
            <Icon name="copy" size={12} /> Copy Markdown
          </Button>
        </footer>
      </div>
    </GlobalDrawer>
  );
}

/** The sheet, and key:// links from other apps (mounted once by the shell). */
export function MarkdownExportHost({ invoke, workspaceId }: { invoke: Invoke; workspaceId?: string }) {
  const [request, setRequest] = useState<ExportRequest>();
  useEffect(() => {
    const open = (e: Event) => setRequest((e as CustomEvent<ExportRequest>).detail ?? {});
    window.addEventListener("key:open-highlight-export", open);
    const off = bridge().on("open-item-link", (url) => {
      const item = itemFromHref(String(url));
      if (item) openItemAt(item, "tab");
    });
    return () => {
      window.removeEventListener("key:open-highlight-export", open);
      off();
    };
  }, []);
  const target = request?.workspaceId ?? workspaceId;
  return request && target ? <HighlightExportSheet invoke={invoke} workspaceId={target} request={request} onClose={() => setRequest(undefined)} /> : null;
}

/** The status bar item: the last export, or what went wrong. */
export function useMarkdownExportStatus(invoke: Invoke, workspaceId?: string): StatusItem | undefined {
  const [status, setStatus] = useState<Status>();
  useEffect(() => {
    if (!workspaceId) return;
    const check = () =>
      void invoke<Status>("store_md_export_status", {}, workspaceId)
        .then(setStatus)
        .catch(() => {});
    check();
    const timer = setInterval(check, 15_000);
    window.addEventListener("key:md-export-changed", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("key:md-export-changed", check);
    };
  }, [invoke, workspaceId]);
  if (!status || status.mode === "off" || !status.folder) return undefined;
  const last = status.last;
  const open = "\n\nOpen Settings › Markdown export";
  if (status.conflicts.length)
    return {
      id: "md-export",
      label: status.conflicts.length === 1 ? "1 Markdown conflict" : `${status.conflicts.length} Markdown conflicts`,
      tone: "warning",
      title: `Key did not overwrite these files (their Key section was edited):\n${status.conflicts.map((c) => c.path).join("\n")}${open}`,
      priority: 55,
    };
  if (last?.errors.length)
    return { id: "md-export", label: "Markdown export failed", tone: "error", title: `${last.errors.map((e) => `${e.title}: ${e.message}`).join("\n")}${open}`, priority: 55 };
  if (!last) return undefined;
  return { id: "md-export", label: `Markdown · ${ago(last.at)}`, icon: "fileMarkdown", title: `Highlights exported to ${home(status.folder)}\n${describe(last)}${open}`, priority: 20 };
}
