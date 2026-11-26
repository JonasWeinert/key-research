// Bibliographic import and export for the Key library. Each format reads into `Record`s
// (a source as key-store takes it, plus its notes, files and groups) through a declarative
// field map; values with no column are kept as namespaced custom properties
// (`bibtex.howpublished`, `ris.M3`, `csl.event-place`) so nothing is lost and an export to
// the same format writes them back. Writers take key-store sources.
pub mod autoexport;
pub mod bibtex;
pub mod csl;
pub mod csv;
pub mod endnote;
pub mod export;
pub mod fields;
pub mod file_mirror;
pub mod filenames;
pub mod import;
pub mod latex;
pub mod md_export;
pub mod md_region;
pub mod template;
pub mod names;
pub mod ris;

use key_store::SourceInput;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Format {
    Bibtex,
    Biblatex,
    Ris,
    CslJson,
    Csv,
    Tsv,
    EndnoteXml,
}

impl Format {
    pub fn label(self) -> &'static str {
        match self {
            Format::Bibtex => "BibTeX",
            Format::Biblatex => "BibLaTeX",
            Format::Ris => "RIS",
            Format::CslJson => "CSL-JSON",
            Format::Csv => "CSV",
            Format::Tsv => "TSV",
            Format::EndnoteXml => "EndNote XML",
        }
    }
    pub fn extension(self) -> &'static str {
        match self {
            Format::Bibtex | Format::Biblatex => "bib",
            Format::Ris => "ris",
            Format::CslJson => "json",
            Format::Csv => "csv",
            Format::Tsv => "tsv",
            Format::EndnoteXml => "xml",
        }
    }
}

/// One entry read from a file.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// Where the entry starts (1-based; 0 when the format has no lines).
    pub line: usize,
    pub source: SourceInput,
    /// Child notes (plain text or Markdown).
    pub notes: Vec<String>,
    /// Attached files as the entry names them (paths or URLs).
    pub files: Vec<String>,
    /// Collections the entry belongs to, each as a path from the top.
    pub groups: Vec<Vec<String>>,
}

impl Record {
    pub fn title(&self) -> &str {
        fields::text(&self.source.fields, "title").unwrap_or("")
    }
    pub fn citation_key(&self) -> Option<&str> {
        fields::text(&self.source.fields, "citationKey")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub line: usize,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Parsed {
    pub format: Format,
    pub records: Vec<Record>,
    pub warnings: Vec<Warning>,
}

/// The format of `text`, from the file name when it tells, else from the content.
pub fn detect(text: &str, file_name: Option<&str>) -> Option<Format> {
    let lower = file_name.map(str::to_ascii_lowercase).unwrap_or_default();
    let by_name = match lower.rsplit('.').next() {
        Some("bib" | "bibtex") if !lower.is_empty() => Some(Format::Bibtex),
        Some("ris") => Some(Format::Ris),
        Some("csv") => Some(Format::Csv),
        Some("tsv" | "tab") => Some(Format::Tsv),
        _ => None,
    };
    if by_name.is_some() {
        return by_name;
    }
    let head = text.trim_start_matches('\u{feff}').trim_start();
    if head.starts_with('[') || head.starts_with('{') {
        return Some(Format::CslJson);
    }
    if head.starts_with('<') {
        let sample: String = head.chars().take(4000).collect::<String>().to_ascii_lowercase();
        if sample.contains("<records") || sample.contains("<record>") || sample.contains("<xml") {
            return Some(Format::EndnoteXml);
        }
        return None;
    }
    if head.lines().take(50).any(|l| ris::tag_line(l).is_some_and(|(tag, _)| tag == "TY")) {
        return Some(Format::Ris);
    }
    if bibtex::looks_like(head) {
        return Some(Format::Bibtex);
    }
    let first = head.lines().next().unwrap_or("");
    if first.contains('\t') {
        return Some(Format::Tsv);
    }
    if first.contains(',') && first.to_ascii_lowercase().contains("title") {
        return Some(Format::Csv);
    }
    None
}

/// Reads `text` in `format`; `progress(done, total)` is called as entries are read.
pub fn parse(text: &str, format: Format, progress: &dyn Fn(usize, usize)) -> Result<Parsed, String> {
    let text = text.trim_start_matches('\u{feff}');
    let (records, warnings) = match format {
        Format::Bibtex | Format::Biblatex => bibtex::parse(text, progress),
        Format::Ris => ris::parse(text, progress),
        Format::CslJson => csl::parse(text)?,
        Format::Csv => csv::parse(text, ',', None)?,
        Format::Tsv => csv::parse(text, '\t', None)?,
        Format::EndnoteXml => endnote::parse(text)?,
    };
    Ok(Parsed { format, records, warnings })
}
