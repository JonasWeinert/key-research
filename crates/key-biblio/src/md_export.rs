// Highlights and notes as Markdown files in a folder (an Obsidian or Logseq vault, or any
// folder), kept in sync without touching what the user writes there (md_region.rs).
//
// One file per source with highlights, named by a pattern (`{{citekey}}`, else its title),
// rendered from a template (template.rs) and found again by its `key-id` front-matter entry
// when the user renames or moves it. Writes are atomic; a file whose Key section was edited
// by hand is left alone and the new export goes beside it as `<name>.conflict.md`.
// Key's notes can be exported the same way, with citations as Pandoc `[@key]`.
use crate::export::{self, Scope};
use crate::filenames::{self, NamingRules};
use crate::md_region::{self as region, Merge};
use crate::template::Template;
use key_store::{Note, Source, Store};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const CONFIG: &str = "markdown.export";
const STATE: &str = "markdown.export.state";
const LAST: &str = "markdown.export.last";
const MAX_SCAN_FILES: usize = 20_000;
const MAX_SCAN_DEPTH: usize = 8;

pub const DEFAULT_PATTERN: &str = "{{citekey}}";
pub const DEFAULT_TEMPLATE: &str = r#"# {{title}}

{{#if reference}}
{{reference}}

{{/if}}
[Open in Key]({{link}}){{#if doi}} · [DOI](https://doi.org/{{doi}}){{/if}}

{{#if annotations}}
## Highlights

{{#each groups}}
{{#if name}}
### {{name}}

{{/if}}
{{#each annotations}}
{{#if comment}}
**{{comment}}**

{{/if}}
{{#if text}}
{{text | quote}} ([{{#if pageLabel}}p. {{pageLabel}}{{else}}open{{/if}}]({{link}}))

{{/if}}
{{#if image}}
![]({{image}})

{{/if}}
{{/each}}
{{/each}}
{{/if}}
"#;
pub const FRONT_MATTER_FIELDS: &[&str] =
    &["title", "authors", "year", "citekey", "itemType", "journal", "doi", "url", "tags", "collections", "reference", "exported", "annotationCount"];
const DEFAULT_FRONT: &[&str] = &["title", "authors", "year", "citekey", "doi", "tags", "collections"];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Off,
    /// A moment after highlights or details change.
    Change,
    /// Only when asked ("Export now", Export highlights).
    Demand,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Grouping {
    #[default]
    Page,
    Color,
    Tag,
    None,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sorting {
    #[default]
    Page,
    Created,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Deleted {
    /// Kept at the end, marked "Removed in Key".
    #[default]
    Mark,
    /// Dropped, unless the user wrote notes under it.
    Remove,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub folder: Option<PathBuf>,
    pub file_pattern: String,
    /// None: the default template.
    pub template: Option<String>,
    pub front_matter: Vec<String>,
    pub group_by: Grouping,
    pub sort_by: Sorting,
    pub mode: Mode,
    /// A "notes" place under each highlight that re-syncs keep.
    pub your_notes: bool,
    pub deleted: Deleted,
    /// Only sources in this collection are exported automatically.
    pub collection_id: Option<String>,
    pub export_notes: bool,
    pub notes_folder: Option<PathBuf>,
    /// Links to sources in notes become Pandoc citations (`[@key, p. 3]`).
    pub pandoc: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            folder: None,
            file_pattern: DEFAULT_PATTERN.into(),
            template: None,
            front_matter: DEFAULT_FRONT.iter().map(|s| s.to_string()).collect(),
            group_by: Grouping::Page,
            sort_by: Sorting::Page,
            mode: Mode::Off,
            your_notes: true,
            deleted: Deleted::Mark,
            collection_id: None,
            export_notes: false,
            notes_folder: None,
            pandoc: true,
        }
    }
}

impl Config {
    pub fn template_text(&self) -> &str {
        self.template.as_deref().filter(|t| !t.trim().is_empty()).unwrap_or(DEFAULT_TEMPLATE)
    }
}

/// What Key remembers about a file it wrote.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FileState {
    pub path: PathBuf,
    /// md_region::fingerprint of the section Key last wrote.
    pub fingerprint: String,
    /// Front-matter keys Key wrote.
    pub front: Vec<String>,
    /// What the item looked like then (store stamps.rs).
    pub stamp: String,
    pub written_at: i64,
    pub conflict: Option<PathBuf>,
    /// "source" or "note".
    pub kind: String,
    /// The user deleted the file from the folder: it is not written again until restored.
    pub removed: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub id: String,
    pub title: String,
    pub path: Option<PathBuf>,
    pub conflict: Option<PathBuf>,
    pub message: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Summary {
    pub at: i64,
    pub written: usize,
    pub unchanged: usize,
    pub conflicts: Vec<Problem>,
    pub errors: Vec<Problem>,
    /// Items left out because the user deleted their file from the folder.
    #[serde(default)]
    pub removed: usize,
    /// Files written this run (at most 50).
    pub files: Vec<PathBuf>,
}

/// What to export now.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Request {
    pub ids: Option<Vec<String>>,
    pub collection_id: Option<String>,
    /// Only what changed since it was last written.
    pub changed_only: bool,
    /// Replace Key's section even where it was edited (the user chose Key's version).
    pub force: bool,
    /// Notes too (when notes export is on).
    pub notes: bool,
}

/// The formatted reference of a source in the chosen style (Markdown), from the host.
pub type Cite<'a> = &'a dyn Fn(&Source) -> Option<String>;

pub fn config(store: &Store) -> Result<Config, String> {
    Ok(store.meta(CONFIG)?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default())
}

pub fn save_config(store: &Store, config: &Config) -> Result<Config, String> {
    Template::parse(config.template_text()).map_err(|e| format!("Template: {e}"))?;
    Template::parse(&config.file_pattern).map_err(|e| format!("File name: {e}"))?;
    for folder in config.folder.iter().chain(config.notes_folder.iter()) {
        if !folder.is_absolute() {
            return Err("Choose a folder".into());
        }
    }
    store.set_meta(CONFIG, &serde_json::to_string(config).map_err(|e| e.to_string())?)?;
    Ok(config.clone())
}

fn state(store: &Store) -> Result<HashMap<String, FileState>, String> {
    Ok(store.meta(STATE)?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default())
}

fn save_state(store: &Store, state: &HashMap<String, FileState>) -> Result<(), String> {
    store.set_meta(STATE, &serde_json::to_string(state).map_err(|e| e.to_string())?)
}

pub fn last_summary(store: &Store) -> Result<Option<Summary>, String> {
    Ok(store.meta(LAST)?.and_then(|t| serde_json::from_str(&t).ok()))
}

/// Files the user deleted from the export folder, which Key leaves out: id and the path it had.
pub fn removed(store: &Store) -> Result<Vec<Problem>, String> {
    let mut out: Vec<Problem> = state(store)?
        .into_iter()
        .filter(|(_, s)| s.removed)
        .map(|(id, s)| Problem { id, title: s.path.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), path: Some(s.path), conflict: None, message: String::new() })
        .collect();
    out.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(out)
}

/// Exports these removed files again from the next run on (all of them without `ids`).
pub fn restore_removed(store: &Store, ids: Option<&[String]>) -> Result<usize, String> {
    let mut all = state(store)?;
    let chosen: Vec<String> = all.iter().filter(|(id, s)| s.removed && ids.is_none_or(|ids| ids.contains(id))).map(|(id, _)| id.clone()).collect();
    for id in &chosen {
        all.remove(id);
    }
    save_state(store, &all)?;
    Ok(chosen.len())
}

/// The open conflicts (files Key did not overwrite).
pub fn conflicts(store: &Store) -> Result<Vec<Problem>, String> {
    let mut out: Vec<Problem> = state(store)?
        .into_iter()
        .filter_map(|(id, s)| s.conflict.clone().filter(|c| c.exists()).map(|c| Problem { id, title: s.path.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), path: Some(s.path), conflict: Some(c), message: String::new() }))
        .collect();
    out.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(out)
}

// ── Contexts ─────────────────────────────────────────────────────────────────

pub fn iso_date(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Bibliography HTML as Markdown: italics and bold kept, the rest as text.
pub fn html_to_markdown(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('>') else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let tag = rest[start + 1..start + end].trim().to_ascii_lowercase();
        let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        match name {
            "i" | "em" => out.push('*'),
            "b" | "strong" => out.push_str("**"),
            "br" => out.push('\n'),
            _ => {}
        }
        rest = &rest[start + end + 1..];
    }
    out.push_str(rest);
    let out = out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'").replace("&nbsp;", " ");
    out.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n")
}

pub fn source_link(id: &str, anchor: Option<&str>) -> String {
    let enc = |s: &str| s.replace('%', "%25").replace(' ', "%20").replace('#', "%23").replace('?', "%3F").replace(')', "%29").replace('(', "%28");
    match anchor {
        Some(a) => format!("key://source/{}#{}", enc(id), enc(a)),
        None => format!("key://source/{}", enc(id)),
    }
}

struct Ann {
    id: String,
    page: Option<i64>,
    index: f64,
    created: String,
    color: String,
    tags: Vec<String>,
    value: Json,
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

fn annotation(source_id: &str, a: &Json) -> Option<Ann> {
    let id = a.get("id").and_then(Json::as_str)?.to_string();
    let text = a.get("text").and_then(Json::as_str).unwrap_or("").trim().to_string();
    let comment = a.get("comment").and_then(Json::as_str).unwrap_or("").trim().to_string();
    let image = a.get("image").and_then(Json::as_str).unwrap_or("").to_string();
    if text.is_empty() && comment.is_empty() && image.is_empty() {
        return None;
    }
    let page = a.pointer("/range/start/page").and_then(Json::as_i64).or_else(|| a.pointer("/anchor/pages/0/page").and_then(Json::as_i64)).or_else(|| a.get("page").and_then(Json::as_i64));
    let index = a.pointer("/range/start/index").and_then(Json::as_f64).or_else(|| a.pointer("/anchor/pages/0/bounds/0/top").and_then(Json::as_f64)).unwrap_or(0.0);
    let color = a.get("color").and_then(Json::as_str).unwrap_or("orange").to_string();
    let created = a.get("createdAt").and_then(Json::as_str).unwrap_or("").to_string();
    let tags: Vec<String> = a.get("tags").and_then(Json::as_array).map(|t| t.iter().filter_map(Json::as_str).map(String::from).collect()).unwrap_or_default();
    let label = a.get("pageLabel").and_then(Json::as_str).map(String::from).or_else(|| page.map(|p| (p + 1).to_string()));
    let value = json!({
        "id": id,
        "text": text,
        "quote": text,
        "comment": comment,
        "color": color,
        "colorName": capitalize(&color),
        "page": page.map(|p| p + 1),
        "pageLabel": label,
        "link": source_link(source_id, Some(&format!("highlight:{id}"))),
        "created": created.get(..10).unwrap_or(&created),
        "tags": tags,
        "image": if image.is_empty() { Json::Null } else { Json::from(image.clone()) },
        "type": if text.is_empty() && image.is_empty() { "note" } else if text.is_empty() { "image" } else { "highlight" },
    });
    Some(Ann { id, page, index, created, color, tags, value })
}

const COLOR_ORDER: &[&str] = &["orange", "green", "blue", "pink", "purple"];

/// The fields a highlights template sees. `markers`: the notes kept per annotation (Some
/// writes the id comments around each one).
pub fn source_context(store: &Store, source: &Source, collections: &HashMap<String, String>, cite: Cite, config: &Config, markers: Option<&HashMap<String, String>>) -> Result<Json, String> {
    let mut anns: Vec<Ann> = store.annotations(&source.id)?.iter().filter_map(|a| annotation(&source.id, a)).collect();
    match config.sort_by {
        Sorting::Page => anns.sort_by(|a, b| a.page.unwrap_or(i64::MAX).cmp(&b.page.unwrap_or(i64::MAX)).then(a.index.total_cmp(&b.index)).then(a.created.cmp(&b.created))),
        Sorting::Created => anns.sort_by(|a, b| a.created.cmp(&b.created).then(a.id.cmp(&b.id))),
    }
    let wrap = |ann: &Ann| {
        let mut value = ann.value.clone();
        if let Some(notes) = markers {
            let (begin, end) = region::block_markers(&ann.id, notes.get(&ann.id).map(String::as_str), config.your_notes);
            value["__begin"] = Json::from(begin);
            value["__end"] = Json::from(end);
        }
        value
    };
    let mut groups: Vec<(String, Vec<Json>)> = Vec::new();
    let mut push = |name: String, value: Json| match groups.iter_mut().find(|(n, _)| *n == name) {
        Some((_, list)) => list.push(value),
        None => groups.push((name, vec![value])),
    };
    for ann in &anns {
        let name = match config.group_by {
            Grouping::Page => ann.page.map(|p| format!("Page {}", ann.value["pageLabel"].as_str().map(String::from).unwrap_or((p + 1).to_string()))).unwrap_or_else(|| "Other".into()),
            Grouping::Color => capitalize(&ann.color),
            Grouping::Tag => ann.tags.first().cloned().unwrap_or_else(|| "Untagged".into()),
            Grouping::None => String::new(),
        };
        push(name, wrap(ann));
    }
    if config.group_by == Grouping::Color {
        groups.sort_by_key(|(name, _)| COLOR_ORDER.iter().position(|c| c.eq_ignore_ascii_case(name)).unwrap_or(99));
    }
    // Flat list in the same order (markers only on the grouped one, so ids appear once).
    let flat: Vec<Json> = anns.iter().map(|a| a.value.clone()).collect();
    let mut out = match filenames::naming_context(source) {
        Json::Object(map) => map,
        _ => Map::new(),
    };
    let names = |role: &str| source.creators.iter().filter(|c| c.role == role).map(|c| c.display()).filter(|n| !n.is_empty()).collect::<Vec<_>>();
    out.insert("authors".into(), json!(names("author")));
    out.insert("editors".into(), json!(names("editor")));
    for (key, field) in [("date", "date"), ("url", "url"), ("abstract", "abstract"), ("isbn", "isbn"), ("language", "language")] {
        out.insert(key.into(), source.field(field).map(Json::from).unwrap_or(Json::Null));
    }
    out.insert("tags".into(), json!(source.tags));
    out.insert("collections".into(), json!(source.collections.iter().filter_map(|c| collections.get(c)).collect::<Vec<_>>()));
    out.insert("reference".into(), cite(source).map(Json::from).unwrap_or(Json::Null));
    out.insert("link".into(), Json::from(source_link(&source.id, None)));
    out.insert("exported".into(), Json::from(iso_date(key_store::now_ms())));
    out.insert("annotationCount".into(), Json::from(flat.len()));
    out.insert("annotations".into(), Json::Array(flat));
    out.insert("groups".into(), Json::Array(groups.into_iter().map(|(name, list)| json!({ "name": name, "annotations": list })).collect()));
    let notes: Vec<Json> = store.notes(&source.id)?.into_iter().map(|n| json!({ "title": n.title, "body": n.body })).collect();
    out.insert("notes".into(), Json::Array(notes));
    Ok(Json::Object(out))
}

/// A tag as Obsidian takes it in front matter (no spaces or #).
fn vault_tag(tag: &str) -> String {
    tag.trim().trim_start_matches('#').split_whitespace().collect::<Vec<_>>().join("-")
}

fn front_matter(context: &Json, fields: &[String]) -> Vec<(String, Json)> {
    fields
        .iter()
        .filter_map(|field| {
            let value = context.get(field)?;
            let value = match (field.as_str(), value) {
                ("tags", Json::Array(tags)) => Json::Array(tags.iter().filter_map(Json::as_str).map(vault_tag).filter(|t| !t.is_empty()).map(Json::from).collect()),
                (_, Json::Null) => return None,
                (_, Json::String(s)) if s.is_empty() => return None,
                (_, Json::Array(_) | Json::String(_) | Json::Number(_) | Json::Bool(_)) => value.clone(),
                _ => return None,
            };
            Some((field.clone(), value))
        })
        .collect()
}

/// `a/b/{{citekey}}` → a safe relative path ending in `.md`.
fn relative_path(pattern: &Template, context: &Json, fallback: &str) -> PathBuf {
    let rules = NamingRules { max_length: 150, ..Default::default() };
    let rendered = pattern.render(context);
    let mut parts: Vec<String> = rendered.split('/').map(|p| filenames::clean(p, &rules)).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        let title = filenames::clean(fallback, &rules);
        parts.push(if title.is_empty() { "Untitled".into() } else { title });
    }
    let mut path = PathBuf::new();
    let last = parts.pop().unwrap_or_default();
    for p in parts {
        path.push(p);
    }
    path.push(format!("{last}.md"));
    path
}

// ── Finding files ────────────────────────────────────────────────────────────

/// Markdown files in a folder by their `key-id`, read once per run.
struct Vault {
    root: PathBuf,
    index: Option<HashMap<String, PathBuf>>,
}

fn is_conflict_copy(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.to_string_lossy().ends_with(".conflict.md"))
}

fn head(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut buffer = vec![0; 64 * 1024];
    let mut file = std::fs::File::open(path).ok()?;
    let read = file.read(&mut buffer).ok()?;
    buffer.truncate(read);
    Some(String::from_utf8_lossy(&buffer).to_string())
}

fn id_of(path: &Path) -> Option<String> {
    region::front_matter_value(&head(path)?, region::ID_KEY)
}

impl Vault {
    fn new(root: &Path) -> Self {
        Self { root: root.to_path_buf(), index: None }
    }
    fn find(&mut self, id: &str) -> Option<PathBuf> {
        if self.index.is_none() {
            let mut index = HashMap::new();
            let mut stack = vec![(self.root.clone(), 0)];
            let mut seen = 0;
            while let Some((dir, depth)) = stack.pop() {
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') {
                        continue;
                    }
                    let Ok(kind) = entry.file_type() else { continue };
                    if kind.is_dir() && depth < MAX_SCAN_DEPTH {
                        stack.push((path, depth + 1));
                    } else if kind.is_file() && name.ends_with(".md") && !is_conflict_copy(&path) {
                        seen += 1;
                        if seen > MAX_SCAN_FILES {
                            break;
                        }
                        if let Some(found) = id_of(&path) {
                            index.entry(found).or_insert(path);
                        }
                    }
                }
            }
            self.index = Some(index);
        }
        self.index.as_ref()?.get(id).cloned()
    }
}

// ── Writing one file ─────────────────────────────────────────────────────────

pub enum Outcome {
    Written(PathBuf),
    Unchanged(PathBuf),
    Conflict { path: PathBuf, copy: PathBuf, reason: String },
    /// Its file was deleted by the user; left out.
    Removed,
}

fn stamp(path: &Path) -> Option<(u64, std::time::SystemTime)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.len(), m.modified().ok()?))
}

/// Writes `text` atomically, unless the file changed since `seen`.
fn write_checked(path: &Path, text: &str, seen: Option<(u64, std::time::SystemTime)>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    if stamp(path) != seen {
        return Err("The file changed while Key was writing it; it is tried again next time".into());
    }
    crate::autoexport::write_atomic(path, text)
}

struct Doc<'a> {
    id: &'a str,
    title: &'a str,
    kind: &'static str,
    folder: &'a Path,
    default_path: PathBuf,
    front: Vec<(String, Json)>,
    stamp: String,
}

/// Where the item's file is: where Key last wrote it if it is still there, else wherever
/// the user moved it in the folder, else a new name.
fn locate(doc: &Doc, known: Option<&FileState>, vault: &mut Vault) -> PathBuf {
    if let Some(known) = known {
        if known.path.is_file() && id_of(&known.path).as_deref() == Some(doc.id) {
            return known.path.clone();
        }
    }
    if let Some(found) = vault.find(doc.id) {
        return found;
    }
    let wanted = doc.folder.join(&doc.default_path);
    if !wanted.exists() || id_of(&wanted).as_deref() == Some(doc.id) {
        return wanted;
    }
    let dir = wanted.parent().unwrap_or(doc.folder).to_path_buf();
    let name = wanted.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let rules = NamingRules::default();
    dir.join(filenames::unique(&name, &rules, &|n| dir.join(n).exists() || n.to_lowercase().ends_with(".conflict.md")))
}

fn sync_doc(doc: &Doc, render: &dyn Fn(&HashMap<String, String>) -> String, live: &HashSet<String>, config: &Config, state: &mut HashMap<String, FileState>, vault: &mut Vault, force: bool) -> Result<Outcome, String> {
    let known = state.get(doc.id).cloned();
    if let Some(k) = &known {
        // A file Key wrote that is gone from the folder (not moved or renamed in it, and the
        // folder itself still there): the user removed it, and Key leaves it out from now on.
        let deleted = !k.path.as_os_str().is_empty()
            && k.path.starts_with(doc.folder)
            && k.path.parent().is_some_and(Path::exists)
            && !k.path.exists()
            && vault.find(doc.id).is_none();
        if k.removed || deleted {
            if !k.removed {
                state.insert(doc.id.to_string(), FileState { removed: true, ..k.clone() });
            }
            return Ok(Outcome::Removed);
        }
    }
    let path = locate(doc, known.as_ref(), vault);
    let seen = stamp(&path);
    let mut existing = match std::fs::read(&path) {
        Ok(bytes) => Some(String::from_utf8(bytes).map_err(|_| format!("{} is not UTF-8 text", path.display()))?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    if force {
        if let Some(text) = existing.as_mut() {
            if !matches!(region::find_region(text), Ok(Some(_))) {
                text.push_str(&format!("\n\n{}\n", region::region(doc.id, "")));
            }
        }
    }
    let old = region::old_blocks(existing.as_deref());
    let notes = region::notes_by_id(&old);
    let body = render(&notes);
    let carried: Vec<String> = old
        .iter()
        .filter(|b| !live.contains(&b.id))
        .filter(|b| b.deleted || config.deleted == Deleted::Mark || !b.notes.trim().is_empty())
        .map(region::mark_deleted)
        .collect();
    let previous = known.as_ref().map(|k| k.front.clone()).unwrap_or_default();
    let export = region::Export { id: doc.id, front: doc.front.clone(), previous_front: &previous, body, carried };
    let expected = if force { None } else { known.as_ref().map(|k| k.fingerprint.clone()).filter(|f| !f.is_empty()) };
    let entry = |path: &Path, text: &str, conflict: Option<PathBuf>, old: Option<&FileState>| FileState {
        path: path.to_path_buf(),
        fingerprint: match region::find_region(text) {
            Ok(Some((s, e))) => region::fingerprint(&text[s..e]),
            _ => old.map(|o| o.fingerprint.clone()).unwrap_or_default(),
        },
        front: std::iter::once(region::ID_KEY.to_string()).chain(doc.front.iter().map(|(k, _)| k.clone())).collect(),
        stamp: doc.stamp.clone(),
        written_at: key_store::now_ms(),
        conflict,
        kind: doc.kind.into(),
        removed: false,
    };
    match region::merge(existing.as_deref(), &export, expected.as_deref()) {
        Merge::Write(text) => {
            if let Some(copy) = known.as_ref().and_then(|k| k.conflict.as_ref()) {
                let _ = std::fs::remove_file(copy);
            }
            if existing.as_deref() == Some(text.as_str()) {
                state.insert(doc.id.to_string(), entry(&path, &text, None, known.as_ref()));
                return Ok(Outcome::Unchanged(path));
            }
            write_checked(&path, &text, seen)?;
            state.insert(doc.id.to_string(), entry(&path, &text, None, known.as_ref()));
            Ok(Outcome::Written(path))
        }
        Merge::Conflict { reason, fresh } => {
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| doc.title.to_string());
            let copy = path.with_file_name(format!("{stem}.conflict.md"));
            crate::autoexport::write_atomic(&copy, &fresh)?;
            let mut kept = known.clone().unwrap_or_default();
            kept.path = path.clone();
            kept.conflict = Some(copy.clone());
            kept.kind = doc.kind.into();
            if kept.front.is_empty() {
                kept.front = entry(&path, "", None, None).front;
            }
            state.insert(doc.id.to_string(), kept);
            Ok(Outcome::Conflict { path, copy, reason })
        }
    }
}

// ── Runs ─────────────────────────────────────────────────────────────────────

fn collection_names(store: &Store) -> Result<HashMap<String, String>, String> {
    Ok(store.collections()?.into_iter().map(|c| (c.id, c.name)).collect())
}

/// The highlights template rendered for one source (no markers, no front matter): the
/// one-shot "Export highlights" and the template preview.
pub fn render_source(store: &Store, source: &Source, config: &Config, cite: Cite) -> Result<String, String> {
    let template = Template::parse(config.template_text())?;
    let context = source_context(store, source, &collection_names(store)?, cite, config, None)?;
    Ok(tidy(&template.render(&context)))
}

/// Collapses runs of blank lines a template leaves (the user's notes stay as written).
fn tidy(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = 0;
    let mut notes = false;
    for line in text.lines() {
        if notes || line == region::NOTES {
            notes = line != region::ANN_END;
            out.push_str(line);
            out.push('\n');
            blank = 0;
            continue;
        }
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out.trim_matches('\n').to_string() + "\n"
}

/// Highlights of several sources as one Markdown text (clipboard or a file).
pub fn render_text(store: &Store, scope: &Scope, config: &Config, cite: Cite) -> Result<(String, usize), String> {
    let template = Template::parse(config.template_text())?;
    let names = collection_names(store)?;
    let mut parts = Vec::new();
    for source in export::sources(store, scope)?.into_iter().filter(|s| s.trashed_at.is_none() && (scope.ids.is_some() || s.annotation_count > 0)) {
        let context = source_context(store, &source, &names, cite, config, None)?;
        parts.push(tidy(&template.render(&context)));
    }
    let count = parts.len();
    Ok((parts.join("\n---\n\n"), count))
}

/// A preview of the file a template writes, for a real source (the given one, else the one
/// with the most highlights).
pub fn preview(store: &Store, config: &Config, source_id: Option<&str>, cite: Cite) -> Result<Json, String> {
    let template = Template::parse(config.template_text())?;
    let pattern = Template::parse(&config.file_pattern).map_err(|e| format!("File name: {e}"))?;
    let id = match source_id {
        Some(id) => Some(id.to_string()),
        None => store.annotation_stamps()?.into_iter().max_by_key(|(id, s)| (s.split(':').next().and_then(|n| n.parse::<i64>().ok()).unwrap_or(0), id.clone())).map(|(id, _)| id),
    };
    let Some(source) = id.and_then(|id| store.source(&id).ok().flatten()) else {
        return Ok(json!({ "empty": true }));
    };
    let context = source_context(store, &source, &collection_names(store)?, cite, config, Some(&HashMap::new()))?;
    let body = tidy(&template.render(&context));
    let export = region::Export { id: &source.id, front: front_matter(&context, &config.front_matter), previous_front: &[], body, carried: vec![] };
    let Merge::Write(file) = region::merge(None, &export, None) else { return Err("Could not render".into()) };
    Ok(json!({ "sourceId": source.id, "title": source.title(), "fileName": relative_path(&pattern, &context, source.title()), "text": file, "annotationCount": context["annotationCount"] }))
}

fn problem(id: &str, title: &str, path: Option<PathBuf>, conflict: Option<PathBuf>, message: String) -> Problem {
    Problem { id: id.into(), title: title.into(), path, conflict, message }
}

/// Exports highlights (and notes) to the configured folders.
pub fn sync(store: &Store, request: &Request, cite: Cite) -> Result<Summary, String> {
    let config = config(store)?;
    let folder = config.folder.clone().ok_or("Choose a folder for Markdown export in Settings")?;
    if !folder.is_dir() {
        return Err(format!("The folder {} does not exist", folder.display()));
    }
    let template = Template::parse(config.template_text())?;
    let pattern = Template::parse(&config.file_pattern)?;
    let names = collection_names(store)?;
    let mut state = state(store)?;
    let stamps = store.annotation_stamps()?;
    let mut summary = Summary { at: key_store::now_ms(), ..Default::default() };
    let mut vault = Vault::new(&folder);

    // Which sources: the ones asked for, else those with highlights (in the collection, when
    // one is chosen) and the ones exported before (their highlights may all be gone).
    let ids: Vec<String> = match (&request.ids, request.collection_id.as_ref().or(config.collection_id.as_ref())) {
        (Some(ids), _) => ids.clone(),
        (None, Some(collection)) => {
            let members: HashSet<String> = export::sources(store, &Scope { ids: None, collection_id: Some(collection.clone()) })?.into_iter().map(|s| s.id).collect();
            let mut ids: Vec<String> = stamps.keys().filter(|id| members.contains(*id)).cloned().collect();
            ids.extend(state.iter().filter(|(id, s)| s.kind == "source" && members.contains(*id) && !stamps.contains_key(*id)).map(|(id, _)| id.clone()));
            ids
        }
        (None, None) => {
            let mut ids: Vec<String> = stamps.keys().cloned().collect();
            ids.extend(state.iter().filter(|(id, s)| s.kind == "source" && !stamps.contains_key(*id)).map(|(id, _)| id.clone()));
            ids
        }
    };
    let mut ids = ids;
    ids.sort();
    ids.dedup();
    for id in ids {
        let stamp = stamps.get(&id).cloned().unwrap_or_default();
        if request.changed_only && state.get(&id).is_some_and(|s| s.stamp == stamp && s.conflict.is_none()) {
            continue;
        }
        let Some(source) = store.source(&id)? else {
            continue;
        };
        if source.trashed_at.is_some() {
            continue;
        }
        let title = source.title().to_string();
        let plain = source_context(store, &source, &names, cite, &config, None)?;
        let live: HashSet<String> = plain["annotations"].as_array().into_iter().flatten().filter_map(|a| a["id"].as_str().map(String::from)).collect();
        let doc = Doc { id: &id, title: &title, kind: "source", folder: &folder, default_path: relative_path(&pattern, &plain, &title), front: front_matter(&plain, &config.front_matter), stamp };
        let render = |notes: &HashMap<String, String>| match source_context(store, &source, &names, cite, &config, Some(notes)) {
            Ok(context) => tidy(&template.render(&context)),
            Err(_) => String::new(),
        };
        record(&mut summary, &id, &title, sync_doc(&doc, &render, &live, &config, &mut state, &mut vault, request.force));
    }
    if request.notes && config.export_notes {
        if let Some(notes_folder) = config.notes_folder.clone().filter(|f| f.is_dir()) {
            sync_notes(store, &config, &notes_folder, request, &mut state, &mut summary)?;
        }
    }
    save_state(store, &state)?;
    store.set_meta(LAST, &serde_json::to_string(&summary).map_err(|e| e.to_string())?)?;
    Ok(summary)
}

fn record(summary: &mut Summary, id: &str, title: &str, outcome: Result<Outcome, String>) {
    match outcome {
        Ok(Outcome::Written(path)) => {
            summary.written += 1;
            if summary.files.len() < 50 {
                summary.files.push(path);
            }
        }
        Ok(Outcome::Unchanged(_)) => summary.unchanged += 1,
        Ok(Outcome::Removed) => summary.removed += 1,
        Ok(Outcome::Conflict { path, copy, reason }) => summary.conflicts.push(problem(id, title, Some(path), Some(copy), reason)),
        Err(message) => summary.errors.push(problem(id, title, None, None, message)),
    }
}

/// A digest of everything an automatic export depends on; a change means a run is due.
pub fn change_digest(store: &Store) -> Result<u64, String> {
    let mut stamps: Vec<(String, String)> = store.annotation_stamps()?.into_iter().collect();
    let config = config(store)?;
    if config.export_notes {
        stamps.extend(store.note_stamps()?);
    }
    stamps.sort();
    let text: String = stamps.into_iter().map(|(id, s)| format!("{id}={s};")).collect();
    Ok(region::fnv(format!("{text}|{}", serde_json::to_string(&config).unwrap_or_default()).as_bytes()))
}

// ── Notes ────────────────────────────────────────────────────────────────────

struct Citer<'a> {
    store: &'a Store,
    sources: HashMap<String, Option<(String, String)>>,
    pages: HashMap<String, HashMap<String, i64>>,
    note_titles: HashMap<String, String>,
}

impl Citer<'_> {
    /// (citation key, title) of a source.
    fn source(&mut self, id: &str) -> Option<(String, String)> {
        if !self.sources.contains_key(id) {
            let found = self.store.source(id).ok().flatten().map(|s| (s.field("citationKey").unwrap_or("").to_string(), s.title().to_string()));
            self.sources.insert(id.to_string(), found);
        }
        self.sources[id].clone()
    }
    fn highlight_page(&mut self, source: &str, highlight: &str) -> Option<i64> {
        if !self.pages.contains_key(source) {
            let pages = self
                .store
                .annotations(source)
                .unwrap_or_default()
                .iter()
                .filter_map(|a| Some((a.get("id")?.as_str()?.to_string(), a.pointer("/range/start/page").or_else(|| a.pointer("/anchor/pages/0/page"))?.as_i64()? + 1)))
                .collect();
            self.pages.insert(source.to_string(), pages);
        }
        self.pages[source].get(highlight).copied()
    }
    /// `[@key, p. 3]`, or None when the source has no key.
    fn cite(&mut self, id: &str, page: Option<String>) -> Option<String> {
        let (key, _) = self.source(id)?;
        if key.is_empty() {
            return None;
        }
        Some(match page {
            Some(p) => format!("[@{key}, p. {p}]"),
            None => format!("[@{key}]"),
        })
    }
}

fn decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn fence_attr(info: &str, name: &str) -> Option<String> {
    let at = info.find(&format!("{name}=\""))? + name.len() + 2;
    let end = info[at..].find('"')?;
    Some(info[at..at + end].to_string())
}

/// A relation map's legend as one line of text: what each mark is (as the map draws it)
/// and how much it shows. `kinds` is the map's comma list (empty: everything).
fn map_legend(kinds: Option<&str>, cap: Option<&str>, min: Option<&str>) -> String {
    const MARKS: &[(&str, &str)] = &[
        ("topic", "topics (filled diamonds)"),
        ("field", "fields (outlined diamonds)"),
        ("person", "people (circles)"),
        ("venue", "journals (rounded squares)"),
        ("tag", "tags (pills)"),
        ("collection", "collections (outlined squares)"),
        ("source", "related sources (cards)"),
    ];
    let wanted: Vec<&str> = kinds.unwrap_or("").split(',').map(str::trim).filter(|k| !k.is_empty()).collect();
    let shown: Vec<&str> = MARKS.iter().filter(|(k, _)| wanted.is_empty() || wanted.contains(k)).map(|(_, label)| *label).collect();
    let mut line = format!("*Legend:* the centre is the item; around it {}", shown.join(", "));
    if let Some(cap) = cap.filter(|c| c.parse::<u32>().is_ok_and(|n| n > 0)) {
        line.push_str(&format!("; up to {cap} of each"));
    }
    if let Some(min) = min.filter(|m| m.parse::<u32>().is_ok_and(|n| n > 1)) {
        line.push_str(&format!("; only those shared by at least {min} sources"));
    }
    line.push_str(". Larger marks are shared by more sources.\n");
    line
}

/// A note's Markdown for other apps: item links resolved, quotes and citations as Pandoc
/// citations when `pandoc` is on, links to other notes as `[[wiki links]]`.
fn note_markdown(body: &str, citer: &mut Citer, pandoc: bool) -> String {
    let mut out = String::with_capacity(body.len());
    let mut lines = body.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        if let Some(info) = trimmed.strip_prefix("```") {
            let kind = info.split_whitespace().next().unwrap_or("");
            if matches!(kind, "quote" | "source" | "bibliography") {
                let mut inner = Vec::new();
                for next in lines.by_ref() {
                    if next.trim_start().starts_with("```") {
                        break;
                    }
                    inner.push(next.to_string());
                }
                match kind {
                    "quote" => {
                        let cite = fence_attr(info, "source").and_then(|s| {
                            let page = fence_attr(info, "page");
                            if pandoc { citer.cite(&s, page) } else { Some(format!("([source]({}))", source_link(&s, page.map(|p| format!("page:{p}")).as_deref()))) }
                        });
                        let text = inner.join("\n");
                        for (i, l) in text.lines().enumerate() {
                            out.push_str("> ");
                            out.push_str(&links(l, citer, pandoc));
                            if i + 1 == text.lines().count() {
                                if let Some(c) = &cite {
                                    out.push(' ');
                                    out.push_str(c);
                                }
                            }
                            out.push('\n');
                        }
                    }
                    "source" => {
                        let id = fence_attr(info, "id").unwrap_or_default();
                        let cited = if pandoc { citer.cite(&id, None) } else { None };
                        out.push_str(&cited.unwrap_or_else(|| inner.join(" ")));
                        out.push('\n');
                    }
                    _ => {
                        if pandoc {
                            out.push_str("::: {#refs}\n:::\n");
                        }
                    }
                }
                continue;
            }
            // A relation map reads as what it is centred on and a legend line (other apps
            // cannot draw it).
            if kind == "embed" && fence_attr(info, "view").as_deref() == Some("map") {
                let mut label = Vec::new();
                for next in lines.by_ref() {
                    if next.trim_start().starts_with("```") {
                        break;
                    }
                    label.push(next.trim().to_string());
                }
                let label = label.join(" ");
                let href = fence_attr(info, "href").unwrap_or_default();
                let centre = if href.is_empty() { label.clone() } else { links(&format!("[{}]({href})", if label.is_empty() { "the item" } else { &label }), citer, pandoc) };
                out.push_str(&format!("**Relation map** of {centre}\n\n"));
                out.push_str(&map_legend(fence_attr(info, "kinds").as_deref(), fence_attr(info, "cap").as_deref(), fence_attr(info, "min").as_deref()));
                out.push('\n');
                continue;
            }
            // Other code blocks pass through untouched.
            out.push_str(line);
            out.push('\n');
            for next in lines.by_ref() {
                out.push_str(next);
                out.push('\n');
                if next.trim_start().starts_with("```") {
                    break;
                }
            }
            continue;
        }
        out.push_str(&links(line, citer, pandoc));
        out.push('\n');
    }
    out
}

/// `[label](key://kind/id#anchor)` in a line, rewritten.
fn links(line: &str, citer: &mut Citer, pandoc: bool) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(at) = rest.find("](key://") {
        let Some(open) = rest[..at].rfind('[') else {
            out.push_str(&rest[..at + 2]);
            rest = &rest[at + 2..];
            continue;
        };
        let Some(close) = rest[at + 2..].find(')') else { break };
        let label = &rest[open + 1..at];
        let href = &rest[at + 2..at + 2 + close];
        let target = href.trim_start_matches("key://");
        let (path, anchor) = target.split_once('#').map(|(p, a)| (p, Some(decode(a)))).unwrap_or((target, None));
        let (kind, id) = path.split_once('/').unwrap_or((path, ""));
        let id = decode(id.split('?').next().unwrap_or(""));
        let page = anchor.as_deref().and_then(|a| a.strip_prefix("page:")).map(String::from);
        let replaced = match kind {
            "source" if pandoc => {
                let page = page.or_else(|| anchor.as_deref().and_then(|a| a.strip_prefix("highlight:")).and_then(|h| citer.highlight_page(&id, h)).map(|p| p.to_string()));
                citer.cite(&id, page)
            }
            "note" => citer.note_titles.get(&id).map(|t| format!("[[{t}|{label}]]")),
            _ => None,
        };
        out.push_str(&rest[..open]);
        match replaced {
            Some(text) => out.push_str(&text),
            None if kind == "source" => out.push_str(&rest[open..at + 3 + close]),
            None => out.push_str(label),
        }
        rest = &rest[at + 3 + close..];
    }
    out.push_str(rest);
    out
}

fn sync_notes(store: &Store, config: &Config, folder: &Path, request: &Request, state: &mut HashMap<String, FileState>, summary: &mut Summary) -> Result<(), String> {
    let stamps = store.note_stamps()?;
    let mut notes: Vec<Note> = store.standalone_notes()?;
    // Notes on sources too.
    for id in stamps.keys() {
        if !notes.iter().any(|n| &n.id == id) {
            if let Some(note) = store.note(id)? {
                notes.push(note);
            }
        }
    }
    let rules = NamingRules { max_length: 150, ..Default::default() };
    // Wiki-link targets: the file each note goes to (its current name, or a new one).
    let mut titles = HashMap::new();
    for note in &notes {
        let title = if note.title.trim().is_empty() { "Untitled note".to_string() } else { note.title.clone() };
        let name = state.get(&note.id).and_then(|s| s.path.file_stem().map(|n| n.to_string_lossy().to_string())).unwrap_or_else(|| filenames::clean(&title, &rules));
        titles.insert(note.id.clone(), name);
    }
    let mut citer = Citer { store, sources: HashMap::new(), pages: HashMap::new(), note_titles: titles };
    let mut vault = Vault::new(folder);
    for note in notes {
        let stamp = stamps.get(&note.id).cloned().unwrap_or_default();
        if request.changed_only && state.get(&note.id).is_some_and(|s| s.stamp == stamp && s.conflict.is_none()) {
            continue;
        }
        let title = if note.title.trim().is_empty() { "Untitled note".to_string() } else { note.title.clone() };
        let body = note_markdown(&note.body, &mut citer, config.pandoc);
        let mut front = vec![("title".to_string(), Json::from(title.clone())), ("created".into(), Json::from(iso_date(note.created_at))), ("updated".into(), Json::from(iso_date(note.updated_at)))];
        if let Some(source) = note.source_id.as_deref().and_then(|s| citer.source(s)) {
            if !source.0.is_empty() {
                front.push(("source".into(), Json::from(format!("[@{}]", source.0))));
            }
        }
        let name = filenames::clean(&title, &rules);
        let doc = Doc { id: &note.id, title: &title, kind: "note", folder, default_path: PathBuf::from(format!("{}.md", if name.is_empty() { "Untitled note" } else { &name })), front, stamp };
        let render = |_: &HashMap<String, String>| body.clone();
        record(summary, &note.id, &title, sync_doc(&doc, &render, &HashSet::new(), config, state, &mut vault, request.force));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use key_store::{Creator, SourceInput};

    fn setup() -> (tempfile::TempDir, Store, String, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("db")).unwrap();
        let mut fields = Map::new();
        fields.insert("title".into(), Json::from("Growth and inequality"));
        fields.insert("date".into(), Json::from("2021"));
        fields.insert("citationKey".into(), Json::from("smith2021"));
        let id = store
            .insert_source(SourceInput { kind: "pdf".into(), creators: vec![Creator { family: Some("Smith".into()), given: Some("Ann".into()), role: "author".into(), ..Default::default() }], tags: vec!["econ growth".into()], fields, ..Default::default() })
            .unwrap()
            .id;
        store.apply_annotations(&id, &[json!({ "id": "h1", "text": "First quote", "color": "green", "range": { "start": { "page": 2, "index": 10 } } })], &[]).unwrap();
        let vault = dir.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        save_config(&store, &Config { folder: Some(vault.clone()), ..Default::default() }).unwrap();
        (dir, store, id, vault)
    }

    fn cite(_: &Source) -> Option<String> {
        Some("Smith, A. (2021). *Growth and inequality*.".into())
    }

    fn run(store: &Store) -> Summary {
        sync(store, &Request { notes: true, ..Default::default() }, &cite).unwrap()
    }

    #[test]
    fn resync_keeps_user_text_and_adds_highlights() {
        let (_dir, store, id, vault) = setup();
        let summary = run(&store);
        assert_eq!(summary.written, 1, "{summary:?}");
        let path = vault.join("smith2021.md");
        let first = std::fs::read_to_string(&path).unwrap();
        assert!(first.starts_with("---\nkey-id: "), "{first}");
        assert!(first.contains("tags:\n  - econ-growth\n"));
        assert!(first.contains("> First quote ([p. 3](key://source/"));
        assert!(first.contains("Smith, A. (2021). *Growth and inequality*."));
        // The user writes above, below, and under the highlight.
        let edited = first.replace("<!-- key:begin", "My summary.\n\n<!-- key:begin").replace("<!-- key:notes -->\n", "<!-- key:notes -->\nWhy this matters.\n") + "\n## My thoughts\nKeep me.\n";
        std::fs::write(&path, &edited).unwrap();
        store.apply_annotations(&id, &[json!({ "id": "h2", "text": "Second quote", "comment": "Key point", "range": { "start": { "page": 0, "index": 1 } } })], &[]).unwrap();
        let summary = run(&store);
        assert_eq!(summary.written, 1, "{summary:?}");
        let second = std::fs::read_to_string(&path).unwrap();
        assert!(second.contains("My summary.\n\n<!-- key:begin"));
        assert!(second.ends_with("## My thoughts\nKeep me.\n"));
        assert!(second.contains("Why this matters."));
        assert!(second.contains("**Key point**\n\n> Second quote"));
        // Page order: the page-1 highlight comes first.
        assert!(second.find("Second quote").unwrap() < second.find("First quote").unwrap());
        // Nothing changed: nothing written.
        assert_eq!(run(&store).written, 0);
        // A highlight deleted in Key stays, marked, with the user's notes.
        store.apply_annotations(&id, &[], &["h1".into()]).unwrap();
        run(&store);
        let third = std::fs::read_to_string(&path).unwrap();
        assert!(third.contains("<!-- key:ann id=h1 deleted -->\n*Removed in Key*"), "{third}");
        assert!(third.contains("Why this matters."));
        assert!(third.ends_with("Keep me.\n"));
    }

    #[test]
    fn follows_renamed_and_moved_files() {
        let (_dir, store, id, vault) = setup();
        run(&store);
        let moved = vault.join("Reading").join("Growth (Smith).md");
        std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
        std::fs::rename(vault.join("smith2021.md"), &moved).unwrap();
        store.apply_annotations(&id, &[json!({ "id": "h3", "text": "Third" })], &[]).unwrap();
        let summary = run(&store);
        assert_eq!(summary.files, vec![moved.clone()]);
        assert!(!vault.join("smith2021.md").exists());
        assert!(std::fs::read_to_string(&moved).unwrap().contains("Third"));
    }

    #[test]
    fn a_file_the_user_deleted_stays_deleted_until_restored() {
        let (_dir, store, id, vault) = setup();
        run(&store);
        std::fs::remove_file(vault.join("smith2021.md")).unwrap();
        store.apply_annotations(&id, &[json!({ "id": "h3", "text": "Third" })], &[]).unwrap();
        let summary = sync(&store, &Request { notes: true, force: true, ..Default::default() }, &cite).unwrap();
        assert_eq!((summary.written, summary.removed), (0, 1), "{summary:?}");
        assert!(!vault.join("smith2021.md").exists(), "a deleted file is not written again");
        assert_eq!(removed(&store).unwrap().iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), [id.as_str()]);
        assert_eq!(restore_removed(&store, None).unwrap(), 1);
        assert!(removed(&store).unwrap().is_empty());
        assert_eq!(run(&store).written, 1);
        assert!(std::fs::read_to_string(vault.join("smith2021.md")).unwrap().contains("Third"));
    }

    #[test]
    fn hand_edits_in_keys_section_get_a_conflict_copy() {
        let (_dir, store, id, vault) = setup();
        run(&store);
        let path = vault.join("smith2021.md");
        let edited = std::fs::read_to_string(&path).unwrap().replace("First quote", "First quote, reworded");
        std::fs::write(&path, &edited).unwrap();
        store.apply_annotations(&id, &[json!({ "id": "h4", "text": "Fourth" })], &[]).unwrap();
        let summary = run(&store);
        assert_eq!(summary.conflicts.len(), 1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), edited);
        let copy = vault.join("smith2021.conflict.md");
        assert!(std::fs::read_to_string(&copy).unwrap().contains("Fourth"));
        assert_eq!(conflicts(&store).unwrap().len(), 1);
        // Choosing Key's version: the section is replaced, the copy goes.
        let forced = sync(&store, &Request { force: true, ids: Some(vec![id]), ..Default::default() }, &cite).unwrap();
        assert_eq!(forced.written, 1);
        assert!(!copy.exists());
        assert!(std::fs::read_to_string(&path).unwrap().contains("Fourth"));
    }

    #[test]
    fn a_taken_name_gets_a_number() {
        let (_dir, store, _id, vault) = setup();
        std::fs::write(vault.join("smith2021.md"), "Someone else's note").unwrap();
        run(&store);
        assert_eq!(std::fs::read_to_string(vault.join("smith2021.md")).unwrap(), "Someone else's note");
        assert!(vault.join("smith2021 2.md").exists());
    }

    #[test]
    fn notes_cite_with_pandoc_keys() {
        let (_dir, store, id, _vault) = setup();
        let notes = _dir.path().join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        let mut config = config(&store).unwrap();
        config.export_notes = true;
        config.notes_folder = Some(notes.clone());
        save_config(&store, &config).unwrap();
        let other = store.save_note(None, None, "Other", "x", None).unwrap();
        let body = format!(
            "As [Smith](key://source/{id}#page:4) and [the quote](key://source/{id}#highlight%3Ah1) say, see [other](key://note/{}).\n\n```quote source=\"{id}\" page=\"7\"\nQuoted.\n```\n\n```embed href=\"key://source/{id}\" view=\"map\" kinds=\"topic,person\" cap=\"8\" min=\"2\"\nGrowth\n```\n",
            other.id
        );
        store.save_note(None, None, "Reading notes", &body, None).unwrap();
        run(&store);
        let text = std::fs::read_to_string(notes.join("Reading notes.md")).unwrap();
        assert!(text.contains("As [@smith2021, p. 4] and [@smith2021, p. 3] say, see [[Other|other]]."), "{text}");
        assert!(text.contains("> Quoted. [@smith2021, p. 7]"));
        // A relation map becomes its centre and a legend line.
        assert!(text.contains("**Relation map** of "), "{text}");
        assert!(text.contains("*Legend:* the centre is the item; around it topics (filled diamonds), people (circles); up to 8 of each; only those shared by at least 2 sources."), "{text}");
        assert!(!text.contains("```embed"), "{text}");
    }

    #[test]
    fn templates_and_helpers() {
        assert_eq!(iso_date(0), "1970-01-01");
        assert_eq!(iso_date(1_700_000_000_000), "2023-11-14");
        assert_eq!(html_to_markdown("<div class=\"csl-entry\">Smith, A. (2021). <i>Growth</i> &amp; more.</div>"), "Smith, A. (2021). *Growth* & more.");
        let (_dir, store, id, _vault) = setup();
        let source = store.source(&id).unwrap().unwrap();
        let text = render_source(&store, &source, &Config { group_by: Grouping::Color, ..Default::default() }, &cite).unwrap();
        assert!(text.contains("### Green\n\n> First quote"), "{text}");
        assert!(!text.contains("key:ann"));
        let preview = preview(&store, &Config::default(), None, &cite).unwrap();
        assert_eq!(preview["fileName"], "smith2021.md");
    }
}
