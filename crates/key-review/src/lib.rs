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
pub mod stats;
pub mod store;
pub mod templates;
pub mod views;
// std-D: advanced synthesis and interop.
pub mod conversions;
pub mod linalg;
pub mod metareg;
pub mod multilevel;
pub mod pubbias;
pub mod sensitivity;
// std-D end.

pub use ops::{Library, NoLibrary};
pub use store::Reviews;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_records;
