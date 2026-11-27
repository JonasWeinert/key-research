// The advanced synthesis of one outcome, run from the Analysis stage: meta-regression,
// several estimates per study, small-study and publication-bias methods and sensitivity tools,
// each section computed only when asked for and failing on its own (a message per section).
// The numbers come from metareg.rs, dependence.rs, pubbias.rs and sensitivity.rs.
use crate::derive::State;
use crate::export::{outcome_rows, resolved_value, study_data};
use crate::meta::{Effect, Measure, Method, Options, StudyData, effect};
use crate::metareg::{ModValue, Moderator, RegOptions, metareg};
use crate::store::{Result, Reviews, metas};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::collections::BTreeMap;

/// Where a moderator's values come from.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ModeratorRef {
    /// "field" (a study-level form field), "column" (an outcome-table column, per estimate) or
    /// "rob" (overall risk of bias, from the RoB assessments).
    pub source: String,
    pub form: String,
    pub field: String,
    /// "continuous" | "categorical"; empty: inferred from the values.
    pub kind: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BiasOptions {
    pub pet_peese: bool,
    /// α for the conditional PET-PEESE rule (0.05).
    pub alpha: Option<f64>,
    pub one_sided: bool,
    /// "L0" | "R0"; empty: no trim and fill.
    pub trim_fill: String,
    pub selection: bool,
    pub uwls: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SensOptions {
    pub influence: bool,
    /// "year" | "precision" | "listed"; empty: no cumulative analysis.
    pub cumulative: String,
    pub models: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SynthesisRequest {
    pub outcome: String,
    pub timepoint: Option<String>,
    pub options: Options,
    pub moderators: Vec<ModeratorRef>,
    pub metareg: Option<RegOptions>,
    pub dependence: Option<crate::dependence::DepOptions>,
    pub bias: Option<BiasOptions>,
    pub sensitivity: Option<SensOptions>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeratorChoice {
    #[serde(flatten)]
    pub moderator: ModeratorRef,
    pub label: String,
    /// Studies with a value.
    pub studies: usize,
}

/// One estimate ready for the models.
struct Row {
    record: String,
    label: String,
    year: Option<i64>,
    effect: Effect,
    data: StudyData,
}

fn number(v: &Json) -> Option<f64> {
    match v {
        Json::Number(n) => n.as_f64(),
        Json::String(s) => s.trim().replace(',', ".").parse().ok(),
        Json::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn text(v: &Json) -> String {
    match v {
        Json::Null => String::new(),
        Json::String(s) => s.trim().to_string(),
        Json::Bool(b) => if *b { "Yes".into() } else { "No".into() },
        Json::Array(a) => a.iter().map(text).collect::<Vec<_>>().join("; "),
        other => other.to_string(),
    }
}

/// Fields and columns that can serve as moderators, with how many studies have a value.
pub fn moderator_choices(state: &State, rows: &[crate::export::OutcomeRow], rob: Option<&Json>) -> Vec<ModeratorChoice> {
    let mut out = Vec::new();
    let included = state.included();
    for form in &state.protocol.forms {
        for f in form.fields().filter(|f| !matches!(f.kind.as_str(), "table" | "longtext") && f.role != "outcomes" && f.id != "study_id") {
            let values: Vec<Json> = included.iter().filter_map(|r| resolved_value(state, &r.id, &form.id, &f.id).map(|(v, _)| v)).filter(|v| !text(v).is_empty()).collect();
            if values.is_empty() {
                continue;
            }
            let kind = if f.kind == "number" || values.iter().all(|v| number(v).is_some() && !matches!(v, Json::Bool(_))) { "continuous" } else { "categorical" };
            out.push(ModeratorChoice { moderator: ModeratorRef { source: "field".into(), form: form.id.clone(), field: f.id.clone(), kind: kind.into(), name: f.label.clone() }, label: format!("{} ({})", f.label, form.name), studies: values.len() });
        }
        for f in form.fields().filter(|f| f.kind == "table" && f.role == "outcomes") {
            for c in f.columns.iter().filter(|c| !crate::export::OUTCOME_KEYS.contains(&c.id.as_str()) && !["r", "t", "df", "time1", "time2"].contains(&c.id.as_str())) {
                let vals: Vec<&Json> = rows.iter().filter_map(|r| r.values.get(&c.id)).filter(|v| !text(v).is_empty()).collect();
                if vals.is_empty() {
                    continue;
                }
                let kind = if c.kind == "number" || vals.iter().all(|v| number(v).is_some()) { "continuous" } else { "categorical" };
                let studies = rows.iter().filter(|r| r.values.get(&c.id).is_some_and(|v| !text(v).is_empty())).map(|r| r.record.as_str()).collect::<std::collections::BTreeSet<_>>().len();
                out.push(ModeratorChoice { moderator: ModeratorRef { source: "column".into(), form: form.id.clone(), field: c.id.clone(), kind: kind.into(), name: c.label.clone() }, label: format!("{} (per estimate)", c.label), studies });
            }
        }
    }
    if let Some(Json::Object(map)) = rob {
        if !map.is_empty() {
            out.push(ModeratorChoice { moderator: ModeratorRef { source: "rob".into(), kind: "categorical".into(), name: "Risk of bias (overall)".into(), ..Default::default() }, label: "Risk of bias (overall)".into(), studies: map.len() });
        }
    }
    out
}

/// A moderator's values for each estimate in `rows`.
pub fn moderator_values(state: &State, m: &ModeratorRef, rows: &[&StudyData], raw: &[crate::export::OutcomeRow], rob: Option<&Json>, outcome_key: &str) -> Moderator {
    let kind = if m.kind.is_empty() { "categorical".to_string() } else { m.kind.clone() };
    let continuous = kind == "continuous";
    let to = |v: Option<Json>| -> ModValue {
        match v {
            None => ModValue::Missing,
            Some(v) if text(&v).is_empty() => ModValue::Missing,
            Some(v) => {
                if continuous {
                    number(&v).map(ModValue::Num).unwrap_or(ModValue::Missing)
                } else {
                    ModValue::Cat(text(&v))
                }
            }
        }
    };
    let values = rows
        .iter()
        .map(|r| match m.source.as_str() {
            "column" => to(raw.iter().find(|x| x.record == r.id && Some(x.index) == r.row).and_then(|x| x.values.get(&m.field).cloned())),
            "rob" => {
                let entry = rob.and_then(|j| j.get(&r.id));
                let by = entry.and_then(|e| e.pointer(&format!("/byResult/{}", outcome_key.replace('~', "~0").replace('/', "~1"))));
                let pick = by.or(entry);
                if continuous { pick.and_then(|p| p.get("rank")).and_then(Json::as_f64).map(ModValue::Num).unwrap_or(ModValue::Missing) } else { pick.and_then(|p| p.get("overall")).and_then(Json::as_str).filter(|s| !s.is_empty()).map(|s| ModValue::Cat(s.to_string())).unwrap_or(ModValue::Missing) }
            }
            _ => to(resolved_value(state, &r.id, &m.form, &m.field).map(|(v, _)| v)),
        })
        .collect();
    Moderator { name: if m.name.is_empty() { m.field.clone() } else { m.name.clone() }, kind, values }
}

impl Reviews {
    /// Moderators available for an outcome.
    pub fn moderators(&self, review: &str) -> Result<Vec<ModeratorChoice>> {
        let rob = self.export(review, "rob-covariates", "").ok().and_then(|f| f.get("content").and_then(Json::as_str).and_then(|c| serde_json::from_str::<Json>(c).ok()));
        self.read(review, |state, conn| {
            let ids: Vec<String> = state.included().iter().map(|r| r.id.clone()).collect();
            let rows = outcome_rows(state, &metas(conn, review, &ids)?);
            Ok(moderator_choices(state, &rows, rob.as_ref()))
        })
    }

    pub fn synthesis(&self, review: &str, req: &SynthesisRequest) -> Result<Json> {
        let rob = if req.moderators.iter().any(|m| m.source == "rob") { self.export(review, "rob-covariates", "").ok().and_then(|f| f.get("content").and_then(Json::as_str).and_then(|c| serde_json::from_str::<Json>(c).ok())) } else { None };
        self.read(review, |state, conn| {
            let ids: Vec<String> = state.included().iter().map(|r| r.id.clone()).collect();
            let raw = outcome_rows(state, &metas(conn, review, &ids)?);
            let timepoint = req.timepoint.as_deref().filter(|t| !t.is_empty());
            let data = study_data(&raw, &req.outcome, timepoint);
            let mut skipped = Vec::new();
            let rows: Vec<Row> = data
                .into_iter()
                .filter_map(|d| match effect(&d, req.options.measure) {
                    Ok(e) if e.vi > 0.0 && e.yi.is_finite() => Some(Row { record: d.id.clone(), label: d.label.clone(), year: state.record(&d.id).and_then(|r| r.year), effect: e, data: d }),
                    Ok(_) => {
                        skipped.push((d.label.clone(), "Variance of 0".to_string()));
                        None
                    }
                    Err(why) => {
                        skipped.push((d.label.clone(), why));
                        None
                    }
                })
                .collect();
            if rows.is_empty() {
                return Err("No included study has usable data for this outcome and effect measure".into());
            }
            let outcome_key = format!("{}|{}", req.outcome, timepoint.unwrap_or(""));
            let y: Vec<f64> = rows.iter().map(|r| r.effect.yi).collect();
            let v: Vec<f64> = rows.iter().map(|r| r.effect.vi).collect();
            let effects: Vec<Effect> = rows.iter().map(|r| r.effect).collect();
            let cluster: Vec<String> = rows.iter().map(|r| r.record.clone()).collect();
            let row_ids: Vec<String> = rows.iter().map(|r| format!("{}#{}", r.record, r.data.row.unwrap_or(0))).collect();
            let labels: Vec<String> = {
                let mut count: BTreeMap<&str, usize> = BTreeMap::new();
                for r in &rows {
                    *count.entry(&r.record).or_default() += 1;
                }
                let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
                rows.iter()
                    .map(|r| {
                        if count[r.record.as_str()] > 1 {
                            let n = seen.entry(&r.record).or_default();
                            *n += 1;
                            format!("{} ({})", r.label, n)
                        } else {
                            r.label.clone()
                        }
                    })
                    .collect()
            };
            let studies = cluster.iter().collect::<std::collections::BTreeSet<_>>().len();
            let multiple = studies < rows.len();
            let datas: Vec<&StudyData> = rows.iter().map(|r| &r.data).collect();
            let mods: Vec<Moderator> = req.moderators.iter().map(|m| moderator_values(state, m, &datas, &raw, rob.as_ref(), &outcome_key)).collect();
            let err = |e: String| json!({ "error": e });
            let mut out = json!({
                "k": rows.len(),
                "studies": studies,
                "multipleEstimates": multiple,
                "measure": req.options.measure,
                "measureLabel": req.options.measure.label(),
                "transform": if req.options.measure.is_ratio() || (req.options.measure == Measure::GEN && rows.iter().any(|r| r.data.ratio)) { "exp" } else { req.options.measure.transform() },
                "skipped": skipped,
                "points": rows.iter().zip(&labels).map(|(r, l)| json!({ "id": r.record, "label": l, "yi": r.effect.yi, "vi": r.effect.vi, "year": r.year })).collect::<Vec<_>>(),
            });
            if multiple && req.dependence.is_none() {
                out["dependenceWarning"] = json!(format!("{} estimates come from {} studies. Methods that assume one estimate per study count those studies more than once; use \"Several estimates per study\" to account for it.", rows.len(), studies));
            }
            if let Some(o) = &req.metareg {
                out["metaRegression"] = if multiple && req.dependence.is_some() { json!({ "note": "With several estimates per study, the moderators are fitted in the multilevel model below." }) } else { metareg(&row_ids, &labels, &y, &v, &mods, o).map(|r| json!(r)).unwrap_or_else(err) };
            }
            if let Some(o) = &req.dependence {
                let mods = if req.metareg.is_some() { mods.clone() } else { Vec::new() };
                out["dependence"] = crate::dependence::analyse(&row_ids, &cluster, &y, &v, &mods, o).map(|r| json!(r)).unwrap_or_else(err);
            }
            if let Some(b) = &req.bias {
                let mut bias = json!({});
                let cl = multiple.then_some(cluster.as_slice());
                if b.pet_peese {
                    bias["petPeese"] = crate::pubbias::pet_peese(&y, &v, cl, b.alpha.unwrap_or(0.05), b.one_sided).map(|r| json!(r)).unwrap_or_else(err);
                }
                if b.uwls {
                    bias["uwls"] = json!(crate::pubbias::uwls_waap(&y, &v));
                }
                if !b.trim_fill.is_empty() {
                    bias["trimFill"] = if multiple { err("Trim and fill assumes one estimate per study; aggregate first or use PET-PEESE with robust standard errors".into()) } else { crate::pubbias::trim_fill(&y, &v, req.options.method, if b.trim_fill == "R0" { "R0" } else { "L0" }).map(|r| json!(r)).unwrap_or_else(err) };
                }
                if b.selection {
                    bias["selection"] = if multiple { err("The selection model assumes one estimate per study".into()) } else { crate::pubbias::selection_model(&y, &v).map(|r| json!(r)).unwrap_or_else(err) };
                }
                bias["caution"] = json!(crate::pubbias::power_caution(studies));
                out["bias"] = bias;
            }
            if let Some(s) = &req.sensitivity {
                let mut sens = json!({});
                if s.influence {
                    sens["influence"] = crate::sensitivity::influence(&row_ids, &labels, &effects, req.options.method, req.options.hartung_knapp).map(|r| json!(r)).unwrap_or_else(err);
                }
                if !s.cumulative.is_empty() {
                    let mut order: Vec<usize> = (0..rows.len()).collect();
                    match s.cumulative.as_str() {
                        "year" => order.sort_by_key(|i| (rows[*i].year.unwrap_or(i64::MAX), *i)),
                        "precision" => order.sort_by(|a, b| v[*a].partial_cmp(&v[*b]).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(b))),
                        _ => {}
                    }
                    sens["cumulative"] = json!(crate::sensitivity::cumulative(&row_ids, &labels, &effects, &order, req.options.method, req.options.hartung_knapp, req.options.level));
                    sens["cumulativeOrder"] = json!(s.cumulative);
                }
                if s.models {
                    sens["models"] = json!(crate::sensitivity::model_comparison(&effects, req.options.level));
                }
                if multiple {
                    sens["note"] = json!("These tools treat each estimate as a separate study.");
                }
                out["sensitivity"] = sens;
            }
            Ok(out)
        })
    }
}

/// The method's name as it is reported ("Random effects (REML, Hartung–Knapp)").
pub fn model_text(o: &Options) -> String {
    match o.method {
        Method::Fe => "fixed-effect (inverse variance)".into(),
        Method::Dl => format!("random-effects (DerSimonian–Laird{})", if o.hartung_knapp { ", Hartung–Knapp" } else { "" }),
        Method::Reml => format!("random-effects (REML{})", if o.hartung_knapp { ", Hartung–Knapp" } else { "" }),
    }
}
