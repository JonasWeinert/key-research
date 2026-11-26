// Types and small helpers for the library's hygiene commands (key-store journal.rs,
// duplicates.rs, refresh.rs and retractions.rs through the host's hygiene.rs): undo and
// redo, batch edits, duplicates and merging, metadata updates and retraction notices.
import { useEffect, useState } from "react";
import type { Invoke, Source } from "./library-api";

export interface JournalEntry {
  seq: number;
  kind: string;
  label: string;
  count: number;
  createdAt: number;
  ids: string[];
}
export interface Operation {
  affected: number;
  entry: JournalEntry | null;
}
export interface BatchEdit {
  patch?: Record<string, unknown>;
  tagsAdd?: string[];
  tagsRemove?: string[];
  collectionsAdd?: string[];
  collectionsRemove?: string[];
}

export type MatchKind = "exact" | "likely" | "version";
export interface DuplicateGroup {
  id: string;
  kind: MatchKind;
  score: number;
  reason: string;
  ids: string[];
  sources: Source[];
}
export interface DuplicateReport {
  groups: DuplicateGroup[];
  count: number;
  exactGroups: number;
  exactRemovable: number;
}
export interface MergeField {
  field: string;
  label: string;
  values: unknown[];
  choice: number;
  edited: boolean[];
}
export interface MergePreview {
  sources: Source[];
  fields: MergeField[];
  tags: string[];
  collections: string[];
  notes: number;
  annotations: number;
  files: number;
  blocked?: string | null;
}

export interface FieldChange {
  field: string;
  label: string;
  old: unknown;
  new: unknown;
  edited: boolean;
  selected: boolean;
}
export interface Published {
  doi: string;
  title?: string | null;
  venue?: string | null;
  year?: number | null;
  sourceId?: string | null;
}
export interface RefreshProposal {
  id: string;
  title: string;
  via?: string | null;
  changes: FieldChange[];
  published?: Published | null;
  error?: string | null;
}

export interface RetractionSummary {
  flagged: number;
  unseen: number;
  checked: number;
  items: { id: string; title: string; kind: string; notice?: string | null; flaggedAt?: number | null; retracted: boolean }[];
}

/** A source flagged as retracted (or under an expression of concern) the user has not dismissed. */
export function retractionOf(source: Pick<Source, "retracted"> & { retractionKind?: string | null; retractionDismissed?: number | null }) {
  if (source.retractionDismissed) return undefined;
  if (source.retracted === 1) return source.retractionKind === "withdrawal" ? "Withdrawn" : "Retracted";
  if (source.retractionKind === "withdrawal") return "Withdrawn";
  if (source.retractionKind === "expression_of_concern") return "Expression of concern";
  return undefined;
}

export const NOTICE_LABEL: Record<string, string> = {
  retraction: "Retraction notice",
  withdrawal: "Withdrawal notice",
  expression_of_concern: "Expression of concern",
  correction: "Correction",
  erratum: "Erratum",
  corrigendum: "Corrigendum",
  partial_retraction: "Partial retraction",
};

/** Undo or redo the latest library operation; answers the toast text ("Undo: Tag 14 sources"). */
export async function stepJournal(invoke: Invoke, workspaceId: string, undo: boolean): Promise<string | undefined> {
  const result = await invoke<{ entry: JournalEntry | null }>(undo ? "store_undo" : "store_redo", {}, workspaceId);
  if (!result.entry) return undo ? "Nothing to undo" : "Nothing to redo";
  return `${undo ? "Undo" : "Redo"}: ${result.entry.label}`;
}

/** A field value as one line of text. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value))
    return value
      .map((c) => {
        const creator = c as { family?: string; given?: string; literal?: string };
        return creator.literal || [creator.given, creator.family].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join("; ");
  return String(value);
}

/** Duplicate and retraction counts for the status bar, polled gently while the library shows. */
export function useHygiene(invoke: Invoke, workspaceId: string, active: boolean, refreshKey: unknown) {
  const [duplicates, setDuplicates] = useState<{ count: number; exactGroups?: number; exactRemovable?: number }>();
  const [retractions, setRetractions] = useState<RetractionSummary>();
  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = () => {
      void invoke<{ count: number }>("store_duplicates_summary", {}, workspaceId).then((d) => live && setDuplicates(d)).catch(() => {});
      void invoke<RetractionSummary>("store_retractions", {}, workspaceId).then((r) => live && setRetractions(r)).catch(() => {});
    };
    load();
    const timer = setInterval(load, 20_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [invoke, workspaceId, active, refreshKey]);
  return { duplicates, retractions, reload: () => void invoke<RetractionSummary>("store_retractions", {}, workspaceId).then(setRetractions).catch(() => {}) };
}
