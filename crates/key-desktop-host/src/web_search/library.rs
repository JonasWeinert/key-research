// The library side of web search: which works the library already has, and "Add to library"
// (a reference with every detail the provider gave), for search results, the readers' cited
// works and the in-app browser's article pages alike.
use super::types::{WebResult, bare_doi, near_years, title_key};
use serde::Deserialize;
use serde_json::{Map, Value as Json, json};

/// A library source as `store_sources` lists it (the fields matching needs).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "year")]
    pub year: Option<i64>,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub arxiv_id: Option<String>,
    #[serde(default)]
    pub openalex_id: Option<String>,
}

fn year<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    Ok(match Option::<Json>::deserialize(d)? {
        Some(Json::Number(n)) => n.as_i64(),
        Some(Json::String(s)) => s.trim().get(..4).and_then(|y| y.parse().ok()),
        _ => None,
    })
}

/// What a work is asked about (search hits, readers' cited works).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default, deserialize_with = "year")]
    pub year: Option<i64>,
    #[serde(default)]
    pub ids: super::types::Ids,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub first_author: Option<String>,
}

impl From<&WebResult> for Asked {
    fn from(w: &WebResult) -> Self {
        Self { key: "work".into(), doi: w.doi.clone(), title: w.title.clone(), year: w.year, ids: w.ids.clone(), url: w.landing_url.clone(), first_author: w.authors.first().cloned() }
    }
}

impl Asked {
    /// As the store's matcher asks it.
    pub fn query(&self) -> Json {
        json!({
            "key": self.key, "doi": self.doi, "url": self.url, "title": self.title, "year": self.year, "firstAuthor": self.first_author,
            "arxiv": self.ids.arxiv, "pmid": self.ids.pmid, "pmcid": self.ids.pmcid, "openalex": self.ids.openalex,
        })
    }
}

/// Which of these works the library has: key -> source id, through the store's matcher when
/// there is one. `certain_only` leaves out title matches ("possibly in library"), which never
/// stop a work from being added.
pub fn existing(library: &dyn super::Library, works: &[Asked], certain_only: bool) -> Map<String, Json> {
    let queries: Vec<Json> = works.iter().take(500).map(Asked::query).collect();
    match library.match_works(&queries) {
        Some(hits) => hits
            .into_iter()
            .filter(|h| !certain_only || h["certain"].as_bool().unwrap_or(false))
            .filter_map(|h| Some((h["key"].as_str()?.to_string(), h["sourceId"].clone())))
            .collect(),
        None => find_existing(works, &|text| library.find(text)),
    }
}

/// "Ashish Vaswani" → given Ashish, family Vaswani; a single word stays as written.
pub fn creator_of(name: &str) -> Json {
    let parts: Vec<&str> = name.split_whitespace().collect();
    match parts.split_last() {
        Some((family, given)) if !given.is_empty() => json!({ "given": given.join(" "), "family": family, "role": "author" }),
        _ => json!({ "literal": name.trim(), "role": "author" }),
    }
}

fn item_type(kind: Option<&str>) -> &'static str {
    match kind.unwrap_or("") {
        "preprint" | "posted-content" => "preprint",
        "book" | "monograph" => "book",
        "book-chapter" => "chapter",
        "proceedings-article" => "conference-paper",
        "dissertation" => "thesis",
        "report" => "report",
        "dataset" => "dataset",
        _ => "article",
    }
}

/// A web result as a library source: a reference with every detail the provider gave.
pub fn source_input(work: &WebResult, collection: Option<&str>) -> Json {
    let mut fields = Map::new();
    let mut put = |key: &str, value: Json| {
        let empty = value.is_null() || value.as_str().is_some_and(str::is_empty);
        if !empty {
            fields.insert(key.into(), value);
        }
    };
    put("kind", json!("reference"));
    put("itemType", json!(item_type(work.kind.as_deref())));
    put("title", json!(work.title));
    put("creators", Json::Array(work.authors.iter().take(100).map(|a| creator_of(a)).collect()));
    put("year", json!(work.year));
    put("containerTitle", json!(work.venue));
    put("doi", json!(work.doi));
    put("url", json!(work.landing_url));
    put("abstract", json!(work.abstract_));
    put("pmid", json!(work.ids.pmid));
    put("pmcid", json!(work.ids.pmcid));
    put("arxivId", json!(work.ids.arxiv));
    put("openalexId", json!(work.ids.openalex));
    put("oaUrl", json!(work.pdf_url));
    put("oaStatus", json!(work.oa_status));
    put("citedByCount", json!(work.cited_by));
    put("collections", json!(collection.into_iter().collect::<Vec<_>>()));
    put("indexStatus", json!("skipped"));
    Json::Object(fields)
}

/// The library source that is this work: same DOI, arXiv or OpenAlex id, else the same title within a year.
pub fn match_source<'a>(work: &Asked, sources: &'a [Stored]) -> Option<&'a Stored> {
    let doi = bare_doi(work.doi.as_deref());
    let arxiv = work.ids.arxiv.as_ref().map(|a| a.to_lowercase());
    let by_id = sources.iter().find(|s| {
        (doi.is_some() && bare_doi(s.doi.as_deref()) == doi)
            || (arxiv.is_some() && s.arxiv_id.as_ref().map(|a| a.to_lowercase()) == arxiv)
            || (work.ids.openalex.is_some() && s.openalex_id == work.ids.openalex)
    });
    if by_id.is_some() {
        return by_id;
    }
    let title = title_key(&work.title);
    sources.iter().find(|s| {
        let disagree = doi.is_some() && s.doi.is_some() && bare_doi(s.doi.as_deref()) != doi;
        !disagree && s.title.as_deref().is_some_and(|t| title_key(t) == title) && near_years(work.year, s.year)
    })
}

/// Which of these works the library already has: key → source id. `find` lists sources
/// matching a text (the library's own search).
pub fn find_existing(works: &[Asked], find: &dyn Fn(&str) -> Vec<Stored>) -> Map<String, Json> {
    let mut out = Map::new();
    for work in works.iter().take(100) {
        let doi = bare_doi(work.doi.as_deref());
        let mut found = doi.as_deref().and_then(|d| match_source(work, &find(d)).map(|s| s.id.clone()));
        if found.is_none() {
            if let Some(arxiv) = &work.ids.arxiv {
                found = match_source(work, &find(arxiv)).map(|s| s.id.clone());
            }
        }
        if found.is_none() && !work.title.trim().is_empty() {
            let text: String = work.title.chars().take(200).collect();
            found = match_source(work, &find(&text)).map(|s| s.id.clone());
        }
        if let Some(id) = found {
            out.insert(work.key.clone(), json!(id));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::tests::fixture;
    use crate::backend::web_search::{merge, semantic_scholar};

    #[test]
    fn makes_a_full_reference_from_a_result() {
        let bert = semantic_scholar::parse_page(&fixture("s2-search.json")).results[1].clone();
        let hit = merge::merge(&[merge::ProviderList { provider: "s2".into(), results: vec![bert] }]).remove(0).work;
        let input = source_input(&hit, Some("c1"));
        assert_eq!(input["kind"], "reference");
        assert_eq!(input["itemType"], "article");
        assert_eq!(input["title"], hit.title.as_str());
        assert_eq!(input["creators"][0], json!({ "given": "Jacob", "family": "Devlin", "role": "author" }));
        assert_eq!((input["year"].as_i64(), input["doi"].as_str()), (Some(2019), Some("10.18653/v1/n19-1423")));
        assert_eq!((input["arxivId"].as_str(), input["oaUrl"].as_str()), (Some("1810.04805"), Some("https://aclanthology.org/N19-1423.pdf")));
        assert_eq!(input["collections"], json!(["c1"]));
        assert_eq!(creator_of("Plato"), json!({ "literal": "Plato", "role": "author" }));
    }

    #[test]
    fn recognises_a_work_already_in_the_library() {
        let sources = vec![
            Stored { id: "s1".into(), title: Some("Something else".into()), doi: Some("https://doi.org/10.1/X".into()), ..Default::default() },
            Stored { id: "s2".into(), title: Some("Attention is all you need.".into()), year: Some(2017), ..Default::default() },
        ];
        let asked = |title: &str, doi: Option<&str>, year: Option<i64>| Asked { title: title.into(), doi: doi.map(String::from), year, ..Default::default() };
        assert_eq!(match_source(&asked("Whatever", Some("10.1/x"), None), &sources).map(|s| s.id.as_str()), Some("s1"));
        assert_eq!(match_source(&asked("Attention Is All You Need", None, Some(2018)), &sources).map(|s| s.id.as_str()), Some("s2"));
        assert!(match_source(&asked("Attention Is All You Need", None, Some(2012)), &sources).is_none());
        assert!(match_source(&asked("Something else", Some("10.1/y"), None), &sources).is_none());
    }
}
