// Fill with AI (or a rule): a guided sheet. 1 What to fill (a starter recipe, a saved one or
// your own words, into an existing or new property), 2 where the answer comes from, 3 its
// shape, 4 a test on three sources with the passages each answer came from, 5 the run over
// the selection, a collection or the library (with the cost up front), then review: accept,
// edit or reject each proposal, or undo the whole run. The host builds every request and
// checks every answer (key-store's fill.rs); main sends them (main/ai/service.ts).
import { useCallback, useEffect, useMemo, useState } from "react";
import { GlobalDrawer } from "./GlobalDrawer";
import { Icon } from "./icons";
import { bridge, type Collection, type Invoke } from "./library-api";
import { Explain, Hint } from "./explain";
import { FormulaValue } from "./formula-display";
import type { PropertyDefinition } from "./PropertySheets";
import "./formula-builder.css";
import "./fill.css";

export interface Recipe {
  id: string;
  name: string;
  description: string;
  property: string;
  shape: string;
  options: string[];
  method: "ai" | "rule";
  task: string;
  instruction: string;
  inputs: string[];
  sections: string[];
  rule: { kind: string; formula: string; pattern: string; input: string };
  auto: boolean;
  refill: boolean;
  budget?: number;
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
interface Item {
  sourceId: string;
  status: string;
  value: unknown;
  confidence?: number | null;
  evidence: Evidence[] | null;
  passages: Passage[] | null;
  note?: string | null;
  error?: string | null;
  title: string;
  current: unknown;
}
export interface RunSummary {
  id: string;
  recipe: Recipe;
  status: string;
  sample: boolean;
  provider?: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  counts: Record<string, number>;
  total: number;
  done: number;
  undoable: boolean;
  cost?: number;
}
interface Estimate {
  sources: number;
  eligible: number;
  skipped: number;
  perSourceTokens: number;
  inputTokens: number;
  outputTokens: number;
  sentCharacters: Record<string, number>;
}

const SHAPES: [string, string, string][] = [
  ["text", "Text", "Aa"],
  ["number", "Number", "#"],
  ["select", "One of these", "1"],
  ["multiselect", "Several of these", "+"],
  ["boolean", "Yes or no", "✓"],
  ["date", "Date", "D"],
];
const INPUTS: [string, string, string][] = [
  ["metadata", "Metadata", "Title, authors, year, journal, type, DOI and tags"],
  ["abstract", "Abstract", "The abstract, when the source has one"],
  ["sections", "Sections of the PDF", "Named sections such as Methods, found when the PDF was indexed"],
  ["fulltext", "Full text", "The beginning of the PDF's text, up to the length below"],
  ["notes", "Your notes", "Notes attached to the source"],
  ["highlights", "Your highlights", "Highlighted passages and their comments"],
];
const SHAPE_OF_TYPE: Record<string, string> = { text: "text", number: "number", select: "select", multiselect: "multiselect", boolean: "boolean", date: "date" };
const STEPS = ["What to fill", "Where from", "Answer", "Test", "Run"] as const;

const blank = (property = ""): Recipe => ({
  id: "",
  name: "",
  description: "",
  property,
  shape: "text",
  options: [],
  method: "ai",
  task: "custom",
  instruction: "",
  inputs: ["metadata", "abstract"],
  sections: [],
  rule: { kind: "formula", formula: "", pattern: "", input: "abstract" },
  auto: false,
  refill: false,
});
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^Error: /, "");
const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;

/** Follows a run: the main process pushes progress; the items are read when it moves. */
function useRun(invoke: Invoke, workspaceId: string, runId?: string, passages = false) {
  const [detail, setDetail] = useState<{ run: RunSummary; items: Item[] }>();
  const load = useCallback(() => {
    if (!runId) return setDetail(undefined);
    void invoke<{ run: RunSummary; items: Item[] }>("store_fill_run", { runId, limit: 500, passages }, workspaceId)
      .then(setDetail)
      .catch(() => {});
  }, [invoke, workspaceId, runId, passages]);
  useEffect(() => {
    load();
    if (!runId) return;
    const off = bridge()?.on?.("fill-progress", (value) => {
      const v = value as { workspaceId?: string; run?: { id?: string } };
      if (v?.run?.id === runId) load();
    });
    const timer = setInterval(load, 1500);
    return () => {
      off?.();
      clearInterval(timer);
    };
  }, [load, runId]);
  return { detail, reload: load };
}

function Quote({ text, quote }: { text: string; quote?: string }) {
  if (!quote) return <>{text}</>;
  const squash = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  const plain = text.replace(/\s+/g, " ");
  const at = squash(plain).indexOf(squash(quote).replace(/…$/, ""));
  if (at < 0) return <>{plain}</>;
  const end = at + quote.replace(/…$/, "").replace(/\s+/g, " ").length;
  return (
    <>
      {plain.slice(Math.max(0, at - 400), at)}
      <mark>{plain.slice(at, end)}</mark>
      {plain.slice(end, end + 400)}
    </>
  );
}

/** One proposal with its evidence; in review it can be accepted, edited or rejected. */
function ProposalRow({
  item,
  recipe,
  review,
  onAccept,
  onReject,
  loadPassages,
}: {
  item: Item;
  recipe: Recipe;
  review?: boolean;
  onAccept?: (edited?: unknown) => void;
  onReject?: () => void;
  /** The review reads the passages only when the evidence is opened. */
  loadPassages?: () => Promise<Passage[]>;
}) {
  const [open, setOpen] = useState(!review);
  const [loaded, setLoaded] = useState<Passage[]>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(Array.isArray(item.value) ? item.value.join(", ") : String(item.value ?? ""));
  const evidence = item.evidence ?? [];
  const passages = item.passages ?? loaded ?? [];
  const status = item.status;
  return (
    <article className="kx-fill-item" data-status={status} data-source={item.sourceId}>
      <header>
        <strong title={item.title}>{item.title || "Untitled"}</strong>
        <span className="kx-fill-item-status" data-status={status}>
          {status === "proposed" ? (item.confidence != null ? `${Math.round(item.confidence * 100)}% sure` : "Proposed") : STATUS_LABEL[status] ?? status}
        </span>
      </header>
      <div className="kx-fill-item-value">
        {editing ? (
          <input
            autoFocus
            className="kx-settings-select"
            aria-label={`Edit the value for ${item.title}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onAccept?.(recipe.shape === "multiselect" ? draft.split(",").map((s) => s.trim()).filter(Boolean) : recipe.shape === "number" ? Number(draft) : recipe.shape === "boolean" ? /^(y|yes|true)$/i.test(draft) : draft);
                setEditing(false);
              }
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : status === "failed" ? (
          <span className="kx-fill-error">{item.error}</span>
        ) : status === "empty" ? (
          <span className="kx-fill-muted">{item.note || "The material does not say"}</span>
        ) : status === "skipped" ? (
          <span className="kx-fill-muted">
            Kept your value: <FormulaValue value={item.current} />
          </span>
        ) : (
          <FormulaValue value={item.value} resultType={recipe.shape === "multiselect" ? "list" : recipe.shape} display={recipe.shape === "select" ? "badge" : recipe.shape === "boolean" ? "plain" : undefined} />
        )}
        {item.note && status === "proposed" && <small className="kx-fill-muted">{item.note}</small>}
      </div>
      {review && status === "proposed" && (
        <div className="kx-fill-item-actions">
          <button type="button" className="kx-settings-button" onClick={() => onAccept?.()}>
            <Icon name="check" size={11} /> Accept
          </button>
          <button type="button" className="kx-settings-button" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="kx-settings-button" onClick={onReject}>
            Reject
          </button>
          {(evidence.length > 0 || loadPassages) && (
            <button
              type="button"
              className="kx-fill-link"
              aria-expanded={open}
              onClick={() => {
                if (!open && !item.passages && !loaded) void loadPassages?.().then(setLoaded);
                setOpen((o) => !o);
              }}
            >
              {open ? "Hide evidence" : "Evidence"}
            </button>
          )}
        </div>
      )}
      {open && (evidence.length > 0 || passages.length > 0) && (
        <div className="kx-fill-evidence">
          {evidence.map((e, i) => (
            <p key={i} className="kx-fill-quote" data-verified={e.verified || undefined}>
              <Icon name={e.verified ? "check" : "warning"} size={10} />“{e.quote}”<small>{e.verified ? `found in ${passages.find((p) => p.id === e.passage)?.label ?? e.passage}` : "not found in the text sent"}</small>
            </p>
          ))}
          {passages.length > 0 && (
            <details>
              <summary>Passages sent ({passages.map((p) => p.label).join(", ")})</summary>
              {passages.map((p) => (
                <div key={p.id} className="kx-fill-passage">
                  <small>
                    [{p.id}] {p.label}
                  </small>
                  <p>
                    <Quote text={p.text} quote={evidence.find((e) => e.passage === p.id)?.quote} />
                  </p>
                </div>
              ))}
            </details>
          )}
        </div>
      )}
    </article>
  );
}
const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting",
  asked: "Asking…",
  empty: "Not found",
  failed: "Failed",
  skipped: "Has your value",
  accepted: "Saved",
  rejected: "Rejected",
  stale: "Changed since",
  cancelled: "Cancelled",
};

/** The review of a run: progress, pause and cancel, accept all, per-row decisions, undo. */
export function FillReview({ invoke, workspaceId, runId, onSaved }: { invoke: Invoke; workspaceId: string; runId: string; onSaved: () => void }) {
  const { detail, reload } = useRun(invoke, workspaceId, runId);
  const [filter, setFilter] = useState<"proposed" | "all">("proposed");
  const [message, setMessage] = useState("");
  if (!detail) return <p className="kx-fb-loading">Loading…</p>;
  const { run, items } = detail;
  const act = async (command: string, args: Record<string, unknown>, done?: (r: any) => string) => {
    try {
      const r = await invoke<any>(command, { runId, ...args }, workspaceId);
      setMessage(done?.(r) ?? "");
      onSaved();
      reload();
    } catch (e) {
      setMessage(errorText(e));
    }
  };
  const proposed = run.counts.proposed ?? 0;
  const shown = filter === "proposed" ? items.filter((i) => i.status === "proposed") : items;
  const running = run.status === "running";
  return (
    <div className="kx-fill-review" data-run={run.id} data-status={run.status}>
      <div className="kx-fill-progress">
        <div>
          <strong>
            {running ? `Filling “${run.recipe.property}”…` : run.status === "paused" ? "Paused" : run.status === "cancelled" ? "Cancelled" : `“${run.recipe.property}” filled`}
          </strong>
          <small>
            {run.done.toLocaleString()} of {plural(run.total, "source")} · {proposed} to review · {run.counts.accepted ?? 0} saved
            {run.counts.failed ? ` · ${run.counts.failed} failed` : ""}
            {run.counts.skipped ? ` · ${run.counts.skipped} kept your value` : ""}
            {run.tokensIn ? ` · ${(run.tokensIn + run.tokensOut).toLocaleString()} tokens` : ""}
          </small>
        </div>
        <span className="kx-fill-bar" aria-label="Progress">
          <span style={{ width: `${run.total ? (run.done / run.total) * 100 : 0}%` }} />
        </span>
        {running && (
          <button type="button" className="kx-settings-button" onClick={() => void act("fill_pause", {})}>
            <Icon name="pause" size={11} /> Pause
          </button>
        )}
        {run.status === "paused" && (
          <button type="button" className="kx-settings-button" onClick={() => void act("fill_resume", {})}>
            <Icon name="play" size={11} /> Resume
          </button>
        )}
        {(running || run.status === "paused") && (
          <button type="button" className="kx-settings-button" onClick={() => void act("fill_cancel", {})}>
            Cancel
          </button>
        )}
      </div>
      <div className="kx-fill-review-tools">
        <div className="kx-segmented" role="group" aria-label="Show">
          <button type="button" aria-pressed={filter === "proposed"} onClick={() => setFilter("proposed")}>
            To review ({proposed})
          </button>
          <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All ({items.length})
          </button>
        </div>
        <Explain help="fill.review" />
        <span className="kx-spacer" />
        {run.undoable && (
          <button type="button" className="kx-settings-button" onClick={() => void act("store_fill_run_undo", {}, (r) => `Undid the run: ${plural(r.reopened, "value")} back to review`)}>
            <Icon name="undo" size={11} /> Undo run
          </button>
        )}
        <button type="button" className="kx-settings-button kx-service-primary" disabled={!proposed} onClick={() => void act("store_fill_review", { all: true }, (r) => `Saved ${plural(r.accepted, "value")}${r.changedSince ? `; ${r.changedSince} changed since and were left alone` : ""}`)}>
          Accept all {proposed ? `(${proposed})` : ""}
        </button>
      </div>
      {message && (
        <p className="kx-fill-message" role="status">
          {message}
        </p>
      )}
      <div className="kx-fill-items">
        {shown.length ? (
          shown.map((item) => (
            <ProposalRow
              key={item.sourceId}
              item={item}
              recipe={run.recipe}
              review
              onAccept={(edited) =>
                void act("store_fill_review", edited === undefined ? { accept: [item.sourceId] } : { edits: { [item.sourceId]: edited } }, (r) =>
                  r.changedSince ? `“${item.title}” changed since the proposal and was left alone` : `Saved ${plural(r.accepted, "value")}`,
                )
              }
              onReject={() => void act("store_fill_review", { reject: [item.sourceId] }, () => `Rejected the value for “${item.title}”`)}
              loadPassages={() => invoke<Passage[]>("store_fill_run_passages", { runId, sourceId: item.sourceId }, workspaceId)}
            />
          ))
        ) : (
          <p className="kx-fill-muted kx-fill-empty">{running ? "Proposals appear here as answers come in." : "Nothing left to review."}</p>
        )}
      </div>
    </div>
  );
}

export default function FillSheet({
  invoke,
  workspaceId,
  targets,
  propertyName,
  runId: openRun,
  onClose,
  onSaved,
}: {
  invoke: Invoke;
  workspaceId: string;
  /** The selected sources (ids or content hashes). */
  targets: string[];
  propertyName?: string;
  /** Open straight into the review of this run. */
  runId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState(0);
  const [recipe, setRecipe] = useState<Recipe>(() => blank(propertyName));
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([]);
  const [starters, setStarters] = useState<Recipe[]>([]);
  const [saved, setSaved] = useState<Recipe[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [ai, setAi] = useState<{ configured: boolean; providerName?: string; model?: string; local?: boolean; reason?: string }>();
  const [testRun, setTestRun] = useState<string>();
  const [fullRun, setFullRun] = useState<string | undefined>(openRun);
  const [scope, setScope] = useState<string>(targets.length ? "selection" : "library");
  const [estimate, setEstimate] = useState<Estimate & { cost?: number }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveRecipe, setSaveRecipe] = useState(true);
  const [importing, setImporting] = useState<string>();
  const { detail: test } = useRun(invoke, workspaceId, testRun, true);

  const loadRecipes = useCallback(() => void invoke<Recipe[]>("store_fill_recipes", {}, workspaceId).then(setSaved).catch(() => {}), [invoke, workspaceId]);
  useEffect(() => {
    void invoke<PropertyDefinition[]>("workspace_attributes", {}, workspaceId).then(setDefinitions).catch(() => {});
    void invoke<Recipe[]>("store_fill_starters", {}, workspaceId).then(setStarters).catch(() => {});
    void invoke<Collection[]>("store_collections", {}, workspaceId).then(setCollections).catch(() => {});
    void invoke<typeof ai>("ai_status", {}, workspaceId).then(setAi).catch(() => setAi({ configured: false }));
    loadRecipes();
  }, [invoke, workspaceId, loadRecipes]);

  const definition = definitions.find((d) => d.name === recipe.property.trim());
  // An existing property decides the answer's shape.
  const lockedShape = definition && definition.type !== "formula" ? SHAPE_OF_TYPE[definition.type] : undefined;
  useEffect(() => {
    if (lockedShape && (recipe.shape !== lockedShape || (definition?.options?.length && recipe.options.join() !== definition.options.join())))
      setRecipe((r) => ({ ...r, shape: lockedShape, options: definition?.options?.length ? definition.options : r.options }));
  }, [lockedShape, definition?.options?.join()]);
  const set = (patch: Partial<Recipe>) => setRecipe((r) => ({ ...r, ...patch }));
  const pick = (r: Recipe) => {
    const property = propertyName || r.property;
    setRecipe({ ...blank(), ...r, id: saved.some((s) => s.id === r.id) ? r.id : "", property });
    setTestRun(undefined);
  };
  const scopeArgs = useMemo(() => (scope === "selection" ? { ids: targets } : scope === "library" ? { all: true } : { collectionId: scope.slice(11) }), [scope, targets.join()]);

  useEffect(() => {
    if (step !== 4) return;
    let live = true;
    setEstimate(undefined);
    void invoke<Estimate>("store_fill_estimate", { recipe, ...scopeArgs }, workspaceId)
      .then(async (e) => {
        const cost = recipe.method === "ai" ? await invoke<{ cost?: number }>("ai_estimate_cost", { inputTokens: e.inputTokens, outputTokens: e.outputTokens }, workspaceId).catch(() => ({ cost: undefined })) : { cost: 0 };
        if (live) setEstimate({ ...e, cost: cost.cost });
      })
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [step, scopeArgs, JSON.stringify(recipe)]);

  const run = async (sample: boolean) => {
    setBusy(true);
    setError("");
    try {
      const args = sample ? { ids: targets.length >= 3 ? targets : [], all: targets.length < 3 } : scopeArgs;
      let final = recipe;
      if (!sample && saveRecipe) {
        final = await invoke<Recipe>("store_fill_recipe_save", { recipe }, workspaceId);
        setRecipe(final);
        loadRecipes();
      }
      const summary = await invoke<RunSummary>("fill_start", { recipe: final, sample, ...args }, workspaceId);
      if (sample) setTestRun(summary.id);
      else setFullRun(summary.id);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = [
    !!recipe.property.trim() && (recipe.method === "rule" || !!recipe.instruction.trim()),
    recipe.method === "rule" ? (recipe.rule.kind === "formula" ? !!recipe.rule.formula.trim() : !!recipe.rule.pattern.trim()) : recipe.inputs.length > 0,
    !["select", "multiselect"].includes(recipe.shape) || recipe.options.length > 0,
    true,
    true,
  ];
  const canNext = ready.slice(0, step + 1).every(Boolean);
  const providerLine = recipe.method === "rule" ? "Worked out on this Mac by the rule; nothing is sent." : ai?.configured ? `${ai.providerName} · ${ai.model}${ai.local ? " (on this Mac)" : ""}` : ai?.reason || "Set up the AI assistant in Key Settings";

  return (
    <GlobalDrawer presentation="window" label="Fill a property" onClose={onClose} busy={busy}>
      <div className="kx-fill" data-modal-view={fullRun ? "fill-review" : `fill-${step}`}>
        <header className="kx-fb-head">
          <div>
            <h2>
              {fullRun ? "Review the fill" : recipe.property ? `Fill “${recipe.property}”` : "Fill a property"} <Explain help="fill.what" />
            </h2>
            {fullRun ? <small>Nothing is saved until you accept it.</small> : <Hint help="fill.intro" />}
          </div>
          {!fullRun && (
            <ol className="kx-fill-steps" aria-label="Steps">
              {STEPS.map((label, i) => (
                <li key={label}>
                  <button type="button" aria-current={i === step ? "step" : undefined} disabled={!ready.slice(0, i).every(Boolean)} onClick={() => setStep(i)}>
                    <span>{i + 1}</span>
                    {label}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <button type="button" className="kx-sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={10} />
          </button>
        </header>
        <div className="kx-fill-body">
          {fullRun ? (
            <FillReview invoke={invoke} workspaceId={workspaceId} runId={fullRun} onSaved={onSaved} />
          ) : step === 0 ? (
            <div className="kx-fill-step">
              <section>
                <h3>Start from a recipe</h3>
                <div className="kx-fill-gallery">
                  {[...saved, ...starters.filter((s) => !saved.some((r) => r.name === s.name))].map((r) => (
                    <button key={r.id || r.name} type="button" className="kx-fill-card" data-recipe={r.name} aria-pressed={recipe.name === r.name} onClick={() => pick(r)}>
                      <span className="kx-fill-card-icon" data-method={r.method}>
                        <Icon name={r.method === "rule" ? "function" : "sparkle"} size={13} />
                      </span>
                      <span>
                        <strong>
                          {r.name}
                          {saved.some((s) => s.id === r.id) && <em className="kx-service-badge">Saved</em>}
                          {r.auto && <em className="kx-service-badge">Automatic</em>}
                        </strong>
                        <small>{r.description || r.instruction}</small>
                      </span>
                    </button>
                  ))}
                  <button type="button" className="kx-fill-card" data-recipe="custom" aria-pressed={!recipe.name && recipe.method === "ai"} onClick={() => setRecipe({ ...blank(propertyName || recipe.property) })}>
                    <span className="kx-fill-card-icon">
                      <Icon name="pen" size={13} />
                    </span>
                    <span>
                      <strong>Your own</strong>
                      <small>Say in a sentence what to fill in</small>
                    </span>
                  </button>
                </div>
              </section>
              <section className="kx-form-group kx-fill-form">
                <label className="kx-form-row">
                  <span>Fill this property</span>
                  <input className="kx-settings-select" list="kx-fill-properties" aria-label="Property to fill" value={recipe.property} placeholder="Study design" onChange={(e) => set({ property: e.target.value })} />
                  <datalist id="kx-fill-properties">
                    {definitions.filter((d) => d.type !== "formula").map((d) => (
                      <option key={d.name} value={d.name} />
                    ))}
                  </datalist>
                </label>
                <small className="kx-form-note">{recipe.property.trim() ? (definition ? `An existing ${definition.type} property.` : "A new property, created when the recipe first runs.") : "Pick one of your properties or type a new name."}</small>
                <div className="kx-form-row">
                  <span>Filled by</span>
                  <div className="kx-segmented" role="group" aria-label="Filled by">
                    <button type="button" aria-pressed={recipe.method === "ai"} onClick={() => set({ method: "ai" })}>
                      AI model
                    </button>
                    <button type="button" aria-pressed={recipe.method === "rule"} onClick={() => set({ method: "rule" })}>
                      A rule
                    </button>
                  </div>
                </div>
                {recipe.method === "ai" && (
                  <label className="kx-form-row kx-fill-instruction">
                    <span>What to fill in</span>
                    <textarea aria-label="Instruction" rows={3} value={recipe.instruction} placeholder="Classify the study design" onChange={(e) => set({ instruction: e.target.value })} />
                  </label>
                )}
              </section>
              <div className="kx-fill-share">
                <Explain help="fill.recipes" label="Share a recipe" />
                <button type="button" className="kx-fill-link" disabled={!recipe.property.trim()} onClick={() => void invoke<{ text: string }>("store_fill_recipe_export", { recipe }, workspaceId).then((r) => navigator.clipboard?.writeText(r.text)).then(() => setError("Recipe copied as text")).catch((e) => setError(errorText(e)))}>
                  Copy recipe
                </button>
                <button type="button" className="kx-fill-link" onClick={() => setImporting("")}>
                  Paste a recipe…
                </button>
                {importing !== undefined && (
                  <span className="kx-fill-import">
                    <textarea aria-label="Recipe to import" rows={2} placeholder='{"format": "key-fill-recipe", …}' value={importing} onChange={(e) => setImporting(e.target.value)} />
                    <button
                      type="button"
                      className="kx-settings-button"
                      disabled={!importing.trim()}
                      onClick={() =>
                        void invoke<Recipe>("store_fill_recipe_import", { text: importing }, workspaceId)
                          .then((r) => {
                            pick(r);
                            setImporting(undefined);
                            setError(`Imported “${r.name}”`);
                          })
                          .catch((e) => setError(errorText(e)))
                      }
                    >
                      Import
                    </button>
                  </span>
                )}
              </div>
            </div>
          ) : step === 1 ? (
            <div className="kx-fill-step">
              {recipe.method === "ai" ? (
                <>
                  <h3>
                    Where the answer comes from <Explain help="fill.source" />
                  </h3>
                  <div className="kx-fill-inputs">
                    {INPUTS.map(([id, label, detail]) => (
                      <label key={id} className="kx-fill-input" data-input={id}>
                        <input type="checkbox" checked={recipe.inputs.includes(id)} onChange={(e) => set({ inputs: e.target.checked ? [...recipe.inputs, id] : recipe.inputs.filter((i) => i !== id) })} />
                        <span>
                          <strong>{label}</strong>
                          <small>{detail}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  {recipe.inputs.includes("sections") && (
                    <label className="kx-form-row">
                      <span>Sections</span>
                      <input className="kx-settings-select" aria-label="Sections" value={recipe.sections.join(", ")} placeholder="methods, results" onChange={(e) => set({ sections: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                    </label>
                  )}
                  {recipe.inputs.includes("fulltext") && (
                    <label className="kx-form-row">
                      <span>Most text per source</span>
                      <select className="kx-settings-select" aria-label="Most text per source" value={recipe.budget ?? 16000} onChange={(e) => set({ budget: Number(e.target.value) })}>
                        <option value={6000}>About 2 pages</option>
                        <option value={16000}>About 5 pages</option>
                        <option value={40000}>About 12 pages</option>
                      </select>
                    </label>
                  )}
                  <div className="kx-fill-privacy" data-local={ai?.local || undefined}>
                    <Icon name={ai?.local ? "lock" : "info"} size={13} />
                    <p>
                      For each source, Key sends{" "}
                      <strong>
                        {recipe.inputs.length ? recipe.inputs.map((i) => INPUTS.find(([id]) => id === i)?.[1].toLowerCase()).join(", ") : "nothing yet"}
                      </strong>{" "}
                      and your instruction to <strong>{ai?.configured ? ai.providerName : "the AI provider"}</strong>. {ai?.local ? "It runs on this Mac, so nothing leaves it." : "Nothing else leaves this Mac."}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <h3>The rule</h3>
                  <div className="kx-form-row">
                    <span>Work it out with</span>
                    <div className="kx-segmented" role="group" aria-label="Rule kind">
                      <button type="button" aria-pressed={recipe.rule.kind === "formula"} onClick={() => set({ rule: { ...recipe.rule, kind: "formula" } })}>
                        A formula
                      </button>
                      <button type="button" aria-pressed={recipe.rule.kind === "pattern"} onClick={() => set({ rule: { ...recipe.rule, kind: "pattern" } })}>
                        A pattern
                      </button>
                    </div>
                  </div>
                  {recipe.rule.kind === "formula" ? (
                    <label className="kx-form-row">
                      <span>Formula</span>
                      <input className="kx-settings-select kx-fill-code" aria-label="Rule formula" value={recipe.rule.formula} placeholder='extract({DOI}, "^(10\.\d+)")' onChange={(e) => set({ rule: { ...recipe.rule, formula: e.target.value } })} />
                    </label>
                  ) : (
                    <>
                      <label className="kx-form-row">
                        <span>Pattern</span>
                        <input className="kx-settings-select kx-fill-code" aria-label="Rule pattern" value={recipe.rule.pattern} placeholder="(?i)\bn\s*=\s*(\d+)" onChange={(e) => set({ rule: { ...recipe.rule, pattern: e.target.value } })} />
                      </label>
                      <label className="kx-form-row">
                        <span>In</span>
                        <select className="kx-settings-select" aria-label="Pattern reads" value={recipe.rule.input} onChange={(e) => set({ rule: { ...recipe.rule, input: e.target.value } })}>
                          {INPUTS.map(([id, label]) => (
                            <option key={id} value={id}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <small className="kx-form-note">The part in ( ) becomes the value; Test shows what it finds.</small>
                    </>
                  )}
                </>
              )}
            </div>
          ) : step === 2 ? (
            <div className="kx-fill-step">
              <h3>
                The answer <Explain help="fill.shape" />
              </h3>
              <div className="kx-fill-shapes" role="radiogroup" aria-label="Answer shape">
                {SHAPES.map(([id, label, glyph]) => (
                  <button key={id} type="button" role="radio" aria-checked={recipe.shape === id} disabled={!!lockedShape && lockedShape !== id} data-shape={id} onClick={() => set({ shape: id })}>
                    <span className="kx-type-glyph">{glyph}</span>
                    {label}
                  </button>
                ))}
              </div>
              {lockedShape && <small className="kx-form-note">“{recipe.property}” is a {definition?.type} property, so the answer takes that shape.</small>}
              {(recipe.shape === "select" || recipe.shape === "multiselect") && (
                <label className="kx-form-row kx-fill-instruction">
                  <span>Options</span>
                  <textarea aria-label="Options" rows={4} disabled={!!definition?.options?.length} value={recipe.options.join("\n")} placeholder={"One per line"} onChange={(e) => set({ options: e.target.value.split("\n").map((s) => s.trimStart()) })} onBlur={() => set({ options: recipe.options.map((o) => o.trim()).filter(Boolean) })} />
                </label>
              )}
              <label className="kx-form-row kx-switch-row">
                <span>Also replace values an earlier fill wrote</span>
                <input type="checkbox" className="kx-switch" checked={recipe.refill} onChange={(e) => set({ refill: e.target.checked })} />
              </label>
              <small className="kx-form-note">Values you typed yourself are never replaced.</small>
            </div>
          ) : step === 3 ? (
            <div className="kx-fill-step">
              <h3>
                Test on three sources <Explain help="fill.test" />
              </h3>
              <p className="kx-fill-muted">{providerLine}</p>
              <div>
                <button type="button" className="kx-settings-button kx-service-primary" disabled={busy || (recipe.method === "ai" && !ai?.configured) || test?.run.status === "running"} onClick={() => void run(true)}>
                  {test?.run.status === "running" ? "Testing…" : test ? "Test again" : "Test on 3 sources"}
                </button>
              </div>
              <div className="kx-fill-items">
                {test?.items.map((item) => (
                  <ProposalRow key={item.sourceId} item={item} recipe={test.run.recipe} />
                ))}
              </div>
            </div>
          ) : (
            <div className="kx-fill-step">
              <h3>Run it</h3>
              <div className="kx-form-group">
                <label className="kx-form-row">
                  <span>On</span>
                  <select className="kx-settings-select" aria-label="Run on" value={scope} onChange={(e) => setScope(e.target.value)}>
                    {targets.length > 0 && <option value="selection">The {plural(targets.length, "selected source")}</option>}
                    <option value="library">The whole library</option>
                    {collections.map((c) => (
                      <option key={c.id} value={`collection:${c.id}`}>
                        Collection: {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="kx-form-row kx-switch-row">
                  <span>
                    Keep filled automatically for new sources <Explain help="fill.auto" />
                  </span>
                  <input type="checkbox" className="kx-switch" checked={recipe.auto} onChange={(e) => set({ auto: e.target.checked })} />
                </label>
                <label className="kx-form-row kx-switch-row">
                  <span>Save the recipe</span>
                  <input type="checkbox" className="kx-switch" checked={saveRecipe || recipe.auto} disabled={recipe.auto} onChange={(e) => setSaveRecipe(e.target.checked)} />
                </label>
                {saveRecipe && (
                  <label className="kx-form-row">
                    <span>Recipe name</span>
                    <input className="kx-settings-select" aria-label="Recipe name" value={recipe.name} placeholder={`Fill ${recipe.property}`} onChange={(e) => set({ name: e.target.value })} />
                  </label>
                )}
              </div>
              <div className="kx-fill-estimate" aria-label="Estimate">
                {estimate ? (
                  <>
                    <div>
                      <strong>{plural(estimate.eligible, "source")}</strong>
                      <small>to fill{estimate.skipped ? ` · ${estimate.skipped} keep the value you entered` : ""}</small>
                    </div>
                    {recipe.method === "ai" && (
                      <>
                        <div>
                          <strong>≈ {(estimate.inputTokens + estimate.outputTokens).toLocaleString()} tokens</strong>
                          <small>about {estimate.perSourceTokens.toLocaleString()} per source</small>
                        </div>
                        <div>
                          <strong>{estimate.cost === undefined ? "Cost unknown" : estimate.cost === 0 ? "Free" : `≈ $${estimate.cost < 0.01 ? "0.01" : estimate.cost.toFixed(2)}`}</strong>
                          <small>
                            {ai?.providerName} · {ai?.model} <Explain help="fill.cost" />
                          </small>
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <small className="kx-fill-muted">Working out what this would send…</small>
                )}
              </div>
            </div>
          )}
          {error && (
            <p className="kx-fill-message" role="status">
              {error}
            </p>
          )}
        </div>
        {!fullRun && (
          <footer className="kx-fb-foot">
            <span className="kx-fill-muted kx-fill-foot-note">{providerLine}</span>
            {step > 0 && (
              <button type="button" className="kx-settings-button" onClick={() => setStep(step - 1)}>
                Back
              </button>
            )}
            {step < 4 ? (
              <button type="button" className="kx-settings-button kx-service-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
                Continue
              </button>
            ) : (
              <button type="button" className="kx-settings-button kx-service-primary" disabled={busy || !estimate?.eligible || (recipe.method === "ai" && !ai?.configured)} onClick={() => void run(false)}>
                {busy ? "Starting…" : `Fill ${estimate ? plural(estimate.eligible, "source") : ""}`}
              </button>
            )}
          </footer>
        )}
      </div>
    </GlobalDrawer>
  );
}
