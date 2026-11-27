// std-A: typed calls and shapes for the reporting views (PRISMA checklists, the protocol
// document and its registration, the PRISMA-S search report). All of it is computed by the
// host (crates/key-review: checklist.rs, protocol_doc.rs, search_report.rs); this only draws.
import type { Invoke } from "../library-api";

export type ItemStatus = "evidenced" | "partly" | "missing" | "na" | "notRecorded";
export interface ReportLink {
  label: string;
  stage: string;
  view?: string;
}
export interface ChecklistNote {
  list: string;
  item: string;
  location: string;
  text: string;
  at: number;
  actor: string;
}
export interface ChecklistItem {
  list: string;
  id: string;
  section: string;
  topic: string;
  text: string;
  status: ItemStatus;
  rule: string;
  evidence: ReportLink[];
  gap?: { text: string; action: string; link?: ReportLink };
  draft?: string;
  note?: ChecklistNote;
  manuscript: boolean;
}
export interface ChecklistList {
  id: string;
  name: string;
  items: ChecklistItem[];
  counts: Record<ItemStatus, number>;
}
export interface ChecklistView {
  kind: string;
  lists: ChecklistList[];
  methods: string;
  results: string;
  software: string;
  attribution: string;
}

export interface Author {
  name: string;
  affiliation: string;
  email: string;
  contribution: string;
  guarantor: boolean;
  contact: boolean;
}
export interface PlannedOutcome {
  name: string;
  priority: "primary" | "secondary" | string;
  timepoint: string;
  measure: string;
}
export interface Plan {
  reviewType?: string;
  text?: Record<string, string>;
  authors?: Author[];
  outcomes?: PlannedOutcome[];
  subgroups?: string[];
  sensitivity?: string[];
}
export interface Registration {
  registry: string;
  id: string;
  date: string;
  url: string;
  at?: number;
  actor?: string;
  version?: string;
}
export interface ProtocolField {
  id: string;
  item: string;
  section: string;
  label: string;
  guidance: string;
  kind: "text" | "long" | "date" | "authors" | "outcomes" | "analyses" | "registration" | "amendments";
  value: string;
  suggestion: string;
  effective: string;
  fromKey: boolean;
  required: boolean;
  done: boolean;
}
export interface Deviation {
  version: number;
  at: number;
  actor: string;
  reason: string;
  changes: string[];
}
export interface ProtocolDoc {
  reviewType: string;
  reviewTypes: { id: string; label: string }[];
  fields: ProtocolField[];
  completeness: { done: number; required: number; missing: string[] };
  registration: Registration | null;
  locked: boolean;
  deviations: Deviation[];
  stage: { task: string; started: boolean; completed: boolean }[];
  registeredBeforeConduct: boolean | null;
  prospero: { section: string; label: string; value: string; from: string }[];
}

export interface Limit {
  kind: string;
  value: string;
  justification: string;
}
export interface Filter {
  name: string;
  citation: string;
  modified: boolean;
}
export interface SourceRow {
  batchId: string;
  source: string;
  name: string;
  group: string;
  kind: string;
  platform: string;
  coverage: string;
  searched: string;
  strategy: string;
  queries: { n: number; native: string; reported?: number | null; kept?: number | null }[];
  decomposition: string[];
  approximate: string[];
  postFilter: boolean;
  limits: Limit[];
  noLimits: boolean;
  filters: Filter[];
  notes: string;
  searcher: string;
  records: number;
  update: boolean;
  keyRun: boolean;
  connectorVersion: string;
  missing: string[];
}
export interface PeerReview {
  id: string;
  by: string;
  date: string;
  tool: string;
  outcome: string;
  notes: string;
  batchIds: string[];
}
export interface PriorWork {
  id: string;
  citation: string;
  how: string;
}
export interface SearchReport {
  sources: SourceRow[];
  otherMethods: SourceRow[];
  updates: { search: string; at: number; added: number; known: number }[];
  peerReviews: PeerReview[];
  prior: PriorWork[];
  totals: { identified: number; duplicates: number; afterDedup: number; otherMethods: number };
  dedupMethod: string;
  items: ChecklistItem[];
}

export function reportingApi(invoke: Invoke, workspaceId: string, reviewId: string) {
  const call = <T>(command: string, args: Record<string, unknown> = {}) => invoke<T>(command, { reviewId, ...args }, workspaceId);
  return {
    checklist: () => call<ChecklistView>("review_checklist"),
    note: (list: string, item: string, location: string, text: string, actor: string) => call("review_checklist_note", { list, item, location, text, actor }),
    protocolDoc: () => call<ProtocolDoc>("review_protocol_doc"),
    register: (registration: Registration, actor: string) => call("review_protocol_register", { registration, actor }),
    unregister: (actor: string) => call("review_protocol_unregister", { actor }),
    searchReport: () => call<SearchReport>("review_search_report"),
    setSource: (detail: Partial<SourceRow> & { batchId: string; source: string; searchedAt?: string }, actor: string) => call("review_search_source", { detail, actor }),
    setPeerReview: (entry: Partial<PeerReview> & { deleted?: boolean }, actor: string) => call<string>("review_search_peer_review", { entry, actor }),
    setPrior: (entry: Partial<PriorWork> & { deleted?: boolean }, actor: string) => call<string>("review_search_prior", { entry, actor }),
    exportFile: (kind: string) => call<{ filename: string; content: string; mime: string }>("review_report_export", { kind }),
  };
}
export type ReportingApi = ReturnType<typeof reportingApi>;

export const STATUS_TEXT: Record<ItemStatus, string> = { evidenced: "Evidenced", partly: "Partly", missing: "Missing", na: "Not applicable", notRecorded: "Not recorded yet" };
export const STATUS_TONE: Record<ItemStatus, string> = { evidenced: "green", partly: "amber", missing: "red", na: "muted", notRecorded: "info" };

// ── Going to where an item is evidenced ───────────────────────────────────────────

const focusKey = (reviewId: string) => `key.review.focus:${reviewId}`;
/** Asks the stage about to open to show `view` (a Setup section, a Sources view …). */
export function setFocus(reviewId: string, view: string | undefined) {
  try {
    if (view) sessionStorage.setItem(focusKey(reviewId), view);
    else sessionStorage.removeItem(focusKey(reviewId));
  } catch {}
}
/** The view a stage was asked to show, once (it is cleared on reading). */
export function takeFocus<T extends string>(reviewId: string, allowed: readonly T[]): T | undefined {
  try {
    const v = sessionStorage.getItem(focusKey(reviewId));
    if (v && (allowed as readonly string[]).includes(v)) {
      sessionStorage.removeItem(focusKey(reviewId));
      return v as T;
    }
  } catch {}
  return undefined;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
