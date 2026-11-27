// Criteria linked to metadata: each linked criterion says, from a record's fields (and its
// library source's custom properties, or a Key formula), whether it is met. An inclusion
// criterion that is not met, or an exclusion criterion that is met, suggests "Exclude" with the
// criterion as the reason — shown to the reviewer, or applied by the "rules" actor when the
// criterion's effect is `auto`. Missing data never suggests anything.
use crate::model::*;
use serde::Serialize;
use serde_json::{Map, Value as Json, json};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub criterion_id: String,
    pub label: String,
    pub value: Choice,
    pub reason_id: Option<String>,
    /// The rule in words ("Year is before 2000").
    pub rule: String,
    pub auto: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub criterion_id: String,
    pub label: String,
    /// true: met, false: not met, null: unknown (data missing).
    pub met: Option<bool>,
    pub rule: String,
}

/// The names a rule (or a formula) reads on a record.
pub fn context(meta: &RecordMeta, has_full_text: bool, properties: &Map<String, Json>) -> Map<String, Json> {
    let mut m = Map::new();
    m.insert("title".into(), json!(meta.title));
    m.insert("abstract".into(), json!(meta.abstract_text));
    m.insert("year".into(), meta.year.map(Json::from).unwrap_or(Json::Null));
    m.insert("itemType".into(), json!(meta.item_type));
    m.insert("language".into(), json!(meta.language));
    m.insert("journal".into(), json!(meta.journal));
    m.insert("doi".into(), json!(meta.doi));
    m.insert("keywords".into(), json!(meta.keywords));
    m.insert("authors".into(), json!(meta.authors));
    m.insert("hasAbstract".into(), json!(!meta.abstract_text.trim().is_empty()));
    m.insert("hasFullText".into(), json!(has_full_text));
    m.insert("hasDoi".into(), json!(!meta.doi.trim().is_empty()));
    for (k, v) in &meta.extra {
        m.entry(k.clone()).or_insert_with(|| v.clone());
    }
    for (k, v) in properties {
        m.insert(format!("property:{k}"), v.clone());
        m.entry(k.clone()).or_insert_with(|| v.clone());
    }
    m
}

fn label_of(field: &str) -> String {
    match field {
        "itemType" => "Document type".into(),
        "year" => "Year".into(),
        "language" => "Language".into(),
        "title" => "Title".into(),
        "abstract" => "Abstract".into(),
        "journal" => "Journal".into(),
        "keywords" => "Keywords".into(),
        "authors" => "Authors".into(),
        "doi" => "DOI".into(),
        "hasAbstract" => "Has an abstract".into(),
        "hasFullText" => "Has full text".into(),
        "hasDoi" => "Has a DOI".into(),
        "formula" => "Formula".into(),
        other => other.strip_prefix("property:").unwrap_or(other).to_string(),
    }
}

fn value_text(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Array(a) => a.iter().map(value_text).collect::<Vec<_>>().join(", "),
        Json::Null => String::new(),
        other => other.to_string(),
    }
}

/// A condition in words.
pub fn describe(c: &Condition) -> String {
    let field = label_of(&c.field);
    let v = value_text(&c.value);
    match c.op.as_str() {
        _ if c.field == "formula" => format!("Formula {v}"),
        "is" => format!("{field} is {v}"),
        "isNot" => format!("{field} is not {v}"),
        "lt" => format!("{field} is before {v}"),
        "le" => format!("{field} is {v} or earlier"),
        "gt" => format!("{field} is after {v}"),
        "ge" => format!("{field} is {v} or later"),
        "contains" => format!("{field} contains \"{v}\""),
        "notContains" => format!("{field} does not contain \"{v}\""),
        "oneOf" => format!("{field} is one of {v}"),
        "exists" | "true" => format!("{field}"),
        "missing" | "false" => format!("{field}: no"),
        other => format!("{field} {other} {v}"),
    }
}

pub fn describe_link(link: &MetadataLink) -> String {
    let parts: Vec<String> = link.conditions.iter().map(describe).collect();
    parts.join(if link.all { " and " } else { " or " })
}

fn as_number(v: &Json) -> Option<f64> {
    match v {
        Json::Number(n) => n.as_f64(),
        Json::String(s) => s.trim().parse().ok(),
        Json::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn is_empty(v: &Json) -> bool {
    match v {
        Json::Null => true,
        Json::String(s) => s.trim().is_empty(),
        Json::Array(a) => a.is_empty(),
        _ => false,
    }
}

fn texts(v: &Json) -> Vec<String> {
    match v {
        Json::Array(a) => a.iter().map(|x| value_text(x).to_lowercase()).collect(),
        other => vec![value_text(other).to_lowercase()],
    }
}

/// Whether one condition holds: `None` when the record lacks the data to say.
pub fn evaluate(c: &Condition, ctx: &Map<String, Json>) -> Option<bool> {
    if c.field == "formula" {
        let source = value_text(&c.value);
        return match key_store::formula::evaluate(&source, ctx) {
            Ok(v) => match v.to_json() {
                Json::Bool(b) => Some(b),
                Json::Null => None,
                Json::Number(n) => Some(n.as_f64().unwrap_or(0.0) != 0.0),
                Json::String(s) => Some(!s.is_empty()),
                other => Some(!is_empty(&other)),
            },
            Err(_) => None,
        };
    }
    let v = ctx.get(&c.field).cloned().unwrap_or(Json::Null);
    match c.op.as_str() {
        "exists" | "true" => Some(match &v {
            Json::Bool(b) => *b,
            other => !is_empty(other),
        }),
        "missing" | "false" => Some(match &v {
            Json::Bool(b) => !*b,
            other => is_empty(other),
        }),
        _ if is_empty(&v) => None,
        "lt" | "le" | "gt" | "ge" => {
            let (a, b) = (as_number(&v)?, as_number(&c.value)?);
            Some(match c.op.as_str() {
                "lt" => a < b,
                "le" => a <= b,
                "gt" => a > b,
                _ => a >= b,
            })
        }
        "is" | "isNot" => {
            let wanted = value_text(&c.value).trim().to_lowercase();
            let hit = match (as_number(&v), as_number(&c.value)) {
                (Some(a), Some(b)) if matches!(v, Json::Number(_)) => a == b,
                _ => texts(&v).iter().any(|t| t.trim() == wanted),
            };
            Some(if c.op == "is" { hit } else { !hit })
        }
        "oneOf" => {
            let options: Vec<String> = texts(&c.value).into_iter().flat_map(|t| t.split(',').map(|s| s.trim().to_string()).collect::<Vec<_>>()).filter(|s| !s.is_empty()).collect();
            Some(texts(&v).iter().any(|t| options.iter().any(|o| o == t.trim())))
        }
        "contains" | "notContains" => {
            let needle = value_text(&c.value).to_lowercase();
            if needle.is_empty() {
                return None;
            }
            let hit = texts(&v).iter().any(|t| t.contains(&needle));
            Some(if c.op == "contains" { hit } else { !hit })
        }
        _ => None,
    }
}

pub fn met(link: &MetadataLink, ctx: &Map<String, Json>) -> Option<bool> {
    if link.conditions.is_empty() {
        return None;
    }
    let results: Vec<Option<bool>> = link.conditions.iter().map(|c| evaluate(c, ctx)).collect();
    if link.all {
        if results.contains(&Some(false)) {
            Some(false)
        } else if results.iter().all(|r| *r == Some(true)) {
            Some(true)
        } else {
            None
        }
    } else if results.contains(&Some(true)) {
        Some(true)
    } else if results.iter().all(|r| *r == Some(false)) {
        Some(false)
    } else {
        None
    }
}

/// Whether a linked criterion is met (`None`: the record lacks the data to say).
fn passes(link: &MetadataLink, ctx: &Map<String, Json>) -> Option<bool> {
    met(link, ctx).map(|m| if link.fails_when { !m } else { m })
}

/// Every linked criterion of `stage` checked against a record.
pub fn checks(protocol: &Protocol, stage: Stage, ctx: &Map<String, Json>) -> Vec<Check> {
    protocol
        .criteria_at(stage)
        .filter_map(|c| c.link.as_ref().map(|l| (c, l)))
        .map(|(c, l)| Check { criterion_id: c.id.clone(), label: c.label.clone(), met: passes(l, ctx), rule: describe_link(l) })
        .collect()
}

/// What the linked criteria suggest for a record: exclude, for each criterion it does not meet
/// (which is then the reason), in criterion order.
pub fn suggestions(protocol: &Protocol, stage: Stage, ctx: &Map<String, Json>) -> Vec<Suggestion> {
    let mut out = Vec::new();
    for c in protocol.criteria_at(stage) {
        let Some(link) = &c.link else { continue };
        if passes(link, ctx) != Some(false) {
            continue;
        }
        let rule = describe_link(link);
        out.push(Suggestion {
            criterion_id: c.id.clone(),
            label: c.label.clone(),
            value: Choice::Exclude,
            reason_id: Some(c.id.clone()),
            rule: if link.fails_when { rule } else { format!("Not met: {rule}") },
            auto: link.effect == "auto",
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> RecordMeta {
        RecordMeta { id: "r1".into(), title: "A trial of tea".into(), year: Some(1998), item_type: "journalArticle".into(), language: "en".into(), ..Default::default() }
    }

    #[test]
    fn linked_criteria_suggest_and_describe() {
        let mut p = Protocol::default();
        p.criteria.push(Criterion {
            id: "c-year".into(),
            label: "Published 2000 or later".into(),
            link: Some(MetadataLink { conditions: vec![Condition { field: "year".into(), op: "ge".into(), value: json!(2000) }], all: true, effect: "suggest".into(), fails_when: false }),
            ..Default::default()
        });
        p.criteria.push(Criterion {
            id: "c-abstract".into(),
            label: "Has an abstract".into(),
            stages: vec![Stage::Ta],
            link: Some(MetadataLink { conditions: vec![Condition { field: "hasAbstract".into(), op: "true".into(), value: Json::Null }], all: true, effect: "auto".into(), fails_when: false }),
            ..Default::default()
        });
        let ctx = context(&meta(), false, &Map::new());
        let s = suggestions(&p, Stage::Ta, &ctx);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].rule, "Not met: Year is 2000 or later");
        assert!(!s[0].auto && s[1].auto);
        // Full text: only the year criterion applies.
        assert_eq!(suggestions(&p, Stage::Ft, &ctx).len(), 1);
        // Missing data suggests nothing.
        let mut no_year = meta();
        no_year.year = None;
        no_year.abstract_text = "Something".into();
        assert!(suggestions(&p, Stage::Ta, &context(&no_year, false, &Map::new())).is_empty());
    }

    #[test]
    fn conditions_on_text_lists_properties_and_formulas() {
        let mut props = Map::new();
        props.insert("Design".into(), json!("RCT"));
        let mut m = meta();
        m.keywords = vec!["Green Tea".into(), "Adults".into()];
        let ctx = context(&m, true, &props);
        let c = |field: &str, op: &str, value: Json| evaluate(&Condition { field: field.into(), op: op.into(), value }, &ctx);
        assert_eq!(c("keywords", "contains", json!("green")), Some(true));
        assert_eq!(c("itemType", "oneOf", json!("book, journalArticle")), Some(true));
        assert_eq!(c("property:Design", "is", json!("rct")), Some(true));
        assert_eq!(c("language", "isNot", json!("en")), Some(false));
        assert_eq!(c("hasFullText", "true", Json::Null), Some(true));
        assert_eq!(c("formula", "true", json!("{year} < 2000")), Some(true));
        assert_eq!(c("journal", "is", json!("X")), None);
    }
}
