// Risk of bias and certainty of evidence as review operations, read models, exports and the
// host's `review_rob_*` / `review_grade_*` commands (the host hands them all here).
use crate::derive::State;
use crate::export::{csv_cell, outcome_rows, outcomes, study_data, study_label};
use crate::grade::{self, Rating};
use crate::meta::{self, Analysis, Measure, Method, Options, StudyData};
use crate::rob::{self, Evidence, Key, Progress, StudyPlan, Tool};
use crate::store::{Result, Reviews, metas};
use rusqlite::Connection;
use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};

fn member_check(state: &State, actor: &str) -> Result<()> {
    if state.member(actor).is_none() {
        return Err("Choose who is assessing: this person is not on the review's team".into());
    }
    Ok(())
}

fn level_json(tool: &Tool, id: &str) -> Json {
    tool.level(id).map(|l| json!({ "id": l.id, "label": l.label, "tone": l.tone, "symbol": l.symbol, "common": l.common })).unwrap_or(Json::Null)
}

/// Every included study's outcome rows, with labels.
fn rows_of(state: &State, conn: &Connection) -> Result<(Vec<crate::export::OutcomeRow>, HashMap<String, crate::model::RecordMeta>)> {
    let ids: Vec<String> = state.included().iter().map(|r| r.id.clone()).collect();
    let metas = metas(conn, &state.info.id, &ids)?;
    Ok((outcome_rows(state, &metas), metas))
}

/// The results ("outcome|time point") a study has data for.
fn study_results(rows: &[crate::export::OutcomeRow], study: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in rows.iter().filter(|r| r.record == study) {
        let text = |k: &str| r.values.get(k).and_then(Json::as_str).unwrap_or("").trim().to_string();
        let o = text("outcome");
        if o.is_empty() {
            continue;
        }
        let key = rob::result_key(&o, &text("timepoint"));
        if !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

/// The assessments a study needs: one per result for result-level tools, else one.
fn planned(state: &State, rows: &[crate::export::OutcomeRow], study: &str) -> (Tool, Vec<String>) {
    let t = rob::tool(state, &rob::study_tool(state, study)).unwrap_or_else(|| rob::builtin_tools().remove(0));
    if t.level != "result" {
        return (t, vec![String::new()]);
    }
    let available = study_results(rows, study);
    let chosen = match state.rob.plans.get(study).and_then(|p| p.results.clone()) {
        Some(list) if !list.is_empty() => list,
        _ => available,
    };
    (t, if chosen.is_empty() { vec![String::new()] } else { chosen })
}

pub struct Run {
    pub analysis: Analysis,
    pub input: Vec<StudyData>,
}

fn run(state: &State, rows: &[crate::export::OutcomeRow], outcome: &str, timepoint: &str, options: &Options, keep: impl Fn(&StudyData) -> bool, subgroup: impl Fn(&StudyData) -> Option<String>) -> Result<Run> {
    let _ = state;
    let mut data: Vec<StudyData> = study_data(rows, outcome, (!timepoint.is_empty()).then_some(timepoint)).into_iter().filter(|d| keep(d)).collect();
    for d in &mut data {
        d.subgroup = subgroup(d);
    }
    if data.is_empty() {
        return Err("No study is left with data for this outcome".into());
    }
    Ok(Run { analysis: meta::analyse(&data, options)?, input: data })
}

fn options_of(choice: &grade::AnalysisChoice, kind: &str) -> Options {
    let measure = Measure::parse(&choice.measure).unwrap_or(match kind {
        "continuous" => Measure::MD,
        "generic" => Measure::GEN,
        _ => Measure::RR,
    });
    let method = match choice.method.as_str() {
        "fe" => Method::Fe,
        "dl" => Method::Dl,
        _ => Method::Reml,
    };
    Options { measure, method, hartung_knapp: choice.hartung_knapp, level: 0.95 }
}

fn split_key(key: &str) -> (String, String) {
    match key.split_once('|') {
        Some((o, t)) => (o.to_string(), t.to_string()),
        None => (key.to_string(), String::new()),
    }
}

impl Reviews {
    // ── Risk of bias: tools and set-up ───────────────────────────────────────────────

    pub fn rob_tools(&self, review: &str) -> Result<Json> {
        self.read(review, |state, _| {
            let used: BTreeSet<String> = state.rob.assessments.keys().map(|k| k.tool.clone()).collect();
            Ok(json!({ "tools": rob::tools(state).into_iter().map(|t| { let mut v = serde_json::to_value(&t).unwrap_or(Json::Null); v["inUse"] = json!(used.contains(&t.id)); v }).collect::<Vec<_>>(), "shipped": rob::builtin_tools(), "blank": rob::blank_tool() }))
        })
    }

    pub fn rob_tool_save(&self, review: &str, mut tool: Tool, actor: &str) -> Result<()> {
        tool.builtin = false;
        tool.validate()?;
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            // A tool in use keeps its domains' ids (judgements made under it stay readable); its
            // version goes up so each judgement says which version it was made under.
            if let Some(old) = rob::tool(state, &tool.id) {
                let used = state.rob.assessments.keys().any(|k| k.tool == tool.id);
                if used {
                    for d in &old.domains {
                        if tool.domain(&d.id).is_none() {
                            return Err(format!("“{}” has judgements under this tool: rename it instead of removing it", d.name));
                        }
                    }
                }
                if old != tool {
                    let n: u32 = old.version.parse().unwrap_or(1);
                    if tool.version == old.version {
                        tool.version = (n + 1).to_string();
                    }
                }
            }
            Ok((vec![b.event("rob.tool", actor, None, json!({ "tool": tool }))], ()))
        })
    }

    pub fn rob_tool_delete(&self, review: &str, id: &str, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            if state.rob.assessments.keys().any(|k| k.tool == id) {
                return Err("Studies are assessed with this tool: it cannot be removed".into());
            }
            Ok((vec![b.event("rob.tool", actor, None, json!({ "id": id, "deleted": true }))], ()))
        })
    }

    pub fn rob_setup(&self, review: &str, setup: rob::Setup, actor: &str) -> Result<()> {
        if setup.assessors.is_some_and(|n| !(1..=5).contains(&n)) {
            return Err("Between one and five assessors".into());
        }
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            if !setup.tool.is_empty() && rob::tool(state, &setup.tool).is_none() {
                return Err("That tool is not in this review".into());
            }
            Ok((vec![b.event("rob.setup", actor, None, serde_json::to_value(&setup).unwrap_or(Json::Null))], ()))
        })
    }

    pub fn rob_study_plan(&self, review: &str, study: &str, plan: StudyPlan, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            state.record(study).ok_or("This study is not in the review")?;
            if rob::tool(state, &plan.tool).is_none() {
                return Err("That tool is not in this review".into());
            }
            Ok((vec![b.event("rob.study", actor, Some(study), serde_json::to_value(&plan).unwrap_or(Json::Null))], ()))
        })
    }

    // ── Risk of bias: overview and one assessment ────────────────────────────────────

    pub fn rob_overview(&self, review: &str, viewer: &str) -> Result<Json> {
        self.read(review, |state, conn| {
            let (rows, metas) = rows_of(state, conn)?;
            let mut studies = Vec::new();
            let mut conflicts = Vec::new();
            let (mut total, mut done, mut mine_left) = (0, 0, 0);
            for r in state.included() {
                let (t, results) = planned(state, &rows, &r.id);
                let label = study_label(state, metas.get(&r.id), &r.id);
                let mut items = Vec::new();
                for result in &results {
                    total += 1;
                    let key = Key { study: r.id.clone(), result: result.clone(), tool: t.id.clone() };
                    let a = state.rob.assessments.get(&key);
                    let (values, conflict, progress) = a.map(|a| rob::agreed(state, a)).unwrap_or((BTreeMap::new(), Vec::new(), Progress::NotStarted));
                    let mine = a.and_then(|a| a.by.get(viewer));
                    let mine_state = match mine {
                        Some(w) if w.complete => "complete",
                        Some(w) if !w.answers.is_empty() || !w.judgements.is_empty() => "inProgress",
                        _ => "notStarted",
                    };
                    if progress == Progress::Done {
                        done += 1;
                    } else if mine_state != "complete" && a.is_none_or(|a| a.by.values().filter(|w| w.complete).count() < rob::assessors_needed(state)) {
                        mine_left += 1;
                    }
                    let names: Vec<String> = conflict.iter().map(|d| t.domain(d).map(|x| x.name.clone()).unwrap_or_else(|| "Overall".into())).collect();
                    if !names.is_empty() {
                        conflicts.push(json!({ "study": r.id, "label": label, "result": result, "resultLabel": rob::result_label(result), "domains": names }));
                    }
                    items.push(json!({
                        "key": result, "label": rob::result_label(result), "progress": progress, "mine": mine_state,
                        "overall": values.get("overall").map(|v| level_json(&t, v)).unwrap_or(Json::Null),
                        "conflicts": names,
                        "assessors": a.map(|a| a.by.values().filter(|w| w.complete).count()).unwrap_or(0),
                    }));
                }
                let meta = metas.get(&r.id);
                studies.push(json!({ "id": r.id, "label": label, "title": meta.map(|m| m.title.clone()).unwrap_or_default(), "tool": t.id, "toolShort": t.short, "level": t.level, "available": study_results(&rows, &r.id), "results": items, "hasFullText": r.has_full_text() }));
            }
            let can_resolve = state.member(viewer).is_some_and(|m| m.can_resolve(&state.protocol.rules));
            Ok(json!({
                "setup": { "assessors": rob::assessors_needed(state), "blind": rob::blind(state), "tool": rob::default_tool(state), "explicit": state.rob.setup },
                "tools": rob::tools(state).iter().map(|t| json!({ "id": t.id, "name": t.name, "short": t.short, "level": t.level, "design": t.design, "builtin": t.builtin })).collect::<Vec<_>>(),
                "studies": studies, "conflicts": conflicts, "migratable": rob::migratable(state), "canResolve": can_resolve,
                "totals": { "assessments": total, "done": done, "conflicts": conflicts.len(), "mineLeft": mine_left },
            }))
        })
    }

    pub fn rob_assessment(&self, review: &str, study: &str, result: &str, viewer: &str) -> Result<Json> {
        self.read(review, |state, conn| {
            let r = state.record(study).ok_or("This study is not in the review")?;
            let t = rob::tool(state, &rob::study_tool(state, study)).ok_or("The study's tool is missing")?;
            let result = if t.level == "result" { result.to_string() } else { String::new() };
            let key = Key { study: study.into(), result: result.clone(), tool: t.id.clone() };
            let empty = rob::Assessment::default();
            let a = state.rob.assessments.get(&key).unwrap_or(&empty);
            let need = rob::assessors_needed(state);
            let (agreed, conflicts, progress) = rob::agreed(state, a);
            let complete = a.by.values().filter(|w| w.complete).count();
            let all_done = complete >= need;
            let see = !rob::blind(state) || all_done;
            let blank = rob::Work::default();
            let mine = a.by.get(viewer).unwrap_or(&blank);
            let mut suggestions = serde_json::Map::new();
            for d in &t.domains {
                suggestions.insert(d.id.clone(), serde_json::to_value(t.suggest_domain(d, &mine.domain_answers(&d.id))).unwrap_or(Json::Null));
            }
            suggestions.insert("overall".into(), serde_json::to_value(t.suggest_overall(&mine.values())).unwrap_or(Json::Null));
            let others: Vec<Json> = a
                .by
                .iter()
                .filter(|(who, _)| who.as_str() != viewer && who.as_str() != "ai")
                .map(|(who, w)| {
                    let mut o = json!({ "id": who, "name": state.member_name(who), "complete": w.complete });
                    if see {
                        o["judgements"] = serde_json::to_value(&w.judgements).unwrap_or(Json::Null);
                        o["answers"] = serde_json::to_value(&w.answers).unwrap_or(Json::Null);
                        o["evidence"] = serde_json::to_value(&w.evidence).unwrap_or(Json::Null);
                    }
                    o
                })
                .collect();
            let meta = metas(conn, review, &[study.to_string()])?.remove(study);
            Ok(json!({
                "study": study, "result": result, "resultLabel": rob::result_label(&result), "studyLabel": study_label(state, meta.as_ref(), study),
                "title": meta.as_ref().map(|m| m.title.clone()).unwrap_or_default(), "hasFullText": r.has_full_text(),
                "tool": t, "need": need, "blind": rob::blind(state), "canSeeOthers": see,
                "canResolve": state.member(viewer).is_some_and(|m| m.can_resolve(&state.protocol.rules)) || state.protocol.rules.conflicts == "consensus",
                "mine": mine, "suggestions": suggestions, "others": others, "completeCount": complete,
                "progress": progress, "agreed": if see { serde_json::to_value(&agreed).unwrap_or(Json::Null) } else { Json::Null },
                "conflicts": if see { json!(conflicts) } else { json!([]) }, "finals": a.finals,
            }))
        })
    }

    // ── Risk of bias: writes ─────────────────────────────────────────────────────────

    fn rob_key(state: &State, study: &str, result: &str) -> Result<(Tool, String)> {
        state.record(study).ok_or("This study is not in the review")?;
        let t = rob::tool(state, &rob::study_tool(state, study)).ok_or("The study's tool is missing")?;
        let result = if t.level == "result" { result.to_string() } else { String::new() };
        Ok((t, result))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn rob_answer(&self, review: &str, study: &str, result: &str, domain: &str, question: Option<&str>, value: &str, reason: &str, support: &str, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            let (t, result) = Self::rob_key(state, study, result)?;
            match question.filter(|q| !q.is_empty()) {
                Some(q) => {
                    let d = t.domain(domain).ok_or("That domain is not in the tool")?;
                    let qd = d.questions.iter().find(|x| x.id == q).ok_or("That question is not in the domain")?;
                    if !value.is_empty() && !t.options(qd).iter().any(|o| o.id == value) {
                        return Err("That answer is not one of the question's options".into());
                    }
                }
                None => {
                    if domain != "overall" && t.domain(domain).is_none() {
                        return Err("That domain is not in the tool".into());
                    }
                    if !value.is_empty() && t.level(value).is_none() {
                        return Err("That judgement is not one of the tool's levels".into());
                    }
                }
            }
            let payload = json!({ "result": result, "tool": t.id, "toolVersion": t.version, "domain": domain, "question": question.unwrap_or(""), "value": value, "reason": reason.trim(), "support": support.trim() });
            Ok((vec![b.event("rob.answer", actor, Some(study), payload)], ()))
        })
    }

    pub fn rob_evidence(&self, review: &str, study: &str, result: &str, mut evidence: Evidence, removed: bool, actor: &str) -> Result<String> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            let (t, result) = Self::rob_key(state, study, result)?;
            if evidence.domain != "overall" && t.domain(&evidence.domain).is_none() {
                return Err("That domain is not in the tool".into());
            }
            if evidence.id.is_empty() {
                evidence.id = crate::events::short_id("ev");
            }
            if !removed && evidence.text.trim().is_empty() {
                return Err("Select a passage in the full text first".into());
            }
            let mut payload = serde_json::to_value(&evidence).unwrap_or(json!({}));
            payload["result"] = json!(result);
            payload["tool"] = json!(t.id);
            payload["removed"] = json!(removed);
            let id = evidence.id.clone();
            Ok((vec![b.event("rob.evidence", actor, Some(study), payload)], id))
        })
    }

    /// Marks one assessor's assessment complete (checked: every domain and the overall
    /// judgement given, and a reason wherever a judgement differs from Key's suggestion) or
    /// reopens it.
    pub fn rob_complete(&self, review: &str, study: &str, result: &str, complete: bool, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            let (t, result) = Self::rob_key(state, study, result)?;
            if complete {
                let key = Key { study: study.into(), result: result.clone(), tool: t.id.clone() };
                let blank = rob::Work::default();
                let w = state.rob.assessments.get(&key).and_then(|a| a.by.get(actor)).unwrap_or(&blank);
                let mut missing = Vec::new();
                for d in &t.domains {
                    match w.judgements.get(&d.id) {
                        None => missing.push(d.name.clone()),
                        Some(j) => {
                            if let Some(s) = t.suggest_domain(d, &w.domain_answers(&d.id)) {
                                if s.level != j.value && j.reason.trim().is_empty() {
                                    return Err(format!("{}: say why your judgement differs from the suggestion", d.name));
                                }
                            }
                        }
                    }
                }
                match w.judgements.get("overall") {
                    None => missing.push("Overall".into()),
                    Some(j) => {
                        if let Some(s) = t.suggest_overall(&w.values()) {
                            if s.level != j.value && j.reason.trim().is_empty() {
                                return Err("Overall: say why your judgement differs from the suggestion".into());
                            }
                        }
                    }
                }
                if !missing.is_empty() {
                    return Err(format!("Still to judge: {}", missing.join(", ")));
                }
            }
            Ok((vec![b.event("rob.complete", actor, Some(study), json!({ "result": result, "tool": t.id, "complete": complete }))], ()))
        })
    }

    /// The agreed judgement of a domain (or overall) after the assessors differ.
    pub fn rob_final(&self, review: &str, study: &str, result: &str, domain: &str, value: &str, note: &str, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            let m = state.member(actor).unwrap();
            if !m.can_resolve(&state.protocol.rules) {
                return Err("Only a tie-breaker or an owner settles disagreements in this review".into());
            }
            let (t, result) = Self::rob_key(state, study, result)?;
            if domain != "overall" && t.domain(domain).is_none() {
                return Err("That domain is not in the tool".into());
            }
            if !value.is_empty() && t.level(value).is_none() {
                return Err("That judgement is not one of the tool's levels".into());
            }
            let key = Key { study: study.into(), result: result.clone(), tool: t.id.clone() };
            let complete = state.rob.assessments.get(&key).map(|a| a.by.values().filter(|w| w.complete).count()).unwrap_or(0);
            if complete < rob::assessors_needed(state) {
                return Err("Agree a judgement once every assessor has finished".into());
            }
            Ok((vec![b.event("rob.final", actor, Some(study), json!({ "result": result, "tool": t.id, "toolVersion": t.version, "domain": domain, "value": value, "note": note.trim() }))], ()))
        })
    }

    /// Brings risk-of-bias answers from extraction forms into assessments.
    pub fn rob_migrate(&self, review: &str, actor: &str) -> Result<usize> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            let events = rob::migration(state, b);
            let studies = events.iter().filter_map(|e| e.record_id.clone()).collect::<BTreeSet<_>>().len();
            Ok((events, studies))
        })
    }

    // ── Risk of bias: plots and analyses ─────────────────────────────────────────────

    /// The traffic-light rows (studies × domains, agreed judgements) for one tool, for one result
    /// or every one, and the summary per domain: the share of studies at each level, unweighted
    /// and, when an outcome is analysed, weighted by the studies' weights in that analysis.
    pub fn rob_plots(&self, review: &str, tool_id: &str, result: Option<&str>, options: Option<Options>) -> Result<Json> {
        self.read(review, |state, conn| {
            let (rows, metas) = rows_of(state, conn)?;
            let t = rob::tool(state, tool_id).ok_or("That tool is not in this review")?;
            let mut lines = Vec::new();
            for r in state.included() {
                if rob::study_tool(state, &r.id) != t.id {
                    continue;
                }
                let label = study_label(state, metas.get(&r.id), &r.id);
                for (key, a) in state.rob.assessments.range(Key { study: r.id.clone(), result: String::new(), tool: String::new() }..).take_while(|(k, _)| k.study == r.id) {
                    if key.tool != t.id {
                        continue;
                    }
                    if let Some(res) = result {
                        // A study-level assessment stands in for a result that has none of its own.
                        let own = state.rob.assessments.contains_key(&Key { study: r.id.clone(), result: res.to_string(), tool: t.id.clone() });
                        if key.result != res && !(key.result.is_empty() && !own) {
                            continue;
                        }
                    }
                    let (values, _, progress) = rob::agreed(state, a);
                    if values.is_empty() {
                        continue;
                    }
                    let cells: serde_json::Map<String, Json> = values.iter().map(|(d, v)| (d.clone(), level_json(&t, v))).collect();
                    lines.push(json!({ "study": r.id, "label": if result.is_some() || key.result.is_empty() { label.clone() } else { format!("{label} · {}", rob::result_label(&key.result)) }, "result": key.result, "cells": cells, "done": progress == Progress::Done }));
                }
            }
            // Weights from the analysis of the chosen result.
            let mut weights: BTreeMap<String, f64> = BTreeMap::new();
            if let (Some(res), Some(opts)) = (result, options.as_ref()) {
                let (o, tp) = split_key(res);
                if let Ok(run) = run(state, &rows, &o, &tp, opts, |_| true, |_| None) {
                    weights = run.analysis.studies.iter().map(|s| (s.id.clone(), s.weight)).collect();
                }
            }
            let mut summary = Vec::new();
            let columns: Vec<(String, String, String)> = t.domains.iter().map(|d| (d.id.clone(), d.short.clone(), d.name.clone())).chain(std::iter::once(("overall".to_string(), "Overall".to_string(), "Overall".to_string()))).collect();
            for (id, short, name) in &columns {
                let mut count: BTreeMap<String, f64> = BTreeMap::new();
                let mut weight: BTreeMap<String, f64> = BTreeMap::new();
                let (mut n, mut wsum) = (0.0, 0.0);
                for l in &lines {
                    let Some(v) = l["cells"].get(id).and_then(|c| c.get("id")).and_then(Json::as_str) else { continue };
                    *count.entry(v.to_string()).or_default() += 1.0;
                    n += 1.0;
                    if let Some(w) = l["study"].as_str().and_then(|s| weights.get(s)) {
                        *weight.entry(v.to_string()).or_default() += w;
                        wsum += w;
                    }
                }
                let share = |m: &BTreeMap<String, f64>, total: f64| -> Vec<Json> { t.levels.iter().map(|l| json!({ "level": l.id, "share": if total > 0.0 { 100.0 * m.get(&l.id).copied().unwrap_or(0.0) / total } else { 0.0 } })).collect() };
                summary.push(json!({ "domain": id, "short": short, "name": name, "n": n, "unweighted": share(&count, n), "weighted": if wsum > 0.0 { json!(share(&weight, wsum)) } else { Json::Null } }));
            }
            Ok(json!({
                "tool": { "id": t.id, "name": t.name, "short": t.short, "levels": t.levels, "url": t.url },
                "domains": t.domains.iter().map(|d| json!({ "id": d.id, "short": d.short, "name": d.name, "applicability": d.applicability })).collect::<Vec<_>>(),
                "rows": lines, "summary": summary, "weighted": !weights.is_empty(),
            }))
        })
    }

    /// An analysis with risk of bias: every study's judgements for the forest plot's columns,
    /// the studies without an assessment, and, with `mode`, the analysis without the studies at
    /// high risk ("excludeHigh") or with the studies grouped by their overall risk ("subgroup").
    pub fn rob_analyse(&self, review: &str, outcome: &str, timepoint: &str, options: &Options, subgroups: bool, mode: &str) -> Result<Json> {
        self.read(review, |state, conn| {
            let (rows, _) = rows_of(state, conn)?;
            let result = rob::result_key(outcome, timepoint);
            let cov = rob::covariates(state, outcome, Some(timepoint));
            let all = run(state, &rows, outcome, timepoint, options, |_| true, |d| if subgroups { d.subgroup.clone() } else { None })?;
            let group_label = |c: Option<&rob::Covariate>| match c.map(|c| c.rank) {
                Some(0) => "Low risk of bias",
                Some(1) => "Some concerns",
                Some(_) => "High risk of bias",
                None => "Not assessed",
            };
            let (analysis, input, excluded) = match mode {
                "excludeHigh" => {
                    let excluded: Vec<String> = all.input.iter().filter(|d| cov.get(&d.id).is_some_and(|c| c.rank >= 2)).map(|d| d.label.clone()).collect();
                    if excluded.is_empty() {
                        (all.analysis.clone(), all.input.clone(), excluded)
                    } else {
                        let r = run(state, &rows, outcome, timepoint, options, |d| !cov.get(&d.id).is_some_and(|c| c.rank >= 2), |d| if subgroups { d.subgroup.clone() } else { None })?;
                        (r.analysis, r.input, excluded)
                    }
                }
                "subgroup" => {
                    let r = run(state, &rows, outcome, timepoint, options, |_| true, |d| Some(group_label(cov.get(&d.id)).to_string()))?;
                    (r.analysis, r.input, Vec::new())
                }
                _ => (all.analysis.clone(), all.input.clone(), Vec::new()),
            };
            // Columns: the domains of the tool most studies use; others show their overall only.
            let mut tools: BTreeMap<String, usize> = BTreeMap::new();
            for c in cov.values() {
                *tools.entry(c.tool.clone()).or_default() += 1;
            }
            let main_tool = tools.into_iter().max_by_key(|x| x.1).and_then(|(id, _)| rob::tool(state, &id));
            let mut studies = serde_json::Map::new();
            for d in &all.input {
                let Some((t, level, values)) = rob::overall_for(state, &d.id, &result) else { continue };
                let cells: serde_json::Map<String, Json> = values.iter().filter(|(k, _)| main_tool.as_ref().is_some_and(|m| m.id == t.id) || k.as_str() == "overall").map(|(k, v)| (k.clone(), level_json(&t, v))).collect();
                studies.insert(d.id.clone(), json!({ "tool": t.id, "overall": level_json(&t, &level.id), "cells": cells }));
            }
            let missing: Vec<String> = all.input.iter().filter(|d| !studies.contains_key(&d.id)).map(|d| d.label.clone()).collect();
            let columns: Vec<Json> = main_tool.map(|t| t.domains.iter().filter(|d| !d.applicability).map(|d| json!({ "id": d.id, "short": d.short, "name": d.name })).collect()).unwrap_or_default();
            Ok(json!({
                "analysis": analysis, "input": input, "includedStudies": state.included().len(),
                "rob": { "mode": mode, "columns": columns, "studies": studies, "missing": missing, "excluded": excluded, "all": all.analysis.main },
            }))
        })
    }

    // ── Certainty (GRADE) ────────────────────────────────────────────────────────────

    pub fn grade_overview(&self, review: &str) -> Result<Json> {
        self.read(review, |state, conn| {
            let (rows, _) = rows_of(state, conn)?;
            let choices = outcomes(&rows);
            let mut list = Vec::new();
            let mut keys: Vec<String> = state.grade.order.clone();
            for c in &choices {
                let k = rob::result_key(&c.outcome, &c.timepoint);
                if !keys.contains(&k) {
                    keys.push(k);
                }
            }
            for k in keys {
                let (o, tp) = split_key(&k);
                let choice = choices.iter().find(|c| rob::result_key(&c.outcome, &c.timepoint) == k);
                let rating = state.grade.outcomes.get(&k);
                if choice.is_none() && rating.is_none() {
                    continue;
                }
                let (level, explanation) = rating.map(grade::certainty).unzip();
                list.push(json!({
                    "key": k, "outcome": o, "timepoint": tp, "label": rating.map(|r| r.label.clone()).filter(|l| !l.is_empty()).unwrap_or_else(|| rob::result_label(&k)),
                    "kind": choice.map(|c| c.kind.clone()).unwrap_or_default(), "studies": choice.map(|c| c.studies).unwrap_or(0),
                    "rated": rating.is_some(), "level": level, "explanation": explanation, "importance": rating.and_then(|r| r.importance), "missingData": choice.is_none(),
                }));
            }
            Ok(json!({ "outcomes": list }))
        })
    }

    fn grade_compute(state: &State, conn: &Connection, key: &str, rating: Option<&Rating>) -> Result<Json> {
        let (rows, _) = rows_of(state, conn)?;
        let (o, tp) = split_key(key);
        let choice = outcomes(&rows).into_iter().find(|c| rob::result_key(&c.outcome, &c.timepoint) == key);
        let kind = choice.as_ref().map(|c| c.kind.clone()).unwrap_or_default();
        let cov = rob::covariates(state, &o, Some(&tp));
        let mut r = rating.cloned().unwrap_or_else(|| {
            // Non-randomised when most assessed studies use a tool for non-randomised studies.
            let randomised = cov.values().filter(|c| matches!(c.tool.as_str(), "robins-i" | "robins-e" | "nos")).count() * 2 <= cov.len() || cov.is_empty();
            Rating { outcome: o.clone(), timepoint: tp.clone(), design: if randomised { "randomised".into() } else { "nonRandomised".into() }, ..Default::default() }
        });
        let opts = options_of(&r.analysis, &kind);
        r.analysis = grade::AnalysisChoice { measure: format!("{:?}", opts.measure), method: match opts.method { Method::Fe => "fe", Method::Dl => "dl", Method::Reml => "reml" }.into(), hartung_knapp: opts.hartung_knapp };
        let all = run(state, &rows, &o, &tp, &opts, |_| true, |_| None);
        let Ok(all) = all else {
            return Ok(json!({ "key": key, "rating": r, "stored": rating.is_some(), "kind": kind, "error": "No included study has data for this outcome yet", "certainty": grade::certainty(&r) }));
        };
        let high: BTreeSet<&String> = cov.iter().filter(|(_, c)| c.rank >= 2).map(|(id, _)| id).collect();
        let without = if !high.is_empty() && all.input.iter().any(|d| !high.contains(&d.id)) { run(state, &rows, &o, &tp, &opts, |d| !high.contains(&d.id), |_| None).ok() } else { None };
        let ctx = grade::Context { analysis: &all.analysis, input: &all.input, rob: &cov, rating: &r, without_high: without.as_ref().map(|w| &w.analysis) };
        let suggestions = grade::suggest(&ctx);
        let a = &all.analysis;
        let m = &a.main;
        // std-D: proportions and Fisher's z back-transform too.
        let nat = |v: f64| crate::meta::back_transform(v, &a.transform, a.harmonic_n);
        let used: Vec<String> = a.studies.iter().map(|s| s.id.clone()).collect();
        let control = r.assumed_risk.or_else(|| grade::control_risk(&all.input));
        let abs = control.and_then(|acr| grade::absolute(a.measure, acr, nat(m.estimate), nat(m.lower), nat(m.upper)));
        let (level, explanation) = grade::certainty(&r);
        let (direction, small) = grade::effect_size(a, r.mid, abs.as_ref());
        let parts = &state.protocol.question.parts;
        let intervention = parts.get("i").or_else(|| parts.get("e")).map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s.len() < 60).unwrap_or_else(|| "the intervention".into());
        let label = if r.label.is_empty() { rob::result_label(key) } else { r.label.clone() };
        let suggested_statement = grade::statement(&level, &intervention, if r.label.is_empty() { &o } else { &r.label }, direction, small);
        let relative = if a.ratio {
            Some(format!("{} {:.2} ({:.2} to {:.2})", match a.measure { Measure::RR => "RR", Measure::OR => "OR", Measure::HR => "HR", Measure::IRR => "IRR", Measure::ROM => "Ratio of means", _ => "Ratio" }, nat(m.estimate), nat(m.lower), nat(m.upper)))
        } else {
            None
        };
        let effect_text = match a.measure {
            Measure::RR | Measure::OR | Measure::RD => abs.as_ref().map(|x| grade::difference_text(x.difference)),
            Measure::MD => Some(grade::mean_text(m.estimate, m.lower, m.upper, "")),
            Measure::SMD => Some(grade::mean_text(m.estimate, m.lower, m.upper, " SD")),
            _ => None,
        };
        Ok(json!({
            "key": key, "label": label, "rating": r, "stored": rating.is_some(), "kind": kind,
            "analysis": { "measure": a.measure, "measureLabel": a.measure_label, "ratio": a.ratio, "k": m.k, "estimate": nat(m.estimate), "lower": nat(m.lower), "upper": nat(m.upper), "i2": m.i2, "tau2": m.tau2, "piLower": m.pi_lower.map(nat), "piUpper": m.pi_upper.map(nat), "egger": a.egger, "method": m.method, "hartungKnapp": m.hartung_knapp },
            "participants": grade::participants(&all.input, &used), "controlRisk": control, "studyControlRisk": grade::control_risk(&all.input),
            "suggestions": suggestions, "certainty": { "level": level, "label": grade::level_label(&level), "explanation": explanation },
            "absolute": abs, "relative": relative, "effectText": effect_text, "suggestedStatement": suggested_statement,
            "statement": if r.statement.trim().is_empty() { suggested_statement.clone() } else { r.statement.clone() },
            "robCoverage": { "assessed": all.input.iter().filter(|d| cov.contains_key(&d.id)).count(), "total": all.input.len() },
            "history": { "changes": r.changes, "by": state.member_name(&r.by), "at": r.at },
        }))
    }

    pub fn grade_outcome(&self, review: &str, key: &str) -> Result<Json> {
        self.read(review, |state, conn| Self::grade_compute(state, conn, key, state.grade.outcomes.get(key)))
    }

    /// What a rating not yet saved would give (its suggestions follow its assumed risk and
    /// smallest important difference).
    pub fn grade_preview(&self, review: &str, rating: Rating) -> Result<Json> {
        self.read(review, |state, conn| {
            let key = rob::result_key(&rating.outcome, &rating.timepoint);
            let mut out = Self::grade_compute(state, conn, &key, Some(&rating))?;
            // Saved or not is the stored rating's, not the draft's.
            let stored = state.grade.outcomes.get(&key);
            out["stored"] = json!(stored.is_some());
            out["history"] = json!({ "changes": stored.map(|r| r.changes).unwrap_or(0), "by": stored.map(|r| state.member_name(&r.by)).unwrap_or_default(), "at": stored.map(|r| r.at).unwrap_or(0) });
            Ok(out)
        })
    }

    /// Saves an outcome's rating; Key's current suggestion for each domain is stored with it
    /// (so a judgement that differs from it is visible, and needs its footnote).
    pub fn grade_set(&self, review: &str, mut rating: Rating, actor: &str) -> Result<()> {
        self.write(review, |state, conn, b| {
            member_check(state, actor)?;
            let key = rob::result_key(&rating.outcome, &rating.timepoint);
            let computed = Self::grade_compute(state, conn, &key, Some(&rating))?;
            for (id, _) in grade::DOWN.iter().chain(grade::UP) {
                let suggested = computed["suggestions"].get(*id).and_then(|s| s.get("judgement")).and_then(Json::as_str).map(str::to_string);
                if let Some(d) = rating.domains.get_mut(*id) {
                    d.suggested = suggested;
                }
            }
            grade::validate(&rating)?;
            Ok((vec![b.event("grade.set", actor, None, json!({ "key": key, "rating": rating }))], ()))
        })
    }

    pub fn grade_delete(&self, review: &str, key: &str, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            Ok((vec![b.event("grade.set", actor, None, json!({ "key": key, "deleted": true }))], ()))
        })
    }

    pub fn grade_order(&self, review: &str, order: Vec<String>, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            Ok((vec![b.event("grade.order", actor, None, json!({ "order": order }))], ()))
        })
    }

    /// The Summary of findings: the rated outcomes in their order.
    pub fn grade_sof(&self, review: &str) -> Result<Json> {
        self.read(review, |state, conn| sof(state, conn))
    }
}

fn sof(state: &State, conn: &Connection) -> Result<Json> {
    let mut rows = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    for key in &state.grade.order {
        let Some(r) = state.grade.outcomes.get(key) else { continue };
        let c = Reviews::grade_compute(state, conn, key, Some(r))?;
        let mut marks = Vec::new();
        for (id, name) in grade::DOWN.iter().chain(grade::UP) {
            let Some(d) = r.domains.get(*id) else { continue };
            if d.footnote.trim().is_empty() || d.judgement.is_empty() || d.judgement == "none" {
                continue;
            }
            notes.push(format!("{}: {}", name, d.footnote.trim()));
            marks.push(letter(notes.len() - 1));
        }
        let design = if r.design == "nonRandomised" { "non-randomised studies" } else { "randomised trials" };
        let k = c["analysis"]["k"].as_u64().unwrap_or(0);
        rows.push(json!({
            "key": key, "outcome": c["label"], "importance": r.importance, "importanceLabel": r.importance.map(|i| if i >= 7 { "Critical" } else if i >= 4 { "Important" } else { "Of limited importance" }),
            "studies": k, "participants": c["participants"], "design": format!("{k} {}", if k == 1 { design.trim_end_matches('s').replace("studie", "study") } else { design.to_string() }),
            "relative": c["relative"], "assumed": c["absolute"]["assumed"], "corresponding": c["absolute"]["corresponding"], "effect": c["effectText"],
            "certainty": c["certainty"]["level"], "certaintyLabel": c["certainty"]["label"], "symbols": grade::symbols(c["certainty"]["level"].as_str().unwrap_or("")),
            "footnotes": marks, "statement": c["statement"], "comment": r.comment, "measure": c["analysis"]["measureLabel"],
        }));
    }
    Ok(json!({ "rows": rows, "footnotes": notes.iter().enumerate().map(|(i, n)| json!({ "mark": letter(i), "text": n })).collect::<Vec<_>>(), "question": state.protocol.question.parts, "review": state.info.name }))
}

fn letter(i: usize) -> String {
    let mut n = i;
    let mut s = String::new();
    loop {
        s.insert(0, (b'a' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    s
}

fn esc(t: &str) -> String {
    t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn line(cells: &[String]) -> String {
    let mut l = cells.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(",");
    l.push('\n');
    l
}

fn txt(v: &Json) -> String {
    match v {
        Json::Null => String::new(),
        Json::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn risk_text(row: &Json) -> (String, String) {
    let assumed = row["assumed"].as_f64().map(|a| format!("{:.0} per 1,000", a)).unwrap_or_default();
    let corr = row["corresponding"].as_array().and_then(|c| Some(format!("{:.0} per 1,000 ({:.0} to {:.0})", c.first()?.as_f64()?, c.get(1)?.as_f64()?, c.get(2)?.as_f64()?))).unwrap_or_default();
    (assumed, corr)
}

pub const EXPORTS: &[&str] = &["rob-csv", "rob-covariates", "grade-csv", "sof-csv", "sof-md", "sof-html"];

/// Exports: kinds rob-csv, rob-covariates, sof-md, sof-html, sof-csv, grade-csv. None for other kinds.
pub fn export(state: &State, conn: &Connection, kind: &str, base: &str) -> Option<Result<(String, String, &'static str)>> {
    Some(match kind {
        "rob-covariates" => Ok((format!("{base}-rob-covariates.json"), rob::covariates_json(state).to_string(), "application/json")),
        "rob-csv" => rob_csv(state, conn).map(|c| (format!("{base}-risk-of-bias.csv"), c, "text/csv")),
        "grade-csv" => grade_csv(state, conn).map(|c| (format!("{base}-certainty.csv"), c, "text/csv")),
        "sof-csv" | "sof-md" | "sof-html" => sof(state, conn).map(|t| match kind {
            "sof-csv" => (format!("{base}-summary-of-findings.csv"), sof_csv(&t), "text/csv"),
            "sof-md" => (format!("{base}-summary-of-findings.md"), sof_md(&t), "text/markdown"),
            _ => (format!("{base}-summary-of-findings.html"), sof_html(&t), "text/html"),
        }),
        _ => return None,
    })
}

fn rob_csv(state: &State, conn: &Connection) -> Result<String> {
    let (_, metas) = rows_of(state, conn)?;
    let mut out = line(&["Study", "Record ID", "Result", "Tool", "Tool version", "Domain", "Judgement", "Agreed", "Assessor", "Assessor judgement", "Reason (differs from suggestion)", "Support", "Evidence (page: quote)"].map(String::from));
    for (key, a) in &state.rob.assessments {
        let Some(t) = rob::tool(state, &key.tool) else { continue };
        let label = study_label(state, metas.get(&key.study), &key.study);
        let (agreed, _, _) = rob::agreed(state, a);
        let domains: Vec<(String, String)> = t.domains.iter().map(|d| (d.id.clone(), d.name.clone())).chain(std::iter::once(("overall".into(), "Overall".into()))).collect();
        for (id, name) in &domains {
            let agreed_label = agreed.get(id).and_then(|v| t.level(v)).map(|l| l.label.clone()).unwrap_or_default();
            for (who, w) in &a.by {
                let j = w.judgements.get(id);
                let evidence = w.evidence.iter().filter(|e| &e.domain == id).map(|e| format!("{}: {}", if e.page >= 0 { format!("p. {}", e.page + 1) } else { "page".into() }, e.text)).collect::<Vec<_>>().join(" | ");
                out.push_str(&line(&[
                    label.clone(),
                    key.study.clone(),
                    rob::result_label(&key.result),
                    t.name.clone(),
                    j.map(|j| j.tool_version.clone()).unwrap_or_default(),
                    name.clone(),
                    agreed_label.clone(),
                    if a.finals.contains_key(id) { "Consensus".into() } else if agreed.contains_key(id) { "Agreed".into() } else { String::new() },
                    state.member_name(who),
                    j.and_then(|j| t.level(&j.value)).map(|l| l.label.clone()).unwrap_or_default(),
                    j.map(|j| j.reason.clone()).unwrap_or_default(),
                    j.map(|j| j.support.clone()).unwrap_or_default(),
                    evidence,
                ]));
            }
        }
    }
    Ok(out)
}

fn grade_csv(state: &State, conn: &Connection) -> Result<String> {
    let mut out = line(&["Outcome", "Design", "Start", "Domain", "Judgement", "Key's suggestion", "Footnote", "Certainty", "How"].map(String::from));
    for key in &state.grade.order {
        let Some(r) = state.grade.outcomes.get(key) else { continue };
        let c = Reviews::grade_compute(state, conn, key, Some(r))?;
        let (level, how) = grade::certainty(r);
        for (id, name) in grade::DOWN.iter().chain(grade::UP) {
            let d = r.domains.get(*id).cloned().unwrap_or_default();
            out.push_str(&line(&[txt(&c["label"]), r.design.clone(), if r.start.is_empty() { String::new() } else { r.start.clone() }, name.to_string(), d.judgement, d.suggested.unwrap_or_default(), d.footnote, grade::level_label(&level).into(), how.clone()]));
        }
    }
    Ok(out)
}

const SOF_HEAD: [&str; 8] = ["Outcome", "Risk without the intervention", "Risk with the intervention", "Difference (95% CI)", "Relative effect (95% CI)", "Participants (studies)", "Certainty of the evidence", "What happens"];

fn sof_cells(row: &Json) -> [String; 8] {
    let (assumed, corr) = risk_text(row);
    let participants = row["participants"].as_f64().map(|p| format!("{} ({})", p as i64, txt(&row["design"]))).unwrap_or_else(|| txt(&row["design"]));
    let marks = row["footnotes"].as_array().map(|m| m.iter().filter_map(Json::as_str).collect::<Vec<_>>().join(",")).unwrap_or_default();
    let importance = txt(&row["importanceLabel"]);
    [
        format!("{}{}", txt(&row["outcome"]), if importance.is_empty() { String::new() } else { format!(" ({})", importance.to_lowercase()) }),
        assumed,
        corr,
        txt(&row["effect"]),
        txt(&row["relative"]),
        participants,
        format!("{} {}{}", txt(&row["symbols"]), txt(&row["certaintyLabel"]), if marks.is_empty() { String::new() } else { format!(" ({marks})") }),
        txt(&row["statement"]),
    ]
}

fn sof_csv(t: &Json) -> String {
    let mut out = line(&SOF_HEAD.map(String::from));
    for row in t["rows"].as_array().into_iter().flatten() {
        out.push_str(&line(&sof_cells(row)));
    }
    for n in t["footnotes"].as_array().into_iter().flatten() {
        out.push_str(&line(&[format!("({}) {}", txt(&n["mark"]), txt(&n["text"]))]));
    }
    out
}

fn sof_md(t: &Json) -> String {
    let cell = |s: &str| s.replace('|', "\\|").replace('\n', " ");
    let mut out = format!("# Summary of findings: {}\n\n", cell(&txt(&t["review"])));
    out.push_str(&format!("| {} |\n|{}|\n", SOF_HEAD.join(" | "), SOF_HEAD.iter().map(|_| "---").collect::<Vec<_>>().join("|")));
    for row in t["rows"].as_array().into_iter().flatten() {
        out.push_str(&format!("| {} |\n", sof_cells(row).iter().map(|c| cell(c)).collect::<Vec<_>>().join(" | ")));
    }
    out.push_str("\nCertainty of the evidence (GRADE): high: we are very confident the true effect lies close to the estimate; moderate: the true effect is probably close to it; low: it may be substantially different; very low: it is likely to be substantially different.\n");
    let notes = t["footnotes"].as_array().cloned().unwrap_or_default();
    if !notes.is_empty() {
        out.push_str("\n**Explanations**\n\n");
        for n in notes {
            out.push_str(&format!("- ({}) {}\n", txt(&n["mark"]), cell(&txt(&n["text"]))));
        }
    }
    out
}

fn sof_html(t: &Json) -> String {
    let mut out = format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>Summary of findings</title>\n<style>body{{font-family:Calibri,Arial,sans-serif;font-size:10pt}}table{{border-collapse:collapse;width:100%}}th,td{{border:1px solid #999;padding:4pt;vertical-align:top;text-align:left}}th{{background:#eee}}</style></head><body>\n<h1>Summary of findings: {}</h1>\n<table>\n<tr>{}</tr>\n",
        esc(&txt(&t["review"])),
        SOF_HEAD.iter().map(|h| format!("<th>{}</th>", esc(h))).collect::<String>()
    );
    for row in t["rows"].as_array().into_iter().flatten() {
        out.push_str(&format!("<tr>{}</tr>\n", sof_cells(row).iter().map(|c| format!("<td>{}</td>", esc(c))).collect::<String>()));
    }
    out.push_str("</table>\n<p>Certainty of the evidence (GRADE): high: we are very confident the true effect lies close to the estimate; moderate: the true effect is probably close to it; low: it may be substantially different; very low: it is likely to be substantially different.</p>\n");
    let notes = t["footnotes"].as_array().cloned().unwrap_or_default();
    if !notes.is_empty() {
        out.push_str("<p><strong>Explanations</strong></p>\n<ol type=\"a\">\n");
        for n in notes {
            out.push_str(&format!("<li>{}</li>\n", esc(&txt(&n["text"]))));
        }
        out.push_str("</ol>\n");
    }
    out.push_str("</body></html>\n");
    out
}

// ── Host commands ───────────────────────────────────────────────────────────────────

/// The read-only commands (the main process does not announce a change after them).
pub const READS: &[&str] = &["review_rob_tools", "review_rob_overview", "review_rob_assessment", "review_rob_plots", "review_rob_analyse", "review_grade_overview", "review_grade_outcome", "review_grade_preview", "review_grade_sof"];

fn text<'a>(args: &'a Json, key: &str) -> &'a str {
    args.get(key).and_then(Json::as_str).unwrap_or("")
}

fn arg<T: serde::de::DeserializeOwned>(args: &Json, key: &str) -> Result<T> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Json::Null)).map_err(|e| format!("Bad {key}: {e}"))
}

/// One `review_rob_*` or `review_grade_*` command.
pub fn command(reviews: &Reviews, review: &str, command: &str, args: &Json) -> Result<Json> {
    let actor = || -> Result<String> { arg::<String>(args, "actor").map_err(|_| "Choose who is assessing".to_string()) };
    let options = || -> Result<Options> { arg::<Options>(args, "options") };
    Ok(match command {
        "review_rob_tools" => reviews.rob_tools(review)?,
        "review_rob_tool_save" => {
            reviews.rob_tool_save(review, arg(args, "tool")?, &actor()?)?;
            json!(true)
        }
        "review_rob_tool_delete" => {
            reviews.rob_tool_delete(review, text(args, "toolId"), &actor()?)?;
            json!(true)
        }
        "review_rob_setup" => {
            reviews.rob_setup(review, arg(args, "setup")?, &actor()?)?;
            json!(true)
        }
        "review_rob_study" => {
            reviews.rob_study_plan(review, text(args, "studyId"), arg(args, "plan")?, &actor()?)?;
            json!(true)
        }
        "review_rob_overview" => reviews.rob_overview(review, text(args, "viewer"))?,
        "review_rob_assessment" => reviews.rob_assessment(review, text(args, "studyId"), text(args, "result"), text(args, "viewer"))?,
        "review_rob_answer" => {
            reviews.rob_answer(review, text(args, "studyId"), text(args, "result"), text(args, "domain"), args.get("question").and_then(Json::as_str), text(args, "value"), text(args, "reason"), text(args, "support"), &actor()?)?;
            json!(true)
        }
        "review_rob_evidence" => json!(reviews.rob_evidence(review, text(args, "studyId"), text(args, "result"), arg(args, "evidence")?, args.get("removed").and_then(Json::as_bool).unwrap_or(false), &actor()?)?),
        "review_rob_complete" => {
            reviews.rob_complete(review, text(args, "studyId"), text(args, "result"), args.get("complete").and_then(Json::as_bool).unwrap_or(true), &actor()?)?;
            json!(true)
        }
        "review_rob_final" => {
            reviews.rob_final(review, text(args, "studyId"), text(args, "result"), text(args, "domain"), text(args, "value"), text(args, "note"), &actor()?)?;
            json!(true)
        }
        "review_rob_migrate" => json!({ "studies": reviews.rob_migrate(review, &actor()?)? }),
        "review_rob_plots" => reviews.rob_plots(review, text(args, "toolId"), args.get("result").and_then(Json::as_str), options().ok())?,
        "review_rob_analyse" => reviews.rob_analyse(review, text(args, "outcome"), text(args, "timepoint"), &options()?, args.get("subgroups").and_then(Json::as_bool).unwrap_or(false), text(args, "mode"))?,
        "review_grade_overview" => reviews.grade_overview(review)?,
        "review_grade_outcome" => reviews.grade_outcome(review, text(args, "key"))?,
        "review_grade_preview" => reviews.grade_preview(review, arg(args, "rating")?)?,
        "review_grade_set" => {
            reviews.grade_set(review, arg(args, "rating")?, &actor()?)?;
            json!(true)
        }
        "review_grade_delete" => {
            reviews.grade_delete(review, text(args, "key"), &actor()?)?;
            json!(true)
        }
        "review_grade_order" => {
            reviews.grade_order(review, arg(args, "order")?, &actor()?)?;
            json!(true)
        }
        "review_grade_sof" => reviews.grade_sof(review)?,
        other => return Err(format!("Unknown Key command: {other}")),
    })
}
