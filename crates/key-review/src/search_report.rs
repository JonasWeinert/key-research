// std-A: the review's search report, complete for PRISMA-S (Rethlefsen et al., Syst Rev
// 2021;10:39; CC BY 4.0; item numbers and topics followed, wording Key's own). Every
// information source: its name and platform, coverage, the date searched, the strategy exactly
// as run (with Key's decomposition and local filtering when it used them), limits and filters,
// records found; update searches; other methods (citation searching, websites, contacts, hand
// searching) with dates and counts; reused prior work; peer review of the strategies; totals
// before and after de-duplication, and how duplicates were found. Database search runs carry
// their own log (`strategies`: the run's machine-readable strategy, from the host); file
// imports are completed by the reviewer (`search.source` events), and the report says what
// is still missing for each.
use crate::derive::State;
use crate::model::Batch;
use crate::report_text::{csv_line, date, join_and, md_cell, plural, software, thousands, when_ms, when_text};
use crate::reporting::{Filter, Limit, PeerReview, PriorWork, SourceDetail};
use crate::store::{Result, Reviews};
use serde::Serialize;
use serde_json::{Value as Json, json};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub n: usize,
    pub native: String,
    pub reported: Option<u64>,
    pub kept: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceRow {
    pub batch_id: String,
    /// The database inside a multi-database run ("" for an import of one source).
    pub source: String,
    pub name: String,
    /// databases | registers | other
    pub group: String,
    /// database search run | file | library | other method
    pub kind: String,
    pub platform: String,
    pub coverage: String,
    pub searched: String,
    #[serde(skip)]
    pub searched_ms: Option<i64>,
    pub strategy: String,
    pub queries: Vec<Query>,
    /// How Key rebuilt the search where the service could not take it in one query.
    pub decomposition: Vec<String>,
    pub approximate: Vec<String>,
    pub post_filter: bool,
    pub limits: Vec<Limit>,
    pub no_limits: bool,
    pub filters: Vec<Filter>,
    pub notes: String,
    pub searcher: String,
    pub records: usize,
    pub update: bool,
    /// Run through Key's Database search (strategy and date from its log).
    pub key_run: bool,
    pub connector_version: String,
    /// What PRISMA-S still needs for this source, in plain words.
    pub missing: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRow {
    pub search: String,
    pub at: i64,
    pub added: usize,
    pub known: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub identified: usize,
    pub duplicates: usize,
    pub after_dedup: usize,
    pub other_methods: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub sources: Vec<SourceRow>,
    pub other_methods: Vec<SourceRow>,
    pub updates: Vec<UpdateRow>,
    pub peer_reviews: Vec<PeerReview>,
    pub prior: Vec<PriorWork>,
    pub totals: Totals,
    pub dedup_method: String,
    pub items: Vec<crate::checklist::Item>,
}

/// How Key finds duplicates (key-store's matcher, the same for the library and reviews).
pub fn dedup_method() -> String {
    format!(
        "Duplicates were identified in {}: records with the same DOI or PubMed ID, or the same normalised title, publication year and first author, were removed automatically as certain duplicates; records that were similar but not identical (for example a slightly different title) were listed in pairs and a reviewer decided whether each pair was the same report. Records found by more than one query of the same database search were counted once.",
        software()
    )
}

fn detail<'a>(state: &'a State, batch: &str, source: &str) -> Option<&'a SourceDetail> {
    state.reporting.source(batch, source)
}

fn apply_detail(row: &mut SourceRow, d: Option<&SourceDetail>) {
    let Some(d) = d else { return };
    if !d.platform.trim().is_empty() {
        row.platform = d.platform.trim().to_string();
    }
    row.coverage = d.coverage.trim().to_string();
    if !d.searched_at.trim().is_empty() {
        row.searched = when_text(&d.searched_at);
        row.searched_ms = when_ms(&d.searched_at);
    }
    if !d.strategy.trim().is_empty() {
        row.strategy = d.strategy.trim().to_string();
    }
    // A limit given again (with its reason) replaces the run's own record of it.
    for l in d.limits.iter().filter(|l| !l.value.trim().is_empty()) {
        row.limits.retain(|x| x.value.trim() != l.value.trim());
        row.limits.push(l.clone());
    }
    row.no_limits = row.no_limits || d.no_limits;
    row.filters = d.filters.iter().filter(|f| !f.name.trim().is_empty()).cloned().collect();
    row.notes = d.notes.trim().to_string();
    row.searcher = d.searcher.trim().to_string();
}

fn missing_for(row: &SourceRow) -> Vec<String> {
    let mut out = Vec::new();
    if row.group == "other" {
        if row.searched.is_empty() {
            out.push("the date it was done".into());
        }
        if row.notes.is_empty() && row.strategy.is_empty() {
            out.push(match row.name.as_str() {
                "Websites" => "which websites, their addresses and how they were browsed".into(),
                "Citation searching" => "the seed studies and direction (references or citing works)".into(),
                "Contact with authors or experts" | "Organisations" => "whom you contacted and what you asked".into(),
                _ => "what was done".into(),
            });
        }
        return out;
    }
    if row.name.is_empty() || row.name == crate::prisma::UNNAMED {
        out.push("the database's name".into());
    }
    if row.platform.is_empty() {
        out.push("the platform or interface (for example Ovid, EBSCOhost, Web of Science)".into());
    }
    if row.searched.is_empty() {
        out.push("the date searched".into());
    }
    if row.strategy.is_empty() && row.queries.is_empty() {
        out.push("the search strategy exactly as run".into());
    }
    if row.limits.is_empty() && !row.no_limits && !row.key_run {
        out.push("its limits (or that none were used)".into());
    }
    out
}

fn kind_of(b: &Batch) -> &'static str {
    match b.kind.as_str() {
        "database" => "Database search run",
        "library" => "Library",
        "file" => "File import",
        _ => "Other method",
    }
}

fn row_base(b: &Batch) -> SourceRow {
    SourceRow {
        batch_id: b.id.clone(),
        name: crate::prisma::batch_name(b),
        group: b.group.clone(),
        kind: kind_of(b).into(),
        searched: when_text(&b.searched_at),
        searched_ms: when_ms(&b.searched_at),
        strategy: b.strategy.trim().to_string(),
        records: b.count,
        update: b.name.ends_with("(update)") || b.note.starts_with("Update search"),
        ..Default::default()
    }
}

/// The report. `strategies`: a database search run's strategy (its `key-search-strategy` JSON)
/// by run id, when the host still has the run's log.
pub fn report(state: &State, strategies: &HashMap<String, Json>) -> Report {
    let mut sources = Vec::new();
    let mut other_methods = Vec::new();
    for b in state.batches.iter().filter(|b| !state.removed_batches.contains(&b.id)) {
        if b.group == "other" {
            let mut row = row_base(b);
            if row.searched.is_empty() && b.at > 0 {
                row.searched = date(b.at);
                row.searched_ms = Some(b.at);
            }
            apply_detail(&mut row, detail(state, &b.id, ""));
            row.missing = missing_for(&row);
            other_methods.push(row);
            continue;
        }
        let run = (!b.db_run_id.is_empty()).then(|| strategies.get(&b.db_run_id)).flatten();
        let databases: Vec<&Json> = run.and_then(|r| r.get("databases")).and_then(Json::as_array).map(|a| a.iter().collect()).unwrap_or_default();
        let run_limits: Vec<Limit> = run.and_then(|r| r.get("limits")).and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(|v| Limit { kind: "search".into(), value: v.into(), justification: String::new() }).collect()).unwrap_or_default();
        if !databases.is_empty() {
            for d in databases {
                let s = |k: &str| d.get(k).and_then(Json::as_str).unwrap_or("").to_string();
                let name = s("name");
                let mut row = row_base(b);
                row.source = name.clone();
                row.name = name.clone();
                row.key_run = true;
                row.connector_version = s("version");
                row.group = match b.per_source_kind.get(&name).map(String::as_str) {
                    Some("register") => "registers".into(),
                    _ => b.group.clone(),
                };
                row.platform = format!("{} through {}'s Database search ({} connector{})", name, software(), s("connector"), if row.connector_version.is_empty() { String::new() } else { format!(" {}", row.connector_version) });
                if let Some(at) = d.get("startedAt").and_then(Json::as_i64) {
                    row.searched = date(at);
                    row.searched_ms = Some(at);
                }
                row.queries = d.get("queries").and_then(Json::as_array).map(|a| a.iter().map(|q| Query { n: q.get("n").and_then(Json::as_u64).unwrap_or(0) as usize, native: q.get("native").and_then(Json::as_str).unwrap_or("").into(), reported: q.get("reported").and_then(Json::as_u64), kept: q.get("kept").and_then(Json::as_u64) }).collect()).unwrap_or_default();
                row.strategy = row.queries.iter().map(|q| q.native.clone()).filter(|q| !q.is_empty()).collect::<Vec<_>>().join("\n");
                row.post_filter = d.get("postFilter").and_then(Json::as_bool).unwrap_or(false);
                let list = |k: &str| d.get(k).and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect::<Vec<_>>()).unwrap_or_default();
                row.decomposition = list("reconstruction");
                row.approximate = list("approximate");
                row.limits = run_limits.clone();
                row.no_limits = run_limits.is_empty();
                row.records = b.per_source.get(&name).copied().unwrap_or_else(|| d.get("kept").and_then(Json::as_u64).unwrap_or(0) as usize);
                apply_detail(&mut row, detail(state, &b.id, &name));
                row.missing = missing_for(&row);
                sources.push(row);
            }
            continue;
        }
        if !b.per_source.is_empty() {
            // A run whose log is gone: its stored strategy covers all its databases.
            for (name, count) in &b.per_source {
                let mut row = row_base(b);
                row.source = name.clone();
                row.name = name.clone();
                row.records = *count;
                row.key_run = !b.db_run_id.is_empty();
                if row.key_run {
                    row.platform = format!("{name} through {}'s Database search", software());
                }
                if b.per_source_kind.get(name).map(String::as_str) == Some("register") {
                    row.group = "registers".into();
                }
                apply_detail(&mut row, detail(state, &b.id, name));
                row.missing = missing_for(&row);
                sources.push(row);
            }
            continue;
        }
        let mut row = row_base(b);
        row.key_run = !b.db_run_id.is_empty();
        apply_detail(&mut row, detail(state, &b.id, ""));
        row.missing = missing_for(&row);
        sources.push(row);
    }
    let mut updates = Vec::new();
    for s in &state.searches {
        let name = s.get("name").and_then(Json::as_str).unwrap_or("Database search").to_string();
        for r in s.get("runs").and_then(Json::as_array).into_iter().flatten() {
            if r.get("update").and_then(Json::as_bool).unwrap_or(false) {
                updates.push(UpdateRow { search: name.clone(), at: r.get("at").and_then(Json::as_i64).unwrap_or(0), added: r.get("added").and_then(Json::as_u64).unwrap_or(0) as usize, known: r.get("known").and_then(Json::as_u64).unwrap_or(0) as usize });
            }
        }
    }
    let p = crate::prisma::compute(state);
    let totals = Totals { identified: p.identified, duplicates: p.duplicates, after_dedup: p.identified.saturating_sub(p.duplicates), other_methods: p.other.identified };
    let mut r = Report { sources, other_methods, updates, peer_reviews: state.reporting.peer_reviews.clone(), prior: state.reporting.prior.clone(), totals, dedup_method: dedup_method(), items: Vec::new() };
    r.items = items(state, &r);
    r
}

// ── PRISMA-S items ──────────────────────────────────────────────────────────────────

use crate::checklist::{Item, Link, done, gap, item};

fn imports() -> Link {
    Link::to("Sources › Imports", "sources", Some("imports"))
}
fn report_link() -> Link {
    Link::to("Search report", "overview", Some("search"))
}

fn named(rows: &[&SourceRow]) -> Vec<String> {
    rows.iter().map(|r| r.name.clone()).collect()
}

fn items(state: &State, r: &Report) -> Vec<Item> {
    let dbs: Vec<&SourceRow> = r.sources.iter().filter(|s| s.group != "registers").collect();
    let regs: Vec<&SourceRow> = r.sources.iter().filter(|s| s.group == "registers").collect();
    let other = |names: &[&str]| -> Vec<&SourceRow> { r.other_methods.iter().filter(|s| names.contains(&s.name.as_str())).collect() };
    let mut out = Vec::new();
    let mk = |id: &'static str, topic: &'static str, text: &'static str| item("prismas", id, "Information sources and methods", topic, text);

    // 1 Database name
    let mut i = mk("1", "Database name", "Name each database searched and the platform used for it.");
    let no_platform: Vec<&SourceRow> = dbs.iter().copied().filter(|s| s.platform.is_empty()).collect();
    i = if dbs.is_empty() {
        gap(i, "missing", "No database searches have been imported.", "Run a database search or import a file", Link::to("Sources › Database searches", "sources", Some("searches")))
    } else if no_platform.is_empty() {
        done(i, "Each database has a name and a platform.", Some(format!("We searched {}.", join_and(&dbs.iter().map(|s| format!("{} ({})", s.name, s.platform)).collect::<Vec<_>>()))))
    } else {
        gap(i, "partly", &format!("No platform for {}.", join_and(&named(&no_platform))), "Add the platform in the search report", report_link())
    };
    i.evidence.push(report_link());
    out.push(i);

    // 2 Multi-database searching
    let mut i = mk("2", "Multi-database searching", "If several databases were searched together on one platform, name the platform and every database.");
    let runs: Vec<&String> = { let mut v: Vec<&String> = r.sources.iter().filter(|s| s.key_run && !s.source.is_empty()).map(|s| &s.batch_id).collect(); v.dedup(); v };
    i = if runs.iter().any(|b| r.sources.iter().filter(|s| &&s.batch_id == b).count() > 1) {
        done(i, "Key's Database search ran several databases in one run, each through its own service.", Some("Several databases were searched in one run of Key's Database search; each database was queried separately through its own interface with a strategy translated to its syntax, and records were combined afterwards.".into()))
    } else {
        Item { status: "na".into(), rule: "No databases were searched together on one platform.".into(), ..i }
    };
    out.push(i);

    // 3 Study registries
    let mut i = mk("3", "Study registries", "Name each study or trial register searched.");
    i = if !regs.is_empty() {
        done(i, "Registers are listed apart from databases.", Some(format!("We searched the registers {}.", join_and(&named(&regs)))))
    } else {
        gap(i, "missing", "No study register was searched. Cochrane requires trial registers (ClinicalTrials.gov, WHO ICTRP) for intervention reviews (MECIR C27).", "Search a register, or say why not in the manuscript", Link::to("Sources › Database searches", "sources", Some("searches")))
    };
    out.push(i);

    // 4–7 other methods
    for (id, topic, text, names, why) in [
        ("4", "Online resources and browsing", "Describe websites, search engines or other online resources browsed, and how.", &["Websites"][..], "No website searching recorded."),
        ("5", "Citation searching", "Describe reference-list checking and citing-work searches, with tools and direction.", &["Citation searching"][..], "No citation searching recorded. Cochrane requires checking reference lists of included studies (MECIR C30)."),
        ("6", "Contacts", "Describe contact with authors, experts, manufacturers or organisations to find studies.", &["Contact with authors or experts", "Organisations"][..], "No contacts recorded."),
        ("7", "Other methods", "Describe any other way of finding studies (for example hand searching).", &["Hand searching", "Other"][..], "No other methods recorded."),
    ] {
        let rows = other(names);
        let mut i = mk(id, topic, text);
        i = if rows.is_empty() {
            let mut x = Item { status: "na".into(), rule: why.into(), ..i };
            if id == "5" {
                x.gap = Some(crate::checklist::Gap { text: why.into(), action: "Import reference-list or citing-work results as “Citation searching”".into(), link: Some(imports()) });
            }
            x
        } else {
            let incomplete: Vec<&&SourceRow> = rows.iter().filter(|s| !s.missing.is_empty()).collect();
            let sentence = rows.iter().map(|s| format!("{} ({}{}, {})", s.name, if s.notes.is_empty() { s.strategy.clone() } else { s.notes.clone() }, if s.searched.is_empty() { String::new() } else { format!(", {}", s.searched) }, plural(s.records, "record", "records"))).collect::<Vec<_>>();
            if incomplete.is_empty() {
                done(i, "Recorded with what was done and when.", Some(format!("Other methods: {}.", join_and(&sentence))))
            } else {
                let mut x = gap(i, "partly", &format!("{}: still needs {}.", incomplete[0].name, join_and(&incomplete[0].missing)), "Complete it in the search report", report_link());
                x.draft = Some(format!("Other methods: {}.", join_and(&sentence)));
                x
            }
        };
        out.push(i);
    }

    // 8 Full search strategies
    let all: Vec<&SourceRow> = r.sources.iter().collect();
    let no_strategy: Vec<&SourceRow> = all.iter().copied().filter(|s| s.strategy.is_empty() && s.queries.is_empty()).collect();
    let mut i = mk("8", "Full search strategies", "Give every strategy exactly as run, for every source, copied and pasted.");
    i = if all.is_empty() {
        gap(i, "missing", "No searches yet.", "Run or import a search", Link::to("Sources › Database searches", "sources", Some("searches")))
    } else if no_strategy.is_empty() {
        done(i, "Every source has its strategy as run (Key runs: each query sent, from the run log).", Some("The full search strategies for all databases and registers, exactly as run and with the number of records each query returned, are given in Supplementary file X (generated by Key from its search log).".into()))
    } else {
        gap(i, "partly", &format!("No strategy for {}.", join_and(&named(&no_strategy))), "Paste the strategy as run into the search report", report_link())
    };
    out.push(i);

    // 9 Limits and restrictions
    let unstated: Vec<&SourceRow> = all.iter().copied().filter(|s| s.limits.is_empty() && !s.no_limits && !s.key_run).collect();
    let unjustified: Vec<&Limit> = all.iter().flat_map(|s| s.limits.iter()).filter(|l| l.justification.trim().is_empty()).collect();
    let mut i = mk("9", "Limits and restrictions", "State any limits (dates, language, publication type) and why they were used.");
    i = if all.is_empty() {
        Item { status: "missing".into(), rule: "No searches yet.".into(), ..i }
    } else if !unstated.is_empty() {
        gap(i, "partly", &format!("Limits not stated for {}.", join_and(&named(&unstated))), "State the limits, or that none were used", report_link())
    } else if !unjustified.is_empty() {
        gap(i, "partly", &format!("The limit “{}” has no reason. Cochrane asks for date and format limits to be justified (MECIR C35).", unjustified[0].value), "Give the reason in the search report", report_link())
    } else {
        let limits: Vec<String> = all.iter().flat_map(|s| s.limits.iter().map(|l| format!("{} ({})", l.value, l.justification.trim()))).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        done(i, "Limits are stated for every source, each with its reason.", Some(if limits.is_empty() { "No date, language or publication type limits were applied.".into() } else { format!("Searches were limited as follows: {}.", join_and(&limits)) }))
    };
    out.push(i);

    // 10 Search filters
    let filters: Vec<&Filter> = all.iter().flat_map(|s| s.filters.iter()).collect();
    let mut i = mk("10", "Search filters", "Cite any published search filter used, and say if it was changed.");
    i = if filters.is_empty() {
        Item { status: "na".into(), rule: "No published search filters recorded.".into(), ..i }
    } else if let Some(f) = filters.iter().find(|f| f.citation.trim().is_empty()) {
        gap(i, "partly", &format!("The filter “{}” has no citation.", f.name), "Add its citation in the search report", report_link())
    } else {
        done(i, "Each filter is cited.", Some(format!("We used {}.", join_and(&filters.iter().map(|f| format!("{} ({}{})", f.name, f.citation.trim(), if f.modified { ", modified" } else { "" })).collect::<Vec<_>>()))))
    };
    out.push(i);

    // 11 Prior work
    let mut i = mk("11", "Prior work", "Say whether strategies from earlier work were reused or adapted, and cite it.");
    i = if r.prior.is_empty() {
        Item { status: "na".into(), rule: "No reused strategies recorded.".into(), ..i }
    } else {
        done(i, "Recorded with citations.", Some(r.prior.iter().map(|p| format!("{} ({})", p.how.trim(), p.citation.trim())).collect::<Vec<_>>().join(" ")))
    };
    out.push(i);

    // 12 Updates
    let living = state.protocol.plan.review_type() == "living";
    let mut i = mk("12", "Updates", "Describe how searches were updated (dates, methods, records added).");
    i = if !r.updates.is_empty() {
        done(i, "Update searches are recorded with their dates and records added.", Some(format!("Searches were updated {}.", join_and(&r.updates.iter().map(|u| format!("on {} ({}: {} new, {} already in the review)", date(u.at), u.search, u.added, u.known)).collect::<Vec<_>>()))))
    } else if living {
        gap(i, "missing", "A living review with no update searches yet.", "Run the review's searches again (Update search)", Link::to("Sources › Database searches", "sources", Some("searches")))
    } else {
        Item { status: "na".into(), rule: "No update searches. Cochrane asks for searches rerun within 12 months of publication (MECIR C37).".into(), ..i }
    };
    out.push(i);

    // 13 Dates of searches
    let undated: Vec<&SourceRow> = all.iter().copied().chain(r.other_methods.iter()).filter(|s| s.searched.is_empty()).collect();
    let mut i = mk("13", "Dates of searches", "Give the date each source was last searched.");
    i = if all.is_empty() {
        Item { status: "missing".into(), rule: "No searches yet.".into(), ..i }
    } else if undated.is_empty() {
        let last = all.iter().filter_map(|s| s.searched_ms).max();
        done(i, "Every source has its date.", last.map(|ms| format!("All sources were last searched on or before {}.", date(ms))))
    } else {
        gap(i, "partly", &format!("No date for {}.", join_and(&named(&undated))), "Add the date searched in the search report", report_link())
    };
    out.push(i);

    // 14 Peer review
    let mut i = mk("14", "Peer review", "Describe any peer review of the search strategies.");
    i = if r.peer_reviews.is_empty() {
        gap(i, "missing", "No peer review of the strategies recorded. A second searcher's check (for example with PRESS 2015) is recommended.", "Record a peer review", report_link())
    } else {
        done(i, "Recorded: who, when, with what tool, and the outcome.", Some(r.peer_reviews.iter().map(|p| format!("The search strategy was peer reviewed by {} on {} using {}{}.", p.by.trim(), p.date.trim(), if p.tool.trim().is_empty() { "PRESS 2015" } else { p.tool.trim() }, if p.outcome.trim().is_empty() { String::new() } else { format!("; {}", p.outcome.trim().trim_end_matches('.')) })).collect::<Vec<_>>().join(" ")))
    };
    out.push(i);

    // 15 Total records
    let mut i = mk("15", "Total records", "Give the number of records found in each source.");
    i = if all.is_empty() {
        Item { status: "missing".into(), rule: "No searches yet.".into(), ..i }
    } else {
        done(i, "Counted per source from each import.", Some(format!("The searches found {} ({}).", plural(r.totals.identified, "record", "records"), all.iter().map(|s| format!("{} {}", s.name, thousands(s.records))).collect::<Vec<_>>().join("; "))))
    };
    i.evidence.push(Link::to("PRISMA flow", "overview", None));
    out.push(i);

    // 16 Deduplication
    let mut i = mk("16", "Deduplication", "Describe how duplicates were removed, with the software used.");
    i = if all.is_empty() {
        Item { status: "missing".into(), rule: "No records yet.".into(), ..i }
    } else {
        done(i, "Key's matcher is the method; the counts come from the review.", Some(format!("{} In total {} duplicates were removed, leaving {}.", r.dedup_method, thousands(r.totals.duplicates), plural(r.totals.after_dedup, "record", "records"))))
    };
    i.evidence.push(Link::to("Sources › Duplicates", "sources", Some("duplicates")));
    out.push(i);
    for i in out.iter_mut() {
        crate::checklist::attach_note(state, i);
    }
    out
}

// ── Outputs ─────────────────────────────────────────────────────────────────────────

impl Report {
    pub fn markdown(&self, state: &State) -> String {
        let mut out = format!("# Search report: {}\n\nAppendix reporting the literature search following PRISMA-S. Generated by {} on {}.\n\n", state.info.name, software(), date(crate::events::now_ms()));
        out.push_str(&format!("## Summary\n\n{} records from {} databases and registers; {} duplicates removed; {} after de-duplication. {} records from other methods.\n\n", thousands(self.totals.identified), self.sources.len(), thousands(self.totals.duplicates), thousands(self.totals.after_dedup), thousands(self.totals.other_methods)));
        out.push_str("| Source | Type | Platform | Coverage | Date searched | Records |\n| --- | --- | --- | --- | --- | --- |\n");
        for s in &self.sources {
            out.push_str(&format!("| {} | {} | {} | {} | {} | {} |\n", md_cell(&s.name), if s.group == "registers" { "Register" } else { "Database" }, md_cell(or_dash(&s.platform)), md_cell(or_dash(&s.coverage)), or_dash(&s.searched), thousands(s.records)));
        }
        out.push('\n');
        out.push_str("## Databases and registers\n\n");
        for s in &self.sources {
            out.push_str(&format!("### {}{}\n\n", s.name, if s.update { " (update search)" } else { "" }));
            out.push_str(&format!("- Platform: {}\n- Coverage: {}\n- Date searched: {}\n- Records: {}\n", or_dash(&s.platform), or_dash(&s.coverage), or_dash(&s.searched), thousands(s.records)));
            if !s.searcher.is_empty() {
                out.push_str(&format!("- Searched by: {}\n", s.searcher));
            }
            let limits = if s.limits.is_empty() { if s.no_limits || s.key_run { "none".to_string() } else { "not stated".to_string() } } else { s.limits.iter().map(|l| if l.justification.trim().is_empty() { l.value.clone() } else { format!("{} (reason: {})", l.value, l.justification.trim()) }).collect::<Vec<_>>().join("; ") };
            out.push_str(&format!("- Limits: {limits}\n"));
            if !s.filters.is_empty() {
                out.push_str(&format!("- Search filters: {}\n", s.filters.iter().map(|f| format!("{} ({}{})", f.name, f.citation, if f.modified { ", modified" } else { "" })).collect::<Vec<_>>().join("; ")));
            }
            out.push('\n');
            if !s.queries.is_empty() {
                out.push_str("| # | Query as sent | Reported | Kept |\n| --- | --- | --- | --- |\n");
                for q in &s.queries {
                    out.push_str(&format!("| {} | `{}` | {} | {} |\n", q.n, md_cell(&q.native.replace('`', "'")), q.reported.map(|n| n.to_string()).unwrap_or_else(|| "n/a".into()), q.kept.map(|n| n.to_string()).unwrap_or_else(|| "n/a".into())));
                }
                out.push('\n');
            } else if !s.strategy.is_empty() {
                out.push_str(&format!("```\n{}\n```\n\n", s.strategy));
            } else {
                out.push_str("Strategy not recorded.\n\n");
            }
            if !s.decomposition.is_empty() {
                out.push_str("How Key ran the full search on this service:\n\n");
                for (i, step) in s.decomposition.iter().enumerate() {
                    out.push_str(&format!("{}. {}\n", i + 1, step));
                }
                out.push('\n');
            }
            if s.post_filter {
                out.push_str("Records were checked locally against the full search after retrieval; those not matching it were removed.\n\n");
            }
            for a in &s.approximate {
                out.push_str(&format!("- Approximation: {a}\n"));
            }
            if !s.approximate.is_empty() {
                out.push('\n');
            }
            if !s.notes.is_empty() {
                out.push_str(&format!("{}\n\n", s.notes));
            }
        }
        if !self.other_methods.is_empty() {
            out.push_str("## Other methods\n\n| Method | What was done | Date | Records |\n| --- | --- | --- | --- |\n");
            for s in &self.other_methods {
                out.push_str(&format!("| {} | {} | {} | {} |\n", md_cell(&s.name), md_cell(or_dash(if s.notes.is_empty() { &s.strategy } else { &s.notes })), or_dash(&s.searched), thousands(s.records)));
            }
            out.push('\n');
        }
        if !self.updates.is_empty() {
            out.push_str("## Search updates\n\n| Search | Date | New records | Already in the review |\n| --- | --- | --- | --- |\n");
            for u in &self.updates {
                out.push_str(&format!("| {} | {} | {} | {} |\n", md_cell(&u.search), date(u.at), u.added, u.known));
            }
            out.push('\n');
        }
        if !self.prior.is_empty() {
            out.push_str("## Prior work\n\n");
            for p in &self.prior {
                out.push_str(&format!("- {}: {}\n", p.how.trim(), p.citation.trim()));
            }
            out.push('\n');
        }
        out.push_str("## Peer review of the search\n\n");
        if self.peer_reviews.is_empty() {
            out.push_str("Not recorded.\n\n");
        }
        for p in &self.peer_reviews {
            out.push_str(&format!("- {} on {} ({}): {}{}\n", p.by.trim(), p.date.trim(), if p.tool.trim().is_empty() { "PRESS 2015" } else { p.tool.trim() }, or_dash(p.outcome.trim()), if p.notes.trim().is_empty() { String::new() } else { format!(". {}", p.notes.trim()) }));
        }
        if !self.peer_reviews.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!("## De-duplication\n\n{}\n\n", self.dedup_method));
        out.push_str("## PRISMA-S checklist\n\n| # | Item | Status | Reported |\n| --- | --- | --- | --- |\n");
        for i in &self.items {
            out.push_str(&format!("| {} | {} | {} | {} |\n", i.id, i.topic, crate::checklist::status_label(&i.status), md_cell(i.draft.as_deref().unwrap_or(&i.rule))));
        }
        out.push_str("\nPRISMA-S: Rethlefsen ML, Kirtley S, Waffenschmidt S, et al. PRISMA-S: an extension to the PRISMA Statement for Reporting Literature Searches in Systematic Reviews. Syst Rev. 2021;10:39. CC BY 4.0. Item wording here is Key's paraphrase.\n");
        out
    }

    pub fn csv(&self) -> String {
        let mut out = csv_line(&["Source", "Type", "Platform", "Coverage", "Date searched", "Records", "Limits", "Filters", "Strategy", "Update", "Still needed"].map(String::from));
        for s in self.sources.iter().chain(self.other_methods.iter()) {
            out.push_str(&csv_line(&[
                s.name.clone(),
                match s.group.as_str() {
                    "registers" => "Register".into(),
                    "other" => "Other method".into(),
                    _ => "Database".into(),
                },
                s.platform.clone(),
                s.coverage.clone(),
                s.searched.clone(),
                s.records.to_string(),
                s.limits.iter().map(|l| l.value.clone()).collect::<Vec<_>>().join("; "),
                s.filters.iter().map(|f| f.name.clone()).collect::<Vec<_>>().join("; "),
                if s.queries.is_empty() { s.strategy.clone() } else { s.queries.iter().map(|q| q.native.clone()).collect::<Vec<_>>().join(" ;; ") },
                if s.update { "yes".into() } else { String::new() },
                s.missing.join("; "),
            ]));
        }
        out.push_str(&csv_line(&["Total identified (databases and registers)".into(), String::new(), String::new(), String::new(), String::new(), self.totals.identified.to_string()]));
        out.push_str(&csv_line(&["Duplicates removed".into(), String::new(), String::new(), String::new(), String::new(), self.totals.duplicates.to_string()]));
        out.push_str(&csv_line(&["After de-duplication".into(), String::new(), String::new(), String::new(), String::new(), self.totals.after_dedup.to_string()]));
        out
    }

    pub fn json(&self, state: &State) -> String {
        serde_json::to_string_pretty(&json!({ "format": "key-prisma-s", "version": 1, "review": state.info.name, "generatedBy": software(), "report": self })).unwrap_or_default()
    }
}

fn or_dash(s: &str) -> &str {
    if s.trim().is_empty() { "not stated" } else { s }
}

impl Reviews {
    pub fn search_report(&self, review: &str, strategies: &HashMap<String, Json>) -> Result<Json> {
        self.read(review, |state, _| Ok(json!(report(state, strategies))))
    }

    /// PRISMA-S details of a source (patch: the fields given replace those kept).
    pub fn set_source_detail(&self, review: &str, detail: Json, actor: &str) -> Result<()> {
        let batch = detail.get("batchId").and_then(Json::as_str).unwrap_or("").to_string();
        self.write(review, |state, _, b| {
            state.batch(&batch).ok_or("This import no longer exists")?;
            if detail.get("searchedAt").and_then(Json::as_str).is_some_and(|d| !d.trim().is_empty() && when_ms(d).is_none()) {
                return Err("Give the date searched as YYYY-MM-DD".into());
            }
            Ok((vec![b.event("search.source", actor, None, detail.clone())], ()))
        })
    }

    pub fn set_peer_review(&self, review: &str, mut entry: Json, actor: &str) -> Result<String> {
        if entry.get("id").and_then(Json::as_str).is_none_or(str::is_empty) {
            entry["id"] = json!(crate::events::short_id("pr"));
        }
        let deleted = entry.get("deleted").and_then(Json::as_bool).unwrap_or(false);
        if !deleted && entry.get("by").and_then(Json::as_str).is_none_or(|s| s.trim().is_empty()) {
            return Err("Say who reviewed the search".into());
        }
        let id = entry["id"].as_str().unwrap_or("").to_string();
        self.write(review, |_, _, b| Ok((vec![b.event("search.peer_review", actor, None, entry.clone())], id.clone())))
    }

    pub fn set_prior_work(&self, review: &str, mut entry: Json, actor: &str) -> Result<String> {
        if entry.get("id").and_then(Json::as_str).is_none_or(str::is_empty) {
            entry["id"] = json!(crate::events::short_id("pw"));
        }
        let deleted = entry.get("deleted").and_then(Json::as_bool).unwrap_or(false);
        if !deleted && entry.get("citation").and_then(Json::as_str).is_none_or(|s| s.trim().is_empty()) {
            return Err("Give the citation of the work reused".into());
        }
        let id = entry["id"].as_str().unwrap_or("").to_string();
        self.write(review, |_, _, b| Ok((vec![b.event("search.prior", actor, None, entry.clone())], id.clone())))
    }
}
