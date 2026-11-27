// The Inbox's "N works selected" panel: an overview of works that are not library sources
// yet, from what the feeds brought (types, years, authors, journals, which feeds and alerts
// found them, how many the library has already or possibly has, open access, a PDF link,
// retractions), and adding many of them to the library at once in batches, skipping those
// the library has. The library's own panel reads sources instead (selection.rs).
use crate::feeds::{creator_of, match_query, text};
use crate::matching::{MatchQuery, bare_openalex};
use crate::selection::{Count, Years, year_histogram};
use crate::{Result, SourceInput, Store, e};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};
use std::collections::{HashMap, HashSet};

/// Most items one overview reads.
pub const MAX_SELECTION: usize = 20_000;
/// Most items one add call takes: the renderer sends larger selections in batches.
pub const MAX_ADD: usize = 200;
const TOP: usize = 8;
/// The matcher answers at most this many works per call.
const MATCH_CHUNK: usize = 500;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedCount {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub count: i64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxOverview {
    /// Selected items found (ids no longer in the Inbox are left out).
    pub total: i64,
    /// Library item types (`article`, `preprint` …) as adding would file them.
    pub item_types: Vec<Count>,
    pub years: Years,
    pub authors: Vec<Count>,
    pub author_count: i64,
    pub journals: Vec<Count>,
    pub journal_count: i64,
    /// The feeds and alerts that brought them, most first.
    pub feeds: Vec<FeedCount>,
    /// Saved by the user from elsewhere in Key (not brought by a feed).
    pub saved_by_you: i64,
    /// The library has them: added from the Inbox, or a certain identifier match.
    pub in_library: i64,
    /// A library source has the same title, year and first author (adding is still allowed).
    pub possibly_in_library: i64,
    pub open_access: i64,
    pub with_pdf_link: i64,
    pub retracted: i64,
    pub missing_doi: i64,
    pub missing_abstract: i64,
    pub unread: i64,
    pub saved: i64,
    /// The item ids behind `in_library` and `possibly_in_library`.
    pub in_library_ids: Vec<String>,
    pub possible_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddedItem {
    pub item_id: String,
    pub source_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedItem {
    pub item_id: String,
    pub source_id: Option<String>,
    /// added (from the Inbox before) | library (the library had it) | gone (no longer in the Inbox)
    pub reason: &'static str,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxAdd {
    pub added: Vec<AddedItem>,
    pub skipped: Vec<SkippedItem>,
}

/// The library item type a work's own type (OpenAlex, Crossref, a feed) is filed as.
pub fn item_type_of(work: &Json) -> &'static str {
    match text(work, "type").map(|t| t.to_lowercase()).as_deref() {
        Some("book" | "monograph" | "edited-book" | "reference-book") => "book",
        Some("book-chapter" | "chapter" | "book-section" | "book-part") => "chapter",
        Some("proceedings-article" | "conference-paper" | "paper-conference" | "proceedings") => "conference-paper",
        Some("report" | "report-component") => "report",
        Some("dissertation" | "thesis") => "thesis",
        Some("preprint" | "posted-content") => "preprint",
        Some("dataset") => "dataset",
        Some("software") => "software",
        _ => "article",
    }
}

fn year_of(work: &Json) -> Option<i64> {
    work.get("year")
        .and_then(|y| y.as_i64().or_else(|| y.as_str().and_then(|s| s.trim().parse().ok())))
        .or_else(|| text(work, "published").and_then(|p| p.get(..4).and_then(|y| y.parse().ok())))
        .filter(|y| (1000..=3000).contains(y))
}

fn authors_of(work: &Json) -> Vec<String> {
    work.get("authors").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str).map(str::trim).filter(|a| !a.is_empty()).map(String::from).collect()
}

fn is_retracted(work: &Json) -> bool {
    work.get("isRetracted").and_then(Json::as_bool).unwrap_or(false)
        || text(work, "type").is_some_and(|t| t.eq_ignore_ascii_case("retraction"))
        || text(work, "title").is_some_and(|t| {
            let t = t.to_lowercase();
            t.starts_with("retracted") || t.starts_with("retraction:") || t.starts_with("retraction note")
        })
}

fn is_open_access(work: &Json) -> bool {
    match work.get("openAccess") {
        Some(Json::Bool(b)) => *b,
        Some(Json::Object(o)) => o.get("isOa").or_else(|| o.get("is_oa")).and_then(Json::as_bool).unwrap_or(false),
        _ => text(work, "oaStatus").is_some_and(|s| s != "closed"),
    }
}

/// A work as a new library source: its bibliographic fields, authors and collections.
pub fn work_source_input(work: &Json, collections: Vec<String>) -> SourceInput {
    let mut fields = Map::new();
    for (from, to) in [("title", "title"), ("doi", "doi"), ("venue", "containerTitle"), ("abstract", "abstract"), ("landingUrl", "url")] {
        if let Some(v) = work.get(from).filter(|v| !v.is_null() && v.as_str() != Some("")) {
            fields.insert(to.into(), v.clone());
        }
    }
    if let Some(year) = year_of(work) {
        fields.insert("year".into(), json!(year));
    }
    if let Some(oa) = work.get("ids").and_then(|i| i.get("openalex")).and_then(Json::as_str).and_then(bare_openalex) {
        fields.insert("openalexId".into(), json!(oa));
    }
    if let Some(arxiv) = work.get("ids").and_then(|i| i.get("arxiv")).and_then(Json::as_str) {
        fields.insert("arxivId".into(), json!(arxiv));
    }
    if let Some(pmid) = work.get("ids").and_then(|i| i.get("pmid")).and_then(Json::as_str) {
        fields.insert("pmid".into(), json!(pmid));
    }
    fields.insert("itemType".into(), json!(item_type_of(work)));
    let creators = authors_of(work).iter().take(100).map(|a| creator_of(a)).collect();
    SourceInput { kind: "reference".into(), creators, fields, collections, index_status: Some("skipped".into()), ..Default::default() }
}

/// A work in the shape of a source (not stored), by the item's id: what citations and
/// BibTeX are made from for works not in the library.
pub fn work_source_json(item_id: &str, work: &Json) -> Json {
    let input = work_source_input(work, Vec::new());
    let mut out = input.fields;
    out.insert("id".into(), json!(item_id));
    out.insert("kind".into(), json!("reference"));
    out.insert("creators".into(), serde_json::to_value(&input.creators).unwrap_or(Json::Null));
    Json::Object(out)
}

/// Adds one to a case-insensitive tally, keeping the first spelling in sort order (as the
/// library's overview does), whatever order the items came in.
fn tally(counts: &mut HashMap<String, (String, i64)>, value: &str) {
    let entry = counts.entry(value.to_lowercase()).or_insert_with(|| (value.to_string(), 0));
    if value < entry.0.as_str() {
        entry.0 = value.to_string();
    }
    entry.1 += 1;
}

fn ranked(counts: HashMap<String, (String, i64)>) -> Vec<Count> {
    let mut list: Vec<Count> = counts.into_values().map(|(value, count)| Count { value, count }).collect();
    list.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.value.to_lowercase().cmp(&b.value.to_lowercase())));
    list
}

struct Row {
    id: String,
    work: Json,
    read: bool,
    saved: bool,
    source_id: Option<String>,
    mine: bool,
}

impl Store {
    fn inbox_rows(&self, ids: &[String]) -> Result<Vec<Row>> {
        let selected = serde_json::to_string(ids).map_err(e)?;
        let db = self.feeds_db()?;
        let mut statement = db
            .prepare(
                "SELECT i.id, i.work, i.read, i.saved, i.source_id, i.origin IS NOT NULL
                 FROM (SELECT DISTINCT value AS id FROM json_each(?1)) sel JOIN feed_items i ON i.id = sel.id",
            )
            .map_err(e)?;
        let rows = statement
            .query_map(params![selected], |r| {
                Ok(Row {
                    id: r.get(0)?,
                    work: serde_json::from_str(&r.get::<_, String>(1)?).unwrap_or(Json::Null),
                    read: r.get::<_, i64>(2)? != 0,
                    saved: r.get::<_, i64>(3)? != 0,
                    source_id: r.get(4)?,
                    mine: r.get::<_, i64>(5)? != 0,
                })
            })
            .map_err(e)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(e)
    }

    /// Of these sources an item became, the ones still in the library (not trashed; a merged
    /// one counts as its survivor).
    fn live_sources(&self, ids: &[String]) -> Result<HashMap<String, String>> {
        let mut out = HashMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let wanted = serde_json::to_string(ids).map_err(e)?;
        let merged: Vec<String> = {
            let db = self.read()?;
            let mut statement = db.prepare("SELECT s.id, s.merged_into IS NOT NULL FROM json_each(?1) w JOIN sources s ON s.id = w.value WHERE s.trashed_at IS NULL").map_err(e)?;
            let rows = statement.query_map(params![wanted], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))).map_err(e)?;
            let mut merged = Vec::new();
            for row in rows {
                let (id, was_merged) = row.map_err(e)?;
                if was_merged {
                    merged.push(id);
                } else {
                    out.insert(id.clone(), id);
                }
            }
            merged
        };
        for id in merged {
            let survivor = self.resolve_source_id(&id)?;
            if self.source(&survivor)?.is_some_and(|s| s.trashed_at.is_none()) {
                out.insert(id, survivor);
            }
        }
        Ok(out)
    }

    /// The library's match for each row: (certain source, possible source), by position.
    fn library_matches(&self, rows: &[&Row]) -> Result<Vec<(Option<String>, Option<String>)>> {
        let mut out = vec![(None, None); rows.len()];
        for (chunk_index, chunk) in rows.chunks(MATCH_CHUNK).enumerate() {
            crate::cancel::check()?;
            let queries: Vec<MatchQuery> = chunk.iter().enumerate().map(|(i, r)| match_query(&(chunk_index * MATCH_CHUNK + i).to_string(), &r.work)).collect();
            for hit in self.match_identifiers(&queries)? {
                let Some(slot) = hit.key.parse::<usize>().ok().and_then(|i| out.get_mut(i)) else { continue };
                if hit.certain {
                    slot.0.get_or_insert(hit.source_id);
                } else if slot.0.is_none() {
                    slot.1.get_or_insert(hit.source_id);
                }
            }
        }
        Ok(out)
    }

    /// The overview of these Inbox items for the selection panel.
    pub fn inbox_selection_overview(&self, ids: &[String]) -> Result<InboxOverview> {
        if ids.len() > MAX_SELECTION {
            return Err("Too many items".into());
        }
        let mut out = InboxOverview::default();
        if ids.is_empty() {
            return Ok(out);
        }
        let rows = self.inbox_rows(ids)?;
        out.total = rows.len() as i64;
        if rows.is_empty() {
            return Ok(out);
        }
        crate::cancel::check()?;

        let (mut types, mut authors, mut journals) = (HashMap::new(), HashMap::new(), HashMap::new());
        let mut years: HashMap<i64, i64> = HashMap::new();
        for row in &rows {
            let work = &row.work;
            tally(&mut types, item_type_of(work));
            if let Some(year) = year_of(work) {
                *years.entry(year).or_default() += 1;
            }
            let mut seen = HashSet::new();
            for author in authors_of(work) {
                if seen.insert(author.to_lowercase()) {
                    tally(&mut authors, &author);
                }
            }
            if let Some(venue) = text(work, "venue") {
                tally(&mut journals, &venue);
            }
            out.open_access += is_open_access(work) as i64;
            out.with_pdf_link += text(work, "pdfUrl").is_some() as i64;
            out.retracted += is_retracted(work) as i64;
            out.missing_doi += text(work, "doi").is_none() as i64;
            out.missing_abstract += text(work, "abstract").is_none() as i64;
            out.unread += !row.read as i64;
            out.saved += row.saved as i64;
            out.saved_by_you += row.mine as i64;
        }
        out.item_types = ranked(types);
        let authors = ranked(authors);
        out.author_count = authors.len() as i64;
        out.authors = authors.into_iter().take(TOP).collect();
        let journals = ranked(journals);
        out.journal_count = journals.len() as i64;
        out.journals = journals.into_iter().take(TOP).collect();
        let years: Vec<(i64, i64)> = years.into_iter().collect();
        out.years = year_histogram(&years, out.total);
        crate::cancel::check()?;

        // The feeds and alerts that brought them.
        {
            let selected = serde_json::to_string(&rows.iter().map(|r| &r.id).collect::<Vec<_>>()).map_err(e)?;
            let db = self.read()?;
            let mut statement = db
                .prepare(
                    "SELECT x.subscription_id, min(s.title), min(s.kind), count(*) FROM json_each(?1) sel
                     JOIN feed_item_subscriptions x ON x.item_id = sel.value JOIN feed_subscriptions s ON s.id = x.subscription_id
                     GROUP BY x.subscription_id",
                )
                .map_err(e)?;
            let found = statement
                .query_map(params![selected], |r| Ok(FeedCount { id: r.get(0)?, title: r.get(1)?, kind: r.get(2)?, count: r.get(3)? }))
                .map_err(e)?;
            for feed in found {
                out.feeds.push(feed.map_err(e)?);
            }
            out.feeds.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase())));
        }
        crate::cancel::check()?;

        // What the library has: what was added from here (and is still there), else the
        // identifier matcher (certain), else the duplicate engine by title (possible).
        let became: Vec<String> = rows.iter().filter_map(|r| r.source_id.clone()).collect();
        let live = self.live_sources(&became)?;
        let open: Vec<&Row> = rows.iter().filter(|r| !r.source_id.as_ref().is_some_and(|s| live.contains_key(s))).collect();
        for row in rows.iter().filter(|r| r.source_id.as_ref().is_some_and(|s| live.contains_key(s))) {
            out.in_library_ids.push(row.id.clone());
        }
        for (row, (certain, possible)) in open.iter().zip(self.library_matches(&open)?) {
            if certain.is_some() {
                out.in_library_ids.push(row.id.clone());
            } else if possible.is_some() {
                out.possible_ids.push(row.id.clone());
            }
        }
        out.in_library = out.in_library_ids.len() as i64;
        out.possibly_in_library = out.possible_ids.len() as i64;
        Ok(out)
    }

    /// These items as source-shaped works (not stored), for citations and BibTeX.
    pub fn inbox_works(&self, ids: &[String]) -> Result<Vec<Json>> {
        let rows = self.inbox_rows(&ids[..ids.len().min(5_000)])?;
        let order: HashMap<&String, usize> = ids.iter().enumerate().map(|(i, id)| (id, i)).collect();
        let mut rows: Vec<&Row> = rows.iter().collect();
        rows.sort_by_key(|r| order.get(&r.id).copied().unwrap_or(usize::MAX));
        Ok(rows.into_iter().map(|r| work_source_json(&r.id, &r.work)).collect())
    }

    /// Adds these items to the library, into `collections`, in one batch (at most `MAX_ADD`):
    /// one the library has already is skipped (and remembers that source), the others become
    /// sources from their metadata, go on the reading list and are marked read in the Inbox.
    /// Background batches pause for the user's own work between steps.
    pub fn add_inbox_items(&self, ids: &[String], collections: &[String]) -> Result<InboxAdd> {
        if ids.len() > MAX_ADD {
            return Err(format!("Add at most {MAX_ADD} at once").into());
        }
        let mut out = InboxAdd::default();
        crate::priority::yield_if_needed();
        let rows = self.inbox_rows(ids)?;
        let found: HashSet<&String> = rows.iter().map(|r| &r.id).collect();
        for id in ids.iter().filter(|id| !found.contains(id)) {
            out.skipped.push(SkippedItem { item_id: id.clone(), source_id: None, reason: "gone" });
        }
        let became: Vec<String> = rows.iter().filter_map(|r| r.source_id.clone()).collect();
        let live = self.live_sources(&became)?;
        let mut open = Vec::new();
        for row in &rows {
            match row.source_id.as_ref().and_then(|s| live.get(s)) {
                Some(source) => out.skipped.push(SkippedItem { item_id: row.id.clone(), source_id: Some(source.clone()), reason: "added" }),
                None => open.push(row),
            }
        }
        let matches = self.library_matches(&open)?;
        crate::priority::yield_if_needed();
        let mut fresh = Vec::new();
        let mut linked = Vec::new();
        for (row, (certain, _)) in open.iter().zip(matches) {
            match certain {
                Some(source) => {
                    linked.push((row.id.clone(), source.clone()));
                    out.skipped.push(SkippedItem { item_id: row.id.clone(), source_id: Some(source), reason: "library" });
                }
                None => fresh.push(*row),
            }
        }
        let inputs: Vec<SourceInput> = fresh.iter().map(|r| work_source_input(&r.work, collections.to_vec())).collect();
        let created = if inputs.is_empty() { Vec::new() } else { self.insert_sources(inputs)? };
        for (row, source_id) in fresh.iter().zip(created) {
            out.added.push(AddedItem { item_id: row.id.clone(), source_id });
        }
        {
            let db = self.db()?;
            let tx = db.unchecked_transaction().map_err(e)?;
            // What the library had already is remembered as well, so the Inbox says "In library".
            for (item, source) in out.added.iter().map(|a| (&a.item_id, &a.source_id)).chain(linked.iter().map(|(i, s)| (i, s))) {
                tx.execute("UPDATE feed_items SET source_id = ?2, read = 1 WHERE id = ?1", params![item, source]).map_err(e)?;
            }
            tx.commit().map_err(e)?;
        }
        if !out.added.is_empty() {
            let new: Vec<String> = out.added.iter().map(|a| a.source_id.clone()).collect();
            self.set_reading_status(&new, Some("unread"))?;
        }
        Ok(out)
    }

    /// Takes an add back: the sources it made go to the Trash, and the items are works not
    /// in the library again.
    pub fn undo_inbox_add(&self, added: &[AddedItem]) -> Result<usize> {
        if added.is_empty() {
            return Ok(0);
        }
        let sources: Vec<String> = added.iter().map(|a| a.source_id.clone()).collect();
        let trashed = self.trash(&sources, true)?;
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        for a in added {
            tx.execute("UPDATE feed_items SET source_id = NULL WHERE id = ?1 AND source_id = ?2", params![a.item_id, a.source_id]).map_err(e)?;
        }
        tx.commit().map_err(e)?;
        Ok(trashed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeds::{ItemQuery, SubscriptionInput};

    fn subscribe(store: &Store, title: &str, kind: &str) -> String {
        store
            .save_feed_subscription(&SubscriptionInput { kind: kind.into(), title: Some(title.into()), config: Some(json!({ "url": format!("https://x.org/{title}") }).as_object().unwrap().clone()), ..Default::default() })
            .unwrap()
            .id
    }

    fn ids_of(store: &Store) -> HashMap<String, String> {
        store.feed_items(&ItemQuery { limit: Some(500), ..Default::default() }).unwrap().items.into_iter().map(|i| (i.work["title"].as_str().unwrap().to_string(), i.id)).collect()
    }

    #[test]
    fn overview_counts_works_feeds_and_what_the_library_has() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let journal = subscribe(&store, "Journal of Growth", "rss");
        let alert = subscribe(&store, "Poverty alert", "openalex");
        store
            .insert_source(serde_json::from_value(json!({"kind": "reference", "title": "Already here by its DOI", "doi": "10.1/here", "year": 2020})).unwrap())
            .unwrap();
        store
            .insert_source(
                serde_json::from_value(json!({"kind": "reference", "title": "Cash transfers and child health in rural Kenya", "year": 2019, "creators": [{"family": "Haushofer", "given": "Johannes"}]}))
                    .unwrap(),
            )
            .unwrap();
        store
            .add_feed_items(
                &journal,
                &[
                    json!({"title": "Already here by its DOI", "doi": "10.1/here", "year": 2020, "authors": ["Jane Doe"], "venue": "Journal of Growth", "type": "article"}),
                    json!({"title": "Cash transfers and child health in rural Kenya", "year": 2019, "authors": ["Johannes Haushofer", "Jeremy Shapiro"], "venue": "journal of growth", "type": "article", "abstract": "A trial.", "openAccess": true, "pdfUrl": "https://x.org/a.pdf"}),
                    json!({"title": "A new preprint on poverty traps", "year": 2024, "authors": ["Jane Doe"], "type": "preprint", "doi": "10.1/new"}),
                ],
            )
            .unwrap();
        store
            .add_feed_items(&alert, &[json!({"title": "A new preprint on poverty traps", "year": 2024, "authors": ["Jane Doe"], "type": "preprint", "doi": "10.1/new"}), json!({"title": "Retracted: a flawed study of growth", "published": "2018-03-01"})])
            .unwrap();
        let ids = ids_of(&store);
        assert_eq!(ids.len(), 4);
        let all: Vec<String> = ids.values().cloned().chain(["gone".to_string()]).collect();
        let o = store.inbox_selection_overview(&all).unwrap();
        assert_eq!(o.total, 4);
        assert_eq!(o.item_types, vec![Count { value: "article".into(), count: 3 }, Count { value: "preprint".into(), count: 1 }]);
        assert_eq!((o.years.min, o.years.max, o.years.without), (Some(2018), Some(2024), 0));
        assert_eq!(o.authors[0], Count { value: "Jane Doe".into(), count: 2 });
        assert_eq!(o.author_count, 3);
        assert_eq!(o.journals, vec![Count { value: "Journal of Growth".into(), count: 2 }]);
        assert_eq!(o.feeds.iter().map(|f| (f.title.as_str(), f.count)).collect::<Vec<_>>(), [("Journal of Growth", 3), ("Poverty alert", 2)]);
        assert_eq!((o.open_access, o.with_pdf_link, o.retracted, o.missing_doi, o.missing_abstract, o.unread), (1, 1, 1, 2, 3, 4));
        assert_eq!(o.in_library, 1);
        assert_eq!(o.in_library_ids, vec![ids["Already here by its DOI"].clone()]);
        assert_eq!(o.possibly_in_library, 1, "same title, year and first author");
        assert_eq!(o.possible_ids, vec![ids["Cash transfers and child health in rural Kenya"].clone()]);
        assert_eq!(store.inbox_selection_overview(&[]).unwrap().total, 0);

        // Adding all: the one the library has is skipped and linked; the others become sources.
        let shelf = store.create_collection("Shelf", None, None).unwrap();
        let mut chosen: Vec<String> = ids.values().cloned().collect();
        chosen.sort();
        let added = store.add_inbox_items(&chosen, std::slice::from_ref(&shelf.id)).unwrap();
        assert_eq!(added.added.len(), 3);
        assert_eq!(added.skipped.iter().map(|s| (s.item_id.clone(), s.reason)).collect::<Vec<_>>(), [(ids["Already here by its DOI"].clone(), "library")]);
        let preprint = added.added.iter().find(|a| a.item_id == ids["A new preprint on poverty traps"]).unwrap();
        let source = store.source(&preprint.source_id).unwrap().unwrap();
        assert_eq!(source.collections, vec![shelf.id.clone()]);
        assert_eq!(source.fields["itemType"], json!("preprint"));
        assert_eq!(source.creators[0].family.as_deref(), Some("Doe"));
        let o = store.inbox_selection_overview(&chosen).unwrap();
        assert_eq!(o.in_library, 4);
        // Again: everything is skipped as added before.
        let again = store.add_inbox_items(&chosen, &[]).unwrap();
        assert!(again.added.is_empty());
        assert_eq!(again.skipped.len(), 4);
        // Undo: the sources made go to the Trash, the items are not in the library again.
        assert_eq!(store.undo_inbox_add(&added.added).unwrap(), 3);
        let o = store.inbox_selection_overview(&chosen).unwrap();
        assert_eq!(o.in_library, 1);
        let works = store.inbox_works(&chosen).unwrap();
        assert_eq!(works.len(), 4);
        assert_eq!(works[0]["id"], json!(chosen[0]));
    }

    #[test]
    fn overview_is_quick_with_thousands_selected() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        {
            let db = store.db().unwrap();
            let tx = db.unchecked_transaction().unwrap();
            for i in 0..5_000 {
                let input: SourceInput = serde_json::from_value(json!({
                    "kind": "reference", "title": format!("Library study number {i} of household income and health"), "year": 1990 + i % 30,
                    "doi": format!("10.5555/lib.{i}"), "creators": [{"family": format!("Author{}", i % 700), "role": "author"}],
                }))
                .unwrap();
                crate::insert_source_row(&tx, &format!("s{i:05}"), &input, 0).unwrap();
            }
            tx.commit().unwrap();
        }
        let feed = subscribe(&store, "Big feed", "rss");
        let works: Vec<Json> = (0..3_000)
            .map(|i| {
                // Every tenth is in the library by its DOI.
                let doi = if i % 10 == 0 { format!("10.5555/lib.{i}") } else { format!("10.7777/new.{i}") };
                json!({"title": format!("Inbox work {i} about trade, credit and migration"), "doi": doi, "year": 2000 + i % 25,
                       "authors": [format!("Writer {}", i % 300), format!("Second {}", i % 41)], "venue": format!("Journal {}", i % 50), "type": "article"})
            })
            .collect();
        for chunk in works.chunks(500) {
            store.add_feed_items(&feed, chunk).unwrap();
        }
        let ids: Vec<String> = store.read().unwrap().prepare("SELECT id FROM feed_items").unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(ids.len(), 3_000);
        let start = std::time::Instant::now();
        let o = store.inbox_selection_overview(&ids).unwrap();
        let took = start.elapsed();
        assert_eq!(o.total, 3_000);
        assert_eq!(o.in_library, 300);
        assert_eq!(o.journal_count, 50);
        assert_eq!(o.feeds[0].count, 3_000);
        // Debug build on a busy machine; release is several times faster.
        assert!(took.as_millis() < 5_000, "{took:?}");
        eprintln!("inbox overview of 3000: {took:?}");
    }
}
