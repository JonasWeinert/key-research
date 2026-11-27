// Search filters ("Author is Mohamed Ali", "Journal contains lancet") and the suggestions
// that create them as the user types, in the manner of Apple Mail's search tokens.
use crate::{ListQuery, Result, Store, e, fts_phrase, where_clause};
use rusqlite::{params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

/// One filter. Several filters all have to match.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    /// creator | container | title | abstract | notes | fulltext | tag | collection | year | kind | itemType | property
    /// and, by id from the metadata graph (typed: by name with `contains`): person | venue | publisher |
    /// institution | topic | keyword | funder; from OpenAlex: citations | retracted | oaStatus | openAccess |
    /// workType | language; more details: volume | issue | pages | edition | series | place | genre | issn |
    /// url | citationKey | publisherName; dates (ms or YYYY[-MM[-DD]], ranges "a..b"): added | modified | read;
    /// numbers: pageCount | notesCount | highlightsCount | commentsCount; yes/no ("true" | "false"):
    /// starred | hasFile | hasPdf | zotero | duplicate; another source (id, citation key, DOI or title):
    /// cites | citedBy | related; and `any`: at least one of the filters in `any` matches.
    pub field: String,
    /// is | contains (default) | exact (a tag without the tags under it) | gt | gte | lt | lte
    /// | between ("a..b") | empty | notEmpty
    #[serde(default)]
    pub op: Option<String>,
    pub value: String,
    /// The property name, for `field = "property"`; a creator's role for `creator`.
    #[serde(default)]
    pub key: Option<String>,
    /// Turned around: the sources the filter does not match.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub negate: bool,
    /// An OR group (`field = "any"`): sources matching at least one of these.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub any: Vec<Filter>,
    /// A property's type as the query was read (number | date | boolean | text), so
    /// "rating>3" compares numbers and "due<2026-01-01" dates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_type: Option<String>,
}

/// A creator's display name from its JSON: the literal name, or "Given Family".
const NAME: &str = "trim(coalesce(nullif(json_extract(c.value, '$.literal'), ''), \
    coalesce(json_extract(c.value, '$.given'), '') || ' ' || coalesce(json_extract(c.value, '$.family'), '')))";

fn like(value: &str) -> Value {
    let escaped = value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    Value::Text(format!("%{escaped}%"))
}

/// The SQL condition (over `sources s`) and bound values for one filter.
pub(crate) fn condition(filter: &Filter) -> Option<(String, Vec<Value>)> {
    let (sql, values) = if filter.field == "any" || !filter.any.is_empty() {
        let parts: Vec<(String, Vec<Value>)> = filter.any.iter().filter_map(condition).collect();
        if parts.is_empty() {
            return None;
        }
        let sql = parts.iter().map(|(sql, _)| format!("({sql})")).collect::<Vec<_>>().join(" OR ");
        (sql, parts.into_iter().flat_map(|(_, v)| v).collect())
    } else {
        base_condition(filter)?
    };
    // NULL counts as "does not match", so a turned-around filter keeps those sources.
    Some(if filter.negate { (format!("coalesce(({sql}), 0) = 0"), values) } else { (format!("({sql})"), values) })
}

fn comparison(op: Option<&str>) -> &'static str {
    match op {
        Some("gt") => ">",
        Some("gte") => ">=",
        Some("lt") => "<",
        Some("lte") => "<=",
        _ => "=",
    }
}

fn number(text: &str) -> Option<Value> {
    let t = text.trim();
    t.parse::<i64>().map(Value::Integer).ok().or_else(|| t.parse::<f64>().ok().filter(|f| f.is_finite()).map(Value::Real))
}

/// `expr` against a number, or a range "a..b".
fn numeric(expr: &str, op: Option<&str>, value: &str) -> Option<(String, Vec<Value>)> {
    if let Some((a, b)) = value.split_once("..") {
        return Some((format!("{expr} BETWEEN ? AND ?"), vec![number(a)?, number(b)?]));
    }
    Some((format!("{expr} {} ?", comparison(op)), vec![number(value)?]))
}

/// `YYYY`, `YYYY-MM`, `YYYY-MM-DD` (or ms) as milliseconds since the epoch: the start of that
/// year, month or day and the start of the next.
pub(crate) fn date_span(text: &str) -> Option<(i64, i64)> {
    let t = text.trim();
    if t.len() >= 10 && t.chars().all(|c| c.is_ascii_digit()) {
        let ms: i64 = t.parse().ok()?;
        return Some((ms, ms + 1));
    }
    let start = crate::reading::date_ms(t)?;
    let parts: Vec<&str> = t.get(..t.len().min(10))?.split('-').collect();
    let end = match parts.len() {
        1 => crate::reading::date_ms(&format!("{}-01-01", parts[0].parse::<i64>().ok()? + 1))?,
        2 => {
            let (y, m): (i64, i64) = (parts[0].parse().ok()?, parts[1].parse().ok()?);
            let (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            crate::reading::date_ms(&format!("{y:04}-{m:02}-01"))?
        }
        _ => start + 86_400_000,
    };
    Some((start, end))
}

/// `expr` (ms since the epoch) against a day, month, year or a range of them.
fn dated(expr: &str, op: Option<&str>, value: &str) -> Option<(String, Vec<Value>)> {
    let (first, last) = value.split_once("..").unwrap_or((value, value));
    let (start, _) = date_span(first)?;
    let (_, end) = date_span(last)?;
    let (sql, bound) = match op {
        Some("gt") => (format!("{expr} >= ?"), vec![end]),
        Some("gte") => (format!("{expr} >= ?"), vec![start]),
        Some("lt") => (format!("{expr} < ?"), vec![start]),
        Some("lte") => (format!("{expr} < ?"), vec![end]),
        _ => (format!("({expr} >= ? AND {expr} < ?)"), vec![start, end]),
    };
    Some((sql, bound.into_iter().map(Value::Integer).collect()))
}

/// "true", "yes" … as the yes/no filters take them.
pub(crate) fn truthy(value: &str) -> bool {
    matches!(value.trim().to_lowercase().as_str(), "true" | "yes" | "y" | "1" | "on" | "checked")
}

/// The sources' column for a plain text detail.
fn text_column(field: &str) -> Option<&'static str> {
    Some(match field {
        "title" => "s.title",
        "abstract" => "s.abstract",
        "container" => "s.container_title",
        "volume" => "s.volume",
        "issue" => "s.issue",
        "pages" => "s.pages",
        "edition" => "s.edition",
        "series" => "s.series",
        "place" => "s.place",
        "genre" => "s.genre",
        "issn" => "s.issn",
        "url" => "s.url",
        "doi" => "s.doi",
        "isbn" => "s.isbn",
        "pmid" => "s.pmid",
        "pmcid" => "s.pmcid",
        "arxiv" => "s.arxiv_id",
        "citationKey" => "s.citation_key",
        "language" => "s.language",
        "publisherName" => "s.publisher",
        "workType" => "s.work_type",
        "oaStatus" => "s.oa_status",
        "itemType" => "s.item_type",
        "date" => "s.date",
        _ => return None,
    })
}

/// "Is empty" for a field (its negation is "is not empty").
fn empty_condition(filter: &Filter) -> Option<String> {
    if let Some(column) = text_column(&filter.field) {
        return Some(format!("coalesce(trim({column}), '') = ''"));
    }
    Some(match filter.field.as_str() {
        "creator" | "person" => "coalesce(s.creators, '[]') = '[]'".into(),
        "tag" => "coalesce(s.tags, '[]') = '[]'".into(),
        "collection" => "NOT EXISTS (SELECT 1 FROM source_collections sc WHERE sc.source_id = s.id)".into(),
        "notes" => "NOT EXISTS (SELECT 1 FROM notes n WHERE n.source_id = s.id)".into(),
        "year" => "s.year IS NULL".into(),
        "citations" => "s.cited_by_count IS NULL".into(),
        "pageCount" => "coalesce(s.page_count, 0) = 0".into(),
        "venue" => "s.venue_id IS NULL AND coalesce(s.container_title, '') = ''".into(),
        "publisher" => "s.publisher_id IS NULL AND coalesce(s.publisher, '') = ''".into(),
        "funder" => "NOT EXISTS (SELECT 1 FROM source_grants g WHERE g.source_id = s.id)".into(),
        "topic" => "NOT EXISTS (SELECT 1 FROM source_topics t WHERE t.source_id = s.id)".into(),
        "keyword" => "NOT EXISTS (SELECT 1 FROM source_keywords k WHERE k.source_id = s.id)".into(),
        "institution" => "NOT EXISTS (SELECT 1 FROM source_person_institutions x WHERE x.source_id = s.id)".into(),
        "read" => format!("{} IS NULL", crate::reading::LAST_READ_SQL),
        "property" => {
            let v = crate::formula::property_sql(filter.key.as_deref()?);
            format!("({v} IS NULL OR CAST({v} AS TEXT) IN ('', '[]'))")
        }
        _ => return None,
    })
}

/// The sources a value names: by id, citation key, DOI or a title containing it.
const TARGET: &str = "(SELECT t.id FROM sources t WHERE t.trashed_at IS NULL AND (t.id = ? OR t.citation_key = ? COLLATE NOCASE OR lower(t.doi) = lower(?) OR t.title LIKE ? ESCAPE '\\') LIMIT 50)";

fn target_values(value: &str) -> Vec<Value> {
    let bare = value.trim_start_matches('@');
    vec![Value::Text(bare.into()), Value::Text(bare.into()), Value::Text(bare.into()), like(bare)]
}

/// Sources whose DOI, or title and year, another source in the library shares.
const DUPLICATE: &str = "s.id IN (SELECT x.id FROM sources x WHERE x.trashed_at IS NULL AND (
    (coalesce(x.doi, '') <> '' AND lower(trim(x.doi)) IN (SELECT lower(trim(doi)) FROM sources WHERE trashed_at IS NULL AND coalesce(doi, '') <> '' GROUP BY 1 HAVING count(*) > 1))
    OR (x.title <> '' AND (lower(x.title), coalesce(x.year, 0)) IN (SELECT lower(title), coalesce(year, 0) FROM sources WHERE trashed_at IS NULL AND title <> '' GROUP BY 1, 2 HAVING count(*) > 1))))";

fn base_condition(filter: &Filter) -> Option<(String, Vec<Value>)> {
    let value = filter.value.trim();
    let op = filter.op.as_deref();
    match op {
        Some("empty") => return empty_condition(filter).map(|sql| (sql, vec![])),
        Some("notEmpty") => return empty_condition(filter).map(|sql| (format!("NOT ({sql})"), vec![])),
        _ => {}
    }
    // Yes/no filters take "true" or "false" (none: yes).
    let yes = value.is_empty() || truthy(value);
    let flag = |sql: &str| Some((if yes { sql.to_string() } else { format!("NOT ({sql})") }, vec![]));
    match filter.field.as_str() {
        "starred" => return flag("s.starred = 1"),
        "hasFile" => return flag("coalesce(s.file_path, '') <> ''"),
        "hasPdf" => return flag("(s.kind = 'pdf' OR s.mime = 'application/pdf')"),
        "zotero" => return flag("s.origin = 'zotero'"),
        "duplicate" => return flag(DUPLICATE),
        "openAccess" => return flag("(coalesce(s.oa_status, '') NOT IN ('', 'closed') OR coalesce(s.oa_url, '') <> '')"),
        _ => {}
    }
    if value.is_empty() {
        return None;
    }
    let exact = op == Some("is");
    let text = || Value::Text(value.to_string());
    let counted = |sql: &str| numeric(&format!("({sql})"), op, value);
    // The graph's people, publishers, topics … are named by id unless typed ("contains").
    let by_id = op != Some("contains");
    let exact = if matches!(filter.field.as_str(), "publisher" | "institution" | "topic" | "keyword" | "funder") { by_id } else { exact };
    let (sql, values) = match (filter.field.as_str(), exact) {
        // A role ("editor") narrows to the creators in it; authors are those without one.
        ("creator", _) if filter.key.is_some() => {
            let role = filter.key.clone().unwrap_or_default();
            let (test, bound) = if exact { (format!("{NAME} = ? COLLATE NOCASE"), text()) } else { (format!("{NAME} LIKE ? ESCAPE '\\'"), like(value)) };
            (
                format!("EXISTS (SELECT 1 FROM json_each(s.creators) c WHERE coalesce(nullif(json_extract(c.value, '$.role'), ''), 'author') = ? AND {test})"),
                vec![Value::Text(role), bound],
            )
        }
        ("creator", true) => (format!("EXISTS (SELECT 1 FROM json_each(s.creators) c WHERE {NAME} = ? COLLATE NOCASE)"), vec![text()]),
        ("creator", false) => (format!("EXISTS (SELECT 1 FROM json_each(s.creators) c WHERE {NAME} LIKE ? ESCAPE '\\')"), vec![like(value)]),
        ("container", true) => ("s.container_title = ? COLLATE NOCASE".into(), vec![text()]),
        ("container", false) => (
            "(s.container_title LIKE ? ESCAPE '\\' OR s.container_short LIKE ? ESCAPE '\\' OR s.publisher LIKE ? ESCAPE '\\')".into(),
            vec![like(value), like(value), like(value)],
        ),
        ("title", true) => ("s.title = ? COLLATE NOCASE".into(), vec![text()]),
        ("title", false) => ("(s.title LIKE ? ESCAPE '\\' OR s.short_title LIKE ? ESCAPE '\\')".into(), vec![like(value), like(value)]),
        ("abstract", _) => ("s.abstract LIKE ? ESCAPE '\\'".into(), vec![like(value)]),
        ("notes", _) => (
            "s.id IN (SELECT source_id FROM notes WHERE body LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')".into(),
            vec![like(value), like(value)],
        ),
        ("fulltext", _) => (
            "s.id IN (SELECT ch.source_id FROM chunks ch WHERE ch.id IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?))".into(),
            vec![Value::Text(fts_phrase(value)?)],
        ),
        // A tag includes the tags under it in the tag tree; "exact" is that tag only.
        ("tag", _) if op == Some("exact") => ("EXISTS (SELECT 1 FROM json_each(s.tags) t WHERE t.value = ? COLLATE NOCASE)".into(), vec![text()]),
        // Written as a path ("methods/qual"), the tags under it count too.
        ("tag", true) => (
            format!("({} OR EXISTS (SELECT 1 FROM json_each(s.tags) t WHERE lower(t.value) LIKE lower(?) || '/%' ESCAPE '\\'))", crate::tag_ops::tag_family_condition("?")),
            vec![text(), Value::Text(value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))],
        ),
        ("tag", false) => ("EXISTS (SELECT 1 FROM json_each(s.tags) t WHERE t.value LIKE ? ESCAPE '\\')".into(), vec![like(value)]),
        // A collection (by id, or by name as typed) includes items filed in its sub-collections.
        ("collection", _) => (
            "s.id IN (SELECT sc.source_id FROM source_collections sc WHERE sc.collection_id IN (
               WITH RECURSIVE tree(id) AS (SELECT id FROM collections WHERE id = ? OR name = ? COLLATE NOCASE UNION ALL SELECT c.id FROM collections c JOIN tree ON c.parent_id = tree.id)
               SELECT id FROM tree))"
                .into(),
            vec![text(), text()],
        ),
        ("year", _) => numeric("s.year", op, value)?,
        // Identifiers as the search field reads them from a pasted DOI, link or number.
        ("doi", _) => (
            "lower(trim(s.doi)) IN (lower(?), 'https://doi.org/' || lower(?), 'http://doi.org/' || lower(?), 'https://dx.doi.org/' || lower(?), 'doi:' || lower(?))".into(),
            vec![text(), text(), text(), text(), text()],
        ),
        ("citationKey", true) => ("s.citation_key = ? COLLATE NOCASE".into(), vec![text()]),
        ("citationKey", false) => ("s.citation_key LIKE ? ESCAPE '\\'".into(), vec![like(value)]),
        ("pmid", _) => ("trim(s.pmid) = ?".into(), vec![text()]),
        ("pmcid", _) => ("upper(trim(s.pmcid)) IN (upper(?), 'PMC' || upper(?))".into(), vec![text(), text()]),
        // Stored with or without its version; a preprint may only carry its arXiv DOI.
        ("arxiv", _) => (
            "(lower(s.arxiv_id) = lower(?) OR lower(s.arxiv_id) LIKE lower(?) || 'v%' OR lower(s.arxiv_id) = 'arxiv:' || lower(?) OR lower(s.doi) = '10.48550/arxiv.' || lower(?))".into(),
            vec![text(), text(), text(), text()],
        ),
        ("isbn", _) => ("replace(replace(upper(s.isbn), '-', ''), ' ', '') LIKE ? ESCAPE '\\'".into(), vec![like(&value.to_uppercase().replace(['-', ' '], ""))]),
        ("url", _) => ("s.url LIKE ? ESCAPE '\\'".into(), vec![like(value)]),
        ("kind", _) => ("s.kind = ?".into(), vec![text()]),
        // "journal article" and "article-journal" alike.
        ("itemType", _) => ("(s.item_type = ? OR replace(lower(s.item_type), '-', ' ') = replace(lower(?), '-', ' '))".into(), vec![text(), text()]),
        ("person", _) => ("EXISTS (SELECT 1 FROM source_people sp WHERE sp.source_id = s.id AND sp.person_id = ?)".into(), vec![text()]),
        ("venue", _) => ("s.venue_id = ?".into(), vec![text()]),
        // The graph's publisher by id; typed, by name (or the source's own publisher text).
        ("publisher", true) => ("(s.publisher_id = ? OR s.venue_id IN (SELECT id FROM venues WHERE publisher_id = ?))".into(), vec![text(), text()]),
        ("publisher", false) => (
            "(s.publisher LIKE ? ESCAPE '\\' OR s.publisher_id IN (SELECT id FROM publishers WHERE name LIKE ? ESCAPE '\\'))".into(),
            vec![like(value), like(value)],
        ),
        ("institution", true) => ("EXISTS (SELECT 1 FROM source_person_institutions x WHERE x.source_id = s.id AND x.institution_id = ?)".into(), vec![text()]),
        ("institution", false) => (
            "(s.institution LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM source_person_institutions x JOIN institutions i ON i.id = x.institution_id WHERE x.source_id = s.id AND i.name LIKE ? ESCAPE '\\'))".into(),
            vec![like(value), like(value)],
        ),
        // A domain, field or subfield includes the topics under it.
        ("topic", true) => (format!("s.id IN ({})", crate::graph::TOPIC_SOURCES.replace("?1", "?")), vec![text()]),
        ("topic", false) => (
            "EXISTS (SELECT 1 FROM source_topics st JOIN topics t ON t.id = st.topic_id WHERE st.source_id = s.id AND t.name LIKE ? ESCAPE '\\')".into(),
            vec![like(value)],
        ),
        ("keyword", true) => ("EXISTS (SELECT 1 FROM source_keywords k WHERE k.source_id = s.id AND k.keyword_id = ?)".into(), vec![text()]),
        ("keyword", false) => (
            "EXISTS (SELECT 1 FROM source_keywords sk JOIN keywords k ON k.id = sk.keyword_id WHERE sk.source_id = s.id AND k.name LIKE ? ESCAPE '\\')".into(),
            vec![like(value)],
        ),
        ("funder", true) => ("EXISTS (SELECT 1 FROM source_grants g WHERE g.source_id = s.id AND g.funder_id = ?)".into(), vec![text()]),
        ("funder", false) => (
            "EXISTS (SELECT 1 FROM source_grants g JOIN funders f ON f.id = g.funder_id WHERE g.source_id = s.id AND f.name LIKE ? ESCAPE '\\')".into(),
            vec![like(value)],
        ),
        ("citations", _) => numeric("s.cited_by_count", op, value)?,
        ("pageCount", _) => numeric("s.page_count", op, value)?,
        ("notesCount", _) => counted("SELECT count(*) FROM notes n WHERE n.source_id = s.id")?,
        ("highlightsCount", _) => counted("SELECT count(*) FROM annotations a WHERE a.source_id = s.id")?,
        ("commentsCount", _) => counted("SELECT count(*) FROM annotations a WHERE a.source_id = s.id AND coalesce(json_extract(a.payload, '$.comment'), '') <> ''")?,
        ("added", _) => dated("s.added_at", op, value)?,
        ("modified", _) => dated("s.updated_at", op, value)?,
        // Reading status (reading.rs): unread | reading | read, and when it was last read.
        ("status", _) => (format!("{} = ?", crate::reading::STATUS_SQL), vec![Value::Text(match value.to_lowercase().as_str() {
            "in-progress" | "progress" | "started" => "reading".into(),
            "finished" | "done" => "read".into(),
            other => other.to_string(),
        })]),
        // Without a comparison: read on or after the date (as before), or within a range.
        ("read", _) => dated(crate::reading::LAST_READ_SQL, if op.is_none() && !value.contains("..") { Some("gte") } else { op }, value)?,
        ("retracted", _) => (if value == "false" { "coalesce(s.retracted, 0) = 0" } else { "s.retracted = 1" }.into(), vec![]),
        ("oaStatus", _) => ("s.oa_status = ? COLLATE NOCASE".into(), vec![text()]),
        ("workType", _) => ("s.work_type = ? COLLATE NOCASE".into(), vec![text()]),
        ("language", _) => ("(s.language = ? COLLATE NOCASE OR s.language LIKE ? || '-%')".into(), vec![text(), text()]),
        // Another source: what cites it, what it cites, or either.
        ("cites", _) => (format!("s.id IN (SELECT sc.source_id FROM source_cites sc WHERE sc.matched_source_id IN {TARGET})"), target_values(value)),
        ("citedBy", _) => (format!("s.id IN (SELECT sc.matched_source_id FROM source_cites sc WHERE sc.source_id IN {TARGET})"), target_values(value)),
        ("related", _) => (
            format!(
                "(s.id IN (SELECT sc.source_id FROM source_cites sc WHERE sc.matched_source_id IN {TARGET}) OR s.id IN (SELECT sc.matched_source_id FROM source_cites sc WHERE sc.source_id IN {TARGET}))"
            ),
            [target_values(value), target_values(value)].concat(),
        ),
        // A property (a formula by its computed value), by its type.
        ("property", is) => property_condition(filter.key.as_deref()?, filter.value_type.as_deref(), op, value, is)?,
        (field, _) => {
            let column = text_column(field)?;
            if exact {
                (format!("{column} = ? COLLATE NOCASE"), vec![text()])
            } else {
                (format!("{column} LIKE ? ESCAPE '\\'"), vec![like(value)])
            }
        }
    };
    Some((sql, values))
}

fn property_condition(name: &str, value_type: Option<&str>, op: Option<&str>, value: &str, is: bool) -> Option<(String, Vec<Value>)> {
    let v = crate::formula::property_sql(name);
    let compares = matches!(op, Some("gt" | "gte" | "lt" | "lte" | "between")) || value.contains("..");
    let compared = || numeric(&format!("CAST({v} AS REAL)"), op, value).map(|(sql, b)| (format!("({v} IS NOT NULL AND CAST({v} AS TEXT) <> '' AND {sql})"), b));
    match value_type {
        Some("boolean") => {
            let sql = if truthy(value) {
                format!("({v} IN (1, 'true', 'yes', '1') OR CAST({v} AS TEXT) = 'true')")
            } else {
                format!("coalesce({v}, 0) IN (0, 'false', 'no', '0', '')")
            };
            return Some((sql, vec![]));
        }
        Some("date") => {
            let ms = format!("(CAST(strftime('%s', substr(CAST({v} AS TEXT), 1, 10)) AS INTEGER) * 1000)");
            return dated(&ms, op, value);
        }
        Some("number") if compares || number(value).is_some() => return compared(),
        _ if compares => return compared(),
        _ => {}
    }
    let text = Value::Text(value.to_string());
    Some(if is {
        // A multi-select holds a list: any of its values.
        (
            format!(
                "EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid({v}) AND json_type({v}) = 'array' THEN {v} ELSE json_array({v}) END) j WHERE CAST(j.value AS TEXT) = ? COLLATE NOCASE)"
            ),
            vec![text],
        )
    } else {
        (format!("CAST({v} AS TEXT) LIKE ? ESCAPE '\\'"), vec![like(value)])
    })
}

/// A filter the user can pick, with how many sources in the current view it matches.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub filter: Filter,
    /// What the menu shows, e.g. a person's name or a journal title.
    pub label: String,
    pub count: i64,
}

impl Store {
    /// Values in the current view that start a word with what was typed: people, journals,
    /// tags, collections, years and values of the user's defined properties, most common
    /// first within each group.
    pub fn suggest(&self, text: &str, view: &ListQuery, per_group: usize) -> Result<Vec<Suggestion>> {
        let typed = text.trim();
        if typed.chars().count() < 2 {
            return Ok(Vec::new());
        }
        let mut view = view.clone();
        view.text = None;
        let (clause, values) = where_clause(&view);
        let db = self.read()?;
        let escaped = typed.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        // Matches at the start of the value or of any word in it ("Ali" in "Mohamed Ali").
        let starts = Value::Text(format!("{escaped}%"));
        let inner = Value::Text(format!("% {escaped}%"));
        let word = "(v LIKE ?1 ESCAPE '\\' OR v LIKE ?2 ESCAPE '\\')";
        let limit = per_group.clamp(1, 20);
        let mut out = Vec::new();
        let mut group = |field: &str, sql: String, key: bool| -> Result<()> {
            let mut statement = db.prepare(&sql).map_err(e)?;
            let mut args = vec![starts.clone(), inner.clone()];
            args.extend(values.iter().cloned());
            let rows = statement
                .query_map(params_from_iter(args.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, if key { r.get::<_, Option<String>>(2)? } else { None }))
                })
                .map_err(e)?;
            for row in rows {
                let (value, count, property) = row.map_err(e)?;
                out.push(Suggestion {
                    label: value.clone(),
                    count,
                    filter: Filter { field: field.into(), op: Some("is".into()), value, key: property, ..Default::default() },
                });
            }
            Ok(())
        };
        // Bound values: ?1 and ?2 are the patterns, the view's own values follow from ?3.
        let numbered = number_from(&clause, 3);
        group(
            "creator",
            format!(
                "SELECT v, count(DISTINCT sid) n FROM (SELECT s.id sid, {NAME} v FROM sources s, json_each(s.creators) c {numbered})
                 WHERE v <> '' AND {word} GROUP BY v COLLATE NOCASE ORDER BY v LIKE ?1 ESCAPE '\\' DESC, n DESC, v LIMIT {limit}"
            ),
            false,
        )?;
        group(
            "container",
            format!(
                "SELECT v, count(*) n FROM (SELECT s.container_title v FROM sources s {numbered})
                 WHERE v IS NOT NULL AND v <> '' AND {word} GROUP BY v COLLATE NOCASE ORDER BY n DESC, v LIMIT {limit}"
            ),
            false,
        )?;
        group(
            "tag",
            format!(
                "SELECT v, count(*) n FROM (SELECT t.value v FROM sources s, json_each(s.tags) t {numbered})
                 WHERE {word} GROUP BY v COLLATE NOCASE ORDER BY n DESC, v LIMIT {limit}"
            ),
            false,
        )?;
        group(
            "property",
            format!(
                "SELECT v, count(*) n, k FROM (SELECT CAST(p.value AS TEXT) v, p.key k FROM sources s, json_each(s.properties) p {numbered}
                   AND p.type IN ('text', 'integer', 'real') AND length(CAST(p.value AS TEXT)) <= 80
                   AND p.key IN (SELECT name FROM property_definitions))
                 WHERE {word} GROUP BY k, v COLLATE NOCASE ORDER BY n DESC, v LIMIT {limit}"
            ),
            true,
        )?;
        drop(group);
        // Collections and years are matched by name and number rather than from the view.
        let mut statement = db
            .prepare(&format!(
                "SELECT c.id, c.name, (SELECT count(*) FROM source_collections sc WHERE sc.collection_id = c.id) FROM collections c
                 WHERE (c.name LIKE ?1 ESCAPE '\\' OR c.name LIKE ?2 ESCAPE '\\') ORDER BY c.name LIKE ?1 ESCAPE '\\' DESC, c.name LIMIT {limit}"
            ))
            .map_err(e)?;
        let rows = statement
            .query_map([starts.clone(), inner.clone()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
            .map_err(e)?;
        for row in rows {
            let (id, name, count) = row.map_err(e)?;
            out.push(Suggestion { label: name, count, filter: Filter { field: "collection".into(), op: Some("is".into()), value: id, key: None, ..Default::default() } });
        }
        // People, journals, topics, keywords and funders of the view, by id.
        for (field, sql) in [
            (
                "topic",
                "SELECT t.id, t.name, count(DISTINCT s.id) n FROM sources s JOIN source_topics st ON st.source_id = s.id JOIN topics t ON t.id = st.topic_id",
            ),
            ("keyword", "SELECT k.id, k.name, count(DISTINCT s.id) n FROM sources s JOIN source_keywords sk ON sk.source_id = s.id JOIN keywords k ON k.id = sk.keyword_id"),
            ("funder", "SELECT f.id, f.name, count(DISTINCT s.id) n FROM sources s JOIN source_grants g ON g.source_id = s.id JOIN funders f ON f.id = g.funder_id"),
        ] {
            let name = sql.split(", ").nth(1).unwrap_or("").trim();
            let mut statement = db
                .prepare(&format!(
                    "{sql} {numbered} AND ({name} LIKE ?1 ESCAPE '\\' OR {name} LIKE ?2 ESCAPE '\\') GROUP BY 1 ORDER BY n DESC, 2 LIMIT {limit}"
                ))
                .map_err(e)?;
            let mut args = vec![starts.clone(), inner.clone()];
            args.extend(values.iter().cloned());
            let rows = statement
                .query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
                .map_err(e)?;
            for row in rows {
                let (id, name, count) = row.map_err(e)?;
                out.push(Suggestion { label: name, count, filter: Filter { field: field.into(), op: Some("is".into()), value: id, key: None, ..Default::default() } });
            }
        }
        // "> 100", "cited 100" or "citations >= 50": a citation count.
        let lower = typed.to_ascii_lowercase();
        let rest = lower.trim_start_matches(|c: char| c.is_ascii_alphabetic()).trim_start();
        let op = rest.chars().take_while(|c| matches!(c, '<' | '>' | '=')).collect::<String>();
        let number = rest[op.len()..].trim();
        let cites = lower.starts_with("cit") || (!op.is_empty() && rest.len() == lower.len());
        let op = op.as_str();
        if let (true, Ok(number)) = (cites, number.parse::<i64>()) {
            let op = match op {
                "<" => "lt",
                "<=" => "lte",
                ">=" => "gte",
                _ => "gt",
            };
            let filter = Filter { field: "citations".into(), op: Some(op.into()), value: number.to_string(), key: None, ..Default::default() };
            let mut cited_view = view.clone();
            cited_view.filters.push(filter.clone());
            let (clause, values) = where_clause(&cited_view);
            let count: i64 = db.query_row(&format!("SELECT count(*) FROM sources s {clause}"), params_from_iter(values.iter()), |r| r.get(0)).map_err(e)?;
            let words = match op {
                "lt" => "fewer than",
                "lte" => "at most",
                "gte" => "at least",
                _ => "more than",
            };
            out.push(Suggestion { label: format!("Cited {words} {number} times"), count, filter });
        }
        if let Ok(year) = typed.parse::<i64>() {
            if (1400..=2200).contains(&year) {
                let mut year_view = view.clone();
                year_view.filters.push(Filter { field: "year".into(), value: year.to_string(), ..Default::default() });
                let (clause, values) = where_clause(&year_view);
                let count: i64 = db
                    .query_row(&format!("SELECT count(*) FROM sources s {clause}"), params_from_iter(values.iter()), |r| r.get(0))
                    .map_err(e)?;
                if count > 0 {
                    out.push(Suggestion { label: year.to_string(), count, filter: Filter { field: "year".into(), op: Some("is".into()), value: year.to_string(), key: None, ..Default::default() } });
                }
            }
        }
        Ok(out)
    }
}

/// Rewrites bare `?` placeholders as `?N, ?N+1, …` so they can follow numbered ones.
fn number_from(sql: &str, first: usize) -> String {
    let mut out = String::with_capacity(sql.len() + 16);
    let mut next = first;
    let mut chars = sql.chars().peekable();
    let mut quoted = false;
    while let Some(ch) = chars.next() {
        if ch == '\'' {
            quoted = !quoted;
        }
        if ch == '?' && !quoted && !chars.peek().is_some_and(|c| c.is_ascii_digit()) {
            out.push_str(&format!("?{next}"));
            next += 1;
        } else {
            out.push(ch);
        }
    }
    out
}
