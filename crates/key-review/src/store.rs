// The reviews of a workspace in one SQLite file (`reviews.sqlite3` beside the library): the
// event log, and the records materialised from `records.add` events so lists page and search
// in SQL. Each open review's derived state is cached in memory and updated as events append.
use crate::derive::State;
use crate::events::{Event, random_u64, uuid7};
use crate::model::*;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value as Json, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

pub type Result<T> = std::result::Result<T, String>;
pub(crate) fn e(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub struct Reviews {
    inner: Mutex<Inner>,
}

pub struct Inner {
    pub conn: Connection,
    pub device: String,
    states: HashMap<String, State>,
}

/// Records are written to the log in chunks of this many (one event each).
pub const CHUNK: usize = 500;

pub fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS review_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS review_events (
             seq INTEGER PRIMARY KEY AUTOINCREMENT,
             id TEXT NOT NULL UNIQUE,
             review_id TEXT NOT NULL,
             at INTEGER NOT NULL,
             actor TEXT NOT NULL,
             device TEXT NOT NULL DEFAULT '',
             kind TEXT NOT NULL,
             version TEXT NOT NULL DEFAULT '',
             record_id TEXT,
             payload TEXT NOT NULL DEFAULT '{}'
         );
         CREATE INDEX IF NOT EXISTS review_events_order ON review_events(review_id, at, id);
         CREATE INDEX IF NOT EXISTS review_events_record ON review_events(review_id, record_id);
         CREATE TABLE IF NOT EXISTS review_records (
             review_id TEXT NOT NULL,
             id TEXT NOT NULL,
             pos INTEGER NOT NULL,
             batch_id TEXT NOT NULL,
             title TEXT NOT NULL DEFAULT '',
             abstract TEXT NOT NULL DEFAULT '',
             authors TEXT NOT NULL DEFAULT '',
             year INTEGER,
             journal TEXT NOT NULL DEFAULT '',
             doi TEXT NOT NULL DEFAULT '',
             meta TEXT NOT NULL,
             PRIMARY KEY (review_id, id)
         );
         CREATE INDEX IF NOT EXISTS review_records_pos ON review_records(review_id, pos);",
    )
    .map_err(e)
}

impl Reviews {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).map_err(e)?;
        let conn = Connection::open(dir.join("reviews.sqlite3")).map_err(e)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;").map_err(e)?;
        Self::with(conn)
    }

    pub fn in_memory() -> Result<Self> {
        Self::with(Connection::open_in_memory().map_err(e)?)
    }

    fn with(conn: Connection) -> Result<Self> {
        ensure_schema(&conn)?;
        let device = match conn.query_row("SELECT value FROM review_meta WHERE key = 'device'", [], |r| r.get::<_, String>(0)).optional().map_err(e)? {
            Some(d) => d,
            None => {
                let d = format!("d{:012x}", random_u64() & 0xffff_ffff_ffff);
                conn.execute("INSERT INTO review_meta (key, value) VALUES ('device', ?1)", [&d]).map_err(e)?;
                d
            }
        };
        Ok(Reviews { inner: Mutex::new(Inner { conn, device, states: HashMap::new() }) })
    }

    pub fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn device(&self) -> String {
        self.lock().device.clone()
    }

    /// Every review, newest activity first.
    pub fn list_reviews(&self) -> Result<Vec<Json>> {
        let mut inner = self.lock();
        let ids: Vec<String> = {
            let mut st = inner.conn.prepare("SELECT DISTINCT review_id FROM review_events WHERE kind = 'review.create'").map_err(e)?;
            st.query_map([], |r| r.get(0)).map_err(e)?.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        let mut out = Vec::new();
        for id in ids {
            let state = inner.state(&id)?;
            let ta = state.stage_counts(Stage::Ta, "");
            let ft = state.stage_counts(Stage::Ft, "");
            out.push(json!({
                "id": id, "name": state.info.name, "createdAt": state.info.created_at, "updatedAt": state.info.updated_at, "archived": state.info.archived,
                "records": state.records.iter().filter(|r| state.active(r)).count(), "included": state.included().len(),
                "taDone": ta["done"], "taEligible": ta["eligible"], "ftDone": ft["done"], "ftEligible": ft["eligible"],
            }));
        }
        out.sort_by_key(|r| std::cmp::Reverse(r["updatedAt"].as_i64().unwrap_or(0)));
        Ok(out)
    }

    /// A new review with the default (or given) protocol and one owner.
    pub fn create(&self, name: &str, owner_name: &str, protocol: Option<Protocol>) -> Result<(String, String)> {
        let name = name.trim();
        let id = uuid7();
        let owner = format!("m{:08x}", random_u64() & 0xffff_ffff);
        let protocol = protocol.unwrap_or_default();
        protocol.validate()?;
        let owner_name = if owner_name.trim().is_empty() { "Me" } else { owner_name.trim() };
        let initials: String = owner_name.split_whitespace().filter_map(|w| w.chars().next()).take(2).collect::<String>().to_uppercase();
        let mut inner = self.lock();
        let device = inner.device.clone();
        let created = Event::new(&id, "review.create", &owner, &device, "", None, json!({ "name": if name.is_empty() { "Untitled review" } else { name } }));
        let team = Event::new(&id, "team.set", &owner, &device, "", None, json!({ "members": [Member { id: owner.clone(), name: owner_name.into(), roles: vec!["owner".into(), "reviewer".into()], initials }] }));
        let proto = Event::new(&id, "protocol.set", &owner, &device, "", None, json!({ "protocol": protocol, "note": "Created" }));
        inner.append(&id, vec![created, team, proto])?;
        Ok((id, owner))
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let mut inner = self.lock();
        let tx = inner.conn.transaction().map_err(e)?;
        tx.execute("DELETE FROM review_events WHERE review_id = ?1", [id]).map_err(e)?;
        tx.execute("DELETE FROM review_records WHERE review_id = ?1", [id]).map_err(e)?;
        tx.commit().map_err(e)?;
        inner.states.remove(id);
        Ok(())
    }

    /// Reads the review's state (loading it on first use).
    pub fn read<R>(&self, id: &str, f: impl FnOnce(&State, &Connection) -> Result<R>) -> Result<R> {
        let mut inner = self.lock();
        inner.state(id)?;
        let Inner { conn, states, .. } = &*inner;
        f(&states[id], conn)
    }

    /// Builds events with `make` from the current state, then appends them atomically.
    pub fn write<R>(&self, id: &str, make: impl FnOnce(&State, &Connection, &Builder) -> Result<(Vec<Event>, R)>) -> Result<R> {
        let mut inner = self.lock();
        inner.state(id)?;
        let builder = Builder { review: id.to_string(), device: inner.device.clone(), version: inner.states[id].version.clone() };
        let (events, out) = {
            let Inner { conn, states, .. } = &*inner;
            make(&states[id], conn, &builder)?
        };
        inner.append(id, events)?;
        Ok(out)
    }

    /// The whole log of a review, in replay order.
    pub fn events(&self, id: &str) -> Result<Vec<Event>> {
        load_events(&self.lock().conn, id)
    }

    /// Adds events from elsewhere (another device, an imported review file): those not yet here
    /// by id. The review's state and records are rebuilt from the merged log.
    pub fn merge(&self, events: Vec<Event>) -> Result<usize> {
        let mut inner = self.lock();
        let mut added = 0;
        let mut touched = std::collections::BTreeSet::new();
        {
            let tx = inner.conn.transaction().map_err(e)?;
            for ev in &events {
                ev.validate()?;
                let n = tx
                    .execute(
                        "INSERT OR IGNORE INTO review_events (id, review_id, at, actor, device, kind, version, record_id, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![ev.id, ev.review_id, ev.at, ev.actor, ev.device, ev.kind, ev.version, ev.record_id, ev.payload.to_string()],
                    )
                    .map_err(e)?;
                if n > 0 {
                    added += 1;
                    touched.insert(ev.review_id.clone());
                }
            }
            tx.commit().map_err(e)?;
        }
        for id in touched {
            inner.states.remove(&id);
            inner.rebuild_records(&id)?;
        }
        Ok(added)
    }

    /// The metadata of some records.
    pub fn metas(&self, review: &str, ids: &[String]) -> Result<HashMap<String, RecordMeta>> {
        metas(&self.lock().conn, review, ids)
    }
}

/// Makes events for one review with its device and current protocol version.
pub struct Builder {
    pub review: String,
    pub device: String,
    pub version: String,
}

impl Builder {
    pub fn event(&self, kind: &str, actor: &str, record: Option<&str>, payload: Json) -> Event {
        Event::new(&self.review, kind, actor, &self.device, &self.version, record, payload)
    }
}

fn row_event(r: &rusqlite::Row) -> rusqlite::Result<Event> {
    let payload: String = r.get(8)?;
    Ok(Event { id: r.get(0)?, review_id: r.get(1)?, at: r.get(2)?, actor: r.get(3)?, device: r.get(4)?, kind: r.get(5)?, version: r.get(6)?, record_id: r.get(7)?, payload: serde_json::from_str(&payload).unwrap_or(Json::Null) })
}

pub fn load_events(conn: &Connection, id: &str) -> Result<Vec<Event>> {
    let mut st = conn.prepare("SELECT id, review_id, at, actor, device, kind, version, record_id, payload FROM review_events WHERE review_id = ?1 ORDER BY at, id").map_err(e)?;
    let rows = st.query_map([id], row_event).map_err(e)?;
    rows.collect::<std::result::Result<_, _>>().map_err(e)
}

/// One page of the log, newest first (the audit trail).
pub fn events_page(conn: &Connection, id: &str, offset: usize, limit: usize, kinds: Option<&[String]>) -> Result<(Vec<Event>, usize)> {
    let filter = kinds.map(|k| serde_json::to_string(k).unwrap_or_default());
    let clause = if filter.is_some() { "AND kind IN (SELECT value FROM json_each(?2))" } else { "AND ?2 IS NULL" };
    let total: usize = conn.query_row(&format!("SELECT count(*) FROM review_events WHERE review_id = ?1 {clause}"), params![id, filter], |r| r.get::<_, i64>(0)).map_err(e)? as usize;
    let mut st = conn
        .prepare(&format!("SELECT id, review_id, at, actor, device, kind, version, record_id, payload FROM review_events WHERE review_id = ?1 {clause} ORDER BY at DESC, id DESC LIMIT ?3 OFFSET ?4"))
        .map_err(e)?;
    let rows = st.query_map(params![id, filter, limit as i64, offset as i64], row_event).map_err(e)?;
    Ok((rows.collect::<std::result::Result<_, _>>().map_err(e)?, total))
}

pub fn metas(conn: &Connection, review: &str, ids: &[String]) -> Result<HashMap<String, RecordMeta>> {
    let mut out = HashMap::new();
    for chunk in ids.chunks(900) {
        let list = serde_json::to_string(chunk).map_err(e)?;
        let mut st = conn.prepare_cached("SELECT id, meta FROM review_records WHERE review_id = ?1 AND id IN (SELECT value FROM json_each(?2))").map_err(e)?;
        let rows = st.query_map(params![review, list], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
        for row in rows {
            let (id, meta) = row.map_err(e)?;
            if let Ok(m) = serde_json::from_str::<RecordMeta>(&meta) {
                out.insert(id, m);
            }
        }
    }
    Ok(out)
}

/// Every record's metadata, in import order.
pub fn all_metas(conn: &Connection, review: &str) -> Result<Vec<RecordMeta>> {
    let mut st = conn.prepare("SELECT meta FROM review_records WHERE review_id = ?1 ORDER BY pos").map_err(e)?;
    let rows = st.query_map([review], |r| r.get::<_, String>(0)).map_err(e)?;
    let mut out = Vec::new();
    for row in rows {
        if let Ok(m) = serde_json::from_str::<RecordMeta>(&row.map_err(e)?) {
            out.push(m);
        }
    }
    Ok(out)
}

/// Ids of records whose title, abstract, authors, journal or DOI contain every word of `text`.
pub fn search_ids(conn: &Connection, review: &str, text: &str) -> Result<std::collections::HashSet<String>> {
    let words: Vec<String> = text.split_whitespace().take(8).map(|w| format!("%{}%", w.replace('%', "").replace('_', ""))).collect();
    if words.is_empty() {
        return Ok(Default::default());
    }
    let mut sql = String::from("SELECT id FROM review_records WHERE review_id = ?1");
    for i in 0..words.len() {
        sql.push_str(&format!(" AND (title LIKE ?{n} OR abstract LIKE ?{n} OR authors LIKE ?{n} OR journal LIKE ?{n} OR doi LIKE ?{n})", n = i + 2));
    }
    let mut st = conn.prepare(&sql).map_err(e)?;
    let mut values: Vec<rusqlite::types::Value> = vec![review.to_string().into()];
    values.extend(words.into_iter().map(Into::into));
    let rows = st.query_map(rusqlite::params_from_iter(values), |r| r.get::<_, String>(0)).map_err(e)?;
    rows.collect::<std::result::Result<_, _>>().map_err(e)
}

impl Inner {
    /// The review's state, loaded and cached on first use.
    pub fn state(&mut self, id: &str) -> Result<&State> {
        if !self.states.contains_key(id) {
            let events = load_events(&self.conn, id)?;
            if !events.iter().any(|e| e.kind == "review.create") {
                return Err("This review no longer exists".into());
            }
            let state = State::replay(id, events.iter());
            let migrate = state.migrated && !state.alias_recorded;
            let (aliases, protocol, version) = (state.aliases.clone(), state.protocol.clone(), state.version.clone());
            self.states.insert(id.to_string(), state);
            // A review from before criteria and reasons were one list: record, once, which old
            // reason became which criterion, and the protocol as it now reads (an amendment, not
            // a new version: nothing changed in meaning). History is not rewritten.
            if migrate {
                let device = self.device.clone();
                let alias = Event::new(id, "criteria.alias", "system", &device, &version, None, json!({ "aliases": aliases }));
                let amend = Event::new(id, "protocol.set", "system", &device, &version, None, json!({ "protocol": protocol, "note": "Exclusion reasons merged into the criteria", "amend": true }));
                self.append(id, vec![alias, amend])?;
            }
        }
        Ok(&self.states[id])
    }

    pub fn append(&mut self, id: &str, events: Vec<Event>) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction().map_err(e)?;
        {
            let mut insert = tx
                .prepare_cached("INSERT INTO review_events (id, review_id, at, actor, device, kind, version, record_id, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
                .map_err(e)?;
            let mut pos: i64 = tx.query_row("SELECT coalesce(max(pos) + 1, 0) FROM review_records WHERE review_id = ?1", [id], |r| r.get(0)).map_err(e)?;
            for ev in &events {
                ev.validate()?;
                insert.execute(params![ev.id, ev.review_id, ev.at, ev.actor, ev.device, ev.kind, ev.version, ev.record_id, ev.payload.to_string()]).map_err(e)?;
                if ev.kind == "records.add" {
                    insert_records(&tx, id, ev, &mut pos)?;
                } else if ev.kind == "record.edit" || ev.kind == "record.enrich" {
                    edit_row(&tx, id, ev)?;
                }
            }
        }
        tx.commit().map_err(e)?;
        if let Some(state) = self.states.get_mut(id) {
            for ev in &events {
                state.apply(ev);
            }
        }
        Ok(())
    }

    fn rebuild_records(&mut self, id: &str) -> Result<()> {
        let events = load_events(&self.conn, id)?;
        let tx = self.conn.transaction().map_err(e)?;
        tx.execute("DELETE FROM review_records WHERE review_id = ?1", [id]).map_err(e)?;
        let mut pos = 0;
        for ev in &events {
            match ev.kind.as_str() {
                "records.add" => insert_records(&tx, id, ev, &mut pos)?,
                "record.edit" | "record.enrich" => edit_row(&tx, id, ev)?,
                _ => {}
            }
        }
        tx.commit().map_err(e)
    }
}

/// A record's corrected or filled-in metadata, written to its row (the log keeps both).
fn edit_row(tx: &Connection, review: &str, ev: &Event) -> Result<()> {
    let (Some(record), Some(Json::Object(fields))) = (ev.record_id.as_deref(), ev.payload.get("fields")) else { return Ok(()) };
    let Some(mut meta) = metas(tx, review, &[record.to_string()])?.remove(record) else { return Ok(()) };
    crate::records::apply_fields(&mut meta, fields);
    let json = serde_json::to_string(&meta).map_err(e)?;
    tx.execute(
        "UPDATE review_records SET title = ?3, abstract = ?4, authors = ?5, year = ?6, journal = ?7, doi = ?8, meta = ?9 WHERE review_id = ?1 AND id = ?2",
        params![review, record, meta.title, meta.abstract_text, meta.authors.join("; "), meta.year, meta.journal, meta.doi, json],
    )
    .map_err(e)?;
    Ok(())
}

fn insert_records(tx: &Connection, review: &str, ev: &Event, pos: &mut i64) -> Result<()> {
    let batch = ev.payload.get("batchId").and_then(Json::as_str).unwrap_or("");
    let Some(Json::Array(items)) = ev.payload.get("records") else { return Ok(()) };
    let mut st = tx
        .prepare_cached("INSERT OR IGNORE INTO review_records (review_id, id, pos, batch_id, title, abstract, authors, year, journal, doi, meta) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)")
        .map_err(e)?;
    for item in items {
        let Ok(m) = serde_json::from_value::<RecordMeta>(item.clone()) else { continue };
        if m.id.is_empty() {
            continue;
        }
        let n = st.execute(params![review, m.id, *pos, batch, m.title, m.abstract_text, m.authors.join("; "), m.year, m.journal, m.doi, item.to_string()]).map_err(e)?;
        if n > 0 {
            *pos += 1;
        }
    }
    Ok(())
}
