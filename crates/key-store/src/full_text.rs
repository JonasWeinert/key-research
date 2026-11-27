// A source's full text can be a PDF, a saved web page (a snapshot), or both. The source's own
// file (`file_path`) is its primary full text, the one that is read, indexed and shown; another
// one it keeps (a page saved before its PDF was found, or the other way round) is listed here and
// can be made primary, which swaps the two.
//
// Also kept here, for Find PDF on a publisher's page: the page's HTML waiting for its PDF to be
// analysed (`source_html_hints`), so the indexer can fold the page's structure into the PDF's
// layout (key-index html_align.rs), what that alignment found (`source_structure_alignment`), and
// a PDF's stored structure carried over from the browser's scratch library with its analysis.
use crate::{Result, Store, e, now_ms};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS source_full_texts (
  source_id TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT,
  kind TEXT NOT NULL,
  size INTEGER,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, file_hash)
);
CREATE TABLE IF NOT EXISTS source_html_hints (
  source_id TEXT PRIMARY KEY,
  html TEXT NOT NULL,
  url TEXT,
  stored_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS source_structure_alignment (
  source_id TEXT PRIMARY KEY,
  file_hash TEXT NOT NULL,
  url TEXT,
  accepted INTEGER NOT NULL,
  confidence REAL NOT NULL,
  report TEXT NOT NULL,
  aligned_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS carried_structure (
  hash TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  layout TEXT NOT NULL,
  carried_at INTEGER NOT NULL
);
";

/// A page waiting for its PDF is dropped after this long (the PDF was never analysed).
const HINT_TTL_MS: i64 = 14 * 24 * 60 * 60 * 1000;

pub(crate) fn ensure_schema(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA).map_err(e)
}

/// "pdf" or "web" by the file's type (else "file").
pub fn full_text_kind(mime: Option<&str>, path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    match mime.unwrap_or("") {
        "application/pdf" => "pdf",
        "text/html" | "application/xhtml+xml" => "web",
        _ if lower.ends_with(".pdf") => "pdf",
        _ if lower.ends_with(".html") || lower.ends_with(".htm") => "web",
        _ => "file",
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullText {
    pub hash: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    /// pdf | web | file
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    pub primary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_at: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct StoredAlignment {
    pub file_hash: String,
    pub url: Option<String>,
    pub accepted: bool,
    pub confidence: f64,
    pub report: String,
    pub aligned_at: i64,
}

impl Store {
    /// The source's full texts: its own file first (primary), then the others it keeps.
    pub fn full_texts(&self, source_id: &str) -> Result<Vec<FullText>> {
        let mut out = Vec::new();
        if let Some(source) = self.source(source_id)? {
            if let (Some(path), Some(hash)) = (source.file_path(), source.file_hash()) {
                let mime = source.fields.get("mime").and_then(|v| v.as_str()).map(String::from);
                let path = path.to_string_lossy().to_string();
                out.push(FullText {
                    kind: full_text_kind(mime.as_deref(), &path).into(),
                    hash: hash.to_string(),
                    size: source.fields.get("fileSize").and_then(|v| v.as_i64()),
                    path,
                    mime,
                    primary: true,
                    added_at: None,
                });
            }
        }
        let db = self.read()?;
        let mut statement = db.prepare("SELECT file_hash, path, mime, kind, size, added_at FROM source_full_texts WHERE source_id = ? ORDER BY added_at").map_err(e)?;
        let rows = statement
            .query_map([source_id], |r| {
                Ok(FullText { hash: r.get(0)?, path: r.get(1)?, mime: r.get(2)?, kind: r.get(3)?, size: r.get(4)?, primary: false, added_at: Some(r.get(5)?) })
            })
            .map_err(e)?;
        for row in rows {
            let row = row.map_err(e)?;
            if !out.iter().any(|f| f.hash == row.hash) {
                out.push(row);
            }
        }
        Ok(out)
    }

    /// The sources that keep a file as one of their other full texts (not their primary one).
    pub fn sources_keeping(&self, hash: &str) -> Result<Vec<String>> {
        let db = self.read()?;
        let mut statement = db.prepare("SELECT source_id FROM source_full_texts WHERE file_hash = ?").map_err(e)?;
        let rows = statement.query_map([hash], |r| r.get::<_, String>(0)).map_err(e)?;
        rows.collect::<std::result::Result<_, _>>().map_err(e)
    }

    /// Keeps a file as one of the source's other full texts (not its primary one).
    pub fn add_other_full_text(&self, source_id: &str, hash: &str, path: &str, mime: Option<&str>, size: Option<i64>) -> Result<()> {
        self.db()?
            .execute(
                "INSERT INTO source_full_texts(source_id, file_hash, path, mime, kind, size, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(source_id, file_hash) DO UPDATE SET path = ?3, mime = ?4, kind = ?5, size = ?6",
                params![source_id, hash, path, mime, full_text_kind(mime, path), size, now_ms()],
            )
            .map(|_| ())
            .map_err(e)
    }

    pub fn remove_other_full_text(&self, source_id: &str, hash: &str) -> Result<bool> {
        self.db()?.execute("DELETE FROM source_full_texts WHERE source_id = ?1 AND file_hash = ?2", params![source_id, hash]).map(|n| n > 0).map_err(e)
    }

    /// Kinds of full text each source has, primary or not: id → kinds ("pdf", "web").
    pub fn other_full_text_kinds(&self, ids: &[String]) -> Result<std::collections::HashMap<String, Vec<String>>> {
        let mut out: std::collections::HashMap<String, Vec<String>> = Default::default();
        if ids.is_empty() {
            return Ok(out);
        }
        let db = self.read()?;
        let marks = vec!["?"; ids.len()].join(",");
        let mut statement = db.prepare(&format!("SELECT source_id, kind FROM source_full_texts WHERE source_id IN ({marks})")).map_err(e)?;
        let rows = statement.query_map(rusqlite::params_from_iter(ids.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
        for row in rows {
            let (id, kind) = row.map_err(e)?;
            let kinds = out.entry(id).or_default();
            if !kinds.contains(&kind) {
                kinds.push(kind);
            }
        }
        Ok(out)
    }

    // ── The publisher's page, for the PDF's structure ──

    pub fn set_html_hint(&self, source_id: &str, html: &str, url: Option<&str>) -> Result<()> {
        let db = self.db()?;
        db.execute("DELETE FROM source_html_hints WHERE stored_at < ?", [now_ms() - HINT_TTL_MS]).map_err(e)?;
        db.execute(
            "INSERT INTO source_html_hints(source_id, html, url, stored_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(source_id) DO UPDATE SET html = ?2, url = ?3, stored_at = ?4",
            params![source_id, html, url, now_ms()],
        )
        .map(|_| ())
        .map_err(e)
    }

    /// The page waiting for this source's PDF, if any (left in place; `clear_html_hint` drops it).
    pub fn html_hint(&self, source_id: &str) -> Result<Option<(String, Option<String>)>> {
        self.read()?
            .query_row("SELECT html, url FROM source_html_hints WHERE source_id = ? AND stored_at >= ?", params![source_id, now_ms() - HINT_TTL_MS], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(e)
    }

    pub fn clear_html_hint(&self, source_id: &str) -> Result<()> {
        self.db()?.execute("DELETE FROM source_html_hints WHERE source_id = ?", [source_id]).map(|_| ()).map_err(e)
    }

    pub fn set_structure_alignment(&self, source_id: &str, file_hash: &str, url: Option<&str>, accepted: bool, confidence: f64, report: &str) -> Result<()> {
        self.db()?
            .execute(
                "INSERT INTO source_structure_alignment(source_id, file_hash, url, accepted, confidence, report, aligned_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(source_id) DO UPDATE SET file_hash = ?2, url = ?3, accepted = ?4, confidence = ?5, report = ?6, aligned_at = ?7",
                params![source_id, file_hash, url, accepted, confidence, report, now_ms()],
            )
            .map(|_| ())
            .map_err(e)
    }

    pub fn structure_alignment(&self, source_id: &str) -> Result<Option<StoredAlignment>> {
        self.read()?
            .query_row("SELECT file_hash, url, accepted, confidence, report, aligned_at FROM source_structure_alignment WHERE source_id = ?", [source_id], |r| {
                Ok(StoredAlignment { file_hash: r.get(0)?, url: r.get(1)?, accepted: r.get(2)?, confidence: r.get(3)?, report: r.get(4)?, aligned_at: r.get(5)? })
            })
            .optional()
            .map_err(e)
    }

    // ── A PDF's structure carried over with its analysis (analysis.rs `carry_analysis`) ──

    pub(crate) fn carry_structure(&self, hash: &str, donor: &Connection, donor_source: &str) -> Result<()> {
        let found: Option<(String, String)> = donor
            .query_row("SELECT engine, layout FROM source_structure WHERE source_id = ?1 AND file_hash = ?2", params![donor_source, hash], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .unwrap_or(None);
        if let Some((engine, layout)) = found {
            self.db()?
                .execute("INSERT OR REPLACE INTO carried_structure(hash, engine, layout, carried_at) VALUES (?1, ?2, ?3, ?4)", params![hash, engine, layout, now_ms()])
                .map_err(e)?;
        }
        Ok(())
    }

    /// The structure carried over for this content hash, once (it is removed): (engine, layout).
    pub fn take_carried_structure(&self, hash: &str) -> Result<Option<(String, String)>> {
        let db = self.db()?;
        let found = db.query_row("SELECT engine, layout FROM carried_structure WHERE hash = ?", [hash], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(e)?;
        if found.is_some() {
            db.execute("DELETE FROM carried_structure WHERE hash = ?", [hash]).map_err(e)?;
        }
        Ok(found)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, json};

    #[test]
    fn keeps_other_full_texts_beside_the_primary_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::Store::open(dir.path()).unwrap();
        let source = store.insert_source(serde_json::from_value(json!({ "kind": "reference", "title": "Rivers" })).unwrap()).unwrap();
        assert!(store.full_texts(&source.id).unwrap().is_empty());
        let mut patch = Map::new();
        patch.insert("filePath".into(), json!("/w/files/a.pdf"));
        patch.insert("fileHash".into(), json!("pdfhash"));
        patch.insert("mime".into(), json!("application/pdf"));
        store.update_source(&source.id, &patch).unwrap();
        store.add_other_full_text(&source.id, "webhash", "/w/files/b.html", Some("text/html"), Some(10)).unwrap();
        let all = store.full_texts(&source.id).unwrap();
        assert_eq!(all.iter().map(|f| (f.kind.as_str(), f.primary)).collect::<Vec<_>>(), [("pdf", true), ("web", false)]);
        assert_eq!(store.other_full_text_kinds(&[source.id.clone()]).unwrap()[&source.id], ["web"]);
        assert!(store.remove_other_full_text(&source.id, "webhash").unwrap());
        assert_eq!(store.full_texts(&source.id).unwrap().len(), 1);
    }

    #[test]
    fn keeps_a_page_for_its_pdf_and_what_aligning_it_found() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::Store::open(dir.path()).unwrap();
        store.set_html_hint("s1", "<html></html>", Some("https://x.example/a")).unwrap();
        assert_eq!(store.html_hint("s1").unwrap().unwrap().1.as_deref(), Some("https://x.example/a"));
        store.clear_html_hint("s1").unwrap();
        assert!(store.html_hint("s1").unwrap().is_none());
        store.set_structure_alignment("s1", "h", None, true, 0.8, "{}").unwrap();
        let found = store.structure_alignment("s1").unwrap().unwrap();
        assert!(found.accepted && (found.confidence - 0.8).abs() < 1e-9);
    }
}
