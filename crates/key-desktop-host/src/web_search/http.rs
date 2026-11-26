// Requests for web search providers and the library's OpenAlex lookups: JSON over the bounded
// public-HTTPS client (key-safe-http), errors that say whether trying again may help (and when),
// retries with backoff that honour Retry-After, the keyed fallback, and a small cache so paging
// back and forth or retyping a query does not ask again.
//
// A provider's base URL can be pointed at a local mock with an environment variable
// (KEY_WEB_OPENALEX_URL, KEY_WEB_S2_URL, KEY_WEB_SERPAPI_URL), for tests and smokes. Only then,
// and only for a loopback address, does a request leave the safe client: a plain HTTP/1.0
// GET to that port.
use key_safe_http::{CancellationToken, ContentTypePolicy, ExactHostAllowlist, HttpError, HttpLimits, HttpPolicy, HttpRequest, RateLimit, SafeHttpClient, SchemePolicy};
use serde_json::Value as Json;
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use url::Url;

const MAX_BYTES: usize = 8 * 1024 * 1024;
/// Each attempt gets this long; the caller's cancel stops it sooner.
const TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = "Key/0.1 (scholarly web search)";

/// Where a provider's requests go: its public API, or a mock named by an environment variable.
#[derive(Clone, Debug, PartialEq)]
pub struct Base {
    pub url: String,
    /// From the environment: a loopback address here is a test's mock.
    pub overridden: bool,
}

impl Base {
    pub fn from_env(var: &str, default: &str) -> Self {
        match std::env::var(var).ok().map(|v| v.trim().trim_end_matches('/').to_string()).filter(|v| !v.is_empty()) {
            Some(url) => Self { url, overridden: true },
            None => Self { url: default.trim_end_matches('/').into(), overridden: false },
        }
    }

    /// `<base>/<path>?<query>`.
    pub fn url(&self, path: &str, query: &[(&str, &str)]) -> Result<Url, String> {
        let mut url = Url::parse(&format!("{}/{}", self.url, path.trim_start_matches('/'))).map_err(|e| e.to_string())?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        Ok(url)
    }
}

/// What came back.
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
    pub fn retry_after(&self) -> Option<Duration> {
        parse_retry_after(self.header("retry-after"), SystemTime::now())
    }
    /// What is left of the caller's budget, when the service says.
    pub fn remaining(&self) -> Option<u64> {
        self.header("x-ratelimit-remaining").or(self.header("x-ratelimit-remaining-day")).and_then(|v| v.trim().parse().ok())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SendError {
    Cancelled,
    Timeout,
    Failed(String),
}

/// Sends one GET (`send`, or a test's recorded answers).
pub type Transport = dyn Fn(&Base, &Url, &[(&str, &str)], &CancellationToken) -> Result<Response, SendError> + Send + Sync;

/// One GET, through the safe client (or to a test's loopback mock).
pub fn send(base: &Base, url: &Url, headers: &[(&str, &str)], cancel: &CancellationToken) -> Result<Response, SendError> {
    if cancel.is_cancelled() {
        return Err(SendError::Cancelled);
    }
    if base.overridden && is_loopback(url) {
        return loopback_get(url, headers, cancel);
    }
    safe_get(url, headers, cancel)
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

fn safe_get(url: &Url, headers: &[(&str, &str)], cancel: &CancellationToken) -> Result<Response, SendError> {
    let failed = |e: HttpError| match e {
        HttpError::Cancelled => SendError::Cancelled,
        HttpError::Timeout(_) => SendError::Timeout,
        other => SendError::Failed(other.to_string()),
    };
    let host = url.host_str().ok_or_else(|| SendError::Failed("The address has no host".into()))?;
    let limits = HttpLimits {
        max_response_bytes: MAX_BYTES,
        max_redirects: 3,
        max_concurrent: 1,
        request_timeout: TIMEOUT,
        rate: RateLimit::new(30, Duration::from_secs(60)).map_err(failed)?,
        ..HttpLimits::default()
    };
    let policy = HttpPolicy::new(ExactHostAllowlist::new([host]).map_err(failed)?, ContentTypePolicy::json())
        .with_schemes(SchemePolicy::HttpsOnly)
        .with_limits(limits)
        .map_err(failed)?;
    let mut request = HttpRequest::get(url.as_str()).and_then(|r| r.with_header("accept", "application/json")).and_then(|r| r.with_header("user-agent", USER_AGENT)).map_err(failed)?;
    for (name, value) in headers {
        request = request.with_header(*name, *value).map_err(failed)?;
    }
    let response = SafeHttpClient::new(policy).execute(request, cancel).map_err(failed)?;
    Ok(Response {
        status: response.status(),
        headers: response.headers().iter().filter_map(|h| Some((h.name().to_string(), h.value_str()?.to_string()))).collect(),
        body: response.body().to_vec(),
    })
}

/// A plain HTTP/1.0 GET to a loopback mock (tests and smokes only).
fn loopback_get(url: &Url, headers: &[(&str, &str)], cancel: &CancellationToken) -> Result<Response, SendError> {
    let failed = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => SendError::Timeout,
        _ => SendError::Failed(format!("Couldn't reach {}: {e}", url.host_str().unwrap_or(""))),
    };
    let ip: IpAddr = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.into(),
        Some(url::Host::Ipv6(ip)) => ip.into(),
        _ => [127, 0, 0, 1].into(),
    };
    let address = SocketAddr::new(ip, url.port_or_known_default().unwrap_or(80));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(4)).map_err(failed)?;
    stream.set_read_timeout(Some(Duration::from_millis(200))).map_err(failed)?;
    let mut path = url.path().to_string();
    if let Some(query) = url.query() {
        path = format!("{path}?{query}");
    }
    let mut head = format!("GET {path} HTTP/1.0\r\nHost: {}\r\nAccept: application/json\r\nUser-Agent: {USER_AGENT}\r\n", url.host_str().unwrap_or(""));
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).map_err(failed)?;
    let started = Instant::now();
    let mut raw = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err(SendError::Cancelled);
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() > MAX_BYTES {
                    return Err(SendError::Failed("The answer is too large".into()));
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                if started.elapsed() > TIMEOUT {
                    return Err(SendError::Timeout);
                }
            }
            Err(e) => return Err(failed(e)),
        }
    }
    parse_http(&raw).ok_or_else(|| SendError::Failed("The mock sent an unreadable answer".into()))
}

fn parse_http(raw: &[u8]) -> Option<Response> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(n, v)| (n.trim().to_string(), v.trim().to_string())).collect();
    let mut body = raw[split + 4..].to_vec();
    if headers.iter().any(|(n, v)| n.eq_ignore_ascii_case("transfer-encoding") && v.eq_ignore_ascii_case("chunked")) {
        let mut out = Vec::new();
        let mut rest = &body[..];
        while let Some(end) = rest.windows(2).position(|w| w == b"\r\n") {
            let size = usize::from_str_radix(std::str::from_utf8(&rest[..end]).ok()?.split(';').next()?.trim(), 16).ok()?;
            if size == 0 {
                break;
            }
            out.extend_from_slice(rest.get(end + 2..end + 2 + size)?);
            rest = rest.get(end + 4 + size..)?;
        }
        body = out;
    }
    Some(Response { status, headers, body })
}

/// Retry-After as seconds or an HTTP date (IMF-fixdate).
pub fn parse_retry_after(value: Option<&str>, now: SystemTime) -> Option<Duration> {
    let value = value?.trim();
    if let Ok(seconds) = value.parse::<f64>() {
        return Some(Duration::from_secs_f64(seconds.max(0.0)));
    }
    // "Sun, 06 Nov 1994 08:49:37 GMT"
    let parts: Vec<&str> = value.split_whitespace().collect();
    let [_, day, month, year, time, _] = parts.as_slice() else { return None };
    let month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].iter().position(|m| m.eq_ignore_ascii_case(month))? as i64 + 1;
    let (day, year): (i64, i64) = (day.parse().ok()?, year.parse().ok()?);
    let hms: Vec<i64> = time.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let [h, m, s] = hms.as_slice() else { return None };
    // Days from the civil date (Howard Hinnant's algorithm).
    let (y, mo) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * mo + 2) / 5 + day - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    let at = days * 86400 + h * 3600 + m * 60 + s;
    let now = now.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    Some(Duration::from_secs((at - now).max(0) as u64))
}

/// Why a provider gave no answer. `transient` errors are worth another try.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderError {
    pub message: String,
    pub status: Option<u16>,
    pub transient: bool,
    /// From Retry-After, when the provider said.
    pub retry_after: Option<Duration>,
    pub cancelled: bool,
    pub timeout: bool,
}

impl ProviderError {
    pub fn new(message: impl Into<String>, status: Option<u16>, transient: bool) -> Self {
        Self { message: message.into(), status, transient, retry_after: None, cancelled: false, timeout: false }
    }
    pub fn cancelled() -> Self {
        Self { cancelled: true, ..Self::new("Cancelled", None, false) }
    }
}

/// The answer as JSON, or why there is none, in words for the user.
pub fn json_of(answer: Result<Response, SendError>, label: &str) -> Result<(Json, Response), ProviderError> {
    let response = match answer {
        Ok(response) => response,
        Err(SendError::Cancelled) => return Err(ProviderError::cancelled()),
        Err(SendError::Timeout) => return Err(ProviderError { timeout: true, ..ProviderError::new(format!("Couldn't reach {label}"), None, true) }),
        Err(SendError::Failed(_)) => return Err(ProviderError::new(format!("Couldn't reach {label}"), None, true)),
    };
    let status = response.status;
    if (200..300).contains(&status) {
        let value = serde_json::from_slice(&response.body).map_err(|_| ProviderError::new(format!("{label} sent an unreadable answer"), Some(status), true))?;
        return Ok((value, response));
    }
    let retry_after = response.retry_after();
    Err(match status {
        429 => ProviderError { retry_after, ..ProviderError::new(format!("{label} is limiting requests"), Some(429), true) },
        500.. => ProviderError { retry_after, ..ProviderError::new(format!("{label} is not answering (HTTP {status})"), Some(status), true) },
        401 | 403 => ProviderError::new(format!("{label} refused the API key"), Some(status), false),
        _ => ProviderError::new(format!("{label} returned HTTP {status}"), Some(status), false),
    })
}

#[derive(Clone, Copy, Debug)]
pub struct Retry {
    pub attempts: usize,
    /// First backoff; doubled each time.
    pub base: Duration,
    /// A Retry-After longer than this is not waited for: the error goes to the user.
    pub max_wait: Duration,
}

impl Retry {
    pub fn search() -> Self {
        let max = std::env::var("KEY_WEB_MAX_RETRY_WAIT_MS").ok().and_then(|v| v.parse().ok()).filter(|v| *v > 0).unwrap_or(10_000);
        Self { attempts: 3, base: Duration::from_secs(1), max_wait: Duration::from_millis(max) }
    }
    pub fn lookup() -> Self {
        Self { attempts: 2, base: Duration::from_secs(1), max_wait: Duration::from_secs(5).min(Self::search().max_wait) }
    }
}

/// Waits, or answers false at once when cancelled.
pub fn wait(duration: Duration, cancel: &CancellationToken) -> bool {
    let until = Instant::now() + duration;
    while Instant::now() < until {
        if cancel.is_cancelled() {
            return false;
        }
        std::thread::sleep((until - Instant::now()).min(Duration::from_millis(25)));
    }
    !cancel.is_cancelled()
}

/// Runs `task` again after transient errors: 1 s, 2 s … or what Retry-After asks, if not too long.
pub fn with_retry<T>(retry: Retry, cancel: &CancellationToken, sleep: &dyn Fn(Duration, &CancellationToken) -> bool, mut task: impl FnMut() -> Result<T, ProviderError>) -> Result<T, ProviderError> {
    let mut delay = retry.base;
    for attempt in 1.. {
        match task() {
            Ok(value) => return Ok(value),
            Err(error) => {
                if cancel.is_cancelled() || error.cancelled || !error.transient || attempt >= retry.attempts {
                    return Err(error);
                }
                let ms = error.retry_after.unwrap_or(delay);
                if ms > retry.max_wait {
                    return Err(error);
                }
                if !sleep(ms, cancel) {
                    return Err(ProviderError::cancelled());
                }
                delay *= 2;
            }
        }
    }
    unreachable!()
}

/// Whether the same request with a key could succeed where the keyless one did not.
pub fn key_can_help(error: &ProviderError) -> bool {
    !error.cancelled && (matches!(error.status, Some(429 | 401 | 402 | 403)) || error.transient || error.timeout)
}

/// What one request with the user's key came to, counted for Settings.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub ok: bool,
    pub error: Option<String>,
    pub invalid: bool,
}

/// The owner's rule for user-supplied keys: they are a fallback. A request goes out without
/// the key first; only when that fails in a way a key can help with (rate limited, over the
/// shared quota, refused, or still unreachable after the usual retries) is it sent again with
/// the key. "Always use" sends the key from the start.
pub fn with_key_fallback<T>(key: Option<&str>, always: bool, cancel: &CancellationToken, record: &dyn Fn(Outcome), run: &dyn Fn(Option<&str>) -> Result<T, ProviderError>) -> Result<T, ProviderError> {
    let Some(key) = key.map(str::trim).filter(|k| !k.is_empty()) else { return run(None) };
    if !always {
        match run(None) {
            Ok(value) => return Ok(value),
            Err(error) if cancel.is_cancelled() || !key_can_help(&error) => return Err(error),
            Err(_) => {}
        }
    }
    match run(Some(key)) {
        Ok(value) => {
            record(Outcome { ok: true, error: None, invalid: false });
            Ok(value)
        }
        Err(error) => {
            if !cancel.is_cancelled() && !error.cancelled {
                record(Outcome { ok: false, error: Some(error.message.clone()), invalid: matches!(error.status, Some(401 | 403)) });
            }
            Err(error)
        }
    }
}

/// An error never quotes a key (a URL in a message would carry it).
pub fn redact(message: &str, key: Option<&str>) -> String {
    match key.filter(|k| !k.is_empty()) {
        Some(key) => message.replace(key, "••••"),
        None => message.to_string(),
    }
}

/// A few minutes of answers, newest kept.
pub struct TtlCache<T> {
    entries: Mutex<(u64, HashMap<String, (Instant, u64, T)>)>,
    ttl: Duration,
    size: usize,
}

impl<T: Clone> TtlCache<T> {
    pub fn new(ttl: Duration, size: usize) -> Self {
        Self { entries: Mutex::new((0, HashMap::new())), ttl, size }
    }
    pub fn get(&self, key: &str) -> Option<T> {
        let mut guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let (clock, entries) = &mut *guard;
        let (at, used, value) = entries.get_mut(key)?;
        if at.elapsed() > self.ttl {
            entries.remove(key);
            return None;
        }
        *clock += 1;
        *used = *clock;
        Some(value.clone())
    }
    pub fn set(&self, key: String, value: T) {
        let mut guard = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let (clock, entries) = &mut *guard;
        *clock += 1;
        entries.insert(key, (Instant::now(), *clock, value));
        while entries.len() > self.size {
            let oldest = entries.iter().min_by_key(|(_, (_, used, _))| *used).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => entries.remove(&k),
                None => break,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(status: u16, headers: &[(&str, &str)], body: &str) -> Result<Response, SendError> {
        Ok(Response { status, headers: headers.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect(), body: body.as_bytes().to_vec() })
    }

    #[test]
    fn reads_retry_after_in_seconds_and_as_a_date() {
        let now = UNIX_EPOCH + Duration::from_secs(4);
        assert_eq!(parse_retry_after(Some("3"), now), Some(Duration::from_secs(3)));
        assert_eq!(parse_retry_after(Some("Thu, 01 Jan 1970 00:00:10 GMT"), now), Some(Duration::from_secs(6)));
        assert_eq!(parse_retry_after(None, now), None);
    }

    #[test]
    fn turns_429_and_5xx_into_transient_errors_with_their_wait() {
        let limited = json_of(response(429, &[("Retry-After", "2")], "{}"), "X").unwrap_err();
        assert_eq!((limited.status, limited.transient, limited.retry_after), (Some(429), true, Some(Duration::from_secs(2))));
        assert!(!json_of(response(403, &[], ""), "X").unwrap_err().transient);
        let down = json_of(Err(SendError::Failed("fetch failed".into())), "X").unwrap_err();
        assert_eq!((down.transient, down.message.as_str()), (true, "Couldn't reach X"));
        assert!(json_of(Err(SendError::Cancelled), "X").unwrap_err().cancelled);
    }

    #[test]
    fn backs_off_honours_retry_after_then_gives_up() {
        let waits = Mutex::new(Vec::new());
        let sleep = |d: Duration, _: &CancellationToken| {
            waits.lock().unwrap().push(d.as_millis());
            true
        };
        let cancel = CancellationToken::active();
        let retry = Retry { attempts: 3, base: Duration::from_millis(100), max_wait: Duration::from_secs(10) };
        let mut calls = 0;
        let out = with_retry(retry, &cancel, &sleep, || {
            calls += 1;
            match calls {
                1 => Err(ProviderError { retry_after: Some(Duration::from_millis(1500)), ..ProviderError::new("busy", Some(429), true) }),
                2 => Err(ProviderError::new("busy", Some(503), true)),
                _ => Ok("ok"),
            }
        });
        assert_eq!(out, Ok("ok"));
        assert_eq!(*waits.lock().unwrap(), vec![1500, 200]);
        let two = Retry { attempts: 2, base: Duration::from_millis(1), ..retry };
        assert_eq!(with_retry::<()>(two, &cancel, &sleep, || Err(ProviderError::new("down", Some(500), true))).unwrap_err().message, "down");
        // Not transient, or a wait too long to sit through: no retry.
        let mut tries = 0;
        let _ = with_retry::<()>(Retry::search(), &cancel, &sleep, || {
            tries += 1;
            Err(ProviderError::new("no", Some(400), false))
        });
        let _ = with_retry::<()>(Retry::search(), &cancel, &sleep, || {
            tries += 1;
            Err(ProviderError { retry_after: Some(Duration::from_secs(3600)), ..ProviderError::new("daily budget", Some(429), true) })
        });
        assert_eq!(tries, 2);
    }

    #[test]
    fn stops_when_cancelled() {
        let source = key_safe_http::CancellationSource::new();
        let cancel = source.token();
        source.cancel();
        let out = with_retry::<()>(Retry::search(), &cancel, &wait, || Err(ProviderError::new("busy", Some(429), true)));
        assert!(out.is_err());
        assert!(!wait(Duration::from_secs(10), &cancel));
    }

    #[test]
    fn asks_without_the_key_first_and_with_it_only_when_that_could_help() {
        let cancel = CancellationToken::active();
        let keys = Mutex::new(Vec::new());
        let outcomes = Mutex::new(Vec::new());
        let record = |o: Outcome| outcomes.lock().unwrap().push(o);
        let limited = |k: Option<&str>| {
            keys.lock().unwrap().push(k.map(String::from));
            if k.is_none() { Err(ProviderError::new("limited", Some(429), true)) } else { Ok("ok") }
        };
        assert_eq!(with_key_fallback(Some("KEY"), false, &cancel, &record, &limited), Ok("ok"));
        assert_eq!(*keys.lock().unwrap(), vec![None, Some("KEY".to_string())]);
        assert_eq!(outcomes.lock().unwrap()[0].ok, true);
        keys.lock().unwrap().clear();
        let not_found = |k: Option<&str>| -> Result<(), ProviderError> {
            keys.lock().unwrap().push(k.map(String::from));
            Err(ProviderError::new("404", Some(404), false))
        };
        assert!(with_key_fallback(Some("KEY"), false, &cancel, &record, &not_found).is_err());
        assert_eq!(keys.lock().unwrap().len(), 1);
        // Always: the key from the start; a refused key is counted as invalid.
        outcomes.lock().unwrap().clear();
        keys.lock().unwrap().clear();
        let refused = |k: Option<&str>| -> Result<(), ProviderError> {
            keys.lock().unwrap().push(k.map(String::from));
            Err(ProviderError::new("refused", Some(403), false))
        };
        assert!(with_key_fallback(Some("KEY"), true, &cancel, &record, &refused).is_err());
        assert_eq!(*keys.lock().unwrap(), vec![Some("KEY".to_string())]);
        assert!(outcomes.lock().unwrap()[0].invalid);
    }

    #[test]
    fn knows_which_errors_a_key_helps_with() {
        assert!(key_can_help(&ProviderError::new("x", Some(429), true)));
        assert!(key_can_help(&ProviderError::new("x", Some(403), false)));
        assert!(key_can_help(&ProviderError::new("x", None, true)));
        assert!(!key_can_help(&ProviderError::new("x", Some(404), false)));
        assert!(key_can_help(&ProviderError { timeout: true, ..ProviderError::new("t", None, false) }));
        assert!(!key_can_help(&ProviderError::cancelled()));
    }

    #[test]
    fn caches_for_a_while() {
        let cache = TtlCache::new(Duration::from_secs(1), 2);
        cache.set("a".into(), 1);
        cache.set("b".into(), 2);
        cache.set("c".into(), 3);
        assert_eq!(cache.get("a"), None);
        assert_eq!(cache.get("c"), Some(3));
    }

    #[test]
    fn reads_a_mock_answer_plain_or_chunked() {
        let plain = parse_http(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nRetry-After: 2\r\n\r\n{\"a\":1}").unwrap();
        assert_eq!((plain.status, plain.body.as_slice(), plain.retry_after()), (200, &b"{\"a\":1}"[..], Some(Duration::from_secs(2))));
        let chunked = parse_http(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n4\r\n\":1}\r\n0\r\n\r\n").unwrap();
        assert_eq!(chunked.body, b"{\"a\":1}");
    }

    #[test]
    fn a_mock_is_reached_only_through_an_override() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(request.starts_with("GET /works?search=a+b HTTP/1.0"));
            assert!(request.contains("x-api-key: k"));
            stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true}").unwrap();
        });
        let base = Base { url: format!("http://127.0.0.1:{port}"), overridden: true };
        let url = base.url("works", &[("search", "a b")]).unwrap();
        let (value, _) = json_of(send(&base, &url, &[("x-api-key", "k")], &CancellationToken::active()), "Mock").unwrap();
        assert_eq!(value["ok"], true);
        // Without the override, loopback is refused like any private address.
        let plain = Base { overridden: false, ..base };
        assert!(send(&plain, &url, &[], &CancellationToken::active()).is_err());
    }
}
