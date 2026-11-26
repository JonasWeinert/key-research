// One search for everywhere something is looked up (the search tab and popup, Open Quickly,
// the link and citation pickers): what it finds, ranked and merged into three groups —
// titles and details, passages in the text, passages related by meaning — without repeats,
// counted by kind and narrowed to one item or to some kinds. The renderer only shows the
// groups in this order. Titles come back at once (`phase: "titles"`); the full-text and
// meaning search follow in a second call.
use crate::links::LinkTarget;
use crate::{Filter, ListQuery, Result, SearchQuery, SearchResult, Source, Store};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// The kinds the search tab counts.
pub const FIND_KINDS: &[&str] = &["source", "note", "record", "canvas", "highlight"];

/// A page or database of the workspace (key-library's records), as the host hands them in.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct PageRecord {
    pub id: String,
    pub kind: String,
    pub title: String,
}

/// "Only this note": results from one item.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ItemFilter {
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FindQuery {
    pub text: String,
    /// Search only these kinds ("highlight" asks for sources' highlights); all when absent.
    pub kinds: Option<Vec<String>>,
    /// Titles and details only.
    pub titles_only: bool,
    pub limit: Option<usize>,
    /// The library's filter tokens: then only sources (and their highlights) can match.
    pub filters: Vec<Filter>,
    pub item: Option<ItemFilter>,
    /// Kind chips: shown kinds after counting (none: all).
    pub show: Vec<String>,
    /// The search tab: count by kind and narrow (`item`, `show`).
    pub counted: bool,
    /// "titles" answers before the full-text search; anything else runs both.
    pub phase: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// titles | text | meaning
    pub group: String,
    /// Where it matched: "p. 4", "Abstract", "Note on …".
    #[serde(rename = "where", skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// A passage with `[[match]]` markers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<String>,
    /// Authors and year of a source ("Smith et al. · 2020"), so author matches show.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passage_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passage_text: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub titles: Vec<Found>,
    pub text: Vec<Found>,
    pub meaning: Vec<Found>,
    pub semantic: bool,
    /// The full-text search is still to come (after a `titles` phase).
    pub pending: bool,
    /// Per kind, before the kind chips narrow the results (`counted` only).
    pub counts: BTreeMap<String, usize>,
    pub all: usize,
}

/// "Smith", "Smith & Jones" or "Smith et al.".
pub fn short_creators(creators: &[crate::Creator]) -> String {
    let authors: Vec<&crate::Creator> = creators.iter().filter(|c| c.role.is_empty() || c.role == "author").collect();
    let list: Vec<&crate::Creator> = if authors.is_empty() { creators.iter().collect() } else { authors };
    let name = |c: &crate::Creator| c.family.clone().or(c.literal.clone()).or(c.given.clone()).unwrap_or_default();
    match list.len() {
        0 => String::new(),
        1 => name(list[0]),
        2 => format!("{} & {}", name(list[0]), name(list[1])),
        _ => format!("{} et al.", name(list[0])),
    }
}

fn byline(source: &Source) -> Option<String> {
    let year = source.fields.get("year").and_then(serde_json::Value::as_i64).map(|y| y.to_string());
    let parts: Vec<String> = [Some(short_creators(&source.creators)), year].into_iter().flatten().filter(|p| !p.is_empty()).collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn kind_of(found: &Found) -> &str {
    if found.anchor.as_deref().is_some_and(|a| a.starts_with("highlight:")) { "highlight" } else { &found.kind }
}

fn wanted(found: &Found, kinds: Option<&Vec<String>>) -> bool {
    kinds.is_none_or(|kinds| kinds.iter().any(|k| k == kind_of(found)))
}

fn key(found: &Found) -> String {
    format!("{}:{}:{}", found.kind, found.id, found.anchor.as_deref().unwrap_or(""))
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Exact and prefix title matches first, then a match at a word start, then by recency
/// (the order the store gives).
fn rank(query: &str, found: Vec<Found>) -> Vec<Found> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return found;
    }
    let first_word = q.chars().next().is_some_and(is_word);
    let score = |f: &Found| {
        let t = f.title.to_lowercase();
        if t == q {
            0
        } else if t.starts_with(&q) {
            1
        } else if t.match_indices(&q).any(|(at, _)| match t[..at].chars().last() {
            None => first_word,
            Some(p) => is_word(p) != first_word,
        }) {
            2
        } else {
            3
        }
    };
    let mut scored: Vec<(usize, usize, Found)> = found.into_iter().enumerate().map(|(i, f)| (score(&f), i, f)).collect();
    scored.sort_by_key(|(s, i, _)| (*s, *i));
    scored.into_iter().map(|(_, _, f)| f).collect()
}

fn target_found(target: &LinkTarget) -> Found {
    let highlight = target.item.anchor.as_deref().is_some_and(|a| a.starts_with("highlight:"));
    let kind = target.item.kind.as_str();
    let at = if highlight {
        let page = target.page.map(|p| format!("p. {}", p + 1));
        let parts: Vec<String> = [target.context.clone(), page].into_iter().flatten().filter(|p| !p.is_empty()).collect();
        (!parts.is_empty()).then(|| parts.join(" · "))
    } else {
        match kind {
            "note" => Some(if target.detail.as_deref() == Some("source note") { "Note on a source".into() } else { "Note".into() }),
            "canvas" => Some("Canvas".into()),
            "file" => target.context.clone(),
            _ => None,
        }
    };
    Found {
        kind: kind.into(),
        id: target.item.id.clone(),
        anchor: target.item.anchor.clone(),
        title: target.title.clone(),
        detail: if highlight { target.context.clone() } else { target.detail.clone() },
        color: target.color.clone(),
        group: "titles".into(),
        at,
        source_kind: if (kind == "source" && !highlight) || kind == "file" { target.detail.clone() } else { None },
        ..Default::default()
    }
}

fn source_found(source: &Source) -> Found {
    Found {
        kind: "source".into(),
        id: source.id.clone(),
        title: if source.title().is_empty() { "Untitled".into() } else { source.title().into() },
        detail: Some(source.kind.clone()),
        source_kind: Some(source.kind.clone()),
        group: "titles".into(),
        byline: byline(source),
        ..Default::default()
    }
}

/// What the full-text search found, grouped.
struct More {
    details: Vec<Found>,
    text: Vec<Found>,
    meaning: Vec<Found>,
    semantic: bool,
}

fn field_where(field: &str) -> Option<String> {
    Some(
        match field {
            "creators" => "Authors",
            "container" => "Journal",
            "abstract" => "Abstract",
            "tags" => "Tags",
            "notes" => "Notes",
            "identifiers" => "Identifier",
            _ => return None,
        }
        .into(),
    )
}

fn group_more(result: SearchResult, filtered: bool) -> More {
    let (mut details, mut text, mut meaning) = (Vec::new(), Vec::new(), Vec::new());
    for hit in result.hits {
        let source = hit.source.as_ref();
        let title = source.map(|s| s.title().to_string()).filter(|t| !t.is_empty()).or(Some(hit.title.clone()).filter(|t| !t.is_empty())).unwrap_or_else(|| "Untitled".into());
        let base = Found {
            kind: "source".into(),
            id: hit.source_id.clone(),
            title: title.clone(),
            source_kind: source.map(|s| s.kind.clone()),
            detail: source.map(|s| s.kind.clone()),
            byline: source.and_then(byline),
            document_hash: Some(hit.document_hash.clone()).filter(|h| !h.is_empty()),
            ..Default::default()
        };
        if let Some(field) = hit.fields.iter().find(|f| f.field != "notes").filter(|_| hit.metadata_match) {
            details.push(Found { group: "titles".into(), at: field_where(&field.field), snippet: Some(field.snippet.clone()), ..base.clone() });
        }
        for passage in hit.passages {
            let group = if passage.related { "meaning" } else { "text" };
            let found = match &passage.note_id {
                Some(note) => Found { kind: "note".into(), id: note.clone(), title: format!("Note on {title}"), group: group.into(), at: Some("Note".into()), snippet: Some(passage.snippet), ..Default::default() },
                None => Found {
                    passage_id: Some(passage.id),
                    passage_text: Some(passage.text),
                    anchor: passage.page.map(|p| format!("page:{p}")),
                    group: group.into(),
                    at: passage.page.map(|p| format!("p. {}", p + 1)),
                    snippet: Some(passage.snippet),
                    ..base.clone()
                },
            };
            if passage.related { meaning.push(found) } else { text.push(found) }
        }
    }
    if !filtered {
        for note in result.notes {
            if let Some(passage) = note.passages.into_iter().next() {
                let group = if passage.related { "meaning" } else { "text" };
                let title = if note.title.is_empty() { "Untitled note".into() } else { note.title.clone() };
                let found = Found { kind: "note".into(), id: note.note_id.clone(), title, group: group.into(), at: Some("Note".into()), snippet: Some(passage.snippet), ..Default::default() };
                if passage.related { meaning.push(found) } else { text.push(found) }
            }
        }
    }
    // Files of indexed linked folders: a name match is a detail, passages go below.
    for file in result.files {
        let base = Found { kind: "file".into(), id: file.file_id.clone(), title: file.name.clone(), at: Some(file.path.clone()), ..Default::default() };
        if file.name_match && file.passages.is_empty() {
            details.push(Found { group: "titles".into(), ..base.clone() });
        }
        if let Some(passage) = file.passages.into_iter().next() {
            let group = if passage.related { "meaning" } else { "text" };
            let found = Found { group: group.into(), snippet: Some(passage.snippet), ..base };
            if passage.related { meaning.push(found) } else { text.push(found) }
        }
    }
    More { details, text, meaning, semantic: result.semantic }
}

/// Both searches merged without repeats: a title match is never repeated below.
fn merge(titles: Vec<Found>, more: Option<More>, kinds: Option<&Vec<String>>) -> FindResult {
    let mut seen: HashSet<String> = titles.iter().map(key).collect();
    let in_titles: HashSet<String> = titles.iter().filter(|t| t.kind == "source" && t.anchor.is_none()).map(|t| t.id.clone()).collect();
    let mut take = |list: Vec<Found>| -> Vec<Found> { list.into_iter().filter(|f| wanted(f, kinds) && seen.insert(key(f))).collect() };
    let Some(more) = more else {
        return FindResult { titles, ..Default::default() };
    };
    let details = take(more.details.into_iter().filter(|d| !in_titles.contains(&d.id)).collect());
    let text = take(more.text);
    let meaning = take(more.meaning);
    let mut titles = titles;
    titles.extend(details);
    FindResult { titles, text, meaning, semantic: more.semantic, ..Default::default() }
}

/// Narrows to the item filter, counts by kind, then applies the kind chips.
fn narrow(mut found: FindResult, q: &FindQuery) -> FindResult {
    let in_item = |f: &Found| q.item.as_ref().is_none_or(|item| f.id == item.id && f.kind == item.kind);
    found.titles.retain(in_item);
    found.text.retain(in_item);
    found.meaning.retain(in_item);
    let typed = q.text.trim().to_lowercase();
    // The item itself leads when its name fits (or nothing was typed).
    if let Some(item) = &q.item {
        if !found.titles.iter().any(|f| f.id == item.id && f.anchor.is_none()) && (typed.is_empty() || item.label.to_lowercase().contains(&typed)) {
            let one = match item.kind.as_str() {
                "source" => "Source",
                "note" => "Note",
                "record" => "Page",
                "canvas" => "Canvas",
                _ => "Highlight",
            };
            found.titles.insert(0, Found { kind: item.kind.clone(), id: item.id.clone(), title: item.label.clone(), group: "titles".into(), at: Some(one.into()), ..Default::default() });
        }
    }
    let mut counts: BTreeMap<String, usize> = FIND_KINDS.iter().map(|k| ((*k).to_string(), 0)).collect();
    for f in found.titles.iter().chain(&found.text).chain(&found.meaning) {
        *counts.entry(kind_of(f).to_string()).or_default() += 1;
    }
    found.all = FIND_KINDS.iter().map(|k| counts[*k]).sum();
    found.counts = counts;
    if !q.show.is_empty() {
        let shown = |f: &Found| q.show.iter().any(|k| k == kind_of(f));
        found.titles.retain(shown);
        found.text.retain(shown);
        found.meaning.retain(shown);
    }
    found
}

impl Store {
    /// Titles and details: names of notes, sources, highlights, canvases and pages, ranked;
    /// with library filters only sources (and their highlights) can match.
    fn find_titles(&self, q: &FindQuery, records: &[PageRecord], limit: usize) -> Result<Vec<Found>> {
        let text = q.text.trim();
        if q.counted && !q.filters.is_empty() {
            let query = ListQuery { filters: q.filters.clone(), scope: Some("all".into()), sort: Some("added".into()), descending: true, ..Default::default() };
            let scoped = self.list_sources(&ListQuery { limit: Some(1000), ..query.clone() })?;
            let matching = if text.is_empty() { None } else { Some(self.list_sources(&ListQuery { text: Some(text.into()), limit: Some(limit), ..query })?) };
            let ids: HashSet<&str> = scoped.items.iter().map(|s| s.id.as_str()).collect();
            let highlights = self.link_targets(text, &["highlight".to_string()], limit * 2).unwrap_or_default();
            let mut out: Vec<Found> = matching.as_ref().unwrap_or(&scoped).items.iter().take(limit).map(source_found).collect();
            out.extend(highlights.iter().filter(|h| ids.contains(h.item.id.as_str())).take(limit).map(target_found));
            return Ok(out);
        }
        let kinds = q.kinds.as_ref();
        let store_kinds: Option<Vec<String>> = kinds.map(|k| k.iter().filter(|k| *k != "record").cloned().collect());
        let targets = match &store_kinds {
            Some(k) if k.is_empty() => Vec::new(),
            other => self.link_targets(text, other.as_deref().unwrap_or(&[]), limit)?,
        };
        let mut found: Vec<Found> = targets.iter().map(target_found).collect();
        // Sources show their authors and year beside the title.
        let ids: Vec<String> = found.iter().filter(|f| f.kind == "source" && f.anchor.is_none()).map(|f| f.id.clone()).collect();
        if !ids.is_empty() {
            let page = self.list_sources(&ListQuery { ids: Some(ids.clone()), scope: Some("all".into()), limit: Some(ids.len()), ..Default::default() })?;
            let bylines: HashMap<String, Option<String>> = page.items.iter().map(|s| (s.id.clone(), byline(s))).collect();
            for f in found.iter_mut().filter(|f| f.kind == "source" && f.anchor.is_none()) {
                f.byline = bylines.get(&f.id).cloned().flatten();
            }
        }
        if kinds.is_none_or(|k| k.iter().any(|k| k == "record")) {
            found.extend(records.iter().filter(|r| r.kind != "source").take(limit).map(|r| Found {
                kind: "record".into(),
                id: r.id.clone(),
                title: if r.title.is_empty() { "Untitled".into() } else { r.title.clone() },
                group: "titles".into(),
                at: Some(if r.kind == "database" { "Database".into() } else { "Page".into() }),
                ..Default::default()
            }));
        }
        found.retain(|f| wanted(f, kinds));
        Ok(rank(text, found))
    }

    /// The search everywhere: see the module comment. `records` are the workspace's pages
    /// matching the text; `vector` is the query's embedding for the meaning search.
    pub fn find(&self, q: &FindQuery, records: &[PageRecord], vector: Option<&[f32]>) -> Result<FindResult> {
        let limit = q.limit.unwrap_or(if q.counted { 10 } else { 8 }).clamp(1, 200);
        let titles = self.find_titles(q, records, limit)?;
        let text = q.text.trim();
        let wants_text = !q.titles_only && text.chars().count() >= 2;
        let more = if wants_text && q.phase.as_deref() != Some("titles") {
            let filter = ListQuery { filters: q.filters.clone(), limit: Some(if q.counted { limit + 4 } else { q.limit.unwrap_or(12) }), ..Default::default() };
            let search = SearchQuery { text: text.into(), mode: None, filter, passages_per_source: Some(2) };
            Some(group_more(self.search(&search, vector)?, !q.filters.is_empty()))
        } else {
            None
        };
        let pending = wants_text && more.is_none();
        let kinds = if q.counted { None } else { q.kinds.as_ref() };
        let mut found = merge(titles, more, kinds);
        found.pending = pending;
        Ok(if q.counted { narrow(found, q) } else { found })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn found(title: &str) -> Found {
        Found { kind: "note".into(), id: title.into(), title: title.into(), group: "titles".into(), ..Default::default() }
    }

    #[test]
    fn ranks_exact_then_prefix_then_word_start() {
        let ranked: Vec<String> = rank("mal", vec![found("Animal studies"), found("On malaria"), found("Malaria"), found("mal")]).into_iter().map(|f| f.title).collect();
        assert_eq!(ranked, ["mal", "Malaria", "On malaria", "Animal studies"]);
    }

    #[test]
    fn finds_titles_with_bylines_and_merges_text_without_repeats() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let input: crate::SourceInput = serde_json::from_value(json!({"kind": "reference", "title": "Malaria in children", "year": 2020, "abstract": "Malaria treatment outcomes", "creators": [{"family": "Smith", "given": "A"}, {"family": "Jones"}]})).unwrap();
        let id = store.insert_source(input).unwrap().id;
        let note = store.save_note(None, None, "Malaria reading list", "Notes about malaria", None).unwrap();
        let records = [PageRecord { id: "r1".into(), kind: "page".into(), title: "Malaria project".into() }];
        let q: FindQuery = serde_json::from_value(json!({"text": "malaria", "counted": true, "phase": "titles"})).unwrap();
        let first = store.find(&q, &records, None).unwrap();
        assert!(first.pending);
        let source = first.titles.iter().find(|f| f.id == id).unwrap();
        assert_eq!(source.byline.as_deref(), Some("Smith & Jones · 2020"));
        assert_eq!(first.counts["record"], 1);
        assert!(first.titles.iter().any(|f| f.id == note.id));
        let all = store.find(&FindQuery { phase: None, ..q.clone() }, &records, None).unwrap();
        assert!(!all.pending);
        // The source matched by title is not repeated as a detail match.
        assert_eq!(all.titles.iter().filter(|f| f.id == id).count(), 1);
        let only_pages = store.find(&FindQuery { show: vec!["record".into()], ..q.clone() }, &records, None).unwrap();
        assert_eq!(only_pages.titles.iter().map(|f| f.kind.as_str()).collect::<Vec<_>>(), ["record"]);
        assert_eq!(only_pages.all, first.all);
        let in_note = store.find(&FindQuery { item: Some(ItemFilter { kind: "note".into(), id: note.id.clone(), label: "Malaria reading list".into() }), ..q }, &records, None).unwrap();
        assert!(in_note.titles.iter().all(|f| f.id == note.id));
    }
}
