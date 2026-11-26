// OpenAlex enrichment for the key-store library (see key-store's openalex.rs for what is
// stored, cached and fetched on demand). A background worker looks up sources imported with
// a DOI, PMID or OpenAlex id (unless Settings turned that off) and any the user asks to
// enrich, one at a time: requests are paced, carry the `mailto` of the polite pool, retry
// with backoff when OpenAlex is busy, and a failed source is tried again later.
//
// With KEY_OPENALEX_FIXTURES set to a folder of recorded responses (W….json, A….json,
// S….json and works-batch.json), nothing goes to the network; tests and smokes use it.
use super::{json_output, library_store::Library};
use crate::ipc::{Output, arg};
use key_store::{EnrichJob, Identification, Store, TitleCandidate, TitleContext, accept_title, title_similarity};
use serde_json::{Value as Json, json};
use std::{
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

const DEFAULT_MAILTO: &str = "key-app@users.noreply.github.com";
/// Pause between any two requests (OpenAlex allows ten a second; we stay well under).
const PACE: Duration = Duration::from_millis(250);
/// Cached counts older than this are fetched again when they are viewed.
const STALE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const ATTEMPTS: i64 = 6;
const WORK_FIELDS: &str = "id,doi,display_name,title,publication_year,publication_date,ids,language,primary_location,best_oa_location,type,open_access,authorships,biblio,is_retracted,cited_by_count,fwci,primary_topic,topics,keywords,funders,awards,referenced_works,abstract_inverted_index";
const CITED_FIELDS: &str = "id,doi,display_name,publication_year,authorships,primary_location";

#[derive(Clone, Debug)]
pub struct Options {
    /// Look up sources on import (Settings → Library).
    pub auto: bool,
    pub mailto: String,
    pub api_key: Option<String>,
}

impl Options {
    fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        Self {
            auto: var("KEY_OPENALEX_ENABLED").is_none_or(|v| v != "0"),
            mailto: var("KEY_OPENALEX_MAILTO").filter(|m| m.contains('@')).unwrap_or_else(|| DEFAULT_MAILTO.into()),
            api_key: var("KEY_OPENALEX_API_KEY"),
        }
    }
}

/// Why a request did not give a record.
#[derive(Debug)]
pub enum Fail {
    NotFound,
    /// Worth trying again later (rate limited, server or network trouble).
    Busy(String),
    Error(String),
}
impl Fail {
    fn message(&self) -> String {
        match self {
            Fail::NotFound => "OpenAlex has no record of this work".into(),
            Fail::Busy(m) | Fail::Error(m) => m.clone(),
        }
    }
}

#[derive(Clone)]
pub struct OpenAlex {
    options: Arc<Mutex<Options>>,
    signal: Arc<(Mutex<bool>, Condvar)>,
    focus: Arc<Mutex<Vec<String>>>,
}

impl OpenAlex {
    pub fn start(store: Store) -> Self {
        let worker = Self { options: Arc::new(Mutex::new(Options::from_env())), signal: Default::default(), focus: Default::default() };
        let run = worker.clone();
        thread::Builder::new().name("key-openalex".into()).spawn(move || run.run(store)).expect("spawn OpenAlex worker");
        worker
    }

    pub fn options(&self) -> Options {
        self.options.lock().map(|o| o.clone()).unwrap_or_else(|_| Options::from_env())
    }

    pub fn wake(&self) {
        let (lock, condvar) = &*self.signal;
        if let Ok(mut woken) = lock.lock() {
            *woken = true;
            condvar.notify_all();
        }
    }

    /// Sources open in a view are looked up first.
    pub fn focus(&self, id: &str) {
        if let Ok(mut focus) = self.focus.lock() {
            focus.retain(|f| f != id);
            focus.insert(0, id.to_string());
            focus.truncate(8);
        }
    }

    fn run(self, store: Store) {
        loop {
            let options = self.options();
            let focus = self.focus.lock().map(|f| f.clone()).unwrap_or_default();
            match store.next_enrichment(options.auto, &focus) {
                Ok(Some(job)) => {
                    if let Err(fail) = enrich(&store, &job, &options) {
                        let (status, retry) = match &fail {
                            Fail::NotFound => ("not_found", None),
                            // Busy: back off 1, 2, 4 … minutes, then give up until asked again.
                            _ if job.attempts + 1 < ATTEMPTS => ("failed", Some(key_store::now_ms() + 60_000 * (1 << job.attempts.clamp(0, 10)))),
                            _ => ("failed", None),
                        };
                        let _ = store.enrichment_failed(&job.id, status, &fail.message(), retry);
                    }
                }
                Ok(None) | Err(_) => {
                    let (lock, condvar) = &*self.signal;
                    if let Ok(guard) = lock.lock() {
                        if let Ok((mut guard, _)) = condvar.wait_timeout_while(guard, Duration::from_secs(30), |woken| !*woken) {
                            *guard = false;
                        }
                    }
                }
            }
        }
    }
}

// ── Requests ────────────────────────────────────────────────

fn fixtures() -> Option<PathBuf> {
    std::env::var_os("KEY_OPENALEX_FIXTURES").map(PathBuf::from).filter(|p| p.is_dir())
}

/// One request: paced against every other, retried with backoff while OpenAlex is busy.
pub fn get(path: &str, query: &[(&str, &str)], options: &Options) -> Result<Json, Fail> {
    fetch(path, query, options, 3)
}

/// One attempt, for something the user is waiting on: no backoff sleeps.
fn get_now(path: &str, query: &[(&str, &str)], options: &Options) -> Result<Json, Fail> {
    fetch(path, query, options, 1)
}

fn fetch(path: &str, query: &[(&str, &str)], options: &Options, attempts: usize) -> Result<Json, Fail> {
    if let Some(dir) = fixtures() {
        return fixture(&dir, path, query);
    }
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    let mut delay = Duration::from_secs(1);
    for attempt in 0..attempts {
        {
            let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(wait) = last.and_then(|l| PACE.checked_sub(l.elapsed())) {
                thread::sleep(wait);
            }
            *last = Some(Instant::now());
        }
        let busy = match key_reference::openalex_get(path, query, Some(&options.mailto), options.api_key.as_deref()) {
            Ok(response) => match response.status {
                200..=299 => return serde_json::from_slice(&response.body).map_err(|e| Fail::Error(format!("OpenAlex sent an unreadable answer: {e}"))),
                404 => return Err(Fail::NotFound),
                429 | 500..=599 => {
                    delay = response.retry_after.map_or(delay, |d| d.min(Duration::from_secs(60)));
                    format!("OpenAlex is busy (HTTP {})", response.status)
                }
                status => return Err(Fail::Error(format!("OpenAlex returned HTTP {status}"))),
            },
            Err(error) => error,
        };
        if attempt + 1 == attempts {
            return Err(Fail::Busy(busy));
        }
        thread::sleep(delay);
        delay *= 2;
    }
    Err(Fail::Busy("OpenAlex did not answer".into()))
}

/// Recorded responses: `works/W1` reads W1.json; `works/doi:…`, `works/pmid:…` and
/// `authors/orcid:…` search the records; a `works` list filtered by `openalex:` ids
/// collects them from works-batch.json and the W files.
fn fixture(dir: &std::path::Path, path: &str, query: &[(&str, &str)]) -> Result<Json, Fail> {
    let read = |name: &str| -> Option<Json> { std::fs::read_to_string(dir.join(name)).ok().and_then(|t| serde_json::from_str(&t).ok()) };
    let records = || -> Vec<Json> {
        let mut all: Vec<Json> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| std::fs::read_to_string(e.path()).ok())
            .filter_map(|t| serde_json::from_str::<Json>(&t).ok())
            .filter(|v| v.get("id").is_some())
            .collect();
        if let Some(batch) = read("works-batch.json") {
            all.extend(batch["results"].as_array().cloned().unwrap_or_default());
        }
        all
    };
    let short = |v: &Json| v.get("id").and_then(Json::as_str).map(|id| id.rsplit('/').next().unwrap_or("").to_string()).unwrap_or_default();
    let (collection, key) = path.trim_matches('/').split_once('/').unwrap_or((path.trim_matches('/'), ""));
    if collection == "works" && key.is_empty() {
        let filter = query.iter().find(|(k, _)| *k == "filter").map(|(_, v)| *v).unwrap_or("");
        let results: Vec<Json> = if let Some(ids) = filter.strip_prefix("openalex:") {
            let ids: Vec<&str> = ids.split('|').collect();
            let mut seen = std::collections::HashSet::new();
            records().into_iter().filter(|r| ids.contains(&short(r).as_str()) && seen.insert(short(r))).collect()
        } else if let Some(title) = filter.strip_prefix("title.search:") {
            // Like OpenAlex's search, loose: what to accept is the caller's decision.
            records().into_iter().filter(|r| r.get("display_name").and_then(Json::as_str).is_some_and(|t| title_similarity(t, title) >= 0.6)).take(5).collect()
        } else {
            Vec::new()
        };
        return Ok(json!({ "results": results }));
    }
    if let Some(found) = read(&format!("{key}.json")) {
        return Ok(found);
    }
    if let Some(found) = records().into_iter().find(|r| short(r) == key) {
        return Ok(found);
    }
    let (scheme, value) = key.split_once(':').ok_or(Fail::NotFound)?;
    let value = value.to_ascii_lowercase();
    records()
        .into_iter()
        .find(|r| {
            let field = match scheme {
                "doi" => r.get("doi"),
                "pmid" => r.get("ids").and_then(|i| i.get("pmid")),
                "orcid" => r.get("orcid"),
                _ => None,
            };
            field.and_then(Json::as_str).is_some_and(|f| f.to_ascii_lowercase().ends_with(&value))
        })
        .ok_or(Fail::NotFound)
}

fn bare_doi(doi: &str) -> String {
    let doi = doi.trim().to_ascii_lowercase();
    ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "doi:"].iter().find_map(|p| doi.strip_prefix(p).map(String::from)).unwrap_or(doi)
}

/// The work for a source: by OpenAlex id, DOI (as read from an added PDF, then its other
/// readings) or PMID, else by title. A title search result is accepted only when it is
/// clearly the same work (key_store::accept_title); the second value is that match's score.
fn find_work(job: &EnrichJob, options: &Options, record: Option<&Identification>, surnames: &[String]) -> Result<(Json, Option<f64>), Fail> {
    let fields = [("select", WORK_FIELDS)];
    let doi = job.doi.as_deref().map(bare_doi).filter(|d| d.starts_with("10."));
    let alternates = record.filter(|r| r.doi.is_some() && r.doi == doi).map(|r| r.alternates.clone()).unwrap_or_default();
    let ids = [job.openalex_id.as_deref().filter(|w| w.starts_with('W')).map(String::from)]
        .into_iter()
        .chain(doi.into_iter().chain(alternates).map(|d| Some(format!("doi:{d}"))))
        .chain([job.pmid.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(|p| format!("pmid:{p}"))]);
    let mut last = Fail::NotFound;
    for id in ids.flatten() {
        match get(&format!("works/{id}"), &fields, options) {
            Err(Fail::NotFound) => continue,
            Err(fail) => last = fail,
            Ok(found) => return Ok((found, None)),
        }
    }
    if !matches!(last, Fail::NotFound) {
        return Err(last);
    }
    // No identifier worked: the titles read from the PDF, else the source's own title.
    let placeholder = record.and_then(|r| r.placeholder.as_deref());
    let titles: Vec<String> = match record.map(|r| r.titles.clone()).unwrap_or_default() {
        titles if !titles.is_empty() => titles,
        _ => job.title.iter().map(|t| t.trim().to_string()).filter(|t| t.chars().count() >= 12 && Some(t.as_str()) != placeholder).collect(),
    };
    let context = TitleContext { year: job.year, surnames: surnames.to_vec(), page_text: record.and_then(|r| r.first_page.clone()) };
    let mut best: Option<(f64, Json)> = None;
    for title in titles.iter().take(3) {
        let filter = format!("title.search:{}", title.replace([',', '|', ':'], " "));
        let page = get("works", &[("filter", &filter), ("per-page", "8"), ("select", WORK_FIELDS)], options)?;
        for work in page["results"].as_array().into_iter().flatten() {
            let candidate = TitleCandidate {
                title: work["display_name"].as_str().unwrap_or("").to_string(),
                year: work["publication_year"].as_i64(),
                surnames: work["authorships"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|a| a["author"]["display_name"].as_str())
                    .filter_map(|name| name.split_whitespace().last().map(String::from))
                    .collect(),
            };
            if let Some(score) = accept_title(title, &candidate, &context) {
                if best.as_ref().is_none_or(|(b, _)| score > *b) {
                    best = Some((score, work.clone()));
                }
            }
        }
        if best.is_some() {
            break;
        }
    }
    best.map(|(score, work)| (work, Some(score))).ok_or(Fail::NotFound)
}

/// Looks one source up and stores what OpenAlex knows, then the details of what it cites.
/// An added PDF identified as a work the library holds without a file joins that source;
/// its file-name title gives way to the work's.
pub fn enrich(store: &Store, job: &EnrichJob, options: &Options) -> Result<(), Fail> {
    let record = store.identification(&job.id).map_err(Fail::Error)?;
    let source = store.source(&job.id).map_err(Fail::Error)?;
    let surnames: Vec<String> = source.iter().flat_map(|s| s.creators.iter()).filter_map(|c| c.family.clone().or_else(|| c.literal.clone())).collect();
    let (work, score) = find_work(job, options, record.as_ref(), &surnames)?;
    let work_id = work["id"].as_str().map(|w| w.rsplit('/').next().unwrap_or("").to_string());
    let work_doi = work["doi"].as_str().map(bare_doi);
    let mut id = job.id.clone();
    if source.as_ref().is_some_and(|s| s.file_path().is_some()) {
        if let Some(reference) = store.file_less_source_for(&job.id, work_id.as_deref(), work_doi.as_deref()).map_err(Fail::Error)? {
            store.adopt_file(&reference, &job.id).map_err(Fail::Error)?;
            id = reference;
        }
    }
    store.apply_openalex_work(&id, &work).map_err(Fail::Error)?;
    if let Some(mut record) = store.identification(&id).map_err(Fail::Error)? {
        if let Some(score) = score {
            record.via = Some("title".into());
            record.score = Some(score);
            record.doi = work_doi.clone();
        } else if let (Some(read), Some(actual)) = (record.doi.clone(), work_doi.clone()) {
            // Found through another reading of the printed DOI: OpenAlex's is the right one.
            if read != actual && store.correct_doi(&id, &read, &actual).map_err(Fail::Error)? {
                record.doi = Some(actual);
            }
        }
        store.set_identification(&id, &record).map_err(Fail::Error)?;
        if let Some(title) = work["display_name"].as_str().or(work["title"].as_str()) {
            store.adopt_title(&id, title).map_err(Fail::Error)?;
        }
    }
    for _ in 0..4 {
        let ids = store.cites_without_details(&id, 50).map_err(Fail::Error)?;
        if ids.is_empty() {
            break;
        }
        let filter = format!("openalex:{}", ids.join("|"));
        let page = match get("works", &[("filter", &filter), ("per-page", "50"), ("select", CITED_FIELDS)], options) {
            Ok(page) => page,
            // The work itself is stored; the titles of what it cites can come another time.
            Err(_) => break,
        };
        let works = page["results"].as_array().cloned().unwrap_or_default();
        store.apply_openalex_cited(&id, &works).map_err(Fail::Error)?;
        if works.is_empty() {
            break;
        }
    }
    Ok(())
}

fn stale(fetched: Option<i64>) -> bool {
    fetched.is_none_or(|at| key_store::now_ms() - at > STALE_MS)
}

/// Works as OpenAlex lists them, each with the library source it is (if any).
fn described(store: &Store, ids: &[String], options: &Options) -> Result<Vec<Json>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let filter = format!("openalex:{}", ids.iter().take(50).cloned().collect::<Vec<_>>().join("|"));
    let page = get_now("works", &[("filter", &filter), ("per-page", "50"), ("select", CITED_FIELDS)], options).map_err(|f| f.message())?;
    let mut out = Vec::new();
    for work in page["results"].as_array().into_iter().flatten() {
        let id = work["id"].as_str().map(|i| i.rsplit('/').next().unwrap_or("").to_string()).unwrap_or_default();
        let doi = work["doi"].as_str().map(bare_doi);
        let names: Vec<&str> = work["authorships"].as_array().into_iter().flatten().filter_map(|a| a["author"]["display_name"].as_str()).collect();
        out.push(json!({
            "openalexId": id,
            "title": work["display_name"],
            "byline": match names.len() { 0 => String::new(), 1 | 2 => names.join(", "), _ => format!("{} et al.", names[0]) },
            "year": work["publication_year"],
            "doi": doi,
            "container": work["primary_location"]["source"]["display_name"],
            "matchedSourceId": store.source_for_work(Some(&id), doi.as_deref())?,
        }));
    }
    Ok(out)
}

pub fn dispatch(library: &Library, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let store = &library.store;
    let openalex = &library.openalex;
    let result = match command {
        // The graph around one source, and the pages of a person, venue and topic.
        "store_source_graph" => arg::<String>(args, "id").and_then(|id| {
            openalex.focus(&id);
            json_output(store.source_graph(&id)?)
        }),
        "store_person" => arg::<String>(args, "id").and_then(|id| json_output(store.person_page(&id)?)),
        "store_venue" => arg::<String>(args, "id").and_then(|id| json_output(store.venue_page(&id)?)),
        "store_topic" => arg::<String>(args, "id").and_then(|id| json_output(store.topic_page(&id)?)),
        // The relations around any of them (or a tag, collection or source), for the maps.
        "store_relation_map" => (|| {
            let limit = arg::<Option<usize>>(args, "limit")?.unwrap_or(8);
            json_output(store.relation_map(&arg::<String>(args, "kind")?, &arg::<String>(args, "id")?, limit)?)
        })(),
        "store_merge_suggestions" => store.merge_suggestions().and_then(json_output),
        "store_merge_people" => (|| json_output(store.merge_people(&arg::<String>(args, "keep")?, &arg::<String>(args, "other")?)?))(),
        "store_merge_dismiss" => (|| json_output(store.dismiss_merge(&arg::<String>(args, "personId")?, &arg::<String>(args, "otherId")?)?))(),
        "store_property_options" => arg::<String>(args, "name").and_then(|name| json_output(store.property_options(&name)?)),
        "store_rename_property_option" => (|| {
            json_output(store.rename_property_option(&arg::<String>(args, "name")?, &arg::<String>(args, "from")?, &arg::<String>(args, "to")?)?)
        })(),
        // "Enrich" on a source or a selection.
        "store_enrich" => arg::<Vec<String>>(args, "ids").and_then(|ids| {
            let count = store.request_enrichment(&ids)?;
            openalex.wake();
            json_output(count)
        }),
        "store_enrich_options" => (|| {
            if let Ok(mut options) = openalex.options.lock() {
                if let Some(auto) = arg::<Option<bool>>(args, "auto")? {
                    options.auto = auto;
                }
                if let Some(mailto) = arg::<Option<String>>(args, "mailto")? {
                    options.mailto = Some(mailto.trim().to_string()).filter(|m| m.contains('@')).unwrap_or_else(|| DEFAULT_MAILTO.into());
                }
                if let Some(key) = arg::<Option<String>>(args, "apiKey")? {
                    options.api_key = Some(key.trim().to_string()).filter(|k| !k.is_empty());
                }
            }
            openalex.wake();
            let options = openalex.options();
            json_output(json!({ "auto": options.auto, "mailto": options.mailto, "queue": store.enrichment_queue(options.auto)? }))
        })(),
        // Cached counts (tier b), fetched again when stale and viewed. Without automatic
        // lookups only `force` (the user's Refresh) goes to the network.
        // Cached counts (tier b): answered at once with what is stored; when they are old (or
        // on the user's Refresh) they are fetched in the background and the page reads them
        // again. Without automatic lookups only `force` goes to the network.
        "store_refresh" => (|| {
            let kind: String = arg(args, "kind")?;
            let id: String = arg(args, "id")?;
            let force = arg::<Option<bool>>(args, "force")?.unwrap_or(false);
            let options = openalex.options();
            let allowed = force || options.auto;
            let (path, query): (Option<String>, &[(&str, &str)]) = match kind.as_str() {
                "person" => {
                    let person = store.person(&id)?.ok_or("Person not found")?;
                    let key = person.openalex_id.clone().or_else(|| person.orcid.as_ref().map(|o| format!("orcid:{o}")));
                    ((force || stale(person.metrics_at)).then_some(key).flatten().map(|k| format!("authors/{k}")), &[])
                }
                "venue" => {
                    let venue = store.venue(&id)?.ok_or("Journal not found")?;
                    ((force || stale(venue.metrics_at)).then_some(venue.openalex_id).flatten().map(|k| format!("sources/{k}")), &[])
                }
                _ => {
                    let source = store.source(&id)?.ok_or("Source not found")?;
                    let fetched = source.fields.get("metricsAt").and_then(Json::as_i64);
                    let work = source.field("openalexId").map(String::from);
                    ((force || stale(fetched)).then_some(work).flatten().map(|w| format!("works/{w}")), &[("select", "id,cited_by_count,fwci,is_retracted")])
                }
            };
            let refreshing = match path.filter(|_| allowed) {
                Some(path) => refresh_later(store.clone(), kind.clone(), id.clone(), path, query.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), options),
                None => false,
            };
            let mut value = match kind.as_str() {
                "person" => serde_json::to_value(store.person_page(&id)?),
                "venue" => serde_json::to_value(store.venue_page(&id)?),
                _ => serde_json::to_value(store.source(&id)?),
            }
            .map_err(|e| e.to_string())?;
            if let Some(object) = value.as_object_mut() {
                object.insert("refreshing".into(), json!(refreshing));
            }
            json_output(value)
        })(),
        // Not stored (tier c): citations by year and related works, when the user asks.
        "store_openalex_extra" => (|| {
            let kind: String = arg(args, "kind")?;
            let id: String = arg(args, "id")?;
            let options = openalex.options();
            let path = match kind.as_str() {
                "person" => {
                    let person = store.person(&id)?.ok_or("Person not found")?;
                    format!("authors/{}", person.openalex_id.or(person.orcid.map(|o| format!("orcid:{o}"))).ok_or("Not in OpenAlex yet")?)
                }
                "venue" => format!("sources/{}", store.venue(&id)?.ok_or("Journal not found")?.openalex_id.ok_or("Not in OpenAlex yet")?),
                _ => format!("works/{}", store.source(&id)?.ok_or("Source not found")?.field("openalexId").ok_or("Not in OpenAlex yet")?),
            };
            let select = if kind == "source" { "id,counts_by_year,related_works" } else { "id,counts_by_year" };
            let record = get_now(&path, &[("select", select)], &options).map_err(|f| f.message())?;
            let related: Vec<String> = record["related_works"].as_array().into_iter().flatten().filter_map(Json::as_str).map(|w| w.rsplit('/').next().unwrap_or("").to_string()).collect();
            json_output(json!({ "countsByYear": record["counts_by_year"], "related": described(store, &related, &options)? }))
        })(),
        // One cited or related work's abstract and links, when the user opens it (not stored).
        "store_openalex_work" => (|| {
            let work: String = arg(args, "openalexId")?;
            let options = openalex.options();
            let record = get_now(&format!("works/{work}"), &[("select", "id,doi,abstract_inverted_index,open_access,cited_by_count")], &options);
            let record = match record {
                Ok(record) => record,
                Err(Fail::NotFound) => return json_output(json!({ "abstract": null })),
                Err(fail) => return Err(fail.message()),
            };
            json_output(json!({
                "abstract": record.get("abstract_inverted_index").and_then(key_store::abstract_text),
                "doi": record["doi"].as_str().map(bare_doi),
                "oaUrl": record["open_access"]["oa_url"],
                "citedByCount": record["cited_by_count"],
            }))
        })(),
        // "Add to library" for a cited work that is not in it yet: a reference, looked up next.
        "store_add_work" => (|| {
            let work: String = arg(args, "openalexId")?;
            if let Some(existing) = store.source_for_work(Some(&work), arg::<Option<String>>(args, "doi")?.as_deref())? {
                return json_output(store.source(&existing)?);
            }
            let mut fields = serde_json::Map::new();
            fields.insert("openalexId".into(), json!(work));
            fields.insert("itemType".into(), json!("article"));
            for (key, name) in [("title", "title"), ("doi", "doi"), ("year", "year")] {
                if let Some(value) = args.get(name).filter(|v| !v.is_null()) {
                    fields.insert(key.into(), value.clone());
                }
            }
            let collection: Option<String> = arg(args, "collectionId")?;
            let source = store.insert_source(key_store::SourceInput { kind: "reference".into(), fields, collections: collection.into_iter().collect(), index_status: Some("skipped".into()), ..Default::default() })?;
            store.request_enrichment(std::slice::from_ref(&source.id))?;
            openalex.focus(&source.id);
            openalex.wake();
            json_output(store.source(&source.id)?)
        })(),
        _ => return None,
    };
    Some(result)
}

/// Fetches cached counts on a thread of their own, once per item at a time. Answers whether
/// a fetch is running for it.
fn refresh_later(store: Store, kind: String, id: String, path: String, query: Vec<(String, String)>, options: Options) -> bool {
    static RUNNING: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let key = format!("{kind}:{id}");
    {
        let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if running.contains(&key) {
            return true;
        }
        running.push(key.clone());
    }
    let spawned = thread::Builder::new().name("key-openalex-refresh".into()).spawn(move || {
        let query: Vec<(&str, &str)> = query.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        if let Ok(record) = get(&path, &query, &options) {
            let _ = match kind.as_str() {
                "person" => store.apply_openalex_author(&id, &record),
                "venue" => store.apply_openalex_venue(&id, &record),
                _ => store.apply_openalex_metrics(&id, &record),
            };
        }
        RUNNING.lock().unwrap_or_else(|e| e.into_inner()).retain(|k| *k != key);
    });
    spawned.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use key_store::SourceInput;

    fn input(value: Json) -> SourceInput {
        serde_json::from_value(value).unwrap()
    }

    /// Title searches and the joining of a reference, from recorded responses.
    #[test]
    fn an_added_pdf_found_by_title_takes_the_works_metadata_and_joins_its_reference() {
        let dir = tempfile::tempdir().unwrap();
        let fixtures = dir.path().join("fixtures");
        std::fs::create_dir_all(&fixtures).unwrap();
        let title = "Reduction of Time on the Ground Related to Real-Time Video Detection of Falls in Memory Care Facilities: Observational Study";
        let work = json!({
            "id": "https://openalex.org/W1", "doi": "https://doi.org/10.5555/falls", "display_name": title, "publication_year": 2021,
            "authorships": [{"author": {"display_name": "Eleonore Bayen"}}, {"author": {"display_name": "Shirley Nickels"}}]
        });
        let reply = json!({
            "id": "https://openalex.org/W2", "display_name": format!("Reply: {title}"), "publication_year": 2021,
            "authorships": [{"author": {"display_name": "A Critic"}}]
        });
        std::fs::write(fixtures.join("W1.json"), work.to_string()).unwrap();
        std::fs::write(fixtures.join("W2.json"), reply.to_string()).unwrap();
        // SAFETY: the only test in this binary that reads the fixtures setting.
        unsafe { std::env::set_var("KEY_OPENALEX_FIXTURES", &fixtures) };
        let store = Store::open(dir.path().join("library")).unwrap();
        let options = Options { auto: true, mailto: DEFAULT_MAILTO.into(), api_key: None };
        let reference = store.insert_source(input(json!({"kind": "reference", "title": "Falls paper (to read)", "doi": "10.5555/falls"}))).unwrap();
        let added = store.insert_source(input(json!({"kind": "pdf", "title": "Downloaded paper", "filePath": "/tmp/x.pdf", "fileHash": "h1"}))).unwrap();
        let record = Identification {
            placeholder: Some("Downloaded paper".into()),
            titles: vec!["Reduction of time on the ground related to real-time video detection of falls in memory care facilities".into()],
            first_page: Some("Original Paper\nReduction of Time on the Ground\nEleonore Bayen1,2, MD, PhD; Shirley Nickels3".into()),
            ..Default::default()
        };
        store.set_identification(&added.id, &record).unwrap();
        store.queue_lookup(&added.id).unwrap();
        let job = store.next_enrichment(true, &[reference.id.clone()]).unwrap().unwrap();
        let job = if job.id == added.id { job } else { EnrichJob { id: added.id.clone(), title: Some("Downloaded paper".into()), ..Default::default() } };
        enrich(&store, &job, &options).unwrap();
        assert!(store.source(&added.id).unwrap().is_none(), "joined the reference");
        let joined = store.source(&reference.id).unwrap().unwrap();
        assert_eq!((joined.field("openalexId"), joined.file_hash(), joined.title()), (Some("W1"), Some("h1"), "Falls paper (to read)"));
        assert_eq!(joined.field("identifiedBy"), Some("title"));

        // Another file of the same work with no reference to join: the work's title replaces
        // the file name. A title nothing was written like finds nothing.
        let second = store.insert_source(input(json!({"kind": "pdf", "title": "PUBMED 34137723", "filePath": "/tmp/y.pdf", "fileHash": "h2"}))).unwrap();
        let record = Identification { placeholder: Some("PUBMED 34137723".into()), titles: vec![title.into()], ..Default::default() };
        store.set_identification(&second.id, &record).unwrap();
        enrich(&store, &EnrichJob { id: second.id.clone(), title: Some("PUBMED 34137723".into()), ..Default::default() }, &options).unwrap();
        let named = store.source(&second.id).unwrap().unwrap();
        assert_eq!(named.title(), title);
        assert_eq!(named.creators.len(), 2);
        let third = store.insert_source(input(json!({"kind": "pdf", "title": "notes", "filePath": "/tmp/z.pdf"}))).unwrap();
        let record = Identification { titles: vec!["Falls in nursing homes and what to do about them".into()], ..Default::default() };
        store.set_identification(&third.id, &record).unwrap();
        assert!(matches!(enrich(&store, &EnrichJob { id: third.id.clone(), ..Default::default() }, &options), Err(Fail::NotFound)));
        unsafe { std::env::remove_var("KEY_OPENALEX_FIXTURES") };
    }
}
