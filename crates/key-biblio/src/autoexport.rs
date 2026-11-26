// Auto-export targets: the library or a collection, written in a format to a file (a
// `.bib` in an Overleaf-synced or git folder) whenever it changes. A file is rewritten
// only when its text would change, atomically (a temporary file in the same folder,
// then a rename), and entries keep a stable order so diffs stay small.
use crate::export::{self, ExportOptions, Scope};
use crate::Format;
use key_store::Store;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

const META: &str = "biblio.autoExport";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    /// None: the whole library.
    #[serde(default)]
    pub collection_id: Option<String>,
    pub format: Format,
    pub path: PathBuf,
    #[serde(default)]
    pub options: ExportOptions,
    #[serde(default)]
    pub last_written: Option<i64>,
    #[serde(default)]
    pub last_checked: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub count: Option<usize>,
}

pub fn targets(store: &Store) -> Result<Vec<Target>, String> {
    Ok(store.meta(META)?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default())
}

fn save(store: &Store, targets: &[Target]) -> Result<(), String> {
    store.set_meta(META, &serde_json::to_string(targets).map_err(|e| e.to_string())?)
}

/// Adds or changes a target (matched by id; a new one gets an id) and writes it once.
pub fn upsert(store: &Store, mut target: Target) -> Result<Target, String> {
    if !target.path.is_absolute() {
        return Err("Choose where the file goes".into());
    }
    if target.format == Format::EndnoteXml {
        return Err("EndNote XML can be imported but not exported".into());
    }
    let mut all = targets(store)?;
    if target.id.is_empty() {
        target.id = key_store::new_id();
    }
    if all.iter().any(|t| t.path == target.path && t.id != target.id) {
        return Err("Another auto-export already writes that file".into());
    }
    match all.iter_mut().find(|t| t.id == target.id) {
        Some(existing) => {
            let (written, checked) = (existing.last_written, existing.last_checked);
            *existing = Target { last_written: written, last_checked: checked, ..target.clone() };
        }
        None => all.push(target.clone()),
    }
    save(store, &all)?;
    let written = run(store, Some(&target.id))?;
    Ok(written.into_iter().find(|t| t.id == target.id).unwrap_or(target))
}

pub fn remove(store: &Store, id: &str) -> Result<(), String> {
    let mut all = targets(store)?;
    all.retain(|t| t.id != id);
    save(store, &all)
}

/// Writes `text` to `path` through a temporary file in the same folder.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let folder = path.parent().ok_or("The file has no folder")?;
    if !folder.is_dir() {
        return Err(format!("The folder {} does not exist", folder.display()));
    }
    let name = path.file_name().ok_or("No file name")?.to_string_lossy().to_string();
    let temporary = folder.join(format!(".{name}.key-{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|e| e.to_string())
}

/// Exports every target (or one) whose file would change. Returns the targets with their status.
pub fn run(store: &Store, only: Option<&str>) -> Result<Vec<Target>, String> {
    let mut all = targets(store)?;
    if all.is_empty() {
        return Ok(all);
    }
    let now = key_store::now_ms();
    let collections = store.collections()?;
    for target in all.iter_mut().filter(|t| only.is_none_or(|id| id == t.id)) {
        target.last_checked = Some(now);
        if let Some(collection) = &target.collection_id {
            if !collections.iter().any(|c| &c.id == collection) {
                target.last_error = Some("The collection was deleted".into());
                continue;
            }
        }
        let scope = Scope { ids: None, collection_id: target.collection_id.clone() };
        let result = export::export(store, &scope, target.format, &target.options).and_then(|(text, count)| {
            target.count = Some(count);
            let current = std::fs::read_to_string(&target.path).ok();
            if current.as_deref() != Some(text.as_str()) {
                write_atomic(&target.path, &text)?;
                target.last_written = Some(now);
            }
            Ok(())
        });
        target.last_error = result.err();
    }
    // Keep changes made to the list meanwhile (only the status fields are ours).
    let mut latest = targets(store)?;
    for target in &mut latest {
        if let Some(ran) = all.iter().find(|t| t.id == target.id) {
            target.last_written = ran.last_written;
            target.last_checked = ran.last_checked;
            target.last_error = ran.last_error.clone();
            target.count = ran.count;
        }
    }
    save(store, &latest)?;
    Ok(latest)
}
