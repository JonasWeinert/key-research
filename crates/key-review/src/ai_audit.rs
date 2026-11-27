// AI-use disclosure and audit (std-B). AI stays off by default and is only ever a suggestion:
// it never decides and never counts as a reviewer. Every suggestion is logged in its event
// (`ai.suggest` for screening, `extract.value` by the "ai" actor for extraction) with the
// provider, the model as configured and as the provider reported it, the date, the prompt
// template (id, version and SHA-256; the template text is stored once per version in an
// `ai.prompt` event), the request's hash and settings, and which fields or passages it read.
// What the human then did is read from the human's own later events (decisions, extracted
// values), so it cannot drift from the record: accepted, changed, rejected, or still pending.
//
// From these: human–AI agreement for screening (confusion matrix, sensitivity of the AI for the
// human's includes, specificity, false-negative rate, Cohen's kappa) and per field for
// extraction; an audit sample the human screens or codes blind to the AI (MAER-Net 2026: the
// larger of 10 % or 100 records for screening, of 10 % or 20 studies for coding); and an AI-use
// statement for the manuscript.
use crate::conduct::{StdB, iso_date};
use crate::derive::{State, Status};
use crate::events::{Event, Rng, random_u64};
use crate::model::*;
use crate::store::{Result, Reviews};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptVersion {
    pub id: String,
    pub version: String,
    pub hash: String,
    pub task: String,
    pub text: String,
    pub at: i64,
}

/// The prompt template behind a task's requests: its id, version and full text (the system
/// message and the shape of the user message; the record's own data fill it in).
pub fn template(task: &str) -> PromptVersion {
    let (id, request, shape) = if task == "extraction" {
        (
            "extraction",
            crate::ai::extraction_request(&Form::default(), &RecordMeta::default(), &[]),
            "User message (JSON): study {title, year, journal}; form name; fields [{fieldId, label, type, guidance, options, unit, columns}]; passages [{id, label, text}] — the abstract and the full text page by page, at most 24,000 characters.",
        )
    } else {
        (
            "screening",
            crate::ai::screening_request(&Protocol::default(), Stage::Ta, &RecordMeta::default()),
            "User message (JSON): stage; reviewQuestion; criteria [{mustMeet, guidance}] for the stage; record {title, abstract (first 6,000 characters), year, journal, type, keywords}.",
        )
    };
    let text = format!("System message:\n{}\n\n{shape}\nSettings: maxTokens {}, JSON answer {}.", request["system"].as_str().unwrap_or(""), request["maxTokens"], request["json"]);
    PromptVersion { id: id.into(), version: "1".into(), hash: sha256(&text), task: task.into(), text, at: 0 }
}

/// The fields a task's request reads.
pub fn scope(task: &str, passages: &[String]) -> Vec<String> {
    if task == "extraction" {
        let mut out = vec!["title".to_string(), "year".into(), "journal".into()];
        out.extend(passages.iter().cloned());
        out
    } else {
        ["title", "abstract", "year", "journal", "type", "keywords", "criteria", "question"].iter().map(|s| s.to_string()).collect()
    }
}

/// What the host knows about the call, as the main process reported it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CallInfo {
    pub provider: String,
    pub provider_name: String,
    /// The model id Key asked for.
    pub model: String,
    /// The model id (with version or date) the provider's answer named.
    pub model_reported: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

/// The payload fields that log one call: added to `ai.suggest` and AI `extract.value`.
pub fn call_fields(task: &str, request: &Json, call: &CallInfo, passages: &[String]) -> serde_json::Map<String, Json> {
    let t = template(task);
    let mut m = serde_json::Map::new();
    m.insert("task".into(), json!(task));
    m.insert("provider".into(), json!(call.provider));
    m.insert("providerName".into(), json!(call.provider_name));
    m.insert("model".into(), json!(call.model));
    m.insert("modelReported".into(), json!(if call.model_reported.is_empty() { &call.model } else { &call.model_reported }));
    m.insert("promptId".into(), json!(t.id));
    m.insert("promptVersion".into(), json!(t.version));
    m.insert("promptHash".into(), json!(t.hash));
    m.insert("requestHash".into(), json!(sha256(&format!("{}\n{}", request["system"].as_str().unwrap_or(""), request["prompt"].as_str().unwrap_or("")))));
    m.insert("params".into(), json!({ "maxTokens": request["maxTokens"], "json": request["json"], "temperature": null, "tokensIn": call.tokens_in, "tokensOut": call.tokens_out }));
    m.insert("scope".into(), json!(scope(task, passages)));
    m
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLog {
    pub event: String,
    pub at: i64,
    pub record_id: String,
    /// screening | extraction
    pub task: String,
    pub stage: Option<Stage>,
    pub form_id: String,
    pub field_id: String,
    pub provider: String,
    pub provider_name: String,
    pub model: String,
    pub model_reported: String,
    pub prompt_id: String,
    pub prompt_version: String,
    pub prompt_hash: String,
    pub request_hash: String,
    pub params: Json,
    pub scope: Vec<String>,
    pub output: Json,
    pub rationale: String,
    pub score: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Audit {
    pub id: String,
    /// screening | extraction
    pub task: String,
    pub stage: Option<Stage>,
    pub records: Vec<String>,
    /// Records (or studies) the AI made suggestions for.
    pub population: usize,
    /// The size the rule asks for; `records` may be fewer when not enough are undecided.
    pub target: usize,
    pub percent: f64,
    pub minimum: usize,
    pub seed: u64,
    pub open: bool,
    pub at: i64,
    pub actor: String,
}

pub fn observe(s: &mut StdB, e: &Event) {
    let p = &e.payload;
    let text = |k: &str| p.get(k).and_then(Json::as_str).unwrap_or("").to_string();
    let log = |task: &str, stage: Option<Stage>| AiLog {
        event: e.id.clone(),
        at: e.at,
        record_id: e.record_id.clone().unwrap_or_default(),
        task: task.into(),
        stage,
        form_id: text("formId"),
        field_id: text("fieldId"),
        provider: text("provider"),
        provider_name: text("providerName"),
        model: text("model"),
        model_reported: text("modelReported"),
        prompt_id: text("promptId"),
        prompt_version: text("promptVersion"),
        prompt_hash: text("promptHash"),
        request_hash: text("requestHash"),
        params: p.get("params").cloned().unwrap_or(Json::Null),
        scope: p.get("scope").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect()).unwrap_or_default(),
        output: p.get("value").cloned().unwrap_or(Json::Null),
        rationale: text("rationale"),
        score: p.get("score").and_then(Json::as_f64),
    };
    match e.kind.as_str() {
        "ai.suggest" => {
            let stage = p.get("stage").and_then(|v| serde_json::from_value::<Stage>(v.clone()).ok());
            let l = log("screening", stage);
            s.ai_log.push(l);
        }
        "extract.value" if e.actor == "ai" => {
            let l = log("extraction", None);
            s.ai_log.push(l);
        }
        "ai.prompt" => {
            if let Ok(mut v) = serde_json::from_value::<PromptVersion>(p.clone()) {
                v.at = e.at;
                s.prompts.entry(format!("{}@{}", v.id, v.version)).or_insert(v);
            }
        }
        "ai.audit" => {
            if let Ok(mut a) = serde_json::from_value::<Audit>(p.clone()) {
                a.at = if a.at == 0 { e.at } else { a.at };
                a.actor = e.actor.clone();
                match s.audits.iter_mut().find(|x| x.id == a.id) {
                    Some(x) => *x = a,
                    None => s.audits.push(a),
                }
            }
        }
        _ => {}
    }
}

// ── What the human did ────────────────────────────────────────────────────────────────

fn canonical(v: &Json) -> String {
    match v {
        Json::String(s) => {
            let t = s.trim().to_lowercase();
            t.replace(',', ".").parse::<f64>().map(|n| format!("{n}")).unwrap_or(t)
        }
        Json::Number(n) => n.as_f64().map(|n| format!("{n}")).unwrap_or_default(),
        Json::Null => String::new(),
        other => other.to_string(),
    }
}

fn human(id: &str) -> bool {
    !matches!(id, "ai" | "rules" | "system")
}

/// accepted | changed | rejected | pending.
pub fn outcome(state: &State, l: &AiLog) -> &'static str {
    if l.task == "screening" {
        let Some(stage) = l.stage else { return "pending" };
        let Some(r) = state.record(&l.record_id) else { return "pending" };
        let ai = l.output.as_str().unwrap_or("");
        let human_value = match state.status(r, stage) {
            Status::Final { value, auto: false, .. } => Some(value),
            _ => r.current(stage).into_iter().find(|d| human(&d.reviewer) && d.at >= l.at).map(|d| d.value),
        };
        return match human_value {
            None => "pending",
            Some(v) if format!("{v:?}").eq_ignore_ascii_case(ai) => "accepted",
            Some(_) => "rejected",
        };
    }
    let Some(ex) = state.extraction.get(&l.record_id) else { return "pending" };
    let key = (l.form_id.clone(), l.field_id.clone());
    let wanted = canonical(&l.output);
    let mut values: Vec<String> = ex.values.get(&key).map(|v| v.iter().filter(|(w, _)| human(w)).map(|(_, x)| canonical(&x.value)).collect()).unwrap_or_default();
    if let Some(f) = ex.finals.get(&key) {
        values = vec![canonical(&f.value)];
    }
    values.retain(|v| !v.is_empty());
    if values.iter().any(|v| *v == wanted) {
        "accepted"
    } else if !values.is_empty() {
        "changed"
    } else if ex.completed.get(&l.form_id).is_some_and(|who| who.iter().any(|w| human(w))) {
        "rejected"
    } else {
        "pending"
    }
}

// ── Agreement ─────────────────────────────────────────────────────────────────────────

/// A 2×2 table of the AI's suggestion against the human's final decision. "Positive" is
/// include or maybe (both go on to the next stage).
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Confusion {
    /// AI include, human include.
    pub tp: usize,
    /// AI include, human exclude.
    pub fp: usize,
    /// AI exclude, human include: the records an AI-only screen would have lost.
    pub fn_: usize,
    pub tn: usize,
    pub n: usize,
    pub percent: Option<f64>,
    /// TP / (TP + FN): of the human's includes, the share the AI also suggested including.
    pub sensitivity: Option<f64>,
    /// TN / (TN + FP).
    pub specificity: Option<f64>,
    /// FN / (TP + FN) = 1 − sensitivity (MAER-Net asks for it).
    pub false_negative_rate: Option<f64>,
    pub kappa: Option<f64>,
    pub band: String,
}

/// From (AI positive, human positive) pairs. Sensitivity, specificity and the false-negative
/// rate as in Altman & Bland, "Diagnostic tests 1", BMJ 1994;308:1552; Cohen's kappa as in
/// Cohen 1960, Educ Psychol Meas 20:37 (stats::cohen).
pub fn confusion(pairs: &[(bool, bool)]) -> Confusion {
    let mut c = Confusion { n: pairs.len(), ..Default::default() };
    for (ai, person) in pairs {
        match (ai, person) {
            (true, true) => c.tp += 1,
            (true, false) => c.fp += 1,
            (false, true) => c.fn_ += 1,
            (false, false) => c.tn += 1,
        }
    }
    let ratio = |a: usize, b: usize| (b > 0).then(|| a as f64 / b as f64);
    c.sensitivity = ratio(c.tp, c.tp + c.fn_);
    c.specificity = ratio(c.tn, c.tn + c.fp);
    c.false_negative_rate = ratio(c.fn_, c.tp + c.fn_);
    let labels: Vec<(String, String)> = pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    let k = crate::stats::cohen(&labels);
    c.percent = k.percent;
    c.kappa = k.kappa;
    c.band = k.band;
    c
}

fn positive(v: &str) -> bool {
    matches!(v, "include" | "maybe")
}

/// The latest AI suggestion per record at a stage.
fn latest_screening(state: &State, stage: Stage) -> BTreeMap<&str, &AiLog> {
    let mut out = BTreeMap::new();
    for l in state.std_b.ai_log.iter().filter(|l| l.task == "screening" && l.stage == Some(stage)) {
        out.insert(l.record_id.as_str(), l);
    }
    out
}

/// AI against the human's final decision at a stage, over `only` (an audit's records) or all.
pub fn screening_agreement(state: &State, stage: Stage, only: Option<&[String]>) -> Confusion {
    let mut pairs = Vec::new();
    for (id, l) in latest_screening(state, stage) {
        if only.is_some_and(|o| !o.iter().any(|x| x == id)) {
            continue;
        }
        let Some(r) = state.record(id) else { continue };
        if let Status::Final { value, auto: false, .. } = state.status(r, stage) {
            pairs.push((positive(l.output.as_str().unwrap_or("")), value != Choice::Exclude));
        }
    }
    confusion(&pairs)
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldAgreement {
    pub form_id: String,
    pub field_id: String,
    pub label: String,
    /// Suggestions with a human value to compare.
    pub n: usize,
    pub agree: usize,
    pub percent: Option<f64>,
}

/// Per field: the AI's latest suggestion against the human value (the agreed one, else the
/// extractors' when they agree), over `only` (an audit's studies) or every study.
pub fn extraction_agreement(state: &State, only: Option<&[String]>) -> Vec<FieldAgreement> {
    let mut latest: BTreeMap<(&str, &str, &str), &AiLog> = BTreeMap::new();
    for l in state.std_b.ai_log.iter().filter(|l| l.task == "extraction") {
        latest.insert((l.record_id.as_str(), l.form_id.as_str(), l.field_id.as_str()), l);
    }
    let mut per: BTreeMap<(String, String), (usize, usize)> = BTreeMap::new();
    for ((record, form, field), l) in latest {
        if only.is_some_and(|o| !o.iter().any(|x| x == record)) {
            continue;
        }
        let Some(ex) = state.extraction.get(record) else { continue };
        let key = (form.to_string(), field.to_string());
        let human_value = match ex.finals.get(&key) {
            Some(f) => Some(canonical(&f.value)),
            None => {
                let vals: BTreeSet<String> = ex.values.get(&key).map(|v| v.iter().filter(|(w, _)| human(w)).map(|(_, x)| canonical(&x.value)).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
                (vals.len() == 1).then(|| vals.into_iter().next().unwrap())
            }
        };
        let Some(h) = human_value else { continue };
        let e = per.entry(key).or_default();
        e.0 += 1;
        if canonical(&l.output) == h {
            e.1 += 1;
        }
    }
    per.into_iter()
        .map(|((form_id, field_id), (n, agree))| {
            let label = state.protocol.forms.iter().find(|f| f.id == form_id).and_then(|f| f.fields().find(|x| x.id == field_id)).map(|x| x.label.clone()).unwrap_or_else(|| field_id.clone());
            FieldAgreement { form_id, field_id, label, n, agree, percent: (n > 0).then(|| agree as f64 / n as f64 * 100.0) }
        })
        .collect()
}

// ── The audit sample ──────────────────────────────────────────────────────────────────

/// MAER-Net 2026's default audit size: the larger of `percent` of the population or `minimum`,
/// never more than the population (screening: 10 % or 100 records; coding: 10 % or 20 studies).
pub fn audit_size(population: usize, percent: f64, minimum: usize) -> usize {
    let share = (population as f64 * percent / 100.0).ceil() as usize;
    share.max(minimum).min(population)
}

pub fn defaults(task: &str) -> (f64, usize) {
    if task == "extraction" { (10.0, 20) } else { (10.0, 100) }
}

/// Whether the AI's screening suggestion is hidden from `viewer` (an open audit's record they
/// have not decided yet: they screen it blind).
pub fn hidden(state: &State, record: &str, stage: Stage, viewer: &str) -> bool {
    state.std_b.audits.iter().any(|a| a.open && a.task == "screening" && a.stage == Some(stage) && a.records.iter().any(|r| r == record))
        && state.record(record).is_none_or(|r| r.mine(stage, viewer).is_none())
}

/// The same for extraction: an open coding audit's study the viewer has not extracted yet.
pub fn hidden_extraction(state: &State, record: &str, viewer: &str) -> bool {
    state.std_b.audits.iter().any(|a| a.open && a.task == "extraction" && a.records.iter().any(|r| r == record))
        && !state.extraction.get(record).is_some_and(|e| e.values.values().any(|v| v.contains_key(viewer)))
}

impl Reviews {
    /// Logs a screening suggestion with its call (and the prompt version, once).
    pub fn ai_log_screening(&self, review: &str, record: &str, stage: Stage, suggestion: Json, request: &Json, call: &CallInfo) -> Result<()> {
        let mut p = suggestion.as_object().cloned().unwrap_or_default();
        p.extend(call_fields("screening", request, call, &[]));
        p.insert("stage".into(), json!(stage));
        self.write(review, |state, _, b| {
            let mut events = prompt_event(state, b, "screening");
            events.push(b.event("ai.suggest", "ai", Some(record), Json::Object(p)));
            Ok((events, ()))
        })
    }

    /// Logs extraction suggestions (each an `extract.value` by "ai") with their call.
    pub fn ai_log_extraction(&self, review: &str, record: &str, form: &str, values: &[crate::ai::Suggested], request: &Json, call: &CallInfo, passages: &[String]) -> Result<usize> {
        let fields = call_fields("extraction", request, call, passages);
        self.write(review, |state, _, b| {
            if state.record(record).is_none() {
                return Err("This record no longer exists".into());
            }
            let mut events = prompt_event(state, b, "extraction");
            for s in values {
                let mut p = serde_json::Map::new();
                p.extend(fields.clone());
                p.extend(json!({ "formId": form, "fieldId": s.field, "value": s.value, "quote": s.quote, "page": s.page, "suggested": true }).as_object().cloned().unwrap_or_default());
                events.push(b.event("extract.value", "ai", Some(record), Json::Object(p)));
            }
            Ok((events, values.len()))
        })
    }

    /// Draws an audit sample (seeded) from the records the AI made suggestions for and nobody has
    /// decided (or coded) yet; they are then screened blind to the AI.
    #[allow(clippy::too_many_arguments)]
    pub fn ai_audit_draw(&self, review: &str, task: &str, stage: Stage, percent: Option<f64>, minimum: Option<usize>, seed: Option<u64>, actor: &str) -> Result<Audit> {
        let (dp, dm) = defaults(task);
        let (percent, minimum) = (percent.unwrap_or(dp).clamp(0.0, 100.0), minimum.unwrap_or(dm));
        self.write(review, |state, _, b| {
            if state.std_b.audits.iter().any(|a| a.open && a.task == task) {
                return Err("An audit is already open: finish or close it first".into());
            }
            let (population, mut pool): (usize, Vec<String>) = if task == "extraction" {
                let with: BTreeSet<&str> = state.std_b.ai_log.iter().filter(|l| l.task == "extraction").map(|l| l.record_id.as_str()).collect();
                let pool = with.iter().filter(|id| !state.extraction.get(**id).is_some_and(|e| e.values.values().any(|v| v.keys().any(|k| human(k))))).map(|s| s.to_string()).collect();
                (with.len(), pool)
            } else {
                let latest = latest_screening(state, stage);
                let pool = latest.keys().filter(|id| state.record(id).is_some_and(|r| state.eligible(r, stage) && r.current(stage).iter().all(|d| !human(&d.reviewer)) && r.resolution(stage).is_none())).map(|s| s.to_string()).collect();
                (latest.len(), pool)
            };
            if population == 0 {
                return Err(if task == "extraction" { "No study has AI suggestions yet".into() } else { "No record has an AI suggestion yet".into() });
            }
            if pool.is_empty() {
                return Err("Every record with an AI suggestion was already decided with the suggestion in view: ask AI on undecided records, then draw the sample".into());
            }
            let target = audit_size(population, percent, minimum);
            let seed = seed.unwrap_or_else(random_u64);
            pool.sort();
            Rng::new(seed).shuffle(&mut pool);
            pool.truncate(target);
            let n = state.std_b.audits.len() + 1;
            let audit = Audit { id: format!("audit{n}"), task: task.into(), stage: (task != "extraction").then_some(stage), records: pool, population, target, percent, minimum, seed, open: true, at: 0, actor: actor.into() };
            Ok((vec![b.event("ai.audit", actor, None, serde_json::to_value(&audit).map_err(|e| e.to_string())?)], audit))
        })
    }

    pub fn ai_audit_close(&self, review: &str, id: &str, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            let mut a = state.std_b.audits.iter().find(|a| a.id == id).cloned().ok_or("This audit no longer exists")?;
            a.open = false;
            Ok((vec![b.event("ai.audit", actor, None, serde_json::to_value(&a).map_err(|e| e.to_string())?)], ()))
        })
    }

    /// The AI use panel: the log, agreement, audits and the statement.
    pub fn ai_use(&self, review: &str) -> Result<Json> {
        self.read(review, |state, _| Ok(ai_view(state)))
    }
}

fn prompt_event(state: &State, b: &crate::store::Builder, task: &str) -> Vec<Event> {
    let t = template(task);
    if state.std_b.prompts.contains_key(&format!("{}@{}", t.id, t.version)) {
        return Vec::new();
    }
    vec![b.event("ai.prompt", "system", None, serde_json::to_value(&t).unwrap_or(Json::Null))]
}

pub fn audit_report(state: &State, a: &Audit) -> Json {
    if a.task == "extraction" {
        let fields = extraction_agreement(state, Some(&a.records));
        let done = a.records.iter().filter(|r| state.extraction.get(*r).is_some_and(|e| e.values.values().any(|v| v.keys().any(|k| human(k))))).count();
        let (n, agree): (usize, usize) = fields.iter().fold((0, 0), |acc, f| (acc.0 + f.n, acc.1 + f.agree));
        json!({ "audit": a, "done": done, "fields": fields, "percent": (n > 0).then(|| agree as f64 / n as f64 * 100.0) })
    } else {
        let stage = a.stage.unwrap_or(Stage::Ta);
        let done = a.records.iter().filter(|r| state.record(r).is_some_and(|x| state.status(x, stage).is_final())).count();
        json!({ "audit": a, "done": done, "agreement": screening_agreement(state, stage, Some(&a.records)) })
    }
}

fn models(state: &State) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in &state.std_b.ai_log {
        let who = if l.provider_name.is_empty() { l.provider.clone() } else { l.provider_name.clone() };
        let model = if l.model_reported.is_empty() || l.model_reported == l.model { l.model.clone() } else { format!("{} (reported as {})", l.model, l.model_reported) };
        let line = [who, model].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", ");
        let line = if line.is_empty() { "a model that was not recorded".into() } else { line };
        if !out.contains(&line) {
            out.push(line);
        }
    }
    out
}

fn pct(x: Option<f64>) -> String {
    x.map(|v| format!("{:.0} %", v * 100.0)).unwrap_or_else(|| "–".into())
}

fn stage_words(stage: Stage) -> &'static str {
    match stage {
        Stage::Ta => "title and abstract screening",
        Stage::Ft => "full-text screening",
    }
}

/// The statement for the manuscript's methods (plain sentences, no LLM).
pub fn statement(state: &State) -> Option<(String, Option<String>)> {
    let log = &state.std_b.ai_log;
    if log.is_empty() {
        return None;
    }
    let mut tasks: Vec<String> = Vec::new();
    for stage in [Stage::Ta, Stage::Ft] {
        let n = log.iter().filter(|l| l.task == "screening" && l.stage == Some(stage)).map(|l| &l.record_id).collect::<BTreeSet<_>>().len();
        if n > 0 {
            tasks.push(format!("to suggest decisions at {} ({n} records)", stage_words(stage)));
        }
    }
    let studies = log.iter().filter(|l| l.task == "extraction").map(|l| &l.record_id).collect::<BTreeSet<_>>().len();
    if studies > 0 {
        tasks.push(format!("to suggest extracted values, each with its quote ({studies} {})", if studies == 1 { "study" } else { "studies" }));
    }
    let first = log.iter().map(|l| l.at).min().unwrap_or(0);
    let last = log.iter().map(|l| l.at).max().unwrap_or(0);
    let dates = if iso_date(first) == iso_date(last) { format!("on {}", iso_date(first)) } else { format!("between {} and {}", iso_date(first), iso_date(last)) };
    let prompts: BTreeSet<String> = log.iter().filter(|l| !l.prompt_id.is_empty()).map(|l| format!("{} v{}", l.prompt_id, l.prompt_version)).collect();
    let prompts = if prompts.is_empty() { String::new() } else { format!(" The prompts ({}) are given in full in the appendix.", prompts.into_iter().collect::<Vec<_>>().join(", ")) };
    let text = format!(
        "We used {} through Key {dates} {}.{prompts} AI suggestions were shown to reviewers beside the record and never made a decision: every screening decision and every extracted value was made by a human reviewer, and the AI did not count as a reviewer.",
        models(state).join("; "),
        tasks.join(" and ")
    );
    let mut results = Vec::new();
    for stage in [Stage::Ta, Stage::Ft] {
        let c = screening_agreement(state, stage, None);
        if c.n > 0 {
            results.push(format!(
                "At {}, AI suggestions agreed with the reviewers' final decisions for {} of {} records ({}; Cohen's κ = {}), with a sensitivity for included records of {} and a false-negative rate of {}",
                stage_words(stage),
                c.tp + c.tn,
                c.n,
                c.percent.map(|p| format!("{p:.0} %")).unwrap_or_default(),
                c.kappa.map(|k| format!("{k:.2}")).unwrap_or_else(|| "not defined".into()),
                pct(c.sensitivity),
                pct(c.false_negative_rate)
            ));
        }
    }
    let fields = extraction_agreement(state, None);
    let (n, agree) = fields.iter().fold((0, 0), |acc, f| (acc.0 + f.n, acc.1 + f.agree));
    if n > 0 {
        results.push(format!("AI-suggested values matched the reviewers' values for {agree} of {n} fields ({:.0} %)", agree as f64 / n as f64 * 100.0));
    }
    for a in state.std_b.audits.iter().filter(|a| !a.open) {
        if a.task == "extraction" {
            continue;
        }
        let c = screening_agreement(state, a.stage.unwrap_or(Stage::Ta), Some(&a.records));
        results.push(format!(
            "In a blind human audit of {} randomly drawn records ({} of the {} the AI assessed; the larger of {:.0} % or {}), the AI's false-negative rate was {}",
            a.records.len(),
            if a.records.len() < a.target { format!("fewer than the {} planned", a.target) } else { "as planned".into() },
            a.population,
            a.percent,
            a.minimum,
            pct(c.false_negative_rate)
        ));
    }
    let results = (!results.is_empty()).then(|| format!("{}.", results.join(". ")));
    Some((text, results))
}

/// For std-A's checklist (`conduct::reporting_facts`).
pub fn facts(state: &State) -> Json {
    let Some((text, results)) = statement(state) else {
        return json!({ "used": false, "statement": "No AI was used: AI assistance is off by default in Key and was not turned on.", "stages": [], "models": [] });
    };
    let mut stages: Vec<&str> = Vec::new();
    for (task, stage, label) in [("screening", Some(Stage::Ta), "title and abstract screening"), ("screening", Some(Stage::Ft), "full-text screening"), ("extraction", None, "data extraction")] {
        if state.std_b.ai_log.iter().any(|l| l.task == task && (stage.is_none() || l.stage == stage)) {
            stages.push(label);
        }
    }
    json!({ "used": true, "statement": text, "results": results, "stages": stages, "models": models(state) })
}

fn ai_view(state: &State) -> Json {
    let rows: Vec<Json> = state.std_b.ai_log.iter().rev().take(500).map(|l| json!({ "log": l, "outcome": outcome(state, l) })).collect();
    let mut outcomes: BTreeMap<&str, usize> = BTreeMap::new();
    for l in &state.std_b.ai_log {
        *outcomes.entry(outcome(state, l)).or_default() += 1;
    }
    let screening: Vec<Json> = [Stage::Ta, Stage::Ft].iter().map(|s| json!({ "stage": s, "agreement": screening_agreement(state, *s, None), "population": latest_screening(state, *s).len() })).collect();
    let (text, results) = statement(state).map(|(t, r)| (Some(t), r)).unwrap_or((None, None));
    json!({
        "on": state.protocol.rules.ai_assist,
        "suggestions": state.std_b.ai_log.len(),
        "outcomes": outcomes,
        "log": rows,
        "screening": screening,
        "extraction": extraction_agreement(state, None),
        "audits": state.std_b.audits.iter().map(|a| audit_report(state, a)).collect::<Vec<_>>(),
        "defaults": { "screening": defaults("screening"), "extraction": defaults("extraction") },
        "statement": text,
        "results": results,
        "prompts": state.std_b.prompts.values().collect::<Vec<_>>(),
        "models": models(state),
    })
}

/// The statement as a Markdown document: the paragraph, the numbers, and the prompts.
pub fn statement_markdown(state: &State) -> String {
    let mut out = String::from("# Use of AI\n\n");
    match statement(state) {
        None => out.push_str("No AI was used: AI assistance is off by default in Key and was not turned on for this review.\n"),
        Some((text, results)) => {
            out.push_str(&text);
            out.push_str("\n\n");
            if let Some(r) = results {
                out.push_str(&r);
                out.push_str("\n\n");
            }
            out.push_str("## Human–AI agreement\n\n| Stage | Records | TP | FP | FN | TN | Agreement | κ | Sensitivity | Specificity | False-negative rate |\n|---|---|---|---|---|---|---|---|---|---|---|\n");
            for stage in [Stage::Ta, Stage::Ft] {
                let c = screening_agreement(state, stage, None);
                if c.n == 0 {
                    continue;
                }
                out.push_str(&format!(
                    "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |\n",
                    stage.label(), c.n, c.tp, c.fp, c.fn_, c.tn,
                    c.percent.map(|p| format!("{p:.1} %")).unwrap_or_default(),
                    c.kappa.map(|k| format!("{k:.2}")).unwrap_or_else(|| "–".into()),
                    pct(c.sensitivity), pct(c.specificity), pct(c.false_negative_rate)
                ));
            }
            out.push_str("\nPositive means include or maybe (both go on to the next stage). TP: both include; FN: the AI suggested excluding a record the reviewers included.\n");
            let fields = extraction_agreement(state, None);
            if !fields.is_empty() {
                out.push_str("\n## Extraction\n\n| Field | Compared | Same value | Agreement |\n|---|---|---|---|\n");
                for f in fields {
                    out.push_str(&format!("| {} | {} | {} | {} |\n", f.label, f.n, f.agree, f.percent.map(|p| format!("{p:.0} %")).unwrap_or_default()));
                }
            }
            out.push_str("\n## Appendix: prompts\n");
            let mut seen = BTreeSet::new();
            for l in &state.std_b.ai_log {
                seen.insert((l.prompt_id.clone(), l.prompt_version.clone()));
            }
            for (id, version) in seen.into_iter().filter(|(id, _)| !id.is_empty()) {
                let t = state.std_b.prompts.get(&format!("{id}@{version}")).cloned().unwrap_or_else(|| template(&id));
                out.push_str(&format!("\n### {id}, version {version}\n\nSHA-256 {}\n\n```text\n{}\n```\n", t.hash, t.text));
            }
        }
    }
    out
}

pub fn log_csv(state: &State) -> String {
    let mut out = String::from("Time (UTC),Record,Task,Stage,Form,Field,Provider,Model,Model reported,Prompt,Prompt version,Prompt SHA-256,Request SHA-256,Fields read,Suggestion,Rationale,What the reviewer did\n");
    for l in &state.std_b.ai_log {
        let cells = [
            iso_date(l.at),
            l.record_id.clone(),
            l.task.clone(),
            l.stage.map(|s| s.label().to_string()).unwrap_or_default(),
            l.form_id.clone(),
            l.field_id.clone(),
            if l.provider_name.is_empty() { l.provider.clone() } else { l.provider_name.clone() },
            l.model.clone(),
            l.model_reported.clone(),
            l.prompt_id.clone(),
            l.prompt_version.clone(),
            l.prompt_hash.clone(),
            l.request_hash.clone(),
            l.scope.join("; "),
            match &l.output {
                Json::String(s) => s.clone(),
                other => other.to_string(),
            },
            l.rationale.clone(),
            outcome(state, l).to_string(),
        ];
        out.push_str(&cells.iter().map(|c| crate::export::csv_cell(c)).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    out
}
