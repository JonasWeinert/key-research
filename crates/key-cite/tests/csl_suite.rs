// The official CSL processor test suite through Key's rendering path. The fixtures are not
// in this repository (the suite carries no licence); point CSL_TEST_SUITE at a checkout's
// `processor-tests/humans` folder to run it:
//   CSL_TEST_SUITE=…/test-suite/processor-tests/humans cargo test -p key-cite --test csl_suite -- --nocapture
// Cases using features the runner cannot express (explicit positions, CITATIONS blocks,
// abbreviations, bibliography sections, date ranges) are skipped. Every case in KNOWN_PASS
// must pass; the summary prints the pass rate per category.
use citationberg::IndependentStyle;
use key_cite::{CitationInput, CiteItem, RenderRequest, render};
use serde_json::Value as Json;
use std::collections::BTreeMap;

/// A representative subset per category that is known to render exactly (regression guard).
const KNOWN_PASS: &[&str] = &[
    "affix_InterveningEmpty", "bugreports_DisambiguationAddNames", "collapse_AuthorCollapse", "collapse_CitationNumberRangesInsert",
    "condition_EmptyIsNumericFalse", "date_LocalizedDateFormats-en-US", "date_YearSuffixDelimiter", "disambiguate_AddNamesSuccess",
    "disambiguate_ByCiteMinimal", "disambiguate_YearSuffixAtTwoLevels", "disambiguate_YearSuffixFiftyTwoEntries", "locale_TermInStyle",
    "locator_SimpleLocators", "magic_SubsequentAuthorSubstituteMultipleNames", "name_EtAlUseLast", "name_InitialsInitializeFalse",
    "nameattr_EtAlMinOnCitationInCitation", "number_OrdinalSpacing", "page_Chicago", "punctuation_DelimiterWithStripPeriodsAndSubstitute1",
    "sort_AguStyle", "label_EmptyLabelVanish",
];

fn section<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let open = text.find(&format!(">>===== {name} =====>>"))?;
    let body = &text[open..];
    let start = body.find('\n')? + 1;
    let end = body.find(&format!("<<===== {name} =====<<"))?;
    Some(body[start..end].trim_end_matches('\n'))
}

fn decode(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|e| *e < 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let c = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some('\u{a0}'),
            e if e.starts_with("#x") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match c {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn strip_tags(html: &str) -> String {
    let html = html.replace("</div><div class=\"csl-right-inline\">", " ");
    let mut out = String::new();
    let mut tag = false;
    for c in html.chars() {
        match c {
            '<' => tag = true,
            '>' if tag => tag = false,
            c if !tag => out.push(c),
            _ => {}
        }
    }
    decode(&out)
}

fn normalize(lines: &str) -> String {
    lines
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

enum Outcome {
    Pass,
    Fail(String),
    Skip,
}

fn run_case(text: &str) -> Outcome {
    let mode = section(text, "MODE").unwrap_or("").trim();
    if !matches!(mode, "citation" | "bibliography") {
        return Outcome::Skip;
    }
    if ["CITATIONS", "BIBENTRIES", "BIBSECTION", "ABBREVIATIONS"].iter().any(|s| section(text, s).is_some()) {
        return Outcome::Skip;
    }
    let (Some(csl), Some(input), Some(result)) = (section(text, "CSL"), section(text, "INPUT"), section(text, "RESULT")) else {
        return Outcome::Skip;
    };
    let Ok(style) = IndependentStyle::from_xml(csl) else { return Outcome::Skip };
    let Ok(Json::Array(items)) = serde_json::from_str::<Json>(input) else { return Outcome::Skip };
    let ranges = items.iter().any(|i| {
        i.as_object().is_some_and(|m| m.values().any(|v| v.get("date-parts").and_then(Json::as_array).is_some_and(|p| p.len() > 1)))
    });
    if ranges || items.iter().any(|i| i.get("note").is_some()) {
        return Outcome::Skip;
    }
    let ids: Vec<String> = items.iter().filter_map(|i| i.get("id").map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect();
    // Numeric ids are strings to the engine.
    let items: Vec<Json> = items
        .into_iter()
        .map(|mut i| {
            if let Some(id) = i.get("id").filter(|v| !v.is_string()).map(|v| v.to_string()) {
                i["id"] = Json::String(id);
            }
            i
        })
        .collect();
    let citations: Vec<CitationInput> = match section(text, "CITATION-ITEMS") {
        Some(raw) => {
            let Ok(Json::Array(groups)) = serde_json::from_str::<Json>(raw) else { return Outcome::Skip };
            let mut out = Vec::new();
            for group in groups {
                let mut cite = CitationInput::default();
                for item in group.as_array().cloned().unwrap_or_default() {
                    if item.get("position").is_some() || item.get("near-note").is_some() {
                        return Outcome::Skip;
                    }
                    let s = |k: &str| item.get(k).and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|n| n.to_string())));
                    cite.items.push(CiteItem {
                        id: item.get("id").map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).unwrap_or_default(),
                        locator: s("locator"),
                        label: s("label"),
                        prefix: s("prefix"),
                        suffix: s("suffix"),
                        suppress_author: item.get("suppress-author").and_then(Json::as_bool).unwrap_or(false),
                        author_only: item.get("author-only").and_then(Json::as_bool).unwrap_or(false),
                        narrative: false,
                    });
                }
                out.push(cite);
            }
            out
        }
        None => vec![CitationInput { items: ids.iter().map(|id| CiteItem { id: id.clone(), ..Default::default() }).collect(), note_number: None }],
    };
    let bibliography = mode == "bibliography";
    let request = RenderRequest { citations, bibliography, uncited: vec![] };
    let Ok(out) = render(&style, None, &items, &request) else { return Outcome::Fail("render error".into()) };
    let got = if bibliography {
        out.bibliography.map(|b| b.entries.iter().map(|e| e.formatted.text.clone()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
    } else {
        out.citations.iter().map(|c| c.text.clone()).collect::<Vec<_>>().join("\n")
    };
    let want = normalize(&strip_tags(result));
    let got = normalize(&got);
    if got == want { Outcome::Pass } else { Outcome::Fail(format!("want: {want}\n got: {got}")) }
}

#[test]
fn csl_test_suite() {
    let Some(dir) = std::env::var_os("CSL_TEST_SUITE") else {
        eprintln!("CSL_TEST_SUITE not set; skipping the CSL test suite");
        return;
    };
    let mut by_category: BTreeMap<String, (usize, usize, usize)> = BTreeMap::new();
    let mut failures = Vec::new();
    let mut known_failed = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().trim_end_matches(".txt").to_string();
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let category = name.split('_').next().unwrap_or("").to_string();
        let counts = by_category.entry(category).or_default();
        match run_case(&text) {
            Outcome::Pass => counts.0 += 1,
            Outcome::Fail(diff) => {
                counts.1 += 1;
                if KNOWN_PASS.contains(&name.as_str()) {
                    known_failed.push(format!("{name}\n{diff}"));
                }
                failures.push(name);
            }
            Outcome::Skip => counts.2 += 1,
        }
    }
    let (pass, fail, skip) = by_category.values().fold((0, 0, 0), |a, c| (a.0 + c.0, a.1 + c.1, a.2 + c.2));
    eprintln!("CSL test suite: {pass} passed, {fail} failed, {skip} skipped");
    for (category, (p, f, s)) in &by_category {
        eprintln!("  {category:<16} {p:>3} passed {f:>3} failed {s:>3} skipped");
    }
    if std::env::var_os("CSL_TEST_SUITE_VERBOSE").is_some() {
        eprintln!("failed: {}", failures.join(" "));
    }
    assert!(known_failed.is_empty(), "known-good cases failed:\n{}", known_failed.join("\n"));
}
