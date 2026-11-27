// Linked records against a real library store (no PDF engine: `LinkLibrary` on a plain store,
// files attached the way the host attaches them). Invented works and bytes.
use super::*;
use key_review::model::Batch;
use key_store::{Creator, SourceInput, Store};

struct TestLibrary {
    store: Store,
    dir: std::path::PathBuf,
}

impl LinkLibrary for TestLibrary {
    fn store(&self) -> &Store {
        &self.store
    }
    /// As the host: the file copied in by its hash, the one the source had kept beside it.
    fn attach_keeping(&self, id: &str, path: &Path, _root: &Path) -> Result<key_store::Source, String> {
        let before = self.store.source(id)?.ok_or("Source not found")?;
        let hash = key_index::file_hash(path)?;
        let stored = self.dir.join(format!("{hash}.pdf"));
        if !stored.is_file() {
            std::fs::copy(path, &stored).map_err(|e| e.to_string())?;
        }
        let mut patch = Map::new();
        patch.insert("filePath".into(), json!(stored.to_string_lossy()));
        patch.insert("fileHash".into(), json!(hash));
        patch.insert("mime".into(), json!("application/pdf"));
        patch.insert("fileSize".into(), json!(std::fs::metadata(&stored).map(|m| m.len()).unwrap_or(0)));
        if before.kind == "reference" {
            patch.insert("kind".into(), json!("pdf"));
        }
        let updated = self.store.update_source(id, &patch)?;
        if let (Some(p), Some(h)) = (before.file_path(), before.file_hash()) {
            if h != hash {
                self.store.add_other_full_text(id, h, &p.to_string_lossy(), Some("application/pdf"), None)?;
            }
        }
        self.store.remove_other_full_text(id, &hash)?;
        Ok(updated)
    }
}

struct World {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
    library: TestLibrary,
    reviews: Reviews,
    review: String,
    owner: String,
    records: Vec<String>,
}

const RIS: &str = "TY  - JOUR\nTI  - Walking groups and blood pressure in older adults: a randomised trial\nAU  - Rivera, Ana\nPY  - 2016\nJO  - Journal of Examples\nAB  - Walking groups in four towns.\nER  - \n\
TY  - JOUR\nTI  - Stretching at work\nAU  - Okafor, Ben\nPY  - 2019\nER  - \n";

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    let files = dir.path().join("library-files");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&files).unwrap();
    let store = Store::open(&root).unwrap();
    let reviews = Reviews::in_memory().unwrap();
    let (review, owner) = reviews.create("Movement", "Ana", None).unwrap();
    let parsed = import::parse_file(RIS, Some("search.ris")).unwrap();
    reviews.import(&review, Batch { kind: "file".into(), group: "databases".into(), name: "Example database".into(), ..Default::default() }, parsed.records, &owner, &key_review::NoLibrary).unwrap();
    let records = reviews.read(&review, |s, _| Ok(s.records.iter().map(|r| r.id.clone()).collect())).unwrap();
    World { _dir: dir, root, library: TestLibrary { store, dir: files }, reviews, review, owner, records }
}

/// The same work in the library, its title without the subtitle (a likely match, not exact).
fn library_source(w: &World) -> String {
    let mut fields = Map::new();
    fields.insert("title".into(), json!("Walking groups and blood pressure in older adults"));
    fields.insert("date".into(), json!("2016"));
    fields.insert("containerTitle".into(), json!("Journal of Examples"));
    fields.insert("abstract".into(), json!("Walking groups in five towns."));
    fields.insert("itemType".into(), json!("journalArticle"));
    let creators = vec![Creator { family: Some("Rivera".into()), given: Some("Ana".into()), literal: None, role: "author".into(), person_id: None }];
    w.library.store.insert_source(SourceInput { kind: "reference".into(), creators, fields, ..Default::default() }).unwrap().id
}

/// A file kept with the review for a record (as an upload would).
fn review_file(w: &World, record: &str, bytes: &[u8]) -> String {
    let tmp = w.root.join("upload.pdf");
    std::fs::write(&tmp, bytes).unwrap();
    let hash = key_index::file_hash(&tmp).unwrap();
    let dir = files_dir(&w.root, &w.review);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(&tmp, dir.join(format!("{hash}.pdf"))).unwrap();
    let file = key_review::derive::FileRef { hash: hash.clone(), name: "walk.pdf".into(), mime: "application/pdf".into(), size: bytes.len() as u64, origin: "upload".into() };
    w.reviews.attach_file(&w.review, record, file, &w.owner).unwrap();
    hash
}

fn record_state(w: &World, record: &str) -> (Option<String>, Option<String>) {
    w.reviews.read(&w.review, |s, _| Ok(s.record(record).map(|r| (r.source_id.clone(), r.fulltext.file.as_ref().map(|f| f.hash.clone()))).unwrap())).unwrap()
}

fn primary(w: &World, source: &str) -> Option<String> {
    w.library.store.source(source).unwrap().unwrap().file_hash().map(str::to_string)
}

fn others(w: &World, source: &str) -> Vec<String> {
    w.library.store.full_texts(source).unwrap().into_iter().filter(|f| !f.primary).map(|f| f.hash).collect()
}

#[test]
fn a_likely_match_is_suggested_confirmed_shares_the_file_and_undoes_on_both_sides() {
    let w = world();
    let source = library_source(&w);
    let rec = w.records[0].clone();
    let hash = review_file(&w, &rec, b"%PDF-1.4 walking groups");
    let found = suggestions(&w.library, &w.reviews, &w.review).unwrap();
    assert_eq!(found["count"], json!(1), "{found}");
    assert_eq!(found["suggestions"][0]["recordId"], json!(rec));
    assert_eq!(found["suggestions"][0]["sourceId"], json!(source));
    // Never linked without a yes.
    assert_eq!(record_state(&w, &rec).0, None);
    let done = confirm(&w.library, &w.root, &w.reviews, &w.review, &rec, &source, "review", &w.owner).unwrap();
    assert!(done["conflict"].is_null());
    // One file for both: the library took the review's, the record reads it from there.
    assert_eq!(record_state(&w, &rec), (Some(source.clone()), None));
    assert_eq!(primary(&w, &source).as_deref(), Some(hash.as_str()));
    assert_eq!(suggestions(&w.library, &w.reviews, &w.review).unwrap()["count"], json!(0));
    // Undone from the review: unlinked, its own file back; the library's copy kept, not deleted.
    let op = undo(&w.library, &w.root, &w.reviews, &w.review, &w.owner, false).unwrap().unwrap();
    assert_eq!(op.label, "Link to the library");
    assert_eq!(record_state(&w, &rec), (None, Some(hash.clone())));
    assert_eq!(primary(&w, &source), None);
    assert_eq!(others(&w, &source), vec![hash.clone()]);
    assert!(w.library.dir.join(format!("{hash}.pdf")).is_file());
    assert!(files_dir(&w.root, &w.review).join(format!("{hash}.pdf")).is_file());
    assert_eq!(w.library.store.source(&source).unwrap().unwrap().kind, "reference");
    // Redone: the same as after the confirmation.
    undo(&w.library, &w.root, &w.reviews, &w.review, &w.owner, true).unwrap().unwrap();
    assert_eq!(record_state(&w, &rec), (Some(source.clone()), None));
    assert_eq!(primary(&w, &source).as_deref(), Some(hash.as_str()));
}

#[test]
fn a_rejected_match_is_never_suggested_again_and_an_unlinked_pair_is_not_relinked() {
    let w = world();
    let source = library_source(&w);
    let rec = w.records[0].clone();
    reject(&w.library, &w.root, &w.reviews, &w.review, &rec, &source, "review", &w.owner).unwrap();
    assert_eq!(suggestions(&w.library, &w.reviews, &w.review).unwrap()["count"], json!(0));
    assert_eq!(suggestions_for_source(&w.library, &w.reviews, &source).unwrap(), json!([]));
    // Linked anyway, then unlinked: it keeps a copy of the library's file and stays unlinked.
    undo(&w.library, &w.root, &w.reviews, &w.review, &w.owner, false).unwrap();
    assert_eq!(suggestions_for_source(&w.library, &w.reviews, &source).unwrap().as_array().unwrap().len(), 1);
    let pdf = w.root.join("lib.pdf");
    std::fs::write(&pdf, b"%PDF-1.4 library copy").unwrap();
    w.library.attach_keeping(&source, &pdf, &w.root).unwrap();
    confirm(&w.library, &w.root, &w.reviews, &w.review, &rec, &source, "review", &w.owner).unwrap();
    unlink(&w.library, &w.root, &w.reviews, &w.review, &rec, "review", &w.owner).unwrap();
    let (src, own) = record_state(&w, &rec);
    assert_eq!((src, own.as_deref()), (None, primary(&w, &source).as_deref()));
    let refreshed = library_links::refresh_links(&w.library, &w.root, &w.reviews, &w.review, &w.owner).unwrap();
    assert_eq!(refreshed["linked"], json!(0));
}

#[test]
fn details_taken_from_the_review_in_the_library_undo_with_one_library_undo() {
    let w = world();
    let source = library_source(&w);
    let rec = w.records[0].clone();
    confirm(&w.library, &w.root, &w.reviews, &w.review, &rec, &source, "review", &w.owner).unwrap();
    let d = diff(&w.library, &w.reviews, &w.review, &rec).unwrap();
    let fields: Vec<&str> = d["diff"]["fields"].as_array().unwrap().iter().map(|f| f["field"].as_str().unwrap()).collect();
    assert_eq!(fields, vec!["title", "abstractText"], "{d}");
    // On the source's page: take the abstract from the review, keep the titles as they are.
    let picks = [("abstractText".to_string(), "review".to_string()), ("title".to_string(), "keep".to_string())];
    let done = take(&w.library, &w.root, &w.reviews, &w.review, &rec, &picks, "library", &w.owner).unwrap();
    assert!(done["entry"]["seq"].as_i64().is_some());
    let abstract_of = || w.library.store.source(&source).unwrap().unwrap().field("abstract").map(str::to_string);
    assert_eq!(abstract_of().as_deref(), Some("Walking groups in four towns."));
    assert_eq!(diff(&w.library, &w.reviews, &w.review, &rec).unwrap()["diff"]["pending"], json!(0));
    // Not on the review's undo stack: it was done in the library.
    assert_eq!(w.reviews.link_undo_target(&w.review, &w.owner, false).unwrap().map(|o| o.label), Some("Link to the library".into()));
    // ⌘Z in the library: the library's abstract and the review's remembered choices both go back.
    let entry = library_step(&w.library, &w.root, &w.reviews, true).unwrap().unwrap();
    assert_eq!(entry.label, "Reconcile 2 fields");
    assert_eq!(abstract_of().as_deref(), Some("Walking groups in five towns."));
    assert_eq!(diff(&w.library, &w.reviews, &w.review, &rec).unwrap()["diff"]["pending"], json!(2));
    // ⇧⌘Z: both again.
    library_step(&w.library, &w.root, &w.reviews, false).unwrap().unwrap();
    assert_eq!(abstract_of().as_deref(), Some("Walking groups in four towns."));
    assert_eq!(diff(&w.library, &w.reviews, &w.review, &rec).unwrap()["diff"]["pending"], json!(0));
    // Take the library's title in the review: the record changes, the library does not.
    take(&w.library, &w.root, &w.reviews, &w.review, &rec, &[("title".into(), "library".into())], "review", &w.owner).unwrap();
    let meta = w.reviews.metas(&w.review, std::slice::from_ref(&rec)).unwrap().remove(&rec).unwrap();
    assert_eq!(meta.title, "Walking groups and blood pressure in older adults");
}

#[test]
fn a_replaced_file_goes_back_on_undo_and_no_file_is_deleted() {
    let w = world();
    let source = library_source(&w);
    let rec = w.records[0].clone();
    let lib_pdf = w.root.join("lib.pdf");
    std::fs::write(&lib_pdf, b"%PDF-1.4 the library's version").unwrap();
    let lib_hash = w.library.attach_keeping(&source, &lib_pdf, &w.root).unwrap().file_hash().unwrap().to_string();
    let review_hash = review_file(&w, &rec, b"%PDF-1.4 the review's version");
    let done = confirm(&w.library, &w.root, &w.reviews, &w.review, &rec, &source, "review", &w.owner).unwrap();
    assert_eq!(done["conflict"]["libraryHash"], json!(lib_hash));
    // "Use the review's file": the library's primary is the review's now, its own kept beside it.
    reconcile(&w.library, &w.root, &w.reviews, &w.review, &rec, "review", &w.owner).unwrap();
    assert_eq!(primary(&w, &source).as_deref(), Some(review_hash.as_str()));
    assert_eq!(others(&w, &source), vec![lib_hash.clone()]);
    assert_eq!(record_state(&w, &rec).1, None);
    // A reader open on the library's old file follows to the new one.
    let follow = reader_follow(&w.library, &w.reviews, &[lib_hash.clone(), review_hash.clone()]).unwrap();
    assert_eq!(follow, json!({ lib_hash.clone(): { "sourceId": source, "hash": review_hash } }));
    undo(&w.library, &w.root, &w.reviews, &w.review, &w.owner, false).unwrap().unwrap();
    assert_eq!(primary(&w, &source).as_deref(), Some(lib_hash.as_str()));
    assert_eq!(others(&w, &source), vec![review_hash.clone()]);
    assert_eq!(record_state(&w, &rec).1.as_deref(), Some(review_hash.as_str()));
    for h in [&lib_hash, &review_hash] {
        assert!(w.library.dir.join(format!("{h}.pdf")).is_file());
    }
    // "Keep both", undone: the choice is forgotten again.
    reconcile(&w.library, &w.root, &w.reviews, &w.review, &rec, "both", &w.owner).unwrap();
    assert!(kept_both(&w.root, &w.review).contains(&rec));
    undo(&w.library, &w.root, &w.reviews, &w.review, &w.owner, false).unwrap().unwrap();
    assert!(!kept_both(&w.root, &w.review).contains(&rec));
}

#[test]
fn highlights_on_a_review_only_full_text_carry_over_to_the_shared_library_copy() {
    let w = world();
    let source = library_source(&w);
    let rec = w.records[0].clone();
    let hash = review_file(&w, &rec, b"%PDF-1.4 walking groups");
    let h = json!({ "id": "h1", "documentId": "doc", "text": "walking groups", "color": "yellow", "range": { "start": { "page": 0, "index": 0 }, "end": { "page": 0, "index": 14 } } });
    apply_highlights(&w.reviews, &w.review, &rec, vec![h], vec![], &w.owner).unwrap();
    assert_eq!(w.reviews.highlights(&w.review, &rec).unwrap()[0]["fileHash"], json!(hash));
    // Not shared yet: nothing to carry.
    assert_eq!(carry_highlights(&w.library, &w.root, &w.reviews, &w.review, &rec, false, &w.owner).unwrap()["count"], json!(0));
    confirm(&w.library, &w.root, &w.reviews, &w.review, &rec, &source, "review", &w.owner).unwrap();
    assert_eq!(carry_highlights(&w.library, &w.root, &w.reviews, &w.review, &rec, false, &w.owner).unwrap()["count"], json!(1));
    carry_highlights(&w.library, &w.root, &w.reviews, &w.review, &rec, true, &w.owner).unwrap();
    let in_library = w.library.store.annotations(&source).unwrap();
    assert_eq!(in_library.len(), 1);
    assert!(in_library[0].get("fileHash").is_none());
    assert!(w.reviews.highlights(&w.review, &rec).unwrap().is_empty());
    // Undone: back in the review, gone from the library copy.
    undo(&w.library, &w.root, &w.reviews, &w.review, &w.owner, false).unwrap().unwrap();
    assert!(w.library.store.annotations(&source).unwrap().is_empty());
    assert_eq!(w.reviews.highlights(&w.review, &rec).unwrap().len(), 1);
}

#[test]
fn an_edit_in_the_library_is_reported_for_the_records_linked_to_it() {
    let w = world();
    let source = library_source(&w);
    let rec = w.records[0].clone();
    confirm(&w.library, &w.root, &w.reviews, &w.review, &rec, &source, "review", &w.owner).unwrap();
    let first = changes(&w.library, &w.reviews, &w.review, 0).unwrap();
    let since = first["latest"].as_i64().unwrap();
    let mut patch = Map::new();
    patch.insert("abstract".into(), json!("Edited in the library."));
    w.library.store.update_source(&source, &patch).unwrap();
    let now = changes(&w.library, &w.reviews, &w.review, since.max(1)).unwrap();
    assert_eq!(now["records"][&rec], json!(["details"]), "{now}");
    let d = diff(&w.library, &w.reviews, &w.review, &rec).unwrap();
    assert!(d["diff"]["fields"].as_array().unwrap().iter().any(|f| f["field"] == "abstractText" && f["library"] == "Edited in the library."));
}
