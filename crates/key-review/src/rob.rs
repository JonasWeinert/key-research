// Risk of bias, per study or per result (docs/review-design.md, "Risk of bias"). An assessment
// belongs to a study (an included record) and, for result-level tools such as RoB 2 and
// ROBINS-I, to one result ("outcome|time point" of the outcome tables); "" is the whole study.
// It follows a tool definition: domains → points to consider (questions with response options)
// → a domain judgement → an overall judgement. Key suggests domain and overall judgements from
// the answers with each tool's own simple rule; the assessor's judgement is what counts, and a
// judgement that differs from the suggestion needs a reason. Two (or more) assessors work
// independently: in blind mode nobody sees another's answers until everyone needed has marked
// theirs complete; then differing judgements are conflicts, settled by a consensus (final)
// judgement per domain. Every change is an event (`rob.*`), so assessments are versioned in the
// log and merge like the rest of the review.
//
// The shipped tools (rob-tools/*.json): Key's own basic checklist (its own questions), and the
// structure of RoB 2, ROBINS-I, ROBINS-E, the Newcastle–Ottawa scale and QUADAS-2 — domains as
// Key's neutral labels, the judgement scale, a worst-domain default and a link — with no
// questions, paraphrases or algorithms: RoB 2, ROBINS-I and ROBINS-E are CC BY-NC-ND 4.0 and the
// others state no licence (LICENSES.md). The assessor answers with the official tool open;
// anyone holding the rights to a fuller version imports it as a tool of their review.
use crate::derive::State;
use crate::events::Event;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, BTreeSet};

// ── Tool definitions ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Opt {
    pub id: String,
    pub label: String,
}

/// A judgement level: its colour and symbol (so the plots read without colour) and what it
/// means across tools (low | some | high | critical | unclear) for analyses.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Level {
    pub id: String,
    pub label: String,
    /// green | amber | red | darkred | muted
    pub tone: String,
    /// plus | minus | cross | excl | query
    pub symbol: String,
    pub common: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ShowIf {
    pub question: String,
    #[serde(rename = "in")]
    pub one_of: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Question {
    pub id: String,
    pub text: String,
    pub help: String,
    /// The tool's option set this question answers from.
    pub options: String,
    /// How much concern an answer raises (0 none, 1, 2, 3 most), for the "worst" rule.
    pub weights: BTreeMap<String, u8>,
    /// Points an answer earns, for the "stars" rule.
    pub points: BTreeMap<String, f64>,
    pub show_if: Option<ShowIf>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Threshold {
    pub min: f64,
    pub level: String,
}

/// How a domain's judgement is suggested from its answers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DomainRule {
    /// worst (the answer raising most concern decides, through `map`) | stars (points summed,
    /// through `thresholds`) | manual (no suggestion)
    pub kind: String,
    /// Concern 0, 1, 2, 3 → level id.
    pub map: Vec<String>,
    pub thresholds: Vec<Threshold>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Domain {
    pub id: String,
    pub short: String,
    pub name: String,
    pub prompt: String,
    pub questions: Vec<Question>,
    pub rule: DomainRule,
    /// Shown beside the bias domains but not counted in the overall judgement (QUADAS-2).
    pub applicability: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OverallRule {
    /// worst | manual
    pub kind: String,
    pub note: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub short: String,
    pub version: String,
    pub design: String,
    /// result | study
    pub level: String,
    pub url: String,
    pub about: String,
    pub licence: String,
    pub option_sets: BTreeMap<String, Vec<Opt>>,
    /// Best first.
    pub levels: Vec<Level>,
    pub domains: Vec<Domain>,
    pub overall: OverallRule,
    /// Shipped with Key (not edited in this review).
    #[serde(skip_deserializing)]
    pub builtin: bool,
}

const BUILTIN: &[&str] = &[
    include_str!("../rob-tools/key-basic.json"),
    include_str!("../rob-tools/rob2.json"),
    include_str!("../rob-tools/robins-i.json"),
    include_str!("../rob-tools/robins-e.json"),
    include_str!("../rob-tools/nos.json"),
    include_str!("../rob-tools/quadas2.json"),
];

/// The tools Key ships, as editable starting points.
pub fn builtin_tools() -> Vec<Tool> {
    BUILTIN
        .iter()
        .map(|t| {
            let mut tool: Tool = serde_json::from_str(t).expect("shipped risk-of-bias tool");
            tool.builtin = true;
            tool
        })
        .collect()
}

/// A blank tool for the custom tool builder.
pub fn blank_tool() -> Tool {
    Tool {
        id: String::new(),
        name: "Custom tool".into(),
        short: "Custom".into(),
        version: "1".into(),
        design: String::new(),
        level: "study".into(),
        option_sets: BTreeMap::from([("ynu".into(), vec![Opt { id: "yes".into(), label: "Yes".into() }, Opt { id: "no".into(), label: "No".into() }, Opt { id: "unclear".into(), label: "Unclear".into() }])]),
        levels: vec![
            Level { id: "low".into(), label: "Low risk".into(), tone: "green".into(), symbol: "plus".into(), common: "low".into() },
            Level { id: "some".into(), label: "Some concerns".into(), tone: "amber".into(), symbol: "minus".into(), common: "some".into() },
            Level { id: "high".into(), label: "High risk".into(), tone: "red".into(), symbol: "cross".into(), common: "high".into() },
        ],
        domains: vec![Domain {
            id: "d1".into(),
            short: "D1".into(),
            name: "Domain 1".into(),
            prompt: String::new(),
            questions: vec![Question { id: "q1".into(), text: "Question 1".into(), options: "ynu".into(), weights: BTreeMap::from([("yes".into(), 0), ("unclear".into(), 1), ("no".into(), 2)]), ..Default::default() }],
            rule: DomainRule { kind: "worst".into(), map: vec!["low".into(), "some".into(), "high".into()], thresholds: Vec::new() },
            applicability: false,
        }],
        overall: OverallRule { kind: "worst".into(), note: String::new() },
        ..Default::default()
    }
}

const TONES: &[&str] = &["green", "amber", "red", "darkred", "muted"];
const SYMBOLS: &[&str] = &["plus", "minus", "cross", "excl", "query"];
const COMMON: &[&str] = &["low", "some", "high", "critical", "unclear"];

impl Tool {
    pub fn level(&self, id: &str) -> Option<&Level> {
        self.levels.iter().find(|l| l.id == id)
    }
    pub fn rank(&self, id: &str) -> Option<usize> {
        self.levels.iter().position(|l| l.id == id)
    }
    pub fn domain(&self, id: &str) -> Option<&Domain> {
        self.domains.iter().find(|d| d.id == id)
    }
    pub fn options(&self, q: &Question) -> &[Opt] {
        self.option_sets.get(&q.options).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Plain-words reasons a tool cannot be saved.
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("The tool needs an id".into());
        }
        if self.name.trim().is_empty() {
            return Err("Give the tool a name".into());
        }
        if !matches!(self.level.as_str(), "study" | "result") {
            return Err("Say whether the tool rates whole studies or single results".into());
        }
        if self.levels.len() < 2 {
            return Err("A tool needs at least two judgement levels".into());
        }
        let mut seen = BTreeSet::new();
        for l in &self.levels {
            if l.id.trim().is_empty() || l.label.trim().is_empty() || !seen.insert(l.id.as_str()) {
                return Err("Every judgement level needs its own id and a label".into());
            }
            if !TONES.contains(&l.tone.as_str()) || !SYMBOLS.contains(&l.symbol.as_str()) || !COMMON.contains(&l.common.as_str()) {
                return Err(format!("“{}” needs a colour, a symbol and a meaning (low, some concerns, high, critical or unclear)", l.label));
            }
        }
        if self.domains.is_empty() {
            return Err("A tool needs at least one domain".into());
        }
        let mut domains = BTreeSet::new();
        for d in &self.domains {
            if d.id.trim().is_empty() || d.id == "overall" || !domains.insert(d.id.as_str()) {
                return Err("Every domain needs its own id (not “overall”)".into());
            }
            if d.name.trim().is_empty() {
                return Err("Every domain needs a name".into());
            }
            let mut qs = BTreeSet::new();
            for q in &d.questions {
                if q.id.trim().is_empty() || !qs.insert(q.id.as_str()) {
                    return Err(format!("Questions in “{}” need their own ids", d.name));
                }
                if self.options(q).is_empty() {
                    return Err(format!("“{}” needs a set of answers", q.text));
                }
                if let Some(s) = &q.show_if {
                    if !d.questions.iter().take_while(|x| x.id != q.id).any(|x| x.id == s.question) {
                        return Err(format!("“{}” can only depend on a question before it in the same domain", q.text));
                    }
                }
            }
            match d.rule.kind.as_str() {
                "worst" => {
                    if d.rule.map.is_empty() || d.rule.map.iter().any(|l| self.level(l).is_none()) {
                        return Err(format!("“{}”: each concern step needs a judgement level of this tool", d.name));
                    }
                }
                "stars" => {
                    if d.rule.thresholds.is_empty() || d.rule.thresholds.iter().any(|t| self.level(&t.level).is_none()) {
                        return Err(format!("“{}”: each star threshold needs a judgement level of this tool", d.name));
                    }
                }
                "manual" | "" => {}
                other => return Err(format!("Unknown suggestion rule {other}")),
            }
        }
        Ok(())
    }

    /// Whether a question is asked, given the earlier answers in its domain.
    pub fn asked(&self, q: &Question, answers: &BTreeMap<String, String>) -> bool {
        match &q.show_if {
            None => true,
            Some(s) => answers.get(&s.question).is_some_and(|a| s.one_of.iter().any(|o| o == a)),
        }
    }

    /// The suggested judgement of a domain from one assessor's answers (question id → option
    /// id), with the reason in words; None while a question asked is unanswered or the domain is
    /// judged by hand.
    pub fn suggest_domain(&self, domain: &Domain, answers: &BTreeMap<String, String>) -> Option<Suggestion> {
        if domain.questions.is_empty() {
            return None;
        }
        let asked: Vec<&Question> = domain.questions.iter().filter(|q| self.asked(q, answers)).collect();
        if asked.iter().any(|q| !answers.contains_key(&q.id)) {
            return None;
        }
        match domain.rule.kind.as_str() {
            "worst" => {
                let mut worst = 0u8;
                let mut because: Vec<&Question> = Vec::new();
                for q in &asked {
                    let w = q.weights.get(&answers[&q.id]).copied().unwrap_or(0);
                    if w > worst {
                        worst = w;
                        because.clear();
                    }
                    if w == worst && w > 0 {
                        because.push(q);
                    }
                }
                let level = domain.rule.map.get(worst as usize).or(domain.rule.map.last())?.clone();
                let why = if because.is_empty() {
                    "No answer raises a concern".to_string()
                } else {
                    format!("Concern from: {}", because.iter().map(|q| format!("“{}” ({})", q.text, self.option_label(q, &answers[&q.id]))).collect::<Vec<_>>().join("; "))
                };
                Some(Suggestion { level, why })
            }
            "stars" => {
                let points: f64 = asked.iter().map(|q| q.points.get(&answers[&q.id]).copied().unwrap_or(0.0)).sum();
                let level = domain.rule.thresholds.iter().find(|t| points >= t.min)?.level.clone();
                Some(Suggestion { level, why: format!("{} {}", fmt_points(points), if points == 1.0 { "star" } else { "stars" }) })
            }
            _ => None,
        }
    }

    /// The suggested overall judgement from the domain judgements (domain id → level id); None
    /// until every counted domain is judged, or when the tool leaves it to the assessor.
    pub fn suggest_overall(&self, judgements: &BTreeMap<String, String>) -> Option<Suggestion> {
        if self.overall.kind != "worst" {
            return None;
        }
        let counted: Vec<&Domain> = self.domains.iter().filter(|d| !d.applicability).collect();
        let mut worst: Option<(usize, &Domain)> = None;
        for d in &counted {
            let rank = self.rank(judgements.get(&d.id)?)?;
            if worst.is_none_or(|(r, _)| rank > r) {
                worst = Some((rank, d));
            }
        }
        let (rank, d) = worst?;
        let level = self.levels[rank].clone();
        let same = counted.iter().filter(|x| judgements.get(&x.id) == Some(&level.id)).count();
        let why = if rank == 0 { format!("Every domain is {}", level.label.to_lowercase()) } else if same > 1 { format!("{same} domains are {}", level.label.to_lowercase()) } else { format!("{} is {}", d.name, level.label.to_lowercase()) };
        Some(Suggestion { level: level.id, why })
    }

    fn option_label(&self, q: &Question, id: &str) -> String {
        self.options(q).iter().find(|o| o.id == id).map(|o| o.label.clone()).unwrap_or_else(|| id.to_string())
    }
}

fn fmt_points(p: f64) -> String {
    if p.fract() == 0.0 { format!("{}", p as i64) } else { format!("{p:.1}") }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub level: String,
    pub why: String,
}

// ── Derived state ───────────────────────────────────────────────────────────────────

/// A domain (or overall) judgement by one assessor, or the agreed one.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Judgement {
    pub value: String,
    /// Why it differs from Key's suggestion (required then).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reason: String,
    /// The assessor's support for it, in their words.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub support: String,
    pub by: String,
    pub at: i64,
    pub event: String,
    /// The tool version it was made under.
    pub tool_version: String,
    /// How many times it was set (the log keeps each).
    pub changes: usize,
}

/// A passage from the full text supporting a domain, with its place in the document.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Evidence {
    pub id: String,
    pub domain: String,
    pub text: String,
    /// 0-based page, -1 for a saved page without pages.
    pub page: i64,
    pub rects: Vec<Json>,
    pub hash: String,
    pub by: String,
    pub at: i64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    /// "domain/question" → option id.
    pub answers: BTreeMap<String, String>,
    /// domain id or "overall" → judgement.
    pub judgements: BTreeMap<String, Judgement>,
    pub evidence: Vec<Evidence>,
    pub complete: bool,
    pub updated: i64,
}

impl Work {
    pub fn domain_answers(&self, domain: &str) -> BTreeMap<String, String> {
        let prefix = format!("{domain}/");
        self.answers.iter().filter_map(|(k, v)| k.strip_prefix(&prefix).map(|q| (q.to_string(), v.clone()))).collect()
    }
    pub fn values(&self) -> BTreeMap<String, String> {
        self.judgements.iter().map(|(k, j)| (k.clone(), j.value.clone())).collect()
    }
}

/// One assessment: a study (record), a result ("" for the whole study) and a tool.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    pub study: String,
    pub result: String,
    pub tool: String,
}

#[derive(Clone, Debug, Default)]
pub struct Assessment {
    pub by: BTreeMap<String, Work>,
    /// Consensus judgements per domain (and overall).
    pub finals: BTreeMap<String, Judgement>,
}

/// Which tool and which results a study is assessed with (when not the review's default).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StudyPlan {
    pub tool: String,
    /// Results to assess ("outcome|time point"); None: every result it has data for.
    pub results: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Setup {
    /// Independent assessors per assessment; None: as many as extraction asks for.
    pub assessors: Option<usize>,
    /// None: as the screening rules say.
    pub blind: Option<bool>,
    /// The tool new studies start with.
    pub tool: String,
}

#[derive(Clone, Debug, Default)]
pub struct RobState {
    /// Tools defined or edited in this review (they shadow the shipped ones by id).
    pub tools: BTreeMap<String, Tool>,
    pub deleted_tools: BTreeSet<String>,
    pub setup: Setup,
    pub plans: BTreeMap<String, StudyPlan>,
    pub assessments: BTreeMap<Key, Assessment>,
    /// (record, form) pairs whose extraction-form answers were brought in.
    pub migrated: BTreeSet<(String, String)>,
    pub events: usize,
}

fn key_of(e: &Event) -> Option<Key> {
    let study = e.record_id.clone()?;
    let p = &e.payload;
    let tool = p.get("tool").and_then(Json::as_str)?.to_string();
    Some(Key { study, result: p.get("result").and_then(Json::as_str).unwrap_or("").to_string(), tool })
}

impl RobState {
    /// Applies a `rob.*` event; malformed ones are ignored (they stay in the log).
    pub fn apply(&mut self, e: &Event) {
        self.events += 1;
        let p = &e.payload;
        let text = |k: &str| p.get(k).and_then(Json::as_str).unwrap_or("").to_string();
        match e.kind.as_str() {
            "rob.tool" => {
                if p.get("deleted").and_then(Json::as_bool).unwrap_or(false) {
                    let id = text("id");
                    self.tools.remove(&id);
                    self.deleted_tools.insert(id);
                } else if let Ok(tool) = serde_json::from_value::<Tool>(p.get("tool").cloned().unwrap_or(Json::Null)) {
                    self.deleted_tools.remove(&tool.id);
                    self.tools.insert(tool.id.clone(), tool);
                }
            }
            "rob.setup" => {
                if let Ok(s) = serde_json::from_value::<Setup>(p.clone()) {
                    self.setup = s;
                }
            }
            "rob.study" => {
                if let (Some(id), Ok(plan)) = (e.record_id.clone(), serde_json::from_value::<StudyPlan>(p.clone())) {
                    self.plans.insert(id, plan);
                }
            }
            "rob.answer" => {
                let Some(key) = key_of(e) else { return };
                let domain = text("domain");
                if domain.is_empty() {
                    return;
                }
                if let Some(from) = p.get("migratedFrom").and_then(Json::as_str) {
                    self.migrated.insert((key.study.clone(), from.split('/').next().unwrap_or(from).to_string()));
                }
                let value = text("value");
                let work = self.assessments.entry(key).or_default().by.entry(e.actor.clone()).or_default();
                work.updated = e.at;
                // A change reopens the assessor's assessment.
                work.complete = false;
                match p.get("question").and_then(Json::as_str).filter(|q| !q.is_empty()) {
                    Some(q) => {
                        let slot = format!("{domain}/{q}");
                        if value.is_empty() {
                            work.answers.remove(&slot);
                        } else {
                            work.answers.insert(slot, value);
                        }
                    }
                    None => {
                        let changes = work.judgements.get(&domain).map(|j| j.changes).unwrap_or(0) + 1;
                        if value.is_empty() {
                            work.judgements.remove(&domain);
                        } else {
                            work.judgements.insert(domain, Judgement { value, reason: text("reason"), support: text("support"), by: e.actor.clone(), at: e.at, event: e.id.clone(), tool_version: text("toolVersion"), changes });
                        }
                    }
                }
            }
            "rob.evidence" => {
                let Some(key) = key_of(e) else { return };
                let work = self.assessments.entry(key).or_default().by.entry(e.actor.clone()).or_default();
                let id = text("id");
                work.evidence.retain(|x| x.id != id);
                if !p.get("removed").and_then(Json::as_bool).unwrap_or(false) {
                    if let Ok(mut ev) = serde_json::from_value::<Evidence>(p.clone()) {
                        ev.by = e.actor.clone();
                        ev.at = e.at;
                        work.evidence.push(ev);
                    }
                }
                work.updated = e.at;
            }
            "rob.complete" => {
                let Some(key) = key_of(e) else { return };
                let work = self.assessments.entry(key).or_default().by.entry(e.actor.clone()).or_default();
                work.complete = p.get("complete").and_then(Json::as_bool).unwrap_or(true);
            }
            "rob.final" => {
                let Some(key) = key_of(e) else { return };
                let domain = text("domain");
                let value = text("value");
                let a = self.assessments.entry(key).or_default();
                if value.is_empty() {
                    a.finals.remove(&domain);
                } else {
                    let changes = a.finals.get(&domain).map(|j| j.changes).unwrap_or(0) + 1;
                    a.finals.insert(domain, Judgement { value, reason: String::new(), support: text("note"), by: e.actor.clone(), at: e.at, event: e.id.clone(), tool_version: text("toolVersion"), changes });
                }
            }
            _ => {}
        }
    }
}

// ── Reading the state ───────────────────────────────────────────────────────────────

/// Every tool the review can use: its own (edited or custom) ones, then the shipped ones it has
/// not replaced or removed.
pub fn tools(state: &State) -> Vec<Tool> {
    let mut out: Vec<Tool> = state.rob.tools.values().cloned().collect();
    for t in builtin_tools() {
        if !state.rob.tools.contains_key(&t.id) && !state.rob.deleted_tools.contains(&t.id) {
            out.push(t);
        }
    }
    out
}

pub fn tool(state: &State, id: &str) -> Option<Tool> {
    state.rob.tools.get(id).cloned().or_else(|| builtin_tools().into_iter().find(|t| t.id == id))
}

pub fn assessors_needed(state: &State) -> usize {
    state.rob.setup.assessors.unwrap_or(state.protocol.rules.extractors as usize).max(1)
}

pub fn blind(state: &State) -> bool {
    state.rob.setup.blind.unwrap_or(state.protocol.rules.blind)
}

pub fn default_tool(state: &State) -> String {
    let t = &state.rob.setup.tool;
    if !t.is_empty() && tool(state, t).is_some() { t.clone() } else { "rob2".into() }
}

/// The tool a study is assessed with.
pub fn study_tool(state: &State, study: &str) -> String {
    state.rob.plans.get(study).map(|p| p.tool.clone()).filter(|t| tool(state, t).is_some()).unwrap_or_else(|| default_tool(state))
}

/// Where an assessment stands.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Progress {
    NotStarted,
    InProgress,
    /// Some assessors finished, others are still needed.
    Waiting,
    Conflict,
    /// Everyone needed finished and every judgement is agreed (or settled).
    Done,
}

/// The agreed judgements of an assessment (domain or "overall" → level), the domains still in
/// conflict, and its progress. With one assessor needed, theirs is agreed once complete.
pub fn agreed(state: &State, a: &Assessment) -> (BTreeMap<String, String>, Vec<String>, Progress) {
    let need = assessors_needed(state);
    let complete: Vec<&Work> = a.by.iter().filter(|(who, _)| who.as_str() != "ai").map(|(_, w)| w).filter(|w| w.complete).collect();
    let mut out: BTreeMap<String, String> = a.finals.iter().map(|(k, j)| (k.clone(), j.value.clone())).collect();
    let mut conflicts = Vec::new();
    if complete.len() >= need {
        let mut slots: BTreeSet<&String> = BTreeSet::new();
        for w in &complete {
            slots.extend(w.judgements.keys());
        }
        for slot in slots {
            if out.contains_key(slot) {
                continue;
            }
            let values: BTreeSet<Option<&String>> = complete.iter().map(|w| w.judgements.get(slot).map(|j| &j.value)).collect();
            match (values.len(), values.iter().next()) {
                (1, Some(Some(v))) => {
                    out.insert(slot.clone(), (*v).clone());
                }
                _ => conflicts.push(slot.clone()),
            }
        }
    }
    let progress = if !conflicts.is_empty() {
        Progress::Conflict
    } else if complete.len() >= need {
        Progress::Done
    } else if !complete.is_empty() {
        Progress::Waiting
    } else if a.by.values().any(|w| !w.answers.is_empty() || !w.judgements.is_empty()) {
        Progress::InProgress
    } else {
        Progress::NotStarted
    };
    (out, conflicts, progress)
}

/// A result's key in the outcome tables: "outcome|time point".
pub fn result_key(outcome: &str, timepoint: &str) -> String {
    format!("{}|{}", outcome.trim(), timepoint.trim())
}

pub fn result_label(key: &str) -> String {
    match key.split_once('|') {
        _ if key.is_empty() => "Whole study".into(),
        Some((o, t)) if !t.is_empty() => format!("{o} · {t}"),
        Some((o, _)) => o.to_string(),
        None => key.to_string(),
    }
}

/// The overall judgement (as the tool's level and its cross-tool meaning) for a study's result:
/// the result's own assessment, else the study-level one.
pub fn overall_for(state: &State, study: &str, result: &str) -> Option<(Tool, Level, BTreeMap<String, String>)> {
    let tool_id = study_tool(state, study);
    let pick = |result: &str| -> Option<(Tool, Level, BTreeMap<String, String>)> {
        let t = tool(state, &tool_id)?;
        let a = state.rob.assessments.get(&Key { study: study.into(), result: result.into(), tool: tool_id.clone() })?;
        let (values, _, _) = agreed(state, a);
        let level = t.level(values.get("overall")?)?.clone();
        Some((t, level, values))
    };
    pick(result).or_else(|| if result.is_empty() { None } else { pick("") })
}

/// The ordinal a cross-tool meaning stands for (low 0 … critical 3; unclear sits with some).
pub fn common_rank(common: &str) -> u8 {
    match common {
        "low" => 0,
        "some" | "unclear" => 1,
        "high" => 2,
        "critical" => 3,
        _ => 1,
    }
}

/// The interface std-D's analyses use: each study's overall risk of bias for a result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Covariate {
    /// low | some | high | critical | unclear
    pub overall: String,
    pub rank: u8,
    pub tool: String,
    pub domains: Vec<(String, String)>,
}

pub fn covariate(state: &State, study: &str, result: &str) -> Option<Covariate> {
    let (tool, level, values) = overall_for(state, study, result)?;
    let domains = tool.domains.iter().filter_map(|d| values.get(&d.id).map(|v| (d.id.clone(), v.clone()))).collect();
    Some(Covariate { rank: common_rank(&level.common), overall: level.common, tool: tool.id, domains })
}

/// Each included study's overall risk of bias for one outcome (and time point).
pub fn covariates(state: &State, outcome: &str, timepoint: Option<&str>) -> BTreeMap<String, Covariate> {
    let result = result_key(outcome, timepoint.unwrap_or(""));
    state.included().iter().filter_map(|r| covariate(state, &r.id, &result).map(|c| (r.id.clone(), c))).collect()
}

/// For the export "rob-covariates": study → its study-level covariate and one per result.
pub fn covariates_json(state: &State) -> Json {
    let mut out = serde_json::Map::new();
    for r in state.included() {
        let mut entry = covariate(state, &r.id, "").map(|c| serde_json::to_value(c).unwrap_or(Json::Null)).unwrap_or_else(|| json!({}));
        let mut by = serde_json::Map::new();
        for (k, _) in state.rob.assessments.iter().filter(|(k, _)| k.study == r.id && !k.result.is_empty()) {
            if let Some(c) = covariate(state, &r.id, &k.result) {
                by.insert(k.result.clone(), json!({ "overall": c.overall, "rank": c.rank }));
            }
        }
        if entry.as_object().is_some_and(|o| o.is_empty()) && by.is_empty() {
            continue;
        }
        entry["byResult"] = Json::Object(by);
        out.insert(r.id.clone(), entry);
    }
    Json::Object(out)
}

/// What the PRISMA checklist (std-A) reads: how risk of bias and certainty were assessed.
pub fn reporting_facts(state: &State) -> Json {
    let included = state.included();
    let ids: BTreeSet<&str> = included.iter().map(|r| r.id.as_str()).collect();
    let mut tools_used: BTreeSet<String> = BTreeSet::new();
    let mut levels: BTreeSet<&str> = BTreeSet::new();
    let mut assessed: BTreeSet<&str> = BTreeSet::new();
    let mut high = BTreeSet::new();
    let mut max_assessors = 0;
    for (k, a) in &state.rob.assessments {
        if !ids.contains(k.study.as_str()) {
            continue;
        }
        let (values, _, progress) = agreed(state, a);
        if progress != Progress::Done {
            continue;
        }
        if let Some(t) = tool(state, &k.tool) {
            tools_used.insert(t.name.clone());
            levels.insert(if k.result.is_empty() { "study" } else { "result" });
            if let Some(l) = values.get("overall").and_then(|v| t.level(v)) {
                if common_rank(&l.common) >= 2 {
                    high.insert(k.study.as_str());
                }
            }
        }
        assessed.insert(k.study.as_str());
        max_assessors = max_assessors.max(a.by.values().filter(|w| w.complete).count());
    }
    let mut rob = serde_json::Map::new();
    if !assessed.is_empty() {
        let tools: Vec<String> = tools_used.into_iter().collect();
        let level = match levels.len() {
            2 => "for whole studies and for single results",
            _ if levels.contains("result") => "for each result",
            _ => "for each study",
        };
        let who = if max_assessors >= 2 { format!("{} assessors independently", words(max_assessors)) } else { "one assessor".to_string() };
        let resolve = if max_assessors >= 2 {
            if state.protocol.rules.conflicts == "third" { "; disagreements were settled by a third person" } else { "; disagreements were settled by discussion" }
        } else {
            ""
        };
        let blind_text = if max_assessors >= 2 && blind(state) { ", without seeing each other's judgements until both were done" } else { "" };
        rob.insert("statement".into(), json!(format!("Risk of bias was assessed {level} with {} by {who}{blind_text}{resolve}.", join_and(&tools))));
        rob.insert("results".into(), json!(format!("Of {} included studies, {} were assessed; {} at high risk of bias for at least one result.", included.len(), assessed.len(), high.len())));
        rob.insert("tools".into(), json!(tools));
    }
    rob.insert("assessed".into(), json!(assessed.len()));
    rob.insert("usedInAnalysis".into(), json!(state.grade.outcomes.values().any(|g| g.rob_used) || state.analyses.iter().any(|a| a.get("rob").is_some())));
    json!({ "rob": rob, "grade": crate::grade::reporting_facts(state) })
}

fn words(n: usize) -> String {
    match n {
        2 => "Two".into(),
        3 => "Three".into(),
        4 => "Four".into(),
        n => n.to_string(),
    }
}

pub fn join_and(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        n => format!("{} and {}", items[..n - 1].join(", "), items[n - 1]),
    }
}

// ── Migration of extraction-form answers ────────────────────────────────────────────

/// How a RoB template form's fields map onto a tool: form id prefix, tool, and for each field
/// (domain judgement, support, or question) where it goes.
struct FormMap {
    form: &'static str,
    tool: &'static str,
    /// field id → (domain, question or "" for the judgement)
    fields: &'static [(&'static str, &'static str, &'static str)],
    /// form option label → tool option or level id
    values: &'static [(&'static str, &'static str)],
}

const FORM_MAPS: &[FormMap] = &[
    FormMap {
        form: "f-rob2",
        tool: "rob2",
        fields: &[("d1_judgement", "d1", ""), ("d2_judgement", "d2", ""), ("d3_judgement", "d3", ""), ("d4_judgement", "d4", ""), ("d5_judgement", "d5", ""), ("overall_judgement", "overall", "")],
        values: &[("Low risk", "low"), ("Some concerns", "some"), ("High risk", "high")],
    },
    // The old ROBINS-I-style form had selection before classification; ROBINS-I v2 the reverse.
    FormMap {
        form: "f-robins-i",
        tool: "robins-i",
        fields: &[("c1_judgement", "c1", ""), ("c2_judgement", "c3", ""), ("c3_judgement", "c2", ""), ("c4_judgement", "c4", ""), ("c5_judgement", "c5", ""), ("c6_judgement", "c6", ""), ("c7_judgement", "c7", ""), ("overall_judgement", "overall", "")],
        values: &[("Low", "low"), ("Moderate", "moderate"), ("Serious", "serious"), ("Critical", "critical"), ("No information", "noinfo")],
    },
];

/// The events that bring risk-of-bias answers from extraction forms into assessments: one
/// `rob.answer` per value (by the person who gave it), supports as evidence, agreed values as
/// finals, and each person's assessment marked complete when it has every judgement. Studies
/// and forms already brought in are skipped, so running it again adds nothing.
pub fn migration(state: &State, b: &crate::store::Builder) -> Vec<Event> {
    let mut out = Vec::new();
    for r in state.included() {
        let Some(ex) = state.extraction.get(&r.id) else { continue };
        for form in state.protocol.forms.iter().filter(|f| f.kind == "rob") {
            let Some(map) = FORM_MAPS.iter().find(|m| form.id.starts_with(m.form)) else { continue };
            if state.rob.migrated.contains(&(r.id.clone(), form.id.clone())) {
                continue;
            }
            let Some(t) = tool(state, map.tool) else { continue };
            let value_of = |v: &Json| -> Option<String> {
                let s = v.as_str()?.trim();
                map.values.iter().find(|(from, _)| from.eq_ignore_ascii_case(s)).map(|(_, to)| to.to_string())
            };
            let base = |domain: &str, question: &str, value: &str, field: &str| json!({ "result": "", "tool": map.tool, "toolVersion": t.version, "domain": domain, "question": question, "value": value, "migratedFrom": format!("{}/{field}", form.id) });
            let mut people: BTreeMap<String, usize> = BTreeMap::new();
            let mut any = false;
            for (field, domain, question) in map.fields {
                let key = (form.id.clone(), field.to_string());
                if let Some(values) = ex.values.get(&key) {
                    for (who, v) in values.iter().filter(|(who, _)| who.as_str() != "ai") {
                        let Some(value) = value_of(&v.value) else { continue };
                        let mut payload = base(domain, question, &value, field);
                        if question.is_empty() {
                            // The support field beside a judgement: its text, and its quote as evidence.
                            let support_field = field.replace("_judgement", "_support");
                            if let Some(s) = ex.values.get(&(form.id.clone(), support_field.clone())).and_then(|m| m.get(who)) {
                                let text = s.value.as_str().unwrap_or("").to_string();
                                payload["support"] = json!(text);
                                let quote = if s.quote.is_empty() { text.clone() } else { s.quote.clone() };
                                if !quote.trim().is_empty() && *domain != "overall" {
                                    let pos = s.source_pos.clone().unwrap_or(Json::Null);
                                    let page = pos.get("page").and_then(Json::as_i64).or(s.page.map(|p| p - 1)).unwrap_or(-1);
                                    out.push(b.event("rob.evidence", who, Some(&r.id), json!({ "result": "", "tool": map.tool, "domain": domain, "id": format!("m-{}-{}", form.id, support_field), "text": quote, "page": page, "rects": pos.get("rects").cloned().unwrap_or(json!([])), "hash": pos.get("hash").cloned().unwrap_or(json!("")) })));
                                }
                            }
                            *people.entry(who.clone()).or_default() += 1;
                        }
                        out.push(b.event("rob.answer", who, Some(&r.id), payload));
                        any = true;
                    }
                }
                if let Some(f) = ex.finals.get(&key).filter(|_| question.is_empty()) {
                    if let Some(value) = value_of(&f.value) {
                        out.push(b.event("rob.final", &f.reviewer, Some(&r.id), json!({ "result": "", "tool": map.tool, "toolVersion": t.version, "domain": domain, "value": value, "note": "Agreed in the extraction form", "migratedFrom": format!("{}/{field}", form.id) })));
                        any = true;
                    }
                }
            }
            if !any {
                continue;
            }
            let judged = t.domains.len() + 1;
            for (who, n) in people {
                if n >= judged {
                    out.push(b.event("rob.complete", &who, Some(&r.id), json!({ "result": "", "tool": map.tool, "complete": true })));
                }
            }
            if !state.rob.plans.contains_key(&r.id) {
                out.push(b.event("rob.study", "system", Some(&r.id), json!({ "tool": map.tool })));
            }
        }
    }
    out
}

/// How many included studies have extraction-form answers not yet brought in.
pub fn migratable(state: &State) -> usize {
    state
        .included()
        .iter()
        .filter(|r| {
            state.extraction.get(&r.id).is_some_and(|ex| {
                state.protocol.forms.iter().filter(|f| f.kind == "rob").any(|f| {
                    FORM_MAPS.iter().any(|m| f.id.starts_with(m.form)) && !state.rob.migrated.contains(&(r.id.clone(), f.id.clone())) && ex.values.keys().chain(ex.finals.keys()).any(|(form, _)| form == &f.id)
                })
            })
        })
        .count()
}
