// The query builder's model: building blocks as in systematic review practice. A query is
// concepts combined with AND, each a set of synonyms combined with OR, and excluded terms
// (NOT). Edits here are pure (they answer a new query); the host translates and runs it.
import { DOC_TYPES, FIELD_LABEL, LANGUAGES, type Concept, type DbQuery, type QueryFilters, type QueryTerm, type TermField } from "./db-search-api";

let counter = 0;
export const newId = (prefix = "t") => `${prefix}${Date.now().toString(36)}${(++counter).toString(36)}`;

export const emptyQuery = (): DbQuery => ({ concepts: [{ id: newId("c"), terms: [] }], exclude: [], filters: {} });

/** A term from what was typed: quotes make a phrase, a trailing * truncates. */
export function makeTerm(raw: string, defaults: Partial<QueryTerm> = {}): QueryTerm {
  let text = raw.trim();
  let mode: QueryTerm["mode"] = defaults.mode ?? (/\s/.test(text) ? "phrase" : "words");
  let truncate = defaults.truncate ?? false;
  const quoted = /^"(.*)"$/.exec(text);
  if (quoted) {
    text = quoted[1].trim();
    mode = "phrase";
  }
  if (/\*$/.test(text)) {
    text = text.replace(/\*+$/, "");
    truncate = true;
  }
  return { id: newId(), text, mode, truncate, field: defaults.field ?? "title_abstract", ...(defaults.proximity ? { proximity: defaults.proximity } : {}) };
}

/** A pasted list of terms: one per line, or separated by ; , or OR. */
export function splitTerms(text: string): string[] {
  const parts = /[\n;]/.test(text) ? text.split(/[\n;]+/) : /\bOR\b/.test(text) ? text.split(/\s+OR\s+/) : text.includes(",") ? text.split(",") : [text];
  const seen = new Set<string>();
  return parts
    .map((p) => p.trim().replace(/^[-•*\d.)\s]+(?=\S)/, "").replace(/^\(+|\)+$/g, "").trim())
    .filter((p) => {
      const key = p.toLowerCase();
      if (!p || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// ── Edits ────────────────────────────────────────────────────────────────────────────

/** Where a term lives: a concept's id, or "exclude". */
export type Block = string;
export const EXCLUDE: Block = "exclude";

const mapConcept = (q: DbQuery, id: string, f: (c: Concept) => Concept): DbQuery => ({ ...q, concepts: q.concepts.map((c) => (c.id === id ? f(c) : c)) });

export function addConcept(q: DbQuery, terms: QueryTerm[] = [], label?: string): DbQuery {
  return { ...q, concepts: [...q.concepts, { id: newId("c"), ...(label ? { label } : {}), terms }] };
}
export function removeConcept(q: DbQuery, id: string): DbQuery {
  const concepts = q.concepts.filter((c) => c.id !== id);
  return { ...q, concepts: concepts.length ? concepts : [{ id: newId("c"), terms: [] }] };
}
export function renameConcept(q: DbQuery, id: string, label: string): DbQuery {
  return mapConcept(q, id, (c) => ({ ...c, label: label.trim() || undefined }));
}
export function moveConcept(q: DbQuery, id: string, to: number): DbQuery {
  const from = q.concepts.findIndex((c) => c.id === id);
  if (from < 0) return q;
  const concepts = [...q.concepts];
  const [moved] = concepts.splice(from, 1);
  concepts.splice(Math.max(0, Math.min(to, concepts.length)), 0, moved);
  return { ...q, concepts };
}

const termsOf = (q: DbQuery, block: Block) => (block === EXCLUDE ? q.exclude : (q.concepts.find((c) => c.id === block)?.terms ?? []));
const withTerms = (q: DbQuery, block: Block, terms: QueryTerm[]): DbQuery => (block === EXCLUDE ? { ...q, exclude: terms } : mapConcept(q, block, (c) => ({ ...c, terms })));

/** Adds terms to a block, skipping ones it has already (same text and field). */
export function addTerms(q: DbQuery, block: Block, terms: QueryTerm[]): DbQuery {
  const have = termsOf(q, block);
  const key = (t: QueryTerm) => `${t.text.toLowerCase()}|${t.field}`;
  const known = new Set(have.map(key));
  const fresh = terms.filter((t) => t.text && !known.has(key(t)) && known.add(key(t)));
  return fresh.length ? withTerms(q, block, [...have, ...fresh]) : q;
}
export function updateTerm(q: DbQuery, id: string, patch: Partial<Omit<QueryTerm, "id">>): DbQuery {
  const edit = (t: QueryTerm) => (t.id === id ? { ...t, ...patch } : t);
  return { ...q, concepts: q.concepts.map((c) => ({ ...c, terms: c.terms.map(edit) })), exclude: q.exclude.map(edit) };
}
export function removeTerm(q: DbQuery, id: string): DbQuery {
  return { ...q, concepts: q.concepts.map((c) => ({ ...c, terms: c.terms.filter((t) => t.id !== id) })), exclude: q.exclude.filter((t) => t.id !== id) };
}
export function findTerm(q: DbQuery, id: string): { term: QueryTerm; block: Block } | undefined {
  for (const c of q.concepts) {
    const term = c.terms.find((t) => t.id === id);
    if (term) return { term, block: c.id };
  }
  const term = q.exclude.find((t) => t.id === id);
  return term ? { term, block: EXCLUDE } : undefined;
}
/** Moves a term to another block (or another place in its own), at `index` (default: the end). */
export function moveTerm(q: DbQuery, id: string, to: Block, index?: number): DbQuery {
  const found = findTerm(q, id);
  if (!found) return q;
  const without = removeTerm(q, id);
  const target = [...termsOf(without, to)];
  target.splice(index === undefined ? target.length : Math.max(0, Math.min(index, target.length)), 0, found.term);
  return withTerms(without, to, target);
}
/** Sets one field for every term of a block. */
export function setBlockField(q: DbQuery, block: Block, field: TermField): DbQuery {
  return withTerms(q, block, termsOf(q, block).map((t) => ({ ...t, field })));
}
export function setFilters(q: DbQuery, patch: Partial<QueryFilters>): DbQuery {
  const filters = { ...q.filters, ...patch };
  for (const k of Object.keys(filters) as (keyof QueryFilters)[]) {
    const v = filters[k];
    if (v === undefined || v === null || v === false || (Array.isArray(v) && !v.length)) delete filters[k];
  }
  return { ...q, filters };
}

// ── Reading a query ──────────────────────────────────────────────────────────────────

/** What is sent: no empty terms or concepts. */
export function cleanQuery(q: DbQuery): DbQuery {
  const clean = (terms: QueryTerm[]) => terms.map((t) => ({ ...t, text: t.text.trim() })).filter((t) => t.text);
  return { concepts: q.concepts.map((c) => ({ ...c, terms: clean(c.terms) })).filter((c) => c.terms.length), exclude: clean(q.exclude), filters: q.filters };
}
export const isEmptyQuery = (q: DbQuery) => !cleanQuery(q).concepts.length;
export const queryKey = (q: DbQuery) => JSON.stringify(cleanQuery(q));

/** A term as the builder writes it: "social capital", child*. */
export function termLabel(t: QueryTerm) {
  const text = t.mode === "phrase" && /\s/.test(t.text) ? `“${t.text}”` : t.text;
  return `${text}${t.truncate ? "*" : ""}${t.proximity ? ` ~${t.proximity}` : ""}`;
}

const list = (items: string[], joiner: string) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${joiner} ${items[items.length - 1]}`);
const docTypeLabel = (id: string) => (DOC_TYPES.find(([k]) => k === id)?.[1] ?? id).toLowerCase();
const languageLabel = (id: string) => LANGUAGES.find(([k]) => k === id)?.[1] ?? id;

/** The query in a sentence: "Find works about (A or B) and (C or D), published 2015–2026." */
export function describeQuery(q: DbQuery): string {
  const clean = cleanQuery(q);
  if (!clean.concepts.length) return "Add a term to the first concept to start.";
  const fieldNote = (terms: QueryTerm[]) => {
    const fields = [...new Set(terms.map((t) => t.field))];
    return fields.length === 1 && fields[0] !== "title_abstract" && fields[0] !== "all" ? ` in the ${FIELD_LABEL[fields[0]].toLowerCase()}` : "";
  };
  const group = (terms: QueryTerm[]) => {
    const words = terms.map(termLabel);
    const inner = list(words, "or");
    return (terms.length > 1 ? `(${inner})` : inner) + fieldNote(terms);
  };
  let text = `Find works about ${list(clean.concepts.map((c) => group(c.terms)), "and")}`;
  if (clean.exclude.length) text += `, but not ${list(clean.exclude.map(termLabel), "or")}`;
  const f = clean.filters;
  if (f.types?.length) text = text.replace(/^Find works/, `Find ${list(f.types.map(docTypeLabel), "or")}s`.replace(/ss$/, "ses"));
  if (f.yearFrom && f.yearTo) text += `, published ${f.yearFrom === f.yearTo ? `in ${f.yearFrom}` : `${f.yearFrom}–${f.yearTo}`}`;
  else if (f.yearFrom) text += `, published ${f.yearFrom} or later`;
  else if (f.yearTo) text += `, published ${f.yearTo} or earlier`;
  if (f.languages?.length) text += `, in ${list(f.languages.map(languageLabel), "or")}`;
  if (f.openAccess) text += `, free to read`;
  return `${text}.`;
}

// ── Import and export ────────────────────────────────────────────────────────────────

export interface QueryFile {
  format: "key-database-query";
  version: 1;
  name?: string;
  query: DbQuery;
  connectors?: string[];
  overrides?: Record<string, string>;
}

export function exportQuery(q: DbQuery, extras: { name?: string; connectors?: string[]; overrides?: Record<string, string> } = {}): string {
  const file: QueryFile = { format: "key-database-query", version: 1, ...(extras.name ? { name: extras.name } : {}), query: cleanQuery(q), ...(extras.connectors?.length ? { connectors: extras.connectors } : {}), ...(extras.overrides && Object.keys(extras.overrides).length ? { overrides: extras.overrides } : {}) };
  return JSON.stringify(file, null, 2);
}

const FIELDS = new Set(Object.keys(FIELD_LABEL));
function readTerm(raw: unknown): QueryTerm | undefined {
  if (typeof raw === "string") return raw.trim() ? makeTerm(raw) : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  const text = typeof t.text === "string" ? t.text.trim() : "";
  if (!text) return undefined;
  const phrase = t.mode === "phrase" || t.phrase === true;
  return {
    id: newId(),
    text,
    mode: phrase ? "phrase" : "words",
    truncate: t.truncate === true,
    field: typeof t.field === "string" && FIELDS.has(t.field) ? (t.field as TermField) : "title_abstract",
    ...(typeof t.proximity === "number" && t.proximity > 0 ? { proximity: Math.round(t.proximity) } : {}),
  };
}
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined);

/** Reads a query file (or a bare query); throws a plain-language error when it is not one. */
export function importQuery(text: string): { query: DbQuery; name?: string; connectors?: string[]; overrides?: Record<string, string> } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This is not a query file (it is not JSON).");
  }
  const file = (data && typeof data === "object" && "query" in data ? data : { query: data }) as Partial<QueryFile> & { query: unknown };
  const q = file.query as unknown as Record<string, unknown> | null;
  if (!q || typeof q !== "object" || !Array.isArray(q.concepts)) throw new Error("This file has no concepts to search for.");
  const concepts: Concept[] = (q.concepts as unknown[])
    .map((c) => {
      const raw = (Array.isArray(c) ? { terms: c } : c) as Record<string, unknown> | null;
      const terms = Array.isArray(raw?.terms) ? (raw.terms as unknown[]).map(readTerm).filter((t): t is QueryTerm => !!t) : [];
      return { id: newId("c"), ...(typeof raw?.label === "string" && raw.label ? { label: raw.label } : {}), terms };
    })
    .filter((c) => c.terms.length);
  if (!concepts.length) throw new Error("This file has no concepts to search for.");
  const exclude = Array.isArray(q.exclude) ? (q.exclude as unknown[]).map(readTerm).filter((t): t is QueryTerm => !!t) : [];
  const f = (q.filters ?? {}) as Record<string, unknown>;
  const filters = setFilters({ concepts, exclude, filters: {} }, { yearFrom: num(f.yearFrom), yearTo: num(f.yearTo), types: strings(f.types), languages: strings(f.languages), openAccess: f.openAccess === true }).filters;
  const overrides = file.overrides && typeof file.overrides === "object" ? Object.fromEntries(Object.entries(file.overrides).filter(([, v]) => typeof v === "string")) : undefined;
  return { query: { concepts, exclude, filters }, name: typeof file.name === "string" ? file.name : undefined, connectors: strings(file.connectors), overrides };
}

/** Looks like a database's own boolean query (pasted from PubMed, Scopus …) rather than a term list. */
export const looksBoolean = (text: string) => /\b(AND|OR|NOT)\b|\[[a-z]{2,}[^\]]*\]|\b(TITLE-ABS-KEY|TS|TI|AB)\s*=?\s*\(/i.test(text) && /\b(AND|NOT)\b|\[|\(/.test(text);

// ── Templates to learn from ──────────────────────────────────────────────────────────

export interface QueryTemplate {
  id: string;
  title: string;
  about: string;
  connectors: string[];
  build: () => DbQuery;
}
const block = (label: string, terms: string[], field: TermField = "title_abstract") => ({ id: newId("c"), label, terms: terms.map((t) => makeTerm(t, { field })) });
export const TEMPLATES: QueryTemplate[] = [
  {
    id: "pico",
    title: "A health question (PICO)",
    about: "Population, intervention and outcome as three concepts, with a MeSH heading beside the free-text words.",
    connectors: ["pubmed", "europepmc"],
    build: () => ({
      concepts: [
        { id: newId("c"), label: "Population", terms: [makeTerm("Adolescent", { field: "subject", mode: "phrase" }), ...["adolescen*", "teenager*", "young people"].map((t) => makeTerm(t))] },
        block("Intervention", ["mindfulness", "meditation", "acceptance and commitment therapy"]),
        block("Outcome", ["anxiety", "depress*", "wellbeing"]),
      ],
      exclude: [makeTerm("protocol", { field: "title" })],
      filters: { yearFrom: 2015, types: ["article", "review"] },
    }),
  },
  {
    id: "policy",
    title: "An economics question",
    about: "Two concepts for working papers and grey literature, where synonyms matter more than subject headings.",
    connectors: ["nber", "worldbank", "iza", "openalex"],
    build: () => ({
      concepts: [block("Intervention", ["cash transfer*", "conditional cash", "social protection"]), block("Outcome", ["school enrol*", "attendance", "education outcome*"])],
      exclude: [],
      filters: { yearFrom: 2000 },
    }),
  },
  {
    id: "trials",
    title: "Find trials of a treatment",
    about: "A condition and a treatment, limited to trial registrations: what was planned and is still running.",
    connectors: ["clinicaltrials", "pubmed"],
    build: () => ({
      concepts: [block("Condition", ["type 2 diabetes", "T2DM"]), block("Treatment", ["metformin", "SGLT2 inhibitor*"])],
      exclude: [],
      filters: { yearFrom: 2018 },
    }),
  },
];
