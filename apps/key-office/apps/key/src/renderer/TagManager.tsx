// The tag manager: a window-sized sheet with the library's tags as a tree on the left
// (search, sort, multi-select, drag to nest, inline rename, colours) and on the right the
// suggestions the host's analysis finds (`store_tag_suggestions`), or the form for what the
// selection should become. Every change is planned by the host (`store_tag_plan`), applied
// as one store transaction (`store_tag_apply`) and can be undone.
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { entityFilter } from "./entity-ui";
import { showInLibrary } from "./filter-links";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon } from "./icons";
import type { Invoke } from "./library-api";
import { fold, plural, splitPath, valueLabel, type PropertyInfo, type Suggestion, type SuggestionKind, type TagIndex } from "./tag-analysis";
import { ancestors, buildTree, planChange, sortTree, visibleRows, type ManagerPlan, type PlannedChange, type TagNode, type TagSort } from "./tag-plan";
import "./tag-manager.css";

/** A tag operation's entry in the library's operations journal (the History tab shows those). */
interface HistoryEntry {
  seq: number;
  kind: string;
  label: string;
  /** Items it changed. */
  count: number;
  createdAt: number;
  undone?: boolean;
}
interface JournalState {
  undo?: HistoryEntry | null;
  entries: HistoryEntry[];
}
type Panel =
  | { mode: "suggestions" }
  | { mode: "merge"; tags: string[]; to?: string }
  | { mode: "nest"; tags: string[]; parent?: string }
  | { mode: "convert"; tags: string[]; name?: string; type?: "boolean" | "select"; values?: [string, string][] }
  | { mode: "delete"; tags: string[] }
  | { mode: "history" };

const GROUPS: [SuggestionKind, string, string][] = [
  ["merge", "Merge duplicates", "Variants of one tag, and tags always used together"],
  ["nest", "Nest under", "Tags that sit inside a broader one, or share a theme"],
  ["hierarchy", "Hierarchy from names", "Names that spell out a path"],
  ["property", "Convert to property", "Tags that read as a checkbox or as one property’s values"],
  ["cleanup", "Clean up", "Noise, automatic headings and rarely used tags"],
];
const COLORS = ["blue", "indigo", "green", "amber", "red", "gray"] as const;
const DISMISSED_KEY = "tagManager.dismissed";
const ROW = 28;
const key = (name: string) => fold(name.trim());
const confidenceLabel = (c: number) => (c >= 0.8 ? "Very likely" : c >= 0.6 ? "Likely" : "Worth a look");

export default function TagManager({ invoke, workspaceId, onClose, focus }: { invoke: Invoke; workspaceId: string; onClose: () => void; focus?: string }) {
  const [index, setIndex] = useState<TagIndex>();
  const [properties, setProperties] = useState<PropertyInfo[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>();
  const [dismissed, setDismissed] = useState<Set<string>>();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<TagSort>("name");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set(focus ? [key(focus)] : []));
  const anchor = useRef<string | undefined>(undefined);
  const [renaming, setRenaming] = useState<string>();
  const [panel, setPanel] = useState<Panel>({ mode: "suggestions" });
  const [journal, setJournal] = useState<JournalState>({ entries: [] });
  const history = journal.entries.filter((entry) => entry.kind === "tags");
  const opened = useRef(Date.now());
  // The footer reports what was done since the manager opened.
  const latest = history.find((entry) => !entry.undone && entry.createdAt >= opened.current);
  /** The newest tag entry, when it is also the library's next undo. */
  const undoable = history.find((entry) => entry.seq === journal.undo?.seq);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; tags: string[] }>();
  const [dropTarget, setDropTarget] = useState<string>();

  const load = useCallback(async () => {
    const [next, defs] = await Promise.all([
      invoke<TagIndex>("store_tag_index", {}, workspaceId),
      invoke<PropertyInfo[]>("workspace_attributes", {}, workspaceId).catch(() => []),
    ]);
    setIndex(next);
    setProperties(defs);
    setJournal(await invoke<JournalState>("store_journal", { limit: 100 }, workspaceId).catch(() => ({ entries: [] })));
  }, [invoke, workspaceId]);
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
    void invoke<string[] | null>("store_ui_get", { key: DISMISSED_KEY }, workspaceId)
      .then((ids) => setDismissed(new Set(Array.isArray(ids) ? ids : [])))
      .catch(() => setDismissed(new Set()));
  }, [load, invoke, workspaceId]);

  // The host analyses the tags again after every change; stale answers are dropped.
  const analysis = useRef(0);
  useEffect(() => {
    if (!index || !dismissed) return;
    const run = ++analysis.current;
    void invoke<Suggestion[]>("store_tag_suggestions", { dismissed: [...dismissed] }, workspaceId)
      .then((list) => run === analysis.current && setSuggestions(list))
      .catch(() => run === analysis.current && setSuggestions([]));
  }, [index, dismissed, invoke, workspaceId]);

  const tree = useMemo(() => (index ? buildTree(index) : undefined), [index]);
  const roots = useMemo(() => (tree ? sortTree(tree.roots, sort) : []), [tree, sort]);
  const rows = useMemo(() => visibleRows(roots, expanded, query), [roots, expanded, query]);
  const nameOf = (k: string) => tree?.nodes.get(k)?.name ?? k;
  const selection = [...selected].filter((k) => tree?.nodes.has(k)).map(nameOf);

  // Opened for one tag: show it.
  useEffect(() => {
    if (!focus || !tree) return;
    setExpanded((old) => new Set([...old, ...ancestors(tree, focus).map(key)]));
  }, [focus, !!tree]);

  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 12 });

  // ── Applying and undoing ──
  const apply = async (changes: PlannedChange[], label?: string) => {
    if (!changes.length) return;
    setBusy(true);
    setError("");
    try {
      // One journal entry for all of it: ⌘Z here or in the library takes it back.
      await invoke("store_tag_apply_many", { operations: changes.map((c) => c.operation), label: label ?? changes[0].label }, workspaceId);
      setPanel({ mode: "suggestions" });
      setSelected(new Set());
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      await load().catch(() => {});
      setBusy(false);
    }
  };
  const run = (plan: ManagerPlan, label?: string) => {
    if (!index || busy) return;
    void planChange(invoke, workspaceId, plan).then(
      (change) => apply([change], label),
      (e) => setError(String(e).replace(/^Error: /, "")),
    );
  };
  const undo = async () => {
    setBusy(true);
    setError("");
    try {
      await invoke("store_undo", {}, workspaceId);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      await load().catch(() => {});
      setBusy(false);
    }
  };
  const dismiss = (ids: string[]) => {
    const next = new Set([...(dismissed ?? []), ...ids]);
    setDismissed(next);
    setSuggestions((list) => list?.filter((s) => !next.has(s.id)));
    void invoke("store_ui_set", { key: DISMISSED_KEY, value: [...next].slice(-5000) }, workspaceId).catch(() => {});
  };
  const applySuggestions = (list: Suggestion[]) => {
    if (!index) return;
    // Each one comes planned against the tags as they are now (stale ones have no change);
    // ones a previous one already covered are skipped.
    const changes: PlannedChange[] = [];
    const touched = new Set<string>();
    for (const s of list) {
      if (!s.change || s.tags.some((t) => touched.has(key(t)))) continue;
      changes.push(s.change);
      s.tags.forEach((t) => touched.add(key(t)));
    }
    void apply(changes, list.length === 1 ? changes[0]?.label : `Applied ${plural(changes.length, "suggestion")}`);
  };

  // ── Selection ──
  const click = (node: TagNode, e: React.MouseEvent) => {
    const k = key(node.name);
    if (e.shiftKey && anchor.current) {
      const at = rows.findIndex((r) => key(r.name) === anchor.current),
        to = rows.findIndex((r) => key(r.name) === k);
      const [a, b] = at < to ? [at, to] : [to, at];
      setSelected(new Set(rows.slice(a, b + 1).map((r) => key(r.name))));
      return;
    }
    anchor.current = k;
    if (e.metaKey || e.ctrlKey)
      setSelected((old) => {
        const next = new Set(old);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        return next;
      });
    else setSelected(new Set([k]));
  };
  const toggle = (node: TagNode) =>
    setExpanded((old) => {
      const next = new Set(old);
      const k = key(node.name);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const dragged = useRef<string[]>([]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && (menu || renaming || panel.mode !== "suggestions")) {
      e.stopPropagation();
      e.preventDefault();
      if (menu) setMenu(undefined);
      else if (renaming) setRenaming(undefined);
      else setPanel({ mode: "suggestions" });
      return;
    }
    const typing = (e.target as HTMLElement).closest("input, textarea, select");
    if (typing) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "z" && undoable && !busy) {
      e.preventDefault();
      void undo();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "f") {
      e.preventDefault();
      document.querySelector<HTMLInputElement>(".kx-tm-search input")?.focus();
    }
    if (!selection.length) return;
    if (e.key === "Enter" && selection.length === 1) {
      e.preventDefault();
      setRenaming(key(selection[0]));
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      setPanel({ mode: "delete", tags: selection });
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const at = rows.findIndex((r) => key(r.name) === (anchor.current ?? key(selection[0])));
      const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        anchor.current = key(next.name);
        setSelected(new Set([key(next.name)]));
        virtual.scrollToIndex(rows.indexOf(next));
      }
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const node = tree?.nodes.get(anchor.current ?? key(selection[0]));
      if (node?.children.length) setExpanded((old) => new Set(e.key === "ArrowRight" ? [...old, key(node.name)] : [...old].filter((k) => k !== key(node.name))));
    }
  };

  const total = index?.tags.length ?? 0;
  const groups = GROUPS.map(([kind, title, detail]) => ({ kind, title, detail, list: (suggestions ?? []).filter((s) => s.kind === kind) })).filter((g) => g.list.length);
  const highlighted = useMemo(() => new Set(panel.mode !== "suggestions" && "tags" in panel ? panel.tags.map(key) : []), [panel]);

  return (
    <GlobalDrawer presentation="window" label="Tags" onClose={onClose} busy={busy}>
      <div className="kx-tag-manager" role="dialog" aria-label="Manage tags" onKeyDown={onKey}>
        <header className="kx-tm-head">
          <div className="kx-tm-title">
            <h1>Tags</h1>
            <small>{index ? `${plural(total, "tag")} on ${plural(index.items.length, "item")}` : "Reading tags…"}</small>
          </div>
          <label className="kx-tm-search">
            <Icon name="search" size={12} />
            <input
              placeholder="Filter tags"
              value={query}
              aria-label="Filter tags"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
            />
          </label>
          <div className="kx-segmented kx-tm-sort" role="group" aria-label="Sort tags">
            <button aria-pressed={sort === "name"} title="Sort by name" onClick={() => setSort("name")}>
              Name
            </button>
            <button aria-pressed={sort === "count"} title="Sort by use" onClick={() => setSort("count")}>
              Use
            </button>
          </div>
          <button className="kx-sheet-close" aria-label="Close tags" disabled={busy} onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="kx-tm-body">
          <section className="kx-tm-tree" aria-label="All tags">
            <div className="kx-tm-toolbar" data-active={selection.length > 0 || undefined}>
              {selection.length ? (
                <>
                  <span className="kx-tm-count">{plural(selection.length, "tag")} selected</span>
                  <span className="kx-spacer" />
                  {selection.length > 1 && <ToolButton icon="group" label="Merge…" onClick={() => setPanel({ mode: "merge", tags: selection })} />}
                  <ToolButton icon="layers" label="Nest…" onClick={() => setPanel({ mode: "nest", tags: selection })} />
                  <ToolButton icon="table" label="Convert…" onClick={() => setPanel({ mode: "convert", tags: selection })} />
                  <ToolButton icon="trash" label="Remove…" onClick={() => setPanel({ mode: "delete", tags: selection })} />
                </>
              ) : (
                <span className="kx-tm-hint">Select tags to merge, nest or convert them. Drag a tag onto another to nest it.</span>
              )}
            </div>
            <div
              className="kx-tm-list"
              ref={scroller}
              role="tree"
              aria-multiselectable="true"
              tabIndex={0}
              data-drop={dropTarget === "" || undefined}
              onDragOver={(e) => {
                if (!dragged.current.length) return;
                e.preventDefault();
                if ((e.target as HTMLElement).closest(".kx-tm-row")) return;
                setDropTarget("");
              }}
              onDragLeave={() => setDropTarget(undefined)}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget(undefined);
                const tags = dragged.current;
                dragged.current = [];
                if (!(e.target as HTMLElement).closest(".kx-tm-row") && tags.some((t) => tree?.nodes.get(key(t))?.parent)) run({ type: "unnest", tags });
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) setSelected(new Set());
              }}
            >
              {!index ? (
                <div className="kx-tm-empty">
                  <span className="kx-tm-spinner" />
                </div>
              ) : !rows.length ? (
                <div className="kx-tm-empty">{query ? "No tags match." : "No tags yet. Tags you add to sources show here."}</div>
              ) : (
                <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
                  {virtual.getVirtualItems().map((v) => {
                    const node = rows[v.index];
                    const k = key(node.name);
                    return (
                      <TagRow
                        key={k}
                        node={node}
                        top={v.start}
                        selected={selected.has(k)}
                        highlighted={highlighted.has(k)}
                        expanded={expanded.has(k) || !!query}
                        renaming={renaming === k}
                        drop={dropTarget === k}
                        onClick={(e) => click(node, e)}
                        onToggle={() => toggle(node)}
                        onRename={() => setRenaming(k)}
                        onRenamed={(to) => {
                          setRenaming(undefined);
                          if (to.trim() && to.trim() !== node.name) run({ type: "rename", tag: node.name, to: to.trim() });
                        }}
                        onMenu={(e) => {
                          e.preventDefault();
                          const tags = selected.has(k) ? selection : [node.name];
                          if (!selected.has(k)) setSelected(new Set([k]));
                          setMenu({ x: e.clientX, y: e.clientY, tags });
                        }}
                        onDragStart={(e) => {
                          const tags = selected.has(k) ? selection : [node.name];
                          dragged.current = tags;
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", tags.join(", "));
                        }}
                        onDragOver={(e) => {
                          if (!dragged.current.length || dragged.current.some((t) => key(t) === k || (tree && ancestors(tree, node.name).some((a) => key(a) === key(t))))) return;
                          e.preventDefault();
                          e.stopPropagation();
                          setDropTarget(k);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDropTarget(undefined);
                          const tags = dragged.current;
                          dragged.current = [];
                          if (tags.length) {
                            setExpanded((old) => new Set([...old, k]));
                            run({ type: "nest", parent: node.name, children: tags });
                          }
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </section>
          <section className="kx-tm-side" aria-label={panel.mode === "suggestions" ? "Suggestions" : "Change tags"}>
            {panel.mode === "suggestions" || panel.mode === "history" ? (
              <>
                <div className="kx-tm-tabs" role="tablist">
                  <button role="tab" aria-selected={panel.mode === "suggestions"} onClick={() => setPanel({ mode: "suggestions" })}>
                    Suggestions {suggestions && <span className="kx-tm-badge">{suggestions.length}</span>}
                  </button>
                  <button role="tab" aria-selected={panel.mode === "history"} onClick={() => setPanel({ mode: "history" })}>
                    History {history.length > 0 && <span className="kx-tm-badge">{history.length}</span>}
                  </button>
                </div>
                <div className="kx-tm-side-scroll">
                  {panel.mode === "history" ? (
                    <History history={history} undoable={undoable} busy={busy} onUndo={() => void undo()} />
                  ) : !suggestions ? (
                    <div className="kx-tm-empty">
                      <span className="kx-tm-spinner" />
                      <span>Reading {plural(total, "tag")}…</span>
                    </div>
                  ) : !groups.length ? (
                    <div className="kx-tm-empty">
                      <Icon name="check" size={16} />
                      <span>Nothing to tidy. Your tags look well organised.</span>
                    </div>
                  ) : (
                    groups.map((group) => (
                      <SuggestionGroup
                        key={group.kind}
                        title={group.title}
                        detail={group.detail}
                        list={group.list}
                        busy={busy}
                        preview={(s) => s.change}
                        onSelect={(s) => setSelected(new Set(s.tags.filter((t) => tree?.nodes.has(key(t))).map(key)))}
                        onApply={(list) => applySuggestions(list)}
                        onDismiss={(list) => dismiss(list.map((s) => s.id))}
                        onEdit={(s) => {
                          if (s.plan.type === "property") setPanel({ mode: "convert", tags: s.plan.values.map(([t]) => t), name: s.plan.name, type: s.plan.propertyType, values: s.plan.values.map(([t, v]) => [t, String(v)]) });
                          else if (s.plan.type === "merge") setPanel({ mode: "merge", tags: [...s.plan.from, s.plan.to], to: s.plan.to });
                          else if (s.plan.type === "nest") setPanel({ mode: "nest", tags: s.plan.children, parent: s.plan.parent });
                          else if (s.plan.type === "delete") setPanel({ mode: "delete", tags: s.plan.tags });
                        }}
                      />
                    ))
                  )}
                </div>
              </>
            ) : index && tree ? (
              <ActionPanel
                key={JSON.stringify(panel)}
                panel={panel}
                invoke={invoke}
                workspaceId={workspaceId}
                tree={tree}
                properties={properties}
                busy={busy}
                onCancel={() => setPanel({ mode: "suggestions" })}
                onApply={(plan) => run(plan)}
              />
            ) : null}
          </section>
        </div>
        <footer className="kx-tm-foot">
          {error ? (
            <span className="kx-tm-error" role="alert">
              <Icon name="warning" size={12} /> {error}
            </span>
          ) : latest ? (
            <span className="kx-tm-last" role="status">
              <Icon name="check" size={12} /> {latest.label}
              {latest.count > 0 && ` · ${plural(latest.count, "item")} updated`}
            </span>
          ) : (
            <span className="kx-tm-last">Changes apply to every item in the library at once.</span>
          )}
          <span className="kx-spacer" />
          {undoable && (
            <button className="kx-tm-button" disabled={busy} onClick={() => void undo()} title="Undo (⌘Z)">
              <Icon name="undo" size={12} /> Undo
            </button>
          )}
          <button className="kx-tm-button kx-tm-primary" disabled={busy} onClick={onClose}>
            Done
          </button>
        </footer>
        {menu && tree && (
          <RowMenu
            menu={menu}
            tree={tree}
            onClose={() => setMenu(undefined)}
            onRename={() => setRenaming(key(menu.tags[0]))}
            onPanel={setPanel}
            onRun={run}
            onShow={() => {
              onClose();
              showInLibrary(workspaceId, entityFilter({ kind: "tag", id: menu.tags[0], name: menu.tags[0] }));
            }}
          />
        )}
      </div>
    </GlobalDrawer>
  );
}

function ToolButton({ icon, label, onClick }: { icon: Parameters<typeof Icon>[0]["name"]; label: string; onClick: () => void }) {
  return (
    <button className="kx-tm-tool" onClick={onClick}>
      <Icon name={icon} size={12} />
      {label}
    </button>
  );
}

function TagRow(props: {
  node: TagNode;
  top: number;
  selected: boolean;
  highlighted: boolean;
  expanded: boolean;
  renaming: boolean;
  drop: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggle: () => void;
  onRename: () => void;
  onRenamed: (to: string) => void;
  onMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { node } = props;
  const [draft, setDraft] = useState(node.name);
  return (
    <div
      className="kx-tm-row"
      role="treeitem"
      aria-selected={props.selected}
      aria-expanded={node.children.length ? props.expanded : undefined}
      aria-level={node.depth + 1}
      data-highlight={props.highlighted || undefined}
      data-drop={props.drop || undefined}
      data-group={node.group || undefined}
      data-tag={node.name}
      style={{ top: props.top, paddingLeft: 8 + node.depth * 16 }}
      draggable={!props.renaming}
      onClick={props.onClick}
      onDoubleClick={props.onRename}
      onContextMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDragLeave={(e) => e.currentTarget.removeAttribute("data-drop")}
      onDrop={props.onDrop}
    >
      <button
        className="kx-tm-disclosure"
        tabIndex={-1}
        aria-hidden={!node.children.length}
        style={{ visibility: node.children.length ? "visible" : "hidden" }}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggle();
        }}
      >
        <Icon name="chevronRight" size={10} />
      </button>
      <span className="kx-tm-dot" data-color={node.color || undefined} data-group={node.group || undefined}>
        {node.group && <Icon name="folder" size={12} />}
      </span>
      {props.renaming ? (
        <input
          className="kx-tm-rename"
          autoFocus
          value={draft}
          aria-label={`Rename ${node.name}`}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => props.onRenamed(draft)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") props.onRenamed(draft);
            if (e.key === "Escape") props.onRenamed(node.name);
          }}
        />
      ) : (
        <span className="kx-tm-name" title={node.name}>
          {node.name}
        </span>
      )}
      <span className="kx-tm-num" title={node.children.length ? `${plural(node.count, "item")} tagged directly, ${node.total.toLocaleString()} with the tags inside` : undefined}>
        {node.total.toLocaleString()}
      </span>
    </div>
  );
}

function RowMenu({
  menu,
  tree,
  onClose,
  onRename,
  onPanel,
  onRun,
  onShow,
}: {
  menu: { x: number; y: number; tags: string[] };
  tree: ReturnType<typeof buildTree>;
  onClose: () => void;
  onRename: () => void;
  onPanel: (panel: Panel) => void;
  onRun: (plan: ManagerPlan) => void;
  onShow: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close.current();
    window.addEventListener("pointerdown", away, true);
    ref.current?.querySelector("button")?.focus();
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);
  const one = menu.tags.length === 1 ? menu.tags[0] : undefined;
  const nested = menu.tags.some((t) => tree.nodes.get(key(t))?.parent);
  const item = (label: string, action: () => void, danger = false) => (
    <button
      role="menuitem"
      data-danger={danger || undefined}
      onClick={() => {
        onClose();
        action();
      }}
    >
      {label}
    </button>
  );
  // The sheet is the menu's frame (it may be transformed while it animates).
  const frame = (ref.current?.offsetParent ?? document.querySelector(".kx-tag-manager"))?.getBoundingClientRect();
  const left = menu.x - (frame?.left ?? 0),
    top = menu.y - (frame?.top ?? 0);
  const style = { left: Math.min(left, (frame?.width ?? window.innerWidth) - 230), top: Math.min(top, (frame?.height ?? window.innerHeight) - 330) };
  return (
    <div ref={ref} className="kx-tm-menu" role="menu" style={style}>
      {one && item("Rename", onRename)}
      {menu.tags.length > 1 && item(`Merge ${menu.tags.length} tags…`, () => onPanel({ mode: "merge", tags: menu.tags }))}
      {item("Nest under…", () => onPanel({ mode: "nest", tags: menu.tags }))}
      {item(menu.tags.length > 1 ? "Group under a new tag…" : "Add a broader tag above…", () => onPanel({ mode: "nest", tags: menu.tags, parent: "" }))}
      {nested && item("Move to top level", () => onRun({ type: "unnest", tags: menu.tags }))}
      <hr />
      <div className="kx-tm-swatches" role="group" aria-label="Colour">
        {COLORS.map((c) => (
          <button
            key={c}
            className="kx-tm-dot"
            data-color={c}
            aria-label={c}
            title={c[0].toUpperCase() + c.slice(1)}
            onClick={() => {
              onClose();
              onRun({ type: "color", tags: menu.tags, color: c });
            }}
          />
        ))}
        <button
          className="kx-tm-dot"
          data-none
          aria-label="No colour"
          title="No colour"
          onClick={() => {
            onClose();
            onRun({ type: "color", tags: menu.tags, color: null });
          }}
        />
      </div>
      <hr />
      {item(menu.tags.length > 1 ? "Convert to a property…" : "Convert to a checkbox…", () => onPanel({ mode: "convert", tags: menu.tags }))}
      {one && !tree.nodes.get(key(one))?.group && item("Show items in library", onShow)}
      <hr />
      {item(menu.tags.length > 1 ? `Remove ${menu.tags.length} tags…` : "Remove…", () => onPanel({ mode: "delete", tags: menu.tags }), true)}
    </div>
  );
}

function SuggestionGroup({
  title,
  detail,
  list,
  busy,
  preview,
  onSelect,
  onApply,
  onDismiss,
  onEdit,
}: {
  title: string;
  detail: string;
  list: Suggestion[];
  busy: boolean;
  preview: (s: Suggestion) => PlannedChange | undefined;
  onSelect: (s: Suggestion) => void;
  onApply: (list: Suggestion[]) => void;
  onDismiss: (list: Suggestion[]) => void;
  onEdit: (s: Suggestion) => void;
}) {
  const [more, setMore] = useState(false);
  const shown = more ? list : list.slice(0, 6);
  const confident = list.filter((s) => s.confidence >= 0.6);
  return (
    <section className="kx-tm-group" aria-label={title}>
      <header>
        <div>
          <h3>
            {title} <span className="kx-tm-badge">{list.length}</span>
          </h3>
          <small>{detail}</small>
        </div>
        {confident.length > 1 && (
          <button className="kx-tm-link" disabled={busy} onClick={() => onApply(confident)} title="Apply the likely ones in this group">
            Apply {confident.length === list.length ? "all" : `${confident.length} likely`}
          </button>
        )}
      </header>
      {shown.map((s) => (
        <SuggestionCard key={s.id} suggestion={s} busy={busy} preview={preview} onSelect={onSelect} onApply={() => onApply([s])} onDismiss={() => onDismiss([s])} onEdit={() => onEdit(s)} />
      ))}
      {list.length > shown.length && (
        <button className="kx-tm-more" onClick={() => setMore(true)}>
          Show {list.length - shown.length} more
        </button>
      )}
    </section>
  );
}

function SuggestionCard({
  suggestion: s,
  busy,
  preview,
  onSelect,
  onApply,
  onDismiss,
  onEdit,
}: {
  suggestion: Suggestion;
  busy: boolean;
  preview: (s: Suggestion) => PlannedChange | undefined;
  onSelect: (s: Suggestion) => void;
  onApply: () => void;
  onDismiss: () => void;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const change = open ? preview(s) : undefined;
  return (
    <article className="kx-tm-card" data-open={open || undefined} data-suggestion={s.id}>
      <button
        className="kx-tm-card-head"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          onSelect(s);
        }}
      >
        <span className="kx-tm-card-title">{s.title}</span>
        <small>
          <span className="kx-tm-confidence" data-level={s.confidence >= 0.8 ? "high" : s.confidence >= 0.6 ? "mid" : "low"}>
            {confidenceLabel(s.confidence)}
          </span>
          {s.evidence}
          {s.items > 0 && ` · ${plural(s.items, "item")}`}
        </small>
      </button>
      {open && (
        <div className="kx-tm-preview">
          {change ? <PreviewLines change={change} /> : <p className="kx-tm-stale">These tags changed since this was suggested.</p>}
        </div>
      )}
      <div className="kx-tm-card-actions">
        <button className="kx-tm-button kx-tm-primary kx-tm-small" disabled={busy} onClick={onApply}>
          Apply
        </button>
        {s.plan.type !== "hierarchy" && (
          <button className="kx-tm-button kx-tm-small" disabled={busy} onClick={onEdit}>
            Edit…
          </button>
        )}
        <span className="kx-spacer" />
        <button className="kx-tm-icon" disabled={busy} onClick={onDismiss} title="Dismiss" aria-label={`Dismiss: ${s.title}`}>
          <Icon name="close" size={10} />
        </button>
      </div>
    </article>
  );
}

function PreviewLines({ change, limit = 8 }: { change: PlannedChange; limit?: number }) {
  const [all, setAll] = useState(false);
  const lines = all ? change.lines : change.lines.slice(0, limit);
  return (
    <>
      <ul className="kx-tm-lines">
        {lines.map((line, i) => (
          <li key={i}>
            <span className="kx-tm-chip">{line.before}</span>
            {line.after ? (
              <>
                <Icon name="arrowRight" size={10} />
                <span className="kx-tm-chip" data-after>
                  {line.after}
                </span>
              </>
            ) : null}
            {line.detail && <small>{line.detail}</small>}
          </li>
        ))}
      </ul>
      {change.lines.length > lines.length && (
        <button className="kx-tm-more" onClick={() => setAll(true)}>
          {change.lines.length - lines.length} more
        </button>
      )}
      <p className="kx-tm-summary">{change.items > 0 ? `${plural(change.items, "item")} change. ` : "No item changes; only the tree. "}You can undo this.</p>
    </>
  );
}

function History({ history, undoable, busy, onUndo }: { history: HistoryEntry[]; undoable?: HistoryEntry; busy: boolean; onUndo: () => void }) {
  if (!history.length) return <div className="kx-tm-empty">Changes you make here are listed so you can take them back.</div>;
  return (
    <ul className="kx-tm-history">
      {history.map((entry) => (
        <li key={entry.seq} data-undone={entry.undone || undefined}>
          <span>
            {entry.label}
            <small>{entry.undone ? "Undone" : entry.count ? plural(entry.count, "item") : "Tree only"}</small>
          </span>
          {entry === undoable && (
            <button className="kx-tm-button kx-tm-small" disabled={busy} onClick={onUndo} title="Undo (⌘Z)">
              Undo
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function ActionPanel({
  panel,
  invoke,
  workspaceId,
  tree,
  properties,
  busy,
  onCancel,
  onApply,
}: {
  panel: Exclude<Panel, { mode: "suggestions" } | { mode: "history" }>;
  invoke: Invoke;
  workspaceId: string;
  tree: ReturnType<typeof buildTree>;
  properties: PropertyInfo[];
  busy: boolean;
  onCancel: () => void;
  onApply: (plan: ManagerPlan) => void;
}) {
  const tags = panel.tags.filter((t) => tree.nodes.has(key(t))).map((t) => tree.nodes.get(key(t))!.name);
  const countOf = (t: string) => tree.nodes.get(key(t))?.count ?? 0;
  // Merge
  const byUse = [...tags].sort((a, b) => countOf(b) - countOf(a) || a.localeCompare(b));
  const [to, setTo] = useState(panel.mode === "merge" ? (panel.to ?? byUse[0] ?? "") : "");
  const [custom, setCustom] = useState(false);
  // Nest
  const [parent, setParent] = useState(panel.mode === "nest" ? (panel.parent ?? "") : "");
  // Convert
  const common = commonPrefix(tags);
  const [name, setName] = useState(panel.mode === "convert" ? (panel.name ?? (tags.length === 1 ? valueLabel(tags[0]) : common ? valueLabel(common) : "")) : "");
  const [type, setType] = useState<"boolean" | "select">(panel.mode === "convert" ? (panel.type ?? (tags.length === 1 ? "boolean" : "select")) : "select");
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(tags.map((t) => [t, (panel.mode === "convert" && panel.values?.find(([x]) => x === t)?.[1]) || valueLabel(t, common)])),
  );
  const [removeTags, setRemoveTags] = useState(true);

  let plan: ManagerPlan | undefined;
  let problem = "";
  let note: ReactNode = null;
  if (panel.mode === "merge") plan = { type: "merge", from: tags.filter((t) => t !== to.trim()), to: to.trim() };
  if (panel.mode === "nest") plan = { type: "nest", parent: parent.trim(), children: tags };
  if (panel.mode === "delete") plan = { type: "delete", tags };
  if (panel.mode === "convert") {
    const existing = properties.find((p) => fold(p.name) === fold(name.trim()));
    if (existing && existing.type !== type) problem = `“${existing.name}” is already a ${existing.type === "boolean" ? "checkbox" : existing.type} property. Choose another name or type.`;
    else if (existing) note = <>Adds to the existing “{existing.name}” property{existing.type === "select" && existing.options?.length ? ` (${plural(existing.options.length, "value")} already)` : ""}.</>;
    plan = { type: "property", name: existing?.name ?? name.trim(), propertyType: type, values: tags.map((t): [string, string | boolean] => [t, type === "boolean" ? true : values[t]?.trim() || valueLabel(t)]), removeTags };
  }
  // The host plans it (and says why not) as the form changes.
  const [planned, setPlanned] = useState<{ key: string; change?: PlannedChange; problem?: string }>();
  const planKey = plan && !problem ? JSON.stringify(plan) : "";
  useEffect(() => {
    if (!planKey) return;
    let live = true;
    const timer = setTimeout(() => {
      void planChange(invoke, workspaceId, JSON.parse(planKey) as ManagerPlan).then(
        (change) => live && setPlanned({ key: planKey, change }),
        (e) => live && setPlanned({ key: planKey, problem: String(e).replace(/^Error: /, "") }),
      );
    }, 80);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [planKey, invoke, workspaceId]);
  const current = planned?.key === planKey ? planned : undefined;
  const change = planKey ? current?.change : undefined;
  if (!problem && current?.problem) problem = current.problem;
  if (panel.mode === "nest" && !parent.trim()) problem = "";
  // Items holding several of the tags keep all but the first as tags.
  const several = type === "select" && tags.length > 1 ? (change?.multiple ?? 0) : 0;
  if (panel.mode === "convert" && several) note = <>{note} {plural(several, "item")} {several === 1 ? "has" : "have"} more than one of these tags: {several === 1 ? "it takes" : "they take"} the first value and keep the other tags.</>;

  const heading =
    panel.mode === "merge" ? `Merge ${plural(tags.length, "tag")}` : panel.mode === "nest" ? `Nest ${tags.length === 1 ? `“${tags[0]}”` : plural(tags.length, "tag")}` : panel.mode === "delete" ? `Remove ${tags.length === 1 ? `“${tags[0]}”` : plural(tags.length, "tag")}` : "Convert to a property";
  const parents = [...tree.nodes.values()]
    .filter((n) => !tags.some((t) => key(t) === key(n.name) || ancestors(tree, n.name).some((a) => key(a) === key(t))))
    .sort((a, b) => b.total - a.total)
    .slice(0, 400);

  return (
    <form
      className="kx-tm-action"
      onSubmit={(e) => {
        e.preventDefault();
        if (plan && change && !problem) onApply(plan);
      }}
    >
      <header>
        <button type="button" className="kx-tm-icon" aria-label="Back to suggestions" onClick={onCancel}>
          <Icon name="arrowLeft" size={12} />
        </button>
        <h2>{heading}</h2>
      </header>
      <div className="kx-tm-side-scroll">
        {panel.mode === "merge" && (
          <fieldset className="kx-tm-fieldset">
            <legend>Keep the name</legend>
            <div className="kx-tm-choices" role="radiogroup">
              {byUse.map((t) => (
                <label key={t} className="kx-tm-choice">
                  <input type="radio" name="survivor" checked={!custom && to === t} onChange={() => (setCustom(false), setTo(t))} />
                  <span>{t}</span>
                  <small>{countOf(t).toLocaleString()}</small>
                </label>
              ))}
              <label className="kx-tm-choice">
                <input type="radio" name="survivor" checked={custom} onChange={() => (setCustom(true), setTo(""))} />
                <input className="kx-tm-input" placeholder="Another name" value={custom ? to : ""} onFocus={() => setCustom(true)} onChange={(e) => (setCustom(true), setTo(e.target.value))} />
              </label>
            </div>
          </fieldset>
        )}
        {panel.mode === "nest" && (
          <fieldset className="kx-tm-fieldset">
            <legend>Under</legend>
            <input className="kx-tm-input" autoFocus list="kx-tm-parents" placeholder="A tag, or a new heading" value={parent} onChange={(e) => setParent(e.target.value)} />
            <datalist id="kx-tm-parents">
              {parents.map((n) => (
                <option key={n.name} value={n.name} />
              ))}
            </datalist>
            <small className="kx-tm-help">
              {parent.trim() && !tree.nodes.has(key(parent))
                ? `“${parent.trim()}” is new: it becomes a heading in the tree, on no item itself.`
                : "Nesting changes only the tree; items keep their tags."}
            </small>
          </fieldset>
        )}
        {panel.mode === "convert" && (
          <>
            <fieldset className="kx-tm-fieldset">
              <legend>Property</legend>
              <input className="kx-tm-input" autoFocus aria-label="Property name" placeholder="Property name" value={name} onChange={(e) => setName(e.target.value)} />
              <div className="kx-tm-types" role="radiogroup" aria-label="Property type">
                <label className="kx-tm-type" data-checked={type === "boolean" || undefined}>
                  <input type="radio" name="type" checked={type === "boolean"} onChange={() => setType("boolean")} />
                  <Icon name="check" size={13} />
                  <span>
                    Checkbox
                    <small>Checked on items with {tags.length === 1 ? "the tag" : "any of the tags"}</small>
                  </span>
                </label>
                <label className="kx-tm-type" data-checked={type === "select" || undefined}>
                  <input type="radio" name="type" checked={type === "select"} onChange={() => setType("select")} />
                  <Icon name="list" size={13} />
                  <span>
                    Select
                    <small>One value per item, from {tags.length === 1 ? "the tag" : "the tags"}</small>
                  </span>
                </label>
              </div>
            </fieldset>
            {type === "select" && (
              <fieldset className="kx-tm-fieldset">
                <legend>Values</legend>
                <ul className="kx-tm-values">
                  {tags.map((t) => (
                    <li key={t}>
                      <span className="kx-tm-chip">{t}</span>
                      <Icon name="arrowRight" size={10} />
                      <input className="kx-tm-input" aria-label={`Value for ${t}`} value={values[t] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [t]: e.target.value }))} />
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}
            <label className="kx-tm-switch">
              <input type="checkbox" className="kx-switch" checked={removeTags} onChange={(e) => setRemoveTags(e.target.checked)} />
              <span>
                Remove the tags afterwards
                <small>Items that already have a value keep it, and keep their tag.</small>
              </span>
            </label>
          </>
        )}
        {problem && <p className="kx-tm-problem">{problem}</p>}
        {note && <p className="kx-tm-help">{note}</p>}
        {change && (
          <div className="kx-tm-preview">
            <h3>Preview</h3>
            <PreviewLines change={change} limit={12} />
          </div>
        )}
      </div>
      <footer>
        <span className="kx-spacer" />
        <button type="button" className="kx-tm-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="kx-tm-button kx-tm-primary" data-danger={panel.mode === "delete" || undefined} disabled={busy || !change || !!problem}>
          {panel.mode === "merge" ? "Merge" : panel.mode === "nest" ? "Nest" : panel.mode === "delete" ? "Remove" : "Convert"}
        </button>
      </footer>
    </form>
  );
}

/** "status" for "status: read" and "status: to read". */
function commonPrefix(tags: string[]) {
  const roots = tags.map((t) => splitPath(t)?.[0]);
  return roots.length > 1 && roots.every((r) => r && fold(r) === fold(roots[0]!)) ? roots[0] : undefined;
}
