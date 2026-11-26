// Sample data for database search while the build's host has no database engine (and for the
// smokes, KEY_DB_SEARCH_MOCK=1): the connectors of connectors/COMMANDS.md with made-up but
// stable counts and records, so every screen can be used and checked. Nothing here touches
// the network. Adding to the library goes through the real library commands.
import { cleanQuery, makeTerm, newId } from "./db-query";
import type { Concept, DbConnector, DbQuery, DbRecord, DbSearchApi, Estimate, ParsedQuery, Progress, QueryTerm, ReportFile, RunPage, RunSummary, SavedSearch, TermField, TermSuggestion, Translation } from "./db-search-api";
import type { Invoke } from "./library-api";

const ALL: TermField[] = ["all", "title", "title_abstract", "abstract", "keywords", "subject", "fulltext", "author", "journal", "affiliation", "identifier"];
const BASIC: TermField[] = ["all", "title", "title_abstract", "abstract", "author"];
type Spec = Pick<DbConnector, "id" | "name" | "category" | "coverage" | "homepage"> & Partial<DbConnector> & { fields?: TermField[]; proximity?: boolean; filters?: string[]; size?: number };
const spec = (s: Spec): DbConnector => ({
  description: s.coverage,
  version: "2026.11.1",
  kind: s.manual ? "manual" : "api",
  credentials: [],
  needsKey: false,
  hasKey: true,
  manual: false,
  options: [],
  health: { state: "ok", failures: 0, lastOkAt: Date.now() - 3_600_000 },
  updatedAt: Date.parse("2026-11-20T09:00:00Z"),
  origin: "baseline",
  ...s,
  supports: { fields: s.fields ?? BASIC, phrase: true, truncation: true, proximity: !!s.proximity, dates: "year", filters: s.filters ?? ["types"], maxResults: 10000, sort: ["relevance", "date"] },
});
const keyed = (id: string, label: string, url: string) => ({ needsKey: true, hasKey: false, credentials: [{ id: "apiKey", label, required: true, secret: `db.${id}.apiKey`, url, present: false }] });
const manualInfo = (url: string) => ({ manual: true, manualInfo: { url, steps: ["Open the search page", "Paste the query", "Export the results as RIS and import them into Key"], exportFormats: ["RIS"] } });

export const MOCK_CONNECTORS: DbConnector[] = [
  spec({ id: "pubmed", name: "PubMed", category: "health", coverage: "Biomedical and life-science journals from MEDLINE, with MeSH subject headings.", homepage: "https://pubmed.ncbi.nlm.nih.gov", fields: ["all", "title", "title_abstract", "abstract", "subject", "author", "journal", "affiliation", "identifier"], proximity: true, filters: ["types", "languages"], size: 3 }),
  spec({ id: "europepmc", name: "Europe PMC", category: "health", coverage: "PubMed plus preprints, patents and European funders' full texts.", homepage: "https://europepmc.org", fields: ALL, filters: ["types", "languages", "openAccess"], size: 3.2 }),
  spec({ id: "scopus", name: "Scopus", category: "multidisciplinary", coverage: "Elsevier's citation index across sciences, social sciences and humanities.", homepage: "https://www.scopus.com", fields: ["all", "title", "title_abstract", "abstract", "keywords", "author", "journal", "affiliation"], proximity: true, filters: ["types", "languages", "openAccess"], size: 4, ...keyed("scopus", "Scopus API key", "https://dev.elsevier.com") }),
  spec({ id: "wos", name: "Web of Science", category: "multidisciplinary", coverage: "Clarivate's curated citation index of journals and proceedings.", homepage: "https://www.webofscience.com", fields: ["all", "title", "title_abstract", "author", "journal", "affiliation"], filters: ["types", "languages"], size: 3.5, ...keyed("wos", "Web of Science API key", "https://developer.clarivate.com") }),
  spec({ id: "openalex", name: "OpenAlex", category: "multidisciplinary", coverage: "An open index of 250 million works across every field.", homepage: "https://openalex.org", fields: ["all", "title", "title_abstract", "abstract", "fulltext", "author", "journal"], filters: ["types", "languages", "openAccess"], size: 6 }),
  spec({ id: "crossref", name: "Crossref", category: "multidisciplinary", coverage: "Every work with a DOI, from publishers' own records; few abstracts.", homepage: "https://www.crossref.org", size: 5 }),
  spec({ id: "europepmc-preprints", name: "Europe PMC preprints", category: "preprints", coverage: "Preprints from bioRxiv, medRxiv, Research Square and others.", homepage: "https://europepmc.org", fields: ["all", "title", "title_abstract", "abstract", "author"], size: 1.2 }),
  spec({ id: "nber", name: "NBER working papers", category: "economics", coverage: "Working papers of the National Bureau of Economic Research.", homepage: "https://www.nber.org", size: 0.8 }),
  spec({ id: "worldbank", name: "World Bank documents", category: "economics", coverage: "Policy research working papers and reports of the World Bank.", homepage: "https://documents.worldbank.org", size: 1.1 }),
  spec({ id: "iza", name: "IZA discussion papers", category: "economics", coverage: "Labour economics discussion papers from the IZA Institute.", homepage: "https://www.iza.org", size: 0.6 }),
  spec({ id: "idb", name: "IDB publications", category: "economics", coverage: "Inter-American Development Bank working papers and reports.", homepage: "https://publications.iadb.org", size: 0.5, health: { state: "outdated", failures: 3, lastError: "The listing page changed (HTTP 404)", lastFailAt: Date.now() - 86_400_000 } }),
  spec({ id: "wider", name: "UNU-WIDER", category: "economics", coverage: "Working papers on development economics from UNU-WIDER.", homepage: "https://www.wider.unu.edu", size: 0.4 }),
  spec({ id: "ssrn", name: "SSRN", category: "economics", coverage: "Social science preprints and working papers. No API: opens SSRN's own search.", homepage: "https://www.ssrn.com", ...manualInfo("https://papers.ssrn.com/sol3/results.cfm") }),
  spec({ id: "econstor", name: "EconStor", category: "economics", coverage: "Open-access economics papers from ZBW's repository.", homepage: "https://www.econstor.eu", size: 0.7 }),
  spec({ id: "ipa", name: "Innovations for Poverty Action", category: "grey", coverage: "Studies and briefs of IPA's evaluations. No API: opens IPA's search.", homepage: "https://poverty-action.org", ...manualInfo("https://poverty-action.org/search") }),
  spec({ id: "jpal", name: "J-PAL evaluations", category: "grey", coverage: "Randomised evaluations summarised by J-PAL.", homepage: "https://www.povertyactionlab.org", size: 0.3 }),
  spec({ id: "3ie", name: "3ie Development Evidence Portal", category: "grey", coverage: "Impact evaluations and systematic reviews in development.", homepage: "https://developmentevidence.3ieimpact.org", size: 0.4 }),
  spec({ id: "aearct", name: "AEA RCT Registry", category: "trials", coverage: "Registered randomised trials in economics and social science.", homepage: "https://www.socialscienceregistry.org", size: 0.3 }),
  spec({ id: "clinicaltrials", name: "ClinicalTrials.gov", category: "trials", coverage: "Registered clinical studies worldwide, with their status and results.", homepage: "https://clinicaltrials.gov", fields: ["all", "title", "title_abstract", "subject"], filters: [], size: 0.9 }),
];

// ── A stable pseudo-random number per string ─────────────────────────────────────────

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
const rand = (seed: string) => (hash(seed) % 10_000) / 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Translation ──────────────────────────────────────────────────────────────────────

const PUBMED_TAG: Partial<Record<TermField, string>> = { title: "ti", title_abstract: "tiab", abstract: "ab", subject: "MeSH Terms", author: "au", journal: "ta", affiliation: "ad", identifier: "aid", all: "all" };
const SCOPUS_FN: Partial<Record<TermField, string>> = { title: "TITLE", title_abstract: "TITLE-ABS-KEY", abstract: "ABS", keywords: "KEY", author: "AUTH", journal: "SRCTITLE", affiliation: "AFFIL", all: "ALL" };
const WOS_TAG: Partial<Record<TermField, string>> = { title: "TI", title_abstract: "TS", author: "AU", journal: "SO", affiliation: "OG", all: "ALL" };

function wordOf(t: QueryTerm, quote = '"') {
  const text = t.text + (t.truncate ? "*" : "");
  return t.mode === "phrase" && /\s/.test(t.text) ? `${quote}${text}${quote}` : text;
}
const or = (parts: string[]) => (parts.length > 1 ? `(${parts.join(" OR ")})` : (parts[0] ?? ""));

function translateFor(c: DbConnector, q: DbQuery): Translation {
  const warnings = new Set<string>();
  const fieldOf = (t: QueryTerm): TermField => {
    if (c.supports.fields.includes(t.field)) return t.field;
    const fallback: TermField = t.field === "subject" || t.field === "keywords" || t.field === "fulltext" ? "title_abstract" : "all";
    const to = c.supports.fields.includes(fallback) ? fallback : "all";
    warnings.add(`${c.name} cannot search ${label(t.field)}: “${t.text}” is looked for in ${label(to)} instead.`);
    return to;
  };
  const check = (t: QueryTerm) => {
    if (t.proximity && !c.supports.proximity) warnings.add(`${c.name} ignores proximity here: “${t.text}” is searched as a phrase.`);
  };
  const render = (t: QueryTerm) => {
    check(t);
    const field = fieldOf(t);
    if (c.id === "pubmed" || c.id === "europepmc") {
      if (t.proximity && c.id === "pubmed") return `"${t.text}"[${PUBMED_TAG[field] ?? "tiab"}:~${t.proximity}]`;
      return `${wordOf(t)}[${PUBMED_TAG[field] ?? "all"}]`;
    }
    if (c.id === "scopus") {
      if (t.proximity) {
        const words = t.text.split(/\s+/);
        return `${SCOPUS_FN[field] ?? "ALL"}(${words[0]} W/${t.proximity} ${words.slice(1).join(" ")})`;
      }
      return `${SCOPUS_FN[field] ?? "ALL"}(${wordOf(t)})`;
    }
    if (c.id === "wos") return `${WOS_TAG[field] ?? "ALL"}=(${wordOf(t)})`;
    if (c.id === "openalex") return field === "title" ? `title.search:${wordOf(t)}` : field === "title_abstract" ? `title_and_abstract.search:${wordOf(t)}` : wordOf(t);
    return wordOf(t);
  };
  const clean = cleanQuery(q);
  let native = clean.concepts.map((concept) => or(concept.terms.map(render))).join(" AND ");
  if (clean.exclude.length) native += ` NOT ${or(clean.exclude.map(render))}`;
  const f = clean.filters;
  if (f.yearFrom || f.yearTo) {
    if (c.id === "pubmed") native += ` AND ${f.yearFrom ?? 1800}:${f.yearTo ?? 3000}[dp]`;
    else if (c.id === "scopus") native += `${f.yearFrom ? ` AND PUBYEAR > ${f.yearFrom - 1}` : ""}${f.yearTo ? ` AND PUBYEAR < ${f.yearTo + 1}` : ""}`;
    else if (c.id === "wos") native += ` AND PY=(${f.yearFrom ?? 1900}-${f.yearTo ?? 2100})`;
  }
  if (f.types?.length && !c.supports.filters.includes("types")) warnings.add(`${c.name} cannot limit by document type: every type is listed.`);
  if (f.languages?.length && !c.supports.filters.includes("languages")) warnings.add(`${c.name} cannot limit by language.`);
  if (f.openAccess && !c.supports.filters.includes("openAccess")) warnings.add(`${c.name} cannot limit to open access: Key filters the results instead.`);
  if (c.manual) warnings.add(`${c.name} has no API: Key opens its search with this query, and you import what you export from there.`);
  const max = c.id === "wos" ? 4000 : c.id === "nber" || c.id === "iza" ? 256 : undefined;
  return { connector: c.id, native, chunks: [native], mode: c.supports.fields.length > 5 ? "native" : "terms", warnings: [...warnings], length: native.length, ...(max ? { maxLength: max } : {}) };
}
const label = (f: TermField) => ({ all: "any field", title: "titles", title_abstract: "titles and abstracts", abstract: "abstracts", keywords: "keywords", subject: "subject headings", fulltext: "full texts", author: "authors", journal: "journal names", affiliation: "affiliations", identifier: "identifiers" })[f];

// ── Counts ───────────────────────────────────────────────────────────────────────────

/** A term's made-up hit count in a database: shorter, truncated, broad-field terms find more. */
function termCount(c: DbConnector, t: QueryTerm) {
  const base = 400 + rand(`${c.id}:${t.text.toLowerCase()}`) * 60_000;
  const breadth = t.truncate ? 2.2 : 1;
  const field = t.field === "title" ? 0.25 : t.field === "subject" ? 0.6 : t.field === "all" || t.field === "fulltext" ? 2.5 : 1;
  const phrase = t.mode === "phrase" && /\s/.test(t.text) ? 0.35 : 1;
  return base * breadth * field * phrase * ((c as { size?: number }).size ?? 1);
}
function conceptCount(c: DbConnector, concept: Concept) {
  return concept.terms.reduce((sum, t, i) => sum + termCount(c, t) * (i ? 0.7 : 1), 0);
}
function totalFor(c: DbConnector, q: DbQuery) {
  const clean = cleanQuery(q);
  if (!clean.concepts.length || c.manual) return { total: undefined, perConcept: [] as number[] };
  const perConcept = clean.concepts.map((concept) => Math.round(conceptCount(c, concept)));
  // Each further concept keeps a share of what the others found.
  let total = perConcept[0];
  for (const n of perConcept.slice(1)) total *= Math.min(0.9, (n / 250_000) * 6 + 0.01);
  if (clean.exclude.length) total *= 0.9;
  const f = clean.filters;
  if (f.yearFrom || f.yearTo) total *= Math.min(1, ((f.yearTo ?? 2026) - (f.yearFrom ?? 1950)) / 60);
  if (f.types?.length) total *= Math.min(1, f.types.length * 0.35);
  if (f.languages?.length) total *= 0.8;
  if (f.openAccess) total *= 0.45;
  return { total: Math.max(0, Math.round(total)), perConcept };
}

// ── Records ──────────────────────────────────────────────────────────────────────────

const VENUES = ["The Lancet", "BMJ", "PLOS ONE", "Journal of Development Economics", "American Economic Review", "Social Science & Medicine", "JAMA Pediatrics", "World Development", "BMC Public Health", "Health Economics"];
const NAMES = ["Ada Okafor", "Lena Fischer", "Rahul Mehta", "Sofia Rossi", "Kenji Sato", "Maria García", "Tom Becker", "Amina Diallo", "Chen Wei", "Laura Smith", "Jonas Berg", "Priya Nair"];
const TYPES_BY: Record<string, string> = { nber: "working-paper", worldbank: "working-paper", iza: "working-paper", wider: "working-paper", econstor: "working-paper", "europepmc-preprints": "preprint", clinicaltrials: "trial", aearct: "trial", jpal: "report", "3ie": "report" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The work behind index `n` of the shared pool: databases that find the same `n` found the same work. */
function poolWork(q: DbQuery, n: number) {
  const clean = cleanQuery(q);
  const pick = (terms: QueryTerm[], salt: string) => terms[hash(salt) % Math.max(1, terms.length)]?.text ?? "evidence";
  const a = pick(clean.concepts[0]?.terms ?? [], `a${n}`);
  const b = clean.concepts[1] ? pick(clean.concepts[1].terms, `b${n}`) : "outcomes";
  const shapes = [`Effects of ${a} on ${b}: a randomised trial`, `${cap(a)} and ${b} in low- and middle-income countries`, `A systematic review of ${a} for ${b}`, `${cap(b)} after ${a}: evidence from a cohort study`, `Does ${a} improve ${b}? A meta-analysis`];
  const year = (clean.filters.yearFrom ?? 2005) + (hash(`y${n}`) % Math.max(1, (clean.filters.yearTo ?? 2026) - (clean.filters.yearFrom ?? 2005) + 1));
  const authors = [0, 1, 2].slice(0, 1 + (hash(`n${n}`) % 3)).map((i) => NAMES[hash(`au${n}:${i}`) % NAMES.length]);
  return {
    title: `${shapes[hash(`s${n}`) % shapes.length]}${n > 40 ? ` (${n})` : ""}`,
    authors,
    year,
    venue: VENUES[hash(`v${n}`) % VENUES.length],
    doi: hash(`d${n}`) % 7 ? `10.5555/mock.${hash(queryText(q)) % 10_000}.${n}` : undefined,
    abstract: hash(`ab${n}`) % 5 ? `Background: ${cap(a)} is widely used, yet its effect on ${b} is unclear. Methods: we studied ${200 + (hash(`m${n}`) % 4000)} participants. Results: ${a} was associated with better ${b}. Conclusions: the evidence supports further trials.` : undefined,
    openAccess: hash(`oa${n}`) % 3 === 0,
    language: hash(`l${n}`) % 9 ? "en" : "de",
  };
}
const queryText = (q: DbQuery) => JSON.stringify(cleanQuery(q));

interface MockRun {
  runId: string;
  label?: string;
  savedId?: string;
  query: DbQuery;
  connectors: DbConnector[];
  overrides: Record<string, string>;
  startedAt: number;
  finishedAt?: number;
  state: RunPage["state"];
  progress: Progress[];
  /** Per connector: the pool indexes it found, in rank order. */
  found: Record<string, number[]>;
  previous?: Set<string>;
}

function buildRecord(run: MockRun, n: number, connector: string, rank: number): DbRecord {
  const w = poolWork(run.query, n);
  const key = w.doi ? `doi:${w.doi}` : `n:${n}`;
  return {
    key,
    provider: connector,
    providerId: connector === "pubmed" ? String(30_000_000 + n) : w.doi ?? `${connector}-${n}`,
    title: w.title,
    authors: w.authors,
    year: w.year,
    venue: TYPES_BY[connector] === "working-paper" ? `${MOCK_CONNECTORS.find((c) => c.id === connector)?.name}` : w.venue,
    abstract: w.abstract,
    doi: w.doi,
    ids: connector === "pubmed" ? { pmid: String(30_000_000 + n) } : connector === "openalex" ? { openalex: `W${4_000_000_000 + n}` } : {},
    landingUrl: w.doi ? `https://doi.org/${w.doi}` : `https://example.org/${connector}/${n}`,
    pdfUrl: w.openAccess ? `https://example.org/${connector}/${n}.pdf` : undefined,
    type: TYPES_BY[connector] ?? (/review|meta-analysis/i.test(w.title) ? "review" : "article"),
    language: w.language,
    foundBy: [connector],
    provenance: [{ connector, version: "2026.11.1", sourceId: String(n), query: run.overrides[connector] ?? translateFor(run.connectors.find((c) => c.id === connector)!, run.query).native, at: run.startedAt, rank }],
    duplicates: 0,
    ...(run.previous && !run.previous.has(key) ? { isNew: true } : {}),
  };
}

function records(run: MockRun, dedupe: boolean, connector?: string): DbRecord[] {
  const all: DbRecord[] = [];
  for (const p of run.progress) {
    if (connector && p.connector !== connector) continue;
    const found = run.found[p.connector] ?? [];
    found.slice(0, p.fetched).forEach((n, rank) => all.push(buildRecord(run, n, p.connector, rank)));
  }
  if (!dedupe) return all.sort((a, b) => a.provenance[0].rank - b.provenance[0].rank);
  const merged = new Map<string, DbRecord>();
  for (const r of all) {
    const have = merged.get(r.key);
    if (!have) merged.set(r.key, r);
    else {
      have.foundBy.push(...r.foundBy);
      have.provenance.push(...r.provenance);
      have.duplicates++;
      have.ids = { ...r.ids, ...have.ids };
      have.abstract ??= r.abstract;
    }
  }
  return [...merged.values()].sort((a, b) => Math.min(...a.provenance.map((p) => p.rank)) - Math.min(...b.provenance.map((p) => p.rank)));
}

// ── A boolean string pasted from PubMed, Scopus or Web of Science ────────────────────

type Node = { kind: "term"; term: QueryTerm } | { kind: "and" | "or"; items: Node[] } | { kind: "not"; left: Node; right: Node };
const PUBMED_FIELD: Record<string, TermField> = { tiab: "title_abstract", "title/abstract": "title_abstract", ti: "title", title: "title", ab: "abstract", abstract: "abstract", mh: "subject", mesh: "subject", "mesh terms": "subject", majr: "subject", au: "author", author: "author", ta: "journal", journal: "journal", ad: "affiliation", affiliation: "affiliation", tw: "title_abstract", all: "all", "all fields": "all", ot: "keywords" };
const SCOPUS_FIELD: Record<string, TermField> = { "TITLE-ABS-KEY": "title_abstract", "TITLE-ABS": "title_abstract", TITLE: "title", ABS: "abstract", KEY: "keywords", AUTHKEY: "keywords", AUTH: "author", AUTHOR: "author", SRCTITLE: "journal", AFFIL: "affiliation", ALL: "all", TS: "title_abstract", TI: "title", AB: "abstract", AK: "keywords", AU: "author", SO: "journal", OG: "affiliation", AD: "affiliation" };

/** Reads a pasted boolean query into blocks where its shape allows (an AND of ORs, NOTs). */
export function parseBoolean(text: string): ParsedQuery {
  const tokens = text.match(/"[^"]*"(\[[^\]]*\])?|\(|\)|\[[^\]]*\]|[A-Z-]+\s*=\s*\(|[A-Z][A-Z-]+\(|[^\s()"]+(\[[^\]]*\])?/g) ?? [];
  let at = 0;
  const warnings: string[] = [];
  const peek = () => tokens[at];
  const leaf = (raw: string, field: TermField): Node => {
    let tag: string | undefined;
    const m = /^(.*?)\[([^\]]*)\]$/.exec(raw);
    if (m) {
      raw = m[1];
      tag = m[2].toLowerCase().replace(/:.*$/, "").replace(/:noexp$/, "").trim();
    }
    const prox = /:~(\d+)/.exec(m?.[2] ?? "");
    const f = tag ? (PUBMED_FIELD[tag] ?? (warnings.push(`Unknown field [${tag}] read as anywhere`), "all")) : field;
    const term = makeTerm(raw, { field: f });
    if (/^".*"$/.test(raw.trim())) term.mode = "phrase";
    if (prox) term.proximity = Number(prox[1]);
    return { kind: "term", term };
  };
  const primary = (field: TermField): Node | undefined => {
    const t = tokens[at++];
    if (t === undefined) return undefined;
    if (t === "(") {
      const inner = expr(field);
      if (tokens[at] === ")") at++;
      // A tag after the parenthesis applies to everything in it: (a OR b)[tiab].
      return inner;
    }
    const fn = /^([A-Z][A-Z-]*)\s*=?\s*\($/.exec(t);
    if (fn) {
      const f = SCOPUS_FIELD[fn[1]] ?? (warnings.push(`Unknown field ${fn[1]} read as anywhere`), "all");
      const inner = expr(f);
      if (tokens[at] === ")") at++;
      return inner;
    }
    return leaf(t, field);
  };
  const isOp = (t: string | undefined, op: string) => t?.toUpperCase() === op || (op === "NOT" && t?.toUpperCase() === "AND" && tokens[at + 1]?.toUpperCase() === "NOT");
  const orExpr = (field: TermField): Node | undefined => {
    const items: Node[] = [];
    let p = primary(field);
    if (p) items.push(p);
    while (peek()?.toUpperCase() === "OR") {
      at++;
      p = primary(field);
      if (p) items.push(p);
    }
    return items.length > 1 ? { kind: "or", items } : items[0];
  };
  const expr = (field: TermField): Node | undefined => {
    let left = orExpr(field);
    const ands: Node[] = left ? [left] : [];
    while (at < tokens.length && peek() !== ")") {
      if (isOp(peek(), "NOT")) {
        at += peek()?.toUpperCase() === "AND" ? 2 : 1;
        const right = orExpr(field);
        const base: Node = ands.length > 1 ? { kind: "and", items: [...ands] } : ands[0];
        if (right && base) {
          ands.splice(0, ands.length, { kind: "not", left: base, right });
        }
        continue;
      }
      if (peek()?.toUpperCase() === "AND") at++;
      left = orExpr(field);
      if (left) ands.push(left);
    }
    return ands.length > 1 ? { kind: "and", items: ands } : ands[0];
  };
  let root: Node | undefined;
  try {
    root = expr("title_abstract");
  } catch {
    root = undefined;
  }
  if (!root || at < tokens.length) return { raw: text, error: "Key could not read this query into blocks; it is kept as the database's own query." };
  const flatTerms = (n: Node): QueryTerm[] | undefined => (n.kind === "term" ? [n.term] : n.kind === "or" ? n.items.reduce<QueryTerm[] | undefined>((all, i) => { const t = flatTerms(i); return all && t ? [...all, ...t] : undefined; }, []) : undefined);
  const conceptsOf = (n: Node): QueryTerm[][] | undefined => {
    if (n.kind === "and") return n.items.reduce<QueryTerm[][] | undefined>((all, i) => { const c = conceptsOf(i); return all && c ? [...all, ...c] : undefined; }, []);
    const t = flatTerms(n);
    return t ? [t] : undefined;
  };
  let exclude: QueryTerm[] = [];
  let main = root;
  if (root.kind === "not") {
    const ex = flatTerms(root.right);
    if (!ex) return { raw: text, error: "The NOT part is too complex to show as blocks; the query is kept as the database's own." };
    exclude = ex;
    main = root.left;
  }
  const concepts = conceptsOf(main);
  if (!concepts) return { raw: text, error: "This query nests AND inside OR, which blocks cannot show; it is kept as the database's own query." };
  return { query: { concepts: concepts.map((terms) => ({ id: newId("c"), terms })), exclude, filters: {} }, warnings };
}

// ── The API ──────────────────────────────────────────────────────────────────────────

const MESH = ["Adolescent", "Child", "Mindfulness", "Meditation", "Anxiety", "Depression", "Diabetes Mellitus, Type 2", "Metformin", "Cash Transfer", "Poverty", "Schools", "Education", "Exercise", "Sleep", "Obesity", "Mental Health", "Social Support", "Randomized Controlled Trials as Topic"];

export function mockDbSearchApi(invoke: Invoke, workspaceId: string): DbSearchApi {
  const runs = new Map<string, MockRun>();
  const cancelled = new Set<string>();
  const savedKey = `key.dbSearch.mockSaved:${workspaceId}`;
  const readSaved = (): SavedSearch[] => {
    try {
      return JSON.parse(localStorage.getItem(savedKey) ?? "[]");
    } catch {
      return [];
    }
  };
  const writeSaved = (list: SavedSearch[]) => {
    try {
      localStorage.setItem(savedKey, JSON.stringify(list));
    } catch {}
  };
  const connectorsById = (ids: string[]) => ids.map((id) => MOCK_CONNECTORS.find((c) => c.id === id)).filter((c): c is DbConnector => !!c);

  const tick = (run: MockRun) => {
    if (run.state !== "running") return;
    for (const p of run.progress) {
      if (p.state === "done" || p.state === "skipped" || p.state === "cancelled" || p.state === "failed") continue;
      const goal = Math.min(p.total ?? 0, 500);
      if (p.state === "waiting") {
        p.waitMs = Math.max(0, (p.waitMs ?? 0) - 250);
        if (!p.waitMs) p.state = "running";
        continue;
      }
      p.state = "running";
      p.requests++;
      p.fetched = Math.min(goal, p.fetched + 50 + (hash(`${p.connector}${p.requests}`) % 60));
      // One database makes Key wait for its rate limit once.
      if (p.connector === "scopus" || (p.requests === 2 && p.connector === "pubmed")) {
        if (p.requests === 2) {
          p.state = "waiting";
          p.waitMs = 1200;
        }
      }
      if (p.fetched >= goal) {
        p.state = "done";
        p.hasMore = (p.total ?? 0) > p.fetched;
      }
    }
    if (run.progress.every((p) => p.state !== "running" && p.state !== "waiting" && p.state !== "queued")) {
      run.state = "done";
      run.finishedAt = Date.now();
      if (run.savedId) {
        const keys = records(run, true).map((r) => r.key);
        const list = readSaved().map((s) => (s.id === run.savedId ? { ...s, lastRunAt: run.finishedAt, lastRunId: run.runId, lastCount: keys.length, newCount: run.previous ? keys.filter((k) => !run.previous!.has(k)).length : 0, lastKeys: keys } : s));
        writeSaved(list);
      }
    } else setTimeout(() => tick(run), 250);
  };

  const start: DbSearchApi["start"] = async ({ query, connectors, overrides, label, savedId }) => {
    const list = connectorsById(connectors);
    const runId = newId("run");
    const previousKeys = savedId ? (readSaved().find((s) => s.id === savedId) as (SavedSearch & { lastKeys?: string[] }) | undefined)?.lastKeys : undefined;
    const run: MockRun = {
      runId,
      label,
      savedId,
      query: cleanQuery(query),
      connectors: list,
      overrides,
      startedAt: Date.now(),
      state: "running",
      progress: list.map((c) => {
        const { total } = totalFor(c, query);
        const blocked = c.manual || (c.needsKey && !c.hasKey);
        return { connector: c.id, state: blocked ? "skipped" : "queued", fetched: 0, total: blocked ? undefined : total, native: overrides[c.id] ?? translateFor(c, query).native, chunks: 1, hasMore: false, requests: 0, ...(blocked ? { error: c.manual ? "Opens in the browser: no API" : "Needs an API key in Key Settings" } : {}) };
      }),
      found: {},
      previous: previousKeys ? new Set(previousKeys) : undefined,
    };
    // Each database finds a share of one pool, overlapping with the others; a re-run finds a few more.
    const extra = savedId && previousKeys ? 6 : 0;
    for (const c of list) {
      const size = Math.min(run.progress.find((p) => p.connector === c.id)?.total ?? 0, 500);
      const offset = hash(c.id) % 40;
      run.found[c.id] = Array.from({ length: size + extra }, (_, i) => (i < extra ? 5000 + i : offset + Math.floor((i - extra) * (1.2 + rand(c.id)))));
    }
    runs.set(runId, run);
    setTimeout(() => tick(run), 200);
    return { runId };
  };

  const page = (run: MockRun, dedupe: boolean, offset: number, limit: number, connector?: string): RunPage => {
    const all = records(run, dedupe, connector);
    const fetched = run.progress.reduce((s, p) => s + p.fetched, 0);
    const unique = dedupe ? all.length : records(run, true).length;
    return { runId: run.runId, state: run.state, progress: run.progress.map((p) => ({ ...p })), records: all.slice(offset, offset + limit), total: all.length, fetched, duplicatesRemoved: fetched - unique, startedAt: run.startedAt, finishedAt: run.finishedAt };
  };

  const reportOf = (run: MockRun) => {
    const p = page(run, true, 0, 0);
    return {
      runId: run.runId,
      label: run.label,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      query: run.query,
      connectors: run.progress.map((pr) => ({ connector: pr.connector, name: MOCK_CONNECTORS.find((c) => c.id === pr.connector)?.name ?? pr.connector, version: "2026.11.1", native: pr.native, total: pr.total ?? null, fetched: pr.fetched, state: pr.state, error: pr.error })),
      fetched: p.fetched,
      duplicatesRemoved: p.duplicatesRemoved,
      unique: p.total,
    };
  };

  return {
    isMock: true,
    connectors: async () => {
      await sleep(60);
      return MOCK_CONNECTORS.map((c) => ({ ...c }));
    },
    translate: async (query, connectors, overrides = {}) => connectorsById(connectors).map((c) => (overrides[c.id] ? { ...translateFor(c, query), native: overrides[c.id], chunks: [overrides[c.id]], warnings: [] } : translateFor(c, query))),
    estimate: async (query, connectors, requestId) => {
      await sleep(350 + rand(requestId) * 400);
      if (cancelled.delete(requestId)) throw new Error("Cancelled");
      return connectorsById(connectors).map((c): Estimate => {
        if (c.manual) return { connector: c.id, exact: false, error: "No count: this database has no API" };
        if (c.needsKey && !c.hasKey) return { connector: c.id, exact: false, error: "Needs an API key" };
        const { total, perConcept } = totalFor(c, query);
        return { connector: c.id, total, perConcept, exact: c.id !== "crossref" };
      });
    },
    cancelEstimate: async (requestId) => void cancelled.add(requestId),
    start,
    results: async (runId, { dedupe, offset, limit, connector }) => {
      const run = runs.get(runId);
      if (!run) throw new Error("This search is no longer available. Run it again.");
      return page(run, dedupe, offset, limit, connector);
    },
    cancel: async (runId) => {
      const run = runs.get(runId);
      if (!run || run.state !== "running") return;
      run.state = "cancelled";
      run.finishedAt = Date.now();
      for (const p of run.progress) if (p.state === "running" || p.state === "waiting" || p.state === "queued") p.state = "cancelled";
    },
    more: async (runId) => {
      const run = runs.get(runId);
      if (!run) return;
      run.state = "running";
      run.finishedAt = undefined;
      for (const p of run.progress) if (p.state === "cancelled") p.state = "queued";
      setTimeout(() => tick(run), 100);
    },
    record: async (runId, key) => {
      const run = runs.get(runId);
      const record = run && records(run, true).find((r) => r.key === key);
      if (!run || !record) throw new Error("Not found");
      return { record, versions: records(run, false).filter((r) => r.key === key) };
    },
    addToLibrary: async (runId, keys, collectionId) => {
      const run = runs.get(runId);
      const wanted = new Set(keys);
      const list = run ? records(run, true).filter((r) => wanted.has(r.key)) : [];
      const results: { key: string; sourceId?: string; existed: boolean; error?: string }[] = [];
      for (const r of list) {
        try {
          const known = await invoke<{ sourceId: string; certain: boolean }[]>("store_match_identifiers", { works: [{ key: r.key, doi: r.doi, title: r.title, year: r.year }] }, workspaceId).catch(() => []);
          const existing = known.find((m) => m.certain);
          if (existing) {
            if (collectionId) await invoke("store_membership", { collectionId, ids: [existing.sourceId], present: true }, workspaceId).catch(() => {});
            results.push({ key: r.key, sourceId: existing.sourceId, existed: true });
            continue;
          }
          const source = await invoke<{ id: string }>(
            "store_create",
            {
              source: {
                kind: "reference",
                itemType: r.type === "working-paper" || r.type === "report" ? "report" : r.type === "preprint" ? "preprint" : "article",
                title: r.title,
                ...(r.doi ? { doi: r.doi } : {}),
                ...(r.year ? { year: r.year } : {}),
                ...(r.venue ? { containerTitle: r.venue } : {}),
                ...(r.abstract ? { abstract: r.abstract } : {}),
                ...(r.landingUrl ? { url: r.landingUrl } : {}),
                creators: r.authors.map((name) => {
                  const parts = name.split(/\s+/);
                  return { family: parts.at(-1), given: parts.slice(0, -1).join(" "), role: "author" };
                }),
                collections: collectionId ? [collectionId] : [],
                indexStatus: "skipped",
              },
            },
            workspaceId,
          );
          results.push({ key: r.key, sourceId: source.id, existed: false });
        } catch (error) {
          results.push({ key: r.key, existed: false, error: String(error) });
        }
      }
      return { added: results.filter((r) => r.sourceId && !r.existed).length, existed: results.filter((r) => r.existed).length, results };
    },
    parse: async (text) => parseBoolean(text),
    suggest: async (text) => {
      const q = text.trim().toLowerCase();
      if (q.length < 2) return [];
      return MESH.filter((m) => m.toLowerCase().includes(q))
        .slice(0, 5)
        .map((m): TermSuggestion => ({ text: m, from: "mesh", field: "subject" }));
    },
    saved: async () => readSaved(),
    save: async (search) => {
      const list = readSaved();
      const existing = search.id ? list.find((s) => s.id === search.id) : undefined;
      const next: SavedSearch = { ...existing, ...search, overrides: search.overrides ?? {}, id: existing?.id ?? newId("s"), createdAt: existing?.createdAt ?? Date.now() };
      writeSaved(existing ? list.map((s) => (s.id === next.id ? next : s)) : [next, ...list]);
      return next;
    },
    removeSaved: async (id) => writeSaved(readSaved().filter((s) => s.id !== id)),
    runSaved: async (id) => {
      const saved = readSaved().find((s) => s.id === id);
      if (!saved) throw new Error("This saved search no longer exists");
      return start({ query: saved.query, connectors: saved.connectors, overrides: saved.overrides, label: saved.name, savedId: id });
    },
    runs: async (limit = 20): Promise<RunSummary[]> =>
      [...runs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit)
        .map((r) => ({ runId: r.runId, label: r.label ?? "Search", startedAt: r.startedAt, finishedAt: r.finishedAt, state: r.state, total: records(r, true).length, perConnector: Object.fromEntries(r.progress.map((p) => [p.connector, p.fetched])) })),
    report: async (runId, format): Promise<ReportFile> => {
      const run = runs.get(runId);
      if (!run) throw new Error("This search is no longer available. Run it again.");
      const report = reportOf(run);
      if (format === "json") return { filename: "search-report.json", mime: "application/json", content: JSON.stringify(report, null, 2) };
      const rows = records(run, true);
      const csv = [["key", "title", "authors", "year", "venue", "doi", "found_by", "type"].join(","), ...rows.map((r) => [r.key, r.title, r.authors.join("; "), r.year ?? "", r.venue ?? "", r.doi ?? "", r.foundBy.join("; "), r.type ?? ""].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
      if (format === "csv") return { filename: "search-report.csv", mime: "text/csv", content: csv };
      return { filename: "search-report.md", mime: "text/markdown", content: "" };
    },
    reportProblem: async (connector, error) => ({ url: `https://github.com/key-app/connectors/issues/new?title=${encodeURIComponent(`${connector}: ${error ?? "problem"}`)}` }),
    checkUpdates: async () => {
      await sleep(400);
      return { state: "current", changed: [] };
    },
  };
}
