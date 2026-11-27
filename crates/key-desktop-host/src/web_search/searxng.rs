// SearXNG, a metasearch engine the user runs (or trusts) at an address they give in Settings;
// no key. GET <address>/search?q=…&format=json. Docs checked 2026-11-27:
// https://docs.searxng.org/dev/search_api.html (q, categories, language, pageno, time_range
// day/month/year, format, safesearch; "Requesting an unset format will return a 403", so JSON
// must be enabled in the instance's settings.yml). That page does not list the answer's fields:
// `results[]` with url, title, content, publishedDate and engine, and `number_of_results`, are
// SearXNG's JSON output as it has long been. Its time ranges cannot express years, so years
// are checked on the results. Scholarly-only asks the `science` category. An address on this
// Mac is reached directly; any other must be public HTTPS (the safe client refuses the rest).
use super::engines::{self, page_result, text};
use super::http::{Base, ProviderError, is_loopback};
use super::provider::{Capabilities, Context, Engine, Provider, SearchRequest};
use super::types::{WebPage, WebResult};
use serde_json::Value as Json;

pub fn base_of(address: &str) -> Result<Base, ProviderError> {
    let url = url::Url::parse(address).map_err(|_| ProviderError::new("The SearXNG address is not a web address", None, false))?;
    let local = is_loopback(&url);
    if !local && url.scheme() != "https" {
        return Err(ProviderError::new("SearXNG must be on this Mac or at an https:// address", None, false));
    }
    Ok(Base { url: address.trim_end_matches('/').to_string(), overridden: local })
}

pub fn params(query: &str, request: &SearchRequest, page: usize, scholarly: bool) -> Vec<(String, String)> {
    let mut out = vec![("q".to_string(), query.to_string()), ("format".into(), "json".into()), ("pageno".into(), (page + 1).to_string())];
    if let Some(language) = engines::language(request.filters) {
        out.push(("language".into(), language.to_string()));
    }
    if scholarly {
        out.push(("categories".into(), "science".into()));
    }
    out
}

pub fn parse_page(body: &Json, page: usize) -> WebPage {
    let results: Vec<WebResult> = body["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| page_result("searxng", r["url"].as_str()?, text(&r["title"]), r["content"].as_str(), r["publishedDate"].as_str()))
        .collect();
    let more = !results.is_empty() && page < 20;
    WebPage { cursor: more.then(|| (page + 1).to_string()), results, ..Default::default() }
}

pub struct SearXng;

impl Provider for SearXng {
    fn id(&self) -> &'static str {
        "searxng"
    }
    fn label(&self) -> &'static str {
        "SearXNG"
    }
    fn icon(&self) -> &'static str {
        "globe"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { api_key: false, key_required: false, key_help: "Your own SearXNG instance, with JSON output turned on.", enabled_by_default: false, filters: &["language"], service: None }
    }
    fn engine(&self) -> Option<Engine> {
        Some(Engine { scholarly: true, base_url: true, max_results: 20, pricing_url: "", ..Default::default() })
    }
    fn search(&self, query: &str, request: &SearchRequest, cx: &Context) -> Result<WebPage, ProviderError> {
        let address = cx.base_url.ok_or_else(|| ProviderError::new("SearXNG needs its address (Settings › Web search engines)", None, false))?;
        let base = base_of(address)?;
        let page = request.cursor.and_then(|c| c.parse().ok()).unwrap_or(0usize);
        let owned = params(query, request, page, cx.scholarly);
        let pairs: Vec<(&str, &str)> = owned.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let answer = cx.get_json(&base, "search", &pairs, &[], "SearXNG").map_err(|e| match e.status {
            Some(403) => ProviderError::new("SearXNG refused JSON: turn on the json format in its settings.yml", Some(403), false),
            _ => e,
        })?;
        let mut out = parse_page(&answer, page);
        out.results.truncate(request.limit.max(1));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::{filters::WebFilters, tests::{Recorded, fixture}};

    #[test]
    fn asks_the_users_instance_and_pages_on() {
        let recorded = Recorded::new(vec![(200, fixture("searxng-search.json").to_string()), (403, "Forbidden".into())]);
        let f = WebFilters { language: Some("de".into()), ..Default::default() };
        let cx = recorded.context_at(None, "https://search.example.org/", true);
        let page = SearXng.search("klimawandel", &SearchRequest { limit: 10, cursor: None, filters: &f }, &cx).unwrap();
        assert_eq!((page.results.len(), page.results[0].year, page.cursor.as_deref()), (2, Some(2022), Some("1")));
        let url = &recorded.urls()[0];
        assert_eq!((url.host_str(), url.path()), (Some("search.example.org"), "/search"));
        let q = Recorded::query(url);
        assert_eq!((q["format"].as_str(), q["language"].as_str(), q["categories"].as_str(), q["pageno"].as_str()), ("json", "de", "science", "1"));
        let refused = SearXng.search("x", &SearchRequest { limit: 10, cursor: None, filters: &f }, &cx).unwrap_err();
        assert!(refused.message.contains("json format"));
    }

    #[test]
    fn takes_only_this_mac_or_public_https() {
        assert!(base_of("http://localhost:8888").unwrap().overridden);
        assert!(!base_of("https://searx.example.org").unwrap().overridden);
        assert!(base_of("http://searx.example.org").is_err());
        let recorded = Recorded::new(Vec::new());
        assert!(SearXng.search("x", &SearchRequest { limit: 10, cursor: None, filters: &WebFilters::default() }, &recorded.context(None, "")).unwrap_err().message.contains("address"));
    }
}
