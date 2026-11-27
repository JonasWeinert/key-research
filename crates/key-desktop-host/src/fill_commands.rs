// Fill recipes and runs (key-store's fill.rs): the recipes, their gallery and sharing, what a
// run would send and cost, the requests the main process sends to the AI provider, the
// answers it hands back, review and undo.
use super::{json_output, library_store::Library};
use crate::ipc::{Output, arg};
use key_store::Store;
use key_store::fill::{Recipe, starter_recipes};
use serde_json::{Map, Value as Json, json};

pub fn dispatch(library: &Library, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let store = &library.store;
    let changed = || library.indexer.wake();
    let run = || arg::<String>(args, "runId");
    // The sources: given ids, else a collection's or the whole library's.
    let ids = || -> Result<Vec<String>, String> {
        let given: Option<Vec<String>> = arg(args, "ids")?;
        match given.filter(|ids| !ids.is_empty()) {
            Some(ids) => Ok(ids),
            None if arg::<Option<bool>>(args, "all")?.unwrap_or(false) => store.fill_scope_ids(None),
            None => match arg::<Option<String>>(args, "collectionId")? {
                Some(collection) => store.fill_scope_ids(Some(&collection)),
                None => Ok(Vec::new()),
            },
        }
    };
    Some(match command {
        "store_fill_recipes" => (|| json_output(store.fill_recipes()?))(),
        "store_fill_starters" => json_output(starter_recipes()),
        "store_fill_recipe_save" => (|| json_output(store.save_fill_recipe(arg::<Recipe>(args, "recipe")?)?))(),
        "store_fill_recipe_delete" => (|| json_output(store.delete_fill_recipe(&arg::<String>(args, "id")?)?))(),
        "store_fill_recipe_export" => (|| {
            let recipe = arg::<Recipe>(args, "recipe")?.validate()?;
            json_output(json!({ "text": serde_json::to_string_pretty(&Store::export_fill_recipe(&recipe)).map_err(|e| e.to_string())? }))
        })(),
        "store_fill_recipe_import" => (|| json_output(Store::import_fill_recipe(&arg::<String>(args, "text")?)?))(),
        "store_fill_validate" => (|| json_output(arg::<Recipe>(args, "recipe")?.validate()?))(),
        "store_fill_estimate" => (|| json_output(store.fill_estimate(arg::<Recipe>(args, "recipe")?, &ids()?)?))(),
        "store_fill_run_create" => (|| {
            let provider: Option<String> = arg(args, "provider")?;
            let model: Option<String> = arg(args, "model")?;
            let summary = store.fill_run_create(
                arg::<Recipe>(args, "recipe")?,
                &ids()?,
                arg::<Option<bool>>(args, "sample")?.unwrap_or(false),
                arg::<Option<bool>>(args, "auto")?.unwrap_or(false),
                provider.as_deref(),
                model.as_deref(),
            )?;
            json_output(summary)
        })(),
        "store_fill_run_next" => (|| {
            let out = store.fill_run_next(&run()?, arg::<Option<usize>>(args, "max")?.unwrap_or(4))?;
            changed();
            json_output(out)
        })(),
        "store_fill_run_answer" => (|| {
            let content: Option<String> = arg(args, "content")?;
            let error: Option<String> = arg(args, "error")?;
            let tokens = (arg::<Option<i64>>(args, "tokensIn")?.unwrap_or(0), arg::<Option<i64>>(args, "tokensOut")?.unwrap_or(0));
            let out = store.fill_run_answer(&run()?, &arg::<String>(args, "sourceId")?, content.as_deref(), error.as_deref(), tokens)?;
            changed();
            json_output(out)
        })(),
        "store_fill_run_status" => (|| json_output(store.fill_run_set_status(&run()?, &arg::<String>(args, "status")?)?))(),
        "store_fill_runs" => (|| json_output(store.fill_runs(arg::<Option<usize>>(args, "limit")?.unwrap_or(20))?))(),
        "store_fill_run" => (|| json_output(store.fill_run(&run()?, arg::<Option<usize>>(args, "offset")?.unwrap_or(0), arg::<Option<usize>>(args, "limit")?.unwrap_or(200), arg::<Option<bool>>(args, "passages")?.unwrap_or(false))?))(),
        "store_fill_run_passages" => (|| json_output(store.fill_run_passages(&run()?, &arg::<String>(args, "sourceId")?)?))(),
        "store_fill_review" => (|| {
            let out = store.fill_review(
                &run()?,
                &arg::<Option<Vec<String>>>(args, "accept")?.unwrap_or_default(),
                &arg::<Option<Vec<String>>>(args, "reject")?.unwrap_or_default(),
                &arg::<Option<Map<String, Json>>>(args, "edits")?.unwrap_or_default(),
                arg::<Option<bool>>(args, "all")?.unwrap_or(false),
            )?;
            changed();
            json_output(out)
        })(),
        "store_fill_run_undo" => (|| {
            let out = store.fill_run_undo(&run()?)?;
            changed();
            json_output(out)
        })(),
        "store_fill_run_delete" => (|| json_output(store.fill_run_delete(&run()?)?))(),
        "store_fill_auto_candidates" => (|| json_output(store.fill_auto_candidates(arg::<Option<usize>>(args, "limit")?.unwrap_or(50))?))(),
        _ => return None,
    })
}
