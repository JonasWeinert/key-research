// PRISMA 2020 flow counts from the review's real data (Page et al., BMJ 2021;372:n71): records
// identified per database, register and other method; removed before screening (duplicates,
// marked ineligible by automation tools, other); screened and excluded; reports sought, not
// retrieved, assessed and excluded with reasons; studies included. Records found by other
// methods (citation searching, websites …) form the diagram's second column.
use crate::derive::{State, Status};
use crate::model::*;
use crate::store::{Result, Reviews};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub name: String,
    pub count: usize,
}

#[derive(Clone, Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub identified: usize,
    /// Other methods only: records Key screened at title and abstract and excluded there, and
    /// those still to screen (PRISMA 2020's right-hand path has no screening box; Key screens
    /// them anyway and reports it beside "Records identified").
    pub screened_out: usize,
    pub screening_pending: usize,
    /// Other methods only: duplicates and records removed by hand.
    pub removed: usize,
    pub sought: usize,
    pub not_retrieved: usize,
    /// Reports with a final full-text decision (included + excluded).
    pub assessed: usize,
    pub excluded: usize,
    pub excluded_reasons: Vec<Named>,
    /// The words written under "Other", with how often.
    pub other_reasons: Vec<Named>,
    pub included: usize,
    /// Sought, retrieved, not decided yet ("still to assess": work in progress).
    pub pending: usize,
}

#[derive(Clone, Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prisma {
    pub databases: Vec<Named>,
    pub registers: Vec<Named>,
    pub other_methods: Vec<Named>,
    /// Records from databases and registers.
    pub identified: usize,
    pub duplicates: usize,
    pub automation: usize,
    pub removed_other: usize,
    /// Records with a final title/abstract decision (included, maybe or excluded).
    pub screened: usize,
    pub screening_excluded: usize,
    /// Still to screen (work in progress, never in a figure for publication).
    pub screening_pending: usize,
    /// Databases and registers (the main column) from retrieval on.
    pub main: Column,
    /// Other methods.
    pub other: Column,
    pub studies_included: usize,
    pub reports_included: usize,
    /// Every box final: nothing still to screen or assess.
    pub complete: bool,
    /// Records counted under a database whose name was not given ("Source not specified").
    pub unnamed: usize,
}

/// A batch's line when its source was not named.
pub const UNNAMED: &str = "Source not specified";

/// PRISMA 2020's other methods. "Manual" (Key's old default) is none of them.
pub const OTHER_METHODS: &[&str] = &["Citation searching", "Websites", "Organisations", "Contact with authors or experts", "Hand searching", "Other"];

fn add(list: &mut Vec<Named>, name: &str, count: usize) {
    match list.iter_mut().find(|n| n.name == name) {
        Some(n) => n.count += count,
        None => list.push(Named { name: name.to_string(), count }),
    }
}

fn take(list: &mut Vec<Named>, name: &str, count: usize) {
    if let Some(n) = list.iter_mut().find(|n| n.name == name) {
        n.count = n.count.saturating_sub(count);
    }
    list.retain(|n| n.count > 0 || n.name != name);
}

/// The PRISMA group of a record: its own origin when one was set, else its import's.
pub fn group_of<'a>(state: &'a State, r: &'a crate::derive::RecState) -> (&'a str, String) {
    if let Some((g, n)) = &r.origin {
        return (g.as_str(), n.clone());
    }
    match state.batch(&r.batch) {
        Some(b) => (b.group.as_str(), batch_name(b)),
        None => ("databases", UNNAMED.to_string()),
    }
}

/// The name a batch is counted under.
pub fn batch_name(b: &Batch) -> String {
    let name = if b.name.trim().is_empty() && b.kind == "file" && b.group == "other" { b.file_name.clone() } else { b.name.clone() };
    if name.trim().is_empty() { UNNAMED.to_string() } else { name }
}

fn list_of<'a>(p: &'a mut Prisma, group: &str) -> &'a mut Vec<Named> {
    match group {
        "registers" | "register" => &mut p.registers,
        "other" => &mut p.other_methods,
        _ => &mut p.databases,
    }
}

pub fn compute(state: &State) -> Prisma {
    let mut p = Prisma::default();
    for b in state.batches.iter().filter(|b| !state.removed_batches.contains(&b.id)) {
        if b.group != "other" {
            p.duplicates += b.duplicates_removed;
        }
        if !b.per_source.is_empty() {
            // A search run can mix databases and registers: each goes to its own box.
            for (n, c) in &b.per_source {
                let kind = if b.group == "other" { "other" } else { b.per_source_kind.get(n).map(String::as_str).unwrap_or(b.group.as_str()) };
                add(list_of(&mut p, kind), n, *c);
            }
        } else {
            add(list_of(&mut p, &b.group), &batch_name(b), b.count);
        }
    }
    // Records given an origin of their own move from their import's line to it.
    for r in state.records.iter().filter(|r| r.origin.is_some() && !state.removed_batches.contains(&r.batch)) {
        let Some(b) = state.batch(&r.batch) else { continue };
        if !b.per_source.is_empty() {
            continue;
        }
        take(list_of(&mut p, &b.group), &batch_name(b), 1);
        let (g, n) = group_of(state, r);
        let (g, n) = (g.to_string(), n);
        add(list_of(&mut p, &g), &n, 1);
    }
    p.unnamed = p.databases.iter().chain(&p.registers).filter(|n| n.name == UNNAMED).map(|n| n.count).sum();
    p.identified = p.databases.iter().chain(&p.registers).map(|n| n.count).sum();
    let mut reasons_main: BTreeMap<String, usize> = BTreeMap::new();
    let mut reasons_other: BTreeMap<String, usize> = BTreeMap::new();
    let mut included_studies: std::collections::HashSet<String> = Default::default();
    for r in &state.records {
        if state.removed_batches.contains(&r.batch) {
            continue;
        }
        let other = group_of(state, r).0 == "other";
        if !state.active(r) {
            if other {
                p.other.removed += 1;
            } else if r.removed.is_some() && r.dup_of.is_none() {
                p.removed_other += 1;
            } else {
                p.duplicates += 1;
            }
            continue;
        }
        // Title and abstract: every record is screened in Key, whichever column it is in.
        let ta = state.status(r, Stage::Ta);
        match &ta {
            Status::Final { auto: true, value: Choice::Exclude, .. } if !other => {
                p.automation += 1;
                continue;
            }
            Status::Final { value: Choice::Exclude, .. } => {
                if other {
                    p.other.screened_out += 1;
                } else {
                    p.screened += 1;
                    p.screening_excluded += 1;
                }
                continue;
            }
            Status::Final { .. } => {
                if !other {
                    p.screened += 1;
                }
            }
            _ => {
                if other {
                    p.other.screening_pending += 1;
                } else {
                    p.screening_pending += 1;
                }
                continue;
            }
        }
        let column = if other { &mut p.other } else { &mut p.main };
        column.sought += 1;
        match state.status(r, Stage::Ft) {
            Status::NotRetrieved => column.not_retrieved += 1,
            Status::Final { value: Choice::Include, .. } => {
                column.assessed += 1;
                column.included += 1;
                included_studies.insert(state.study_id(r).to_string());
            }
            Status::Final { value: Choice::Exclude, .. } => {
                column.assessed += 1;
                column.excluded += 1;
                let reasons = state.final_reasons(r, Stage::Ft);
                let top = state.protocol.top_reason(&reasons).cloned();
                let texts = state.final_other(r, Stage::Ft);
                let label = match top {
                    Some(id) => state.protocol.reason_label(&id),
                    None if !texts.is_empty() => "Other".into(),
                    None => "No criterion given".into(),
                };
                if label == "Other" {
                    for t in texts {
                        add(&mut column.other_reasons, &t, 1);
                    }
                }
                *(if other { &mut reasons_other } else { &mut reasons_main }).entry(label).or_default() += 1;
            }
            _ => column.pending += 1,
        }
    }
    let order = |map: BTreeMap<String, usize>| -> Vec<Named> {
        let mut v: Vec<Named> = map.into_iter().map(|(name, count)| Named { name, count }).collect();
        let pos = |n: &Named| state.protocol.criteria.iter().position(|c| c.reason_text() == n.name).unwrap_or(if n.name == "Other" { usize::MAX - 1 } else { usize::MAX });
        v.sort_by_key(pos);
        v
    };
    p.main.excluded_reasons = order(reasons_main);
    p.other.excluded_reasons = order(reasons_other);
    p.main.identified = p.identified;
    p.other.identified = p.other_methods.iter().map(|n| n.count).sum();
    // Several reports of one study count once as a study.
    p.reports_included = p.main.included + p.other.included;
    p.studies_included = included_studies.len();
    p.complete = p.screening_pending == 0 && p.main.pending == 0 && p.other.pending == 0 && p.other.screening_pending == 0;
    p
}

/// The numbers as a two-column table (CSV).
pub fn csv(p: &Prisma) -> String {
    let mut rows: Vec<(String, String)> = Vec::new();
    for n in &p.databases {
        rows.push((format!("Records identified: database: {}", n.name), n.count.to_string()));
    }
    for n in &p.registers {
        rows.push((format!("Records identified: register: {}", n.name), n.count.to_string()));
    }
    rows.push(("Records identified from databases and registers".into(), p.identified.to_string()));
    rows.push(("Duplicate records removed".into(), p.duplicates.to_string()));
    rows.push(("Records marked as ineligible by automation tools".into(), p.automation.to_string()));
    rows.push(("Records removed for other reasons".into(), p.removed_other.to_string()));
    rows.push(("Records screened".into(), p.screened.to_string()));
    rows.push(("Records excluded".into(), p.screening_excluded.to_string()));
    if p.screening_pending > 0 {
        rows.push(("Records still to screen (in progress, not for publication)".into(), p.screening_pending.to_string()));
    }
    let column = |rows: &mut Vec<(String, String)>, prefix: &str, c: &Column| {
        rows.push((format!("{prefix}Reports sought for retrieval"), c.sought.to_string()));
        rows.push((format!("{prefix}Reports not retrieved"), c.not_retrieved.to_string()));
        rows.push((format!("{prefix}Reports assessed for eligibility"), c.assessed.to_string()));
        rows.push((format!("{prefix}Reports excluded"), c.excluded.to_string()));
        for r in &c.excluded_reasons {
            rows.push((format!("{prefix}Reports excluded: {}", r.name), r.count.to_string()));
        }
        for r in &c.other_reasons {
            rows.push((format!("{prefix}Reports excluded: Other: {}", r.name), r.count.to_string()));
        }
        if c.pending > 0 {
            rows.push((format!("{prefix}Reports still to assess (in progress, not for publication)"), c.pending.to_string()));
        }
    };
    column(&mut rows, "", &p.main);
    for n in &p.other_methods {
        rows.push((format!("Other methods: records identified: {}", n.name), n.count.to_string()));
    }
    if p.other.screened_out > 0 {
        rows.push(("Other methods: records excluded at title and abstract screening".into(), p.other.screened_out.to_string()));
    }
    if p.other.screening_pending > 0 {
        rows.push(("Other methods: records still to screen (in progress, not for publication)".into(), p.other.screening_pending.to_string()));
    }
    column(&mut rows, "Other methods: ", &p.other);
    rows.push(("Studies included in review".into(), p.studies_included.to_string()));
    rows.push(("Reports of included studies".into(), p.reports_included.to_string()));
    let mut out = String::from("Item,Count\n");
    for (k, v) in rows {
        out.push_str(&crate::export::csv_cell(&k));
        out.push(',');
        out.push_str(&v);
        out.push('\n');
    }
    out
}

impl Reviews {
    pub fn prisma(&self, review: &str) -> Result<Prisma> {
        self.read(review, |state, _| Ok(compute(state)))
    }
}
