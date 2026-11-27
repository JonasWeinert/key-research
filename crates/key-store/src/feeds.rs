// Feeds and alerts: what the user follows (an RSS/Atom feed, a saved OpenAlex search, an
// author, a journal, a topic, new works citing a collection) and the works they brought in,
// de-duplicated across subscriptions by every identifier a work carries (DOI, OpenAlex,
// arXiv, link, title and year). Each item is read or unread, may be saved for later or
// dismissed, and remembers the library source it became. The host (key-desktop-host
// feeds/) fetches; this keeps the rows. A dismissed or purged item leaves its keys behind,
// so a feed that still lists it does not bring it back.
use crate::matching::{LinkKey, MatchQuery, bare_arxiv, bare_doi, bare_openalex, link_key, title_key};
use crate::{Result, Store, e, new_id, now_ms};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS feed_subscriptions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  interval_minutes INTEGER NOT NULL DEFAULT 360,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  checked_at INTEGER,
  next_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  etag TEXT,
  last_modified TEXT,
  cursor TEXT
);
CREATE TABLE IF NOT EXISTS feed_items (
  id TEXT PRIMARY KEY,
  work TEXT NOT NULL,
  title TEXT NOT NULL,
  published TEXT,
  found_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  saved INTEGER NOT NULL DEFAULT 0,
  dismissed_at INTEGER,
  source_id TEXT
);
CREATE INDEX IF NOT EXISTS feed_items_found ON feed_items(found_at);
CREATE TABLE IF NOT EXISTS feed_item_subscriptions (
  item_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  PRIMARY KEY (item_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS feed_item_subscriptions_sub ON feed_item_subscriptions(subscription_id);
-- Every key an item is known by; item_id NULL once it is purged (it stays seen).
CREATE TABLE IF NOT EXISTS feed_item_keys (
  key TEXT PRIMARY KEY,
  item_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_item_keys_item ON feed_item_keys(item_id);
";

pub(crate) fn ensure_schema(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA).map_err(e)?;
    // Works the user saved themselves remember where they were found.
    if db.prepare("SELECT origin FROM feed_items LIMIT 0").is_err() {
        db.execute_batch("ALTER TABLE feed_items ADD COLUMN origin TEXT").map_err(e)?;
    }
    Ok(())
}

/// rss | openalex | author | venue | topic | citing | pubmed
pub const KINDS: &[&str] = &["rss", "openalex", "author", "venue", "topic", "citing", "pubmed"];
pub const MIN_INTERVAL: i64 = 15;
pub const MAX_INTERVAL: i64 = 7 * 24 * 60;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub config: Map<String, Json>,
    pub interval_minutes: i64,
    pub paused: bool,
    pub created_at: i64,
    pub checked_at: Option<i64>,
    pub next_at: Option<i64>,
    pub failures: i64,
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Items from it that are unread and not dismissed.
    #[serde(default)]
    pub unread: i64,
    #[serde(default)]
    pub total: i64,
    /// When it last brought something new.
    #[serde(default)]
    pub last_item_at: Option<i64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub config: Option<Map<String, Json>>,
    #[serde(default)]
    pub interval_minutes: Option<i64>,
    #[serde(default)]
    pub paused: Option<bool>,
}

/// How one check went, as the poller records it.
#[derive(Clone, Debug, Default)]
pub struct Check {
    pub ok: bool,
    pub error: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub cursor: Option<String>,
    /// A wait the service asked for (Retry-After), beyond the usual backoff.
    pub retry_after_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub id: String,
    /// The work as web search describes it (title, authors, year, venue, abstract, doi, ids, landingUrl …).
    pub work: Json,
    pub published: Option<String>,
    pub found_at: i64,
    pub read: bool,
    pub saved: bool,
    pub dismissed: bool,
    /// The library source it was added as, or (when not added) the one it matches.
    pub source_id: Option<String>,
    pub added: bool,
    /// doi | openalex | arxiv | url | title, when the library has it.
    pub in_library: Option<String>,
    /// Titles of the subscriptions that brought it.
    pub subscriptions: Vec<String>,
    pub subscription_ids: Vec<String>,
    /// Saved by the user from somewhere (a web search, a source's references, a page):
    /// { kind, label, query?, sourceId?, url?, at }. None for what feeds brought.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Json>,
}

/// What saving a work to the Inbox did.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxSave {
    /// inbox | library (the library has it, so nothing was stored)
    pub state: &'static str,
    pub item_id: Option<String>,
    pub source_id: Option<String>,
    /// It was in the Inbox already.
    pub existed: bool,
}

/// Where a work stands, for an "Add to Inbox" button.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxState {
    /// none | inbox | library
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub saved: bool,
}

/// Something in the library worth following: a journal, person or topic and how many
/// sources it has there.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntity {
    pub id: String,
    pub name: String,
    pub openalex_id: Option<String>,
    /// An ISSN (journals), an ORCID (people) or the topic's level.
    pub detail: Option<String>,
    pub count: i64,
}

/// A work's fields worth keeping in an item (web hits carry ranking noise).
fn clean_work(work: &Json) -> Json {
    let mut out = Map::new();
    for key in ["title", "authors", "year", "venue", "abstract", "doi", "ids", "landingUrl", "pdfUrl", "type", "published", "openAccess", "oaStatus", "citedBy", "url", "isRetracted"] {
        if let Some(v) = work.get(key).filter(|v| !v.is_null()) {
            out.insert(key.into(), v.clone());
        }
    }
    Json::Object(out)
}

/// `old` with the blanks filled from `work`.
fn merge_blanks(old: &str, work: &Json) -> String {
    let mut merged: Map<String, Json> = serde_json::from_str(old).unwrap_or_default();
    for (k, v) in work.as_object().into_iter().flatten() {
        let blank = merged.get(k).is_none_or(|old| old.is_null() || old.as_str() == Some("") || old.as_array().is_some_and(Vec::is_empty));
        if blank {
            merged.insert(k.clone(), v.clone());
        }
    }
    Json::Object(merged).to_string()
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemQuery {
    #[serde(default)]
    pub subscription_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    /// unread | all (default: not dismissed) | saved | dismissed
    #[serde(default)]
    pub view: Option<String>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub limit: Option<usize>,
    /// Items read while the list was shown: they stay in the unread view until it is left.
    #[serde(default)]
    pub keep: Vec<String>,
    /// Only what the user saved themselves (not brought by a feed).
    #[serde(default)]
    pub saved_by_you: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPage {
    pub items: Vec<FeedItem>,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub unread: i64,
    pub saved: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Retention {
    /// Unread items older than this are removed (0 keeps them).
    pub unread_days: i64,
    /// Read items, not saved or added.
    pub read_days: i64,
    pub dismissed_days: i64,
}
impl Default for Retention {
    fn default() -> Self {
        Self { unread_days: 90, read_days: 30, dismissed_days: 7 }
    }
}
const RETENTION_META: &str = "feeds.retention";
/// Purged items' keys are forgotten after a year.
const SEEN_DAYS: i64 = 365;

pub(crate) fn text(work: &Json, key: &str) -> Option<String> {
    work.get(key).and_then(Json::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// Every key a work is known by, most certain first.
pub fn work_keys(work: &Json) -> Vec<String> {
    let mut keys = Vec::new();
    let ids = work.get("ids").cloned().unwrap_or(Json::Null);
    if let Some(doi) = text(work, "doi").as_deref().and_then(bare_doi) {
        // arXiv's DataCite DOIs are the arXiv id too.
        if let Some(arxiv) = doi.strip_prefix("10.48550/arxiv.") {
            keys.push(format!("arxiv:{arxiv}"));
        }
        keys.push(format!("doi:{doi}"));
    }
    if let Some(id) = text(&ids, "openalex").as_deref().and_then(bare_openalex) {
        keys.push(format!("openalex:{id}"));
    }
    if let Some(id) = text(&ids, "arxiv").as_deref().and_then(bare_arxiv) {
        keys.push(format!("arxiv:{id}"));
    }
    for url in [text(work, "landingUrl"), text(work, "url")].into_iter().flatten() {
        match link_key(&url) {
            Some(LinkKey::Doi(d)) => keys.push(format!("doi:{d}")),
            Some(LinkKey::Arxiv(a)) => keys.push(format!("arxiv:{a}")),
            Some(LinkKey::Pmid(p)) => keys.push(format!("pmid:{p}")),
            Some(LinkKey::Url(u)) => keys.push(format!("url:{u}")),
            None => {}
        }
    }
    if let Some(title) = text(work, "title") {
        let t = title_key(&title);
        if t.len() >= 12 {
            let year = work.get("year").and_then(Json::as_i64).map(|y| y.to_string()).unwrap_or_default();
            keys.push(format!("title:{t}|{year}"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    keys.retain(|k| seen.insert(k.clone()));
    keys
}

pub(crate) fn match_query(key: &str, work: &Json) -> MatchQuery {
    let ids = work.get("ids").cloned().unwrap_or(Json::Null);
    MatchQuery {
        key: key.into(),
        doi: text(work, "doi"),
        url: text(work, "landingUrl").or_else(|| text(work, "url")),
        arxiv: text(&ids, "arxiv"),
        openalex: text(&ids, "openalex"),
        pmid: text(&ids, "pmid"),
        title: text(work, "title"),
        year: work.get("year").and_then(Json::as_i64),
        first_author: work.get("authors").and_then(|a| a.get(0)).and_then(Json::as_str).map(String::from),
        ..Default::default()
    }
}

fn read_subscription(r: &rusqlite::Row) -> rusqlite::Result<Subscription> {
    Ok(Subscription {
        id: r.get(0)?,
        kind: r.get(1)?,
        title: r.get(2)?,
        config: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
        interval_minutes: r.get(4)?,
        paused: r.get::<_, i64>(5)? != 0,
        created_at: r.get(6)?,
        checked_at: r.get(7)?,
        next_at: r.get(8)?,
        failures: r.get(9)?,
        last_error: r.get(10)?,
        etag: r.get(11)?,
        last_modified: r.get(12)?,
        cursor: r.get(13)?,
        unread: r.get(14)?,
        total: r.get(15)?,
        last_item_at: r.get(16)?,
    })
}

const SUBSCRIPTION_COLUMNS: &str = "s.id, s.kind, s.title, s.config, s.interval_minutes, s.paused, s.created_at, s.checked_at, s.next_at, s.failures, s.last_error, s.etag, s.last_modified, s.cursor,
  (SELECT count(*) FROM feed_item_subscriptions x JOIN feed_items i ON i.id = x.item_id WHERE x.subscription_id = s.id AND i.read = 0 AND i.dismissed_at IS NULL),
  (SELECT count(*) FROM feed_item_subscriptions x WHERE x.subscription_id = s.id),
  (SELECT max(i.found_at) FROM feed_item_subscriptions x JOIN feed_items i ON i.id = x.item_id WHERE x.subscription_id = s.id)";

/// The default check interval for a kind, in minutes: feeds change more often than catalogues.
pub fn default_interval(kind: &str) -> i64 {
    if kind == "rss" { 180 } else { 720 }
}

/// What makes two subscriptions the same: a feed's address, a search and its filters, an id.
pub fn identity(kind: &str, config: &Map<String, Json>) -> String {
    let pick = |k: &str| config.get(k).map(|v| match v {
        Json::String(s) => s.trim().to_lowercase(),
        other => other.to_string(),
    });
    match kind {
        "rss" => format!("rss:{}", pick("url").unwrap_or_default().trim_end_matches('/')),
        "openalex" => format!("openalex:{}|{}", pick("query").unwrap_or_default(), pick("filters").unwrap_or_default()),
        "pubmed" => format!("pubmed:{}", pick("query").unwrap_or_default()),
        "citing" => format!("citing:{}|{}", pick("collectionId").unwrap_or_default(), pick("sourceId").unwrap_or_default()),
        other => format!("{other}:{}", pick("openalexId").or_else(|| pick("orcid")).or_else(|| pick("issn")).unwrap_or_default()),
    }
}

impl Store {
    pub(crate) fn feeds_db(&self) -> Result<crate::priority::Guard<'_, Connection>> {
        let db = self.db()?;
        ensure_schema(&db)?;
        Ok(db)
    }

    pub fn feed_subscriptions(&self) -> Result<Vec<Subscription>> {
        let db = self.feeds_db()?;
        let mut statement = db.prepare(&format!("SELECT {SUBSCRIPTION_COLUMNS} FROM feed_subscriptions s ORDER BY s.created_at")).map_err(e)?;
        let rows = statement.query_map([], read_subscription).map_err(e)?;
        rows.collect::<std::result::Result<_, _>>().map_err(e)
    }

    pub fn feed_subscription(&self, id: &str) -> Result<Option<Subscription>> {
        let db = self.feeds_db()?;
        db.query_row(&format!("SELECT {SUBSCRIPTION_COLUMNS} FROM feed_subscriptions s WHERE s.id = ?1"), [id], read_subscription).optional().map_err(e)
    }

    /// The subscription that already follows this, if any.
    pub fn find_feed_subscription(&self, kind: &str, config: &Map<String, Json>) -> Result<Option<Subscription>> {
        let wanted = identity(kind, config);
        Ok(self.feed_subscriptions()?.into_iter().find(|s| identity(&s.kind, &s.config) == wanted))
    }

    /// Creates (or, with an id, changes) a subscription. Following something already followed
    /// answers the existing one.
    pub fn save_feed_subscription(&self, input: &SubscriptionInput) -> Result<Subscription> {
        let interval = |kind: &str| input.interval_minutes.unwrap_or_else(|| default_interval(kind)).clamp(MIN_INTERVAL, MAX_INTERVAL);
        if let Some(id) = input.id.as_deref() {
            let current = self.feed_subscription(id)?.ok_or("No such subscription")?;
            let db = self.feeds_db()?;
            let config = input.config.clone().unwrap_or(current.config.clone());
            let title = input.title.as_deref().map(str::trim).filter(|t| !t.is_empty()).unwrap_or(&current.title).to_string();
            let paused = input.paused.unwrap_or(current.paused);
            let minutes = input.interval_minutes.map(|_| interval(&current.kind)).unwrap_or(current.interval_minutes);
            // A changed interval or a resumed subscription is next checked on its new schedule.
            let next = if minutes != current.interval_minutes || (current.paused && !paused) {
                Some(current.checked_at.map(|at| at + minutes * 60_000).unwrap_or_else(now_ms))
            } else {
                current.next_at
            };
            db.execute(
                "UPDATE feed_subscriptions SET title = ?2, config = ?3, interval_minutes = ?4, paused = ?5, next_at = ?6 WHERE id = ?1",
                params![id, title, Json::Object(config).to_string(), minutes, paused as i64, next],
            )
            .map_err(e)?;
            drop(db);
            return self.feed_subscription(id)?.ok_or_else(|| "No such subscription".into());
        }
        let kind = input.kind.trim();
        if !KINDS.contains(&kind) {
            return Err(format!("Unknown subscription kind {kind}"));
        }
        let config = input.config.clone().unwrap_or_default();
        if let Some(existing) = self.find_feed_subscription(kind, &config)? {
            return Ok(existing);
        }
        let id = new_id();
        let title = input.title.as_deref().map(str::trim).filter(|t| !t.is_empty()).unwrap_or("Untitled feed").chars().take(300).collect::<String>();
        {
            let db = self.feeds_db()?;
            db.execute(
                "INSERT INTO feed_subscriptions(id, kind, title, config, interval_minutes, paused, created_at, next_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![id, kind, title, Json::Object(config).to_string(), interval(kind), input.paused.unwrap_or(false) as i64, now_ms()],
            )
            .map_err(e)?;
        }
        self.feed_subscription(&id)?.ok_or_else(|| "The subscription was not saved".into())
    }

    /// Removes a subscription and the items only it brought, but those saved or added.
    pub fn delete_feed_subscription(&self, id: &str) -> Result<()> {
        let db = self.feeds_db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        tx.execute("DELETE FROM feed_item_subscriptions WHERE subscription_id = ?1", [id]).map_err(e)?;
        tx.execute("DELETE FROM feed_subscriptions WHERE id = ?1", [id]).map_err(e)?;
        let orphan = "SELECT id FROM feed_items WHERE saved = 0 AND source_id IS NULL AND NOT EXISTS (SELECT 1 FROM feed_item_subscriptions x WHERE x.item_id = feed_items.id)";
        tx.execute(&format!("DELETE FROM feed_item_keys WHERE item_id IN ({orphan})"), []).map_err(e)?;
        tx.execute(&format!("DELETE FROM feed_items WHERE id IN ({orphan})"), []).map_err(e)?;
        tx.commit().map_err(e)
    }

    /// Subscriptions due a check now: not paused, and their time has come.
    pub fn due_feed_subscriptions(&self, now: i64) -> Result<Vec<Subscription>> {
        Ok(self.feed_subscriptions()?.into_iter().filter(|s| !s.paused && s.next_at.is_none_or(|at| at <= now)).collect())
    }

    /// Records a check: on failure the next one backs off (twice the interval each time, at
    /// most a day, or what the service asked for).
    pub fn record_feed_check(&self, id: &str, check: &Check) -> Result<()> {
        let Some(current) = self.feed_subscription(id)? else { return Ok(()) };
        let now = now_ms();
        let interval = current.interval_minutes * 60_000;
        let failures = if check.ok { 0 } else { current.failures + 1 };
        let wait = if check.ok { interval } else { (interval.min(60 * 60_000) * (1 << failures.min(5))).min(24 * 60 * 60_000) };
        let next = now + wait.max(check.retry_after_ms.unwrap_or(0));
        let db = self.feeds_db()?;
        db.execute(
            "UPDATE feed_subscriptions SET checked_at = ?2, next_at = ?3, failures = ?4, last_error = ?5,
               etag = coalesce(?6, etag), last_modified = coalesce(?7, last_modified), cursor = coalesce(?8, cursor) WHERE id = ?1",
            params![id, now, next, failures, check.error, check.etag, check.last_modified, check.cursor],
        )
        .map_err(e)?;
        Ok(())
    }

    /// Asks for a check at once (Refresh).
    pub fn feed_check_now(&self, id: Option<&str>) -> Result<()> {
        let db = self.feeds_db()?;
        match id {
            Some(id) => db.execute("UPDATE feed_subscriptions SET next_at = 0 WHERE id = ?1", [id]),
            None => db.execute("UPDATE feed_subscriptions SET next_at = 0 WHERE paused = 0", []),
        }
        .map_err(e)?;
        Ok(())
    }

    /// Stores the works a subscription found; those already known (by any key) are linked to
    /// it and filled in, not repeated. Answers how many are new.
    pub fn add_feed_items(&self, subscription_id: &str, works: &[Json]) -> Result<usize> {
        Ok(self.add_feed_items_ids(subscription_id, works)?.len())
    }

    /// As `add_feed_items`, answering the new items' ids.
    pub fn add_feed_items_ids(&self, subscription_id: &str, works: &[Json]) -> Result<Vec<String>> {
        let db = self.feeds_db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let now = now_ms();
        let mut added = Vec::new();
        for work in works.iter().take(500) {
            let Some(title) = text(work, "title") else { continue };
            let keys = work_keys(work);
            if keys.is_empty() {
                continue;
            }
            let mut known: Option<Option<String>> = None;
            for key in &keys {
                if let Some(item) = tx.query_row("SELECT item_id FROM feed_item_keys WHERE key = ?1", [key], |r| r.get::<_, Option<String>>(0)).optional().map_err(e)? {
                    known = Some(item);
                    if known.as_ref().is_some_and(Option::is_some) {
                        break;
                    }
                }
            }
            let item_id = match known {
                // Seen before and purged (or dismissed long ago): not brought back.
                Some(None) => continue,
                Some(Some(id)) => {
                    // A second source of the same work may know more (a DOI, an abstract).
                    let old: String = tx.query_row("SELECT work FROM feed_items WHERE id = ?1", [&id], |r| r.get(0)).map_err(e)?;
                    tx.execute("UPDATE feed_items SET work = ?2 WHERE id = ?1", params![id, merge_blanks(&old, work)]).map_err(e)?;
                    id
                }
                None => {
                    let id = new_id();
                    tx.execute(
                        "INSERT INTO feed_items(id, work, title, published, found_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![id, work.to_string(), title, text(work, "published"), now],
                    )
                    .map_err(e)?;
                    added.push(id.clone());
                    id
                }
            };
            for key in &keys {
                tx.execute("INSERT INTO feed_item_keys(key, item_id, at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET item_id = coalesce(item_id, excluded.item_id)", params![key, item_id, now]).map_err(e)?;
            }
            tx.execute("INSERT OR IGNORE INTO feed_item_subscriptions(item_id, subscription_id) VALUES (?1, ?2)", params![item_id, subscription_id]).map_err(e)?;
        }
        tx.commit().map_err(e)?;
        Ok(added)
    }

    fn item_conditions(query: &ItemQuery) -> (String, Vec<Value>) {
        let mut conditions = vec![match query.view.as_deref() {
            Some("unread") => "i.read = 0 AND i.dismissed_at IS NULL",
            Some("saved") => "i.saved = 1 AND i.dismissed_at IS NULL",
            Some("dismissed") => "i.dismissed_at IS NOT NULL",
            _ => "i.dismissed_at IS NULL",
        }
        .to_string()];
        let mut values = Vec::new();
        let keep: Vec<&String> = query.keep.iter().take(500).collect();
        if query.view.as_deref() == Some("unread") && !keep.is_empty() {
            conditions[0] = format!("(i.read = 0 OR i.id IN ({})) AND i.dismissed_at IS NULL", vec!["?"; keep.len()].join(","));
            values.extend(keep.into_iter().map(|id| Value::Text(id.clone())));
        }
        if let Some(id) = &query.subscription_id {
            conditions.push("EXISTS (SELECT 1 FROM feed_item_subscriptions x WHERE x.item_id = i.id AND x.subscription_id = ?)".into());
            values.push(Value::Text(id.clone()));
        }
        if query.saved_by_you {
            conditions.push("i.origin IS NOT NULL".into());
        }
        if let Some(kind) = &query.kind {
            conditions.push("EXISTS (SELECT 1 FROM feed_item_subscriptions x JOIN feed_subscriptions s ON s.id = x.subscription_id WHERE x.item_id = i.id AND s.kind = ?)".into());
            values.push(Value::Text(kind.clone()));
        }
        (format!("WHERE {}", conditions.join(" AND ")), values)
    }

    /// A page of items, newest first, each with what the library knows of it.
    pub fn feed_items(&self, query: &ItemQuery) -> Result<ItemPage> {
        let limit = query.limit.unwrap_or(100).clamp(1, 500);
        let (clause, values) = Self::item_conditions(query);
        let (mut items, total, unread, saved) = {
            let db = self.feeds_db()?;
            let total: i64 = db.query_row(&format!("SELECT count(*) FROM feed_items i {clause}"), params_from_iter(values.iter()), |r| r.get(0)).map_err(e)?;
            let sql = format!(
                "SELECT i.id, i.work, i.published, i.found_at, i.read, i.saved, i.dismissed_at, i.source_id,
                   (SELECT group_concat(s.title, char(31)) FROM feed_item_subscriptions x JOIN feed_subscriptions s ON s.id = x.subscription_id WHERE x.item_id = i.id),
                   (SELECT group_concat(x.subscription_id, char(31)) FROM feed_item_subscriptions x WHERE x.item_id = i.id),
                   i.origin
                 FROM feed_items i {clause}
                 ORDER BY coalesce(i.published, '') = '' , i.found_at DESC, i.published DESC, i.rowid DESC LIMIT {limit} OFFSET {}",
                query.offset
            );
            let mut statement = db.prepare(&sql).map_err(e)?;
            let split = |v: Option<String>| v.map(|v| v.split('\u{1f}').map(String::from).collect::<Vec<_>>()).unwrap_or_default();
            let items = statement
                .query_map(params_from_iter(values.iter()), |r| {
                    let source_id: Option<String> = r.get(7)?;
                    Ok(FeedItem {
                        id: r.get(0)?,
                        work: serde_json::from_str(&r.get::<_, String>(1)?).unwrap_or(Json::Null),
                        published: r.get(2)?,
                        found_at: r.get(3)?,
                        read: r.get::<_, i64>(4)? != 0,
                        saved: r.get::<_, i64>(5)? != 0,
                        dismissed: r.get::<_, Option<i64>>(6)?.is_some(),
                        added: source_id.is_some(),
                        source_id,
                        in_library: None,
                        subscriptions: split(r.get(8)?),
                        subscription_ids: split(r.get(9)?),
                        origin: r.get::<_, Option<String>>(10)?.and_then(|o| serde_json::from_str(&o).ok()),
                    })
                })
                .map_err(e)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(e)?;
            let unread: i64 = db.query_row("SELECT count(*) FROM feed_items WHERE read = 0 AND dismissed_at IS NULL", [], |r| r.get(0)).map_err(e)?;
            let saved: i64 = db.query_row("SELECT count(*) FROM feed_items WHERE saved = 1 AND dismissed_at IS NULL", [], |r| r.get(0)).map_err(e)?;
            (items, total as usize, unread, saved)
        };
        // "In library": the identifier matcher, certain matches only.
        let queries: Vec<MatchQuery> = items.iter().map(|i| match_query(&i.id, &i.work)).collect();
        for hit in self.match_identifiers(&queries)?.into_iter().filter(|h| h.certain) {
            if let Some(item) = items.iter_mut().find(|i| i.id == hit.key) {
                item.in_library = Some(hit.kind.to_string());
                item.source_id = item.source_id.take().or(Some(hit.source_id));
            }
        }
        for item in items.iter_mut().filter(|i| i.added && i.in_library.is_none()) {
            // Added, then trashed or merged: the source it became is gone.
            let live = self.source(&self.resolve_source_id(item.source_id.as_deref().unwrap_or(""))?)?.is_some_and(|s| s.trashed_at.is_none());
            if live {
                item.in_library = Some("added".into());
            }
        }
        let next = query.offset + items.len();
        Ok(ItemPage { next_offset: (next < total).then_some(next), items, total, unread, saved })
    }

    /// Marks items read or unread, saved or not, dismissed or back.
    pub fn set_feed_items(&self, ids: &[String], read: Option<bool>, saved: Option<bool>, dismissed: Option<bool>) -> Result<usize> {
        if ids.is_empty() {
            return Ok(0);
        }
        let db = self.feeds_db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let now = now_ms();
        let mut changed = 0;
        for id in ids {
            if let Some(read) = read {
                changed += tx.execute("UPDATE feed_items SET read = ?2 WHERE id = ?1 AND read <> ?2", params![id, read as i64]).map_err(e)?;
            }
            if let Some(saved) = saved {
                changed += tx.execute("UPDATE feed_items SET saved = ?2 WHERE id = ?1 AND saved <> ?2", params![id, saved as i64]).map_err(e)?;
            }
            match dismissed {
                // Dismissing reads it too.
                Some(true) => changed += tx.execute("UPDATE feed_items SET dismissed_at = ?2, read = 1, saved = 0 WHERE id = ?1 AND dismissed_at IS NULL", params![id, now]).map_err(e)?,
                Some(false) => changed += tx.execute("UPDATE feed_items SET dismissed_at = NULL WHERE id = ?1", [id]).map_err(e)?,
                None => {}
            }
        }
        tx.commit().map_err(e)?;
        Ok(changed)
    }

    /// An item added to the library: it is read, and remembers the source it became.
    pub fn feed_item_added(&self, id: &str, source_id: &str) -> Result<()> {
        let db = self.feeds_db()?;
        db.execute("UPDATE feed_items SET source_id = ?2, read = 1 WHERE id = ?1", params![id, source_id]).map_err(e)?;
        Ok(())
    }

    pub fn mark_feed_read(&self, query: &ItemQuery) -> Result<usize> {
        let (clause, values) = Self::item_conditions(&ItemQuery { view: Some("unread".into()), ..query.clone() });
        let db = self.feeds_db()?;
        db.execute(&format!("UPDATE feed_items SET read = 1 WHERE id IN (SELECT i.id FROM feed_items i {clause})"), params_from_iter(values.iter())).map_err(e)
    }

    /// Unread items, and those found since `since` (the status bar's quiet count).
    pub fn feed_counts(&self, since: Option<i64>) -> Result<Json> {
        let db = self.feeds_db()?;
        let unread: i64 = db.query_row("SELECT count(*) FROM feed_items WHERE read = 0 AND dismissed_at IS NULL", [], |r| r.get(0)).map_err(e)?;
        let fresh: i64 = db
            .query_row("SELECT count(*) FROM feed_items WHERE read = 0 AND dismissed_at IS NULL AND found_at > ?1", [since.unwrap_or(i64::MAX)], |r| r.get(0))
            .map_err(e)?;
        let subscriptions: i64 = db.query_row("SELECT count(*) FROM feed_subscriptions", [], |r| r.get(0)).map_err(e)?;
        let latest: Option<i64> = db.query_row("SELECT max(found_at) FROM feed_items", [], |r| r.get(0)).map_err(e)?;
        Ok(json!({ "unread": unread, "fresh": fresh, "subscriptions": subscriptions, "latest": latest }))
    }

    pub fn feed_retention(&self) -> Result<Retention> {
        Ok(self.meta(RETENTION_META)?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default())
    }

    pub fn set_feed_retention(&self, retention: &Retention) -> Result<Retention> {
        let clean = Retention { unread_days: retention.unread_days.clamp(0, 3650), read_days: retention.read_days.clamp(0, 3650), dismissed_days: retention.dismissed_days.clamp(0, 3650) };
        self.set_meta(RETENTION_META, &serde_json::to_string(&clean).map_err(e)?)?;
        Ok(clean)
    }

    /// Removes old items by the retention policy; saved and added items stay. Their keys stay
    /// seen, so the feed does not bring them back.
    pub fn purge_feed_items(&self, now: i64) -> Result<usize> {
        let r = self.feed_retention()?;
        let day = 86_400_000i64;
        let db = self.feeds_db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let mut doomed = Vec::new();
        let mut take = |sql: &str, days: i64| -> Result<()> {
            if days <= 0 {
                return Ok(());
            }
            let mut statement = tx.prepare(sql).map_err(e)?;
            let rows = statement.query_map([now - days * day], |r| r.get::<_, String>(0)).map_err(e)?;
            for row in rows {
                doomed.push(row.map_err(e)?);
            }
            Ok(())
        };
        take("SELECT id FROM feed_items WHERE dismissed_at IS NOT NULL AND dismissed_at < ?1", r.dismissed_days)?;
        take("SELECT id FROM feed_items WHERE dismissed_at IS NULL AND saved = 0 AND source_id IS NULL AND read = 0 AND found_at < ?1", r.unread_days)?;
        take("SELECT id FROM feed_items WHERE dismissed_at IS NULL AND saved = 0 AND source_id IS NULL AND read = 1 AND found_at < ?1", r.read_days)?;
        for id in &doomed {
            tx.execute("UPDATE feed_item_keys SET item_id = NULL WHERE item_id = ?1", [id]).map_err(e)?;
            tx.execute("DELETE FROM feed_item_subscriptions WHERE item_id = ?1", [id]).map_err(e)?;
            tx.execute("DELETE FROM feed_items WHERE id = ?1", [id]).map_err(e)?;
        }
        tx.execute("DELETE FROM feed_item_keys WHERE item_id IS NULL AND at < ?1", [now - SEEN_DAYS * day]).map_err(e)?;
        tx.commit().map_err(e)?;
        Ok(doomed.len())
    }

    /// OpenAlex work ids of the sources in a collection (or the whole library), most recently
    /// added first: what "new works citing these" asks about.
    pub fn openalex_ids_in(&self, collection_id: Option<&str>, source_id: Option<&str>, limit: usize) -> Result<Vec<String>> {
        let db = self.read()?;
        let (sql, values): (&str, Vec<Value>) = match (source_id, collection_id) {
            (Some(id), _) => ("SELECT openalex_id FROM sources s WHERE s.id = ?1 AND s.openalex_id IS NOT NULL", vec![Value::Text(id.into())]),
            (None, Some(c)) => (
                "SELECT s.openalex_id FROM sources s WHERE s.trashed_at IS NULL AND s.openalex_id IS NOT NULL AND s.id IN (SELECT sc.source_id FROM source_collections sc WHERE sc.collection_id IN (
                   WITH RECURSIVE tree(id) AS (SELECT ?1 UNION ALL SELECT c.id FROM collections c JOIN tree ON c.parent_id = tree.id) SELECT id FROM tree))
                 ORDER BY s.added_at DESC",
                vec![Value::Text(c.into())],
            ),
            (None, None) => ("SELECT s.openalex_id FROM sources s WHERE s.trashed_at IS NULL AND s.openalex_id IS NOT NULL ORDER BY s.added_at DESC", vec![]),
        };
        let mut statement = db.prepare(sql).map_err(e)?;
        let rows = statement.query_map(params_from_iter(values.iter()), |r| r.get::<_, String>(0)).map_err(e)?;
        let mut out = Vec::new();
        for row in rows {
            if let Some(id) = bare_openalex(&row.map_err(e)?) {
                if !out.contains(&id) {
                    out.push(id);
                }
            }
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }
}

/// The certain library match for each work, by position.
fn library_hits(store: &Store, works: &[Json]) -> Result<Vec<Option<String>>> {
    let queries: Vec<MatchQuery> = works.iter().enumerate().map(|(i, w)| match_query(&i.to_string(), w)).collect();
    let mut out = vec![None; works.len()];
    for hit in store.match_identifiers(&queries)?.into_iter().filter(|h| h.certain) {
        if let Ok(i) = hit.key.parse::<usize>() {
            if out.get(i).is_some_and(Option::is_none) {
                out[i] = Some(hit.source_id);
            }
        }
    }
    Ok(out)
}

/// The live item a work is already known as, by any of its keys.
fn known_item(db: &Connection, keys: &[String]) -> Result<Option<String>> {
    for key in keys {
        let item = db
            .query_row("SELECT k.item_id FROM feed_item_keys k JOIN feed_items i ON i.id = k.item_id WHERE k.key = ?1", [key], |r| r.get::<_, String>(0))
            .optional()
            .map_err(e)?;
        if item.is_some() {
            return Ok(item);
        }
    }
    Ok(None)
}

pub(crate) fn creator_of(name: &str) -> crate::Creator {
    let name = name.trim();
    if let Some((family, given)) = name.split_once(',') {
        return crate::Creator { family: Some(family.trim().into()), given: Some(given.trim().into()), literal: None, role: "author".into(), person_id: None };
    }
    let parts: Vec<&str> = name.split_whitespace().collect();
    match parts.split_last() {
        Some((family, given)) if !given.is_empty() => crate::Creator { family: Some((*family).into()), given: Some(given.join(" ")), literal: None, role: "author".into(), person_id: None },
        _ => crate::Creator { family: None, given: None, literal: Some(name.into()), role: "author".into(), person_id: None },
    }
}

impl Store {
    /// "Add to Inbox": keeps a work not in the library as an item the user saved, with where
    /// it was found. One the library has is not stored; one the Inbox has is saved, not
    /// repeated (and comes back if it was dismissed). Saved items are read: not news.
    pub fn save_to_inbox(&self, work: &Json, origin: &Json) -> Result<InboxSave> {
        let work = clean_work(work);
        let title = text(&work, "title").ok_or("This work has no title")?;
        if let Some(Some(source_id)) = library_hits(self, std::slice::from_ref(&work))?.into_iter().next() {
            return Ok(InboxSave { state: "library", item_id: None, source_id: Some(source_id), existed: true });
        }
        let keys = work_keys(&work);
        if keys.is_empty() {
            return Err("This work has no title or identifier to keep it by".into());
        }
        let mut origin = origin.as_object().cloned().unwrap_or_default();
        origin.retain(|_, v| !v.is_null());
        origin.insert("at".into(), json!(now_ms()));
        let origin = Json::Object(origin).to_string();
        let db = self.feeds_db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let now = now_ms();
        let (id, existed) = match known_item(&tx, &keys)? {
            Some(id) => {
                let (old, saved, dismissed): (String, i64, Option<i64>) =
                    tx.query_row("SELECT work, saved, dismissed_at FROM feed_items WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(e)?;
                tx.execute(
                    "UPDATE feed_items SET work = ?2, saved = 1, read = 1, dismissed_at = NULL, origin = coalesce(origin, ?3) WHERE id = ?1",
                    params![id, merge_blanks(&old, &work), origin],
                )
                .map_err(e)?;
                (id, saved == 1 && dismissed.is_none())
            }
            None => {
                let id = new_id();
                tx.execute(
                    "INSERT INTO feed_items(id, work, title, published, found_at, read, saved, origin) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, ?6)",
                    params![id, work.to_string(), title, text(&work, "published"), now, origin],
                )
                .map_err(e)?;
                (id, false)
            }
        };
        for key in &keys {
            tx.execute("INSERT INTO feed_item_keys(key, item_id, at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET item_id = coalesce(item_id, excluded.item_id)", params![key, id, now]).map_err(e)?;
        }
        tx.commit().map_err(e)?;
        Ok(InboxSave { state: "inbox", item_id: Some(id), source_id: None, existed })
    }

    /// Where each work stands: in the library, in the Inbox (not dismissed), or neither.
    pub fn inbox_states(&self, works: &[Json]) -> Result<Vec<InboxState>> {
        let works: Vec<Json> = works.iter().take(500).map(clean_work).collect();
        let library = library_hits(self, &works)?;
        let db = self.feeds_db()?;
        let mut out = Vec::with_capacity(works.len());
        for (work, source_id) in works.iter().zip(library) {
            if source_id.is_some() {
                out.push(InboxState { state: "library", item_id: None, source_id, saved: false });
                continue;
            }
            let item = known_item(&db, &work_keys(work))?;
            let live = match &item {
                Some(id) => db.query_row("SELECT saved FROM feed_items WHERE id = ?1 AND dismissed_at IS NULL", [id], |r| r.get::<_, i64>(0)).optional().map_err(e)?,
                None => None,
            };
            out.push(match live {
                Some(saved) => InboxState { state: "inbox", item_id: item, source_id: None, saved: saved == 1 },
                None => InboxState { state: "none", item_id: None, source_id: None, saved: false },
            });
        }
        Ok(out)
    }

    /// The journals, people and topics the library has most sources of: what to follow first.
    pub fn followable_in_library(&self, limit: usize) -> Result<Json> {
        let db = self.read()?;
        let run = |sql: &str| -> Result<Vec<LibraryEntity>> {
            let mut statement = db.prepare(sql).map_err(e)?;
            let rows = statement
                .query_map([limit as i64], |r| Ok(LibraryEntity { id: r.get(0)?, name: r.get(1)?, openalex_id: r.get(2)?, detail: r.get(3)?, count: r.get(4)? }))
                .map_err(e)?;
            rows.collect::<std::result::Result<Vec<_>, _>>().map_err(e)
        };
        let journals = run(
            "SELECT v.id, v.name, v.openalex_id, v.issn_l, count(*) n FROM sources s JOIN venues v ON v.id = s.venue_id
             WHERE s.trashed_at IS NULL AND coalesce(v.type, 'journal') NOT IN ('repository', 'ebook platform') GROUP BY v.id HAVING n >= 2 ORDER BY n DESC, v.name LIMIT ?1",
        )?;
        let people = run(
            "SELECT p.id, p.name, p.openalex_id, p.orcid, count(DISTINCT sp.source_id) n FROM source_people sp JOIN people p ON p.id = sp.person_id JOIN sources s ON s.id = sp.source_id
             WHERE s.trashed_at IS NULL GROUP BY p.id HAVING n >= 2 ORDER BY n DESC, p.name LIMIT ?1",
        )?;
        let topics = run(
            "SELECT t.id, t.name, t.id, t.level, count(DISTINCT st.source_id) n FROM source_topics st JOIN topics t ON t.id = st.topic_id JOIN sources s ON s.id = st.source_id
             WHERE s.trashed_at IS NULL AND t.level IN ('topic', 'subfield') GROUP BY t.id HAVING n >= 2 ORDER BY n DESC, t.name LIMIT ?1",
        )?;
        Ok(json!({ "journals": journals, "people": people, "topics": topics }))
    }

    /// How many library sources each OpenAlex journal (S…) or author (A…) has.
    pub fn library_counts_for_openalex(&self, ids: &[String]) -> Result<Map<String, Json>> {
        let db = self.read()?;
        let mut out = Map::new();
        for id in ids.iter().take(50) {
            let short = id.trim().trim_end_matches('/').rsplit('/').next().unwrap_or("").to_uppercase();
            let sql = match short.chars().next() {
                Some('S') => "SELECT count(*) FROM sources s JOIN venues v ON v.id = s.venue_id WHERE s.trashed_at IS NULL AND upper(v.openalex_id) = ?1",
                Some('A') => "SELECT count(DISTINCT sp.source_id) FROM source_people sp JOIN people p ON p.id = sp.person_id JOIN sources s ON s.id = sp.source_id WHERE s.trashed_at IS NULL AND upper(p.openalex_id) = ?1",
                _ => continue,
            };
            let n: i64 = db.query_row(sql, [&short], |r| r.get(0)).map_err(e)?;
            if n > 0 {
                out.insert(short, json!(n));
            }
        }
        Ok(out)
    }

    /// Adds new items to the library on their own, into a collection (a subscription's
    /// "also add to …"). Answers how many sources were made.
    pub fn auto_add_feed_items(&self, item_ids: &[String], collection_id: &str) -> Result<usize> {
        let mut added = 0;
        for id in item_ids.iter().take(100) {
            let work: Option<String> = self.feeds_db()?.query_row("SELECT work FROM feed_items WHERE id = ?1 AND source_id IS NULL", [id], |r| r.get(0)).optional().map_err(e)?;
            let Some(work) = work.and_then(|w| serde_json::from_str::<Json>(&w).ok()) else { continue };
            if library_hits(self, std::slice::from_ref(&work))?.first().is_some_and(Option::is_some) {
                continue;
            }
            let source = self.insert_source(crate::inbox_selection::work_source_input(&work, vec![collection_id.to_string()]))?;
            self.feed_item_added(id, &source.id)?;
            added += 1;
        }
        Ok(added)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }

    fn subscribe(store: &Store, kind: &str, config: Json) -> Subscription {
        store.save_feed_subscription(&SubscriptionInput { kind: kind.into(), title: Some("T".into()), config: config.as_object().cloned(), ..Default::default() }).unwrap()
    }

    #[test]
    fn keys_cover_every_identifier() {
        let keys = work_keys(&json!({ "title": "A long enough title here", "year": 2024, "doi": "https://doi.org/10.48550/arXiv.2401.00001", "landingUrl": "https://www.example.org/a?utm_source=x" }));
        assert_eq!(keys, ["arxiv:2401.00001", "doi:10.48550/arxiv.2401.00001", "url:example.org/a", "title:a long enough title here|2024"]);
    }

    #[test]
    fn items_are_deduplicated_across_subscriptions_and_matched_with_the_library() {
        let (_dir, store) = store();
        let a = subscribe(&store, "rss", json!({ "url": "https://a.example/feed" }));
        let b = subscribe(&store, "openalex", json!({ "query": "x" }));
        assert_eq!(subscribe(&store, "rss", json!({ "url": "https://A.example/feed/" })).id, a.id, "the same feed is one subscription");
        let one = json!({ "title": "Graph neural networks for chemistry", "doi": "10.1/abc", "year": 2025 });
        assert_eq!(store.add_feed_items(&a.id, &[one.clone()]).unwrap(), 1);
        // The same work from OpenAlex, with its abstract, by DOI.
        let again = json!({ "title": "Graph Neural Networks for Chemistry", "doi": "https://doi.org/10.1/ABC", "abstract": "We…", "ids": { "openalex": "W1" } });
        assert_eq!(store.add_feed_items(&b.id, &[again]).unwrap(), 0);
        let page = store.feed_items(&ItemQuery::default()).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].work["abstract"], "We…");
        assert_eq!(page.items[0].subscription_ids.len(), 2);
        assert_eq!(page.unread, 1);
        assert_eq!(store.feed_subscriptions().unwrap().iter().map(|s| s.unread).collect::<Vec<_>>(), [1, 1]);
        // The library has it: "In library".
        let mut fields = Map::new();
        fields.insert("title".into(), json!("Graph neural networks for chemistry"));
        fields.insert("doi".into(), json!("10.1/abc"));
        let source = store.insert_source(crate::SourceInput { kind: "reference".into(), fields, ..Default::default() }).unwrap();
        let page = store.feed_items(&ItemQuery::default()).unwrap();
        assert_eq!((page.items[0].in_library.as_deref(), page.items[0].source_id.as_deref()), (Some("doi"), Some(source.id.as_str())));
    }

    #[test]
    fn triage_states_views_and_retention() {
        let (_dir, store) = store();
        let s = subscribe(&store, "rss", json!({ "url": "https://a.example/feed" }));
        let works: Vec<Json> = (0..3).map(|i| json!({ "title": format!("Work number {i} with a title"), "landingUrl": format!("https://a.example/{i}") })).collect();
        assert_eq!(store.add_feed_items(&s.id, &works).unwrap(), 3);
        let ids: Vec<String> = store.feed_items(&ItemQuery::default()).unwrap().items.iter().map(|i| i.id.clone()).collect();
        store.set_feed_items(&ids[..1], None, None, Some(true)).unwrap();
        store.set_feed_items(&ids[1..2], None, Some(true), None).unwrap();
        let view = |v: &str| store.feed_items(&ItemQuery { view: Some(v.into()), ..Default::default() }).unwrap().total;
        assert_eq!((view("all"), view("unread"), view("saved"), view("dismissed")), (2, 2, 1, 1));
        store.mark_feed_read(&ItemQuery::default()).unwrap();
        assert_eq!(view("unread"), 0);
        let kept = store.feed_items(&ItemQuery { view: Some("unread".into()), keep: vec![ids[2].clone()], ..Default::default() }).unwrap();
        assert_eq!(kept.total, 1, "read while shown: still listed");
        // A dismissed item is not brought back by the feed that still lists it, even purged.
        store.set_feed_retention(&Retention { unread_days: 1, read_days: 1, dismissed_days: 1 }).unwrap();
        let later = now_ms() + 2 * 86_400_000;
        assert_eq!(store.purge_feed_items(later).unwrap(), 2, "the dismissed one and the read one; the saved one stays");
        assert_eq!(store.add_feed_items(&s.id, &works).unwrap(), 0);
        assert_eq!(view("all"), 1);
    }

    #[test]
    fn saved_works_are_kept_once_with_their_origin_and_are_not_news() {
        let (_dir, store) = store();
        let work = json!({ "title": "Sparse attention for long documents", "doi": "10.5/sparse", "year": 2024, "authors": ["Ada Lovelace"], "key": "doi:x", "foundBy": ["openalex"], "rank": 0 });
        let origin = json!({ "kind": "web-search", "label": "sparse attention", "query": "sparse attention", "sourceId": null });
        assert_eq!(store.inbox_states(std::slice::from_ref(&work)).unwrap()[0].state, "none");
        let saved = store.save_to_inbox(&work, &origin).unwrap();
        assert_eq!((saved.state, saved.existed), ("inbox", false));
        let again = store.save_to_inbox(&json!({ "title": "Sparse Attention for Long Documents", "doi": "https://doi.org/10.5/SPARSE" }), &json!({ "kind": "page" })).unwrap();
        assert_eq!((again.item_id.as_deref(), again.existed), (saved.item_id.as_deref(), true));
        let page = store.feed_items(&ItemQuery { view: Some("saved".into()), ..Default::default() }).unwrap();
        assert_eq!(page.total, 1);
        let item = &page.items[0];
        assert_eq!((item.origin.as_ref().unwrap()["label"].as_str(), item.origin.as_ref().unwrap()["kind"].as_str()), (Some("sparse attention"), Some("web-search")));
        assert!(item.work.get("foundBy").is_none(), "ranking noise is not kept");
        assert_eq!((page.unread, store.feed_counts(None).unwrap()["unread"].as_i64()), (0, Some(0)), "saved by you is not unread news");
        assert_eq!(store.feed_items(&ItemQuery { saved_by_you: true, ..Default::default() }).unwrap().total, 1);
        let state = &store.inbox_states(std::slice::from_ref(&work)).unwrap()[0];
        assert_eq!((state.state, state.saved), ("inbox", true));
        // Dismissed, then saved again: back.
        store.set_feed_items(std::slice::from_ref(saved.item_id.as_ref().unwrap()), None, None, Some(true)).unwrap();
        assert_eq!(store.inbox_states(std::slice::from_ref(&work)).unwrap()[0].state, "none");
        assert!(!store.save_to_inbox(&work, &origin).unwrap().existed);
        // In the library: not stored.
        let mut fields = Map::new();
        fields.insert("title".into(), json!("Sparse attention for long documents"));
        fields.insert("doi".into(), json!("10.5/sparse"));
        let source = store.insert_source(crate::SourceInput { kind: "reference".into(), fields, ..Default::default() }).unwrap();
        let out = store.save_to_inbox(&work, &origin).unwrap();
        assert_eq!((out.state, out.source_id.as_deref()), ("library", Some(source.id.as_str())));
        assert_eq!(store.inbox_states(&[work]).unwrap()[0].state, "library");
    }

    #[test]
    fn new_items_can_be_added_to_a_collection_on_their_own() {
        let (_dir, store) = store();
        let s = subscribe(&store, "venue", json!({ "openalexId": "S1" }));
        let collection = store.create_collection("Auto", None, None).unwrap();
        let ids = store.add_feed_items_ids(&s.id, &[json!({ "title": "An automatically added article", "doi": "10.9/auto", "authors": ["Grace Hopper"], "venue": "J" })]).unwrap();
        assert_eq!(store.auto_add_feed_items(&ids, &collection.id).unwrap(), 1);
        let item = store.feed_items(&ItemQuery::default()).unwrap().items.remove(0);
        assert!(item.added && item.read);
        let source = store.source(item.source_id.as_deref().unwrap()).unwrap().unwrap();
        assert!(source.collections.contains(&collection.id));
        assert_eq!(source.creators[0].family.as_deref(), Some("Hopper"));
        assert_eq!(store.auto_add_feed_items(&ids, &collection.id).unwrap(), 0, "only once");
        let picks = store.followable_in_library(5).unwrap();
        assert!(picks["journals"].as_array().unwrap().is_empty(), "one source is not enough to suggest");
    }

    #[test]
    fn checks_back_off_after_failures() {
        let (_dir, store) = store();
        let s = subscribe(&store, "rss", json!({ "url": "https://a.example/feed" }));
        assert_eq!(store.due_feed_subscriptions(now_ms()).unwrap().len(), 1);
        store.record_feed_check(&s.id, &Check { ok: true, etag: Some("\"e1\"".into()), ..Default::default() }).unwrap();
        let ok = store.feed_subscription(&s.id).unwrap().unwrap();
        assert!(ok.next_at.unwrap() - ok.checked_at.unwrap() == 180 * 60_000);
        store.record_feed_check(&s.id, &Check { ok: false, error: Some("down".into()), ..Default::default() }).unwrap();
        store.record_feed_check(&s.id, &Check { ok: false, error: Some("down".into()), ..Default::default() }).unwrap();
        let failed = store.feed_subscription(&s.id).unwrap().unwrap();
        assert_eq!((failed.failures, failed.etag.as_deref(), failed.last_error.as_deref()), (2, Some("\"e1\""), Some("down")));
        assert_eq!(failed.next_at.unwrap() - failed.checked_at.unwrap(), 4 * 60 * 60_000);
        assert!(store.due_feed_subscriptions(now_ms()).unwrap().is_empty());
        store.feed_check_now(Some(&s.id)).unwrap();
        assert_eq!(store.due_feed_subscriptions(now_ms()).unwrap().len(), 1);
        store.save_feed_subscription(&SubscriptionInput { id: Some(s.id.clone()), paused: Some(true), ..Default::default() }).unwrap();
        assert!(store.due_feed_subscriptions(now_ms()).unwrap().is_empty());
        store.delete_feed_subscription(&s.id).unwrap();
        assert!(store.feed_subscriptions().unwrap().is_empty());
    }
}
