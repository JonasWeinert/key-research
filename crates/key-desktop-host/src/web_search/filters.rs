// The search field's filter tokens as web search understands them. Each token the web can
// apply becomes part of `WebFilters`; each provider says which of them it applies in its
// request, and the rest that a result shows (an author's name, the journal …) are checked
// on the results it returns. Tokens no provider can apply (a tag, a collection, notes …)
// stay in the query for the library and are shown as not applied while only the web is searched.
use super::types::{WebResult, fold};
use serde::{Deserialize, Serialize};

/// The kinds of filter web search knows.
pub const KEYS: [&str; 14] = ["year", "author", "title", "venue", "doi", "arxiv", "pmid", "pmcid", "openAccess", "type", "citations", "abstract", "language", "retracted"];
/// Filters that can be checked on a result itself, whatever the provider.
pub const LOCAL: [&str; 12] = ["year", "author", "title", "venue", "doi", "arxiv", "pmid", "pmcid", "openAccess", "type", "citations", "abstract"];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFilters {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year_from: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year_to: Option<i64>,
    /// Each must be among the authors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authors: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arxiv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pmid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pmcid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_access: Option<bool>,
    /// gold, green, hybrid, bronze, diamond (OpenAlex's names).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oa_status: Option<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_citations: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_citations: Option<i64>,
    #[serde(default, rename = "abstract", skip_serializing_if = "Option::is_none")]
    pub abstract_: Option<String>,
    /// ISO 639-1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retracted: Option<bool>,
}

/// A search field token (search-suggest's SearchFilter).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct FilterToken {
    #[serde(default)]
    pub field: String,
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub label: String,
}

/// A work type as the library names item types (article, chapter, conference-paper …).
pub fn work_type(value: Option<&str>) -> Option<&'static str> {
    Some(match value?.to_lowercase().as_str() {
        "article" | "journal-article" | "magazine-article" => "article",
        "review" => "review",
        "preprint" | "posted-content" => "preprint",
        "book" | "monograph" => "book",
        "chapter" | "book-chapter" => "chapter",
        "conference-paper" | "proceedings-article" => "conference-paper",
        "thesis" | "dissertation" => "thesis",
        "report" => "report",
        "dataset" => "dataset",
        _ => return None,
    })
}

fn digits(value: &str, n: Option<usize>) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()) && n.is_none_or(|n| value.len() == n)
}

/// Which web filter a token is, if any.
pub fn filter_key(token: &FilterToken) -> Option<&'static str> {
    Some(match token.field.as_str() {
        "year" if digits(&token.value, Some(4)) => "year",
        "creator" | "person" => "author",
        "title" => "title",
        "container" | "venue" => "venue",
        "doi" => "doi",
        "arxiv" => "arxiv",
        "pmid" => "pmid",
        "pmcid" => "pmcid",
        "oaStatus" => "openAccess",
        "itemType" | "workType" if work_type(Some(&token.value)).is_some() => "type",
        "citations" if digits(&token.value, None) => "citations",
        "abstract" => "abstract",
        "language" if token.value.len() == 2 && token.value.chars().all(|c| c.is_ascii_alphabetic()) => "language",
        "retracted" => "retracted",
        _ => return None,
    })
}

/// The web filters a list of tokens asks for. Tokens of the same kind narrow together.
pub fn to_filters(tokens: &[FilterToken]) -> WebFilters {
    let mut out = WebFilters::default();
    for token in tokens {
        let Some(key) = filter_key(token) else { continue };
        // People and venues are entity tokens: their value is an id, their label the name.
        let text = if token.field == "person" || token.field == "venue" { token.label.trim() } else { token.value.trim() };
        let op = token.op.as_deref().unwrap_or("is");
        match key {
            "year" => {
                let year: i64 = token.value.parse().unwrap_or(0);
                let from = match op {
                    "gt" => Some(year + 1),
                    "gte" | "is" | "contains" => Some(year),
                    _ => None,
                };
                let to = match op {
                    "lt" => Some(year - 1),
                    "lte" | "is" | "contains" => Some(year),
                    _ => None,
                };
                if let Some(from) = from {
                    out.year_from = Some(out.year_from.map_or(from, |f| f.max(from)));
                }
                if let Some(to) = to {
                    out.year_to = Some(out.year_to.map_or(to, |t| t.min(to)));
                }
            }
            "author" => {
                let mut authors = out.authors.take().unwrap_or_default();
                if !text.is_empty() {
                    authors.push(text.to_string());
                }
                out.authors = Some(authors);
            }
            "title" => out.title = Some([out.title.take().unwrap_or_default(), text.to_string()].iter().filter(|t| !t.is_empty()).cloned().collect::<Vec<_>>().join(" ")),
            "venue" => out.venue = Some(text.to_string()),
            "doi" => out.doi = Some(text.to_lowercase()),
            "arxiv" => out.arxiv = Some(text.to_lowercase()),
            "pmid" => out.pmid = Some(text.to_string()),
            "pmcid" => out.pmcid = Some(text.to_uppercase()),
            "openAccess" => {
                let status = text.to_lowercase();
                if status == "closed" {
                    out.open_access = Some(false);
                } else {
                    out.open_access = Some(true);
                    if !status.is_empty() && status != "true" && status != "open" {
                        out.oa_status = Some(status);
                    }
                }
            }
            "type" => out.kind = work_type(Some(&token.value)).map(String::from),
            "citations" => {
                let n: i64 = token.value.parse().unwrap_or(0);
                match op {
                    "gt" => out.min_citations = Some(n + 1),
                    "gte" | "is" => out.min_citations = Some(n),
                    "lt" => out.max_citations = Some((n - 1).max(0)),
                    "lte" => out.max_citations = Some(n),
                    _ => {}
                }
            }
            "abstract" => out.abstract_ = Some(text.to_string()),
            "language" => out.language = Some(text.to_lowercase()),
            "retracted" => out.retracted = Some(token.value != "false"),
            _ => {}
        }
    }
    out
}

/// The kinds of filter set in `filters`.
pub fn active(filters: &WebFilters) -> Vec<&'static str> {
    let f = filters;
    let set = |s: &Option<String>| s.as_deref().is_some_and(|s| !s.is_empty());
    [
        ("year", f.year_from.is_some() || f.year_to.is_some()),
        ("author", f.authors.as_ref().is_some_and(|a| !a.is_empty())),
        ("title", set(&f.title)),
        ("venue", set(&f.venue)),
        ("doi", set(&f.doi)),
        ("arxiv", set(&f.arxiv)),
        ("pmid", set(&f.pmid)),
        ("pmcid", set(&f.pmcid)),
        ("openAccess", f.open_access.is_some()),
        ("type", set(&f.kind)),
        ("citations", f.min_citations.is_some() || f.max_citations.is_some()),
        ("abstract", set(&f.abstract_)),
        ("language", set(&f.language)),
        ("retracted", f.retracted.is_some()),
    ]
    .into_iter()
    .filter_map(|(k, on)| on.then_some(k))
    .collect()
}

/// Only the filters of these kinds.
pub fn pick(filters: &WebFilters, keys: &[&str]) -> WebFilters {
    let has = |k: &str| keys.contains(&k);
    let f = filters.clone();
    WebFilters {
        year_from: f.year_from.filter(|_| has("year")),
        year_to: f.year_to.filter(|_| has("year")),
        authors: f.authors.filter(|_| has("author")),
        title: f.title.filter(|_| has("title")),
        venue: f.venue.filter(|_| has("venue")),
        doi: f.doi.filter(|_| has("doi")),
        arxiv: f.arxiv.filter(|_| has("arxiv")),
        pmid: f.pmid.filter(|_| has("pmid")),
        pmcid: f.pmcid.filter(|_| has("pmcid")),
        open_access: f.open_access.filter(|_| has("openAccess")),
        oa_status: f.oa_status.filter(|_| has("openAccess")),
        kind: f.kind.filter(|_| has("type")),
        min_citations: f.min_citations.filter(|_| has("citations")),
        max_citations: f.max_citations.filter(|_| has("citations")),
        abstract_: f.abstract_.filter(|_| has("abstract")),
        language: f.language.filter(|_| has("language")),
        retracted: f.retracted.filter(|_| has("retracted")),
    }
}

/// `needle`'s words appear in `haystack` from a word start ("Smith" in "John Smith").
fn contains(haystack: Option<&str>, needle: &str) -> bool {
    haystack.is_some_and(|h| format!(" {} ", fold(h)).contains(&format!(" {}", fold(needle))))
}

/// Whether a result meets the filters of these kinds (those a provider could not ask for).
pub fn meets(result: &WebResult, filters: &WebFilters, keys: &[&str]) -> bool {
    keys.iter().all(|key| match *key {
        "year" => result.year.is_some_and(|y| filters.year_from.is_none_or(|f| y >= f) && filters.year_to.is_none_or(|t| y <= t)),
        "author" => filters.authors.iter().flatten().all(|name| result.authors.iter().any(|a| contains(Some(a), name))),
        "title" => contains(Some(&result.title), filters.title.as_deref().unwrap_or("")),
        "venue" => contains(result.venue.as_deref(), filters.venue.as_deref().unwrap_or("")),
        "doi" => result.doi.is_some() && result.doi == filters.doi,
        "arxiv" => {
            let arxiv = filters.arxiv.as_deref().unwrap_or("");
            result.ids.arxiv.as_deref().is_some_and(|a| a.to_lowercase() == arxiv) || result.doi.as_deref() == Some(&format!("10.48550/arxiv.{arxiv}"))
        }
        "pmid" => result.ids.pmid.is_some() && result.ids.pmid == filters.pmid,
        "pmcid" => result.ids.pmcid.as_deref().is_some_and(|p| {
            let p = p.to_uppercase();
            let p = if p.starts_with("PMC") { p } else { format!("PMC{p}") };
            Some(p.as_str()) == filters.pmcid.as_deref()
        }),
        "openAccess" => {
            if filters.open_access == Some(false) {
                return result.open_access == Some(false);
            }
            if result.open_access != Some(true) && result.pdf_url.is_none() {
                return false;
            }
            filters.oa_status.is_none() || result.oa_status == filters.oa_status
        }
        "type" => {
            let have = work_type(result.kind.as_deref());
            have.is_some() && have == filters.kind.as_deref() || (filters.kind.as_deref() == Some("article") && have == Some("review"))
        }
        "citations" => result.cited_by.is_some_and(|c| filters.min_citations.is_none_or(|m| c >= m) && filters.max_citations.is_none_or(|m| c <= m)),
        "abstract" => contains(result.abstract_.as_deref(), filters.abstract_.as_deref().unwrap_or("")),
        _ => false,
    })
}

/// Words that stand in for the query when only filters were given (some providers need words).
pub fn filter_words(filters: &WebFilters) -> String {
    [filters.title.clone()]
        .into_iter()
        .chain(filters.authors.iter().flatten().cloned().map(Some))
        .chain([filters.venue.clone(), filters.abstract_.clone()])
        .flatten()
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(field: &str, value: &str, op: Option<&str>) -> FilterToken {
        FilterToken { field: field.into(), value: value.into(), op: op.map(String::from), label: value.into() }
    }
    fn labelled(field: &str, value: &str, op: &str, label: &str) -> FilterToken {
        FilterToken { label: label.into(), ..token(field, value, Some(op)) }
    }
    fn work(f: impl FnOnce(&mut WebResult)) -> WebResult {
        let mut w = WebResult { provider: "a".into(), provider_id: "1".into(), title: "A study of attention".into(), authors: vec!["Ashish Vaswani".into(), "Noam Shazeer".into()], ..Default::default() };
        f(&mut w);
        w
    }

    #[test]
    fn knows_which_tokens_the_web_can_apply() {
        assert_eq!(filter_key(&token("creator", "Smith", Some("contains"))), Some("author"));
        assert_eq!(filter_key(&labelled("person", "p1", "is", "Jane Smith")), Some("author"));
        assert_eq!(filter_key(&token("container", "Nature", None)), Some("venue"));
        assert_eq!(filter_key(&token("workType", "preprint", None)), Some("type"));
        assert_eq!(filter_key(&token("itemType", "software", None)), None);
        for field in ["tag", "collection", "notes", "fulltext", "item", "kind", "property", "url", "isbn"] {
            assert_eq!(filter_key(&token(field, "x", None)), None);
        }
    }

    #[test]
    fn turns_tokens_into_filters() {
        let filters = to_filters(&[
            token("year", "2018", Some("gte")),
            token("year", "2021", Some("lte")),
            token("creator", "Vaswani", Some("contains")),
            labelled("person", "p9", "is", "Noam Shazeer"),
            token("title", "attention", Some("contains")),
            labelled("venue", "v1", "is", "NeurIPS"),
            token("doi", "10.1/ABC", None),
            token("oaStatus", "gold", None),
            token("workType", "book-chapter", None),
            token("citations", "100", Some("gt")),
            token("tag", "covid", None),
        ]);
        assert_eq!(
            serde_json::to_value(&filters).unwrap(),
            serde_json::json!({ "yearFrom": 2018, "yearTo": 2021, "authors": ["Vaswani", "Noam Shazeer"], "title": "attention", "venue": "NeurIPS", "doi": "10.1/abc", "openAccess": true, "oaStatus": "gold", "type": "chapter", "minCitations": 101 })
        );
        assert_eq!(to_filters(&[token("year", "2019", None)]), WebFilters { year_from: Some(2019), year_to: Some(2019), ..Default::default() });
        assert_eq!(to_filters(&[token("year", "2019", Some("gt"))]), WebFilters { year_from: Some(2020), ..Default::default() });
        assert_eq!(to_filters(&[token("oaStatus", "closed", None)]), WebFilters { open_access: Some(false), ..Default::default() });
        let f = WebFilters { year_to: Some(2000), authors: Some(vec!["x".into()]), retracted: Some(false), ..Default::default() };
        assert_eq!(active(&f), vec!["year", "author", "retracted"]);
        let f = WebFilters { year_from: Some(1), title: Some("t".into()), venue: Some("v".into()), ..Default::default() };
        assert_eq!(pick(&f, &["year", "venue"]), WebFilters { year_from: Some(1), venue: Some("v".into()), ..Default::default() });
    }

    #[test]
    fn checks_a_result_against_filters() {
        let years = WebFilters { year_from: Some(2015), year_to: Some(2018), ..Default::default() };
        assert!(meets(&work(|w| w.year = Some(2017)), &years, &["year"]));
        assert!(!meets(&work(|w| w.year = Some(2019)), &years, &["year"]));
        assert!(meets(&work(|_| {}), &WebFilters { authors: Some(vec!["vaswani".into()]), ..Default::default() }, &["author"]));
        assert!(!meets(&work(|_| {}), &WebFilters { authors: Some(vec!["Väswani".into(), "Parmar".into()]), ..Default::default() }, &["author"]));
        assert!(meets(&work(|w| w.venue = Some("Neural Information Processing Systems".into())), &WebFilters { venue: Some("information processing".into()), ..Default::default() }, &["venue"]));
        assert!(meets(&work(|_| {}), &WebFilters { title: Some("attention".into()), ..Default::default() }, &["title"]));
        assert!(!meets(&work(|w| w.open_access = Some(false)), &WebFilters { open_access: Some(true), ..Default::default() }, &["openAccess"]));
        let gold = WebFilters { open_access: Some(true), oa_status: Some("gold".into()), ..Default::default() };
        assert!(!meets(&work(|w| (w.open_access, w.oa_status) = (Some(true), Some("green".into()))), &gold, &["openAccess"]));
        assert!(meets(&work(|w| w.kind = Some("proceedings-article".into())), &WebFilters { kind: Some("conference-paper".into()), ..Default::default() }, &["type"]));
        assert!(!meets(&work(|w| w.cited_by = Some(50)), &WebFilters { min_citations: Some(100), ..Default::default() }, &["citations"]));
        assert!(meets(&work(|w| w.ids.arxiv = Some("1706.03762".into())), &WebFilters { arxiv: Some("1706.03762".into()), ..Default::default() }, &["arxiv"]));
    }
}
