// What a new review starts with, and the extraction form templates. The risk-of-bias templates
// follow the domains of RoB 2, ROBINS-I and the Newcastle–Ottawa scale with Key's own short
// summaries: they are editable starting points, not the instruments' text — reviewers should use
// the official guidance documents alongside them.
use crate::model::*;

fn reason(id: &str, label: &str, guidance: &str) -> Reason {
    Reason { id: id.into(), label: label.into(), guidance: guidance.into(), stages: Vec::new() }
}

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
    Section { id: id.into(), title: title.into(), guidance: String::new(), fields }
}

pub fn default_reasons() -> Vec<Reason> {
    vec![
        reason("r-design", "Wrong study design", "The design is not one the protocol includes."),
        reason("r-population", "Wrong population", "Participants or setting outside the protocol."),
        reason("r-intervention", "Wrong intervention or exposure", ""),
        reason("r-comparator", "Wrong comparator", ""),
        reason("r-outcome", "Wrong outcomes", "None of the protocol's outcomes is reported."),
        reason("r-publication", "Wrong publication type", "Editorial, comment, conference abstract only, protocol …"),
        reason("r-duplicate", "Duplicate report", "Another report of a study already included."),
        reason("r-language", "Language", "Written in a language the team cannot assess."),
        reason("r-other", "Other", "Say why in the note."),
    ]
}

pub fn default_protocol() -> Protocol {
    Protocol {
        question: Question::default(),
        registration: String::new(),
        notes: String::new(),
        rules: Rules::default(),
        criteria: Vec::new(),
        reasons: default_reasons(),
        keywords: Keywords::default(),
        labels: vec!["Background".into(), "Check later".into()],
        forms: vec![characteristics_form()],
        shortcuts: Default::default(),
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
        choice("type", "Data type", &["Dichotomous", "Continuous", "Generic"]),
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
        choice("measure", "Reported effect measure", &["RR", "OR", "RD", "HR", "MD", "SMD", "Other"]),
        field("estimate", "Reported estimate", "number"),
        field("lower", "Lower 95% CI", "number"),
        field("upper", "Upper 95% CI", "number"),
        field("se", "Standard error", "number"),
    ]
}

pub fn outcomes_form() -> Form {
    Form {
        id: "f-outcomes".into(),
        name: "Outcome data".into(),
        kind: "outcomes".into(),
        sections: vec![Section {
            id: "s-outcomes".into(),
            title: "Outcomes".into(),
            guidance: "One row per outcome and time point. Dichotomous: events and totals per group. Continuous: mean, SD and number per group. Generic: an estimate with its standard error or 95% interval (ratios as ratios)."
                .into(),
            fields: vec![Field { columns: outcome_columns(), role: "outcomes".into(), quote: true, ..field("outcomes", "Outcome data", "table") }],
        }],
    }
}

fn domain(id: &str, title: &str, summary: &str, options: &[&str]) -> Section {
    Section {
        id: format!("s-{id}"),
        title: title.into(),
        guidance: summary.into(),
        fields: vec![choice(&format!("{id}_judgement"), "Judgement", options), Field { quote: true, ..field(&format!("{id}_support"), "Support for judgement", "longtext") }],
    }
}

pub fn rob2_form() -> Form {
    let o = &["Low risk", "Some concerns", "High risk"];
    Form {
        id: "f-rob2".into(),
        name: "Risk of bias (RoB 2 style, randomised trials)".into(),
        kind: "rob".into(),
        sections: vec![
            domain("d1", "Randomisation process", "Was the allocation sequence random and concealed, and were groups similar at baseline?", o),
            domain("d2", "Deviations from intended interventions", "Did participants, carers or staff know the assignment, and did that change what people received in a way that could affect the result?", o),
            domain("d3", "Missing outcome data", "Were outcome data available for nearly everyone, or is there evidence that missingness did not bias the result?", o),
            domain("d4", "Measurement of the outcome", "Was the outcome measured appropriately and the same way in all groups, and could knowing the assignment have influenced it?", o),
            domain("d5", "Selection of the reported result", "Was the result chosen from several measurements or analyses on the basis of the findings?", o),
            domain("overall", "Overall", "Usually the least favourable judgement across domains.", o),
        ],
    }
}

pub fn robins_i_form() -> Form {
    let o = &["Low", "Moderate", "Serious", "Critical", "No information"];
    Form {
        id: "f-robins-i".into(),
        name: "Risk of bias (ROBINS-I style, non-randomised studies)".into(),
        kind: "rob".into(),
        sections: vec![
            domain("c1", "Confounding", "Could factors that predict both the intervention and the outcome explain the effect, and were they controlled for?", o),
            domain("c2", "Selection of participants", "Was entry into the study, or into the analysis, related to both intervention and outcome?", o),
            domain("c3", "Classification of interventions", "Were intervention groups clearly defined and recorded at the start, not from hindsight?", o),
            domain("c4", "Deviations from intended interventions", "Were there departures from the intended intervention beyond usual practice, and were they balanced?", o),
            domain("c5", "Missing data", "Were outcome, intervention or confounder data missing for a share of participants that could change the result?", o),
            domain("c6", "Measurement of outcomes", "Could the measurement have differed between groups, or been influenced by knowing the intervention?", o),
            domain("c7", "Selection of the reported result", "Was the reported result picked from several outcomes, analyses or subgroups?", o),
            domain("overall", "Overall", "Usually the most severe judgement across domains.", o),
        ],
    }
}

pub fn nos_form() -> Form {
    let star = &["Star", "No star", "Not reported"];
    let item = |id: &str, label: &str, guidance: &str| guided(choice(id, label, star), guidance);
    Form {
        id: "f-nos".into(),
        name: "Quality (Newcastle–Ottawa style, cohort studies)".into(),
        kind: "rob".into(),
        sections: vec![
            Section {
                id: "s-selection".into(),
                title: "Selection".into(),
                guidance: "Up to four stars.".into(),
                fields: vec![
                    item("sel_exposed", "Exposed cohort represents the target population", "A community or typical group rather than a select one."),
                    item("sel_nonexposed", "Non-exposed cohort from the same source", ""),
                    item("sel_exposure", "Exposure ascertained reliably", "Records or structured interview rather than self-report alone."),
                    item("sel_absent", "Outcome absent at the start", ""),
                ],
            },
            Section {
                id: "s-comparability".into(),
                title: "Comparability".into(),
                guidance: "Up to two stars: the most important factor, and any additional factor.".into(),
                fields: vec![choice("comparability", "Cohorts comparable by design or analysis", &["2 stars", "1 star", "No star"])],
            },
            Section {
                id: "s-outcome".into(),
                title: "Outcome".into(),
                guidance: "Up to three stars.".into(),
                fields: vec![
                    item("out_assessment", "Outcome assessed independently or from records", ""),
                    item("out_length", "Follow-up long enough for outcomes to occur", ""),
                    item("out_adequacy", "Follow-up complete, or losses unlikely to bias", ""),
                ],
            },
            Section { id: "s-total".into(), title: "Total".into(), guidance: String::new(), fields: vec![field("nos_total", "Total stars (0–9)", "number")] },
        ],
    }
}

/// The templates the form builder offers.
pub fn form_templates() -> Vec<Form> {
    vec![characteristics_form(), outcomes_form(), rob2_form(), robins_i_form(), nos_form(), Form { id: "f-custom".into(), name: "Custom form".into(), kind: "custom".into(), sections: vec![section("s-1", "Section 1", vec![field("field_1", "Field 1", "text")])] }]
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
        assert_eq!(p.top_reason(&["r-other".into(), "r-population".into()]).unwrap(), "r-population");
    }
}
