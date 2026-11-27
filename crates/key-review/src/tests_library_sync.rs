// Records linked to the library: field normalisation and the comparison, remembered choices,
// rejected matches, undo and redo of link operations through compensating events, the review's
// policy, "complete metadata" from the linked source, and the user's highlights on review-only
// full texts (stored, exported). Invented records.
use crate::library_sync::{self, author_key, normal, plan_link, plan_reject, plan_take, plan_unlink};
use crate::model::*;
use crate::ops::Library;
use crate::{NoLibrary, Reviews};
use serde_json::{Map, Value as Json, json};

const RIS: &str = "TY  - JOUR\nTI  - Walking groups and blood pressure in older adults\nAU  - Rivera, Ana\nPY  - 2016\nDO  - 10.9999/walk.1\nJO  - Journal of Examples\nSP  - 123\nEP  - 30\nAB  - A randomised trial of walking groups in four towns.\nER  - \n\
TY  - JOUR\nTI  - Stretching at work: a cluster trial\nAU  - Okafor, Ben\nPY  - 2019\nER  - \n";

fn setup() -> (Reviews, String, String, Vec<String>) {
    let reviews = Reviews::in_memory().unwrap();
    let (id, owner) = reviews.create("Movement and health", "Ana", None).unwrap();
    let parsed = crate::import::parse_file(RIS, Some("search.ris")).unwrap();
    let batch = Batch { kind: "file".into(), group: "databases".into(), name: "Example database".into(), ..Default::default() };
    reviews.import(&id, batch, parsed.records, &owner, &NoLibrary).unwrap();
    let ids = reviews.read(&id, |s, _| Ok(s.records.iter().map(|r| r.id.clone()).collect())).unwrap();
    (reviews, id, owner, ids)
}

/// The library's copy of the first record: the same work, written differently, one real change.
fn library_copy(id: &str) -> RecordMeta {
    RecordMeta {
        id: id.into(),
        title: "Walking Groups and Blood-Pressure in Older Adults.".into(),
        authors: vec!["Ana Rivera".into()],
        year: Some(2016),
        journal: "JOURNAL OF EXAMPLES".into(),
        pages: "123–130".into(),
        doi: "https://doi.org/10.9999/WALK.1".into(),
        abstract_text: "A randomised trial of walking groups in five towns.".into(),
        language: "eng".into(),
        item_type: "article-journal".into(),
        ..Default::default()
    }
}

fn meta(reviews: &Reviews, id: &str, record: &str) -> RecordMeta {
    reviews.metas(id, &[record.to_string()]).unwrap().remove(record).unwrap()
}

fn diff(reviews: &Reviews, id: &str, record: &str, library: &RecordMeta) -> library_sync::LinkDiff {
    let m = meta(reviews, id, record);
    reviews.read(id, |s, _| Ok(library_sync::compare(s, &m, library, "src1"))).unwrap()
}

#[test]
fn trivial_differences_do_not_count() {
    assert_eq!(normal("title", &json!("Ünïcode: Façade-Study")), normal("title", &json!("unicode facade study")));
    assert_eq!(author_key("Smith, John A."), author_key("John A. Smith"));
    assert_eq!(author_key("Smith JA"), author_key("Smith, J."));
    assert_eq!(author_key("van der Berg, Anna"), author_key("Anna van der Berg"));
    assert_ne!(author_key("Smith, John"), author_key("Smith, Kate"));
    assert_eq!(normal("doi", &json!("doi:10.1/ABC")), normal("doi", &json!("https://dx.doi.org/10.1/abc")));
    assert_eq!(normal("pages", &json!("123-30")), normal("pages", &json!("pp. 123–130")));
    assert_eq!(normal("itemType", &json!("journalArticle")), normal("itemType", &json!("article-journal")));
    assert_eq!(normal("language", &json!("English")), normal("language", &json!("en-GB")));
    assert_eq!(normal("url", &json!("https://www.example.org/a/")), normal("url", &json!("http://example.org/a")));
    assert_eq!(normal("abstractText", &json!("Abstract: Children cycled.")), normal("abstractText", &json!("children cycled")));
    // Author order is real: a different first author differs.
    assert_ne!(normal("authors", &json!(["Rivera, Ana", "Okafor, Ben"])), normal("authors", &json!(["Okafor, Ben", "Rivera, Ana"])));
}

#[test]
fn the_comparison_lists_real_differences_and_remembers_choices_until_a_value_changes() {
    let (reviews, id, owner, ids) = setup();
    let rec = &ids[0];
    let lib = library_copy(rec);
    let d = diff(&reviews, &id, rec, &lib);
    let fields: Vec<(&str, &str)> = d.fields.iter().map(|f| (f.field.as_str(), f.state.as_str())).collect();
    // Title, author, journal, pages, DOI fold away; the abstract differs; language only in the library.
    assert_eq!(fields, vec![("abstractText", "differ"), ("language", "libraryOnly")]);
    assert_eq!(d.pending, 2);
    // "Keep as they are" for the abstract: quiet from now on.
    let m = meta(&reviews, &id, rec);
    let plan = reviews.read(&id, |s, _| plan_take(s, &m, &lib, "src1", &[("abstractText".into(), "keep".into())])).unwrap();
    reviews.link_commit(&id, &plan, "review", &owner).unwrap();
    let d = diff(&reviews, &id, rec, &lib);
    assert_eq!(d.pending, 1);
    assert_eq!(d.fields[0].decided.as_deref(), Some("keep"));
    // The library's abstract changes: the field asks again.
    let mut changed = lib.clone();
    changed.abstract_text = "A randomised trial of walking groups in six towns.".into();
    assert_eq!(diff(&reviews, &id, rec, &changed).pending, 2);
    // "Take from the library" for the language: the record has it now, nothing differs there.
    let plan = reviews.read(&id, |s, _| plan_take(s, &m, &lib, "src1", &[("language".into(), "library".into())])).unwrap();
    assert_eq!(plan.label, "Take the language from the library");
    reviews.link_commit(&id, &plan, "review", &owner).unwrap();
    assert_eq!(meta(&reviews, &id, rec).language, "eng");
    let d = diff(&reviews, &id, rec, &lib);
    assert_eq!(d.fields.len(), 1);
    assert_eq!(d.pending, 0);
    // "Take from the review" plans the library's patch for the host (creators, date, abstract …).
    let plan = reviews.read(&id, |s, _| plan_take(s, &m, &lib, "src1", &[("abstractText".into(), "review".into()), ("authors".into(), "review".into()), ("year".into(), "review".into())])).unwrap();
    let patch = plan.forward.iter().find(|s| s["do"] == "library").unwrap();
    assert_eq!(patch["patch"]["abstract"], json!("A randomised trial of walking groups in four towns."));
    assert_eq!(patch["patch"]["creators"][0], json!({ "family": "Rivera", "given": "Ana", "role": "author" }));
    assert_eq!(patch["patch"]["date"], json!("2016"));
}

#[test]
fn the_policy_quiets_or_settles_differences() {
    let (reviews, id, owner, ids) = setup();
    let lib = library_copy(&ids[0]);
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.rules.linked_sync = "review".into();
    reviews.save_protocol(&id, p, "", &owner, false, &NoLibrary).unwrap();
    let d = diff(&reviews, &id, &ids[0], &lib);
    assert_eq!((d.policy.as_str(), d.pending, d.fields.len()), ("review", 0, 2));
}

#[test]
fn link_operations_undo_and_redo_with_compensating_events() {
    let (reviews, id, owner, ids) = setup();
    let rec = &ids[0];
    let events = || reviews.events(&id).unwrap().len();
    let source = |r: &Reviews| r.read(&id, |s, _| Ok(s.record(rec).unwrap().source_id.clone())).unwrap();
    // Link.
    let plan = reviews.read(&id, |s, _| plan_link(s, rec, "src1")).unwrap();
    reviews.link_commit(&id, &plan, "review", &owner).unwrap();
    assert_eq!(source(&reviews).as_deref(), Some("src1"));
    // Take the language from the library, then undo it: the record is as before.
    let m = meta(&reviews, &id, rec);
    let lib = library_copy(rec);
    let plan = reviews.read(&id, |s, _| plan_take(s, &m, &lib, "src1", &[("language".into(), "library".into()), ("abstractText".into(), "library".into())])).unwrap();
    reviews.link_commit(&id, &plan, "review", &owner).unwrap();
    assert_eq!(meta(&reviews, &id, rec).abstract_text, lib.abstract_text);
    let before = events();
    let op = reviews.link_undo_target(&id, &owner, false).unwrap().unwrap();
    assert_eq!(op.label, "Take the 2 fields from the library");
    reviews.link_step(&id, &op, true, &owner).unwrap();
    assert!(events() > before, "an undo appends events, it never removes any");
    let m2 = meta(&reviews, &id, rec);
    assert_eq!((m2.language.as_str(), m2.abstract_text.as_str()), ("", "A randomised trial of walking groups in four towns."));
    assert_eq!(diff(&reviews, &id, rec, &lib).pending, 2, "the remembered choices went with it");
    // Redo puts it back; a second undo goes to the link.
    let op = reviews.link_undo_target(&id, &owner, true).unwrap().unwrap();
    reviews.link_step(&id, &op, false, &owner).unwrap();
    assert_eq!(meta(&reviews, &id, rec).language, "eng");
    assert!(reviews.link_undo_target(&id, &owner, true).unwrap().is_none());
    let take = reviews.link_undo_target(&id, &owner, false).unwrap().unwrap();
    reviews.link_step(&id, &take, true, &owner).unwrap();
    let link = reviews.link_undo_target(&id, &owner, false).unwrap().unwrap();
    assert_eq!(link.label, "Link to the library");
    reviews.link_step(&id, &link, true, &owner).unwrap();
    assert_eq!(source(&reviews), None);
    // The same undo twice does nothing more.
    let n = events();
    reviews.link_step(&id, &link, true, &owner).unwrap();
    assert_eq!(events(), n);
    // A replay of the log (another device, a reopened file) ends in the same state.
    let replayed = crate::derive::State::replay(&id, reviews.events(&id).unwrap().iter());
    assert_eq!(replayed.record(rec).unwrap().source_id, None);
    assert_eq!(replayed.link.ops.iter().filter(|o| o.undone).count(), 2);
    // An operation done in the library is not undone from the review.
    let plan = reviews.read(&id, |s, _| plan_link(s, rec, "src2")).unwrap();
    reviews.link_commit(&id, &plan, "library", &owner).unwrap();
    assert_ne!(reviews.link_undo_target(&id, &owner, false).unwrap().map(|o| o.origin), Some("library".to_string()));
}

#[test]
fn unlinked_and_rejected_pairs_are_remembered() {
    let (reviews, id, owner, ids) = setup();
    let rec = &ids[1];
    let plan = reviews.read(&id, |s, _| plan_reject(s, rec, "src9")).unwrap();
    reviews.link_commit(&id, &plan, "review", &owner).unwrap();
    assert!(reviews.read(&id, |s, _| Ok(s.link.is_rejected(rec, "src9"))).unwrap());
    // Confirming it after all lifts the rejection.
    let plan = reviews.read(&id, |s, _| plan_link(s, rec, "src9")).unwrap();
    reviews.link_commit(&id, &plan, "review", &owner).unwrap();
    assert!(!reviews.read(&id, |s, _| Ok(s.link.is_rejected(rec, "src9"))).unwrap());
    // Unlinked: the record keeps the library's file as its own, the pair is rejected.
    let own = json!({ "hash": "abc", "name": "walk.pdf", "mime": "application/pdf", "size": 3, "origin": "library" });
    let plan = reviews.read(&id, |s, _| plan_unlink(s, rec, Some(own.clone()))).unwrap();
    reviews.link_commit(&id, &plan, "review", &owner).unwrap();
    let (src, file, rejected) = reviews.read(&id, |s, _| Ok((s.record(rec).unwrap().source_id.clone(), s.record(rec).unwrap().fulltext.file.clone(), s.link.is_rejected(rec, "src9")))).unwrap();
    assert_eq!((src, file.map(|f| f.hash), rejected), (None, Some("abc".to_string()), true));
    assert!(library_sync::unlinked(&reviews.read(&id, |s, _| Ok(s.clone())).unwrap()).contains(rec));
    // Undone: linked again, without the copy.
    let op = reviews.link_undo_target(&id, &owner, false).unwrap().unwrap();
    reviews.link_step(&id, &op, true, &owner).unwrap();
    let (src, file) = reviews.read(&id, |s, _| Ok((s.record(rec).unwrap().source_id.clone(), s.record(rec).unwrap().fulltext.file.clone()))).unwrap();
    assert_eq!((src.as_deref(), file), (Some("src9"), None));
}

struct OneSource(RecordMeta);
impl Library for OneSource {
    fn properties(&self, _: &str) -> Map<String, Json> {
        Map::new()
    }
    fn has_file(&self, _: &str) -> bool {
        false
    }
    fn source_meta(&self, id: &str) -> Option<RecordMeta> {
        (id == "src1").then(|| self.0.clone())
    }
}

#[test]
fn completing_metadata_uses_the_linked_source_first() {
    let (reviews, id, owner, ids) = setup();
    let rec = &ids[1];
    reviews.link_commit(&id, &reviews.read(&id, |s, _| plan_link(s, rec, "src1")).unwrap(), "review", &owner).unwrap();
    let lib = RecordMeta { abstract_text: "Office workers stretched twice a day.".into(), journal: "Work and Health".into(), ..Default::default() };
    let report = reviews.fill_missing(&id, &OneSource(lib), &owner).unwrap();
    assert_eq!(report.filled.get("abstractText"), Some(&1));
    let m = meta(&reviews, &id, rec);
    assert_eq!((m.abstract_text.as_str(), m.journal.as_str()), ("Office workers stretched twice a day.", "Work and Health"));
}

#[test]
fn highlights_on_review_only_full_texts_are_logged_and_exported() {
    let (reviews, id, owner, ids) = setup();
    let rec = &ids[0];
    let h = json!({ "id": "h1", "documentId": "doc", "text": "walking groups", "color": "yellow", "comment": "Key passage", "range": { "start": { "page": 2, "index": 0 }, "end": { "page": 2, "index": 14 } } });
    reviews.set_highlights(&id, rec, vec![h.clone()], vec![], &owner).unwrap();
    // The same again: nothing logged.
    let n = reviews.events(&id).unwrap().len();
    reviews.set_highlights(&id, rec, vec![h.clone()], vec![], &owner).unwrap();
    assert_eq!(reviews.events(&id).unwrap().len(), n);
    assert_eq!(reviews.highlights(&id, rec).unwrap(), vec![h.clone()]);
    let csv = reviews.export(&id, "highlights", &owner).unwrap();
    let content = csv["content"].as_str().unwrap();
    assert!(content.contains("Walking groups and blood pressure") && content.contains(",3,walking groups,Key passage,"), "{content}");
    // In the review file: a review opened from it has them.
    let file = reviews.export(&id, "review", &owner).unwrap()["content"].as_str().unwrap().to_string();
    let other = Reviews::in_memory().unwrap();
    other.import_review_file(&file).unwrap();
    assert_eq!(other.highlights(&id, rec).unwrap(), vec![h]);
    reviews.set_highlights(&id, rec, vec![], vec!["h1".into()], &owner).unwrap();
    assert!(reviews.highlights(&id, rec).unwrap().is_empty());
}
