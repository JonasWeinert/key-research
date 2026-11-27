// Which databases to search: grouped by what they cover, with what each needs (a key, or a
// browser for the manual ones), how it has been working, and sets to pick at once (Health,
// Economics, your own). The workspace remembers its default choice.
import { useMemo, useState } from "react";
import { CATEGORY_LABEL, CATEGORY_ORDER, type DbConnector } from "./db-search-api";
import { GlobalDrawer } from "./GlobalDrawer";
import { Explain } from "./explain";
import { Icon } from "./icons";
import { openKeySettings } from "./settings-catalog";

export interface DatabaseSet {
  id: string;
  name: string;
  ids: string[];
  builtIn?: boolean;
}
// Built-in sets by what the databases cover, so they follow the connectors the host has.
const BUILT_IN: (Omit<DatabaseSet, "ids"> & { categories: string[]; free?: boolean })[] = [
  { id: "health", name: "Health", categories: ["biomedical", "health", "preprints", "trials", "registries"], builtIn: true },
  { id: "economics", name: "Economics", categories: ["economics", "grey", "grey-literature", "social-science"], builtIn: true },
  { id: "open", name: "Free to use", categories: ["biomedical", "health", "multidisciplinary", "preprints", "economics", "social-science", "grey", "grey-literature", "trials", "registries"], free: true, builtIn: true },
];
const setsKey = (ws: string) => `key.dbSearch.sets:${ws}`;
const defaultKey = (ws: string) => `key.dbSearch.default:${ws}`;
const read = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
export const readDefaultDatabases = (workspaceId: string): string[] => read(defaultKey(workspaceId), ["pubmed", "openalex"]);

/** A connector's state in one word: whether it can be searched now. */
export function connectorState(c: DbConnector): { tone: "ready" | "warning" | "error" | "idle"; text: string } {
  if (c.needsKey && !c.hasKey) return { tone: "idle", text: "Needs an API key" };
  if (c.manual) return { tone: "idle", text: "Opens in the browser" };
  if (c.health.state === "failing") return { tone: "error", text: `Failing (${c.health.failures} times)` };
  if (c.health.state === "outdated") return { tone: "warning", text: "May be out of date" };
  if (c.health.state === "unknown") return { tone: "idle", text: "Not used yet" };
  return { tone: "ready", text: "Working" };
}

/** The chosen databases as a row of chips with "Choose…", for the page's header. */
export function DatabaseStrip({ connectors, selected, onOpen, onRemove }: { connectors: DbConnector[]; selected: string[]; onOpen: () => void; onRemove: (id: string) => void }) {
  const chosen = selected.map((id) => connectors.find((c) => c.id === id)).filter((c): c is DbConnector => !!c);
  return (
    <div className="kx-db-strip" role="group" aria-label="Databases to search">
      <span className="kx-db-strip-label">Search in</span>
      {chosen.map((c) => {
        const state = connectorState(c);
        return (
          <span key={c.id} className="kx-db-strip-chip" data-tone={state.tone} title={`${c.name}: ${state.text}`}>
            <span className="kx-db-dot" aria-hidden="true" />
            {c.name}
            <button type="button" aria-label={`Don't search ${c.name}`} onClick={() => onRemove(c.id)}>
              <Icon name="close" size={8} />
            </button>
          </span>
        );
      })}
      <button type="button" className="kx-page-action" onClick={onOpen}>
        <Icon name="database" size={12} /> {chosen.length ? "Choose…" : "Choose databases…"}
      </button>
    </div>
  );
}

export function DatabasePicker({ workspaceId, connectors, selected, onChange, onClose }: { workspaceId: string; connectors: DbConnector[]; selected: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
  const [sets, setSets] = useState<DatabaseSet[]>(() => read(setsKey(workspaceId), []));
  const [filter, setFilter] = useState("");
  const [naming, setNaming] = useState<string>();
  const [savedDefault, setSavedDefault] = useState(false);
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const shown = connectors.filter((c) => !q || `${c.name} ${c.coverage} ${c.category}`.toLowerCase().includes(q));
    const cats = [...new Set(shown.map((c) => c.category))].sort((a, b) => (CATEGORY_ORDER.indexOf(a) + 99) % 99 - ((CATEGORY_ORDER.indexOf(b) + 99) % 99));
    return cats.map((cat) => ({ cat, items: shown.filter((c) => c.category === cat) }));
  }, [connectors, filter]);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  const known = new Set(connectors.map((c) => c.id));
  const builtIn = BUILT_IN.map(({ categories, free, ...s }) => ({ ...s, ids: connectors.filter((c) => categories.includes(c.category) && (!free || (!c.needsKey && !c.manual)) && !(c.needsKey && !c.hasKey)).map((c) => c.id) }));
  const allSets = [...builtIn, ...sets].map((s) => ({ ...s, ids: s.ids.filter((id) => known.has(id)) })).filter((s) => s.ids.length);
  const saveSet = (name: string) => {
    const next = [...sets.filter((s) => s.name !== name), { id: `set-${Date.now()}`, name, ids: selected }];
    setSets(next);
    write(setsKey(workspaceId), next);
    setNaming(undefined);
  };
  const removeSet = (id: string) => {
    const next = sets.filter((s) => s.id !== id);
    setSets(next);
    write(setsKey(workspaceId), next);
  };
  return (
    <GlobalDrawer presentation="sheet" label="Choose databases" onClose={onClose}>
      <div className="kx-db-picker" data-modal-view="databases">
        <header className="kx-db-picker-head">
          <div>
            <h2>Choose databases</h2>
            <p>
              Each database covers different journals and reports, so systematic searches use several. <Explain help="dbsearch.databases" />
            </p>
          </div>
          <button className="kx-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="kx-db-picker-bar">
          <input className="kx-db-picker-find" type="search" placeholder="Find a database" aria-label="Find a database" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
          <div className="kx-db-sets" role="group" aria-label="Sets">
            {allSets.map((s) => (
              <span key={s.id} className="kx-db-set">
                <button type="button" aria-pressed={s.ids.length === selected.length && s.ids.every((id) => selected.includes(id))} onClick={() => onChange(s.ids)} title={`Search ${s.ids.length} databases`}>
                  {s.name}
                </button>
                {!s.builtIn && (
                  <button type="button" className="kx-db-set-remove" aria-label={`Remove the set ${s.name}`} onClick={() => removeSet(s.id)}>
                    <Icon name="close" size={8} />
                  </button>
                )}
              </span>
            ))}
            {naming === undefined ? (
              <button type="button" className="kx-db-link" disabled={!selected.length} onClick={() => setNaming("")}>
                Save as set…
              </button>
            ) : (
              <input
                className="kx-db-set-name"
                autoFocus
                placeholder="Name of the set"
                aria-label="Name of the set"
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && naming.trim()) saveSet(naming.trim());
                  if (e.key === "Escape") (e.stopPropagation(), setNaming(undefined));
                }}
                onBlur={() => (naming.trim() ? saveSet(naming.trim()) : setNaming(undefined))}
              />
            )}
          </div>
        </div>
        <div className="kx-db-picker-body">
          {groups.map(({ cat, items }) => {
            const on = items.filter((c) => selected.includes(c.id)).length;
            return (
              <section key={cat} className="kx-db-group" aria-label={CATEGORY_LABEL[cat] ?? cat}>
                <header>
                  <h3>{CATEGORY_LABEL[cat] ?? cat}</h3>
                  <button
                    type="button"
                    className="kx-db-link"
                    onClick={() => onChange(on === items.length ? selected.filter((id) => !items.some((c) => c.id === id)) : [...new Set([...selected, ...items.map((c) => c.id)])])}
                  >
                    {on === items.length ? "Select none" : "Select all"}
                  </button>
                </header>
                {items.map((c) => {
                  const state = connectorState(c);
                  const checked = selected.includes(c.id);
                  return (
                    <label key={c.id} className="kx-db-option" data-connector={c.id} data-checked={checked || undefined} title={c.updatedAt ? `Connector ${c.version}, updated ${new Date(c.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}` : undefined}>
                      <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} />
                      <span className="kx-db-option-text">
                        <span className="kx-db-option-name">
                          {c.name}
                          {c.manual && <span className="kx-db-badge">Manual</span>}
                          {c.needsKey && <span className="kx-db-badge" data-tone={c.hasKey ? undefined : "warning"}>{c.hasKey ? "Key added" : "API key"}</span>}
                        </span>
                        <small>{c.coverage}</small>
                      </span>
                      <span className="kx-db-option-state" data-tone={state.tone}>
                        {c.needsKey && !c.hasKey ? (
                          <button
                            type="button"
                            className="kx-db-link"
                            onClick={(e) => {
                              e.preventDefault();
                              onClose();
                              openKeySettings("services");
                            }}
                          >
                            Add key…
                          </button>
                        ) : (
                          <>
                            <span className="kx-db-dot" aria-hidden="true" />
                            {state.text}
                          </>
                        )}

                      </span>
                    </label>
                  );
                })}
              </section>
            );
          })}
          {!groups.length && <p className="kx-db-muted">No database matches “{filter}”.</p>}
        </div>
        <footer className="kx-merge-actions">
          <button
            type="button"
            className="kx-db-link"
            disabled={!selected.length}
            onClick={() => {
              write(defaultKey(workspaceId), selected);
              setSavedDefault(true);
            }}
          >
            {savedDefault ? "Saved as this workspace's default" : "Use as default for this workspace"}
          </button>
          <span className="kx-spacer" />
          <span className="kx-db-muted">{selected.length ? `${selected.length} chosen` : "None chosen"}</span>
          <button type="button" className="kx-page-action kx-page-action-primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </GlobalDrawer>
  );
}
