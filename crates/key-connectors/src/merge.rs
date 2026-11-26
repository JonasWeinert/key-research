// Records from several connectors merged into works, with key-store's duplicate matcher (the
// one definition of "same work" in Key: identifiers first, then title, year and first author).
// A trial registration and a paper are never merged; a preprint and its published version stay
// two works (key-store calls them versions).
use crate::record::Record;
use key_store::duplicates::{MatchKind, WorkIndex};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One record as one connector returned it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub connector: String,
    pub version: String,
    pub record: Record,
    /// The native query (chunk) that found it.
    pub query: String,
    pub at: i64,
    pub rank: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Merged {
    pub key: String,
    /// The fullest reading: the longest abstract (then one with a DOI), gaps filled from the rest.
    pub record: Record,
    pub versions: Vec<Found>,
    pub found_by: Vec<String>,
}

#[derive(Default)]
pub struct Merger {
    index: WorkIndex,
    pub groups: Vec<Merged>,
    by_source: HashMap<String, usize>,
    by_key: HashMap<String, usize>,
}

fn is_trial(r: &Record) -> bool {
    r.kind.as_deref() == Some("trial")
}

fn better(a: &Record, b: &Record) -> bool {
    let len = |r: &Record| r.abstract_.as_ref().map(|s| s.len()).unwrap_or(0);
    (len(a), a.doi.is_some(), a.authors.len()) > (len(b), b.doi.is_some(), b.authors.len())
}

impl Merger {
    /// Adds a record; answers the key of the work it belongs to.
    pub fn add(&mut self, found: Found) -> String {
        let source_key = format!("{}\u{1f}{}", found.connector, found.record.source_id);
        let at = self.by_source.get(&source_key).copied().or_else(|| {
            let work = found.record.work();
            self.index
                .find(&work)
                .into_iter()
                .filter(|m| matches!(m.kind, MatchKind::Exact | MatchKind::Likely))
                .filter_map(|m| self.by_key.get(&m.source_id).copied())
                .find(|&g| is_trial(&self.groups[g].record) == is_trial(&found.record))
        });
        match at {
            Some(g) => {
                let group = &mut self.groups[g];
                if !group.found_by.contains(&found.connector) {
                    group.found_by.push(found.connector.clone());
                }
                if better(&found.record, &group.record) {
                    let mut next = found.record.clone();
                    next.merge_from(&group.record);
                    group.record = next;
                } else {
                    group.record.merge_from(&found.record);
                }
                let key = group.key.clone();
                let exists = group.versions.iter().any(|v| v.connector == found.connector && v.record.source_id == found.record.source_id);
                if !exists {
                    group.versions.push(found);
                }
                self.by_source.insert(source_key, g);
                // The merged record may now match more (a DOI it did not have).
                let work = self.groups[g].record.work();
                self.index.add(&key, &work);
                key
            }
            None => {
                let key = format!("w{}", self.groups.len() + 1);
                let g = self.groups.len();
                self.index.add(&key, &found.record.work());
                self.groups.push(Merged { key: key.clone(), record: found.record.clone(), found_by: vec![found.connector.clone()], versions: vec![found] });
                self.by_source.insert(source_key, g);
                self.by_key.insert(key.clone(), g);
                key
            }
        }
    }

    pub fn get(&self, key: &str) -> Option<&Merged> {
        self.by_key.get(key).map(|g| &self.groups[*g])
    }

    /// Records read in all (before de-duplication).
    pub fn fetched(&self) -> usize {
        self.groups.iter().map(|g| g.versions.len()).sum()
    }

    pub fn duplicates_removed(&self) -> usize {
        self.fetched() - self.groups.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(connector: &str, id: &str, title: &str, doi: Option<&str>, abstract_: Option<&str>) -> Found {
        Found {
            connector: connector.into(),
            version: "1.0.0".into(),
            record: Record { source_id: id.into(), title: title.into(), doi: doi.map(String::from), abstract_: abstract_.map(String::from), year: Some(2021), authors: vec!["Lee, Ann".into()], ..Default::default() },
            query: "q".into(),
            at: 0,
            rank: 0,
        }
    }

    #[test]
    fn merges_by_identifier_and_title_keeps_provenance_and_the_fullest_record() {
        let mut m = Merger::default();
        let a = m.add(found("pubmed", "1", "School meals and attendance", Some("10.1/abc"), None));
        let b = m.add(found("crossref", "10.1/ABC", "School meals and attendance.", Some("https://doi.org/10.1/abc"), Some("A long abstract.")));
        let c = m.add(found("econstor", "h/1", "School Meals and Attendance", None, None));
        let d = m.add(found("econstor", "h/2", "Something else entirely", None, None));
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_ne!(a, d);
        let g = m.get(&a).unwrap();
        assert_eq!(g.found_by, vec!["pubmed", "crossref", "econstor"]);
        assert_eq!(g.record.abstract_.as_deref(), Some("A long abstract."));
        assert_eq!(m.fetched(), 4);
        assert_eq!(m.duplicates_removed(), 2);
        // The same record again from the same connector is not counted twice.
        m.add(found("pubmed", "1", "School meals and attendance", Some("10.1/abc"), None));
        assert_eq!(m.fetched(), 4);
    }

    #[test]
    fn trials_and_papers_stay_apart() {
        let mut m = Merger::default();
        let mut trial = found("registry", "T1", "School meals and attendance", None, None);
        trial.record.kind = Some("trial".into());
        let a = m.add(trial);
        let b = m.add(found("crossref", "x", "School meals and attendance", None, None));
        assert_ne!(a, b);
    }
}
