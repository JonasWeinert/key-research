// Systematic reviews (`review_*`, crates/key-review): the workspace's reviews live in their own
// SQLite file beside the library. Records come from files, the library (sources, a collection,
// a filter) and database search runs (through the `db_*` commands, never their internals).
// The library answers the rules' questions about linked sources (custom properties, files) and
// gets a source when a record needs its full text.
use super::databases::Databases;
use super::library_store::Library;
use super::web_search::{self, StoreLibrary};
use crate::ipc::{Output, arg, json_output};
use key_review::derive::Share;
use key_review::export::AnalysisRequest;
use key_review::model::{Batch, Choice, Member, Protocol, RecordMeta, Stage};
use key_review::views::ListQuery;
use key_review::{Reviews, import};
use key_store::{ListQuery as SourceQuery, SourceInput};
use serde_json::{Map, Value as Json, json};
use std::path::Path;
use std::sync::{Arc, OnceLock};

static REVIEWS: OnceLock<Result<Reviews, String>> = OnceLock::new();

fn reviews(root: &Path) -> Result<&'static Reviews, String> {
    REVIEWS.get_or_init(|| Reviews::open(root)).as_ref().map_err(Clone::clone)
}

/// The library's view for the rules: custom properties and whether a source has a file.
struct Lookup<'a>(&'a Library);
impl key_review::Library for Lookup<'_> {
    fn properties(&self, source_id: &str) -> Map<String, Json> {
        self.0.store.source(source_id).ok().flatten().map(|s| s.properties).unwrap_or_default()
    }
    /// Full text to read: a PDF or a saved web page (key-store full_text.rs), its file or kept beside it.
    fn has_file(&self, source_id: &str) -> bool {
        self.0.store.full_texts(source_id).is_ok_and(|all| all.iter().any(|f| matches!(f.kind.as_str(), "pdf" | "web")))
    }
    /// The library's copy of the same work, with the fields a review record may lack.
    fn same_work(&self, meta: &RecordMeta) -> Option<(String, Map<String, Json>)> {
        let found = self.0.store.find_duplicates_for(&[import::work(meta)]).ok()?.into_iter().next()?;
        let id = found.into_iter().find(|m| m.kind == key_store::duplicates::MatchKind::Exact)?.source_id;
        let source = self.0.store.source(&id).ok()??;
        let mut out = Map::new();
        for (from, to) in [("abstract", "abstractText"), ("doi", "doi"), ("pmid", "pmid"), ("containerTitle", "journal"), ("volume", "volume"), ("issue", "issue"), ("pages", "pages"), ("language", "language")] {
            if let Some(v) = source.field(from).filter(|v| !v.trim().is_empty()) {
                out.insert(to.into(), json!(v));
            }
        }
        if let Some(y) = source.fields.get("year").and_then(|y| y.as_i64().or_else(|| y.as_str().and_then(|t| t.get(..4)?.parse().ok()))) {
            out.insert("year".into(), json!(y));
        }
        Some((id, out))
    }
}

/// Where the review keeps the full texts it holds itself (not library sources).
fn files_dir(root: &Path, review: &str) -> std::path::PathBuf {
    root.join("reviews").join(review).join("files")
}

fn extension(name: &str, mime: &str) -> String {
    let ext = Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "pdf" | "html" | "htm" | "epub" | "docx" | "txt" => ext,
        _ if mime.contains("html") => "html".into(),
        _ => "pdf".into(),
    }
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "html" | "htm" => "text/html",
        "epub" => "application/epub+zip",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "txt" => "text/plain",
        _ => "application/pdf",
    }
}

/// A full text for a record: linked when the library already has the file (same content),
/// else copied into the review's own files. A temporary file handed over (a found PDF, a page
/// snapshot) is removed with its folder once copied.
fn attach_full_text(root: &Path, library: &Library, reviews: &Reviews, review: &str, record: &str, path: &Path, name: &str, origin: &str, owned_temp: bool, actor: &str) -> Result<Json, String> {
    if !path.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    let hash = key_index::file_hash(path)?;
    // The same file again: nothing to add.
    let same = reviews.read(review, |s, _| Ok(s.record(record).and_then(|r| r.fulltext.file.as_ref()).is_some_and(|f| f.hash == hash)))?;
    if same {
        if owned_temp {
            if let Some(parent) = path.parent().filter(|p| p.starts_with(std::env::temp_dir()) && *p != std::env::temp_dir()) {
                let _ = std::fs::remove_dir_all(parent);
            }
        }
        return Ok(json!({ "same": true, "hash": hash }));
    }
    let name = if name.trim().is_empty() { path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default() } else { name.to_string() };
    let result = if let Some(source) = library.store.source_by_hash(&hash)?.filter(|s| s.trashed_at.is_none()) {
        reviews.fulltext(review, record, Some("retrieved"), None, Some(Some(&source.id)), actor)?;
        json!({ "linked": source.id, "hash": hash })
    } else {
        let ext = extension(&name, "");
        let dir = files_dir(root, review);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Could not keep the file: {e}"))?;
        let stored = dir.join(format!("{hash}.{ext}"));
        if !stored.is_file() {
            std::fs::copy(path, &stored).map_err(|e| format!("Could not keep the file: {e}"))?;
        }
        let size = std::fs::metadata(&stored).map(|m| m.len()).unwrap_or(0);
        let file = key_review::derive::FileRef { hash: hash.clone(), name, mime: mime_of(&ext).into(), size, origin: origin.into() };
        reviews.attach_file(review, record, file.clone(), actor)?;
        json!({ "file": file, "hash": hash })
    };
    if owned_temp {
        if let Some(parent) = path.parent().filter(|p| p.starts_with(std::env::temp_dir()) && *p != std::env::temp_dir()) {
            let _ = std::fs::remove_dir_all(parent);
        }
    }
    Ok(result)
}

/// The path of a record's full text: the review's own file, else its library source's.
fn full_text_path(root: &Path, library: &Library, reviews: &Reviews, review: &str, record: &str) -> Result<(std::path::PathBuf, String), String> {
    let (file, source) = reviews.read(review, |s, _| {
        let r = s.record(record).ok_or("This record no longer exists")?;
        Ok((r.fulltext.file.clone(), r.source_id.clone()))
    })?;
    if let Some(f) = file {
        let ext = extension(&f.name, &f.mime);
        return Ok((files_dir(root, review).join(format!("{}.{ext}", f.hash)), f.mime));
    }
    let source = source.ok_or("This record has no full text yet")?;
    let s = library.store.source(&source)?.ok_or("Its library source no longer exists")?;
    let path = s.file_path().ok_or("Its library source has no file yet")?;
    let mime = s.field("mime").unwrap_or("application/pdf").to_string();
    Ok((path, mime))
}

fn stage(args: &Json) -> Result<Stage, String> {
    Stage::parse(args.get("stage").and_then(Json::as_str).unwrap_or("ta"))
}

fn text<'a>(args: &'a Json, key: &str) -> &'a str {
    args.get(key).and_then(Json::as_str).unwrap_or("")
}

fn strings(args: &Json, key: &str) -> Vec<String> {
    args.get(key).and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect()).unwrap_or_default()
}

/// A database search result row as a review record.
fn from_db_row(row: &Json) -> RecordMeta {
    let s = |k: &str| row.get(k).and_then(Json::as_str).unwrap_or("").trim().to_string();
    let authors = row.get("authors").and_then(Json::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string).or_else(|| x.get("name").and_then(Json::as_str).map(str::to_string))).collect()).unwrap_or_default();
    let keywords = row.get("keywords").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect()).unwrap_or_default();
    let mut extra = Map::new();
    for key in ["foundBy", "provenance", "issn", "isbn", "publisher"] {
        if let Some(v) = row.get(key).filter(|v| !v.is_null()) {
            extra.insert(key.into(), v.clone());
        }
    }
    RecordMeta {
        id: key_review::events::uuid7(),
        title: s("title"),
        abstract_text: s("abstract"),
        authors,
        year: row.get("year").and_then(|y| y.as_i64().or_else(|| y.as_str().and_then(|t| t.get(..4)?.parse().ok()))),
        journal: if s("venue").is_empty() { s("containerTitle") } else { s("venue") },
        doi: s("doi"),
        pmid: row.pointer("/ids/pmid").and_then(Json::as_str).unwrap_or("").to_string(),
        url: s("url"),
        item_type: match s("recordType").as_str() {
            "" | "article" | "journal-article" => "journalArticle".into(),
            other => other.into(),
        },
        language: s("language"),
        keywords,
        source_id: row.get("inLibrary").and_then(Json::as_str).map(str::to_string),
        extra,
        ..Default::default()
    }
}

fn batch_from(args: &Json, kind: &str) -> Result<Batch, String> {
    let mut batch: Batch = serde_json::from_value(args.get("batch").cloned().unwrap_or(json!({}))).map_err(|e| format!("Invalid batch: {e}"))?;
    batch.kind = kind.into();
    batch.id = String::new();
    Ok(batch)
}

fn call_db(databases: &Arc<Databases>, web: &web_search::WebSearch, library: &StoreLibrary, command: &str, args: Json) -> Result<Json, String> {
    match databases.dispatch(web, library, command, &args) {
        Some(Ok(Output::Json(v))) => Ok(v),
        Some(Ok(_)) => Err("Unexpected answer from database search".into()),
        Some(Err(e)) => Err(e),
        None => Err(format!("Database search has no {command}")),
    }
}

/// What PRISMA counts each connector's records as (database | register | repository | other),
/// by the connector's id and its name.
fn connector_kinds(databases: &Arc<Databases>, web: &web_search::WebSearch, library: &StoreLibrary) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    if let Ok(Json::Array(list)) = call_db(databases, web, library, "db_connectors", json!({})) {
        for c in list {
            let kind = c.get("prisma").and_then(Json::as_str).unwrap_or("database").to_string();
            for key in ["id", "name"] {
                if let Some(k) = c.get(key).and_then(Json::as_str) {
                    out.insert(k.to_string(), kind.clone());
                }
            }
        }
    }
    out
}

/// A database search run's records and its PRISMA identification numbers.
/// `keys` (the run's work keys) keeps only those works, every version of each.
fn database_run(databases: &Arc<Databases>, web: &web_search::WebSearch, library: &StoreLibrary, run: &str, keys: &[String]) -> Result<(Batch, Vec<RecordMeta>), String> {
    let wanted = |row: &&Json| keys.is_empty() || row.get("key").and_then(Json::as_str).is_some_and(|k| keys.iter().any(|w| w == k));
    let report = call_db(databases, web, library, "db_run", json!({ "runId": run }))?;
    let mut batch = Batch { kind: "database".into(), group: "databases".into(), db_run_id: run.into(), ..Default::default() };
    batch.name = report.get("label").and_then(Json::as_str).filter(|l| !l.trim().is_empty()).unwrap_or("Database search").to_string();
    batch.searched_at = report.get("startedAt").and_then(Json::as_i64).map(|ms| ms.to_string()).unwrap_or_default();
    if let Some(sources) = report.get("sources").and_then(Json::as_array) {
        let mut lines = Vec::new();
        for s in sources {
            let name = s.get("name").and_then(Json::as_str).or_else(|| s.get("connector").and_then(Json::as_str)).unwrap_or("Database").to_string();
            let fetched = s.get("fetched").and_then(Json::as_u64).unwrap_or(0) as usize;
            batch.per_source.insert(name.clone(), fetched);
            let strategy = s.pointer("/strategy/original").and_then(Json::as_str).or_else(|| s.get("native").and_then(Json::as_str)).unwrap_or("");
            if !strategy.is_empty() {
                lines.push(format!("{name}: {strategy}"));
            }
        }
        batch.strategy = lines.join("\n");
    }
    if let Ok(strategy) = call_db(databases, web, library, "db_strategy", json!({ "runId": run, "format": "text" })) {
        if let Some(t) = strategy.get("content").and_then(Json::as_str).filter(|t| !t.trim().is_empty()) {
            batch.strategy = t.to_string();
        }
    }
    // Every version each database found, so the review's own de-duplication shows the numbers;
    // a run that is no longer in memory gives its unique records and the duplicates it removed.
    let mut records = Vec::new();
    let mut offset = 0;
    let live = loop {
        match call_db(databases, web, library, "db_results", json!({ "runId": run, "dedupe": false, "offset": offset, "limit": 2000 })) {
            Ok(page) => {
                let rows = page.get("rows").or_else(|| page.get("records")).and_then(Json::as_array).cloned().unwrap_or_default();
                records.extend(rows.iter().filter(wanted).map(from_db_row));
                let listed = page.get("listed").and_then(Json::as_u64).unwrap_or(0) as usize;
                offset += rows.len();
                if rows.is_empty() || offset >= listed {
                    break true;
                }
            }
            Err(_) => break false,
        }
    };
    if !live {
        records = report.get("records").and_then(Json::as_array).map(|a| a.iter().filter(wanted).map(from_db_row).collect()).unwrap_or_default();
        if keys.is_empty() {
            batch.duplicates_removed = report.get("duplicatesRemoved").and_then(Json::as_u64).unwrap_or(0) as usize;
        }
    }
    if !keys.is_empty() {
        // A selection: the run's per-database totals are not what was sent.
        batch.per_source.clear();
    }
    // Registers (ClinicalTrials.gov, WHO ICTRP …) searched in the same run go to PRISMA's
    // register box, not the databases'.
    let kinds = connector_kinds(databases, web, library);
    batch.per_source_kind = batch.per_source.keys().filter_map(|n| kinds.get(n).map(|k| (n.clone(), k.clone()))).collect();
    if batch.per_source.is_empty() && !records.is_empty() {
        // No per-database counts: a run that searched only registers is a register import.
        let found: std::collections::HashSet<String> = records.iter().filter_map(|r| r.extra.get("foundBy")).filter_map(Json::as_array).flatten().filter_map(Json::as_str).map(str::to_string).collect();
        if !found.is_empty() && found.iter().all(|c| kinds.get(c).map(String::as_str) == Some("register")) {
            batch.group = "registers".into();
        }
    }
    batch.count = records.len() + batch.duplicates_removed;
    if !batch.per_source.is_empty() && !live {
        // per_source counts what each database returned; keep them as identified.
        batch.count = batch.per_source.values().sum();
    }
    Ok((batch, records))
}

/// Search runs imported before databases and registers were told apart: classified once from
/// the connectors' kinds (an event in the review's log).
fn classify_runs(reviews: &Reviews, review: &str, databases: &Arc<Databases>, web: &web_search::WebSearch, library: &Library, root: &Path) {
    let pending = reviews.read(review, |s, _| Ok(s.batches.iter().any(|b| !b.db_run_id.is_empty() && !b.per_source.is_empty() && b.per_source_kind.is_empty()))).unwrap_or(false);
    if pending {
        let store_library = StoreLibrary { library, root };
        let _ = reviews.classify_batches(review, &connector_kinds(databases, web, &store_library));
    }
}

/// Library sources for records that have none (to find and read their full text): an existing
/// source when the library has the work already, else a new reference.
fn link_to_library(library: &Library, reviews: &Reviews, review: &str, ids: &[String], actor: &str) -> Result<Json, String> {
    let metas = reviews.metas(review, ids)?;
    let linked: std::collections::HashMap<String, Option<String>> = reviews.read(review, |s, _| Ok(ids.iter().map(|id| (id.clone(), s.record(id).and_then(|r| r.source_id.clone()))).collect()))?;
    let mut out = Map::new();
    for id in ids {
        if let Some(Some(source)) = linked.get(id) {
            out.insert(id.clone(), json!(source));
            continue;
        }
        let Some(meta) = metas.get(id) else { continue };
        let work = import::work(meta);
        let existing = library.store.find_duplicates_for(&[work])?.into_iter().next().unwrap_or_default().into_iter().find(|m| m.kind == key_store::duplicates::MatchKind::Exact).map(|m| m.source_id);
        let source = match existing {
            Some(s) => s,
            None => {
                let mut input = SourceInput { kind: "reference".into(), ..Default::default() };
                let mut put = |k: &str, v: &str| {
                    if !v.trim().is_empty() {
                        input.fields.insert(k.into(), json!(v));
                    }
                };
                put("itemType", if meta.item_type.is_empty() { "journalArticle" } else { &meta.item_type });
                put("title", &meta.title);
                put("abstract", &meta.abstract_text);
                put("containerTitle", &meta.journal);
                put("volume", &meta.volume);
                put("issue", &meta.issue);
                put("pages", &meta.pages);
                put("doi", &meta.doi);
                put("pmid", &meta.pmid);
                put("url", &meta.url);
                put("language", &meta.language);
                if let Some(y) = meta.year {
                    input.fields.insert("date".into(), json!(y.to_string()));
                    input.fields.insert("year".into(), json!(y));
                }
                input.creators = meta
                    .authors
                    .iter()
                    .map(|a| match a.split_once(',') {
                        Some((f, g)) => key_store::Creator { family: Some(f.trim().into()), given: Some(g.trim().into()), literal: None, role: "author".into(), person_id: None },
                        None => key_store::Creator { family: None, given: None, literal: Some(a.clone()), role: "author".into(), person_id: None },
                    })
                    .collect();
                input.origin = Some("review".into());
                library.store.insert_sources(vec![input])?.into_iter().next().ok_or("Could not add the record to the library")?
            }
        };
        reviews.fulltext(review, id, None, None, Some(Some(&source)), actor)?;
        out.insert(id.clone(), json!(source));
    }
    library.indexer.wake();
    Ok(Json::Object(out))
}

/// What AI pre-fill reads for a study: its abstract, then the linked source's text page by page
/// (the library's indexed passages, in order).
fn study_passages(library: &Library, meta: &RecordMeta, source: Option<&str>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if !meta.abstract_text.trim().is_empty() {
        out.push(("Abstract".to_string(), meta.abstract_text.clone()));
    }
    let Some(source) = source else { return out };
    let mut total = 0usize;
    for page in 0..60i64 {
        let Ok(Some(first)) = library.store.page_chunk(source, page) else { continue };
        let mut text = String::new();
        let mut id = first;
        while let Ok(Some(p)) = library.store.passage(id) {
            if p.source_id != source || p.page != page {
                break;
            }
            text.push_str(&p.text);
            text.push('\n');
            id += 1;
        }
        total += text.len();
        if !text.trim().is_empty() {
            out.push((format!("p. {}", page + 1), text));
        }
        if total > 40_000 {
            break;
        }
    }
    // A saved web page as the full text: its text has no pages.
    if total == 0 {
        if let Ok(text) = library.store.leading_text(source, 40_000) {
            if !text.trim().is_empty() {
                out.push(("Saved page".to_string(), text));
            }
        }
    }
    out
}

pub fn dispatch(root: &Path, library: &Library, databases: &Arc<Databases>, web: &web_search::WebSearch, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let reviews = match reviews(root) {
        Ok(r) => r,
        Err(e) => return Some(Err(format!("Reviews are not available: {e}"))),
    };
    // The file itself, for the reader inside the review.
    if command == "review_fulltext_bytes" {
        return Some((|| {
            let id = arg::<String>(args, "reviewId")?;
            let (path, _) = full_text_path(root, library, reviews, &id, text(args, "recordId"))?;
            std::fs::read(&path).map(Output::Binary).map_err(|e| format!("Could not read the full text: {e}"))
        })());
    }
    let lookup = Lookup(library);
    let review = || arg::<String>(args, "reviewId").or_else(|_| arg::<String>(args, "id"));
    let actor = || -> Result<String, String> { arg::<String>(args, "actor").map_err(|_| "Choose who is screening".to_string()) };
    let result: Result<Json, String> = (|| {
        Ok(match command {
            "review_list" => json!(reviews.list_reviews()?),
            "review_create" => {
                let protocol: Option<Protocol> = match args.get("template").and_then(Json::as_str) {
                    Some(t) if !t.trim().is_empty() => Some(key_review::export::read_template(t)?),
                    _ => None,
                };
                let (id, owner) = reviews.create(text(args, "name"), text(args, "ownerName"), protocol)?;
                json!({ "reviewId": id, "actor": owner })
            }
            "review_get" => {
                let id = review()?;
                classify_runs(reviews, &id, databases, web, library, root);
                reviews.summary(&id, text(args, "viewer"))?
            }
            // Cheap: whether anything changed since the screen last read (another window, a merge).
            "review_stamp" => reviews.read(&review()?, |state, _| Ok(json!({ "events": state.events, "last": state.last_event.as_ref().map(|e| &e.1) })))?,
            "review_rename" => {
                reviews.rename(&review()?, text(args, "name"), &actor()?)?;
                json!(true)
            }
            "review_archive" => {
                reviews.archive(&review()?, args.get("archived").and_then(Json::as_bool).unwrap_or(true), &actor()?)?;
                json!(true)
            }
            "review_delete" => {
                reviews.delete(&review()?)?;
                json!(true)
            }
            "review_team_save" => {
                reviews.save_team(&review()?, arg::<Vec<Member>>(args, "members")?, &actor()?)?;
                json!(true)
            }
            "review_protocol_impact" => json!(reviews.protocol_impact(&review()?, &arg::<Protocol>(args, "protocol")?, &lookup)?),
            "review_protocol_save" => json!(reviews.save_protocol(&review()?, arg::<Protocol>(args, "protocol")?, text(args, "note"), &actor()?, args.get("rescreen").and_then(Json::as_bool).unwrap_or(false), &lookup)?),
            "review_template_read" => json!(key_review::export::read_template(text(args, "text"))?),
            "review_form_templates" => json!(key_review::templates::form_templates()),
            // Criteria to start from for a question (one per part of its framework, and the usual others).
            "review_criteria_suggestions" => {
                let question: key_review::model::Question = arg(args, "question")?;
                json!({
                    "criteria": key_review::templates::suggested_criteria(&question),
                    "elements": key_review::model::elements_of(&question.framework).iter().map(|id| json!({ "id": id, "label": key_review::model::ELEMENTS.iter().find(|(e, _)| e == id).map(|(_, l)| *l).unwrap_or("Other") })).collect::<Vec<_>>(),
                })
            }
            "review_import_file" => {
                let parsed = import::parse_file(text(args, "text"), Some(text(args, "fileName")).filter(|f| !f.is_empty()))?;
                let mut batch = batch_from(args, "file")?;
                if batch.file_name.is_empty() {
                    batch.file_name = text(args, "fileName").into();
                }
                if batch.name.is_empty() {
                    batch.name = batch.file_name.clone();
                }
                let report = reviews.import(&review()?, batch, parsed.records, &actor()?, &lookup)?;
                json!({ "report": report, "format": parsed.format, "warnings": parsed.warnings.iter().take(20).collect::<Vec<_>>() })
            }
            "review_preview_file" => {
                let parsed = import::parse_file(text(args, "text"), Some(text(args, "fileName")).filter(|f| !f.is_empty()))?;
                json!({ "format": parsed.format, "count": parsed.records.len(), "sample": parsed.records.iter().take(3).map(|r| json!({ "title": r.title, "byline": r.byline() })).collect::<Vec<_>>(), "warnings": parsed.warnings.len() })
            }
            "review_import_library" => {
                let mut query: SourceQuery = serde_json::from_value(args.get("query").cloned().unwrap_or(json!({}))).map_err(|e| format!("Invalid query: {e}"))?;
                let ids = strings(args, "ids");
                if !ids.is_empty() {
                    query.ids = Some(ids);
                }
                let mut records = Vec::new();
                query.offset = 0;
                query.limit = Some(500);
                loop {
                    let page = library.store.list_sources(&query)?;
                    records.extend(page.items.iter().map(import::from_source));
                    match page.next_offset {
                        Some(next) if next > query.offset && records.len() < 50_000 => query.offset = next,
                        _ => break,
                    }
                }
                // Where the library's records came from is asked in the sheet; without an answer
                // they count under databases, "source not specified", until named.
                let batch = batch_from(args, "library")?;
                json!({ "report": reviews.import(&review()?, batch, records, &actor()?, &lookup)? })
            }
            "review_db_runs" => {
                let store_library = StoreLibrary { library, root };
                call_db(databases, web, &store_library, "db_runs", json!({ "limit": args.get("limit").and_then(Json::as_u64).unwrap_or(20) }))?
            }
            "review_import_db_run" => {
                let store_library = StoreLibrary { library, root };
                let (mut batch, records) = database_run(databases, web, &store_library, &arg::<String>(args, "runId")?, &strings(args, "keys"))?;
                if let Some(name) = args.pointer("/batch/name").and_then(Json::as_str).filter(|n| !n.trim().is_empty()) {
                    batch.name = name.into();
                }
                if records.is_empty() {
                    return Err("This search run has no records any more: run it again from Database search".into());
                }
                let id = review()?;
                let run_id = arg::<String>(args, "runId")?;
                let search = args.get("searchId").and_then(Json::as_str).filter(|s| !s.is_empty());
                if args.get("onlyNew").and_then(Json::as_bool).unwrap_or(false) {
                    // An update search: a dated batch of what is new.
                    batch.name = format!("{} (update)", batch.name);
                    json!({ "report": reviews.import_update(&id, batch, records, search, &run_id, &actor()?, &lookup)? })
                } else {
                    let report = reviews.import(&id, batch, records, &actor()?, &lookup)?;
                    if let Some(s) = search {
                        reviews.search_ran(&id, s, &run_id, &report.batch_id, report.added, &actor()?)?;
                    }
                    json!({ "report": report })
                }
            }
            "review_import_records" => {
                let records: Vec<RecordMeta> = arg::<Vec<RecordMeta>>(args, "records")?.into_iter().map(|mut r| {
                    r.id = key_review::events::uuid7();
                    r
                }).collect();
                json!({ "report": reviews.import(&review()?, batch_from(args, "other")?, records, &actor()?, &lookup)? })
            }
            // The Inbox's "Send to review…": works not in the library, from their feed metadata.
            "review_import_inbox" => {
                let mut records = Vec::new();
                for work in library.store.inbox_works(&strings(args, "ids"))? {
                    let input: SourceInput = serde_json::from_value(work).map_err(|e| format!("Invalid work: {e}"))?;
                    records.push(import::from_input(&input));
                }
                if records.is_empty() {
                    return Err("These works are no longer in the Inbox".into());
                }
                // Alerts from journals and feeds: PRISMA's other methods ("Other").
                let mut batch = batch_from(args, "other")?;
                if batch.group.is_empty() {
                    batch.group = "other".into();
                }
                if batch.name.is_empty() {
                    batch.name = "Other".into();
                }
                json!({ "report": reviews.import(&review()?, batch, records, &actor()?, &lookup)? })
            }
            // Database searches that belong to the review (Sources › Search databases).
            "review_search_save" => {
                reviews.save_search(&review()?, args.get("search").cloned().unwrap_or(Json::Null), &actor()?)?;
                json!(true)
            }
            // Where an import's records (or some records) came from, for PRISMA.
            "review_batch_origin" => {
                reviews.set_batch_origin(&review()?, text(args, "batchId"), text(args, "group"), text(args, "name"), &actor()?)?;
                json!(true)
            }
            "review_record_origin" => {
                let group = text(args, "group");
                let origin = (!group.is_empty()).then(|| (group, text(args, "name")));
                reviews.set_record_origin(&review()?, &strings(args, "recordIds"), origin, &actor()?)?;
                json!(true)
            }
            "review_batch_remove" => {
                reviews.remove_batch(&review()?, text(args, "batchId"), &actor()?)?;
                json!(true)
            }
            "review_pairs" => reviews.pairs(&review()?, args.get("offset").and_then(Json::as_u64).unwrap_or(0) as usize, args.get("limit").and_then(Json::as_u64).unwrap_or(50) as usize)?,
            "review_pair_resolve" => {
                reviews.resolve_pair(&review()?, text(args, "a"), text(args, "b"), text(args, "choice"), args.get("keep").and_then(Json::as_str), &actor()?)?;
                json!(true)
            }
            "review_records" => reviews.list(&review()?, text(args, "viewer"), &arg::<ListQuery>(args, "query")?, &lookup)?,
            "review_queue" => json!(reviews.queue(&review()?, text(args, "viewer"), stage(args)?, text(args, "filter"))?),
            "review_record" => reviews.record_view(&review()?, text(args, "recordId"), text(args, "viewer"), stage(args)?, &lookup)?,
            "review_decide" => {
                let value: Choice = arg(args, "value")?;
                let mut ids = strings(args, "recordIds");
                if ids.is_empty() {
                    ids.push(arg::<String>(args, "recordId")?);
                }
                let evidence: Vec<Json> = arg::<Option<Vec<Json>>>(args, "evidence")?.unwrap_or_default();
                json!(reviews.decide(&review()?, &ids, stage(args)?, value, strings(args, "reasons"), text(args, "other"), text(args, "note"), evidence, &actor()?)?)
            }
            "review_undo" => json!(reviews.undo(&review()?, &actor()?)?.map(|(record, stage)| json!({ "recordId": record, "stage": stage }))),
            "review_retract" => {
                reviews.retract(&review()?, text(args, "recordId"), text(args, "eventId"), &actor()?)?;
                json!(true)
            }
            "review_resolve" => {
                reviews.resolve(&review()?, text(args, "recordId"), stage(args)?, arg(args, "value")?, strings(args, "reasons"), text(args, "other"), text(args, "note"), &actor()?)?;
                json!(true)
            }
            "review_reopen" => {
                reviews.reopen(&review()?, text(args, "recordId"), stage(args)?, &actor()?)?;
                json!(true)
            }
            "review_note" => {
                reviews.note(&review()?, text(args, "recordId"), text(args, "text"), args.get("noteId").and_then(Json::as_str), &actor()?)?;
                json!(true)
            }
            "review_labels" => {
                reviews.labels(&review()?, &strings(args, "recordIds"), &strings(args, "add"), &strings(args, "remove"), &actor()?)?;
                json!(true)
            }
            "review_flags_clear" => {
                reviews.clear_flags(&review()?, &strings(args, "recordIds"), stage(args)?, &actor()?)?;
                json!(true)
            }
            "review_fulltext" => {
                let source = args.get("sourceId").map(|v| v.as_str());
                reviews.fulltext(&review()?, text(args, "recordId"), args.get("status").and_then(Json::as_str), args.get("reason").and_then(Json::as_str), source, &actor()?)?;
                json!(true)
            }
            "review_link_library" => link_to_library(library, reviews, &review()?, &strings(args, "recordIds"), &actor()?)?,
            "review_pilot_create" => json!(reviews.pilot_create(&review()?, stage(args)?, args.get("size").and_then(Json::as_u64).unwrap_or(20) as usize, strings(args, "reviewers"), text(args, "name"), args.get("seed").and_then(Json::as_u64), &actor()?)?),
            "review_pilot_set" => {
                reviews.pilot_set_open(&review()?, text(args, "pilotId"), args.get("open").and_then(Json::as_bool).unwrap_or(false), &actor()?)?;
                json!(true)
            }
            "review_assign" => json!(reviews.assign(&review()?, stage(args)?, text(args, "mode"), arg::<Vec<Share>>(args, "reviewers")?, args.get("double").and_then(Json::as_f64).unwrap_or(0.0), args.get("seed").and_then(Json::as_u64), &actor()?)?.mode),
            "review_agreement" => reviews.agreement(&review()?, stage(args)?, args.get("pilotId").and_then(Json::as_str))?,
            "review_prisma" => {
                let id = review()?;
                classify_runs(reviews, &id, databases, web, library, root);
                json!(reviews.prisma(&id)?)
            }
            "review_studies" => reviews.studies(&review()?, text(args, "viewer"))?,
            "review_extraction" => reviews.extraction_view(&review()?, text(args, "recordId"), text(args, "viewer"))?,
            "review_extract" => {
                reviews.extract(
                    &review()?,
                    text(args, "recordId"),
                    text(args, "formId"),
                    text(args, "fieldId"),
                    args.get("value").cloned().unwrap_or(Json::Null),
                    text(args, "quote"),
                    args.get("page").and_then(Json::as_i64),
                    args.get("sourceId").and_then(Json::as_str),
                    args.get("sourcePos").filter(|v| !v.is_null()).cloned(),
                    args.get("suggested").and_then(Json::as_bool).unwrap_or(false),
                    args.get("final").and_then(Json::as_bool).unwrap_or(false),
                    &actor()?,
                )?;
                json!(true)
            }
            "review_complete_form" => {
                reviews.complete_form(&review()?, text(args, "recordId"), text(args, "formId"), &actor()?)?;
                json!(true)
            }
            // The form builder's live preview: which fields sample answers show, each rule in
            // words, and whether the form's logic holds (no circles, no unknown fields).
            "review_form_preview" => {
                let form: key_review::model::Form = arg(args, "form")?;
                let answers: key_review::logic::Answers = args.get("answers").and_then(Json::as_object).map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
                let label = |id: &str| form.fields().find(|f| f.id == id).map(|f| f.label.clone()).unwrap_or_else(|| id.to_string());
                let mut rules = Map::new();
                for s in &form.sections {
                    if let Some(w) = &s.show_when {
                        rules.insert(format!("section:{}", s.id), json!(key_review::logic::describe(w, &label)));
                    }
                    for f in &s.fields {
                        if let Some(w) = &f.show_when {
                            rules.insert(f.id.clone(), json!(key_review::logic::describe(w, &label)));
                        }
                        for c in &f.columns {
                            if let Some(w) = &c.show_when {
                                let col_label = |id: &str| f.columns.iter().find(|x| x.id == id).map(|x| x.label.clone()).unwrap_or_else(|| label(id));
                                rules.insert(format!("{}/{}", f.id, c.id), json!(key_review::logic::describe(w, &col_label)));
                            }
                        }
                    }
                }
                json!({
                    "visible": key_review::logic::visible_fields(&form, &answers),
                    "shownWhen": rules,
                    "error": key_review::logic::validate_form(&form).err(),
                })
            }
            // A selection in the reader read as numbers ("12.3 (4.5)", "n = 120", "45%", CI).
            "review_parse_selection" => key_review::logic::parse_selection(text(args, "text")),
            // Records: removed and restored by hand, corrected, grouped into studies.
            "review_records_remove" => {
                reviews.remove_records(&review()?, &strings(args, "recordIds"), args.get("removed").and_then(Json::as_bool).unwrap_or(true), text(args, "reason"), &actor()?)?;
                json!(true)
            }
            "review_record_edit" => {
                let fields = args.get("fields").and_then(Json::as_object).cloned().unwrap_or_default();
                reviews.edit_record(&review()?, text(args, "recordId"), fields, &actor()?)?;
                json!(true)
            }
            "review_study_link" => {
                reviews.link_study(&review()?, text(args, "recordId"), args.get("studyOf").and_then(Json::as_str).filter(|s| !s.is_empty()), &actor()?)?;
                json!(true)
            }
            "review_duplicates" => reviews.duplicates(&review()?)?,
            // Missing abstracts (DOI …): the record's duplicates, then the library.
            "review_fill_missing" => json!(reviews.fill_missing(&review()?, &lookup, &actor()?)?),
            // Values an open lookup found for one record (only what it lacks is written).
            "review_enrich" => {
                let found = args.get("fields").and_then(Json::as_object).cloned().unwrap_or_default();
                json!({ "filled": reviews.enrich_from(&review()?, text(args, "recordId"), found, text(args, "from"), args.get("replace").and_then(Json::as_bool).unwrap_or(false), &actor()?)? })
            }
            // Full texts.
            "review_fulltexts" => reviews.fulltext_status(&review()?)?,
            "review_fulltext_match" => json!(reviews.match_dropped(&review()?, &arg::<Vec<key_review::records::DroppedFile>>(args, "files")?)?),
            // A PDF caught in the review's browser for one record: is it that record's work?
            "review_fulltext_check" => reviews.check_dropped(&review()?, text(args, "recordId"), &arg::<key_review::records::DroppedFile>(args, "file")?)?,
            "review_fulltext_csv_read" => json!(reviews.read_csv(&review()?, text(args, "text"), &arg::<Vec<key_review::records::DroppedFile>>(args, "files")?)?),
            "review_fulltext_attach" => {
                let path = std::path::PathBuf::from(arg::<String>(args, "path")?);
                attach_full_text(root, library, reviews, &review()?, text(args, "recordId"), &path, text(args, "name"), text(args, "origin"), args.get("ownedTemp").and_then(Json::as_bool).unwrap_or(false), &actor()?)?
            }
            "review_fulltext_detach" => {
                let id = review()?;
                let record = text(args, "recordId");
                let linked = reviews.read(&id, |s, _| Ok(s.record(record).is_some_and(|r| r.fulltext.file.is_none() && r.source_id.is_some())))?;
                if linked {
                    reviews.fulltext(&id, record, Some("sought"), None, Some(None), &actor()?)?;
                } else {
                    reviews.detach_file(&id, record, &actor()?)?;
                }
                json!(true)
            }
            "review_fulltext_info" => {
                let id = review()?;
                let (path, mime) = full_text_path(root, library, reviews, &id, text(args, "recordId"))?;
                json!({ "path": path, "mime": mime, "exists": path.is_file() })
            }
            // "Also add to library": the review's file becomes a library source too.
            "review_fulltext_to_library" => {
                let id = review()?;
                let record = text(args, "recordId");
                let (path, _) = full_text_path(root, library, reviews, &id, record)?;
                let added = library.import_file(&path, None, root, None)?;
                let source = added.get("id").and_then(Json::as_str).ok_or("Could not add the file to the library")?.to_string();
                reviews.fulltext(&id, record, Some("retrieved"), None, Some(Some(&source)), &actor()?)?;
                library.indexer.wake();
                json!({ "sourceId": source })
            }
            "review_outcomes" => json!(reviews.outcome_choices(&review()?)?),
            "review_analyse" => reviews.analyse(&review()?, &arg::<AnalysisRequest>(args, "request")?)?,
            "review_analysis_save" => {
                reviews.save_analysis(&review()?, args.get("analysis").cloned().unwrap_or(Json::Null), &actor()?)?;
                json!(true)
            }
            "review_export" => reviews.export(&review()?, text(args, "kind"), text(args, "viewer"))?,
            "review_import_review" => reviews.import_review_file(text(args, "text"))?,
            "review_audit" => {
                let id = review()?;
                let offset = args.get("offset").and_then(Json::as_u64).unwrap_or(0) as usize;
                let limit = args.get("limit").and_then(Json::as_u64).unwrap_or(100).min(500) as usize;
                reviews.read(&id, |state, conn| {
                    let (events, total) = key_review::store::events_page(conn, &id, offset, limit, None)?;
                    let rows: Vec<Json> = events
                        .iter()
                        .map(|e| json!({ "id": e.id, "at": e.at, "actor": e.actor, "actorName": state.member_name(&e.actor), "kind": e.kind, "recordId": e.record_id, "version": state.versions.iter().find(|v| v.id == e.version).map(|v| v.number), "what": key_review::export::describe(state, e) }))
                        .collect();
                    Ok(json!({ "events": rows, "total": total }))
                })?
            }
            "review_ai_request" => {
                let id = review()?;
                let record = text(args, "recordId").to_string();
                let stage = stage(args)?;
                let meta = reviews.metas(&id, std::slice::from_ref(&record))?.remove(&record).ok_or("This record no longer exists")?;
                reviews.read(&id, |state, _| Ok(key_review::ai::screening_request(&state.protocol, stage, &meta)))?
            }
            "review_ai_extract_request" => {
                let id = review()?;
                let record = text(args, "recordId").to_string();
                let meta = reviews.metas(&id, std::slice::from_ref(&record))?.remove(&record).ok_or("This record no longer exists")?;
                let source = reviews.read(&id, |s, _| Ok(s.record(&record).and_then(|r| r.source_id.clone())))?;
                let passages = study_passages(library, &meta, source.as_deref());
                let form_id = text(args, "formId").to_string();
                reviews.read(&id, |state, _| {
                    let form = state.protocol.forms.iter().find(|f| f.id == form_id).ok_or("This form no longer exists")?;
                    Ok(json!({ "request": key_review::ai::extraction_request(form, &meta, &passages), "passages": passages.len() }))
                })?
            }
            "review_ai_extract_answer" => {
                let id = review()?;
                let record = text(args, "recordId").to_string();
                let meta = reviews.metas(&id, std::slice::from_ref(&record))?.remove(&record).ok_or("This record no longer exists")?;
                let source = reviews.read(&id, |s, _| Ok(s.record(&record).and_then(|r| r.source_id.clone())))?;
                let passages = study_passages(library, &meta, source.as_deref());
                let form_id = text(args, "formId").to_string();
                let suggested = reviews.read(&id, |state, _| {
                    let form = state.protocol.forms.iter().find(|f| f.id == form_id).ok_or("This form no longer exists")?;
                    key_review::ai::parse_extraction(text(args, "content"), form, &passages)
                })?;
                json!({ "suggested": reviews.ai_extract(&id, &record, &form_id, &suggested, text(args, "model"))? })
            }
            "review_ai_answer" => {
                let suggestion = key_review::ai::parse_answer(text(args, "content"), text(args, "model"))?;
                reviews.ai_suggest(&review()?, text(args, "recordId"), stage(args)?, suggestion.clone(), "ai")?;
                suggestion
            }
            _ => return Err(format!("Unknown Key command: {command}")),
        })
    })();
    Some(result.and_then(json_output))
}
