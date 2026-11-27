// Jina: Search (GET https://s.jina.ai/?q=…) and, as a reader, Jina Reader
// (GET https://r.jina.ai/<page address>), both with `Authorization: Bearer <key>` and
// `Accept: application/json` (answers `{ code, status, data }`). Docs checked 2026-11-27:
// https://jina.ai/reader/, https://github.com/jina-ai/reader (README) and https://r.jina.ai/docs.
// A site narrows the search with the `site` parameter. The reader is asked for HTML with
// `x-respond-with: html`. Search needs a key (blocked without one); a search costs a fixed
// number of tokens (from about 10,000), reading a page the tokens of its text. No paging.
use super::engines::{self, page_result, text};
use super::http::{Base, ProviderError};
use super::provider::{Capabilities, Context, Engine, Provider, ReadPage, SearchRequest};
use super::types::{WebPage, WebResult};
use serde_json::Value as Json;

pub fn search_base() -> Base {
    Base::from_env("KEY_WEB_JINA_URL", "https://s.jina.ai")
}
pub fn reader_base() -> Base {
    Base::from_env("KEY_WEB_JINA_READER_URL", "https://r.jina.ai")
}

pub fn parse_page(body: &Json) -> WebPage {
    let results: Vec<WebResult> = body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| page_result("jina", r["url"].as_str()?, text(&r["title"]), r["description"].as_str().or(r["content"].as_str()), r["publishedTime"].as_str()))
        .collect();
    WebPage { results, ..Default::default() }
}

pub fn parse_read(body: &Json, asked: &str) -> Option<ReadPage> {
    let data = &body["data"];
    Some(ReadPage { provider: "jina".into(), url: text(&data["url"]).unwrap_or_else(|| asked.to_string()), title: text(&data["title"]), description: text(&data["description"]), language: None, html: text(&data["content"])? })
}

fn failed_in_body(body: &Json) -> bool {
    body["code"].as_i64().is_some_and(|c| c >= 400)
}

pub struct Jina;

impl Provider for Jina {
    fn id(&self) -> &'static str {
        "jina"
    }
    fn label(&self) -> &'static str {
        "Jina"
    }
    fn icon(&self) -> &'static str {
        "globe"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { api_key: true, key_required: true, key_help: "With your Jina key (Services & API keys).", enabled_by_default: false, filters: &["site"], service: Some("jina") }
    }
    fn engine(&self) -> Option<Engine> {
        Some(Engine { reader: true, max_results: 10, pricing_url: "https://jina.ai/reader/#pricing", ..Default::default() })
    }
    fn search(&self, query: &str, request: &SearchRequest, cx: &Context) -> Result<WebPage, ProviderError> {
        let key = engines::key(cx, "Jina")?;
        if request.cursor.is_some() {
            return Ok(WebPage::default());
        }
        let mut params = vec![("q", query)];
        if let Some(site) = engines::site(request.filters) {
            params.push(("site", site));
        }
        let auth = format!("Bearer {key}");
        let answer = cx.get_json(&search_base(), "", &params, &[("authorization", &auth)], "Jina")?;
        if failed_in_body(&answer) {
            return Err(ProviderError::new("Jina could not run the search", None, false));
        }
        let mut page = parse_page(&answer);
        page.results.truncate(request.limit.max(1));
        Ok(page)
    }
    fn read_page(&self, url: &str, cx: &Context) -> Result<ReadPage, ProviderError> {
        let key = engines::key(cx, "Jina")?;
        let auth = format!("Bearer {key}");
        let answer = cx.get_json(&reader_base(), url, &[], &[("authorization", &auth), ("x-respond-with", "html")], "Jina Reader")?;
        if failed_in_body(&answer) {
            return Err(ProviderError::new("Jina Reader could not read the page", None, false));
        }
        parse_read(&answer, url).ok_or_else(|| ProviderError::new("Jina Reader found nothing to read on the page", None, false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::{filters::WebFilters, tests::{Recorded, fixture}};

    #[test]
    fn searches_with_a_site_and_reads_a_page() {
        let recorded = Recorded::new(vec![(200, fixture("jina-search.json").to_string()), (200, fixture("jina-read.json").to_string())]);
        let f = WebFilters { site: Some("jina.ai".into()), ..Default::default() };
        let page = Jina.search("reader api", &SearchRequest { limit: 1, cursor: None, filters: &f }, &recorded.context(Some("jina_test_key_1"), "")).unwrap();
        assert_eq!((page.results.len(), page.results[0].year), (1, Some(2024)));
        let q = Recorded::query(&recorded.urls()[0]);
        assert_eq!((q["q"].as_str(), q["site"].as_str()), ("reader api", "jina.ai"));
        assert!(recorded.headers()[0].contains(&("authorization".into(), "Bearer jina_test_key_1".into())));
        let read = Jina.read_page("https://example.org/post", &recorded.context(Some("jina_test_key_1"), "")).unwrap();
        assert_eq!((read.provider.as_str(), read.title.as_deref()), ("jina", Some("A post")));
        assert_eq!(recorded.urls()[1].as_str(), "https://r.jina.ai/https://example.org/post");
        assert!(recorded.headers()[1].contains(&("x-respond-with".into(), "html".into())));
    }

    #[test]
    fn an_error_code_in_the_body_is_an_error() {
        let recorded = Recorded::new(vec![(200, r#"{"code":402,"status":40203,"message":"Insufficient balance"}"#.into())]);
        assert!(Jina.search("x", &SearchRequest { limit: 5, cursor: None, filters: &WebFilters::default() }, &recorded.context(Some("jina_test_key_1"), "")).is_err());
    }
}
