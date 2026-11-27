// Changes to a review, each validated against the protocol and turned into events.
use crate::derive::{Assignment, Pilot, Share, State, Status};
use crate::events::{Event, Rng, random_u64};
use crate::import::{DedupOutcome, dedup};
use crate::model::*;
use crate::rules;
use crate::store::{CHUNK, Result, Reviews, all_metas, metas};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Map, Value as Json, json};
use std::collections::{BTreeMap, HashMap, HashSet};

/// What Key knows about a record's library source: its custom properties and whether it has a
/// file to read. The host answers from the library; tests use `NoLibrary`.
pub trait Library {
    fn properties(&self, source_id: &str) -> Map<String, Json>;
    fn has_file(&self, source_id: &str) -> bool;
}

pub struct NoLibrary;
impl Library for NoLibrary {
    fn properties(&self, _: &str) -> Map<String, Json> {
        Map::new()
    }
    fn has_file(&self, _: &str) -> bool {
        false
    }
}

pub fn rule_context(meta: &RecordMeta, state: &State, library: &dyn Library) -> Map<String, Json> {
    let source = state.record(&meta.id).and_then(|r| r.source_id.clone()).or_else(|| meta.source_id.clone());
    let props = source.as_deref().map(|s| library.properties(s)).unwrap_or_default();
    let has_file = source.as_deref().is_some_and(|s| library.has_file(s)) || state.record(&meta.id).is_some_and(|r| r.fulltext.status == "retrieved");
    rules::context(meta, has_file, &props)
}

fn member_check(state: &State, actor: &str) -> Result<()> {
    if state.member(actor).is_none() {
        return Err("Choose who is screening: this person is not on the review's team".into());
    }
    Ok(())
}

fn validate_reasons(protocol: &Protocol, stage: Stage, value: Choice, reasons: &[String]) -> Result<()> {
    let rule = protocol.rules.stage(stage);
    if value == Choice::Maybe && !rule.maybe {
        return Err(format!("\"Maybe\" is turned off for {}", stage.label().to_lowercase()));
    }
    for r in reasons {
        if protocol.reason(r).is_none() {
            return Err("That exclusion reason is not in the protocol".into());
        }
    }
    if value == Choice::Exclude {
        match rule.reasons.as_str() {
            "one" if reasons.len() != 1 => return Err("Choose one exclusion reason".into()),
            "all" if reasons.is_empty() => return Err("Choose the exclusion reasons that apply".into()),
            _ => {}
        }
    }
    Ok(())
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub batch_id: String,
    pub added: usize,
    pub duplicates: usize,
    pub possible_duplicates: usize,
    pub auto_excluded: usize,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolSaved {
    pub version: String,
    pub number: usize,
    pub new_version: bool,
    pub flagged: usize,
    pub auto_applied: usize,
}

#[derive(Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangeImpact {
    /// Whether saving makes a new version (decisions exist under the current one).
    pub new_version: bool,
    /// Decided records per stage that the change could affect.
    pub ta: usize,
    pub ft: usize,
    /// "linked" (only rules linked to metadata changed: exactly the records whose suggestion
    /// changes) or "criteria" (wording, stages or reasons changed: every decided record).
    pub basis: String,
}

impl Reviews {
    pub fn rename(&self, review: &str, name: &str, actor: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Give the review a name".into());
        }
        self.write(review, |_, _, b| Ok((vec![b.event("review.rename", actor, None, json!({ "name": name }))], ())))
    }

    pub fn archive(&self, review: &str, archived: bool, actor: &str) -> Result<()> {
        self.write(review, |_, _, b| Ok((vec![b.event("review.archive", actor, None, json!({ "archived": archived }))], ())))
    }

    pub fn save_team(&self, review: &str, members: Vec<Member>, actor: &str) -> Result<()> {
        let mut seen = HashSet::new();
        for m in &members {
            if m.id.trim().is_empty() || !seen.insert(m.id.clone()) {
                return Err("Every person needs a unique id".into());
            }
            if m.name.trim().is_empty() {
                return Err("Every person needs a name".into());
            }
        }
        if !members.iter().any(|m| m.roles.iter().any(|r| r == "owner")) {
            return Err("Keep at least one owner".into());
        }
        self.write(review, |state, _, b| {
            // People who made decisions stay (their decisions keep their names); they can lose roles.
            for old in &state.team {
                if !members.iter().any(|m| m.id == old.id) && state.records.iter().any(|r| r.decisions.iter().flatten().any(|d| d.reviewer == old.id)) {
                    return Err(format!("{} has decisions in this review: remove their roles instead", old.name));
                }
            }
            Ok((vec![b.event("team.set", actor, None, json!({ "members": members }))], ()))
        })
    }

    /// What saving `protocol` would affect.
    pub fn protocol_impact(&self, review: &str, protocol: &Protocol, library: &dyn Library) -> Result<ChangeImpact> {
        self.read(review, |state, conn| impact(state, conn, protocol, library))
    }

    /// Saves the protocol: a new version (with `note`) once decisions exist under the current one,
    /// else an amendment. With `rescreen`, decided records the change affects are flagged.
    pub fn save_protocol(&self, review: &str, protocol: Protocol, note: &str, actor: &str, rescreen: bool, library: &dyn Library) -> Result<ProtocolSaved> {
        protocol.validate()?;
        let saved = self.write(review, |state, conn, b| {
            let new_version = state.decisions_under(&state.version) > 0;
            if new_version && note.trim().is_empty() {
                return Err("Say what changed: decisions were made under the current version".into());
            }
            let set = b.event("protocol.set", actor, None, json!({ "protocol": protocol, "note": note.trim(), "amend": !new_version }));
            let mut events = vec![set];
            let mut flagged = 0;
            if rescreen && new_version {
                for stage in [Stage::Ta, Stage::Ft] {
                    let ids = affected(state, conn, &protocol, stage, library)?;
                    flagged += ids.len();
                    if !ids.is_empty() {
                        events.push(b.event("rescreen.flag", actor, None, json!({ "stage": stage, "recordIds": ids })));
                    }
                }
            }
            let number = if new_version { state.versions.len() + 1 } else { state.versions.len().max(1) };
            let version = if new_version { events[0].id.clone() } else { state.version.clone() };
            Ok((events, ProtocolSaved { version, number, new_version, flagged, auto_applied: 0 }))
        })?;
        let auto_applied = self.apply_auto_rules(review, library)?;
        Ok(ProtocolSaved { auto_applied, ..saved })
    }

    /// Applies criteria whose effect is "auto" to records nobody has decided yet, as decisions of
    /// the "rules" actor that name the criterion (shown, counted and undoable like any other).
    pub fn apply_auto_rules(&self, review: &str, library: &dyn Library) -> Result<usize> {
        self.write(review, |state, conn, b| {
            let autos: Vec<&Criterion> = state.protocol.criteria.iter().filter(|c| c.link.as_ref().is_some_and(|l| l.effect == "auto")).collect();
            if autos.is_empty() {
                return Ok((Vec::new(), 0));
            }
            let mut events = Vec::new();
            for stage in [Stage::Ta, Stage::Ft] {
                if !autos.iter().any(|c| c.stages.contains(&stage)) {
                    continue;
                }
                let ids: Vec<String> = state.records.iter().filter(|r| state.status(r, stage) == Status::Undecided && r.resolution(stage).is_none()).map(|r| r.id.clone()).collect();
                let found = metas(conn, &state.info.id, &ids)?;
                for id in &ids {
                    let Some(meta) = found.get(id) else { continue };
                    let ctx = rule_context(meta, state, library);
                    if let Some(s) = rules::suggestions(&state.protocol, stage, &ctx).into_iter().find(|s| s.auto) {
                        events.push(b.event(
                            "resolve",
                            "rules",
                            Some(id),
                            json!({ "stage": stage, "value": Choice::Exclude, "reasons": s.reason_id.iter().collect::<Vec<_>>(), "note": s.rule, "auto": s.criterion_id }),
                        ));
                    }
                }
            }
            let n = events.len();
            Ok((events, n))
        })
    }

    /// Adds a batch of records, removing certain duplicates and queueing likely ones for review.
    pub fn import(&self, review: &str, mut batch: Batch, records: Vec<RecordMeta>, actor: &str, library: &dyn Library) -> Result<ImportReport> {
        if records.is_empty() {
            return Err("There are no records to add".into());
        }
        let report = self.write(review, |state, conn, b| {
            batch.id = if batch.id.is_empty() { crate::events::uuid7() } else { batch.id.clone() };
            if batch.count == 0 {
                batch.count = records.len();
            }
            if batch.group.is_empty() {
                batch.group = if batch.kind == "database" { "databases".into() } else { "other".into() };
            }
            // Compare with the records still in the review (not duplicates, not removed).
            let existing: Vec<RecordMeta> = all_metas(conn, review)?.into_iter().filter(|m| state.record(&m.id).is_some_and(|r| state.active(r))).collect();
            let DedupOutcome { exact, likely } = dedup(&existing, &records);
            let mut events = vec![b.event("batch.add", actor, None, json!({ "batch": batch }))];
            for chunk in records.chunks(CHUNK) {
                events.push(b.event("records.add", "system", None, json!({ "batchId": batch.id, "records": chunk })));
            }
            for (id, of) in &exact {
                events.push(b.event("dedup.set", "system", Some(id), json!({ "duplicateOf": of, "auto": true })));
            }
            if !likely.is_empty() {
                let pairs: Vec<Json> = likely.iter().map(|(a, b2, score, reason)| json!({ "a": a, "b": b2, "score": score, "reason": reason })).collect();
                events.push(b.event("dedup.candidates", "system", None, json!({ "pairs": pairs })));
            }
            Ok((events, ImportReport { batch_id: batch.id.clone(), added: records.len(), duplicates: exact.len(), possible_duplicates: likely.len(), auto_excluded: 0 }))
        })?;
        let auto_excluded = self.apply_auto_rules(review, library)?;
        Ok(ImportReport { auto_excluded, ..report })
    }

    pub fn remove_batch(&self, review: &str, batch: &str, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            if state.batch(batch).is_none() {
                return Err("This import no longer exists".into());
            }
            Ok((vec![b.event("batch.remove", actor, None, json!({ "batchId": batch }))], ()))
        })
    }

    /// A pair from de-duplication: `duplicate` (keep `keep`, the other is the duplicate) or `distinct`.
    pub fn resolve_pair(&self, review: &str, a: &str, b2: &str, choice: &str, keep: Option<&str>, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            if state.record(a).is_none() || state.record(b2).is_none() {
                return Err("One of these records no longer exists".into());
            }
            let event = match choice {
                "distinct" => b.event("dedup.set", actor, Some(a), json!({ "distinctFrom": b2 })),
                "duplicate" => {
                    let keep = keep.unwrap_or(a);
                    let drop = if keep == a { b2 } else { a };
                    b.event("dedup.set", actor, Some(drop), json!({ "duplicateOf": keep }))
                }
                "restore" => b.event("dedup.set", actor, Some(a), json!({ "duplicateOf": null })),
                _ => return Err("Choose duplicate or distinct".into()),
            };
            Ok((vec![event], ()))
        })
    }

    /// One reviewer's decision.
    #[allow(clippy::too_many_arguments)]
    pub fn decide(&self, review: &str, ids: &[String], stage: Stage, value: Choice, reasons: Vec<String>, note: &str, evidence: Vec<Json>, actor: &str) -> Result<Vec<String>> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            validate_reasons(&state.protocol, stage, value, &reasons)?;
            let mut events = Vec::new();
            for id in ids {
                let r = state.record(id).ok_or("This record no longer exists")?;
                match state.status(r, stage) {
                    Status::NotEligible => return Err(format!("This record is not at {}", stage.label().to_lowercase())),
                    Status::NotRetrieved => return Err("The full text was marked not retrieved: mark it found first".into()),
                    Status::Final { resolved: true, .. } => return Err("This record's decision was resolved; reopen it to change it".into()),
                    _ => {}
                }
                if let Some(mine) = r.mine(stage, actor) {
                    if mine.value == value && mine.reasons == reasons && mine.note == note && evidence.is_empty() {
                        continue;
                    }
                }
                let reasons = if value == Choice::Exclude { reasons.clone() } else { Vec::new() };
                events.push(b.event("decision", actor, Some(id), json!({ "stage": stage, "value": value, "reasons": reasons, "note": note, "evidence": evidence })));
            }
            let ids = events.iter().map(|e: &Event| e.id.clone()).collect();
            Ok((events, ids))
        })
    }

    /// Takes back `actor`'s latest decision (or resolution) in force; answers its record and stage.
    pub fn undo(&self, review: &str, actor: &str) -> Result<Option<(String, Stage)>> {
        self.write(review, |state, _, b| {
            let mut latest: Option<(&str, Stage, &str, i64)> = None;
            for r in &state.records {
                for stage in [Stage::Ta, Stage::Ft] {
                    for d in r.decisions[stage.index()].iter().chain(r.resolutions[stage.index()].iter()) {
                        if d.reviewer == actor && latest.is_none_or(|(_, _, _, at)| d.at >= at) {
                            latest = Some((&r.id, stage, &d.event, d.at));
                        }
                    }
                }
            }
            match latest {
                Some((record, stage, event, _)) => Ok((vec![b.event("decision.retract", actor, Some(record), json!({ "target": event, "stage": stage }))], Some((record.to_string(), stage)))),
                None => Ok((Vec::new(), None)),
            }
        })
    }

    /// Retracts one decision event (an auto decision, or one's own).
    pub fn retract(&self, review: &str, record: &str, event: &str, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            let r = state.record(record).ok_or("This record no longer exists")?;
            let d = r.decisions.iter().chain(r.resolutions.iter()).flatten().find(|d| d.event == event).ok_or("This decision was already taken back")?;
            let may = d.reviewer == actor || d.reviewer == "rules" || state.member(actor).is_some_and(|m| m.can_resolve(&state.protocol.rules));
            if !may {
                return Err("Only its reviewer can take this decision back".into());
            }
            Ok((vec![b.event("decision.retract", actor, Some(record), json!({ "target": event }))], ()))
        })
    }

    /// The final decision on a conflict (or over an automatic one).
    pub fn resolve(&self, review: &str, record: &str, stage: Stage, value: Choice, reasons: Vec<String>, note: &str, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            let m = state.member(actor).unwrap();
            if !m.can_resolve(&state.protocol.rules) {
                return Err("A tie-breaker resolves conflicts in this review".into());
            }
            validate_reasons(&state.protocol, stage, value, &reasons)?;
            let r = state.record(record).ok_or("This record no longer exists")?;
            if state.status(r, stage) == Status::NotEligible {
                return Err(format!("This record is not at {}", stage.label().to_lowercase()));
            }
            let reasons = if value == Choice::Exclude { reasons } else { Vec::new() };
            Ok((vec![b.event("resolve", actor, Some(record), json!({ "stage": stage, "value": value, "reasons": reasons, "note": note }))], ()))
        })
    }

    /// Undoes a resolution, so the record is a conflict (or undecided) again.
    pub fn reopen(&self, review: &str, record: &str, stage: Stage, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            let r = state.record(record).ok_or("This record no longer exists")?;
            let events = r.resolutions[stage.index()].iter().map(|d| b.event("decision.retract", actor, Some(record), json!({ "target": d.event, "stage": stage }))).collect();
            Ok((events, ()))
        })
    }

    pub fn note(&self, review: &str, record: &str, text: &str, note_id: Option<&str>, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            Ok((vec![b.event("note", actor, Some(record), json!({ "text": text, "noteId": note_id }))], ()))
        })
    }

    pub fn labels(&self, review: &str, ids: &[String], add: &[String], remove: &[String], actor: &str) -> Result<()> {
        self.write(review, |_, _, b| Ok((vec![b.event("labels", actor, None, json!({ "recordIds": ids, "add": add, "remove": remove }))], ())))
    }

    /// Full-text retrieval: status (sought | retrieved | notRetrieved | ""), reason, linked source.
    pub fn fulltext(&self, review: &str, record: &str, status: Option<&str>, reason: Option<&str>, source: Option<Option<&str>>, actor: &str) -> Result<()> {
        if let Some(s) = status {
            if !["", "sought", "retrieved", "notRetrieved"].contains(&s) {
                return Err("Unknown retrieval status".into());
            }
            if s == "notRetrieved" && reason.is_none_or(|r| r.trim().is_empty()) {
                return Err("Say why the full text could not be obtained".into());
            }
        }
        self.write(review, |_, _, b| {
            let mut payload = Map::new();
            if let Some(s) = status {
                payload.insert("status".into(), json!(s));
            }
            if let Some(r) = reason {
                payload.insert("reason".into(), json!(r));
            }
            if let Some(s) = source {
                payload.insert("sourceId".into(), json!(s));
            }
            Ok((vec![b.event("fulltext.set", actor, Some(record), Json::Object(payload))], ()))
        })
    }

    /// A calibration round: `size` records drawn at random (seeded) from those nobody decided yet.
    pub fn pilot_create(&self, review: &str, stage: Stage, size: usize, reviewers: Vec<String>, name: &str, seed: Option<u64>, actor: &str) -> Result<Pilot> {
        if reviewers.len() < 2 {
            return Err("A pilot round needs at least two reviewers".into());
        }
        self.write(review, |state, _, b| {
            for r in &reviewers {
                member_check(state, r)?;
            }
            let mut pool: Vec<String> = state.records.iter().filter(|r| state.status(r, stage) == Status::Undecided && state.pilot_of(&r.id, stage).is_none()).map(|r| r.id.clone()).collect();
            if pool.is_empty() {
                return Err("There are no undecided records to draw a sample from".into());
            }
            let seed = seed.unwrap_or_else(random_u64);
            Rng::new(seed).shuffle(&mut pool);
            pool.truncate(size.max(1));
            let n = state.pilots.iter().filter(|p| p.stage == Some(stage)).count() + 1;
            let pilot = Pilot {
                id: crate::events::short_id("p"),
                name: if name.trim().is_empty() { format!("Pilot {n}") } else { name.trim().into() },
                stage: Some(stage),
                records: pool,
                reviewers,
                open: true,
                seed,
                at: 0,
            };
            Ok((vec![b.event("pilot.set", actor, None, serde_json::to_value(&pilot).map_err(|e| e.to_string())?)], pilot))
        })
    }

    pub fn pilot_set_open(&self, review: &str, id: &str, open: bool, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            let mut pilot = state.pilots.iter().find(|p| p.id == id).cloned().ok_or("This pilot no longer exists")?;
            pilot.open = open;
            Ok((vec![b.event("pilot.set", actor, None, serde_json::to_value(&pilot).map_err(|e| e.to_string())?)], ()))
        })
    }

    /// Splits a stage's records across reviewers: `everyone`, or `split` by shares with a
    /// double-screened proportion. Exact for the records there are now (seeded shuffle, counts by
    /// share); records added later follow the same seeded rule.
    pub fn assign(&self, review: &str, stage: Stage, mode: &str, reviewers: Vec<Share>, double: f64, seed: Option<u64>, actor: &str) -> Result<Assignment> {
        if !["everyone", "split"].contains(&mode) {
            return Err("Choose everyone or split".into());
        }
        if mode == "split" && reviewers.is_empty() {
            return Err("Choose who screens".into());
        }
        if !(0.0..=1.0).contains(&double) {
            return Err("The double-screened share is between 0 and 100%".into());
        }
        self.write(review, |state, _, b| {
            for r in &reviewers {
                member_check(state, &r.id)?;
            }
            let seed = seed.unwrap_or_else(random_u64);
            let mut snapshot = BTreeMap::new();
            if mode == "split" {
                let mut ids: Vec<String> = state.records.iter().filter(|r| state.eligible(r, stage) && !state.status(r, stage).is_final() && state.pilot_of(&r.id, stage).is_none()).map(|r| r.id.clone()).collect();
                Rng::new(seed).shuffle(&mut ids);
                let total: f64 = reviewers.iter().map(|r| r.share.max(0.0)).sum::<f64>().max(1e-9);
                // Largest-remainder counts per reviewer.
                let n = ids.len();
                let raw: Vec<f64> = reviewers.iter().map(|r| r.share.max(0.0) / total * n as f64).collect();
                let mut counts: Vec<usize> = raw.iter().map(|x| x.floor() as usize).collect();
                let mut rest: Vec<usize> = (0..raw.len()).collect();
                rest.sort_by(|a, b| (raw[*b] - raw[*b].floor()).total_cmp(&(raw[*a] - raw[*a].floor())));
                let mut left = n - counts.iter().sum::<usize>();
                for i in rest {
                    if left == 0 {
                        break;
                    }
                    counts[i] += 1;
                    left -= 1;
                }
                let doubles = (double * n as f64).round() as usize;
                let mut at = 0;
                for (i, count) in counts.iter().enumerate() {
                    for id in &ids[at..at + count] {
                        snapshot.insert(id.clone(), vec![reviewers[i].id.clone()]);
                    }
                    at += count;
                }
                // The double-screened share: every k-th record of the shuffled order gets the next reviewer too.
                if reviewers.len() > 1 && doubles > 0 {
                    let mut order = ids.clone();
                    Rng::new(seed ^ 0x9e37).shuffle(&mut order);
                    for id in order.iter().take(doubles) {
                        let first = snapshot[id][0].clone();
                        let i = reviewers.iter().position(|r| r.id == first).unwrap_or(0);
                        snapshot.get_mut(id).unwrap().push(reviewers[(i + 1) % reviewers.len()].id.clone());
                    }
                }
            }
            let a = Assignment { stage: Some(stage), mode: mode.into(), reviewers, double, seed, snapshot, at: 0, actor: actor.into() };
            Ok((vec![b.event("assign", actor, None, serde_json::to_value(&a).map_err(|e| e.to_string())?)], a))
        })
    }

    /// One reviewer's value for a field.
    #[allow(clippy::too_many_arguments)]
    pub fn extract(&self, review: &str, record: &str, form: &str, field: &str, value: Json, quote: &str, page: Option<i64>, source: Option<&str>, suggested: bool, final_value: bool, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            member_check(state, actor)?;
            let f = state.protocol.forms.iter().find(|f| f.id == form).ok_or("This form no longer exists")?;
            let def = f.fields().find(|x| x.id == field).ok_or("This field no longer exists")?;
            let empty = matches!(&value, Json::Null) || value.as_str().is_some_and(|s| s.trim().is_empty()) || value.as_array().is_some_and(|a| a.is_empty());
            if !empty && !suggested && (state.protocol.rules.quote_required || def.quote) && quote.trim().is_empty() {
                return Err(format!("{}: add a quote from the paper (the rules ask for one)", def.label));
            }
            if def.kind == "number" && !empty && value.as_f64().is_none() && value.as_str().and_then(|s| s.trim().parse::<f64>().ok()).is_none() {
                return Err(format!("{}: enter a number", def.label));
            }
            let kind = if final_value { "extract.final" } else { "extract.value" };
            Ok((vec![b.event(kind, actor, Some(record), json!({ "formId": form, "fieldId": field, "value": value, "quote": quote, "page": page, "sourceId": source, "suggested": suggested }))], ()))
        })
    }

    /// AI pre-fill: suggested values under the "ai" actor, shown beside a field until a reviewer
    /// takes one; never a reviewer's value.
    pub fn ai_extract(&self, review: &str, record: &str, form: &str, values: &[crate::ai::Suggested], model: &str) -> Result<usize> {
        self.write(review, |state, _, b| {
            if state.record(record).is_none() {
                return Err("This record no longer exists".into());
            }
            let events: Vec<Event> = values
                .iter()
                .map(|s| b.event("extract.value", "ai", Some(record), json!({ "formId": form, "fieldId": s.field, "value": s.value, "quote": s.quote, "page": s.page, "suggested": true, "model": model })))
                .collect();
            let n = events.len();
            Ok((events, n))
        })
    }

    pub fn ai_suggest(&self, review: &str, record: &str, stage: Stage, suggestion: Json, actor: &str) -> Result<()> {
        self.write(review, |_, _, b| {
            let mut p = suggestion.as_object().cloned().unwrap_or_default();
            p.insert("stage".into(), json!(stage));
            Ok((vec![b.event("ai.suggest", actor, Some(record), Json::Object(p))], ()))
        })
    }

    pub fn save_analysis(&self, review: &str, analysis: Json, actor: &str) -> Result<()> {
        if analysis.get("id").and_then(Json::as_str).is_none_or(str::is_empty) {
            return Err("An analysis needs an id".into());
        }
        self.write(review, |_, _, b| Ok((vec![b.event("analysis.set", actor, None, analysis)], ())))
    }

    /// Clears re-screen flags (a reviewer decided they still hold).
    pub fn clear_flags(&self, review: &str, ids: &[String], stage: Stage, actor: &str) -> Result<()> {
        self.write(review, |_, _, b| Ok((vec![b.event("rescreen.flag", actor, None, json!({ "stage": stage, "recordIds": ids, "clear": true }))], ())))
    }
}

/// Which decided records a protocol change could affect at a stage.
fn affected(state: &State, conn: &Connection, new: &Protocol, stage: Stage, library: &dyn Library) -> Result<Vec<String>> {
    let old = &state.protocol;
    let relevant = |p: &Protocol| -> Vec<Criterion> { p.criteria.iter().filter(|c| c.stages.contains(&stage)).cloned().collect() };
    let (a, b) = (relevant(old), relevant(new));
    let strip = |cs: &[Criterion]| -> Vec<Criterion> { cs.iter().map(|c| Criterion { link: None, ..c.clone() }).collect() };
    let reasons_changed = old.reasons.iter().map(|r| (&r.id, &r.label)).collect::<Vec<_>>() != new.reasons.iter().map(|r| (&r.id, &r.label)).collect::<Vec<_>>();
    let decided: Vec<&crate::derive::RecState> = state.records.iter().filter(|r| !r.current(stage).is_empty() || r.resolution(stage).is_some_and(|d| d.auto.is_none())).collect();
    if strip(&a) != strip(&b) || (reasons_changed && stage == Stage::Ft) {
        return Ok(decided.iter().map(|r| r.id.clone()).collect());
    }
    if a == b {
        return Ok(Vec::new());
    }
    // Only the metadata links changed: the records whose suggestions differ.
    let ids: Vec<String> = decided.iter().map(|r| r.id.clone()).collect();
    let found = metas(conn, &state.info.id, &ids)?;
    let mut out = Vec::new();
    for id in ids {
        let Some(meta) = found.get(&id) else { continue };
        let ctx = rule_context(meta, state, library);
        if rules::suggestions(old, stage, &ctx) != rules::suggestions(new, stage, &ctx) {
            out.push(id);
        }
    }
    Ok(out)
}

fn impact(state: &State, conn: &Connection, protocol: &Protocol, library: &dyn Library) -> Result<ChangeImpact> {
    let ta = affected(state, conn, protocol, Stage::Ta, library)?;
    let ft = affected(state, conn, protocol, Stage::Ft, library)?;
    let old: Vec<Criterion> = state.protocol.criteria.iter().map(|c| Criterion { link: None, ..c.clone() }).collect();
    let new: Vec<Criterion> = protocol.criteria.iter().map(|c| Criterion { link: None, ..c.clone() }).collect();
    Ok(ChangeImpact { new_version: state.decisions_under(&state.version) > 0, ta: ta.len(), ft: ft.len(), basis: if old != new { "criteria".into() } else { "linked".into() } })
}

/// Records per reviewer, for the assignment preview.
pub fn assignment_counts(state: &State, stage: Stage) -> HashMap<String, usize> {
    let mut out = HashMap::new();
    for r in &state.records {
        if !state.eligible(r, stage) {
            continue;
        }
        for who in state.assigned(&r.id, stage) {
            *out.entry(who).or_default() += 1;
        }
    }
    out
}
