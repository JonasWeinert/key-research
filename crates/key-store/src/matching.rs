// "Already in library": which library source a work seen elsewhere (a web search hit, a
// reader's cited work, a browser page, a related work) is. Identifiers match exactly once
// normalised (DOI, arXiv, PMID, PMCID, ISBN, OpenAlex); a link matches its normalised
// address (no tracking parameters, no `www.`, a library proxy's rewriting undone); a title
// matches only as "possibly" (same normalised title, years within one, first authors that
// agree), and never when both sides name different DOIs.
use crate::{Result, Store, e, graph::name_key};
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

// ── Normalisers ──────────────────────────────────────────────────────────────

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A DOI however it is written: bare, lower-case, without `doi:` or a doi.org link.
pub fn bare_doi(text: &str) -> Option<String> {
    let lower = percent_decode(text.trim()).to_lowercase();
    let at = lower.find("10.")?;
    let head = lower[..at].trim_end();
    let allowed = head.is_empty() || head.ends_with("doi:") || head.ends_with("doi.org/") || head.ends_with("doi") || head.ends_with("doi.org/doi:");
    if !allowed {
        return None;
    }
    let doi: String = lower[at..].split(|c: char| c.is_whitespace() || c == '#' || c == '?').next().unwrap_or("").to_string();
    let doi = doi.trim_end_matches(['.', ',', ';', ')', ']', '/']).to_string();
    (doi.contains('/') && doi.len() > doi.find('/').unwrap_or(0) + 1).then_some(doi)
}

/// An arXiv id without "arXiv:", a link's path or a version: 2101.00001, hep-th/9901001.
pub fn bare_arxiv(text: &str) -> Option<String> {
    let mut t = text.trim().to_lowercase();
    for prefix in ["https://", "http://", "www.", "arxiv.org/abs/", "arxiv.org/pdf/", "export.arxiv.org/abs/", "arxiv:", "10.48550/arxiv."] {
        if let Some(rest) = t.strip_prefix(prefix) {
            t = rest.to_string();
        }
    }
    let t = t.trim().trim_end_matches(".pdf").trim_end_matches('/');
    let t = match t.rfind('v') {
        Some(at) if at > 0 && t[at + 1..].chars().all(|c| c.is_ascii_digit()) && !t[at + 1..].is_empty() && t[..at].chars().last().is_some_and(|c| c.is_ascii_digit()) => &t[..at],
        _ => t,
    };
    (!t.is_empty() && t.chars().any(|c| c.is_ascii_digit())).then(|| t.to_string())
}

pub fn bare_pmid(text: &str) -> Option<String> {
    let digits: String = text.chars().filter(char::is_ascii_digit).collect();
    let digits = digits.trim_start_matches('0').to_string();
    (!digits.is_empty() && digits.len() <= 9).then_some(digits)
}

pub fn bare_pmcid(text: &str) -> Option<String> {
    let digits: String = text.chars().filter(char::is_ascii_digit).collect();
    (!digits.is_empty()).then(|| format!("PMC{}", digits.trim_start_matches('0')))
}

pub fn bare_openalex(text: &str) -> Option<String> {
    let t = text.trim().trim_end_matches('/');
    let id = t.rsplit('/').next().unwrap_or(t).to_uppercase();
    (id.starts_with('W') && id.len() > 1 && id[1..].chars().all(|c| c.is_ascii_digit())).then_some(id)
}

/// An ISBN as ISBN-13 digits (an ISBN-10 is converted), when its checksum holds.
pub fn bare_isbn(text: &str) -> Option<String> {
    let chars: String = text.chars().filter(|c| c.is_ascii_digit() || *c == 'X' || *c == 'x').map(|c| c.to_ascii_uppercase()).collect();
    let valid13 = |d: &str| d.len() == 13 && d.chars().all(|c| c.is_ascii_digit()) && d.chars().enumerate().map(|(i, c)| c.to_digit(10).unwrap_or(0) * if i % 2 == 1 { 3 } else { 1 }).sum::<u32>() % 10 == 0;
    if valid13(&chars) {
        return Some(chars);
    }
    if chars.len() == 10 {
        let d: Vec<char> = chars.chars().collect();
        if !d[..9].iter().all(char::is_ascii_digit) {
            return None;
        }
        let sum: u32 = d.iter().enumerate().map(|(i, &c)| (if c == 'X' { 10 } else { c.to_digit(10).unwrap_or(99) }) * (10 - i as u32)).sum();
        if sum % 11 != 0 {
            return None;
        }
        let body = format!("978{}", &chars[..9]);
        let check: u32 = body.chars().enumerate().map(|(i, c)| c.to_digit(10).unwrap_or(0) * if i % 2 == 1 { 3 } else { 1 }).sum();
        return Some(format!("{body}{}", (10 - check % 10) % 10));
    }
    None
}

/// Query parameters that only say where a click came from.
fn tracking(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with("utm_")
        || n.starts_with("_hs")
        || matches!(
            n.as_str(),
            "fbclid" | "gclid" | "dclid" | "msclkid" | "mc_cid" | "mc_eid" | "ref" | "ref_src" | "referrer" | "src" | "source" | "via" | "igshid" | "si" | "spm" | "cmpid" | "campaign" | "sessionid" | "jsessionid" | "sid" | "casa_token" | "__cf_chl_tk" | "__cf_chl_rt_tk" | "s_kwcid" | "ito" | "trk"
        )
}

/// A link without scheme, `www.`, fragment, tracking parameters or trailing slash, with a
/// library proxy's rewriting undone (EZproxy's `www-nature-com.ezproxy.uni.edu` and
/// `…/login?url=https://…`). Answers the DOI or arXiv id instead when the link is one.
#[derive(Clone, Debug, PartialEq)]
pub enum LinkKey {
    Doi(String),
    Arxiv(String),
    Pmid(String),
    Url(String),
}

pub fn link_key(text: &str) -> Option<LinkKey> {
    let raw = text.trim();
    let (scheme_less, had_scheme) = match raw.find("://") {
        Some(at) if raw[..at].chars().all(|c| c.is_ascii_alphabetic()) => (&raw[at + 3..], true),
        _ => (raw, false),
    };
    if !had_scheme && !scheme_less.contains('.') {
        return None;
    }
    let (rest, _fragment) = scheme_less.split_once('#').unwrap_or((scheme_less, ""));
    let (host_path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (host, path) = host_path.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((host_path, String::new()));
    let host = host.rsplit('@').next().unwrap_or(host).to_lowercase();
    let host = host.split(':').next().unwrap_or(&host).to_string();
    let pairs: Vec<(String, String)> = query.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())).unwrap_or((p.to_string(), String::new()))).collect();
    // EZproxy's login link carries the address it opens.
    if host.contains("proxy") || path.ends_with("/login") {
        if let Some((_, target)) = pairs.iter().find(|(k, _)| matches!(k.to_ascii_lowercase().as_str(), "url" | "qurl")) {
            let target = percent_decode(target);
            if target.contains("://") && target != raw {
                return link_key(&target);
            }
        }
    }
    // A host rewritten by a proxy: the labels before the proxy's, hyphens back to dots.
    let labels: Vec<&str> = host.split('.').collect();
    let host = match labels.iter().position(|l| l.contains("ezproxy") || *l == "proxy" || l.starts_with("proxy-") || l.ends_with("-proxy")) {
        Some(at) if at > 0 && labels[..at].iter().any(|l| l.contains('-')) => {
            labels[..at].join(".").replace("--", "\u{0}").replace('-', ".").replace('\u{0}', "-")
        }
        _ => host,
    };
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    let path = percent_decode(&path);
    if host == "doi.org" || host == "dx.doi.org" {
        return bare_doi(path.trim_start_matches('/')).map(LinkKey::Doi);
    }
    if host == "arxiv.org" || host == "export.arxiv.org" {
        if let Some(id) = path.strip_prefix("/abs/").or_else(|| path.strip_prefix("/pdf/")).and_then(bare_arxiv) {
            return Some(LinkKey::Arxiv(id));
        }
    }
    if host == "pubmed.ncbi.nlm.nih.gov" {
        if let Some(id) = bare_pmid(path.trim_matches('/')).filter(|_| path.trim_matches('/').chars().all(|c| c.is_ascii_digit())) {
            return Some(LinkKey::Pmid(id));
        }
    }
    let path = path.split(';').next().unwrap_or("").trim_end_matches('/').to_string();
    let mut kept: Vec<String> = pairs.into_iter().filter(|(k, _)| !tracking(k)).map(|(k, v)| if v.is_empty() { k } else { format!("{k}={v}") }).collect();
    kept.sort();
    let query = if kept.is_empty() { String::new() } else { format!("?{}", kept.join("&")) };
    (!host.is_empty()).then(|| LinkKey::Url(format!("{host}{path}{query}")))
}

/// A title as matched: folded, letters and digits only.
pub fn title_key(title: &str) -> String {
    // Markup in titles from providers (<i>…</i>) is dropped first.
    let mut plain = String::with_capacity(title.len());
    let mut in_tag = false;
    for c in title.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => plain.push(c),
            _ => {}
        }
    }
    name_key(&plain)
}

fn family_key(name: &str) -> String {
    let name = name.trim();
    let family = match name.split_once(',') {
        Some((family, _)) => family,
        None => name.split_whitespace().last().unwrap_or(""),
    };
    name_key(family)
}

// ── The index ────────────────────────────────────────────────────────────────

struct Row {
    id: String,
    title: String,
    year: Option<i64>,
    first_family: String,
    doi: Option<String>,
    has_file: bool,
}

#[derive(Default)]
struct Index {
    rows: Vec<Row>,
    by: HashMap<(&'static str, String), usize>,
    by_title: HashMap<String, Vec<usize>>,
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

fn first_family(creators: &str) -> String {
    let list: Vec<Json> = serde_json::from_str(creators).unwrap_or_default();
    let first = list.iter().find(|c| c.get("role").and_then(Json::as_str).is_none_or(|r| r == "author")).or(list.first());
    first
        .map(|c| match c.get("family").and_then(Json::as_str).filter(|f| !f.trim().is_empty()) {
            Some(family) => name_key(family),
            None => family_key(c.get("literal").and_then(Json::as_str).unwrap_or("")),
        })
        .unwrap_or_default()
}

fn hit(query: &MatchQuery, row: &Row, kind: &'static str) -> MatchHit {
    MatchHit { key: query.key.clone(), source_id: row.id.clone(), title: row.title.clone(), kind, certain: kind != "title", has_file: row.has_file }
}

/// The match for one query against the index.
fn find(index: &Index, q: &MatchQuery) -> Option<MatchHit> {
    let doi = q.doi.as_deref().and_then(bare_doi);
    let link = q.url.as_deref().and_then(link_key);
    let link_doi = match &link {
        Some(LinkKey::Doi(d)) => Some(d.clone()),
        _ => None,
    };
    let doi = doi.or(link_doi);
    let arxiv = q.arxiv.as_deref().and_then(bare_arxiv).or(match &link {
        Some(LinkKey::Arxiv(a)) => Some(a.clone()),
        _ => None,
    }).or_else(|| doi.as_deref().and_then(|d| d.strip_prefix("10.48550/arxiv.")).map(String::from));
    let pmid = q.pmid.as_deref().and_then(bare_pmid).or(match &link {
        Some(LinkKey::Pmid(p)) => Some(p.clone()),
        _ => None,
    });
    let checks: [(&'static str, Option<String>); 6] = [
        ("doi", doi.clone()),
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
    let title = title_key(q.title.as_deref().unwrap_or(""));
    if title.split_whitespace().count() < 2 && title.len() < 12 {
        return None;
    }
    let author = q.first_author.as_deref().map(family_key).unwrap_or_default();
    let rows = index.by_title.get(&title)?;
    rows.iter().map(|&r| &index.rows[r]).find(|row| {
        let years = match (q.year, row.year) {
            (Some(a), Some(b)) => (a - b).abs() <= 1,
            _ => true,
        };
        let authors = author.is_empty() || row.first_family.is_empty() || author == row.first_family || author.contains(&row.first_family) || row.first_family.contains(&author);
        let dois = doi.is_none() || row.doi.is_none() || row.doi == doi;
        years && authors && dois && !row.title.is_empty()
    }).map(|row| hit(q, row, "title"))
}

impl Store {
    fn match_index(&self) -> Result<Index> {
        let db = self.read()?;
        let mut statement = db
            .prepare("SELECT id, title, year, creators, doi, url, pmid, pmcid, arxiv_id, isbn, openalex_id, file_path FROM sources WHERE trashed_at IS NULL")
            .map_err(e)?;
        let mut index = Index::default();
        let mut rows = statement.query([]).map_err(e)?;
        while let Some(r) = rows.next().map_err(e)? {
            let text = |i: usize| r.get::<_, Option<String>>(i).ok().flatten().filter(|v| !v.trim().is_empty());
            let at = index.rows.len();
            let doi = text(4).as_deref().and_then(bare_doi);
            let title = text(1).unwrap_or_default();
            index.put("doi", doi.clone(), at);
            if let Some(url) = text(5) {
                match link_key(&url) {
                    Some(LinkKey::Doi(d)) => index.put("doi", Some(d), at),
                    Some(LinkKey::Arxiv(a)) => index.put("arxiv", Some(a), at),
                    Some(LinkKey::Pmid(p)) => index.put("pmid", Some(p), at),
                    Some(LinkKey::Url(u)) => index.put("url", Some(u), at),
                    None => {}
                }
            }
            index.put("pmid", text(6).as_deref().and_then(bare_pmid), at);
            index.put("pmcid", text(7).as_deref().and_then(bare_pmcid), at);
            index.put("arxiv", text(8).as_deref().and_then(bare_arxiv), at);
            index.put("arxiv", doi.as_deref().and_then(|d| d.strip_prefix("10.48550/arxiv.")).map(String::from), at);
            // A book can carry several ISBNs ("978…; 978…").
            for part in text(9).unwrap_or_default().split([';', ',', ' ']).filter(|p| p.len() >= 10) {
                index.put("isbn", bare_isbn(part), at);
            }
            if let Some(isbn) = text(9).as_deref().and_then(bare_isbn) {
                index.put("isbn", Some(isbn), at);
            }
            index.put("openalex", text(10).as_deref().and_then(bare_openalex), at);
            let key = title_key(&title);
            if !key.is_empty() {
                index.by_title.entry(key).or_default().push(at);
            }
            index.rows.push(Row {
                id: r.get(0).map_err(e)?,
                title,
                year: r.get::<_, Option<i64>>(2).ok().flatten(),
                first_family: first_family(&text(3).unwrap_or_default()),
                doi,
                has_file: text(11).is_some(),
            });
        }
        Ok(index)
    }

    /// Which of these works the library has (at most 500 asked at once); unmatched ones are left out.
    pub fn match_identifiers(&self, queries: &[MatchQuery]) -> Result<Vec<MatchHit>> {
        if queries.is_empty() {
            return Ok(Vec::new());
        }
        let index = self.match_index()?;
        Ok(queries.iter().take(500).filter_map(|q| find(&index, q)).collect())
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
