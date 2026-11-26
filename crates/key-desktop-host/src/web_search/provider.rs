// A scholarly catalogue web search can ask. To add one: a file next to this one with a type
// that implements `Provider` (openalex.rs is a small example: build the request, map each
// record to a `WebResult` with a parse function tested against a recorded response), then add
// it to `providers()` in mod.rs. Settings (on/off, API key), the Web pill, merging, retries,
// caching, the keyed fallback and "Add to library" pick it up from there. Let its base URL be
// overridden by an environment variable (http::Base::from_env) so smokes can use a mock.
use super::filters::WebFilters;
use super::http::{Base, ProviderError, Transport, json_of};
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
}

impl Context<'_> {
    pub fn get_json(&self, base: &Base, path: &str, query: &[(&str, &str)], headers: &[(&str, &str)], label: &str) -> Result<Json, ProviderError> {
        let url = base.url(path, query).map_err(|e| ProviderError::new(format!("{label}: {e}"), None, false))?;
        json_of((self.transport)(base, &url, headers, self.cancel), label).map(|(value, _)| value)
    }
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
