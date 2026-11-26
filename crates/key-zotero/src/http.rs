// A small HTTP/1.1 client for Zotero's local server on 127.0.0.1. Only loopback, one
// request per connection, JSON in and out.
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    time::Duration,
};

#[derive(Debug, PartialEq, Eq)]
pub enum HttpError {
    /// Nothing listens on the port: Zotero is not running.
    Unreachable,
    Other(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::Unreachable => write!(f, "Zotero is not running"),
            HttpError::Other(e) => write!(f, "{e}"),
        }
    }
}

pub struct Response {
    pub status: u16,
    pub body: String,
}

pub fn request(port: u16, method: &str, path: &str, token: Option<&str>, body: Option<&str>, timeout: Duration) -> Result<Response, HttpError> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(1500)).map_err(|_| HttpError::Unreachable)?;
    stream.set_read_timeout(Some(timeout)).map_err(|e| HttpError::Other(e.to_string()))?;
    stream.set_write_timeout(Some(timeout)).map_err(|e| HttpError::Other(e.to_string()))?;
    let body = body.unwrap_or("");
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: Key\r\nAccept: application/json\r\nConnection: close\r\n");
    if let Some(token) = token {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if method != "GET" {
        head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(body.as_bytes())).map_err(|e| HttpError::Other(format!("Could not reach Zotero: {e}")))?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    let mut expected: Option<usize> = None;
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(HttpError::Other(format!("Zotero did not answer: {e}"))),
        }
        if expected.is_none() {
            if let Some(end) = find(&raw, b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&raw[..end]).to_lowercase();
                expected = header(&headers, "content-length").and_then(|v| v.parse::<usize>().ok()).map(|n| end + 4 + n);
            }
        }
        if expected.is_some_and(|n| raw.len() >= n) {
            break;
        }
    }
    parse(&raw)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn header<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
    headers.lines().find_map(|line| line.split_once(':').filter(|(n, _)| n.trim() == name).map(|(_, v)| v.trim()))
}

fn parse(raw: &[u8]) -> Result<Response, HttpError> {
    let end = find(raw, b"\r\n\r\n").ok_or_else(|| HttpError::Other("Zotero sent an incomplete answer.".into()))?;
    let head = String::from_utf8_lossy(&raw[..end]).to_string();
    let status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| HttpError::Other("Zotero sent an unreadable answer.".into()))?;
    let lower = head.to_lowercase();
    let mut body = raw[end + 4..].to_vec();
    if let Some(length) = header(&lower, "content-length").and_then(|v| v.parse::<usize>().ok()) {
        body.truncate(length);
    } else if header(&lower, "transfer-encoding").is_some_and(|v| v.contains("chunked")) {
        body = dechunk(&body);
    }
    Ok(Response { status, body: String::from_utf8_lossy(&body).to_string() })
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(line) = find(data, b"\r\n") {
        let size = usize::from_str_radix(String::from_utf8_lossy(&data[..line]).split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        if size == 0 {
            break;
        }
        let start = line + 2;
        let stop = (start + size).min(data.len());
        out.extend_from_slice(&data[start..stop]);
        data = &data[(stop + 2).min(data.len())..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_length_and_chunked_bodies() {
        let r = parse(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}extra").unwrap();
        assert_eq!((r.status, r.body.as_str()), (200, "{}"));
        let r = parse(b"HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n").unwrap();
        assert_eq!((r.status, r.body.as_str()), (404, "abcde"));
        let r = parse(b"HTTP/1.0 401 Unauthorized\r\n\r\nno").unwrap();
        assert_eq!((r.status, r.body.as_str()), (401, "no"));
    }

    #[test]
    fn nothing_listening_is_unreachable() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert_eq!(request(port, "GET", "/", None, None, Duration::from_secs(1)).err(), Some(HttpError::Unreachable));
    }
}
