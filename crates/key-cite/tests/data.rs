// The shipped citation data: `data/citation/index.json` matches the style and locale files
// (`KEY_UPDATE_CITATION_INDEX=1 cargo test -p key-cite --test data` rewrites it), and without
// the folder Key still renders with its own basic style and English terms.
use key_cite::{
    CitationInput, CiteItem, RenderRequest, Styles,
    data::{CitationData, FALLBACK_STYLE, build_index, index_json},
};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};

fn data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data/citation")
}

#[test]
fn the_index_matches_the_files() {
    let dir = data_dir();
    let index = build_index(&dir).unwrap();
    assert!(index.styles.len() >= 55 && index.locales.len() >= 60);
    let text = index_json(&index);
    let path = dir.join("index.json");
    if std::env::var_os("KEY_UPDATE_CITATION_INDEX").is_some() {
        std::fs::write(&path, &text).unwrap();
    }
    let saved = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(saved == text, "data/citation/index.json is out of date: run KEY_UPDATE_CITATION_INDEX=1 cargo test -p key-cite --test data");
    // Ids are unique and name their files.
    for style in &index.styles {
        assert_eq!(format!("{}.csl", style.summary.id), style.file);
    }
    assert!(dir.join("NOTICE").is_file());
}

#[test]
fn styles_come_from_the_data_folder() {
    let data = Arc::new(CitationData::open(Some(data_dir())));
    assert!(data.status().available);
    let styles = Styles::with_data(None, data);
    assert_eq!(styles.default_id(), "apa");
    assert!(styles.list().iter().any(|s| s.id == "nature" && s.bundled));
    assert!(styles.summary(FALLBACK_STYLE).is_some());
    assert!(styles.style("ieee").is_ok());
}

#[test]
fn a_missing_data_folder_falls_back() {
    let data = Arc::new(CitationData::open(Some(PathBuf::from("/nonexistent/key-citation-data"))));
    let status = data.status();
    assert!(!status.available);
    assert!(status.error.unwrap().starts_with("Citation styles not found"));
    assert_eq!(data.locale_codes(), vec!["en-US".to_string()]);
    let styles = Styles::with_data(None, data.clone());
    assert_eq!(styles.default_id(), FALLBACK_STYLE);
    let list = styles.list();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].format, "author-date");
    assert!(styles.style("apa").is_err());
    let style = styles.style(FALLBACK_STYLE).unwrap();
    let items = vec![json!({
        "id": "a", "type": "article-journal", "title": "A sample title",
        "author": [{ "family": "Doe", "given": "Jane" }, { "family": "Roe", "given": "Rick" }, { "family": "Poe", "given": "Pat" }],
        "issued": { "date-parts": [[2020]] }, "container-title": "Journal", "volume": "1", "page": "1-2"
    })];
    let request = RenderRequest {
        citations: vec![CitationInput { items: vec![CiteItem { id: "a".into(), locator: Some("2".into()), ..Default::default() }], note_number: None }],
        bibliography: true,
        uncited: vec![],
    };
    let out = key_cite::render::render_in(&data, &style, None, &items, &request).unwrap();
    assert_eq!(out.citations[0].text, "(Doe et al., 2020, p. 2)");
    let entry = &out.bibliography.unwrap().entries[0].formatted.text;
    assert!(entry.starts_with("Doe, J., Roe, R., and Poe, P. (2020). A sample title."), "{entry}");
}
