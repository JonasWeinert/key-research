// Bibliographic import and export (key-biblio), citation keys and auto-export targets.
// A background thread watches the library: when it has changed and then stayed still for
// a moment, sources without a citation key get one and auto-export files are rewritten.
use super::{json_output, library_store::Library};
use crate::ipc::{Output, arg};
use key_biblio::export::{ExportOptions, Scope};
use key_biblio::import::{ImportOptions, Progress};
use key_biblio::{Format, autoexport, export, import};
use key_store::Store;
use serde_json::{Value as Json, json};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Larger files are refused (a 10k-entry BibTeX file is about 10 MB).
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const POLL: Duration = Duration::from_millis(1500);
/// How long the library stays unchanged before files are written.
const SETTLE: Duration = Duration::from_millis(1200);

fn progress_slot() -> &'static Mutex<Option<Progress>> {
    static SLOT: OnceLock<Mutex<Option<Progress>>> = OnceLock::new();
    SLOT.get_or_init(Default::default)
}

fn set_progress(progress: Option<Progress>) {
    if let Ok(mut slot) = progress_slot().lock() {
        *slot = progress;
    }
}

/// The text to import: a file (`path`) or pasted `text`, with the name that hints its format.
fn input(args: &Json) -> Result<(String, Option<String>, Option<PathBuf>), String> {
    if let Some(path) = arg::<Option<PathBuf>>(args, "path")? {
        let size = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?.len();
        if size > MAX_FILE_BYTES {
            return Err("The file is larger than 256 MB".into());
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            // Older files are often Latin-1.
            Err(error) => error.into_bytes().iter().map(|b| *b as char).collect(),
        };
        let name = path.file_name().map(|n| n.to_string_lossy().to_string());
        return Ok((text, name, Some(path)));
    }
    let text: String = arg::<Option<String>>(args, "text")?.ok_or("Nothing to import")?;
    Ok((text, arg(args, "fileName")?, None))
}

pub fn dispatch(library: &Library, command: &str, args: &Json, root: &Path) -> Option<Result<Output, String>> {
    let store = &library.store;
    let result = match command {
        // What a file or pasted text holds, before importing it.
        "store_biblio_preview" => (|| {
            let (text, name, path) = input(args)?;
            let format: Option<Format> = arg(args, "format")?;
            let parsed = import::read(&text, name.as_deref(), format, &|_, _| {})?;
            let options = ImportOptions { base_dir: path.as_ref().and_then(|p| p.parent().map(Path::to_path_buf)), ..Default::default() };
            json_output(import::preview(store, &parsed, &options)?)
        })(),
        "store_biblio_import" => (|| {
            let (text, name, path) = input(args)?;
            let format: Option<Format> = arg(args, "format")?;
            let mut options: ImportOptions = arg::<Option<ImportOptions>>(args, "options")?.unwrap_or_default();
            if options.base_dir.is_none() {
                options.base_dir = path.as_ref().and_then(|p| p.parent().map(Path::to_path_buf));
            }
            set_progress(Some(Progress { stage: "Reading".into(), done: 0, total: 0 }));
            let result = (|| {
                let parsed = import::read(&text, name.as_deref(), format, &|done, total| {
                    set_progress(Some(Progress { stage: "Reading".into(), done, total }))
                })?;
                let label = name.clone().unwrap_or_else(|| "Pasted references".into());
                import::run(store, parsed, &options, &label, &|p| set_progress(Some(p)), &|id, file| library.attach_file(id, file, root).map(|_| ()))
            })();
            set_progress(None);
            library.indexer.wake();
            library.openalex.wake();
            json_output(result?)
        })(),
        "store_biblio_progress" => json_output(progress_slot().lock().map_err(|e| e.to_string()).map(|p| p.clone())),
        "store_biblio_history" => import::history(store).and_then(json_output),
        "store_biblio_undo" => arg::<String>(args, "id").and_then(|id| json_output(import::undo(store, &id)?)),
        // A selection (`ids`), a collection or the library, as text or into `path`.
        "store_biblio_export" => (|| {
            let format: Format = arg(args, "format")?;
            let scope: Scope = arg::<Option<Scope>>(args, "scope")?.unwrap_or_default();
            let options: ExportOptions = arg::<Option<ExportOptions>>(args, "options")?.unwrap_or_default();
            let (text, count) = export::export(store, &scope, format, &options)?;
            match arg::<Option<PathBuf>>(args, "path")? {
                Some(path) => {
                    autoexport::write_atomic(&path, &text)?;
                    json_output(json!({ "count": count, "path": path }))
                }
                None => json_output(json!({ "count": count, "text": text })),
            }
        })(),
        // Quick copy: bibtex, biblatex, ris, csl-json, pandoc, latex, keys.
        "store_biblio_copy" => (|| json_output(export::quick_copy(store, &arg::<Vec<String>>(args, "ids")?, &arg::<String>(args, "format")?)?))(),
        "store_citation_key" => arg::<String>(args, "id").and_then(|id| json_output(store.citation_key(&id)?)),
        "store_citation_key_set" => (|| {
            let id: String = arg(args, "id")?;
            let key: String = arg(args, "key")?;
            let pinned = arg::<Option<bool>>(args, "pinned")?.unwrap_or(true);
            json_output(store.set_citation_key(&id, &key, pinned)?)
        })(),
        "store_citation_key_pin" => (|| json_output(store.pin_citation_key(&arg::<String>(args, "id")?, arg(args, "pinned")?)?))(),
        "store_citation_key_regenerate" => arg::<Vec<String>>(args, "ids").and_then(|ids| json_output(store.regenerate_citation_keys(&ids)?)),
        "store_citation_key_pattern" => (|| {
            if let Some(pattern) = arg::<Option<String>>(args, "pattern")? {
                let regenerate = arg::<Option<bool>>(args, "regenerate")?.unwrap_or(false);
                let changed = store.set_citation_key_pattern(&pattern, regenerate)?;
                return json_output(json!({ "pattern": store.citation_key_pattern()?, "changed": changed, "default": key_store::citation_keys::DEFAULT_PATTERN }));
            }
            json_output(json!({ "pattern": store.citation_key_pattern()?, "default": key_store::citation_keys::DEFAULT_PATTERN }))
        })(),
        "store_citation_key_preview" => arg::<String>(args, "pattern").and_then(|p| json_output(store.preview_citation_key_pattern(&p)?)),
        "store_autoexport_targets" => autoexport::targets(store).and_then(json_output),
        "store_autoexport_save" => arg::<autoexport::Target>(args, "target").and_then(|t| json_output(autoexport::upsert(store, t)?)),
        "store_autoexport_remove" => arg::<String>(args, "id").and_then(|id| {
            autoexport::remove(store, &id)?;
            json_output(true)
        }),
        "store_autoexport_run" => arg::<Option<String>>(args, "id").and_then(|id| json_output(autoexport::run(store, id.as_deref())?)),
        _ => return None,
    };
    Some(result)
}

/// Watches the library: keys for new sources, then the auto-export files.
pub fn start_watcher(store: Store) {
    let _ = std::thread::Builder::new().name("key-biblio-watch".into()).spawn(move || {
        let mut seen = String::new();
        let mut changed_at: Option<Instant> = None;
        // Keys for sources added before keys existed.
        let _ = store.ensure_citation_keys();
        loop {
            std::thread::sleep(POLL);
            let Ok(now) = store.library_fingerprint() else { continue };
            if now != seen {
                seen = now;
                changed_at = Some(Instant::now());
                continue;
            }
            let Some(at) = changed_at else { continue };
            if at.elapsed() < SETTLE {
                continue;
            }
            changed_at = None;
            let _ = store.ensure_citation_keys();
            if autoexport::targets(&store).is_ok_and(|t| !t.is_empty()) {
                let _ = autoexport::run(&store, None);
            }
            // What the run itself changed (keys) is not a new change.
            if let Ok(after) = store.library_fingerprint() {
                seen = after;
            }
        }
    });
}
