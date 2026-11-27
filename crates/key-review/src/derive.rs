// Derived state: a fold over a review's events in (at, id) order. Nothing here is stored; the
// store keeps one `State` per open review and applies each new event to it, and a merge replays
// from scratch. Status, conflicts, queues and counts are all computed from this.
use crate::events::{Event, hash64};
use crate::model::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub event: String,
    pub at: i64,
    pub reviewer: String,
    pub value: Choice,
    pub reasons: Vec<String>,
    pub note: String,
    pub version: String,
    pub evidence: Vec<Json>,
    /// The criterion that applied it automatically.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullText {
    /// "" | sought | retrieved | notRetrieved
    pub status: String,
    pub reason: String,
    pub source_id: Option<String>,
    pub at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub event: String,
    pub reviewer: String,
    pub at: i64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSuggestion {
    pub value: Choice,
    #[serde(default)]
    pub rationale: String,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub at: i64,
}

#[derive(Clone, Debug, Default)]
pub struct RecState {
    pub id: String,
    pub batch: String,
    pub pos: usize,
    pub dup_of: Option<String>,
    pub dup_auto: bool,
    pub distinct: BTreeSet<String>,
    /// Decision events still in force, oldest first.
    pub decisions: [Vec<Decision>; 2],
    pub resolutions: [Vec<Decision>; 2],
    pub fulltext: FullText,
    pub labels: BTreeSet<String>,
    pub notes: Vec<Note>,
    /// When it was flagged for re-screening (cleared by a later decision).
    pub flagged: [Option<i64>; 2],
    pub ai: [Option<AiSuggestion>; 2],
    pub source_id: Option<String>,
    pub has_abstract: bool,
    pub year: Option<i64>,
}

impl RecState {
    /// Each reviewer's decision in force at `stage` (their latest).
    pub fn current(&self, stage: Stage) -> Vec<&Decision> {
        let mut latest: BTreeMap<&str, &Decision> = BTreeMap::new();
        for d in &self.decisions[stage.index()] {
            latest.insert(&d.reviewer, d);
        }
        let mut out: Vec<&Decision> = latest.into_values().collect();
        out.sort_by_key(|d| d.at);
        out
    }
    pub fn mine(&self, stage: Stage, reviewer: &str) -> Option<&Decision> {
        self.decisions[stage.index()].iter().rev().find(|d| d.reviewer == reviewer)
    }
    pub fn resolution(&self, stage: Stage) -> Option<&Decision> {
        self.resolutions[stage.index()].last()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Share {
    pub id: String,
    /// Relative share of the records (equal when all are 1).
    pub share: f64,
}

/// Who screens what at a stage.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Assignment {
    pub stage: Option<Stage>,
    /// everyone | split
    pub mode: String,
    pub reviewers: Vec<Share>,
    /// Share of records screened by two people (0–1).
    pub double: f64,
    pub seed: u64,
    /// Record → reviewers, for the records there were when it was made.
    pub snapshot: BTreeMap<String, Vec<String>>,
    pub at: i64,
    pub actor: String,
}

impl Assignment {
    /// The reviewers of a record; records added later are placed by the same seeded rule.
    pub fn of(&self, record: &str) -> Vec<String> {
        if self.mode != "split" || self.reviewers.is_empty() {
            return Vec::new();
        }
        if let Some(found) = self.snapshot.get(record) {
            return found.clone();
        }
        let total: f64 = self.reviewers.iter().map(|r| r.share.max(0.0)).sum::<f64>().max(1e-9);
        let pick = (hash64(self.seed, record) % 1_000_000) as f64 / 1_000_000.0 * total;
        let mut acc = 0.0;
        let mut first = 0;
        for (i, r) in self.reviewers.iter().enumerate() {
            acc += r.share.max(0.0);
            if pick < acc {
                first = i;
                break;
            }
        }
        let mut out = vec![self.reviewers[first].id.clone()];
        let second = (hash64(self.seed ^ 0x5bd1_e995, record) % 1_000_000) as f64 / 1_000_000.0;
        if second < self.double && self.reviewers.len() > 1 {
            out.push(self.reviewers[(first + 1) % self.reviewers.len()].id.clone());
        }
        out
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Pilot {
    pub id: String,
    pub name: String,
    pub stage: Option<Stage>,
    pub records: Vec<String>,
    pub reviewers: Vec<String>,
    pub open: bool,
    pub seed: u64,
    pub at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub number: usize,
    pub at: i64,
    pub actor: String,
    pub note: String,
    pub protocol: Protocol,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    pub a: String,
    pub b: String,
    pub score: f64,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extracted {
    pub event: String,
    pub at: i64,
    pub reviewer: String,
    pub value: Json,
    #[serde(default)]
    pub quote: String,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub source_id: Option<String>,
    /// From AI pre-fill (a suggestion the reviewer accepted or not).
    #[serde(default)]
    pub suggested: bool,
}

/// One record's extraction: per (form, field) each reviewer's value, and the agreed one.
#[derive(Clone, Debug, Default)]
pub struct RecExtraction {
    pub values: BTreeMap<(String, String), BTreeMap<String, Extracted>>,
    pub finals: BTreeMap<(String, String), Extracted>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewInfo {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub created_by: String,
    pub archived: bool,
    pub updated_at: i64,
}

/// What a record's state is at a stage.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Status {
    /// Not at this stage (duplicate, removed, or excluded earlier).
    NotEligible,
    /// Full text could not be obtained.
    NotRetrieved,
    Undecided,
    /// Some reviewers decided, more are needed.
    Partial { have: usize, need: usize },
    Conflict,
    Final { value: Choice, resolved: bool, auto: bool },
}

impl Status {
    pub fn name(&self) -> &'static str {
        match self {
            Status::NotEligible => "notEligible",
            Status::NotRetrieved => "notRetrieved",
            Status::Undecided => "undecided",
            Status::Partial { .. } => "partial",
            Status::Conflict => "conflict",
            Status::Final { value: Choice::Include, .. } => "included",
            Status::Final { value: Choice::Exclude, .. } => "excluded",
            Status::Final { value: Choice::Maybe, .. } => "maybe",
        }
    }
    pub fn is_final(&self) -> bool {
        matches!(self, Status::Final { .. })
    }
}

#[derive(Clone, Debug)]
pub struct State {
    pub info: ReviewInfo,
    pub protocol: Protocol,
    pub version: String,
    pub versions: Vec<Version>,
    pub team: Vec<Member>,
    pub batches: Vec<Batch>,
    pub removed_batches: HashSet<String>,
    pub records: Vec<RecState>,
    pub index: HashMap<String, usize>,
    pub candidates: Vec<Pair>,
    pub pilots: Vec<Pilot>,
    pub assignments: [Option<Assignment>; 2],
    pub extraction: HashMap<String, RecExtraction>,
    pub analyses: Vec<Json>,
    pub events: usize,
    pub last_event: Option<(i64, String)>,
    /// Old exclusion reason ids → the criteria they became (criteria and reasons are one list).
    pub aliases: BTreeMap<String, String>,
    /// Whether an old protocol was migrated on replay, and whether a `criteria.alias` event
    /// records it in the log.
    pub migrated: bool,
    pub alias_recorded: bool,
    /// Retracted decision event ids (so a replay of a retract before its target still works).
    retracted: HashSet<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct DecisionPayload {
    stage: Option<Stage>,
    value: Option<Choice>,
    reasons: Vec<String>,
    note: String,
    evidence: Vec<Json>,
    auto: Option<String>,
}

impl State {
    pub fn new(review_id: &str) -> Self {
        State {
            info: ReviewInfo { id: review_id.into(), name: "Untitled review".into(), created_at: 0, created_by: String::new(), archived: false, updated_at: 0 },
            protocol: Protocol::default(),
            version: String::new(),
            versions: Vec::new(),
            team: Vec::new(),
            batches: Vec::new(),
            removed_batches: HashSet::new(),
            records: Vec::new(),
            index: HashMap::new(),
            candidates: Vec::new(),
            pilots: Vec::new(),
            assignments: [None, None],
            extraction: HashMap::new(),
            analyses: Vec::new(),
            events: 0,
            last_event: None,
            aliases: BTreeMap::new(),
            migrated: false,
            alias_recorded: false,
            retracted: HashSet::new(),
        }
    }

    pub fn replay<'a>(review_id: &str, events: impl IntoIterator<Item = &'a Event>) -> Self {
        let mut sorted: Vec<&Event> = events.into_iter().collect();
        sorted.sort_by(|a, b| a.order_key().cmp(&b.order_key()));
        let mut state = State::new(review_id);
        for e in sorted {
            state.apply(e);
        }
        state
    }

    pub fn record(&self, id: &str) -> Option<&RecState> {
        self.index.get(id).map(|i| &self.records[*i])
    }
    fn record_mut(&mut self, id: &str) -> Option<&mut RecState> {
        let i = *self.index.get(id)?;
        Some(&mut self.records[i])
    }
    pub fn member(&self, id: &str) -> Option<&Member> {
        self.team.iter().find(|m| m.id == id)
    }
    pub fn member_name(&self, id: &str) -> String {
        match id {
            "rules" => "Rules".into(),
            "system" => "Key".into(),
            _ => self.member(id).map(|m| m.name.clone()).unwrap_or_else(|| id.to_string()),
        }
    }
    pub fn batch(&self, id: &str) -> Option<&Batch> {
        self.batches.iter().find(|b| b.id == id)
    }
    /// Whether a version has decisions made under it.
    pub fn decisions_under(&self, version: &str) -> usize {
        self.records.iter().map(|r| r.decisions.iter().chain(r.resolutions.iter()).flatten().filter(|d| d.version == version).count()).sum()
    }

    /// Applies one event. Unknown kinds and malformed payloads are ignored (they stay in the log).
    pub fn apply(&mut self, e: &Event) {
        self.events += 1;
        self.info.updated_at = self.info.updated_at.max(e.at);
        self.last_event = Some((e.at, e.id.clone()));
        let p = &e.payload;
        let text = |key: &str| p.get(key).and_then(Json::as_str).unwrap_or("").to_string();
        let stage = || p.get("stage").and_then(|s| serde_json::from_value::<Stage>(s.clone()).ok());
        match e.kind.as_str() {
            "review.create" => {
                self.info.name = text("name");
                self.info.created_at = e.at;
                self.info.created_by = e.actor.clone();
            }
            "review.rename" => self.info.name = text("name"),
            "review.archive" => self.info.archived = p.get("archived").and_then(Json::as_bool).unwrap_or(true),
            "protocol.set" => {
                if let Ok(mut protocol) = serde_json::from_value::<Protocol>(p.get("protocol").cloned().unwrap_or(Json::Null)) {
                    // A protocol from before criteria and reasons were one list.
                    if protocol.is_legacy() {
                        let aliases = protocol.migrate();
                        self.migrated = true;
                        for (from, to) in aliases {
                            self.aliases.entry(from).or_insert(to);
                        }
                    }
                    let amend = p.get("amend").and_then(Json::as_bool).unwrap_or(false) && !self.versions.is_empty();
                    if amend {
                        if let Some(v) = self.versions.last_mut() {
                            v.protocol = protocol.clone();
                        }
                    } else {
                        let number = self.versions.len() + 1;
                        self.versions.push(Version { id: e.id.clone(), number, at: e.at, actor: e.actor.clone(), note: text("note"), protocol: protocol.clone() });
                        self.version = e.id.clone();
                    }
                    self.protocol = protocol;
                }
            }
            "criteria.alias" => {
                if let Some(Json::Object(map)) = p.get("aliases") {
                    for (from, to) in map {
                        if let Some(to) = to.as_str() {
                            self.aliases.insert(from.clone(), to.to_string());
                        }
                    }
                }
                self.alias_recorded = true;
            }
            "team.set" => {
                if let Ok(team) = serde_json::from_value::<Vec<Member>>(p.get("members").cloned().unwrap_or(Json::Null)) {
                    self.team = team;
                }
            }
            "batch.add" => {
                if let Ok(mut batch) = serde_json::from_value::<Batch>(p.get("batch").cloned().unwrap_or(Json::Null)) {
                    batch.at = e.at;
                    batch.actor = e.actor.clone();
                    self.removed_batches.remove(&batch.id);
                    match self.batches.iter_mut().find(|b| b.id == batch.id) {
                        Some(existing) => *existing = batch,
                        None => self.batches.push(batch),
                    }
                }
            }
            "batch.remove" => {
                let id = text("batchId");
                self.removed_batches.insert(id);
            }
            "records.add" => {
                let batch = text("batchId");
                if let Some(Json::Array(items)) = p.get("records") {
                    for item in items {
                        let Ok(meta) = serde_json::from_value::<RecordMeta>(item.clone()) else { continue };
                        if meta.id.is_empty() || self.index.contains_key(&meta.id) {
                            continue;
                        }
                        let pos = self.records.len();
                        self.index.insert(meta.id.clone(), pos);
                        self.records.push(RecState {
                            id: meta.id.clone(),
                            batch: batch.clone(),
                            pos,
                            source_id: meta.source_id.clone(),
                            has_abstract: !meta.abstract_text.trim().is_empty(),
                            year: meta.year,
                            ..Default::default()
                        });
                    }
                }
            }
            "dedup.candidates" => {
                if let Some(Json::Array(pairs)) = p.get("pairs") {
                    for pair in pairs {
                        let a = pair.get("a").and_then(Json::as_str).unwrap_or("").to_string();
                        let b = pair.get("b").and_then(Json::as_str).unwrap_or("").to_string();
                        if a.is_empty() || b.is_empty() {
                            continue;
                        }
                        self.candidates.push(Pair { a, b, score: pair.get("score").and_then(Json::as_f64).unwrap_or(0.0), reason: pair.get("reason").and_then(Json::as_str).unwrap_or("").into() });
                    }
                }
            }
            "dedup.set" => {
                let id = e.record_id.clone().unwrap_or_else(|| text("recordId"));
                let auto = p.get("auto").and_then(Json::as_bool).unwrap_or(false);
                if let Some(other) = p.get("distinctFrom").and_then(Json::as_str).map(str::to_string) {
                    if let Some(r) = self.record_mut(&id) {
                        r.distinct.insert(other.clone());
                        if r.dup_of.as_deref() == Some(other.as_str()) {
                            r.dup_of = None;
                        }
                    }
                    if let Some(r) = self.record_mut(&other) {
                        r.distinct.insert(id.clone());
                        if r.dup_of.as_deref() == Some(id.as_str()) {
                            r.dup_of = None;
                        }
                    }
                } else {
                    let of = p.get("duplicateOf").and_then(Json::as_str).map(str::to_string);
                    if of.as_deref() != Some(id.as_str()) {
                        if let Some(r) = self.record_mut(&id) {
                            r.dup_of = of;
                            r.dup_auto = auto;
                        }
                    }
                }
            }
            "decision" | "resolve" => {
                let Ok(d) = serde_json::from_value::<DecisionPayload>(p.clone()) else { return };
                let (Some(stage), Some(value)) = (d.stage, d.value) else { return };
                if self.retracted.contains(&e.id) {
                    return;
                }
                // Reasons are criterion ids; old decisions name old reason ids, resolved here.
                let reasons = d.reasons.into_iter().map(|r| self.aliases.get(&r).cloned().unwrap_or(r)).collect();
                let decision = Decision { event: e.id.clone(), at: e.at, reviewer: e.actor.clone(), value, reasons, note: d.note, version: e.version.clone(), evidence: d.evidence, auto: d.auto };
                let resolve = e.kind == "resolve";
                let Some(id) = e.record_id.clone() else { return };
                if let Some(r) = self.record_mut(&id) {
                    if resolve {
                        r.resolutions[stage.index()].push(decision);
                    } else {
                        r.decisions[stage.index()].push(decision);
                    }
                    if r.flagged[stage.index()].is_some_and(|at| at <= e.at) {
                        r.flagged[stage.index()] = None;
                    }
                }
            }
            "decision.retract" => {
                let target = text("target");
                self.retracted.insert(target.clone());
                if let Some(id) = e.record_id.clone() {
                    if let Some(r) = self.record_mut(&id) {
                        for list in r.decisions.iter_mut().chain(r.resolutions.iter_mut()) {
                            list.retain(|d| d.event != target);
                        }
                    }
                }
            }
            "note" => {
                let Some(id) = e.record_id.clone() else { return };
                let note_id = p.get("noteId").and_then(Json::as_str).map(str::to_string).unwrap_or_else(|| e.id.clone());
                let body = text("text");
                if let Some(r) = self.record_mut(&id) {
                    r.notes.retain(|n| n.id != note_id);
                    if !body.trim().is_empty() {
                        r.notes.push(Note { id: note_id, event: e.id.clone(), reviewer: e.actor.clone(), at: e.at, text: body });
                    }
                }
            }
            "labels" => {
                let list = |key: &str| p.get(key).and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect::<Vec<_>>()).unwrap_or_default();
                let (add, remove) = (list("add"), list("remove"));
                let ids: Vec<String> = match e.record_id.clone() {
                    Some(id) => vec![id],
                    None => list("recordIds"),
                };
                for id in ids {
                    if let Some(r) = self.record_mut(&id) {
                        for l in &remove {
                            r.labels.remove(l);
                        }
                        for l in &add {
                            r.labels.insert(l.clone());
                        }
                    }
                }
            }
            "fulltext.set" => {
                let Some(id) = e.record_id.clone() else { return };
                let status = p.get("status").and_then(Json::as_str).map(str::to_string);
                let reason = p.get("reason").and_then(Json::as_str).map(str::to_string);
                let source = p.get("sourceId").map(|v| v.as_str().map(str::to_string));
                if let Some(r) = self.record_mut(&id) {
                    if let Some(s) = status {
                        r.fulltext.status = s;
                    }
                    if let Some(reason) = reason {
                        r.fulltext.reason = reason;
                    }
                    if let Some(source) = source {
                        r.fulltext.source_id = source.clone();
                        if source.is_some() {
                            r.source_id = source;
                            if r.fulltext.status.is_empty() || r.fulltext.status == "sought" {
                                // A linked source does not mean a PDF yet; the reader checks.
                            }
                        }
                    }
                    r.fulltext.at = e.at;
                }
            }
            "assign" => {
                if let Ok(mut a) = serde_json::from_value::<Assignment>(p.clone()) {
                    a.at = e.at;
                    a.actor = e.actor.clone();
                    if let Some(stage) = a.stage {
                        self.assignments[stage.index()] = Some(a);
                    }
                }
            }
            "pilot.set" => {
                if let Ok(mut pilot) = serde_json::from_value::<Pilot>(p.clone()) {
                    pilot.at = e.at;
                    match self.pilots.iter_mut().find(|x| x.id == pilot.id) {
                        Some(existing) => *existing = pilot,
                        None => self.pilots.push(pilot),
                    }
                }
            }
            "rescreen.flag" => {
                let Some(stage) = stage() else { return };
                let ids: Vec<String> = p.get("recordIds").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect()).unwrap_or_default();
                let clear = p.get("clear").and_then(Json::as_bool).unwrap_or(false);
                for id in ids {
                    if let Some(r) = self.record_mut(&id) {
                        r.flagged[stage.index()] = if clear { None } else { Some(e.at) };
                    }
                }
            }
            "extract.value" | "extract.final" => {
                let Some(id) = e.record_id.clone() else { return };
                let key = (text("formId"), text("fieldId"));
                let value = Extracted {
                    event: e.id.clone(),
                    at: e.at,
                    reviewer: e.actor.clone(),
                    value: p.get("value").cloned().unwrap_or(Json::Null),
                    quote: text("quote"),
                    page: p.get("page").and_then(Json::as_i64),
                    source_id: p.get("sourceId").and_then(Json::as_str).map(str::to_string),
                    suggested: p.get("suggested").and_then(Json::as_bool).unwrap_or(false),
                };
                let entry = self.extraction.entry(id).or_default();
                if e.kind == "extract.final" {
                    entry.finals.insert(key, value);
                } else {
                    entry.values.entry(key).or_default().insert(e.actor.clone(), value);
                }
            }
            "ai.suggest" => {
                let (Some(stage), Some(id)) = (stage(), e.record_id.clone()) else { return };
                if let Ok(mut s) = serde_json::from_value::<AiSuggestion>(p.clone()) {
                    s.at = e.at;
                    if let Some(r) = self.record_mut(&id) {
                        r.ai[stage.index()] = Some(s);
                    }
                }
            }
            "analysis.set" => {
                let id = text("id");
                self.analyses.retain(|a| a.get("id").and_then(Json::as_str) != Some(id.as_str()));
                if !p.get("deleted").and_then(Json::as_bool).unwrap_or(false) {
                    self.analyses.push(p.clone());
                }
            }
            _ => {}
        }
    }

    // ── Status ──────────────────────────────────────────────────────────────────────

    /// Not removed with its batch and not a duplicate of a record still in the review.
    pub fn active(&self, r: &RecState) -> bool {
        if self.removed_batches.contains(&r.batch) {
            return false;
        }
        match &r.dup_of {
            Some(of) => !self.record(of).is_some_and(|o| !self.removed_batches.contains(&o.batch)),
            None => true,
        }
    }

    pub fn pilot_of(&self, record: &str, stage: Stage) -> Option<&Pilot> {
        self.pilots.iter().find(|p| p.stage == Some(stage) && p.records.iter().any(|r| r == record))
    }

    /// The reviewers a record waits for at a stage: its pilot's, its assignment's, or any.
    pub fn assigned(&self, record: &str, stage: Stage) -> Vec<String> {
        if let Some(p) = self.pilot_of(record, stage) {
            return p.reviewers.clone();
        }
        self.assignments[stage.index()].as_ref().map(|a| a.of(record)).unwrap_or_default()
    }

    pub fn needed(&self, record: &str, stage: Stage) -> usize {
        let assigned = self.assigned(record, stage);
        if !assigned.is_empty() {
            return assigned.len();
        }
        // A change to the number of reviewers applies from then on: a record first decided
        // under an earlier version needs what that version asked for.
        let rules = self
            .record(record)
            .and_then(|r| r.decisions[stage.index()].first())
            .and_then(|d| self.versions.iter().find(|v| v.id == d.version))
            .map(|v| &v.protocol.rules)
            .unwrap_or(&self.protocol.rules);
        rules.stage(stage).reviewers.max(1) as usize
    }

    /// Whether a record reaches `stage` at all.
    pub fn eligible(&self, r: &RecState, stage: Stage) -> bool {
        if !self.active(r) {
            return false;
        }
        match stage {
            Stage::Ta => true,
            Stage::Ft => matches!(self.status(r, Stage::Ta), Status::Final { value: Choice::Include | Choice::Maybe, .. }),
        }
    }

    pub fn status(&self, r: &RecState, stage: Stage) -> Status {
        if !self.eligible(r, stage) {
            return Status::NotEligible;
        }
        if let Some(res) = r.resolution(stage) {
            return Status::Final { value: res.value, resolved: res.auto.is_none(), auto: res.auto.is_some() };
        }
        if stage == Stage::Ft && r.fulltext.status == "notRetrieved" {
            return Status::NotRetrieved;
        }
        let current = r.current(stage);
        if current.is_empty() {
            return Status::Undecided;
        }
        let need = self.needed(&r.id, stage);
        let first = current[0].value;
        if current.iter().any(|d| d.value != first) {
            // Disagreement is a conflict once everyone needed has decided (or more than needed did).
            return if current.len() >= need { Status::Conflict } else { Status::Partial { have: current.len(), need } };
        }
        if current.len() < need {
            return Status::Partial { have: current.len(), need };
        }
        Status::Final { value: first, resolved: false, auto: false }
    }

    /// Whether `reviewer` is asked to screen this record now.
    pub fn waits_for(&self, r: &RecState, stage: Stage, reviewer: &str) -> bool {
        match self.status(r, stage) {
            Status::Undecided | Status::Partial { .. } => {}
            _ => return false,
        }
        if r.mine(stage, reviewer).is_some() {
            return false;
        }
        let assigned = self.assigned(&r.id, stage);
        assigned.is_empty() || assigned.iter().any(|a| a == reviewer)
    }

    /// The final reasons (criterion ids) of an excluded record at a stage: the resolution's, or
    /// every criterion the excluding reviewers chose.
    pub fn final_reasons(&self, r: &RecState, stage: Stage) -> Vec<String> {
        let alias = |id: &String| self.aliases.get(id).cloned().unwrap_or_else(|| id.clone());
        if let Some(res) = r.resolution(stage) {
            return res.reasons.iter().map(alias).collect();
        }
        let mut reasons: Vec<String> = Vec::new();
        for d in r.current(stage).into_iter().filter(|d| d.value == Choice::Exclude) {
            for reason in d.reasons.iter().map(alias) {
                if !reasons.contains(&reason) {
                    reasons.push(reason);
                }
            }
        }
        reasons
    }

    /// Reviewers agree to exclude but chose different criteria. Not a conflict (the record is
    /// excluded either way, and PRISMA reports the first criterion in the list); full-text
    /// screening shows it so the team can settle the reason.
    pub fn reasons_differ(&self, r: &RecState, stage: Stage) -> bool {
        if r.resolution(stage).is_some() {
            return false;
        }
        let current = r.current(stage);
        if current.len() < 2 || current.iter().any(|d| d.value != Choice::Exclude) {
            return false;
        }
        let sets: Vec<std::collections::BTreeSet<&String>> = current.iter().map(|d| d.reasons.iter().collect()).collect();
        sets.iter().any(|x| *x != sets[0])
    }

    /// Counts per stage for the top bar.
    pub fn stage_counts(&self, stage: Stage, reviewer: &str) -> Json {
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        let mut mine = 0;
        let mut eligible = 0;
        let mut flagged = 0;
        let mut awaiting = 0;
        for r in &self.records {
            let s = self.status(r, stage);
            if s == Status::NotEligible {
                continue;
            }
            eligible += 1;
            *counts.entry(s.name()).or_default() += 1;
            if self.waits_for(r, stage, reviewer) {
                mine += 1;
            }
            if r.flagged[stage.index()].is_some() {
                flagged += 1;
            }
            if stage == Stage::Ft && !s.is_final() && s != Status::NotRetrieved && r.fulltext.status != "retrieved" && r.source_id.is_none() {
                awaiting += 1;
            }
        }
        let done = counts.get("included").copied().unwrap_or(0) + counts.get("excluded").copied().unwrap_or(0) + counts.get("maybe").copied().unwrap_or(0);
        json!({
            "eligible": eligible, "done": done, "mine": mine, "flagged": flagged, "awaiting": awaiting,
            "undecided": counts.get("undecided").copied().unwrap_or(0), "partial": counts.get("partial").copied().unwrap_or(0),
            "conflicts": counts.get("conflict").copied().unwrap_or(0), "included": counts.get("included").copied().unwrap_or(0),
            "excluded": counts.get("excluded").copied().unwrap_or(0), "maybe": counts.get("maybe").copied().unwrap_or(0),
            "notRetrieved": counts.get("notRetrieved").copied().unwrap_or(0),
        })
    }

    /// Records whose final full-text decision is include: the studies.
    pub fn included(&self) -> Vec<&RecState> {
        self.records.iter().filter(|r| matches!(self.status(r, Stage::Ft), Status::Final { value: Choice::Include, .. })).collect()
    }

    /// Duplicate pairs still to look at.
    pub fn open_pairs(&self) -> Vec<&Pair> {
        self.candidates
            .iter()
            .filter(|p| {
                let (Some(a), Some(b)) = (self.record(&p.a), self.record(&p.b)) else { return false };
                self.active(a) && self.active(b) && !a.distinct.contains(&p.b) && a.dup_of.as_deref() != Some(&p.b) && b.dup_of.as_deref() != Some(&p.a)
            })
            .collect()
    }
}
