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
    pub sought: usize,
    pub not_retrieved: usize,
    pub assessed: usize,
    pub excluded: usize,
    pub excluded_reasons: Vec<Named>,
    pub included: usize,
    /// Assessed but not decided yet.
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
    pub screened: usize,
    pub screening_excluded: usize,
    pub screening_pending: usize,
    /// Databases and registers (the main column) from retrieval on.
    pub main: Column,
    /// Other methods.
    pub other: Column,
    pub studies_included: usize,
    pub reports_included: usize,
}

fn add(list: &mut Vec<Named>, name: &str, count: usize) {
    match list.iter_mut().find(|n| n.name == name) {
        Some(n) => n.count += count,
        None => list.push(Named { name: name.to_string(), count }),
    }
}

pub fn compute(state: &State) -> Prisma {
    let mut p = Prisma::default();
    let mut other_group: std::collections::HashSet<&str> = Default::default();
    for b in state.batches.iter().filter(|b| !state.removed_batches.contains(&b.id)) {
        let list = match b.group.as_str() {
            "databases" => &mut p.databases,
            "registers" => &mut p.registers,
            _ => {
                other_group.insert(&b.id);
                &mut p.other_methods
            }
        };
        if b.group != "other" {
            p.duplicates += b.duplicates_removed;
        }
        let name = if b.name.trim().is_empty() { b.file_name.clone() } else { b.name.clone() };
        if !b.per_source.is_empty() {
            for (n, c) in &b.per_source {
                add(list, n, *c);
            }
        } else {
            add(list, &name, b.count);
        }
    }
    p.identified = p.databases.iter().chain(&p.registers).map(|n| n.count).sum();
    let mut reasons_main: BTreeMap<String, usize> = BTreeMap::new();
    let mut reasons_other: BTreeMap<String, usize> = BTreeMap::new();
    for r in &state.records {
        if state.removed_batches.contains(&r.batch) {
            continue;
        }
        let other = other_group.contains(r.batch.as_str());
        if !state.active(r) {
            if !other {
                p.duplicates += 1;
            }
            continue;
        }
        let ta = state.status(r, Stage::Ta);
        if !other {
            match &ta {
                Status::Final { auto: true, .. } => {
                    p.automation += 1;
                    continue;
                }
                Status::Final { value: Choice::Exclude, .. } => {
                    p.screened += 1;
                    p.screening_excluded += 1;
                    continue;
                }
                Status::Final { .. } => p.screened += 1,
                _ => {
                    p.screened += 1;
                    p.screening_pending += 1;
                    continue;
                }
            }
        } else if !matches!(ta, Status::Final { value: Choice::Include | Choice::Maybe, .. }) {
            // Other methods: only what reaches full text appears in their column.
            continue;
        }
        let column = if other { &mut p.other } else { &mut p.main };
        column.sought += 1;
        let ft = state.status(r, Stage::Ft);
        match ft {
            Status::NotRetrieved => column.not_retrieved += 1,
            Status::Final { value: Choice::Include, .. } => {
                column.assessed += 1;
                column.included += 1;
            }
            Status::Final { value: Choice::Exclude, .. } => {
                column.assessed += 1;
                column.excluded += 1;
                let reasons = state.final_reasons(r, Stage::Ft);
                let top = state.protocol.top_reason(&reasons).cloned();
                let label = top.map(|id| state.protocol.reason_label(&id)).unwrap_or_else(|| "No criterion given".into());
                *(if other { &mut reasons_other } else { &mut reasons_main }).entry(label).or_default() += 1;
            }
            _ => {
                column.assessed += 1;
                column.pending += 1;
            }
        }
    }
    let order = |map: BTreeMap<String, usize>| -> Vec<Named> {
        let mut v: Vec<Named> = map.into_iter().map(|(name, count)| Named { name, count }).collect();
        let pos = |n: &Named| state.protocol.criteria.iter().position(|c| c.reason_text() == n.name).unwrap_or(usize::MAX);
        v.sort_by_key(pos);
        v
    };
    p.main.excluded_reasons = order(reasons_main);
    p.other.excluded_reasons = order(reasons_other);
    p.main.identified = p.identified;
    p.other.identified = p.other_methods.iter().map(|n| n.count).sum();
    p.studies_included = p.main.included + p.other.included;
    p.reports_included = p.studies_included;
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
    rows.push(("Records awaiting screening".into(), p.screening_pending.to_string()));
    let column = |rows: &mut Vec<(String, String)>, prefix: &str, c: &Column| {
        rows.push((format!("{prefix}Reports sought for retrieval"), c.sought.to_string()));
        rows.push((format!("{prefix}Reports not retrieved"), c.not_retrieved.to_string()));
        rows.push((format!("{prefix}Reports assessed for eligibility"), c.assessed.to_string()));
        rows.push((format!("{prefix}Reports excluded"), c.excluded.to_string()));
        for r in &c.excluded_reasons {
            rows.push((format!("{prefix}Reports excluded: {}", r.name), r.count.to_string()));
        }
        rows.push((format!("{prefix}Reports awaiting assessment"), c.pending.to_string()));
    };
    column(&mut rows, "", &p.main);
    for n in &p.other_methods {
        rows.push((format!("Other methods: records identified: {}", n.name), n.count.to_string()));
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
