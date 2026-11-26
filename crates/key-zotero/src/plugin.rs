// Sync through the Key Sync Zotero plugin (integrations/zotero-key-sync). The plugin journals
// every change in Zotero; Key asks for the changes since the last one it applied, fetches
// the items they touch into a local mirror (zotero-sync.sqlite), and runs the same merge
// as the import over the mirror. Applying a batch twice gives the same mirror, so a failed
// run is simply repeated.
use crate::{
    ImportOptions, ImportReport, Progress, Result,
    http::{self, HttpError},
    snapshot::{self, Snapshot, Stamp, ZAnnotation, ZAttachment, ZCollection, ZItem, ZNote},
    state::State,
    sync::{self, Mode},
};
use key_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

pub const DEFAULT_PORT: u16 = 23119;
const FETCH_CHUNK: usize = 200;
const PAGE: usize = 200;
/// How often the whole mirror is checked against Zotero's item list, for changes the
/// journal could not record (the plugin was off).
const RECONCILE_EVERY: Duration = Duration::from_secs(30 * 60);

// ── Protocol ────────────────────────────────────────────

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Record {
    pub key: String,
    #[serde(rename = "libraryID")]
    pub library_id: Option<i64>,
    pub item_type: String,
    pub date_added: String,
    pub date_modified: String,
    /// Changes whenever the item or anything inside it changes (see the plugin's versions).
    pub stamp: String,
    pub deleted: bool,
    pub fields: BTreeMap<String, Json>,
    pub creators: Vec<PCreator>,
    pub tags: Vec<String>,
    pub collections: Vec<String>,
    pub attachments: Vec<PAttachment>,
    pub notes: Vec<PNote>,
    /// A standalone note.
    pub note: Option<PNote>,
    /// A standalone file.
    pub attachment: Option<PAttachment>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PCreator {
    pub creator_type: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PAttachment {
    pub key: String,
    pub title: String,
    pub content_type: String,
    pub link_mode: Option<i64>,
    pub path: Option<String>,
    pub annotations: Vec<PAnnotation>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PAnnotation {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: i64,
    pub text: String,
    pub comment: String,
    pub color: String,
    pub page_index: Option<i64>,
    pub sort_index: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PNote {
    pub key: String,
    pub title: String,
    pub html: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PCollection {
    pub key: String,
    pub name: String,
    pub parent_key: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Change {
    pub seq: i64,
    pub kind: String,
    pub op: String,
    pub key: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Library {
    #[serde(rename = "libraryID")]
    pub library_id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

/// How Key talks to the plugin; the tests use an in-memory one.
pub trait Transport {
    fn call(&self, method: &str, path: &str, body: Option<&Json>) -> std::result::Result<Json, Failure>;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Connection {
    /// Paired and answering.
    Ok,
    /// Nothing answers on Zotero's port.
    NotRunning,
    /// Zotero answers, but without the Key Sync plugin.
    PluginMissing,
    /// The plugin refuses the pairing code.
    Unpaired,
    Error,
    /// No sync set up, or paused.
    Off,
    Paused,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub connection: Connection,
    pub message: String,
}

impl Failure {
    fn error(message: impl Into<String>) -> Failure {
        Failure { connection: Connection::Error, message: message.into() }
    }
}

impl From<String> for Failure {
    fn from(message: String) -> Failure {
        Failure::error(message)
    }
}

pub struct HttpTransport {
    pub port: u16,
    pub token: Option<String>,
}

impl Transport for HttpTransport {
    fn call(&self, method: &str, path: &str, body: Option<&Json>) -> std::result::Result<Json, Failure> {
        let body = body.map(Json::to_string);
        let response = http::request(self.port, method, &format!("/key-sync/{path}"), self.token.as_deref(), body.as_deref(), Duration::from_secs(60)).map_err(|e| match e {
            HttpError::Unreachable => Failure { connection: Connection::NotRunning, message: "Zotero is not running.".into() },
            HttpError::Other(message) => Failure::error(message),
        })?;
        match response.status {
            200 => serde_json::from_str(&response.body).map_err(|e| Failure::error(format!("Zotero sent an unreadable answer: {e}"))),
            401 => Err(Failure { connection: Connection::Unpaired, message: "Zotero did not accept the pairing code.".into() }),
            404 => Err(Failure { connection: Connection::PluginMissing, message: "The Key Sync plugin is not installed in Zotero.".into() }),
            status => Err(Failure::error(format!("Zotero answered {status}: {}", response.body.chars().take(200).collect::<String>()))),
        }
    }
}

// ── Configuration and status ───────────────────────────

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    pub paused: bool,
    pub port: Option<u16>,
    pub token: Option<String>,
    #[serde(rename = "libraryID")]
    pub library_id: Option<i64>,
    pub options: ImportOptions,
    pub created_at: i64,
}

/// What the settings show about the sync.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Status {
    pub configured: bool,
    pub paused: bool,
    pub connection: Option<Connection>,
    pub message: Option<String>,
    /// Last time Zotero answered and Key was up to date with it.
    pub checked_at: Option<i64>,
    /// Last time changes from Zotero were applied.
    pub synced_at: Option<i64>,
    pub plugin_version: Option<String>,
    pub zotero_version: Option<String>,
    #[serde(rename = "libraryID")]
    pub library_id: Option<i64>,
    pub library_name: Option<String>,
    pub options: Option<ImportOptions>,
    pub items: usize,
    pub report: Option<ImportReport>,
    // Where the journal was read up to.
    pub epoch: Option<String>,
    pub seq: i64,
    /// The scope the mirror was filled for; another scope fetches again.
    pub scope: Option<Json>,
}

fn config(state: &State) -> Option<Config> {
    state.meta("pluginConfig").and_then(|c| serde_json::from_str(&c).ok())
}

fn status_of(state: &State) -> Status {
    state.meta("pluginStatus").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_status(state: &State, status: &Status) -> Result<()> {
    state.set_meta("pluginStatus", &serde_json::to_string(status).map_err(|e| e.to_string())?)
}

/// The sync's settings and state, without the pairing code.
pub fn status(store: &Store) -> Result<Status> {
    let state = State::open(store.root())?;
    let mut status = status_of(&state);
    match config(&state) {
        Some(config) if config.enabled => {
            status.configured = true;
            status.paused = config.paused;
            status.options = Some(config.options);
            if config.paused {
                status.connection = Some(Connection::Paused);
            }
        }
        _ => status = Status { connection: Some(Connection::Off), ..Default::default() },
    }
    Ok(status)
}

/// Whether a plugin sync is set up for this library (the database sync then stands aside).
pub fn configured(store: &Store) -> bool {
    State::open(store.root()).ok().and_then(|s| config(&s)).is_some_and(|c| c.enabled)
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Configure {
    pub options: Option<ImportOptions>,
    pub token: Option<String>,
    pub port: Option<u16>,
    #[serde(rename = "libraryID")]
    pub library_id: Option<i64>,
    pub paused: Option<bool>,
    /// Stops syncing. What came from Zotero stays in Key.
    pub remove: bool,
}

pub fn configure(store: &Store, args: Configure) -> Result<Status> {
    let mut state = State::open(store.root())?;
    if args.remove {
        state.clear_meta("pluginConfig")?;
        state.clear_meta("pluginStatus")?;
        state.save_plugin_items(&[], &[], true)?;
        return status(store);
    }
    let mut config = config(&state).unwrap_or_else(|| Config { created_at: key_store::now_ms(), ..Default::default() });
    config.enabled = true;
    if let Some(mut options) = args.options {
        options.data_dir = None;
        options.collections = None;
        options.unlink_outside_scope = true;
        config.options = options;
    }
    if let Some(token) = args.token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        config.token = Some(token);
    }
    if args.port.is_some() {
        config.port = args.port;
    }
    if args.library_id.is_some() {
        config.library_id = args.library_id;
    }
    if let Some(paused) = args.paused {
        config.paused = paused;
    }
    state.set_meta("pluginConfig", &serde_json::to_string(&config).map_err(|e| e.to_string())?)?;
    status(store)
}

/// Zotero's local server port: KEY_ZOTERO_PORT, then Zotero's pref, then 23119.
pub fn port(config: Option<u16>) -> u16 {
    config
        .or_else(|| std::env::var("KEY_ZOTERO_PORT").ok().and_then(|p| p.parse().ok()))
        .or_else(|| crate::pref_int("extensions.zotero.httpServer.port").and_then(|p| u16::try_from(p).ok()))
        .unwrap_or(DEFAULT_PORT)
}

/// The pairing code the plugin saved to Zotero's prefs.js.
pub fn discovered_token() -> Option<String> {
    crate::pref("extensions.key-sync.token").filter(|t| t.len() >= 32)
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub connection: Option<Connection>,
    pub message: Option<String>,
    pub plugin_version: Option<String>,
    pub zotero_version: Option<String>,
    pub libraries: Vec<Library>,
    #[serde(rename = "defaultLibraryID")]
    pub default_library_id: Option<i64>,
    /// Where a working pairing code came from: "given", "saved" or "found".
    pub token_source: Option<String>,
}

/// Whether Zotero runs, has the plugin, and accepts a pairing code (the given one, the
/// saved one or the one in Zotero's prefs).
pub fn probe(store: Option<&Store>, port_override: Option<u16>, token: Option<String>) -> Probe {
    let saved = store.and_then(|s| State::open(s.root()).ok()).and_then(|s| config(&s));
    let port = port(port_override.or(saved.as_ref().and_then(|c| c.port)));
    let open = HttpTransport { port, token: None };
    let hello = match open.call("GET", "handshake", None) {
        Ok(hello) => hello,
        Err(failure) => return Probe { connection: Some(failure.connection), message: Some(failure.message), ..Default::default() },
    };
    let mut probe = Probe {
        plugin_version: hello["version"].as_str().map(String::from),
        zotero_version: hello["zotero"].as_str().map(String::from),
        ..Default::default()
    };
    let candidates = [
        ("given", token.filter(|t| !t.trim().is_empty()).map(|t| t.trim().to_string())),
        ("saved", saved.and_then(|c| c.token)),
        ("found", discovered_token()),
    ];
    for (source, candidate) in candidates {
        let Some(candidate) = candidate else { continue };
        let paired = HttpTransport { port, token: Some(candidate) }.call("GET", "handshake", None);
        if let Some(hello) = paired.ok().filter(|h| h["paired"] == Json::Bool(true)) {
            probe.connection = Some(Connection::Ok);
            probe.token_source = Some(source.into());
            probe.libraries = serde_json::from_value(hello["libraries"].clone()).unwrap_or_default();
            probe.default_library_id = hello["defaultLibraryID"].as_i64();
            return probe;
        }
    }
    probe.connection = Some(Connection::Unpaired);
    probe.message = Some("Key needs the pairing code from Zotero → Settings → Key Sync.".into());
    probe
}

// ── Mirror ──────────────────────────────────────────────

/// Zotero as last fetched from the plugin: collections and top-level items (with their
/// files, notes and annotations), in and around the sync's scope.
#[derive(Clone, Debug, Default)]
pub struct Mirror {
    pub collections: Vec<PCollection>,
    pub items: BTreeMap<String, Record>,
    changed: BTreeSet<String>,
    removed: BTreeSet<String>,
    replaced: bool,
}

/// What a batch of changes asks for.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    pub fetch: BTreeSet<String>,
    pub remove: BTreeSet<String>,
    pub collections: bool,
    /// Something changed that touches unknown items (a tag renamed everywhere).
    pub everything: bool,
}

impl Mirror {
    pub fn load(state: &State) -> Result<Mirror> {
        let mut mirror = Mirror { collections: state.meta("pluginCollections").and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default(), ..Default::default() };
        for (key, record) in state.plugin_items()? {
            if let Ok(record) = serde_json::from_str::<Record>(&record) {
                mirror.items.insert(key, record);
            }
        }
        Ok(mirror)
    }

    pub fn save(&mut self, state: &mut State) -> Result<()> {
        let upserts: Vec<(String, String)> = self
            .items
            .iter()
            .filter(|(k, _)| self.replaced || self.changed.contains(*k))
            .map(|(k, r)| Ok((k.clone(), serde_json::to_string(r).map_err(|e| e.to_string())?)))
            .collect::<Result<_>>()?;
        let removes: Vec<String> = self.removed.iter().cloned().collect();
        state.save_plugin_items(&upserts, &removes, self.replaced)?;
        state.set_meta("pluginCollections", &serde_json::to_string(&self.collections).map_err(|e| e.to_string())?)?;
        self.changed.clear();
        self.removed.clear();
        self.replaced = false;
        Ok(())
    }

    /// Each file, note and annotation key → the top-level item it belongs to.
    pub fn parents(&self) -> HashMap<String, String> {
        let mut parents = HashMap::new();
        for (key, record) in &self.items {
            for attachment in record.attachments.iter().chain(&record.attachment) {
                if attachment.key != *key {
                    parents.insert(attachment.key.clone(), key.clone());
                }
                for annotation in &attachment.annotations {
                    parents.insert(annotation.key.clone(), key.clone());
                }
            }
            for note in &record.notes {
                parents.insert(note.key.clone(), key.clone());
            }
        }
        parents
    }

    pub fn plan(&self, changes: &[Change]) -> Plan {
        let parents = self.parents();
        let mut plan = Plan::default();
        for change in changes {
            match change.kind.as_str() {
                "collection" => plan.collections = true,
                "library" => plan.everything = true,
                "item" if change.op == "delete" => {
                    if self.items.contains_key(&change.key) {
                        plan.remove.insert(change.key.clone());
                        plan.fetch.remove(&change.key);
                    } else if let Some(parent) = parents.get(&change.key) {
                        // A note, file or annotation went: its item has changed.
                        plan.fetch.insert(parent.clone());
                    }
                }
                "item" => {
                    plan.fetch.insert(change.key.clone());
                    plan.remove.remove(&change.key);
                }
                _ => {}
            }
        }
        plan
    }

    /// Stores fetched items. A file, note or annotation moved to another item leaves the
    /// one it was in.
    pub fn upsert(&mut self, records: Vec<Record>) {
        for record in records {
            let children: HashSet<String> = record
                .attachments
                .iter()
                .flat_map(|a| std::iter::once(a.key.clone()).chain(a.annotations.iter().map(|n| n.key.clone())))
                .chain(record.notes.iter().map(|n| n.key.clone()))
                .collect();
            if !children.is_empty() {
                for (key, other) in self.items.iter_mut().filter(|(k, _)| **k != record.key) {
                    let before = (other.attachments.len(), other.notes.len());
                    other.attachments.retain(|a| !children.contains(&a.key));
                    other.notes.retain(|n| !children.contains(&n.key));
                    if before != (other.attachments.len(), other.notes.len()) {
                        self.changed.insert(key.clone());
                    }
                }
            }
            // An item that was a child before and is top-level now (or the other way round).
            self.removed.remove(&record.key);
            self.changed.insert(record.key.clone());
            self.items.insert(record.key.clone(), record);
        }
    }

    pub fn remove(&mut self, key: &str) {
        if self.items.remove(key).is_some() {
            self.changed.remove(key);
            self.removed.insert(key.to_string());
        }
    }

    pub fn replace(&mut self, collections: Vec<PCollection>, records: Vec<Record>) {
        self.collections = collections;
        self.items.clear();
        self.changed.clear();
        self.removed.clear();
        self.replaced = true;
        self.upsert(records);
    }

    /// The mirror as the import reads a library. Items in Zotero's trash are left out, so
    /// the sync moves them to Key's trash.
    pub fn snapshot(&self, label: &Path) -> Snapshot {
        let mut next = 0i64;
        let mut id = || {
            next += 1;
            next
        };
        let mut s = Snapshot {
            data_dir: label.to_path_buf(),
            stamp: Stamp { modified_ms: 0, size: 0 },
            collections: Vec::new(),
            items: Vec::new(),
            fields: HashMap::new(),
            creators: HashMap::new(),
            tags: HashMap::new(),
            collections_of: HashMap::new(),
            attachments: Vec::new(),
            notes: Vec::new(),
            annotations: Vec::new(),
            key_of: HashMap::new(),
            added_of: HashMap::new(),
            trashed: HashSet::new(),
        };
        let collection_ids: HashMap<&str, i64> = self.collections.iter().map(|c| (c.key.as_str(), id())).collect();
        s.collections = self
            .collections
            .iter()
            .map(|c| ZCollection {
                id: collection_ids[c.key.as_str()],
                key: c.key.clone(),
                name: c.name.clone(),
                parent: c.parent_key.as_deref().and_then(|p| collection_ids.get(p).copied()),
            })
            .collect();
        snapshot::order_collections(&mut s.collections);
        for record in self.items.values().filter(|r| !r.deleted) {
            let item = id();
            let added = sql_date(&record.date_added);
            s.key_of.insert(item, record.key.clone());
            s.added_of.insert(item, added.clone());
            let filed: Vec<i64> = record.collections.iter().filter_map(|k| collection_ids.get(k.as_str()).copied()).collect();
            if !filed.is_empty() {
                s.collections_of.insert(item, filed);
            }
            if !record.tags.is_empty() {
                s.tags.insert(item, record.tags.clone());
            }
            match record.item_type.as_str() {
                "note" => {
                    let note = record.note.clone().unwrap_or_default();
                    s.notes.push(ZNote { id: item, key: record.key.clone(), parent: None, title: note.title, html: note.html });
                }
                "attachment" => {
                    let attachment = record.attachment.clone().unwrap_or_default();
                    add_attachment(&mut s, item, None, &attachment);
                }
                _ => {
                    s.items.push(ZItem { id: item, key: record.key.clone(), type_name: record.item_type.clone(), added });
                    let fields: Vec<(String, String)> = record.fields.iter().filter_map(|(k, v)| text(v).filter(|v| !v.is_empty()).map(|v| (k.clone(), v))).collect();
                    s.fields.insert(item, fields);
                    let creators: Vec<key_store::Creator> =
                        record.creators.iter().map(|c| snapshot::creator(c.first_name.clone(), c.last_name.clone().or_else(|| c.name.clone()), c.name.is_some(), &c.creator_type)).collect();
                    if !creators.is_empty() {
                        s.creators.insert(item, creators);
                    }
                    for attachment in &record.attachments {
                        let child = id();
                        s.key_of.insert(child, attachment.key.clone());
                        add_attachment(&mut s, child, Some(item), attachment);
                    }
                    for note in &record.notes {
                        let child = id();
                        s.key_of.insert(child, note.key.clone());
                        s.notes.push(ZNote { id: child, key: note.key.clone(), parent: Some(item), title: note.title.clone(), html: note.html.clone() });
                    }
                }
            }
        }
        s
    }
}

fn add_attachment(s: &mut Snapshot, id: i64, parent: Option<i64>, attachment: &PAttachment) {
    s.attachments.push(ZAttachment { id, parent, content_type: attachment.content_type.clone(), path: attachment.path.as_ref().filter(|p| !p.is_empty()).map(PathBuf::from) });
    let mut annotations: Vec<&PAnnotation> = attachment.annotations.iter().collect();
    annotations.sort_by(|a, b| a.sort_index.cmp(&b.sort_index));
    for a in annotations {
        s.annotations.push(ZAnnotation { attachment: id, kind: a.kind, text: a.text.clone(), comment: a.comment.clone(), color: a.color.clone(), page_index: a.page_index });
    }
}

fn text(value: &Json) -> Option<String> {
    match value {
        Json::String(s) => Some(s.clone()),
        Json::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Zotero's "YYYY-MM-DD HH:MM:SS" (UTC), also from ISO 8601.
fn sql_date(value: &str) -> String {
    value.replace('T', " ").trim_end_matches('Z').to_string()
}

// ── Sync ────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// Whether changes were fetched and merged.
    pub ran: bool,
    pub connection: Option<Connection>,
    pub message: Option<String>,
    pub report: Option<ImportReport>,
    /// When the app should ask again (milliseconds): see `next_delay`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_ms: Option<u64>,
}

/// How often the app asks for a sync while Zotero answers.
pub const SYNC_EVERY_MS: u64 = 15_000;
/// The longest wait while Zotero is not running or the plugin is missing.
pub const SYNC_BACKOFF_MAX_MS: u64 = 5 * 60_000;
/// Without a sync set up (or paused) the app asks rarely; setting one up wakes it.
pub const SYNC_IDLE_MS: u64 = 5 * 60_000;

static DELAYS: Mutex<Option<HashMap<PathBuf, u64>>> = Mutex::new(None);

/// The wait before the next sync of this library: steady while Zotero answers, rare while
/// sync is off or paused, doubling (to a ceiling) while Zotero is closed, the plugin is
/// missing or the sync fails. `connection: None` with `failed` is a sync that errored.
pub fn next_delay(root: &Path, connection: Option<&Connection>, failed: bool) -> u64 {
    let Ok(mut map) = DELAYS.lock() else { return SYNC_EVERY_MS };
    let delays = map.get_or_insert_with(HashMap::new);
    let previous = delays.get(root).copied().unwrap_or(SYNC_EVERY_MS);
    let next = match connection {
        _ if failed => SYNC_BACKOFF_MAX_MS.min(SYNC_EVERY_MS.max(previous * 2)),
        None | Some(Connection::Ok) => SYNC_EVERY_MS,
        Some(Connection::Off) | Some(Connection::Paused) => SYNC_IDLE_MS,
        Some(_) => SYNC_BACKOFF_MAX_MS.min(SYNC_EVERY_MS.max(previous * 2)),
    };
    delays.insert(root.to_path_buf(), next);
    next
}

/// A forced sync (the user asked, or set sync up) starts the steady pace again.
pub fn reset_delay(root: &Path) {
    if let Ok(mut map) = DELAYS.lock() {
        map.get_or_insert_with(HashMap::new).remove(root);
    }
}

static RECONCILED: Mutex<Option<HashMap<PathBuf, Instant>>> = Mutex::new(None);

fn due_for_reconcile(root: &Path) -> bool {
    let Ok(mut map) = RECONCILED.lock() else { return false };
    map.get_or_insert_with(HashMap::new).get(root).is_none_or(|at| at.elapsed() >= RECONCILE_EVERY)
}

fn reconciled(root: &Path) {
    if let Ok(mut map) = RECONCILED.lock() {
        map.get_or_insert_with(HashMap::new).insert(root.to_path_buf(), Instant::now());
    }
}

/// One sync over HTTP: called on a timer and when Key's window gets focus. Cheap when
/// nothing changed in Zotero (one small request).
pub fn sync(store: &Store, force: bool, progress: &dyn Fn(Progress)) -> Result<Outcome> {
    let state = State::open(store.root())?;
    let Some(mut config) = config(&state).filter(|c| c.enabled) else {
        return Ok(Outcome { connection: Some(Connection::Off), ..Default::default() });
    };
    if config.paused {
        return Ok(Outcome { connection: Some(Connection::Paused), ..Default::default() });
    }
    let port = port(config.port);
    let token = config.token.clone().or_else(discovered_token);
    let transport = HttpTransport { port, token: token.clone() };
    let reconcile = due_for_reconcile(store.root());
    let mut outcome = sync_with(store, &transport, force, reconcile, progress);
    // A new code in Zotero (regenerated, or a first pairing through prefs.js).
    if matches!(&outcome, Err(f) if f.connection == Connection::Unpaired) {
        if let Some(found) = discovered_token().filter(|t| Some(t) != token.as_ref()) {
            outcome = sync_with(store, &HttpTransport { port, token: Some(found.clone()) }, force, reconcile, progress);
            if outcome.is_ok() {
                config.token = Some(found);
                state.set_meta("pluginConfig", &serde_json::to_string(&config).map_err(|e| e.to_string())?)?;
            }
        }
    } else if outcome.is_ok() && config.token.is_none() {
        config.token = token;
        state.set_meta("pluginConfig", &serde_json::to_string(&config).map_err(|e| e.to_string())?)?;
    }
    if outcome.is_ok() && reconcile {
        reconciled(store.root());
    }
    finish(&state, outcome)
}

/// Records how the attempt went, writing the status only when there is news.
fn finish(state: &State, outcome: std::result::Result<Outcome, Failure>) -> Result<Outcome> {
    let mut status = status_of(state);
    let now = key_store::now_ms();
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(failure) => Outcome { connection: Some(failure.connection), message: Some(failure.message), ..Default::default() },
    };
    let quiet = !outcome.ran && status.connection == outcome.connection && status.checked_at.is_some_and(|at| now - at < 60_000);
    if outcome.connection == Some(Connection::Ok) {
        status.checked_at = Some(now);
    }
    status.connection = outcome.connection.clone();
    status.message = outcome.message.clone();
    if !quiet || outcome.connection != Some(Connection::Ok) {
        save_status(state, &status)?;
    }
    Ok(outcome)
}

fn scope_of(config: &Config) -> Json {
    match (&config.options.collection_keys, &config.options.item_keys) {
        (None, None) => json!({"type": "all"}),
        (collections, items) => json!({"type": "mixed", "collections": collections.clone().unwrap_or_default(), "items": items.clone().unwrap_or_default()}),
    }
}

/// The sync against any transport.
pub fn sync_with(store: &Store, t: &dyn Transport, force: bool, reconcile: bool, progress: &dyn Fn(Progress)) -> std::result::Result<Outcome, Failure> {
    let mut state = State::open(store.root())?;
    let config = config(&state).ok_or_else(|| Failure::error("Zotero sync is not set up."))?;
    let mut status = status_of(&state);
    let hello = t.call("GET", "handshake", None)?;
    if hello["paired"] != Json::Bool(true) {
        return Err(Failure { connection: Connection::Unpaired, message: "Zotero did not accept the pairing code.".into() });
    }
    let libraries: Vec<Library> = serde_json::from_value(hello["libraries"].clone()).unwrap_or_default();
    let library = config.library_id.or_else(|| hello["defaultLibraryID"].as_i64()).unwrap_or(1);
    let scope = json!({"library": library, "scope": scope_of(&config)});
    status.plugin_version = hello["version"].as_str().map(String::from);
    status.zotero_version = hello["zotero"].as_str().map(String::from);
    status.library_id = Some(library);
    status.library_name = libraries.iter().find(|l| l.library_id == library).map(|l| l.name.clone());

    let epoch = hello["epoch"].as_str().map(String::from);
    let mut full = status.epoch.is_none() || status.epoch != epoch || status.scope.as_ref() != Some(&scope);
    let mut changes: Vec<Change> = Vec::new();
    let mut seq = status.seq;
    if !full {
        loop {
            let page = t.call("GET", &format!("changes?since={seq}&epoch={}&libraryID={library}", epoch.as_deref().unwrap_or("")), None)?;
            if page["resyncRequired"] == Json::Bool(true) {
                full = true;
                break;
            }
            changes.extend(serde_json::from_value::<Vec<Change>>(page["changes"].clone()).unwrap_or_default());
            seq = page["seq"].as_i64().unwrap_or(seq);
            if page["more"] != Json::Bool(true) {
                break;
            }
        }
    }
    if !full && changes.is_empty() && !force && !reconcile {
        return Ok(Outcome { connection: Some(Connection::Ok), ..Default::default() });
    }

    let tracked: Vec<String> = state.all("item")?.into_iter().filter(|(_, t)| t.id.is_some()).map(|(k, _)| k).collect();
    let tracked_notes: Vec<String> = state.all("note")?.into_iter().filter(|(k, t)| t.id.is_some() && !k.contains(':')).map(|(k, _)| k).collect();
    let mut mirror = Mirror::load(&state)?;
    let plan = mirror.plan(&changes);
    if full || plan.everything {
        // Everything in scope, then what Key already has from Zotero outside it.
        seq = hello["seq"].as_i64().unwrap_or(0);
        let collections = fetch_collections(t, library)?;
        let mut records = Vec::new();
        let mut offset = 0usize;
        loop {
            let page = t.call("POST", "items", Some(&json!({"libraryID": library, "scope": scope_of(&config), "offset": offset, "limit": PAGE})))?;
            let total = page["total"].as_u64().unwrap_or(0) as usize;
            records.extend(serde_json::from_value::<Vec<Record>>(page["items"].clone()).map_err(|e| Failure::error(e.to_string()))?);
            progress(Progress::new("fetching", records.len().min(total), total));
            match page["next"].as_u64() {
                Some(next) if next as usize > offset => offset = next as usize,
                _ => break,
            }
        }
        mirror.replace(collections, records);
        let parents = mirror.parents();
        let outside: Vec<String> =
            tracked.iter().chain(&tracked_notes).filter(|k| !mirror.items.contains_key(*k) && !parents.contains_key(*k)).cloned().collect();
        fetch_keys(t, &mut mirror, library, outside)?;
    } else {
        for key in &plan.remove {
            mirror.remove(key);
        }
        let mut fetch: Vec<String> = plan.fetch.into_iter().collect();
        if reconcile {
            fetch.extend(reconcile_keys(t, &mut mirror, library, &config)?);
        }
        if plan.collections || reconcile {
            mirror.collections = fetch_collections(t, library)?;
        }
        fetch_keys(t, &mut mirror, library, fetch)?;
    }
    mirror.save(&mut state)?;
    status.epoch = epoch;
    status.seq = seq;
    status.scope = Some(scope);
    status.items = mirror.items.len();
    save_status(&state, &status)?;

    let snapshot = mirror.snapshot(Path::new("Zotero"));
    let mut options = config.options.clone();
    options.unlink_outside_scope = true;
    let report = sync::run_snapshot(store, &options, Mode::Sync, &snapshot, progress)?;
    let mut status = status_of(&state);
    let changed = report.added + report.updated + report.trashed + report.restored + report.notes + report.notes_updated + report.notes_deleted + report.collections + report.unlinked;
    if changed > 0 || status.synced_at.is_none() {
        status.synced_at = Some(key_store::now_ms());
    }
    status.report = Some(report.clone());
    save_status(&state, &status)?;
    Ok(Outcome { ran: true, connection: Some(Connection::Ok), message: None, report: Some(report), next_ms: None })
}

fn fetch_collections(t: &dyn Transport, library: i64) -> std::result::Result<Vec<PCollection>, Failure> {
    let answer = t.call("GET", &format!("collections?libraryID={library}"), None)?;
    serde_json::from_value(answer["collections"].clone()).map_err(|e| Failure::error(e.to_string()))
}

/// Fetches these items. Keys Zotero no longer has leave the mirror; a gone note or file
/// refetches the item it was in.
fn fetch_keys(t: &dyn Transport, mirror: &mut Mirror, library: i64, keys: Vec<String>) -> std::result::Result<(), Failure> {
    let mut queue: Vec<String> = keys.into_iter().collect::<BTreeSet<_>>().into_iter().collect();
    let mut seen: HashSet<String> = HashSet::new();
    while !queue.is_empty() {
        let batch: Vec<String> = queue.drain(..queue.len().min(FETCH_CHUNK)).filter(|k| seen.insert(k.clone())).collect();
        if batch.is_empty() {
            continue;
        }
        let answer = t.call("POST", "items", Some(&json!({"libraryID": library, "keys": batch})))?;
        let records: Vec<Record> = serde_json::from_value(answer["items"].clone()).map_err(|e| Failure::error(e.to_string()))?;
        let missing: Vec<String> = serde_json::from_value(answer["missing"].clone()).unwrap_or_default();
        mirror.upsert(records);
        let parents = mirror.parents();
        for key in missing {
            if mirror.items.contains_key(&key) {
                mirror.remove(&key);
            } else if let Some(parent) = parents.get(&key).filter(|p| !seen.contains(*p)) {
                queue.push(parent.clone());
            }
        }
    }
    Ok(())
}

/// Compares the mirror with Zotero's item list: items gone or changed while the journal
/// was not recording, and items now in scope that Key has not seen.
fn reconcile_keys(t: &dyn Transport, mirror: &mut Mirror, library: i64, config: &Config) -> std::result::Result<Vec<String>, Failure> {
    let answer = t.call("GET", &format!("versions?libraryID={library}"), None)?;
    let versions: HashMap<String, (String, bool)> = answer["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| Some((v["key"].as_str()?.to_string(), (v["stamp"].as_str().unwrap_or("").to_string(), v["deleted"].as_bool().unwrap_or(false)))))
        .collect();
    let mut fetch = Vec::new();
    let keys: Vec<String> = mirror.items.keys().cloned().collect();
    for key in keys {
        match versions.get(&key) {
            None => mirror.remove(&key),
            Some((stamp, deleted)) => {
                let record = &mirror.items[&key];
                if *deleted != record.deleted || stamp.is_empty() || *stamp != record.stamp {
                    fetch.push(key);
                }
            }
        }
    }
    let in_scope = t.call("POST", "items", Some(&json!({"libraryID": library, "scope": scope_of(config), "keysOnly": true})))?;
    for key in in_scope["keys"].as_array().into_iter().flatten().filter_map(Json::as_str) {
        if !mirror.items.contains_key(key) {
            fetch.push(key.to_string());
        }
    }
    Ok(fetch)
}
