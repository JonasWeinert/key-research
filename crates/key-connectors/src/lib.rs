//! Database search connectors: declarative JSON specs (see `connectors/SPEC.md`) that say how to
//! query a scholarly database, executed by a small engine with a fixed set of safe operations and
//! named built-in adapters. Specs are distributed as an Ed25519-signed bundle (`bundle`); the app
//! ships a baseline bundle built from `connectors/specs` (`baseline`).
//!
//! Nothing here reads keys from a keychain or talks to the user: the host passes credentials in
//! and sends every request through a [`Transport`] (the safe HTTP client, or recorded answers).

pub mod baseline;
pub mod bundle;
pub mod engine;
pub mod extract;
pub mod fixtures;
pub mod merge;
pub mod net;
pub mod paths;
pub mod query;
pub mod record;
pub mod report;
pub mod schema;
pub mod spec;
pub mod template;
pub mod testing;
pub mod time;
pub mod xml;

/// The engine's own version: specs say the oldest engine they work with (`minEngine`).
pub const ENGINE_VERSION: &str = "1.0.0";
/// The spec format this engine reads.
pub const SPEC_FORMAT: u64 = 1;

pub use engine::{Connector, Credentials, Engine, Fetched, Request, Response, RunControl, SearchState, Transport, TransportError};
pub use query::{Field, Query, Term, Translation};
pub use record::Record;
pub use spec::Spec;

/// `a.b.c` versions compared numerically (missing parts are 0).
pub fn version_at_least(have: &str, need: &str) -> bool {
    let parse = |v: &str| v.split(|c: char| c == '.' || c == '-' || c == '+').take(3).map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (mut a, mut b) = (parse(have), parse(need));
    a.resize(3, 0);
    b.resize(3, 0);
    a >= b
}

#[cfg(test)]
mod tests {
    #[test]
    fn versions_compare_numerically() {
        assert!(super::version_at_least("1.10.0", "1.9.3"));
        assert!(super::version_at_least("1.0", "1.0.0"));
        assert!(!super::version_at_least("0.9.9", "1.0.0"));
    }
}
