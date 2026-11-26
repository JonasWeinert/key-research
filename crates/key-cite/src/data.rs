//! The CSL styles and locales Key ships (CC BY-SA 3.0) live outside the binary, as unmodified
//! data files in a folder (`styles/*.csl`, `locales/locales-*.xml`, `index.json`, `NOTICE`):
//! the app's resources when packaged, `data/citation` in the repository otherwise. The host
//! is told the folder in KEY_CITATION_DATA_DIR. `index.json` lists the styles so the picker
//! needs no parsing; a style or locale file is read the first time it is used. Without the
//! folder Key falls back to a small author–date style and English terms of its own.
use crate::styles::{StyleSummary, summarize};
use citationberg::{Locale, LocaleCode, LocaleFile, Style};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

/// The style used when the data folder is missing.
pub const FALLBACK_STYLE: &str = "key-author-date";
const FALLBACK_STYLE_XML: &str = include_str!("fallback/key-author-date.csl");
const FALLBACK_LOCALE_XML: &str = include_str!("fallback/en-US.xml");
pub const INDEX_FILE: &str = "index.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Index {
    pub styles: Vec<IndexStyle>,
    pub locales: Vec<IndexLocale>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct IndexStyle {
    /// The file in `styles/`.
    pub file: String,
    #[serde(flatten)]
    pub summary: StyleSummary,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct IndexLocale {
    pub code: String,
    /// The file in `locales/`.
    pub file: String,
}

/// Whether the shipped styles were found, for Settings.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub styles: usize,
    pub locales: usize,
}

fn safe_file(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Builds the index from the files in `dir` (what `index.json` must contain).
pub fn build_index(dir: &Path) -> Result<Index, String> {
    let list = |sub: &str, ext: &str| -> Result<Vec<String>, String> {
        let mut names: Vec<String> = std::fs::read_dir(dir.join(sub))
            .map_err(|e| format!("{}: {e}", dir.join(sub).display()))?
            .filter_map(Result::ok)
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(ext) && safe_file(n))
            .collect();
        names.sort();
        Ok(names)
    };
    let mut styles = Vec::new();
    for file in list("styles", ".csl")? {
        let xml = std::fs::read_to_string(dir.join("styles").join(&file)).map_err(|e| format!("{file}: {e}"))?;
        let style = Style::from_xml(&xml).map_err(|e| format!("{file}: {e}"))?;
        styles.push(IndexStyle { file, summary: summarize(&style, true) });
    }
    let locales = list("locales", ".xml")?
        .into_iter()
        .filter_map(|file| Some(IndexLocale { code: file.strip_prefix("locales-")?.strip_suffix(".xml")?.to_string(), file }))
        .collect();
    Ok(Index { styles, locales })
}

/// The index as it is written to `index.json`.
pub fn index_json(index: &Index) -> String {
    serde_json::to_string_pretty(index).unwrap_or_default() + "\n"
}

/// One data folder: its index, and the locales read from it so far.
pub struct CitationData {
    dir: Option<PathBuf>,
    index: Result<Index, String>,
    locales: Mutex<HashMap<String, Arc<Vec<Locale>>>>,
}

impl CitationData {
    pub fn open(dir: Option<PathBuf>) -> Self {
        let index = match &dir {
            None => Err("No folder for citation styles was given".to_string()),
            Some(dir) => std::fs::read(dir.join(INDEX_FILE))
                .map_err(|_| format!("Citation styles not found in {}", dir.display()))
                .and_then(|bytes| serde_json::from_slice::<Index>(&bytes).map_err(|e| format!("The citation style list could not be read: {e}"))),
        };
        Self { dir, index, locales: Mutex::new(HashMap::new()) }
    }

    /// The folder in KEY_CITATION_DATA_DIR (debug builds fall back to the repository's).
    pub fn global() -> Arc<CitationData> {
        static DATA: OnceLock<Arc<CitationData>> = OnceLock::new();
        DATA.get_or_init(|| {
            let dir = std::env::var_os("KEY_CITATION_DATA_DIR").filter(|d| !d.is_empty()).map(PathBuf::from).or_else(|| {
                cfg!(debug_assertions).then(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../data/citation")))
            });
            Arc::new(CitationData::open(dir))
        })
        .clone()
    }

    pub fn available(&self) -> bool {
        self.index.is_ok()
    }

    pub fn status(&self) -> DataStatus {
        DataStatus {
            available: self.available(),
            dir: self.dir.clone(),
            error: self.index.as_ref().err().cloned(),
            styles: self.index.as_ref().map_or(0, |i| i.styles.len()),
            locales: self.index.as_ref().map_or(0, |i| i.locales.len()),
        }
    }

    /// The shipped styles, or the fallback alone when they are missing.
    pub fn style_summaries(&self) -> Vec<StyleSummary> {
        match &self.index {
            Ok(index) => index.styles.iter().map(|s| s.summary.clone()).collect(),
            Err(_) => fallback_summary().into_iter().collect(),
        }
    }

    pub fn style_summary(&self, id: &str) -> Option<StyleSummary> {
        if id == FALLBACK_STYLE {
            return fallback_summary();
        }
        self.index.as_ref().ok()?.styles.iter().find(|s| s.summary.id == id).map(|s| s.summary.clone())
    }

    /// A shipped style's file contents.
    pub fn style_xml(&self, id: &str) -> Option<String> {
        if id == FALLBACK_STYLE {
            return Some(FALLBACK_STYLE_XML.to_string());
        }
        let entry = self.index.as_ref().ok()?.styles.iter().find(|s| s.summary.id == id)?;
        if !safe_file(&entry.file) {
            return None;
        }
        std::fs::read_to_string(self.dir.as_ref()?.join("styles").join(&entry.file)).ok()
    }

    /// The locale codes Key has.
    pub fn locale_codes(&self) -> Vec<String> {
        match &self.index {
            Ok(index) => index.locales.iter().map(|l| l.code.clone()).collect(),
            Err(_) => vec!["en-US".into()],
        }
    }

    /// One locale file, parsed.
    pub fn locale(&self, code: &str) -> Option<Locale> {
        let entry = self.index.as_ref().ok()?.locales.iter().find(|l| l.code.eq_ignore_ascii_case(code))?;
        if !safe_file(&entry.file) {
            return None;
        }
        let xml = std::fs::read_to_string(self.dir.as_ref()?.join("locales").join(&entry.file)).ok()?;
        LocaleFile::from_xml(&xml).ok().map(Locale::from)
    }

    /// The locales the engine consults for `code`: it, its language's primary dialect and
    /// en-US (the engine's own fallback order), read once per code.
    pub fn locales_for(&self, code: &LocaleCode) -> Arc<Vec<Locale>> {
        if let Some(found) = self.locales.lock().ok().and_then(|m| m.get(&code.0).cloned()) {
            return found;
        }
        let mut wanted = vec![code.clone()];
        wanted.extend(code.fallback());
        wanted.push(LocaleCode::en_us());
        wanted.dedup();
        let mut out: Vec<Locale> = Vec::new();
        for c in &wanted {
            if out.iter().any(|l| l.lang.as_ref() == Some(c)) {
                continue;
            }
            if let Some(locale) = self.locale(&c.0) {
                out.push(locale);
            }
        }
        if !out.iter().any(|l| l.lang == Some(LocaleCode::en_us())) {
            out.extend(LocaleFile::from_xml(FALLBACK_LOCALE_XML).ok().map(Locale::from));
        }
        let out = Arc::new(out);
        if let Ok(mut map) = self.locales.lock() {
            map.insert(code.0.clone(), out.clone());
        }
        out
    }
}

fn fallback_summary() -> Option<StyleSummary> {
    Style::from_xml(FALLBACK_STYLE_XML).ok().map(|s| summarize(&s, true))
}
