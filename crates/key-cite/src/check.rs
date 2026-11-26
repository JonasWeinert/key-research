//! The reference checker: rules over a document's (or note's) citations and reference list,
//! given what the library knows about each cited work. No network and no guessing: every
//! issue names the citations it is about, and the fixes offered are the safe ones (cite the
//! published version or the kept duplicate, tidy a locator, add the missing bibliography,
//! restore a trashed source).
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::HashMap;

/// One cited work in one citation.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem {
    pub id: String,
    #[serde(default)]
    pub locator: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

/// What the library knows about a cited work.
#[derive(Clone, Debug, Default)]
pub struct CheckSource {
    pub title: String,
    pub in_library: bool,
    pub trashed: bool,
    /// The notice kind (retraction, expression_of_concern, …) when flagged and not dismissed.
    pub notice: Option<String>,
    /// The CSL-JSON the work renders from.
    pub item: Json,
    pub preprint: bool,
    /// The published version of a preprint, when the library has it: (id, title).
    pub published: Option<(String, String)>,
}

#[derive(Clone, Debug, Default)]
pub struct CheckInput {
    pub citations: Vec<Vec<CheckItem>>,
    /// Works the reference list shows; `None` when the document has no reference list.
    pub bibliography: Option<Vec<String>>,
    /// The style's format: author-date, numeric, note, label, author.
    pub format: String,
    pub note_style: bool,
    pub sources: HashMap<String, CheckSource>,
    /// Cited works the library considers the same work: (a, b, reason).
    pub duplicates: Vec<(String, String, String)>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "action")]
pub enum Fix {
    /// Cite `to` wherever `from` is cited.
    Replace { from: String, to: String, label: String },
    /// Set one citation item's locator.
    Locator { citation: usize, item: usize, locator: String, locator_label: String, label: String },
    InsertBibliography { label: String },
    Restore { id: String, label: String },
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// missing, trashed, uncited, retracted, fields, preprint, duplicate, locator, no-bibliography
    pub kind: String,
    /// error | warning | info
    pub severity: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// The citations (in document order) it is about.
    pub citations: Vec<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<Fix>,
}

fn issue(kind: &str, severity: &str, message: String, source_id: Option<&str>, citations: Vec<usize>, fix: Option<Fix>) -> Issue {
    Issue { kind: kind.into(), severity: severity.into(), message, source_id: source_id.map(String::from), citations, fix }
}

fn quoted(title: &str) -> String {
    let t = title.trim();
    let short: String = t.chars().take(60).collect();
    let short = if short.chars().count() < t.chars().count() { format!("{short}…") } else { short };
    if short.is_empty() { "Untitled".into() } else { format!("“{short}”") }
}

/// The CSL fields a style needs that the work lacks.
pub fn missing_fields(item: &Json, format: &str) -> Vec<&'static str> {
    let has = |key: &str| item.get(key).is_some_and(|v| match v {
        Json::String(s) => !s.trim().is_empty(),
        Json::Array(a) => !a.is_empty(),
        Json::Object(o) => !o.is_empty(),
        Json::Null => false,
        _ => true,
    });
    let mut out = Vec::new();
    let names = ["author", "editor", "translator", "director", "composer"].iter().any(|k| has(k));
    let date_based = matches!(format, "author-date" | "label" | "author");
    if !names && (date_based || format == "note") {
        out.push("author");
    }
    let year = item
        .get("issued")
        .is_some_and(|d| d.get("date-parts").and_then(Json::as_array).and_then(|p| p.first()).and_then(Json::as_array).is_some_and(|p| !p.is_empty()) || d.get("raw").or_else(|| d.get("literal")).is_some());
    if !year {
        out.push("year");
    }
    if !has("title") {
        out.push("title");
    }
    let kind = item.get("type").and_then(Json::as_str).unwrap_or("");
    if matches!(kind, "article-journal" | "chapter" | "paper-conference" | "article-magazine" | "article-newspaper") && !has("container-title") {
        out.push(match kind {
            "chapter" => "book title",
            "paper-conference" => "proceedings title",
            _ => "journal",
        });
    }
    out
}

/// "pp. 12-14" → ("12–14", "page"): a locator that repeats its label, or writes a range with
/// a hyphen, in the form the style expects.
pub fn tidy_locator(locator: &str, label: Option<&str>) -> Option<(String, String)> {
    let raw = locator.trim();
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_lowercase();
    let mut label = label.unwrap_or("page").to_string();
    let mut value = raw.to_string();
    for (prefixes, name) in [
        (&["pp.", "pp ", "p.", "p ", "pages ", "page "][..], "page"),
        (&["ch.", "chap.", "chapter "][..], "chapter"),
        (&["sec.", "§", "section "][..], "section"),
        (&["fig.", "figure "][..], "figure"),
        (&["para.", "¶", "paragraph "][..], "paragraph"),
        (&["vol.", "volume "][..], "volume"),
        (&["l.", "ll.", "line "][..], "line"),
    ] {
        if let Some(prefix) = prefixes.iter().find(|p| lower.starts_with(*p)) {
            value = raw[prefix.len()..].trim().to_string();
            label = name.to_string();
            break;
        }
    }
    // Number ranges take an en dash.
    let chars: Vec<char> = value.chars().collect();
    let mut tidied = String::with_capacity(value.len());
    for (i, c) in chars.iter().enumerate() {
        let between_digits = i > 0 && i + 1 < chars.len() && chars[i - 1].is_ascii_alphanumeric() && chars[i + 1].is_ascii_alphanumeric();
        if (*c == '-' || *c == '—') && between_digits && chars[i - 1].is_ascii_digit() {
            tidied.push('–');
        } else {
            tidied.push(*c);
        }
    }
    let tidied = tidied.replace(" – ", "–").replace(" - ", "–");
    (tidied != raw).then_some((tidied, label))
}

pub fn check(input: &CheckInput) -> Vec<Issue> {
    let mut issues = Vec::new();
    // Where each work is cited.
    let mut cited: Vec<String> = Vec::new();
    let mut at: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, citation) in input.citations.iter().enumerate() {
        for item in citation {
            if !cited.contains(&item.id) {
                cited.push(item.id.clone());
            }
            let list = at.entry(item.id.as_str()).or_default();
            if !list.contains(&index) {
                list.push(index);
            }
        }
    }
    let places = |id: &str| at.get(id).cloned().unwrap_or_default();
    for id in &cited {
        let Some(source) = input.sources.get(id) else {
            issues.push(issue("missing", "error", "A citation names a work that is not in your library and carries no details".into(), Some(id), places(id), None));
            continue;
        };
        let name = quoted(&source.title);
        if !source.in_library {
            issues.push(issue("missing", "warning", format!("{name} is not in your library; it is rendered from the details saved in the document"), Some(id), places(id), None));
        } else if source.trashed {
            issues.push(issue(
                "trashed",
                "warning",
                format!("{name} is in the trash"),
                Some(id),
                places(id),
                Some(Fix::Restore { id: id.clone(), label: "Restore".into() }),
            ));
        }
        if let Some(kind) = &source.notice {
            let what = match kind.as_str() {
                "retraction" | "removal" => "has been retracted",
                "withdrawal" => "has been withdrawn",
                "expression_of_concern" | "expression-of-concern" => "has an expression of concern",
                "correction" | "erratum" | "corrigendum" => "has a published correction",
                "partial_retraction" | "partial-retraction" => "has been partly retracted",
                _ => "has a notice from its publisher",
            };
            let severity = if matches!(kind.as_str(), "retraction" | "removal" | "withdrawal") { "error" } else { "warning" };
            issues.push(issue("retracted", severity, format!("{name} {what}"), Some(id), places(id), None));
        }
        let missing = missing_fields(&source.item, &input.format);
        if !missing.is_empty() {
            issues.push(issue("fields", "warning", format!("{name} has no {}", join_words(&missing)), Some(id), places(id), None));
        }
        if source.preprint {
            match &source.published {
                Some((published, title)) if !cited.contains(published) => issues.push(issue(
                    "preprint",
                    "info",
                    format!("{name} is a preprint; its published version {} is in your library", quoted(title)),
                    Some(id),
                    places(id),
                    Some(Fix::Replace { from: id.clone(), to: published.clone(), label: "Cite the published version".into() }),
                )),
                _ => {}
            }
        }
    }
    for (a, b, reason) in &input.duplicates {
        if !(cited.contains(a) && cited.contains(b)) {
            continue;
        }
        let title = input.sources.get(a).map(|s| s.title.as_str()).unwrap_or("");
        let mut citations = places(a);
        for c in places(b) {
            if !citations.contains(&c) {
                citations.push(c);
            }
        }
        citations.sort_unstable();
        // Keep the work cited first; the other becomes it.
        let (keep, other) = if cited.iter().position(|c| c == a) <= cited.iter().position(|c| c == b) { (a, b) } else { (b, a) };
        issues.push(issue(
            "duplicate",
            "warning",
            format!("{} is cited as two different works ({})", quoted(title), reason.to_lowercase()),
            Some(other),
            citations,
            Some(Fix::Replace { from: other.clone(), to: keep.clone(), label: "Cite one of them".into() }),
        ));
    }
    if let Some(listed) = &input.bibliography {
        for id in listed.iter().filter(|id| !cited.contains(id)) {
            let title = input.sources.get(id).map(|s| s.title.as_str()).unwrap_or("");
            issues.push(issue("uncited", "info", format!("{} is in the reference list but never cited", quoted(title)), Some(id), vec![], None));
        }
        for id in cited.iter().filter(|id| !listed.contains(id)) {
            let title = input.sources.get(id).map(|s| s.title.as_str()).unwrap_or("");
            issues.push(issue("unlisted", "warning", format!("{} is cited but not in the reference list", quoted(title)), Some(id), places(id), None));
        }
    } else if !cited.is_empty() && !input.note_style {
        issues.push(issue("no-bibliography", "info", "The document cites works but has no reference list".into(), None, vec![], Some(Fix::InsertBibliography { label: "Add a bibliography".into() })));
    }
    // Locators written in different ways: each one that is not in the plain form.
    let mut locator_forms: Vec<(usize, usize, String, String)> = Vec::new();
    for (ci, citation) in input.citations.iter().enumerate() {
        for (ii, item) in citation.iter().enumerate() {
            if let Some(locator) = item.locator.as_deref()
                && let Some((value, label)) = tidy_locator(locator, item.label.as_deref())
            {
                locator_forms.push((ci, ii, value, label));
            }
        }
    }
    for (citation, item, locator, label) in locator_forms {
        let original = input.citations[citation][item].locator.clone().unwrap_or_default();
        issues.push(issue(
            "locator",
            "info",
            format!("Locator “{original}” reads better as “{locator}”: the style adds labels and dashes itself"),
            Some(&input.citations[citation][item].id),
            vec![citation],
            Some(Fix::Locator { citation, item, locator: locator.clone(), locator_label: label, label: format!("Use “{locator}”") }),
        ));
    }
    let rank = |s: &str| match s {
        "error" => 0,
        "warning" => 1,
        _ => 2,
    };
    issues.sort_by_key(|i| (rank(&i.severity), i.citations.first().copied().unwrap_or(usize::MAX)));
    issues
}

fn join_words(words: &[&str]) -> String {
    match words {
        [] => String::new(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source(title: &str, item: Json) -> CheckSource {
        CheckSource { title: title.into(), in_library: true, item, ..Default::default() }
    }
    fn cite(id: &str) -> CheckItem {
        CheckItem { id: id.into(), ..Default::default() }
    }
    fn full(id: &str) -> Json {
        json!({ "id": id, "type": "article-journal", "title": "T", "author": [{ "family": "Doe" }], "issued": { "date-parts": [[2020]] }, "container-title": "J" })
    }

    #[test]
    fn clean_document_has_no_issues() {
        let mut input = CheckInput { citations: vec![vec![cite("a")], vec![cite("b")]], bibliography: Some(vec!["a".into(), "b".into()]), format: "author-date".into(), ..Default::default() };
        input.sources.insert("a".into(), source("A", full("a")));
        input.sources.insert("b".into(), source("B", full("b")));
        assert!(check(&input).is_empty(), "{:?}", check(&input));
    }

    #[test]
    fn rules() {
        let mut input = CheckInput {
            citations: vec![vec![cite("a"), CheckItem { id: "b".into(), locator: Some("pp. 12-14".into()), label: None }], vec![cite("pre"), cite("dup")], vec![cite("gone"), cite("ret")]],
            bibliography: Some(vec!["a".into(), "b".into(), "pre".into(), "dup".into(), "ret".into(), "extra".into()]),
            format: "author-date".into(),
            duplicates: vec![("a".into(), "dup".into(), "Same DOI".into())],
            ..Default::default()
        };
        input.sources.insert("a".into(), source("A", full("a")));
        input.sources.insert("b".into(), source("B", json!({ "type": "article-journal", "title": "B" })));
        input.sources.insert("pre".into(), CheckSource { preprint: true, published: Some(("pub".into(), "Published".into())), ..source("Pre", full("pre")) });
        input.sources.insert("dup".into(), source("A again", full("dup")));
        input.sources.insert("ret".into(), CheckSource { notice: Some("retraction".into()), trashed: true, ..source("R", full("ret")) });
        let issues = check(&input);
        let kinds: Vec<&str> = issues.iter().map(|i| i.kind.as_str()).collect();
        for kind in ["missing", "trashed", "retracted", "fields", "preprint", "duplicate", "uncited", "unlisted", "locator"] {
            assert!(kinds.contains(&kind), "{kind} missing from {kinds:?}");
        }
        // Errors first: the unknown work and the retraction.
        assert_eq!(issues[0].severity, "error");
        let fields = issues.iter().find(|i| i.kind == "fields").unwrap();
        assert!(fields.message.contains("author, year or journal"), "{}", fields.message);
        let dup = issues.iter().find(|i| i.kind == "duplicate").unwrap();
        assert_eq!(dup.fix, Some(Fix::Replace { from: "dup".into(), to: "a".into(), label: "Cite one of them".into() }));
        assert_eq!(dup.citations, vec![0, 1]);
        let locator = issues.iter().find(|i| i.kind == "locator").unwrap();
        assert_eq!(locator.fix, Some(Fix::Locator { citation: 0, item: 1, locator: "12–14".into(), locator_label: "page".into(), label: "Use “12–14”".into() }));
        let preprint = issues.iter().find(|i| i.kind == "preprint").unwrap();
        assert!(matches!(&preprint.fix, Some(Fix::Replace { to, .. }) if to == "pub"));
        assert!(issues.iter().any(|i| i.kind == "uncited" && i.source_id.as_deref() == Some("extra")));
    }

    #[test]
    fn missing_bibliography_and_locators() {
        let mut input = CheckInput { citations: vec![vec![cite("a")]], format: "numeric".into(), ..Default::default() };
        input.sources.insert("a".into(), source("A", full("a")));
        let issues = check(&input);
        assert_eq!(issues.len(), 1);
        assert!(matches!(issues[0].fix, Some(Fix::InsertBibliography { .. })));
        input.note_style = true;
        assert!(check(&input).is_empty());
        assert_eq!(tidy_locator("12", None), None);
        assert_eq!(tidy_locator("12–14", None), None);
        assert_eq!(tidy_locator("12-14", None), Some(("12–14".into(), "page".into())));
        assert_eq!(tidy_locator("ch. 3", None), Some(("3".into(), "chapter".into())));
        assert_eq!(tidy_locator("p. 4", Some("page")), Some(("4".into(), "page".into())));
    }
}
