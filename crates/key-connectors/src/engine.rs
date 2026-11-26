// Executing a connector's request plans: building requests from templates (only to the spec's
// hosts), politeness (spacing, retries with backoff, Retry-After, quotas), the built-in adapters
// (paged, ncbi-history, oai-pmh, html-listing), detail steps, local filtering and resumable
// paging (`SearchState`), so a run can stop, be cancelled, and fetch more later.
use crate::extract;
use crate::paths::{self, Doc, Node};
use crate::query::{self, Query, Translation};
use crate::record::Record;
use crate::spec::{Detail, PageSize, Param, Plan, RequestSpec, Spec};
use crate::template::{self, Vars};
pub use key_safe_http::{CancellationSource, CancellationToken};
use serde::Serialize;
use serde_json::Value as Json;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use url::Url;

/// Credential values by the spec's credential id.
pub type Credentials = BTreeMap<String, String>;

#[derive(Clone, Debug)]
pub struct Request {
    pub connector: String,
    pub method: String,
    pub url: Url,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub format: String,
    /// The spec's hosts: the only ones this request (and its redirects) may reach.
    pub hosts: Vec<String>,
    pub max_bytes: usize,
}

#[derive(Clone, Debug, Default)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum TransportError {
    Cancelled,
    Timeout,
    /// The request was refused before it was sent (host, scheme, size).
    Denied(String),
    Failed(String),
}

/// Sends one request: the safe HTTP client (`net`), a test's recorded answers (`fixtures`).
pub trait Transport: Send + Sync {
    fn send(&self, request: &Request, cancel: &CancellationToken) -> Result<Response, TransportError>;
}

/// Why a connector gave no answer.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineError {
    pub message: String,
    /// network | http | auth | quota | parse | config | cancelled
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// The request that failed (credentials removed), for reports and issues.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
    /// The start of the answer, for reports and issues.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
}

impl EngineError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self { message: message.into(), kind: kind.into(), status: None, request: None, excerpt: None }
    }
    pub fn cancelled() -> Self {
        Self::new("cancelled", "Cancelled")
    }
    /// The service changed (its answers no longer read), rather than a passing network fault.
    pub fn suggests_outdated(&self) -> bool {
        matches!(self.kind.as_str(), "parse" | "config") || (self.kind == "http" && self.status.is_some_and(|s| (400..500).contains(&s) && s != 429))
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// How a run waits, reports waiting and gives way to the user's work.
pub struct RunControl {
    pub cancel: CancellationToken,
    /// Waits (returns early when cancelled).
    pub sleep: Box<dyn Fn(Duration, &CancellationToken) + Send + Sync>,
    /// Told before a wait the user may notice (throttling, Retry-After).
    pub on_wait: Box<dyn Fn(Duration) + Send + Sync>,
    /// Called between requests: background runs yield to interactive work here.
    pub yield_now: Box<dyn Fn() + Send + Sync>,
}

impl RunControl {
    pub fn new(cancel: CancellationToken) -> Self {
        Self {
            cancel,
            sleep: Box::new(|d, cancel| {
                let until = Instant::now() + d;
                while Instant::now() < until && !cancel.is_cancelled() {
                    std::thread::sleep((until - Instant::now()).min(Duration::from_millis(50)));
                }
            }),
            on_wait: Box::new(|_| {}),
            yield_now: Box::new(|| {}),
        }
    }
    /// No real waiting (tests).
    pub fn instant() -> Self {
        Self { sleep: Box::new(|_, _| {}), ..Self::new(CancellationToken::active()) }
    }
}

/// One loaded connector.
#[derive(Clone, Debug)]
pub struct Connector {
    pub spec: Arc<Spec>,
    pub sha256: String,
}

/// What one page brought.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    pub records: Vec<Record>,
    /// Items read from the service on this page, before local filtering and de-duplication.
    pub raw: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    pub done: bool,
    pub requests: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota_remaining: Option<u64>,
    /// Records without a year, kept although a year filter was asked (applied locally).
    pub undated: usize,
}

#[derive(Clone, Debug)]
pub struct Chunk {
    pub native: String,
    pub vars: Vars,
    pub local_filter: bool,
}

/// Where a search is: which chunk, where its paging stands, what was seen.
#[derive(Clone, Debug)]
pub struct SearchState {
    pub chunks: Vec<Chunk>,
    pub chunk: usize,
    pub query: Query,
    pub options: Vars,
    offset: u64,
    page: u64,
    cursor: Option<String>,
    pages: u32,
    history: Option<(String, String)>,
    chunk_total: Option<u64>,
    links: VecDeque<Url>,
    listing_done: bool,
    pub totals: Vec<Option<u64>>,
    pub seen: HashSet<String>,
    pub done: bool,
    pub split_years: bool,
    pub requests: u32,
    /// Replaces the plan's page size (tests record small fixtures).
    pub page_size: Option<u64>,
}

impl SearchState {
    pub fn new(translation: &Translation, query: &Query, options: &Vars) -> Self {
        let chunks: Vec<Chunk> = translation.chunks.iter().map(|native| Chunk { native: native.clone(), vars: translation.vars.clone(), local_filter: translation.local_filter }).collect();
        Self {
            totals: vec![None; chunks.len()],
            chunks,
            chunk: 0,
            query: query.clone(),
            options: options.clone(),
            offset: 0,
            page: 0,
            cursor: None,
            pages: 0,
            history: None,
            chunk_total: None,
            links: VecDeque::new(),
            listing_done: false,
            seen: HashSet::new(),
            done: false,
            split_years: false,
            requests: 0,
            page_size: None,
        }
    }

    /// The total over every chunk as far as known (overlaps counted twice when split).
    pub fn total(&self) -> Option<u64> {
        let known: Vec<u64> = self.totals.iter().flatten().copied().collect();
        (!known.is_empty()).then(|| known.iter().sum())
    }

    fn next_chunk(&mut self) {
        self.chunk += 1;
        self.offset = 0;
        self.page = 0;
        self.cursor = None;
        self.pages = 0;
        self.history = None;
        self.chunk_total = None;
        self.links.clear();
        self.listing_done = false;
        if self.chunk >= self.chunks.len() {
            self.done = true;
        }
    }
}

struct Throttle {
    last: Option<Instant>,
}

pub struct Engine {
    transport: Arc<dyn Transport>,
    throttles: Mutex<HashMap<String, Throttle>>,
    cache: Mutex<HashMap<String, (Instant, Response)>>,
    pub mailto: Mutex<Option<String>>,
    pub cache_ttl: Duration,
}

const DEFAULT_MAX_BYTES: usize = 8 * 1024 * 1024;
const CACHE_ENTRIES: usize = 300;

impl Engine {
    pub fn new(transport: Arc<dyn Transport>) -> Self {
        Self { transport, throttles: Mutex::default(), cache: Mutex::default(), mailto: Mutex::default(), cache_ttl: Duration::from_secs(24 * 3600) }
    }

    pub fn clear_cache(&self) {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    fn base_vars(&self, spec: &Spec, chunk: &Chunk, creds: &Credentials, options: &Vars) -> Vars {
        let mut vars = chunk.vars.clone();
        vars.insert("query".into(), chunk.native.clone());
        for (id, value) in creds {
            vars.insert(format!("cred.{id}"), value.clone());
        }
        for option in &spec.options {
            let value = options.get(&option.id).cloned().unwrap_or_else(|| option.default.clone());
            vars.insert(format!("opt.{}", option.id), value);
        }
        for (k, v) in options {
            vars.insert(format!("opt.{k}"), v.clone());
        }
        if let Some(mailto) = self.mailto.lock().ok().and_then(|m| m.clone()) {
            vars.insert("mailto".into(), mailto);
        }
        vars
    }

    fn page_size(plan: &Plan, vars: &Vars) -> u64 {
        match &plan.page_size {
            PageSize::Fixed(n) => *n,
            PageSize::Template(t) => template::render_lenient(t, vars).trim().parse().unwrap_or(50),
        }
        .clamp(1, 10_000)
    }

    /// The request a template set describes, for these variables.
    pub fn build(&self, spec: &Spec, request: &RequestSpec, vars: &Vars) -> Result<Request, EngineError> {
        let config = |m: String| EngineError::new("config", m);
        let url_text = template::render(&request.url, vars).map_err(config)?.ok_or_else(|| config("The request URL has no value".into()))?;
        let mut url = Url::parse(&url_text).map_err(|e| config(format!("Bad request URL: {e}")))?;
        if url.scheme() != "https" {
            return Err(config("Only https requests are allowed".into()));
        }
        let host = url.host_str().unwrap_or("").to_ascii_lowercase();
        if !spec.hosts.iter().any(|h| h.eq_ignore_ascii_case(&host)) {
            return Err(config(format!("{host} is not one of this connector's hosts")));
        }
        let render_param = |p: &Param| -> Result<Option<String>, EngineError> {
            match p {
                Param::Text(t) => template::render(t, vars).map_err(config),
                Param::Joined(j) => {
                    let mut parts = Vec::new();
                    for t in &j.parts {
                        if let Some(v) = template::render(t, vars).map_err(config)? {
                            if !v.is_empty() {
                                parts.push(v);
                            }
                        }
                    }
                    Ok((!parts.is_empty()).then(|| parts.join(&j.join)))
                }
            }
        };
        let mut params = Vec::new();
        for (name, p) in &request.params {
            if let Some(v) = render_param(p)? {
                params.push((name.clone(), v));
            }
        }
        if let (Some(param), Some(mailto)) = (&spec.politeness.mailto_param, vars.get("mailto")) {
            if !request.params.contains_key(param) {
                params.push((param.clone(), mailto.clone()));
            }
        }
        if !params.is_empty() {
            url.query_pairs_mut().extend_pairs(params.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        }
        let mut headers = Vec::new();
        for (name, t) in &request.headers {
            if let Some(v) = template::render(t, vars).map_err(config)? {
                headers.push((name.clone(), v));
            }
        }
        let mut body = Vec::new();
        if !request.form.is_empty() {
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            for (name, p) in &request.form {
                if let Some(v) = render_param(p)? {
                    form.append_pair(name, &v);
                }
            }
            body = form.finish().into_bytes();
            headers.push(("content-type".into(), "application/x-www-form-urlencoded".into()));
        } else if let Some(json) = &request.body {
            body = serde_json::to_vec(&render_json(json, vars).map_err(config)?).unwrap_or_default();
            headers.push(("content-type".into(), "application/json".into()));
        }
        let accept = match request.format.as_str() {
            "json" => "application/json",
            "xml" => "application/xml, text/xml;q=0.9, */*;q=0.1",
            "csv" => "text/csv, text/plain;q=0.9, */*;q=0.1",
            _ => "text/html, application/xhtml+xml;q=0.9, */*;q=0.1",
        };
        if !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("accept")) {
            headers.push(("accept".into(), accept.into()));
        }
        Ok(Request {
            connector: spec.id.clone(),
            method: request.method.clone(),
            url,
            headers,
            body,
            format: request.format.clone(),
            hosts: spec.hosts.clone(),
            max_bytes: spec.politeness.max_response_bytes.unwrap_or(DEFAULT_MAX_BYTES).min(64 * 1024 * 1024),
        })
    }

    /// Sends a request with the spec's politeness: spacing, retries, Retry-After, quotas, cache.
    pub fn fetch(&self, spec: &Spec, request: &Request, creds: &Credentials, ctl: &RunControl, cache: bool) -> Result<(Response, Option<u64>), EngineError> {
        let key = format!("{}|{}|{}|{}", spec.id, spec.version, request.url, String::from_utf8_lossy(&request.body));
        if cache {
            if let Some((at, response)) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
                if at.elapsed() < self.cache_ttl {
                    return Ok((response.clone(), None));
                }
            }
        }
        let has_keys = !spec.credentials.is_empty() && spec.credentials.iter().all(|c| creds.contains_key(&c.id));
        let interval = Duration::from_millis(if has_keys { spec.politeness.min_interval_ms_with_key.unwrap_or(spec.politeness.min_interval_ms) } else { spec.politeness.min_interval_ms });
        let describe = || redact(request.url.as_str(), creds);
        let mut attempt = 0;
        loop {
            if ctl.cancel.is_cancelled() {
                return Err(EngineError::cancelled());
            }
            (ctl.yield_now)();
            let wait = {
                let throttles = self.throttles.lock().unwrap_or_else(|e| e.into_inner());
                throttles.get(&spec.id).and_then(|t| t.last).map(|last| interval.saturating_sub(last.elapsed())).unwrap_or_default()
            };
            if !wait.is_zero() {
                if wait > Duration::from_millis(900) {
                    (ctl.on_wait)(wait);
                }
                (ctl.sleep)(wait, &ctl.cancel);
            }
            self.throttles.lock().unwrap_or_else(|e| e.into_inner()).insert(spec.id.clone(), Throttle { last: Some(Instant::now()) });
            let answer = self.transport.send(request, &ctl.cancel);
            let retryable = attempt < spec.politeness.retries;
            let backoff = Duration::from_millis(spec.politeness.backoff_ms.saturating_mul(1 << attempt.min(6)));
            match answer {
                Err(TransportError::Cancelled) => return Err(EngineError::cancelled()),
                Err(TransportError::Denied(m)) => return Err(EngineError { request: Some(describe()), ..EngineError::new("config", m) }),
                Err(e @ (TransportError::Timeout | TransportError::Failed(_))) => {
                    if retryable {
                        attempt += 1;
                        (ctl.on_wait)(backoff);
                        (ctl.sleep)(backoff, &ctl.cancel);
                        continue;
                    }
                    let message = match e {
                        TransportError::Timeout => format!("{} did not answer in time", spec.name),
                        TransportError::Failed(m) => format!("Couldn't reach {}: {m}", spec.name),
                        _ => unreachable!(),
                    };
                    return Err(EngineError { request: Some(describe()), ..EngineError::new("network", message) });
                }
                Ok(response) => {
                    let quota = spec.politeness.quota.as_ref().and_then(|q| q.remaining_header.as_deref()).and_then(|h| response.header(h)).and_then(|v| v.trim().parse::<u64>().ok());
                    let exhausted_body = spec.politeness.quota.as_ref().and_then(|q| q.exhausted_body.as_deref()).is_some_and(|marker| response.status >= 400 && String::from_utf8_lossy(&response.body).contains(marker));
                    let error = |kind: &str, message: String| EngineError { status: Some(response.status), request: Some(describe()), excerpt: Some(excerpt(&response.body)), ..EngineError::new(kind, message) };
                    if exhausted_body || (response.status == 429 && quota == Some(0)) {
                        return Err(error("quota", format!("The {} quota is used up; try again later", spec.name)));
                    }
                    if (response.status == 429 || response.status >= 500) && retryable {
                        attempt += 1;
                        let wait = response.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok()).map(Duration::from_secs).unwrap_or(backoff).min(Duration::from_secs(120));
                        (ctl.on_wait)(wait);
                        (ctl.sleep)(wait, &ctl.cancel);
                        continue;
                    }
                    if response.status == 401 || response.status == 403 {
                        let keyed = !spec.credentials.is_empty();
                        return Err(error("auth", if keyed { format!("{} refused the request: check the API key and your access", spec.name) } else { format!("{} refused the request", spec.name) }));
                    }
                    if response.status == 429 {
                        return Err(error("quota", format!("{} asks to slow down; try again in a while", spec.name)));
                    }
                    if !(200..300).contains(&response.status) {
                        return Err(error("http", format!("{} answered {}", spec.name, response.status)));
                    }
                    if cache {
                        let mut c = self.cache.lock().unwrap_or_else(|e| e.into_inner());
                        if c.len() >= CACHE_ENTRIES {
                            c.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(600));
                            if c.len() >= CACHE_ENTRIES {
                                c.clear();
                            }
                        }
                        c.insert(key, (Instant::now(), response.clone()));
                    }
                    return Ok((response, quota));
                }
            }
        }
    }

    fn get_doc(&self, spec: &Spec, request: &Request, creds: &Credentials, ctl: &RunControl, state_requests: &mut u32, quota: &mut Option<u64>) -> Result<Doc, EngineError> {
        *state_requests += 1;
        let (response, q) = self.fetch(spec, request, creds, ctl, true)?;
        if q.is_some() {
            *quota = q;
        }
        Doc::parse(&request.format, &response.body, Some(&request.url))
            .map_err(|m| EngineError { request: Some(redact(request.url.as_str(), creds)), excerpt: Some(excerpt(&response.body)), ..EngineError::new("parse", format!("{}: {m}", spec.name)) })
    }

    /// How many records the query finds (the sum over its chunks).
    pub fn count(&self, spec: &Spec, translation: &Translation, query: &Query, options: &Vars, creds: &Credentials, ctl: &RunControl) -> Result<Option<u64>, EngineError> {
        let plan = spec.count.as_ref().or(spec.search.as_ref()).ok_or_else(|| EngineError::new("config", "This connector cannot search"))?;
        let mut total: Option<u64> = None;
        let state = SearchState::new(translation, query, options);
        let (mut requests, mut quota) = (0u32, None);
        for chunk in &state.chunks {
            let mut vars = self.base_vars(spec, chunk, creds, options);
            let size = if spec.count.is_some() { Self::page_size(plan, &vars) } else { 1 };
            vars.insert("pageSize".into(), size.to_string());
            vars.insert("offset".into(), plan.paging.start.to_string());
            vars.insert("page".into(), plan.paging.start.max(1).to_string());
            vars.insert("cursor".into(), plan.paging.first_cursor.clone().unwrap_or_default());
            let request = self.build(spec, &plan.request, &vars)?;
            let doc = self.get_doc(spec, &request, creds, ctl, &mut requests, &mut quota)?;
            let found = if plan.adapter == "oai-pmh" { oai_total(&doc) } else { plan.total.as_deref().and_then(|p| first_text(&doc.root(), p)).and_then(|t| parse_count(&t)) };
            if let Some(n) = found {
                total = Some(total.unwrap_or(0) + n);
            }
        }
        Ok(total)
    }

    /// The next page of results (after `state`), advancing it.
    pub fn next_page(&self, spec: &Spec, state: &mut SearchState, creds: &Credentials, ctl: &RunControl) -> Result<Fetched, EngineError> {
        let plan = spec.search.as_ref().ok_or_else(|| EngineError::new("config", "This connector cannot search"))?;
        let mut out = Fetched::default();
        if state.done || state.chunks.is_empty() {
            state.done = true;
            out.done = true;
            return Ok(out);
        }
        let chunk = state.chunks[state.chunk].clone();
        let mut vars = self.base_vars(spec, &chunk, creds, &state.options);
        let size = state.page_size.unwrap_or_else(|| Self::page_size(plan, &vars)).clamp(1, 10_000);
        vars.insert("pageSize".into(), size.to_string());
        let before = state.requests;
        let records = match plan.adapter.as_str() {
            "ncbi-history" => self.ncbi_page(spec, plan, state, &mut vars, size, creds, ctl, &mut out)?,
            "oai-pmh" => self.oai_page(spec, plan, state, &mut vars, creds, ctl, &mut out)?,
            "html-listing" => self.listing_page(spec, plan, state, &mut vars, size, creds, ctl, &mut out)?,
            _ => self.paged_page(spec, plan, state, &mut vars, size, creds, ctl, &mut out)?,
        };
        out.requests = state.requests - before;
        // Year-split: a query over the service's limit is sent again one year at a time.
        if spec.query.chunk == "year-split" && !state.split_years && state.chunk_total.is_some_and(|t| t > spec.capabilities.max_results) && state.pages <= 1 {
            if let Some(years) = year_chunks(spec, state) {
                state.split_years = true;
                let at = state.chunk;
                state.chunks.splice(at..=at, years.clone());
                state.totals.splice(at..=at, vec![None; years.len()]);
                state.offset = 0;
                state.page = 0;
                state.cursor = None;
                state.pages = 0;
                state.history = None;
                state.chunk_total = None;
                state.seen.clear();
                return self.next_page(spec, state, creds, ctl);
            }
        }
        let kept = self.finish_records(spec, plan, &chunk, state, records, creds, ctl, &mut out)?;
        out.records = kept;
        out.total = state.total();
        out.done = state.done;
        Ok(out)
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_records(&self, spec: &Spec, plan: &Plan, chunk: &Chunk, state: &mut SearchState, records: Vec<Record>, creds: &Credentials, ctl: &RunControl, out: &mut Fetched) -> Result<Vec<Record>, EngineError> {
        out.raw = records.len();
        let mut kept = Vec::new();
        let mut matched_any = false;
        let mut new_any = false;
        let year_asked = state.query.filters.year_from.is_some() || state.query.filters.year_to.is_some();
        for mut record in records {
            if record.source_id.is_empty() {
                record.source_id = record.doi.clone().or_else(|| record.url.clone()).unwrap_or_else(|| query::fold(&record.title));
            }
            if record.title.trim().is_empty() {
                continue;
            }
            if !state.seen.insert(record.source_id.clone()) {
                continue;
            }
            new_any = true;
            if let Some(detail) = plan.detail.as_ref().filter(|d| d.per_record && plan.adapter != "html-listing") {
                self.per_record(spec, detail, &mut record, chunk, creds, state, ctl, out)?;
            }
            if chunk.local_filter && !query::matches(&state.query, &record) {
                continue;
            }
            matched_any = true;
            if year_asked && record.year.is_none() {
                out.undated += 1;
            }
            kept.push(record);
        }
        if !state.done && out.raw > 0 {
            let stop = (plan.paging.stop_when_no_new && !new_any) || (plan.paging.stop_when_no_local_match && chunk.local_filter && !matched_any);
            if stop {
                state.next_chunk();
            }
        }
        Ok(kept)
    }

    #[allow(clippy::too_many_arguments)]
    fn per_record(&self, spec: &Spec, detail: &Detail, record: &mut Record, chunk: &Chunk, creds: &Credentials, state: &mut SearchState, ctl: &RunControl, out: &mut Fetched) -> Result<(), EngineError> {
        if let Some(when) = &detail.when {
            let have = record.get(&when.field);
            if when.min_length.is_some_and(|m| have.chars().count() >= m) || (when.min_length.is_none() && !have.is_empty()) {
                return Ok(());
            }
        }
        let mut vars = self.base_vars(spec, chunk, creds, &state.options);
        for field in crate::spec::RECORD_FIELDS {
            vars.insert(format!("record.{field}"), record.get(field));
        }
        let request = match self.build(spec, &detail.request, &vars) {
            Ok(r) => r,
            // A record whose link leads elsewhere keeps what the list said.
            Err(_) => return Ok(()),
        };
        let doc = match self.get_doc(spec, &request, creds, ctl, &mut state.requests, &mut out.quota_remaining) {
            Ok(doc) => doc,
            Err(e) if e.kind == "cancelled" => return Err(e),
            Err(_) => return Ok(()),
        };
        let root = doc.root();
        let item = match &detail.items {
            Some(p) => paths::select(&root, p).map_err(|m| EngineError::new("config", m))?.into_iter().next(),
            None => Some(root.clone()),
        };
        if let Some(item) = item {
            let extra = extract::record(&item, &detail.record).map_err(|m| EngineError::new("config", m))?;
            record.merge_from(&extra);
        }
        Ok(())
    }

    /// Items of an answer, filtered by `itemsWhere`.
    fn items<'a>(root: &Node<'a>, items: Option<&str>, where_: Option<&str>) -> Result<Vec<Node<'a>>, EngineError> {
        let mut list = match items {
            Some(p) => paths::select(root, p).map_err(|m| EngineError::new("config", m))?,
            None => vec![root.clone()],
        };
        if let Some(w) = where_ {
            list.retain(|n| first_text(n, w).is_some_and(|t| !t.trim().is_empty()));
        }
        Ok(list)
    }

    fn records_of(nodes: &[Node], map: &crate::spec::RecordMap) -> Result<Vec<Record>, EngineError> {
        nodes.iter().map(|n| extract::record(n, map).map_err(|m| EngineError::new("config", m))).collect()
    }

    #[allow(clippy::too_many_arguments)]
    fn paged_page(&self, spec: &Spec, plan: &Plan, state: &mut SearchState, vars: &mut Vars, size: u64, creds: &Credentials, ctl: &RunControl, out: &mut Fetched) -> Result<Vec<Record>, EngineError> {
        let style = plan.paging.style.as_str();
        vars.insert("offset".into(), (plan.paging.start + state.offset).to_string());
        vars.insert("page".into(), (plan.paging.start.max(if style == "page" { 0 } else { 1 }) + state.page).to_string());
        let cursor = state.cursor.clone().or_else(|| plan.paging.first_cursor.clone()).unwrap_or_default();
        vars.insert("cursor".into(), cursor.clone());
        vars.insert("token".into(), cursor);
        let request = self.build(spec, &plan.request, vars)?;
        let doc = self.get_doc(spec, &request, creds, ctl, &mut state.requests, &mut out.quota_remaining)?;
        let root = doc.root();
        if state.pages == 0 {
            let total = plan.total.as_deref().and_then(|p| first_text(&root, p)).and_then(|t| parse_count(&t));
            check_sanity(plan, total)?;
            state.chunk_total = total;
            state.totals[state.chunk] = total;
        }
        state.pages += 1;
        let items = Self::items(&root, plan.items.as_deref(), plan.items_where.as_deref())?;
        let count = items.len() as u64;
        let records = match &plan.detail {
            Some(detail) if !detail.per_record => {
                let ids: Vec<String> = match &detail.ids {
                    Some(p) => paths::select(&root, p).map_err(|m| EngineError::new("config", m))?.iter().filter_map(paths::text).filter(|t| !t.is_empty()).collect(),
                    None => Vec::new(),
                };
                self.detail_batches(spec, detail, &ids, vars, creds, state, ctl, out)?
            }
            _ => Self::records_of(&items, &plan.record)?,
        };
        let count = if plan.detail.as_ref().is_some_and(|d| !d.per_record) { records.len() as u64 } else { count };
        let next = plan.paging.next.as_deref().and_then(|p| first_text(&root, p)).filter(|n| !n.trim().is_empty());
        state.offset += size;
        state.page += 1;
        let finished = match style {
            "none" => true,
            "cursor" | "token" => next.is_none() || next == state.cursor,
            _ => false,
        } || count == 0
            || (plan.paging.stop_when_fewer && count < size)
            || state.chunk_total.is_some_and(|t| state.offset >= t)
            || state.pages >= spec.politeness.max_pages
            || (state.offset >= spec.capabilities.max_results && style != "cursor" && style != "token");
        state.cursor = next;
        if finished {
            state.next_chunk();
        }
        Ok(records)
    }

    #[allow(clippy::too_many_arguments)]
    fn detail_batches(&self, spec: &Spec, detail: &Detail, ids: &[String], vars: &Vars, creds: &Credentials, state: &mut SearchState, ctl: &RunControl, out: &mut Fetched) -> Result<Vec<Record>, EngineError> {
        let mut records = Vec::new();
        for batch in ids.chunks(detail.batch.max(1)) {
            let mut v = vars.clone();
            v.insert("ids".into(), batch.join(","));
            let request = self.build(spec, &detail.request, &v)?;
            let doc = self.get_doc(spec, &request, creds, ctl, &mut state.requests, &mut out.quota_remaining)?;
            let items = Self::items(&doc.root(), detail.items.as_deref(), detail.items_where.as_deref())?;
            records.extend(Self::records_of(&items, &detail.record)?);
        }
        Ok(records)
    }

    /// NCBI E-utilities: esearch with the history server once, then efetch pages from it.
    #[allow(clippy::too_many_arguments)]
    fn ncbi_page(&self, spec: &Spec, plan: &Plan, state: &mut SearchState, vars: &mut Vars, size: u64, creds: &Credentials, ctl: &RunControl, out: &mut Fetched) -> Result<Vec<Record>, EngineError> {
        let detail = plan.detail.as_ref().ok_or_else(|| EngineError::new("config", "ncbi-history needs detail"))?;
        if state.history.is_none() {
            vars.insert("offset".into(), "0".into());
            let request = self.build(spec, &plan.request, vars)?;
            let doc = self.get_doc(spec, &request, creds, ctl, &mut state.requests, &mut out.quota_remaining)?;
            let root = doc.root();
            let pick = |json: &str, xml: &str| first_text(&root, if plan.request.format == "json" { json } else { xml });
            if let Some(error) = pick("$.esearchresult.ERROR", "//ERROR") {
                return Err(EngineError { excerpt: Some(error.clone()), ..EngineError::new("http", format!("{}: {error}", spec.name)) });
            }
            let total = plan.total.as_deref().and_then(|p| first_text(&root, p)).and_then(|t| parse_count(&t)).or_else(|| pick("$.esearchresult.count", "/eSearchResult/Count").and_then(|t| parse_count(&t)));
            check_sanity(plan, total)?;
            let webenv = pick("$.esearchresult.webenv", "//WebEnv").unwrap_or_default();
            let key = pick("$.esearchresult.querykey", "//QueryKey").unwrap_or_default();
            state.chunk_total = total;
            state.totals[state.chunk] = total;
            if total == Some(0) || webenv.is_empty() {
                state.next_chunk();
                return Ok(Vec::new());
            }
            state.history = Some((webenv, key));
        }
        let (webenv, key) = state.history.clone().unwrap_or_default();
        vars.insert("webenv".into(), webenv);
        vars.insert("queryKey".into(), key);
        vars.insert("offset".into(), state.offset.to_string());
        let request = self.build(spec, &detail.request, vars)?;
        let doc = self.get_doc(spec, &request, creds, ctl, &mut state.requests, &mut out.quota_remaining)?;
        let items = Self::items(&doc.root(), detail.items.as_deref(), detail.items_where.as_deref())?;
        let records = Self::records_of(&items, &detail.record)?;
        state.pages += 1;
        state.offset += size;
        let limit = state.chunk_total.unwrap_or(0).min(spec.capabilities.max_results);
        if items.is_empty() || state.offset >= limit || state.pages >= spec.politeness.max_pages {
            state.next_chunk();
        }
        Ok(records)
    }

    /// OAI-PMH ListRecords: the first request as the spec says, then resumptionToken only.
    #[allow(clippy::too_many_arguments)]
    fn oai_page(&self, spec: &Spec, plan: &Plan, state: &mut SearchState, vars: &mut Vars, creds: &Credentials, ctl: &RunControl, out: &mut Fetched) -> Result<Vec<Record>, EngineError> {
        let request = match &state.cursor {
            None => self.build(spec, &plan.request, vars)?,
            Some(token) => {
                let mut first = self.build(spec, &RequestSpec { params: BTreeMap::new(), ..plan.request.clone() }, vars)?;
                first.url.query_pairs_mut().clear().append_pair("verb", "ListRecords").append_pair("resumptionToken", token);
                first
            }
        };
        let doc = self.get_doc(spec, &request, creds, ctl, &mut state.requests, &mut out.quota_remaining)?;
        let root = doc.root();
        if let Some(code) = paths::select(&root, "//error/@code").ok().and_then(|n| n.first().and_then(paths::text)) {
            if code == "noRecordsMatch" {
                state.totals[state.chunk] = Some(0);
                state.next_chunk();
                return Ok(Vec::new());
            }
            return Err(EngineError::new("http", format!("{}: OAI-PMH error {code}", spec.name)));
        }
        if state.pages == 0 {
            let total = oai_total(&doc);
            state.chunk_total = total;
            state.totals[state.chunk] = total;
        }
        state.pages += 1;
        let items = Self::items(&root, plan.items.as_deref().or(Some("//record")), plan.items_where.as_deref())?;
        // Deleted records carry a header only.
        let items: Vec<Node> = items.into_iter().filter(|n| first_text(n, "header/@status").as_deref() != Some("deleted")).collect();
        let records = Self::records_of(&items, &plan.record)?;
        let token = first_text(&root, "//resumptionToken").map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        if token.is_none() || state.pages >= spec.politeness.max_pages {
            state.next_chunk();
        } else {
            state.cursor = token;
        }
        Ok(records)
    }

    /// A listing of links (search results or a sitemap), each item page read for the record.
    #[allow(clippy::too_many_arguments)]
    fn listing_page(&self, spec: &Spec, plan: &Plan, state: &mut SearchState, vars: &mut Vars, size: u64, creds: &Credentials, ctl: &RunControl, out: &mut Fetched) -> Result<Vec<Record>, EngineError> {
        let detail = plan.detail.as_ref().ok_or_else(|| EngineError::new("config", "html-listing needs detail"))?;
        if state.links.is_empty() && !state.listing_done {
            vars.insert("offset".into(), (plan.paging.start + state.offset).to_string());
            vars.insert("page".into(), (plan.paging.start + state.page).to_string());
            vars.insert("cursor".into(), state.cursor.clone().or_else(|| plan.paging.first_cursor.clone()).unwrap_or_default());
            let request = self.build(spec, &plan.request, vars)?;
            let doc = self.get_doc(spec, &request, creds, ctl, &mut state.requests, &mut out.quota_remaining)?;
            let root = doc.root();
            if state.pages == 0 {
                let total = plan.total.as_deref().and_then(|p| first_text(&root, p)).and_then(|t| parse_count(&t));
                check_sanity(plan, total)?;
                state.chunk_total = total;
                state.totals[state.chunk] = total;
            }
            state.pages += 1;
            let selector = plan.links.as_deref().unwrap_or("a@href");
            let mut fresh = 0;
            for link in paths::select(&root, selector).map_err(|m| EngineError::new("config", m))?.iter().filter_map(paths::text) {
                let Ok(url) = request.url.join(link.trim()) else { continue };
                let same = url.scheme() == "https" && url.host_str().is_some_and(|h| spec.hosts.iter().any(|x| x.eq_ignore_ascii_case(h)));
                if same && !state.seen.contains(url.as_str()) && !state.links.contains(&url) {
                    state.links.push_back(url);
                    fresh += 1;
                }
            }
            state.offset += size;
            state.page += 1;
            let next = plan.paging.next.as_deref().and_then(|p| first_text(&root, p));
            let no_more = plan.paging.style == "none" || fresh == 0 || (plan.paging.stop_when_fewer && (fresh as u64) < size && plan.paging.style != "cursor") || state.pages >= spec.politeness.max_pages || (matches!(plan.paging.style.as_str(), "cursor" | "token") && next.is_none());
            state.cursor = next;
            state.listing_done = no_more;
        }
        let mut records = Vec::new();
        // A few item pages per call, so progress shows and cancel is quick.
        for _ in 0..size.min(10) {
            let Some(link) = state.links.pop_front() else { break };
            let mut v = vars.clone();
            v.insert("link".into(), link.to_string());
            let request = self.build(spec, &detail.request, &v)?;
            let doc = match self.get_doc(spec, &request, creds, ctl, &mut state.requests, &mut out.quota_remaining) {
                Ok(doc) => doc,
                Err(e) if e.kind == "cancelled" => return Err(e),
                Err(_) => continue,
            };
            let root = doc.root();
            let item = match &detail.items {
                Some(p) => paths::select(&root, p).map_err(|m| EngineError::new("config", m))?.into_iter().next(),
                None => Some(root.clone()),
            };
            if let Some(item) = item {
                let mut record = extract::record(&item, &detail.record).map_err(|m| EngineError::new("config", m))?;
                if record.url.is_none() {
                    record.url = Some(link.to_string());
                }
                if record.source_id.is_empty() {
                    record.source_id = link.to_string();
                }
                records.push(record);
            }
        }
        if state.links.is_empty() && state.listing_done {
            state.next_chunk();
        }
        Ok(records)
    }

    /// One record by its id at the source.
    pub fn lookup(&self, spec: &Spec, id: &str, creds: &Credentials, ctl: &RunControl) -> Result<Option<Record>, EngineError> {
        let plan = spec.lookup.as_ref().ok_or_else(|| EngineError::new("config", "This connector cannot look records up"))?;
        let chunk = Chunk { native: String::new(), vars: Vars::new(), local_filter: false };
        let mut vars = self.base_vars(spec, &chunk, creds, &Vars::new());
        vars.insert("id".into(), id.to_string());
        vars.insert("ids".into(), id.to_string());
        let request = self.build(spec, &plan.request, &vars)?;
        let (mut requests, mut quota) = (0, None);
        let doc = self.get_doc(spec, &request, creds, ctl, &mut requests, &mut quota)?;
        let search = spec.search.as_ref();
        let (items_path, map) = if !plan.record.is_empty() {
            (plan.items.clone(), &plan.record)
        } else if let Some(d) = plan.detail.as_ref() {
            (d.items.clone(), &d.record)
        } else if let Some(d) = search.and_then(|s| s.detail.as_ref()).filter(|d| !d.per_record) {
            (plan.items.clone().or(d.items.clone()), &d.record)
        } else {
            (plan.items.clone().or(search.and_then(|s| s.items.clone())), &search.ok_or_else(|| EngineError::new("config", "No record mapping"))?.record)
        };
        let items = Self::items(&doc.root(), items_path.as_deref(), None)?;
        Ok(items.first().map(|n| extract::record(n, map)).transpose().map_err(|m| EngineError::new("config", m))?)
    }
}

fn check_sanity(plan: &Plan, total: Option<u64>) -> Result<(), EngineError> {
    if let (Some(s), Some(t)) = (&plan.sanity, total) {
        if t > s.max_total {
            return Err(EngineError::new("parse", s.error.clone().unwrap_or_else(|| format!("The service reported {t} results, more than this connector expects; its search may have changed"))));
        }
    }
    Ok(())
}

fn oai_total(doc: &Doc) -> Option<u64> {
    first_text(&doc.root(), "//resumptionToken/@completeListSize").and_then(|t| parse_count(&t)).or_else(|| {
        // A single page without a token: its records are all there is.
        let n = paths::select(&doc.root(), "//record").ok()?.len() as u64;
        first_text(&doc.root(), "//resumptionToken").is_none().then_some(n)
    })
}

/// Per-year chunks for a query over the service's limit (year-split).
fn year_chunks(spec: &Spec, state: &SearchState) -> Option<Vec<Chunk>> {
    let current = crate::time::current_year();
    let from = state.query.filters.year_from.unwrap_or(1950);
    let to = state.query.filters.year_to.unwrap_or(current).min(current);
    if to < from || to - from > 150 {
        return None;
    }
    let mut out = Vec::new();
    for year in (from..=to).rev() {
        let mut q = state.query.clone();
        q.filters.year_from = Some(year);
        q.filters.year_to = Some(year);
        let t = query::translate(spec, &q, &state.options);
        // The year-split chunk is the one that was too large; its OR-split siblings stay.
        let native = t.chunks.get(state.chunk).cloned().or_else(|| t.chunks.first().cloned())?;
        out.push(Chunk { native, vars: t.vars, local_filter: t.local_filter });
    }
    Some(out)
}

pub fn first_text(node: &Node, path: &str) -> Option<String> {
    paths::select(node, path).ok()?.iter().filter_map(paths::text).map(|t| t.trim().to_string()).find(|t| !t.is_empty())
}

fn parse_count(text: &str) -> Option<u64> {
    let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Strings in a JSON body are templates; a string that is exactly one variable holding an
/// integer becomes a number.
fn render_json(value: &Json, vars: &Vars) -> Result<Json, String> {
    Ok(match value {
        Json::String(s) => {
            if let Some(name) = template::sole_variable(s) {
                let v = vars.get(name.trim_end_matches('?')).filter(|v| !v.is_empty());
                match v {
                    Some(v) if v.parse::<i64>().is_ok() => Json::from(v.parse::<i64>().unwrap_or(0)),
                    Some(v) => Json::String(v.clone()),
                    None if s.ends_with("?}") => Json::Null,
                    None => return Err(format!("{s} has no value")),
                }
            } else {
                match template::render(s, vars)? {
                    Some(v) => Json::String(v),
                    None => Json::Null,
                }
            }
        }
        Json::Array(items) => Json::Array(items.iter().map(|v| render_json(v, vars)).collect::<Result<_, _>>()?),
        Json::Object(map) => Json::Object(map.iter().map(|(k, v)| Ok((k.clone(), render_json(v, vars)?))).collect::<Result<_, String>>()?),
        other => other.clone(),
    })
}

/// The URL with credential values replaced.
pub fn redact(text: &str, creds: &Credentials) -> String {
    let mut out = text.to_string();
    for value in creds.values().filter(|v| v.len() >= 4) {
        out = out.replace(value.as_str(), "REDACTED");
        let encoded: String = url::form_urlencoded::byte_serialize(value.as_bytes()).collect();
        out = out.replace(&encoded, "REDACTED");
    }
    out
}

pub fn excerpt(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(&body[..body.len().min(2000)]);
    text.chars().take(1500).collect()
}
