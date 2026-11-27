// std-B's review host commands (crates/key-desktop-host/src/review_std_b.rs), typed: citation
// searching, AI use and audit, conduct checks, extraction pilots and contacts with authors. All
// logic is in Rust (crates/key-review: chasing.rs, ai_audit.rs, conduct.rs, xpilot.rs).
import type { Invoke } from "../library-api";
import type { ImportReport, Stage } from "./review-api";

export type Direction = "backward" | "forward" | "both";

export interface ChaseRound {
  round: number;
  batchId: string;
  direction: Direction;
  seeds: string[];
  tool: string;
  at: number;
  found: number;
  inReview: number;
  new: number;
  possibleDuplicates: number;
  fallbackSeeds: string[];
  unresolvedSeeds: string[];
  orderedByLinks: boolean;
}
export interface ChaseView {
  included: { id: string; title: string; byline: string; doi: string; chased: boolean }[];
  defaultSeeds: string[];
  rounds: { round: ChaseRound; included: number; screened: number; actorName: string }[];
  hint: string | null;
}
export interface ChaseStatus {
  state: "running" | "done" | "cancelled" | "failed";
  progress: { phase: "seeds" | "references" | "citing" | "done"; done: number; total: number } | null;
  error: string | null;
  preview?: { found: number; inReview: number; new: number; possibleDuplicates: number };
  seeds?: { recordId: string; title: string; work: string | null; via: "doi" | "title" | "fulltext" | "none"; backward: number; forward: number }[];
  candidates?: { title: string; byline: string; year: number | null; doi: string; direction: Direction; links: number; known: boolean }[];
  requests?: number;
  tool?: string;
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  n: number;
  percent: number | null;
  sensitivity: number | null;
  specificity: number | null;
  falseNegativeRate: number | null;
  kappa: number | null;
  band: string;
}
export interface AiLog {
  event: string;
  at: number;
  recordId: string;
  task: "screening" | "extraction";
  stage: Stage | null;
  formId: string;
  fieldId: string;
  provider: string;
  providerName: string;
  model: string;
  modelReported: string;
  promptId: string;
  promptVersion: string;
  promptHash: string;
  requestHash: string;
  scope: string[];
  output: unknown;
  rationale: string;
  score: number | null;
}
export type AiOutcome = "accepted" | "changed" | "rejected" | "pending";
export interface Audit {
  id: string;
  task: "screening" | "extraction";
  stage: Stage | null;
  records: string[];
  population: number;
  target: number;
  percent: number;
  minimum: number;
  open: boolean;
  at: number;
}
export interface AiUse {
  on: boolean;
  suggestions: number;
  outcomes: Partial<Record<AiOutcome, number>>;
  log: { log: AiLog; outcome: AiOutcome }[];
  screening: { stage: Stage; agreement: Confusion; population: number }[];
  extraction: { formId: string; fieldId: string; label: string; n: number; agree: number; percent: number | null }[];
  audits: { audit: Audit; done: number; agreement?: Confusion; percent?: number | null }[];
  defaults: { screening: [number, number]; extraction: [number, number] };
  statement: string | null;
  results: string | null;
  prompts: { id: string; version: string; hash: string; text: string }[];
  models: string[];
}

export interface Warning {
  id: string;
  standard: string;
  title: string;
  message: string;
  fix: string;
  action: string;
  link: string;
  severity: "warn" | "info";
  dismissed?: { reason: string; by: string; at: number };
}
export interface Conduct {
  reviewType: "systematic" | "scoping" | "rapid" | "living";
  warnings: Warning[];
  open: number;
  retractionChecks: { at: number; checked: number; withoutDoi: number; flagged: { recordId: string; doi: string; kind: string }[] }[];
}

export interface FieldPilot {
  formId: string;
  fieldId: string;
  label: string;
  kind: string;
  n: number;
  missing: number;
  percent: number | null;
  kappa: number | null;
  kappaMethod: string;
  icc: number | null;
  meanAbsDiff: number | null;
  band: string;
}
export interface XPilot {
  id: string;
  name: string;
  formIds: string[];
  records: string[];
  extractors: string[];
  open: boolean;
  at: number;
  closedAt: number;
}
export interface XPilots {
  pilots: { pilot: XPilot; done: number; fields: FieldPilot[]; percent: number | null; kappa: number | null; extractorNames: string[]; changedSince: { formId: string; name: string; versions: { number: number; at: number; note: string }[] }[]; studies: { id: string; label: string; title: string }[] }[];
  piloted: { pilotId: string; n: number; at: number; percent: number | null; kappa: number | null }[];
  facts: { statement: string } | null;
  included: number;
}
export interface Contact {
  id?: string;
  recordId: string;
  date: string;
  person: string;
  method: string;
  asked: string;
  reply: string;
  replyDate: string;
  status: "waiting" | "replied" | "noReply" | "";
  dataReceived: boolean;
  deleted?: boolean;
  at?: number;
}

export function conductApi(invoke: Invoke, workspaceId: string, reviewId: string) {
  const call = <T>(command: string, args: Record<string, unknown> = {}) => invoke<T>(command, { reviewId, ...args }, workspaceId);
  return {
    chaseView: () => call<ChaseView>("review_chase_view"),
    chaseStart: (seedIds: string[], direction: Direction) => call<{ jobId: string }>("review_chase_start", { seedIds, direction }),
    chaseStatus: (jobId: string) => call<ChaseStatus>("review_chase_status", { jobId }),
    chaseCancel: (jobId: string) => call("review_chase_cancel", { jobId }),
    chaseImport: (jobId: string, orderByLinks: boolean, actor: string) => call<{ round: ChaseRound; report: ImportReport | null }>("review_chase_import", { jobId, orderByLinks, actor }),
    aiUse: () => call<AiUse>("review_ai_use"),
    auditDraw: (task: "screening" | "extraction", stage: Stage, percent: number, minimum: number, actor: string) => call<Audit>("review_ai_audit_draw", { task, stage, percent, minimum, actor }),
    auditClose: (auditId: string, actor: string) => call("review_ai_audit_close", { auditId, actor }),
    conduct: () => call<Conduct>("review_conduct"),
    dismiss: (check: string, reason: string, dismissed: boolean, actor: string) => call("review_conduct_dismiss", { check, reason, dismissed, actor }),
    retractions: (actor: string) => call<{ checked: number; withoutDoi: number; flagged: { recordId: string; doi: string; kind: string }[] }>("review_conduct_retractions", { actor }),
    xpilots: () => call<XPilots>("review_xpilots"),
    xpilotCreate: (size: number, extractors: string[], formIds: string[], actor: string) => call<XPilot>("review_xpilot_create", { size, extractors, formIds, actor }),
    xpilotClose: (pilotId: string, piloted: boolean, actor: string) => call("review_xpilot_close", { pilotId, piloted, actor }),
    contacts: (recordId?: string) => call<{ contacts: { contact: Contact; study: string; byName: string }[]; facts: { statement: string } | null }>("review_contacts", { recordId }),
    contactSave: (contact: Contact, actor: string) => call<Contact>("review_contact_save", { contact, actor }),
  };
}
export type ConductApi = ReturnType<typeof conductApi>;

export const percent = (x: number | null | undefined, digits = 0) => (x == null ? "–" : `${(x * 100).toFixed(digits)} %`);
export const fixed = (x: number | null | undefined, digits = 2) => (x == null ? "–" : x.toFixed(digits));
