// Workspace-wide tag operations for the tag manager: one read of every tag with the
// sources carrying it, and operations (merge, rename, remove, convert to a property)
// applied in a single transaction that hands back exactly what it overwrote, so the
// renderer can undo it. The tag tree (parents, colours) is a JSON object in `meta`.
use crate::{Result, Store, e, merge_json, now_ms, patch_source_row, properties, refresh_fts, sync_graph};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};
use std::collections::{HashMap, HashSet};

const TREE_KEY: &str = "tags.tree";

/// One tag replaced on every source: `to` empty removes it.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct TagReplace {
    pub from: String,
    #[serde(default)]
    pub to: Vec<String>,
}

/// Tags turned into a property's values: sources holding `values[tag]` get that value.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagProperty {
    pub name: String,
    /// The definition to create, or to merge select options into when it exists.
    pub config: Json,
    /// Tag → value, in priority order (the first wins when a source holds several).
    pub values: Vec<(String, Json)>,
    #[serde(default)]
    pub remove_tags: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagOperation {
    #[serde(default)]
    pub replace: Vec<TagReplace>,
    /// Entries of the tag tree to set (`null` removes one); others are kept.
    #[serde(default)]
    pub tree: Map<String, Json>,
    #[serde(default)]
    pub property: Option<TagProperty>,
}

/// What an operation overwrote; `restore_tags` puts it back.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSnapshot {
    #[serde(default)]
    pub sources: Vec<SourceTags>,
    #[serde(default)]
    pub tree: Option<Json>,
    /// The property definition before (`config: null` when the operation created it).
    #[serde(default)]
    pub definition: Option<(String, Json)>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct SourceTags {
    pub id: String,
    pub tags: Vec<String>,
    /// Only the property values the operation touched; `null` was unset.
    #[serde(default)]
    pub properties: Map<String, Json>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagResult {
    /// Sources whose tags or properties changed.
    pub affected: usize,
    /// Sources that kept a tag because the property could not hold it (another value won,
    /// or the source already had a different value).
    pub kept: usize,
    pub undo: TagSnapshot,
}

fn read_tree(db: &Connection) -> Result<Map<String, Json>> {
    let text: Option<String> = db.query_row("SELECT value FROM meta WHERE key = ?", [TREE_KEY], |r| r.get(0)).optional().map_err(e)?;
    Ok(text.and_then(|t| serde_json::from_str::<Json>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default())
}

fn write_tree(db: &Connection, tree: &Map<String, Json>) -> Result<()> {
    db.execute(
        "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![TREE_KEY, Json::Object(tree.clone()).to_string()],
    )
    .map(|_| ())
    .map_err(e)
}

fn write_source(db: &Connection, id: &str, tags: &[String], properties: Option<&Map<String, Json>>) -> Result<()> {
    let mut patch = Map::new();
    patch.insert("tags".into(), Json::from(tags.to_vec()));
    if let Some(p) = properties.filter(|p| !p.is_empty()) {
        patch.insert("properties".into(), Json::Object(p.clone()));
    }
    patch_source_row(db, id, &patch, now_ms())?;
    sync_graph(db, id, Some(&patch))?;
    refresh_fts(db, id)
}

fn same_tag(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

fn push_unique(out: &mut Vec<String>, tag: &str) {
    let tag = tag.trim();
    if !tag.is_empty() && !out.iter().any(|t| same_tag(t, tag)) {
        out.push(tag.to_string());
    }
}

impl Store {
    /// Every tag with its count, every live source with its tags (as indexes) and title,
    /// and the tag tree: what the tag manager analyses.
    pub fn tag_index(&self) -> Result<Json> {
        let db = self.read()?;
        let mut statement = db.prepare("SELECT id, title, year, tags FROM sources WHERE trashed_at IS NULL AND tags <> '[]'").map_err(e)?;
        let rows = statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, String>(3)?)))
            .map_err(e)?;
        let mut names: Vec<String> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        let mut counts: Vec<usize> = Vec::new();
        let mut items = Vec::new();
        for row in rows {
            let (id, title, year, tags) = row.map_err(e)?;
            let tags: Vec<String> = serde_json::from_str(&tags).unwrap_or_default();
            let mut own = Vec::with_capacity(tags.len());
            for tag in tags {
                let i = *index.entry(tag.clone()).or_insert_with(|| {
                    names.push(tag.clone());
                    counts.push(0);
                    names.len() - 1
                });
                if !own.contains(&i) {
                    counts[i] += 1;
                    own.push(i);
                }
            }
            items.push(json!({"id": id, "title": title, "year": year, "tags": own}));
        }
        let total: i64 = db.query_row("SELECT count(*) FROM sources WHERE trashed_at IS NULL", [], |r| r.get(0)).map_err(e)?;
        let tags: Vec<Json> = names.iter().zip(&counts).map(|(n, c)| json!({"name": n, "count": c})).collect();
        Ok(json!({"tags": tags, "items": items, "sourceCount": total, "tree": Json::Object(read_tree(&db)?)}))
    }

    /// Applies one tag operation to every source holding the tags (trashed ones too, so
    /// nothing comes back on restore), in one transaction.
    pub fn apply_tags(&self, op: &TagOperation) -> Result<TagResult> {
        if op.replace.len() > 5000 || op.replace.iter().any(|r| r.from.trim().is_empty() || r.to.iter().any(|t| t.len() > 256)) {
            return Err("Invalid tag operation".into());
        }
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let mut snapshot = TagSnapshot::default();
        let replace: HashMap<String, &Vec<String>> = op.replace.iter().map(|r| (r.from.trim().to_lowercase(), &r.to)).collect();
        let values: Vec<(String, &Json)> = op.property.iter().flat_map(|p| p.values.iter().map(|(t, v)| (t.trim().to_lowercase(), v))).collect();
        let watched: HashSet<String> = replace.keys().cloned().chain(values.iter().map(|(t, _)| t.clone())).collect();
        // The property's definition first: created, or its options merged.
        if let Some(property) = &op.property {
            let name = property.name.trim();
            if name.is_empty() || name.len() > 128 || !property.config.is_object() {
                return Err("Invalid property".into());
            }
            let before: Option<String> = tx.query_row("SELECT config FROM property_definitions WHERE name = ?", [name], |r| r.get(0)).optional().map_err(e)?;
            let before: Option<Json> = before.and_then(|c| serde_json::from_str(&c).ok());
            let mut config = property.config.clone();
            if let Some(existing) = &before {
                let (old, new) = (existing.get("type").and_then(Json::as_str), config.get("type").and_then(Json::as_str));
                if old != new {
                    return Err(format!("“{name}” is already a {} property", old.unwrap_or("different")));
                }
                if new == Some("select") {
                    let mut options: Vec<String> = existing.get("options").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str).map(String::from).collect();
                    for option in config.get("options").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str) {
                        if !options.iter().any(|o| o == option) {
                            options.push(option.to_string());
                        }
                    }
                    config = existing.clone();
                    config["options"] = json!(options);
                } else {
                    config = existing.clone();
                }
            }
            if let Some(object) = config.as_object_mut() {
                object.remove("name");
            }
            tx.execute(
                "INSERT INTO property_definitions(name, config, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at",
                params![name, config.to_string(), now_ms()],
            )
            .map_err(e)?;
            properties::sync_options(&tx, name)?;
            snapshot.definition = Some((name.to_string(), before.unwrap_or(Json::Null)));
        }
        let (mut affected, mut kept) = (0, 0);
        if !watched.is_empty() {
            let rows: Vec<(String, String, String)> = {
                let mut statement = tx.prepare("SELECT id, tags, properties FROM sources WHERE tags <> '[]'").map_err(e)?;
                let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(e)?;
                rows.collect::<std::result::Result<_, _>>().map_err(e)?
            };
            for (id, tags, props) in rows {
                let tags: Vec<String> = serde_json::from_str(&tags).unwrap_or_default();
                if !tags.iter().any(|t| watched.contains(&t.trim().to_lowercase())) {
                    continue;
                }
                let props: Map<String, Json> = serde_json::from_str(&props).unwrap_or_default();
                let mut next: Vec<String> = Vec::new();
                let mut patch = Map::new();
                let mut before_props = Map::new();
                // Which value the property takes, and which tags it then stands for.
                let mut stored: HashSet<String> = HashSet::new();
                let mut kept_one = false;
                if let Some(property) = &op.property {
                    let name = property.name.trim().to_string();
                    let current = props.get(&name).filter(|v| !v.is_null() && v.as_str() != Some("")).cloned();
                    let held: Vec<&(String, &Json)> = values.iter().filter(|(t, _)| tags.iter().any(|x| x.trim().to_lowercase() == *t)).collect();
                    if let Some((_, first)) = held.first() {
                        let value = current.clone().unwrap_or_else(|| (*first).clone());
                        if current.is_none() {
                            before_props.insert(name.clone(), Json::Null);
                            patch.insert(name.clone(), value.clone());
                        }
                        for (tag, v) in &held {
                            if **v == value {
                                stored.insert(tag.clone());
                            } else {
                                kept_one = true;
                            }
                        }
                    }
                }
                for tag in &tags {
                    let key = tag.trim().to_lowercase();
                    let removed_by_property = op.property.as_ref().is_some_and(|p| p.remove_tags) && stored.contains(&key);
                    if removed_by_property {
                        continue;
                    }
                    match replace.get(&key) {
                        Some(to) => to.iter().for_each(|t| push_unique(&mut next, t)),
                        None => push_unique(&mut next, tag),
                    }
                }
                if kept_one {
                    kept += 1;
                }
                if next == tags && patch.is_empty() {
                    continue;
                }
                snapshot.sources.push(SourceTags { id: id.clone(), tags: tags.clone(), properties: before_props });
                write_source(&tx, &id, &next, Some(&patch))?;
                affected += 1;
            }
        }
        if !op.tree.is_empty() {
            let tree = read_tree(&tx)?;
            snapshot.tree = Some(Json::Object(tree.clone()));
            write_tree(&tx, &merge_json(tree, &op.tree))?;
        }
        tx.commit().map_err(e)?;
        Ok(TagResult { affected, kept, undo: snapshot })
    }

    /// Puts back what `apply_tags` overwrote, in one transaction.
    pub fn restore_tags(&self, snapshot: &TagSnapshot) -> Result<usize> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        if let Some((name, config)) = &snapshot.definition {
            if config.is_null() {
                tx.execute("DELETE FROM property_definitions WHERE name = ?", [name]).map_err(e)?;
            } else {
                tx.execute(
                    "INSERT INTO property_definitions(name, config, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at",
                    params![name, config.to_string(), now_ms()],
                )
                .map_err(e)?;
            }
            properties::sync_options(&tx, name)?;
        }
        for source in &snapshot.sources {
            let exists: bool = tx.query_row("SELECT count(*) FROM sources WHERE id = ?", [&source.id], |r| r.get::<_, i64>(0)).map_err(e)? > 0;
            if exists {
                write_source(&tx, &source.id, &source.tags, Some(&source.properties))?;
            }
        }
        if let Some(Json::Object(tree)) = &snapshot.tree {
            write_tree(&tx, tree)?;
        }
        tx.commit().map_err(e)?;
        Ok(snapshot.sources.len())
    }
}

#[cfg(test)]
mod tests {
    use crate::{SourceInput, Store};
    use serde_json::{Map, Value as Json, json};

    fn source(store: &Store, title: &str, tags: &[&str]) -> String {
        let mut fields = Map::new();
        fields.insert("title".into(), Json::from(title));
        store
            .insert_source(SourceInput { kind: "reference".into(), tags: tags.iter().map(|t| t.to_string()).collect(), fields, ..Default::default() })
            .unwrap()
            .id
    }

    fn op(value: Json) -> super::TagOperation {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn merge_rename_and_undo() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = source(&store, "A", &["ML", "machine learning", "survey"]);
        let b = source(&store, "B", &["machine-learning"]);
        let result = store
            .apply_tags(&op(json!({"replace": [{"from": "machine learning", "to": ["Machine learning"]}, {"from": "machine-learning", "to": ["Machine learning"]}, {"from": "ML", "to": ["Machine learning"]}], "tree": {"Machine learning": {"parent": "Methods"}}})))
            .unwrap();
        assert_eq!(result.affected, 2);
        assert_eq!(store.source(&a).unwrap().unwrap().tags, vec!["Machine learning", "survey"]);
        assert_eq!(store.source(&b).unwrap().unwrap().tags, vec!["Machine learning"]);
        let index = store.tag_index().unwrap();
        assert_eq!(index["tree"]["Machine learning"]["parent"], "Methods");
        store.restore_tags(&result.undo).unwrap();
        assert_eq!(store.source(&a).unwrap().unwrap().tags, vec!["ML", "machine learning", "survey"]);
        assert_eq!(store.source(&b).unwrap().unwrap().tags, vec!["machine-learning"]);
        assert!(store.tag_index().unwrap()["tree"].as_object().unwrap().is_empty());
    }

    #[test]
    fn convert_to_select_keeps_what_it_cannot_hold() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = source(&store, "A", &["to read", "x"]);
        let b = source(&store, "B", &["read", "to read"]);
        let c = source(&store, "C", &["x"]);
        let result = store
            .apply_tags(&op(json!({"property": {"name": "Status", "config": {"type": "select", "options": ["To read", "Read"]}, "values": [["read", "Read"], ["to read", "To read"]], "removeTags": true}})))
            .unwrap();
        assert_eq!(result.affected, 2);
        assert_eq!(result.kept, 1);
        let a1 = store.source(&a).unwrap().unwrap();
        assert_eq!(a1.properties["Status"], "To read");
        assert_eq!(a1.tags, vec!["x"]);
        let b1 = store.source(&b).unwrap().unwrap();
        assert_eq!(b1.properties["Status"], "Read");
        assert_eq!(b1.tags, vec!["to read"]);
        assert!(store.source(&c).unwrap().unwrap().properties.get("Status").is_none());
        assert_eq!(store.property_options("Status").unwrap().iter().map(|o| o.count).sum::<i64>(), 2);
        store.restore_tags(&result.undo).unwrap();
        assert!(store.property_definitions().unwrap().is_empty());
        let a2 = store.source(&a).unwrap().unwrap();
        assert!(a2.properties.get("Status").is_none());
        assert_eq!(a2.tags, vec!["to read", "x"]);
    }

    #[test]
    fn boolean_merges_into_an_existing_property() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.save_property_definition("Important", &json!({"type": "boolean"})).unwrap();
        let a = source(&store, "A", &["!important"]);
        let err = store.apply_tags(&op(json!({"property": {"name": "Important", "config": {"type": "select", "options": ["x"]}, "values": [["!important", "x"]]}})));
        assert!(err.is_err());
        let result = store.apply_tags(&op(json!({"property": {"name": "Important", "config": {"type": "boolean"}, "values": [["!important", true]], "removeTags": false}}))).unwrap();
        assert_eq!(result.affected, 1);
        let a1 = store.source(&a).unwrap().unwrap();
        assert_eq!(a1.properties["Important"], true);
        assert_eq!(a1.tags, vec!["!important"]);
        store.restore_tags(&result.undo).unwrap();
        assert_eq!(store.property_definitions().unwrap().len(), 1);
        assert!(store.source(&a).unwrap().unwrap().properties.get("Important").is_none());
    }
}
