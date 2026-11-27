// Moving an in-progress review into Key: records and screening decisions from a CSV exported by
// Covidence, Rayyan or anything else, with a column mapping the reviewer checks on a preview.
//
// Layouts checked against public documentation and real exports (2026-11-27):
// - Covidence's references export: Title, Authors, Abstract, Published Year, Published Month,
//   Journal, Volume, Issue, Pages, Accession Number, DOI, Ref, Covidence #, Study, Notes, Tags.
//   It has no decision column: the decision is the list that was exported (Covidence's Export >
//   References > stage), so the reviewer says what the file is; excluded lists carry
//   "Exclusion reason: …;" in Notes. Covidence's Extraction 2 export is documented only loosely,
//   so extraction data is not mapped automatically.
// - Rayyan's articles CSV: key, title, year, month, day, journal, issn, volume, issue, pages,
//   authors, url, language, publisher, location, abstract, notes, doi, keywords, pubmed_id,
//   pmc_id; decisions live in notes as `RAYYAN-INCLUSION: {"Name"=>"Included", …}` with
//   `RAYYAN-LABELS: …` and `RAYYAN-EXCLUSION-REASONS: …` blocks joined by " | ".
// Anything else maps by hand.
use crate::model::*;
use crate::store::{Result, Reviews};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

/// One CSV line split on commas only (quotes and doubled quotes).
pub fn csv_fields(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out.into_iter().map(|s| s.trim().to_string()).collect()
}

/// Splits CSV text into rows, keeping quoted line breaks inside a cell.
pub fn csv_rows(text: &str) -> Vec<Vec<String>> {
    let text = text.trim_start_matches('\u{feff}');
    let mut rows = Vec::new();
    let mut cur = String::new();
    let mut quotes = 0usize;
    for l in text.split('\n') {
        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(l.trim_end_matches('\r'));
        quotes += l.matches('"').count();
        if quotes % 2 == 0 {
            if !cur.trim().is_empty() {
                rows.push(csv_fields(&cur));
            }
            cur.clear();
            quotes = 0;
        }
    }
    if !cur.trim().is_empty() {
        rows.push(csv_fields(&cur));
    }
    rows
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Mapping {
    /// Key field → column index (title, authors, year, journal, volume, issue, pages, doi, pmid,
    /// abstract, url, notes, labels, decision, reasons, id).
    pub columns: BTreeMap<String, usize>,
    /// "rayyan" (decisions in notes), "column" (a decision column), "list" (every record has
    /// `list_decision`) or "none".
    pub decisions: String,
    /// For "list": include | exclude | maybe.
    pub list_decision: String,
    /// The stage the decisions are for: "ta" or "ft" (full-text decisions also record the
    /// title-and-abstract include they imply).
    pub stage: String,
    /// External reviewer name → Key team member id ("" = leave out). Without a mapping, the
    /// importer records the agreed decision (unanimous ones only).
    pub reviewers: BTreeMap<String, String>,
    pub batch_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub format: String,
    pub columns: Vec<String>,
    pub sample: Vec<Vec<String>>,
    pub rows: usize,
    pub mapping: Mapping,
    /// Reviewers named in Rayyan's inclusion blocks.
    pub reviewers: Vec<String>,
    /// Counts of the decisions the file holds (by value).
    pub decisions: BTreeMap<String, usize>,
    pub notes: Vec<String>,
}

const KNOWN: [(&str, &[&str]); 16] = [
    ("title", &["title", "article title", "ti"]),
    ("authors", &["authors", "author", "au"]),
    ("year", &["published year", "year", "py", "publication year"]),
    ("journal", &["journal", "source", "journal/book", "secondary title"]),
    ("volume", &["volume", "vl"]),
    ("issue", &["issue", "number", "is"]),
    ("pages", &["pages", "sp"]),
    ("doi", &["doi", "do"]),
    ("pmid", &["pubmed_id", "pmid", "pubmed id"]),
    ("abstract", &["abstract", "ab"]),
    ("url", &["url"]),
    ("notes", &["notes"]),
    ("labels", &["tags", "labels", "keywords"]),
    ("decision", &["decision", "screening decision", "status", "included"]),
    ("reasons", &["exclusion reason", "exclusion reasons", "reason"]),
    ("id", &["covidence #", "key", "record id", "id"]),
];

/// One Rayyan notes field: decisions per reviewer, labels and exclusion reasons.
pub fn parse_rayyan(notes: &str) -> (BTreeMap<String, String>, Vec<String>, Vec<String>, String) {
    let mut decisions = BTreeMap::new();
    let mut labels = Vec::new();
    let mut reasons = Vec::new();
    let mut other = Vec::new();
    for block in notes.split(" | ") {
        let b = block.trim();
        if let Some(rest) = b.strip_prefix("RAYYAN-INCLUSION:") {
            let inner = rest.trim().trim_start_matches('{').trim_end_matches('}');
            for pair in inner.split(", \"").map(|p| p.trim().trim_start_matches('"')) {
                if let Some((who, what)) = pair.split_once("\"=>\"") {
                    decisions.insert(who.trim_matches('"').to_string(), what.trim_matches('"').to_string());
                }
            }
        } else if let Some(rest) = b.strip_prefix("RAYYAN-LABELS:") {
            labels.extend(rest.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
        } else if let Some(rest) = b.strip_prefix("RAYYAN-EXCLUSION-REASONS:") {
            reasons.extend(rest.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
        } else if !b.starts_with("USER-NOTES:") && !b.is_empty() {
            other.push(b.to_string());
        }
    }
    (decisions, labels, reasons, other.join(" | "))
}

fn choice_of(text: &str) -> Option<Choice> {
    let t = text.trim().to_lowercase();
    if t.starts_with("incl") || t == "yes" || t == "1" {
        Some(Choice::Include)
    } else if t.starts_with("excl") || t == "no" || t == "-1" || t == "irrelevant" {
        Some(Choice::Exclude)
    } else if t.starts_with("maybe") || t == "0" || t == "unsure" {
        Some(Choice::Maybe)
    } else {
        None
    }
}

pub fn preview(text: &str) -> Result<Preview> {
    let rows = csv_rows(text);
    let head = rows.first().ok_or("The file is empty")?.clone();
    let lower: Vec<String> = head.iter().map(|h| h.trim().to_lowercase()).collect();
    let format = if lower.iter().any(|h| h == "covidence #") {
        "covidence"
    } else if lower.first().is_some_and(|h| h == "key") && lower.iter().any(|h| h == "notes") && rows.iter().skip(1).any(|r| r.iter().any(|c| c.contains("RAYYAN-"))) {
        "rayyan"
    } else {
        "other"
    };
    let mut mapping = Mapping { stage: "ta".into(), batch_name: match format { "covidence" => "Imported from Covidence", "rayyan" => "Imported from Rayyan", _ => "Imported screening file" }.into(), ..Default::default() };
    for (key, names) in KNOWN {
        if let Some(i) = lower.iter().position(|h| names.contains(&h.as_str())) {
            mapping.columns.insert(key.into(), i);
        }
    }
    let mut notes = Vec::new();
    let mut reviewers: Vec<String> = Vec::new();
    let mut decisions: BTreeMap<String, usize> = BTreeMap::new();
    match format {
        "rayyan" => {
            mapping.decisions = "rayyan".into();
            let n = mapping.columns.get("notes").copied();
            for r in rows.iter().skip(1) {
                let (d, ..) = parse_rayyan(n.and_then(|i| r.get(i)).map(String::as_str).unwrap_or(""));
                for (who, what) in d {
                    if !reviewers.contains(&who) {
                        reviewers.push(who);
                    }
                    *decisions.entry(what).or_default() += 1;
                }
            }
            notes.push("Rayyan keeps each reviewer's decision in the notes column. Match the reviewers to your team to keep them as separate decisions, or leave them unmatched to record only the decisions they agree on.".into());
        }
        "covidence" => {
            mapping.decisions = "list".into();
            mapping.list_decision = "include".into();
            notes.push("Covidence exports one list per stage and has no decision column: choose what this list is (for example \"Included at full text\"). Exclusion reasons are read from the notes.".into());
        }
        _ => {
            mapping.decisions = if mapping.columns.contains_key("decision") { "column".into() } else { "none".into() };
            if let Some(i) = mapping.columns.get("decision") {
                for r in rows.iter().skip(1) {
                    *decisions.entry(r.get(*i).cloned().unwrap_or_default()).or_default() += 1;
                }
            }
            notes.push("This file is not a Covidence or Rayyan export Key recognises: check every column below.".into());
        }
    }
    Ok(Preview { format: format.into(), columns: head, sample: rows.iter().skip(1).take(5).cloned().collect(), rows: rows.len().saturating_sub(1), mapping, reviewers, decisions, notes })
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub added: usize,
    pub duplicates: usize,
    pub decisions: usize,
    /// Records whose reviewers disagree and no mapping kept them apart: left to screen in Key.
    pub left_undecided: usize,
    pub skipped: Vec<String>,
}

impl Reviews {
    pub fn migrate(&self, review: &str, text: &str, mapping: &Mapping, actor: &str, library: &dyn crate::Library) -> Result<MigrationReport> {
        let rows = csv_rows(text);
        if rows.len() < 2 {
            return Err("The file has no records".into());
        }
        let col = |r: &Vec<String>, k: &str| mapping.columns.get(k).and_then(|i| r.get(*i)).map(|s| s.trim().to_string()).unwrap_or_default();
        let mut metas = Vec::new();
        // Per record: decisions by Key actor, reasons, labels.
        let mut planned: Vec<(String, Vec<(String, Choice)>, Vec<String>, Vec<String>)> = Vec::new();
        let mut left_undecided = 0;
        let mut skipped = Vec::new();
        for (n, r) in rows.iter().enumerate().skip(1) {
            let title = col(r, "title");
            if title.is_empty() {
                skipped.push(format!("Row {}: no title", n + 1));
                continue;
            }
            let authors_raw = col(r, "authors");
            let authors: Vec<String> = if authors_raw.contains(';') { authors_raw.split(';').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect() } else { authors_raw.split(" and ").map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect() };
            let notes = col(r, "notes");
            let (rayyan, rlabels, rreasons, rest) = if mapping.decisions == "rayyan" { parse_rayyan(&notes) } else { (BTreeMap::new(), vec![], vec![], notes.clone()) };
            let mut reasons = rreasons;
            let mut rest_notes = rest;
            if let Some(idx) = rest_notes.find("Exclusion reason:") {
                let after = &rest_notes[idx + "Exclusion reason:".len()..];
                let reason = after.split(';').next().unwrap_or("").trim().to_string();
                if !reason.is_empty() {
                    reasons.push(reason);
                }
                rest_notes = rest_notes.replace(&format!("Exclusion reason: {}; ", reasons.last().cloned().unwrap_or_default()), "").trim().to_string();
            }
            let r_col = col(r, "reasons");
            if !r_col.is_empty() {
                reasons.push(r_col);
            }
            let mut labels: Vec<String> = col(r, "labels").split(';').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            labels.extend(rlabels);
            let id = crate::events::uuid7();
            let year = col(r, "year").chars().take(4).collect::<String>().parse().ok();
            let mut meta = RecordMeta { id: id.clone(), title, authors, year, journal: col(r, "journal"), volume: col(r, "volume"), issue: col(r, "issue"), pages: col(r, "pages"), doi: col(r, "doi").trim_start_matches("https://doi.org/").to_string(), pmid: col(r, "pmid"), abstract_text: col(r, "abstract"), url: col(r, "url"), ..Default::default() };
            let ext = col(r, "id");
            if !ext.is_empty() {
                meta.extra.insert("importedId".into(), json!(ext));
            }
            if !rest_notes.trim().is_empty() {
                meta.extra.insert("importedNotes".into(), json!(rest_notes));
            }
            metas.push(meta);
            let decisions: Vec<(String, Choice)> = match mapping.decisions.as_str() {
                "rayyan" => {
                    if mapping.reviewers.values().any(|v| !v.is_empty()) {
                        rayyan.iter().filter_map(|(who, what)| Some((mapping.reviewers.get(who).filter(|m| !m.is_empty())?.clone(), choice_of(what)?))).collect()
                    } else {
                        let vals: Vec<Choice> = rayyan.values().filter_map(|v| choice_of(v)).collect();
                        match vals.first() {
                            Some(first) if vals.iter().all(|v| v == first) => vec![(actor.to_string(), *first)],
                            Some(_) => {
                                left_undecided += 1;
                                vec![]
                            }
                            None => vec![],
                        }
                    }
                }
                "column" => choice_of(&col(r, "decision")).map(|c| vec![(actor.to_string(), c)]).unwrap_or_default(),
                "list" => choice_of(&mapping.list_decision).map(|c| vec![(actor.to_string(), c)]).unwrap_or_default(),
                _ => vec![],
            };
            planned.push((id, decisions, reasons, labels));
        }
        if metas.is_empty() {
            return Err("No row has a title: check the column mapping".into());
        }
        let batch = Batch { kind: "file".into(), group: "databases".into(), name: if mapping.batch_name.is_empty() { "Imported screening file".into() } else { mapping.batch_name.clone() }, file_name: String::new(), note: "Moved into Key with its screening decisions".into(), ..Default::default() };
        let report = self.import(review, batch, metas, actor, library)?;
        let stage = if mapping.stage == "ft" { Stage::Ft } else { Stage::Ta };
        let mut count = 0;
        let criteria: Vec<(String, String)> = self.read(review, |s, _| Ok(s.protocol.criteria_at(stage).map(|c| (c.id.clone(), c.label.to_lowercase())).collect()))?;
        let note = format!("Imported from {}", if mapping.batch_name.is_empty() { "another tool" } else { mapping.batch_name.trim_start_matches("Imported from ") });
        for (id, decisions, reasons, labels) in &planned {
            if !labels.is_empty() {
                let _ = self.labels(review, std::slice::from_ref(id), labels, &[], actor);
            }
            for (who, value) in decisions {
                // Reasons that name a criterion become that criterion; others go to Other.
                let (ids, other): (Vec<String>, Vec<String>) = if *value == Choice::Include {
                    (vec![], vec![])
                } else {
                    let mut ids = Vec::new();
                    let mut other = Vec::new();
                    for r in reasons {
                        match criteria.iter().find(|(_, l)| l == &r.to_lowercase()) {
                            Some((cid, _)) => ids.push(cid.clone()),
                            None => other.push(r.clone()),
                        }
                    }
                    if ids.is_empty() && other.is_empty() {
                        other.push("Reason not given in the imported file".into());
                    }
                    (ids, other)
                };
                if stage == Stage::Ft {
                    let _ = self.decide(review, std::slice::from_ref(id), Stage::Ta, Choice::Include, vec![], "", &note, vec![], who);
                }
                let first = |v: Vec<String>, rule_one: bool| if rule_one { v.into_iter().take(1).collect() } else { v };
                let one = self.read(review, |s, _| Ok(s.protocol.rules.stage(stage).asks(*value) == "first"))?;
                let ids = first(ids, one);
                let other = if one && !ids.is_empty() { String::new() } else { other.join("; ") };
                match self.decide(review, std::slice::from_ref(id), stage, *value, ids, &other, &note, vec![], who) {
                    Ok(_) => count += 1,
                    Err(e) => skipped.push(format!("A decision was not recorded: {e}")),
                }
            }
        }
        Ok(MigrationReport { added: report.added, duplicates: report.duplicates, decisions: count, left_undecided, skipped })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NoLibrary;

    const RAYYAN: &str = "key,title,year,month,day,journal,issn,volume,issue,pages,authors,url,language,publisher,location,abstract,notes,doi,keywords,pubmed_id,pmc_id\n\
rayyan-1,Invented trial of walking,2019,,,J Inv,,3,2,10-12,\"Rivera, A. and Okafor, B.\",,eng,,,An abstract.,\"RAYYAN-INCLUSION: {\"\"Reviewer A\"\"=>\"\"Included\"\", \"\"Reviewer B\"\"=>\"\"Included\"\"} | RAYYAN-LABELS: RCT\",10.9999/w.1,,,\n\
rayyan-2,Invented survey of cycling,2017,,,J Inv,,4,1,1-9,\"Haas, D.\",,eng,,,Another.,\"RAYYAN-INCLUSION: {\"\"Reviewer A\"\"=>\"\"Excluded\"\", \"\"Reviewer B\"\"=>\"\"Excluded\"\"} | RAYYAN-EXCLUSION-REASONS: wrong design\",10.9999/c.2,,,\n\
rayyan-3,Invented yoga study,2020,,,J Inv,,5,1,2-3,\"Moreau, E.\",,eng,,,Third.,\"RAYYAN-INCLUSION: {\"\"Reviewer A\"\"=>\"\"Included\"\", \"\"Reviewer B\"\"=>\"\"Excluded\"\"}\",10.9999/y.3,,,\n";

    const COVIDENCE: &str = "Title,Authors,Abstract,Published Year,Published Month,Journal,Volume,Issue,Pages,Accession Number,DOI,Ref,Covidence #,Study,Notes,Tags\n\
Invented trial of stretching,Lind C; Haas D,An abstract.,2018,,J Inv,2,1,4-9,,10.9999/s.9,,#12,Lind 2018,Exclusion reason: Wrong population; ,pilot\n";

    #[test]
    fn rayyan_decisions_are_read_and_imported() {
        let (d, labels, reasons, _) = parse_rayyan("RAYYAN-INCLUSION: {\"A\"=>\"Excluded\", \"B\"=>\"Included\"} | RAYYAN-LABELS: RCT,Data | RAYYAN-EXCLUSION-REASONS: wrong population");
        assert_eq!(d.get("A").map(String::as_str), Some("Excluded"));
        assert_eq!(d.get("B").map(String::as_str), Some("Included"));
        assert_eq!(labels, ["RCT", "Data"]);
        assert_eq!(reasons, ["wrong population"]);
        let p = preview(RAYYAN).unwrap();
        assert_eq!(p.format, "rayyan");
        assert_eq!(p.rows, 3);
        assert_eq!(p.reviewers, ["Reviewer A", "Reviewer B"]);
        assert_eq!(p.mapping.columns["title"], 1);
        assert_eq!(p.mapping.columns["authors"], 10);
        let reviews = Reviews::in_memory().unwrap();
        let (id, owner) = reviews.create("Moved review", "Ana", None).unwrap();
        // No reviewer mapping: agreed decisions only, the disagreement left to screen.
        let r = reviews.migrate(&id, RAYYAN, &p.mapping, &owner, &NoLibrary).unwrap();
        assert_eq!((r.added, r.decisions, r.left_undecided), (3, 2, 1));
        let excluded = reviews.studies_export(&id, "csv", "excluded").unwrap();
        let text = String::from_utf8(excluded.bytes).unwrap();
        assert!(text.contains("Invented survey of cycling") && text.contains("wrong design"), "{text}");
    }

    #[test]
    fn covidence_list_with_reasons() {
        let p = preview(COVIDENCE).unwrap();
        assert_eq!(p.format, "covidence");
        assert_eq!(p.mapping.columns["year"], 3);
        let reviews = Reviews::in_memory().unwrap();
        let (id, owner) = reviews.create("Moved review", "Ana", None).unwrap();
        let mapping = Mapping { list_decision: "exclude".into(), stage: "ft".into(), ..p.mapping };
        let r = reviews.migrate(&id, COVIDENCE, &mapping, &owner, &NoLibrary).unwrap();
        assert_eq!((r.added, r.decisions), (1, 1), "{:?}", r.skipped);
        let text = String::from_utf8(reviews.studies_export(&id, "csv", "excluded").unwrap().bytes).unwrap();
        assert!(text.contains("full text") && text.contains("Wrong population"), "{text}");
    }
}
