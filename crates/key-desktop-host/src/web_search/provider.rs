// A scholarly catalogue web search can ask. To add one: a file next to this one with a type
// that implements `Provider` (openalex.rs is a small example: build the request, map each
// record to a `WebResult` with a parse function tested against a recorded response), then add
// it to `providers()` in mod.rs. Settings (on/off, API key), the Web pill, merging, retries,
// caching, the keyed fallback and "Add to library" pick it up from there. Let its base URL be
// overridden by an environment variable (http::Base::from_env) so smokes can use a mock.
//
// General web search engines (Tavily, Firecrawl, Exa, Brave …) are providers too, with
// `engine()` saying so: they are not asked side by side like the catalogues but one at a time
// in the user's order, the next one only when the one before fails (mod.rs, `WebSearch::chain`).
// Their shared helpers (POST, errors, filter mapping) are in engines.rs.
use super::filters::WebFilters;
use super::http::{Base, PostTransport, ProviderError, Transport, json_of, redact};
use super::types::{WebPage, WebResult};
use key_safe_http::CancellationToken;
use serde_json::Value as Json;

/// What a provider is told for one request.
pub struct Context<'a> {
    /// The provider's API key, when this attempt carries it (see http::with_key_fallback).
    pub api_key: Option<&'a str>,
    /// For providers with a polite pool (OpenAlex).
    pub mailto: &'a str,
    pub cancel: &'a CancellationToken,
    pub transport: &'a Transport,
    /// For engines whose API takes a JSON body.
    pub post: &'a PostTransport,
    /// The user's own address for a self-hosted engine (SearXNG), from Settings.
    pub base_url: Option<&'a str>,
    /// Narrow to scholarly sources where the engine can (Settings).
    pub scholarly: bool,
}

impl Context<'_> {
    pub fn get_json(&self, base: &Base, path: &str, query: &[(&str, &str)], headers: &[(&str, &str)], label: &str) -> Result<Json, ProviderError> {
        let url = base.url(path, query).map_err(|e| ProviderError::new(format!("{label}: {e}"), None, false))?;
        json_of((self.transport)(base, &url, headers, self.cancel), label).map(|(value, _)| value).map_err(|e| ProviderError { message: redact(&e.message, self.api_key), ..e })
    }
    pub fn post_json(&self, base: &Base, path: &str, body: &Json, headers: &[(&str, &str)], label: &str) -> Result<Json, ProviderError> {
        let url = base.url(path, &[]).map_err(|e| ProviderError::new(format!("{label}: {e}"), None, false))?;
        let bytes = serde_json::to_vec(body).unwrap_or_default();
        json_of((self.post)(base, &url, headers, &bytes, self.cancel), label).map(|(value, _)| value).map_err(|e| ProviderError { message: redact(&e.message, self.api_key), ..e })
    }
}

/// What makes a provider a general web search engine.
#[derive(Clone, Copy, Debug, Default)]
pub struct Engine {
    /// It can narrow results to scholarly sources (Exa's publications, Firecrawl's research).
    pub scholarly: bool,
    /// It runs at an address the user gives (SearXNG); without one it is off.
    pub base_url: bool,
    /// It can also fetch one page as readable HTML (`read_page`).
    pub reader: bool,
    /// Its largest page of results.
    pub max_results: usize,
    /// The provider's pricing page, for Settings.
    pub pricing_url: &'static str,
}

/// One page read by a reader service (Firecrawl's scrape, Jina Reader).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPage {
    pub provider: String,
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub language: Option<String>,
    /// The page's main content as HTML.
    pub html: String,
}

pub struct SearchRequest<'a> {
    pub limit: usize,
    /// From the previous page.
    pub cursor: Option<&'a str>,
    /// Every filter of the search: the provider applies those in `capabilities().filters` and
    /// may narrow by others; those others are checked on its results (filters::meets).
    pub filters: &'a WebFilters,
}

#[derive(Clone, Copy, Debug)]
pub struct Capabilities {
    /// Takes an API key (Settings shows a field).
    pub api_key: bool,
    pub key_required: bool,
    pub key_help: &'static str,
    /// On unless the user turns it off.
    pub enabled_by_default: bool,
    /// The filters it applies in its own request.
    pub filters: &'static [&'static str],
    /// Its key is managed as this service (Settings → Services & API keys).
    pub service: Option<&'static str>,
}

pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    /// An icon from the renderer's icon set.
    fn icon(&self) -> &'static str;
    fn capabilities(&self) -> Capabilities;
    fn search(&self, query: &str, request: &SearchRequest, cx: &Context) -> Result<WebPage, ProviderError>;
    /// Looks works up by DOI or the provider's own id.
    fn has_lookup(&self) -> bool {
        false
    }
    /// One work by DOI or the provider's own id; none when it has no such work.
    fn lookup(&self, _id: &str, _cx: &Context) -> Result<Option<WebResult>, ProviderError> {
        Err(ProviderError::new(format!("{} cannot look works up", self.label()), None, false))
    }
    /// A general web search engine, asked in the user's order (none for a catalogue).
    fn engine(&self) -> Option<Engine> {
        None
    }
    /// The page at `url` as readable HTML (engines with `reader`).
    fn read_page(&self, _url: &str, _cx: &Context) -> Result<ReadPage, ProviderError> {
        Err(ProviderError::new(format!("{} cannot read pages", self.label()), None, false))
    }
}

/// A path segment as encodeURI leaves it, but with `#`, `?` and spaces escaped.
pub fn encode_path(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~:/()@!$&'*+,;=".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
