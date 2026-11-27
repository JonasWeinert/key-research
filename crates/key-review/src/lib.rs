// Systematic reviews (docs/review-design.md): an append-only event log per review in its own
// SQLite file, derived state for screening, PRISMA 2020 counts, extraction, exports and
// meta-analysis. The desktop host exposes it as `review_*` commands.
pub mod ai;
pub mod derive;
pub mod events;
pub mod export;
pub mod import;
pub mod logic;
pub mod meta;
pub mod model;
pub mod ops;
pub mod prisma;
pub mod records;
pub mod rules;
pub mod selection;
pub mod stats;
pub mod store;
pub mod templates;
pub mod views;
// std-A: reporting (PRISMA 2020 checklist, protocol, PRISMA-S search report)
pub mod checklist;
pub mod protocol_doc;
pub mod report_text;
pub mod reporting;
pub mod reporting_hooks;
pub mod search_report;
// std-C: risk of bias, certainty of evidence (GRADE) and their host commands.
pub mod certainty;
pub mod grade;
pub mod rob;
// end std-C

// std-B: citation chasing, AI-use audit, conduct checks, extraction pilots and contacts.
pub mod ai_audit;
pub mod chasing;
pub mod conduct;
pub mod xpilot;
// std-D: advanced synthesis and interop.
pub mod conversions;
pub mod dependence;
pub mod interop;
pub mod linalg;
pub mod metareg;
pub mod migrate;
pub mod multilevel;
pub mod pubbias;
pub mod revman;
pub mod rscript;
pub mod sensitivity;
pub mod synthesis;
// std-D end.

pub use ops::{Library, NoLibrary};
pub use store::Reviews;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_records;
// std-B
#[cfg(test)]
mod tests_std_b;
// std-A
#[cfg(test)]
mod tests_reporting;
// std-C
#[cfg(test)]
mod tests_certainty;
#[cfg(test)]
mod tests_interop;
