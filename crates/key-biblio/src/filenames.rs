// File naming rules: a template (`{{firstCreator}} - {{year}} - {{title | truncate 60}}`)
// turned into a name that is safe on macOS, Windows and cloud folders. Used for the name a
// managed file shows, is dragged out and exported under (managed storage itself stays named
// by content), for the readable mirror folder, for exported Markdown files, and, when the
// user asks, to rename linked files in place.
use crate::template::{self, Template};
use key_store::Source;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};
use std::collections::HashSet;

pub const DEFAULT_TEMPLATE: &str = "{{firstCreator}} - {{year}} - {{title | truncate 60}}";
const META: &str = "files.naming";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Case {
    #[default]
    Keep,
    Lower,
    Upper,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NamingRules {
    pub template: String,
    /// Removes diacritics (é → e, ß → ss).
    pub ascii: bool,
    pub case: Case,
    /// Replaces spaces (e.g. with "_" or "-"); empty keeps them.
    pub separator: String,
    /// Characters, without the extension.
    pub max_length: usize,
    /// What goes before the number a taken name gets (" " → "Name 2").
    pub collision: String,
}

impl Default for NamingRules {
    fn default() -> Self {
        Self { template: DEFAULT_TEMPLATE.into(), ascii: false, case: Case::Keep, separator: String::new(), max_length: 120, collision: " ".into() }
    }
}

pub fn rules(store: &key_store::Store) -> Result<NamingRules, String> {
    Ok(store.meta(META)?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default())
}

pub fn save_rules(store: &key_store::Store, rules: &NamingRules) -> Result<(), String> {
    Template::parse(&rules.template)?;
    store.set_meta(META, &serde_json::to_string(rules).map_err(|e| e.to_string())?)
}

/// "Smith", "Smith and Jones", "Smith et al." (authors, else editors, else anyone).
pub fn first_creator(source: &Source) -> String {
    let family = |c: &key_store::Creator| c.family.clone().or_else(|| c.literal.clone()).or_else(|| c.given.clone()).unwrap_or_default();
    let by_role = |role: &str| source.creators.iter().filter(|c| c.role == role).collect::<Vec<_>>();
    let mut people = by_role("author");
    if people.is_empty() {
        people = by_role("editor");
    }
    if people.is_empty() {
        people = source.creators.iter().collect();
    }
    match people.as_slice() {
        [] => String::new(),
        [one] => family(one),
        [a, b] => format!("{} and {}", family(a), family(b)),
        [a, ..] => format!("{} et al.", family(a)),
    }
}

pub fn year(source: &Source) -> Option<String> {
    if let Some(y) = source.fields.get("year").and_then(Json::as_i64) {
        return Some(y.to_string());
    }
    let date = source.field("date")?;
    let digits: String = date.chars().skip_while(|c| !c.is_ascii_digit()).take(4).collect();
    (digits.len() == 4 && digits.chars().all(|c| c.is_ascii_digit())).then_some(digits)
}

/// The fields a naming template can use.
pub fn naming_context(source: &Source) -> Json {
    let authors: Vec<String> = source.creators.iter().filter(|c| c.role == "author").map(|c| c.family.clone().or_else(|| c.literal.clone()).unwrap_or_default()).collect();
    let mut out = Map::new();
    for (key, field) in [
        ("title", "title"),
        ("shortTitle", "shortTitle"),
        ("citekey", "citationKey"),
        ("itemType", "itemType"),
        ("journal", "containerTitle"),
        ("publisher", "publisher"),
        ("doi", "doi"),
        ("volume", "volume"),
        ("issue", "issue"),
        ("pages", "pages"),
    ] {
        out.insert(key.into(), source.field(field).map(Json::from).unwrap_or(Json::Null));
    }
    out.insert("firstCreator".into(), Json::from(first_creator(source)));
    out.insert("authors".into(), json!(authors));
    out.insert("year".into(), year(source).map(Json::from).unwrap_or(Json::Null));
    out.insert("id".into(), Json::from(source.id.clone()));
    Json::Object(out)
}

/// The file's name (without extension) under the rules; "Untitled" when nothing is left.
pub fn base_name(source: &Source, rules: &NamingRules, template: &Template) -> String {
    let rendered = template.render(&naming_context(source));
    let name = clean(&rendered, rules);
    if name.is_empty() {
        let title = clean(source.title(), rules);
        return if title.is_empty() { "Untitled".into() } else { title };
    }
    name
}

/// A name with the source's file extension (`.pdf`), or `ext` when given.
pub fn file_name(source: &Source, rules: &NamingRules, template: &Template, ext: Option<&str>) -> String {
    let ext = ext.map(String::from).or_else(|| source.file_path().and_then(|p| p.extension().map(|e| e.to_string_lossy().to_lowercase())));
    let base = base_name(source, rules, template);
    match ext.filter(|e| !e.is_empty()) {
        Some(ext) => format!("{base}.{ext}"),
        None => base,
    }
}

const RESERVED: &[&str] = &["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];

/// One path component, safe everywhere: no `/ \ : * ? " < > |` or control characters, no
/// leading dot (a hidden file), no trailing dot or space, spaces collapsed, within
/// `max_length` characters and 240 bytes (APFS allows 255), not a Windows device name.
pub fn clean(text: &str, rules: &NamingRules) -> String {
    let folded = if rules.ascii { template::fold_ascii(text) } else { text.to_string() };
    let mut out = String::with_capacity(folded.len());
    let mut space = false;
    for c in folded.chars() {
        let c = match c {
            '/' | '\\' | '|' => '-',
            ':' => {
                // "Title: subtitle" reads best as "Title - subtitle".
                if !out.ends_with(' ') {
                    out.push(' ');
                }
                out.push('-');
                ' '
            }
            '*' | '?' | '"' | '<' | '>' => {
                if c == '"' {
                    '\''
                } else {
                    continue;
                }
            }
            c if c.is_whitespace() => ' ',
            c if c.is_control() || c == '\u{feff}' || c == '\u{200b}' => continue,
            c => c,
        };
        if c == ' ' {
            if space || out.is_empty() {
                continue;
            }
            space = true;
        } else {
            space = false;
        }
        out.push(c);
    }
    let mut out = out.trim().trim_start_matches('.').trim().to_string();
    out = match rules.case {
        Case::Keep => out,
        Case::Lower => out.to_lowercase(),
        Case::Upper => out.to_uppercase(),
    };
    if !rules.separator.is_empty() {
        let sep = clean_separator(&rules.separator);
        out = out.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(&sep);
    }
    let max = rules.max_length.clamp(8, 240);
    if out.chars().count() > max {
        out = template::truncate(&out, max);
    }
    while out.len() > 240 {
        out.pop();
    }
    let out = out.trim_end_matches(['.', ' ', '-', '_']).trim_end().to_string();
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return format!("{out}_");
    }
    out
}

fn clean_separator(sep: &str) -> String {
    sep.chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()).collect()
}

/// `name.ext`, or `name 2.ext`, `name 3.ext` … the first that `taken` does not hold
/// (compared without case, as macOS volumes usually are).
pub fn unique(name: &str, rules: &NamingRules, taken: &dyn Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && e.len() <= 8 && !e.contains(' ') => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    let sep = if rules.collision.is_empty() { " ".to_string() } else { clean_separator(&rules.collision) };
    (2..10_000).map(|n| format!("{stem}{sep}{n}{ext}")).find(|candidate| !taken(candidate)).unwrap_or_else(|| format!("{stem}{sep}{}{ext}", key_store::new_id()))
}

/// Names for many sources at once, distinct from each other (case-insensitively).
pub fn distinct_names(sources: &[&Source], rules: &NamingRules, ext: Option<&str>) -> Result<Vec<String>, String> {
    let template = Template::parse(&rules.template)?;
    let mut seen: HashSet<String> = HashSet::new();
    Ok(sources
        .iter()
        .map(|s| {
            let name = unique(&file_name(s, rules, &template, ext), rules, &|n| seen.contains(&n.to_lowercase()));
            seen.insert(name.to_lowercase());
            name
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use key_store::Creator;

    fn source(title: &str, authors: &[&str], date: &str) -> Source {
        let mut value = json!({
            "id": "s1", "kind": "pdf", "tags": [], "properties": {}, "collections": [], "starred": false, "indexStatus": "none",
            "indexedChunks": 0, "indexTotal": 0, "addedAt": 0, "updatedAt": 0, "noteCount": 0, "annotationCount": 0,
            "title": title, "date": date, "filePath": "/x/abc123.PDF",
        });
        value["creators"] = json!(authors.iter().map(|a| Creator { family: Some(a.to_string()), role: "author".into(), ..Default::default() }).collect::<Vec<_>>());
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn default_rule() {
        let rules = NamingRules::default();
        let t = Template::parse(&rules.template).unwrap();
        assert_eq!(file_name(&source("On growth: a study", &["Smith"], "2020-03"), &rules, &t, None), "Smith - 2020 - On growth - a study.pdf");
        assert_eq!(file_name(&source("T", &["Smith", "Jones"], "1999"), &rules, &t, None), "Smith and Jones - 1999 - T.pdf");
        assert_eq!(file_name(&source("T", &["Smith", "Jones", "Lee"], ""), &rules, &t, None), "Smith et al. - - T.pdf");
    }

    #[test]
    fn edge_cases() {
        let rules = NamingRules::default();
        assert_eq!(clean("  ..hidden/one\\two*?<>|  ", &rules), "hidden-one-two");
        assert_eq!(clean("a\u{0}b\tc\n d", &rules), "ab c d");
        assert_eq!(clean("CON", &rules), "CON_");
        assert_eq!(clean("Say \"hi\".", &rules), "Say 'hi'");
        let ascii = NamingRules { ascii: true, case: Case::Lower, separator: "_".into(), ..Default::default() };
        assert_eq!(clean("Müller – Évolution des Systèmes", &ascii), "muller_-_evolution_des_systemes");
        let short = NamingRules { max_length: 20, ..Default::default() };
        assert_eq!(clean("A rather long title about many things", &short), "A rather long title");
        let long: String = "語".repeat(200);
        assert!(clean(&long, &NamingRules { max_length: 240, ..Default::default() }).len() <= 240);
        let t = Template::parse("{{nothing}}").unwrap();
        assert_eq!(base_name(&source("", &[], ""), &rules, &t), "Untitled");
    }

    #[test]
    fn collisions() {
        let rules = NamingRules::default();
        let taken = |n: &str| ["a.pdf", "a 2.pdf"].contains(&n.to_lowercase().as_str());
        assert_eq!(unique("A.pdf", &rules, &taken), "A 3.pdf");
        let a = source("Same", &["X"], "2000");
        let b = source("Same", &["X"], "2000");
        assert_eq!(distinct_names(&[&a, &b], &rules, None).unwrap(), vec!["X - 2000 - Same.pdf", "X - 2000 - Same 2.pdf"]);
    }
}
