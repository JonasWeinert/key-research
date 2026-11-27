// A web page's reference list and the in-text links to it, read from its HTML. Pages mark
// their bibliography in a handful of ways: a list with a references class or id (Wikipedia,
// publishers' JATS-derived markup), a section under a "References" heading, entries with ids
// like "ref-12", "B12", "CR12" or "cite_note-12", only `citation_reference` meta tags, or
// schema.org `citation` in JSON-LD. In-text citations are links to those entries ("#ref-12").
use crate::ReferenceInput;
use crate::html_dom::{Dom, NodeId, ROOT};
use serde::Serialize;
use serde_json::{Value as Json, json};
use std::collections::{HashMap, HashSet};

const MAX: usize = 1000;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct WebReference {
    /// 1-based, in list order.
    pub number: usize,
    pub text: String,
    /// The entry's element id (the in-text links' target).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct WebCitation {
    pub anchor: String,
    pub numbers: Vec<usize>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct WebReferenceScan {
    pub references: Vec<WebReference>,
    /// In-text links: their target id and the reference numbers they name.
    pub citations: Vec<WebCitation>,
    /// How the list was found: list, entries, meta, json-ld or none.
    pub method: &'static str,
}

fn clean(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit() {
            if let Ok(b) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

/// The first DOI in `s`, decoded, without trailing punctuation, lower case.
fn doi_of(s: &str) -> Option<String> {
    let mut from = 0;
    while let Some(found) = s[from..].find("10.") {
        let at = from + found;
        let rest = &s[at + 3..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if (4..=9).contains(&digits) && rest[digits..].starts_with('/') {
            let tail_at = at + 3 + digits + 1;
            let len: usize = s[tail_at..].chars().take_while(|c| !c.is_whitespace() && !"\"'<>".contains(*c)).map(char::len_utf8).sum();
            if len > 0 {
                let doi = percent_decode(&s[at..tail_at + len]);
                return Some(doi.trim_end_matches(['.', ',', ';', ')', ']']).to_lowercase());
            }
        }
        from = at + 3;
    }
    None
}

fn ci_contains(text: &str, needle: &str) -> bool {
    text.to_ascii_lowercase().contains(needle)
}

fn is_heading_tag(tag: &str) -> bool {
    matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
}

/// "References", "Bibliography", "3. Works cited" …
fn is_references_heading(text: &str) -> bool {
    const NAMES: &[&str] = &[
        "references",
        "references and notes",
        "bibliography",
        "works cited",
        "literature cited",
        "literature",
        "cited works",
        "reference list",
        "citations",
        "sources",
        "notes and references",
        "references cited",
    ];
    let lower = text.to_lowercase();
    if NAMES.contains(&lower.as_str()) {
        return true;
    }
    let digits = lower.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    let rest = lower[digits..].strip_prefix('.').unwrap_or(&lower[digits..]).trim_start();
    NAMES.contains(&rest)
}

/// Entry ids: "ref-12", "B12", "CR12", "cite_note-12", "bibr3" …
fn entry_id(id: &str) -> bool {
    const PREFIXES: &[&str] = &["ref", "reference", "bib", "bibr", "cite", "cite_note", "cr", "b", "r", "en", "fn"];
    let lower = id.to_ascii_lowercase();
    let sep = |c: u8| matches!(c, b'-' | b'_' | b':' | b'.');
    PREFIXES.iter().any(|p| {
        let Some(rest) = lower.strip_prefix(p) else { return false };
        let b = rest.as_bytes();
        let mut i = 0;
        if b.first().is_some_and(|&c| sep(c)) {
            i += 1;
        }
        while b.get(i).is_some_and(u8::is_ascii_lowercase) {
            i += 1;
        }
        if b.get(i).is_some_and(|&c| sep(c)) {
            i += 1;
        }
        b.get(i).is_some_and(u8::is_ascii_digit)
    })
}

struct Page<'a> {
    dom: &'a Dom,
    all: Vec<NodeId>,
}

impl Page<'_> {
    fn text(&self, id: NodeId) -> String {
        clean(&self.dom.text(id))
    }

    fn is_list(&self, id: NodeId) -> bool {
        matches!(self.dom.tag(id), "ol" | "ul")
    }

    fn li_children(&self, id: NodeId) -> Vec<NodeId> {
        self.dom.element_children(id).into_iter().filter(|&c| self.dom.tag(c) == "li").collect()
    }

    fn outermost(&self, list: Vec<NodeId>) -> Vec<NodeId> {
        list.iter().copied().filter(|&el| !list.iter().any(|&o| o != el && self.dom.contains(o, el))).collect()
    }

    /// The element that holds the entries, in the order pages are tried.
    fn container(&self, selector: usize, id: NodeId) -> bool {
        let d = self.dom;
        let tag = d.tag(id);
        let el_id = d.id(id);
        match selector {
            0 => d.attr(id, "role") == Some("doc-bibliography"),
            1 => tag == "ol" && d.has_class(id, "references"),
            2 => tag == "ul" && d.has_class(id, "references"),
            3 => tag == "ol" && d.nodes[id].parent.is_some_and(|p| d.closest(p, |a| d.has_class(a, "reflist")).is_some()),
            4 => tag == "ol" && d.has_class(id, "reference-list"),
            5 => tag == "ul" && d.has_class(id, "reference-list"),
            6 => d.has_class(id, "ref-list"),
            7 => el_id == "references",
            8 => el_id == "References",
            9 => el_id == "bibliography",
            10 => el_id == "Bibliography",
            11 => el_id == "Bib1",
            12 => d.has_class(id, "c-article-references"),
            13 => tag == "section" && d.has_class(id, "references"),
            14 => tag == "div" && d.has_class(id, "references"),
            15 => d.has_class(id, "bibliography"),
            16 => d.has_class(id, "citation-list"),
            17 => tag == "ol" && d.has_class(id, "refs"),
            18 => el_id == "reference-list",
            19 => el_id == "ref-list",
            20 => d.has_class(id, "article-references"),
            _ => false,
        }
    }

    fn entries_in(&self, root: NodeId) -> Vec<NodeId> {
        let d = self.dom;
        let inside = d.descendants(root);
        let marked: Vec<NodeId> = inside.iter().copied().filter(|&el| d.attr(el, "role") == Some("doc-biblioentry")).collect();
        if !marked.is_empty() {
            return marked;
        }
        let list = if self.is_list(root) {
            Some(root)
        } else {
            let mut lists: Vec<NodeId> =
                inside.iter().copied().filter(|&l| self.is_list(l) && d.nodes[l].parent.is_none_or(|p| d.closest(p, |a| d.tag(a) == "li").is_none())).collect();
            lists.sort_by_key(|&l| std::cmp::Reverse(d.element_children(l).len()));
            lists.first().copied()
        };
        if let Some(list) = list {
            let items = self.li_children(list);
            if !items.is_empty() {
                return items;
            }
        }
        let by_id: Vec<NodeId> = inside.iter().copied().filter(|&el| entry_id(d.id(el)) && self.text(el).chars().count() > 20).collect();
        if !by_id.is_empty() {
            return self.outermost(by_id);
        }
        d.element_children(root).into_iter().filter(|&el| matches!(d.tag(el), "p" | "div") && self.text(el).chars().count() > 30).collect()
    }
}

/// What a reference entry's text leaves out: back links and labels.
fn skipped(d: &Dom, id: NodeId) -> bool {
    let tag = d.tag(id);
    let class = d.attr(id, "class").unwrap_or_default();
    ["mw-cite-backlink", "cite-backlink", "c-article-references__links", "ref-label", "label"].iter().any(|c| d.has_class(id, c))
        || class.contains("backlink")
        || matches!(tag, "button" | "style" | "script")
        || (tag == "a" && d.attr(id, "href").is_some_and(|h| h.contains("#cite_ref")))
}

/// `["“]…[”"]` with 12 to 300 characters inside.
fn quoted_title(text: &str) -> Option<String> {
    for (at, c) in text.char_indices() {
        if c != '"' && c != '“' {
            continue;
        }
        let inner = at + c.len_utf8();
        let run: Vec<char> = text[inner..].chars().take_while(|c| *c != '"' && *c != '”').collect();
        let closed = text[inner..].chars().nth(run.len()).is_some();
        if closed && (12..=300).contains(&run.len()) {
            return Some(run.into_iter().collect());
        }
    }
    None
}

/// Author–date styles: "Okafor A. (2019). The title. Journal …"
fn dated_title(text: &str) -> Option<String> {
    let b = text.as_bytes();
    for at in 0..b.len() {
        if b[at] != b'(' || b.len() < at + 6 {
            continue;
        }
        let year = &b[at + 1..at + 5];
        let century = (year[0] == b'1' && (b'6'..=b'9').contains(&year[1])) || (year[0] == b'2' && year[1] == b'0');
        if !century || !year[2..].iter().all(u8::is_ascii_digit) {
            continue;
        }
        let mut i = at + 5;
        if b.get(i).is_some_and(u8::is_ascii_lowercase) {
            i += 1;
        }
        if b.get(i) != Some(&b')') {
            continue;
        }
        i += 1;
        if b.get(i) == Some(&b'.') {
            i += 1;
        }
        let ws: usize = text[i..].chars().take_while(|c| c.is_whitespace()).map(char::len_utf8).sum();
        if ws == 0 {
            continue;
        }
        i += ws;
        let run: Vec<char> = text[i..].chars().take_while(|c| !".?!".contains(*c)).collect();
        if run.len() < 12 {
            continue;
        }
        let mut title: String = run.iter().take(300).collect();
        if run.len() <= 300 {
            if let Some(mark) = text[i + title.len()..].chars().next().filter(|c| *c == '?' || *c == '!') {
                title.push(mark);
            }
        }
        return Some(title);
    }
    None
}

/// `\b(1[6-9]\d\d|20\d\d)[a-z]?\b`
fn year_in(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    for at in 0..b.len().saturating_sub(3) {
        if at > 0 && word(b[at - 1]) {
            continue;
        }
        let y = &b[at..at + 4];
        if !y.iter().all(u8::is_ascii_digit) || !((y[0] == b'1' && y[1] >= b'6') || (y[0] == b'2' && y[1] == b'0')) {
            continue;
        }
        let after = b.get(at + 4).copied();
        let ok = match after {
            None => true,
            Some(c) if c.is_ascii_lowercase() => !b.get(at + 5).is_some_and(|&n| word(n)),
            Some(c) => !word(c),
        };
        if ok {
            return std::str::from_utf8(y).ok()?.parse().ok();
        }
    }
    None
}

fn four_digits(text: &str) -> Option<String> {
    let b = text.as_bytes();
    (0..b.len().saturating_sub(3)).find(|&i| b[i..i + 4].iter().all(u8::is_ascii_digit)).map(|i| text[i..i + 4].to_string())
}

fn json_text(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Number(n) => n.to_string(),
        Json::Bool(b) => b.to_string(),
        Json::Array(a) => a.iter().map(json_text).collect::<Vec<_>>().join(","),
        _ => String::new(),
    }
}

fn as_list(v: Option<&Json>) -> Vec<Json> {
    match v {
        None | Some(Json::Null) => vec![],
        Some(Json::Array(a)) => a.clone(),
        Some(other) => vec![other.clone()],
    }
}

/// The scan of a page's HTML. `page_url` is the address the page was saved from (links to
/// it with a fragment are in-text citations too).
pub fn detect_web_references(html: &str, page_url: Option<&str>) -> WebReferenceScan {
    let dom = Dom::parse(html);
    let d = &dom;
    let page = Page { dom: d, all: d.descendants(ROOT) };
    let mut entries: Vec<NodeId> = Vec::new();
    let mut method = "none";
    for selector in 0..21 {
        for &root in page.all.iter().filter(|&&el| page.container(selector, el)) {
            let found = page.entries_in(root);
            if found.len() > entries.len() {
                entries = found;
            }
        }
        if entries.len() >= 2 {
            break;
        }
    }
    // A heading named "References": the list (or entries) after it, up to the next heading.
    if entries.len() < 2 {
        for &h in page.all.iter().filter(|&&el| is_heading_tag(d.tag(el)) || d.attr(el, "role") == Some("heading")) {
            if !is_references_heading(&page.text(h)) {
                continue;
            }
            let mut found = Vec::new();
            if let Some(section) = d.closest(h, |a| d.tag(a) == "section") {
                if d.descendants(section).into_iter().find(|&x| is_heading_tag(d.tag(x))) == Some(h) {
                    found = page.entries_in(section);
                }
            }
            if found.len() < 2 {
                let mut after = Vec::new();
                let mut el = d.next_element_sibling(h);
                while let Some(e) = el.filter(|&e| !is_heading_tag(d.tag(e))) {
                    after.push(e);
                    el = d.next_element_sibling(e);
                }
                let list = after.iter().copied().find(|&e| page.is_list(e)).or_else(|| after.iter().find_map(|&e| d.descendants(e).into_iter().find(|&x| page.is_list(x))));
                found = match list {
                    Some(list) => page.li_children(list),
                    None => after.into_iter().filter(|&e| matches!(d.tag(e), "p" | "div") && page.text(e).chars().count() > 30).collect(),
                };
            }
            if found.len() > entries.len() {
                entries = found;
            }
        }
    }
    if !entries.is_empty() {
        method = "list";
    }
    // Entries by id alone, wherever they are.
    if entries.len() < 2 {
        let by_id: Vec<NodeId> =
            page.all.iter().copied().filter(|&el| matches!(d.tag(el), "li" | "div" | "p") && entry_id(d.id(el)) && page.text(el).chars().count() > 30).collect();
        let outer = page.outermost(by_id);
        if outer.len() >= 2 {
            entries = outer;
            method = "entries";
        }
    }

    let mut references: Vec<WebReference> = Vec::new();
    let mut elements: Vec<(usize, NodeId)> = Vec::new();
    for &el in entries.iter().take(MAX) {
        let raw = clean(&d.text_without(el, &|n| skipped(d, n)));
        let mut text = raw.strip_prefix('^').map(|t| t.trim_start().to_string()).unwrap_or(raw);
        if text.chars().count() < 8 {
            continue;
        }
        if text.chars().count() > 2000 {
            text = truncate_chars(&text, 2000);
        }
        let inside = d.descendants(el);
        let links: Vec<&str> = inside.iter().filter(|&&a| d.tag(a) == "a").filter_map(|&a| d.attr(a, "href")).collect();
        let doi_link = links.iter().find(|h| ci_contains(h, "doi.org/10."));
        let doi = doi_link.and_then(|h| doi_of(h)).or_else(|| doi_of(&text));
        let url = links
            .iter()
            .find(|h| {
                let l = h.to_ascii_lowercase();
                let pubmed_term = l.find("pubmed.ncbi").is_some_and(|at| l[at..].contains("term="));
                (l.starts_with("http:") || l.starts_with("https:"))
                    && !l.contains("doi.org/")
                    && !(l.contains("?title=")
                        || l.contains("&title=")
                        || l.contains("?action=")
                        || l.contains("&action=")
                        || l.contains("wikipedia.org/wiki/special:")
                        || l.contains("wikipedia.org/wiki/help:")
                        || l.contains("scholar.google")
                        || pubmed_term
                        || l.contains("worldcat")
                        || l.contains("crossref.org/guestquery"))
            })
            .map(|h| h.to_string());
        let titled = inside.iter().copied().find(|&x| {
            matches!(d.attr(x, "itemprop"), Some("name") | Some("headline"))
                || ["citation-title", "ref-title", "article-title"].iter().any(|c| d.has_class(x, c))
                || (d.tag(x) == "span" && d.has_class(x, "title"))
        });
        let italic = inside.iter().copied().find(|&x| matches!(d.tag(x), "i" | "em")).map(|x| page.text(x)).unwrap_or_default();
        let title = titled
            .map(|t| page.text(t))
            .filter(|t| !t.is_empty())
            .or_else(|| quoted_title(&text).map(|q| clean(&q).trim_end_matches(['.', ',']).to_string()).filter(|t| !t.is_empty()))
            .or_else(|| (italic.chars().count() >= 12).then(|| italic.clone()))
            .or_else(|| dated_title(&text).map(|t| clean(&t)).filter(|t| !t.is_empty()));
        let year = year_in(&text);
        let authors: Vec<String> = inside
            .iter()
            .copied()
            .filter(|&x| d.attr(x, "itemprop") == Some("author") || ["citation-author", "ref-author", "author"].iter().any(|c| d.has_class(x, c)))
            .map(|x| page.text(x))
            .filter(|a| !a.is_empty())
            .take(20)
            .collect();
        let anchor = Some(d.id(el)).filter(|i| !i.is_empty()).or_else(|| inside.iter().find(|&&x| d.attr(x, "id").is_some()).map(|&x| d.id(x))).filter(|i| !i.is_empty());
        let number = references.len() + 1;
        elements.push((number, el));
        references.push(WebReference { number, text, anchor: anchor.map(String::from), doi, url, title: title.map(|t| truncate_chars(&t, 400)), authors, year });
    }

    // Only Highwire-style meta tags: "citation_title=…; citation_author=…; citation_doi=…".
    if references.is_empty() {
        for &meta in page.all.iter().filter(|&&el| d.tag(el) == "meta" && d.attr(el, "name").is_some_and(|n| n.eq_ignore_ascii_case("citation_reference"))) {
            let content = d.attr(meta, "content").unwrap_or_default();
            let mut fields: HashMap<String, Vec<String>> = HashMap::new();
            for part in split_citation_fields(content) {
                let Some(at) = part.find('=') else { continue };
                fields.entry(part[..at].trim().to_lowercase()).or_default().push(part[at + 1..].trim().to_string());
            }
            let get = |k: &str| fields.get(k).and_then(|v| v.first()).cloned();
            let title = get("citation_title");
            let authors = fields.get("citation_author").cloned().unwrap_or_default();
            let year = get("citation_publication_date").or_else(|| get("citation_date")).or_else(|| get("citation_year")).and_then(|y| four_digits(&y));
            let venue = get("citation_journal_title");
            let doi = get("citation_doi").map(|raw| doi_of(&raw).unwrap_or_else(|| raw.to_lowercase()));
            let parts: Vec<String> = [Some(authors.join(", ")), year.as_ref().map(|y| format!("({y})")), title.clone(), venue].into_iter().flatten().filter(|s| !s.is_empty()).collect();
            let text = Some(clean(&parts.join(". "))).filter(|t| !t.is_empty()).unwrap_or_else(|| clean(content));
            if text.chars().count() < 8 || references.len() >= MAX {
                continue;
            }
            let number = references.len() + 1;
            references.push(WebReference { number, text, doi, title, authors, year: year.and_then(|y| y.parse().ok()), ..Default::default() });
        }
        if !references.is_empty() {
            method = "meta";
        }
    }
    // schema.org "citation" in JSON-LD.
    if references.is_empty() {
        for &script in page.all.iter().filter(|&&el| d.tag(el) == "script" && d.attr(el, "type").is_some_and(|t| t.eq_ignore_ascii_case("application/ld+json"))) {
            let Ok(data) = serde_json::from_str::<Json>(&d.text(script)) else { continue };
            let nodes = match &data {
                Json::Array(list) => list.clone(),
                other => match other.get("@graph").and_then(Json::as_array) {
                    Some(graph) => graph.clone(),
                    None => vec![other.clone()],
                },
            };
            for node in &nodes {
                for c in as_list(node.get("citation")) {
                    if references.len() >= MAX {
                        break;
                    }
                    let item = if let Json::String(s) = &c { json!({ "name": s }) } else { c };
                    let title = clean(&json_text(item.get("name").filter(|v| !v.is_null()).or_else(|| item.get("headline")).unwrap_or(&Json::Null)));
                    let id = json_text(item.get("sameAs").filter(|v| !v.is_null()).or_else(|| item.get("@id").filter(|v| !v.is_null())).or_else(|| item.get("url")).unwrap_or(&Json::Null));
                    let doi = doi_of(&id).or_else(|| doi_of(&json_text(item.get("identifier").unwrap_or(&Json::Null))));
                    let authors: Vec<String> = as_list(item.get("author"))
                        .iter()
                        .map(|a| clean(&if a.is_string() { json_text(a) } else { json_text(a.get("name").unwrap_or(&Json::Null)) }))
                        .filter(|a| !a.is_empty())
                        .collect();
                    let year = four_digits(&json_text(item.get("datePublished").unwrap_or(&Json::Null)));
                    let parts: Vec<String> = [Some(authors.join(", ")), year.as_ref().map(|y| format!("({y})")), Some(title.clone())].into_iter().flatten().filter(|s| !s.is_empty()).collect();
                    let text = clean(&parts.join(". "));
                    if text.chars().count() < 8 {
                        continue;
                    }
                    let url = (id.starts_with("http:") || id.starts_with("https:")).then(|| id.clone()).filter(|_| doi.is_none());
                    let number = references.len() + 1;
                    references.push(WebReference {
                        number,
                        text,
                        doi,
                        title: Some(title).filter(|t| !t.is_empty()),
                        authors,
                        year: year.and_then(|y| y.parse().ok()),
                        url,
                        anchor: None,
                    });
                }
            }
        }
        if !references.is_empty() {
            method = "json-ld";
        }
    }

    // In-text links to the entries: "#ref-12" (or this page's URL with that fragment).
    let mut by_anchor: HashMap<String, usize> = HashMap::new();
    for &(number, el) in &elements {
        if !d.id(el).is_empty() {
            by_anchor.insert(d.id(el).to_string(), number);
        }
        for x in d.descendants(el) {
            if d.attr(x, "id").is_some() {
                by_anchor.entry(d.id(x).to_string()).or_insert(number);
            }
        }
    }
    let mut citations = Vec::new();
    if !by_anchor.is_empty() {
        let page_base = page_url.unwrap_or("about:blank").split('#').next().unwrap_or_default().to_string();
        let own = page.all.iter().find(|&&m| d.tag(m) == "meta" && d.attr(m, "name") == Some("key-snapshot")).and_then(|&m| d.attr(m, "content")).unwrap_or_default();
        let mut seen: HashSet<String> = HashSet::new();
        for &a in page.all.iter().filter(|&&a| d.tag(a) == "a") {
            let Some(href) = d.attr(a, "href").filter(|h| h.contains('#')) else { continue };
            let hash_at = href.find('#').unwrap_or(0);
            let (base, hash) = (&href[..hash_at], &href[hash_at + 1..]);
            // A saved copy keeps links absolute: same page is the one its snapshot names.
            if !base.is_empty() && !page_base.is_empty() && base != page_base && !page_base.starts_with("about:") && !own.contains(&base.replace('"', "")) {
                continue;
            }
            let id = percent_decode(hash);
            let Some(&number) = by_anchor.get(&id) else { continue };
            let in_list = d.closest(a, |x| d.tag(x) == "li" || d.attr(x, "role") == Some("doc-biblioentry")).is_some() && entries.iter().any(|&el| d.contains(el, a));
            if in_list {
                continue;
            }
            if seen.insert(id.clone()) {
                citations.push(WebCitation { anchor: id, numbers: vec![number] });
            }
        }
    }
    let method = if references.is_empty() { "none" } else { method };
    WebReferenceScan { references, citations, method }
}

/// `content.split(/;\s*(?=citation_)/)`
fn split_citation_fields(content: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut from = 0;
    while let Some(found) = content[from..].find(';') {
        let at = from + found;
        let next = at + 1 + content[at + 1..].chars().take_while(|c| c.is_whitespace()).map(char::len_utf8).sum::<usize>();
        if content[next..].starts_with("citation_") {
            parts.push(&content[start..at]);
            start = next;
        }
        from = at + 1;
    }
    parts.push(&content[start..]);
    parts
}

/// The references as the library stores an analysis': what the page says about each seeds
/// its metadata until the lookup answers.
pub fn reference_inputs(scan: &WebReferenceScan) -> Vec<ReferenceInput> {
    scan.references
        .iter()
        .map(|r| ReferenceInput {
            number: Some(r.number as i64),
            page: None,
            rects: vec![],
            text: r.text.clone(),
            metadata: (r.title.is_some() || r.doi.is_some()).then(|| {
                let mut meta = json!({ "source": "page", "title": r.title.clone().unwrap_or_else(|| r.text.clone()), "authors": r.authors });
                if let Some(y) = r.year {
                    meta["year"] = json!(y);
                }
                if let Some(doi) = &r.doi {
                    meta["doi"] = json!(doi);
                }
                if let Some(url) = &r.url {
                    meta["landingUrl"] = json!(url);
                }
                meta
            }),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_wikipedia_style_reference_list_and_its_citations() {
        let html = r##"<html><body>
          <p>Malaria kills.<sup id="cite_ref-1"><a href="#cite_note-1">[1]</a></sup> Nets help.<sup><a href="#cite_note-2">[2]</a></sup></p>
          <h2>References</h2>
          <div class="reflist"><ol class="references">
            <li id="cite_note-1"><span class="mw-cite-backlink"><a href="#cite_ref-1">^</a></span>
              <cite>Okafor A. (2019). <i>Bed nets and malaria in rural Nigeria</i>. Lancet. <a href="https://doi.org/10.1016/S0140-6736(19)30001-2">doi</a></cite></li>
            <li id="cite_note-2"><span class="mw-cite-backlink">^</span> Smith J, Jones K. “Insecticide resistance across Africa”. Nature. 2020. <a href="https://example.org/paper">link</a></li>
          </ol></div></body></html>"##;
        let scan = detect_web_references(html, None);
        assert_eq!(scan.method, "list");
        assert_eq!(scan.references.len(), 2);
        let first = &scan.references[0];
        assert_eq!(first.anchor.as_deref(), Some("cite_note-1"));
        assert_eq!(first.doi.as_deref(), Some("10.1016/s0140-6736(19)30001-2"));
        assert_eq!(first.title.as_deref(), Some("Bed nets and malaria in rural Nigeria"));
        assert_eq!(first.year, Some(2019));
        assert!(!first.text.contains('^'), "{}", first.text);
        let second = &scan.references[1];
        assert_eq!(second.title.as_deref(), Some("Insecticide resistance across Africa"));
        assert_eq!(second.url.as_deref(), Some("https://example.org/paper"));
        assert_eq!(scan.citations, vec![WebCitation { anchor: "cite_note-1".into(), numbers: vec![1] }, WebCitation { anchor: "cite_note-2".into(), numbers: vec![2] }]);
    }

    #[test]
    fn reads_the_cases_the_renderer_detection_was_tested_on() {
        let scan = detect_web_references(
            r##"<p>Health rose<sup><a href="#cite_note-1">[1]</a></sup> and so did income<sup><a href="#cite_note-2">[2]</a></sup>.</p>
      <h2>References</h2>
      <div class="reflist"><ol class="references">
        <li id="cite_note-1"><span class="mw-cite-backlink"><a href="#cite_ref-1">^</a></span> <cite>Deaton, A. (2013). “The Great Escape: Health, Wealth, and the Origins of Inequality”. Princeton. <a href="https://doi.org/10.1515/9781400847969">doi:10.1515/9781400847969</a></cite></li>
        <li id="cite_note-2"><span class="mw-cite-backlink"><a href="#cite_ref-2">^</a></span> Preston, S. H. (1975). The changing relation between mortality and level of economic development. Population Studies 29.</li>
      </ol></div>"##,
            None,
        );
        assert_eq!(scan.method, "list");
        let first = &scan.references[0];
        assert_eq!((first.number, first.anchor.as_deref(), first.doi.as_deref(), first.year), (1, Some("cite_note-1"), Some("10.1515/9781400847969"), Some(2013)));
        assert_eq!(first.title.as_deref(), Some("The Great Escape: Health, Wealth, and the Origins of Inequality"));
        assert!(first.text.starts_with("Deaton"), "{}", first.text);
        assert_eq!(scan.citations.iter().map(|c| (c.anchor.as_str(), c.numbers[0])).collect::<Vec<_>>(), [("cite_note-1", 1), ("cite_note-2", 2)]);

        let jats = detect_web_references(
            r##"<p>As shown <a href="#B1">1</a>, <a href="#B2">2</a>.</p>
      <section><h2>References</h2>
        <div id="B1" class="ref">Smith J, Lee K. A long enough reference title about things. J Things. 2020;1:2.</div>
        <div id="B2" class="ref">Doe A. Another long enough reference about other things. Nature. 2019.</div>
      </section>"##,
            None,
        );
        assert_eq!(jats.references.iter().map(|r| r.anchor.as_deref().unwrap_or_default()).collect::<Vec<_>>(), ["B1", "B2"]);
        assert_eq!(jats.citations.iter().map(|c| c.numbers[0]).collect::<Vec<_>>(), [1, 2]);

        let meta = detect_web_references(
            r#"<head><meta name="citation_reference" content="citation_title=Income and health; citation_author=Jane Roe; citation_publication_date=2018; citation_doi=10.1000/xyz"></head><p>No list here.</p>"#,
            None,
        );
        assert_eq!(meta.method, "meta");
        let r = &meta.references[0];
        assert_eq!((r.title.as_deref(), r.doi.as_deref(), r.year, r.authors.clone()), (Some("Income and health"), Some("10.1000/xyz"), Some(2018), vec!["Jane Roe".to_string()]));
        let input = &reference_inputs(&meta)[0];
        assert_eq!(input.metadata.as_ref().unwrap()["doi"], "10.1000/xyz");
        assert_eq!(input.metadata.as_ref().unwrap()["source"], "page");
        assert_eq!(scan.references.len(), 2);
    }

    #[test]
    fn reads_a_bare_references_list_without_a_heading() {
        // What the renderer's page script was last checked on: the list's class alone marks it.
        let scan = detect_web_references(r#"<ol class="references"><li id="r1">Someone. A reference title long enough. 2001.</li><li id="r2">Another. A second reference title. 2002.</li></ol>"#, None);
        assert_eq!(scan.method, "list");
        assert_eq!(scan.references.iter().map(|r| r.anchor.as_deref().unwrap_or_default()).collect::<Vec<_>>(), ["r1", "r2"]);
    }

    #[test]
    fn reads_entries_under_a_heading_and_by_id() {
        let html = r#"<article><h2>2. Bibliography</h2>
            <p>Doe, J. (2018). A long enough title about reading lists. Journal of Things, 3(2).</p>
            <p>Roe, R. (2021). Another long title about bibliographies. Some Press.</p>
            <h2>Notes</h2><p>Unrelated paragraph that is long enough to count as one.</p></article>"#;
        let scan = detect_web_references(html, None);
        assert_eq!(scan.method, "list");
        assert_eq!(scan.references.len(), 2);
        assert_eq!(scan.references[0].title.as_deref(), Some("A long enough title about reading lists"));
        let by_id = r##"<p>See <a href="#B1">1</a> and <a href="https://site.org/a#B2">2</a>.</p>
            <div id="B1">Alpha A. A first referenced work with a title. 2001.</div>
            <div id="B2">Beta B. A second referenced work with a title. 2002.</div>"##;
        let scan = detect_web_references(by_id, Some("https://site.org/a"));
        assert_eq!(scan.method, "entries");
        assert_eq!(scan.citations.len(), 2);
    }

    #[test]
    fn falls_back_to_meta_tags_and_json_ld() {
        let html = r#"<head><meta name="citation_reference" content="citation_title=Deep nets; citation_author=Lee, A; citation_author=Kim, B; citation_publication_date=2015; citation_doi=10.1038/nature14539"></head>"#;
        let scan = detect_web_references(html, None);
        assert_eq!(scan.method, "meta");
        assert_eq!(scan.references[0].text, "Lee, A, Kim, B. (2015). Deep nets");
        assert_eq!(scan.references[0].doi.as_deref(), Some("10.1038/nature14539"));
        let ld = r#"<script type="application/ld+json">{"@graph":[{"@type":"Article","citation":[{"name":"A cited article title","author":[{"name":"Ann Author"}],"datePublished":"2012-01-01","sameAs":"https://doi.org/10.1000/xyz123"}, "Plain string citation title"]}]}</script>"#;
        let scan = detect_web_references(ld, None);
        assert_eq!(scan.method, "json-ld");
        assert_eq!(scan.references.len(), 2);
        assert_eq!(scan.references[0].doi.as_deref(), Some("10.1000/xyz123"));
        assert_eq!(scan.references[0].year, Some(2012));
        let inputs = reference_inputs(&scan);
        assert_eq!(inputs[0].metadata.as_ref().unwrap()["source"], "page");
        assert!(inputs[1].metadata.is_some());
    }

    #[test]
    fn finds_nothing_on_a_plain_page_and_survives_broken_markup() {
        assert_eq!(detect_web_references("<p>Hello <b>world</p></i><li>x", None).method, "none");
        for html in ["", "<", "<a href=", "<!--", "<script>", "&#xZZ;&#99999999;", "<ol class=references><li>Short</li>"] {
            let _ = detect_web_references(html, None);
        }
    }

    #[test]
    fn is_fast_on_a_large_page() {
        let mut html = String::from("<html><body>");
        for i in 0..3000 {
            html.push_str(&format!("<p>Paragraph {i} with a citation <a href=\"#ref-{}\">[{}]</a> and some more words to read.</p>", i % 500 + 1, i % 500 + 1));
        }
        html.push_str("<ol class=\"references\">");
        for i in 1..=500 {
            html.push_str(&format!("<li id=\"ref-{i}\">Author {i}. ({}) A title for reference number {i}. Journal. doi:10.1000/{i}</li>", 1950 + i % 70));
        }
        html.push_str("</ol></body></html>");
        let start = std::time::Instant::now();
        let scan = detect_web_references(&html, None);
        assert_eq!(scan.references.len(), 500);
        assert_eq!(scan.citations.len(), 500);
        assert!(start.elapsed().as_millis() < if cfg!(debug_assertions) { 5000 } else { 800 }, "{:?}", start.elapsed());
    }
}
