// Out of a review: screening decisions, extraction tables (wide, long, outcome data for R's
// meta/metafor, a table for RevMan-style entry), the audit trail, the PRISMA numbers, the whole review as
// one file and the protocol as a template. And the outcome data the meta-analysis reads.
use crate::derive::{RecState, State, Status};
use crate::events::{Event, FORMAT};
use crate::meta::{self, Analysis, Measure, StudyData};
use crate::model::*;
use crate::store::{Result, Reviews, all_metas, load_events, metas};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub fn csv_cell(text: &str) -> String {
    // Spreadsheets run a cell that starts with = + - @ as a formula: quote it as text.
    let guarded = if text.starts_with(['=', '+', '-', '@']) && text.parse::<f64>().is_err() { format!("'{text}") } else { text.to_string() };
    if guarded.contains([',', '"', '\n', '\r']) { format!("\"{}\"", guarded.replace('"', "\"\"")) } else { guarded }
}

fn csv_line(cells: &[String]) -> String {
    let mut line = cells.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(",");
    line.push('\n');
    line
}

fn value_text(v: &Json) -> String {
    match v {
        Json::Null => String::new(),
        Json::String(s) => s.clone(),
        Json::Bool(b) => if *b { "Yes".into() } else { "No".into() },
        Json::Array(items) => items.iter().map(value_text).collect::<Vec<_>>().join("; "),
        Json::Object(o) => o.iter().filter(|(k, _)| !k.starts_with('_')).map(|(k, v)| format!("{k}: {}", value_text(v))).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    }
}

/// The value used for a study: the agreed one, else one everyone gave, else the first reviewer's.
pub fn resolved_value(state: &State, record: &str, form: &str, field: &str) -> Option<(Json, bool)> {
    let ex = state.extraction.get(record)?;
    let key = (form.to_string(), field.to_string());
    if let Some(f) = ex.finals.get(&key) {
        return Some((f.value.clone(), false));
    }
    // AI suggestions are not values until a reviewer takes one.
    let values: Vec<&crate::derive::Extracted> = ex.values.get(&key)?.iter().filter(|(who, _)| who.as_str() != "ai").map(|(_, v)| v).collect();
    let first = values.first()?.value.clone();
    let conflict = values.iter().any(|v| v.value != first);
    Some((first, conflict))
}

/// A study's label: its "Study ID" field, else first author and year.
pub fn study_label(state: &State, meta: Option<&RecordMeta>, record: &str) -> String {
    for form in &state.protocol.forms {
        if let Some(f) = form.fields().find(|f| f.id == "study_id") {
            if let Some((v, _)) = resolved_value(state, record, &form.id, &f.id) {
                let t = value_text(&v);
                if !t.trim().is_empty() {
                    return t;
                }
            }
        }
    }
    meta.map(|m| m.byline()).filter(|b| !b.is_empty()).unwrap_or_else(|| meta.map(|m| m.title.chars().take(40).collect()).unwrap_or_else(|| record.to_string()))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeRow {
    pub record: String,
    pub study: String,
    pub subgroup: Option<String>,
    pub values: BTreeMap<String, Json>,
}

fn number(v: Option<&Json>) -> Option<f64> {
    match v? {
        Json::Number(n) => n.as_f64(),
        Json::String(s) => s.trim().replace(',', ".").parse().ok(),
        _ => None,
    }
}

fn text_of(v: Option<&Json>) -> String {
    v.map(value_text).unwrap_or_default().trim().to_string()
}

/// Every row of every outcome table of the included studies.
pub fn outcome_rows(state: &State, metas: &HashMap<String, RecordMeta>) -> Vec<OutcomeRow> {
    let mut out = Vec::new();
    let subgroup_fields: Vec<(String, String)> = state.protocol.forms.iter().flat_map(|f| f.fields().filter(|x| x.role == "subgroup").map(move |x| (f.id.clone(), x.id.clone()))).collect();
    for r in state.included() {
        let study = study_label(state, metas.get(&r.id), &r.id);
        let subgroup = subgroup_fields.iter().find_map(|(form, field)| resolved_value(state, &r.id, form, field).map(|(v, _)| value_text(&v)).filter(|s| !s.is_empty()));
        for form in &state.protocol.forms {
            for f in form.fields().filter(|f| f.role == "outcomes" && f.kind == "table") {
                let Some((Json::Array(rows), _)) = resolved_value(state, &r.id, &form.id, &f.id) else { continue };
                for row in rows {
                    let Json::Object(o) = row else { continue };
                    out.push(OutcomeRow { record: r.id.clone(), study: study.clone(), subgroup: subgroup.clone(), values: o.into_iter().collect() });
                }
            }
        }
    }
    out
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeChoice {
    pub outcome: String,
    pub timepoint: String,
    pub kind: String,
    pub studies: usize,
}

/// The outcomes there are data for, with their time points and data type.
pub fn outcomes(rows: &[OutcomeRow]) -> Vec<OutcomeChoice> {
    let mut map: BTreeMap<(String, String), (BTreeSet<String>, BTreeMap<String, usize>)> = BTreeMap::new();
    for r in rows {
        let outcome = text_of(r.values.get("outcome"));
        if outcome.is_empty() {
            continue;
        }
        let entry = map.entry((outcome, text_of(r.values.get("timepoint")))).or_default();
        entry.0.insert(r.record.clone());
        *entry.1.entry(text_of(r.values.get("type")).to_lowercase()).or_default() += 1;
    }
    map.into_iter().map(|((outcome, timepoint), (studies, kinds))| OutcomeChoice { outcome, timepoint, kind: kinds.into_iter().max_by_key(|x| x.1).map(|x| x.0).unwrap_or_default(), studies: studies.len() }).collect()
}

/// The meta-analysis input for one outcome (and time point).
pub fn study_data(rows: &[OutcomeRow], outcome: &str, timepoint: Option<&str>) -> Vec<StudyData> {
    rows.iter()
        .filter(|r| text_of(r.values.get("outcome")).eq_ignore_ascii_case(outcome.trim()))
        .filter(|r| timepoint.is_none_or(|t| text_of(r.values.get("timepoint")).eq_ignore_ascii_case(t.trim())))
        .map(|r| {
            let n = |k: &str| number(r.values.get(k));
            let measure = text_of(r.values.get("measure")).to_ascii_uppercase();
            StudyData {
                id: r.record.clone(),
                label: r.study.clone(),
                e1: n("e1"),
                n1: n("n1"),
                e2: n("e2"),
                n2: n("n2"),
                m1: n("m1"),
                sd1: n("sd1"),
                m2: n("m2"),
                sd2: n("sd2"),
                estimate: n("estimate"),
                se: n("se"),
                lower: n("lower"),
                upper: n("upper"),
                ratio: matches!(measure.as_str(), "RR" | "OR" | "HR"),
                subgroup: r.subgroup.clone(),
            }
        })
        .collect()
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AnalysisRequest {
    pub outcome: String,
    pub timepoint: Option<String>,
    pub options: meta::Options,
    /// Pool within subgroups (from fields with the "subgroup" role).
    pub subgroups: bool,
}

impl Reviews {
    pub fn outcome_choices(&self, review: &str) -> Result<Vec<OutcomeChoice>> {
        self.read(review, |state, conn| {
            let ids: Vec<String> = state.included().iter().map(|r| r.id.clone()).collect();
            Ok(outcomes(&outcome_rows(state, &metas(conn, review, &ids)?)))
        })
    }

    pub fn analyse(&self, review: &str, request: &AnalysisRequest) -> Result<Json> {
        let (data, studies_total) = self.read(review, |state, conn| {
            let ids: Vec<String> = state.included().iter().map(|r| r.id.clone()).collect();
            let rows = outcome_rows(state, &metas(conn, review, &ids)?);
            let mut data = study_data(&rows, &request.outcome, request.timepoint.as_deref().filter(|t| !t.is_empty()));
            if !request.subgroups {
                for d in &mut data {
                    d.subgroup = None;
                }
            }
            Ok((data, ids.len()))
        })?;
        if data.is_empty() {
            return Err("No included study has data for this outcome yet".into());
        }
        let analysis: Analysis = meta::analyse(&data, &request.options)?;
        Ok(json!({ "analysis": analysis, "input": data, "includedStudies": studies_total }))
    }

    /// An export as { filename, content, mime }.
    pub fn export(&self, review: &str, kind: &str, viewer: &str) -> Result<Json> {
        self.read(review, |state, conn| {
            let base = slug(&state.info.name);
            let (name, content, mime) = match kind {
                "screening" => (format!("{base}-screening.csv"), screening_csv(state, conn)?, "text/csv"),
                "extraction" => (format!("{base}-extraction.csv"), extraction_wide(state, conn)?, "text/csv"),
                "extraction-long" => (format!("{base}-extraction-long.csv"), extraction_long(state, conn)?, "text/csv"),
                "outcomes" => (format!("{base}-outcomes.csv"), outcomes_csv(state, conn)?, "text/csv"),
                // Not a file RevMan Web imports (it takes its own templates): a table for typing
                // the data in. "revman" was its earlier name.
                "outcome-table" | "revman" => (format!("{base}-outcome-data.csv"), revman_csv(state, conn)?, "text/csv"),
                "prisma" => (format!("{base}-prisma.csv"), crate::prisma::csv(&crate::prisma::compute(state)), "text/csv"),
                "audit" => (format!("{base}-audit.csv"), audit_csv(state, conn)?, "text/csv"),
                "review" => (format!("{base}.keyreview.json"), serde_json::to_string_pretty(&json!({ "format": "key-review", "version": FORMAT, "review": state.info, "exportedBy": viewer, "events": load_events(conn, review)? })).map_err(|e| e.to_string())?, "application/json"),
                "template" => (format!("{base}-template.json"), template_json(&state.protocol)?, "application/json"),
                "dictionary" => (format!("{base}-data-dictionary.csv"), crate::logic::dictionary(&state.protocol).iter().map(|r| csv_line(r)).collect::<String>(), "text/csv"),
                "fulltext-csv" => (format!("{base}-full-texts-needed.csv"), crate::records::fulltext_csv(state, &all_metas(conn, review)?.into_iter().map(|m| (m.id.clone(), m)).collect()), "text/csv"),
                // std-B: AI-use statement and log, contacts with authors, extraction pilot, conduct checks.
                "ai-statement" | "ai-log" | "contacts" | "extraction-pilot" | "conduct" => crate::conduct::export(state, kind, &base)?,
                other => return Err(format!("Unknown export {other}")),
            };
            Ok(json!({ "filename": name, "content": content, "mime": mime }))
        })
    }

    /// A review file: a review that is not here yet is added; one that is gets the events it lacks (a merge).
    pub fn import_review_file(&self, text: &str) -> Result<Json> {
        let v: Json = serde_json::from_str(text).map_err(|_| "This is not a Key review file")?;
        if v.get("format").and_then(Json::as_str) != Some("key-review") {
            return Err("This is not a Key review file".into());
        }
        let events: Vec<Event> = serde_json::from_value(v.get("events").cloned().unwrap_or(Json::Null)).map_err(|e| format!("The review file is damaged: {e}"))?;
        let id = events.iter().find(|e| e.kind == "review.create").map(|e| e.review_id.clone()).ok_or("The review file has no review in it")?;
        if events.iter().any(|e| e.review_id != id) {
            return Err("The review file mixes several reviews".into());
        }
        let added = self.merge(events)?;
        Ok(json!({ "reviewId": id, "added": added }))
    }
}

pub fn template_json(protocol: &Protocol) -> Result<String> {
    serde_json::to_string_pretty(&json!({ "format": "key-review-template", "version": FORMAT, "protocol": protocol })).map_err(|e| e.to_string())
}

/// A template's protocol (rules, criteria, forms, keywords; an old template's reasons become
/// criteria); the question and
/// registration of the review it is applied to stay.
pub fn read_template(text: &str) -> Result<Protocol> {
    let v: Json = serde_json::from_str(text).map_err(|_| "This is not a review template")?;
    let p = match v.get("format").and_then(Json::as_str) {
        Some("key-review-template") => v.get("protocol").cloned().unwrap_or(Json::Null),
        _ if v.get("rules").is_some() || v.get("criteria").is_some() => v,
        _ => return Err("This is not a review template".into()),
    };
    let mut protocol: Protocol = serde_json::from_value(p).map_err(|e| format!("The template is damaged: {e}"))?;
    protocol.normalize();
    protocol.validate()?;
    Ok(protocol)
}

fn slug(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if s.is_empty() { "review".into() } else { s.chars().take(60).collect() }
}

fn status_label(s: &Status) -> &'static str {
    match s {
        Status::NotEligible => "",
        Status::NotRetrieved => "Not retrieved",
        Status::Undecided => "Undecided",
        Status::Partial { .. } => "Needs another reviewer",
        Status::Conflict => "Conflict",
        Status::Final { value: Choice::Include, .. } => "Included",
        Status::Final { value: Choice::Exclude, auto: true, .. } => "Excluded (automatic)",
        Status::Final { value: Choice::Exclude, .. } => "Excluded",
        Status::Final { value: Choice::Maybe, .. } => "Maybe",
    }
}

fn reason_labels(state: &State, ids: &[String]) -> String {
    ids.iter().map(|id| state.protocol.reason_label(state.aliases.get(id).unwrap_or(id))).collect::<Vec<_>>().join("; ")
}

fn screening_csv(state: &State, conn: &rusqlite::Connection) -> Result<String> {
    let metas = all_metas(conn, &state.info.id)?;
    let reviewers: Vec<&Member> = state.team.iter().collect();
    let mut head = vec!["Record ID", "Title", "Authors", "Year", "Journal", "DOI", "PMID", "Import", "Duplicate of", "Title/abstract", "Title/abstract criteria not met", "Full text", "Full-text criteria not met", "Full text retrieval", "Other (title/abstract)", "Other (full text)", "Removed by hand", "Report of study", "Filled in from"].into_iter().map(String::from).collect::<Vec<_>>();
    for m in &reviewers {
        head.push(format!("Title/abstract: {}", m.name));
        head.push(format!("Full text: {}", m.name));
    }
    head.push("Labels".into());
    head.push("Notes".into());
    let mut out = csv_line(&head);
    for meta in metas {
        let Some(r) = state.record(&meta.id) else { continue };
        let ta = state.status(r, Stage::Ta);
        let ft = state.status(r, Stage::Ft);
        let mut cells = vec![
            meta.id.clone(),
            meta.title.clone(),
            meta.authors.join("; "),
            meta.year.map(|y| y.to_string()).unwrap_or_default(),
            meta.journal.clone(),
            meta.doi.clone(),
            meta.pmid.clone(),
            state.batch(&r.batch).map(|b| b.name.clone()).unwrap_or_default(),
            if state.active(r) { String::new() } else { r.dup_of.clone().unwrap_or_else(|| "removed".into()) },
            status_label(&ta).into(),
            reason_labels(state, &state.final_reasons(r, Stage::Ta)),
            status_label(&ft).into(),
            reason_labels(state, &state.final_reasons(r, Stage::Ft)),
            r.fulltext.status.clone(),
            state.final_other(r, Stage::Ta).join("; "),
            state.final_other(r, Stage::Ft).join("; "),
            r.removed.clone().unwrap_or_default(),
            r.study_of.clone().unwrap_or_default(),
            r.filled.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("; "),
        ];
        for m in &reviewers {
            for stage in [Stage::Ta, Stage::Ft] {
                cells.push(r.mine(stage, &m.id).map(|d| d.value.label().to_string()).unwrap_or_default());
            }
        }
        cells.push(r.labels.iter().cloned().collect::<Vec<_>>().join("; "));
        cells.push(r.notes.iter().map(|n| format!("{}: {}", state.member_name(&n.reviewer), n.text)).collect::<Vec<_>>().join(" | "));
        out.push_str(&csv_line(&cells));
    }
    Ok(out)
}

fn included_metas<'a>(state: &'a State, conn: &rusqlite::Connection) -> Result<(Vec<&'a RecState>, HashMap<String, RecordMeta>)> {
    let included = state.included();
    let ids: Vec<String> = included.iter().map(|r| r.id.clone()).collect();
    Ok((included, metas(conn, &state.info.id, &ids)?))
}

/// The source a value was taken from: "p. 4: “quote”".
pub fn source_text(x: &crate::derive::Extracted) -> String {
    let page = x.page.or_else(|| x.source_pos.as_ref().and_then(|p| p.get("page")).and_then(Json::as_i64).filter(|p| *p >= 0).map(|p| p + 1));
    let quote = if x.quote.trim().is_empty() { x.source_pos.as_ref().and_then(|p| p.get("text")).and_then(Json::as_str).unwrap_or("").to_string() } else { x.quote.clone() };
    match (page, quote.trim()) {
        (Some(p), "") => format!("p. {p}"),
        (Some(p), q) => format!("p. {p}: “{q}”"),
        (None, "") => String::new(),
        (None, q) => format!("“{q}”"),
    }
}

/// The value used for a study with where it came from.
fn resolved_entry<'a>(state: &'a State, record: &str, form: &str, field: &str) -> Option<&'a crate::derive::Extracted> {
    let ex = state.extraction.get(record)?;
    let key = (form.to_string(), field.to_string());
    ex.finals.get(&key).or_else(|| ex.values.get(&key)?.iter().find(|(who, _)| who.as_str() != "ai").map(|(_, v)| v))
}

/// The fields each study's agreed answers show (others are "not applicable").
fn shown_fields(state: &State, record: &str, form: &Form) -> std::collections::HashSet<String> {
    let answers: crate::logic::Answers = form.fields().filter_map(|f| resolved_value(state, record, &form.id, &f.id).map(|(v, _)| (f.id.clone(), v))).collect();
    crate::logic::visible_fields(form, &answers)
}

fn extraction_wide(state: &State, conn: &rusqlite::Connection) -> Result<String> {
    let (included, m) = included_metas(state, conn)?;
    let fields: Vec<(&Form, &Field)> = state.protocol.forms.iter().flat_map(|f| f.fields().map(move |x| (f, x))).collect();
    // A source column for fields whose rule asks for one or where any study has one.
    let with_source: Vec<bool> = fields
        .iter()
        .map(|(f, x)| x.quote || state.protocol.rules.quote_required || crate::logic::source_rule(x, &state.protocol.rules) != "none" || included.iter().any(|r| resolved_entry(state, &r.id, &f.id, &x.id).is_some_and(|e| !source_text(e).is_empty())))
        .collect();
    let mut head = vec!["Study".to_string(), "Record ID".into(), "Title".into(), "Year".into(), "DOI".into()];
    for ((f, x), src) in fields.iter().zip(&with_source) {
        head.push(format!("{}: {}", f.name, x.label));
        if *src {
            head.push(format!("{}: {} (source)", f.name, x.label));
        }
    }
    let mut out = csv_line(&head);
    for r in included {
        let meta = m.get(&r.id);
        let mut cells = vec![study_label(state, meta, &r.id), r.id.clone(), meta.map(|x| x.title.clone()).unwrap_or_default(), r.year.map(|y| y.to_string()).unwrap_or_default(), meta.map(|x| x.doi.clone()).unwrap_or_default()];
        let shown: HashMap<&str, std::collections::HashSet<String>> = state.protocol.forms.iter().map(|f| (f.id.as_str(), shown_fields(state, &r.id, f))).collect();
        for ((f, x), src) in fields.iter().zip(&with_source) {
            // Not applicable for this study (hidden by its answers): blank.
            let applies = shown.get(f.id.as_str()).is_some_and(|s| s.contains(&x.id));
            cells.push(if applies { resolved_value(state, &r.id, &f.id, &x.id).map(|(v, conflict)| if conflict { format!("{} (reviewers differ)", value_text(&v)) } else { value_text(&v) }).unwrap_or_default() } else { String::new() });
            if *src {
                cells.push(if applies { resolved_entry(state, &r.id, &f.id, &x.id).map(source_text).unwrap_or_default() } else { String::new() });
            }
        }
        out.push_str(&csv_line(&cells));
    }
    Ok(out)
}

fn extraction_long(state: &State, conn: &rusqlite::Connection) -> Result<String> {
    let (included, m) = included_metas(state, conn)?;
    let mut out = csv_line(&["study", "record_id", "form", "field", "row", "column", "value", "reviewer", "agreed", "quote", "page", "source", "applies"].map(String::from));
    for r in included {
        let study = study_label(state, m.get(&r.id), &r.id);
        let Some(ex) = state.extraction.get(&r.id) else { continue };
        for form in &state.protocol.forms {
            let shown = shown_fields(state, &r.id, form);
            for f in form.fields() {
                let applies = if shown.contains(&f.id) { "yes" } else { "no" };
                let key = (form.id.clone(), f.id.clone());
                let mut entries: Vec<(String, &crate::derive::Extracted, bool)> = ex.values.get(&key).map(|v| v.iter().filter(|(who, _)| who.as_str() != "ai").map(|(who, x)| (state.member_name(who), x, false)).collect()).unwrap_or_default();
                if let Some(fin) = ex.finals.get(&key) {
                    entries.push(("agreed".into(), fin, true));
                }
                for (who, x, agreed) in entries {
                    let base = |row: &str, column: &str, value: String| csv_line(&[study.clone(), r.id.clone(), form.name.clone(), f.label.clone(), row.into(), column.into(), value, who.clone(), if agreed { "yes".into() } else { "no".into() }, x.quote.clone(), x.page.map(|p| p.to_string()).unwrap_or_default(), source_text(x), applies.into()]);
                    match (&x.value, f.kind.as_str()) {
                        (Json::Array(rows), "table") => {
                            for (i, row) in rows.iter().enumerate() {
                                if let Json::Object(o) = row {
                                    for c in &f.columns {
                                        if let Some(v) = o.get(&c.id) {
                                            out.push_str(&base(&(i + 1).to_string(), &c.id, value_text(v)));
                                        }
                                    }
                                }
                            }
                        }
                        (v, _) => out.push_str(&base("", "", value_text(v))),
                    }
                }
            }
        }
    }
    Ok(out)
}

const OUTCOME_KEYS: [&str; 19] = ["outcome", "timepoint", "unit", "type", "group1", "group2", "e1", "n1", "e2", "n2", "m1", "sd1", "m2", "sd2", "measure", "estimate", "lower", "upper", "se"];

/// One row per study, outcome and time point, with the columns metafor's escalc() and meta's
/// metabin()/metacont()/metagen() take (ai/n1i …: e1, n1, e2, n2; m1i …: m1, sd1, n1 …).
fn outcomes_csv(state: &State, conn: &rusqlite::Connection) -> Result<String> {
    let (_, m) = included_metas(state, conn)?;
    let rows = outcome_rows(state, &m);
    let mut head = vec!["study".to_string(), "record_id".into(), "subgroup".into()];
    head.extend(OUTCOME_KEYS.iter().map(|k| k.to_string()));
    let mut out = csv_line(&head);
    for r in rows {
        let mut cells = vec![r.study.clone(), r.record.clone(), r.subgroup.clone().unwrap_or_default()];
        cells.extend(OUTCOME_KEYS.iter().map(|k| text_of(r.values.get(*k))));
        out.push_str(&csv_line(&cells));
    }
    Ok(out)
}

/// Outcome data laid out for entering it in RevMan or another tool by hand (not a file RevMan
/// Web imports): per outcome, study
/// then events and totals (dichotomous) or mean, SD and total (continuous) for each group, or
/// estimate and SE (generic inverse variance, ratios on the log scale).
fn revman_csv(state: &State, conn: &rusqlite::Connection) -> Result<String> {
    let (_, m) = included_metas(state, conn)?;
    let rows = outcome_rows(state, &m);
    let mut out = String::new();
    for choice in outcomes(&rows) {
        let data = study_data(&rows, &choice.outcome, Some(&choice.timepoint));
        let title = if choice.timepoint.is_empty() { choice.outcome.clone() } else { format!("{} ({})", choice.outcome, choice.timepoint) };
        out.push_str(&csv_line(&[format!("Outcome: {title}")]));
        let fmt = |v: Option<f64>| v.map(|x| x.to_string()).unwrap_or_default();
        match choice.kind.as_str() {
            "dichotomous" => {
                out.push_str(&csv_line(&["Study", "Experimental events", "Experimental total", "Control events", "Control total"].map(String::from)));
                for d in data {
                    out.push_str(&csv_line(&[d.label, fmt(d.e1), fmt(d.n1), fmt(d.e2), fmt(d.n2)]));
                }
            }
            "continuous" => {
                out.push_str(&csv_line(&["Study", "Experimental mean", "Experimental SD", "Experimental total", "Control mean", "Control SD", "Control total"].map(String::from)));
                for d in data {
                    out.push_str(&csv_line(&[d.label, fmt(d.m1), fmt(d.sd1), fmt(d.n1), fmt(d.m2), fmt(d.sd2), fmt(d.n2)]));
                }
            }
            _ => {
                out.push_str(&csv_line(&["Study", "Estimate (log scale for ratios)", "SE"].map(String::from)));
                for d in data {
                    let e = meta::effect(&d, Measure::GEN).ok();
                    out.push_str(&csv_line(&[d.label, e.map(|x| x.yi.to_string()).unwrap_or_default(), e.map(|x| x.vi.sqrt().to_string()).unwrap_or_default()]));
                }
            }
        }
        out.push('\n');
    }
    if out.is_empty() {
        out.push_str("No outcome data extracted yet\n");
    }
    Ok(out)
}

/// An event in words, for the audit trail.
pub fn describe(state: &State, e: &Event) -> String {
    let p = &e.payload;
    let s = |k: &str| p.get(k).and_then(Json::as_str).unwrap_or("");
    let stage = p.get("stage").and_then(Json::as_str).map(|x| if x == "ft" { "full text" } else { "title and abstract" }).unwrap_or("");
    let reasons = p.get("reasons").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(|id| state.protocol.reason_label(state.aliases.get(id).map(String::as_str).unwrap_or(id))).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    let reasons = if reasons.is_empty() { String::new() } else { format!(" ({reasons})") };
    match e.kind.as_str() {
        "review.create" => format!("Created the review \"{}\"", s("name")),
        "review.rename" => format!("Renamed the review to \"{}\"", s("name")),
        "review.archive" => if p.get("archived").and_then(Json::as_bool).unwrap_or(true) { "Archived the review".into() } else { "Restored the review".into() },
        "protocol.set" => if p.get("amend").and_then(Json::as_bool).unwrap_or(false) { "Edited the protocol".into() } else { format!("Saved protocol version: {}", s("note")) },
        "team.set" => "Changed the team".into(),
        "criteria.alias" => "Merged the exclusion reasons into the criteria".into(),
        "batch.add" => format!("Imported {} records from {}", p.pointer("/batch/count").and_then(Json::as_u64).unwrap_or(0), p.pointer("/batch/name").and_then(Json::as_str).unwrap_or("a file")),
        "batch.remove" => "Removed an import".into(),
        "records.add" => format!("Added {} records", p.get("records").and_then(Json::as_array).map(|a| a.len()).unwrap_or(0)),
        "dedup.candidates" => format!("Found {} possible duplicates", p.get("pairs").and_then(Json::as_array).map(|a| a.len()).unwrap_or(0)),
        "dedup.set" => if p.get("distinctFrom").is_some() { "Marked two records as different".into() } else if p.get("duplicateOf").is_some_and(|v| !v.is_null()) { "Marked a duplicate".into() } else { "Restored a duplicate".into() },
        "decision" => format!("{} at {stage}{reasons}", p.get("value").and_then(Json::as_str).map(|v| match v { "include" => "Included", "exclude" => "Excluded", _ => "Maybe" }).unwrap_or("Decided")),
        "decision.retract" => "Took back a decision".into(),
        "resolve" => format!("{} {stage}{reasons}", if p.get("auto").is_some_and(|a| !a.is_null()) { "Applied a rule at" } else { "Resolved" }),
        "note" => "Wrote a note".into(),
        "labels" => "Changed labels".into(),
        "fulltext.set" => format!("Full text: {}", match s("status") { "notRetrieved" => "not retrieved", "retrieved" => "retrieved", "sought" => "sought", _ => "linked" }),
        "assign" => format!("Assigned {stage} records"),
        "pilot.set" => format!("Pilot round \"{}\" {}", s("name"), if p.get("open").and_then(Json::as_bool).unwrap_or(false) { "open" } else { "closed" }),
        "rescreen.flag" => if p.get("clear").and_then(Json::as_bool).unwrap_or(false) { "Cleared re-screen flags".into() } else { format!("Flagged records for re-screening at {stage}") },
        "extract.value" => format!("Extracted {}", s("fieldId")),
        "extract.final" => format!("Agreed {}", s("fieldId")),
        "ai.suggest" => "AI suggestion".into(),
        "analysis.set" => "Saved an analysis".into(),
        // std-B
        "chase.round" | "conduct.dismiss" | "conduct.retractions" | "ai.prompt" | "ai.audit" | "xpilot.set" | "form.piloted" | "contact.log" => crate::conduct::describe(e),
        other => other.into(),
    }
}

fn audit_csv(state: &State, conn: &rusqlite::Connection) -> Result<String> {
    let events = load_events(conn, &state.info.id)?;
    let mut out = csv_line(&["Time (UTC ms)", "Event ID", "Who", "Device", "Kind", "Record", "Protocol version", "What"].map(String::from));
    for e in &events {
        let version = state.versions.iter().find(|v| v.id == e.version).map(|v| v.number.to_string()).unwrap_or_default();
        out.push_str(&csv_line(&[e.at.to_string(), e.id.clone(), state.member_name(&e.actor), e.device.clone(), e.kind.clone(), e.record_id.clone().unwrap_or_default(), version, describe(state, e)]));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv_cells_are_safe() {
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("=SUM(A1)"), "'=SUM(A1)");
        assert_eq!(csv_cell("-1.5"), "-1.5");
        assert_eq!(slug("Tea & sleep: a review"), "tea-sleep-a-review");
    }
}
