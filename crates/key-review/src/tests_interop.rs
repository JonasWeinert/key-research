// std-D: a review with the 13 BCG trials (metafor's dat.bcg) as extracted outcome data and
// latitude as a study-level field, through the advanced synthesis and every export.
use crate::interop::{AnalysisSpec, sha256_hex};
use crate::model::*;
use crate::{NoLibrary, Reviews};
use serde_json::{Value as Json, json};
use std::collections::BTreeMap;
use std::io::Read as _;

const BCG: [(f64, f64, f64, f64, f64, &str); 13] = [
    (4., 119., 11., 128., 44., "Aronson"),
    (6., 300., 29., 274., 55., "Ferguson"),
    (3., 228., 11., 209., 42., "Rosenthal"),
    (62., 13536., 248., 12619., 52., "Hart"),
    (33., 5036., 47., 5761., 13., "Frimodt"),
    (180., 1361., 372., 1079., 44., "Stein"),
    (8., 2537., 10., 619., 19., "Vandiviere"),
    (505., 87886., 499., 87892., 13., "Madras"),
    (29., 7470., 45., 7232., 27., "Coetzee"),
    (17., 1699., 65., 1600., 42., "Rosenthal"),
    (186., 50448., 141., 27197., 18., "Comstock"),
    (5., 2493., 3., 2338., 33., "Comstock"),
    (27., 16886., 29., 17825., 33., "Comstock"),
];

pub(crate) fn bcg_review() -> (Reviews, String, String, Vec<String>) {
    let reviews = Reviews::in_memory().unwrap();
    let (id, owner) = reviews.create("Vaccine trials", "Ana", None).unwrap();
    let mut p = reviews.read(&id, |s, _| Ok(s.protocol.clone())).unwrap();
    p.rules.ta.reviewers = 1;
    p.rules.ft.reviewers = 1;
    p.forms.push(crate::templates::outcomes_form());
    p.forms.push(Form {
        id: "f-chars".into(),
        name: "Characteristics".into(),
        kind: "custom".into(),
        sections: vec![Section { id: "s1".into(), title: "Study".into(), fields: vec![Field { id: "lat".into(), label: "Latitude".into(), kind: "number".into(), ..Default::default() }, Field { id: "design".into(), label: "Study design".into(), kind: "text".into(), ..Default::default() }, Field { id: "alloc".into(), label: "Allocation".into(), kind: "text".into(), role: "subgroup".into(), ..Default::default() }], ..Default::default() }],
    });
    reviews.save_protocol(&id, p, "", &owner, false, &NoLibrary).unwrap();
    let ris: String = BCG.iter().enumerate().map(|(i, (.., name))| format!("TY  - JOUR\nTI  - Invented vaccine trial number {i}\nAU  - {name}, A.\nPY  - {}\nDO  - 10.9999/bcg.{i}\nER  - \n", 1940 + i * 3)).collect();
    let parsed = crate::import::parse_file(&ris, Some("t.ris")).unwrap();
    let batch = Batch { kind: "file".into(), group: "databases".into(), name: "Example".into(), file_name: "t.ris".into(), ..Default::default() };
    reviews.import(&id, batch, parsed.records, &owner, &NoLibrary).unwrap();
    let mut records: Vec<(String, String)> = reviews.read(&id, |s, conn| Ok(crate::store::all_metas(conn, &id)?.into_iter().filter(|m| s.record(&m.id).is_some_and(|r| s.active(r))).map(|m| (m.id.clone(), m.title.clone())).collect())).unwrap();
    records.sort_by_key(|(_, t)| t.rsplit(' ').next().unwrap().parse::<usize>().unwrap());
    let ids: Vec<String> = records.into_iter().map(|(id, _)| id).collect();
    for (r, (a, b, c, d, lat, _)) in ids.iter().zip(BCG) {
        reviews.decide(&id, &[r.clone()], Stage::Ta, Choice::Include, vec![], "", "", vec![], &owner).unwrap();
        reviews.decide(&id, &[r.clone()], Stage::Ft, Choice::Include, vec![], "", "", vec![], &owner).unwrap();
        let row = json!([{ "outcome": "Tuberculosis", "type": "Dichotomous", "group1": "Vaccine", "group2": "Control", "e1": a, "n1": a + b, "e2": c, "n2": c + d, "measure": "RR",
            "_conversions": [{ "kind": "events-from-percent", "method": "Events from a percentage", "formula": "events = round(percentage / 100 × n)", "citation": "Cochrane Handbook", "inputs": { "percent": 3.2 }, "fill": { "e1": a } }] }]);
        reviews.extract(&id, r, "f-outcomes", "outcomes", row, "Table 1", Some(2), None, None, false, false, &owner).unwrap();
        reviews.extract(&id, r, "f-chars", "lat", json!(lat), "", None, None, None, false, false, &owner).unwrap();
        reviews.extract(&id, r, "f-chars", "design", json!("Randomised trial"), "", None, None, None, false, false, &owner).unwrap();
        reviews.extract(&id, r, "f-chars", "alloc", json!(if lat > 40.0 { "north" } else if lat > 25.0 { "middle" } else { "south" }), "", None, None, None, false, false, &owner).unwrap();
    }
    (reviews, id, owner, ids)
}

fn spec() -> AnalysisSpec {
    AnalysisSpec {
        id: "a1".into(),
        name: "Main analysis".into(),
        request: json!({ "outcome": "Tuberculosis", "options": { "measure": "RR", "method": "reml", "hartungKnapp": true, "level": 0.95 }, "subgroups": false }),
        advanced: json!({
            "moderators": [{ "source": "field", "form": "f-chars", "field": "lat", "kind": "continuous", "name": "Latitude" }],
            "metareg": { "method": "reml", "knappHartung": true, "permutations": 0 },
            "bias": { "petPeese": true, "uwls": true, "trimFill": "L0", "selection": true },
            "sensitivity": { "influence": true, "cumulative": "year", "models": true },
        }),
        deleted: false,
    }
}

#[test]
fn synthesis_runs_every_section_on_review_data() {
    let (reviews, id, _, _) = bcg_review();
    let mods = reviews.moderators(&id).unwrap();
    assert!(mods.iter().any(|m| m.moderator.field == "lat" && m.moderator.kind == "continuous" && m.studies == 13));
    let s = spec();
    let base: crate::export::AnalysisRequest = serde_json::from_value(s.request.clone()).unwrap();
    let mut req: crate::synthesis::SynthesisRequest = serde_json::from_value(s.advanced.clone()).unwrap();
    req.outcome = base.outcome.clone();
    req.options = base.options.clone();
    let out = reviews.synthesis(&id, &req).unwrap();
    // The same numbers as metareg.rs's validated test on dat.bcg (metafor, test = "knha").
    let b1 = out.pointer("/metaRegression/coefficients/1/estimate").and_then(Json::as_f64).unwrap();
    assert!((b1 - -0.0291017250116496).abs() < 1e-8, "{b1}");
    assert!(out.pointer("/bias/petPeese/chosen").is_some());
    assert_eq!(out.pointer("/bias/trimFill/k0").and_then(Json::as_u64), Some(1));
    assert!(out.pointer("/bias/selection/estimate").is_some() || out.pointer("/bias/selection/error").is_some());
    assert_eq!(out.pointer("/sensitivity/influence").and_then(Json::as_array).map(|a| a.len()), Some(13));
    assert_eq!(out.pointer("/sensitivity/models").and_then(Json::as_array).map(|a| a.len()), Some(4));
    assert_eq!(out["multipleEstimates"], json!(false));
}

#[test]
fn r_script_embeds_keys_numbers() {
    let (reviews, id, owner, _) = bcg_review();
    reviews.save_analysis(&id, serde_json::to_value(spec()).unwrap(), &owner).unwrap();
    let files = reviews.r_export(&id, &spec()).unwrap();
    let script = String::from_utf8(files.iter().find(|f| f.path == "analysis.R").unwrap().bytes.clone()).unwrap();
    let data = String::from_utf8(files.iter().find(|f| f.path == "data.csv").unwrap().bytes.clone()).unwrap();
    assert_eq!(data.lines().count(), 14);
    assert!(data.lines().next().unwrap().ends_with("mod_1"));
    let results: Json = serde_json::from_slice(&files.iter().find(|f| f.path == "key-results.json").unwrap().bytes).unwrap();
    // The embedded expected values are Key's own, to full precision.
    let est = results.pointer("/analysis/main/estimate").and_then(Json::as_f64).unwrap();
    assert!(script.contains(&format!("{est}")), "estimate {est} not in the script");
    let b1 = results.pointer("/advanced/metaRegression/coefficients/1/estimate").and_then(Json::as_f64).unwrap();
    assert!(script.contains(&format!("{b1}")));
    assert!(script.contains("method = \"REML\", test = \"knha\""));
    assert!(script.contains("mods = ~ mod_1"));
    assert!(script.contains("trimfill(") && script.contains("influence(res)") && script.contains("cumul(res"));
    assert!(script.contains("sessionInfo()"));
    let facts = reviews.read(&id, |s, _| Ok(crate::interop::reporting_facts(s))).unwrap();
    assert_eq!(facts["analysis"]["metaRegression"], json!(true));
    assert!(facts["analysis"]["statement"].as_str().unwrap().contains("PET-PEESE"));
    assert_eq!(facts["analysis"]["conversions"], json!(["Events from a percentage"]));
}

/// Runs the exported script in R when Rscript and metafor are installed (not in CI: `cargo test
/// -- --ignored r_script_reproduces_in_r`).
#[test]
#[ignore]
fn r_script_reproduces_in_r() {
    let (reviews, id, _, _) = bcg_review();
    let files = reviews.r_export(&id, &spec()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for f in &files {
        std::fs::write(dir.path().join(&f.path), &f.bytes).unwrap();
    }
    let out = std::process::Command::new("Rscript").arg("analysis.R").current_dir(dir.path()).output().expect("Rscript");
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    println!("{text}");
    assert!(text.contains("Every check matches Key."), "{text}");
}

/// Several estimates per study and subgroups, each dependence model in turn, run in R when it
/// is installed (`cargo test -- --ignored`; the robust checks need clubSandwich).
#[test]
#[ignore]
fn dependence_scripts_reproduce_in_r() {
    let (reviews, id, owner, ids) = bcg_review();
    // A second, invented estimate for six of the trials.
    for (i, r) in ids.iter().enumerate().take(6) {
        let (a, b, c, d, ..) = BCG[i];
        let row = json!([{ "outcome": "Tuberculosis", "type": "Dichotomous", "e1": a, "n1": a + b, "e2": c, "n2": c + d }, { "outcome": "Tuberculosis", "type": "Dichotomous", "e1": a + 2.0, "n1": a + b, "e2": c + 1.0, "n2": c + d }]);
        reviews.extract(&id, r, "f-outcomes", "outcomes", row, "Table 1", Some(2), None, None, false, false, &owner).unwrap();
    }
    for model in ["three-level", "che", "aggregate"] {
        let mut s = spec();
        s.request["subgroups"] = json!(model == "aggregate");
        let mods = if model == "aggregate" { json!([]) } else { s.advanced["moderators"].clone() };
        s.advanced = json!({ "moderators": mods, "metareg": if model == "aggregate" { Json::Null } else { json!({}) }, "dependence": { "model": model, "rho": 0.5, "robust": true }, "bias": { "petPeese": true, "uwls": true } });
        let files = reviews.r_export(&id, &s).unwrap();
        let dir = tempfile::tempdir().unwrap();
        for f in &files {
            std::fs::write(dir.path().join(&f.path), &f.bytes).unwrap();
        }
        let out = std::process::Command::new("Rscript").arg("analysis.R").current_dir(dir.path()).output().expect("Rscript");
        let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
        let checks: Vec<&str> = text.lines().filter(|l| l.contains("matches Key") || l.contains("DIFFERS") || l.contains("Error")).collect();
        println!("{model}:\n{}", checks.join("\n"));
        assert!(text.contains("Every check matches Key."), "{model}: {text}");
    }
}

#[test]
fn revman_files_pass_the_validator() {
    let (reviews, id, _, _) = bcg_review();
    let files = reviews.revman_files(&id).unwrap();
    let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(names, ["study-information.csv", "study-arms.csv", "study-results.csv", "references.ris", "README.txt"]);
    let problems = reviews.revman_check(&id).unwrap();
    assert!(problems.is_empty(), "{problems:?}");
    let info = String::from_utf8(files[0].bytes.clone()).unwrap();
    assert!(info.starts_with("\u{feff}Study,Year,Allocation method"));
    // Three Comstock trials: distinct Study IDs.
    assert!(info.contains("Comstock 1970a") || info.contains("Comstock 1973"), "{info}");
    assert!(info.contains(",RCT,PUB,"));
    let results = String::from_utf8(files[2].bytes.clone()).unwrap();
    assert_eq!(results.lines().count(), 1 + 26);
    assert!(results.contains("Tuberculosis,Arm Level,LOG_RR,Vaccine,FALSE,123,4"));
    assert!(String::from_utf8_lossy(&files[3].bytes).contains("NS  - Aronson 1940"));
}

#[test]
fn bundle_has_every_file_with_checksums() {
    let (reviews, id, owner, _) = bcg_review();
    reviews.save_analysis(&id, serde_json::to_value(spec()).unwrap(), &owner).unwrap();
    let plots: BTreeMap<String, String> = [("tuberculosis-forest.svg".to_string(), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".to_string())].into();
    let (name, bytes) = reviews.bundle(&id, &owner, &plots, None, true, &Default::default()).unwrap();
    assert_eq!(name, "vaccine-trials-replication.zip");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
    for want in ["README.md", "manifest.json", "SHA256SUMS", "screening/screening-decisions.csv", "extraction/extraction-wide.csv", "extraction/extraction-long.csv", "extraction/data-dictionary.csv", "extraction/conversions.csv", "prisma/prisma-counts.csv", "audit/audit-trail.csv", "studies/included.ris", "studies/included.bib", "studies/studies-and-decisions.csv", "revman/study-results.csv", "analyses/main-analysis/analysis.R", "analyses/main-analysis/data.csv", "analyses/plots/tuberculosis-forest.svg"] {
        assert!(names.iter().any(|n| n == &format!("vaccine-trials-replication/{want}")), "missing {want}: {names:?}");
    }
    // Anonymised: no review event log, no reviewer name.
    assert!(!names.iter().any(|n| n.ends_with(".keyreview.json")));
    let mut manifest = String::new();
    zip.by_name("vaccine-trials-replication/manifest.json").unwrap().read_to_string(&mut manifest).unwrap();
    let manifest: Json = serde_json::from_str(&manifest).unwrap();
    for f in manifest["files"].as_array().unwrap() {
        let path = f["path"].as_str().unwrap();
        let mut bytes = Vec::new();
        zip.by_name(&format!("vaccine-trials-replication/{path}")).unwrap().read_to_end(&mut bytes).unwrap();
        assert_eq!(f["sha256"].as_str().unwrap(), sha256_hex(&bytes), "{path}");
        if let Ok(t) = String::from_utf8(bytes) {
            assert!(!t.contains("Ana"), "{path} names a reviewer");
        }
    }
}
