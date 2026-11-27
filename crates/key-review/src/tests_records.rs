// Round two: rules for the criterion asked when excluding or maybe (with Other), label keys,
// records removed and restored, duplicates split and merged, missing abstracts filled with where
// they came from, full texts kept with the review (attached, matched from dropped files, a CSV of
// file names), evidence and value sources, and studies with several reports. Invented records.
use crate::derive::FileRef;
use crate::model::*;
use crate::ops::Library;
use crate::records::DroppedFile;
use crate::views::ListQuery;
use crate::{NoLibrary, Reviews};
use serde_json::{Map, Value as Json, json};

const RIS: &str = "TY  - JOUR\nTI  - Walking groups and blood pressure in older adults\nAU  - Rivera, Ana\nPY  - 2016\nDO  - 10.9999/walk.1\nER  - \n\
TY  - JOUR\nTI  - Walking groups and blood pressure in older adults\nAU  - Rivera, Ana\nPY  - 2016\nDO  - 10.9999/walk.1\nJO  - Journal of Examples\nAB  - A randomised trial of walking groups in four towns.\nER  - \n\
TY  - JOUR\nTI  - Stretching at work: a cluster trial\nAU  - Okafor, Ben\nPY  - 2019\nDO  - 10.9999/stretch.2\nAB  - Office workers stretched.\nER  - \n\
TY  - JOUR\nTI  - Cycling to school and fitness in children\nAU  - Haas, Dev\nPY  - 2021\nAB  - Children cycled.\nER  - \n\
TY  - JOUR\nTI  - Yoga for back pain: a randomised trial\nAU  - Moreau, Eli\nPY  - 2018\nDO  - 10.9999/yoga.5\nER  - \n";

/// One reviewer per stage, so a decision is final.
fn setup() -> (Reviews, String, String) {
    let reviews = Reviews::in_memory().unwrap();
    let (id, owner) = reviews.create("Movement and health", "Ana", None).unwrap();
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.rules.ta.reviewers = 1;
    p.rules.ft.reviewers = 1;
    p.criteria = crate::templates::suggested_criteria(&p.question);
    reviews.save_protocol(&id, p, "", &owner, false, &NoLibrary).unwrap();
    let parsed = crate::import::parse_file(RIS, Some("search.ris")).unwrap();
    let batch = Batch { kind: "file".into(), group: "databases".into(), name: "Example database".into(), file_name: "search.ris".into(), ..Default::default() };
    reviews.import(&id, batch, parsed.records, &owner, &NoLibrary).unwrap();
    (reviews, id, owner)
}

fn active(reviews: &Reviews, id: &str) -> Vec<String> {
    reviews.read(id, |s, _| Ok(s.records.iter().filter(|r| s.active(r)).map(|r| r.id.clone()).collect())).unwrap()
}

fn criterion(reviews: &Reviews, id: &str, stage: Stage, n: usize) -> String {
    reviews.read(id, |s, _| Ok(s.protocol.criteria_at(stage).nth(n).unwrap().id.clone())).unwrap()
}

fn set_rules(reviews: &Reviews, id: &str, owner: &str, f: impl FnOnce(&mut Protocol)) {
    let mut p = reviews.read(id, |s, _| Ok(s.protocol.clone())).unwrap();
    f(&mut p);
    reviews.save_protocol(id, p, "Rules changed", owner, false, &NoLibrary).unwrap();
}

fn to_full_text(reviews: &Reviews, id: &str, owner: &str, records: &[String]) {
    reviews.decide(id, records, Stage::Ta, Choice::Include, vec![], "", "", vec![], owner).unwrap();
}

#[test]
fn the_criterion_asked_when_excluding_or_maybe_with_other() {
    let (reviews, id, a) = setup();
    let recs = active(&reviews, &id);
    let (c1, c2) = (criterion(&reviews, &id, Stage::Ta, 0), criterion(&reviews, &id, Stage::Ta, 1));
    // Title/abstract defaults to "No": nothing asked.
    reviews.decide(&id, &[recs[0].clone()], Stage::Ta, Choice::Exclude, vec![], "", "", vec![], &a).unwrap();
    set_rules(&reviews, &id, &a, |p| {
        p.rules.ta.reasons = "first".into();
        p.rules.ta.maybe_reasons = "all".into();
    });
    let r = &recs[1];
    let err = reviews.decide(&id, &[r.clone()], Stage::Ta, Choice::Exclude, vec![], "", "", vec![], &a).unwrap_err();
    assert!(err.contains("criterion it does not meet"), "{err}");
    assert!(reviews.decide(&id, &[r.clone()], Stage::Ta, Choice::Exclude, vec![c1.clone(), c2.clone()], "", "", vec![], &a).unwrap_err().contains("Choose one"));
    // A criterion and Other together are two: not "the first one".
    assert!(reviews.decide(&id, &[r.clone()], Stage::Ta, Choice::Exclude, vec![c1.clone()], "Conference abstract only", "", vec![], &a).is_err());
    reviews.decide(&id, &[r.clone()], Stage::Ta, Choice::Exclude, vec![], "Conference abstract only", "", vec![], &a).unwrap();
    // Maybe asks for all that apply: at least one.
    assert!(reviews.decide(&id, &[recs[2].clone()], Stage::Ta, Choice::Maybe, vec![], "", "", vec![], &a).is_err());
    reviews.decide(&id, &[recs[2].clone()], Stage::Ta, Choice::Maybe, vec![c1.clone(), c2.clone()], "", "", vec![], &a).unwrap();
    // Including names no criterion.
    reviews.decide(&id, &[recs[3].clone()], Stage::Ta, Choice::Include, vec![], "", "", vec![], &a).unwrap();
    let seen = reviews.record_view(&id, r, &a, Stage::Ta, &NoLibrary).unwrap();
    assert_eq!(seen["mine"]["other"], "Conference abstract only");
    // At full text, Other shows in PRISMA under "Other" with its words, and in the export.
    let ft = recs[3].clone();
    reviews.decide(&id, &[ft.clone()], Stage::Ft, Choice::Exclude, vec![], "Same trial as another report", "", vec![], &a).unwrap();
    let p = reviews.prisma(&id).unwrap();
    assert_eq!(p.main.excluded_reasons.iter().find(|n| n.name == "Other").map(|n| n.count), Some(1));
    assert_eq!(p.main.other_reasons[0].name, "Same trial as another report");
    let csv = crate::prisma::csv(&p);
    assert!(csv.contains("Reports excluded: Other: Same trial as another report,1"), "{csv}");
    let out = reviews.export(&id, "screening", &a).unwrap();
    assert!(out["content"].as_str().unwrap().contains("Same trial as another report"));
    // A recurring Other text is offered as a criterion.
    reviews.decide(&id, &[recs[0].clone()], Stage::Ta, Choice::Exclude, vec![], "conference abstract only", "", vec![], &a).unwrap();
    let s = reviews.summary(&id, &a).unwrap();
    assert_eq!(s["otherReasons"][0]["count"], 2, "{}", s["otherReasons"]);
}

#[test]
fn label_keys_are_one_letter_and_do_not_clash() {
    let (reviews, id, a) = setup();
    let p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    assert_eq!(p.label_key("Background"), Some("b"));
    assert_eq!(p.label_key("Check later"), Some("l"));
    let mut bad = p.clone();
    bad.label_keys.insert("Background".into(), "e".into());
    let err = reviews.save_protocol(&id, bad, "", &a, false, &NoLibrary).unwrap_err();
    assert!(err.contains("taken"), "{err}");
    let mut bad = p.clone();
    bad.label_keys.insert("Check later".into(), "b".into());
    assert!(reviews.save_protocol(&id, bad, "", &a, false, &NoLibrary).is_err());
    let mut bad = p.clone();
    bad.label_keys.insert("Check later".into(), "lx".into());
    assert!(reviews.save_protocol(&id, bad, "", &a, false, &NoLibrary).is_err());
    let mut good = p;
    good.label_keys.insert("Methods paper".into(), "t".into());
    reviews.save_protocol(&id, good, "", &a, false, &NoLibrary).unwrap();
    // Labels are counted and form their own queue.
    let recs = active(&reviews, &id);
    reviews.labels(&id, &recs[..2], &["Check later".to_string()], &[], &a).unwrap();
    let s = reviews.summary(&id, &a).unwrap();
    assert_eq!(s["labelCounts"]["Check later"], 2);
    assert_eq!(reviews.queue(&id, &a, Stage::Ta, "label:Check later").unwrap().len(), 2);
}

#[test]
fn removing_restoring_and_duplicates_keep_prisma_consistent() {
    let (reviews, id, a) = setup();
    let recs = active(&reviews, &id);
    assert_eq!(recs.len(), 4);
    let before = reviews.prisma(&id).unwrap();
    assert_eq!((before.identified, before.duplicates, before.removed_other, before.screening_pending), (5, 1, 0, 4));
    // Removed by hand: out of screening, counted as removed for other reasons.
    reviews.remove_records(&id, &[recs[3].clone()], true, "Retracted", &a).unwrap();
    let p = reviews.prisma(&id).unwrap();
    assert_eq!((p.removed_other, p.screening_pending), (1, 3));
    assert_eq!(reviews.queue(&id, &a, Stage::Ta, "").unwrap().len(), 3);
    let removed = reviews.list(&id, &a, &ListQuery { filter: "removed".into(), ..Default::default() }, &NoLibrary).unwrap();
    assert_eq!(removed["rows"][0]["removed"], "Retracted");
    // Restored: back as before.
    reviews.remove_records(&id, &[recs[3].clone()], false, "", &a).unwrap();
    assert_eq!(reviews.prisma(&id).unwrap(), before);
    // The automatic duplicate is listed with why; splitting it brings the record back.
    let d = reviews.duplicates(&id).unwrap();
    assert_eq!(d["groups"].as_array().unwrap().len(), 1);
    let merged = &d["groups"][0]["merged"][0];
    assert_eq!(merged["auto"], true);
    assert!(!merged["why"].as_str().unwrap().is_empty());
    let kept = d["groups"][0]["kept"]["id"].as_str().unwrap().to_string();
    let dup = merged["record"]["id"].as_str().unwrap().to_string();
    reviews.resolve_pair(&id, &dup, &kept, "distinct", None, &a).unwrap();
    let p = reviews.prisma(&id).unwrap();
    assert_eq!((p.duplicates, p.screening_pending), (0, 5));
    // Merged again by hand: listed as by hand.
    reviews.resolve_pair(&id, &kept, &dup, "duplicate", Some(&kept), &a).unwrap();
    assert_eq!(reviews.prisma(&id).unwrap(), before);
    let d = reviews.duplicates(&id).unwrap();
    assert_eq!(d["groups"][0]["merged"][0]["auto"], false);
    // The Sources table sees every record, with filters.
    let all = reviews.list(&id, &a, &ListQuery { scope: "sources".into(), ..Default::default() }, &NoLibrary).unwrap();
    assert_eq!(all["total"], 5);
    let by_title = reviews.list(&id, &a, &ListQuery { scope: "sources".into(), sort: "title".into(), ..Default::default() }, &NoLibrary).unwrap();
    let titles: Vec<&str> = by_title["rows"].as_array().unwrap().iter().map(|r| r["title"].as_str().unwrap()).collect();
    let mut sorted = titles.clone();
    sorted.sort_by_key(|t| t.to_lowercase());
    assert_eq!(titles, sorted);
    let back = reviews.list(&id, &a, &ListQuery { scope: "sources".into(), sort: "-title".into(), ..Default::default() }, &NoLibrary).unwrap();
    assert_eq!(back["rows"][0]["title"].as_str(), titles.last().copied());
    let no_abstract = reviews.list(&id, &a, &ListQuery { scope: "sources".into(), filter: "active".into(), has_abstract: "no".into(), ..Default::default() }, &NoLibrary).unwrap();
    assert_eq!(no_abstract["total"], 2);
}

struct Lib;
impl Library for Lib {
    fn properties(&self, _: &str) -> Map<String, Json> {
        Map::new()
    }
    fn has_file(&self, _: &str) -> bool {
        false
    }
    fn same_work(&self, meta: &RecordMeta) -> Option<(String, Map<String, Json>)> {
        let mut m = Map::new();
        if meta.title.starts_with("Walking") {
            m.insert("abstractText".into(), json!("The library's shorter abstract."));
            m.insert("pmid".into(), json!("123456"));
        } else if meta.title.starts_with("Yoga") {
            m.insert("abstractText".into(), json!("Adults with back pain did yoga twice a week."));
        } else {
            return None;
        }
        Some(("src-1".into(), m))
    }
}

#[test]
fn missing_abstracts_come_from_duplicates_then_the_library() {
    let (reviews, id, a) = setup();
    let report = reviews.fill_missing(&id, &Lib, &a).unwrap();
    let (walk, yoga, cycle) = reviews
        .read(&id, |s, conn| {
            let m = crate::store::all_metas(conn, &id)?;
            let find = |t: &str| m.iter().find(|x| x.title.starts_with(t) && s.record(&x.id).is_some_and(|r| s.active(r))).unwrap().id.clone();
            Ok((find("Walking"), find("Yoga"), find("Cycling")))
        })
        .unwrap();
    let metas = reviews.metas(&id, &[walk.clone(), yoga.clone()]).unwrap();
    // The duplicate in the other import came first (its abstract and journal), the library
    // filled what it still lacked.
    assert_eq!(metas[&walk].abstract_text, "A randomised trial of walking groups in four towns.");
    assert_eq!(metas[&walk].journal, "Journal of Examples");
    assert_eq!(metas[&walk].pmid, "123456");
    assert_eq!(metas[&yoga].abstract_text, "Adults with back pain did yoga twice a week.");
    let filled = reviews.read(&id, |s, _| Ok((s.record(&walk).unwrap().filled.clone(), s.record(&yoga).unwrap().filled.clone()))).unwrap();
    assert_eq!(filled.0["abstractText"], "duplicate in Example database");
    assert_eq!(filled.0["pmid"], "library:src-1");
    assert_eq!(filled.1["abstractText"], "library:src-1");
    assert_eq!(report.filled["abstractText"], 2);
    assert_eq!(report.still_missing, 0);
    let _ = cycle;
    // Running again changes nothing; an open lookup only fills what is missing.
    assert!(reviews.fill_missing(&id, &Lib, &a).unwrap().filled.is_empty());
    let mut found = Map::new();
    found.insert("abstractText".into(), json!("Something else"));
    found.insert("volume".into(), json!("12"));
    assert_eq!(reviews.enrich_from(&id, &walk, found, "OpenAlex", false, &a).unwrap(), 1);
    let m = reviews.metas(&id, &[walk.clone()]).unwrap();
    assert_eq!(m[&walk].abstract_text, "A randomised trial of walking groups in four towns.");
    assert_eq!(m[&walk].volume, "12");
    // Edits by hand replace a value and clear its "filled from".
    let mut fields = Map::new();
    fields.insert("abstractText".into(), json!("Corrected abstract."));
    reviews.edit_record(&id, &walk, fields, &a).unwrap();
    assert_eq!(reviews.metas(&id, &[walk.clone()]).unwrap()[&walk].abstract_text, "Corrected abstract.");
    assert!(reviews.read(&id, |s, _| Ok(!s.record(&walk).unwrap().filled.contains_key("abstractText"))).unwrap());
    let mut fields = Map::new();
    fields.insert("title".into(), json!(""));
    assert!(reviews.edit_record(&id, &walk, fields, &a).is_err());
}

#[test]
fn full_texts_kept_with_the_review_matched_and_from_a_csv() {
    let (reviews, id, a) = setup();
    let recs = active(&reviews, &id);
    to_full_text(&reviews, &id, &a, &recs);
    let titles: Vec<(String, String)> = reviews.metas(&id, &recs).unwrap().into_iter().map(|(k, m)| (m.title, k)).collect();
    let rec = |t: &str| titles.iter().find(|x| x.0.starts_with(t)).unwrap().1.clone();
    let status = reviews.fulltext_status(&id).unwrap();
    assert_eq!(status["need"], 4);

    // Dropped files: by DOI (confident), by title and author (confident), nothing (unmatched).
    let files = vec![
        DroppedFile { name: "a.pdf".into(), path: "/x/a.pdf".into(), text: "doi: 10.9999/stretch.2 Stretching".into(), ..Default::default() },
        DroppedFile { name: "b.pdf".into(), path: "/x/b.pdf".into(), title: "Cycling to school and fitness in children".into(), text: "Haas D, 2021".into(), ..Default::default() },
        DroppedFile { name: "c.pdf".into(), path: "/x/c.pdf".into(), text: "Gardening and mood".into(), ..Default::default() },
        DroppedFile { name: "d.pdf".into(), path: "/x/d.pdf".into(), text: "Yoga for pain in a randomised trial".into(), ..Default::default() },
    ];
    let m = reviews.match_dropped(&id, &files).unwrap();
    assert_eq!((m[0].level.as_str(), m[0].record.clone()), ("confident", Some(rec("Stretching"))));
    assert_eq!((m[1].level.as_str(), m[1].record.clone()), ("confident", Some(rec("Cycling"))));
    assert_eq!(m[2].level, "unmatched");
    assert_eq!((m[3].level.as_str(), m[3].record.clone()), ("uncertain", Some(rec("Yoga"))));

    // Attached: kept with the review, not a library source.
    let file = FileRef { hash: "abc123".into(), name: "a.pdf".into(), mime: "application/pdf".into(), size: 10, origin: "match".into() };
    reviews.attach_file(&id, &rec("Stretching"), file, &a).unwrap();
    let st = reviews.read(&id, |s, _| Ok(s.record(&rec("Stretching")).unwrap().clone())).unwrap();
    assert!(st.has_full_text());
    assert_eq!(st.source_id, None);
    assert_eq!(st.fulltext.file.as_ref().unwrap().hash, "abc123");
    assert_eq!(reviews.fulltext_status(&id).unwrap()["need"], 3);

    // The CSV lists the three still needed, with an empty filename column.
    let csv = reviews.fulltext_csv(&id).unwrap();
    assert!(csv.starts_with("record_id,title,first_author,year,doi,filename\n"));
    assert_eq!(csv.lines().count(), 4);
    assert!(!csv.contains("Stretching"));
    let walk = rec("Walking");
    let filled = format!(
        "record_id,title,first_author,year,doi,filename\n{},Walking,Rivera,2016,,walk.PDF\n{},Cycling,,,,missing.pdf\nnope,Unknown,,,,walk.pdf\n{},Yoga,,,,\n{},Again,,,,walk.pdf\n",
        walk,
        rec("Cycling"),
        rec("Yoga"),
        rec("Cycling")
    );
    let uploaded = vec![DroppedFile { name: "walk.pdf".into(), path: "/up/walk.pdf".into(), ..Default::default() }];
    let rows = reviews.read_csv(&id, &filled, &uploaded).unwrap();
    let states: Vec<&str> = rows.iter().map(|r| r.state.as_str()).collect();
    assert_eq!(states, ["ok", "error", "error", "skipped", "error"]);
    assert_eq!(rows[0].path.as_deref(), Some("/up/walk.pdf"));
    assert!(rows[1].message.contains("not among the files"), "{}", rows[1].message);
    assert!(rows[2].message.contains("No record"), "{}", rows[2].message);
    assert!(rows[4].message.contains("another record"), "{}", rows[4].message);
    assert_eq!(rows[2].line, 4);
    assert!(reviews.read_csv(&id, "a,b\n1,2", &uploaded).unwrap()[0].message.contains("record_id"));

    // Undo of an attach: needed again. PRISMA counts reports sought either way.
    reviews.detach_file(&id, &rec("Stretching"), &a).unwrap();
    assert_eq!(reviews.fulltext_status(&id).unwrap()["need"], 4);
    assert_eq!(reviews.prisma(&id).unwrap().main.sought, 4);
}

#[test]
fn evidence_and_value_sources_round_trip_and_required_sources() {
    let (reviews, id, a) = setup();
    let recs = active(&reviews, &id);
    to_full_text(&reviews, &id, &a, &recs[..1]);
    let r = &recs[0];
    let c = criterion(&reviews, &id, Stage::Ft, 0);
    let passage = json!({ "kind": "notMet", "criterion": c, "text": "Participants were 18 to 30 years old", "page": 2, "rects": [[100, 200, 300, 220]], "hash": "abc" });
    reviews.decide(&id, &[r.clone()], Stage::Ft, Choice::Exclude, vec![c.clone()], "", "", vec![passage.clone()], &a).unwrap();
    let seen = reviews.record_view(&id, r, &a, Stage::Ft, &NoLibrary).unwrap();
    assert_eq!(seen["mine"]["evidence"][0], passage);
    // Back to include, for extraction.
    reviews.decide(&id, &[r.clone()], Stage::Ft, Choice::Include, vec![], "", "", vec![], &a).unwrap();

    set_rules(&reviews, &id, &a, |p| p.rules.source_default = "required".into());
    let form = reviews.read(&id, |s, _| Ok(s.protocol.forms[0].clone())).unwrap();
    let field = form.fields().find(|f| f.kind == "text").unwrap().clone();
    // Typed without its place: the form cannot be completed.
    for f in form.fields().filter(|f| f.required && f.id != field.id) {
        let v = if f.kind == "number" { json!(1) } else if !f.options.is_empty() { json!(f.options[0]) } else { json!("x") };
        reviews.extract(&id, r, &form.id, &f.id, v, "q", Some(1), None, Some(json!({ "page": 0, "rects": [], "text": "q" })), false, false, &a).unwrap();
    }
    reviews.extract(&id, r, &form.id, &field.id, json!("Cluster trial"), "", None, None, None, false, false, &a).unwrap();
    let err = reviews.complete_form(&id, r, &form.id, &a).unwrap_err();
    assert!(err.contains("pick it from the document"), "{err}");
    let pos = json!({ "hash": "abc", "page": 3, "rects": [[10, 20, 30, 40]], "text": "a cluster randomised trial" });
    reviews.extract(&id, r, &form.id, &field.id, json!("Cluster trial"), "", Some(4), None, Some(pos.clone()), false, false, &a).unwrap();
    let still = reviews.complete_form(&id, r, &form.id, &a);
    assert!(still.is_ok() || !still.unwrap_err().contains(&field.label));
    let view = reviews.extraction_view(&id, r, &a).unwrap();
    assert_eq!(view["values"][format!("{}/{}", form.id, field.id)]["mine"]["sourcePos"], pos);
    assert_eq!(view["values"][format!("{}/{}", form.id, field.id)]["source"], "required");
    // The export has the source next to the value.
    let wide = reviews.export(&id, "extraction", &a).unwrap()["content"].as_str().unwrap().to_string();
    assert!(wide.contains(&format!("{}: {} (source)", form.name, field.label)), "{wide}");
    assert!(wide.contains("p. 4: “a cluster randomised trial”"), "{wide}");
    // Selections read as numbers.
    let n = crate::logic::parse_selection("12.3 (4.5)");
    assert_eq!((n["mean"].as_f64(), n["sd"].as_f64()), (Some(12.3), Some(4.5)));
}

fn conditional_form() -> Form {
    let cond = |field: &str, op: &str, value: Json| ShowWhen { conditions: vec![FieldCondition { field: field.into(), op: op.into(), value }], all: true };
    let fld = |id: &str, kind: &str| Field { id: id.into(), label: id.replace('_', " "), kind: kind.into(), ..Default::default() };
    Form {
        id: "f-design".into(),
        name: "Design".into(),
        kind: "custom".into(),
        sections: vec![Section {
            id: "s".into(),
            title: "Design".into(),
            fields: vec![
                Field { options: vec!["Quantitative".into(), "Qualitative".into()], required: true, ..fld("study_type", "choice") },
                Field { options: vec!["Interviews".into(), "Focus groups".into(), "Ethnography".into()], required: true, show_when: Some(cond("study_type", "is", json!("Qualitative"))), ..fld("method", "choice") },
                Field { required: true, show_when: Some(cond("method", "is", json!("Interviews"))), ..fld("interviews", "number") },
            ],
            ..Default::default()
        }],
    }
}

#[test]
fn conditional_fields_in_completeness_exports_and_templates() {
    let (reviews, id, a) = setup();
    let recs = active(&reviews, &id);
    to_full_text(&reviews, &id, &a, &recs[..2]);
    for r in &recs[..2] {
        reviews.decide(&id, &[r.clone()], Stage::Ft, Choice::Include, vec![], "", "", vec![], &a).unwrap();
    }
    set_rules(&reviews, &id, &a, |p| {
        p.forms = vec![conditional_form()];
        p.rules.quote_required = false;
    });
    let (q, ql) = (&recs[0], &recs[1]);
    let put = |r: &String, f: &str, v: Json| reviews.extract(&id, r, "f-design", f, v, "", None, None, None, false, false, &a).unwrap();
    put(q, "study_type", json!("Quantitative"));
    // The method is hidden, so not required: complete.
    reviews.complete_form(&id, q, "f-design", &a).unwrap();
    put(ql, "study_type", json!("Qualitative"));
    let err = reviews.complete_form(&id, ql, "f-design", &a).unwrap_err();
    assert!(err.contains("method"), "{err}");
    put(ql, "method", json!("Interviews"));
    assert!(reviews.complete_form(&id, ql, "f-design", &a).unwrap_err().contains("interviews"));
    put(ql, "interviews", json!(24));
    reviews.complete_form(&id, ql, "f-design", &a).unwrap();
    let view = reviews.extraction_view(&id, ql, &a).unwrap();
    assert_eq!(view["formState"]["f-design"]["completed"], true);
    assert_eq!(view["formState"]["f-design"]["shownWhen"]["method"], "Shown when study type is Qualitative");
    // Switching back to quantitative keeps the method's value but marks it inactive; it is
    // blank in the export.
    put(ql, "study_type", json!("Quantitative"));
    let view = reviews.extraction_view(&id, ql, &a).unwrap();
    assert_eq!(view["values"]["f-design/method"]["inactive"], true);
    assert_eq!(view["formState"]["f-design"]["completed"], false);
    let wide = reviews.export(&id, "extraction", &a).unwrap()["content"].as_str().unwrap().to_string();
    assert!(!wide.contains("Interviews"), "{wide}");
    put(ql, "study_type", json!("Qualitative"));
    let wide = reviews.export(&id, "extraction", &a).unwrap()["content"].as_str().unwrap().to_string();
    assert!(wide.contains("Interviews"), "{wide}");
    // The data dictionary and a template keep the logic.
    let dict = reviews.export(&id, "dictionary", &a).unwrap()["content"].as_str().unwrap().to_string();
    assert!(dict.contains("Shown when"), "{dict}");
    assert!(dict.contains("study type is Qualitative"), "{dict}");
    let template = reviews.export(&id, "template", &a).unwrap()["content"].as_str().unwrap().to_string();
    let back = crate::export::read_template(&template).unwrap();
    assert_eq!(back.forms[0], conditional_form());
    // A field shown on itself is refused with a plain message.
    let mut looped = conditional_form();
    looped.sections[0].fields[0].show_when = Some(ShowWhen { conditions: vec![FieldCondition { field: "interviews".into(), op: "filled".into(), value: Json::Null }], all: true });
    let err = reviews.save_protocol(&id, Protocol { forms: vec![looped], ..reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap() }, "", &a, false, &NoLibrary).unwrap_err();
    assert!(err.contains("circle"), "{err}");
}

#[test]
fn several_reports_of_one_study_count_once() {
    let (reviews, id, a) = setup();
    let recs = active(&reviews, &id);
    to_full_text(&reviews, &id, &a, &recs[..2]);
    for r in &recs[..2] {
        reviews.decide(&id, &[r.clone()], Stage::Ft, Choice::Include, vec![], "", "", vec![], &a).unwrap();
    }
    assert_eq!(reviews.prisma(&id).unwrap().studies_included, 2);
    reviews.link_study(&id, &recs[1], Some(&recs[0]), &a).unwrap();
    let p = reviews.prisma(&id).unwrap();
    assert_eq!((p.studies_included, p.reports_included), (1, 2));
    assert!(reviews.link_study(&id, &recs[0], Some(&recs[1]), &a).is_err());
    let seen = reviews.record_view(&id, &recs[0], &a, Stage::Ft, &NoLibrary).unwrap();
    assert_eq!(seen["reports"], json!([recs[1]]));
    reviews.link_study(&id, &recs[1], None, &a).unwrap();
    assert_eq!(reviews.prisma(&id).unwrap().studies_included, 2);
}

#[test]
fn registers_in_a_search_run_are_counted_as_registers() {
    let reviews = Reviews::in_memory().unwrap();
    let (id, owner) = reviews.create("Runs", "Ana", None).unwrap();
    let parsed = crate::import::parse_file(RIS, Some("run.ris")).unwrap();
    let mut per_source = std::collections::BTreeMap::new();
    per_source.insert("PubMed".to_string(), 3);
    per_source.insert("ClinicalTrials.gov".to_string(), 2);
    // A run imported before registers were told apart: all of it under databases.
    let batch = Batch { kind: "database".into(), group: "databases".into(), name: "Search run".into(), db_run_id: "run-1".into(), per_source, count: 5, ..Default::default() };
    reviews.import(&id, batch, parsed.records, &owner, &NoLibrary).unwrap();
    let before = reviews.prisma(&id).unwrap();
    assert_eq!(before.databases.len(), 2);
    assert!(before.registers.is_empty());
    // Classified from the connectors' kinds (once: a second pass changes nothing).
    let kinds: std::collections::HashMap<String, String> = [("PubMed", "database"), ("ClinicalTrials.gov", "register")].into_iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    assert_eq!(reviews.classify_batches(&id, &kinds).unwrap(), 1);
    assert_eq!(reviews.classify_batches(&id, &kinds).unwrap(), 0);
    let p = reviews.prisma(&id).unwrap();
    assert_eq!(p.databases, vec![crate::prisma::Named { name: "PubMed".into(), count: 3 }]);
    assert_eq!(p.registers, vec![crate::prisma::Named { name: "ClinicalTrials.gov".into(), count: 2 }]);
    assert_eq!(p.identified, 5);
    let csv = crate::prisma::csv(&p);
    assert!(csv.contains("Records identified: register: ClinicalTrials.gov,2"), "{csv}");
}

/// Every box adds up: what was identified, removed, screened, sought, assessed and included.
fn assert_invariants(p: &crate::prisma::Prisma) {
    assert_eq!(p.identified, p.databases.iter().chain(&p.registers).map(|n| n.count).sum::<usize>());
    assert_eq!(p.identified - p.duplicates - p.automation - p.removed_other, p.screened + p.screening_pending, "identified − removed = screened + still to screen: {p:?}");
    assert_eq!(p.screened - p.screening_excluded, p.main.sought, "screened − excluded = sought");
    for c in [&p.main, &p.other] {
        assert_eq!(c.sought - c.not_retrieved, c.assessed + c.pending, "sought − not retrieved = assessed + still to assess");
        assert_eq!(c.assessed - c.excluded, c.included, "assessed − excluded = included");
        assert_eq!(c.excluded, c.excluded_reasons.iter().map(|n| n.count).sum::<usize>(), "every exclusion has its reason");
    }
    assert_eq!(p.other.identified - p.other.removed, p.other.screened_out + p.other.screening_pending + p.other.sought, "other methods: identified = screened out + still to screen + sought");
    assert_eq!(p.reports_included, p.main.included + p.other.included);
    assert!(p.studies_included <= p.reports_included);
    assert_eq!(p.complete, p.screening_pending + p.main.pending + p.other.pending + p.other.screening_pending == 0);
}

fn invented(n: usize, tag: &str) -> Vec<RecordMeta> {
    (0..n)
        .map(|i| RecordMeta {
            id: crate::events::uuid7(),
            title: format!("{tag} study number {i} on walking, cycling and outcome {}", (i * 7919) % 100_003),
            authors: vec![format!("Author{i}, A.")],
            year: Some(2000 + (i % 24) as i64),
            doi: format!("10.9999/{tag}.{i}"),
            abstract_text: "An invented abstract.".into(),
            ..Default::default()
        })
        .collect()
}

#[test]
fn the_owners_review_counts_add_up() {
    let reviews = Reviews::in_memory().unwrap();
    let (id, a) = reviews.create("Counts", "Ana", None).unwrap();
    // 315 from a PubMed search run, and 3,402 from the library that an older Key labelled
    // "Manual" under other methods.
    let mut per_source = std::collections::BTreeMap::new();
    per_source.insert("PubMed".to_string(), 315);
    let run = Batch { kind: "database".into(), group: "databases".into(), name: "PubMed search".into(), db_run_id: "run-1".into(), per_source, count: 315, ..Default::default() };
    reviews.import(&id, run, invented(315, "pubmed"), &a, &NoLibrary).unwrap();
    let library = Batch { kind: "library".into(), group: "other".into(), name: "Manual".into(), ..Default::default() };
    let lib_batch = reviews.import(&id, library, invented(3402, "library"), &a, &NoLibrary).unwrap().batch_id;
    // 75 screened at title and abstract: 70 excluded, 5 included.
    let queue = reviews.queue(&id, &a, Stage::Ta, "").unwrap();
    let pubmed: Vec<String> = reviews.read(&id, |s, _| Ok(s.records.iter().filter(|r| r.batch != lib_batch).map(|r| r.id.clone()).collect())).unwrap();
    let screened: Vec<String> = queue.iter().filter(|id| pubmed.contains(id)).take(75).cloned().collect();
    reviews.decide(&id, &screened[..70], Stage::Ta, Choice::Exclude, vec![], "", "", vec![], &a).unwrap();
    reviews.decide(&id, &screened[70..], Stage::Ta, Choice::Include, vec![], "", "", vec![], &a).unwrap();
    let p = reviews.prisma(&id).unwrap();
    assert_invariants(&p);
    // Screened counts finished decisions only; the rest is work in progress.
    assert_eq!((p.identified, p.screened, p.screening_pending, p.screening_excluded, p.main.sought), (315, 75, 240, 70, 5));
    assert!(!p.complete);
    // The old "Manual" import still sits under other methods, its records screened in Key.
    assert_eq!(p.other_methods, vec![crate::prisma::Named { name: "Manual".into(), count: 3402 }]);
    assert_eq!(p.other.screening_pending, 3402);
    let csv = crate::prisma::csv(&p);
    assert!(csv.contains("Records screened,75"), "{csv}");
    assert!(csv.contains("still to screen (in progress, not for publication)\",240"), "{csv}");
    // "Where did these come from?": a database, so they move to the left column and its screening.
    assert!(reviews.set_batch_origin(&id, &lib_batch, "manual", "", &a).is_err());
    reviews.set_batch_origin(&id, &lib_batch, "databases", "", &a).unwrap();
    let p = reviews.prisma(&id).unwrap();
    assert_invariants(&p);
    assert_eq!(p.databases, vec![crate::prisma::Named { name: "PubMed".into(), count: 315 }, crate::prisma::Named { name: crate::prisma::UNNAMED.into(), count: 3402 }]);
    assert_eq!((p.identified, p.screened, p.screening_pending, p.unnamed), (3717, 75, 3642, 3402));
    assert!(p.other_methods.is_empty());
    reviews.set_batch_origin(&id, &lib_batch, "databases", "Scopus", &a).unwrap();
    let p = reviews.prisma(&id).unwrap();
    assert_eq!((p.databases[1].name.as_str(), p.unnamed), ("Scopus", 0));
    // One record found by citation searching instead: it moves to the right-hand column.
    let one = reviews.read(&id, |s, _| Ok(s.records.iter().find(|r| r.batch == lib_batch).unwrap().id.clone())).unwrap();
    reviews.set_record_origin(&id, std::slice::from_ref(&one), Some(("other", "Citation searching")), &a).unwrap();
    let p = reviews.prisma(&id).unwrap();
    assert_invariants(&p);
    assert_eq!(p.databases[1].count, 3401);
    assert_eq!(p.other_methods, vec![crate::prisma::Named { name: "Citation searching".into(), count: 1 }]);
    // Included at title/abstract, then at full text: it reaches "included" through the right path.
    reviews.decide(&id, std::slice::from_ref(&one), Stage::Ta, Choice::Include, vec![], "", "", vec![], &a).unwrap();
    reviews.decide(&id, std::slice::from_ref(&one), Stage::Ft, Choice::Include, vec![], "", "", vec![], &a).unwrap();
    for r in &screened[70..] {
        reviews.decide(&id, std::slice::from_ref(r), Stage::Ft, Choice::Include, vec![], "", "", vec![], &a).unwrap();
    }
    let p = reviews.prisma(&id).unwrap();
    assert_invariants(&p);
    assert_eq!((p.other.sought, p.other.included, p.main.included, p.studies_included), (1, 1, 5, 6));
}
