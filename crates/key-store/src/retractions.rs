// Retraction and correction notices. The host rechecks DOIs now and then, at low priority
// (OpenAlex's `is_retracted`, and Crossref's `updates:` filter, which carries the
// Retraction Watch database and publishers' own notices); this module stores the answers:
// the kind of notice, its DOI and date, when the work was checked and when it was first
// flagged. The user can dismiss a flag per source ("not a concern").
use crate::{Result, Store, e, now_ms};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

const SEEN_KEY: &str = "retractions.seen";

/// A notice about a work, as Crossref lists it in `update-to`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    /// retraction | withdrawal | expression_of_concern | correction | erratum | …
    pub kind: String,
    /// The notice's own DOI.
    pub doi: Option<String>,
    pub date: Option<String>,
    /// retraction-watch | publisher
    pub source: Option<String>,
}

/// How serious a kind of notice is: the most serious one is kept.
fn severity(kind: &str) -> u8 {
    match kind {
        "retraction" | "removal" => 4,
        "withdrawal" => 3,
        "expression_of_concern" | "expression-of-concern" => 2,
        "correction" | "erratum" | "corrigendum" | "partial_retraction" | "partial-retraction" => 1,
        _ => 0,
    }
}

/// The most serious notice among Crossref works that update `doi` (each work's `update-to`).
pub fn notice_for(doi: &str, items: &[Json]) -> Option<Notice> {
    let doi = doi.trim().to_ascii_lowercase();
    let mut best: Option<Notice> = None;
    for item in items {
        for update in item.get("update-to").and_then(Json::as_array).into_iter().flatten() {
            let target = update.get("DOI").and_then(Json::as_str).map(str::to_ascii_lowercase);
            if target.as_deref() != Some(doi.as_str()) {
                continue;
            }
            let kind = update.get("type").and_then(Json::as_str).unwrap_or("").replace('-', "_");
            if severity(&kind) == 0 {
                continue;
            }
            let date = update.get("updated").and_then(|u| u.get("date-time")).and_then(Json::as_str).map(|d| d.chars().take(10).collect());
            let notice = Notice { kind, doi: item.get("DOI").and_then(Json::as_str).map(str::to_ascii_lowercase), date, source: update.get("source").and_then(Json::as_str).map(String::from) };
            if best.as_ref().is_none_or(|b| severity(&notice.kind) > severity(&b.kind)) {
                best = Some(notice);
            }
        }
    }
    best
}

impl Store {
    /// Sources with a DOI whose check is older than `older_than` (ms), never checked first.
    pub fn retraction_due(&self, older_than: i64, limit: usize) -> Result<Vec<(String, String)>> {
        let db = self.read()?;
        let mut statement = db
            .prepare(
                "SELECT id, lower(doi) FROM sources WHERE trashed_at IS NULL AND coalesce(trim(doi), '') <> '' AND coalesce(retraction_checked_at, 0) < ?1
                 ORDER BY retraction_checked_at IS NOT NULL, retraction_checked_at, added_at DESC LIMIT ?2",
            )
            .map_err(e)?;
        let rows = statement.query_map(params![now_ms() - older_than, limit as i64], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
        rows.collect::<std::result::Result<_, _>>().map_err(e)
    }

    /// Stores one check. `retracted` is OpenAlex's flag (None: not known there); `notice` is
    /// the most serious Crossref notice (None: none). Answers whether the source became flagged.
    pub fn apply_retraction_check(&self, id: &str, retracted: Option<bool>, notice: Option<&Notice>) -> Result<bool> {
        let db = self.db()?;
        let before: Option<(Option<i64>, Option<String>)> =
            db.query_row("SELECT retracted, retraction_kind FROM sources WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(e)?;
        let Some((was_retracted, was_kind)) = before else { return Ok(false) };
        let by_notice = notice.is_some_and(|n| severity(&n.kind) >= 3);
        let retracted = match (retracted, by_notice) {
            (_, true) => Some(1),
            (Some(r), false) => Some(i64::from(r)),
            (None, false) => was_retracted,
        };
        let serious = |r: Option<i64>, kind: Option<&str>| r == Some(1) || kind.is_some_and(|k| severity(k) >= 2);
        let flagged = serious(retracted, notice.map(|n| n.kind.as_str())) && !serious(was_retracted, was_kind.as_deref());
        let now = now_ms();
        db.execute(
            "UPDATE sources SET retracted = ?2, retraction_kind = ?3, retraction_notice = ?4, retraction_date = ?5, retraction_checked_at = ?6,
               retraction_flagged_at = CASE WHEN ?7 THEN ?6 ELSE retraction_flagged_at END,
               retraction_dismissed = CASE WHEN ?7 THEN 0 ELSE retraction_dismissed END
             WHERE id = ?1",
            params![id, retracted, notice.map(|n| n.kind.clone()), notice.and_then(|n| n.doi.clone()), notice.and_then(|n| n.date.clone()), now, flagged],
        )
        .map_err(e)?;
        Ok(flagged)
    }

    /// "Not a concern" (or flag again) for these sources.
    pub fn dismiss_retraction(&self, ids: &[String], dismissed: bool) -> Result<usize> {
        let db = self.db()?;
        let mut changed = 0;
        for id in ids {
            changed += db.execute("UPDATE sources SET retraction_dismissed = ?2 WHERE id = ?1", params![id, dismissed]).map_err(e)?;
        }
        Ok(changed)
    }

    /// Flagged sources, and how many were flagged since the user last looked (`seen`).
    pub fn retraction_summary(&self) -> Result<Json> {
        let db = self.read()?;
        let seen: i64 = db.query_row("SELECT value FROM meta WHERE key = ?", [SEEN_KEY], |r| r.get::<_, String>(0)).optional().map_err(e)?.and_then(|v| v.parse().ok()).unwrap_or(0);
        let mut statement = db
            .prepare(
                "SELECT id, title, retraction_kind, retraction_notice, retraction_flagged_at, retracted FROM sources
                 WHERE trashed_at IS NULL AND retraction_dismissed = 0 AND (retracted = 1 OR retraction_kind IN ('expression_of_concern', 'withdrawal', 'retraction'))
                 ORDER BY retraction_flagged_at DESC LIMIT 200",
            )
            .map_err(e)?;
        let items: Vec<Json> = statement
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "kind": r.get::<_, Option<String>>(2)?.or_else(|| Some("retraction".into())),
                    "notice": r.get::<_, Option<String>>(3)?, "flaggedAt": r.get::<_, Option<i64>>(4)?, "retracted": r.get::<_, Option<i64>>(5)? == Some(1),
                }))
            })
            .map_err(e)?
            .collect::<std::result::Result<_, _>>()
            .map_err(e)?;
        let unseen = items.iter().filter(|i| i["flaggedAt"].as_i64().is_some_and(|at| at > seen)).count();
        let checked: i64 = db.query_row("SELECT count(*) FROM sources WHERE trashed_at IS NULL AND retraction_checked_at IS NOT NULL", [], |r| r.get(0)).map_err(e)?;
        Ok(json!({ "flagged": items.len(), "unseen": unseen, "checked": checked, "items": items }))
    }

    pub fn mark_retractions_seen(&self) -> Result<()> {
        self.set_meta(SEEN_KEY, &now_ms().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SourceInput;
    use serde_json::Map;

    #[test]
    fn reads_crossref_notices_and_flags_once() {
        let items = vec![
            json!({"DOI": "10.1016/s0140-6736(04)15715-2", "update-to": [{"DOI": "10.1016/s0140-6736(97)11096-0", "type": "correction", "source": "retraction-watch", "updated": {"date-time": "2004-03-06T00:00:00Z"}}]}),
            json!({"DOI": "10.1016/S0140-6736(10)60175-4", "update-to": [{"DOI": "10.1016/S0140-6736(97)11096-0", "type": "retraction", "source": "retraction-watch", "updated": {"date-time": "2010-02-06T00:00:00Z"}}]}),
        ];
        let notice = notice_for("10.1016/S0140-6736(97)11096-0", &items).unwrap();
        assert_eq!(notice.kind, "retraction");
        assert_eq!(notice.doi.as_deref(), Some("10.1016/s0140-6736(10)60175-4"));
        assert_eq!(notice.date.as_deref(), Some("2010-02-06"));
        assert!(notice_for("10.1/other", &items).is_none());

        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let mut fields = Map::new();
        fields.insert("title".into(), json!("Ileal-lymphoid-nodular hyperplasia"));
        fields.insert("doi".into(), json!("10.1016/S0140-6736(97)11096-0"));
        let id = store.insert_source(SourceInput { kind: "reference".into(), fields, ..Default::default() }).unwrap().id;
        assert_eq!(store.retraction_due(0, 10).unwrap().len(), 1);
        assert!(store.apply_retraction_check(&id, Some(true), Some(&notice)).unwrap());
        assert!(!store.apply_retraction_check(&id, Some(true), Some(&notice)).unwrap(), "flagged only once");
        assert!(store.retraction_due(60_000, 10).unwrap().is_empty());
        let summary = store.retraction_summary().unwrap();
        assert_eq!(summary["flagged"], 1);
        assert_eq!(summary["unseen"], 1);
        let listed = store.list_sources(&crate::ListQuery { scope: Some("retracted".into()), ..Default::default() }).unwrap();
        assert_eq!(listed.total, 1);
        assert_eq!(listed.counts.retracted, 1);
        assert_eq!(listed.items[0].field("retractionNotice"), Some("10.1016/s0140-6736(10)60175-4"));
        std::thread::sleep(std::time::Duration::from_millis(2));
        store.mark_retractions_seen().unwrap();
        assert_eq!(store.retraction_summary().unwrap()["unseen"], 0);
        store.dismiss_retraction(std::slice::from_ref(&id), true).unwrap();
        assert_eq!(store.retraction_summary().unwrap()["flagged"], 0);
        assert_eq!(store.list_sources(&crate::ListQuery { scope: Some("retracted".into()), ..Default::default() }).unwrap().total, 0);
        // A correction alone is shown on the source, not flagged.
        let correction = Notice { kind: "correction".into(), ..Default::default() };
        let mut fields = Map::new();
        fields.insert("doi".into(), json!("10.1/c"));
        let other = store.insert_source(SourceInput { kind: "reference".into(), fields, ..Default::default() }).unwrap().id;
        assert!(!store.apply_retraction_check(&other, Some(false), Some(&correction)).unwrap());
        assert_eq!(store.source(&other).unwrap().unwrap().field("retractionKind"), Some("correction"));
    }
}
