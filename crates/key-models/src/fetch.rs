// Byte ranges of a model file. Public hosts go through the bounded safe client (HTTPS only,
// public addresses, at most 64 MB per response), so a file is fetched in ranges that also
// make resuming natural. A loopback base URL (tests, smokes, a local mirror) gets a plain
// HTTP/1.1 GET instead, as the web search mocks do.
use key_safe_http::{
    CancellationToken, ContentTypePolicy, ContentTypeRule, ExactHostAllowlist, HttpError, HttpLimits, HttpPolicy, HttpRequest,
    RateLimit, SafeHttpClient, SchemePolicy,
};
use std::{
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream},
    time::Duration,
};
use url::Url;

const USER_AGENT: &str = "Key/0.1 (on-device models)";

pub(crate) struct Chunk {
    pub status: u16,
    pub body: Vec<u8>,
    /// Where the bytes came from after redirects (a CDN), reused for the next range.
    pub final_url: String,
    /// The response ended before the bytes it announced (the connection dropped).
    pub truncated: bool,
}

#[derive(Debug)]
pub(crate) enum FetchError {
    /// The network or host could not be reached: worth trying again later.
    Offline(String),
    Failed(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Offline(m) | Self::Failed(m) => f.write_str(m),
        }
    }
}

pub(crate) fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

/// Bytes `start..=end` of `url`.
pub(crate) fn range(url: &str, start: u64, end: u64, timeout: Duration) -> Result<Chunk, FetchError> {
    let parsed = Url::parse(url).map_err(|e| FetchError::Failed(format!("{url}: {e}")))?;
    if is_loopback(&parsed) {
        return loopback_range(&parsed, start, end, timeout);
    }
    safe_range(&parsed, start, end, timeout)
}

fn safe_range(url: &Url, start: u64, end: u64, timeout: Duration) -> Result<Chunk, FetchError> {
    let failed = |e: HttpError| match e {
        HttpError::Resolve(_) | HttpError::Timeout(_) | HttpError::Transport(_) => FetchError::Offline(e.to_string()),
        other => FetchError::Failed(other.to_string()),
    };
    let host = url.host_str().ok_or_else(|| FetchError::Failed("The address has no host".into()))?;
    let rules = ["application", "text", "binary"].into_iter().filter_map(|t| ContentTypeRule::type_wildcard(t).ok());
    let types = ContentTypePolicy::new(rules, true).map_err(failed)?;
    let limits = HttpLimits {
        max_response_bytes: (end - start + 1) as usize + 1024,
        max_redirects: 5,
        max_concurrent: 2,
        connect_timeout: Duration::from_secs(20),
        resolve_timeout: Duration::from_secs(20),
        request_timeout: timeout,
        rate: RateLimit::new(600, Duration::from_secs(60)).map_err(failed)?,
        ..HttpLimits::default()
    };
    // Hugging Face answers a file with a redirect to its CDN; the file's hash is what is
    // trusted, so a redirect to another public host is allowed a few times.
    let mut hosts = vec![host.to_string()];
    loop {
        let policy = HttpPolicy::new(ExactHostAllowlist::new(&hosts).map_err(failed)?, types.clone())
            .with_schemes(SchemePolicy::HttpsOnly)
            .with_limits(limits.clone())
            .map_err(failed)?;
        let request = HttpRequest::get(url.as_str())
            .and_then(|r| r.with_header("range", format!("bytes={start}-{end}")))
            .and_then(|r| r.with_header("user-agent", USER_AGENT))
            .map_err(failed)?;
        match SafeHttpClient::new(policy).execute(request, &CancellationToken::active()) {
            Ok(response) => {
                return Ok(Chunk {
                    status: response.status(),
                    body: response.body().to_vec(),
                    final_url: response.final_url().to_string(),
                    truncated: false,
                });
            }
            Err(HttpError::HostDenied(next)) if hosts.len() < 5 && !hosts.contains(&next) => hosts.push(next),
            Err(error) => return Err(failed(error)),
        }
    }
}

fn loopback_range(url: &Url, start: u64, end: u64, timeout: Duration) -> Result<Chunk, FetchError> {
    let offline = |e: std::io::Error| FetchError::Offline(format!("Couldn't reach {}: {e}", url.host_str().unwrap_or("")));
    let ip: IpAddr = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.into(),
        Some(url::Host::Ipv6(ip)) => ip.into(),
        _ => [127, 0, 0, 1].into(),
    };
    let address = SocketAddr::new(ip, url.port_or_known_default().unwrap_or(80));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5)).map_err(offline)?;
    stream.set_read_timeout(Some(timeout)).map_err(offline)?;
    let path = match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => url.path().to_string(),
    };
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {}\r\nRange: bytes={start}-{end}\r\nUser-Agent: {USER_AGENT}\r\nConnection: close\r\n\r\n",
        url.host_str().unwrap_or("127.0.0.1")
    );
    stream.write_all(request.as_bytes()).map_err(offline)?;
    let mut raw = Vec::new();
    // A dropped connection keeps what arrived, so the next attempt resumes after it.
    let read = stream.read_to_end(&mut raw);
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| match &read {
        Err(e) => FetchError::Offline(format!("Couldn't reach {}: {e}", url.host_str().unwrap_or(""))),
        Ok(_) => FetchError::Failed("The server sent no response".into()),
    })?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let body = raw[split + 4..].to_vec();
    let status = head.split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
    let length = head
        .lines()
        .find_map(|l| l.split_once(':').filter(|(n, _)| n.trim().eq_ignore_ascii_case("content-length")).map(|(_, v)| v.trim().to_string()))
        .and_then(|v| v.parse::<usize>().ok());
    let truncated = length.is_some_and(|n| body.len() < n) || read.is_err();
    Ok(Chunk { status, body, final_url: url.to_string(), truncated })
}
