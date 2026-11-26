// OpenAlex enrichment for the key-store library (see key-store's openalex.rs for what is
// stored, cached and fetched on demand). A background worker looks up sources imported with
// a DOI, PMID or OpenAlex id (unless Settings turned that off) and any the user asks to
// enrich, one at a time: requests are paced, carry the `mailto` of the polite pool, retry
// with backoff when OpenAlex is busy, and a failed source is tried again later.
//
// A user's API key (Settings → Services & API keys) arrives from the app in
// `store_enrich_options`, never through the environment, and is a fallback: requests go out
// without it, and only one OpenAlex refuses or limits is sent again with the key (or every
// request carries it when the user chose "Always use"). Requests made with the key are
// counted for the app, which reads and clears the counts with `store_key_usage`.
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
/// Between two background lookups of older PDFs, on top of the pacing of each request.
const BACKFILL_PACE: Duration = Duration::from_secs(4);
/// Between two Crossref searches (its polite pool asks for little).
const CROSSREF_PACE: Duration = Duration::from_secs(1);
const WORK_FIELDS: &str = "id,doi,display_name,title,publication_year,publication_date,ids,language,primary_location,best_oa_location,type,open_access,authorships,biblio,is_retracted,cited_by_count,fwci,primary_topic,topics,keywords,funders,awards,referenced_works,abstract_inverted_index";
const CITED_FIELDS: &str = "id,doi,display_name,publication_year,authorships,primary_location";

#[derive(Clone, Debug)]
pub struct Options {
    /// Look up sources on import: the workspace's own choice, else the app's.
    pub auto: bool,
    /// The app-wide default (Key Settings › Privacy) and this workspace's override.
    pub app_auto: bool,
    pub own_auto: Option<bool>,
    pub mailto: String,
    pub api_key: Option<String>,
    /// Send the key with every request, not only when a keyless one fails.
    pub key_always: bool,
}

impl Options {
    fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let app_auto = var("KEY_OPENALEX_ENABLED").is_none_or(|v| v != "0");
        Self {
            auto: app_auto,
            app_auto,
            own_auto: None,
            mailto: var("KEY_OPENALEX_MAILTO").filter(|m| m.contains('@')).unwrap_or_else(|| DEFAULT_MAILTO.into()),
            // Older apps passed the key this way; the app now sends it in store_enrich_options.
            api_key: var("KEY_OPENALEX_API_KEY"),
            key_always: false,
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
    /// Crossref matched the title, but OpenAlex has no record of that DOI.
    Unlisted { doi: String, score: f64 },
}
impl Fail {
    pub(crate) fn message(&self) -> String {
        match self {
            Fail::NotFound => "OpenAlex has no record of this work".into(),
            Fail::Unlisted { doi, .. } => format!("OpenAlex has no record of {doi}"),
            Fail::Busy(m) | Fail::Error(m) => m.clone(),
        }
    }
}

#[derive(Clone)]
pub struct OpenAlex {
    options: Arc<Mutex<Options>>,
    signal: Arc<(Mutex<bool>, Condvar)>,
    focus: Arc<Mutex<Vec<String>>>,
    gate: Arc<Mutex<Option<Arc<dyn Fn() -> bool + Send + Sync>>>>,
}

impl OpenAlex {
    pub fn start(store: Store) -> Self {
        let worker = Self { options: Arc::new(Mutex::new(Options::from_env())), signal: Default::default(), focus: Default::default(), gate: Default::default() };
        let run = worker.clone();
        thread::Builder::new().name("key-openalex".into()).spawn(move || run.run(store)).expect("spawn OpenAlex worker");
        worker
    }

    pub fn options(&self) -> Options {
        self.options.lock().map(|o| o.clone()).unwrap_or_else(|_| Options::from_env())
    }

    /// This workspace's own lookups choice (Workspace Settings); None follows the app.
    pub fn set_own_auto(&self, own: Option<bool>) {
        if let Ok(mut options) = self.options.lock() {
            options.own_auto = own;
            options.auto = own.unwrap_or(options.app_auto);
        }
        self.wake();
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

    /// Background lookups of older PDFs run only while this answers true (indexing idle and
    /// not paused); without one they never run.
    pub fn set_backfill_gate(&self, gate: impl Fn() -> bool + Send + Sync + 'static) {
        if let Ok(mut slot) = self.gate.lock() {
            *slot = Some(Arc::new(gate));
        }
        self.wake();
    }

    /// The next background lookup of an older PDF, when nothing else waits, automatic
    /// lookups are on, the gate is open and the last one was a while ago.
    fn next_backfill(&self, store: &Store, options: &Options, last: Option<Instant>) -> Option<EnrichJob> {
        if !options.auto || last.is_some_and(|l| l.elapsed() < BACKFILL_PACE) {
            return None;
        }
        let gate = self.gate.lock().ok()?.clone()?;
        if !gate() {
            return None;
        }
        store.next_backfill_enrichment().ok().flatten()
    }

    fn run(self, store: Store) {
        let mut last_backfill: Option<Instant> = None;
        key_store::priority::set_thread_class(key_store::priority::Class::Background);
        loop {
            key_store::priority::yield_if_needed();
            let options = self.options();
            let focus = self.focus.lock().map(|f| f.clone()).unwrap_or_default();
            let next = match store.next_enrichment(options.auto, &focus) {
                Ok(None) => match self.next_backfill(&store, &options, last_backfill) {
                    Some(job) => {
                        last_backfill = Some(Instant::now());
                        Ok(Some(job))
                    }
                    None => Ok(None),
                },
                other => other,
            };
            match next {
                Ok(Some(job)) => {
                    let result = enrich(&store, &job, &options);
                    // Open library views refresh (throttled) as lookups fill sources in.
                    crate::events::library_changed();
                    if let Err(fail) = result {
                        let (status, retry) = match &fail {
                            Fail::NotFound | Fail::Unlisted { .. } => ("not_found", None),
                            // Busy: back off 1, 2, 4 … minutes, then give up until asked again.
                            _ if job.attempts + 1 < ATTEMPTS => ("failed", Some(key_store::now_ms() + 60_000 * (1 << job.attempts.clamp(0, 10)))),
                            _ => ("failed", None),
                        };
                        let _ = store.enrichment_failed(&job.id, status, &fail.message(), retry);
                    }
                }
                Ok(None) | Err(_) => {
                    // Background lookups waiting: come back once the pace allows the next.
                    let backfill = options.auto && store.backfill_status().is_ok_and(|s| s.lookup > 0);
                    let idle = if backfill { BACKFILL_PACE } else { Duration::from_secs(30) };
                    let (lock, condvar) = &*self.signal;
                    if let Ok(guard) = lock.lock() {
                        if let Ok((mut guard, _)) = condvar.wait_timeout_while(guard, idle, |woken| !*woken) {
                            *guard = false;
                        }
                    }
                }
            }
        }
    }
}

// ── Requests ────────────────────────────────────────────────

pub(crate) fn fixtures() -> Option<PathBuf> {
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
    let send = |path: &str, query: &[(&str, &str)], mailto: &str, key: Option<&str>| {
        {
            let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(wait) = last.and_then(|l| PACE.checked_sub(l.elapsed())) {
                thread::sleep(wait);
            }
            *last = Some(Instant::now());
        }
        // The same OpenAlex requests as web search (base URL, polite pool, key, transport).
        super::web_search::openalex::request(&super::web_search::http::send, path, query, Some(mailto), key, &key_safe_http::CancellationToken::active())
            .map(|r| key_reference::OpenAlexResponse { status: r.status, retry_after: r.retry_after(), remaining: r.remaining(), body: r.body })
            .map_err(|e| match e {
                super::web_search::http::SendError::Failed(message) => format!("OpenAlex: {message}"),
                other => format!("OpenAlex: {other:?}"),
            })
    };
    fetch_with(&send, &thread::sleep, path, query, options, attempts)
}

type Request<'a> = dyn Fn(&str, &[(&str, &str)], &str, Option<&str>) -> Result<key_reference::OpenAlexResponse, String> + 'a;

/// The keyless request first; the same request with the user's key only when OpenAlex limits
/// or refuses it, or stays busy through the retries (see the top of this file).
fn fetch_with(send: &Request<'_>, sleep: &dyn Fn(Duration), path: &str, query: &[(&str, &str)], options: &Options, attempts: usize) -> Result<Json, Fail> {
    let key = options.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty());
    let Some(key) = key else {
        return attempt(send, sleep, path, query, options, None, attempts, false).map_err(|(fail, _)| fail);
    };
    if options.key_always {
        return attempt(send, sleep, path, query, options, Some(key), attempts, false).map_err(|(fail, _)| fail);
    }
    match attempt(send, sleep, path, query, options, None, attempts, true) {
        Err((_, true)) => attempt(send, sleep, path, query, options, Some(key), attempts, false).map_err(|(fail, _)| fail),
        other => other.map_err(|(fail, _)| fail),
    }
}

/// One request, retried with backoff while OpenAlex is busy. The flag on an error says whether
/// a key could help; `hand_over` gives up at the first rate limit so the keyed request goes
/// at once rather than after the waits.
#[allow(clippy::too_many_arguments)]
fn attempt(send: &Request<'_>, sleep: &dyn Fn(Duration), path: &str, query: &[(&str, &str)], options: &Options, key: Option<&str>, attempts: usize, hand_over: bool) -> Result<Json, (Fail, bool)> {
    let mut delay = Duration::from_secs(1);
    for n in 0..attempts {
        let answer = send(path, query, &options.mailto, key);
        if key.is_some() {
            count_key_use(&answer);
        }
        let busy = match answer {
            Ok(response) => match response.status {
                200..=299 => return serde_json::from_slice(&response.body).map_err(|e| (Fail::Error(format!("OpenAlex sent an unreadable answer: {e}")), false)),
                404 => return Err((Fail::NotFound, false)),
                401 | 402 | 403 if key.is_some() => return Err((Fail::Error(format!("OpenAlex refused the API key (HTTP {})", response.status)), false)),
                401 | 402 | 403 => return Err((Fail::Error(format!("OpenAlex refused the request (HTTP {})", response.status)), true)),
                429 if hand_over => return Err((Fail::Busy("OpenAlex is limiting requests (HTTP 429)".into()), true)),
                429 | 500..=599 => {
                    delay = response.retry_after.map_or(delay, |d| d.min(Duration::from_secs(60)));
                    format!("OpenAlex is busy (HTTP {})", response.status)
                }
                status => return Err((Fail::Error(format!("OpenAlex returned HTTP {status}")), false)),
            },
            Err(error) => redact(&error, key),
        };
        if n + 1 == attempts {
            return Err((Fail::Busy(busy), true));
        }
        sleep(delay);
        delay *= 2;
    }
    Err((Fail::Busy("OpenAlex did not answer".into()), true))
}

/// An error never quotes the key (a URL in a message would carry it).
fn redact(message: &str, key: Option<&str>) -> String {
    match key {
        Some(key) if !key.is_empty() => message.replace(key, "••••"),
        _ => message.to_string(),
    }
}

#[derive(Default)]
struct KeyUsage {
    requests: u64,
    failures: u64,
    last_error: Option<String>,
    last_at: Option<i64>,
    remaining: Option<u64>,
    invalid: bool,
}
static KEY_USAGE: Mutex<KeyUsage> = Mutex::new(KeyUsage { requests: 0, failures: 0, last_error: None, last_at: None, remaining: None, invalid: false });

fn count_key_use(answer: &Result<key_reference::OpenAlexResponse, String>) {
    let mut usage = KEY_USAGE.lock().unwrap_or_else(|e| e.into_inner());
    usage.requests += 1;
    usage.last_at = Some(key_store::now_ms());
    match answer {
        Ok(response) if (200..300).contains(&response.status) || response.status == 404 => {
            if response.remaining.is_some() {
                usage.remaining = response.remaining;
            }
        }
        Ok(response) => {
            usage.failures += 1;
            usage.invalid |= matches!(response.status, 401 | 403);
            usage.last_error = Some(match response.status {
                401 | 403 => "OpenAlex refused the API key".into(),
                429 => "OpenAlex is limiting requests with this key".into(),
                status => format!("OpenAlex returned HTTP {status}"),
            });
            if response.remaining.is_some() {
                usage.remaining = response.remaining;
            }
        }
        Err(_) => {
            usage.failures += 1;
            usage.last_error = Some("Couldn't reach OpenAlex".into());
        }
    }
}

/// The counts since the last call, which starts them again.
fn take_key_usage() -> Json {
    let usage = std::mem::take(&mut *KEY_USAGE.lock().unwrap_or_else(|e| e.into_inner()));
    json!({ "requests": usage.requests, "failures": usage.failures, "lastError": usage.last_error, "lastAt": usage.last_at, "remaining": usage.remaining, "invalid": usage.invalid })
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
        } else if let Some(dois) = filter.strip_prefix("doi:") {
            let dois: Vec<String> = dois.split('|').map(str::to_ascii_lowercase).collect();
            records().into_iter().filter(|r| r.get("doi").and_then(Json::as_str).is_some_and(|d| dois.iter().any(|x| d.to_ascii_lowercase().ends_with(x.as_str())))).collect()
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
    key_store::normalize::doi_or_text(doi)
}

/// The work for a source: by OpenAlex id, DOI (as read from an added PDF, then its other
/// readings) or PMID, else by title. A title search result is accepted only when it is
/// clearly the same work (key_store::accept_title); the second value is that match's score.
pub(crate) fn find_work(job: &EnrichJob, options: &Options, record: Option<&Identification>, surnames: &[String]) -> Result<(Json, Option<(f64, &'static str)>), Fail> {
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
    if let Some((score, work)) = best {
        return Ok((work, Some((score, "title"))));
    }
    // OpenAlex has nothing by these titles: Crossref's search, held to the same test, and the
    // work by the DOI it gives.
    for title in titles.iter().take(2) {
        let Some((score, doi)) = crossref_match(title, &context, options)? else { continue };
        return match get(&format!("works/doi:{doi}"), &fields, options) {
            Ok(work) => Ok((work, Some((score, "crossref")))),
            Err(Fail::NotFound) => Err(Fail::Unlisted { doi, score }),
            Err(fail) => Err(fail),
        };
    }
    Err(Fail::NotFound)
}

/// The DOI of the Crossref work that is clearly the one titled `title` (key_store::accept_title).
fn crossref_match(title: &str, context: &TitleContext, options: &Options) -> Result<Option<(f64, String)>, Fail> {
    let items = crossref_search(title, options)?;
    let mut best: Option<(f64, String)> = None;
    for item in &items {
        let Some(doi) = item["DOI"].as_str().map(bare_doi).filter(|d| d.starts_with("10.")) else { continue };
        let year = ["issued", "published", "published-print", "published-online"]
            .iter()
            .find_map(|k| item[*k]["date-parts"][0][0].as_i64());
        let candidate = TitleCandidate {
            title: item["title"][0].as_str().unwrap_or("").to_string(),
            year,
            surnames: item["author"].as_array().into_iter().flatten().filter_map(|a| a["family"].as_str().or(a["name"].as_str()).map(String::from)).collect(),
        };
        if let Some(score) = accept_title(title, &candidate, context) {
            if best.as_ref().is_none_or(|(b, _)| score > *b) {
                best = Some((score, doi));
            }
        }
    }
    Ok(best)
}

/// Crossref's bibliographic search for a title: a few candidates, paced a second apart
/// (Crossref's polite pool asks for little), retried with backoff when it is busy.
fn crossref_search(title: &str, options: &Options) -> Result<Vec<Json>, Fail> {
    let query = [("query.bibliographic", title), ("rows", "5"), ("select", "DOI,title,author,issued,published,published-print,published-online")];
    if let Some(dir) = fixtures() {
        // Recorded: crossref.json lists items; the search is loose like Crossref's.
        let items: Vec<Json> = std::fs::read_to_string(dir.join("crossref.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Json>(&t).ok())
            .and_then(|v| v["message"]["items"].as_array().cloned())
            .unwrap_or_default();
        return Ok(items.into_iter().filter(|i| i["title"][0].as_str().is_some_and(|t| title_similarity(t, title) >= 0.6)).take(5).collect());
    }
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    let mut delay = Duration::from_secs(2);
    for attempt in 0..3 {
        {
            let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(wait) = last.and_then(|l| CROSSREF_PACE.checked_sub(l.elapsed())) {
                thread::sleep(wait);
            }
            *last = Some(Instant::now());
        }
        let busy = match key_reference::crossref_get("works", &query, Some(&options.mailto)) {
            Ok(response) => match response.status {
                200..=299 => {
                    let value: Json = serde_json::from_slice(&response.body).map_err(|e| Fail::Error(format!("Crossref sent an unreadable answer: {e}")))?;
                    return Ok(value["message"]["items"].as_array().cloned().unwrap_or_default());
                }
                404 => return Ok(Vec::new()),
                429 | 500..=599 => {
                    delay = response.retry_after.map_or(delay, |d| d.min(Duration::from_secs(60)));
                    format!("Crossref is busy (HTTP {})", response.status)
                }
                status => return Err(Fail::Error(format!("Crossref returned HTTP {status}"))),
            },
            Err(error) => error,
        };
        if attempt == 2 {
            return Err(Fail::Busy(busy));
        }
        thread::sleep(delay);
        delay *= 2;
    }
    Err(Fail::Busy("Crossref did not answer".into()))
}

/// Looks one source up and stores what OpenAlex knows, then the details of what it cites.
/// An added PDF identified as a work the library holds without a file joins that source;
/// its file-name title gives way to the work's.
pub fn enrich(store: &Store, job: &EnrichJob, options: &Options) -> Result<(), Fail> {
    let record = store.identification(&job.id).map_err(Fail::Error)?;
    let source = store.source(&job.id).map_err(Fail::Error)?;
    let surnames: Vec<String> = source.iter().flat_map(|s| s.creators.iter()).filter_map(|c| c.family.clone().or_else(|| c.literal.clone())).collect();
    let (work, score) = match find_work(job, options, record.as_ref(), &surnames) {
        // Only Crossref knows the work: its DOI is attached (when the source has none) and
        // the source counts as looked up; OpenAlex may list it later.
        Err(Fail::Unlisted { doi, score }) => {
            let has_doi = source.as_ref().is_some_and(|s| s.field("doi").is_some_and(|d| !d.trim().is_empty()));
            if !has_doi && source.is_some() {
                let mut patch = serde_json::Map::new();
                patch.insert("doi".into(), json!(doi));
                store.update_source(&job.id, &patch).map_err(Fail::Error)?;
                let mut record = record.unwrap_or_default();
                record.via = Some("crossref".into());
                record.score = Some(score);
                record.doi = Some(doi.clone());
                store.set_identification(&job.id, &record).map_err(Fail::Error)?;
            }
            return Err(Fail::Unlisted { doi, score });
        }
        found => found?,
    };
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
        if let Some((score, via)) = score {
            record.via = Some(via.into());
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
        "store_tag" => arg::<String>(args, "id").and_then(|id| json_output(store.tag_page(&id)?)),
        "store_map_centers" => arg::<String>(args, "text").and_then(|text| json_output(store.find_map_centers(&text, 10)?)),
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
                    options.app_auto = auto;
                    options.auto = options.own_auto.unwrap_or(auto);
                }
                if let Some(mailto) = arg::<Option<String>>(args, "mailto")? {
                    options.mailto = Some(mailto.trim().to_string()).filter(|m| m.contains('@')).unwrap_or_else(|| DEFAULT_MAILTO.into());
                }
                if let Some(key) = arg::<Option<String>>(args, "apiKey")? {
                    options.api_key = Some(key.trim().to_string()).filter(|k| !k.is_empty());
                }
                if let Some(mode) = arg::<Option<String>>(args, "keyMode")? {
                    options.key_always = mode == "always";
                }
            }
            openalex.wake();
            let options = openalex.options();
            json_output(json!({ "auto": options.auto, "mailto": options.mailto, "queue": store.enrichment_queue(options.auto)? }))
        })(),
        // What was asked with the user's key since the last read (Settings shows the usage).
        "store_key_usage" => json_output(take_key_usage()),
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
        // The page that asked is open: its counts are foreground work.
        key_store::priority::set_thread_class(key_store::priority::Class::Foreground);
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

    /// Recorded answers, one per request, and what each request carried.
    struct Recorded {
        answers: std::cell::RefCell<Vec<(u16, &'static str)>>,
        keys: std::cell::RefCell<Vec<Option<String>>>,
    }
    impl Recorded {
        fn new(answers: &[(u16, &'static str)]) -> Self {
            Self { answers: std::cell::RefCell::new(answers.iter().rev().cloned().collect()), keys: Default::default() }
        }
        fn send(&self, _path: &str, _query: &[(&str, &str)], _mailto: &str, key: Option<&str>) -> Result<key_reference::OpenAlexResponse, String> {
            self.keys.borrow_mut().push(key.map(String::from));
            let (status, body) = self.answers.borrow_mut().pop().expect("an answer for every request");
            Ok(key_reference::OpenAlexResponse { status, retry_after: None, remaining: (status == 200 && key.is_some()).then_some(41), body: body.as_bytes().to_vec() })
        }
    }
    const WORK: &str = r#"{"id":"https://openalex.org/W1","display_name":"A work"}"#;
    const LIMITED: &str = r#"{"error":"Rate limit exceeded"}"#;

    /// The usage counts are one per process; these tests take turns.
    static USAGE_TESTS: Mutex<()> = Mutex::new(());

    fn keyed(always: bool) -> Options {
        Options { auto: true, app_auto: true, own_auto: None, mailto: DEFAULT_MAILTO.into(), api_key: Some("sk-test-1234".into()), key_always: always }
    }

    /// The keyed retry path, from recorded answers: limited without a key → asked again with it.
    #[test]
    fn a_rate_limited_keyless_request_is_sent_again_with_the_key_and_counted() {
        let _turn = USAGE_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let _ = take_key_usage();
        let recorded = Recorded::new(&[(429, LIMITED), (200, WORK)]);
        let send = |p: &str, q: &[(&str, &str)], m: &str, k: Option<&str>| recorded.send(p, q, m, k);
        let work = fetch_with(&send, &|_| {}, "works/W1", &[], &keyed(false), 3).unwrap();
        assert_eq!(work["id"], "https://openalex.org/W1");
        assert_eq!(*recorded.keys.borrow(), vec![None, Some("sk-test-1234".to_string())]);
        let usage = take_key_usage();
        assert_eq!((usage["requests"].as_u64(), usage["failures"].as_u64(), usage["remaining"].as_u64()), (Some(1), Some(0), Some(41)));
        assert_eq!(take_key_usage()["requests"], 0, "reading clears the counts");

        // A keyless success never touches the key; without a key a limit just retries.
        let recorded = Recorded::new(&[(200, WORK)]);
        let send = |p: &str, q: &[(&str, &str)], m: &str, k: Option<&str>| recorded.send(p, q, m, k);
        fetch_with(&send, &|_| {}, "works/W1", &[], &keyed(false), 3).unwrap();
        assert_eq!(*recorded.keys.borrow(), vec![None]);
        let recorded = Recorded::new(&[(429, LIMITED), (429, LIMITED), (200, WORK)]);
        let send = |p: &str, q: &[(&str, &str)], m: &str, k: Option<&str>| recorded.send(p, q, m, k);
        let plain = Options { api_key: None, ..keyed(false) };
        fetch_with(&send, &|_| {}, "works/W1", &[], &plain, 3).unwrap();
        assert_eq!(recorded.keys.borrow().len(), 3);
        assert_eq!(take_key_usage()["requests"], 0);
    }

    #[test]
    fn always_sends_the_key_and_a_refused_key_is_reported_without_quoting_it() {
        let _turn = USAGE_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let _ = take_key_usage();
        let recorded = Recorded::new(&[(200, WORK)]);
        let send = |p: &str, q: &[(&str, &str)], m: &str, k: Option<&str>| recorded.send(p, q, m, k);
        fetch_with(&send, &|_| {}, "works/W1", &[], &keyed(true), 3).unwrap();
        assert_eq!(*recorded.keys.borrow(), vec![Some("sk-test-1234".to_string())]);
        let recorded = Recorded::new(&[(503, LIMITED), (403, LIMITED)]);
        let send = |p: &str, q: &[(&str, &str)], m: &str, k: Option<&str>| recorded.send(p, q, m, k);
        let fail = fetch_with(&send, &|_| {}, "works/W1", &[], &keyed(false), 1).unwrap_err();
        assert!(fail.message().contains("refused the API key"));
        let usage = take_key_usage();
        assert_eq!((usage["requests"].as_u64(), usage["failures"].as_u64(), usage["invalid"].as_bool()), (Some(2), Some(1), Some(true)));
        assert!(!usage.to_string().contains("sk-test-1234"));
        assert_eq!(redact("GET https://api.openalex.org/works?api_key=sk-test-1234 failed", Some("sk-test-1234")), "GET https://api.openalex.org/works?api_key=•••• failed");
    }

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
        let options = Options { auto: true, app_auto: true, own_auto: None, mailto: DEFAULT_MAILTO.into(), api_key: None, key_always: false };
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

        // OpenAlex has no such title; Crossref does, with the author on the page: its DOI
        // leads to the OpenAlex work. A Crossref work OpenAlex does not list gives its DOI.
        let crossref = json!({"message": {"items": [
            {"DOI": "10.5555/FALLS", "title": ["Video detection of falls in memory care: a cohort"], "issued": {"date-parts": [[2021]]}, "author": [{"family": "Bayen"}]},
            {"DOI": "10.5555/unlisted", "title": ["Night-time wandering in memory care units"], "issued": {"date-parts": [[2020]]}, "author": [{"family": "Nickels"}]},
            {"DOI": "10.5555/other", "title": ["Night-time wandering in memory care units"], "issued": {"date-parts": [[2020]]}, "author": [{"family": "Someone"}]}
        ]}});
        std::fs::write(fixtures.join("crossref.json"), crossref.to_string()).unwrap();
        let page = "Original Paper\nEleonore Bayen1,2; Shirley Nickels3\n2021";
        let fourth = store.insert_source(input(json!({"kind": "pdf", "title": "scan 4", "filePath": "/tmp/w.pdf", "fileHash": "h4"}))).unwrap();
        let record = Identification { titles: vec!["Video detection of falls in memory care: a cohort".into()], first_page: Some(page.into()), ..Default::default() };
        store.set_identification(&fourth.id, &record).unwrap();
        enrich(&store, &EnrichJob { id: fourth.id.clone(), ..Default::default() }, &options).unwrap();
        let found = store.source(&fourth.id).unwrap().unwrap();
        assert_eq!((found.field("openalexId"), found.field("identifiedBy")), (Some("W1"), Some("crossref")));
        let fifth = store.insert_source(input(json!({"kind": "pdf", "title": "scan 5", "filePath": "/tmp/v.pdf", "fileHash": "h5"}))).unwrap();
        let record = Identification { titles: vec!["Night-time wandering in memory care units".into()], first_page: Some(page.into()), ..Default::default() };
        store.set_identification(&fifth.id, &record).unwrap();
        assert!(matches!(enrich(&store, &EnrichJob { id: fifth.id.clone(), ..Default::default() }, &options), Err(Fail::Unlisted { .. })));
        let found = store.source(&fifth.id).unwrap().unwrap();
        assert_eq!((found.field("doi"), found.field("identifiedBy")), (Some("10.5555/unlisted"), Some("crossref")));
        unsafe { std::env::remove_var("KEY_OPENALEX_FIXTURES") };
    }
}
