// Risk of bias and certainty of evidence host commands (key_review::certainty), typed. All logic
// is in Rust; this file only names the calls and their shapes.
import type { Invoke } from "../library-api";
import type { Analysis, Pooled } from "./review-api";

export interface RobOpt {
  id: string;
  label: string;
}
export interface RobLevel {
  id: string;
  label: string;
  tone: "green" | "amber" | "red" | "darkred" | "muted";
  symbol: "plus" | "minus" | "cross" | "excl" | "query";
  common: "low" | "some" | "high" | "critical" | "unclear";
}
export interface RobQuestion {
  id: string;
  text: string;
  help: string;
  options: string;
  weights: Record<string, number>;
  points: Record<string, number>;
  showIf: { question: string; in: string[] } | null;
}
export interface RobDomain {
  id: string;
  short: string;
  name: string;
  prompt: string;
  questions: RobQuestion[];
  rule: { kind: string; map: string[]; thresholds: { min: number; level: string }[] };
  applicability: boolean;
}
export interface RobTool {
  id: string;
  name: string;
  short: string;
  version: string;
  design: string;
  level: "study" | "result";
  url: string;
  about: string;
  licence: string;
  optionSets: Record<string, RobOpt[]>;
  levels: RobLevel[];
  domains: RobDomain[];
  overall: { kind: string; note: string };
  builtin?: boolean;
  inUse?: boolean;
}
export interface RobJudgement {
  value: string;
  reason?: string;
  support?: string;
  by: string;
  at: number;
  event: string;
  toolVersion: string;
  changes: number;
}
export interface RobEvidence {
  id: string;
  domain: string;
  text: string;
  page: number;
  rects: number[][];
  hash: string;
  by?: string;
  at?: number;
}
export interface RobWork {
  answers: Record<string, string>;
  judgements: Record<string, RobJudgement>;
  evidence: RobEvidence[];
  complete: boolean;
}
export type RobProgress = "notStarted" | "inProgress" | "waiting" | "conflict" | "done";
export interface RobAssessment {
  study: string;
  result: string;
  resultLabel: string;
  studyLabel: string;
  title: string;
  hasFullText: boolean;
  tool: RobTool;
  need: number;
  blind: boolean;
  canSeeOthers: boolean;
  canResolve: boolean;
  mine: RobWork;
  suggestions: Record<string, { level: string; why: string } | null>;
  others: { id: string; name: string; complete: boolean; judgements?: Record<string, RobJudgement>; answers?: Record<string, string>; evidence?: RobEvidence[] }[];
  completeCount: number;
  progress: RobProgress;
  agreed: Record<string, string> | null;
  conflicts: string[];
  finals: Record<string, RobJudgement>;
}
export interface RobOverview {
  setup: { assessors: number; blind: boolean; tool: string; explicit: { assessors: number | null; blind: boolean | null; tool: string } };
  tools: { id: string; name: string; short: string; level: string; design: string; builtin: boolean }[];
  studies: {
    id: string;
    label: string;
    title: string;
    tool: string;
    toolShort: string;
    level: string;
    available: string[];
    hasFullText: boolean;
    results: { key: string; label: string; progress: RobProgress; mine: "notStarted" | "inProgress" | "complete"; overall: RobLevel | null; conflicts: string[]; assessors: number }[];
  }[];
  conflicts: { study: string; label: string; result: string; resultLabel: string; domains: string[] }[];
  migratable: number;
  canResolve: boolean;
  totals: { assessments: number; done: number; conflicts: number; mineLeft: number };
}
export interface RobPlots {
  tool: { id: string; name: string; short: string; levels: RobLevel[]; url: string };
  domains: { id: string; short: string; name: string; applicability: boolean }[];
  rows: { study: string; label: string; result: string; cells: Record<string, RobLevel>; done: boolean }[];
  summary: { domain: string; short: string; name: string; n: number; unweighted: { level: string; share: number }[]; weighted: { level: string; share: number }[] | null }[];
  weighted: boolean;
}
export interface AnalysisOptions {
  measure: string;
  method: string;
  hartungKnapp: boolean;
  level: number;
}
export interface RobAnalysis {
  analysis: Analysis;
  input: unknown[];
  includedStudies: number;
  rob: {
    mode: string;
    columns: { id: string; short: string; name: string }[];
    studies: Record<string, { tool: string; overall: RobLevel; cells: Record<string, RobLevel> }>;
    missing: string[];
    excluded: string[];
    all: Pooled;
  };
}

export type DomainJudgement = { judgement: string; footnote: string; suggested?: string | null };
export interface Rating {
  outcome: string;
  timepoint: string;
  label: string;
  importance: number | null;
  analysis: { measure: string; method: string; hartungKnapp: boolean };
  design: "randomised" | "nonRandomised";
  start: "" | "high" | "low";
  domains: Record<string, DomainJudgement>;
  mid: number | null;
  ois: number | null;
  assumedRisk: number | null;
  comment: string;
  statement: string;
}
export interface GradeOutcome {
  key: string;
  label: string;
  rating: Rating;
  stored: boolean;
  kind: string;
  error?: string;
  analysis?: { measure: string; measureLabel: string; ratio: boolean; k: number; estimate: number; lower: number; upper: number; i2: number; tau2: number; piLower: number | null; piUpper: number | null; egger: { p: number } | null };
  participants?: number | null;
  controlRisk?: number | null;
  studyControlRisk?: number | null;
  suggestions?: Record<string, { judgement: string | null; why: string[] }>;
  certainty: { level: string; label: string; explanation: string } | [string, string];
  absolute?: { assumed: number; corresponding: [number, number, number]; difference: [number, number, number] } | null;
  relative?: string | null;
  effectText?: string | null;
  suggestedStatement?: string;
  statement?: string;
  robCoverage?: { assessed: number; total: number };
  history?: { changes: number; by: string; at: number };
}
export interface GradeList {
  outcomes: { key: string; outcome: string; timepoint: string; label: string; kind: string; studies: number; rated: boolean; level: string | null; explanation: string | null; importance: number | null; missingData: boolean }[];
}
export interface Sof {
  rows: {
    key: string;
    outcome: string;
    importance: number | null;
    importanceLabel: string | null;
    studies: number;
    participants: number | null;
    design: string;
    relative: string | null;
    assumed: number | null;
    corresponding: [number, number, number] | null;
    effect: string | null;
    certainty: string;
    certaintyLabel: string;
    symbols: string;
    footnotes: string[];
    statement: string;
    comment: string;
    measure: string;
  }[];
  footnotes: { mark: string; text: string }[];
  review: string;
}

/** Calls bound to one workspace and review. */
export function certaintyApi(invoke: Invoke, workspaceId: string, reviewId: string) {
  const call = <T>(command: string, args: Record<string, unknown> = {}) => invoke<T>(command, { reviewId, ...args }, workspaceId);
  return {
    tools: () => call<{ tools: RobTool[]; shipped: RobTool[]; blank: RobTool }>("review_rob_tools"),
    saveTool: (tool: RobTool, actor: string) => call("review_rob_tool_save", { tool, actor }),
    deleteTool: (toolId: string, actor: string) => call("review_rob_tool_delete", { toolId, actor }),
    setup: (setup: { assessors: number | null; blind: boolean | null; tool: string }, actor: string) => call("review_rob_setup", { setup, actor }),
    studyPlan: (studyId: string, plan: { tool: string; results: string[] | null }, actor: string) => call("review_rob_study", { studyId, plan, actor }),
    overview: (viewer: string) => call<RobOverview>("review_rob_overview", { viewer }),
    assessment: (studyId: string, result: string, viewer: string) => call<RobAssessment>("review_rob_assessment", { studyId, result, viewer }),
    answer: (studyId: string, result: string, domain: string, question: string | null, value: string, actor: string, extra: { reason?: string; support?: string } = {}) =>
      call("review_rob_answer", { studyId, result, domain, question, value, actor, ...extra }),
    evidence: (studyId: string, result: string, evidence: Partial<RobEvidence> & { domain: string }, actor: string, removed = false) => call<string>("review_rob_evidence", { studyId, result, evidence, removed, actor }),
    complete: (studyId: string, result: string, complete: boolean, actor: string) => call("review_rob_complete", { studyId, result, complete, actor }),
    final: (studyId: string, result: string, domain: string, value: string, note: string, actor: string) => call("review_rob_final", { studyId, result, domain, value, note, actor }),
    migrate: (actor: string) => call<{ studies: number }>("review_rob_migrate", { actor }),
    plots: (toolId: string, result: string | null, options?: AnalysisOptions) => call<RobPlots>("review_rob_plots", { toolId, result, options }),
    analyse: (outcome: string, timepoint: string, options: AnalysisOptions, subgroups: boolean, mode: string) => call<RobAnalysis>("review_rob_analyse", { outcome, timepoint, options, subgroups, mode }),
    gradeList: () => call<GradeList>("review_grade_overview"),
    gradeOutcome: (key: string) => call<GradeOutcome>("review_grade_outcome", { key }),
    gradePreview: (rating: Rating) => call<GradeOutcome>("review_grade_preview", { rating }),
    gradeSet: (rating: Rating, actor: string) => call("review_grade_set", { rating, actor }),
    gradeDelete: (key: string, actor: string) => call("review_grade_delete", { key, actor }),
    gradeOrder: (order: string[], actor: string) => call("review_grade_order", { order, actor }),
    sof: () => call<Sof>("review_grade_sof"),
  };
}
export type CertaintyApi = ReturnType<typeof certaintyApi>;

export const resultKey = (outcome: string, timepoint = "") => `${outcome.trim()}|${timepoint.trim()}`;

/** Handing the analysis's choice to the Certainty stage (Analysis › Rate certainty…). */
const handoff = (reviewId: string) => `key.review.certainty-outcome:${reviewId}`;
export function handCertainty(reviewId: string, value: { key: string; options: AnalysisOptions }) {
  try {
    sessionStorage.setItem(handoff(reviewId), JSON.stringify(value));
  } catch {}
}
export function takeCertainty(reviewId: string): { key: string; options: AnalysisOptions } | null {
  try {
    const v = sessionStorage.getItem(handoff(reviewId));
    sessionStorage.removeItem(handoff(reviewId));
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
