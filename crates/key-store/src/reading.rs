// Reading status and history: each source is unread, being read or read (`sources.read_state`;
// none counts as unread). Opening it in a reader moves it to "reading" and reaching its last
// page to "read", but never past a status the user chose by hand. When it was last opened and
// last read, the page reached and how many pages were seen are kept beside it. Status is
// Key's own: Zotero sync does not carry it.
//
// Related items: links the user makes between two sources (both ways, journaled for undo as
// `related` pairs), shown beside what the library knows on its own: the sources one cites
// and those citing it (from stored references), and linked versions.
use crate::{BatchEdit, Operation, Result, Source, Store, e, now_ms};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value as Json, json};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS source_reading (
  source_id TEXT PRIMARY KEY,
  opened_at INTEGER,
  read_at INTEGER,
  finished_at INTEGER,
  manual INTEGER NOT NULL DEFAULT 0,
  page INTEGER,
  max_page INTEGER,
  pages_seen TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS source_reading_read ON source_reading(read_at);
";

pub(crate) fn ensure_schema(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA).map_err(e)
}

pub const STATUSES: &[&str] = &["unread", "reading", "read"];

/// The status a source shows: what is stored, or unread.
pub(crate) const STATUS_SQL: &str = "coalesce(nullif(s.read_state, ''), 'unread')";
/// When it was last read (any page change), for filters and sorting.
pub(crate) const LAST_READ_SQL: &str = "(SELECT r.read_at FROM source_reading r WHERE r.source_id = s.id)";

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub status: String,
    pub manual: bool,
    pub opened_at: Option<i64>,
    pub read_at: Option<i64>,
    pub finished_at: Option<i64>,
    /// The page last shown (0-based).
    pub page: Option<i64>,
    pub max_page: Option<i64>,
    pub pages_read: i64,
    pub page_count: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Related {
    /// Linked by the user.
    pub manual: Vec<Source>,
    /// Sources this one cites (its references matched in the library).
    pub cites: Vec<Source>,
    /// Sources that cite this one.
    pub cited_by: Vec<Source>,
    /// Other versions of the same work (a preprint and its published version).
    pub versions: Vec<Source>,
}

/// Pages seen, as a run-length string of 0-based pages ("0-4,7").
fn pages_add(seen: &str, page: i64) -> String {
    let mut pages: Vec<i64> = seen
        .split(',')
        .filter(|p| !p.is_empty())
        .flat_map(|run| {
            let (a, b) = run.split_once('-').unwrap_or((run, run));
            let (a, b) = (a.parse().unwrap_or(0), b.parse().unwrap_or(0));
            a..=b.min(a + 100_000)
        })
        .collect();
    pages.push(page);
    pages.sort_unstable();
    pages.dedup();
    let mut runs: Vec<(i64, i64)> = Vec::new();
    for p in pages {
        match runs.last_mut() {
            Some((_, end)) if *end + 1 == p => *end = p,
            _ => runs.push((p, p)),
        }
    }
    runs.iter().map(|(a, b)| if a == b { a.to_string() } else { format!("{a}-{b}") }).collect::<Vec<_>>().join(",")
}

fn pages_count(seen: &str) -> i64 {
    seen.split(',').filter(|p| !p.is_empty()).map(|run| {
        let (a, b) = run.split_once('-').unwrap_or((run, run));
        b.parse::<i64>().unwrap_or(0) - a.parse::<i64>().unwrap_or(0) + 1
    }).sum()
}

impl Store {
    fn reading_db(&self) -> Result<crate::priority::Guard<'_, Connection>> {
        let db = self.db()?;
        ensure_schema(&db)?;
        Ok(db)
    }

    pub fn reading(&self, id: &str) -> Result<Reading> {
        let db = self.reading_db()?;
        let id = crate::journal::resolve_source(&db, id)?;
        let (status, page_count): (Option<String>, Option<i64>) =
            db.query_row("SELECT read_state, page_count FROM sources WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(e)?.ok_or("Source not found")?;
        let row = db
            .query_row("SELECT opened_at, read_at, finished_at, manual, page, max_page, pages_seen FROM source_reading WHERE source_id = ?1", [&id], |r| {
                Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, i64>(3)?, r.get::<_, Option<i64>>(4)?, r.get::<_, Option<i64>>(5)?, r.get::<_, String>(6)?))
            })
            .optional()
            .map_err(e)?;
        let status = status.filter(|s| STATUSES.contains(&s.as_str())).unwrap_or_else(|| "unread".into());
        Ok(match row {
            Some((opened_at, read_at, finished_at, manual, page, max_page, seen)) => {
                Reading { status, manual: manual != 0, opened_at, read_at, finished_at, page, max_page, pages_read: pages_count(&seen), page_count }
            }
            None => Reading { status, page_count, ..Default::default() },
        })
    }

    /// What a reader saw: `open` when a source is opened, `page` as its pages change (0-based,
    /// with the document's page count when the reader knows it). Answers the reading state.
    pub fn reading_event(&self, id: &str, kind: &str, page: Option<i64>, page_count: Option<i64>) -> Result<Reading> {
        {
            let db = self.reading_db()?;
            let id = crate::journal::resolve_source(&db, id)?;
            let now = now_ms();
            let (status, stored_count): (Option<String>, Option<i64>) =
                db.query_row("SELECT read_state, page_count FROM sources WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(e)?.ok_or("Source not found")?;
            db.execute("INSERT OR IGNORE INTO source_reading(source_id) VALUES (?1)", [&id]).map_err(e)?;
            let (manual, seen): (i64, String) = db.query_row("SELECT manual, pages_seen FROM source_reading WHERE source_id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
            if kind == "open" {
                db.execute("UPDATE source_reading SET opened_at = ?2 WHERE source_id = ?1", params![id, now]).map_err(e)?;
            }
            let count = page_count.filter(|c| *c > 0).or(stored_count.filter(|c| *c > 0));
            let current = status.clone().filter(|s| STATUSES.contains(&s.as_str())).unwrap_or_else(|| "unread".into());
            let mut next = current.clone();
            if let Some(page) = page.filter(|p| *p >= 0) {
                let seen = pages_add(&seen, page);
                db.execute(
                    "UPDATE source_reading SET read_at = ?2, page = ?3, max_page = max(coalesce(max_page, 0), ?3), pages_seen = ?4 WHERE source_id = ?1",
                    params![id, now, page, seen],
                )
                .map_err(e)?;
                if manual == 0 {
                    // The last page reached: read. A document of one page is read once opened.
                    if count.is_some_and(|c| page + 1 >= c) {
                        if next != "read" {
                            db.execute("UPDATE source_reading SET finished_at = ?2 WHERE source_id = ?1", params![id, now]).map_err(e)?;
                        }
                        next = "read".into();
                    } else if next == "unread" {
                        next = "reading".into();
                    }
                }
            } else if manual == 0 && next == "unread" && kind == "open" {
                next = "reading".into();
            }
            if next != current && manual == 0 {
                db.execute("UPDATE sources SET read_state = ?2 WHERE id = ?1", params![id, next]).map_err(e)?;
            }
        }
        self.reading(id)
    }

    /// The user's choice of status for these sources, journaled; automatic changes never
    /// override it. `None` gives the status back to the reader.
    pub fn set_reading_status(&self, ids: &[String], status: Option<&str>) -> Result<Operation> {
        if let Some(status) = status {
            if !STATUSES.contains(&status) {
                return Err(format!("Unknown reading status {status}"));
            }
        }
        let mut patch = Map::new();
        patch.insert("readState".into(), status.map(Json::from).unwrap_or(Json::Null));
        let label = match status {
            Some("read") => "Mark as read",
            Some("reading") => "Mark as in progress",
            Some(_) => "Mark as unread",
            None => "Reset reading status",
        };
        let n = ids.len();
        let label = if n == 1 { label.to_string() } else { format!("{label} ({n} sources)") };
        let operation = self.edit_sources(ids, &BatchEdit { patch, by_hand: false, ..Default::default() }, Some(&label))?;
        let db = self.reading_db()?;
        let now = now_ms();
        for id in ids {
            db.execute("INSERT OR IGNORE INTO source_reading(source_id) VALUES (?1)", [id]).map_err(e)?;
            db.execute("UPDATE source_reading SET manual = ?2 WHERE source_id = ?1", params![id, status.is_some() as i64]).map_err(e)?;
            if status == Some("read") {
                db.execute("UPDATE source_reading SET finished_at = coalesce(finished_at, ?2) WHERE source_id = ?1", params![id, now]).map_err(e)?;
            }
        }
        Ok(operation)
    }

    /// Links two sources as related (both ways), or unlinks them; undoable.
    pub fn link_related(&self, a: &str, b: &str, linked: bool) -> Result<Operation> {
        if a == b {
            return Err("A source cannot be related to itself".into());
        }
        let (affected, entry) = self.journaled("pairs", if linked { "Link related sources" } else { "Unlink related sources" }, &[], |db, recorder| {
            let a = crate::journal::resolve_source(db, a)?;
            let b = crate::journal::resolve_source(db, b)?;
            for id in [&a, &b] {
                let exists: bool = db.query_row("SELECT count(*) FROM sources WHERE id = ?1", [id], |r| r.get::<_, i64>(0)).map_err(e)? > 0;
                if !exists {
                    return Err("Source not found".into());
                }
            }
            Ok(usize::from(recorder.pair(db, &a, &b, "related", linked)?))
        })?;
        Ok(Operation { affected, entry })
    }

    /// The related sources around one: linked by hand, cited, citing and versions.
    pub fn related_sources(&self, id: &str) -> Result<Related> {
        let ids = |sql: &str| -> Result<Vec<String>> {
            let db = self.read()?;
            let mut statement = db.prepare(sql).map_err(e)?;
            let rows = statement.query_map([id], |r| r.get::<_, String>(0)).map_err(e)?;
            rows.collect::<std::result::Result<_, _>>().map_err(e)
        };
        let live = |ids: Vec<String>| -> Result<Vec<Source>> {
            let mut out: Vec<Source> = Vec::new();
            for id in ids {
                if let Some(source) = self.source(&id)?.filter(|s| s.trashed_at.is_none()) {
                    if !out.iter().any(|o| o.id == source.id) {
                        out.push(source);
                    }
                }
                if out.len() >= 200 {
                    break;
                }
            }
            Ok(out)
        };
        let pair = |kind: &str| format!("SELECT CASE WHEN a = ?1 THEN b ELSE a END FROM source_pairs WHERE kind = '{kind}' AND (a = ?1 OR b = ?1) ORDER BY created_at DESC");
        let manual = live(ids(&pair("related"))?)?;
        let versions = live(ids(&pair("version"))?)?;
        let cites = live(ids(
            "SELECT matched_source_id FROM source_references WHERE source_id = ?1 AND matched_source_id IS NOT NULL AND matched_source_id <> ?1
             UNION SELECT matched_source_id FROM source_cites WHERE source_id = ?1 AND matched_source_id IS NOT NULL AND matched_source_id <> ?1",
        )?)?;
        let cited_by = live(ids(
            "SELECT source_id FROM source_references WHERE matched_source_id = ?1 AND source_id <> ?1
             UNION SELECT source_id FROM source_cites WHERE matched_source_id = ?1 AND source_id <> ?1",
        )?)?;
        Ok(Related { manual, cites, cited_by, versions })
    }

    /// For lists: last opened and last read, by source id.
    pub(crate) fn reading_columns() -> [&'static str; 2] {
        ["(SELECT r.opened_at FROM source_reading r WHERE r.source_id = s.id)", LAST_READ_SQL]
    }
}

/// `read:>2026-01-01` style dates (and plain ms) as milliseconds since the epoch, UTC.
pub fn date_ms(text: &str) -> Option<i64> {
    let t = text.trim();
    if t.len() >= 10 && t.chars().all(|c| c.is_ascii_digit()) {
        return t.parse().ok();
    }
    let mut parts = t.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next().map(|m| m.parse().ok()).unwrap_or(Some(1))?;
    let day: i64 = parts.next().map(|d| d.get(..2).unwrap_or(d).parse().ok()).unwrap_or(Some(1))?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(1000..=9999).contains(&year) {
        return None;
    }
    let (y, m) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + day - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    Some(days * 86_400_000)
}

pub(crate) fn decorate(fields: &mut Map<String, Json>, opened: Option<i64>, read: Option<i64>) {
    if let Some(at) = opened {
        fields.insert("lastOpenedAt".into(), json!(at));
    }
    if let Some(at) = read {
        fields.insert("lastReadAt".into(), json!(at));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SourceInput;

    fn source(store: &Store, pages: i64) -> String {
        let mut fields = Map::new();
        fields.insert("title".into(), json!("A paper"));
        fields.insert("pageCount".into(), json!(pages));
        store.insert_source(SourceInput { kind: "pdf".into(), fields, ..Default::default() }).unwrap().id
    }

    #[test]
    fn opening_and_reaching_the_end_advance_the_status_but_never_a_manual_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let id = source(&store, 3);
        assert_eq!(store.reading(&id).unwrap().status, "unread");
        assert_eq!(store.reading_event(&id, "open", Some(0), None).unwrap().status, "reading");
        let r = store.reading_event(&id, "page", Some(1), None).unwrap();
        assert_eq!((r.status.as_str(), r.pages_read, r.page), ("reading", 2, Some(1)));
        let r = store.reading_event(&id, "page", Some(2), None).unwrap();
        assert_eq!(r.status, "read");
        assert!(r.finished_at.is_some() && r.read_at.is_some() && r.opened_at.is_some());
        // The user says unread: reading again does not change it.
        store.set_reading_status(std::slice::from_ref(&id), Some("unread")).unwrap();
        assert_eq!(store.reading_event(&id, "page", Some(2), None).unwrap().status, "unread");
        assert!(store.reading(&id).unwrap().manual);
        // Undo puts the status back; giving it back to the reader lets it advance again.
        store.undo().unwrap();
        assert_eq!(store.reading(&id).unwrap().status, "read");
        store.set_reading_status(std::slice::from_ref(&id), None).unwrap();
        assert_eq!(store.reading_event(&id, "page", Some(0), None).unwrap().status, "reading");
        // Filters and scopes.
        let other = source(&store, 10);
        let list = |filters: Json, scope: Option<&str>| {
            let query = crate::ListQuery { filters: serde_json::from_value(filters).unwrap(), scope: scope.map(String::from), ..Default::default() };
            store.list_sources(&query).unwrap().items.iter().map(|s| s.id.clone()).collect::<Vec<_>>()
        };
        assert_eq!(list(json!([{ "field": "status", "value": "unread" }]), None), [other.clone()]);
        assert_eq!(list(json!([{ "field": "status", "value": "reading" }]), None), [id.clone()]);
        assert_eq!(list(json!([{ "field": "read", "op": "gt", "value": "2020-01-01" }]), None), [id.clone()]);
        assert_eq!(list(json!([]), Some("recent")), [id.clone()]);
        assert_eq!(list(json!([]), Some("toread")), [id.clone()], "in progress; an untouched source is not queued");
        store.set_reading_status(std::slice::from_ref(&other), Some("unread")).unwrap();
        assert_eq!(list(json!([]), Some("toread")).len(), 2);
        let page = store.list_sources(&crate::ListQuery { ids: Some(vec![id.clone()]), ..Default::default() }).unwrap();
        assert!(page.items[0].fields.contains_key("lastReadAt"));
    }

    #[test]
    fn related_links_go_both_ways_and_undo() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let (a, b) = (source(&store, 1), source(&store, 1));
        assert_eq!(store.link_related(&a, &b, true).unwrap().affected, 1);
        assert_eq!(store.related_sources(&b).unwrap().manual[0].id, a);
        assert_eq!(store.related_sources(&a).unwrap().manual[0].id, b);
        store.undo().unwrap();
        assert!(store.related_sources(&a).unwrap().manual.is_empty());
        store.redo().unwrap();
        assert_eq!(store.related_sources(&a).unwrap().manual.len(), 1);
        assert!(store.link_related(&a, &a, true).is_err());
    }

    #[test]
    fn reads_dates_and_page_runs() {
        assert_eq!(date_ms("1970-01-02"), Some(86_400_000));
        assert_eq!(date_ms("2026-01"), date_ms("2026-01-01"));
        assert_eq!(date_ms("soon"), None);
        assert_eq!(pages_add("0-2,5", 3), "0-3,5");
        assert_eq!(pages_count("0-3,5"), 5);
    }
}
