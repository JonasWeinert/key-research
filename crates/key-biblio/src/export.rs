// Export: a selection, a collection (with its sub-collections) or the whole library, in
// any format, ordered by citation key so a file written again changes only where the
// library did. Quick copy formats (BibTeX, RIS, pandoc `[@key]`, LaTeX `\cite{key}`)
// go through the same writers.
use crate::latex::Encoding;
use crate::{Format, bibtex, csl, csv, ris};
use key_store::{ListQuery, Source, Store};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    pub notes: bool,
    pub abstracts: bool,
    pub files: bool,
    pub keywords: bool,
    /// BibTeX values: Unicode (biber) or LaTeX escapes (classic BibTeX).
    #[serde(with = "encoding_name")]
    pub encoding: Encoding,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self { notes: false, abstracts: true, files: false, keywords: true, encoding: Encoding::Unicode }
    }
}

mod encoding_name {
    use super::Encoding;
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &Encoding, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(match value {
            Encoding::Unicode => "unicode",
            Encoding::Latex => "latex",
        })
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Encoding, D::Error> {
        Ok(if String::deserialize(d)? == "latex" { Encoding::Latex } else { Encoding::Unicode })
    }
}

/// What to export.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Scope {
    pub ids: Option<Vec<String>>,
    pub collection_id: Option<String>,
}

pub struct ExportItem<'a> {
    pub source: &'a Source,
    pub notes: Vec<String>,
    pub key: String,
}

/// The sources of a scope (trashed ones left out).
pub fn sources(store: &Store, scope: &Scope) -> Result<Vec<Source>, String> {
    if let Some(ids) = &scope.ids {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(source) = store.source(id)? {
                out.push(source);
            }
        }
        return Ok(out);
    }
    let mut out = Vec::new();
    let mut offset = 0;
    loop {
        let page = store.list_sources(&ListQuery { collection_id: scope.collection_id.clone(), offset, limit: Some(2000), sort: Some("added".into()), ..Default::default() })?;
        out.extend(page.items);
        match page.next_offset {
            Some(next) => offset = next,
            None => break,
        }
    }
    Ok(out)
}

fn key_of(source: &Source) -> String {
    source.field("citationKey").map(str::to_string).filter(|k| !k.is_empty()).unwrap_or_else(|| source.id.clone())
}

/// Sorted by key, then id, so the order never depends on when a source was read.
fn ordered(sources: &mut [Source]) {
    sources.sort_by(|a, b| key_of(a).to_lowercase().cmp(&key_of(b).to_lowercase()).then_with(|| a.id.cmp(&b.id)));
}

/// Writes `sources` in `format`. Keys come from the store (call `ensure_citation_keys` first).
pub fn write(store: &Store, mut sources: Vec<Source>, format: Format, options: &ExportOptions) -> Result<String, String> {
    ordered(&mut sources);
    let notes = |source: &Source| -> Result<Vec<String>, String> {
        if !options.notes || source.note_count == 0 {
            return Ok(vec![]);
        }
        Ok(store.notes(&source.id)?.into_iter().map(|n| if n.title.trim().is_empty() || n.body.starts_with(n.title.trim()) { n.body } else { format!("{}\n\n{}", n.title.trim(), n.body) }).filter(|b| !b.trim().is_empty()).collect())
    };
    let items = sources.iter().map(|s| Ok(ExportItem { source: s, notes: notes(s)?, key: key_of(s) })).collect::<Result<Vec<_>, String>>()?;
    Ok(write_items(&items, format, options))
}

pub fn write_items(items: &[ExportItem], format: Format, options: &ExportOptions) -> String {
    match format {
        Format::Bibtex | Format::Biblatex => items.iter().map(|i| bibtex::write_entry(i, format == Format::Biblatex, options)).collect::<Vec<_>>().join("\n"),
        Format::Ris => items.iter().map(|i| ris::write_entry(i, options)).collect::<Vec<_>>().join("\n"),
        Format::CslJson => {
            let list: Vec<Json> = items.iter().map(|i| csl::item(i, options)).collect();
            serde_json::to_string_pretty(&list).unwrap_or_default() + "\n"
        }
        Format::Csv | Format::Tsv => {
            let separator = if format == Format::Csv { ',' } else { '\t' };
            let mut out = csv::header(separator, options);
            for item in items {
                out.push_str(&csv::write_row(item, separator, options));
            }
            out
        }
        Format::EndnoteXml => String::new(),
    }
}

pub fn export(store: &Store, scope: &Scope, format: Format, options: &ExportOptions) -> Result<(String, usize), String> {
    if format == Format::EndnoteXml {
        return Err("EndNote XML can be imported but not exported".into());
    }
    store.ensure_citation_keys()?;
    let sources = sources(store, scope)?;
    let count = sources.len();
    Ok((write(store, sources, format, options)?, count))
}

/// Quick copy: `bibtex`, `biblatex`, `ris`, `csl-json`, `pandoc` (`[@a; @b]`) or `latex` (`\cite{a,b}`).
pub fn quick_copy(store: &Store, ids: &[String], format: &str) -> Result<String, String> {
    store.ensure_citation_keys()?;
    let sources = sources(store, &Scope { ids: Some(ids.to_vec()), collection_id: None })?;
    let keys: Vec<String> = sources.iter().map(key_of).collect();
    Ok(match format {
        "pandoc" => format!("[{}]", keys.iter().map(|k| format!("@{k}")).collect::<Vec<_>>().join("; ")),
        "latex" => format!("\\cite{{{}}}", keys.join(",")),
        "keys" => keys.join(", "),
        other => {
            let format: Format = serde_json::from_value(Json::from(other)).map_err(|_| format!("Unknown format “{other}”"))?;
            // Quick copy keeps the order the items were picked in.
            let items: Vec<ExportItem> = sources.iter().map(|s| ExportItem { source: s, notes: vec![], key: key_of(s) }).collect();
            write_items(&items, format, &ExportOptions { abstracts: false, ..Default::default() })
        }
    })
}
