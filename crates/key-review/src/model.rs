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
    /// Exclusion reasons: none | one | all (all that apply, at least one).
    pub reasons: String,
    /// Whether "Maybe" is offered.
    pub maybe: bool,
}

impl StageRule {
    fn ta() -> Self {
        Self { reviewers: 1, reasons: "none".into(), maybe: true }
    }
    fn ft() -> Self {
        Self { reviewers: 1, reasons: "one".into(), maybe: false }
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
}

impl Default for Rules {
    fn default() -> Self {
        Self { ta: StageRule::ta(), ft: StageRule::ft(), blind: true, conflicts: "consensus".into(), quote_required: false, extractors: 1, ai_assist: false, suggestions: true }
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
}

impl Default for MetadataLink {
    fn default() -> Self {
        Self { conditions: Vec::new(), all: true, effect: "suggest".into() }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Criterion {
    pub id: String,
    /// include | exclude
    pub kind: String,
    pub label: String,
    pub guidance: String,
    pub stages: Vec<Stage>,
    /// The exclusion reason a record gets when it fails this criterion.
    pub reason_id: Option<String>,
    pub link: Option<MetadataLink>,
}

impl Default for Criterion {
    fn default() -> Self {
        Self { id: String::new(), kind: "include".into(), label: String::new(), guidance: String::new(), stages: vec![Stage::Ta, Stage::Ft], reason_id: None, link: None }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Reason {
    pub id: String,
    pub label: String,
    pub guidance: String,
    /// The stages it is offered at (empty: both).
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Section {
    pub id: String,
    pub title: String,
    pub guidance: String,
    pub fields: Vec<Field>,
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
    pub criteria: Vec<Criterion>,
    /// Exclusion reasons, in the order of the hierarchy (the first that applies is the one
    /// PRISMA reports).
    pub reasons: Vec<Reason>,
    pub keywords: Keywords,
    pub labels: Vec<String>,
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
    pub fn reason(&self, id: &str) -> Option<&Reason> {
        self.reasons.iter().find(|r| r.id == id)
    }
    pub fn criterion(&self, id: &str) -> Option<&Criterion> {
        self.criteria.iter().find(|c| c.id == id)
    }
    /// The reason PRISMA reports among `ids`: the first in the hierarchy.
    pub fn top_reason<'a>(&self, ids: &'a [String]) -> Option<&'a String> {
        ids.iter().min_by_key(|id| self.reasons.iter().position(|r| &r.id == *id).unwrap_or(usize::MAX))
    }
    pub fn validate(&self) -> Result<(), String> {
        for stage in [Stage::Ta, Stage::Ft] {
            let rule = self.rules.stage(stage);
            if rule.reviewers == 0 || rule.reviewers > 10 {
                return Err(format!("{}: choose 1 to 10 reviewers", stage.label()));
            }
            if !["none", "one", "all"].contains(&rule.reasons.as_str()) {
                return Err(format!("{}: unknown reason rule", stage.label()));
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
                return Err("Every criterion needs a short label".into());
            }
            if let Some(link) = &c.link {
                if !["suggest", "auto"].contains(&link.effect.as_str()) {
                    return Err(format!("Criterion \"{}\": unknown effect", c.label));
                }
            }
        }
        for r in &self.reasons {
            if r.id.is_empty() || !ids.insert(r.id.clone()) {
                return Err(format!("Reason \"{}\" needs a unique id", r.label));
            }
        }
        for f in &self.forms {
            if f.id.is_empty() || !ids.insert(f.id.clone()) {
                return Err(format!("Form \"{}\" needs a unique id", f.name));
            }
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
    pub db_run_id: String,
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
