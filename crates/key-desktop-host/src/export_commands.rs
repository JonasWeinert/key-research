// Markdown export of highlights and notes (key-biblio md_export.rs), file naming rules,
// renaming linked files and the readable mirror folder (filenames.rs, file_mirror.rs).
// A background thread runs the automatic Markdown export a moment after highlights or
// details change, and keeps the mirror folder current.
use super::{json_output, library_store::Library};
use crate::ipc::{Output, arg};
use key_biblio::export::Scope;
use key_biblio::file_mirror::{self, MirrorConfig, Rename};
use key_biblio::filenames::{self, NamingRules};
use key_biblio::md_export::{self, Config, Mode, Request};
use key_biblio::template::Template;
use key_store::{ListQuery, Store};
use serde_json::{Value as Json, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(2000);
const SETTLE: Duration = Duration::from_millis(1500);

fn cite(store: &Store) -> impl Fn(&key_store::Source) -> Option<String> + '_ {
    move |source| super::cite_commands::reference_markdown(store, source)
}

fn status(store: &Store) -> Result<Json, String> {
    let config = md_export::config(store)?;
    Ok(json!({
        "mode": config.mode,
        "folder": config.folder,
        "last": md_export::last_summary(store)?,
        "conflicts": md_export::conflicts(store)?,
        // Files the user deleted from the folder, which exports leave out until restored.
        "removed": md_export::removed(store)?,
        "mirror": file_mirror::mirror_config(store)?,
        "mirrorLast": file_mirror::mirror_summary(store),
    }))
}

/// Sources with files to show naming examples for: the given ones, else recent ones.
fn examples(store: &Store, rules: &NamingRules, ids: Option<Vec<String>>) -> Result<Json, String> {
    let template = Template::parse(&rules.template)?;
    let sources: Vec<key_store::Source> = match ids {
        Some(ids) => ids.iter().filter_map(|id| store.source(id).ok().flatten()).collect(),
        None => store.list_sources(&ListQuery { limit: Some(60), sort: Some("added".into()), descending: true, ..Default::default() })?.items,
    };
    let list: Vec<Json> = sources
        .iter()
        .filter(|s| s.file_path().is_some())
        .take(6)
        .map(|s| {
            let from = s.file_path().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string())).unwrap_or_default();
            json!({ "id": s.id, "title": s.title(), "from": from, "name": filenames::file_name(s, rules, &template, None) })
        })
        .collect();
    Ok(Json::Array(list))
}

pub fn dispatch(library: &Library, command: &str, args: &Json, root: &Path) -> Option<Result<Output, String>> {
    let store = &library.store;
    let result = match command {
        // ── Markdown export ──
        "store_md_export_config" => (|| {
            if let Some(config) = arg::<Option<Config>>(args, "config")? {
                md_export::save_config(store, &config)?;
            }
            json_output(json!({
                "config": md_export::config(store)?,
                "defaults": { "template": md_export::DEFAULT_TEMPLATE, "pattern": md_export::DEFAULT_PATTERN, "fields": md_export::FRONT_MATTER_FIELDS },
            }))
        })(),
        // The file a (draft) configuration writes for a real source.
        "store_md_export_preview" => (|| {
            let config = arg::<Option<Config>>(args, "config")?.map_or_else(|| md_export::config(store), Ok)?;
            let id: Option<String> = arg(args, "sourceId")?;
            json_output(md_export::preview(store, &config, id.as_deref(), &cite(store))?)
        })(),
        // To the folder: { ids?, collectionId?, force?, notes?, changedOnly? } -> summary.
        "store_md_export_run" => (|| {
            let request: Request = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
            json_output(md_export::sync(store, &request, &cite(store))?)
        })(),
        // One-shot: the highlights of a selection or collection as text, or into `path`.
        "store_md_export_render" => (|| {
            let scope = Scope { ids: arg(args, "ids")?, collection_id: arg(args, "collectionId")? };
            let config = md_export::config(store)?;
            let (text, count) = md_export::render_text(store, &scope, &config, &cite(store))?;
            if count == 0 {
                return Err("No highlights to export".into());
            }
            match arg::<Option<PathBuf>>(args, "path")? {
                Some(path) => {
                    key_biblio::autoexport::write_atomic(&path, &text)?;
                    json_output(json!({ "count": count, "path": path }))
                }
                None => json_output(json!({ "count": count, "text": text })),
            }
        })(),
        "store_md_export_status" => status(store).and_then(json_output),
        "store_md_export_restore" => (|| json_output(md_export::restore_removed(store, arg::<Option<Vec<String>>>(args, "ids")?.as_deref())?))(),

        // ── File names ──
        "store_file_naming" => (|| {
            if let Some(rules) = arg::<Option<NamingRules>>(args, "rules")? {
                filenames::save_rules(store, &rules)?;
            }
            let rules = filenames::rules(store)?;
            json_output(json!({ "rules": rules, "default": NamingRules::default() }))
        })(),
        "store_file_naming_preview" => (|| {
            let rules = arg::<Option<NamingRules>>(args, "rules")?.map_or_else(|| filenames::rules(store), Ok)?;
            json_output(examples(store, &rules, arg(args, "ids")?)?)
        })(),
        // Renaming linked files: { ids? (None: all), rules?, folders? (linked folders opted in) }.
        "store_file_rename_plan" => (|| {
            let rules = arg::<Option<NamingRules>>(args, "rules")?.map_or_else(|| filenames::rules(store), Ok)?;
            let ids: Option<Vec<String>> = arg(args, "ids")?;
            let folders: Vec<String> = arg::<Option<Vec<String>>>(args, "folders")?.unwrap_or_default();
            json_output(file_mirror::plan_renames(store, ids.as_deref(), &rules, root, &folders)?)
        })(),
        "store_file_rename_apply" => (|| {
            let renames: Vec<Rename> = arg(args, "renames")?;
            let op = file_mirror::apply_renames(store, &renames)?;
            library.indexer.wake();
            json_output(op)
        })(),
        // Dragging out: readable names for managed files.
        "store_file_readable_paths" => (|| {
            let ids: Vec<String> = arg(args, "ids")?;
            json_output(file_mirror::readable_paths(store, &ids, &filenames::rules(store)?, root)?)
        })(),
        "store_file_readable_names" => (|| json_output(file_mirror::readable_names(store, &arg::<Vec<String>>(args, "ids")?, &filenames::rules(store)?)?))(),
        "store_file_mirror" => (|| {
            if let Some(config) = arg::<Option<MirrorConfig>>(args, "config")? {
                file_mirror::save_mirror_config(store, &config)?;
                if config.enabled {
                    file_mirror::mirror_sync(store, &filenames::rules(store)?)?;
                }
            }
            json_output(json!({ "config": file_mirror::mirror_config(store)?, "last": file_mirror::mirror_summary(store) }))
        })(),
        // The settings' read: quick, so it never waits behind slow work for a bridge slot.
        "store_file_mirror_config" => (|| json_output(json!({ "config": file_mirror::mirror_config(store)?, "last": file_mirror::mirror_summary(store) })))(),
        "store_file_mirror_run" => (|| json_output(file_mirror::mirror_sync(store, &filenames::rules(store)?)?))(),
        _ => return None,
    };
    Some(result)
}

/// Runs the automatic Markdown export and the mirror when what they depend on has changed
/// and then stayed still for a moment.
pub fn start_watcher(store: Store) {
    let _ = std::thread::Builder::new().name("key-export-watch".into()).spawn(move || {
        key_store::priority::set_thread_class(key_store::priority::Class::Background);
        let mut seen: (Option<u64>, Option<String>) = (None, None);
        let mut changed_at: [Option<Instant>; 2] = [None, None];
        loop {
            std::thread::sleep(POLL);
            let markdown = md_export::config(&store).ok().filter(|c| c.mode == Mode::Change && c.folder.as_ref().is_some_and(|f| f.is_dir()));
            let mirror = file_mirror::mirror_config(&store).ok().filter(|m| m.enabled && m.folder.is_some());
            if markdown.is_some() {
                if let Ok(digest) = md_export::change_digest(&store) {
                    if seen.0 != Some(digest) {
                        // The first look after start only remembers; later ones export.
                        changed_at[0] = if seen.0.is_some() { Some(Instant::now()) } else { Some(Instant::now() - SETTLE) };
                        seen.0 = Some(digest);
                    }
                }
            }
            if mirror.is_some() {
                if let Ok(fingerprint) = store.library_fingerprint() {
                    if seen.1.as_ref() != Some(&fingerprint) {
                        changed_at[1] = Some(Instant::now());
                        seen.1 = Some(fingerprint);
                    }
                }
            }
            if changed_at[0].is_some_and(|at| at.elapsed() >= SETTLE) && markdown.is_some() {
                changed_at[0] = None;
                let _ = md_export::sync(&store, &Request { changed_only: true, notes: true, ..Default::default() }, &cite(&store));
                seen.0 = md_export::change_digest(&store).ok();
            }
            if changed_at[1].is_some_and(|at| at.elapsed() >= SETTLE) && mirror.is_some() {
                changed_at[1] = None;
                if let Ok(rules) = filenames::rules(&store) {
                    let _ = file_mirror::mirror_sync(&store, &rules);
                }
            }
        }
    });
}
