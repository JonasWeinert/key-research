// Recorded answers (connectors/fixtures/<id>/<test>.json): a transport that replays them, and
// one that records live answers into that shape. Credentials and contact parameters are never
// written and are ignored when matching.
use crate::engine::{CancellationToken, Request, Response, Transport, TransportError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fixture {
    #[serde(default)]
    pub recorded: String,
    #[serde(default)]
    pub exchanges: Vec<Exchange>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    #[serde(default = "get")]
    pub method: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_body: Option<String>,
    #[serde(default = "ok")]
    pub status: u16,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: String,
}

fn get() -> String {
    "GET".into()
}
fn ok() -> u16 {
    200
}

/// Parameters that never decide which answer is meant.
const IGNORED: &[&str] = &["api_key", "apikey", "apiKey", "insttoken", "email", "mailto", "tool", "key", "token"];

/// host + path + sorted parameters (ignored ones left out).
pub fn match_key(method: &str, url: &url::Url) -> String {
    let mut pairs: Vec<(String, String)> = url.query_pairs().filter(|(k, _)| !IGNORED.contains(&k.as_ref())).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    pairs.sort();
    let query: Vec<String> = pairs.iter().map(|(k, v)| format!("{k}={v}")).collect();
    format!("{} {}{}?{}", method.to_ascii_uppercase(), url.host_str().unwrap_or(""), url.path(), query.join("&"))
}

/// The URL without credential and contact parameters (what a fixture stores).
pub fn clean_url(url: &url::Url) -> String {
    let mut out = url.clone();
    let pairs: Vec<(String, String)> = url.query_pairs().filter(|(k, _)| !IGNORED.contains(&k.as_ref())).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    if pairs.is_empty() {
        out.set_query(None);
    } else {
        out.query_pairs_mut().clear().extend_pairs(pairs);
    }
    out.to_string()
}

pub struct Replay {
    answers: BTreeMap<String, Vec<Exchange>>,
    pub calls: Mutex<Vec<String>>,
}

impl Replay {
    pub fn new(fixtures: &[Fixture]) -> Self {
        let mut answers: BTreeMap<String, Vec<Exchange>> = BTreeMap::new();
        for f in fixtures {
            for e in &f.exchanges {
                if let Ok(url) = url::Url::parse(&e.url) {
                    answers.entry(match_key(&e.method, &url)).or_default().push(e.clone());
                }
            }
        }
        Self { answers, calls: Mutex::default() }
    }
}

impl Transport for Replay {
    fn send(&self, request: &Request, cancel: &CancellationToken) -> Result<Response, TransportError> {
        if cancel.is_cancelled() {
            return Err(TransportError::Cancelled);
        }
        let key = match_key(&request.method, &request.url);
        self.calls.lock().unwrap_or_else(|e| e.into_inner()).push(key.clone());
        let body = String::from_utf8_lossy(&request.body);
        let found = self.answers.get(&key).and_then(|list| list.iter().find(|e| e.request_body.as_deref().is_none_or(|b| b == body)).or(list.first()));
        match found {
            Some(e) => Ok(Response { status: e.status, headers: e.headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect(), body: e.body.clone().into_bytes() }),
            None => Err(TransportError::Failed(format!("no recorded answer for {key}"))),
        }
    }
}

/// Sends through another transport and keeps what came back.
pub struct Recorder {
    inner: Arc<dyn Transport>,
    pub exchanges: Mutex<Vec<Exchange>>,
}

impl Recorder {
    pub fn new(inner: Arc<dyn Transport>) -> Self {
        Self { inner, exchanges: Mutex::default() }
    }

    pub fn fixture(&self) -> Fixture {
        Fixture { recorded: crate::time::format(crate::time::now_secs())[..10].to_string(), exchanges: self.exchanges.lock().unwrap_or_else(|e| e.into_inner()).clone() }
    }
}

impl Transport for Recorder {
    fn send(&self, request: &Request, cancel: &CancellationToken) -> Result<Response, TransportError> {
        let response = self.inner.send(request, cancel)?;
        let keep = ["content-type", "x-ratelimit-remaining"];
        self.exchanges.lock().unwrap_or_else(|e| e.into_inner()).push(Exchange {
            method: request.method.clone(),
            url: clean_url(&request.url),
            request_body: (!request.body.is_empty()).then(|| String::from_utf8_lossy(&request.body).into_owned()),
            status: response.status,
            headers: response.headers.iter().filter(|(k, _)| keep.contains(&k.to_ascii_lowercase().as_str())).map(|(k, v)| (k.to_ascii_lowercase(), v.clone())).collect(),
            body: String::from_utf8_lossy(&response.body).into_owned(),
        });
        Ok(response)
    }
}
