// Brave Search API web search (GET https://api.search.brave.com/res/v1/web/search,
// `X-Subscription-Token: <key>`). Docs checked 2026-11-27:
// https://api-dashboard.search.brave.com/app/documentation/web-search/query (and …/get-started).
// `count` at most 20, `offset` a 0-based page index up to 9, `search_lang` an ISO 639-1 code,
// `freshness` a custom range "YYYY-MM-DDtoYYYY-MM-DD"; a site goes into the query as the
// `site:` operator (the docs say operators belong in `q`). `query.more_results_available`
// says whether a further page exists. Result dates (`page_age`, `age`) are not in the
// documented shape and are read only when present.
use super::engines::{self, freshness_range, page_result, text};
use super::http::{Base, ProviderError};
use super::provider::{Capabilities, Context, Engine, Provider, SearchRequest};
use super::types::{WebPage, WebResult};
use serde_json::Value as Json;

pub fn base() -> Base {
    Base::from_env("KEY_WEB_BRAVE_URL", "https://api.search.brave.com")
}

/// The query parameters for one page (`page` 0-based).
pub fn params(query: &str, request: &SearchRequest, page: usize) -> Vec<(String, String)> {
    let f = request.filters;
    let q = match engines::site(f) {
        Some(site) => format!("{query} site:{site}").trim().to_string(),
        None => query.to_string(),
    };
    let mut out = vec![("q".to_string(), q), ("count".into(), request.limit.clamp(1, 20).to_string()), ("offset".into(), page.min(9).to_string())];
    if let Some(language) = engines::language(f) {
        out.push(("search_lang".into(), language.to_string()));
    }
    if let Some(range) = freshness_range(f) {
        out.push(("freshness".into(), range));
    }
    out
}

pub fn parse_page(body: &Json, page: usize) -> WebPage {
    let results: Vec<WebResult> = body["web"]["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| page_result("brave", r["url"].as_str()?, text(&r["title"]).map(|t| super::types::strip_tags(&t)), r["description"].as_str(), r["page_age"].as_str()))
        .collect();
    let more = body["query"]["more_results_available"].as_bool() == Some(true) && !results.is_empty() && page < 9;
    WebPage { cursor: more.then(|| (page + 1).to_string()), results, ..Default::default() }
}

pub struct Brave;

impl Provider for Brave {
    fn id(&self) -> &'static str {
        "brave"
    }
    fn label(&self) -> &'static str {
        "Brave Search"
    }
    fn icon(&self) -> &'static str {
        "globe"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { api_key: true, key_required: true, key_help: "With your Brave Search API key (Services & API keys).", enabled_by_default: false, filters: &["year", "site", "language"], service: Some("brave") }
    }
    fn engine(&self) -> Option<Engine> {
        Some(Engine { max_results: 20, pricing_url: "https://brave.com/search/api/", ..Default::default() })
    }
    fn search(&self, query: &str, request: &SearchRequest, cx: &Context) -> Result<WebPage, ProviderError> {
        let key = engines::key(cx, "Brave Search")?;
        let page = request.cursor.and_then(|c| c.parse().ok()).unwrap_or(0usize);
        let owned = params(query, request, page);
        let pairs: Vec<(&str, &str)> = owned.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let answer = cx.get_json(&base(), "res/v1/web/search", &pairs, &[("x-subscription-token", key)], "Brave Search")?;
        Ok(parse_page(&answer, page))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::{filters::WebFilters, tests::{Recorded, fixture}};

    #[test]
    fn maps_filters_into_the_query() {
        let f = WebFilters { year_from: Some(2018), year_to: Some(2019), site: Some("who.int".into()), language: Some("fr".into()), ..Default::default() };
        let p: std::collections::HashMap<String, String> = params("vaccine", &SearchRequest { limit: 50, cursor: None, filters: &f }, 2).into_iter().collect();
        assert_eq!((p["q"].as_str(), p["count"].as_str(), p["offset"].as_str()), ("vaccine site:who.int", "20", "2"));
        assert_eq!((p["search_lang"].as_str(), p["freshness"].as_str()), ("fr", "2018-01-01to2019-12-31"));
    }

    #[test]
    fn parses_a_page_and_pages_on() {
        let recorded = Recorded::new(vec![(200, fixture("brave-search.json").to_string()), (200, fixture("brave-search.json").to_string())]);
        let none = WebFilters::default();
        let page = Brave.search("vaccine", &SearchRequest { limit: 10, cursor: None, filters: &none }, &recorded.context(Some("brave-test-key-1"), "")).unwrap();
        assert_eq!((page.results.len(), page.cursor.as_deref()), (2, Some("1")));
        assert_eq!(page.results[0].title, "Vaccines and immunization");
        assert_eq!(page.results[0].year, Some(2024));
        assert!(recorded.headers()[0].contains(&("x-subscription-token".into(), "brave-test-key-1".into())));
        Brave.search("vaccine", &SearchRequest { limit: 10, cursor: Some("1"), filters: &none }, &recorded.context(Some("brave-test-key-1"), "")).unwrap();
        assert_eq!(Recorded::query(&recorded.urls()[1])["offset"], "1");
    }
}
