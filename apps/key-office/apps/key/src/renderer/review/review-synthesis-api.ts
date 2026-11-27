// Typed calls for the advanced synthesis, the conversion helper and the exports others can
// import (key-review's synthesis.rs, conversions.rs, interop.rs, revman.rs, migrate.rs).
import type { Invoke } from "../library-api";

export interface Coef {
  name: string;
  estimate: number;
  se: number;
  statistic: number;
  df: number | null;
  p: number;
  lower: number;
  upper: number;
}
export interface PooledLite {
  estimate: number;
  se: number;
  lower: number;
  upper: number;
  p: number;
  tau2: number;
  i2: number;
  q: number;
  df: number;
  qP: number;
  k: number;
  piLower: number | null;
  piUpper: number | null;
}
export interface ModeratorRef {
  source: "field" | "column" | "rob";
  form: string;
  field: string;
  kind: "continuous" | "categorical" | "";
  name: string;
}
export interface ModeratorChoice extends ModeratorRef {
  label: string;
  studies: number;
}
type Err = { error?: string };
export interface MetaRegResult extends Err {
  note?: string;
  coefficients?: Coef[];
  method: string;
  test: string;
  k: number;
  p: number;
  tau2: number;
  i2: number;
  h2: number;
  r2: number | null;
  qe: number;
  qeDf: number;
  qeP: number;
  qm: number;
  qmDf: [number, number | null];
  qmP: number;
  permutation: { iterations: number; exact: boolean; p: number[]; qmP: number } | null;
  bubble: { moderator: string; points: { id: string; label: string; x: number; yi: number; weight: number }[]; line: { x: number; fit: number; lower: number; upper: number }[] } | null;
  leftOut: string[];
  warnings: string[];
}
export interface DependenceResult extends Err {
  model: string;
  modelLabel: string;
  k: number;
  studies: number;
  coefficients: Coef[];
  robust: Coef[] | null;
  sigma2: [number, number] | null;
  rho: number | null;
  aggregated: [string, number, number][] | null;
  pooled: PooledLite | null;
  warnings: string[];
}
export interface Regression {
  intercept: Coef;
  slope: Coef;
  seType: string;
}
export interface BiasResult {
  petPeese?: Err & { pet: Regression; peese: Regression; chosen: string; estimate: Coef; rule: string };
  uwls?: { uwls: Coef; adequatelyPowered: number; waap: Coef | null; note: string };
  trimFill?: Err & { estimator: string; side: string; k0: number; seK0: number; pK0: number | null; filled: [number, number][]; pooled: PooledLite };
  selection?: Err & { estimate: number; se: number; lower: number; upper: number; p: number; tau2: number; delta: number; deltaSe: number | null; lrt: number; lrtP: number; counts: [number, number] };
  caution: string | null;
}
export interface InfluenceRow {
  id: string;
  label: string;
  rstudent: number;
  dffits: number;
  cookD: number;
  covR: number;
  dfbetas: number;
  tau2Del: number;
  qeDel: number;
  hat: number;
  weight: number;
  influential: boolean;
  baujatX: number;
  baujatY: number;
}
export interface SensitivityResult {
  influence?: InfluenceRow[] | Err;
  cumulative?: { id: string; label: string; pooled: PooledLite }[];
  cumulativeOrder?: string;
  models?: { model: string; pooled: PooledLite }[];
  note?: string;
}
export interface SynthesisResult {
  k: number;
  studies: number;
  multipleEstimates: boolean;
  measure: string;
  measureLabel: string;
  transform: "exp" | "tanh" | "expit" | "ipft" | "none";
  skipped: [string, string][];
  points: { id: string; label: string; yi: number; vi: number; year: number | null }[];
  dependenceWarning?: string;
  metaRegression?: MetaRegResult;
  dependence?: DependenceResult;
  bias?: BiasResult;
  sensitivity?: SensitivityResult;
}
export interface SynthesisOptions {
  moderators: ModeratorRef[];
  metareg: { method: "reml" | "fe"; knappHartung: boolean; permutations: number } | null;
  dependence: { model: "che" | "three-level" | "aggregate"; rho: number; robust: boolean; method?: string; hartungKnapp?: boolean } | null;
  bias: { petPeese: boolean; alpha?: number; oneSided: boolean; trimFill: "" | "L0" | "R0"; selection: boolean; uwls: boolean } | null;
  sensitivity: { influence: boolean; cumulative: "" | "year" | "precision" | "listed"; models: boolean } | null;
}
export interface BaseRequest {
  outcome: string;
  timepoint?: string;
  options: { measure: string; method: string; hartungKnapp: boolean; level: number };
  subgroups: boolean;
}
export interface AnalysisSpec {
  id: string;
  name: string;
  request: BaseRequest;
  advanced: Partial<SynthesisOptions> | null;
}
export interface Conversion {
  kind: string;
  method: string;
  formula: string;
  citation: string;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  fill: Record<string, number>;
  warnings: string[];
}
export interface ZipFile {
  filename: string;
  content: string;
  encoding: "base64";
  mime: string;
}
export interface RevmanProblem {
  file: string;
  row: number;
  study: string;
  message: string;
  severity: "error" | "warning";
}
export interface MigratePreview {
  format: "covidence" | "rayyan" | "other";
  columns: string[];
  sample: string[][];
  rows: number;
  mapping: MigrateMapping;
  reviewers: string[];
  decisions: Record<string, number>;
  notes: string[];
}
export interface MigrateMapping {
  columns: Record<string, number>;
  decisions: "rayyan" | "column" | "list" | "none";
  listDecision: string;
  stage: "ta" | "ft";
  reviewers: Record<string, string>;
  batchName: string;
}

export function synthesisApi(invoke: Invoke, workspaceId: string, reviewId: string) {
  const call = <T>(command: string, args: Record<string, unknown> = {}) => invoke<T>(command, { reviewId, ...args }, workspaceId);
  return {
    moderators: () => call<ModeratorChoice[]>("review_moderators"),
    synthesis: (request: BaseRequest & Partial<SynthesisOptions>) => call<SynthesisResult>("review_synthesis", { request }),
    convert: (request: { kind: string; inputs: Record<string, number>; group: string; ratio: boolean }) => call<Conversion>("review_convert", { request }),
    conversionKinds: () => call<{ kind: string; title: string; inputs: string[] }[]>("review_conversion_kinds"),
    exportR: (spec: AnalysisSpec) => call<ZipFile>("review_export_r", { spec }),
    revman: () => call<ZipFile & { problems: RevmanProblem[] }>("review_revman_export"),
    studies: (format: "ris" | "bib" | "csv", which: "included" | "excluded" | "all") => call<{ filename: string; content: string; mime: string }>("review_studies_export", { format, which }),
    bundle: (viewer: string, plots: Record<string, string>, current: AnalysisSpec | null, anonymise: boolean) => call<ZipFile>("review_bundle", { viewer, plots, current, anonymise }),
    saveAnalysis: (spec: AnalysisSpec, actor: string) => call("review_analysis_save", { analysis: spec, actor }),
    migratePreview: (text: string) => call<MigratePreview>("review_migrate_preview", { text }),
    migrate: (text: string, mapping: MigrateMapping, actor: string) => call<{ added: number; duplicates: number; decisions: number; leftUndecided: number; skipped: string[] }>("review_migrate", { text, mapping, actor }),
  };
}
export type SynthesisApi = ReturnType<typeof synthesisApi>;

/** Saves a base64 file the host made (zips) as a download. */
export function saveBase64(file: ZipFile) {
  const bin = atob(file.content);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A value on the analysis scale shown on the outcome's scale (as key-review's back_transform). */
export function backTransform(v: number, transform: string, harmonicN?: number | null): number {
  if (transform === "exp") return Math.exp(v);
  if (transform === "tanh") return Math.tanh(v);
  if (transform === "expit") return 1 / (1 + Math.exp(-v));
  if (transform === "ipft") {
    const n = harmonicN ?? 1;
    const pft = (p: number) => 0.5 * (Math.asin(Math.sqrt((p * n) / (n + 1))) + Math.asin(Math.sqrt((p * n + 1) / (n + 1))));
    if (v > pft(1)) return 1;
    if (v < pft(0)) return 0;
    const s = Math.sin(2 * v);
    return 0.5 * (1 - Math.sign(Math.cos(2 * v)) * Math.sqrt(1 - (s + (s - 1 / s) / n) ** 2));
  }
  return v;
}
