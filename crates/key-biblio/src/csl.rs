// CSL-JSON. Writing uses key-cite's canonical mapping (`key_cite::csl_json::from_source`);
// reading is its inverse, built on key-cite's type and role tables. Variables with no
// column are kept as `csl.<variable>` and written back on export.
use crate::export::{ExportItem, ExportOptions};
use crate::fields::{self, keep, put};
use crate::{Record, Warning};
use key_cite::csl_json::{from_source, item_type_from_csl, role_from_csl_variable};
use key_store::Creator;
use serde_json::{Map, Value as Json, json};

const NS: &str = "csl";

const NAME_VARIABLES: &[&str] = &[
    "author", "editor", "translator", "container-author", "collection-editor", "director", "interviewer", "recipient", "reviewed-author", "composer",
    "illustrator", "contributor", "editorial-director", "chair", "compiler", "curator", "executive-producer", "guest", "host", "narrator",
    "organizer", "performer", "producer", "script-writer", "series-creator", "original-author",
];

/// Plain variables → column.
const VARIABLES: &[(&str, &str)] = &[
    ("title", "title"),
    ("title-short", "shortTitle"),
    ("shortTitle", "shortTitle"),
    ("container-title", "containerTitle"),
    ("container-title-short", "containerShort"),
    ("journalAbbreviation", "containerShort"),
    ("volume", "volume"),
    ("issue", "issue"),
    ("page", "pages"),
    ("edition", "edition"),
    ("collection-title", "series"),
    ("publisher", "publisher"),
    ("publisher-place", "place"),
    ("genre", "genre"),
    ("DOI", "doi"),
    ("ISBN", "isbn"),
    ("ISSN", "issn"),
    ("PMID", "pmid"),
    ("PMCID", "pmcid"),
    ("URL", "url"),
    ("abstract", "abstract"),
    ("language", "language"),
    ("license", "rights"),
    ("citation-key", "citationKey"),
    ("note", "extra"),
];

fn as_text(value: &Json) -> Option<String> {
    match value {
        Json::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Json::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn name(value: &Json, role: &str) -> Option<Creator> {
    let text = |k: &str| value.get(k).and_then(as_text);
    if let Some(literal) = text("literal") {
        return Some(Creator { literal: Some(literal), role: role.into(), ..Default::default() });
    }
    let particle = [text("dropping-particle"), text("non-dropping-particle")].into_iter().flatten().collect::<Vec<_>>().join(" ");
    let family = text("family").map(|f| if particle.is_empty() { f } else { format!("{particle} {f}") });
    let given = match (text("given"), text("suffix")) {
        (Some(g), Some(s)) => Some(format!("{g}, {s}")),
        (g, _) => g,
    };
    (family.is_some() || given.is_some()).then(|| Creator { family, given, role: role.into(), ..Default::default() })
}

/// A CSL date object as Key's date text.
fn date(value: &Json) -> Option<String> {
    if let Some(parts) = value.get("date-parts").and_then(|p| p.get(0)).and_then(Json::as_array) {
        let n: Vec<String> = parts.iter().filter_map(as_text).collect();
        let year = n.first()?;
        return Some(fields::iso_date(year, n.get(1).map(String::as_str), n.get(2).map(String::as_str)));
    }
    value.get("raw").or(value.get("literal")).and_then(as_text).or_else(|| as_text(value))
}

pub fn record(item: &Map<String, Json>, index: usize) -> Record {
    let csl_type = item.get("type").and_then(Json::as_str).unwrap_or("document");
    let mut item_type = item_type_from_csl(csl_type);
    // "article" in CSL is also a plain article without a journal; a preprint has a repository number.
    if csl_type == "article" && !item.get("number").and_then(Json::as_str).is_some_and(|n| n.to_lowercase().starts_with("arxiv")) && item.get("genre").and_then(Json::as_str).is_none_or(|g| !g.eq_ignore_ascii_case("preprint")) && item.contains_key("container-title") {
        item_type = "article";
    }
    let mut input = fields::reference_input(item_type);
    if item_type == "document" && csl_type != "document" {
        keep(&mut input, NS, "type", csl_type);
    }
    let mut record = Record { line: index + 1, ..Default::default() };
    for (variable, value) in item {
        if NAME_VARIABLES.contains(&variable.as_str()) {
            let role = role_from_csl_variable(variable);
            for n in value.as_array().into_iter().flatten() {
                if let Some(creator) = name(n, role) {
                    input.creators.push(creator);
                }
            }
            continue;
        }
        if let Some((_, column)) = VARIABLES.iter().find(|(v, _)| v == variable) {
            if let Some(text) = as_text(value) {
                if *column == "publisher" && text == "arXiv" && item_type == "preprint" {
                    continue;
                }
                if *column == "genre" && text == "Preprint" && item_type == "preprint" {
                    continue;
                }
                // Theses and reports carry their institution as the publisher.
                if *column == "publisher" && matches!(item_type, "thesis" | "report") {
                    put(&mut input, "institution", &text);
                    continue;
                }
                put(&mut input, column, &text);
            }
            continue;
        }
        match variable.as_str() {
            "id" | "type" => {}
            "issued" => {
                if let Some(d) = date(value) {
                    put(&mut input, "date", &d);
                }
            }
            "accessed" => {
                if let Some(d) = date(value) {
                    put(&mut input, "accessed", &d);
                }
            }
            "number" => {
                let text = as_text(value).unwrap_or_default();
                match text.strip_prefix("arXiv:").or_else(|| text.strip_prefix("arxiv:")) {
                    Some(id) => put(&mut input, "arxivId", id),
                    None => keep(&mut input, NS, "number", &text),
                }
            }
            "keyword" => {
                if let Some(text) = as_text(value) {
                    fields::add_tags(&mut input, fields::keywords(&text));
                }
            }
            "number-of-pages" | "dimensions" if item_type != "document" => keep(&mut input, NS, variable, &as_text(value).unwrap_or_default()),
            other => match value {
                Json::String(_) | Json::Number(_) => keep(&mut input, NS, other, &as_text(value).unwrap_or_default()),
                Json::Null => {}
                v => {
                    if let Some(d) = v.is_object().then(|| date(v)).flatten() {
                        keep(&mut input, NS, other, &d);
                    } else {
                        keep(&mut input, NS, other, &v.to_string());
                    }
                }
            },
        }
    }
    // A citation key in `id` (pandoc, Better BibTeX) when there is no `citation-key`.
    if fields::text(&input.fields, "citationKey").is_none() {
        if let Some(id) = item.get("id").and_then(Json::as_str) {
            if key_store::citation_keys::valid_key(id) && !id.chars().all(|c| c.is_ascii_digit()) && !id.contains('/') && id.len() < 80 && !looks_like_uuid(id) {
                put(&mut input, "citationKey", id);
            }
        }
    }
    record.source = input;
    record
}

fn looks_like_uuid(id: &str) -> bool {
    id.len() >= 32 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

pub fn parse(text: &str) -> Result<(Vec<Record>, Vec<Warning>), String> {
    let value: Json = serde_json::from_str(text).map_err(|e| format!("Not valid CSL-JSON: {e}"))?;
    let items: Vec<Json> = match value {
        Json::Array(items) => items,
        Json::Object(mut object) => match object.remove("items") {
            Some(Json::Array(items)) => items,
            _ => vec![Json::Object(object)],
        },
        _ => return Err("CSL-JSON should be a list of items".into()),
    };
    let mut warnings = Vec::new();
    let mut records = Vec::new();
    for (index, item) in items.iter().enumerate() {
        match item.as_object() {
            Some(object) => records.push(record(object, index)),
            None => warnings.push(Warning { line: 0, message: format!("Item {} is not an object", index + 1) }),
        }
    }
    Ok((records, warnings))
}

/// One CSL-JSON item: key-cite's mapping, the citation key as `id` (as pandoc reads it),
/// tags as `keyword`, and kept `csl.*` variables.
pub fn item(item: &ExportItem, options: &ExportOptions) -> Json {
    let mut value = from_source(item.source);
    let object = value.as_object_mut().expect("object");
    object.insert("id".into(), json!(item.key));
    object.insert("citation-key".into(), json!(item.key));
    if !options.abstracts {
        object.remove("abstract");
    }
    if options.keywords && !item.source.tags.is_empty() {
        object.insert("keyword".into(), json!(item.source.tags.join(", ")));
    }
    if options.notes && !item.notes.is_empty() {
        let note = object.get("note").and_then(Json::as_str).map(|n| format!("{n}\n\n")).unwrap_or_default();
        object.insert("note".into(), json!(note + &item.notes.join("\n\n")));
    }
    if options.files {
        if let Some(path) = fields::text(&item.source.fields, "filePath") {
            object.insert("file".into(), json!(path));
        }
    }
    let mut kept: Vec<(&String, &Json)> = item.source.properties.iter().filter(|(k, _)| k.starts_with("csl.")).collect();
    kept.sort_by(|a, b| a.0.cmp(b.0));
    for (name, kept_value) in kept {
        let variable = &name[NS.len() + 1..];
        if variable == "type" {
            if let Some(t) = kept_value.as_str() {
                object.insert("type".into(), json!(t));
            }
            continue;
        }
        if !object.contains_key(variable) {
            let parsed = kept_value.as_str().and_then(|s| (s.starts_with('{') || s.starts_with('[')).then(|| serde_json::from_str(s).ok()).flatten());
            object.insert(variable.into(), parsed.unwrap_or_else(|| kept_value.clone()));
        }
    }
    value
}
