// Google Scholar through SerpApi's `google_scholar` engine (serpapi.com/search.json). Google
// Scholar itself has no API and must not be scraped; SerpApi is a paid third party that runs
// the search with the user's own key (Settings → Services & API keys). Off unless the user
// turns it on, or used as the fallback when the other catalogues fail or find nothing.
// Another Scholar API (ScraperAPI, Serper …) would be one more file like this one.
use super::http::{Base, ProviderError, redact};
use super::provider::{Capabilities, Context, Provider, SearchRequest};
use super::types::{WebPage, WebResult, snippet_of};
use serde_json::Value as Json;

pub fn base() -> Base {
    Base::from_env("KEY_WEB_SERPAPI_URL", "https://serpapi.com")
}

fn text(value: &Json) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// The first year 1500–2099 standing alone in `text`, with where it starts.
fn year_in(text: &str) -> Option<(usize, i64)> {
    let bytes = text.as_bytes();
    for at in 0..bytes.len().saturating_sub(3) {
        let word = &bytes[at..at + 4];
        let alone = (at == 0 || !bytes[at - 1].is_ascii_alphanumeric()) && bytes.get(at + 4).is_none_or(|b| !b.is_ascii_alphanumeric());
        let year = word.iter().all(u8::is_ascii_digit) && ((word[0] == b'1' && word[1] >= b'5') || (word[0] == b'2' && word[1] == b'0'));
        if alone && year {
            return Some((at, std::str::from_utf8(word).ok()?.parse().ok()?));
        }
    }
    None
}

/// "A Vaswani, N Shazeer… - Advances in neural …, 2017 - proceedings.neurips.cc".
pub fn parse_summary(summary: Option<&str>) -> (Vec<String>, Option<i64>, Option<String>) {
    let parts: Vec<&str> = summary.unwrap_or("").split(" - ").map(str::trim).collect();
    let authors = parts
        .first()
        .unwrap_or(&"")
        .split(',')
        .map(|a| a.replace('…', "").replace("...", "").trim().to_string())
        .filter(|a| !a.is_empty() && !(a.len() == 4 && a.bytes().all(|b| b.is_ascii_digit())))
        .collect();
    let looks_like_host = |p: &str| p.rsplit_once('.').is_some_and(|(_, tld)| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()));
    let middle = match parts.len() {
        n if n > 2 => parts[1],
        2 if !looks_like_host(parts[1]) => parts[1],
        _ => "",
    };
    let year = year_in(middle);
    let venue = match year {
        // The year at the end, with its comma, is not part of the venue.
        Some((at, _)) if middle[at + 4..].trim().is_empty() => middle[..at].trim_end().trim_end_matches(',').trim_end(),
        _ => middle,
    };
    let venue = venue.trim_end_matches('…').trim();
    (authors, year.map(|(_, y)| y), Some(venue.to_string()).filter(|v| !v.is_empty()))
}

/// The first DOI in a link (10.xxxx/…), lower-case.
fn doi_in(link: &str) -> Option<String> {
    let mut from = 0;
    while let Some(found) = link[from..].find("10.") {
        let at = from + found;
        from = at + 3;
        if at > 0 && link.as_bytes()[at - 1].is_ascii_alphanumeric() {
            continue;
        }
        let Some((prefix, suffix)) = link[at..].split_once('/') else { continue };
        let digits = &prefix[3..];
        if !(4..=9).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let suffix: String = suffix.chars().take_while(|c| !c.is_whitespace() && *c != '?' && *c != '#').collect();
        if !suffix.is_empty() {
            return Some(format!("{prefix}/{suffix}").to_lowercase());
        }
    }
    None
}

pub fn parse_result(item: &Json) -> Option<WebResult> {
    let title = text(&item["title"])?;
    let (summary_authors, year, venue) = parse_summary(item["publication_info"]["summary"].as_str());
    let named: Vec<String> = item["publication_info"]["authors"].as_array().into_iter().flatten().filter_map(|a| text(&a["name"])).collect();
    let pdf = item["resources"].as_array().into_iter().flatten().find(|r| r["file_format"].as_str().is_some_and(|f| f.eq_ignore_ascii_case("pdf"))).and_then(|r| text(&r["link"]));
    let link = text(&item["link"]);
    Some(WebResult {
        provider: "scholar".into(),
        provider_id: text(&item["result_id"]).unwrap_or_else(|| title.clone()),
        title,
        authors: if named.len() >= summary_authors.len() { named } else { summary_authors },
        year,
        venue,
        abstract_: snippet_of(item["snippet"].as_str(), 600),
        doi: link.as_deref().and_then(doi_in),
        cited_by: item["inline_links"]["cited_by"]["total"].as_i64(),
        open_access: pdf.as_ref().map(|_| true),
        pdf_url: pdf,
        landing_url: link,
        kind: (item["type"].as_str() == Some("Book")).then(|| "book".into()),
        ..WebResult::default()
    })
}

pub fn parse_page(body: &Json, start: usize) -> WebPage {
    let results: Vec<WebResult> = body["organic_results"].as_array().into_iter().flatten().filter_map(parse_result).collect();
    let more = text(&body["serpapi_pagination"]["next"]).is_some() && !results.is_empty();
    WebPage { cursor: more.then(|| (start + results.len()).to_string()), total: body["search_information"]["total_results"].as_i64(), results, skipped: None }
}

pub struct ScholarSerpApi;

impl Provider for ScholarSerpApi {
    fn id(&self) -> &'static str {
        "scholar"
    }
    fn label(&self) -> &'static str {
        "Google Scholar"
    }
    fn icon(&self) -> &'static str {
        "search"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            api_key: true,
            key_required: true,
            key_help: "Through SerpApi, with your SerpApi key (Services & API keys).",
            enabled_by_default: false,
            filters: &["year"],
            service: Some("scholar-serpapi"),
        }
    }
    fn search(&self, query: &str, request: &SearchRequest, cx: &Context) -> Result<WebPage, ProviderError> {
        let Some(key) = cx.api_key else { return Err(ProviderError::new("Google Scholar needs a SerpApi key", Some(401), false)) };
        let start = request.cursor.and_then(|c| c.parse().ok()).unwrap_or(0usize);
        let (num, from) = (request.limit.min(20).to_string(), start.to_string());
        let (low, high) = (request.filters.year_from.map(|y| y.to_string()), request.filters.year_to.map(|y| y.to_string()));
        let mut params: Vec<(&str, &str)> = vec![("engine", "google_scholar"), ("q", query), ("num", &num), ("start", &from), ("api_key", key)];
        if let Some(low) = &low {
            params.push(("as_ylo", low));
        }
        if let Some(high) = &high {
            params.push(("as_yhi", high));
        }
        let body = cx.get_json(&base(), "search.json", &params, &[], "SerpApi").map_err(|e| ProviderError { message: redact(&e.message, Some(key)), ..e })?;
        // SerpApi answers 200 with an error for some failures (quota, bad key).
        if let Some(error) = body["error"].as_str() {
            let lower = error.to_lowercase();
            if lower.contains("any results") {
                return Ok(WebPage::default());
            }
            let invalid = lower.contains("invalid api key");
            let spent = lower.contains("run out") || lower.contains("limit");
            let message = if spent { "SerpApi: this key has no searches left" } else if invalid { "SerpApi refused the API key" } else { "SerpApi could not run the search" };
            return Err(ProviderError::new(message, if invalid { Some(401) } else if spent { Some(429) } else { None }, false));
        }
        Ok(parse_page(&body, start))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::tests::fixture;

    #[test]
    fn parses_results() {
        let (authors, year, venue) = parse_summary(Some("A Vaswani, N Shazeer, N Parmar… - Advances in neural …, 2017 - proceedings.neurips.cc"));
        assert_eq!((authors, year, venue.as_deref()), (vec!["A Vaswani".to_string(), "N Shazeer".into(), "N Parmar".into()], Some(2017), Some("Advances in neural")));
        let page = parse_page(&fixture("serpapi-scholar.json"), 0);
        assert_eq!(page.results.len(), 2);
        let first = &page.results[0];
        assert_eq!((first.provider.as_str(), first.title.as_str(), first.year, first.cited_by), ("scholar", "Attention is all you need", Some(2017), Some(150000)));
        assert_eq!(first.pdf_url.as_deref(), Some("https://arxiv.org/pdf/1706.03762"));
        assert_eq!(page.cursor.as_deref(), Some("2"));
        assert_eq!(doi_in("https://doi.org/10.1038/S41586-021-03819-2?x=1").as_deref(), Some("10.1038/s41586-021-03819-2"));
    }
}
