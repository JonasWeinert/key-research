// The real transport: key-safe-http (https only, the connector's exact hosts, public addresses,
// bounded size and time, no proxies, redirects only within the connector's hosts).
//
// For tests and smokes, a loopback mock can stand in for every service: with `mock` set
// (KEY_CONNECTORS_MOCK=http://127.0.0.1:PORT), a request for https://host/path?q goes to
// http://127.0.0.1:PORT/host/path?q instead. Only a loopback address is accepted.
use crate::engine::{CancellationToken, Request, Response, Transport, TransportError};
use key_safe_http::{ContentTypePolicy, ContentTypeRule, ExactHostAllowlist, HttpError, HttpLimits, HttpMethod, HttpPolicy, HttpRequest, RateLimit, SafeHttpClient, SchemePolicy};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const USER_AGENT: &str = "Key/0.1 (database search; +https://github.com/key-app)";

pub struct SafeTransport {
    /// A loopback base URL every request is sent to instead (tests and smokes).
    pub mock: Option<url::Url>,
    pub timeout: Duration,
}

impl Default for SafeTransport {
    fn default() -> Self {
        Self::from_env()
    }
}

impl SafeTransport {
    pub fn from_env() -> Self {
        let mock = std::env::var("KEY_CONNECTORS_MOCK").ok().and_then(|v| url::Url::parse(v.trim()).ok()).filter(is_loopback);
        Self { mock, timeout: Duration::from_secs(30) }
    }
}

pub fn is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

fn types(format: &str) -> Result<ContentTypePolicy, HttpError> {
    let exact = |list: &[&str]| list.iter().filter_map(|t| ContentTypeRule::exact(*t).ok()).collect::<Vec<_>>();
    let mut rules = match format {
        "json" => exact(&["application/json", "text/json", "text/javascript", "application/javascript", "text/plain"]),
        "xml" => exact(&["application/xml", "text/xml", "text/plain", "application/oai-pmh+xml"]),
        "csv" => exact(&["text/csv", "text/plain", "application/csv", "application/octet-stream", "application/vnd.ms-excel", "text/comma-separated-values"]),
        _ => exact(&["text/html", "application/xhtml+xml", "text/plain"]),
    };
    match format {
        "json" => rules.extend(ContentTypeRule::structured_suffix("json").ok()),
        "xml" | "html" => rules.extend(ContentTypeRule::structured_suffix("xml").ok()),
        _ => {}
    }
    ContentTypePolicy::new(rules, true)
}

impl Transport for SafeTransport {
    fn send(&self, request: &Request, cancel: &CancellationToken) -> Result<Response, TransportError> {
        if cancel.is_cancelled() {
            return Err(TransportError::Cancelled);
        }
        let host = request.url.host_str().unwrap_or("").to_ascii_lowercase();
        if request.url.scheme() != "https" || !request.hosts.iter().any(|h| h.eq_ignore_ascii_case(&host)) {
            return Err(TransportError::Denied(format!("{} is not allowed for this connector", request.url)));
        }
        if let Some(mock) = &self.mock {
            return loopback(mock, request, cancel, self.timeout);
        }
        let failed = |e: HttpError| match e {
            HttpError::Cancelled => TransportError::Cancelled,
            HttpError::Timeout(_) => TransportError::Timeout,
            HttpError::HostDenied(h) => TransportError::Denied(format!("{h} is not one of this connector's hosts")),
            other => TransportError::Failed(other.to_string()),
        };
        let limits = HttpLimits {
            max_response_bytes: request.max_bytes,
            max_request_bytes: 1024 * 1024,
            max_redirects: 3,
            max_concurrent: 2,
            request_timeout: self.timeout,
            rate: RateLimit::new(600, Duration::from_secs(60)).map_err(failed)?,
            ..HttpLimits::default()
        };
        let policy = HttpPolicy::new(ExactHostAllowlist::new(&request.hosts).map_err(failed)?, types(&request.format).map_err(failed)?)
            .with_schemes(SchemePolicy::HttpsOnly)
            .with_limits(limits)
            .map_err(failed)?;
        let method = if request.method == "POST" { HttpMethod::Post } else { HttpMethod::Get };
        let mut http = HttpRequest::new(method, request.url.as_str()).map_err(failed)?;
        if !request.headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("user-agent")) {
            http = http.with_header("user-agent", USER_AGENT).map_err(failed)?;
        }
        for (name, value) in &request.headers {
            http = http.with_header(name.as_str(), value.as_str()).map_err(failed)?;
        }
        if method == HttpMethod::Post {
            http = http.with_body(request.body.clone()).map_err(failed)?;
        }
        let response = SafeHttpClient::new(policy).execute(http, cancel).map_err(failed)?;
        Ok(Response {
            status: response.status(),
            headers: response.headers().iter().filter_map(|h| Some((h.name().to_string(), h.value_str()?.to_string()))).collect(),
            body: response.body().to_vec(),
        })
    }
}

/// HTTP/1.0 to the loopback mock: `/<host><path>?<query>`.
fn loopback(mock: &url::Url, request: &Request, cancel: &CancellationToken, timeout: Duration) -> Result<Response, TransportError> {
    let failed = |e: std::io::Error| TransportError::Failed(format!("mock: {e}"));
    let ip: std::net::IpAddr = match mock.host() {
        Some(url::Host::Ipv4(ip)) => ip.into(),
        Some(url::Host::Ipv6(ip)) => ip.into(),
        _ => [127, 0, 0, 1].into(),
    };
    let address = SocketAddr::new(ip, mock.port_or_known_default().unwrap_or(80));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(4)).map_err(failed)?;
    stream.set_read_timeout(Some(Duration::from_millis(200))).map_err(failed)?;
    let mut path = format!("/{}{}", request.url.host_str().unwrap_or(""), request.url.path());
    if let Some(q) = request.url.query() {
        path = format!("{path}?{q}");
    }
    let mut head = format!("{} {path} HTTP/1.0\r\nHost: {}\r\nUser-Agent: {USER_AGENT}\r\nContent-Length: {}\r\n", request.method, mock.host_str().unwrap_or(""), request.body.len());
    for (name, value) in &request.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).map_err(failed)?;
    stream.write_all(&request.body).map_err(failed)?;
    let started = Instant::now();
    let mut raw = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err(TransportError::Cancelled);
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() > request.max_bytes + 64 * 1024 {
                    return Err(TransportError::Failed("The answer is too large".into()));
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                if started.elapsed() > timeout {
                    return Err(TransportError::Timeout);
                }
            }
            Err(e) => return Err(failed(e)),
        }
    }
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| TransportError::Failed("mock: unreadable answer".into()))?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut lines = head.split("\r\n");
    let status = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).unwrap_or(500);
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(n, v)| (n.trim().to_string(), v.trim().to_string())).collect();
    Ok(Response { status, headers, body: raw[split + 4..].to_vec() })
}
