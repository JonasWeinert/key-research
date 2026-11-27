use crate::tag_analysis::*;
use crate::tag_plan::{PlanContext, Split, TagPlan};
use serde_json::{Map, Value as Json, json};
use std::collections::HashMap;

/// An index from items written as tag lists.
fn index_of(item_tags: &[Vec<&str>], tree: Json) -> TagIndex {
    let mut names: Vec<String> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    let items: Vec<TagItem> = item_tags
        .iter()
        .enumerate()
        .map(|(i, tags)| TagItem {
            id: format!("s{i}"),
            title: Some(format!("Item {i}")),
            year: None,
            tags: tags
                .iter()
                .map(|t| {
                    *at.entry(t.to_string()).or_insert_with(|| {
                        names.push(t.to_string());
                        names.len() - 1
                    })
                })
                .collect(),
        })
        .collect();
    let tags = names.iter().enumerate().map(|(i, name)| TagCount { name: name.clone(), count: items.iter().filter(|it| it.tags.contains(&i)).count() }).collect();
    TagIndex { tags, source_count: items.len(), items, tree: tree.as_object().cloned().unwrap_or_default() }
}

fn repeat(n: usize, tags: &[&'static str]) -> Vec<Vec<&'static str>> {
    (0..n).map(|_| tags.to_vec()).collect()
}

fn messy() -> TagIndex {
    let mut items: Vec<Vec<&str>> = Vec::new();
    items.extend(repeat(6, &["Machine learning", "Methods"]));
    items.extend(repeat(2, &["machine-learning", "Methods"]));
    items.push(vec!["machine learnings"]);
    items.extend(repeat(3, &["ML"]));
    items.extend(repeat(4, &["status: read"]));
    items.extend(repeat(2, &["status: to read"]));
    items.push(vec!["status: reading"]);
    items.extend(repeat(5, &["Deep learning", "Neural networks"]));
    items.extend(repeat(4, &["Surveys", "Methods"]));
    items.extend(repeat(3, &["Interviews", "Methods"]));
    items.extend(repeat(2, &["RCT", "Methods"]));
    items.extend(repeat(3, &["_tablet"]));
    items.push(vec!["1234"]);
    items.push(vec!["https://example.org/x"]);
    items.extend(repeat(3, &["Behaviour"]));
    items.push(vec!["Behavior"]);
    index_of(&items, json!({}))
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn folds_case_diacritics_separators_plurals_and_spelling() {
    assert_eq!(normalize("Machine-Learning").squash, normalize("machine learnings").squash);
    assert_eq!(normalize("Économie").squash, "economie");
    assert_eq!(normalize("#Policies").squash, "policy");
    assert_eq!(normalize("behaviour").squash, normalize("Behavior").squash);
    assert_eq!(normalize("Analysis").squash, "analysis");
}

#[test]
fn splits_names_that_spell_out_a_path() {
    assert_eq!(split_path("methods/survey"), Some(strings(&["methods", "survey"])));
    assert_eq!(split_path("Topic::Health::Insurance"), Some(strings(&["Topic", "Health", "Insurance"])));
    assert_eq!(split_path("status: read"), Some(strings(&["status", "read"])));
    assert_eq!(split_path("Covid - Lockdown"), Some(strings(&["Covid", "Lockdown"])));
    assert_eq!(split_path("self-employment"), None);
    assert_eq!(split_path("https://x.org/a"), None);
}

#[test]
fn measures_similarity() {
    assert_eq!(edit_distance("modeling", "modelling", 3), 1);
    assert_eq!(edit_distance("abcd", "abdc", 3), 1);
    assert!((jaro_winkler("martha", "marhta") - 0.961).abs() < 0.005);
}

#[test]
fn ids_match_the_renderer_analysis() {
    // FNV-1a over UTF-16 in base 36, as tag-analysis.ts made them: dismissals carry over.
    let s = analyze_tags(&messy(), &AnalysisOptions::default());
    let merge = s.iter().find(|s| s.kind == "merge" && s.tags.contains(&"machine-learning".into())).unwrap();
    let mut sorted = merge.tags.clone();
    sorted.sort();
    let mut h: u32 = 0x811c9dc5;
    for u in sorted.join("\u{1}").encode_utf16() {
        h ^= u as u32;
        h = h.wrapping_mul(0x01000193);
    }
    assert!(merge.id.starts_with("merge:"));
    assert_eq!(u32::from_str_radix(&merge.id[6..], 36).unwrap(), h);
}

fn find<'a>(list: &'a [Suggestion], kind: &str, test: impl Fn(&Suggestion) -> bool) -> Option<&'a Suggestion> {
    list.iter().filter(|s| s.kind == kind).find(|s| test(s))
}

#[test]
fn merges_variants_and_initialisms_into_the_most_used_name() {
    let s = analyze_tags(&messy(), &AnalysisOptions::default());
    let merge = find(&s, "merge", |s| s.tags.contains(&"machine-learning".into())).unwrap();
    assert_eq!(merge.plan, TagPlan::Merge { from: strings(&["machine learnings", "machine-learning", "ML"]), to: "Machine learning".into() });
    assert_eq!(merge.items, 12);
    assert!(matches!(&find(&s, "merge", |s| s.tags.contains(&"Behavior".into())).unwrap().plan, TagPlan::Merge { to, .. } if to == "Behaviour"));
    assert!(find(&s, "merge", |s| s.tags.contains(&"status: to read".into())).is_none());
}

#[test]
fn reads_delimiter_families_as_hierarchy_and_property() {
    let s = analyze_tags(&messy(), &AnalysisOptions::default());
    assert!(matches!(find(&s, "hierarchy", |s| s.tags.contains(&"status: read".into())).unwrap().plan, TagPlan::Hierarchy { .. }));
    let property = find(&s, "property", |s| s.tags.contains(&"status: to read".into())).unwrap();
    let TagPlan::Property { name, property_type, values, .. } = &property.plan else { panic!() };
    assert_eq!((name.as_str(), property_type.as_str()), ("Status", "select"));
    assert!(values.contains(&("status: to read".into(), json!("To read"))));
}

#[test]
fn finds_subsumption_togetherness_flags_methods_and_junk() {
    let s = analyze_tags(&messy(), &AnalysisOptions::default());
    let nest = find(&s, "nest", |s| matches!(&s.plan, TagPlan::Nest { parent, .. } if parent == "Methods")).unwrap();
    let TagPlan::Nest { children, .. } = &nest.plan else { panic!() };
    assert!(children.contains(&"Surveys".into()) && children.contains(&"Interviews".into()));
    assert!(find(&s, "merge", |s| s.tags.contains(&"Deep learning".into()) && s.tags.contains(&"Neural networks".into())).is_some());
    let tablet = find(&s, "property", |s| s.tags[0] == "_tablet").unwrap();
    assert!(matches!(&tablet.plan, TagPlan::Property { name, property_type, .. } if name == "Tablet" && property_type == "boolean"));
    let method = find(&s, "property", |s| s.title.contains("Method")).unwrap();
    for t in ["Surveys", "Interviews", "RCT"] {
        assert!(method.tags.contains(&t.into()), "{t}");
    }
    let junk = find(&s, "cleanup", |s| s.tags.contains(&"1234".into())).unwrap();
    assert!(junk.tags.contains(&"https://example.org/x".into()));
}

#[test]
fn is_deterministic_and_remembers_dismissals() {
    let first: Vec<String> = analyze_tags(&messy(), &AnalysisOptions::default()).into_iter().map(|s| s.id).collect();
    let again: Vec<String> = analyze_tags(&messy(), &AnalysisOptions::default()).into_iter().map(|s| s.id).collect();
    assert_eq!(first, again);
    let options = AnalysisOptions { dismissed: [first[0].clone()].into_iter().collect(), ..Default::default() };
    assert!(!analyze_tags(&messy(), &options).iter().any(|s| s.id == first[0]));
}

#[test]
fn offers_to_merge_into_an_existing_property() {
    let options = AnalysisOptions { properties: vec![PropertyInfo { name: "status".into(), kind: "select".into() }], ..Default::default() };
    let s = analyze_tags(&messy(), &options);
    let found = s.iter().find(|x| x.kind == "property" && x.tags.contains(&"status: read".into())).unwrap();
    assert!(matches!(&found.plan, TagPlan::Property { name, .. } if name == "status"));
    assert!(found.title.contains("to the “status” property"));
}

#[test]
fn every_suggestion_carries_its_planned_change() {
    let s = suggestions_with_changes(&messy(), &AnalysisOptions::default());
    assert!(!s.is_empty());
    let merge = s.iter().find(|s| s.kind == "merge" && s.tags.contains(&"machine-learning".into())).unwrap();
    assert_eq!(merge.change.as_ref().unwrap().label, "Merge 3 tags into “Machine learning”");
    let value = serde_json::to_value(&s[0]).unwrap();
    for field in ["id", "kind", "title", "evidence", "confidence", "tags", "items", "plan"] {
        assert!(value.get(field).is_some(), "{field}");
    }
}

#[test]
fn stays_fast_on_a_large_messy_library() {
    let words: Vec<&str> =
        "health economics policy insurance labour market climate energy migration education poverty inequality trade finance banking housing urban rural gender ageing".split(' ').collect();
    let tags: Vec<String> = (0..5000).map(|i| format!("{} {} {}{i}", words[i % words.len()], words[(i * 7) % words.len()], if i % 3 != 0 { "" } else { "s" })).collect();
    let items: Vec<Vec<&str>> = (0..5000).map(|i| vec![tags[i].as_str(), tags[(i * 13) % 5000].as_str(), tags[(i * 31) % 5000].as_str(), tags[i % 50].as_str()]).collect();
    let index = index_of(&items, json!({}));
    let start = std::time::Instant::now();
    let found = suggestions_with_changes(&index, &AnalysisOptions::default());
    let took = start.elapsed();
    eprintln!("5k tags / 5k items: {} suggestions in {took:?}", found.len());
    // Debug builds are several times slower than the host's release build.
    assert!(took.as_millis() < if cfg!(debug_assertions) { 8000 } else { 1500 }, "{took:?}");
}

fn plan(index: &TagIndex, plan: TagPlan) -> crate::Result<crate::tag_plan::PlannedChange> {
    PlanContext::new(index).plan(&plan)
}

fn tree(value: Json) -> Map<String, Json> {
    value.as_object().cloned().unwrap()
}

#[test]
fn merges_with_the_tree_kept_in_step() {
    let mut index = messy();
    index.tree = tree(json!({ "machine-learning": { "parent": "AI" }, "Child": { "parent": "ML" } }));
    let change = plan(&index, TagPlan::Merge { from: strings(&["ML", "machine-learning"]), to: "Machine learning".into() }).unwrap();
    let replace: Vec<(String, Vec<String>)> = change.operation.replace.iter().map(|r| (r.from.clone(), r.to.clone())).collect();
    assert_eq!(replace, vec![("ML".into(), strings(&["Machine learning"])), ("machine-learning".into(), strings(&["Machine learning"]))]);
    assert_eq!(
        Json::Object(change.operation.tree.clone()),
        json!({ "machine-learning": null, "Machine learning": { "parent": "AI" }, "Child": { "parent": "Machine learning" } })
    );
    assert_eq!(change.items, 5);
}

#[test]
fn splits_delimiter_paths_into_nested_short_names() {
    let splits = vec![Split { tag: "status: read".into(), path: strings(&["status", "read"]) }, Split { tag: "status: to read".into(), path: strings(&["status", "to read"]) }];
    let change = plan(&messy(), TagPlan::Hierarchy { splits }).unwrap();
    let replace: Vec<(String, Vec<String>)> = change.operation.replace.iter().map(|r| (r.from.clone(), r.to.clone())).collect();
    assert_eq!(replace, vec![("status: read".into(), strings(&["read"])), ("status: to read".into(), strings(&["to read"]))]);
    let t = &change.operation.tree;
    assert_eq!(t["status"], json!({}));
    assert_eq!(t["read"], json!({ "parent": "status" }));
    assert_eq!(t["to read"], json!({ "parent": "status" }));
}

#[test]
fn nests_without_cycles() {
    let mut index = messy();
    index.tree = tree(json!({ "Surveys": { "parent": "Methods" } }));
    assert!(plan(&index, TagPlan::Nest { parent: "Surveys".into(), children: strings(&["Methods"]), rename_parent: None }).is_err());
    let abstracted = plan(&index, TagPlan::Nest { parent: "Learning".into(), children: strings(&["Machine learning", "Deep learning"]), rename_parent: None }).unwrap();
    assert_eq!(
        Json::Object(abstracted.operation.tree),
        json!({ "Learning": {}, "Machine learning": { "parent": "Learning" }, "Deep learning": { "parent": "Learning" } })
    );
}

#[test]
fn nests_under_a_renamed_parent() {
    let mut index = messy();
    index.tree = tree(json!({ "Surveys": { "parent": "Methods", "color": "blue" } }));
    let change = plan(&index, TagPlan::Nest { parent: "Methods".into(), children: strings(&["Interviews"]), rename_parent: Some("Research methods".into()) }).unwrap();
    let replace: Vec<(String, Vec<String>)> = change.operation.replace.iter().map(|r| (r.from.clone(), r.to.clone())).collect();
    assert_eq!(replace, vec![("Methods".into(), strings(&["Research methods"]))]);
    let t = Json::Object(change.operation.tree.clone());
    assert_eq!(t["Research methods"], json!({}));
    assert_eq!(t["Surveys"], json!({ "parent": "Research methods", "color": "blue" }));
    assert_eq!(t["Interviews"], json!({ "parent": "Research methods" }));
    assert!(change.label.contains("renamed from"));
    assert!(plan(&index, TagPlan::Nest { parent: "Methods".into(), children: strings(&["Interviews"]), rename_parent: Some("Surveys".into()) }).is_err());
    assert!(plan(&index, TagPlan::Nest { parent: "Methods".into(), children: vec![], rename_parent: None }).is_err());
}

#[test]
fn converts_to_a_property_and_removes_tags() {
    let change = plan(&messy(), TagPlan::Property { name: "Tablet".into(), property_type: "boolean".into(), values: vec![("_tablet".into(), json!(true))], remove_tags: true }).unwrap();
    assert_eq!(serde_json::to_value(&change.operation.property).unwrap(), json!({ "name": "Tablet", "config": { "type": "boolean" }, "values": [["_tablet", true]], "removeTags": true }));
    assert_eq!(change.items, 3);
    let del = plan(&messy(), TagPlan::Delete { tags: strings(&["1234"]) }).unwrap();
    assert_eq!(del.operation.replace.len(), 1);
    assert_eq!(del.operation.replace[0].from, "1234");
    assert!(del.operation.replace[0].to.is_empty());
    // Items holding several of a select property's tags are counted for the panel's note.
    let index = index_of(&[vec!["a1", "b1"], vec!["a1"], vec!["b1"]], json!({}));
    let select = plan(&index, TagPlan::Property { name: "X".into(), property_type: "select".into(), values: vec![("a1".into(), json!("A")), ("b1".into(), json!("B"))], remove_tags: true }).unwrap();
    assert_eq!(select.multiple, 1);
}

#[test]
fn plans_parse_from_the_renderer_shape() {
    let parsed: TagPlan = serde_json::from_value(json!({ "type": "property", "name": "S", "propertyType": "select", "values": [["a", "A"]], "removeTags": true })).unwrap();
    assert!(matches!(parsed, TagPlan::Property { .. }));
    let parsed: TagPlan = serde_json::from_value(json!({ "type": "color", "tags": ["a"], "color": null })).unwrap();
    assert_eq!(parsed, TagPlan::Color { tags: strings(&["a"]), color: None });
    let parsed: TagPlan = serde_json::from_value(json!({ "type": "rename", "tag": "a", "to": "b" })).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap()["type"], "rename");
}

#[test]
fn convert_form_defaults_take_the_shared_root_off() {
    let tags = vec!["status: read".to_string(), "Status: to read".to_string()];
    let d = convert_defaults(&tags);
    assert_eq!(d["common"], "status");
    assert_eq!(d["name"], "Status");
    assert_eq!(d["values"]["status: read"], "Read");
    assert_eq!(d["values"]["Status: to read"], "To read");
    let one = convert_defaults(&["#important".to_string()]);
    assert_eq!(one["name"], "Important");
    assert!(one["common"].is_null());
}

/// A library of a few thousand tags with variants, families, co-occurrence and titles.
fn large(n: usize) -> (Vec<String>, Vec<Vec<String>>) {
    let words: Vec<&str> =
        "health economics policy insurance labour market climate energy migration education poverty inequality trade finance banking housing urban rural gender ageing".split(' ').collect();
    let tags: Vec<String> = (0..n).map(|i| format!("{} {} {}{i}", words[i % words.len()], words[(i * 7) % words.len()], if i % 3 != 0 { "" } else { "s" })).collect();
    let items: Vec<Vec<String>> = (0..n).map(|i| vec![tags[i].clone(), tags[(i * 13) % n].clone(), tags[(i * 31) % n].clone(), tags[i % 50].clone()]).collect();
    (tags, items)
}

fn index_from(items: &[Vec<String>]) -> TagIndex {
    let refs: Vec<Vec<&str>> = items.iter().map(|tags| tags.iter().map(String::as_str).collect()).collect();
    index_of(&refs, json!({}))
}

fn summary(list: &[Suggestion]) -> Vec<String> {
    list.iter().map(|s| format!("{} {} {} {:.3} {} {}", s.id, s.title, s.evidence, s.confidence, s.items, serde_json::to_string(&s.change).unwrap())).collect()
}

#[test]
fn reanalyses_only_what_a_tag_edit_touched() {
    let (tags, mut items) = large(3000);
    let mut cache = AnalysisCache::default();
    let options = AnalysisOptions::default();
    let (first, stats) = suggestions_cached(&index_from(&items), &options, &mut cache);
    assert_eq!(stats.touched, 3000);
    assert_eq!(stats.recounted, 3000);
    assert_eq!(stats.planned, first.len());
    // Nothing changed: nothing is done again.
    let (same, stats) = suggestions_cached(&index_from(&items), &options, &mut cache);
    assert_eq!(summary(&same), summary(&first));
    assert_eq!((stats.touched, stats.compared, stats.recounted, stats.read, stats.planned), (0, 0, 0, 0, 0), "{stats:?}");
    // One tag renamed on its items: only it, its new name and their neighbours.
    let old = tags[1234].clone();
    for item in &mut items {
        for t in item.iter_mut() {
            if *t == old {
                *t = format!("{old}x");
            }
        }
    }
    let index = index_from(&items);
    let start = std::time::Instant::now();
    let (after, stats) = suggestions_cached(&index, &options, &mut cache);
    let incremental = start.elapsed();
    let start = std::time::Instant::now();
    let fresh = suggestions_with_changes(&index, &options);
    let full = start.elapsed();
    eprintln!("one rename at 3k tags: {stats:?} in {incremental:?} (fresh run {full:?}, {} suggestions)", after.len());
    assert_eq!(summary(&after), summary(&fresh), "an incremental run finds exactly what a fresh one does");
    // The renamed tag, its new name, and the other tags on its three items.
    assert!(stats.touched <= 12, "{stats:?}");
    let (_, full_stats) = suggestions_cached(&index, &options, &mut AnalysisCache::default());
    assert!(stats.compared * 10 < full_stats.compared, "{stats:?} against {full_stats:?}");
    assert!(stats.recounted <= 4, "{stats:?}");
    assert!(stats.read <= 12, "{stats:?}");
    assert!(stats.planned * 4 <= after.len().max(4), "{stats:?} of {}", after.len());
    // A tree change (a nest) touches the tags it moves and their parents only.
    let mut index = index_from(&items);
    index.tree = tree(json!({tags[10].clone(): {"parent": tags[11].clone()}}));
    let (nested, stats) = suggestions_cached(&index, &options, &mut cache);
    assert_eq!(summary(&nested), summary(&suggestions_with_changes(&index, &options)));
    assert!(stats.touched <= 2 && stats.recounted == 0, "{stats:?}");
}

fn edits(change: &crate::tag_plan::PlannedChange) -> Vec<(String, Vec<String>, Vec<String>)> {
    change.predicted.items.iter().map(|e| (e.id.clone(), e.remove.clone(), e.add.clone())).collect()
}

#[test]
fn predicts_how_the_tags_will_look() {
    let index = index_of(&[vec!["ML", "Methods"], vec!["ML", "Machine learning"], vec!["Methods"]], json!({"ML": {"parent": "Methods"}}));
    // A merge renames on items (once per item) and moves the tree entry.
    let merged = plan(&index, TagPlan::Merge { from: strings(&["ML"]), to: "Machine learning".into() }).unwrap();
    assert_eq!(edits(&merged), vec![("s0".into(), strings(&["ML"]), strings(&["Machine learning"])), ("s1".into(), strings(&["ML"]), vec![])]);
    assert_eq!(merged.predicted.tree.get("ML"), Some(&Json::Null));
    assert_eq!(merged.predicted.tree["Machine learning"]["parent"], "Methods");
    // A nest only moves the tree.
    let nested = plan(&index, TagPlan::Nest { parent: "Methods".into(), children: strings(&["Machine learning"]), rename_parent: None }).unwrap();
    assert!(nested.predicted.items.is_empty());
    assert_eq!(nested.predicted.tree["Machine learning"]["parent"], "Methods");
    // A removal takes the tag off every item.
    let removed = plan(&index, TagPlan::Delete { tags: strings(&["Methods"]) }).unwrap();
    assert_eq!(edits(&removed), vec![("s0".into(), strings(&["Methods"]), vec![]), ("s2".into(), strings(&["Methods"]), vec![])]);
    // A property that removes its tags: an item holding two takes the first value and keeps the other tag.
    let status = index_of(&[vec!["to read", "x"], vec!["read", "to read"]], json!({}));
    let property = plan(
        &status,
        TagPlan::Property { name: "Status".into(), property_type: "select".into(), values: vec![("read".into(), json!("Read")), ("to read".into(), json!("To read"))], remove_tags: true },
    )
    .unwrap();
    assert_eq!(edits(&property), vec![("s0".into(), strings(&["to read"]), vec![]), ("s1".into(), strings(&["read"]), vec![])]);
}

#[test]
fn predictions_match_what_the_store_applies() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::Store::open(dir.path()).unwrap();
    for (title, tags) in [("A", vec!["ML", "machine learning", "survey"]), ("B", vec!["machine-learning"]), ("C", vec!["status: read", "survey"])] {
        let mut fields = Map::new();
        fields.insert("title".into(), Json::from(title));
        store.insert_source(crate::SourceInput { kind: "reference".into(), tags: tags.iter().map(|t| t.to_string()).collect(), fields, ..Default::default() }).unwrap();
    }
    for p in [
        TagPlan::Merge { from: strings(&["ML", "machine-learning"]), to: "machine learning".into() },
        TagPlan::Delete { tags: strings(&["survey"]) },
        TagPlan::Hierarchy { splits: vec![Split { tag: "status: read".into(), path: strings(&["status", "read"]) }] },
    ] {
        let before = store.tag_index_typed().unwrap();
        let change = store.tag_plan(&p).unwrap();
        let mut expected: HashMap<String, Vec<String>> =
            before.items.iter().map(|i| (i.id.clone(), i.tags.iter().map(|&t| before.tags[t].name.clone()).collect())).collect();
        for edit in &change.predicted.items {
            let tags = expected.get_mut(&edit.id).unwrap();
            tags.retain(|t| !edit.remove.contains(t));
            for a in &edit.add {
                if !tags.contains(a) {
                    tags.push(a.clone());
                }
            }
        }
        store.apply_tags(&change.operation).unwrap();
        for (id, tags) in expected {
            assert_eq!(store.source(&id).unwrap().unwrap().tags, tags, "{p:?}");
        }
    }
}
