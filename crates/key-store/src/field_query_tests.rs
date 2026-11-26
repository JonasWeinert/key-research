// Typed-out filters (field_query.rs) read by the parser and matched by the filter engine
// (filters.rs) against a real store, and both kept fast on a large library.
use super::*;
use serde_json::json;

fn input(value: Json) -> SourceInput {
    serde_json::from_value(value).unwrap()
}

/// The filters of the query's first reading, as the renderer hands them back to the store.
fn filters_of(store: &Store, text: &str) -> Vec<Filter> {
    let found = store.parse_query(text, false).unwrap();
    let first = found.first().unwrap_or_else(|| panic!("no reading of {text}"));
    serde_json::from_value(serde_json::to_value(&first.filters).unwrap()).unwrap()
}

fn titles(store: &Store, text: &str) -> Vec<String> {
    let page = store.list_sources(&ListQuery { filters: filters_of(store, text), limit: Some(100), ..Default::default() }).unwrap();
    let mut out: Vec<String> = page.items.iter().map(|s| s.title().to_string()).collect();
    out.sort();
    out
}

#[test]
fn typed_filters_match_every_kind_of_field() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store.save_property_definition("Rating", &json!({"type": "number"})).unwrap();
    store.save_property_definition("Reading status", &json!({"type": "select", "options": ["To read", "Done"]})).unwrap();
    store.save_property_definition("Reviewed", &json!({"type": "checkbox"})).unwrap();
    store.save_property_definition("Due", &json!({"type": "date"})).unwrap();
    store.save_property_definition("Methods", &json!({"type": "multiselect", "options": ["RCT", "Cohort", "Survey"]})).unwrap();
    let project = store.create_collection("Falls project", None, None).unwrap();
    let ids = store
        .insert_sources(vec![
            input(json!({"kind": "pdf", "itemType": "article", "title": "Alpha", "year": 2019, "doi": "10.1/a", "volume": "12", "abstract": "A randomised trial",
                "creators": [{"family": "Smith", "given": "Ann"}, {"family": "Jones", "role": "editor"}], "tags": ["methods/qual"], "language": "en",
                "properties": {"Rating": 4, "Reading status": "Done", "Reviewed": true, "Due": "2026-12-10", "Methods": ["RCT", "Survey"]}, "collections": [project.id]})),
            input(json!({"kind": "reference", "itemType": "book", "title": "Beta", "year": 2021, "publisher": "Elsevier",
                "creators": [{"family": "Doe"}], "tags": ["draft"], "properties": {"Rating": 2, "Reading status": "To read", "Reviewed": false, "Methods": ["Cohort"]}})),
            input(json!({"kind": "web", "itemType": "webpage", "title": "Gamma", "year": 2024, "url": "https://nature.com/x",
                "creators": [{"family": "Smith"}], "properties": {"Due": "2027-01-05"}})),
            input(json!({"kind": "reference", "itemType": "article", "title": "Alpha", "year": 2019, "doi": "10.1/A"})),
        ])
        .unwrap();
    store.save_note(None, Some(&ids[1]), "On Beta", "sampling frames", None).unwrap();

    assert_eq!(titles(&store, "rating>3"), ["Alpha"]);
    assert_eq!(titles(&store, "rating:1..3"), ["Beta"]);
    assert_eq!(titles(&store, "rating!=4"), ["Alpha", "Beta", "Gamma"]);
    assert_eq!(titles(&store, "\"reading status\":done"), ["Alpha"]);
    assert_eq!(titles(&store, "reading status:\"to read\""), ["Beta"]);
    assert_eq!(titles(&store, "reviewed:yes"), ["Alpha"]);
    assert_eq!(titles(&store, "reviewed:no"), ["Alpha", "Beta", "Gamma"]);
    assert_eq!(titles(&store, "due<2027-01-01"), ["Alpha"]);
    assert_eq!(titles(&store, "due:2027"), ["Gamma"]);
    assert_eq!(titles(&store, "methods:survey"), ["Alpha"]);
    assert_eq!(titles(&store, "methods:cohort|rct"), ["Alpha", "Beta"]);
    assert_eq!(titles(&store, "rating:empty"), ["Alpha", "Gamma"]);
    assert_eq!(titles(&store, "has:due"), ["Alpha", "Gamma"]);

    assert_eq!(titles(&store, "author:smith"), ["Alpha", "Gamma"]);
    assert_eq!(titles(&store, "editor:jones"), ["Alpha"]);
    assert_eq!(titles(&store, "-author:smith"), ["Alpha", "Beta"]);
    assert_eq!(titles(&store, "year:2019..2021"), ["Alpha", "Alpha", "Beta"]);
    assert_eq!(titles(&store, "year>2020"), ["Beta", "Gamma"]);
    assert_eq!(titles(&store, "type:book"), ["Beta"]);
    assert_eq!(titles(&store, "kind:web"), ["Gamma"]);
    assert_eq!(titles(&store, "publisher:elsevier"), ["Beta"]);
    assert_eq!(titles(&store, "volume:12"), ["Alpha"]);
    assert_eq!(titles(&store, "abstract:randomised"), ["Alpha"]);
    assert_eq!(titles(&store, "abstract:empty"), ["Alpha", "Beta", "Gamma"]);
    assert_eq!(titles(&store, "url:nature.com"), ["Gamma"]);
    assert_eq!(titles(&store, "tag:methods"), ["Alpha"]);
    assert_eq!(titles(&store, "-tag:draft is:untagged"), ["Alpha", "Gamma"]);
    assert_eq!(titles(&store, "collection:falls"), ["Alpha"]);
    assert_eq!(titles(&store, "is:unfiled"), ["Alpha", "Beta", "Gamma"]);
    assert_eq!(titles(&store, "has:notes"), ["Beta"]);
    assert_eq!(titles(&store, "notes:sampling"), ["Beta"]);
    assert_eq!(titles(&store, "has:pdf"), ["Alpha"]);
    assert_eq!(titles(&store, "is:duplicate"), ["Alpha", "Alpha"]);
    assert_eq!(titles(&store, "added:today"), ["Alpha", "Alpha", "Beta", "Gamma"]);
    assert_eq!(titles(&store, "added last week"), Vec::<String>::new());
    assert_eq!(titles(&store, "modified<2020-01-01"), Vec::<String>::new());
    assert_eq!(titles(&store, "status:unread"), ["Alpha", "Alpha", "Beta", "Gamma"]);
    assert_eq!(titles(&store, "kind:pdf OR kind:web"), ["Alpha", "Gamma"]);
    assert_eq!(titles(&store, "lang:en"), ["Alpha"]);

    // The field list names the workspace's properties with their types.
    let fields = store.filter_fields().unwrap();
    let ty = |name: &str| fields.iter().find(|f| f.key.as_deref() == Some(name)).map(|f| f.ty);
    assert_eq!(ty("Rating"), Some(field_query::FieldType::Number));
    assert_eq!(ty("Methods"), Some(field_query::FieldType::Select));
    assert_eq!(ty("Due"), Some(field_query::FieldType::Date));
    assert_eq!(ty("Reviewed"), Some(field_query::FieldType::Boolean));
}

#[test]
fn filters_stay_fast_on_a_large_library() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store.save_property_definition("Rating", &json!({"type": "number"})).unwrap();
    store.save_property_definition("Stage", &json!({"type": "select", "options": ["New", "Screened", "Included"]})).unwrap();
    {
        let db = store.db().unwrap();
        let tx = db.unchecked_transaction().unwrap();
        let now = now_ms();
        for i in 0..20_000i64 {
            let stage = ["New", "Screened", "Included"][(i % 3) as usize];
            let props = json!({"Rating": i % 5, "Stage": stage}).to_string();
            let tags = json!([format!("t{}", i % 40)]).to_string();
            let creators = json!([{"family": format!("Author{}", i % 500)}]).to_string();
            tx.execute(
                "INSERT INTO sources(id, kind, item_type, title, creators, year, tags, properties, doi, added_at, updated_at) VALUES (?1, 'reference', 'article', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                rusqlite::params![format!("s{i}"), format!("Work number {i}"), creators, 1990 + i % 35, tags, props, format!("10.1/{i}"), now - i * 60_000],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }
    for text in ["rating>3", "stage:included", "-tag:t3 year:2000..2010", "author:author42", "added:this-week rating:2", "is:duplicate", "rating:empty", "tag:t1|t2|t3"] {
        let filters = filters_of(&store, text);
        let start = std::time::Instant::now();
        let page = store.list_sources(&ListQuery { filters, limit: Some(100), ..Default::default() }).unwrap();
        let took = start.elapsed();
        assert!(page.total > 0 || matches!(text, "rating:empty" | "is:duplicate"), "{text}");
        // Debug build on a busy machine; release is several times faster.
        assert!(took.as_millis() < 1500, "{text}: {took:?}");
    }
    let start = std::time::Instant::now();
    for _ in 0..50 {
        store.parse_query("rating>3 stage:included added last week malaria", false).unwrap();
    }
    assert!(start.elapsed().as_millis() < 1500, "{:?}", start.elapsed());
}
