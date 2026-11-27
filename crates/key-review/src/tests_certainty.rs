// Risk of bias (rob.rs) and certainty of evidence (grade.rs, certainty.rs), with invented
// studies and an invented fixture tool (no published instrument's questions).
use crate::grade::{self, AnalysisChoice, DomainRating, Rating};
use crate::meta::{Measure, Method, Options};
use crate::model::*;
use crate::rob::{self, Evidence, Tool};
use crate::{NoLibrary, Reviews};
use serde_json::json;
use std::collections::BTreeMap;

/// A result-level tool made up for the tests: three domains with invented questions (one
/// asked only after an answer), a stars domain, and a worst-domain overall.
const FIXTURE: &str = r#"{
  "id": "fixture", "name": "Fixture tool", "short": "FX", "version": "1", "design": "Tests", "level": "result",
  "optionSets": {
    "abc": [{ "id": "a", "label": "Alpha" }, { "id": "b", "label": "Beta" }, { "id": "c", "label": "Gamma" }],
    "dot": [{ "id": "dot", "label": "Dot" }, { "id": "none", "label": "No dot" }]
  },
  "levels": [
    { "id": "low", "label": "Low risk", "tone": "green", "symbol": "plus", "common": "low" },
    { "id": "some", "label": "Some concerns", "tone": "amber", "symbol": "minus", "common": "some" },
    { "id": "high", "label": "High risk", "tone": "red", "symbol": "cross", "common": "high" }
  ],
  "domains": [
    { "id": "f1", "short": "F1", "name": "Fixture one", "rule": { "kind": "worst", "map": ["low", "some", "high"] }, "questions": [
      { "id": "q1", "text": "Fixture question one?", "options": "abc", "weights": { "a": 0, "b": 1, "c": 2 } },
      { "id": "q2", "text": "Fixture question two?", "options": "abc", "weights": { "a": 0, "b": 1, "c": 2 } }
    ] },
    { "id": "f2", "short": "F2", "name": "Fixture two", "rule": { "kind": "worst", "map": ["low", "some", "high"] }, "questions": [
      { "id": "q1", "text": "Fixture gate?", "options": "abc", "weights": { "a": 0, "b": 1, "c": 1 } },
      { "id": "q2", "text": "Fixture follow-up?", "options": "abc", "weights": { "a": 0, "b": 2, "c": 2 }, "showIf": { "question": "q1", "in": ["b", "c"] } }
    ] },
    { "id": "f3", "short": "F3", "name": "Fixture three", "rule": { "kind": "worst", "map": ["low", "some", "high"] }, "questions": [
      { "id": "q1", "text": "Fixture question three?", "options": "abc", "weights": { "a": 0, "b": 1, "c": 2 } }
    ] },
    { "id": "f4", "short": "F4", "name": "Fixture dots", "rule": { "kind": "stars", "thresholds": [{ "min": 2, "level": "low" }, { "min": 1, "level": "some" }, { "min": 0, "level": "high" }] }, "questions": [
      { "id": "x", "text": "Dot one", "options": "dot", "points": { "dot": 1 } },
      { "id": "y", "text": "Dot two", "options": "dot", "points": { "dot": 1 } }
    ] }
  ],
  "overall": { "kind": "worst" }
}"#;

fn fixture() -> Tool {
    serde_json::from_str(FIXTURE).unwrap()
}

/// A review with included studies, two assessors (Ana, Ben) and a tie-breaker (Cara),
/// dichotomous outcome data "Falls" for each study, and the fixture tool as its default.
fn setup(data: &[(f64, f64, f64, f64)]) -> (Reviews, String, String, Vec<String>) {
    let reviews = Reviews::in_memory().unwrap();
    let (id, a) = reviews.create("Balance training", "Ana", None).unwrap();
    let team = vec![
        Member { id: a.clone(), name: "Ana".into(), roles: vec!["owner".into(), "reviewer".into()], initials: "A".into() },
        Member { id: "b".into(), name: "Ben".into(), roles: vec!["reviewer".into()], initials: "B".into() },
        Member { id: "c".into(), name: "Cara".into(), roles: vec!["tiebreaker".into()], initials: "C".into() },
    ];
    reviews.save_team(&id, team, &a).unwrap();
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.rules.ta.reviewers = 1;
    p.rules.ft.reviewers = 1;
    p.rules.extractors = 2;
    p.rules.conflicts = "third".into();
    p.forms.push(crate::templates::outcomes_form());
    p.forms.push(crate::templates::rob2_form());
    reviews.save_protocol(&id, p, "", &a, false, &NoLibrary).unwrap();
    reviews.rob_tool_save(&id, fixture(), &a).unwrap();
    reviews.rob_setup(&id, rob::Setup { tool: "fixture".into(), ..Default::default() }, &a).unwrap();
    let records: Vec<RecordMeta> = (0..data.len()).map(|i| RecordMeta { id: format!("r{i:04}"), title: format!("Invented balance trial {i} in a made-up town"), authors: vec![format!("Author{i}, A")], year: Some(2010 + i as i64), ..Default::default() }).collect();
    reviews.import(&id, Batch { kind: "file".into(), group: "databases".into(), name: "Example".into(), ..Default::default() }, records, &a, &NoLibrary).unwrap();
    let ids: Vec<String> = reviews.read(&id, |s, _| Ok(s.records.iter().map(|r| r.id.clone()).collect())).unwrap();
    for (r, (e1, n1, e2, n2)) in ids.iter().zip(data) {
        reviews.decide(&id, &[r.clone()], Stage::Ta, Choice::Include, vec![], "", "", vec![], &a).unwrap();
        reviews.decide(&id, &[r.clone()], Stage::Ft, Choice::Include, vec![], "", "", vec![], &a).unwrap();
        let row = json!([{ "outcome": "Falls", "timepoint": "12 months", "type": "Dichotomous", "e1": e1, "n1": n1, "e2": e2, "n2": n2 }]);
        reviews.extract(&id, r, "f-outcomes", "outcomes", row, "Table 2", Some(3), None, None, false, true, &a).unwrap();
    }
    (reviews, id, a, ids)
}

const RESULT: &str = "Falls|12 months";

/// Answers every fixture question so that Key suggests `level` (low: answers raising no
/// concern; high: the most concerning ones) and judges each domain and overall as suggested.
fn assess(reviews: &Reviews, id: &str, study: &str, who: &str, level: &str) {
    let tool = fixture();
    for d in &tool.domains {
        let mut given = BTreeMap::new();
        for q in &d.questions {
            if !tool.asked(q, &given) {
                continue;
            }
            let answer = if !q.points.is_empty() {
                if level == "low" { "dot".to_string() } else { "none".to_string() }
            } else if level == "low" {
                q.weights.iter().find(|(_, w)| **w == 0).unwrap().0.clone()
            } else {
                q.weights.iter().max_by_key(|(_, w)| **w).unwrap().0.clone()
            };
            reviews.rob_answer(id, study, RESULT, &d.id, Some(&q.id), &answer, "", "", who).unwrap();
            given.insert(q.id.clone(), answer);
        }
        let suggested = tool.suggest_domain(d, &given).unwrap().level;
        reviews.rob_answer(id, study, RESULT, &d.id, None, &suggested, "", "", who).unwrap();
    }
    reviews.rob_answer(id, study, RESULT, "overall", None, level, "", "", who).unwrap();
}

/// Tools whose official text is not openly licensed (LICENSES.md): structure only.
const RESTRICTED: &[&str] = &["rob2", "robins-i", "robins-e", "nos", "quadas2"];

#[test]
fn restricted_tools_ship_structure_only() {
    let tools = rob::builtin_tools();
    for id in RESTRICTED {
        let t = tools.iter().find(|t| t.id == *id).unwrap_or_else(|| panic!("{id} missing"));
        assert!(t.domains.iter().all(|d| d.questions.is_empty() && d.prompt.is_empty()), "{id} ships questions or prompts");
        assert!(t.option_sets.is_empty(), "{id} ships response options");
        assert!(t.domains.iter().all(|d| matches!(d.rule.kind.as_str(), "manual" | "")), "{id} ships a domain algorithm");
        assert_eq!(t.overall.kind, "worst");
        assert!(t.url.starts_with("https://"), "{id} links the official tool");
        assert!(t.licence.contains("checked 2026-11-27") && t.licence.contains("https://"), "{id} records its licence check");
    }
    // Every shipped tool is either restricted or Key's own.
    assert!(tools.iter().all(|t| RESTRICTED.contains(&t.id.as_str()) || t.licence.contains("Written for Key")));
}

#[test]
fn shipped_tools_are_valid_and_suggest_judgements() {
    for t in rob::builtin_tools() {
        t.validate().unwrap_or_else(|e| panic!("{}: {e}", t.id));
    }
    fixture().validate().unwrap();
    rob::blank_tool().validate().unwrap_err(); // no id yet
    let t = fixture();
    let d1 = t.domain("f1").unwrap();
    let answers = |pairs: &[(&str, &str)]| pairs.iter().map(|(q, a)| (q.to_string(), a.to_string())).collect::<BTreeMap<_, _>>();
    // Incomplete: no suggestion yet.
    assert!(t.suggest_domain(d1, &answers(&[("q1", "a")])).is_none());
    assert_eq!(t.suggest_domain(d1, &answers(&[("q1", "a"), ("q2", "a")])).unwrap().level, "low");
    let s = t.suggest_domain(d1, &answers(&[("q1", "a"), ("q2", "b")])).unwrap();
    assert_eq!(s.level, "some");
    assert!(s.why.contains("Beta"), "{}", s.why);
    assert_eq!(t.suggest_domain(d1, &answers(&[("q1", "c"), ("q2", "a")])).unwrap().level, "high");
    // A follow-up question is asked only after the answer it depends on.
    let d2 = t.domain("f2").unwrap();
    assert_eq!(t.suggest_domain(d2, &answers(&[("q1", "a")])).unwrap().level, "low");
    assert!(t.suggest_domain(d2, &answers(&[("q1", "b")])).is_none());
    assert_eq!(t.suggest_domain(d2, &answers(&[("q1", "b"), ("q2", "c")])).unwrap().level, "high");
    // Stars: points summed into levels.
    let d4 = t.domain("f4").unwrap();
    assert_eq!(t.suggest_domain(d4, &answers(&[("x", "dot"), ("y", "dot")])).unwrap().level, "low");
    assert_eq!(t.suggest_domain(d4, &answers(&[("x", "dot"), ("y", "none")])).unwrap().level, "some");
    // Overall: the least favourable domain.
    let mut j: BTreeMap<String, String> = ["f1", "f2", "f3", "f4"].iter().map(|d| (d.to_string(), "low".to_string())).collect();
    assert_eq!(t.suggest_overall(&j).unwrap().level, "low");
    j.insert("f3".into(), "some".into());
    let o = t.suggest_overall(&j).unwrap();
    assert_eq!((o.level.as_str(), o.why.as_str()), ("some", "Fixture three is some concerns"));
    j.remove("f4");
    assert!(t.suggest_overall(&j).is_none());
    // A structure-only tool: no domain suggestion, the worst-domain overall default.
    let tools = rob::builtin_tools();
    let rob2 = tools.iter().find(|t| t.id == "rob2").unwrap();
    assert!(rob2.suggest_domain(rob2.domain("d1").unwrap(), &BTreeMap::new()).is_none());
    let j: BTreeMap<String, String> = ["d1", "d2", "d3", "d4", "d5"].iter().map(|d| (d.to_string(), if *d == "d2" { "high" } else { "low" }.to_string())).collect();
    assert_eq!(rob2.suggest_overall(&j).unwrap().level, "high");
    // QUADAS-2's structure: applicability does not count in the overall.
    let q = tools.iter().find(|t| t.id == "quadas2").unwrap();
    let j: BTreeMap<String, String> = ["patients", "index", "reference", "flow"].iter().map(|d| (d.to_string(), "low".to_string())).chain([("a-patients".to_string(), "high".to_string())]).collect();
    assert_eq!(q.suggest_overall(&j).unwrap().level, "low");
    // Key's own checklist works at question level out of the box.
    let k = tools.iter().find(|t| t.id == "key-basic").unwrap();
    let g = k.domain("groups").unwrap();
    assert_eq!(k.suggest_domain(g, &answers(&[("q1", "yes"), ("q2", "partly")])).unwrap().level, "some");
}

#[test]
fn custom_tools_are_checked_and_versioned() {
    let (reviews, id, a, ids) = setup(&[(5., 50., 10., 50.)]);
    let mut t = rob::blank_tool();
    t.id = "custom-1".into();
    t.domains[0].rule.map = vec!["low".into(), "nope".into()];
    assert!(reviews.rob_tool_save(&id, t.clone(), &a).unwrap_err().contains("judgement level"));
    t.domains[0].rule.map = vec!["low".into(), "some".into(), "high".into()];
    reviews.rob_tool_save(&id, t.clone(), &a).unwrap();
    reviews.rob_study_plan(&id, &ids[0], rob::StudyPlan { tool: "custom-1".into(), results: None }, &a).unwrap();
    reviews.rob_answer(&id, &ids[0], "", "d1", None, "low", "", "", &a).unwrap();
    // In use: a domain cannot disappear, and an edit raises the version.
    let mut edited = t.clone();
    edited.domains[0].id = "renamed".into();
    assert!(reviews.rob_tool_save(&id, edited, &a).is_err());
    let mut edited = t.clone();
    edited.domains[0].name = "Domain one".into();
    reviews.rob_tool_save(&id, edited, &a).unwrap();
    let tools = reviews.rob_tools(&id).unwrap();
    let saved = tools["tools"].as_array().unwrap().iter().find(|x| x["id"] == "custom-1").unwrap();
    assert_eq!(saved["version"], "2");
    assert_eq!(saved["inUse"], true);
    assert!(reviews.rob_tool_delete(&id, "custom-1", &a).is_err());
}

#[test]
fn dual_assessment_is_blind_then_conflicts_then_consensus() {
    let (reviews, id, a, ids) = setup(&[(5., 50., 10., 50.), (8., 60., 12., 60.), (20., 200., 30., 200.)]);
    let s = &ids[0];
    // Ana assesses everything low; she cannot finish while a judgement that differs from the
    // suggestion lacks a reason.
    assess(&reviews, &id, s, &a, "low");
    reviews.rob_answer(&id, s, RESULT, "f3", None, "high", "", "", &a).unwrap();
    assert!(reviews.rob_complete(&id, s, RESULT, true, &a).unwrap_err().contains("differs from the suggestion"));
    reviews.rob_answer(&id, s, RESULT, "f3", None, "low", "", "", &a).unwrap();
    reviews.rob_complete(&id, s, RESULT, true, &a).unwrap();
    // Evidence from the reader, with its place.
    let ev = Evidence { domain: "f1".into(), text: "Allocation by sealed envelopes".into(), page: 2, rects: vec![json!([100, 200, 3000, 400])], hash: "h1".into(), ..Default::default() };
    reviews.rob_evidence(&id, s, RESULT, ev, false, &a).unwrap();
    // Ben, blind, sees nothing of Ana's.
    let view = reviews.rob_assessment(&id, s, RESULT, "b").unwrap();
    assert_eq!(view["canSeeOthers"], false);
    assert!(view["others"][0].get("judgements").is_none());
    assert_eq!(view["progress"], "waiting");
    // Ben rates D1 high (his answers suggest it): a conflict on D1 and overall.
    assess(&reviews, &id, s, "b", "low");
    for q in ["q1", "q2"] {
        reviews.rob_answer(&id, s, RESULT, "f1", Some(q), "c", "", "", "b").unwrap();
    }
    reviews.rob_answer(&id, s, RESULT, "f1", None, "high", "", "", "b").unwrap();
    assert!(reviews.rob_complete(&id, s, RESULT, true, "b").unwrap_err().contains("Overall"));
    reviews.rob_answer(&id, s, RESULT, "overall", None, "high", "", "", "b").unwrap();
    reviews.rob_complete(&id, s, RESULT, true, "b").unwrap();
    let view = reviews.rob_assessment(&id, s, RESULT, "b").unwrap();
    assert_eq!(view["canSeeOthers"], true);
    assert_eq!(view["progress"], "conflict");
    assert_eq!(view["conflicts"], json!(["f1", "overall"]));
    assert_eq!(view["others"][0]["evidence"][0]["page"], 2);
    let overview = reviews.rob_overview(&id, &a).unwrap();
    assert_eq!(overview["totals"]["conflicts"], 1);
    assert_eq!(overview["conflicts"][0]["domains"], json!(["Fixture one", "Overall"]));
    // Only the tie-breaker settles under "third".
    assert!(reviews.rob_final(&id, s, RESULT, "f1", "some", "", "b").is_err());
    reviews.rob_final(&id, s, RESULT, "f1", "some", "Envelopes not opaque", "c").unwrap();
    reviews.rob_final(&id, s, RESULT, "overall", "some", "", "c").unwrap();
    let view = reviews.rob_assessment(&id, s, RESULT, &a).unwrap();
    assert_eq!(view["progress"], "done");
    assert_eq!(view["agreed"]["f1"], "some");
    assert_eq!(view["agreed"]["f2"], "low");
    // A change reopens the assessor's assessment: no longer done.
    reviews.rob_answer(&id, s, RESULT, "f2", None, "some", "Unclear", "", &a).unwrap();
    assert_eq!(reviews.rob_assessment(&id, s, RESULT, &a).unwrap()["progress"], "waiting");
    // The covariate for analyses (the agreed overall stands).
    reviews.rob_answer(&id, s, RESULT, "overall", None, "low", "Waiting for the consensus meeting", "", &a).unwrap();
    reviews.rob_complete(&id, s, RESULT, true, &a).unwrap();
    let cov = reviews.read(&id, |st, _| Ok(rob::covariates(st, "Falls", Some("12 months")))).unwrap();
    assert_eq!(cov[s].overall, "some");
    assert_eq!(cov[s].rank, 1);
    // The log keeps every change (versioned); the CSV carries the evidence.
    let csv = reviews.export(&id, "rob-csv", &a).unwrap();
    assert!(csv["content"].as_str().unwrap().contains("p. 3: Allocation by sealed envelopes"));
    let cj = reviews.export(&id, "rob-covariates", &a).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(cj["content"].as_str().unwrap()).unwrap();
    assert_eq!(parsed[s]["byResult"][RESULT]["overall"], "some");
}

#[test]
fn form_answers_migrate_once() {
    let (reviews, id, a, ids) = setup(&[(5., 50., 10., 50.), (8., 60., 12., 60.)]);
    let s = &ids[0];
    for (f, v) in [("d1_judgement", "Low risk"), ("d2_judgement", "Some concerns"), ("d3_judgement", "Low risk"), ("d4_judgement", "Low risk"), ("d5_judgement", "High risk"), ("overall_judgement", "High risk")] {
        reviews.extract(&id, s, "f-rob2", f, json!(v), "", None, None, None, false, false, &a).unwrap();
    }
    reviews.extract(&id, s, "f-rob2", "d1_support", json!("Computer-generated list"), "computer-generated list", Some(4), None, None, false, false, &a).unwrap();
    reviews.extract(&id, s, "f-rob2", "d5_judgement", json!("High risk"), "", None, None, None, false, true, "c").unwrap();
    assert_eq!(reviews.read(&id, |st, _| Ok(rob::migratable(st))).unwrap(), 1);
    assert_eq!(reviews.rob_migrate(&id, &a).unwrap(), 1);
    assert_eq!(reviews.read(&id, |st, _| Ok(rob::migratable(st))).unwrap(), 0);
    // Running it again adds nothing.
    let events = reviews.events(&id).unwrap().len();
    assert_eq!(reviews.rob_migrate(&id, &a).unwrap(), 0);
    assert_eq!(reviews.events(&id).unwrap().len(), events);
    let view = reviews.rob_assessment(&id, s, "", &a).unwrap();
    assert_eq!(view["result"], "");
    assert_eq!(view["mine"]["judgements"]["d2"]["value"], "some");
    assert_eq!(view["mine"]["judgements"]["d1"]["support"], "Computer-generated list");
    assert_eq!(view["mine"]["evidence"][0]["text"], "computer-generated list");
    assert_eq!(view["mine"]["evidence"][0]["page"], 3);
    assert_eq!(view["mine"]["complete"], true);
    assert_eq!(view["finals"]["d5"]["value"], "high");
    // A result-level tool falls back to the study-level assessment for a result (with one
    // assessor needed, Ana's judgements are the agreed ones).
    assert!(reviews.read(&id, |st, _| Ok(rob::overall_for(st, s, RESULT).is_none())).unwrap());
    reviews.rob_setup(&id, rob::Setup { assessors: Some(1), ..Default::default() }, &a).unwrap();
    let (_, level, _) = reviews.read(&id, |st, _| Ok(rob::overall_for(st, s, RESULT).unwrap())).unwrap();
    assert_eq!(level.id, "high");
}

/// (e1, n1, e2, n2): two large low-risk studies and two at high risk with bigger effects.
const FALLS: [(f64, f64, f64, f64); 4] = [(30., 300., 40., 300.), (28., 280., 36., 280.), (5., 60., 20., 60.), (4., 50., 18., 50.)];

fn assess_all(reviews: &Reviews, id: &str, a: &str, ids: &[String]) {
    for (i, s) in ids.iter().enumerate() {
        let level = if i < 2 { "low" } else { "high" };
        for who in [a, "b"] {
            assess(reviews, id, s, who, level);
            reviews.rob_complete(id, s, RESULT, true, who).unwrap();
        }
    }
}

#[test]
fn sensitivity_and_subgroups_by_risk_of_bias() {
    let (reviews, id, a, ids) = setup(&FALLS);
    let options = Options { measure: Measure::RR, method: Method::Dl, hartung_knapp: false, level: 0.95 };
    // Not assessed yet: flagged.
    let out = reviews.rob_analyse(&id, "Falls", "12 months", &options, false, "").unwrap();
    assert_eq!(out["rob"]["missing"].as_array().unwrap().len(), 4);
    assess_all(&reviews, &id, &a, &ids);
    let all = reviews.rob_analyse(&id, "Falls", "12 months", &options, false, "").unwrap();
    assert!(all["rob"]["missing"].as_array().unwrap().is_empty());
    assert_eq!(all["rob"]["columns"].as_array().unwrap().len(), 4);
    assert_eq!(all["rob"]["studies"][&ids[2]]["overall"]["symbol"], "cross");
    let low = reviews.rob_analyse(&id, "Falls", "12 months", &options, false, "excludeHigh").unwrap();
    assert_eq!(low["analysis"]["main"]["k"], 2);
    assert_eq!(low["rob"]["excluded"].as_array().unwrap().len(), 2);
    let (e_all, e_low) = (all["analysis"]["main"]["estimate"].as_f64().unwrap(), low["analysis"]["main"]["estimate"].as_f64().unwrap());
    assert!(e_low > e_all + 0.1, "excluding the high-risk studies moves the estimate towards no effect: {e_all} {e_low}");
    let sub = reviews.rob_analyse(&id, "Falls", "12 months", &options, false, "subgroup").unwrap();
    let names: Vec<&str> = sub["analysis"]["subgroups"].as_array().unwrap().iter().map(|g| g["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["High risk of bias", "Low risk of bias"]);
    assert!(sub["analysis"]["subgroupTest"]["p"].as_f64().unwrap() < 0.05);
    // Plots: rows per study, the summary unweighted and weighted by the analysis.
    let plots = reviews.rob_plots(&id, "fixture", Some(RESULT), Some(options)).unwrap();
    assert_eq!(plots["rows"].as_array().unwrap().len(), 4);
    let overall = plots["summary"].as_array().unwrap().iter().find(|s| s["domain"] == "overall").unwrap();
    assert_eq!(overall["unweighted"][0]["share"], 50.0);
    let weighted_low = overall["weighted"][0]["share"].as_f64().unwrap();
    assert!(weighted_low > 55.0, "the big low-risk trials carry most weight: {weighted_low}");
}

// ── GRADE ────────────────────────────────────────────────────────────────────────────

#[test]
fn absolute_effects_per_thousand() {
    // RR: the risk with the intervention is the assumed risk times the RR (Cochrane Handbook
    // ch. 14 §14.1.5.1). Assumed 100 per 1,000, RR 0.75 (0.60 to 0.93): 75 per 1,000, 25 fewer
    // (40 fewer to 7 fewer).
    let x = grade::absolute(Measure::RR, 100.0, 0.75, 0.60, 0.93).unwrap();
    assert!((x.corresponding.0 - 75.0).abs() < 1e-9);
    assert!((x.difference.1 - -40.0).abs() < 1e-9 && (x.difference.2 - -7.0).abs() < 1e-9);
    assert_eq!(grade::difference_text(x.difference), "25 fewer per 1,000 (from 40 fewer to 7 fewer)");
    // OR: through the odds, ACR × OR / (1 − ACR + ACR × OR) (Cochrane Handbook ch. 15 §15.4.4).
    // Assumed 200 per 1,000, OR 0.5: odds 0.25 → 0.125, risk 0.125 / 1.125 = 111 per 1,000 (not
    // the 100 that multiplying the risk by the OR would give).
    let x = grade::absolute(Measure::OR, 200.0, 0.5, 0.25, 1.0).unwrap();
    assert!((x.corresponding.0 - 1000.0 / 9.0).abs() < 1e-9);
    assert!((x.corresponding.1 - 1000.0 * 0.05 / 0.85).abs() < 1e-9); // 58.8
    assert!((x.corresponding.2 - 200.0).abs() < 1e-9);
    assert_eq!(grade::difference_text(x.difference), "89 fewer per 1,000 (from 141 fewer to 0)");
    // With a rare outcome the OR and RR give nearly the same risk; with a common one they part.
    let rare = grade::corresponding_risk(Measure::OR, 0.01, 2.0);
    assert!((rare - 0.02).abs() < 0.0003);
    let common = grade::corresponding_risk(Measure::OR, 0.5, 2.0);
    assert!((common - 2.0 / 3.0).abs() < 1e-12);
    // RD: the same absolute difference whatever the risk; intervals sorted.
    let x = grade::absolute(Measure::RD, 300.0, -0.05, -0.08, -0.02).unwrap();
    assert!((x.difference.0 - -50.0).abs() < 1e-9 && (x.corresponding.1 - 220.0).abs() < 1e-9);
    // A protective ratio with its interval upside down still gives lower ≤ upper.
    let x = grade::absolute(Measure::RR, 50.0, 2.0, 1.5, 3.0).unwrap();
    assert!(x.corresponding.1 <= x.corresponding.2);
    assert_eq!(grade::mean_text(-0.45, -0.8, -0.1, " SD"), "0.45 lower SD (0.80 lower to 0.10 lower)");
    assert!(grade::absolute(Measure::MD, 100.0, 1.0, 0.0, 2.0).is_none());
}

#[test]
fn certainty_levels_and_footnotes() {
    let mut r = Rating { outcome: "Falls".into(), design: "randomised".into(), ..Default::default() };
    assert_eq!(grade::certainty(&r).0, "high");
    r.domains.insert("riskOfBias".into(), DomainRating { judgement: "serious".into(), footnote: String::new(), suggested: None });
    assert!(grade::validate(&r).unwrap_err().contains("footnote"));
    r.domains.get_mut("riskOfBias").unwrap().footnote = "Half the weight from trials without concealment".into();
    grade::validate(&r).unwrap();
    r.domains.insert("imprecision".into(), DomainRating { judgement: "verySerious".into(), footnote: "Few events".into(), suggested: None });
    let (level, how) = grade::certainty(&r);
    assert_eq!(level, "veryLow");
    assert_eq!(how, "Starts high (randomised trials), down one for risk of bias, down two for imprecision: very low.");
    // Overriding a suggestion with "not serious" also needs a footnote.
    r.domains.insert("inconsistency".into(), DomainRating { judgement: "none".into(), footnote: String::new(), suggested: Some("serious".into()) });
    assert!(grade::validate(&r).unwrap_err().contains("differs from Key's suggestion"));
    // Non-randomised evidence starts low and may go up for a large effect; never above high.
    let mut n = Rating { outcome: "Falls".into(), design: "nonRandomised".into(), ..Default::default() };
    assert_eq!(grade::certainty(&n).0, "low");
    n.domains.insert("largeEffect".into(), DomainRating { judgement: "veryLarge".into(), footnote: "RR 0.15".into(), suggested: None });
    assert_eq!(grade::certainty(&n).0, "high");
    n.start = "high".into();
    assert_eq!(grade::certainty(&n).0, "high");
    assert_eq!(grade::symbols("moderate"), "⊕⊕⊕◯");
    assert_eq!(grade::statement("moderate", "balance training", "Falls", -1, false), "Balance training probably reduces falls.");
    assert_eq!(grade::statement("low", "balance training", "Falls", 1, true), "Balance training may result in little or no difference in falls.");
    assert!(grade::statement("veryLow", "balance training", "Falls", -1, false).starts_with("The evidence is very uncertain"));
}

#[test]
fn information_size_follows_the_sample_size_formula() {
    // Control risk 20%, 25% relative reduction (to 15%), α 0.05, power 80%:
    // n per group = (1.96 + 0.84)² × (0.2·0.8 + 0.15·0.85) / 0.05² = 7.849 × 0.2875 / 0.0025 = 902.6 → 903.
    assert_eq!(grade::information_size(true, Some(200.0), None, None), Some(1806.0));
    // Continuous: MID 5 points, SD 10: n per group = 2 × 7.849 × 100 / 25 = 62.8 → 63.
    assert_eq!(grade::information_size(false, None, Some(5.0), Some(10.0)), Some(126.0));
    assert_eq!(grade::information_size(false, None, None, Some(10.0)), None);
}

#[test]
fn grade_suggestions_rating_and_summary_of_findings() {
    let (reviews, id, a, ids) = setup(&FALLS);
    let key = RESULT;
    // Before risk of bias: no suggestion for that domain, and why.
    let o = reviews.grade_outcome(&id, key).unwrap();
    assert!(o["suggestions"]["riskOfBias"]["judgement"].is_null());
    assert!(o["suggestions"]["indirectness"]["judgement"].is_null());
    assert!(o["suggestions"]["publicationBias"]["why"][0].as_str().unwrap().contains("too few"));
    assess_all(&reviews, &id, &a, &ids);
    let o = reviews.grade_outcome(&id, key).unwrap();
    assert_eq!(o["rating"]["design"], "randomised");
    // The high-risk trials carry under a quarter of the weight: not serious, with the numbers.
    let rob_s = &o["suggestions"]["riskOfBias"];
    assert_eq!(rob_s["judgement"], "none", "{rob_s}");
    assert!(rob_s["why"][1].as_str().unwrap().starts_with("Without the studies at high risk"));
    assert!(o["suggestions"]["inconsistency"]["why"][0].as_str().unwrap().starts_with("I² = "));
    // 1,380 participants against an information size of about 1,700 at a control risk of ~200:
    // rated down one for imprecision.
    assert_eq!(o["participants"], 1380.0);
    assert!(o["suggestions"]["imprecision"]["why"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("optimal information size")));
    // The reviewer downgrades risk of bias against the suggestion, with a footnote.
    let mut rating: Rating = serde_json::from_value(o["rating"].clone()).unwrap();
    rating.analysis = AnalysisChoice { measure: "RR".into(), method: "dl".into(), hartung_knapp: false };
    rating.importance = Some(8);
    rating.mid = Some(20.0);
    rating.domains.insert("riskOfBias".into(), DomainRating { judgement: "serious".into(), footnote: String::new(), ..Default::default() });
    assert!(reviews.grade_set(&id, rating.clone(), &a).unwrap_err().contains("footnote"));
    rating.domains.get_mut("riskOfBias").unwrap().footnote = "Two trials did not conceal allocation and show larger effects".into();
    reviews.grade_set(&id, rating, &a).unwrap();
    let o = reviews.grade_outcome(&id, key).unwrap();
    assert_eq!(o["rating"]["domains"]["riskOfBias"]["suggested"], "none");
    assert_eq!(o["certainty"]["level"], "moderate");
    // Summary of findings: absolute effects, certainty and footnotes; the exports carry them.
    let sof = reviews.grade_sof(&id).unwrap();
    let row = &sof["rows"][0];
    assert_eq!(row["certainty"], "moderate");
    assert_eq!(row["studies"], 4);
    assert!(row["effect"].as_str().unwrap().contains("fewer per 1,000"), "{row}");
    assert!(row["relative"].as_str().unwrap().starts_with("RR "));
    assert_eq!(row["footnotes"], json!(["a"]));
    for kind in ["sof-md", "sof-html", "sof-csv"] {
        let f = reviews.export(&id, kind, &a).unwrap();
        let text = f["content"].as_str().unwrap();
        assert!(text.contains("fewer per 1,000") && text.contains("Moderate") && text.contains("Two trials did not conceal allocation"), "{kind}: {text}");
    }
    let md = reviews.export(&id, "sof-md", &a).unwrap()["content"].as_str().unwrap().to_string();
    assert!(md.contains("⊕⊕⊕◯ Moderate (a)") && md.contains("4 randomised trials"), "{md}");
    let g = reviews.export(&id, "grade-csv", &a).unwrap();
    assert!(g["content"].as_str().unwrap().contains("Risk of bias,serious,none,Two trials"));
    // What the checklist reads.
    let facts = reviews.read(&id, |st, _| Ok(rob::reporting_facts(st))).unwrap();
    assert!(facts["rob"]["statement"].as_str().unwrap().contains("Two assessors independently"), "{facts}");
    assert_eq!(facts["rob"]["assessed"], 4);
    assert_eq!(facts["grade"]["outcomes"], 1);
    assert_eq!(facts["rob"]["usedInAnalysis"], true);
    // The checklist (std-A) and the conduct checks (std-B) read the same assessments.
    let hooks = reviews.read(&id, |st, _| Ok(crate::reporting_hooks::facts(st))).unwrap();
    assert_eq!(hooks["rob"]["assessed"], 4);
    assert_eq!(hooks["grade"]["outcomes"], 1);
    let conduct = reviews.export(&id, "conduct", &a).unwrap()["content"].as_str().unwrap().to_string();
    assert!(!conduct.contains("No risk-of-bias assessment") && !conduct.contains("Risk of bias assessed by one person"), "{conduct}");
    // Merging the log elsewhere gives the same state.
    let events = reviews.events(&id).unwrap();
    let other = Reviews::in_memory().unwrap();
    other.merge(events).unwrap();
    assert_eq!(other.grade_outcome(&id, key).unwrap()["certainty"], reviews.grade_outcome(&id, key).unwrap()["certainty"]);
}

#[test]
fn rob_and_grade_at_scale() {
    // 300 included studies with two assessors each: the overview stays quick.
    let n = 300;
    let data: Vec<(f64, f64, f64, f64)> = (0..n).map(|i| (5. + (i % 7) as f64, 100., 10. + (i % 5) as f64, 100.)).collect();
    let (reviews, id, a, ids) = setup(&data);
    for s in ids.iter().take(50) {
        assess(&reviews, &id, s, &a, "low");
    }
    let t = std::time::Instant::now();
    let o = reviews.rob_overview(&id, &a).unwrap();
    assert_eq!(o["studies"].as_array().unwrap().len(), n);
    let _ = reviews.grade_outcome(&id, RESULT).unwrap();
    assert!(t.elapsed().as_millis() < 3000, "{:?}", t.elapsed());
}
