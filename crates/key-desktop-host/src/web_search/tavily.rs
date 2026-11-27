// Tavily web search (POST https://api.tavily.com/search, `Authorization: Bearer <key>`).
// Docs checked 2026-11-27: https://docs.tavily.com/documentation/api-reference/endpoint/search
// and …/endpoint/usage. `basic` depth costs 1 credit per search (advanced 2, auto_parameters
// 2: neither is used). Errors: 401 key, 429 rate limit (Retry-After), 432 key/plan limit,
// 433 pay-as-you-go limit. No paging: one page of at most 20 results.
use super::engines::{self, iso_dates, page_result, text};
use super::http::{Base, ProviderError};
use super::provider::{Capabilities, Context, Engine, Provider, SearchRequest};
use super::types::{WebPage, WebResult};
use serde_json::{Value as Json, json};

pub fn base() -> Base {
    Base::from_env("KEY_WEB_TAVILY_URL", "https://api.tavily.com")
}

pub fn body(query: &str, request: &SearchRequest) -> Json {
    let f = request.filters;
    let mut body = json!({
        "query": query,
        "max_results": request.limit.clamp(1, 20),
        "search_depth": "basic",
        "topic": "general",
        "include_answer": false,
        "include_raw_content": false,
    });
    let (from, to) = iso_dates(f);
    if from.is_some() || to.is_some() {
        body["start_date"] = json!(from);
        body["end_date"] = json!(to);
        // Undated pages and those outside the years are left out, not just ranked lower.
        body["filter_by_published_date"] = json!(true);
    }
    if let Some(site) = engines::site(f) {
        body["include_domains"] = json!([site]);
    }
    if let Some(language) = engines::language(f) {
        body["language"] = json!(language);
        body["filter_by_language"] = json!(true);
    }
    body
}

pub fn parse_page(body: &Json) -> WebPage {
    let results: Vec<WebResult> = body["results"].as_array().into_iter().flatten().filter_map(|r| page_result("tavily", r["url"].as_str()?, text(&r["title"]), r["content"].as_str(), r["published_date"].as_str())).collect();
    WebPage { results, ..Default::default() }
}

pub struct Tavily;

impl Provider for Tavily {
    fn id(&self) -> &'static str {
        "tavily"
    }
    fn label(&self) -> &'static str {
        "Tavily"
    }
    fn icon(&self) -> &'static str {
        "globe"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { api_key: true, key_required: true, key_help: "With your Tavily key (Services & API keys).", enabled_by_default: false, filters: &["year", "site", "language"], service: Some("tavily") }
    }
    fn engine(&self) -> Option<Engine> {
        Some(Engine { max_results: 20, pricing_url: "https://www.tavily.com/pricing", ..Default::default() })
    }
    fn search(&self, query: &str, request: &SearchRequest, cx: &Context) -> Result<WebPage, ProviderError> {
        let key = engines::key(cx, "Tavily")?;
        // One page only: Tavily has no paging.
        if request.cursor.is_some() {
            return Ok(WebPage::default());
        }
        let auth = format!("Bearer {key}");
        let answer = cx.post_json(&base(), "search", &body(query, request), &[("authorization", &auth)], "Tavily")?;
        Ok(parse_page(&answer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::{filters::WebFilters, tests::{Recorded, fixture}};

    #[test]
    fn maps_filters_into_the_body() {
        let f = WebFilters { year_from: Some(2019), year_to: Some(2021), site: Some("nature.com".into()), language: Some("de".into()), ..Default::default() };
        let b = body("crispr", &SearchRequest { limit: 50, cursor: None, filters: &f });
        assert_eq!(b["max_results"], 20);
        assert_eq!((b["start_date"].as_str(), b["end_date"].as_str()), (Some("2019-01-01"), Some("2021-12-31")));
        assert_eq!(b["include_domains"], json!(["nature.com"]));
        assert_eq!((b["language"].as_str(), b["filter_by_language"].as_bool()), (Some("de"), Some(true)));
        assert_eq!(b["search_depth"], "basic", "one credit a search");
        let plain = body("x", &SearchRequest { limit: 5, cursor: None, filters: &WebFilters::default() });
        assert!(plain.get("start_date").is_none() && plain.get("include_domains").is_none());
    }

    #[test]
    fn parses_results_and_sends_the_key_as_a_bearer_token() {
        let recorded = Recorded::new(vec![(200, fixture("tavily-search.json").to_string())]);
        let page = Tavily.search("alphafold", &SearchRequest { limit: 10, cursor: None, filters: &WebFilters::default() }, &recorded.context(Some("tvly-test-0000"), "")).unwrap();
        assert_eq!(page.results.len(), 2);
        assert_eq!((page.results[0].provider.as_str(), page.results[0].year), ("tavily", Some(2021)));
        assert_eq!(page.results[0].landing_url.as_deref(), Some("https://www.nature.com/articles/s41586-021-03819-2"));
        assert_eq!(recorded.urls()[0].path(), "/search");
        assert!(recorded.headers()[0].contains(&("authorization".into(), "Bearer tvly-test-0000".into())));
        assert_eq!(recorded.bodies()[0]["query"], "alphafold");
    }

    #[test]
    fn says_when_a_key_is_spent_or_refused() {
        let recorded = Recorded::new(vec![(432, r#"{"detail":{"error":"usage limit"}}"#.into()), (401, "{}".into())]);
        let none = WebFilters::default();
        let ask = |r: &Recorded| Tavily.search("x", &SearchRequest { limit: 5, cursor: None, filters: &none }, &r.context(Some("tvly-test-key-9999"), "")).unwrap_err();
        let spent = ask(&recorded);
        assert_eq!((spent.status, spent.transient, spent.message.as_str()), (Some(402), false, "Tavily: this key has no credits left"));
        assert_eq!(ask(&recorded).status, Some(401));
        assert!(Tavily.search("x", &SearchRequest { limit: 5, cursor: None, filters: &none }, &recorded.context(None, "")).unwrap_err().message.contains("needs an API key"));
    }
}
