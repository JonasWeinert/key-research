// Citation keys in the UI: the row in a source's details (edit, copy, pin, regenerate) and
// the Settings section for the key pattern and auto-export targets. The store makes and
// keeps the keys (key-store citation_keys.rs, key-biblio).
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { libraryChanged } from "./library-nav";
import { bridge, type Collection, type Invoke, type Source, type WorkspaceSummary } from "./library-api";
import { EXPORT_FORMATS, openBibExport, type AutoExportTarget } from "./BiblioSheets";
import { Group, Row } from "./Settings";
import "./biblio.css";

interface KeyInfo {
  key?: string | null;
  pinned: boolean;
  provisional: boolean;
}

/** Quick copy through the host (the same writers as export). */
export async function copyCitation(invoke: Invoke, workspaceId: string | undefined, ids: string[], format: "bibtex" | "biblatex" | "ris" | "csl-json" | "pandoc" | "latex") {
  const text = await invoke<string>("store_biblio_copy", { ids, format }, workspaceId);
  await navigator.clipboard.writeText(text);
  return text;
}

export function CitationKeyRow({ invoke, workspaceId, source, onChanged }: { invoke: Invoke; workspaceId?: string; source: Source; onChanged: () => void }) {
  const key = source.citationKey ?? "";
  const pinned = !!(source as Source & { citationKeyPinned?: boolean }).citationKeyPinned;
  const [draft, setDraft] = useState(key);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setDraft(key), [key]);
  const run = async (command: string, args: Record<string, unknown>) => {
    setError("");
    try {
      await invoke<KeyInfo | KeyInfo[]>(command, args, workspaceId);
      onChanged();
      libraryChanged();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
      setDraft(key);
    }
  };
  return (
    <div className="kx-field-row" data-field="citationKey">
      <span>Citation key</span>
      <span className="kx-citekey">
        <input
          aria-label="Citation key"
          value={draft}
          placeholder="—"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft.trim() && draft.trim() !== key && void run("store_citation_key_set", { id: source.id, key: draft.trim(), pinned: true })}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(key);
              e.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          title={copied ? "Copied" : "Copy as [@key]"}
          aria-label="Copy citation key"
          disabled={!key}
          onClick={() =>
            void navigator.clipboard.writeText(`[@${key}]`).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          <Icon name={copied ? "check" : "copy"} size={12} />
        </button>
        <button
          type="button"
          aria-pressed={pinned}
          title={pinned ? "Pinned: kept as it is. Click to let Key update it." : "Pin the key so it never changes"}
          aria-label={pinned ? "Unpin citation key" : "Pin citation key"}
          onClick={() => void run("store_citation_key_pin", { id: source.id, pinned: !pinned })}
        >
          <Icon name="pin" size={12} filled={pinned} />
        </button>
        <button type="button" title="Generate the key again from the pattern" aria-label="Regenerate citation key" onClick={() => void run("store_citation_key_regenerate", { ids: [source.id] })}>
          <Icon name="retry" size={12} />
        </button>
      </span>
      {error && <span className="kx-citekey-error" role="alert">{error}</span>}
    </div>
  );
}

const FORMAT_LABEL = Object.fromEntries(EXPORT_FORMATS.map(([id, label]) => [id, label]));
const ago = (at?: number | null) => {
  if (!at) return "never";
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
};

/** Settings › Citation keys & export. */
export function CitationKeySettings({ invoke, workspaces }: { invoke: Invoke; workspaces: WorkspaceSummary[] }) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id);
  const [pattern, setPattern] = useState("");
  const [saved, setSaved] = useState("");
  const [fallback, setFallback] = useState("auth.lower + year");
  const [preview, setPreview] = useState<{ valid: boolean; error?: string | null; examples: [string, string][] }>();
  const [targets, setTargets] = useState<AutoExportTarget[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [note, setNote] = useState("");
  const load = () => {
    if (!workspaceId) return;
    void invoke<{ pattern: string; default: string }>("store_citation_key_pattern", {}, workspaceId).then((p) => {
      setPattern(p.pattern);
      setSaved(p.pattern);
      setFallback(p.default);
    });
    void invoke<AutoExportTarget[]>("store_autoexport_targets", {}, workspaceId).then(setTargets);
    void invoke<Collection[]>("store_collections", {}, workspaceId).then(setCollections);
  };
  useEffect(load, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!workspaceId || !pattern) return;
    const timer = setTimeout(() => void invoke<typeof preview>("store_citation_key_preview", { pattern }, workspaceId).then(setPreview), 200);
    return () => clearTimeout(timer);
  }, [pattern, workspaceId, invoke]);
  useEffect(() => {
    const timer = setInterval(() => workspaceId && void invoke<AutoExportTarget[]>("store_autoexport_targets", {}, workspaceId).then(setTargets).catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [workspaceId, invoke]);
  const apply = async (regenerate: boolean) => {
    const result = await invoke<{ changed?: number }>("store_citation_key_pattern", { pattern, regenerate }, workspaceId);
    setSaved(pattern);
    setNote(regenerate ? `${(result.changed ?? 0).toLocaleString()} keys generated again; pinned keys were kept.` : "New sources get keys from this pattern.");
    libraryChanged();
  };
  const changed = () => window.dispatchEvent(new CustomEvent("key:autoexport-changed"));
  const names = new Map(collections.map((c) => [c.id, c.name]));
  return (
    <>
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
        title="Citation keys"
        help="settings.keys.what"
        intro="settings.keys.pattern"
        footer={
          <>
            Fields: <code>auth</code>, <code>authors(n)</code>, <code>authorsetal(n)</code>, <code>year</code>, <code>shorttitle(n)</code>, <code>veryshorttitle</code>, <code>title</code>, <code>"text"</code>, joined with <code>+</code>. Modifiers:{" "}
            <code>.lower</code>, <code>.upper</code>, <code>.capitalize</code>, <code>.raw</code> (keep accents), <code>.substring(1,3)</code>. A taken key gets a, b, c… Keys stay as they are when details change; pinned keys and keys from imported files never change.
          </>
        }
      >
        <Row label="Pattern" detail={preview && !preview.valid ? <span className="kx-citekey-error">{preview.error}</span> : preview?.examples.length ? (
              <span className="kx-citekey-examples">
                {preview.examples.slice(0, 3).map(([title, key]) => (
                  <span key={title}>
                    <code>{key}</code> {title}
                  </span>
                ))}
              </span>
            ) : undefined}>
          <input className="kx-settings-select kx-citekey-pattern" aria-label="Citation key pattern" value={pattern} placeholder={fallback} spellCheck={false} onChange={(e) => setPattern(e.target.value)} />
        </Row>
        <Row label="Apply" detail={note || "Regenerating changes every key that is not pinned."}>
          <button className="kx-settings-button" disabled={!preview?.valid || pattern === saved} onClick={() => void apply(false)}>
            Use for new sources
          </button>
          <button className="kx-settings-button" disabled={!preview?.valid} onClick={() => window.confirm("Generate every unpinned citation key again from this pattern? Documents citing the old keys would need updating.") && void apply(true)}>
            Regenerate keys…
          </button>
        </Row>
      </Group>
      <Group
        title="Auto-export"
        footer="Key rewrites each file a moment after the library changes, only when its contents change, keeping entries in key order so git and Overleaf diffs stay small. For Overleaf, keep the file in a folder synced with Dropbox or a clone of the project's git repository."
      >
        {targets.length === 0 && <Row label="No files are kept exported" detail="Export a library or collection and choose “Keep exported…”." />}
        {targets.map((t) => (
          <Row
            key={t.id}
            label={
              <>
                {t.path.split("/").pop()} <small className="kx-settings-tag">{FORMAT_LABEL[t.format] ?? t.format}</small>
              </>
            }
            detail={
              t.lastError ? (
                <span className="kx-citekey-error">{t.lastError}</span>
              ) : (
                `${t.collectionId ? names.get(t.collectionId) ?? "Collection" : "Whole library"} · ${t.count?.toLocaleString() ?? "–"} entries · written ${ago(t.lastWritten)} · ${t.path.replace(/^\/Users\/[^/]+/, "~")}`
              )
            }
          >
            <button className="kx-settings-button" onClick={() => void invoke<AutoExportTarget[]>("store_autoexport_run", { id: t.id }, workspaceId).then((all) => (setTargets(all), changed()))}>
              Write now
            </button>
            <button className="kx-settings-button" aria-label={`Show ${t.path} in Finder`} onClick={() => void bridge().revealPath(t.path)}>
              <Icon name="folder" size={12} />
            </button>
            <button
              className="kx-settings-button"
              aria-label={`Stop exporting to ${t.path}`}
              onClick={() => void invoke("store_autoexport_remove", { id: t.id }, workspaceId).then(() => (load(), changed()))}
            >
              Stop
            </button>
          </Row>
        ))}
        <Row label="Add a file">
          <button className="kx-settings-button" onClick={() => openBibExport({ workspaceId })}>
            Export…
          </button>
        </Row>
      </Group>
    </>
  );
}
