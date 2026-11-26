// Sheets that act on library sources: typed property definitions (create, edit,
// rename, apply), agent fill, the tag manager and adding a reference by identifier.
import { useCallback, useEffect, useState } from "react";
import { AgentPropertyDialog } from "./EntryTools";
import { GlobalDialog } from "./GlobalDrawer";
import { Icon } from "./icons";
import type { Invoke, Source } from "./library-api";
import PropertyEditor, { type PropertyDraft } from "./PropertyEditor";
import { preparePropertyDraft, renamedOptions } from "./property-draft";
import { evaluatePropertyFormula } from "./property-formula";
import TagManagerDialog from "./TagManagerDialog";

export interface PropertyDefinition {
  name: string;
  type: "text" | "number" | "boolean" | "select" | "formula";
  options?: string[];
  formula?: string;
}

/** Workspace property definitions; callers reload them after saves and library changes. */
export function usePropertyDefinitions(invoke: Invoke, workspaceId: string) {
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([]);
  const reload = useCallback(() => {
    void invoke<PropertyDefinition[]>("workspace_attributes", {}, workspaceId).then(setDefinitions).catch(() => setDefinitions([]));
  }, [invoke, workspaceId]);
  useEffect(reload, [reload]);
  return { definitions, reload };
}

/** The key the reader and agent use for a source: its content hash, or its id. */
export const sourceKey = (source: Source) => source.fileHash ?? source.id;

/** Formula inputs for one source: its properties plus the core bibliographic fields. */
export function formulaContext(source: Source) {
  return {
    ...source.properties,
    title: source.title ?? "",
    Title: source.title ?? "",
    year: source.year ?? null,
    Year: source.year ?? null,
    pages: source.pageCount ?? 0,
    Pages: source.pageCount ?? 0,
    authors: source.creators.map((c) => c.literal || [c.given, c.family].filter(Boolean).join(" ")).join("; "),
    journal: source.containerTitle ?? "",
  };
}

export function formulaValue(definition: PropertyDefinition, source: Source): string {
  try {
    const value = evaluatePropertyFormula(definition.formula || "", formulaContext(source));
    return value === null || value === undefined ? "" : String(value);
  } catch (e) {
    return `⚠ ${String(e).replace(/^Error: /, "")}`;
  }
}

export type PropertySheetState =
  | { mode: "new"; targets: Source[] }
  | { mode: "edit"; definition: PropertyDefinition; targets: Source[]; applyValue?: boolean };

/** Create or edit a typed property; optionally apply a value to the target sources. */
export function PropertySheet({
  state,
  invoke,
  workspaceId,
  definitions,
  onClose,
  onSaved,
  onCreated,
}: {
  state: PropertySheetState;
  invoke: Invoke;
  workspaceId: string;
  definitions: PropertyDefinition[];
  onClose: () => void;
  onSaved: () => void;
  /** A new property was defined under this name (pages that are not sources add it to themselves). */
  onCreated?: (name: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [agentFor, setAgentFor] = useState<string>();
  const editing = state.mode === "edit" ? state.definition : undefined;
  const single = state.targets.length === 1 ? state.targets[0] : undefined;
  const initial: PropertyDraft = {
    name: editing?.name ?? "",
    type: editing?.type ?? "text",
    value: editing && single ? String(single.properties[editing.name] ?? "") : "",
    options: editing?.options ?? [],
    formula: editing?.formula ?? "",
    applyValues: state.mode === "new" ? state.targets.length > 0 : !!state.applyValue,
  };
  const save = async (draft: PropertyDraft, configureAgent: boolean) => {
    setError("");
    let prepared: ReturnType<typeof preparePropertyDraft>;
    try {
      prepared = preparePropertyDraft(draft);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
      return;
    }
    const { name, value, config } = prepared;
    if (!editing && definitions.some((d) => d.name === name)) {
      setError("A property with this name already exists. Edit it instead.");
      return;
    }
    setBusy(true);
    try {
      if (editing && editing.name !== name) await invoke("workspace_rename_attribute", { name: editing.name, newName: name }, workspaceId);
      // A choice edited in place is a rename: every source holding it gets the new text.
      if (editing?.type === "select" && draft.type === "select")
        for (const [from, to] of renamedOptions(editing.options ?? [], (config as { options?: string[] }).options ?? []))
          await invoke("store_rename_property_option", { name, from, to }, workspaceId);
      await invoke("workspace_save_attribute", { name, config }, workspaceId);
      if (draft.applyValues) {
        for (const target of state.targets) {
          const next =
            draft.type === "formula"
              ? formulaValue({ name, type: "formula", formula: draft.formula }, target)
              : value;
          await invoke("store_update", { id: target.id, patch: { properties: { [name]: next } }, byHand: true }, workspaceId);
        }
      }
      onSaved();
      if (!editing) onCreated?.(name);
      if (configureAgent) setAgentFor(name);
      else onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PropertyEditor
      initial={initial}
      editing={!!editing}
      busy={busy}
      error={error || undefined}
      targetCount={state.targets.length}
      targetLabel="source"
      properties={single ? formulaContext(single) : {}}
      previewTitle={single?.title}
      onClose={onClose}
      onSave={(draft, agent) => void save(draft, agent)}
      onBack={() => setAgentFor(undefined)}
      agentContent={
        agentFor ? (
          <AgentPropertyDialog
            key={agentFor}
            embedded
            invoke={invoke}
            workspaceId={workspaceId}
            hashes={state.targets.slice(0, 25).map(sourceKey)}
            propertyName={agentFor}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : undefined
      }
    />
  );
}

/** Agent fill for a property across up to 25 sources. */
export function AgentFillSheet({
  invoke,
  workspaceId,
  targets,
  propertyName,
  onClose,
  onSaved,
}: {
  invoke: Invoke;
  workspaceId: string;
  targets: Source[];
  propertyName?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <AgentPropertyDialog
      invoke={invoke}
      workspaceId={workspaceId}
      hashes={targets.slice(0, 25).map(sourceKey)}
      propertyName={propertyName ?? ""}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

export function TagManagerSheet({ invoke, workspaceId, onClose, onSaved }: { invoke: Invoke; workspaceId: string; onClose: () => void; onSaved: () => void }) {
  return <TagManagerDialog invoke={invoke} workspaceId={workspaceId} onClose={onClose} onSaved={onSaved} />;
}

/** Add by identifier lives in identifier-sheet.tsx (many identifiers at once). */
export { IdentifierSheet } from "./identifier-sheet";

