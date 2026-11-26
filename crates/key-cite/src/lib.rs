//! Key's citation engine: sources as CSL-JSON (`csl_json`), the bundled and installed CSL
//! styles and locales (`styles`, the shipped data files in `data`), and citations and bibliographies rendered with hayagriva's
//! CSL processor as text, HTML and RTF (`render`). `check` is
//! the rule-based reference checker.
pub mod check;
pub mod data;
pub mod csl_json;
pub mod render;
pub mod styles;

pub use render::{CitationInput, CiteItem, Formatted, RenderOutput, RenderRequest, render};
pub use styles::{StyleSummary, Styles};

/// The style used when none is chosen.
pub const DEFAULT_STYLE: &str = "apa";
