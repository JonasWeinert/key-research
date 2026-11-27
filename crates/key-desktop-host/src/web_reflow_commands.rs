// Reading mode for saved web pages: the article of a `web` source's snapshot as reflowed text
// (key-index web_reflow.rs), its highlights, and selections and places mapped back to the page.
//   store_web_reflow_document {id, offset?} → {status: ready|unsupported, document, marks, at, text: {length, hash}}
//   store_web_reflow_locate {id, item, part?, start, end} → {certain, quote, start?, end?, exact?, prefix?, suffix?}
//   store_web_reflow_project {id, ranges: [{start, end}]} → [[{item, part?, start, end}]]
//   store_web_reflow_resource {id, resource} → {src}  (a picture's own inlined copy: data: only)
use super::library_store::Library;
use crate::ipc::{Output, arg, json_output};
use key_index::web_reflow::{self, WebDocument};
use serde_json::{Value as Json, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

pub fn dispatch(library: &Library, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let result = match command {
        "store_web_reflow_document" => document(library, args),
        "store_web_reflow_locate" => locate(library, args),
        "store_web_reflow_project" => project(library, args),
        "store_web_reflow_resource" => resource(library, args),
        _ => return None,
    };
    Some(result.and_then(json_output))
}

type Key = (PathBuf, Option<SystemTime>, u64);
/// The last few pages read: annotations change often, the page does not.
static CACHE: Mutex<Vec<(Key, Arc<WebDocument>)>> = Mutex::new(Vec::new());

fn assembled(library: &Library, id: &str) -> Result<Option<(key_store::Source, Arc<WebDocument>)>, String> {
    let source = library.store.source(id)?.ok_or("This page is not in the library")?;
    if source.kind != "web" {
        return Ok(None);
    }
    let path = source.file_path().ok_or("This source has no saved page")?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("The saved page cannot be read: {e}"))?;
    if meta.len() > 80 * 1024 * 1024 {
        return Err("The saved page is too large for reading mode".into());
    }
    let key: Key = (path.clone(), meta.modified().ok(), meta.len());
    if let Some((_, doc)) = CACHE.lock().map_err(|e| e.to_string())?.iter().find(|(k, _)| *k == key) {
        return Ok(Some((source, doc.clone())));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("The saved page cannot be read: {e}"))?;
    let doc = Arc::new(web_reflow::assemble(&String::from_utf8_lossy(&bytes)));
    let mut cache = CACHE.lock().map_err(|e| e.to_string())?;
    cache.retain(|(k, _)| k.0 != key.0);
    cache.insert(0, (key, doc.clone()));
    cache.truncate(4);
    Ok(Some((source, doc)))
}

fn document(library: &Library, args: &Json) -> Result<Json, String> {
    let id: String = arg(args, "id")?;
    let Some((source, doc)) = assembled(library, &id)? else { return Ok(json!({ "status": "unsupported" })) };
    let annotations = library.store.annotations(&source.id)?;
    let marks = web_reflow::marks(&doc, &annotations);
    let at = arg::<Option<usize>>(args, "offset")?.and_then(|offset| web_reflow::item_at(&doc, offset));
    let (length, hash) = doc.fingerprint();
    Ok(json!({ "status": "ready", "document": doc.document, "marks": marks, "at": at, "text": { "length": length, "hash": hash } }))
}

fn locate(library: &Library, args: &Json) -> Result<Json, String> {
    let id: String = arg(args, "id")?;
    let (_, doc) = assembled(library, &id)?.ok_or("Reading mode is for saved web pages")?;
    let part = arg::<Option<String>>(args, "part")?.unwrap_or_default();
    let found = web_reflow::locate(&doc, arg(args, "item")?, &part, arg(args, "start")?, arg(args, "end")?);
    serde_json::to_value(found).map_err(|e| e.to_string())
}

fn project(library: &Library, args: &Json) -> Result<Json, String> {
    let id: String = arg(args, "id")?;
    let (_, doc) = assembled(library, &id)?.ok_or("Reading mode is for saved web pages")?;
    let ranges: Vec<Json> = arg(args, "ranges")?;
    let out: Vec<Json> = ranges
        .iter()
        .map(|r| {
            let (start, end) = (r["start"].as_u64().unwrap_or(0) as usize, r["end"].as_u64().unwrap_or(0) as usize);
            serde_json::to_value(web_reflow::project(&doc, start, end)).unwrap_or(Json::Null)
        })
        .collect();
    Ok(Json::Array(out))
}

fn resource(library: &Library, args: &Json) -> Result<Json, String> {
    let id: String = arg(args, "id")?;
    let (_, doc) = assembled(library, &id)?.ok_or("Reading mode is for saved web pages")?;
    let n: usize = arg(args, "resource")?;
    let src = doc.resources.get(n).ok_or("No such picture on this page")?;
    Ok(json!({ "src": src }))
}
