// The reference checker for a note (key_cite::check) given what the library knows about
// each cited source, and "where is this source cited": the notes that cite, quote or
// mention a source, counted from the links their saves write.
use super::cite_commands::{chosen, styles};
use super::{json_output, library_store::Library};
use crate::ipc::{Output, arg};
use key_cite::check::{self, CheckInput, CheckItem, CheckSource};
use key_cite::csl_json;
use key_store::Source;
use key_store::duplicates::{self, MatchKind, Work};
use serde::Deserialize;
use serde_json::{Value as Json, json};
use std::collections::HashMap;

#[derive(Clone, Debug, Default, Deserialize)]
struct CitationArg {
    #[serde(default)]
    items: Vec<CheckItem>,
}

fn number(source: &Source, key: &str) -> i64 {
    source.fields.get(key).and_then(Json::as_i64).unwrap_or(0)
}

fn is_preprint(source: &Source) -> bool {
    source.field("itemType") == Some("preprint") || source.field("workType") == Some("preprint") || source.field("doi").is_some_and(duplicates::is_preprint_doi)
}

fn work_of(source: &Source) -> Work {
    let year = source.fields.get("year").and_then(Json::as_i64);
    Work {
        id: Some(source.id.clone()),
        title: source.field("title").map(String::from),
        year,
        item_type: source.field("itemType").map(String::from),
        doi: source.field("doi").map(String::from),
        isbn: source.field("isbn").map(String::from),
        pmid: source.field("pmid").map(String::from),
        pmcid: source.field("pmcid").map(String::from),
        arxiv_id: source.field("arxivId").map(String::from),
        file_hash: source.file_hash().map(String::from),
        container_title: source.field("containerTitle").map(String::from),
        work_type: source.field("workType").map(String::from),
        edition: source.field("edition").map(String::from),
        creators: source.creators.clone(),
        ..Default::default()
    }
}

/// { style?, citations: [{ items: [{ id, locator?, label? }] }], bibliographyIds? (what the
/// reference list shows; absent when there is none) } -> { issues, style }
fn check_note(library: &Library, args: &Json) -> Result<Json, String> {
    let (style_id, _) = chosen(&library.store, args)?;
    let summary = styles().summary(&style_id);
    let citations: Vec<CitationArg> = arg::<Option<Vec<CitationArg>>>(args, "citations")?.unwrap_or_default();
    if citations.len() > 5000 {
        return Err("Too many citations in one request".into());
    }
    let mut input = CheckInput {
        citations: citations.into_iter().map(|c| c.items).collect(),
        bibliography: arg::<Option<Vec<String>>>(args, "bibliographyIds")?,
        format: summary.as_ref().map(|s| s.format.clone()).unwrap_or_else(|| "author-date".into()),
        note_style: summary.as_ref().is_some_and(|s| s.class == "note"),
        ..Default::default()
    };
    let mut ids: Vec<String> = input.citations.iter().flatten().map(|i| i.id.clone()).chain(input.bibliography.iter().flatten().cloned()).collect();
    ids.dedup();
    let mut found: HashMap<String, Option<Source>> = HashMap::new();
    let mut lookup = |id: &str| -> Result<Option<Source>, String> {
        if !found.contains_key(id) {
            found.insert(id.to_string(), library.store.source(id)?);
        }
        Ok(found[id].clone())
    };
    let mut works: Vec<(String, Work)> = Vec::new();
    for id in &ids {
        if input.sources.contains_key(id) {
            continue;
        }
        // A source that is gone entirely has no entry: the checker reports it as missing.
        let Some(source) = lookup(id)? else { continue };
        let notice = (number(&source, "retracted") > 0 && number(&source, "retractionDismissed") == 0).then(|| source.field("retractionKind").unwrap_or("retraction").to_string());
        let preprint = is_preprint(&source);
        let mut published = None;
        if preprint {
            let mut candidates = library.store.versions_of(&source.id)?;
            candidates.extend(library.store.find_duplicates_for(&[work_of(&source)])?.into_iter().flatten().filter(|m| m.kind == MatchKind::Version).map(|m| m.source_id));
            for other in candidates {
                if let Some(version) = lookup(&other)?.filter(|v| v.trashed_at.is_none() && !is_preprint(v)) {
                    published = Some((version.id.clone(), version.title().to_string()));
                    break;
                }
            }
        }
        if input.citations.iter().flatten().any(|i| &i.id == id) {
            works.push((source.id.clone(), work_of(&source)));
        }
        input.sources.insert(
            id.clone(),
            CheckSource { title: source.title().to_string(), in_library: true, trashed: source.trashed_at.is_some(), notice, item: csl_json::from_source(&source), preprint, published },
        );
    }
    // The same work cited as two library items (versions linked to each other are not).
    for (i, (a, wa)) in works.iter().enumerate() {
        for (b, wb) in &works[i + 1..] {
            if let Some(verdict) = duplicates::compare(wa, wb)
                && verdict.kind != MatchKind::Version
                && !library.store.versions_of(a)?.contains(b)
            {
                input.duplicates.push((a.clone(), b.clone(), verdict.reason));
            }
        }
    }
    Ok(json!({ "issues": check::check(&input), "style": summary }))
}

/// "(Doe, 2020)", "[3]", "³": link text that is a citation.
fn looks_like_citation(text: &str) -> bool {
    let t = text.trim();
    let wrapped = |open: char, close: char| t.len() > 2 && t.starts_with(open) && t.ends_with(close);
    wrapped('(', ')') || (wrapped('[', ']') && t.chars().count() <= 42) || (!t.is_empty() && t.chars().count() <= 12 && t.chars().all(|c| c.is_ascii_digit() || ",–-".contains(c)))
}

/// { id } -> { items: [{ kind, id, title, citations, quotes, mentions, places, context }] }:
/// the notes and canvases that use a source, and how.
fn cited_in(library: &Library, args: &Json) -> Result<Json, String> {
    let id: String = arg(args, "id")?;
    let links = library.store.item_links("source", &id)?;
    let mut order: Vec<String> = Vec::new();
    let mut rows: HashMap<String, Json> = HashMap::new();
    for link in &links.backlinks {
        let key = format!("{}:{}", link.from.kind, link.from.id);
        let row = rows.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            json!({ "kind": link.from.kind, "id": link.from.id, "title": link.from.title, "citations": 0, "quotes": 0, "mentions": 0, "places": [], "context": Json::Null })
        });
        let what = match link.label.as_deref() {
            Some(label) if looks_like_citation(label) => "citations",
            Some(_) => "mentions",
            None if link.context.is_some() || link.to.anchor.as_deref().is_some_and(|a| a.starts_with("highlight:")) => "quotes",
            None => "mentions",
        };
        row[what] = json!(row[what].as_i64().unwrap_or(0) + 1);
        if let Some(place) = &link.to.anchor_label
            && let Some(places) = row["places"].as_array_mut()
            && !places.iter().any(|p| p.as_str() == Some(place))
        {
            places.push(json!(place));
        }
        if row["context"].is_null()
            && let Some(context) = &link.context
        {
            row["context"] = json!(context);
        }
    }
    Ok(json!({ "items": order.iter().filter_map(|k| rows.remove(k)).collect::<Vec<_>>() }))
}

pub fn dispatch(library: &Library, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let result = match command {
        "store_cite_check" => check_note(library, args).and_then(json_output),
        "store_cited_in" => cited_in(library, args).and_then(json_output),
        _ => return None,
    };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::looks_like_citation;

    #[test]
    fn citation_labels() {
        for yes in ["(Doe, 2020)", "[3]", "[3, p. 4]", "12", "1–3"] {
            assert!(looks_like_citation(yes), "{yes}");
        }
        for no in ["Doe 2020", "a paper", ""] {
            assert!(!looks_like_citation(no), "{no}");
        }
    }
}
