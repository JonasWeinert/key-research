// An overview of a selection of sources, for the library's "N sources selected" panel: what
// kinds and types they are, their years, the authors, journals, tags and collections they
// share (on all of them or only some), how many have a PDF, are unread, starred or
// retracted or lack a DOI or abstract, the value each editable field has on all of them
// (or that it is mixed), and which of them look like the same work. Read in a handful of
// statements over the selection, so it stays quick with thousands selected; a newer
// request for the same panel cancels it (`cancel`).
use crate::{Result, Store, e, reading::STATUS_SQL};
use rusqlite::params;
use serde::Serialize;
use serde_json::{Map, Value as Json};
use std::collections::HashMap;

/// Most sources one overview reads.
pub const MAX_SELECTION: usize = 20_000;
const TOP: usize = 8;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Count {
    pub value: String,
    pub count: i64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCount {
    pub id: String,
    pub name: String,
    pub count: i64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct YearBin {
    pub from: i64,
    pub to: i64,
    pub count: i64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Years {
    pub min: Option<i64>,
    pub max: Option<i64>,
    /// Sources per year (or span of years) from `min` to `max`, zeros included.
    pub histogram: Vec<YearBin>,
    pub without: i64,
}

/// A field's value across the selection: the same on all (`value`), or mixed.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shared {
    pub mixed: bool,
    pub value: Json,
    /// How many have a value at all.
    pub filled: i64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionOverview {
    /// Selected sources found (ids that no longer exist are left out).
    pub total: i64,
    pub trashed: i64,
    pub kinds: Vec<Count>,
    pub item_types: Vec<Count>,
    pub years: Years,
    /// The most frequent authors, and how many different ones there are.
    pub authors: Vec<Count>,
    pub author_count: i64,
    pub journals: Vec<Count>,
    pub journal_count: i64,
    /// Every tag on any of them (most frequent first, at most 200): `count == total` is "on all".
    pub tags: Vec<Count>,
    pub collections: Vec<CollectionCount>,
    pub with_file: i64,
    pub with_pdf: i64,
    pub unread: i64,
    pub reading: i64,
    pub read: i64,
    pub starred: i64,
    pub retracted: i64,
    pub missing_doi: i64,
    pub missing_abstract: i64,
    /// Bibliographic fields (camelCase) and `property:<name>` → their value across the selection.
    pub fields: Map<String, Json>,
    /// Groups of selected sources that look like the same work (two or more each).
    pub duplicates: Vec<Vec<String>>,
}

/// The bibliographic fields the panel edits for all, with their columns.
const FIELDS: &[(&str, &str)] = &[
    ("itemType", "item_type"),
    ("containerTitle", "container_title"),
    ("publisher", "publisher"),
    ("year", "year"),
    ("date", "date"),
    ("volume", "volume"),
    ("issue", "issue"),
    ("edition", "edition"),
    ("series", "series"),
    ("place", "place"),
    ("institution", "institution"),
    ("language", "language"),
    ("rights", "rights"),
    ("extra", "extra"),
];

impl Store {
    pub fn selection_overview(&self, ids: &[String]) -> Result<SelectionOverview> {
        if ids.len() > MAX_SELECTION {
            return Err("Too many sources".into());
        }
        let mut out = SelectionOverview::default();
        if ids.is_empty() {
            return Ok(out);
        }
        let selected = serde_json::to_string(ids).map_err(e)?;
        let db = self.read()?;
        // The selection's rows, read once per statement through the primary key.
        let view = "WITH v AS MATERIALIZED (SELECT s.* FROM (SELECT DISTINCT value AS id FROM json_each(?1)) sel JOIN sources s ON s.id = sel.id WHERE s.merged_into IS NULL)";

        // Counts and every field's shared value, in one row.
        let shared_columns: String = FIELDS
            .iter()
            .map(|(_, c)| format!(", count(DISTINCT coalesce(CAST(s.{c} AS TEXT), '')), min(s.{c}), count(nullif(CAST(s.{c} AS TEXT), ''))"))
            .collect();
        let sql = format!(
            "{view} SELECT count(*), count(s.trashed_at), count(s.file_path), count(CASE WHEN s.file_path IS NOT NULL AND (s.kind = 'pdf' OR s.mime = 'application/pdf') THEN 1 END),
                    count(CASE WHEN {STATUS_SQL} = 'unread' THEN 1 END), count(CASE WHEN {STATUS_SQL} = 'reading' THEN 1 END), count(CASE WHEN {STATUS_SQL} = 'read' THEN 1 END),
                    count(CASE WHEN s.starred = 1 THEN 1 END), count(CASE WHEN s.retracted = 1 AND s.retraction_dismissed = 0 THEN 1 END),
                    count(CASE WHEN nullif(trim(coalesce(s.doi, '')), '') IS NULL THEN 1 END), count(CASE WHEN nullif(trim(coalesce(s.abstract, '')), '') IS NULL THEN 1 END)
                    {shared_columns}
             FROM v s"
        );
        db.query_row(&sql, params![selected], |r| {
            out.total = r.get(0)?;
            out.trashed = r.get(1)?;
            out.with_file = r.get(2)?;
            out.with_pdf = r.get(3)?;
            out.unread = r.get(4)?;
            out.reading = r.get(5)?;
            out.read = r.get(6)?;
            out.starred = r.get(7)?;
            out.retracted = r.get(8)?;
            out.missing_doi = r.get(9)?;
            out.missing_abstract = r.get(10)?;
            for (i, (field, _)) in FIELDS.iter().enumerate() {
                let distinct: i64 = r.get(11 + i * 3)?;
                let value: rusqlite::types::Value = r.get(12 + i * 3)?;
                let filled: i64 = r.get(13 + i * 3)?;
                let shared = Shared { mixed: distinct > 1, value: if distinct > 1 { Json::Null } else { sql_json(value) }, filled };
                out.fields.insert((*field).into(), serde_json::to_value(shared).unwrap_or(Json::Null));
            }
            Ok(())
        })
        .map_err(e)?;
        if out.total == 0 {
            return Ok(out);
        }
        crate::cancel::check()?;

        // Groups, counted in one pass over the selection.
        let author = "coalesce(nullif(trim(json_extract(c.value, '$.literal')), ''), trim(coalesce(json_extract(c.value, '$.given'), '') || ' ' || coalesce(json_extract(c.value, '$.family'), '')))";
        let sql = format!(
            "{view}
             SELECT 'kind', kind, count(*) FROM v GROUP BY kind
             UNION ALL SELECT 'type', item_type, count(*) FROM v GROUP BY item_type
             UNION ALL SELECT 'year', CAST(year AS TEXT), count(*) FROM v WHERE year IS NOT NULL GROUP BY year
             UNION ALL SELECT 'tag', t.value, count(DISTINCT v.id) FROM v, json_each(v.tags) t GROUP BY t.value
             UNION ALL SELECT 'journal', min(trim(container_title)), count(*) FROM v WHERE nullif(trim(container_title), '') IS NOT NULL GROUP BY lower(trim(container_title))
             UNION ALL SELECT 'author', min(name), count(DISTINCT id) FROM (
               SELECT v.id, {author} AS name FROM v, json_each(v.creators) c WHERE coalesce(json_extract(c.value, '$.role'), 'author') = 'author'
             ) WHERE name <> '' GROUP BY lower(name)
             UNION ALL SELECT 'collection:' || sc.collection_id, min(col.name), count(DISTINCT v.id) FROM v JOIN source_collections sc ON sc.source_id = v.id JOIN collections col ON col.id = sc.collection_id GROUP BY sc.collection_id"
        );
        let mut statement = db.prepare(&sql).map_err(e)?;
        let rows = statement
            .query_map(params![selected], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default(), r.get::<_, i64>(2)?)))
            .map_err(e)?;
        let mut years = Vec::new();
        for row in rows {
            let (group, value, count) = row.map_err(e)?;
            match group.as_str() {
                "kind" => out.kinds.push(Count { value, count }),
                "type" => out.item_types.push(Count { value, count }),
                "year" => years.extend(value.parse::<i64>().ok().map(|y| (y, count))),
                "tag" => out.tags.push(Count { value, count }),
                "journal" => out.journals.push(Count { value, count }),
                "author" => out.authors.push(Count { value, count }),
                _ => out.collections.push(CollectionCount { id: group["collection:".len()..].to_string(), name: value, count }),
            }
        }
        drop(statement);
        let by_count = |a: &Count, b: &Count| b.count.cmp(&a.count).then_with(|| a.value.to_lowercase().cmp(&b.value.to_lowercase()));
        for list in [&mut out.kinds, &mut out.item_types, &mut out.tags, &mut out.journals, &mut out.authors] {
            list.sort_by(by_count);
        }
        out.collections.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        out.tags.truncate(200);
        out.author_count = out.authors.len() as i64;
        out.authors.truncate(TOP);
        out.journal_count = out.journals.len() as i64;
        out.journals.truncate(TOP);
        out.years = year_histogram(&years, out.total);
        crate::cancel::check()?;

        // Custom properties: the value on all of them, or mixed.
        let sql = format!(
            "{view} SELECT p.key, count(DISTINCT p.type || ':' || coalesce(p.value, '')), min(p.type), min(p.value), count(*)
             FROM v, json_each(v.properties) p WHERE p.type <> 'null' GROUP BY p.key"
        );
        let mut statement = db.prepare(&sql).map_err(e)?;
        let rows = statement
            .query_map(params![selected], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, rusqlite::types::Value>(3)?, r.get::<_, i64>(4)?)))
            .map_err(e)?;
        for row in rows {
            let (key, distinct, kind, value, filled) = row.map_err(e)?;
            // Set on only some: mixed with "no value".
            let mixed = distinct > 1 || filled < out.total;
            let value = if mixed { Json::Null } else { property_json(&kind, value) };
            out.fields.insert(format!("property:{key}"), serde_json::to_value(Shared { mixed, value, filled }).unwrap_or(Json::Null));
        }
        drop(statement);
        crate::cancel::check()?;

        out.duplicates = crate::duplicates::groups_among(&db, &selected)?;
        Ok(out)
    }
}

/// Every year from the first to the last (a long span is grouped into at most 40 bars).
fn year_histogram(years: &[(i64, i64)], total: i64) -> Years {
    let (Some(min), Some(max)) = (years.iter().map(|y| y.0).min(), years.iter().map(|y| y.0).max()) else {
        return Years { without: total, ..Default::default() };
    };
    let with: i64 = years.iter().map(|y| y.1).sum();
    let counts: HashMap<i64, i64> = years.iter().copied().collect();
    let span = max - min + 1;
    let step = ((span + 39) / 40).max(1);
    let mut histogram = Vec::new();
    let mut start = min;
    while start <= max {
        let end = (start + step - 1).min(max);
        let count = (start..=end).map(|y| counts.get(&y).copied().unwrap_or(0)).sum();
        histogram.push(YearBin { from: start, to: end, count });
        start += step;
    }
    Years { min: Some(min), max: Some(max), histogram, without: total - with }
}

fn sql_json(value: rusqlite::types::Value) -> Json {
    use rusqlite::types::Value;
    match value {
        Value::Null => Json::Null,
        Value::Integer(n) => Json::from(n),
        Value::Real(f) => Json::from(f),
        Value::Text(t) => Json::from(t),
        Value::Blob(_) => Json::Null,
    }
}

/// A `json_each` value back as JSON from its type.
fn property_json(kind: &str, value: rusqlite::types::Value) -> Json {
    match kind {
        "true" => Json::Bool(true),
        "false" => Json::Bool(false),
        "object" | "array" => match value {
            rusqlite::types::Value::Text(t) => serde_json::from_str(&t).unwrap_or(Json::Null),
            _ => Json::Null,
        },
        _ => sql_json(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SourceInput, now_ms};
    use serde_json::json;

    fn input(value: Json) -> SourceInput {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn overview_counts_shares_and_finds_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let shelf = store.create_collection("Shelf", None, None).unwrap();
        let a = store
            .insert_source(input(json!({"kind": "reference", "itemType": "article", "title": "Poverty traps and growth in rural areas", "year": 2006, "containerTitle": "Journal of Growth", "publisher": "MIT Press",
                "doi": "10.1/a", "tags": ["growth", "theory"], "properties": {"Stage": "New", "Rating": 3}, "collections": [shelf.id], "starred": true,
                "creators": [{"family": "Doe", "given": "Jane", "role": "author"}, {"family": "Roe", "given": "Rick"}]})))
            .unwrap();
        let b = store
            .insert_source(input(json!({"kind": "reference", "itemType": "article", "title": "Poverty traps and growth in rural areas", "year": 2006, "containerTitle": "journal of growth", "publisher": "MIT Press",
                "abstract": "An abstract.", "tags": ["growth"], "properties": {"Stage": "New"},
                "creators": [{"family": "Doe", "given": "Jane"}]})))
            .unwrap();
        let c = store
            .insert_source(input(json!({"kind": "reference", "itemType": "book", "title": "Cash transfers in Kenya", "year": 2016, "publisher": "MIT Press", "tags": ["growth", "policy"], "properties": {"Stage": "Screened"},
                "creators": [{"literal": "World Bank"}]})))
            .unwrap();
        store.update_source(&a.id, json!({"starred": true}).as_object().unwrap()).unwrap();
        let other = store.insert_source(input(json!({"kind": "reference", "title": "Unselected", "tags": ["x"]}))).unwrap();
        let ids = vec![a.id.clone(), b.id.clone(), c.id.clone(), "gone".to_string(), a.id.clone()];
        let o = store.selection_overview(&ids).unwrap();
        assert_eq!(o.total, 3);
        assert_eq!(o.item_types, vec![Count { value: "article".into(), count: 2 }, Count { value: "book".into(), count: 1 }]);
        assert_eq!((o.years.min, o.years.max, o.years.without), (Some(2006), Some(2016), 0));
        assert_eq!(o.years.histogram.len(), 11);
        assert_eq!(o.years.histogram[0].count, 2);
        assert_eq!(o.authors[0], Count { value: "Jane Doe".into(), count: 2 });
        assert_eq!(o.author_count, 3);
        assert_eq!(o.journals.len(), 1, "journal names differing in case are one");
        assert_eq!(o.journals[0].count, 2);
        assert_eq!(o.tags[0], Count { value: "growth".into(), count: 3 });
        assert!(o.tags.iter().all(|t| t.value != "x"));
        assert_eq!(o.collections, vec![CollectionCount { id: shelf.id.clone(), name: "Shelf".into(), count: 1 }]);
        assert_eq!((o.starred, o.unread, o.missing_doi, o.missing_abstract, o.with_pdf), (1, 3, 2, 2, 0));
        assert_eq!(o.fields["publisher"], json!({"mixed": false, "value": "MIT Press", "filled": 3}));
        assert_eq!(o.fields["year"]["mixed"], json!(true));
        assert_eq!(o.fields["volume"], json!({"mixed": false, "value": null, "filled": 0}));
        assert_eq!(o.fields["property:Stage"]["mixed"], json!(true));
        assert_eq!(o.fields["property:Rating"], json!({"mixed": true, "value": null, "filled": 1}));
        assert_eq!(o.duplicates.len(), 1);
        let mut group = o.duplicates[0].clone();
        group.sort();
        let mut expected = vec![a.id.clone(), b.id.clone()];
        expected.sort();
        assert_eq!(group, expected);
        // Only a and c: no duplicates, everything shared where it is the same.
        let o = store.selection_overview(&[a.id.clone(), other.id.clone()]).unwrap();
        assert!(o.duplicates.is_empty());
        assert!(store.selection_overview(&[]).unwrap().total == 0);
    }

    /// A made-up title of four pseudo-random words, different for every `n`.
    fn words(n: i64) -> String {
        let mut x = (n as u64).wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (0..4)
            .map(|_| {
                (0..7)
                    .map(|_| {
                        x ^= x >> 29;
                        x = x.wrapping_mul(0xbf58476d1ce4e5b9);
                        (b'a' + (x % 26) as u8) as char
                    })
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn overview_is_quick_with_thousands_selected() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        {
            let db = store.db().unwrap();
            let tx = db.unchecked_transaction().unwrap();
            let now = now_ms();
            for i in 0..20_000i64 {
                let stage = ["New", "Screened"][(i % 2) as usize];
                let props = json!({"Rating": i % 5, "Stage": stage}).to_string();
                let tags = json!([format!("t{}", i % 40), "all"]).to_string();
                let creators = json!([{"family": format!("Author{}", i % 500), "given": "A"}, {"family": format!("Second{}", i % 77)}]).to_string();
                // Every 1000th is a copy of the one before.
                let title = words(if i % 1000 == 1 { i - 1 } else { i });
                let creators = if i % 1000 == 1 { json!([{"family": format!("Author{}", (i - 1) % 500), "given": "A"}]).to_string() } else { creators };
                tx.execute(
                    "INSERT INTO sources(id, kind, item_type, title, creators, year, tags, properties, container_title, added_at, updated_at) VALUES (?1, 'reference', 'article', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                    rusqlite::params![format!("s{i}"), title, creators, 1990 + (i / 2) % 35, tags, props, format!("Journal {}", i % 60), now - i],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }
        let ids: Vec<String> = (0..5_000).map(|i| format!("s{i}")).collect();
        let start = std::time::Instant::now();
        let o = store.selection_overview(&ids).unwrap();
        let took = start.elapsed();
        assert_eq!(o.total, 5_000);
        assert_eq!(o.tags.iter().find(|t| t.value == "all").map(|t| t.count), Some(5_000));
        assert_eq!(o.journal_count, 60);
        assert_eq!(o.duplicates.len(), 5, "{:?}", o.duplicates);
        // Debug build on a busy machine; release is several times faster.
        assert!(took.as_millis() < 2_500, "{took:?}");
        eprintln!("selection overview of 5000 in 20000: {took:?}");
    }
}
