// Semantic Scholar's Graph API (/graph/v1/paper/search): works without a key at a low, shared
// rate limit; the user's key is sent as x-api-key.
use super::filters::{WebFilters, filter_words};
use super::http::{Base, ProviderError};
use super::provider::{Capabilities, Context, Provider, SearchRequest, encode_path};
use super::types::{Ids, WebPage, WebResult, bare_doi, snippet_of};
use serde_json::Value as Json;

const FIELDS: &str = "title,authors,year,venue,journal,abstract,externalIds,citationCount,isOpenAccess,openAccessPdf,url,publicationTypes";

fn base() -> Base {
    Base::from_env("KEY_WEB_S2_URL", "https://api.semanticscholar.org")
}

fn text(value: &Json) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

pub fn parse_paper(paper: &Json) -> Option<WebResult> {
    let title = text(&paper["title"])?;
    let ext = &paper["externalIds"];
    let id = |key: &str| match &ext[key] {
        Json::String(s) if !s.is_empty() => Some(s.clone()),
        Json::Number(n) => Some(n.to_string()),
        _ => None,
    };
    let doi = bare_doi(id("DOI").as_deref());
    let arxiv = id("ArXiv");
    let types: Vec<&str> = paper["publicationTypes"].as_array().into_iter().flatten().filter_map(Json::as_str).collect();
    let paper_id = text(&paper["paperId"]).unwrap_or_default();
    // Conference papers are often also tagged JournalArticle; the more specific wins.
    let kind = [("Conference", "proceedings-article"), ("BookSection", "book-chapter"), ("Book", "book"), ("Review", "review"), ("Dataset", "dataset"), ("JournalArticle", "article")]
        .iter()
        .find(|(t, _)| types.contains(t))
        .map(|(_, k)| k.to_string())
        .or_else(|| (arxiv.is_some() && doi.is_none()).then(|| "preprint".to_string()));
    Some(WebResult {
        provider: "s2".into(),
        provider_id: paper_id.clone(),
        title,
        authors: paper["authors"].as_array().into_iter().flatten().filter_map(|a| text(&a["name"])).collect(),
        year: paper["year"].as_i64(),
        venue: text(&paper["journal"]["name"]).or_else(|| text(&paper["venue"])),
        abstract_: snippet_of(paper["abstract"].as_str(), 4000),
        ids: Ids { s2: Some(paper_id).filter(|p| !p.is_empty()), arxiv: arxiv.clone(), pmid: id("PubMed"), pmcid: id("PubMedCentral"), mag: id("MAG"), openalex: None },
        cited_by: paper["citationCount"].as_i64(),
        open_access: paper["isOpenAccess"].as_bool(),
        oa_status: text(&paper["openAccessPdf"]["status"]).map(|s| s.to_lowercase()),
        pdf_url: text(&paper["openAccessPdf"]["url"]).or_else(|| arxiv.map(|a| format!("https://arxiv.org/pdf/{a}"))),
        landing_url: doi.as_ref().map(|d| format!("https://doi.org/{d}")).or_else(|| text(&paper["url"])),
        kind,
        doi,
        fallback_for: None,
    })
}

pub fn parse_page(body: &Json) -> WebPage {
    WebPage {
        results: body["data"].as_array().into_iter().flatten().filter_map(parse_paper).collect(),
        cursor: body["next"].as_i64().map(|n| n.to_string()),
        total: body["total"].as_i64(),
        skipped: None,
        ..Default::default()
    }
}

// Semantic Scholar applies years itself and finds a work by its identifier; journals, types,
// open access and citation counts it narrows by but not exactly, so they are also checked on
// its results, as are authors, titles and abstracts. Language and retractions it cannot tell.
const FILTERS: &[&str] = &["year", "doi", "arxiv", "pmid", "pmcid"];

/// The paper to look up instead of searching, for an identifier filter.
pub fn paper_id(f: &WebFilters) -> Option<String> {
    let set = |s: &Option<String>| s.clone().filter(|s| !s.is_empty());
    if let Some(doi) = set(&f.doi) {
        return Some(format!("DOI:{doi}"));
    }
    if let Some(arxiv) = set(&f.arxiv) {
        return Some(format!("ARXIV:{arxiv}"));
    }
    if let Some(pmid) = set(&f.pmid) {
        return Some(format!("PMID:{pmid}"));
    }
    set(&f.pmcid).map(|p| format!("PMCID:{}", if p.len() > 3 && p[..3].eq_ignore_ascii_case("pmc") { &p[3..] } else { &p }))
}

/// Search parameters for these filters.
pub fn params(f: &WebFilters) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    if f.year_from.is_some() || f.year_to.is_some() {
        let show = |y: Option<i64>| y.map(|y| y.to_string()).unwrap_or_default();
        out.push(("year", if f.year_from == f.year_to { show(f.year_from) } else { format!("{}-{}", show(f.year_from), show(f.year_to)) }));
    }
    if let Some(venue) = f.venue.as_deref().filter(|v| !v.is_empty()) {
        out.push(("venue", venue.replace(',', " ")));
    }
    if f.open_access == Some(true) {
        out.push(("openAccessPdf", String::new()));
    }
    let kind = match f.kind.as_deref() {
        Some("article") => Some("JournalArticle"),
        Some("review") => Some("Review"),
        Some("book") => Some("Book"),
        Some("chapter") => Some("BookSection"),
        Some("conference-paper") => Some("Conference"),
        Some("dataset") => Some("Dataset"),
        _ => None,
    };
    if let Some(kind) = kind {
        out.push(("publicationTypes", kind.into()));
    }
    if let Some(n) = f.min_citations {
        out.push(("minCitationCount", n.to_string()));
    }
    out
}

pub struct SemanticScholar;

impl SemanticScholar {
    fn headers<'a>(cx: &'a Context) -> Vec<(&'static str, &'a str)> {
        cx.api_key.map(|k| ("x-api-key", k)).into_iter().collect()
    }
}

impl Provider for SemanticScholar {
    fn id(&self) -> &'static str {
        "s2"
    }
    fn label(&self) -> &'static str {
        "Semantic Scholar"
    }
    fn icon(&self) -> &'static str {
        "sparkle"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            api_key: true,
            key_required: false,
            key_help: "Optional. Without one, Semantic Scholar answers slowly when many people search at once.",
            enabled_by_default: true,
            filters: FILTERS,
            service: Some("semantic-scholar"),
        }
    }
    fn search(&self, query: &str, request: &SearchRequest, cx: &Context) -> Result<WebPage, ProviderError> {
        if let Some(id) = paper_id(request.filters) {
            if request.cursor.is_some() {
                return Ok(WebPage::default());
            }
            let paper = self.lookup(&id, cx)?;
            let total = Some(paper.is_some() as i64);
            return Ok(WebPage { results: paper.into_iter().collect(), total, ..Default::default() });
        }
        let words = if query.is_empty() { filter_words(request.filters) } else { query.to_string() };
        if words.is_empty() {
            return Ok(WebPage::default());
        }
        let limit = request.limit.to_string();
        let extra = params(request.filters);
        let mut query: Vec<(&str, &str)> = vec![("query", &words), ("offset", request.cursor.unwrap_or("0")), ("limit", &limit), ("fields", FIELDS)];
        query.extend(extra.iter().map(|(k, v)| (*k, v.as_str())));
        Ok(parse_page(&cx.get_json(&base(), "graph/v1/paper/search", &query, &Self::headers(cx), "Semantic Scholar")?))
    }
    fn has_lookup(&self) -> bool {
        true
    }
    fn lookup(&self, id: &str, cx: &Context) -> Result<Option<WebResult>, ProviderError> {
        let key = match bare_doi(Some(id)).filter(|d| d.starts_with("10.")) {
            Some(doi) => format!("DOI:{doi}"),
            None => id.trim().to_string(),
        };
        match cx.get_json(&base(), &format!("graph/v1/paper/{}", encode_path(&key)), &[("fields", FIELDS)], &Self::headers(cx), "Semantic Scholar") {
            Ok(paper) => Ok(parse_paper(&paper)),
            Err(error) if error.status == Some(404) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::tests::{Recorded, fixture};

    #[test]
    fn maps_every_field() {
        let page = parse_page(&fixture("s2-search.json"));
        assert_eq!(page.cursor.as_deref(), Some("3"));
        let [attention, bert, gpt] = page.results.as_slice() else { panic!("three papers") };
        assert_eq!(attention.provider_id, "204e3073870fae3d05bcbc2f6a8e263d9b72e776");
        assert_eq!(attention.authors, ["Ashish Vaswani", "Noam M. Shazeer"]);
        assert_eq!(attention.venue.as_deref(), Some("Neural Information Processing Systems"));
        assert_eq!(attention.doi, None);
        assert_eq!(attention.ids, Ids { s2: Some("204e3073870fae3d05bcbc2f6a8e263d9b72e776".into()), arxiv: Some("1706.03762".into()), mag: Some("2963403868".into()), ..Default::default() });
        assert_eq!((attention.cited_by, attention.open_access), (Some(120000), Some(false)));
        assert_eq!(attention.pdf_url.as_deref(), Some("https://arxiv.org/pdf/1706.03762"));
        assert_eq!(attention.landing_url.as_deref(), Some("https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263d9b72e776"));
        assert_eq!(attention.kind.as_deref(), Some("proceedings-article"));
        assert_eq!((bert.doi.as_deref(), bert.oa_status.as_deref(), bert.pdf_url.as_deref(), &bert.abstract_), (Some("10.18653/v1/n19-1423"), Some("hybrid"), Some("https://aclanthology.org/N19-1423.pdf"), &None));
        assert_eq!((gpt.kind.as_deref(), gpt.ids.arxiv.as_deref()), (Some("preprint"), Some("2005.14165")));
    }

    #[test]
    fn sends_the_key_as_a_header_and_pages_by_offset() {
        let recorded = Recorded::new(vec![(200, r#"{"data":[]}"#.into())]);
        let out = SemanticScholar.search("attention", &SearchRequest { limit: 10, cursor: Some("20"), filters: &WebFilters::default() }, &recorded.context(Some("secret"), "")).unwrap();
        assert_eq!(Recorded::query(&recorded.urls()[0])["offset"], "20");
        assert_eq!(recorded.headers()[0], vec![("x-api-key".to_string(), "secret".to_string())]);
        assert_eq!(out, WebPage::default());
    }

    #[test]
    fn maps_filters_onto_search_parameters() {
        let f = WebFilters { year_from: Some(2018), year_to: Some(2021), venue: Some("Nature, Medicine".into()), open_access: Some(true), kind: Some("conference-paper".into()), min_citations: Some(5), ..Default::default() };
        let p: Vec<(&str, String)> = params(&f);
        assert_eq!(p, vec![("year", "2018-2021".into()), ("venue", "Nature  Medicine".into()), ("openAccessPdf", "".into()), ("publicationTypes", "Conference".into()), ("minCitationCount", "5".into())]);
        assert_eq!(params(&WebFilters { year_to: Some(2000), kind: Some("thesis".into()), ..Default::default() }), vec![("year", "-2000".to_string())]);
        assert_eq!(paper_id(&WebFilters { doi: Some("10.1/x".into()), ..Default::default() }).as_deref(), Some("DOI:10.1/x"));
        assert_eq!(paper_id(&WebFilters { pmcid: Some("PMC123".into()), ..Default::default() }).as_deref(), Some("PMCID:123"));
    }

    #[test]
    fn looks_a_doi_up_instead_of_searching() {
        let paper = fixture("s2-search.json")["data"][1].to_string();
        let recorded = Recorded::new(vec![(200, paper), (404, "{}".into())]);
        let filters = WebFilters { doi: Some("10.18653/v1/n19-1423".into()), ..Default::default() };
        let page = SemanticScholar.search("anything", &SearchRequest { limit: 10, cursor: None, filters: &filters }, &recorded.context(None, "")).unwrap();
        assert_eq!(recorded.urls()[0].path(), "/graph/v1/paper/DOI:10.18653/v1/n19-1423");
        assert_eq!(page.results.iter().map(|r| r.doi.clone().unwrap()).collect::<Vec<_>>(), ["10.18653/v1/n19-1423"]);
        let missing = WebFilters { doi: Some("10.1/none".into()), ..Default::default() };
        assert!(SemanticScholar.search("x", &SearchRequest { limit: 10, cursor: None, filters: &missing }, &recorded.context(None, "")).unwrap().results.is_empty());
    }

    #[test]
    fn uses_the_filter_words_when_there_are_no_others() {
        let recorded = Recorded::new(vec![(200, r#"{"data":[]}"#.into())]);
        let filters = WebFilters { authors: Some(vec!["Vaswani".into()]), year_from: Some(2017), ..Default::default() };
        SemanticScholar.search("", &SearchRequest { limit: 10, cursor: None, filters: &filters }, &recorded.context(None, "")).unwrap();
        let q = Recorded::query(&recorded.urls()[0]);
        assert_eq!((q["query"].as_str(), q["year"].as_str()), ("Vaswani", "2017-"));
    }
}
