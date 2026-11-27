// Firecrawl: web search (POST https://api.firecrawl.dev/v2/search) and, as a reader, one
// page as clean HTML (POST /v2/scrape) for saving a page when Key's own capture fails or the
// user picks it. `Authorization: Bearer <key>`. Docs checked 2026-11-27:
// https://docs.firecrawl.dev/api-reference/endpoint/search, …/endpoint/scrape and
// …/endpoint/credit-usage. Search results come without page content (no scrapeOptions), so
// a search costs the base search credits only. Years go in `tbs` as a custom date range
// (cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY); a site in `includeDomains`; scholarly-only
// is the `research` category. Errors: 402 credits, 429 rate limit, 408 timeout, 5xx.
use super::engines::{self, page_result, text, us_dates};
use super::http::{Base, ProviderError};
use super::provider::{Capabilities, Context, Engine, Provider, ReadPage, SearchRequest};
use super::types::{WebPage, WebResult};
use serde_json::{Value as Json, json};

pub fn base() -> Base {
    Base::from_env("KEY_WEB_FIRECRAWL_URL", "https://api.firecrawl.dev")
}

pub fn body(query: &str, request: &SearchRequest, scholarly: bool) -> Json {
    let f = request.filters;
    let mut body = json!({ "query": query.chars().take(500).collect::<String>(), "limit": request.limit.clamp(1, 100), "sources": ["web"] });
    let (from, to) = us_dates(f);
    if from.is_some() || to.is_some() {
        let mut tbs = vec!["cdr:1".to_string()];
        tbs.extend(from.map(|d| format!("cd_min:{d}")));
        tbs.extend(to.map(|d| format!("cd_max:{d}")));
        body["tbs"] = json!(tbs.join(","));
    }
    if let Some(site) = engines::site(f) {
        body["includeDomains"] = json!([site]);
    }
    if scholarly {
        body["categories"] = json!(["research"]);
    }
    body
}

pub fn parse_page(body: &Json) -> WebPage {
    // v2 answers `data.web`; an older shape had the list as `data` itself.
    let list = body["data"]["web"].as_array().or(body["data"].as_array());
    let results: Vec<WebResult> = list
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let url = r["url"].as_str().or(r["metadata"]["url"].as_str())?;
            let title = text(&r["title"]).or_else(|| text(&r["metadata"]["title"]));
            let mut result = page_result("firecrawl", url, title, r["description"].as_str(), None)?;
            if r["category"].as_str() == Some("research") {
                result.kind = Some("article".into());
            }
            Some(result)
        })
        .collect();
    WebPage { results, ..Default::default() }
}

pub fn parse_scrape(body: &Json, asked: &str) -> Option<ReadPage> {
    let data = &body["data"];
    let html = text(&data["html"])?;
    let meta = &data["metadata"];
    Some(ReadPage {
        provider: "firecrawl".into(),
        url: text(&meta["url"]).or_else(|| text(&meta["sourceURL"])).unwrap_or_else(|| asked.to_string()),
        title: text(&meta["title"]),
        description: text(&meta["description"]),
        language: text(&meta["language"]),
        html,
    })
}

pub struct Firecrawl;

impl Provider for Firecrawl {
    fn id(&self) -> &'static str {
        "firecrawl"
    }
    fn label(&self) -> &'static str {
        "Firecrawl"
    }
    fn icon(&self) -> &'static str {
        "globe"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { api_key: true, key_required: true, key_help: "With your Firecrawl key (Services & API keys).", enabled_by_default: false, filters: &["year", "site"], service: Some("firecrawl") }
    }
    fn engine(&self) -> Option<Engine> {
        Some(Engine { scholarly: true, reader: true, max_results: 100, pricing_url: "https://www.firecrawl.dev/pricing", ..Default::default() })
    }
    fn search(&self, query: &str, request: &SearchRequest, cx: &Context) -> Result<WebPage, ProviderError> {
        let key = engines::key(cx, "Firecrawl")?;
        if request.cursor.is_some() {
            return Ok(WebPage::default());
        }
        let auth = format!("Bearer {key}");
        let answer = cx.post_json(&base(), "v2/search", &body(query, request, cx.scholarly), &[("authorization", &auth)], "Firecrawl")?;
        if let Some(error) = engines::refused_in_body("Firecrawl", &answer) {
            return Err(error);
        }
        Ok(parse_page(&answer))
    }
    fn read_page(&self, url: &str, cx: &Context) -> Result<ReadPage, ProviderError> {
        let key = engines::key(cx, "Firecrawl")?;
        let auth = format!("Bearer {key}");
        let request = json!({ "url": url, "formats": [{ "type": "html" }], "onlyMainContent": true, "timeout": 30000 });
        let answer = cx.post_json(&base(), "v2/scrape", &request, &[("authorization", &auth)], "Firecrawl")?;
        if let Some(error) = engines::refused_in_body("Firecrawl", &answer) {
            return Err(ProviderError { message: "Firecrawl could not read the page".into(), ..error });
        }
        parse_scrape(&answer, url).ok_or_else(|| ProviderError::new("Firecrawl found nothing to read on the page", None, false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::{filters::WebFilters, tests::{Recorded, fixture}};

    #[test]
    fn maps_years_site_and_scholarly_into_the_body() {
        let f = WebFilters { year_from: Some(2019), year_to: Some(2021), site: Some("arxiv.org".into()), ..Default::default() };
        let b = body("diffusion models", &SearchRequest { limit: 20, cursor: None, filters: &f }, true);
        assert_eq!(b["tbs"], "cdr:1,cd_min:01/01/2019,cd_max:12/31/2021");
        assert_eq!(b["includeDomains"], json!(["arxiv.org"]));
        assert_eq!(b["categories"], json!(["research"]));
        assert_eq!(b["limit"], 20);
        assert!(b.get("scrapeOptions").is_none(), "no page content: the search alone is paid for");
        let open = body("x", &SearchRequest { limit: 5, cursor: None, filters: &WebFilters { year_to: Some(2000), ..Default::default() } }, false);
        assert_eq!(open["tbs"], "cdr:1,cd_max:12/31/2000");
        assert!(open.get("categories").is_none());
    }

    #[test]
    fn parses_search_results() {
        let recorded = Recorded::new(vec![(200, fixture("firecrawl-search.json").to_string())]);
        let page = Firecrawl.search("diffusion", &SearchRequest { limit: 10, cursor: None, filters: &WebFilters::default() }, &recorded.context(Some("fc-test"), "")).unwrap();
        assert_eq!(page.results.len(), 2);
        assert_eq!((page.results[0].provider.as_str(), page.results[0].kind.as_deref()), ("firecrawl", Some("article")));
        assert_eq!(page.results[1].pdf_url.as_deref(), Some("https://arxiv.org/pdf/2006.11239.pdf"));
        assert_eq!(recorded.urls()[0].path(), "/v2/search");
        assert!(recorded.headers()[0].contains(&("authorization".into(), "Bearer fc-test".into())));
    }

    #[test]
    fn reads_a_page_as_html() {
        let recorded = Recorded::new(vec![(200, fixture("firecrawl-scrape.json").to_string()), (402, r#"{"success":false,"error":"Insufficient credits"}"#.into())]);
        let page = Firecrawl.read_page("https://example.org/post", &recorded.context(Some("fc-test"), "")).unwrap();
        assert_eq!((page.title.as_deref(), page.language.as_deref(), page.url.as_str()), (Some("A post"), Some("en"), "https://example.org/post/"));
        assert!(page.html.contains("<article>"));
        assert_eq!(recorded.bodies()[0]["formats"], json!([{ "type": "html" }]));
        let spent = Firecrawl.read_page("https://example.org/post", &recorded.context(Some("fc-test"), "")).unwrap_err();
        assert_eq!((spent.status, spent.transient), (Some(402), false));
    }

    #[test]
    fn a_failed_answer_with_status_200_is_an_error() {
        let recorded = Recorded::new(vec![(200, r#"{"success":false,"error":"something about the request"}"#.into())]);
        let err = Firecrawl.search("x", &SearchRequest { limit: 5, cursor: None, filters: &WebFilters::default() }, &recorded.context(Some("k"), "")).unwrap_err();
        assert_eq!(err.message, "Firecrawl could not run the search");
    }
}
