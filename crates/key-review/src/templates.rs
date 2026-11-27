// What a new review starts with, and the extraction form templates. Risk of bias has its own
// stage and tools (rob.rs); it is no longer offered as an extraction form.
use crate::model::*;

fn field(id: &str, label: &str, kind: &str) -> Field {
    Field { id: id.into(), label: label.into(), kind: kind.into(), ..Default::default() }
}

fn choice(id: &str, label: &str, options: &[&str]) -> Field {
    Field { options: options.iter().map(|s| s.to_string()).collect(), ..field(id, label, "choice") }
}

fn guided(mut f: Field, guidance: &str) -> Field {
    f.guidance = guidance.into();
    f
}

fn section(id: &str, title: &str, fields: Vec<Field>) -> Section {
    Section { id: id.into(), title: title.into(), guidance: String::new(), fields, show_when: None }
}

/// A suggested criterion: element, id, what a study must meet, the reason's wording, stages.
struct Suggestion {
    element: &'static str,
    id: &'static str,
    label: &'static str,
    reason: &'static str,
    guidance: &'static str,
    full_text_only: bool,
    /// The question part whose words become its guidance ("Include: …").
    part: Option<&'static str>,
}

const fn s(element: &'static str, id: &'static str, label: &'static str, reason: &'static str, guidance: &'static str, part: Option<&'static str>) -> Suggestion {
    Suggestion { element, id, label, reason, guidance, full_text_only: false, part }
}

const SUGGESTIONS: &[Suggestion] = &[
    s("population", "c-population", "Population as in the question", "Wrong population", "Participants and setting the question is about.", Some("p")),
    s("intervention", "c-intervention", "Intervention as in the question", "Wrong intervention", "", Some("i")),
    s("exposure", "c-exposure", "Exposure as in the question", "Wrong exposure", "", Some("e")),
    s("comparator", "c-comparator", "Comparator as in the question", "Wrong comparator", "", Some("c")),
    s("outcome", "c-outcome", "Reports an outcome of interest", "Wrong outcome", "", Some("o")),
    s("sample", "c-sample", "Sample as in the question", "Wrong sample", "", Some("s")),
    s("phenomenon", "c-phenomenon", "Phenomenon of interest as in the question", "Wrong phenomenon of interest", "", Some("pi")),
    s("evaluation", "c-evaluation", "Evaluation as in the question", "Wrong evaluation", "", Some("e")),
    s("research", "c-research", "Research type as in the question", "Wrong research type", "", Some("r")),
    s("design", "c-design", "An eligible study design", "Wrong study design", "Say which designs count, for example randomised controlled trials.", Some("d")),
    s("other", "c-language", "In an included language", "Not in an included language", "Languages the team can read or translate.", None),
    s("other", "c-dates", "Within the date range", "Outside the date range", "", None),
    s("other", "c-publication", "An eligible publication type", "Wrong publication type", "Not an editorial, comment, letter, protocol or conference abstract alone.", None),
    s("other", "c-duplicate", "Not a duplicate report", "Duplicate", "Another report of a study already in the review.", None),
    Suggestion { element: "other", id: "c-fulltext", label: "Full text available", reason: "Full text not available", guidance: "", full_text_only: true, part: None },
];

fn criterion_of(x: &Suggestion, parts: &std::collections::BTreeMap<String, String>, framework: &str) -> Criterion {
    // SPIDER's "d" is the design part; PICO has none.
    let part = x.part.filter(|p| !(*p == "d" && framework != "spider")).and_then(|p| parts.get(p)).map(|t| t.trim()).filter(|t| !t.is_empty());
    Criterion {
        id: x.id.into(),
        element: x.element.into(),
        label: x.label.into(),
        reason: x.reason.into(),
        guidance: match part {
            Some(text) => format!("Include: {text}"),
            None => x.guidance.into(),
        },
        stages: if x.full_text_only { vec![Stage::Ft] } else { vec![Stage::Ta, Stage::Ft] },
        ..Default::default()
    }
}

/// Criteria to start from for a question: one per part of its framework, then the usual others
/// (language, dates, publication type, duplicates, full text). Each carries the question's own
/// words as guidance when they were filled in.
pub fn suggested_criteria(question: &Question) -> Vec<Criterion> {
    let wanted = elements_of(&question.framework);
    let mut out: Vec<Criterion> = Vec::new();
    for element in wanted {
        for x in SUGGESTIONS.iter().filter(|x| x.element == *element) {
            out.push(criterion_of(x, &question.parts, &question.framework));
        }
    }
    out
}

/// The question element an old default reason belonged to.
pub fn legacy_element(reason_id: &str) -> &'static str {
    match reason_id {
        "r-design" => "design",
        "r-population" => "population",
        "r-intervention" => "intervention",
        "r-comparator" => "comparator",
        "r-outcome" => "outcome",
        _ => "other",
    }
}

/// An old reason no criterion named, as a criterion: Key's own defaults become their suggested
/// criteria; any other keeps its wording as the reason.
pub fn legacy_criterion(r: &LegacyReason) -> Criterion {
    let known = match r.id.as_str() {
        "r-design" => Some("c-design"),
        "r-population" => Some("c-population"),
        "r-intervention" => Some("c-intervention"),
        "r-comparator" => Some("c-comparator"),
        "r-outcome" => Some("c-outcome"),
        "r-publication" => Some("c-publication"),
        "r-duplicate" => Some("c-duplicate"),
        "r-language" => Some("c-language"),
        _ => None,
    };
    let stages = if r.stages.is_empty() { vec![Stage::Ta, Stage::Ft] } else { r.stages.clone() };
    if let Some(x) = known.and_then(|id| SUGGESTIONS.iter().find(|x| x.id == id)) {
        // Keep the wording the team used ("Wrong outcomes"), and its guidance if it had one.
        return Criterion {
            reason: r.label.clone(),
            guidance: if r.guidance.is_empty() { x.guidance.into() } else { r.guidance.clone() },
            stages,
            ..criterion_of(x, &Default::default(), "pico")
        };
    }
    let label = if r.id == "r-other" { "No other reason to exclude".to_string() } else { r.label.clone() };
    Criterion { id: format!("c-{}", r.id.trim_start_matches("r-")), element: "other".into(), label, reason: r.label.clone(), guidance: r.guidance.clone(), stages, ..Default::default() }
}

pub fn default_protocol() -> Protocol {
    Protocol {
        question: Question::default(),
        registration: String::new(),
        notes: String::new(),
        rules: Rules::default(),
        criteria: Vec::new(),
        reasons: Vec::new(),
        keywords: Keywords::default(),
        labels: vec!["Background".into(), "Check later".into()],
        label_keys: [("Background".to_string(), "b".to_string()), ("Check later".to_string(), "l".to_string())].into_iter().collect(),
        forms: vec![characteristics_form()],
        shortcuts: Default::default(),
        plan: Default::default(),
    }
}

pub fn characteristics_form() -> Form {
    Form {
        id: "f-characteristics".into(),
        name: "Study characteristics".into(),
        kind: "characteristics".into(),
        sections: vec![
            section(
                "s-identification",
                "Identification",
                vec![
                    field("study_id", "Study ID", "text"),
                    guided(field("country", "Country or countries", "text"), "Where participants were recruited."),
                    field("funding", "Funding source", "longtext"),
                ],
            ),
            section(
                "s-methods",
                "Methods",
                vec![
                    Field { role: "subgroup".into(), ..choice("design", "Study design", &["Randomised controlled trial", "Cluster randomised trial", "Non-randomised trial", "Cohort", "Case-control", "Cross-sectional", "Other"]) },
                    field("setting", "Setting", "text"),
                    field("start", "Start of recruitment", "date"),
                    Field { unit: "months".into(), ..field("followup", "Length of follow-up", "number") },
                ],
            ),
            section(
                "s-participants",
                "Participants",
                vec![
                    field("n_total", "Participants randomised or enrolled", "number"),
                    Field { unit: "years".into(), ..field("age", "Mean or median age", "number") },
                    field("inclusion", "Inclusion criteria as reported", "longtext"),
                ],
            ),
            section(
                "s-interventions",
                "Interventions",
                vec![Field {
                    columns: vec![field("arm", "Arm", "text"), field("description", "Description", "longtext"), field("n", "Participants", "number")],
                    ..guided(field("arms", "Arms", "table"), "One row per arm or group.")
                }],
            ),
        ],
    }
}

/// The columns of an outcome-data table, in the ids the meta-analysis reads.
pub fn outcome_columns() -> Vec<Field> {
    vec![
        field("outcome", "Outcome", "text"),
        field("timepoint", "Time point", "text"),
        field("unit", "Unit", "text"),
        choice("type", "Data type", &["Dichotomous", "Continuous", "Generic", "Correlation", "Proportion", "Rate"]),
        field("group1", "Intervention group", "text"),
        field("group2", "Comparison group", "text"),
        field("e1", "Events (intervention)", "number"),
        field("n1", "Total (intervention)", "number"),
        field("e2", "Events (comparison)", "number"),
        field("n2", "Total (comparison)", "number"),
        field("m1", "Mean (intervention)", "number"),
        field("sd1", "SD (intervention)", "number"),
        field("m2", "Mean (comparison)", "number"),
        field("sd2", "SD (comparison)", "number"),
        choice("measure", "Reported effect measure", &["RR", "OR", "RD", "HR", "MD", "SMD", "IRR", "Partial correlation", "Elasticity", "Other"]),
        field("estimate", "Reported estimate", "number"),
        field("lower", "Lower 95% CI", "number"),
        field("upper", "Upper 95% CI", "number"),
        field("se", "Standard error", "number"),
        // std-D: correlations, regression t statistics, person-time.
        field("r", "Correlation (r)", "number"),
        field("t", "t statistic", "number"),
        field("df", "Degrees of freedom", "number"),
        field("time1", "Person-time (intervention)", "number"),
        field("time2", "Person-time (comparison)", "number"),
    ]
}

pub fn outcomes_form() -> Form {
    Form {
        id: "f-outcomes".into(),
        name: "Outcome data".into(),
        kind: "outcomes".into(),
        sections: vec![Section { show_when: None,
            id: "s-outcomes".into(),
            title: "Outcomes".into(),
            guidance: "One row per outcome and time point. Dichotomous: events and totals per group. Continuous: mean, SD and number per group. Generic: an estimate with its standard error or 95% interval (ratios as ratios)."
                .into(),
            fields: vec![Field { columns: outcome_columns(), role: "outcomes".into(), quote: true, ..field("outcomes", "Outcome data", "table") }],
        }],
    }
}

fn domain(id: &str, title: &str, options: &[&str]) -> Section {
    Section { show_when: None,
        id: format!("s-{id}"),
        title: title.into(),
        guidance: String::new(),
        fields: vec![choice(&format!("{id}_judgement"), "Judgement", options), Field { quote: true, ..field(&format!("{id}_support"), "Support for judgement", "longtext") }],
    }
}

/// The shape of the risk-of-bias extraction form older reviews used (a judgement and its
/// support per domain), kept so tests can build such a review; risk of bias now has its own
/// stage (rob.rs), which brings these answers in. Domain labels are Key's own.
pub fn rob2_form() -> Form {
    let o = &["Low risk", "Some concerns", "High risk"];
    Form {
        id: "f-rob2".into(),
        name: "Risk of bias (randomised trials)".into(),
        kind: "rob".into(),
        sections: vec![
            domain("d1", "Randomisation", o),
            domain("d2", "Deviations from the planned intervention", o),
            domain("d3", "Missing outcome data", o),
            domain("d4", "Outcome measurement", o),
            domain("d5", "Choice of the reported result", o),
            domain("overall", "Overall", o),
        ],
    }
}

/// The templates the form builder offers.
pub fn form_templates() -> Vec<Form> {
    vec![characteristics_form(), outcomes_form(), Form { id: "f-custom".into(), name: "Custom form".into(), kind: "custom".into(), sections: vec![section("s-1", "Section 1", vec![field("field_1", "Field 1", "text")])] }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_templates_validate() {
        let mut p = default_protocol();
        p.validate().unwrap();
        p.forms = form_templates();
        p.forms.last_mut().unwrap().id = "f-custom-1".into();
        p.validate().unwrap();
        assert!(outcomes_form().fields().any(|f| f.role == "outcomes"));
    }

    #[test]
    fn suggestions_follow_the_question() {
        let mut q = Question::default();
        q.parts.insert("p".into(), "adults with type 2 diabetes".into());
        let c = suggested_criteria(&q);
        assert_eq!(c[0].element, "population");
        assert_eq!(c[0].guidance, "Include: adults with type 2 diabetes");
        assert!(c.iter().any(|c| c.id == "c-intervention") && !c.iter().any(|c| c.id == "c-exposure"));
        assert_eq!(c.last().unwrap().stages, vec![Stage::Ft]);
        q.framework = "spider".into();
        assert_eq!(suggested_criteria(&q)[0].element, "sample");
        let mut p = default_protocol();
        p.criteria = suggested_criteria(&Question::default());
        p.validate().unwrap();
        assert_eq!(p.top_reason(&["c-language".into(), "c-population".into()]).unwrap(), "c-population");
    }
}
