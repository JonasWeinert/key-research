// Shared pieces of the field maps: putting values on a source, dates, pages, keywords,
// the namespaced custom properties that keep what has no column, and file paths.
use key_store::SourceInput;
use serde_json::{Map, Value as Json};

/// Key's bibliographic columns a format can fill directly (camelCase names).
pub const TEXT_COLUMNS: &[&str] = &[
    "title", "shortTitle", "date", "containerTitle", "containerShort", "volume", "issue", "pages", "edition", "series", "publisher", "place",
    "institution", "genre", "doi", "isbn", "issn", "pmid", "pmcid", "arxivId", "url", "accessed", "abstract", "language", "rights", "citationKey",
    "extra",
];

/// Sets a text column unless the value is empty; the first value wins.
pub fn put(input: &mut SourceInput, name: &str, value: &str) {
    let value = value.trim();
    if value.is_empty() || input.fields.get(name).and_then(Json::as_str).is_some_and(|v| !v.is_empty()) {
        return;
    }
    let value = match name {
        "doi" => clean_doi(value),
        "pages" => clean_pages(value),
        _ => value.to_string(),
    };
    if name == "date" {
        if let Some(year) = year_of(&value) {
            input.fields.entry("year".to_string()).or_insert(Json::from(year));
        }
    }
    input.fields.insert(name.into(), Json::from(value));
}

/// Keeps a value with no column as a custom property (`bibtex.howpublished`).
pub fn keep(input: &mut SourceInput, namespace: &str, name: &str, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    let key = format!("{namespace}.{name}");
    match input.properties.get_mut(&key) {
        Some(Json::String(existing)) if !existing.is_empty() => {
            existing.push_str("; ");
            existing.push_str(value);
        }
        _ => {
            input.properties.insert(key, Json::from(value));
        }
    }
}

pub fn text<'a>(fields: &'a Map<String, Json>, name: &str) -> Option<&'a str> {
    fields.get(name).and_then(Json::as_str).map(str::trim).filter(|s| !s.is_empty())
}

pub fn clean_doi(value: &str) -> String {
    let v = value.trim();
    let lower = v.to_ascii_lowercase();
    for prefix in ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi.org/", "doi:", "doi "] {
        if lower.starts_with(prefix) {
            return v[prefix.len()..].trim().to_string();
        }
    }
    v.to_string()
}

/// "123--130" and "123–130" are stored as "123-130".
pub fn clean_pages(value: &str) -> String {
    value.replace("--", "-").replace(['–', '—'], "-").split_whitespace().collect::<Vec<_>>().join(" ").replace(" - ", "-")
}

pub fn year_of(date: &str) -> Option<i64> {
    let bytes = date.as_bytes();
    (0..bytes.len().saturating_sub(3)).find_map(|i| {
        let window = &bytes[i..i + 4];
        let before = i == 0 || !bytes[i - 1].is_ascii_digit();
        let after = i + 4 == bytes.len() || !bytes[i + 4].is_ascii_digit();
        (before && after && window.iter().all(u8::is_ascii_digit)).then(|| std::str::from_utf8(window).ok()?.parse().ok()).flatten()
    })
}

pub fn month_number(value: &str) -> Option<u32> {
    let v = value.trim().trim_end_matches('.').to_lowercase();
    if let Ok(n) = v.parse::<u32>() {
        return (1..=12).contains(&n).then_some(n);
    }
    const NAMES: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    NAMES.iter().position(|m| v.starts_with(m)).map(|i| i as u32 + 1)
}

/// "2020", "2020-05" or "2020-05-03" from parts.
pub fn iso_date(year: &str, month: Option<&str>, day: Option<&str>) -> String {
    let mut out = year.trim().to_string();
    if let Some(month) = month.and_then(month_number) {
        out.push_str(&format!("-{month:02}"));
        if let Some(day) = day.and_then(|d| d.trim().parse::<u32>().ok()).filter(|d| (1..=31).contains(d)) {
            out.push_str(&format!("-{day:02}"));
        }
    }
    out
}

/// (year, month, day) of an ISO-like date ("2020-05-03", "2020/05", "2020").
pub fn date_parts(date: &str) -> Option<(i64, Option<u32>, Option<u32>)> {
    let year = year_of(date)?;
    let rest = date.trim();
    let parts: Vec<&str> = rest.split(['-', '/']).collect();
    if parts.first().map(|p| p.trim()) != Some(&year.to_string()) {
        return Some((year, None, None));
    }
    let month = parts.get(1).and_then(|m| m.trim().parse::<u32>().ok()).filter(|m| (1..=12).contains(m));
    let day = month.and(parts.get(2)).and_then(|d| d.trim().get(..2.min(d.trim().len()))).and_then(|d| d.parse::<u32>().ok()).filter(|d| (1..=31).contains(d));
    Some((year, month, day))
}

/// Keywords as tags: split on commas or semicolons (one kind per value).
pub fn keywords(value: &str) -> Vec<String> {
    let separator = if value.contains(';') { ';' } else { ',' };
    value.split(separator).map(|k| k.trim().trim_matches('"').trim().to_string()).filter(|k| !k.is_empty()).collect()
}

pub fn add_tags(input: &mut SourceInput, tags: impl IntoIterator<Item = String>) {
    for tag in tags {
        if !input.tags.iter().any(|t| t.eq_ignore_ascii_case(&tag)) {
            input.tags.push(tag);
        }
    }
}

/// The library kind for an item type: everything imported is a reference until a file comes with it.
pub fn reference_input(item_type: &str) -> SourceInput {
    let mut input = SourceInput { kind: "reference".into(), ..Default::default() };
    input.fields.insert("itemType".into(), Json::from(item_type));
    input
}

/// Paths in a BibTeX `file` field: JabRef ("Description:path:PDF;…"), Mendeley (":path:pdf")
/// or plain paths separated by semicolons. Escaped `\:` and `\;` are kept.
pub fn file_paths(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    for entry in split_unescaped(value, ';') {
        let parts = split_unescaped(&entry, ':');
        let path = match parts.len() {
            0 => continue,
            1 => parts[0].clone(),
            // `C:/…` (a drive letter) or `Description:/path`.
            2 if parts[0].trim().len() == 1 => format!("{}:{}", parts[0].trim(), parts[1]),
            2 if looks_like_path(&parts[1]) => parts[1].clone(),
            2 => parts.join(":"),
            n => parts[1..n - 1].join(":"),
        };
        let path = path.trim().replace("\\:", ":").replace("\\;", ";").replace("\\\\", "\\");
        if !path.is_empty() {
            out.push(path);
        }
    }
    out
}

fn looks_like_path(text: &str) -> bool {
    text.starts_with('/') || text.starts_with("~/") || text.contains('\\') || text.ends_with(".pdf") || text.ends_with(".PDF")
}

fn split_unescaped(value: &str, separator: char) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut escaped = false;
    for c in value.chars() {
        if escaped {
            parts.last_mut().unwrap().push('\\');
            parts.last_mut().unwrap().push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == separator {
            parts.push(String::new());
        } else {
            parts.last_mut().unwrap().push(c);
        }
    }
    parts.into_iter().filter(|p| !p.trim().is_empty() || separator == ':').collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_file_fields() {
        assert_eq!(file_paths("/Users/a/paper.pdf"), ["/Users/a/paper.pdf"]);
        assert_eq!(file_paths(":/Users/a/paper.pdf:pdf"), ["/Users/a/paper.pdf"]);
        assert_eq!(file_paths("Full Text:/Users/a/paper.pdf:PDF;Notes:/Users/a/n.txt:text/plain"), ["/Users/a/paper.pdf", "/Users/a/n.txt"]);
        assert_eq!(file_paths("/a/one.pdf;/a/two.pdf"), ["/a/one.pdf", "/a/two.pdf"]);
        assert_eq!(file_paths(r"PDF:C\:/papers/x.pdf:PDF"), ["C:/papers/x.pdf"]);
    }

    #[test]
    fn dates_and_pages() {
        assert_eq!(year_of("in press 2021a"), Some(2021));
        assert_eq!(year_of("in press"), None);
        assert_eq!(year_of("2021"), Some(2021));
        assert_eq!(year_of("May 2019"), Some(2019));
        assert_eq!(iso_date("2020", Some("may"), Some("3")), "2020-05-03");
        assert_eq!(date_parts("2020-05-03"), Some((2020, Some(5), Some(3))));
        assert_eq!(clean_pages("123--130"), "123-130");
        assert_eq!(clean_doi("https://doi.org/10.1/X"), "10.1/X");
    }
}
