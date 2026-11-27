// Year suffixes, cite grouping and dates as the CSL specification has them: suffixes follow
// the bibliography's order, collapsed years join with the cite-group delimiter (", " by
// default), a year-only date leaves no stray delimiter, and a date range keeps its end.
use key_cite::{CitationInput, CiteItem, RenderRequest, Styles, render};
use serde_json::{Value as Json, json};

fn items() -> Vec<Json> {
    vec![
        // Cited first, sorted second in the bibliography (by title): "b".
        json!({ "id": "m", "type": "article-journal", "title": "Measuring attention in reading", "author": [{ "family": "Doe", "given": "Jane" }],
                "issued": { "date-parts": [[2020]] }, "container-title": "Cognition", "volume": "201", "page": "104-118" }),
        json!({ "id": "a", "type": "article-journal", "title": "Attention across scripts", "author": [{ "family": "Doe", "given": "Jane" }],
                "issued": { "date-parts": [[2020]] }, "container-title": "Cognition", "volume": "205", "page": "1-15" }),
        json!({ "id": "web", "type": "webpage", "title": "A page without a day", "author": [{ "family": "Smith", "given": "Anna" }],
                "issued": { "date-parts": [[2021]] }, "container-title": "Example", "URL": "https://example.org/page" }),
        json!({ "id": "news", "type": "article-newspaper", "title": "A story", "author": [{ "family": "Lee", "given": "Bo" }],
                "issued": { "date-parts": [[2019]] }, "container-title": "The Daily" }),
        json!({ "id": "range", "type": "paper-conference", "title": "A meeting over days", "author": [{ "family": "Kim", "given": "Ha" }],
                "issued": { "date-parts": [[2018, 5, 3], [2018, 5, 7]] }, "event-title": "A conference" }),
        json!({ "id": "years", "type": "book", "title": "A book written over years", "author": [{ "family": "Ng", "given": "Ai" }],
                "issued": { "date-parts": [[2001], [2004]] }, "publisher": "Press" }),
    ]
}

fn run(style: &str) -> key_cite::RenderOutput {
    let style = Styles::new(None).style(style).unwrap();
    let cite = |id: &str| CiteItem { id: id.into(), ..Default::default() };
    let request = RenderRequest {
        citations: vec![CitationInput { items: vec![cite("m"), cite("a")], note_number: None }, CitationInput { items: vec![cite("web")], note_number: None }],
        bibliography: true,
        uncited: vec!["news".into(), "range".into(), "years".into()],
    };
    render(&style, None, &items(), &request).unwrap()
}

fn entry(out: &key_cite::RenderOutput, id: &str) -> String {
    out.bibliography.as_ref().unwrap().entries.iter().find(|e| e.id == id).unwrap().formatted.text.clone()
}

#[test]
fn year_suffixes_follow_the_bibliography_and_collapse_with_a_comma() {
    let out = run("apa");
    // "Attention…" sorts first, so it is 2020a although "Measuring…" was cited first.
    assert!(entry(&out, "a").starts_with("Doe, J. (2020a). Attention across scripts."), "{}", entry(&out, "a"));
    assert!(entry(&out, "m").starts_with("Doe, J. (2020b). Measuring attention"), "{}", entry(&out, "m"));
    // The citation lists them in suffix order.
    assert_eq!(out.citations[0].text, "(Doe, 2020a, 2020b)");
    let chicago = run("chicago-author-date");
    // Chicago does not sort citations: the order cited stays.
    assert_eq!(chicago.citations[0].text, "(Doe 2020b, 2020a)");
}

#[test]
fn year_only_dates_leave_no_stray_delimiter() {
    let out = run("apa");
    let web = entry(&out, "web");
    assert!(web.starts_with("Smith, A. (2021). A page without a day."), "{web}");
    let news = entry(&out, "news");
    assert!(news.starts_with("Lee, B. (2019). A story."), "{news}");
}

#[test]
fn date_ranges_keep_their_end() {
    let out = run("apa");
    let years = entry(&out, "years");
    assert!(years.contains("(2001–2004)"), "{years}");
    let range = entry(&out, "range");
    assert!(range.contains("2018, May 3–7"), "{range}");
}
