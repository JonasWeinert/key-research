// What the general web search engines (tavily.rs, firecrawl.rs, exa.rs, brave.rs …) share:
// a found page as a `WebResult`, Key's filters as dates and a site, and the key check. Each
// engine is one file next to this one, implements `Provider` with `engine()`, and is added to
// `providers()` in mod.rs; Settings lists it under Web search engines, where the user turns it
// on, orders it and gives its key under Services & API keys.
use super::filters::WebFilters;
use super::http::ProviderError;
use super::provider::Context;
use super::scholar_serpapi::doi_in;
use super::types::{WebResult, snippet_of};
use serde_json::Value as Json;

pub fn text(value: &Json) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// The year of an ISO date or date-time ("2024-05-01", "2024-05-01T00:00:00Z").
pub fn year_of(date: Option<&str>) -> Option<i64> {
    let date = date?.trim();
    let year = date.get(..4)?;
    year.bytes().all(|b| b.is_ascii_digit()).then(|| year.parse().ok()).flatten().filter(|y| (1500..2100).contains(y))
}

/// One page an engine found.
pub fn page_result(provider: &str, url: &str, title: Option<String>, snippet: Option<&str>, date: Option<&str>) -> Option<WebResult> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return None;
    }
    let title = title.unwrap_or_else(|| url.to_string());
    Some(WebResult {
        provider: provider.into(),
        provider_id: url.into(),
        title,
        year: year_of(date),
        abstract_: snippet_of(snippet, 600),
        doi: doi_in(url),
        landing_url: Some(url.into()),
        pdf_url: url.to_lowercase().split(['?', '#']).next().is_some_and(|p| p.ends_with(".pdf")).then(|| url.to_string()),
        kind: Some("webpage".into()),
        ..WebResult::default()
    })
}

/// The year filter as the first and last day: ("2019-01-01", "2021-12-31").
pub fn iso_dates(filters: &WebFilters) -> (Option<String>, Option<String>) {
    (filters.year_from.map(|y| format!("{y:04}-01-01")), filters.year_to.map(|y| format!("{y:04}-12-31")))
}

/// The year filter as US dates: ("01/01/2019", "12/31/2021") (Firecrawl's tbs, Perplexity).
pub fn us_dates(filters: &WebFilters) -> (Option<String>, Option<String>) {
    (filters.year_from.map(|y| format!("01/01/{y:04}")), filters.year_to.map(|y| format!("12/31/{y:04}")))
}

/// "2019-01-01to2021-12-31" (Brave's and You.com's freshness); an open end is today or 1900.
pub fn freshness_range(filters: &WebFilters) -> Option<String> {
    if filters.year_from.is_none() && filters.year_to.is_none() {
        return None;
    }
    let from = filters.year_from.map_or("1900-01-01".to_string(), |y| format!("{y:04}-01-01"));
    let to = filters.year_to.map_or_else(|| format!("{}-12-31", current_year()), |y| format!("{y:04}-12-31"));
    Some(format!("{from}to{to}"))
}

pub fn current_year() -> i64 {
    let days = key_store::now_ms() / 86_400_000;
    // Close enough for an open-ended range: the year this day falls in.
    1970 + (days as f64 / 365.2425) as i64
}

pub fn site(filters: &WebFilters) -> Option<&str> {
    filters.site.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

pub fn language(filters: &WebFilters) -> Option<&str> {
    filters.language.as_deref().map(str::trim).filter(|s| s.len() == 2)
}

/// The key an engine needs, or why it cannot search.
pub fn key<'a>(cx: &Context<'a>, label: &str) -> Result<&'a str, ProviderError> {
    cx.api_key.ok_or_else(|| ProviderError::new(format!("{label} needs an API key (Settings → Services & API keys)"), Some(401), false))
}

/// An answer of 200 that says it failed (`success: false`, an `error`): in words for the user,
/// never quoting the body (it may repeat the request).
pub fn refused_in_body(label: &str, body: &Json) -> Option<ProviderError> {
    let failed = body["success"] == Json::Bool(false) || body.get("error").is_some_and(|e| !e.is_null());
    failed.then(|| ProviderError::new(format!("{label} could not run the search"), None, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_years_to_each_date_format() {
        let f = WebFilters { year_from: Some(2019), year_to: Some(2021), ..Default::default() };
        assert_eq!(iso_dates(&f), (Some("2019-01-01".into()), Some("2021-12-31".into())));
        assert_eq!(us_dates(&f), (Some("01/01/2019".into()), Some("12/31/2021".into())));
        assert_eq!(freshness_range(&f).as_deref(), Some("2019-01-01to2021-12-31"));
        assert!(freshness_range(&WebFilters { year_from: Some(2020), ..Default::default() }).unwrap().starts_with("2020-01-01to20"));
        assert_eq!(freshness_range(&WebFilters::default()), None);
        assert_eq!(year_of(Some("2024-05-01T00:00:00Z")), Some(2024));
        assert_eq!(year_of(Some("May 2024")), None);
    }

    #[test]
    fn a_page_is_a_web_result() {
        let r = page_result("tavily", "https://doi.org/10.1038/S41586-021-03819-2", Some("Highly accurate".into()), Some("AlphaFold"), Some("2021-07-15")).unwrap();
        assert_eq!((r.kind.as_deref(), r.year, r.doi.as_deref()), (Some("webpage"), Some(2021), Some("10.1038/s41586-021-03819-2")));
        assert!(page_result("x", "javascript:alert(1)", None, None, None).is_none());
        assert_eq!(page_result("x", "https://a.org/paper.PDF?dl=1", None, None, None).unwrap().pdf_url.as_deref(), Some("https://a.org/paper.PDF?dl=1"));
    }
}
