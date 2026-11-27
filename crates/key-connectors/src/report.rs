// The run log of a database search, for PRISMA-style reporting: what was asked where (the
// neutral query and each service's native string), when, how many records each source
// returned, how many duplicates were removed, and every record with its provenance.
use crate::merge::Merger;
use crate::plan::Strategy;
use crate::query::Query;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SourceLog {
    pub connector: String,
    pub name: String,
    pub version: String,
    pub native: String,
    pub chunks: Vec<String>,
    pub warnings: Vec<String>,
    /// What the service reported.
    pub total: Option<u64>,
    /// Records read from it (after Key's local filter, where one applies).
    pub fetched: usize,
    /// Items the service sent before local filtering.
    pub raw: usize,
    pub requests: u32,
    pub state: String,
    pub error: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    /// How the search was run on this service (queries, reconstruction, limits).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy: Option<Strategy>,
    /// Per query sent (same order as `chunks`): what the service reported, items read, kept.
    pub chunk_totals: Vec<Option<u64>>,
    pub chunk_raw: Vec<usize>,
    pub chunk_kept: Vec<usize>,
    /// Ruled out by Key's check of the full search.
    pub rejected: usize,
    /// Kept although a part could not be checked (a missing abstract...).
    pub unverified: usize,
    /// Brought again by a later query of the same search (kept once).
    pub repeats: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordLog {
    pub key: String,
    pub title: String,
    pub authors: String,
    pub year: Option<i64>,
    pub venue: Option<String>,
    pub doi: Option<String>,
    pub url: Option<String>,
    pub found_by: Vec<String>,
    pub source_ids: Vec<String>,
    pub in_library: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunReport {
    pub run_id: String,
    pub label: String,
    pub engine: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub state: String,
    pub query: Query,
    pub sources: Vec<SourceLog>,
    pub fetched: usize,
    pub unique: usize,
    pub duplicates_removed: usize,
    pub records: Vec<RecordLog>,
    /// What reruns this search: `{ query, connectors, options, overrides }`.
    pub rerun: Json,
}

impl RunReport {
    pub fn records_from(merger: &Merger) -> Vec<RecordLog> {
        merger
            .groups
            .iter()
            .map(|g| RecordLog {
                key: g.key.clone(),
                title: g.record.title.clone(),
                authors: g.record.authors.join("; "),
                year: g.record.year,
                venue: g.record.venue.clone(),
                doi: g.record.doi.clone(),
                url: g.record.url.clone(),
                found_by: g.found_by.clone(),
                source_ids: g.versions.iter().map(|v| format!("{}:{}", v.connector, v.record.source_id)).collect(),
                in_library: None,
            })
            .collect()
    }

    pub fn json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }

    /// One row per record (and its sources), then nothing else: easy to open in a spreadsheet.
    pub fn csv(&self) -> String {
        let mut out = String::from("key,title,authors,year,venue,doi,url,found_by,source_ids,in_library\n");
        for r in &self.records {
            let row = [
                r.key.clone(),
                r.title.clone(),
                r.authors.clone(),
                r.year.map(|y| y.to_string()).unwrap_or_default(),
                r.venue.clone().unwrap_or_default(),
                r.doi.clone().unwrap_or_default(),
                r.url.clone().unwrap_or_default(),
                r.found_by.join("; "),
                r.source_ids.join("; "),
                r.in_library.clone().unwrap_or_default(),
            ];
            out.push_str(&row.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(","));
            out.push('\n');
        }
        out
    }

    /// The search log as a table, for a note or a methods section.
    pub fn markdown(&self) -> String {
        let date = crate::time::format(self.started_at / 1000);
        let mut out = format!("**Database search** ({} UTC)\n\n", date.replace('T', " ").trim_end_matches('Z'));
        out.push_str("| Source | Query as sent | Reported | Records |\n| --- | --- | --- | --- |\n");
        for s in &self.sources {
            let native = if s.native.is_empty() { "(harvested, filtered by Key)".to_string() } else { s.native.replace('|', "\\|") };
            let total = s.total.map(|t| t.to_string()).unwrap_or_else(|| "n/a".into());
            let fetched = match &s.error {
                Some(e) => format!("{} (failed: {})", s.fetched, e.replace('|', "/")),
                None => s.fetched.to_string(),
            };
            out.push_str(&format!("| {} {} | `{}` | {} | {} |\n", s.name, s.version, native, total, fetched));
        }
        out.push_str(&format!("\nRecords found: {}. Duplicates removed: {}. Unique records: {}.\n", self.fetched, self.duplicates_removed, self.unique));
        out
    }
}

fn when(ms: i64) -> String {
    crate::time::format(ms / 1000).replace('T', " ").trim_end_matches('Z').to_string() + " UTC"
}

fn limits(query: &Query) -> Vec<String> {
    let f = &query.filters;
    let mut out = Vec::new();
    match (f.year_from, f.year_to) {
        (Some(a), Some(b)) => out.push(format!("years {a}\u{2013}{b}")),
        (Some(a), None) => out.push(format!("from {a}")),
        (None, Some(b)) => out.push(format!("until {b}")),
        _ => {}
    }
    if !f.types.is_empty() {
        out.push(format!("document types: {}", f.types.join(", ")));
    }
    if !f.languages.is_empty() {
        out.push(format!("languages: {}", f.languages.join(", ")));
    }
    if f.open_access == Some(true) {
        out.push("open access only".into());
    }
    out
}

fn count(n: Option<u64>) -> String {
    n.map(|n| n.to_string()).unwrap_or_else(|| "n/a".into())
}

/// The search strategy for a methods section: per database the exact strings sent, when, the
/// counts per query, and where Key split or checked the search, the reconstruction in words.
impl RunReport {
    pub fn original(&self) -> String {
        crate::boolean::format(&self.query.tree())
    }

    fn queries(s: &SourceLog) -> Vec<(String, String)> {
        match &s.strategy {
            Some(st) if !st.subqueries.is_empty() && (s.chunks.is_empty() || st.subqueries.len() == s.chunks.len()) => st.subqueries.iter().map(|q| (q.native.clone(), q.neutral.clone())).collect(),
            _ if !s.chunks.is_empty() => s.chunks.iter().map(|c| (c.clone(), String::new())).collect(),
            _ => vec![(s.native.clone(), String::new())],
        }
    }

    pub fn strategy_markdown(&self) -> String {
        let mut out = String::from("## Search strategy\n\n");
        if self.started_at > 0 {
            out.push_str(&format!("Run on {} with Key (search engine {}).\n\n", when(self.started_at), self.engine));
        }
        out.push_str(&format!("Full search: `{}`\n\n", self.original().replace('`', "'")));
        let l = limits(&self.query);
        if !l.is_empty() {
            out.push_str(&format!("Limits: {}.\n\n", l.join("; ")));
        }
        for s in &self.sources {
            out.push_str(&format!("### {}{}\n\n", s.name, if s.version.is_empty() { String::new() } else { format!(" (connector {})", s.version) }));
            if let Some(at) = s.started_at {
                out.push_str(&format!("Searched {}.\n\n", when(at)));
            }
            let queries = Self::queries(s);
            let ran = self.started_at > 0;
            if ran {
                out.push_str("| # | Query as sent | Reported | Read | Kept |\n| --- | --- | --- | --- | --- |\n");
            } else {
                out.push_str("| # | Query as sent |\n| --- | --- |\n");
            }
            for (i, (native, _)) in queries.iter().enumerate() {
                let native = if native.is_empty() { "(no query: the source is read in full and filtered by Key)".to_string() } else { format!("`{}`", native.replace('|', "\\|").replace('`', "'")) };
                if ran {
                    out.push_str(&format!("| {} | {} | {} | {} | {} |\n", i + 1, native, count(s.chunk_totals.get(i).copied().flatten()), s.chunk_raw.get(i).map(|n| n.to_string()).unwrap_or_else(|| "n/a".into()), s.chunk_kept.get(i).map(|n| n.to_string()).unwrap_or_else(|| "n/a".into())));
                } else {
                    out.push_str(&format!("| {} | {} |\n", i + 1, native));
                }
            }
            out.push('\n');
            if let Some(st) = &s.strategy {
                if st.post_filter || queries.len() > 1 {
                    out.push_str("How Key reconstructed the full search:\n\n");
                    for (i, step) in st.steps.iter().enumerate() {
                        out.push_str(&format!("{}. {}\n", i + 1, step));
                    }
                    out.push('\n');
                }
                if !st.approximate.is_empty() {
                    out.push_str("Approximate:\n\n");
                    for a in &st.approximate {
                        out.push_str(&format!("- {a}\n"));
                    }
                    out.push('\n');
                }
                if let Some(d) = &st.decision {
                    out.push_str(&format!("Note: {}\n\n", d.message));
                }
            }
            if ran {
                let mut line = format!("Records kept: {}", s.fetched);
                if s.rejected > 0 {
                    line.push_str(&format!("; ruled out by Key's check: {}", s.rejected));
                }
                if s.repeats > 0 {
                    line.push_str(&format!("; found by more than one query (kept once): {}", s.repeats));
                }
                if s.unverified > 0 {
                    line.push_str(&format!("; kept although not fully checkable: {}", s.unverified));
                }
                if let Some(e) = &s.error {
                    line.push_str(&format!("; failed: {e}"));
                }
                out.push_str(&line);
                out.push_str(".\n\n");
            }
            for w in &s.warnings {
                if !s.strategy.as_ref().is_some_and(|st| st.approximate.contains(w)) {
                    out.push_str(&format!("- {w}\n"));
                }
            }
            if !s.warnings.is_empty() {
                out.push('\n');
            }
        }
        if self.started_at > 0 {
            out.push_str(&format!("Across databases: {} records found, {} duplicates removed, {} unique records.\n", self.fetched, self.duplicates_removed, self.unique));
        }
        out
    }

    /// The same as plain text (no Markdown table syntax).
    pub fn strategy_text(&self) -> String {
        self.strategy_markdown()
            .lines()
            .filter(|l| !l.starts_with("| ---") && !l.starts_with("| # "))
            .map(|l| {
                let l = l.trim_start_matches('#').trim_start();
                if l.starts_with('|') {
                    let cells: Vec<&str> = l.trim_matches('|').split(" | ").map(str::trim).collect();
                    let mut line = format!("Query {}: {}", cells.first().unwrap_or(&""), cells.get(1).unwrap_or(&"").trim_matches('`'));
                    if cells.len() >= 5 {
                        line.push_str(&format!(" (reported {}, read {}, kept {})", cells[2], cells[3], cells[4]));
                    }
                    line
                } else {
                    l.replace('`', "")
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Machine-readable; `rerun` (query, databases, options) lets Key run it again.
    pub fn strategy_json(&self) -> String {
        let databases: Vec<Json> = self
            .sources
            .iter()
            .map(|s| {
                let queries: Vec<Json> = Self::queries(s)
                    .iter()
                    .enumerate()
                    .map(|(i, (native, neutral))| json!({ "n": i + 1, "native": native, "neutral": neutral, "reported": s.chunk_totals.get(i).copied().flatten(), "read": s.chunk_raw.get(i), "kept": s.chunk_kept.get(i) }))
                    .collect();
                json!({
                    "connector": s.connector, "name": s.name, "version": s.version, "startedAt": s.started_at, "finishedAt": s.finished_at, "state": s.state, "error": s.error,
                    "strategy": s.strategy.as_ref().map(|st| st.kind.clone()), "queries": queries,
                    "postFilter": s.strategy.as_ref().is_some_and(|st| st.post_filter), "reconstruction": s.strategy.as_ref().map(|st| st.steps.clone()).unwrap_or_default(),
                    "approximate": s.strategy.as_ref().map(|st| st.approximate.clone()).unwrap_or_default(),
                    "reported": s.total, "kept": s.fetched, "read": s.raw, "ruledOut": s.rejected, "repeats": s.repeats, "unverified": s.unverified, "warnings": s.warnings,
                })
            })
            .collect();
        serde_json::to_string_pretty(&json!({
            "format": "key-search-strategy", "version": 1, "label": self.label, "runId": if self.run_id.is_empty() { Json::Null } else { json!(self.run_id) },
            "ranAt": (self.started_at > 0).then_some(self.started_at), "engine": self.engine, "search": self.original(), "limits": limits(&self.query),
            "databases": databases,
            "totals": if self.started_at > 0 { json!({ "found": self.fetched, "duplicatesRemoved": self.duplicates_removed, "unique": self.unique }) } else { Json::Null },
            "rerun": self.rerun,
        }))
        .unwrap_or_default()
    }

    /// One row per database and query.
    pub fn strategy_csv(&self) -> String {
        let mut out = String::from("database,connector_version,query_number,query_as_sent,key_syntax,reported,read,kept,approximate\n");
        for s in &self.sources {
            let approx = s.strategy.as_ref().map(|st| st.approximate.join("; ")).unwrap_or_default();
            for (i, (native, neutral)) in Self::queries(s).iter().enumerate() {
                let row = [
                    s.name.clone(),
                    s.version.clone(),
                    (i + 1).to_string(),
                    native.clone(),
                    neutral.clone(),
                    s.chunk_totals.get(i).copied().flatten().map(|n| n.to_string()).unwrap_or_default(),
                    s.chunk_raw.get(i).map(|n| n.to_string()).unwrap_or_default(),
                    s.chunk_kept.get(i).map(|n| n.to_string()).unwrap_or_default(),
                    approx.clone(),
                ];
                out.push_str(&row.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(","));
                out.push('\n');
            }
        }
        out
    }
}

fn csv_cell(text: &str) -> String {
    let text = text.replace(['\r', '\n'], " ");
    // A leading formula character would run in a spreadsheet.
    let text = if text.starts_with(['=', '+', '-', '@']) { format!("'{text}") } else { text };
    if text.contains([',', '"']) { format!("\"{}\"", text.replace('"', "\"\"")) } else { text }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_quotes_and_neutralises_formulas() {
        assert_eq!(csv_cell("a, \"b\""), "\"a, \"\"b\"\"\"");
        assert_eq!(csv_cell("=SUM(A1)"), "'=SUM(A1)");
        let report = RunReport { sources: vec![SourceLog { name: "PubMed".into(), version: "1.0.0".into(), native: "a|b".into(), total: Some(3), fetched: 3, ..Default::default() }], fetched: 3, unique: 2, duplicates_removed: 1, ..Default::default() };
        let md = report.markdown();
        assert!(md.contains("| PubMed 1.0.0 | `a\\|b` | 3 | 3 |") && md.contains("Duplicates removed: 1"), "{md}");
    }

    #[test]
    fn the_strategy_export_writes_out_queries_counts_and_reconstruction() {
        let tree = crate::boolean::parse("(health OR doctor) AND (ai OR ml) NOT regression").unwrap().tree;
        let query = Query::from_tree(tree.clone(), crate::query::Filters { year_from: Some(2015), ..Default::default() });
        let strategy = Strategy {
            kind: "split".into(),
            subqueries: vec![
                crate::plan::SubQueryInfo { native: "health AND ai".into(), neutral: "health AND ai".into(), ..Default::default() },
                crate::plan::SubQueryInfo { native: "doctor AND ml".into(), neutral: "doctor AND ml".into(), ..Default::default() },
            ],
            post_filter: true,
            steps: vec!["Split into 2 queries".into(), "Key keeps only the records that match the full search".into()],
            approximate: vec!["abstract:x cannot be checked exactly".into()],
            ..Default::default()
        };
        let report = RunReport {
            started_at: 1_764_000_000_000,
            engine: "1.0.0".into(),
            query,
            sources: vec![SourceLog { name: "Simple".into(), version: "1.0.0".into(), chunks: vec!["health AND ai".into(), "doctor AND ml".into()], strategy: Some(strategy), chunk_totals: vec![Some(10), Some(5)], chunk_raw: vec![10, 5], chunk_kept: vec![8, 3], rejected: 2, repeats: 2, fetched: 11, ..Default::default() }],
            fetched: 11,
            unique: 11,
            rerun: json!({ "query": { "expr": tree }, "connectors": ["simple"] }),
            ..Default::default()
        };
        let md = report.strategy_markdown();
        for want in ["Full search: `(health OR doctor) AND (ai OR ml) NOT regression`", "Limits: from 2015", "| 2 | `doctor AND ml` | 5 | 5 | 3 |", "1. Split into 2 queries", "Approximate:", "ruled out by Key's check: 2", "kept once): 2"] {
            assert!(md.contains(want), "{want}\n{md}");
        }
        let text = report.strategy_text();
        assert!(text.contains("Query 2: doctor AND ml (reported 5, read 5, kept 3)") && !text.contains('|'), "{text}");
        let json: Json = serde_json::from_str(&report.strategy_json()).unwrap();
        assert_eq!(json["databases"][0]["queries"][1]["kept"], 3);
        assert_eq!(json["rerun"]["connectors"][0], "simple");
        let back: Query = serde_json::from_value(json["rerun"]["query"].clone()).unwrap();
        assert_eq!(back.tree(), report.query.tree());
        let csv = report.strategy_csv();
        assert!(csv.lines().nth(2).unwrap().starts_with("Simple,1.0.0,2,doctor AND ml,doctor AND ml,5,5,3,"), "{csv}");
    }
}
