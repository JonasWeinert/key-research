// Web pages saved from the in-app browser: which library source a page is (by its
// normalised address, normalize::page_key, or its DOI) and the source fields its metadata
// fills. The browser (Electron main) only snapshots the page and hands over its metadata.
use crate::{Result, Source, Store, e, normalize};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Map, Value as Json, json};

/// What the browser read from a page (`browser/snapshot.ts`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PageMeta {
    pub title: String,
    pub url: String,
    pub canonical: Option<String>,
    pub site: Option<String>,
    pub authors: Vec<String>,
    pub date: Option<String>,
    pub doi: Option<String>,
    pub description: Option<String>,
    pub language: Option<String>,
}

/// "Doe, Jane" or "Jane Doe" as a creator; organisations (and long names) stay literal.
fn creator(name: &str) -> Json {
    let clean = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some((family, given)) = clean.split_once(',') {
        return json!({"family": family.trim(), "given": given.trim(), "role": "author"});
    }
    let parts: Vec<&str> = clean.split(' ').collect();
    if parts.len() < 2 || parts.len() > 4 {
        return json!({"literal": clean, "role": "author"});
    }
    json!({"family": parts[parts.len() - 1], "given": parts[..parts.len() - 1].join(" "), "role": "author"})
}

/// The host of a link without `www.`.
fn site_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?.split(':').next()?.to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    (!host.is_empty() && host.contains('.')).then_some(host)
}

/// A page date's day and year, when it starts with a plausible ISO date ("2024-05-01…").
fn date_of(text: &str) -> Option<(String, i64)> {
    let t = text.trim();
    let year: i64 = t.get(..4)?.parse().ok()?;
    if !(1000..=2999).contains(&year) || t.get(4..5).is_some_and(|c| c != "-") {
        return None;
    }
    Some((t.chars().take(10).collect(), year))
}

/// The source fields a page's metadata fills.
pub fn page_patch(meta: &PageMeta, captured_at: &str) -> Map<String, Json> {
    let site = meta.site.clone().filter(|s| !s.trim().is_empty()).or_else(|| site_of(&meta.url));
    let mut patch = Map::new();
    patch.insert("itemType".into(), json!("webpage"));
    let title = Some(meta.title.trim()).filter(|t| !t.is_empty()).map(String::from).or(site.clone()).unwrap_or_else(|| meta.url.clone());
    patch.insert("title".into(), json!(title));
    patch.insert("url".into(), json!(meta.url));
    patch.insert("containerTitle".into(), site.map_or(Json::Null, Json::from));
    patch.insert("accessed".into(), json!(captured_at.chars().take(10).collect::<String>()));
    patch.insert("creators".into(), Json::Array(meta.authors.iter().filter(|a| !a.trim().is_empty()).map(|a| creator(a)).collect()));
    if let Some((date, year)) = meta.date.as_deref().and_then(date_of) {
        patch.insert("date".into(), json!(date));
        patch.insert("year".into(), json!(year));
    }
    if let Some(doi) = meta.doi.as_deref().filter(|d| !d.trim().is_empty()) {
        patch.insert("doi".into(), json!(normalize::doi(doi).unwrap_or_else(|| doi.trim().to_string())));
    }
    if let Some(description) = meta.description.as_deref().filter(|d| !d.trim().is_empty()) {
        patch.insert("abstract".into(), json!(description.chars().take(4000).collect::<String>()));
    }
    if let Some(language) = meta.language.as_deref().filter(|d| !d.trim().is_empty()) {
        patch.insert("language".into(), json!(language));
    }
    patch.insert("properties".into(), json!({"webSnapshot": {"url": meta.url, "canonical": meta.canonical, "capturedAt": captured_at}}));
    patch
}

impl Store {
    /// The library's source for a web page: a web source with this address (one with a
    /// saved page first), else a source without a file that is this page by its DOI or
    /// address, for the page to be saved into.
    pub fn find_web_page(&self, url: &str, doi: Option<&str>) -> Result<Option<Source>> {
        let key = normalize::page_key(url);
        if key.is_empty() {
            return Ok(None);
        }
        let doi = doi.and_then(normalize::doi).or_else(|| key.strip_prefix("doi:").map(String::from));
        let candidates: Vec<(String, String, Option<String>, Option<String>, bool)> = {
            let db = self.read()?;
            let mut statement = db
                .prepare("SELECT id, kind, url, doi, file_path IS NOT NULL FROM sources WHERE trashed_at IS NULL AND merged_into IS NULL AND (url IS NOT NULL OR doi IS NOT NULL) ORDER BY added_at")
                .map_err(e)?;
            let rows = statement.query_map(params![], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(e)?;
            rows.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        let same_page = |u: &Option<String>| u.as_deref().is_some_and(|u| normalize::page_key(u) == key);
        let web: Vec<&(String, String, Option<String>, Option<String>, bool)> = candidates.iter().filter(|c| c.1 == "web" && same_page(&c.2)).collect();
        let pick = web.iter().find(|c| c.4).or(web.first()).map(|c| c.0.clone()).or_else(|| {
            candidates
                .iter()
                .find(|c| !c.4 && (same_page(&c.2) || (doi.is_some() && c.3.as_deref().and_then(normalize::doi) == doi)))
                .map(|c| c.0.clone())
        });
        match pick {
            Some(id) => self.source(&id),
            None => Ok(None),
        }
    }

    /// Fills source `id`, which now holds a saved page, from the page's metadata. `existing`
    /// is the source the page was saved into or found as (before the save): a reference
    /// keeps what it is and only gains the snapshot (and the address when it had none); a
    /// page saved again keeps the title and details someone may have edited.
    pub fn apply_web_page(&self, id: &str, meta: &PageMeta, captured_at: &str, existing: Option<&Source>, existing_had_file: bool) -> Result<Source> {
        let mut patch = page_patch(meta, captured_at);
        if let Some(existing) = existing.filter(|s| s.kind != "web") {
            let mut properties = existing.properties.clone();
            properties.insert("webSnapshot".into(), patch["properties"]["webSnapshot"].clone());
            let mut keep = Map::new();
            keep.insert("properties".into(), Json::Object(properties));
            if existing.field("url").is_none_or(|u| u.trim().is_empty()) {
                keep.insert("url".into(), json!(meta.url));
            }
            return self.update_source(id, &keep);
        }
        if existing_had_file && existing.is_some_and(|s| s.id == id) {
            for key in ["title", "creators", "containerTitle", "abstract"] {
                patch.remove(key);
            }
        }
        self.update_source(id, &patch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SourceInput;

    fn meta(value: Json) -> PageMeta {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn page_metadata_becomes_source_fields() {
        let patch = page_patch(&meta(json!({"title": "", "url": "https://www.example.org/a", "authors": ["Doe, Jane", "John Smith", "World Health Organization of the Americas"], "date": "2024-05-01T10:00:00Z", "doi": "https://doi.org/10.1/ABC"})), "2026-11-26T10:00:00Z");
        assert_eq!(patch["title"], json!("example.org"));
        assert_eq!(patch["containerTitle"], json!("example.org"));
        assert_eq!(patch["date"], json!("2024-05-01"));
        assert_eq!(patch["year"], json!(2024));
        assert_eq!(patch["accessed"], json!("2026-11-26"));
        assert_eq!(patch["doi"], json!("10.1/abc"));
        assert_eq!(patch["creators"][0], json!({"family": "Doe", "given": "Jane", "role": "author"}));
        assert_eq!(patch["creators"][1], json!({"family": "Smith", "given": "John", "role": "author"}));
        assert_eq!(patch["creators"][2]["literal"], json!("World Health Organization of the Americas"));
        assert!(page_patch(&meta(json!({"url": "x", "date": "yesterday"})), "2026").get("year").is_none());
    }

    #[test]
    fn finds_a_page_by_its_normalised_address_or_doi() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let add = |v: Json| store.insert_source(serde_json::from_value::<SourceInput>(v).unwrap()).unwrap().id;
        let page = add(json!({"kind": "web", "title": "Post", "url": "https://www.example.org/post/?utm_source=x"}));
        let article = add(json!({"kind": "reference", "title": "Article", "doi": "10.1/xyz"}));
        assert_eq!(store.find_web_page("http://example.org/post#top", None).unwrap().map(|s| s.id), Some(page));
        assert_eq!(store.find_web_page("https://journal.org/article/1", Some("doi:10.1/XYZ")).unwrap().map(|s| s.id), Some(article.clone()));
        assert_eq!(store.find_web_page("https://doi.org/10.1/xyz", None).unwrap().map(|s| s.id), Some(article));
        assert!(store.find_web_page("https://example.org/other", None).unwrap().is_none());
    }
}
