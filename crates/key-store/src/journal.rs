// The operations journal: each library operation (an edit of one or many sources, tags and
// collections, trash and restore, a merge, a metadata update) runs in one transaction that
// records, per source, the values it changed (before and after), the rows it moved from one
// source to another and the pairs it linked. Undo puts the "before" values back and moves
// the rows back; redo replays the "after". Only the values an operation changed are
// written back, so later unrelated changes (a lookup filling a blank) survive an undo.
// The tag manager's snapshots (tag_ops.rs) work the same way for workspace-wide tag edits.
//
// Zotero sync compares Key's current values with what it last took from Zotero, so an
// undo is seen there like any other edit made in Key.
use crate::{DERIVED_FIELDS, NUMBER_FIELDS, Result, Store, TEXT_FIELDS, e, normalize_tags, now_ms, patch_source_row, refresh_fts, sync_graph};
use rusqlite::{Connection, OptionalExtension, params, types::Value};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};
use std::collections::{BTreeSet, HashMap};

/// Entries kept for undo; older ones are dropped.
pub const MAX_ENTRIES: i64 = 200;
/// Edits of the same fields of one source this close together are one entry.
const COALESCE_MS: i64 = 4_000;
/// Fields that are not the user's description of a work: never marked as edited by hand.
const NOT_DESCRIPTIVE: &[&str] =
    &["readState", "filePath", "fileHash", "mime", "fileSize", "pageCount", "durationSeconds", "openalexId", "workType", "oaStatus", "oaUrl", "retracted", "citedByCount", "fwci"];
/// Rows that can move between sources: (table, column, id column).
const MOVABLE: &[(&str, &str, &str)] = &[
    ("notes", "source_id", "id"),
    ("annotations", "source_id", "id"),
    ("linked_files", "source_id", "id"),
    ("links", "from_id", "id"),
    ("links", "to_id", "id"),
];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Change {
    id: String,
    before: Map<String, Json>,
    after: Map<String, Json>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Move {
    table: String,
    column: String,
    rows: Vec<Json>,
    from: String,
    to: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct PairChange {
    a: String,
    b: String,
    kind: String,
    added: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Payload {
    #[serde(default)]
    changes: Vec<Change>,
    #[serde(default)]
    moves: Vec<Move>,
    #[serde(default)]
    pairs: Vec<PairChange>,
    /// Files renamed on disk (linked files renamed by the file naming rules).
    #[serde(default)]
    files: Vec<FileRename>,
    /// Rows of other tables (collections, memberships, notes, links, the tag tree, property
    /// definitions) as they were before and after.
    #[serde(default)]
    rows: Vec<RowChange>,
    /// Sources the operation added (an import): undo moves them to the Trash, redo back.
    #[serde(default)]
    created: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct FileRename {
    id: String,
    from: String,
    to: String,
}

/// Renames files on disk; stops at the first failure and puts back what it already moved.
fn move_files(renames: &[(String, String)]) -> Result<()> {
    for (i, (from, to)) in renames.iter().enumerate() {
        let (from, to) = (std::path::Path::new(from), std::path::Path::new(to));
        let failed = if from == to {
            None
        } else if to.exists() {
            Some(format!("{} already exists", to.display()))
        } else {
            std::fs::rename(from, to).err().map(|err| format!("Couldn't rename {}: {err}", from.display()))
        };
        if let Some(error) = failed {
            for (f, t) in renames[..i].iter().rev() {
                let _ = std::fs::rename(t, f);
            }
            return Err(error);
        }
    }
    Ok(())
}

impl Payload {
    fn is_empty(&self) -> bool {
        self.changes.is_empty() && self.moves.is_empty() && self.pairs.is_empty() && self.rows.is_empty() && self.created.is_empty() && self.files.is_empty()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub seq: i64,
    pub kind: String,
    pub label: String,
    pub count: i64,
    pub created_at: i64,
    /// The sources it changed.
    pub ids: Vec<String>,
    /// Undone (and not redone).
    #[serde(default)]
    pub undone: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalState {
    pub undo: Option<JournalEntry>,
    pub redo: Option<JournalEntry>,
    pub entries: Vec<JournalEntry>,
}

/// One edit applied to every listed source.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchEdit {
    /// A camelCase patch as for `update_source` (fields, `creators`, `properties` merged, `starred`, `kind`).
    #[serde(default)]
    pub patch: Map<String, Json>,
    #[serde(default)]
    pub tags_add: Vec<String>,
    #[serde(default)]
    pub tags_remove: Vec<String>,
    #[serde(default)]
    pub collections_add: Vec<String>,
    #[serde(default)]
    pub collections_remove: Vec<String>,
    /// Properties set to a formula's result on each source (`{"Age": "2026 - [year]"}`).
    #[serde(default)]
    pub formulas: Map<String, Json>,
    /// The user typed it: bibliographic fields are marked as edited by hand.
    #[serde(default = "yes")]
    pub by_hand: bool,
}
fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub affected: usize,
    pub entry: Option<JournalEntry>,
}

/// What an operation touches, captured before it changes anything.
pub(crate) struct Recorder {
    order: Vec<String>,
    before: HashMap<String, Map<String, Json>>,
    moves: Vec<Move>,
    pairs: Vec<PairChange>,
    watches: Vec<Watch>,
    created: Vec<String>,
}

impl Recorder {
    /// Records a source the operation is about to change.
    pub(crate) fn touch(&mut self, db: &Connection, id: &str) -> Result<()> {
        if self.before.contains_key(id) {
            return Ok(());
        }
        if let Some(state) = capture(db, id)? {
            self.order.push(id.to_string());
            self.before.insert(id.to_string(), state);
        }
        Ok(())
    }

    /// Moves every row of `table` that belongs to `from` over to `to`.
    pub(crate) fn move_rows(&mut self, db: &Connection, table: &str, column: &str, from: &str, to: &str) -> Result<usize> {
        let (_, _, key) = MOVABLE.iter().find(|(t, c, _)| *t == table && *c == column).ok_or("Unknown row kind")?;
        let kind_filter = if table == "links" { format!(" AND {}_kind = 'source'", column.trim_end_matches("_id")) } else { String::new() };
        let rows: Vec<Json> = {
            let mut statement = db.prepare(&format!("SELECT {key} FROM {table} WHERE {column} = ?1{kind_filter}")).map_err(e)?;
            let rows = statement.query_map([from], |r| r.get::<_, Value>(0)).map_err(e)?;
            rows.map(|r| r.map(|v| value_json(&v))).collect::<std::result::Result<_, _>>().map_err(e)?
        };
        if rows.is_empty() {
            return Ok(0);
        }
        set_rows(db, table, column, key, &rows, to)?;
        let count = rows.len();
        self.moves.push(Move { table: table.into(), column: column.into(), rows, from: from.into(), to: to.into() });
        Ok(count)
    }

    /// Links (or unlinks) two sources as `kind`.
    pub(crate) fn pair(&mut self, db: &Connection, a: &str, b: &str, kind: &str, added: bool) -> Result<bool> {
        let (a, b) = if a < b { (a, b) } else { (b, a) };
        let changed = set_pair(db, a, b, kind, added)?;
        if changed {
            self.pairs.push(PairChange { a: a.into(), b: b.into(), kind: kind.into(), added });
        }
        Ok(changed)
    }
}

/// Tables whose rows operations can journal, with their key columns.
const ROW_TABLES: &[(&str, &[&str])] = &[
    ("collections", &["id"]),
    ("source_collections", &["source_id", "collection_id"]),
    ("notes", &["id"]),
    ("links", &["id"]),
    ("meta", &["key"]),
    ("property_definitions", &["name"]),
    ("fill_cells", &["source_id", "property"]),
];

/// One row of another table before and after an operation (`None`: absent).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct RowChange {
    table: String,
    key: Map<String, Json>,
    before: Option<Map<String, Json>>,
    after: Option<Map<String, Json>>,
}

/// Rows of a table an operation may change, read before it runs.
pub(crate) struct Watch {
    table: &'static str,
    keys: &'static [&'static str],
    condition: String,
    values: Vec<Value>,
    before: Vec<Map<String, Json>>,
}

fn json_value(value: &Json) -> Value {
    match value {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(i64::from(*b)),
        Json::Number(n) => n.as_i64().map(Value::Integer).unwrap_or_else(|| Value::Real(n.as_f64().unwrap_or(0.0))),
        Json::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

fn read_rows(db: &Connection, table: &str, condition: &str, values: &[Value]) -> Result<Vec<Map<String, Json>>> {
    let mut statement = db.prepare(&format!("SELECT * FROM {table} WHERE {condition}")).map_err(e)?;
    let names: Vec<String> = statement.column_names().into_iter().map(String::from).collect();
    let rows = statement
        .query_map(rusqlite::params_from_iter(values.iter()), |r| {
            let mut row = Map::new();
            for (i, name) in names.iter().enumerate() {
                row.insert(name.clone(), value_json(&r.get::<_, Value>(i)?));
            }
            Ok(row)
        })
        .map_err(e)?;
    rows.collect::<std::result::Result<_, _>>().map_err(e)
}

impl Watch {
    fn key_of(&self, row: &Map<String, Json>) -> Map<String, Json> {
        self.keys.iter().map(|k| ((*k).to_string(), row.get(*k).cloned().unwrap_or(Json::Null))).collect()
    }

    /// What changed since the watch began.
    fn finish(self, db: &Connection) -> Result<Vec<RowChange>> {
        let after = read_rows(db, self.table, &self.condition, &self.values)?;
        let mut out = Vec::new();
        let mut later: HashMap<String, Map<String, Json>> = after.iter().map(|r| (Json::Object(self.key_of(r)).to_string(), r.clone())).collect();
        for row in &self.before {
            let key = self.key_of(row);
            let now = later.remove(&Json::Object(key.clone()).to_string());
            if now.as_ref() != Some(row) {
                out.push(RowChange { table: self.table.into(), key, before: Some(row.clone()), after: now });
            }
        }
        // Rows that are new, in the order they were read.
        for row in after {
            let key = self.key_of(&row);
            if later.remove(&Json::Object(key.clone()).to_string()).is_some() {
                out.push(RowChange { table: self.table.into(), key, before: None, after: Some(row) });
            }
        }
        Ok(out)
    }
}

impl Recorder {
    /// Watches the rows of `table` matching `condition` (over `values`): whatever the
    /// operation does to them (or rows it adds that match) is journaled.
    pub(crate) fn watch(&mut self, db: &Connection, table: &str, condition: &str, values: Vec<Value>) -> Result<()> {
        let (table, keys) = ROW_TABLES.iter().find(|(t, _)| *t == table).copied().ok_or("Unknown table for the journal")?;
        let before = read_rows(db, table, condition, &values)?;
        self.watches.push(Watch { table, keys, condition: condition.into(), values, before });
        Ok(())
    }

    /// Watches rows by one column's values (`id IN (…)`).
    pub(crate) fn watch_in(&mut self, db: &Connection, table: &str, column: &str, ids: &[String]) -> Result<()> {
        for chunk in ids.chunks(500) {
            let marks = vec!["?"; chunk.len()].join(", ");
            self.watch(db, table, &format!("{column} IN ({marks})"), chunk.iter().map(|i| Value::Text(i.clone())).collect())?;
        }
        Ok(())
    }
}

/// Writes rows back: `undo` puts the "before" rows back, redo the "after" ones. Rows to
/// remove go first (last one first), then rows to add (in order), so parents come before
/// children; a row on both sides is updated in place (deleting a collection would cascade).
fn apply_rows(db: &Connection, rows: &[RowChange], undo: bool) -> Result<()> {
    fn target(r: &RowChange, undo: bool) -> (Option<&Map<String, Json>>, Option<&Map<String, Json>>) {
        if undo { (r.after.as_ref(), r.before.as_ref()) } else { (r.before.as_ref(), r.after.as_ref()) }
    }
    let condition = |key: &Map<String, Json>| key.keys().map(|k| format!("{k} IS ?")).collect::<Vec<_>>().join(" AND ");
    let key_values = |key: &Map<String, Json>| key.values().map(json_value).collect::<Vec<_>>();
    for row in rows.iter().rev() {
        if let (Some(_), None) = target(row, undo) {
            db.execute(&format!("DELETE FROM {} WHERE {}", row.table, condition(&row.key)), rusqlite::params_from_iter(key_values(&row.key))).map_err(e)?;
        }
    }
    let mut properties = BTreeSet::new();
    let mut sources = BTreeSet::new();
    let mut inserts: Vec<(String, Vec<Value>)> = Vec::new();
    for row in rows {
        let (from, to) = target(row, undo);
        let Some(to) = to else { continue };
        let mut to = to.clone();
        // A restored note is cut into passages again.
        if row.table == "notes" {
            to.insert("indexed_at".into(), Json::Null);
            if let Some(source) = to.get("source_id").and_then(Json::as_str) {
                sources.insert(source.to_string());
            }
        }
        if row.table == "property_definitions" {
            properties.insert(to.get("name").and_then(Json::as_str).unwrap_or("").to_string());
        }
        let columns: Vec<&String> = to.keys().collect();
        let values: Vec<Value> = to.values().map(json_value).collect();
        if from.is_some() {
            let set = columns.iter().map(|c| format!("{c} = ?")).collect::<Vec<_>>().join(", ");
            let mut all = values;
            all.extend(key_values(&row.key));
            db.execute(&format!("UPDATE {} SET {set} WHERE {}", row.table, condition(&row.key)), rusqlite::params_from_iter(all)).map_err(e)?;
        } else {
            let marks = vec!["?"; columns.len()].join(", ");
            let names = columns.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(", ");
            inserts.push((format!("INSERT OR REPLACE INTO {} ({names}) VALUES ({marks})", row.table), values));
        }
    }
    // Rows come back in table order, so a child can precede its parent: retry until
    // nothing more goes in. A parent (a collection, a source) that is gone for good
    // takes its rows with it.
    while !inserts.is_empty() {
        let before = inserts.len();
        let mut waiting = Vec::new();
        for (sql, values) in inserts {
            match db.execute(&sql, rusqlite::params_from_iter(values.iter())) {
                Ok(_) => {}
                Err(error) if error.to_string().contains("FOREIGN KEY") => waiting.push((sql, values)),
                Err(error) => return Err(e(error)),
            }
        }
        if waiting.len() == before {
            break;
        }
        inserts = waiting;
    }
    for row in rows.iter().filter(|r| r.table == "notes") {
        if let Some(source) = row.before.as_ref().or(row.after.as_ref()).and_then(|r| r.get("source_id")).and_then(Json::as_str) {
            sources.insert(source.to_string());
        }
    }
    for name in properties.into_iter().filter(|n| !n.is_empty()) {
        crate::properties::sync_options(db, &name)?;
    }
    for source in sources {
        refresh_fts(db, &source)?;
    }
    Ok(())
}

/// Moves added sources to the Trash (undo) or out of it (redo).
fn trash_created(db: &Connection, ids: &[String], undo: bool) -> Result<()> {
    let now = now_ms();
    for id in ids {
        db.execute("UPDATE sources SET trashed_at = ?2, updated_at = ?3 WHERE id = ?1", params![id, undo.then_some(now), now]).map_err(e)?;
    }
    Ok(())
}

fn set_pair(db: &Connection, a: &str, b: &str, kind: &str, added: bool) -> Result<bool> {
    let changed = if added {
        db.execute("INSERT OR IGNORE INTO source_pairs(a, b, kind, created_at) VALUES (?1, ?2, ?3, ?4)", params![a, b, kind, now_ms()])
    } else {
        db.execute("DELETE FROM source_pairs WHERE a = ?1 AND b = ?2 AND kind = ?3", params![a, b, kind])
    }
    .map_err(e)?;
    Ok(changed > 0)
}

fn set_rows(db: &Connection, table: &str, column: &str, key: &str, rows: &[Json], to: &str) -> Result<()> {
    let mut statement = db.prepare(&format!("UPDATE {table} SET {column} = ?1 WHERE {key} = ?2")).map_err(e)?;
    for row in rows {
        let id = match row {
            Json::Number(n) => Value::Integer(n.as_i64().unwrap_or(0)),
            other => Value::Text(other.as_str().unwrap_or("").to_string()),
        };
        statement.execute(params![to, id]).map_err(e)?;
    }
    Ok(())
}

fn value_json(value: &Value) -> Json {
    match value {
        Value::Null => Json::Null,
        Value::Integer(i) => Json::from(*i),
        Value::Real(f) => if f.fract() == 0.0 { Json::from(*f as i64) } else { Json::from(*f) },
        Value::Text(t) => Json::String(t.clone()),
        Value::Blob(_) => Json::Null,
    }
}

fn editable() -> impl Iterator<Item = &'static (&'static str, &'static str)> {
    TEXT_FIELDS.iter().chain(NUMBER_FIELDS).filter(|(name, _)| !DERIVED_FIELDS.contains(name))
}

/// Everything about a source an operation can change, as camelCase values.
fn capture(db: &Connection, id: &str) -> Result<Option<Map<String, Json>>> {
    let fields: Vec<&(&str, &str)> = editable().collect();
    let columns: Vec<&str> = fields.iter().map(|(_, c)| *c).chain(["kind", "creators", "tags", "properties", "starred", "trashed_at", "merged_into", "edited_fields"]).collect();
    let row: Option<Vec<Value>> = db
        .query_row(&format!("SELECT {} FROM sources WHERE id = ?", columns.join(", ")), [id], |r| (0..columns.len()).map(|i| r.get::<_, Value>(i)).collect())
        .optional()
        .map_err(e)?;
    let Some(row) = row else { return Ok(None) };
    let mut state = Map::new();
    for (i, (name, _)) in fields.iter().enumerate() {
        state.insert((*name).into(), value_json(&row[i]));
    }
    let n = fields.len();
    let parsed = |v: &Value, default: Json| match v {
        Value::Text(t) => serde_json::from_str(t).unwrap_or(default),
        _ => default,
    };
    state.insert("kind".into(), value_json(&row[n]));
    state.insert("creators".into(), parsed(&row[n + 1], json!([])));
    state.insert("tags".into(), parsed(&row[n + 2], json!([])));
    state.insert("properties".into(), parsed(&row[n + 3], json!({})));
    state.insert("starred".into(), Json::Bool(matches!(row[n + 4], Value::Integer(1))));
    state.insert("trashedAt".into(), value_json(&row[n + 5]));
    state.insert("mergedInto".into(), value_json(&row[n + 6]));
    state.insert("editedFields".into(), parsed(&row[n + 7], json!([])));
    let collections: Vec<String> = {
        let mut statement = db.prepare("SELECT collection_id FROM source_collections WHERE source_id = ? ORDER BY collection_id").map_err(e)?;
        let rows = statement.query_map([id], |r| r.get(0)).map_err(e)?;
        rows.collect::<std::result::Result<_, _>>().map_err(e)?
    };
    state.insert("collections".into(), json!(collections));
    Ok(Some(state))
}

/// Writes back the given values (a subset of what `capture` reads).
fn restore(db: &Connection, id: &str, values: &Map<String, Json>) -> Result<()> {
    let exists: bool = db.query_row("SELECT count(*) FROM sources WHERE id = ?", [id], |r| r.get::<_, i64>(0)).map_err(e)? > 0;
    if !exists {
        return Ok(());
    }
    let mut patch = Map::new();
    for (key, value) in values {
        match key.as_str() {
            "properties" => {
                patch.insert("replaceProperties".into(), if value.is_object() { value.clone() } else { json!({}) });
            }
            "collections" => {
                db.execute("DELETE FROM source_collections WHERE source_id = ?", [id]).map_err(e)?;
                for collection in value.as_array().into_iter().flatten().filter_map(Json::as_str) {
                    db.execute(
                        "INSERT OR IGNORE INTO source_collections(source_id, collection_id) SELECT ?1, id FROM collections WHERE id = ?2",
                        params![id, collection],
                    )
                    .map_err(e)?;
                }
            }
            "trashedAt" => {
                db.execute("UPDATE sources SET trashed_at = ?2 WHERE id = ?1", params![id, value.as_i64()]).map_err(e)?;
            }
            "mergedInto" => {
                db.execute("UPDATE sources SET merged_into = ?2 WHERE id = ?1", params![id, value.as_str()]).map_err(e)?;
            }
            "editedFields" => {
                db.execute("UPDATE sources SET edited_fields = ?2 WHERE id = ?1", params![id, if value.is_array() { value.to_string() } else { "[]".into() }]).map_err(e)?;
            }
            "kind" | "creators" | "tags" | "starred" => {
                if !value.is_null() {
                    patch.insert(key.clone(), value.clone());
                }
            }
            field => {
                if editable().any(|(name, _)| *name == field) {
                    patch.insert(key.clone(), value.clone());
                }
            }
        }
    }
    patch_source_row(db, id, &patch, now_ms())?;
    sync_graph(db, id, Some(&patch))?;
    refresh_fts(db, id)
}

fn diff(before: &Map<String, Json>, after: &Map<String, Json>) -> (Map<String, Json>, Map<String, Json>) {
    let keys: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    let (mut b, mut a) = (Map::new(), Map::new());
    for key in keys {
        let (x, y) = (before.get(key).unwrap_or(&Json::Null), after.get(key).unwrap_or(&Json::Null));
        if x != y {
            b.insert(key.clone(), x.clone());
            a.insert(key.clone(), y.clone());
        }
    }
    (b, a)
}

/// The source `id` stands for: itself, or the one it was merged into.
pub(crate) fn resolve_source(db: &Connection, id: &str) -> Result<String> {
    let mut current = id.to_string();
    for _ in 0..8 {
        let next: Option<String> = db.query_row("SELECT merged_into FROM sources WHERE id = ?", [&current], |r| r.get(0)).optional().map_err(e)?.flatten();
        match next {
            Some(next) if next != current => current = next,
            _ => break,
        }
    }
    Ok(current)
}

/// `ids` with every source merged into one of them.
pub(crate) fn with_merged(db: &Connection, ids: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = ids.to_vec();
    let mut i = 0;
    while i < out.len() && out.len() < 100_000 {
        let children: Vec<String> = {
            let mut statement = db.prepare("SELECT id FROM sources WHERE merged_into = ?").map_err(e)?;
            let rows = statement.query_map([&out[i]], |r| r.get(0)).map_err(e)?;
            rows.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        for child in children {
            if !out.contains(&child) {
                out.push(child);
            }
        }
        i += 1;
    }
    Ok(out)
}

/// Marks the descriptive fields of a patch as set by hand on `id`.
pub(crate) fn mark_edited(db: &Connection, id: &str, keys: impl IntoIterator<Item = String>) -> Result<()> {
    let current: String = db.query_row("SELECT edited_fields FROM sources WHERE id = ?", [id], |r| r.get(0)).map_err(e)?;
    let mut edited: Vec<String> = serde_json::from_str(&current).unwrap_or_default();
    let before = edited.len();
    for key in keys {
        let descriptive = key == "creators" || editable().any(|(name, _)| *name == key);
        if descriptive && !NOT_DESCRIPTIVE.contains(&key.as_str()) && !edited.contains(&key) {
            edited.push(key);
        }
    }
    if edited.len() != before {
        db.execute("UPDATE sources SET edited_fields = ?2 WHERE id = ?1", params![id, serde_json::to_string(&edited).map_err(e)?]).map_err(e)?;
    }
    Ok(())
}

/// The current values of the fields the user edited by hand (for automatic writers to put back).
pub(crate) fn hand_edited_values(db: &Connection, id: &str) -> Result<Map<String, Json>> {
    let edited = edited_fields(db, id)?;
    if edited.is_empty() {
        return Ok(Map::new());
    }
    let state = capture(db, id)?.unwrap_or_default();
    Ok(edited.into_iter().filter_map(|f| state.get(&f).map(|v| (f, v.clone()))).collect())
}

/// Writes back values read by `hand_edited_values` that an automatic writer changed.
pub(crate) fn put_back(db: &Connection, id: &str, kept: &Map<String, Json>) -> Result<()> {
    if kept.is_empty() {
        return Ok(());
    }
    let now = capture(db, id)?.unwrap_or_default();
    let changed: Map<String, Json> = kept.iter().filter(|(k, v)| now.get(*k) != Some(*v) && *k != "creators").map(|(k, v)| (k.clone(), v.clone())).collect();
    if changed.is_empty() {
        return Ok(());
    }
    restore(db, id, &changed)
}

/// The fields of `id` the user edited by hand.
pub(crate) fn edited_fields(db: &Connection, id: &str) -> Result<Vec<String>> {
    let current: Option<String> = db.query_row("SELECT edited_fields FROM sources WHERE id = ?", [id], |r| r.get(0)).optional().map_err(e)?;
    Ok(current.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default())
}

fn read_entry(r: &rusqlite::Row) -> rusqlite::Result<(JournalEntry, String)> {
    let payload: String = r.get(5)?;
    let ids = serde_json::from_str::<Payload>(&payload).map(|p| p.changes.into_iter().map(|c| c.id).collect()).unwrap_or_default();
    Ok((JournalEntry { seq: r.get(0)?, kind: r.get(1)?, label: r.get(2)?, count: r.get(3)?, created_at: r.get(4)?, ids, undone: r.get(6)? }, payload))
}

const ENTRY_COLUMNS: &str = "seq, kind, label, count, created_at, payload, undone";

fn plural(n: usize, one: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {one}s") }
}

impl Store {
    /// Runs `op` in one transaction and journals what it changed. `ids` are the sources it
    /// changes; the operation can name more with `Recorder::touch` before changing them.
    pub(crate) fn journaled<T>(&self, kind: &str, label: &str, ids: &[String], op: impl FnOnce(&Connection, &mut Recorder) -> Result<T>) -> Result<(T, Option<JournalEntry>)> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let mut recorder = Recorder { order: Vec::new(), before: HashMap::new(), moves: Vec::new(), pairs: Vec::new(), watches: Vec::new(), created: Vec::new() };
        for id in ids {
            recorder.touch(&tx, id)?;
        }
        let out = op(&tx, &mut recorder)?;
        let mut payload = Payload { moves: std::mem::take(&mut recorder.moves), pairs: std::mem::take(&mut recorder.pairs), created: std::mem::take(&mut recorder.created), ..Default::default() };
        for watch in std::mem::take(&mut recorder.watches) {
            payload.rows.extend(watch.finish(&tx)?);
        }
        for id in &recorder.order {
            let after = capture(&tx, id)?.unwrap_or_default();
            let (before, after) = diff(&recorder.before[id], &after);
            if !before.is_empty() {
                payload.changes.push(Change { id: id.clone(), before, after });
            }
        }
        let entry = if payload.is_empty() {
            None
        } else {
            Some(record(&tx, kind, label, payload)?)
        };
        tx.commit().map_err(e)?;
        Ok((out, entry))
    }

    /// Applies one edit to many sources (the inspector's "N sources" editor, and the
    /// single-source inspector through `store_update`).
    pub fn edit_sources(&self, ids: &[String], edit: &BatchEdit, label: Option<&str>) -> Result<Operation> {
        if ids.len() > 20_000 {
            return Err("Too many sources".into());
        }
        let label = label.map(String::from).unwrap_or_else(|| default_label(ids.len(), edit));
        let (affected, entry) = self.journaled("edit", &label, ids, |db, _| {
            let mut affected = 0;
            let now = now_ms();
            for id in ids {
                let current: Option<String> = db.query_row("SELECT tags FROM sources WHERE id = ?", [id], |r| r.get(0)).optional().map_err(e)?;
                let Some(current) = current else { continue };
                let mut patch = edit.patch.clone();
                if !edit.formulas.is_empty() {
                    let computed = formula_patch(db, id, &edit.formulas)?;
                    let mut properties = patch.get("properties").and_then(Json::as_object).cloned().unwrap_or_default();
                    properties.extend(computed);
                    patch.insert("properties".into(), Json::Object(properties));
                }
                if !edit.tags_add.is_empty() || !edit.tags_remove.is_empty() {
                    let tags: Vec<String> = serde_json::from_str(&current).unwrap_or_default();
                    let mut next: Vec<String> = tags.into_iter().filter(|t| !edit.tags_remove.iter().any(|r| r.trim().eq_ignore_ascii_case(t.trim()))).collect();
                    next.extend(edit.tags_add.iter().cloned());
                    patch.insert("tags".into(), json!(normalize_tags(&next)));
                }
                if !patch.is_empty() {
                    patch_source_row(db, id, &patch, now)?;
                    sync_graph(db, id, Some(&patch))?;
                    refresh_fts(db, id)?;
                    if edit.by_hand {
                        mark_edited(db, id, patch.keys().cloned())?;
                    }
                }
                for collection in &edit.collections_add {
                    db.execute("INSERT OR IGNORE INTO source_collections(source_id, collection_id) SELECT ?1, id FROM collections WHERE id = ?2", params![id, collection]).map_err(e)?;
                }
                for collection in &edit.collections_remove {
                    db.execute("DELETE FROM source_collections WHERE source_id = ?1 AND collection_id = ?2", params![id, collection]).map_err(e)?;
                }
                affected += 1;
            }
            Ok(affected)
        })?;
        Ok(Operation { affected, entry })
    }

    /// Moves sources to the Trash (or back), journaled.
    pub fn trash_sources(&self, ids: &[String], trashed: bool) -> Result<Operation> {
        let label = if trashed { format!("Move {} to the Trash", plural(ids.len(), "source")) } else { format!("Restore {}", plural(ids.len(), "source")) };
        let (affected, entry) = self.journaled("trash", &label, ids, |db, _| {
            let now = now_ms();
            let mut changed = 0;
            for id in ids {
                changed += db
                    .execute(
                        "UPDATE sources SET trashed_at = ?2, updated_at = ?3 WHERE id = ?1 AND merged_into IS NULL AND (trashed_at IS NULL) = ?4",
                        params![id, trashed.then_some(now), now, trashed],
                    )
                    .map_err(e)?;
            }
            Ok(changed)
        })?;
        Ok(Operation { affected, entry })
    }

    /// Adds sources to a collection (or takes them out), journaled.
    pub fn file_sources(&self, collection_id: &str, ids: &[String], present: bool) -> Result<Operation> {
        let name: String = self.read()?.query_row("SELECT name FROM collections WHERE id = ?", [collection_id], |r| r.get(0)).optional().map_err(e)?.unwrap_or_default();
        let label = if present { format!("Add {} to “{name}”", plural(ids.len(), "source")) } else { format!("Remove {} from “{name}”", plural(ids.len(), "source")) };
        let (affected, entry) = self.journaled("membership", &label, ids, |db, _| {
            let mut changed = 0;
            for id in ids {
                changed += if present {
                    db.execute("INSERT OR IGNORE INTO source_collections(source_id, collection_id) SELECT ?1, id FROM collections WHERE id = ?2", params![id, collection_id])
                } else {
                    db.execute("DELETE FROM source_collections WHERE source_id = ?1 AND collection_id = ?2", params![id, collection_id])
                }
                .map_err(e)?;
            }
            Ok(changed)
        })?;
        Ok(Operation { affected, entry })
    }

    /// Renames sources' files on disk and points the sources at the new paths, as one
    /// journaled operation (undo renames them back). `renames`: (source id, from, to).
    pub fn rename_source_files(&self, renames: &[(String, String, String)], label: &str) -> Result<Operation> {
        let ids: Vec<String> = renames.iter().map(|(id, _, _)| id.clone()).collect();
        let moves: Vec<(String, String)> = renames.iter().map(|(_, from, to)| (from.clone(), to.clone())).collect();
        move_files(&moves)?;
        let result = self.journaled("rename-files", label, &ids, |db, _| {
            let now = now_ms();
            for (id, _, to) in renames {
                let mut patch = Map::new();
                patch.insert("filePath".into(), Json::String(to.clone()));
                patch_source_row(db, id, &patch, now)?;
            }
            Ok(renames.len())
        });
        let (affected, entry) = match result {
            Ok(done) => done,
            Err(error) => {
                let back: Vec<(String, String)> = moves.iter().rev().map(|(f, t)| (t.clone(), f.clone())).collect();
                let _ = move_files(&back);
                return Err(error);
            }
        };
        let Some(entry) = entry else { return Ok(Operation { affected, entry: None }) };
        // The renames go with the entry, so undo and redo move the files too.
        let db = self.db()?;
        let payload: String = db.query_row("SELECT payload FROM journal WHERE seq = ?", [entry.seq], |r| r.get(0)).map_err(e)?;
        let mut payload: Payload = serde_json::from_str(&payload).map_err(e)?;
        payload.files = renames.iter().map(|(id, from, to)| FileRename { id: id.clone(), from: from.clone(), to: to.clone() }).collect();
        db.execute("UPDATE journal SET payload = ?2 WHERE seq = ?1", params![entry.seq, serde_json::to_string(&payload).map_err(e)?]).map_err(e)?;
        Ok(Operation { affected, entry: Some(entry) })
    }

    /// Undoes the latest operation not undone yet.
    pub fn undo(&self) -> Result<Option<JournalEntry>> {
        self.step(true)
    }

    /// Redoes the earliest undone operation.
    pub fn redo(&self) -> Result<Option<JournalEntry>> {
        self.step(false)
    }

    fn step(&self, undo: bool) -> Result<Option<JournalEntry>> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let sql = if undo {
            format!("SELECT {ENTRY_COLUMNS} FROM journal WHERE undone = 0 ORDER BY seq DESC LIMIT 1")
        } else {
            format!("SELECT {ENTRY_COLUMNS} FROM journal WHERE undone = 1 ORDER BY seq ASC LIMIT 1")
        };
        let Some((entry, payload)) = tx.query_row(&sql, [], read_entry).optional().map_err(e)? else { return Ok(None) };
        let payload: Payload = serde_json::from_str(&payload).map_err(e)?;
        let files: Vec<(String, String)> =
            if undo { payload.files.iter().rev().map(|f| (f.to.clone(), f.from.clone())).collect() } else { payload.files.iter().map(|f| (f.from.clone(), f.to.clone())).collect() };
        move_files(&files)?;
        apply_entry(&tx, &payload, undo)?;
        tx.execute("UPDATE journal SET undone = ?2 WHERE seq = ?1", params![entry.seq, undo]).map_err(e)?;
        if let Err(error) = tx.commit().map_err(e) {
            let back: Vec<(String, String)> = files.iter().rev().map(|(f, t)| (t.clone(), f.clone())).collect();
            let _ = move_files(&back);
            return Err(error);
        }
        Ok(Some(entry))
    }

    /// Undoes one entry out of order ("Undo this import"): its own changes are put back;
    /// later operations keep theirs. `None` when it is gone or undone already.
    pub fn undo_entry(&self, seq: i64) -> Result<Option<JournalEntry>> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let found = tx.query_row(&format!("SELECT {ENTRY_COLUMNS} FROM journal WHERE seq = ?1 AND undone = 0"), [seq], read_entry).optional().map_err(e)?;
        let Some((entry, payload)) = found else { return Ok(None) };
        apply_entry(&tx, &serde_json::from_str(&payload).map_err(e)?, true)?;
        tx.execute("UPDATE journal SET undone = 1 WHERE seq = ?1", [seq]).map_err(e)?;
        tx.commit().map_err(e)?;
        Ok(Some(entry))
    }

    /// An entry and whether it is undone.
    pub fn journal_entry(&self, seq: i64) -> Result<Option<(JournalEntry, bool)>> {
        let db = self.read()?;
        db.query_row(&format!("SELECT {ENTRY_COLUMNS} FROM journal WHERE seq = ?1"), [seq], |r| read_entry(r).map(|(entry, _)| { let undone = entry.undone; (entry, undone) })).optional().map_err(e)
    }
}

fn apply_entry(tx: &Connection, payload: &Payload, undo: bool) -> Result<()> {
    // Other rows first: a collection comes back before sources are filed in it again.
    apply_rows(tx, &payload.rows, undo)?;
    if undo {
        for change in payload.changes.iter().rev() {
            restore(tx, &change.id, &change.before)?;
        }
        for m in payload.moves.iter().rev() {
            let key = MOVABLE.iter().find(|(t, c, _)| *t == m.table && *c == m.column).map(|(_, _, k)| *k).ok_or("Unknown row kind")?;
            set_rows(tx, &m.table, &m.column, key, &m.rows, &m.from)?;
        }
        for p in payload.pairs.iter().rev() {
            set_pair(tx, &p.a, &p.b, &p.kind, !p.added)?;
        }
    } else {
        for m in &payload.moves {
            let key = MOVABLE.iter().find(|(t, c, _)| *t == m.table && *c == m.column).map(|(_, _, k)| *k).ok_or("Unknown row kind")?;
            set_rows(tx, &m.table, &m.column, key, &m.rows, &m.to)?;
        }
        for change in &payload.changes {
            restore(tx, &change.id, &change.after)?;
        }
        for p in &payload.pairs {
            set_pair(tx, &p.a, &p.b, &p.kind, p.added)?;
        }
    }
    trash_created(tx, &payload.created, undo)?;
    // Notes that moved count towards a different source's search text.
    for m in &payload.moves {
        if m.table == "notes" {
            refresh_fts(tx, &m.from)?;
            refresh_fts(tx, &m.to)?;
        }
    }
    Ok(())
}

impl Store {
    /// The next undo and redo, and the latest entries.
    pub fn journal_state(&self, limit: usize) -> Result<JournalState> {
        let db = self.read()?;
        let undo = db.query_row(&format!("SELECT {ENTRY_COLUMNS} FROM journal WHERE undone = 0 ORDER BY seq DESC LIMIT 1"), [], read_entry).optional().map_err(e)?.map(|(e, _)| e);
        let redo = db.query_row(&format!("SELECT {ENTRY_COLUMNS} FROM journal WHERE undone = 1 ORDER BY seq ASC LIMIT 1"), [], read_entry).optional().map_err(e)?.map(|(e, _)| e);
        let mut statement = db.prepare(&format!("SELECT {ENTRY_COLUMNS} FROM journal ORDER BY seq DESC LIMIT ?")).map_err(e)?;
        let entries = statement.query_map([limit.min(MAX_ENTRIES as usize) as i64], read_entry).map_err(e)?.map(|r| r.map(|(e, _)| e)).collect::<std::result::Result<_, _>>().map_err(e)?;
        Ok(JournalState { undo, redo, entries })
    }

    /// The source an id stands for now (itself, or the one it was merged into).
    pub fn resolve_source_id(&self, id: &str) -> Result<String> {
        resolve_source(&*self.read()?, id)
    }
}

/// Stores an entry: drops the redo stack, folds a quick repeat edit of the same fields into
/// the entry before, and keeps the journal short.
fn record(db: &Connection, kind: &str, label: &str, payload: Payload) -> Result<JournalEntry> {
    db.execute("DELETE FROM journal WHERE undone = 1", []).map_err(e)?;
    let now = now_ms();
    let count = (payload.changes.len() + payload.created.len()).max(payload.moves.iter().map(|m| m.rows.len()).sum::<usize>().min(1)).max(usize::from(!payload.rows.is_empty())) as i64;
    let last = db.query_row(&format!("SELECT {ENTRY_COLUMNS} FROM journal ORDER BY seq DESC LIMIT 1"), [], read_entry).optional().map_err(e)?;
    if let Some((entry, old)) = last {
        let old: Payload = serde_json::from_str(&old).unwrap_or_default();
        // The same sources, and no field the earlier entry did not change already.
        let ids = |p: &Payload| p.changes.iter().map(|c| c.id.clone()).collect::<Vec<_>>();
        let within = old.changes.len() == payload.changes.len() && old.changes.iter().zip(&payload.changes).all(|(o, n)| o.id == n.id && n.after.keys().all(|k| o.after.contains_key(k)));
        let quick = kind == "edit" && entry.kind == "edit" && now - entry.created_at < COALESCE_MS && entry.label == label;
        if quick && old.rows.is_empty() && payload.rows.is_empty() && old.moves.is_empty() && payload.moves.is_empty() && old.pairs.is_empty() && payload.pairs.is_empty() && within && ids(&old) == ids(&payload) {
            let changes: Vec<Change> = old
                .changes
                .into_iter()
                .zip(payload.changes)
                .map(|(o, n)| {
                    let mut after = o.after;
                    after.extend(n.after);
                    Change { id: o.id, before: o.before, after }
                })
                .collect();
            let merged = Payload { changes, ..Default::default() };
            db.execute("UPDATE journal SET payload = ?2, created_at = ?3 WHERE seq = ?1", params![entry.seq, serde_json::to_string(&merged).map_err(e)?, now]).map_err(e)?;
            return Ok(JournalEntry { created_at: now, ..entry });
        }
    }
    let ids: Vec<String> = payload.changes.iter().map(|c| c.id.clone()).collect();
    db.execute(
        "INSERT INTO journal(kind, label, count, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![kind, label, count, serde_json::to_string(&payload).map_err(e)?, now],
    )
    .map_err(e)?;
    let seq = db.last_insert_rowid();
    db.execute("DELETE FROM journal WHERE seq <= ?1", [seq - MAX_ENTRIES]).map_err(e)?;
    Ok(JournalEntry { seq, kind: kind.into(), label: label.into(), count, created_at: now, ids, undone: false })
}

/// The values `formulas` give on source `id` (a failing formula leaves its property alone).
fn formula_patch(db: &Connection, id: &str, formulas: &Map<String, Json>) -> Result<Map<String, Json>> {
    Ok(formulas
        .iter()
        .filter_map(|(name, formula)| Some((name.clone(), crate::formula::evaluate_on(db, id, formula.as_str()?).ok()?.to_json())))
        .collect())
}

fn default_label(n: usize, edit: &BatchEdit) -> String {
    let what = plural(n, "source");
    let fields = edit.patch.keys().filter(|k| *k != "properties").count() + edit.patch.get("properties").and_then(Json::as_object).map_or(0, |p| p.len());
    match (fields > 0, !edit.tags_add.is_empty() || !edit.tags_remove.is_empty(), !edit.collections_add.is_empty() || !edit.collections_remove.is_empty()) {
        (false, true, false) if edit.tags_remove.is_empty() => format!("Tag {what}"),
        (false, true, false) => format!("Change tags of {what}"),
        (false, false, true) => format!("Change collections of {what}"),
        (true, false, false) if fields == 1 && n == 1 => {
            let key = edit.patch.keys().next().cloned().unwrap_or_default();
            let key = if key == "properties" { edit.patch["properties"].as_object().and_then(|p| p.keys().next().cloned()).unwrap_or(key) } else { key };
            format!("Edit {}", field_label(&key))
        }
        _ => format!("Edit {what}"),
    }
}

/// A field's name as the inspector shows it.
pub fn field_label(key: &str) -> String {
    match key {
        "itemType" => "item type".into(),
        "containerTitle" => "publication".into(),
        "shortTitle" => "short title".into(),
        "doi" => "DOI".into(),
        "isbn" => "ISBN".into(),
        "issn" => "ISSN".into(),
        "pmid" => "PMID".into(),
        "pmcid" => "PMCID".into(),
        "arxivId" => "arXiv ID".into(),
        "url" => "URL".into(),
        "citationKey" => "citation key".into(),
        "creators" => "authors".into(),
        other => {
            let mut out = String::new();
            for c in other.chars() {
                if c.is_uppercase() {
                    out.push(' ');
                    out.extend(c.to_lowercase());
                } else {
                    out.push(c);
                }
            }
            out
        }
    }
}

// ── Journaled collection, note and import operations ─────────────────────────────

fn collection_name(db: &Connection, id: &str) -> Result<String> {
    Ok(db.query_row("SELECT name FROM collections WHERE id = ?", [id], |r| r.get::<_, String>(0)).optional().map_err(e)?.unwrap_or_default())
}

impl Store {
    /// Creates a collection, journaled (the library's sidebar).
    pub fn create_collection_undoable(&self, name: &str, parent_id: Option<&str>) -> Result<(crate::Collection, Option<JournalEntry>)> {
        let id = crate::new_id();
        let label = format!("New collection “{}”", name.trim());
        let (_, entry) = self.journaled("collection", &label, &[], |db, rec| {
            rec.watch_in(db, "collections", "id", std::slice::from_ref(&id))?;
            crate::create_collection_in(db, &id, name, parent_id, None).map(|_| ())
        })?;
        let collection = self.collections()?.into_iter().find(|c| c.id == id).ok_or("Collection missing")?;
        Ok((collection, entry))
    }

    /// Renames or moves a collection, journaled.
    pub fn update_collection_undoable(&self, id: &str, name: Option<&str>, parent_id: Option<Option<&str>>) -> Result<Option<JournalEntry>> {
        let old = collection_name(&*self.read()?, id)?;
        let label = match name {
            Some(name) if name.trim() != old => format!("Rename “{old}” to “{}”", name.trim()),
            _ => format!("Move “{old}”"),
        };
        Ok(self
            .journaled("collection", &label, &[], |db, rec| {
                rec.watch_in(db, "collections", "id", &[id.to_string()])?;
                crate::update_collection_in(db, id, name, parent_id)
            })?
            .1)
    }

    /// Reorders (and re-parents) collections, journaled.
    pub fn reorder_collections_undoable(&self, parent_id: Option<&str>, ids: &[String]) -> Result<Option<JournalEntry>> {
        let label = if ids.len() == 1 { format!("Move “{}”", collection_name(&*self.read()?, &ids[0])?) } else { format!("Move {} collections", ids.len()) };
        Ok(self
            .journaled("collection", &label, &[], |db, rec| {
                rec.watch(db, "collections", "parent_id IS ?1 OR id IN (SELECT value FROM json_each(?2))", vec![
                    parent_id.map_or(Value::Null, |p| Value::Text(p.into())),
                    Value::Text(serde_json::to_string(ids).map_err(e)?),
                ])?;
                crate::reorder_collections_in(db, parent_id, ids)
            })?
            .1)
    }

    /// Deletes a collection and those under it, journaled: undo brings them back with the
    /// sources filed in them.
    pub fn delete_collection_undoable(&self, id: &str) -> Result<Option<JournalEntry>> {
        let label = format!("Delete collection “{}”", collection_name(&*self.read()?, id)?);
        Ok(self
            .journaled("collection", &label, &[], |db, rec| {
                let tree = crate::collection_subtree(db, id)?;
                rec.watch_in(db, "collections", "id", &tree)?;
                rec.watch_in(db, "source_collections", "collection_id", &tree)?;
                db.execute("DELETE FROM collections WHERE id = ?", [id]).map_err(e)?;
                Ok(())
            })?
            .1)
    }

    /// Deletes a note, journaled: undo brings it back with the links it wrote (and the
    /// links to it whole again); its passages are cut again.
    pub fn delete_note_undoable(&self, id: &str) -> Result<Option<JournalEntry>> {
        let title: String = self.read()?.query_row("SELECT title FROM notes WHERE id = ?", [id], |r| r.get(0)).optional().map_err(e)?.unwrap_or_default();
        let label = if title.trim().is_empty() { "Delete note".to_string() } else { format!("Delete note “{}”", title.trim()) };
        Ok(self
            .journaled("note", &label, &[], |db, rec| {
                rec.watch_in(db, "notes", "id", &[id.to_string()])?;
                rec.watch(db, "links", "(owner_kind = 'note' AND owner_id = ?1) OR (to_kind = 'note' AND to_id = ?1)", vec![Value::Text(id.into())])?;
                let source: Option<String> = db.query_row("SELECT source_id FROM notes WHERE id = ?", [id], |r| r.get(0)).optional().map_err(e)?.flatten();
                db.execute("DELETE FROM notes WHERE id = ?", [id]).map_err(e)?;
                crate::links::forget_item(db, crate::links::NOTE, id)?;
                if let Some(source) = source {
                    refresh_fts(db, &source)?;
                }
                Ok(())
            })?
            .1)
    }

    /// Journals an operation that already ran in several steps (a bibliography import):
    /// the sources it added, rows it added (`(table, column, ids)`: notes, collections), and
    /// existing sources it changed with the values to put back (an import's merge patch).
    pub fn journal_added(&self, kind: &str, label: &str, created: &[String], rows: &[(&str, &str, Vec<String>)], changed: &[(String, Map<String, Json>)]) -> Result<Option<JournalEntry>> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let mut payload = Payload { created: created.to_vec(), ..Default::default() };
        for (table, column, ids) in rows {
            let (table, keys) = ROW_TABLES.iter().find(|(t, _)| t == table).copied().ok_or("Unknown table for the journal")?;
            for chunk in ids.chunks(500) {
                let marks = vec!["?"; chunk.len()].join(", ");
                let values: Vec<Value> = chunk.iter().map(|i| Value::Text(i.clone())).collect();
                let watch = Watch { table, keys, condition: format!("{column} IN ({marks})"), values, before: Vec::new() };
                payload.rows.extend(watch.finish(&tx)?);
            }
        }
        for (id, undo) in changed {
            let Some(after) = capture(&tx, id)? else { continue };
            let mut before = after.clone();
            for (key, value) in undo {
                if key == "properties" {
                    let mut properties = before.get("properties").and_then(Json::as_object).cloned().unwrap_or_default();
                    for (name, old) in value.as_object().into_iter().flatten() {
                        if old.is_null() {
                            properties.remove(name);
                        } else {
                            properties.insert(name.clone(), old.clone());
                        }
                    }
                    before.insert(key.clone(), Json::Object(properties));
                } else if key == "collectionsRemove" {
                    let gone: Vec<&str> = value.as_array().into_iter().flatten().filter_map(Json::as_str).collect();
                    let kept: Vec<Json> = before.get("collections").and_then(Json::as_array).into_iter().flatten().filter(|c| !c.as_str().is_some_and(|c| gone.contains(&c))).cloned().collect();
                    before.insert("collections".into(), Json::Array(kept));
                } else {
                    before.insert(key.clone(), value.clone());
                }
            }
            let (before, after) = diff(&before, &after);
            if !before.is_empty() {
                payload.changes.push(Change { id: id.clone(), before, after });
            }
        }
        let entry = if payload.is_empty() { None } else { Some(record(&tx, kind, label, payload)?) };
        tx.commit().map_err(e)?;
        Ok(entry)
    }
}

#[cfg(test)]

mod tests {
    use super::BatchEdit;
    use crate::{SourceInput, Store};
    use serde_json::{Map, Value as Json, json};

    fn source(store: &Store, title: &str, tags: &[&str]) -> String {
        let mut fields = Map::new();
        fields.insert("title".into(), Json::from(title));
        store.insert_source(SourceInput { kind: "reference".into(), tags: tags.iter().map(|t| t.to_string()).collect(), fields, ..Default::default() }).unwrap().id
    }

    fn edit(value: Json) -> BatchEdit {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn batch_edit_undo_and_redo() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = source(&store, "A", &["x"]);
        let b = source(&store, "B", &["y", "x"]);
        let c = store.create_collection("Reading", None, None).unwrap().id;
        let op = store
            .edit_sources(&[a.clone(), b.clone()], &edit(json!({"patch": {"publisher": "MIT Press", "itemType": "book"}, "tagsAdd": ["new"], "tagsRemove": ["x"], "collectionsAdd": [c]})), None)
            .unwrap();
        assert_eq!(op.affected, 2);
        let entry = op.entry.unwrap();
        assert_eq!(entry.label, "Edit 2 sources");
        let a1 = store.source(&a).unwrap().unwrap();
        assert_eq!(a1.tags, vec!["new"]);
        assert_eq!(a1.field("publisher"), Some("MIT Press"));
        assert_eq!(a1.collections, vec![c.clone()]);
        let mut edited: Vec<String> = serde_json::from_value(a1.fields["editedFields"].clone()).unwrap();
        edited.sort();
        assert_eq!(edited, vec!["itemType", "publisher"]);
        assert_eq!(store.source(&b).unwrap().unwrap().tags, vec!["y", "new"]);

        let undone = store.undo().unwrap().unwrap();
        assert_eq!(undone.seq, entry.seq);
        let a2 = store.source(&a).unwrap().unwrap();
        assert_eq!(a2.tags, vec!["x"]);
        assert_eq!(a2.field("publisher"), None);
        assert_eq!(a2.field("itemType"), Some("document"));
        assert!(a2.collections.is_empty());
        assert!(a2.fields.get("editedFields").is_none());
        assert_eq!(store.source(&b).unwrap().unwrap().tags, vec!["y", "x"]);
        assert!(store.journal_state(10).unwrap().redo.is_some());

        store.redo().unwrap().unwrap();
        assert_eq!(store.source(&a).unwrap().unwrap().tags, vec!["new"]);
        assert_eq!(store.source(&b).unwrap().unwrap().field("itemType"), Some("book"));
        assert!(store.journal_state(10).unwrap().redo.is_none());
        // Nothing more to redo; undo again works.
        assert!(store.redo().unwrap().is_none());
        store.undo().unwrap().unwrap();
        assert_eq!(store.source(&b).unwrap().unwrap().field("itemType"), Some("document"));
    }

    #[test]
    fn undo_keeps_later_unrelated_changes_and_a_new_operation_drops_redo() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = source(&store, "A", &[]);
        store.edit_sources(std::slice::from_ref(&a), &edit(json!({"patch": {"volume": "3"}})), None).unwrap();
        // A lookup fills another field afterwards.
        let mut patch = Map::new();
        patch.insert("issue".into(), json!("7"));
        store.update_source(&a, &patch).unwrap();
        store.undo().unwrap();
        let a1 = store.source(&a).unwrap().unwrap();
        assert_eq!(a1.field("volume"), None);
        assert_eq!(a1.field("issue"), Some("7"));
        store.trash_sources(std::slice::from_ref(&a), true).unwrap();
        assert!(store.journal_state(10).unwrap().redo.is_none());
        assert!(store.source(&a).unwrap().unwrap().trashed_at.is_some());
        let entry = store.undo().unwrap().unwrap();
        assert_eq!(entry.label, "Move 1 source to the Trash");
        assert!(store.source(&a).unwrap().unwrap().trashed_at.is_none());
    }

    #[test]
    fn quick_edits_of_one_field_are_one_entry_and_the_journal_survives_reopening() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = Store::open(dir.path()).unwrap();
            let a = source(&store, "A", &[]);
            for title in ["A b", "A bo", "A book"] {
                store.edit_sources(std::slice::from_ref(&a), &edit(json!({"patch": {"title": title}})), None).unwrap();
            }
            assert_eq!(store.journal_state(10).unwrap().entries.len(), 1);
        }
        let store = Store::open(dir.path()).unwrap();
        let entry = store.undo().unwrap().unwrap();
        assert_eq!(entry.label, "Edit title");
        let id = entry.ids[0].clone();
        assert_eq!(store.source(&id).unwrap().unwrap().title(), "A");
    }

    #[test]
    fn collection_membership_is_journaled() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = source(&store, "A", &[]);
        let c = store.create_collection("Thesis", None, None).unwrap().id;
        let op = store.file_sources(&c, std::slice::from_ref(&a), true).unwrap();
        assert_eq!(op.entry.unwrap().label, "Add 1 source to “Thesis”");
        assert_eq!(store.source(&a).unwrap().unwrap().collections, vec![c.clone()]);
        store.undo().unwrap();
        assert!(store.source(&a).unwrap().unwrap().collections.is_empty());
    }

    #[test]
    fn collections_notes_tags_and_imports_share_the_journal() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = source(&store, "A", &["ml"]);
        // Collections: create, rename, nest, delete with what is filed in them.
        let (parent, _) = store.create_collection_undoable("Thesis", None).unwrap();
        let (child, _) = store.create_collection_undoable("Chapter 1", None).unwrap();
        store.update_collection_undoable(&child.id, Some("Chapter one"), Some(Some(&parent.id))).unwrap();
        store.file_sources(&child.id, std::slice::from_ref(&a), true).unwrap();
        let entry = store.delete_collection_undoable(&parent.id).unwrap().unwrap();
        assert_eq!(entry.label, "Delete collection “Thesis”");
        assert!(store.collections().unwrap().is_empty());
        store.undo().unwrap();
        let names: Vec<(String, Option<String>)> = store.collections().unwrap().into_iter().map(|c| (c.name, c.parent_id)).collect();
        assert!(names.contains(&("Chapter one".into(), Some(parent.id.clone()))), "{names:?}");
        assert_eq!(store.source(&a).unwrap().unwrap().collections, vec![child.id.clone()]);
        store.redo().unwrap();
        assert!(store.collections().unwrap().is_empty());
        store.undo().unwrap();
        // Back past the filing and the rename.
        store.undo().unwrap();
        assert_eq!(store.undo().unwrap().unwrap().label, "Rename “Chapter 1” to “Chapter one”");
        let c = store.collections().unwrap().into_iter().find(|c| c.id == child.id).unwrap();
        assert_eq!((c.name.as_str(), c.parent_id), ("Chapter 1", None));

        // A deleted note comes back with its links.
        let note = store.save_note(None, Some(&a), "Reading notes", "Body", None).unwrap();
        store.delete_note_undoable(&note.id).unwrap().unwrap();
        assert!(store.note(&note.id).unwrap().is_none());
        store.undo().unwrap();
        assert_eq!(store.note(&note.id).unwrap().unwrap().title, "Reading notes");
        assert!(store.stale_notes(10).unwrap().iter().any(|n| n.id == note.id));

        // Tag manager operations are entries too.
        let op: crate::TagOperation = serde_json::from_value(json!({"replace": [{"from": "ml", "to": ["Machine learning"]}], "tree": {"Machine learning": {"parent": "Methods"}}})).unwrap();
        let result = store.apply_tags(&op).unwrap();
        assert_eq!(result.entry.unwrap().label, "Rename tag “ml” to “Machine learning”");
        assert_eq!(store.source(&a).unwrap().unwrap().tags, vec!["Machine learning"]);
        store.undo().unwrap();
        assert_eq!(store.source(&a).unwrap().unwrap().tags, vec!["ml"]);
        assert!(store.tag_index().unwrap()["tree"].as_object().unwrap().is_empty());

        // An import that ran in steps, journaled afterwards; undone out of order.
        let b = source(&store, "Imported", &[]);
        let mut undo = Map::new();
        undo.insert("volume".into(), Json::Null);
        let mut patch = Map::new();
        patch.insert("volume".into(), json!("4"));
        store.update_source(&a, &patch).unwrap();
        let imported = store.journal_added("import", "Import refs.bib", std::slice::from_ref(&b), &[], &[(a.clone(), undo)]).unwrap().unwrap();
        store.edit_sources(std::slice::from_ref(&a), &edit(json!({"patch": {"publisher": "X"}})), None).unwrap();
        store.undo_entry(imported.seq).unwrap().unwrap();
        assert!(store.source(&b).unwrap().unwrap().trashed_at.is_some());
        let a1 = store.source(&a).unwrap().unwrap();
        assert_eq!((a1.field("volume"), a1.field("publisher")), (None, Some("X")));
        assert!(store.journal_entry(imported.seq).unwrap().unwrap().1);
    }
}
