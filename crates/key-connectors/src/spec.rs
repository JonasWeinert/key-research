// The connector spec (format 1, connectors/SPEC.md) as Rust types, and the checks of meaning
// the JSON Schema cannot express: hosts, templates, paths and adapters.
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema_url: Option<String>,
    pub format: u64,
    pub id: String,
    pub version: String,
    #[serde(default = "default_engine")]
    pub min_engine: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub homepage: String,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default)]
    pub coverage: String,
    #[serde(default)]
    pub terms: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guide: Option<Guide>,
    #[serde(default)]
    pub credentials: Vec<Credential>,
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub politeness: Politeness,
    #[serde(default)]
    pub capabilities: Capabilities,
    #[serde(default)]
    pub options: Vec<OptionSpec>,
    #[serde(default)]
    pub query: QuerySpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<Plan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<Plan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lookup: Option<Plan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual: Option<Manual>,
    #[serde(default)]
    pub tests: Vec<TestSpec>,
}

fn default_engine() -> String {
    "1.0.0".into()
}
fn default_category() -> String {
    "other".into()
}
fn default_kind() -> String {
    "api".into()
}

/// Plain-language help for researchers, shown by the app.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Guide {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coverage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub limits: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tips: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credential {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub required: bool,
    pub secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Politeness {
    #[serde(default = "default_interval")]
    pub min_interval_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_interval_ms_with_key: Option<u64>,
    #[serde(default = "default_retries")]
    pub retries: u32,
    #[serde(default = "default_backoff")]
    pub backoff_ms: u64,
    #[serde(default = "default_max_pages")]
    pub max_pages: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mailto_param: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota: Option<Quota>,
    /// Largest answer accepted (default 8 MB, at most 64 MB).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_response_bytes: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quota {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exhausted_body: Option<String>,
}

fn default_interval() -> u64 {
    1000
}
fn default_retries() -> u32 {
    3
}
fn default_backoff() -> u64 {
    2000
}
fn default_max_pages() -> u32 {
    100
}

impl Default for Politeness {
    fn default() -> Self {
        Self {
            min_interval_ms: default_interval(),
            min_interval_ms_with_key: None,
            retries: default_retries(),
            backoff_ms: default_backoff(),
            max_pages: default_max_pages(),
            mailto_param: None,
            quota: None,
            max_response_bytes: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capabilities {
    #[serde(default = "default_fields")]
    pub fields: Vec<String>,
    #[serde(default)]
    pub phrase: bool,
    #[serde(default)]
    pub truncation: bool,
    #[serde(default)]
    pub proximity: bool,
    #[serde(default = "default_dates")]
    pub dates: String,
    #[serde(default)]
    pub filters: Vec<String>,
    #[serde(default = "default_max_results")]
    pub max_results: u64,
    #[serde(default)]
    pub sort: Vec<String>,
    #[serde(default)]
    pub export_fields: Vec<String>,
}

fn default_fields() -> Vec<String> {
    vec!["all".into()]
}
fn default_dates() -> String {
    "none".into()
}
fn default_max_results() -> u64 {
    1000
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            fields: default_fields(),
            phrase: false,
            truncation: false,
            proximity: false,
            dates: default_dates(),
            filters: Vec::new(),
            max_results: default_max_results(),
            sort: Vec::new(),
            export_fields: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OptionSpec {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub default: String,
    #[serde(default)]
    pub choices: Vec<Choice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    /// The user may type any value (checked against `pattern` when given).
    #[serde(default)]
    pub free: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manual {
    /// A template: `{query}` (translated with the spec's `query`), `{yearFrom?}`, `{yearTo?}`.
    pub url: String,
    #[serde(default)]
    pub steps: Vec<String>,
    #[serde(default)]
    pub export_formats: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_hint: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Replace {
    pub find: String,
    #[serde(default, alias = "replace")]
    pub with: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DateSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_to: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilterSpec {
    #[serde(default = "default_or")]
    pub join: String,
    pub template: String,
    /// Sets this template variable instead of joining into the native query.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub var: Option<String>,
    #[serde(default)]
    pub values: BTreeMap<String, String>,
}

fn default_or() -> String {
    " OR ".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VarSpec {
    pub template: String,
    #[serde(default, rename = "else")]
    pub otherwise: String,
}

/// Proximity: a template (`"\"{text}\"[tiab:~{n}]"`), or the words joined by an operator
/// (`{"wordJoin": " W/{n} "}`), then put in the field.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Proximity {
    Template(String),
    Join {
        #[serde(rename = "wordJoin")]
        word_join: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuerySpec {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    #[serde(default)]
    pub fallback: BTreeMap<String, String>,
    #[serde(default = "default_all")]
    pub default_field: String,
    #[serde(default = "default_phrase")]
    pub phrase: String,
    #[serde(default = "default_text")]
    pub words: String,
    #[serde(default = "default_space")]
    pub word_join: String,
    #[serde(default)]
    pub per_word_field: bool,
    #[serde(default = "default_truncate")]
    pub truncate: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proximity: Option<Proximity>,
    #[serde(default = "default_and")]
    pub and: String,
    #[serde(default = "default_or")]
    pub or: String,
    #[serde(default = "default_not")]
    pub not: String,
    #[serde(default = "default_group")]
    pub group: String,
    #[serde(default = "default_not_style")]
    pub not_style: String,
    #[serde(default)]
    pub escape: Vec<Replace>,
    #[serde(default)]
    pub lowercase_operators: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dates: Option<DateSpec>,
    #[serde(default)]
    pub vars: BTreeMap<String, VarSpec>,
    #[serde(default)]
    pub filters: BTreeMap<String, FilterSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_terms: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_operators: Option<usize>,
    #[serde(default = "default_chunk")]
    pub chunk: String,
    #[serde(default = "default_max_chunks")]
    pub max_chunks: usize,
    #[serde(default)]
    pub local_filter: bool,
}

fn default_mode() -> String {
    "native".into()
}
fn default_all() -> String {
    "all".into()
}
fn default_phrase() -> String {
    "\"{text}\"".into()
}
fn default_text() -> String {
    "{text}".into()
}
fn default_space() -> String {
    " ".into()
}
fn default_truncate() -> String {
    "{text}*".into()
}
fn default_and() -> String {
    " AND ".into()
}
fn default_not() -> String {
    " NOT ".into()
}
fn default_group() -> String {
    "({q})".into()
}
fn default_not_style() -> String {
    "binary".into()
}
fn default_chunk() -> String {
    "none".into()
}
fn default_max_chunks() -> usize {
    20
}

impl Default for QuerySpec {
    fn default() -> Self {
        serde_json::from_value(serde_json::json!({})).expect("defaults")
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestSpec {
    #[serde(default = "default_get")]
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub params: BTreeMap<String, Param>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub form: BTreeMap<String, Param>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Json>,
    #[serde(default = "default_json")]
    pub format: String,
}

/// A parameter: one template, or parts joined (empty parts left out; none: no parameter).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Param {
    Text(String),
    Joined(Joined),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Joined {
    pub join: String,
    pub parts: Vec<String>,
}

impl Param {
    pub fn templates(&self) -> Vec<&str> {
        match self {
            Param::Text(t) => vec![t.as_str()],
            Param::Joined(j) => j.parts.iter().map(String::as_str).collect(),
        }
    }
}

fn default_get() -> String {
    "GET".into()
}
fn default_json() -> String {
    "json".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Paging {
    #[serde(default = "default_none")]
    pub style: String,
    #[serde(default)]
    pub start: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    #[serde(default = "default_true")]
    pub stop_when_fewer: bool,
    #[serde(default)]
    pub stop_when_no_new: bool,
    #[serde(default)]
    pub stop_when_no_local_match: bool,
}

fn default_none() -> String {
    "none".into()
}
fn default_true() -> bool {
    true
}

impl Default for Paging {
    fn default() -> Self {
        Self { style: default_none(), start: 0, first_cursor: None, next: None, stop_when_fewer: true, stop_when_no_new: false, stop_when_no_local_match: false }
    }
}

pub type RecordMap = BTreeMap<String, Extract>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Detail {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<String>,
    #[serde(default = "default_batch")]
    pub batch: usize,
    pub request: RequestSpec,
    /// The records in a detail answer; a per-record detail reads the whole answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items_where: Option<String>,
    pub record: RecordMap,
    /// One request per record (`{record.<field>}`), its fields merged into the record.
    #[serde(default)]
    pub per_record: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<When>,
}

fn default_batch() -> usize {
    100
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct When {
    pub field: String,
    /// Fetch when the field is shorter than this (missing counts as empty).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_length: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sanity {
    pub max_total: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A number, or a template such as "{opt.pageSize}".
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PageSize {
    Fixed(u64),
    Template(String),
}

impl Default for PageSize {
    fn default() -> Self {
        PageSize::Fixed(50)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    #[serde(default = "default_adapter")]
    pub adapter: String,
    pub request: RequestSpec,
    #[serde(default)]
    pub page_size: PageSize,
    #[serde(default)]
    pub paging: Paging,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items_where: Option<String>,
    #[serde(default)]
    pub record: RecordMap,
    /// html-listing: the selector of item links on a listing page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Detail>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sanity: Option<Sanity>,
}

fn default_adapter() -> String {
    "paged".into()
}

/// A path, or a path with operations.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Extract {
    Path(String),
    Rule(Box<Rule>),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub first: Vec<String>,
    #[serde(default)]
    pub all: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drop: Vec<String>,
    /// Splits each value into several (a literal separator, or `re:<regex>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regex: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replace: Vec<Replace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub map: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<NameParts>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// For `extras`: a map of extractors instead of one value.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, Extract>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NameParts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub given: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MustFind {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestSpec {
    pub name: String,
    pub query: Json,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native: Option<String>,
    #[serde(default)]
    pub options: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_results: Option<u64>,
    #[serde(default = "default_pages")]
    pub pages: u32,
    #[serde(default)]
    pub must_find: Vec<MustFind>,
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixture: Option<String>,
    /// Skipped by the live health check (a fixture-only test).
    #[serde(default)]
    pub offline_only: bool,
    /// At most this many records are read (and per-record details fetched) by the test.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_records: Option<usize>,
}

fn default_pages() -> u32 {
    1
}

pub const ADAPTERS: &[&str] = &["paged", "ncbi-history", "oai-pmh", "html-listing"];
pub const FIELDS: &[&str] = &["all", "title", "title_abstract", "abstract", "keywords", "subject", "fulltext", "author", "journal", "affiliation", "identifier"];
pub const RECORD_FIELDS: &[&str] = &[
    "sourceId", "title", "authors", "year", "date", "venue", "series", "number", "publisher", "abstract", "doi", "pmid", "pmcid", "arxiv", "openalex", "handle", "isbn", "issn", "url", "pdfUrl",
    "type", "language", "keywords", "extras",
];
pub const TYPES: &[&str] = &["text", "year", "date", "doi", "int", "url", "language", "inverted-index"];
const KNOWN_VARS: &[&str] = &["query", "pageSize", "offset", "page", "cursor", "token", "ids", "id", "yearFrom", "yearTo", "mailto", "webenv", "queryKey", "link", "q", "text", "n", "v", "from", "to", "value", "field"];
const MAX_SPEC_BYTES: usize = 200 * 1024;

impl Spec {
    /// Reads and checks a spec: the JSON Schema, then the meaning.
    pub fn parse(text: &str) -> Result<Spec, Vec<String>> {
        if text.len() > MAX_SPEC_BYTES {
            return Err(vec![format!("The spec is larger than {} KB", MAX_SPEC_BYTES / 1024)]);
        }
        let value: Json = serde_json::from_str(text).map_err(|e| vec![format!("Not JSON: {e}")])?;
        let problems = crate::schema::validate(&value);
        if !problems.is_empty() {
            return Err(problems);
        }
        let spec: Spec = serde_json::from_value(value).map_err(|e| vec![e.to_string()])?;
        let problems = spec.check();
        if problems.is_empty() { Ok(spec) } else { Err(problems) }
    }

    pub fn credential(&self, id: &str) -> Option<&Credential> {
        self.credentials.iter().find(|c| c.id == id)
    }

    pub fn option_default(&self, id: &str) -> Option<&str> {
        self.options.iter().find(|o| o.id == id).map(|o| o.default.as_str())
    }

    /// The meaning checks (also run by `tools/connectors/validate`).
    pub fn check(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.format != crate::SPEC_FORMAT {
            out.push(format!("Format {} is not supported (this engine reads {})", self.format, crate::SPEC_FORMAT));
        }
        let id_ok = !self.id.is_empty() && self.id.len() <= 64 && self.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !self.id.starts_with('-');
        if !id_ok {
            out.push(format!("Bad id {:?}", self.id));
        }
        if self.version.split('.').count() != 3 || self.version.split('.').any(|p| p.parse::<u64>().is_err()) {
            out.push(format!("Version {:?} is not x.y.z", self.version));
        }
        if !crate::version_at_least(crate::ENGINE_VERSION, &self.min_engine) {
            out.push(format!("Needs engine {} (this is {})", self.min_engine, crate::ENGINE_VERSION));
        }
        for host in &self.hosts {
            if host.is_empty() || host.contains('/') || host.contains(':') || host.contains('*') || host.contains('{') {
                out.push(format!("Host {host:?} must be a plain host name"));
            }
        }
        match self.kind.as_str() {
            "manual" => match &self.manual {
                None => out.push("A manual connector needs `manual`".into()),
                Some(manual) => {
                    if !manual.url.starts_with("https://") {
                        out.push("manual.url must be an https URL".into());
                    }
                    if let Err(e) = crate::template::check(&manual.url) {
                        out.push(format!("manual.url: {e}"));
                    }
                }
            },
            "api" | "harvest" => {
                if self.search.is_none() {
                    out.push("`search` is missing".into());
                }
                if self.hosts.is_empty() {
                    out.push("`hosts` is empty".into());
                }
            }
            other => out.push(format!("Unknown kind {other:?}")),
        }
        if self.kind == "harvest" && self.query.mode != "harvest" {
            out.push("A harvest connector needs query.mode \"harvest\"".into());
        }
        if !["native", "terms", "harvest"].contains(&self.query.mode.as_str()) {
            out.push(format!("Unknown query mode {:?}", self.query.mode));
        }
        if !["none", "or-split", "year-split"].contains(&self.query.chunk.as_str()) {
            out.push(format!("Unknown chunk strategy {:?}", self.query.chunk));
        }
        if !["binary", "andNot", "prefix"].contains(&self.query.not_style.as_str()) {
            out.push(format!("Unknown notStyle {:?}", self.query.not_style));
        }
        if self.politeness.max_response_bytes.is_some_and(|n| n > 64 * 1024 * 1024) {
            out.push("politeness.maxResponseBytes is at most 64 MB".into());
        }
        for option in &self.options {
            if let Some(p) = &option.pattern {
                if regex::Regex::new(p).is_err() {
                    out.push(format!("option {}: bad pattern", option.id));
                }
            }
        }
        if !["none", "year", "day"].contains(&self.capabilities.dates.as_str()) {
            out.push(format!("Unknown capabilities.dates {:?}", self.capabilities.dates));
        }
        for field in self.capabilities.fields.iter().chain(self.query.fields.keys()).chain(self.query.fallback.keys()).chain(self.query.fallback.values()) {
            if !FIELDS.contains(&field.as_str()) {
                out.push(format!("Unknown field {field:?}"));
            }
        }
        if self.query.mode == "native" && !self.query.fields.contains_key(&self.query.default_field) && (self.kind != "manual" || !self.query.fields.is_empty()) {
            out.push(format!("query.fields has no template for the default field {:?}", self.query.default_field));
        }
        for replace in &self.query.escape {
            if replace.find.is_empty() {
                out.push("An empty escape `find`".into());
            }
        }
        let mut templates: Vec<(String, String)> = Vec::new();
        for (name, plan) in [("search", &self.search), ("count", &self.count), ("lookup", &self.lookup)] {
            let Some(plan) = plan else { continue };
            self.check_plan(name, plan, &mut out, &mut templates);
        }
        for (k, v) in &self.query.fields {
            templates.push((format!("query.fields.{k}"), v.clone()));
        }
        for (k, v) in &self.query.vars {
            templates.push((format!("query.vars.{k}"), v.template.clone()));
        }
        if let Some(manual) = &self.manual {
            templates.push(("manual.url".into(), manual.url.clone()));
        }
        for (label, template) in &templates {
            if let Err(e) = crate::template::check(template) {
                out.push(format!("{label}: {e}"));
            }
            for var in crate::template::variables(template) {
                if let Some(cred) = var.strip_prefix("cred.") {
                    if self.credential(cred).is_none() {
                        out.push(format!("{label}: unknown credential {cred}"));
                    }
                } else if let Some(opt) = var.strip_prefix("opt.") {
                    if !self.options.iter().any(|o| o.id == opt) {
                        out.push(format!("{label}: unknown option {opt}"));
                    }
                } else if let Some(field) = var.strip_prefix("record.") {
                    if !label.contains(".detail.") {
                        out.push(format!("{label}: {{{var}}} is only available in a per-record detail"));
                    } else if !RECORD_FIELDS.contains(&field) {
                        out.push(format!("{label}: unknown record field {field}"));
                    }
                } else if !KNOWN_VARS.contains(&var.as_str()) && !self.query.vars.contains_key(&var) && !self.query.filters.values().any(|f| f.var.as_deref() == Some(var.as_str())) {
                    out.push(format!("{label}: unknown variable {{{var}}}"));
                }
            }
        }
        let mut names = std::collections::BTreeSet::new();
        for test in &self.tests {
            if !names.insert(test.name.clone()) {
                out.push(format!("test {}: the name is used twice", test.name));
            }
            if let Err(e) = serde_json::from_value::<crate::query::Query>(test.query.clone()) {
                out.push(format!("test {}: bad query ({e})", test.name));
            }
        }
        out
    }

    fn check_plan(&self, name: &str, plan: &Plan, out: &mut Vec<String>, templates: &mut Vec<(String, String)>) {
        if !ADAPTERS.contains(&plan.adapter.as_str()) {
            out.push(format!("{name}: unknown adapter {:?} (known: {})", plan.adapter, ADAPTERS.join(", ")));
        }
        if !["none", "offset", "page", "cursor", "token"].contains(&plan.paging.style.as_str()) {
            out.push(format!("{name}: unknown paging style {:?}", plan.paging.style));
        }
        if matches!(plan.paging.style.as_str(), "cursor" | "token") && plan.paging.next.is_none() && plan.adapter == "paged" {
            out.push(format!("{name}: {} paging needs `next`", plan.paging.style));
        }
        if plan.adapter == "html-listing" && (plan.links.is_none() || plan.detail.is_none()) {
            out.push(format!("{name}: html-listing needs `links` and `detail`"));
        }
        if plan.adapter == "ncbi-history" && plan.detail.is_none() {
            out.push(format!("{name}: ncbi-history needs `detail` (the efetch request)"));
        }
        if plan.adapter == "oai-pmh" && plan.request.format != "xml" {
            out.push(format!("{name}: oai-pmh answers are xml"));
        }
        match &plan.page_size {
            PageSize::Fixed(n) if *n == 0 || *n > 10_000 => out.push(format!("{name}: pageSize must be 1 to 10000")),
            PageSize::Template(t) => templates.push((format!("{name}.pageSize"), t.clone())),
            _ => {}
        }
        let mut requests = vec![(format!("{name}.request"), &plan.request)];
        // A lookup without its own record reads the search's.
        let record_needed = name == "search" || (name == "lookup" && (!plan.record.is_empty() || plan.detail.is_some()));
        match &plan.detail {
            Some(detail) => {
                requests.push((format!("{name}.detail.request"), &detail.request));
                if detail.per_record {
                    if record_needed && plan.adapter != "html-listing" {
                        check_record(&format!("{name}.record"), &plan.record, out);
                    }
                    for (field, extract) in &detail.record {
                        check_field(&format!("{name}.detail.record"), field, extract, out);
                    }
                } else if plan.adapter == "html-listing" {
                    check_record(&format!("{name}.detail.record"), &detail.record, out);
                } else if record_needed {
                    check_record(&format!("{name}.detail.record"), &detail.record, out);
                    if detail.items.is_none() {
                        out.push(format!("{name}.detail: `items` is required"));
                    }
                }
                for path in [&detail.items, &detail.items_where, &detail.ids].into_iter().flatten() {
                    let format = if Some(path) == detail.ids.as_ref() { &plan.request.format } else { &detail.request.format };
                    check_path(&format!("{name}.detail"), path, format, out);
                }
                if detail.batch == 0 || detail.batch > 10_000 {
                    out.push(format!("{name}.detail: batch must be 1 to 10000"));
                }
            }
            None => {
                if record_needed {
                    check_record(&format!("{name}.record"), &plan.record, out);
                    if plan.items.is_none() {
                        out.push(format!("{name}: `items` is required"));
                    }
                }
            }
        }
        for (label, request) in requests {
            if !["GET", "POST"].contains(&request.method.as_str()) {
                out.push(format!("{label}: method must be GET or POST"));
            }
            if !["json", "xml", "html", "csv"].contains(&request.format.as_str()) {
                out.push(format!("{label}: format must be json, xml, html or csv"));
            }
            if request.method == "GET" && (request.body.is_some() || !request.form.is_empty()) {
                out.push(format!("{label}: a GET has no body"));
            }
            // A per-record or listing detail may start with a variable ({link}, {record.url});
            // the engine still only sends it to `hosts`.
            if !request.url.starts_with('{') {
                match url::Url::parse(&crate::template::blank(&request.url)) {
                    Ok(u) if u.scheme() == "https" => {
                        if let Some(h) = u.host_str() {
                            if !self.hosts.iter().any(|x| x.eq_ignore_ascii_case(h)) {
                                out.push(format!("{label}: host {h} is not in `hosts`"));
                            }
                        }
                        if request.url.split("://").nth(1).and_then(|r| r.split('/').next()).is_some_and(|h| h.contains('{')) {
                            out.push(format!("{label}: the host may not be templated"));
                        }
                    }
                    Ok(_) => out.push(format!("{label}: only https URLs are allowed")),
                    Err(e) => out.push(format!("{label}: bad URL ({e})")),
                }
            }
            templates.push((format!("{label}.url"), request.url.clone()));
            for (k, v) in request.params.iter().chain(&request.form) {
                for t in v.templates() {
                    templates.push((format!("{label}.{k}"), t.to_string()));
                }
            }
            for (k, v) in &request.headers {
                templates.push((format!("{label}.{k}"), v.clone()));
            }
            if let Some(body) = &request.body {
                let mut strings = Vec::new();
                collect_strings(body, &mut strings);
                for s in strings {
                    templates.push((format!("{label}.body"), s));
                }
            }
        }
        for path in [&plan.total, &plan.items, &plan.items_where, &plan.paging.next, &plan.links].into_iter().flatten() {
            check_path(name, path, &plan.request.format, out);
        }
    }
}

fn collect_strings(value: &Json, out: &mut Vec<String>) {
    match value {
        Json::String(s) => out.push(s.clone()),
        Json::Array(a) => a.iter().for_each(|v| collect_strings(v, out)),
        Json::Object(o) => o.values().for_each(|v| collect_strings(v, out)),
        _ => {}
    }
}

fn check_record(label: &str, record: &RecordMap, out: &mut Vec<String>) {
    if !record.contains_key("sourceId") {
        out.push(format!("{label}: `sourceId` is required"));
    }
    if !record.contains_key("title") {
        out.push(format!("{label}: `title` is required"));
    }
    if record.len() > 64 {
        out.push(format!("{label}: more than 64 fields"));
    }
    for (field, extract) in record {
        check_field(label, field, extract, out);
    }
}

fn check_field(label: &str, field: &str, extract: &Extract, out: &mut Vec<String>) {
    if !RECORD_FIELDS.contains(&field) {
        out.push(format!("{label}: unknown record field {field:?}"));
    }
    let Extract::Rule(rule) = extract else { return };
    if rule.path.is_none() && rule.first.is_empty() && rule.default.is_none() && rule.fields.is_empty() {
        out.push(format!("{label}.{field}: needs `path`, `first`, `fields` or `default`"));
    }
    if let Some(re) = &rule.regex {
        if let Err(e) = regex::Regex::new(re) {
            out.push(format!("{label}.{field}: bad regex ({e})"));
        }
    }
    for r in &rule.replace {
        if let Err(e) = regex::Regex::new(&r.find) {
            out.push(format!("{label}.{field}: bad replace regex ({e})"));
        }
    }
    if let Some(kind) = &rule.kind {
        if !TYPES.contains(&kind.as_str()) {
            out.push(format!("{label}.{field}: unknown type {kind:?}"));
        }
    }
    for (name, inner) in &rule.fields {
        if let Extract::Rule(r) = inner {
            if !r.fields.is_empty() {
                out.push(format!("{label}.{field}.{name}: fields cannot nest"));
            }
        }
    }
}

fn check_path(label: &str, path: &str, format: &str, out: &mut Vec<String>) {
    if let Err(e) = crate::paths::check(path, format) {
        out.push(format!("{label}: path {path:?}: {e}"));
    }
}
