// The formula builder: an empty formula opens on a gallery of examples (reachable again
// from Examples); the sidebar is only a reference to insert from (the source's properties
// and the functions, searchable, each described when pointed at); the middle edits the
// formula as blocks (each a pill with its own picker) or as text with highlighting,
// completion and plain-language errors where they are; the preview shows the result on
// real sources. The host parses, checks, prints and evaluates (store_formula_*).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { SegmentedTabs } from "@key-reader/ui/SegmentedTabs";
import { Icon, type IconName } from "./icons";
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
function TextEditor({ value, analysis, catalog, onChange, areaRef }: { value: string; analysis?: Analysis; catalog: Catalog; onChange: (value: string) => void; areaRef: RefObject<HTMLTextAreaElement | null> }) {
  const area = areaRef;
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

type ReferenceItem =
  | { kind: "field"; key: string; name: string; type: string; summary?: string; group: string; own: boolean }
  | { kind: "function"; key: string; fn: CatalogFunction };

const TYPE_ICON: Record<string, IconName> = { number: "hash", boolean: "check", date: "clock", list: "list", text: "text" };
const fieldType = (type: string) => type.replace(/^formula:/, "");

/** The insertable reference: the source's fields and properties, and the functions by
 * category, searchable; the selected (hovered or focused) item is described underneath. */
function Reference({ catalog, onInsert }: { catalog: Catalog; onInsert: (text: string, item: ReferenceItem) => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReferenceItem>();
  const list = useRef<HTMLDivElement>(null);
  // Always opens at the top (a focused item further down used to scroll it).
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, []);
  const q = query.trim().toLowerCase();
  const fieldGroups = useMemo(() => {
    const items: ReferenceItem[] = [
      ...catalog.properties.map((f) => ({ kind: "field" as const, key: `p:${f.name}`, name: f.name, type: f.type, summary: f.kind === "formula" ? "One of your formula properties." : "One of your properties.", group: "properties", own: true })),
      ...catalog.fields.map((f) => ({ kind: "field" as const, key: `f:${f.name}`, name: f.name, type: f.type, summary: f.summary, group: f.group, own: false })),
    ].filter((f) => !q || f.name.toLowerCase().includes(q) || (f.summary ?? "").toLowerCase().includes(q));
    const groups = new Map<string, ReferenceItem[]>();
    for (const item of items) if (item.kind === "field") groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
    return [...groups.entries()];
  }, [catalog, q]);
  const functionGroups = useMemo(
    () =>
      Object.entries(CATEGORY_LABEL)
        .map(([category, label]) => [
          label,
          catalog.functions
            .filter((f) => f.category === category && (!q || f.name.includes(q) || f.label.toLowerCase().includes(q) || f.summary.toLowerCase().includes(q)))
            .map((fn): ReferenceItem => ({ kind: "function", key: `fn:${fn.name}`, fn })),
        ] as const)
        .filter(([, items]) => items.length),
    [catalog, q],
  );
  const textOf = (item: ReferenceItem) => (item.kind === "field" ? `{${item.name}}` : item.fn.example);
  const row = (item: ReferenceItem) => (
    <button
      key={item.key}
      type="button"
      className="kx-fb-ref"
      data-ref={item.kind === "field" ? item.name : item.fn.name}
      aria-current={selected?.key === item.key || undefined}
      title={item.kind === "field" ? `Insert {${item.name}}` : `Insert ${item.fn.example}`}
      onMouseEnter={() => setSelected(item)}
      onFocus={() => setSelected(item)}
      onClick={() => onInsert(textOf(item), item)}
    >
      {item.kind === "field" ? (
        <>
          <Icon name={item.type.startsWith("formula") ? "function" : (TYPE_ICON[item.type] ?? "text")} size={12} />
          <span>{item.name}</span>
        </>
      ) : (
        <>
          <span>{item.fn.label}</span>
          <code>{item.fn.name}</code>
        </>
      )}
    </button>
  );
  const empty = !fieldGroups.length && !functionGroups.length;
  return (
    <aside className="kx-fb-side" aria-label="Formula reference">
      <label className="kx-fb-search">
        <Icon name="search" size={12} />
        <input type="search" placeholder="Search" aria-label="Search properties and functions" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="kx-fb-side-list" ref={list}>
        {fieldGroups.length > 0 && (
          <section aria-label="Properties">
            <h3>Properties</h3>
            {fieldGroups.map(([group, items]) => (
              <div key={group} className="kx-fb-ref-group">
                <h4>{GROUP_LABEL[group] ?? group}</h4>
                {items.map(row)}
              </div>
            ))}
          </section>
        )}
        {functionGroups.length > 0 && (
          <section aria-label="Functions">
            <h3>Functions</h3>
            {functionGroups.map(([label, items]) => (
              <div key={label} className="kx-fb-ref-group">
                <h4>{label}</h4>
                {items.map(row)}
              </div>
            ))}
          </section>
        )}
        {empty && <p className="kx-fb-side-empty">Nothing matches “{query}”.</p>}
      </div>
      <div className="kx-fb-detail" aria-live="polite">
        {selected ? (
          selected.kind === "field" ? (
            <>
              <strong>
                {selected.name} <span className="kx-fb-type">{TYPE_LABEL[fieldType(selected.type)] ?? "Any"}</span>
              </strong>
              {selected.summary && <small>{selected.summary}</small>}
              <code>{`{${selected.name}}`}</code>
            </>
          ) : (
            <>
              <strong>
                {selected.fn.label} <span className="kx-fb-type">{TYPE_LABEL[selected.fn.result] ?? "Any"}</span>
              </strong>
              <small>{selected.fn.summary}</small>
              <code>
                {selected.fn.name}({selected.fn.params.join(", ")})
              </code>
              <small className="kx-fb-detail-example">
                Example: <code>{selected.fn.example}</code>
              </small>
            </>
          )
        ) : (
          <small>Point at an item to see what it does. Click to insert it into the formula.</small>
        )}
      </div>
    </aside>
  );
}

/** Ready-made formulas to start from, and (with an AI model set up) drafting from words. */
function Gallery({
  catalog,
  ai,
  invoke,
  workspaceId,
  hasFormula,
  onPick,
  onClose,
}: {
  catalog: Catalog;
  ai?: { configured: boolean };
  invoke: Invoke;
  workspaceId?: string;
  hasFormula: boolean;
  onPick: (formula: string, display?: string) => void;
  onClose: () => void;
}) {
  const [describe, setDescribe] = useState("");
  const [draft, setDraft] = useState<{ formula: string; explanation: string; error?: string }>();
  const [drafting, setDrafting] = useState(false);
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
  return (
    <section className="kx-fb-gallery" aria-label="Start from an example">
      <header>
        <div>
          <h3>Start from an example</h3>
          <small>Pick one and adjust it, or start from scratch with the properties and functions on the left.</small>
        </div>
        <button type="button" className="kx-settings-button" onClick={onClose}>
          {hasFormula ? "Back to formula" : "Start from scratch"}
        </button>
      </header>
      <div className="kx-fb-templates">
        {catalog.templates.map((t) => (
          <button key={t.id} type="button" className="kx-fb-template" data-template={t.id} onClick={() => onPick(t.formula, t.display)}>
            <strong>{t.name}</strong>
            <small>{t.summary}</small>
            <code>{t.formula}</code>
          </button>
        ))}
      </div>
      <div className="kx-fb-describe">
        <h4>
          <Icon name="sparkle" size={12} /> Describe it in words <Explain help="formula.describe" />
        </h4>
        {ai?.configured ? (
          <>
            <div className="kx-fb-describe-row">
              <input
                aria-label="Describe the formula"
                placeholder="Days since I added it, or “High” when it has more than 100 citations"
                value={describe}
                onChange={(e) => setDescribe(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && describe.trim() && !drafting && void draftFromWords()}
              />
              <button type="button" className="kx-settings-button" disabled={!describe.trim() || drafting} onClick={() => void draftFromWords()}>
                {drafting ? "Drafting…" : "Draft"}
              </button>
            </div>
            {draft && (
              <div className="kx-fb-draft" data-error={draft.error ? true : undefined}>
                {draft.formula && <code>{draft.formula}</code>}
                {draft.explanation && <small>{draft.explanation}</small>}
                {draft.error && <small className="kx-fb-draft-error">{draft.error}</small>}
                {draft.formula && (
                  <button type="button" className="kx-settings-button" onClick={() => onPick(draft.formula)}>
                    Use this
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <small>Set up the AI assistant in Key Settings to draft a formula from a sentence.</small>
        )}
      </div>
    </section>
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
  const [gallery, setGallery] = useState(!initialFormula.trim());
  const [analysis, setAnalysis] = useState<Analysis>();
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [display, setDisplay] = useState(initialDisplay ?? "");
  const [ai, setAi] = useState<{ configured: boolean; providerName?: string; local?: boolean }>();
  const [error, setError] = useState("");
  const tree = useRef<Block>(undefined);
  const area = useRef<HTMLTextAreaElement>(null);

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
        .then((a) => {
          if (!live) return;
          setAnalysis(a);
          if (a.blocks) tree.current = a.blocks;
        })
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
  // Edits build on the newest tree, not on the last analysis (which may lag one edit behind).
  const setBlocks = (next: Block) => {
    tree.current = next;
    void invoke<{ formula: string }>("store_formula_print", { blocks: next }, workspaceId)
      .then((r) => setFormula(r.formula))
      .catch((e) => setError(errorText(e)));
  };
  const start = (text: string, display?: string) => {
    tree.current = undefined;
    setFormula(text);
    if (display) setDisplay(display);
    setError("");
    setGallery(false);
  };
  // From the reference: at the caret in Text, else into the first empty slot of the blocks
  // (or as the start of the formula).
  const insert = async (text: string) => {
    setGallery(false);
    if (!formula.trim()) return start(text);
    if (mode === "text") {
      const el = area.current;
      const chars = [...formula];
      const [from, to] = el ? [[...formula.slice(0, el.selectionStart)].length, [...formula.slice(0, el.selectionEnd)].length] : [chars.length, chars.length];
      const next = chars.slice(0, from).join("") + text + chars.slice(to).join("");
      setFormula(next);
      const caret = from + [...text].length;
      requestAnimationFrame(() => {
        area.current?.focus();
        const at = [...next].slice(0, caret).join("").length;
        area.current?.setSelectionRange(at, at);
      });
      return;
    }
    const root = tree.current;
    const slot = root ? firstEmpty(root) : undefined;
    if (!slot || !root) return start(text);
    const piece = await invoke<Analysis>("store_formula_analyze", { formula: text }, workspaceId).catch(() => undefined);
    if (piece?.blocks && tree.current) setBlocks(setAt(tree.current, slot, piece.blocks));
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
    replace: (path, next) => tree.current && setBlocks(setAt(tree.current, path, next)),
    remove: (path) => tree.current && setBlocks(removeAt(tree.current, path)),
  };
  const problem = analysis?.error;
  const problems = (
    <>
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
    </>
  );
  return (
    <div className="kx-fb" data-modal-view="formula-builder">
      <header className="kx-fb-head">
        <div className="kx-fb-title">
          <h2>
            {name ? `Formula for “${name}”` : "Formula"} <Explain help="formula.builder" />
          </h2>
          <small>Worked out for every source and kept up to date.</small>
        </div>
        <button type="button" className="kx-settings-button" aria-pressed={gallery} onClick={() => setGallery((g) => !g)}>
          <Icon name="sparkle" size={12} /> Examples
        </button>
        <SegmentedTabs
          label="Edit as"
          size="small"
          className="kx-fb-modes"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setGallery(false);
          }}
          tabs={[
            { id: "blocks", label: "Blocks" },
            { id: "text", label: "Text" },
          ]}
        />
        <button type="button" className="kx-sheet-close" aria-label="Close formula builder" onClick={onCancel}>
          <Icon name="close" size={10} />
        </button>
      </header>
      <div className="kx-fb-body">
        <Reference catalog={catalog} onInsert={(text) => void insert(text)} />
        <main className="kx-fb-main">
          {gallery ? (
            <Gallery catalog={catalog} ai={ai} invoke={invoke} workspaceId={workspaceId} hasFormula={!!formula.trim()} onPick={start} onClose={() => setGallery(false)} />
          ) : (
            <>
              <section className="kx-fb-editor" aria-label={mode === "blocks" ? "Formula blocks" : "Formula text"}>
                {mode === "blocks" ? (
                  !formula.trim() ? (
                    <div className="kx-fb-empty">
                      <Icon name="function" size={20} />
                      <strong>Click a property or function on the left to start</strong>
                      <small>Each block then has a menu to change it, or to wrap it in another one such as “If … then … otherwise”.</small>
                    </div>
                  ) : analysis?.blocks ? (
                    <div className="kx-fb-tree">
                      <BlockView block={analysis.blocks} path={[]} ctx={ctx} />
                    </div>
                  ) : problem ? (
                    <div className="kx-fb-empty" data-problem>
                      <Icon name="warning" size={18} />
                      <strong>This formula has a problem, so it cannot show as blocks</strong>
                      <small>Switch to Text to fix it where it is marked, or pick an example.</small>
                    </div>
                  ) : (
                    <p className="kx-fb-loading">Reading…</p>
                  )
                ) : (
                  <TextEditor value={formula} analysis={analysis} catalog={catalog} onChange={setFormula} areaRef={area} />
                )}
                {problems}
                {mode === "text" && !problem && <Hint help="formula.text" />}
              </section>
              <section className="kx-fb-preview" aria-label="Preview">
                <header>
                  <h4>Preview on your sources</h4>
                  {analysis?.ok && (
                    <span className="kx-fb-type" data-type={resultType}>
                      {TYPE_LABEL[resultType] ?? "Mixed"}
                    </span>
                  )}
                  <span className="kx-spacer" />
                  {displays.length > 1 && (
                    <SegmentedTabs label="Show as" size="small" className="kx-fb-shows" value={shownDisplay} onChange={setDisplay} tabs={displays.map((d) => ({ id: d.id, label: d.label }))} />
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
            </>
          )}
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

const TYPE_LABEL: Record<string, string> = { number: "Number", text: "Text", boolean: "Yes / no", date: "Date", list: "List", select: "Label", any: "Any", item: "Any", branches: "Any" };
