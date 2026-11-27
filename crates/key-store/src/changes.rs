// What changed on which source, for features that keep something derived from sources up to
// date (stored formula values, AI answers, review criteria). One set of triggers writes a
// `(seq, source_id, kind)` row into `source_input_changes` when a value actually changes;
// each consumer reads the rows after its own cursor and acknowledges what it handled, and
// rows every consumer has passed are pruned.
//
// Kinds: a metadata field's name as the app calls it (`title`, `year`, `containerTitle`,
// `doi`, `readState`, … see `KINDS`), `creators`, `tags`, `starred`, `kind`, `property:<name>`
// (a custom property, as stored), `files` (file path, hash, type or size), `text` (its text
// was read again), `collections` (membership, or a collection it is in was renamed), `notes`,
// `highlights`, `reading` (opened or read), `cited` (a source in the library now cites it, or
// stopped), `references` (its references matched the library differently), `trashed`,
// `merged`, `added` (a new source) and `removed` (deleted).
use crate::{Result, e};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS source_input_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS source_input_changes_source ON source_input_changes(source_id, seq);
CREATE TABLE IF NOT EXISTS source_change_cursors (
  consumer TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);
";

/// Sources columns and the kind a change to them records. Columns not listed (index
/// progress, lookup bookkeeping, `updated_at`) record nothing.
const KINDS: &[(&str, &str)] = &[
    ("item_type", "itemType"), ("title", "title"), ("short_title", "shortTitle"), ("date", "date"), ("container_title", "containerTitle"),
    ("container_short", "containerShort"), ("volume", "volume"), ("issue", "issue"), ("pages", "pages"), ("edition", "edition"), ("series", "series"),
    ("publisher", "publisher"), ("place", "place"), ("institution", "institution"), ("genre", "genre"), ("doi", "doi"), ("isbn", "isbn"), ("issn", "issn"),
    ("pmid", "pmid"), ("pmcid", "pmcid"), ("arxiv_id", "arxivId"), ("url", "url"), ("accessed", "accessed"), ("abstract", "abstract"),
    ("language", "language"), ("rights", "rights"), ("citation_key", "citationKey"), ("extra", "extra"), ("read_state", "readState"),
    ("openalex_id", "openalexId"), ("work_type", "workType"), ("oa_status", "oaStatus"), ("oa_url", "oaUrl"), ("venue_id", "venueId"),
    ("publisher_id", "publisherId"), ("retraction_kind", "retractionKind"), ("retraction_notice", "retractionNotice"), ("retraction_date", "retractionDate"),
    ("year", "year"), ("duration_seconds", "durationSeconds"), ("page_count", "pageCount"), ("retracted", "retracted"), ("cited_by_count", "citedByCount"),
    ("fwci", "fwci"), ("retraction_dismissed", "retractionDismissed"), ("creators", "creators"), ("tags", "tags"), ("starred", "starred"), ("kind", "kind"),
    ("added_at", "added"), ("file_path", "files"), ("file_hash", "files"), ("mime", "files"), ("file_size", "files"), ("index_status", "text"),
    ("trashed_at", "trashed"), ("merged_into", "merged"),
];

/// The kind a change to a sources column records, if any.
pub fn kind_of_column(column: &str) -> Option<&'static str> {
    KINDS.iter().find(|(c, _)| *c == column).map(|(_, k)| *k)
}

/// A change: `kind` happened to `source_id`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub seq: i64,
    pub source_id: String,
    pub kind: String,
}

fn log(id: &str, kind: &str) -> String {
    format!("INSERT INTO source_input_changes(source_id, kind) SELECT {id}, '{kind}' WHERE {id} IS NOT NULL;")
}

const TRIGGERS: [&str; 17] = [
    "source_changes_insert", "source_changes_update", "source_changes_delete", "source_changes_file", "source_changes_unfile", "source_changes_collection_name",
    "source_changes_note_add", "source_changes_note_remove", "source_changes_note_move", "source_changes_highlight_add", "source_changes_highlight_remove",
    "source_changes_reading_add", "source_changes_reading_change", "source_changes_reading_remove", "source_changes_cite_add", "source_changes_cite_remove",
    "source_changes_cite_match",
];

fn triggers(db: &Connection) -> Result<String> {
    let columns: Vec<String> = {
        let mut statement = db.prepare("SELECT name FROM pragma_table_info('sources')").map_err(e)?;
        statement.query_map([], |r| r.get::<_, String>(0)).map_err(e)?.collect::<std::result::Result<_, _>>().map_err(e)?
    };
    let compared = columns
        .iter()
        .filter_map(|c| kind_of_column(c).map(|k| (c, k)))
        .map(|(c, k)| format!("SELECT '{k}' AS k WHERE OLD.{c} IS NOT NEW.{c}"))
        .collect::<Vec<_>>()
        .join(" UNION ");
    let json = |side: &str| format!("CASE WHEN json_valid({side}.properties) THEN {side}.properties ELSE '{{}}' END");
    let (new, old) = (json("NEW"), json("OLD"));
    let mut sql: String = TRIGGERS.iter().map(|t| format!("DROP TRIGGER IF EXISTS {t};\n")).collect();
    sql.push_str(&format!(
        "CREATE TRIGGER source_changes_insert AFTER INSERT ON sources BEGIN {} END;
         CREATE TRIGGER source_changes_update AFTER UPDATE ON sources BEGIN
           INSERT INTO source_input_changes(source_id, kind) SELECT NEW.id, k FROM ({compared});
           INSERT INTO source_input_changes(source_id, kind)
             SELECT NEW.id, 'property:' || key FROM (
               SELECT key, value FROM json_each({new}) EXCEPT SELECT key, value FROM json_each({old})
               UNION SELECT key, NULL FROM json_each({old}) WHERE key NOT IN (SELECT key FROM json_each({new})))
             WHERE OLD.properties IS NOT NEW.properties;
         END;
         CREATE TRIGGER source_changes_delete AFTER DELETE ON sources BEGIN {} END;
         CREATE TRIGGER source_changes_file AFTER INSERT ON source_collections BEGIN {} END;
         CREATE TRIGGER source_changes_unfile AFTER DELETE ON source_collections BEGIN {} END;
         CREATE TRIGGER source_changes_collection_name AFTER UPDATE OF name ON collections WHEN OLD.name IS NOT NEW.name BEGIN
           INSERT INTO source_input_changes(source_id, kind) SELECT source_id, 'collections' FROM source_collections WHERE collection_id = NEW.id;
         END;
         CREATE TRIGGER source_changes_note_add AFTER INSERT ON notes BEGIN {} END;
         CREATE TRIGGER source_changes_note_remove AFTER DELETE ON notes BEGIN {} END;
         CREATE TRIGGER source_changes_note_move AFTER UPDATE OF source_id ON notes WHEN OLD.source_id IS NOT NEW.source_id BEGIN {} {} END;
         CREATE TRIGGER source_changes_highlight_add AFTER INSERT ON annotations BEGIN {} END;
         CREATE TRIGGER source_changes_highlight_remove AFTER DELETE ON annotations BEGIN {} END;
         CREATE TRIGGER source_changes_reading_add AFTER INSERT ON source_reading BEGIN {} END;
         CREATE TRIGGER source_changes_reading_change AFTER UPDATE ON source_reading BEGIN {} END;
         CREATE TRIGGER source_changes_reading_remove AFTER DELETE ON source_reading BEGIN {} END;
         CREATE TRIGGER source_changes_cite_add AFTER INSERT ON source_cites BEGIN {} {} END;
         CREATE TRIGGER source_changes_cite_remove AFTER DELETE ON source_cites BEGIN {} {} END;
         CREATE TRIGGER source_changes_cite_match AFTER UPDATE OF matched_source_id ON source_cites WHEN OLD.matched_source_id IS NOT NEW.matched_source_id BEGIN {} {} {} END;",
        log("NEW.id", "added"),
        log("OLD.id", "removed"),
        log("NEW.source_id", "collections"),
        log("OLD.source_id", "collections"),
        log("NEW.source_id", "notes"),
        log("OLD.source_id", "notes"),
        log("OLD.source_id", "notes"),
        log("NEW.source_id", "notes"),
        log("NEW.source_id", "highlights"),
        log("OLD.source_id", "highlights"),
        log("NEW.source_id", "reading"),
        log("NEW.source_id", "reading"),
        log("OLD.source_id", "reading"),
        log("NEW.matched_source_id", "cited"),
        log("NEW.source_id", "references"),
        log("OLD.matched_source_id", "cited"),
        log("OLD.source_id", "references"),
        log("OLD.matched_source_id", "cited"),
        log("NEW.matched_source_id", "cited"),
        log("NEW.source_id", "references"),
    ));
    Ok(sql)
}

/// Rows kept at most when consumers lag (a consumer past this rebuilds instead).
const KEEP: i64 = 500_000;

/// Creates the log and its triggers (after the tables they watch exist; recreated on each
/// open so they follow new sources columns), and prunes what every consumer has passed.
pub(crate) fn ensure_schema(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA).map_err(e)?;
    let tx = db.unchecked_transaction().map_err(e)?;
    tx.execute_batch(&triggers(&tx)?).map_err(e)?;
    prune(&tx)?;
    tx.execute("DELETE FROM source_input_changes WHERE seq <= (SELECT max(seq) FROM source_input_changes) - ?", [KEEP]).map_err(e)?;
    tx.commit().map_err(e)
}

/// The latest change's sequence number (0 when none was ever logged).
pub fn latest(db: &Connection) -> Result<i64> {
    let logged: Option<i64> = db.query_row("SELECT seq FROM sqlite_sequence WHERE name = 'source_input_changes'", [], |r| r.get(0)).optional().map_err(e)?;
    Ok(logged.unwrap_or(0))
}

/// `consumer`'s cursor; a new consumer starts at the latest change (it builds its state
/// from the library itself, then follows changes from here).
pub fn cursor(db: &Connection, consumer: &str) -> Result<i64> {
    if let Some(seq) = db.query_row("SELECT seq FROM source_change_cursors WHERE consumer = ?", [consumer], |r| r.get(0)).optional().map_err(e)? {
        return Ok(seq);
    }
    let seq = latest(db)?;
    db.execute("INSERT INTO source_change_cursors(consumer, seq) VALUES (?1, ?2)", params![consumer, seq]).map_err(e)?;
    Ok(seq)
}

/// Whether the log still holds everything after `seq` (else a consumer must rebuild).
pub fn complete_since(db: &Connection, seq: i64) -> Result<bool> {
    let first: Option<i64> = db.query_row("SELECT min(seq) FROM source_input_changes", [], |r| r.get(0)).map_err(e)?;
    Ok(first.is_none_or(|first| first <= seq + 1) || latest(db)? <= seq)
}

/// Up to `limit` changes after `consumer`'s cursor, oldest first.
pub fn read_since(db: &Connection, consumer: &str, limit: usize) -> Result<Vec<Change>> {
    let since = cursor(db, consumer)?;
    let mut statement = db.prepare_cached("SELECT seq, source_id, kind FROM source_input_changes WHERE seq > ?1 ORDER BY seq LIMIT ?2").map_err(e)?;
    let rows = statement.query_map(params![since, limit as i64], |r| Ok(Change { seq: r.get(0)?, source_id: r.get(1)?, kind: r.get(2)? })).map_err(e)?;
    rows.collect::<std::result::Result<_, _>>().map_err(e)
}

/// Sources among `ids` with changes `consumer` has not handled yet.
pub fn pending_for(db: &Connection, consumer: &str, ids: &[String]) -> Result<Vec<String>> {
    let since: Option<i64> = db.query_row("SELECT seq FROM source_change_cursors WHERE consumer = ?", [consumer], |r| r.get(0)).optional().map_err(e)?;
    let Some(since) = since else { return Ok(Vec::new()) };
    let list = serde_json::to_string(ids).map_err(e)?;
    let mut statement = db
        .prepare_cached("SELECT DISTINCT source_id FROM source_input_changes WHERE source_id IN (SELECT value FROM json_each(?1)) AND seq > ?2")
        .map_err(e)?;
    let rows = statement.query_map(params![list, since], |r| r.get(0)).map_err(e)?;
    rows.collect::<std::result::Result<_, _>>().map_err(e)
}

/// `consumer` has handled every change up to `seq`.
pub fn ack(db: &Connection, consumer: &str, seq: i64) -> Result<()> {
    db.execute(
        "INSERT INTO source_change_cursors(consumer, seq) VALUES (?1, ?2) ON CONFLICT(consumer) DO UPDATE SET seq = max(seq, excluded.seq)",
        params![consumer, seq],
    )
    .map_err(e)?;
    prune(db)
}

/// Forgets a consumer (a feature turned off), so it no longer holds the log back.
pub fn forget(db: &Connection, consumer: &str) -> Result<()> {
    db.execute("DELETE FROM source_change_cursors WHERE consumer = ?", [consumer]).map_err(e)?;
    prune(db)
}

fn prune(db: &Connection) -> Result<()> {
    db.execute("DELETE FROM source_input_changes WHERE seq <= coalesce((SELECT min(seq) FROM source_change_cursors), (SELECT max(seq) FROM source_input_changes))", [])
        .map_err(e)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SourceInput, Store};
    use serde_json::{Map, Value as Json, json};

    fn kinds(changes: &[Change]) -> Vec<(&str, &str)> {
        let mut out: Vec<(&str, &str)> = changes.iter().map(|c| (c.source_id.as_str(), c.kind.as_str())).collect();
        out.sort();
        out
    }

    #[test]
    fn logs_real_changes_per_consumer_and_prunes_what_all_have_passed() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let db = || store.db().unwrap();
        // Consumers start at the latest change.
        cursor(&db(), "a").unwrap();
        cursor(&db(), "b").unwrap();
        let input: SourceInput = serde_json::from_value(json!({"kind": "reference", "title": "One", "properties": {"Score": 1, "Keep": "x"}})).unwrap();
        let id = store.insert_source(input).unwrap().id;
        let patch = |value: Json| store.update_source(&id, serde_json::from_value::<Map<String, Json>>(value).as_ref().unwrap()).unwrap();
        patch(json!({"title": "Two", "year": 2020, "tags": ["t"], "properties": {"Score": 2, "Keep": "x"}}));
        // The same values again, and only bookkeeping: nothing.
        patch(json!({"title": "Two", "year": 2020}));
        let collection = store.create_collection("C", None, None).unwrap();
        store.file_sources(&collection.id, std::slice::from_ref(&id), true).unwrap();
        store.update_collection(&collection.id, Some("D"), None).unwrap();
        store.save_note(None, Some(&id), "", "Body", None).unwrap();
        let changes = read_since(&db(), "a", 100).unwrap();
        assert_eq!(
            kinds(&changes),
            [(&*id, "added"), (&*id, "collections"), (&*id, "collections"), (&*id, "notes"), (&*id, "property:Score"), (&*id, "tags"), (&*id, "title"), (&*id, "year")]
                .map(|(i, k)| (i, k))
                .to_vec()
        );
        assert_eq!(pending_for(&db(), "a", std::slice::from_ref(&id)).unwrap(), vec![id.clone()]);
        let last = changes.last().unwrap().seq;
        ack(&db(), "a", last).unwrap();
        assert!(read_since(&db(), "a", 100).unwrap().is_empty());
        assert!(pending_for(&db(), "a", std::slice::from_ref(&id)).unwrap().is_empty());
        // "b" has not read them: they stay until it has.
        assert_eq!(read_since(&db(), "b", 100).unwrap().len(), changes.len());
        ack(&db(), "b", last).unwrap();
        let left: i64 = db().query_row("SELECT count(*) FROM source_input_changes", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
        // A property removed, and the source deleted.
        patch(json!({"properties": {"Keep": null}}));
        store.delete(std::slice::from_ref(&id)).unwrap();
        let changes = read_since(&db(), "a", 100).unwrap();
        assert!(changes.iter().any(|c| c.kind == "property:Keep"), "{changes:?}");
        assert_eq!(changes.last().map(|c| c.kind.as_str()), Some("removed"));
        assert!(complete_since(&db(), last).unwrap());
    }

    #[test]
    fn citations_mark_the_cited_source_and_the_citing_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let add = |title: &str| store.insert_source(serde_json::from_value(json!({"kind": "reference", "title": title})).unwrap()).unwrap().id;
        let (a, b) = (add("A"), add("B"));
        cursor(&store.db().unwrap(), "c").unwrap();
        store.db().unwrap().execute("INSERT INTO source_cites(source_id, seq, openalex_id, matched_source_id) VALUES (?1, 0, 'W1', ?2)", params![a, b]).unwrap();
        let changes = read_since(&store.db().unwrap(), "c", 10).unwrap();
        let mut expected = vec![(a.as_str(), "references"), (b.as_str(), "cited")];
        expected.sort();
        assert_eq!(kinds(&changes), expected);
    }
}
