// Filled cells in the library: an AI answer the user edited carries a quiet "edited" mark, and
// one whose material (or recipe) changed since is marked out of date. The mark opens a
// popover with "Your value" and "AI answer" side by side, the passages the answer came from,
// earlier answers, and "Use AI answer again", "Keep mine" and "Fill again" (with the cost
// first). All of it is worked out in the host (key-store's fill_cells.rs); this only shows it.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "@key-reader/ui/dismiss";
import { Icon } from "./icons";
import { bridge, relativeDate, type Invoke } from "./library-api";
import { Explain } from "./explain";
import { FormulaValue } from "./formula-display";
import type { Recipe } from "./FillSheet";
import "./fill-cells.css";

export interface CellMark {
  stale: boolean;
  edited: boolean;
  recipe: string;
}
export interface StaleRecipe {
  id: string;
  name: string;
  property: string;
  onChange: string;
  stale: number;
  ids: string[];
}
interface Marks {
  cells: Record<string, Record<string, CellMark>>;
  recipes: StaleRecipe[];
}
interface Passage {
  id: string;
  label: string;
  text: string;
}
interface Evidence {
  passage: string;
  quote: string;
  verified: boolean;
}
interface Cell {
  sourceId: string;
  property: string;
  recipe: { id: string; name: string; onChange: string; method: string } | null;
  recipeId: string;
  method: string;
  provider?: string | null;
  model?: string | null;
  value: unknown;
  confidence?: number | null;
  evidence: Evidence[] | null;
  passages: Passage[] | null;
  filledAt: number;
  userValue: unknown;
  editedAt?: number | null;
  edited: boolean;
  stale?: "inputs" | "recipe" | null;
  current: unknown;
  history: { value: unknown; model?: string | null; filledAt: number; evidence?: Evidence[] | null }[];
}

interface FillCells {
  invoke: Invoke;
  workspaceId: string;
  marks: Marks;
  refresh: () => void;
}
const Context = createContext<FillCells | undefined>(undefined);

/** Reads the marks for the library; `version` changes when the rows were read again. */
export function FillCellsProvider({ invoke, workspaceId, version, children }: { invoke: Invoke; workspaceId: string; version?: unknown; children: ReactNode }) {
  const parent = useContext(Context);
  const [marks, setMarks] = useState<Marks>({ cells: {}, recipes: [] });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void invoke<Marks>("store_fill_marks", {}, workspaceId)
        .then((m) => setMarks(m ?? { cells: {}, recipes: [] }))
        .catch(() => {});
    }, 250);
  }, [invoke, workspaceId]);
  useEffect(() => {
    if (parent) return;
    refresh();
  }, [refresh, version, parent]);
  useEffect(() => {
    if (parent) return;
    const offs = [bridge()?.on?.("library-changed", refresh), bridge()?.on?.("fill-progress", (v) => (v as { run?: { status?: string } })?.run?.status === "done" && refresh())];
    return () => offs.forEach((off) => off?.());
  }, [refresh, parent]);
  const value = useMemo(() => parent ?? { invoke, workspaceId, marks, refresh }, [parent, invoke, workspaceId, marks, refresh]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useFillCells = () => useContext(Context);

/** A cell's mark in the table (nothing when the cell has no fill state). */
export function FillCellMark({ sourceId, property, mark: given }: { sourceId: string; property: string; mark?: CellMark }) {
  const context = useContext(Context);
  const mark = given ?? context?.marks.cells[sourceId]?.[property];
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!context || !mark) return null;
  const kind = mark.stale && !mark.edited ? "stale" : mark.edited ? "edited" : "filled";
  const label = kind === "stale" ? "Out of date" : kind === "edited" ? "Edited" : "Filled by AI";
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="kx-fill-mark"
        data-mark={kind}
        aria-label={`${label}: ${property}`}
        title={kind === "stale" ? "The material this answer came from changed. Click to see both and fill again." : kind === "edited" ? "You changed the AI's answer. Click to compare." : "Filled by AI. Click to see where it came from."}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {kind === "stale" ? <Icon name="clock" size={9} /> : kind === "edited" ? <Icon name="pen" size={9} /> : <Icon name="sparkle" size={9} />}
      </button>
      {open && <FillCellPopover anchor={anchor} sourceId={sourceId} property={property} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The marks of one source's cells, for its details panel. */
export function useSourceFillCells(sourceId?: string) {
  const context = useContext(Context);
  const [cells, setCells] = useState<Record<string, CellMark>>({});
  const version = context?.marks;
  useEffect(() => {
    if (!context || !sourceId) return setCells({});
    let live = true;
    void context
      .invoke<Record<string, CellMark>>("store_fill_source_cells", { id: sourceId }, context.workspaceId)
      .then((c) => live && setCells(c ?? {}))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sourceId, version, context?.workspaceId]);
  return cells;
}

const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^Error: /, "");
const when = (ms?: number | null) => (ms ? relativeDate(ms) : "");

function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return <span className="kx-fill-cell-empty">Empty</span>;
  return <FormulaValue value={value} resultType={Array.isArray(value) ? "list" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : undefined} />;
}

function usePlace(anchor: RefObject<HTMLElement | null>, ref: RefObject<HTMLElement | null>, deps: unknown[]) {
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number }>();
  useLayoutEffect(() => {
    const position = () => {
      const box = anchor.current?.getBoundingClientRect();
      const el = ref.current;
      if (!box || !el) return;
      const margin = 8;
      const width = el.offsetWidth;
      const height = el.scrollHeight;
      const below = window.innerHeight - box.bottom - margin - 6;
      const above = box.top - margin - 6;
      const down = height <= below || below >= above;
      const maxHeight = Math.max(160, down ? below : above);
      const top = down ? box.bottom + 6 : Math.max(margin, box.top - 6 - Math.min(height, maxHeight));
      setPlace({ left: Math.max(margin, Math.min(box.left - 16, window.innerWidth - width - margin)), top, maxHeight });
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return place;
}

/** Your value and the AI's answer, with where the answer came from and what to do. */
export function FillCellPopover({ anchor, sourceId, property, onClose }: { anchor: RefObject<HTMLElement | null>; sourceId: string; property: string; onClose: () => void }) {
  const context = useContext(Context)!;
  const { invoke, workspaceId } = context;
  const ref = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState<Cell | null>();
  const [message, setMessage] = useState("");
  const [again, setAgain] = useState<{ ids: string[]; recipe: Recipe; tokens: number; cost?: number; scope: "one" | "all" }>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void invoke<Cell | null>("store_fill_cell", { id: sourceId, property }, workspaceId)
      .then(setCell)
      .catch((e) => setMessage(errorText(e)));
  }, [invoke, workspaceId, sourceId, property]);
  useEffect(load, [load]);
  const place = usePlace(anchor, ref, [cell, again, message]);
  const placed = !!place;
  useEffect(() => {
    if (placed) ref.current?.focus({ preventScroll: true });
  }, [placed]);
  useDismiss(placed, { refs: [ref, anchor], anchor, onDismiss: onClose });

  const act = async (command: string, done: string) => {
    setBusy(true);
    try {
      await invoke(command, { id: sourceId, property }, workspaceId);
      context.refresh();
      setMessage(done);
      load();
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const staleOfRecipe = context.marks.recipes.find((r) => r.id === cell?.recipeId);
  // "Fill again": the cost first, as for any run.
  const prepare = async (scope: "one" | "all") => {
    if (!cell) return;
    setBusy(true);
    setMessage("");
    try {
      const recipes = await invoke<Recipe[]>("store_fill_recipes", {}, workspaceId);
      const recipe = recipes.find((r) => r.id === cell.recipeId);
      if (!recipe) throw Error("The recipe that filled this value was deleted");
      const ids = scope === "one" ? [sourceId] : await invoke<string[]>("store_fill_again_ids", { recipeId: recipe.id }, workspaceId);
      const estimate = await invoke<{ eligible: number; inputTokens: number; outputTokens: number }>("store_fill_estimate", { recipe, ids, again: true }, workspaceId);
      const tokens = estimate.inputTokens + estimate.outputTokens;
      const cost = recipe.method === "ai" ? await invoke<{ cost?: number }>("ai_estimate_cost", { inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens }, workspaceId).then((c) => c.cost).catch(() => undefined) : 0;
      setAgain({ ids, recipe, tokens, cost, scope });
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const fillAgain = async () => {
    if (!again) return;
    setBusy(true);
    try {
      const run = await invoke<{ id: string }>("fill_start", { recipe: again.recipe, ids: again.ids, again: true }, workspaceId);
      setAgain(undefined);
      setMessage(again.recipe.auto ? "Filling again…" : "Filling again. The new answer waits for your review.");
      window.dispatchEvent(new CustomEvent("key:fill-run-started", { detail: { runId: run.id, workspaceId } }));
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const evidence = cell?.evidence ?? [];
  const passages = cell?.passages ?? [];
  const differs = !!cell?.edited;
  return createPortal(
    <div
      ref={ref}
      className="kx-fill-cell-popover"
      role="dialog"
      aria-label={`${property}: your value and the AI answer`}
      tabIndex={-1}
      data-source={sourceId}
      data-property={property}
      style={place ? { left: place.left, top: place.top, maxHeight: place.maxHeight } : { visibility: "hidden" }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <header>
        <div>
          <h4>{property}</h4>
          {cell?.recipe && (
            <small>
              {cell.recipe.name}
              {cell.model ? ` · ${cell.model}` : cell.method === "rule" ? " · rule" : ""} · {when(cell.filledAt)}
            </small>
          )}
        </div>
        <Explain help="fill.cell" />
        <button type="button" className="kx-explain-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={9} />
        </button>
      </header>
      {cell === undefined ? (
        <p className="kx-fill-cell-muted">Loading…</p>
      ) : cell === null ? (
        <p className="kx-fill-cell-muted">This value was not filled by a recipe.</p>
      ) : (
        <>
          {cell.stale && (
            <p className="kx-fill-cell-stale" role="note">
              <Icon name="clock" size={11} />
              {cell.stale === "recipe" ? "The recipe changed since this answer." : "What this answer came from has changed since."}
            </p>
          )}
          <div className="kx-fill-cell-compare" data-edited={differs || undefined}>
            {differs && (
              <section data-side="yours" aria-label="Your value">
                <h5>
                  <Icon name="pen" size={10} /> Your value
                </h5>
                <div className="kx-fill-cell-value">
                  <Value value={cell.current} />
                </div>
                <small>{cell.editedAt ? `Edited ${when(cell.editedAt)}` : "Edited"}</small>
              </section>
            )}
            <section data-side="ai" aria-label="AI answer">
              <h5>
                <Icon name={cell.method === "rule" ? "function" : "sparkle"} size={10} /> {cell.method === "rule" ? "Rule's answer" : "AI answer"}
              </h5>
              <div className="kx-fill-cell-value">
                <Value value={cell.value} />
              </div>
              <small>{cell.confidence != null ? `${Math.round(cell.confidence * 100)}% sure · ` : ""}{when(cell.filledAt)}</small>
            </section>
          </div>
          {(evidence.length > 0 || passages.length > 0) && (
            <div className="kx-fill-cell-evidence">
              {evidence.map((e, i) => (
                <p key={i} className="kx-fill-quote" data-verified={e.verified || undefined}>
                  <Icon name={e.verified ? "check" : "warning"} size={10} />“{e.quote}”<small>{e.verified ? `in ${passages.find((p) => p.id === e.passage)?.label ?? e.passage}` : "not found in the text sent"}</small>
                </p>
              ))}
              {passages.length > 0 && (
                <details>
                  <summary>Passages it read ({passages.map((p) => p.label).join(", ")})</summary>
                  {passages.map((p) => (
                    <div key={p.id} className="kx-fill-passage">
                      <small>
                        [{p.id}] {p.label}
                      </small>
                      <p>{p.text.length > 1200 ? `${p.text.slice(0, 1200)}…` : p.text}</p>
                    </div>
                  ))}
                </details>
              )}
            </div>
          )}
          {cell.history.length > 0 && (
            <details className="kx-fill-cell-history">
              <summary>Earlier answers ({cell.history.length})</summary>
              <ol>
                {cell.history.map((h, i) => (
                  <li key={i}>
                    <Value value={h.value} />
                    <small>
                      {h.model ? `${h.model} · ` : ""}
                      {when(h.filledAt)}
                    </small>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {again ? (
            <div className="kx-fill-cell-again" aria-label="Fill again">
              <p>
                Fill {again.ids.length === 1 ? "this value" : `${again.ids.length.toLocaleString()} values`} again with “{again.recipe.name}”
                {again.recipe.method === "ai" ? (
                  <>
                    {" "}
                    · ≈ {again.tokens.toLocaleString()} tokens · {again.cost === undefined ? "cost unknown" : again.cost === 0 ? "free" : `≈ $${again.cost < 0.01 ? "0.01" : again.cost.toFixed(2)}`}
                  </>
                ) : (
                  " · nothing is sent"
                )}
              </p>
              <small>{differs ? "Your value stays; only the AI answer is renewed." : again.recipe.auto ? "Saved straight away, undoable." : "New answers wait for your review."}</small>
              <div className="kx-fill-cell-actions">
                <button type="button" className="kx-settings-button" onClick={() => setAgain(undefined)}>
                  Cancel
                </button>
                <button type="button" className="kx-settings-button kx-service-primary" disabled={busy || !again.ids.length} onClick={() => void fillAgain()}>
                  Fill again
                </button>
              </div>
            </div>
          ) : (
            <div className="kx-fill-cell-actions">
              {cell.stale && (
                <button type="button" className="kx-settings-button" disabled={busy} onClick={() => void prepare("one")}>
                  <Icon name="retry" size={11} /> Fill again
                </button>
              )}
              {cell.stale && (staleOfRecipe?.stale ?? 0) > 1 && (
                <button type="button" className="kx-fill-link" disabled={busy} onClick={() => void prepare("all")}>
                  All {staleOfRecipe!.stale.toLocaleString()} out of date…
                </button>
              )}
              <span className="kx-spacer" />
              {differs && (
                <>
                  <button type="button" className="kx-settings-button" disabled={busy} onClick={() => void act("store_fill_cell_keep", "Kept your value")}>
                    Keep mine
                  </button>
                  <button type="button" className="kx-settings-button kx-service-primary" disabled={busy} onClick={() => void act("store_fill_cell_use_answer", "Using the AI answer again. Undo with ⌘Z.")}>
                    Use AI answer again
                  </button>
                </>
              )}
            </div>
          )}
          {message && (
            <p className="kx-fill-cell-message" role="status">
              {message}
            </p>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
