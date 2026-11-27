// Extraction form logic: when a field or section shows (on other answers; inside a table, on the
// same row), cycles refused, what a study's form still lacks (required answers, quotes, source
// positions, cross-field checks) counting only what is shown, and reading numbers out of a
// passage selected in the reader ("12.3 (4.5)", "n = 120", "45%", "0.52 (0.31 to 0.88)", "12/120").
use crate::model::*;
use serde::Serialize;
use serde_json::{Map, Value as Json, json};
use std::collections::{BTreeMap, HashMap, HashSet};

pub type Answers = BTreeMap<String, Json>;

fn as_number(v: &Json) -> Option<f64> {
    match v {
        Json::Number(n) => n.as_f64(),
        Json::String(s) => s.trim().replace(',', ".").parse().ok(),
        Json::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

pub fn is_empty(v: Option<&Json>) -> bool {
    match v {
        None | Some(Json::Null) => true,
        Some(Json::String(s)) => s.trim().is_empty(),
        Some(Json::Array(a)) => a.is_empty(),
        _ => false,
    }
}

fn text_of(v: &Json) -> String {
    match v {
        Json::String(s) => s.trim().to_lowercase(),
        Json::Bool(true) => "yes".into(),
        Json::Bool(false) => "no".into(),
        Json::Null => String::new(),
        other => other.to_string().to_lowercase(),
    }
}

/// Whether a condition holds for `value` (the answer of the field it names).
pub fn condition_holds(c: &FieldCondition, value: Option<&Json>) -> bool {
    match c.op.as_str() {
        "filled" => !is_empty(value),
        "empty" => is_empty(value),
        "yes" => matches!(value, Some(Json::Bool(true))) || value.is_some_and(|v| text_of(v) == "yes"),
        "no" => matches!(value, Some(Json::Bool(false))) || value.is_some_and(|v| text_of(v) == "no"),
        _ if is_empty(value) => false,
        "lt" | "le" | "gt" | "ge" => {
            let (Some(a), Some(b)) = (value.and_then(as_number), as_number(&c.value)) else { return false };
            match c.op.as_str() {
                "lt" => a < b,
                "le" => a <= b,
                "gt" => a > b,
                _ => a >= b,
            }
        }
        "is" | "isNot" | "oneOf" => {
            let wanted: Vec<String> = match &c.value {
                Json::Array(a) => a.iter().map(text_of).collect(),
                other if c.op == "oneOf" => text_of(other).split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
                other => vec![text_of(other)],
            };
            // A multiple-choice answer holds when any of its options is wanted.
            let given: Vec<String> = match value.unwrap() {
                Json::Array(a) => a.iter().map(text_of).collect(),
                other => vec![text_of(other)],
            };
            let hit = given.iter().any(|g| wanted.contains(g));
            if c.op == "isNot" { !hit } else { hit }
        }
        _ => false,
    }
}

fn holds(rule: &ShowWhen, lookup: &dyn Fn(&str) -> (bool, Option<Json>)) -> bool {
    if rule.conditions.is_empty() {
        return true;
    }
    // A condition on a field that is itself hidden does not hold.
    let results = rule.conditions.iter().map(|c| {
        let (shown, value) = lookup(&c.field);
        shown && condition_holds(c, value.as_ref())
    });
    let results: Vec<bool> = results.collect();
    if rule.all { results.iter().all(|r| *r) } else { results.iter().any(|r| *r) }
}

/// The fields of a form that are shown for these answers (sections' rules included).
pub fn visible_fields(form: &Form, answers: &Answers) -> HashSet<String> {
    let mut section_of: HashMap<&str, &Section> = HashMap::new();
    let mut fields: HashMap<&str, &Field> = HashMap::new();
    for s in &form.sections {
        for f in &s.fields {
            section_of.insert(&f.id, s);
            fields.insert(&f.id, f);
        }
    }
    let mut memo: HashMap<String, bool> = HashMap::new();
    fn shown(id: &str, depth: usize, fields: &HashMap<&str, &Field>, section_of: &HashMap<&str, &Section>, answers: &Answers, memo: &mut HashMap<String, bool>) -> bool {
        if let Some(v) = memo.get(id) {
            return *v;
        }
        let Some(field) = fields.get(id) else { return false };
        if depth > 64 {
            return false;
        }
        let mut rules: Vec<&ShowWhen> = Vec::new();
        if let Some(s) = section_of.get(id).and_then(|s| s.show_when.as_ref()) {
            rules.push(s);
        }
        if let Some(r) = field.show_when.as_ref() {
            rules.push(r);
        }
        let mut ok = true;
        for rule in rules {
            let mut cache: HashMap<String, (bool, Option<Json>)> = HashMap::new();
            for c in &rule.conditions {
                if !cache.contains_key(&c.field) {
                    let visible = shown(&c.field, depth + 1, fields, section_of, answers, memo);
                    cache.insert(c.field.clone(), (visible, answers.get(&c.field).cloned()));
                }
            }
            if !holds(rule, &|f: &str| cache.get(f).cloned().unwrap_or((false, None))) {
                ok = false;
                break;
            }
        }
        memo.insert(id.to_string(), ok);
        ok
    }
    let ids: Vec<&str> = fields.keys().copied().collect();
    ids.into_iter().filter(|id| shown(id, 0, &fields, &section_of, answers, &mut memo)).map(str::to_string).collect()
}

/// The columns of a table shown on one row (rules on other columns of the same row, else on the
/// form's fields).
pub fn visible_columns(field: &Field, row: &Map<String, Json>, answers: &Answers, form_visible: &HashSet<String>) -> HashSet<String> {
    let column_ids: HashSet<&str> = field.columns.iter().map(|c| c.id.as_str()).collect();
    let mut memo: HashMap<String, bool> = HashMap::new();
    fn shown(id: &str, depth: usize, field: &Field, ids: &HashSet<&str>, row: &Map<String, Json>, answers: &Answers, form_visible: &HashSet<String>, memo: &mut HashMap<String, bool>) -> bool {
        if let Some(v) = memo.get(id) {
            return *v;
        }
        if depth > 64 {
            return false;
        }
        let Some(col) = field.columns.iter().find(|c| c.id == id) else {
            return form_visible.contains(id);
        };
        let ok = match &col.show_when {
            None => true,
            Some(rule) => {
                let mut cache: HashMap<String, (bool, Option<Json>)> = HashMap::new();
                for c in &rule.conditions {
                    let got = if ids.contains(c.field.as_str()) {
                        (shown(&c.field, depth + 1, field, ids, row, answers, form_visible, memo), row.get(&c.field).cloned())
                    } else {
                        (form_visible.contains(&c.field), answers.get(&c.field).cloned())
                    };
                    cache.insert(c.field.clone(), got);
                }
                holds(rule, &|f: &str| cache.get(f).cloned().unwrap_or((false, None)))
            }
        };
        memo.insert(id.to_string(), ok);
        ok
    }
    field.columns.iter().filter(|c| shown(&c.id, 0, field, &column_ids, row, answers, form_visible, &mut memo)).map(|c| c.id.clone()).collect()
}

/// Refuses references to fields that do not exist and rules that depend on themselves.
pub fn validate_form(form: &Form) -> Result<(), String> {
    let mut label: HashMap<String, String> = HashMap::new();
    let mut deps: HashMap<String, Vec<String>> = HashMap::new();
    for s in &form.sections {
        for f in &s.fields {
            label.insert(f.id.clone(), f.label.clone());
            let mut d: Vec<String> = Vec::new();
            for rule in [s.show_when.as_ref(), f.show_when.as_ref()].into_iter().flatten() {
                d.extend(rule.conditions.iter().map(|c| c.field.clone()));
            }
            deps.insert(f.id.clone(), d);
        }
    }
    for s in &form.sections {
        for f in &s.fields {
            for c in deps[&f.id].iter() {
                if !label.contains_key(c) {
                    return Err(format!("{}: “{}” is shown on an answer that is not in the form", form.name, f.label));
                }
            }
            // Columns: their rules may name the same row's columns or the form's fields.
            let cols: HashMap<&str, Vec<&str>> = f.columns.iter().map(|c| (c.id.as_str(), c.show_when.iter().flat_map(|r| r.conditions.iter().map(|x| x.field.as_str())).collect())).collect();
            for (col, refs) in &cols {
                for r in refs {
                    if !cols.contains_key(r) && !label.contains_key(*r) {
                        return Err(format!("{}: a column of “{}” is shown on an answer that is not in the form", form.name, f.label));
                    }
                    if r == col {
                        return Err(format!("{}: a column of “{}” cannot depend on itself", form.name, f.label));
                    }
                }
            }
            let mut state: HashMap<&str, u8> = HashMap::new();
            fn col_cycle<'a>(n: &'a str, cols: &HashMap<&'a str, Vec<&'a str>>, state: &mut HashMap<&'a str, u8>) -> bool {
                match state.get(n) {
                    Some(1) => return true,
                    Some(2) => return false,
                    _ => {}
                }
                state.insert(n, 1);
                for d in cols.get(n).into_iter().flatten() {
                    if cols.contains_key(d) && col_cycle(d, cols, state) {
                        return true;
                    }
                }
                state.insert(n, 2);
                false
            }
            for col in cols.keys() {
                if col_cycle(col, &cols, &mut state) {
                    return Err(format!("{}: the columns of “{}” are shown on each other in a circle; one has to come first", form.name, f.label));
                }
            }
        }
    }
    // Depth-first search for a cycle among the fields.
    let mut state: HashMap<String, u8> = HashMap::new();
    fn visit(n: &str, deps: &HashMap<String, Vec<String>>, state: &mut HashMap<String, u8>, path: &mut Vec<String>) -> Option<Vec<String>> {
        match state.get(n) {
            Some(1) => {
                let start = path.iter().position(|p| p == n).unwrap_or(0);
                return Some(path[start..].to_vec());
            }
            Some(2) => return None,
            _ => {}
        }
        state.insert(n.to_string(), 1);
        path.push(n.to_string());
        for d in deps.get(n).into_iter().flatten() {
            if let Some(cycle) = visit(d, deps, state, path) {
                return Some(cycle);
            }
        }
        path.pop();
        state.insert(n.to_string(), 2);
        None
    }
    let mut ids: Vec<&String> = deps.keys().collect();
    ids.sort();
    for id in ids {
        if let Some(cycle) = visit(id, &deps, &mut state, &mut Vec::new()) {
            let names: Vec<String> = cycle.iter().map(|c| format!("“{}”", label.get(c).cloned().unwrap_or_default())).collect();
            return Err(format!("{}: {} are shown on each other in a circle; one of them has to come first", form.name, names.join(" and ")));
        }
    }
    Ok(())
}

/// A rule in words: "Shown when Study type is Qualitative".
pub fn describe(rule: &ShowWhen, label: &dyn Fn(&str) -> String) -> String {
    let parts: Vec<String> = rule
        .conditions
        .iter()
        .map(|c| {
            let name = label(&c.field);
            let v = match &c.value {
                Json::Array(a) => a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect::<Vec<_>>().join(" or "),
                Json::String(s) => s.clone(),
                Json::Null => String::new(),
                other => other.to_string(),
            };
            match c.op.as_str() {
                "is" => format!("{name} is {v}"),
                "isNot" => format!("{name} is not {v}"),
                "oneOf" => format!("{name} is {v}"),
                "filled" => format!("{name} is answered"),
                "empty" => format!("{name} is not answered"),
                "yes" => format!("{name} is yes"),
                "no" => format!("{name} is no"),
                "lt" => format!("{name} is below {v}"),
                "le" => format!("{name} is at most {v}"),
                "gt" => format!("{name} is above {v}"),
                "ge" => format!("{name} is at least {v}"),
                other => format!("{name} {other} {v}"),
            }
        })
        .collect();
    format!("Shown when {}", parts.join(if rule.all { " and " } else { " or " }))
}

/// What a value of one field still lacks.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub form_id: String,
    pub field_id: String,
    /// The row of a table it is in.
    pub row: Option<usize>,
    /// required | quote | source | check
    pub kind: String,
    pub message: String,
}

/// One answer as the completeness check sees it.
#[derive(Clone, Debug, Default)]
pub struct Given {
    pub value: Json,
    pub quote: bool,
    pub source: bool,
}

/// The source rule for a field: its own, else the review's default.
pub fn source_rule<'a>(field: &'a Field, rules: &'a Rules) -> &'a str {
    if field.source.is_empty() { if rules.source_default.is_empty() { "none" } else { &rules.source_default } } else { &field.source }
}

fn check_fails(check: &FieldCheck, value: Option<&Json>, other: Option<&Json>) -> bool {
    let (Some(a), Some(b)) = (value.and_then(as_number), other.and_then(as_number).or_else(|| as_number(&check.value))) else { return false };
    !match check.op.as_str() {
        "lt" => a < b,
        "le" => a <= b,
        "gt" => a > b,
        "ge" => a >= b,
        "is" => (a - b).abs() < 1e-9,
        "isNot" => (a - b).abs() >= 1e-9,
        _ => true,
    }
}

/// What a form still lacks for these answers: required answers, quotes and source positions
/// where the rules ask for them, failed checks — for shown fields only.
pub fn issues(form: &Form, given: &BTreeMap<String, Given>, rules: &Rules) -> Vec<Issue> {
    let answers: Answers = given.iter().map(|(k, g)| (k.clone(), g.value.clone())).collect();
    let visible = visible_fields(form, &answers);
    let mut out = Vec::new();
    let issue = |f: &Field, row: Option<usize>, kind: &str, message: String| Issue { form_id: form.id.clone(), field_id: f.id.clone(), row, kind: kind.into(), message };
    for f in form.fields().filter(|f| visible.contains(&f.id)) {
        let g = given.get(&f.id);
        let value = g.map(|g| &g.value);
        let empty = is_empty(value);
        if f.required && empty {
            out.push(issue(f, None, "required", format!("{}: required", f.label)));
        }
        if !empty {
            if (f.quote || rules.quote_required) && !g.is_some_and(|g| g.quote) {
                out.push(issue(f, None, "quote", format!("{}: add the quote from the paper", f.label)));
            }
            if source_rule(f, rules) == "required" && !g.is_some_and(|g| g.source) {
                out.push(issue(f, None, "source", format!("{}: pick it from the document so its place is kept", f.label)));
            }
            for check in &f.checks {
                let other = check.other.as_ref().and_then(|o| answers.get(o));
                if check_fails(check, value, other) {
                    out.push(issue(f, None, "check", if check.message.is_empty() { format!("{}: check this value", f.label) } else { check.message.clone() }));
                }
            }
        }
        // Tables: each row's shown columns.
        if f.kind == "table" {
            if let Some(Json::Array(rows)) = value {
                for (i, row) in rows.iter().enumerate() {
                    let Json::Object(row) = row else { continue };
                    let cols = visible_columns(f, row, &answers, &visible);
                    for c in f.columns.iter().filter(|c| cols.contains(&c.id)) {
                        let v = row.get(&c.id);
                        if c.required && is_empty(v) {
                            out.push(issue(f, Some(i), "required", format!("{}, row {}: {} is required", f.label, i + 1, c.label)));
                        }
                        for check in &c.checks {
                            let other = check.other.as_ref().and_then(|o| row.get(o).or_else(|| answers.get(o)));
                            if !is_empty(v) && check_fails(check, v, other) {
                                out.push(issue(f, Some(i), "check", format!("{}, row {}: {}", f.label, i + 1, if check.message.is_empty() { format!("check {}", c.label) } else { check.message.clone() })));
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// The data dictionary: one row per field (and table column) with its type, options, rules.
pub fn dictionary(protocol: &Protocol) -> Vec<Vec<String>> {
    let mut rows = vec![["Form", "Section", "Field", "Field ID", "Column of", "Type", "Options", "Unit", "Required", "Quote", "Source position", "Shown when", "Checks"].iter().map(|s| s.to_string()).collect::<Vec<_>>()];
    for form in &protocol.forms {
        let labels: HashMap<&str, &str> = form.fields().flat_map(|f| std::iter::once((f.id.as_str(), f.label.as_str())).chain(f.columns.iter().map(|c| (c.id.as_str(), c.label.as_str())))).collect();
        let name = |id: &str| labels.get(id).map(|s| s.to_string()).unwrap_or_else(|| id.to_string());
        for s in &form.sections {
            for f in &s.fields {
                let mut shown = Vec::new();
                if let Some(r) = &s.show_when {
                    shown.push(format!("section: {}", describe(r, &name)));
                }
                if let Some(r) = &f.show_when {
                    shown.push(describe(r, &name));
                }
                let checks = |list: &[FieldCheck]| list.iter().map(|c| if c.message.is_empty() { format!("{} {}", c.op, c.other.clone().unwrap_or_else(|| c.value.to_string())) } else { c.message.clone() }).collect::<Vec<_>>().join("; ");
                rows.push(vec![form.name.clone(), s.title.clone(), f.label.clone(), f.id.clone(), String::new(), f.kind.clone(), f.options.join(" | "), f.unit.clone(), yes(f.required), yes(f.quote || protocol.rules.quote_required), source_rule(f, &protocol.rules).to_string(), shown.join("; "), checks(&f.checks)]);
                for c in &f.columns {
                    rows.push(vec![form.name.clone(), s.title.clone(), c.label.clone(), c.id.clone(), f.label.clone(), c.kind.clone(), c.options.join(" | "), c.unit.clone(), yes(c.required), String::new(), String::new(), c.show_when.as_ref().map(|r| describe(r, &name)).unwrap_or_default(), checks(&c.checks)]);
                }
            }
        }
    }
    rows
}

fn yes(b: bool) -> String {
    if b { "yes".into() } else { "no".into() }
}

/// Numbers in a passage selected in the reader, read the way papers write them.
pub fn parse_selection(text: &str) -> Json {
    let t = text.replace('\u{2212}', "-").replace(['–', '—'], "-").replace('·', ".");
    let number = r"-?\d+(?:[.,]\d+)?";
    let re = |p: &str| regex::Regex::new(p).unwrap();
    let num = |s: &str| s.replace(',', ".").parse::<f64>().ok();
    let mut out = Map::new();
    let all: Vec<f64> = re(number).find_iter(&t).filter_map(|m| num(m.as_str())).collect();
    out.insert("numbers".into(), json!(all));
    // An estimate with its interval: 0.52 (0.31 to 0.88), 0.52 [0.31, 0.88], 0.52 (0.31-0.88).
    if let Some(c) = re(&format!(r"({number})\s*[\(\[]\s*(?:95\s*%\s*CI[:,]?\s*)?({number})\s*(?:to|,|;|-)\s*({number})\s*[\)\]]")).captures(&t) {
        out.insert("estimate".into(), json!(num(&c[1])));
        out.insert("lower".into(), json!(num(&c[2])));
        out.insert("upper".into(), json!(num(&c[3])));
    } else if let Some(c) = re(&format!(r"({number})\s*\(\s*(?:SD\s*[=:]?\s*)?({number})\s*\)")).captures(&t) {
        // Mean (SD): 12.3 (4.5).
        out.insert("mean".into(), json!(num(&c[1])));
        out.insert("sd".into(), json!(num(&c[2])));
    } else if let Some(c) = re(&format!(r"({number})\s*(?:±|\+/-)\s*({number})")).captures(&t) {
        out.insert("mean".into(), json!(num(&c[1])));
        out.insert("sd".into(), json!(num(&c[2])));
    }
    if let Some(c) = re(&format!(r"(?i)\bn\s*=\s*({number})")).captures(&t) {
        out.insert("n".into(), json!(num(&c[1])));
    }
    if let Some(c) = re(&format!(r"({number})\s*/\s*({number})")).captures(&t) {
        out.insert("events".into(), json!(num(&c[1])));
        out.insert("total".into(), json!(num(&c[2])));
    }
    if let Some(c) = re(&format!(r"({number})\s*%")).captures(&t) {
        out.insert("percent".into(), json!(num(&c[1])));
    }
    if let Some(c) = re(&format!(r"^\s*({number})\s*-\s*({number})\s*$")).captures(&t) {
        out.insert("lower".into(), json!(num(&c[1])));
        out.insert("upper".into(), json!(num(&c[2])));
    }
    Json::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(id: &str, kind: &str) -> Field {
        Field { id: id.into(), label: id.replace('_', " "), kind: kind.into(), ..Default::default() }
    }
    fn when(field: &str, op: &str, value: Json) -> Option<ShowWhen> {
        Some(ShowWhen { conditions: vec![FieldCondition { field: field.into(), op: op.into(), value }], all: true })
    }

    fn study_form() -> Form {
        let mut kind = f("study_type", "choice");
        kind.options = vec!["Quantitative".into(), "Qualitative".into(), "Mixed".into()];
        let mut method = f("qual_method", "choice");
        method.options = vec!["Interviews".into(), "Focus groups".into(), "Observation".into()];
        method.required = true;
        method.show_when = when("study_type", "is", json!("Qualitative"));
        let mut detail = f("interview_count", "number");
        detail.show_when = when("qual_method", "is", json!("Interviews"));
        detail.required = true;
        let mut outcomes = f("outcomes", "table");
        let mut e1 = f("e1", "number");
        e1.checks = vec![FieldCheck { op: "le".into(), other: Some("n1".into()), value: Json::Null, message: "Events cannot exceed the total".into() }];
        let n1 = f("n1", "number");
        let mut sd = f("sd1", "number");
        sd.show_when = when("type", "is", json!("Continuous"));
        sd.required = true;
        outcomes.columns = vec![f("type", "choice"), e1, n1, sd];
        Form {
            id: "form".into(),
            name: "Study".into(),
            kind: "custom".into(),
            sections: vec![
                Section { id: "s1".into(), title: "Design".into(), fields: vec![kind, method, detail], ..Default::default() },
                Section { id: "s2".into(), title: "Numbers".into(), fields: vec![outcomes], show_when: when("study_type", "oneOf", json!(["Quantitative", "Mixed"])), ..Default::default() },
            ],
        }
    }

    fn given(pairs: &[(&str, Json)]) -> BTreeMap<String, Given> {
        pairs.iter().map(|(k, v)| (k.to_string(), Given { value: v.clone(), quote: true, source: false })).collect()
    }

    #[test]
    fn nested_visibility_and_completeness() {
        let form = study_form();
        validate_form(&form).unwrap();
        let rules = Rules::default();
        // Qualitative: the method shows, nested interview count once Interviews is chosen; the
        // numbers section hides.
        let a: Answers = [("study_type".to_string(), json!("Qualitative"))].into_iter().collect();
        let v = visible_fields(&form, &a);
        assert!(v.contains("qual_method") && !v.contains("interview_count") && !v.contains("outcomes"));
        let issues_q = issues(&form, &given(&[("study_type", json!("Qualitative"))]), &rules);
        assert_eq!(issues_q.len(), 1);
        assert_eq!(issues_q[0].field_id, "qual_method");
        let a2: Answers = [("study_type".to_string(), json!("Qualitative")), ("qual_method".to_string(), json!("Interviews"))].into_iter().collect();
        assert!(visible_fields(&form, &a2).contains("interview_count"));
        // Switching to Quantitative hides the method (kept, but not required) and its child.
        let q = given(&[("study_type", json!("Quantitative")), ("qual_method", json!("Interviews"))]);
        let v = visible_fields(&form, &q.iter().map(|(k, g)| (k.clone(), g.value.clone())).collect());
        assert!(!v.contains("qual_method") && !v.contains("interview_count") && v.contains("outcomes"));
        assert!(issues(&form, &q, &rules).is_empty());
    }

    #[test]
    fn rows_have_their_own_scope_and_checks() {
        let form = study_form();
        let rows = json!([{ "type": "Dichotomous", "e1": 30, "n1": 20 }, { "type": "Continuous", "e1": 1, "n1": 10 }]);
        let g = given(&[("study_type", json!("Quantitative")), ("outcomes", rows)]);
        let found = issues(&form, &g, &Rules::default());
        let kinds: Vec<(Option<usize>, &str)> = found.iter().map(|i| (i.row, i.kind.as_str())).collect();
        // Row 1: events above the total; row 2: continuous needs its SD.
        assert_eq!(kinds, [(Some(0), "check"), (Some(1), "required")]);
        assert_eq!(found[0].message, "outcomes, row 1: Events cannot exceed the total");
    }

    #[test]
    fn cycles_and_unknown_references_are_refused() {
        let mut form = study_form();
        form.sections[0].fields[0].show_when = when("interview_count", "filled", Json::Null);
        let err = validate_form(&form).unwrap_err();
        assert!(err.contains("in a circle"), "{err}");
        let mut form = study_form();
        form.sections[0].fields[0].show_when = when("nothing", "filled", Json::Null);
        assert!(validate_form(&form).unwrap_err().contains("not in the form"));
    }

    #[test]
    fn sources_required_only_when_shown() {
        let mut form = study_form();
        form.sections[0].fields[1].source = "required".into();
        let mut g = given(&[("study_type", json!("Qualitative")), ("qual_method", json!("Interviews")), ("interview_count", json!(12))]);
        let found = issues(&form, &g, &Rules::default());
        assert_eq!(found.iter().map(|i| i.kind.as_str()).collect::<Vec<_>>(), ["source"]);
        g.get_mut("qual_method").unwrap().source = true;
        assert!(issues(&form, &g, &Rules::default()).is_empty());
        g.get_mut("study_type").unwrap().value = json!("Quantitative");
        g.get_mut("qual_method").unwrap().source = false;
        assert!(issues(&form, &g, &Rules::default()).is_empty());
    }

    #[test]
    fn dictionary_and_descriptions() {
        let mut p = Protocol::default();
        p.forms = vec![study_form()];
        let d = dictionary(&p);
        let method = d.iter().find(|r| r[3] == "qual_method").unwrap();
        assert_eq!(method[11], "Shown when study type is Qualitative");
        assert!(d.iter().any(|r| r[3] == "sd1" && r[4] == "outcomes"));
    }

    #[test]
    fn numbers_from_selections() {
        let p = parse_selection("12.3 (4.5)");
        assert_eq!((p["mean"].as_f64(), p["sd"].as_f64()), (Some(12.3), Some(4.5)));
        assert_eq!(parse_selection("(n = 120)")["n"], 120.0);
        let ci = parse_selection("0.52 (95% CI 0.31 to 0.88)");
        assert_eq!((ci["estimate"].as_f64(), ci["lower"].as_f64(), ci["upper"].as_f64()), (Some(0.52), Some(0.31), Some(0.88)));
        let ci = parse_selection("RR 0.52 [0.31, 0.88]");
        assert_eq!(ci["upper"], 0.88);
        assert_eq!(parse_selection("45%")["percent"], 45.0);
        let r = parse_selection("12/120 (10%)");
        assert_eq!((r["events"].as_f64(), r["total"].as_f64(), r["percent"].as_f64()), (Some(12.0), Some(120.0), Some(10.0)));
        assert_eq!(parse_selection("0.31–0.88")["lower"], 0.31);
        assert_eq!(parse_selection("24.1 ± 3.2")["sd"], 3.2);
    }
}
