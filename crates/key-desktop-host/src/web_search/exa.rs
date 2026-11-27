// Exa search (POST https://api.exa.ai/search, `x-api-key: <key>`). Docs checked 2026-11-27:
// https://docs.exa.ai/reference/search. Years go in startPublishedDate/endPublishedDate (ISO
// date-times), a site in includeDomains, scholarly-only is `category: "publication"` ("scholarly
// publications such as research papers, preprints, and journal articles"). Only short
// highlights are asked for as contents, to keep the cost of a search low. Errors: 400 bad
// filter combination, 401/403 key, 402 out of credits, 429 rate limit, 5xx. No paging.
use super::engines::{self, iso_dates, page_result, text};
use super::http::{Base, ProviderError};
use super::provider::{Capabilities, Context, Engine, Provider, SearchRequest};
use super::types::{WebPage, WebResult};
use serde_json::{Value as Json, json};

pub fn base() -> Base {
    Base::from_env("KEY_WEB_EXA_URL", "https://api.exa.ai")
}

pub fn body(query: &str, request: &SearchRequest, scholarly: bool) -> Json {
    let f = request.filters;
    let mut body = json!({ "query": query, "type": "auto", "numResults": request.limit.clamp(1, 100), "contents": { "highlights": { "maxCharacters": 400 } } });
    let (from, to) = iso_dates(f);
    if let Some(from) = from {
        body["startPublishedDate"] = json!(format!("{from}T00:00:00.000Z"));
    }
    if let Some(to) = to {
        body["endPublishedDate"] = json!(format!("{to}T23:59:59.999Z"));
    }
    if let Some(site) = engines::site(f) {
        body["includeDomains"] = json!([site]);
    }
    if scholarly {
        body["category"] = json!("publication");
    }
    body
}

pub fn parse_page(body: &Json) -> WebPage {
    let results: Vec<WebResult> = body["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let highlights: Vec<&str> = r["highlights"].as_array().into_iter().flatten().filter_map(Json::as_str).collect();
            let snippet = if highlights.is_empty() { r["summary"].as_str().or(r["text"].as_str()).map(String::from) } else { Some(highlights.join(" … ")) };
            let mut result = page_result("exa", r["url"].as_str()?, text(&r["title"]), snippet.as_deref(), r["publishedDate"].as_str())?;
            if let Some(author) = text(&r["author"]) {
                result.authors = author.split([',', ';']).map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect();
            }
            Some(result)
        })
        .collect();
    WebPage { results, ..Default::default() }
}

pub struct Exa;

impl Provider for Exa {
    fn id(&self) -> &'static str {
        "exa"
    }
    fn label(&self) -> &'static str {
        "Exa"
    }
    fn icon(&self) -> &'static str {
        "globe"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { api_key: true, key_required: true, key_help: "With your Exa key (Services & API keys).", enabled_by_default: false, filters: &["year", "site"], service: Some("exa") }
    }
    fn engine(&self) -> Option<Engine> {
        Some(Engine { scholarly: true, max_results: 100, pricing_url: "https://exa.ai/pricing", ..Default::default() })
    }
    fn search(&self, query: &str, request: &SearchRequest, cx: &Context) -> Result<WebPage, ProviderError> {
        let key = engines::key(cx, "Exa")?;
        if request.cursor.is_some() {
            return Ok(WebPage::default());
        }
        let answer = cx.post_json(&base(), "search", &body(query, request, cx.scholarly), &[("x-api-key", key)], "Exa")?;
        Ok(parse_page(&answer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::{filters::WebFilters, tests::{Recorded, fixture}};

    #[test]
    fn maps_filters_and_scholarly_into_the_body() {
        let f = WebFilters { year_from: Some(2020), year_to: Some(2020), site: Some("biorxiv.org".into()), ..Default::default() };
        let b = body("single cell", &SearchRequest { limit: 20, cursor: None, filters: &f }, true);
        assert_eq!((b["startPublishedDate"].as_str(), b["endPublishedDate"].as_str()), (Some("2020-01-01T00:00:00.000Z"), Some("2020-12-31T23:59:59.999Z")));
        assert_eq!((b["includeDomains"].clone(), b["category"].as_str(), b["numResults"].as_u64()), (json!(["biorxiv.org"]), Some("publication"), Some(20)));
        assert!(body("x", &SearchRequest { limit: 5, cursor: None, filters: &WebFilters::default() }, false).get("category").is_none());
    }

    #[test]
    fn parses_results_with_highlights_and_authors() {
        let recorded = Recorded::new(vec![(200, fixture("exa-search.json").to_string()), (402, r#"{"requestId":"x","error":"No credits","tag":"NO_MORE_CREDITS"}"#.into())]);
        let none = WebFilters::default();
        let page = Exa.search("single cell", &SearchRequest { limit: 10, cursor: None, filters: &none }, &recorded.context(Some("exa-test-key-1234"), "")).unwrap();
        assert_eq!(page.results.len(), 2);
        let first = &page.results[0];
        assert_eq!((first.year, first.authors.len(), first.abstract_.as_deref().map(|a| a.contains("…"))), (Some(2023), 2, Some(true)));
        assert!(recorded.headers()[0].contains(&("x-api-key".into(), "exa-test-key-1234".into())));
        let spent = Exa.search("x", &SearchRequest { limit: 10, cursor: None, filters: &none }, &recorded.context(Some("exa-test-key-1234"), "")).unwrap_err();
        assert_eq!((spent.status, spent.message.as_str()), (Some(402), "Exa: this key has no credits left"));
    }
}
