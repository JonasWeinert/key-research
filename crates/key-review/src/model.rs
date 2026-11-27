// The review's documents: the protocol (question, rules, criteria, reasons, forms), the team,
// import batches and records. All serialise as camelCase JSON, the same in events, exports and
// templates; every field has a default so older files keep loading.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    /// Title and abstract.
    Ta,
    /// Full text.
    Ft,
}

impl Stage {
    pub fn index(self) -> usize {
        match self {
            Stage::Ta => 0,
            Stage::Ft => 1,
        }
    }
    pub fn parse(text: &str) -> Result<Stage, String> {
        match text {
            "ta" => Ok(Stage::Ta),
            "ft" => Ok(Stage::Ft),
            other => Err(format!("Unknown stage {other}")),
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Stage::Ta => "Title and abstract",
            Stage::Ft => "Full text",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Include,
    Exclude,
    Maybe,
}

impl Choice {
    pub fn label(self) -> &'static str {
        match self {
            Choice::Include => "Include",
            Choice::Exclude => "Exclude",
            Choice::Maybe => "Maybe",
        }
    }
}

// ── Protocol ────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Question {
    /// pico | peco | spider | free
    pub framework: String,
    /// The framework's parts by key (p, i, c, o … or s, pi, d, e, r, t).
    pub parts: BTreeMap<String, String>,
    /// The question in one sentence.
    pub text: String,
}

impl Default for Question {
    fn default() -> Self {
        Self { framework: "pico".into(), parts: BTreeMap::new(), text: String::new() }
    }
}

/// How many decide, and what a decision needs, at one stage.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StageRule {
    /// Independent reviewers each record needs (1 or more).
    pub reviewers: u32,
    /// When excluding, the criteria not met: none (not asked) | first (the one, the first it
    /// fails) | all (every one it fails, at least one). "one" in older files means "first".
    pub reasons: String,
    /// The same for Maybe.
    pub maybe_reasons: String,
    /// Whether "Maybe" is offered.
    pub maybe: bool,
}

impl StageRule {
    fn ta() -> Self {
        Self { reviewers: 1, reasons: "none".into(), maybe_reasons: "none".into(), maybe: true }
    }
    fn ft() -> Self {
        Self { reviewers: 1, reasons: "first".into(), maybe_reasons: "none".into(), maybe: false }
    }
    /// What a choice asks for: none | first | all.
    pub fn asks(&self, value: Choice) -> &str {
        let rule = match value {
            Choice::Exclude => self.reasons.as_str(),
            Choice::Maybe => self.maybe_reasons.as_str(),
            Choice::Include => "none",
        };
        match rule {
            "one" => "first",
            "" => "none",
            other => other,
        }
    }
    fn normalize(&mut self) {
        if self.reasons == "one" {
            self.reasons = "first".into();
        }
        if self.maybe_reasons.is_empty() {
            self.maybe_reasons = "none".into();
        }
    }
}

impl Default for StageRule {
    fn default() -> Self {
        Self::ta()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Rules {
    pub ta: StageRule,
    pub ft: StageRule,
    /// Reviewers do not see each other's decisions until both have decided.
    pub blind: bool,
    /// consensus | third (a tie-breaker decides)
    pub conflicts: String,
    /// Extracted values need a quote from the paper.
    pub quote_required: bool,
    /// Independent extractors per study (1 or 2).
    pub extractors: u32,
    /// Rules and AI may order the queue (most likely relevant first).
    pub ai_assist: bool,
    /// Show the suggestions of criteria linked to metadata.
    pub suggestions: bool,
    /// Go to the next record as soon as a decision is complete.
    pub auto_advance: bool,
    /// Where an extracted value came from in the document: none | encouraged | required, for
    /// fields that do not set their own.
    pub source_default: String,
}

impl Default for Rules {
    fn default() -> Self {
        Self { ta: StageRule::ta(), ft: StageRule::ft(), blind: true, conflicts: "consensus".into(), quote_required: false, extractors: 1, ai_assist: false, suggestions: true, auto_advance: true, source_default: "none".into() }
    }
}

impl Rules {
    pub fn stage(&self, stage: Stage) -> &StageRule {
        match stage {
            Stage::Ta => &self.ta,
            Stage::Ft => &self.ft,
        }
    }
}

/// One condition on a record's metadata. Fields: itemType, year, language, title, abstract,
/// journal, keywords, authors, doi, hasAbstract, hasFullText, hasDoi, `property:<name>` (the
/// linked library source's custom property), or `formula` (a Key formula; `value` is its text).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Condition {
    pub field: String,
    /// is | isNot | lt | le | gt | ge | contains | notContains | oneOf | exists | missing | true | false
    pub op: String,
    pub value: Json,
}

/// When a criterion is met, read from metadata.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MetadataLink {
    pub conditions: Vec<Condition>,
    /// All conditions (true) or any (false).
    pub all: bool,
    /// suggest (shown as a suggestion) | auto (applied as a decision, labelled, undoable)
    pub effect: String,
    /// The conditions say when the criterion is *not* met (criteria that were exclusion
    /// criteria before criteria and reasons became one list).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub fails_when: bool,
}

impl Default for MetadataLink {
    fn default() -> Self {
        Self { conditions: Vec::new(), all: true, effect: "suggest".into(), fails_when: false }
    }
}

/// The parts of a review question criteria are grouped under.
pub const ELEMENTS: &[(&str, &str)] = &[
    ("population", "Population"),
    ("intervention", "Intervention"),
    ("exposure", "Exposure"),
    ("comparator", "Comparator"),
    ("outcome", "Outcome"),
    ("sample", "Sample"),
    ("phenomenon", "Phenomenon of interest"),
    ("evaluation", "Evaluation"),
    ("research", "Research type"),
    ("design", "Study design"),
    ("other", "Other"),
];

/// The elements a framework's criteria are grouped by, in order.
pub fn elements_of(framework: &str) -> &'static [&'static str] {
    match framework {
        "peco" => &["population", "exposure", "comparator", "outcome", "design", "other"],
        "spider" => &["sample", "phenomenon", "design", "evaluation", "research", "other"],
        "free" => &["design", "other"],
        _ => &["population", "intervention", "comparator", "outcome", "design", "other"],
    }
}

/// One eligibility criterion: a rule a study must meet. Excluding a study means choosing the
/// criterion (or criteria) it fails; the criterion is the reason PRISMA reports. The list's
/// order is the reason hierarchy (the first failed criterion is the one reported).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Criterion {
    pub id: String,
    /// The question's part it belongs to (`ELEMENTS`).
    pub element: String,
    /// What a study must meet, stated once ("Adults with type 2 diabetes").
    pub label: String,
    /// How the reason reads in reports when a study fails it ("Wrong population"); empty:
    /// derived from the label.
    pub reason: String,
    pub guidance: String,
    pub stages: Vec<Stage>,
    pub link: Option<MetadataLink>,
    /// Before criteria and reasons were one list: include | exclude. Read, never written.
    #[serde(skip_serializing)]
    pub kind: String,
    /// Before criteria and reasons were one list: the reason it gave. Read, never written.
    #[serde(skip_serializing)]
    pub reason_id: Option<String>,
}

impl Default for Criterion {
    fn default() -> Self {
        Self { id: String::new(), element: "other".into(), label: String::new(), reason: String::new(), guidance: String::new(), stages: vec![Stage::Ta, Stage::Ft], link: None, kind: String::new(), reason_id: None }
    }
}

fn lower_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        // Keep acronyms (RCT, HIV) as they are.
        Some(c) if chars.clone().next().is_some_and(|n| n.is_uppercase()) => format!("{c}{}", chars.as_str()),
        Some(c) => format!("{}{}", c.to_lowercase(), chars.as_str()),
        None => String::new(),
    }
}

impl Criterion {
    /// The reason as reports show it.
    pub fn reason_text(&self) -> String {
        if !self.reason.trim().is_empty() {
            self.reason.trim().to_string()
        } else {
            format!("Not met: {}", lower_first(self.label.trim()))
        }
    }
    pub fn applies(&self, stage: Stage) -> bool {
        self.stages.is_empty() || self.stages.contains(&stage)
    }
}

/// An exclusion reason as reviews kept them before criteria and reasons were one list (read
/// from old protocols and turned into criteria, see `Protocol::migrate`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LegacyReason {
    pub id: String,
    pub label: String,
    pub guidance: String,
    pub stages: Vec<Stage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Keywords {
    /// Words that speak for inclusion (highlighted green).
    pub include: Vec<String>,
    /// Words that speak for exclusion (highlighted red).
    pub exclude: Vec<String>,
}

/// One field of an extraction form.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Field {
    pub id: String,
    pub label: String,
    /// text | longtext | number | choice | multi | date | yesno | table
    pub kind: String,
    pub guidance: String,
    pub required: bool,
    /// A quote from the paper must back the value.
    pub quote: bool,
    pub options: Vec<String>,
    pub unit: String,
    /// The columns of a table (repeating group: arms, outcomes …).
    pub columns: Vec<Field>,
    /// What the meta-analysis reads: "outcomes" on a table of outcome data, "subgroup" on a field
    /// that names a study's subgroup.
    pub role: String,
    /// The value's place in the document (page, position, quoted text): "" (the review's
    /// default) | none | encouraged | required.
    pub source: String,
    /// Shown only when this holds (on other fields' answers; inside a table, on the same row).
    pub show_when: Option<ShowWhen>,
    /// Checks against other answers ("events at most the total").
    pub checks: Vec<FieldCheck>,
}

/// When a field or section is shown.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShowWhen {
    pub conditions: Vec<FieldCondition>,
    /// All conditions (true) or any (false).
    pub all: bool,
}

impl Default for ShowWhen {
    fn default() -> Self {
        Self { conditions: Vec::new(), all: true }
    }
}

/// A condition on another field's answer: is | isNot | oneOf | filled | empty | lt | le | gt | ge |
/// yes | no.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FieldCondition {
    pub field: String,
    pub op: String,
    pub value: Json,
}

/// A check of this field's answer against a number or another field: lt | le | gt | ge | is | isNot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FieldCheck {
    pub op: String,
    /// Another field (inside a table: a column of the same row) …
    pub other: Option<String>,
    /// … or a fixed value.
    pub value: Json,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Section {
    pub id: String,
    pub title: String,
    pub guidance: String,
    pub fields: Vec<Field>,
    /// The whole section is shown only when this holds.
    pub show_when: Option<ShowWhen>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Form {
    pub id: String,
    pub name: String,
    /// characteristics | outcomes | rob | custom
    pub kind: String,
    pub sections: Vec<Section>,
}

impl Form {
    pub fn fields(&self) -> impl Iterator<Item = &Field> {
        self.sections.iter().flat_map(|s| s.fields.iter())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Protocol {
    pub question: Question,
    pub registration: String,
    pub notes: String,
    pub rules: Rules,
    /// The eligibility criteria, in the order of the reason hierarchy.
    pub criteria: Vec<Criterion>,
    /// Old protocols' separate exclusion reasons: read, migrated into criteria, never written.
    #[serde(skip_serializing)]
    pub reasons: Vec<LegacyReason>,
    pub keywords: Keywords,
    pub labels: Vec<String>,
    /// A key for each label that has one (Background: b, Check later: l).
    pub label_keys: BTreeMap<String, String>,
    pub forms: Vec<Form>,
    /// Keyboard shortcuts the reviewer changed (action → key).
    pub shortcuts: BTreeMap<String, String>,
}

impl Default for Protocol {
    fn default() -> Self {
        crate::templates::default_protocol()
    }
}

impl Protocol {
    pub fn criterion(&self, id: &str) -> Option<&Criterion> {
        self.criteria.iter().find(|c| c.id == id)
    }
    /// A reason (criterion id) as reports show it.
    pub fn reason_label(&self, id: &str) -> String {
        self.criterion(id).map(Criterion::reason_text).unwrap_or_else(|| id.to_string())
    }
    /// The criteria offered as reasons at a stage, in order.
    pub fn criteria_at(&self, stage: Stage) -> impl Iterator<Item = &Criterion> {
        self.criteria.iter().filter(move |c| c.applies(stage))
    }
    /// The reason PRISMA reports among `ids`: the first in the criteria's order.
    pub fn top_reason<'a>(&self, ids: &'a [String]) -> Option<&'a String> {
        ids.iter().min_by_key(|id| self.criteria.iter().position(|c| &c.id == *id).unwrap_or(usize::MAX))
    }
    /// Reads any older shape: criteria plus reasons, "one" for "first"; answers the old reason
    /// ids' criteria.
    pub fn normalize(&mut self) -> BTreeMap<String, String> {
        self.rules.ta.normalize();
        self.rules.ft.normalize();
        if self.rules.source_default.is_empty() {
            self.rules.source_default = "none".into();
        }
        self.migrate()
    }
    /// The key that toggles a label, if any.
    pub fn label_key(&self, label: &str) -> Option<&str> {
        self.label_keys.get(label).map(String::as_str).filter(|k| !k.is_empty())
    }
    /// Whether this protocol was written before criteria and reasons became one list.
    pub fn is_legacy(&self) -> bool {
        !self.reasons.is_empty() || self.criteria.iter().any(|c| !c.kind.is_empty() || c.reason_id.is_some())
    }

    /// Turns an old protocol (criteria plus a separate list of reasons) into criteria only, and
    /// answers which old reason ids now mean which criterion. Reasons a criterion named collapse
    /// into it; the others become criteria of their own (the defaults under their question
    /// element, any others under Other); exclusion criteria are restated as what a study must
    /// meet. The old reasons' order stays the hierarchy.
    pub fn migrate(&mut self) -> BTreeMap<String, String> {
        let mut aliases = BTreeMap::new();
        if !self.is_legacy() {
            return aliases;
        }
        let reasons = std::mem::take(&mut self.reasons);
        let rank_of = |id: &str| reasons.iter().position(|r| r.id == id);
        let mut ranked: Vec<(usize, Criterion)> = Vec::new();
        let mut taken: std::collections::HashSet<String> = self.criteria.iter().map(|c| c.id.clone()).collect();
        for (i, mut c) in std::mem::take(&mut self.criteria).into_iter().enumerate() {
            let reason = c.reason_id.take().and_then(|id| reasons.iter().find(|r| r.id == id).cloned());
            if c.kind == "exclude" {
                // The reason it gave stays the wording reports use; else its own label.
                c.reason = match &reason {
                    Some(r) if c.reason.is_empty() => r.label.clone(),
                    _ if c.reason.is_empty() => c.label.clone(),
                    _ => c.reason.clone(),
                };
                if !c.label.to_lowercase().starts_with("not ") {
                    c.label = format!("Not {}", lower_first(&c.label));
                }
                if let Some(link) = c.link.as_mut() {
                    link.fails_when = !link.fails_when;
                }
            }
            c.kind.clear();
            let mut rank = reasons.len() + i;
            if let Some(r) = reason {
                if !aliases.contains_key(&r.id) {
                    aliases.insert(r.id.clone(), c.id.clone());
                    rank = rank_of(&r.id).unwrap_or(rank);
                    if c.reason.is_empty() {
                        c.reason = r.label.clone();
                    }
                    if c.element.is_empty() || c.element == "other" {
                        c.element = crate::templates::legacy_element(&r.id).to_string();
                    }
                }
            }
            if c.element.is_empty() {
                c.element = "other".into();
            }
            ranked.push((rank, c));
        }
        for (rank, r) in reasons.iter().enumerate() {
            if aliases.contains_key(&r.id) {
                continue;
            }
            let mut c = crate::templates::legacy_criterion(r);
            let base = c.id.clone();
            let mut n = 2;
            while taken.contains(&c.id) {
                c.id = format!("{base}-{n}");
                n += 1;
            }
            taken.insert(c.id.clone());
            aliases.insert(r.id.clone(), c.id.clone());
            ranked.push((rank, c));
        }
        ranked.sort_by_key(|(rank, _)| *rank);
        self.criteria = ranked.into_iter().map(|(_, c)| c).collect();
        aliases
    }

    pub fn validate(&self) -> Result<(), String> {
        for stage in [Stage::Ta, Stage::Ft] {
            let rule = self.rules.stage(stage);
            if rule.reviewers == 0 || rule.reviewers > 10 {
                return Err(format!("{}: choose 1 to 10 reviewers", stage.label()));
            }
            for r in [rule.asks(Choice::Exclude), rule.asks(Choice::Maybe)] {
                if !["none", "first", "all"].contains(&r) {
                    return Err(format!("{}: unknown rule for the criteria not met", stage.label()));
                }
            }
        }
        if !["consensus", "third"].contains(&self.rules.conflicts.as_str()) {
            return Err("Choose how conflicts are resolved".into());
        }
        let mut ids = std::collections::HashSet::new();
        for c in &self.criteria {
            if c.id.is_empty() || !ids.insert(c.id.clone()) {
                return Err(format!("Criterion \"{}\" needs a unique id", c.label));
            }
            if c.label.trim().is_empty() {
                return Err("Every criterion needs a short statement".into());
            }
            if !ELEMENTS.iter().any(|(id, _)| *id == c.element) {
                return Err(format!("Criterion \"{}\": unknown part of the question", c.label));
            }
            if let Some(link) = &c.link {
                if !["suggest", "auto"].contains(&link.effect.as_str()) {
                    return Err(format!("Criterion \"{}\": unknown effect", c.label));
                }
            }
        }
        for f in &self.forms {
            if f.id.is_empty() || !ids.insert(f.id.clone()) {
                return Err(format!("Form \"{}\" needs a unique id", f.name));
            }
            crate::logic::validate_form(f)?;
        }
        // Keys: one action each.
        let mut keys: BTreeMap<String, String> = BTreeMap::new();
        for (action, fallback) in [("include", "i"), ("exclude", "e"), ("maybe", "m")] {
            keys.insert(self.shortcuts.get(action).cloned().unwrap_or_else(|| fallback.into()).to_lowercase(), action.into());
        }
        for reserved in ["j", "k", "u", "n"] {
            keys.entry(reserved.into()).or_insert_with(|| "moving between records, undo and notes".into());
        }
        for (label, key) in &self.label_keys {
            let key = key.trim().to_lowercase();
            if key.is_empty() {
                continue;
            }
            if key.chars().count() != 1 || !key.chars().all(|c| c.is_alphabetic()) {
                return Err(format!("The key for \"{label}\" must be one letter"));
            }
            if let Some(used) = keys.get(&key) {
                return Err(format!("The key {} is taken by {used}", key.to_uppercase()));
            }
            keys.insert(key, format!("the label {label}"));
        }
        Ok(())
    }
}

// ── Team ────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Member {
    pub id: String,
    pub name: String,
    /// owner | reviewer | tiebreaker
    pub roles: Vec<String>,
    /// Short initials shown on decisions.
    pub initials: String,
}

impl Member {
    pub fn can_resolve(&self, rules: &Rules) -> bool {
        if rules.conflicts == "third" {
            self.roles.iter().any(|r| r == "tiebreaker" || r == "owner")
        } else {
            true
        }
    }
}

// ── Sources ─────────────────────────────────────────────────────────────────────────

/// One import: a file, a library selection, a database search run or another method.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Batch {
    pub id: String,
    /// file | library | database | other
    pub kind: String,
    /// PRISMA 2020 column: databases | registers | other (citation searching, websites …)
    pub group: String,
    /// What it is: the database or register ("PubMed"), or the other method
    /// ("Citation searching", "Websites", "Organisations", "Manual").
    pub name: String,
    pub file_name: String,
    /// The search strategy as run.
    pub strategy: String,
    pub searched_at: String,
    /// Records as identified (before de-duplication).
    pub count: usize,
    /// Records per database of a multi-database run: name → count.
    pub per_source: BTreeMap<String, usize>,
    /// What PRISMA counts each of those as (name → database | register | repository | other),
    /// from the connector that searched it: a run can mix databases and trial registers.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub per_source_kind: BTreeMap<String, String>,
    pub db_run_id: String,
    /// Duplicates the database search removed before the records came here (counted in PRISMA).
    pub duplicates_removed: usize,
    pub note: String,
    pub at: i64,
    pub actor: String,
}

/// A record's metadata, as it was imported.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordMeta {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub abstract_text: String,
    pub authors: Vec<String>,
    pub year: Option<i64>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub journal: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub volume: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub issue: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub pages: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub doi: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub pmid: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub item_type: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub language: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    /// The library source it is (imported from the library, or added for its full text).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// Anything else the file had.
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Json>,
}

impl RecordMeta {
    /// "Family, Family … (year)" for lists.
    pub fn byline(&self) -> String {
        let families: Vec<String> = self.authors.iter().map(|a| a.split(',').next().unwrap_or(a).trim().to_string()).collect();
        let who = match families.len() {
            0 => String::new(),
            1 => families[0].clone(),
            2 => format!("{} and {}", families[0], families[1]),
            _ => format!("{} et al.", families[0]),
        };
        match (who.is_empty(), self.year) {
            (false, Some(y)) => format!("{who} ({y})"),
            (false, None) => who,
            (true, Some(y)) => y.to_string(),
            (true, None) => String::new(),
        }
    }
}
