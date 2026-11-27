// std-A: the protocol as a document. PRISMA-P 2015's items (Moher et al., Syst Rev 2015;4:1;
// CC BY 4.0; item numbers and topics followed, wording Key's own), the fields PROSPERO's
// registration form asks for (its 2025 form could not be read without an account: sections
// from a secondary description, see docs/research), and an OSF-style outline for reviews
// outside health. Everything Key already knows is filled in from the review (question,
// criteria, rules, forms, team, searches); the rest is the plan (`Protocol::plan`), versioned
// with the protocol. Registering (`protocol.register`) locks it: every later change to what
// the protocol says is a new version with a reason, listed as a deviation from the protocol.
use crate::derive::State;
use crate::model::*;
use crate::report_text::{capital, count_word, date, join_and, md_cell, plural, software};
use crate::reporting::Registration;
use crate::store::{Result, Reviews};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Author {
    pub name: String,
    pub affiliation: String,
    pub email: String,
    /// What they do in the review ("Screening, extraction, analysis").
    pub contribution: String,
    pub guarantor: bool,
    /// The named contact.
    pub contact: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PlannedOutcome {
    pub name: String,
    /// primary | secondary
    pub priority: String,
    pub timepoint: String,
    pub measure: String,
}

/// The protocol beyond question, criteria, rules and forms.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Plan {
    /// systematic | scoping | rapid | living ("" = systematic)
    #[serde(skip_serializing_if = "String::is_empty")]
    pub review_type: String,
    /// Text fields by id (`FIELDS`).
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub text: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<Author>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub outcomes: Vec<PlannedOutcome>,
    /// Pre-specified subgroup analyses.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub subgroups: Vec<String>,
    /// Pre-specified sensitivity analyses.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sensitivity: Vec<String>,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        *self == Plan::default()
    }
    pub fn review_type(&self) -> &str {
        match self.review_type.as_str() {
            "scoping" | "rapid" | "living" => self.review_type.as_str(),
            _ => "systematic",
        }
    }
    pub fn get(&self, id: &str) -> &str {
        self.text.get(id).map(|s| s.trim()).unwrap_or("")
    }
}

pub const REVIEW_TYPES: &[(&str, &str)] = &[("systematic", "Systematic review"), ("scoping", "Scoping review"), ("rapid", "Rapid review"), ("living", "Living systematic review")];

pub fn type_label(t: &str) -> &'static str {
    REVIEW_TYPES.iter().find(|(id, _)| *id == t).map(|(_, l)| *l).unwrap_or("Systematic review")
}

/// One field of the protocol document.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDef {
    pub id: &'static str,
    /// PRISMA-P item ("3a"), or "" for registry-only fields.
    pub item: &'static str,
    pub section: &'static str,
    pub label: &'static str,
    /// Plain guidance in Key's words.
    pub guidance: &'static str,
    /// text | long | date | authors | outcomes | analyses | registration | amendments
    pub kind: &'static str,
    /// Review types that do not need it (it shows as optional there).
    pub optional_for: &'static [&'static str],
    /// Only for these review types (empty: all).
    pub only_for: &'static [&'static str],
}

const ADMIN: &str = "Administrative information";
const INTRO: &str = "Introduction";
const METHODS: &str = "Methods";

pub const FIELDS: &[FieldDef] = &[
    FieldDef { id: "title", item: "1a", section: ADMIN, label: "Title", guidance: "Say that this is the protocol of a systematic (or scoping, rapid, living) review.", kind: "text", optional_for: &[], only_for: &[] },
    FieldDef { id: "update", item: "1b", section: ADMIN, label: "Update of an earlier review", guidance: "If this updates a review, name and cite it. Leave empty if it does not.", kind: "text", optional_for: &["systematic", "scoping", "rapid", "living"], only_for: &[] },
    FieldDef { id: "registration", item: "2", section: ADMIN, label: "Registration", guidance: "The registry and number once registered (PROSPERO, OSF, INPLASY). Recorded with Register below.", kind: "registration", optional_for: &[], only_for: &[] },
    FieldDef { id: "authors", item: "3a–3b", section: ADMIN, label: "Authors and contributions", guidance: "Everyone on the protocol with affiliation and e-mail, what each contributes, the guarantor (who takes responsibility for the review) and the contact.", kind: "authors", optional_for: &[], only_for: &[] },
    FieldDef { id: "amendments", item: "4", section: ADMIN, label: "Amendments", guidance: "Key lists every change made after registration, with its date and reason.", kind: "amendments", optional_for: &[], only_for: &[] },
    FieldDef { id: "funding", item: "5a", section: ADMIN, label: "Funding and other support", guidance: "Grants, institutions, in-kind support. Write “None” when there is none.", kind: "long", optional_for: &[], only_for: &[] },
    FieldDef { id: "sponsor", item: "5b", section: ADMIN, label: "Sponsor", guidance: "The funder's or sponsor's name, if there is one.", kind: "text", optional_for: &["systematic", "scoping", "rapid", "living"], only_for: &[] },
    FieldDef { id: "funderRole", item: "5c", section: ADMIN, label: "Role of funders", guidance: "Whether funders or sponsor have a say in the protocol, the analysis or the report.", kind: "long", optional_for: &["systematic", "scoping", "rapid", "living"], only_for: &[] },
    FieldDef { id: "conflicts", item: "", section: ADMIN, label: "Competing interests", guidance: "Any financial or personal interest of an author in the topic. Write “None declared” when there are none.", kind: "long", optional_for: &[], only_for: &[] },
    FieldDef { id: "startDate", item: "", section: ADMIN, label: "Start date", guidance: "When work on the review began.", kind: "date", optional_for: &[], only_for: &[] },
    FieldDef { id: "endDate", item: "", section: ADMIN, label: "Expected completion", guidance: "When you expect to finish.", kind: "date", optional_for: &[], only_for: &[] },
    FieldDef { id: "rationale", item: "6", section: INTRO, label: "Rationale", guidance: "What is known, what is not, and why this review is needed now. Mention existing reviews on the question.", kind: "long", optional_for: &[], only_for: &[] },
    FieldDef { id: "objectives", item: "7", section: INTRO, label: "Objectives", guidance: "The question(s) the review answers, by its parts (population, intervention or exposure, comparator, outcomes).", kind: "long", optional_for: &[], only_for: &[] },
    FieldDef { id: "condition", item: "", section: INTRO, label: "Condition or domain", guidance: "The health condition or topic area (registries index reviews by it).", kind: "text", optional_for: &[], only_for: &[] },
    FieldDef { id: "keywords", item: "", section: INTRO, label: "Keywords", guidance: "A few words people would search the registry with, separated by commas.", kind: "text", optional_for: &["systematic", "scoping", "rapid", "living"], only_for: &[] },
    FieldDef { id: "country", item: "", section: INTRO, label: "Country", guidance: "Where the review team is based.", kind: "text", optional_for: &["systematic", "scoping", "rapid", "living"], only_for: &[] },
    FieldDef { id: "eligibility", item: "8", section: METHODS, label: "Eligibility criteria", guidance: "Key writes this from Setup › Criteria. Add study and report characteristics the criteria do not say (years, languages, settings).", kind: "long", optional_for: &[], only_for: &[] },
    FieldDef { id: "sources", item: "9", section: METHODS, label: "Information sources", guidance: "The databases, registers and other sources you will search (with platform and dates of coverage), and other methods: reference lists, citation searching, contacting authors.", kind: "long", optional_for: &[], only_for: &[] },
    FieldDef { id: "searchStrategy", item: "10", section: METHODS, label: "Search strategy", guidance: "A draft strategy for at least one database, with its limits, so it can be repeated.", kind: "long", optional_for: &[], only_for: &[] },
    FieldDef { id: "limits", item: "", section: METHODS, label: "Language and date restrictions", guidance: "Any limit on language, publication date or type, with the reason. Write “None” when there are none.", kind: "text", optional_for: &[], only_for: &[] },
    FieldDef { id: "unpublished", item: "", section: METHODS, label: "Unpublished studies", guidance: "Whether and how you look for unpublished work: trial registers, theses, conference abstracts, contacting authors.", kind: "long", optional_for: &["systematic", "scoping", "rapid", "living"], only_for: &[] },
    FieldDef { id: "dataManagement", item: "11a", section: METHODS, label: "Data management", guidance: "How records and data are kept through the review. Key describes its own part.", kind: "long", optional_for: &[], only_for: &[] },
    FieldDef { id: "selection", item: "11b", section: METHODS, label: "Selection process", guidance: "Who screens, how many per record, independently or not, at which stages, and how disagreements are settled. Key writes this from Setup › Team & rules.", kind: "long", optional_for: &[], only_for: &[] },
    FieldDef { id: "dataCollection", item: "11c", section: METHODS, label: "Data collection process", guidance: "How data are taken from reports (piloted forms, one or two people, how disagreements are settled, contacting authors for missing data).", kind: "long", optional_for: &[], only_for: &[] },
    FieldDef { id: "dataItems", item: "12", section: METHODS, label: "Data items", guidance: "What you collect from each study. Key lists the extraction forms' questions.", kind: "long", optional_for: &[], only_for: &[] },
    FieldDef { id: "outcomes", item: "13", section: METHODS, label: "Outcomes and prioritisation", guidance: "Each outcome with its time point and measure, primary or secondary, and how one result is chosen when a study reports several.", kind: "outcomes", optional_for: &[], only_for: &[] },
    FieldDef { id: "rob", item: "14", section: METHODS, label: "Risk of bias in individual studies", guidance: "The tool(s), at study or outcome level, by how many people, and how it will be used in the synthesis.", kind: "long", optional_for: &["scoping"], only_for: &[] },
    FieldDef { id: "synthesis", item: "15a–15b", section: METHODS, label: "Data synthesis", guidance: "When studies will be combined, the effect measures, the model and how heterogeneity is assessed.", kind: "long", optional_for: &[], only_for: &[] },
    FieldDef { id: "analyses", item: "15c", section: METHODS, label: "Planned subgroup and sensitivity analyses", guidance: "Name them now: analyses chosen after seeing the data are reported as such.", kind: "analyses", optional_for: &["scoping"], only_for: &[] },
    FieldDef { id: "synthesisAlternative", item: "15d", section: METHODS, label: "If pooling is not appropriate", guidance: "How results are summarised without a meta-analysis (for example SWiM: grouping, a standard metric, effect direction).", kind: "long", optional_for: &["scoping"], only_for: &[] },
    FieldDef { id: "metaBias", item: "16", section: METHODS, label: "Meta-bias(es)", guidance: "How publication bias and selective reporting will be assessed (funnel plots, small-study tests, comparing with registrations).", kind: "long", optional_for: &["scoping"], only_for: &[] },
    FieldDef { id: "certainty", item: "17", section: METHODS, label: "Confidence in cumulative evidence", guidance: "How the certainty of the body of evidence will be judged (for example GRADE).", kind: "long", optional_for: &["scoping"], only_for: &[] },
    FieldDef { id: "livingFrequency", item: "", section: METHODS, label: "Living mode", guidance: "How often searches are rerun, what triggers an update of the review, and when it stops being living.", kind: "long", optional_for: &[], only_for: &["living"] },
    FieldDef { id: "dissemination", item: "", section: METHODS, label: "Dissemination plans", guidance: "Where the results will be published and shared.", kind: "long", optional_for: &["systematic", "scoping", "rapid", "living"], only_for: &[] },
    FieldDef { id: "protocolUrl", item: "", section: METHODS, label: "Where the protocol can be read", guidance: "A link to the full protocol (registry record, OSF, a journal).", kind: "text", optional_for: &["systematic", "scoping", "rapid", "living"], only_for: &[] },
];

pub fn field(id: &str) -> Option<&'static FieldDef> {
    FIELDS.iter().find(|f| f.id == id)
}

fn applies(f: &FieldDef, t: &str) -> bool {
    f.only_for.is_empty() || f.only_for.contains(&t)
}

fn element_label(id: &str) -> &'static str {
    ELEMENTS.iter().find(|(e, _)| *e == id).map(|(_, l)| *l).unwrap_or("Other")
}

/// The question in parts, as the frameworks name them.
fn question_parts(q: &Question) -> Vec<(String, String)> {
    let names: &[(&str, &str)] = match q.framework.as_str() {
        "peco" => &[("p", "population"), ("e", "exposure"), ("c", "comparator"), ("o", "outcomes")],
        "spider" => &[("s", "sample"), ("pi", "phenomenon of interest"), ("d", "design"), ("e", "evaluation"), ("r", "research type")],
        "free" => &[],
        _ => &[("p", "population"), ("i", "intervention"), ("c", "comparator"), ("o", "outcomes")],
    };
    names.iter().filter_map(|(k, n)| q.parts.get(*k).map(|v| v.trim()).filter(|v| !v.is_empty()).map(|v| (n.to_string(), v.to_string()))).collect()
}

fn stage_words(c: &Criterion) -> &'static str {
    match (c.applies(Stage::Ta), c.applies(Stage::Ft)) {
        (true, true) => "",
        (true, false) => " (title and abstract only)",
        _ => " (full text only)",
    }
}

/// The criteria, by part of the question.
pub fn criteria_text(p: &Protocol) -> String {
    let mut out = Vec::new();
    for el in elements_of(&p.question.framework).iter().copied().chain(ELEMENTS.iter().map(|(e, _)| *e)) {
        let items: Vec<String> = p.criteria.iter().filter(|c| c.element == el).map(|c| format!("{}{}", c.label.trim(), stage_words(c))).collect();
        if items.is_empty() || out.iter().any(|(e, _): &(&str, String)| *e == el) {
            continue;
        }
        out.push((el, format!("{}: {}.", element_label(el), items.join("; "))));
    }
    out.into_iter().map(|(_, t)| t).collect::<Vec<_>>().join("\n")
}

fn reviewers_phrase(n: u32) -> String {
    if n <= 1 { "one reviewer".into() } else { format!("{} reviewers independently", count_word(n as usize)) }
}

/// How records are selected, from the rules (also the PRISMA 2020 item 8 sentence).
pub fn selection_text(state: &State) -> String {
    let r = &state.protocol.rules;
    let mut s = format!("Titles and abstracts are screened by {}", reviewers_phrase(r.ta.reviewers));
    s.push_str(&format!(", and full texts by {}", reviewers_phrase(r.ft.reviewers)));
    if r.blind && (r.ta.reviewers > 1 || r.ft.reviewers > 1) {
        s.push_str(", each blind to the others' decisions until all have decided");
    }
    s.push('.');
    if r.ta.reviewers > 1 || r.ft.reviewers > 1 {
        s.push_str(if r.conflicts == "third" { " Disagreements are resolved by a third reviewer." } else { " Disagreements are resolved by discussion until consensus." });
    }
    if r.ft.asks(Choice::Exclude) != "none" {
        s.push_str(" Each report excluded at full text is given the eligibility criterion it does not meet.");
    }
    if !state.pilots.is_empty() {
        let p = &state.pilots[0];
        s.push_str(&format!(" The team first screens a pilot sample of {} together to calibrate the criteria.", plural(p.records.len(), "record", "records")));
    }
    if state.protocol.criteria.iter().any(|c| c.link.as_ref().is_some_and(|l| l.effect == "auto")) {
        s.push_str(" Records that fail a criterion read from their metadata (such as publication year) are excluded automatically, labelled as such and counted separately.");
    }
    s.push_str(&format!(" Screening is done in {}.", software()));
    s
}

pub fn data_collection_text(state: &State) -> String {
    let r = &state.protocol.rules;
    let mut s = if r.extractors >= 2 { "Two reviewers extract data from each included study independently, using piloted forms; differences are compared and agreed values recorded.".to_string() } else { "One reviewer extracts data from each included study using a piloted form.".to_string() };
    if r.quote_required {
        s.push_str(" Each value is backed by a quote from the report.");
    } else if r.source_default != "none" {
        s.push_str(" Each value keeps its place in the report (page and passage).");
    }
    s
}

fn forms_of<'a>(p: &'a Protocol, rob: bool) -> impl Iterator<Item = &'a Form> {
    p.forms.iter().filter(move |f| (f.kind == "rob") == rob)
}

pub fn data_items_text(p: &Protocol) -> String {
    forms_of(p, false)
        .map(|f| {
            let labels: Vec<String> = f.fields().map(|x| if x.kind == "table" { format!("{} ({})", x.label, x.columns.iter().map(|c| c.label.clone()).collect::<Vec<_>>().join(", ")) } else { x.label.clone() }).collect();
            format!("{}: {}.", f.name, labels.join("; "))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn rob_text(p: &Protocol) -> String {
    let names: Vec<String> = forms_of(p, true).map(|f| f.name.clone()).collect();
    if names.is_empty() {
        return String::new();
    }
    let who = if p.rules.extractors >= 2 { "two reviewers independently, agreeing differences by discussion" } else { "one reviewer" };
    format!("Risk of bias is assessed with {} by {who}; each judgement is supported by a quote from the report.", join_and(&names))
}

fn searches_text(state: &State) -> String {
    let mut lines = Vec::new();
    for s in &state.searches {
        let name = s.get("name").and_then(Json::as_str).unwrap_or("Database search");
        let dbs: Vec<String> = s.get("connectors").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect()).unwrap_or_default();
        if !dbs.is_empty() {
            lines.push(format!("{name}: {}", dbs.join(", ")));
        }
    }
    lines.join("\n")
}

fn sources_text(state: &State) -> String {
    let mut dbs: Vec<String> = Vec::new();
    let mut others: Vec<String> = Vec::new();
    for b in state.batches.iter().filter(|b| !state.removed_batches.contains(&b.id)) {
        let names: Vec<String> = if b.per_source.is_empty() { vec![crate::prisma::batch_name(b)] } else { b.per_source.keys().cloned().collect() };
        for n in names {
            let list = if b.group == "other" { &mut others } else { &mut dbs };
            if !list.contains(&n) && n != crate::prisma::UNNAMED {
                list.push(n);
            }
        }
    }
    let mut out = String::new();
    if !dbs.is_empty() {
        out.push_str(&format!("Databases and registers: {}.", dbs.join(", ")));
    } else {
        let planned = searches_text(state);
        if !planned.is_empty() {
            out.push_str(&format!("Planned database searches: {planned}."));
        }
    }
    if !others.is_empty() {
        out.push_str(&format!("{}Other methods: {}.", if out.is_empty() { "" } else { " " }, others.join(", ")));
    }
    out
}

fn strategy_text(state: &State) -> String {
    state.batches.iter().filter(|b| !state.removed_batches.contains(&b.id) && !b.strategy.trim().is_empty() && b.group != "other").map(|b| b.strategy.trim().to_string()).next().unwrap_or_default()
}

fn synthesis_text(state: &State) -> String {
    let mut out = Vec::new();
    for a in &state.analyses {
        let o = a.get("options").cloned().unwrap_or(Json::Null);
        let measure = o.get("measure").and_then(Json::as_str).map(measure_name).unwrap_or_default();
        let method = o.get("method").and_then(Json::as_str).map(method_name).unwrap_or_default();
        if !measure.is_empty() {
            let hk = if o.get("hartungKnapp").and_then(Json::as_bool).unwrap_or(false) { " with the Hartung–Knapp adjustment" } else { "" };
            out.push(format!("{} pooled with {method}{hk}", measure));
        }
    }
    out.dedup();
    if out.is_empty() {
        return String::new();
    }
    format!("{}. Heterogeneity is assessed with Cochran's Q, I², τ² and a prediction interval. Analyses are run in {}.", capital(&join_and(&out)), software())
}

pub fn measure_name(m: &str) -> String {
    match m {
        "RR" => "risk ratios",
        "OR" => "odds ratios",
        "RD" => "risk differences",
        "MD" => "mean differences",
        "SMD" => "standardised mean differences (Hedges' g)",
        "GEN" => "effect estimates with their standard errors (generic inverse variance)",
        other => other,
    }
    .to_string()
}

pub fn method_name(m: &str) -> String {
    match m {
        "fe" => "a common-effect (inverse-variance) model",
        "dl" => "a random-effects model (DerSimonian–Laird)",
        _ => "a random-effects model (restricted maximum likelihood)",
    }
    .to_string()
}

fn objectives_text(p: &Protocol) -> String {
    let q = &p.question;
    let parts = question_parts(q);
    let mut s = q.text.trim().to_string();
    if !parts.is_empty() {
        let list: Vec<String> = parts.iter().map(|(n, v)| format!("{n}: {v}")).collect();
        if !s.is_empty() {
            s.push_str(if s.ends_with('?') || s.ends_with('.') { " " } else { ". " });
        }
        s.push_str(&format!("{} ({}).", if q.framework == "spider" { "The question by its SPIDER parts" } else { "The question by its parts" }, list.join("; ")));
    }
    s
}

fn title_text(state: &State) -> String {
    let t = state.protocol.plan.review_type();
    let kind = match t {
        "scoping" => "a scoping review",
        "rapid" => "a rapid review",
        "living" => "a living systematic review",
        _ => "a systematic review",
    };
    let name = state.info.name.trim();
    if name.to_lowercase().contains("review") { format!("{name}: protocol") } else { format!("{name}: protocol for {kind}") }
}

/// What Key would write in a field from the review's own data.
pub fn suggestion(state: &State, id: &str) -> String {
    let p = &state.protocol;
    match id {
        "title" => title_text(state),
        "objectives" => objectives_text(p),
        "eligibility" => criteria_text(p),
        "sources" => sources_text(state),
        "searchStrategy" => strategy_text(state),
        "dataManagement" => format!("Records are de-duplicated, screened and extracted in {}, which keeps every import, decision and extracted value as a dated, attributed entry in an append-only log; the log, the protocol versions and the extracted data can be exported.", software()),
        "selection" => selection_text(state),
        "dataCollection" => data_collection_text(state),
        "dataItems" => data_items_text(p),
        "rob" => rob_text(p),
        "synthesis" => synthesis_text(state),
        "startDate" => if state.info.created_at > 0 { date(state.info.created_at) } else { String::new() },
        "outcomes" => p.question.parts.get("o").map(|o| o.trim().to_string()).unwrap_or_default(),
        _ => String::new(),
    }
}

fn outcomes_text(plan: &Plan) -> String {
    let mut lines = Vec::new();
    for (prio, head) in [("primary", "Primary outcomes"), ("secondary", "Secondary outcomes")] {
        let items: Vec<String> = plan
            .outcomes
            .iter()
            .filter(|o| if prio == "primary" { o.priority == "primary" } else { o.priority != "primary" })
            .filter(|o| !o.name.trim().is_empty())
            .map(|o| {
                let extra: Vec<&str> = [o.measure.trim(), o.timepoint.trim()].into_iter().filter(|x| !x.is_empty()).collect();
                if extra.is_empty() { o.name.trim().to_string() } else { format!("{} ({})", o.name.trim(), extra.join(", ")) }
            })
            .collect();
        if !items.is_empty() {
            lines.push(format!("{head}: {}.", items.join("; ")));
        }
    }
    lines.join("\n")
}

fn analyses_text(plan: &Plan) -> String {
    let mut out = Vec::new();
    let clean = |v: &[String]| v.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>();
    let (sg, se) = (clean(&plan.subgroups), clean(&plan.sensitivity));
    if !sg.is_empty() {
        out.push(format!("Subgroup analyses: {}.", sg.join("; ")));
    }
    if !se.is_empty() {
        out.push(format!("Sensitivity analyses: {}.", se.join("; ")));
    }
    out.join("\n")
}

fn authors_text(plan: &Plan) -> String {
    plan.authors
        .iter()
        .filter(|a| !a.name.trim().is_empty())
        .map(|a| {
            let mut s = a.name.trim().to_string();
            if !a.affiliation.trim().is_empty() {
                s.push_str(&format!(", {}", a.affiliation.trim()));
            }
            if !a.email.trim().is_empty() {
                s.push_str(&format!(" ({})", a.email.trim()));
            }
            let mut roles = Vec::new();
            if a.guarantor {
                roles.push("guarantor".to_string());
            }
            if a.contact {
                roles.push("contact".to_string());
            }
            if !a.contribution.trim().is_empty() {
                roles.push(a.contribution.trim().to_string());
            }
            if !roles.is_empty() {
                s.push_str(&format!(": {}", roles.join("; ")));
            }
            s
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The registration as a sentence.
pub fn registration_text(state: &State) -> String {
    match &state.reporting.registration {
        Some(r) => {
            let mut s = format!("Registered with {} on {}", if r.registry.trim().is_empty() { "a registry" } else { r.registry.trim() }, if r.date.trim().is_empty() { date(r.at) } else { r.date.trim().to_string() });
            if !r.id.trim().is_empty() {
                s.push_str(&format!(" ({})", r.id.trim()));
            }
            if !r.url.trim().is_empty() {
                s.push_str(&format!(", {}", r.url.trim()));
            }
            s.push('.');
            s
        }
        None if !state.protocol.registration.trim().is_empty() => format!("Registration: {}.", state.protocol.registration.trim()),
        None => String::new(),
    }
}

/// A field's value as the document shows it: the text written, else what Key knows.
pub fn effective(state: &State, id: &str) -> (String, bool) {
    let plan = &state.protocol.plan;
    match id {
        "authors" => (authors_text(plan), false),
        "registration" => (registration_text(state), false),
        "amendments" => (amendments_text(state), false),
        "analyses" => (analyses_text(plan), false),
        "outcomes" => {
            let listed = outcomes_text(plan);
            let notes = plan.get("outcomes");
            let text = [listed.as_str(), notes].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
            if text.is_empty() { (suggestion(state, id), true) } else { (text, false) }
        }
        _ => {
            let written = plan.get(id);
            if written.is_empty() { (suggestion(state, id), true) } else { (written.to_string(), false) }
        }
    }
}

// ── Registration and deviations ─────────────────────────────────────────────────────

/// Whether the protocol is registered (changes are amendments with a reason).
pub fn locked(state: &State) -> bool {
    state.reporting.registration.is_some()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deviation {
    pub version: usize,
    pub at: i64,
    pub actor: String,
    pub reason: String,
    pub changes: Vec<String>,
}

/// What changed between two protocols that the protocol document says, in words.
pub fn relevant_changes(old: &Protocol, new: &Protocol) -> Vec<String> {
    let mut out = Vec::new();
    let q = |p: &Protocol| (p.question.framework.clone(), p.question.text.trim().to_string());
    if q(old) != q(new) {
        out.push("Review question reworded".to_string());
    }
    for (k, label) in question_parts(&new.question).into_iter().map(|(n, _)| n).chain(question_parts(&old.question).into_iter().map(|(n, _)| n)).collect::<std::collections::BTreeSet<_>>().into_iter().map(|n| (n.clone(), n)) {
        let get = |p: &Protocol| question_parts(&p.question).into_iter().find(|(n, _)| *n == k).map(|(_, v)| v).unwrap_or_default();
        if get(old) != get(new) {
            out.push(format!("Question: {label} changed"));
        }
    }
    for c in &new.criteria {
        match old.criterion(&c.id) {
            None => out.push(format!("Criterion added: “{}”", c.label.trim())),
            Some(o) if o.label.trim() != c.label.trim() => out.push(format!("Criterion reworded: “{}” → “{}”", o.label.trim(), c.label.trim())),
            Some(o) if o.stages != c.stages => out.push(format!("Criterion “{}”: stages changed", c.label.trim())),
            Some(o) if o.link != c.link => out.push(format!("Criterion “{}”: metadata rule changed", c.label.trim())),
            Some(o) if o.element != c.element || o.reason != c.reason => out.push(format!("Criterion “{}”: part of the question or reason changed", c.label.trim())),
            _ => {}
        }
    }
    for o in &old.criteria {
        if new.criterion(&o.id).is_none() {
            out.push(format!("Criterion removed: “{}”", o.label.trim()));
        }
    }
    let ids = |p: &Protocol| p.criteria.iter().filter(|c| old.criterion(&c.id).is_some() && new.criterion(&c.id).is_some()).map(|c| c.id.clone()).collect::<Vec<_>>();
    if ids(old) != ids(new) {
        out.push("Order of the criteria (the reason hierarchy) changed".to_string());
    }
    let (a, b) = (&old.rules, &new.rules);
    for (stage, x, y) in [("Title and abstract", &a.ta, &b.ta), ("Full text", &a.ft, &b.ft)] {
        if x.reviewers != y.reviewers {
            out.push(format!("{stage}: reviewers per record {} → {}", x.reviewers, y.reviewers));
        }
        if x.asks(Choice::Exclude) != y.asks(Choice::Exclude) {
            out.push(format!("{stage}: criteria named when excluding changed"));
        }
    }
    if a.blind != b.blind {
        out.push(format!("Blind screening {}", if b.blind { "turned on" } else { "turned off" }));
    }
    if a.conflicts != b.conflicts {
        out.push(format!("Conflicts resolved by {}", if b.conflicts == "third" { "a third reviewer" } else { "consensus" }));
    }
    if a.extractors != b.extractors {
        out.push(format!("Extractors per study {} → {}", a.extractors, b.extractors));
    }
    if a.quote_required != b.quote_required {
        out.push(format!("Quotes for extracted values {}", if b.quote_required { "required" } else { "no longer required" }));
    }
    for f in &new.forms {
        match old.forms.iter().find(|o| o.id == f.id) {
            None => out.push(format!("Form added: {}", f.name)),
            Some(o) if o != f => out.push(format!("Form changed: {}", f.name)),
            _ => {}
        }
    }
    for o in &old.forms {
        if !new.forms.iter().any(|f| f.id == o.id) {
            out.push(format!("Form removed: {}", o.name));
        }
    }
    let (pa, pb) = (&old.plan, &new.plan);
    if pa.review_type() != pb.review_type() {
        out.push(format!("Review type: {} → {}", type_label(pa.review_type()), type_label(pb.review_type())));
    }
    for f in FIELDS {
        if pa.get(f.id) != pb.get(f.id) {
            out.push(format!("{} changed", f.label));
        }
    }
    if pa.outcomes != pb.outcomes {
        let names = |p: &Plan| p.outcomes.iter().map(|o| o.name.trim().to_string()).collect::<Vec<_>>();
        let (na, nb) = (names(pa), names(pb));
        let added: Vec<String> = nb.iter().filter(|n| !na.contains(n)).cloned().collect();
        let removed: Vec<String> = na.iter().filter(|n| !nb.contains(n)).cloned().collect();
        for n in &added {
            out.push(format!("Outcome added: {n}"));
        }
        for n in &removed {
            out.push(format!("Outcome removed: {n}"));
        }
        if added.is_empty() && removed.is_empty() {
            out.push("Outcomes: priority, measure or time point changed".to_string());
        }
    }
    for (label, x, y) in [("Subgroup analysis", &pa.subgroups, &pb.subgroups), ("Sensitivity analysis", &pa.sensitivity, &pb.sensitivity)] {
        for n in y.iter().filter(|n| !x.contains(n)) {
            out.push(format!("{label} added: {n}"));
        }
        for n in x.iter().filter(|n| !y.contains(n)) {
            out.push(format!("{label} removed: {n}"));
        }
    }
    if pa.authors != pb.authors {
        out.push("Authors or contributions changed".to_string());
    }
    out
}

/// Every protocol version made after registration, with what changed and why.
pub fn deviations(state: &State) -> Vec<Deviation> {
    let Some(reg) = &state.reporting.registration else { return Vec::new() };
    let Some(start) = state.versions.iter().position(|v| v.id == reg.version).or_else(|| state.versions.iter().rposition(|v| v.at <= reg.at)) else { return Vec::new() };
    state.versions.windows(2).skip(start).map(|w| Deviation { version: w[1].number, at: w[1].at, actor: state.member_name(&w[1].actor), reason: w[1].note.clone(), changes: relevant_changes(&w[0].protocol, &w[1].protocol) }).collect()
}

pub fn amendments_text(state: &State) -> String {
    if !locked(state) {
        return String::new();
    }
    let d = deviations(state);
    if d.is_empty() {
        return "No changes since registration.".into();
    }
    d.iter().map(|x| format!("{} (version {}): {}. Reason: {}", date(x.at), x.version, if x.changes.is_empty() { "settings changed".to_string() } else { x.changes.join("; ") }, x.reason.trim())).collect::<Vec<_>>().join("\n")
}

pub fn deviations_csv(state: &State) -> String {
    let mut out = crate::report_text::csv_line(&["Date", "Version", "By", "Change", "Reason"].map(String::from));
    for d in deviations(state) {
        let changes = if d.changes.is_empty() { vec!["Settings changed".to_string()] } else { d.changes.clone() };
        for c in changes {
            out.push_str(&crate::report_text::csv_line(&[date(d.at), d.version.to_string(), d.actor.clone(), c, d.reason.clone()]));
        }
    }
    out
}

pub fn deviations_markdown(state: &State) -> String {
    let mut out = format!("# Deviations from the protocol\n\n{}\n\n", registration_text(state));
    let d = deviations(state);
    if d.is_empty() {
        out.push_str(if locked(state) { "No changes were made after registration.\n" } else { "The protocol is not registered yet.\n" });
        return out;
    }
    out.push_str("| Date | Version | Change | Reason |\n| --- | --- | --- | --- |\n");
    for x in d {
        out.push_str(&format!("| {} | {} | {} | {} |\n", date(x.at), x.version, md_cell(&if x.changes.is_empty() { "Settings changed".into() } else { x.changes.join("; ") }), md_cell(x.reason.trim())));
    }
    out
}

// ── The review's stage (PROSPERO) and conduct before registration ─────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageTask {
    pub task: &'static str,
    pub started: bool,
    pub completed: bool,
}

/// Where the review stands, read from its log (PROSPERO asks at each submission).
pub fn stage_of_review(state: &State) -> Vec<StageTask> {
    let prisma = crate::prisma::compute(state);
    let decided = |stage: Stage| state.records.iter().any(|r| state.pilot_of(&r.id, stage).is_none() && (!r.decisions[stage.index()].is_empty() || r.resolutions[stage.index()].iter().any(|d| d.auto.is_none())));
    let included = state.included();
    let values = |rob: bool| {
        included.iter().filter(|r| state.extraction.get(&r.id).is_some_and(|e| e.values.iter().any(|((f, _), v)| v.keys().any(|k| k != "ai") && state.protocol.forms.iter().any(|x| x.id == *f && (x.kind == "rob") == rob)))).count()
    };
    let completed = |rob: bool| {
        let forms: Vec<&Form> = forms_of(&state.protocol, rob).collect();
        !included.is_empty() && !forms.is_empty() && included.iter().all(|r| state.extraction.get(&r.id).is_some_and(|e| forms.iter().all(|f| e.completed.get(&f.id).is_some_and(|w| !w.is_empty()))))
    };
    let searched = state.batches.iter().any(|b| !state.removed_batches.contains(&b.id));
    vec![
        StageTask { task: "Preliminary searches", started: searched || !state.searches.is_empty(), completed: searched },
        StageTask { task: "Piloting of the study selection process", started: !state.pilots.is_empty(), completed: state.pilots.iter().any(|p| !p.open) },
        StageTask { task: "Formal screening of search results against eligibility criteria", started: decided(Stage::Ta), completed: searched && decided(Stage::Ta) && prisma.complete },
        StageTask { task: "Data extraction", started: values(false) > 0, completed: completed(false) },
        StageTask { task: "Risk of bias (quality) assessment", started: values(true) > 0, completed: completed(true) },
        StageTask { task: "Data analysis", started: !state.analyses.is_empty(), completed: false },
    ]
}

pub fn stage_text(state: &State) -> String {
    stage_of_review(state).iter().map(|t| format!("{}: {}", t.task, if t.completed { "completed" } else if t.started { "started" } else { "not started" })).collect::<Vec<_>>().join("\n")
}

/// The first screening decision by a person (not a pilot's rule), for "protocol before conduct".
pub fn first_decision_at(state: &State) -> Option<i64> {
    state.records.iter().flat_map(|r| r.decisions.iter().flatten().chain(r.resolutions.iter().flatten())).filter(|d| d.auto.is_none()).map(|d| d.at).min()
}

/// Registered before the first screening decision (AMSTAR 2 item 2's evidence).
pub fn registered_before_conduct(state: &State) -> Option<bool> {
    let reg = state.reporting.registration.as_ref()?;
    let at = crate::report_text::parse_date(&reg.date).unwrap_or(reg.at);
    Some(first_decision_at(state).is_none_or(|first| at <= first))
}

// ── The document ────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldState {
    #[serde(flatten)]
    pub def: FieldDef,
    pub value: String,
    pub suggestion: String,
    pub effective: String,
    /// The text shown is what Key filled in (not written by a person).
    pub from_key: bool,
    pub required: bool,
    pub done: bool,
}

pub fn view(state: &State) -> Json {
    let plan = &state.protocol.plan;
    let t = plan.review_type();
    let fields: Vec<FieldState> = FIELDS
        .iter()
        .filter(|f| applies(f, t))
        .map(|f| {
            let (effective, from_key) = effective(state, f.id);
            let required = !f.optional_for.contains(&t) && !matches!(f.kind, "amendments");
            let done = match f.kind {
                "registration" => locked(state) || !state.protocol.registration.trim().is_empty(),
                "authors" => plan.authors.iter().any(|a| !a.name.trim().is_empty()) && plan.authors.iter().any(|a| a.guarantor),
                _ => !effective.trim().is_empty(),
            };
            FieldState { def: f.clone(), value: plan.get(f.id).to_string(), suggestion: suggestion(state, f.id), effective, from_key, required, done }
        })
        .collect();
    let required = fields.iter().filter(|f| f.required).count();
    let done = fields.iter().filter(|f| f.required && f.done).count();
    let missing: Vec<&str> = fields.iter().filter(|f| f.required && !f.done).map(|f| f.def.label).collect();
    json!({
        "reviewType": t,
        "reviewTypes": REVIEW_TYPES.iter().map(|(id, label)| json!({ "id": id, "label": label })).collect::<Vec<_>>(),
        "fields": fields,
        "completeness": { "done": done, "required": required, "missing": missing },
        "registration": state.reporting.registration,
        "locked": locked(state),
        "deviations": deviations(state),
        "stage": stage_of_review(state),
        "registeredBeforeConduct": registered_before_conduct(state),
        "team": state.team.iter().map(|m| json!({ "name": m.name, "roles": m.roles })).collect::<Vec<_>>(),
        "prospero": prospero(state),
    })
}

/// The PRISMA-P-structured protocol.
pub fn markdown(state: &State) -> String {
    let t = state.protocol.plan.review_type();
    let (title, _) = effective(state, "title");
    let mut out = format!("# {title}\n\n");
    out.push_str(&format!("{} protocol, structured by PRISMA-P 2015 items. Prepared with {} on {}.\n\n", type_label(t), software(), date(crate::events::now_ms())));
    let mut section = "";
    for f in FIELDS.iter().filter(|f| applies(f, t)) {
        if f.section != section {
            section = f.section;
            out.push_str(&format!("## {section}\n\n"));
        }
        let (text, _) = effective(state, f.id);
        let head = if f.item.is_empty() { f.label.to_string() } else { format!("{} (item {})", f.label, f.item) };
        out.push_str(&format!("### {head}\n\n"));
        if text.trim().is_empty() {
            out.push_str("Not stated.\n\n");
        } else {
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                out.push_str(line.trim());
                out.push_str("\n\n");
            }
        }
    }
    out.push_str("---\n\nStructure follows PRISMA-P 2015 (Moher D, et al. Syst Rev. 2015;4:1; Shamseer L, et al. BMJ. 2015;349:g7647), distributed under CC BY 4.0. Item wording is Key's own.\n");
    out
}

// ── PROSPERO copy sheet ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetField {
    pub section: &'static str,
    pub label: &'static str,
    pub value: String,
    /// Where it comes from in Key ("Setup › Criteria", "Protocol › Rationale").
    pub from: String,
}

fn criteria_of(p: &Protocol, elements: &[&str], part: &str) -> String {
    let items: Vec<String> = p.criteria.iter().filter(|c| elements.contains(&c.element.as_str())).map(|c| c.label.trim().to_string()).collect();
    let q = p.question.parts.get(part).map(|s| s.trim()).unwrap_or("");
    match (items.is_empty(), q.is_empty()) {
        (false, _) => items.join("; ") + ".",
        (true, false) => q.to_string(),
        _ => String::new(),
    }
}

/// PROSPERO's registration fields in the form's order, ready to paste (no API exists).
pub fn prospero(state: &State) -> Vec<SheetField> {
    let p = &state.protocol;
    let e = |id: &str| effective(state, id).0;
    let plan = &p.plan;
    let others: Vec<String> = state.batches.iter().filter(|b| !state.removed_batches.contains(&b.id) && b.group == "other").map(crate::prisma::batch_name).collect();
    let primary: Vec<String> = plan.outcomes.iter().filter(|o| o.priority == "primary" && !o.name.trim().is_empty()).map(|o| [o.name.trim(), o.measure.trim(), o.timepoint.trim()].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(", ")).collect();
    let secondary: Vec<String> = plan.outcomes.iter().filter(|o| o.priority != "primary" && !o.name.trim().is_empty()).map(|o| [o.name.trim(), o.measure.trim(), o.timepoint.trim()].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(", ")).collect();
    let contact = plan.authors.iter().find(|a| a.contact).or_else(|| plan.authors.first());
    let synthesis = [e("synthesis"), analyses_text(plan), plan.get("synthesisAlternative").to_string()].into_iter().filter(|s| !s.trim().is_empty()).collect::<Vec<_>>().join("\n");
    let f = |section, label, value: String, from: &str| SheetField { section, label, value, from: from.to_string() };
    vec![
        f("Title and basic details", "Review title", e("title"), "Protocol › Title"),
        f("Title and basic details", "Type of review", type_label(plan.review_type()).to_string(), "Protocol › Review type"),
        f("Title and basic details", "Condition or domain", e("condition"), "Protocol › Condition or domain"),
        f("Title and basic details", "Rationale", e("rationale"), "Protocol › Rationale"),
        f("Title and basic details", "Review objectives", e("objectives"), "Setup › Question"),
        f("Title and basic details", "Keywords", e("keywords"), "Protocol › Keywords"),
        f("Title and basic details", "Country", e("country"), "Protocol › Country"),
        f("Eligibility criteria", "Population", criteria_of(p, &["population", "sample"], if p.question.framework == "spider" { "s" } else { "p" }), "Setup › Criteria"),
        f("Eligibility criteria", "Intervention(s) or exposure(s)", criteria_of(p, &["intervention", "exposure", "phenomenon"], if p.question.framework == "peco" { "e" } else { "i" }), "Setup › Criteria"),
        f("Eligibility criteria", "Comparator(s) or control(s)", criteria_of(p, &["comparator"], "c"), "Setup › Criteria"),
        f("Eligibility criteria", "Study design", criteria_of(p, &["design", "research"], "d"), "Setup › Criteria"),
        f("Eligibility criteria", "Context and other criteria", criteria_of(p, &["other"], ""), "Setup › Criteria"),
        f("Timeline", "Review start date", e("startDate"), "Protocol › Start date"),
        f("Timeline", "Review expected end date", e("endDate"), "Protocol › Expected completion"),
        f("Availability of full protocol", "Where the full protocol is available", e("protocolUrl"), "Protocol › Where the protocol can be read"),
        f("Searching and screening", "Searching for unpublished studies", e("unpublished"), "Protocol › Unpublished studies"),
        f("Searching and screening", "Main bibliographic databases", e("sources"), "Sources and Protocol › Information sources"),
        f("Searching and screening", "Other sources and methods", if others.is_empty() { String::new() } else { format!("{}.", others.join(", ")) }, "Sources › Imports (other methods)"),
        f("Searching and screening", "Language and date restrictions", e("limits"), "Protocol › Language and date restrictions"),
        f("Searching and screening", "Search strategy", e("searchStrategy"), "Sources › Database searches"),
        f("Searching and screening", "Study selection process", e("selection"), "Setup › Team & rules"),
        f("Data collection", "Data extraction", [e("dataCollection"), e("dataItems")].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"), "Setup › Extraction forms"),
        f("Data collection", "Risk of bias (quality) assessment", e("rob"), "Setup › Extraction forms (risk of bias)"),
        f("Data collection", "Reporting bias assessment", e("metaBias"), "Protocol › Meta-bias(es)"),
        f("Data collection", "Certainty of evidence assessment", e("certainty"), "Protocol › Confidence in cumulative evidence"),
        f("Outcomes", "Main outcome(s)", primary.join("\n"), "Protocol › Outcomes"),
        f("Outcomes", "Additional outcome(s)", secondary.join("\n"), "Protocol › Outcomes"),
        f("Planned synthesis", "Strategy for data synthesis", synthesis, "Protocol › Data synthesis"),
        f("Current review stage", "Stage of the review at this submission", stage_text(state), "Key's log"),
        f("Review team and funding", "Review team members", authors_text(plan), "Protocol › Authors"),
        f("Review team and funding", "Named contact", contact.map(|a| [a.name.trim(), a.email.trim()].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(", ")).unwrap_or_default(), "Protocol › Authors"),
        f("Review team and funding", "Funding", e("funding"), "Protocol › Funding"),
        f("Additional information", "Conflicts of interest", e("conflicts"), "Protocol › Competing interests"),
        f("Additional information", "Dissemination plans", e("dissemination"), "Protocol › Dissemination plans"),
    ]
}

pub fn prospero_markdown(state: &State) -> String {
    let mut out = String::from("# PROSPERO registration: copy sheet\n\nEach field of PROSPERO's registration form with the text from this review, in the form's order. Paste each into the form; Key does not submit anything. PROSPERO's 2025 form could not be checked field by field without an account: check the labels against the form.\n\n");
    let mut section = "";
    for f in prospero(state) {
        if f.section != section {
            section = f.section;
            out.push_str(&format!("## {section}\n\n"));
        }
        out.push_str(&format!("### {}\n\n{}\n\n", f.label, if f.value.trim().is_empty() { "(not stated yet)".into() } else { f.value.trim().to_string() }));
    }
    out
}

/// An OSF-ready preregistration outline (for reviews PROSPERO does not take).
pub fn osf_markdown(state: &State) -> String {
    let p = &state.protocol;
    let e = |id: &str| effective(state, id).0;
    let or = |t: String| if t.trim().is_empty() { "Not stated.".to_string() } else { t };
    let mut out = format!("# {}\n\nPreregistration outline for OSF Registries, following the headings of OSF's generalised systematic review registration form (van den Akker et al., 2023). Check the current form on osf.io before pasting. Prepared with {}.\n\n", e("title"), software());
    let sections: Vec<(&str, String)> = vec![
        ("Metadata", format!("Type of review: {}.\n\nContributors:\n{}\n\nReview stage:\n{}\n\nStart date: {}. Expected end: {}.", type_label(p.plan.review_type()), or(authors_text(&p.plan)), stage_text(state), or(e("startDate")), or(e("endDate")))),
        ("Background", or(e("rationale"))),
        ("Research question(s)", or(e("objectives"))),
        ("Hypotheses or expectations", or(p.plan.get("hypotheses").to_string())),
        ("Inclusion and exclusion criteria", or(e("eligibility"))),
        ("Databases and other sources", or(e("sources"))),
        ("Search strategy and query strings", or(e("searchStrategy"))),
        ("Search limits", or(e("limits"))),
        ("Other search strategies (unpublished work, contacts)", or(e("unpublished"))),
        ("Screening process", or(e("selection"))),
        ("Data extraction", or([e("dataCollection"), e("dataItems")].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n"))),
        ("Outcomes", or(e("outcomes"))),
        ("Quality / risk of bias assessment", or(e("rob"))),
        ("Synthesis plan", or([e("synthesis"), analyses_text(&p.plan), p.plan.get("synthesisAlternative").to_string()].into_iter().filter(|s| !s.trim().is_empty()).collect::<Vec<_>>().join("\n\n"))),
        ("Publication bias", or(e("metaBias"))),
        ("Certainty of evidence", or(e("certainty"))),
        ("Data management and sharing", or(e("dataManagement"))),
        ("Funding and conflicts of interest", format!("Funding: {}\n\nConflicts of interest: {}", or(e("funding")), or(e("conflicts")))),
    ];
    for (head, body) in sections {
        out.push_str(&format!("## {head}\n\n{}\n\n", body.trim()));
    }
    out
}

/// Summary fields for the review's summary (Setup reads `locked`).
pub fn summary_json(state: &State) -> Json {
    json!({
        "locked": locked(state),
        "registration": state.reporting.registration,
        "reviewType": state.protocol.plan.review_type(),
        "deviations": deviations(state).len(),
    })
}

impl Reviews {
    pub fn protocol_doc(&self, review: &str) -> Result<Json> {
        self.read(review, |state, _| Ok(view(state)))
    }

    /// Records the protocol's registration (or corrects its details). The version in force is
    /// the registered one; every later change is an amendment that needs a reason.
    pub fn register_protocol(&self, review: &str, registration: &Registration, actor: &str) -> Result<()> {
        if registration.registry.trim().is_empty() {
            return Err("Choose the registry (PROSPERO, OSF, INPLASY …)".into());
        }
        if crate::report_text::parse_date(&registration.date).is_none() {
            return Err("Give the registration date as the registry shows it (YYYY-MM-DD)".into());
        }
        self.write(review, |state, _, b| {
            if state.member(actor).is_none() {
                return Err("Choose who you are: this person is not on the review's team".into());
            }
            Ok((vec![b.event("protocol.register", actor, None, json!({ "registry": registration.registry.trim(), "id": registration.id.trim(), "date": registration.date.trim(), "url": registration.url.trim() }))], ()))
        })
    }

    /// Takes back a registration recorded by mistake (the log keeps both).
    pub fn unregister_protocol(&self, review: &str, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            if state.reporting.registration.is_none() {
                return Err("The protocol is not registered".into());
            }
            if !deviations(state).is_empty() {
                return Err("Amendments were recorded after registration: correct the registration's details instead".into());
            }
            Ok((vec![b.event("protocol.register", actor, None, json!({ "deleted": true }))], ()))
        })
    }

}

/// One protocol document export: protocol | protocol-html | prospero-sheet | osf-prereg | deviations | deviations-md.
pub fn export(state: &State, kind: &str) -> Option<(String, String, &'static str)> {
    {
        let base = crate::export::slug(&state.info.name);
        Some(match kind {
            "protocol" => (format!("{base}-protocol.md"), markdown(state), "text/markdown"),
            "protocol-html" => (format!("{base}-protocol.html"), crate::report_text::html(&effective(state, "title").0, &markdown(state)), "text/html"),
            "prospero-sheet" => (format!("{base}-prospero-sheet.md"), prospero_markdown(state), "text/markdown"),
            "osf-prereg" => (format!("{base}-osf-preregistration.md"), osf_markdown(state), "text/markdown"),
            "deviations" => (format!("{base}-deviations.csv"), deviations_csv(state), "text/csv"),
            "deviations-md" => (format!("{base}-deviations.md"), deviations_markdown(state), "text/markdown"),
            _ => return None,
        })
    }
}
