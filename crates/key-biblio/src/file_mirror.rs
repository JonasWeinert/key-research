// Readable file names on disk: renaming linked files in place (on request, journaled so it
// can be undone), readable copies of managed files for dragging out, and the mirror folder
// (human-named PDFs organised by collection, as hard links where the volume allows, else
// copies) that other apps (Finder, iPad sync through a cloud folder, DEVONthink) can read.
//
// Managed files (the workspace's `files/<hash>.pdf`) are never renamed: storage stays named
// by content. Files in linked folders are renamed only in folders the user opts in.
use crate::filenames::{self, NamingRules};
use crate::template::Template;
use key_store::{Collection, Source, Store};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const MIRROR: &str = "files.mirror";
const MIRROR_STATE: &str = "files.mirror.state";
/// Collection folder for sources in no collection.
pub const UNFILED: &str = "Unfiled";

/// Whether a path is in the workspace's own content-addressed storage.
pub fn is_managed(path: &Path, root: &Path) -> bool {
    path.starts_with(root.join("files"))
}

fn sources(store: &Store, ids: Option<&[String]>) -> Result<Vec<Source>, String> {
    let scope = crate::export::Scope { ids: ids.map(<[String]>::to_vec), collection_id: None };
    Ok(crate::export::sources(store, &scope)?.into_iter().filter(|s| s.trashed_at.is_none() && s.file_path().is_some()).collect())
}

// ── Renaming linked files ────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rename {
    pub id: String,
    pub title: String,
    pub from: PathBuf,
    pub to: PathBuf,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePlan {
    pub renames: Vec<Rename>,
    /// Already named so.
    pub unchanged: usize,
    /// Managed files (their shown name follows the rules; storage keeps its name).
    pub managed: usize,
    /// In linked folders not opted in.
    pub in_folders: usize,
    /// The file is not there.
    pub missing: usize,
}

/// What renaming the files of `ids` (None: every source) would do.
pub fn plan_renames(store: &Store, ids: Option<&[String]>, rules: &NamingRules, root: &Path, folders: &[String]) -> Result<RenamePlan, String> {
    let template = Template::parse(&rules.template)?;
    let linked: Vec<(String, PathBuf)> = store.linked_folders()?.into_iter().map(|f| (f.id, PathBuf::from(f.path))).collect();
    let mut plan = RenamePlan::default();
    // Names taken per folder (lowercase), including the ones this plan gives out.
    let mut taken: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    let mut list = sources(store, ids)?;
    list.sort_by(|a, b| a.added_at.cmp(&b.added_at).then(a.id.cmp(&b.id)));
    for source in list {
        let Some(from) = source.file_path() else { continue };
        if is_managed(&from, root) {
            plan.managed += 1;
            continue;
        }
        let real = std::fs::canonicalize(&from).unwrap_or_else(|_| from.clone());
        if linked.iter().any(|(id, path)| (real.starts_with(path) || from.starts_with(path)) && !folders.contains(id)) {
            plan.in_folders += 1;
            continue;
        }
        if !from.is_file() {
            plan.missing += 1;
            continue;
        }
        let dir = from.parent().map(Path::to_path_buf).unwrap_or_default();
        let ext = from.extension().map(|e| e.to_string_lossy().to_string());
        let wanted = filenames::file_name(&source, rules, &template, ext.as_deref());
        let current = from.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if current == wanted {
            plan.unchanged += 1;
            continue;
        }
        let names = taken.entry(dir.clone()).or_insert_with(|| {
            std::fs::read_dir(&dir).map(|entries| entries.flatten().map(|e| e.file_name().to_string_lossy().to_lowercase()).collect()).unwrap_or_default()
        });
        // The file's own current name is free for it (a change of case only).
        let own = current.to_lowercase();
        let name = filenames::unique(&wanted, rules, &|n| {
            let n = n.to_lowercase();
            n != own && names.contains(&n)
        });
        if name == current {
            plan.unchanged += 1;
            continue;
        }
        names.insert(name.to_lowercase());
        plan.renames.push(Rename { id: source.id.clone(), title: source.title().to_string(), from: from.clone(), to: dir.join(&name) });
    }
    Ok(plan)
}

/// Renames the planned files (journaled: Undo puts the names back).
pub fn apply_renames(store: &Store, renames: &[Rename]) -> Result<key_store::Operation, String> {
    if renames.is_empty() {
        return Err("Nothing to rename".into());
    }
    let list: Vec<(String, String, String)> = renames.iter().map(|r| (r.id.clone(), r.from.to_string_lossy().to_string(), r.to.to_string_lossy().to_string())).collect();
    let label = if list.len() == 1 { "Rename 1 file".to_string() } else { format!("Rename {} files", list.len()) };
    store.rename_source_files(&list, &label)
}

// ── Names for managed files ──────────────────────────────────────────────────

/// The readable name of each source's file, under the rules.
pub fn readable_names(store: &Store, ids: &[String], rules: &NamingRules) -> Result<HashMap<String, String>, String> {
    let list = sources(store, Some(ids))?;
    let refs: Vec<&Source> = list.iter().collect();
    let names = filenames::distinct_names(&refs, rules, None)?;
    Ok(list.iter().map(|s| s.id.clone()).zip(names).collect())
}

/// Hard links make a second name for the same bytes: free, and instant.
fn link_or_copy(from: &Path, to: &Path) -> Result<bool, String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    match std::fs::hard_link(from, to) {
        Ok(()) => Ok(true),
        Err(_) => std::fs::copy(from, to).map(|_| false).map_err(|e| format!("{}: {e}", to.display())),
    }
}

/// Paths to drag out of the app: linked files as they are; managed files under a readable
/// name (a hard link in the workspace's `readable` folder).
pub fn readable_paths(store: &Store, ids: &[String], rules: &NamingRules, root: &Path) -> Result<Vec<PathBuf>, String> {
    let names = readable_names(store, ids, rules)?;
    let mut out = Vec::new();
    for source in sources(store, Some(ids))? {
        let Some(path) = source.file_path().filter(|p| p.is_file()) else { continue };
        if !is_managed(&path, root) {
            out.push(path);
            continue;
        }
        let name = names.get(&source.id).cloned().unwrap_or_else(|| "Untitled.pdf".into());
        let dir = root.join("readable").join(&source.id);
        // One name per source: an older one goes.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy() != name {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let target = dir.join(&name);
        if !same_file(&path, &target) {
            let _ = std::fs::remove_file(&target);
            link_or_copy(&path, &target)?;
        }
        out.push(target);
    }
    Ok(out)
}

#[cfg(unix)]
fn inode(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}
#[cfg(not(unix))]
fn inode(_: &Path) -> Option<(u64, u64)> {
    None
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (inode(a), inode(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

// ── Mirror folder ────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MirrorConfig {
    pub enabled: bool,
    pub folder: Option<PathBuf>,
    /// Sub-folders by collection (else one flat folder).
    pub by_collection: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Entry {
    path: PathBuf,
    source: String,
    size: u64,
    /// Device and inode when written: a file the user replaced is left alone.
    inode: Option<(u64, u64)>,
    linked: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MirrorSummary {
    pub at: i64,
    pub files: usize,
    pub linked: usize,
    pub copied: usize,
    pub added: usize,
    pub removed: usize,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct MirrorState {
    entries: Vec<Entry>,
    last: Option<MirrorSummary>,
}

pub fn mirror_config(store: &Store) -> Result<MirrorConfig, String> {
    Ok(store.meta(MIRROR)?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(MirrorConfig { by_collection: true, ..Default::default() }))
}

pub fn save_mirror_config(store: &Store, config: &MirrorConfig) -> Result<(), String> {
    if config.enabled {
        let folder = config.folder.as_ref().ok_or("Choose a folder for the mirror")?;
        if !folder.is_absolute() {
            return Err("Choose a folder for the mirror".into());
        }
        if folder.starts_with(store.root()) {
            return Err("Choose a folder outside the workspace's data".into());
        }
    }
    store.set_meta(MIRROR, &serde_json::to_string(config).map_err(|e| e.to_string())?)
}

fn mirror_state(store: &Store) -> MirrorState {
    store.meta(MIRROR_STATE).ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn mirror_summary(store: &Store) -> Option<MirrorSummary> {
    mirror_state(store).last
}

/// "Parent/Child" folder names for each collection.
fn collection_paths(collections: &[Collection], rules: &NamingRules) -> HashMap<String, PathBuf> {
    let by_id: HashMap<&str, &Collection> = collections.iter().map(|c| (c.id.as_str(), c)).collect();
    collections
        .iter()
        .map(|c| {
            let mut parts = vec![filenames::clean(&c.name, rules)];
            let mut parent = c.parent_id.as_deref();
            let mut depth = 0;
            while let (Some(id), true) = (parent, depth < 16) {
                let Some(p) = by_id.get(id) else { break };
                parts.push(filenames::clean(&p.name, rules));
                parent = p.parent_id.as_deref();
                depth += 1;
            }
            parts.reverse();
            (c.id.clone(), parts.into_iter().map(|p| if p.is_empty() { "Untitled".to_string() } else { p }).collect())
        })
        .collect()
}

/// Brings the mirror folder in line with the library: adds, replaces and removes only the
/// files it made itself.
pub fn mirror_sync(store: &Store, rules: &NamingRules) -> Result<MirrorSummary, String> {
    let config = mirror_config(store)?;
    let folder = config.folder.clone().filter(|_| config.enabled).ok_or("The mirror folder is off")?;
    std::fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let template = Template::parse(&rules.template)?;
    let folder_rules = NamingRules { max_length: 80, ..rules.clone() };
    let paths = collection_paths(&store.collections()?, &folder_rules);
    let mut list = sources(store, None)?;
    list.sort_by(|a, b| a.added_at.cmp(&b.added_at).then(a.id.cmp(&b.id)));
    let mut state = mirror_state(store);
    let old: HashMap<PathBuf, Entry> = state.entries.drain(..).map(|e| (e.path.clone(), e)).collect();
    let mut summary = MirrorSummary { at: key_store::now_ms(), ..Default::default() };
    let mut taken: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    let mut entries = Vec::new();
    for source in &list {
        let Some(file) = source.file_path().filter(|p| p.is_file()) else { continue };
        let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase());
        let name = filenames::file_name(source, rules, &template, ext.as_deref());
        let dirs: Vec<PathBuf> = if !config.by_collection {
            vec![folder.clone()]
        } else if source.collections.is_empty() {
            vec![folder.join(UNFILED)]
        } else {
            source.collections.iter().filter_map(|c| paths.get(c)).map(|p| folder.join(p)).collect()
        };
        for dir in dirs {
            let names = taken.entry(dir.clone()).or_default();
            // A name already given in this run, or a file there that the mirror did not make.
            let name = filenames::unique(&name, rules, &|n| names.contains(&n.to_lowercase()) || (dir.join(n).exists() && !old.get(&dir.join(n)).is_some_and(|e| e.source == source.id)));
            names.insert(name.to_lowercase());
            let target = dir.join(&name);
            let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
            let current = old.get(&target).filter(|e| e.source == source.id && target.exists());
            let fresh = current.is_some_and(|e| if e.linked { same_file(&file, &target) } else { e.size == size && std::fs::metadata(&target).is_ok_and(|m| m.len() == size) });
            summary.files += 1;
            if fresh {
                let e = current.cloned().unwrap_or_default();
                if e.linked {
                    summary.linked += 1;
                } else {
                    summary.copied += 1;
                }
                entries.push(e);
                continue;
            }
            if current.is_some() {
                let _ = std::fs::remove_file(&target);
            }
            match link_or_copy(&file, &target) {
                Ok(linked) => {
                    summary.added += 1;
                    if linked {
                        summary.linked += 1;
                    } else {
                        summary.copied += 1;
                    }
                    entries.push(Entry { path: target.clone(), source: source.id.clone(), size, inode: inode(&target), linked });
                }
                Err(error) => summary.errors.push(error),
            }
        }
    }
    let kept: HashSet<PathBuf> = entries.iter().map(|e| e.path.clone()).collect();
    for (path, entry) in old {
        if kept.contains(&path) || !path.exists() {
            continue;
        }
        // Only a file the mirror made and nobody replaced.
        if entry.inode.is_some() && inode(&path) != entry.inode {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            summary.removed += 1;
            let mut dir = path.parent();
            while let Some(d) = dir.filter(|d| d.starts_with(&folder) && *d != folder) {
                if std::fs::remove_dir(d).is_err() {
                    break;
                }
                dir = d.parent();
            }
        }
    }
    state.entries = entries;
    state.last = Some(summary.clone());
    store.set_meta(MIRROR_STATE, &serde_json::to_string(&state).map_err(|e| e.to_string())?)?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use key_store::{Creator, SourceInput};
    use serde_json::{Map, Value as Json};

    fn add(store: &Store, title: &str, path: &Path, collections: Vec<String>) -> String {
        std::fs::write(path, title.as_bytes()).unwrap();
        let mut fields = Map::new();
        fields.insert("title".into(), Json::from(title));
        fields.insert("date".into(), Json::from("2019"));
        fields.insert("filePath".into(), Json::from(path.to_string_lossy().to_string()));
        let creators = vec![Creator { family: Some("Lee".into()), role: "author".into(), ..Default::default() }];
        store.insert_source(SourceInput { kind: "pdf".into(), creators, collections, fields, ..Default::default() }).unwrap().id
    }

    #[test]
    fn renames_linked_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws").join("db");
        let store = Store::open(&root).unwrap();
        std::fs::create_dir_all(root.join("files")).unwrap();
        let docs = dir.path().join("Docs");
        std::fs::create_dir_all(&docs).unwrap();
        let a = add(&store, "Alpha", &docs.join("scan1.pdf"), vec![]);
        add(&store, "Managed", &root.join("files").join("abc.pdf"), vec![]);
        let linked = dir.path().join("Linked");
        std::fs::create_dir_all(&linked).unwrap();
        let folder = store.link_folder(&linked).unwrap();
        add(&store, "In folder", &linked.join("x.pdf"), vec![]);
        // A file already holds the wanted name.
        std::fs::write(docs.join("Lee - 2019 - Alpha.pdf"), b"user's").unwrap();
        let rules = NamingRules::default();
        let plan = plan_renames(&store, None, &rules, &root, &[]).unwrap();
        assert_eq!((plan.renames.len(), plan.managed, plan.in_folders), (1, 1, 1));
        assert_eq!(plan.renames[0].to, docs.join("Lee - 2019 - Alpha 2.pdf"));
        apply_renames(&store, &plan.renames).unwrap();
        assert!(docs.join("Lee - 2019 - Alpha 2.pdf").exists() && !docs.join("scan1.pdf").exists());
        store.undo().unwrap();
        assert!(docs.join("scan1.pdf").exists());
        assert_eq!(store.source(&a).unwrap().unwrap().field("filePath"), Some(docs.join("scan1.pdf").to_string_lossy().as_ref()));
        // Opting the linked folder in.
        let plan = plan_renames(&store, None, &rules, &root, &[folder.id]).unwrap();
        assert_eq!(plan.renames.len(), 2);
    }

    #[test]
    fn mirror_by_collection_and_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("ws")).unwrap();
        let reading = store.create_collection("Reading", None, None).unwrap();
        let sub = store.create_collection("Theory: core", Some(&reading.id), None).unwrap();
        let files = dir.path().join("src");
        std::fs::create_dir_all(&files).unwrap();
        let a = add(&store, "Alpha", &files.join("a.pdf"), vec![sub.id.clone()]);
        add(&store, "Beta", &files.join("b.pdf"), vec![]);
        let mirror = dir.path().join("Mirror");
        save_mirror_config(&store, &MirrorConfig { enabled: true, folder: Some(mirror.clone()), by_collection: true }).unwrap();
        let rules = NamingRules::default();
        let summary = mirror_sync(&store, &rules).unwrap();
        assert_eq!((summary.files, summary.added), (2, 2), "{summary:?}");
        let alpha = mirror.join("Reading").join("Theory - core").join("Lee - 2019 - Alpha.pdf");
        assert!(alpha.exists());
        assert!(mirror.join(UNFILED).join("Lee - 2019 - Beta.pdf").exists());
        assert_eq!(summary.linked, 2);
        // A file the user put there is never touched.
        std::fs::write(mirror.join(UNFILED).join("mine.txt"), b"x").unwrap();
        // Moving Alpha out of its collection moves its mirror file.
        store.set_membership(&sub.id, std::slice::from_ref(&a), false).unwrap();
        let summary = mirror_sync(&store, &rules).unwrap();
        assert_eq!(summary.removed, 1);
        assert!(!alpha.exists() && !mirror.join("Reading").exists());
        assert!(mirror.join(UNFILED).join("Lee - 2019 - Alpha.pdf").exists());
        assert!(mirror.join(UNFILED).join("mine.txt").exists());
        assert_eq!(mirror_sync(&store, &rules).unwrap().added, 0);
    }

    #[test]
    fn readable_drag_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let store = Store::open(&root).unwrap();
        std::fs::create_dir_all(root.join("files")).unwrap();
        let id = add(&store, "Gamma", &root.join("files").join("f00.pdf"), vec![]);
        let paths = readable_paths(&store, &[id], &NamingRules::default(), &root).unwrap();
        assert_eq!(paths[0].file_name().unwrap(), "Lee - 2019 - Gamma.pdf");
        assert_eq!(std::fs::read(&paths[0]).unwrap(), b"Gamma");
    }
}
