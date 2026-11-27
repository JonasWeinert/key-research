// Managing a review's records: remove and restore by hand, edit metadata, group reports of one
// study, every duplicate decision with its reason, filling missing abstracts (and DOI, PMID,
// year, journal) from the record's duplicates, then the library, then open lookups — each with
// where it came from — and full texts kept with the review: matching dropped PDFs to records,
// and a CSV of records still needing one, filled in with file names.
use crate::derive::{FileRef, RecState, State, Status};
use crate::events::Event;
use crate::import::work;
use crate::model::*;
use crate::ops::Library;
use crate::store::{Result, Reviews, metas};
use key_store::duplicates::compare;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};
use std::collections::{BTreeMap, HashMap, HashSet};

/// The fields missing values are filled for, in the order they are looked at.
pub const FILLABLE: &[&str] = &["abstractText", "doi", "pmid", "year", "journal", "volume", "issue", "pages", "language"];

pub fn field_value(meta: &RecordMeta, field: &str) -> Option<Json> {
    let text = |s: &str| (!s.trim().is_empty()).then(|| json!(s.trim()));
    match field {
        "abstractText" => text(&meta.abstract_text),
        "doi" => text(&meta.doi),
        "pmid" => text(&meta.pmid),
        "year" => meta.year.map(Json::from),
        "journal" => text(&meta.journal),
        "volume" => text(&meta.volume),
        "issue" => text(&meta.issue),
        "pages" => text(&meta.pages),
        "language" => text(&meta.language),
        "title" => text(&meta.title),
        _ => None,
    }
}

/// Applies edited fields to a record's metadata (the store does this to its row).
pub fn apply_fields(meta: &mut RecordMeta, fields: &Map<String, Json>) {
    for (k, v) in fields {
        let s = || v.as_str().unwrap_or("").to_string();
        match k.as_str() {
            "title" => meta.title = s(),
            "abstractText" => meta.abstract_text = s(),
            "authors" => meta.authors = v.as_array().map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect()).unwrap_or_default(),
            "year" => meta.year = v.as_i64().or_else(|| v.as_str().and_then(|t| t.trim().parse().ok())),
            "journal" => meta.journal = s(),
            "volume" => meta.volume = s(),
            "issue" => meta.issue = s(),
            "pages" => meta.pages = s(),
            "doi" => meta.doi = s(),
            "pmid" => meta.pmid = s(),
            "url" => meta.url = s(),
            "itemType" => meta.item_type = s(),
            "language" => meta.language = s(),
            "keywords" => meta.keywords = v.as_array().map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect()).unwrap_or_default(),
            _ => {
                meta.extra.insert(k.clone(), v.clone());
            }
        }
    }
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FillReport {
    /// Missing values filled, by field.
    pub filled: BTreeMap<String, usize>,
    /// Records still without an abstract.
    pub still_missing: usize,
    /// Records the open lookups may still help (have a DOI or PMID).
    pub lookup_candidates: Vec<String>,
}

/// One file the reviewer dropped, as the reader saw it (its name, PDF metadata title, the DOI
/// and the opening text of its first pages).
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub title: String,
    pub doi: String,
    pub text: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub file: String,
    pub path: String,
    pub record: Option<String>,
    pub score: f64,
    /// confident | uncertain | unmatched
    pub level: String,
    pub why: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CsvRow {
    pub line: usize,
    pub record: String,
    pub file: String,
    pub path: Option<String>,
    /// ok | error | skipped
    pub state: String,
    pub message: String,
}

fn normalize(text: &str) -> String {
    text.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn bare_doi(text: &str) -> String {
    key_store::normalize::doi(text).unwrap_or_default().to_lowercase()
}

/// How well a dropped file is this record, and why.
pub fn file_score(meta: &RecordMeta, file: &DroppedFile) -> (f64, String) {
    let doi = bare_doi(&meta.doi);
    let text = normalize(&format!("{} {} {}", file.title, file.text, file.name));
    if !doi.is_empty() && (bare_doi(&file.doi) == doi || file.text.to_lowercase().contains(&doi) || file.name.to_lowercase().replace(['_', ' '], "/").contains(&doi.replace('_', "/"))) {
        return (1.0, format!("DOI {doi}"));
    }
    let title = normalize(&meta.title);
    if title.len() < 12 {
        return (0.0, String::new());
    }
    let mut score;
    let mut why;
    if text.contains(&title) {
        score = 0.9;
        why = "the title".to_string();
    } else {
        let words: Vec<&str> = title.split(' ').filter(|w| w.len() > 3).collect();
        let found = words.iter().filter(|w| text.split(' ').any(|t| t == **w)).count();
        score = if words.is_empty() { 0.0 } else { 0.75 * found as f64 / words.len() as f64 };
        why = format!("{found} of {} title words", words.len());
    }
    if let Some(first) = meta.authors.first() {
        let family = normalize(first.split(',').next().unwrap_or(first));
        if family.len() > 2 && text.split(' ').any(|t| t == family) {
            score += 0.07;
            why.push_str(", the first author");
        }
    }
    if let Some(y) = meta.year {
        if text.contains(&y.to_string()) {
            score += 0.03;
            why.push_str(", the year");
        }
    }
    (score.min(0.99), why)
}

/// Each dropped file's best record among `records` (those still needing a full text): confident
/// at 0.85 or more and clearly ahead of the next, uncertain from 0.5, else unmatched. A record
/// goes to one file at most (the best).
pub fn match_files(records: &[RecordMeta], files: &[DroppedFile]) -> Vec<Proposal> {
    let mut proposals: Vec<Proposal> = Vec::new();
    let mut taken: HashMap<String, (usize, f64)> = HashMap::new();
    for file in files {
        let mut scored: Vec<(f64, &RecordMeta, String)> = records.iter().map(|m| {
            let (s, why) = file_score(m, file);
            (s, m, why)
        }).filter(|x| x.0 > 0.0).collect();
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        let best = scored.first();
        let second = scored.get(1).map(|x| x.0).unwrap_or(0.0);
        let p = match best {
            Some((s, m, why)) if *s >= 0.5 => Proposal {
                file: file.name.clone(),
                path: file.path.clone(),
                record: Some(m.id.clone()),
                score: *s,
                level: if *s >= 0.85 && s - second > 0.1 { "confident".into() } else { "uncertain".into() },
                why: format!("Matched on {why}"),
            },
            _ => Proposal { file: file.name.clone(), path: file.path.clone(), record: None, score: 0.0, level: "unmatched".into(), why: "No record matches its DOI, title or authors".into() },
        };
        if let Some(r) = &p.record {
            if let Some((other, other_score)) = taken.get(r).copied() {
                if other_score >= p.score {
                    proposals.push(Proposal { level: "uncertain".into(), why: format!("{} (another file matches the same record better)", p.why), ..p });
                    continue;
                }
                proposals[other].level = "uncertain".into();
                proposals[other].why.push_str(" (another file matches the same record better)");
            }
            taken.insert(r.clone(), (proposals.len(), p.score));
        }
        proposals.push(p);
    }
    proposals
}

fn csv_cell(s: &str) -> String {
    crate::export::csv_cell(s)
}

/// Splits one CSV line (quotes and doubled quotes).
pub fn csv_fields(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' | ';' if !quoted => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out.into_iter().map(|s| s.trim().to_string()).collect()
}

/// The CSV a reviewer fills in: the records still needing a full text, with an empty filename
/// column.
pub fn fulltext_csv(state: &State, all: &HashMap<String, RecordMeta>) -> String {
    let mut out = String::from("record_id,title,first_author,year,doi,filename\n");
    for r in needing_full_text(state) {
        let Some(m) = all.get(&r.id) else { continue };
        let first = m.authors.first().cloned().unwrap_or_default();
        out.push_str(&[csv_cell(&m.id), csv_cell(&m.title), csv_cell(&first), m.year.map(|y| y.to_string()).unwrap_or_default(), csv_cell(&m.doi), String::new()].join(","));
        out.push('\n');
    }
    out
}

/// The filled-in CSV read against the uploaded files: one result per row, with a plain error
/// when something does not fit.
pub fn read_fulltext_csv(state: &State, text: &str, files: &[DroppedFile]) -> Vec<CsvRow> {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    let head = csv_fields(lines.next().unwrap_or(""));
    let col = |name: &str| head.iter().position(|h| h.eq_ignore_ascii_case(name));
    let (Some(id_col), Some(file_col)) = (col("record_id"), col("filename")) else {
        return vec![CsvRow { line: 1, record: String::new(), file: String::new(), path: None, state: "error".into(), message: "The first row needs the columns record_id and filename (download the CSV from Key and fill in its filename column)".into() }];
    };
    let by_name: HashMap<String, &DroppedFile> = files.iter().map(|f| (f.name.to_lowercase(), f)).collect();
    let mut used: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for (i, line) in lines.enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let cells = csv_fields(line);
        let record = cells.get(id_col).cloned().unwrap_or_default();
        let file = cells.get(file_col).cloned().unwrap_or_default();
        let row = |state: &str, message: String, path: Option<String>| CsvRow { line: i + 2, record: record.clone(), file: file.clone(), path, state: state.into(), message };
        if file.is_empty() {
            out.push(row("skipped", "No file name: left for later".into(), None));
            continue;
        }
        let Some(r) = state.record(&record) else {
            out.push(row("error", format!("No record with the id “{record}” in this review"), None));
            continue;
        };
        if !state.eligible(r, Stage::Ft) {
            out.push(row("error", "This record is not at full-text screening".into(), None));
            continue;
        }
        let name = std::path::Path::new(&file).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        match by_name.get(&name) {
            None => out.push(row("error", format!("“{file}” was not among the files uploaded"), None)),
            Some(_) if !used.insert(name.clone()) => out.push(row("error", format!("“{file}” is named for another record too"), None)),
            Some(f) => out.push(row("ok", "Ready to attach".into(), Some(f.path.clone()))),
        }
    }
    out
}

/// Records at full text with no full text yet (and not marked not retrieved).
pub fn needing_full_text(state: &State) -> Vec<&RecState> {
    state
        .records
        .iter()
        .filter(|r| state.eligible(r, Stage::Ft) && !r.has_full_text() && r.fulltext.status != "notRetrieved" && !matches!(state.status(r, Stage::Ft), Status::Final { .. }))
        .collect()
}

impl Reviews {
    pub fn remove_records(&self, review: &str, ids: &[String], removed: bool, reason: &str, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            for id in ids {
                state.record(id).ok_or("This record no longer exists")?;
            }
            let reason = if reason.trim().is_empty() { "Removed by hand" } else { reason.trim() };
            Ok((vec![b.event("record.remove", actor, None, json!({ "recordIds": ids, "removed": removed, "reason": reason }))], ()))
        })
    }

    /// Corrects a record's metadata (the import's values stay in the log).
    pub fn edit_record(&self, review: &str, record: &str, fields: Map<String, Json>, actor: &str) -> Result<()> {
        if fields.is_empty() {
            return Ok(());
        }
        self.write(review, |state, _, b| {
            state.record(record).ok_or("This record no longer exists")?;
            if fields.get("title").is_some_and(|t| t.as_str().is_none_or(|s| s.trim().is_empty())) {
                return Err("A record needs a title".into());
            }
            Ok((vec![b.event("record.edit", actor, Some(record), json!({ "fields": fields }))], ()))
        })
    }

    /// Marks `record` as another report of the study `study_of` is (None: its own study again).
    pub fn link_study(&self, review: &str, record: &str, study_of: Option<&str>, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            state.record(record).ok_or("This record no longer exists")?;
            if let Some(of) = study_of {
                let root = state.record(of).ok_or("That record no longer exists")?;
                let root_id = root.study_of.clone().unwrap_or_else(|| of.to_string());
                if root_id == record {
                    return Err("A record cannot be a report of itself".into());
                }
                return Ok((vec![b.event("study.link", actor, Some(record), json!({ "studyOf": root_id }))], ()));
            }
            Ok((vec![b.event("study.link", actor, Some(record), json!({ "studyOf": null }))], ()))
        })
    }

    /// Every duplicate decision: automatic and by hand, the record kept, why they matched.
    pub fn duplicates(&self, review: &str) -> Result<Json> {
        self.read(review, |state, conn| {
            let dups: Vec<&RecState> = state.records.iter().filter(|r| r.dup_of.is_some() && !state.removed_batches.contains(&r.batch)).collect();
            let mut ids: Vec<String> = dups.iter().map(|r| r.id.clone()).collect();
            ids.extend(dups.iter().filter_map(|r| r.dup_of.clone()));
            let m = metas(conn, review, &ids)?;
            // Grouped by the record kept.
            let mut groups: BTreeMap<String, Vec<Json>> = BTreeMap::new();
            for r in &dups {
                let kept = r.dup_of.clone().unwrap();
                let why = if !r.dup_reason.is_empty() {
                    r.dup_reason.clone()
                } else if let (Some(a), Some(b)) = (m.get(&r.id), m.get(&kept)) {
                    compare(&work(a), &work(b)).map(|v| v.reason).unwrap_or_else(|| "Marked by hand".into())
                } else {
                    String::new()
                };
                groups.entry(kept).or_default().push(json!({
                    "record": m.get(&r.id), "batch": state.batch(&r.batch).map(|b| b.name.clone()), "auto": r.dup_auto, "why": why,
                    "by": state.member_name(&r.dup_by), "at": r.dup_at,
                }));
            }
            let rows: Vec<Json> = groups
                .into_iter()
                .map(|(kept, merged)| {
                    let k = state.record(&kept);
                    json!({ "kept": m.get(&kept), "keptBatch": k.and_then(|r| state.batch(&r.batch)).map(|b| b.name.clone()), "keptActive": k.is_some_and(|r| state.active(r)), "merged": merged })
                })
                .collect();
            Ok(json!({ "groups": rows, "pairsToCheck": state.open_pairs().len() }))
        })
    }

    /// Fills missing values from the record's duplicates (every record in its duplicate group,
    /// any import), then from the library when it holds the same work. Each value notes where it
    /// came from. Answers what was filled and which records the open lookups may still help.
    pub fn fill_missing(&self, review: &str, library: &dyn Library, actor: &str) -> Result<FillReport> {
        self.write(review, |state, conn, b| {
            let all: Vec<String> = state.records.iter().map(|r| r.id.clone()).collect();
            let m = metas(conn, review, &all)?;
            // Duplicate groups: each record with the one it was merged into, both ways.
            let mut group: HashMap<String, Vec<String>> = HashMap::new();
            for r in &state.records {
                if let Some(of) = &r.dup_of {
                    group.entry(of.clone()).or_default().push(r.id.clone());
                    group.entry(r.id.clone()).or_default().push(of.clone());
                }
            }
            let mut report = FillReport::default();
            let mut events = Vec::new();
            for r in state.records.iter().filter(|r| state.active(r)) {
                let Some(meta) = m.get(&r.id) else { continue };
                let missing: Vec<&str> = FILLABLE.iter().copied().filter(|f| field_value(meta, f).is_none()).collect();
                if missing.is_empty() {
                    continue;
                }
                let mut fields = Map::new();
                let mut from = Map::new();
                // Duplicates first: the longest abstract, the first value of anything else.
                for other in group.get(&r.id).into_iter().flatten() {
                    let Some(om) = m.get(other) else { continue };
                    let batch = state.record(other).and_then(|o| state.batch(&o.batch)).map(|b| b.name.clone()).unwrap_or_default();
                    for f in &missing {
                        if let Some(v) = field_value(om, f) {
                            let better = match fields.get(*f) {
                                None => true,
                                Some(Json::String(old)) if *f == "abstractText" => v.as_str().is_some_and(|n| n.len() > old.len()),
                                _ => false,
                            };
                            if better {
                                fields.insert(f.to_string(), v);
                                from.insert(f.to_string(), json!(format!("duplicate in {batch}")));
                            }
                        }
                    }
                }
                // Then the library.
                if missing.iter().any(|f| !fields.contains_key(*f)) {
                    if let Some((source, lib)) = library.same_work(meta) {
                        for f in &missing {
                            if fields.contains_key(*f) {
                                continue;
                            }
                            if let Some(v) = lib.get(*f).filter(|v| !crate::logic::is_empty(Some(v))) {
                                fields.insert(f.to_string(), v.clone());
                                from.insert(f.to_string(), json!(format!("library:{source}")));
                            }
                        }
                    }
                }
                for k in fields.keys() {
                    *report.filled.entry(k.clone()).or_default() += 1;
                }
                let has_abstract = fields.contains_key("abstractText") || !missing.contains(&"abstractText");
                if !has_abstract {
                    report.still_missing += 1;
                    if !meta.doi.is_empty() || !meta.pmid.is_empty() || fields.contains_key("doi") || fields.contains_key("pmid") {
                        report.lookup_candidates.push(r.id.clone());
                    }
                }
                if !fields.is_empty() {
                    events.push(b.event("record.enrich", actor, Some(&r.id), json!({ "fields": fields, "from": from })));
                }
            }
            Ok((events, report))
        })
    }

    /// Values found by an open lookup (OpenAlex, Crossref, PubMed) for one record: only fields it
    /// lacks are written, each marked with where it came from.
    pub fn enrich_from(&self, review: &str, record: &str, found: Map<String, Json>, from: &str, actor: &str) -> Result<usize> {
        self.write(review, |state, conn, b| {
            state.record(record).ok_or("This record no longer exists")?;
            let meta = metas(conn, review, &[record.to_string()])?.remove(record).ok_or("This record has no metadata")?;
            let mut fields = Map::new();
            let mut whence = Map::new();
            for (k, v) in found {
                if FILLABLE.contains(&k.as_str()) && field_value(&meta, &k).is_none() && !crate::logic::is_empty(Some(&v)) {
                    whence.insert(k.clone(), json!(from));
                    fields.insert(k, v);
                }
            }
            let n = fields.len();
            let events = if n > 0 { vec![b.event("record.enrich", actor, Some(record), json!({ "fields": fields, "from": whence }))] } else { Vec::new() };
            Ok((events, n))
        })
    }

    /// A full text kept with the review for a record (the host has copied the file).
    pub fn attach_file(&self, review: &str, record: &str, file: FileRef, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            let r = state.record(record).ok_or("This record no longer exists")?;
            if !state.eligible(r, Stage::Ft) && !state.included().iter().any(|x| x.id == record) {
                return Err("Full texts are for records at full-text screening".into());
            }
            Ok((vec![b.event("fulltext.set", actor, Some(record), json!({ "status": "retrieved", "file": file }))], ()))
        })
    }

    /// Takes the kept file off a record (undo of an attach).
    pub fn detach_file(&self, review: &str, record: &str, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            state.record(record).ok_or("This record no longer exists")?;
            Ok((vec![b.event("fulltext.set", actor, Some(record), json!({ "status": "sought", "file": null }))], ()))
        })
    }

    pub fn match_dropped(&self, review: &str, files: &[DroppedFile]) -> Result<Vec<Proposal>> {
        self.read(review, |state, conn| {
            let ids: Vec<String> = needing_full_text(state).iter().map(|r| r.id.clone()).collect();
            let m = metas(conn, review, &ids)?;
            let records: Vec<RecordMeta> = ids.iter().filter_map(|id| m.get(id).cloned()).collect();
            Ok(match_files(&records, files))
        })
    }

    pub fn fulltext_status(&self, review: &str) -> Result<Json> {
        self.read(review, |state, conn| {
            let at_ft: Vec<&RecState> = state.records.iter().filter(|r| state.eligible(r, Stage::Ft)).collect();
            let ids: Vec<String> = at_ft.iter().map(|r| r.id.clone()).collect();
            let m = metas(conn, review, &ids)?;
            let rows: Vec<Json> = at_ft
                .iter()
                .map(|r| {
                    let meta = m.get(&r.id);
                    let state_name = if r.fulltext.status == "notRetrieved" { "notRetrievable" } else if r.has_full_text() { "have" } else { "need" };
                    json!({ "id": r.id, "title": meta.map(|x| x.title.clone()), "byline": meta.map(|x| x.byline()), "doi": meta.map(|x| x.doi.clone()), "state": state_name, "reason": r.fulltext.reason, "file": r.fulltext.file, "sourceId": r.source_id, "status": state.status(r, Stage::Ft).name() })
                })
                .collect();
            let count = |s: &str| rows.iter().filter(|r| r["state"] == s).count();
            Ok(json!({ "rows": rows, "have": count("have"), "need": count("need"), "notRetrievable": count("notRetrievable") }))
        })
    }

    pub fn fulltext_csv(&self, review: &str) -> Result<String> {
        self.read(review, |state, conn| {
            let ids: Vec<String> = needing_full_text(state).iter().map(|r| r.id.clone()).collect();
            Ok(fulltext_csv(state, &metas(conn, review, &ids)?))
        })
    }

    pub fn read_csv(&self, review: &str, text: &str, files: &[DroppedFile]) -> Result<Vec<CsvRow>> {
        self.read(review, |state, _| Ok(read_fulltext_csv(state, text, files)))
    }
}

/// The "Other" reasons reviewers wrote, with how often: recurring ones are offered as criteria.
pub fn other_reasons(state: &State) -> Vec<(String, usize)> {
    let mut counts: BTreeMap<String, (String, usize)> = BTreeMap::new();
    for r in &state.records {
        for d in r.decisions.iter().chain(r.resolutions.iter()).flatten() {
            if !d.other.is_empty() {
                let e = counts.entry(d.other.to_lowercase()).or_insert((d.other.clone(), 0));
                e.1 += 1;
            }
        }
    }
    let mut out: Vec<(String, usize)> = counts.into_values().collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    out
}

#[allow(dead_code)]
fn _event_type_check(_: &Event) {}
