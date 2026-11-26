// Duplicate sources: a matcher that works on plain `Work` records (so importers and the
// "in library" badges can ask about works that are not in the library yet), the library's
// duplicate groups, the user's decisions about pairs ("not duplicates", "versions of one
// work") and merging.
//
// Matching, strongest first:
//  - exact: the same normalised DOI, PMID, PMCID, arXiv id or ISBN, or an identical file;
//  - different DOIs (or PMIDs) are different works, except a preprint and its published
//    version, which are "versions";
//  - likely: normalised titles agree (case, diacritics, punctuation, a subtitle left off),
//    years at most one apart, first authors agree; scored for similarity. A book and a
//    chapter of it, or two editions, are never duplicates.
// A merged-away source stays as a hidden row pointing at the one it was merged into, so
// its id keeps resolving (links in notes and canvases, Zotero sync) and the merge can be
// undone (journal.rs).
use crate::graph::name_key;
use crate::normalize;
use crate::journal::{self, Operation, Recorder};
use crate::{Creator, DERIVED_FIELDS, Result, Source, Store, e, identify, normalize_tags, now_ms, patch_source_row, refresh_fts, sync_graph};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// A work to match: a library source or a record about to be imported.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Work {
    /// The library source it is, when it is one.
    pub id: Option<String>,
    pub title: Option<String>,
    pub year: Option<i64>,
    pub item_type: Option<String>,
    pub doi: Option<String>,
    pub isbn: Option<String>,
    pub pmid: Option<String>,
    pub pmcid: Option<String>,
    pub arxiv_id: Option<String>,
    pub file_hash: Option<String>,
    pub container_title: Option<String>,
    /// OpenAlex's type ("preprint", "article" …).
    pub work_type: Option<String>,
    pub edition: Option<String>,
    /// The first author's family name; read from `creators` when not given.
    pub first_author: Option<String>,
    pub creators: Vec<Creator>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase")]
pub enum MatchKind {
    Exact,
    Likely,
    /// A preprint and its published version.
    Version,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub kind: MatchKind,
    pub score: f64,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateMatch {
    pub source_id: String,
    pub kind: MatchKind,
    pub score: f64,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    /// Stable for the same members: the sorted ids joined.
    pub id: String,
    pub kind: MatchKind,
    pub score: f64,
    pub reason: String,
    pub ids: Vec<String>,
    pub sources: Vec<Source>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateReport {
    pub groups: Vec<DuplicateGroup>,
    /// Groups of duplicates (exact or likely), not counting versions.
    pub count: usize,
    /// Groups joined by an identifier or file alone, and the sources a merge would remove.
    pub exact_groups: usize,
    pub exact_removable: usize,
}

// ── Normalising (normalize.rs; the names here stay for callers) ─────────────

/// ISBN-13s in a field that may hold several ("978-0-262-03384-8, 0262033844").
pub fn normalize_isbns(text: &str) -> Vec<String> {
    normalize::isbns(text)
}

pub fn normalize_pmid(text: &str) -> Option<String> {
    normalize::pmid(text)
}

pub fn normalize_pmcid(text: &str) -> Option<String> {
    normalize::pmcid(text)
}

/// arXiv ids without prefix, URL or version: "2101.00001", "hep-th/9901001".
pub fn normalize_arxiv(text: &str) -> Option<String> {
    normalize::arxiv(text)
}

pub fn normalize_doi(text: &str) -> Option<String> {
    normalize::doi(text)
}

/// DOIs given by preprint servers (arXiv, bioRxiv and medRxiv, SSRN, OSF, Research Square …).
pub fn is_preprint_doi(doi: &str) -> bool {
    const PREFIXES: &[&str] = &["10.48550/", "10.2139/ssrn", "10.20944/preprints", "10.31234/", "10.31235/", "10.31219/", "10.31222/", "10.21203/rs", "10.26434/chemrxiv", "10.36227/techrxiv", "10.22541/au", "10.1590/scielopreprints"];
    // bioRxiv and medRxiv: 10.1101/2020.01.01.123456 (Cold Spring Harbor journals share the prefix).
    let biorxiv = doi.strip_prefix("10.1101/").is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()));
    biorxiv || PREFIXES.iter().any(|p| doi.starts_with(p))
}

/// A normalised title: folded case and diacritics, punctuation as spaces.
pub fn title_key(title: &str) -> String {
    normalize::title_key(title)
}

/// The title without its subtitle (after ":", " - ", " — " or "?"), when that leaves three words.
fn main_title(title: &str) -> Option<String> {
    let cut = [":", " - ", " – ", " — ", "? ", ". "].iter().filter_map(|sep| title.find(sep).map(|at| (at, sep.len()))).min_by_key(|(at, _)| *at)?;
    let main = title_key(&title[..cut.0]);
    (main.split_whitespace().count() >= 3).then_some(main)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shape {
    Book,
    Chapter,
    Other,
}

/// A work prepared for comparing.
#[derive(Clone, Debug, Default)]
struct Prepared {
    doi: Option<String>,
    isbns: Vec<String>,
    pmid: Option<String>,
    pmcid: Option<String>,
    arxiv: Option<String>,
    hash: Option<String>,
    title: String,
    main: Option<String>,
    family: Option<String>,
    year: Option<i64>,
    edition: Option<String>,
    shape: Option<Shape>,
    preprint: bool,
}

fn clean(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

fn prepare(work: &Work) -> Prepared {
    let doi = clean(&work.doi).and_then(|d| {
        normalize_doi(d).or_else(|| Some(normalize::doi_or_text(d)).filter(|b| b.starts_with("10.")))
    });
    let arxiv = clean(&work.arxiv_id).and_then(normalize_arxiv).or_else(|| doi.as_deref().filter(|d| d.starts_with("10.48550/")).and_then(normalize_arxiv));
    let shape = clean(&work.item_type).map(|t| match t.to_ascii_lowercase().as_str() {
        "book" | "monograph" | "edited-book" => Shape::Book,
        "booksection" | "chapter" | "book-chapter" | "book-section" | "chapter_in_book" => Shape::Chapter,
        _ => Shape::Other,
    });
    let container = clean(&work.container_title).map(|c| c.to_ascii_lowercase()).unwrap_or_default();
    let preprint = doi.as_deref().is_some_and(is_preprint_doi)
        || (arxiv.is_some() && doi.as_deref().is_none_or(is_preprint_doi))
        || clean(&work.work_type).is_some_and(|t| t.eq_ignore_ascii_case("preprint"))
        || clean(&work.item_type).is_some_and(|t| t.eq_ignore_ascii_case("preprint"))
        || ["arxiv", "biorxiv", "medrxiv", "ssrn", "preprint", "research square"].iter().any(|p| container.contains(p));
    let family = clean(&work.first_author).map(String::from).or_else(|| {
        work.creators.iter().find(|c| c.role == "author").or(work.creators.first()).and_then(|c| {
            c.family.clone().filter(|f| !f.trim().is_empty()).or_else(|| c.literal.as_ref().and_then(|l| l.split_whitespace().last().map(String::from)))
        })
    });
    let title = clean(&work.title).unwrap_or("");
    Prepared {
        doi,
        isbns: clean(&work.isbn).map(normalize_isbns).unwrap_or_default(),
        pmid: clean(&work.pmid).and_then(normalize_pmid),
        pmcid: clean(&work.pmcid).and_then(normalize_pmcid),
        arxiv,
        hash: clean(&work.file_hash).map(String::from),
        title: title_key(title),
        main: main_title(title),
        family: family.map(|f| name_key(&f)).filter(|f| !f.is_empty()),
        year: work.year,
        edition: clean(&work.edition).map(|e| name_key(e).trim_end_matches(" ed").to_string()).filter(|e| !e.is_empty()),
        shape,
        preprint,
    }
}

fn same_family(a: &str, b: &str) -> bool {
    a == b || a.split_whitespace().last() == b.split_whitespace().last()
}

/// How similar two normalised titles are, with a left-off subtitle counted as the same title.
fn titles(a: &Prepared, b: &Prepared) -> f64 {
    if a.title.is_empty() || b.title.is_empty() {
        return 0.0;
    }
    let sim = identify::title_similarity(&a.title, &b.title);
    let subtitle = a.main.as_deref() == Some(b.title.as_str()) || b.main.as_deref() == Some(a.title.as_str()) || (a.main.is_some() && a.main == b.main);
    if subtitle { sim.max(0.95) } else { sim }
}

fn exact(reason: &str) -> Option<Verdict> {
    Some(Verdict { kind: MatchKind::Exact, score: 1.0, reason: reason.into() })
}

fn compare_prepared(a: &Prepared, b: &Prepared) -> Option<Verdict> {
    // Title similarity is the costly part: worked out only once identifiers leave it open.
    let sim_cell = std::cell::OnceCell::new();
    let sim = || *sim_cell.get_or_init(|| titles(a, b));
    let one_preprint = a.preprint != b.preprint;
    let version = |score: f64, reason: &str| (sim() >= 0.85).then(|| Verdict { kind: MatchKind::Version, score, reason: reason.into() });
    if let (Some(x), Some(y)) = (&a.doi, &b.doi) {
        if x == y {
            return exact("Same DOI");
        }
        // Different DOIs are different works, unless one is the preprint of the other.
        return if one_preprint { version(sim(), "Preprint and published version") } else { None };
    }
    if let (Some(x), Some(y)) = (&a.pmid, &b.pmid) {
        return if x == y { exact("Same PMID") } else { None };
    }
    if let (Some(x), Some(y)) = (&a.pmcid, &b.pmcid) {
        return if x == y { exact("Same PMCID") } else { None };
    }
    if let (Some(x), Some(y)) = (&a.arxiv, &b.arxiv) {
        if x == y {
            return if one_preprint { version(sim().max(0.9), "Preprint and published version") } else { exact("Same arXiv ID") };
        }
        return None;
    }
    if let (Some(x), Some(y)) = (&a.hash, &b.hash) {
        if x == y {
            return exact("Identical file");
        }
    }
    // A book and one of its chapters share the ISBN (and often the title).
    if matches!((a.shape, b.shape), (Some(Shape::Book), Some(Shape::Chapter)) | (Some(Shape::Chapter), Some(Shape::Book))) {
        return None;
    }
    if let (Some(x), Some(y)) = (&a.edition, &b.edition) {
        if x != y {
            return None;
        }
    }
    if !a.isbns.is_empty() && !b.isbns.is_empty() {
        let shared = a.isbns.iter().any(|i| b.isbns.contains(i));
        let chapters = a.shape == Some(Shape::Chapter) && b.shape == Some(Shape::Chapter);
        if shared && !chapters {
            return exact("Same ISBN");
        }
        if !shared && !chapters {
            // Different ISBNs: other editions or formats; the title test below decides.
        }
    }
    let sim = sim();
    if sim < 0.88 {
        return None;
    }
    let words = a.title.split_whitespace().count().min(b.title.split_whitespace().count());
    let gap = match (a.year, b.year) {
        (Some(x), Some(y)) => Some((x - y).abs()),
        _ => None,
    };
    if gap.is_some_and(|g| g > if one_preprint { 3 } else { 1 }) {
        return None;
    }
    let authors = match (&a.family, &b.family) {
        (Some(x), Some(y)) if !same_family(x, y) => return None,
        (Some(_), Some(_)) => 1.0,
        _ => 0.4,
    };
    // A short title ("Introduction", "Editorial") alone says little.
    if words < 3 && (sim < 1.0 || authors < 1.0 || gap != Some(0)) {
        return None;
    }
    let years = match gap {
        Some(0) => 1.0,
        Some(1) => 0.5,
        Some(_) => 0.2,
        None => 0.5,
    };
    let score = ((0.7 * sim + 0.15 * years + 0.15 * authors) * 100.0).round() / 100.0;
    if one_preprint {
        return (score >= 0.8).then(|| Verdict { kind: MatchKind::Version, score, reason: "Preprint and published version".into() });
    }
    if score < 0.86 {
        return None;
    }
    let reason = if sim >= 0.999 { "Same title, year and author" } else { "Similar title, year and author" };
    Some(Verdict { kind: MatchKind::Likely, score, reason: reason.into() })
}

/// Whether two works are the same, and how sure that is.
pub fn compare(a: &Work, b: &Work) -> Option<Verdict> {
    compare_prepared(&prepare(a), &prepare(b))
}

// ── The library index ───────────────────────────────────────

/// Library works by each thing they can be matched on. Changed and removed sources are
/// marked dead and their new versions appended (`Store::index`), until a rebuild.
#[derive(Clone, Default)]
pub(crate) struct Index {
    works: Vec<(String, Prepared)>,
    by: HashMap<(&'static str, String), Vec<usize>>,
    dead: HashSet<usize>,
    slot: HashMap<String, usize>,
}

/// The largest block compared item by item (a very common surname or title start).
const MAX_BLOCK: usize = 400;
const STOP: &[&str] = &["a", "an", "the", "of", "on", "in", "and", "for", "to", "der", "die", "das", "le", "la", "les", "el", "los", "de"];

/// The keys a work is found by: identifiers, file, first author and title start. `author`
/// and `title` are blocks (many works share them), the others are exact.
fn keys(p: &Prepared) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    out.extend(p.doi.iter().map(|d| ("doi", d.clone())));
    out.extend(p.pmid.iter().map(|d| ("pmid", d.clone())));
    out.extend(p.pmcid.iter().map(|d| ("pmcid", d.clone())));
    out.extend(p.arxiv.iter().map(|d| ("arxiv", d.clone())));
    out.extend(p.hash.iter().map(|d| ("hash", d.clone())));
    out.extend(p.isbns.iter().map(|d| ("isbn", d.clone())));
    if let Some(family) = &p.family {
        out.push(("author", family.clone()));
    }
    let start: Vec<&str> = p.title.split_whitespace().filter(|w| !STOP.contains(w)).take(2).collect();
    if !start.is_empty() {
        out.push(("title", start.join(" ")));
    }
    out
}

fn is_block(kind: &str) -> bool {
    matches!(kind, "author" | "title")
}

/// Everything a library source is looked up by, stored in `source_match_keys` (kept by
/// triggers through `key_match_keys`): the duplicate keys above, plus what its link stands
/// for (a DOI, arXiv or PubMed id, or the normalised address) and its OpenAlex id. One list
/// for the "in library" matcher (matching.rs) and the duplicate candidates; whether two
/// works are the same is still `compare_prepared`'s call.
pub(crate) fn row_keys(work: &Work, url: Option<&str>, openalex: Option<&str>) -> Vec<(&'static str, String)> {
    let mut out = keys(&prepare(work));
    if let Some(link) = url.and_then(normalize::link_key) {
        out.push(match link {
            normalize::LinkKey::Doi(d) => ("doi", d),
            normalize::LinkKey::Arxiv(a) => ("arxiv", a),
            normalize::LinkKey::Pmid(p) => ("pmid", p),
            normalize::LinkKey::Url(u) => ("url", u),
        });
    }
    out.extend(openalex.and_then(normalize::openalex).map(|o| ("openalex", o)));
    out.sort();
    out.dedup();
    out
}

/// `key_match_keys(title, year, doi, isbn, pmid, pmcid, arxiv_id, file_hash, url, openalex_id,
/// creators)`: `row_keys` as a JSON array of `[kind, value]`, for the triggers of migration 012.
pub(crate) fn register(db: &Connection) -> Result<()> {
    use rusqlite::functions::FunctionFlags;
    use rusqlite::types::ValueRef;
    db.create_scalar_function("key_match_keys", 11, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
        let text = |i: usize| -> Option<String> {
            match ctx.get_raw(i) {
                ValueRef::Text(t) => std::str::from_utf8(t).ok().map(str::trim).filter(|t| !t.is_empty()).map(String::from),
                ValueRef::Integer(n) => Some(n.to_string()),
                _ => None,
            }
        };
        let year = match ctx.get_raw(1) {
            ValueRef::Integer(n) => Some(n),
            ValueRef::Real(f) => Some(f as i64),
            ValueRef::Text(t) => std::str::from_utf8(t).ok().and_then(|t| t.trim().get(..4)).and_then(|y| y.parse().ok()),
            _ => None,
        };
        let work = Work {
            title: text(0),
            year,
            doi: text(2),
            isbn: text(3),
            pmid: text(4),
            pmcid: text(5),
            arxiv_id: text(6),
            file_hash: text(7),
            creators: text(10).and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default(),
            ..Default::default()
        };
        let keys = row_keys(&work, text(8).as_deref(), text(9).as_deref());
        Ok(serde_json::to_string(&keys).unwrap_or_else(|_| "[]".into()))
    })
    .map_err(e)
}

impl Index {
    fn build(works: Vec<(String, Prepared)>) -> Self {
        let mut index = Self::default();
        for (id, p) in works {
            index.push(id, p);
        }
        index
    }

    fn push(&mut self, id: String, p: Prepared) {
        let at = self.works.len();
        for key in keys(&p) {
            self.by.entry(key).or_default().push(at);
        }
        if let Some(old) = self.slot.insert(id.clone(), at) {
            self.dead.insert(old);
        }
        self.works.push((id, p));
    }

    fn remove(&mut self, id: &str) {
        if let Some(old) = self.slot.remove(id) {
            self.dead.insert(old);
        }
    }

    fn live(&self, i: usize) -> bool {
        !self.dead.contains(&i)
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, id: &str) -> bool {
        self.slot.contains_key(id)
    }

    fn candidates(&self, p: &Prepared) -> Vec<usize> {
        let mut seen = BTreeSet::new();
        for key in keys(p) {
            if let Some(list) = self.by.get(&key) {
                let list = list.iter().copied().filter(|i| self.live(*i));
                if is_block(key.0) && self.by[&key].len() > MAX_BLOCK {
                    // Too common to compare with all: only the ones of about the same year.
                    seen.extend(list.filter(|i| match (self.works[*i].1.year, p.year) {
                        (Some(x), Some(y)) => (x - y).abs() <= 1,
                        _ => false,
                    }).take(MAX_BLOCK));
                } else {
                    seen.extend(list);
                }
            }
        }
        seen.into_iter().collect()
    }
}

/// Works gathered as they come (an import's own entries, for duplicates within one file),
/// matched with the same rules as the library's duplicates.
#[derive(Default)]
pub struct WorkIndex {
    index: Index,
}

impl WorkIndex {
    pub fn add(&mut self, id: &str, work: &Work) {
        let p = prepare(work);
        let at = self.index.works.len();
        for key in keys(&p) {
            self.index.by.entry(key).or_default().push(at);
        }
        // Not `push`: an import may add the same id twice, and both stay.
        self.index.works.push((id.to_string(), p));
    }

    /// The works added so far that are the same as `work`, best first.
    pub fn find(&self, work: &Work) -> Vec<DuplicateMatch> {
        let p = prepare(work);
        let mut found: Vec<DuplicateMatch> = self
            .index
            .candidates(&p)
            .into_iter()
            .filter_map(|i| compare_prepared(&p, &self.index.works[i].1).map(|v| DuplicateMatch { source_id: self.index.works[i].0.clone(), kind: v.kind, score: v.score, reason: v.reason }))
            .collect();
        found.sort_by(|a, b| a.kind.cmp(&b.kind).then(b.score.total_cmp(&a.score)));
        found
    }
}

const WORK_COLUMNS: &str = "SELECT id, title, year, item_type, doi, isbn, pmid, pmcid, arxiv_id, file_hash, container_title, work_type, edition, creators FROM sources";

fn read_work(r: &rusqlite::Row) -> rusqlite::Result<Work> {
    Ok(Work {
        id: Some(r.get(0)?),
        title: r.get(1)?,
        year: r.get(2)?,
        item_type: r.get(3)?,
        doi: r.get(4)?,
        isbn: r.get(5)?,
        pmid: r.get(6)?,
        pmcid: r.get(7)?,
        arxiv_id: r.get(8)?,
        file_hash: r.get(9)?,
        container_title: r.get(10)?,
        work_type: r.get(11)?,
        edition: r.get(12)?,
        creators: serde_json::from_str(&r.get::<_, String>(13)?).unwrap_or_default(),
        ..Default::default()
    })
}

fn library_works(db: &Connection) -> Result<Vec<(String, Prepared)>> {
    let mut statement = db.prepare(&format!("{WORK_COLUMNS} WHERE trashed_at IS NULL")).map_err(e)?;
    let rows = statement.query_map([], read_work).map_err(e)?;
    let mut out = Vec::new();
    for work in rows {
        let work = work.map_err(e)?;
        out.push((work.id.clone().unwrap_or_default(), prepare(&work)));
    }
    Ok(out)
}

/// One library source prepared, when it is in the library (not trashed or merged away).
fn library_work(db: &Connection, id: &str) -> Result<Option<Prepared>> {
    let mut statement = db.prepare_cached(&format!("{WORK_COLUMNS} WHERE id = ? AND trashed_at IS NULL")).map_err(e)?;
    statement.query_row([id], read_work).optional().map_err(e).map(|w| w.as_ref().map(prepare))
}

/// The library sources that might be the same work as `p`, through `source_match_keys`
/// (the same keys and block limits as `Index::candidates`), in library order.
fn candidates_in(db: &Connection, p: &Prepared) -> Result<Vec<String>> {
    let mut found: BTreeMap<i64, String> = BTreeMap::new();
    let mut exact = db.prepare_cached("SELECT s.rowid, s.id FROM source_match_keys k JOIN sources s ON s.id = k.source_id WHERE k.kind = ?1 AND k.value = ?2 AND s.trashed_at IS NULL").map_err(e)?;
    let mut count = db.prepare_cached("SELECT count(*) FROM (SELECT 1 FROM source_match_keys WHERE kind = ?1 AND value = ?2 LIMIT ?3)").map_err(e)?;
    let mut near = db
        .prepare_cached("SELECT s.rowid, s.id FROM source_match_keys k JOIN sources s ON s.id = k.source_id WHERE k.kind = ?1 AND k.value = ?2 AND k.year BETWEEN ?3 - 1 AND ?3 + 1 AND s.trashed_at IS NULL ORDER BY s.rowid LIMIT ?4")
        .map_err(e)?;
    for (kind, value) in keys(p) {
        let large = is_block(kind) && count.query_row(params![kind, value, MAX_BLOCK as i64 + 1], |r| r.get::<_, i64>(0)).map_err(e)? > MAX_BLOCK as i64;
        let rows: Vec<(i64, String)> = if large {
            // Too common to compare with all: only the ones of about the same year.
            let Some(year) = p.year else { continue };
            near.query_map(params![kind, value, year, MAX_BLOCK as i64], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<std::result::Result<_, _>>().map_err(e)?
        } else {
            exact.query_map(params![kind, value], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        found.extend(rows);
    }
    Ok(found.into_values().collect())
}

fn pair_key(a: &str, b: &str) -> (String, String) {
    if a < b { (a.into(), b.into()) } else { (b.into(), a.into()) }
}

fn decided_pairs(db: &Connection) -> Result<HashSet<(String, String, String)>> {
    let mut statement = db.prepare("SELECT a, b, kind FROM source_pairs").map_err(e)?;
    let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(e)?;
    rows.collect::<std::result::Result<_, _>>().map_err(e)
}

struct Find {
    parent: Vec<usize>,
}
impl Find {
    fn new(n: usize) -> Self {
        Self { parent: (0..n).collect() }
    }
    fn root(&mut self, mut i: usize) -> usize {
        while self.parent[i] != i {
            self.parent[i] = self.parent[self.parent[i]];
            i = self.parent[i];
        }
        i
    }
    fn join(&mut self, a: usize, b: usize) {
        let (a, b) = (self.root(a), self.root(b));
        if a != b {
            self.parent[a.max(b)] = a.min(b);
        }
    }
}

/// How complete a source is, to choose which one a merge keeps.
fn completeness(source: &Source) -> i64 {
    let fields = source.fields.iter().filter(|(k, v)| !DERIVED_FIELDS.contains(&k.as_str()) && !v.is_null() && v.as_str() != Some("")).count() as i64;
    let edited = source.fields.get("editedFields").and_then(Json::as_array).map_or(0, |a| a.len()) as i64;
    fields + source.creators.len().min(5) as i64 + 6 * i64::from(source.file_path().is_some()) + 2 * edited + 2 * (source.note_count + source.annotation_count).min(10)
}

/// Fields compared side by side when merging, in the inspector's order.
const MERGE_FIELDS: &[&str] = &[
    "title", "shortTitle", "itemType", "date", "year", "containerTitle", "volume", "issue", "pages", "edition", "series", "publisher", "place", "institution", "doi", "isbn", "issn", "pmid", "pmcid",
    "arxivId", "url", "abstract", "language", "citationKey", "extra",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeField {
    pub field: String,
    pub label: String,
    /// Each source's value (null when it has none), in the order of `ids`.
    pub values: Vec<Json>,
    /// The index into `values` chosen by default.
    pub choice: usize,
    /// The sources that set this field by hand.
    pub edited: Vec<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// The sources, the one to keep first.
    pub sources: Vec<Source>,
    /// Fields where the sources differ.
    pub fields: Vec<MergeField>,
    /// What the merged source gains: tags, collections, notes, highlights, files.
    pub tags: Vec<String>,
    pub collections: Vec<String>,
    pub notes: i64,
    pub annotations: i64,
    /// Distinct files; a merge keeps one file per source, so more than one blocks it.
    pub files: usize,
    pub blocked: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    pub keep: String,
    pub others: Vec<String>,
    /// Field values the user chose (camelCase field → value); the rest follow the defaults.
    #[serde(default)]
    pub fields: Map<String, Json>,
}

fn value_of(source: &Source, field: &str) -> Json {
    match field {
        "creators" => if source.creators.is_empty() { Json::Null } else { serde_json::to_value(&source.creators).unwrap_or(Json::Null) },
        _ => source.fields.get(field).filter(|v| !v.is_null() && v.as_str().is_none_or(|s| !s.trim().is_empty())).cloned().unwrap_or(Json::Null),
    }
}

fn weight(value: &Json) -> usize {
    match value {
        Json::Null => 0,
        Json::String(s) => s.trim().chars().count(),
        Json::Array(a) => a.len() * 10,
        _ => 1,
    }
}

/// The default value per field: the kept source's when it was edited by hand there, else
/// another's edited by hand, else the most complete.
fn default_choice(values: &[Json], edited: &[bool]) -> usize {
    if edited.first() == Some(&true) && !values[0].is_null() {
        return 0;
    }
    if let Some(i) = edited.iter().position(|e| *e).filter(|i| !values[*i].is_null()) {
        return i;
    }
    let best = values.iter().map(weight).max().unwrap_or(0);
    // Ties go to the kept source.
    if weight(&values[0]) == best { 0 } else { values.iter().position(|v| weight(v) == best).unwrap_or(0) }
}

fn edited_set(source: &Source) -> Vec<String> {
    source.fields.get("editedFields").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str).map(String::from).collect()
}

/// Moves everything of `others` onto `keep` and hides them (one merge, inside a journaled operation).
fn merge_into(db: &Connection, recorder: &mut Recorder, keep: &Source, others: &[Source], chosen: &Map<String, Json>) -> Result<()> {
    let mut patch = Map::new();
    let all: Vec<&Source> = std::iter::once(keep).chain(others).collect();
    for field in MERGE_FIELDS.iter().copied().chain(["creators"]) {
        let values: Vec<Json> = all.iter().map(|s| value_of(s, field)).collect();
        let edited: Vec<bool> = all.iter().map(|s| edited_set(s).iter().any(|f| f == field)).collect();
        let value = match chosen.get(field) {
            Some(value) => value.clone(),
            None => values[default_choice(&values, &edited)].clone(),
        };
        if value != values[0] {
            patch.insert(field.to_string(), value);
        }
    }
    // Files: the kept source takes another's file when it has none; two different files cannot merge.
    let hashes: BTreeSet<&str> = all.iter().filter_map(|s| s.file_hash()).collect();
    if hashes.len() > 1 {
        return Err("These sources have different files. Key keeps one file per source: link them as versions instead.".into());
    }
    if keep.file_path().is_none() {
        if let Some(with_file) = others.iter().find(|s| s.file_path().is_some()) {
            for field in ["filePath", "fileHash", "mime", "fileSize", "pageCount"] {
                if let Some(value) = with_file.fields.get(field) {
                    patch.insert(field.into(), value.clone());
                }
            }
            if matches!(keep.kind.as_str(), "reference" | "web") {
                patch.insert("kind".into(), json!(with_file.kind));
            }
        }
    }
    let mut tags = keep.tags.clone();
    let mut properties = keep.properties.clone();
    let mut edited = edited_set(keep);
    for other in others {
        tags.extend(other.tags.iter().cloned());
        for (key, value) in &other.properties {
            properties.entry(key.clone()).or_insert_with(|| value.clone());
        }
        for field in edited_set(other) {
            if !edited.contains(&field) {
                edited.push(field);
            }
        }
    }
    patch.insert("tags".into(), json!(normalize_tags(&tags)));
    patch.insert("replaceProperties".into(), Json::Object(properties));
    if others.iter().any(|o| o.starred) {
        patch.insert("starred".into(), json!(true));
    }
    let now = now_ms();
    patch_source_row(db, &keep.id, &patch, now)?;
    sync_graph(db, &keep.id, Some(&patch))?;
    db.execute("UPDATE sources SET edited_fields = ?2 WHERE id = ?1", params![keep.id, serde_json::to_string(&edited).map_err(e)?]).map_err(e)?;
    for other in others {
        db.execute("INSERT OR IGNORE INTO source_collections(source_id, collection_id) SELECT ?1, collection_id FROM source_collections WHERE source_id = ?2", params![keep.id, other.id])
            .map_err(e)?;
        for (table, column) in [("notes", "source_id"), ("annotations", "source_id"), ("linked_files", "source_id"), ("links", "from_id"), ("links", "to_id")] {
            recorder.move_rows(db, table, column, &other.id, &keep.id)?;
        }
        // Its decisions about other sources become the kept one's; the pair itself goes.
        let pairs: Vec<(String, String, String)> = {
            let mut statement = db.prepare("SELECT a, b, kind FROM source_pairs WHERE a = ?1 OR b = ?1").map_err(e)?;
            let rows = statement.query_map([&other.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(e)?;
            rows.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        for (a, b, kind) in pairs {
            recorder.pair(db, &a, &b, &kind, false)?;
            let partner = if a == other.id { b } else { a };
            if partner != keep.id && !others.iter().any(|o| o.id == partner) {
                recorder.pair(db, &keep.id, &partner, &kind, true)?;
            }
        }
        db.execute("UPDATE sources SET trashed_at = ?2, merged_into = ?3, updated_at = ?2 WHERE id = ?1", params![other.id, now, keep.id]).map_err(e)?;
        refresh_fts(db, &other.id)?;
    }
    refresh_fts(db, &keep.id)
}

fn source_in(db: &Connection, id: &str) -> Result<Source> {
    let merged: Option<String> = db.query_row("SELECT merged_into FROM sources WHERE id = ?", [id], |r| r.get(0)).optional().map_err(e)?.flatten();
    if merged.is_some() {
        return Err("A source was merged already; look again".into());
    }
    db.query_row(&format!("{} WHERE s.id = ?", crate::select_sources()), [id], crate::read_source).optional().map_err(e)?.ok_or_else(|| "Source not found".into())
}

impl Store {
    /// The library index, brought up to date: sources changed since it was built (the
    /// `source_key_changes` log) are re-read, the rest stays; rebuilt only when much changed.
    fn index(&self) -> Result<std::sync::Arc<Index>> {
        let db = self.read()?;
        let (first, last): (i64, i64) = db.query_row("SELECT coalesce(min(seq), 0), coalesce(max(seq), 0) FROM source_key_changes", [], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
        let mut cache = self.duplicates.lock().map_err(|_| "Duplicate index lock poisoned")?;
        if let Some((seq, index)) = cache.as_mut() {
            if *seq == last {
                return Ok(index.clone());
            }
            // Still in the log, and not so much that a rebuild is cheaper.
            if *seq < last && (*seq >= first - 1 || first == 0) && last - *seq <= 2_000 {
                let mut statement = db.prepare_cached("SELECT DISTINCT source_id FROM source_key_changes WHERE seq > ?").map_err(e)?;
                let changed: Vec<String> = statement.query_map([*seq], |r| r.get(0)).map_err(e)?.collect::<std::result::Result<_, _>>().map_err(e)?;
                let next = std::sync::Arc::make_mut(index);
                for id in changed {
                    match library_work(&db, &id)? {
                        Some(p) => next.push(id, p),
                        None => next.remove(&id),
                    }
                }
                if next.dead.len() <= next.works.len() / 4 {
                    *seq = last;
                    return Ok(index.clone());
                }
            }
        }
        let index = std::sync::Arc::new(Index::build(library_works(&db)?));
        *cache = Some((last, index.clone()));
        Ok(index)
    }

    #[cfg(test)]
    pub(crate) fn duplicate_index(&self) -> Result<std::sync::Arc<Index>> {
        self.index()
    }

    /// Library sources that are the same as each of these works (for importers, the "in
    /// library" badges and sync). Results are in input order, best first. Candidates come
    /// from the indexed `source_match_keys`, so this never reads the whole library.
    pub fn find_duplicates_for(&self, works: &[Work]) -> Result<Vec<Vec<DuplicateMatch>>> {
        let db = self.read()?;
        let mut prepared: HashMap<String, Option<Prepared>> = HashMap::new();
        let mut out = Vec::with_capacity(works.len());
        for work in works {
            let p = prepare(work);
            let mut found = Vec::new();
            for id in candidates_in(&db, &p)? {
                if work.id.as_deref() == Some(id.as_str()) {
                    continue;
                }
                if !prepared.contains_key(&id) {
                    prepared.insert(id.clone(), library_work(&db, &id)?);
                }
                if let Some(v) = prepared[&id].as_ref().and_then(|other| compare_prepared(&p, other)) {
                    found.push(DuplicateMatch { source_id: id, kind: v.kind, score: v.score, reason: v.reason });
                }
            }
            found.sort_by(|a, b| a.kind.cmp(&b.kind).then(b.score.total_cmp(&a.score)));
            out.push(found);
        }
        Ok(out)
    }

    /// The library's duplicate groups (and preprint/published pairs not linked yet), the
    /// surest first.
    pub fn duplicate_groups(&self, with_sources: bool) -> Result<DuplicateReport> {
        let index = self.index()?;
        let decided = decided_pairs(&*self.read()?)?;
        let n = index.works.len();
        let (mut any, mut exact) = (Find::new(n), Find::new(n));
        let mut best: HashMap<usize, (f64, String)> = HashMap::new();
        let mut versions: Vec<(usize, usize, Verdict)> = Vec::new();
        for i in (0..n).filter(|i| index.live(*i)) {
            for j in index.candidates(&index.works[i].1) {
                if j <= i {
                    continue;
                }
                let Some(verdict) = compare_prepared(&index.works[i].1, &index.works[j].1) else { continue };
                let (a, b) = pair_key(&index.works[i].0, &index.works[j].0);
                if decided.contains(&(a.clone(), b.clone(), "distinct".into())) {
                    continue;
                }
                match verdict.kind {
                    MatchKind::Version => {
                        if !decided.contains(&(a, b, "version".into())) {
                            versions.push((i, j, verdict));
                        }
                    }
                    kind => {
                        any.join(i, j);
                        if kind == MatchKind::Exact {
                            exact.join(i, j);
                        }
                        for k in [i, j] {
                            let entry = best.entry(k).or_insert((0.0, String::new()));
                            if verdict.score > entry.0 {
                                *entry = (verdict.score, verdict.reason.clone());
                            }
                        }
                    }
                }
            }
        }
        let mut members: HashMap<usize, Vec<usize>> = HashMap::new();
        for i in best.keys().copied() {
            let root = any.root(i);
            members.entry(root).or_default().push(i);
        }
        let mut groups: Vec<(MatchKind, f64, String, Vec<usize>)> = Vec::new();
        for (_, mut list) in members {
            list.sort();
            let all_exact = list.iter().map(|i| exact.root(*i)).collect::<HashSet<_>>().len() == 1;
            let score = list.iter().filter_map(|i| best.get(i)).map(|(s, _)| *s).fold(0.0, f64::max);
            let reason = list.iter().filter_map(|i| best.get(i)).max_by(|a, b| a.0.total_cmp(&b.0)).map(|(_, r)| r.clone()).unwrap_or_default();
            groups.push((if all_exact { MatchKind::Exact } else { MatchKind::Likely }, if all_exact { 1.0 } else { score }, reason, list));
        }
        for (i, j, verdict) in versions {
            groups.push((MatchKind::Version, verdict.score, verdict.reason, vec![i, j]));
        }
        groups.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.total_cmp(&a.1)).then(a.3.cmp(&b.3)));
        let count = groups.iter().filter(|g| g.0 != MatchKind::Version).count();
        let exact_groups = groups.iter().filter(|g| g.0 == MatchKind::Exact).count();
        let exact_removable = groups.iter().filter(|g| g.0 == MatchKind::Exact).map(|g| g.3.len() - 1).sum();
        let mut out = Vec::new();
        for (kind, score, reason, list) in groups.into_iter().take(1000) {
            let mut ids: Vec<String> = list.iter().map(|i| index.works[*i].0.clone()).collect();
            ids.sort();
            let sources = if with_sources { ids.iter().filter_map(|id| self.source(id).ok().flatten()).collect() } else { Vec::new() };
            out.push(DuplicateGroup { id: ids.join("+"), kind, score, reason, ids, sources });
        }
        Ok(DuplicateReport { groups: out, count, exact_groups, exact_removable })
    }

    /// The side-by-side comparison for merging these sources, the one to keep first.
    pub fn merge_preview(&self, ids: &[String], keep: Option<&str>) -> Result<MergePreview> {
        let mut sources: Vec<Source> = ids.iter().filter_map(|id| self.source(id).ok().flatten()).collect();
        if sources.len() < 2 {
            return Err("Choose at least two sources to merge".into());
        }
        match keep {
            Some(keep) => sources.sort_by_key(|s| s.id != keep),
            None => sources.sort_by_key(|s| -completeness(s)),
        }
        let mut fields = Vec::new();
        for field in MERGE_FIELDS.iter().copied().chain(["creators"]) {
            let values: Vec<Json> = sources.iter().map(|s| value_of(s, field)).collect();
            let distinct: Vec<&Json> = values.iter().filter(|v| !v.is_null()).collect::<Vec<_>>();
            if distinct.is_empty() || (distinct.iter().all(|v| *v == distinct[0]) && !values.iter().any(Json::is_null)) {
                continue;
            }
            let edited: Vec<bool> = sources.iter().map(|s| edited_set(s).iter().any(|f| f == field)).collect();
            let choice = default_choice(&values, &edited);
            fields.push(MergeField { field: field.into(), label: journal::field_label(field), values, choice, edited });
        }
        let mut tags: Vec<String> = Vec::new();
        let mut collections: Vec<String> = Vec::new();
        for s in &sources {
            tags.extend(s.tags.iter().cloned());
            for c in &s.collections {
                if !collections.contains(c) {
                    collections.push(c.clone());
                }
            }
        }
        let files = sources.iter().filter_map(|s| s.file_hash()).collect::<BTreeSet<_>>().len();
        Ok(MergePreview {
            tags: normalize_tags(&tags),
            collections,
            notes: sources.iter().map(|s| s.note_count).sum(),
            annotations: sources.iter().map(|s| s.annotation_count).sum(),
            files,
            blocked: (files > 1).then(|| "These sources have different files. Key keeps one file per source, so link them as versions instead.".to_string()),
            sources,
            fields,
        })
    }

    /// Merges `others` into `keep` (journaled; undo brings them back).
    pub fn merge_sources(&self, request: &MergeRequest) -> Result<Operation> {
        let others: Vec<String> = request.others.iter().filter(|o| **o != request.keep).cloned().collect();
        if others.is_empty() {
            return Err("Nothing to merge".into());
        }
        let ids: Vec<String> = std::iter::once(request.keep.clone()).chain(others.iter().cloned()).collect();
        let label = format!("Merge {} sources", ids.len());
        let (affected, entry) = self.journaled("merge", &label, &ids, |db, recorder| {
            let keep = source_in(db, &request.keep)?;
            let others: Vec<Source> = others.iter().map(|id| source_in(db, id)).collect::<Result<_>>()?;
            merge_into(db, recorder, &keep, &others, &request.fields)?;
            Ok(others.len())
        })?;
        Ok(Operation { affected, entry })
    }

    /// Merges every group joined by an identifier or identical file, each into its most
    /// complete source, as one operation.
    pub fn merge_exact_duplicates(&self) -> Result<Operation> {
        let report = self.duplicate_groups(true)?;
        let groups: Vec<Vec<Source>> = report
            .groups
            .into_iter()
            .filter(|g| g.kind == MatchKind::Exact)
            .map(|g| {
                let mut sources = g.sources;
                sources.sort_by_key(|s| -completeness(s));
                sources
            })
            .filter(|s| s.len() > 1 && s.iter().filter_map(|x| x.file_hash()).collect::<BTreeSet<_>>().len() <= 1)
            .collect();
        let ids: Vec<String> = groups.iter().flatten().map(|s| s.id.clone()).collect();
        let removed: usize = groups.iter().map(|g| g.len() - 1).sum();
        let label = format!("Merge {removed} exact duplicates");
        let (affected, entry) = self.journaled("merge", &label, &ids, |db, recorder| {
            for group in &groups {
                let keep = source_in(db, &group[0].id)?;
                let others: Vec<Source> = group[1..].iter().map(|s| source_in(db, &s.id)).collect::<Result<_>>()?;
                merge_into(db, recorder, &keep, &others, &Map::new())?;
            }
            Ok(removed)
        })?;
        Ok(Operation { affected, entry })
    }

    /// "Not duplicates": these sources are not suggested as duplicates of each other again.
    pub fn mark_distinct(&self, ids: &[String]) -> Result<Operation> {
        self.decide_pairs(ids, "distinct", true, "Mark as not duplicates")
    }

    /// Links a preprint and its published version (or any two versions of one work).
    pub fn link_versions(&self, ids: &[String], linked: bool) -> Result<Operation> {
        self.decide_pairs(ids, "version", linked, if linked { "Link as versions" } else { "Unlink versions" })
    }

    fn decide_pairs(&self, ids: &[String], kind: &str, added: bool, label: &str) -> Result<Operation> {
        let (affected, entry) = self.journaled("pairs", label, &[], |db, recorder| {
            let mut changed = 0;
            for (i, a) in ids.iter().enumerate() {
                for b in &ids[i + 1..] {
                    changed += usize::from(recorder.pair(db, a, b, kind, added)?);
                }
            }
            Ok(changed)
        })?;
        Ok(Operation { affected, entry })
    }

    /// Other versions linked to a source.
    pub fn versions_of(&self, id: &str) -> Result<Vec<String>> {
        let db = self.read()?;
        let mut statement = db.prepare("SELECT CASE WHEN a = ?1 THEN b ELSE a END FROM source_pairs WHERE kind = 'version' AND (a = ?1 OR b = ?1)").map_err(e)?;
        let rows = statement.query_map([id], |r| r.get(0)).map_err(e)?;
        rows.collect::<std::result::Result<_, _>>().map_err(e)
    }
}

/// The library index, with the last change (`source_key_changes.seq`) it has applied.
pub(crate) type Cache = Option<(i64, std::sync::Arc<Index>)>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SourceInput;

    fn work(value: Json) -> Work {
        serde_json::from_value(value).unwrap()
    }

    fn kind(a: Json, b: Json) -> Option<MatchKind> {
        compare(&work(a), &work(b)).map(|v| v.kind)
    }

    #[test]
    fn normalises_identifiers() {
        assert_eq!(normalize_isbns("0-262-03384-4"), vec!["9780262033848"]);
        assert_eq!(normalize_isbns("978-0-262-03384-8; 0262033844"), vec!["9780262033848"]);
        assert_eq!(normalize_pmid("PMID: 0012345"), Some("12345".into()));
        assert_eq!(normalize_pmcid("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123456/"), Some("PMC123456".into()));
        assert_eq!(normalize_arxiv("arXiv:2101.00001v3"), Some("2101.00001".into()));
        assert_eq!(normalize_arxiv("https://arxiv.org/abs/hep-th/9901001v1"), Some("hep-th/9901001".into()));
        assert_eq!(normalize_arxiv("10.48550/arXiv.1706.03762"), Some("1706.03762".into()));
        assert!(is_preprint_doi("10.1101/2020.03.22.20040501"));
        assert!(!is_preprint_doi("10.1101/gr.123456.111"));
    }

    #[test]
    fn exact_identifiers_win_and_different_dois_are_different_works() {
        assert_eq!(kind(json!({"doi": "https://doi.org/10.1000/ABC", "title": "X"}), json!({"doi": "doi:10.1000/abc", "title": "Something else"})), Some(MatchKind::Exact));
        assert_eq!(kind(json!({"pmid": "123", "title": "A"}), json!({"pmid": "PMID 123"})), Some(MatchKind::Exact));
        assert_eq!(kind(json!({"fileHash": "h1"}), json!({"fileHash": "h1"})), Some(MatchKind::Exact));
        // A paper and its erratum share the title but not the DOI.
        let title = "Effects of a school-based intervention on adolescent sleep: a randomized trial";
        assert_eq!(kind(json!({"doi": "10.1/a", "title": title, "year": 2020}), json!({"doi": "10.1/b", "title": title, "year": 2020})), None);
    }

    #[test]
    fn titles_match_through_case_diacritics_punctuation_and_subtitles() {
        let a = json!({"title": "Économie du bien-être: une introduction", "year": 2019, "firstAuthor": "Müller"});
        assert_eq!(kind(a.clone(), json!({"title": "economie du bien etre", "year": 2019, "creators": [{"family": "Muller", "role": "author"}]})), Some(MatchKind::Likely));
        assert_eq!(kind(a.clone(), json!({"title": "ECONOMIE DU BIEN-ÊTRE: UNE INTRODUCTION.", "year": 2020, "firstAuthor": "Müller"})), Some(MatchKind::Likely));
        // Two years apart: another work (a later edition, a follow-up).
        assert_eq!(kind(a.clone(), json!({"title": "Économie du bien-être: une introduction", "year": 2021, "firstAuthor": "Müller"})), None);
        // Another first author.
        assert_eq!(kind(a, json!({"title": "Économie du bien-être: une introduction", "year": 2019, "firstAuthor": "Dupont"})), None);
    }

    #[test]
    fn tricky_pairs_stay_apart() {
        // Translated titles are different records (only an identifier joins them).
        assert_eq!(kind(json!({"title": "Deep learning in clinical medicine", "year": 2018, "firstAuthor": "Weber"}), json!({"title": "Tiefes Lernen in der klinischen Medizin", "year": 2018, "firstAuthor": "Weber"})), None);
        // A book and its chapter share a title and the ISBN.
        let book = json!({"title": "Handbook of development economics", "itemType": "book", "isbn": "9780444531001", "year": 2010, "firstAuthor": "Rodrik"});
        let chapter = json!({"title": "Handbook of development economics", "itemType": "bookSection", "isbn": "9780444531001", "year": 2010, "firstAuthor": "Rodrik"});
        assert_eq!(kind(book.clone(), chapter), None);
        // Two chapters of one book share the ISBN but are different works.
        let c1 = json!({"title": "Trade and growth", "itemType": "bookSection", "isbn": "9780444531001", "year": 2010, "firstAuthor": "Rodrik"});
        let c2 = json!({"title": "Institutions and growth", "itemType": "bookSection", "isbn": "9780444531001", "year": 2010, "firstAuthor": "Rodrik"});
        assert_eq!(kind(c1, c2), None);
        // Editions differ.
        assert_eq!(kind(json!({"title": "Econometric analysis", "edition": "7", "year": 2011, "firstAuthor": "Greene"}), json!({"title": "Econometric analysis", "edition": "8", "year": 2012, "firstAuthor": "Greene"})), None);
        // Same title, same year, nothing else: short generic titles are not enough.
        assert_eq!(kind(json!({"title": "Introduction", "year": 2010}), json!({"title": "Introduction", "year": 2010})), None);
        // Same book, same ISBN.
        assert_eq!(kind(book, json!({"title": "Handbook of Development Economics, Vol. 5", "itemType": "book", "isbn": "0-444-53100-3"})), Some(MatchKind::Exact));
    }

    #[test]
    fn preprint_and_published_version_are_versions() {
        let title = "Attention is all you need";
        let preprint = json!({"title": title, "year": 2017, "arxivId": "1706.03762v5", "firstAuthor": "Vaswani"});
        let published = json!({"title": "Attention Is All You Need", "year": 2017, "doi": "10.5555/3295222.3295349", "containerTitle": "NeurIPS", "firstAuthor": "Vaswani"});
        assert_eq!(kind(preprint.clone(), published.clone()), Some(MatchKind::Version));
        let bio = json!({"title": "A long title about cell signalling in yeast colonies", "doi": "10.1101/2020.01.01.111111", "year": 2020, "firstAuthor": "Li"});
        let journal = json!({"title": "A long title about cell signalling in yeast colonies", "doi": "10.1038/s41586-021-00001-1", "year": 2022, "firstAuthor": "Li"});
        assert_eq!(kind(bio, journal), Some(MatchKind::Version));
        // The same arXiv record twice is a duplicate.
        assert_eq!(kind(preprint.clone(), json!({"arxivId": "arXiv:1706.03762", "title": "x"})), Some(MatchKind::Exact));
    }

    fn add(store: &Store, fields: Json) -> String {
        let mut input: SourceInput = serde_json::from_value(json!({"kind": "reference"})).unwrap();
        input.fields = fields.as_object().unwrap().clone();
        if let Some(creators) = input.fields.remove("creators") {
            input.creators = serde_json::from_value(creators).unwrap();
        }
        if let Some(tags) = input.fields.remove("tags") {
            input.tags = serde_json::from_value(tags).unwrap();
        }
        store.insert_source(input).unwrap().id
    }

    #[test]
    fn groups_decisions_and_matching_new_works() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = add(&store, json!({"title": "Nudge theory in public health practice", "year": 2015, "doi": "10.1/nudge", "creators": [{"family": "Thaler", "role": "author"}]}));
        let b = add(&store, json!({"title": "Nudge Theory in Public Health Practice", "year": 2015, "creators": [{"family": "Thaler", "role": "author"}]}));
        let c = add(&store, json!({"title": "Something unrelated entirely here", "year": 2015, "doi": "10.1/nudge"}));
        let d = add(&store, json!({"title": "Yet another paper on poverty measurement", "year": 2001}));
        let report = store.duplicate_groups(false).unwrap();
        assert_eq!(report.count, 1);
        let group = &report.groups[0];
        assert_eq!(group.kind, MatchKind::Likely);
        let mut expected = vec![a.clone(), b.clone(), c.clone()];
        expected.sort();
        assert_eq!(group.ids, expected);
        assert!(!group.ids.contains(&d));
        let found = store.find_duplicates_for(&[work(json!({"title": "NUDGE THEORY IN PUBLIC HEALTH PRACTICE.", "year": 2016, "firstAuthor": "Thaler"})), work(json!({"doi": "10.1/NUDGE"}))]).unwrap();
        assert!(found[0].iter().any(|m| m.source_id == a && m.kind == MatchKind::Likely));
        assert_eq!(found[1].iter().filter(|m| m.kind == MatchKind::Exact).count(), 2);
        // Not duplicates: c is apart from a; b and a remain.
        store.mark_distinct(&[a.clone(), c.clone()]).unwrap();
        store.mark_distinct(&[b.clone(), c.clone()]).unwrap();
        let report = store.duplicate_groups(false).unwrap();
        assert_eq!(report.groups[0].ids.len(), 2);
        assert!(!report.groups[0].ids.contains(&c));
        // The decisions are undoable.
        store.undo().unwrap();
        store.undo().unwrap();
        assert_eq!(store.duplicate_groups(false).unwrap().groups[0].ids.len(), 3);
    }

    #[test]
    fn merge_keeps_everything_and_undo_restores_both() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let keep = add(&store, json!({"title": "Poverty traps", "year": 2006, "doi": "10.1/pt", "tags": ["growth"], "creators": [{"family": "Azariadis", "role": "author"}]}));
        let other = add(&store, json!({"title": "Poverty traps", "year": 2006, "doi": "10.1/PT", "volume": "12", "pages": "1–20", "citationKey": "azariadis2006", "tags": ["traps", "Growth"], "filePath": "/tmp/pt.pdf", "fileHash": "abc", "mime": "application/pdf"}));
        let collection = store.create_collection("Theory", None, None).unwrap().id;
        store.set_membership(&collection, std::slice::from_ref(&other), true).unwrap();
        let note = store.save_note(None, Some(&other), "Thoughts", "On traps", None).unwrap();
        store.apply_annotations(&other, &[json!({"id": "h1", "type": "highlight", "page": 1, "text": "traps"})], &[]).unwrap();
        let third = add(&store, json!({"title": "Some later version", "year": 2010}));
        store.link_versions(&[other.clone(), third.clone()], true).unwrap();
        let preview = store.merge_preview(&[keep.clone(), other.clone()], Some(&keep)).unwrap();
        assert_eq!(preview.sources[0].id, keep);
        assert!(preview.fields.iter().any(|f| f.field == "volume" && f.choice == 1));
        assert!(preview.blocked.is_none());

        let op = store.merge_sources(&MergeRequest { keep: keep.clone(), others: vec![other.clone()], fields: Map::new() }).unwrap();
        assert_eq!(op.affected, 1);
        let merged = store.source(&keep).unwrap().unwrap();
        assert_eq!(merged.field("volume"), Some("12"));
        assert_eq!(merged.field("citationKey"), Some("azariadis2006"));
        assert_eq!(merged.field("fileHash"), Some("abc"));
        assert_eq!(merged.tags, vec!["growth", "traps"]);
        assert_eq!(merged.collections, vec![collection.clone()]);
        assert_eq!(merged.note_count, 1);
        assert_eq!(merged.annotation_count, 1);
        assert_eq!(store.note(&note.id).unwrap().unwrap().source_id.as_deref(), Some(keep.as_str()));
        assert_eq!(store.versions_of(&keep).unwrap(), vec![third.clone()]);
        assert_eq!(store.resolve_source_id(&other).unwrap(), keep);
        // The merged-away source is not listed anywhere, not even in the Trash.
        let trash = store.list_sources(&crate::ListQuery { scope: Some("trashed".into()), ..Default::default() }).unwrap();
        assert_eq!(trash.total, 0);
        assert_eq!(store.list_sources(&crate::ListQuery::default()).unwrap().total, 2);
        assert!(store.duplicate_groups(false).unwrap().groups.iter().all(|g| !g.ids.contains(&other)));

        store.undo().unwrap().unwrap();
        let back = store.source(&other).unwrap().unwrap();
        assert!(back.trashed_at.is_none());
        assert_eq!(back.note_count, 1);
        assert_eq!(back.annotation_count, 1);
        assert_eq!(back.collections, vec![collection.clone()]);
        let kept = store.source(&keep).unwrap().unwrap();
        assert_eq!(kept.field("volume"), None);
        assert_eq!(kept.field("fileHash"), None);
        assert_eq!(kept.tags, vec!["growth"]);
        assert!(kept.collections.is_empty());
        assert_eq!(store.versions_of(&other).unwrap(), vec![third.clone()]);
        assert_eq!(store.resolve_source_id(&other).unwrap(), other);
        store.redo().unwrap().unwrap();
        assert_eq!(store.resolve_source_id(&other).unwrap(), keep);
        assert_eq!(store.source(&keep).unwrap().unwrap().note_count, 1);
    }

    #[test]
    fn different_files_block_a_merge_and_exact_merge_all_skips_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = add(&store, json!({"title": "A", "doi": "10.1/x", "fileHash": "h1", "filePath": "/a.pdf"}));
        let b = add(&store, json!({"title": "A", "doi": "10.1/x", "fileHash": "h2", "filePath": "/b.pdf"}));
        assert!(store.merge_sources(&MergeRequest { keep: a.clone(), others: vec![b.clone()], fields: Map::new() }).is_err());
        let c = add(&store, json!({"title": "C paper", "pmid": "77"}));
        let d = add(&store, json!({"title": "C paper", "pmid": "77", "fileHash": "h3", "filePath": "/c.pdf"}));
        let report = store.duplicate_groups(false).unwrap();
        assert_eq!(report.exact_groups, 2);
        let op = store.merge_exact_duplicates().unwrap();
        assert_eq!(op.affected, 1);
        // The one with the file is the more complete and is kept.
        assert_eq!(store.resolve_source_id(&c).unwrap(), d);
        assert_eq!(store.list_sources(&crate::ListQuery::default()).unwrap().total, 3);
        let _ = (a, b);
    }
}
