// The formula builder: start from a template or a building block, compose blocks (each a
// pill with its own picker), or write the formula as text with highlighting, completion and
// plain-language errors; a live preview shows the result on real sources. The host parses,
// checks, prints and evaluates (store_formula_*); this view only edits the tree it returns.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import type { Invoke } from "./library-api";
import { Explain, Hint } from "./explain";
import { FormulaValue, displaysFor } from "./formula-display";
import "./formula-builder.css";

export interface Block {
  t: "field" | "text" | "number" | "bool" | "empty" | "fn" | "op";
  name?: string;
  v?: string | number | boolean;
  op?: string;
  args?: Block[];
}
interface CatalogField {
  name: string;
  type: string;
  group: string;
  summary?: string;
  kind: string;
}
interface CatalogFunction {
  name: string;
  label: string;
  category: string;
  summary: string;
  example: string;
  result: string;
  params: string[];
  sentence: string;
  min: number;
  max: number | null;
}
interface Catalog {
  fields: CatalogField[];
  properties: CatalogField[];
  functions: CatalogFunction[];
  templates: { id: string; name: string; summary: string; formula: string; display: string }[];
  blocks: { group: string; label: string; summary: string; formula: string }[];
  operators: { op: string; label: string }[];
}
interface FormulaProblem {
  message: string;
  hint?: string;
  start: number;
  end: number;
}
interface Analysis {
  ok: boolean;
  highlights: { kind: string; start: number; end: number }[];
  resultType: string;
  error?: FormulaProblem;
  warnings: FormulaProblem[];
  blocks?: Block;
}
interface PreviewRow {
  id: string;
  title: string;
  value?: unknown;
  type?: string;
  error?: string;
  hint?: string;
}

const CATEGORY_LABEL: Record<string, string> = { logic: "Decide", text: "Text", number: "Numbers", list: "Lists and counts", date: "Dates" };
const GROUP_LABEL: Record<string, string> = {
  publication: "Publication",
  people: "Authors",
  library: "Library",
  reading: "Reading",
  files: "Files",
  metrics: "Citations and access",
  related: "Related sources",
  properties: "Your properties",
};
const OPERATOR_GROUPS: [string, string[]][] = [
  ["Compare", ["==", "!=", ">", "<", ">=", "<="]],
  ["Maths", ["+", "-", "*", "/"]],
  ["Combine", ["&&", "||", "&"]],
];

const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^Error: /, "");

function setAt(root: Block, path: number[], next: Block): Block {
  if (!path.length) return next;
  const [head, ...rest] = path;
  const args = [...(root.args ?? [])];
  args[head] = setAt(args[head] ?? { t: "empty" }, rest, next);
  return { ...root, args };
}
function removeAt(root: Block, path: number[]): Block {
  if (path.length === 1) return { ...root, args: (root.args ?? []).filter((_, i) => i !== path[0]) };
  const [head, ...rest] = path;
  const args = [...(root.args ?? [])];
  args[head] = removeAt(args[head], rest);
  return { ...root, args };
}

/** The path of the first empty slot, depth first. */
function firstEmpty(block: Block, path: number[] = []): number[] | undefined {
  if (block.t === "empty") return path;
  for (const [i, arg] of (block.args ?? []).entries()) {
    const found = firstEmpty(arg, [...path, i]);
    if (found) return found;
  }
  return undefined;
}

/** A value typed into a block: committed on Enter or when it loses focus. */
function InlineInput({ value, numeric, label, onCommit }: { value: string; numeric?: boolean; label: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="kx-fb-input"
      data-numeric={numeric || undefined}
      aria-label={label}
      inputMode={numeric ? "decimal" : undefined}
      size={Math.max(2, Math.min(28, draft.length + 1))}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

interface BlockContext {
  catalog: Catalog;
  functions: Map<string, CatalogFunction>;
  replace: (path: number[], next: Block) => void;
  remove: (path: number[]) => void;
}

/** "Change to…": a native menu of what a block can become (the current one is kept as the
 * first value of a function or operator, so blocks compose by wrapping). */
function ChangeMenu({ block, path, ctx, removable }: { block: Block; path: number[]; ctx: BlockContext; removable?: boolean }) {
  return (
    <span className="kx-fb-change" title="Change this block">
    <Icon name="chevronDown" size={9} />
    <select
      aria-label="Change this block"
      title="Change this block"
      value=""
      onChange={(e) => {
        const choice = e.target.value;
        e.target.value = "";
        if (choice === "remove") return removable ? ctx.remove(path) : ctx.replace(path, { t: "empty" });
        if (choice === "field") return ctx.replace(path, { t: "field", name: ctx.catalog.fields[0].name });
        if (choice === "text") return ctx.replace(path, { t: "text", v: "" });
        if (choice === "number") return ctx.replace(path, { t: "number", v: 0 });
        if (choice === "bool") return ctx.replace(path, { t: "bool", v: true });
        if (choice === "empty") return ctx.replace(path, { t: "empty" });
        if (choice.startsWith("op:")) {
          const op = choice.slice(3);
          return ctx.replace(path, { t: "op", op, args: [block, op === "&" ? { t: "text", v: "" } : { t: "number", v: 0 }] });
        }
        if (choice.startsWith("fn:")) {
          const fn = ctx.functions.get(choice.slice(3))!;
          const args: Block[] = Array.from({ length: Math.max(fn.min, 0) }, (_, i) => (i === 0 && fn.min > 0 ? block : { t: "empty" }));
          return ctx.replace(path, { t: "fn", name: fn.name, args });
        }
      }}
    >
      <option value="">Change to…</option>
      <optgroup label="Value">
        <option value="field">A field or property</option>
        <option value="text">Text</option>
        <option value="number">A number</option>
        <option value="bool">Yes or no</option>
        <option value="empty">Empty</option>
      </optgroup>
      {OPERATOR_GROUPS.map(([label, ops]) => (
        <optgroup key={label} label={`${label} with…`}>
          {ops.map((op) => (
            <option key={op} value={`op:${op}`}>
              This {ctx.catalog.operators.find((o) => o.op === op)?.label ?? op} …
            </option>
          ))}
        </optgroup>
      ))}
      {Object.entries(CATEGORY_LABEL).map(([category, label]) => (
        <optgroup key={category} label={label}>
          {ctx.catalog.functions
            .filter((f) => f.category === category)
            .map((f) => (
              <option key={f.name} value={`fn:${f.name}`}>
                {f.label}
              </option>
            ))}
        </optgroup>
      ))}
      <option value="remove">{removable ? "Remove" : "Clear"}</option>
    </select>
    </span>
  );
}

function FieldPicker({ name, ctx, onChange }: { name: string; ctx: BlockContext; onChange: (name: string) => void }) {
  const groups = useMemo(() => {
    const all = [...ctx.catalog.properties, ...ctx.catalog.fields];
    const map = new Map<string, CatalogField[]>();
    for (const f of all) map.set(f.group, [...(map.get(f.group) ?? []), f]);
    return [...map.entries()];
  }, [ctx.catalog]);
  const known = groups.some(([, list]) => list.some((f) => f.name.toLowerCase() === name.toLowerCase()));
  return (
    <select className="kx-fb-pill" data-kind="field" aria-label="Field" value={known ? groups.flatMap(([, l]) => l).find((f) => f.name.toLowerCase() === name.toLowerCase())!.name : name} onChange={(e) => onChange(e.target.value)}>
      {!known && <option value={name}>{name} (not found)</option>}
      {groups.map(([group, list]) => (
        <optgroup key={group} label={GROUP_LABEL[group] ?? group}>
          {list.map((f) => (
            <option key={`${f.kind}:${f.name}`} value={f.name}>
              {f.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function BlockView({ block, path, ctx, removable }: { block: Block; path: number[]; ctx: BlockContext; removable?: boolean }): ReactNode {
  const replace = (next: Block) => ctx.replace(path, next);
  let body: ReactNode;
  switch (block.t) {
    case "field":
      body = <FieldPicker name={block.name ?? ""} ctx={ctx} onChange={(name) => replace({ t: "field", name })} />;
      break;
    case "text":
      body = (
        <span className="kx-fb-pill" data-kind="text">
          “<InlineInput value={String(block.v ?? "")} label="Text" onCommit={(v) => replace({ t: "text", v })} />”
        </span>
      );
      break;
    case "number":
      body = (
        <span className="kx-fb-pill" data-kind="number">
          <InlineInput numeric value={String(block.v ?? 0)} label="Number" onCommit={(v) => replace({ t: "number", v: Number.isFinite(Number(v)) ? Number(v) : 0 })} />
        </span>
      );
      break;
    case "bool":
      body = (
        <select className="kx-fb-pill" data-kind="bool" aria-label="Yes or no" value={String(block.v)} onChange={(e) => replace({ t: "bool", v: e.target.value === "true" })}>
          <option value="true">yes</option>
          <option value="false">no</option>
        </select>
      );
      break;
    case "empty":
      body = (
        <span className="kx-fb-pill" data-kind="empty">
          empty
        </span>
      );
      break;
    case "op": {
      const args = block.args ?? [];
      if (args.length === 1) {
        body = (
          <span className="kx-fb-group">
            <span className="kx-fb-word">{block.op === "!" ? "not" : "minus"}</span>
            <BlockView block={args[0]} path={[...path, 0]} ctx={ctx} />
          </span>
        );
      } else {
        body = (
          <span className="kx-fb-group" data-kind="op">
            <BlockView block={args[0] ?? { t: "empty" }} path={[...path, 0]} ctx={ctx} />
            <select className="kx-fb-op" aria-label="Operator" value={block.op} onChange={(e) => replace({ ...block, op: e.target.value })}>
              {ctx.catalog.operators.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            <BlockView block={args[1] ?? { t: "empty" }} path={[...path, 1]} ctx={ctx} />
          </span>
        );
      }
      break;
    }
    case "fn": {
      const fn = ctx.functions.get(block.name ?? "");
      const args = block.args ?? [];
      if (!fn) {
        body = <span className="kx-fb-pill">{block.name}()</span>;
        break;
      }
      const parts = fn.sentence.split(/(\{\d+\}|\{…\})/g).filter(Boolean);
      const fixed = Math.max(...[-1, ...parts.map((p) => (/^\{\d+\}$/.test(p) ? Number(p.slice(1, -1)) : -1))]) + 1;
      body = (
        <span className="kx-fb-group" data-kind="fn" data-category={fn.category} title={fn.summary}>
          {parts.map((part, i) => {
            if (/^\{\d+\}$/.test(part)) {
              const index = Number(part.slice(1, -1));
              const arg = args[index];
              if (!arg)
                return (
                  <button key={i} type="button" className="kx-fb-add" title={`Add ${fn.params[index] ?? "a value"}`} onClick={() => replace({ ...block, args: [...args, ...Array.from({ length: index + 1 - args.length }, (): Block => ({ t: index === 1 && fn.params[1] === "decimals" ? "number" : "empty", v: 0 }))] })}>
                    + {fn.params[index] ?? "value"}
                  </button>
                );
              return <BlockView key={i} block={arg} path={[...path, index]} ctx={ctx} removable={index >= fn.min} />;
            }
            if (part === "{…}") {
              const rest = args.slice(fixed);
              return (
                <span key={i} className="kx-fb-list">
                  {rest.map((arg, j) => (
                    <BlockView key={j} block={arg} path={[...path, fixed + j]} ctx={ctx} removable={rest.length > Math.max(1, fn.min - fixed)} />
                  ))}
                  {(fn.max === null || args.length < fn.max) && (
                    <button type="button" className="kx-fb-add" title="Add another" onClick={() => replace({ ...block, args: [...args, { t: "empty" }] })}>
                      +
                    </button>
                  )}
                </span>
              );
            }
            return (
              <span key={i} className="kx-fb-word">
                {part.trim()}
              </span>
            );
          })}
        </span>
      );
      break;
    }
  }
  return (
    <span className="kx-fb-block" data-type={block.t}>
      {body}
      <ChangeMenu block={block} path={path} ctx={ctx} removable={removable} />
    </span>
  );
}

/** The formula as text, highlighted underneath a transparent textarea, with completion. */
function TextEditor({ value, analysis, catalog, onChange }: { value: string; analysis?: Analysis; catalog: Catalog; onChange: (value: string) => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const chars = [...value];
  const marks = analysis?.highlights ?? [];
  const error = analysis?.error;
  const spans: ReactNode[] = [];
  let at = 0;
  for (const h of marks) {
    if (h.start > at) spans.push(<span key={`g${at}`}>{chars.slice(at, h.start).join("")}</span>);
    const inError = error && h.start < error.end && h.end > error.start;
    spans.push(
      <span key={h.start} data-hl={h.kind} data-error={inError || undefined}>
        {chars.slice(h.start, h.end).join("")}
      </span>,
    );
    at = h.end;
  }
  if (at < chars.length) spans.push(<span key="tail">{chars.slice(at).join("")}</span>);
  // What is being typed at the caret: `{Partial` (a field) or `word` (a function).
  const before = chars.slice(0, caret).join("");
  const fieldMatch = /[{[]([^{}[\]]*)$/.exec(before);
  const wordMatch = !fieldMatch ? /([A-Za-z_]{2,})$/.exec(before) : null;
  const suggestions = useMemo(() => {
    if (fieldMatch) {
      const q = fieldMatch[1].toLowerCase();
      return [...catalog.properties, ...catalog.fields].filter((f) => f.name.toLowerCase().includes(q)).slice(0, 8).map((f) => ({ label: f.name, detail: f.type, insert: `{${f.name}}`, replace: fieldMatch[0].length }));
    }
    if (wordMatch) {
      const q = wordMatch[1].toLowerCase();
      return catalog.functions.filter((f) => f.name.startsWith(q) || f.label.toLowerCase().startsWith(q)).slice(0, 8).map((f) => ({ label: `${f.name}()`, detail: f.label, insert: `${f.name}(`, replace: wordMatch[1].length }));
    }
    return [];
  }, [before, catalog]);
  const open = suggestOpen && suggestions.length > 0;
  const accept = (index: number) => {
    const s = suggestions[index];
    if (!s) return;
    const start = caret - s.replace;
    const next = chars.slice(0, start).join("") + s.insert + chars.slice(caret).join("");
    onChange(next);
    const position = start + [...s.insert].length;
    setSuggestOpen(false);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(position, position);
      setCaret(position);
    });
  };
  return (
    <div className="kx-fb-code-wrap">
      <div className="kx-fb-code">
        <pre aria-hidden="true">
          {spans}
          {"\n"}
        </pre>
        <textarea
          ref={area}
          aria-label="Formula text"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={value}
          placeholder='if({Year} > 2020, "Recent", "Older")'
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart);
            setSuggestOpen(true);
            setActive(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
            } else if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              accept(active);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setSuggestOpen(false);
            }
          }}
        />
      </div>
      {open && (
        <ul className="kx-fb-suggest" role="listbox" aria-label="Suggestions">
          {suggestions.map((s, i) => (
            <li key={s.label} role="option" aria-selected={i === active} onMouseDown={(e) => (e.preventDefault(), accept(i))}>
              <code>{s.label}</code>
              <small>{s.detail}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FunctionReference({ catalog, onInsert }: { catalog: Catalog; onInsert: (text: string) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  return (
    <div className="kx-fb-reference" aria-label="Function reference">
      <label className="kx-fb-search">
        <Icon name="search" size={11} />
        <input placeholder="Find a function" aria-label="Find a function" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {Object.entries(CATEGORY_LABEL).map(([category, label]) => {
        const list = catalog.functions.filter((f) => f.category === category && (!q || f.name.includes(q) || f.label.toLowerCase().includes(q) || f.summary.toLowerCase().includes(q)));
        if (!list.length) return null;
        return (
          <section key={category}>
            <h4>{label}</h4>
            {list.map((f) => (
              <div key={f.name} className="kx-fb-ref-item">
                <strong>
                  {f.label} <code>{f.name}({f.params.join(", ")})</code>
                </strong>
                <small>{f.summary}</small>
                <button type="button" className="kx-fb-example" title="Insert this example" onClick={() => onInsert(f.example)}>
                  <code>{f.example}</code>
                </button>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

export default function FormulaBuilder({
  invoke,
  workspaceId,
  name,
  formula: initialFormula,
  display: initialDisplay,
  sampleIds,
  onDone,
  onCancel,
}: {
  invoke: Invoke;
  workspaceId?: string;
  /** The property's name (for the loop check), when it has one. */
  name?: string;
  formula: string;
  display?: string;
  /** Sources to preview on (else the most recently added). */
  sampleIds?: string[];
  onDone: (formula: string, display: string, resultType: string) => void;
  onCancel: () => void;
}) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [formula, setFormula] = useState(initialFormula);
  const [mode, setMode] = useState<"blocks" | "text">("blocks");
  const [analysis, setAnalysis] = useState<Analysis>();
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [display, setDisplay] = useState(initialDisplay ?? "");
  const [showReference, setShowReference] = useState(false);
  const [describe, setDescribe] = useState("");
  const [draft, setDraft] = useState<{ formula: string; explanation: string; error?: string }>();
  const [drafting, setDrafting] = useState(false);
  const [ai, setAi] = useState<{ configured: boolean; providerName?: string; local?: boolean }>();
  const [error, setError] = useState("");

  useEffect(() => {
    void invoke<Catalog>("store_formula_catalog", {}, workspaceId).then(setCatalog).catch((e) => setError(errorText(e)));
    void invoke<{ configured: boolean }>("ai_status", {}, workspaceId).then(setAi).catch(() => setAi({ configured: false }));
  }, [invoke, workspaceId]);
  useEffect(() => {
    if (!formula.trim()) {
      setAnalysis(undefined);
      setRows([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void invoke<Analysis>("store_formula_analyze", { formula, name: name || null }, workspaceId)
        .then((a) => live && setAnalysis(a))
        .catch(() => {});
      void invoke<{ rows: PreviewRow[] }>("store_formula_preview", { formula, ids: sampleIds?.length ? sampleIds.slice(0, 6) : null, limit: 6 }, workspaceId)
        .then((r) => live && setRows(r.rows))
        .catch(() => {});
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [formula, invoke, workspaceId, name, sampleIds?.join()]);

  const functions = useMemo(() => new Map((catalog?.functions ?? []).map((f) => [f.name, f])), [catalog]);
  const resultType = analysis?.resultType ?? "any";
  const displays = displaysFor(resultType);
  const shownDisplay = displays.some((d) => d.id === display) ? display : displays[0].id;
  const setBlocks = (next: Block) =>
    void invoke<{ formula: string }>("store_formula_print", { blocks: next }, workspaceId)
      .then((r) => setFormula(r.formula))
      .catch((e) => setError(errorText(e)));
  const start = (text: string, display?: string) => {
    setFormula(text);
    if (display) setDisplay(display);
    setError("");
  };
  // A block goes into the first empty slot of the formula, or starts it.
  const insert = async (text: string) => {
    if (!formula.trim()) return start(text);
    if (mode === "text") return setFormula(`${formula}${/\s$/.test(formula) ? "" : " "}${text}`);
    const slot = analysis?.blocks ? firstEmpty(analysis.blocks) : undefined;
    if (!slot || !analysis?.blocks) return start(text);
    const piece = await invoke<Analysis>("store_formula_analyze", { formula: text }, workspaceId).catch(() => undefined);
    if (piece?.blocks) setBlocks(setAt(analysis.blocks, slot, piece.blocks));
  };
  const draftFromWords = async () => {
    setDrafting(true);
    setDraft(undefined);
    try {
      const r = await invoke<{ formula: string; explanation: string; analysis: Analysis }>("ai_describe_formula", { description: describe }, workspaceId);
      setDraft({ formula: r.formula, explanation: r.explanation, error: r.analysis.ok ? undefined : r.analysis.error?.message });
    } catch (e) {
      setDraft({ formula: "", explanation: "", error: errorText(e) });
    } finally {
      setDrafting(false);
    }
  };

  if (!catalog)
    return (
      <div className="kx-fb" data-modal-view="formula-builder">
        <p className="kx-fb-loading">{error || "Loading…"}</p>
      </div>
    );
  const ctx: BlockContext = {
    catalog,
    functions,
    replace: (path, next) => analysis?.blocks && setBlocks(setAt(analysis.blocks, path, next)),
    remove: (path) => analysis?.blocks && setBlocks(removeAt(analysis.blocks, path)),
  };
  const groups = [...new Set(catalog.blocks.map((b) => b.group))];
  const problem = analysis?.error;
  return (
    <div className="kx-fb" role="dialog" aria-label="Formula builder" data-modal-view="formula-builder">
      <header className="kx-fb-head">
        <div>
          <h2>
            {name ? `Formula for “${name}”` : "Formula"} <Explain help="formula.builder" />
          </h2>
          <small>Worked out for every source, kept up to date, sortable and filterable.</small>
        </div>
        <div className="kx-segmented" role="group" aria-label="Edit as">
          <button type="button" aria-pressed={mode === "blocks"} onClick={() => setMode("blocks")}>
            Blocks
          </button>
          <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>
            Text
          </button>
        </div>
        <button type="button" className="kx-sheet-close" aria-label="Close formula builder" onClick={onCancel}>
          <Icon name="close" size={10} />
        </button>
      </header>
      <div className="kx-fb-body">
        <aside className="kx-fb-palette" aria-label="Building blocks">
          <section className="kx-fb-describe">
            <h4>
              Describe it in words <Explain help="formula.describe" />
            </h4>
            <textarea
              aria-label="Describe the formula"
              rows={2}
              placeholder="Days since I added it, or “High” when it has more than 100 citations"
              value={describe}
              disabled={!ai?.configured}
              onChange={(e) => setDescribe(e.target.value)}
            />
            {ai?.configured ? (
              <button type="button" className="kx-settings-button" disabled={!describe.trim() || drafting} onClick={() => void draftFromWords()}>
                <Icon name="sparkle" size={11} /> {drafting ? "Drafting…" : "Draft a formula"}
              </button>
            ) : (
              <small>Set up the AI assistant in Key Settings to draft formulas from a description.</small>
            )}
            {draft && (
              <div className="kx-fb-draft" data-error={draft.error ? true : undefined}>
                {draft.formula && <code>{draft.formula}</code>}
                {draft.explanation && <small>{draft.explanation}</small>}
                {draft.error && <small className="kx-fb-draft-error">{draft.error}</small>}
                {draft.formula && (
                  <button type="button" className="kx-settings-button" onClick={() => start(draft.formula)}>
                    Use this
                  </button>
                )}
              </div>
            )}
          </section>
          <section>
            <h4>Start from</h4>
            <div className="kx-fb-templates">
              {catalog.templates.map((t) => (
                <button key={t.id} type="button" className="kx-fb-template" data-template={t.id} title={t.summary} onClick={() => start(t.formula, t.display)}>
                  <strong>{t.name}</strong>
                  <small>{t.summary}</small>
                </button>
              ))}
            </div>
          </section>
          {groups.map((group) => (
            <section key={group}>
              <h4>{group}</h4>
              <div className="kx-fb-blocks">
                {catalog.blocks
                  .filter((b) => b.group === group)
                  .map((b) => (
                    <button key={b.label} type="button" className="kx-fb-chip" data-block={b.label} title={b.summary} onClick={() => void insert(b.formula)}>
                      {b.label}
                    </button>
                  ))}
              </div>
            </section>
          ))}
        </aside>
        <main className="kx-fb-main">
          <section className="kx-fb-editor" aria-label={mode === "blocks" ? "Formula blocks" : "Formula text"}>
            {mode === "blocks" ? (
              !formula.trim() ? (
                <div className="kx-fb-empty">
                  <Icon name="function" size={20} />
                  <strong>Pick a template or a block to start</strong>
                  <small>Each block has a menu to change it, or to wrap it in another block such as “If … then … otherwise”.</small>
                </div>
              ) : analysis?.blocks ? (
                <div className="kx-fb-tree">
                  <BlockView block={analysis.blocks} path={[]} ctx={ctx} />
                </div>
              ) : problem ? (
                <div className="kx-fb-empty">
                  <Icon name="warning" size={18} />
                  <strong>The text has a problem, so it cannot show as blocks</strong>
                  <small>Switch to Text to fix it, or start again from a template.</small>
                </div>
              ) : (
                <p className="kx-fb-loading">Reading…</p>
              )
            ) : (
              <>
                <TextEditor value={formula} analysis={analysis} catalog={catalog} onChange={setFormula} />
                <div className="kx-fb-text-tools">
                  <button type="button" className="kx-settings-button" aria-pressed={showReference} onClick={() => setShowReference((s) => !s)}>
                    <Icon name="book" size={11} /> Functions
                  </button>
                  <Hint help="formula.text" />
                </div>
              </>
            )}
            {problem && (
              <div className="kx-fb-problem" role="alert">
                <Icon name="warning" size={13} />
                <div>
                  <strong>{problem.message}</strong>
                  {problem.hint && <small>{problem.hint}</small>}
                </div>
              </div>
            )}
            {!problem &&
              analysis?.warnings.map((w) => (
                <div key={`${w.start}-${w.message}`} className="kx-fb-problem" data-level="warning">
                  <Icon name="info" size={13} />
                  <div>
                    <strong>{w.message}</strong>
                    {w.hint && <small>{w.hint}</small>}
                  </div>
                </div>
              ))}
            {error && <p className="key-property-error">{error}</p>}
          </section>
          {showReference && mode === "text" && <FunctionReference catalog={catalog} onInsert={(text) => setFormula(formula.trim() ? `${formula} ${text}` : text)} />}
          <section className="kx-fb-preview" aria-label="Preview">
            <header>
              <h4>Preview</h4>
              {analysis?.ok && <span className="kx-fb-type" data-type={resultType}>{TYPE_LABEL[resultType] ?? "Mixed"}</span>}
              <span className="kx-spacer" />
              {displays.length > 1 && (
                <div className="kx-segmented" role="group" aria-label="Show as">
                  {displays.map((d) => (
                    <button key={d.id} type="button" aria-pressed={shownDisplay === d.id} onClick={() => setDisplay(d.id)}>
                      {d.label}
                    </button>
                  ))}
                </div>
              )}
            </header>
            {rows.length ? (
              <table className="kx-fb-rows">
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td title={row.title}>{row.title || "Untitled"}</td>
                      <td>{row.error ? <span className="kx-fv-error" title={row.hint}>{row.error}</span> : <FormulaValue value={row.value} resultType={resultType} display={shownDisplay} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <small className="kx-fb-hint">{formula.trim() ? "No sources to preview yet." : "The result on a few of your sources shows here."}</small>
            )}
          </section>
        </main>
      </div>
      <footer className="kx-fb-foot">
        <code className="kx-fb-summary" title={formula}>
          {formula || " "}
        </code>
        <button type="button" className="kx-settings-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="kx-settings-button kx-service-primary" disabled={!formula.trim() || !analysis?.ok} onClick={() => onDone(formula.trim(), shownDisplay, resultType)}>
          Use formula
        </button>
      </footer>
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = { number: "Number", text: "Text", boolean: "Yes / no", date: "Date", list: "List", select: "Label" };
