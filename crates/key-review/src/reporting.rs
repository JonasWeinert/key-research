// std-A: what the reporting views keep beside the protocol, folded from their own events:
// the protocol's registration, the reviewer's notes on checklist items (where the manuscript
// reports them), and the PRISMA-S details of each information source (platform, coverage,
// limits, filters, a pasted strategy), search peer reviews and reused prior work.
use crate::events::Event;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};
use std::collections::BTreeMap;

/// The event kinds this module derives.
pub const KINDS: &[&str] = &["protocol.register", "checklist.note", "search.source", "search.peer_review", "search.prior"];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Registration {
    /// PROSPERO | OSF | INPLASY | other registry's name.
    pub registry: String,
    pub id: String,
    /// The registration date as the registry gives it ("2026-11-27").
    pub date: String,
    pub url: String,
    /// When it was recorded in Key, by whom, and the protocol version then in force.
    pub at: i64,
    pub actor: String,
    pub version: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ChecklistNote {
    /// prisma2020 | abstract | prismas | scr
    pub list: String,
    pub item: String,
    /// Where the manuscript reports it ("Methods, p. 6").
    pub location: String,
    pub text: String,
    pub at: i64,
    pub actor: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Limit {
    /// date | language | publication type | study design | other
    pub kind: String,
    pub value: String,
    pub justification: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    pub name: String,
    pub citation: String,
    pub modified: bool,
}

/// PRISMA-S details of one information source: an import, or one database inside a run.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SourceDetail {
    pub batch_id: String,
    /// The database's name inside a multi-database run ("" for the import as a whole).
    pub source: String,
    pub platform: String,
    pub coverage: String,
    /// The date searched, when the import does not carry it.
    pub searched_at: String,
    /// The strategy as run, pasted for a file import.
    pub strategy: String,
    pub limits: Vec<Limit>,
    /// "No limits were applied" stated explicitly.
    pub no_limits: bool,
    pub filters: Vec<Filter>,
    /// Websites: the address and how it was browsed; contacts: whom; anything else.
    pub notes: String,
    pub searcher: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PeerReview {
    pub id: String,
    pub by: String,
    pub date: String,
    /// "PRESS 2015" by default.
    pub tool: String,
    /// What came of it ("Two missing synonyms added").
    pub outcome: String,
    pub notes: String,
    /// The imports whose strategies were reviewed (empty: all).
    pub batch_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PriorWork {
    pub id: String,
    pub citation: String,
    /// How it was used ("Strategy adapted from …").
    pub how: String,
}

#[derive(Clone, Debug, Default)]
pub struct Reporting {
    pub registration: Option<Registration>,
    pub notes: BTreeMap<(String, String), ChecklistNote>,
    pub sources: BTreeMap<(String, String), SourceDetail>,
    pub peer_reviews: Vec<PeerReview>,
    pub prior: Vec<PriorWork>,
}

fn merge_into<T: Serialize + for<'de> Deserialize<'de> + Default>(base: &T, patch: &Map<String, Json>) -> Option<T> {
    let mut v = serde_json::to_value(base).ok()?;
    if let Json::Object(obj) = &mut v {
        for (k, val) in patch {
            obj.insert(k.clone(), val.clone());
        }
    }
    serde_json::from_value(v).ok()
}

impl Reporting {
    pub fn apply(&mut self, e: &Event, version: &str) {
        let Some(p) = e.payload.as_object() else { return };
        let text = |k: &str| p.get(k).and_then(Json::as_str).unwrap_or("").to_string();
        let deleted = p.get("deleted").and_then(Json::as_bool).unwrap_or(false);
        match e.kind.as_str() {
            "protocol.register" => {
                if deleted {
                    self.registration = None;
                    return;
                }
                // A correction keeps the version it was registered under.
                let kept = self.registration.as_ref().map(|r| (r.version.clone(), r.at));
                let mut r = merge_into(&self.registration.clone().unwrap_or_default(), p).unwrap_or_default();
                match kept {
                    Some((v, at)) => {
                        r.version = v;
                        r.at = at;
                    }
                    None => {
                        r.version = version.to_string();
                        r.at = e.at;
                    }
                }
                r.actor = e.actor.clone();
                self.registration = Some(r);
            }
            "checklist.note" => {
                let key = (text("list"), text("item"));
                let mut n = merge_into(&self.notes.get(&key).cloned().unwrap_or_default(), p).unwrap_or_default();
                n.at = e.at;
                n.actor = e.actor.clone();
                if n.location.trim().is_empty() && n.text.trim().is_empty() {
                    self.notes.remove(&key);
                } else {
                    self.notes.insert(key, n);
                }
            }
            "search.source" => {
                let key = (text("batchId"), text("source"));
                if let Some(d) = merge_into(&self.sources.get(&key).cloned().unwrap_or_default(), p) {
                    self.sources.insert(key, d);
                }
            }
            "search.peer_review" => {
                let id = text("id");
                let existing = self.peer_reviews.iter().position(|r| r.id == id);
                if deleted {
                    if let Some(i) = existing {
                        self.peer_reviews.remove(i);
                    }
                    return;
                }
                let base = existing.map(|i| self.peer_reviews[i].clone()).unwrap_or_default();
                if let Some(r) = merge_into(&base, p) {
                    match existing {
                        Some(i) => self.peer_reviews[i] = r,
                        None => self.peer_reviews.push(r),
                    }
                }
            }
            "search.prior" => {
                let id = text("id");
                let existing = self.prior.iter().position(|r| r.id == id);
                if deleted {
                    if let Some(i) = existing {
                        self.prior.remove(i);
                    }
                    return;
                }
                let base = existing.map(|i| self.prior[i].clone()).unwrap_or_default();
                if let Some(r) = merge_into(&base, p) {
                    match existing {
                        Some(i) => self.prior[i] = r,
                        None => self.prior.push(r),
                    }
                }
            }
            _ => {}
        }
    }

    pub fn note(&self, list: &str, item: &str) -> Option<&ChecklistNote> {
        self.notes.get(&(list.to_string(), item.to_string()))
    }

    pub fn source(&self, batch: &str, source: &str) -> Option<&SourceDetail> {
        self.sources.get(&(batch.to_string(), source.to_string()))
    }
}
