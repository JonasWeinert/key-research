import { Button, Input, Textarea, Select } from "@key/design-system";
import { GlobalDrawer } from "./GlobalDrawer";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useFormulaPreview, type FormulaEval } from "./formula";
import "./property-tools.css";
import { Icon } from "./icons";
import FormulaBuilder from "./FormulaBuilder";
import { FormulaValue } from "./formula-display";
import type { Invoke } from "./library-api";
export interface PropertyDraft {
  name: string;
  type: string;
  value: string;
  options: string[];
  formula: string;
  /** How a formula's value shows: plain | badge | progress | check | relative. */
  display?: string;
  applyValues: boolean;
}
const types: [string, ReactNode, string, string][] = [
  ["text", <span className="kx-type-glyph">Aa</span>, "Text", "Notes, identifiers and summaries."],
  ["number", <span className="kx-type-glyph">#</span>, "Number", "Ratings, years and measurements."],
  ["boolean", <Icon name="check" size={14} />, "Checkbox", "A simple true or false value."],
  ["select", <Icon name="list" size={14} />, "Select", "One choice from a consistent set of options."],
  ["multiselect", <Icon name="tag" size={14} />, "Multiple", "Any number of choices from a set of options."],
  ["date", <Icon name="clock" size={14} />, "Date", "A day, such as a deadline or when you read it."],
  ["formula", <Icon name="function" size={14} />, "Formula", "Worked out from other fields: counts, dates, labels and more."],
];
export default function PropertyEditor({
  initial,
  editing,
  busy,
  error,
  targetCount,
  properties,
  evaluate,
  previewTitle,
  onClose,
  onSave,
  allowAgent = true,
  targetLabel = "source",
  agentContent,
  onBack,
  invoke,
  workspaceId,
  sampleIds,
}: {
  /** With these, the formula builder can open (it asks the host directly). */
  invoke?: Invoke;
  workspaceId?: string;
  sampleIds?: string[];
  agentContent?: ReactNode;
  onBack?: () => void;
  allowAgent?: boolean;
  targetLabel?: string;
  initial: PropertyDraft;
  editing: boolean;
  busy: boolean;
  error?: string;
  targetCount: number;
  properties: Record<string, unknown>;
  /** Evaluates a formula for the preview (the host does the work). */
  evaluate?: FormulaEval;
  previewTitle?: string;
  onClose: () => void;
  onSave: (draft: PropertyDraft, agent: boolean) => void;
}) {
  const reduce = useReducedMotion();
  const retainedAgent = useRef<ReactNode>(null);
  if (agentContent) retainedAgent.current = agentContent;
  const [draft, setDraft] = useState(initial),
    [option, setOption] = useState("");
  // A new formula property opens straight into the builder.
  const [building, setBuilding] = useState(!!invoke && initial.type === "formula" && !initial.formula.trim());
  const ref = useRef<HTMLFormElement>(null);
  const set = (patch: Partial<PropertyDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));
  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    ref.current
      ?.querySelector<HTMLElement>(
        "input:not(:disabled),textarea:not(:disabled),button:not(:disabled)",
      )
      ?.focus();
    return () => before?.focus();
  }, []);
  const result = useFormulaPreview(draft.type === "formula" ? evaluate : undefined, draft.formula, properties);
  const formulaError = result?.error ?? "";
  const preview = result && !result.error ? result.text || "Empty" : "";
  const addOption = () => {
    const v = option.trim();
    if (v && !draft.options.includes(v))
      set({ options: [...draft.options, v] });
    setOption("");
  };
  const valid =
    !!draft.name.trim() &&
    (!["select", "multiselect"].includes(draft.type) || draft.options.length > 0) &&
    (draft.type !== "formula" || !!draft.formula.trim());
  if (building && invoke)
    return (
      <GlobalDrawer onClose={() => setBuilding(false)} busy={busy} presentation="window" label="Formula builder">
        <FormulaBuilder
          invoke={invoke}
          workspaceId={workspaceId}
          name={draft.name.trim() || undefined}
          formula={draft.formula}
          display={draft.display}
          sampleIds={sampleIds}
          onCancel={() => setBuilding(false)}
          onDone={(formula, display) => {
            set({ formula, display });
            setBuilding(false);
          }}
        />
      </GlobalDrawer>
    );
  return (
    <GlobalDrawer onClose={onClose} busy={busy} presentation="sheet">
      <div className="key-drawer-slides">
        <motion.div
          className="key-drawer-slide"
          inert={!!agentContent}
          animate={{
            x: agentContent ? "-25%" : "0%",
            opacity: agentContent ? 0 : 1,
          }}
          transition={
            reduce
              ? { duration: 0 }
              : { type: "spring", stiffness: 420, damping: 40, mass: 0.5 }
          }
        >
          <form
            ref={ref}
            className="key-property-editor"
            role="dialog"
            aria-modal="true"
            aria-label={editing ? "Edit property" : "New property"}
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) onSave(draft, false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) {
                e.stopPropagation();
                onClose();
              }
              if (e.key === "Tab") {
                const controls = Array.from(
                  ref.current?.querySelectorAll<HTMLElement>(
                    'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
                  ) || [],
                );
                const first = controls[0],
                  last = controls.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <header>
              <h2>{editing ? "Edit Property" : "New Property"}</h2>
              <p>
                {editing
                  ? "Changes apply to this property across the workspace."
                  : "Add a typed field to every item in this workspace."}
              </p>
              <button
                type="button"
                className="kx-sheet-close"
                aria-label="Close property editor"
                disabled={busy}
                onClick={onClose}
              >
                <Icon name="close" size={12} />
              </button>
            </header>
            <div className="key-property-body">
              <div className="kx-form-group">
                <label className="kx-form-row">
                  <span>Property name</span>
                  <Input
                    required
                    maxLength={128}
                    value={draft.name}
                    disabled={busy}
                    placeholder="Reading status"
                    onChange={(e) => set({ name: e.target.value })}
                  />
                </label>
              </div>
              {editing && (
                <small className="kx-form-note">
                  Renaming keeps existing values and updates formula references.
                </small>
              )}
              <fieldset disabled={busy} className="kx-form-section">
                <legend>Type</legend>
                <div className="key-property-types" role="group" aria-label="Property type">
                  {types.map(([id, icon, label, hint]) => (
                    <button
                      type="button"
                      key={id}
                      aria-pressed={draft.type === id}
                      title={hint}
                      onClick={() => {
                        set({
                          type: id,
                          value: id === "boolean" ? "false" : "",
                        });
                        if (id === "formula" && invoke && !draft.formula.trim()) setBuilding(true);
                      }}
                    >
                      {icon}
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                <small className="kx-form-note">
                  {types.find(([id]) => id === draft.type)?.[3]}
                </small>
              </fieldset>
              {(draft.type === "select" || draft.type === "multiselect") && (
                <section className="kx-form-section">
                  <h3>Options</h3>
                  <div className="kx-form-group key-property-options">
                    {draft.options.map((value, i) => (
                      <div className="kx-option-row" key={value}>
                        <span className="kx-option-dot" data-color={i % 5} />
                        <span>{value}</span>
                        <button
                          type="button"
                          aria-label={`Remove option ${value}`}
                          title="Remove option"
                          onClick={() =>
                            set({
                              options: draft.options.filter((v) => v !== value),
                              value: draft.value === value ? "" : draft.value,
                            })
                          }
                        >
                          <Icon name="close" size={11} />
                        </button>
                      </div>
                    ))}
                    <div className="kx-option-row key-property-option-entry">
                      <Icon name="plus" size={13} />
                      <input
                        aria-label="New option"
                        value={option}
                        placeholder="Add an option…"
                        onChange={(e) => setOption(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addOption();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="kx-option-add"
                        disabled={!option.trim()}
                        onClick={addOption}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </section>
              )}
              {draft.type === "formula" && invoke && (
                <section className="kx-form-section">
                  <h3>Formula</h3>
                  <div className="kx-form-group kx-formula">
                    <button type="button" className="key-formula-summary" aria-label="Edit formula" onClick={() => setBuilding(true)}>
                      <Icon name="function" size={14} />
                      <code>{draft.formula || "No formula yet"}</code>
                      <span>Edit…</span>
                    </button>
                    <div className="key-property-preview" role="status" data-state={formulaError ? "error" : preview ? "ok" : "empty"}>
                      <small>{previewTitle ? `Result for ${previewTitle}` : "Result"}</small>
                      <strong>{formulaError || (result && !result.error ? <FormulaValue value={result.value} display={draft.display} resultType={result.type} /> : "—")}</strong>
                    </div>
                  </div>
                </section>
              )}
              {draft.type === "formula" && !invoke && (
                <section className="kx-form-section">
                  <h3>Formula</h3>
                  <div className="kx-form-group kx-formula">
                    <Textarea
                      aria-label="Formula"
                      required
                      spellCheck={false}
                      value={draft.formula}
                      placeholder="if({Pages} > 20, 'Long read', 'Short read')"
                      onChange={(e) => set({ formula: e.target.value })}
                    />
                    {Object.keys(properties).length > 0 && (
                      <div className="key-property-references">
                        <small>Insert</small>
                        {Object.keys(properties)
                          .slice(0, 24)
                          .map((name) => (
                            <button
                              type="button"
                              key={name}
                              onClick={() =>
                                set({ formula: draft.formula + `{${name}}` })
                              }
                            >
                              {name}
                            </button>
                          ))}
                      </div>
                    )}
                    <div
                      className="key-property-preview"
                      role="status"
                      data-state={formulaError ? "error" : preview ? "ok" : "empty"}
                    >
                      <small>
                        {previewTitle ? `Result for ${previewTitle}` : "Result with empty values"}
                      </small>
                      <strong>
                        {formulaError || preview || "—"}
                      </strong>
                    </div>
                  </div>
                  <details className="kx-form-details">
                    <summary>Supported functions and storage</summary>
                    <p>
                      Use arithmetic, comparisons, [property] or {"{Property}"},
                      and if, concat, upper, lower, length, round, contains,
                      coalesce. Use if(condition, yes, no); ternary syntax,
                      relations and rollups are unsupported. Arguments are
                      evaluated eagerly.
                    </p>
                    <p>
                      Cells calculate locally. Applying to selected sources
                      stores the results for search filters. Stored values do
                      not automatically update when dependencies change.
                    </p>
                  </details>
                </section>
              )}
              <section className="kx-form-section key-property-apply">
                <div className="kx-form-group">
                  <label className="kx-form-row kx-switch-row">
                    <span>
                      {draft.type === "formula" ? "Recompute stored results" : "Set a value"}{" "}
                      on {targetCount} selected{" "}
                      {targetCount === 1 ? targetLabel : `${targetLabel}s`}
                    </span>
                    <input
                      type="checkbox"
                      className="kx-switch"
                      checked={draft.applyValues}
                      disabled={!targetCount || busy}
                      onChange={(e) => set({ applyValues: e.target.checked })}
                    />
                  </label>
                  {draft.applyValues &&
                    targetCount > 0 &&
                    !["formula", "multiselect"].includes(draft.type) && (
                      <label className="kx-form-row">
                        <span>Value</span>
                        {draft.type === "select" ? (
                          <Select
                            aria-label="Value"
                            required
                            value={draft.value}
                            onChange={(e) => set({ value: e.target.value })}
                          >
                            <option value="">Choose…</option>
                            {draft.options.map((v) => (
                              <option key={v}>{v}</option>
                            ))}
                          </Select>
                        ) : draft.type === "boolean" ? (
                          <Select
                            aria-label="Value"
                            value={draft.value}
                            onChange={(e) => set({ value: e.target.value })}
                          >
                            <option value="false">Unchecked</option>
                            <option value="true">Checked</option>
                          </Select>
                        ) : (
                          <Input
                            required={draft.type === "number" || draft.type === "date"}
                            type={draft.type === "number" ? "number" : draft.type === "date" ? "date" : "text"}
                            step="any"
                            placeholder={draft.type === "number" ? "0" : "Value"}
                            value={draft.value}
                            onChange={(e) => set({ value: e.target.value })}
                          />
                        )}
                      </label>
                    )}
                </div>
                <small className="kx-form-note">
                  {targetCount
                    ? "Otherwise existing values stay untouched."
                    : "Select items in the table to set a value on them."}
                </small>
              </section>
              {error && (
                <p role="alert" className="key-property-error">
                  {error}
                </p>
              )}
            </div>
            <footer>
              {allowAgent && (
                <button
                  type="button"
                  className="kx-footer-link"
                  disabled={busy || !valid || draft.type === "formula"}
                  title="Save this property, then configure inputs and review AI proposals"
                  onClick={() => onSave({ ...draft, applyValues: false }, true)}
                >
                  <Icon name="sparkle" size={14} />
                  Configure agent fill…
                </button>
              )}
              <span className="kx-footer-spacer" />
              <Button type="button" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                className="key-property-primary"
                variant="primary"
                disabled={busy || !valid}
              >
                {busy
                  ? "Saving…"
                  : editing
                    ? "Save property"
                    : "Create property"}
              </Button>
            </footer>
          </form>
        </motion.div>
        {retainedAgent.current && (
          <motion.div
            key="agent"
            className="key-drawer-slide"
            inert={!agentContent}
            initial={reduce ? { opacity: 0 } : { x: "100%" }}
            animate={{
              x: agentContent ? 0 : "100%",
              opacity: agentContent ? 1 : 0,
            }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 420, damping: 40, mass: 0.5 }
            }
          >
            <div className="key-agent-drawer-back">
              <button
                type="button"
                aria-label="Back to property"
                onClick={onBack}
              >
                <Icon name="chevronRight" size={14} style={{ transform: "scaleX(-1)" }} />
              </button>
              <strong>Agent settings</strong>
            </div>
            {retainedAgent.current}
          </motion.div>
        )}
      </div>
    </GlobalDrawer>
  );
}
