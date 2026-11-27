// What the screens read: the review's summary, one record as a reviewer sees it, lists and
// queues with filters, agreement statistics and extraction. Blind mode is enforced here: a
// reviewer never receives another reviewer's decision, reasons or notes on a record until
// everyone needed has decided it (and then only when it is in conflict or settled).
use crate::derive::{Decision, RecState, State, Status};
use crate::model::*;
use crate::ops::{Library, assignment_counts, rule_context};
use crate::rules;
use crate::stats::{self, Agreement};
use crate::store::{Result, Reviews, metas, search_ids};
use serde::Deserialize;
use serde_json::{Map, Value as Json, json};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Whether `viewer` may see other reviewers' work on this record at this stage.
pub fn unblinded(state: &State, r: &RecState, stage: Stage, viewer: &str) -> bool {
    if !state.protocol.rules.blind {
        return true;
    }
    let status = state.status(r, stage);
    match status {
        Status::Undecided | Status::Partial { .. } => false,
        Status::Conflict => r.mine(stage, viewer).is_some() || state.member(viewer).is_some_and(|m| m.can_resolve(&state.protocol.rules)),
        _ => true,
    }
}

fn decision_json(state: &State, d: &Decision) -> Json {
    let mut v = serde_json::to_value(d).unwrap_or(Json::Null);
    if let Some(o) = v.as_object_mut() {
        o.insert("reviewerName".into(), json!(state.member_name(&d.reviewer)));
        o.insert("versionNumber".into(), json!(state.versions.iter().find(|x| x.id == d.version).map(|x| x.number)));
    }
    v
}

fn status_json(s: &Status) -> Json {
    let mut v = serde_json::to_value(s).unwrap_or(Json::Null);
    if let Some(o) = v.as_object_mut() {
        o.insert("name".into(), json!(s.name()));
    }
    v
}

/// The decisions a viewer may see at a stage: their own always, others' when unblinded.
fn visible_decisions(state: &State, r: &RecState, stage: Stage, viewer: &str) -> (Option<Json>, Vec<Json>, bool) {
    let open = unblinded(state, r, stage, viewer);
    let mine = r.mine(stage, viewer).map(|d| decision_json(state, d));
    let others: Vec<Json> = if open { r.current(stage).into_iter().filter(|d| d.reviewer != viewer).map(|d| decision_json(state, d)).collect() } else { Vec::new() };
    (mine, others, open)
}

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ListQuery {
    pub stage: Option<Stage>,
    /// all | mine | undecided | partial | conflicts | included | excluded | maybe | decidedByMe |
    /// flagged | suggested | awaiting | notRetrieved | duplicates | removed | ai
    pub filter: String,
    pub text: String,
    pub label: String,
    pub batch: String,
    pub reason: String,
    /// "yes" | "no": has an abstract / a full text.
    pub has_abstract: String,
    pub has_full_text: String,
    /// The import's group: databases | registers | other.
    pub group: String,
    /// "" | sources: every record of the review (the Sources table), whatever its stage.
    pub scope: String,
    /// pos (import order) | title | year | ai
    pub sort: String,
    pub offset: usize,
    pub limit: usize,
}

impl Reviews {
    /// Everything the review's header, Overview and Setup need.
    pub fn summary(&self, review: &str, viewer: &str) -> Result<Json> {
        self.read(review, |state, _| {
            let versions: Vec<Json> = state.versions.iter().map(|v| json!({ "id": v.id, "number": v.number, "at": v.at, "actor": v.actor, "actorName": state.member_name(&v.actor), "note": v.note, "decisions": state.decisions_under(&v.id) })).collect();
            let batches: Vec<Json> = state
                .batches
                .iter()
                .map(|b| {
                    let recs: Vec<&RecState> = state.records.iter().filter(|r| r.batch == b.id).collect();
                    let dups = recs.iter().filter(|r| r.dup_of.is_some() && !state.active(r)).count();
                    json!({ "batch": b, "records": recs.len(), "duplicates": dups, "removed": state.removed_batches.contains(&b.id), "actorName": state.member_name(&b.actor) })
                })
                .collect();
            let pilots: Vec<Json> = state
                .pilots
                .iter()
                .map(|p| {
                    let stage = p.stage.unwrap_or(Stage::Ta);
                    let done = p.records.iter().filter(|id| state.record(id).is_some_and(|r| p.reviewers.iter().all(|who| r.mine(stage, who).is_some()))).count();
                    json!({ "pilot": p, "done": done, "agreement": pilot_agreement(state, p) })
                })
                .collect();
            let assignments: Vec<Json> = [Stage::Ta, Stage::Ft]
                .iter()
                .map(|s| json!({ "stage": s, "assignment": state.assignments[s.index()].as_ref().map(|a| json!({ "mode": a.mode, "reviewers": a.reviewers, "double": a.double, "at": a.at })), "counts": assignment_counts(state, *s) }))
                .collect();
            let viewer_member = state.member(viewer);
            Ok(json!({
                "review": state.info,
                "protocol": state.protocol,
                "version": state.version,
                "versionNumber": state.versions.len(),
                "versionHasDecisions": state.decisions_under(&state.version) > 0,
                "versions": versions,
                "team": state.team,
                "viewer": viewer_member,
                "canResolve": viewer_member.is_some_and(|m| m.can_resolve(&state.protocol.rules)),
                "batches": batches,
                "records": state.records.len(),
                "active": state.records.iter().filter(|r| state.active(r)).count(),
                "duplicates": state.records.iter().filter(|r| r.dup_of.is_some() && !state.active(r) && !state.removed_batches.contains(&r.batch)).count(),
                "openPairs": state.open_pairs().len(),
                "stages": { "ta": state.stage_counts(Stage::Ta, viewer), "ft": state.stage_counts(Stage::Ft, viewer) },
                "included": state.included().len(),
                "extraction": extraction_counts(state, viewer),
                "pilots": pilots,
                "assignments": assignments,
                "analyses": state.analyses,
                "events": state.events,
                "labelsInUse": state.records.iter().flat_map(|r| r.labels.iter().cloned()).collect::<std::collections::BTreeSet<_>>(),
                "labelCounts": label_counts(state),
                "originsToCheck": origins_to_check(state),
                "searches": state.searches,
                "labelKeys": state.protocol.label_keys,
                "removedByHand": state.records.iter().filter(|r| r.removed.is_some() && !state.removed_batches.contains(&r.batch)).count(),
                "missingAbstracts": state.records.iter().filter(|r| state.active(r) && !r.has_abstract).count(),
                "filledAbstracts": state.records.iter().filter(|r| r.filled.contains_key("abstractText")).count(),
                "otherReasons": crate::records::other_reasons(state).into_iter().filter(|(_, n)| *n >= 2).map(|(text, count)| json!({ "text": text, "count": count })).collect::<Vec<_>>(),
                "fulltexts": { "need": crate::records::needing_full_text(state).len(), "have": state.records.iter().filter(|r| state.eligible(r, Stage::Ft) && r.has_full_text()).count() },
                // std-A: registration lock, review type
                "reporting": crate::protocol_doc::summary_json(state),
            }))
        })
    }

    /// One record as `viewer` sees it at `stage`.
    pub fn record_view(&self, review: &str, record: &str, viewer: &str, stage: Stage, library: &dyn Library) -> Result<Json> {
        self.read(review, |state, conn| {
            let r = state.record(record).ok_or("This record no longer exists")?;
            let meta = metas(conn, review, &[record.to_string()])?.remove(record).ok_or("This record has no metadata")?;
            let ctx = rule_context(&meta, state, library);
            let (mine, others, open) = visible_decisions(state, r, stage, viewer);
            let notes: Vec<&crate::derive::Note> = r.notes.iter().filter(|n| open || n.reviewer == viewer).collect();
            let suggestions = if state.protocol.rules.suggestions { rules::suggestions(&state.protocol, stage, &ctx) } else { Vec::new() };
            let other_stage = if stage == Stage::Ta { Stage::Ft } else { Stage::Ta };
            let (_, other_others, _) = visible_decisions(state, r, other_stage, viewer);
            let batch = state.batch(&r.batch);
            Ok(json!({
                "meta": meta,
                "batch": batch.map(|b| json!({ "id": b.id, "name": b.name, "kind": b.kind, "group": b.group })),
                "status": status_json(&state.status(r, stage)),
                "statuses": { "ta": status_json(&state.status(r, Stage::Ta)), "ft": status_json(&state.status(r, Stage::Ft)) },
                "mine": mine,
                "others": others,
                "unblinded": open,
                "reasonsDiffer": open && state.reasons_differ(r, stage),
                "needed": state.needed(record, stage),
                "resolution": r.resolution(stage).map(|d| decision_json(state, d)),
                "earlier": if stage == Stage::Ft { json!({ "resolution": r.resolution(Stage::Ta).map(|d| decision_json(state, d)), "decisions": other_others, "mine": r.mine(Stage::Ta, viewer).map(|d| decision_json(state, d)) }) } else { Json::Null },
                "notes": notes,
                "labels": r.labels,
                "fulltext": r.fulltext,
                "sourceId": r.source_id,
                "flagged": r.flagged[stage.index()].is_some(),
                "suggestions": suggestions,
                "checks": rules::checks(&state.protocol, stage, &ctx),
                // std-B: hidden while the record is in a blind AI audit the viewer has not decided.
                "ai": if crate::ai_audit::hidden(state, record, stage, viewer) { None } else { r.ai[stage.index()].clone() },
                "aiBlind": crate::ai_audit::hidden(state, record, stage, viewer),
                "pilot": state.pilot_of(record, stage).map(|p| json!({ "id": p.id, "name": p.name, "open": p.open })),
                "assigned": state.assigned(record, stage).iter().map(|id| json!({ "id": id, "name": state.member_name(id) })).collect::<Vec<_>>(),
                "duplicateOf": r.dup_of,
                "removed": r.removed,
                "studyOf": r.study_of,
                "origin": r.origin.as_ref().map(|(g, n)| json!({ "group": g, "name": n })),
                "reports": state.records.iter().filter(|o| o.study_of.as_deref() == Some(record)).map(|o| o.id.clone()).collect::<Vec<_>>(),
                "filled": r.filled,
                "hasFullText": r.has_full_text(),
            }))
        })
    }

    /// A page of records with their state, filtered.
    pub fn list(&self, review: &str, viewer: &str, q: &ListQuery, library: &dyn Library) -> Result<Json> {
        self.read(review, |state, conn| {
            let stage = q.stage.unwrap_or(Stage::Ta);
            let text_hits = (!q.text.trim().is_empty()).then(|| search_ids(conn, review, &q.text)).transpose()?;
            let needs_rules = q.filter == "suggested";
            let mut candidates: Vec<&RecState> = state
                .records
                .iter()
                .filter(|r| match q.filter.as_str() {
                    "duplicates" => r.dup_of.is_some() && !state.active(r) && !state.removed_batches.contains(&r.batch),
                    "removed" => state.removed_batches.contains(&r.batch) || r.removed.is_some(),
                    _ if q.scope == "sources" => !state.removed_batches.contains(&r.batch),
                    _ => state.eligible(r, stage),
                })
                .filter(|r| match q.has_abstract.as_str() {
                    "yes" => r.has_abstract,
                    "no" => !r.has_abstract,
                    _ => true,
                })
                .filter(|r| match q.has_full_text.as_str() {
                    "yes" => r.has_full_text(),
                    "no" => !r.has_full_text(),
                    _ => true,
                })
                .filter(|r| q.group.is_empty() || state.batch(&r.batch).is_some_and(|b| b.group == q.group))
                .filter(|r| text_hits.as_ref().is_none_or(|h| h.contains(&r.id)))
                .filter(|r| q.label.is_empty() || r.labels.contains(&q.label))
                .filter(|r| q.batch.is_empty() || r.batch == q.batch)
                .filter(|r| q.reason.is_empty() || state.final_reasons(r, stage).contains(&q.reason))
                .filter(|r| {
                    let s = state.status(r, stage);
                    match q.filter.as_str() {
                        "" | "all" | "duplicates" | "removed" | "suggested" => true,
                        "active" => state.active(r),
                        "mine" => state.waits_for(r, stage, viewer),
                        "decidedByMe" => r.mine(stage, viewer).is_some(),
                        "undecided" => s == Status::Undecided,
                        "partial" => matches!(s, Status::Partial { .. }),
                        "conflicts" => s == Status::Conflict,
                        "included" => matches!(s, Status::Final { value: Choice::Include, .. }),
                        "excluded" => matches!(s, Status::Final { value: Choice::Exclude, .. }),
                        "auto" => matches!(s, Status::Final { auto: true, .. }),
                        "maybe" => matches!(s, Status::Final { value: Choice::Maybe, .. }),
                        "flagged" => r.flagged[stage.index()].is_some(),
                        "awaiting" => !s.is_final() && s != Status::NotRetrieved && r.source_id.is_none() && r.fulltext.status != "retrieved",
                        "notRetrieved" => s == Status::NotRetrieved,
                        "ai" => r.ai[stage.index()].is_some(),
                        _ => true,
                    }
                })
                .collect();
            let mut found = None;
            if needs_rules {
                let ids: Vec<String> = candidates.iter().map(|r| r.id.clone()).collect();
                let m = metas(conn, review, &ids)?;
                candidates.retain(|r| m.get(&r.id).is_some_and(|meta| !rules::suggestions(&state.protocol, stage, &rule_context(meta, state, library)).is_empty()));
                found = Some(m);
            }
            match q.sort.as_str() {
                "ai" => candidates.sort_by(|a, b| {
                    let s = |r: &RecState| r.ai[stage.index()].as_ref().and_then(|x| x.score).unwrap_or(-1.0);
                    s(b).total_cmp(&s(a))
                }),
                "year" => candidates.sort_by_key(|r| std::cmp::Reverse(r.year.unwrap_or(0))),
                "-year" => candidates.sort_by_key(|r| r.year.unwrap_or(i64::MAX)),
                "-pos" => candidates.reverse(),
                // Text columns sort in SQLite (one query over the review's rows).
                s @ ("title" | "-title" | "journal" | "-journal" | "authors" | "-authors" | "doi" | "-doi") => {
                    let col = s.trim_start_matches('-');
                    let mut st = conn.prepare(&format!("SELECT id FROM review_records WHERE review_id = ?1 ORDER BY lower(coalesce({col}, '')) = '', lower({col})")).map_err(|e| e.to_string())?;
                    let order: HashMap<String, usize> = st.query_map([review], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?.filter_map(|x| x.ok()).enumerate().map(|(i, id)| (id, i)).collect();
                    candidates.sort_by_key(|r| order.get(&r.id).copied().unwrap_or(usize::MAX));
                    if s.starts_with('-') {
                        candidates.reverse();
                    }
                }
                _ => {}
            }
            let total = candidates.len();
            let limit = if q.limit == 0 { 100 } else { q.limit.min(1000) };
            let page: Vec<&RecState> = candidates.into_iter().skip(q.offset).take(limit).collect();
            let ids: Vec<String> = page.iter().map(|r| r.id.clone()).collect();
            let m = match found {
                Some(m) => m,
                None => metas(conn, review, &ids)?,
            };
            let rows: Vec<Json> = page
                .iter()
                .map(|r| {
                    let meta = m.get(&r.id);
                    let (mine, others, _) = visible_decisions(state, r, stage, viewer);
                    let s = state.status(r, stage);
                    let suggestion = meta.filter(|_| state.protocol.rules.suggestions).and_then(|meta| rules::suggestions(&state.protocol, stage, &rule_context(meta, state, library)).into_iter().next());
                    json!({
                        "id": r.id,
                        "title": meta.map(|x| x.title.clone()).unwrap_or_default(),
                        "byline": meta.map(|x| x.byline()).unwrap_or_default(),
                        "journal": meta.map(|x| x.journal.clone()).unwrap_or_default(),
                        "year": r.year,
                        "hasAbstract": r.has_abstract,
                        "status": status_json(&s),
                        "mine": mine.as_ref().and_then(|d| d.get("value").cloned()),
                        "others": others.iter().map(|d| json!({ "value": d["value"], "reviewerName": d["reviewerName"] })).collect::<Vec<_>>(),
                        "count": r.current(stage).len(),
                        "needed": state.needed(&r.id, stage),
                        "reasons": if s.is_final() || unblinded(state, r, stage, viewer) { state.final_reasons(r, stage) } else { Vec::new() },
                        "labels": r.labels,
                        "flagged": r.flagged[stage.index()].is_some(),
                        "fulltext": r.fulltext.status,
                        "sourceId": r.source_id,
                        "suggestion": suggestion,
                        "ai": r.ai[stage.index()].as_ref().filter(|_| !crate::ai_audit::hidden(state, &r.id, stage, viewer)).map(|a| json!({ "value": a.value, "score": a.score })),
                        "duplicateOf": r.dup_of,
                        "batch": r.batch,
                        "batchName": state.batch(&r.batch).map(|b| b.name.clone()),
                        "doi": meta.map(|x| x.doi.clone()).unwrap_or_default(),
                        "pmid": meta.map(|x| x.pmid.clone()).unwrap_or_default(),
                        "authors": meta.map(|x| x.authors.clone()).unwrap_or_default(),
                        "removed": r.removed,
                        "active": state.active(r),
                        "studyOf": r.study_of,
                        "origin": r.origin.as_ref().map(|(g, n)| json!({ "group": g, "name": n })),
                        "filled": r.filled,
                        "hasFullText": r.has_full_text(),
                        "statuses": if q.scope == "sources" { json!({ "ta": status_json(&state.status(r, Stage::Ta)), "ft": status_json(&state.status(r, Stage::Ft)) }) } else { Json::Null },
                    })
                })
                .collect();
            Ok(json!({ "rows": rows, "total": total, "offset": q.offset, "stage": stage }))
        })
    }

    /// The records waiting for `viewer` at a stage, in screening order: open pilots first, then
    /// records flagged for re-screening, then the rest (by AI relevance when that is on).
    pub fn queue(&self, review: &str, viewer: &str, stage: Stage, filter: &str) -> Result<Vec<String>> {
        self.read(review, |state, _| {
            let mut out: Vec<(u8, f64, usize, String)> = Vec::new();
            let ai = state.protocol.rules.ai_assist;
            for r in &state.records {
                let s = state.status(r, stage);
                let take = match filter {
                    // A label's records at this stage, decided or not (to go through them again).
                    f if f.starts_with("label:") => state.eligible(r, stage) && r.labels.contains(&f[6..]),
                    "conflicts" => s == Status::Conflict,
                    "flagged" => r.flagged[stage.index()].is_some() && state.eligible(r, stage),
                    "maybe" => r.mine(stage, viewer).is_some_and(|d| d.value == Choice::Maybe),
                    _ => state.waits_for(r, stage, viewer) || (r.flagged[stage.index()].is_some() && r.mine(stage, viewer).is_some() && state.eligible(r, stage) && !matches!(s, Status::Final { resolved: true, .. })),
                };
                if !take {
                    continue;
                }
                let tier = if state.pilot_of(&r.id, stage).is_some_and(|p| p.open) {
                    0
                } else if r.flagged[stage.index()].is_some() {
                    1
                } else {
                    2
                };
                let score = if ai { -r.ai[stage.index()].as_ref().and_then(|a| a.score).unwrap_or(0.0) } else { 0.0 };
                out.push((tier, score, r.pos, r.id.clone()));
            }
            out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)).then(a.2.cmp(&b.2)));
            Ok(out.into_iter().map(|x| x.3).collect())
        })
    }

    /// Agreement between reviewers at a stage over records two or more of them decided
    /// (optionally only a pilot's): overall and per pair.
    pub fn agreement(&self, review: &str, stage: Stage, pilot: Option<&str>) -> Result<Json> {
        self.read(review, |state, _| {
            let records: Vec<&RecState> = match pilot {
                Some(id) => {
                    let p = state.pilots.iter().find(|p| p.id == id).ok_or("This pilot no longer exists")?;
                    p.records.iter().filter_map(|id| state.record(id)).collect()
                }
                None => state.records.iter().filter(|r| state.eligible(r, stage)).collect(),
            };
            Ok(agreement_over(state, &records, stage))
        })
    }

    /// The extraction of one record: forms with each reviewer's values (blind until the viewer
    /// has a value for that field), agreed values, and fields that differ.
    pub fn extraction_view(&self, review: &str, record: &str, viewer: &str) -> Result<Json> {
        self.read(review, |state, _| {
            let ex = state.extraction.get(record);
            let blind = state.protocol.rules.blind;
            let mut fields = Map::new();
            let mut forms_state = Map::new();
            for form in &state.protocol.forms {
                // What the viewer's answers show and what the form still lacks.
                let given = crate::ops::given_for(state, record, &form.id, viewer);
                let answers: crate::logic::Answers = given.iter().map(|(k, g)| (k.clone(), g.value.clone())).collect();
                let visible = crate::logic::visible_fields(form, &answers);
                let issues = crate::logic::issues(form, &given, &state.protocol.rules);
                let completed = ex.is_some_and(|e| e.completed.get(&form.id).is_some_and(|who| who.contains(viewer)));
                let label = |id: &str| form.fields().find(|f| f.id == id).map(|f| f.label.clone()).unwrap_or_else(|| id.to_string());
                let rules: Map<String, Json> = form
                    .sections
                    .iter()
                    .filter_map(|s| s.show_when.as_ref().map(|w| (format!("section:{}", s.id), json!(crate::logic::describe(w, &label)))))
                    .chain(form.fields().filter_map(|f| f.show_when.as_ref().map(|w| (f.id.clone(), json!(crate::logic::describe(w, &label))))))
                    .collect();
                forms_state.insert(form.id.clone(), json!({ "visible": visible, "issues": issues, "completed": completed, "shownWhen": rules }));
                for f in form.fields() {
                    let key = (form.id.clone(), f.id.clone());
                    let all = ex.and_then(|e| e.values.get(&key));
                    // std-B: no AI suggestion while the study is in a blind coding audit.
                    let suggestion = all.and_then(|v| v.get("ai")).filter(|_| !crate::ai_audit::hidden_extraction(state, record, viewer));
                    let people: Option<BTreeMap<String, crate::derive::Extracted>> = all.map(|v| v.iter().filter(|(who, _)| who.as_str() != "ai").map(|(k, x)| (k.clone(), x.clone())).collect());
                    let values = people.as_ref();
                    let mine = values.and_then(|v| v.get(viewer));
                    let others: Vec<Json> = values
                        .map(|v| v.iter().filter(|(who, _)| who.as_str() != viewer).map(|(who, x)| json!({ "reviewer": who, "reviewerName": state.member_name(who), "value": x.value, "quote": x.quote, "page": x.page, "sourcePos": x.source_pos })).collect())
                        .unwrap_or_default();
                    let differs = values.is_some_and(|v| {
                        let mut it = v.values().map(|x| canonical(&x.value));
                        let first = it.next();
                        it.any(|x| Some(x) != first)
                    });
                    let show_others = !blind || mine.is_some();
                    // A field hidden by the viewer's answers is not compared (its values are kept
                    // but inactive).
                    let shown = visible.contains(&f.id);
                    let differs = differs && shown;
                    fields.insert(
                        format!("{}/{}", form.id, f.id),
                        json!({
                            "mine": mine,
                            "others": if show_others { others } else { Vec::new() },
                            "othersCount": values.map(|v| v.len() - usize::from(mine.is_some())).unwrap_or(0),
                            "final": ex.and_then(|e| e.finals.get(&key)),
                            "suggestion": suggestion,
                            "differs": differs && show_others,
                            "inactive": !shown && mine.is_some_and(|m| !crate::logic::is_empty(Some(&m.value))),
                            "source": crate::logic::source_rule(f, &state.protocol.rules),
                        }),
                    );
                }
            }
            Ok(json!({ "forms": state.protocol.forms, "values": fields, "extractors": state.protocol.rules.extractors, "formState": forms_state }))
        })
    }

    /// Included studies with their extraction progress.
    pub fn studies(&self, review: &str, viewer: &str) -> Result<Json> {
        self.read(review, |state, conn| {
            let included = state.included();
            let ids: Vec<String> = included.iter().map(|r| r.id.clone()).collect();
            let m = metas(conn, review, &ids)?;
            let required: Vec<(String, String)> = state.protocol.forms.iter().flat_map(|f| f.fields().filter(|x| x.required).map(move |x| (f.id.clone(), x.id.clone()))).collect();
            let total_fields: usize = state.protocol.forms.iter().map(|f| f.fields().count()).sum();
            let rows: Vec<Json> = included
                .iter()
                .map(|r| {
                    let ex = state.extraction.get(&r.id);
                    let mine = ex.map(|e| e.values.values().filter(|v| v.contains_key(viewer)).count()).unwrap_or(0);
                    let person = |who: &String| who.as_str() != "ai";
                    let extractors: HashSet<&String> = ex.map(|e| e.values.values().flat_map(|v| v.keys()).filter(|k| person(k)).collect()).unwrap_or_default();
                    let conflicts = ex
                        .map(|e| e.values.iter().filter(|(k, v)| !e.finals.contains_key(*k) && v.iter().filter(|(w, _)| person(w)).map(|(_, x)| canonical(&x.value)).collect::<HashSet<_>>().len() > 1).count())
                        .unwrap_or(0);
                    let _ = &required;
                    // Only fields the answers show count (a hidden follow-up is not missing).
                    let missing: usize = state.protocol.forms.iter().map(|f| crate::logic::issues(f, &crate::ops::given_for(state, &r.id, &f.id, viewer), &state.protocol.rules).iter().filter(|i| i.kind == "required").count()).sum();
                    let meta = m.get(&r.id);
                    json!({
                        "id": r.id, "title": meta.map(|x| x.title.clone()).unwrap_or_default(), "byline": meta.map(|x| x.byline()).unwrap_or_default(),
                        "sourceId": r.source_id, "mine": mine, "fields": total_fields, "extractors": extractors.len(), "conflicts": conflicts, "missingRequired": missing,
                    })
                })
                .collect();
            Ok(json!({ "studies": rows }))
        })
    }

    /// Duplicate pairs still open, with both records.
    pub fn pairs(&self, review: &str, offset: usize, limit: usize) -> Result<Json> {
        self.read(review, |state, conn| {
            let open = state.open_pairs();
            let total = open.len();
            let page: Vec<_> = open.into_iter().skip(offset).take(limit.clamp(1, 200)).collect();
            let ids: Vec<String> = page.iter().flat_map(|p| [p.a.clone(), p.b.clone()]).collect();
            let m = metas(conn, review, &ids)?;
            let rows: Vec<Json> = page.iter().map(|p| json!({ "a": m.get(&p.a), "b": m.get(&p.b), "score": p.score, "reason": p.reason })).collect();
            Ok(json!({ "pairs": rows, "total": total }))
        })
    }
}

/// Values compared as text, so 12 and "12" agree.
fn canonical(v: &Json) -> String {
    match v {
        Json::String(s) => s.trim().to_lowercase(),
        Json::Null => String::new(),
        other => other.to_string(),
    }
}

fn agreement_over(state: &State, records: &[&RecState], stage: Stage) -> Json {
    let mut by_pair: BTreeMap<(String, String), Vec<(String, String)>> = BTreeMap::new();
    let mut all_two: Vec<(String, String)> = Vec::new();
    let mut multi: Vec<Vec<String>> = Vec::new();
    let mut disagreements = Vec::new();
    for r in records {
        let current = r.current(stage);
        if current.len() < 2 {
            continue;
        }
        let ratings: Vec<String> = current.iter().map(|d| format!("{:?}", d.value).to_lowercase()).collect();
        if ratings.iter().any(|x| *x != ratings[0]) {
            disagreements.push(r.id.clone());
        }
        for i in 0..current.len() {
            for j in i + 1..current.len() {
                let (a, b) = (&current[i], &current[j]);
                let (key, pair) = if a.reviewer < b.reviewer { ((a.reviewer.clone(), b.reviewer.clone()), (ratings[i].clone(), ratings[j].clone())) } else { ((b.reviewer.clone(), a.reviewer.clone()), (ratings[j].clone(), ratings[i].clone())) };
                by_pair.entry(key).or_default().push(pair);
            }
        }
        if current.len() == 2 {
            all_two.push((ratings[0].clone(), ratings[1].clone()));
        }
        multi.push(ratings);
    }
    let raters = multi.iter().map(Vec::len).max().unwrap_or(0);
    let overall: Agreement = if raters > 2 {
        let m = multi.iter().map(Vec::len).min().unwrap_or(0);
        stats::fleiss(&multi.iter().filter(|r| r.len() == m).cloned().collect::<Vec<_>>())
    } else {
        stats::cohen(&all_two)
    };
    let pairs: Vec<Json> = by_pair
        .iter()
        .map(|((a, b), ratings)| json!({ "a": a, "b": b, "aName": state.member_name(a), "bName": state.member_name(b), "agreement": stats::cohen(ratings) }))
        .collect();
    json!({ "overall": overall, "pairs": pairs, "disagreements": disagreements, "records": records.len() })
}

fn pilot_agreement(state: &State, p: &crate::derive::Pilot) -> Json {
    let stage = p.stage.unwrap_or(Stage::Ta);
    let records: Vec<&RecState> = p.records.iter().filter_map(|id| state.record(id)).collect();
    agreement_over(state, &records, stage)
}

fn extraction_counts(state: &State, viewer: &str) -> Json {
    let included = state.included();
    let started = included.iter().filter(|r| state.extraction.get(&r.id).is_some_and(|e| e.values.values().any(|v| v.keys().any(|k| k != "ai")))).count();
    let mine = included.iter().filter(|r| state.extraction.get(&r.id).is_some_and(|e| e.values.values().any(|v| v.contains_key(viewer)))).count();
    json!({ "studies": included.len(), "started": started, "mine": mine })
}

/// How many records in the review carry each label (records still in it).
pub fn label_counts(state: &State) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for r in state.records.iter().filter(|r| state.active(r)) {
        for l in &r.labels {
            *out.entry(l.clone()).or_default() += 1;
        }
    }
    out
}

/// Imports whose origin PRISMA cannot report as it stands: a database not named, or an "other
/// method" that is none of PRISMA 2020's (an older Key's "Manual").
pub fn origins_to_check(state: &State) -> Vec<Json> {
    state
        .batches
        .iter()
        .filter(|b| !state.removed_batches.contains(&b.id))
        .filter_map(|b| {
            let records = state.records.iter().filter(|r| r.batch == b.id).count();
            let why = if b.group == "other" && !crate::prisma::OTHER_METHODS.contains(&b.name.as_str()) {
                "PRISMA 2020 has no such method: name the database they came from, or the method (citation searching, websites …)".to_string()
            } else if b.group != "other" && b.per_source.is_empty() && b.name.trim().is_empty() {
                "The database or register is not named".to_string()
            } else {
                return None;
            };
            Some(json!({ "batchId": b.id, "name": crate::prisma::batch_name(b), "group": b.group, "kind": b.kind, "records": records, "why": why }))
        })
        .collect()
}
