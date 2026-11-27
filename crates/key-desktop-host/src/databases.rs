// Database search (`db_*`, connectors/COMMANDS.md): the declarative connectors of
// crates/key-connectors run here. A search is a run in the background (one thread per
// connector, polite to each service); the app polls `db_results`, which merges what came in
// with key-store's duplicate matcher and marks what the library already has. Runs, saved
// searches and connector health are kept on disk; connector updates are bundles
// (key_connectors::bundle; unsigned while signing is postponed) checked on demand and at most daily.
//
// Keys come from the app (`db_options`, like `web_options`); nothing here reads a keychain.
use super::web_search::{self, Library, library::Asked, types::{Ids, WebResult}};
use crate::ipc::{Output, arg, json_output};
use key_connectors::baseline::{self, Loaded};
use key_connectors::bundle::{self, Store, Trust};
use key_connectors::engine::{CancellationSource, Credentials, Engine, EngineError, Request, RunControl, SearchState, Transport};
use key_connectors::merge::{Found, Merger};
use key_connectors::net::SafeTransport;
use key_connectors::query::{self, Query};
use key_connectors::record::Record;
use key_connectors::report::{RunReport, SourceLog};
use key_connectors::spec::Spec;
use key_connectors::template::Vars;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

const ISSUES_URL: &str = "https://github.com/JonasWeinert/key-research/issues/new";
const DEFAULT_LIMIT: usize = 500;
const MAX_LIMIT: usize = 10_000;
const KEEP_RUNS: usize = 50;
/// Consecutive failures (not counting the network being down) before "may be out of date".
const FAILING_AFTER: u32 = 3;

#[derive(Clone, Debug, Default)]
struct Options {
    /// Secret values by secret name ("ncbi", "elsevier", ...).
    keys: BTreeMap<String, String>,
    mailto: Option<String>,
    update_url: Option<String>,
    dir: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Health {
    failures: u32,
    last_error: Option<String>,
    outdated: bool,
    last_ok_at: Option<i64>,
    last_fail_at: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Progress {
    connector: String,
    state: String,
    fetched: usize,
    raw: usize,
    total: Option<u64>,
    wait_ms: Option<u64>,
    error: Option<String>,
    error_kind: Option<String>,
    native: String,
    chunks: usize,
    has_more: bool,
    requests: u32,
    quota_remaining: Option<u64>,
    undated: usize,
    warnings: Vec<String>,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    /// Ruled out by the check of the full search, kept unverifiable, found again by a later query.
    rejected: usize,
    unverified: usize,
    repeats: usize,
    /// How the search is run here (key_connectors::plan).
    strategy: Option<key_connectors::plan::Strategy>,
}

struct RunData {
    state: String,
    progress: BTreeMap<String, Progress>,
    searches: HashMap<String, SearchState>,
    merger: Merger,
    finished_at: Option<i64>,
    limit: usize,
    previous: HashSet<String>,
}

struct Run {
    id: String,
    label: String,
    saved_id: Option<String>,
    query: Query,
    options: BTreeMap<String, Vars>,
    overrides: BTreeMap<String, String>,
    started_at: i64,
    background: bool,
    cancel: Mutex<CancellationSource>,
    data: Mutex<RunData>,
    connectors: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Saved {
    id: String,
    name: String,
    query: Query,
    connectors: Vec<String>,
    overrides: BTreeMap<String, String>,
    options: BTreeMap<String, Vars>,
    created_at: i64,
    last_run_at: Option<i64>,
    last_run_id: Option<String>,
    last_count: Option<usize>,
    new_count: Option<usize>,
    /// Identities of the works the last run found ("new since last run").
    #[serde(skip_serializing_if = "Vec::is_empty")]
    seen: Vec<String>,
}

pub struct Databases {
    root: PathBuf,
    engine: Arc<Engine>,
    transport: Arc<dyn Transport>,
    options: Mutex<Options>,
    loaded: RwLock<(BTreeMap<String, Loaded>, Option<bundle::Verified>)>,
    runs: Mutex<HashMap<String, Arc<Run>>>,
    estimates: Mutex<HashMap<String, CancellationSource>>,
    health: Mutex<BTreeMap<String, Health>>,
    counter: AtomicU64,
    dev_trust: bool,
}

fn now_ms() -> i64 {
    key_connectors::time::now_ms()
}

/// "Family, Given" as people write it ("Given Family"); a literal name stays.
fn display_name(name: &str) -> String {
    match name.split_once(", ") {
        Some((family, given)) if !given.contains(',') && !given.trim().is_empty() => format!("{} {}", given.trim(), family.trim()),
        _ => name.to_string(),
    }
}

fn web_kind(kind: Option<&str>) -> Option<String> {
    Some(
        match kind? {
            "working-paper" | "report" => "report",
            "preprint" => "preprint",
            "book" => "book",
            "chapter" => "book-chapter",
            "thesis" => "dissertation",
            "dataset" => "dataset",
            "trial" => "trial",
            _ => "article",
        }
        .to_string(),
    )
}

/// The record as web search's result (what `inbox_save` and the add path take).
fn web_result(connector: &str, r: &Record) -> WebResult {
    WebResult {
        provider: connector.into(),
        provider_id: r.source_id.clone(),
        title: r.title.clone(),
        authors: r.authors.iter().map(|a| display_name(a)).collect(),
        year: r.year,
        venue: r.venue.clone().or_else(|| r.series.clone()),
        abstract_: r.abstract_.clone(),
        doi: r.doi.clone(),
        ids: Ids { openalex: r.openalex.clone(), arxiv: r.arxiv.clone(), pmid: r.pmid.clone(), pmcid: r.pmcid.clone(), ..Default::default() },
        pdf_url: r.pdf_url.clone(),
        landing_url: r.url.clone(),
        kind: web_kind(r.kind.as_deref()),
        ..Default::default()
    }
}

/// What identifies a work across runs: its DOI, else each source's own id.
fn identities(versions: &[Found], record: &Record) -> Vec<String> {
    let mut out: Vec<String> = record.doi.iter().map(|d| format!("doi:{d}")).collect();
    out.extend(versions.iter().map(|v| format!("{}:{}", v.connector, v.record.source_id)));
    out
}

impl Databases {
    pub fn new(root: PathBuf) -> Self {
        let transport: Arc<dyn Transport> = Arc::new(SafeTransport::from_env());
        let dev_trust = std::env::var("KEY_CONNECTORS_DEV_TRUST").is_ok_and(|v| v == "1");
        let this = Self {
            root,
            engine: Arc::new(Engine::new(transport.clone())),
            transport,
            options: Mutex::default(),
            loaded: RwLock::new((BTreeMap::new(), None)),
            runs: Mutex::default(),
            estimates: Mutex::default(),
            health: Mutex::default(),
            counter: AtomicU64::new(1),
            dev_trust,
        };
        *this.health.lock().unwrap_or_else(|e| e.into_inner()) = std::fs::read(this.health_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        this.reload();
        this
    }

    /// A minute after start, and then every few hours, checks for connector updates (at most
    /// once a day; nothing is fetched without an update address in connectors/trust.json).
    pub fn start_background_checks(self: &Arc<Self>) {
        if std::env::var("KEY_CONNECTORS_NO_AUTO_CHECK").is_ok() {
            return;
        }
        let weak = Arc::downgrade(self);
        let _ = std::thread::Builder::new().name("key-db-updates".into()).spawn(move || {
            std::thread::sleep(Duration::from_secs(60));
            loop {
                let Some(this) = weak.upgrade() else { return };
                key_store::priority::set_thread_class(key_store::priority::Class::Background);
                if this.trust().configured() {
                    this.check_updates(false);
                }
                drop(this);
                std::thread::sleep(Duration::from_secs(6 * 3600));
            }
        });
    }

    fn data_dir(&self) -> PathBuf {
        self.root.join("databases")
    }

    fn store(&self) -> Store {
        let dir = self.options.lock().ok().and_then(|o| o.dir.clone()).or_else(|| std::env::var("KEY_CONNECTORS_DIR").ok().map(PathBuf::from)).unwrap_or_else(|| self.root.join("connectors"));
        Store::new(dir)
    }

    fn health_path(&self) -> PathBuf {
        self.data_dir().join("health.json")
    }

    fn trust(&self) -> Trust {
        let mut trust = Trust::embedded(self.dev_trust);
        if let Some(url) = self.options.lock().ok().and_then(|o| o.update_url.clone()).or_else(|| std::env::var("KEY_CONNECTORS_UPDATE_URL").ok()) {
            trust.update_url = url;
        }
        trust
    }

    /// Built-in plus verified downloaded connectors.
    fn reload(&self) {
        let verified = self.store().load(&self.trust(), key_connectors::time::now_secs());
        let set = baseline::combine(verified.as_ref());
        *self.loaded.write().unwrap_or_else(|e| e.into_inner()) = (set, verified);
    }

    fn connector(&self, id: &str) -> Result<Loaded, String> {
        self.loaded.read().unwrap_or_else(|e| e.into_inner()).0.get(id).cloned().ok_or_else(|| format!("No database connector {id}"))
    }

    fn credentials(&self, spec: &Spec) -> Credentials {
        let options = self.options.lock().unwrap_or_else(|e| e.into_inner());
        spec.credentials.iter().filter_map(|c| options.keys.get(&c.secret).map(|v| (c.id.clone(), v.clone()))).collect()
    }

    fn set_options(&self, args: &Json) {
        let mut o = self.options.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(keys) = args.get("keys").and_then(Json::as_object) {
            for (secret, value) in keys {
                // A value, or {key: value} as web_options sends it; null removes it.
                let v = value.as_str().map(String::from).or_else(|| value.get("key").and_then(Json::as_str).map(String::from)).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
                match v {
                    Some(v) => o.keys.insert(secret.clone(), v),
                    None => o.keys.remove(secret),
                };
            }
        }
        if let Some(m) = args.get("mailto").and_then(Json::as_str) {
            o.mailto = Some(m.trim().to_string()).filter(|m| m.contains('@'));
            *self.engine.mailto.lock().unwrap_or_else(|e| e.into_inner()) = o.mailto.clone();
        }
        if let Some(url) = args.get("updateUrl").and_then(Json::as_str) {
            o.update_url = Some(url.trim().trim_end_matches('/').to_string()).filter(|u| u.starts_with("https://"));
        }
        let dir_changed = if let Some(dir) = args.get("connectorsDir").and_then(Json::as_str) {
            o.dir = Some(PathBuf::from(dir)).filter(|d| d.is_absolute());
            true
        } else {
            false
        };
        drop(o);
        if dir_changed {
            self.reload();
        }
    }

    fn health_of(&self, id: &str) -> Json {
        let h = self.health.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned().unwrap_or_default();
        let state = if h.failures >= FAILING_AFTER {
            if h.outdated { "outdated" } else { "failing" }
        } else if h.last_ok_at.is_some() && h.failures == 0 {
            "ok"
        } else {
            "unknown"
        };
        json!({ "state": state, "failures": h.failures, "lastError": h.last_error, "lastOkAt": h.last_ok_at, "lastFailAt": h.last_fail_at })
    }

    fn record_health(&self, id: &str, outcome: Result<(), &EngineError>) {
        let mut all = self.health.lock().unwrap_or_else(|e| e.into_inner());
        let h = all.entry(id.to_string()).or_default();
        match outcome {
            Ok(()) => {
                h.failures = 0;
                h.outdated = false;
                h.last_ok_at = Some(now_ms());
            }
            Err(e) if e.kind == "cancelled" => return,
            Err(e) => {
                h.last_error = Some(e.message.clone());
                h.last_fail_at = Some(now_ms());
                // The network being down says nothing about the connector.
                if e.kind != "network" {
                    h.failures += 1;
                    h.outdated = e.suggests_outdated();
                }
            }
        }
        let _ = std::fs::create_dir_all(self.data_dir());
        let _ = std::fs::write(self.health_path(), serde_json::to_vec_pretty(&*all).unwrap_or_default());
    }

    fn info(&self, l: &Loaded) -> Json {
        let spec = &l.connector.spec;
        let creds = self.credentials(spec);
        let credentials: Vec<Json> = spec
            .credentials
            .iter()
            .map(|c| json!({ "id": c.id, "label": c.label, "required": c.required, "secret": c.secret, "help": c.help, "url": c.url, "present": creds.contains_key(&c.id) }))
            .collect();
        let needs_key = spec.credentials.iter().any(|c| c.required && !creds.contains_key(&c.id));
        let has_key = !spec.credentials.is_empty() && spec.credentials.iter().all(|c| creds.contains_key(&c.id));
        let state = self.store().state();
        let caps = &spec.capabilities;
        json!({
            "id": spec.id, "name": spec.name, "description": spec.description, "category": spec.category, "coverage": spec.coverage,
            "terms": spec.terms, "homepage": spec.homepage, "version": spec.version, "kind": spec.kind, "guide": spec.guide,
            "credentials": credentials, "needsKey": needs_key, "hasKey": has_key, "manual": spec.kind == "manual",
            "manualInfo": spec.manual.as_ref().map(|m| json!({ "url": m.url, "steps": m.steps, "exportFormats": m.export_formats, "importHint": m.import_hint })),
            "options": spec.options,
            "supports": { "fields": caps.fields, "phrase": caps.phrase, "truncation": caps.truncation, "proximity": caps.proximity, "dates": caps.dates, "filters": caps.filters, "maxResults": caps.max_results, "sort": caps.sort, "mode": spec.query.mode },
            "health": self.health_of(&spec.id),
            "updatedAt": if l.origin == "update" { state.activated_at.map(|t| t * 1000) } else { None },
            "origin": l.origin,
            // Built-in connectors ship inside the app; downloaded ones carry their bundle's state.
            "signature": if l.origin == "update" { if self.loaded.read().unwrap_or_else(|e| e.into_inner()).1.as_ref().is_some_and(|v| v.signed) { "signed" } else { "unsigned" } } else { "built-in" },
        })
    }

    fn connectors_info(&self) -> Json {
        let set = self.loaded.read().unwrap_or_else(|e| e.into_inner()).0.clone();
        Json::Array(set.values().map(|l| self.info(l)).collect())
    }

    fn status(&self) -> Json {
        let state = self.store().state();
        let trust = self.trust();
        let loaded = self.loaded.read().unwrap_or_else(|e| e.into_inner());
        let (sequence, created, origin) = match &loaded.1 {
            Some(v) => (v.index.sequence, v.index.created.clone(), "update"),
            None => (0, String::new(), "baseline"),
        };
        json!({
            "sequence": sequence, "created": created, "origin": origin, "activatedAt": state.activated_at.map(|t| t * 1000),
            "lastCheckAt": state.last_check_at.map(|t| t * 1000), "lastResult": state.last_result, "lastError": state.last_error,
            "updatesConfigured": trust.configured(), "updateUrl": trust.update_url,
            "signed": loaded.1.as_ref().map(|v| v.signed), "signingKey": loaded.1.as_ref().and_then(|v| v.key_id.clone()), "signatureRequired": trust.requires_signature(),
            "engine": key_connectors::ENGINE_VERSION, "connectors": loaded.0.len(), "warnings": loaded.1.as_ref().map(|v| v.warnings.clone()).unwrap_or_default(),
        })
    }

    /// Downloads and activates a newer signed bundle (at most daily unless forced).
    fn check_updates(&self, force: bool) -> Json {
        let trust = self.trust();
        if trust.update_url.is_empty() {
            return json!({ "state": "unconfigured", "sequence": 0, "changed": [] });
        }
        let base = trust.update_url.trim_end_matches('/').to_string();
        let host = url::Url::parse(&base).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
        let transport = self.transport.clone();
        let get = move |rel: &str, etag: Option<&str>| -> Result<Option<(Vec<u8>, Option<String>)>, String> {
            let url = url::Url::parse(&format!("{base}/{rel}")).map_err(|e| e.to_string())?;
            let mut headers = vec![("accept".to_string(), "application/json, text/plain;q=0.9".to_string())];
            if let Some(tag) = etag {
                headers.push(("if-none-match".into(), tag.into()));
            }
            let request = Request { connector: "updates".into(), method: "GET".into(), url, headers, body: Vec::new(), format: "json".into(), hosts: vec![host.clone()], max_bytes: 8 * 1024 * 1024 };
            let response = transport.send(&request, &key_connectors::engine::CancellationToken::active()).map_err(|e| format!("{e:?}"))?;
            match response.status {
                304 => Ok(None),
                // Nothing published yet: the built-in connectors are current.
                404 if rel == "index.json" => Ok(None),
                404 => Err(format!("{rel} was not found at the update address")),
                200..=299 => Ok(Some((response.body.clone(), response.header("etag").map(String::from)))),
                s => Err(format!("The update address answered {s}")),
            }
        };
        let fetch = |rel: &str| get(rel, None).map(|o| o.map(|(b, _)| b)).or_else(|e| if e.contains("was not found") && (rel == "keys.json" || rel == "index.sig") { Ok(None) } else { Err(e) });
        let conditional = |etag: Option<&str>| get("index.json", etag);
        let result = self.store().check(&trust, &fetch, key_connectors::time::now_secs(), force, &conditional);
        if result.state == "updated" {
            self.engine.clear_cache();
            self.reload();
        }
        serde_json::to_value(&result).unwrap_or(Json::Null)
    }

    fn options_for(&self, spec: &Spec, all: &BTreeMap<String, Vars>) -> Vars {
        let mut out: Vars = spec.options.iter().map(|o| (o.id.clone(), o.default.clone())).collect();
        if let Some(given) = all.get(&spec.id) {
            for (k, v) in given {
                if let Some(option) = spec.options.iter().find(|o| o.id == *k) {
                    let allowed = option.choices.iter().any(|c| c.value == *v) || (option.free && option.pattern.as_deref().is_none_or(|p| regex::Regex::new(p).is_ok_and(|r| r.is_match(v))));
                    if allowed {
                        out.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        out
    }

    fn translate_one(&self, spec: &Spec, query: &Query, options: &Vars, overrides: &BTreeMap<String, String>) -> query::Translation {
        let mut t = query::translate(spec, query, options);
        if let Some(native) = overrides.get(&spec.id).map(|s| s.trim()).filter(|s| !s.is_empty()) {
            t.native = native.to_string();
            t.chunks = vec![native.to_string()];
            t.length = native.chars().count();
            t.overridden = true;
            t.warnings = vec!["Sent exactly as typed".into()];
            t.local_filter = spec.query.mode != "native" || spec.query.local_filter;
        }
        t
    }

    fn translate(&self, args: &Json) -> Result<Json, String> {
        let query: Query = arg::<Option<Query>>(args, "query")?.unwrap_or_default();
        let ids: Vec<String> = arg::<Option<Vec<String>>>(args, "connectors")?.unwrap_or_default();
        let overrides: BTreeMap<String, String> = arg::<Option<_>>(args, "overrides")?.unwrap_or_default();
        let options: BTreeMap<String, Vars> = arg::<Option<_>>(args, "options")?.unwrap_or_default();
        let mut out = Vec::new();
        for id in ids {
            let l = self.connector(&id)?;
            let spec = &l.connector.spec;
            let opts = self.options_for(spec, &options);
            let t = self.translate_one(spec, &query, &opts, &overrides);
            let mut value = serde_json::to_value(&t).map_err(|e| e.to_string())?;
            if let Some(manual) = &spec.manual {
                let mut vars = t.vars.clone();
                let encode = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
                vars = vars.into_iter().map(|(k, v)| (k, encode(&v))).collect();
                vars.insert("query".into(), encode(&t.native));
                value["manualUrl"] = json!(key_connectors::template::render(&manual.url, &vars).ok().flatten().unwrap_or_else(|| manual.url.replace("{query}", "")));
            }
            out.push(value);
        }
        Ok(Json::Array(out))
    }

    fn estimate(&self, args: &Json) -> Result<Json, String> {
        let query: Query = arg::<Option<Query>>(args, "query")?.unwrap_or_default();
        let ids: Vec<String> = arg::<Option<Vec<String>>>(args, "connectors")?.unwrap_or_default();
        let overrides: BTreeMap<String, String> = arg::<Option<_>>(args, "overrides")?.unwrap_or_default();
        let options: BTreeMap<String, Vars> = arg::<Option<_>>(args, "options")?.unwrap_or_default();
        let per_concept = arg::<Option<bool>>(args, "perConcept")?.unwrap_or(false);
        let request_id: Option<String> = arg(args, "requestId")?;
        let source = CancellationSource::new();
        if let Some(id) = &request_id {
            if let Some(old) = self.estimates.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), source.clone()) {
                old.cancel();
            }
        }
        let query = query.cleaned();
        let results: Vec<Json> = std::thread::scope(|scope| {
            let handles: Vec<_> = ids
                .iter()
                .map(|id| {
                    let (query, overrides, options, token) = (&query, &overrides, &options, source.token());
                    scope.spawn(move || -> Json {
                        let l = match self.connector(id) {
                            Ok(l) => l,
                            Err(e) => return json!({ "connector": id, "error": e }),
                        };
                        let spec = &l.connector.spec;
                        if spec.kind == "manual" {
                            return json!({ "connector": id, "error": "This source is searched in its own website", "manual": true });
                        }
                        let creds = self.credentials(spec);
                        if spec.credentials.iter().any(|c| c.required && !creds.contains_key(&c.id)) {
                            return json!({ "connector": id, "error": "Needs an API key", "needsKey": true });
                        }
                        let opts = self.options_for(spec, options);
                        let ctl = RunControl::new(token.clone());
                        let count = |q: &Query| {
                            let t = self.translate_one(spec, q, &opts, overrides);
                            self.engine.count(spec, &t, q, &opts, &creds, &ctl)
                        };
                        let exact = spec.query.mode == "native";
                        match count(query) {
                            Ok(total) => {
                                self.record_health(id, Ok(()));
                                let per: Option<Vec<Json>> = (per_concept && exact && query.parts().len() > 1 && !overrides.contains_key(id))
                                    .then(|| (0..query.parts().len()).map(|i| count(&query.only_part(i)).ok().flatten().map(Json::from).unwrap_or(Json::Null)).collect());
                                json!({ "connector": id, "total": total, "perConcept": per, "exact": exact })
                            }
                            Err(e) => {
                                self.record_health(id, Err(&e));
                                json!({ "connector": id, "error": e.message, "errorKind": e.kind })
                            }
                        }
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or(Json::Null)).collect()
        });
        if let Some(id) = &request_id {
            self.estimates.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        }
        Ok(Json::Array(results))
    }

    pub fn cancel_estimate(&self, id: &str) {
        if let Some(s) = self.estimates.lock().unwrap_or_else(|e| e.into_inner()).remove(id) {
            s.cancel();
        }
    }

    pub fn cancel_run(&self, id: &str) {
        if let Some(run) = self.runs.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned() {
            run.cancel.lock().unwrap_or_else(|e| e.into_inner()).cancel();
        }
    }

    fn start(self: &Arc<Self>, args: &Json, saved: Option<&Saved>) -> Result<Json, String> {
        let (query, ids, overrides, options, label) = match saved {
            Some(s) => (s.query.clone(), s.connectors.clone(), s.overrides.clone(), s.options.clone(), s.name.clone()),
            None => (
                arg::<Option<Query>>(args, "query")?.unwrap_or_default(),
                arg::<Option<Vec<String>>>(args, "connectors")?.unwrap_or_default(),
                arg::<Option<_>>(args, "overrides")?.unwrap_or_default(),
                arg::<Option<_>>(args, "options")?.unwrap_or_default(),
                arg::<Option<String>>(args, "label")?.unwrap_or_default(),
            ),
        };
        if ids.is_empty() {
            return Err("Choose at least one database".into());
        }
        for id in &ids {
            self.connector(id)?;
        }
        let limit = args.get("limit").and_then(Json::as_u64).map(|l| l as usize).unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let background = arg::<Option<bool>>(args, "background")?.unwrap_or(false);
        // Databases whose plan needs the user's OK (many queries, or nothing to send) that they gave.
        let allowed: HashSet<String> = arg::<Option<Vec<String>>>(args, "allow")?.unwrap_or_default().into_iter().collect();
        let id = format!("run-{}-{}", now_ms(), self.counter.fetch_add(1, Ordering::Relaxed));
        let saved_id = saved.map(|s| s.id.clone()).or(arg::<Option<String>>(args, "savedId")?);
        let previous: HashSet<String> = match saved_id.as_deref().and_then(|s| self.saved_list().into_iter().find(|x| x.id == s)) {
            Some(s) => s.seen.into_iter().collect(),
            None => HashSet::new(),
        };
        let run = Arc::new(Run {
            id: id.clone(),
            label: if label.is_empty() { "Database search".into() } else { label },
            saved_id,
            query: query.cleaned(),
            options,
            overrides,
            started_at: now_ms(),
            background,
            cancel: Mutex::new(CancellationSource::new()),
            data: Mutex::new(RunData { state: "running".into(), progress: BTreeMap::new(), searches: HashMap::new(), merger: Merger::default(), finished_at: None, limit, previous }),
            connectors: ids.clone(),
        });
        {
            let mut d = run.data.lock().unwrap_or_else(|e| e.into_inner());
            for cid in &ids {
                let l = self.connector(cid)?;
                let spec = &l.connector.spec;
                let opts = self.options_for(spec, &run.options);
                let t = self.translate_one(spec, &run.query, &opts, &run.overrides);
                let mut p = Progress { connector: cid.clone(), state: "queued".into(), native: t.native.clone(), chunks: t.chunks.len(), warnings: t.warnings.clone(), strategy: Some(t.strategy.clone()), ..Default::default() };
                let creds = self.credentials(spec);
                let decision = t.strategy.decision.as_ref().filter(|_| !t.overridden);
                if spec.kind == "manual" {
                    p.state = "skipped".into();
                    p.error = Some("This source is searched in its own website".into());
                } else if spec.credentials.iter().any(|c| c.required && !creds.contains_key(&c.id)) {
                    p.state = "skipped".into();
                    p.error = Some("Needs an API key (Settings)".into());
                } else if let Some(d) = decision.filter(|d| d.kind == "nothing" || !allowed.contains(cid)) {
                    p.state = "skipped".into();
                    p.error = Some(d.message.clone());
                } else {
                    d.searches.insert(cid.clone(), SearchState::new(&t, &run.query, &opts));
                }
                d.progress.insert(cid.clone(), p);
            }
        }
        {
            let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
            if runs.len() > 20 {
                let mut old: Vec<(i64, String)> = runs.values().map(|r| (r.started_at, r.id.clone())).collect();
                old.sort();
                for (_, rid) in old.into_iter().take(runs.len() - 20) {
                    runs.remove(&rid);
                }
            }
            runs.insert(id.clone(), run.clone());
        }
        self.spawn_fetch(&run, None, limit);
        Ok(json!({ "runId": id }))
    }

    /// Fetches (more) pages for the run's connectors, one thread each.
    fn spawn_fetch(self: &Arc<Self>, run: &Arc<Run>, only: Option<&str>, extra: usize) {
        let ids: Vec<String> = {
            let mut d = run.data.lock().unwrap_or_else(|e| e.into_inner());
            d.state = "running".into();
            d.finished_at = None;
            run.connectors.iter().filter(|c| only.is_none_or(|o| o == c.as_str())).filter(|c| d.searches.get(*c).is_some_and(|s| !s.done)).cloned().collect()
        };
        {
            // A fresh cancel source, so "more" after a cancel works.
            let mut cancel = run.cancel.lock().unwrap_or_else(|e| e.into_inner());
            if cancel.is_cancelled() {
                *cancel = CancellationSource::new();
            }
        }
        let pending = Arc::new(AtomicU64::new(ids.len() as u64));
        if ids.is_empty() {
            self.finish(run);
            return;
        }
        for cid in ids {
            let (this, run, pending) = (self.clone(), run.clone(), pending.clone());
            let _ = std::thread::Builder::new().name(format!("key-db-{cid}")).spawn(move || {
                if run.background {
                    key_store::priority::set_thread_class(key_store::priority::Class::Background);
                }
                this.fetch_connector(&run, &cid, extra);
                if pending.fetch_sub(1, Ordering::SeqCst) == 1 {
                    this.finish(&run);
                }
            });
        }
    }

    fn fetch_connector(&self, run: &Arc<Run>, cid: &str, extra: usize) {
        let Ok(l) = self.connector(cid) else { return };
        let spec = l.connector.spec.clone();
        let creds = self.credentials(&spec);
        let token = run.cancel.lock().unwrap_or_else(|e| e.into_inner()).token();
        let mut ctl = RunControl::new(token.clone());
        let (wait_run, wait_id) = (run.clone(), cid.to_string());
        ctl.on_wait = Box::new(move |d: Duration| {
            if let Some(p) = wait_run.data.lock().unwrap_or_else(|e| e.into_inner()).progress.get_mut(&wait_id) {
                p.state = "waiting".into();
                p.wait_ms = Some(d.as_millis() as u64);
            }
        });
        if run.background {
            ctl.yield_now = Box::new(|| {
                key_store::priority::yield_if_needed();
            });
        }
        let mut state = {
            let mut d = run.data.lock().unwrap_or_else(|e| e.into_inner());
            let Some(state) = d.searches.remove(cid) else { return };
            if let Some(p) = d.progress.get_mut(cid) {
                p.state = "running".into();
                p.started_at.get_or_insert(now_ms());
                p.error = None;
            }
            state
        };
        let target = run.data.lock().unwrap_or_else(|e| e.into_inner()).progress.get(cid).map(|p| p.fetched).unwrap_or(0) + extra;
        let mut outcome: Result<(), EngineError> = Ok(());
        let mut rank = run.data.lock().unwrap_or_else(|e| e.into_inner()).progress.get(cid).map(|p| p.raw).unwrap_or(0);
        loop {
            if token.is_cancelled() {
                outcome = Err(EngineError::cancelled());
                break;
            }
            let fetched = run.data.lock().unwrap_or_else(|e| e.into_inner()).progress.get(cid).map(|p| p.fetched).unwrap_or(0);
            if state.done || fetched >= target {
                break;
            }
            let chunk = state.chunks.get(state.chunk).map(|c| c.native.clone()).unwrap_or_default();
            match self.engine.next_page(&spec, &mut state, &creds, &ctl) {
                Ok(page) => {
                    let mut d = run.data.lock().unwrap_or_else(|e| e.into_inner());
                    let at = now_ms();
                    let count = page.records.len();
                    for record in page.records {
                        d.merger.add(Found { connector: cid.to_string(), version: spec.version.clone(), record, query: chunk.clone(), at, rank });
                        rank += 1;
                    }
                    if let Some(p) = d.progress.get_mut(cid) {
                        p.state = "running".into();
                        p.wait_ms = None;
                        p.fetched += count;
                        p.raw += page.raw;
                        p.total = page.total.or(p.total);
                        p.requests += page.requests;
                        p.quota_remaining = page.quota_remaining.or(p.quota_remaining);
                        p.undated += page.undated;
                        p.rejected += page.rejected;
                        p.unverified += page.unverified;
                        p.repeats += page.repeats;
                        p.has_more = !page.done;
                    }
                }
                Err(e) => {
                    outcome = Err(e);
                    break;
                }
            }
        }
        let mut d = run.data.lock().unwrap_or_else(|e| e.into_inner());
        // Results reported but none readable: the answers changed shape.
        if let (Ok(()), Some(p)) = (&outcome, d.progress.get(cid)) {
            if p.raw == 0 && p.total.is_some_and(|t| t > 0) {
                outcome = Err(EngineError::new("parse", format!("{} reported {} results, but none could be read; the connector may be out of date", spec.name, p.total.unwrap_or(0))));
            }
        }
        if let Some(p) = d.progress.get_mut(cid) {
            p.has_more = !state.done;
            p.wait_ms = None;
            p.finished_at = Some(now_ms());
            match &outcome {
                Ok(()) => p.state = "done".into(),
                Err(e) if e.kind == "cancelled" => p.state = "cancelled".into(),
                Err(e) => {
                    p.state = "failed".into();
                    p.error = Some(e.message.clone());
                    p.error_kind = Some(e.kind.clone());
                }
            }
            if outcome.is_ok() && p.fetched == 0 {
                let why = if p.raw > 0 {
                    format!("{} records were read, but none matched the whole query (this source cannot search it all, so Key checks each record)", p.raw)
                } else if p.total.is_some_and(|t| t > 0) {
                    format!("The source reported {} results, but none could be read; the connector may be out of date", p.total.unwrap_or(0))
                } else {
                    "No records found".to_string()
                };
                if !p.warnings.contains(&why) {
                    p.warnings.push(why);
                }
            }
            if p.undated > 0 && !p.warnings.iter().any(|w| w.contains("without a year")) {
                p.warnings.push(format!("{} records without a year were kept", p.undated));
            }
            if p.unverified > 0 && !p.warnings.iter().any(|w| w.contains("could not be checked")) {
                p.warnings.push(format!("{} records were kept although part of the search could not be checked on them (missing abstract or keywords)", p.unverified));
            }
        }
        d.searches.insert(cid.to_string(), state);
        drop(d);
        self.record_health(cid, outcome.as_ref().map(|_| ()));
    }

    fn finish(&self, run: &Arc<Run>) {
        let report = {
            let mut d = run.data.lock().unwrap_or_else(|e| e.into_inner());
            let cancelled = d.progress.values().any(|p| p.state == "cancelled");
            let all_failed = !d.progress.is_empty() && d.progress.values().all(|p| p.state == "failed" || p.state == "skipped");
            d.state = if cancelled { "cancelled" } else if all_failed { "failed" } else { "done" }.into();
            d.finished_at = Some(now_ms());
            self.report_of(run, &d)
        };
        let dir = self.data_dir().join("runs");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(format!("{}.json", run.id)), report.json());
        // Keep the newest runs only.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            let mut files: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            files.sort();
            for f in files.iter().take(files.len().saturating_sub(KEEP_RUNS)) {
                let _ = std::fs::remove_file(f);
            }
        }
        if let Some(saved_id) = &run.saved_id {
            let d = run.data.lock().unwrap_or_else(|e| e.into_inner());
            let seen: Vec<String> = d.merger.groups.iter().flat_map(|g| identities(&g.versions, &g.record)).collect();
            let new_count = d.merger.groups.iter().filter(|g| !d.previous.is_empty() && !identities(&g.versions, &g.record).iter().any(|i| d.previous.contains(i))).count();
            let count = d.merger.groups.len();
            drop(d);
            let mut all = self.saved_list();
            if let Some(s) = all.iter_mut().find(|s| s.id == *saved_id) {
                s.last_run_at = Some(run.started_at);
                s.last_run_id = Some(run.id.clone());
                s.last_count = Some(count);
                s.new_count = Some(new_count);
                s.seen = seen.into_iter().take(50_000).collect();
            }
            self.save_saved(&all);
        }
    }

    fn report_of(&self, run: &Run, d: &RunData) -> RunReport {
        let loaded = self.loaded.read().unwrap_or_else(|e| e.into_inner());
        let sources = run
            .connectors
            .iter()
            .filter_map(|c| d.progress.get(c))
            .map(|p| {
                let spec = loaded.0.get(&p.connector).map(|l| l.connector.spec.clone());
                let state = d.searches.get(&p.connector);
                SourceLog {
                    connector: p.connector.clone(),
                    name: spec.as_ref().map(|s| s.name.clone()).unwrap_or_default(),
                    version: spec.as_ref().map(|s| s.version.clone()).unwrap_or_default(),
                    native: p.native.clone(),
                    chunks: d.searches.get(&p.connector).map(|s| s.chunks.iter().map(|c| c.native.clone()).collect()).unwrap_or_default(),
                    warnings: p.warnings.clone(),
                    total: p.total,
                    fetched: p.fetched,
                    raw: p.raw,
                    requests: p.requests,
                    state: p.state.clone(),
                    error: p.error.clone(),
                    started_at: p.started_at,
                    finished_at: p.finished_at,
                    strategy: p.strategy.clone(),
                    chunk_totals: state.map(|s| s.totals.clone()).unwrap_or_default(),
                    chunk_raw: state.map(|s| s.chunk_raw.clone()).unwrap_or_default(),
                    chunk_kept: state.map(|s| s.chunk_kept.clone()).unwrap_or_default(),
                    rejected: p.rejected,
                    unverified: p.unverified,
                    repeats: p.repeats,
                }
            })
            .collect();
        RunReport {
            run_id: run.id.clone(),
            label: run.label.clone(),
            engine: key_connectors::ENGINE_VERSION.into(),
            started_at: run.started_at,
            finished_at: d.finished_at,
            state: d.state.clone(),
            query: run.query.clone(),
            sources,
            fetched: d.merger.fetched(),
            unique: d.merger.groups.len(),
            duplicates_removed: d.merger.duplicates_removed(),
            records: RunReport::records_from(&d.merger),
            rerun: json!({ "query": run.query, "connectors": run.connectors, "options": run.options, "overrides": run.overrides, "label": run.label, "savedId": run.saved_id }),
        }
    }

    fn run(&self, id: &str) -> Result<Arc<Run>, String> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned().ok_or_else(|| "This search is no longer available; run it again".to_string())
    }

    fn record_json(connector: &str, key: &str, record: &Record, versions: &[Found], found_by: &[String], in_library: Option<&Json>, is_new: Option<bool>) -> Json {
        let mut value = serde_json::to_value(web_result(connector, record)).unwrap_or(Json::Null);
        let extra = json!({
            "key": key, "date": record.date, "series": record.series, "number": record.number, "publisher": record.publisher,
            "language": record.language, "keywords": record.keywords, "handle": record.handle, "isbn": record.isbn, "issn": record.issn,
            "extras": record.extras, "foundBy": found_by, "duplicates": versions.len().saturating_sub(1),
            "provenance": versions.iter().map(|v| json!({ "connector": v.connector, "version": v.version, "sourceId": v.record.source_id, "query": v.query, "at": v.at, "rank": v.rank })).collect::<Vec<_>>(),
            "inLibrary": in_library.and_then(Json::as_str), "isNew": is_new, "recordType": record.kind,
        });
        if let (Some(obj), Some(more)) = (value.as_object_mut(), extra.as_object()) {
            for (k, v) in more {
                if !v.is_null() {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
        value
    }

    fn results(&self, library: &dyn Library, args: &Json) -> Result<Json, String> {
        let run = self.run(&arg::<String>(args, "runId")?)?;
        let dedupe = arg::<Option<bool>>(args, "dedupe")?.unwrap_or(true);
        let offset = args.get("offset").and_then(Json::as_u64).unwrap_or(0) as usize;
        let limit = args.get("limit").and_then(Json::as_u64).unwrap_or(100).min(2000) as usize;
        let only: Option<String> = arg(args, "connector")?;
        let d = run.data.lock().unwrap_or_else(|e| e.into_inner());
        let progress: Vec<&Progress> = run.connectors.iter().filter_map(|c| d.progress.get(c)).collect();
        let mut rows: Vec<Json> = Vec::new();
        let mut asked: Vec<Asked> = Vec::new();
        let previous = &d.previous;
        let is_new = |versions: &[Found], record: &Record| (!previous.is_empty()).then(|| !identities(versions, record).iter().any(|i| previous.contains(i)));
        let total;
        if dedupe {
            let groups: Vec<_> = d.merger.groups.iter().filter(|g| only.as_ref().is_none_or(|o| g.found_by.contains(o))).collect();
            total = groups.len();
            for g in groups.into_iter().skip(offset).take(limit) {
                rows.push(Self::record_json(&g.found_by[0], &g.key, &g.record, &g.versions, &g.found_by, None, is_new(&g.versions, &g.record)));
                asked.push(Asked::from(&web_result(&g.found_by[0], &g.record)));
            }
        } else {
            let flat: Vec<(&str, &Found)> = d.merger.groups.iter().flat_map(|g| g.versions.iter().map(move |v| (g.key.as_str(), v))).filter(|(_, v)| only.as_ref().is_none_or(|o| v.connector == *o)).collect();
            total = flat.len();
            for (key, v) in flat.into_iter().skip(offset).take(limit) {
                rows.push(Self::record_json(&v.connector, key, &v.record, std::slice::from_ref(v), std::slice::from_ref(&v.connector), None, is_new(std::slice::from_ref(v), &v.record)));
                asked.push(Asked::from(&web_result(&v.connector, &v.record)));
            }
        }
        let progress_json = serde_json::to_value(&progress).unwrap_or(Json::Null);
        let answer_base = json!({
            "runId": run.id, "label": run.label, "state": d.state, "progress": progress_json, "total": d.merger.groups.len(), "listed": total,
            "fetched": d.merger.fetched(), "duplicatesRemoved": d.merger.duplicates_removed(), "startedAt": run.started_at, "finishedAt": d.finished_at,
        });
        drop(d);
        // "In library": the store's matcher, for the page being shown.
        if !asked.is_empty() {
            for (i, a) in asked.iter_mut().enumerate() {
                a.key = i.to_string();
            }
            let found = web_search::library::existing(library, &asked, false);
            for (i, row) in rows.iter_mut().enumerate() {
                if let Some(id) = found.get(&i.to_string()) {
                    row["inLibrary"] = id.clone();
                }
            }
        }
        let mut answer = answer_base;
        answer["records"] = Json::Array(rows);
        Ok(answer)
    }

    fn record(&self, args: &Json) -> Result<Json, String> {
        let run = self.run(&arg::<String>(args, "runId")?)?;
        let key: String = arg(args, "key")?;
        let d = run.data.lock().unwrap_or_else(|e| e.into_inner());
        let g = d.merger.get(&key).ok_or("No such record")?;
        let versions: Vec<Json> = g.versions.iter().map(|v| Self::record_json(&v.connector, &g.key, &v.record, std::slice::from_ref(v), std::slice::from_ref(&v.connector), None, None)).collect();
        Ok(json!({ "record": Self::record_json(&g.found_by[0], &g.key, &g.record, &g.versions, &g.found_by, None, None), "versions": versions }))
    }

    fn add(&self, web: &web_search::WebSearch, library: &dyn Library, args: &Json) -> Result<Json, String> {
        let run = self.run(&arg::<String>(args, "runId")?)?;
        let keys: Vec<String> = arg::<Option<Vec<String>>>(args, "keys")?.unwrap_or_default();
        let collection: Option<String> = arg(args, "collectionId")?;
        let lookup = arg::<Option<bool>>(args, "lookup")?.unwrap_or(false);
        let tag: Option<String> = arg::<Option<String>>(args, "tag")?.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        let works: Vec<(String, WebResult)> = {
            let d = run.data.lock().unwrap_or_else(|e| e.into_inner());
            keys.iter().filter_map(|k| d.merger.get(k).map(|g| (k.clone(), web_result(&g.found_by[0], &g.record)))).collect()
        };
        let (mut added, mut existed) = (0, 0);
        let mut results = Vec::new();
        for (key, work) in works {
            match web_search::add_to_library(web, library, work, collection.as_deref(), lookup) {
                Ok(answer) => {
                    let was = answer["existed"].as_bool().unwrap_or(false);
                    if was { existed += 1 } else { added += 1 }
                    let source_id = answer["source"]["id"].as_str().map(String::from);
                    if let (Some(tag), Some(id)) = (&tag, &source_id) {
                        let _ = library.tag(id, tag);
                    }
                    results.push(json!({ "key": key, "sourceId": source_id, "existed": was }));
                }
                Err(e) => results.push(json!({ "key": key, "error": e })),
            }
        }
        Ok(json!({ "added": added, "existed": existed, "results": results }))
    }

    fn saved_path(&self) -> PathBuf {
        self.data_dir().join("saved.json")
    }

    fn saved_list(&self) -> Vec<Saved> {
        std::fs::read(self.saved_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn save_saved(&self, all: &[Saved]) {
        let _ = std::fs::create_dir_all(self.data_dir());
        let tmp = self.saved_path().with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(all).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(tmp, self.saved_path());
        }
    }

    fn saved_save(&self, args: &Json) -> Result<Json, String> {
        let mut all = self.saved_list();
        let id: Option<String> = arg(args, "id")?;
        let name = arg::<Option<String>>(args, "name")?.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).ok_or("Give the search a name")?;
        let entry = Saved {
            id: id.clone().unwrap_or_else(|| format!("saved-{}-{}", now_ms(), self.counter.fetch_add(1, Ordering::Relaxed))),
            name,
            query: arg::<Option<Query>>(args, "query")?.unwrap_or_default().cleaned(),
            connectors: arg::<Option<Vec<String>>>(args, "connectors")?.unwrap_or_default(),
            overrides: arg::<Option<_>>(args, "overrides")?.unwrap_or_default(),
            options: arg::<Option<_>>(args, "options")?.unwrap_or_default(),
            created_at: now_ms(),
            ..Default::default()
        };
        let out = match id.and_then(|id| all.iter_mut().find(|s| s.id == id)) {
            Some(existing) => {
                let keep = (existing.created_at, existing.last_run_at, existing.last_run_id.clone(), existing.last_count, existing.new_count, std::mem::take(&mut existing.seen));
                *existing = Saved { created_at: keep.0, last_run_at: keep.1, last_run_id: keep.2, last_count: keep.3, new_count: keep.4, seen: keep.5, ..entry };
                existing.clone()
            }
            None => {
                all.push(entry.clone());
                entry
            }
        };
        self.save_saved(&all);
        Ok(serde_json::to_value(Saved { seen: Vec::new(), ..out }).unwrap_or(Json::Null))
    }

    fn report(&self, args: &Json) -> Result<Json, String> {
        let id: String = arg(args, "runId")?;
        let format = arg::<Option<String>>(args, "format")?.unwrap_or_else(|| "json".into());
        let report = match self.run(&id) {
            Ok(run) => {
                let d = run.data.lock().unwrap_or_else(|e| e.into_inner());
                self.report_of(&run, &d)
            }
            Err(e) => std::fs::read(self.data_dir().join("runs").join(format!("{id}.json"))).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or(e)?,
        };
        let date = key_connectors::time::format(report.started_at / 1000)[..10].to_string();
        let (content, ext, mime) = match format.as_str() {
            "csv" => (report.csv(), "csv", "text/csv"),
            "markdown" | "md" => (report.markdown(), "md", "text/markdown"),
            _ => (report.json(), "json", "application/json"),
        };
        Ok(json!({ "filename": format!("database-search-{date}.{ext}"), "content": content, "mime": mime }))
    }

    /// A run's report, live or from disk.
    fn report_by_id(&self, id: &str) -> Result<RunReport, String> {
        match self.run(id) {
            Ok(run) => {
                let d = run.data.lock().unwrap_or_else(|e| e.into_inner());
                Ok(self.report_of(&run, &d))
            }
            Err(e) => std::fs::read(self.data_dir().join("runs").join(format!("{id}.json"))).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or(e),
        }
    }

    /// The search strategy (exact strings per database, counts, reconstruction) of a run, or of
    /// a search not run yet (`query` + `connectors`: the plan only).
    fn strategy(&self, args: &Json) -> Result<Json, String> {
        let format = arg::<Option<String>>(args, "format")?.unwrap_or_else(|| "markdown".into());
        let report = match arg::<Option<String>>(args, "runId")? {
            Some(id) => self.report_by_id(&id)?,
            None => {
                let query: Query = arg::<Option<Query>>(args, "query")?.unwrap_or_default().cleaned();
                let ids: Vec<String> = arg::<Option<Vec<String>>>(args, "connectors")?.unwrap_or_default();
                let overrides: BTreeMap<String, String> = arg::<Option<_>>(args, "overrides")?.unwrap_or_default();
                let options: BTreeMap<String, Vars> = arg::<Option<_>>(args, "options")?.unwrap_or_default();
                let mut sources = Vec::new();
                for id in &ids {
                    let l = self.connector(id)?;
                    let spec = &l.connector.spec;
                    let t = self.translate_one(spec, &query, &self.options_for(spec, &options), &overrides);
                    sources.push(SourceLog { connector: id.clone(), name: spec.name.clone(), version: spec.version.clone(), native: t.native.clone(), chunks: t.chunks.clone(), warnings: t.warnings.clone(), strategy: Some(t.strategy), ..Default::default() });
                }
                RunReport {
                    label: arg::<Option<String>>(args, "label")?.unwrap_or_default(),
                    engine: key_connectors::ENGINE_VERSION.into(),
                    rerun: json!({ "query": query, "connectors": ids, "options": options, "overrides": overrides }),
                    query,
                    sources,
                    ..Default::default()
                }
            }
        };
        let date = if report.started_at > 0 { key_connectors::time::format(report.started_at / 1000)[..10].to_string() } else { key_connectors::time::format(key_connectors::time::now_secs())[..10].to_string() };
        let (content, ext, mime) = match format.as_str() {
            "json" => (report.strategy_json(), "json", "application/json"),
            "csv" => (report.strategy_csv(), "csv", "text/csv"),
            "text" => (report.strategy_text(), "txt", "text/plain"),
            _ => (report.strategy_markdown(), "md", "text/markdown"),
        };
        Ok(json!({ "filename": format!("search-strategy-{date}.{ext}"), "content": content, "mime": mime }))
    }

    fn runs_list(&self, args: &Json) -> Result<Json, String> {
        let limit = args.get("limit").and_then(Json::as_u64).unwrap_or(20) as usize;
        let mut files: Vec<PathBuf> = std::fs::read_dir(self.data_dir().join("runs")).map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        files.sort();
        files.reverse();
        let out: Vec<Json> = files
            .into_iter()
            .take(limit)
            .filter_map(|f| std::fs::read(f).ok().and_then(|b| serde_json::from_slice::<RunReport>(&b).ok()))
            .map(|r| {
                let per: BTreeMap<String, usize> = r.sources.iter().map(|s| (s.connector.clone(), s.fetched)).collect();
                json!({ "runId": r.run_id, "label": r.label, "startedAt": r.started_at, "finishedAt": r.finished_at, "state": r.state, "total": r.unique, "perConnector": per, "fetched": r.fetched, "duplicatesRemoved": r.duplicates_removed, "savedId": r.rerun.get("savedId").cloned().unwrap_or(Json::Null) })
            })
            .collect();
        Ok(Json::Array(out))
    }

    fn report_problem(&self, args: &Json) -> Result<Json, String> {
        let id: String = arg(args, "connector")?;
        let l = self.connector(&id)?;
        let spec = &l.connector.spec;
        let error: Option<String> = arg::<Option<String>>(args, "error")?.or_else(|| self.health.lock().ok().and_then(|h| h.get(&id).and_then(|h| h.last_error.clone())));
        let title = format!("Connector {}: {}", spec.id, error.as_deref().unwrap_or("problem report").chars().take(80).collect::<String>());
        let body = format!(
            "**Connector:** {} {} ({})\n**Engine:** {}\n**Error shown:** {}\n\n**What I did** (please describe; no search terms are included automatically):\n\n",
            spec.id,
            spec.version,
            l.origin,
            key_connectors::ENGINE_VERSION,
            error.as_deref().unwrap_or("none")
        );
        let mut url = url::Url::parse(ISSUES_URL).map_err(|e| e.to_string())?;
        url.query_pairs_mut().append_pair("title", &title).append_pair("body", &body).append_pair("labels", &format!("connector,connector:{}", spec.id));
        Ok(json!({ "url": url.to_string() }))
    }

    fn recall(&self, args: &Json) -> Result<Json, String> {
        let run = self.run(&arg::<String>(args, "runId")?)?;
        #[derive(Deserialize)]
        struct Seed {
            doi: Option<String>,
            title: Option<String>,
        }
        let seeds: Vec<Seed> = arg::<Option<Vec<Seed>>>(args, "seeds")?.unwrap_or_default();
        let d = run.data.lock().unwrap_or_else(|e| e.into_inner());
        let mut per: BTreeMap<String, usize> = BTreeMap::new();
        let mut out = Vec::new();
        for seed in &seeds {
            let work = key_store::duplicates::Work { doi: seed.doi.clone(), title: seed.title.clone(), ..Default::default() };
            let doi = seed.doi.as_deref().and_then(key_store::normalize::doi);
            let title = seed.title.as_deref().map(key_store::normalize::title_key).filter(|t| t.len() >= 20);
            let hit = d.merger.groups.iter().find(|g| {
                doi.is_some() && g.record.doi == doi
                    || title.as_ref().is_some_and(|t| *t == key_store::normalize::title_key(&g.record.title))
                    || key_store::duplicates::compare(&work, &g.record.work()).is_some()
            });
            if let Some(g) = hit {
                for c in &g.found_by {
                    *per.entry(c.clone()).or_default() += 1;
                }
            }
            out.push(json!({ "doi": seed.doi, "title": seed.title, "found": hit.is_some(), "matchedKey": hit.map(|g| g.key.clone()), "foundBy": hit.map(|g| g.found_by.clone()).unwrap_or_default() }));
        }
        let found = out.iter().filter(|o| o["found"] == true).count();
        Ok(json!({ "seeds": out, "found": found, "of": seeds.len(), "perConnector": per }))
    }

    pub fn dispatch(self: &Arc<Self>, web: &web_search::WebSearch, library: &dyn Library, command: &str, args: &Json) -> Option<Result<Output, String>> {
        let result = match command {
            "db_options" => {
                self.set_options(args);
                json_output(true)
            }
            "db_connectors" => json_output(self.connectors_info()),
            "db_connectors_status" => json_output(self.status()),
            "db_connectors_check" => json_output(self.check_updates(arg::<Option<bool>>(args, "force").ok().flatten().unwrap_or(false))),
            "db_connectors_rollback" => (|| {
                self.store().rollback()?;
                self.reload();
                json_output(self.status())
            })(),
            "db_translate" => self.translate(args).and_then(json_output),
            "db_estimate" => self.estimate(args).and_then(json_output),
            "db_estimate_cancel" => arg::<String>(args, "requestId").and_then(|id| {
                self.cancel_estimate(&id);
                json_output(true)
            }),
            "db_search_start" => self.start(args, None).and_then(json_output),
            "db_search_cancel" => arg::<String>(args, "runId").and_then(|id| {
                self.cancel_run(&id);
                json_output(true)
            }),
            "db_search_more" => (|| {
                let run = self.run(&arg::<String>(args, "runId")?)?;
                let only: Option<String> = arg(args, "connector")?;
                let extra = args.get("limit").and_then(Json::as_u64).map(|l| l as usize).unwrap_or(run.data.lock().map(|d| d.limit).unwrap_or(DEFAULT_LIMIT)).clamp(1, MAX_LIMIT);
                self.spawn_fetch(&run, only.as_deref(), extra);
                json_output(json!({ "runId": run.id }))
            })(),
            "db_results" => self.results(library, args).and_then(json_output),
            "db_record" => self.record(args).and_then(json_output),
            "db_add_to_library" => self.add(web, library, args).and_then(json_output),
            "db_saved_list" => json_output(self.saved_list().into_iter().map(|s| Saved { seen: Vec::new(), ..s }).collect::<Vec<_>>()),
            "db_saved_save" => self.saved_save(args).and_then(json_output),
            "db_saved_delete" => arg::<String>(args, "id").and_then(|id| {
                let mut all = self.saved_list();
                all.retain(|s| s.id != id);
                self.save_saved(&all);
                json_output(true)
            }),
            "db_saved_run" => (|| {
                let id: String = arg(args, "id")?;
                let saved = self.saved_list().into_iter().find(|s| s.id == id).ok_or("No such saved search")?;
                self.start(args, Some(&saved)).and_then(json_output)
            })(),
            "db_report" => self.report(args).and_then(json_output),
            "db_strategy" => self.strategy(args).and_then(json_output),
            // The whole run (strategy, counts per database and query, records with provenance):
            // the stable read for PRISMA identification numbers.
            "db_run" => arg::<String>(args, "runId").and_then(|id| self.report_by_id(&id)).and_then(|r| json_output(serde_json::to_value(&r).unwrap_or(Json::Null))),
            "db_query_parse" => (|| {
                let text: String = arg(args, "text")?;
                let default = arg::<Option<String>>(args, "defaultField")?.unwrap_or_else(|| "all".into());
                json_output(match key_connectors::boolean::parse_in(&text, &default) {
                    Ok(parsed) => json!({ "ok": true, "tree": parsed.tree, "text": parsed.text, "notes": parsed.notes }),
                    Err(error) => json!({ "ok": false, "error": error }),
                })
            })(),
            "db_query_format" => (|| {
                let tree: key_connectors::Node = arg(args, "tree")?;
                let default = arg::<Option<String>>(args, "defaultField")?.unwrap_or_else(|| "all".into());
                json_output(json!({ "text": key_connectors::boolean::format_in(&tree, &default) }))
            })(),
            "db_runs" => self.runs_list(args).and_then(json_output),
            "db_report_problem" => self.report_problem(args).and_then(json_output),
            "db_recall" => self.recall(args).and_then(json_output),
            "db_parse" => (|| {
                let text: String = arg(args, "text")?;
                let dialect = arg::<Option<String>>(args, "dialect")?.unwrap_or_else(|| "auto".into());
                json_output(match key_connectors::parse::parse(&text, &dialect) {
                    Ok((query, warnings)) => json!({ "query": query, "warnings": warnings }),
                    Err(error) => json!({ "raw": text, "error": error }),
                })
            })(),
            "db_suggest_terms" => json_output(Json::Array(Vec::new())),
            _ => return None,
        };
        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_read_naturally() {
        assert_eq!(display_name("Lee, Ann"), "Ann Lee");
        assert_eq!(display_name("World Health Organization"), "World Health Organization");
        assert_eq!(web_kind(Some("working-paper")).as_deref(), Some("report"));
    }

    #[test]
    fn a_search_runs_merges_reports_and_saved_searches_mark_new_records() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Arc::new(Databases::new(tmp.path().to_path_buf()));
        let info = db.connectors_info();
        assert!(info.as_array().unwrap().iter().any(|c| c["id"] == "pubmed"));
        let query = json!({ "concepts": [ { "terms": [ { "text": "vaccine hesitancy", "mode": "phrase", "field": "title_abstract" } ] } ] });
        let t = db.translate(&json!({ "query": query, "connectors": ["pubmed", "crossref-series", "econstor"] })).unwrap();
        assert_eq!(t[0]["native"], "\"vaccine hesitancy\"[tiab]");
        assert_eq!(t[2]["mode"], "harvest");
        let saved = db.saved_save(&json!({ "name": "Test", "query": query, "connectors": ["pubmed"] })).unwrap();
        assert_eq!(db.saved_list().len(), 1);
        assert!(saved["id"].as_str().unwrap().starts_with("saved-"));
        let url = db.report_problem(&json!({ "connector": "pubmed", "error": "PubMed answered 400" })).unwrap();
        assert!(url["url"].as_str().unwrap().starts_with(ISSUES_URL) && url["url"].as_str().unwrap().contains("connector%3Apubmed"));
    }
}
