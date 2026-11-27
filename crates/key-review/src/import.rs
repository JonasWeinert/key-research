// Records in: files (RIS, BibTeX, EndNote XML, CSV/TSV, CSL-JSON through key-biblio; PubMed
// MEDLINE/.nbib here), library sources, and database search results; then de-duplication against
// what the review already has with the library's duplicate matcher (key_store::duplicates).
use crate::events::uuid7;
use crate::model::RecordMeta;
use key_store::duplicates::{MatchKind, Work, WorkIndex};
use key_store::{Creator, Source, SourceInput};
use serde_json::{Map, Value as Json};

#[derive(Debug)]
pub struct ParsedFile {
    pub format: String,
    pub records: Vec<RecordMeta>,
    pub warnings: Vec<String>,
}

fn creator_name(c: &Creator) -> Option<String> {
    if let Some(l) = c.literal.as_deref().filter(|l| !l.trim().is_empty()) {
        return Some(l.trim().to_string());
    }
    match (c.family.as_deref(), c.given.as_deref()) {
        (Some(f), Some(g)) if !g.trim().is_empty() => Some(format!("{}, {}", f.trim(), g.trim())),
        (Some(f), _) if !f.trim().is_empty() => Some(f.trim().to_string()),
        _ => None,
    }
}

fn text(fields: &Map<String, Json>, name: &str) -> String {
    fields.get(name).and_then(Json::as_str).map(str::trim).unwrap_or("").to_string()
}

fn year(fields: &Map<String, Json>) -> Option<i64> {
    fields.get("year").and_then(|y| y.as_i64().or_else(|| y.as_str().and_then(|s| s.trim().get(..4)?.parse().ok()))).or_else(|| {
        let date = text(fields, "date");
        date.split(|c: char| !c.is_ascii_digit()).find(|p| p.len() == 4).and_then(|p| p.parse().ok())
    })
}

fn from_fields(fields: &Map<String, Json>, creators: &[Creator], tags: &[String]) -> RecordMeta {
    let mut extra = Map::new();
    for key in ["issn", "isbn", "publisher", "pmcid", "arxivId"] {
        let v = text(fields, key);
        if !v.is_empty() {
            extra.insert(key.into(), Json::from(v));
        }
    }
    RecordMeta {
        id: uuid7(),
        title: text(fields, "title"),
        abstract_text: text(fields, "abstract"),
        authors: creators.iter().filter(|c| c.role.is_empty() || c.role == "author").filter_map(creator_name).collect(),
        year: year(fields),
        journal: text(fields, "containerTitle"),
        volume: text(fields, "volume"),
        issue: text(fields, "issue"),
        pages: text(fields, "pages"),
        doi: text(fields, "doi"),
        pmid: text(fields, "pmid"),
        url: text(fields, "url"),
        item_type: text(fields, "itemType"),
        language: text(fields, "language"),
        keywords: tags.to_vec(),
        source_id: None,
        extra,
    }
}

pub fn from_input(input: &SourceInput) -> RecordMeta {
    from_fields(&input.fields, &input.creators, &input.tags)
}

/// A library source as a review record, linked to it.
pub fn from_source(source: &Source) -> RecordMeta {
    let mut meta = from_fields(&source.fields, &source.creators, &source.tags);
    meta.source_id = Some(source.id.clone());
    meta
}

/// Detects the format and reads the records.
pub fn parse_file(content: &str, file_name: Option<&str>) -> Result<ParsedFile, String> {
    let lower = file_name.unwrap_or("").to_ascii_lowercase();
    let head = content.trim_start_matches('\u{feff}').trim_start();
    if lower.ends_with(".nbib") || lower.ends_with(".medline") || head.starts_with("PMID-") || head.starts_with("PMID -") {
        let records = parse_medline(content);
        if records.is_empty() {
            return Err("No PubMed records found in this file".into());
        }
        return Ok(ParsedFile { format: "PubMed (MEDLINE)".into(), records, warnings: Vec::new() });
    }
    let format = key_biblio::detect(content, file_name).ok_or("Key cannot tell this file's format. Use RIS, BibTeX, EndNote XML, PubMed (.nbib) or CSV.")?;
    let parsed = key_biblio::parse(content, format, &|_, _| {})?;
    let records: Vec<RecordMeta> = parsed.records.iter().map(|r| from_input(&r.source)).collect();
    if records.is_empty() {
        return Err(format!("No records found in this {} file", format.label()));
    }
    Ok(ParsedFile { format: format.label().into(), records, warnings: parsed.warnings.iter().map(|w| format!("Line {}: {}", w.line, w.message)).collect() })
}

/// PubMed's MEDLINE format (.nbib, "Send to: Citation manager"): "TAG - value" lines, values
/// continued on lines indented by six spaces, records separated by blank lines.
pub fn parse_medline(content: &str) -> Vec<RecordMeta> {
    let mut out = Vec::new();
    let mut fields: Vec<(String, String)> = Vec::new();
    let flush = |fields: &mut Vec<(String, String)>, out: &mut Vec<RecordMeta>| {
        if fields.is_empty() {
            return;
        }
        let get = |tag: &str| fields.iter().find(|(t, _)| t == tag).map(|(_, v)| v.clone()).unwrap_or_default();
        let all = |tag: &str| fields.iter().filter(|(t, _)| t == tag).map(|(_, v)| v.clone()).collect::<Vec<_>>();
        let mut authors = all("FAU");
        if authors.is_empty() {
            authors = all("AU");
        }
        let doi = fields
            .iter()
            .filter(|(t, _)| t == "LID" || t == "AID")
            .find_map(|(_, v)| v.strip_suffix("[doi]").map(|d| d.trim().to_string()))
            .unwrap_or_default();
        let date = get("DP");
        let year = date.split_whitespace().next().and_then(|y| y.get(..4)?.parse().ok());
        let types = all("PT");
        let item_type = if types.iter().any(|t| t.eq_ignore_ascii_case("Journal Article") || t.contains("Trial") || t.contains("Review")) { "journalArticle" } else { "document" };
        let mut extra = Map::new();
        if !types.is_empty() {
            extra.insert("publicationTypes".into(), Json::from(types.clone()));
        }
        let pmc = get("PMC");
        if !pmc.is_empty() {
            extra.insert("pmcid".into(), Json::from(pmc));
        }
        let mut keywords = all("MH");
        keywords.extend(all("OT"));
        let pmid = get("PMID");
        out.push(RecordMeta {
            id: uuid7(),
            title: get("TI"),
            abstract_text: get("AB"),
            authors,
            year,
            journal: if get("JT").is_empty() { get("TA") } else { get("JT") },
            volume: get("VI"),
            issue: get("IP"),
            pages: get("PG"),
            url: if pmid.is_empty() { String::new() } else { format!("https://pubmed.ncbi.nlm.nih.gov/{pmid}/") },
            doi,
            pmid,
            item_type: item_type.into(),
            language: get("LA"),
            keywords,
            source_id: None,
            extra,
        });
        fields.clear();
    };
    for line in content.trim_start_matches('\u{feff}').lines() {
        if line.trim().is_empty() {
            flush(&mut fields, &mut out);
            continue;
        }
        if line.starts_with("      ") {
            if let Some((_, v)) = fields.last_mut() {
                v.push(' ');
                v.push_str(line.trim());
            }
            continue;
        }
        if line.len() >= 5 && line.as_bytes().get(4) == Some(&b'-') {
            let tag = line[..4].trim().to_string();
            let value = line[5..].trim().to_string();
            if tag == "PMID" && !fields.is_empty() {
                flush(&mut fields, &mut out);
            }
            fields.push((tag, value));
        }
    }
    flush(&mut fields, &mut out);
    out
}

/// The duplicate matcher's view of a record.
pub fn work(meta: &RecordMeta) -> Work {
    let first = meta.authors.first().map(|a| a.split(',').next().unwrap_or(a).trim().to_string());
    Work {
        id: Some(meta.id.clone()),
        title: (!meta.title.is_empty()).then(|| meta.title.clone()),
        year: meta.year,
        item_type: (!meta.item_type.is_empty()).then(|| meta.item_type.clone()),
        doi: (!meta.doi.is_empty()).then(|| meta.doi.clone()),
        pmid: (!meta.pmid.is_empty()).then(|| meta.pmid.clone()),
        pmcid: meta.extra.get("pmcid").and_then(Json::as_str).map(str::to_string),
        arxiv_id: meta.extra.get("arxivId").and_then(Json::as_str).map(str::to_string),
        container_title: (!meta.journal.is_empty()).then(|| meta.journal.clone()),
        first_author: first,
        ..Default::default()
    }
}

/// What de-duplication found for new records.
#[derive(Debug, Default)]
pub struct DedupOutcome {
    /// (record, the record it duplicates) — certain matches (same identifier, or same title,
    /// year and first author): removed and counted.
    pub exact: Vec<(String, String)>,
    /// (a, b, score, reason): likely matches for a person to look at.
    pub likely: Vec<(String, String, f64, String)>,
}

/// Matches `new` against `existing` (records already in the review that are not duplicates)
/// and against each other.
pub fn dedup(existing: &[RecordMeta], new: &[RecordMeta]) -> DedupOutcome {
    let mut index = WorkIndex::default();
    for r in existing {
        index.add(&r.id, &work(r));
    }
    let mut out = DedupOutcome::default();
    for r in new {
        let w = work(r);
        let found = index.find(&w);
        if let Some(best) = found.iter().find(|m| m.kind == MatchKind::Exact && m.source_id != r.id) {
            out.exact.push((r.id.clone(), best.source_id.clone()));
            // A duplicate is not added: later records match the one it duplicates.
            continue;
        }
        for m in found.iter().filter(|m| m.source_id != r.id).take(3) {
            out.likely.push((r.id.clone(), m.source_id.clone(), m.score, m.reason.clone()));
        }
        index.add(&r.id, &w);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const NBIB: &str = "PMID- 10000001\nOWN - NLM\nTI  - A randomised trial of\n      walking in adults.\nLID - 10.1000/example.1 [doi]\nAB  - We studied walking.\nFAU - Smith, Anna\nFAU - Jones, Bo\nLA  - eng\nPT  - Journal Article\nPT  - Randomized Controlled Trial\nDP  - 2019 Mar\nJT  - Journal of Examples\nMH  - Walking\n\nPMID- 10000002\nTI  - Second record.\nDP  - 2001\n";

    #[test]
    fn reads_medline() {
        let r = parse_medline(NBIB);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title, "A randomised trial of walking in adults.");
        assert_eq!(r[0].doi, "10.1000/example.1");
        assert_eq!(r[0].authors, vec!["Smith, Anna", "Jones, Bo"]);
        assert_eq!(r[0].year, Some(2019));
        assert_eq!(r[0].journal, "Journal of Examples");
        assert_eq!(r[1].year, Some(2001));
        assert!(parse_file(NBIB, Some("pubmed.nbib")).unwrap().format.contains("PubMed"));
    }

    #[test]
    fn reads_ris_and_bibtex_through_biblio() {
        let ris = "TY  - JOUR\nTI  - Tea and sleep\nAU  - Doe, Jane\nPY  - 2015\nDO  - 10.1000/tea\nAB  - Short.\nER  - \n";
        let p = parse_file(ris, Some("export.ris")).unwrap();
        assert_eq!(p.records[0].title, "Tea and sleep");
        assert_eq!(p.records[0].year, Some(2015));
        assert_eq!(p.records[0].doi, "10.1000/tea");
        let bib = "@article{doe2015, title={Tea and sleep}, author={Doe, Jane}, year={2015}}";
        assert_eq!(parse_file(bib, Some("x.bib")).unwrap().records.len(), 1);
    }

    #[test]
    fn dedup_finds_exact_and_within_batch() {
        let rec = |title: &str, doi: &str, year: i64| RecordMeta { id: uuid7(), title: title.into(), doi: doi.into(), year: Some(year), authors: vec!["Doe, Jane".into()], ..Default::default() };
        let old = vec![rec("Tea and sleep in adults", "10.1/a", 2015)];
        let new = vec![rec("Tea and sleep in adults", "10.1/a", 2015), rec("Coffee and mood", "", 2018), rec("Coffee and mood", "", 2018)];
        let out = dedup(&old, &new);
        // Same title, year and author without an identifier is "likely": a person confirms it.
        assert_eq!(out.exact.len(), 1, "{out:?}");
        assert_eq!(out.likely.len(), 1);
        assert_eq!(out.exact[0].1, old[0].id);
    }
}
