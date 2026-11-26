// Understands a library's tags, locally and deterministically: spelling and plural
// variants, initialisms, tags that always travel together or sit inside another, paths
// written into names ("methods/survey"), families that read as one property with values
// (reading status, ratings, years, languages…), junk, and theme groups found from the
// words of the tags and their items' titles (TF-IDF with a greedy cosine clustering).
// Everything runs as a generator so a caller can spread it over frames.

export interface TagCount {
  name: string;
  count: number;
}
export interface TagItem {
  id: string;
  title: string;
  year?: number | null;
  /** Indexes into `tags`. */
  tags: number[];
}
export interface TagMeta {
  parent?: string | null;
  color?: string | null;
}
export interface TagIndex {
  tags: TagCount[];
  items: TagItem[];
  sourceCount: number;
  tree: Record<string, TagMeta>;
}
export interface PropertyInfo {
  name: string;
  type: string;
  options?: string[];
}

export type SuggestionKind = "merge" | "nest" | "hierarchy" | "property" | "cleanup";

export type TagPlan =
  | { type: "merge"; from: string[]; to: string }
  | { type: "nest"; parent: string; children: string[] }
  | { type: "hierarchy"; splits: { tag: string; path: string[] }[] }
  | { type: "property"; name: string; propertyType: "boolean" | "select"; values: [string, string | boolean][]; removeTags: boolean }
  | { type: "delete"; tags: string[] };

export interface Suggestion {
  /** Stable across runs for the same tags, so a dismissal sticks. */
  id: string;
  kind: SuggestionKind;
  title: string;
  evidence: string;
  /** 0–1. */
  confidence: number;
  tags: string[];
  /** Sources the change touches. */
  items: number;
  plan: TagPlan;
}

// ── Normalisation ────────────────────────────────────────────────────────────

const PREFIX = /^[_#!@*+~.\-\s]+/;
const STOP = new Set(
  "a an and are as at be by for from has in into is it of on or that the this to was were with without via vs versus its their our your not no".split(" "),
);

/** Diacritics off, lower case. */
export function fold(text: string) {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** One word to its singular, for comparison only. */
export function singular(word: string) {
  if (word.length <= 3 || /\d/.test(word)) return word;
  if (/(ss|us|is|ics|sis|ous)$/.test(word)) return word;
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (/(ches|shes|xes|sses|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** British and American spellings to one form, for comparison only. */
function spelling(word: string) {
  return word
    .replace(/our$/, "or")
    .replace(/ise(d|s)?$/, "ize$1")
    .replace(/isation$/, "ization")
    .replace(/lling$/, "ling")
    .replace(/lled$/, "led")
    .replace(/([^aeiou])re$/, "$1er")
    .replace(/ogue$/, "og");
}

export interface Normal {
  /** Folded words, singular, with spelling unified. */
  words: string[];
  /** The words run together: equal for case, spacing, hyphen and plural variants. */
  squash: string;
  /** The words sorted: equal for reordered names. */
  sorted: string;
  prefixed: boolean;
}

export function normalize(tag: string): Normal {
  const folded = fold(tag.trim());
  const prefixed = PREFIX.test(folded);
  const words = folded
    .replace(PREFIX, "")
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => spelling(singular(w)));
  return { words, squash: words.join(""), sorted: [...words].sort().join(" "), prefixed };
}

// ── String similarity ────────────────────────────────────────────────────────

export function jaroWinkler(a: string, b: string) {
  if (a === b) return 1;
  const la = a.length,
    lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Uint8Array(la),
    mb = new Uint8Array(lb);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range),
      hi = Math.min(lb - 1, i + range);
    for (let j = lo; j <= hi; j++)
      if (!mb[j] && a[i] === b[j]) {
        ma[i] = mb[j] = 1;
        matches++;
        break;
      }
  }
  if (!matches) return 0;
  let t = 0,
    k = 0;
  for (let i = 0; i < la; i++)
    if (ma[i]) {
      while (!mb[k]) k++;
      if (a[i] !== b[k]) t++;
      k++;
    }
  const jaro = (matches / la + matches / lb + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Edit distance with transpositions, giving up beyond `max`. */
export function editDistance(a: string, b: string, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1).fill(0),
    prev = Array.from({ length: b.length + 1 }, (_, i) => i),
    cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    for (let j = 0; j <= b.length; j++) {
      prev2[j] = prev[j];
      prev[j] = cur[j];
    }
  }
  return prev[b.length];
}

// ── Built-in vocabularies ────────────────────────────────────────────────────

interface Family {
  property: string;
  /** Folded, normalised value → display value. */
  values: Record<string, string>;
  min: number;
}
const family = (property: string, min: number, values: string[]): Family => ({
  property,
  min,
  values: Object.fromEntries(
    values.flatMap((v) => {
      const [shown, ...aliases] = v.split("|");
      return [shown, ...aliases].map((alias) => [normalize(alias).squash, shown]);
    }),
  ),
});
const FAMILIES: Family[] = [
  family("Reading status", 2, [
    "To read|toread|to-read|unread|not read|reading list|read later|to be read|tbr",
    "Reading|currently reading|in progress",
    "Read|done reading|finished",
    "Skimmed|skim",
    "To reread|reread|re-read",
  ]),
  family("Priority", 2, ["High priority|high|priority high|important", "Medium priority|medium|priority medium", "Low priority|low|priority low"]),
  family("Rating", 2, ["★★★★★|5 star|5 stars|rating 5|*****", "★★★★|4 star|4 stars|rating 4|****", "★★★|3 star|3 stars|rating 3|***", "★★|2 star|2 stars|rating 2|**", "★|1 star|1 star|rating 1|*"]),
  family("Language", 2, [
    "English|en|eng",
    "German|de|deutsch|ger",
    "French|fr|francais|fre",
    "Spanish|es|espanol|spa",
    "Italian|it|italiano",
    "Portuguese|pt|portugues",
    "Dutch|nl|nederlands",
    "Chinese|zh",
    "Japanese|ja",
    "Russian|ru",
    "Arabic|ar",
    "Swedish|sv",
    "Norwegian",
    "Danish",
    "Finnish",
    "Polish",
    "Korean",
    "Turkish",
  ]),
  family("Country", 3, [
    "United States|usa|us|united states of america|america",
    "United Kingdom|uk|great britain|britain|england",
    "Germany",
    "France",
    "Italy",
    "Spain",
    "Netherlands",
    "Switzerland",
    "Austria",
    "Sweden",
    "Norway",
    "Denmark",
    "Finland",
    "Poland",
    "Canada",
    "Mexico",
    "Brazil",
    "Argentina",
    "Chile",
    "China",
    "India",
    "Japan",
    "South Korea|korea",
    "Indonesia",
    "Australia",
    "New Zealand",
    "South Africa",
    "Nigeria",
    "Kenya",
    "Ethiopia",
    "Ghana",
    "Uganda",
    "Tanzania",
    "Egypt",
    "Bangladesh",
    "Pakistan",
    "Vietnam",
    "Philippines",
    "Turkey",
    "Iran",
    "Russia",
    "Ukraine",
    "Ireland",
    "Belgium",
    "Portugal",
    "Greece",
  ]),
  family("Method", 3, [
    "Survey|surveys|questionnaire",
    "Interview|interviews|semi-structured interviews",
    "RCT|randomized controlled trial|randomised controlled trial|randomized trial|rct",
    "Meta-analysis|meta analysis|metaanalysis",
    "Systematic review",
    "Literature review|review",
    "Case study|case studies",
    "Qualitative|qualitative research",
    "Quantitative|quantitative research",
    "Mixed methods",
    "Experiment|experimental",
    "Simulation|modelling|modeling",
    "Ethnography",
    "Focus groups|focus group",
    "Cohort study",
    "Cross-sectional",
    "Difference-in-differences|did",
    "Regression discontinuity",
    "Instrumental variables",
  ]),
];

/** Tags a PubMed or library-catalogue import adds to every record (MeSH check tags and the like). */
const AUTOMATIC = new Set(
  [
    "humans",
    "human",
    "animals",
    "male",
    "female",
    "adult",
    "aged",
    "middle aged",
    "aged, 80 and over",
    "young adult",
    "adolescent",
    "child",
    "child, preschool",
    "infant",
    "infant, newborn",
    "pregnancy",
    "mice",
    "rats",
    "retrospective studies",
    "prospective studies",
    "cross-sectional studies",
    "cohort studies",
    "risk factors",
    "treatment outcome",
    "time factors",
    "follow-up studies",
    "questionnaires",
    "surveys and questionnaires",
    "united states",
    "case-control studies",
    "socioeconomic factors",
  ].map((t) => normalize(t).squash),
);

/** Tags that read as a yes/no flag on an item. */
const FLAG = /^(important|key paper|key|favou?rites?|fav|starred|star|todo|to do|cited|cite|printed|print|tablet|ipad|kindle|check|verify|follow up|followup|must read|core|classic|seminal|own|mine|my paper|draft)$/;

const DELIMITERS: [RegExp, string][] = [
  [/\s*::\s*/, "::"],
  [/\s*\/\s*/, "/"],
  [/\s*>\s*/, ">"],
  [/\s+[-–—]\s+/, " - "],
  [/\s*:\s*/, ":"],
];

/** The path a tag name spells out, if any ("methods/survey" → ["methods", "survey"]). */
export function splitPath(tag: string): string[] | undefined {
  if (/^https?:|^10\.\d{4,}\//i.test(tag)) return undefined;
  for (const [pattern] of DELIMITERS) {
    const parts = tag.split(pattern).map((p) => p.trim());
    if (parts.length > 1 && parts.length <= 4 && parts.every((p) => p.length > 0 && p.length <= 48 && /\p{L}/u.test(p))) return parts;
  }
  return undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
const suggestionId = (kind: string, tags: string[]) => `${kind}:${hash([...tags].sort().join("\u0001"))}`;

export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;
const quote = (t: string) => `“${t}”`;
const list = (tags: string[], max = 3) =>
  tags.length <= max ? tags.map(quote).join(tags.length === 2 ? " and " : ", ") : `${tags.slice(0, max).map(quote).join(", ")} and ${tags.length - max} more`;

/** A value as the property shows it: the tag's own words, the delimiter prefix off. */
export function valueLabel(tag: string, prefix?: string) {
  let text = tag.replace(PREFIX, "").trim();
  if (prefix) {
    const path = splitPath(text);
    if (path && path.length > 1 && fold(path[0]) === fold(prefix)) text = path.slice(1).join(" ");
  }
  return text ? text[0].toLocaleUpperCase() + text.slice(1) : tag;
}

/** The name kept when variants merge: the most used, then unprefixed, then the better cased. */
export function survivor(names: string[], count: (name: string) => number) {
  return [...names].sort((a, b) => {
    const d = count(b) - count(a);
    if (d) return d;
    const pa = PREFIX.test(a) ? 1 : 0,
      pb = PREFIX.test(b) ? 1 : 0;
    if (pa !== pb) return pa - pb;
    const ca = a === a.toLowerCase() || a === a.toUpperCase() ? 1 : 0,
      cb = b === b.toLowerCase() || b === b.toUpperCase() ? 1 : 0;
    if (ca !== cb) return ca - cb;
    return a.length - b.length || a.localeCompare(b);
  })[0];
}

class UnionFind {
  parent: Int32Array;
  constructor(n: number) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]];
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a),
      rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

// ── The analysis ─────────────────────────────────────────────────────────────

export interface AnalysisOptions {
  /** Suggestion ids the user dismissed. */
  dismissed?: Set<string>;
  properties?: PropertyInfo[];
  /** Cap on theme groups (they are the least certain). */
  maxThemes?: number;
}

/** Yields now and then (a number: work done so far) so the caller can let a frame through. */
export function* analyzeSteps(index: TagIndex, options: AnalysisOptions = {}): Generator<number, Suggestion[]> {
  const { tags, items } = index;
  const n = tags.length;
  const out: Suggestion[] = [];
  const counts = tags.map((t) => t.count);
  const byName = new Map(tags.map((t, i) => [t.name, i]));
  const tree = index.tree ?? {};
  const live = Math.max(1, items.length);
  // Which items hold each tag.
  const holders: number[][] = tags.map(() => []);
  items.forEach((item, i) => item.tags.forEach((t) => holders[t]?.push(i)));
  const unionCount = (names: string[]) => {
    const seen = new Set<number>();
    for (const name of names) for (const i of holders[byName.get(name) ?? -1] ?? []) seen.add(i);
    return seen.size;
  };
  const count = (name: string) => counts[byName.get(name) ?? -1] ?? 0;
  const normals = tags.map((t) => normalize(t.name));
  yield 0;

  // 1. Variants: the same words apart from case, spacing, hyphens, plurals, order or a prefix.
  const uf = new UnionFind(n);
  const edge = new Map<string, { confidence: number; why: string }>();
  const link = (a: number, b: number, confidence: number, why: string) => {
    if (a === b) return;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const old = edge.get(key);
    if (!old || old.confidence < confidence) edge.set(key, { confidence, why });
    uf.union(a, b);
  };
  for (const [field, confidence, why] of [
    ["squash", 0.95, "Same words apart from case, spacing, punctuation or plural"],
    ["sorted", 0.85, "Same words in a different order"],
  ] as const) {
    const groups = new Map<string, number>();
    normals.forEach((norm, i) => {
      const key = norm[field];
      if (!key || key.length < 2) return;
      const first = groups.get(key);
      if (first === undefined) groups.set(key, i);
      else link(first, i, confidence, why);
    });
  }
  yield 1;

  // Near spellings, compared within blocks that share a word or a leading trigram.
  const blocks = new Map<string, number[]>();
  normals.forEach((norm, i) => {
    if (norm.squash.length < 5) return;
    const keys = new Set([`p:${norm.squash.slice(0, 3)}`, ...norm.words.filter((w) => w.length >= 4).map((w) => `w:${w}`)]);
    for (const key of keys) {
      const block = blocks.get(key);
      if (block) block.push(i);
      else blocks.set(key, [i]);
    }
  });
  let work = 0;
  const compared = new Set<string>();
  for (const block of blocks.values()) {
    if (block.length < 2 || block.length > 400) continue;
    for (let x = 0; x < block.length; x++)
      for (let y = x + 1; y < block.length; y++) {
        const a = block[x],
          b = block[y];
        if (uf.find(a) === uf.find(b)) continue;
        const key = `${a},${b}`;
        if (compared.has(key)) continue;
        compared.add(key);
        if (++work % 4000 === 0) yield 2;
        const sa = normals[a].squash,
          sb = normals[b].squash;
        // Different numbers are different things (2019 / 2020, phase 1 / phase 2).
        if (sa.replace(/\D/g, "") !== sb.replace(/\D/g, "")) continue;
        const short = Math.min(sa.length, sb.length);
        if (short < 5) continue;
        const distance = editDistance(sa, sb, 2);
        const allowed = short >= 10 ? 2 : 1;
        if (distance > allowed || jaroWinkler(sa, sb) < 0.9) continue;
        // A one-letter difference between two common words (policy / police) is no typo:
        // only offered when one of them is rare.
        const rare = Math.min(counts[a], counts[b]) <= Math.max(2, Math.max(counts[a], counts[b]) / 8);
        if (!rare && short < 8) continue;
        link(a, b, distance === 1 ? 0.75 : 0.6, "Spelled almost the same");
      }
  }
  yield 3;

  // Initialisms: "ML" and "machine learning", "RCT" and "randomised controlled trials".
  const initials = new Map<string, number[]>();
  normals.forEach((norm, i) => {
    const words = norm.words.filter((w) => !STOP.has(w));
    if (words.length >= 2 && words.length <= 6) {
      const key = words.map((w) => w[0]).join("");
      initials.set(key, [...(initials.get(key) ?? []), i]);
    }
  });
  normals.forEach((norm, i) => {
    const raw = tags[i].name.replace(PREFIX, "");
    if (norm.words.length !== 1 || norm.squash.length < 2 || norm.squash.length > 6 || !/^[A-Z0-9]{2,6}s?$/.test(raw)) return;
    const matches = initials.get(norm.squash.replace(/s$/, "")) ?? initials.get(norm.squash);
    // Only an unambiguous expansion (its spelling variants count as one).
    if (matches?.length && new Set(matches.map((m) => uf.find(m))).size === 1) link(i, matches[0], 0.65, `${quote(tags[i].name)} reads as the initials of ${quote(tags[matches[0]].name)}`);
  });
  yield 4;

  const inMerge = new Set<number>();
  const components = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const members = components.get(root);
    if (members) members.push(i);
    else components.set(root, [i]);
  }
  for (const members of components.values()) {
    if (members.length < 2 || members.length > 12) continue;
    let confidence = 1;
    const reasons = new Set<string>();
    for (let x = 0; x < members.length; x++)
      for (let y = x + 1; y < members.length; y++) {
        const a = Math.min(members[x], members[y]),
          b = Math.max(members[x], members[y]);
        const e = edge.get(`${a},${b}`);
        if (e) {
          confidence = Math.min(confidence, e.confidence);
          reasons.add(e.why);
        }
      }
    const names = members.map((i) => tags[i].name).sort((a, b) => a.localeCompare(b));
    const to = survivor(names, count);
    members.forEach((i) => inMerge.add(i));
    out.push({
      id: suggestionId("merge", names),
      kind: "merge",
      title: `Merge ${list(names.filter((t) => t !== to))} into ${quote(to)}`,
      evidence: [...reasons].join(". "),
      confidence,
      tags: names,
      items: unionCount(names),
      plan: { type: "merge", from: names.filter((t) => t !== to), to },
    });
  }
  yield 5;

  // 2. Paths written into names.
  const pathed: { tag: string; path: string[] }[] = [];
  for (const t of tags) {
    if (tree[t.name]?.parent) continue;
    const path = splitPath(t.name);
    if (path) pathed.push({ tag: t.name, path });
  }
  const byRoot = new Map<string, { tag: string; path: string[] }[]>();
  for (const p of pathed) {
    const key = fold(p.path[0]);
    byRoot.set(key, [...(byRoot.get(key) ?? []), p]);
  }
  const inPath = new Set<string>();
  for (const group of byRoot.values()) {
    const root = group[0].path[0];
    if (group.length < 2 && !byName.has(root)) continue;
    const names = group.map((g) => g.tag);
    names.forEach((t) => inPath.add(t));
    out.push({
      id: suggestionId("hierarchy", names),
      kind: "hierarchy",
      title: `Nest ${plural(group.length, "tag")} under ${quote(root)}`,
      evidence: `Their names start with ${quote(root)}: ${list(names, 2)}`,
      confidence: group.length >= 3 ? 0.85 : 0.7,
      tags: names,
      items: unionCount(names),
      plan: { type: "hierarchy", splits: group.map((g) => ({ tag: g.tag, path: g.path })) },
    });
    // A prefix family is often one property with values ("status: read", "status: to read").
    if (group.length >= 2 && group.length <= 30 && group.every((g) => g.path.length === 2)) {
      const values = group.map((g): [string, string] => [g.tag, valueLabel(g.path[1])]);
      out.push(propertySuggestion(valueLabel(root), values, 0.6, `${quote(root)} reads as a property with ${plural(values.length, "value")}`));
    }
  }
  yield 6;

  // 3. Families from the built-in vocabularies, years, and flags.
  for (const fam of FAMILIES) {
    const values: [string, string][] = [];
    for (const t of tags) {
      const shown = fam.values[normals[byName.get(t.name)!].squash];
      if (shown && !inPath.has(t.name)) values.push([t.name, shown]);
    }
    const distinct = new Set(values.map(([, v]) => v));
    if (distinct.size >= fam.min) out.push(propertySuggestion(fam.property, values, 0.75, `${list(values.map(([t]) => t))} look like values of one ${fam.property.toLowerCase()}`));
  }
  const years = tags.filter((t) => /^(19|20)\d\d$/.test(t.name.replace(PREFIX, "").trim())).map((t): [string, string] => [t.name, t.name.replace(PREFIX, "").trim()]);
  if (years.length >= 3)
    out.push(propertySuggestion("Year tag", years.sort((a, b) => b[1].localeCompare(a[1])), 0.55, `${plural(years.length, "tag")} are years`));
  for (let i = 0; i < n; i++) {
    const t = tags[i];
    const bare = fold(t.name).replace(PREFIX, "").trim();
    const flagLike = FLAG.test(bare) || (normals[i].prefixed && normals[i].words.length <= 3 && t.count >= 2);
    if (!flagLike || inMerge.has(i) || inPath.has(t.name)) continue;
    const name = valueLabel(t.name);
    out.push({
      id: suggestionId("property", [t.name]),
      kind: "property",
      title: `Make ${quote(t.name)} a checkbox`,
      evidence: normals[i].prefixed ? "A marked tag like this usually flags items for a workflow" : "Reads as a yes/no flag on an item",
      confidence: normals[i].prefixed ? 0.65 : 0.6,
      tags: [t.name],
      items: t.count,
      plan: { type: "property", name, propertyType: "boolean", values: [[t.name, true]], removeTags: true },
    });
  }
  yield 7;

  // 4. Junk: on nearly everything, automatic headings, numbers and garbage, very long, once only.
  const junk: string[] = [],
    automatic: string[] = [],
    everywhere: string[] = [],
    once: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = tags[i];
    const bare = t.name.replace(PREFIX, "").trim();
    if (items.length >= 20 && t.count / live >= 0.6) everywhere.push(t.name);
    else if (AUTOMATIC.has(normals[i].squash) && !inMerge.has(i)) automatic.push(t.name);
    else if (!/\p{L}/u.test(bare) && !/^(19|20)\d\d$/.test(bare)) junk.push(t.name);
    else if (bare.length > 60 || bare.split(/\s+/).length > 8 || /^(https?:|www\.|10\.\d{4,}\/)/i.test(bare) || /^[0-9a-f]{12,}$/i.test(bare)) junk.push(t.name);
    else if (t.count === 1 && !inMerge.has(i) && !inPath.has(t.name)) once.push(t.name);
  }
  const cleanup = (tags: string[], title: string, evidence: string, confidence: number) =>
    tags.length &&
    out.push({ id: suggestionId("cleanup", tags), kind: "cleanup", title, evidence, confidence, tags, items: unionCount(tags), plan: { type: "delete", tags } });
  cleanup(junk, `Remove ${plural(junk.length, "tag")} that look like noise`, "Numbers, links, identifiers or whole sentences rather than topics", 0.7);
  cleanup(automatic, `Remove ${plural(automatic.length, "automatic subject heading")}`, "Headings such as “Humans” or “Female” that catalogues add to every record", 0.55);
  for (const t of everywhere)
    cleanup([t], `Remove ${quote(t)} from all items`, `On ${Math.round((count(t) / live) * 100)}% of tagged items, so it does not tell them apart (an import marker?)`, 0.5);
  if (once.length >= 5) cleanup(once, `Remove ${plural(once.length, "tag")} used only once`, "Each is on a single item; review before removing", 0.3);
  yield 8;

  // 5. Co-occurrence: tags that always travel together, and tags that sit inside another.
  const pair = new Map<number, number>();
  const key = (a: number, b: number) => a * n + b;
  for (let i = 0; i < items.length; i++) {
    const own = items[i].tags;
    if (own.length > 60) continue;
    for (let x = 0; x < own.length; x++)
      for (let y = 0; y < own.length; y++) if (x !== y) pair.set(key(own[x], own[y]), (pair.get(key(own[x], own[y])) ?? 0) + 1);
    if (i % 2000 === 1999) yield 9;
  }
  const nestedChild = new Set<number>();
  const together = new Set<string>();
  const parents = new Map<number, { parent: number; ratio: number; both: number }>();
  for (const [k, both] of pair) {
    const a = Math.floor(k / n),
      b = k % n;
    if (both < 3 || uf.find(a) === uf.find(b)) continue;
    const ca = counts[a],
      cb = counts[b];
    const jaccard = both / (ca + cb - both);
    if (a < b && jaccard >= 0.9 && !together.has(`${a},${b}`)) {
      together.add(`${a},${b}`);
      const names = [tags[a].name, tags[b].name].sort((x, y) => x.localeCompare(y));
      const to = survivor(names, count);
      out.push({
        id: suggestionId("together", names),
        kind: "merge",
        title: `Combine ${quote(names.find((t) => t !== to)!)} with ${quote(to)}`,
        evidence: `Used together on ${both} of ${Math.max(ca, cb)} items`,
        confidence: 0.45 + 0.4 * jaccard * Math.min(1, both / 10),
        tags: names,
        items: unionCount(names),
        plan: { type: "merge", from: names.filter((t) => t !== to), to },
      });
      continue;
    }
    // a inside b: nearly every item with a has b, and b is clearly broader (not on everything).
    const ratio = both / ca;
    if (ratio < 0.9 || cb < ca * 1.5 || cb / live > 0.5 || tree[tags[a].name]?.parent) continue;
    const best = parents.get(a);
    // The narrowest parent wins.
    if (!best || cb < counts[best.parent] || (cb === counts[best.parent] && tags[b].name < tags[best.parent].name)) parents.set(a, { parent: b, ratio, both });
  }
  const byParent = new Map<number, { child: number; ratio: number; both: number }[]>();
  for (const [child, p] of parents) byParent.set(p.parent, [...(byParent.get(p.parent) ?? []), { child, ...p }]);
  for (const [parent, children] of byParent) {
    // A parent that is itself nested under one of these children would make a cycle.
    const kids = children.filter((c) => parents.get(parent)?.parent !== c.child).sort((x, y) => tags[x.child].name.localeCompare(tags[y.child].name));
    if (!kids.length) continue;
    kids.forEach((c) => nestedChild.add(c.child));
    const names = kids.map((c) => tags[c.child].name);
    const support = Math.min(1, kids.reduce((s, c) => s + c.both, 0) / 12);
    const ratio = Math.min(...kids.map((c) => c.ratio));
    out.push({
      id: suggestionId("nest", [tags[parent].name, ...names]),
      kind: "nest",
      title: `Nest ${list(names)} under ${quote(tags[parent].name)}`,
      evidence:
        kids.length === 1
          ? `${kids[0].both} of ${counts[kids[0].child]} items tagged ${quote(names[0])} are also tagged ${quote(tags[parent].name)}`
          : `Nearly every item with these tags is also tagged ${quote(tags[parent].name)} (${Math.round(ratio * 100)}% or more)`,
      confidence: 0.4 + 0.45 * support * ratio,
      tags: [tags[parent].name, ...names],
      items: 0,
      plan: { type: "nest", parent: tags[parent].name, children: names },
    });
  }
  yield 10;

  // 6. Themes: TF-IDF over each tag's words (weighted) and its items' title words.
  const candidates = tags
    .map((t, i) => i)
    .filter((i) => counts[i] >= 2 && !tree[tags[i].name]?.parent && !nestedChild.has(i) && !inPath.has(tags[i].name))
    .sort((a, b) => counts[b] - counts[a] || tags[a].name.localeCompare(tags[b].name))
    .slice(0, 1500);
  const docs: Map<string, number>[] = [];
  const df = new Map<string, number>();
  for (const i of candidates) {
    const doc = new Map<string, number>();
    for (const w of normals[i].words) if (w.length >= 3 && !STOP.has(w)) doc.set(w, (doc.get(w) ?? 0) + 3);
    for (const h of holders[i].slice(0, 40))
      for (const w of fold(items[h].title).split(/[^\p{L}]+/u))
        if (w.length >= 4 && !STOP.has(w)) {
          const s = spelling(singular(w));
          doc.set(s, (doc.get(s) ?? 0) + 1);
        }
    docs.push(doc);
    for (const w of doc.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  }
  yield 11;
  const D = Math.max(1, docs.length);
  const vectors = docs.map((doc) => {
    const weighted = [...doc]
      .filter(([w]) => (df.get(w) ?? 0) > 1 && (df.get(w) ?? 0) / D < 0.2)
      .map(([w, tf]): [string, number] => [w, (1 + Math.log(tf)) * Math.log(D / (df.get(w) ?? 1))])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20);
    const norm = Math.hypot(...weighted.map(([, v]) => v)) || 1;
    return new Map(weighted.map(([w, v]) => [w, v / norm]));
  });
  const postings = new Map<string, number[]>();
  vectors.forEach((v, d) => v.forEach((_, w) => postings.set(w, [...(postings.get(w) ?? []), d])));
  const assigned = new Int32Array(vectors.length).fill(-1);
  const themes: { leader: number; members: number[]; sims: number[] }[] = [];
  for (let d = 0; d < vectors.length; d++) {
    if (assigned[d] >= 0 || !vectors[d].size) continue;
    const scores = new Map<number, number>();
    vectors[d].forEach((v, w) => {
      for (const o of postings.get(w) ?? []) if (o !== d && assigned[o] < 0) scores.set(o, (scores.get(o) ?? 0) + v * (vectors[o].get(w) ?? 0));
    });
    const members = [...scores]
      .filter(([o, s]) => s >= 0.35 && uf.find(candidates[o]) !== uf.find(candidates[d]))
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 14);
    if (members.length < 2) continue;
    assigned[d] = themes.length;
    members.forEach(([o]) => (assigned[o] = themes.length));
    themes.push({ leader: d, members: [d, ...members.map(([o]) => o)], sims: members.map(([, s]) => s) });
    if (d % 200 === 199) yield 12;
  }
  const maxThemes = options.maxThemes ?? 12;
  for (const theme of themes.slice(0, maxThemes)) {
    const weight = new Map<string, number>();
    for (const m of theme.members) vectors[m].forEach((v, w) => weight.set(w, (weight.get(w) ?? 0) + v));
    const [top] = [...weight].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!top) continue;
    const names = theme.members.map((m) => tags[candidates[m]].name);
    const existing = names.find((t) => normalize(t).squash === top[0]);
    const parent = existing ?? top[0][0].toUpperCase() + top[0].slice(1);
    const children = names.filter((t) => t !== existing).sort((a, b) => a.localeCompare(b));
    const shared = [...weight].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([w]) => w);
    out.push({
      id: suggestionId("theme", names),
      kind: "nest",
      title: `Group ${plural(children.length, "related tag")} under ${quote(parent)}`,
      evidence: `Their items share words like ${shared.map(quote).join(", ")}`,
      confidence: Math.min(0.6, 0.25 + theme.sims.reduce((s, v) => s + v, 0) / theme.sims.length / 2),
      tags: [parent, ...children],
      items: 0,
      plan: { type: "nest", parent, children },
    });
  }
  yield 13;

  function propertySuggestion(name: string, values: [string, string][], confidence: number, evidence: string): Suggestion {
    const existing = options.properties?.find((p) => fold(p.name) === fold(name));
    const tagsIn = values.map(([t]) => t);
    return {
      id: suggestionId("property", tagsIn),
      kind: "property",
      title: existing ? `Add ${plural(tagsIn.length, "tag")} to the ${quote(existing.name)} property` : `Turn ${plural(tagsIn.length, "tag")} into a ${quote(name)} property`,
      evidence,
      confidence,
      tags: tagsIn,
      items: unionCount(tagsIn),
      plan: { type: "property", name: existing?.name ?? name, propertyType: "select", values, removeTags: true },
    };
  }

  const dismissed = options.dismissed ?? new Set<string>();
  const seen = new Set<string>();
  return out
    .filter((s) => !dismissed.has(s.id) && !seen.has(s.id) && (seen.add(s.id), true))
    .sort((a, b) => b.confidence - a.confidence || b.items - a.items || a.id.localeCompare(b.id));
}

export function analyzeTags(index: TagIndex, options?: AnalysisOptions): Suggestion[] {
  const steps = analyzeSteps(index, options);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Runs the analysis in slices of a few milliseconds so the window keeps painting. */
export async function analyzeTagsAsync(index: TagIndex, options?: AnalysisOptions, signal?: AbortSignal): Promise<Suggestion[]> {
  const steps = analyzeSteps(index, options);
  let slice = performance.now();
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const next = steps.next();
    if (next.done) return next.value;
    if (performance.now() - slice > 12) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      slice = performance.now();
    }
  }
}
