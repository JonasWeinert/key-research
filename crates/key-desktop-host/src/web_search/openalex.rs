// OpenAlex (api.openalex.org/works?search=…): free, no key needed; requests carry the polite
// pool's `mailto`, and the user's API key when the fallback policy says so. `request` is also
// how the library's OpenAlex worker (../openalex.rs) reaches OpenAlex: one URL builder and
// transport for both.
use super::filters::WebFilters;
use super::http::{self, Base, ProviderError, Response, SendError};
use super::provider::{Capabilities, Context, Provider, SearchRequest, encode_path};
use super::types::{Ids, WebPage, WebResult, bare_doi, short_id, snippet_of};
use key_safe_http::CancellationToken;
use serde_json::Value as Json;

pub const FIELDS: &str = "id,doi,display_name,publication_year,type,authorships,primary_location,best_oa_location,open_access,ids,cited_by_count,abstract_inverted_index";

pub fn base() -> Base {
    Base::from_env("KEY_WEB_OPENALEX_URL", "https://api.openalex.org")
}

/// GET `<base>/<path>?<query>&mailto=…&api_key=…`.
pub fn request(transport: &http::Transport, path: &str, query: &[(&str, &str)], mailto: Option<&str>, api_key: Option<&str>, cancel: &CancellationToken) -> Result<Response, SendError> {
    let base = base();
    let mut pairs: Vec<(&str, &str)> = query.to_vec();
    if let Some(mailto) = mailto.filter(|m| m.contains('@')) {
        pairs.push(("mailto", mailto));
    }
    if let Some(key) = api_key.map(str::trim).filter(|k| !k.is_empty()) {
        pairs.push(("api_key", key));
    }
    let url = base.url(path, &pairs).map_err(SendError::Failed)?;
    transport(&base, &url, &[], cancel)
}

/// OpenAlex keeps abstracts as word → positions.
pub fn abstract_text(index: Option<&Json>) -> Option<String> {
    let index = index?.as_object()?;
    let mut words: Vec<Option<&str>> = Vec::new();
    for (word, positions) in index {
        for at in positions.as_array().into_iter().flatten().filter_map(Json::as_u64) {
            let at = at as usize;
            if at >= 100_000 {
                continue;
            }
            if words.len() <= at {
                words.resize(at + 1, None);
            }
            words[at] = Some(word);
        }
    }
    let text = words.into_iter().flatten().collect::<Vec<_>>().join(" ");
    Some(text).filter(|t| !t.is_empty())
}

fn text(value: &Json) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// An arXiv id from a landing page, a PDF link or an arXiv DataCite DOI.
fn arxiv_from(urls: &[Option<String>]) -> Option<String> {
    for url in urls.iter().flatten() {
        let lower = url.to_lowercase();
        if let Some(rest) = lower.strip_prefix("10.48550/arxiv.") {
            return Some(url[url.len() - rest.len()..].to_string());
        }
        for marker in ["arxiv.org/abs/", "arxiv.org/pdf/"] {
            if let Some(at) = lower.find(marker) {
                let mut id = &url[at + marker.len()..];
                if id.contains(['?', '#']) || id.chars().any(char::is_whitespace) {
                    continue;
                }
                id = id.strip_suffix(".pdf").unwrap_or(id);
                if let Some(v) = id.rfind('v').filter(|v| *v > 0 && id[v + 1..].chars().all(|c| c.is_ascii_digit()) && id.len() > v + 1) {
                    id = &id[..v];
                }
                if !id.is_empty() {
                    return Some(id.to_string());
                }
            }
        }
    }
    None
}

pub fn parse_work(work: &Json) -> Option<WebResult> {
    let title = text(&work["display_name"]).or_else(|| text(&work["title"]))?;
    let doi = bare_doi(work["doi"].as_str());
    let primary = &work["primary_location"];
    let best = &work["best_oa_location"];
    let id = short_id(work["id"].as_str());
    let arxiv = arxiv_from(&[text(&primary["landing_page_url"]), text(&best["landing_page_url"]), doi.clone()]);
    let pmid = short_id(work["ids"]["pmid"].as_str()).map(|p| p.chars().filter(char::is_ascii_digit).collect::<String>()).filter(|p| !p.is_empty());
    let pmcid = short_id(work["ids"]["pmcid"].as_str()).map(|p| p.rsplit('/').next().unwrap_or("").to_string()).filter(|p| !p.is_empty());
    let mag = match &work["ids"]["mag"] {
        Json::String(s) => Some(s.clone()),
        Json::Number(n) => Some(n.to_string()),
        _ => None,
    };
    Some(WebResult {
        provider: "openalex".into(),
        provider_id: id.clone().or_else(|| text(&work["id"])).unwrap_or_default(),
        title,
        authors: work["authorships"].as_array().into_iter().flatten().filter_map(|a| text(&a["author"]["display_name"])).collect(),
        year: work["publication_year"].as_i64(),
        venue: text(&primary["source"]["display_name"]),
        abstract_: snippet_of(abstract_text(work.get("abstract_inverted_index")).as_deref(), 4000),
        ids: Ids { openalex: id, pmid, pmcid, mag, arxiv: arxiv.clone(), s2: None },
        cited_by: work["cited_by_count"].as_i64(),
        open_access: work["open_access"]["is_oa"].as_bool(),
        oa_status: text(&work["open_access"]["oa_status"]),
        // An arXiv preprint's PDF is always free, even when OpenAlex points elsewhere.
        pdf_url: text(&best["pdf_url"]).or_else(|| arxiv.map(|a| format!("https://arxiv.org/pdf/{a}"))),
        landing_url: doi.as_ref().map(|d| format!("https://doi.org/{d}")).or_else(|| text(&primary["landing_page_url"])),
        kind: text(&work["type"]),
        doi,
        fallback_for: None,
    })
}

pub fn parse_page(body: &Json) -> WebPage {
    WebPage {
        results: body["results"].as_array().into_iter().flatten().filter_map(parse_work).collect(),
        cursor: text(&body["meta"]["next_cursor"]),
        total: body["meta"]["count"].as_i64(),
        skipped: None,
    }
}

// Filters OpenAlex applies itself (api.openalex.org/works?filter=…). Venues have no search
// filter there, so they are checked on the results.
const FILTERS: &[&str] = &["year", "author", "title", "doi", "arxiv", "pmid", "pmcid", "openAccess", "type", "citations", "abstract", "language", "retracted"];

fn oa_type(kind: &str) -> &str {
    match kind {
        "chapter" => "book-chapter",
        "conference-paper" => "article",
        "thesis" => "dissertation",
        other => other,
    }
}

/// Commas, pipes and colons separate filters and values in the filter parameter.
fn plain(text: &str) -> String {
    text.replace([',', '|', ':'], " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The `filter` parameter for these filters (each part ANDed).
pub fn filter_param(f: &WebFilters) -> Vec<String> {
    let mut out = Vec::new();
    if f.year_from.is_some() || f.year_to.is_some() {
        let show = |y: Option<i64>| y.map(|y| y.to_string()).unwrap_or_default();
        out.push(if f.year_from == f.year_to { format!("publication_year:{}", show(f.year_from)) } else { format!("publication_year:{}-{}", show(f.year_from), show(f.year_to)) });
    }
    for name in f.authors.iter().flatten() {
        out.push(format!("raw_author_name.search:{}", plain(name)));
    }
    if let Some(title) = f.title.as_deref().filter(|t| !t.is_empty()) {
        out.push(format!("title.search:{}", plain(title)));
    }
    if let Some(text) = f.abstract_.as_deref().filter(|t| !t.is_empty()) {
        out.push(format!("abstract.search:{}", plain(text)));
    }
    if let Some(doi) = f.doi.as_deref().filter(|t| !t.is_empty()) {
        out.push(format!("doi:https://doi.org/{doi}"));
    }
    // arXiv preprints carry DataCite DOIs in OpenAlex.
    if let Some(arxiv) = f.arxiv.as_deref().filter(|t| !t.is_empty()) {
        out.push(format!("doi:https://doi.org/10.48550/arxiv.{arxiv}"));
    }
    if let Some(pmid) = f.pmid.as_deref().filter(|t| !t.is_empty()) {
        out.push(format!("pmid:{pmid}"));
    }
    if let Some(pmcid) = f.pmcid.as_deref().filter(|t| !t.is_empty()) {
        let bare = if pmcid.len() > 3 && pmcid[..3].eq_ignore_ascii_case("pmc") { &pmcid[3..] } else { pmcid };
        out.push(format!("pmcid:{bare}"));
    }
    match (f.open_access, f.oa_status.as_deref().filter(|s| !s.is_empty())) {
        (Some(false), _) => out.push("is_oa:false".into()),
        (_, Some(status)) => out.push(format!("oa_status:{}", plain(status))),
        (Some(true), None) => out.push("is_oa:true".into()),
        _ => {}
    }
    // Conference papers are articles in a conference's proceedings there.
    match f.kind.as_deref() {
        Some("conference-paper") => out.push("primary_location.source.type:conference".into()),
        Some(kind) if !kind.is_empty() => out.push(format!("type:{}", oa_type(kind))),
        _ => {}
    }
    if let Some(n) = f.min_citations {
        out.push(format!("cited_by_count:>{}", n - 1));
    }
    if let Some(n) = f.max_citations {
        out.push(format!("cited_by_count:<{}", n + 1));
    }
    if let Some(language) = f.language.as_deref().filter(|t| !t.is_empty()) {
        out.push(format!("language:{language}"));
    }
    if let Some(retracted) = f.retracted {
        out.push(format!("is_retracted:{retracted}"));
    }
    out
}

pub struct OpenAlex;

impl Provider for OpenAlex {
    fn id(&self) -> &'static str {
        "openalex"
    }
    fn label(&self) -> &'static str {
        "OpenAlex"
    }
    fn icon(&self) -> &'static str {
        "globe"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { api_key: true, key_required: false, key_help: "Optional. Uses the key from OpenAlex above.", enabled_by_default: true, filters: FILTERS, service: Some("openalex") }
    }
    fn search(&self, query: &str, request: &SearchRequest, cx: &Context) -> Result<WebPage, ProviderError> {
        let filter = filter_param(request.filters).join(",");
        let limit = request.limit.to_string();
        let mut params: Vec<(&str, &str)> = Vec::new();
        // Filters alone (an author, a DOI …) need no words.
        if !query.is_empty() {
            params.push(("search", query));
        }
        params.extend([("per-page", limit.as_str()), ("cursor", request.cursor.unwrap_or("*")), ("select", FIELDS)]);
        if !filter.is_empty() {
            params.push(("filter", &filter));
        }
        Ok(parse_page(&self.get(cx, "works", &params)?))
    }
    fn has_lookup(&self) -> bool {
        true
    }
    fn lookup(&self, id: &str, cx: &Context) -> Result<Option<WebResult>, ProviderError> {
        let key = match bare_doi(Some(id)).filter(|d| d.starts_with("10.")) {
            Some(doi) => format!("doi:{doi}"),
            None => id.trim().to_string(),
        };
        match self.get(cx, &format!("works/{}", encode_path(&key)), &[("select", FIELDS)]) {
            Ok(work) => Ok(parse_work(&work)),
            Err(error) if error.status == Some(404) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

impl OpenAlex {
    fn get(&self, cx: &Context, path: &str, params: &[(&str, &str)]) -> Result<Json, ProviderError> {
        http::json_of(request(cx.transport, path, params, Some(cx.mailto), cx.api_key, cx.cancel), "OpenAlex")
            .map(|(value, _)| value)
            .map_err(|e| ProviderError { message: http::redact(&e.message, cx.api_key), ..e })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::tests::{Recorded, fixture};

    #[test]
    fn rebuilds_abstracts() {
        assert_eq!(abstract_text(Some(&serde_json::json!({"world": [1], "hello": [0, 2]}))).as_deref(), Some("hello world hello"));
        assert_eq!(abstract_text(None), None);
    }

    #[test]
    fn maps_every_field() {
        let body = fixture("openalex-search.json");
        let page = parse_page(&body);
        assert_eq!(page.cursor.as_deref(), body["meta"]["next_cursor"].as_str());
        assert_eq!(page.total, Some(3));
        let [attention, bert, alphafold] = page.results.as_slice() else { panic!("three works") };
        assert_eq!(attention.provider_id, "W2963403868");
        assert_eq!(attention.title, "Attention Is All You Need");
        assert_eq!(attention.authors, ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"]);
        assert_eq!((attention.year, attention.venue.as_deref(), attention.doi.as_deref()), (Some(2017), Some("arXiv (Cornell University)"), None));
        assert_eq!(attention.ids, Ids { openalex: Some("W2963403868".into()), arxiv: Some("1706.03762".into()), mag: Some("2963403868".into()), ..Default::default() });
        assert_eq!((attention.cited_by, attention.open_access, attention.oa_status.as_deref()), (Some(61234), Some(true), Some("green")));
        assert_eq!(attention.pdf_url.as_deref(), Some("https://arxiv.org/pdf/1706.03762"));
        assert_eq!(attention.landing_url.as_deref(), Some("https://arxiv.org/abs/1706.03762"));
        assert_eq!(attention.kind.as_deref(), Some("preprint"));
        assert!(attention.abstract_.as_deref().unwrap().starts_with("The dominant sequence"));
        assert_eq!(bert.doi.as_deref(), Some("10.18653/v1/n19-1423"));
        assert_eq!(bert.pdf_url.as_deref(), Some("https://aclanthology.org/N19-1423.pdf"));
        assert_eq!(bert.landing_url.as_deref(), Some("https://doi.org/10.18653/v1/n19-1423"));
        assert_eq!(bert.abstract_, None);
        assert_eq!((alphafold.open_access, alphafold.pdf_url.as_deref()), (Some(false), None));
        assert_eq!((alphafold.ids.pmid.as_deref(), alphafold.ids.pmcid.as_deref()), (Some("34265844"), Some("8371605")));
    }

    #[test]
    fn asks_with_the_polite_pool_the_key_and_a_cursor() {
        let recorded = Recorded::new(vec![(200, fixture("openalex-search.json").to_string())]);
        let filters = WebFilters { open_access: Some(true), year_from: Some(2015), ..Default::default() };
        OpenAlex.search("attention", &SearchRequest { limit: 5, cursor: Some("abc"), filters: &filters }, &recorded.context(Some("k"), "me@example.org")).unwrap();
        let url = recorded.urls()[0].clone();
        assert_eq!(url.path(), "/works");
        let q = Recorded::query(&url);
        for (k, v) in [("search", "attention"), ("per-page", "5"), ("cursor", "abc"), ("mailto", "me@example.org"), ("api_key", "k"), ("filter", "publication_year:2015-,is_oa:true")] {
            assert_eq!(q.get(k).map(String::as_str), Some(v), "{k}");
        }
    }

    #[test]
    fn searches_by_filters_alone_without_words() {
        let recorded = Recorded::new(vec![(200, fixture("openalex-search.json").to_string())]);
        let filters = WebFilters { authors: Some(vec!["Vaswani".into()]), ..Default::default() };
        OpenAlex.search("", &SearchRequest { limit: 5, cursor: None, filters: &filters }, &recorded.context(None, "m")).unwrap();
        let q = Recorded::query(&recorded.urls()[0]);
        assert!(!q.contains_key("search"));
        assert_eq!(q["filter"], "raw_author_name.search:Vaswani");
    }

    #[test]
    fn maps_each_filter_onto_the_filter_parameter() {
        let f = WebFilters {
            year_from: Some(2018),
            year_to: Some(2021),
            authors: Some(vec!["Vaswani, A.".into()]),
            title: Some("attention: all".into()),
            doi: Some("10.1/x".into()),
            open_access: Some(true),
            oa_status: Some("gold".into()),
            kind: Some("chapter".into()),
            min_citations: Some(10),
            max_citations: Some(99),
            abstract_: Some("transformer".into()),
            language: Some("en".into()),
            retracted: Some(false),
            ..Default::default()
        };
        assert_eq!(
            filter_param(&f),
            [
                "publication_year:2018-2021",
                "raw_author_name.search:Vaswani A.",
                "title.search:attention all",
                "abstract.search:transformer",
                "doi:https://doi.org/10.1/x",
                "oa_status:gold",
                "type:book-chapter",
                "cited_by_count:>9",
                "cited_by_count:<100",
                "language:en",
                "is_retracted:false",
            ]
        );
        assert_eq!(filter_param(&WebFilters { year_from: Some(2019), year_to: Some(2019), ..Default::default() }), ["publication_year:2019"]);
        let f = WebFilters { arxiv: Some("1706.03762".into()), pmid: Some("123".into()), kind: Some("conference-paper".into()), open_access: Some(false), ..Default::default() };
        assert_eq!(filter_param(&f), ["doi:https://doi.org/10.48550/arxiv.1706.03762", "pmid:123", "is_oa:false", "primary_location.source.type:conference"]);
    }

    #[test]
    fn looks_a_doi_up_and_answers_none_when_unknown() {
        let work = fixture("openalex-search.json")["results"][1].to_string();
        let recorded = Recorded::new(vec![(200, work), (404, "{}".into())]);
        let found = OpenAlex.lookup("https://doi.org/10.18653/V1/N19-1423", &recorded.context(None, "m@x.org")).unwrap().unwrap();
        assert_eq!(found.doi.as_deref(), Some("10.18653/v1/n19-1423"));
        assert_eq!(recorded.urls()[0].path(), "/works/doi:10.18653/v1/n19-1423");
        assert_eq!(OpenAlex.lookup("10.1/none", &recorded.context(None, "m@x.org")).unwrap(), None);
    }
}
