// How the things in a library relate around one of them: the topics, fields, people,
// journals, tags and collections its sources share, each with how many of them, and how
// strongly the shown ones go together. A source's map is its own topics, people, journal,
// tags and collections, with the few library sources closest to it.
use crate::{Result, Store, e, graph::TOPIC_SOURCES};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Kinds a map shows, in the order they go round it.
pub const MAP_KINDS: [&str; 7] = ["topic", "field", "person", "venue", "tag", "collection", "source"];
/// The most sources whose relations are counted (the newest first).
const MAX_SOURCES: usize = 4000;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapNode {
    /// topic | field (a topic's subfield) | person | venue | tag | collection | source
    pub kind: String,
    pub id: String,
    pub name: String,
    /// Sources it shares with the centre (a source's map: sources in the library with it,
    /// or for a related source, how closely it relates).
    pub count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapLink {
    /// `kind:id` of both ends (never the centre).
    pub a: String,
    pub b: String,
    /// Sources the two share among the centre's.
    pub weight: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationMap {
    pub center: MapNode,
    pub nodes: Vec<MapNode>,
    pub links: Vec<MapLink>,
    /// How many more of each kind there are than are shown.
    pub more: BTreeMap<String, i64>,
}

type Key = (String, String);
/// A source's related things, by kind and id, with names.
type Memberships = HashMap<String, Vec<Key>>;

fn rows(db: &Connection, sql: &str, id: &str) -> Result<Vec<(String, String, String)>> {
    let mut statement = db.prepare(sql).map_err(e)?;
    statement
        .query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
        .map_err(e)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(e)
}

/// The sources of `kind` `id` as a subquery over `?1`.
fn source_set(kind: &str) -> Option<String> {
    Some(match kind {
        "person" => "SELECT sp.source_id FROM source_people sp WHERE sp.person_id = ?1".into(),
        "venue" => "SELECT s.id FROM sources s WHERE s.venue_id = ?1".into(),
        "topic" | "field" => TOPIC_SOURCES.into(),
        "tag" => "SELECT s.id FROM sources s, json_each(s.tags) j WHERE j.value = ?1".into(),
        "collection" => "SELECT sc.source_id FROM source_collections sc WHERE sc.collection_id IN (
            WITH RECURSIVE down(id) AS (SELECT ?1 UNION ALL SELECT c.id FROM collections c JOIN down ON c.parent_id = down.id) SELECT id FROM down)"
            .into(),
        _ => return None,
    })
}

/// What each source in `set` (a subquery over `?1`) relates to.
fn memberships(db: &Connection, set: &str, id: &str, live: &HashSet<String>) -> Result<Memberships> {
    let mut out: Memberships = HashMap::new();
    let mut add = |source: String, kind: &str, key: String, name: String| {
        if live.contains(&source) {
            out.entry(source).or_default().push((format!("{kind}:{key}"), name));
        }
    };
    let mut topics = db
        .prepare(&format!(
            "SELECT st.source_id, t.id, t.name, p.id, p.name, p.level FROM source_topics st JOIN topics t ON t.id = st.topic_id
             LEFT JOIN topics p ON p.id = t.parent_id WHERE st.source_id IN ({set})"
        ))
        .map_err(e)?;
    let found = topics
        .query_map([id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))
        })
        .map_err(e)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(e)?;
    for (source, topic, name, parent, parent_name) in found {
        add(source.clone(), "topic", topic, name);
        if let (Some(parent), Some(parent_name)) = (parent, parent_name) {
            add(source, "field", parent, parent_name);
        }
    }
    let queries = [
        ("person", format!("SELECT sp.source_id, p.id, p.name FROM source_people sp JOIN people p ON p.id = sp.person_id WHERE sp.source_id IN ({set})")),
        ("venue", format!("SELECT s.id, v.id, v.name FROM sources s JOIN venues v ON v.id = s.venue_id WHERE s.id IN ({set})")),
        ("tag", format!("SELECT s.id, j.value, j.value FROM sources s, json_each(s.tags) j WHERE s.id IN ({set})")),
        ("collection", format!("SELECT sc.source_id, c.id, c.name FROM source_collections sc JOIN collections c ON c.id = sc.collection_id WHERE sc.source_id IN ({set})")),
    ];
    for (kind, sql) in queries {
        for (source, key, name) in rows(db, &sql, id)? {
            add(source, kind, key, name);
        }
    }
    for list in out.values_mut() {
        list.sort();
        list.dedup_by(|a, b| a.0 == b.0);
    }
    Ok(out)
}

fn split(key: &str) -> (String, String) {
    let (kind, id) = key.split_once(':').unwrap_or(("", key));
    (kind.to_string(), id.to_string())
}

/// The `limit` most shared of each kind (most sources first, then by name), with how many
/// more there are.
fn strongest(counts: &HashMap<String, (i64, String)>, skip: &HashSet<String>, limit: usize) -> (Vec<MapNode>, BTreeMap<String, i64>) {
    let mut by_kind: HashMap<String, Vec<MapNode>> = HashMap::new();
    for (key, (count, name)) in counts {
        if skip.contains(key) {
            continue;
        }
        let (kind, id) = split(key);
        by_kind.entry(kind.clone()).or_default().push(MapNode { kind, id, name: name.clone(), count: *count, detail: None });
    }
    let mut nodes = Vec::new();
    let mut more = BTreeMap::new();
    for kind in MAP_KINDS {
        let Some(mut list) = by_kind.remove(kind) else { continue };
        list.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        if list.len() > limit {
            more.insert(kind.to_string(), (list.len() - limit) as i64);
            list.truncate(limit);
        }
        nodes.extend(list);
    }
    (nodes, more)
}

/// How often the shown things go together across `sources`.
fn co_links(nodes: &[MapNode], sources: &Memberships) -> Vec<MapLink> {
    let shown: HashSet<String> = nodes.iter().map(|n| format!("{}:{}", n.kind, n.id)).collect();
    let mut pairs: HashMap<(String, String), i64> = HashMap::new();
    for list in sources.values() {
        let here: Vec<&String> = list.iter().map(|(k, _)| k).filter(|k| shown.contains(*k)).collect();
        for (i, a) in here.iter().enumerate() {
            for b in &here[i + 1..] {
                let pair = if a < b { ((*a).clone(), (*b).clone()) } else { ((*b).clone(), (*a).clone()) };
                *pairs.entry(pair).or_default() += 1;
            }
        }
    }
    let mut links: Vec<MapLink> = pairs.into_iter().map(|((a, b), weight)| MapLink { a, b, weight }).collect();
    links.sort_by(|x, y| y.weight.cmp(&x.weight).then_with(|| (&x.a, &x.b).cmp(&(&y.a, &y.b))));
    links
}

fn name_of(db: &Connection, kind: &str, id: &str) -> Result<Option<String>> {
    let sql = match kind {
        "person" => "SELECT name FROM people WHERE id = ?",
        "venue" => "SELECT name FROM venues WHERE id = ?",
        "topic" | "field" => "SELECT name FROM topics WHERE id = ?",
        "collection" => "SELECT name FROM collections WHERE id = ?",
        "source" => "SELECT CASE WHEN title = '' THEN 'Untitled' ELSE title END FROM sources WHERE id = ? AND trashed_at IS NULL",
        "tag" => "SELECT ?1 FROM sources s, json_each(s.tags) j WHERE j.value = ?1 AND s.trashed_at IS NULL LIMIT 1",
        _ => return Ok(None),
    };
    db.query_row(sql, [id], |r| r.get(0)).optional().map_err(e)
}

/// A tag as a page of its own: how many sources carry it, and the years they span.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagPage {
    pub name: String,
    pub source_count: i64,
    pub first_year: Option<i64>,
    pub last_year: Option<i64>,
}

impl Store {
    /// People, journals, topics and tags whose name has a word starting with `text`, with
    /// how many live sources have each, most first (for choosing what a map centres on).
    pub fn find_map_centers(&self, text: &str, limit: usize) -> Result<Vec<MapNode>> {
        let typed = text.trim().to_lowercase();
        if typed.is_empty() {
            return Ok(Vec::new());
        }
        let escaped = typed.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let (starts, inner) = (format!("{escaped}%"), format!("% {escaped}%"));
        let db = self.read()?;
        let word = |column: &str| format!("(lower({column}) LIKE ?1 ESCAPE '\\' OR lower({column}) LIKE ?2 ESCAPE '\\')");
        let queries = [
            ("person", format!("SELECT p.id, p.name, count(DISTINCT s.id) n FROM people p JOIN source_people sp ON sp.person_id = p.id JOIN sources s ON s.id = sp.source_id AND s.trashed_at IS NULL WHERE {} GROUP BY p.id", word("p.name"))),
            ("venue", format!("SELECT v.id, v.name, count(*) n FROM venues v JOIN sources s ON s.venue_id = v.id AND s.trashed_at IS NULL WHERE {} GROUP BY v.id", word("v.name"))),
            ("topic", format!("SELECT t.id, t.name, count(DISTINCT s.id) n FROM topics t JOIN source_topics st ON st.topic_id = t.id JOIN sources s ON s.id = st.source_id AND s.trashed_at IS NULL WHERE {} GROUP BY t.id", word("t.name"))),
            ("tag", format!("SELECT j.value, j.value, count(DISTINCT s.id) n FROM sources s, json_each(s.tags) j WHERE s.trashed_at IS NULL AND {} GROUP BY j.value", word("j.value"))),
        ];
        let mut out = Vec::new();
        for (kind, sql) in queries {
            let mut statement = db.prepare(&format!("{sql} ORDER BY n DESC LIMIT {limit}")).map_err(e)?;
            let found = statement
                .query_map([&starts, &inner], |r| Ok(MapNode { kind: kind.into(), id: r.get(0)?, name: r.get(1)?, count: r.get(2)?, detail: None }))
                .map_err(e)?;
            for node in found {
                out.push(node.map_err(e)?);
            }
        }
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
        out.truncate(limit);
        Ok(out)
    }

    /// `None` when no source in the library (outside the Trash) has the tag.
    pub fn tag_page(&self, name: &str) -> Result<Option<TagPage>> {
        let db = self.read()?;
        let (count, first, last): (i64, Option<i64>, Option<i64>) = db
            .query_row(
                "SELECT count(DISTINCT s.id), min(s.year), max(s.year) FROM sources s, json_each(s.tags) j WHERE j.value = ?1 AND s.trashed_at IS NULL",
                [name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(e)?;
        Ok((count > 0).then(|| TagPage { name: name.into(), source_count: count, first_year: first, last_year: last }))
    }

    /// The map around a person, journal, topic, tag, collection or source; `limit` of each
    /// kind at most. `None` when it is not in the library.
    pub fn relation_map(&self, kind: &str, id: &str, limit: usize) -> Result<Option<RelationMap>> {
        let limit = limit.clamp(1, 40);
        let db = self.read()?;
        let kind = if kind == "field" { "topic" } else { kind };
        let Some(name) = name_of(&db, kind, id)? else { return Ok(None) };
        if kind == "source" {
            return source_map(&db, id, name, limit).map(Some);
        }
        let Some(set) = source_set(kind) else { return Err(format!("No relation map for {kind}")) };
        let mut statement = db
            .prepare(&format!("SELECT s.id FROM sources s WHERE s.trashed_at IS NULL AND s.id IN ({set}) ORDER BY s.year DESC, s.added_at DESC LIMIT {MAX_SOURCES}"))
            .map_err(e)?;
        let live: HashSet<String> = statement.query_map([id], |r| r.get(0)).map_err(e)?.collect::<std::result::Result<_, _>>().map_err(e)?;
        let sources = memberships(&db, &set, id, &live)?;
        let mut counts: HashMap<String, (i64, String)> = HashMap::new();
        for list in sources.values() {
            for (key, name) in list {
                counts.entry(key.clone()).or_insert((0, name.clone())).0 += 1;
            }
        }
        // Not the centre itself, nor (for a topic) the broader topics every one of its sources is in.
        let mut skip: HashSet<String> = [format!("{kind}:{id}")].into();
        if kind == "topic" {
            skip.insert(format!("field:{id}"));
            let mut up = db
                .prepare("WITH RECURSIVE up(id) AS (SELECT parent_id FROM topics WHERE id = ?1 UNION ALL SELECT t.parent_id FROM topics t JOIN up ON t.id = up.id WHERE t.parent_id IS NOT NULL) SELECT id FROM up WHERE id IS NOT NULL")
                .map_err(e)?;
            for parent in up.query_map([id], |r| r.get::<_, String>(0)).map_err(e)? {
                let parent = parent.map_err(e)?;
                skip.insert(format!("field:{parent}"));
                skip.insert(format!("topic:{parent}"));
            }
        }
        let (nodes, more) = strongest(&counts, &skip, limit);
        let links = co_links(&nodes, &sources);
        Ok(Some(RelationMap { center: MapNode { kind: kind.into(), id: id.into(), name, count: live.len() as i64, detail: None }, nodes, links, more }))
    }
}

/// A source's own things (sized by how many library sources have each) and the library
/// sources closest to it: shared topics and people, references in common, and citations
/// either way.
fn source_map(db: &Connection, id: &str, name: String, limit: usize) -> Result<RelationMap> {
    let me: HashSet<String> = [id.to_string()].into();
    let own = memberships(db, "SELECT ?1", id, &me)?.remove(id).unwrap_or_default();
    let mut nodes = Vec::new();
    let mut more = BTreeMap::new();
    for kind in MAP_KINDS {
        let mut list: Vec<MapNode> = own
            .iter()
            .filter(|(k, _)| split(k).0 == kind)
            .map(|(k, name)| {
                let (kind, key) = split(k);
                let count = set_count(db, &kind, &key).unwrap_or(1);
                MapNode { kind, id: key, name: name.clone(), count, detail: None }
            })
            .collect();
        list.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
        if list.len() > limit {
            more.insert(kind.to_string(), (list.len() - limit) as i64);
            list.truncate(limit);
        }
        nodes.extend(list);
    }
    // Related sources, scored.
    let mut score: HashMap<String, (i64, Vec<&'static str>)> = HashMap::new();
    let mut bump = |source: String, by: i64, why: &'static str| {
        let entry = score.entry(source).or_insert((0, Vec::new()));
        entry.0 += by;
        if !entry.1.contains(&why) {
            entry.1.push(why);
        }
    };
    let scored: [(&str, i64, &'static str); 5] = [
        ("SELECT st.source_id, count(*) FROM source_topics st WHERE st.topic_id IN (SELECT topic_id FROM source_topics WHERE source_id = ?1) AND st.source_id <> ?1 GROUP BY st.source_id", 2, "topics"),
        ("SELECT sp.source_id, count(DISTINCT sp.person_id) FROM source_people sp WHERE sp.person_id IN (SELECT person_id FROM source_people WHERE source_id = ?1) AND sp.source_id <> ?1 GROUP BY sp.source_id", 2, "authors"),
        ("SELECT b.source_id, count(*) FROM source_cites a JOIN source_cites b ON b.openalex_id = a.openalex_id WHERE a.source_id = ?1 AND b.source_id <> ?1 GROUP BY b.source_id", 1, "references"),
        ("SELECT matched_source_id, 1 FROM source_cites WHERE source_id = ?1 AND matched_source_id IS NOT NULL AND matched_source_id <> ?1", 3, "cited"),
        ("SELECT source_id, 1 FROM source_cites WHERE matched_source_id = ?1 AND source_id <> ?1", 3, "cites"),
    ];
    for (sql, weight, why) in scored {
        let mut statement = db.prepare(sql).map_err(e)?;
        for row in statement.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(e)? {
            let (source, n) = row.map_err(e)?;
            bump(source, n * weight, why);
        }
    }
    let mut related: Vec<(String, i64, Vec<&str>, String)> = Vec::new();
    for (source, (n, why)) in score {
        if let Some(title) = name_of(db, "source", &source)? {
            related.push((source, n, why, title));
        }
    }
    related.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.3.cmp(&b.3)));
    let cap = limit.min(6);
    if related.len() > cap {
        more.insert("source".into(), (related.len() - cap) as i64);
        related.truncate(cap);
    }
    let detail = |why: &[&str]| {
        let words: Vec<&str> = why
            .iter()
            .map(|w| match *w {
                "topics" => "shared topics",
                "authors" => "shared authors",
                "references" => "references in common",
                "cited" => "cited by this source",
                _ => "cites this source",
            })
            .collect();
        let text = words.join(", ");
        let mut chars = text.chars();
        chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
    };
    let related_ids: HashSet<String> = related.iter().map(|r| r.0.clone()).collect();
    for (source, n, why, title) in &related {
        nodes.push(MapNode { kind: "source".into(), id: source.clone(), name: title.clone(), count: *n, detail: Some(detail(why)) });
    }
    // Links: a related source to the things of this source it shares.
    let theirs = memberships(db, &format!("SELECT value FROM json_each(?1)"), &serde_json::to_string(&related_ids.iter().collect::<Vec<_>>()).map_err(e)?, &related_ids)?;
    let shown: HashSet<String> = nodes.iter().filter(|n| n.kind != "source").map(|n| format!("{}:{}", n.kind, n.id)).collect();
    let mut links = Vec::new();
    for (source, list) in theirs {
        for (key, _) in list {
            if shown.contains(&key) {
                links.push(MapLink { a: key, b: format!("source:{source}"), weight: 1 });
            }
        }
    }
    links.sort_by(|x, y| (&x.a, &x.b).cmp(&(&y.a, &y.b)));
    Ok(RelationMap { center: MapNode { kind: "source".into(), id: id.into(), name, count: 1, detail: None }, nodes, links, more })
}

/// How many live sources have it.
fn set_count(db: &Connection, kind: &str, id: &str) -> Result<i64> {
    let kind = if kind == "field" { "topic" } else { kind };
    let Some(set) = source_set(kind) else { return Ok(1) };
    db.query_row(&format!("SELECT count(DISTINCT s.id) FROM sources s WHERE s.trashed_at IS NULL AND s.id IN ({set})"), [id], |r| r.get(0))
        .map_err(e)
}

#[cfg(test)]
mod tests {
    use crate::{SourceInput, Store};
    use serde_json::json;

    fn work(n: u32, topics: &[(&str, &str)], refs: &[&str]) -> serde_json::Value {
        json!({
            "id": format!("https://openalex.org/W{n}"),
            "topics": topics.iter().map(|(id, name)| json!({
                "id": format!("https://openalex.org/{id}"), "display_name": name, "score": 0.9,
                "subfield": {"id": "https://openalex.org/subfields/1802", "display_name": "Information Systems"},
                "field": {"id": "https://openalex.org/fields/18", "display_name": "Decision Sciences"},
                "domain": {"id": "https://openalex.org/domains/2", "display_name": "Social Sciences"}
            })).collect::<Vec<_>>(),
            "referenced_works": refs.iter().map(|r| format!("https://openalex.org/{r}")).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn maps_what_a_topic_and_a_source_relate_to() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let collection = store.create_collection("Thesis", None, None).unwrap();
        let add = |title: &str, tags: &[&str], authors: &[&str]| {
            let input: SourceInput = serde_json::from_value(json!({
                "kind": "reference", "itemType": "article", "title": title, "tags": tags, "year": 2020,
                "containerTitle": "Journal of Maps", "collections": [collection.id],
                "creators": authors.iter().map(|a| json!({"family": a, "given": "A."})).collect::<Vec<_>>(),
            }))
            .unwrap();
            store.insert_source(input).unwrap().id
        };
        let a = add("One", &["graphs", "maps"], &["Ada", "Ben"]);
        let b = add("Two", &["graphs"], &["Ada"]);
        let c = add("Three", &["other"], &["Cy"]);
        store.apply_openalex_work(&a, &work(1, &[("T1", "Open science"), ("T2", "Citation analysis")], &["W90", "W91"])).unwrap();
        store.apply_openalex_work(&b, &work(2, &[("T1", "Open science")], &["W90"])).unwrap();
        store.apply_openalex_work(&c, &work(3, &[("T3", "Peer review")], &[])).unwrap();

        let map = store.relation_map("topic", "T1", 8).unwrap().unwrap();
        assert_eq!(map.center.name, "Open science");
        assert_eq!(map.center.count, 2);
        let node = |kind: &str, name: &str| map.nodes.iter().find(|n| n.kind == kind && n.name == name).map(|n| n.count);
        assert_eq!(node("tag", "graphs"), Some(2));
        assert_eq!(node("tag", "maps"), Some(1));
        assert_eq!(node("topic", "Citation analysis"), Some(1));
        assert_eq!(node("collection", "Thesis"), Some(2));
        assert_eq!(node("venue", "Journal of Maps"), Some(2));
        assert_eq!(node("topic", "Peer review"), None, "only what its sources share");
        assert_eq!(node("field", "Information Systems"), None, "not the topic's own subfield");
        let ada = map.nodes.iter().find(|n| n.kind == "person" && n.name.contains("Ada")).unwrap();
        assert_eq!(ada.count, 2);
        assert!(map.links.iter().any(|l| l.weight == 2 && (l.a == "tag:graphs" || l.b == "tag:graphs")));

        let capped = store.relation_map("topic", "T1", 1).unwrap().unwrap();
        assert_eq!(capped.nodes.iter().filter(|n| n.kind == "tag").count(), 1);
        assert_eq!(capped.more.get("tag"), Some(&1));

        let tag = store.relation_map("tag", "graphs", 8).unwrap().unwrap();
        assert_eq!(tag.center.count, 2);
        assert_eq!(store.tag_page("graphs").unwrap().unwrap().source_count, 2);
        assert!(store.tag_page("nothing").unwrap().is_none());
        let found = store.find_map_centers("gra", 8).unwrap();
        assert_eq!(found.first().map(|n| (n.kind.as_str(), n.count)), Some(("tag", 2)));
        assert!(store.find_map_centers("science", 8).unwrap().iter().any(|n| n.kind == "topic" && n.name == "Open science"));
        assert!(tag.nodes.iter().all(|n| !(n.kind == "tag" && n.id == "graphs")));

        let paper = store.relation_map("source", &a, 8).unwrap().unwrap();
        assert_eq!(paper.center.name, "One");
        let two = paper.nodes.iter().find(|n| n.kind == "source").unwrap();
        assert_eq!(two.name, "Two");
        assert!(two.detail.as_deref().unwrap().starts_with("Shared topics"));
        assert!(paper.links.iter().any(|l| l.a == "topic:T1" && l.b == format!("source:{b}")));
        assert!(paper.nodes.iter().all(|n| n.id != c), "an unrelated source is not shown");
        assert!(store.relation_map("person", "nobody", 8).unwrap().is_none());
    }
}
