// RIS: one tag per line (`TY  - JOUR` … `ER  -`), repeated tags for lists, and lines that
// do not start with a tag continue the value before them.
use crate::export::{ExportItem, ExportOptions};
use crate::fields::{self, keep, put};
use crate::{Record, Warning};
use key_store::{Creator, SourceInput};
use serde_json::Value as Json;

const NS: &str = "ris";

const TYPES: &[(&str, &str)] = &[
    ("JOUR", "article"),
    ("EJOUR", "article"),
    ("JFULL", "article"),
    ("ABST", "article"),
    ("INPR", "article"),
    ("MGZN", "magazine-article"),
    ("NEWS", "newspaper-article"),
    ("BOOK", "book"),
    ("EBOOK", "book"),
    ("EDBOOK", "book"),
    ("CHAP", "chapter"),
    ("ECHAP", "chapter"),
    ("CONF", "conference-paper"),
    ("CPAPER", "conference-paper"),
    ("RPRT", "report"),
    ("THES", "thesis"),
    ("ELEC", "webpage"),
    ("WEB", "webpage"),
    ("BLOG", "blog-post"),
    ("DATA", "dataset"),
    ("DBASE", "dataset"),
    ("COMP", "software"),
    ("UNPB", "manuscript"),
    ("MANSCPT", "manuscript"),
    ("PAT", "patent"),
    ("SLIDE", "presentation"),
    ("VIDEO", "video"),
    ("SOUND", "audio"),
    ("ART", "image"),
    ("STAND", "standard"),
    ("GEN", "document"),
];

fn ris_type(item_type: &str) -> &'static str {
    match item_type {
        "article" | "preprint" => "JOUR",
        "magazine-article" => "MGZN",
        "newspaper-article" => "NEWS",
        "book" => "BOOK",
        "chapter" => "CHAP",
        "conference-paper" => "CPAPER",
        "report" => "RPRT",
        "thesis" => "THES",
        "webpage" | "forum-post" => "ELEC",
        "blog-post" => "BLOG",
        "dataset" => "DATA",
        "software" => "COMP",
        "manuscript" => "UNPB",
        "patent" => "PAT",
        "presentation" => "SLIDE",
        "video" => "VIDEO",
        "audio" => "SOUND",
        "image" => "ART",
        "standard" => "STAND",
        _ => "GEN",
    }
}

/// `("AU", "Smith, J.")` for a tag line.
pub fn tag_line(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    if bytes.len() < 4 || !bytes[0].is_ascii_uppercase() || !(bytes[1].is_ascii_uppercase() || bytes[1].is_ascii_digit()) {
        return None;
    }
    let rest = &line[2..];
    let trimmed = rest.trim_start_matches(' ');
    let value = trimmed.strip_prefix('-')?;
    if trimmed.len() == rest.len() && !rest.starts_with('-') {
        return None;
    }
    Some((&line[..2], value.strip_prefix(' ').unwrap_or(value).trim_end()))
}

fn name(value: &str, role: &str) -> Creator {
    let value = value.trim();
    match value.split_once(',') {
        Some((family, given)) => {
            let given = given.trim();
            // "Smith, John, Jr." keeps the suffix with the given name.
            let given = match given.split_once(',') {
                Some((g, suffix)) => format!("{}, {}", g.trim(), suffix.trim()),
                None => given.to_string(),
            };
            Creator { family: Some(family.trim().into()), given: Some(given).filter(|g| !g.is_empty()), role: role.into(), ..Default::default() }
        }
        None if value.contains(' ') && value.split_whitespace().count() > 3 => Creator { literal: Some(value.into()), role: role.into(), ..Default::default() },
        None => match value.rsplit_once(' ') {
            Some((given, family)) => Creator { family: Some(family.into()), given: Some(given.into()), role: role.into(), ..Default::default() },
            None => Creator { family: Some(value.into()), role: role.into(), ..Default::default() },
        },
    }
}

/// "2020/05/03/other" → "2020-05-03".
fn ris_date(value: &str) -> String {
    let parts: Vec<&str> = value.split('/').collect();
    if parts.len() > 1 && parts[0].len() == 4 && parts[0].chars().all(|c| c.is_ascii_digit()) {
        return fields::iso_date(parts[0], parts.get(1).copied().filter(|m| !m.is_empty()), parts.get(2).copied().filter(|d| !d.is_empty()));
    }
    value.trim().to_string()
}

fn finish(tags: Vec<(String, String)>, line: usize) -> Option<Record> {
    let ty = tags.iter().find(|(t, _)| t == "TY").map(|(_, v)| v.trim().to_uppercase()).unwrap_or_default();
    let item_type = TYPES.iter().find(|(t, _)| *t == ty).map(|(_, i)| *i).unwrap_or("document");
    let mut input: SourceInput = fields::reference_input(item_type);
    if !TYPES.iter().any(|(t, _)| *t == ty) || matches!(ty.as_str(), "EJOUR" | "JFULL" | "ABST" | "INPR" | "EBOOK" | "EDBOOK" | "ECHAP" | "CONF" | "WEB" | "DBASE" | "MANSCPT") {
        keep(&mut input, NS, "TY", &ty);
    }
    let mut record = Record { line, ..Default::default() };
    let (mut start, mut end) = (None, None);
    let mut serial = Vec::new();
    for (tag, value) in &tags {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match tag.as_str() {
            "TY" | "ER" => {}
            "AU" | "A1" => input.creators.push(name(value, "author")),
            "A2" | "ED" => input.creators.push(name(value, "editor")),
            "A3" => input.creators.push(name(value, "series-editor")),
            "A4" => input.creators.push(name(value, "translator")),
            "TI" | "T1" => {
                if fields::text(&input.fields, "title").is_some() {
                    keep(&mut input, NS, tag, value);
                } else {
                    put(&mut input, "title", value);
                }
            }
            "CT" => put(&mut input, "title", value),
            "T2" | "JF" | "JO" | "BT" => {
                if fields::text(&input.fields, "containerTitle").is_some_and(|c| c != value) {
                    if tag == "JO" || tag == "JA" {
                        put(&mut input, "containerShort", value);
                    } else {
                        keep(&mut input, NS, tag, value);
                    }
                } else {
                    put(&mut input, "containerTitle", value);
                }
            }
            "J2" | "JA" => put(&mut input, "containerShort", value),
            "T3" => put(&mut input, "series", value),
            "ST" => put(&mut input, "shortTitle", value),
            "PY" | "Y1" => {
                let date = ris_date(value);
                let current = fields::text(&input.fields, "date").map(str::to_string);
                match current {
                    Some(c) if c.len() >= date.len() => {}
                    _ => {
                        input.fields.remove("date");
                        put(&mut input, "date", &date);
                    }
                }
            }
            "DA" => {
                let date = ris_date(value);
                let current = fields::text(&input.fields, "date").map(str::to_string);
                if current.as_ref().is_none_or(|c| date.len() > c.len() && date.starts_with(c.as_str())) {
                    input.fields.remove("date");
                    put(&mut input, "date", &date);
                } else if current.as_deref() != Some(date.as_str()) {
                    keep(&mut input, NS, "DA", value);
                }
            }
            "Y2" => put(&mut input, "accessed", &ris_date(value)),
            "VL" => put(&mut input, "volume", value),
            "IS" | "CP" => put(&mut input, "issue", value),
            "SP" => start = Some(value.to_string()),
            "EP" => end = Some(value.to_string()),
            "ET" => put(&mut input, "edition", value),
            "PB" => put(&mut input, "publisher", value),
            "CY" | "PP" => put(&mut input, "place", value),
            "SN" => serial.push(value.to_string()),
            "DO" => put(&mut input, "doi", value),
            "UR" => {
                if fields::text(&input.fields, "url").is_some() {
                    keep(&mut input, NS, "UR", value);
                } else {
                    put(&mut input, "url", value);
                }
            }
            "L1" | "L4" => record.files.push(value.strip_prefix("file://").unwrap_or(value).to_string()),
            "AB" | "N2" => {
                if fields::text(&input.fields, "abstract").is_some_and(|a| a != value) {
                    record.notes.push(value.to_string());
                } else {
                    put(&mut input, "abstract", value);
                }
            }
            "N1" => record.notes.push(value.to_string()),
            "KW" => fields::add_tags(&mut input, value.split(['\n', ';']).map(|k| k.trim().to_string()).filter(|k| !k.is_empty())),
            "LA" => put(&mut input, "language", value),
            "M3" => put(&mut input, "genre", value),
            "CR" => put(&mut input, "rights", value),
            "AN" if value.chars().all(|c| c.is_ascii_digit()) && fields::text(&input.fields, "pmid").is_none() && tags.iter().any(|(t, v)| t == "DB" && v.to_lowercase().contains("pubmed")) => {
                put(&mut input, "pmid", value)
            }
            other => keep(&mut input, NS, other, value),
        }
    }
    match (start, end) {
        (Some(s), Some(e)) if s != e => put(&mut input, "pages", &format!("{s}-{e}")),
        (Some(s), _) => put(&mut input, "pages", &s),
        (None, Some(e)) => keep(&mut input, NS, "EP", &e),
        _ => {}
    }
    let isbn_like = matches!(item_type, "book" | "chapter" | "conference-paper" | "report" | "thesis");
    for sn in serial {
        let issn = sn.len() == 9 && sn.as_bytes()[4] == b'-';
        if issn || !isbn_like && fields::text(&input.fields, "issn").is_none() && !(sn.replace('-', "").len() >= 10) {
            put(&mut input, "issn", &sn);
        } else {
            put(&mut input, "isbn", &sn);
        }
    }
    record.source = input;
    (fields::text(&record.source.fields, "title").is_some() || !record.source.creators.is_empty() || ty.len() > 1).then_some(record)
}

pub fn parse(text: &str, progress: &dyn Fn(usize, usize)) -> (Vec<Record>, Vec<Warning>) {
    let mut records = Vec::new();
    let mut warnings = Vec::new();
    let mut tags: Vec<(String, String)> = Vec::new();
    let mut start_line = 0;
    let total = text.len();
    let mut done = 0;
    for (index, line) in text.lines().enumerate() {
        done += line.len() + 1;
        if index % 20000 == 0 {
            progress(done.min(total), total);
        }
        let line = line.trim_end_matches('\r');
        match tag_line(line) {
            Some(("TY", value)) => {
                if !tags.is_empty() {
                    warnings.push(Warning { line: start_line, message: format!("Entry at line {start_line} has no “ER” line") });
                    records.extend(finish(std::mem::take(&mut tags), start_line));
                }
                start_line = index + 1;
                tags.push(("TY".into(), value.into()));
            }
            Some(("ER", _)) => {
                if tags.is_empty() {
                    continue;
                }
                records.extend(finish(std::mem::take(&mut tags), start_line));
            }
            Some((tag, value)) => {
                if tags.is_empty() {
                    warnings.push(Warning { line: index + 1, message: format!("“{tag}” at line {} is outside an entry", index + 1) });
                    continue;
                }
                tags.push((tag.into(), value.into()));
            }
            None if line.trim().is_empty() => {}
            None => {
                // A continuation line.
                if let Some((tag, value)) = tags.last_mut() {
                    let joiner = if matches!(tag.as_str(), "AB" | "N1" | "N2") { "\n" } else { " " };
                    if !value.is_empty() {
                        value.push_str(joiner);
                    }
                    value.push_str(line.trim());
                }
            }
        }
    }
    if !tags.is_empty() {
        records.extend(finish(tags, start_line));
    }
    progress(total, total);
    (records, warnings)
}

// ── Writing ──────────────────────────────────────────────────────────────────

pub fn write_entry(item: &ExportItem, options: &ExportOptions) -> String {
    let source = item.source;
    let f = &source.fields;
    let text = |name: &str| fields::text(f, name).map(str::to_string);
    let item_type = text("itemType").unwrap_or_else(|| "document".into());
    let ty = source.properties.get("ris.TY").and_then(Json::as_str).map(str::to_string).unwrap_or_else(|| ris_type(&item_type).to_string());
    let mut out = format!("TY  - {ty}\n");
    let mut line = |tag: &str, value: &str| {
        let value = value.trim();
        if !value.is_empty() {
            // Further lines of a value are indented, so none reads as a tag.
            out.push_str(&format!("{tag}  - {}\n", value.replace("\r\n", "\n").replace('\n', "\n  ")));
        }
    };
    for (role, tag) in [("author", "AU"), ("editor", "A2"), ("series-editor", "A3"), ("translator", "A4")] {
        for c in source.creators.iter().filter(|c| c.role == role) {
            let name = match (&c.literal, &c.family, &c.given) {
                (Some(literal), _, _) => literal.clone(),
                (None, Some(family), Some(given)) => format!("{family}, {given}"),
                (None, Some(family), None) => family.clone(),
                (None, None, Some(given)) => given.clone(),
                _ => continue,
            };
            line(tag, &name);
        }
    }
    line("TI", &text("title").unwrap_or_default());
    line("ST", &text("shortTitle").unwrap_or_default());
    line("T2", &text("containerTitle").unwrap_or_default());
    line("J2", &text("containerShort").unwrap_or_default());
    line("T3", &text("series").unwrap_or_default());
    if let Some(date) = text("date") {
        match fields::date_parts(&date) {
            Some((y, m, d)) => {
                line("PY", &y.to_string());
                if m.is_some() {
                    line("DA", &format!("{y}/{}/{}/", m.map(|m| format!("{m:02}")).unwrap_or_default(), d.map(|d| format!("{d:02}")).unwrap_or_default()));
                }
            }
            None => line("PY", &date),
        }
    } else if let Some(year) = f.get("year").and_then(Json::as_i64) {
        line("PY", &year.to_string());
    }
    line("Y2", &text("accessed").unwrap_or_default());
    line("VL", &text("volume").unwrap_or_default());
    line("IS", &text("issue").unwrap_or_default());
    if let Some(pages) = text("pages") {
        match pages.split_once(['-', '–']) {
            Some((s, e)) => {
                line("SP", s);
                line("EP", e);
            }
            None => line("SP", &pages),
        }
    }
    line("ET", &text("edition").unwrap_or_default());
    line("PB", &text("publisher").or(text("institution")).unwrap_or_default());
    line("CY", &text("place").unwrap_or_default());
    line("SN", &text("isbn").unwrap_or_default());
    line("SN", &text("issn").unwrap_or_default());
    line("DO", &text("doi").unwrap_or_default());
    line("UR", &text("url").unwrap_or_default());
    line("M3", &text("genre").unwrap_or_default());
    line("LA", &text("language").unwrap_or_default());
    line("CR", &text("rights").unwrap_or_default());
    if options.abstracts {
        line("AB", &text("abstract").unwrap_or_default());
    }
    if options.keywords {
        for tag in &source.tags {
            line("KW", tag);
        }
    }
    if options.files {
        if let Some(path) = text("filePath") {
            line("L1", &format!("file://{path}"));
        }
    }
    if options.notes {
        for note in &item.notes {
            line("N1", note);
        }
    }
    if let Some(extra) = text("extra") {
        line("N1", &extra);
    }
    line("ID", &item.key);
    let mut kept: Vec<(&String, &Json)> = source.properties.iter().filter(|(k, _)| k.starts_with("ris.") && k.len() == 6 && k.as_str() != "ris.TY").collect();
    kept.sort_by(|a, b| a.0.cmp(b.0));
    for (name, value) in kept {
        if let Some(value) = value.as_str() {
            for part in value.split("; ") {
                line(&name[4..], part);
            }
        }
    }
    out.push_str("ER  - \n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tags_repeats_and_continuations() {
        let text = "TY  - JOUR\nAU  - Smith, John\nAU  - Doe, Jane\nTI  - A long title\n  that continues\nT2  - Journal of Tests\nPY  - 2020/05/03/\nSP  - 10\nEP  - 20\nKW  - alpha\nKW  - beta\nN1  - A note\nSN  - 1234-5678\nL1  - file:///tmp/x.pdf\nZZ  - custom\nER  - \n";
        let (records, warnings) = parse(text, &|_, _| {});
        assert!(warnings.is_empty());
        let r = &records[0];
        assert_eq!(r.title(), "A long title that continues");
        assert_eq!(r.source.creators.len(), 2);
        assert_eq!(fields::text(&r.source.fields, "date"), Some("2020-05-03"));
        assert_eq!(fields::text(&r.source.fields, "pages"), Some("10-20"));
        assert_eq!(fields::text(&r.source.fields, "issn"), Some("1234-5678"));
        assert_eq!(r.source.tags, ["alpha", "beta"]);
        assert_eq!(r.notes, ["A note"]);
        assert_eq!(r.files, ["/tmp/x.pdf"]);
        assert_eq!(r.source.properties.get("ris.ZZ").and_then(Json::as_str), Some("custom"));
    }
}
