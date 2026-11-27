// Every field a search can filter by, as the host lists them (key-store `field_query.rs`,
// `store_filter_fields`): standard details and the workspace's own properties, with their
// types, operators and examples. The search field completes their names, the filter
// builder offers them, and the syntax sheet shows their examples.
import { useEffect, useState } from "react";
import type { Invoke } from "./library-api";

export type FieldType = "text" | "number" | "date" | "boolean" | "select" | "entity" | "relation";
export type FieldOp = "is" | "contains" | "gt" | "gte" | "lt" | "lte" | "between" | "empty" | "notEmpty";

export interface FilterField {
  /** What is typed before the colon ("rating", "\"Reading status\""). */
  id: string;
  field: string;
  key?: string;
  valueType?: string;
  label: string;
  group: "publication" | "identifiers" | "subjects" | "metrics" | "files" | "library" | "reading" | "relations" | "properties";
  type: FieldType;
  ops: FieldOp[];
  names: string[];
  examples: string[];
  options?: { value: string; label: string }[];
  help: string;
  propertyType?: string;
}

export const GROUP_LABEL: Record<FilterField["group"], string> = {
  publication: "Publication",
  identifiers: "Identifiers",
  subjects: "Topics and people",
  metrics: "Citations and access",
  files: "Files",
  library: "Library",
  reading: "Reading",
  relations: "Related works",
  properties: "Your properties",
};

export const OP_LABEL: Record<FieldOp, string> = {
  contains: "contains",
  is: "is",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  between: "is between",
  empty: "is empty",
  notEmpty: "is not empty",
};
/** Dates read better as before and after. */
export const DATE_OP_LABEL: Partial<Record<FieldOp, string>> = { is: "is in", gt: "is after", gte: "is since", lt: "is before", lte: "is until" };

const cache = new Map<string, { at: number; fields: Promise<FilterField[]> }>();
const listeners = new Set<() => void>();

/** The workspace's fields, cached briefly (properties change rarely). */
export function filterFields(invoke: Invoke, workspaceId: string): Promise<FilterField[]> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < 30_000) return hit.fields;
  const fields = invoke<FilterField[]>("store_filter_fields", {}, workspaceId).catch(() => [] as FilterField[]);
  cache.set(workspaceId, { at: Date.now(), fields });
  return fields;
}
/** A property was defined, renamed or removed. */
export function filterFieldsChanged() {
  cache.clear();
  listeners.forEach((l) => l());
}

export function useFilterFields(invoke: Invoke | undefined, workspaceId: string | undefined): FilterField[] {
  const [fields, setFields] = useState<FilterField[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);
  useEffect(() => {
    if (!invoke || !workspaceId) return;
    let live = true;
    void filterFields(invoke, workspaceId).then((f) => live && setFields(f));
    return () => {
      live = false;
    };
  }, [invoke, workspaceId, version]);
  return fields;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_.\-"]/g, "");

/** Fields whose name or another name starts with `word` (two letters at least). */
export function fieldsStarting(fields: FilterField[], word: string, max = 4): FilterField[] {
  const w = norm(word);
  if (w.length < 2) return [];
  const score = (f: FilterField) => {
    const names = [f.id, f.label, ...f.names].map(norm);
    if (names.some((n) => n === w)) return 0;
    if (names.some((n) => n.startsWith(w))) return 1;
    return -1;
  };
  return fields
    .map((f) => [f, score(f)] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => a[1] - b[1] || (a[0].group === "properties" ? -1 : 0) - (b[0].group === "properties" ? -1 : 0))
    .slice(0, max)
    .map(([f]) => f);
}

/** The field a typed name names ("rating", "\"reading status\"", "author"). */
export function fieldNamed(fields: FilterField[], name: string): FilterField | undefined {
  const n = norm(name);
  return fields.find((f) => f.group === "properties" && norm(f.label) === n) ?? fields.find((f) => [f.id, ...f.names].some((x) => norm(x) === n));
}

const quote = (value: string) => (/^[\p{L}\p{N}_.\-/@]+$/u.test(value) ? value : `"${value.replace(/"/g, "")}"`);

/** The text a filter is typed as: `rating>3`, `"Reading status":Done`, `abstract:empty`. */
export function typedFilter(field: FilterField, op: FieldOp, value: string, value2 = "", negate = false): string {
  const sign: Record<FieldOp, string> = { contains: ":", is: field.type === "text" ? "=" : ":", gt: ">", gte: ">=", lt: "<", lte: "<=", between: ":", empty: ":", notEmpty: ":" };
  const v = op === "empty" ? "empty" : op === "notEmpty" ? "any" : op === "between" ? `${value.trim()}..${value2.trim()}` : quote(value.trim());
  return `${negate ? "-" : ""}${field.id}${sign[op]}${v}`;
}
