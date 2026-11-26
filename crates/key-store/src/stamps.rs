// What changed since an export last ran: a short stamp per source with annotations (its
// highlights and its own record) and per note, compared with the stamp an exporter kept.
use super::{Result, Store, e};
use std::collections::HashMap;

impl Store {
    /// Sources with annotations: id → "count:latest annotation change:source change".
    pub fn annotation_stamps(&self) -> Result<HashMap<String, String>> {
        let db = self.read()?;
        let mut statement = db
            .prepare(
                "SELECT a.source_id, count(*), max(a.updated_at), s.updated_at FROM annotations a JOIN sources s ON s.id = a.source_id
                 WHERE s.trashed_at IS NULL AND s.merged_into IS NULL GROUP BY a.source_id",
            )
            .map_err(e)?;
        let rows = statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, format!("{}:{}:{}", r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))))
            .map_err(e)?;
        rows.collect::<std::result::Result<_, _>>().map_err(e)
    }

    /// Every note: id → its last change.
    pub fn note_stamps(&self) -> Result<HashMap<String, String>> {
        let db = self.read()?;
        let mut statement = db.prepare("SELECT id, updated_at FROM notes").map_err(e)?;
        let rows = statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?.to_string()))).map_err(e)?;
        rows.collect::<std::result::Result<_, _>>().map_err(e)
    }
}

#[cfg(test)]
mod tests {
    use crate::{SourceInput, Store};
    use serde_json::{Map, Value as Json, json};

    fn source(store: &Store, title: &str, file: &std::path::Path) -> String {
        let mut fields = Map::new();
        fields.insert("title".into(), Json::from(title));
        fields.insert("filePath".into(), Json::from(file.to_string_lossy().to_string()));
        store.insert_source(SourceInput { kind: "pdf".into(), fields, ..Default::default() }).unwrap().id
    }

    #[test]
    fn stamps_follow_annotations() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let id = source(&store, "A", &dir.path().join("a.pdf"));
        assert!(store.annotation_stamps().unwrap().is_empty());
        store.apply_annotations(&id, &[json!({ "id": "h1", "text": "x" })], &[]).unwrap();
        let first = store.annotation_stamps().unwrap()[&id].clone();
        store.apply_annotations(&id, &[json!({ "id": "h2", "text": "y" })], &[]).unwrap();
        assert_ne!(store.annotation_stamps().unwrap()[&id], first);
    }

    #[test]
    fn renaming_files_is_undone_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("db")).unwrap();
        let from = dir.path().join("scan0001.pdf");
        std::fs::write(&from, b"%PDF").unwrap();
        let id = source(&store, "A", &from);
        let to = dir.path().join("Smith - 2020 - A.pdf");
        let op = store.rename_source_files(&[(id.clone(), from.to_string_lossy().into(), to.to_string_lossy().into())], "Rename 1 file").unwrap();
        assert!(op.entry.is_some());
        assert!(to.exists() && !from.exists());
        assert_eq!(store.source(&id).unwrap().unwrap().field("filePath"), Some(to.to_string_lossy().as_ref()));
        store.undo().unwrap();
        assert!(from.exists() && !to.exists());
        assert_eq!(store.source(&id).unwrap().unwrap().field("filePath"), Some(from.to_string_lossy().as_ref()));
        store.redo().unwrap();
        assert!(to.exists() && !from.exists());
        // A taken name is refused and nothing moves.
        std::fs::write(&from, b"other").unwrap();
        assert!(store.rename_source_files(&[(id.clone(), to.to_string_lossy().into(), from.to_string_lossy().into())], "Rename").is_err());
        assert!(to.exists());
    }
}
