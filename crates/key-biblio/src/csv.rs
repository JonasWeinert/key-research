// CSV and TSV: a header row names the columns (Zotero's, Key's own and common spellings
// are recognised; others are kept as `csv.<Header>` properties). Quoted cells may hold
// separators, quotes ("") and line breaks.
use crate::export::{ExportItem, ExportOptions};
use crate::fields::{self, keep, put};
use crate::{Record, Warning};
use key_store::Creator;
use serde_json::Value as Json;

const NS: &str = "csv";

/// Rows with the line each starts on.
pub fn rows(text: &str, separator: char) -> Vec<(usize, Vec<String>)> {
    let mut out = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut line = 1;
    let mut row_line = 1;
    let mut chars = text.chars().peekable();
    let mut any = false;
    while let Some(c) = chars.next() {
        any = true;
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    cell.push('"');
                }
                '"' => quoted = false,
                '\n' => {
                    line += 1;
                    cell.push('\n');
                }
                c => cell.push(c),
            }
            continue;
        }
        match c {
            '"' if cell.is_empty() => quoted = true,
            c if c == separator => row.push(std::mem::take(&mut cell)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut cell));
                if row.iter().any(|c| !c.is_empty()) {
                    out.push((row_line, std::mem::take(&mut row)));
                } else {
                    row.clear();
                }
                line += 1;
                row_line = line;
            }
            c => cell.push(c),
        }
    }
    if any && (!cell.is_empty() || !row.is_empty()) {
        row.push(cell);
        out.push((row_line, row));
    }
    out
}

fn normal(header: &str) -> String {
    header.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase()
}

/// A header's column (or a special: authors, editors, tags, notes, files, type, year).
fn column(header: &str) -> Option<&'static str> {
    Some(match normal(header).as_str() {
        "title" => "title",
        "shorttitle" => "shortTitle",
        "author" | "authors" | "creator" | "creators" => "@authors",
        "editor" | "editors" => "@editors",
        "translator" | "translators" => "@translators",
        "year" | "publicationyear" | "pubyear" => "@year",
        "date" | "publicationdate" | "issued" => "date",
        "journal" | "publicationtitle" | "publication" | "container" | "containertitle" | "journalcontainer" | "source" | "sourcetitle"
        | "booktitle" | "journaltitle" => "containerTitle",
        "journalabbreviation" | "containershort" | "abbreviation" => "containerShort",
        "volume" => "volume",
        "issue" | "number" => "issue",
        "pages" | "page" => "pages",
        "edition" => "edition",
        "series" => "series",
        "publisher" => "publisher",
        "place" | "address" | "location" => "place",
        "institution" | "university" | "school" => "institution",
        "genre" => "genre",
        "doi" => "doi",
        "isbn" => "isbn",
        "issn" => "issn",
        "pmid" | "pubmedid" => "pmid",
        "pmcid" => "pmcid",
        "arxiv" | "arxivid" => "arxivId",
        "url" | "link" => "url",
        "accessed" | "accessdate" | "urldate" => "accessed",
        "abstract" | "abstractnote" => "abstract",
        "language" => "language",
        "rights" => "rights",
        "extra" => "extra",
        "citationkey" | "citekey" | "bibtexkey" | "key" => "citationKey",
        "itemtype" | "type" | "entrytype" => "@type",
        "keywords" | "tags" | "manualtags" | "automatictags" => "@tags",
        "notes" | "note" => "@notes",
        "fileattachments" | "file" | "files" | "attachments" | "filepath" => "@files",
        _ => return None,
    })
}

fn item_type(value: &str) -> &'static str {
    match normal(value).as_str() {
        "journalarticle" | "article" | "journal" | "jour" => "article",
        "book" => "book",
        "booksection" | "chapter" | "bookchapter" | "incollection" | "inbook" => "chapter",
        "conferencepaper" | "inproceedings" | "proceedingsarticle" | "conference" => "conference-paper",
        "report" | "techreport" => "report",
        "thesis" | "phdthesis" | "mastersthesis" | "dissertation" => "thesis",
        "preprint" => "preprint",
        "webpage" | "website" | "online" => "webpage",
        "blogpost" => "blog-post",
        "dataset" => "dataset",
        "software" | "computerprogram" => "software",
        "magazinearticle" => "magazine-article",
        "newspaperarticle" => "newspaper-article",
        "presentation" => "presentation",
        "manuscript" | "unpublished" => "manuscript",
        "patent" => "patent",
        _ => "document",
    }
}

fn names(value: &str, role: &str) -> Vec<Creator> {
    // "Smith, John; Doe, Jane" (Zotero) or "John Smith and Jane Doe".
    let parts: Vec<&str> = if value.contains(';') { value.split(';').collect() } else { value.split(" and ").collect() };
    parts
        .into_iter()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once(',') {
            Some((family, given)) => Creator { family: Some(family.trim().into()), given: Some(given.trim().into()).filter(|g: &String| !g.is_empty()), role: role.into(), ..Default::default() },
            None => match p.rsplit_once(' ') {
                Some((given, family)) => Creator { family: Some(family.into()), given: Some(given.into()), role: role.into(), ..Default::default() },
                None => Creator { family: Some(p.into()), role: role.into(), ..Default::default() },
            },
        })
        .collect()
}

pub fn parse(text: &str, separator: char, _hint: Option<()>) -> Result<(Vec<Record>, Vec<Warning>), String> {
    let mut all = rows(text, separator).into_iter();
    let Some((_, header)) = all.next() else { return Ok((vec![], vec![])) };
    let columns: Vec<Option<&'static str>> = header.iter().map(|h| column(h)).collect();
    if !columns.iter().any(|c| *c == Some("title")) {
        return Err("The first row needs a “Title” column".into());
    }
    let mut records = Vec::new();
    let mut warnings = Vec::new();
    for (line, cells) in all {
        if cells.len() > header.len() {
            warnings.push(Warning { line, message: format!("Row at line {line} has {} cells, the header {}", cells.len(), header.len()) });
        }
        let type_value = columns.iter().zip(&cells).find(|(c, _)| **c == Some("@type")).map(|(_, v)| v.as_str());
        let mut input = fields::reference_input(type_value.map(item_type).unwrap_or("article"));
        let mut record = Record { line, ..Default::default() };
        for (i, value) in cells.iter().enumerate() {
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            match columns.get(i).copied().flatten() {
                Some("@authors") => input.creators.extend(names(value, "author")),
                Some("@editors") => input.creators.extend(names(value, "editor")),
                Some("@translators") => input.creators.extend(names(value, "translator")),
                Some("@year") => {
                    if fields::text(&input.fields, "date").is_none() {
                        put(&mut input, "date", value);
                    }
                }
                Some("@type") => {
                    if item_type(value) == "document" && normal(value) != "document" {
                        keep(&mut input, NS, "Item Type", value);
                    }
                }
                Some("@tags") => fields::add_tags(&mut input, fields::keywords(value)),
                Some("@notes") => record.notes.push(value.to_string()),
                Some("@files") => record.files.extend(value.split(';').map(|f| f.trim().to_string()).filter(|f| !f.is_empty())),
                Some("date") => {
                    input.fields.remove("date");
                    put(&mut input, "date", value);
                }
                Some(column) => put(&mut input, column, value),
                None => keep(&mut input, NS, header.get(i).map(|h| h.trim()).unwrap_or("Column"), value),
            }
        }
        if let Some(year) = fields::text(&input.fields, "date").and_then(fields::year_of) {
            input.fields.insert("year".into(), Json::from(year));
        }
        record.source = input;
        if !record.title().is_empty() || !record.source.creators.is_empty() {
            records.push(record);
        } else {
            warnings.push(Warning { line, message: format!("Row at line {line} has no title") });
        }
    }
    Ok((records, warnings))
}

pub const HEADER: &[&str] = &[
    "Citation Key", "Item Type", "Title", "Authors", "Editors", "Year", "Date", "Container", "Volume", "Issue", "Pages", "Publisher", "Place", "DOI",
    "ISBN", "ISSN", "URL", "Language", "Extra", "Abstract", "Keywords", "Notes", "File",
];

fn cell(value: &str, separator: char) -> String {
    if value.contains([separator, '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

pub fn header(separator: char, options: &ExportOptions) -> String {
    let mut columns: Vec<&str> = HEADER.to_vec();
    columns.retain(|c| match *c {
        "Abstract" => options.abstracts,
        "Keywords" => options.keywords,
        "Notes" => options.notes,
        "File" => options.files,
        _ => true,
    });
    columns.join(&separator.to_string()) + "\n"
}

pub fn write_row(item: &ExportItem, separator: char, options: &ExportOptions) -> String {
    let source = item.source;
    let text = |name: &str| fields::text(&source.fields, name).unwrap_or("").to_string();
    let people = |role: &str| source.creators.iter().filter(|c| c.role == role).map(|c| c.display()).collect::<Vec<_>>().join("; ");
    let year = source.fields.get("year").and_then(Json::as_i64).map(|y| y.to_string()).unwrap_or_default();
    let mut cells = vec![
        item.key.clone(),
        text("itemType"),
        text("title"),
        people("author"),
        people("editor"),
        year,
        text("date"),
        text("containerTitle"),
        text("volume"),
        text("issue"),
        text("pages"),
        text("publisher"),
        text("place"),
        text("doi"),
        text("isbn"),
        text("issn"),
        text("url"),
        text("language"),
        text("extra"),
    ];
    if options.abstracts {
        cells.push(text("abstract"));
    }
    if options.keywords {
        cells.push(source.tags.join("; "));
    }
    if options.notes {
        cells.push(item.notes.join("\n\n"));
    }
    if options.files {
        cells.push(text("filePath"));
    }
    cells.iter().map(|c| cell(c, separator)).collect::<Vec<_>>().join(&separator.to_string()) + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_quoted_cells_and_maps_headers() {
        let text = "Key,Item Type,Publication Year,Author,Title,Manual Tags,Odd Column\nk1,journalArticle,2019,\"Smith, John; Doe, Jane\",\"A title, with comma\nand a break\",a; b,x\n";
        let (records, warnings) = parse(text, ',', None).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        let r = &records[0];
        assert_eq!(r.line, 2);
        assert_eq!(r.title(), "A title, with comma\nand a break");
        assert_eq!(r.source.creators.len(), 2);
        assert_eq!(r.citation_key(), Some("k1"));
        assert_eq!(r.source.tags, ["a", "b"]);
        assert_eq!(r.source.fields.get("year").and_then(Json::as_i64), Some(2019));
        assert_eq!(r.source.properties.get("csv.Odd Column").and_then(Json::as_str), Some("x"));
    }
}
