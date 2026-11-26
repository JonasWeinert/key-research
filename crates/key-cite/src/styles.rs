//! The styles Key knows: the bundled set (CSL repository files, kept as data) and the ones a
//! user installs (`.csl` files in an app-level folder). Locales are all bundled.
use crate::bundled;
use citationberg::{CitationFormat, IndependentStyle, InfoLinkRel, Locale, LocaleCode, LocaleFile, Style, StyleCategory, StyleClass};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

/// What the style picker shows for a style.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleSummary {
    /// The short id: the last segment of the style's CSL id, e.g. `apa`.
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_title: Option<String>,
    /// `author-date`, `numeric`, `note`, `label` or `author`.
    pub format: String,
    /// `in-text` or `note`.
    pub class: String,
    /// Shipped with Key (cannot be removed).
    pub bundled: bool,
    /// For a dependent style, the style it renders with.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub fields: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_locale: Option<String>,
}

/// The last path segment of a CSL style id or URL.
pub fn short_id(id: &str) -> String {
    id.trim().trim_end_matches('/').rsplit('/').next().unwrap_or(id).trim_end_matches(".csl").to_string()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') && !id.starts_with('.')
}

fn summarize(style: &Style, bundled: bool) -> StyleSummary {
    let (info, default_locale, parent) = match style {
        Style::Independent(s) => (&s.info, s.default_locale.as_ref(), None),
        Style::Dependent(d) => (
            &d.info,
            d.default_locale.as_ref(),
            d.info.link.iter().find(|l| l.rel == InfoLinkRel::IndependentParent).map(|l| short_id(&l.href)),
        ),
    };
    let format = info.category.iter().find_map(|c| match c {
        StyleCategory::CitationFormat { format } => Some(match format {
            CitationFormat::AuthorDate => "author-date",
            CitationFormat::Author => "author",
            CitationFormat::Numeric => "numeric",
            CitationFormat::Label => "label",
            CitationFormat::Note => "note",
        }),
        _ => None,
    });
    let class = match style {
        Style::Independent(s) if s.settings.class == StyleClass::Note => "note",
        _ if format == Some("note") => "note",
        _ => "in-text",
    };
    let fields = info
        .category
        .iter()
        .filter_map(|c| match c {
            StyleCategory::Field { field } => serde_json::to_value(field).ok().and_then(|v| v.as_str().map(String::from)),
            _ => None,
        })
        .collect();
    StyleSummary {
        id: short_id(&info.id),
        title: info.title.value.trim().to_string(),
        short_title: info.title_short.as_ref().map(|t| t.value.trim().to_string()).filter(|t| !t.is_empty()),
        format: format.unwrap_or(if class == "note" { "note" } else { "author-date" }).to_string(),
        class: class.to_string(),
        bundled,
        parent,
        fields,
        default_locale: default_locale.map(|l| l.0.clone()),
    }
}

/// Every bundled locale, parsed once.
pub fn locales() -> &'static [Locale] {
    static LOCALES: OnceLock<Vec<Locale>> = OnceLock::new();
    LOCALES.get_or_init(|| bundled::LOCALES.iter().filter_map(|(_, xml)| LocaleFile::from_xml(xml).ok().map(Locale::from)).collect())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleSummary {
    pub code: String,
    /// The language's own name for itself, when the locale file has one.
    pub name: String,
}

/// The bundled locale codes with display names (English names; Key's UI is English).
pub fn locale_list() -> Vec<LocaleSummary> {
    bundled::LOCALES.iter().map(|(code, _)| LocaleSummary { code: code.to_string(), name: locale_name(code) }).collect()
}

fn locale_name(code: &str) -> String {
    let (lang, region) = code.split_once('-').unwrap_or((code, ""));
    let language = match lang {
        "af" => "Afrikaans", "ar" => "Arabic", "bal" => "Balochi", "bg" => "Bulgarian", "brh" => "Brahui", "ca" => "Catalan",
        "cs" => "Czech", "cy" => "Welsh", "da" => "Danish", "de" => "German", "el" => "Greek", "en" => "English",
        "es" => "Spanish", "et" => "Estonian", "eu" => "Basque", "fa" => "Persian", "fi" => "Finnish", "fr" => "French",
        "gl" => "Galician", "he" => "Hebrew", "hi" => "Hindi", "hr" => "Croatian", "hu" => "Hungarian", "hy" => "Armenian",
        "id" => "Indonesian", "is" => "Icelandic", "it" => "Italian", "ja" => "Japanese", "km" => "Khmer", "ko" => "Korean",
        "la" => "Latin", "lij" => "Ligurian", "lt" => "Lithuanian", "lv" => "Latvian", "mn" => "Mongolian", "ms" => "Malay",
        "nb" => "Norwegian Bokmål", "nl" => "Dutch", "nn" => "Norwegian Nynorsk", "pa" => "Punjabi", "pl" => "Polish",
        "pt" => "Portuguese", "ro" => "Romanian", "ru" => "Russian", "sk" => "Slovak", "sl" => "Slovenian", "sr" => "Serbian",
        "sv" => "Swedish", "th" => "Thai", "tl" => "Tagalog", "tr" => "Turkish", "uk" => "Ukrainian", "vi" => "Vietnamese",
        "zh" => "Chinese", other => other,
    };
    let region = match region {
        "" => String::new(),
        "US" => " (United States)".into(), "GB" => " (United Kingdom)".into(), "AT" => " (Austria)".into(),
        "CH" => " (Switzerland)".into(), "DE" => " (Germany)".into(), "CL" => " (Chile)".into(), "ES" => " (Spain)".into(),
        "MX" => " (Mexico)".into(), "CA" => " (Canada)".into(), "FR" => " (France)".into(), "BR" => " (Brazil)".into(),
        "PT" => " (Portugal)".into(), "CN" => " (China)".into(), "TW" => " (Taiwan)".into(), "Cyrl-RS" => " (Cyrillic)".into(),
        "Latn-RS" => " (Latin)".into(), "PK" => " (Pakistan)".into(), "AD" => " (Andorra)".into(), "IT" => " (Italy)".into(),
        _ => String::new(),
    };
    format!("{language}{region}")
}

/// The locale codes Key has, for checking a requested one.
pub fn has_locale(code: &str) -> bool {
    bundled::LOCALES.iter().any(|(c, _)| c.eq_ignore_ascii_case(code)) || bundled::LOCALES.iter().any(|(c, _)| c.split('-').next() == Some(code))
}

/// The bundled styles plus those installed in `dir`; parsed styles are cached.
pub struct Styles {
    dir: Option<PathBuf>,
    cache: Mutex<HashMap<String, Arc<IndependentStyle>>>,
}

impl Styles {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self { dir, cache: Mutex::new(HashMap::new()) }
    }

    pub fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    fn installed_xml(&self, id: &str) -> Option<String> {
        if !valid_id(id) {
            return None;
        }
        std::fs::read_to_string(self.dir.as_ref()?.join(format!("{id}.csl"))).ok()
    }

    fn xml(&self, id: &str) -> Option<(String, bool)> {
        if let Some(xml) = self.installed_xml(id) {
            return Some((xml, false));
        }
        bundled::STYLES.iter().find(|(name, _)| *name == id).map(|(_, xml)| (xml.to_string(), true))
    }

    /// Bundled styles first (alphabetical by title), then installed ones; an installed style
    /// with a bundled style's id replaces it.
    pub fn list(&self) -> Vec<StyleSummary> {
        // The bundled set never changes: summarized once.
        static BUNDLED: OnceLock<Vec<StyleSummary>> = OnceLock::new();
        let bundled = BUNDLED.get_or_init(|| bundled::STYLES.iter().filter_map(|(_, xml)| Style::from_xml(xml).ok().map(|s| summarize(&s, true))).collect());
        let installed = self.installed();
        let mut out: Vec<StyleSummary> = bundled.iter().filter(|b| !installed.iter().any(|s| s.id == b.id)).cloned().collect();
        out.extend(installed);
        out.sort_by(|a, b| b.bundled.cmp(&a.bundled).then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase())));
        out
    }

    fn installed(&self) -> Vec<StyleSummary> {
        let Some(dir) = &self.dir else { return vec![] };
        let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
        entries
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "csl"))
            .filter_map(|e| std::fs::read_to_string(e.path()).ok())
            .filter_map(|xml| Style::from_xml(&xml).ok().map(|s| summarize(&s, false)))
            .collect()
    }

    pub fn summary(&self, id: &str) -> Option<StyleSummary> {
        let (xml, bundled) = self.xml(id)?;
        Style::from_xml(&xml).ok().map(|s| summarize(&s, bundled))
    }

    /// The style to render with: an independent style, or a dependent one's parent with the
    /// dependent's default locale.
    pub fn style(&self, id: &str) -> Result<Arc<IndependentStyle>, String> {
        let id = short_id(id);
        if let Some(style) = self.cache.lock().map_err(|e| e.to_string())?.get(&id) {
            return Ok(style.clone());
        }
        let (xml, _) = self.xml(&id).ok_or_else(|| format!("No citation style named “{id}”"))?;
        let style = match Style::from_xml(&xml).map_err(|e| format!("The style “{id}” could not be read: {e}"))? {
            Style::Independent(style) => style,
            Style::Dependent(dependent) => {
                let parent = dependent
                    .info
                    .link
                    .iter()
                    .find(|l| l.rel == InfoLinkRel::IndependentParent)
                    .map(|l| short_id(&l.href))
                    .ok_or("This dependent style names no parent style")?;
                if parent == id {
                    return Err("This style names itself as its parent".into());
                }
                let mut style = (*self.style(&parent).map_err(|_| format!("This style is based on “{parent}”, which is not installed"))?).clone();
                if dependent.default_locale.is_some() {
                    style.default_locale = dependent.default_locale.clone();
                }
                style.info.title = dependent.info.title.clone();
                style
            }
        };
        let style = Arc::new(style);
        self.cache.lock().map_err(|e| e.to_string())?.insert(id, style.clone());
        Ok(style)
    }

    /// Checks and saves a `.csl` file; answers what it installed. A dependent style needs its
    /// parent to be bundled or installed first.
    pub fn install(&self, xml: &str) -> Result<StyleSummary, String> {
        let dir = self.dir.as_ref().ok_or("There is no folder for installed styles")?;
        if xml.len() > 2 * 1024 * 1024 {
            return Err("That file is too large to be a citation style".into());
        }
        let style = Style::from_xml(xml).map_err(|e| format!("This is not a CSL style: {e}"))?;
        let summary = summarize(&style, false);
        if !valid_id(&summary.id) {
            return Err("The style's id cannot be used as a file name".into());
        }
        if let Some(parent) = &summary.parent {
            if self.xml(parent).is_none() {
                return Err(format!("This style is based on “{parent}”; install that style first"));
            }
        }
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{}.csl", summary.id));
        let temporary = dir.join(format!(".{}.csl.tmp", summary.id));
        std::fs::write(&temporary, xml).map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
        self.cache.lock().map_err(|e| e.to_string())?.clear();
        // Render once so a style the engine cannot use is refused here, not later.
        if let Err(error) = self.style(&summary.id).and_then(|style| crate::render::check(&style)) {
            let _ = std::fs::remove_file(&path);
            self.cache.lock().map_err(|e| e.to_string())?.clear();
            return Err(error);
        }
        Ok(summary)
    }

    /// Removes an installed style (bundled ones stay).
    pub fn remove(&self, id: &str) -> Result<bool, String> {
        let Some(dir) = &self.dir else { return Ok(false) };
        if !valid_id(id) {
            return Err("Not a style id".into());
        }
        let path = dir.join(format!("{id}.csl"));
        let removed = path.exists();
        if removed {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        self.cache.lock().map_err(|e| e.to_string())?.clear();
        Ok(removed)
    }
}

/// A locale code as the engine wants it.
pub fn locale_code(code: Option<&str>) -> Option<LocaleCode> {
    code.map(str::trim).filter(|c| !c.is_empty()).map(|c| LocaleCode(c.to_string()))
}
