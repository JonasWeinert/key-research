// std-A: the reporting rules on small invented reviews: PRISMA 2020 checklist statuses and
// drafts, the protocol's registration lock and deviations log, the PRISMA-S report.
use crate::checklist::{Item, compute};
use crate::model::*;
use crate::reporting::Registration;
use crate::{NoLibrary, Reviews};
use serde_json::{Value as Json, json};
use std::collections::HashMap;

const RIS: &str = "TY  - JOUR\nTI  - Walking groups and blood pressure\nAU  - Rivera, Ana\nPY  - 2016\nDO  - 10.9999/w.1\nAB  - A trial.\nER  - \n\
TY  - JOUR\nTI  - Walking groups and blood pressure\nAU  - Rivera, Ana\nPY  - 2016\nDO  - 10.9999/w.1\nAB  - Again.\nER  - \n\
TY  - JOUR\nTI  - Stretching at work\nAU  - Okafor, Ben\nPY  - 2019\nDO  - 10.9999/s.2\nAB  - Office.\nER  - \n\
TY  - JOUR\nTI  - Cycling to school\nAU  - Haas, Dev\nPY  - 2021\nDO  - 10.9999/c.4\nAB  - Children.\nER  - \n\
TY  - JOUR\nTI  - Yoga for back pain\nAU  - Moreau, Eli\nPY  - 2018\nDO  - 10.9999/y.5\nAB  - Adults.\nER  - \n";

fn review() -> (Reviews, String, String) {
    let reviews = Reviews::in_memory().unwrap();
    let (id, a) = reviews.create("Movement and health", "Ana", None).unwrap();
    let team = vec![
        Member { id: a.clone(), name: "Ana".into(), roles: vec!["owner".into(), "reviewer".into()], initials: "A".into() },
        Member { id: "b".into(), name: "Ben".into(), roles: vec!["reviewer".into()], initials: "B".into() },
    ];
    reviews.save_team(&id, team, &a).unwrap();
    (reviews, id, a)
}

fn protocol(r: &Reviews, id: &str) -> Protocol {
    r.read(id, |s, _| Ok(s.protocol.clone())).unwrap()
}

fn import(r: &Reviews, id: &str, a: &str, batch: Batch) -> crate::ops::ImportReport {
    let parsed = crate::import::parse_file(RIS, Some("x.ris")).unwrap();
    r.import(id, batch, parsed.records, a, &NoLibrary).unwrap()
}

fn items(r: &Reviews, id: &str) -> crate::checklist::Checklist {
    r.read(id, |s, _| Ok(compute(s, &HashMap::new()))).unwrap()
}

fn find<'a>(items: &'a [Item], id: &str) -> &'a Item {
    items.iter().find(|i| i.id == id).unwrap_or_else(|| panic!("no item {id}"))
}

fn active(r: &Reviews, id: &str) -> Vec<String> {
    r.read(id, |s, _| Ok(s.records.iter().filter(|x| s.active(x)).map(|x| x.id.clone()).collect())).unwrap()
}

#[test]
fn empty_review_shows_gaps_with_one_action_each() {
    let (r, id, _) = review();
    let c = items(&r, &id);
    assert_eq!(c.main.len(), 42, "PRISMA 2020 has 42 rows with sub-items");
    assert_eq!(c.abstract_items.len(), 12);
    assert_eq!(c.prismas.len(), 16);
    for i in c.main.iter().filter(|i| i.status == "missing" || i.status == "partly") {
        assert!(i.gap.is_some(), "item {} has no action", i.id);
    }
    assert_eq!(find(&c.main, "3").status, "missing");
    assert_eq!(find(&c.main, "6").status, "missing");
    assert_eq!(find(&c.main, "24a").status, "missing");
    assert_eq!(find(&c.main, "24a").draft.as_deref(), Some("The review was not registered."));
    // RoB and certainty come from other parts of Key: not recorded yet, not "missing".
    assert_eq!(find(&c.main, "22").status, "notRecorded");
    assert_eq!(find(&c.main, "1").manuscript, true);
}

#[test]
fn checklist_follows_the_review_data() {
    let (r, id, a) = review();
    let mut p = protocol(&r, &id);
    p.question.text = "Does walking lower blood pressure in adults?".into();
    p.question.parts.insert("p".into(), "Adults".into());
    p.criteria = crate::templates::suggested_criteria(&p.question);
    p.rules.ta.reviewers = 2;
    p.rules.conflicts = "third".into();
    p.plan.text.insert("rationale".into(), "Blood pressure is common and walking is cheap.".into());
    p.plan.text.insert("funding".into(), "None.".into());
    p.plan.text.insert("conflicts".into(), "None declared.".into());
    p.plan.outcomes.push(crate::protocol_doc::PlannedOutcome { name: "Systolic blood pressure".into(), priority: "primary".into(), timepoint: "12 weeks".into(), measure: "mmHg".into() });
    r.save_protocol(&id, p, "", &a, false, &NoLibrary).unwrap();
    import(&r, &id, &a, Batch { kind: "file".into(), group: "databases".into(), name: "Example database".into(), searched_at: "2026-10-01".into(), ..Default::default() });
    let c = items(&r, &id);
    assert_eq!(find(&c.main, "3").status, "evidenced");
    assert_eq!(find(&c.main, "4").status, "evidenced");
    assert_eq!(find(&c.main, "5").status, "evidenced");
    assert_eq!(find(&c.main, "25").status, "evidenced");
    assert_eq!(find(&c.main, "26").status, "evidenced");
    // A file import's strategy is missing: item 7 partly, through PRISMA-S item 8.
    assert_eq!(find(&c.main, "7").status, "partly");
    assert_eq!(find(&c.main, "6").status, "evidenced");
    assert!(find(&c.main, "6").draft.as_deref().unwrap().contains("Example database (last searched 2026-10-01)"));
    // Screening under way: 16a partly, with the numbers so far.
    assert_eq!(find(&c.main, "16a").status, "partly");

    // Two reviewers screen 4 records: (I,I) (E,E) (I,E) (E,E). Agreement 75%; expected by
    // chance 0.5·0.25 + 0.5·0.75 = 0.5, so Cohen's κ = (0.75 − 0.5)/(1 − 0.5) = 0.50.
    let ids = active(&r, &id);
    assert_eq!(ids.len(), 4);
    let plan = [(Choice::Include, Choice::Include), (Choice::Exclude, Choice::Exclude), (Choice::Include, Choice::Exclude), (Choice::Exclude, Choice::Exclude)];
    for (rec, (x, y)) in ids.iter().zip(plan) {
        r.decide(&id, &[rec.clone()], Stage::Ta, x, vec![], "", "", vec![], &a).unwrap();
        r.decide(&id, &[rec.clone()], Stage::Ta, y, vec![], "", "", vec![], "b").unwrap();
    }
    r.resolve(&id, &ids[2], Stage::Ta, Choice::Exclude, vec![], "", "", &a).unwrap();
    // Full text: the one included record is included.
    r.decide(&id, &[ids[0].clone()], Stage::Ft, Choice::Include, vec![], "", "", vec![], &a).unwrap();
    let c = items(&r, &id);
    let eight = find(&c.main, "8");
    assert_eq!(eight.status, "evidenced");
    let d = eight.draft.as_deref().unwrap();
    assert!(d.contains("two reviewers independently") && d.contains("Cohen's κ = 0.50, 75% agreement over 4 records") && d.contains("third reviewer"), "{d}");
    let flow = find(&c.main, "16a");
    assert_eq!(flow.status, "evidenced");
    let f = flow.draft.as_deref().unwrap();
    // 5 identified, 1 duplicate, 4 screened, 3 excluded, 1 sought, 1 assessed, 0 excluded, 1 included.
    assert!(f.contains("identified 5 records") && f.contains("removing 1 duplicates") && f.contains("4 records were screened") && f.contains("3 excluded") && f.contains("1 study (1 report)"), "{f}");
    assert!(c.methods.contains("### Selection process") && c.methods.contains("Example database"), "{}", c.methods);

    // A manuscript location evidences a manuscript-only item.
    r.checklist_note(&id, "prisma2020", "1", "Title page", "", &a).unwrap();
    let c = items(&r, &id);
    assert_eq!(find(&c.main, "1").status, "evidenced");
    assert_eq!(find(&c.main, "1").note.as_ref().unwrap().location, "Title page");
    // Exports carry every item in order, with the attribution.
    let md = r.export(&id, "prisma-checklist", &a).unwrap();
    let text = md["content"].as_str().unwrap();
    assert!(text.contains("| Title – Title | 1 |") && text.contains("CC BY 4.0") && text.find("| 13a |").unwrap() < text.find("| 13f |").unwrap(), "{text}");
    let csv = r.export(&id, "prisma-checklist-csv", &a).unwrap();
    assert!(csv["content"].as_str().unwrap().contains("Title page"));
    let methods = r.export(&id, "methods-draft", &a).unwrap();
    assert!(methods["content"].as_str().unwrap().contains("Cohen's κ = 0.50"));
}

#[test]
fn registration_locks_the_protocol_and_logs_deviations() {
    let (r, id, a) = review();
    let mut p = protocol(&r, &id);
    p.criteria = crate::templates::suggested_criteria(&p.question);
    p.plan.text.insert("rationale".into(), "Why.".into());
    r.save_protocol(&id, p, "", &a, false, &NoLibrary).unwrap();
    // Before registration, edits save as they are (no decisions yet).
    let mut p = protocol(&r, &id);
    p.plan.text.insert("funding".into(), "None.".into());
    assert!(!r.save_protocol(&id, p, "", &a, false, &NoLibrary).unwrap().new_version);
    assert!(r.register_protocol(&id, &Registration { registry: "OSF".into(), date: "27/11/2026".into(), ..Default::default() }, &a).is_err());
    r.register_protocol(&id, &Registration { registry: "OSF".into(), id: "osf.io/abcde".into(), date: "2026-11-01".into(), url: "https://osf.io/abcde".into(), ..Default::default() }, &a).unwrap();
    // Now a change to a criterion needs a reason and is a new version.
    let mut p = protocol(&r, &id);
    p.criteria[0].label = "Adults aged 18 to 65".into();
    let impact = r.protocol_impact(&id, &p, &NoLibrary).unwrap();
    assert!(impact.new_version);
    let err = r.save_protocol(&id, p.clone(), "", &a, false, &NoLibrary).unwrap_err();
    assert!(err.contains("reason"), "{err}");
    let saved = r.save_protocol(&id, p, "Older adults have other blood pressure targets", &a, false, &NoLibrary).unwrap();
    assert!(saved.new_version);
    // A change the protocol does not state (labels) needs no reason.
    let mut p = protocol(&r, &id);
    p.labels.push("Ask Ben".into());
    assert!(r.save_protocol(&id, p, "", &a, false, &NoLibrary).is_ok());
    // A planned analysis added later is a deviation too.
    let mut p = protocol(&r, &id);
    p.plan.sensitivity.push("Excluding studies at high risk of bias".into());
    r.save_protocol(&id, p, "Asked for by a peer reviewer", &a, false, &NoLibrary).unwrap();
    let (devs, doc) = r.read(&id, |s, _| Ok((crate::protocol_doc::deviations(s), crate::protocol_doc::view(s)))).unwrap();
    assert_eq!(devs.len(), 2, "{devs:?}");
    assert!(devs[0].changes[0].starts_with("Criterion reworded"), "{:?}", devs[0].changes);
    assert_eq!(devs[0].reason, "Older adults have other blood pressure targets");
    assert_eq!(devs[1].changes, vec!["Sensitivity analysis added: Excluding studies at high risk of bias".to_string()]);
    assert_eq!(doc["locked"], true);
    assert_eq!(doc["registeredBeforeConduct"], true);
    let c = items(&r, &id);
    let x = find(&c.main, "24c");
    assert_eq!(x.status, "evidenced");
    assert!(x.draft.as_deref().unwrap().contains("amended two times") && x.draft.as_deref().unwrap().contains("Asked for by a peer reviewer"));
    assert_eq!(find(&c.main, "24a").status, "evidenced");
    assert_eq!(find(&c.main, "24b").status, "evidenced");
    let csv = r.export(&id, "deviations", &a).unwrap();
    assert!(csv["content"].as_str().unwrap().contains("Criterion reworded"));
    // Undoing a registration once amendments exist is refused.
    assert!(r.unregister_protocol(&id, &a).is_err());
    // The PRISMA-P document and PROSPERO sheet carry what Key knows.
    let doc = r.export(&id, "protocol", &a).unwrap();
    let text = doc["content"].as_str().unwrap();
    assert!(text.contains("### Rationale (item 6)") && text.contains("Why.") && text.contains("Registered with OSF on 2026-11-01 (osf.io/abcde)") && text.contains("Reason: Asked for by a peer reviewer"), "{text}");
    let sheet = r.export(&id, "prospero-sheet", &a).unwrap();
    let text = sheet["content"].as_str().unwrap();
    assert!(text.contains("### Stage of the review at this submission") && text.contains("Formal screening of search results against eligibility criteria: not started"), "{text}");
    assert!(r.export(&id, "osf-prereg", &a).unwrap()["content"].as_str().unwrap().contains("## Inclusion and exclusion criteria"));
}

#[test]
fn stage_of_review_and_conduct_before_registration() {
    let (r, id, a) = review();
    let mut p = protocol(&r, &id);
    p.criteria = crate::templates::suggested_criteria(&p.question);
    r.save_protocol(&id, p, "", &a, false, &NoLibrary).unwrap();
    import(&r, &id, &a, Batch { kind: "file".into(), group: "databases".into(), name: "Example database".into(), ..Default::default() });
    let ids = active(&r, &id);
    r.decide(&id, &[ids[0].clone()], Stage::Ta, Choice::Include, vec![], "", "", vec![], &a).unwrap();
    // Registered after screening started (dated today).
    let today = crate::report_text::date(crate::events::now_ms() + 86_400_000);
    r.register_protocol(&id, &Registration { registry: "PROSPERO".into(), id: "CRD420260000".into(), date: today, ..Default::default() }, &a).unwrap();
    let (stage, before) = r.read(&id, |s, _| Ok((crate::protocol_doc::stage_of_review(s), crate::protocol_doc::registered_before_conduct(s)))).unwrap();
    assert!(stage[0].completed && stage[2].started && !stage[2].completed && !stage[3].started);
    assert_eq!(before, Some(false));
    let c = items(&r, &id);
    assert!(find(&c.main, "24a").rule.contains("after screening had started"));
}

#[test]
fn prisma_s_report_from_runs_imports_and_details() {
    let (r, id, a) = review();
    // A Key database search run of two services (one a register), and a file import.
    let run = Batch { kind: "database".into(), group: "databases".into(), name: "Database search".into(), db_run_id: "run-1".into(), searched_at: "1795737600000".into(), per_source: [("PubMed".to_string(), 3usize), ("ClinicalTrials.gov".to_string(), 2usize)].into_iter().collect(), per_source_kind: [("ClinicalTrials.gov".to_string(), "register".to_string())].into_iter().collect(), strategy: "PubMed: walking".into(), ..Default::default() };
    import(&r, &id, &a, run);
    let file = import(&r, &id, &a, Batch { kind: "file".into(), group: "databases".into(), name: "Embase".into(), file_name: "embase.ris".into(), ..Default::default() });
    import(&r, &id, &a, Batch { kind: "other".into(), group: "other".into(), name: "Citation searching".into(), strategy: "Backward citation searching (OpenAlex) from 2 seed records".into(), ..Default::default() });
    let strategy = json!({ "format": "key-search-strategy", "limits": ["years 2000\u{2013}2026"], "databases": [
        { "connector": "pubmed", "name": "PubMed", "version": "1.2", "startedAt": 1795737600000i64, "queries": [{ "n": 1, "native": "walking[tiab] AND \"blood pressure\"[tiab]", "reported": 120, "kept": 3 }], "postFilter": false, "reconstruction": [], "approximate": [] },
        { "connector": "ctgov", "name": "ClinicalTrials.gov", "version": "1.0", "startedAt": 1795737660000i64, "queries": [{ "n": 1, "native": "walking", "reported": 40, "kept": 2 }, { "n": 2, "native": "exercise", "reported": 30, "kept": 1 }], "postFilter": true, "reconstruction": ["Ran each synonym as its own query", "Kept records matching the full search"], "approximate": [] }
    ]});
    let strategies: HashMap<String, Json> = [("run-1".to_string(), strategy)].into_iter().collect();
    let rep = r.read(&id, |s, _| Ok(crate::search_report::report(s, &strategies))).unwrap();
    assert_eq!(rep.sources.len(), 3);
    let pubmed = rep.sources.iter().find(|s| s.name == "PubMed").unwrap();
    assert_eq!(pubmed.searched, "2026-11-27");
    assert_eq!(pubmed.queries[0].native, "walking[tiab] AND \"blood pressure\"[tiab]");
    assert!(pubmed.missing.is_empty(), "{:?}", pubmed.missing);
    let ct = rep.sources.iter().find(|s| s.name == "ClinicalTrials.gov").unwrap();
    assert_eq!(ct.group, "registers");
    assert_eq!(ct.decomposition.len(), 2);
    let embase = rep.sources.iter().find(|s| s.name == "Embase").unwrap();
    assert!(embase.missing.iter().any(|m| m.contains("platform")) && embase.missing.iter().any(|m| m.contains("date searched")) && embase.missing.iter().any(|m| m.contains("strategy")));
    let st = |id: &str| rep.items.iter().find(|i| i.id == id).unwrap().status.clone();
    assert_eq!(st("3"), "evidenced");
    assert_eq!(st("5"), "evidenced", "citation searching is dated by its import");
    assert_eq!(st("8"), "partly");
    assert_eq!(st("9"), "partly", "the year limit has no reason");
    assert_eq!(st("14"), "missing");
    assert_eq!(st("16"), "evidenced");

    // The reviewer completes the file import, justifies the limit and records a PRESS review.
    r.set_source_detail(&id, json!({ "batchId": file.batch_id, "platform": "Ovid", "coverage": "1974 to present", "searchedAt": "2026-10-02", "strategy": "1 exp walking/\n2 blood pressure.ti,ab.\n3 1 and 2", "noLimits": true }), &a).unwrap();
    assert!(r.set_source_detail(&id, json!({ "batchId": file.batch_id, "searchedAt": "yesterday" }), &a).is_err());
    let run_batch = r.read(&id, |s, _| Ok(s.batches.iter().find(|b| b.db_run_id == "run-1").unwrap().id.clone())).unwrap();
    for source in ["PubMed", "ClinicalTrials.gov"] {
        r.set_source_detail(&id, json!({ "batchId": run_batch, "source": source, "limits": [{ "kind": "date", "value": "years 2000\u{2013}2026", "justification": "Walking groups began in 2000" }] }), &a).unwrap();
    }
    let cite = r.read(&id, |s, _| Ok(s.batches.iter().find(|b| b.group == "other").unwrap().id.clone())).unwrap();
    r.set_source_detail(&id, json!({ "batchId": cite, "searchedAt": "2026-11-20" }), &a).unwrap();
    assert!(r.set_peer_review(&id, json!({ "date": "2026-10-01" }), &a).is_err());
    r.set_peer_review(&id, json!({ "by": "Cara (librarian)", "date": "2026-10-01", "tool": "PRESS 2015", "outcome": "Two synonyms added" }), &a).unwrap();
    r.set_prior_work(&id, json!({ "citation": "Doe J. Walking review. 2020", "how": "Strategy adapted from" }), &a).unwrap();
    let rep = r.read(&id, |s, _| Ok(crate::search_report::report(s, &strategies))).unwrap();
    let st = |id: &str| rep.items.iter().find(|i| i.id == id).unwrap().status.clone();
    for item in ["1", "3", "5", "8", "9", "11", "13", "14", "15", "16"] {
        assert_eq!(st(item), "evidenced", "PRISMA-S item {item}: {:?}", rep.items.iter().find(|i| i.id == item).unwrap().rule);
    }
    let md = rep.markdown(&r.read(&id, |s, _| Ok(s.clone())).unwrap());
    assert!(md.contains("### Embase") && md.contains("1 exp walking/") && md.contains("Date searched: 2026-10-02") && md.contains("Platform: Ovid"), "{md}");
    assert!(md.contains("walking[tiab] AND \"blood pressure\"[tiab]") && md.contains("Date searched: 2026-11-27") && md.contains("Ran each synonym as its own query"));
    assert!(md.contains("Cara (librarian) on 2026-10-01 (PRESS 2015): Two synonyms added"));
    assert!(md.contains("years 2000–2026 (reason: Walking groups began in 2000)"));
    assert!(rep.csv().contains("Ovid") && rep.csv().contains("2026-10-02"));
    let json: Json = serde_json::from_str(&rep.json(&r.read(&id, |s, _| Ok(s.clone())).unwrap())).unwrap();
    assert_eq!(json["format"], "key-prisma-s");
    // Without the run's log the export falls back to the stored strategy.
    let plain = r.export(&id, "search-report", &a).unwrap();
    assert!(plain["content"].as_str().unwrap().contains("PubMed: walking"));
}

#[test]
fn review_types_choose_the_checklist() {
    let (r, id, a) = review();
    let mut p = protocol(&r, &id);
    p.plan.review_type = "scoping".into();
    r.save_protocol(&id, p, "", &a, false, &NoLibrary).unwrap();
    let c = items(&r, &id);
    assert_eq!(c.kind, "scoping");
    assert_eq!(c.main.len(), 22);
    assert_eq!(c.main[0].list, "scr");
    assert_eq!(find(&c.main, "12").status, "na", "critical appraisal is optional");
    let doc = r.read(&id, |s, _| Ok(crate::protocol_doc::view(s))).unwrap();
    let rob = doc["fields"].as_array().unwrap().iter().find(|f| f["id"] == "rob").unwrap();
    assert_eq!(rob["required"], false);
    let mut p = protocol(&r, &id);
    p.plan.review_type = "living".into();
    r.save_protocol(&id, p, "", &a, false, &NoLibrary).unwrap();
    let c = items(&r, &id);
    assert_eq!(c.main.len(), 42);
    assert_eq!(c.extra.len(), 2);
    let doc = r.read(&id, |s, _| Ok(crate::protocol_doc::view(s))).unwrap();
    assert!(doc["fields"].as_array().unwrap().iter().any(|f| f["id"] == "livingFrequency" && f["required"] == true));
}

#[test]
fn protocol_fields_prefill_and_completeness() {
    let (r, id, a) = review();
    let mut p = protocol(&r, &id);
    p.question.text = "Does walking help?".into();
    p.question.parts.insert("p".into(), "Adults".into());
    p.criteria = crate::templates::suggested_criteria(&p.question);
    p.rules.ta.reviewers = 2;
    r.save_protocol(&id, p, "", &a, false, &NoLibrary).unwrap();
    let doc = r.read(&id, |s, _| Ok(crate::protocol_doc::view(s))).unwrap();
    let field = |k: &str| doc["fields"].as_array().unwrap().iter().find(|f| f["id"] == k).unwrap().clone();
    assert_eq!(field("objectives")["fromKey"], true);
    assert!(field("objectives")["effective"].as_str().unwrap().contains("population: Adults"));
    assert!(field("selection")["effective"].as_str().unwrap().starts_with("Titles and abstracts are screened by two reviewers independently"));
    assert!(field("dataManagement")["effective"].as_str().unwrap().contains("Key v"));
    assert_eq!(field("rationale")["done"], false);
    let before = doc["completeness"]["done"].as_u64().unwrap();
    let mut p = protocol(&r, &id);
    p.plan.text.insert("rationale".into(), "Why.".into());
    r.save_protocol(&id, p, "", &a, false, &NoLibrary).unwrap();
    let doc = r.read(&id, |s, _| Ok(crate::protocol_doc::view(s))).unwrap();
    assert_eq!(doc["completeness"]["done"].as_u64().unwrap(), before + 1);
    assert!(doc["completeness"]["missing"].as_array().unwrap().iter().any(|m| m == "Funding and other support"));
}
