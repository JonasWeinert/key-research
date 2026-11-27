// The review host commands (crates/key-desktop-host/src/review_commands.rs), typed. All logic is
// in Rust (crates/key-review); this file only names the calls and their shapes.
import type { Invoke } from "../library-api";

export type Stage = "ta" | "ft";
export type Choice = "include" | "exclude" | "maybe";

export interface StageRule {
  reviewers: number;
  reasons: "none" | "one" | "all";
  maybe: boolean;
}
export interface Rules {
  ta: StageRule;
  ft: StageRule;
  blind: boolean;
  conflicts: "consensus" | "third";
  quoteRequired: boolean;
  extractors: number;
  aiAssist: boolean;
  suggestions: boolean;
}
export interface Condition {
  field: string;
  op: string;
  value: unknown;
}
export interface MetadataLink {
  conditions: Condition[];
  all: boolean;
  effect: "suggest" | "auto";
}
export interface Criterion {
  id: string;
  kind: "include" | "exclude";
  label: string;
  guidance: string;
  stages: Stage[];
  reasonId?: string | null;
  link?: MetadataLink | null;
}
export interface Reason {
  id: string;
  label: string;
  guidance: string;
  stages: Stage[];
}
export interface Field {
  id: string;
  label: string;
  kind: "text" | "longtext" | "number" | "choice" | "multi" | "date" | "yesno" | "table";
  guidance: string;
  required: boolean;
  quote: boolean;
  options: string[];
  unit: string;
  columns: Field[];
  role: string;
}
export interface Section {
  id: string;
  title: string;
  guidance: string;
  fields: Field[];
}
export interface Form {
  id: string;
  name: string;
  kind: string;
  sections: Section[];
}
export interface Protocol {
  question: { framework: string; parts: Record<string, string>; text: string };
  registration: string;
  notes: string;
  rules: Rules;
  criteria: Criterion[];
  reasons: Reason[];
  keywords: { include: string[]; exclude: string[] };
  labels: string[];
  forms: Form[];
  shortcuts: Record<string, string>;
}
export interface Member {
  id: string;
  name: string;
  roles: string[];
  initials: string;
}
export interface Batch {
  id: string;
  kind: "file" | "library" | "database" | "other";
  group: "databases" | "registers" | "other";
  name: string;
  fileName: string;
  strategy: string;
  searchedAt: string;
  count: number;
  perSource: Record<string, number>;
  dbRunId: string;
  duplicatesRemoved: number;
  note: string;
  at: number;
  actor: string;
}
export interface StageCounts {
  eligible: number;
  done: number;
  mine: number;
  flagged: number;
  awaiting: number;
  undecided: number;
  partial: number;
  conflicts: number;
  included: number;
  excluded: number;
  maybe: number;
  notRetrieved: number;
}
export interface Agreement {
  n: number;
  percent: number | null;
  kappa: number | null;
  method: string;
  band: string;
}
export interface AgreementReport {
  overall: Agreement;
  pairs: { a: string; b: string; aName: string; bName: string; agreement: Agreement }[];
  disagreements: string[];
  records: number;
}
export interface Pilot {
  id: string;
  name: string;
  stage: Stage;
  records: string[];
  reviewers: string[];
  open: boolean;
  seed: number;
  at: number;
}
export interface Summary {
  review: { id: string; name: string; createdAt: number; createdBy: string; archived: boolean; updatedAt: number };
  protocol: Protocol;
  version: string;
  versionNumber: number;
  versionHasDecisions: boolean;
  versions: { id: string; number: number; at: number; actor: string; actorName: string; note: string; decisions: number }[];
  team: Member[];
  viewer: Member | null;
  canResolve: boolean;
  batches: { batch: Batch; records: number; duplicates: number; removed: boolean; actorName: string }[];
  records: number;
  active: number;
  duplicates: number;
  openPairs: number;
  stages: { ta: StageCounts; ft: StageCounts };
  included: number;
  extraction: { studies: number; started: number; mine: number };
  pilots: { pilot: Pilot; done: number; agreement: AgreementReport }[];
  assignments: { stage: Stage; assignment: { mode: string; reviewers: { id: string; share: number }[]; double: number; at: number } | null; counts: Record<string, number> }[];
  analyses: unknown[];
  events: number;
  labelsInUse: string[];
}
export interface RecordMeta {
  id: string;
  title: string;
  abstractText?: string;
  authors: string[];
  year?: number | null;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  pmid?: string;
  url?: string;
  itemType?: string;
  language?: string;
  keywords?: string[];
  sourceId?: string | null;
  extra?: Record<string, unknown>;
}
export interface StatusInfo {
  state: string;
  name: "notEligible" | "notRetrieved" | "undecided" | "partial" | "conflict" | "included" | "excluded" | "maybe";
  have?: number;
  need?: number;
  value?: Choice;
  resolved?: boolean;
  auto?: boolean;
}
export interface DecisionInfo {
  event: string;
  at: number;
  reviewer: string;
  reviewerName: string;
  value: Choice;
  reasons: string[];
  note: string;
  version: string;
  versionNumber: number | null;
  evidence: Evidence[];
  auto?: string;
}
export interface Evidence {
  quote: string;
  page?: number | null;
  annotationId?: string;
}
export interface Suggestion {
  criterionId: string;
  label: string;
  value: Choice;
  reasonId?: string | null;
  rule: string;
  auto: boolean;
}
export interface RecordView {
  meta: RecordMeta;
  batch: { id: string; name: string; kind: string; group: string } | null;
  status: StatusInfo;
  statuses: { ta: StatusInfo; ft: StatusInfo };
  mine: DecisionInfo | null;
  others: DecisionInfo[];
  unblinded: boolean;
  needed: number;
  resolution: DecisionInfo | null;
  earlier: { resolution: DecisionInfo | null; decisions: DecisionInfo[]; mine: DecisionInfo | null } | null;
  notes: { id: string; event: string; reviewer: string; at: number; text: string }[];
  labels: string[];
  fulltext: { status: string; reason: string; sourceId: string | null; at: number };
  sourceId: string | null;
  flagged: boolean;
  suggestions: Suggestion[];
  checks: { criterionId: string; label: string; met: boolean | null; rule: string }[];
  ai: { value: Choice; rationale: string; score: number | null; model: string; at: number } | null;
  pilot: { id: string; name: string; open: boolean } | null;
  assigned: { id: string; name: string }[];
  duplicateOf: string | null;
}
export interface ListRow {
  id: string;
  title: string;
  byline: string;
  journal: string;
  year: number | null;
  hasAbstract: boolean;
  status: StatusInfo;
  mine: Choice | null;
  others: { value: Choice; reviewerName: string }[];
  count: number;
  needed: number;
  reasons: string[];
  labels: string[];
  flagged: boolean;
  fulltext: string;
  sourceId: string | null;
  suggestion: Suggestion | null;
  ai: { value: Choice; score: number | null } | null;
  duplicateOf: string | null;
  batch: string;
}
export interface ListQuery {
  stage: Stage;
  filter?: string;
  text?: string;
  label?: string;
  batch?: string;
  reason?: string;
  sort?: string;
  offset?: number;
  limit?: number;
}
export interface ImportReport {
  batchId: string;
  added: number;
  duplicates: number;
  possibleDuplicates: number;
  autoExcluded: number;
}
export interface Named {
  name: string;
  count: number;
}
export interface PrismaColumn {
  identified: number;
  sought: number;
  notRetrieved: number;
  assessed: number;
  excluded: number;
  excludedReasons: Named[];
  included: number;
  pending: number;
}
export interface Prisma {
  databases: Named[];
  registers: Named[];
  otherMethods: Named[];
  identified: number;
  duplicates: number;
  automation: number;
  removedOther: number;
  screened: number;
  screeningExcluded: number;
  screeningPending: number;
  main: PrismaColumn;
  other: PrismaColumn;
  studiesIncluded: number;
  reportsIncluded: number;
}
export interface Extracted {
  event: string;
  at: number;
  reviewer: string;
  value: unknown;
  quote: string;
  page: number | null;
  sourceId: string | null;
  suggested: boolean;
}
export interface ExtractionView {
  forms: Form[];
  values: Record<string, { mine: Extracted | null; others: { reviewer: string; reviewerName: string; value: unknown; quote: string; page: number | null }[]; othersCount: number; final: Extracted | null; differs: boolean }>;
  extractors: number;
}
export interface StudyRow {
  id: string;
  title: string;
  byline: string;
  sourceId: string | null;
  mine: number;
  fields: number;
  extractors: number;
  conflicts: number;
  missingRequired: number;
}
export interface Pooled {
  estimate: number;
  se: number;
  lower: number;
  upper: number;
  statistic: number;
  p: number;
  tau2: number;
  tau: number;
  q: number;
  df: number;
  qP: number;
  i2: number;
  h2: number;
  piLower: number | null;
  piUpper: number | null;
  k: number;
  method: "fe" | "dl" | "reml";
  hartungKnapp: boolean;
}
export interface Analysis {
  measure: string;
  measureLabel: string;
  ratio: boolean;
  studies: { id: string; label: string; yi: number; vi: number; lower: number; upper: number; weight: number; subgroup: string | null }[];
  skipped: [string, string][];
  fixed: Pooled;
  random: Pooled | null;
  main: Pooled;
  subgroups: { name: string; pooled: Pooled; studies: string[] }[];
  subgroupTest: { q: number; df: number; p: number } | null;
  leaveOneOut: { id: string; label: string; estimate: number; lower: number; upper: number; tau2: number; i2: number }[];
  egger: { t: number; df: number; p: number; limit: number } | null;
}
export interface ExportFile {
  filename: string;
  content: string;
  mime: string;
}

/** Calls bound to one workspace and review. */
export function reviewApi(invoke: Invoke, workspaceId: string, reviewId: string) {
  const call = <T>(command: string, args: Record<string, unknown> = {}) => invoke<T>(command, { reviewId, ...args }, workspaceId);
  return {
    summary: (viewer: string) => call<Summary>("review_get", { viewer }),
    rename: (name: string, actor: string) => call("review_rename", { name, actor }),
    archive: (archived: boolean, actor: string) => call("review_archive", { archived, actor }),
    remove: () => call("review_delete"),
    saveTeam: (members: Member[], actor: string) => call("review_team_save", { members, actor }),
    impact: (protocol: Protocol) => call<{ newVersion: boolean; ta: number; ft: number; basis: string }>("review_protocol_impact", { protocol }),
    saveProtocol: (protocol: Protocol, note: string, actor: string, rescreen: boolean) =>
      call<{ version: string; number: number; newVersion: boolean; flagged: number; autoApplied: number }>("review_protocol_save", { protocol, note, actor, rescreen }),
    readTemplate: (text: string) => call<Protocol>("review_template_read", { text }),
    formTemplates: () => call<Form[]>("review_form_templates"),
    previewFile: (text: string, fileName: string) => call<{ format: string; count: number; sample: { title: string; byline: string }[]; warnings: number }>("review_preview_file", { text, fileName }),
    importFile: (text: string, fileName: string, batch: Partial<Batch>, actor: string) => call<{ report: ImportReport; format: string; warnings: string[] }>("review_import_file", { text, fileName, batch, actor }),
    importLibrary: (args: { ids?: string[]; query?: Record<string, unknown> }, batch: Partial<Batch>, actor: string) => call<{ report: ImportReport }>("review_import_library", { ...args, batch, actor }),
    dbRuns: () => call<{ runId: string; label: string; startedAt: number; finishedAt?: number; state: string; total: number; fetched?: number; perConnector?: Record<string, number> }[]>("review_db_runs", { limit: 20 }),
    importDbRun: (runId: string, batch: Partial<Batch>, actor: string) => call<{ report: ImportReport }>("review_import_db_run", { runId, batch, actor }),
    importRecords: (records: Partial<RecordMeta>[], batch: Partial<Batch>, actor: string) => call<{ report: ImportReport }>("review_import_records", { records, batch, actor }),
    removeBatch: (batchId: string, actor: string) => call("review_batch_remove", { batchId, actor }),
    pairs: (offset = 0, limit = 50) => call<{ pairs: { a: RecordMeta | null; b: RecordMeta | null; score: number; reason: string }[]; total: number }>("review_pairs", { offset, limit }),
    resolvePair: (a: string, b: string, choice: "duplicate" | "distinct" | "restore", keep: string | undefined, actor: string) => call("review_pair_resolve", { a, b, choice, keep, actor }),
    records: (query: ListQuery, viewer: string) => call<{ rows: ListRow[]; total: number; offset: number }>("review_records", { query, viewer }),
    queue: (stage: Stage, viewer: string, filter = "") => call<string[]>("review_queue", { stage, viewer, filter }),
    record: (recordId: string, stage: Stage, viewer: string) => call<RecordView>("review_record", { recordId, stage, viewer }),
    decide: (recordIds: string[], stage: Stage, value: Choice, reasons: string[], note: string, actor: string, evidence: Evidence[] = []) =>
      call<string[]>("review_decide", { recordIds, stage, value, reasons, note, evidence, actor }),
    undo: (actor: string) => call<{ recordId: string; stage: Stage } | null>("review_undo", { actor }),
    retract: (recordId: string, eventId: string, actor: string) => call("review_retract", { recordId, eventId, actor }),
    resolve: (recordId: string, stage: Stage, value: Choice, reasons: string[], note: string, actor: string) => call("review_resolve", { recordId, stage, value, reasons, note, actor }),
    reopen: (recordId: string, stage: Stage, actor: string) => call("review_reopen", { recordId, stage, actor }),
    note: (recordId: string, text: string, actor: string, noteId?: string) => call("review_note", { recordId, text, noteId, actor }),
    labels: (recordIds: string[], add: string[], remove: string[], actor: string) => call("review_labels", { recordIds, add, remove, actor }),
    clearFlags: (recordIds: string[], stage: Stage, actor: string) => call("review_flags_clear", { recordIds, stage, actor }),
    fulltext: (recordId: string, change: { status?: string; reason?: string; sourceId?: string | null }, actor: string) => call("review_fulltext", { recordId, ...change, actor }),
    linkLibrary: (recordIds: string[], actor: string) => call<Record<string, string>>("review_link_library", { recordIds, actor }),
    pilotCreate: (stage: Stage, size: number, reviewers: string[], name: string, actor: string) => call<Pilot>("review_pilot_create", { stage, size, reviewers, name, actor }),
    pilotSet: (pilotId: string, open: boolean, actor: string) => call("review_pilot_set", { pilotId, open, actor }),
    assign: (stage: Stage, mode: "everyone" | "split", reviewers: { id: string; share: number }[], double: number, actor: string) => call("review_assign", { stage, mode, reviewers, double, actor }),
    agreement: (stage: Stage, pilotId?: string) => call<AgreementReport>("review_agreement", { stage, pilotId }),
    prisma: () => call<Prisma>("review_prisma"),
    studies: (viewer: string) => call<{ studies: StudyRow[] }>("review_studies", { viewer }),
    extraction: (recordId: string, viewer: string) => call<ExtractionView>("review_extraction", { recordId, viewer }),
    extract: (recordId: string, formId: string, fieldId: string, value: unknown, extra: { quote?: string; page?: number | null; sourceId?: string | null; suggested?: boolean; final?: boolean }, actor: string) =>
      call("review_extract", { recordId, formId, fieldId, value, ...extra, actor }),
    outcomes: () => call<{ outcome: string; timepoint: string; kind: string; studies: number }[]>("review_outcomes"),
    analyse: (request: { outcome: string; timepoint?: string; options: { measure: string; method: string; hartungKnapp: boolean; level: number }; subgroups: boolean }) =>
      call<{ analysis: Analysis; input: unknown[]; includedStudies: number }>("review_analyse", { request }),
    exportFile: (kind: string, viewer: string) => call<ExportFile>("review_export", { kind, viewer }),
    audit: (offset = 0, limit = 100) => call<{ events: { id: string; at: number; actor: string; actorName: string; kind: string; recordId: string | null; version: number | null; what: string }[]; total: number }>("review_audit", { offset, limit }),
    aiSuggest: (recordId: string, stage: Stage) => invoke<{ value: Choice; score: number | null; rationale: string; model: string }>("review_ai_suggest", { reviewId, recordId, stage }, workspaceId),
  };
}
export type ReviewApi = ReturnType<typeof reviewApi>;

export const listReviews = (invoke: Invoke, workspaceId: string) =>
  invoke<{ id: string; name: string; createdAt: number; updatedAt: number; archived: boolean; records: number; included: number; taDone: number; taEligible: number; ftDone: number; ftEligible: number }[]>("review_list", {}, workspaceId);
export const createReview = (invoke: Invoke, workspaceId: string, name: string, ownerName: string, template?: string) =>
  invoke<{ reviewId: string; actor: string }>("review_create", { name, ownerName, template }, workspaceId);
export const importReviewFile = (invoke: Invoke, workspaceId: string, text: string) => invoke<{ reviewId: string; added: number }>("review_import_review", { text }, workspaceId);

// ── Who is screening (a local profile per review, until sync brings accounts) ─────────────

const viewerKey = (reviewId: string) => `key.review.viewer:${reviewId}`;
export function savedViewer(reviewId: string): string | undefined {
  try {
    return localStorage.getItem(viewerKey(reviewId)) ?? undefined;
  } catch {
    return undefined;
  }
}
export function saveViewer(reviewId: string, id: string) {
  try {
    localStorage.setItem(viewerKey(reviewId), id);
  } catch {}
}

export const STAGE_LABEL: Record<Stage, string> = { ta: "Title & abstract", ft: "Full text" };
export const CHOICE_LABEL: Record<Choice, string> = { include: "Include", exclude: "Exclude", maybe: "Maybe" };
export const STATUS_LABEL: Record<StatusInfo["name"], string> = {
  notEligible: "Not at this stage",
  notRetrieved: "Not retrieved",
  undecided: "Undecided",
  partial: "Needs another reviewer",
  conflict: "Conflict",
  included: "Included",
  excluded: "Excluded",
  maybe: "Maybe",
};
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
