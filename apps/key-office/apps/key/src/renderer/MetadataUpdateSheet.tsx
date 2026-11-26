// "Update metadata…": what OpenAlex (or Crossref) says now about one or many sources, as
// old → new per field with a checkbox each. Fields the user edited by hand are listed but
// not ticked. Nothing changes until Apply, which is one journaled operation (⌘Z undoes).
// A preprint that has been published since is offered its published version, linked.
import { useEffect, useMemo, useState } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon } from "./icons";
import { libraryChanged } from "./library-nav";
import type { Invoke } from "./library-api";
import { valueText, type Operation, type RefreshProposal } from "./library-hygiene";
import "./hygiene.css";

const clip = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export default function MetadataUpdateSheet({ invoke, workspaceId, ids, onClose, onDone }: { invoke: Invoke; workspaceId: string; ids: string[]; onClose: () => void; onDone: (message: string) => void }) {
  const [proposals, setProposals] = useState<RefreshProposal[]>();
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [linked, setLinked] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void invoke<RefreshProposal[]>("store_refresh_metadata", { ids }, workspaceId)
      .then((list) => {
        if (!live) return;
        setProposals(list);
        setPicked(Object.fromEntries(list.flatMap((p) => p.changes.map((c) => [`${p.id}:${c.field}`, c.selected]))));
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, ids]);
  const changed = useMemo(() => (proposals ?? []).filter((p) => p.changes.length || p.published), [proposals]);
  const current = (proposals ?? []).filter((p) => !p.error && !p.changes.length && !p.published).length;
  const failed = (proposals ?? []).filter((p) => p.error);
  const count = Object.values(picked).filter(Boolean).length;
  const apply = async () => {
    if (!proposals) return;
    setBusy(true);
    try {
      const items = proposals
        .map((p) => ({ id: p.id, fields: Object.fromEntries(p.changes.filter((c) => picked[`${p.id}:${c.field}`]).map((c) => [c.field, c.new])) }))
        .filter((i) => Object.keys(i.fields).length);
      const op = await invoke<Operation>("store_apply_metadata", { items }, workspaceId);
      libraryChanged();
      onDone(op.entry?.label ?? "Nothing changed");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const linkPublished = async (p: RefreshProposal) => {
    if (!p.published) return;
    const result = await invoke<{ id: string }>("store_add_published", { id: p.id, published: p.published }, workspaceId);
    setLinked({ ...linked, [p.id]: result.id });
    libraryChanged();
  };
  return (
    <GlobalDrawer onClose={onClose} presentation="sheet" label="Update metadata">
      <div className="key-property-editor kx-metadata-sheet" role="dialog" aria-label="Update metadata">
        <header>
          <h2>Update metadata</h2>
          <p>
            {!proposals
              ? `Looking up ${ids.length === 1 ? "this source" : `${ids.length} sources`} in OpenAlex and Crossref…`
              : changed.length
                ? `${changed.length} ${changed.length === 1 ? "source has" : "sources have"} newer details. Fields you edited by hand are not ticked.`
                : "Everything is up to date."}
          </p>
          <button className="kx-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="key-property-body">
          {!proposals && !error && (
            <div className="kx-metadata-wait">
              <span className="kx-spinner" aria-hidden />
              <span>Asking OpenAlex…</span>
            </div>
          )}
          {changed.map((p) => (
            <section key={p.id} className="kx-metadata-source">
              <h3>
                {p.title || "Untitled"}
                <small>{p.via === "crossref" ? "Crossref" : "OpenAlex"}</small>
              </h3>
              {p.published && (
                <div className="kx-metadata-published">
                  <Icon name="book" size={13} />
                  <span>
                    Published since{p.published.venue ? ` in ${p.published.venue}` : ""}
                    {p.published.year ? ` (${p.published.year})` : ""} · {p.published.doi}
                  </span>
                  {linked[p.id] || p.published.sourceId ? (
                    <em>{linked[p.id] ? "Added and linked" : "In your library"}</em>
                  ) : (
                    <button className="kx-page-action" onClick={() => void linkPublished(p)}>
                      Add and link
                    </button>
                  )}
                </div>
              )}
              {p.changes.length > 0 && (
                <ul className="kx-metadata-changes">
                  {p.changes.map((c) => {
                    const key = `${p.id}:${c.field}`;
                    return (
                      <li key={key}>
                        <label>
                          <input type="checkbox" checked={!!picked[key]} onChange={(e) => setPicked({ ...picked, [key]: e.target.checked })} />
                          <span className="kx-metadata-field">
                            {c.label[0].toUpperCase() + c.label.slice(1)}
                            {c.edited && <small title="You set this field by hand">edited by you</small>}
                          </span>
                          <span className="kx-metadata-diff">
                            {valueText(c.old) ? <del>{clip(valueText(c.old))}</del> : <i>empty</i>}
                            <Icon name="arrowRight" size={11} />
                            <ins>{clip(valueText(c.new))}</ins>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
          {proposals && (current > 0 || failed.length > 0) && (
            <p className="kx-metadata-rest">
              {current > 0 && `${current} up to date. `}
              {failed.length > 0 && `${failed.length} not found${failed.length === 1 && failed[0].error ? `: ${failed[0].error}` : ""}.`}
            </p>
          )}
          {error && <p className="kx-inline-error">{error}</p>}
        </div>
        <footer className="kx-merge-actions">
          <span className="kx-spacer" />
          <button className="kx-page-action" onClick={onClose}>
            {count ? "Cancel" : "Done"}
          </button>
          {count > 0 && (
            <button className="kx-page-action kx-page-action-primary" disabled={busy} onClick={() => void apply()}>
              Apply {count} {count === 1 ? "change" : "changes"}
            </button>
          )}
        </footer>
      </div>
    </GlobalDrawer>
  );
}
