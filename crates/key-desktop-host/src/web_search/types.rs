// The shapes web search answers with (camelCase, as the app's shared/web-search.ts types
// them) and the text helpers every provider uses.
use serde::{Deserialize, Serialize};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ids {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openalex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s2: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arxiv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pmid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pmcid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mag: Option<String>,
}

/// One work as any provider describes it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebResult {
    #[serde(default)]
    pub provider: String,
    /// Found by this (keyed) provider in the place of the one asked, which failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_for: Option<String>,
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "loose_int")]
    pub year: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    #[serde(default, rename = "abstract", skip_serializing_if = "Option::is_none")]
    pub abstract_: Option<String>,
    /// Bare and lower-case: 10.1234/abc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(default)]
    pub ids: Ids,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "loose_int")]
    pub cited_by: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_access: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oa_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landing_url: Option<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// Years and counts as numbers, numeric strings or nothing.
fn loose_int<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    let value = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match value {
        Some(serde_json::Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Some(serde_json::Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    })
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPage {
    pub results: Vec<WebResult>,
    /// Filters the provider cannot apply, so it was not asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<Vec<String>>,
    /// Pass back to get the next page; absent at the end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
    /// The web search engine that answered (the "web" chain).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_by: Option<String>,
    /// Engines asked before it that failed, and why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed: Option<Vec<EngineFailure>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineFailure {
    pub provider: String,
    pub message: String,
}

/// A merged result: one work, found by one or more providers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebHit {
    #[serde(flatten)]
    pub work: WebResult,
    pub key: String,
    /// Every provider that found it, in the order they rank it.
    pub found_by: Vec<String>,
    /// Best rank among the providers (0 first).
    pub rank: usize,
}

pub fn bare_doi(doi: Option<&str>) -> Option<String> {
    Some(key_store::normalize::doi_or_text(doi?)).filter(|d| !d.is_empty())
}

/// Text without case, accents or tags; letters and digits only, single-spaced.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut gap = false;
    for c in text.nfkd().filter(|c| !is_combining_mark(*c)).flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    out
}

pub fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('<') {
        match rest[start..].find('>') {
            Some(end) if end > 1 => {
                out.push_str(&rest[..start]);
                rest = &rest[start + end + 1..];
            }
            _ => {
                out.push_str(&rest[..=start]);
                rest = &rest[start + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Titles compared without case, accents, markup, punctuation or spacing.
pub fn title_key(title: &str) -> String {
    fold(&strip_tags(title))
}

pub fn near_years(a: Option<i64>, b: Option<i64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() <= 1,
        _ => true,
    }
}

/// A short abstract: whole sentences up to about `max` characters.
pub fn snippet_of(text: Option<&str>, max: usize) -> Option<String> {
    let plain = strip_tags(text?).split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = plain.chars().collect();
    if chars.len() <= max {
        return Some(plain).filter(|p| !p.is_empty());
    }
    let cut: String = chars[..max].iter().collect();
    let end = [cut.rfind(". "), cut.rfind("? ")].into_iter().flatten().max();
    if let Some(end) = end.filter(|e| cut[..*e].chars().count() as f64 > max as f64 * 0.5) {
        return Some(cut[..=end].to_string());
    }
    let trimmed = match cut.rfind(char::is_whitespace) {
        Some(at) => cut[..at].trim_end().to_string(),
        None => cut,
    };
    Some(format!("{trimmed}…"))
}

/// The short id at the end of an OpenAlex URL (`https://openalex.org/W1` → `W1`).
pub fn short_id(id: Option<&str>) -> Option<String> {
    let id = id?;
    let rest = id.strip_prefix("https://").or_else(|| id.strip_prefix("http://")).and_then(|r| r.split_once('/').map(|(_, p)| p)).unwrap_or(id);
    Some(rest.to_string()).filter(|r| !r.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bares_dois_and_keys_titles() {
        assert_eq!(bare_doi(Some("https://doi.org/10.1038/ABC")).as_deref(), Some("10.1038/abc"));
        assert_eq!(bare_doi(Some("doi: 10.1/x")).as_deref(), Some("10.1/x"));
        assert_eq!(bare_doi(Some("")), None);
        assert_eq!(title_key("Attention is All you Need!"), title_key("attention is all  you need"));
        assert_eq!(title_key("Über <i>Café</i>"), "uber cafe");
    }

    #[test]
    fn cuts_abstracts_at_a_sentence() {
        let text = "First sentence here. ".repeat(30);
        let cut = snippet_of(Some(&text), 100).unwrap();
        assert!(cut.chars().count() <= 100);
        assert!(cut.ends_with('.'));
        assert_eq!(snippet_of(Some("  "), 280), None);
        assert!(snippet_of(Some(&"word ".repeat(100)), 50).unwrap().ends_with('…'));
    }

    #[test]
    fn near_years_within_one() {
        assert!(near_years(Some(2001), Some(2002)) && near_years(None, Some(1990)) && !near_years(Some(2001), Some(2004)));
    }
}
