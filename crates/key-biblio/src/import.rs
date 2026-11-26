// Putting parsed records into the library: a preview first (counts, the first rows with
// their fields, warnings, duplicates, files found), then the import itself in batches with
// progress, duplicate handling, files, notes, tags, groups as collections and pinned
// citation keys. Every import is journalled so it can be undone as a whole.
use crate::fields::{self, text};
use crate::{Format, Parsed, Record, Warning};
use key_store::duplicates::{MatchKind as EngineKind, Work};
use key_store::{ListQuery, Source, SourceInput, Store, citation_keys::fold_ascii};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

/// Rows the preview shows.
pub const PREVIEW_ROWS: usize = 20;
const BATCH: usize = 500;
const JOURNAL_PREFIX: &str = "biblio.import.";
const JOURNAL_LIST: &str = "biblio.imports";

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DuplicatePolicy {
    /// Skip entries whose identifier is already in the library; import possible ones, flagged.
    #[default]
    Skip,
    /// Fill the existing source's empty fields, add tags, notes and collections.
    Merge,
    /// Import everything.
    Keep,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportOptions {
    pub collection_ids: Vec<String>,
    pub duplicates: DuplicatePolicy,
    /// Make the file's groups collections (JabRef groups, …).
    pub groups: bool,
    pub files: bool,
    pub notes: bool,
    /// Where relative file paths start (the imported file's folder).
    pub base_dir: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MatchKind {
    Exact,
    Possible,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateMatch {
    pub source_id: String,
    pub kind: MatchKind,
    pub reason: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRow {
    pub line: usize,
    pub title: String,
    pub creators: String,
    pub year: Option<i64>,
    pub item_type: String,
    pub citation_key: Option<String>,
    /// Key fields this entry fills, then the kept ones (as `bibtex.note`).
    pub fields: Vec<String>,
    pub files: usize,
    pub notes: usize,
    pub duplicate: Option<DuplicateMatch>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub format: Format,
    pub format_label: String,
    pub total: usize,
    pub rows: Vec<PreviewRow>,
    /// How many entries fill each field.
    pub fields: Vec<(String, usize)>,
    pub warnings: Vec<Warning>,
    pub warning_count: usize,
    pub exact_duplicates: usize,
    pub possible_duplicates: usize,
    pub files_found: usize,
    pub files_missing: usize,
    pub notes: usize,
    pub groups: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub format: String,
    pub total: usize,
    pub added: usize,
    pub merged: usize,
    pub skipped: usize,
    /// Imported although a source looks like the same work: (line, title, existing id).
    pub flagged: Vec<(usize, String, String)>,
    pub skipped_rows: Vec<(usize, String, String)>,
    pub errors: Vec<Warning>,
    pub warnings: Vec<Warning>,
    pub files_attached: usize,
    pub files_missing: usize,
    pub notes_added: usize,
    pub collections_created: usize,
    pub created_ids: Vec<String>,
    pub undone: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub done: usize,
    pub total: usize,
}

/// What an import changed, to undo it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    id: String,
    at: i64,
    label: String,
    created: Vec<String>,
    /// Existing sources a merge changed, with the patch that puts them back.
    merged: Vec<(String, Map<String, Json>)>,
    memberships: Vec<(String, String)>,
    notes: Vec<String>,
    collections: Vec<String>,
    undone: bool,
    /// Its entry in the library's operations journal (⌘Z undoes the import there too).
    #[serde(default)]
    seq: Option<i64>,
}

// ── Duplicates ───────────────────────────────────────────────────────────────

/// Title, folded to lower-case letters and digits (the shared normaliser, spaces dropped).
pub fn title_key(title: &str) -> String {
    key_store::normalize::compact_title_key(&fold_ascii(title))
}

/// Records matched against each other (entries earlier in the same file, or the library)
/// with the store's duplicate engine: an identifier or identical file is exact; a likely
/// match, or a preprint and its published version, is possible.
#[derive(Default)]
pub struct DuplicateIndex {
    works: key_store::duplicates::WorkIndex,
    titles: HashMap<String, String>,
}

impl DuplicateIndex {
    pub fn build(store: &Store) -> Result<Self, String> {
        let mut index = Self::default();
        let mut offset = 0;
        loop {
            let page = store.list_sources(&ListQuery { offset, limit: Some(2000), ..Default::default() })?;
            for source in &page.items {
                index.add_source(source);
            }
            match page.next_offset {
                Some(next) => offset = next,
                None => break,
            }
        }
        Ok(index)
    }

    pub fn add_source(&mut self, source: &Source) {
        let input = SourceInput { creators: source.creators.clone(), fields: source.fields.clone(), ..Default::default() };
        let mut work = work(&input);
        work.title = Some(source.title().to_string());
        self.titles.insert(source.id.clone(), source.title().to_string());
        self.works.add(&source.id, &work);
    }

    pub fn add_input(&mut self, id: &str, input: &SourceInput) {
        self.titles.insert(id.to_string(), text(&input.fields, "title").unwrap_or("").to_string());
        self.works.add(id, &work(input));
    }

    /// The best match for a record.
    pub fn find(&self, input: &SourceInput) -> Option<DuplicateMatch> {
        let best = self.works.find(&work(input)).into_iter().next()?;
        let kind = if best.kind == EngineKind::Exact { MatchKind::Exact } else { MatchKind::Possible };
        let title = self.titles.get(&best.source_id).cloned().unwrap_or_default();
        Some(DuplicateMatch { source_id: best.source_id, kind, reason: best.reason, title })
    }
}

fn work(input: &SourceInput) -> Work {
    let t = |name: &str| text(&input.fields, name).map(String::from);
    Work {
        title: t("title"),
        year: input.fields.get("year").and_then(Json::as_i64),
        item_type: t("itemType"),
        doi: t("doi"),
        isbn: t("isbn"),
        pmid: t("pmid"),
        pmcid: t("pmcid"),
        arxiv_id: t("arxivId"),
        container_title: t("containerTitle"),
        edition: t("edition"),
        creators: input.creators.clone(),
        ..Default::default()
    }
}

/// The library's duplicates of records (the store's duplicate engine): an identifier match
/// is exact; a likely match, or a preprint and its published version, is possible.
pub fn find_duplicates(store: &Store, records: &[Record]) -> Result<Vec<Option<DuplicateMatch>>, String> {
    let works: Vec<Work> = records.iter().map(|r| work(&r.source)).collect();
    let mut titles: HashMap<String, String> = HashMap::new();
    let found = store.find_duplicates_for(&works)?;
    found
        .into_iter()
        .map(|matches| {
            let Some(best) = matches.into_iter().next() else { return Ok(None) };
            let title = match titles.get(&best.source_id) {
                Some(title) => title.clone(),
                None => {
                    let title = store.source(&best.source_id)?.map(|s| s.title().to_string()).unwrap_or_default();
                    titles.insert(best.source_id.clone(), title.clone());
                    title
                }
            };
            let kind = if best.kind == EngineKind::Exact { MatchKind::Exact } else { MatchKind::Possible };
            Ok(Some(DuplicateMatch { source_id: best.source_id, kind, reason: best.reason, title }))
        })
        .collect()
}

// ── Files ────────────────────────────────────────────────────────────────────

pub fn resolve_file(path: &str, base: Option<&Path>) -> Option<PathBuf> {
    let path = path.trim();
    if path.starts_with("http://") || path.starts_with("https://") || path.starts_with("internal-pdf://") {
        return None;
    }
    let path = path.strip_prefix("file://").unwrap_or(path);
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME").map(|home| PathBuf::from(home).join(rest))?,
        None => PathBuf::from(path),
    };
    let candidates = if expanded.is_absolute() { vec![expanded] } else { base.map(|b| vec![b.join(&expanded)]).unwrap_or_default() };
    candidates.into_iter().find(|p| p.is_file())
}

// ── Preview ──────────────────────────────────────────────────────────────────

fn creators_line(record: &Record) -> String {
    let names: Vec<String> = record.source.creators.iter().filter(|c| c.role == "author").map(|c| c.family.clone().or(c.literal.clone()).or(c.given.clone()).unwrap_or_default()).collect();
    match names.len() {
        0 => String::new(),
        1 => names[0].clone(),
        2 => format!("{} & {}", names[0], names[1]),
        _ => format!("{} et al.", names[0]),
    }
}

fn filled_fields(record: &Record) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if !record.source.creators.is_empty() {
        out.push("creators".into());
    }
    for name in fields::TEXT_COLUMNS {
        if text(&record.source.fields, name).is_some() {
            out.push((*name).into());
        }
    }
    if !record.source.tags.is_empty() {
        out.push("tags".into());
    }
    let mut kept: Vec<String> = record.source.properties.keys().cloned().collect();
    kept.sort();
    out.extend(kept);
    out
}

pub fn preview(store: &Store, parsed: &Parsed, options: &ImportOptions) -> Result<Preview, String> {
    // The library's duplicates, then earlier entries of the same file.
    let library = find_duplicates(store, &parsed.records)?;
    let mut seen = DuplicateIndex::default();
    let matches: Vec<Option<DuplicateMatch>> = parsed
        .records
        .iter()
        .zip(library)
        .enumerate()
        .map(|(i, (record, found))| {
            let found = found.or_else(|| seen.find(&record.source));
            seen.add_input(&format!("#{i}"), &record.source);
            found
        })
        .collect();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let (mut found, mut missing, mut notes) = (0, 0, 0);
    let mut groups: Vec<String> = Vec::new();
    for record in &parsed.records {
        for field in filled_fields(record) {
            *counts.entry(field).or_default() += 1;
        }
        for file in &record.files {
            if resolve_file(file, options.base_dir.as_deref()).is_some() {
                found += 1;
            } else {
                missing += 1;
            }
        }
        notes += record.notes.len();
        for group in &record.groups {
            let name = group.join(" › ");
            if !groups.contains(&name) {
                groups.push(name);
            }
        }
    }
    let rows = parsed
        .records
        .iter()
        .zip(&matches)
        .take(PREVIEW_ROWS)
        .map(|(r, m)| PreviewRow {
            line: r.line,
            title: r.title().to_string(),
            creators: creators_line(r),
            year: r.source.fields.get("year").and_then(Json::as_i64),
            item_type: text(&r.source.fields, "itemType").unwrap_or("document").to_string(),
            citation_key: r.citation_key().map(String::from),
            fields: filled_fields(r),
            files: r.files.len(),
            notes: r.notes.len(),
            duplicate: m.clone(),
        })
        .collect();
    let mut fields: Vec<(String, usize)> = counts.into_iter().collect();
    fields.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    Ok(Preview {
        format: parsed.format,
        format_label: parsed.format.label().into(),
        total: parsed.records.len(),
        rows,
        fields,
        warning_count: parsed.warnings.len(),
        warnings: parsed.warnings.iter().take(50).cloned().collect(),
        exact_duplicates: matches.iter().flatten().filter(|m| m.kind == MatchKind::Exact).count(),
        possible_duplicates: matches.iter().flatten().filter(|m| m.kind == MatchKind::Possible).count(),
        files_found: found,
        files_missing: missing,
        notes,
        groups,
    })
}

// ── Import ───────────────────────────────────────────────────────────────────

fn note_title(body: &str) -> String {
    let first = body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Imported note");
    let mut title: String = first.chars().take(80).collect();
    if first.chars().count() > 80 {
        title.push('…');
    }
    title
}

/// A collection path's id, created when missing (ids it created are added to `created`).
fn collection_for(store: &Store, path: &[String], known: &mut HashMap<(Option<String>, String), String>, created: &mut Vec<String>) -> Result<Option<String>, String> {
    let mut parent: Option<String> = None;
    for name in path {
        let key = (parent.clone(), name.to_lowercase());
        let id = match known.get(&key) {
            Some(id) => id.clone(),
            None => {
                let collection = store.create_collection(name, parent.as_deref(), None)?;
                created.push(collection.id.clone());
                known.insert(key, collection.id.clone());
                collection.id
            }
        };
        parent = Some(id);
    }
    Ok(parent)
}

/// Only what the existing source lacks: empty fields, new tags.
fn merge_patch(existing: &Source, input: &SourceInput) -> (Map<String, Json>, Map<String, Json>) {
    let mut patch = Map::new();
    let mut undo = Map::new();
    for (name, value) in &input.fields {
        if matches!(name.as_str(), "itemType" | "citationKey") || value.is_null() {
            continue;
        }
        let empty = existing.fields.get(name).is_none_or(|v| v.is_null() || v.as_str().is_some_and(str::is_empty));
        if empty {
            patch.insert(name.clone(), value.clone());
            undo.insert(name.clone(), Json::Null);
        }
    }
    if existing.creators.is_empty() && !input.creators.is_empty() {
        patch.insert("creators".into(), serde_json::to_value(&input.creators).unwrap_or_default());
        undo.insert("creators".into(), json!([]));
    }
    let mut tags = existing.tags.clone();
    for tag in &input.tags {
        if !tags.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
            tags.push(tag.clone());
        }
    }
    if tags.len() != existing.tags.len() {
        patch.insert("tags".into(), json!(tags));
        undo.insert("tags".into(), json!(existing.tags));
    }
    let mut properties = Map::new();
    let mut undo_properties = Map::new();
    for (name, value) in &input.properties {
        if !existing.properties.contains_key(name) {
            properties.insert(name.clone(), value.clone());
            undo_properties.insert(name.clone(), Json::Null);
        }
    }
    if !properties.is_empty() {
        patch.insert("properties".into(), Json::Object(properties));
        undo.insert("properties".into(), Json::Object(undo_properties));
    }
    (patch, undo)
}

/// Imports parsed records. `attach(source_id, path)` links a file to a new source
/// (the host hashes, classifies and queues it for indexing).
pub fn run(
    store: &Store,
    parsed: Parsed,
    options: &ImportOptions,
    label: &str,
    progress: &dyn Fn(Progress),
    attach: &dyn Fn(&str, &Path) -> Result<(), String>,
) -> Result<Report, String> {
    let total = parsed.records.len();
    let journal_id = key_store::new_id();
    let mut report = Report { id: journal_id.clone(), format: parsed.format.label().into(), total, warnings: parsed.warnings.clone(), ..Default::default() };
    let mut journal = Journal { id: journal_id.clone(), at: key_store::now_ms(), label: label.into(), ..Default::default() };
    progress(Progress { stage: "Checking for duplicates".into(), done: 0, total });
    let library = find_duplicates(store, &parsed.records)?;
    // Entries imported earlier in this run, for duplicates within the file.
    let mut index = DuplicateIndex::default();
    let mut position = 0;
    // Collections the file's groups name (existing ones are reused).
    let mut known: HashMap<(Option<String>, String), String> =
        store.collections()?.into_iter().map(|c| ((c.parent_id.clone(), c.name.to_lowercase()), c.id)).collect();

    let mut records = parsed.records;
    let mut done = 0;
    while !records.is_empty() {
        let batch: Vec<Record> = records.drain(..records.len().min(BATCH)).collect();
        let mut inputs: Vec<SourceInput> = Vec::new();
        let mut kept: Vec<Record> = Vec::new();
        for mut record in batch {
            let duplicate = library.get(position).cloned().flatten().or_else(|| index.find(&record.source));
            position += 1;
            match (&duplicate, options.duplicates) {
                (Some(m), DuplicatePolicy::Skip) if m.kind == MatchKind::Exact => {
                    report.skipped += 1;
                    report.skipped_rows.push((record.line, record.title().to_string(), m.reason.clone()));
                    continue;
                }
                (Some(m), DuplicatePolicy::Merge) if m.kind == MatchKind::Exact => {
                    let Some(existing) = store.source(&m.source_id)? else { continue };
                    let (patch, undo) = merge_patch(&existing, &record.source);
                    if !patch.is_empty() {
                        store.update_source(&existing.id, &patch)?;
                        journal.merged.push((existing.id.clone(), undo));
                    }
                    for collection in &options.collection_ids {
                        if !existing.collections.contains(collection) {
                            store.set_membership(collection, std::slice::from_ref(&existing.id), true)?;
                            journal.memberships.push((collection.clone(), existing.id.clone()));
                        }
                    }
                    if options.notes {
                        for body in &record.notes {
                            let note = store.save_note(None, Some(&existing.id), &note_title(body), body, None)?;
                            journal.notes.push(note.id);
                            report.notes_added += 1;
                        }
                    }
                    report.merged += 1;
                    continue;
                }
                (Some(m), _) if m.kind == MatchKind::Possible => {
                    report.flagged.push((record.line, record.title().to_string(), m.source_id.clone()));
                }
                _ => {}
            }
            let mut collections = options.collection_ids.clone();
            if options.groups {
                for group in &record.groups {
                    if let Some(id) = collection_for(store, group, &mut known, &mut journal.collections)? {
                        collections.push(id);
                    }
                }
            }
            collections.dedup();
            record.source.collections = collections;
            record.source.origin = None;
            if !options.files {
                record.files.clear();
            }
            // Keys are claimed after the insert, so two entries with one key get a suffix.
            let mut input = record.source.clone();
            input.fields.remove("citationKey");
            inputs.push(input);
            kept.push(record);
        }
        let ids = store.insert_sources(inputs)?;
        let wanted: Vec<(String, String)> = ids.iter().zip(&kept).filter_map(|(id, r)| r.citation_key().map(|k| (id.clone(), k.to_string()))).collect();
        let claimed = store.claim_citation_keys(&wanted)?;
        let lines: HashMap<&str, usize> = ids.iter().zip(&kept).map(|(id, r)| (id.as_str(), r.line)).collect();
        for ((id, key), claimed) in wanted.iter().zip(claimed) {
            let line = lines.get(id.as_str()).copied().unwrap_or(0);
            match claimed {
                Ok(claimed) if &claimed != key => report.warnings.push(Warning { line, message: format!("The key “{key}” at line {line} was taken; the entry was imported as “{claimed}”") }),
                Ok(_) => {}
                Err(error) => report.warnings.push(Warning { line, message: error }),
            }
        }
        for (id, record) in ids.iter().zip(&kept) {
            journal.created.push(id.clone());
            index.add_input(id, &record.source);
            if options.notes {
                for body in &record.notes {
                    let note = store.save_note(None, Some(id), &note_title(body), body, None)?;
                    journal.notes.push(note.id);
                    report.notes_added += 1;
                }
            }
            let mut attached = false;
            for file in &record.files {
                match resolve_file(file, options.base_dir.as_deref()) {
                    Some(path) if !attached => match attach(id, &path) {
                        Ok(()) => {
                            attached = true;
                            report.files_attached += 1;
                        }
                        Err(error) => report.errors.push(Warning { line: record.line, message: format!("{}: {error}", path.display()) }),
                    },
                    Some(path) => {
                        // Key keeps one file per source; the others stay listed.
                        let mut patch = Map::new();
                        patch.insert("properties".into(), json!({ "import.otherFiles": path.to_string_lossy() }));
                        store.update_source(id, &patch)?;
                    }
                    None => {
                        report.files_missing += 1;
                        if !file.starts_with("http") {
                            report.warnings.push(Warning { line: record.line, message: format!("File not found: {file}") });
                        }
                    }
                }
            }
        }
        report.added += ids.len();
        done += kept.len();
        progress(Progress { stage: "Importing".into(), done: report.added + report.merged + report.skipped, total });
        let _ = done;
    }
    // Kept fields stay plain properties of the sources that have them: no library-wide
    // definition, so other sources do not show empty rows for them.
    progress(Progress { stage: "Creating citation keys".into(), done: total, total });
    store.ensure_citation_keys()?;
    report.collections_created = journal.collections.len();
    report.created_ids = journal.created.clone();
    journal.seq = record_in_journal(store, &journal)?;
    save_journal(store, &journal, &report)?;
    Ok(report)
}

/// One entry in the operations journal for the whole import: undo moves the new sources to
/// the Trash and takes back merges, notes, filings and new collections; redo brings them back.
fn record_in_journal(store: &Store, journal: &Journal) -> Result<Option<i64>, String> {
    let mut changed: BTreeMap<String, Map<String, Json>> = BTreeMap::new();
    for (id, undo) in &journal.merged {
        changed.entry(id.clone()).or_default().extend(undo.clone());
    }
    for (collection, id) in &journal.memberships {
        let undo = changed.entry(id.clone()).or_default();
        let mut gone = undo.remove("collectionsRemove").and_then(|v| v.as_array().cloned()).unwrap_or_default();
        gone.push(Json::from(collection.clone()));
        undo.insert("collectionsRemove".into(), Json::Array(gone));
    }
    let rows = [("collections", "id", journal.collections.clone()), ("source_collections", "source_id", journal.created.clone()), ("notes", "id", journal.notes.clone())];
    let label = if journal.label.is_empty() { "Import".to_string() } else { format!("Import {}", journal.label) };
    let entry = store.journal_added("import", &label, &journal.created, &rows, &changed.into_iter().collect::<Vec<_>>())?;
    Ok(entry.map(|e| e.seq))
}

fn save_journal(store: &Store, journal: &Journal, report: &Report) -> Result<(), String> {
    let mut summary = report.clone();
    summary.created_ids.clear();
    store.set_meta(&format!("{JOURNAL_PREFIX}{}", journal.id), &serde_json::to_string(&json!({ "journal": journal, "report": summary })).map_err(|e| e.to_string())?)?;
    let mut list: Vec<String> = store.meta(JOURNAL_LIST)?.and_then(|l| serde_json::from_str(&l).ok()).unwrap_or_default();
    list.retain(|id| id != &journal.id);
    list.push(journal.id.clone());
    // Older journals than the last 20 are let go.
    while list.len() > 20 {
        let old = list.remove(0);
        store.set_meta(&format!("{JOURNAL_PREFIX}{old}"), "{}")?;
    }
    store.set_meta(JOURNAL_LIST, &serde_json::to_string(&list).map_err(|e| e.to_string())?)
}

/// The latest imports, newest first.
pub fn history(store: &Store) -> Result<Vec<Report>, String> {
    let list: Vec<String> = store.meta(JOURNAL_LIST)?.and_then(|l| serde_json::from_str(&l).ok()).unwrap_or_default();
    let mut out = Vec::new();
    for id in list.iter().rev() {
        let Some(value) = store.meta(&format!("{JOURNAL_PREFIX}{id}"))?.and_then(|v| serde_json::from_str::<Json>(&v).ok()) else { continue };
        if let Some(mut report) = value.get("report").and_then(|r| serde_json::from_value::<Report>(r.clone()).ok()) {
            // Undone or redone with ⌘Z in the library since.
            let seq = value.get("journal").and_then(|j| j.get("seq")).and_then(Json::as_i64);
            if let Some((_, undone)) = seq.map(|s| store.journal_entry(s)).transpose()?.flatten() {
                report.undone = undone;
            }
            out.push(report);
        }
    }
    Ok(out)
}

/// Undoes an import through the operations journal (its new sources go to the Trash);
/// an import too old for the journal: its new sources (and their notes) are deleted, merged sources put
/// back, collections it created removed when nothing else is in them.
pub fn undo(store: &Store, id: &str) -> Result<Report, String> {
    let key = format!("{JOURNAL_PREFIX}{id}");
    let value: Json = store.meta(&key)?.and_then(|v| serde_json::from_str(&v).ok()).ok_or("That import can no longer be undone")?;
    let mut journal: Journal = serde_json::from_value(value.get("journal").cloned().unwrap_or_default()).map_err(|_| "That import can no longer be undone")?;
    let mut report: Report = serde_json::from_value(value.get("report").cloned().unwrap_or_default()).unwrap_or_default();
    if journal.undone {
        return Err("That import was already undone".into());
    }
    if let Some(seq) = journal.seq {
        match store.journal_entry(seq)? {
            Some((_, true)) => return Err("That import was already undone".into()),
            Some((_, false)) => {
                store.undo_entry(seq)?;
                journal.undone = true;
                report.undone = true;
                store.set_meta(&key, &serde_json::to_string(&json!({ "journal": journal, "report": report })).map_err(|e| e.to_string())?)?;
                return Ok(report);
            }
            // Gone from the journal (too old): undone the way it was recorded here.
            None => {}
        }
    }
    for note in &journal.notes {
        let _ = store.delete_note(note);
    }
    for chunk in journal.created.chunks(500) {
        store.delete(chunk)?;
    }
    for (source, patch) in &journal.merged {
        if store.source(source)?.is_some() {
            store.update_source(source, patch)?;
        }
    }
    for (collection, source) in &journal.memberships {
        let _ = store.set_membership(collection, std::slice::from_ref(source), false);
    }
    for collection in journal.collections.iter().rev() {
        let empty = store.list_sources(&ListQuery { collection_id: Some(collection.clone()), scope: Some("all".into()), limit: Some(1), ..Default::default() })?.total == 0
            && store.list_sources(&ListQuery { collection_id: Some(collection.clone()), scope: Some("trashed".into()), limit: Some(1), ..Default::default() })?.total == 0;
        if empty {
            store.delete_collection(collection)?;
        }
    }
    journal.undone = true;
    report.undone = true;
    store.set_meta(&key, &serde_json::to_string(&json!({ "journal": journal, "report": report })).map_err(|e| e.to_string())?)?;
    Ok(report)
}

/// Reads a file or pasted text into records, picking the format when it is not given.
pub fn read(text: &str, file_name: Option<&str>, format: Option<Format>, progress: &dyn Fn(usize, usize)) -> Result<Parsed, String> {
    let format = format.or_else(|| crate::detect(text, file_name)).ok_or("Key could not tell the format. Choose BibTeX, RIS, CSL-JSON, CSV or EndNote XML.")?;
    crate::parse(text, format, progress)
}
