// std-B's review commands (crates/key-review: chasing.rs, ai_audit.rs, conduct.rs, xpilot.rs):
// citation searching through OpenAlex (the library's paced, keyed, retrying requests, with a
// cache so a second look costs nothing) as a background job with progress and cancel; the AI
// use panel and its audit; the Conduct panel and the retraction check of included studies;
// extraction pilots and the contact-with-authors log.
use super::library_store::Library;
use super::openalex;
use key_review::Reviews;
use key_review::chasing::{self, ChaseResult, Direction, Graph, GraphWork, Progress};
use key_review::model::{RecordMeta, Stage};
use serde_json::{Value as Json, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// What citation searching asks OpenAlex for (references and abstracts for screening).
const FIELDS: &str = "id,doi,display_name,publication_year,authorships,primary_location,type,referenced_works,abstract_inverted_index";
/// Answers are kept this long: a chase repeated the same day (or a round after it) asks again only for what is new.
const CACHE_FOR: Duration = Duration::from_secs(24 * 60 * 60);

static CACHE: Mutex<Option<HashMap<String, (Instant, Json)>>> = Mutex::new(None);

fn cached_get(path: &str, query: &[(&str, &str)], options: &openalex::Options) -> Result<Json, String> {
    let key = format!("{path}?{}", query.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&"));
    if let Some((at, v)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).get(&key) {
        if at.elapsed() < CACHE_FOR {
            return Ok(v.clone());
        }
    }
    let value = match openalex::get(path, query, options) {
        Ok(v) => v,
        Err(openalex::Fail::NotFound) => json!({ "results": [] }),
        Err(fail) => return Err(fail.message()),
    };
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let map = cache.get_or_insert_with(HashMap::new);
    if map.len() > 2000 {
        map.retain(|_, (at, _)| at.elapsed() < CACHE_FOR);
    }
    map.insert(key, (Instant::now(), value.clone()));
    Ok(value)
}

/// "Ana Rivera" → "Rivera, Ana" (review records keep "Family, Given").
fn family_first(name: &str) -> String {
    let name = name.trim();
    match name.rsplit_once(' ') {
        Some((given, family)) if !name.contains(',') => format!("{family}, {given}"),
        _ => name.to_string(),
    }
}

fn work_of(v: &Json) -> GraphWork {
    let short = |s: &str| s.rsplit('/').next().unwrap_or(s).to_string();
    GraphWork {
        id: v["id"].as_str().map(short).unwrap_or_default(),
        doi: v["doi"].as_str().map(|d| key_store::normalize::doi_or_text(d)).unwrap_or_default(),
        title: v["display_name"].as_str().or(v["title"].as_str()).unwrap_or("").to_string(),
        year: v["publication_year"].as_i64(),
        authors: v["authorships"].as_array().into_iter().flatten().filter_map(|a| a["author"]["display_name"].as_str()).map(family_first).collect(),
        journal: v["primary_location"]["source"]["display_name"].as_str().unwrap_or("").to_string(),
        abstract_text: key_store::abstract_text(&v["abstract_inverted_index"]).unwrap_or_default(),
        item_type: match v["type"].as_str().unwrap_or("") {
            "article" | "" => "journalArticle".into(),
            "book" => "book".into(),
            "book-chapter" => "bookSection".into(),
            "dissertation" => "thesis".into(),
            "preprint" => "preprint".into(),
            "report" => "report".into(),
            other => other.into(),
        },
        references: v["referenced_works"].as_array().into_iter().flatten().filter_map(Json::as_str).map(short).collect(),
    }
}

struct OpenAlexGraph {
    store: key_store::Store,
    options: openalex::Options,
}

impl OpenAlexGraph {
    fn list(&self, filter: &str, per_page: usize) -> Result<Vec<GraphWork>, String> {
        let per = per_page.to_string();
        let page = cached_get("works", &[("filter", filter), ("per-page", &per), ("select", FIELDS)], &self.options)?;
        Ok(page["results"].as_array().into_iter().flatten().map(work_of).collect())
    }
}

impl Graph for OpenAlexGraph {
    fn by_dois(&self, dois: &[String]) -> Result<Vec<GraphWork>, String> {
        self.list(&format!("doi:{}", dois.join("|")), 50)
    }
    fn by_ids(&self, ids: &[String]) -> Result<Vec<GraphWork>, String> {
        self.list(&format!("openalex:{}", ids.join("|")), 50)
    }
    fn by_title(&self, title: &str) -> Result<Vec<GraphWork>, String> {
        let clean: String = title.chars().map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' }).collect();
        self.list(&format!("title.search:{}", clean.split_whitespace().collect::<Vec<_>>().join(" ")), 5)
    }
    fn citing(&self, ids: &[String], limit: usize) -> Result<Vec<GraphWork>, String> {
        // Cursor paging, 200 a page, until `limit`.
        let filter = format!("cites:{}", ids.join("|"));
        let mut cursor = "*".to_string();
        let mut out = Vec::new();
        while out.len() < limit {
            let page = cached_get("works", &[("filter", &filter), ("per-page", "200"), ("cursor", &cursor), ("select", FIELDS)], &self.options)?;
            let rows: Vec<GraphWork> = page["results"].as_array().into_iter().flatten().map(work_of).collect();
            let empty = rows.is_empty();
            out.extend(rows);
            match page["meta"]["next_cursor"].as_str() {
                Some(next) if !empty && next != cursor => cursor = next.to_string(),
                _ => break,
            }
            key_store::priority::yield_if_needed();
        }
        out.truncate(limit);
        Ok(out)
    }
    /// The references Key read from the seed's PDF or saved page (the library's analysis).
    fn local_references(&self, seed: &RecordMeta) -> Vec<RecordMeta> {
        let Some(source) = seed.source_id.as_deref() else { return Vec::new() };
        let Ok(refs) = self.store.references(source) else { return Vec::new() };
        refs.into_iter()
            .filter_map(|r| {
                let m = r.metadata.unwrap_or(Json::Null);
                let title = m["title"].as_str().map(str::to_string).filter(|t| !t.trim().is_empty())?;
                Some(RecordMeta {
                    title,
                    authors: m["authors"].as_array().into_iter().flatten().filter_map(Json::as_str).map(family_first).collect(),
                    year: m["year"].as_i64(),
                    journal: m["journal"].as_str().unwrap_or("").into(),
                    doi: m["doi"].as_str().map(key_store::normalize::doi_or_text).unwrap_or_default(),
                    abstract_text: m["abstractText"].as_str().unwrap_or("").into(),
                    item_type: "journalArticle".into(),
                    extra: [("fromFullText".to_string(), json!(r.text))].into_iter().collect(),
                    ..Default::default()
                })
            })
            .collect()
    }
}

// ── Background jobs ───────────────────────────────────────────────────────────────────

struct Job {
    review: String,
    state: &'static str,
    progress: Option<Progress>,
    result: Option<ChaseResult>,
    error: Option<String>,
    cancel: Arc<AtomicBool>,
    started: Instant,
}

static JOBS: Mutex<Option<HashMap<String, Job>>> = Mutex::new(None);

fn jobs<R>(f: impl FnOnce(&mut HashMap<String, Job>) -> R) -> R {
    let mut guard = JOBS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn start_chase(reviews: &'static Reviews, library: &Library, review: &str, seeds: Vec<String>, direction: Direction) -> Result<Json, String> {
    if seeds.is_empty() {
        return Err("Choose the studies to start from".into());
    }
    let metas = reviews.metas(review, &seeds)?;
    let seed_metas: Vec<RecordMeta> = seeds.iter().filter_map(|id| metas.get(id).cloned()).collect();
    let id = key_review::events::short_id("chase");
    let cancel = Arc::new(AtomicBool::new(false));
    jobs(|j| {
        j.retain(|_, job| job.started.elapsed() < Duration::from_secs(6 * 3600));
        j.insert(id.clone(), Job { review: review.into(), state: "running", progress: None, result: None, error: None, cancel: cancel.clone(), started: Instant::now() })
    });
    let store = library.store.clone();
    let options = library.openalex.options();
    let job = id.clone();
    std::thread::Builder::new()
        .name("key-review-chase".into())
        .spawn(move || {
            key_store::priority::set_thread_class(key_store::priority::Class::Background);
            let graph = OpenAlexGraph { store, options };
            let answer = chasing::chase(&seed_metas, direction, &graph, &mut |p| {
                key_store::priority::yield_if_needed();
                jobs(|j| {
                    if let Some(x) = j.get_mut(&job) {
                        x.progress = Some(p);
                    }
                });
                !cancel.load(Ordering::Relaxed)
            });
            jobs(|j| {
                if let Some(x) = j.get_mut(&job) {
                    match answer {
                        Ok(r) => {
                            x.state = if r.cancelled { "cancelled" } else { "done" };
                            x.result = Some(r);
                        }
                        Err(e) => {
                            x.state = "failed";
                            x.error = Some(e);
                        }
                    }
                }
            });
        })
        .map_err(|e| e.to_string())?;
    Ok(json!({ "jobId": id }))
}

fn chase_status(reviews: &Reviews, job: &str) -> Result<Json, String> {
    let (review, state, progress, result, error) = jobs(|j| {
        let x = j.get(job).ok_or("This search is no longer running")?;
        Ok::<_, String>((x.review.clone(), x.state, x.progress.clone(), x.result.clone(), x.error.clone()))
    })?;
    let mut out = json!({ "state": state, "progress": progress, "error": error });
    if let Some(r) = result {
        let preview = reviews.chase_preview(&review, &r)?;
        let candidates: Vec<Json> = r
            .candidates
            .iter()
            .enumerate()
            .take(300)
            .map(|(i, c)| json!({ "title": c.meta.title, "byline": c.meta.byline(), "year": c.meta.year, "doi": c.meta.doi, "direction": c.direction, "links": c.links, "known": preview.known.contains_key(&i) }))
            .collect();
        out["preview"] = json!(preview);
        out["seeds"] = json!(r.seeds);
        out["candidates"] = json!(candidates);
        out["requests"] = json!(r.requests);
        out["tool"] = json!(r.tool);
    }
    Ok(out)
}

/// Looks the included studies' DOIs up for retractions and corrections (OpenAlex's flag in
/// batches, then Crossref's notices, which carry the Retraction Watch data) and records the check.
fn check_retractions(reviews: &Reviews, library: &Library, review: &str, actor: &str) -> Result<Json, String> {
    let (targets, missing) = reviews.retraction_targets(review)?;
    if targets.is_empty() && missing == 0 {
        return Err("No study is included yet".into());
    }
    let options = library.openalex.options();
    let mut flags: HashMap<String, bool> = HashMap::new();
    for chunk in targets.chunks(50) {
        let filter = format!("doi:{}", chunk.iter().map(|(_, d)| d.as_str()).collect::<Vec<_>>().join("|"));
        let page = openalex::get("works", &[("filter", &filter), ("select", "id,doi,is_retracted"), ("per-page", "50")], &options).map_err(|f| f.message())?;
        for w in page["results"].as_array().into_iter().flatten() {
            if let (Some(doi), Some(r)) = (w["doi"].as_str(), w["is_retracted"].as_bool()) {
                flags.insert(key_store::normalize::doi_or_text(doi).to_ascii_lowercase(), r);
            }
        }
    }
    let mut flagged = Vec::new();
    for (record, doi) in &targets {
        let notice = super::hygiene::crossref_notice(doi, &options.mailto).ok().flatten();
        let retracted = flags.get(&doi.to_ascii_lowercase()).copied().unwrap_or(false);
        if retracted || notice.is_some() {
            let kind = notice.as_ref().map(|n| n.kind.clone()).unwrap_or_else(|| "retraction".into());
            flagged.push(json!({ "recordId": record, "doi": doi, "kind": kind, "noticeDoi": notice.as_ref().and_then(|n| n.doi.clone()), "date": notice.as_ref().and_then(|n| n.date.clone()) }));
        }
    }
    reviews.record_retraction_check(review, targets.len(), missing, flagged.clone(), "Crossref (with Retraction Watch) and OpenAlex", actor)?;
    Ok(json!({ "checked": targets.len(), "withoutDoi": missing, "flagged": flagged }))
}

fn text<'a>(args: &'a Json, key: &str) -> &'a str {
    args.get(key).and_then(Json::as_str).unwrap_or("")
}

fn strings(args: &Json, key: &str) -> Vec<String> {
    args.get(key).and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect()).unwrap_or_default()
}

pub fn handles(command: &str) -> bool {
    ["review_chase_", "review_ai_use", "review_ai_audit_", "review_conduct", "review_xpilot", "review_contact"].iter().any(|p| command.starts_with(p))
}

pub fn dispatch(reviews: &'static Reviews, library: &Library, lookup: &dyn key_review::Library, command: &str, args: &Json) -> Result<Json, String> {
    let review = || args.get("reviewId").and_then(Json::as_str).map(str::to_string).ok_or_else(|| "Missing reviewId".to_string());
    let actor = || args.get("actor").and_then(Json::as_str).filter(|a| !a.is_empty()).map(str::to_string).ok_or_else(|| "Choose who is working".to_string());
    Ok(match command {
        "review_chase_view" => reviews.chase_view(&review()?)?,
        "review_chase_start" => start_chase(reviews, library, &review()?, strings(args, "seedIds"), Direction::parse(text(args, "direction")))?,
        "review_chase_status" => chase_status(reviews, text(args, "jobId"))?,
        "review_chase_cancel" => {
            jobs(|j| j.get(text(args, "jobId")).map(|x| x.cancel.store(true, Ordering::Relaxed)));
            json!(true)
        }
        "review_chase_import" => {
            let job = text(args, "jobId");
            let result = jobs(|j| j.get(job).and_then(|x| x.result.clone())).ok_or("This search has no results to import")?;
            let (round, report) = reviews.chase_import(&review()?, &result, args.get("orderByLinks").and_then(Json::as_bool).unwrap_or(true), &actor()?, lookup)?;
            jobs(|j| j.remove(job));
            json!({ "round": round, "report": report })
        }
        "review_ai_use" => reviews.ai_use(&review()?)?,
        "review_ai_audit_draw" => {
            let stage = Stage::parse(args.get("stage").and_then(Json::as_str).unwrap_or("ta"))?;
            json!(reviews.ai_audit_draw(&review()?, if text(args, "task") == "extraction" { "extraction" } else { "screening" }, stage, args.get("percent").and_then(Json::as_f64), args.get("minimum").and_then(Json::as_u64).map(|m| m as usize), args.get("seed").and_then(Json::as_u64), &actor()?)?)
        }
        "review_ai_audit_close" => {
            reviews.ai_audit_close(&review()?, text(args, "auditId"), &actor()?)?;
            json!(true)
        }
        "review_conduct" => reviews.conduct(&review()?, key_review::events::now_ms())?,
        "review_conduct_dismiss" => {
            reviews.conduct_dismiss(&review()?, text(args, "check"), text(args, "reason"), args.get("dismissed").and_then(Json::as_bool).unwrap_or(true), &actor()?)?;
            json!(true)
        }
        "review_conduct_retractions" => check_retractions(reviews, library, &review()?, &actor()?)?,
        "review_xpilots" => reviews.xpilots(&review()?)?,
        "review_xpilot_create" => json!(reviews.xpilot_create(&review()?, args.get("size").and_then(Json::as_u64).unwrap_or(5) as usize, strings(args, "extractors"), strings(args, "formIds"), text(args, "name"), args.get("seed").and_then(Json::as_u64), &actor()?)?),
        "review_xpilot_close" => {
            reviews.xpilot_close(&review()?, text(args, "pilotId"), args.get("piloted").and_then(Json::as_bool).unwrap_or(true), &actor()?)?;
            json!(true)
        }
        "review_contacts" => reviews.contacts(&review()?, args.get("recordId").and_then(Json::as_str).filter(|s| !s.is_empty()))?,
        "review_contact_save" => {
            let contact: key_review::xpilot::Contact = serde_json::from_value(args.get("contact").cloned().unwrap_or(Json::Null)).map_err(|e| format!("Invalid contact: {e}"))?;
            json!(reviews.contact_save(&review()?, contact, &actor()?)?)
        }
        other => return Err(format!("Unknown Key command: {other}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openalex_works_become_graph_works() {
        let w = work_of(&json!({
            "id": "https://openalex.org/W42", "doi": "https://doi.org/10.1/ABC", "display_name": "A title", "publication_year": 2020,
            "authorships": [{ "author": { "display_name": "Ana Rivera" } }], "primary_location": { "source": { "display_name": "J" } },
            "type": "article", "referenced_works": ["https://openalex.org/W1"], "abstract_inverted_index": { "Short": [0], "text": [1] }
        }));
        assert_eq!(w.id, "W42");
        assert_eq!(w.doi.to_lowercase(), "10.1/abc");
        assert_eq!(w.authors, vec!["Rivera, Ana"]);
        assert_eq!(w.references, vec!["W1"]);
        assert_eq!(w.abstract_text, "Short text");
        assert_eq!(w.item_type, "journalArticle");
    }
}
