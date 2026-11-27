// The library's side of linked review records (key_review::library_sync plans the review's):
// a record's details compared with its source's; "take from …" choices run on both sides; link,
// unlink, confirmed and rejected matches, shared and replaced files and reconcile choices as
// operations that undo and redo as one — from the review through its log (compensating events),
// from the library through its journal (one entry carrying the review's part). No file is ever
// deleted: a replaced file stays one of the source's full texts, the review's copies stay in its
// folder. Also: possible matches (the library's duplicate matcher, never linked without a yes),
// the user's highlights on review-only full texts and their carry-over to the library copy, and
// which linked records changed in the library since a view last asked (the change log).
use super::library_links::{self, LinkLibrary, keep_both, kept_both, live_source};
use super::*;
use key_review::library_sync::{self as sync, LinkOp, Plan};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// A linked source's details as a review record.
pub fn source_meta(library: &dyn LinkLibrary, source: &str) -> Option<(key_store::Source, RecordMeta)> {
    let s = live_source(library, source)?;
    let meta = import::from_source(&s);
    Some((s, meta))
}

/// The comparison of a linked record with its source; null when it is not linked.
pub fn diff(library: &dyn LinkLibrary, reviews: &Reviews, review: &str, record: &str) -> Result<Json, String> {
    let source = reviews.read(review, |s, _| Ok(s.record(record).ok_or("This record no longer exists")?.source_id.clone()))?;
    let Some(source) = source else { return Ok(Json::Null) };
    let Some((s, lib)) = source_meta(library, &source) else { return Ok(Json::Null) };
    let meta = reviews.metas(review, &[record.to_string()])?.remove(record).ok_or("This record no longer exists")?;
    let d = reviews.read(review, |state, _| Ok(sync::compare(state, &meta, &lib, &s.id)))?;
    Ok(json!({ "diff": d, "sourceTitle": s.field("title").unwrap_or(""), "trashed": s.trashed_at.is_some() }))
}

/// How many fields still differ for each linked record (the Records table's chips).
pub fn pending_counts(library: &dyn LinkLibrary, reviews: &Reviews, review: &str) -> Result<HashMap<String, usize>, String> {
    let linked: Vec<(String, String)> = reviews.read(review, |s, _| Ok(s.records.iter().filter(|r| s.active(r)).filter_map(|r| Some((r.id.clone(), r.source_id.clone()?))).collect()))?;
    let ids: Vec<String> = linked.iter().map(|(r, _)| r.clone()).collect();
    let metas = reviews.metas(review, &ids)?;
    let mut out = HashMap::new();
    reviews.read(review, |state, _| {
        for (record, source) in &linked {
            let (Some(meta), Some((s, lib))) = (metas.get(record), source_meta(library, source)) else { continue };
            let n = sync::compare(state, meta, &lib, &s.id).pending;
            if n > 0 {
                out.insert(record.clone(), n);
            }
        }
        Ok(())
    })?;
    Ok(out)
}

fn review_file_path(root: &Path, review: &str, f: &key_review::derive::FileRef) -> std::path::PathBuf {
    files_dir(root, review).join(format!("{}.{}", f.hash, extension(&f.name, &f.mime)))
}

/// Makes `hash` the source's primary full text (one it keeps, or the file at `path`), or with
/// none the primary becomes one of its other full texts. Answers the step that puts it back.
fn set_primary(library: &dyn LinkLibrary, root: &Path, source: &str, hash: Option<&str>, path: Option<&str>, kind: Option<&str>) -> Result<Json, String> {
    let store = library.store();
    let s = live_source(library, source).ok_or("The library source no longer exists")?;
    let before = json!({ "do": "file", "sourceId": s.id, "hash": s.file_hash(), "path": s.file_path().map(|p| p.to_string_lossy().to_string()), "kind": s.kind });
    if s.file_hash() != hash {
        match hash {
            Some(h) => {
                let kept = store.full_texts(&s.id)?.into_iter().find(|f| f.hash == h && !f.primary).map(|f| std::path::PathBuf::from(f.path));
                let from = kept.filter(|p| p.is_file()).or_else(|| path.map(std::path::PathBuf::from).filter(|p| p.is_file())).ok_or("That file is no longer kept")?;
                library.attach_keeping(&s.id, &from, root)?;
                store.remove_other_full_text(&s.id, h)?;
            }
            None => {
                if let (Some(p), Some(h)) = (s.file_path(), s.file_hash()) {
                    let size = s.fields.get("fileSize").and_then(Json::as_i64);
                    store.add_other_full_text(&s.id, h, &p.to_string_lossy(), s.field("mime"), size)?;
                }
                let mut patch = Map::new();
                for k in ["filePath", "fileHash", "mime", "fileSize"] {
                    patch.insert(k.into(), Json::Null);
                }
                store.update_source(&s.id, &patch)?;
            }
        }
        library.wake();
    }
    if let Some(kind) = kind.filter(|k| !k.is_empty()) {
        if store.source(&s.id)?.is_some_and(|now| now.kind != kind) {
            let mut patch = Map::new();
            patch.insert("kind".into(), json!(kind));
            store.update_source(&s.id, &patch)?;
        }
    }
    Ok(before)
}

/// Runs the library's steps of an operation (field patches, files, keep-both, highlights);
/// answers, in order, the steps that undo them.
fn run_host_steps(library: &dyn LinkLibrary, root: &Path, review: &str, record: &str, steps: &[Json]) -> Result<Vec<Json>, String> {
    let mut undo = Vec::new();
    for step in steps {
        let source = step.get("sourceId").and_then(Json::as_str).unwrap_or("");
        match step.get("do").and_then(Json::as_str) {
            Some("library") => {
                let s = live_source(library, source).ok_or("The library source no longer exists")?;
                let patch = step.get("patch").and_then(Json::as_object).cloned().unwrap_or_default();
                let mut before = Map::new();
                for k in patch.keys() {
                    let v = if k == "creators" { serde_json::to_value(&s.creators).unwrap_or(Json::Null) } else { s.fields.get(k).cloned().unwrap_or(Json::Null) };
                    before.insert(k.clone(), v);
                }
                library.store().update_source(&s.id, &patch)?;
                undo.push(json!({ "do": "library", "sourceId": s.id, "patch": before }));
            }
            Some("file") => {
                let hash = step.get("hash").and_then(Json::as_str);
                let path = step.get("path").and_then(Json::as_str);
                undo.push(set_primary(library, root, source, hash, path, step.get("kind").and_then(Json::as_str))?);
            }
            Some("keepBoth") => {
                let on = step.get("on").and_then(Json::as_bool).unwrap_or(false);
                let was = kept_both(root, review).contains(record);
                keep_both(root, review, record, on)?;
                undo.push(json!({ "do": "keepBoth", "on": was }));
            }
            Some("annotations") => {
                let upserts: Vec<Json> = step.get("upserts").and_then(Json::as_array).cloned().unwrap_or_default();
                let deleted: Vec<String> = step.get("deleted").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect()).unwrap_or_default();
                let s = live_source(library, source).ok_or("The library source no longer exists")?;
                let have: Vec<Json> = library.store().annotations(&s.id)?;
                let put_back: Vec<Json> = have.iter().filter(|a| a.get("id").and_then(Json::as_str).is_some_and(|id| deleted.iter().any(|d| d == id))).cloned().collect();
                let added: Vec<String> = upserts.iter().filter_map(|a| a.get("id").and_then(Json::as_str)).filter(|id| !have.iter().any(|h| h.get("id").and_then(Json::as_str) == Some(*id))).map(str::to_string).collect();
                library.store().apply_annotations(&s.id, &upserts, &deleted)?;
                undo.push(json!({ "do": "annotations", "sourceId": s.id, "upserts": put_back, "deleted": added }));
            }
            _ => {}
        }
    }
    undo.reverse();
    Ok(undo)
}

/// Runs an operation: the library's steps, then the review's events with the operation and
/// its undo. Done in the library, it is also one entry on the library's undo stack.
pub fn perform(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, mut plan: Plan, origin: &str, actor: &str) -> Result<Json, String> {
    if plan.is_empty() {
        return Ok(json!({ "op": null }));
    }
    let undo = run_host_steps(library, root, review, &plan.record, &plan.forward)?;
    plan.inverse.splice(0..0, undo);
    let op = reviews.link_commit(review, &plan, origin, actor)?;
    let mut out = json!({ "op": op, "label": plan.label, "recordId": plan.record });
    if origin == "library" {
        let entry = library.store().journal_external("link", &plan.label, &[], json!({ "reviewId": review, "op": op }))?;
        out["entry"] = json!(entry);
    }
    Ok(out)
}

/// Takes an operation back, or does it again.
fn step_op(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, op: &LinkOp, undo: bool, actor: &str) -> Result<(), String> {
    let record = op.record.clone().unwrap_or_default();
    run_host_steps(library, root, review, &record, if undo { &op.inverse } else { &op.forward })?;
    reviews.link_step(review, op, undo, actor)
}

/// ⌘Z / ⇧⌘Z in the review for link operations done there. Answers what was undone (or redone).
pub fn undo(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, actor: &str, redo: bool) -> Result<Option<LinkOp>, String> {
    let Some(op) = reviews.link_undo_target(review, actor, redo)? else { return Ok(None) };
    step_op(library, root, reviews, review, &op, !redo, actor)?;
    Ok(Some(op))
}

/// The library's ⌘Z / ⇧⌘Z: the journal entry stepped, then its review part (an operation done
/// in the library on a linked record) undone or redone the same way.
pub fn library_step(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, undo: bool) -> Result<Option<key_store::JournalEntry>, String> {
    let entry = if undo { library.store().undo()? } else { library.store().redo()? };
    if let Some(entry) = &entry {
        for ext in &entry.external {
            let (Some(review), Some(op)) = (ext.get("reviewId").and_then(Json::as_str), ext.get("op").and_then(Json::as_str)) else { continue };
            let Some(found) = reviews.link_op(review, op)? else { continue };
            let actor = found.actor.clone();
            step_op(library, root, reviews, review, &found, undo, &actor)?;
        }
    }
    Ok(entry)
}

/// "Take from the library / the review / keep as they are" for some fields of a linked record.
pub fn take(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, record: &str, picks: &[(String, String)], origin: &str, actor: &str) -> Result<Json, String> {
    let source = reviews.read(review, |s, _| Ok(s.record(record).ok_or("This record no longer exists")?.source_id.clone()))?.ok_or("This record is not linked to the library")?;
    let (s, lib) = source_meta(library, &source).ok_or("Its library source no longer exists")?;
    let meta = reviews.metas(review, &[record.to_string()])?.remove(record).ok_or("This record no longer exists")?;
    let plan = reviews.read(review, |state, _| sync::plan_take(state, &meta, &lib, &s.id, picks))?;
    perform(library, root, reviews, review, plan, origin, actor)
}

/// The library's details win (the review's policy): every differing field the library has
/// taken over, without asking (not on the undo stack: the review chose it in Setup).
pub fn settle_by_policy(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, actor: &str) -> Result<usize, String> {
    let library_wins = reviews.read(review, |s, _| Ok(sync::policy(s) == "library"))?;
    if !library_wins {
        return Ok(0);
    }
    let linked: Vec<(String, String)> = reviews.read(review, |s, _| Ok(s.records.iter().filter(|r| s.active(r)).filter_map(|r| Some((r.id.clone(), r.source_id.clone()?))).collect()))?;
    let metas = reviews.metas(review, &linked.iter().map(|(r, _)| r.clone()).collect::<Vec<_>>())?;
    let mut settled = 0;
    for (record, source) in linked {
        let (Some(meta), Some((s, lib))) = (metas.get(&record), source_meta(library, &source)) else { continue };
        let picks: Vec<(String, String)> = reviews.read(review, |state, _| Ok(sync::compare(state, meta, &lib, &s.id).fields.into_iter().filter(|f| f.state != "reviewOnly").map(|f| (f.field, "library".to_string())).collect()))?;
        if picks.is_empty() {
            continue;
        }
        let plan = reviews.read(review, |state, _| sync::plan_take(state, meta, &lib, &s.id, &picks))?;
        perform(library, root, reviews, review, plan, "auto", actor)?;
        settled += 1;
    }
    Ok(settled)
}

/// Links a record to a source the person confirmed is the same work; a file only one side has
/// becomes both sides' (a different file on each side is left for the person to choose).
pub fn confirm(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, record: &str, source: &str, origin: &str, actor: &str) -> Result<Json, String> {
    let s = live_source(library, source).filter(|s| s.trashed_at.is_none()).ok_or("This library source no longer exists")?;
    let (mut plan, own) = reviews.read(review, |state, _| Ok((sync::plan_link(state, record, &s.id)?, state.record(record).and_then(|r| r.fulltext.file.clone()))))?;
    let library_has = library.store().full_texts(&s.id)?.iter().any(|f| f.primary && matches!(f.kind.as_str(), "pdf" | "web"));
    let mut conflict = None;
    match (&own, s.file_hash()) {
        (Some(f), None) => {
            plan.host(json!({ "do": "file", "sourceId": s.id, "hash": f.hash, "path": review_file_path(root, review, f).to_string_lossy() }));
            plan.review("fulltext.set", json!({ "file": null, "status": "retrieved" }), json!({}));
        }
        (Some(f), Some(have)) if have == f.hash => plan.review("fulltext.set", json!({ "file": null, "status": "retrieved" }), json!({})),
        (Some(f), Some(have)) => conflict = Some(json!({ "recordId": record, "sourceId": s.id, "libraryHash": have, "libraryMime": s.field("mime"), "reviewHash": f.hash })),
        (None, _) if library_has => plan.review("fulltext.set", json!({ "status": "retrieved" }), json!({})),
        (None, _) => {}
    }
    let mut out = perform(library, root, reviews, review, plan, origin, actor)?;
    out["conflict"] = conflict.unwrap_or(Json::Null);
    Ok(out)
}

/// Unlinks a record; it keeps the library's file as its own copy (copied, never moved).
pub fn unlink(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, record: &str, origin: &str, actor: &str) -> Result<Json, String> {
    let (source, own) = reviews.read(review, |s, _| {
        let r = s.record(record).ok_or("This record no longer exists")?;
        Ok((r.source_id.clone().ok_or("This record is not linked to the library")?, r.fulltext.file.is_some()))
    })?;
    let mut copy = None;
    if !own {
        if let Some(s) = live_source(library, &source) {
            if let (Some(path), Some(hash)) = (s.file_path().filter(|p| p.is_file()), s.file_hash()) {
                let mime = s.field("mime").unwrap_or("application/pdf").to_string();
                let ext = extension(&path.to_string_lossy(), &mime);
                let dir = files_dir(root, review);
                std::fs::create_dir_all(&dir).map_err(|e| format!("Could not keep the file: {e}"))?;
                let stored = dir.join(format!("{hash}.{ext}"));
                if !stored.is_file() {
                    std::fs::copy(&path, &stored).map_err(|e| format!("Could not keep the file: {e}"))?;
                }
                let size = std::fs::metadata(&stored).map(|m| m.len()).unwrap_or(0);
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                copy = Some(json!(key_review::derive::FileRef { hash: hash.into(), name, mime: mime_of(&ext).into(), size, origin: "library".into() }));
            }
        }
    }
    let plan = reviews.read(review, |state, _| sync::plan_unlink(state, record, copy))?;
    perform(library, root, reviews, review, plan, origin, actor)
}

pub fn reject(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, record: &str, source: &str, origin: &str, actor: &str) -> Result<Json, String> {
    let plan = reviews.read(review, |state, _| sync::plan_reject(state, record, source))?;
    perform(library, root, reviews, review, plan, origin, actor)
}

/// The person's choice for a linked record whose review file and library file differ (see
/// library_links::reconcile), as an operation: "library", "review" or "both".
pub fn reconcile(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, record: &str, choice: &str, actor: &str) -> Result<Json, String> {
    let (file, source) = reviews.read(review, |s, _| {
        let r = s.record(record).ok_or("This record no longer exists")?;
        Ok((r.fulltext.file.clone(), r.source_id.clone()))
    })?;
    let source = source.and_then(|id| live_source(library, &id)).ok_or("This record is not linked to a library source")?;
    let was_both = kept_both(root, review).contains(record);
    let mut plan = Plan::new(
        match choice {
            "library" => "Use the library's file",
            "review" => "Use the review's file in the library",
            _ => "Keep both files",
        },
        record,
    );
    let before = reviews.read(review, |s, _| Ok(sync::fulltext_now(s, record)))?;
    match choice {
        "library" => {
            if was_both {
                plan.host(json!({ "do": "keepBoth", "on": false }));
            }
            plan.review("fulltext.set", json!({ "file": null, "status": "retrieved", "sourceId": source.id }), before);
        }
        "review" => {
            let f = file.ok_or("The record keeps no file of its own")?;
            if was_both {
                plan.host(json!({ "do": "keepBoth", "on": false }));
            }
            plan.host(json!({ "do": "file", "sourceId": source.id, "hash": f.hash, "path": review_file_path(root, review, &f).to_string_lossy() }));
            plan.review("fulltext.set", json!({ "file": null, "status": "retrieved", "sourceId": source.id }), before);
        }
        "both" => plan.host(json!({ "do": "keepBoth", "on": true })),
        _ => return Err("Choose the library's file, the review's, or both".into()),
    }
    let mut out = perform(library, root, reviews, review, plan, "review", actor)?;
    out["choice"] = json!(choice);
    out["sourceId"] = json!(source.id);
    Ok(out)
}

/// A full text found in the review for a linked record whose source has none: the library
/// takes it, as an operation (undo leaves it one of the source's other full texts).
pub fn share_new(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, record: &str, source: &str, path: &Path, hash: &str, actor: &str) -> Result<Json, String> {
    let before = reviews.read(review, |s, _| Ok(sync::fulltext_now(s, record)))?;
    let mut plan = Plan::new("Share the full text with the library", record);
    plan.host(json!({ "do": "file", "sourceId": source, "hash": hash, "path": path.to_string_lossy() }));
    plan.review("fulltext.set", json!({ "status": "retrieved", "sourceId": source }), before);
    perform(library, root, reviews, review, plan, "review", actor)
}

/// Open readers showing a file that is no longer its source's primary full text, for sources
/// linked in a review (the shared file was replaced from either side): old hash → the new.
pub fn reader_follow(library: &dyn LinkLibrary, reviews: &Reviews, hashes: &[String]) -> Result<Json, String> {
    let mut out = Map::new();
    for hash in hashes {
        if library.store().source_by_hash(hash)?.is_some_and(|s| s.file_hash() == Some(hash.as_str())) {
            continue;
        }
        for id in library.store().sources_keeping(hash)? {
            let Some(s) = live_source(library, &id).filter(|s| s.trashed_at.is_none()) else { continue };
            let Some(now) = s.file_hash().filter(|h| *h != hash) else { continue };
            let linked = library_links::links_for_source(library, reviews, &s.id).ok().and_then(|v| v.as_array().map(|a| !a.is_empty())).unwrap_or(false);
            if linked && s.field("mime").is_none_or(|m| m.contains("pdf")) {
                out.insert(hash.clone(), json!({ "sourceId": s.id, "hash": now }));
                break;
            }
        }
    }
    Ok(Json::Object(out))
}

// ── Possible matches ──────────────────────────────────────────────────────────────────

/// Suggestions per review, kept while neither the review nor the library changed.
static SUGGESTIONS: Mutex<Vec<(String, usize, i64, Json)>> = Mutex::new(Vec::new());

fn library_stamp(library: &dyn LinkLibrary) -> i64 {
    library.store().journal_state(1).ok().and_then(|j| j.undo.map(|e| e.seq)).unwrap_or(0) + with_log(library, |c| c.last).unwrap_or(0)
}

/// Records likely to be works the library has (title, year and first author, or identifiers
/// the duplicate matcher scores): suggestions to confirm, never linked without a yes. Rejected
/// pairs are left out; each record's best match first.
pub fn suggestions(library: &dyn LinkLibrary, reviews: &Reviews, review: &str) -> Result<Json, String> {
    pump(library);
    let events = reviews.read(review, |s, _| Ok(s.events))?;
    let stamp = library_stamp(library);
    if let Ok(cache) = SUGGESTIONS.lock() {
        if let Some((_, _, _, v)) = cache.iter().find(|(r, e, l, _)| r == review && *e == events && *l == stamp) {
            return Ok(v.clone());
        }
    }
    let ids = reviews.read(review, |s, _| Ok(sync::unlinked(s)))?;
    let metas = reviews.metas(review, &ids)?;
    let mut out = Vec::new();
    for chunk in ids.chunks(500) {
        key_store::priority::yield_if_needed();
        let list: Vec<&RecordMeta> = chunk.iter().filter_map(|id| metas.get(id)).collect();
        let works: Vec<key_store::duplicates::Work> = list.iter().map(|m| import::work(m)).collect();
        let found = library.store().find_duplicates_for(&works)?;
        for (meta, matches) in list.iter().zip(found) {
            let best = reviews.read(review, |s, _| Ok(matches.into_iter().filter(|m| m.kind != key_store::duplicates::MatchKind::Version && !s.link.is_rejected(&meta.id, &m.source_id)).find(|m| live_source(library, &m.source_id).is_some_and(|x| x.trashed_at.is_none() && x.id == m.source_id))))?;
            let Some(best) = best else { continue };
            let Some((s, lib)) = source_meta(library, &best.source_id) else { continue };
            out.push(json!({
                "recordId": meta.id,
                "sourceId": s.id,
                "kind": best.kind,
                "score": best.score,
                "reason": best.reason,
                "record": { "title": meta.title, "byline": meta.byline(), "journal": meta.journal, "year": meta.year, "doi": meta.doi },
                "source": { "title": lib.title, "byline": lib.byline(), "journal": lib.journal, "year": lib.year, "doi": lib.doi, "hasFile": s.file_hash().is_some() },
            }));
        }
    }
    let v = json!({ "count": out.len(), "suggestions": out });
    if let Ok(mut cache) = SUGGESTIONS.lock() {
        cache.retain(|(r, ..)| r != review);
        cache.push((review.to_string(), events, stamp, v.clone()));
    }
    Ok(v)
}

/// Review records that may be this library source (its page's "In review" row).
pub fn suggestions_for_source(library: &dyn LinkLibrary, reviews: &Reviews, source: &str) -> Result<Json, String> {
    let s = live_source(library, source).ok_or("Source not found")?;
    let work = import::work(&import::from_source(&s));
    let mut out = Vec::new();
    for item in reviews.list_reviews()? {
        let Some(id) = item.get("id").and_then(Json::as_str) else { continue };
        let name = item.get("name").and_then(Json::as_str).unwrap_or("Review").to_string();
        let ids = reviews.read(id, |st, _| Ok(sync::unlinked(st)))?;
        let metas = reviews.metas(id, &ids)?;
        let mut index = key_store::duplicates::WorkIndex::default();
        for m in metas.values() {
            index.add(&m.id, &import::work(m));
        }
        for m in index.find(&work) {
            if m.kind == key_store::duplicates::MatchKind::Version || reviews.read(id, |st, _| Ok(st.link.is_rejected(&m.source_id, &s.id)))? {
                continue;
            }
            let Some(meta) = metas.get(&m.source_id) else { continue };
            out.push(json!({ "reviewId": id, "reviewName": name, "recordId": meta.id, "kind": m.kind, "reason": m.reason, "record": { "title": meta.title, "byline": meta.byline(), "journal": meta.journal, "year": meta.year } }));
        }
    }
    Ok(json!(out))
}

// ── Library changes that reach open review views ─────────────────────────────────────

/// Recent changes to sources (from the library's change log, as the "reviews" consumer):
/// each open review view asks which of its linked records changed since it last asked.
struct ChangeLog {
    entries: VecDeque<(i64, String, String)>,
    last: i64,
    /// Changes up to here fell out of the log (a view behind them reloads everything).
    dropped: i64,
}
/// One log per library store (the host has one; tests several at once).
static CHANGES: Mutex<Vec<(usize, ChangeLog)>> = Mutex::new(Vec::new());
const KEEP_CHANGES: usize = 20_000;
const CONSUMER: &str = "reviews";

fn store_key(library: &dyn LinkLibrary) -> usize {
    library.store() as *const key_store::Store as usize
}

fn with_log<R>(library: &dyn LinkLibrary, f: impl FnOnce(&mut ChangeLog) -> R) -> Option<R> {
    let key = store_key(library);
    let mut all = CHANGES.lock().ok()?;
    if !all.iter().any(|(k, _)| *k == key) {
        all.push((key, ChangeLog { entries: VecDeque::new(), last: 0, dropped: 0 }));
    }
    all.iter_mut().find(|(k, _)| *k == key).map(|(_, log)| f(log))
}

fn pump(library: &dyn LinkLibrary) {
    with_log(library, |log| {
        for _ in 0..20 {
            let Ok(batch) = library.store().changes_since(CONSUMER, 2000) else { return };
            let Some(last) = batch.last().map(|c| c.seq) else { return };
            for c in batch {
                log.entries.push_back((c.seq, c.source_id, c.kind));
            }
            while log.entries.len() > KEEP_CHANGES {
                if let Some((seq, ..)) = log.entries.pop_front() {
                    log.dropped = seq;
                }
            }
            log.last = log.last.max(last);
            let _ = library.store().changes_ack(CONSUMER, last);
        }
    });
}

/// What a change of this kind means for a linked record: its details, or its file.
fn kind_of(kind: &str) -> Option<&'static str> {
    match kind {
        "files" | "text" => Some("file"),
        "trashed" | "merged" | "removed" => Some("link"),
        k if sync::FIELDS.iter().any(|(f, _)| sync::library_key(f) == k) || matches!(k, "creators" | "year" | "title" | "itemType") => Some("details"),
        _ => None,
    }
}

/// Linked records of `review` whose sources changed after `since` (a view's last answer):
/// `{latest, records: {recordId: ["details"|"file"|"link"]}, all}`; `all` when the view is
/// further behind than the log reaches (it reloads everything).
pub fn changes(library: &dyn LinkLibrary, reviews: &Reviews, review: &str, since: i64) -> Result<Json, String> {
    pump(library);
    let (last, dropped, entries) = with_log(library, |log| {
        (log.last, log.dropped, log.entries.iter().filter(|(s, ..)| *s > since).cloned().collect::<Vec<_>>())
    })
    .ok_or("The change log is busy")?;
    if since < 0 || since > last {
        return Ok(json!({ "latest": last, "records": {}, "all": since > last }));
    }
    let all = since < dropped;
    let by_source: HashMap<String, Vec<String>> = reviews.read(review, |s, _| {
        let mut m: HashMap<String, Vec<String>> = HashMap::new();
        for r in &s.records {
            if let Some(src) = &r.source_id {
                m.entry(src.clone()).or_default().push(r.id.clone());
            }
        }
        Ok(m)
    })?;
    let mut records: HashMap<String, std::collections::BTreeSet<&str>> = HashMap::new();
    for (_, source, kind) in &entries {
        let (Some(what), Some(recs)) = (kind_of(kind), by_source.get(source)) else { continue };
        for r in recs {
            records.entry(r.clone()).or_default().insert(what);
        }
    }
    Ok(json!({ "latest": last, "records": records, "all": all }))
}

// ── The user's highlights on review-only full texts ──────────────────────────────────

/// The highlights the reader shows on a record's full text: the library's when the record
/// reads its source's file, else the review's own.
pub fn highlights(reviews: &Reviews, review: &str, record: &str) -> Result<Json, String> {
    Ok(json!(reviews.highlights(review, record)?))
}

/// Saves the reader's highlights on a review-only full text, each with the file it was made on.
pub fn apply_highlights(reviews: &Reviews, review: &str, record: &str, upserts: Vec<Json>, deleted: Vec<String>, actor: &str) -> Result<(), String> {
    let hash = reviews.read(review, |s, _| Ok(s.record(record).and_then(|r| r.fulltext.file.as_ref().map(|f| f.hash.clone()))))?;
    let upserts = upserts
        .into_iter()
        .map(|mut a| {
            if let (Some(h), Some(o)) = (&hash, a.as_object_mut()) {
                o.entry("fileHash").or_insert(json!(h));
            }
            a
        })
        .collect();
    reviews.set_highlights(review, record, upserts, deleted, actor)
}

/// The review's highlights on a record now reading its library source's file: those made on
/// that same file can go to the library copy (`carry` moves them, as an undoable operation).
pub fn carry_highlights(library: &dyn LinkLibrary, root: &Path, reviews: &Reviews, review: &str, record: &str, carry: bool, actor: &str) -> Result<Json, String> {
    let (source, own, list) = reviews.read(review, |s, _| {
        let r = s.record(record).ok_or("This record no longer exists")?;
        Ok((r.source_id.clone(), r.fulltext.file.is_some(), s.link.highlights.get(record).map(|h| h.values().cloned().collect::<Vec<_>>()).unwrap_or_default()))
    })?;
    let Some(source) = source.filter(|_| !own).and_then(|s| live_source(library, &s)) else { return Ok(json!({ "count": 0 })) };
    let Some(hash) = source.file_hash().map(str::to_string) else { return Ok(json!({ "count": 0 })) };
    let same: Vec<Json> = list.into_iter().filter(|a| a.get("fileHash").and_then(Json::as_str).is_none_or(|h| h == hash)).collect();
    if !carry || same.is_empty() {
        return Ok(json!({ "count": same.len(), "sourceId": source.id }));
    }
    let ids: Vec<String> = same.iter().filter_map(|a| a.get("id").and_then(Json::as_str).map(str::to_string)).collect();
    let mut plan = Plan::new(format!("Move {} to the library copy", if same.len() == 1 { "1 highlight".to_string() } else { format!("{} highlights", same.len()) }), record);
    let upserts: Vec<Json> = same
        .iter()
        .map(|a| {
            let mut a = a.clone();
            if let Some(o) = a.as_object_mut() {
                o.remove("fileHash");
            }
            a
        })
        .collect();
    plan.host(json!({ "do": "annotations", "sourceId": source.id, "upserts": upserts, "deleted": [] }));
    plan.review("highlight.set", json!({ "upserts": [], "deleted": ids }), json!({ "upserts": same, "deleted": [] }));
    let mut out = perform(library, root, reviews, review, plan, "review", actor)?;
    out["count"] = json!(ids.len());
    Ok(out)
}

#[cfg(test)]
#[path = "library_sync_tests.rs"]
mod tests;
