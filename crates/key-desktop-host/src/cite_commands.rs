// Citations through key-cite: formatted citations and bibliographies for library sources in
// any bundled or installed CSL style, the style and locale lists, installing a `.csl` (file
// contents, or a style from the official repository by id or URL) and removing one.
// Installed styles live in KEY_CITATION_STYLES_DIR (the app's user-data folder), shared by
// every workspace; the shipped ones are data files in KEY_CITATION_DATA_DIR (key_cite::data).
use super::{json_output, library_store::Library};
use crate::ipc::{Output, arg};
use key_cite::{CitationInput, RenderRequest, Styles, csl_json};
use key_safe_http::{CancellationToken, ContentTypePolicy, ContentTypeRule, ExactHostAllowlist, HttpLimits, HttpPolicy, HttpRequest, RateLimit, SafeHttpClient, SchemePolicy};
use serde_json::{Value as Json, json};
use std::{sync::OnceLock, time::Duration};

const REPOSITORY_HOST: &str = "raw.githubusercontent.com";
const REPOSITORY: &str = "https://raw.githubusercontent.com/citation-style-language/styles/master";

pub(super) fn styles() -> &'static Styles {
    static STYLES: OnceLock<Styles> = OnceLock::new();
    STYLES.get_or_init(|| Styles::new(std::env::var_os("KEY_CITATION_STYLES_DIR").map(Into::into)))
}

/// The style and locale asked for, else this workspace's own (Workspace Settings), else the
/// app's default (the app's settings file, KEY_APP_SETTINGS_FILE, read each time so a change
/// applies at once), else APA.
pub(super) fn chosen(store: &key_store::Store, args: &Json) -> Result<(String, Option<String>), String> {
    let style: Option<String> = arg::<Option<String>>(args, "style")?.filter(|s| !s.trim().is_empty());
    let locale: Option<String> = arg::<Option<String>>(args, "locale")?.filter(|s| !s.trim().is_empty());
    // (Without the shipped styles, any style asked for falls back to Key's basic one.)
    if let (Some(style), Some(locale)) = (&style, &locale)
        && (styles().data().available() || styles().summary(style).is_some())
    {
        return Ok((style.clone(), Some(locale.clone())));
    }
    let (own_style, own_locale) = super::workspace_settings::citation_override(store);
    let style = style.or(own_style);
    let locale = locale.or(own_locale);
    let settings = super::workspace_settings::app_file();
    let saved = |key: &str| settings.get(key).and_then(Json::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let mut style = style.or_else(|| saved("citationStyle")).unwrap_or_else(|| styles().default_id().into());
    // A removed style falls back to the default rather than failing every citation.
    if styles().summary(&style).is_none() {
        style = styles().default_id().into();
    }
    Ok((style, locale.or_else(|| saved("citationLocale"))))
}

pub fn dispatch(library: &Library, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let result = match command {
        // Where a quotation is from in the chosen style: { id, page? (1-based text), label? }
        // -> { text, html, rtf }.
        "store_cite_attribution" => (|| {
            let (style_id, locale) = chosen(&library.store, args)?;
            let id: String = arg(args, "id")?;
            let page: Option<String> = arg(args, "page")?;
            let label: Option<String> = arg(args, "label")?;
            let item = csl_items(library, std::slice::from_ref(&id))?.into_iter().next().ok_or("Source not found")?;
            json_output(key_cite::render::attribution(&*styles().style(&style_id)?, locale.as_deref(), &item, page.as_deref(), label.as_deref())?)
        })(),
        // { style?, locale?, citations?: [{ items: [{ id, locator?, label?, prefix?, suffix?,
        //   suppressAuthor?, authorOnly?, narrative? }], noteNumber? }], bibliography?, ids? }
        // -> { citations: [{text, html, rtf}], bibliography?: { entries, text, html, rtf, … },
        //      noteStyle, missing, style }. `ids` alone renders a bibliography of them.
        "store_cite_render" => (|| {
            let (style_id, locale) = chosen(&library.store, args)?;
            let citations: Vec<CitationInput> = arg::<Option<Vec<CitationInput>>>(args, "citations")?.unwrap_or_default();
            let ids: Vec<String> = arg::<Option<Vec<String>>>(args, "ids")?.unwrap_or_default();
            let bibliography = arg::<Option<bool>>(args, "bibliography")?.unwrap_or(citations.is_empty());
            if citations.len() > 5000 || ids.len() > 5000 {
                return Err("Too many citations in one request".into());
            }
            let style = styles().style(&style_id)?;
            let mut wanted: Vec<String> = citations.iter().flat_map(|c| c.items.iter().map(|i| i.id.clone())).chain(ids.iter().cloned()).collect();
            wanted.sort();
            wanted.dedup();
            let mut items = csl_items(library, &wanted)?;
            // Works not in the library (a web search result): in the source shape, by their own id.
            for source in arg::<Option<Vec<Json>>>(args, "sources")?.unwrap_or_default().into_iter().take(500) {
                items.push(csl_json::from_source(&loose_source(source)?));
            }
            let request = RenderRequest { citations, bibliography, uncited: ids };
            let out = key_cite::render(&style, locale.as_deref(), &items, &request)?;
            let mut value = serde_json::to_value(out).map_err(|e| e.to_string())?;
            value["style"] = serde_json::to_value(styles().summary(&style_id)).map_err(|e| e.to_string())?;
            json_output(value)
        })(),
        // CSL-JSON for sources (export, the Word add-in): { ids } -> [item].
        "store_cite_items" => arg::<Vec<String>>(args, "ids").and_then(|ids| json_output(csl_items(library, &ids)?)),
        "store_cite_styles" => chosen(&library.store, &Json::Null).and_then(|(style, locale)| {
            json_output(json!({ "styles": styles().list(), "locales": key_cite::styles::locale_list(), "folder": styles().dir(), "style": style, "locale": locale, "data": styles().data().status() }))
        }),
        // { xml } (a file's contents) or { url } (a style id, or a zotero.org/styles or
        // citation-style-language/styles address). A dependent style's parent comes along.
        "store_cite_style_install" => (|| {
            let xml: Option<String> = arg(args, "xml")?;
            let url: Option<String> = arg(args, "url")?;
            let summary = match (xml, url) {
                (Some(xml), _) => styles().install(&xml)?,
                (None, Some(url)) => install_from_repository(&url)?,
                _ => return Err("Give a style file or address".into()),
            };
            json_output(summary)
        })(),
        "store_cite_style_remove" => arg::<String>(args, "id").and_then(|id| json_output(json!({ "removed": styles().remove(&id)? }))),
        _ => return None,
    };
    Some(result)
}

/// A source's bibliography entry in the chosen style, as Markdown (the Markdown export).
pub fn reference_markdown(store: &key_store::Store, source: &key_store::Source) -> Option<String> {
    let (style_id, locale) = chosen(store, &Json::Null).ok()?;
    let style = styles().style(&style_id).ok()?;
    let request = RenderRequest { citations: Vec::new(), bibliography: true, uncited: vec![source.id.clone()] };
    let out = key_cite::render(&style, locale.as_deref(), &[csl_json::from_source(source)], &request).ok()?;
    let entry = out.bibliography?.entries.into_iter().next()?;
    Some(key_biblio::md_export::html_to_markdown(&entry.formatted.html)).filter(|t| !t.is_empty())
}

pub(super) fn csl_items(library: &Library, ids: &[String]) -> Result<Vec<Json>, String> {
    let mut items = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(source) = library.store.source(id)? {
            items.push(csl_json::from_source(&source));
        }
    }
    Ok(items)
}

/// A source-shaped object from the UI (id, kind, creators and bibliographic fields), with
/// the bookkeeping fields a stored source has filled in.
fn loose_source(mut value: Json) -> Result<key_store::Source, String> {
    let map = value.as_object_mut().ok_or("A source must be an object")?;
    for (key, default) in [
        ("id", json!("work")),
        ("kind", json!("reference")),
        ("creators", json!([])),
        ("tags", json!([])),
        ("properties", json!({})),
        ("collections", json!([])),
        ("starred", json!(false)),
        ("indexStatus", json!("none")),
        ("indexedChunks", json!(0)),
        ("indexTotal", json!(0)),
        ("addedAt", json!(0)),
        ("updatedAt", json!(0)),
        ("noteCount", json!(0)),
        ("annotationCount", json!(0)),
    ] {
        if map.get(key).is_none_or(Json::is_null) {
            map.insert(key.into(), default);
        }
    }
    serde_json::from_value(value).map_err(|e| format!("Invalid source: {e}"))
}

/// The repository path a style id or address names (`<id>` or `dependent/<id>`).
fn repository_id(input: &str) -> Result<String, String> {
    let text = input.trim().trim_end_matches('/');
    let lower = text.to_ascii_lowercase();
    let id = if !text.contains('/') && !text.contains(':') {
        text.trim_end_matches(".csl").to_string()
    } else if let Some(rest) = ["https://www.zotero.org/styles/", "http://www.zotero.org/styles/", "https://zotero.org/styles/", "http://zotero.org/styles/"]
        .iter()
        .find_map(|p| lower.starts_with(p).then(|| &text[p.len()..]))
    {
        rest.split(['?', '#']).next().unwrap_or(rest).to_string()
    } else if let Some(rest) = ["https://github.com/citation-style-language/styles/blob/", "https://raw.githubusercontent.com/citation-style-language/styles/"]
        .iter()
        .find_map(|p| lower.starts_with(p).then(|| &text[p.len()..]))
    {
        // <branch>/<path>.csl
        let path = rest.split_once('/').map(|(_, p)| p).unwrap_or(rest);
        path.trim_end_matches(".csl").trim_start_matches("dependent/").to_string()
    } else {
        return Err("Only styles from the official CSL repository can be installed by address; choose the file instead".into());
    };
    let id = id.trim_end_matches(".csl").to_string();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("That is not a style id".into());
    }
    Ok(id)
}

fn fetch(path: &str) -> Result<Option<String>, String> {
    let failed = |e: key_safe_http::HttpError| e.to_string();
    let limits = HttpLimits {
        max_response_bytes: 2 * 1024 * 1024,
        max_redirects: 0,
        max_concurrent: 1,
        request_timeout: Duration::from_secs(20),
        rate: RateLimit::new(20, Duration::from_secs(60)).map_err(failed)?,
        ..HttpLimits::default()
    };
    let types = ContentTypePolicy::new(
        [ContentTypeRule::exact("text/plain").map_err(failed)?, ContentTypeRule::structured_suffix("xml").map_err(failed)?, ContentTypeRule::exact("application/xml").map_err(failed)?, ContentTypeRule::exact("text/xml").map_err(failed)?],
        true,
    )
    .map_err(failed)?;
    let policy = HttpPolicy::new(ExactHostAllowlist::new([REPOSITORY_HOST]).map_err(failed)?, types).with_schemes(SchemePolicy::HttpsOnly).with_limits(limits).map_err(failed)?;
    let request = HttpRequest::get(&format!("{REPOSITORY}/{path}")).and_then(|r| r.with_header("user-agent", "Key/0.1 (citation styles)")).map_err(failed)?;
    let response = SafeHttpClient::new(policy).execute(request, &CancellationToken::active()).map_err(|e| format!("Couldn't download the style: {e}"))?;
    match response.status() {
        200 => Ok(Some(String::from_utf8_lossy(response.body()).into_owned())),
        404 => Ok(None),
        status => Err(format!("The styles repository answered {status}")),
    }
}

fn install_from_repository(input: &str) -> Result<key_cite::StyleSummary, String> {
    let id = repository_id(input)?;
    let xml = match fetch(&format!("{id}.csl"))? {
        Some(xml) => xml,
        None => fetch(&format!("dependent/{id}.csl"))?.ok_or_else(|| format!("The styles repository has no style “{id}”"))?,
    };
    // A dependent style needs its parent; fetch it first when Key does not have it.
    if let Ok(citationberg::Style::Dependent(dependent)) = citationberg::Style::from_xml(&xml) {
        let parent = dependent.info.link.iter().find(|l| l.rel == citationberg::InfoLinkRel::IndependentParent).map(|l| key_cite::styles::short_id(&l.href));
        if let Some(parent) = parent.filter(|p| styles().summary(p).is_none()) {
            let parent_xml = fetch(&format!("{parent}.csl"))?.ok_or_else(|| format!("The parent style “{parent}” is missing from the repository"))?;
            styles().install(&parent_xml)?;
        }
    }
    styles().install(&xml)
}

#[cfg(test)]
mod tests {
    use super::repository_id;

    /// Downloads from the CSL repository: `cargo test -- --ignored repository_install`.
    #[test]
    #[ignore]
    fn repository_install() {
        let dir = std::env::temp_dir().join(format!("key-cite-repo-{}", std::process::id()));
        unsafe { std::env::set_var("KEY_CITATION_STYLES_DIR", &dir) };
        let style = super::install_from_repository("https://www.zotero.org/styles/apa-no-ampersand").unwrap();
        assert_eq!(style.id, "apa-no-ampersand");
        // A dependent style brings its parent along.
        let dependent = super::install_from_repository("journal-of-the-american-chemical-society").unwrap();
        assert!(dependent.parent.is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn style_addresses() {
        assert_eq!(repository_id("apa-no-ampersand").unwrap(), "apa-no-ampersand");
        assert_eq!(repository_id("https://www.zotero.org/styles/nature?source=1").unwrap(), "nature");
        assert_eq!(repository_id("https://github.com/citation-style-language/styles/blob/master/ieee.csl").unwrap(), "ieee");
        assert_eq!(repository_id("https://raw.githubusercontent.com/citation-style-language/styles/master/dependent/vancouver.csl").unwrap(), "vancouver");
        assert!(repository_id("https://example.com/evil.csl").is_err());
        assert!(repository_id("../etc").is_err());
    }
}
