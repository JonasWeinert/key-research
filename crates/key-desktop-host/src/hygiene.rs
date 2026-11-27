// Library hygiene commands: the operations journal (undo/redo and batch edits), duplicates
// and merging, "Update metadata…" with a field diff, and retraction and correction notices
// (see key-store's journal.rs, duplicates.rs, refresh.rs and retractions.rs).
//
// Two low-priority background jobs run only while indexing is idle: the duplicate count for
// the status bar (recomputed when the library changed), and a recheck of DOIs for
// retractions (OpenAlex `is_retracted` in batches, then Crossref's `updates:` filter, which
// carries the Retraction Watch data), each DOI about once a week and only while automatic
// lookups are on (Settings → Library).
use super::{json_output, library_store::Library, openalex};
use crate::ipc::{Output, arg};
use key_store::duplicates::{MergeRequest, Work};
use key_store::refresh::{self, Published, RefreshApply, RefreshProposal};
use key_store::{BatchEdit, EnrichJob, Notice, Store, notice_for};
use serde_json::{Value as Json, json};
use std::{
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Between two Crossref requests of the background recheck.
const CROSSREF_PACE: Duration = Duration::from_millis(1500);
/// Sources asked about at once in "Update metadata…".
const MAX_REFRESH: usize = 100;

#[derive(Clone, Default)]
pub struct Hygiene {
    duplicates: Arc<Mutex<Option<Json>>>,
    signal: Arc<(Mutex<bool>, Condvar)>,
}

impl Hygiene {
    pub fn start(store: Store, openalex: openalex::OpenAlex, idle: impl Fn() -> bool + Send + Sync + Clone + 'static) -> Self {
        let hygiene = Self::default();
        let (run, s, i) = (hygiene.clone(), store.clone(), idle.clone());
        thread::Builder::new().name("key-duplicates".into()).spawn(move || run.count_duplicates(s, i)).ok();
        thread::Builder::new().name("key-retractions".into()).spawn(move || recheck_retractions(store, openalex, idle)).ok();
        hygiene
    }

    pub fn wake(&self) {
        let (lock, condvar) = &*self.signal;
        if let Ok(mut woken) = lock.lock() {
            *woken = true;
            condvar.notify_all();
        }
    }

    fn count_duplicates(self, store: Store, idle: impl Fn() -> bool) {
        key_store::priority::set_thread_class(key_store::priority::Class::Idle);
        thread::sleep(Duration::from_secs(5));
        loop {
            key_store::priority::yield_if_needed();
            if idle() {
                if let Ok(report) = store.duplicate_groups(false) {
                    let summary = json!({ "count": report.count, "exactGroups": report.exact_groups, "exactRemovable": report.exact_removable, "versions": report.groups.len() - report.count });
                    if let Ok(mut slot) = self.duplicates.lock() {
                        *slot = Some(summary);
                    }
                }
            }
            let (lock, condvar) = &*self.signal;
            if let Ok(guard) = lock.lock() {
                if let Ok((mut guard, _)) = condvar.wait_timeout_while(guard, Duration::from_secs(60), |woken| !*woken) {
                    *guard = false;
                }
            }
        }
    }
}

// ── Requests ────────────────────────────────────────────────

/// Recorded Crossref answers for tests and smokes (KEY_OPENALEX_FIXTURES): crossref-updates.json
/// lists notices, crossref-works.json lists works by DOI.
fn crossref_fixture(name: &str) -> Option<Vec<Json>> {
    let dir = openalex::fixtures()?;
    let value: Json = std::fs::read_to_string(dir.join(name)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    Some(value["message"]["items"].as_array().cloned().unwrap_or_default())
}

/// One Crossref request, paced against the others of this module.
fn crossref(path: &str, query: &[(&str, &str)], mailto: &str) -> Result<Json, String> {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(wait) = last.and_then(|l| CROSSREF_PACE.checked_sub(l.elapsed())) {
            thread::sleep(wait);
        }
        *last = Some(Instant::now());
    }
    let response = key_reference::crossref_get(path, query, Some(mailto))?;
    match response.status {
        200..=299 => serde_json::from_slice(&response.body).map_err(|e| format!("Crossref sent an unreadable answer: {e}")),
        404 => Ok(json!({})),
        status => Err(format!("Crossref returned HTTP {status}")),
    }
}

/// Crossref's record of a DOI (`message`), if it has one.
fn crossref_work(doi: &str, mailto: &str) -> Result<Option<Json>, String> {
    if let Some(items) = crossref_fixture("crossref-works.json") {
        return Ok(items.into_iter().find(|i| i["DOI"].as_str().is_some_and(|d| d.eq_ignore_ascii_case(doi))));
    }
    let value = crossref(&format!("works/{doi}"), &[], mailto)?;
    Ok(value.get("message").filter(|m| m.is_object()).cloned())
}

/// The most serious notice Crossref lists for a DOI (Retraction Watch and publishers).
pub(crate) fn crossref_notice(doi: &str, mailto: &str) -> Result<Option<Notice>, String> {
    let items = match crossref_fixture("crossref-updates.json") {
        Some(items) => items,
        None => {
            let filter = format!("updates:{doi}");
            let value = crossref("works", &[("filter", &filter), ("select", "DOI,update-to"), ("rows", "20")], mailto)?;
            value["message"]["items"].as_array().cloned().unwrap_or_default()
        }
    };
    Ok(notice_for(doi, &items))
}

// ── Retractions ─────────────────────────────────────────────

/// Checks these sources (id, lower-case DOI) now. Answers how many became flagged.
fn check_retractions(store: &Store, options: &openalex::Options, due: &[(String, String)]) -> Result<usize, String> {
    let batchable: Vec<&(String, String)> = due.iter().filter(|(_, d)| !d.contains(['|', ',']) && d.starts_with("10.")).collect();
    let mut flags: std::collections::HashMap<String, bool> = Default::default();
    for chunk in batchable.chunks(50) {
        let filter = format!("doi:{}", chunk.iter().map(|(_, d)| d.as_str()).collect::<Vec<_>>().join("|"));
        let page = openalex::get("works", &[("filter", &filter), ("select", "id,doi,is_retracted"), ("per-page", "50")], options).map_err(|f| f.message())?;
        for work in page["results"].as_array().into_iter().flatten() {
            if let (Some(doi), Some(retracted)) = (work["doi"].as_str(), work["is_retracted"].as_bool()) {
                let doi = doi.to_ascii_lowercase();
                let doi = doi.trim_start_matches("https://doi.org/").to_string();
                flags.insert(doi, retracted);
            }
        }
    }
    let mut flagged = 0;
    for (id, doi) in due {
        // Without Crossref's answer the source stays due, so a known notice is not lost.
        let Ok(notice) = crossref_notice(doi, &options.mailto) else { continue };
        if store.apply_retraction_check(id, flags.get(doi).copied(), notice.as_ref())? {
            flagged += 1;
        }
    }
    Ok(flagged)
}

fn recheck_retractions(store: Store, openalex: openalex::OpenAlex, idle: impl Fn() -> bool) {
    key_store::priority::set_thread_class(key_store::priority::Class::Idle);
    // Let the app settle after opening.
    thread::sleep(Duration::from_secs(if openalex::fixtures().is_some() { 3 } else { 120 }));
    loop {
        key_store::priority::yield_if_needed();
        let options = openalex.options();
        let mut pause = Duration::from_secs(5 * 60);
        if options.auto && idle() {
            match store.retraction_due(WEEK_MS, 25) {
                Ok(due) if !due.is_empty() => {
                    let _ = check_retractions(&store, &options, &due);
                    pause = Duration::from_secs(30);
                }
                Ok(_) => pause = Duration::from_secs(30 * 60),
                Err(_) => {}
            }
        }
        thread::sleep(pause);
    }
}

// ── Update metadata ─────────────────────────────────────────

fn refresh_one(store: &Store, options: &openalex::Options, id: &str) -> RefreshProposal {
    let failed = |title: &str, error: String| RefreshProposal { id: id.into(), title: title.into(), error: Some(error), ..Default::default() };
    let source = match store.source(id) {
        Ok(Some(source)) => source,
        _ => return failed("", "Source not found".into()),
    };
    let title = source.title().to_string();
    let edited = store.edited_fields(id).unwrap_or_default();
    let arxiv_doi = source.field("arxivId").and_then(key_store::duplicates::normalize_arxiv).map(|a| format!("10.48550/arxiv.{a}"));
    let job = EnrichJob {
        id: id.into(),
        doi: source.field("doi").map(String::from).or(arxiv_doi),
        pmid: source.field("pmid").map(String::from),
        openalex_id: source.field("openalexId").map(String::from),
        title: Some(title.clone()).filter(|t| !t.trim().is_empty()),
        year: source.fields.get("year").and_then(Json::as_i64),
        attempts: 0,
    };
    let surnames: Vec<String> = source.creators.iter().filter_map(|c| c.family.clone().or_else(|| c.literal.clone())).collect();
    let (work, doi) = match openalex::find_work(&job, options, None, &surnames) {
        Ok((work, _)) => {
            let doi = work["doi"].as_str().map(|d| d.trim_start_matches("https://doi.org/").to_ascii_lowercase());
            (Some(work), doi)
        }
        Err(openalex::Fail::Unlisted { doi, .. }) => (None, Some(doi)),
        Err(openalex::Fail::NotFound) => (None, job.doi.clone().filter(|d| d.starts_with("10.") || d.contains("doi.org"))),
        Err(fail) => return failed(&title, fail.message()),
    };
    // Crossref: when OpenAlex has nothing, or to fill what it lacks and to see a preprint's relation.
    let crossref = match (&work, &doi) {
        (_, Some(doi)) => crossref_work(doi.trim_start_matches("https://doi.org/"), &options.mailto).ok().flatten(),
        _ => None,
    };
    let mut proposed = work.as_ref().map(refresh::openalex_fields).unwrap_or_default();
    if let Some(item) = &crossref {
        for (key, value) in refresh::crossref_fields(item) {
            proposed.entry(key).or_insert(value);
        }
    }
    if work.is_none() && crossref.is_none() {
        return failed(&title, "Not found in OpenAlex or Crossref".into());
    }
    let via = if work.is_some() { "openalex" } else { "crossref" };
    let mut proposal = refresh::proposal(&source, &edited, &proposed, via);
    proposal.published = refresh::published_version(&source, work.as_ref(), crossref.as_ref()).map(|mut p: Published| {
        p.source_id = store.source_for_work(None, Some(&p.doi)).ok().flatten().filter(|s| s != id);
        p
    });
    proposal
}

pub fn dispatch(library: &Library, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let store = &library.store;
    let changed = || {
        library.indexer.wake();
        library.hygiene.wake();
    };
    let result = match command {
        // The operations journal.
        "store_edit" => (|| {
            let ids: Vec<String> = arg(args, "ids")?;
            let edit: BatchEdit = arg(args, "edit")?;
            let label: Option<String> = arg(args, "label")?;
            let op = store.edit_sources(&ids, &edit, label.as_deref())?;
            changed();
            json_output(op)
        })(),
        "store_undo" | "store_redo" => (|| {
            let entry = if command == "store_undo" { store.undo()? } else { store.redo()? };
            changed();
            json_output(json!({ "entry": entry, "state": store.journal_state(1)? }))
        })(),
        // A formula's value (the property editors' preview): over a source (`id`), or over
        // given values; `{value}` or `{error}`.
        "store_formula_evaluate" => (|| {
            let formula: String = arg(args, "formula")?;
            match arg::<Option<String>>(args, "id")? {
                Some(id) => json_output(store.formula_evaluate(&formula, &id)?),
                None => {
                    let context = arg::<Option<serde_json::Map<String, serde_json::Value>>>(args, "properties")?.unwrap_or_default();
                    json_output(match key_store::formula::evaluate_in(&formula, &key_store::formula::MapScope(&context)) {
                        Ok(value) => json!({ "value": value.to_json(), "text": value.text(), "type": value.type_name() }),
                        Err(error) => json!({ "error": error.message, "hint": error.hint, "start": error.start, "end": error.end }),
                    })
                }
            }
        })(),
        // The formula editor: fields, functions, templates and blocks; a formula's
        // highlighting, type, errors and blocks; its values on real sources; blocks to text.
        "store_formula_catalog" => (|| json_output(store.formula_catalog()?))(),
        "store_formula_status" => (|| json_output(json!({ "updating": store.formula_pending()? })))(),
        "store_formula_analyze" => (|| {
            let name: Option<String> = arg(args, "name")?;
            json_output(store.formula_analyze(&arg::<String>(args, "formula")?, name.as_deref())?)
        })(),
        "store_formula_preview" => (|| {
            let ids: Option<Vec<String>> = arg(args, "ids")?;
            json_output(store.formula_preview(&arg::<String>(args, "formula")?, &ids.unwrap_or_default(), arg::<Option<usize>>(args, "limit")?.unwrap_or(5))?)
        })(),
        "store_formula_prompt" => (|| json_output(store.formula_prompt(&arg::<String>(args, "description")?)?))(),
        "store_formula_from_answer" => (|| json_output(store.formula_from_answer(&arg::<String>(args, "content")?)?))(),
        "store_formula_print" => (|| json_output(json!({ "formula": key_store::formula::print(&arg::<serde_json::Value>(args, "blocks")?)? })))(),
        "store_journal" => (||json_output(store.journal_state(arg::<Option<usize>>(args, "limit")?.unwrap_or(20))?))(),
        // Duplicates.
        "store_duplicates" => (|| json_output(store.duplicate_groups(arg::<Option<bool>>(args, "withSources")?.unwrap_or(true))?))(),
        "store_duplicates_summary" => (|| {
            library.hygiene.wake();
            json_output(library.hygiene.duplicates.lock().map_err(|e| e.to_string())?.clone().unwrap_or(json!({ "count": 0, "pending": true })))
        })(),
        "store_find_duplicates_for" => arg::<Vec<Work>>(args, "works").and_then(|works| json_output(store.find_duplicates_for(&works)?)),
        "store_merge_preview" => (|| {
            let keep: Option<String> = arg(args, "keep")?;
            json_output(store.merge_preview(&arg::<Vec<String>>(args, "ids")?, keep.as_deref())?)
        })(),
        "store_merge_sources" => arg::<MergeRequest>(args, "request").and_then(|request| {
            let op = store.merge_sources(&request)?;
            changed();
            json_output(op)
        }),
        "store_merge_exact" => (|| {
            let op = store.merge_exact_duplicates()?;
            changed();
            json_output(op)
        })(),
        "store_mark_distinct" => arg::<Vec<String>>(args, "ids").and_then(|ids| {
            let op = store.mark_distinct(&ids)?;
            changed();
            json_output(op)
        }),
        "store_link_versions" => (|| {
            let op = store.link_versions(&arg::<Vec<String>>(args, "ids")?, arg::<Option<bool>>(args, "linked")?.unwrap_or(true))?;
            changed();
            json_output(op)
        })(),
        "store_versions" => arg::<String>(args, "id").and_then(|id| {
            let sources: Vec<_> = store.versions_of(&id)?.iter().filter_map(|v| store.source(v).ok().flatten()).collect();
            json_output(sources)
        }),
        // Update metadata.
        "store_refresh_metadata" => arg::<Vec<String>>(args, "ids").and_then(|ids| {
            let options = library.openalex.options();
            let proposals: Vec<RefreshProposal> = ids.iter().take(MAX_REFRESH).map(|id| refresh_one(store, &options, id)).collect();
            json_output(proposals)
        }),
        "store_apply_metadata" => arg::<Vec<RefreshApply>>(args, "items").and_then(|items| {
            let op = store.apply_refresh(&items)?;
            changed();
            json_output(op)
        }),
        "store_add_published" => (|| {
            let (id, op) = store.add_published_version(&arg::<String>(args, "id")?, &arg::<Published>(args, "published")?)?;
            library.openalex.wake();
            changed();
            json_output(json!({ "id": id, "entry": op.entry }))
        })(),
        // Retractions.
        "store_retractions" => store.retraction_summary().and_then(json_output),
        "store_retractions_seen" => store.mark_retractions_seen().and_then(|()| json_output(true)),
        "store_retraction_dismiss" => (|| json_output(store.dismiss_retraction(&arg::<Vec<String>>(args, "ids")?, arg::<Option<bool>>(args, "dismissed")?.unwrap_or(true))?))(),
        // "Check for retractions" on a selection (or everything due), now.
        "store_retraction_check" => (|| {
            let ids: Option<Vec<String>> = arg(args, "ids")?;
            let due: Vec<(String, String)> = match ids {
                Some(ids) => ids.iter().filter_map(|id| store.source(id).ok().flatten()).filter_map(|s| s.field("doi").map(|d| (s.id.clone(), d.trim().to_ascii_lowercase()))).collect(),
                None => store.retraction_due(WEEK_MS, 50)?,
            };
            let flagged = check_retractions(store, &library.openalex.options(), &due)?;
            json_output(json!({ "checked": due.len(), "flagged": flagged }))
        })(),
        _ => return None,
    };
    Some(result)
}
