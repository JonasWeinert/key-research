// Parse → Key → write → parse on realistic files, the import's duplicate handling and undo,
// and a large file.
use key_biblio::export::{self, ExportOptions, Scope};
use key_biblio::import::{self, DuplicatePolicy, ImportOptions};
use key_biblio::latex::Encoding;
use key_biblio::{Format, Record, parse};
use key_store::Store;
use serde_json::{Value as Json, json};
use std::time::Instant;

const NASTY: &str = include_str!("fixtures/nasty.bib");
const RIS: &str = include_str!("fixtures/sample.ris");

fn summary(record: &Record) -> Json {
    let f = &record.source.fields;
    let get = |name: &str| f.get(name).cloned().unwrap_or(Json::Null);
    let mut tags = record.source.tags.clone();
    tags.sort();
    let creators: Vec<Json> = record.source.creators.iter().map(|c| json!([c.family, c.given, c.literal, c.role])).collect();
    json!({
        "itemType": get("itemType"), "title": get("title"), "creators": creators, "date": get("date"), "year": get("year"),
        "container": get("containerTitle"), "volume": get("volume"), "issue": get("issue"), "pages": get("pages"), "doi": get("doi"),
        "isbn": get("isbn"), "issn": get("issn"), "url": get("url"), "arxiv": get("arxivId"), "place": get("place"),
        "publisher": get("publisher"), "institution": get("institution"), "abstract": get("abstract"), "extra": get("extra"),
        "tags": tags, "key": get("citationKey"),
    })
}

fn by_key(records: &[Record]) -> Vec<Json> {
    let mut out: Vec<Json> = records.iter().map(summary).collect();
    out.sort_by_key(|r| r["title"].as_str().unwrap_or("").to_lowercase());
    out
}

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    (dir, store)
}

fn import_all(store: &Store, text: &str, format: Format) -> import::Report {
    let parsed = parse(text, format, &|_, _| {}).unwrap();
    let options = ImportOptions { notes: true, files: true, groups: true, duplicates: DuplicatePolicy::Skip, ..Default::default() };
    import::run(store, parsed, &options, "test", &|_| {}, &|_, _| Ok(())).unwrap()
}

#[test]
fn nasty_bibtex_reads_as_expected() {
    let parsed = parse(NASTY, Format::Bibtex, &|_, _| {}).unwrap();
    let find = |key: &str| parsed.records.iter().find(|r| r.citation_key() == Some(key)).unwrap_or_else(|| panic!("{key} missing"));
    let text = |r: &Record, f: &str| r.source.fields.get(f).and_then(Json::as_str).map(String::from);
    // One broken entry is reported with its line; parsing resumes after it.
    assert_eq!(parsed.records.len(), 9, "{:?}", parsed.records.iter().map(|r| r.citation_key()).collect::<Vec<_>>());
    assert_eq!(parsed.warnings.len(), 1, "{:?}", parsed.warnings);
    assert!(parsed.warnings[0].message.contains("broken") || parsed.warnings[0].line >= 70, "{:?}", parsed.warnings);
    let s = find("schroedinger1926");
    assert_eq!(text(s, "title").as_deref(), Some("Quantisierung als Eigenwertproblem"));
    assert_eq!(s.source.creators[0].family.as_deref(), Some("Schrödinger"));
    assert_eq!(text(s, "date").as_deref(), Some("1926-01"));
    assert_eq!(text(s, "pages").as_deref(), Some("361-376"));
    assert_eq!(s.source.tags, ["quantum mechanics", "wave equation"]);
    let smith = find("Smith2020a");
    assert_eq!(text(smith, "title").as_deref(), Some("The α-Helix in DNA–Protein Binding: A Nested Brace Study"));
    assert_eq!(text(smith, "containerTitle").as_deref(), Some("Nature"));
    assert_eq!(text(smith, "doi").as_deref(), Some("10.1038/S41586-020-0001-X"));
    assert_eq!(text(smith, "abstract").as_deref(), Some(r"We study $\mathcal{O}(n \log n)$ algorithms and 50% of cases."));
    assert_eq!(smith.source.creators.len(), 3);
    assert_eq!(smith.source.creators[1].family.as_deref(), Some("van der Berg"));
    assert_eq!(smith.source.creators[2].given.as_deref(), Some("Martin Luther, Jr."));
    assert_eq!(smith.source.properties.get("bibtex.etal").and_then(Json::as_str), Some("author"));
    assert_eq!(smith.source.properties.get("bibtex.addendum").and_then(Json::as_str), Some("Corrected version"));
    assert_eq!(smith.files, ["/nonexistent/smith2020.pdf"]);
    assert!(smith.notes[0].starts_with("Read this first.") && smith.notes[0].ends_with("Second paragraph."), "{:?}", smith.notes);
    let who = find("who2019");
    assert_eq!(who.source.creators[0].literal.as_deref(), Some("World Health Organization"));
    assert_eq!(text(who, "place").as_deref(), Some("Genève"));
    let lamport = find("lamport1978");
    assert_eq!(text(lamport, "containerTitle").as_deref(), Some("IEEE Transactions on Software Engineering"));
    // Crossref fills what the child lacks (editor, publisher) without overriding.
    assert_eq!(text(lamport, "publisher").as_deref(), Some("ACM"));
    assert!(lamport.source.creators.iter().any(|c| c.role == "editor"));
    let thesis = find("ozturk2015");
    assert_eq!(text(thesis, "title").as_deref(), Some("Straßenverkehr in Großstädten"));
    assert_eq!(thesis.source.creators[1].family.as_deref(), Some("Ødegård"));
    assert_eq!(text(thesis, "institution").as_deref(), Some("Technische Universität München"));
    assert_eq!(text(find("arxiv2021"), "arxivId").as_deref(), Some("2101.00001"));
    let online = find("biblatex2022");
    assert_eq!(text(online, "title").as_deref(), Some("A BibLaTeX Online Entry: With a Subtitle"));
    assert_eq!(text(online, "itemType").as_deref(), Some("webpage"));
    assert_eq!(text(online, "date").as_deref(), Some("2022-03-14"));
}

// Ported from the renderer's old reference-import tests.
#[test]
fn small_pastes_read_without_fabricating_fields() {
    let parsed = parse("@article{a,title={A {Nested} title},author={Alice and Bob},year={2024},doi={10.1234/test}}", Format::Bibtex, &|_, _| {}).unwrap();
    let r = &parsed.records[0];
    assert_eq!(r.title(), "A Nested title");
    assert_eq!(r.source.creators.iter().map(|c| c.family.clone().unwrap()).collect::<Vec<_>>(), ["Alice", "Bob"]);
    assert_eq!(r.source.fields.get("doi").and_then(Json::as_str), Some("10.1234/test"));
    let parsed = parse("TY  - JOUR\nTI  - Paper\nAU  - Alice\nPY  - 2023/01/01\nER  -\nTY  - BOOK\nTI  - Book\nER  -", Format::Ris, &|_, _| {}).unwrap();
    assert_eq!(parsed.records.len(), 2);
    assert_eq!(parsed.records[0].source.fields.get("year").and_then(Json::as_i64), Some(2023));
    assert!(parsed.records[1].source.fields.get("year").is_none());
    assert_eq!(key_biblio::detect("nothing", None), None);
}

fn roundtrip(text: &str, read: Format, write: Format, encoding: Encoding) {
    let (_dir, store) = store();
    let first = parse(text, read, &|_, _| {}).unwrap();
    let report = import_all(&store, text, read);
    assert_eq!(report.added, first.records.len());
    let options = ExportOptions { notes: false, abstracts: true, files: false, keywords: true, encoding };
    let (written, count) = export::export(&store, &Scope::default(), write, &options).unwrap();
    assert_eq!(count, first.records.len());
    let second = parse(&written, write, &|_, _| {}).unwrap();
    assert!(second.warnings.is_empty(), "{:?}\n{written}", second.warnings);
    let a = by_key(&first.records);
    let b = by_key(&second.records);
    for (x, y) in a.iter().zip(&b) {
        let mut x = x.clone();
        let mut y = y.clone();
        // Keys the file lacked were generated on import.
        if x["key"].is_null() {
            x["key"] = Json::Null;
            y["key"] = Json::Null;
        }
        // CSL-JSON gives an arXiv preprint its abstract page as URL (key-cite's mapping).
        if x["url"].is_null() && y["url"].as_str().is_some_and(|u| u.starts_with("https://arxiv.org/abs/")) {
            y["url"] = Json::Null;
        }
        assert_eq!(x, y, "\n{written}");
    }
    assert_eq!(a.len(), b.len());
}

#[test]
fn bibtex_roundtrips_in_unicode_and_latex() {
    roundtrip(NASTY, Format::Bibtex, Format::Bibtex, Encoding::Unicode);
    roundtrip(NASTY, Format::Bibtex, Format::Bibtex, Encoding::Latex);
    roundtrip(NASTY, Format::Bibtex, Format::Biblatex, Encoding::Unicode);
}

#[test]
fn ris_roundtrips() {
    roundtrip(RIS, Format::Ris, Format::Ris, Encoding::Unicode);
}

#[test]
fn csl_json_roundtrips() {
    roundtrip(NASTY, Format::Bibtex, Format::CslJson, Encoding::Unicode);
}

#[test]
fn csv_roundtrips() {
    roundtrip(RIS, Format::Ris, Format::Csv, Encoding::Unicode);
}

#[test]
fn duplicates_are_skipped_and_imports_undo() {
    let (_dir, store) = store();
    let first = import_all(&store, NASTY, Format::Bibtex);
    assert_eq!(first.added, 9);
    // Again: the ones with identifiers are exact duplicates, the rest possible ones.
    let second = import_all(&store, NASTY, Format::Bibtex);
    assert_eq!(second.skipped, 4, "{second:?}");
    assert_eq!(second.flagged.len(), 5);
    // Keys stay unique: the second copies got suffixes.
    let keys: Vec<String> = export::sources(&store, &Scope::default()).unwrap().iter().filter_map(|s| s.field("citationKey").map(String::from)).collect();
    let mut unique = keys.clone();
    unique.sort();
    unique.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    assert_eq!(unique.len(), keys.len());
    assert!(keys.iter().any(|k| k == "Smith2020a"));
    import::undo(&store, &second.id).unwrap();
    assert_eq!(export::sources(&store, &Scope::default()).unwrap().len(), 9);
    // Pinned imported keys survive regeneration of the pattern.
    store.set_citation_key_pattern("auth.lower + year", true).unwrap();
    let source = export::sources(&store, &Scope::default()).unwrap().into_iter().find(|s| s.title().starts_with("Quantisierung")).unwrap();
    assert_eq!(source.field("citationKey"), Some("schroedinger1926"));
    import::undo(&store, &first.id).unwrap();
    assert_eq!(export::sources(&store, &Scope::default()).unwrap().len(), 0);
    assert!(store.property_definitions().unwrap().iter().all(|d| !d["name"].as_str().unwrap().starts_with("bibtex.")));
}

#[test]
fn merge_fills_empty_fields_and_undo_restores() {
    let (_dir, store) = store();
    import_all(&store, "@article{a, title = {Only a title here please}, doi = {10.1/x}}", Format::Bibtex);
    let parsed = parse("@article{b, title = {Only a title here please}, doi = {10.1/X}, volume = {7}, keywords = {merged}}", Format::Bibtex, &|_, _| {}).unwrap();
    let options = ImportOptions { duplicates: DuplicatePolicy::Merge, ..Default::default() };
    let report = import::run(&store, parsed, &options, "merge", &|_| {}, &|_, _| Ok(())).unwrap();
    assert_eq!((report.added, report.merged), (0, 1));
    let source = &export::sources(&store, &Scope::default()).unwrap()[0];
    assert_eq!(source.field("volume"), Some("7"));
    assert_eq!(source.tags, ["merged"]);
    import::undo(&store, &report.id).unwrap();
    let source = &export::sources(&store, &Scope::default()).unwrap()[0];
    assert_eq!(source.field("volume"), None);
    assert!(source.tags.is_empty());
}

#[test]
fn quick_copy_formats() {
    let (_dir, store) = store();
    import_all(&store, NASTY, Format::Bibtex);
    let ids: Vec<String> = export::sources(&store, &Scope::default()).unwrap().iter().filter(|s| s.title().starts_with("Quantisierung") || s.title().starts_with("World")).map(|s| s.id.clone()).collect();
    let pandoc = export::quick_copy(&store, &ids, "pandoc").unwrap();
    assert!(pandoc.starts_with("[@") && pandoc.contains("@who2019") && pandoc.contains("; "), "{pandoc}");
    let latex = export::quick_copy(&store, &ids, "latex").unwrap();
    assert!(latex.starts_with("\\cite{") && latex.contains("schroedinger1926"));
    let bib = export::quick_copy(&store, &ids[..1], "bibtex").unwrap();
    assert!(bib.starts_with('@'));
    let ris = export::quick_copy(&store, &ids[..1], "ris").unwrap();
    assert!(ris.starts_with("TY  - "));
}

#[test]
fn auto_export_rewrites_only_on_change() {
    let (dir, store) = store();
    import_all(&store, RIS, Format::Ris);
    let path = dir.path().join("library.bib");
    let target = key_biblio::autoexport::upsert(
        &store,
        key_biblio::autoexport::Target {
            id: String::new(),
            collection_id: None,
            format: Format::Bibtex,
            path: path.clone(),
            options: ExportOptions::default(),
            last_written: None,
            last_checked: None,
            last_error: None,
            count: None,
        },
    )
    .unwrap();
    assert!(target.last_error.is_none(), "{target:?}");
    let first = std::fs::read_to_string(&path).unwrap();
    assert_eq!(first.matches("\n@").count() + 1, 3);
    let written = target.last_written;
    std::thread::sleep(std::time::Duration::from_millis(5));
    let again = key_biblio::autoexport::run(&store, None).unwrap();
    assert_eq!(again[0].last_written, written, "unchanged library, unchanged file");
    let id = export::sources(&store, &Scope::default()).unwrap()[0].id.clone();
    let mut patch = serde_json::Map::new();
    patch.insert("volume".into(), json!("99"));
    store.update_source(&id, &patch).unwrap();
    key_biblio::autoexport::run(&store, None).unwrap();
    let second = std::fs::read_to_string(&path).unwrap();
    assert!(second.contains("volume = {99}"));
    // Only that entry's lines changed.
    let changed = first.lines().zip(second.lines()).filter(|(a, b)| a != b).count();
    assert!(changed <= 2, "{changed} lines changed");
}

#[test]
fn large_files_stay_fast() {
    let mut text = String::new();
    for i in 0..12_000 {
        text.push_str(&format!(
            // Mostly distinct family names, as in a real library (people sharing one are
            // compared for merge suggestions as each source is added).
            "@article{{k{i},\n  author = {{M{{\\\"u}}ller{}, J{i} and Smith, A. and others}},\n  title = {{A study of {{DNA}} number {i} in $\\alpha$ cells}},\n  journal = {{Journal {}}},\n  year = {{{}}},\n  doi = {{10.1000/{i}}},\n  keywords = {{one, two}},\n}}\n\n",
            i % 4000,
            i % 50,
            1990 + i % 30
        ));
    }
    let start = Instant::now();
    let parsed = parse(&text, Format::Bibtex, &|_, _| {}).unwrap();
    let parse_time = start.elapsed();
    assert_eq!(parsed.records.len(), 12_000);
    assert!(parse_time.as_secs_f64() < 5.0, "parse took {parse_time:?}");
    let (_dir, store) = store();
    let start = Instant::now();
    let report = import::run(&store, parsed, &ImportOptions::default(), "large", &|_| {},&|_, _| Ok(())).unwrap();
    let import_time = start.elapsed();
    assert_eq!(report.added, 12_000);
    let start = Instant::now();
    let (written, _) = export::export(&store, &Scope::default(), Format::Bibtex, &ExportOptions::default()).unwrap();
    let export_time = start.elapsed();
    assert!(written.len() > 1_000_000);
    eprintln!("12k entries: parse {parse_time:?}, import {import_time:?}, export {export_time:?}");
    assert!(import_time.as_secs_f64() < 120.0);
}
