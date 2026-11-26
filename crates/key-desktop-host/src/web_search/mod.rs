// Web search for the search page, the readers and the in-app browser: scholarly catalogues
// (OpenAlex, Semantic Scholar, Google Scholar via SerpApi) asked one at a time through `web_*`
// commands, so a slow or failing one never holds up another. A search the user moved on from
// is cancelled with `web_search_cancel`.
//
// Keys and preferences come from the app (`web_options`): the app keeps the keys in its
// secret store and sends them over this channel, never through the environment. Requests
// made with a key are counted; the app reads and clears the counts with `web_key_usage` and
// shows them in Settings. Nothing here goes to the network unless the user searches the web
// or adds a work.
pub mod filters;
pub mod http;
pub mod library;
pub mod merge;
pub mod openalex;
pub mod provider;
pub mod scholar_serpapi;
pub mod semantic_scholar;
pub mod types;

use crate::ipc::{Output, arg, json_output};
use filters::{FilterToken, LOCAL, WebFilters};
use http::{ProviderError, Retry, TtlCache, Transport};
use key_safe_http::{CancellationSource, CancellationToken};
use provider::{Context, Provider, SearchRequest};
use serde_json::{Value as Json, json};
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};
use types::{WebPage, WebResult};

const DEFAULT_MAILTO: &str = "key-app@users.noreply.github.com";

/// The web search providers, in the order their results interleave. Google Scholar (via
/// SerpApi) comes last: off by default, and the fallback when the others fail.
pub fn providers() -> Vec<Arc<dyn Provider>> {
    vec![Arc::new(openalex::OpenAlex), Arc::new(semantic_scholar::SemanticScholar), Arc::new(scholar_serpapi::ScholarSerpApi)]
}

#[derive(Clone, Debug, Default)]
struct Key {
    key: Option<String>,
    always: bool,
}

#[derive(Clone, Debug, Default)]
struct Options {
    mailto: Option<String>,
    /// Turned on or off in Settings, by provider id.
    enabled: HashMap<String, bool>,
    /// By service id.
    keys: HashMap<String, Key>,
}

#[derive(Default)]
struct Usage {
    requests: u64,
    failures: u64,
    last_error: Option<String>,
    last_at: Option<i64>,
    invalid: bool,
}

/// One fallback request that several failed providers wait for.
#[derive(Default)]
struct Flight {
    page: Mutex<Option<Option<WebPage>>>,
    done: Condvar,
}

type Sleep = dyn Fn(Duration, &CancellationToken) -> bool + Send + Sync;

pub struct WebSearch {
    providers: Vec<Arc<dyn Provider>>,
    options: Mutex<Options>,
    cache: TtlCache<WebPage>,
    running: Mutex<HashMap<String, CancellationSource>>,
    fallbacks: Mutex<HashMap<String, Arc<Flight>>>,
    usage: Mutex<HashMap<String, Usage>>,
    transport: Box<Transport>,
    sleep: Box<Sleep>,
}

impl Default for WebSearch {
    fn default() -> Self {
        Self::with(providers(), Box::new(|base, url, headers, cancel| http::send(base, url, headers, cancel)), Box::new(http::wait))
    }
}

impl WebSearch {
    fn with(providers: Vec<Arc<dyn Provider>>, transport: Box<Transport>, sleep: Box<Sleep>) -> Self {
        Self {
            providers,
            options: Default::default(),
            cache: TtlCache::new(Duration::from_secs(10 * 60), 200),
            running: Default::default(),
            fallbacks: Default::default(),
            usage: Default::default(),
            transport,
            sleep,
        }
    }

    fn options(&self) -> Options {
        self.options.lock().map(|o| o.clone()).unwrap_or_default()
    }

    /// What the app says about keys and Settings; any part may be left out.
    pub fn set_options(&self, args: &Json) {
        let mut options = self.options.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mailto) = args.get("mailto").and_then(Json::as_str) {
            options.mailto = Some(mailto.trim().to_string()).filter(|m| m.contains('@'));
        }
        if let Some(providers) = args.get("providers").and_then(Json::as_object) {
            options.enabled = providers.iter().filter_map(|(id, entry)| Some((id.clone(), entry.get("enabled")?.as_bool()?))).collect();
        }
        if let Some(keys) = args.get("keys").and_then(Json::as_object) {
            for (service, entry) in keys {
                let key = entry.get("key").and_then(Json::as_str).map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
                let always = entry.get("mode").and_then(Json::as_str) == Some("always");
                options.keys.insert(service.clone(), Key { key, always });
            }
        }
    }

    fn mailto(&self) -> String {
        self.options().mailto.unwrap_or_else(|| DEFAULT_MAILTO.into())
    }

    fn key_of(&self, p: &dyn Provider) -> Option<String> {
        let service = p.capabilities().service?;
        self.options().keys.get(service)?.key.clone()
    }

    fn always(&self, service: &str) -> bool {
        self.options().keys.get(service).is_some_and(|k| k.always)
    }

    fn enabled(&self, p: &dyn Provider) -> bool {
        let caps = p.capabilities();
        if caps.key_required && self.key_of(p).is_none() {
            return false;
        }
        match self.options().enabled.get(p.id()) {
            Some(on) => *on,
            None => caps.service.is_some_and(|s| caps.key_required && self.always(s)) || caps.enabled_by_default,
        }
    }

    fn provider(&self, id: &str) -> Result<Arc<dyn Provider>, String> {
        self.providers.iter().find(|p| p.id() == id).cloned().ok_or_else(|| format!("No web search provider {id}"))
    }

    fn record(&self, service: &str, outcome: http::Outcome) {
        let mut usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
        let entry = usage.entry(service.to_string()).or_default();
        entry.requests += 1;
        entry.last_at = Some(key_store::now_ms());
        if !outcome.ok {
            entry.failures += 1;
            entry.last_error = outcome.error;
        }
        entry.invalid |= outcome.invalid;
    }

    /// The counts since the last call, by service, which starts them again.
    pub fn take_usage(&self) -> Json {
        let usage = std::mem::take(&mut *self.usage.lock().unwrap_or_else(|e| e.into_inner()));
        Json::Object(
            usage
                .into_iter()
                .map(|(service, u)| (service, json!({ "requests": u.requests, "failures": u.failures, "lastError": u.last_error, "lastAt": u.last_at, "invalid": u.invalid })))
                .collect(),
        )
    }

    /// Keyless first; with the key only when that fails in a way a key helps (or always, if
    /// chosen, and always for a provider that needs one).
    fn keyed<T>(&self, p: &dyn Provider, cancel: &CancellationToken, task: &dyn Fn(&Context) -> Result<T, ProviderError>) -> Result<T, ProviderError> {
        let caps = p.capabilities();
        let key = self.key_of(p);
        let mailto = self.mailto();
        let run = |key: Option<&str>| task(&Context { api_key: key, mailto: &mailto, cancel, transport: &*self.transport });
        let Some(service) = caps.service else { return run(key.as_deref()) };
        let always = caps.key_required || self.always(service);
        http::with_key_fallback(key.as_deref(), always, cancel, &|outcome| self.record(service, outcome), &run)
    }

    fn ask(&self, p: &dyn Provider, query: &str, request: &SearchRequest, cancel: &CancellationToken) -> Result<WebPage, ProviderError> {
        self.keyed(p, cancel, &|cx| http::with_retry(Retry::search(), cancel, &*self.sleep, || p.search(query, request, cx)))
    }

    /// The filters a provider can apply: in its request, or on the results it returns.
    fn applicable(p: &dyn Provider) -> Vec<&'static str> {
        let own = p.capabilities().filters;
        filters::KEYS.iter().copied().filter(|k| own.contains(k) || LOCAL.contains(k)).collect()
    }

    pub fn providers_info(&self) -> Json {
        Json::Array(
            self.providers
                .iter()
                .map(|p| {
                    let caps = p.capabilities();
                    json!({
                        "id": p.id(),
                        "label": p.label(),
                        "icon": p.icon(),
                        // Keys are set under Services & API keys for every provider with a service.
                        "apiKey": caps.api_key && caps.service.is_none(),
                        "keyRequired": caps.key_required,
                        "keyHelp": caps.key_help,
                        "enabled": self.enabled(&**p),
                        "lookup": p.has_lookup(),
                        "filters": Self::applicable(&**p),
                    })
                })
                .collect(),
        )
    }

    /// Search tokens as web filters: those some provider that is on applies, the kind of each
    /// token (none for those the web cannot apply), and the kinds that apply.
    pub fn filters_for(&self, tokens: &[FilterToken]) -> Json {
        let mut applicable: Vec<&str> = Vec::new();
        for p in self.providers.iter().filter(|p| self.enabled(&***p)) {
            for key in Self::applicable(&**p) {
                if !applicable.contains(&key) {
                    applicable.push(key);
                }
            }
        }
        let all = filters::to_filters(tokens);
        let picked = filters::pick(&all, &filters::active(&all).into_iter().filter(|k| applicable.contains(k)).collect::<Vec<_>>());
        json!({ "filters": picked, "keys": tokens.iter().map(filters::filter_key).collect::<Vec<_>>(), "applicable": applicable })
    }

    pub fn cancel(&self, request_id: &str) {
        if let Some(source) = self.running.lock().unwrap_or_else(|e| e.into_inner()).get(request_id) {
            source.cancel();
        }
    }

    pub fn search(&self, id: &str, query: &str, limit: usize, cursor: Option<&str>, filters: &WebFilters, request_id: Option<&str>) -> Result<WebPage, String> {
        let p = self.provider(id)?;
        if !self.enabled(&*p) {
            return Err(format!("{} is turned off in Settings", p.label()));
        }
        let q: String = query.trim().chars().take(300).collect();
        let q = q.trim();
        let own = p.capabilities().filters;
        let active = filters::active(filters);
        let local: Vec<&str> = active.iter().copied().filter(|k| !own.contains(k) && LOCAL.contains(k)).collect();
        let unsupported: Vec<String> = active.iter().copied().filter(|k| !own.contains(k) && !LOCAL.contains(k)).map(String::from).collect();
        let short = q.chars().count() < 2;
        if short && active.is_empty() {
            return Ok(WebPage::default());
        }
        if !unsupported.is_empty() {
            return Ok(WebPage { skipped: Some(unsupported), ..Default::default() });
        }
        // Results checked here come in larger pages, so a page still has some left.
        let limit = if local.is_empty() { limit } else { (limit * 2).min(50) };
        let key = json!([id, q.to_lowercase(), limit, cursor.unwrap_or(""), filters]).to_string();
        if let Some(cached) = self.cache.get(&key) {
            return Ok(cached);
        }
        let source = CancellationSource::new();
        let cancel = source.token();
        if let Some(request_id) = request_id {
            self.running.lock().unwrap_or_else(|e| e.into_inner()).insert(request_id.to_string(), source);
        }
        let words = if short { "" } else { q };
        let request = SearchRequest { limit, cursor, filters };
        let result = (|| {
            let mut page = match self.ask(&*p, words, &request, &cancel) {
                Ok(page) => page,
                Err(error) if cancel.is_cancelled() || error.cancelled => return Err(error),
                Err(error) => self.fallback(id, words, &request, &cancel).ok_or(error)?,
            };
            // Nothing found: a keyed Scholar search may know the work.
            if page.results.is_empty() {
                if let Some(fallback) = self.fallback(id, words, &request, &cancel) {
                    page = fallback;
                }
            }
            if !local.is_empty() {
                page.results.retain(|r| filters::meets(r, filters, &local));
                page.total = None;
            }
            Ok(page)
        })();
        if let Some(request_id) = request_id {
            self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(request_id);
        }
        match result {
            Ok(page) => {
                self.cache.set(key, page.clone());
                Ok(page)
            }
            Err(error) if cancel.is_cancelled() || error.cancelled => Err("Cancelled".into()),
            Err(error) => Err(error.message),
        }
    }

    /// A first page from the keyed provider kept for when others fail (Google Scholar via
    /// SerpApi): only when it has a key and the user has not turned it on as a provider of its
    /// own. Two providers failing on the same query share one request.
    fn fallback(&self, failed: &str, q: &str, request: &SearchRequest, cancel: &CancellationToken) -> Option<WebPage> {
        if request.cursor.is_some() {
            return None;
        }
        let spare = self.providers.iter().find(|p| {
            let caps = p.capabilities();
            p.id() != failed && caps.key_required && caps.service.is_some() && self.key_of(&***p).is_some() && !self.enabled(&***p)
        })?;
        let key = json!([spare.id(), q.to_lowercase(), request.limit, request.filters]).to_string();
        let page = match self.cache.get(&key) {
            Some(page) => Some(page),
            None => {
                let (flight, leader) = {
                    let mut flights = self.fallbacks.lock().unwrap_or_else(|e| e.into_inner());
                    match flights.get(&key) {
                        Some(flight) => (flight.clone(), false),
                        None => {
                            let flight = Arc::new(Flight::default());
                            flights.insert(key.clone(), flight.clone());
                            (flight, true)
                        }
                    }
                };
                if leader {
                    let page = self.ask(&**spare, q, &SearchRequest { cursor: None, ..*request }, cancel).ok();
                    if let Some(page) = &page {
                        self.cache.set(key.clone(), page.clone());
                    }
                    *flight.page.lock().unwrap_or_else(|e| e.into_inner()) = Some(page.clone());
                    flight.done.notify_all();
                    self.fallbacks.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
                    page
                } else {
                    let guard = flight.page.lock().unwrap_or_else(|e| e.into_inner());
                    let guard = flight.done.wait_while(guard, |page| page.is_none()).unwrap_or_else(|e| e.into_inner());
                    guard.clone().flatten()
                }
            }
        }?;
        if page.results.is_empty() {
            return None;
        }
        let results = page.results.into_iter().map(|r| WebResult { fallback_for: Some(failed.to_string()), ..r }).collect();
        Some(WebPage { results, cursor: None, ..page })
    }

    /// One work by DOI or the provider's own id; none when the provider has no such work.
    pub fn lookup(&self, provider: &str, id: &str) -> Result<Option<WebResult>, String> {
        let p = self.provider(provider)?;
        if !p.has_lookup() {
            return Err(format!("{} cannot look works up", p.label()));
        }
        let cancel = CancellationToken::active();
        self.keyed(&*p, &cancel, &|cx| http::with_retry(Retry::lookup(), &cancel, &*self.sleep, || p.lookup(id, cx))).map_err(|e| e.message)
    }
}

/// The library calls web search makes: its own search, one source, and creating one.
pub trait Library {
    fn find(&self, text: &str) -> Vec<library::Stored>;
    fn source(&self, id: &str) -> Result<Json, String>;
    fn create(&self, input: Json) -> Result<Json, String>;
}

/// Adds the work as a reference, or answers the source it already is. With `lookup`, a work
/// with a DOI is first looked up in OpenAlex, whose record (when it has one) is what is added.
pub fn add_to_library(web: &WebSearch, library: &dyn Library, work: WebResult, collection: Option<&str>, lookup: bool) -> Result<Json, String> {
    let mut work = work;
    if lookup {
        if let Some(doi) = types::bare_doi(work.doi.as_deref()).filter(|d| d.starts_with("10.")) {
            if let Ok(Some(found)) = web.lookup("openalex", &doi) {
                if !found.title.trim().is_empty() {
                    work = found;
                }
            }
        }
    }
    if work.title.trim().is_empty() {
        return Err("Nothing to add".into());
    }
    let existing = library::find_existing(&[library::Asked::from(&work)], &|text| library.find(text));
    if let Some(id) = existing.get("work").and_then(Json::as_str) {
        return Ok(json!({ "source": library.source(id)?, "existed": true, "work": work }));
    }
    let source = library.create(library::source_input(&work, collection))?;
    Ok(json!({ "source": source, "existed": false, "work": work }))
}

/// The `web_*` commands (but `web_search_cancel`, which is answered at once: see Host::immediate).
pub fn dispatch(web: &WebSearch, library: &dyn Library, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let result = match command {
        "web_options" => {
            web.set_options(args);
            json_output(true)
        }
        "web_providers" => json_output(web.providers_info()),
        "web_filters" => arg::<Option<Vec<FilterToken>>>(args, "tokens").and_then(|tokens| json_output(web.filters_for(&tokens.unwrap_or_default()))),
        "web_search" => (|| {
            let provider: String = arg(args, "provider")?;
            let query = arg::<Option<String>>(args, "query")?.unwrap_or_default();
            let limit = args.get("limit").and_then(Json::as_f64).map(|l| l as usize).filter(|l| *l > 0).unwrap_or(20).clamp(1, 50);
            let cursor: Option<String> = arg::<Option<Json>>(args, "cursor")?.and_then(|c| match c {
                Json::String(s) => Some(s),
                Json::Number(n) => Some(n.to_string()),
                _ => None,
            });
            let filters = arg::<Option<WebFilters>>(args, "filters")?.unwrap_or_default();
            let request_id: Option<String> = arg(args, "requestId")?;
            json_output(web.search(&provider, &query, limit, cursor.as_deref(), &filters, request_id.as_deref())?)
        })(),
        "web_lookup" => (|| json_output(web.lookup(&arg::<String>(args, "provider")?, &arg::<String>(args, "id")?)?))(),
        "web_merge" => arg::<Vec<merge::ProviderList>>(args, "lists").and_then(|lists| json_output(merge::merge(&lists))),
        "web_library_match" => arg::<Option<Vec<library::Asked>>>(args, "works").and_then(|works| json_output(Json::Object(library::find_existing(&works.unwrap_or_default(), &|text| library.find(text))))),
        "web_add_to_library" => (|| {
            let work: WebResult = arg::<Option<WebResult>>(args, "work")?.ok_or("Nothing to add")?;
            let collection: Option<String> = arg(args, "collectionId")?;
            let lookup = arg::<Option<bool>>(args, "lookup")?.unwrap_or(false);
            json_output(add_to_library(web, library, work, collection.as_deref(), lookup)?)
        })(),
        // What was asked with the user's keys since the last read (Settings shows the usage).
        "web_key_usage" => json_output(web.take_usage()),
        _ => return None,
    };
    Some(result)
}

/// The workspace library behind the `store_*` commands.
pub struct StoreLibrary<'a> {
    pub library: &'a super::library_store::Library,
    pub root: &'a std::path::Path,
}

impl StoreLibrary<'_> {
    fn call(&self, command: &str, args: Json) -> Result<Json, String> {
        match self.library.dispatch(command, &args, self.root) {
            Some(Ok(Output::Json(value))) => Ok(value),
            Some(Ok(Output::Binary(_))) => Err("Unexpected binary answer".into()),
            Some(Err(error)) => Err(error),
            None => Err(format!("Unknown Key command: {command}")),
        }
    }
}

impl Library for StoreLibrary<'_> {
    fn find(&self, text: &str) -> Vec<library::Stored> {
        self.call("store_sources", json!({ "text": text, "limit": 8, "scope": "all", "sort": "added", "descending": true }))
            .ok()
            .and_then(|page| serde_json::from_value(page["items"].clone()).ok())
            .unwrap_or_default()
    }
    fn source(&self, id: &str) -> Result<Json, String> {
        self.call("store_source", json!({ "id": id }))
    }
    fn create(&self, input: Json) -> Result<Json, String> {
        self.call("store_create", json!({ "source": input }))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::VecDeque;
    use url::Url;

    pub fn fixture(name: &str) -> Json {
        let text = match name {
            "openalex-search.json" => include_str!("fixtures/openalex-search.json"),
            "s2-search.json" => include_str!("fixtures/s2-search.json"),
            "serpapi-scholar.json" => include_str!("fixtures/serpapi-scholar.json"),
            other => panic!("no fixture {other}"),
        };
        serde_json::from_str(text).unwrap()
    }

    type Route = dyn Fn(&Url) -> (u16, String) + Send + Sync;

    #[derive(Default)]
    struct Calls {
        answers: VecDeque<(u16, String)>,
        urls: Vec<Url>,
        headers: Vec<Vec<(String, String)>>,
    }

    /// Recorded answers, in order or by route, and what each request carried.
    pub struct Recorded {
        calls: Arc<Mutex<Calls>>,
        transport: Box<Transport>,
        cancel: CancellationToken,
    }

    impl Recorded {
        fn make(answers: Vec<(u16, String)>, route: Option<Box<Route>>) -> Self {
            let calls = Arc::new(Mutex::new(Calls { answers: answers.into(), ..Default::default() }));
            let inner = calls.clone();
            let transport: Box<Transport> = Box::new(move |_base, url, headers, _cancel| {
                let mut calls = inner.lock().unwrap();
                calls.urls.push(url.clone());
                calls.headers.push(headers.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect());
                let (status, body) = match &route {
                    Some(route) => route(url),
                    None => calls.answers.pop_front().expect("an answer for every request"),
                };
                Ok(http::Response { status, headers: Vec::new(), body: body.into_bytes() })
            });
            Self { calls, transport, cancel: CancellationToken::active() }
        }
        pub fn new(answers: Vec<(u16, String)>) -> Self {
            Self::make(answers, None)
        }
        pub fn routed(route: impl Fn(&Url) -> (u16, String) + Send + Sync + 'static) -> Self {
            Self::make(Vec::new(), Some(Box::new(route)))
        }
        pub fn context<'a>(&'a self, api_key: Option<&'a str>, mailto: &'a str) -> Context<'a> {
            Context { api_key, mailto, cancel: &self.cancel, transport: &*self.transport }
        }
        pub fn urls(&self) -> Vec<Url> {
            self.calls.lock().unwrap().urls.clone()
        }
        pub fn headers(&self) -> Vec<Vec<(String, String)>> {
            self.calls.lock().unwrap().headers.clone()
        }
        pub fn query(url: &Url) -> HashMap<String, String> {
            url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect()
        }
        /// A web search that sends everything here and never sleeps.
        fn search(self) -> (Arc<Mutex<Calls>>, WebSearch) {
            let calls = self.calls.clone();
            (calls, WebSearch::with(providers(), self.transport, Box::new(|_, cancel| !cancel.is_cancelled())))
        }
    }

    fn page_len(page: &WebPage) -> usize {
        page.results.len()
    }

    #[test]
    fn searches_one_provider_caches_and_leaves_turned_off_providers_alone() {
        let (calls, web) = Recorded::routed(|_| (200, fixture("openalex-search.json").to_string())).search();
        let none = WebFilters::default();
        assert_eq!(page_len(&web.search("openalex", "attention", 3, None, &none, None).unwrap()), 3);
        web.search("openalex", "Attention ", 3, None, &none, None).unwrap();
        assert_eq!(calls.lock().unwrap().urls.len(), 1, "the second search is cached");
        web.set_options(&json!({ "providers": { "openalex": { "enabled": false } } }));
        assert!(web.search("openalex", "other", 3, None, &none, None).unwrap_err().contains("turned off"));
        let info = web.providers_info();
        let on: Vec<(String, bool)> = info.as_array().unwrap().iter().map(|p| (p["id"].as_str().unwrap().to_string(), p["enabled"].as_bool().unwrap())).collect();
        // Google Scholar needs a SerpApi key: off without one.
        assert_eq!(on, [("openalex".to_string(), false), ("s2".into(), true), ("scholar".into(), false)]);
        let filters = |id: &str| info.as_array().unwrap().iter().find(|p| p["id"] == id).unwrap()["filters"].clone();
        assert!(filters("openalex").as_array().unwrap().contains(&json!("retracted")));
        assert!(!filters("s2").as_array().unwrap().contains(&json!("retracted")));
    }

    #[test]
    fn checks_what_a_provider_cannot_ask_for_on_its_results() {
        let (calls, web) = Recorded::routed(|_| (200, fixture("s2-search.json").to_string())).search();
        let filters = WebFilters { authors: Some(vec!["Devlin".into()]), ..Default::default() };
        let page = web.search("s2", "language models", 10, None, &filters, None).unwrap();
        assert_eq!(page.results.iter().map(|r| r.authors[0].as_str()).collect::<Vec<_>>(), ["Jacob Devlin"]);
        // Asked for more, since some are left out.
        assert_eq!(Recorded::query(&calls.lock().unwrap().urls[0])["limit"], "20");
    }

    #[test]
    fn leaves_out_a_provider_that_cannot_apply_a_filter_and_says_so() {
        let (calls, web) = Recorded::new(Vec::new()).search();
        let page = web.search("s2", "x y", 10, None, &WebFilters { language: Some("de".into()), ..Default::default() }, None).unwrap();
        assert_eq!(page, WebPage { skipped: Some(vec!["language".into()]), ..Default::default() });
        assert!(calls.lock().unwrap().urls.is_empty());
    }

    #[test]
    fn retries_a_rate_limited_openalex_search_with_the_key() {
        let (calls, web) = Recorded::routed(|url| if url.query().unwrap_or("").contains("api_key=") { (200, fixture("openalex-search.json").to_string()) } else { (429, r#"{"error":"limited"}"#.into()) }).search();
        web.set_options(&json!({ "keys": { "openalex": { "key": "sk-test-abcdefgh9876", "mode": "fallback" } } }));
        let page = web.search("openalex", "attention", 3, None, &WebFilters::default(), None).unwrap();
        assert_eq!(page.results.len(), 3);
        let urls: Vec<String> = calls.lock().unwrap().urls.iter().map(|u| u.to_string()).collect();
        assert!(!urls[0].contains("api_key="), "the first request goes without the key");
        assert_eq!(urls.iter().filter(|u| u.contains("api_key=")).count(), 1);
        let usage = web.take_usage();
        assert_eq!((usage["openalex"]["requests"].as_u64(), usage["openalex"]["failures"].as_u64()), (Some(1), Some(0)));
        assert_eq!(web.take_usage(), json!({}), "reading clears the counts");
    }

    #[test]
    fn falls_back_to_google_scholar_when_a_catalogue_fails_once_per_query() {
        let (calls, web) = Recorded::routed(|url| if url.path().ends_with("search.json") { (200, fixture("serpapi-scholar.json").to_string()) } else { (503, "{}".into()) }).search();
        web.set_options(&json!({ "keys": { "scholar-serpapi": { "key": "serp-key-1234", "mode": "fallback" } } }));
        let info = web.providers_info();
        let scholar = info.as_array().unwrap().iter().find(|p| p["id"] == "scholar").unwrap();
        assert_eq!((scholar["enabled"].as_bool(), scholar["apiKey"].as_bool()), (Some(false), Some(false)));
        let web = Arc::new(web);
        let ask = |id: &'static str| {
            let web = web.clone();
            std::thread::spawn(move || web.search(id, "attention", 20, None, &WebFilters::default(), None).unwrap())
        };
        let (a, b) = (ask("openalex"), ask("s2"));
        let (a, b) = (a.join().unwrap(), b.join().unwrap());
        assert_eq!((a.results[0].provider.as_str(), a.results[0].fallback_for.as_deref()), ("scholar", Some("openalex")));
        assert_eq!(b.results[0].provider, "scholar");
        assert_eq!(calls.lock().unwrap().urls.iter().filter(|u| u.path().ends_with("search.json")).count(), 1);
        let usage = web.take_usage();
        assert_eq!(usage["scholar-serpapi"]["requests"], 1);
    }

    #[test]
    fn a_cancelled_search_says_so() {
        let (_calls, web) = Recorded::routed(|_| (503, "{}".into())).search();
        let web = Arc::new(web);
        let runner = web.clone();
        let handle = std::thread::spawn(move || runner.search("s2", "slow query", 10, None, &WebFilters::default(), Some("r1")));
        std::thread::sleep(Duration::from_millis(5));
        web.cancel("r1");
        // Retries never sleep here, so the search may finish first: then it failed normally.
        let out = handle.join().unwrap().unwrap_err();
        assert!(out == "Cancelled" || out.contains("Semantic Scholar"), "{out}");
    }

    #[test]
    fn tokens_become_the_filters_providers_that_are_on_apply() {
        let web = WebSearch::default();
        let tokens: Vec<FilterToken> = serde_json::from_value(json!([{ "field": "creator", "value": "Vaswani", "op": "contains", "label": "Vaswani" }, { "field": "tag", "value": "x", "label": "x" }, { "field": "language", "value": "de", "label": "de" }])).unwrap();
        let out = web.filters_for(&tokens);
        assert_eq!(out["filters"], json!({ "authors": ["Vaswani"], "language": "de" }));
        assert_eq!(out["keys"], json!(["author", null, "language"]));
        web.set_options(&json!({ "providers": { "openalex": { "enabled": false } } }));
        assert_eq!(web.filters_for(&tokens)["filters"], json!({ "authors": ["Vaswani"] }), "no provider that is on can tell languages");
    }

    struct Shelf(Mutex<Vec<Json>>);
    impl Library for Shelf {
        fn find(&self, text: &str) -> Vec<library::Stored> {
            let needle = text.to_lowercase();
            self.0.lock().unwrap().iter().filter(|s| s.to_string().to_lowercase().contains(&needle)).filter_map(|s| serde_json::from_value(s.clone()).ok()).collect()
        }
        fn source(&self, id: &str) -> Result<Json, String> {
            self.0.lock().unwrap().iter().find(|s| s["id"] == id).cloned().ok_or("gone".into())
        }
        fn create(&self, input: Json) -> Result<Json, String> {
            let mut source = input;
            source["id"] = json!(format!("s{}", self.0.lock().unwrap().len() + 1));
            self.0.lock().unwrap().push(source.clone());
            Ok(source)
        }
    }

    #[test]
    fn adds_a_work_once_with_the_openalex_record_when_asked_to_look_it_up() {
        let work = fixture("openalex-search.json")["results"][1].to_string();
        let (calls, web) = Recorded::routed(move |_| (200, work.clone())).search();
        let shelf = Shelf(Mutex::new(vec![json!({ "id": "s1", "title": "BERT (my copy)", "doi": "https://doi.org/10.18653/V1/N19-1423" })]));
        let page_work = WebResult { provider: "web".into(), title: "A page".into(), doi: Some("10.5555/page".into()), ..Default::default() };
        let added = add_to_library(&web, &shelf, page_work, Some("c1"), true).unwrap();
        // The page's DOI led to OpenAlex's record of BERT, which the library has.
        assert_eq!((added["existed"].as_bool(), added["source"]["id"].as_str()), (Some(true), Some("s1")));
        assert_eq!(calls.lock().unwrap().urls[0].path(), "/works/doi:10.5555/page");
        let fresh = WebResult { provider: "reader".into(), title: "A new work".into(), authors: vec!["Ada Lovelace".into()], year: Some(1843), ..Default::default() };
        let added = add_to_library(&web, &shelf, fresh.clone(), Some("c1"), false).unwrap();
        assert_eq!(added["existed"], false);
        assert_eq!(added["source"]["creators"][0]["family"], "Lovelace");
        assert_eq!(added["source"]["collections"], json!(["c1"]));
        assert_eq!(add_to_library(&web, &shelf, fresh, None, false).unwrap()["existed"], true);
    }
}
