// The tag manager: a window-sized sheet with the library's tags as a tree on the left
// (search, sort, multi-select, drag to nest or out to the top level, inline rename, colours)
// and on the right the suggestions the host's analysis finds (`store_tag_suggestions`), or
// the form for what the selection or a suggestion should become. Every change is planned by
// the host (`store_tag_plan`), applied as one store transaction (`store_tag_apply_many`)
// and can be undone. The tree moves at once (the host's answer replaces the guess) and the
// suggestions are read again in the background.
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { entityFilter } from "./entity-ui";
import { showInLibrary } from "./filter-links";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon } from "./icons";
import type { Invoke } from "./library-api";
import { fold, plural, type PropertyInfo, type Suggestion, type SuggestionKind, type TagIndex } from "./tag-analysis";
import { ancestors, applyLocally, buildTree, planChange, sortTree, visibleRows, type ApplyResult, type ManagerPlan, type PlannedChange, type TagNode, type TagSort, type TagTree } from "./tag-plan";
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
type Split = { tag: string; path: string[] };
type Panel =
  | { mode: "suggestions" }
  | { mode: "merge"; tags: string[]; to?: string }
  | { mode: "nest"; tags: string[]; parent?: string }
  | { mode: "hierarchy"; tags: string[]; splits: Split[] }
  | { mode: "convert"; tags: string[]; name?: string; type?: "boolean" | "select"; values?: [string, string][] }
  | { mode: "delete"; tags: string[] }
  | { mode: "history" };
type FormPanel = Exclude<Panel, { mode: "suggestions" } | { mode: "history" }>;

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
/** How long the tree animates after a change (rows move, counts tick). */
const SETTLE_MS = 650;
/** An applied card shows its check this long before it folds away. */
const CHECK_MS = 140;
const EASE = [0.2, 0.8, 0.2, 1] as const;
const SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.7 } as const;
const key = (name: string) => fold(name.trim());
const confidenceLabel = (c: number) => (c >= 0.8 ? "Very likely" : c >= 0.6 ? "Likely" : "Worth a look");
const message = (e: unknown) => String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, "");

/** Apply timings, newest last (read by the tag manager smoke and perf script). */
const timings: { label: string; hostMs: number; totalMs: number }[] = [];
(window as unknown as { keyTagTimings?: typeof timings }).keyTagTimings = timings;

export default function TagManager({ invoke, workspaceId, onClose, focus }: { invoke: Invoke; workspaceId: string; onClose: () => void; focus?: string }) {
  const reduce = useReducedMotion() ?? false;
  const [index, setIndex] = useState<TagIndex>();
  /** Bumped when the index comes from the host (not a local guess): the analysis follows it. */
  const [revision, setRevision] = useState(0);
  const [properties, setProperties] = useState<PropertyInfo[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>();
  const [analysing, setAnalysing] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<TagSort>("name");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set(focus ? [key(focus)] : []));
  const anchor = useRef<string | undefined>(undefined);
  const [renaming, setRenaming] = useState<string>();
  const [panel, setPanel] = useState<Panel>({ mode: "suggestions" });
  const [formTags, setFormTags] = useState<string[]>([]);
  const [journal, setJournal] = useState<JournalState>({ entries: [] });
  const history = journal.entries.filter((entry) => entry.kind === "tags");
  /** The newest tag entry, when it is also the library's next undo. */
  const undoable = history.find((entry) => entry.seq === journal.undo?.seq);
  const [busy, setBusy] = useState(false);
  const applying = useRef(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; tags: string[] }>();
  const [dropTarget, setDropTarget] = useState<string>();
  const [dragging, setDragging] = useState(false);
  // Motion: cards being applied (button shows progress, then a check), cards folding away
  // (in order, for a light stagger), and a short window in which tree rows animate.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Map<string, number>>(new Map());
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const movingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const exitTo = useRef(new Map<string, string>());
  const [done, setDone] = useState<{ label: string; count: number; at: number }>();

  const settle = () => {
    clearTimeout(movingTimer.current);
    setMoving(!reduce);
    movingTimer.current = setTimeout(() => setMoving(false), SETTLE_MS);
  };
  useEffect(() => () => clearTimeout(movingTimer.current), []);

  const loadJournal = useCallback(() => invoke<JournalState>("store_journal", { limit: 100 }, workspaceId).then(setJournal, () => {}), [invoke, workspaceId]);
  const loadProperties = useCallback(() => invoke<PropertyInfo[]>("workspace_attributes", {}, workspaceId).then(setProperties, () => {}), [invoke, workspaceId]);
  const load = useCallback(async () => {
    const next = await invoke<TagIndex>("store_tag_index", {}, workspaceId);
    setIndex(next);
    setRevision((r) => r + 1);
    void loadProperties();
    void loadJournal();
  }, [invoke, workspaceId, loadJournal, loadProperties]);
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
    void invoke<string[] | null>("store_ui_get", { key: DISMISSED_KEY }, workspaceId)
      .then((ids) => setDismissed(new Set(Array.isArray(ids) ? ids : [])))
      .catch(() => setDismissed(new Set()));
  }, [load, invoke, workspaceId]);

  // The host reads the tags again after every change, a moment later and in the background:
  // the cards stay (the ones the change touched dimmed) until the new list arrives.
  const analysis = useRef(0);
  useEffect(() => {
    if (!revision || !dismissed) return;
    const run = ++analysis.current;
    const timer = setTimeout(() => {
      setAnalysing(true);
      void invoke<Suggestion[]>("store_tag_suggestions", { dismissed: [...dismissed] }, workspaceId)
        .then(
          (list) => run === analysis.current && !applying.current && (setSuggestions(list), setLeaving(new Map()), setTouched(new Set())),
          () => run === analysis.current && setSuggestions((old) => old ?? []),
        )
        .finally(() => run === analysis.current && setAnalysing(false));
    }, 120);
    return () => clearTimeout(timer);
  }, [revision, dismissed, invoke, workspaceId]);

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
  /** Applies at once in the tree, then in the store; rolls the tree back if the store says no. */
  const apply = async (changes: PlannedChange[], label?: string): Promise<boolean> => {
    if (!changes.length || applying.current) return false;
    applying.current = true;
    const started = performance.now();
    const before = index;
    const operations = changes.map((c) => c.operation);
    const text = label ?? changes[0].label;
    setBusy(true);
    setError("");
    exitTo.current = new Map(operations.flatMap((op) => op.replace.filter((r) => r.to.length).map((r) => [key(r.from), key(r.to[0])] as [string, string])));
    setTouched(new Set(changes.flatMap((c) => c.lines.flatMap((l) => [key(l.before), ...(l.after ? [key(l.after.split(" › ").pop() ?? l.after)] : [])]))));
    settle();
    if (before) setIndex(applyLocally(before, operations));
    // Nested tags show under their parent.
    const parents = operations.flatMap((op) => Object.values(op.tree).flatMap((meta) => (meta?.parent ? [key(meta.parent)] : [])));
    if (parents.length) setExpanded((old) => new Set([...old, ...parents]));
    try {
      const sent = performance.now();
      const result = await invoke<ApplyResult>("store_tag_apply_many", { operations, label: text, withIndex: true }, workspaceId);
      const hostMs = performance.now() - sent;
      if (result.index) setIndex(result.index);
      else if (result.tree) setIndex((current) => current && { ...current, tree: result.tree! });
      setRevision((r) => r + 1);
      setSelected(new Set());
      setDone({ label: text, count: result.affected ?? 0, at: Date.now() });
      void loadJournal();
      if (operations.some((op) => op.property)) void loadProperties();
      timings.push({ label: text, hostMs: Math.round(hostMs), totalMs: Math.round(performance.now() - started) });
      return true;
    } catch (e) {
      if (before) setIndex(before);
      setTouched(new Set());
      setError(message(e));
      return false;
    } finally {
      applying.current = false;
      setBusy(false);
    }
  };
  const run = (plan: ManagerPlan, label?: string) => {
    if (!index || applying.current) return;
    void planChange(invoke, workspaceId, plan).then(
      (change) => apply([change], label),
      (e) => setError(message(e)),
    );
  };
  const undo = async () => {
    if (applying.current) return;
    applying.current = true;
    setBusy(true);
    setError("");
    exitTo.current = new Map();
    settle();
    try {
      await invoke("store_undo", {}, workspaceId);
      setDone(undefined);
    } catch (e) {
      setError(message(e));
    } finally {
      applying.current = false;
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
  const applySuggestions = async (list: Suggestion[]) => {
    if (!index || applying.current) return;
    // Each one comes planned against the tags as they are now (stale ones have no change);
    // ones a previous one already covered are skipped. All of it is one transaction.
    const chosen: Suggestion[] = [];
    const touchedTags = new Set<string>();
    for (const s of list) {
      if (!s.change || s.tags.some((t) => touchedTags.has(key(t)))) continue;
      chosen.push(s);
      s.tags.forEach((t) => touchedTags.add(key(t)));
    }
    if (!chosen.length) return;
    const ids = chosen.map((s) => s.id);
    setPending((old) => new Set([...old, ...ids]));
    setCardErrors((old) => Object.fromEntries(Object.entries(old).filter(([id]) => !ids.includes(id))));
    const shown = new Promise((r) => setTimeout(r, reduce ? 0 : CHECK_MS));
    // Let the button's check paint before the tree rebuilds.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    const ok = await apply(
      chosen.map((s) => s.change!),
      chosen.length === 1 ? chosen[0].change!.label : `Applied ${plural(chosen.length, "suggestion")}`,
    );
    await shown;
    setPending((old) => new Set([...old].filter((id) => !ids.includes(id))));
    if (ok) setLeaving((old) => new Map([...old, ...ids.map((id, i) => [id, i] as [string, number])]));
    else if (ids.length === 1) setCardErrors((old) => ({ ...old, [ids[0]]: "Could not apply this. The tags may have changed." }));
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
  const endDrag = () => {
    dragged.current = [];
    setDragging(false);
    setDropTarget(undefined);
  };
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
  const visible = (suggestions ?? []).filter((s) => !leaving.has(s.id));
  const groups = GROUPS.map(([kind, title, detail]) => ({ kind, title, detail, list: visible.filter((s) => s.kind === kind) })).filter((g) => g.list.length);
  const highlighted = useMemo(() => new Set(panel.mode !== "suggestions" && panel.mode !== "history" ? formTags.map(key) : []), [panel.mode, formTags]);
  const tops = new Map(virtual.getVirtualItems().map((v) => [key(rows[v.index].name), v.start]));
  const draggedNested = dragging && dragged.current.some((t) => tree?.nodes.get(key(t))?.parent);
  const openForm = (next: FormPanel) => {
    setFormTags("tags" in next ? next.tags : []);
    setPanel(next);
  };

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
                  {selection.length > 1 && <ToolButton icon="group" label="Merge…" onClick={() => openForm({ mode: "merge", tags: selection })} />}
                  <ToolButton icon="layers" label="Nest…" onClick={() => openForm({ mode: "nest", tags: selection })} />
                  {selection.some((t) => tree?.nodes.get(key(t))?.parent) && <ToolButton icon="arrowLeft" label="Un-nest" onClick={() => run({ type: "unnest", tags: selection.filter((t) => tree?.nodes.get(key(t))?.parent) })} />}
                  <ToolButton icon="table" label="Convert…" onClick={() => openForm({ mode: "convert", tags: selection })} />
                  <ToolButton icon="trash" label="Remove…" onClick={() => openForm({ mode: "delete", tags: selection })} />
                </>
              ) : (
                <span className="kx-tm-hint">Select tags to merge, nest or convert them. Drag a tag onto another to nest it, or to the top to un-nest it.</span>
              )}
            </div>
            <div
              className="kx-tm-list"
              ref={scroller}
              role="tree"
              aria-multiselectable="true"
              aria-busy={busy || undefined}
              tabIndex={0}
              data-drop={dropTarget === "" || undefined}
              onDragOver={(e) => {
                if (!dragged.current.length) return;
                e.preventDefault();
                if ((e.target as HTMLElement).closest(".kx-tm-row")) return;
                setDropTarget("");
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(undefined);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const tags = dragged.current;
                endDrag();
                if (!(e.target as HTMLElement).closest(".kx-tm-row")) {
                  const nested = tags.filter((t) => tree?.nodes.get(key(t))?.parent);
                  if (nested.length) run({ type: "unnest", tags: nested });
                }
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) setSelected(new Set());
              }}
            >
              <AnimatePresence>
                {draggedNested && (
                  <motion.div
                    className="kx-tm-topzone"
                    data-drop={dropTarget === "" || undefined}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: reduce ? 0 : 0.15, ease: EASE }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDropTarget("");
                    }}
                  >
                    <Icon name="arrowLeft" size={11} /> Drop here to move to the top level
                  </motion.div>
                )}
              </AnimatePresence>
              {!index ? (
                <div className="kx-tm-empty">
                  <span className="kx-tm-spinner" />
                </div>
              ) : !rows.length ? (
                <div className="kx-tm-empty">{query ? "No tags match." : "No tags yet. Tags you add to sources show here."}</div>
              ) : (
                <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
                  <AnimatePresence initial={false} custom={{ moving, tops }}>
                    {virtual.getVirtualItems().map((v) => {
                      const node = rows[v.index];
                      const k = key(node.name);
                      return (
                        <TagRow
                          key={k}
                          node={node}
                          top={v.start}
                          moving={moving}
                          exitTo={exitTo.current.get(k)}
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
                            setDragging(true);
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", tags.join(", "));
                          }}
                          onDragEnd={endDrag}
                          onDragOver={(e) => {
                            if (!dragged.current.length || dragged.current.some((t) => key(t) === k || (tree && ancestors(tree, node.name).some((a) => key(a) === key(t))))) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setDropTarget(k);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const tags = dragged.current;
                            endDrag();
                            if (tags.length && !tags.some((t) => key(t) === k)) {
                              setExpanded((old) => new Set([...old, k]));
                              run({ type: "nest", parent: node.name, children: tags });
                            }
                          }}
                        />
                      );
                    })}
                  </AnimatePresence>
                </div>
              )}
            </div>
          </section>
          <section className="kx-tm-side" aria-label={panel.mode === "suggestions" ? "Suggestions" : "Change tags"} data-analysing={analysing || undefined}>
            {panel.mode === "suggestions" || panel.mode === "history" ? (
              <>
                <div className="kx-tm-tabs" role="tablist">
                  <button role="tab" aria-selected={panel.mode === "suggestions"} onClick={() => setPanel({ mode: "suggestions" })}>
                    Suggestions {suggestions && <span className="kx-tm-badge">{visible.length}</span>}
                    {analysing && suggestions && <span className="kx-tm-spinner kx-tm-spinner-small" aria-label="Checking again" />}
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
                    <motion.div className="kx-tm-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduce ? 0 : 0.2 }}>
                      <Icon name="check" size={16} />
                      <span>{analysing ? "Checking your tags again…" : "Nothing to tidy. Your tags look well organised."}</span>
                    </motion.div>
                  ) : (
                    <AnimatePresence initial={false}>
                      {groups.map((group) => (
                        <motion.div
                          key={group.kind}
                          className="kx-tm-group-wrap"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: reduce ? 0 : 0.2, ease: EASE }}
                        >
                          <SuggestionGroup
                            title={group.title}
                            detail={group.detail}
                            list={group.list}
                            busy={busy}
                            reduce={reduce}
                            pending={pending}
                            leaving={leaving}
                            stale={analysing ? touched : undefined}
                            errors={cardErrors}
                            onSelect={(s) => setSelected(new Set(s.tags.filter((t) => tree?.nodes.has(key(t))).map(key)))}
                            onApply={(list) => void applySuggestions(list)}
                            onDismiss={(list) => dismiss(list.map((s) => s.id))}
                            onEdit={(s) => {
                              const p = s.plan;
                              if (p.type === "property") openForm({ mode: "convert", tags: p.values.map(([t]) => t), name: p.name, type: p.propertyType, values: p.values.map(([t, v]) => [t, String(v)]) });
                              else if (p.type === "merge") openForm({ mode: "merge", tags: [...p.from, p.to], to: p.to });
                              else if (p.type === "nest") openForm({ mode: "nest", tags: p.children, parent: p.parent });
                              else if (p.type === "hierarchy") openForm({ mode: "hierarchy", tags: p.splits.map((x) => x.tag), splits: p.splits });
                              else if (p.type === "delete") openForm({ mode: "delete", tags: p.tags });
                            }}
                          />
                        </motion.div>
                      ))}
                    </AnimatePresence>
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
                onTags={setFormTags}
                onCancel={() => setPanel({ mode: "suggestions" })}
                onApply={(change) =>
                  void apply([change]).then((ok) => {
                    if (ok) setPanel({ mode: "suggestions" });
                  })
                }
              />
            ) : null}
          </section>
        </div>
        <footer className="kx-tm-foot" data-applying={busy || undefined}>
          {error ? (
            <span className="kx-tm-error" role="alert">
              <Icon name="warning" size={12} /> {error}
            </span>
          ) : busy ? (
            <span className="kx-tm-last" role="status">
              <span className="kx-tm-spinner kx-tm-spinner-small" /> Applying…
            </span>
          ) : done ? (
            <motion.span
              key={done.at}
              className="kx-tm-last kx-tm-done"
              role="status"
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: EASE }}
            >
              <motion.span className="kx-tm-done-check" initial={reduce ? false : { scale: 0.4 }} animate={{ scale: 1 }} transition={SPRING}>
                <Icon name="check" size={10} />
              </motion.span>
              Done · {done.label}
              {done.count > 0 && ` · ${plural(done.count, "item")} updated`}
            </motion.span>
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
            onPanel={openForm}
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
  moving: boolean;
  /** A merged-away tag slides into this one as it leaves. */
  exitTo?: string;
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
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { node, moving } = props;
  const [draft, setDraft] = useState(node.name);
  // One answer per rename: Return, then the blur as the field goes, must not rename twice.
  const answered = useRef(false);
  useEffect(() => {
    if (props.renaming) {
      setDraft(node.name);
      answered.current = false;
    }
  }, [props.renaming]);
  const finish = (to: string) => {
    if (answered.current) return;
    answered.current = true;
    props.onRenamed(to);
  };
  const exitTo = props.exitTo;
  // Rows move to their new place while the tree settles after a change, and only then
  // (scrolling and filtering place them at once). Leaving rows fade, sliding into the tag
  // they merged into when that one is in view.
  const variants = {
    exit: (c: { moving: boolean; tops: Map<string, number> }) =>
      c.moving ? { opacity: 0, top: exitTo !== undefined ? c.tops.get(exitTo) : undefined, scale: 0.98, transition: { duration: 0.2, ease: EASE } } : { opacity: 0, transition: { duration: 0 } },
  };
  // The box moves (and fades); the row inside takes the pointer and drag events, which a
  // motion element would read as its own gestures.
  return (
    <motion.div
      className="kx-tm-rowbox"
      variants={variants}
      initial={moving ? { opacity: 0, top: props.top } : false}
      animate={{ opacity: 1, top: props.top }}
      exit="exit"
      transition={moving ? SPRING : { duration: 0 }}
    >
    <div
      className="kx-tm-row"
      role="treeitem"
      aria-selected={props.selected}
      aria-expanded={node.children.length ? props.expanded : undefined}
      aria-level={node.depth + 1}
      data-highlight={props.highlighted || undefined}
      data-drop={props.drop || undefined}
      data-group={node.group || undefined}
      data-moving={moving || undefined}
      data-tag={node.name}
      style={{ paddingLeft: 8 + node.depth * 16 }}
      draggable={!props.renaming}
      onClick={props.onClick}
      onDoubleClick={props.onRename}
      onContextMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
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
          onBlur={() => finish(draft)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") finish(draft);
            if (e.key === "Escape") finish(node.name);
          }}
        />
      ) : (
        <span className="kx-tm-name" title={node.name}>
          {node.name}
        </span>
      )}
      <motion.span
        key={node.total}
        className="kx-tm-num"
        initial={moving ? { opacity: 0, y: -5 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: EASE }}
        title={node.children.length ? `${plural(node.count, "item")} tagged directly, ${node.total.toLocaleString()} with the tags inside` : undefined}
      >
        {node.total.toLocaleString()}
      </motion.span>
    </div>
    </motion.div>
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
  tree: TagTree;
  onClose: () => void;
  onRename: () => void;
  onPanel: (panel: FormPanel) => void;
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
  const nested = menu.tags.filter((t) => tree.nodes.get(key(t))?.parent);
  const parent = one ? tree.nodes.get(key(one))?.parent : undefined;
  const grandparent = parent ? tree.nodes.get(key(parent))?.parent : undefined;
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
  const style = { left: Math.min(left, (frame?.width ?? window.innerWidth) - 230), top: Math.min(top, (frame?.height ?? window.innerHeight) - 360) };
  return (
    <div ref={ref} className="kx-tm-menu" role="menu" style={style}>
      {one && item("Rename", onRename)}
      {menu.tags.length > 1 && item(`Merge ${menu.tags.length} tags…`, () => onPanel({ mode: "merge", tags: menu.tags }))}
      {item("Nest under…", () => onPanel({ mode: "nest", tags: menu.tags }))}
      {item(menu.tags.length > 1 ? "Group under a new tag…" : "Add a broader tag above…", () => onPanel({ mode: "nest", tags: menu.tags, parent: "" }))}
      {parent && grandparent && item(`Move up to “${grandparent}”`, () => onRun({ type: "nest", parent: grandparent, children: [one!] }))}
      {parent && !grandparent && item(`Remove from “${parent}”`, () => onRun({ type: "unnest", tags: [one!] }))}
      {nested.length > 0 && (grandparent || !one) && item(nested.length > 1 ? `Move ${nested.length} to top level` : "Move to top level", () => onRun({ type: "unnest", tags: nested }))}
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
  reduce,
  pending,
  leaving,
  stale,
  errors,
  onSelect,
  onApply,
  onDismiss,
  onEdit,
}: {
  title: string;
  detail: string;
  list: Suggestion[];
  busy: boolean;
  reduce: boolean;
  pending: Set<string>;
  leaving: Map<string, number>;
  stale?: Set<string>;
  errors: Record<string, string>;
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
      <AnimatePresence initial={false} custom={leaving}>
        {shown.map((s) => (
          <SuggestionCard
            key={s.id}
            suggestion={s}
            busy={busy}
            reduce={reduce}
            pending={pending.has(s.id)}
            stale={!!stale && s.tags.some((t) => stale.has(key(t)))}
            error={errors[s.id]}
            onSelect={onSelect}
            onApply={() => onApply([s])}
            onDismiss={() => onDismiss([s])}
            onEdit={() => onEdit(s)}
          />
        ))}
      </AnimatePresence>
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
  reduce,
  pending,
  stale,
  error,
  onSelect,
  onApply,
  onDismiss,
  onEdit,
}: {
  suggestion: Suggestion;
  busy: boolean;
  reduce: boolean;
  pending: boolean;
  stale: boolean;
  error?: string;
  onSelect: (s: Suggestion) => void;
  onApply: () => void;
  onDismiss: () => void;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const change = open ? s.change : undefined;
  // Folds away when applied or dismissed; several applied at once go one after another,
  // quickly. A card that comes in (one further down moving up) unfolds.
  const variants = {
    exit: (order: Map<string, number>) => ({
      opacity: 0,
      height: 0,
      marginTop: 0,
      scale: 0.98,
      transition: { duration: reduce ? 0 : 0.2, ease: EASE, delay: reduce ? 0 : Math.min(order.get(s.id) ?? 0, 6) * 0.035 },
    }),
  };
  return (
    <motion.article
      className="kx-tm-card"
      data-open={open || undefined}
      data-suggestion={s.id}
      data-pending={pending || undefined}
      data-stale={stale || undefined}
      variants={variants}
      initial={reduce ? false : { opacity: 0, height: 0 }}
      animate={{ opacity: stale ? 0.55 : 1, height: "auto" }}
      exit="exit"
      transition={{ duration: reduce ? 0 : 0.2, ease: EASE }}
    >
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
      {error && <p className="kx-tm-problem kx-tm-card-error">{error}</p>}
      <div className="kx-tm-card-actions">
        <button className="kx-tm-button kx-tm-primary kx-tm-small kx-tm-apply" data-pending={pending || undefined} disabled={busy || pending || !s.change} onClick={onApply} aria-label={pending ? "Applying" : "Apply"}>
          {pending ? (
            <motion.span className="kx-tm-apply-check" initial={reduce ? false : { scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={reduce ? { duration: 0 } : SPRING}>
              <Icon name="check" size={11} />
            </motion.span>
          ) : (
            "Apply"
          )}
        </button>
        <button className="kx-tm-button kx-tm-small" disabled={busy || pending} onClick={onEdit}>
          Edit…
        </button>
        <span className="kx-spacer" />
        <button className="kx-tm-icon" disabled={busy || pending} onClick={onDismiss} title="Dismiss" aria-label={`Dismiss: ${s.title}`}>
          <Icon name="close" size={10} />
        </button>
      </div>
    </motion.article>
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
        <button type="button" className="kx-tm-more" onClick={() => setAll(true)}>
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

/** A field to add one more tag to a form's set (type, or pick from the list). */
function TagAdder({ tree, exclude, onAdd, label = "Add a tag" }: { tree: TagTree; exclude: Set<string>; onAdd: (name: string) => void; label?: string }) {
  const [text, setText] = useState("");
  const id = useId();
  const options = useMemo(
    () =>
      [...tree.nodes.values()]
        .filter((n) => !exclude.has(key(n.name)))
        .sort((a, b) => b.total - a.total)
        .slice(0, 300),
    [tree, exclude],
  );
  const commit = (value: string) => {
    const node = tree.nodes.get(key(value));
    if (!node || exclude.has(key(node.name))) return false;
    onAdd(node.name);
    setText("");
    return true;
  };
  return (
    <label className="kx-tm-adder">
      <Icon name="plus" size={11} />
      <input
        list={id}
        className="kx-tm-input"
        placeholder={label}
        aria-label={label}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // A pick from the list arrives whole, not typed.
          if ((e.nativeEvent as InputEvent).inputType !== "insertText") commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(text);
          }
        }}
      />
      <datalist id={id}>
        {options.map((n) => (
          <option key={n.name} value={n.name} />
        ))}
      </datalist>
    </label>
  );
}

/** The set of tags a form works on: chips to take one out, a field to add one. */
function Members({ tree, tags, onRemove, onAdd, reduce, addLabel }: { tree: TagTree; tags: string[]; onRemove: (t: string) => void; onAdd: (t: string) => void; reduce: boolean; addLabel?: string }) {
  const exclude = useMemo(() => new Set(tags.map(key)), [tags]);
  return (
    <>
      <ul className="kx-tm-members" aria-label="Tags">
        <AnimatePresence initial={false}>
          {tags.map((t) => (
            <motion.li
              key={key(t)}
              layout={!reduce}
              className="kx-tm-member"
              initial={reduce ? false : { opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85, transition: { duration: reduce ? 0 : 0.12 } }}
              transition={reduce ? { duration: 0 } : SPRING}
            >
              <span title={t}>{t}</span>
              <small>{(tree.nodes.get(key(t))?.count ?? 0).toLocaleString()}</small>
              <button type="button" aria-label={`Take out ${t}`} title="Take out" onClick={() => onRemove(t)}>
                <Icon name="close" size={8} />
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <TagAdder tree={tree} exclude={exclude} onAdd={onAdd} label={addLabel} />
    </>
  );
}

const splitPath = (text: string) =>
  text
    .split(/\s*[›>]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

function ActionPanel({
  panel,
  invoke,
  workspaceId,
  tree,
  properties,
  busy,
  onTags,
  onCancel,
  onApply,
}: {
  panel: FormPanel;
  invoke: Invoke;
  workspaceId: string;
  tree: TagTree;
  properties: PropertyInfo[];
  busy: boolean;
  onTags: (tags: string[]) => void;
  onCancel: () => void;
  onApply: (change: PlannedChange) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const nameOf = (t: string) => tree.nodes.get(key(t))?.name ?? t;
  // The tags the form works on: the suggestion's or the selection's, editable.
  const [members, setMembers] = useState<string[]>(() => {
    const seen = new Set<string>();
    return panel.tags.filter((t) => tree.nodes.has(key(t)) && !seen.has(key(t)) && seen.add(key(t))).map(nameOf);
  });
  const add = (t: string) => setMembers((m) => (m.some((x) => key(x) === key(t)) ? m : [...m, nameOf(t)]));
  const remove = (t: string) => setMembers((m) => m.filter((x) => key(x) !== key(t)));
  // Delete and hierarchy keep every tag listed, with a tick to leave one out.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const tick = (t: string, on: boolean) =>
    setExcluded((old) => {
      const next = new Set(old);
      if (on) next.delete(key(t));
      else next.add(key(t));
      return next;
    });
  const included = members.filter((t) => !excluded.has(key(t)));
  const membersKey = members.join("\u0000");
  useEffect(() => onTags(included), [membersKey, excluded]); // eslint-disable-line react-hooks/exhaustive-deps

  const countOf = (t: string) => tree.nodes.get(key(t))?.count ?? 0;
  // Merge
  const byUse = [...members].sort((a, b) => countOf(b) - countOf(a) || a.localeCompare(b));
  const [to, setTo] = useState(panel.mode === "merge" ? (panel.to ?? byUse[0] ?? "") : "");
  const [custom, setCustom] = useState(false);
  const survivor = custom ? to : members.some((m) => key(m) === key(to)) ? nameOf(to) : (byUse[0] ?? "");
  // Nest
  const [parent, setParent] = useState(panel.mode === "nest" ? (panel.parent ?? "") : "");
  const [renameParent, setRenameParent] = useState("");
  const parentNode = parent.trim() ? tree.nodes.get(key(parent)) : undefined;
  const parentInput = useRef<HTMLInputElement>(null);
  // Hierarchy
  const [paths, setPaths] = useState<Record<string, string>>(() => (panel.mode === "hierarchy" ? Object.fromEntries(panel.splits.map((s) => [key(s.tag), s.path.join(" › ")])) : {}));
  // Convert: the form's starting name and values come from the host (key-store tag_analysis.rs).
  const [name, setName] = useState(panel.mode === "convert" ? (panel.name ?? "") : "");
  const [type, setType] = useState<"boolean" | "select">(panel.mode === "convert" ? (panel.type ?? (members.length === 1 ? "boolean" : "select")) : "select");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(members.map((t) => [key(t), (panel.mode === "convert" && panel.values?.find(([x]) => key(x) === key(t))?.[1]) || t])));
  useEffect(() => {
    if (panel.mode !== "convert" || !members.length) return;
    let live = true;
    void invoke<{ name: string; values: Record<string, string> }>("store_tag_convert_defaults", { tags: members }, workspaceId)
      .then((d) => {
        if (!live) return;
        setName((current) => current || d.name);
        // Only tags without a value yet (just added, or never named) take the host's.
        setValues((current) => Object.fromEntries(members.map((t) => [key(t), current[key(t)] && current[key(t)] !== t ? current[key(t)] : (d.values[t] ?? current[key(t)] ?? t)])));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membersKey, panel.mode]);
  const move = (t: string, by: number) =>
    setMembers((m) => {
      const at = m.indexOf(t),
        next = [...m];
      const to = Math.max(0, Math.min(m.length - 1, at + by));
      next.splice(at, 1);
      next.splice(to, 0, t);
      return next;
    });
  const [removeTags, setRemoveTags] = useState(true);

  let plan: ManagerPlan | undefined;
  let problem = "";
  let note: ReactNode = null;
  if (panel.mode === "merge") {
    if (members.length + (custom && to.trim() && !members.some((m) => key(m) === key(to)) ? 1 : 0) < 2) problem = "Keep at least two tags to merge, or type another name to rename into.";
    else plan = { type: "merge", from: members.filter((t) => key(t) !== key(survivor)), to: survivor.trim() };
  }
  if (panel.mode === "nest") plan = { type: "nest", parent: parent.trim(), children: members, ...(parentNode && renameParent.trim() ? { renameParent: renameParent.trim() } : {}) };
  if (panel.mode === "hierarchy") plan = { type: "hierarchy", splits: included.map((t) => ({ tag: t, path: splitPath(paths[key(t)] ?? t) })) };
  if (panel.mode === "delete") plan = { type: "delete", tags: included };
  if (panel.mode === "convert") {
    const existing = properties.find((p) => fold(p.name) === fold(name.trim()));
    if (existing && existing.type !== type) problem = `“${existing.name}” is already a ${existing.type === "boolean" ? "checkbox" : existing.type} property. Choose another name or type.`;
    else if (existing) note = <>Adds to the existing “{existing.name}” property{existing.type === "select" && existing.options?.length ? ` (${plural(existing.options.length, "value")} already)` : ""}.</>;
    plan = { type: "property", name: existing?.name ?? name.trim(), propertyType: type, values: members.map((t): [string, string | boolean] => [t, type === "boolean" ? true : values[key(t)]?.trim() || t]), removeTags };
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
        (e) => live && setPlanned({ key: planKey, problem: message(e) }),
      );
    }, 80);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [planKey, invoke, workspaceId]);
  const current = planned?.key === planKey ? planned : undefined;
  // The last preview stays while the next one is planned, so the form does not flicker.
  const [shown, setShown] = useState<PlannedChange>();
  useEffect(() => {
    if (current?.change) setShown(current.change);
    else if (current?.problem || !planKey) setShown(undefined);
  }, [current, planKey]);
  const change = planKey ? current?.change : undefined;
  if (!problem && current?.problem) problem = current.problem;
  if (panel.mode === "nest" && !parent.trim()) problem = "";
  // Items holding several of the tags keep all but the first as tags.
  const several = type === "select" && members.length > 1 ? (change?.multiple ?? 0) : 0;
  if (panel.mode === "convert" && several) note = <>{note} {plural(several, "item")} {several === 1 ? "has" : "have"} more than one of these tags: {several === 1 ? "it takes" : "they take"} the first value and keep the other tags.</>;

  const count = panel.mode === "delete" || panel.mode === "hierarchy" ? included.length : members.length;
  const heading =
    panel.mode === "merge"
      ? `Merge ${plural(count, "tag")}`
      : panel.mode === "nest"
        ? `Nest ${count === 1 ? `“${members[0]}”` : plural(count, "tag")}`
        : panel.mode === "delete"
          ? `Remove ${count === 1 ? `“${included[0]}”` : plural(count, "tag")}`
          : panel.mode === "hierarchy"
            ? `Nest ${plural(count, "tag")} by their names`
            : "Convert to a property";
  const parents = useMemo(
    () =>
      [...tree.nodes.values()]
        .filter((n) => !members.some((t) => key(t) === key(n.name) || ancestors(tree, n.name).some((a) => key(a) === key(t))))
        .sort((a, b) => b.total - a.total)
        .slice(0, 400),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, membersKey],
  );
  const ready = !!change && !problem && !busy;

  return (
    <form
      className="kx-tm-action"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onApply(change!);
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
          <>
            <fieldset className="kx-tm-fieldset">
              <legend>Tags to merge</legend>
              <Members tree={tree} tags={members} onRemove={remove} onAdd={add} reduce={reduce} addLabel="Add a tag to merge" />
            </fieldset>
            <fieldset className="kx-tm-fieldset">
              <legend>Keep the name</legend>
              <div className="kx-tm-choices" role="radiogroup" aria-label="Keep the name">
                {byUse.map((t) => (
                  <label key={t} className="kx-tm-choice">
                    <input type="radio" name="survivor" checked={!custom && key(survivor) === key(t)} onChange={() => (setCustom(false), setTo(t))} />
                    <span>{t}</span>
                    <small>{countOf(t).toLocaleString()}</small>
                  </label>
                ))}
                <label className="kx-tm-choice">
                  <input type="radio" name="survivor" checked={custom} onChange={() => (setCustom(true), setTo(survivor))} />
                  <input className="kx-tm-input" aria-label="Another name" placeholder="Another name" value={custom ? to : ""} onFocus={() => (setCustom(true), !custom && setTo(survivor))} onChange={(e) => (setCustom(true), setTo(e.target.value))} />
                </label>
              </div>
            </fieldset>
          </>
        )}
        {panel.mode === "nest" && (
          <>
            <fieldset className="kx-tm-fieldset">
              <legend>Tags to nest</legend>
              <Members tree={tree} tags={members} onRemove={remove} onAdd={add} reduce={reduce} addLabel="Add a tag to nest" />
            </fieldset>
            <fieldset className="kx-tm-fieldset">
              <legend>Under</legend>
              <div className="kx-tm-parent">
                <input ref={parentInput} className="kx-tm-input" autoFocus={!parent} aria-label="Parent tag" list="kx-tm-parents" placeholder="A tag, or a new heading" value={parent} onChange={(e) => (setParent(e.target.value), setRenameParent(""))} />
                <button
                  type="button"
                  className="kx-tm-button kx-tm-small"
                  onClick={() => {
                    setParent("");
                    setRenameParent("");
                    parentInput.current?.focus();
                  }}
                >
                  New heading…
                </button>
              </div>
              <datalist id="kx-tm-parents">
                {parents.map((n) => (
                  <option key={n.name} value={n.name} />
                ))}
              </datalist>
              {parentNode && (
                <label className="kx-tm-inline">
                  <span>Rename “{parentNode.name}” to</span>
                  <input className="kx-tm-input" aria-label="Rename the parent" placeholder="Keep its name" value={renameParent} onChange={(e) => setRenameParent(e.target.value)} />
                </label>
              )}
              <small className="kx-tm-help">
                {!parent.trim()
                  ? "Type a tag to nest under, or the name of a new heading."
                  : !parentNode
                    ? `“${parent.trim()}” is new: it becomes a heading in the tree, on no item itself.`
                    : renameParent.trim()
                      ? `“${parentNode.name}” becomes “${renameParent.trim()}” everywhere, with the tags under it.`
                      : "Nesting changes only the tree; items keep their tags."}
              </small>
            </fieldset>
          </>
        )}
        {panel.mode === "hierarchy" && (
          <fieldset className="kx-tm-fieldset">
            <legend>Paths</legend>
            <ul className="kx-tm-paths">
              {members.map((t) => {
                const on = !excluded.has(key(t));
                return (
                  <li key={key(t)} data-off={!on || undefined}>
                    <input type="checkbox" aria-label={`Include ${t}`} checked={on} onChange={(e) => tick(t, e.target.checked)} />
                    <span className="kx-tm-chip" title={t}>
                      {t}
                    </span>
                    <Icon name="arrowRight" size={10} />
                    <input className="kx-tm-input" aria-label={`Path for ${t}`} disabled={!on} value={paths[key(t)] ?? t} onChange={(e) => setPaths((p) => ({ ...p, [key(t)]: e.target.value }))} />
                  </li>
                );
              })}
            </ul>
            <small className="kx-tm-help">Separate the levels with ›, as in “Status › Read”. The last part becomes the tag’s name.</small>
          </fieldset>
        )}
        {panel.mode === "delete" && (
          <fieldset className="kx-tm-fieldset">
            <legend>Tags to remove</legend>
            <div className="kx-tm-choices">
              {members.map((t) => (
                <label key={key(t)} className="kx-tm-choice">
                  <input type="checkbox" aria-label={`Remove ${t}`} checked={!excluded.has(key(t))} onChange={(e) => tick(t, e.target.checked)} />
                  <span>{t}</span>
                  <small>{countOf(t).toLocaleString()}</small>
                </label>
              ))}
            </div>
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
                    <small>Checked on items with {members.length === 1 ? "the tag" : "any of the tags"}</small>
                  </span>
                </label>
                <label className="kx-tm-type" data-checked={type === "select" || undefined}>
                  <input type="radio" name="type" checked={type === "select"} onChange={() => setType("select")} />
                  <Icon name="list" size={13} />
                  <span>
                    Select
                    <small>One value per item, from {members.length === 1 ? "the tag" : "the tags"}</small>
                  </span>
                </label>
              </div>
            </fieldset>
            <fieldset className="kx-tm-fieldset">
              <legend>{type === "select" ? "Values, in order" : "Tags"}</legend>
              <ul className="kx-tm-values">
                <AnimatePresence initial={false}>
                  {members.map((t, i) => (
                    <motion.li key={key(t)} layout={!reduce} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.12 } }} transition={reduce ? { duration: 0 } : SPRING}>
                      <span className="kx-tm-chip" title={t}>
                        {t}
                      </span>
                      {type === "select" && (
                        <>
                          <Icon name="arrowRight" size={10} />
                          <input className="kx-tm-input" aria-label={`Value for ${t}`} value={values[key(t)] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [key(t)]: e.target.value }))} />
                          <span className="kx-tm-order">
                            <button type="button" className="kx-tm-icon" aria-label={`Move ${t} up`} disabled={i === 0} onClick={() => move(t, -1)}>
                              <Icon name="chevronUp" size={10} />
                            </button>
                            <button type="button" className="kx-tm-icon" aria-label={`Move ${t} down`} disabled={i === members.length - 1} onClick={() => move(t, 1)}>
                              <Icon name="chevronDown" size={10} />
                            </button>
                          </span>
                        </>
                      )}
                      <button type="button" className="kx-tm-icon" aria-label={`Take out ${t}`} title="Take out" onClick={() => remove(t)}>
                        <Icon name="close" size={9} />
                      </button>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
              <TagAdder tree={tree} exclude={new Set(members.map(key))} onAdd={add} label="Add a tag" />
              {type === "select" && <small className="kx-tm-help">Tags with the same value become one option.</small>}
            </fieldset>
            <label className="kx-tm-switch">
              <input type="checkbox" className="kx-switch" checked={removeTags} onChange={(e) => setRemoveTags(e.target.checked)} />
              <span>
                Remove the tags afterwards
                <small>Items that already have a value keep it, and keep their tag.</small>
              </span>
            </label>
          </>
        )}
        {problem && (
          <p className="kx-tm-problem" role="alert">
            {problem}
          </p>
        )}
        {note && <p className="kx-tm-help">{note}</p>}
        {shown && !problem && (
          <div className="kx-tm-preview" data-updating={(planKey && !current) || undefined}>
            <h3>Preview</h3>
            <PreviewLines change={shown} limit={12} />
          </div>
        )}
      </div>
      <footer>
        <span className="kx-spacer" />
        <button type="button" className="kx-tm-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="kx-tm-button kx-tm-primary" data-danger={panel.mode === "delete" || undefined} disabled={!ready}>
          {busy ? <span className="kx-tm-spinner kx-tm-spinner-small kx-tm-spinner-ink" /> : null}
          {panel.mode === "merge" ? "Merge" : panel.mode === "nest" || panel.mode === "hierarchy" ? "Nest" : panel.mode === "delete" ? "Remove" : "Convert"}
        </button>
      </footer>
    </form>
  );
}
