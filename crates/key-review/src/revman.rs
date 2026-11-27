// RevMan Web's study-data import (Cochrane RevMan knowledge base, "Import study data from
// CSV" and the "Data package specification", read 2026-11-27): three required CSVs (Study
// information, Study arms, Study results; the optional Risk of bias file is left to the RoB
// assessments), comma-delimited UTF-8, one row per study (information), per arm (arms) and per
// study, outcome and arm (results), plus a RIS of the references with the Study ID in NS
// (import the RIS first). Names must match exactly across files and RevMan's set-up, and the
// characters ( ) # / < > can make an import fail, so names are cleaned and the validator lists
// what RevMan would reject.
//
// Verified from public pages: the file set, encoding and delimiter, the matching rules, the
// Study information and Study arms columns, the first six Study results columns (Study,
// Outcome, Data type, Effect measure, Arm, Reference arm), and the effect-measure codes of
// Cochrane's published JSON schema (LOG_RR, LOG_OR, RD, MD, SMD, LOG_HR, LOG_RATE_RATIO). The
// remaining Study results columns follow the data package specification (RevMan's export), which
// the import is documented to mirror; the official .xlsx templates were not downloaded.
use crate::export::{csv_cell, outcome_rows, outcomes, resolved_value, study_data, study_label};
use crate::interop::OutFile;
use crate::meta::{Measure, effect};
use crate::migrate::csv_rows;
use crate::store::{Result, Reviews, metas};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const INFO_HEAD: [&str; 10] = ["Study", "Year", "Allocation method", "Data source", "ID: DOI", "Char: Methods", "Char: Participants", "Char: Interventions", "Char: Outcomes", "Char: Notes"];
pub const ARMS_HEAD: [&str; 4] = ["Study", "Arm", "Description", "Intervention"];
pub const RESULTS_HEAD: [&str; 40] = [
    "Study", "Outcome", "Data type", "Effect measure", "Arm", "Reference arm", "Sample size", "Cases", "Mean", "SD", "SE", "Variance", "CI level", "CI start", "CI end", "Exp mean", "Exp CI start", "Exp CI end", "t-test", "z-test", "P value", "Covariance method", "Covariance", "Other arm 1", "Other arm 2", "Correlation arm 1", "Correlation arm 2", "Correlation", "Other mean", "Other SE",
    "Other variance", "Other CI level", "Other CI start", "Other CI end", "Other exp mean", "Other exp CI start", "Other exp CI end", "Other t-test", "Other z-test", "Other P value",
];

fn results_head() -> Vec<&'static str> {
    RESULTS_HEAD.iter().copied().filter(|h| !h.is_empty()).collect()
}

/// Names RevMan can take: without ( ) # / < > and with single spaces.
pub fn clean(name: &str) -> String {
    let s: String = name.chars().map(|c| if "()#/<>".contains(c) { ' ' } else { c }).collect();
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn line(cells: &[String]) -> String {
    let mut l = cells.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(",");
    l.push_str("\r\n");
    l
}

fn fmt(v: Option<f64>) -> String {
    v.filter(|x| x.is_finite()).map(|x| format!("{x}")).unwrap_or_default()
}

/// RevMan's effect-measure code for a Key measure.
pub fn measure_code(m: &str) -> &'static str {
    match m.to_ascii_uppercase().as_str() {
        "RR" => "LOG_RR",
        "OR" => "LOG_OR",
        "RD" => "RD",
        "MD" => "MD",
        "SMD" => "SMD",
        "HR" => "LOG_HR",
        "IRR" => "LOG_RATE_RATIO",
        _ => "OTHER",
    }
}

fn field_text(state: &crate::derive::State, record: &str, labels: &[&str]) -> String {
    for form in &state.protocol.forms {
        for f in form.fields() {
            let l = f.label.to_lowercase();
            if labels.iter().any(|x| l == *x || l.starts_with(x)) {
                if let Some((v, _)) = resolved_value(state, record, &form.id, &f.id) {
                    let t = match v {
                        serde_json::Value::String(s) => s,
                        serde_json::Value::Array(a) => a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect::<Vec<_>>().join("; "),
                        serde_json::Value::Null => String::new(),
                        other => other.to_string(),
                    };
                    if !t.trim().is_empty() {
                        return t;
                    }
                }
            }
        }
    }
    String::new()
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub file: String,
    /// 1-based data row (0: the file).
    pub row: usize,
    pub study: String,
    pub message: String,
    /// "error": RevMan rejects it; "warning": it may.
    pub severity: String,
}

/// Checks the three CSVs against RevMan Web's documented import rules.
pub fn validate(info: &str, arms: &str, results: &str) -> Vec<Problem> {
    let mut out = Vec::new();
    let mut p = |file: &str, row: usize, study: &str, msg: String, sev: &str| out.push(Problem { file: file.into(), row, study: study.into(), message: msg, severity: sev.into() });
    let parse = |t: &str| -> Vec<Vec<String>> { csv_rows(t) };
    let (i, a, r) = (parse(info), parse(arms), parse(results));
    for (name, rows, head) in [("Study information", &i, INFO_HEAD.to_vec()), ("Study arms", &a, ARMS_HEAD.to_vec()), ("Study results", &r, results_head())] {
        match rows.first() {
            None => p(name, 0, "", "The file is empty".into(), "error"),
            Some(h) => {
                for (k, col) in head.iter().enumerate() {
                    if h.get(k).map(|x| x.trim_start_matches('\u{feff}')) != Some(*col) {
                        p(name, 0, "", format!("Column {} should be \"{col}\"", k + 1), "error");
                        break;
                    }
                }
            }
        }
    }
    for t in [info, arms, results] {
        if t.lines().next().is_some_and(|h| h.contains(';') && !h.contains(',')) {
            p("", 0, "", "Use commas between columns (RevMan reads only comma-delimited files)".into(), "error");
        }
    }
    let studies: BTreeSet<String> = i.iter().skip(1).filter_map(|x| x.first().cloned()).collect();
    let mut seen = BTreeSet::new();
    for (n, row) in i.iter().enumerate().skip(1) {
        let s = row.first().cloned().unwrap_or_default();
        if s.trim().is_empty() {
            p("Study information", n, "", "A study needs a Study ID".into(), "error");
        }
        if !seen.insert(s.clone()) {
            p("Study information", n, &s, "The same Study ID appears twice".into(), "error");
        }
        if s != s.trim() || s.contains("  ") {
            p("Study information", n, &s, "Extra spaces in the Study ID (RevMan matches names exactly)".into(), "error");
        }
        if s.contains(['(', ')', '#', '/', '<', '>']) {
            p("Study information", n, &s, "Characters ( ) # / < > can make RevMan's import fail".into(), "error");
        }
        let year = row.get(1).cloned().unwrap_or_default();
        if !year.is_empty() && !(year.len() >= 4 && year[..4].chars().all(|c| c.is_ascii_digit()) && year[4..].chars().all(|c| c.is_ascii_lowercase())) {
            p("Study information", n, &s, format!("Year \"{year}\" should look like 2020 or 2020b"), "error");
        }
        let alloc = row.get(2).cloned().unwrap_or_default();
        if alloc.is_empty() {
            p("Study information", n, &s, "No allocation method (RCT, QRCT or NRSI): set it in RevMan or add a \"Study design\" field".into(), "warning");
        } else if !["RCT", "QRCT", "NRSI"].contains(&alloc.as_str()) {
            p("Study information", n, &s, format!("Allocation method \"{alloc}\" must be RCT, QRCT or NRSI"), "error");
        }
        let src = row.get(3).cloned().unwrap_or_default();
        if !src.is_empty() && !["PUB", "MIX", "UNPUB", "SOUGHT"].contains(&src.as_str()) {
            p("Study information", n, &s, format!("Data source \"{src}\" must be PUB, MIX, UNPUB or SOUGHT"), "error");
        }
    }
    let mut arm_names: HashMap<String, BTreeSet<String>> = HashMap::new();
    for (n, row) in a.iter().enumerate().skip(1) {
        let s = row.first().cloned().unwrap_or_default();
        let arm = row.get(1).cloned().unwrap_or_default();
        if !studies.contains(&s) {
            p("Study arms", n, &s, "This Study ID is not in the study information file".into(), "error");
        }
        if arm.trim().is_empty() {
            p("Study arms", n, &s, "An arm needs a name".into(), "error");
        }
        if arm.contains(['(', ')', '#', '/', '<', '>']) {
            p("Study arms", n, &s, "Characters ( ) # / < > can make RevMan's import fail".into(), "error");
        }
        arm_names.entry(s).or_default().insert(arm);
    }
    let col = |name: &str| results_head().iter().position(|h| *h == name).unwrap_or(0);
    let (c_out, c_type, c_meas, c_arm, c_ref, c_n, c_cases, c_mean, c_sd, c_se, c_cil, c_cis, c_cie) = (col("Outcome"), col("Data type"), col("Effect measure"), col("Arm"), col("Reference arm"), col("Sample size"), col("Cases"), col("Mean"), col("SD"), col("SE"), col("CI level"), col("CI start"), col("CI end"));
    let mut measure_of: HashMap<(String, String), String> = HashMap::new();
    let mut kind_of: HashMap<String, String> = HashMap::new();
    let mut refs: BTreeMap<(String, String), usize> = BTreeMap::new();
    let num = |row: &Vec<String>, k: usize| row.get(k).and_then(|x| x.trim().parse::<f64>().ok());
    for (n, row) in r.iter().enumerate().skip(1) {
        let s = row.first().cloned().unwrap_or_default();
        let get = |k: usize| row.get(k).cloned().unwrap_or_default();
        let (outcome, kind, meas, arm, reference) = (get(c_out), get(c_type), get(c_meas), get(c_arm), get(c_ref));
        if !studies.contains(&s) {
            p("Study results", n, &s, "This Study ID is not in the study information file".into(), "error");
        }
        if !arm_names.get(&s).is_some_and(|x| x.contains(&arm)) {
            p("Study results", n, &s, format!("Arm \"{arm}\" is not in the study arms file for this study"), "error");
        }
        if outcome.trim().is_empty() {
            p("Study results", n, &s, "A result needs an outcome name".into(), "error");
        }
        if outcome.contains(['(', ')', '#', '/', '<', '>']) {
            p("Study results", n, &s, "Characters ( ) # / < > in the outcome name can make RevMan's import fail".into(), "error");
        }
        if !["Arm Level", "Contrast Level"].contains(&kind.as_str()) {
            p("Study results", n, &s, format!("Data type \"{kind}\" should be Arm Level or Contrast Level"), "error");
        }
        if !["LOG_OR", "LOG_RR", "LOG_HR", "LOG_RATE_RATIO", "RD", "MD", "SMD", "OTHER"].contains(&meas.as_str()) {
            p("Study results", n, &s, format!("Effect measure \"{meas}\" is not one of RevMan's codes"), "error");
        }
        if let Some(prev) = measure_of.insert((s.clone(), outcome.clone()), meas.clone())
            && prev != meas
        {
            p("Study results", n, &s, format!("Outcome \"{outcome}\" has two effect measures in this study ({prev} and {meas})"), "error");
        }
        let family = if num(row, c_cases).is_some() { "dichotomous" } else if num(row, c_mean).is_some() && num(row, c_sd).is_some() { "continuous" } else { "contrast" };
        if kind == "Arm Level" {
            if let Some(prev) = kind_of.insert(outcome.clone(), family.into())
                && prev != family
            {
                p("Study results", n, &s, format!("Outcome \"{outcome}\" mixes dichotomous and continuous data across studies"), "error");
            }
            let size = num(row, c_n);
            if !size.is_some_and(|x| x > 0.0) {
                p("Study results", n, &s, "Sample size missing or not above 0".into(), "error");
            }
            if let (Some(c), Some(sz)) = (num(row, c_cases), size)
                && (c < 0.0 || c > sz)
            {
                p("Study results", n, &s, "Cases must be between 0 and the sample size".into(), "error");
            }
            if family == "continuous" && num(row, c_sd).is_some_and(|x| x <= 0.0) {
                p("Study results", n, &s, "SD must be above 0".into(), "error");
            }
            if family == "contrast" {
                p("Study results", n, &s, "An arm-level row needs cases, or a mean and SD".into(), "error");
            }
        } else if reference != "TRUE" && num(row, c_mean).is_none() {
            p("Study results", n, &s, "A contrast needs its estimate in Mean".into(), "error");
        } else if reference != "TRUE" && num(row, c_se).is_none() && (num(row, c_cis).is_none() || num(row, c_cie).is_none()) {
            p("Study results", n, &s, "A contrast needs its SE or a confidence interval".into(), "error");
        }
        if let Some(l) = num(row, c_cil)
            && ![0.90, 0.95, 0.99].iter().any(|x| (x - l).abs() < 1e-9)
        {
            p("Study results", n, &s, "CI level must be 0.90, 0.95 or 0.99".into(), "error");
        }
        if reference == "TRUE" {
            *refs.entry((s.clone(), outcome.clone())).or_default() += 1;
        } else if reference != "FALSE" {
            p("Study results", n, &s, "Reference arm must be TRUE or FALSE".into(), "error");
        } else {
            refs.entry((s.clone(), outcome.clone())).or_default();
        }
    }
    for ((s, o), n) in refs {
        if n != 1 {
            p("Study results", 0, &s, format!("Outcome \"{o}\" needs exactly one reference arm (has {n})"), "error");
        }
    }
    out
}

impl Reviews {
    /// The RevMan Web import files and a README with the validation.
    pub fn revman_files(&self, review: &str) -> Result<Vec<OutFile>> {
        Ok(self.revman_build(review)?.0)
    }

    /// The files, and what was left out on the way (RevMan takes one result per study and outcome).
    fn revman_build(&self, review: &str) -> Result<(Vec<OutFile>, Vec<Problem>)> {
        self.read(review, |state, conn| {
            let mut notes: Vec<Problem> = Vec::new();
            let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
            let included = state.included();
            let ids: Vec<String> = included.iter().map(|r| r.id.clone()).collect();
            let m = metas(conn, review, &ids)?;
            // Study IDs: "Family 2020", with a/b for clashes.
            let mut sid: HashMap<String, String> = HashMap::new();
            let mut count: HashMap<String, usize> = HashMap::new();
            let raw_id = |r: &str| -> String {
                let meta = m.get(r);
                let label = study_label(state, meta, r);
                let from_field = state.protocol.forms.iter().flat_map(|f| f.fields().map(move |x| (f, x))).any(|(f, x)| x.id == "study_id" && resolved_value(state, r, &f.id, &x.id).is_some());
                if from_field {
                    return clean(&label);
                }
                let family = meta.and_then(|x| x.authors.first()).map(|a| a.split(',').next().unwrap_or(a).trim().to_string()).unwrap_or_else(|| "Study".into());
                clean(&format!("{family} {}", meta.and_then(|x| x.year).map(|y| y.to_string()).unwrap_or_default()))
            };
            for r in &included {
                *count.entry(raw_id(&r.id)).or_default() += 1;
            }
            let mut next: HashMap<String, u8> = HashMap::new();
            for r in &included {
                let base = raw_id(&r.id);
                let id = if count[&base] > 1 {
                    let n = next.entry(base.clone()).or_default();
                    *n += 1;
                    format!("{base}{}", (b'a' + *n - 1) as char)
                } else {
                    base
                };
                sid.insert(r.id.clone(), id);
            }
            let mut info = line(&INFO_HEAD.map(String::from));
            for r in &included {
                let meta = m.get(&r.id);
                let design = field_text(state, &r.id, &["study design", "design", "allocation"]).to_lowercase();
                let alloc = if design.contains("quasi") { "QRCT" } else if design.contains("random") || design.contains("rct") { "RCT" } else if design.is_empty() { "" } else { "NRSI" };
                let year = sid[&r.id].rsplit(' ').next().filter(|y| y.len() >= 4 && y[..4].chars().all(|c| c.is_ascii_digit())).map(String::from).or_else(|| meta.and_then(|x| x.year).map(|y| y.to_string())).unwrap_or_default();
                info.push_str(&line(&[
                    sid[&r.id].clone(),
                    year,
                    alloc.into(),
                    "PUB".into(),
                    meta.map(|x| x.doi.clone()).unwrap_or_default(),
                    field_text(state, &r.id, &["methods", "study design"]),
                    field_text(state, &r.id, &["participants", "population"]),
                    field_text(state, &r.id, &["interventions", "intervention"]),
                    field_text(state, &r.id, &["outcomes"]),
                    field_text(state, &r.id, &["notes"]),
                ]));
            }
            let rows = outcome_rows(state, &m);
            let mut arms: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
            let mut results = line(&results_head().iter().map(|s| s.to_string()).collect::<Vec<_>>());
            let blank = results_head().len();
            let row_of = |cells: &[(&str, String)]| {
                let mut v = vec![String::new(); blank];
                for (k, val) in cells {
                    if let Some(i) = results_head().iter().position(|h| h == k) {
                        v[i] = val.clone();
                    }
                }
                line(&v)
            };
            for choice in outcomes(&rows) {
                let name = clean(&if choice.timepoint.is_empty() { choice.outcome.clone() } else { format!("{} - {}", choice.outcome, choice.timepoint) });
                for d in study_data(&rows, &choice.outcome, Some(&choice.timepoint)) {
                    let Some(study) = sid.get(&d.id).cloned() else { continue };
                    if !seen.insert((study.clone(), name.clone())) {
                        notes.push(Problem { file: "Study results".into(), row: 0, study: study.clone(), message: format!("Several estimates for \"{name}\": RevMan takes one result per study and outcome, so only the first was exported (rename the outcome in Key to keep the others)"), severity: "warning".into() });
                        continue;
                    }
                    let src = rows.iter().find(|x| x.record == d.id && Some(x.index) == d.row);
                    let g = |k: &str| src.and_then(|x| x.values.get(k)).and_then(|v| v.as_str()).map(clean).filter(|s| !s.is_empty());
                    let (a1, a2) = (g("group1").unwrap_or_else(|| "Intervention".into()), g("group2").unwrap_or_else(|| "Control".into()));
                    let reported = src.and_then(|x| x.values.get("measure")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let kind = choice.kind.as_str();
                    if kind == "dichotomous" && d.e1.is_some() {
                        let code = measure_code(if reported.is_empty() { "RR" } else { &reported });
                        let code = if ["LOG_RR", "LOG_OR", "RD"].contains(&code) { code } else { "LOG_RR" };
                        for (arm, e, n, reference) in [(&a1, d.e1, d.n1, "FALSE"), (&a2, d.e2, d.n2, "TRUE")] {
                            results.push_str(&row_of(&[("Study", study.clone()), ("Outcome", name.clone()), ("Data type", "Arm Level".into()), ("Effect measure", code.into()), ("Arm", arm.clone()), ("Reference arm", reference.into()), ("Sample size", fmt(n)), ("Cases", fmt(e))]));
                        }
                    } else if kind == "continuous" && d.m1.is_some() {
                        let code = if reported.eq_ignore_ascii_case("SMD") { "SMD" } else { "MD" };
                        for (arm, mean, sd, n, reference) in [(&a1, d.m1, d.sd1, d.n1, "FALSE"), (&a2, d.m2, d.sd2, d.n2, "TRUE")] {
                            results.push_str(&row_of(&[("Study", study.clone()), ("Outcome", name.clone()), ("Data type", "Arm Level".into()), ("Effect measure", code.into()), ("Arm", arm.clone()), ("Reference arm", reference.into()), ("Sample size", fmt(n)), ("Mean", fmt(mean)), ("SD", fmt(sd))]));
                        }
                    } else if let Ok(e) = effect(&d, Measure::GEN) {
                        let code = measure_code(&reported);
                        let ratio = d.ratio || code.starts_with("LOG_");
                        let code = if ratio && code == "OTHER" { "LOG_RR" } else { code };
                        let se = e.vi.sqrt();
                        let z = crate::stats::norm_quantile(0.975);
                        let mut cells = vec![("Study", study.clone()), ("Outcome", name.clone()), ("Data type", "Contrast Level".into()), ("Effect measure", code.into()), ("Arm", a1.clone()), ("Reference arm", "FALSE".into()), ("Mean", fmt(Some(e.yi))), ("SE", fmt(Some(se))), ("CI level", "0.95".into()), ("CI start", fmt(Some(e.yi - z * se))), ("CI end", fmt(Some(e.yi + z * se)))];
                        if ratio {
                            cells.push(("Exp mean", fmt(Some(e.yi.exp()))));
                            cells.push(("Exp CI start", fmt(Some((e.yi - z * se).exp()))));
                            cells.push(("Exp CI end", fmt(Some((e.yi + z * se).exp()))));
                        }
                        results.push_str(&row_of(&cells));
                        results.push_str(&row_of(&[("Study", study.clone()), ("Outcome", name.clone()), ("Data type", "Contrast Level".into()), ("Effect measure", code.into()), ("Arm", a2.clone()), ("Reference arm", "TRUE".into())]));
                    } else {
                        continue;
                    }
                    arms.entry(study.clone()).or_default().insert(a1);
                    arms.entry(study).or_default().insert(a2);
                }
            }
            let mut arms_csv = line(&ARMS_HEAD.map(String::from));
            for (s, names) in &arms {
                for a in names {
                    arms_csv.push_str(&line(&[s.clone(), a.clone(), String::new(), a.clone()]));
                }
            }
            let mut ris = String::new();
            for r in &included {
                if let Some(meta) = m.get(&r.id) {
                    let mut e = String::from("TY  - JOUR\n");
                    e.push_str(&format!("NS  - {}\n", sid[&r.id]));
                    for (t, v) in [("TI", meta.title.clone()), ("PY", meta.year.map(|y| y.to_string()).unwrap_or_default()), ("T2", meta.journal.clone()), ("VL", meta.volume.clone()), ("IS", meta.issue.clone()), ("SP", meta.pages.clone()), ("DO", meta.doi.clone()), ("C3", if meta.pmid.is_empty() { String::new() } else { format!("PMID {}", meta.pmid) })] {
                        if !v.is_empty() {
                            e.push_str(&format!("{t}  - {v}\n"));
                        }
                    }
                    for a in &meta.authors {
                        e.push_str(&format!("AU  - {a}\n"));
                    }
                    e.push_str("ER  - \n\n");
                    ris.push_str(&e);
                }
            }
            let mut problems = validate(&info, &arms_csv, &results);
            problems.extend(notes.iter().cloned());
            let mut readme = String::from("RevMan Web import files exported by Key\r\n\r\n1. In RevMan Web, switch on study-centric data management.\r\n2. Studies > Action > Import study references: import references.ris first (NS holds the Study ID), so studies are not created twice.\r\n3. Dashboard > Import study data > Import from CSV: upload study-information.csv, study-arms.csv and study-results.csv.\r\n   Outcome, arm and intervention names must match your review's set-up exactly; rename them in RevMan or in these files before importing.\r\n\r\nThe column layout follows RevMan's published import documentation and data package specification. Cochrane's own Excel templates were not available to check against, so if RevMan reports a column it does not expect, compare with its current template.\r\n\r\n");
            if problems.is_empty() {
                readme.push_str("Validation: no problems found.\r\n");
            } else {
                readme.push_str(&format!("Validation: {} problem(s):\r\n", problems.len()));
                for p in &problems {
                    readme.push_str(&format!("- [{}] {} row {}{}: {}\r\n", p.severity, p.file, p.row, if p.study.is_empty() { String::new() } else { format!(" ({})", p.study) }, p.message));
                }
            }
            let bom = |s: String| format!("\u{feff}{s}");
            Ok((
                vec![
                    OutFile::text("study-information.csv", bom(info)),
                    OutFile::text("study-arms.csv", bom(arms_csv)),
                    OutFile::text("study-results.csv", bom(results)),
                    OutFile::text("references.ris", ris),
                    OutFile::text("README.txt", readme),
                ],
                notes,
            ))
        })
    }

    pub fn revman_check(&self, review: &str) -> Result<Vec<Problem>> {
        let (files, notes) = self.revman_build(review)?;
        let text = |name: &str| files.iter().find(|f| f.path == name).map(|f| String::from_utf8_lossy(&f.bytes).trim_start_matches('\u{feff}').to_string()).unwrap_or_default();
        let mut out = validate(&text("study-information.csv"), &text("study-arms.csv"), &text("study-results.csv"));
        out.extend(notes);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validator_reports_what_revman_rejects() {
        let info = format!("{}\nSmith 2020,2020,RCT,PUB,,,,,,\nLee (2019),2019,XYZ,PUB,,,,,,\n", INFO_HEAD.join(","));
        let arms = format!("{}\nSmith 2020,Diet,,Diet\nSmith 2020,Control,,Control\n", ARMS_HEAD.join(","));
        let h = results_head().join(",");
        let pad = |cells: &[&str]| {
            let mut v: Vec<String> = cells.iter().map(|s| s.to_string()).collect();
            v.resize(results_head().len(), String::new());
            v.join(",")
        };
        let results = format!("{h}\n{}\n{}\n{}\n", pad(&["Smith 2020", "Weight", "Arm Level", "LOG_RR", "Diet", "FALSE", "30", "40"]), pad(&["Smith 2020", "Weight", "Arm Level", "MD", "Control", "FALSE", "30", "4"]), pad(&["Jones 2018", "Weight", "Arm Level", "MD", "Diet", "TRUE", "30", "4"]));
        let p = validate(&info, &arms, &results);
        let msgs: Vec<&str> = p.iter().map(|x| x.message.as_str()).collect();
        assert!(msgs.iter().any(|m| m.contains("( ) # / < >")), "{msgs:?}");
        assert!(msgs.iter().any(|m| m.contains("must be RCT, QRCT or NRSI")));
        assert!(msgs.iter().any(|m| m.contains("Cases must be between 0")));
        assert!(msgs.iter().any(|m| m.contains("two effect measures")));
        assert!(msgs.iter().any(|m| m.contains("not in the study information file")));
        assert!(msgs.iter().any(|m| m.contains("exactly one reference arm")));
        assert_eq!(clean("Pain (VAS) / 6 weeks"), "Pain VAS 6 weeks");
    }
}
