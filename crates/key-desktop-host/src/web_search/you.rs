// You.com Search API (POST https://ydc-index.io/v1/search, `X-API-Key: <key>`). Docs checked
// 2026-11-27: https://you.com/docs/api-reference/search/v1-search. `count` 1–100, `offset`
// a page index 0–9 (in multiples of count), `freshness` a range "YYYY-MM-DDtoYYYY-MM-DD",
// `language` BCP 47 style (EN, DE …), a site in include_domains. Results in `results.web[]`
// with url, title, description, snippets and page_age. Errors: 401 key, 402 no paid
// requests left, 403 scope, 422 invalid parameters.
use super::engines::{self, freshness_range, page_result, text};
use super::http::{Base, ProviderError};
use super::provider::{Capabilities, Context, Engine, Provider, SearchRequest};
use super::types::{WebPage, WebResult};
use serde_json::{Value as Json, json};

pub fn base() -> Base {
    Base::from_env("KEY_WEB_YOU_URL", "https://ydc-index.io")
}

pub fn body(query: &str, request: &SearchRequest, page: usize) -> Json {
    let f = request.filters;
    let mut body = json!({ "query": query, "count": request.limit.clamp(1, 100), "offset": page.min(9) });
    if let Some(range) = freshness_range(f) {
        body["freshness"] = json!(range);
    }
    if let Some(language) = engines::language(f) {
        body["language"] = json!(language.to_uppercase());
    }
    if let Some(site) = engines::site(f) {
        body["include_domains"] = json!([site]);
    }
    body
}

pub fn parse_page(body: &Json, page: usize, asked: usize) -> WebPage {
    let results: Vec<WebResult> = body["results"]["web"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let snippets: Vec<&str> = r["snippets"].as_array().into_iter().flatten().filter_map(Json::as_str).collect();
            let snippet = r["description"].as_str().map(String::from).or_else(|| (!snippets.is_empty()).then(|| snippets.join(" … ")));
            page_result("you", r["url"].as_str()?, text(&r["title"]), snippet.as_deref(), r["page_age"].as_str())
        })
        .collect();
    // A full page may have more after it (the API has no "more" flag).
    let more = results.len() >= asked && page < 9;
    WebPage { cursor: more.then(|| (page + 1).to_string()), results, ..Default::default() }
}

pub struct You;

impl Provider for You {
    fn id(&self) -> &'static str {
        "you"
    }
    fn label(&self) -> &'static str {
        "You.com"
    }
    fn icon(&self) -> &'static str {
        "globe"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { api_key: true, key_required: true, key_help: "With your You.com key (Services & API keys).", enabled_by_default: false, filters: &["year", "site", "language"], service: Some("you") }
    }
    fn engine(&self) -> Option<Engine> {
        Some(Engine { max_results: 100, pricing_url: "https://you.com/docs/administration/billing", ..Default::default() })
    }
    fn search(&self, query: &str, request: &SearchRequest, cx: &Context) -> Result<WebPage, ProviderError> {
        let key = engines::key(cx, "You.com")?;
        let page = request.cursor.and_then(|c| c.parse().ok()).unwrap_or(0usize);
        let answer = cx.post_json(&base(), "v1/search", &body(query, request, page), &[("x-api-key", key)], "You.com")?;
        Ok(parse_page(&answer, page, request.limit.clamp(1, 100)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::{filters::WebFilters, tests::{Recorded, fixture}};

    #[test]
    fn maps_filters_and_parses_results() {
        let f = WebFilters { year_to: Some(2015), site: Some("europa.eu".into()), language: Some("de".into()), ..Default::default() };
        let b = body("energiewende", &SearchRequest { limit: 10, cursor: None, filters: &f }, 1);
        assert_eq!((b["freshness"].as_str(), b["language"].as_str(), b["offset"].as_u64()), (Some("1900-01-01to2015-12-31"), Some("DE"), Some(1)));
        assert_eq!(b["include_domains"], json!(["europa.eu"]));
        let recorded = Recorded::new(vec![(200, fixture("you-search.json").to_string())]);
        let page = You.search("energiewende", &SearchRequest { limit: 2, cursor: None, filters: &WebFilters::default() }, &recorded.context(Some("you-test-key-1"), "")).unwrap();
        assert_eq!((page.results.len(), page.cursor.as_deref()), (2, Some("1")));
        assert_eq!(page.results[1].abstract_.as_deref(), Some("Second snippet. … Third snippet."));
        assert!(recorded.headers()[0].contains(&("x-api-key".into(), "you-test-key-1".into())));
    }
}
