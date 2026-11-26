// Every connector's embedded tests against its recorded answers (connectors/fixtures), and an
// end-to-end search across the reference connectors: paging, local filtering and merging.
use key_connectors::engine::{Engine, RunControl, SearchState};
use key_connectors::fixtures::{Fixture, Replay};
use key_connectors::merge::{Found, Merger};
use key_connectors::{baseline, query, testing};
use std::path::Path;
use std::sync::Arc;

fn fixtures_of(id: &str) -> Vec<Fixture> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../connectors/fixtures").join(id);
    std::fs::read_dir(dir)
        .map(|d| d.flatten().filter_map(|e| std::fs::read_to_string(e.path()).ok()).filter_map(|t| serde_json::from_str(&t).ok()).collect())
        .unwrap_or_default()
}

#[test]
fn embedded_tests_pass_on_recorded_answers() {
    let (connectors, problems) = baseline::baseline();
    assert!(problems.is_empty(), "{problems:#?}");
    let mut ran = 0;
    for c in connectors {
        let fixtures = fixtures_of(&c.spec.id);
        if fixtures.is_empty() && c.spec.kind != "manual" {
            continue;
        }
        let engine = Engine::new(Arc::new(Replay::new(&fixtures)));
        for outcome in testing::run_all(&engine, &c.spec, &testing::placeholder_credentials(&c.spec), &RunControl::instant(), false) {
            ran += 1;
            assert!(outcome.passed, "{} / {}: {:#?}", outcome.connector, outcome.test, outcome.failures);
        }
    }
    assert!(ran >= 3, "the reference connectors' tests ran ({ran})");
}

#[test]
fn reference_connectors_search_merge_and_count_from_fixtures() {
    let all = baseline::combine(None);
    let mut merger = Merger::default();
    for id in ["pubmed", "crossref-series", "econstor"] {
        let spec = &all[id].connector.spec;
        let test = &spec.tests[0];
        let q: query::Query = serde_json::from_value(test.query.clone()).unwrap();
        let options = test.options.clone().into_iter().collect();
        let t = query::translate(spec, &q, &options);
        let engine = Engine::new(Arc::new(Replay::new(&fixtures_of(id))));
        let mut state = SearchState::new(&t, &q, &options);
        let page = engine.next_page(spec, &mut state, &Default::default(), &RunControl::instant()).unwrap();
        assert!(!page.records.is_empty(), "{id}");
        if t.local_filter {
            assert!(page.records.iter().all(|r| query::matches(&q, r)), "{id}: every record passes the local filter");
        }
        for (rank, record) in page.records.into_iter().enumerate() {
            merger.add(Found { connector: id.into(), version: spec.version.clone(), record, query: t.chunks[0].clone(), at: 0, rank });
        }
    }
    assert!(merger.groups.len() >= 30);
    // A count reads only the total.
    let spec = &all["pubmed"].connector.spec;
    let test = &spec.tests[0];
    let q: query::Query = serde_json::from_value(test.query.clone()).unwrap();
    let t = query::translate(spec, &q, &Default::default());
    let engine = Engine::new(Arc::new(Replay::new(&fixtures_of("pubmed"))));
    let total = engine.count(spec, &t, &q, &Default::default(), &Default::default(), &RunControl::instant()).unwrap();
    assert!(total.unwrap_or(0) >= 50);
}
