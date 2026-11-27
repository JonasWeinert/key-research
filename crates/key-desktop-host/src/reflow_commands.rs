// Reading mode's host commands. The text, its runs and where highlights fall in it are built in
// key-index (reflow.rs) from the structure the indexer stored (key-store structure.rs); this
// serves them and maps a selection in the text back to the PDF's own characters, so a highlight
// made in reading mode is stored where it is on the page.
//   store_reflow_document {hash}  → {status: ready|missing|running|unsupported, document?, marks?}
//   store_reflow_locate {hash, item, caption?, start, end}
//                                → {certain, range?, text, page, quote}
use super::{NativePdfService, Reply, Request, json_output, library_store::Library};
use crate::ipc::{Output, arg};
use key_index::reflow::{self, PageChars};
use serde_json::{Value as Json, json};
use std::sync::atomic::{AtomicU64, Ordering};

pub fn dispatch(library: &Library, native: &NativePdfService, command: &str, args: &Json) -> Option<Result<Output, String>> {
    match command {
        "store_reflow_document" => Some(document(library, args).and_then(json_output)),
        "store_reflow_locate" => Some(locate(library, native, args).and_then(json_output)),
        _ => None,
    }
}

/// The stored structure assembled, or why there is none.
fn assembled(library: &Library, hash: &str) -> Result<Result<(key_store::Source, reflow::Document), Json>, String> {
    let source = library.store.source_by_hash(hash)?.ok_or("This PDF is not in the library")?;
    if source.kind != "pdf" {
        return Ok(Err(json!({ "status": "unsupported" })));
    }
    let running = matches!(source.index_status.as_str(), "pending" | "indexing");
    let stored = library.store.structure(&source.id)?.filter(|s| source.file_hash().is_none_or(|h| h == s.file_hash));
    let Some(stored) = stored else {
        return Ok(Err(json!({ "status": if running { "running" } else { "missing" }, "indexStatus": source.index_status })));
    };
    let layout: key_index::Layout = serde_json::from_str(&stored.layout).map_err(|e| e.to_string())?;
    Ok(Ok((source, reflow::assemble(&layout))))
}

fn document(library: &Library, args: &Json) -> Result<Json, String> {
    let hash: String = arg(args, "hash")?;
    let (source, document) = match assembled(library, &hash)? {
        Ok(found) => found,
        Err(status) => return Ok(status),
    };
    let annotations = library.store.annotations(&source.id)?;
    let marks = reflow::marks(&document, &annotations);
    let running = matches!(source.index_status.as_str(), "pending" | "indexing");
    // Where the page view was: the item reading mode opens at.
    let at = match (arg::<Option<i64>>(args, "page")?, arg::<Option<f32>>(args, "fraction")?) {
        (Some(page), fraction) => reflow::item_at(&document, page, fraction.unwrap_or(0.0)),
        _ => None,
    };
    Ok(json!({ "status": "ready", "running": running, "document": document, "marks": marks, "at": at }))
}

fn locate(library: &Library, native: &NativePdfService, args: &Json) -> Result<Json, String> {
    let hash: String = arg(args, "hash")?;
    let item: usize = arg(args, "item")?;
    let caption = arg::<Option<bool>>(args, "caption")?.unwrap_or(false);
    let start: usize = arg(args, "start")?;
    let end: usize = arg(args, "end")?;
    let (source, document) = assembled(library, &hash)?.map_err(|_| "Reading mode has no text for this PDF yet".to_string())?;
    let pieces = reflow::pieces(&document, item, caption, start, end);
    let quote = pieces.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join(" ");
    let first_page = pieces.first().map_or(0, |p| p.page);
    let uncertain = || json!({ "certain": false, "page": first_page, "quote": quote, "text": quote });
    if pieces.is_empty() {
        return Ok(uncertain());
    }
    let path = source.file_path().ok_or("The PDF file is missing")?;
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = format!("reflow:{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let Reply::Document(opened) = native.request(|reply| Request::OpenFile { id: id.clone(), path, reply })? else {
        return Err("Unexpected PDF open reply".into());
    };
    let mut found = Vec::new();
    let mut rects = Vec::new();
    for piece in &pieces {
        let page = piece.page.max(0) as usize;
        let size = opened.pages.get(page).map(|p| (p.width, p.height));
        let text = match (size, native.request(|reply| Request::Text { id: id.clone(), page, reply })) {
            (Some(size), Ok(Reply::Text(text))) => Some((size, text)),
            _ => None,
        };
        let located = text.and_then(|((width, height), text)| {
            let chars = PageChars {
                page: piece.page,
                width,
                height,
                chars: text.characters.into_iter().map(|c| (c.value, c.bounds.map(|b| [b.left, b.top, b.right, b.bottom]))).collect(),
            };
            let span = reflow::locate(&chars, piece)?;
            if rects.is_empty() {
                rects = reflow::span_rects(&chars, span);
            }
            Some(span)
        });
        match located {
            Some(span) => found.push((piece.page, span)),
            None => break,
        }
    }
    let _ = native.request(|reply| Request::Close { id, reply });
    if found.len() != pieces.len() {
        return Ok(uncertain());
    }
    let (first, last) = (found[0], found[found.len() - 1]);
    Ok(json!({
        "certain": true,
        "page": first.0,
        "quote": quote,
        "text": quote,
        "range": { "start": { "page": first.0, "index": first.1.0 }, "end": { "page": last.0, "index": last.1.1 } },
        // On the first page: where Cite's quote links back to.
        "rects": rects,
    }))
}
