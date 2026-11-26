// The connectors built into the app (connectors/specs at build time), and the set in use:
// for each connector the newer of the built-in and the verified downloaded version.
use crate::bundle::{self, Verified};
use crate::engine::Connector;
use crate::spec::Spec;
use std::collections::BTreeMap;
use std::sync::Arc;

include!(concat!(env!("OUT_DIR"), "/baseline.rs"));

#[derive(Clone, Debug)]
pub struct Loaded {
    pub connector: Connector,
    /// "baseline" or "update".
    pub origin: String,
}

/// The built-in specs; a spec that does not validate is left out (and reported).
pub fn baseline() -> (Vec<Connector>, Vec<String>) {
    let mut out = Vec::new();
    let mut problems = Vec::new();
    for (file, text) in BASELINE {
        match Spec::parse(text) {
            Ok(spec) => out.push(Connector { sha256: bundle::sha256_hex(text.as_bytes()), spec: Arc::new(spec) }),
            Err(p) => problems.push(format!("{file}: {}", p.join("; "))),
        }
    }
    (out, problems)
}

/// Built-in and downloaded connectors combined: the higher version of each wins.
pub fn combine(update: Option<&Verified>) -> BTreeMap<String, Loaded> {
    let mut out: BTreeMap<String, Loaded> = BTreeMap::new();
    for connector in baseline().0 {
        out.insert(connector.spec.id.clone(), Loaded { connector, origin: "baseline".into() });
    }
    if let Some(update) = update {
        for (spec, sha) in &update.specs {
            let newer = out.get(&spec.id).is_none_or(|have| newer_version(&spec.version, &have.connector.spec.version));
            if newer {
                out.insert(spec.id.clone(), Loaded { connector: Connector { spec: Arc::new(spec.clone()), sha256: sha.clone() }, origin: "update".into() });
            }
        }
    }
    out
}

fn newer_version(a: &str, b: &str) -> bool {
    crate::version_at_least(a, b) && a != b
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_built_in_spec_validates() {
        let (connectors, problems) = super::baseline();
        assert!(problems.is_empty(), "{problems:#?}");
        let mut ids: Vec<&str> = connectors.iter().map(|c| c.spec.id.as_str()).collect();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "a connector id is used twice");
    }
}
