// std-B: citation chasing against a mocked graph, human–AI agreement and audit sizes, conduct
// checks on synthetic reviews, extraction pilots. Invented records only; no network.
use crate::ai_audit::{self, CallInfo};
use crate::chasing::{self, Direction, GraphWork, MockGraph};
use crate::conduct;
use crate::model::*;
use crate::xpilot;
use crate::{NoLibrary, Reviews};
use serde_json::{Value as Json, json};
use std::collections::HashMap;

const RIS: &str = "TY  - JOUR\nTI  - Walking groups and blood pressure in older adults\nAU  - Rivera, Ana\nPY  - 2016\nDO  - 10.9999/walk.1\nAB  - A trial.\nER  - \n\
TY  - JOUR\nTI  - Stretching at work: a cluster trial\nAU  - Okafor, Ben\nPY  - 2019\nAB  - Office workers stretched.\nER  - \n\
TY  - JOUR\nTI  - Cycling to school and fitness in children\nAU  - Haas, Dev\nPY  - 2021\nDO  - 10.9999/cycle.3\nAB  - Children cycled.\nER  - \n\
TY  - JOUR\nTI  - Yoga for back pain: a randomised trial\nAU  - Moreau, Eli\nPY  - 2018\nDO  - 10.9999/yoga.4\nAB  - Adults did yoga.\nER  - \n";

fn setup() -> (Reviews, String, String) {
    let reviews = Reviews::in_memory().unwrap();
    let (id, owner) = reviews.create("Movement and health", "Ana", None).unwrap();
    let team = vec![
        Member { id: owner.clone(), name: "Ana".into(), roles: vec!["owner".into(), "reviewer".into()], initials: "A".into() },
        Member { id: "b".into(), name: "Ben".into(), roles: vec!["reviewer".into()], initials: "B".into() },
    ];
    reviews.save_team(&id, team, &owner).unwrap();
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.rules.ta.reviewers = 1;
    p.rules.ft.reviewers = 1;
    p.criteria = crate::templates::suggested_criteria(&p.question);
    reviews.save_protocol(&id, p, "", &owner, false, &NoLibrary).unwrap();
    let parsed = crate::import::parse_file(RIS, Some("search.ris")).unwrap();
    let batch = Batch { kind: "file".into(), group: "databases".into(), name: "Example database".into(), searched_at: "2026-01-10".into(), ..Default::default() };
    reviews.import(&id, batch, parsed.records, &owner, &NoLibrary).unwrap();
    (reviews, id, owner)
}

fn by_title(reviews: &Reviews, id: &str, title: &str) -> String {
    reviews.read(id, |s, conn| Ok(crate::store::all_metas(conn, id)?.into_iter().find(|m| m.title.starts_with(title) && s.record(&m.id).is_some()).unwrap().id)).unwrap()
}

fn include(reviews: &Reviews, id: &str, owner: &str, records: &[String]) {
    reviews.decide(id, records, Stage::Ta, Choice::Include, vec![], "", "", vec![], owner).unwrap();
    reviews.decide(id, records, Stage::Ft, Choice::Include, vec![], "", "", vec![], owner).unwrap();
}

fn work(id: &str, doi: &str, title: &str, year: i64, author: &str, refs: &[&str]) -> GraphWork {
    GraphWork { id: id.into(), doi: doi.into(), title: title.into(), year: Some(year), authors: vec![author.into()], references: refs.iter().map(|s| s.to_string()).collect(), ..Default::default() }
}

fn graph() -> MockGraph {
    MockGraph {
        works: vec![
            // Seeds: walking (by DOI) and stretching (no DOI in the review: found by title).
            work("W1", "10.9999/walk.1", "Walking groups and blood pressure in older adults", 2016, "Rivera, Ana", &["W10", "W11", "W3"]),
            work("W2", "", "Stretching at work: a cluster trial", 2019, "Okafor, Ben", &["W11", "W12"]),
            // Cycling is already in the review (by DOI).
            work("W3", "10.9999/cycle.3", "Cycling to school and fitness in children", 2021, "Haas, Dev", &[]),
            work("W10", "10.9999/ref.10", "Pedometers and step counts", 2010, "Kim, Jo", &[]),
            // Cited by both seeds: co-citation, two links.
            work("W11", "10.9999/ref.11", "Physical activity guidelines revisited", 2012, "Lund, Mo", &[]),
            work("W12", "", "Desk breaks and back pain", 2014, "Pires, Lu", &[]),
            // Cites both seeds: bibliographic coupling, two links.
            work("W20", "10.9999/cite.20", "Workplace and community exercise: a review", 2022, "Ito, Sam", &["W1", "W2"]),
            work("W21", "10.9999/cite.21", "Group walking for hypertension", 2023, "Diaz, Rae", &["W1"]),
        ],
        local: HashMap::new(),
        calls: Default::default(),
    }
}

#[test]
fn chasing_dedups_counts_and_imports_a_citation_searching_batch() {
    let (reviews, id, owner) = setup();
    let walk = by_title(&reviews, &id, "Walking");
    let stretch = by_title(&reviews, &id, "Stretching");
    include(&reviews, &id, &owner, &[walk.clone(), stretch.clone()]);
    assert_eq!(chasing::default_seeds(&reviews.read(&id, |s, _| Ok(s.clone())).unwrap()).len(), 2);
    let seeds: Vec<RecordMeta> = reviews.metas(&id, &[walk.clone(), stretch.clone()]).unwrap().into_values().collect();
    let g = graph();
    let mut steps = 0;
    let result = chasing::chase(&seeds, Direction::Both, &g, &mut |_| {
        steps += 1;
        true
    })
    .unwrap();
    assert!(steps > 0);
    let via: HashMap<String, String> = result.seeds.iter().map(|s| (s.record_id.clone(), s.via.clone())).collect();
    assert_eq!(via[&walk], "doi");
    assert_eq!(via[&stretch], "title", "a seed without a DOI is matched by title, year and author");
    // Backward: W10, W11 (twice), W12, W3; forward: W20 (twice), W21. Distinct: 6.
    assert_eq!(result.candidates.len(), 6, "{:?}", result.candidates.iter().map(|c| &c.meta.title).collect::<Vec<_>>());
    let links = |t: &str| result.candidates.iter().find(|c| c.meta.title.starts_with(t)).unwrap().links;
    assert_eq!(links("Physical activity"), 2);
    assert_eq!(links("Workplace and community"), 2);
    assert_eq!(links("Pedometers"), 1);
    // Most linked first: the optional screening order.
    assert_eq!(result.candidates[0].links, 2);
    // Requests are batched: one DOI lookup, one title, one batch of references, one of citing works.
    assert_eq!(*g.calls.borrow(), vec!["doi:1", "title", "ids:4", "cites:2"]);

    let preview = reviews.chase_preview(&id, &result).unwrap();
    assert_eq!((preview.found, preview.in_review, preview.new), (6, 1, 5), "cycling is already in the review");
    let (round, report) = reviews.chase_import(&id, &result, true, &owner, &NoLibrary).unwrap();
    assert_eq!(report.unwrap().added, 5);
    assert_eq!((round.round, round.new, round.seeds.len()), (1, 5, 2));
    let state = reviews.read(&id, |s, _| Ok(s.clone())).unwrap();
    let batch = state.batch(&round.batch_id).unwrap();
    assert_eq!((batch.kind.as_str(), batch.group.as_str(), batch.name.as_str()), ("other", "other", "Citation searching"));
    assert!(batch.strategy.contains("OpenAlex") && batch.strategy.contains("round 1") && batch.strategy.contains("Found 6, 1 already in the review, 5 new"), "{}", batch.strategy);
    // PRISMA counts them under other methods, and every box adds up.
    let p = crate::prisma::compute(&state);
    assert_eq!(p.other_methods.iter().find(|n| n.name == "Citation searching").map(|n| n.count), Some(5));
    crate::tests_records::assert_invariants(&p);
    // The facts std-A's checklist reads.
    let facts = conduct::reporting_facts(&state);
    assert_eq!(facts["citation"]["batches"][0]["direction"], "both");
    assert_eq!(facts["citation"]["batches"][0]["seeds"], 2);
    assert!(facts["citation"]["statement"].as_str().unwrap().contains("5 additional records"));

    // Round 2: no newly included study yet, the hint says to screen first.
    assert!(chasing::default_seeds(&state).is_empty());
    assert!(chasing::stop_hint(&state).unwrap().contains("Screen them"));
    // The same chase again finds nothing new: the stop hint.
    let again = chasing::chase(&seeds, Direction::Both, &graph(), &mut |_| true).unwrap();
    let (round2, report2) = reviews.chase_import(&id, &again, true, &owner, &NoLibrary).unwrap();
    assert!(report2.is_none());
    assert_eq!((round2.round, round2.new, round2.in_review), (2, 0, 6));
    let state = reviews.read(&id, |s, _| Ok(s.clone())).unwrap();
    assert!(chasing::stop_hint(&state).unwrap().contains("found nothing new"));
}

#[test]
fn chasing_falls_back_to_full_text_references_batches_and_cancels() {
    let (reviews, id, owner) = setup();
    let yoga = by_title(&reviews, &id, "Yoga");
    include(&reviews, &id, &owner, std::slice::from_ref(&yoga));
    let seeds: Vec<RecordMeta> = reviews.metas(&id, std::slice::from_ref(&yoga)).unwrap().into_values().collect();
    // Yoga is not in the graph: its own reference list (read from its PDF) is used.
    let mut g = graph();
    g.local.insert(yoga.clone(), vec![RecordMeta { title: "Spinal mobility in adults".into(), year: Some(2001), authors: vec!["Ng, Al".into()], ..Default::default() }]);
    let r = chasing::chase(&seeds, Direction::Backward, &g, &mut |_| true).unwrap();
    assert_eq!(r.seeds[0].via, "fulltext");
    assert_eq!(r.candidates.len(), 1);
    // 120 references go out in three requests of at most 50.
    let mut big = graph();
    let refs: Vec<String> = (0..120).map(|i| format!("W9{i:03}")).collect();
    big.works[0].references = refs.clone();
    for (i, w) in refs.iter().enumerate() {
        big.works.push(work(w, &format!("10.9999/many.{i}"), &format!("Reference number {i}"), 2000, "Doe, J", &[]));
    }
    let walk = reviews.metas(&id, &[by_title(&reviews, &id, "Walking")]).unwrap().into_values().collect::<Vec<_>>();
    let r = chasing::chase(&walk, Direction::Backward, &big, &mut |_| true).unwrap();
    assert_eq!(r.candidates.len(), 120);
    assert_eq!(big.calls.borrow().iter().filter(|c| c.starts_with("ids:")).count(), 3);
    // Cancelled between requests: stops with what it has.
    let mut n = 0;
    let r = chasing::chase(&walk, Direction::Backward, &big, &mut |_| {
        n += 1;
        n < 3
    })
    .unwrap();
    assert!(r.cancelled);
    assert_eq!(r.candidates.len(), 50);
}

#[test]
fn agreement_statistics_match_hand_computed_values() {
    // 2×2: TP 40, FP 20, FN 10, TN 130 (n = 200). Sensitivity 40/50 = 0.8, specificity
    // 130/150 = 0.8667, FNR 10/50 = 0.2. Cohen's kappa: po = 170/200 = 0.85; AI positive 60,
    // human positive 50: pe = 0.3·0.25 + 0.7·0.75 = 0.6; κ = (0.85 − 0.6)/(1 − 0.6) = 0.625.
    let mut pairs = Vec::new();
    for (ai, h, n) in [(true, true, 40), (true, false, 20), (false, true, 10), (false, false, 130)] {
        pairs.extend(std::iter::repeat_n((ai, h), n));
    }
    let c = ai_audit::confusion(&pairs);
    assert_eq!((c.tp, c.fp, c.fn_, c.tn, c.n), (40, 20, 10, 130, 200));
    assert!((c.sensitivity.unwrap() - 0.8).abs() < 1e-12);
    assert!((c.specificity.unwrap() - 130.0 / 150.0).abs() < 1e-12);
    assert!((c.false_negative_rate.unwrap() - 0.2).abs() < 1e-12);
    assert!((c.kappa.unwrap() - 0.625).abs() < 1e-12, "{:?}", c.kappa);
    assert!((c.percent.unwrap() - 85.0).abs() < 1e-9);

    // ICC(2,1): Shrout & Fleiss (1979), Table 2, six targets rated by four judges; the paper
    // gives ICC(2,1) = 0.29 (exactly 0.2898).
    let rows = vec![vec![9.0, 2.0, 5.0, 8.0], vec![6.0, 1.0, 3.0, 2.0], vec![8.0, 4.0, 6.0, 8.0], vec![7.0, 1.0, 2.0, 6.0], vec![10.0, 5.0, 6.0, 9.0], vec![6.0, 2.0, 4.0, 7.0]];
    let icc = xpilot::icc_2_1(&rows).unwrap();
    assert!((icc - 0.2898).abs() < 5e-4, "{icc}");
    assert_eq!(xpilot::icc_2_1(&[vec![3.0, 3.0], vec![3.0, 3.0]]), Some(1.0));
    // Mean absolute difference: |10−12| and |20−20| → (2 + 0)/2 = 1.
    assert_eq!(xpilot::mean_abs_diff(&[vec![10.0, 12.0], vec![20.0, 20.0]]), Some(1.0));
}

#[test]
fn audit_sizes_follow_the_maer_net_thresholds() {
    // Screening: the larger of 10 % or 100 records, never more than there are.
    assert_eq!(ai_audit::audit_size(500, 10.0, 100), 100);
    assert_eq!(ai_audit::audit_size(2000, 10.0, 100), 200);
    assert_eq!(ai_audit::audit_size(2001, 10.0, 100), 201, "10 % rounds up");
    assert_eq!(ai_audit::audit_size(60, 10.0, 100), 60);
    // Coding: the larger of 10 % or 20 studies.
    assert_eq!(ai_audit::audit_size(100, 10.0, 20), 20);
    assert_eq!(ai_audit::audit_size(300, 10.0, 20), 30);
    assert_eq!(ai_audit::audit_size(15, 10.0, 20), 15);
    assert_eq!(ai_audit::defaults("screening"), (10.0, 100));
    assert_eq!(ai_audit::defaults("extraction"), (10.0, 20));
}

fn ai_on(reviews: &Reviews, id: &str, owner: &str) {
    let mut p = reviews.read(id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.rules.ai_assist = true;
    reviews.save_protocol(id, p, "AI on", owner, false, &NoLibrary).unwrap();
}

#[test]
fn ai_suggestions_are_logged_compared_audited_blind_and_disclosed() {
    let (reviews, id, owner) = setup();
    ai_on(&reviews, &id, &owner);
    let call = CallInfo { provider: "custom".into(), provider_name: "Other (OpenAI-compatible)".into(), model: "mock-small".into(), model_reported: "mock-small-2026-10-01".into(), tokens_in: 400, tokens_out: 30 };
    let all: Vec<String> = reviews.read(&id, |s, _| Ok(s.records.iter().map(|r| r.id.clone()).collect())).unwrap();
    let request = |rid: &str| {
        let meta = reviews.metas(&id, &[rid.to_string()]).unwrap().remove(rid).unwrap();
        reviews.read(&id, |s, _| Ok(crate::ai::screening_request(&s.protocol, Stage::Ta, &meta))).unwrap()
    };
    // AI: include, include, exclude, exclude.
    for (rid, v) in all.iter().zip(["include", "include", "exclude", "exclude"]) {
        let s = crate::ai::parse_answer(&format!("{{\"decision\":\"{v}\",\"relevance\":0.7,\"rationale\":\"r\"}}"), "mock-small").unwrap();
        reviews.ai_log_screening(&id, rid, Stage::Ta, s, &request(rid), &call).unwrap();
    }
    let state = reviews.read(&id, |s, _| Ok(s.clone())).unwrap();
    assert_eq!(state.std_b.ai_log.len(), 4);
    assert_eq!(state.std_b.prompts.len(), 1, "the template text is stored once per version");
    let l = &state.std_b.ai_log[0];
    assert_eq!((l.model_reported.as_str(), l.prompt_id.as_str(), l.prompt_version.as_str()), ("mock-small-2026-10-01", "screening", "1"));
    assert_eq!(l.prompt_hash, ai_audit::template("screening").hash);
    assert_eq!(l.request_hash.len(), 64);
    assert!(l.scope.contains(&"abstract".to_string()));

    // An audit sample before anyone decides: blind to the AI.
    let audit = reviews.ai_audit_draw(&id, "screening", Stage::Ta, None, None, Some(7), &owner).unwrap();
    assert_eq!((audit.population, audit.target, audit.records.len()), (4, 4, 4), "max(10 %, 100) of 4 is all 4");
    let view = reviews.record_view(&id, &all[0], &owner, Stage::Ta, &NoLibrary).unwrap();
    assert_eq!(view["ai"], Json::Null);
    assert_eq!(view["aiBlind"], true);
    // The human: accepts two (include, exclude), rejects two.
    reviews.decide(&id, &[all[0].clone()], Stage::Ta, Choice::Include, vec![], "", "", vec![], &owner).unwrap();
    reviews.decide(&id, &[all[1].clone()], Stage::Ta, Choice::Exclude, vec![], "Other reason", "", vec![], &owner).unwrap();
    reviews.decide(&id, &[all[2].clone()], Stage::Ta, Choice::Include, vec![], "", "", vec![], &owner).unwrap();
    reviews.decide(&id, &[all[3].clone()], Stage::Ta, Choice::Exclude, vec![], "Other reason", "", vec![], &owner).unwrap();
    // Decided: the AI shows again.
    assert_ne!(reviews.record_view(&id, &all[0], &owner, Stage::Ta, &NoLibrary).unwrap()["ai"], Json::Null);
    let state = reviews.read(&id, |s, _| Ok(s.clone())).unwrap();
    let outcomes: Vec<&str> = state.std_b.ai_log.iter().map(|l| ai_audit::outcome(&state, l)).collect();
    assert_eq!(outcomes, vec!["accepted", "rejected", "rejected", "accepted"]);
    // TP 1 (0), FP 1 (1), FN 1 (2), TN 1 (3): sensitivity 0.5, FNR 0.5, κ 0.
    let c = ai_audit::screening_agreement(&state, Stage::Ta, None);
    assert_eq!((c.tp, c.fp, c.fn_, c.tn), (1, 1, 1, 1));
    assert_eq!(c.false_negative_rate, Some(0.5));
    assert!(c.kappa.unwrap().abs() < 1e-12);
    reviews.ai_audit_close(&id, &audit.id, &owner).unwrap();
    let state = reviews.read(&id, |s, _| Ok(s.clone())).unwrap();
    let (text, results) = ai_audit::statement(&state).unwrap();
    assert!(text.contains("mock-small (reported as mock-small-2026-10-01)") && text.contains("never made a decision"), "{text}");
    assert!(results.unwrap().contains("blind human audit of 4 records drawn at random from the 4"));
    let md = ai_audit::statement_markdown(&state);
    assert!(md.contains("## Appendix: prompts") && md.contains("SHA-256") && md.contains("You help a systematic reviewer screen records"));
    let facts = conduct::reporting_facts(&state);
    assert_eq!(facts["ai"]["used"], true);
    assert_eq!(facts["ai"]["stages"], json!(["title and abstract screening"]));
    // Extraction suggestions: per-field agreement after the human's values.
    let walk = by_title(&reviews, &id, "Walking");
    reviews.decide(&id, &[walk.clone()], Stage::Ft, Choice::Include, vec![], "", "", vec![], &owner).unwrap();
    let values = vec![crate::ai::Suggested { field: "n_total".into(), value: json!(240), quote: "".into(), page: None }, crate::ai::Suggested { field: "country".into(), value: json!("Kenya"), quote: "".into(), page: None }];
    reviews.ai_log_extraction(&id, &walk, "f-characteristics", &values, &json!({ "system": "s", "prompt": "p" }), &call, &["Abstract".into()]).unwrap();
    reviews.extract(&id, &walk, "f-characteristics", "n_total", json!("240"), "", None, None, None, true, false, &owner).unwrap();
    reviews.extract(&id, &walk, "f-characteristics", "country", json!("Uganda"), "", None, None, None, false, false, &owner).unwrap();
    let state = reviews.read(&id, |s, _| Ok(s.clone())).unwrap();
    let fields = ai_audit::extraction_agreement(&state, None);
    assert_eq!(fields.iter().map(|f| (f.field_id.as_str(), f.agree, f.n)).collect::<Vec<_>>(), vec![("country", 0, 1), ("n_total", 1, 1)]);
    let ex: Vec<&str> = state.std_b.ai_log.iter().filter(|l| l.task == "extraction").map(|l| ai_audit::outcome(&state, l)).collect();
    assert_eq!(ex, vec!["accepted", "changed"]);
    assert_eq!(state.std_b.prompts.len(), 2);
}

fn warning_ids(reviews: &Reviews, id: &str) -> Vec<String> {
    reviews.conduct(id, crate::events::now_ms()).unwrap()["warnings"].as_array().unwrap().iter().map(|w| w["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn conduct_checks_fire_on_synthetic_reviews_and_follow_the_review_type() {
    let (reviews, id, owner) = setup();
    let w = warning_ids(&reviews, &id);
    // One reviewer per stage, one database, no register, no grey literature.
    for c in ["dual-screening-ft", "dual-screening-ta", "two-databases", "registers", "grey-literature"] {
        assert!(w.contains(&c.to_string()), "{c} in {w:?}");
    }
    assert!(!w.contains(&"citation-searching".to_string()), "nothing included yet");
    assert!(!w.contains(&"screening-pilot".to_string()), "nothing screened yet");
    // Screening started with two people and no pilot round.
    let walk = by_title(&reviews, &id, "Walking");
    include(&reviews, &id, &owner, std::slice::from_ref(&walk));
    let w = warning_ids(&reviews, &id);
    for c in ["screening-pilot", "citation-searching", "retractions", "dual-extraction", "risk-of-bias"] {
        assert!(w.contains(&c.to_string()), "{c} in {w:?}");
    }
    // Rapid review: dual screening and citation searching are not expected.
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.rules.ft.reviewers = 2;
    p.rules.extractors = 2;
    let mut v = serde_json::to_value(&p).unwrap();
    v["plan"] = json!({ "reviewType": "rapid", "outcomes": [{ "name": "Blood pressure", "priority": "primary" }] });
    reviews.write(&id, |_, _, b| Ok((vec![b.event("protocol.set", &owner, None, json!({ "protocol": v, "note": "Rapid review", "amend": false }))], ()))).unwrap();
    let state = reviews.read(&id, |s, _| Ok(s.clone())).unwrap();
    assert_eq!(conduct::review_type(&state), "rapid");
    let w = warning_ids(&reviews, &id);
    assert!(!w.contains(&"citation-searching".to_string()) && !w.contains(&"dual-screening-ft".to_string()) && !w.contains(&"dual-extraction".to_string()), "{w:?}");
    assert!(w.contains(&"retractions".to_string()));
    // Extraction started without a pilot: form-pilot; an outcome the plan does not name.
    reviews.extract(&id, &walk, "f-characteristics", "country", json!("Chile"), "", None, None, None, false, false, &owner).unwrap();
    let w = warning_ids(&reviews, &id);
    assert!(!w.contains(&"form-pilot".to_string()), "rapid reviews skip the pilot check: {w:?}");
    let checks = |state: &crate::derive::State, now: i64, outcomes: &[String]| conduct::checks(state, now, outcomes).into_iter().map(|w| w.id).collect::<Vec<_>>();
    let state = reviews.read(&id, |s, _| Ok(s.clone())).unwrap();
    let c = checks(&state, crate::events::now_ms(), &["Blood pressure".into(), "Quality of life".into()]);
    assert!(c.contains(&"unplanned-outcomes".to_string()), "{c:?}");
    assert!(!checks(&state, crate::events::now_ms(), &["blood pressure".into()]).contains(&"unplanned-outcomes".to_string()));
    // Searches over a year old at analysis time (the import says 2026-01-10).
    let later = conduct::parse_date("2027-02-01").unwrap();
    assert!(checks(&state, later, &[]).contains(&"search-age".to_string()));
    assert!(!checks(&state, conduct::parse_date("2026-06-01").unwrap(), &[]).contains(&"search-age".to_string()));
    // The retraction check, recorded, clears its warning.
    let (targets, missing) = reviews.retraction_targets(&id).unwrap();
    assert_eq!((targets.len(), missing), (1, 0));
    reviews.record_retraction_check(&id, 1, 0, vec![], "Crossref and OpenAlex", &owner).unwrap();
    assert!(!warning_ids(&reviews, &id).contains(&"retractions".to_string()));
    // Dismissed with a reason: still listed, marked, and the reason is kept.
    assert!(reviews.conduct_dismiss(&id, "two-databases", "", true, &owner).is_err(), "a reason is required");
    reviews.conduct_dismiss(&id, "two-databases", "Only one database covers this field", true, &owner).unwrap();
    let all = reviews.conduct(&id, crate::events::now_ms()).unwrap();
    let reg = all["warnings"].as_array().unwrap().iter().find(|w| w["id"] == "two-databases").unwrap().clone();
    assert_eq!(reg["dismissed"]["reason"], "Only one database covers this field");
    reviews.conduct_dismiss(&id, "two-databases", "", false, &owner).unwrap();
    let all = reviews.conduct(&id, crate::events::now_ms()).unwrap();
    assert!(all["warnings"].as_array().unwrap().iter().find(|w| w["id"] == "two-databases").unwrap()["dismissed"].is_null());
    // Conflicts while extracting.
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.rules.ta.reviewers = 2;
    reviews.save_protocol(&id, p, "Two reviewers", &owner, false, &NoLibrary).unwrap();
    let yoga = by_title(&reviews, &id, "Yoga");
    reviews.decide(&id, &[yoga.clone()], Stage::Ta, Choice::Include, vec![], "", "", vec![], &owner).unwrap();
    reviews.decide(&id, &[yoga], Stage::Ta, Choice::Exclude, vec![], "Other reason", "", vec![], "b").unwrap();
    assert!(warning_ids(&reviews, &id).contains(&"conflicts".to_string()));
    // Every check has an entry in the table.
    for w in reviews.conduct(&id, crate::events::now_ms()).unwrap()["warnings"].as_array().unwrap() {
        assert!(conduct::CHECKS.iter().any(|(c, _)| *c == w["id"]), "{w}");
        assert!(w["link"].as_str().unwrap().starts_with("https://"));
    }
}

#[test]
fn extraction_pilot_agreement_and_contacts() {
    let (reviews, id, owner) = setup();
    let all: Vec<String> = reviews.read(&id, |s, _| Ok(s.records.iter().map(|r| r.id.clone()).collect())).unwrap();
    include(&reviews, &id, &owner, &all);
    assert!(reviews.xpilot_create(&id, 4, vec![owner.clone()], vec![], "", Some(3), &owner).is_err(), "two extractors");
    let p = reviews.xpilot_create(&id, 4, vec![owner.clone(), "b".into()], vec!["f-characteristics".into()], "", Some(3), &owner).unwrap();
    assert_eq!(p.records.len(), 4);
    // Design (choice): agree on 3 of 4. n_total (number): close values.
    let design = ["Cohort", "Cohort", "Cross-sectional", "Other"];
    let design_b = ["Cohort", "Cohort", "Cross-sectional", "Cohort"];
    let n_a = [100.0, 200.0, 300.0, 400.0];
    let n_b = [100.0, 210.0, 300.0, 390.0];
    for (i, r) in p.records.iter().enumerate() {
        reviews.extract(&id, r, "f-characteristics", "design", json!(design[i]), "", None, None, None, false, false, &owner).unwrap();
        reviews.extract(&id, r, "f-characteristics", "design", json!(design_b[i]), "", None, None, None, false, false, "b").unwrap();
        reviews.extract(&id, r, "f-characteristics", "n_total", json!(n_a[i]), "", None, None, None, false, false, &owner).unwrap();
        reviews.extract(&id, r, "f-characteristics", "n_total", json!(n_b[i]), "", None, None, None, false, false, "b").unwrap();
    }
    let state = reviews.read(&id, |s, _| Ok(s.clone())).unwrap();
    let forms: Vec<&Form> = state.protocol.forms.iter().collect();
    let fields = xpilot::field_agreement(&state, &forms, &p.records, &p.extractors);
    let d = fields.iter().find(|f| f.field_id == "design").unwrap();
    assert_eq!(d.n, 4);
    assert!((d.percent.unwrap() - 75.0).abs() < 1e-9);
    // Cohen: po = 0.75; A: Cohort 2, Cross 1, Other 1; B: Cohort 3, Cross 1 → pe = (2·3 + 1·1)/16 = 7/16;
    // κ = (0.75 − 0.4375)/(1 − 0.4375) = 0.5556.
    assert!((d.kappa.unwrap() - 0.3125 / 0.5625).abs() < 1e-9, "{:?}", d.kappa);
    let n = fields.iter().find(|f| f.field_id == "n_total").unwrap();
    assert!((n.percent.unwrap() - 50.0).abs() < 1e-9);
    assert_eq!(n.mean_abs_diff, Some(5.0));
    assert!(n.icc.unwrap() > 0.99);
    // Closing as piloted records the event; the conduct check is satisfied; a later form change shows.
    reviews.xpilot_close(&id, &p.id, true, &owner).unwrap();
    let state = reviews.read(&id, |s, _| Ok(s.clone())).unwrap();
    assert_eq!(state.std_b.piloted.len(), 1);
    assert_eq!(state.std_b.piloted[0].n, 4);
    assert!(!warning_ids(&reviews, &id).contains(&"form-pilot".to_string()));
    let facts = conduct::reporting_facts(&state);
    assert!(facts["extractionPilot"]["statement"].as_str().unwrap().contains("with 4 studies by 2 extractors"));
    let mut proto = state.protocol.clone();
    proto.forms[0].sections[0].fields.push(Field { id: "setting".into(), label: "Setting".into(), kind: "text".into(), ..Default::default() });
    reviews.save_protocol(&id, proto, "Added the setting after the pilot", &owner, false, &NoLibrary).unwrap();
    let report = reviews.xpilots(&id).unwrap();
    assert_eq!(report["pilots"][0]["changedSince"][0]["formId"], "f-characteristics");
    assert!(xpilot::pilot_markdown(&reviews.read(&id, |s, _| Ok(s.clone())).unwrap()).contains("| Study design | choice | 4 | 75 %"));

    // Contacts with authors.
    let c = xpilot::Contact { record_id: all[0].clone(), date: "2026-11-20".into(), person: "Corresponding author".into(), method: "email".into(), asked: "Standard deviations for the outcome".into(), ..Default::default() };
    assert!(reviews.contact_save(&id, xpilot::Contact { person: String::new(), ..c.clone() }, &owner).is_err());
    let saved = reviews.contact_save(&id, c, &owner).unwrap();
    assert_eq!(saved.status, "waiting");
    reviews.contact_save(&id, xpilot::Contact { reply: "Sent the table".into(), reply_date: "2026-11-25".into(), data_received: true, status: "replied".into(), ..saved.clone() }, &owner).unwrap();
    let state = reviews.read(&id, |s, _| Ok(s.clone())).unwrap();
    assert_eq!(state.std_b.contacts.len(), 1, "an edit replaces the entry");
    let facts = conduct::reporting_facts(&state);
    assert_eq!(facts["contacts"]["dataReceived"], 1);
    assert!(xpilot::contacts_csv(&state).contains("Sent the table"));
    let out = reviews.export(&id, "contacts", &owner).unwrap();
    assert!(out["filename"].as_str().unwrap().ends_with("contacts-with-authors.csv"));
    // Removing it.
    reviews.contact_save(&id, xpilot::Contact { deleted: true, ..saved }, &owner).unwrap();
    assert!(reviews.read(&id, |s, _| Ok(s.std_b.contacts.is_empty())).unwrap());
}

#[test]
fn dates_round_trip() {
    assert_eq!(conduct::iso_date(0), "1970-01-01");
    let d = conduct::parse_date("2026-11-27").unwrap();
    assert_eq!(conduct::iso_date(d), "2026-11-27");
    assert_eq!(conduct::iso_date(conduct::parse_date("2024-02-29").unwrap()), "2024-02-29");
    assert_eq!(conduct::parse_date("1700000000000"), Some(1_700_000_000_000));
}
