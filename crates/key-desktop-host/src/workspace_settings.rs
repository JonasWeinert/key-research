// Settings that belong to one workspace, kept in its own store (meta `settings.workspace`),
// next to the app-wide defaults some of them override (the app's settings file,
// KEY_APP_SETTINGS_FILE, read each time).
//
// - citationStyle / citationLocale: null uses the app's default style and locale.
// - lookups: automatic OpenAlex lookups (and the retraction rechecks that ride on them);
//   null follows the app's default.
// - findPdfOnAdd / addFromSource: this workspace's own; app settings files from before
//   Workspace Settings held them for every workspace, so a workspace without its own value
//   starts from that one (copied in once).
use super::{json_output, library_store::Library};
use crate::ipc::{Output, arg};
use key_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

const KEY: &str = "settings.workspace";
const ADD_MODES: [&str; 3] = ["ask", "origin", "library"];

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Own {
    #[serde(default)]
    pub citation_style: Option<String>,
    #[serde(default)]
    pub citation_locale: Option<String>,
    #[serde(default)]
    pub lookups: Option<bool>,
    #[serde(default)]
    pub find_pdf_on_add: Option<bool>,
    #[serde(default)]
    pub add_from_source: Option<String>,
    /// Bulk indexing on battery (power.rs): "low" (the default), "battery" or "never".
    #[serde(default)]
    pub battery: Option<String>,
}

pub fn own(store: &Store) -> Own {
    store.meta(KEY).ok().flatten().and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

fn save(store: &Store, own: &Own) -> Result<(), String> {
    store.set_meta(KEY, &serde_json::to_string(own).map_err(|e| e.to_string())?)
}

/// The app's settings file (absent in tests and on a fresh profile).
pub fn app_file() -> Json {
    std::env::var_os("KEY_APP_SETTINGS_FILE")
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Json::Null)
}

fn text(value: Option<&Json>) -> Option<String> {
    value.and_then(Json::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// The workspace's own values, with the legacy app-wide ones copied in where it has none.
fn migrated(store: &Store, app: &Json) -> Result<Own, String> {
    let mut own = own(store);
    let before = own.clone();
    if own.find_pdf_on_add.is_none() {
        own.find_pdf_on_add = Some(app.get("findPdfOnAdd").and_then(Json::as_bool).unwrap_or(false));
    }
    if own.add_from_source.is_none() {
        own.add_from_source = Some(text(app.get("addFromSource")).filter(|m| ADD_MODES.contains(&m.as_str())).unwrap_or_else(|| "ask".into()));
    }
    if own != before {
        save(store, &own)?;
    }
    Ok(own)
}

/// The override for citations in this workspace, if it has one.
pub fn citation_override(store: &Store) -> (Option<String>, Option<String>) {
    let own = own(store);
    (own.citation_style, own.citation_locale)
}

fn resolved(store: &Store) -> Result<Json, String> {
    let app = app_file();
    let own = migrated(store, &app)?;
    let app_style = text(app.get("citationStyle")).unwrap_or_else(|| key_cite::DEFAULT_STYLE.into());
    let app_locale = text(app.get("citationLocale")).unwrap_or_else(|| "en-US".into());
    let app_lookups = app.get("openalex").and_then(Json::as_bool).unwrap_or(true);
    Ok(json!({
        "own": own,
        "app": { "citationStyle": app_style, "citationLocale": app_locale, "lookups": app_lookups },
        "effective": {
            "citationStyle": own.citation_style.clone().unwrap_or(app_style),
            "citationLocale": own.citation_locale.clone().unwrap_or(app_locale),
            "lookups": own.lookups.unwrap_or(app_lookups),
            "findPdfOnAdd": own.find_pdf_on_add.unwrap_or(false),
            "addFromSource": own.add_from_source.clone().unwrap_or_else(|| "ask".into()),
            "battery": own.battery.clone().unwrap_or_else(|| "low".into()),
        },
    }))
}

/// Applies `patch` (a field set to null goes back to the app default).
fn update(store: &Store, patch: &Json) -> Result<Own, String> {
    let mut own = migrated(store, &app_file())?;
    let Some(fields) = patch.as_object() else { return Err("Give the settings to change".into()) };
    for (key, value) in fields {
        match key.as_str() {
            "citationStyle" => {
                own.citation_style = text(Some(value));
                if own.citation_style.as_ref().is_some_and(|s| s.len() > 200 || !s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))) {
                    return Err("Choose a citation style".into());
                }
            }
            "citationLocale" => {
                own.citation_locale = text(Some(value));
                if own.citation_locale.as_ref().is_some_and(|s| s.len() > 20 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')) {
                    return Err("Choose a citation language".into());
                }
            }
            "lookups" => own.lookups = value.as_bool(),
            "findPdfOnAdd" => own.find_pdf_on_add = Some(value.as_bool().unwrap_or(false)),
            "addFromSource" => {
                let mode = text(Some(value)).unwrap_or_else(|| "ask".into());
                if !ADD_MODES.contains(&mode.as_str()) {
                    return Err("Choose where added works go".into());
                }
                own.add_from_source = Some(mode);
            }
            "battery" => {
                let mode = text(Some(value));
                if mode.as_ref().is_some_and(|m| !super::power::MODES.contains(&m.as_str())) {
                    return Err("Choose when indexing pauses on battery".into());
                }
                own.battery = mode;
            }
            _ => return Err(format!("Unknown workspace setting {key}")),
        }
    }
    save(store, &own)?;
    Ok(own)
}

pub fn dispatch(library: &Library, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let result = match command {
        // { patch?: { citationStyle?, citationLocale?, lookups?, findPdfOnAdd?, addFromSource? } }
        // -> { own, app, effective }. Null in a patch goes back to the app default.
        "store_workspace_settings" => (|| {
            if let Some(patch) = arg::<Option<Json>>(args, "patch")? {
                let own = update(&library.store, &patch)?;
                library.openalex.set_own_auto(own.lookups);
                super::power::apply(library);
            }
            json_output(resolved(&library.store)?)
        })(),
        _ => return None,
    };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }

    #[test]
    fn legacy_app_values_are_copied_in_once() {
        let (_dir, store) = store();
        let app = json!({ "findPdfOnAdd": true, "addFromSource": "library" });
        let own = migrated(&store, &app).unwrap();
        assert_eq!(own.find_pdf_on_add, Some(true));
        assert_eq!(own.add_from_source.as_deref(), Some("library"));
        // A later app value does not change what the workspace now holds.
        let own = migrated(&store, &json!({ "findPdfOnAdd": false })).unwrap();
        assert_eq!(own.find_pdf_on_add, Some(true));
    }

    #[test]
    fn null_goes_back_to_the_app_default() {
        let (_dir, store) = store();
        update(&store, &json!({ "citationStyle": "chicago-author-date", "lookups": false })).unwrap();
        assert_eq!(citation_override(&store).0.as_deref(), Some("chicago-author-date"));
        let own = update(&store, &json!({ "citationStyle": null, "lookups": null })).unwrap();
        assert_eq!(own.citation_style, None);
        assert_eq!(own.lookups, None);
        assert!(update(&store, &json!({ "addFromSource": "elsewhere" })).is_err());
        assert!(update(&store, &json!({ "theme": "dark" })).is_err());
    }
}
