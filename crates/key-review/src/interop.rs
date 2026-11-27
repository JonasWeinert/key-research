// Exports others can import: an R script per analysis (rscript.rs), RevMan Web's study-data
// CSVs (revman.rs), lists of included and excluded studies (RIS, BibTeX, CSV with decisions), a
// replication bundle for OSF or a journal (one zip with a README and a manifest of SHA-256
// checksums; no upload), and the facts other parts of Key report (PRISMA items 13 and 27).
use crate::derive::{State, Status};
use crate::export::{AnalysisRequest, csv_cell, outcome_rows, study_data, study_label};
use crate::meta::Method;
use crate::model::*;
use crate::store::{Result, Reviews, all_metas, metas};
use crate::synthesis::{ModeratorRef, SynthesisRequest};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write as _;

pub const KEY_VERSION: &str = env!("CARGO_PKG_VERSION");

/// A saved analysis (`analysis.set` payload): the base request and, optionally, the advanced one.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AnalysisSpec {
    pub id: String,
    pub name: String,
    /// AnalysisRequest as JSON.
    pub request: Json,
    /// SynthesisRequest as JSON (outcome and options are taken from `request`).
    pub advanced: Json,
    pub deleted: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct OutFile {
    pub path: String,
    #[serde(skip)]
    pub bytes: Vec<u8>,
}

impl OutFile {
    pub fn text(path: impl Into<String>, text: impl Into<String>) -> OutFile {
        OutFile { path: path.into(), bytes: text.into().into_bytes() }
    }
}

pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn slug(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if s.is_empty() { "analysis".into() } else { s.chars().take(50).collect() }
}

fn line(cells: &[String]) -> String {
    let mut l = cells.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(",");
    l.push('\n');
    l
}

/// Saved analyses, newest last.
pub fn saved(state: &State) -> Vec<AnalysisSpec> {
    state.analyses.iter().filter_map(|a| serde_json::from_value::<AnalysisSpec>(a.clone()).ok()).filter(|a| !a.deleted && a.request.get("outcome").is_some()).collect()
}

fn synthesis_request(spec: &AnalysisSpec, base: &AnalysisRequest) -> Option<SynthesisRequest> {
    if spec.advanced.is_null() || spec.advanced.as_object().is_some_and(|o| o.is_empty()) {
        return None;
    }
    let mut r: SynthesisRequest = serde_json::from_value(spec.advanced.clone()).ok()?;
    r.outcome = base.outcome.clone();
    r.timepoint = base.timepoint.clone();
    r.options = base.options.clone();
    Some(r)
}

// ── PRISMA facts (for std-A's checklist) ──────────────────────────────────────────────

/// What the synthesis and sharing parts of a PRISMA 2020 report can say, from the saved
/// analyses and the conversions recorded in extraction.
pub fn reporting_facts(state: &State) -> Json {
    let specs = saved(state);
    let mut measures = Vec::new();
    let mut models = Vec::new();
    let mut sensitivity = Vec::new();
    let mut bias = vec!["Egger's regression test (reported with at least 10 studies)".to_string()];
    let mut metareg = false;
    let mut subgroups = false;
    for s in &specs {
        let Ok(base) = serde_json::from_value::<AnalysisRequest>(s.request.clone()) else { continue };
        let label = base.options.measure.label().to_string();
        if !measures.contains(&label) {
            measures.push(label);
        }
        let m = crate::synthesis::model_text(&base.options);
        if !models.contains(&m) {
            models.push(m);
        }
        subgroups |= base.subgroups;
        if let Some(adv) = synthesis_request(s, &base) {
            metareg |= adv.metareg.is_some();
            if let Some(d) = &adv.dependence {
                let t = match d.model.as_str() {
                    "aggregate" => format!("estimates within a study combined into one (assumed correlation {})", d.rho),
                    "three-level" => "a three-level random-effects model for several estimates per study".to_string(),
                    _ => format!("a correlated and hierarchical effects model with CR2 robust standard errors (assumed correlation {})", d.rho),
                };
                if !models.contains(&t) {
                    models.push(t);
                }
            }
            if let Some(b) = &adv.bias {
                for (on, name) in [(b.pet_peese, "PET-PEESE"), (!b.trim_fill.is_empty(), "trim and fill"), (b.selection, "a three-parameter selection model"), (b.uwls, "UWLS and WAAP")] {
                    if on && !bias.iter().any(|x| x == name) {
                        bias.push(name.to_string());
                    }
                }
            }
            if let Some(x) = &adv.sensitivity {
                for (on, name) in [(x.influence, "influence diagnostics"), (!x.cumulative.is_empty(), "cumulative meta-analysis"), (x.models, "fixed-effect versus random-effects models")] {
                    if on && !sensitivity.iter().any(|y| y == name) {
                        sensitivity.push(name.to_string());
                    }
                }
            }
        }
    }
    let conversions: Vec<String> = conversion_log(state).into_iter().map(|c| c.method).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    let statement = if specs.is_empty() {
        String::new()
    } else {
        let mut t = format!("Effects were expressed as {} and pooled with {} models", measures.join(", "), models.join("; "));
        if subgroups {
            t.push_str("; subgroups were pooled separately and compared with a test for subgroup differences");
        }
        if metareg {
            t.push_str("; meta-regression used REML with Knapp–Hartung tests");
        }
        t.push_str(&format!(". Small-study effects: {}.", bias.join(", ")));
        if !sensitivity.is_empty() {
            t.push_str(&format!(" Sensitivity analyses: {}.", sensitivity.join(", ")));
        }
        if !conversions.is_empty() {
            t.push_str(&format!(" Missing statistics were derived as follows: {}.", conversions.join("; ")));
        }
        t.push_str(&format!(" Analyses were run in Key {KEY_VERSION}, whose methods are validated against the R package metafor; an R script reproducing each analysis is provided."));
        t
    };
    json!({
        "analysis": {
            "statement": statement,
            "metaRegression": metareg,
            "sensitivity": sensitivity,
            "publicationBias": if specs.is_empty() { Vec::new() } else { bias },
            "conversions": conversions,
        },
        "sharing": {
            // Only once an analysis is saved: before that there is no analytic code to share.
            "statement": if specs.is_empty() { "" } else { "Data, analytic code (R scripts using metafor) and the review's audit trail are in the replication bundle exported from Key." },
            "rScript": !specs.is_empty(),
            "revman": true,
            "bundle": true,
        }
    })
}

// ── Conversions recorded in extraction ──────────────────────────────────────────────

/// Every conversion stored on outcome rows (`_conversions`), with the study and row.
pub fn conversion_log(state: &State) -> Vec<ConversionEntry> {
    let mut out = Vec::new();
    for r in state.included() {
        for form in &state.protocol.forms {
            for f in form.fields().filter(|f| f.role == "outcomes" && f.kind == "table") {
                let Some((Json::Array(rows), _)) = crate::export::resolved_value(state, &r.id, &form.id, &f.id) else { continue };
                for (i, row) in rows.iter().enumerate() {
                    for c in row.get("_conversions").and_then(Json::as_array).into_iter().flatten() {
                        out.push(ConversionEntry {
                            record: r.id.clone(),
                            row: i + 1,
                            outcome: row.get("outcome").and_then(Json::as_str).unwrap_or("").to_string(),
                            method: c.get("method").and_then(Json::as_str).unwrap_or("").to_string(),
                            formula: c.get("formula").and_then(Json::as_str).unwrap_or("").to_string(),
                            citation: c.get("citation").and_then(Json::as_str).unwrap_or("").to_string(),
                            inputs: c.get("inputs").cloned().unwrap_or(Json::Null),
                            fill: c.get("fill").cloned().unwrap_or(Json::Null),
                        });
                    }
                }
            }
        }
    }
    out
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionEntry {
    pub record: String,
    pub row: usize,
    pub outcome: String,
    pub method: String,
    pub formula: String,
    pub citation: String,
    pub inputs: Json,
    pub fill: Json,
}

fn conversions_csv(state: &State, metas: &std::collections::HashMap<String, RecordMeta>) -> String {
    let mut out = line(&["study", "record_id", "row", "outcome", "method", "formula", "source", "inputs", "values filled"].map(String::from));
    for c in conversion_log(state) {
        out.push_str(&line(&[study_label(state, metas.get(&c.record), &c.record), c.record.clone(), c.row.to_string(), c.outcome, c.method, c.formula, c.citation, compact(&c.inputs), compact(&c.fill)]));
    }
    out
}

fn compact(v: &Json) -> String {
    match v {
        Json::Object(o) => o.iter().map(|(k, v)| format!("{k}={}", v.as_f64().map(|x| format!("{x}")).unwrap_or_else(|| v.to_string()))).collect::<Vec<_>>().join("; "),
        Json::Null => String::new(),
        other => other.to_string(),
    }
}

// ── Studies: RIS, BibTeX, CSV with decisions ──────────────────────────────────────────

fn ris_entry(m: &RecordMeta, extra: &[(&str, String)]) -> String {
    let mut s = String::from("TY  - JOUR\n");
    let mut tag = |t: &str, v: &str| {
        if !v.trim().is_empty() {
            s.push_str(&format!("{t}  - {}\n", v.replace('\n', " ")));
        }
    };
    tag("TI", &m.title);
    for a in &m.authors {
        tag("AU", a);
    }
    tag("PY", &m.year.map(|y| y.to_string()).unwrap_or_default());
    tag("T2", &m.journal);
    tag("VL", &m.volume);
    tag("IS", &m.issue);
    tag("SP", &m.pages);
    tag("DO", &m.doi);
    tag("UR", &m.url);
    tag("AB", &m.abstract_text);
    for (t, v) in extra {
        tag(t, v);
    }
    s.push_str("ER  - \n\n");
    s
}

fn bib_key(m: &RecordMeta, used: &mut std::collections::HashSet<String>) -> String {
    let family: String = m.authors.first().map(|a| a.split(',').next().unwrap_or(a)).unwrap_or("anon").chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    let base = format!("{}{}", if family.is_empty() { "anon".into() } else { family }, m.year.map(|y| y.to_string()).unwrap_or_default());
    let mut key = base.clone();
    let mut i = 0;
    while !used.insert(key.clone()) {
        i += 1;
        key = format!("{base}{}", (b'a' + ((i - 1) % 26) as u8) as char);
    }
    key
}

fn bib_entry(m: &RecordMeta, key: &str, note: &str) -> String {
    let esc = |s: &str| s.replace('{', "\\{").replace('}', "\\}");
    let mut s = format!("@article{{{key},\n");
    let mut field = |k: &str, v: &str| {
        if !v.trim().is_empty() {
            s.push_str(&format!("  {k} = {{{}}},\n", esc(v)));
        }
    };
    field("title", &m.title);
    field("author", &m.authors.join(" and "));
    field("year", &m.year.map(|y| y.to_string()).unwrap_or_default());
    field("journal", &m.journal);
    field("volume", &m.volume);
    field("number", &m.issue);
    field("pages", &m.pages);
    field("doi", &m.doi);
    field("note", note);
    s.push_str("}\n\n");
    s
}

/// Final status in words and the reasons.
fn decision(state: &State, r: &crate::derive::RecState) -> (String, String, String) {
    let ft = state.status(r, Stage::Ft);
    let ta = state.status(r, Stage::Ta);
    let reasons = |stage| state.final_reasons(r, stage).iter().map(|id| state.protocol.reason_label(state.aliases.get(id).unwrap_or(id))).chain(state.final_other(r, stage)).collect::<Vec<_>>().join("; ");
    match (&ta, &ft) {
        (_, Status::Final { value: Choice::Include, .. }) => ("Included".into(), "full text".into(), String::new()),
        (_, Status::Final { value: Choice::Exclude, .. }) => ("Excluded".into(), "full text".into(), reasons(Stage::Ft)),
        (Status::Final { value: Choice::Exclude, .. }, _) => ("Excluded".into(), "title and abstract".into(), reasons(Stage::Ta)),
        (Status::Final { value: Choice::Include | Choice::Maybe, .. }, _) => ("Awaiting full text".into(), "full text".into(), String::new()),
        _ => ("Not yet decided".into(), "title and abstract".into(), String::new()),
    }
}

impl Reviews {
    /// Included and excluded studies with their decisions: "studies-ris", "studies-bib",
    /// "studies-csv"; `which` is "included", "excluded" or "all".
    pub fn studies_export(&self, review: &str, format: &str, which: &str) -> Result<OutFile> {
        self.read(review, |state, conn| {
            let all = all_metas(conn, review)?;
            let base = slug(&state.info.name);
            let mut ris = String::new();
            let mut bib = String::new();
            let mut csv = line(&["Study", "Record ID", "Decision", "Decided at", "Reasons", "Title", "Authors", "Year", "Journal", "DOI", "PMID"].map(String::from));
            let mut used = std::collections::HashSet::new();
            for m in &all {
                let Some(r) = state.record(&m.id) else { continue };
                if !state.active(r) {
                    continue;
                }
                let (what, stage, reasons) = decision(state, r);
                let keep = match which {
                    "included" => what == "Included",
                    "excluded" => what == "Excluded",
                    _ => true,
                };
                if !keep {
                    continue;
                }
                let study = study_label(state, Some(m), &m.id);
                ris.push_str(&ris_entry(m, &[("N1", if reasons.is_empty() { format!("{what} at {stage}") } else { format!("{what} at {stage}: {reasons}") }), ("C3", m.id.clone())]));
                let key = bib_key(m, &mut used);
                bib.push_str(&bib_entry(m, &key, &if reasons.is_empty() { what.clone() } else { format!("{what}: {reasons}") }));
                csv.push_str(&line(&[study, m.id.clone(), what, stage, reasons, m.title.clone(), m.authors.join("; "), m.year.map(|y| y.to_string()).unwrap_or_default(), m.journal.clone(), m.doi.clone(), m.pmid.clone()]));
            }
            Ok(match format {
                "ris" => OutFile::text(format!("{base}-{which}-studies.ris"), ris),
                "bib" => OutFile::text(format!("{base}-{which}-studies.bib"), bib),
                _ => OutFile::text(format!("{base}-{which}-studies.csv"), csv),
            })
        })
    }

    /// The files reproducing one analysis in R: data.csv, analysis.R, key-results.json and,
    /// for the basic models, analysis.do (Stata).
    pub fn r_export(&self, review: &str, spec: &AnalysisSpec) -> Result<Vec<OutFile>> {
        let base: AnalysisRequest = serde_json::from_value(spec.request.clone()).map_err(|e| format!("The analysis settings are damaged: {e}"))?;
        let analysis = self.analyse(review, &base)?;
        let adv = synthesis_request(spec, &base);
        let synthesis = match &adv {
            Some(r) => Some(self.synthesis(review, r)?),
            None => None,
        };
        let (data, mods, title) = self.read(review, |state, conn| {
            let ids: Vec<String> = state.included().iter().map(|r| r.id.clone()).collect();
            let raw = outcome_rows(state, &metas(conn, review, &ids)?);
            let tp = base.timepoint.as_deref().filter(|t| !t.is_empty());
            let mut data = study_data(&raw, &base.outcome, tp);
            if !base.subgroups {
                for d in &mut data {
                    d.subgroup = None;
                }
            }
            let refs: Vec<&crate::meta::StudyData> = data.iter().collect();
            let mods: Vec<crate::metareg::Moderator> = adv.as_ref().map(|a| a.moderators.iter().map(|m: &ModeratorRef| crate::synthesis::moderator_values(state, m, &refs, &raw, &base.outcome, tp)).collect()).unwrap_or_default();
            let title = format!("{} — {}{}", state.info.name, base.outcome, tp.map(|t| format!(" ({t})")).unwrap_or_default());
            Ok((data, mods, title))
        })?;
        let a = analysis.get("analysis").cloned().unwrap_or(Json::Null);
        let adv_json = adv.as_ref().map(|_| serde_json::to_value(&spec.advanced).unwrap_or(Json::Null));
        let script = crate::rscript::script(&crate::rscript::ScriptInput {
            title: &if spec.name.is_empty() { title.clone() } else { format!("{title}: {}", spec.name) },
            key_version: KEY_VERSION,
            data: &data,
            moderators: &mods,
            measure: base.options.measure,
            method: base.options.method,
            hartung_knapp: base.options.hartung_knapp,
            subgroups: base.subgroups,
            analysis: &a,
            synthesis: match (&adv_json, &synthesis) {
                (Some(r), Some(s)) => Some((r, s)),
                _ => None,
            },
        });
        let mut files = vec![
            OutFile::text("data.csv", crate::rscript::data_csv(&data, &mods, base.options.measure)),
            OutFile::text("analysis.R", script),
            OutFile::text("key-results.json", serde_json::to_string_pretty(&json!({ "settings": spec, "analysis": a, "advanced": synthesis })).unwrap_or_default()),
        ];
        if let Some(do_file) = crate::rscript::stata(base.options.measure, base.options.method, base.options.hartung_knapp) {
            files.push(OutFile::text("analysis.do", do_file));
        }
        Ok(files)
    }

    /// One analysis's R files as a zip: (file name, bytes).
    pub fn export_r_zip(&self, review: &str, spec: &AnalysisSpec) -> Result<(String, Vec<u8>)> {
        let files = self.r_export(review, spec)?;
        let outcome = spec.request.get("outcome").and_then(Json::as_str).unwrap_or("analysis");
        let root = format!("{}-r", slug(if spec.name.is_empty() { outcome } else { &spec.name }));
        Ok((format!("{root}.zip"), zip_files(&root, &files)?))
    }

    /// The replication bundle as zip bytes. `plots` are SVGs the Analysis stage drew
    /// (path → markup), placed under analyses/; `anonymise` replaces reviewer names.
    /// `strategies` are the database runs' logs the host has at hand (std-A's search report).
    pub fn bundle(&self, review: &str, viewer: &str, plots: &BTreeMap<String, String>, current: Option<&AnalysisSpec>, anonymise: bool, strategies: &std::collections::HashMap<String, Json>) -> Result<(String, Vec<u8>)> {
        let mut files: Vec<(OutFile, &str)> = Vec::new();
        let (name, members, specs) = self.read(review, |state, _| Ok((state.info.name.clone(), state.team.iter().map(|m| (m.id.clone(), m.name.clone())).collect::<Vec<_>>(), saved(state))))?;
        let add_export = |kind: &str, path: &str, what: &'static str, files: &mut Vec<(OutFile, &str)>| {
            if let Ok(f) = self.export(review, kind, viewer)
                && let Some(c) = f.get("content").and_then(Json::as_str)
            {
                files.push((OutFile::text(path, c), what));
            }
        };
        // Protocol, search report and checklist (std-A's reporting_hooks), risk of bias and
        // certainty (std-C's certainty exports), called directly.
        let mut direct: Vec<(OutFile, &str)> = Vec::new();
        self.read(review, |state, conn| {
            let base = slug(&state.info.name);
            for (kind, path, what) in [
            ("protocol", "protocol/protocol.md", "The protocol in PRISMA-P order."),
            ("prospero-sheet", "protocol/prospero-sheet.md", "Text for each PROSPERO registration field."),
            ("osf-prereg", "protocol/osf-preregistration.md", "The protocol as an OSF preregistration."),
            ("deviations", "protocol/deviations.csv", "Changes to the protocol after screening began, with reasons."),
            ("search-report", "search/search-report.md", "The PRISMA-S search report."),
            ("search-report-csv", "search/search-report.csv", "Search counts per source."),
            ("prisma-checklist", "reporting/prisma-checklist.md", "The PRISMA 2020 checklist filled from the review."),
            ("prisma-checklist-csv", "reporting/prisma-checklist.csv", "The same checklist as CSV."),
            ("methods-draft", "reporting/methods-draft.md", "A draft methods section built from the review's data."),
            ] {
                if let Ok((_, content, _)) = crate::reporting_hooks::export_with(state, kind, strategies)
                    && !content.trim().is_empty()
                {
                    direct.push((OutFile::text(path, content), what));
                }
            }
            for (kind, path, what) in [
                ("rob-csv", "risk-of-bias/risk-of-bias.csv", "Risk-of-bias judgements per study, result and domain, with support."),
                ("sof-md", "certainty/summary-of-findings.md", "Summary of findings with GRADE certainty."),
                ("sof-csv", "certainty/summary-of-findings.csv", "The same table as CSV."),
                ("grade-csv", "certainty/grade.csv", "GRADE judgements per outcome and domain with footnotes."),
            ] {
                if let Some(Ok((_, content, _))) = crate::certainty::export(state, conn, kind, &base)
                    && content.lines().count() > 1
                {
                    direct.push((OutFile::text(path, content), what));
                }
            }
            Ok(())
        })?;
        files.extend(direct);
        for (kind, path, what) in [
            ("prisma", "prisma/prisma-counts.csv", "PRISMA 2020 flow diagram numbers."),
            ("screening", "screening/screening-decisions.csv", "Every record with its decisions and reasons, per stage and reviewer."),
            ("extraction", "extraction/extraction-wide.csv", "Extracted data, one row per study, with source positions."),
            ("extraction-long", "extraction/extraction-long.csv", "Extracted data, one row per value, with reviewer, agreement, quote and page."),
            ("dictionary", "extraction/data-dictionary.csv", "What each extraction field means (forms, fields, types, options)."),
            ("outcomes", "extraction/outcomes.csv", "Outcome data with escalc()-style columns."),
            ("audit", "audit/audit-trail.csv", "Every event in the review's log, in words, with time, person and protocol version."),
            ("highlights", "full-texts/my-highlights.csv", "Highlights and comments made in full texts the review keeps itself."),
        ] {
            add_export(kind, path, what, &mut files);
        }
        if !anonymise {
            add_export("review", "review/review.keyreview.json", "The whole review as Key's event log (reopens in Key).", &mut files);
        }
        let conv = self.read(review, |state, conn| {
            let ids: Vec<String> = state.included().iter().map(|r| r.id.clone()).collect();
            Ok(conversions_csv(state, &metas(conn, review, &ids)?))
        })?;
        files.push((OutFile::text("extraction/conversions.csv", conv), "Values derived from other statistics, with the method and its source."));
        for (fmt, what) in [("ris", "Included studies (RIS)."), ("bib", "Included studies (BibTeX).")] {
            let f = self.studies_export(review, fmt, "included")?;
            files.push((OutFile { path: format!("studies/included.{fmt}"), bytes: f.bytes }, what));
        }
        let f = self.studies_export(review, "csv", "all")?;
        files.push((OutFile { path: "studies/studies-and-decisions.csv".into(), bytes: f.bytes }, "Every record with its final decision and reasons."));
        // RevMan Web import files.
        if let Ok(rm) = self.revman_files(review) {
            for f in rm {
                let what = match f.path.as_str() {
                    p if p.ends_with("study-information.csv") => "RevMan Web import: study information.",
                    p if p.ends_with("study-arms.csv") => "RevMan Web import: study arms.",
                    p if p.ends_with("study-results.csv") => "RevMan Web import: study results.",
                    p if p.ends_with(".ris") => "RevMan Web import: references (import first).",
                    _ => "RevMan Web import notes and validation.",
                };
                files.push((OutFile { path: format!("revman/{}", f.path), bytes: f.bytes }, what));
            }
        }
        // Analyses: the saved ones and the one on screen.
        let mut all_specs = specs;
        if let Some(c) = current
            && !all_specs.iter().any(|s| s.id == c.id)
        {
            all_specs.push(c.clone());
        }
        let mut used = std::collections::HashSet::new();
        for spec in &all_specs {
            let outcome = spec.request.get("outcome").and_then(Json::as_str).unwrap_or("analysis");
            let mut dir = slug(if spec.name.is_empty() { outcome } else { &spec.name });
            let mut i = 1;
            while !used.insert(dir.clone()) {
                i += 1;
                dir = format!("{}-{i}", slug(outcome));
            }
            match self.r_export(review, spec) {
                Ok(fs) => {
                    for f in fs {
                        let what = match f.path.as_str() {
                            "data.csv" => "The data the script reads (one row per estimate).",
                            "analysis.R" => "R script (metafor) reproducing Key's results, with checks.",
                            "analysis.do" => "Stata do-file for the basic model (not checked).",
                            _ => "Key's settings and results as JSON.",
                        };
                        files.push((OutFile { path: format!("analyses/{dir}/{}", f.path), bytes: f.bytes }, what));
                    }
                }
                Err(e) => files.push((OutFile::text(format!("analyses/{dir}/NOT-EXPORTED.txt"), format!("This analysis could not be exported: {e}\n")), "Why an analysis is missing.")),
            }
        }
        for (path, svg) in plots {
            let clean: String = path.chars().map(|c| if c.is_alphanumeric() || "-_./".contains(c) { c } else { '-' }).collect();
            let clean = clean.trim_start_matches(['/', '.']).replace("..", "");
            files.push((OutFile::text(format!("analyses/plots/{clean}"), svg.clone()), "A plot as drawn in Key (SVG)."));
        }
        if anonymise {
            for (f, _) in files.iter_mut() {
                if let Ok(mut t) = String::from_utf8(f.bytes.clone()) {
                    for (i, (id, name)) in members.iter().enumerate() {
                        let alias = format!("Reviewer {}", i + 1);
                        if !name.trim().is_empty() {
                            t = t.replace(name.as_str(), &alias);
                        }
                        if id.len() > 6 {
                            t = t.replace(id.as_str(), &alias);
                        }
                    }
                    f.bytes = t.into_bytes();
                }
            }
        }
        let readme = readme(&name, &files, anonymise);
        files.insert(0, (OutFile::text("README.md", readme), "This file."));
        let manifest: Vec<Json> = files.iter().map(|(f, what)| json!({ "path": f.path, "bytes": f.bytes.len(), "sha256": sha256_hex(&f.bytes), "description": what })).collect();
        let manifest_json = serde_json::to_string_pretty(&json!({ "format": "key-replication-bundle", "version": 1, "review": name, "keyVersion": KEY_VERSION, "anonymised": anonymise, "files": manifest })).unwrap_or_default();
        let sums: String = files.iter().map(|(f, _)| format!("{}  {}\n", sha256_hex(&f.bytes), f.path)).collect();
        files.push((OutFile::text("manifest.json", manifest_json), ""));
        files.push((OutFile::text("SHA256SUMS", sums), ""));
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let root = format!("{}-replication", slug(&name));
        for (f, _) in &files {
            zip.start_file(format!("{root}/{}", f.path), opts).map_err(|e| e.to_string())?;
            zip.write_all(&f.bytes).map_err(|e| e.to_string())?;
        }
        let bytes = zip.finish().map_err(|e| e.to_string())?.into_inner();
        Ok((format!("{root}.zip"), bytes))
    }
}

fn readme(name: &str, files: &[(OutFile, &str)], anonymise: bool) -> String {
    let mut s = format!("# Replication bundle: {name}\n\nExported from Key {KEY_VERSION}. Nothing was uploaded: deposit this folder on OSF or with a journal yourself.\n\n");
    s.push_str("To reproduce an analysis, open its folder under `analyses/` and run `Rscript analysis.R`; every check prints \"matches Key\" or the difference. ");
    s.push_str("`manifest.json` and `SHA256SUMS` list each file with its SHA-256 checksum (`shasum -a 256 -c SHA256SUMS` verifies them).\n\n");
    if anonymise {
        s.push_str("Reviewer names are replaced by \"Reviewer 1\", \"Reviewer 2\" … throughout, and the review's own event log is left out because it names people.\n\n");
    }
    s.push_str("## Files\n\n| File | What it is |\n|---|---|\n");
    for (f, what) in files {
        s.push_str(&format!("| `{}` | {} |\n", f.path, what));
    }
    s.push_str("| `manifest.json` | Every file with its size, SHA-256 checksum and description. |\n| `SHA256SUMS` | The checksums in `shasum` format. |\n");
    s.push_str("\nFiles from parts of the review that were not used (for example risk of bias or certainty) are absent.\n");
    s
}

/// Files as one zip under `root/`.
pub fn zip_files(root: &str, files: &[OutFile]) -> Result<Vec<u8>> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for f in files {
        zip.start_file(format!("{root}/{}", f.path), opts).map_err(|e| e.to_string())?;
        zip.write_all(&f.bytes).map_err(|e| e.to_string())?;
    }
    Ok(zip.finish().map_err(|e| e.to_string())?.into_inner())
}

pub fn method_name(m: Method) -> &'static str {
    match m {
        Method::Fe => "fixed effect",
        Method::Dl => "DerSimonian–Laird",
        Method::Reml => "REML",
    }
}
