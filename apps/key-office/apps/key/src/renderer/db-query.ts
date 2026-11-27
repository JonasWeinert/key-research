// The query builder's model: a Boolean tree (crates/key-connectors boolean.rs). The root is an
// AND group; its items are usually concepts (OR groups of synonyms), but any item may be a term
// or a group nested to any depth, and any item may be negated (NOT). Edits here are pure (they
// answer a new query); parsing the text mode, translating and running are the host's.
import { DOC_TYPES, FIELD_LABEL, LANGUAGES, type Concept, type DbQuery, type QGroup, type QNode, type QTerm, type QueryFilters, type QueryTerm, type TermField } from "./db-search-api";

let counter = 0;
export const newId = (prefix = "t") => `${prefix}${Date.now().toString(36)}${(++counter).toString(36)}`;

export const group = (op: QGroup["op"], items: QNode[] = [], extra: Partial<QGroup> = {}): QGroup => ({ type: "group", id: newId("g"), op, items, ...extra });
export const emptyQuery = (): DbQuery => ({ expr: group("and", [group("or")]), filters: {} });

/** A term from what was typed: quotes make a phrase, a trailing * truncates. */
export function makeTerm(raw: string, defaults: Partial<QueryTerm> = {}): QTerm {
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
  return { type: "term", id: newId(), text, mode, truncate, field: defaults.field ?? "title_abstract", ...(defaults.proximity ? { proximity: defaults.proximity } : {}) };
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

// ── Reading old and new shapes ──────────────────────────────────────────────────────

const FIELDS = new Set(Object.keys(FIELD_LABEL));
const asField = (f: unknown): TermField => (typeof f === "string" && FIELDS.has(f) ? (f as TermField) : "title_abstract");

/** A node from anywhere (the host, a file, an older draft) with ids on every item. */
export function readNode(raw: unknown): QNode | undefined {
  if (typeof raw === "string") return raw.trim() ? makeTerm(raw) : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const n = raw as Record<string, unknown>;
  const not = n.not === true ? { not: true } : {};
  if (n.type === "group" || Array.isArray(n.items)) {
    const items = (Array.isArray(n.items) ? n.items : []).map(readNode).filter((x): x is QNode => !!x);
    return { type: "group", id: typeof n.id === "string" && n.id ? n.id : newId("g"), op: n.op === "or" ? "or" : "and", items, ...not, ...(typeof n.label === "string" && n.label ? { label: n.label } : {}) };
  }
  const text = typeof n.text === "string" ? n.text.trim() : "";
  if (!text) return undefined;
  return {
    type: "term",
    id: typeof n.id === "string" && n.id ? n.id : newId(),
    text,
    mode: n.mode === "phrase" || n.phrase === true ? "phrase" : "words",
    truncate: n.truncate === true,
    field: asField(n.field),
    ...(typeof n.proximity === "number" && n.proximity > 0 ? { proximity: Math.round(n.proximity) } : {}),
    ...not,
  };
}

/** The older concepts/exclude form as a tree. */
function fromConcepts(concepts: unknown[], exclude: unknown[]): QGroup {
  const items: QNode[] = concepts.map((c) => {
    const raw = (Array.isArray(c) ? { terms: c } : c) as Record<string, unknown> | null;
    const terms = (Array.isArray(raw?.terms) ? raw.terms : []).map(readNode).filter((t): t is QNode => !!t);
    return group("or", terms, typeof raw?.label === "string" && raw.label ? { label: raw.label } : {});
  });
  for (const t of exclude.map(readNode)) if (t) items.push({ ...t, not: true } as QNode);
  return group("and", items.length ? items : [group("or")]);
}

/** Any stored or received query (tree or older form) as the builder's shape. */
export function readQuery(raw: unknown): DbQuery {
  const q = (raw ?? {}) as Record<string, unknown>;
  const filters = (q.filters && typeof q.filters === "object" ? q.filters : {}) as QueryFilters;
  if (q.expr) {
    const n = readNode(q.expr);
    const root = !n ? group("and") : n.type === "group" && !n.not ? n : group("and", [n]);
    return { expr: root.op === "and" ? root : group("and", [root]), filters };
  }
  return { expr: fromConcepts(Array.isArray(q.concepts) ? q.concepts : [], Array.isArray(q.exclude) ? q.exclude : []), filters };
}

// ── Walking the tree ────────────────────────────────────────────────────────────────

export interface Found {
  node: QNode;
  parent?: QGroup;
  index: number;
  depth: number;
}

export function findNode(root: QGroup, id: string): Found | undefined {
  if (root.id === id) return { node: root, index: 0, depth: 0 };
  const walk = (g: QGroup, depth: number): Found | undefined => {
    for (let i = 0; i < g.items.length; i++) {
      const n = g.items[i];
      if (n.id === id) return { node: n, parent: g, index: i, depth: depth + 1 };
      if (n.type === "group") {
        const f = walk(n, depth + 1);
        if (f) return f;
      }
    }
    return undefined;
  };
  return walk(root, 0);
}

export const terms = (n: QNode): QTerm[] => (n.type === "term" ? [n] : n.items.flatMap(terms));
const contains = (n: QNode, id: string): boolean => n.id === id || (n.type === "group" && n.items.some((i) => contains(i, id)));

/** The tree with one node replaced (or removed, when `f` answers undefined). */
export function mapNode(root: QGroup, id: string, f: (n: QNode) => QNode | undefined): QGroup {
  const go = (n: QNode): QNode | undefined => {
    if (n.id === id) return f(n);
    if (n.type !== "group") return n;
    return { ...n, items: n.items.map(go).filter((x): x is QNode => !!x) };
  };
  return (go(root) as QGroup | undefined) ?? group("and", [group("or")]);
}

const withQuery = (q: DbQuery, expr: QGroup): DbQuery => ({ ...q, expr: expr.items.length ? expr : { ...expr, items: [group("or")] } });

// ── Edits ────────────────────────────────────────────────────────────────────────────

/** A new concept (an OR group) at the end of the root, or at `index`. */
export function addConcept(q: DbQuery, items: QNode[] = [], label?: string, index?: number): DbQuery {
  const next = [...q.expr.items];
  next.splice(index ?? next.length, 0, group("or", items, label ? { label } : {}));
  return withQuery(q, { ...q.expr, items: next });
}

/** Adds terms to a group, skipping ones it has already (same text and field). */
export function addTerms(q: DbQuery, groupId: string, add: QNode[]): DbQuery {
  return withQuery(
    q,
    mapNode(q.expr, groupId, (g) => {
      if (g.type !== "group") return g;
      const key = (t: QNode) => (t.type === "term" ? `${t.text.toLowerCase()}|${t.field}|${!!t.not}` : t.id);
      const known = new Set(g.items.map(key));
      const fresh = add.filter((t) => (t.type === "group" || t.text) && !known.has(key(t)) && known.add(key(t)));
      return fresh.length ? { ...g, items: [...g.items, ...fresh] } : g;
    }),
  );
}

export function updateNode(q: DbQuery, id: string, patch: Partial<QTerm> | Partial<QGroup>): DbQuery {
  return withQuery(q, mapNode(q.expr, id, (n) => ({ ...n, ...patch }) as QNode));
}
export const updateTerm = updateNode;

export function removeNode(q: DbQuery, id: string): DbQuery {
  if (id === q.expr.id) return emptyQuery();
  return withQuery(q, mapNode(q.expr, id, () => undefined));
}
export const removeTerm = removeNode;

/** Moves an item into a group at `index` (default: the end); not into itself. */
export function moveNode(q: DbQuery, id: string, to: string, index?: number): DbQuery {
  const found = findNode(q.expr, id);
  if (!found?.parent || contains(found.node, to)) return q;
  // An index in the same group counts positions before the item is taken out.
  const shift = found.parent.id === to && index !== undefined && index > found.index ? 1 : 0;
  const without = mapNode(q.expr, id, () => undefined);
  return withQuery(
    q,
    mapNode(without, to, (g) => {
      if (g.type !== "group") return g;
      const items = [...g.items];
      items.splice(index === undefined ? items.length : Math.max(0, Math.min(index - shift, items.length)), 0, found.node);
      return { ...g, items };
    }),
  );
}
export const moveTerm = moveNode;

/** Puts sibling items into a new group in their place (the opposite operator of their parent). */
export function wrapNodes(q: DbQuery, ids: string[]): DbQuery {
  const first = ids.length ? findNode(q.expr, ids[0]) : undefined;
  const parent = first?.parent;
  if (!parent) return q;
  const chosen = parent.items.filter((n) => ids.includes(n.id));
  if (!chosen.length) return q;
  const at = parent.items.findIndex((n) => ids.includes(n.id));
  const wrapped = group(parent.op === "and" ? "or" : "and", chosen);
  const items = parent.items.filter((n) => !ids.includes(n.id));
  items.splice(at, 0, wrapped);
  return withQuery(q, mapNode(q.expr, parent.id, (g) => ({ ...(g as QGroup), items })));
}

/** Dissolves a group into its parent: its items join the parent's operator. A negated group
 *  cannot be dissolved (its NOT would be lost). */
export function ungroup(q: DbQuery, id: string): DbQuery {
  const found = findNode(q.expr, id);
  if (!found?.parent || found.node.type !== "group" || found.node.not) return q;
  const g = found.node;
  return withQuery(
    q,
    mapNode(q.expr, found.parent.id, (p) => {
      const items = [...(p as QGroup).items];
      items.splice(found.index, 1, ...g.items);
      return { ...(p as QGroup), items };
    }),
  );
}

export function canUngroup(q: DbQuery, id: string) {
  const f = findNode(q.expr, id);
  return !!f?.parent && f.node.type === "group" && !f.node.not;
}

export type Joiner = "and" | "or" | "not";
/** What joins item `index` to the one before it: the group's operator, or NOT for a negated item. */
export const joinerAt = (g: QGroup, index: number): Joiner => (g.items[index]?.not && g.op === "and" ? "not" : g.op);

/** Changes the operator between item `index - 1` and item `index` of a group. With two items
 *  the group's operator changes; with more, it reads left to right as PubMed does: what comes
 *  before the word is bracketed, so "a OR b OR c" with NOT before c is (a OR b) NOT c. */
export function setJoiner(q: DbQuery, groupId: string, index: number, to: Joiner): DbQuery {
  const found = findNode(q.expr, groupId);
  if (!found || found.node.type !== "group" || index < 1) return q;
  const g = found.node;
  const now = joinerAt(g, index);
  if (now === to) return q;
  const item = g.items[index];
  const op = to === "or" ? "or" : "and";
  const negate = to === "not";
  if (op === g.op) {
    // AND <-> NOT within an AND group: only the item's negation changes.
    return updateNode(q, item.id, { not: negate });
  }
  const before = g.items.slice(0, index);
  const after = g.items.slice(index + 1);
  const left = before.length === 1 ? before[0] : group(g.op, before);
  const joined = [left, { ...item, not: negate } as QNode];
  // Nothing after the word: the group itself takes the new operator.
  if (!after.length) return withQuery(q, mapNode(q.expr, groupId, () => ({ ...g, op, items: joined })));
  return withQuery(q, mapNode(q.expr, groupId, () => ({ ...g, items: [group(op, joined), ...after] })));
}

/** Sets one field for every term inside a group. */
export function setGroupField(q: DbQuery, id: string, field: TermField): DbQuery {
  const setAll = (n: QNode): QNode => (n.type === "term" ? { ...n, field } : { ...n, items: n.items.map(setAll) });
  return withQuery(q, mapNode(q.expr, id, setAll));
}
export const setBlockField = setGroupField;

export function setFilters(q: DbQuery, patch: Partial<QueryFilters>): DbQuery {
  const filters = { ...q.filters, ...patch };
  for (const k of Object.keys(filters) as (keyof QueryFilters)[]) {
    const v = filters[k];
    if (v === undefined || v === null || v === false || (Array.isArray(v) && !v.length)) delete filters[k];
  }
  return { ...q, filters };
}

// ── Reading a query ──────────────────────────────────────────────────────────────────

function prune(n: QNode): QNode | undefined {
  if (n.type === "term") return n.text.trim() ? { ...n, text: n.text.trim() } : undefined;
  const items = n.items.map(prune).filter((x): x is QNode => !!x);
  return items.length ? { ...n, items } : undefined;
}

/** What is sent: no empty terms or groups. */
export function cleanQuery(q: DbQuery): DbQuery {
  const root = prune(q.expr);
  return { expr: root && root.type === "group" ? root : group("and"), filters: q.filters };
}
export const isEmptyQuery = (q: DbQuery) => !terms(q.expr).some((t) => t.text.trim());
export const queryKey = (q: DbQuery) => {
  const strip = (n: QNode): unknown => (n.type === "term" ? { ...n, id: undefined } : { ...n, id: undefined, label: undefined, items: n.items.map(strip) });
  return JSON.stringify({ e: strip(cleanQuery(q).expr), f: q.filters });
};

/** The top-level items that have terms (what the host counts one by one). */
export const topParts = (q: DbQuery) => q.expr.items.filter((n) => terms(n).some((t) => t.text.trim()));

/** A term as the builder writes it: "social capital", child*. */
export function termLabel(t: QueryTerm) {
  const text = t.mode === "phrase" && /\s/.test(t.text) ? `“${t.text}”` : t.text;
  return `${text}${t.truncate ? "*" : ""}${t.proximity ? ` ~${t.proximity}` : ""}`;
}

const list = (items: string[], joiner: string) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${joiner} ${items[items.length - 1]}`);
const docTypeLabel = (id: string) => (DOC_TYPES.find(([k]) => k === id)?.[1] ?? id).toLowerCase();
const languageLabel = (id: string) => LANGUAGES.find(([k]) => k === id)?.[1] ?? id;

function sayTerm(t: QTerm, mixed: boolean) {
  if (t.field === "year") return `published ${t.text.replace("-", "–")}`;
  if (t.field === "type") return `of type ${docTypeLabel(t.text)}`;
  if (t.field === "language") return `in ${languageLabel(t.text)}`;
  return termLabel(t) + (mixed && t.field !== "title_abstract" && t.field !== "all" ? ` in the ${FIELD_LABEL[t.field].toLowerCase()}` : "");
}

/** A group in words: "(a or b) and not c". */
function sayGroup(g: QGroup, nested: boolean): string {
  const fields = new Set(terms(g).map((t) => t.field));
  const mixed = fields.size > 1;
  const parts = g.items.map((n, i) => {
    const inner = n.type === "term" ? sayTerm(n, mixed || g.items.length === 1) : sayGroup(n, true);
    const not = n.not ? "not " : "";
    if (i === 0) return `${not}${inner}`;
    return `${g.op === "and" ? (n.not ? "but" : "and") : "or"} ${not}${inner}`;
  });
  let text = parts.join(" ");
  if (!mixed && fields.size === 1) {
    const f = [...fields][0];
    if (f !== "title_abstract" && f !== "all" && f !== "year" && f !== "type" && f !== "language") text += ` in the ${FIELD_LABEL[f].toLowerCase()}`;
  }
  return nested && g.items.length > 1 ? `(${text})` : text;
}

/** The query in a sentence: "Find works about (A or B) and (C or D), published 2015–2026." */
export function describeQuery(q: DbQuery): string {
  const clean = cleanQuery(q);
  if (!clean.expr.items.length) return "Add a term to the first concept to start.";
  const positives = clean.expr.items.filter((n) => !n.not);
  const negatives = clean.expr.items.filter((n) => n.not);
  const say = (n: QNode) => (n.type === "term" ? sayTerm(n, false) : sayGroup(n, true));
  let text = positives.length ? `Find works about ${list(positives.map(say), "and")}` : "Find works";
  if (negatives.length) text += `, but not ${list(negatives.map(say), "or")}`;
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
  version: 2;
  name?: string;
  query: DbQuery;
  connectors?: string[];
  overrides?: Record<string, string>;
}

export function exportQuery(q: DbQuery, extras: { name?: string; connectors?: string[]; overrides?: Record<string, string> } = {}): string {
  const file: QueryFile = { format: "key-database-query", version: 2, ...(extras.name ? { name: extras.name } : {}), query: cleanQuery(q), ...(extras.connectors?.length ? { connectors: extras.connectors } : {}), ...(extras.overrides && Object.keys(extras.overrides).length ? { overrides: extras.overrides } : {}) };
  return JSON.stringify(file, null, 2);
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined);

/** Reads a query file, an exported search strategy (its `rerun`), or a bare query; throws a
 *  plain-language error when it is none of them. */
export function importQuery(text: string): { query: DbQuery; name?: string; connectors?: string[]; overrides?: Record<string, string> } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This is not a query file (it is not JSON).");
  }
  const d = (data ?? {}) as Record<string, unknown>;
  const file = (d.format === "key-search-strategy" && d.rerun && typeof d.rerun === "object" ? { ...(d.rerun as object), name: d.label } : "query" in d ? d : { query: d }) as Partial<QueryFile> & { query: unknown };
  const q = file.query as unknown as Record<string, unknown> | null;
  if (!q || typeof q !== "object" || (!q.expr && !Array.isArray(q.concepts))) throw new Error("This file has no concepts to search for.");
  const read = readQuery(q);
  if (isEmptyQuery(read)) throw new Error("This file has no concepts to search for.");
  const f = (q.filters ?? {}) as Record<string, unknown>;
  const filters = setFilters({ ...read, filters: {} }, { yearFrom: num(f.yearFrom), yearTo: num(f.yearTo), types: strings(f.types), languages: strings(f.languages), openAccess: f.openAccess === true }).filters;
  const overrides = file.overrides && typeof file.overrides === "object" ? Object.fromEntries(Object.entries(file.overrides).filter(([, v]) => typeof v === "string")) : undefined;
  return { query: { expr: read.expr, filters }, name: typeof file.name === "string" && file.name ? file.name : undefined, connectors: strings(file.connectors), overrides: overrides && Object.keys(overrides).length ? overrides : undefined };
}

/** Looks like a database's own boolean query (pasted from PubMed, Scopus …) rather than a term list. */
export const looksBoolean = (text: string) => /\b(AND|OR|NOT)\b|\[[a-z]{2,}[^\]]*\]|\b(TITLE-ABS-KEY|TS|TI|AB)\s*=?\s*\(/i.test(text) && /\b(AND|NOT)\b|\[|\(/.test(text);

/** Old-style concept list, for code that still thinks in concepts. */
export const conceptsOf = (q: DbQuery): Concept[] => q.expr.items.filter((n): n is QGroup => n.type === "group" && !n.not).map((g) => ({ id: g.id, label: g.label, terms: terms(g) }));

// ── Templates to learn from ──────────────────────────────────────────────────────────

export interface QueryTemplate {
  id: string;
  title: string;
  about: string;
  connectors: string[];
  build: () => DbQuery;
}
const block = (label: string, words: string[], field: TermField = "title_abstract") => group("or", words.map((t) => makeTerm(t, { field })), { label });
export const TEMPLATES: QueryTemplate[] = [
  {
    id: "pico",
    title: "A health question (PICO)",
    about: "Population, intervention and outcome as three concepts, with a MeSH heading beside the free-text words.",
    connectors: ["pubmed", "europepmc"],
    build: () => ({
      expr: group("and", [
        group("or", [makeTerm("Adolescent", { field: "subject", mode: "phrase" }), ...["adolescen*", "teenager*", "young people"].map((t) => makeTerm(t))], { label: "Population" }),
        block("Intervention", ["mindfulness", "meditation", "acceptance and commitment therapy"]),
        block("Outcome", ["anxiety", "depress*", "wellbeing"]),
        { ...makeTerm("protocol", { field: "title" }), not: true },
      ]),
      filters: { yearFrom: 2015, types: ["article", "review"] },
    }),
  },
  {
    id: "nested",
    title: "Nested logic",
    about: "Groups inside groups: (health OR doctor) AND ((AI OR machine learning) NOT regression). Each database gets what it can run; Key checks the rest.",
    connectors: ["pubmed", "openalex", "crossref"],
    build: () => ({
      expr: group("and", [
        block("Setting", ["health", "doctor*"]),
        group("and", [block("Method", ["artificial intelligence", "machine learning"]), { ...makeTerm("regression"), not: true }], { label: "Method" }),
      ]),
      filters: { yearFrom: 2018 },
    }),
  },
  {
    id: "policy",
    title: "An economics question",
    about: "Two concepts for working papers and grey literature, where synonyms matter more than subject headings.",
    connectors: ["nber", "worldbank", "iza", "openalex"],
    build: () => ({ expr: group("and", [block("Intervention", ["cash transfer*", "conditional cash", "social protection"]), block("Outcome", ["school enrol*", "attendance", "education outcome*"])]), filters: { yearFrom: 2000 } }),
  },
  {
    id: "trials",
    title: "Find trials of a treatment",
    about: "A condition and a treatment, limited to trial registrations: what was planned and is still running.",
    connectors: ["clinicaltrials", "pubmed"],
    build: () => ({ expr: group("and", [block("Condition", ["type 2 diabetes", "T2DM"]), block("Treatment", ["metformin", "SGLT2 inhibitor*"])]), filters: { yearFrom: 2018 } }),
  },
];
