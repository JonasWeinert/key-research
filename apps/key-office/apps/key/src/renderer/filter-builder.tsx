// "Add a filter" by clicking: field → operator → value, for every field a search can filter
// by (the workspace's properties included). It writes the filter as it would be typed
// (`rating>3`) and lets the host read it, so a built filter is the same token as a typed
// one. Below it, the syntax with examples for each field.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useDismiss } from "@key-reader/ui/dismiss";
import { Icon } from "./icons";
import type { Invoke } from "./library-api";
import { DATE_OP_LABEL, GROUP_LABEL, OP_LABEL, typedFilter, useFilterFields, type FieldOp, type FilterField } from "./filter-fields";
import { parseQuery } from "./smart-query";
import type { SearchFilter } from "./search-suggest";
import { Explain } from "./explain";

export default function FilterBuilder({
  invoke,
  workspaceId,
  anchor,
  onAdd,
  onClose,
  onInsert,
}: {
  invoke: Invoke;
  workspaceId: string;
  anchor: RefObject<HTMLElement | null>;
  onAdd: (filters: SearchFilter[]) => void;
  onClose: () => void;
  /** An example clicked in the syntax list goes into the field as text. */
  onInsert: (text: string) => void;
}) {
  const fields = useFilterFields(invoke, workspaceId);
  const [fieldId, setFieldId] = useState("");
  const field = fields.find((f) => f.id === fieldId) ?? fields[0];
  const [op, setOp] = useState<FieldOp>("contains");
  const [value, setValue] = useState("");
  const [value2, setValue2] = useState("");
  const [negate, setNegate] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"build" | "syntax">("build");
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, { refs: [box, anchor], kind: "menu", anchor, onDismiss: onClose });
  // A new field starts with its first operator and no value.
  useEffect(() => {
    if (!field) return;
    setOp(field.ops[0]);
    setValue(field.type === "boolean" ? "yes" : (field.options?.[0]?.value ?? ""));
    setValue2("");
    setError("");
  }, [field?.id]);
  const groups = useMemo(() => {
    const out = new Map<FilterField["group"], FilterField[]>();
    for (const f of fields) out.set(f.group, [...(out.get(f.group) ?? []), f]);
    return [...out.entries()];
  }, [fields]);
  if (!field) return null;
  const needsValue = op !== "empty" && op !== "notEmpty";
  const ready = !needsValue || (value.trim() && (op !== "between" || value2.trim()));
  const typed = ready ? typedFilter(field, op, value, value2, negate) : "";
  const opLabel = (o: FieldOp) => (field.type === "date" && DATE_OP_LABEL[o]) || OP_LABEL[o];
  const add = async () => {
    if (!typed) return;
    const read = await parseQuery(invoke, workspaceId, typed, false).catch(() => []);
    const found = read[0];
    if (!found?.filters.length || found.rest.trim()) {
      setError(`Key could not read “${typed}” as a filter`);
      return;
    }
    onAdd(found.filters);
    onClose();
  };
  const input = (v: string, set: (v: string) => void, label: string) =>
    field.type === "boolean" ? (
      <select className="kui-select" aria-label={label} value={v} onChange={(e) => set(e.target.value)}>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    ) : field.options?.length && op === "is" ? (
      <select className="kui-select" aria-label={label} value={v} onChange={(e) => set(e.target.value)}>
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ) : (
      <input
        className="kui-input"
        aria-label={label}
        type={field.type === "number" ? "number" : "text"}
        placeholder={field.type === "date" ? "2026-01-01 or last week" : field.type === "relation" ? "@citekey, DOI or title" : "Value"}
        value={v}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void add())}
      />
    );
  return (
    <div ref={box} className="kx-menu-popover kx-filter-builder" role="dialog" aria-label="Add a filter" onMouseDown={(e) => e.stopPropagation()}>
      <div className="kx-segmented kx-filter-builder-tabs" role="group" aria-label="Filter builder">
        <button type="button" aria-pressed={tab === "build"} onClick={() => setTab("build")}>
          Add a filter
        </button>
        <button type="button" aria-pressed={tab === "syntax"} onClick={() => setTab("syntax")}>
          Typing filters
        </button>
      </div>
      {tab === "build" ? (
        <>
          <div className="kx-filter-builder-row">
            <select className="kui-select" aria-label="Field" value={field.id} onChange={(e) => setFieldId(e.target.value)}>
              {groups.map(([group, list]) => (
                <optgroup key={group} label={GROUP_LABEL[group]}>
                  {list.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <select className="kui-select" aria-label="Operator" value={op} onChange={(e) => setOp(e.target.value as FieldOp)}>
              {field.ops.map((o) => (
                <option key={o} value={o}>
                  {opLabel(o)}
                </option>
              ))}
            </select>
          </div>
          {needsValue && (
            <div className="kx-filter-builder-row">
              {input(value, setValue, "Value")}
              {op === "between" && (
                <>
                  <span className="kx-filter-builder-and">and</span>
                  {input(value2, setValue2, "Second value")}
                </>
              )}
            </div>
          )}
          <p className="kx-filter-builder-help">{field.help}</p>
          <div className="kx-filter-builder-foot">
            <label className="kx-filter-builder-not">
              <input type="checkbox" checked={negate} onChange={(e) => setNegate(e.target.checked)} /> Exclude matches
            </label>
            {typed && (
              <code className="kx-filter-builder-typed" title="The same filter, typed">
                {typed}
              </code>
            )}
            <button type="button" className="kui-button" data-variant="primary" disabled={!ready} onClick={() => void add()}>
              Add filter
            </button>
          </div>
          {error && (
            <p className="kx-filter-builder-error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <div className="kx-filter-syntax">
          <p className="kx-filter-builder-help">
            <Explain help="search.filters" />{" "}
            Type <code>field:value</code> in any search field. Key shows what it read as a filter; pick it, or press ⇥ in the search window, to apply it.
          </p>
          <dl className="kx-filter-syntax-rules">
            <div>
              <dt>rating&gt;3 · year:2015..2020</dt>
              <dd>Compare numbers, or give a range</dd>
            </div>
            <div>
              <dt>added:last-week · read&lt;2026-01-01</dt>
              <dd>Dates, or today, this month, 30d …</dd>
            </div>
            <div>
              <dt>-tag:draft · not status:read</dt>
              <dd>Leave out what matches</dd>
            </div>
            <div>
              <dt>tag:a|b · oa:gold OR oa:green</dt>
              <dd>Either one</dd>
            </div>
            <div>
              <dt>abstract:empty · doi:any</dt>
              <dd>Is empty, is not empty</dd>
            </div>
            <div>
              <dt>has:pdf · is:starred · no:doi</dt>
              <dd>Shortcuts</dd>
            </div>
            <div>
              <dt>"reading status":done</dt>
              <dd>Quote names with spaces</dd>
            </div>
          </dl>
          {groups.map(([group, list]) => (
            <section key={group}>
              <h3>{GROUP_LABEL[group]}</h3>
              <div className="kx-filter-syntax-examples">
                {list.flatMap((f) =>
                  f.examples.slice(0, 2).map((example) => (
                    <button key={`${f.id}:${example}`} type="button" title={`${f.label}: ${f.help}`} onClick={() => (onInsert(example), onClose())}>
                      {example}
                    </button>
                  )),
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** The field's "filter" button that opens the builder. */
export function FilterBuilderButton({ open, onClick, buttonRef }: { open: boolean; onClick: () => void; buttonRef: RefObject<HTMLButtonElement | null> }) {
  return (
    <button ref={buttonRef} type="button" className="kx-search-build" aria-label="Add a filter" title="Add a filter, and how to type filters" aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon name="filter" size={12} />
    </button>
  );
}
