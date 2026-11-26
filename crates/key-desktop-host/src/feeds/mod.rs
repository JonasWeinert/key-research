// Feeds and alerts: the `feeds_*` commands and a polite poller behind the Inbox. What is
// followed and what it brought live in the workspace store (key-store feeds.rs); this
// fetches. Subscriptions are RSS/Atom feeds (fetched with ETag/Last-Modified, so an unchanged
// feed costs a 304) or OpenAlex queries: a saved web search with its filters, an author, a
// journal, a topic, or new works citing the sources of a collection or the library
// (`cites:`), asked through web search's OpenAlex client (polite pool, the key as fallback).
//
// The poller runs only while the workspace's host does (that is, while the app does), one
// subscription at a time, each on its own interval with backoff after failures and any
// Retry-After honoured; it rests while the app says the Mac is offline or saving power.
// Nothing is fetched until the user follows something.
//
// Tests and smokes point a feed at a local mock with KEY_FEEDS_ALLOW_LOOPBACK=1 (OpenAlex
// with KEY_WEB_OPENALEX_URL); KEY_FEEDS_TICK_MS and KEY_FEEDS_START_DELAY_MS shorten waits.
pub mod parse;

use super::web_search::{
    WebSearch,
    filters::WebFilters,
    http::{self, Base, Response, SendError, Transport},
    openalex,
};
use crate::ipc::{Output, arg, json_output};
use key_safe_http::CancellationToken;
use key_store::{
    Store,
    feeds::{Check, ItemQuery, Retention, Subscription, SubscriptionInput},
};
use serde_json::{Map, Value as Json, json};
use std::{
    collections::HashSet,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use url::Url;

const FEED_ACCEPT: &str = "application/rss+xml, application/atom+xml, application/rdf+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8, text/html;q=0.5, */*;q=0.1";
/// Works asked of OpenAlex per check (the first check takes fewer: the latest only).
const PAGE: usize = 50;
const FIRST_PAGE: usize = 25;
/// OpenAlex takes at most this many values in one filter.
const CITES_PER_REQUEST: usize = 50;
const PURGE_EVERY_MS: i64 = 6 * 60 * 60_000;

#[derive(Clone, Copy, Debug)]
struct Env {
    online: bool,
    low_power: bool,
}

struct Inner {
    store: Store,
    web: Arc<WebSearch>,
    transport: Box<Transport>,
    env: Mutex<Env>,
    signal: (Mutex<u64>, Condvar),
    busy: AtomicUsize,
    started: AtomicBool,
    checking: Mutex<HashSet<String>>,
    purged_at: Mutex<i64>,
}

#[derive(Clone)]
pub struct Feeds {
    inner: Arc<Inner>,
}

fn env_ms(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn base() -> Base {
    Base { url: String::new(), overridden: std::env::var("KEY_FEEDS_ALLOW_LOOPBACK").is_ok_and(|v| v == "1") }
}

fn send(base: &Base, url: &Url, headers: &[(&str, &str)], cancel: &CancellationToken) -> Result<Response, SendError> {
    if base.overridden && http::is_loopback(url) {
        return http::loopback_get(url, headers, cancel);
    }
    http::feed_get(url, headers, cancel)
}

/// Days since the epoch as YYYY-MM-DD (UTC).
fn civil(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// An OpenAlex id as its short form: "https://openalex.org/A123" → "A123".
fn short(id: &str) -> String {
    id.trim().trim_end_matches('/').rsplit('/').next().unwrap_or("").to_uppercase()
}

fn config_text(config: &Map<String, Json>, key: &str) -> Option<String> {
    config.get(key).and_then(Json::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// A typed address as a URL ("journal.org/rss" gets https://).
fn address(text: &str) -> Result<Url, String> {
    let t = text.trim();
    let with_scheme = if t.contains("://") { t.to_string() } else { format!("https://{t}") };
    let url = Url::parse(&with_scheme).map_err(|_| "That is not a web address".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Feeds are fetched over HTTP or HTTPS".into());
    }
    Ok(url)
}

struct Failure {
    message: String,
    retry_after_ms: Option<i64>,
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self { message, retry_after_ms: None }
    }
}

impl Feeds {
    pub fn new(store: Store, web: Arc<WebSearch>) -> Self {
        Self::with(store, web, Box::new(send))
    }

    fn with(store: Store, web: Arc<WebSearch>, transport: Box<Transport>) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                web,
                transport,
                env: Mutex::new(Env { online: true, low_power: false }),
                signal: (Mutex::new(0), Condvar::new()),
                busy: AtomicUsize::new(0),
                started: AtomicBool::new(false),
                checking: Default::default(),
                purged_at: Mutex::new(0),
            }),
        }
    }

    /// Starts the poller (once).
    pub fn start(&self) {
        if self.inner.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let inner = self.inner.clone();
        let _ = std::thread::Builder::new().name("key-feeds".into()).spawn(move || {
            inner.wait(Duration::from_millis(env_ms("KEY_FEEDS_START_DELAY_MS", 20_000)));
            loop {
                if !inner.paused() {
                    inner.poll_due();
                    inner.purge();
                }
                inner.wait(Duration::from_millis(env_ms("KEY_FEEDS_TICK_MS", 60_000).max(200)));
            }
        });
    }

    pub fn busy(&self) -> bool {
        self.inner.busy.load(Ordering::SeqCst) > 0
    }

    fn wake(&self) {
        let (lock, condvar) = &self.inner.signal;
        *lock.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        condvar.notify_all();
    }
}

impl Inner {
    fn wait(&self, duration: Duration) {
        let (lock, condvar) = &self.signal;
        let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let seen = *guard;
        let _ = condvar.wait_timeout_while(guard, duration, |n| *n == seen);
    }

    fn paused(&self) -> bool {
        let env = *self.env.lock().unwrap_or_else(|e| e.into_inner());
        !env.online || env.low_power
    }

    fn purge(&self) {
        let now = key_store::now_ms();
        let mut at = self.purged_at.lock().unwrap_or_else(|e| e.into_inner());
        if now - *at > PURGE_EVERY_MS {
            *at = now;
            let _ = self.store.purge_feed_items(now);
        }
    }

    fn poll_due(&self) {
        let Ok(due) = self.store.due_feed_subscriptions(key_store::now_ms()) else { return };
        for (i, subscription) in due.iter().enumerate() {
            if self.paused() {
                break;
            }
            if i > 0 {
                std::thread::sleep(Duration::from_millis(500));
            }
            let _ = self.refresh(subscription);
        }
    }

    /// Checks one subscription now and stores what it found: the count of new items.
    fn refresh(&self, subscription: &Subscription) -> Result<usize, String> {
        if !self.checking.lock().unwrap_or_else(|e| e.into_inner()).insert(subscription.id.clone()) {
            return Ok(0);
        }
        self.busy.fetch_add(1, Ordering::SeqCst);
        let cancel = CancellationToken::active();
        let outcome = self.check(subscription, &cancel);
        let result = match outcome {
            Ok((items, check)) => {
                let added = self.store.add_feed_items(&subscription.id, &items);
                self.store.record_feed_check(&subscription.id, &check)?;
                added
            }
            Err(failure) => {
                let check = Check { ok: false, error: Some(failure.message.clone()), retry_after_ms: failure.retry_after_ms, ..Default::default() };
                self.store.record_feed_check(&subscription.id, &check)?;
                Err(failure.message)
            }
        };
        self.busy.fetch_sub(1, Ordering::SeqCst);
        self.checking.lock().unwrap_or_else(|e| e.into_inner()).remove(&subscription.id);
        result
    }

    fn check(&self, subscription: &Subscription, cancel: &CancellationToken) -> Result<(Vec<Json>, Check), Failure> {
        if subscription.kind == "rss" {
            let url = address(&config_text(&subscription.config, "url").ok_or("This feed has no address".to_string())?)?;
            let (response, feed) = self.fetch_feed(&url, subscription.etag.as_deref(), subscription.last_modified.as_deref(), cancel)?;
            let check = Check {
                ok: true,
                etag: response.header("etag").map(String::from),
                last_modified: response.header("last-modified").map(String::from),
                ..Default::default()
            };
            return match feed {
                Some(feed) => Ok((feed.items, check)),
                // 304: nothing new.
                None => Ok((Vec::new(), check)),
            };
        }
        let items = self.openalex_items(subscription, cancel)?;
        Ok((items, Check { ok: true, cursor: Some(civil(key_store::now_ms())), ..Default::default() }))
    }

    /// GETs a feed (conditionally). Answers the parsed feed, or none for a 304.
    fn fetch_feed(&self, url: &Url, etag: Option<&str>, modified: Option<&str>, cancel: &CancellationToken) -> Result<(Response, Option<parse::Feed>), Failure> {
        let response = self.get(url, etag, modified, cancel)?;
        if response.status == 304 {
            return Ok((response, None));
        }
        let text = String::from_utf8_lossy(&response.body).into_owned();
        match parse::feed(&text, Some(url)) {
            Some(feed) => Ok((response, Some(feed))),
            None => Err(Failure::from("This address does not serve a feed".to_string())),
        }
    }

    fn get(&self, url: &Url, etag: Option<&str>, modified: Option<&str>, cancel: &CancellationToken) -> Result<Response, Failure> {
        let mut headers: Vec<(&str, &str)> = vec![("accept", FEED_ACCEPT)];
        if let Some(etag) = etag {
            headers.push(("if-none-match", etag));
        }
        if let Some(modified) = modified {
            headers.push(("if-modified-since", modified));
        }
        let host = url.host_str().unwrap_or("the site").to_string();
        let response = (self.transport)(&base(), url, &headers, cancel).map_err(|e| match e {
            SendError::Cancelled => Failure::from("Cancelled".to_string()),
            SendError::Timeout => Failure::from(format!("{host} did not answer in time")),
            SendError::Failed(m) => Failure::from(format!("Couldn't reach {host}: {m}")),
        })?;
        match response.status {
            200..=299 | 304 => Ok(response),
            429 | 503 => Err(Failure { message: format!("{host} is limiting requests"), retry_after_ms: response.retry_after().map(|d| d.as_millis() as i64) }),
            404 | 410 => Err(Failure::from(format!("{host} no longer has this feed (HTTP {})", response.status))),
            status => Err(Failure::from(format!("{host} returned HTTP {status}"))),
        }
    }

    /// The OpenAlex `filter` values (and search words) a subscription asks with.
    fn openalex_query(&self, subscription: &Subscription) -> Result<(Option<String>, Vec<Vec<String>>), String> {
        let c = &subscription.config;
        let id = config_text(c, "openalexId").map(|i| short(&i));
        let one = |filter: String| Ok((None, vec![vec![filter]]));
        match subscription.kind.as_str() {
            "openalex" => {
                let filters: WebFilters = c.get("filters").cloned().map(serde_json::from_value).transpose().map_err(|e| e.to_string())?.unwrap_or_default();
                let query = config_text(c, "query");
                let parts = openalex::filter_param(&filters);
                if query.is_none() && parts.is_empty() {
                    return Err("This search has no words or filters".into());
                }
                Ok((query, vec![parts]))
            }
            "author" => match (id, config_text(c, "orcid")) {
                (Some(id), _) if id.starts_with('A') => one(format!("author.id:{id}")),
                (_, Some(orcid)) => one(format!("author.orcid:https://orcid.org/{}", orcid.rsplit('/').next().unwrap_or(&orcid))),
                _ => Err("This author has no OpenAlex id or ORCID yet".into()),
            },
            "venue" => match (id, config_text(c, "issn")) {
                (Some(id), _) if id.starts_with('S') => one(format!("primary_location.source.id:{id}")),
                (_, Some(issn)) => one(format!("primary_location.source.issn:{issn}")),
                _ => Err("This journal has no OpenAlex id or ISSN yet".into()),
            },
            "topic" => match id {
                Some(id) if id.starts_with('T') => one(format!("topics.id:{id}")),
                Some(id) if id.len() > 1 && id[1..].chars().all(|c| c.is_ascii_digit()) => {
                    let level = match &id[..1] {
                        "D" => "domain",
                        "F" => "field",
                        _ => "subfield",
                    };
                    one(format!("primary_topic.{level}.id:{}", &id[1..]))
                }
                _ => Err("This topic has no OpenAlex id".into()),
            },
            "citing" => {
                let ids = self.store.openalex_ids_in(config_text(c, "collectionId").as_deref(), config_text(c, "sourceId").as_deref(), CITES_PER_REQUEST * 2)?;
                if ids.is_empty() {
                    return Err("None of these sources has an OpenAlex record yet, so citing works cannot be found".into());
                }
                Ok((None, ids.chunks(CITES_PER_REQUEST).map(|chunk| vec![format!("cites:{}", chunk.join("|"))]).collect()))
            }
            other => Err(format!("Unknown subscription kind {other}")),
        }
    }

    fn openalex_items(&self, subscription: &Subscription, cancel: &CancellationToken) -> Result<Vec<Json>, Failure> {
        let (query, requests) = self.openalex_query(subscription)?;
        let first = subscription.checked_at.is_none() || subscription.cursor.is_none();
        // After the first check, works published since a while before it (late indexing).
        let since = subscription.cursor.as_ref().filter(|_| !first).map(|_| civil(subscription.checked_at.unwrap_or(0) - 60 * 86_400_000));
        let per_page = if first { FIRST_PAGE } else { PAGE }.to_string();
        let select = format!("{},publication_date", openalex::FIELDS);
        let mut items = Vec::new();
        for mut filters in requests {
            if let Some(since) = &since {
                filters.push(format!("from_publication_date:{since}"));
            }
            let filter = filters.join(",");
            let mut params: Vec<(&str, &str)> = vec![("filter", &filter), ("sort", "publication_date:desc"), ("per-page", &per_page), ("select", &select)];
            if let Some(q) = &query {
                params.push(("search", q));
            }
            let body = self.web.openalex_json("works", &params, cancel).map_err(|e| Failure { message: e.message, retry_after_ms: e.retry_after.map(|d| d.as_millis() as i64) })?;
            for raw in body["results"].as_array().into_iter().flatten() {
                let Some(work) = openalex::parse_work(raw) else { continue };
                let mut value = serde_json::to_value(work).unwrap_or(Json::Null);
                if let Some(date) = raw["publication_date"].as_str() {
                    value["published"] = json!(date);
                }
                items.push(value);
            }
        }
        Ok(items)
    }

    /// Feeds a page offers: itself when it is one, else those it links to.
    fn discover(&self, text: &str) -> Result<Vec<Json>, String> {
        let url = address(text)?;
        let cancel = CancellationToken::active();
        let response = self.get(&url, None, None, &cancel).map_err(|f| f.message)?;
        let body = String::from_utf8_lossy(&response.body).into_owned();
        if let Some(feed) = parse::feed(&body, Some(&url)) {
            return Ok(vec![json!({ "url": url.to_string(), "title": feed.title, "items": feed.items.len() })]);
        }
        Ok(parse::discover(&body, &url).into_iter().map(|(u, t)| json!({ "url": u, "title": t })).collect())
    }

    /// Follows something: a feed (found from a page's address when needed) or an OpenAlex
    /// alert; checked at once, so the Inbox fills.
    fn subscribe(&self, mut input: SubscriptionInput) -> Result<Json, String> {
        if input.kind == "rss" {
            let config = input.config.get_or_insert_with(Map::new);
            let typed = config_text(config, "url").ok_or("Enter a feed or page address")?;
            let mut url = address(&typed)?;
            let cancel = CancellationToken::active();
            let response = self.get(&url, None, None, &cancel).map_err(|f| f.message)?;
            let body = String::from_utf8_lossy(&response.body).into_owned();
            let (feed, response) = match parse::feed(&body, Some(&url)) {
                Some(feed) => (feed, response),
                None => {
                    let found = parse::discover(&body, &url);
                    let (feed_url, _) = found.first().ok_or("No feed found at this address")?;
                    config.insert("site".into(), json!(url.to_string()));
                    url = address(feed_url)?;
                    let (response, feed) = self.fetch_feed(&url, None, None, &cancel).map_err(|f| f.message)?;
                    (feed.ok_or("No feed found at this address")?, response)
                }
            };
            config.insert("url".into(), json!(url.to_string()));
            if input.title.as_deref().is_none_or(|t| t.trim().is_empty()) {
                input.title = feed.title.clone().or_else(|| url.host_str().map(String::from));
            }
            let existing = self.store.find_feed_subscription("rss", config)?;
            let subscription = self.store.save_feed_subscription(&input)?;
            let added = if existing.is_some() {
                0
            } else {
                let added = self.store.add_feed_items(&subscription.id, &feed.items)?;
                let check = Check { ok: true, etag: response.header("etag").map(String::from), last_modified: response.header("last-modified").map(String::from), ..Default::default() };
                self.store.record_feed_check(&subscription.id, &check)?;
                added
            };
            return Ok(json!({ "subscription": self.store.feed_subscription(&subscription.id)?, "added": added, "existed": existing.is_some() }));
        }
        let existing = self.store.find_feed_subscription(&input.kind, input.config.as_ref().unwrap_or(&Map::new()))?;
        let subscription = self.store.save_feed_subscription(&input)?;
        let (added, error) = if existing.is_some() {
            (0, None)
        } else {
            match self.refresh(&subscription) {
                Ok(n) => (n, None),
                Err(e) => (0, Some(e)),
            }
        };
        Ok(json!({ "subscription": self.store.feed_subscription(&subscription.id)?, "added": added, "existed": existing.is_some(), "error": error }))
    }

    fn import_opml(&self, text: &str) -> Result<Json, String> {
        let (mut added, mut existing) = (0, 0);
        let outlines = parse::opml(text);
        if outlines.is_empty() {
            return Err("This file lists no feeds".into());
        }
        for outline in outlines {
            if !key_store::feeds::KINDS.contains(&outline.kind.as_str()) {
                continue;
            }
            if self.store.find_feed_subscription(&outline.kind, &outline.config)?.is_some() {
                existing += 1;
                continue;
            }
            self.store.save_feed_subscription(&SubscriptionInput {
                kind: outline.kind,
                title: Some(outline.title).filter(|t| !t.is_empty()),
                config: Some(outline.config),
                interval_minutes: outline.interval_minutes,
                ..Default::default()
            })?;
            added += 1;
        }
        Ok(json!({ "added": added, "existing": existing }))
    }
}

/// The `feeds_*` commands.
pub fn dispatch(feeds: &Feeds, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let inner = &feeds.inner;
    let store = &inner.store;
    let query = || serde_json::from_value::<ItemQuery>(args.clone()).map_err(|e| e.to_string());
    let result = match command {
        "feeds_subscriptions" => store.feed_subscriptions().and_then(json_output),
        "feeds_find" => (|| {
            let kind: String = arg(args, "kind")?;
            let config: Map<String, Json> = arg::<Option<Map<String, Json>>>(args, "config")?.unwrap_or_default();
            json_output(store.find_feed_subscription(&kind, &config)?)
        })(),
        "feeds_discover" => arg::<String>(args, "url").and_then(|url| json_output(inner.discover(&url)?)),
        "feeds_subscribe" => (|| {
            let input: SubscriptionInput = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
            let out = inner.subscribe(SubscriptionInput { id: None, ..input })?;
            feeds.wake();
            json_output(out)
        })(),
        "feeds_update" => (|| {
            let input: SubscriptionInput = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
            input.id.as_ref().ok_or("Choose a subscription")?;
            let saved = store.save_feed_subscription(&input)?;
            feeds.wake();
            json_output(saved)
        })(),
        "feeds_unsubscribe" => arg::<String>(args, "id").and_then(|id| {
            store.delete_feed_subscription(&id)?;
            json_output(true)
        }),
        // Checks now: one subscription, or every one that is not paused. Answers what came in.
        "feeds_refresh" => (|| {
            let id: Option<String> = arg(args, "id")?;
            let subscriptions: Vec<Subscription> = match &id {
                Some(id) => store.feed_subscription(id)?.into_iter().collect(),
                None => store.feed_subscriptions()?.into_iter().filter(|s| !s.paused).collect(),
            };
            let (mut added, mut errors) = (0, Vec::new());
            for subscription in &subscriptions {
                match inner.refresh(subscription) {
                    Ok(n) => added += n,
                    Err(error) => errors.push(json!({ "id": subscription.id, "title": subscription.title, "error": error })),
                }
            }
            json_output(json!({ "added": added, "errors": errors, "checked": subscriptions.len() }))
        })(),
        "feeds_items" => query().and_then(|q| json_output(store.feed_items(&q)?)),
        "feeds_set" => (|| {
            let ids: Vec<String> = arg(args, "ids")?;
            json_output(store.set_feed_items(&ids, arg(args, "read")?, arg(args, "saved")?, arg(args, "dismissed")?)?)
        })(),
        // An item added to the library: it remembers the source, which goes on the reading
        // list ("To read") unless the user already gave it a status.
        "feeds_added" => (|| {
            let id: String = arg(args, "id")?;
            let source_id: String = arg(args, "sourceId")?;
            store.feed_item_added(&id, &source_id)?;
            let reading = store.reading(&source_id)?;
            if !reading.manual && reading.status == "unread" && reading.opened_at.is_none() {
                store.set_reading_status(std::slice::from_ref(&source_id), Some("unread"))?;
            }
            json_output(true)
        })(),
        "feeds_mark_read" => query().and_then(|q| json_output(store.mark_feed_read(&q)?)),
        "feeds_counts" => arg::<Option<i64>>(args, "since").and_then(|since| json_output(store.feed_counts(since)?)),
        // OPML out: as text, or written to a file the user chose.
        "feeds_opml_export" => (|| {
            let subscriptions = store.feed_subscriptions()?;
            let text = parse::to_opml(&subscriptions);
            match arg::<Option<std::path::PathBuf>>(args, "path")? {
                Some(path) => {
                    std::fs::write(&path, &text).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
                    json_output(json!({ "path": path, "count": subscriptions.len() }))
                }
                None => json_output(json!({ "text": text, "count": subscriptions.len() })),
            }
        })(),
        "feeds_opml_import" => (|| {
            let text = match (arg::<Option<String>>(args, "text")?, arg::<Option<std::path::PathBuf>>(args, "path")?) {
                (Some(text), _) => text,
                (None, Some(path)) => {
                    let bytes = std::fs::read(&path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
                    if bytes.len() > 4 * 1024 * 1024 {
                        return Err("This file is too large for an OPML list".into());
                    }
                    String::from_utf8_lossy(&bytes).into_owned()
                }
                _ => return Err("Choose an OPML file".into()),
            };
            let out = inner.import_opml(&text)?;
            feeds.wake();
            json_output(out)
        })(),
        // The app says when the Mac is offline or saving power: the poller rests.
        "feeds_environment" => (|| {
            let mut env = inner.env.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(online) = arg::<Option<bool>>(args, "online")? {
                env.online = online;
            }
            if let Some(low) = arg::<Option<bool>>(args, "lowPower")? {
                env.low_power = low;
            }
            let paused = !env.online || env.low_power;
            drop(env);
            feeds.wake();
            json_output(json!({ "paused": paused }))
        })(),
        "feeds_retention" => (|| match arg::<Option<Retention>>(args, "set")? {
            Some(r) => json_output(store.set_feed_retention(&r)?),
            None => json_output(store.feed_retention()?),
        })(),
        "feeds_purge" => store.purge_feed_items(key_store::now_ms()).and_then(json_output),
        _ => return None,
    };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::tests::{Recorded, fixture};
    use std::sync::Mutex as StdMutex;

    type Seen = Arc<StdMutex<Vec<(String, Vec<(String, String)>)>>>;

    /// A feed server: a page that links to a feed, the feed (with an ETag), and a 503.
    fn feeds_with(openalex: impl Fn(&Url) -> (u16, String) + Send + Sync + 'static) -> (tempfile::TempDir, Feeds, Seen, Arc<Mutex<Vec<Url>>>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let oa_urls: Arc<Mutex<Vec<Url>>> = Default::default();
        let record = oa_urls.clone();
        let (_calls, web) = Recorded::routed(move |url| {
            record.lock().unwrap().push(url.clone());
            openalex(url)
        })
        .search();
        let seen: Seen = Default::default();
        let log = seen.clone();
        let transport: Box<Transport> = Box::new(move |_base, url, headers, _cancel| {
            log.lock().unwrap().push((url.to_string(), headers.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect()));
            let conditional = headers.iter().any(|(n, v)| *n == "if-none-match" && *v == "\"v1\"");
            let (status, headers, body): (u16, Vec<(String, String)>, String) = match url.path() {
                "/toc" => (200, vec![], r#"<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head></html>"#.into()),
                "/rss.xml" if conditional => (304, vec![], String::new()),
                "/rss.xml" => (200, vec![("ETag".into(), "\"v1\"".into())], include_str!("fixtures/journal-toc.rss").into()),
                "/down.xml" => (503, vec![("Retry-After".into(), "120".into())], String::new()),
                _ => (404, vec![], String::new()),
            };
            Ok(Response { status, headers, body: body.into_bytes() })
        });
        let feeds = Feeds::with(store, Arc::new(web), transport);
        (dir, feeds, seen, oa_urls)
    }

    fn call(feeds: &Feeds, command: &str, args: Json) -> Json {
        match dispatch(feeds, command, &args).unwrap() {
            Ok(Output::Json(v)) => v,
            Ok(_) => panic!("binary"),
            Err(e) => panic!("{command}: {e}"),
        }
    }

    #[test]
    fn subscribes_from_a_page_address_then_asks_conditionally() {
        let (_dir, feeds, seen, _) = feeds_with(|_| (404, "{}".into()));
        let out = call(&feeds, "feeds_subscribe", json!({ "kind": "rss", "config": { "url": "journal.example.org/toc" } }));
        assert_eq!(out["added"], 2);
        let s = &out["subscription"];
        assert_eq!((s["title"].as_str(), s["config"]["url"].as_str()), (Some("Nature Methods: latest research"), Some("https://journal.example.org/rss.xml")));
        assert_eq!(s["etag"], "\"v1\"");
        // Unchanged: a 304, nothing new, no error.
        let refreshed = call(&feeds, "feeds_refresh", json!({ "id": s["id"] }));
        assert_eq!((refreshed["added"].as_u64(), refreshed["errors"].as_array().map(Vec::len)), (Some(0), Some(0)));
        let last = seen.lock().unwrap().last().cloned().unwrap();
        assert!(last.1.iter().any(|(n, v)| n == "if-none-match" && v == "\"v1\""));
        let items = call(&feeds, "feeds_items", json!({ "view": "unread" }));
        assert_eq!(items["total"], 2);
        assert_eq!(items["items"][0]["work"]["doi"], "10.1038/s41592-025-01234-5");
        // Following it again is the same subscription.
        assert_eq!(call(&feeds, "feeds_subscribe", json!({ "kind": "rss", "config": { "url": "https://journal.example.org/rss.xml" } }))["existed"], true);
    }

    #[test]
    fn a_failing_feed_backs_off_and_honours_retry_after() {
        let (_dir, feeds, _, _) = feeds_with(|_| (404, "{}".into()));
        let saved = feeds.inner.store.save_feed_subscription(&SubscriptionInput { kind: "rss".into(), title: Some("Down".into()), config: json!({ "url": "https://x.example/down.xml" }).as_object().cloned(), ..Default::default() }).unwrap();
        let out = call(&feeds, "feeds_refresh", json!({ "id": saved.id }));
        assert!(out["errors"][0]["error"].as_str().unwrap().contains("limiting"));
        let s = feeds.inner.store.feed_subscription(&saved.id).unwrap().unwrap();
        assert_eq!(s.failures, 1);
        assert!(s.next_at.unwrap() - s.checked_at.unwrap() >= 120_000);
    }

    #[test]
    fn follows_authors_journals_topics_searches_and_citations_through_openalex() {
        let body = fixture("openalex-search.json").to_string();
        let (_dir, feeds, _, urls) = feeds_with(move |_| (200, body.clone()));
        let store = feeds.inner.store.clone();
        let out = call(&feeds, "feeds_subscribe", json!({ "kind": "author", "title": "Ashish Vaswani", "config": { "openalexId": "https://openalex.org/A5001" } }));
        assert_eq!(out["added"], 3);
        let q = Recorded::query(&urls.lock().unwrap()[0]);
        assert_eq!((q["filter"].as_str(), q["sort"].as_str(), q["per-page"].as_str()), ("author.id:A5001", "publication_date:desc", "25"));
        assert!(q["select"].ends_with(",publication_date"));
        assert!(q.contains_key("mailto"), "the polite pool");
        // A second check asks only for recent works; the same works are not repeated.
        let id = out["subscription"]["id"].clone();
        assert_eq!(call(&feeds, "feeds_refresh", json!({ "id": id }))["added"], 0);
        let q = Recorded::query(&urls.lock().unwrap()[1]);
        assert!(q["filter"].starts_with("author.id:A5001,from_publication_date:"), "{}", q["filter"]);
        // A saved web search with its filters, a journal and a topic.
        call(&feeds, "feeds_subscribe", json!({ "kind": "openalex", "title": "attention", "config": { "query": "attention", "filters": { "yearFrom": 2020, "openAccess": true } } }));
        let q = Recorded::query(&urls.lock().unwrap()[2]);
        assert_eq!((q["search"].as_str(), q["filter"].as_str()), ("attention", "publication_year:2020-,is_oa:true"));
        call(&feeds, "feeds_subscribe", json!({ "kind": "venue", "config": { "openalexId": "S137773608" } }));
        call(&feeds, "feeds_subscribe", json!({ "kind": "topic", "config": { "openalexId": "F17" } }));
        let q = |i: usize| Recorded::query(&urls.lock().unwrap()[i])["filter"].clone();
        assert_eq!((q(3).as_str(), q(4).as_str()), ("primary_location.source.id:S137773608", "primary_topic.field.id:17"));
        // New works citing a collection's sources.
        let collection = store.create_collection("Reading group", None, None).unwrap();
        let mut fields = Map::new();
        fields.insert("title".into(), json!("Mine"));
        fields.insert("openalexId".into(), json!("W42"));
        store.insert_source(key_store::SourceInput { kind: "reference".into(), fields, collections: vec![collection.id.clone()], ..Default::default() }).unwrap();
        let out = call(&feeds, "feeds_subscribe", json!({ "kind": "citing", "title": "Citing Reading group", "config": { "collectionId": collection.id } }));
        assert_eq!(out["error"], Json::Null);
        assert_eq!(q(5), "cites:W42");
        // Every work is one item, whichever subscriptions found it.
        let items = call(&feeds, "feeds_items", json!({}));
        assert_eq!(items["total"], 3);
        assert_eq!(items["items"][0]["subscriptionIds"].as_array().unwrap().len(), 5);
        // Triage: add one to the library; it goes on the reading list.
        let item = items["items"][0]["id"].clone();
        let source = store.insert_source(key_store::SourceInput { kind: "reference".into(), fields: json!({ "title": "Added" }).as_object().cloned().unwrap(), ..Default::default() }).unwrap();
        call(&feeds, "feeds_added", json!({ "id": item, "sourceId": source.id }));
        let after = call(&feeds, "feeds_items", json!({}));
        let added = after["items"].as_array().unwrap().iter().find(|i| i["id"] == item).unwrap().clone();
        assert_eq!((added["added"].as_bool(), added["read"].as_bool(), added["inLibrary"].as_str()), (Some(true), Some(true), Some("added")));
        assert!(store.reading(&source.id).unwrap().manual);
        assert_eq!(call(&feeds, "feeds_counts", json!({}))["unread"], 2);
    }

    #[test]
    fn opml_round_trips_and_the_poller_rests_offline() {
        let (_dir, feeds, _, _) = feeds_with(|_| (404, "{}".into()));
        call(&feeds, "feeds_subscribe", json!({ "kind": "rss", "config": { "url": "https://journal.example.org/rss.xml" } }));
        feeds.inner.store.save_feed_subscription(&SubscriptionInput { kind: "author".into(), title: Some("Ada".into()), config: json!({ "orcid": "0000-0001" }).as_object().cloned(), ..Default::default() }).unwrap();
        let text = call(&feeds, "feeds_opml_export", json!({}))["text"].as_str().unwrap().to_string();
        for s in feeds.inner.store.feed_subscriptions().unwrap() {
            call(&feeds, "feeds_unsubscribe", json!({ "id": s.id }));
        }
        assert_eq!(call(&feeds, "feeds_items", json!({}))["total"], 0);
        assert_eq!(call(&feeds, "feeds_opml_import", json!({ "text": text })), json!({ "added": 2, "existing": 0 }));
        assert_eq!(call(&feeds, "feeds_opml_import", json!({ "text": text })), json!({ "added": 0, "existing": 2 }));
        let kinds: Vec<String> = feeds.inner.store.feed_subscriptions().unwrap().into_iter().map(|s| s.kind).collect();
        assert_eq!(kinds, ["rss", "author"]);
        assert_eq!(call(&feeds, "feeds_environment", json!({ "online": false })), json!({ "paused": true }));
        assert!(feeds.inner.paused());
        call(&feeds, "feeds_environment", json!({ "online": true, "lowPower": false }));
        assert!(!feeds.inner.paused());
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil(0), "1970-01-01");
        assert_eq!(civil(1_700_000_000_000), "2023-11-14");
    }
}
