// "Update metadata…": what OpenAlex (or Crossref) says about a source now, compared field
// by field with what the library holds. The host fetches; this module maps the records to
// Key's fields and builds the proposal. Fields the user edited by hand are proposed but not
// selected, and nothing is written until the user applies a proposal (journaled, so it can
// be undone). Also notices when a preprint has been published since.
use crate::duplicates::{is_preprint_doi, normalize_arxiv};
use crate::graph::{name_key, split_name};
use crate::journal::{self, Operation, field_label};
use crate::{Creator, Result, Source, Store, abstract_text, now_ms, patch_source_row, refresh_fts, sync_graph};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    pub field: String,
    pub label: String,
    pub old: Json,
    pub new: Json,
    /// The user set this field by hand: shown, not selected.
    pub edited: bool,
    pub selected: bool,
}

/// The published version of a preprint, as the lookup found it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub doi: String,
    pub title: Option<String>,
    pub venue: Option<String>,
    pub year: Option<i64>,
    /// The library source it already is, if any.
    pub source_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshProposal {
    pub id: String,
    pub title: String,
    /// openalex | crossref
    pub via: Option<String>,
    pub changes: Vec<FieldChange>,
    pub published: Option<Published>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshApply {
    pub id: String,
    /// camelCase field → new value, only the ones the user kept selected.
    pub fields: Map<String, Json>,
}

fn text(value: &Json, key: &str) -> Option<String> {
    value.get(key).and_then(Json::as_str).map(str::trim).filter(|v| !v.is_empty()).map(String::from)
}

fn bare_doi(doi: &str) -> String {
    let doi = doi.trim().to_ascii_lowercase();
    ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "doi:"].iter().find_map(|p| doi.strip_prefix(p).map(String::from)).unwrap_or(doi)
}

fn item_type(openalex: &str) -> Option<&'static str> {
    Some(match openalex {
        "article" | "journal-article" => "article",
        "book" | "monograph" | "edited-book" => "book",
        "book-chapter" => "chapter",
        "preprint" | "posted-content" => "preprint",
        "dissertation" => "thesis",
        "report" => "report",
        "dataset" => "dataset",
        "proceedings-article" => "conference-paper",
        _ => return None,
    })
}

fn creators(names: impl Iterator<Item = (Option<String>, Option<String>, Option<String>)>) -> Json {
    let list: Vec<Creator> = names
        .map(|(family, given, literal)| match (family, given, literal) {
            (None, None, Some(name)) => {
                let (family, given) = split_name(&name);
                Creator { family, given, literal: None, role: "author".into(), person_id: None }
            }
            (family, given, literal) => Creator { family, given, literal, role: "author".into(), person_id: None },
        })
        .collect();
    if list.is_empty() { Json::Null } else { serde_json::to_value(list).unwrap_or(Json::Null) }
}

/// Key's fields from an OpenAlex work.
pub fn openalex_fields(work: &Json) -> Map<String, Json> {
    let mut out = Map::new();
    let mut put = |k: &str, v: Option<Json>| {
        if let Some(v) = v.filter(|v| !v.is_null() && v.as_str().is_none_or(|s| !s.trim().is_empty())) {
            out.insert(k.into(), v);
        }
    };
    let venue = work.get("primary_location").and_then(|l| l.get("source")).filter(|s| s.is_object());
    let biblio = work.get("biblio");
    let ids = work.get("ids");
    put("title", text(work, "display_name").or_else(|| text(work, "title")).map(Json::from));
    put("year", work.get("publication_year").and_then(Json::as_i64).map(Json::from));
    put("date", text(work, "publication_date").map(Json::from));
    put("containerTitle", venue.and_then(|v| text(v, "display_name")).map(Json::from));
    put("issn", venue.and_then(|v| text(v, "issn_l")).map(Json::from));
    put("publisher", venue.and_then(|v| text(v, "host_organization_name")).map(Json::from));
    put("volume", biblio.and_then(|b| text(b, "volume")).map(Json::from));
    put("issue", biblio.and_then(|b| text(b, "issue")).map(Json::from));
    put(
        "pages",
        biblio.and_then(|b| match (text(b, "first_page"), text(b, "last_page")) {
            (Some(first), Some(last)) if first != last => Some(format!("{first}–{last}")),
            (first, last) => first.or(last),
        }).map(Json::from),
    );
    put("doi", text(work, "doi").map(|d| Json::from(bare_doi(&d))));
    put("pmid", ids.and_then(|i| text(i, "pmid")).map(|p| Json::from(p.rsplit('/').next().unwrap_or("").to_string())));
    put("pmcid", ids.and_then(|i| text(i, "pmcid")).map(|p| { let id = p.rsplit('/').next().unwrap_or("").to_string(); Json::from(if id.starts_with("PMC") { id } else { format!("PMC{id}") }) }));
    put("language", text(work, "language").map(Json::from));
    put("abstract", work.get("abstract_inverted_index").and_then(abstract_text).map(Json::from));
    put("itemType", text(work, "type").and_then(|t| item_type(&t)).map(Json::from));
    let authors = work.get("authorships").and_then(Json::as_array).into_iter().flatten().filter_map(|a| a.get("author").and_then(|author| text(author, "display_name"))).map(|n| (None, None, Some(n)));
    put("creators", Some(creators(authors)));
    out
}

/// Key's fields from a Crossref work (`message` of `works/{doi}`).
pub fn crossref_fields(item: &Json) -> Map<String, Json> {
    let mut out = Map::new();
    let mut put = |k: &str, v: Option<Json>| {
        if let Some(v) = v.filter(|v| !v.is_null() && v.as_str().is_none_or(|s| !s.trim().is_empty())) {
            out.insert(k.into(), v);
        }
    };
    let first = |key: &str| item.get(key).and_then(Json::as_array).and_then(|a| a.first()).and_then(Json::as_str).map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "));
    let parts = ["published-print", "published-online", "issued", "published"].iter().find_map(|k| item[*k]["date-parts"][0].as_array().cloned());
    put("title", first("title").map(Json::from));
    put("year", parts.as_ref().and_then(|p| p.first()).and_then(Json::as_i64).map(Json::from));
    put(
        "date",
        parts.as_ref().map(|p| p.iter().filter_map(Json::as_i64).enumerate().map(|(i, n)| if i == 0 { format!("{n:04}") } else { format!("{n:02}") }).collect::<Vec<_>>().join("-")).map(Json::from),
    );
    put("containerTitle", first("container-title").map(Json::from));
    put("issn", first("ISSN").map(Json::from));
    put("publisher", text(item, "publisher").map(Json::from));
    put("volume", text(item, "volume").map(Json::from));
    put("issue", text(item, "issue").map(Json::from));
    put("pages", text(item, "page").map(|p| Json::from(p.replace('-', "–"))));
    put("doi", text(item, "DOI").map(|d| Json::from(bare_doi(&d))));
    put("language", text(item, "language").map(Json::from));
    put("itemType", text(item, "type").and_then(|t| item_type(&t)).map(Json::from));
    let authors = item.get("author").and_then(Json::as_array).into_iter().flatten().map(|a| (text(a, "family"), text(a, "given"), text(a, "name")));
    put("creators", Some(creators(authors)));
    out
}

/// Whether two values say the same (case, spacing, dash style and DOI prefixes aside).
fn same(field: &str, a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::String(x), Json::String(y)) => {
            let fold = |s: &str| name_key(&s.replace(['–', '—'], "-"));
            if field == "doi" { bare_doi(x) == bare_doi(y) } else { fold(x) == fold(y) }
        }
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        (Json::Number(x), Json::String(y)) | (Json::String(y), Json::Number(x)) => y.trim() == x.to_string(),
        (Json::Array(x), Json::Array(y)) if field == "creators" => {
            let names = |list: &Vec<Json>| -> Vec<String> {
                list.iter()
                    .filter_map(|c| serde_json::from_value::<Creator>(c.clone()).ok())
                    .map(|c| name_key(&c.family.clone().or_else(|| c.literal.as_ref().and_then(|l| split_name(l).0)).unwrap_or_default()))
                    .collect()
            };
            names(x) == names(y)
        }
        _ => a == b,
    }
}

fn is_preprint(source: &Source) -> bool {
    source.field("doi").is_some_and(|d| is_preprint_doi(&bare_doi(d)))
        || (source.field("arxivId").and_then(normalize_arxiv).is_some() && source.field("doi").is_none_or(|d| is_preprint_doi(&bare_doi(d))))
        || source.field("itemType") == Some("preprint")
        || source.field("workType") == Some("preprint")
}

/// Compares what a lookup found with a source. `proposed` are Key fields (`openalex_fields`
/// or `crossref_fields`).
pub fn proposal(source: &Source, edited: &[String], proposed: &Map<String, Json>, via: &str) -> RefreshProposal {
    let mut changes = Vec::new();
    let preprint = is_preprint(source);
    for (field, new) in proposed {
        // The DOI of a published version is not this preprint's DOI (see `published`).
        if field == "doi" && preprint && new.as_str().is_some_and(|d| !is_preprint_doi(d)) {
            continue;
        }
        // A generic or chosen item type is the user's call; only "document" is replaced.
        if field == "itemType" && source.field("itemType").is_some_and(|t| t != "document") {
            continue;
        }
        let old = match field.as_str() {
            "creators" => if source.creators.is_empty() { Json::Null } else { serde_json::to_value(&source.creators).unwrap_or(Json::Null) },
            _ => source.fields.get(field).cloned().unwrap_or(Json::Null),
        };
        if !old.is_null() && same(field, &old, new) {
            continue;
        }
        let edited = edited.iter().any(|f| f == field);
        changes.push(FieldChange { field: field.clone(), label: field_label(field), old, new: new.clone(), edited, selected: !edited });
    }
    RefreshProposal { id: source.id.clone(), title: source.title().to_string(), via: Some(via.into()), changes, published: None, error: None }
}

/// The published version a lookup reveals for a preprint: OpenAlex's work under a
/// journal DOI, a published location, or Crossref's `is-preprint-of` relation.
pub fn published_version(source: &Source, openalex: Option<&Json>, crossref: Option<&Json>) -> Option<Published> {
    if !is_preprint(source) {
        return None;
    }
    if let Some(work) = openalex {
        let doi = text(work, "doi").map(|d| bare_doi(&d));
        let venue = work.get("primary_location").and_then(|l| l.get("source")).and_then(|s| text(s, "display_name"));
        if let Some(doi) = doi.filter(|d| !is_preprint_doi(d) && Some(d.as_str()) != source.field("doi").map(bare_doi).as_deref()) {
            return Some(Published { doi, title: text(work, "display_name"), venue, year: work.get("publication_year").and_then(Json::as_i64), source_id: None });
        }
        for location in work.get("locations").and_then(Json::as_array).into_iter().flatten() {
            let journal = location.get("source").and_then(|s| text(s, "type")).is_some_and(|t| t == "journal");
            let published = text(location, "version").is_some_and(|v| v == "publishedVersion");
            let doi = text(location, "landing_page_url").filter(|u| u.contains("doi.org/")).map(|u| bare_doi(&u));
            if let (true, true, Some(doi)) = (journal, published, doi.filter(|d| !is_preprint_doi(d))) {
                return Some(Published {
                    doi,
                    title: text(work, "display_name"),
                    venue: location.get("source").and_then(|s| text(s, "display_name")),
                    year: work.get("publication_year").and_then(Json::as_i64),
                    source_id: None,
                });
            }
        }
    }
    let related = crossref?.get("relation")?.get("is-preprint-of")?.as_array()?.iter().find(|r| text(r, "id-type").is_none_or(|t| t == "doi"))?;
    Some(Published { doi: bare_doi(&text(related, "id")?), ..Default::default() })
}

impl Store {
    /// Applies the changes the user kept, as one journaled operation. Not marked as edited by
    /// hand (they came from the lookup), but fields the user chose to overwrite keep their mark.
    pub fn apply_refresh(&self, items: &[RefreshApply]) -> Result<Operation> {
        let ids: Vec<String> = items.iter().filter(|i| !i.fields.is_empty()).map(|i| i.id.clone()).collect();
        let label = if ids.len() == 1 { "Update metadata".to_string() } else { format!("Update metadata of {} sources", ids.len()) };
        let (affected, entry) = self.journaled("refresh", &label, &ids, |db, _| {
            let now = now_ms();
            let mut affected = 0;
            for item in items.iter().filter(|i| !i.fields.is_empty()) {
                let mut patch = Map::new();
                for (field, value) in &item.fields {
                    if matches!(field.as_str(), "creators" | "title" | "year" | "date" | "containerTitle" | "issn" | "publisher" | "volume" | "issue" | "pages" | "doi" | "pmid" | "pmcid" | "language" | "abstract" | "itemType" | "arxivId") {
                        patch.insert(field.clone(), value.clone());
                    }
                }
                if patch.is_empty() {
                    continue;
                }
                patch_source_row(db, &item.id, &patch, now)?;
                sync_graph(db, &item.id, Some(&patch))?;
                refresh_fts(db, &item.id)?;
                affected += 1;
            }
            Ok(affected)
        })?;
        Ok(Operation { affected, entry })
    }

    /// The hand-edited fields of a source.
    pub fn edited_fields(&self, id: &str) -> Result<Vec<String>> {
        journal::edited_fields(&*self.read()?, id)
    }

    /// Adds the published version of a preprint as a reference (looked up next) and links
    /// the two as versions; an existing source with that DOI is linked instead.
    pub fn add_published_version(&self, preprint: &str, published: &Published) -> Result<(String, Operation)> {
        let existing = self.source_for_work(None, Some(&published.doi))?;
        let id = match existing {
            Some(id) => id,
            None => {
                let mut fields = Map::new();
                fields.insert("doi".into(), json!(published.doi));
                fields.insert("itemType".into(), json!("article"));
                if let Some(title) = &published.title {
                    fields.insert("title".into(), json!(title));
                }
                if let Some(venue) = &published.venue {
                    fields.insert("containerTitle".into(), json!(venue));
                }
                if let Some(year) = published.year {
                    fields.insert("year".into(), json!(year));
                }
                let collections = self.source(preprint)?.map(|s| s.collections).unwrap_or_default();
                let source = self.insert_source(crate::SourceInput { kind: "reference".into(), fields, collections, index_status: Some("skipped".into()), ..Default::default() })?;
                self.request_enrichment(std::slice::from_ref(&source.id))?;
                source.id
            }
        };
        let op = self.link_versions(&[preprint.to_string(), id.clone()], true)?;
        Ok((id, op))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SourceInput;

    #[test]
    fn proposal_skips_same_values_and_does_not_select_hand_edited_fields() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let mut fields = Map::new();
        for (k, v) in [("title", json!("Poverty traps")), ("pages", json!("1-20")), ("doi", json!("10.1/pt")), ("volume", json!("3"))] {
            fields.insert(k.into(), v);
        }
        let id = store.insert_source(SourceInput { kind: "reference".into(), fields, ..Default::default() }).unwrap().id;
        store.edit_sources(std::slice::from_ref(&id), &serde_json::from_value(json!({"patch": {"title": "Poverty Traps (my title)"}})).unwrap(), None).unwrap();
        let work = json!({
            "id": "https://openalex.org/W1", "display_name": "Poverty traps", "doi": "https://doi.org/10.1/PT", "publication_year": 2006,
            "biblio": {"volume": "12", "first_page": "1", "last_page": "20"},
            "primary_location": {"source": {"display_name": "Journal of Growth"}},
            "authorships": [{"author": {"display_name": "Costas Azariadis"}}]
        });
        let source = store.source(&id).unwrap().unwrap();
        let p = proposal(&source, &store.edited_fields(&id).unwrap(), &openalex_fields(&work), "openalex");
        let by = |f: &str| p.changes.iter().find(|c| c.field == f).cloned();
        assert!(by("pages").is_none(), "1-20 and 1–20 are the same");
        assert!(by("doi").is_none());
        assert_eq!(by("volume").unwrap().new, json!("12"));
        assert!(by("volume").unwrap().selected);
        let title = by("title").unwrap();
        assert!(title.edited && !title.selected);
        assert_eq!(by("containerTitle").unwrap().old, Json::Null);
        assert!(by("creators").is_some());
        // Applying is journaled.
        let apply = RefreshApply { id: id.clone(), fields: p.changes.iter().filter(|c| c.selected).map(|c| (c.field.clone(), c.new.clone())).collect() };
        store.apply_refresh(&[apply]).unwrap();
        let after = store.source(&id).unwrap().unwrap();
        assert_eq!(after.field("volume"), Some("12"));
        assert_eq!(after.title(), "Poverty Traps (my title)");
        assert_eq!(after.creators[0].family.as_deref(), Some("Azariadis"));
        store.undo().unwrap();
        assert_eq!(store.source(&id).unwrap().unwrap().field("volume"), Some("3"));
    }

    #[test]
    fn background_lookups_leave_hand_edited_fields_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let mut fields = Map::new();
        fields.insert("title".into(), json!("draft.pdf"));
        let id = store.insert_source(SourceInput { kind: "reference".into(), fields, ..Default::default() }).unwrap().id;
        // The user cleared the volume and typed a title.
        store.edit_sources(std::slice::from_ref(&id), &serde_json::from_value(json!({"patch": {"volume": null, "title": "My title"}})).unwrap(), None).unwrap();
        let work = json!({"id": "https://openalex.org/W9", "display_name": "Their title", "biblio": {"volume": "9", "issue": "2"}});
        store.apply_openalex_work(&id, &work).unwrap();
        let source = store.source(&id).unwrap().unwrap();
        assert_eq!(source.title(), "My title");
        assert_eq!(source.field("volume"), None);
        assert_eq!(source.field("issue"), Some("2"));
    }

    #[test]
    fn finds_the_published_version_of_a_preprint() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let mut fields = Map::new();
        fields.insert("title".into(), json!("Cells signal"));
        fields.insert("doi".into(), json!("10.1101/2020.01.01.111111"));
        let id = store.insert_source(SourceInput { kind: "reference".into(), fields, ..Default::default() }).unwrap().id;
        let source = store.source(&id).unwrap().unwrap();
        let work = json!({"display_name": "Cells signal", "doi": "https://doi.org/10.1038/x1", "publication_year": 2022, "primary_location": {"source": {"display_name": "Nature"}}});
        let published = published_version(&source, Some(&work), None).unwrap();
        assert_eq!(published.doi, "10.1038/x1");
        assert_eq!(published.venue.as_deref(), Some("Nature"));
        // The proposal does not swap the preprint's DOI for the journal's.
        let p = proposal(&source, &[], &openalex_fields(&work), "openalex");
        assert!(p.changes.iter().all(|c| c.field != "doi"));
        let crossref = json!({"relation": {"is-preprint-of": [{"id-type": "doi", "id": "10.1038/X2"}]}});
        assert_eq!(published_version(&source, None, Some(&crossref)).unwrap().doi, "10.1038/x2");
        let (new_id, _) = store.add_published_version(&id, &published).unwrap();
        assert_eq!(store.versions_of(&id).unwrap(), vec![new_id]);
    }
}
