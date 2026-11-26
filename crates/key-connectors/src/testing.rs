// A spec's embedded tests, run against recorded fixtures (CI on every change) or live (the
// scheduled health check): translation, counts, records, known items, field presence.
use crate::engine::{Credentials, Engine, RunControl, SearchState};
use crate::query::{self, Query};
use crate::record::Record;
use crate::spec::{Spec, TestSpec};
use crate::template::Vars;
use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestOutcome {
    pub connector: String,
    pub version: String,
    pub test: String,
    pub passed: bool,
    pub failures: Vec<String>,
    pub native: String,
    pub total: Option<u64>,
    pub records: usize,
    pub requests: u32,
    /// The failing request and answer, when a request failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    pub sample: Vec<Record>,
}

fn found(records: &[Record], want: &crate::spec::MustFind) -> bool {
    records.iter().any(|r| {
        want.doi.as_ref().is_some_and(|d| r.doi.as_deref().map(str::to_lowercase) == key_store::normalize::doi(d))
            || want.source_id.as_ref().is_some_and(|s| r.source_id.eq_ignore_ascii_case(s))
            || want.title.as_ref().is_some_and(|t| query::fold(&r.title).contains(&query::fold(t)))
    })
}

pub fn run_test(engine: &Engine, spec: &Spec, test: &TestSpec, creds: &Credentials, ctl: &RunControl) -> TestOutcome {
    let mut out = TestOutcome { connector: spec.id.clone(), version: spec.version.clone(), test: test.name.clone(), ..Default::default() };
    let query: Query = match serde_json::from_value(test.query.clone()) {
        Ok(q) => q,
        Err(e) => {
            out.failures.push(format!("bad query: {e}"));
            return out;
        }
    };
    let options: Vars = test.options.clone().into_iter().collect();
    let translation = query::translate(spec, &query, &options);
    out.native = translation.native.clone();
    if let Some(native) = &test.native {
        if *native != translation.native {
            out.failures.push(format!("translation changed:\n  expected {native}\n  got      {}", translation.native));
        }
    }
    if spec.kind == "manual" {
        out.passed = out.failures.is_empty();
        return out;
    }
    let mut state = SearchState::new(&translation, &query, &options);
    state.page_size = test.page_size;
    state.record_cap = test.max_records;
    let mut records: Vec<Record> = Vec::new();
    let cap = test.max_records.unwrap_or(usize::MAX);
    for _ in 0..test.pages.max(1) {
        match engine.next_page(spec, &mut state, creds, ctl) {
            Ok(page) => {
                out.total = page.total.or(out.total);
                records.extend(page.records);
                if page.done || records.len() >= cap {
                    break;
                }
            }
            Err(e) => {
                out.failures.push(format!("{} ({})", e.message, e.kind));
                out.request = e.request.clone();
                out.excerpt = e.excerpt.clone();
                break;
            }
        }
    }
    records.truncate(cap);
    out.requests = state.requests;
    out.records = records.len();
    if let Some(min) = test.min_total {
        match out.total {
            Some(t) if t >= min => {}
            Some(t) => out.failures.push(format!("total {t} is below {min}")),
            None if out.failures.is_empty() => out.failures.push("no total was reported".into()),
            None => {}
        }
    }
    if let Some(min) = test.min_results {
        if (records.len() as u64) < min {
            out.failures.push(format!("{} records read, fewer than {min}", records.len()));
        }
    }
    for want in &test.must_find {
        if !found(&records, want) {
            out.failures.push(format!("not found: {}", serde_json::to_string(want).unwrap_or_default()));
        }
    }
    for field in &test.fields {
        let have = records.iter().filter(|r| !r.is_empty_field(field)).count();
        if !records.is_empty() && (have as f64) < 0.8 * records.len() as f64 {
            out.failures.push(format!("field {field} is filled in only {have} of {} records", records.len()));
        }
    }
    if records.iter().any(|r| r.title.trim().is_empty()) {
        out.failures.push("a record has no title".into());
    }
    out.sample = records.into_iter().take(3).collect();
    out.passed = out.failures.is_empty();
    out
}

pub fn run_all(engine: &Engine, spec: &Spec, creds: &Credentials, ctl: &RunControl, live: bool) -> Vec<TestOutcome> {
    spec.tests.iter().filter(|t| !(live && t.offline_only)).map(|t| run_test(engine, spec, t, creds, ctl)).collect()
}
