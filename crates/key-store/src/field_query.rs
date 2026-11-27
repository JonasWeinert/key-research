// Filters typed out in a search field: `field:value`, `rating>3`, `year:2015..2020`,
// `added:last-week`, `-tag:draft`, `not status:read`, `tag:a|b`, `oa:gold OR oa:green`,
// `abstract:empty`, `has:pdf`, `is:starred`, `"reading status":read` and a few phrases
// ("added last week"). Every field of a source can be named, and every property the
// workspace defines, by its name. Only names this table (or the workspace) knows are read;
// anything else stays text, so a query is never rewritten by surprise. The field table is
// also what `store_filter_fields` lists for the suggestions and the filter builder.
use crate::smart_query::{KnownNames, KnownProperty, QueryFilter};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldType {
    Text,
    Number,
    Date,
    Boolean,
    Select,
    Entity,
    Relation,
}

/// One built-in field: what is typed for it and the store filter it becomes.
pub struct Spec {
    /// The name shown in suggestions and examples.
    pub id: &'static str,
    /// The store's filter field (filters.rs).
    pub field: &'static str,
    pub key: Option<&'static str>,
    pub label: &'static str,
    pub group: &'static str,
    pub ty: FieldType,
    /// Other names it answers to.
    pub names: &'static [&'static str],
    pub examples: &'static [&'static str],
    pub options: &'static [(&'static str, &'static str)],
    pub help: &'static str,
}

const fn spec(id: &'static str, field: &'static str, label: &'static str, group: &'static str, ty: FieldType, names: &'static [&'static str], examples: &'static [&'static str], help: &'static str) -> Spec {
    Spec { id, field, key: None, label, group, ty, names, examples, options: &[], help }
}

use FieldType::*;

const ITEM_TYPES: &[(&str, &str)] = &[
    ("article", "Journal article"),
    ("book", "Book"),
    ("chapter", "Book chapter"),
    ("conference-paper", "Conference paper"),
    ("report", "Report"),
    ("thesis", "Thesis"),
    ("preprint", "Preprint"),
    ("webpage", "Web page"),
    ("blog-post", "Blog post"),
    ("dataset", "Dataset"),
    ("software", "Software"),
    ("video", "Video"),
    ("audio", "Audio"),
    ("image", "Image"),
    ("magazine-article", "Magazine article"),
    ("newspaper-article", "Newspaper article"),
    ("presentation", "Presentation"),
    ("manuscript", "Manuscript"),
    ("document", "Document"),
];
const KINDS: &[(&str, &str)] = &[("pdf", "PDF"), ("web", "Web page"), ("video", "Video"), ("audio", "Audio"), ("image", "Image"), ("file", "Other file"), ("reference", "Reference only")];
const OA: &[(&str, &str)] = &[("gold", "Gold"), ("green", "Green"), ("hybrid", "Hybrid"), ("bronze", "Bronze"), ("diamond", "Diamond"), ("closed", "Closed")];
const STATUS: &[(&str, &str)] = &[("unread", "Unread"), ("reading", "In progress"), ("read", "Read")];
const WORK_TYPES: &[(&str, &str)] = &[("article", "Article"), ("preprint", "Preprint"), ("review", "Review"), ("book", "Book"), ("book-chapter", "Book chapter"), ("dataset", "Dataset"), ("dissertation", "Dissertation"), ("editorial", "Editorial"), ("letter", "Letter")];

pub const SPECS: &[Spec] = &[
    // Publication
    spec("title", "title", "Title", "publication", Text, &["ti"], &["title:\"deep learning\"", "title=Attention is all you need"], "Title contains the words; = for the exact title"),
    spec("author", "creator", "Author", "publication", Text, &["authors", "by", "creator", "creators", "person", "people", "au"], &["author:smith", "-author:doe"], "Any author's name contains it"),
    Spec { key: Some("editor"), ..spec("editor", "creator", "Editor", "publication", Text, &["editors", "ed"], &["editor:jones"], "An editor's name contains it") },
    Spec { key: Some("translator"), ..spec("translator", "creator", "Translator", "publication", Text, &["translators"], &["translator:weber"], "A translator's name contains it") },
    spec("journal", "container", "Journal", "publication", Text, &["venue", "container", "conference", "proceedings", "so", "source"], &["journal:lancet", "venue:\"Nature Medicine\""], "Journal, book or conference contains it"),
    spec("publisher", "publisher", "Publisher", "publication", Text, &[], &["publisher:elsevier"], "Publisher contains it"),
    spec("year", "year", "Year", "publication", Number, &["published", "yr", "py"], &["year:2020", "year>2018", "year:2015..2020"], "Year published: a year, a range or a comparison"),
    Spec { options: ITEM_TYPES, ..spec("type", "itemType", "Type", "publication", Select, &["itemtype", "doctype"], &["type:book", "type:\"conference paper\""], "The kind of work: article, book, chapter …") },
    Spec { options: WORK_TYPES, ..spec("worktype", "workType", "Work type", "publication", Select, &["openalextype"], &["worktype:review"], "OpenAlex's type of work") },
    spec("language", "language", "Language", "publication", Text, &["lang"], &["language:de"], "Language code, e.g. en or de"),
    spec("abstract", "abstract", "Abstract", "publication", Text, &["ab", "summary"], &["abstract:randomised", "abstract:empty"], "Abstract contains the words"),
    spec("volume", "volume", "Volume", "publication", Text, &["vol"], &["volume:12"], "Volume"),
    spec("issue", "issue", "Issue", "publication", Text, &["number", "no"], &["issue:3"], "Issue"),
    spec("pages", "pages", "Pages", "publication", Text, &["page", "pp"], &["pages:101", "pages>300"], "Page range; with > or < the number of pages"),
    spec("edition", "edition", "Edition", "publication", Text, &[], &["edition:2"], "Edition"),
    spec("series", "series", "Series", "publication", Text, &[], &["series:\"lecture notes\""], "Series"),
    spec("place", "place", "Place", "publication", Text, &["location", "city"], &["place:london"], "Place of publication"),
    // Identifiers
    spec("doi", "doi", "DOI", "identifiers", Text, &[], &["doi:10.1038/…", "has:doi", "doi:empty"], "DOI; paste one to find it"),
    spec("isbn", "isbn", "ISBN", "identifiers", Text, &[], &["isbn:9780262033848"], "ISBN"),
    spec("issn", "issn", "ISSN", "identifiers", Text, &[], &["issn:0140-6736"], "ISSN"),
    spec("pmid", "pmid", "PubMed ID", "identifiers", Text, &["pubmed"], &["pmid:33599681"], "PubMed ID"),
    spec("pmcid", "pmcid", "PMC ID", "identifiers", Text, &["pmc"], &["pmcid:PMC8190434"], "PubMed Central ID"),
    spec("arxiv", "arxiv", "arXiv ID", "identifiers", Text, &[], &["arxiv:1706.03762"], "arXiv ID"),
    spec("url", "url", "Link", "identifiers", Text, &["link", "site", "domain", "website"], &["url:nature.com"], "The link contains it"),
    spec("citekey", "citationKey", "Citation key", "identifiers", Text, &["citationkey", "bibkey"], &["citekey:smith2020", "@smith2020"], "Citation key"),
    // Subjects and people from the metadata graph
    spec("topic", "topic", "Topic", "subjects", Text, &["topics", "field", "subject", "concept", "subfield", "domain"], &["topic:epidemiology"], "A topic, field or domain (OpenAlex) contains it"),
    spec("keyword", "keyword", "Keyword", "subjects", Text, &["keywords", "kw"], &["keyword:malaria"], "A keyword contains it"),
    spec("funder", "funder", "Funder", "subjects", Text, &["funders", "funding", "grant"], &["funder:wellcome"], "A funder's name contains it"),
    spec("institution", "institution", "Institution", "subjects", Text, &["institutions", "affiliation", "org", "university"], &["institution:oxford"], "An author's institution contains it"),
    // Metrics and access (OpenAlex)
    spec("citations", "citations", "Citations", "metrics", Number, &["cited", "citationcount", "citedbycount"], &["citations>100", "citations:10..50"], "How often it is cited (OpenAlex)"),
    Spec { options: OA, ..spec("oa", "oaStatus", "Open access", "metrics", Select, &["oastatus", "access"], &["oa:gold", "is:oa"], "Open access status") },
    spec("retracted", "retracted", "Retracted", "metrics", Boolean, &[], &["is:retracted", "retracted:no"], "Retracted (Retraction Watch, OpenAlex)"),
    // Files
    Spec { options: KINDS, ..spec("kind", "kind", "Kind", "files", Select, &["format", "filetype"], &["kind:pdf", "kind:web"], "PDF, web page, video … or a reference only") },
    spec("pagecount", "pageCount", "Number of pages", "files", Number, &["length", "numpages", "pdfpages"], &["pagecount>300"], "Pages in the file"),
    spec("haspdf", "hasPdf", "Has a PDF", "files", Boolean, &[], &["has:pdf", "no:pdf"], "A PDF is attached"),
    spec("hasfile", "hasFile", "Has a file", "files", Boolean, &[], &["has:file"], "Any file is attached"),
    spec("hasfulltext", "hasFullText", "Has full text", "files", Boolean, &["fulltextavailable"], &["has:fulltext", "no:fulltext"], "A PDF or a saved web page to read"),
    spec("haswebpage", "hasWebPage", "Has a saved web page", "files", Boolean, &["hassnapshot"], &["has:webpage"], "A snapshot of its web page is kept"),
    spec("fulltext", "fulltext", "Full text", "files", Text, &["text", "content", "body"], &["fulltext:\"odds ratio\""], "The file's text contains the words"),
    // The library
    spec("tag", "tag", "Tag", "library", Text, &["tags", "label"], &["tag:methods", "-tag:draft", "tag:a|b"], "Tagged with it, or a tag under it"),
    Spec { field: "tag", ..spec("tagonly", "tag", "Tag only", "library", Text, &["exacttag"], &["tagonly:methods"], "Tagged with exactly this tag") },
    spec("collection", "collection", "Collection", "library", Entity, &["in", "folder", "coll", "project"], &["collection:\"Falls project\"", "is:unfiled"], "In the collection or one under it"),
    spec("starred", "starred", "Starred", "library", Boolean, &["favorite", "favourite", "star", "flagged"], &["is:starred"], "Starred"),
    spec("zotero", "zotero", "From Zotero", "library", Boolean, &["synced"], &["is:zotero"], "Synced from Zotero"),
    spec("duplicate", "duplicate", "Possible duplicate", "library", Boolean, &["duplicates", "dupe", "dupes"], &["is:duplicate"], "Shares its DOI, or title and year, with another source"),
    spec("added", "added", "Added", "library", Date, &["created", "imported", "dateadded"], &["added:last-week", "added>2026-01-01", "added:2026-03"], "When it was added"),
    spec("modified", "modified", "Modified", "library", Date, &["updated", "changed", "edited", "datemodified"], &["modified:today", "modified<2025"], "When it last changed"),
    spec("notes", "notes", "Notes", "library", Text, &["note"], &["notes:sampling"], "One of its notes contains the words"),
    spec("notescount", "notesCount", "Number of notes", "library", Number, &["numnotes"], &["has:notes", "notescount>2"], "How many notes it has"),
    spec("highlights", "highlightsCount", "Highlights", "library", Number, &["highlightcount", "annotations"], &["has:highlights", "highlights>5"], "How many highlights it has"),
    spec("comments", "commentsCount", "Comments", "library", Number, &["commentcount"], &["has:comments"], "How many highlights carry a comment"),
    // Reading
    Spec { options: STATUS, ..spec("status", "status", "Reading", "reading", Select, &["readingstatus", "reading"], &["status:unread", "is:reading"], "Unread, in progress or read") },
    spec("read", "read", "Last read", "reading", Date, &["lastread", "opened"], &["read:this-week", "read<2026-01-01"], "When it was last read"),
    // Relations
    spec("cites", "cites", "Cites", "relations", Relation, &["citing", "references"], &["cites:@smith2020"], "Cites the source named (citation key, DOI or title)"),
    spec("citedby", "citedBy", "Cited by", "relations", Relation, &["citedin"], &["citedby:@smith2020"], "Cited by the source named"),
    spec("related", "related", "Related to", "relations", Relation, &["relatedto"], &["related:@smith2020"], "Cites or is cited by the source named"),
];

/// Names that read as identifiers elsewhere (smart_query.rs) when given a value.
const IDENTIFIERS: &[&str] = &["doi", "isbn", "pmid", "pmcid", "arxiv", "key"];

fn norm(name: &str) -> String {
    name.chars().filter(|c| !matches!(c, ' ' | '_' | '-' | '.')).flat_map(char::to_lowercase).collect()
}

pub fn spec_named(name: &str) -> Option<&'static Spec> {
    let n = norm(name);
    SPECS.iter().find(|s| norm(s.id) == n || s.names.iter().any(|a| norm(a) == n))
}

/// A property's field type and the value type its filters carry.
pub fn property_type(property: &KnownProperty) -> (FieldType, Option<&'static str>) {
    let kind = if property.kind == "formula" { property.result_type.as_deref().unwrap_or("text") } else { property.kind.as_str() };
    match kind {
        "number" | "integer" | "real" | "rating" | "progress" | "currency" | "percent" => (Number, Some("number")),
        "date" | "datetime" => (Date, Some("date")),
        "checkbox" | "boolean" | "bool" => (Boolean, Some("boolean")),
        "select" | "status" | "multiselect" | "multi_select" | "multiSelect" => (Select, None),
        _ => (Text, None),
    }
}

#[derive(Clone, Copy)]
enum Target<'a> {
    Spec(&'static Spec),
    Property(&'a KnownProperty),
}

impl Target<'_> {
    fn ty(&self) -> FieldType {
        match self {
            Target::Spec(s) => s.ty,
            Target::Property(p) => property_type(p).0,
        }
    }
    fn label(&self) -> String {
        match self {
            Target::Spec(s) => s.label.to_string(),
            Target::Property(p) => p.name.clone(),
        }
    }
}

/// The workspace's property by name first (its own vocabulary), then a built-in field.
fn resolve<'a>(name: &str, known: Option<&'a KnownNames>) -> Option<Target<'a>> {
    let n = norm(name);
    if n.is_empty() {
        return None;
    }
    if let Some(p) = known.and_then(|k| k.properties.iter().find(|p| norm(&p.name) == n)) {
        return Some(Target::Property(p));
    }
    spec_named(name).map(Target::Spec)
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Op {
    Colon,
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
}

const OPS: &[(&str, Op)] = &[
    (":>=", Op::Gte),
    (":<=", Op::Lte),
    (":>", Op::Gt),
    (":<", Op::Lt),
    (":=", Op::Eq),
    (":≥", Op::Gte),
    (":≤", Op::Lte),
    (">=", Op::Gte),
    ("<=", Op::Lte),
    ("!=", Op::Ne),
    ("≥", Op::Gte),
    ("≤", Op::Lte),
    (":", Op::Colon),
    ("=", Op::Eq),
    (">", Op::Gt),
    ("<", Op::Lt),
];

fn is_quote(c: char) -> bool {
    matches!(c, '"' | '“' | '”')
}

/// Words of the query, quotes kept together: (start, end) byte offsets.
fn tokens(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = None;
    let mut quoted = false;
    for (i, c) in text.char_indices() {
        if is_quote(c) {
            quoted = !quoted;
        }
        if c.is_whitespace() && !quoted {
            if let Some(s) = start.take() {
                out.push((s, i));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        out.push((s, text.len()));
    }
    out
}

fn unquote(text: &str) -> &str {
    let t = text.trim();
    let mut chars = t.chars();
    match (chars.next(), chars.next_back()) {
        (Some(a), Some(b)) if is_quote(a) && is_quote(b) && t.chars().count() >= 2 => t[a.len_utf8()..t.len() - b.len_utf8()].trim(),
        _ => t,
    }
}

/// `-name:value`, `name>value`, `"a name":value`: (negated, name, operator, value).
fn split_token(token: &str) -> Option<(bool, &str, Op, &str)> {
    if token.contains("://") {
        return None;
    }
    let (negate, body) = match token.strip_prefix('-') {
        Some(rest) if rest.starts_with(|c: char| c.is_alphabetic() || is_quote(c)) => (true, rest),
        _ => (false, token),
    };
    let name_end = if body.starts_with(is_quote) {
        let first = body.chars().next()?.len_utf8();
        let close = body[first..].find(is_quote)? + first;
        close + body[close..].chars().next()?.len_utf8()
    } else {
        body.char_indices().find(|(_, c)| !(c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))).map_or(body.len(), |(i, _)| i)
    };
    let name = unquote(&body[..name_end]);
    if name.is_empty() {
        return None;
    }
    let rest = &body[name_end..];
    let (sign, op) = OPS.iter().find(|(sign, _)| rest.starts_with(sign))?;
    Some((negate, name, *op, &rest[sign.len()..]))
}

// ── Dates ────────────────────────────────────────────────────────────────────

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, m, d)
}

fn iso(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn today() -> i64 {
    crate::now_ms().div_euclid(86_400_000)
}

/// "last week", "7d", "this-month" …: the first and last day and how to say it.
fn relative(text: &str, today: i64) -> Option<(i64, i64, String)> {
    let t = text.trim().to_lowercase().replace([' ', '_'], "-");
    let t = t.strip_prefix("in-the-").or_else(|| t.strip_prefix("the-")).unwrap_or(&t).to_string();
    let weekday = (today + 3).rem_euclid(7); // 0 = Monday
    let (y, m, _) = civil_from_days(today);
    let month_start = |y: i64, m: i64| days_from_civil(y, m, 1);
    let found = match t.as_str() {
        "today" => (today, today, "today".to_string()),
        "yesterday" => (today - 1, today - 1, "yesterday".into()),
        "this-week" => (today - weekday, today, "this week".into()),
        "last-week" => (today - weekday - 7, today - weekday - 1, "last week".into()),
        "this-month" => (month_start(y, m), today, "this month".into()),
        "last-month" => {
            let (py, pm) = if m == 1 { (y - 1, 12) } else { (y, m - 1) };
            (month_start(py, pm), month_start(y, m) - 1, "last month".into())
        }
        "this-year" => (days_from_civil(y, 1, 1), today, "this year".into()),
        "last-year" => (days_from_civil(y - 1, 1, 1), days_from_civil(y, 1, 1) - 1, "last year".into()),
        other => {
            // "7d", "2w", "3m", "1y", "last-30-days", "past-2-weeks".
            let other = other.strip_prefix("last-").or_else(|| other.strip_prefix("past-")).unwrap_or(other);
            let digits: String = other.chars().take_while(char::is_ascii_digit).collect();
            let n: i64 = digits.parse().ok().filter(|n| (1..=10_000).contains(n))?;
            let unit = other[digits.len()..].trim_start_matches('-');
            let (days, word) = match unit {
                "d" | "day" | "days" => (n, "day"),
                "w" | "wk" | "week" | "weeks" => (n * 7, "week"),
                "m" | "mo" | "month" | "months" => (n * 30, "month"),
                "y" | "yr" | "year" | "years" => (n * 365, "year"),
                _ => return None,
            };
            (today - days + 1, today, if n == 1 { format!("in the last {word}") } else { format!("in the last {n} {word}s") })
        }
    };
    Some(found)
}

/// A date value as the filter takes it ("2026-03", "2026-11-16..2026-11-22") and how to say it.
fn date_value(raw: &str, today: i64) -> Option<(String, String, bool)> {
    if let Some((a, b, label)) = relative(raw, today) {
        return Some((format!("{}..{}", iso(a), iso(b)), label, true));
    }
    let v = raw.trim();
    let valid = |d: &str| crate::filters::date_span(d).is_some() && d.len() >= 4 && d.as_bytes()[..4].iter().all(u8::is_ascii_digit);
    if let Some((a, b)) = v.split_once("..") {
        return (valid(a) && valid(b)).then(|| (v.to_string(), format!("{a} to {b}"), true));
    }
    // "2020-2022": two years.
    if v.len() == 9 && v.is_ascii() && v.as_bytes()[4] == b'-' && v[..4].parse::<i64>().is_ok() && v[5..].parse::<i64>().is_ok_and(|y| y > 1300) {
        return Some((format!("{}..{}", &v[..4], &v[5..]), format!("{} to {}", &v[..4], &v[5..]), true));
    }
    valid(v).then(|| (v.to_string(), if v.len() == 10 { format!("on {v}") } else { format!("in {v}") }, false))
}

// ── Building filters ─────────────────────────────────────────────────────────

fn base(target: &Target, negate: bool) -> QueryFilter {
    let mut f = QueryFilter::default();
    match target {
        Target::Spec(s) => {
            f.field = s.field.into();
            f.key = s.key.map(String::from);
        }
        Target::Property(p) => {
            f.field = "property".into();
            f.key = Some(p.name.clone());
            f.value_type = property_type(p).1.map(String::from);
        }
    }
    f.negate = negate;
    f.scope = Some(target.label());
    f
}

fn not(negate: bool, text: String) -> String {
    if negate { format!("not {text}") } else { text }
}

fn number_label(op: &str, value: &str, year: bool) -> String {
    match (op, year) {
        ("gt", true) => format!("after {value}"),
        ("gte", true) => format!("{value} or later"),
        ("lt", true) => format!("before {value}"),
        ("lte", true) => format!("{value} or earlier"),
        ("gt", _) => format!("more than {value}"),
        ("gte", _) => format!("at least {value}"),
        ("lt", _) => format!("less than {value}"),
        ("lte", _) => format!("at most {value}"),
        ("between", _) => value.replace("..", "–"),
        _ => value.to_string(),
    }
}

fn pick_option(options: &[(&str, &str)], value: &str) -> Option<(String, String)> {
    let v = value.to_lowercase();
    let vn = norm(value);
    options
        .iter()
        .find(|(id, label)| id.to_lowercase() == v || label.to_lowercase() == v || norm(id) == vn || norm(label) == vn)
        .or_else(|| options.iter().find(|(_, label)| label.to_lowercase().split(' ').any(|w| w == v)))
        .map(|(id, label)| (id.to_string(), label.to_string()))
}

fn status_word(value: &str) -> Option<&'static str> {
    Some(match value.to_lowercase().as_str() {
        "unread" | "new" | "toread" | "to-read" => "unread",
        "reading" | "in-progress" | "progress" | "started" | "inprogress" => "reading",
        "read" | "finished" | "done" => "read",
        _ => return None,
    })
}

fn yes_no(value: &str) -> Option<bool> {
    match value.trim().to_lowercase().as_str() {
        "" | "yes" | "y" | "true" | "1" | "on" | "checked" | "ticked" => Some(true),
        "no" | "n" | "false" | "0" | "off" | "unchecked" => Some(false),
        _ => None,
    }
}

/// One filter for `target op value`, or none when the value does not fit the field.
fn build(target: Target, op: Op, raw: &str, negate: bool, known: Option<&KnownNames>, today: i64) -> Option<QueryFilter> {
    let (negate, op) = if op == Op::Ne { (!negate, Op::Eq) } else { (negate, op) };
    let quoted = raw.trim().starts_with(is_quote);
    let value = unquote(raw);
    // Several values: any of them.
    if !quoted && value.contains('|') {
        let parts: Vec<QueryFilter> = value.split('|').filter(|v| !v.trim().is_empty()).map(|v| build(target, op, v, false, known, today)).collect::<Option<_>>()?;
        if parts.len() < 2 {
            return parts.into_iter().next();
        }
        let mut group = base(&target, negate);
        group.field = "any".into();
        group.op = "is".into();
        group.key = None;
        group.value_type = None;
        group.label = not(negate, parts.iter().map(|p| p.label.clone()).collect::<Vec<_>>().join(" or "));
        group.any = parts;
        return Some(group);
    }
    let mut f = base(&target, negate);
    let lower = value.to_lowercase();
    if !quoted && matches!(op, Op::Colon | Op::Eq) {
        if matches!(lower.as_str(), "empty" | "none" | "null" | "missing") {
            f.op = if negate { "notEmpty" } else { "empty" }.into();
            f.negate = false;
            f.label = if negate { "is not empty".into() } else { "is empty".into() };
            return Some(f);
        }
        if matches!(lower.as_str(), "any" | "*" | "notempty" | "exists" | "some") {
            f.op = if negate { "empty" } else { "notEmpty" }.into();
            f.negate = false;
            f.label = if negate { "is empty".into() } else { "is not empty".into() };
            return Some(f);
        }
    } else if quoted && value.is_empty() {
        f.op = if negate { "notEmpty" } else { "empty" }.into();
        f.negate = false;
        f.label = if negate { "is not empty".into() } else { "is empty".into() };
        return Some(f);
    }
    if value.is_empty() {
        return None;
    }
    let compare = match op {
        Op::Gt => Some("gt"),
        Op::Gte => Some("gte"),
        Op::Lt => Some("lt"),
        Op::Lte => Some("lte"),
        _ => None,
    };
    match target.ty() {
        Text | Relation => {
            // "pages>300": the number of pages.
            if let (Target::Spec(s), Some(c)) = (target, compare) {
                if s.field == "pages" && value.parse::<u32>().is_ok() {
                    let pages = spec_named("pagecount")?;
                    let mut f = base(&Target::Spec(pages), negate);
                    f.op = c.into();
                    f.value = value.into();
                    f.label = not(negate, number_label(c, value, false));
                    return Some(f);
                }
                return None;
            }
            if compare.is_some() {
                return None;
            }
            let spec_field = if let Target::Spec(s) = target { s.field } else { "" };
            let exact = op == Op::Eq || matches!(spec_field, "tag" | "cites" | "citedBy" | "related");
            f.op = if let Target::Spec(s) = target {
                if s.id == "tagonly" { "exact" } else if exact { "is" } else { "contains" }
            } else if exact {
                "is"
            } else {
                "contains"
            }
            .into();
            if let (Target::Spec(s), Some(k)) = (target, known) {
                if s.field == "tag" {
                    if let Some(tag) = k.tags.iter().find(|t| t.to_lowercase() == lower) {
                        f.value = tag.clone();
                    }
                }
            }
            if f.value.is_empty() {
                f.value = value.trim_start_matches('#').to_string();
            }
            f.label = not(negate, if f.op == "contains" { format!("contains {}", f.value) } else { f.value.clone() });
        }
        Number => {
            let range = value.split_once("..").or_else(|| value.split_once('-').filter(|(a, _)| !a.is_empty()));
            if let (Some((a, b)), None) = (range, compare) {
                let (x, y): (f64, f64) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
                let (lo, hi) = if x <= y { (a.trim(), b.trim()) } else { (b.trim(), a.trim()) };
                f.op = "between".into();
                f.value = format!("{lo}..{hi}");
            } else {
                value.parse::<f64>().ok().filter(|n| n.is_finite())?;
                f.op = compare.unwrap_or("is").into();
                f.value = value.into();
            }
            let year = matches!(target, Target::Spec(s) if s.field == "year");
            f.label = not(negate, number_label(&f.op, &f.value, year));
        }
        Date => {
            let (v, said, ranged) = date_value(value, today)?;
            f.op = compare.unwrap_or("is").into();
            f.value = v;
            f.label = not(
                negate,
                match (f.op.as_str(), ranged) {
                    ("gt", _) => format!("after {}", said.trim_start_matches("on ").trim_start_matches("in ")),
                    ("gte", _) => format!("since {}", said.trim_start_matches("on ").trim_start_matches("in ").trim_start_matches("in the last ")),
                    ("lt", _) => format!("before {}", said.trim_start_matches("on ").trim_start_matches("in ")),
                    ("lte", _) => format!("until {}", said.trim_start_matches("on ").trim_start_matches("in ")),
                    _ => said,
                },
            );
            if matches!(target, Target::Spec(s) if s.field == "read") && f.op == "is" && !ranged && value.len() == 10 {
                // A day for "read" means read that day, not since.
                f.op = "is".into();
            }
        }
        Boolean => {
            if compare.is_some() {
                return None;
            }
            let yes = yes_no(value)? != negate;
            f.negate = false;
            f.op = "is".into();
            f.value = if yes { "true" } else { "false" }.into();
            match target {
                Target::Spec(s) => {
                    f.scope = Some(String::new());
                    f.label = if yes { s.label.to_string() } else { format!("Not {}", s.label.to_lowercase()) };
                }
                Target::Property(_) => f.label = if yes { "yes".into() } else { "no".into() },
            }
        }
        Select => {
            if compare.is_some() {
                return None;
            }
            f.op = "is".into();
            let (v, label) = match target {
                Target::Spec(s) if s.field == "status" => {
                    let v = status_word(value)?;
                    (v.to_string(), pick_option(STATUS, v)?.1)
                }
                Target::Spec(s) => pick_option(s.options, value).unwrap_or_else(|| (lower.clone(), value.to_string())),
                Target::Property(p) => {
                    let options: Vec<(&str, &str)> = p.options.iter().map(|o| (o.as_str(), o.as_str())).collect();
                    pick_option(&options, value).unwrap_or_else(|| (value.to_string(), value.to_string()))
                }
            };
            f.value = v;
            f.label = not(negate, label);
        }
        Entity => {
            if compare.is_some() {
                return None;
            }
            f.op = "is".into();
            let collections = known.map(|k| k.collections.as_slice()).unwrap_or(&[]);
            let found = collections.iter().find(|c| c.name.to_lowercase() == lower).or_else(|| {
                let mut starts = collections.iter().filter(|c| c.name.to_lowercase().starts_with(&lower));
                match (starts.next(), starts.next()) {
                    (Some(one), None) => Some(one),
                    _ => None,
                }
            });
            match found {
                Some(c) => {
                    f.value = c.id.clone();
                    f.label = not(negate, c.name.clone());
                }
                None => {
                    f.value = value.into();
                    f.label = not(negate, value.into());
                }
            }
        }
    }
    Some(f)
}

/// `is:starred`, `has:pdf`, `no:abstract` …
fn shortcut(word: &str, value: &str, negate: bool, known: Option<&KnownNames>, today: i64) -> Option<QueryFilter> {
    let negate = negate ^ matches!(norm(word).as_str(), "no" | "missing" | "without" | "lacks" | "isnt" | "not");
    let v = norm(value);
    let spec = |id: &str| spec_named(id).map(Target::Spec);
    let flag = |id: &str| build(spec(id)?, Op::Colon, "yes", negate, known, today);
    let count = |id: &str| {
        let mut f = build(spec(id)?, Op::Gt, "0", false, known, today)?;
        f.negate = negate;
        f.label = format!("{} {}", if negate { "Without" } else { "With" }, spec_named(id)?.label.to_lowercase().trim_start_matches("number of "));
        f.scope = Some(String::new());
        Some(f)
    };
    match norm(word).as_str() {
        "is" | "isnt" | "not" => match v.as_str() {
            "starred" | "favorite" | "favourite" | "flagged" => flag("starred"),
            "retracted" => flag("retracted"),
            "duplicate" | "duplicates" | "dupe" | "dupes" => flag("duplicate"),
            "zotero" | "synced" => flag("zotero"),
            "unread" | "reading" | "read" | "inprogress" | "finished" => build(spec("status")?, Op::Colon, value, negate, known, today),
            "oa" | "open" | "openaccess" => {
                let mut f = build(spec("oa")?, Op::Colon, "closed", !negate, known, today)?;
                f.field = "openAccess".into();
                f.op = "is".into();
                f.value = if negate { "false" } else { "true" }.into();
                f.negate = false;
                f.scope = Some(String::new());
                f.label = if negate { "Not open access".into() } else { "Open access".into() };
                Some(f)
            }
            "unfiled" => build(spec("collection")?, Op::Colon, "empty", negate, known, today).map(|mut f| {
                f.scope = Some(String::new());
                f.label = if negate { "In a collection".into() } else { "Unfiled".into() };
                f
            }),
            "untagged" => build(spec("tag")?, Op::Colon, "empty", negate, known, today).map(|mut f| {
                f.scope = Some(String::new());
                f.label = if negate { "Tagged".into() } else { "Untagged".into() };
                f
            }),
            other => {
                let (id, label) = KINDS.iter().find(|(id, label)| *id == other || norm(label) == other)?;
                let _ = label;
                build(spec("kind")?, Op::Colon, id, negate, known, today)
            }
        },
        _ => match v.as_str() {
            "pdf" | "pdfs" => flag("haspdf"),
            "file" | "files" | "attachment" => flag("hasfile"),
            "fulltext" | "full-text" | "text" => flag("hasfulltext"),
            "webpage" | "page" | "snapshot" | "snapshots" => flag("haswebpage"),
            "notes" | "note" => count("notescount"),
            "highlights" | "highlight" | "annotations" => count("highlights"),
            "comments" | "comment" => count("comments"),
            _ => {
                let target = resolve(value, known)?;
                build(target, Op::Colon, "any", negate, known, today)
            }
        },
    }
}

/// What was read: the filters, and the byte ranges of the query they came from.
pub struct Read {
    pub filters: Vec<QueryFilter>,
    pub spans: Vec<(usize, usize)>,
}

const DATE_WORDS: &[&str] = &["added", "created", "imported", "modified", "updated", "changed", "edited", "read", "opened"];

/// The filters typed out in `text`, if any.
pub fn read(text: &str, known: Option<&KnownNames>, today: i64) -> Option<Read> {
    let toks = tokens(text);
    let word = |i: usize| &text[toks[i].0..toks[i].1];
    let mut taken = vec![false; toks.len()];
    // (first token, last token, filter)
    let mut found: Vec<(usize, usize, QueryFilter)> = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let w = word(i);
        // "not" before a filter turns it around.
        let (negate_word, at) = if w.eq_ignore_ascii_case("not") && i + 1 < toks.len() { (true, i + 1) } else { (false, i) };
        let token = word(at);
        let mut matched: Option<(usize, usize, QueryFilter)> = None;
        if let Some((negate, name, op, value)) = split_token(token) {
            let negate = negate ^ negate_word;
            let n = norm(name);
            let shortcut_word = matches!(n.as_str(), "is" | "has" | "no" | "missing" | "without" | "lacks" | "isnt") && op == Op::Colon;
            if shortcut_word && !known.is_some_and(|k| k.properties.iter().any(|p| norm(&p.name) == n)) {
                if let Some(f) = shortcut(name, unquote(value), negate, known, today) {
                    matched = Some((i, at, f));
                }
            } else if !(IDENTIFIERS.contains(&n.as_str()) && op == Op::Colon && !matches!(unquote(value).to_lowercase().as_str(), "" | "empty" | "none" | "any" | "*")) {
                // A property whose name has spaces, typed without quotes: "reading status:read".
                let mut start = at;
                let mut target = None;
                if !negate_word && !token.starts_with('-') {
                    for k in (1..=3).rev() {
                        if at < k || (at - k..at).any(|j| taken[j] || split_token(word(j)).is_some()) {
                            continue;
                        }
                        let joined = format!("{} {name}", (at - k..at).map(word).collect::<Vec<_>>().join(" "));
                        if let Some(p) = known.and_then(|kn| kn.properties.iter().find(|p| norm(&p.name) == norm(&joined))) {
                            target = Some(Target::Property(p));
                            start = at - k;
                            break;
                        }
                    }
                }
                let value_end = at;
                if let Some(f) = target.or_else(|| resolve(name, known)).and_then(|t| build(t, op, value, negate, known, today)) {
                    matched = Some((if negate_word { i } else { start }, value_end, f));
                }
            }
        } else if !negate_word && at + 2 < toks.len() {
            // "rating > 3": the name, the operator and the value apart.
            let op = OPS.iter().find(|(sign, op)| *sign == word(at + 1) && !matches!(op, Op::Colon)).map(|(_, op)| *op);
            if let (Some(op), Some(target)) = (op, resolve(token, known).filter(|_| token.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-'))) {
                if let Some(f) = build(target, op, word(at + 2), false, known, today) {
                    matched = Some((at, at + 2, f));
                }
            }
        }
        // "added last week", "read in the last 30 days", "modified since 2026-01-01".
        if matched.is_none() && !negate_word && DATE_WORDS.contains(&w.to_lowercase().as_str()) {
            let spec = spec_named(w).map(Target::Spec);
            for len in (1..=5).rev() {
                if i + len >= toks.len() {
                    continue;
                }
                let phrase = (i + 1..=i + len).map(word).collect::<Vec<_>>().join(" ");
                let lower = phrase.to_lowercase();
                let (op, rest) = [("since ", Op::Gte), ("after ", Op::Gt), ("before ", Op::Lt), ("until ", Op::Lte)]
                    .iter()
                    .find_map(|(p, op)| lower.strip_prefix(p).map(|r| (*op, r.to_string())))
                    .unwrap_or((Op::Colon, lower.clone()));
                if op == Op::Colon && relative(&rest, today).is_none() {
                    continue;
                }
                if let Some(f) = spec.and_then(|t| build(t, op, &rest, false, known, today)) {
                    matched = Some((i, i + len, f));
                    break;
                }
            }
        }
        match matched {
            Some((first, last, f)) => {
                for t in taken.iter_mut().take(last + 1).skip(first) {
                    *t = true;
                }
                found.push((first, last, f));
                i = last + 1;
            }
            None => i += 1,
        }
    }
    if found.is_empty() {
        return None;
    }
    // "a OR b" between two filters: either.
    let mut merged: Vec<(usize, usize, QueryFilter)> = Vec::new();
    for (first, last, f) in found {
        if let Some((pfirst, plast, prev)) = merged.last_mut() {
            if first == *plast + 2 && (word(*plast + 1).eq_ignore_ascii_case("or") || word(*plast + 1) == "|") {
                taken[*plast + 1] = true;
                let mut group = if prev.field == "any" && !prev.negate {
                    prev.clone()
                } else {
                    QueryFilter { field: "any".into(), op: "is".into(), scope: Some(String::new()), any: vec![prev.clone()], ..Default::default() }
                };
                group.any.push(f);
                group.label = group.any.iter().map(|p| [p.scope.clone().unwrap_or_default(), p.label.clone()].join(" ").trim().to_string()).collect::<Vec<_>>().join(" or ");
                *prev = group;
                *plast = last;
                let _ = pfirst;
                continue;
            }
        }
        merged.push((first, last, f));
    }
    let spans = taken.iter().enumerate().filter(|(_, t)| **t).map(|(i, _)| toks[i]).collect();
    Some(Read { filters: merged.into_iter().map(|(_, _, f)| f).collect(), spans })
}

// ── The field list for suggestions and the filter builder ───────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldOption {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    /// What is typed before the colon.
    pub id: String,
    /// The store filter's field, key and value type.
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_type: Option<String>,
    pub label: String,
    pub group: String,
    #[serde(rename = "type")]
    pub ty: FieldType,
    pub ops: Vec<&'static str>,
    pub names: Vec<String>,
    pub examples: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<FieldOption>,
    pub help: String,
    /// A property's own type ("select", "formula" …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub property_type: Option<String>,
}

fn ops_for(ty: FieldType) -> Vec<&'static str> {
    match ty {
        Text => vec!["contains", "is", "empty", "notEmpty"],
        Number | Date => vec!["is", "gt", "gte", "lt", "lte", "between", "empty", "notEmpty"],
        Boolean => vec!["is"],
        Select | Entity => vec!["is", "empty", "notEmpty"],
        Relation => vec!["is"],
    }
}

/// How a name is typed: quoted when it has spaces.
pub fn typed_name(name: &str) -> String {
    if name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') { name.to_lowercase() } else { format!("\"{name}\"") }
}

pub fn fields(known: &KnownNames) -> Vec<FieldInfo> {
    let mut out: Vec<FieldInfo> = SPECS
        .iter()
        .map(|s| FieldInfo {
            id: s.id.into(),
            field: s.field.into(),
            key: s.key.map(String::from),
            value_type: None,
            label: s.label.into(),
            group: s.group.into(),
            ty: s.ty,
            ops: if s.id == "tagonly" { vec!["is"] } else { ops_for(s.ty) },
            names: s.names.iter().map(|n| n.to_string()).collect(),
            examples: s.examples.iter().map(|e| e.to_string()).collect(),
            options: s.options.iter().map(|(v, l)| FieldOption { value: v.to_string(), label: l.to_string() }).collect(),
            help: s.help.into(),
            property_type: None,
        })
        .collect();
    for p in &known.properties {
        let (ty, value_type) = property_type(p);
        let name = typed_name(&p.name);
        let first = p.options.first().map(|o| typed_name(o)).unwrap_or_else(|| "value".into());
        let examples = match ty {
            Number => vec![format!("{name}>3"), format!("{name}:1..5")],
            Date => vec![format!("{name}<2026-01-01"), format!("{name}:this-month")],
            Boolean => vec![format!("{name}:yes"), format!("{name}:no")],
            Select => vec![format!("{name}:{first}"), format!("-{name}:{first}")],
            _ => vec![format!("{name}:word"), format!("{name}:empty")],
        };
        out.push(FieldInfo {
            id: name,
            field: "property".into(),
            key: Some(p.name.clone()),
            value_type: value_type.map(String::from),
            label: p.name.clone(),
            group: "properties".into(),
            ty,
            ops: ops_for(ty),
            names: vec![],
            examples,
            options: p.options.iter().map(|o| FieldOption { value: o.clone(), label: o.clone() }).collect(),
            help: if p.kind == "formula" { "A formula property, by its computed value".into() } else { format!("Your {} property", p.kind) },
            property_type: Some(p.kind.clone()),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smart_query::KnownCollection;

    // 2026-11-26, a Thursday.
    const TODAY: i64 = 20_783;

    fn known() -> KnownNames {
        KnownNames {
            tags: vec!["Methods".into()],
            collections: vec![KnownCollection { id: "c1".into(), name: "Falls project".into() }],
            properties: vec![
                KnownProperty { name: "Rating".into(), kind: "number".into(), options: vec![], result_type: None },
                KnownProperty { name: "Reading status".into(), kind: "select".into(), options: vec!["To read".into(), "Reading".into(), "Done".into()], result_type: None },
                KnownProperty { name: "Reviewed".into(), kind: "checkbox".into(), options: vec![], result_type: None },
                KnownProperty { name: "Due".into(), kind: "date".into(), options: vec![], result_type: None },
                KnownProperty { name: "Score".into(), kind: "formula".into(), options: vec![], result_type: Some("number".into()) },
            ],
            today: Some(TODAY),
        }
    }

    fn brief(text: &str) -> (Vec<String>, String) {
        let k = known();
        let Some(r) = read(text, Some(&k), TODAY) else { return (vec![], text.into()) };
        let show = |f: &QueryFilter| {
            let key = f.key.as_ref().map(|k| format!("[{k}]")).unwrap_or_default();
            let any = if f.any.is_empty() { String::new() } else { format!("({})", f.any.iter().map(|a| format!("{}{} {}", a.field, a.op, a.value)).collect::<Vec<_>>().join("|")) };
            format!("{}{}{key} {} {}{any}", if f.negate { "-" } else { "" }, f.field, f.op, f.value).trim().to_string()
        };
        let mut rest = text.to_string();
        for (a, b) in r.spans.iter().rev() {
            rest.replace_range(*a..*b, "");
        }
        (r.filters.iter().map(show).collect(), rest.split_whitespace().collect::<Vec<_>>().join(" "))
    }

    #[test]
    fn dates_round_trip() {
        assert_eq!(iso(TODAY), "2026-11-26");
        assert_eq!(days_from_civil(2026, 11, 26), TODAY);
        assert_eq!(relative("last week", TODAY).map(|(a, b, _)| (iso(a), iso(b))), Some(("2026-11-16".into(), "2026-11-22".into())));
        assert_eq!(relative("this-month", TODAY).map(|(a, _, _)| iso(a)), Some("2026-11-01".into()));
        assert_eq!(relative("last-month", TODAY).map(|(a, b, _)| (iso(a), iso(b))), Some(("2026-10-01".into(), "2026-10-31".into())));
        assert_eq!(relative("7d", TODAY).map(|(a, _, _)| iso(a)), Some("2026-11-20".into()));
        assert_eq!(relative("in the last 30 days", TODAY).map(|(a, _, l)| (iso(a), l)), Some(("2026-10-28".into(), "in the last 30 days".into())));
    }

    #[test]
    fn reads_standard_fields() {
        assert_eq!(brief("title:\"deep learning\" malaria"), (vec!["title contains deep learning".into()], "malaria".into()));
        assert_eq!(brief("author:smith year>2018"), (vec!["creator contains smith".into(), "year gt 2018".into()], "".into()));
        assert_eq!(brief("editor:jones").0, ["creator[editor] contains jones"]);
        assert_eq!(brief("year:2015..2020").0, ["year between 2015..2020"]);
        assert_eq!(brief("year:2015-2020").0, ["year between 2015..2020"]);
        assert_eq!(brief("citations>=100").0, ["citations gte 100"]);
        assert_eq!(brief("type:book").0, ["itemType is book"]);
        assert_eq!(brief("type:\"conference paper\"").0, ["itemType is conference-paper"]);
        assert_eq!(brief("kind:pdf").0, ["kind is pdf"]);
        assert_eq!(brief("oa:gold").0, ["oaStatus is gold"]);
        assert_eq!(brief("pages>300").0, ["pageCount gt 300"]);
        assert_eq!(brief("volume:12 issue:3").0, ["volume contains 12", "issue contains 3"]);
        assert_eq!(brief("lang:de").0, ["language contains de"]);
        assert_eq!(brief("collection:falls").0, ["collection is c1"]);
        assert_eq!(brief("in:\"Falls project\"").0, ["collection is c1"]);
        assert_eq!(brief("tag:methods").0, ["tag is Methods"]);
        assert_eq!(brief("tagonly:methods").0, ["tag exact Methods"]);
        assert_eq!(brief("status:reading").0, ["status is reading"]);
        assert_eq!(brief("cites:@smith2020").0, ["cites is @smith2020"]);
        assert_eq!(brief("url:nature.com").0, ["url contains nature.com"]);
        assert_eq!(brief("citekey:smith2020").0, ["citationKey contains smith2020"]);
    }

    #[test]
    fn reads_dates_and_relative_phrases() {
        assert_eq!(brief("added:last-week").0, ["added is 2026-11-16..2026-11-22"]);
        assert_eq!(brief("added:\"last week\"").0, ["added is 2026-11-16..2026-11-22"]);
        assert_eq!(brief("malaria added last week"), (vec!["added is 2026-11-16..2026-11-22".into()], "malaria".into()));
        assert_eq!(brief("modified today").0, ["modified is 2026-11-26..2026-11-26"]);
        assert_eq!(brief("added since 2026-01-01").0, ["added gte 2026-01-01"]);
        assert_eq!(brief("added in the last 30 days").0, ["added is 2026-10-28..2026-11-26"]);
        assert_eq!(brief("added>2026-01-01").0, ["added gt 2026-01-01"]);
        assert_eq!(brief("read:>2026-01-01").0, ["read gt 2026-01-01"]);
        assert_eq!(brief("added:2026-03").0, ["added is 2026-03"]);
        // A word that is not a date stays text.
        assert_eq!(brief("read papers"), (vec![], "read papers".into()));
    }

    #[test]
    fn reads_custom_properties_by_type() {
        assert_eq!(brief("rating>3").0, ["property[Rating] gt 3"]);
        assert_eq!(brief("rating > 3").0, ["property[Rating] gt 3"]);
        assert_eq!(brief("rating:2..4").0, ["property[Rating] between 2..4"]);
        assert_eq!(brief("\"reading status\":done").0, ["property[Reading status] is Done"]);
        assert_eq!(brief("reading status:\"to read\" sepsis"), (vec!["property[Reading status] is To read".into()], "sepsis".into()));
        assert_eq!(brief("reading_status=reading").0, ["property[Reading status] is Reading"]);
        assert_eq!(brief("reviewed:yes").0, ["property[Reviewed] is true"]);
        assert_eq!(brief("reviewed:no").0, ["property[Reviewed] is false"]);
        assert_eq!(brief("due<2026-12-01").0, ["property[Due] lt 2026-12-01"]);
        assert_eq!(brief("score>=10").0, ["property[Score] gte 10"]);
        let k = known();
        let r = read("rating>3", Some(&k), TODAY).unwrap();
        assert_eq!((r.filters[0].value_type.as_deref(), r.filters[0].label.as_str(), r.filters[0].scope.as_deref()), (Some("number"), "more than 3", Some("Rating")));
    }

    #[test]
    fn reads_negation_or_groups_and_emptiness() {
        assert_eq!(brief("-tag:methods").0, ["-tag is Methods"]);
        assert_eq!(brief("not status:read").0, ["-status is read"]);
        assert_eq!(brief("rating!=3").0, ["-property[Rating] is 3"]);
        assert_eq!(brief("tag:a|b").0, ["any is (tagis a|tagis b)"]);
        assert_eq!(brief("oa:gold OR oa:green malaria"), (vec!["any is (oaStatusis gold|oaStatusis green)".into()], "malaria".into()));
        assert_eq!(brief("abstract:empty").0, ["abstract empty"]);
        assert_eq!(brief("-abstract:empty").0, ["abstract notEmpty"]);
        assert_eq!(brief("doi:any").0, ["doi notEmpty"]);
        assert_eq!(brief("rating:\"\"").0, ["property[Rating] empty"]);
        assert_eq!(brief("has:doi").0, ["doi notEmpty"]);
        assert_eq!(brief("no:abstract").0, ["abstract empty"]);
        assert_eq!(brief("has:pdf is:starred").0, ["hasPdf is true", "starred is true"]);
        assert_eq!(brief("has:notes").0, ["notesCount gt 0"]);
        assert_eq!(brief("is:unread").0, ["status is unread"]);
        assert_eq!(brief("is:oa").0, ["openAccess is true"]);
        assert_eq!(brief("is:unfiled").0, ["collection empty"]);
        assert_eq!(brief("is:duplicate").0, ["duplicate is true"]);
        assert_eq!(brief("is:retracted").0, ["retracted is true"]);
        assert_eq!(brief("has:rating").0, ["property[Rating] notEmpty"]);
    }

    #[test]
    fn leaves_everything_else_alone() {
        for text in ["deep learning", "note: this is text", "foo:bar", "https://example.org/a:b", "ratio 3:1", "doi:10.1038/abc", "key:smith2020", "a > b", "status:whatever", "rating>high"] {
            assert!(read(text, Some(&known()), TODAY).is_none(), "{text}");
        }
    }

    #[test]
    fn lists_fields_with_properties() {
        let list = fields(&known());
        let rating = list.iter().find(|f| f.key.as_deref() == Some("Rating")).unwrap();
        assert_eq!((rating.ty, rating.examples[0].as_str()), (Number, "rating>3"));
        let status = list.iter().find(|f| f.key.as_deref() == Some("Reading status")).unwrap();
        assert_eq!(status.examples[0], "\"Reading status\":\"To read\"");
        assert!(list.iter().any(|f| f.id == "added" && f.ty == Date));
        assert!(list.len() > SPECS.len());
    }
}
