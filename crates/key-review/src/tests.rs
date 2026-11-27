// A review from import to meta-analysis, with invented records.
use crate::derive::{Share, State};
use crate::model::*;
use crate::views::ListQuery;
use crate::{NoLibrary, Reviews};
use serde_json::{Value as Json, json};
use std::time::Instant;

const RIS: &str = "TY  - JOUR\nTI  - Walking groups and blood pressure in older adults\nAU  - Rivera, Ana\nPY  - 2016\nDO  - 10.9999/walk.1\nAB  - A randomised trial of walking groups.\nER  - \n\
TY  - JOUR\nTI  - Walking groups and blood pressure in older adults\nAU  - Rivera, Ana\nPY  - 2016\nDO  - 10.9999/walk.1\nAB  - Same record from a second database.\nER  - \n\
TY  - JOUR\nTI  - Stretching at work: a cluster trial\nAU  - Okafor, Ben\nPY  - 2019\nDO  - 10.9999/stretch.2\nAB  - Office workers stretched.\nER  - \n\
TY  - JOUR\nTI  - An old survey of exercise habits\nAU  - Lind, Cara\nPY  - 1987\nAB  - A survey.\nER  - \n\
TY  - JOUR\nTI  - Cycling to school and fitness\nAU  - Haas, Dev\nPY  - 2021\nDO  - 10.9999/cycle.4\nAB  - Children cycled.\nER  - \n\
TY  - JOUR\nTI  - Yoga for back pain: a randomised trial\nAU  - Moreau, Eli\nPY  - 2018\nDO  - 10.9999/yoga.5\nAB  - Adults did yoga.\nER  - \n";

fn setup() -> (Reviews, String, String, String, String) {
    let reviews = Reviews::in_memory().unwrap();
    let (id, owner) = reviews.create("Movement and health", "Ana", None).unwrap();
    let team = vec![
        Member { id: owner.clone(), name: "Ana".into(), roles: vec!["owner".into(), "reviewer".into()], initials: "A".into() },
        Member { id: "b".into(), name: "Ben".into(), roles: vec!["reviewer".into()], initials: "B".into() },
        Member { id: "c".into(), name: "Cara".into(), roles: vec!["tiebreaker".into()], initials: "C".into() },
    ];
    reviews.save_team(&id, team, &owner).unwrap();
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.rules.ta.reviewers = 2;
    p.rules.ft.reviewers = 1;
    p.rules.conflicts = "third".into();
    p.criteria = crate::templates::suggested_criteria(&p.question);
    reviews.save_protocol(&id, p, "", &owner, false, &NoLibrary).unwrap();
    (reviews, id, owner, "b".into(), "c".into())
}

fn ids(reviews: &Reviews, id: &str) -> Vec<String> {
    reviews.read(id, |s, _| Ok(s.records.iter().filter(|r| s.active(r)).map(|r| r.id.clone()).collect())).unwrap()
}

fn import_ris(reviews: &Reviews, id: &str, owner: &str) -> crate::ops::ImportReport {
    let parsed = crate::import::parse_file(RIS, Some("search.ris")).unwrap();
    let batch = Batch { kind: "file".into(), group: "databases".into(), name: "Example database".into(), file_name: "search.ris".into(), strategy: "walking OR cycling".into(), ..Default::default() };
    reviews.import(id, batch, parsed.records, owner, &NoLibrary).unwrap()
}

#[test]
fn screening_workflow_with_blind_conflicts_and_resolution() {
    let (reviews, id, a, b, c) = setup();
    let report = import_ris(&reviews, &id, &a);
    assert_eq!(report.added, 6);
    assert_eq!(report.duplicates, 1);
    let records = ids(&reviews, &id);
    assert_eq!(records.len(), 5);
    let first = &records[0];

    // Ana includes, Ben has not decided: blind, so Ben sees nothing of Ana's.
    reviews.decide(&id, &[first.clone()], Stage::Ta, Choice::Include, vec![], "", vec![], &a).unwrap();
    let seen = reviews.record_view(&id, first, &b, Stage::Ta, &NoLibrary).unwrap();
    assert_eq!(seen["others"], json!([]));
    assert_eq!(seen["status"]["name"], "partial");
    // Ben excludes: a conflict, now visible to both.
    reviews.decide(&id, &[first.clone()], Stage::Ta, Choice::Exclude, vec![], "", vec![], &b).unwrap();
    let seen = reviews.record_view(&id, first, &b, Stage::Ta, &NoLibrary).unwrap();
    assert_eq!(seen["status"]["name"], "conflict");
    assert_eq!(seen["others"].as_array().unwrap().len(), 1);
    // Only the tie-breaker (or owner) resolves under "third".
    assert!(reviews.resolve(&id, first, Stage::Ta, Choice::Include, vec![], "", &b).is_err());
    reviews.resolve(&id, first, Stage::Ta, Choice::Include, vec![], "Agreed in meeting", &c).unwrap();
    let s = reviews.summary(&id, &a).unwrap();
    assert_eq!(s["stages"]["ta"]["included"], 1);
    assert_eq!(s["stages"]["ft"]["eligible"], 1);

    // The queue for Ben skips what he decided; undo brings his last decision back.
    let queue = reviews.queue(&id, &b, Stage::Ta, "").unwrap();
    assert_eq!(queue.len(), 4);
    reviews.decide(&id, &[records[1].clone()], Stage::Ta, Choice::Maybe, vec![], "", vec![], &b).unwrap();
    assert_eq!(reviews.queue(&id, &b, Stage::Ta, "").unwrap().len(), 3);
    let undone = reviews.undo(&id, &b).unwrap().unwrap();
    assert_eq!(&undone.0, &records[1]);
    assert_eq!(reviews.queue(&id, &b, Stage::Ta, "").unwrap().len(), 4);

    // Rules: Maybe off at full text; excluding names the one criterion it fails.
    let ft = reviews.decide(&id, &[first.clone()], Stage::Ft, Choice::Exclude, vec![], "", vec![], &a);
    assert!(ft.unwrap_err().contains("criterion it fails"));
    assert!(reviews.decide(&id, &[first.clone()], Stage::Ft, Choice::Exclude, vec!["no-such".into()], "", vec![], &a).is_err());
    assert!(reviews.decide(&id, &[first.clone()], Stage::Ft, Choice::Maybe, vec![], "", vec![], &a).is_err());
    reviews.decide(&id, &[first.clone()], Stage::Ft, Choice::Exclude, vec!["c-population".into()], "", vec![], &a).unwrap();
    let view = reviews.record_view(&id, first, &a, Stage::Ft, &NoLibrary).unwrap();
    assert_eq!(view["mine"]["reasons"], json!(["c-population"]));

    let list = reviews.list(&id, &a, &ListQuery { stage: Some(Stage::Ta), filter: "conflicts".into(), ..Default::default() }, &NoLibrary).unwrap();
    assert_eq!(list["total"], 0);
    let list = reviews.list(&id, &a, &ListQuery { stage: Some(Stage::Ta), text: "yoga".into(), ..Default::default() }, &NoLibrary).unwrap();
    assert_eq!(list["total"], 1);
}

#[test]
fn versions_linked_rules_and_prisma() {
    let (reviews, id, a, b, _) = setup();
    import_ris(&reviews, &id, &a);
    let records = ids(&reviews, &id);
    for r in &records {
        for who in [&a, &b] {
            reviews.decide(&id, &[r.clone()], Stage::Ta, Choice::Include, vec![], "", vec![], who).unwrap();
        }
    }
    // A change after decisions needs a note and makes version 3 (1 created, 2 our rules).
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.criteria.push(Criterion {
        id: "c-year".into(),
        label: "Published 2000 or later".into(),
        reason: "Published before 2000".into(),
        stages: vec![Stage::Ta],
        link: Some(MetadataLink { conditions: vec![Condition { field: "year".into(), op: "ge".into(), value: json!(2000) }], all: true, effect: "suggest".into(), fails_when: false }),
        ..Default::default()
    });
    assert!(reviews.save_protocol(&id, p.clone(), "", &a, true, &NoLibrary).is_err());
    let impact = reviews.protocol_impact(&id, &p, &NoLibrary).unwrap();
    assert!(impact.new_version);
    let saved = reviews.save_protocol(&id, p, "Added a year limit", &a, true, &NoLibrary).unwrap();
    assert!(saved.new_version);
    assert_eq!(saved.number, 2);
    // Every decided record is flagged (a criterion was added), at title/abstract.
    assert_eq!(saved.flagged, 5);
    let view = reviews.record_view(&id, &records[2], &a, Stage::Ta, &NoLibrary).unwrap();
    assert_eq!(view["suggestions"][0]["rule"], "Not met: Year is 2000 or later");
    assert_eq!(view["flagged"], true);
    // Deciding again clears the flag; the decision records version 2.
    reviews.decide(&id, &[records[2].clone()], Stage::Ta, Choice::Exclude, vec![], "", vec![], &a).unwrap();
    let view = reviews.record_view(&id, &records[2], &a, Stage::Ta, &NoLibrary).unwrap();
    assert_eq!(view["flagged"], false);
    assert_eq!(view["mine"]["versionNumber"], 2);
    reviews.decide(&id, &[records[2].clone()], Stage::Ta, Choice::Exclude, vec![], "", vec![], &b).unwrap();

    // Records identified by other methods, one duplicate of the first database.
    let other = crate::import::parse_file("TY  - JOUR\nTI  - Yoga for back pain: a randomised trial\nAU  - Moreau, Eli\nPY  - 2018\nDO  - 10.9999/yoga.5\nER  - \nTY  - JOUR\nTI  - Dancing and balance\nAU  - Ito, Fay\nPY  - 2020\nER  - \n", None).unwrap();
    reviews.import(&id, Batch { kind: "other".into(), group: "other".into(), name: "Citation searching".into(), ..Default::default() }, other.records, &a, &NoLibrary).unwrap();

    // An automatic rule: records before 1990 are excluded by "rules", counted as automation.
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.criteria.push(Criterion {
        id: "c-old".into(),
        label: "Published 1990 or later".into(),
        stages: vec![Stage::Ta],
        link: Some(MetadataLink { conditions: vec![Condition { field: "year".into(), op: "ge".into(), value: json!(1990) }], all: true, effect: "auto".into(), fails_when: false }),
        ..Default::default()
    });
    // The 1987 survey is decided already, so the rule does not touch it; a new old record gets it.
    reviews.save_protocol(&id, p, "Automatic exclusion before 1990", &a, false, &NoLibrary).unwrap();
    let old = crate::import::parse_file("TY  - JOUR\nTI  - Exercise in 1970s factories\nAU  - Berg, Gus\nPY  - 1975\nER  - \n", None).unwrap();
    let report = reviews.import(&id, Batch { kind: "file".into(), group: "databases".into(), name: "Second database".into(), ..Default::default() }, old.records, &a, &NoLibrary).unwrap();
    assert_eq!(report.auto_excluded, 1);

    // Full text for the included ones: one not retrieved, one excluded with a reason, the rest included.
    let ft: Vec<String> = reviews.read(&id, |s, _| Ok(s.records.iter().filter(|r| s.eligible(r, Stage::Ft)).map(|r| r.id.clone()).collect())).unwrap();
    assert_eq!(ft.len(), 4);
    assert!(reviews.fulltext(&id, &ft[0], Some("notRetrieved"), None, None, &a).is_err());
    reviews.fulltext(&id, &ft[0], Some("notRetrieved"), Some("Not available from the library"), None, &a).unwrap();
    reviews.decide(&id, &[ft[1].clone()], Stage::Ft, Choice::Exclude, vec!["c-design".into()], "", vec![], &a).unwrap();
    for r in &ft[2..] {
        reviews.decide(&id, &[r.clone()], Stage::Ft, Choice::Include, vec![], "", vec![], &a).unwrap();
    }
    let p = reviews.prisma(&id).unwrap();
    assert_eq!(p.identified, 7, "{p:?}");
    assert_eq!(p.databases.len(), 2);
    // The citation-searching duplicate is removed too, but PRISMA counts duplicates in the databases column only.
    assert_eq!(p.duplicates, 1);
    assert_eq!(p.automation, 1);
    assert_eq!(p.screened, 5);
    assert_eq!(p.screening_excluded, 1);
    assert_eq!(p.main.sought, 4);
    assert_eq!(p.main.not_retrieved, 1);
    assert_eq!(p.main.assessed, 3);
    assert_eq!(p.main.excluded_reasons[0].name, "Wrong study design");
    assert_eq!(p.main.included, 2);
    assert_eq!(p.other.identified, 2);
    assert_eq!(p.studies_included, 2);
    assert!(crate::prisma::csv(&p).contains("Records screened,5"));

    // The log replays to the same state: export, import into another store.
    let file = reviews.export(&id, "review", &a).unwrap();
    let other = Reviews::in_memory().unwrap();
    let out = other.import_review_file(file["content"].as_str().unwrap()).unwrap();
    assert_eq!(out["reviewId"], json!(id));
    assert_eq!(other.prisma(&id).unwrap(), p);
    // Importing again adds nothing.
    assert_eq!(other.import_review_file(file["content"].as_str().unwrap()).unwrap()["added"], 0);
    for kind in ["screening", "audit", "prisma", "template", "extraction", "extraction-long", "outcomes", "revman"] {
        assert!(!reviews.export(&id, kind, &a).unwrap()["content"].as_str().unwrap().is_empty(), "{kind}");
    }
    let template = reviews.export(&id, "template", &a).unwrap();
    let t = crate::export::read_template(template["content"].as_str().unwrap()).unwrap();
    assert_eq!(t.criteria.len(), 12, "ten suggested and two added");
}

#[test]
fn concurrent_devices_merge_without_conflict() {
    let (reviews, id, a, b, _) = setup();
    import_ris(&reviews, &id, &a);
    let file = reviews.export(&id, "review", &a).unwrap();
    // A second device starts from the same log, then both screen independently.
    let laptop = Reviews::in_memory().unwrap();
    laptop.import_review_file(file["content"].as_str().unwrap()).unwrap();
    let records = ids(&reviews, &id);
    reviews.decide(&id, &[records[0].clone()], Stage::Ta, Choice::Include, vec![], "", vec![], &a).unwrap();
    laptop.decide(&id, &[records[0].clone()], Stage::Ta, Choice::Include, vec![], "", vec![], &b).unwrap();
    laptop.note(&id, &records[1], "Check the population", None, &b).unwrap();
    let from_laptop = laptop.events(&id).unwrap();
    let from_desk = reviews.events(&id).unwrap();
    reviews.merge(from_laptop).unwrap();
    laptop.merge(from_desk).unwrap();
    let a_state = State::replay(&id, reviews.events(&id).unwrap().iter());
    let b_state = State::replay(&id, laptop.events(&id).unwrap().iter());
    assert_eq!(a_state.events, b_state.events);
    for (x, y) in a_state.records.iter().zip(&b_state.records) {
        assert_eq!(a_state.status(x, Stage::Ta), b_state.status(y, Stage::Ta));
    }
    assert_eq!(reviews.summary(&id, &a).unwrap()["stages"]["ta"]["included"], 1);
}

#[test]
fn pilots_assignment_and_agreement() {
    let (reviews, id, a, b, _) = setup();
    import_ris(&reviews, &id, &a);
    let pilot = reviews.pilot_create(&id, Stage::Ta, 4, vec![a.clone(), b.clone()], "", Some(7), &a).unwrap();
    assert_eq!(pilot.records.len(), 4);
    for (i, r) in pilot.records.iter().enumerate() {
        reviews.decide(&id, &[r.clone()], Stage::Ta, Choice::Include, vec![], "", vec![], &a).unwrap();
        let v = if i == 0 { Choice::Exclude } else { Choice::Include };
        reviews.decide(&id, &[r.clone()], Stage::Ta, v, vec![], "", vec![], &b).unwrap();
    }
    let ag = reviews.agreement(&id, Stage::Ta, Some(&pilot.id)).unwrap();
    assert_eq!(ag["overall"]["n"], 4);
    assert!((ag["overall"]["percent"].as_f64().unwrap() - 75.0).abs() < 1e-9);
    assert_eq!(ag["disagreements"].as_array().unwrap().len(), 1);
    reviews.pilot_set_open(&id, &pilot.id, false, &a).unwrap();
    // Split the rest: everything left goes to exactly one reviewer, with all double-screened.
    let split = reviews.assign(&id, Stage::Ta, "split", vec![Share { id: a.clone(), share: 1.0 }, Share { id: b.clone(), share: 1.0 }], 1.0, Some(3), &a).unwrap();
    assert_eq!(split.snapshot.len(), 1);
    assert!(split.snapshot.values().all(|v| v.len() == 2));
    let half = reviews.assign(&id, Stage::Ta, "split", vec![Share { id: a.clone(), share: 3.0 }, Share { id: b.clone(), share: 1.0 }], 0.0, Some(3), &a).unwrap();
    assert!(half.snapshot.values().all(|v| v.len() == 1));
}

#[test]
fn extraction_and_meta_analysis_from_extracted_outcomes() {
    let (reviews, id, a, _, _) = setup();
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.rules.ta.reviewers = 1;
    p.forms.push(crate::templates::outcomes_form());
    reviews.save_protocol(&id, p, "", &a, false, &NoLibrary).unwrap();
    import_ris(&reviews, &id, &a);
    let records = ids(&reviews, &id);
    // Three BCG trials (metafor's dat.bcg rows 1–3) as extracted outcome data.
    let data = [(4., 123., 11., 139.), (6., 306., 29., 303.), (3., 231., 11., 220.)];
    for (r, (e1, n1, e2, n2)) in records.iter().zip(data) {
        reviews.decide(&id, &[r.clone()], Stage::Ta, Choice::Include, vec![], "", vec![], &a).unwrap();
        reviews.decide(&id, &[r.clone()], Stage::Ft, Choice::Include, vec![], "", vec![], &a).unwrap();
        let row = json!([{ "outcome": "Tuberculosis", "type": "Dichotomous", "e1": e1, "n1": n1, "e2": e2, "n2": n2 }]);
        // The outcomes table asks for a quote.
        assert!(reviews.extract(&id, r, "f-outcomes", "outcomes", row.clone(), "", None, None, false, false, &a).is_err());
        reviews.extract(&id, r, "f-outcomes", "outcomes", row, "Table 2", Some(4), None, false, false, &a).unwrap();
    }
    let choices = reviews.outcome_choices(&id).unwrap();
    assert_eq!(choices.len(), 1);
    assert_eq!(choices[0].studies, 3);
    let request = crate::export::AnalysisRequest { outcome: "Tuberculosis".into(), timepoint: None, options: crate::meta::Options { measure: crate::meta::Measure::RR, method: crate::meta::Method::Dl, hartung_knapp: false, level: 0.95 }, subgroups: false };
    let out = reviews.analyse(&id, &request).unwrap();
    // rma(ai=tpos, bi=tneg, ci=cpos, di=cneg, data=dat.bcg[1:3,], measure="RR", method="DL")
    let est = out["analysis"]["main"]["estimate"].as_f64().unwrap();
    assert!((est - -1.33023414924).abs() < 1e-9, "{est}");
    let csv = reviews.export(&id, "outcomes", &a).unwrap();
    assert!(csv["content"].as_str().unwrap().contains("Tuberculosis"));
    let view = reviews.extraction_view(&id, &records[0], &a).unwrap();
    assert_eq!(view["values"]["f-outcomes/outcomes"]["mine"]["quote"], "Table 2");
}

/// A varied invented title (real titles share few words; identical templates would make every
/// record a near-duplicate of every other).
fn invented_title(i: usize) -> String {
    const SYLLABLES: [&str; 16] = ["ka", "lo", "mi", "ne", "ru", "sa", "ti", "vo", "ber", "dan", "fel", "gor", "hul", "jin", "mar", "pex"];
    let mut rng = crate::events::Rng::new(i as u64 + 1);
    let words: Vec<String> = (0..8).map(|_| (0..3).map(|_| SYLLABLES[rng.below(16)]).collect::<String>()).collect();
    format!("{} topic {}", words.join(" "), i % 97)
}

/// Screening stays instant at 20,000 records: replaying the log, the summary, a list page, the
/// queue and one record. Times are printed; limits leave room for a debug build.
#[test]
fn perf_twenty_thousand_records() {
    let reviews = Reviews::in_memory().unwrap();
    let (id, a) = reviews.create("Large review", "Ana", None).unwrap();
    let n = 20_000;
    let records: Vec<RecordMeta> = (0..n)
        .map(|i| RecordMeta {
            id: crate::events::uuid7(),
            title: invented_title(i),
            abstract_text: "An invented abstract about movement, health and many other words that make it long enough to be realistic. ".repeat(4),
            authors: vec![format!("Author{i}, A."), "Second, B.".into()],
            year: Some(1980 + (i % 45) as i64),
            doi: format!("10.9999/inv.{i}"),
            ..Default::default()
        })
        .collect();
    let t = Instant::now();
    reviews.import(&id, Batch { kind: "file".into(), group: "databases".into(), name: "Big database".into(), ..Default::default() }, records, &a, &NoLibrary).unwrap();
    let import_ms = t.elapsed().as_millis();
    let all = ids(&reviews, &id);
    let t = Instant::now();
    for r in all.iter().take(5000) {
        reviews.decide(&id, &[r.clone()], Stage::Ta, Choice::Exclude, vec![], "", vec![], &a).unwrap();
    }
    let decide_ms = t.elapsed().as_millis();
    let events = reviews.events(&id).unwrap();
    let t = Instant::now();
    let state = State::replay(&id, events.iter());
    let replay_ms = t.elapsed().as_millis();
    assert_eq!(state.records.len(), n);
    let t = Instant::now();
    let summary = reviews.summary(&id, &a).unwrap();
    let summary_ms = t.elapsed().as_millis();
    assert_eq!(summary["stages"]["ta"]["excluded"], 5000);
    let t = Instant::now();
    let page = reviews.list(&id, &a, &ListQuery { stage: Some(Stage::Ta), filter: "mine".into(), limit: 100, ..Default::default() }, &NoLibrary).unwrap();
    let list_ms = t.elapsed().as_millis();
    assert_eq!(page["total"], 15000);
    let t = Instant::now();
    let found = reviews.list(&id, &a, &ListQuery { stage: Some(Stage::Ta), text: "topic 42".into(), limit: 100, ..Default::default() }, &NoLibrary).unwrap();
    let search_ms = t.elapsed().as_millis();
    assert!(found["total"].as_u64().unwrap() > 100);
    let t = Instant::now();
    let queue = reviews.queue(&id, &a, Stage::Ta, "").unwrap();
    let queue_ms = t.elapsed().as_millis();
    assert_eq!(queue.len(), 15000);
    let t = Instant::now();
    let view: Json = reviews.record_view(&id, &queue[0], &a, Stage::Ta, &NoLibrary).unwrap();
    reviews.decide(&id, &[queue[0].clone()], Stage::Ta, Choice::Include, vec![], "", vec![], &a).unwrap();
    let record_ms = t.elapsed().as_millis();
    assert!(view["meta"]["title"].as_str().is_some());
    eprintln!("20k records: import {import_ms} ms, 5000 decisions {decide_ms} ms, replay {replay_ms} ms, summary {summary_ms} ms, list {list_ms} ms, search {search_ms} ms, queue {queue_ms} ms, record+decide {record_ms} ms");
    assert!(record_ms < 250, "one record and a decision took {record_ms} ms");
    assert!(list_ms < 1000 && queue_ms < 1000 && summary_ms < 1500 && replay_ms < 5000);
}

#[test]
fn a_stricter_rule_applies_from_then_on() {
    let reviews = Reviews::in_memory().unwrap();
    let (id, a) = reviews.create("Solo then dual", "Ana", None).unwrap();
    let parsed = crate::import::parse_file(RIS, None).unwrap();
    reviews.import(&id, Batch { kind: "file".into(), group: "databases".into(), name: "Db".into(), ..Default::default() }, parsed.records, &a, &NoLibrary).unwrap();
    let records = ids(&reviews, &id);
    reviews.decide(&id, &[records[0].clone()], Stage::Ta, Choice::Include, vec![], "", vec![], &a).unwrap();
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.rules.ta.reviewers = 2;
    reviews.save_protocol(&id, p, "Two reviewers from now on", &a, false, &NoLibrary).unwrap();
    reviews.decide(&id, &[records[1].clone()], Stage::Ta, Choice::Include, vec![], "", vec![], &a).unwrap();
    let s = reviews.summary(&id, &a).unwrap();
    // The record decided under version 1 stays included; the one decided under version 2 waits.
    assert_eq!(s["stages"]["ta"]["included"], 1);
    assert_eq!(s["stages"]["ta"]["partial"], 1);
}


/// A review written before criteria and reasons were one list: its reasons become criteria (the
/// one a criterion named collapses into it), old decisions resolve to the criteria, PRISMA counts
/// the same reasons, and the migration is recorded once as an event, not by rewriting history.
#[test]
fn old_reviews_merge_reasons_into_criteria() {
    let review = "0190a000-0000-7000-8000-000000000001";
    let ev = |n: u64, kind: &str, actor: &str, record: Option<&str>, payload: Json| -> Json {
        json!({ "id": format!("0190a000-0000-7000-8000-{n:012}"), "reviewId": review, "at": 1_700_000_000_000u64 + n, "actor": actor, "device": "old", "kind": kind, "version": "0190a000-0000-7000-8000-000000000003", "recordId": record, "payload": payload })
    };
    let old_protocol = json!({
        "rules": { "ta": { "reviewers": 1, "reasons": "none", "maybe": true }, "ft": { "reviewers": 1, "reasons": "one", "maybe": false }, "blind": true, "conflicts": "consensus", "extractors": 1, "suggestions": true },
        "criteria": [
            { "id": "c-animal", "kind": "exclude", "label": "Animal studies", "stages": ["ta", "ft"], "reasonId": "r-population" },
            { "id": "c-rct", "kind": "include", "label": "Randomised controlled trial", "stages": ["ta", "ft"] }
        ],
        "reasons": [
            { "id": "r-design", "label": "Wrong study design" },
            { "id": "r-population", "label": "Wrong population" },
            { "id": "r-custom", "label": "Not in English" }
        ]
    });
    let records = json!([{ "id": "rec-1", "title": "Mice on wheels" }, { "id": "rec-2", "title": "A cohort of walkers" }, { "id": "rec-3", "title": "Un essai" }]);
    let mut events = vec![
        ev(1, "review.create", "m1", None, json!({ "name": "Old review" })),
        ev(2, "team.set", "m1", None, json!({ "members": [{ "id": "m1", "name": "Ana", "roles": ["owner", "reviewer"] }] })),
        ev(3, "protocol.set", "m1", None, json!({ "protocol": old_protocol, "note": "Created" })),
        ev(4, "batch.add", "m1", None, json!({ "batch": { "id": "b1", "kind": "file", "group": "databases", "name": "Db", "count": 3 } })),
        ev(5, "records.add", "system", None, json!({ "batchId": "b1", "records": records })),
    ];
    for (n, rec) in ["rec-1", "rec-2", "rec-3"].iter().enumerate() {
        events.push(ev(10 + n as u64, "decision", "m1", Some(rec), json!({ "stage": "ta", "value": "include", "reasons": [] })));
    }
    events.push(ev(20, "decision", "m1", Some("rec-1"), json!({ "stage": "ft", "value": "exclude", "reasons": ["r-population"] })));
    events.push(ev(21, "decision", "m1", Some("rec-2"), json!({ "stage": "ft", "value": "exclude", "reasons": ["r-design"] })));
    events.push(ev(22, "decision", "m1", Some("rec-3"), json!({ "stage": "ft", "value": "exclude", "reasons": ["r-custom"] })));
    let file = json!({ "format": "key-review", "version": 1, "events": events }).to_string();
    let reviews = Reviews::in_memory().unwrap();
    reviews.import_review_file(&file).unwrap();
    let protocol = reviews.read(review, |s, _| Ok(s.protocol.clone())).unwrap();
    assert!(protocol.reasons.is_empty());
    let order: Vec<&str> = protocol.criteria.iter().map(|c| c.id.as_str()).collect();
    // The old reasons' order is the hierarchy: design, then the animal criterion (it gave
    // "Wrong population"), then the custom reason; the RCT criterion gave no reason and comes last.
    assert_eq!(order, ["c-design", "c-animal", "c-custom", "c-rct"]);
    let animal = protocol.criterion("c-animal").unwrap();
    assert_eq!(animal.label, "Not animal studies");
    assert_eq!(animal.reason_text(), "Wrong population");
    assert_eq!(animal.element, "population");
    assert_eq!(protocol.criterion("c-custom").unwrap().reason_text(), "Not in English");
    assert_eq!(protocol.criterion("c-rct").unwrap().reason_text(), "Not met: randomised controlled trial");
    // PRISMA counts by the same wording as before.
    let p = reviews.prisma(review).unwrap();
    let names: Vec<(String, usize)> = p.main.excluded_reasons.iter().map(|n| (n.name.clone(), n.count)).collect();
    assert_eq!(names, [("Wrong study design".to_string(), 1), ("Wrong population".to_string(), 1), ("Not in English".to_string(), 1)]);
    // Old decisions name the criteria now.
    let view = reviews.record_view(review, "rec-1", "m1", Stage::Ft, &NoLibrary).unwrap();
    assert_eq!(view["mine"]["reasons"], json!(["c-animal"]));
    // The migration is two events (an alias map and an amended protocol), written once.
    let logged = reviews.events(review).unwrap();
    assert_eq!(logged.iter().filter(|e| e.kind == "criteria.alias").count(), 1);
    assert_eq!(logged.len(), events.len() + 2);
    assert_eq!(reviews.summary(review, "m1").unwrap()["versionNumber"], 1);
    let again = Reviews::in_memory().unwrap();
    again.import_review_file(&reviews.export(review, "review", "m1").unwrap()["content"].as_str().unwrap().to_string()).unwrap();
    assert_eq!(again.events(review).unwrap().len(), logged.len());
    assert_eq!(again.prisma(review).unwrap(), p);
    // Picking a criterion as the reason works on the migrated review.
    reviews.decide(review, &["rec-3".into()], Stage::Ft, Choice::Exclude, vec!["c-design".into()], "", vec![], "m1").unwrap();
    assert_eq!(reviews.prisma(review).unwrap().main.excluded_reasons[0].count, 2);
    // An old template reads the same way, and a new one round-trips.
    let old_template = json!({ "format": "key-review-template", "version": 1, "protocol": old_protocol }).to_string();
    let t = crate::export::read_template(&old_template).unwrap();
    assert_eq!(t.criteria.len(), 4);
    let text = crate::export::template_json(&t).unwrap();
    assert!(!text.contains("\"reasons\": ["), "no separate reasons list is written");
    assert_eq!(crate::export::read_template(&text).unwrap().criteria, t.criteria);
}

#[test]
fn different_criteria_are_not_a_conflict() {
    let (reviews, id, a, b, _) = setup();
    import_ris(&reviews, &id, &a);
    let r = ids(&reviews, &id)[0].clone();
    for who in [&a, &b] {
        reviews.decide(&id, &[r.clone()], Stage::Ta, Choice::Include, vec![], "", vec![], who).unwrap();
    }
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.rules.ft.reviewers = 2;
    reviews.save_protocol(&id, p, "Two reviewers at full text", &a, false, &NoLibrary).unwrap();
    reviews.decide(&id, &[r.clone()], Stage::Ft, Choice::Exclude, vec!["c-population".into()], "", vec![], &a).unwrap();
    reviews.decide(&id, &[r.clone()], Stage::Ft, Choice::Exclude, vec!["c-design".into()], "", vec![], &b).unwrap();
    let view = reviews.record_view(&id, &r, &a, Stage::Ft, &NoLibrary).unwrap();
    assert_eq!(view["status"]["name"], "excluded");
    assert_eq!(view["reasonsDiffer"], true);
    // PRISMA reports the criterion highest in the list.
    assert_eq!(reviews.prisma(&id).unwrap().main.excluded_reasons[0].name, "Wrong population");
}
