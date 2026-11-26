// BibTeX and BibLaTeX. The reader keeps going past broken entries (each becomes a warning
// with its line), expands `@string` macros and `#` concatenation, resolves `crossref`,
// and reads JabRef groups. The writer emits entries in a fixed field order so a library
// exported twice gives the same file.
use crate::export::{ExportItem, ExportOptions};
use crate::fields::{self, keep, put};
use crate::latex;
use crate::{Record, Warning, names};
use key_store::{Creator, SourceInput};
use serde_json::Value as Json;
use std::collections::HashMap;

const NS: &str = "bibtex";

/// A parsed entry before mapping: raw (undecoded) field values in file order.
#[derive(Clone, Debug)]
pub struct RawEntry {
    pub line: usize,
    pub kind: String,
    pub key: String,
    pub fields: Vec<(String, String)>,
}

impl RawEntry {
    fn get(&self, name: &str) -> Option<&str> {
        self.fields.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

pub fn looks_like(text: &str) -> bool {
    let mut rest = text;
    while let Some(at) = rest.find('@') {
        let after = &rest[at + 1..];
        let name: String = after.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
        if !name.is_empty() && after[name.len()..].trim_start().starts_with(['{', '(']) {
            return true;
        }
        rest = after;
    }
    false
}

struct Lexer<'a> {
    text: &'a str,
    bytes: &'a [u8],
    at: usize,
    line: usize,
    line_at: usize,
}

impl<'a> Lexer<'a> {
    fn line(&mut self) -> usize {
        // Lines are counted lazily up to the current position.
        if self.at < self.line_at {
            // Moved back (recovering from a broken entry).
            self.line -= self.bytes[self.at..self.line_at].iter().filter(|b| **b == b'\n').count();
        } else {
            self.line += self.bytes[self.line_at..self.at].iter().filter(|b| **b == b'\n').count();
        }
        self.line_at = self.at;
        self.line
    }
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }
    fn skip_ws(&mut self) {
        while self.peek().is_some_and(|b| b.is_ascii_whitespace()) {
            self.at += 1;
        }
        // `%` comments between fields.
        if self.peek() == Some(b'%') {
            while self.peek().is_some_and(|b| b != b'\n') {
                self.at += 1;
            }
            self.skip_ws();
        }
    }
    fn ident(&mut self) -> &'a str {
        let start = self.at;
        while self.peek().is_some_and(|b| !b.is_ascii_whitespace() && !matches!(b, b'=' | b',' | b'{' | b'}' | b'(' | b')' | b'#' | b'"')) {
            self.at += 1;
        }
        &self.text[start..self.at]
    }
    /// A `{…}` group's inside (braces balanced); the opening brace is current.
    fn braced(&mut self) -> Result<&'a str, String> {
        let start = self.at + 1;
        let mut depth = 0;
        while let Some(b) = self.peek() {
            match b {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        self.at += 1;
                        return Ok(&self.text[start..self.at - 1]);
                    }
                }
                b'\\' => self.at += 1,
                b'@' if depth == 1 && self.bytes.get(self.at.wrapping_sub(1)) == Some(&b'\n') && looks_like(&self.text[self.at..self.text.len().min(self.at + 64)]) => {
                    return Err("a “}” is missing, so the next entry starts inside this one".into());
                }
                _ => {}
            }
            self.at += 1;
        }
        Err("a “}” is missing".into())
    }
    fn quoted(&mut self) -> Result<&'a str, String> {
        let start = self.at + 1;
        self.at += 1;
        let mut depth = 0;
        while let Some(b) = self.peek() {
            match b {
                b'{' => depth += 1,
                b'}' => depth -= 1,
                b'\\' => self.at += 1,
                b'"' if depth == 0 => {
                    self.at += 1;
                    return Ok(&self.text[start..self.at - 1]);
                }
                _ => {}
            }
            self.at += 1;
        }
        Err("Missing closing quote".into())
    }
    /// A value: parts joined by `#`, macros expanded.
    fn value(&mut self, macros: &HashMap<String, String>) -> Result<String, String> {
        let mut out = String::new();
        loop {
            self.skip_ws();
            match self.peek() {
                Some(b'{') => out.push_str(self.braced()?),
                Some(b'"') => out.push_str(self.quoted()?),
                Some(b) if b.is_ascii_digit() => {
                    let start = self.at;
                    while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                        self.at += 1;
                    }
                    out.push_str(&self.text[start..self.at]);
                }
                Some(_) => {
                    let name = self.ident().to_ascii_lowercase();
                    if name.is_empty() {
                        return Err("Expected a value".into());
                    }
                    match macros.get(&name) {
                        Some(value) => out.push_str(value),
                        None => out.push_str(&name),
                    }
                }
                None => return Err("Unexpected end of file".into()),
            }
            self.skip_ws();
            if self.peek() == Some(b'#') {
                self.at += 1;
                continue;
            }
            return Ok(out);
        }
    }
    /// Skips to the next `@` that starts a line (recovery after an error).
    fn recover(&mut self) {
        while let Some(b) = self.peek() {
            if b == b'@' && (self.at == 0 || self.bytes[self.at - 1] == b'\n') {
                return;
            }
            self.at += 1;
        }
    }
}

fn month_macros() -> HashMap<String, String> {
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].iter().map(|m| (m.to_string(), m.to_string())).collect()
}

/// Entries, `@string`s and JabRef groups of a file.
pub fn parse_raw(text: &str, progress: &dyn Fn(usize, usize)) -> (Vec<RawEntry>, Vec<Warning>, HashMap<String, Vec<String>>) {
    let mut lexer = Lexer { text, bytes: text.as_bytes(), at: 0, line: 1, line_at: 0 };
    let mut macros = month_macros();
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let mut groups = HashMap::new();
    let total = text.len();
    let mut last_report = 0;
    while let Some(offset) = text[lexer.at..].find('@') {
        lexer.at += offset + 1;
        let entry_start = lexer.at;
        let line = lexer.line();
        if lexer.at - last_report > 256 * 1024 {
            progress(lexer.at, total);
            last_report = lexer.at;
        }
        let kind = lexer.ident().to_ascii_lowercase();
        lexer.skip_ws();
        let close = match lexer.peek() {
            Some(b'{') => b'}',
            Some(b'(') => b')',
            _ => continue, // an @ in free text between entries
        };
        if kind == "comment" {
            if close == b'}' {
                if let Ok(body) = lexer.braced() {
                    read_jabref_groups(body, &mut groups);
                }
            } else {
                lexer.recover();
            }
            continue;
        }
        if kind == "preamble" {
            if lexer.braced().is_err() {
                lexer.recover();
            }
            continue;
        }
        lexer.at += 1;
        let result: Result<Option<RawEntry>, String> = (|| {
            if kind == "string" {
                lexer.skip_ws();
                let name = lexer.ident().to_ascii_lowercase();
                lexer.skip_ws();
                if lexer.peek() != Some(b'=') {
                    return Err("Expected “=” in @string".into());
                }
                lexer.at += 1;
                let value = lexer.value(&macros)?;
                macros.insert(name, value);
                lexer.skip_ws();
                if lexer.peek() == Some(close) {
                    lexer.at += 1;
                }
                return Ok(None);
            }
            lexer.skip_ws();
            let key_start = lexer.at;
            while lexer.peek().is_some_and(|b| b != b',' && b != close && b != b'\n') {
                lexer.at += 1;
            }
            let key = text[key_start..lexer.at].trim().to_string();
            let mut entry = RawEntry { line, kind: kind.clone(), key, fields: Vec::new() };
            loop {
                lexer.skip_ws();
                match lexer.peek() {
                    Some(b',') => {
                        lexer.at += 1;
                        continue;
                    }
                    Some(b) if b == close => {
                        lexer.at += 1;
                        return Ok(Some(entry));
                    }
                    None => return Err("Unexpected end of file inside the entry".into()),
                    _ => {}
                }
                let name = lexer.ident().to_ascii_lowercase();
                if name.starts_with('@') {
                    return Err("a “}” is missing, so the next entry starts inside this one".into());
                }
                if name.is_empty() {
                    return Err(format!("Unexpected “{}”", lexer.peek().map(|b| b as char).unwrap_or(' ')));
                }
                lexer.skip_ws();
                if lexer.peek() != Some(b'=') {
                    return Err(format!("Expected “=” after “{name}”"));
                }
                lexer.at += 1;
                let value = lexer.value(&macros)?;
                if entry.fields.iter().any(|(n, _)| *n == name) {
                    continue;
                }
                entry.fields.push((name, value));
            }
        })();
        match result {
            Ok(Some(entry)) => entries.push(entry),
            Ok(None) => {}
            Err(message) => {
                let key: String = text[entry_start..].chars().skip_while(|c| *c != '{' && *c != '(').skip(1).take_while(|c| *c != ',' && *c != '\n').take(60).collect();
                let name = if key.trim().is_empty() { format!("@{kind}") } else { format!("@{kind}{{{}}}", key.trim()) };
                warnings.push(Warning { line, message: format!("{name} was left out: {message}") });
                // The next entry may begin inside what the broken one swallowed.
                lexer.at = entry_start;
                lexer.recover();
            }
        }
    }
    progress(total, total);
    (entries, warnings, groups)
}

/// JabRef keeps its group tree in `@comment{jabref-meta: grouping: 0 AllEntriesGroup:; 1 StaticGroup:Name\;0\;…;}`.
fn read_jabref_groups(body: &str, groups: &mut HashMap<String, Vec<String>>) {
    let Some(rest) = body.trim().strip_prefix("jabref-meta:") else { return };
    let rest = rest.trim();
    let Some(rest) = rest.strip_prefix("grouping:").or_else(|| rest.strip_prefix("groupstree:")) else { return };
    let mut path: Vec<String> = Vec::new();
    for line in rest.split(";\n").flat_map(|l| l.split('\n')) {
        let line = line.trim();
        let Some((level, group)) = line.split_once(' ') else { continue };
        let Ok(level) = level.parse::<usize>() else { continue };
        let Some((_, spec)) = group.split_once(':') else { continue };
        let name = spec.split("\\;").next().unwrap_or("").trim().trim_end_matches(';').to_string();
        if level == 0 || name.is_empty() {
            continue;
        }
        path.truncate(level - 1);
        path.push(name.clone());
        groups.insert(name, path.clone());
    }
}

/// Entry types and the item type each reads as.
const TYPES: &[(&str, &str)] = &[
    ("article", "article"),
    ("book", "book"),
    ("mvbook", "book"),
    ("collection", "book"),
    ("mvcollection", "book"),
    ("proceedings", "book"),
    ("mvproceedings", "book"),
    ("reference", "book"),
    ("inbook", "chapter"),
    ("incollection", "chapter"),
    ("bookinbook", "chapter"),
    ("suppbook", "chapter"),
    ("suppcollection", "chapter"),
    ("inreference", "chapter"),
    ("inproceedings", "conference-paper"),
    ("conference", "conference-paper"),
    ("techreport", "report"),
    ("report", "report"),
    ("phdthesis", "thesis"),
    ("mastersthesis", "thesis"),
    ("thesis", "thesis"),
    ("online", "webpage"),
    ("electronic", "webpage"),
    ("www", "webpage"),
    ("webpage", "webpage"),
    ("unpublished", "manuscript"),
    ("software", "software"),
    ("dataset", "dataset"),
    ("data", "dataset"),
    ("patent", "patent"),
    ("misc", "document"),
    ("manual", "document"),
    ("booklet", "document"),
    ("periodical", "document"),
    ("standard", "standard"),
];

/// The entry type an item type is written as.
fn entry_type(item_type: &str, biblatex: bool, genre: Option<&str>) -> &'static str {
    match item_type {
        "article" | "magazine-article" | "newspaper-article" => "article",
        "book" => "book",
        "chapter" => if biblatex { "incollection" } else { "incollection" },
        "conference-paper" => "inproceedings",
        "report" => if biblatex { "report" } else { "techreport" },
        "thesis" if biblatex => "thesis",
        "thesis" => {
            if genre.is_some_and(|g| g.to_lowercase().contains("master")) { "mastersthesis" } else { "phdthesis" }
        }
        "webpage" | "blog-post" | "forum-post" if biblatex => "online",
        "preprint" if biblatex => "online",
        "dataset" if biblatex => "dataset",
        "software" if biblatex => "software",
        "patent" if biblatex => "patent",
        "manuscript" => "unpublished",
        _ => "misc",
    }
}

/// Fields that are copied verbatim (no LaTeX decoding).
const VERBATIM: &[&str] = &["url", "doi", "eprint", "file", "pdf", "local-url", "urlraw", "isbn", "issn", "pmid", "pmcid", "groups", "crossref"];

/// Plain field → column, applied to every entry.
const FIELD_MAP: &[(&str, &str)] = &[
    ("shorttitle", "shortTitle"),
    ("volume", "volume"),
    ("pages", "pages"),
    ("edition", "edition"),
    ("series", "series"),
    ("publisher", "publisher"),
    ("address", "place"),
    ("location", "place"),
    ("institution", "institution"),
    ("school", "institution"),
    ("type", "genre"),
    ("doi", "doi"),
    ("isbn", "isbn"),
    ("issn", "issn"),
    ("pmid", "pmid"),
    ("pmcid", "pmcid"),
    ("url", "url"),
    ("urldate", "accessed"),
    ("abstract", "abstract"),
    ("language", "language"),
    ("langid", "language"),
    ("copyright", "rights"),
    ("rights", "rights"),
    ("note", "extra"),
    ("shortjournal", "containerShort"),
    ("journalabbrev", "containerShort"),
    ("journal-abbrev", "containerShort"),
    ("issue", "issue"),
    ("number", "issue"),
];

/// Fields the mapping reads itself (not kept again as properties).
const HANDLED: &[&str] = &[
    "author", "editor", "translator", "bookauthor", "title", "subtitle", "journal", "journaltitle", "booktitle", "year", "date", "month", "day",
    "keywords", "mendeley-tags", "file", "pdf", "local-url", "groups", "annote", "annotation", "eprint", "eprinttype", "archiveprefix",
    "crossref", "organization", "entrysubtype",
];

/// Raw entries → records (crossref resolved first).
pub fn map_entries(entries: Vec<RawEntry>, groups: &HashMap<String, Vec<String>>, warnings: &mut Vec<Warning>) -> Vec<Record> {
    let by_key: HashMap<String, usize> = entries.iter().enumerate().map(|(i, e)| (e.key.to_lowercase(), i)).collect();
    let mut records = Vec::with_capacity(entries.len());
    for entry in &entries {
        let mut entry = entry.clone();
        if let Some(parent) = entry.get("crossref").map(str::to_lowercase) {
            match by_key.get(&parent) {
                Some(&p) => inherit(&mut entry, &entries[p]),
                None => warnings.push(Warning { line: entry.line, message: format!("“{}” cross-references “{parent}”, which is not in the file", entry.key) }),
            }
        }
        records.push(map_entry(&entry, groups));
    }
    records
}

/// BibLaTeX inheritance: the parent's title becomes the child's book title, and so on.
fn inherit(child: &mut RawEntry, parent: &RawEntry) {
    for (name, value) in &parent.fields {
        let target = match (name.as_str(), parent.kind.as_str()) {
            ("title", "proceedings" | "book" | "collection" | "mvbook" | "mvcollection" | "reference") => "booktitle",
            ("subtitle", _) => "booksubtitle",
            ("shorttitle" | "crossref" | "ids" | "keywords" | "file" | "abstract" | "annote" | "doi" | "url", _) => continue,
            ("author", "book" | "mvbook") if child.kind == "inbook" || child.kind == "bookinbook" => "bookauthor",
            (other, _) => other,
        };
        if child.get(target).is_none() {
            child.fields.push((target.to_string(), value.clone()));
        }
    }
}

pub fn map_entry(entry: &RawEntry, groups: &HashMap<String, Vec<String>>) -> Record {
    let kind = entry.kind.as_str();
    let mut item_type = TYPES.iter().find(|(t, _)| *t == kind).map(|(_, i)| *i).unwrap_or("document");
    if item_type == "article" {
        match entry.get("entrysubtype").map(str::to_lowercase).as_deref() {
            Some("magazine") => item_type = "magazine-article",
            Some("newspaper") => item_type = "newspaper-article",
            _ => {}
        }
        if entry.get("eprint").is_some() && entry.get("journal").or(entry.get("journaltitle")).is_none() {
            item_type = "preprint";
        }
    }
    let arxiv = entry.get("eprinttype").or(entry.get("archiveprefix")).is_some_and(|a| a.eq_ignore_ascii_case("arxiv"));
    if matches!(kind, "misc" | "unpublished" | "online") && arxiv {
        item_type = "preprint";
    } else if kind == "misc" && (entry.get("url").is_some() || entry.get("urldate").is_some()) && entry.get("publisher").is_none() {
        item_type = "webpage";
    }
    let mut input: SourceInput = fields::reference_input(item_type);
    let mut record = Record { line: entry.line, ..Default::default() };
    // The type comes back the same way only when the writer would pick it.
    let genre_raw = entry.get("type").map(latex::decode);
    let written = entry_type(item_type, false, genre_raw.as_deref());
    let written_biblatex = entry_type(item_type, true, genre_raw.as_deref());
    if kind != written && kind != written_biblatex {
        keep(&mut input, NS, "entrytype", kind);
    }
    if !entry.key.is_empty() {
        input.fields.insert("citationKey".into(), Json::from(entry.key.clone()));
    }
    let decoded = |name: &str| -> Option<String> {
        entry.get(name).map(|v| if VERBATIM.contains(&name) { latex::decode_verbatim(v) } else { latex::decode(v) }).filter(|v| !v.is_empty())
    };
    // Names.
    for (field, role) in [("author", "author"), ("editor", "editor"), ("translator", "translator"), ("bookauthor", "container-author")] {
        if let Some(raw) = entry.get(field) {
            let (creators, etal) = names::parse_list(raw, role);
            input.creators.extend(creators);
            if etal {
                keep(&mut input, NS, "etal", field);
            }
        }
    }
    // Titles and containers.
    let mut title = decoded("title").unwrap_or_default();
    if let Some(subtitle) = decoded("subtitle") {
        title = if title.is_empty() { subtitle } else { format!("{title}: {subtitle}") };
    }
    put(&mut input, "title", &title);
    let mut container = decoded("journaltitle").or_else(|| decoded("journal")).or_else(|| decoded("booktitle"));
    if let (Some(c), Some(sub)) = (container.as_mut(), decoded("booksubtitle")) {
        *c = format!("{c}: {sub}");
    }
    if let Some(container) = &container {
        put(&mut input, "containerTitle", container);
        if decoded("journal").is_some() && decoded("booktitle").is_some() {
            keep(&mut input, NS, "booktitle", &decoded("booktitle").unwrap());
        }
    }
    // Dates.
    if let Some(date) = decoded("date") {
        put(&mut input, "date", &date);
    } else if let Some(year) = decoded("year") {
        if fields::year_of(&year).is_some() {
            let month = decoded("month");
            let day = decoded("day");
            put(&mut input, "date", &fields::iso_date(&fields::year_of(&year).unwrap().to_string(), month.as_deref(), day.as_deref()));
        } else {
            put(&mut input, "date", &year);
        }
    }
    // Identifiers that travel as eprints.
    if let Some(eprint) = decoded("eprint") {
        let archive = decoded("eprinttype").or_else(|| decoded("archiveprefix")).unwrap_or_default().to_lowercase();
        match archive.as_str() {
            "arxiv" => put(&mut input, "arxivId", eprint.trim_start_matches("arXiv:")),
            "pubmed" => put(&mut input, "pmid", &eprint),
            "" if eprint.chars().next().is_some_and(|c| c.is_ascii_digit()) && eprint.contains('.') => put(&mut input, "arxivId", &eprint),
            _ => {
                keep(&mut input, NS, "eprint", &eprint);
                keep(&mut input, NS, "eprinttype", &archive);
            }
        }
    }
    // Organisation: the institution when there is none, else kept.
    if let Some(organization) = decoded("organization") {
        if entry.get("institution").is_none() && entry.get("school").is_none() {
            put(&mut input, "institution", &organization);
        } else {
            keep(&mut input, NS, "organization", &organization);
        }
    }
    for (field, column) in FIELD_MAP {
        if let Some(value) = decoded(field) {
            let current = fields::text(&input.fields, column).map(str::to_string);
            match current {
                None => put(&mut input, column, &value),
                // Two fields for one column (`number` and `issue`): the second is kept as written.
                Some(current) if current != value && !(*column == "pages" && fields::clean_pages(&value) == current) => keep(&mut input, NS, field, &value),
                Some(_) => {}
            }
        }
    }
    if item_type == "thesis" && fields::text(&input.fields, "genre").is_none() {
        put(&mut input, "genre", if kind == "mastersthesis" { "Master's thesis" } else if kind == "phdthesis" { "PhD thesis" } else { "" });
    }
    // Tags, notes, files, groups.
    for field in ["keywords", "mendeley-tags"] {
        if let Some(value) = decoded(field) {
            fields::add_tags(&mut input, fields::keywords(&value));
        }
    }
    for field in ["annote", "annotation"] {
        if let Some(value) = entry.get(field).map(|v| latex::decode(&v.replace("\\par", "\n\n"))).filter(|v| !v.is_empty()) {
            record.notes.push(value);
        }
    }
    for field in ["file", "pdf", "local-url"] {
        if let Some(value) = decoded(field) {
            record.files.extend(fields::file_paths(&value));
        }
    }
    if let Some(value) = decoded("groups") {
        for name in value.split(',').map(str::trim).filter(|n| !n.is_empty()) {
            record.groups.push(groups.get(name).cloned().unwrap_or_else(|| vec![name.to_string()]));
        }
    }
    if let Some(crossref) = decoded("crossref") {
        keep(&mut input, NS, "crossref", &crossref);
    }
    // Everything else is kept as written.
    for (name, raw) in &entry.fields {
        if HANDLED.contains(&name.as_str()) || FIELD_MAP.iter().any(|(f, _)| f == name) {
            continue;
        }
        let value = if VERBATIM.contains(&name.as_str()) { latex::decode_verbatim(raw) } else { latex::decode(raw) };
        keep(&mut input, NS, name, &value);
    }
    record.source = input;
    record
}

pub fn parse(text: &str, progress: &dyn Fn(usize, usize)) -> (Vec<Record>, Vec<Warning>) {
    let (entries, mut warnings, groups) = parse_raw(text, progress);
    let records = map_entries(entries, &groups, &mut warnings);
    (records, warnings)
}

// ── Writing ──────────────────────────────────────────────────────────────────

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

fn names_field(creators: &[&Creator], etal: bool, encode: &dyn Fn(&str) -> String) -> Option<String> {
    if creators.is_empty() {
        return None;
    }
    let mut list: Vec<String> = creators.iter().map(|c| names::format_name(c, encode)).collect();
    if etal {
        list.push("others".into());
    }
    Some(list.join(" and "))
}

/// Braces in a value must balance; if escaping left them unbalanced, drop them.
fn balanced(value: String) -> String {
    let mut depth = 0i32;
    let mut escaped = false;
    for c in value.chars() {
        match c {
            '\\' => escaped = !escaped,
            '{' if !escaped => depth += 1,
            '}' if !escaped => {
                depth -= 1;
                if depth < 0 {
                    break;
                }
            }
            _ => escaped = false,
        }
        if c != '\\' {
            escaped = false;
        }
    }
    if depth == 0 { value } else { value.replace(['{', '}'], "") }
}

/// One entry. `biblatex` picks BibLaTeX's types and field names.
pub fn write_entry(item: &ExportItem, biblatex: bool, options: &ExportOptions) -> String {
    let source = item.source;
    let f = &source.fields;
    let text = |name: &str| fields::text(f, name).map(str::to_string);
    let prop = |name: &str| source.properties.get(&format!("{NS}.{name}")).and_then(Json::as_str).map(str::to_string);
    let encoding = options.encoding;
    let enc = move |s: &str| latex::encode(s, encoding);
    let verbatim = |s: &str| s.replace(['{', '}'], "").replace('%', "\\%").replace('#', "\\#");
    let item_type = text("itemType").unwrap_or_else(|| "document".into());
    let genre = text("genre");
    let kind = prop("entrytype").unwrap_or_else(|| entry_type(&item_type, biblatex, genre.as_deref()).to_string());
    let mut out: Vec<(String, String)> = Vec::new();
    let mut push = |name: &str, value: Option<String>| {
        if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
            if !out.iter().any(|(n, _)| n == name) {
                out.push((name.to_string(), balanced(value)));
            }
        }
    };
    let etal = prop("etal");
    for (role, field) in [("author", "author"), ("editor", "editor"), ("translator", "translator"), ("container-author", "bookauthor")] {
        let creators: Vec<&Creator> = source.creators.iter().filter(|c| c.role == role).collect();
        push(field, names_field(&creators, etal.as_deref() == Some(field), &enc));
    }
    push("title", text("title").map(|t| latex::protect_case(&enc(&t))));
    push("shorttitle", text("shortTitle").map(|t| enc(&t)));
    let container = text("containerTitle").map(|t| enc(&t));
    match kind.as_str() {
        "article" | "periodical" => push(if biblatex { "journaltitle" } else { "journal" }, container),
        "incollection" | "inproceedings" | "inbook" | "inreference" | "bookinbook" | "conference" => push("booktitle", container.map(|c| latex::protect_case(&c))),
        _ => push(if biblatex { "maintitle" } else { "howpublished" }, container),
    }
    push(if biblatex { "shortjournal" } else { "shortjournal" }, text("containerShort").map(|t| enc(&t)));
    let date = text("date");
    let year = f.get("year").and_then(Json::as_i64);
    if biblatex {
        push("date", date.clone().filter(|d| fields::date_parts(d).is_some()).or(year.map(|y| y.to_string())));
    } else {
        let parts = date.as_deref().and_then(fields::date_parts);
        push("year", year.or(parts.map(|p| p.0)).map(|y| y.to_string()));
        if let Some(month) = parts.and_then(|p| p.1) {
            push("month", Some(format!("\u{0}{}", MONTHS[month as usize - 1])));
        }
        if let Some(day) = parts.and_then(|p| p.2) {
            push("day", Some(day.to_string()));
        }
    }
    if year.is_none() && date.as_deref().is_some_and(|d| fields::year_of(d).is_none()) {
        push("year", date.map(|d| enc(&d)));
    }
    push("volume", text("volume").map(|t| enc(&t)));
    push("number", text("issue").map(|t| enc(&t)));
    push("pages", text("pages").map(|p| enc(&p.replace(['–', '—'], "-")).replace('-', "--").replace("----", "--")));
    push("edition", text("edition").map(|t| enc(&t)));
    push("series", text("series").map(|t| enc(&t)));
    push("publisher", text("publisher").map(|t| enc(&t)));
    push(if biblatex { "location" } else { "address" }, text("place").map(|t| enc(&t)));
    let institution = text("institution").map(|t| enc(&t));
    match kind.as_str() {
        "phdthesis" | "mastersthesis" if !biblatex => push("school", institution),
        "inproceedings" | "proceedings" | "manual" => push("organization", institution),
        _ => push("institution", institution),
    }
    let generic_thesis = matches!(genre.as_deref(), Some("PhD thesis" | "Master's thesis")) && kind != "thesis";
    if !generic_thesis {
        push("type", genre.map(|t| enc(&t)));
    }
    push("doi", text("doi").map(|t| verbatim(&t)));
    push("isbn", text("isbn").map(|t| verbatim(&t)));
    push("issn", text("issn").map(|t| verbatim(&t)));
    if let Some(arxiv) = text("arxivId") {
        push("eprint", Some(verbatim(&arxiv)));
        push(if biblatex { "eprinttype" } else { "archiveprefix" }, Some("arXiv".into()));
    }
    push("pmid", text("pmid").map(|t| verbatim(&t)));
    push("pmcid", text("pmcid").map(|t| verbatim(&t)));
    push("url", text("url").map(|t| verbatim(&t)));
    push("urldate", text("accessed").map(|t| enc(&t)));
    if options.abstracts {
        push("abstract", text("abstract").map(|t| enc(&t)));
    }
    push(if biblatex { "langid" } else { "language" }, text("language").map(|t| enc(&t)));
    push("copyright", text("rights").map(|t| enc(&t)));
    push("note", text("extra").map(|t| enc(&t)));
    if options.keywords && !source.tags.is_empty() {
        push("keywords", Some(source.tags.iter().map(|t| enc(t)).collect::<Vec<_>>().join(", ")));
    }
    if options.files {
        if let Some(path) = text("filePath") {
            push("file", Some(verbatim(&path)));
        }
    }
    if options.notes && !item.notes.is_empty() {
        push("annote", Some(item.notes.iter().map(|n| enc(n.trim())).collect::<Vec<_>>().join("\n\n")));
    }
    // Fields kept from an earlier BibTeX import go back as they were.
    let mut kept: Vec<(&String, &Json)> = source.properties.iter().filter(|(k, _)| k.starts_with("bibtex.")).collect();
    kept.sort_by(|a, b| a.0.cmp(b.0));
    for (name, value) in kept {
        let field = &name[NS.len() + 1..];
        if matches!(field, "entrytype" | "etal") || (field == "abstract" && !options.abstracts) {
            continue;
        }
        let Some(value) = value.as_str() else { continue };
        let value = if VERBATIM.contains(&field) { verbatim(value) } else { enc(value) };
        push(field, Some(value));
    }
    let mut entry = format!("@{kind}{{{},\n", item.key);
    for (name, value) in &out {
        // Month macros go unbraced.
        if let Some(month) = value.strip_prefix('\u{0}') {
            entry.push_str(&format!("  {name} = {month},\n"));
        } else {
            entry.push_str(&format!("  {name} = {{{value}}},\n"));
        }
    }
    if entry.ends_with(",\n") {
        entry.truncate(entry.len() - 2);
        entry.push('\n');
    }
    entry.push_str("}\n");
    entry
}
