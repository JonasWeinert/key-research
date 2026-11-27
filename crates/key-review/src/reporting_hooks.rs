// std-A: what the reporting views read from other parts of the review tool, and their exports.
// `facts` merges each part's `reporting_facts(state)` (agreed shapes, all keys optional):
//   std-B (conduct.rs): "ai" { used, statement, results, stages, models }, "citation" { statement,
//     batches }, "contacts" { statement, count }, "extractionPilot" { statement, kappa, percent },
//     "warnings" [{ standard, message, fix }]
//   std-C (rob.rs): "rob" { statement, results, tools, assessed, usedInAnalysis },
//     "grade" { statement, results, outcomes, sof }
//   std-D (interop.rs): "analysis" { statement, results, metaRegression, sensitivity,
//     publicationBias, conversions }, "sharing" { statement, rScript, revman, bundle }
// Until a part is merged its line stays a stub and the checklist says "Not recorded yet".
use crate::derive::State;
use crate::store::Result;
use serde_json::{Map, Value as Json};

fn merge(into: &mut Map<String, Json>, facts: Json) {
    if let Json::Object(m) = facts {
        for (k, v) in m {
            if !v.is_null() {
                into.insert(k, v);
            }
        }
    }
}

pub fn facts(state: &State) -> Json {
    let _ = state;
    let mut out = Map::new();
    // std-B: replace Json::Null with crate::conduct::reporting_facts(state)
    merge(&mut out, Json::Null);
    // std-C: replace Json::Null with crate::rob::reporting_facts(state)
    merge(&mut out, Json::Null);
    // std-D: replace Json::Null with crate::interop::reporting_facts(state)
    merge(&mut out, Json::Null);
    Json::Object(out)
}

/// The export kinds of the reporting documents.
pub const EXPORTS: &[&str] = &[
    "prisma-checklist",
    "prisma-checklist-html",
    "prisma-checklist-csv",
    "methods-draft",
    "protocol",
    "protocol-html",
    "prospero-sheet",
    "osf-prereg",
    "deviations",
    "deviations-md",
    "search-report",
    "search-report-html",
    "search-report-csv",
    "search-report-json",
];

/// One export as (file name, content, mime). Search runs' own logs are not at hand here, so the
/// search report uses each import's stored strategy (the host's `review_search_report_export`
/// adds the runs' logs).
pub fn export(state: &State, kind: &str) -> Result<(String, String, &'static str)> {
    export_with(state, kind, &Default::default())
}

pub fn export_with(state: &State, kind: &str, strategies: &std::collections::HashMap<String, Json>) -> Result<(String, String, &'static str)> {
    if let Some(found) = crate::protocol_doc::export(state, kind) {
        return Ok(found);
    }
    let base = crate::export::slug(&state.info.name);
    Ok(match kind {
        "prisma-checklist" | "prisma-checklist-html" | "prisma-checklist-csv" | "methods-draft" => {
            let c = crate::checklist::compute(state, strategies);
            match kind {
                "prisma-checklist" => (format!("{base}-prisma-checklist.md"), c.markdown(state), "text/markdown"),
                "prisma-checklist-html" => (format!("{base}-prisma-checklist.html"), crate::report_text::html("PRISMA checklist", &c.markdown(state)), "text/html"),
                "prisma-checklist-csv" => (format!("{base}-prisma-checklist.csv"), c.csv(), "text/csv"),
                _ => (format!("{base}-methods-draft.md"), c.methods_markdown(state), "text/markdown"),
            }
        }
        "search-report" | "search-report-html" | "search-report-csv" | "search-report-json" => {
            let r = crate::search_report::report(state, strategies);
            match kind {
                "search-report" => (format!("{base}-search-report.md"), r.markdown(state), "text/markdown"),
                "search-report-html" => (format!("{base}-search-report.html"), crate::report_text::html("Search report", &r.markdown(state)), "text/html"),
                "search-report-csv" => (format!("{base}-search-report.csv"), r.csv(), "text/csv"),
                _ => (format!("{base}-search-report.json"), r.json(state), "application/json"),
            }
        }
        other => return Err(format!("Unknown export {other}")),
    })
}
