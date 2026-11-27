// What document analysis found in a source: how its text was extracted, its Markdown,
// and its bibliography with where each entry is printed and what it resolved to.
use crate::{Result, Store, e, now_ms};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// How a source was analysed and how far its references have got.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAnalysis {
    pub source_id: String,
    /// layout-onnx | layout | pdfium | text
    pub engine: String,
    pub analyzed_at: i64,
    /// pending | detecting | resolving | done | none | failed
    pub references_status: String,
    pub references_error: Option<String>,
    pub references_total: i64,
    pub references_done: i64,
    /// How many references point at a source in this library.
    pub references_matched: i64,
    pub has_markdown: bool,
    /// The analyser version that found the in-text citations; None until they're found.
    pub citations_version: Option<i64>,
    /// Whether the analyser judged the document a scientific paper, and what it counted.
    pub scientific: Option<bool>,
    pub signals: Option<Json>,
}

/// A reference detected in a source's bibliography.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceInput {
    pub number: Option<i64>,
    pub page: Option<i64>,
    pub rects: Vec<[u16; 4]>,
    pub text: String,
    pub metadata: Option<Json>,
}

/// An in-text citation: where it is printed and which reference numbers it names.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationInput {
    pub page: i64,
    pub start: i64,
    pub end: i64,
    /// [x, y, width, height] on a 0..65535 page scale.
    pub rect: [u16; 4],
    pub text: String,
    pub numbers: Vec<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCitation {
    pub seq: i64,
    pub page: i64,
    pub start: i64,
    pub end: i64,
    pub rect: [u16; 4],
    pub text: String,
    pub numbers: Vec<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReference {
    pub seq: i64,
    pub number: Option<i64>,
    pub page: Option<i64>,
    pub rects: Vec<[u16; 4]>,
    pub text: String,
    pub metadata: Option<Json>,
    pub error: Option<String>,
    pub matched_source_id: Option<String>,
}

/// A heading found by layout analysis (see `Store::sections`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedSection {
    pub title: String,
    pub page: i64,
    pub top: f64,
}

/// A finished analysis taken from another library for a file with the same content.
#[derive(Clone, Debug, Default)]
pub struct CarriedAnalysis {
    pub engine: String,
    pub markdown: Option<String>,
    pub page_count: Option<i64>,
    /// The document's passages (without the abstract, which follows the source's metadata).
    pub chunks: Vec<crate::ChunkInput>,
}

#[derive(Serialize, Deserialize)]
struct CarriedChunk {
    page: Option<i64>,
    start_seconds: Option<f64>,
    text: String,
    rects: Vec<[u16; 4]>,
    kind: Option<String>,
    section: Option<String>,
}

impl Store {
    /// Keeps the analysis another library (`from`, its database folder) finished for the PDF
    /// with this content `hash`, for this library's indexer to use instead of analysing the
    /// file again (`take_carried_analysis`). False when that library has none ready.
    pub fn carry_analysis(&self, hash: &str, from: &std::path::Path) -> Result<bool> {
        let path = from.join("key.db");
        if !path.is_file() || from == self.root() {
            return Ok(false);
        }
        let donor = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(e)?;
        donor.busy_timeout(std::time::Duration::from_secs(2)).map_err(e)?;
        let found: Option<(String, Option<i64>, Option<String>, String, Option<String>)> = donor
            .query_row(
                "SELECT s.id, s.page_count, s.abstract, a.engine, a.markdown FROM sources s JOIN source_analysis a ON a.source_id = s.id
                 WHERE s.file_hash = ?1 AND s.trashed_at IS NULL AND s.index_status IN ('ready', 'no_text') ORDER BY a.analyzed_at DESC LIMIT 1",
                [hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(e)?;
        let Some((id, page_count, abstract_text, engine, markdown)) = found else { return Ok(false) };
        let abstract_text = abstract_text.map(|a| a.trim().to_string()).filter(|a| !a.is_empty());
        let mut statement = donor.prepare("SELECT seq, page, start_seconds, text, rects, kind, section FROM chunks WHERE source_id = ? ORDER BY seq").map_err(e)?;
        let rows = statement
            .query_map([&id], |r| {
                Ok((r.get::<_, i64>(0)?, CarriedChunk {
                    page: r.get(1)?,
                    start_seconds: r.get(2)?,
                    text: r.get(3)?,
                    rects: r.get::<_, Option<String>>(4)?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default(),
                    kind: r.get(5)?,
                    section: r.get(6)?,
                }))
            })
            .map_err(e)?;
        let mut chunks = Vec::new();
        for row in rows {
            let (seq, chunk) = row.map_err(e)?;
            // The indexer puts the abstract first; it is added again from this library's record.
            if seq == 0 && chunk.page.is_none() && abstract_text.as_deref() == Some(chunk.text.trim()) {
                continue;
            }
            chunks.push(chunk);
        }
        self.db()?
            .execute(
                "INSERT OR REPLACE INTO carried_analysis(hash, engine, markdown, page_count, chunks, carried_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![hash, engine, markdown, page_count, serde_json::to_string(&chunks).map_err(e)?, now_ms()],
            )
            .map_err(e)?;
        Ok(true)
    }

    /// The analysis carried over for this content hash, once (it is removed).
    pub fn take_carried_analysis(&self, hash: &str) -> Result<Option<CarriedAnalysis>> {
        let db = self.db()?;
        let found: Option<(String, Option<String>, Option<i64>, String)> = db
            .query_row("SELECT engine, markdown, page_count, chunks FROM carried_analysis WHERE hash = ?", [hash], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .optional()
            .map_err(e)?;
        let Some((engine, markdown, page_count, chunks)) = found else { return Ok(None) };
        db.execute("DELETE FROM carried_analysis WHERE hash = ?", [hash]).map_err(e)?;
        let chunks: Vec<CarriedChunk> = serde_json::from_str(&chunks).unwrap_or_default();
        Ok(Some(CarriedAnalysis {
            engine,
            markdown,
            page_count,
            chunks: chunks
                .into_iter()
                .map(|c| crate::ChunkInput { page: c.page, start_seconds: c.start_seconds, text: c.text, rects: c.rects, kind: c.kind, section: c.section, embedding: None })
                .collect(),
        }))
    }

    /// Records how a source's text was extracted. With `references`, its bibliography is
    /// detected and looked up (again) next; otherwise there is none to find.
    pub fn set_analysis(&self, source_id: &str, engine: &str, markdown: Option<&str>, references: bool) -> Result<()> {
        let status = if references { "pending" } else { "none" };
        self.db()?
            .execute(
                "INSERT INTO source_analysis(source_id, engine, markdown, analyzed_at, references_status) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(source_id) DO UPDATE SET engine = ?2, markdown = ?3, analyzed_at = ?4,
                   references_status = ?5, references_error = NULL, references_done = 0, references_total = 0,
                   citations_version = NULL",
                params![source_id, engine, markdown, now_ms(), status],
            )
            .map(|_| ())
            .map_err(e)
    }

    pub fn analysis(&self, source_id: &str) -> Result<Option<SourceAnalysis>> {
        self.read()?
            .query_row(
                "SELECT a.source_id, a.engine, a.analyzed_at, a.references_status, a.references_error, a.references_total, a.references_done,
                   (SELECT count(*) FROM source_references r WHERE r.source_id = a.source_id AND r.matched_source_id IS NOT NULL),
                   a.markdown IS NOT NULL, a.citations_version, a.scientific, a.signals
                 FROM source_analysis a WHERE a.source_id = ?",
                [source_id],
                |r| {
                    Ok(SourceAnalysis {
                        source_id: r.get(0)?,
                        engine: r.get(1)?,
                        analyzed_at: r.get(2)?,
                        references_status: r.get(3)?,
                        references_error: r.get(4)?,
                        references_total: r.get(5)?,
                        references_done: r.get(6)?,
                        references_matched: r.get(7)?,
                        has_markdown: r.get(8)?,
                        citations_version: r.get(9)?,
                        scientific: r.get(10)?,
                        signals: r.get::<_, Option<String>>(11)?.and_then(|s| serde_json::from_str(&s).ok()),
                    })
                },
            )
            .optional()
            .map_err(e)
    }

    /// The source's text as Markdown, when layout analysis produced it.
    pub fn markdown(&self, source_id: &str) -> Result<Option<String>> {
        Ok(self
            .read()?
            .query_row("SELECT markdown FROM source_analysis WHERE source_id = ?", [source_id], |r| r.get::<_, Option<String>>(0))
            .optional()
            .map_err(e)?
            .flatten())
    }

    /// The next PDF whose references wait for detection, preferring `first` when it waits.
    /// After those, PDFs whose in-text citations were never found (or were found by an
    /// analyser older than `citations_version`) get them found.
    pub fn next_reference_job(&self, first: &[String], citations_version: i64) -> Result<Option<String>> {
        const WAITING: &str = "(a.references_status IN ('pending','detecting','resolving')
            OR (a.references_status IN ('done','none') AND coalesce(a.citations_version, 0) < :version))";
        let db = self.read()?;
        for id in first {
            let waiting: Option<i64> = db
                .query_row(
                    &format!("SELECT 1 FROM source_analysis a WHERE a.source_id = :id AND {WAITING}"),
                    rusqlite::named_params! { ":id": id, ":version": citations_version },
                    |r| r.get(0),
                )
                .optional()
                .map_err(e)?;
            if waiting.is_some() {
                return Ok(Some(id.clone()));
            }
        }
        db.query_row(
            &format!(
                "SELECT a.source_id FROM source_analysis a JOIN sources s ON s.id = a.source_id
                 WHERE {WAITING} AND s.trashed_at IS NULL AND s.kind = 'pdf'
                 ORDER BY a.references_status IN ('done','none'), a.references_status <> 'pending' DESC, s.added_at DESC LIMIT 1"
            ),
            rusqlite::named_params! { ":version": citations_version },
            |r| r.get(0),
        )
        .optional()
        .map_err(e)
    }

    /// Replaces a source's in-text citations and records the analyser that found them.
    pub fn replace_citations(&self, source_id: &str, version: i64, scientific: bool, signals: Option<&Json>, citations: &[CitationInput]) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        tx.execute("DELETE FROM source_citations WHERE source_id = ?", [source_id]).map_err(e)?;
        {
            let mut insert = tx
                .prepare("INSERT INTO source_citations(source_id, seq, page, start, end, rect, text, numbers) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
                .map_err(e)?;
            for (seq, citation) in citations.iter().enumerate() {
                let rect = serde_json::to_string(&citation.rect).unwrap_or_default();
                let numbers = serde_json::to_string(&citation.numbers).unwrap_or_default();
                insert
                    .execute(params![source_id, seq as i64, citation.page, citation.start, citation.end, rect, citation.text, numbers])
                    .map_err(e)?;
            }
        }
        tx.execute(
            "UPDATE source_analysis SET citations_version = ?2, scientific = ?3, signals = ?4 WHERE source_id = ?1",
            params![source_id, version, scientific, signals.map(|s| s.to_string())],
        )
        .map_err(e)?;
        tx.commit().map_err(e)
    }

    pub fn citations(&self, source_id: &str) -> Result<Vec<SourceCitation>> {
        let db = self.read()?;
        let mut statement = db
            .prepare("SELECT seq, page, start, end, rect, text, numbers FROM source_citations WHERE source_id = ? ORDER BY seq")
            .map_err(e)?;
        statement
            .query_map([source_id], |r| {
                Ok(SourceCitation {
                    seq: r.get(0)?,
                    page: r.get(1)?,
                    start: r.get(2)?,
                    end: r.get(3)?,
                    rect: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                    text: r.get(5)?,
                    numbers: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
                })
            })
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)
    }

    pub fn set_references_status(&self, source_id: &str, status: &str, error: Option<&str>, done: i64, total: i64) -> Result<()> {
        self.db()?
            .execute(
                "UPDATE source_analysis SET references_status = ?2, references_error = ?3, references_done = ?4, references_total = ?5 WHERE source_id = ?1",
                params![source_id, status, error, done, total],
            )
            .map(|_| ())
            .map_err(e)
    }

    /// Replaces a source's detected references (their lookups start over).
    pub fn replace_references(&self, source_id: &str, references: &[ReferenceInput]) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        tx.execute("DELETE FROM source_references WHERE source_id = ?", [source_id]).map_err(e)?;
        {
            let mut insert = tx
                .prepare("INSERT INTO source_references(source_id, seq, number, page, rects, text, metadata) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
                .map_err(e)?;
            for (seq, reference) in references.iter().enumerate() {
                let rects = (!reference.rects.is_empty()).then(|| serde_json::to_string(&reference.rects).unwrap_or_default());
                let metadata = reference.metadata.as_ref().map(|m| m.to_string());
                insert
                    .execute(params![source_id, seq as i64, reference.number, reference.page, rects, reference.text, metadata])
                    .map_err(e)?;
            }
        }
        tx.commit().map_err(e)
    }

    /// Stores what one reference resolved to, linking it to a library source with the
    /// same DOI (or, failing that, the same title) when there is one.
    pub fn resolve_reference(&self, source_id: &str, seq: i64, metadata: Option<&Json>, error: Option<&str>) -> Result<Option<String>> {
        // Without a lookup result, what the document itself said (a web page's DOI) still links it.
        let stored = match metadata {
            Some(_) => None,
            None => self
                .read()?
                .query_row("SELECT metadata FROM source_references WHERE source_id = ?1 AND seq = ?2", params![source_id, seq], |r| r.get::<_, Option<String>>(0))
                .optional()
                .map_err(e)?
                .flatten()
                .and_then(|m| serde_json::from_str::<Json>(&m).ok()),
        };
        let matched = match metadata.or(stored.as_ref()) {
            Some(metadata) => self.match_work(source_id, metadata)?,
            None => None,
        };
        self.db()?
            .execute(
                "UPDATE source_references SET metadata = coalesce(?3, metadata), error = ?4, matched_source_id = ?5 WHERE source_id = ?1 AND seq = ?2",
                params![source_id, seq, metadata.map(|m| m.to_string()), error, matched],
            )
            .map_err(e)?;
        Ok(matched)
    }

    fn match_work(&self, citing: &str, metadata: &Json) -> Result<Option<String>> {
        let db = self.read()?;
        let doi = metadata.get("doi").and_then(Json::as_str).map(|d| d.trim().to_ascii_lowercase()).filter(|d| !d.is_empty());
        if let Some(doi) = doi {
            let found: Option<String> = db
                .query_row(
                    "SELECT id FROM sources WHERE lower(doi) = ? AND id <> ? AND trashed_at IS NULL LIMIT 1",
                    params![doi, citing],
                    |r| r.get(0),
                )
                .optional()
                .map_err(e)?;
            if found.is_some() {
                return Ok(found);
            }
        }
        let title = metadata.get("title").and_then(Json::as_str).map(str::trim).filter(|t| t.chars().count() >= 12);
        match title {
            Some(title) => db
                .query_row(
                    "SELECT id FROM sources WHERE title = ? COLLATE NOCASE AND id <> ? AND trashed_at IS NULL LIMIT 1",
                    params![title, citing],
                    |r| r.get(0),
                )
                .optional()
                .map_err(e),
            None => Ok(None),
        }
    }

    /// The document's sections as layout analysis found them: each heading once, in reading
    /// order, with the page and height (0..1) where it starts. For PDFs without an outline.
    pub fn sections(&self, source_id: &str) -> Result<Vec<DetectedSection>> {
        let db = self.read()?;
        let mut statement = db
            .prepare(
                "SELECT section, page, rects FROM chunks c WHERE source_id = ?1 AND section IS NOT NULL AND trim(section) <> '' AND page IS NOT NULL
                   AND seq = (SELECT min(seq) FROM chunks d WHERE d.source_id = ?1 AND d.section = c.section)
                 ORDER BY seq",
            )
            .map_err(e)?;
        let rows = statement
            .query_map([source_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?)))
            .map_err(e)?;
        let mut out = Vec::new();
        for row in rows {
            let (title, page, rects) = row.map_err(e)?;
            let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
            if title.chars().count() > 120 {
                continue;
            }
            let top = rects
                .and_then(|r| serde_json::from_str::<Vec<[u16; 4]>>(&r).ok())
                .and_then(|r| r.first().map(|rect| f64::from(rect[1]) / 65535.0))
                .unwrap_or(0.0);
            out.push(DetectedSection { title, page, top });
        }
        Ok(out)
    }

    pub fn references(&self, source_id: &str) -> Result<Vec<SourceReference>> {
        let db = self.read()?;
        let mut statement = db
            .prepare("SELECT seq, number, page, rects, text, metadata, error, matched_source_id FROM source_references WHERE source_id = ? ORDER BY seq")
            .map_err(e)?;
        statement
            .query_map([source_id], |r| {
                Ok(SourceReference {
                    seq: r.get(0)?,
                    number: r.get(1)?,
                    page: r.get(2)?,
                    rects: r.get::<_, Option<String>>(3)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
                    text: r.get(4)?,
                    metadata: r.get::<_, Option<String>>(5)?.and_then(|s| serde_json::from_str(&s).ok()),
                    error: r.get(6)?,
                    matched_source_id: r.get(7)?,
                })
            })
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)
    }

    /// Analyses a source again from scratch: text extraction, then references.
    pub fn reanalyze(&self, source_id: &str) -> Result<()> {
        let db = self.db()?;
        db.execute("DELETE FROM source_analysis WHERE source_id = ?", [source_id]).map_err(e)?;
        db.execute("DELETE FROM source_references WHERE source_id = ?", [source_id]).map_err(e)?;
        db.execute("DELETE FROM source_citations WHERE source_id = ?", [source_id]).map_err(e)?;
        db.execute("UPDATE sources SET index_status = 'pending', index_error = NULL WHERE id = ?", [source_id])
            .map(|_| ())
            .map_err(e)
    }

    /// The source whose references are being detected or looked up right now, if any.
    pub fn references_activity(&self) -> Result<Option<Json>> {
        self.read()?
            .query_row(
                "SELECT a.source_id, s.title, a.references_status, a.references_done, a.references_total
                 FROM source_analysis a JOIN sources s ON s.id = a.source_id
                 WHERE a.references_status IN ('detecting','resolving') ORDER BY a.references_status DESC LIMIT 1",
                [],
                |r| {
                    Ok(serde_json::json!({
                        "id": r.get::<_, String>(0)?,
                        "title": r.get::<_, Option<String>>(1)?,
                        "stage": r.get::<_, String>(2)?,
                        "done": r.get::<_, i64>(3)?,
                        "total": r.get::<_, i64>(4)?,
                    }))
                },
            )
            .optional()
            .map_err(e)
    }

    /// Queues every PDF analysed with another engine (or not analysed yet) for analysis.
    pub fn reanalyze_outdated(&self, engine: &str) -> Result<usize> {
        let db = self.db()?;
        db.execute(
            "UPDATE sources SET index_status = 'pending', index_error = NULL
             WHERE kind = 'pdf' AND trashed_at IS NULL AND file_path IS NOT NULL AND index_status NOT IN ('pending','indexing')
               AND id NOT IN (SELECT source_id FROM source_analysis WHERE engine = ?)",
            [engine],
        )
        .map_err(e)
    }

    /// How many PDFs were analysed with another engine (or not yet).
    pub fn outdated_analyses(&self, engine: &str) -> Result<i64> {
        self.read()?
            .query_row(
                "SELECT count(*) FROM sources WHERE kind = 'pdf' AND trashed_at IS NULL AND file_path IS NOT NULL
                   AND id NOT IN (SELECT source_id FROM source_analysis WHERE engine = ?)",
                [engine],
                |r| r.get(0),
            )
            .map_err(e)
    }
}
