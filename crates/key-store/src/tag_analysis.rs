// Understands a library's tags, locally and deterministically: spelling and plural
// variants, initialisms, tags that always travel together or sit inside another, paths
// written into names ("methods/survey"), families that read as one property with values
// (reading status, ratings, years, languages…), junk, and theme groups found from the
// words of the tags and their items' titles (TF-IDF with a greedy cosine clustering).
// Suggestion ids hash the same way the renderer's analysis did, so dismissals carry over.
use crate::tag_plan::{PlanContext, PlannedChange, TagPlan};
use crate::{Result, Store};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct TagCount {
    pub name: String,
    pub count: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct TagItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub year: Option<i64>,
    /// Indexes into `tags`.
    #[serde(default)]
    pub tags: Vec<usize>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagIndex {
    #[serde(default)]
    pub tags: Vec<TagCount>,
    #[serde(default)]
    pub items: Vec<TagItem>,
    #[serde(default)]
    pub source_count: usize,
    /// Tag → `{ parent?, color? }`.
    #[serde(default)]
    pub tree: Map<String, Json>,
}

impl TagIndex {
    pub fn parent_of(&self, name: &str) -> Option<&str> {
        self.tree.get(name).and_then(|m| m.get("parent")).and_then(|p| p.as_str()).filter(|p| !p.is_empty())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct PropertyInfo {
    pub name: String,
    #[serde(default, rename = "type")]
    pub kind: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Suggestion {
    /// Stable across runs for the same tags, so a dismissal sticks.
    pub id: String,
    /// merge, nest, hierarchy, property or cleanup.
    pub kind: &'static str,
    pub title: String,
    pub evidence: String,
    /// 0–1.
    pub confidence: f64,
    pub tags: Vec<String>,
    /// Sources the change touches.
    pub items: usize,
    pub plan: TagPlan,
    /// What applying it does now (absent when it no longer applies).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<PlannedChange>,
}

#[derive(Clone, Debug, Default)]
pub struct AnalysisOptions {
    pub dismissed: HashSet<String>,
    pub properties: Vec<PropertyInfo>,
    /// Cap on theme groups (they are the least certain).
    pub max_themes: Option<usize>,
}

// ── Normalisation ────────────────────────────────────────────────────────────

fn is_prefix_char(c: char) -> bool {
    matches!(c, '_' | '#' | '!' | '@' | '*' | '+' | '~' | '.' | '-') || c.is_whitespace()
}

/// The text without a leading run of marker characters (`_`, `#`, `*`, …).
pub fn strip_prefix(text: &str) -> &str {
    text.trim_start_matches(is_prefix_char)
}

fn has_prefix(text: &str) -> bool {
    text.chars().next().is_some_and(is_prefix_char)
}

const STOP: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "into", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "were", "with",
    "without", "via", "vs", "versus", "its", "their", "our", "your", "not", "no",
];
fn stop(word: &str) -> bool {
    STOP.contains(&word)
}

/// Diacritics off, lower case.
pub fn fold(text: &str) -> String {
    text.nfkd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect::<String>().to_lowercase()
}

fn len16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// One word to its singular, for comparison only.
pub fn singular(word: &str) -> String {
    if len16(word) <= 3 || word.chars().any(|c| c.is_ascii_digit()) {
        return word.into();
    }
    if ["ss", "us", "is", "ics", "sis", "ous"].iter().any(|s| word.ends_with(s)) {
        return word.into();
    }
    if word.ends_with("ies") && len16(word) > 4 {
        return format!("{}y", &word[..word.len() - 3]);
    }
    if ["ches", "shes", "xes", "sses", "zes"].iter().any(|s| word.ends_with(s)) {
        return word[..word.len() - 2].into();
    }
    if let Some(stem) = word.strip_suffix('s') {
        return stem.into();
    }
    word.into()
}

/// British and American spellings to one form, for comparison only.
fn spelling(word: &str) -> String {
    let mut w = word.to_string();
    let swap = |w: &mut String, from: &str, to: &str| {
        if w.ends_with(from) {
            w.truncate(w.len() - from.len());
            w.push_str(to);
        }
    };
    swap(&mut w, "our", "or");
    for (from, to) in [("ised", "ized"), ("ises", "izes"), ("ise", "ize")] {
        if w.ends_with(from) {
            swap(&mut w, from, to);
            break;
        }
    }
    swap(&mut w, "isation", "ization");
    swap(&mut w, "lling", "ling");
    swap(&mut w, "lled", "led");
    if w.ends_with("re") {
        let before = w[..w.len() - 2].chars().last();
        if before.is_some_and(|c| !"aeiou".contains(c)) {
            swap(&mut w, "re", "er");
        }
    }
    swap(&mut w, "ogue", "og");
    w
}

#[derive(Clone, Debug, Default)]
pub struct Normal {
    /// Folded words, singular, with spelling unified.
    pub words: Vec<String>,
    /// The words run together: equal for case, spacing, hyphen and plural variants.
    pub squash: String,
    /// The words sorted: equal for reordered names.
    pub sorted: String,
    pub prefixed: bool,
}

pub fn normalize(tag: &str) -> Normal {
    let folded = fold(tag.trim());
    let prefixed = has_prefix(&folded);
    let words: Vec<String> = strip_prefix(&folded)
        .replace('&', " and ")
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| spelling(&singular(w)))
        .collect();
    let mut sorted = words.clone();
    sorted.sort();
    Normal { squash: words.concat(), sorted: sorted.join(" "), words, prefixed }
}

// ── String similarity ────────────────────────────────────────────────────────

pub fn jaro_winkler(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let (la, lb) = (a.len(), b.len());
    if la == 0 || lb == 0 {
        return 0.0;
    }
    let range = (la.max(lb) / 2).saturating_sub(1);
    let (mut ma, mut mb) = (vec![false; la], vec![false; lb]);
    let mut matches = 0usize;
    for i in 0..la {
        let lo = i.saturating_sub(range);
        let hi = (i + range).min(lb - 1);
        for j in lo..=hi {
            if !mb[j] && a[i] == b[j] {
                ma[i] = true;
                mb[j] = true;
                matches += 1;
                break;
            }
        }
    }
    if matches == 0 {
        return 0.0;
    }
    let (mut t, mut k) = (0usize, 0usize);
    for i in 0..la {
        if ma[i] {
            while !mb[k] {
                k += 1;
            }
            if a[i] != b[k] {
                t += 1;
            }
            k += 1;
        }
    }
    let m = matches as f64;
    let jaro = (m / la as f64 + m / lb as f64 + (m - t as f64 / 2.0) / m) / 3.0;
    let mut prefix = 0;
    while prefix < 4 && prefix < la && prefix < lb && a[prefix] == b[prefix] {
        prefix += 1;
    }
    jaro + prefix as f64 * 0.1 * (1.0 - jaro)
}

/// Edit distance with transpositions, giving up beyond `max`.
pub fn edit_distance(a: &str, b: &str, max: usize) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.len().abs_diff(b.len()) > max {
        return max + 1;
    }
    let mut prev2 = vec![0usize; b.len() + 1];
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        let mut best = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut v = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(prev2[j - 2] + 1);
            }
            cur[j] = v;
            best = best.min(v);
        }
        if best > max {
            return max + 1;
        }
        prev2.copy_from_slice(&prev);
        prev.copy_from_slice(&cur);
    }
    prev[b.len()]
}

// ── Ordering ─────────────────────────────────────────────────────────────────

/// JavaScript's default sort: by UTF-16 code units.
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A close stand-in for `localeCompare` (ICU root collation): spaces, then punctuation,
/// digits and letters; letters by base letter, then accents, then lower before upper case.
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    fn group(c: char) -> u8 {
        if c.is_whitespace() {
            0
        } else if c.is_alphabetic() {
            4
        } else if c.is_numeric() {
            3
        } else if c.is_ascii_punctuation() || c.is_ascii() {
            1
        } else {
            2
        }
    }
    if a.is_ascii() && b.is_ascii() {
        let weight = |c: u8| (group(c as char), c.to_ascii_lowercase());
        let primary = a.bytes().map(weight).cmp(b.bytes().map(weight));
        return primary.then_with(|| {
            for (x, y) in a.bytes().zip(b.bytes()) {
                if x != y {
                    return y.is_ascii_lowercase().cmp(&x.is_ascii_lowercase()).then(x.cmp(&y));
                }
            }
            a.len().cmp(&b.len())
        });
    }
    let primary = |s: &str| -> Vec<(u8, char)> { fold(s).chars().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).map(|c| (group(c), c)).collect() };
    primary(a)
        .cmp(&primary(b))
        .then_with(|| {
            let accents = |s: &str| s.to_lowercase();
            accents(a).cmp(&accents(b))
        })
        .then_with(|| {
            // Lower case first at the first difference in case.
            for (x, y) in a.chars().zip(b.chars()) {
                if x != y {
                    return match (x.is_lowercase(), y.is_lowercase()) {
                        (true, false) => Ordering::Less,
                        (false, true) => Ordering::Greater,
                        _ => x.cmp(&y),
                    };
                }
            }
            a.len().cmp(&b.len())
        })
}

// ── Built-in vocabularies ────────────────────────────────────────────────────

struct Family {
    property: &'static str,
    /// Normalised value → display value.
    values: HashMap<String, &'static str>,
    min: usize,
}

fn family(property: &'static str, min: usize, values: &[&'static str]) -> Family {
    let mut map = HashMap::new();
    for v in values {
        let mut parts = v.split('|');
        let shown = parts.next().unwrap_or_default();
        for alias in std::iter::once(shown).chain(parts) {
            map.insert(normalize(alias).squash, shown);
        }
    }
    Family { property, values: map, min }
}

fn families() -> Vec<Family> {
    vec![
        family(
            "Reading status",
            2,
            &[
                "To read|toread|to-read|unread|not read|reading list|read later|to be read|tbr",
                "Reading|currently reading|in progress",
                "Read|done reading|finished",
                "Skimmed|skim",
                "To reread|reread|re-read",
            ],
        ),
        family("Priority", 2, &["High priority|high|priority high|important", "Medium priority|medium|priority medium", "Low priority|low|priority low"]),
        family(
            "Rating",
            2,
            &["★★★★★|5 star|5 stars|rating 5|*****", "★★★★|4 star|4 stars|rating 4|****", "★★★|3 star|3 stars|rating 3|***", "★★|2 star|2 stars|rating 2|**", "★|1 star|1 star|rating 1|*"],
        ),
        family(
            "Language",
            2,
            &[
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
            ],
        ),
        family(
            "Country",
            3,
            &[
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
            ],
        ),
        family(
            "Method",
            3,
            &[
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
            ],
        ),
    ]
}

/// Tags a PubMed or library-catalogue import adds to every record (MeSH check tags and the like).
const AUTOMATIC: &[&str] = &[
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
];

/// Tags that read as a yes/no flag on an item.
const FLAGS: &[&str] = &[
    "important", "key paper", "key", "favorite", "favorites", "favourite", "favourites", "fav", "starred", "star", "todo", "to do", "cited", "cite", "printed", "print", "tablet",
    "ipad", "kindle", "check", "verify", "follow up", "followup", "must read", "core", "classic", "seminal", "own", "mine", "my paper", "draft",
];

fn split_trimmed<'a>(tag: &'a str, delimiter: &str) -> Vec<&'a str> {
    tag.split(delimiter).map(str::trim).collect()
}

/// Splits at a dash with spaces on both sides ("Covid - Lockdown").
fn split_dash(tag: &str) -> Vec<&str> {
    let chars: Vec<(usize, char)> = tag.char_indices().collect();
    let mut parts = Vec::new();
    let mut start = 0;
    for (k, &(at, c)) in chars.iter().enumerate() {
        if matches!(c, '-' | '–' | '—') && k > 0 && chars[k - 1].1.is_whitespace() && chars.get(k + 1).is_some_and(|n| n.1.is_whitespace()) && at >= start {
            parts.push(tag[start..at].trim());
            start = at + c.len_utf8();
        }
    }
    parts.push(tag[start..].trim());
    parts
}

/// The path a tag name spells out, if any ("methods/survey" → ["methods", "survey"]).
pub fn split_path(tag: &str) -> Option<Vec<String>> {
    let lower = tag.to_ascii_lowercase();
    if lower.starts_with("http:") || lower.starts_with("https:") || is_doi_start(tag) {
        return None;
    }
    let candidates = [split_trimmed(tag, "::"), split_trimmed(tag, "/"), split_trimmed(tag, ">"), split_dash(tag), split_trimmed(tag, ":")];
    for parts in candidates {
        if parts.len() > 1 && parts.len() <= 4 && parts.iter().all(|p| !p.is_empty() && len16(p) <= 48 && p.chars().any(char::is_alphabetic)) {
            return Some(parts.into_iter().map(String::from).collect());
        }
    }
    None
}

/// "10.1234/…" at the start.
fn is_doi_start(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("10.") else { return false };
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    digits >= 4 && rest[digits..].starts_with('/')
}

fn is_year(text: &str) -> bool {
    text.len() == 4 && text.chars().all(|c| c.is_ascii_digit()) && (text.starts_with("19") || text.starts_with("20"))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn hash(text: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for unit in text.encode_utf16() {
        h ^= unit as u32;
        h = h.wrapping_mul(0x01000193);
    }
    base36(h)
}

fn base36(mut n: u32) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn suggestion_id(kind: &str, tags: &[String]) -> String {
    let mut sorted: Vec<&str> = tags.iter().map(String::as_str).collect();
    sorted.sort_by(|a, b| cmp_utf16(a, b));
    format!("{kind}:{}", hash(&sorted.join("\u{1}")))
}

/// "1,234 tags".
pub fn plural(n: usize, word: &str) -> String {
    plural_as(n, word, &format!("{word}s"))
}

pub fn plural_as(n: usize, word: &str, many: &str) -> String {
    let digits = n.to_string();
    let mut grouped = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    format!("{grouped} {}", if n == 1 { word } else { many })
}

pub fn quote(t: &str) -> String {
    format!("“{t}”")
}

fn list(tags: &[String], max: usize) -> String {
    if tags.len() <= max {
        tags.iter().map(|t| quote(t)).collect::<Vec<_>>().join(if tags.len() == 2 { " and " } else { ", " })
    } else {
        format!("{} and {} more", tags[..max].iter().map(|t| quote(t)).collect::<Vec<_>>().join(", "), tags.len() - max)
    }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// A value as the property shows it: the tag's own words, the delimiter prefix off.
pub fn value_label(tag: &str, prefix: Option<&str>) -> String {
    let mut text = strip_prefix(tag).trim().to_string();
    if let Some(prefix) = prefix {
        if let Some(path) = split_path(&text) {
            if path.len() > 1 && fold(&path[0]) == fold(prefix) {
                text = path[1..].join(" ");
            }
        }
    }
    if text.is_empty() { tag.to_string() } else { capitalize(&text) }
}

/// What the tag manager's "Turn into a property" form starts with: the shared root of the
/// tags ("status" for "status: read" and "status: to read"), a property name and each tag's value.
pub fn convert_defaults(tags: &[String]) -> serde_json::Value {
    let roots: Vec<Option<String>> = tags.iter().map(|t| split_path(t).map(|p| p[0].clone())).collect();
    let common = match roots.first() {
        Some(Some(first)) if roots.len() > 1 && roots.iter().all(|r| r.as_deref().is_some_and(|r| fold(r) == fold(first))) => Some(first.clone()),
        _ => None,
    };
    let name = match (tags, &common) {
        ([one], _) => value_label(one, None),
        (_, Some(common)) => value_label(common, None),
        _ => String::new(),
    };
    let values: serde_json::Map<String, serde_json::Value> = tags.iter().map(|t| (t.clone(), serde_json::Value::from(value_label(t, common.as_deref())))).collect();
    serde_json::json!({ "common": common, "name": name, "values": values })
}

/// The name kept when variants merge: the most used, then unprefixed, then the better cased.
pub fn survivor(names: &[String], count: &dyn Fn(&str) -> usize) -> String {
    let mut sorted = names.to_vec();
    let plain_case = |s: &str| s == s.to_lowercase() || s == s.to_uppercase();
    sorted.sort_by(|a, b| {
        count(b)
            .cmp(&count(a))
            .then_with(|| has_prefix(a).cmp(&has_prefix(b)))
            .then_with(|| plain_case(a).cmp(&plain_case(b)))
            .then_with(|| len16(a).cmp(&len16(b)))
            .then_with(|| locale_cmp(a, b))
    });
    sorted.into_iter().next().unwrap_or_default()
}

struct UnionFind(Vec<usize>);
impl UnionFind {
    fn find(&mut self, mut i: usize) -> usize {
        while self.0[i] != i {
            self.0[i] = self.0[self.0[i]];
            i = self.0[i];
        }
        i
    }
    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.0[ra.max(rb)] = ra.min(rb);
        }
    }
}

/// Keys in first-seen order, each with its values.
struct Ordered<V> {
    at: HashMap<String, usize>,
    entries: Vec<(String, V)>,
}
impl<V: Default> Ordered<V> {
    fn new() -> Self {
        Self { at: HashMap::new(), entries: Vec::new() }
    }
    fn entry(&mut self, key: &str) -> &mut V {
        let i = *self.at.entry(key.to_string()).or_insert_with(|| {
            self.entries.push((key.to_string(), V::default()));
            self.entries.len() - 1
        });
        &mut self.entries[i].1
    }
}

// ── What one analysis keeps for the next ─────────────────────────────────────

/// The tags and items as the last analysis saw them, and the work done on them: after a
/// change only the tags it touched (and their neighbours) are compared, counted, read and
/// planned again; everything else comes from here. Results are the same as a fresh run.
#[derive(Default)]
pub struct AnalysisCache {
    primed: bool,
    /// Tag name → count.
    tags: HashMap<String, usize>,
    /// Item id → its tag names.
    items: HashMap<String, Vec<String>>,
    tree: Map<String, Json>,
    /// Near spellings found, by name pair, with the link's confidence (pairs not here
    /// were compared and are not alike).
    spelled: HashMap<(String, String), f64>,
    /// Items holding both tags (ordered pairs, as counted).
    together: HashMap<(String, String), usize>,
    /// A theme candidate's word counts, with a hash of what they were read from.
    docs: HashMap<String, (u64, HashMap<String, usize>)>,
    /// Planned changes by suggestion id.
    plans: HashMap<String, (TagPlan, Option<PlannedChange>)>,
}

/// How much of the last analysis had to be done again.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct AnalysisStats {
    /// Tags whose items, count or place in the tree changed (all of them on a first run).
    pub touched: usize,
    /// Spelling pairs compared afresh.
    pub compared: usize,
    /// Items whose tag pairs were counted again.
    pub recounted: usize,
    /// Theme candidates whose words were read again.
    pub read: usize,
    /// Suggestions planned again.
    pub planned: usize,
}

const MAX_TOGETHER: usize = 60;

fn count_pairs(together: &mut HashMap<(String, String), usize>, names: &[String], add: bool) {
    if names.len() > MAX_TOGETHER {
        return;
    }
    for x in names {
        for y in names {
            if x == y {
                continue;
            }
            let key = (x.clone(), y.clone());
            if add {
                *together.entry(key).or_insert(0) += 1;
            } else if let Some(c) = together.get_mut(&key) {
                *c -= 1;
                if *c == 0 {
                    together.remove(&key);
                }
            }
        }
    }
}

impl AnalysisCache {
    /// Compares the index with the last one seen and returns the folded names of the tags
    /// that changed (`None` on a first run: everything is new). Recounts the tag pairs of
    /// changed items and forgets verdicts about changed tags.
    fn update(&mut self, index: &TagIndex, stats: &mut AnalysisStats) -> Option<HashSet<String>> {
        let names: Vec<&str> = index.tags.iter().map(|t| t.name.as_str()).collect();
        let item_names = |item: &TagItem| -> Vec<String> { item.tags.iter().filter_map(|&t| names.get(t)).map(|n| n.to_string()).collect() };
        if !self.primed {
            self.primed = true;
            self.together.clear();
            self.items.clear();
            for item in &index.items {
                let own = item_names(item);
                count_pairs(&mut self.together, &own, true);
                self.items.insert(item.id.clone(), own);
            }
            stats.recounted = index.items.len();
            stats.touched = index.tags.len();
            self.tags = index.tags.iter().map(|t| (t.name.clone(), t.count)).collect();
            self.tree = index.tree.clone();
            self.spelled.clear();
            return None;
        }
        let mut touched: HashSet<String> = HashSet::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for item in &index.items {
            seen.insert(item.id.as_str());
            let own = item_names(item);
            match self.items.get(&item.id) {
                Some(old) if *old == own => continue,
                Some(old) => {
                    let old = old.clone();
                    touched.extend(old.iter().map(|t| fold(t.trim())));
                    count_pairs(&mut self.together, &old, false);
                }
                None => {}
            }
            touched.extend(own.iter().map(|t| fold(t.trim())));
            count_pairs(&mut self.together, &own, true);
            self.items.insert(item.id.clone(), own);
            stats.recounted += 1;
        }
        let gone: Vec<String> = self.items.keys().filter(|id| !seen.contains(id.as_str())).cloned().collect();
        for id in gone {
            if let Some(old) = self.items.remove(&id) {
                touched.extend(old.iter().map(|t| fold(t.trim())));
                count_pairs(&mut self.together, &old, false);
                stats.recounted += 1;
            }
        }
        let now: HashMap<String, usize> = index.tags.iter().map(|t| (t.name.clone(), t.count)).collect();
        for (name, count) in &now {
            if self.tags.get(name) != Some(count) {
                touched.insert(fold(name.trim()));
            }
        }
        touched.extend(self.tags.keys().filter(|name| !now.contains_key(*name)).map(|name| fold(name.trim())));
        // A tag that moved in the tree, and its parents before and after.
        let parent = |meta: Option<&Json>| meta.and_then(|m| m.get("parent")).and_then(Json::as_str).map(|p| fold(p.trim()));
        for name in index.tree.keys().chain(self.tree.keys()) {
            let (old, new) = (self.tree.get(name), index.tree.get(name));
            if old != new {
                touched.insert(fold(name.trim()));
                touched.extend(parent(old));
                touched.extend(parent(new));
            }
        }
        self.tags = now;
        self.tree = index.tree.clone();
        self.spelled.retain(|(a, b), _| !touched.contains(&fold(a.trim())) && !touched.contains(&fold(b.trim())));
        stats.touched = touched.len();
        Some(touched)
    }
}

/// Every tag name a plan reads.
fn plan_names(plan: &TagPlan) -> Vec<&str> {
    match plan {
        TagPlan::Merge { from, to } => from.iter().map(String::as_str).chain([to.as_str()]).collect(),
        TagPlan::Nest { parent, children, rename_parent } => [parent.as_str()].into_iter().chain(children.iter().map(String::as_str)).chain(rename_parent.as_deref()).collect(),
        TagPlan::Hierarchy { splits } => splits.iter().flat_map(|s| [s.tag.as_str()].into_iter().chain(s.path.iter().map(String::as_str))).collect(),
        TagPlan::Property { values, .. } => values.iter().map(|(t, _)| t.as_str()).collect(),
        TagPlan::Delete { tags } | TagPlan::Unnest { tags } | TagPlan::Color { tags, .. } => tags.iter().map(String::as_str).collect(),
        TagPlan::Rename { tag, to } => vec![tag.as_str(), to.as_str()],
    }
}

/// Whether two tags are near spellings of one another, and how sure that is.
fn spelled_alike(na: &Normal, nb: &Normal, ca: usize, cb: usize) -> Option<f64> {
    let digits = |s: &str| s.chars().filter(char::is_ascii_digit).collect::<String>();
    let (sa, sb) = (&na.squash, &nb.squash);
    // Different numbers are different things (2019 / 2020, phase 1 / phase 2).
    if digits(sa) != digits(sb) {
        return None;
    }
    let short = len16(sa).min(len16(sb));
    if short < 5 {
        return None;
    }
    // A whole word more or less is a different tag ("to read" / "read").
    let wa: HashSet<&String> = na.words.iter().collect();
    let wb: HashSet<&String> = nb.words.iter().collect();
    if wa.len() != wb.len() && (wa.is_subset(&wb) || wb.is_subset(&wa)) {
        return None;
    }
    let distance = edit_distance(sa, sb, 2);
    let allowed = if short >= 10 { 2 } else { 1 };
    if distance > allowed || jaro_winkler(sa, sb) < 0.9 {
        return None;
    }
    // A one-letter difference between two common words (policy / police) is no typo:
    // only offered when one of them is rare.
    let (lo, hi) = (ca.min(cb) as f64, ca.max(cb) as f64);
    let rare = lo <= 2f64.max(hi / 8.0);
    if !rare && short < 8 {
        return None;
    }
    Some(if distance == 1 { 0.75 } else { 0.6 })
}

// ── The analysis ─────────────────────────────────────────────────────────────

pub fn analyze_tags(index: &TagIndex, options: &AnalysisOptions) -> Vec<Suggestion> {
    let mut cache = AnalysisCache::default();
    let touched = cache.update(index, &mut AnalysisStats::default());
    analyze(index, options, &mut cache, touched.as_ref(), &mut AnalysisStats::default())
}

fn analyze(index: &TagIndex, options: &AnalysisOptions, cache: &mut AnalysisCache, touched: Option<&HashSet<String>>, stats: &mut AnalysisStats) -> Vec<Suggestion> {
    let changed = |name: &str| touched.is_none_or(|t| t.contains(&fold(name.trim())));
    let tags = &index.tags;
    let items = &index.items;
    let n = tags.len();
    let mut out: Vec<Suggestion> = Vec::new();
    let counts: Vec<usize> = tags.iter().map(|t| t.count).collect();
    let by_name: HashMap<&str, usize> = tags.iter().enumerate().map(|(i, t)| (t.name.as_str(), i)).collect();
    let live = items.len().max(1) as f64;
    let mut holders: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (i, item) in items.iter().enumerate() {
        for &t in &item.tags {
            if let Some(h) = holders.get_mut(t) {
                h.push(i);
            }
        }
    }
    let union_count = |names: &[String]| -> usize {
        let mut seen = HashSet::new();
        for name in names {
            if let Some(&i) = by_name.get(name.as_str()) {
                seen.extend(holders[i].iter().copied());
            }
        }
        seen.len()
    };
    let count = |name: &str| by_name.get(name).map(|&i| counts[i]).unwrap_or(0);
    let normals: Vec<Normal> = tags.iter().map(|t| normalize(&t.name)).collect();
    let property = |name: &str, values: Vec<(String, String)>, confidence: f64, evidence: String| -> Suggestion {
        let existing = options.properties.iter().find(|p| fold(&p.name) == fold(name));
        let tags_in: Vec<String> = values.iter().map(|(t, _)| t.clone()).collect();
        let title = match existing {
            Some(p) => format!("Add {} to the {} property", plural(tags_in.len(), "tag"), quote(&p.name)),
            None => format!("Turn {} into a {} property", plural(tags_in.len(), "tag"), quote(name)),
        };
        Suggestion {
            id: suggestion_id("property", &tags_in),
            kind: "property",
            title,
            evidence,
            confidence,
            items: union_count(&tags_in),
            tags: tags_in,
            plan: TagPlan::Property {
                name: existing.map(|p| p.name.clone()).unwrap_or_else(|| name.to_string()),
                property_type: "select".into(),
                values: values.into_iter().map(|(t, v)| (t, Json::from(v))).collect(),
                remove_tags: true,
            },
            change: None,
        }
    };

    // 1. Variants: the same words apart from case, spacing, hyphens, plurals, order or a prefix.
    let mut uf = UnionFind((0..n).collect());
    let mut edge: HashMap<(usize, usize), (f64, String)> = HashMap::new();
    let mut link = |uf: &mut UnionFind, a: usize, b: usize, confidence: f64, why: String| {
        if a == b {
            return;
        }
        let key = (a.min(b), a.max(b));
        if edge.get(&key).is_none_or(|old| old.0 < confidence) {
            edge.insert(key, (confidence, why));
        }
        uf.union(a, b);
    };
    for (squash, confidence, why) in [(true, 0.95, "Same words apart from case, spacing, punctuation or plural"), (false, 0.85, "Same words in a different order")] {
        let mut groups: HashMap<&str, usize> = HashMap::new();
        for (i, norm) in normals.iter().enumerate() {
            let key = if squash { norm.squash.as_str() } else { norm.sorted.as_str() };
            if len16(key) < 2 {
                continue;
            }
            match groups.get(key) {
                None => {
                    groups.insert(key, i);
                }
                Some(&first) => link(&mut uf, first, i, confidence, why.into()),
            }
        }
    }

    // Near spellings, compared within blocks that share a word or a leading trigram.
    let mut blocks: Ordered<Vec<usize>> = Ordered::new();
    for (i, norm) in normals.iter().enumerate() {
        if len16(&norm.squash) < 5 {
            continue;
        }
        let mut keys: Vec<String> = vec![format!("p:{}", norm.squash.chars().take(3).collect::<String>())];
        for w in norm.words.iter().filter(|w| len16(w) >= 4) {
            let key = format!("w:{w}");
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        for key in keys {
            blocks.entry(&key).push(i);
        }
    }
    let mut compared: HashSet<(usize, usize)> = HashSet::new();
    // Pairs of tags that did not change keep their verdict; only changed tags are compared.
    let fresh: Vec<bool> = tags.iter().map(|t| changed(&t.name)).collect();
    let known: HashMap<(usize, usize), f64> = cache
        .spelled
        .iter()
        .filter_map(|((x, y), &c)| {
            let (a, b) = (*by_name.get(x.as_str())?, *by_name.get(y.as_str())?);
            Some(((a.min(b), a.max(b)), c))
        })
        .collect();
    for (_, block) in &blocks.entries {
        if block.len() < 2 || block.len() > 400 {
            continue;
        }
        for x in 0..block.len() {
            for y in x + 1..block.len() {
                let (a, b) = (block[x], block[y]);
                if uf.find(a) == uf.find(b) || !compared.insert((a, b)) {
                    continue;
                }
                let verdict = if !fresh[a] && !fresh[b] {
                    known.get(&(a.min(b), a.max(b))).copied()
                } else {
                    stats.compared += 1;
                    let v = spelled_alike(&normals[a], &normals[b], counts[a], counts[b]);
                    if let Some(c) = v {
                        let pair = if tags[a].name <= tags[b].name { (tags[a].name.clone(), tags[b].name.clone()) } else { (tags[b].name.clone(), tags[a].name.clone()) };
                        cache.spelled.insert(pair, c);
                    }
                    v
                };
                if let Some(confidence) = verdict {
                    link(&mut uf, a, b, confidence, "Spelled almost the same".into());
                }
            }
        }
    }

    // Initialisms: "ML" and "machine learning", "RCT" and "randomised controlled trials".
    let mut initials: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, norm) in normals.iter().enumerate() {
        let words: Vec<&String> = norm.words.iter().filter(|w| !stop(w)).collect();
        if (2..=6).contains(&words.len()) {
            let key: String = words.iter().filter_map(|w| w.chars().next()).collect();
            initials.entry(key).or_default().push(i);
        }
    }
    for (i, norm) in normals.iter().enumerate() {
        let raw = strip_prefix(&tags[i].name);
        let upper = raw.strip_suffix('s').unwrap_or(raw);
        let shaped = (2..=6).contains(&upper.len()) && upper.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
        if norm.words.len() != 1 || len16(&norm.squash) < 2 || len16(&norm.squash) > 6 || !shaped {
            continue;
        }
        let matches = initials.get(norm.squash.strip_suffix('s').unwrap_or(&norm.squash)).or_else(|| initials.get(&norm.squash));
        // Only an unambiguous expansion (its spelling variants count as one).
        if let Some(matches) = matches.filter(|m| !m.is_empty()) {
            let roots: HashSet<usize> = matches.iter().map(|&m| uf.find(m)).collect();
            if roots.len() == 1 {
                let to = matches[0];
                link(&mut uf, i, to, 0.65, format!("{} reads as the initials of {}", quote(&tags[i].name), quote(&tags[to].name)));
            }
        }
    }

    let mut in_merge: HashSet<usize> = HashSet::new();
    let mut components: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in 0..n {
        let root = uf.find(i);
        components.entry(root).or_default().push(i);
    }
    for members in components.values() {
        if members.len() < 2 || members.len() > 12 {
            continue;
        }
        let mut confidence: f64 = 1.0;
        let mut reasons: Vec<String> = Vec::new();
        for x in 0..members.len() {
            for y in x + 1..members.len() {
                let key = (members[x].min(members[y]), members[x].max(members[y]));
                if let Some((c, why)) = edge.get(&key) {
                    confidence = confidence.min(*c);
                    if !reasons.contains(why) {
                        reasons.push(why.clone());
                    }
                }
            }
        }
        let mut names: Vec<String> = members.iter().map(|&i| tags[i].name.clone()).collect();
        names.sort_by(|a, b| locale_cmp(a, b));
        let to = survivor(&names, &count);
        in_merge.extend(members.iter().copied());
        let from: Vec<String> = names.iter().filter(|t| **t != to).cloned().collect();
        out.push(Suggestion {
            id: suggestion_id("merge", &names),
            kind: "merge",
            title: format!("Merge {} into {}", list(&from, 3), quote(&to)),
            evidence: reasons.join(". "),
            confidence,
            items: union_count(&names),
            tags: names,
            plan: TagPlan::Merge { from, to },
            change: None,
        });
    }

    // 2. Paths written into names.
    let mut by_root: Ordered<Vec<(String, Vec<String>)>> = Ordered::new();
    for t in tags {
        if index.parent_of(&t.name).is_some() {
            continue;
        }
        if let Some(path) = split_path(&t.name) {
            by_root.entry(&fold(&path[0])).push((t.name.clone(), path));
        }
    }
    let mut in_path: HashSet<String> = HashSet::new();
    for (_, group) in &by_root.entries {
        let root = group[0].1[0].clone();
        if group.len() < 2 && !by_name.contains_key(root.as_str()) {
            continue;
        }
        let names: Vec<String> = group.iter().map(|g| g.0.clone()).collect();
        in_path.extend(names.iter().cloned());
        out.push(Suggestion {
            id: suggestion_id("hierarchy", &names),
            kind: "hierarchy",
            title: format!("Nest {} under {}", plural(group.len(), "tag"), quote(&root)),
            evidence: format!("Their names start with {}: {}", quote(&root), list(&names, 2)),
            confidence: if group.len() >= 3 { 0.85 } else { 0.7 },
            items: union_count(&names),
            tags: names,
            plan: TagPlan::Hierarchy { splits: group.iter().map(|(tag, path)| crate::tag_plan::Split { tag: tag.clone(), path: path.clone() }).collect() },
            change: None,
        });
        // A prefix family is often one property with values ("status: read", "status: to read").
        if (2..=30).contains(&group.len()) && group.iter().all(|g| g.1.len() == 2) {
            let values: Vec<(String, String)> = group.iter().map(|(tag, path)| (tag.clone(), value_label(&path[1], None))).collect();
            let evidence = format!("{} reads as a property with {}", quote(&root), plural(values.len(), "value"));
            out.push(property(&value_label(&root, None), values, 0.6, evidence));
        }
    }

    // 3. Families from the built-in vocabularies, years, and flags.
    for fam in families() {
        let mut values: Vec<(String, String)> = Vec::new();
        for (i, t) in tags.iter().enumerate() {
            if let Some(shown) = fam.values.get(&normals[i].squash) {
                if !in_path.contains(&t.name) {
                    values.push((t.name.clone(), shown.to_string()));
                }
            }
        }
        let distinct: HashSet<&String> = values.iter().map(|(_, v)| v).collect();
        if distinct.len() >= fam.min {
            let names: Vec<String> = values.iter().map(|(t, _)| t.clone()).collect();
            let evidence = format!("{} look like values of one {}", list(&names, 3), fam.property.to_lowercase());
            out.push(property(fam.property, values, 0.75, evidence));
        }
    }
    let mut years: Vec<(String, String)> =
        tags.iter().filter_map(|t| Some(strip_prefix(&t.name).trim()).filter(|b| is_year(b)).map(|b| (t.name.clone(), b.to_string()))).collect();
    if years.len() >= 3 {
        years.sort_by(|a, b| locale_cmp(&b.1, &a.1));
        let evidence = format!("{} are years", plural(years.len(), "tag"));
        out.push(property("Year tag", years, 0.55, evidence));
    }
    for (i, t) in tags.iter().enumerate() {
        let folded = fold(&t.name);
        let bare = strip_prefix(&folded).trim();
        let flag_like = FLAGS.contains(&bare) || (normals[i].prefixed && normals[i].words.len() <= 3 && t.count >= 2);
        if !flag_like || in_merge.contains(&i) || in_path.contains(&t.name) {
            continue;
        }
        out.push(Suggestion {
            id: suggestion_id("property", std::slice::from_ref(&t.name)),
            kind: "property",
            title: format!("Make {} a checkbox", quote(&t.name)),
            evidence: if normals[i].prefixed { "A marked tag like this usually flags items for a workflow" } else { "Reads as a yes/no flag on an item" }.into(),
            confidence: if normals[i].prefixed { 0.65 } else { 0.6 },
            tags: vec![t.name.clone()],
            items: t.count,
            plan: TagPlan::Property { name: value_label(&t.name, None), property_type: "boolean".into(), values: vec![(t.name.clone(), Json::Bool(true))], remove_tags: true },
            change: None,
        });
    }

    // 4. Junk: on nearly everything, automatic headings, numbers and garbage, very long, once only.
    let automatic_set: HashSet<String> = AUTOMATIC.iter().map(|t| normalize(t).squash).collect();
    let (mut junk, mut automatic, mut everywhere, mut once) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (i, t) in tags.iter().enumerate() {
        let bare = strip_prefix(&t.name).trim();
        let lower = bare.to_ascii_lowercase();
        let has_letter = bare.chars().any(char::is_alphabetic);
        if items.len() >= 20 && t.count as f64 / live >= 0.6 {
            everywhere.push(t.name.clone());
        } else if automatic_set.contains(&normals[i].squash) && !in_merge.contains(&i) {
            automatic.push(t.name.clone());
        } else if !has_letter && !is_year(bare) {
            junk.push(t.name.clone());
        } else if len16(bare) > 60
            || bare.split_whitespace().count().max(1) > 8
            || lower.starts_with("http:")
            || lower.starts_with("https:")
            || lower.starts_with("www.")
            || is_doi_start(bare)
            || (bare.len() >= 12 && bare.chars().all(|c| c.is_ascii_hexdigit()))
        {
            junk.push(t.name.clone());
        } else if t.count == 1 && !in_merge.contains(&i) && !in_path.contains(&t.name) {
            once.push(t.name.clone());
        }
    }
    let cleanup = |out: &mut Vec<Suggestion>, tags: Vec<String>, title: String, evidence: String, confidence: f64| {
        if tags.is_empty() {
            return;
        }
        out.push(Suggestion {
            id: suggestion_id("cleanup", &tags),
            kind: "cleanup",
            title,
            evidence,
            confidence,
            items: union_count(&tags),
            plan: TagPlan::Delete { tags: tags.clone() },
            tags,
            change: None,
        });
    };
    let title = format!("Remove {} that {} like noise", plural(junk.len(), "tag"), if junk.len() == 1 { "looks" } else { "look" });
    cleanup(&mut out, junk, title, "Numbers, links, identifiers or whole sentences rather than topics".into(), 0.7);
    let title = format!("Remove {}", plural(automatic.len(), "automatic subject heading"));
    cleanup(&mut out, automatic, title, "Headings such as “Humans” or “Female” that catalogues add to every record".into(), 0.55);
    for t in everywhere {
        let share = (count(&t) as f64 / live * 100.0).round();
        let title = format!("Remove {} from all items", quote(&t));
        cleanup(&mut out, vec![t], title, format!("On {share}% of tagged items, so it does not tell them apart (an import marker?)"), 0.5);
    }
    if once.len() >= 5 {
        let title = format!("Remove {} used only once", plural(once.len(), "tag"));
        cleanup(&mut out, once, title, "Each is on a single item; review before removing".into(), 0.3);
    }

    // 5. Co-occurrence: tags that always travel together, and tags that sit inside another.
    // Counted once and then kept up to date item by item (AnalysisCache::update).
    let mut pairs: Vec<((usize, usize), usize)> =
        cache.together.iter().filter_map(|((x, y), &both)| Some(((*by_name.get(x.as_str())?, *by_name.get(y.as_str())?), both))).collect();
    pairs.sort_unstable();
    let mut nested_child: HashSet<usize> = HashSet::new();
    let mut parents: BTreeMap<usize, (usize, f64, usize)> = BTreeMap::new();
    for ((a, b), both) in pairs {
        if both < 3 || uf.find(a) == uf.find(b) {
            continue;
        }
        let (ca, cb) = (counts[a] as f64, counts[b] as f64);
        let jaccard = both as f64 / (ca + cb - both as f64);
        if a < b && jaccard >= 0.9 {
            let mut names = vec![tags[a].name.clone(), tags[b].name.clone()];
            names.sort_by(|x, y| locale_cmp(x, y));
            let to = survivor(&names, &count);
            let other = names.iter().find(|t| **t != to).cloned().unwrap_or_default();
            out.push(Suggestion {
                id: suggestion_id("together", &names),
                kind: "merge",
                title: format!("Combine {} with {}", quote(&other), quote(&to)),
                evidence: format!("Used together on {both} of {} items", counts[a].max(counts[b])),
                confidence: 0.45 + 0.4 * jaccard * (both as f64 / 10.0).min(1.0),
                items: union_count(&names),
                plan: TagPlan::Merge { from: names.iter().filter(|t| **t != to).cloned().collect(), to },
                tags: names,
                change: None,
            });
            continue;
        }
        // a inside b: nearly every item with a has b, and b is clearly broader (not on everything).
        let ratio = both as f64 / ca;
        if ratio < 0.9 || cb < ca * 1.5 || cb / live > 0.5 || index.parent_of(&tags[a].name).is_some() {
            continue;
        }
        let better = match parents.get(&a) {
            None => true,
            Some(&(best, _, _)) => counts[b] < counts[best] || (counts[b] == counts[best] && cmp_utf16(&tags[b].name, &tags[best].name) == Ordering::Less),
        };
        if better {
            parents.insert(a, (b, ratio, both));
        }
    }
    let mut by_parent: BTreeMap<usize, Vec<(usize, f64, usize)>> = BTreeMap::new();
    for (&child, &(parent, ratio, both)) in &parents {
        by_parent.entry(parent).or_default().push((child, ratio, both));
    }
    for (parent, children) in by_parent {
        // A parent that is itself nested under one of these children would make a cycle.
        let mut kids: Vec<(usize, f64, usize)> = children.into_iter().filter(|c| parents.get(&parent).map(|p| p.0) != Some(c.0)).collect();
        kids.sort_by(|x, y| locale_cmp(&tags[x.0].name, &tags[y.0].name));
        if kids.is_empty() {
            continue;
        }
        nested_child.extend(kids.iter().map(|c| c.0));
        let names: Vec<String> = kids.iter().map(|c| tags[c.0].name.clone()).collect();
        let support = (kids.iter().map(|c| c.2).sum::<usize>() as f64 / 12.0).min(1.0);
        let ratio = kids.iter().map(|c| c.1).fold(f64::INFINITY, f64::min);
        let parent_name = tags[parent].name.clone();
        let evidence = if kids.len() == 1 {
            format!("{} of {} items tagged {} are also tagged {}", kids[0].2, counts[kids[0].0], quote(&names[0]), quote(&parent_name))
        } else {
            format!("Nearly every item with these tags is also tagged {} ({}% or more)", quote(&parent_name), (ratio * 100.0).round())
        };
        let mut all = vec![parent_name.clone()];
        all.extend(names.iter().cloned());
        out.push(Suggestion {
            id: suggestion_id("nest", &all),
            kind: "nest",
            title: format!("Nest {} under {}", list(&names, 3), quote(&parent_name)),
            evidence,
            confidence: 0.4 + 0.45 * support * ratio,
            tags: all,
            items: 0,
            plan: TagPlan::Nest { parent: parent_name, children: names, rename_parent: None },
            change: None,
        });
    }

    // 6. Themes: TF-IDF over each tag's words (weighted) and its items' title words.
    let mut candidates: Vec<usize> =
        (0..n).filter(|&i| counts[i] >= 2 && index.parent_of(&tags[i].name).is_none() && !nested_child.contains(&i) && !in_path.contains(&tags[i].name)).collect();
    candidates.sort_by(|&a, &b| counts[b].cmp(&counts[a]).then_with(|| locale_cmp(&tags[a].name, &tags[b].name)));
    candidates.truncate(1500);
    let mut docs: Vec<HashMap<String, usize>> = Vec::with_capacity(candidates.len());
    let mut df: HashMap<String, usize> = HashMap::new();
    let mut kept_docs: HashMap<String, (u64, HashMap<String, usize>)> = HashMap::new();
    for &i in &candidates {
        // Read again only when the tag or the items it is read from changed.
        let source = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            tags[i].name.hash(&mut h);
            for &x in holders[i].iter().take(40) {
                items[x].id.hash(&mut h);
                items[x].title.hash(&mut h);
            }
            h.finish()
        };
        let doc = match cache.docs.remove(&tags[i].name) {
            Some((hash, doc)) if hash == source => doc,
            _ => {
                stats.read += 1;
                let mut doc: HashMap<String, usize> = HashMap::new();
                for w in &normals[i].words {
                    if len16(w) >= 3 && !stop(w) {
                        *doc.entry(w.clone()).or_insert(0) += 3;
                    }
                }
                for &h in holders[i].iter().take(40) {
                    let title = fold(items[h].title.as_deref().unwrap_or_default());
                    for w in title.split(|c: char| !c.is_alphabetic()) {
                        if len16(w) >= 4 && !stop(w) {
                            *doc.entry(spelling(&singular(w))).or_insert(0) += 1;
                        }
                    }
                }
                doc
            }
        };
        kept_docs.insert(tags[i].name.clone(), (source, doc.clone()));
        for w in doc.keys() {
            *df.entry(w.clone()).or_insert(0) += 1;
        }
        docs.push(doc);
    }
    cache.docs = kept_docs;
    let d_count = docs.len().max(1) as f64;
    let vectors: Vec<Vec<(String, f64)>> = docs
        .iter()
        .map(|doc| {
            let mut weighted: Vec<(String, f64)> = doc
                .iter()
                .filter_map(|(w, &tf)| {
                    let f = *df.get(w).unwrap_or(&1) as f64;
                    (f > 1.0 && f / d_count < 0.2).then(|| (w.clone(), (1.0 + (tf as f64).ln()) * (d_count / f).ln()))
                })
                .collect();
            weighted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal).then_with(|| locale_cmp(&a.0, &b.0)));
            weighted.truncate(20);
            let norm = weighted.iter().map(|(_, v)| v * v).sum::<f64>().sqrt();
            let norm = if norm > 0.0 { norm } else { 1.0 };
            weighted.into_iter().map(|(w, v)| (w, v / norm)).collect()
        })
        .collect();
    let lookup: Vec<HashMap<&str, f64>> = vectors.iter().map(|v| v.iter().map(|(w, x)| (w.as_str(), *x)).collect()).collect();
    let mut postings: HashMap<&str, Vec<usize>> = HashMap::new();
    for (d, v) in vectors.iter().enumerate() {
        for (w, _) in v {
            postings.entry(w.as_str()).or_default().push(d);
        }
    }
    let mut assigned: Vec<i64> = vec![-1; vectors.len()];
    let mut themes: Vec<(Vec<usize>, Vec<f64>)> = Vec::new();
    for d in 0..vectors.len() {
        if assigned[d] >= 0 || vectors[d].is_empty() {
            continue;
        }
        let mut scores: HashMap<usize, f64> = HashMap::new();
        let mut order: Vec<usize> = Vec::new();
        for (w, v) in &vectors[d] {
            for &o in postings.get(w.as_str()).map(Vec::as_slice).unwrap_or_default() {
                if o != d && assigned[o] < 0 {
                    let score = scores.entry(o).or_insert_with(|| {
                        order.push(o);
                        0.0
                    });
                    *score += v * lookup[o].get(w.as_str()).copied().unwrap_or(0.0);
                }
            }
        }
        let root = uf.find(candidates[d]);
        let mut members: Vec<(usize, f64)> = order.iter().map(|&o| (o, scores[&o])).filter(|&(o, s)| s >= 0.35 && uf.find(candidates[o]) != root).collect();
        members.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal).then(a.0.cmp(&b.0)));
        members.truncate(14);
        if members.len() < 2 {
            continue;
        }
        let theme = themes.len() as i64;
        assigned[d] = theme;
        for &(o, _) in &members {
            assigned[o] = theme;
        }
        let mut all = vec![d];
        all.extend(members.iter().map(|m| m.0));
        themes.push((all, members.iter().map(|m| m.1).collect()));
    }
    for (members, sims) in themes.iter().take(options.max_themes.unwrap_or(12)) {
        let mut weight: Vec<(String, f64)> = Vec::new();
        let mut at: HashMap<&str, usize> = HashMap::new();
        for &m in members {
            for (w, v) in &vectors[m] {
                match at.get(w.as_str()) {
                    Some(&k) => weight[k].1 += v,
                    None => {
                        at.insert(w.as_str(), weight.len());
                        weight.push((w.clone(), *v));
                    }
                }
            }
        }
        weight.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal).then_with(|| locale_cmp(&a.0, &b.0)));
        let Some(top) = weight.first().map(|w| w.0.clone()) else { continue };
        let names: Vec<String> = members.iter().map(|&m| tags[candidates[m]].name.clone()).collect();
        let existing = names.iter().find(|t| normalize(t).squash == top).cloned();
        let parent = existing.clone().unwrap_or_else(|| capitalize(&top));
        let mut children: Vec<String> = names.iter().filter(|t| Some(*t) != existing.as_ref()).cloned().collect();
        children.sort_by(|a, b| locale_cmp(a, b));
        let shared: Vec<String> = weight.iter().take(3).map(|(w, _)| quote(w)).collect();
        let mean = sims.iter().sum::<f64>() / sims.len() as f64;
        let mut all = vec![parent.clone()];
        all.extend(children.iter().cloned());
        out.push(Suggestion {
            id: suggestion_id("theme", &names),
            kind: "nest",
            title: format!("Group {} under {}", plural(children.len(), "related tag"), quote(&parent)),
            evidence: format!("Their items share words like {}", shared.join(", ")),
            confidence: 0.6f64.min(0.25 + mean / 2.0),
            tags: all,
            items: 0,
            plan: TagPlan::Nest { parent, children, rename_parent: None },
            change: None,
        });
    }

    let mut seen = HashSet::new();
    let mut out: Vec<Suggestion> = out.into_iter().filter(|s| !options.dismissed.contains(&s.id) && seen.insert(s.id.clone())).collect();
    out.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(Ordering::Equal).then(b.items.cmp(&a.items)).then_with(|| locale_cmp(&a.id, &b.id)));
    out
}

/// The analysis with each suggestion's change planned against the same index.
pub fn suggestions_with_changes(index: &TagIndex, options: &AnalysisOptions) -> Vec<Suggestion> {
    suggestions_cached(index, options, &mut AnalysisCache::default()).0
}

/// The same, reusing what `cache` kept from the last run: only the tags that changed since
/// (and their neighbours: tags sharing a spelling block, an item or a branch of the tree)
/// are compared, read and planned again.
pub fn suggestions_cached(index: &TagIndex, options: &AnalysisOptions, cache: &mut AnalysisCache) -> (Vec<Suggestion>, AnalysisStats) {
    let mut stats = AnalysisStats::default();
    let touched = cache.update(index, &mut stats);
    let mut list = analyze(index, options, cache, touched.as_ref(), &mut stats);
    let context = PlanContext::new(index);
    let affected = |plan: &TagPlan| {
        let Some(touched) = &touched else { return true };
        plan_names(plan).into_iter().any(|name| touched.contains(&fold(name.trim())) || context.ancestors(name).iter().any(|a| touched.contains(&fold(a.trim()))))
    };
    let mut plans: HashMap<String, (TagPlan, Option<PlannedChange>)> = HashMap::with_capacity(list.len());
    for s in &mut list {
        s.change = match cache.plans.remove(&s.id) {
            Some((plan, change)) if plan == s.plan && !affected(&s.plan) => change,
            _ => {
                stats.planned += 1;
                context.plan(&s.plan).ok()
            }
        };
        plans.insert(s.id.clone(), (s.plan.clone(), s.change.clone()));
    }
    // Only this run's plans: one left out now could miss a change before it comes back.
    cache.plans = plans;
    (list, stats)
}

const DISMISSED_KEY: &str = "ui.tagManager.dismissed";

impl Store {
    pub fn tag_index_typed(&self) -> Result<TagIndex> {
        serde_json::from_value(self.tag_index()?).map_err(|e| e.to_string())
    }

    /// Suggestions for the tag manager: `dismissed` defaults to the ids the manager keeps.
    pub fn tag_suggestions(&self, dismissed: Option<Vec<String>>, max_themes: Option<usize>) -> Result<Vec<Suggestion>> {
        let index = self.tag_index_typed()?;
        let dismissed = match dismissed {
            Some(ids) => ids,
            None => self.meta(DISMISSED_KEY)?.and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok()).unwrap_or_default(),
        };
        let properties = self.property_definitions()?.into_iter().filter_map(|d| serde_json::from_value::<PropertyInfo>(d).ok()).collect();
        let options = AnalysisOptions { dismissed: dismissed.into_iter().collect(), properties, max_themes };
        let mut cache = self.tag_analysis.lock().map_err(|_| "Tag analysis is unavailable".to_string())?;
        Ok(suggestions_cached(&index, &options, &mut cache).0)
    }

    /// One plan (from a suggestion or the manager's own panels) as the store operation and
    /// its preview, against the tags as they are now.
    pub fn tag_plan(&self, plan: &TagPlan) -> Result<PlannedChange> {
        PlanContext::new(&self.tag_index_typed()?).plan(plan)
    }
}
