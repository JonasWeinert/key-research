//! The one mapping from a Key source to a CSL-JSON item (and the type and role tables both
//! ways, for importers). Everything Key stores that CSL has a variable for is carried over.
use key_store::{Creator, Source};
use serde_json::{Map, Value as Json, json};

/// Key item type -> CSL type.
const TYPES: &[(&str, &str)] = &[
    ("article", "article-journal"),
    ("book", "book"),
    ("chapter", "chapter"),
    ("conference-paper", "paper-conference"),
    ("report", "report"),
    ("thesis", "thesis"),
    ("preprint", "article"),
    ("webpage", "webpage"),
    ("blog-post", "post-weblog"),
    ("dataset", "dataset"),
    ("software", "software"),
    ("video", "motion_picture"),
    ("audio", "song"),
    ("image", "graphic"),
    ("magazine-article", "article-magazine"),
    ("newspaper-article", "article-newspaper"),
    ("presentation", "speech"),
    ("manuscript", "manuscript"),
    ("document", "document"),
];

/// The CSL type for a Key item type (`document` when unknown).
pub fn csl_type(item_type: &str) -> &'static str {
    TYPES.iter().find(|(key, _)| *key == item_type).map_or("document", |(_, csl)| csl)
}

/// The Key item type for a CSL type (`document` when Key has none closer).
pub fn item_type_from_csl(csl: &str) -> &'static str {
    match csl {
        "article" | "article-journal" | "review" | "review-book" => {
            if csl == "article" { "preprint" } else { "article" }
        }
        "paper-conference" => "conference-paper",
        "entry" | "entry-dictionary" | "entry-encyclopedia" => "chapter",
        "post" => "blog-post",
        "broadcast" => "video",
        "interview" | "personal_communication" | "letter" => "manuscript",
        "standard" | "legislation" | "bill" | "legal_case" | "regulation" | "treaty" | "patent" => "document",
        "map" | "figure" => "image",
        "classic" | "collection" | "periodical" => "book",
        other => TYPES.iter().find(|(_, c)| *c == other).map_or("document", |(key, _)| key),
    }
}

/// Key creator role -> CSL name variable.
pub fn csl_name_variable(role: &str) -> &'static str {
    match role {
        "editor" => "editor",
        "translator" => "translator",
        "container-author" => "container-author",
        "contributor" => "contributor",
        "series-editor" => "collection-editor",
        "director" => "director",
        "interviewer" => "interviewer",
        "recipient" => "recipient",
        "reviewed-author" => "reviewed-author",
        "composer" => "composer",
        "illustrator" => "illustrator",
        _ => "author",
    }
}

/// CSL name variable -> Key creator role.
pub fn role_from_csl_variable(variable: &str) -> &'static str {
    match variable {
        "editor" | "editorial-director" => "editor",
        "translator" => "translator",
        "container-author" => "container-author",
        "collection-editor" => "series-editor",
        "director" => "director",
        "interviewer" => "interviewer",
        "recipient" => "recipient",
        "reviewed-author" => "reviewed-author",
        "composer" => "composer",
        "illustrator" => "illustrator",
        "author" => "author",
        _ => "contributor",
    }
}

/// A CSL name object for a creator (`literal` for institutions and unsplit names).
pub fn csl_name(creator: &Creator) -> Option<Json> {
    let clean = |s: &Option<String>| s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    if let Some(literal) = clean(&creator.literal) {
        return Some(json!({ "literal": literal }));
    }
    match (clean(&creator.family), clean(&creator.given)) {
        (Some(family), Some(given)) => Some(json!({ "family": family, "given": given })),
        (Some(family), None) => Some(json!({ "family": family })),
        (None, Some(given)) => Some(json!({ "literal": given })),
        (None, None) => None,
    }
}

/// A CSL date (`date-parts`, one date only) from Key's free-form date and year.
/// Reads `2021`, `2021-03`, `2021-03-04`, ISO timestamps, `3/4/2021` and `March 2021`;
/// keeps the text as `raw` when only the year can be read from it.
pub fn csl_date(date: Option<&str>, year: Option<i64>) -> Option<Json> {
    let text = date.map(str::trim).filter(|d| !d.is_empty());
    if let Some(parts) = text.and_then(parse_date) {
        return Some(json!({ "date-parts": [parts] }));
    }
    if let Some(year) = year.filter(|y| (-9999..=9999).contains(y) && *y != 0) {
        return Some(json!({ "date-parts": [[year]] }));
    }
    let year = text.and_then(|t| {
        t.split(|c: char| !c.is_ascii_digit()).find(|p| p.len() == 4).and_then(|p| p.parse::<i64>().ok())
    })?;
    Some(json!({ "date-parts": [[year]] }))
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

fn parse_date(text: &str) -> Option<Vec<i64>> {
    let valid = |parts: Vec<i64>| {
        let ok = parts.first().is_some_and(|y| (1..=9999).contains(y))
            && parts.get(1).is_none_or(|m| (1..=12).contains(m))
            && parts.get(2).is_none_or(|d| (1..=31).contains(d));
        ok.then_some(parts)
    };
    let head = text.split(['T', ' ']).next().unwrap_or(text);
    // 2021, 2021-03, 2021-03-04, 2021/03/04
    let iso: Vec<&str> = head.split(['-', '/', '.']).collect();
    if iso.first().is_some_and(|y| y.len() == 4) && iso.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) && iso.len() <= 3 {
        return valid(iso.iter().map(|p| p.parse().unwrap_or(0)).collect());
    }
    // 3/4/2021 (month first, as Zotero and US sources write it)
    if iso.len() == 3 && iso[2].len() == 4 && iso.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty()) {
        let n: Vec<i64> = iso.iter().map(|p| p.parse().unwrap_or(0)).collect();
        return valid(vec![n[2], n[0], n[1]]);
    }
    // March 2021, 4 March 2021, March 4, 2021
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower.split(|c: char| c.is_whitespace() || c == ',').filter(|w| !w.is_empty()).collect();
    let month = words.iter().find_map(|w| MONTHS.iter().position(|m| w.starts_with(m)).map(|i| i as i64 + 1))?;
    let year = words.iter().find(|w| w.len() == 4 && w.chars().all(|c| c.is_ascii_digit()))?.parse().ok()?;
    let day = words.iter().find(|w| (1..=2).contains(&w.len()) && w.chars().all(|c| c.is_ascii_digit())).and_then(|d| d.parse().ok());
    valid(match day {
        Some(day) => vec![year, month, day],
        None => vec![year, month],
    })
}

fn clean_doi(doi: &str) -> String {
    let doi = doi.trim();
    let lower = doi.to_ascii_lowercase();
    for prefix in ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi:"] {
        if lower.starts_with(prefix) {
            return doi[prefix.len()..].trim().to_string();
        }
    }
    doi.to_string()
}

/// The CSL-JSON item for a source. `id` is the source id; fields Key leaves empty are left out.
pub fn from_source(source: &Source) -> Json {
    let mut item = Map::new();
    let field = |name: &str| source.field(name).map(str::trim).filter(|v| !v.is_empty());
    let item_type = field("itemType").unwrap_or(match source.kind.as_str() {
        "web" => "webpage",
        "video" => "video",
        "audio" => "audio",
        "image" => "image",
        _ => "document",
    });
    item.insert("id".into(), json!(source.id));
    item.insert("type".into(), json!(csl_type(item_type)));

    let mut names: Map<String, Json> = Map::new();
    for creator in &source.creators {
        let Some(name) = csl_name(creator) else { continue };
        let variable = csl_name_variable(&creator.role);
        names.entry(variable).or_insert_with(|| json!([])).as_array_mut().expect("array").push(name);
    }
    item.extend(names);

    let year = source.fields.get("year").and_then(Json::as_i64);
    if let Some(issued) = csl_date(field("date"), year) {
        item.insert("issued".into(), issued);
    }
    if let Some(accessed) = field("accessed").and_then(|a| csl_date(Some(a), None)) {
        item.insert("accessed".into(), accessed);
    }

    let mut put = |key: &str, value: Option<&str>| {
        if let Some(value) = value {
            item.insert(key.into(), json!(value));
        }
    };
    put("title", field("title"));
    put("title-short", field("shortTitle"));
    put("container-title", field("containerTitle"));
    put("container-title-short", field("containerShort"));
    put("volume", field("volume"));
    put("issue", field("issue"));
    put("page", field("pages"));
    put("edition", field("edition"));
    put("collection-title", field("series"));
    put("publisher-place", field("place"));
    put("genre", field("genre"));
    put("ISBN", field("isbn"));
    put("ISSN", field("issn"));
    put("PMID", field("pmid"));
    put("PMCID", field("pmcid"));
    put("URL", field("url"));
    put("abstract", field("abstract"));
    put("language", field("language"));
    put("license", field("rights"));
    put("citation-key", field("citationKey"));
    put("note", field("extra"));
    // Theses and reports name their institution where CSL expects the publisher.
    put("publisher", field("publisher").or_else(|| field("institution")));
    if let Some(doi) = field("doi") {
        item.insert("DOI".into(), json!(clean_doi(doi)));
    }
    if let Some(arxiv) = field("arxivId") {
        // A preprint's repository is its publisher (as Zotero and the CSL 1.0.2 spec have it).
        if !item.contains_key("publisher") && !item.contains_key("container-title") && item_type == "preprint" {
            item.insert("publisher".into(), json!("arXiv"));
        }
        item.insert("number".into(), json!(format!("arXiv:{}", arxiv.trim_start_matches("arXiv:"))));
        if !item.contains_key("URL") && !item.contains_key("DOI") {
            item.insert("URL".into(), json!(format!("https://arxiv.org/abs/{}", arxiv.trim_start_matches("arXiv:"))));
        }
    }
    if let Some(pages) = source.fields.get("pageCount").and_then(Json::as_i64).filter(|n| *n > 0) {
        if !matches!(item_type, "article" | "chapter" | "conference-paper" | "magazine-article" | "newspaper-article") {
            item.insert("number-of-pages".into(), json!(pages.to_string()));
        }
    }
    if let Some(seconds) = source.fields.get("durationSeconds").and_then(Json::as_i64).filter(|n| *n > 0) {
        item.insert("dimensions".into(), json!(format!("{}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60)));
    }
    if item_type == "preprint" && !item.contains_key("genre") {
        item.insert("genre".into(), json!("Preprint"));
    }
    if source.kind == "web" && !item.contains_key("container-title") {
        // A saved web page's site name, when the snapshot recorded one.
        let site = source.properties.get("webSnapshot").and_then(|s| s.get("siteName")).and_then(Json::as_str).map(str::trim).filter(|s| !s.is_empty());
        if let Some(site) = site {
            item.insert("container-title".into(), json!(site));
        }
    }
    Json::Object(item)
}
