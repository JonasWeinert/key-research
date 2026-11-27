// Perplexity Search API (POST https://api.perplexity.ai/search, `Authorization: Bearer <key>`):
// ranked web results, not a generated answer. Docs checked 2026-11-27:
// https://docs.perplexity.ai/api-reference/search-post. `max_results` 1–20 for web search;
// years as search_after_date_filter/search_before_date_filter in MM/DD/YYYY; a site in
// search_domain_filter; a language in search_language_filter (ISO 639-1). Errors: 400
// invalid_request, 401 invalid_api_key, 429 rate limited (not billed). No paging.
use super::engines::{self, page_result, text, us_dates};
use super::http::{Base, ProviderError};
use super::provider::{Capabilities, Context, Engine, Provider, SearchRequest};
use super::types::{WebPage, WebResult};
use serde_json::{Value as Json, json};

pub fn base() -> Base {
    Base::from_env("KEY_WEB_PERPLEXITY_URL", "https://api.perplexity.ai")
}

pub fn body(query: &str, request: &SearchRequest) -> Json {
    let f = request.filters;
    let mut body = json!({ "query": query, "max_results": request.limit.clamp(1, 20) });
    let (from, to) = us_dates(f);
    if let Some(from) = from {
        body["search_after_date_filter"] = json!(from);
    }
    if let Some(to) = to {
        body["search_before_date_filter"] = json!(to);
    }
    if let Some(site) = engines::site(f) {
        body["search_domain_filter"] = json!([site]);
    }
    if let Some(language) = engines::language(f) {
        body["search_language_filter"] = json!([language]);
    }
    body
}

pub fn parse_page(body: &Json) -> WebPage {
    let results: Vec<WebResult> = body["results"].as_array().into_iter().flatten().filter_map(|r| page_result("perplexity", r["url"].as_str()?, text(&r["title"]), r["snippet"].as_str(), r["date"].as_str())).collect();
    WebPage { results, ..Default::default() }
}

pub struct Perplexity;

impl Provider for Perplexity {
    fn id(&self) -> &'static str {
        "perplexity"
    }
    fn label(&self) -> &'static str {
        "Perplexity"
    }
    fn icon(&self) -> &'static str {
        "globe"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { api_key: true, key_required: true, key_help: "With your Perplexity API key (Services & API keys).", enabled_by_default: false, filters: &["year", "site", "language"], service: Some("perplexity") }
    }
    fn engine(&self) -> Option<Engine> {
        Some(Engine { max_results: 20, pricing_url: "https://docs.perplexity.ai/getting-started/pricing", ..Default::default() })
    }
    fn search(&self, query: &str, request: &SearchRequest, cx: &Context) -> Result<WebPage, ProviderError> {
        let key = engines::key(cx, "Perplexity")?;
        if request.cursor.is_some() {
            return Ok(WebPage::default());
        }
        let auth = format!("Bearer {key}");
        let answer = cx.post_json(&base(), "search", &body(query, request), &[("authorization", &auth)], "Perplexity")?;
        Ok(parse_page(&answer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::{filters::WebFilters, tests::{Recorded, fixture}};

    #[test]
    fn maps_filters_and_parses_results() {
        let f = WebFilters { year_from: Some(2022), site: Some("nih.gov".into()), language: Some("en".into()), ..Default::default() };
        let b = body("long covid", &SearchRequest { limit: 40, cursor: None, filters: &f });
        assert_eq!((b["max_results"].as_u64(), b["search_after_date_filter"].as_str()), (Some(20), Some("01/01/2022")));
        assert!(b.get("search_before_date_filter").is_none());
        assert_eq!((b["search_domain_filter"].clone(), b["search_language_filter"].clone()), (json!(["nih.gov"]), json!(["en"])));
        let recorded = Recorded::new(vec![(200, fixture("perplexity-search.json").to_string()), (401, r#"{"error":{"message":"bad key","type":"invalid_api_key","code":401}}"#.into())]);
        let none = WebFilters::default();
        let page = Perplexity.search("long covid", &SearchRequest { limit: 10, cursor: None, filters: &none }, &recorded.context(Some("pplx-test-key-1"), "")).unwrap();
        assert_eq!((page.results.len(), page.results[0].year), (2, Some(2023)));
        assert!(recorded.headers()[0].contains(&("authorization".into(), "Bearer pplx-test-key-1".into())));
        let refused = Perplexity.search("x", &SearchRequest { limit: 10, cursor: None, filters: &none }, &recorded.context(Some("pplx-test-key-1"), "")).unwrap_err();
        assert_eq!((refused.status, refused.message.as_str()), (Some(401), "Perplexity refused the API key"));
    }
}
