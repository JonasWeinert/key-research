// The engine on a fixture library: every bundled style renders, the headline styles match
// their golden output (`UPDATE_GOLDEN=1 cargo test -p key-cite` rewrites them), and the
// features Key relies on (locators, affixes, suppressed authors, disambiguation, numbering,
// notes, locales, the three output formats) behave.
use key_cite::{CitationInput, CiteItem, RenderRequest, Styles, csl_json, render};
use serde_json::{Value as Json, json};
use std::path::PathBuf;

fn library() -> Vec<Json> {
    let raw: Vec<Json> = serde_json::from_str(include_str!("fixtures/library.json")).unwrap();
    raw.into_iter()
        .map(|mut s| {
            let m = s.as_object_mut().unwrap();
            for (k, v) in [
                ("tags", json!([])),
                ("properties", json!({})),
                ("collections", json!([])),
                ("starred", json!(false)),
                ("indexStatus", json!("ready")),
                ("indexedChunks", json!(0)),
                ("indexTotal", json!(0)),
                ("addedAt", json!(0)),
                ("updatedAt", json!(0)),
                ("noteCount", json!(0)),
                ("annotationCount", json!(0)),
            ] {
                m.entry(k).or_insert(v);
            }
            let source: key_store::Source = serde_json::from_value(s).unwrap();
            csl_json::from_source(&source)
        })
        .collect()
}

fn cite(id: &str) -> CiteItem {
    CiteItem { id: id.into(), ..Default::default() }
}
fn one(item: CiteItem) -> CitationInput {
    CitationInput { items: vec![item], note_number: None }
}

/// A short document: plain, with a page, author named in the text, a repeat, a group, the
/// disambiguation pairs, and everything else in the bibliography only.
fn document() -> RenderRequest {
    RenderRequest {
        citations: vec![
            one(cite("narang2021")),
            one(CiteItem { locator: Some("12".into()), ..cite("kahneman2011") }),
            one(CiteItem { suppress_author: true, ..cite("palma2022") }),
            one(CiteItem { locator: Some("626".into()), ..cite("narang2021") }),
            CitationInput { items: vec![cite("doe2020a"), cite("doe2020b")], note_number: None },
            CitationInput { items: vec![cite("smitha2019"), cite("smithb2019")], note_number: None },
            one(CiteItem { prefix: Some("see".into()), suffix: Some("for a review".into()), ..cite("vaswani2017") }),
        ],
        bibliography: true,
        uncited: vec!["who2023".into(), "lee2018".into(), "ipcc2021".into(), "he2016".into()],
    }
}

fn styles() -> Styles {
    Styles::new(None)
}

fn run(style: &str, locale: Option<&str>, request: &RenderRequest) -> key_cite::RenderOutput {
    let style = styles().style(style).unwrap();
    render(&style, locale, &library(), request).unwrap()
}

#[test]
fn every_bundled_style_renders() {
    let styles = styles();
    let list = styles.list();
    assert!(list.len() >= 55, "{} styles", list.len());
    for summary in list {
        let style = styles.style(&summary.id).unwrap_or_else(|e| panic!("{}: {e}", summary.id));
        let out = render(&style, None, &library(), &document()).unwrap_or_else(|e| panic!("{}: {e}", summary.id));
        assert_eq!(out.citations.len(), 7, "{}", summary.id);
        assert!(out.citations.iter().all(|c| !c.text.is_empty()), "{}: empty citation {:?}", summary.id, out.citations);
        // The Bluebook styles have no bibliography.
        match out.bibliography {
            Some(bib) => assert_eq!(bib.entries.len(), 12, "{}", summary.id),
            None => assert!(summary.id.starts_with("bluebook"), "{}: no bibliography", summary.id),
        }
        assert!(out.missing.is_empty());
    }
}

const HEADLINE: &[&str] = &[
    "apa",
    "chicago-author-date",
    "chicago-notes-bibliography",
    "modern-language-association",
    "harvard-cite-them-right",
    "ieee",
    "nlm-citation-sequence",
    "american-medical-association",
    "nature",
    "science",
    "cell",
    "american-chemical-society",
    "american-political-science-association",
    "american-sociological-association",
    "bluebook-law-review",
    "bibtex",
];

#[test]
fn headline_styles_match_golden_output() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let update = std::env::var_os("UPDATE_GOLDEN").is_some();
    let mut failures = Vec::new();
    for id in HEADLINE {
        let out = run(id, None, &document());
        let mut text = String::from("Citations:\n");
        for c in &out.citations {
            text.push_str(&c.text);
            text.push('\n');
        }
        text.push_str("\nBibliography:\n");
        text.push_str(&out.bibliography.map(|b| b.formatted.text).unwrap_or_else(|| "(none)".into()));
        text.push('\n');
        let path = dir.join(format!("{id}.txt"));
        if update {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(&path, &text).unwrap();
        } else if std::fs::read_to_string(&path).unwrap_or_default() != text {
            failures.push(format!("{id}:\n{text}"));
        }
    }
    assert!(failures.is_empty(), "golden output differs:\n{}", failures.join("\n"));
}

#[test]
fn apa_citations() {
    let out = run("apa", None, &document());
    let c: Vec<&str> = out.citations.iter().map(|c| c.text.as_str()).collect();
    assert_eq!(c[0], "(Narang et al., 2021)");
    assert_eq!(c[1], "(Kahneman, 2011, p. 12)");
    assert_eq!(c[2], "(2022)");
    assert_eq!(c[3], "(Narang et al., 2021, p. 626)");
    // CSL's default cite-group delimiter is ", " (vendor/patches/hayagriva/0004).
    assert_eq!(c[4], "(Doe, 2020a, 2020b)");
    assert_eq!(c[5], "(A. Smith, 2019; B. Smith, 2019)");
    assert_eq!(c[6], "(see Vaswani et al., 2017 for a review)");
    let bib = out.bibliography.unwrap();
    let narang = bib.entries.iter().find(|e| e.id == "narang2021").unwrap();
    assert_eq!(
        narang.formatted.text,
        "Narang, A., Bae, R., Hong, H., Thomas, Y., & Surette, S. (2021). Utility of a deep-learning algorithm to guide novices to acquire echocardiograms for limited diagnostic use. JAMA Cardiology, 6(6), 624–632. https://doi.org/10.1001/jamacardio.2021.0185"
    );
    assert!(narang.formatted.html.contains("<i>JAMA Cardiology</i>"), "{}", narang.formatted.html);
    assert!(narang.formatted.rtf.contains("{\\i JAMA Cardiology"), "{}", narang.formatted.rtf);
    assert!(bib.hanging_indent);
    // Sorted by author.
    assert_eq!(bib.entries[0].id, "doe2020b");
    assert!(bib.entries[0].formatted.text.starts_with("Doe, J. (2020a). Attention"), "{}", bib.entries[0].formatted.text);
}

#[test]
fn narrative_and_author_only() {
    let request = RenderRequest {
        citations: vec![one(CiteItem { narrative: true, ..cite("narang2021") }), one(CiteItem { author_only: true, ..cite("kahneman2011") })],
        ..Default::default()
    };
    let out = run("apa", None, &request);
    assert_eq!(out.citations[0].text, "Narang et al. (2021)");
    assert_eq!(out.citations[1].text, "Kahneman");
}

#[test]
fn numeric_styles_number_in_citation_order() {
    let out = run("ieee", None, &document());
    let c: Vec<&str> = out.citations.iter().map(|c| c.text.as_str()).collect();
    assert_eq!(c[0], "[1]");
    assert_eq!(c[1], "[2, p. 12]");
    assert_eq!(c[3], "[1, p. 626]");
    let bib = out.bibliography.unwrap();
    assert!(bib.entries[0].formatted.text.starts_with("[1] A. Narang"), "{}", bib.entries[0].formatted.text);
    // Uncited works come after the cited ones.
    assert_eq!(bib.entries.len(), 12);
}

#[test]
fn note_styles_shorten_later_notes() {
    let out = run("chicago-notes-bibliography", None, &document());
    assert!(out.note_style);
    let first = &out.citations[0].text;
    let later = &out.citations[3].text;
    assert!(first.contains("Utility of a Deep-Learning Algorithm"), "{first}");
    assert!(later.len() < first.len(), "{later}");
    assert!(later.contains("626"), "{later}");
}

#[test]
fn locales_change_terms() {
    let out = run("apa", Some("de-DE"), &document());
    assert_eq!(out.citations[1].text, "(Kahneman, 2011, S. 12)");
    // APA keeps "et al." in German (its own locale section says so); Chicago uses the locale's "u. a.".
    assert_eq!(out.citations[0].text, "(Narang et al., 2021)");
    let out = run("chicago-author-date", Some("de-DE"), &document());
    assert!(out.citations[0].text.replace('\u{a0}', " ").contains("u. a."), "{}", out.citations[0].text);
}

#[test]
fn a_bibliography_of_a_selection() {
    let request = RenderRequest { bibliography: true, uncited: vec!["kahneman2011".into(), "narang2021".into(), "nope".into()], ..Default::default() };
    let out = run("ieee", None, &request);
    let bib = out.bibliography.unwrap();
    assert_eq!(bib.entries.len(), 2);
    assert!(bib.entries[0].formatted.text.starts_with("[1] D. Kahneman"), "{}", bib.entries[0].formatted.text);
    assert_eq!(out.missing, vec!["nope".to_string()]);
    assert!(bib.formatted.rtf.starts_with("{\\rtf1"));
    assert!(bib.formatted.html.starts_with("<div class=\"csl-bib-body\">"));
}

#[test]
fn installing_and_removing_a_style() {
    let dir = std::env::temp_dir().join(format!("key-cite-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let styles = Styles::new(Some(dir.clone()));
    let xml = include_str!("../../../data/citation/styles/apa.csl").replace("http://www.zotero.org/styles/apa\"", "http://www.zotero.org/styles/my-apa\"").replace(
        "<id>http://www.zotero.org/styles/apa</id>",
        "<id>http://www.zotero.org/styles/my-apa</id>",
    );
    let xml = xml.replacen("<title>APA Style 7th edition</title>", "<title>My APA</title>", 1);
    let summary = styles.install(&xml).unwrap();
    assert_eq!(summary.id, "my-apa");
    assert_eq!(summary.title, "My APA");
    assert!(styles.list().iter().any(|s| s.id == "my-apa" && !s.bundled));
    let out = render(&styles.style("my-apa").unwrap(), None, &library(), &document()).unwrap();
    assert_eq!(out.citations[0].text, "(Narang et al., 2021)");
    assert!(styles.install("<html>not a style</html>").is_err());
    // A dependent style renders with its parent.
    let dependent = r#"<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" default-locale="en-GB">
  <info>
    <title>Journal of Examples</title>
    <id>http://www.zotero.org/styles/journal-of-examples</id>
    <link href="http://www.zotero.org/styles/journal-of-examples" rel="self"/>
    <link href="http://www.zotero.org/styles/nature" rel="independent-parent"/>
    <category citation-format="numeric"/>
    <updated>2024-01-01T00:00:00+00:00</updated>
  </info>
</style>"#;
    let summary = styles.install(dependent).unwrap();
    assert_eq!(summary.parent.as_deref(), Some("nature"));
    let out = render(&styles.style("journal-of-examples").unwrap(), None, &library(), &document()).unwrap();
    assert_eq!(out.citations[0].text, "1");
    assert!(styles.remove("my-apa").unwrap());
    assert!(styles.style("my-apa").is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn csl_json_mapping() {
    let items = library();
    let narang = &items[0];
    assert_eq!(narang["type"], "article-journal");
    assert_eq!(narang["DOI"], "10.1001/jamacardio.2021.0185");
    assert_eq!(narang["issued"], json!({ "date-parts": [[2021, 2, 1]] }));
    assert_eq!(narang["author"].as_array().unwrap().len(), 5);
    assert_eq!(narang["container-title-short"], "JAMA Cardiol");
    assert_eq!(narang["PMID"], "33599681");
    let palma = &items[2];
    assert_eq!(palma["type"], "chapter");
    assert_eq!(palma["editor"], json!([{ "family": "Lusk", "given": "Jayson L." }]));
    assert_eq!(palma["author"].as_array().unwrap().len(), 2);
    let who = &items[7];
    assert_eq!(who["type"], "webpage");
    assert_eq!(who["author"], json!([{ "literal": "World Health Organization" }]));
    assert_eq!(who["accessed"], json!({ "date-parts": [[2024, 1, 15]] }));
    let thesis = &items[8];
    assert_eq!(thesis["publisher"], "University of Toronto");
    let preprint = &items[9];
    assert_eq!(preprint["type"], "article");
    assert_eq!(preprint["number"], "arXiv:1706.03762");
    assert_eq!(preprint["URL"], "https://arxiv.org/abs/1706.03762");
    assert_eq!(csl_json::csl_date(Some("March 4, 2021"), None), Some(json!({ "date-parts": [[2021, 3, 4]] })));
    assert_eq!(csl_json::csl_date(Some("3/4/2021"), None), Some(json!({ "date-parts": [[2021, 3, 4]] })));
    assert_eq!(csl_json::csl_date(Some("Spring 1999"), None), Some(json!({ "date-parts": [[1999]] })));
    assert_eq!(csl_json::csl_date(None, Some(1984)), Some(json!({ "date-parts": [[1984]] })));
    assert_eq!(csl_json::item_type_from_csl("paper-conference"), "conference-paper");
    for (key, _) in [("article", 0), ("webpage", 0), ("thesis", 0), ("chapter", 0), ("report", 0), ("preprint", 0)] {
        assert_eq!(csl_json::item_type_from_csl(csl_json::csl_type(key)), key);
    }
}

// Ported from the renderer's former citation.test.ts / citation-styles.test.ts.
#[test]
fn formats_the_cases_the_typescript_formatters_covered() {
    let palma = json!({
        "id": "1", "type": "article-journal", "title": "Health versus income amid COVID-19: What do people value more?",
        "author": [{ "family": "Palma", "given": "Marco A." }, { "family": "Huseynov", "given": "Samir" }, { "family": "Nayga", "given": "Rodolfo M." }],
        "issued": { "date-parts": [[2022]] }, "container-title": "PLoS One", "volume": "17", "issue": "4", "page": "e0266237",
        "DOI": "10.1371/journal.pone.0266237"
    });
    let pair = {
        let mut p = palma.clone();
        p["id"] = json!("2");
        p["author"] = json!([{ "family": "Palma", "given": "Marco A." }, { "family": "Huseynov", "given": "Samir" }]);
        p
    };
    let report = json!({ "id": "3", "type": "book", "title": "Untitled report", "publisher": "WHO" });
    let kirkby = json!({
        "id": "k", "type": "article-journal", "title": "Education-related inequalities in beliefs and behaviors",
        "author": [{ "family": "Kirkby", "given": "Jane" }, { "family": "Smith", "given": "Ann" }, { "family": "Lee", "given": "Bo" }],
        "issued": { "date-parts": [[2022]] }, "container-title": "Journal of Health", "volume": "12", "issue": "3", "page": "4-19", "DOI": "10.1/xyz"
    });
    let items = vec![palma, pair, report, kirkby];
    let bib = |style: &str, id: &str| {
        let request = RenderRequest { bibliography: true, uncited: vec![id.into()], ..Default::default() };
        render(&styles().style(style).unwrap(), None, &items, &request).unwrap().bibliography.unwrap().entries.remove(0).formatted
    };
    let cite = |style: &str, item: CiteItem| render(&styles().style(style).unwrap(), None, &items, &RenderRequest { citations: vec![one(item)], ..Default::default() }).unwrap().citations.remove(0).text;
    assert_eq!(
        bib("apa", "1").text,
        "Palma, M. A., Huseynov, S., & Nayga, R. M. (2022). Health versus income amid COVID-19: What do people value more? PLoS One, 17(4), e0266237. https://doi.org/10.1371/journal.pone.0266237"
    );
    assert!(bib("apa", "1").html.contains("<i>PLoS One</i>, <i>17</i>(4)"), "{}", bib("apa", "1").html);
    assert_eq!(cite("apa", cite_id("1")), "(Palma et al., 2022)");
    assert_eq!(cite("apa", cite_id("2")), "(Palma & Huseynov, 2022)");
    assert_eq!(bib("apa", "3").text, "Untitled report. (n.d.). WHO.");
    assert_eq!(cite("apa", CiteItem { locator: Some("4".into()), ..cite_id("k") }), "(Kirkby et al., 2022, p. 4)");
    // Chicago 18 shortens three or more authors to "et al." (17 listed up to three).
    assert_eq!(cite("chicago-author-date", CiteItem { locator: Some("4".into()), ..cite_id("k") }), "(Kirkby et al. 2022, 4)");
    assert!(bib("apa", "k").text.contains("Kirkby, J., Smith, A., & Lee, B. (2022)."));
    assert_eq!(
        bib("chicago-author-date", "k").text,
        "Kirkby, Jane, Ann Smith, and Bo Lee. 2022. “Education-Related Inequalities in Beliefs and Behaviors.” Journal of Health 12 (3): 4–19. https://doi.org/10.1/xyz."
    );
    assert_eq!(
        bib("modern-language-association", "k").text,
        "Kirkby, Jane, et al. “Education-Related Inequalities in Beliefs and Behaviors.” Journal of Health, vol. 12, no. 3, 2022, pp. 4–19, https://doi.org/10.1/xyz."
    );
    assert!(bib("modern-language-association", "k").html.contains("<i>Journal of Health</i>"));
    let bibtex = bib("bibtex", "1").text;
    assert!(bibtex.starts_with("@article{"), "{bibtex}");
    assert!(bibtex.contains("Palma, Marco A. and Huseynov, Samir and Nayga, Rodolfo M."), "{bibtex}");
}

fn cite_id(id: &str) -> CiteItem {
    cite(id)
}

#[test]
fn quote_attributions() {
    let items = library();
    let attribution = |style: &str| key_cite::render::attribution(&styles().style(style).unwrap(), None, &items[0], Some("4"), None).unwrap().text;
    assert_eq!(attribution("apa"), "Narang et al., 2021, p. 4");
    assert_eq!(attribution("modern-language-association"), "Narang et al. 4");
    assert!(attribution("ieee").starts_with("A. Narang, R. Bae"), "{}", attribution("ieee"));
    assert!(attribution("ieee").ends_with(", p. 4"), "{}", attribution("ieee"));
    let note = attribution("chicago-notes-bibliography");
    assert!(note.starts_with("Akhil Narang et al., “Utility") && note.contains("4"), "{note}");
}

#[test]
fn locales_are_all_bundled() {
    let list = key_cite::styles::locale_list();
    assert!(list.len() >= 60);
    let data = key_cite::data::CitationData::global();
    for locale in &list {
        assert!(data.locale(&locale.code).is_some(), "{} parses", locale.code);
    }
}
