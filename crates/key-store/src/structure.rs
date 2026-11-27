// The document structure layout analysis found for a source (blocks in reading order with
// their sentences and geometry, page sizes, pictures), kept as the indexer's JSON so reading
// mode can show the document as text (key-index reflow.rs). One row per source; analysing the
// source again replaces it, and a source read without layout analysis has none.
use crate::{Result, Store, e, now_ms};
use rusqlite::{Connection, OptionalExtension, params};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS source_structure (
  source_id TEXT PRIMARY KEY,
  file_hash TEXT NOT NULL,
  engine TEXT NOT NULL,
  layout TEXT NOT NULL,
  stored_at INTEGER NOT NULL
);
";

pub(crate) fn ensure_schema(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA).map_err(e)
}

/// A source's stored structure.
#[derive(Clone, Debug)]
pub struct StoredStructure {
    pub file_hash: String,
    pub engine: String,
    /// key-index's `Layout` as JSON.
    pub layout: String,
    pub stored_at: i64,
}

impl Store {
    pub fn set_structure(&self, source_id: &str, file_hash: &str, engine: &str, layout: &str) -> Result<()> {
        self.db()?
            .execute(
                "INSERT INTO source_structure(source_id, file_hash, engine, layout, stored_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(source_id) DO UPDATE SET file_hash = ?2, engine = ?3, layout = ?4, stored_at = ?5",
                params![source_id, file_hash, engine, layout, now_ms()],
            )
            .map(|_| ())
            .map_err(e)
    }

    pub fn structure(&self, source_id: &str) -> Result<Option<StoredStructure>> {
        self.read()?
            .query_row("SELECT file_hash, engine, layout, stored_at FROM source_structure WHERE source_id = ?", [source_id], |r| {
                Ok(StoredStructure { file_hash: r.get(0)?, engine: r.get(1)?, layout: r.get(2)?, stored_at: r.get(3)? })
            })
            .optional()
            .map_err(e)
    }

    pub fn clear_structure(&self, source_id: &str) -> Result<()> {
        self.db()?.execute("DELETE FROM source_structure WHERE source_id = ?", [source_id]).map(|_| ()).map_err(e)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn keeps_one_structure_per_source() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::Store::open(dir.path()).unwrap();
        assert!(store.structure("s1").unwrap().is_none());
        store.set_structure("s1", "h1", "layout", "{\"a\":1}").unwrap();
        store.set_structure("s1", "h2", "layout-onnx", "{\"a\":2}").unwrap();
        let found = store.structure("s1").unwrap().unwrap();
        assert_eq!((found.file_hash.as_str(), found.engine.as_str(), found.layout.as_str()), ("h2", "layout-onnx", "{\"a\":2}"));
        store.clear_structure("s1").unwrap();
        assert!(store.structure("s1").unwrap().is_none());
    }
}
