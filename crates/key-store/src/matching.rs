// "Already in library": which library source a work seen elsewhere (a web search hit, a
// reader's cited work, a browser page, a related work) is. Identifiers match exactly once
// normalised (DOI, arXiv, PMID, PMCID, ISBN, OpenAlex); a link matches its normalised
// address (no tracking parameters, no `www.`, a library proxy's rewriting undone); a title
// matches only as "possibly" (same normalised title, years within one, first authors that
// agree), and never when both sides name different DOIs.
use crate::{Result, Store, e};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::HashMap;

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

// ── The index ────────────────────────────────────────────────────────────────

struct Row {
    id: String,
    title: String,
    has_file: bool,
}

#[derive(Default)]
struct Index {
    rows: Vec<Row>,
    by: HashMap<(&'static str, String), usize>,
    by_id: HashMap<String, usize>,
}

impl Index {
    fn put(&mut self, kind: &'static str, value: Option<String>, row: usize) {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            self.by.entry((kind, value)).or_insert(row);
        }
    }
    fn get(&self, kind: &'static str, value: Option<String>) -> Option<usize> {
        self.by.get(&(kind, value?)).copied()
    }
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

/// The identifier match for one query against the index.
fn find(index: &Index, q: &MatchQuery) -> Option<MatchHit> {
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
    let checks: [(&'static str, Option<String>); 6] = [
        ("doi", doi),
        ("arxiv", arxiv),
        ("pmid", pmid),
        ("pmcid", q.pmcid.as_deref().and_then(bare_pmcid)),
        ("isbn", q.isbn.as_deref().and_then(bare_isbn)),
        ("openalex", q.openalex.as_deref().and_then(bare_openalex)),
    ];
    for (kind, value) in checks {
        if let Some(row) = index.get(kind, value) {
            return Some(hit(q, &index.rows[row], kind));
        }
    }
    if let Some(LinkKey::Url(url)) = &link {
        if let Some(row) = index.get("url", Some(url.clone())) {
            return Some(hit(q, &index.rows[row], "url"));
        }
    }
    None
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
    fn match_index(&self) -> Result<Index> {
        let db = self.read()?;
        let mut statement = db
            .prepare("SELECT id, title, doi, url, pmid, pmcid, arxiv_id, isbn, openalex_id, file_path FROM sources WHERE trashed_at IS NULL")
            .map_err(e)?;
        let mut index = Index::default();
        let mut rows = statement.query([]).map_err(e)?;
        while let Some(r) = rows.next().map_err(e)? {
            let text = |i: usize| r.get::<_, Option<String>>(i).ok().flatten().filter(|v| !v.trim().is_empty());
            let at = index.rows.len();
            let doi = text(2).as_deref().and_then(bare_doi);
            index.put("doi", doi.clone(), at);
            if let Some(url) = text(3) {
                match link_key(&url) {
                    Some(LinkKey::Doi(d)) => index.put("doi", Some(d), at),
                    Some(LinkKey::Arxiv(a)) => index.put("arxiv", Some(a), at),
                    Some(LinkKey::Pmid(p)) => index.put("pmid", Some(p), at),
                    Some(LinkKey::Url(u)) => index.put("url", Some(u), at),
                    None => {}
                }
            }
            index.put("pmid", text(4).as_deref().and_then(bare_pmid), at);
            index.put("pmcid", text(5).as_deref().and_then(bare_pmcid), at);
            index.put("arxiv", text(6).as_deref().and_then(bare_arxiv), at);
            index.put("arxiv", doi.as_deref().and_then(|d| d.strip_prefix("10.48550/arxiv.")).map(String::from), at);
            // A book can carry several ISBNs ("978…; 978…").
            for isbn in crate::normalize::isbns(&text(7).unwrap_or_default()) {
                index.put("isbn", Some(isbn), at);
            }
            index.put("openalex", text(8).as_deref().and_then(bare_openalex), at);
            let id: String = r.get(0).map_err(e)?;
            index.by_id.insert(id.clone(), at);
            index.rows.push(Row { id, title: text(1).unwrap_or_default(), has_file: text(9).is_some() });
        }
        Ok(index)
    }

    /// Which of these works the library has (at most 500 asked at once); unmatched ones are
    /// left out. Identifiers and links match exactly; otherwise the duplicate engine
    /// (duplicates.rs) decides whether a library source is the same work by its title,
    /// year and first author, and that match is only "possible".
    pub fn match_identifiers(&self, queries: &[MatchQuery]) -> Result<Vec<MatchHit>> {
        if queries.is_empty() {
            return Ok(Vec::new());
        }
        let index = self.match_index()?;
        let queries: Vec<&MatchQuery> = queries.iter().take(500).collect();
        let mut hits: Vec<Option<MatchHit>> = queries.iter().map(|q| find(&index, q)).collect();
        let open: Vec<(usize, crate::duplicates::Work)> = hits.iter().enumerate().filter(|(_, h)| h.is_none()).filter_map(|(i, _)| title_work(queries[i]).map(|w| (i, w))).collect();
        if !open.is_empty() {
            let works: Vec<crate::duplicates::Work> = open.iter().map(|(_, w)| w.clone()).collect();
            for ((i, _), found) in open.iter().zip(self.find_duplicates_for(&works)?) {
                if let Some(row) = found.first().and_then(|m| index.by_id.get(&m.source_id)) {
                    hits[*i] = Some(hit(queries[*i], &index.rows[*row], "title"));
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
}
