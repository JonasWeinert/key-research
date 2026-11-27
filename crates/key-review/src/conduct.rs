// Conduct checks (std-B): quiet, soft warnings derived from the review's state against the
// conduct standards reviewers are held to, each in Key's own words with a link to the standard
// (Cochrane's MECIR conduct standards, August 2023, © Cochrane: paraphrased and linked, never
// quoted; the Campbell standards, 2024, CC BY 4.0; MAER-Net 2026, CC BY 4.0; TARCiS 2024;
// Cochrane rapid review recommendations 2024). They never block. Each can be dismissed with a
// recorded reason (`conduct.dismiss`). The review type (Setup, `protocol.plan.reviewType`, owned
// by std-A) decides which checks apply.
//
// This module also holds the derived state of std-B's other features (citation chasing, AI
// audit, extraction pilots, contacts with authors), folded from their events by `observe`, and
// `reporting_facts`, the small query interface std-A's checklist reads.
use crate::chasing::Round;
use crate::derive::{State, Status};
use crate::events::Event;
use crate::model::*;
use crate::store::{Result, Reviews};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, BTreeSet};

pub const MECIR: &str = "https://www.cochrane.org/authors/handbooks-and-manuals/mecir-manual";
pub const CAMPBELL: &str = "https://www.campbellcollaboration.org/methods/standards/";
pub const MAERNET: &str = "https://doi.org/10.1111/joes.70116";
pub const TARCIS: &str = "https://tarcis.unibas.ch";
pub const RAPID: &str = "https://www.bmj.com/content/384/bmj-2023-076335";

// ── std-B's derived state ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dismissal {
    pub reason: String,
    pub by: String,
    pub at: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RetractionCheck {
    pub at: i64,
    pub checked: usize,
    pub without_doi: usize,
    pub flagged: Vec<Json>,
    pub service: String,
    pub actor: String,
}

#[derive(Clone, Debug, Default)]
pub struct StdB {
    pub rounds: Vec<Round>,
    /// `protocol.plan` of the protocol in force (std-A's protocol builder), read raw.
    pub plan: Json,
    pub prompts: BTreeMap<String, crate::ai_audit::PromptVersion>,
    pub ai_log: Vec<crate::ai_audit::AiLog>,
    pub audits: Vec<crate::ai_audit::Audit>,
    pub dismissed: BTreeMap<String, Dismissal>,
    pub retraction_checks: Vec<RetractionCheck>,
    pub xpilots: Vec<crate::xpilot::XPilot>,
    pub piloted: Vec<crate::xpilot::FormPiloted>,
    pub contacts: Vec<crate::xpilot::Contact>,
}

/// Folds std-B's events (and what they read from others) into `StdB`. Called for every event
/// at the start of `State::apply`.
pub fn observe(s: &mut StdB, e: &Event) {
    let p = &e.payload;
    match e.kind.as_str() {
        "protocol.set" => {
            if let Some(plan) = p.pointer("/protocol/plan") {
                s.plan = plan.clone();
            }
        }
        "chase.round" => {
            if let Ok(r) = serde_json::from_value::<Round>(p.get("round").cloned().unwrap_or(Json::Null)) {
                s.rounds.retain(|x| x.round != r.round || x.batch_id != r.batch_id);
                s.rounds.push(r);
            }
        }
        "conduct.dismiss" => {
            let check = p.get("check").and_then(Json::as_str).unwrap_or("").to_string();
            if p.get("dismissed").and_then(Json::as_bool).unwrap_or(true) {
                s.dismissed.insert(check, Dismissal { reason: p.get("reason").and_then(Json::as_str).unwrap_or("").into(), by: e.actor.clone(), at: e.at });
            } else {
                s.dismissed.remove(&check);
            }
        }
        "conduct.retractions" => {
            if let Ok(mut c) = serde_json::from_value::<RetractionCheck>(p.clone()) {
                c.at = e.at;
                c.actor = e.actor.clone();
                s.retraction_checks.push(c);
            }
        }
        _ => {}
    }
    crate::ai_audit::observe(s, e);
    crate::xpilot::observe(s, e);
}

// ── Dates ─────────────────────────────────────────────────────────────────────────────

/// "2026-11-27" (UTC) for ms since the epoch (Hinnant's civil-from-days).
pub fn iso_date(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

/// Ms for "YYYY-MM-DD…" (UTC midnight), or a number of ms written as text.
pub fn parse_date(text: &str) -> Option<i64> {
    let t = text.trim();
    if !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()) {
        return t.parse().ok();
    }
    let (y, rest) = t.split_once('-')?;
    let (m, rest) = rest.split_once('-')?;
    let d: i64 = rest.get(..2)?.parse().ok()?;
    let (y, m): (i64, i64) = (y.parse().ok()?, m.parse().ok()?);
    // Days from civil (Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400_000)
}

// ── The review type ───────────────────────────────────────────────────────────────────

/// systematic | scoping | rapid | living (std-A's Setup; missing means systematic).
pub fn review_type(state: &State) -> String {
    match state.std_b.plan.get("reviewType").and_then(Json::as_str).unwrap_or("") {
        t @ ("scoping" | "rapid" | "living") => t.to_string(),
        _ => "systematic".into(),
    }
}

// ── Checks ────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub id: String,
    /// "MECIR C39 · Campbell 4"
    pub standard: String,
    pub title: String,
    pub message: String,
    /// What to do about it, in a few words.
    pub fix: String,
    /// What the panel's button does: a stage to open (setup, sources, ta, ft, extract) or an
    /// action (retractions, chase, xpilot, audit).
    pub action: String,
    pub link: String,
    /// warn | info
    pub severity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dismissed: Option<Dismissal>,
}

/// Every check Key knows, with the review types it applies to (for the help text and tests).
pub const CHECKS: &[(&str, &[&str])] = &[
    ("dual-screening-ft", &["systematic", "scoping", "living"]),
    ("dual-screening-ta", &["systematic", "living"]),
    ("screening-pilot", &["systematic", "scoping", "living"]),
    ("two-databases", &["systematic", "scoping", "rapid", "living"]),
    ("registers", &["systematic", "living"]),
    ("grey-literature", &["systematic", "scoping", "living"]),
    ("citation-searching", &["systematic", "scoping", "living"]),
    ("search-age", &["systematic", "rapid", "living"]),
    ("retractions", &["systematic", "rapid", "living"]),
    ("ft-reasons", &["systematic", "scoping", "rapid", "living"]),
    ("dual-extraction", &["systematic", "living"]),
    ("form-pilot", &["systematic", "scoping", "living"]),
    ("risk-of-bias", &["systematic", "rapid", "living"]),
    ("risk-of-bias-dual", &["systematic", "living"]),
    ("unplanned-outcomes", &["systematic", "rapid", "living"]),
    ("unplanned-analyses", &["systematic", "rapid", "living"]),
    ("conflicts", &["systematic", "scoping", "rapid", "living"]),
    ("awaiting", &["systematic", "scoping", "rapid", "living"]),
    ("ai-audit", &["systematic", "scoping", "rapid", "living"]),
];

const MONTH_MS: i64 = 30 * 86_400_000;

fn applies(id: &str, kind: &str) -> bool {
    CHECKS.iter().any(|(c, types)| *c == id && types.contains(&kind))
}

/// The newest search date among imports from databases and registers (or any import).
pub fn newest_search(state: &State) -> Option<i64> {
    state
        .batches
        .iter()
        .filter(|b| !state.removed_batches.contains(&b.id) && b.group != "other")
        .map(|b| parse_date(&b.searched_at).unwrap_or(b.at))
        .filter(|at| *at > 0)
        .max()
}

/// Named databases searched (multi-database runs count each database; registers apart).
pub fn databases(state: &State) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for b in state.batches.iter().filter(|b| !state.removed_batches.contains(&b.id)) {
        if !b.per_source.is_empty() {
            for name in b.per_source.keys() {
                let kind = b.per_source_kind.get(name).map(String::as_str).unwrap_or("database");
                if kind != "register" && b.group != "registers" {
                    out.insert(name.to_lowercase());
                }
            }
        } else if b.group == "databases" && !b.name.trim().is_empty() {
            out.insert(b.name.trim().to_lowercase());
        }
    }
    out
}

fn has_registers(state: &State) -> bool {
    state.batches.iter().filter(|b| !state.removed_batches.contains(&b.id)).any(|b| b.group == "registers" || b.per_source_kind.values().any(|k| k == "register"))
}

fn is_rob_form(f: &Form) -> bool {
    f.kind == "rob" || f.name.to_lowercase().contains("risk of bias")
}

/// The warnings for a review as it stands at `now` (ms). `outcomes` are the outcome names the
/// extracted data has (from `export::outcome_rows`).
pub fn checks(state: &State, now: i64, outcomes: &[String]) -> Vec<Warning> {
    let kind = review_type(state);
    let rules = &state.protocol.rules;
    let mut out: Vec<Warning> = Vec::new();
    let mut push = |id: &str, standard: &str, title: &str, message: String, fix: &str, action: &str, link: &str, severity: &str| {
        if applies(id, &kind) {
            out.push(Warning { id: id.into(), standard: standard.into(), title: title.into(), message, fix: fix.into(), action: action.into(), link: link.into(), severity: severity.into(), dismissed: state.std_b.dismissed.get(id).cloned() });
        }
    };
    let active = state.records.iter().filter(|r| state.active(r)).count();
    let ta_done = state.records.iter().filter(|r| !r.current(Stage::Ta).is_empty()).count();
    let included = state.included();
    let humans = |id: &str| id != "ai" && id != "rules" && id != "system";
    let extraction_started = state.extraction.values().any(|e| e.values.values().any(|v| v.keys().any(|k| humans(k))));
    let analysing = extraction_started || !state.analyses.is_empty();
    let people = state.team.iter().filter(|m| m.roles.iter().any(|r| r == "reviewer" || r == "owner")).count();

    if active > 0 {
        if rules.ft.reviewers < 2 {
            push("dual-screening-ft", "MECIR C39 · Campbell 4", "One person decides at full text", "Cochrane expects at least two people to decide independently which full texts are included, with a way to settle disagreements set beforehand; Campbell recommends the same.".into(), "Set two reviewers for full text in Setup › Team and rules", "setup", MECIR, "warn");
        }
        if rules.ta.reviewers < 2 {
            push("dual-screening-ta", "MECIR C39 · Campbell 4", "One person screens titles and abstracts", "Screening titles and abstracts in duplicate is desirable: one person alone misses some eligible studies. Two reviewers for a share of the records is a middle way.".into(), "Add a second reviewer, or double-screen a share (Setup › Team and rules)", "setup", MECIR, "info");
        }
    }
    if people >= 2 && ta_done > 0 && state.pilots.is_empty() {
        push("screening-pilot", "Campbell 4 · MECIR C39", "No calibration round", "Reviewers usually screen a small shared sample first and compare decisions, so everyone reads the criteria the same way before the main round.".into(), "Start a pilot round (Setup › Team and rules)", "setup", CAMPBELL, "info");
    }
    if !state.batches.is_empty() {
        let dbs = databases(state);
        if dbs.len() < 2 {
            push("two-databases", "MECIR C24–C25 · Campbell 3", "Fewer than two databases", format!("The records come from {} named {}. Searching at least two bibliographic databases (and the specialist ones for the topic) is the minimum both Cochrane and Campbell expect.", dbs.len(), if dbs.len() == 1 { "database" } else { "databases" }), "Search another database (Sources › Database searches)", "sources", MECIR, "warn");
        }
        if !has_registers(state) {
            push("registers", "MECIR C27", "No trial register searched", "Cochrane expects trial registers such as ClinicalTrials.gov and the WHO ICTRP to be searched as well as databases, to find unpublished and ongoing studies.".into(), "Search a register, or dismiss if registers do not apply", "sources", MECIR, "info");
        }
        let grey = state.batches.iter().filter(|b| !state.removed_batches.contains(&b.id)).any(|b| b.group == "other" && b.name != crate::chasing::BATCH_NAME);
        if !grey {
            push("grey-literature", "MECIR C28 · Campbell 3", "No grey literature", "No records come from websites, organisations, theses or other grey literature. Both standards ask reviews to look beyond journals, where publication bias is smaller.".into(), "Import from a website or organisation as another method", "sources", CAMPBELL, "info");
        }
        let chased = !state.std_b.rounds.is_empty() || state.batches.iter().any(|b| !state.removed_batches.contains(&b.id) && b.name == crate::chasing::BATCH_NAME);
        if !chased && !included.is_empty() {
            push("citation-searching", "MECIR C30 · TARCiS", "Reference lists not searched", "Checking the reference lists of included studies (and the works citing them) is mandatory for Cochrane reviews. Key can do it from the included studies in one step.".into(), "Search citations (Sources › Citation searching)", "chase", TARCIS, "warn");
        }
    }
    if analysing {
        if let Some(newest) = newest_search(state) {
            let months = (now - newest) / MONTH_MS;
            if months >= 12 {
                push("search-age", "MECIR C37", "Searches are over a year old", format!("The newest search ran {} ({months} months ago). Cochrane asks for searches to be run again within 12 months of publication and the new results screened.", iso_date(newest)), "Run the searches again as update searches", "sources", MECIR, "warn");
            }
        }
    }
    if !included.is_empty() {
        let newest_inclusion = included.iter().filter_map(|r| r.resolution(Stage::Ft).map(|d| d.at).or_else(|| r.current(Stage::Ft).iter().map(|d| d.at).max())).max().unwrap_or(0);
        let checked = state.std_b.retraction_checks.last().map(|c| c.at).unwrap_or(0);
        if checked < newest_inclusion {
            let msg = if checked == 0 { "Included studies have not been checked for retractions, corrections or expressions of concern. Key can look each DOI up in Crossref (with the Retraction Watch data) and OpenAlex and record the check.".to_string() } else { format!("Studies were included after the last check for retractions ({}).", iso_date(checked)) };
            push("retractions", "MECIR C48", "Retractions and errata not checked", msg, "Check the included studies now", "retractions", MECIR, "warn");
        }
    }
    let ft_excluded = state.records.iter().filter(|r| matches!(state.status(r, Stage::Ft), Status::Final { value: Choice::Exclude, .. })).collect::<Vec<_>>();
    let unexplained = ft_excluded.iter().filter(|r| state.final_reasons(r, Stage::Ft).is_empty() && state.final_other(r, Stage::Ft).is_empty()).count();
    if rules.ft.asks(Choice::Exclude) == "none" || unexplained > 0 {
        let msg = if unexplained > 0 { format!("{unexplained} full-text {} excluded without a reason. PRISMA reports each excluded report with its reason, and Cochrane lists the excluded studies with theirs.", if unexplained == 1 { "report was" } else { "reports were" }) } else { "Excluding a full text does not ask for the criterion it fails. PRISMA reports the reasons for every report excluded at full text.".into() };
        push("ft-reasons", "PRISMA 16b · MECIR C41", "Exclusion reasons not recorded at full text", msg, "Ask for the criterion when excluding at full text (Setup)", "setup", MECIR, "warn");
    }
    if !state.protocol.forms.is_empty() && !included.is_empty() {
        let outcome_form = state.protocol.forms.iter().any(|f| f.kind == "outcomes" || f.fields().any(|x| x.role == "outcomes"));
        if rules.extractors < 2 {
            push(
                "dual-extraction",
                "MECIR C45–C46 · Campbell 5",
                "One person extracts the data",
                if outcome_form { "Outcome data are extracted by one person. Cochrane requires two people to extract outcome data independently (and recommends it for study characteristics).".into() } else { "Study characteristics are extracted by one person. Duplicate extraction is highly desirable.".into() },
                "Set two extractors in Setup › Team and rules",
                "setup",
                MECIR,
                if outcome_form { "warn" } else { "info" },
            );
        }
        if extraction_started && state.std_b.piloted.is_empty() {
            push("form-pilot", "MECIR C43 · Campbell 5", "Extraction form not piloted", "The forms were not tried on a few studies by everyone who extracts before the main extraction. A pilot shows unclear fields early and gives the agreement to report.".into(), "Run an extraction pilot", "xpilot", MECIR, "warn");
        }
        let rob_forms: Vec<&Form> = state.protocol.forms.iter().filter(|f| is_rob_form(f)).collect();
        // std-C's assessments (rob.rs): study → the people who assessed it independently.
        let mut rob: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        for (k, a) in &state.rob.assessments {
            let who = rob.entry(k.study.as_str()).or_default();
            for (actor, w) in &a.by {
                if actor != "system" && actor != "ai" && (w.complete || !w.answers.is_empty() || !w.judgements.is_empty()) {
                    who.insert(actor.as_str());
                }
            }
        }
        rob.retain(|_, who| !who.is_empty());
        if rob_forms.is_empty() && rob.is_empty() {
            push("risk-of-bias", "MECIR C52 · Campbell 5", "No risk-of-bias assessment", "The review has no risk-of-bias form or assessment for its included studies. Cochrane assesses risk of bias for each result that feeds the conclusions.".into(), "Add a risk-of-bias form (Setup › Forms)", "setup", MECIR, "warn");
        } else {
            let single = if !rob.is_empty() { included.iter().any(|r| rob.get(r.id.as_str()).is_some_and(|who| who.len() < 2)) } else { rules.extractors < 2 };
            if single {
                push("risk-of-bias-dual", "MECIR C53", "Risk of bias assessed by one person", "Cochrane expects risk of bias to be assessed by two people independently, with a set way to resolve disagreements.".into(), "Have a second person assess risk of bias", "extract", MECIR, "info");
            }
        }
    }
    // Outcomes with data that the protocol's plan does not name (std-A's protocol builder).
    let planned: BTreeSet<String> = state.std_b.plan.get("outcomes").and_then(Json::as_array).into_iter().flatten().filter_map(|o| o.get("name").and_then(Json::as_str).or_else(|| o.as_str())).map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
    // std-D: the outcomes of saved analyses (analysis.set) count too.
    let saved = crate::interop::saved(state);
    let mut outcomes: Vec<String> = outcomes.to_vec();
    for s in &saved {
        if let Some(o) = s.request.get("outcome").and_then(Json::as_str)
            && !outcomes.iter().any(|x| x.trim().eq_ignore_ascii_case(o.trim()))
        {
            outcomes.push(o.to_string());
        }
    }
    if !planned.is_empty() {
        let unplanned: Vec<&String> = outcomes.iter().filter(|o| !planned.contains(&o.trim().to_lowercase())).collect();
        if !unplanned.is_empty() {
            let names: Vec<String> = unplanned.iter().take(4).map(|s| format!("“{s}”")).collect();
            push("unplanned-outcomes", "MECIR C68 · Campbell 1 · PRISMA 24c", "Outcomes not in the protocol", format!("Data were extracted for {} that the protocol does not plan. Analyses that were not planned should be reported as changes to the protocol, with the reason.", names.join(", ")), "Record the change in the protocol's deviations, or add the outcome", "setup", CAMPBELL, "warn");
        }
    }
    // std-D: saved analyses whose moderators or subgroups the plan does not name (MECIR C68).
    let planned_analyses: Vec<String> = ["subgroups", "sensitivity"].iter().flat_map(|k| state.std_b.plan.get(*k).and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str).map(|s| s.trim().to_lowercase())).filter(|s| !s.is_empty()).collect();
    if !state.std_b.plan.is_null() && !saved.is_empty() {
        let mut extra: Vec<String> = Vec::new();
        for s in &saved {
            for m in s.advanced.get("moderators").and_then(Json::as_array).into_iter().flatten() {
                let name = m.get("name").and_then(Json::as_str).unwrap_or("").trim().to_string();
                let low = name.to_lowercase();
                if !name.is_empty() && !planned_analyses.iter().any(|p| p.contains(&low) || low.contains(p.as_str())) && !extra.contains(&name) {
                    extra.push(name);
                }
            }
        }
        if !extra.is_empty() {
            let names: Vec<String> = extra.iter().take(4).map(|s| format!("“{s}”")).collect();
            push("unplanned-analyses", "MECIR C68 · PRISMA 13e, 24c", "Analyses not in the protocol", format!("Saved analyses examine {} as moderators, which the protocol's planned subgroup and sensitivity analyses do not name. Report them as post hoc, with the reason.", names.join(", ")), "Add them to the protocol's planned analyses, or record a deviation", "setup", MECIR, "info");
        }
    }
    let conflicts: usize = [Stage::Ta, Stage::Ft].iter().map(|s| state.records.iter().filter(|r| state.status(r, *s) == Status::Conflict).count()).sum();
    if conflicts > 0 && analysing {
        push("conflicts", "MECIR C39", "Unresolved conflicts", format!("{conflicts} {} still disagreed on while data are being extracted. They need the agreed method (consensus or a third reviewer) before the numbers are final.", if conflicts == 1 { "record is" } else { "records are" }), "Resolve the conflicts", "ft", MECIR, "warn");
    }
    if analysing {
        let waiting = state.records.iter().filter(|r| matches!(state.status(r, Stage::Ft), Status::Undecided | Status::Partial { .. } | Status::Final { value: Choice::Maybe, .. })).count();
        if waiting > 0 {
            push("awaiting", "PRISMA 16 · MECIR C41", "Records still awaiting classification", format!("{waiting} {} not decided at full text yet. If they cannot be decided, report them as studies awaiting classification.", if waiting == 1 { "record is" } else { "records are" }), "Finish full-text screening", "ft", MECIR, "info");
        }
    }
    let used_ai = state.std_b.ai_log.iter().any(|l| l.task == "screening");
    if used_ai && !state.std_b.audits.iter().any(|a| a.task == "screening") {
        push("ai-audit", "MAER-Net 2026 · Campbell 4", "AI suggestions not audited", "AI suggested screening decisions. MAER-Net asks for a human audit of a random sample (10 % or 100 records, whichever is larger) with the false-negative rate reported; Campbell asks for automation to be validated.".into(), "Draw an audit sample (Overview › AI use)", "audit", MAERNET, "warn");
    }
    out
}

impl Reviews {
    /// The Conduct panel: the review type and the warnings.
    pub fn conduct(&self, review: &str, now: i64) -> Result<Json> {
        self.read(review, |state, _| {
            let outcomes: Vec<String> = crate::export::outcomes(&crate::export::outcome_rows(state, &Default::default())).into_iter().map(|o| o.outcome).collect();
            let warnings = checks(state, now, &outcomes);
            let open = warnings.iter().filter(|w| w.dismissed.is_none()).count();
            Ok(json!({ "reviewType": review_type(state), "warnings": warnings, "open": open, "retractionChecks": state.std_b.retraction_checks }))
        })
    }

    pub fn conduct_dismiss(&self, review: &str, check: &str, reason: &str, dismissed: bool, actor: &str) -> Result<()> {
        if !CHECKS.iter().any(|(c, _)| *c == check) {
            return Err("Unknown check".into());
        }
        if dismissed && reason.trim().is_empty() {
            return Err("Say why this does not apply: the reason is kept with the review".into());
        }
        self.write(review, |_, _, b| Ok((vec![b.event("conduct.dismiss", actor, None, json!({ "check": check, "reason": reason.trim(), "dismissed": dismissed }))], ())))
    }

    /// Included studies to check for retractions: (record, DOI), and how many have no DOI.
    pub fn retraction_targets(&self, review: &str) -> Result<(Vec<(String, String)>, usize)> {
        self.read(review, |state, conn| {
            let ids: Vec<String> = state.included().iter().map(|r| r.id.clone()).collect();
            let metas = crate::store::metas(conn, review, &ids)?;
            let mut out = Vec::new();
            let mut missing = 0;
            for id in ids {
                match metas.get(&id).and_then(|m| key_store::normalize::doi(&m.doi)) {
                    Some(doi) => out.push((id, doi)),
                    None => missing += 1,
                }
            }
            Ok((out, missing))
        })
    }

    /// Records a retraction check of the included studies (the host looked them up).
    pub fn record_retraction_check(&self, review: &str, checked: usize, without_doi: usize, flagged: Vec<Json>, service: &str, actor: &str) -> Result<()> {
        self.write(review, |_, _, b| Ok((vec![b.event("conduct.retractions", actor, None, json!({ "checked": checked, "withoutDoi": without_doi, "flagged": flagged, "service": service }))], ())))
    }
}

// ── What std-A's checklist reads ──────────────────────────────────────────────────────

/// Facts for the PRISMA checklist and methods text (std-A's `reporting_hooks::facts`): AI use,
/// citation searching, contacts with authors, the extraction pilot, open conduct warnings.
pub fn reporting_facts(state: &State) -> Json {
    let ai = crate::ai_audit::facts(state);
    let rounds = &state.std_b.rounds;
    let citation = if rounds.is_empty() {
        Json::Null
    } else {
        let seeds: BTreeSet<&String> = rounds.iter().flat_map(|r| r.seeds.iter()).collect();
        let new: usize = rounds.iter().map(|r| r.new).sum();
        let directions: BTreeSet<&str> = rounds.iter().map(|r| r.direction.as_str()).collect();
        let dir = if directions.contains("both") || (directions.contains("backward") && directions.contains("forward")) { "backward (reference lists) and forward (citing works)" } else if directions.contains("forward") { "forward (citing works)" } else { "backward (reference lists)" };
        let tool = rounds.last().map(|r| r.tool.clone()).unwrap_or_default();
        let fallback: BTreeSet<&String> = rounds.iter().flat_map(|r| r.fallback_seeds.iter()).collect();
        let fb = if fallback.is_empty() { String::new() } else { format!(" For {} not indexed there, the reference lists in their full texts were used.", if fallback.len() == 1 { "one study".to_string() } else { format!("{} studies", fallback.len()) }) };
        let stop = if rounds.last().is_some_and(|r| r.new == 0) { " Searching stopped when a round found no new records." } else { "" };
        json!({
            "statement": format!(
                "We searched citations {dir} of {} included {} in {tool} in {} {} ({}), which identified {new} additional {}.{fb}{stop}",
                seeds.len(), if seeds.len() == 1 { "study" } else { "studies" }, rounds.len(), if rounds.len() == 1 { "round" } else { "rounds" },
                rounds.iter().map(|r| iso_date(r.at)).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>().join(", "), if new == 1 { "record" } else { "records" }
            ),
            "batches": rounds.iter().map(|r| json!({ "batchId": r.batch_id, "direction": r.direction, "tool": r.tool, "seeds": r.seeds.len(), "at": r.at, "found": r.found, "new": r.new, "inReview": r.in_review, "round": r.round })).collect::<Vec<_>>(),
        })
    };
    let contacts = crate::xpilot::contact_facts(state);
    let pilot = crate::xpilot::pilot_facts(state);
    let outcomes: Vec<String> = crate::export::outcomes(&crate::export::outcome_rows(state, &Default::default())).into_iter().map(|o| o.outcome).collect();
    let warnings: Vec<Json> = checks(state, crate::events::now_ms(), &outcomes).into_iter().filter(|w| w.dismissed.is_none()).map(|w| json!({ "standard": w.standard, "message": w.message, "fix": w.fix })).collect();
    json!({ "ai": ai, "citation": citation, "contacts": contacts, "extractionPilot": pilot, "warnings": warnings })
}

/// Audit-trail wording for std-B's events.
pub fn describe(e: &Event) -> String {
    let p = &e.payload;
    match e.kind.as_str() {
        "chase.round" => format!("Citation searching round {}: {} new records", p.pointer("/round/round").and_then(Json::as_u64).unwrap_or(0), p.pointer("/round/new").and_then(Json::as_u64).unwrap_or(0)),
        "conduct.dismiss" => if p.get("dismissed").and_then(Json::as_bool).unwrap_or(true) { format!("Dismissed a conduct check: {}", p.get("reason").and_then(Json::as_str).unwrap_or("")) } else { "Restored a conduct check".into() },
        "conduct.retractions" => format!("Checked {} included studies for retractions", p.get("checked").and_then(Json::as_u64).unwrap_or(0)),
        "ai.prompt" => format!("Stored AI prompt {} version {}", p.get("id").and_then(Json::as_str).unwrap_or(""), p.get("version").and_then(Json::as_str).unwrap_or("")),
        "ai.audit" => format!("AI audit sample of {} records {}", p.get("records").and_then(Json::as_array).map(|a| a.len()).unwrap_or(0), if p.get("open").and_then(Json::as_bool).unwrap_or(false) { "drawn" } else { "closed" }),
        "xpilot.set" => format!("Extraction pilot \"{}\" {}", p.get("name").and_then(Json::as_str).unwrap_or(""), if p.get("open").and_then(Json::as_bool).unwrap_or(false) { "open" } else { "closed" }),
        "form.piloted" => format!("Forms piloted with {} studies", p.get("n").and_then(Json::as_u64).unwrap_or(0)),
        "contact.log" => if p.get("deleted").and_then(Json::as_bool).unwrap_or(false) { "Removed a contact with authors".into() } else { format!("Contact with authors: {}", p.get("person").and_then(Json::as_str).unwrap_or("")) },
        other => other.into(),
    }
}

/// std-B's exports (`Reviews::export`): AI-use statement, contacts log, pilot report, conduct.
pub fn export(state: &State, kind: &str, base: &str) -> Result<(String, String, &'static str)> {
    Ok(match kind {
        "ai-statement" => (format!("{base}-ai-use.md"), crate::ai_audit::statement_markdown(state), "text/markdown"),
        "ai-log" => (format!("{base}-ai-log.csv"), crate::ai_audit::log_csv(state), "text/csv"),
        "contacts" => (format!("{base}-contacts-with-authors.csv"), crate::xpilot::contacts_csv(state), "text/csv"),
        "extraction-pilot" => (format!("{base}-extraction-pilot.md"), crate::xpilot::pilot_markdown(state), "text/markdown"),
        "conduct" => {
            let outcomes: Vec<String> = crate::export::outcomes(&crate::export::outcome_rows(state, &Default::default())).into_iter().map(|o| o.outcome).collect();
            let mut text = String::from("Check,Standard,Warning,What to do,Dismissed because\n");
            for w in checks(state, crate::events::now_ms(), &outcomes) {
                let cells = [w.title, w.standard, w.message, w.fix, w.dismissed.map(|d| d.reason).unwrap_or_default()];
                text.push_str(&cells.iter().map(|c| crate::export::csv_cell(c)).collect::<Vec<_>>().join(","));
                text.push('\n');
            }
            (format!("{base}-conduct-checks.csv"), text, "text/csv")
        }
        other => return Err(format!("Unknown export {other}")),
    })
}
