// "Already in library": which library source a work seen elsewhere (a web search hit, a
// reader's cited work, a browser page, a related work) is. Identifiers match exactly once
// normalised (DOI, arXiv, PMID, PMCID, ISBN, OpenAlex); a link matches its normalised
// address (no tracking parameters, no `www.`, a library proxy's rewriting undone); a title
// matches only as "possibly" (same normalised title, years within one, first authors that
// agree), and never when both sides name different DOIs.
use crate::{Result, Store, e};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// A work to look for. Every field is optional; `key` comes back with its match.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchQuery {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub pmid: Option<String>,
    #[serde(default)]
    pub pmcid: Option<String>,
    #[serde(default, alias = "arxivId")]
    pub arxiv: Option<String>,
    #[serde(default)]
    pub isbn: Option<String>,
    #[serde(default, alias = "openalexId")]
    pub openalex: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "loose_year")]
    pub year: Option<i64>,
    #[serde(default)]
    pub first_author: Option<String>,
}

fn loose_year<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<i64>, D::Error> {
    Ok(match Option::<Json>::deserialize(d)? {
        Some(Json::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Some(Json::String(s)) => s.trim().get(..4).and_then(|y| y.parse().ok()),
        _ => None,
    })
}

/// The source a work is, and how it was recognised.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchHit {
    pub key: String,
    pub source_id: String,
    pub title: String,
    /// doi | arxiv | pmid | pmcid | isbn | openalex | url | title
    pub kind: &'static str,
    /// False for a title match: shown as "Possibly in library", never blocks adding.
    pub certain: bool,
    /// Whether the source has a file (a PDF or saved page) already.
    pub has_file: bool,
}

// ── Normalisers (normalize.rs; the names here stay for callers) ─────────────────

pub use crate::normalize::{LinkKey, link_key, title_key};

pub fn bare_doi(text: &str) -> Option<String> {
    crate::normalize::doi(text)
}
pub fn bare_arxiv(text: &str) -> Option<String> {
    crate::normalize::arxiv(text)
}
pub fn bare_pmid(text: &str) -> Option<String> {
    crate::normalize::pmid(text)
}
pub fn bare_pmcid(text: &str) -> Option<String> {
    crate::normalize::pmcid(text)
}
pub fn bare_openalex(text: &str) -> Option<String> {
    crate::normalize::openalex(text)
}
pub fn bare_isbn(text: &str) -> Option<String> {
    crate::normalize::isbn(text)
}

// ── Lookups ──────────────────────────────────────────────────────────────────

struct Row {
    id: String,
    title: String,
    has_file: bool,
}

fn hit(query: &MatchQuery, row: &Row, kind: &'static str) -> MatchHit {
    MatchHit { key: query.key.clone(), source_id: row.id.clone(), title: row.title.clone(), kind, certain: kind != "title", has_file: row.has_file }
}

/// The query's DOI (its own, or the one its link is).
fn query_doi(q: &MatchQuery) -> Option<String> {
    q.doi.as_deref().and_then(bare_doi).or_else(|| match q.url.as_deref().and_then(link_key) {
        Some(LinkKey::Doi(d)) => Some(d),
        _ => None,
    })
}

/// What a query is looked up by, surest first (the same keys `duplicates::row_keys` stores
/// for each library source).
fn lookups(q: &MatchQuery) -> Vec<(&'static str, String)> {
    let link = q.url.as_deref().and_then(link_key);
    let doi = query_doi(q);
    let arxiv = q.arxiv.as_deref().and_then(bare_arxiv).or(match &link {
        Some(LinkKey::Arxiv(a)) => Some(a.clone()),
        _ => None,
    }).or_else(|| doi.as_deref().and_then(|d| d.strip_prefix("10.48550/arxiv.")).map(String::from));
    let pmid = q.pmid.as_deref().and_then(bare_pmid).or(match &link {
        Some(LinkKey::Pmid(p)) => Some(p.clone()),
        _ => None,
    });
    let url = match link {
        Some(LinkKey::Url(u)) => Some(u),
        _ => None,
    };
    let checks: [(&'static str, Option<String>); 7] = [
        ("doi", doi),
        ("arxiv", arxiv),
        ("pmid", pmid),
        ("pmcid", q.pmcid.as_deref().and_then(bare_pmcid)),
        ("isbn", q.isbn.as_deref().and_then(bare_isbn)),
        ("openalex", q.openalex.as_deref().and_then(bare_openalex)),
        ("url", url),
    ];
    checks.into_iter().filter_map(|(kind, value)| Some((kind, value.filter(|v| !v.is_empty())?))).collect()
}

/// The identifier match for one query: an index probe per identifier it has.
fn find(db: &rusqlite::Connection, q: &MatchQuery) -> Result<Option<MatchHit>> {
    use rusqlite::OptionalExtension;
    let mut statement = db
        .prepare_cached(
            "SELECT s.id, s.title, s.file_path FROM source_match_keys k JOIN sources s ON s.id = k.source_id
             WHERE k.kind = ?1 AND k.value = ?2 AND s.trashed_at IS NULL ORDER BY s.rowid LIMIT 1",
        )
        .map_err(e)?;
    for (kind, value) in lookups(q) {
        let row = statement
            .query_row(rusqlite::params![kind, value], |r| {
                let text = |i: usize| r.get::<_, Option<String>>(i).map(|v| v.filter(|v| !v.trim().is_empty()));
                Ok(Row { id: r.get(0)?, title: text(1)?.unwrap_or_default(), has_file: text(2)?.is_some() })
            })
            .optional()
            .map_err(e)?;
        if let Some(row) = row {
            return Ok(Some(hit(q, &row, kind)));
        }
    }
    Ok(None)
}

/// The query as the duplicate engine compares works, when its title says enough.
fn title_work(q: &MatchQuery) -> Option<crate::duplicates::Work> {
    let title = title_key(q.title.as_deref().unwrap_or(""));
    if title.split_whitespace().count() < 2 && title.len() < 12 {
        return None;
    }
    Some(crate::duplicates::Work {
        title: q.title.clone(),
        year: q.year,
        doi: query_doi(q),
        arxiv_id: q.arxiv.clone(),
        pmid: q.pmid.clone(),
        pmcid: q.pmcid.clone(),
        isbn: q.isbn.clone(),
        first_author: q.first_author.as_deref().map(crate::normalize::family_key).filter(|f| !f.is_empty()),
        ..Default::default()
    })
}

impl Store {
    /// Which of these works the library has (at most 500 asked at once); unmatched ones are
    /// left out. Identifiers and links match exactly; otherwise the duplicate engine
    /// (duplicates.rs) decides whether a library source is the same work by its title,
    /// year and first author, and that match is only "possible".
    pub fn match_identifiers(&self, queries: &[MatchQuery]) -> Result<Vec<MatchHit>> {
        if queries.is_empty() {
            return Ok(Vec::new());
        }
        let queries: Vec<&MatchQuery> = queries.iter().take(500).collect();
        let mut hits: Vec<Option<MatchHit>> = {
            let db = self.read()?;
            queries.iter().map(|q| find(&db, q)).collect::<Result<_>>()?
        };
        let open: Vec<(usize, crate::duplicates::Work)> = hits.iter().enumerate().filter(|(_, h)| h.is_none()).filter_map(|(i, _)| title_work(queries[i]).map(|w| (i, w))).collect();
        if !open.is_empty() {
            let works: Vec<crate::duplicates::Work> = open.iter().map(|(_, w)| w.clone()).collect();
            for ((i, _), found) in open.iter().zip(self.find_duplicates_for(&works)?) {
                if let Some(source) = found.first().and_then(|m| self.source(&m.source_id).ok().flatten()) {
                    let row = Row { id: source.id.clone(), title: source.field("title").unwrap_or_default().to_string(), has_file: source.file_path().is_some() };
                    hits[*i] = Some(hit(queries[*i], &row, "title"));
                }
            }
        }
        Ok(hits.into_iter().flatten().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SourceInput;
    use serde_json::json;

    fn add(store: &Store, value: Json) -> String {
        store.insert_source(serde_json::from_value::<SourceInput>(value).unwrap()).unwrap().id
    }
    fn query(value: Json) -> MatchQuery {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn normalises_identifiers_and_links() {
        assert_eq!(bare_doi("https://doi.org/10.1038/S41591-021-01384-9.").as_deref(), Some("10.1038/s41591-021-01384-9"));
        assert_eq!(bare_doi("doi: 10.1000%2Fxyz").as_deref(), Some("10.1000/xyz"));
        assert_eq!(bare_doi("see 10.1/x"), None);
        assert_eq!(bare_arxiv("arXiv:1706.03762v7").as_deref(), Some("1706.03762"));
        assert_eq!(bare_arxiv("https://arxiv.org/pdf/hep-th/9901001v2.pdf").as_deref(), Some("hep-th/9901001"));
        assert_eq!(bare_isbn("0-262-03384-4").as_deref(), Some("9780262033848"));
        assert_eq!(bare_isbn("978-0-262-03384-8").as_deref(), Some("9780262033848"));
        assert_eq!(bare_isbn("9780262033849"), None);
        assert_eq!(bare_pmcid("pmc8190434").as_deref(), Some("PMC8190434"));
        assert_eq!(bare_openalex("https://openalex.org/W2963403868").as_deref(), Some("W2963403868"));
        let url = |t: &str| match link_key(t) {
            Some(LinkKey::Url(u)) => u,
            other => format!("{other:?}"),
        };
        assert_eq!(url("https://www.Nature.com/articles/s41586-021-03819-2/?utm_source=x&fbclid=y#sec1"), "nature.com/articles/s41586-021-03819-2");
        assert_eq!(url("https://www-nature-com.ezproxy.uni.example.edu/articles/s41586-021-03819-2"), "nature.com/articles/s41586-021-03819-2");
        assert_eq!(url("https://login.ezproxy.uni.example.edu/login?url=https://www.jstor.org/stable/123"), "jstor.org/stable/123");
        assert_eq!(url("https://example.org/a;jsessionid=abc?b=2&a=1"), "example.org/a?a=1&b=2");
        assert_eq!(link_key("https://doi.org/10.1/ABC"), Some(LinkKey::Doi("10.1/abc".into())));
        assert_eq!(link_key("https://arxiv.org/abs/2101.00001v3"), Some(LinkKey::Arxiv("2101.00001".into())));
        assert_eq!(link_key("https://pubmed.ncbi.nlm.nih.gov/33599681/"), Some(LinkKey::Pmid("33599681".into())));
        assert_eq!(link_key("not a link"), None);
    }

    #[test]
    fn matches_by_identifier_link_and_possibly_by_title() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let doi = add(&store, json!({"kind": "reference", "title": "Health versus income", "doi": "https://doi.org/10.1/ABC", "year": 2022}));
        let arxiv = add(&store, json!({"kind": "reference", "title": "Attention is all you need", "arxivId": "1706.03762", "year": 2017, "creators": [{"family": "Vaswani", "given": "Ashish"}]}));
        let book = add(&store, json!({"kind": "reference", "title": "Introduction to algorithms", "isbn": "0-262-03384-4"}));
        let page = add(&store, json!({"kind": "web", "title": "A blog post", "url": "https://www.example.org/post/?utm_campaign=z"}));
        let pubmed = add(&store, json!({"kind": "reference", "title": "Something medical", "pmid": "33599681", "pmcid": "PMC8190434"}));
        let trashed = add(&store, json!({"kind": "reference", "title": "Gone", "doi": "10.9/gone"}));
        store.trash(&[trashed], true).unwrap();
        let hits = store
            .match_identifiers(&[
                query(json!({"key": "a", "doi": "doi:10.1/abc"})),
                query(json!({"key": "b", "url": "https://arxiv.org/pdf/1706.03762v7"})),
                query(json!({"key": "c", "isbn": "9780262033848"})),
                query(json!({"key": "d", "url": "http://example.org/post#top"})),
                query(json!({"key": "e", "pmcid": "8190434"})),
                query(json!({"key": "f", "title": "Attention Is All You Need.", "year": "2018", "firstAuthor": "Ashish Vaswani"})),
                query(json!({"key": "g", "title": "Attention Is All You Need", "year": 2012})),
                query(json!({"key": "h", "title": "Attention Is All You Need", "firstAuthor": "Smith, J."})),
                query(json!({"key": "i", "doi": "10.9/gone"})),
                query(json!({"key": "j", "title": "Health versus income", "doi": "10.1/other"})),
                query(json!({"key": "k", "url": "https://doi.org/10.1/abc"})),
            ])
            .unwrap();
        let got: Vec<(&str, &str, &str, bool)> = hits.iter().map(|h| (h.key.as_str(), h.source_id.as_str(), h.kind, h.certain)).collect();
        assert_eq!(
            got,
            [
                ("a", doi.as_str(), "doi", true),
                ("b", arxiv.as_str(), "arxiv", true),
                ("c", book.as_str(), "isbn", true),
                ("d", page.as_str(), "url", true),
                ("e", pubmed.as_str(), "pmcid", true),
                ("f", arxiv.as_str(), "title", false),
                ("k", doi.as_str(), "doi", true),
            ]
        );
    }

    /// 20k sources: "Add to library"'s check and a duplicate lookup are index probes, and a
    /// change updates the duplicate index instead of rebuilding it.
    #[test]
    fn lookups_stay_fast_at_20k_sources() {
        use std::time::{Duration, Instant};
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        {
            let db = store.db().unwrap();
            let tx = db.unchecked_transaction().unwrap();
            let words = ["rural", "urban", "maternal", "fiscal", "digital", "public", "global", "early", "social", "local", "mental", "labour", "trade", "health", "energy", "school", "credit", "water", "climate", "migrant"];
            for i in 0..20_000 {
                let title = format!("{} {} {} study {i} of household income and child health", words[i % 20], words[(i / 20) % 20], words[(i / 400) % 20]);
                let input: SourceInput = serde_json::from_value(json!({
                    "kind": "reference", "title": title, "year": 1990 + i % 30,
                    "doi": format!("10.5555/bench.{i}"), "url": format!("https://example.org/articles/{i}?utm_source=x"),
                    "creators": [{"family": format!("Author{}", i % 2000), "role": "author"}],
                }))
                .unwrap();
                crate::insert_source_row(&tx, &format!("s{i:05}"), &input, 0).unwrap();
            }
            tx.commit().unwrap();
        }
        let ask = |value: Json| {
            let start = Instant::now();
            let hits = store.match_identifiers(&[query(value)]).unwrap();
            (hits.into_iter().map(|h| (h.source_id, h.kind)).next(), start.elapsed())
        };
        // Warm the readers' statement caches.
        for _ in 0..3 {
            ask(json!({"key": "w", "doi": "10.5555/bench.1", "title": "urban rural rural study 1 of household income and child health"}));
        }
        let budget = if cfg!(debug_assertions) { Duration::from_millis(25) } else { Duration::from_millis(5) };
        let (found, took) = ask(json!({"key": "a", "doi": "https://doi.org/10.5555/BENCH.12345"}));
        assert_eq!(found, Some(("s12345".to_string(), "doi")));
        assert!(took < budget, "DOI lookup took {took:?}");
        let (found, took) = ask(json!({"key": "b", "url": "http://www.example.org/articles/777/"}));
        assert_eq!(found, Some(("s00777".to_string(), "url")));
        assert!(took < budget, "link lookup took {took:?}");
        let (found, took) = ask(json!({"key": "c", "title": "Maternal trade mental study 4242 of household income and child health", "year": 2002, "firstAuthor": "Author242"}));
        assert_eq!(found, Some(("s04242".to_string(), "title")));
        assert!(took < budget * 2, "title lookup took {took:?}");

        // The duplicate index is built once, then follows each change.
        let start = Instant::now();
        store.duplicate_groups(false).unwrap();
        let built = start.elapsed();
        let added = add(&store, json!({"kind": "reference", "title": "A new study of household income and child health", "year": 2019, "creators": [{"family": "Author99", "role": "author"}]}));
        let start = Instant::now();
        let index = store.duplicate_index().unwrap();
        let refreshed = start.elapsed();
        assert!(index.contains(&added));
        assert!(refreshed < budget && refreshed * 5 < built, "refresh took {refreshed:?} (build {built:?})");
        // A trashed source is no longer found.
        store.trash(&["s12345".to_string()], true).unwrap();
        assert_eq!(ask(json!({"key": "e", "doi": "10.5555/bench.12345"})).0, None);
        assert!(!store.duplicate_index().unwrap().contains("s12345"));
    }
}
