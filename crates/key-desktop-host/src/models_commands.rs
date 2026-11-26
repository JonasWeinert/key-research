// The on-device models (key-models) as host commands: list with state and disk use, download
// (the user asking), remove, add from a file, and the automatic-download setting. Any
// workspace host answers for the whole machine: the models folder is shared.
//
// When a model arrives, the work that waited for it continues: PDFs read without the layout
// model are analysed again, and passages indexed before the search model get their vectors.
use crate::ipc::{Output, arg};
use key_index::Indexer;
use key_store::Store;
use serde_json::{Value as Json, json};
use std::path::PathBuf;

use super::json_output;

/// The engine a PDF analysed with the layout model records.
const LAYOUT_ENGINE: &str = "layout-onnx";

pub fn models() -> key_models::Models {
    key_models::Models::from_env()
}

/// What runs once a model is ready.
fn after_ready(store: &Store, indexer: &Indexer, id: &str) -> Option<Box<dyn FnOnce() + Send>> {
    let (store, indexer) = (store.clone(), indexer.clone());
    match id {
        key_models::LAYOUT => Some(Box::new(move || {
            if indexer.layout_model() {
                let _ = store.reanalyze_outdated(LAYOUT_ENGINE);
            }
            indexer.wake();
        })),
        key_models::EMBEDDINGS => Some(Box::new(move || {
            let _ = indexer.embedder();
            indexer.wake();
        })),
        _ => None,
    }
}

/// Asks for the layout model in the background (the indexer calls it on first need).
pub fn layout_requester(store: Store, indexer: Indexer) -> Box<dyn Fn() + Send + Sync> {
    Box::new(move || {
        models().request(key_models::LAYOUT, false, after_ready(&store, &indexer, key_models::LAYOUT));
    })
}

/// At start: PDFs that were read without the layout model while it was missing ask for it
/// again (a download interrupted by quitting continues).
pub fn resume(store: &Store, indexer: &Indexer) {
    if !indexer.layout_model() || crate::layout_helper::model_path().is_some() {
        return;
    }
    if store.outdated_analyses(LAYOUT_ENGINE).unwrap_or(0) > 0 {
        models().request(key_models::LAYOUT, false, after_ready(store, indexer, key_models::LAYOUT));
    }
}

pub fn dispatch(store: &Store, indexer: &Indexer, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let result = match command {
        "store_models" => json_output(models().list()),
        "store_model_download" => (|| {
            let id: String = arg(args, "id")?;
            let models = models();
            models.spec(&id)?;
            models.request(&id, true, after_ready(store, indexer, &id));
            json_output(models.status(&id)?)
        })(),
        "store_model_remove" => (|| {
            let id: String = arg(args, "id")?;
            let models = models();
            models.remove(&id)?;
            if id == key_models::EMBEDDINGS {
                indexer.unload_embedder();
            }
            json_output(models.list())
        })(),
        // "Add model from file…": a file or folder the user downloaded by hand.
        "store_model_import" => (|| {
            let path: PathBuf = arg(args, "path")?;
            let models = models();
            let added = models.import(&path)?;
            for id in &added {
                if models.ready(id)
                    && let Some(then) = after_ready(store, indexer, id)
                {
                    then();
                }
            }
            json_output(json!({ "added": added, "models": models.list() }))
        })(),
        "store_models_options" => (|| {
            if let Some(auto) = arg::<Option<bool>>(args, "autoDownload")? {
                key_models::set_auto_download(auto);
            }
            json_output(models().list())
        })(),
        _ => return None,
    };
    Some(result)
}
