// The details panel for several selected sources: one editor for all of them. A field whose
// values differ shows "Multiple"; typing a value sets it on every source. Tags and
// collections are chips with three states (on all, on some, on none): clicking a partial
// chip adds it to all, its × takes it off all. Every change is one journaled host command
// (`store_edit`), so ⌘Z takes it back.
import { useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import { ITEM_TYPES, type Collection, type Facet, type Invoke, type Source } from "./library-api";
import type { PropertyDefinition } from "./PropertySheets";
import type { BatchEdit, Operation } from "./library-hygiene";
import "./hygiene.css";

const BATCH_FIELDS: [keyof Source & string, string, "number"?][] = [
  ["containerTitle", "Published in"],
  ["publisher", "Publisher"],
  ["year", "Year", "number"],
  ["date", "Date"],
  ["volume", "Volume"],
  ["issue", "Issue"],
  ["edition", "Edition"],
  ["series", "Series"],
  ["place", "Place"],
  ["institution", "Institution"],
  ["language", "Language"],
  ["rights", "Rights"],
  ["extra", "Extra"],
];

/** The shared value of a field, or `undefined` when the sources differ. */
function shared(sources: Source[], read: (s: Source) => unknown): { same: boolean; value: string } {
  const values = sources.map((s) => {
    const v = read(s);
    return v === undefined || v === null ? "" : String(v);
  });
  const same = values.every((v) => v === values[0]);
  return { same, value: same ? values[0] : "" };
}

function BatchField({ label, state, number, onCommit }: { label: string; state: { same: boolean; value: string }; number?: boolean; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(state.value);
  useEffect(() => setDraft(state.value), [state.value, state.same]);
  return (
    <label className="kx-field-row" data-mixed={!state.same || undefined}>
      <span>{label}</span>
      <input
        value={draft}
        inputMode={number ? "numeric" : undefined}
        placeholder={state.same ? "—" : "Multiple"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== state.value && onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(state.value);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

/** A chip on all, some or none of the sources. */
function TriChip({ label, icon, count, total, onAdd, onRemove }: { label: string; icon: "tag" | "folder"; count: number; total: number; onAdd: () => void; onRemove: () => void }) {
  const partial = count < total;
  return (
    <span className="kx-chip kx-tri-chip" data-partial={partial || undefined} title={partial ? `On ${count} of ${total} · click to add to all` : `On all ${total}`}>
      <button className="kx-tri-chip-label" onClick={partial ? onAdd : undefined} aria-label={partial ? `Add ${label} to all` : label}>
        <Icon name={partial ? "minus" : icon} size={11} />
        {label}
        {partial && <small>{count}</small>}
      </button>
      <button aria-label={`Remove ${label} from all`} onClick={onRemove}>
        <Icon name="close" size={9} />
      </button>
    </span>
  );
}

export default function BatchEditor({
  invoke,
  workspaceId,
  sources,
  total,
  collections,
  tagSuggestions,
  definitions,
  onEdited,
  onClear,
  onAction,
}: {
  invoke: Invoke;
  workspaceId: string;
  /** The selected sources that are loaded (a large selection may not all be). */
  sources: Source[];
  total: number;
  collections: Collection[];
  tagSuggestions: Facet[];
  definitions: PropertyDefinition[];
  onEdited: (message: string) => void;
  onClear: () => void;
  onAction: (action: "metadata" | "merge" | "retractions" | "trash") => void;
}) {
  const [error, setError] = useState("");
  const [newTag, setNewTag] = useState("");
  const ids = useMemo(() => sources.map((s) => s.id), [sources]);
  const n = sources.length;
  const edit = async (edit: BatchEdit) => {
    setError("");
    try {
      const op = await invoke<Operation>("store_edit", { ids, edit }, workspaceId);
      onEdited(op.entry ? op.entry.label : "Nothing changed");
    } catch (e) {
      setError(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ""));
    }
  };
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sources) for (const t of s.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [sources]);
  const filed = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sources) for (const c of s.collections) counts.set(c, (counts.get(c) ?? 0) + 1);
    return [...counts];
  }, [sources]);
  const names = new Map(collections.map((c) => [c.id, c.name]));
  const itemType = shared(sources, (s) => s.itemType || "document");
  const editable = definitions.filter((d) => d.type === "text" || d.type === "number" || d.type === "select" || d.type === "boolean");
  return (
    <div className="kx-batch" aria-label={`${n} sources`}>
      <header className="kx-batch-head">
        <div>
          <h2>{total.toLocaleString()} sources</h2>
          <p>{n < total ? `Changes apply to the ${n.toLocaleString()} loaded.` : "Changes apply to all of them. ⌘Z undoes."}</p>
        </div>
        <button className="kx-icon-button" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear}>
          <Icon name="close" size={13} />
        </button>
      </header>
      {error && <p className="kx-inline-error">{error}</p>}
      <section className="kx-page-properties kx-batch-fields" aria-label="Shared fields">
        <label className="kx-field-row" data-mixed={!itemType.same || undefined}>
          <span>Item type</span>
          <select
            className="kx-batch-select"
            value={itemType.same ? itemType.value : ""}
            onChange={(e) => e.target.value && void edit({ patch: { itemType: e.target.value } })}
          >
            {!itemType.same && <option value="">Multiple</option>}
            {ITEM_TYPES.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {BATCH_FIELDS.map(([key, label, kind]) => (
          <BatchField
            key={key}
            label={label}
            number={kind === "number"}
            state={shared(sources, (s) => s[key])}
            onCommit={(value) => void edit({ patch: { [key]: kind === "number" ? (value.trim() === "" ? null : Number(value)) : value } })}
          />
        ))}
        {editable.map((d) =>
          d.type === "select" || d.type === "boolean" ? (
            <label className="kx-field-row" key={d.name} data-mixed={!shared(sources, (s) => s.properties[d.name]).same || undefined}>
              <span>{d.name}</span>
              <select
                className="kx-batch-select"
                value={(() => {
                  const state = shared(sources, (s) => s.properties[d.name]);
                  return state.same ? state.value : "\u0000";
                })()}
                onChange={(e) => {
                  const raw = e.target.value;
                  const value = raw === "" ? null : d.type === "boolean" ? raw === "true" : raw;
                  void edit({ patch: { properties: { [d.name]: value } } });
                }}
              >
                {!shared(sources, (s) => s.properties[d.name]).same && <option value={"\u0000"}>Multiple</option>}
                <option value="">—</option>
                {(d.type === "boolean" ? ["true", "false"] : d.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {d.type === "boolean" ? (o === "true" ? "Yes" : "No") : o}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <BatchField
              key={d.name}
              label={d.name}
              number={d.type === "number"}
              state={shared(sources, (s) => s.properties[d.name])}
              onCommit={(value) => void edit({ patch: { properties: { [d.name]: value.trim() === "" ? null : d.type === "number" ? Number(value) : value } } })}
            />
          ),
        )}
        <div className="kx-field-row kx-page-chips">
          <span>Tags</span>
          <div className="kx-chips">
            {tags.map(([tag, count]) => (
              <TriChip key={tag} label={tag} icon="tag" count={count} total={n} onAdd={() => void edit({ tagsAdd: [tag] })} onRemove={() => void edit({ tagsRemove: [tag] })} />
            ))}
            <input
              className="kx-chip-input"
              list="kx-batch-tags"
              aria-label="Add a tag to all"
              placeholder="Add tag…"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTag.trim()) {
                  void edit({ tagsAdd: [newTag.trim()] });
                  setNewTag("");
                }
              }}
            />
            <datalist id="kx-batch-tags">
              {tagSuggestions.slice(0, 200).map((t) => (
                <option key={t.value} value={t.value} />
              ))}
            </datalist>
          </div>
        </div>
        <div className="kx-field-row kx-page-chips">
          <span>Collections</span>
          <div className="kx-chips">
            {filed.map(([id, count]) => (
              <TriChip
                key={id}
                label={names.get(id) ?? "Collection"}
                icon="folder"
                count={count}
                total={n}
                onAdd={() => void edit({ collectionsAdd: [id] })}
                onRemove={() => void edit({ collectionsRemove: [id] })}
              />
            ))}
            <select className="kx-chip-add" aria-label="Add all to collection" value="" onChange={(e) => e.target.value && void edit({ collectionsAdd: [e.target.value] })}>
              <option value="">+ Add to…</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>
      <section className="kx-batch-actions" aria-label="Actions">
        <button onClick={() => onAction("metadata")}>
          <Icon name="sync" size={13} /> Update metadata…
        </button>
        {n >= 2 && n <= 8 && (
          <button onClick={() => onAction("merge")}>
            <Icon name="layers" size={13} /> Merge {n} sources…
          </button>
        )}
        <button onClick={() => onAction("retractions")}>
          <Icon name="warning" size={13} /> Check for retractions
        </button>
        <button onClick={() => onAction("trash")}>
          <Icon name="trash" size={13} /> Move to Trash
        </button>
      </section>
    </div>
  );
}
