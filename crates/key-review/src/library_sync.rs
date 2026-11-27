// A review record and the library source it is linked to (the record's `sourceId`; the host's
// review_commands/library_links.rs keeps their full text one file) also describe the same work
// twice. Here: their details compared field by field with trivial differences folded away (case,
// punctuation, diacritics, author name order and initials, DOI forms, abbreviated page ranges),
// the person's choice per pair and field ("take from the library", "take from the review",
// "keep as they are") remembered in the log; matches the person rejected; link operations that
// can be undone and redone with compensating events (the log stays append-only); and the user's
// own highlights on full texts the review keeps itself (not library sources).
//
// The host runs the library's side of an operation (its source fields, its files); this module
// plans the review's side and records each operation with what undoes it.
use crate::derive::State;
use crate::events::Event;
use crate::model::RecordMeta;
use crate::store::{Result, Reviews};
use key_store::normalize;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const KINDS: &[&str] = &["link.field", "link.reject", "link.op", "highlight.set"];

/// The fields compared, in the order the comparison shows them.
pub const FIELDS: &[(&str, &str)] = &[
    ("title", "Title"),
    ("authors", "Authors"),
    ("year", "Year"),
    ("journal", "Journal"),
    ("volume", "Volume"),
    ("issue", "Issue"),
    ("pages", "Pages"),
    ("doi", "DOI"),
    ("pmid", "PMID"),
    ("pmcid", "PMCID"),
    ("isbn", "ISBN"),
    ("issn", "ISSN"),
    ("abstractText", "Abstract"),
    ("itemType", "Type"),
    ("language", "Language"),
    ("url", "URL"),
];

/// The library's name for a compared field (a source patch key).
pub fn library_key(field: &str) -> &str {
    match field {
        "authors" => "creators",
        "year" => "date",
        "journal" => "containerTitle",
        "abstractText" => "abstract",
        other => other,
    }
}

fn text(v: &str) -> Json {
    if v.trim().is_empty() { Json::Null } else { json!(v.trim()) }
}

/// A record's value for a compared field (null when it has none).
pub fn value(meta: &RecordMeta, field: &str) -> Json {
    match field {
        "title" => text(&meta.title),
        "authors" if meta.authors.iter().any(|a| !a.trim().is_empty()) => json!(meta.authors),
        "authors" => Json::Null,
        "year" => meta.year.map_or(Json::Null, |y| json!(y)),
        "journal" => text(&meta.journal),
        "volume" => text(&meta.volume),
        "issue" => text(&meta.issue),
        "pages" => text(&meta.pages),
        "doi" => text(&meta.doi),
        "pmid" => text(&meta.pmid),
        "abstractText" => text(&meta.abstract_text),
        "itemType" => text(&meta.item_type),
        "language" => text(&meta.language),
        "url" => text(&meta.url),
        other => match meta.extra.get(other) {
            Some(Json::String(s)) => text(s),
            Some(Json::Number(n)) => json!(n.to_string()),
            _ => Json::Null,
        },
    }
}

/// A value as a person reads it.
pub fn display(v: &Json) -> String {
    match v {
        Json::Null => String::new(),
        Json::String(s) => s.clone(),
        Json::Array(a) => a.iter().filter_map(Json::as_str).collect::<Vec<_>>().join("; "),
        other => other.to_string(),
    }
}

/// Initials only ("JA", "J.A.", "J-P"): no lower-case letter, at most four letters.
fn initials(token: &str) -> bool {
    let letters: Vec<char> = token.chars().filter(|c| c.is_alphabetic()).collect();
    !letters.is_empty() && letters.len() <= 4 && letters.iter().all(|c| c.is_uppercase())
}

/// One author as compared: family name (its last word, folded) and first initial, whatever
/// order and form the name came in ("Smith, John A.", "John A. Smith", "Smith JA").
pub fn author_key(name: &str) -> String {
    let name = name.trim();
    let (family, given) = match name.split_once(',') {
        Some((f, g)) => (f.to_string(), g.to_string()),
        None => {
            let parts: Vec<&str> = name.split_whitespace().collect();
            match parts.as_slice() {
                [] => (String::new(), String::new()),
                [one] => (one.to_string(), String::new()),
                [rest @ .., last] if initials(last) => (rest.join(" "), last.to_string()),
                [given @ .., last] => (last.to_string(), given.join(" ")),
            }
        }
    };
    let family = normalize::title_key(&family);
    let family = family.split_whitespace().last().unwrap_or("").to_string();
    let initial = normalize::title_key(&given).chars().find(|c| c.is_alphanumeric()).map(String::from).unwrap_or_default();
    format!("{family} {initial}").trim().to_string()
}

/// "123-30", "pp. 123–130", "123 - 130" → "123-130".
fn pages_key(v: &str) -> String {
    let parts: Vec<String> = v.split(|c: char| c == '-' || c == '–' || c == '—').map(|p| p.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase().trim_start_matches("pp").trim_start_matches('p').to_string()).filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        [start, end] => {
            let end = if end.len() < start.len() && start.chars().all(|c| c.is_ascii_digit()) && end.chars().all(|c| c.is_ascii_digit()) { format!("{}{end}", &start[..start.len() - end.len()]) } else { end.clone() };
            if &end == start { start.clone() } else { format!("{start}-{end}") }
        }
        _ => parts.join("-"),
    }
}

fn type_key(v: &str) -> String {
    let k: String = v.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    match k.as_str() {
        "journalarticle" | "article" | "articlejournal" | "jour" | "magazinearticle" | "review" => "article".into(),
        "booksection" | "chapter" | "bookchapter" | "incollection" | "chap" => "chapter".into(),
        "conferencepaper" | "paperconference" | "proceedingsarticle" | "inproceedings" | "conf" => "conference".into(),
        "thesis" | "dissertation" | "phdthesis" | "mastersthesis" => "thesis".into(),
        "book" | "monograph" => "book".into(),
        "report" | "techreport" | "rprt" => "report".into(),
        "preprint" | "postedcontent" => "preprint".into(),
        other => other.into(),
    }
}

fn language_key(v: &str) -> String {
    let k = v.trim().to_lowercase();
    let k = k.split(['-', '_']).next().unwrap_or("").to_string();
    match k.as_str() {
        "en" | "eng" | "english" => "en".into(),
        "de" | "ger" | "deu" | "german" | "deutsch" => "de".into(),
        "fr" | "fre" | "fra" | "french" | "français" => "fr".into(),
        "es" | "spa" | "spanish" | "español" => "es".into(),
        "it" | "ita" | "italian" => "it".into(),
        "pt" | "por" | "portuguese" => "pt".into(),
        "nl" | "dut" | "nld" | "dutch" => "nl".into(),
        "zh" | "chi" | "zho" | "chinese" => "zh".into(),
        "ja" | "jpn" | "japanese" => "ja".into(),
        other => other.into(),
    }
}

fn url_key(v: &str) -> String {
    let v = v.trim().to_lowercase();
    let v = v.trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("www.");
    v.trim_end_matches('/').to_string()
}

/// A value as compared: "" when empty; trivial differences folded away.
pub fn normal(field: &str, v: &Json) -> String {
    let s = match v {
        Json::Null => return String::new(),
        Json::String(s) => s.trim().to_string(),
        Json::Number(n) => n.to_string(),
        Json::Array(a) if field == "authors" => return a.iter().filter_map(Json::as_str).map(author_key).filter(|k| !k.is_empty()).collect::<Vec<_>>().join("; "),
        other => other.to_string(),
    };
    if s.is_empty() {
        return String::new();
    }
    match field {
        "doi" => normalize::doi(&s).unwrap_or_else(|| normalize::doi_or_text(&s).to_lowercase()),
        "pmid" => normalize::pmid(&s).unwrap_or(s),
        "pmcid" => normalize::pmcid(&s).unwrap_or_else(|| s.to_uppercase()),
        "isbn" => normalize::isbns(&s).join(" "),
        "issn" => s.chars().filter(|c| c.is_ascii_digit() || *c == 'x' || *c == 'X').collect::<String>().to_uppercase(),
        "year" => s.get(..4).unwrap_or(&s).to_string(),
        "authors" => s.split(';').map(author_key).collect::<Vec<_>>().join("; "),
        "pages" => pages_key(&s),
        // Key's "document" is a type not known yet.
        "itemType" if s == "document" => String::new(),
        "itemType" => type_key(&s),
        "language" => language_key(&s),
        "url" => url_key(&s),
        "volume" | "issue" => s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase(),
        "abstractText" => {
            let k = normalize::title_key(&s);
            k.strip_prefix("abstract ").unwrap_or(&k).to_string()
        }
        _ => normalize::title_key(&s),
    }
}

/// A short, stable stamp of a compared value (what a remembered choice was made about).
pub fn stamp(field: &str, v: &Json) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in normal(field, v).bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// A choice the person made for one field of a linked pair.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FieldChoice {
    /// library | review | keep
    pub choice: String,
    pub source_id: String,
    /// The values' stamps when it was made: while both still hold, the field stays quiet.
    pub review: String,
    pub library: String,
    pub at: i64,
    pub actor: String,
}
impl Default for FieldChoice {
    fn default() -> Self {
        Self { choice: "keep".into(), source_id: String::new(), review: String::new(), library: String::new(), at: 0, actor: String::new() }
    }
}

/// A link operation done in the review or in the library: what it did and what undoes it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkOp {
    pub id: String,
    pub actor: String,
    pub label: String,
    /// review | library: where it was done (and is undone from).
    pub origin: String,
    pub record: Option<String>,
    pub at: i64,
    pub forward: Vec<Json>,
    pub inverse: Vec<Json>,
    pub undone: bool,
}

#[derive(Clone, Debug, Default)]
pub struct LinkState {
    /// record → field → choice in force.
    pub choices: HashMap<String, BTreeMap<String, FieldChoice>>,
    /// (record, source) pairs the person said are not the same work.
    pub rejected: HashSet<(String, String)>,
    pub ops: Vec<LinkOp>,
    /// Per actor: undone operations that can be redone, latest last.
    pub redo: HashMap<String, Vec<String>>,
    /// record → highlight id → the reader's annotation (review-only full texts).
    pub highlights: HashMap<String, BTreeMap<String, Json>>,
}

impl LinkState {
    pub fn apply(&mut self, e: &Event) {
        let p = &e.payload;
        let record = e.record_id.clone().unwrap_or_default();
        match e.kind.as_str() {
            "link.field" => {
                let source = p.get("sourceId").and_then(Json::as_str).unwrap_or("").to_string();
                let Some(fields) = p.get("fields").and_then(Json::as_object) else { return };
                let entry = self.choices.entry(record.clone()).or_default();
                for (field, choice) in fields {
                    match serde_json::from_value::<FieldChoice>(choice.clone()) {
                        Ok(mut c) if !choice.is_null() => {
                            c.source_id = source.clone();
                            c.at = e.at;
                            c.actor = e.actor.clone();
                            entry.insert(field.clone(), c);
                        }
                        _ => {
                            entry.remove(field);
                        }
                    }
                }
            }
            "link.reject" => {
                let source = p.get("sourceId").and_then(Json::as_str).unwrap_or("").to_string();
                if p.get("rejected").and_then(Json::as_bool).unwrap_or(true) {
                    self.rejected.insert((record, source));
                } else {
                    self.rejected.remove(&(record, source));
                }
            }
            "link.op" => {
                if let Some(target) = p.get("undo").and_then(Json::as_str) {
                    if let Some(op) = self.ops.iter_mut().find(|o| o.id == target) {
                        op.undone = true;
                        self.redo.entry(e.actor.clone()).or_default().push(target.to_string());
                    }
                } else if let Some(target) = p.get("redo").and_then(Json::as_str) {
                    if let Some(op) = self.ops.iter_mut().find(|o| o.id == target) {
                        op.undone = false;
                    }
                    let stack = self.redo.entry(e.actor.clone()).or_default();
                    stack.retain(|id| id != target);
                } else {
                    let list = |k: &str| p.get(k).and_then(Json::as_array).cloned().unwrap_or_default();
                    let origin = p.get("origin").and_then(Json::as_str).unwrap_or("review").to_string();
                    // A new operation done here ends what could be redone here.
                    if origin == "review" {
                        self.redo.remove(&e.actor);
                    }
                    self.ops.push(LinkOp {
                        id: p.get("op").and_then(Json::as_str).unwrap_or(&e.id).to_string(),
                        actor: e.actor.clone(),
                        label: p.get("label").and_then(Json::as_str).unwrap_or("Link change").to_string(),
                        origin,
                        record: e.record_id.clone(),
                        at: e.at,
                        forward: list("forward"),
                        inverse: list("inverse"),
                        undone: false,
                    });
                }
            }
            "highlight.set" => {
                let entry = self.highlights.entry(record).or_default();
                for a in p.get("upserts").and_then(Json::as_array).into_iter().flatten() {
                    if let Some(id) = a.get("id").and_then(Json::as_str) {
                        entry.insert(id.to_string(), a.clone());
                    }
                }
                for id in p.get("deleted").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str) {
                    entry.remove(id);
                }
            }
            _ => {}
        }
    }

    pub fn is_rejected(&self, record: &str, source: &str) -> bool {
        self.rejected.contains(&(record.to_string(), source.to_string()))
    }
}

/// The review's policy for linked records whose details differ: ask | library | review.
pub fn policy(state: &State) -> &str {
    match state.protocol.rules.linked_sync.as_str() {
        "library" => "library",
        "review" => "review",
        _ => "ask",
    }
}

/// One compared field of a linked pair.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDiff {
    pub field: String,
    pub label: String,
    pub review: Json,
    pub library: Json,
    /// differ (both have it) | reviewOnly | libraryOnly
    pub state: String,
    /// The choice in force for it, if the person made one and both values are as they were.
    pub decided: Option<String>,
    /// Still to look at: counted by the "N fields differ" chip.
    pub pending: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkDiff {
    pub record_id: String,
    pub source_id: String,
    pub policy: String,
    pub fields: Vec<FieldDiff>,
    pub pending: usize,
}

/// The fields where a record and its library source really differ (trivial differences folded).
pub fn compare(state: &State, review: &RecordMeta, library: &RecordMeta, source_id: &str) -> LinkDiff {
    let choices = state.link.choices.get(&review.id);
    let policy = policy(state);
    let mut fields = Vec::new();
    for (field, label) in FIELDS {
        let (a, b) = (value(review, field), value(library, field));
        let (na, nb) = (normal(field, &a), normal(field, &b));
        if na == nb {
            continue;
        }
        let state = if na.is_empty() { "libraryOnly" } else if nb.is_empty() { "reviewOnly" } else { "differ" };
        let decided = choices.and_then(|c| c.get(*field)).filter(|c| c.source_id == source_id && c.review == stamp(field, &a) && c.library == stamp(field, &b)).map(|c| c.choice.clone());
        let pending = decided.is_none() && policy == "ask";
        fields.push(FieldDiff { field: field.to_string(), label: label.to_string(), review: a, library: b, state: state.into(), decided, pending });
    }
    let pending = fields.iter().filter(|f| f.pending).count();
    LinkDiff { record_id: review.id.clone(), source_id: source_id.to_string(), policy: policy.into(), fields, pending }
}

/// An operation planned: its review steps (and, from the host, library and file steps), with
/// what undoes them. Steps: `{"do":"review","kind","payload"}` (an event on the record),
/// `{"do":"library","sourceId","patch"}`, `{"do":"file","sourceId","hash","path"}`,
/// `{"do":"keepBoth","on"}`, `{"do":"annotations","sourceId","upserts","deleted"}`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Plan {
    pub label: String,
    pub record: String,
    pub forward: Vec<Json>,
    pub inverse: Vec<Json>,
}

impl Plan {
    pub fn new(label: impl Into<String>, record: &str) -> Self {
        Plan { label: label.into(), record: record.into(), ..Default::default() }
    }
    /// A review step and what undoes it.
    pub fn review(&mut self, kind: &str, payload: Json, undo: Json) {
        self.forward.push(json!({ "do": "review", "kind": kind, "payload": payload }));
        self.inverse.insert(0, json!({ "do": "review", "kind": kind, "payload": undo }));
    }
    /// A step the host runs (its undo is what the host answers when it runs it).
    pub fn host(&mut self, step: Json) {
        self.forward.push(step);
    }
    pub fn is_empty(&self) -> bool {
        self.forward.is_empty()
    }
}

/// The record's full-text state as a `fulltext.set` payload that puts it back.
pub fn fulltext_now(state: &State, record: &str) -> Json {
    let Some(r) = state.record(record) else { return json!({}) };
    let mut p = json!({ "status": r.fulltext.status, "file": r.fulltext.file, "sourceId": r.source_id });
    if r.source_id.is_none() {
        p["unlink"] = json!(true);
    }
    p
}

fn choice_now(state: &State, record: &str, field: &str) -> Json {
    state.link.choices.get(record).and_then(|c| c.get(field)).map(|c| json!(c)).unwrap_or(Json::Null)
}

/// "Take from the library / from the review / keep as they are" for some fields. The review's
/// side is planned here; the library's patch (`{"do":"library"}`) is run by the host.
pub fn plan_take(state: &State, review: &RecordMeta, library: &RecordMeta, source_id: &str, picks: &[(String, String)]) -> Result<Plan> {
    let mut edits = Map::new();
    let mut undo_edits = Map::new();
    let mut patch = Map::new();
    let mut choices = Map::new();
    let mut undo_choices = Map::new();
    let mut names = Vec::new();
    for (field, choice) in picks {
        let Some((_, label)) = FIELDS.iter().find(|(f, _)| f == field) else { return Err(format!("Unknown field {field}")) };
        let (a, b) = (value(review, field), value(library, field));
        let (after_a, after_b) = match choice.as_str() {
            "library" => {
                edits.insert(field.clone(), if field == "year" { b.clone() } else if b.is_null() && field == "authors" { json!([]) } else if b.is_null() { json!("") } else { b.clone() });
                undo_edits.insert(field.clone(), if a.is_null() && field == "authors" { json!([]) } else if a.is_null() && field != "year" { json!("") } else { a.clone() });
                (b.clone(), b.clone())
            }
            "review" => {
                patch.insert(library_key(field).to_string(), match field.as_str() {
                    "authors" => json!(review.authors.iter().map(|n| match n.split_once(',') {
                        Some((f, g)) => json!({ "family": f.trim(), "given": g.trim(), "role": "author" }),
                        None => json!({ "literal": n.trim(), "role": "author" }),
                    }).collect::<Vec<_>>()),
                    "year" => a.as_i64().map_or(Json::Null, |y| json!(y.to_string())),
                    _ => a.clone(),
                });
                (a.clone(), a.clone())
            }
            "keep" => (a.clone(), b.clone()),
            _ => return Err("Choose the library's value, the review's, or keep both as they are".into()),
        };
        choices.insert(field.clone(), json!({ "choice": choice, "review": stamp(field, &after_a), "library": stamp(field, &after_b) }));
        undo_choices.insert(field.clone(), choice_now(state, &review.id, field));
        names.push(label.to_lowercase());
    }
    let what = match names.as_slice() {
        [one] => one.clone(),
        _ => format!("{} fields", names.len()),
    };
    let source = picks.iter().map(|(_, c)| c.as_str()).collect::<HashSet<_>>();
    let label = match source.iter().next().copied() {
        Some("library") if source.len() == 1 => format!("Take the {what} from the library"),
        Some("review") if source.len() == 1 => format!("Take the {what} from the review"),
        Some("keep") if source.len() == 1 => format!("Keep the {what} as they are"),
        _ => format!("Reconcile {what}"),
    };
    let mut plan = Plan::new(label, &review.id);
    if !edits.is_empty() {
        plan.review("record.edit", json!({ "fields": edits, "from": "library" }), json!({ "fields": undo_edits }));
    }
    if !patch.is_empty() {
        plan.host(json!({ "do": "library", "sourceId": source_id, "patch": patch }));
    }
    plan.review("link.field", json!({ "sourceId": source_id, "fields": choices }), json!({ "sourceId": source_id, "fields": undo_choices }));
    Ok(plan)
}

/// Links a record to a library source the person confirmed is the same work.
pub fn plan_link(state: &State, record: &str, source_id: &str) -> Result<Plan> {
    let r = state.record(record).ok_or("This record no longer exists")?;
    if r.source_id.as_deref() == Some(source_id) {
        return Err("This record is linked to that source already".into());
    }
    let mut plan = Plan::new("Link to the library", record);
    plan.review("fulltext.set", json!({ "sourceId": source_id }), fulltext_now(state, record));
    if state.link.is_rejected(record, source_id) {
        plan.review("link.reject", json!({ "sourceId": source_id, "rejected": false }), json!({ "sourceId": source_id, "rejected": true }));
    }
    Ok(plan)
}

/// Unlinks a record from its library source; the pair is not suggested or linked again.
/// `own` is the library's file copied into the review's files, so the record keeps its full text.
pub fn plan_unlink(state: &State, record: &str, own: Option<Json>) -> Result<Plan> {
    let r = state.record(record).ok_or("This record no longer exists")?;
    let source = r.source_id.clone().ok_or("This record is not linked to the library")?;
    let mut plan = Plan::new("Unlink from the library", record);
    let mut payload = json!({ "sourceId": null, "unlink": true });
    if let Some(file) = own.filter(|_| r.fulltext.file.is_none()) {
        payload["file"] = file;
    }
    plan.review("fulltext.set", payload, fulltext_now(state, record));
    plan.review("link.reject", json!({ "sourceId": source, "rejected": true }), json!({ "sourceId": source, "rejected": state.link.is_rejected(record, &source) }));
    Ok(plan)
}

/// "Not the same work": a suggested match the person rejected.
pub fn plan_reject(state: &State, record: &str, source_id: &str) -> Result<Plan> {
    state.record(record).ok_or("This record no longer exists")?;
    let mut plan = Plan::new("Not the same work", record);
    plan.review("link.reject", json!({ "sourceId": source_id, "rejected": true }), json!({ "sourceId": source_id, "rejected": state.link.is_rejected(record, source_id) }));
    Ok(plan)
}

/// Active records not linked to the library (candidates for possible matches).
pub fn unlinked(state: &State) -> Vec<String> {
    state.records.iter().filter(|r| state.active(r) && r.source_id.is_none()).map(|r| r.id.clone()).collect()
}

impl Reviews {
    /// Records an operation: its review steps as events and the operation (with its undo) itself.
    pub fn link_commit(&self, review: &str, plan: &Plan, origin: &str, actor: &str) -> Result<String> {
        self.write(review, |state, _, b| {
            state.record(&plan.record).ok_or("This record no longer exists")?;
            let mut events: Vec<Event> = review_events(b, &plan.record, &plan.forward, actor);
            let op = crate::events::uuid7();
            events.push(b.event("link.op", actor, Some(&plan.record), json!({ "op": op, "label": plan.label, "origin": origin, "forward": plan.forward, "inverse": plan.inverse })));
            Ok((events, op))
        })
    }

    /// The operation done here (in the review) that ⌘Z takes back next, and the one ⇧⌘Z redoes.
    pub fn link_undo_target(&self, review: &str, actor: &str, redo: bool) -> Result<Option<LinkOp>> {
        self.read(review, |state, _| {
            Ok(if redo {
                state.link.redo.get(actor).and_then(|s| s.last()).and_then(|id| state.link.ops.iter().find(|o| &o.id == id && o.undone && o.origin == "review")).cloned()
            } else {
                state.link.ops.iter().rev().find(|o| o.actor == actor && o.origin == "review" && !o.undone).cloned()
            })
        })
    }

    pub fn link_op(&self, review: &str, op: &str) -> Result<Option<LinkOp>> {
        self.read(review, |state, _| Ok(state.link.ops.iter().find(|o| o.id == op).cloned()))
    }

    /// Takes an operation back (`undo`) or does it again: its review steps as new events (the
    /// log keeps everything), then the mark. The host has run the library's steps already.
    pub fn link_step(&self, review: &str, op: &LinkOp, undo: bool, actor: &str) -> Result<()> {
        let record = op.record.clone().unwrap_or_default();
        self.write(review, |state, _, b| {
            let current = state.link.ops.iter().find(|o| o.id == op.id).ok_or("This change is no longer in the review")?;
            if current.undone == undo {
                return Ok((Vec::new(), ()));
            }
            let steps = if undo { &op.inverse } else { &op.forward };
            let mut events = review_events(b, &record, steps, actor);
            events.push(b.event("link.op", actor, op.record.as_deref(), if undo { json!({ "undo": op.id }) } else { json!({ "redo": op.id }) }));
            Ok((events, ()))
        })
    }

    /// The user's own highlights on a record's full text kept with the review.
    pub fn highlights(&self, review: &str, record: &str) -> Result<Vec<Json>> {
        self.read(review, |state, _| Ok(state.link.highlights.get(record).map(|h| h.values().cloned().collect()).unwrap_or_default()))
    }

    pub fn set_highlights(&self, review: &str, record: &str, upserts: Vec<Json>, deleted: Vec<String>, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            state.record(record).ok_or("This record no longer exists")?;
            let have = state.link.highlights.get(record);
            // Only what changed is logged.
            let upserts: Vec<Json> = upserts.into_iter().filter(|a| a.get("id").and_then(Json::as_str).is_some_and(|id| have.and_then(|h| h.get(id)) != Some(a))).collect();
            let deleted: Vec<String> = deleted.into_iter().filter(|id| have.is_some_and(|h| h.contains_key(id))).collect();
            if upserts.is_empty() && deleted.is_empty() {
                return Ok((Vec::new(), ()));
            }
            Ok((vec![b.event("highlight.set", actor, Some(record), json!({ "upserts": upserts, "deleted": deleted }))], ()))
        })
    }
}

/// The review steps of a plan as events on its record.
fn review_events(b: &crate::store::Builder, record: &str, steps: &[Json], actor: &str) -> Vec<Event> {
    steps
        .iter()
        .filter(|s| s.get("do").and_then(Json::as_str) == Some("review"))
        .filter_map(|s| Some(b.event(s.get("kind")?.as_str()?, actor, Some(record), s.get("payload").cloned().unwrap_or(json!({})))))
        .collect()
}

/// The user's highlights on review-only full texts, one row each.
pub fn highlights_csv(state: &State, metas: &HashMap<String, RecordMeta>) -> String {
    let cell = |s: &str| if s.contains([',', '"', '\n']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() };
    let mut out = String::from("Record,Title,Page,Text,Comment,Colour,Updated\n");
    let mut records: Vec<&String> = state.link.highlights.keys().collect();
    records.sort();
    for record in records {
        let title = metas.get(record).map(|m| m.title.as_str()).unwrap_or("");
        for a in state.link.highlights[record].values() {
            let s = |k: &str| a.get(k).and_then(Json::as_str).unwrap_or("").to_string();
            let page = a.pointer("/range/start/page").and_then(Json::as_i64).map(|p| (p + 1).to_string()).unwrap_or_default();
            out.push_str(&[cell(record), cell(title), page, cell(&s("text")), cell(&s("comment")), cell(&s("color")), cell(&s("updatedAt"))].join(","));
            out.push('\n');
        }
    }
    out
}

/// What an event of this module did, in words (the audit trail).
pub fn describe(e: &Event) -> String {
    let p = &e.payload;
    match e.kind.as_str() {
        "link.field" => format!("Reconciled {} with the library", p.get("fields").and_then(Json::as_object).map(|f| f.keys().map(|k| FIELDS.iter().find(|(x, _)| x == k).map(|(_, l)| l.to_lowercase()).unwrap_or_else(|| k.clone())).collect::<Vec<_>>().join(", ")).unwrap_or_default()),
        "link.reject" if p.get("rejected").and_then(Json::as_bool).unwrap_or(true) => "Marked a library source as not this work".into(),
        "link.reject" => "Allowed a library source to match again".into(),
        "link.op" if p.get("undo").is_some() => "Undid a link change".into(),
        "link.op" if p.get("redo").is_some() => "Redid a link change".into(),
        "link.op" => format!("{}{}", p.get("label").and_then(Json::as_str).unwrap_or("Link change"), if p.get("origin").and_then(Json::as_str) == Some("library") { " (in the library)" } else { "" }),
        "highlight.set" => "Changed highlights in the full text".into(),
        other => other.into(),
    }
}
