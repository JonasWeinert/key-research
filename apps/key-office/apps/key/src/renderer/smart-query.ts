// What a typed or pasted query looks like: a DOI, an arXiv id, a PMID, an ISBN, a link, a
// year or a range of years, a citation ("Smith et al. 2020"), a quoted title, a kind of
// item, or the name of a tag or collection. Each reading is only offered: the search
// field lists it above its suggestions and the query stays as typed until one is picked.
import type { SearchFilter } from "./search-suggest";

/** A kind of item the search tab narrows to (see global-search's FindKind). */
export type DetectedKind = "source" | "note" | "record" | "canvas" | "highlight";

export interface Detection {
  /** Stable id of the reading, for keys and tests ("doi", "years", "citation" …). */
  id: string;
  filters: SearchFilter[];
  /** Kinds the search tab should show (only offered where kinds can be picked). */
  kinds?: DetectedKind[];
  /** The query once the detected part is taken out (what is still searched as text). */
  rest: string;
}

export interface KnownNames {
  tags?: string[];
  collections?: { id: string; name: string }[];
}

export interface DetectOptions {
  known?: KnownNames;
  /** Whether a kind of item (notes, canvases …) can be picked here (the search tab). */
  kinds?: boolean;
}

const MIN_YEAR = 1500;
const MAX_YEAR = 2100;
const isYear = (y: number) => Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR;

const tidy = (text: string) =>
  text
    .replace(/\s+/g, " ")
    // Punctuation left on its own where something was taken out.
    .replace(/(^|\s)[.,;:!?)\]]+(?=\s|$)/g, "$1")
    .replace(/^[\s,;:.·-]+|[\s,;:·-]+$/g, "")
    .trim();
/** The query without `[start, end)`. */
const cut = (text: string, start: number, end: number) => tidy(`${text.slice(0, start)} ${text.slice(end)}`);

/** Sentence punctuation and unbalanced closing brackets after an identifier. */
function trimTail(value: string) {
  let v = value;
  for (;;) {
    const last = v.slice(-1);
    const count = (c: string) => v.split(c).length - 1;
    if (/[.,;:!?'"”’]/.test(last) || (last === ")" && count("(") < count(")")) || (last === "]" && count("[") < count("]"))) v = v.slice(0, -1);
    else return v;
  }
}

/** A DOI as typed or pasted: bare, "doi:"-prefixed or a doi.org link; lowercased. */
export function readDoi(input: string): { doi: string; start: number; end: number } | undefined {
  // Links escape the slash ("10.1038%2Fs41591…"). Offsets are into the unescaped text.
  const text = input.replace(/%2F/gi, "/");
  const match = /(?:https?:\/\/(?:dx\.)?doi\.org\/|\bdoi:\s*|\bdoi\s+)?(10\.\d{4,9}(?:\.\d+)*\/\S+)/i.exec(text);
  if (!match) return undefined;
  const doi = trimTail(match[1]);
  if (doi.length < doi.indexOf("/") + 2) return undefined;
  return { doi: doi.toLowerCase(), start: match.index, end: match.index + match[0].length - (match[1].length - doi.length) };
}

function isbnValid(digits: string) {
  if (digits.length === 13) {
    if (!/^97[89]\d{10}$/.test(digits)) return false;
    const sum = [...digits].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0;
  }
  if (digits.length === 10) {
    const sum = [...digits].reduce((s, d, i) => s + (d === "X" ? 10 : Number(d)) * (10 - i), 0);
    return /^\d{9}[\dX]$/.test(digits) && sum % 11 === 0;
  }
  return false;
}

const filter = (field: string, value: string, label: string, op: SearchFilter["op"] = "is"): SearchFilter => ({ field, op, value, label });

/** Identifiers: DOI, arXiv, PMID, PMCID, ISBN, then any other link. At most one. */
function identifier(query: string): Detection | undefined {
  const text = query.replace(/%2F/gi, "/");
  const doi = readDoi(text);
  // An arXiv DOI is better found by its arXiv id (that is how preprints are stored).
  if (doi && !doi.doi.startsWith("10.48550/arxiv.")) return { id: "doi", filters: [filter("doi", doi.doi, doi.doi)], rest: cut(text, doi.start, doi.end) };
  const arxiv =
    /(?:\barxiv:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/|\b10\.48550\/arxiv\.)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?/i.exec(text) ??
    /^(\d{4}\.\d{4,5})(?:v\d+)?$/.exec(text.trim());
  if (arxiv) {
    const start = text.indexOf(arxiv[0]);
    return { id: "arxiv", filters: [filter("arxiv", arxiv[1].toLowerCase(), arxiv[1])], rest: cut(text, start, start + arxiv[0].length) };
  }
  const pmcid = /\b(?:pmcid:\s*)?(PMC\d{4,9})\b/i.exec(text) ?? /https?:\/\/(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc\/articles\/(PMC\d{4,9})\/?/i.exec(text);
  if (pmcid) return { id: "pmcid", filters: [filter("pmcid", pmcid[1].toUpperCase(), pmcid[1].toUpperCase())], rest: cut(text, pmcid.index, pmcid.index + pmcid[0].length) };
  const pmid = /\bpmid:?\s*(\d{1,9})\b/i.exec(text) ?? /https?:\/\/(?:pubmed\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov\/pubmed)\/(\d{1,9})\/?/i.exec(text);
  if (pmid) return { id: "pmid", filters: [filter("pmid", pmid[1], pmid[1])], rest: cut(text, pmid.index, pmid.index + pmid[0].length) };
  // ISBN: labelled, or a number that checks out as one (13 digits from 978/979, or 10).
  const isbn = /\bisbn(?:-1[03])?:?\s*([\dX][\d\s-]{8,16}[\dX])\b/i.exec(text) ?? /(?<![\d-])(97[89][\d-]{10,14}\d|\d[\d-]{8,11}[\dX])(?![\d-])/i.exec(text);
  if (isbn) {
    const digits = isbn[1].replace(/[\s-]/g, "").toUpperCase();
    const labelled = /^isbn/i.test(isbn[0]);
    if (isbnValid(digits) && (labelled || digits.length === 13 || /-/.test(isbn[1]))) return { id: "isbn", filters: [filter("isbn", digits, digits)], rest: cut(text, isbn.index, isbn.index + isbn[0].length) };
  }
  // A bare PMID: a whole query of 6 to 9 digits (shorter ones are years, counts, pages).
  const bare = /^\s*(\d{6,9})\s*$/.exec(text);
  if (bare) return { id: "pmid", filters: [filter("pmid", bare[1], bare[1])], rest: "" };
  const url = /\b(?:https?:\/\/|www\.)[^\s<>"]+/i.exec(text);
  if (url) {
    const link = trimTail(url[0]);
    // Matched without its scheme, "www." and closing slash, as links are stored either way.
    const value = link.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/[/#?]+$/, "");
    if (value.includes(".")) return { id: "url", filters: [filter("url", value, value, "contains")], rest: cut(text, url.index, url.index + link.length) };
  }
  return undefined;
}

/** Years: "2015-2020", ">2018", ">= 2018", "since 2020", "before 2010", "2019". */
function years(text: string): Detection | undefined {
  const range = /(?<![\d.\/-])(\d{4})\s*(?:-|–|—|to|until)\s*(\d{4})(?![\d.\/-])/i.exec(text);
  if (range) {
    const [from, to] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
    if (isYear(from) && isYear(to) && from !== to)
      return {
        id: "years",
        filters: [filter("year", String(from), `${from} or later`, "gte"), filter("year", String(to), `${to} or earlier`, "lte")],
        rest: cut(text, range.index, range.index + range[0].length),
      };
  }
  const bound = /(?:^|\s)(>=|<=|>|<|≥|≤|since|from|after|before|until|till|up to|in or after|in or before)\s*(\d{4})(?![\d.\/-])/i.exec(text);
  if (bound && isYear(Number(bound[2]))) {
    const year = Number(bound[2]);
    const word = bound[1].toLowerCase();
    const [op, value, label]: [SearchFilter["op"], number, string] =
      word === ">" || word === "after"
        ? ["gte", year + 1, `${year + 1} or later`]
        : word === "<" || word === "before"
          ? ["lte", year - 1, `${year - 1} or earlier`]
          : [">=", "≥", "since", "from", "in or after"].includes(word)
            ? ["gte", year, `${year} or later`]
            : ["lte", year, `${year} or earlier`];
    const start = bound.index + bound[0].indexOf(bound[1]);
    return { id: "years", filters: [filter("year", String(value), label, op)], rest: cut(text, start, bound.index + bound[0].length) };
  }
  const single = /(?<![\d.\/-])(\d{4})(?![\d.\/-])/.exec(text);
  // A year alone is the store's own suggestion; within words it is a reading.
  if (single && isYear(Number(single[1])) && text.trim() !== single[1])
    return { id: "year", filters: [filter("year", single[1], single[1])], rest: cut(text, single.index, single.index + single[0].length) };
  return undefined;
}

const NAME = "[\\p{Lu}][\\p{L}'’-]+(?:[ -](?:van|von|de|der|den|da|di|le|la)?[ -]?[\\p{Lu}][\\p{L}'’-]+)?";
/** "Smith 2020", "Smith et al. 2020", "Smith and Jones (2019)", "Smith & Jones, 2019a". */
function citation(text: string): Detection | undefined {
  const pattern = new RegExp(`^\\s*(${NAME})(?:\\s+et\\s+al\\.?|\\s+(?:and|&)\\s+(${NAME}))?,?\\s+\\(?(\\d{4})[a-z]?\\)?\\s*$`, "u");
  const m = pattern.exec(text);
  if (!m || !isYear(Number(m[3]))) return undefined;
  const first = m[1];
  if (STOP.has(first.toLowerCase()) || KIND_WORDS.some(([w]) => w.test(first))) return undefined;
  const people = [first, m[2]].filter(Boolean).map((name) => filter("creator", name, name, "contains"));
  return { id: "citation", filters: [...people, filter("year", m[3], m[3])], rest: "" };
}
/** Words a query starts with that are not names. */
const STOP = new Set(["since", "from", "after", "before", "until", "in", "the", "a", "an", "of", "on", "for", "and", "or", "about", "year", "published", "papers", "paper", "articles", "article", "review", "reviews", "covid", "data"]);

/** "a phrase in quotes": the exact title. */
function quoted(text: string): Detection | undefined {
  const m = /["“„«]([^"“”„«»]{3,})["”«»]/.exec(text);
  if (!m) return undefined;
  const title = m[1].trim();
  return { id: "title", filters: [filter("title", title, title)], rest: cut(text, m.index, m.index + m[0].length) };
}

// Words naming a kind of item, with the library kind or the search tab's kind.
const KIND_WORDS: [RegExp, { kind?: string; label?: string; find?: DetectedKind }][] = [
  [/^pdfs?$/i, { kind: "pdf", label: "PDF" }],
  [/^(?:web ?pages?|websites?)$/i, { kind: "web", label: "Web page" }],
  [/^notes$/i, { find: "note" }],
  [/^highlights$/i, { find: "highlight" }],
  [/^canvas(?:es)?$/i, { find: "canvas" }],
];
function kindWord(text: string, kinds: boolean): Detection | undefined {
  const words = /(?:^|\s)(web\s+pages?|webpages?|websites?|pdfs?|notes|highlights|canvas(?:es)?)(?=\s|$)/gi;
  for (let m = words.exec(text); m; m = words.exec(text)) {
    const word = m[1];
    const entry = KIND_WORDS.find(([w]) => w.test(word.replace(/\s+/g, " ")));
    if (!entry) continue;
    const start = m.index + m[0].indexOf(word);
    const rest = cut(text, start, start + word.length);
    const { kind, label, find } = entry[1];
    if (kind) return { id: "kind", filters: [filter("kind", kind, label ?? kind)], rest };
    if (find && kinds) return { id: "kind", filters: [], kinds: [find], rest };
  }
  return undefined;
}

/** A tag ("#review" or its name) or a collection named in the query. */
function knownName(text: string, known: KnownNames | undefined): Detection | undefined {
  if (!known) return undefined;
  const lower = text.toLowerCase();
  const find = (name: string) => {
    const n = name.toLowerCase().trim();
    if (n.length < 3) return -1;
    let at = lower.indexOf(n);
    while (at >= 0) {
      const before = lower[at - 1];
      const after = lower[at + n.length];
      if ((!before || /[\s#]/.test(before)) && (!after || /\s/.test(after))) return before === "#" ? at - 1 : at;
      at = lower.indexOf(n, at + 1);
    }
    return -1;
  };
  // Whole-query names are already the store's suggestions; only names within a longer query.
  const within = (name: string) => lower.trim() !== name.toLowerCase().trim() && lower.trim() !== `#${name.toLowerCase().trim()}`;
  const longest = <T>(list: T[], name: (t: T) => string) => [...list].sort((a, b) => name(b).length - name(a).length).find((t) => find(name(t)) >= 0);
  const tag = longest(known.tags ?? [], (t) => t);
  const hashed = /(?:^|\s)#([\p{L}\d_-]+)/u.exec(text);
  if (hashed && !tag) {
    const start = hashed.index + hashed[0].indexOf("#");
    return { id: "tag", filters: [filter("tag", hashed[1], hashed[1])], rest: cut(text, start, start + hashed[1].length + 1) };
  }
  if (tag && (within(tag) || text.trim().startsWith("#"))) {
    const at = find(tag);
    const length = tag.length + (lower[at] === "#" ? 1 : 0);
    return { id: "tag", filters: [filter("tag", tag, tag)], rest: cut(text, at, at + length) };
  }
  const collection = longest(known.collections ?? [], (c) => c.name);
  if (collection && within(collection.name)) {
    const at = find(collection.name);
    return { id: "collection", filters: [filter("collection", collection.id, collection.name)], rest: cut(text, at, at + collection.name.length) };
  }
  return undefined;
}

/** Every reading of `text`, best first. An identifier stands alone; the others can combine. */
export function detectQuery(text: string, options: DetectOptions = {}): Detection[] {
  const query = text.trim();
  if (query.length < 3) return [];
  const id = identifier(query);
  if (id) return [id];
  const out: Detection[] = [];
  const cite = citation(query);
  if (cite) out.push(cite);
  for (const read of [quoted, years, (t: string) => kindWord(t, !!options.kinds), (t: string) => knownName(t, options.known)]) {
    if (cite && read === years) continue;
    const found = read(query);
    if (found) out.push(found);
  }
  // Several readings: also all at once ("pdf since 2020 malaria" → PDF, 2020 or later, "malaria").
  if (out.length > 1 && !cite) {
    let rest = query;
    const all: Detection = { id: "all", filters: [], kinds: undefined, rest: "" };
    for (const read of [quoted, years, (t: string) => kindWord(t, !!options.kinds), (t: string) => knownName(t, options.known)]) {
      const found = read(rest);
      if (!found) continue;
      all.filters.push(...found.filters);
      if (found.kinds) all.kinds = [...(all.kinds ?? []), ...found.kinds];
      rest = found.rest;
    }
    all.rest = rest;
    if (all.filters.length + (all.kinds?.length ?? 0) > 1) out.unshift(all);
  }
  return out;
}
