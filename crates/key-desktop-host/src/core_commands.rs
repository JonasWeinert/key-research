// Analysis the shell used to do in TypeScript, served from key-store: the tag manager's
// suggestions and plans, the search field's reading of a query, and a saved web page's
// reference list (read from its HTML, stored as a PDF analysis' are).
use super::{json_output, library_store::Library};
use crate::ipc::{Output, arg};
use key_store::tag_plan::TagPlan;
use key_store::web_references::{WebReferenceScan, detect_web_references, reference_inputs};
use serde_json::{Value as Json, json};

const MAX_PAGE_BYTES: u64 = 80 * 1024 * 1024;

pub fn dispatch(library: &Library, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let store = &library.store;
    let result = match command {
        // Suggestions with each one's planned change; `dismissed` defaults to the stored list.
        "store_tag_suggestions" => (|| {
            let dismissed: Option<Vec<String>> = arg(args, "dismissed")?;
            let max_themes: Option<usize> = arg(args, "maxThemes")?;
            json_output(store.tag_suggestions(dismissed, max_themes)?)
        })(),
        // A plan as the operation `store_tag_apply` takes, with its preview.
        "store_tag_plan" => arg::<TagPlan>(args, "plan").and_then(|plan| json_output(store.tag_plan(&plan)?)),
        // Readings of a search query (identifiers, years, citations, kinds, tag and collection names).
        "store_parse_query" => (|| {
            let text: String = arg(args, "text")?;
            let kinds = arg::<Option<bool>>(args, "kinds")?.unwrap_or(false);
            json_output(store.parse_query(&text, kinds)?)
        })(),
        // A saved page's references: from `html` (the live page, JSON-LD included) or its
        // saved file. Stored unless `store` is false; the scan comes back for the reader.
        "store_web_references_detect" => (|| {
            let id: String = arg(args, "id")?;
            let html: Option<String> = arg(args, "html")?;
            let url: Option<String> = arg(args, "url")?;
            let save = arg::<Option<bool>>(args, "store")?.unwrap_or(true);
            let source = store.source(&id)?.ok_or("Source not found")?;
            if source.kind != "web" {
                return Err("Not a saved web page".to_string());
            }
            let html = match html {
                Some(html) => html,
                None => {
                    let path = source.file_path().ok_or("This source has no saved page")?;
                    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_PAGE_BYTES {
                        return Err("The saved page is too large to read".into());
                    }
                    String::from_utf8_lossy(&std::fs::read(&path).map_err(|e| e.to_string())?).into_owned()
                }
            };
            let page_url = url.or_else(|| source.properties.get("webSnapshot").and_then(|s| s.get("url")).and_then(Json::as_str).map(String::from)).or_else(|| source.field("url").map(String::from));
            let scan = detect_web_references(&html, page_url.as_deref());
            let analysis = if save { Some(store_scan(library, &id, &scan)?) } else { None };
            json_output(json!({ "scan": scan, "analysis": analysis }))
        })(),
        _ => return None,
    };
    Some(result)
}

/// Kept as the PDF analysis' are, then looked up by the reference worker the same way.
fn store_scan(library: &Library, id: &str, scan: &WebReferenceScan) -> Result<Json, String> {
    let store = &library.store;
    let references = reference_inputs(scan);
    store.set_analysis(id, "html", None, !references.is_empty())?;
    store.replace_references(id, &references)?;
    store.replace_citations(id, super::reference_worker::CITATIONS_VERSION, !references.is_empty(), None, &[])?;
    library.references.focus(id);
    serde_json::to_value(store.analysis(id)?).map_err(|e| e.to_string())
}
