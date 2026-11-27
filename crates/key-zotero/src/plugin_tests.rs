// Sync through the Key Sync plugin, against an in-memory plugin speaking the same protocol.
use super::plugin::*;
use crate::{ImportOptions, ORIGIN};
use key_store::Store;
use serde_json::{Value as Json, json};
use std::{cell::RefCell, collections::BTreeMap};

#[derive(Default)]
struct Fake {
    epoch: String,
    seq: i64,
    floor: i64,
    collections: Vec<Json>,
    records: BTreeMap<String, Json>,
    journal: Vec<(i64, String, String, String)>,
    calls: Vec<String>,
}

struct Plugin(RefCell<Fake>);

impl Plugin {
    fn new() -> Plugin {
        let plugin = Plugin(RefCell::new(Fake { epoch: "e1".into(), ..Default::default() }));
        plugin.collection("COLL1", "Thesis", None);
        plugin.collection("COLL2", "Chapter", Some("COLL1"));
        plugin.collection("COLL3", "Other", None);
        plugin.put(json!({
            "key": "ITEM1", "itemType": "journalArticle", "dateAdded": "2024-01-02 03:04:05",
            "fields": {"title": "Health versus income", "publicationTitle": "Social Science & Medicine", "date": "2022-03-01"},
            "creators": [{"creatorType": "author", "firstName": "Marco", "lastName": "Palma"}, {"creatorType": "editor", "name": "WHO"}],
            "tags": ["covid"], "collections": ["COLL2"],
            "attachments": [{"key": "ATT1", "contentType": "application/pdf", "linkMode": 2, "path": "/nowhere/paper.pdf",
                "annotations": [{"key": "ANN1", "type": 1, "text": "A highlighted sentence", "comment": "Worth citing", "color": "#ffd400", "pageIndex": 2, "sortIndex": "00002"}]}],
            "notes": [{"key": "NOTE1", "title": "Bold idea", "html": "<p><strong>Bold</strong> idea</p>"}]
        }));
        plugin.put(json!({"key": "ITEM2", "itemType": "book", "fields": {"title": "A Book"}, "collections": ["COLL3"]}));
        plugin.put(json!({"key": "ITEM3", "itemType": "report", "fields": {"title": "Report"}}));
        plugin.put(json!({"key": "NOTE9", "itemType": "note", "note": {"key": "NOTE9", "title": "A loose thought", "html": "<p>A loose thought</p>"}}));
        plugin
    }
    fn record(&self, kind: &str, op: &str, key: &str) {
        let mut f = self.0.borrow_mut();
        f.seq += 1;
        let seq = f.seq;
        f.journal.retain(|(_, k, _, key2)| !(k == kind && key2 == key));
        f.journal.push((seq, kind.into(), op.into(), key.into()));
    }
    fn collection(&self, key: &str, name: &str, parent: Option<&str>) {
        let mut f = self.0.borrow_mut();
        f.collections.retain(|c| c["key"] != key);
        f.collections.push(json!({"key": key, "name": name, "parentKey": parent}));
        drop(f);
        self.record("collection", "upsert", key);
    }
    fn put(&self, mut record: Json) {
        let key = record["key"].as_str().unwrap().to_string();
        let mut f = self.0.borrow_mut();
        let stamp = f.seq + 1;
        record["stamp"] = json!(format!("s{stamp}"));
        f.records.insert(key.clone(), record);
        drop(f);
        self.record("item", "upsert", &key);
    }
    fn edit(&self, key: &str, change: impl FnOnce(&mut Json)) {
        let mut record = self.0.borrow().records[key].clone();
        change(&mut record);
        self.put(record);
    }
    fn erase(&self, key: &str) {
        self.0.borrow_mut().records.remove(key);
        self.record("item", "delete", key);
    }
    fn top_of(&self, key: &str) -> Option<String> {
        let f = self.0.borrow();
        if f.records.contains_key(key) {
            return Some(key.into());
        }
        f.records.iter().find(|(_, r)| r.to_string().contains(&format!("\"key\":\"{key}\""))).map(|(k, _)| k.clone())
    }
    fn in_scope(&self, scope: &Json) -> Vec<String> {
        let f = self.0.borrow();
        let list = |name: &str| -> Vec<String> { scope[name].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect() };
        let (collections, items) = (list("collections"), list("items"));
        f.records
            .iter()
            .filter(|(_, r)| r["deleted"] != json!(true))
            .filter(|(k, r)| {
                scope["type"] == "all"
                    || items.contains(k)
                    || r["collections"].as_array().into_iter().flatten().any(|c| collections.iter().any(|x| c == x))
            })
            .map(|(k, _)| k.clone())
            .collect()
    }
    fn calls(&self) -> Vec<String> {
        std::mem::take(&mut self.0.borrow_mut().calls)
    }
}

impl Transport for Plugin {
    fn call(&self, method: &str, path: &str, body: Option<&Json>) -> Result<Json, Failure> {
        self.0.borrow_mut().calls.push(format!("{method} {}", path.split('?').next().unwrap()));
        let query = |name: &str| path.split(['?', '&']).find_map(|p| p.strip_prefix(&format!("{name}="))).unwrap_or("").to_string();
        let f = self.0.borrow();
        let answer = match path.split('?').next().unwrap() {
            "handshake" => json!({"paired": true, "version": "1.0.0", "zotero": "7.0", "epoch": f.epoch, "seq": f.seq, "defaultLibraryID": 1,
                "libraries": [{"libraryID": 1, "name": "My Library", "type": "user"}]}),
            "changes" => {
                let since: i64 = query("since").parse().unwrap_or(0);
                let resync = since < f.floor || since > f.seq || query("epoch") != f.epoch;
                let changes: Vec<Json> = f.journal.iter().filter(|e| e.0 > since).map(|(seq, kind, op, key)| json!({"seq": seq, "kind": kind, "op": op, "key": key})).collect();
                json!({"epoch": f.epoch, "seq": f.seq, "resyncRequired": resync, "more": false, "changes": if resync { vec![] } else { changes }})
            }
            "collections" => json!({"collections": f.collections}),
            "versions" => json!({"items": f.records.iter().map(|(k, r)| json!({"key": k, "stamp": r["stamp"], "deleted": r["deleted"] == json!(true)})).collect::<Vec<_>>()}),
            "items" => {
                let body = body.unwrap();
                if let Some(keys) = body["keys"].as_array() {
                    drop(f);
                    let mut found = BTreeMap::new();
                    let mut missing = vec![];
                    for key in keys.iter().filter_map(Json::as_str) {
                        match self.top_of(key) {
                            Some(top) => {
                                found.insert(top.clone(), self.0.borrow().records[&top].clone());
                            }
                            None => missing.push(key.to_string()),
                        }
                    }
                    return Ok(json!({"items": found.into_values().collect::<Vec<_>>(), "missing": missing}));
                }
                drop(f);
                let keys = self.in_scope(&body["scope"]);
                if body["keysOnly"] == json!(true) {
                    return Ok(json!({"keys": keys}));
                }
                let offset = body["offset"].as_u64().unwrap_or(0) as usize;
                let limit = 2; // Small pages, so paging is exercised.
                let page: Vec<Json> = keys.iter().skip(offset).take(limit).map(|k| self.0.borrow().records[k].clone()).collect();
                let next = if offset + limit < keys.len() { json!(offset + limit) } else { Json::Null };
                return Ok(json!({"items": page, "total": keys.len(), "next": next, "missing": []}));
            }
            other => panic!("unexpected {other}"),
        };
        Ok(answer)
    }
}

fn setup(options: ImportOptions) -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    configure(&store, Configure { options: Some(options), token: Some("t".repeat(48)), ..Default::default() }).unwrap();
    (dir, store)
}

fn sync(store: &Store, plugin: &Plugin) -> crate::ImportReport {
    sync_with(store, plugin, false, false, &|_| {}).unwrap().report.unwrap_or_default()
}

fn source(store: &Store, key: &str) -> Option<key_store::Source> {
    let index = store.origin_index(ORIGIN).unwrap();
    index.get(key).and_then(|(id, _)| store.source(id).unwrap())
}

fn notes(store: &Store) -> Vec<key_store::Note> {
    let mut all = Vec::new();
    for s in store.origin_index(ORIGIN).unwrap().values() {
        all.extend(store.notes(&s.0).unwrap());
    }
    all
}

#[test]
fn first_sync_brings_the_library_across() {
    let plugin = Plugin::new();
    let (_dir, store) = setup(ImportOptions::default());
    let report = sync(&store, &plugin);
    assert_eq!((report.added, report.collections), (3, 3));
    let article = source(&store, "ITEM1").unwrap();
    assert_eq!(article.title(), "Health versus income");
    assert_eq!(article.fields["containerTitle"], "Social Science & Medicine");
    assert_eq!(article.creators.len(), 2);
    assert_eq!(article.creators[1].literal.as_deref(), Some("WHO"));
    assert_eq!(article.fields["filePath"], "/nowhere/paper.pdf");
    let chapter = store.collections().unwrap().into_iter().find(|c| c.name == "Chapter").unwrap();
    assert!(article.collections.contains(&chapter.id));
    let bodies: Vec<String> = notes(&store).into_iter().map(|n| n.body).collect();
    assert!(bodies.iter().any(|b| b.contains("**Bold** idea")), "{bodies:?}");
    assert!(bodies.iter().any(|b| b.contains("A highlighted sentence")), "{bodies:?}");
    assert!(store.note_by_origin("zotero:NOTE9").unwrap().is_some());
    let st = status(&store).unwrap();
    assert_eq!((st.connection, st.items, st.library_name.as_deref()), (None, 3, Some("My Library")));

    // Nothing new: one request, no merge.
    plugin.calls();
    let quiet = sync_with(&store, &plugin, false, false, &|_| {}).unwrap();
    assert!(!quiet.ran);
    assert_eq!(plugin.calls(), vec!["GET handshake", "GET changes"]);
}

#[test]
fn deltas_apply_once_and_again_harmlessly() {
    let plugin = Plugin::new();
    let (dir, store) = setup(ImportOptions::default());
    sync(&store, &plugin);
    let before = status(&store).unwrap().seq;

    // An edit in Key is kept while Zotero changes another field.
    let id = source(&store, "ITEM1").unwrap().id;
    store.update_source(&id, &serde_json::from_value(json!({"title": "My own title"})).unwrap()).unwrap();
    plugin.edit("ITEM1", |r| {
        r["fields"]["date"] = json!("2023-05-01");
        r["fields"]["title"] = json!("Health and income");
        r["tags"] = json!(["covid", "economics"]);
    });
    plugin.edit("ITEM3", |r| r["fields"]["title"] = json!("Annual report"));
    plugin.calls();
    let report = sync(&store, &plugin);
    assert_eq!(report.updated, 2);
    assert_eq!(report.conflict_count, 1);
    // Only the two changed items were fetched.
    assert_eq!(plugin.calls(), vec!["GET handshake", "GET changes", "POST items"]);
    let article = source(&store, "ITEM1").unwrap();
    assert_eq!(article.title(), "My own title");
    assert_eq!(article.fields["year"], 2023);
    assert!(article.tags.contains(&"economics".to_string()));
    assert_eq!(source(&store, "ITEM3").unwrap().title(), "Annual report");

    // The same changes again (as after a crash before the position was saved): no effect.
    let state = crate::state::State::open(dir.path()).unwrap();
    let mut st: Json = serde_json::from_str(&state.meta("pluginStatus").unwrap()).unwrap();
    st["seq"] = json!(before);
    state.set_meta("pluginStatus", &st.to_string()).unwrap();
    let again = sync(&store, &plugin);
    assert_eq!((again.added, again.updated, again.trashed), (0, 0, 0));
    assert_eq!(source(&store, "ITEM3").unwrap().title(), "Annual report");
}

#[test]
fn deletions_trash_and_restore_but_keep_edited_notes() {
    let plugin = Plugin::new();
    let (_dir, store) = setup(ImportOptions::default());
    sync(&store, &plugin);

    // Trashed in Zotero → Key's trash; restored → back.
    plugin.edit("ITEM2", |r| r["deleted"] = json!(true));
    assert_eq!(sync(&store, &plugin).trashed, 1);
    assert!(source(&store, "ITEM2").unwrap().trashed_at.is_some());
    plugin.edit("ITEM2", |r| r["deleted"] = json!(false));
    assert_eq!(sync(&store, &plugin).restored, 1);
    assert!(source(&store, "ITEM2").unwrap().trashed_at.is_none());

    // Erased in Zotero → Key's trash (never deleted outright).
    plugin.erase("ITEM3");
    assert_eq!(sync(&store, &plugin).trashed, 1);
    assert!(source(&store, "ITEM3").unwrap().trashed_at.is_some());

    // A child note erased: its item is refetched; the unedited note goes.
    plugin.0.borrow_mut().records.get_mut("ITEM1").unwrap()["notes"] = json!([]);
    plugin.record("item", "delete", "NOTE1");
    let report = sync(&store, &plugin);
    assert_eq!(report.notes_deleted, 1);
    assert!(store.note_by_origin("zotero:NOTE1").unwrap().is_none());

    // A standalone note edited in Key stays when Zotero deletes it.
    let loose = store.note_by_origin("zotero:NOTE9").unwrap().unwrap();
    store.save_note(Some(&loose.id), None, &loose.title, "My thoughts on this", Some("zotero:NOTE9")).unwrap();
    plugin.erase("NOTE9");
    let report = sync(&store, &plugin);
    assert_eq!(report.notes_deleted, 0);
    assert_eq!(store.note(&loose.id).unwrap().unwrap().body, "My thoughts on this");
}

#[test]
fn scope_follows_collections_and_unlinks_what_leaves_it() {
    let plugin = Plugin::new();
    let options = ImportOptions { collection_keys: Some(vec!["COLL1".into(), "COLL2".into()]), ..Default::default() };
    let (_dir, store) = setup(options);
    let report = sync(&store, &plugin);
    assert_eq!(report.added, 1);
    assert!(source(&store, "ITEM2").is_none());
    let names: Vec<String> = store.collections().unwrap().into_iter().map(|c| c.name).collect();
    assert!(names.contains(&"Thesis".to_string()) && !names.contains(&"Other".to_string()), "{names:?}");

    // Filed into a synced collection in Zotero: it arrives.
    plugin.edit("ITEM2", |r| r["collections"] = json!(["COLL3", "COLL1"]));
    assert_eq!(sync(&store, &plugin).added, 1);
    // Taken out again: it stays in Key, no longer followed, and is not trashed.
    plugin.edit("ITEM2", |r| r["collections"] = json!(["COLL3"]));
    let report = sync(&store, &plugin);
    assert_eq!((report.unlinked, report.trashed), (1, 0));
    plugin.edit("ITEM2", |r| r["fields"]["title"] = json!("Changed while outside"));
    sync(&store, &plugin);
    let book = source(&store, "ITEM2").unwrap();
    assert_eq!((book.title(), book.trashed_at), ("A Book", None));
    // Deleted in Zotero while outside the scope: still left alone.
    plugin.erase("ITEM2");
    assert_eq!(sync(&store, &plugin).trashed, 0);
    assert!(source(&store, "ITEM2").unwrap().trashed_at.is_none());
}

#[test]
fn chosen_papers_and_a_changed_scope() {
    let plugin = Plugin::new();
    let (_dir, store) = setup(ImportOptions { item_keys: Some(vec!["ITEM3".into()]), ..Default::default() });
    let report = sync(&store, &plugin);
    assert_eq!(report.added, 1);
    assert!(source(&store, "ITEM3").is_some() && source(&store, "ITEM1").is_none());
    // No collections hold it, so none are made.
    assert!(store.collections().unwrap().is_empty());

    // A wider scope fetches again and brings the rest; ITEM1's collections come with it.
    configure(&store, Configure { options: Some(ImportOptions { item_keys: Some(vec!["ITEM3".into(), "ITEM1".into()]), ..Default::default() }), ..Default::default() }).unwrap();
    plugin.calls();
    let report = sync(&store, &plugin);
    assert_eq!(report.added, 1);
    assert!(plugin.calls().contains(&"POST items".to_string()));
    let names: Vec<String> = store.collections().unwrap().into_iter().map(|c| c.name).collect();
    assert_eq!(names.len(), 2, "{names:?}");
}

#[test]
fn a_journal_that_cannot_answer_means_fetching_everything_again() {
    let plugin = Plugin::new();
    let (_dir, store) = setup(ImportOptions::default());
    sync(&store, &plugin);
    plugin.edit("ITEM3", |r| r["fields"]["title"] = json!("Renamed"));
    // The plugin's journal was replaced (a new epoch): Key starts over, without duplicates.
    plugin.0.borrow_mut().epoch = "e2".into();
    let report = sync(&store, &plugin);
    assert_eq!((report.added, report.updated), (0, 1));
    assert_eq!(source(&store, "ITEM3").unwrap().title(), "Renamed");
    // Dropped entries (floor above Key's position) also mean a full fetch.
    plugin.edit("ITEM2", |r| r["fields"]["title"] = json!("Moved on"));
    plugin.0.borrow_mut().floor = 10_000;
    plugin.0.borrow_mut().seq = 10_001;
    let report = sync(&store, &plugin);
    assert_eq!(report.updated, 1);
    assert_eq!(store.origin_index(ORIGIN).unwrap().len(), 3);
}

#[test]
fn a_reconcile_finds_what_the_journal_missed() {
    let plugin = Plugin::new();
    let (_dir, store) = setup(ImportOptions::default());
    sync(&store, &plugin);
    // Changed and deleted while the plugin was not recording: nothing in the journal.
    {
        let mut f = plugin.0.borrow_mut();
        f.records.get_mut("ITEM3").unwrap()["fields"]["title"] = json!("Quietly renamed");
        f.records.get_mut("ITEM3").unwrap()["stamp"] = json!("changed");
        f.records.remove("ITEM2");
    }
    assert!(!sync_with(&store, &plugin, false, false, &|_| {}).unwrap().ran);
    let report = sync_with(&store, &plugin, false, true, &|_| {}).unwrap().report.unwrap();
    assert_eq!((report.updated, report.trashed), (1, 1));
    assert_eq!(source(&store, "ITEM3").unwrap().title(), "Quietly renamed");
}

#[test]
fn a_file_moved_to_another_item_leaves_the_first() {
    let mut mirror = Mirror::default();
    let record = |key: &str, att: &str| serde_json::from_value::<Record>(json!({"key": key, "itemType": "book", "attachments": [{"key": att}]})).unwrap();
    mirror.upsert(vec![record("A", "F1")]);
    mirror.upsert(vec![record("B", "F1")]);
    assert!(mirror.items["A"].attachments.is_empty());
    assert_eq!(mirror.items["B"].attachments.len(), 1);
    // Deleting the file asks for its item; deleting an unknown key asks for nothing.
    let plan = mirror.plan(&[
        Change { seq: 1, kind: "item".into(), op: "delete".into(), key: "F1".into() },
        Change { seq: 2, kind: "item".into(), op: "delete".into(), key: "ZZZ".into() },
        Change { seq: 3, kind: "item".into(), op: "delete".into(), key: "A".into() },
        Change { seq: 4, kind: "collection".into(), op: "upsert".into(), key: "C".into() },
    ]);
    assert_eq!(plan.fetch.into_iter().collect::<Vec<_>>(), vec!["B".to_string()]);
    assert_eq!(plan.remove.into_iter().collect::<Vec<_>>(), vec!["A".to_string()]);
    assert!(plan.collections);
}

#[test]
fn sync_needs_a_setup_and_can_be_paused_and_removed() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(super::plugin::sync(&store, false, &|_| {}).unwrap().connection, Some(Connection::Off));
    configure(&store, Configure { options: Some(ImportOptions::default()), paused: Some(true), ..Default::default() }).unwrap();
    assert_eq!(super::plugin::sync(&store, false, &|_| {}).unwrap().connection, Some(Connection::Paused));
    assert_eq!(status(&store).unwrap().connection, Some(Connection::Paused));
    // Nothing listens on this port: Zotero is not running.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    configure(&store, Configure { paused: Some(false), port: Some(port), ..Default::default() }).unwrap();
    let outcome = super::plugin::sync(&store, false, &|_| {}).unwrap();
    assert_eq!(outcome.connection, Some(Connection::NotRunning));
    assert_eq!(status(&store).unwrap().connection, Some(Connection::NotRunning));
    configure(&store, Configure { remove: true, ..Default::default() }).unwrap();
    assert!(!configured(&store));
}

#[test]
fn sync_pace_backs_off_and_recovers() {
    let root = std::path::Path::new("/tmp/key-zotero-pace-test");
    reset_delay(root);
    assert_eq!(next_delay(root, Some(&Connection::Ok), false), SYNC_EVERY_MS);
    assert_eq!(next_delay(root, Some(&Connection::NotRunning), false), SYNC_EVERY_MS * 2);
    assert_eq!(next_delay(root, Some(&Connection::PluginMissing), false), SYNC_EVERY_MS * 4);
    for _ in 0..10 {
        next_delay(root, None, true);
    }
    assert_eq!(next_delay(root, None, true), SYNC_BACKOFF_MAX_MS);
    assert_eq!(next_delay(root, Some(&Connection::Ok), false), SYNC_EVERY_MS);
    assert_eq!(next_delay(root, Some(&Connection::Paused), false), SYNC_IDLE_MS);
    reset_delay(root);
    assert_eq!(next_delay(root, Some(&Connection::Unpaired), false), SYNC_EVERY_MS * 2);
}

/// Keys of the Zotero items a workspace has, not in its trash.
fn present(store: &Store) -> Vec<String> {
    let mut keys: Vec<String> = store
        .origin_index(ORIGIN)
        .unwrap()
        .into_iter()
        .filter(|(_, (id, _))| store.source(id).unwrap().is_some_and(|s| s.trashed_at.is_none()))
        .map(|(k, _)| k)
        .collect();
    keys.sort();
    keys
}

/// Everything a single-workspace sync brings with ITEM1: its file, note and highlights.
fn has_item1_in_full(store: &Store) {
    let article = source(store, "ITEM1").unwrap();
    assert_eq!(article.fields["filePath"], "/nowhere/paper.pdf");
    let bodies: Vec<String> = store.notes(&article.id).unwrap().into_iter().map(|n| n.body).collect();
    assert!(bodies.iter().any(|b| b.contains("**Bold** idea")), "{bodies:?}");
    assert!(bodies.iter().any(|b| b.contains("A highlighted sentence")), "{bodies:?}");
}

/// Two workspaces syncing the same Zotero library, with nested or overlapping scopes and in
/// either order: each has all of its own scope, and later changes reach every workspace
/// whose scope holds them.
#[test]
fn workspaces_with_the_same_or_nested_scopes_each_get_their_own_items() {
    let everything = ImportOptions::default();
    let thesis = ImportOptions { collection_keys: Some(vec!["COLL1".into(), "COLL2".into()]), ..Default::default() };
    let chapter = ImportOptions { collection_keys: Some(vec!["COLL2".into()]), ..Default::default() };
    let other_and_chapter = ImportOptions { collection_keys: Some(vec!["COLL2".into(), "COLL3".into()]), ..Default::default() };
    let all = vec!["ITEM1", "ITEM2", "ITEM3"];
    let cases: Vec<(&str, ImportOptions, Vec<&str>, ImportOptions, Vec<&str>)> = vec![
        ("same library", everything.clone(), all.clone(), everything.clone(), all.clone()),
        ("a collection inside", everything.clone(), all.clone(), thesis.clone(), vec!["ITEM1"]),
        ("a sub-collection inside", everything.clone(), all.clone(), chapter.clone(), vec!["ITEM1"]),
        ("overlapping collections", thesis.clone(), vec!["ITEM1"], other_and_chapter.clone(), vec!["ITEM1", "ITEM2"]),
        ("narrow first", thesis.clone(), vec!["ITEM1"], everything.clone(), all.clone()),
        ("overlapping, the other way", other_and_chapter.clone(), vec!["ITEM1", "ITEM2"], thesis.clone(), vec!["ITEM1"]),
    ];
    for (case, a_scope, a_keys, b_scope, b_keys) in cases {
        let plugin = Plugin::new();
        let (a_dir, a) = setup(a_scope);
        sync(&a, &plugin);
        assert_eq!(present(&a), a_keys, "{case}: A");
        // A keeps syncing while B is set up.
        plugin.edit("ITEM3", |r| r["fields"]["title"] = json!("Report, revised"));
        sync(&a, &plugin);
        // B takes the pairing code A saved: Zotero has one code.
        let _b_dir = tempfile::tempdir().unwrap();
        let b = Store::open(_b_dir.path()).unwrap();
        configure(&b, Configure { options: Some(b_scope), token_from: vec![_b_dir.path().join("nowhere"), a_dir.path().to_path_buf()], ..Default::default() }).unwrap();
        assert_eq!(saved_token(_b_dir.path()), Some("t".repeat(48)), "{case}: B has the code");
        let report = sync(&b, &plugin);
        assert_eq!(present(&b), b_keys, "{case}: B");
        assert_eq!(report.added, b_keys.len(), "{case}: B adds its scope");
        assert_eq!(status(&b).unwrap().items, b_keys.len(), "{case}: B counts its own scope");
        has_item1_in_full(&a);
        has_item1_in_full(&b);

        // Later changes in Zotero reach both, in whatever order they ask.
        plugin.edit("ITEM1", |r| r["fields"]["title"] = json!("Health and income"));
        plugin.put(json!({"key": "ITEM4", "itemType": "journalArticle", "fields": {"title": "New in the chapter"}, "collections": ["COLL2"]}));
        sync(&b, &plugin);
        sync(&a, &plugin);
        for (name, store) in [("A", &a), ("B", &b)] {
            assert_eq!(source(store, "ITEM1").unwrap().title(), "Health and income", "{case}: {name} has the edit");
            assert!(source(store, "ITEM4").is_some(), "{case}: {name} has the new item");
        }
        // Each asks the journal from where it got to: nothing more for either.
        assert!(!sync_with(&a, &plugin, false, false, &|_| {}).unwrap().ran, "{case}: A quiet");
        assert!(!sync_with(&b, &plugin, false, false, &|_| {}).unwrap().ran, "{case}: B quiet");
    }
}
