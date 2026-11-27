// std-A: the PRISMA 2020 checklist (Page et al., BMJ 2021;372:n71; CC BY 4.0) and its abstracts
// checklist, filled from the review's own data. Each item gets a status (evidenced, partly,
// missing, not applicable, or not recorded yet when another part of Key will supply it), the
// rule that decided it, links to where the review shows it, the one action that would close a
// gap, and for items Key can write, a draft sentence in plain academic English built from the
// numbers. Item wording is Key's paraphrase; numbers, topics and order are PRISMA's. A scoping
// review gets PRISMA-ScR's items (Tricco et al., Ann Intern Med 2018), read by the same
// rules; a living review two PRISMA-LSR additions. Nothing here calls a model: the text is
// deterministic.
use crate::derive::State;
use crate::model::*;
use crate::protocol_doc as pd;
use crate::report_text::{capital, count_word, date, join_and, md_cell, plural, software, thousands};
use crate::reporting::ChecklistNote;
use crate::store::{Result, Reviews};
use serde::Serialize;
use serde_json::{Value as Json, json};

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub label: String,
    /// The review's stage (overview, setup, sources, ta, ft, extract, analysis, rob …).
    pub stage: String,
    /// A section or view inside it (setup: question, protocol, criteria …; sources: imports …;
    /// overview: flow, checklist, search).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
}

impl Link {
    pub fn to(label: &str, stage: &str, view: Option<&str>) -> Link {
        Link { label: label.into(), stage: stage.into(), view: view.map(Into::into) }
    }
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub text: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<Link>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// prisma2020 | abstract | scr | lsr | prismas
    pub list: String,
    pub id: String,
    pub section: String,
    pub topic: String,
    /// What the item asks, in Key's words.
    pub text: String,
    /// evidenced | partly | missing | na | notRecorded
    pub status: String,
    /// The rule that decided the status, in plain words.
    pub rule: String,
    pub evidence: Vec<Link>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap: Option<Gap>,
    /// A sentence or paragraph Key can write for it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<String>,
    /// Where the manuscript reports it, and notes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<ChecklistNote>,
    /// Written in the manuscript only (Key cannot evidence it).
    pub manuscript: bool,
}

pub fn item(list: &str, id: &str, section: &str, topic: &str, text: &str) -> Item {
    Item { list: list.into(), id: id.into(), section: section.into(), topic: topic.into(), text: text.into(), ..Default::default() }
}

pub fn done(mut i: Item, rule: &str, draft: Option<String>) -> Item {
    i.status = "evidenced".into();
    i.rule = rule.into();
    i.draft = draft.filter(|d| !d.trim().is_empty());
    i
}

pub fn gap(mut i: Item, status: &str, text: &str, action: &str, link: Link) -> Item {
    i.status = status.into();
    i.rule = text.into();
    i.gap = Some(Gap { text: text.into(), action: action.into(), link: Some(link) });
    i
}

pub fn status_label(s: &str) -> &'static str {
    match s {
        "evidenced" => "Evidenced",
        "partly" => "Partly",
        "missing" => "Missing",
        "na" => "Not applicable",
        _ => "Not recorded yet",
    }
}

pub fn attach_note(state: &State, i: &mut Item) {
    i.note = state.reporting.note(&i.list, &i.id).cloned();
}

// ── What the rules read ─────────────────────────────────────────────────────────────

struct Ctx<'a> {
    state: &'a State,
    prisma: crate::prisma::Prisma,
    facts: Json,
    search: crate::search_report::Report,
    kind: &'a str,
}

impl Ctx<'_> {
    fn fact(&self, path: &str) -> Option<&Json> {
        self.facts.pointer(path).filter(|v| !v.is_null())
    }
    fn fact_text(&self, path: &str) -> Option<String> {
        self.fact(path).and_then(Json::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    }
    fn plan(&self, id: &str) -> String {
        self.state.protocol.plan.get(id).to_string()
    }
    fn scoping(&self) -> bool {
        self.kind == "scoping"
    }
    fn forms(&self, rob: bool) -> Vec<&Form> {
        self.state.protocol.forms.iter().filter(|f| (f.kind == "rob") == rob).collect()
    }
}

fn setup(view: &str, label: &str) -> Link {
    Link::to(label, "setup", Some(view))
}
fn protocol(label: &str) -> Link {
    setup("protocol", &format!("Setup › Protocol › {label}"))
}

/// Agreement between two reviewers' decisions at a stage, over the records two people decided.
fn agreement(state: &State, stage: Stage) -> Option<crate::stats::Agreement> {
    let mut pairs = Vec::new();
    let mut multi = Vec::new();
    for r in &state.records {
        let current = r.current(stage);
        if current.len() < 2 || current.iter().any(|d| d.auto.is_some()) {
            continue;
        }
        let ratings: Vec<String> = current.iter().map(|d| format!("{:?}", d.value)).collect();
        if ratings.len() == 2 {
            pairs.push((ratings[0].clone(), ratings[1].clone()));
        }
        multi.push(ratings);
    }
    let a = if multi.iter().any(|m| m.len() > 2) {
        let m = multi.iter().map(Vec::len).min().unwrap_or(0);
        crate::stats::fleiss(&multi.into_iter().filter(|r| r.len() == m).collect::<Vec<_>>())
    } else {
        crate::stats::cohen(&pairs)
    };
    (a.n >= 2 && a.kappa.is_some()).then_some(a)
}

fn kappa_phrase(a: &crate::stats::Agreement) -> String {
    let symbol = if a.method.starts_with("Fleiss") { "Fleiss' κ" } else { "Cohen's κ" };
    format!("{symbol} = {:.2}, {:.0}% agreement over {}", a.kappa.unwrap_or(0.0), a.percent.unwrap_or(0.0), plural(a.n, "record", "records"))
}

fn reviewers(n: u32) -> String {
    if n <= 1 { "one reviewer".into() } else { format!("{} reviewers independently", count_word(n as usize)) }
}

/// Item 8 in the past tense, with agreement, automation and AI.
fn selection_methods(c: &Ctx) -> String {
    let s = c.state;
    let r = &s.protocol.rules;
    let mut t = format!("Titles and abstracts were screened by {} and full texts by {}", reviewers(r.ta.reviewers), reviewers(r.ft.reviewers));
    if r.blind && (r.ta.reviewers > 1 || r.ft.reviewers > 1) {
        t.push_str(", blind to each other's decisions");
    }
    t.push_str(&format!(", using {}.", software()));
    if let Some(a) = agreement(s, Stage::Ta) {
        t.push_str(&format!(" Agreement at title and abstract was {}.", kappa_phrase(&a)));
    }
    if let Some(a) = agreement(s, Stage::Ft) {
        t.push_str(&format!(" Agreement at full text was {}.", kappa_phrase(&a)));
    }
    if r.ta.reviewers > 1 || r.ft.reviewers > 1 {
        t.push_str(if r.conflicts == "third" { " Disagreements were resolved by a third reviewer." } else { " Disagreements were resolved by discussion." });
    }
    for p in &s.pilots {
        let stage = if p.stage == Some(Stage::Ft) { "full texts" } else { "titles and abstracts" };
        t.push_str(&format!(" Before the main round, {} screened a pilot sample of {} {stage} to calibrate the criteria.", join_and(&p.reviewers.iter().map(|x| s.member_name(x)).collect::<Vec<_>>()), thousands(p.records.len())));
    }
    if c.prisma.automation > 0 {
        let names: Vec<String> = s.protocol.criteria.iter().filter(|x| x.link.as_ref().is_some_and(|l| l.effect == "auto")).map(|x| x.label.clone()).collect();
        t.push_str(&format!(" {} were excluded automatically because their metadata showed they did not meet {}; these decisions were labelled, could be undone, and are reported as removed by automation tools.", capital(&plural(c.prisma.automation, "record", "records")), if names.is_empty() { "a criterion".into() } else { join_and(&names.iter().map(|n| format!("“{n}”")).collect::<Vec<_>>()) }));
    }
    if let Some(ai) = c.fact_text("/ai/statement") {
        t.push(' ');
        t.push_str(&ai);
    } else if r.ai_assist {
        t.push_str(" An AI model suggested decisions and an order for screening; suggestions were shown to reviewers and never counted as a decision.");
    }
    t
}

fn collection_methods(c: &Ctx) -> String {
    let r = &c.state.protocol.rules;
    let forms: Vec<String> = c.forms(false).iter().map(|f| f.name.clone()).collect();
    let mut t = if r.extractors >= 2 { format!("Two reviewers extracted data independently using {}; differences were compared field by field and agreed values recorded", if forms.is_empty() { "a structured form".into() } else { join_and(&forms) }) } else { format!("One reviewer extracted data using {}", if forms.is_empty() { "a structured form".into() } else { join_and(&forms) }) };
    t.push_str(&format!(" in {}.", software()));
    if r.quote_required {
        t.push_str(" Every value was backed by a quotation from the report.");
    }
    if let Some(p) = c.fact_text("/extractionPilot/statement") {
        t.push(' ');
        t.push_str(&p);
    }
    if let Some(x) = c.fact_text("/contacts/statement") {
        t.push(' ');
        t.push_str(&x);
    }
    t
}

fn sources_sentence(c: &Ctx) -> String {
    let rows = &c.search.sources;
    if rows.is_empty() {
        return String::new();
    }
    let dbs: Vec<String> = rows.iter().filter(|s| s.group != "registers").map(|s| if s.searched.is_empty() { s.name.clone() } else { format!("{} (last searched {})", s.name, s.searched) }).collect();
    let regs: Vec<String> = rows.iter().filter(|s| s.group == "registers").map(|s| if s.searched.is_empty() { s.name.clone() } else { format!("{} ({})", s.name, s.searched) }).collect();
    let mut t = String::new();
    if !dbs.is_empty() {
        t.push_str(&format!("We searched {}.", join_and(&dbs)));
    }
    if !regs.is_empty() {
        t.push_str(&format!(" We searched the study registers {}.", join_and(&regs)));
    }
    let other: Vec<String> = c.search.other_methods.iter().map(|s| lower_first(&s.name)).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    if !other.is_empty() {
        t.push_str(&format!(" We also used {}.", join_and(&other)));
    }
    t.trim().to_string()
}

fn synthesis_methods(c: &Ctx) -> Option<String> {
    if let Some(s) = c.fact_text("/analysis/statement") {
        return Some(s);
    }
    let mut out = Vec::new();
    for a in &c.state.analyses {
        let o = a.get("options").cloned().unwrap_or(Json::Null);
        if let Some(m) = o.get("measure").and_then(Json::as_str) {
            let hk = if o.get("hartungKnapp").and_then(Json::as_bool).unwrap_or(false) { " with the Hartung–Knapp adjustment" } else { "" };
            out.push(format!("{} were pooled with {}{hk}", pd::measure_name(m), pd::method_name(o.get("method").and_then(Json::as_str).unwrap_or("reml"))));
        }
    }
    out.dedup();
    if out.is_empty() {
        return None;
    }
    Some(format!("{}. Heterogeneity was assessed with Cochran's Q, I², τ² and 95% prediction intervals. Analyses were run in {}, whose meta-analysis results are checked against the R package metafor.", capital(&join_and(&out)), software()))
}

/// The Results flow paragraph from the PRISMA numbers.
fn results_flow(c: &Ctx) -> String {
    let p = &c.prisma;
    if p.identified + p.other.identified == 0 {
        return String::new();
    }
    let mut t = format!("The searches identified {}", plural(p.identified, "record", "records"));
    let dbs: usize = p.databases.iter().map(|n| n.count).sum();
    let regs: usize = p.registers.iter().map(|n| n.count).sum();
    if regs > 0 {
        t.push_str(&format!(" ({} from databases and {} from registers)", thousands(dbs), thousands(regs)));
    }
    t.push('.');
    let mut removed = vec![plural(p.duplicates, "duplicate", "duplicates")];
    if p.automation > 0 {
        removed.push(format!("{} marked ineligible by automation tools", thousands(p.automation)));
    }
    if p.removed_other > 0 {
        removed.push(format!("{} removed for other reasons", thousands(p.removed_other)));
    }
    t.push_str(&format!(" After removing {}, {} were screened on title and abstract and {} excluded.", join_and(&removed), plural(p.screened, "record", "records"), thousands(p.screening_excluded)));
    let m = &p.main;
    t.push_str(&format!(" We sought {} for retrieval", plural(m.sought, "report", "reports")));
    if m.not_retrieved > 0 {
        t.push_str(&format!(", of which {} could not be retrieved", thousands(m.not_retrieved)));
    }
    t.push_str(&format!(". Of {} assessed for eligibility, {} excluded", plural(m.assessed, "report", "reports"), thousands(m.excluded)));
    if !m.excluded_reasons.is_empty() {
        t.push_str(&format!(" ({})", m.excluded_reasons.iter().map(|r| format!("{}: {}", lower_first(&r.name), r.count)).collect::<Vec<_>>().join("; ")));
    }
    t.push('.');
    if p.other.identified > 0 {
        let o = &p.other;
        t.push_str(&format!(" Other methods ({}) identified {}; {} were assessed and {} included.", join_and(&p.other_methods.iter().map(|n| lower_first(&n.name)).collect::<Vec<_>>()), plural(o.identified, "record", "records"), thousands(o.assessed), thousands(o.included)));
    }
    t.push_str(&format!(" In total, {} ({}) were included in the review.", plural(p.studies_included, "study", "studies"), plural(p.reports_included, "report", "reports")));
    if !p.complete {
        t.push_str(&format!(" [Screening is still under way: {} still to screen and {} still to assess; these numbers will change.]", thousands(p.screening_pending + p.other.screening_pending), thousands(m.pending + p.other.pending)));
    }
    t
}

fn limitations(c: &Ctx) -> String {
    let s = c.state;
    let r = &s.protocol.rules;
    let mut out = Vec::new();
    if r.ta.reviewers < 2 {
        out.push("titles and abstracts were screened by one reviewer".to_string());
    }
    if r.ft.reviewers < 2 {
        out.push("full texts were assessed by one reviewer".to_string());
    }
    if r.extractors < 2 {
        out.push("data were extracted by one reviewer".to_string());
    }
    if c.prisma.main.not_retrieved + c.prisma.other.not_retrieved > 0 {
        out.push(format!("{} could not be retrieved", plural(c.prisma.main.not_retrieved + c.prisma.other.not_retrieved, "report", "reports")));
    }
    if c.prisma.automation > 0 {
        out.push(format!("{} were excluded automatically from their metadata", plural(c.prisma.automation, "record", "records")));
    }
    if c.search.sources.iter().all(|x| x.group != "registers") && !c.search.sources.is_empty() {
        out.push("no study registers were searched".to_string());
    }
    let langs: Vec<String> = c.search.sources.iter().flat_map(|x| x.limits.iter()).filter(|l| l.value.to_lowercase().contains("language")).map(|l| l.value.clone()).collect();
    if !langs.is_empty() {
        out.push(format!("searches were limited ({})", langs[0]));
    }
    if out.is_empty() {
        return String::new();
    }
    format!("Limitations of the review process: {}.", out.join("; "))
}

// ── PRISMA 2020 items ───────────────────────────────────────────────────────────────

fn lower_first(t: &str) -> String {
    let mut c = t.chars();
    match c.next() {
        Some(f) => f.to_lowercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn manuscript(mut i: Item, draft: Option<String>) -> Item {
    i.manuscript = true;
    i.draft = draft.filter(|d| !d.trim().is_empty());
    i.status = "missing".into();
    i.rule = "Written in the manuscript; Key cannot see it. Note where it is reported.".into();
    i.gap = Some(Gap { text: "Report it in the manuscript.".into(), action: "Note where the manuscript reports it".into(), link: None });
    i
}

fn not_recorded(mut i: Item, who: &str, link: Option<Link>) -> Item {
    i.status = "notRecorded".into();
    i.rule = format!("Not recorded yet: {who} will supply this once it is in use.");
    i.gap = Some(Gap { text: format!("{who} is not recorded yet."), action: "Record it there, or report it in the manuscript".into(), link });
    i
}

fn na(mut i: Item, why: &str) -> Item {
    i.status = "na".into();
    i.rule = why.into();
    i
}

const SCOPING_NA: &str = "Not required for a scoping review (PRISMA-ScR).";

fn main_items(c: &Ctx) -> Vec<Item> {
    let s = c.state;
    let p = &s.protocol;
    let pr = &c.prisma;
    let mk = |id: &str, section: &str, topic: &str, text: &str| item("prisma2020", id, section, topic, text);
    let has_analysis = !s.analyses.is_empty() || c.fact("/analysis").is_some();
    let mut out = Vec::new();

    out.push(manuscript(mk("1", "Title", "Title", "Identify the report as a systematic review."), Some(format!("{}: {}", s.info.name.trim(), if has_analysis { "a systematic review and meta-analysis" } else { "a systematic review" }))));
    let mut abs = mk("2", "Abstract", "Abstract", "Give a structured abstract (see the abstracts checklist).");
    abs = gap(abs, "partly", "Key fills most abstract items from the review; the abstract itself is written in the manuscript.", "Open the abstracts checklist", Link::to("Abstracts checklist", "overview", Some("checklist:abstract")));
    out.push(abs);

    // Introduction
    let i = mk("3", "Introduction", "Rationale", "Describe the rationale for the review in the context of what is already known.");
    out.push(if !c.plan("rationale").is_empty() { done(i, "The protocol states a rationale.", Some(c.plan("rationale"))) } else { gap(i, "missing", "No rationale is written yet.", "Write the rationale in the protocol", protocol("Rationale")) });
    let i = mk("4", "Introduction", "Objectives", "State the objective(s) or question(s) the review addresses.");
    let obj = pd::effective(s, "objectives").0;
    out.push(if !obj.is_empty() { done(i, "The review question is set (Setup › Question).", Some(obj)) } else { gap(i, "missing", "The review question is empty.", "Write the question", setup("question", "Setup › Question")) });

    // Methods
    let i = mk("5", "Methods", "Eligibility criteria", "Specify the inclusion and exclusion criteria and how studies were grouped for the syntheses.");
    let mut i = if p.criteria.is_empty() {
        gap(i, "missing", "No criteria yet.", "Set the criteria", setup("criteria", "Setup › Criteria"))
    } else if p.plan.outcomes.is_empty() && p.plan.subgroups.is_empty() && pd::effective(s, "synthesis").0.is_empty() && !c.scoping() {
        let mut x = gap(i, "partly", "The criteria are set; how studies are grouped for the syntheses is not stated.", "Name the outcomes and planned groupings in the protocol", protocol("Outcomes"));
        x.draft = Some(pd::criteria_text(p));
        x
    } else {
        done(i, "Criteria are set by part of the question, and the grouping for syntheses is planned.", Some(pd::criteria_text(p)))
    };
    i.evidence.push(setup("criteria", "Setup › Criteria"));
    out.push(i);

    let i = mk("6", "Methods", "Information sources", "Name all sources searched or consulted and the date each was last searched.");
    let rows: Vec<&crate::search_report::SourceRow> = c.search.sources.iter().chain(c.search.other_methods.iter()).collect();
    let undated: Vec<String> = rows.iter().filter(|r| r.searched.is_empty()).map(|r| r.name.clone()).collect();
    let mut i = if rows.is_empty() {
        gap(i, "missing", "No searches are imported yet.", "Add the records you found", Link::to("Sources › Imports", "sources", Some("imports")))
    } else if pr.unnamed > 0 {
        gap(i, "partly", &format!("{} come from a source that is not named.", plural(pr.unnamed, "record", "records")), "Name the database they came from", Link::to("Sources › Imports", "sources", Some("imports")))
    } else if !undated.is_empty() {
        gap(i, "partly", &format!("No date searched for {}.", join_and(&undated)), "Add the dates in the search report", Link::to("Search report", "overview", Some("search")))
    } else {
        done(i, "Every source is named and dated (search report).", None)
    };
    i.draft = Some(sources_sentence(c)).filter(|d| !d.is_empty());
    i.evidence.push(Link::to("Search report", "overview", Some("search")));
    out.push(i);

    let i = mk("7", "Methods", "Search strategy", "Present the full search strategies for all databases, registers and websites, with any filters and limits.");
    let s8 = c.search.items.iter().find(|x| x.id == "8");
    let mut i = match s8.map(|x| x.status.as_str()) {
        Some("evidenced") => done(i, "Every source has its strategy as run (PRISMA-S item 8).", Some("The full search strategies for every database, register and website, including the limits and filters used, are given in Supplementary file X.".into())),
        Some(st) => {
            let x = s8.unwrap();
            gap(i, if st == "missing" { "missing" } else { "partly" }, &x.rule, "Complete the search report", Link::to("Search report", "overview", Some("search")))
        }
        None => gap(i, "missing", "No searches yet.", "Run a database search", Link::to("Sources › Database searches", "sources", Some("searches"))),
    };
    i.evidence.push(Link::to("Search report", "overview", Some("search")));
    out.push(i);

    let mut i = done(mk("8", "Methods", "Selection process", "Say how eligibility was decided: how many reviewers screened each record, whether independently, and any automation tools."), "Read from the screening rules, decisions and agreement.", Some(selection_methods(c)));
    if s.protocol.rules.ai_assist && c.fact("/ai").is_none() {
        i.status = "partly".into();
        i.rule = "AI assistance is on; its disclosure (model, version, dates, how it was checked) is not recorded yet.".into();
        i.gap = Some(Gap { text: "The AI-use disclosure is not recorded yet.".into(), action: "Describe the AI use in the manuscript".into(), link: None });
    }
    i.evidence.push(setup("team", "Setup › Team & rules"));
    out.push(i);

    let i = mk("9", "Methods", "Data collection process", "Say how data were collected: how many reviewers, independently or not, any contact with investigators and automation tools.");
    let mut i = if c.forms(false).is_empty() {
        gap(i, "missing", "No extraction form.", "Add an extraction form", setup("forms", "Setup › Extraction forms"))
    } else if c.fact("/contacts").is_none() {
        let mut x = done(i, "Read from the extraction rules and forms. Contact with study authors is not recorded yet.", Some(collection_methods(c)));
        x.status = "partly".into();
        x.gap = Some(Gap { text: "Contact with study investigators is not recorded yet.".into(), action: "Say in the manuscript whether authors were contacted".into(), link: None });
        x
    } else {
        done(i, "Read from the extraction rules, forms and contact log.", Some(collection_methods(c)))
    };
    i.evidence.push(setup("forms", "Setup › Extraction forms"));
    out.push(i);

    let i = mk("10a", "Methods", "Data items: outcomes", "List the outcomes sought and how results were chosen when a study reported several.");
    let outcome_forms = c.forms(false).iter().any(|f| f.kind == "outcomes" || f.fields().any(|x| x.role == "outcomes"));
    let planned = pd::effective(s, "outcomes").0;
    out.push(match (outcome_forms, p.plan.outcomes.is_empty()) {
        (_, false) => done(i, "Outcomes are named in the protocol.", Some(planned)),
        (true, true) => gap(i, "partly", "An outcome form exists; the outcomes and the rule for choosing among several results are not named.", "Name the outcomes in the protocol", protocol("Outcomes")),
        _ if c.scoping() => na(i, SCOPING_NA),
        _ => gap(i, "missing", "No outcomes are named.", "Name the outcomes in the protocol", protocol("Outcomes")),
    });
    let i = mk("10b", "Methods", "Data items: other variables", "List the other variables collected and any assumptions about missing or unclear information.");
    let items = pd::data_items_text(p);
    out.push(if !items.is_empty() { done(i, "The extraction forms list the variables.", Some(items)) } else { gap(i, "missing", "No form lists the variables.", "Add a study characteristics form", setup("forms", "Setup › Extraction forms")) });

    let i = mk("11", "Methods", "Study risk of bias assessment", "Name the risk-of-bias tool(s), how many reviewers assessed each study, whether independently, and any automation.");
    out.push(if let Some(st) = c.fact_text("/rob/statement") {
        done(i, "From the risk-of-bias assessment.", Some(st))
    } else if c.scoping() {
        na(i, "Optional for a scoping review (critical appraisal, PRISMA-ScR item 12).")
    } else if !c.forms(true).is_empty() {
        let mut x = not_recorded(i, "Risk of bias per result (the Risk of bias view)", Some(Link::to("Risk of bias", "rob", None)));
        x.status = "partly".into();
        x.rule = "A risk-of-bias form is in use; the per-result assessment is not recorded yet.".into();
        x.draft = Some(pd::rob_text(p));
        x
    } else {
        gap(i, "missing", "No risk-of-bias tool is chosen.", "Add a risk-of-bias form (RoB 2, ROBINS-I or Newcastle–Ottawa style)", setup("forms", "Setup › Extraction forms"))
    });

    let i = mk("12", "Methods", "Effect measures", "Name the effect measure(s) used for each outcome.");
    let measures: Vec<String> = s.analyses.iter().filter_map(|a| a.pointer("/options/measure").and_then(Json::as_str)).map(pd::measure_name).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    out.push(if !measures.is_empty() {
        done(i, "Read from the saved analyses.", Some(format!("Effects were expressed as {}.", join_and(&measures))))
    } else if c.scoping() {
        na(i, SCOPING_NA)
    } else if !pd::effective(s, "synthesis").0.is_empty() {
        gap(i, "partly", "Planned in the protocol; no analysis is saved yet.", "Save an analysis", Link::to("Analysis", "analysis", None))
    } else {
        gap(i, "missing", "No effect measure is chosen.", "Choose it in Analysis or plan it in the protocol", Link::to("Analysis", "analysis", None))
    });

    let synth = synthesis_methods(c);
    for (id, topic, text) in [
        ("13a", "Synthesis methods: eligibility", "Describe how studies were chosen for each synthesis."),
        ("13b", "Synthesis methods: data preparation", "Describe any preparation of data (missing statistics, conversions)."),
        ("13c", "Synthesis methods: tabulation and display", "Describe how results were tabulated or shown."),
        ("13d", "Synthesis methods: methods and software", "Describe the synthesis methods, the model, heterogeneity and the software."),
        ("13e", "Synthesis methods: heterogeneity", "Describe how causes of heterogeneity were explored (subgroups, meta-regression)."),
        ("13f", "Synthesis methods: sensitivity", "Describe sensitivity analyses."),
    ] {
        let i = mk(id, "Methods", topic, text);
        if c.scoping() && id != "13d" {
            out.push(na(i, SCOPING_NA));
            continue;
        }
        let it = match id {
            "13a" if has_analysis => done(i, "Each saved analysis names its outcome and time point; studies with data for it are pooled.", Some("Studies were eligible for a synthesis when they reported the outcome and time point of that synthesis with the data the effect measure needs.".into())),
            "13b" => match c.fact("/analysis/conversions").and_then(Json::as_array).filter(|a| !a.is_empty()) {
                Some(list) => done(i, "Conversions are recorded with their method.", Some(format!("Data were converted where needed: {}.", list.iter().filter_map(Json::as_str).collect::<Vec<_>>().join("; ")))),
                None if has_analysis => not_recorded(i, "Data conversions (Analysis)", Some(Link::to("Analysis", "analysis", None))),
                None => gap(i, "missing", "No analysis yet.", "Describe data preparation in the protocol or the manuscript", protocol("Data synthesis")),
            },
            "13c" if has_analysis => done(i, "Forest and funnel plots and outcome tables come from the analysis.", Some("Results of individual studies and syntheses were tabulated and shown in forest plots.".into())),
            "13d" if c.scoping() => {
                let t = c.plan("synthesis");
                if t.is_empty() { gap(i, "missing", "How the evidence is charted and summarised is not stated.", "Describe it in the protocol (Data synthesis)", protocol("Data synthesis")) } else { done(i, "Stated in the protocol.", Some(t)) }
            }
            "13d" => match &synth {
                Some(t) => done(i, "Read from the saved analyses.", Some(t.clone())),
                None if !pd::effective(s, "synthesis").0.is_empty() => gap(i, "partly", "Planned in the protocol; no analysis is saved yet.", "Save an analysis", Link::to("Analysis", "analysis", None)),
                None => gap(i, "missing", "No synthesis method yet.", "Plan the synthesis in the protocol", protocol("Data synthesis")),
            },
            "13e" => {
                let meta_reg = c.fact("/analysis/metaRegression").and_then(Json::as_bool).unwrap_or(false);
                if !p.plan.subgroups.is_empty() || meta_reg {
                    done(i, "Subgroup analyses are planned in the protocol.", Some(format!("Heterogeneity was explored with {}{}.", if p.plan.subgroups.is_empty() { String::new() } else { format!("subgroup analyses by {}", join_and(&p.plan.subgroups)) }, if meta_reg { if p.plan.subgroups.is_empty() { "meta-regression" } else { " and meta-regression" } } else { "" })))
                } else {
                    gap(i, "missing", "No subgroup analysis or meta-regression is planned.", "Name planned subgroup analyses (or none) in the protocol", protocol("Planned subgroup and sensitivity analyses"))
                }
            }
            "13f" => {
                let done_list: Vec<String> = c.fact("/analysis/sensitivity").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect()).unwrap_or_default();
                let list: Vec<String> = if done_list.is_empty() { p.plan.sensitivity.clone() } else { done_list };
                if list.is_empty() { gap(i, "missing", "No sensitivity analysis is planned.", "Name planned sensitivity analyses in the protocol", protocol("Planned subgroup and sensitivity analyses")) } else { done(i, "Sensitivity analyses are named.", Some(format!("Sensitivity analyses: {}.", join_and(&list)))) }
            }
            _ => gap(i, "missing", "No analysis yet.", "Save an analysis", Link::to("Analysis", "analysis", None)),
        };
        out.push(it);
    }

    let i = mk("14", "Methods", "Reporting bias assessment", "Describe how the risk of bias from missing results (publication bias) was assessed.");
    let pb: Vec<String> = c.fact("/analysis/publicationBias").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).map(str::to_string).collect()).unwrap_or_default();
    out.push(if !pb.is_empty() {
        done(i, "From the analysis.", Some(format!("Small-study effects and publication bias were assessed with {}.", join_and(&pb))))
    } else if c.scoping() {
        na(i, SCOPING_NA)
    } else if !c.plan("metaBias").is_empty() {
        let mut x = gap(i, "partly", "Planned in the protocol; not recorded from an analysis yet.", "Run it in Analysis", Link::to("Analysis", "analysis", None));
        x.draft = Some(c.plan("metaBias"));
        x
    } else {
        gap(i, "missing", "No plan for assessing reporting bias.", "State it in the protocol (Meta-bias)", protocol("Meta-bias(es)"))
    });

    let i = mk("15", "Methods", "Certainty assessment", "Describe how certainty in the body of evidence was assessed (for example GRADE).");
    out.push(if let Some(t) = c.fact_text("/grade/statement") {
        done(i, "From the certainty assessment.", Some(t))
    } else if c.scoping() {
        na(i, SCOPING_NA)
    } else if !c.plan("certainty").is_empty() {
        let mut x = not_recorded(i, "Certainty of evidence (GRADE, in Analysis)", Some(Link::to("Certainty", "analysis", Some("certainty"))));
        x.status = "partly".into();
        x.rule = "Planned in the protocol; the certainty assessment is not recorded yet.".into();
        x.draft = Some(c.plan("certainty"));
        x
    } else {
        not_recorded(i, "Certainty of evidence (GRADE, in Analysis)", Some(Link::to("Certainty", "analysis", Some("certainty"))))
    });

    // Results
    let i = mk("16a", "Results", "Study selection", "Describe the search and selection results, ideally with a flow diagram.");
    let flow = Link::to("PRISMA flow diagram", "overview", Some("flow"));
    let mut i = if pr.identified + pr.other.identified == 0 {
        gap(i, "missing", "No records yet.", "Add the records you found", Link::to("Sources › Imports", "sources", Some("imports")))
    } else if pr.complete {
        done(i, "The PRISMA flow is complete: every record is decided.", Some(results_flow(c)))
    } else {
        let mut x = gap(i, "partly", "Screening is still under way; the numbers will change.", "Finish screening", Link::to("Title & abstract", if pr.screening_pending > 0 { "ta" } else { "ft" }, None));
        x.draft = Some(results_flow(c));
        x
    };
    i.evidence.push(flow);
    out.push(i);
    let i = mk("16b", "Results", "Excluded studies", "Cite studies that seemed to meet the criteria but were excluded, and say why.");
    let unexplained = pr.main.excluded_reasons.iter().chain(pr.other.excluded_reasons.iter()).filter(|r| r.name == "No criterion given").map(|r| r.count).sum::<usize>();
    let mut i = if pr.main.excluded + pr.other.excluded == 0 {
        if pr.main.assessed + pr.other.assessed > 0 { na(i, "No report was excluded at full text.") } else { gap(i, "missing", "No full texts assessed yet.", "Assess the full texts", Link::to("Full text", "ft", None)) }
    } else if unexplained > 0 {
        gap(i, "partly", &format!("{} excluded at full text without a criterion.", plural(unexplained, "report was", "reports were")), "Give the criterion for each (Full text, Excluded)", Link::to("Full text", "ft", None))
    } else {
        done(i, "Every report excluded at full text has its criterion; the screening export lists them.", Some(format!("Reports excluded at full text, with reasons, are listed in Supplementary table X ({}).", pr.main.excluded_reasons.iter().map(|r| format!("{}: {}", lower_first(&r.name), r.count)).collect::<Vec<_>>().join("; "))))
    };
    i.evidence.push(Link::to("Export screening decisions (CSV)", "export", Some("screening")));
    out.push(i);

    let included = s.included();
    let char_forms = c.forms(false);
    let char_done = included.iter().filter(|r| s.extraction.get(&r.id).is_some_and(|e| char_forms.iter().any(|f| e.completed.get(&f.id).is_some_and(|w| !w.is_empty())))).count();
    let i = mk("17", "Results", "Study characteristics", "Cite each included study and give its characteristics.");
    out.push(if included.is_empty() {
        gap(i, "missing", "No study is included yet.", "Finish full-text screening", Link::to("Full text", "ft", None))
    } else if char_done == included.len() {
        done(i, &format!("Every included study ({}) has a completed form.", included.len()), Some("The characteristics of each included study are given in Table X (from the extraction export).".into()))
    } else {
        gap(i, "partly", &format!("{} of {} included studies have a completed form.", char_done, included.len()), "Complete the extraction", Link::to("Extraction", "extract", None))
    });

    let i = mk("18", "Results", "Risk of bias in studies", "Present the risk-of-bias assessment of each included study.");
    out.push(if let Some(t) = c.fact_text("/rob/results") {
        done(i, "From the risk-of-bias assessment.", Some(t))
    } else if c.scoping() {
        na(i, "Optional for a scoping review (PRISMA-ScR item 16).")
    } else {
        not_recorded(i, "Risk of bias per result (the Risk of bias view)", Some(Link::to("Risk of bias", "rob", None)))
    });

    let i = mk("19", "Results", "Results of individual studies", "For each study and outcome, give summary statistics per group and the effect estimate with its precision.");
    out.push(if has_analysis {
        done(i, "Each saved analysis lists every study's data and estimate (forest plot).", Some("For every outcome, the data of each study and its effect estimate with 95% confidence interval are shown in the forest plots (Figures X–Y).".into()))
    } else if included.is_empty() {
        gap(i, "missing", "No study included yet.", "Finish screening", Link::to("Full text", "ft", None))
    } else {
        gap(i, "partly", "Outcome data can be extracted; no analysis is saved yet.", "Analyse an outcome", Link::to("Analysis", "analysis", None))
    });

    for (id, topic, text) in [
        ("20a", "Results of syntheses: contributing studies", "Summarise the characteristics and risk of bias of the studies in each synthesis."),
        ("20b", "Results of syntheses: estimates", "Give each synthesis's estimate, precision and heterogeneity."),
        ("20c", "Results of syntheses: heterogeneity", "Present the results of the investigations of heterogeneity."),
        ("20d", "Results of syntheses: sensitivity", "Present the results of the sensitivity analyses."),
    ] {
        let i = mk(id, "Results", topic, text);
        if c.scoping() && id != "20b" {
            out.push(na(i, SCOPING_NA));
            continue;
        }
        out.push(match id {
            "20b" => match c.fact_text("/analysis/results") {
                Some(t) => done(i, "From the analysis.", Some(t)),
                None if has_analysis => done(i, "The saved analyses give each pooled estimate with its interval and heterogeneity.", None),
                None => gap(i, "missing", "No synthesis yet.", "Analyse an outcome", Link::to("Analysis", "analysis", None)),
            },
            "20a" if c.fact("/rob/results").is_some() && has_analysis => done(i, "Risk of bias and characteristics are recorded for the studies in each analysis.", None),
            "20a" => not_recorded(i, "Risk of bias per synthesis", Some(Link::to("Risk of bias", "rob", None))),
            _ if !has_analysis => gap(i, "missing", "No synthesis yet.", "Analyse an outcome", Link::to("Analysis", "analysis", None)),
            _ => not_recorded(i, "These analyses' results (Analysis)", Some(Link::to("Analysis", "analysis", None))),
        });
    }

    let i = mk("21", "Results", "Reporting biases", "Present the assessments of risk of bias from missing results.");
    out.push(if c.scoping() { na(i, SCOPING_NA) } else if !pb.is_empty() { done(i, "From the analysis.", None) } else if has_analysis { not_recorded(i, "Small-study and publication-bias results (Analysis)", Some(Link::to("Analysis", "analysis", None))) } else { gap(i, "missing", "No synthesis yet.", "Analyse an outcome", Link::to("Analysis", "analysis", None)) });
    let i = mk("22", "Results", "Certainty of evidence", "Present the certainty of the evidence for each outcome.");
    out.push(if let Some(t) = c.fact_text("/grade/results") { done(i, "From the certainty assessment.", Some(t)) } else if c.scoping() { na(i, SCOPING_NA) } else { not_recorded(i, "Certainty of evidence (GRADE)", Some(Link::to("Certainty", "analysis", Some("certainty")))) });

    // Discussion
    out.push(manuscript(mk("23a", "Discussion", "Interpretation", "Interpret the results in the context of other evidence."), None));
    out.push(manuscript(mk("23b", "Discussion", "Limitations of the evidence", "Discuss the limitations of the evidence included."), None));
    out.push(manuscript(mk("23c", "Discussion", "Limitations of the review processes", "Discuss the limitations of the review processes used."), Some(limitations(c))));
    out.push(manuscript(mk("23d", "Discussion", "Implications", "Discuss implications for practice, policy and future research."), None));

    // Other information
    let i = mk("24a", "Other information", "Registration", "Give the registry and registration number, or say the review was not registered.");
    let mut i = if let Some(r) = &s.reporting.registration {
        let before = pd::registered_before_conduct(s);
        let mut x = done(i, &format!("Registered with {} on {}{}.", r.registry, r.date, match before { Some(true) => ", before the first screening decision", Some(false) => ", after screening had started", None => "" }), Some(format!("The protocol was registered with {}{} on {}.", r.registry, if r.id.is_empty() { String::new() } else { format!(" ({})", r.id) }, r.date)));
        if before == Some(false) {
            x.rule.push_str(" AMSTAR 2 asks for the protocol to be registered before the review starts; say so in the manuscript.");
        }
        x
    } else if !p.registration.trim().is_empty() {
        let mut x = gap(i, "partly", "A registration id is written but its date is not recorded.", "Record the registration (registry and date)", protocol("Registration"));
        x.draft = Some(format!("The protocol was registered ({}).", p.registration.trim()));
        x
    } else {
        let mut x = gap(i, "missing", "Not registered.", "Register the protocol, or say in the manuscript that it was not registered", protocol("Registration"));
        x.draft = Some("The review was not registered.".into());
        x
    };
    i.evidence.push(protocol("Registration"));
    out.push(i);
    let i = mk("24b", "Other information", "Protocol", "Say where the protocol can be accessed, or that none was prepared.");
    let url = [c.plan("protocolUrl"), s.reporting.registration.as_ref().map(|r| r.url.clone()).unwrap_or_default()].into_iter().find(|u| !u.trim().is_empty());
    out.push(match url {
        Some(u) => done(i, "The protocol's address is recorded.", Some(format!("The protocol is available at {u}."))),
        None => gap(i, "partly", "Key holds the protocol; where it can be read is not stated.", "Export the protocol and add its address", protocol("Where the protocol can be read")),
    });
    let i = mk("24c", "Other information", "Amendments", "Describe and explain any changes from the registration or protocol.");
    out.push(if pd::locked(s) {
        let d = pd::deviations(s);
        let draft = if d.is_empty() { "There were no deviations from the registered protocol.".to_string() } else { format!("The protocol was amended {} after registration: {}.", if d.len() == 1 { "once".to_string() } else { format!("{} times", count_word(d.len())) }, d.iter().map(|x| format!("on {} ({}; reason: {})", date(x.at), if x.changes.is_empty() { "settings changed".into() } else { lower_first(&x.changes.join("; ")) }, x.reason.trim())).collect::<Vec<_>>().join("; ")) };
        let mut x = done(i, "Every change after registration is a dated amendment with its reason.", Some(draft));
        x.evidence.push(protocol("Deviations from protocol"));
        x
    } else {
        gap(i, "partly", "The protocol is not registered, so there is nothing to compare against; Key keeps every version with its note.", "Register the protocol to track deviations", protocol("Registration"))
    });
    let i = mk("25", "Other information", "Support", "Describe sources of support and the role of funders.");
    out.push(if !c.plan("funding").is_empty() { done(i, "Stated in the protocol.", Some([c.plan("funding"), c.plan("funderRole")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" "))) } else { gap(i, "missing", "No funding statement.", "State funding (or none) in the protocol", protocol("Funding and other support")) });
    let i = mk("26", "Other information", "Competing interests", "Declare any competing interests of the review authors.");
    out.push(if !c.plan("conflicts").is_empty() { done(i, "Stated in the protocol.", Some(c.plan("conflicts"))) } else { gap(i, "missing", "No competing-interests statement.", "State competing interests (or none) in the protocol", protocol("Competing interests")) });
    let i = mk("27", "Other information", "Availability of data, code and other materials", "Say which materials are public and where: forms, extracted data, analysis data, code.");
    out.push(if let Some(t) = c.fact_text("/sharing/statement") {
        done(i, "From the review's exports.", Some(t))
    } else {
        let mut x = gap(i, "partly", "Key exports the forms, extracted data and review file; analysis code is not recorded yet.", "Export the data and say where it is shared", Link::to("Extraction › Export", "extract", None));
        x.draft = Some(format!("The data collection forms, the extracted data and the complete review log (as a {} review file) are available at [repository].", software()));
        x
    });
    out
}

fn living_items(c: &Ctx) -> Vec<Item> {
    let s = c.state;
    let mk = |id: &str, topic: &str, text: &str| item("lsr", id, "Living review (PRISMA-LSR)", topic, text);
    let mut out = Vec::new();
    let i = mk("L1", "Living mode", "State how often searches are rerun, what triggers an update and when the review stops being living.");
    let t = c.plan("livingFrequency");
    out.push(if t.is_empty() { gap(i, "missing", "Not stated.", "Describe the living mode in the protocol", protocol("Living mode")) } else { done(i, "Stated in the protocol.", Some(t)) });
    let i = mk("L2", "Changes in this version", "Say what changed since the previous version of the review: new searches, studies and results.");
    let updates = &c.search.updates;
    out.push(if updates.is_empty() {
        gap(i, "missing", "No update search yet.", "Run the review's searches again", Link::to("Sources › Database searches", "sources", Some("searches")))
    } else {
        done(i, "Update searches are recorded.", Some(format!("Since the previous version, searches were rerun {}; {} were added.", join_and(&updates.iter().map(|u| format!("on {}", date(u.at))).collect::<Vec<_>>()), plural(updates.iter().map(|u| u.added).sum(), "record", "records"))))
    });
    let _ = s;
    out
}

/// PRISMA-ScR (paraphrased) read with the PRISMA 2020 rules: (ScR item, topic, PRISMA 2020 item).
const SCR: &[(&str, &str, &str, &str)] = &[
    ("1", "Title", "Title", "1"),
    ("2", "Abstract", "Structured summary", "2"),
    ("3", "Introduction", "Rationale", "3"),
    ("4", "Introduction", "Objectives", "4"),
    ("5", "Methods", "Protocol and registration", "24a"),
    ("6", "Methods", "Eligibility criteria", "5"),
    ("7", "Methods", "Information sources", "6"),
    ("8", "Methods", "Search", "7"),
    ("9", "Methods", "Selection of sources of evidence", "8"),
    ("10", "Methods", "Data charting process", "9"),
    ("11", "Methods", "Data items", "10b"),
    ("12", "Methods", "Critical appraisal (optional)", "11"),
    ("13", "Methods", "Synthesis of results", "13d"),
    ("14", "Results", "Selection of sources of evidence", "16a"),
    ("15", "Results", "Characteristics of sources of evidence", "17"),
    ("16", "Results", "Critical appraisal within sources (optional)", "18"),
    ("17", "Results", "Results of individual sources", "19"),
    ("18", "Results", "Synthesis of results", "20b"),
    ("19", "Discussion", "Summary of evidence", "23a"),
    ("20", "Discussion", "Limitations", "23c"),
    ("21", "Discussion", "Conclusions", "23d"),
    ("22", "Funding", "Funding", "25"),
];

fn scr_items(main: &[Item]) -> Vec<Item> {
    SCR.iter()
        .filter_map(|(id, section, topic, from)| {
            let m = main.iter().find(|x| x.id == *from)?;
            let mut x = m.clone();
            x.list = "scr".into();
            x.id = id.to_string();
            x.section = section.to_string();
            x.topic = topic.to_string();
            if *id == "12" || *id == "16" {
                if x.status != "evidenced" {
                    x.status = "na".into();
                    x.rule = "Optional in PRISMA-ScR; report it if you appraised the sources.".into();
                    x.gap = None;
                }
            }
            Some(x)
        })
        .collect()
}

/// The abstracts checklist: (item, section, topic, text, PRISMA 2020 item it reads).
const ABSTRACT: &[(&str, &str, &str, &str, &str)] = &[
    ("1", "Title", "Title", "Identify the report as a systematic review.", "1"),
    ("2", "Background", "Objectives", "State the main objective(s) or question(s).", "4"),
    ("3", "Methods", "Eligibility criteria", "Give the inclusion and exclusion criteria.", "5"),
    ("4", "Methods", "Information sources", "Name the key sources and the date each was last searched.", "6"),
    ("5", "Methods", "Risk of bias", "Name the methods used to assess risk of bias.", "11"),
    ("6", "Methods", "Synthesis of results", "Name the methods used to present and synthesise results.", "13d"),
    ("7", "Results", "Included studies", "Give the number of included studies and participants and their characteristics.", "17"),
    ("8", "Results", "Synthesis of results", "Give the main results, with the number of studies and participants and the estimate with its precision.", "20b"),
    ("9", "Discussion", "Limitations of evidence", "Summarise the main limitations of the evidence.", "23b"),
    ("10", "Discussion", "Interpretation", "Give a general interpretation and the main implications.", "23a"),
    ("11", "Other", "Funding", "Name the main source of funding.", "25"),
    ("12", "Other", "Registration", "Give the register name and registration number.", "24a"),
];

fn abstract_items(c: &Ctx, main: &[Item]) -> Vec<Item> {
    let p = &c.prisma;
    ABSTRACT
        .iter()
        .filter_map(|(id, section, topic, text, from)| {
            let m = main.iter().find(|x| x.id == *from)?;
            let mut x = m.clone();
            x.list = "abstract".into();
            x.id = id.to_string();
            x.section = section.to_string();
            x.topic = topic.to_string();
            x.text = text.to_string();
            x.draft = match *id {
                "4" => {
                    let names: Vec<String> = c.search.sources.iter().map(|s| s.name.clone()).collect();
                    let last = c.search.sources.iter().filter_map(|s| s.searched_ms).max();
                    (!names.is_empty()).then(|| format!("We searched {}{}.", join_and(&names), last.map(|l| format!(" up to {}", date(l))).unwrap_or_default()))
                }
                "7" => (p.studies_included > 0).then(|| format!("We included {} ({}).", plural(p.studies_included, "study", "studies"), plural(p.reports_included, "report", "reports"))),
                _ => m.draft.as_ref().map(|d| d.split_inclusive(". ").next().unwrap_or(d).trim().to_string()),
            };
            Some(x)
        })
        .collect()
}

pub struct Checklist {
    pub kind: String,
    pub main: Vec<Item>,
    pub abstract_items: Vec<Item>,
    pub extra: Vec<Item>,
    pub prismas: Vec<Item>,
    pub methods: String,
    pub results: String,
}

pub fn compute(state: &State, strategies: &std::collections::HashMap<String, Json>) -> Checklist {
    let kind = state.protocol.plan.review_type();
    let c = Ctx { state, prisma: crate::prisma::compute(state), facts: crate::reporting_hooks::facts(state), search: crate::search_report::report(state, strategies), kind };
    let mut main = main_items(&c);
    let extra = if kind == "living" { living_items(&c) } else { Vec::new() };
    for i in main.iter_mut() {
        attach_note(state, i);
        // A location in the manuscript evidences what only the manuscript can.
        if i.manuscript && i.note.as_ref().is_some_and(|n| !n.location.trim().is_empty()) {
            i.status = "evidenced".into();
            i.rule = format!("Reported in the manuscript: {}.", i.note.as_ref().unwrap().location.trim());
            i.gap = None;
        }
    }
    let mut abstract_items = abstract_items(&c, &main);
    for i in abstract_items.iter_mut() {
        attach_note(state, i);
        if i.note.as_ref().is_some_and(|n| !n.location.trim().is_empty()) && matches!(i.status.as_str(), "missing" | "partly") && i.manuscript {
            i.status = "evidenced".into();
            i.gap = None;
        }
    }
    let main = if kind == "scoping" {
        let mut scr = scr_items(&main);
        for i in scr.iter_mut() {
            attach_note(state, i);
        }
        scr
    } else {
        main
    };
    let methods = methods_text(&c);
    let results = results_flow(&c);
    Checklist { kind: kind.to_string(), main, abstract_items, extra, prismas: c.search.items.clone(), methods, results }
}

/// A Methods section drafted from the review's data (and the Results flow paragraph).
fn methods_text(c: &Ctx) -> String {
    let s = c.state;
    let mut parts: Vec<(&str, String)> = Vec::new();
    let mut proto = match &s.reporting.registration {
        Some(r) => format!("The protocol was registered with {}{} on {}.", r.registry.trim(), if r.id.trim().is_empty() { String::new() } else { format!(" ({})", r.id.trim()) }, r.date.trim()),
        None if !s.protocol.registration.trim().is_empty() => format!("The protocol was registered ({}).", s.protocol.registration.trim()),
        None => "The review was not registered.".to_string(),
    };
    if pd::locked(s) {
        let d = pd::deviations(s);
        proto.push_str(if d.is_empty() { " There were no deviations from the registered protocol." } else { " Deviations from the registered protocol are listed with their reasons in Supplementary file X." });
    }
    proto.push_str(&format!(" We report the review following PRISMA 2020{}.", if c.scoping() { " and its extension for scoping reviews (PRISMA-ScR)" } else { "" }));
    parts.push(("Protocol and registration", proto));
    let crit = pd::criteria_text(&s.protocol);
    if !crit.is_empty() {
        parts.push(("Eligibility criteria", format!("Studies were eligible when they met these criteria. {}", crit.replace('\n', " "))));
    }
    let src = sources_sentence(c);
    if !src.is_empty() {
        parts.push(("Information sources", src));
    }
    parts.push(("Search strategy", "The full strategies for every source, exactly as run, with limits, filters and the number of records each query returned, are given in Supplementary file X.".into()));
    parts.push(("Selection process", selection_methods(c)));
    if !c.forms(false).is_empty() {
        parts.push(("Data collection process", collection_methods(c)));
        let items = pd::data_items_text(&s.protocol);
        if !items.is_empty() {
            parts.push(("Data items", format!("We collected the following. {}", items.replace('\n', " "))));
        }
    }
    if let Some(t) = c.fact_text("/rob/statement").or_else(|| Some(pd::rob_text(&s.protocol)).filter(|t| !t.is_empty())) {
        if !c.scoping() {
            parts.push(("Study risk of bias assessment", t.replace("is assessed", "was assessed")));
        }
    }
    if let Some(t) = synthesis_methods(c) {
        parts.push(("Synthesis methods", t));
    }
    if let Some(t) = c.fact_text("/grade/statement") {
        parts.push(("Certainty assessment", t));
    }
    if let Some(t) = c.fact_text("/ai/statement") {
        parts.push(("Use of artificial intelligence", t));
    }
    let mut out = String::new();
    for (head, body) in parts {
        out.push_str(&format!("### {head}\n\n{}\n\n", body.trim()));
    }
    out
}

// ── Outputs ─────────────────────────────────────────────────────────────────────────

fn list_name(list: &str) -> &'static str {
    match list {
        "abstract" => "PRISMA 2020 for Abstracts",
        "scr" => "PRISMA-ScR",
        "lsr" => "PRISMA-LSR additions",
        "prismas" => "PRISMA-S",
        _ => "PRISMA 2020",
    }
}

pub const ATTRIBUTION: &str = "Checklist structure (item numbers, topics and order) from PRISMA 2020: Page MJ, McKenzie JE, Bossuyt PM, et al. The PRISMA 2020 statement: an updated guideline for reporting systematic reviews. BMJ 2021;372:n71, distributed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); see https://www.prisma-statement.org. Item descriptions are Key's paraphrases, not the official wording.";

impl Checklist {
    pub fn lists(&self) -> Vec<(&'static str, &Vec<Item>)> {
        let mut v = vec![(if self.kind == "scoping" { "scr" } else { "prisma2020" }, &self.main), ("abstract", &self.abstract_items)];
        if !self.extra.is_empty() {
            v.push(("lsr", &self.extra));
        }
        v.push(("prismas", &self.prismas));
        v
    }

    pub fn json(&self) -> Json {
        let count = |items: &Vec<Item>| {
            let mut m = serde_json::Map::new();
            for s in ["evidenced", "partly", "missing", "na", "notRecorded"] {
                m.insert(s.into(), json!(items.iter().filter(|i| i.status == s).count()));
            }
            Json::Object(m)
        };
        json!({
            "kind": self.kind,
            "lists": self.lists().iter().map(|(id, items)| json!({ "id": id, "name": list_name(id), "items": items, "counts": count(items) })).collect::<Vec<_>>(),
            "methods": self.methods,
            "results": self.results,
            "software": software(),
            "attribution": ATTRIBUTION,
        })
    }

    /// The filled checklist (DOCX-friendly Markdown): every list in the official order.
    pub fn markdown(&self, state: &State) -> String {
        let mut out = format!("# Reporting checklist: {}\n\nFilled from the review in {} on {}.\n\n", state.info.name, software(), date(crate::events::now_ms()));
        for (id, items) in self.lists() {
            out.push_str(&format!("## {}\n\n| Section and topic | Item | Checklist item | Status | Where reported | Evidence or draft |\n| --- | --- | --- | --- | --- | --- |\n", list_name(id)));
            for i in items {
                let location = i.note.as_ref().map(|n| n.location.trim().to_string()).unwrap_or_default();
                let evidence = i.draft.clone().unwrap_or_else(|| i.rule.clone());
                out.push_str(&format!("| {} – {} | {} | {} | {} | {} | {} |\n", md_cell(&i.section), md_cell(&i.topic), i.id, md_cell(&i.text), status_label(&i.status), md_cell(&location), md_cell(&evidence)));
            }
            out.push('\n');
        }
        out.push_str(&format!("{ATTRIBUTION} PRISMA-S: Rethlefsen ML, et al. Syst Rev 2021;10:39 (CC BY 4.0). PRISMA-ScR: Tricco AC, et al. Ann Intern Med 2018;169:467–73 (paraphrased).\n"));
        out
    }

    pub fn csv(&self) -> String {
        let mut out = crate::report_text::csv_line(&["Checklist", "Section", "Topic", "Item", "Checklist item (paraphrased)", "Status", "Rule", "Where reported", "Notes", "Draft"].map(String::from));
        for (id, items) in self.lists() {
            for i in items {
                let (loc, text) = i.note.as_ref().map(|n| (n.location.clone(), n.text.clone())).unwrap_or_default();
                out.push_str(&crate::report_text::csv_line(&[list_name(id).into(), i.section.clone(), i.topic.clone(), i.id.clone(), i.text.clone(), status_label(&i.status).into(), i.rule.clone(), loc, text, i.draft.clone().unwrap_or_default()]));
            }
        }
        out.push_str(&crate::report_text::csv_line(&[ATTRIBUTION.into()]));
        out
    }

    pub fn methods_markdown(&self, state: &State) -> String {
        format!("# Methods (draft)\n\nDrafted by {} from the review “{}” on {}. Check every sentence against what was done, and replace “Supplementary file X”.\n\n## Methods\n\n{}## Results: study selection\n\n{}\n", software(), state.info.name, date(crate::events::now_ms()), self.methods, if self.results.is_empty() { "No records yet.".into() } else { self.results.clone() })
    }
}

impl Reviews {
    pub fn checklist(&self, review: &str, strategies: &std::collections::HashMap<String, Json>) -> Result<Json> {
        self.read(review, |state, _| Ok(compute(state, strategies).json()))
    }

    /// Where the manuscript reports an item, and notes (empty both: removed).
    pub fn checklist_note(&self, review: &str, list: &str, item: &str, location: &str, text: &str, actor: &str) -> Result<()> {
        if !["prisma2020", "abstract", "scr", "lsr", "prismas"].contains(&list) || item.trim().is_empty() {
            return Err("Unknown checklist item".into());
        }
        self.write(review, |_, _, b| Ok((vec![b.event("checklist.note", actor, None, json!({ "list": list, "item": item, "location": location.trim(), "text": text.trim() }))], ())))
    }
}
