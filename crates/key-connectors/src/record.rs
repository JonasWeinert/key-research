// Key's normalised work record, as every connector's extraction produces it.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Record {
    pub source_id: String,
    pub title: String,
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(rename = "abstract", skip_serializing_if = "Option::is_none")]
    pub abstract_: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pmid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pmcid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openalex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isbn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_url: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub extras: BTreeMap<String, String>,
}

impl Record {
    fn slot(&mut self, field: &str) -> Option<&mut Option<String>> {
        Some(match field {
            "date" => &mut self.date,
            "venue" => &mut self.venue,
            "series" => &mut self.series,
            "number" => &mut self.number,
            "publisher" => &mut self.publisher,
            "abstract" => &mut self.abstract_,
            "doi" => &mut self.doi,
            "pmid" => &mut self.pmid,
            "pmcid" => &mut self.pmcid,
            "arxiv" => &mut self.arxiv,
            "openalex" => &mut self.openalex,
            "handle" => &mut self.handle,
            "isbn" => &mut self.isbn,
            "issn" => &mut self.issn,
            "url" => &mut self.url,
            "pdfUrl" => &mut self.pdf_url,
            "type" => &mut self.kind,
            "language" => &mut self.language,
            _ => return None,
        })
    }

    /// Sets a field from extracted values (lists keep all; others the first).
    pub fn set(&mut self, field: &str, values: Vec<String>) {
        let first = values.first().cloned();
        match field {
            "sourceId" => self.source_id = first.unwrap_or_default(),
            "title" => self.title = first.unwrap_or_default(),
            "authors" => self.authors = values,
            "keywords" => self.keywords = values,
            "year" => self.year = first.and_then(|y| y.parse().ok()),
            _ => {
                if let Some(slot) = self.slot(field) {
                    *slot = first;
                }
            }
        }
    }

    /// A field as text ("" when empty), lists joined.
    pub fn get(&self, field: &str) -> String {
        match field {
            "sourceId" => self.source_id.clone(),
            "title" => self.title.clone(),
            "authors" => self.authors.join("; "),
            "keywords" => self.keywords.join("; "),
            "year" => self.year.map(|y| y.to_string()).unwrap_or_default(),
            _ => {
                let mut copy = self.clone();
                copy.slot(field).and_then(|s| s.clone()).unwrap_or_default()
            }
        }
    }

    pub fn is_empty_field(&self, field: &str) -> bool {
        self.get(field).trim().is_empty()
    }

    /// Fills this record's empty fields (and replaces shorter abstracts) from another reading
    /// of the same work (a per-record detail page).
    pub fn merge_from(&mut self, other: &Record) {
        for field in crate::spec::RECORD_FIELDS {
            if *field == "extras" || *field == "sourceId" {
                continue;
            }
            let theirs = other.get(field);
            if theirs.trim().is_empty() {
                continue;
            }
            let longer = *field == "abstract" && theirs.len() > self.get(field).len();
            if self.is_empty_field(field) || longer {
                match *field {
                    "authors" => self.authors = other.authors.clone(),
                    "keywords" => self.keywords = other.keywords.clone(),
                    "year" => self.year = other.year,
                    f => self.set(f, vec![theirs]),
                }
            }
        }
        for (k, v) in &other.extras {
            self.extras.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }

    /// The record as a library work (key-store's duplicate matcher).
    pub fn work(&self) -> key_store::duplicates::Work {
        key_store::duplicates::Work {
            title: Some(self.title.clone()).filter(|t| !t.is_empty()),
            year: self.year,
            item_type: self.kind.as_deref().map(item_type),
            doi: self.doi.clone(),
            isbn: self.isbn.clone(),
            pmid: self.pmid.clone(),
            pmcid: self.pmcid.clone(),
            arxiv_id: self.arxiv.clone(),
            container_title: self.venue.clone(),
            work_type: self.kind.clone(),
            first_author: self.authors.first().map(|a| a.split(',').next().unwrap_or(a).trim().to_string()),
            ..Default::default()
        }
    }
}

/// The library item type for a record type.
pub fn item_type(kind: &str) -> String {
    match kind {
        "article" => "journalArticle",
        "preprint" => "preprint",
        "working-paper" | "report" => "report",
        "book" => "book",
        "chapter" => "bookSection",
        "dataset" => "dataset",
        "thesis" => "thesis",
        "trial" => "document",
        _ => "document",
    }
    .into()
}
