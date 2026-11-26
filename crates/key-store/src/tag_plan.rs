// A tag plan (a suggestion's, or one the tag manager builds) as one store operation for
// `apply_tags`, with a preview of exactly what will change. Plans are checked against the
// tags and tag tree as they are: one that no longer applies is an error with a reason.
use crate::tag_analysis::{TagIndex, fold, plural, quote};
use crate::{Result, TagOperation, TagProperty, TagReplace};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Split {
    pub tag: String,
    pub path: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TagPlan {
    Merge {
        from: Vec<String>,
        to: String,
    },
    Nest {
        parent: String,
        children: Vec<String>,
        /// A new name for the parent, applied with the nesting.
        #[serde(default, rename = "renameParent", skip_serializing_if = "Option::is_none")]
        rename_parent: Option<String>,
    },
    Hierarchy {
        splits: Vec<Split>,
    },
    Property {
        name: String,
        #[serde(rename = "propertyType")]
        property_type: String,
        values: Vec<(String, Json)>,
        #[serde(rename = "removeTags")]
        remove_tags: bool,
    },
    Delete {
        tags: Vec<String>,
    },
    Rename {
        tag: String,
        to: String,
    },
    Unnest {
        tags: Vec<String>,
    },
    Color {
        tags: Vec<String>,
        #[serde(default)]
        color: Option<String>,
    },
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Line {
    pub before: String,
    pub after: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedChange {
    pub operation: TagOperation,
    /// "Merge 3 tags into “Machine learning”".
    pub label: String,
    /// One line per change, for the preview.
    pub lines: Vec<Line>,
    /// Sources whose tags or properties change.
    pub items: usize,
    /// For a select property: sources holding more than one of its tags (they take the
    /// first value and keep the other tags).
    #[serde(skip_serializing_if = "is_zero")]
    pub multiple: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

fn key(name: &str) -> String {
    fold(name.trim())
}

struct Node {
    name: String,
    count: usize,
    parent: Option<String>,
}

/// The tags, their tree and which items hold each: built once, then any number of plans.
pub struct PlanContext<'a> {
    index: &'a TagIndex,
    /// In first-seen order (the index's tags, then the tree's entries).
    nodes: Vec<Node>,
    at: HashMap<String, usize>,
    holders: HashMap<String, HashSet<usize>>,
}

impl<'a> PlanContext<'a> {
    pub fn new(index: &'a TagIndex) -> Self {
        let mut context = PlanContext { index, nodes: Vec::new(), at: HashMap::new(), holders: HashMap::new() };
        for t in &index.tags {
            context.add(&t.name, t.count);
        }
        let meta_parent = |meta: &Json| meta.get("parent").and_then(Json::as_str).filter(|p| !p.is_empty()).map(String::from);
        for (name, meta) in &index.tree {
            context.add(name, 0);
            if let Some(parent) = meta_parent(meta) {
                context.add(&parent, 0);
            }
        }
        for (name, meta) in &index.tree {
            let Some(&node) = context.at.get(&key(name)) else { continue };
            let Some(parent) = meta_parent(meta).and_then(|p| context.at.get(&key(&p)).copied()) else { continue };
            if parent == node {
                continue;
            }
            // A parent chain that comes back to this tag would loop: it stays at the top.
            let mut up = Some(parent);
            let mut loops = false;
            for _ in 0..64 {
                let Some(u) = up else { break };
                if u == node {
                    loops = true;
                }
                up = context.nodes[u].parent.as_ref().and_then(|p| context.at.get(&key(p)).copied());
            }
            if !loops {
                context.nodes[node].parent = Some(context.nodes[parent].name.clone());
            }
        }
        let names: Vec<String> = index.tags.iter().map(|t| key(&t.name)).collect();
        for k in &names {
            context.holders.entry(k.clone()).or_default();
        }
        for (i, item) in index.items.iter().enumerate() {
            for &t in &item.tags {
                if let Some(k) = names.get(t) {
                    context.holders.entry(k.clone()).or_default().insert(i);
                }
            }
        }
        context
    }

    fn add(&mut self, name: &str, count: usize) {
        let k = key(name);
        match self.at.get(&k) {
            Some(&i) => self.nodes[i].count += count,
            None => {
                self.at.insert(k, self.nodes.len());
                self.nodes.push(Node { name: name.to_string(), count, parent: None });
            }
        }
    }

    fn node(&self, name: &str) -> Option<&Node> {
        self.at.get(&key(name)).map(|&i| &self.nodes[i])
    }

    fn has(&self, name: &str) -> bool {
        self.at.contains_key(&key(name))
    }

    fn count_of(&self, name: &str) -> usize {
        self.node(name).map(|n| n.count).unwrap_or(0)
    }

    fn existing_name(&self, name: &str) -> String {
        self.node(name).map(|n| n.name.clone()).unwrap_or_else(|| name.trim().to_string())
    }

    pub fn ancestors(&self, name: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut node = self.node(name);
        for _ in 0..64 {
            let Some(parent) = node.and_then(|n| n.parent.clone()) else { break };
            node = self.node(&parent);
            out.push(parent);
        }
        out
    }

    fn is_ancestor(&self, maybe: &str, of: &str) -> bool {
        key(maybe) == key(of) || self.ancestors(of).iter().any(|a| key(a) == key(maybe))
    }

    fn items_of(&self, names: &[String]) -> usize {
        let mut all = HashSet::new();
        for n in names {
            if let Some(h) = self.holders.get(&key(n)) {
                all.extend(h.iter().copied());
            }
        }
        all.len()
    }

    fn meta_key(&self, name: &str) -> Option<String> {
        self.index.tree.keys().find(|k| key(k) == key(name)).cloned()
    }

    fn meta_of(&self, name: &str) -> Map<String, Json> {
        self.meta_key(name).and_then(|k| self.index.tree.get(&k)).and_then(Json::as_object).cloned().unwrap_or_default()
    }

    /// Turns a plan into the store operation, its label and its preview.
    pub fn plan(&self, plan: &TagPlan) -> Result<PlannedChange> {
        let mut op = TagOperation::default();
        let mut lines: Vec<Line> = Vec::new();
        let set_meta = |op: &mut TagOperation, name: &str, next: Option<Map<String, Json>>| {
            let k = self.meta_key(name).unwrap_or_else(|| name.to_string());
            let next = next.map(|mut m| {
                for field in ["parent", "color"] {
                    if m.get(field).is_none_or(|v| v.is_null() || v.as_str() == Some("")) {
                        m.remove(field);
                    }
                }
                Json::Object(m)
            });
            op.tree.insert(k, next.unwrap_or(Json::Null));
        };
        let field = |m: &Map<String, Json>, f: &str| m.get(f).and_then(Json::as_str).filter(|s| !s.is_empty()).map(String::from);
        // Children of removed tags move up to `to` (or the removed tag's own parent).
        let reparent = |op: &mut TagOperation, removed: &[String], to: &dyn Fn(&str) -> Option<String>| {
            let gone: HashSet<String> = removed.iter().map(|r| key(r)).collect();
            for node in &self.nodes {
                if let Some(parent) = &node.parent {
                    if gone.contains(&key(parent)) && !gone.contains(&key(&node.name)) {
                        let mut meta = self.meta_of(&node.name);
                        meta.insert("parent".into(), to(parent).map(Json::from).unwrap_or(Json::Null));
                        set_meta(op, &node.name, Some(meta));
                    }
                }
            }
        };
        let one_or_many = |tags: &[String]| if tags.len() == 1 { quote(&tags[0]) } else { plural(tags.len(), "tag") };

        match plan {
            TagPlan::Rename { .. } | TagPlan::Merge { .. } => {
                let (from, to, rename) = match plan {
                    TagPlan::Rename { tag, to } => (vec![tag.clone()], to.trim().to_string(), true),
                    TagPlan::Merge { from, to } => (from.clone(), to.clone(), false),
                    _ => unreachable!(),
                };
                if to.is_empty() {
                    return Err("Enter a tag name.".into());
                }
                if to.encode_utf16().count() > 128 {
                    return Err("Tag names are at most 128 characters.".into());
                }
                let target = if from.iter().any(|f| key(f) == key(&to)) { to.clone() } else { self.existing_name(&to) };
                let sources: Vec<String> = from.iter().filter(|f| **f != target).cloned().collect();
                if sources.is_empty() {
                    return Err("Nothing to change.".into());
                }
                for f in &sources {
                    op.replace.push(TagReplace { from: f.clone(), to: vec![target.clone()] });
                    lines.push(Line { before: f.clone(), after: target.clone(), detail: Some(plural(self.count_of(f), "item")) });
                }
                // The surviving tag keeps its place, or takes the first merged tag's.
                let base = self.meta_of(&target);
                let inherited = sources.iter().map(|s| self.meta_of(s)).find(|m| field(m, "parent").is_some() || field(m, "color").is_some()).unwrap_or_default();
                let mut parent = field(&base, "parent").or_else(|| field(&inherited, "parent"));
                let color = field(&base, "color").or_else(|| field(&inherited, "color"));
                if parent.as_deref().is_some_and(|p| self.is_ancestor(&target, p)) {
                    parent = None;
                }
                for f in &sources {
                    if let Some(k) = self.meta_key(f).filter(|_| key(f) != key(&target)) {
                        op.tree.insert(k, Json::Null);
                    }
                }
                if parent.is_some() || color.is_some() || self.meta_key(&target).is_some() || sources.iter().any(|f| self.meta_key(f).is_some()) {
                    let mut next = Map::new();
                    if let Some(p) = parent {
                        next.insert("parent".into(), Json::from(p));
                    }
                    if let Some(c) = color {
                        next.insert("color".into(), Json::from(c));
                    }
                    set_meta(&mut op, &target, Some(next));
                }
                let removed: Vec<String> = sources.iter().filter(|f| key(f) != key(&target)).cloned().collect();
                let survivor = target.clone();
                reparent(&mut op, &removed, &|_| Some(survivor.clone()));
                let label = if rename || (sources.len() == 1 && !self.has(&to)) {
                    format!("Rename {} to {}", quote(&sources[0]), quote(&target))
                } else {
                    format!("Merge {} into {}", plural(sources.len(), "tag"), quote(&target))
                };
                let items = self.items_of(&sources);
                Ok(PlannedChange { operation: op, label, lines, items, multiple: 0 })
            }
            TagPlan::Delete { tags } => {
                if tags.is_empty() {
                    return Err("Choose at least one tag.".into());
                }
                for t in tags {
                    let count = self.count_of(t);
                    if count > 0 {
                        op.replace.push(TagReplace { from: t.clone(), to: vec![] });
                    }
                    if let Some(k) = self.meta_key(t) {
                        op.tree.insert(k, Json::Null);
                    }
                    let detail = if count > 0 { format!("removed from {}", plural(count, "item")) } else { "removed from the tree".into() };
                    lines.push(Line { before: t.clone(), after: String::new(), detail: Some(detail) });
                }
                reparent(&mut op, tags, &|removed| field(&self.meta_of(removed), "parent"));
                Ok(PlannedChange { operation: op, label: format!("Remove {}", one_or_many(tags)), lines, items: self.items_of(tags), multiple: 0 })
            }
            TagPlan::Nest { parent, children, rename_parent } => {
                let parent = self.existing_name(parent);
                if parent.is_empty() {
                    return Err("Enter a parent name.".into());
                }
                let renamed = rename_parent.as_deref().map(str::trim).filter(|r| !r.is_empty() && *r != parent).map(String::from);
                if renamed.as_ref().is_some_and(|r| r.encode_utf16().count() > 128) {
                    return Err("Tag names are at most 128 characters.".into());
                }
                let mut moved = 0;
                let target = match &renamed {
                    Some(to) if self.has(&parent) => {
                        if key(to) != key(&parent) && self.has(to) {
                            return Err(format!("There is already a tag {}: merge the two instead.", quote(to)));
                        }
                        let count = self.count_of(&parent);
                        if count > 0 {
                            op.replace.push(TagReplace { from: parent.clone(), to: vec![to.clone()] });
                        }
                        let mut meta = self.meta_of(&parent);
                        if let Some(k) = self.meta_key(&parent).filter(|k| k != to) {
                            op.tree.insert(k, Json::Null);
                        }
                        meta.retain(|_, v| !(v.is_null() || v.as_str() == Some("")));
                        op.tree.insert(to.clone(), Json::Object(meta));
                        let survivor = to.clone();
                        reparent(&mut op, std::slice::from_ref(&parent), &|_| Some(survivor.clone()));
                        lines.push(Line { before: parent.clone(), after: to.clone(), detail: Some(if count > 0 { format!("renamed on {}", plural(count, "item")) } else { "renamed".into() }) });
                        moved = count;
                        to.clone()
                    }
                    Some(to) => to.clone(),
                    None => parent.clone(),
                };
                if !self.has(&parent) {
                    set_meta(&mut op, &target, Some(Map::new()));
                }
                let renames = lines.len();
                for child in children {
                    if key(child) == key(&parent) || self.is_ancestor(child, &parent) {
                        continue;
                    }
                    let mut meta = self.meta_of(child);
                    meta.insert("parent".into(), Json::from(target.clone()));
                    set_meta(&mut op, child, Some(meta));
                    let shown = self.node(child).map(|n| n.name.clone()).unwrap_or_else(|| child.clone());
                    lines.push(Line { before: child.clone(), after: format!("{target} › {shown}"), detail: None });
                }
                let nested = lines.len() - renames;
                if nested == 0 {
                    return Err(if children.is_empty() { "Add a tag to nest.".into() } else { "A tag cannot go under itself or under a tag inside it.".into() });
                }
                let what = if nested == 1 { quote(&lines[renames].before) } else { plural(nested, "tag") };
                let label = if renames > 0 { format!("Nest {what} under {}, renamed from {}", quote(&target), quote(&parent)) } else { format!("Nest {what} under {}", quote(&target)) };
                Ok(PlannedChange { operation: op, label, lines, items: moved, multiple: 0 })
            }
            TagPlan::Unnest { tags } => {
                for t in tags {
                    let mut next = self.meta_of(t);
                    next.insert("parent".into(), Json::Null);
                    let keep = field(&next, "color").is_some() || self.count_of(t) == 0;
                    set_meta(&mut op, t, keep.then_some(next));
                    lines.push(Line { before: t.clone(), after: t.clone(), detail: Some("to the top level".into()) });
                }
                Ok(PlannedChange { operation: op, label: format!("Move {} to the top level", one_or_many(tags)), lines, items: 0, multiple: 0 })
            }
            TagPlan::Color { tags, color } => {
                for t in tags {
                    let mut next = self.meta_of(t);
                    next.insert("color".into(), color.clone().map(Json::from).unwrap_or(Json::Null));
                    set_meta(&mut op, t, Some(next));
                }
                let label = if color.as_deref().is_some_and(|c| !c.is_empty()) { "Change colour" } else { "Remove colour" };
                Ok(PlannedChange { operation: op, label: label.into(), lines, items: 0, multiple: 0 })
            }
            TagPlan::Hierarchy { splits } => {
                let splits: Vec<Split> = splits
                    .iter()
                    .map(|s| Split { tag: s.tag.clone(), path: s.path.iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect() })
                    .filter(|s| !s.path.is_empty())
                    .collect();
                if splits.is_empty() {
                    return Err("Choose at least one tag.".into());
                }
                if let Some(s) = splits.iter().find(|s| s.path.len() < 2) {
                    return Err(format!("Give {} a path of at least two parts, like “Topic › {}”.", quote(&s.tag), s.path[0]));
                }
                let mut leaves: HashMap<String, usize> = HashMap::new();
                for s in &splits {
                    if let Some(leaf) = s.path.last() {
                        *leaves.entry(key(leaf)).or_insert(0) += 1;
                    }
                }
                let mut ensured: HashSet<String> = HashSet::new();
                for Split { tag, path } in &splits {
                    let Some(leaf) = path.last() else { continue };
                    let chain: Vec<String> = path[..path.len() - 1].iter().map(|s| self.existing_name(s)).collect();
                    for (i, segment) in chain.iter().enumerate() {
                        if !ensured.insert(key(segment)) {
                            continue;
                        }
                        let mut current = self.meta_of(segment);
                        if i > 0 && field(&current, "parent").is_none() {
                            current.insert("parent".into(), Json::from(chain[i - 1].clone()));
                            set_meta(&mut op, segment, Some(current));
                        } else if !self.has(segment) && !op.tree.contains_key(&key(segment)) {
                            set_meta(&mut op, segment, Some(Map::new()));
                        }
                    }
                    // A short name another tag already has, or two paths share, keeps the full name.
                    let clash = leaves.get(&key(leaf)).copied().unwrap_or(0) > 1 || (self.has(leaf) && key(leaf) != key(tag));
                    let name = if clash { tag.clone() } else { leaf.clone() };
                    if name != *tag {
                        op.replace.push(TagReplace { from: tag.clone(), to: vec![name.clone()] });
                        if let Some(k) = self.meta_key(tag) {
                            op.tree.insert(k, Json::Null);
                        }
                    }
                    let mut meta = self.meta_of(tag);
                    meta.insert("parent".into(), chain.last().map(|c| Json::from(c.clone())).unwrap_or(Json::Null));
                    op.tree.insert(name.clone(), Json::Object(meta));
                    let mut shown = chain.clone();
                    shown.push(name.clone());
                    lines.push(Line { before: tag.clone(), after: shown.join(" › "), detail: (name == *tag).then(|| "keeps its name".to_string()) });
                }
                let renamed: Vec<String> = splits.iter().filter(|s| op.replace.iter().any(|r| r.from == s.tag)).map(|s| s.tag.clone()).collect();
                let items = self.items_of(&renamed);
                Ok(PlannedChange { operation: op, label: format!("Nest {} by their names", plural(splits.len(), "tag")), lines, items, multiple: 0 })
            }
            TagPlan::Property { name, property_type, values, remove_tags } => {
                let name = name.trim().to_string();
                if name.is_empty() {
                    return Err("Enter a property name.".into());
                }
                let values: Vec<(String, Json)> = values.iter().filter(|(t, _)| self.has(t)).cloned().collect();
                if values.is_empty() {
                    return Err("None of these tags are left.".into());
                }
                let text = |v: &Json| match v {
                    Json::String(s) => s.clone(),
                    other => other.to_string(),
                };
                let boolean = property_type == "boolean";
                let mut options: Vec<String> = Vec::new();
                for (_, v) in &values {
                    let v = text(v);
                    if !options.contains(&v) {
                        options.push(v);
                    }
                }
                let values: Vec<(String, Json)> = if boolean { values.into_iter().map(|(t, _)| (t, Json::Bool(true))).collect() } else { values };
                for (t, v) in &values {
                    let after = if boolean { format!("{name}: checked") } else { format!("{name}: {}", text(v)) };
                    lines.push(Line { before: t.clone(), after, detail: Some(plural(self.count_of(t), "item")) });
                }
                let tags: Vec<String> = values.iter().map(|(t, _)| t.clone()).collect();
                let multiple = if boolean || tags.len() < 2 {
                    0
                } else {
                    let wanted: HashSet<String> = tags.iter().map(|t| key(t)).collect();
                    let ids: HashSet<usize> = self.index.tags.iter().enumerate().filter(|(_, t)| wanted.contains(&key(&t.name))).map(|(i, _)| i).collect();
                    self.index.items.iter().filter(|item| item.tags.iter().filter(|t| ids.contains(t)).count() > 1).count()
                };
                let label = format!("Turn {} into {}", if tags.len() == 1 { quote(&tags[0]) } else { plural(tags.len(), "tag") }, quote(&name));
                op.property = Some(TagProperty {
                    name,
                    config: if boolean { json!({ "type": "boolean" }) } else { json!({ "type": "select", "options": options }) },
                    values,
                    remove_tags: *remove_tags,
                });
                Ok(PlannedChange { operation: op, label, lines, items: self.items_of(&tags), multiple })
            }
        }
    }
}
