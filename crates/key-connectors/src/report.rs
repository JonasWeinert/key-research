// The run log of a database search, for PRISMA-style reporting: what was asked where (the
// neutral query and each service's native string), when, how many records each source
// returned, how many duplicates were removed, and every record with its provenance.
use crate::merge::Merger;
use crate::query::Query;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
}
