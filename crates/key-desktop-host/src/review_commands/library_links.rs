// A review record and a library source that are the same work, linked (the record's `sourceId`,
// an event in the review's log), so their full text is one file: the library's file is the
// record's when the record keeps none of its own; a full text found in the review for a linked
// record goes into the library when the source has none; when both already hold different
// files the person chooses (the library's, the review's, or both kept). Links follow the
// library: a merged source's records move to the source it was merged into, unlinked records
// are linked when the library has their work exactly (DOI, PMID … or the duplicate matcher's
// exact match), and a trashed source leaves its records as they are, file and all.
use super::*;
use key_review::derive::Status;

/// What linking needs of the library: its store, a file attached keeping the one it had (as
/// another full text), and its indexer woken. The host's `Library`; tests use a plain store.
pub trait LinkLibrary {
    fn store(&self) -> &key_store::Store;
    fn attach_keeping(&self, id: &str, path: &Path, root: &Path) -> Result<key_store::Source, String>;
    fn wake(&self) {}
}

impl LinkLibrary for Library {
    fn store(&self) -> &key_store::Store {
        &self.store
    }
    fn attach_keeping(&self, id: &str, path: &Path, root: &Path) -> Result<key_store::Source, String> {
        Library::attach_keeping(self, id, path, root)
    }
    fn wake(&self) {
        self.indexer.wake();
    }
}

/// The library's source for a record's work, by the duplicate matcher (exact matches only).
pub fn exact_source(library: &dyn LinkLibrary, meta: &RecordMeta) -> Option<String> {
    let found = library.store().find_duplicates_for(&[import::work(meta)]).ok()?.into_iter().next()?;
    found.into_iter().find(|m| m.kind == key_store::duplicates::MatchKind::Exact).map(|m| m.source_id)
}

/// A source's live id: itself, or the source it was merged into (followed a few steps).
pub fn live_source(library: &dyn LinkLibrary, id: &str) -> Option<key_store::Source> {
    let mut id = id.to_string();
    for _ in 0..8 {
        let source = library.store().source(&id).ok()??;
        match source.field("mergedInto").filter(|m| !m.is_empty()) {
            Some(next) => id = next.to_string(),
            None => return Some(source),
        }
    }
    None
}

/// Pairs the person chose to keep both files for (record ids), remembered beside the review.
pub fn kept_both(root: &Path, review: &str) -> std::collections::BTreeSet<String> {
    std::fs::read_to_string(files_dir(root, review).with_file_name("reconciled.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}
pub fn keep_both(root: &Path, review: &str, record: &str, on: bool) -> Result<(), String> {
    let mut all = kept_both(root, review);
    if on {
        all.insert(record.to_string());
    } else {
        all.remove(record);
    }
    let path = files_dir(root, review).with_file_name("reconciled.json");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_string(&all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// A linked record that keeps a file of its own: shared with the source when the source has
/// none (or the same), else a conflict for the person (unless they chose to keep both).
fn share_own(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, record: &str, source: &key_store::Source, actor: &str) -> Result<Option<Json>, String> {
    let file = reviews.read(review, |s, _| Ok(s.record(record).and_then(|r| r.fulltext.file.clone())))?;
    let Some(f) = file else { return Ok(None) };
    match source.file_hash() {
        None => {
            let path = files_dir(root, review).join(format!("{}.{}", f.hash, extension(&f.name, &f.mime)));
            if path.is_file() {
                library.attach_keeping(&source.id, &path, root)?;
                library.wake();
                reviews.detach_file(review, record, actor)?;
                reviews.fulltext(review, record, Some("retrieved"), None, Some(Some(&source.id)), actor)?;
            }
            Ok(None)
        }
        Some(have) if have == f.hash => {
            reviews.detach_file(review, record, actor)?;
            reviews.fulltext(review, record, Some("retrieved"), None, Some(Some(&source.id)), actor)?;
            Ok(None)
        }
        Some(_) if kept_both(root, review).contains(record) => Ok(None),
        Some(have) => Ok(Some(json!({ "recordId": record, "sourceId": source.id, "libraryHash": have, "libraryMime": source.field("mime"), "reviewHash": f.hash }))),
    }
}

/// Re-reads the links of a review's records against the library: merged sources repointed,
/// records whose work the library has exactly linked, and a linked record's own file shared
/// with its source (or listed as a conflict to decide). Answers what changed.
pub fn refresh_links(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, actor: &str) -> Result<Json, String> {
    // Linked records, and the unlinked ones at full text (a full text matters there).
    let records: Vec<(String, Option<String>)> = reviews.read(review, |s, _| {
        Ok(s.records.iter().filter(|r| s.active(r) && (r.source_id.is_some() || s.eligible(r, Stage::Ft))).map(|r| (r.id.clone(), r.source_id.clone())).collect())
    })?;
    let unlinked: Vec<String> = records.iter().filter(|(_, s)| s.is_none()).map(|(id, _)| id.clone()).collect();
    let metas = reviews.metas(review, &unlinked)?;
    // Pairs the person said are not the same work (or unlinked) are not linked again.
    let rejected = reviews.read(review, |s, _| Ok(s.link.rejected.clone()))?;
    let (mut linked, mut repointed, mut shared) = (0, 0, 0);
    let mut conflicts = Vec::new();
    for (id, source) in &records {
        let now = match source {
            Some(source) => match live_source(library, source) {
                Some(live) if &live.id != source => {
                    reviews.fulltext(review, id, None, None, Some(Some(&live.id)), actor)?;
                    repointed += 1;
                    Some(live)
                }
                live => live,
            },
            None => match metas.get(id).and_then(|m| exact_source(library, m)).filter(|found| !rejected.contains(&(id.clone(), found.clone()))) {
                Some(found) => {
                    reviews.fulltext(review, id, None, None, Some(Some(&found)), actor)?;
                    linked += 1;
                    library.store().source(&found)?
                }
                None => None,
            },
        };
        // A trashed source leaves the record as it is.
        if let Some(source) = now.filter(|s| s.trashed_at.is_none()) {
            let before = reviews.read(review, |s, _| Ok(s.record(id).is_some_and(|r| r.fulltext.file.is_some())))?;
            match share_own(library, root, reviews, review, id, &source, actor)? {
                Some(conflict) => conflicts.push(conflict),
                None if before => shared += 1,
                None => {}
            }
            // A record using the library's file has its full text exactly while the source has one.
            let (own, status) = reviews.read(review, |s, _| Ok(s.record(id).map(|r| (r.fulltext.file.is_some(), r.fulltext.status.clone())).unwrap_or((true, String::new()))))?;
            if !own && status != "notRetrieved" {
                let has = library.store().full_texts(&source.id)?.iter().any(|f| matches!(f.kind.as_str(), "pdf" | "web"));
                let want = if has { "retrieved" } else { "sought" };
                if status != want && !(want == "sought" && status.is_empty()) {
                    reviews.fulltext(review, id, Some(want), None, None, actor)?;
                    shared += 1;
                }
            }
        }
    }
    Ok(json!({ "linked": linked, "repointed": repointed, "shared": shared, "conflicts": conflicts }))
}

/// Before a full text found in the review is kept: for a linked record it is shared with the
/// library. Some(answer) when the library took (or had) it; None when the record keeps its own
/// copy, with `conflict` set when the library holds a different file already.
pub fn share_on_attach(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, record: &str, path: &Path, hash: &str, actor: &str) -> Result<(Option<Json>, Option<Json>), String> {
    let source_id = reviews.read(review, |s, _| Ok(s.record(record).and_then(|r| r.source_id.clone())))?;
    let Some(source) = source_id.and_then(|id| live_source(library, &id)).filter(|s| s.trashed_at.is_none()) else { return Ok((None, None)) };
    match source.file_hash() {
        None => {
            // An operation of its own: undone, the file stays one of the source's full texts.
            let op = super::library_sync::share_new(library, root, reviews, review, record, &source.id, path, hash, actor)?;
            Ok((Some(json!({ "shared": source.id, "hash": hash, "op": op.get("op") })), None))
        }
        Some(have) if have == hash => {
            reviews.fulltext(review, record, Some("retrieved"), None, Some(Some(&source.id)), actor)?;
            Ok((Some(json!({ "linked": source.id, "hash": hash })), None))
        }
        Some(have) => Ok((None, Some(json!({ "sourceId": source.id, "libraryHash": have, "libraryMime": source.field("mime"), "reviewHash": hash })))),
    }
}

// The person's choice between two different files: library_sync::reconcile (undoable).

/// Where a library source is in the workspace's reviews: each linked record with where it stands.
pub fn links_for_source(library: &dyn LinkLibrary, reviews: &Reviews, source: &str) -> Result<Json, String> {
    let mut out = Vec::new();
    for item in reviews.list_reviews()? {
        let Some(id) = item.get("id").and_then(Json::as_str) else { continue };
        let name = item.get("name").and_then(Json::as_str).unwrap_or("Review").to_string();
        let found: Vec<(String, String)> = reviews.read(id, |s, _| {
            Ok(s.records
                .iter()
                .filter(|r| s.active(r) && r.source_id.as_deref().is_some_and(|x| x == source || live_source(library, x).is_some_and(|l| l.id == source)))
                .map(|r| {
                    let state = if s.eligible(r, Stage::Ft) {
                        match s.status(r, Stage::Ft) {
                            Status::Final { value: Choice::Include, .. } => "included",
                            Status::Final { value: Choice::Exclude, .. } => "excluded",
                            Status::NotRetrieved => "not retrieved",
                            _ if r.fulltext.file.is_none() && r.source_id.is_none() => "awaiting full text",
                            _ => "at full-text screening",
                        }
                    } else {
                        match s.status(r, Stage::Ta) {
                            Status::Final { value: Choice::Exclude, .. } => "excluded",
                            Status::Final { .. } => "screened",
                            _ => "at title and abstract",
                        }
                    };
                    (r.id.clone(), state.to_string())
                })
                .collect())
        })?;
        for (record, state) in found {
            // How many details differ between the record and this source (still to look at).
            let differ = super::library_sync::diff(library, reviews, id, &record).ok().and_then(|d| d.pointer("/diff/pending").and_then(Json::as_u64)).unwrap_or(0);
            out.push(json!({ "reviewId": id, "reviewName": name, "recordId": record, "state": state, "differ": differ }));
        }
    }
    Ok(json!(out))
}
