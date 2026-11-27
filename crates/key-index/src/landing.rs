// A publisher's landing page, read when Find PDF ends on it instead of on a PDF: the links on it
// that lead to the article's PDF (by the page's structure: citation_pdf_url and similar metadata,
// a PDF alternate, links whose address or wording says PDF; never a list of publishers), whether
// it shows an access wall (a sign-in or purchase form), and whether it holds the article's text
// or only its abstract. Key only points at what it finds; the person opens it themselves.
use crate::web_reflow;
use html5ever::tendril::TendrilSink;
use html5ever::tree_builder::TreeBuilderOpts;
use html5ever::{ParseOpts, parse_document};
use markup5ever_rcdom::{Handle, NodeData, RcDom};
use serde::Serialize;

/// One element of a page, flattened: its tag, attributes, its text (collapsed, capped) and
/// whether it sits in page furniture (navigation, header, footer, aside).
#[derive(Debug, Default, Clone)]
pub(crate) struct Element {
    pub tag: String,
    pub attrs: Vec<(String, String)>,
    pub text: String,
    pub furniture: bool,
}

impl Element {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

const TEXT_CAP: usize = 400;
/// Elements whose text is worth keeping (links, buttons, the title, forms' labels).
const TEXT_OF: &[&str] = &["a", "button", "title", "label", "h1", "h2", "h3", "p", "div", "span", "section", "form"];

/// The page's elements in document order (scripts and styles skipped).
pub(crate) fn elements(html: &str) -> Vec<Element> {
    let opts = ParseOpts { tree_builder: TreeBuilderOpts { scripting_enabled: false, ..Default::default() }, ..Default::default() };
    let dom = parse_document(RcDom::default(), opts).one(html);
    let mut out = Vec::new();
    walk(&dom.document, false, &mut out);
    out
}

fn text_of(handle: &Handle, into: &mut String) {
    if into.len() >= TEXT_CAP {
        return;
    }
    match &handle.data {
        NodeData::Text { contents } => {
            into.push(' ');
            into.push_str(&contents.borrow());
        }
        NodeData::Element { name, .. } if matches!(&*name.local, "script" | "style" | "noscript" | "template") => {}
        _ => {
            for child in handle.children.borrow().iter() {
                text_of(child, into);
            }
        }
    }
}

fn walk(handle: &Handle, furniture: bool, out: &mut Vec<Element>) {
    for child in handle.children.borrow().iter() {
        if let NodeData::Element { name, attrs, .. } = &child.data {
            let tag = name.local.to_string();
            if matches!(tag.as_str(), "script" | "style" | "noscript" | "template") {
                continue;
            }
            let attrs: Vec<(String, String)> = attrs.borrow().iter().map(|a| (a.name.local.to_string(), a.value.to_string())).collect();
            let role = attrs.iter().find(|(k, _)| k == "role").map(|(_, v)| v.as_str()).unwrap_or("");
            let inside = furniture || matches!(tag.as_str(), "nav" | "footer") || matches!(role, "navigation" | "contentinfo");
            let mut text = String::new();
            if TEXT_OF.contains(&tag.as_str()) {
                text_of(child, &mut text);
            }
            out.push(Element { tag, attrs, text: collapse(&text), furniture: inside });
            walk(child, inside, out);
        }
    }
}

pub(crate) fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The page's `<meta>` name/property → content pairs, names lowercased.
pub(crate) fn metas(elements: &[Element]) -> Vec<(String, String)> {
    elements
        .iter()
        .filter(|e| e.tag == "meta")
        .filter_map(|e| {
            let name = e.attr("name").or_else(|| e.attr("property"))?.trim().to_ascii_lowercase();
            let content = collapse(e.attr("content")?);
            (!name.is_empty() && !content.is_empty()).then_some((name, content))
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfLink {
    pub url: String,
    /// What the page calls it ("Download PDF"), or what it is ("The article's PDF").
    pub label: String,
    /// meta | alternate | link
    pub why: &'static str,
    #[serde(skip)]
    pub score: i32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Landing {
    /// Best first; at most four.
    pub links: Vec<PdfLink>,
    /// The page asks to sign in or to buy access before the article.
    pub wall: bool,
    /// The page seems to hold only the abstract (a landing page), not the article's text.
    pub abstract_only: bool,
    /// The page seems to hold the article's text.
    pub full_text: bool,
    /// Words of article text the page holds.
    pub words: usize,
    /// The page's own sign-in link (a person signs in there themselves).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sign_in: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
}

fn resolve(base: Option<&url::Url>, href: &str) -> Option<String> {
    let href = href.trim();
    if href.is_empty() || href.starts_with('#') {
        return None;
    }
    let parsed = match base {
        Some(base) => base.join(href).ok()?,
        None => url::Url::parse(href).ok()?,
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let mut parsed = parsed;
    parsed.set_fragment(None);
    Some(parsed.to_string())
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect()
}

/// How strongly an address says "a PDF": its file name, or a path segment or query value that is one.
fn url_score(url: &str) -> i32 {
    let Ok(parsed) = url::Url::parse(url) else { return 0 };
    let path = parsed.path().to_ascii_lowercase();
    if path.ends_with(".pdf") {
        return 50;
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.iter().any(|s| matches!(*s, "pdf" | "epdf" | "pdfft" | "pdfdirect" | "fullpdf" | "pdf-download" | "download-pdf")) {
        return 35;
    }
    if parsed.query_pairs().any(|(k, v)| {
        let (k, v) = (k.to_ascii_lowercase(), v.to_ascii_lowercase());
        v == "pdf" && matches!(k.as_str(), "type" | "format" | "download" | "blobtype" | "mime" | "output" | "view")
    }) {
        return 35;
    }
    0
}

/// Words that say a PDF is not the article: supplements, slides, citation files.
const NOT_THE_ARTICLE: &[&str] = &["supplement", "supplementary", "supporting", "appendix", "slides", "poster", "dataset", "citation", "cite", "ris", "bibtex", "endnote", "erratum", "license", "licence", "guide", "instructions", "policy", "terms", "brochure", "catalog", "catalogue", "flyer"];

fn link_score(element: &Element, url: &str) -> i32 {
    let label = [element.text.as_str(), element.attr("aria-label").unwrap_or(""), element.attr("title").unwrap_or("")].join(" ");
    let said = words(&label);
    let mut score = url_score(url);
    if element.attr("type").is_some_and(|t| t.to_ascii_lowercase().contains("pdf")) {
        score += 60;
    }
    if said.iter().any(|w| w == "pdf" || w == "epdf") {
        score += 40;
        if said.iter().any(|w| matches!(w.as_str(), "download" | "view" | "full" | "article" | "open" | "read" | "get")) {
            score += 10;
        }
    }
    if element.attr("download").is_some() && score > 0 {
        score += 10;
    }
    let said_url = words(url);
    if said.iter().chain(said_url.iter()).any(|w| NOT_THE_ARTICLE.contains(&w.as_str())) {
        score -= 70;
    }
    if element.furniture {
        score -= 60;
    }
    score
}

fn label_of(element: &Element) -> String {
    let text = element.text.trim();
    let text = if text.is_empty() { element.attr("aria-label").or(element.attr("title")).unwrap_or("").trim() } else { text };
    if text.is_empty() || text.chars().count() > 60 { "PDF".into() } else { text.to_string() }
}

/// Phrases of access walls: a sign-in, a subscription or a purchase before the article.
const WALL: &[&str] = &[
    "sign in to access",
    "log in to access",
    "login to access",
    "sign in to read",
    "log in to read",
    "access through your institution",
    "access through your organization",
    "check access",
    "get access",
    "purchase this article",
    "purchase access",
    "buy this article",
    "buy article",
    "rent this article",
    "subscribe to read",
    "subscribe to continue",
    "institutional login",
    "institutional access",
    "you do not have access",
    "you don't have access",
    "full access to this article",
    "access options",
];

/// Section headings an article's text has (and a landing page's abstract does not).
const BODY_HEADINGS: &[&str] = &["introduction", "background", "methods", "method", "materials and methods", "results", "discussion", "conclusion", "conclusions", "related work", "experiments", "data", "findings", "analysis"];

pub(crate) fn strip_numbering(text: &str) -> String {
    let mut words: Vec<&str> = text.split_whitespace().collect();
    while let Some(first) = words.first() {
        let bare = first.trim_end_matches(['.', ')', ':']);
        let numbering = !bare.is_empty()
            && (bare.chars().all(|c| c.is_ascii_digit() || c == '.')
                || (bare.len() <= 4 && bare.chars().all(|c| "ivxlcIVXLC".contains(c)))
                || (bare.len() == 1 && bare.chars().all(|c| c.is_ascii_uppercase()) && words.len() > 1));
        if numbering {
            words.remove(0);
        } else {
            break;
        }
    }
    words.join(" ")
}

/// Reads a landing page (its live HTML, with `url` its address).
pub fn read_landing(html: &str, url: &str) -> Landing {
    let base = url::Url::parse(url).ok();
    let elements = elements(html);
    let metas = metas(&elements);
    let meta = |names: &[&str]| names.iter().find_map(|n| metas.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone()));
    let mut links: Vec<PdfLink> = Vec::new();
    let mut add = |url: String, label: String, why: &'static str, score: i32| {
        if let Some(found) = links.iter_mut().find(|l| l.url == url) {
            if score > found.score {
                found.score = score;
            }
            if found.why == "meta" && why == "link" && label != "PDF" {
                found.label = label;
            }
            return;
        }
        links.push(PdfLink { url, label, why, score });
    };
    for (name, content) in &metas {
        if matches!(name.as_str(), "citation_pdf_url" | "eprints.document_url" | "bepress_citation_pdf_url" | "dc.identifier.pdf" | "prism.url.pdf") {
            if let Some(url) = resolve(base.as_ref(), content) {
                add(url, "The article’s PDF".into(), "meta", 100);
            }
        }
    }
    for element in &elements {
        match element.tag.as_str() {
            "link" => {
                let rel = element.attr("rel").unwrap_or("").to_ascii_lowercase();
                let kind = element.attr("type").unwrap_or("").to_ascii_lowercase();
                if rel.split_whitespace().any(|r| r == "alternate") && kind.contains("pdf") {
                    if let Some(url) = element.attr("href").and_then(|h| resolve(base.as_ref(), h)) {
                        add(url, "The article’s PDF".into(), "alternate", 90);
                    }
                }
            }
            "a" | "button" | "area" => {
                let href = element.attr("href").or_else(|| element.attr("data-href")).or_else(|| element.attr("data-url")).or_else(|| element.attr("data-pdf-url"));
                let Some(url) = href.and_then(|h| resolve(base.as_ref(), h)) else { continue };
                let score = link_score(element, &url);
                if score >= 40 {
                    add(url, label_of(element), "link", score);
                }
            }
            _ => {}
        }
    }
    // The page itself is no link to its own PDF.
    if let Some(own) = base.as_ref().map(|b| b.to_string()) {
        links.retain(|l| l.url != own);
    }
    links.sort_by(|a, b| b.score.cmp(&a.score));
    links.truncate(4);

    let page_text = elements.iter().filter(|e| matches!(e.tag.as_str(), "a" | "button" | "label" | "p" | "h1" | "h2" | "h3" | "form" | "section" | "div" | "span")).map(|e| e.text.to_lowercase()).collect::<Vec<_>>().join(" ");
    let password = elements.iter().any(|e| e.tag == "input" && e.attr("type").is_some_and(|t| t.eq_ignore_ascii_case("password")));
    let wall = password || WALL.iter().any(|w| page_text.contains(w));

    let sign_in = elements
        .iter()
        .filter(|e| e.tag == "a" && e.text.chars().count() <= 60)
        .find(|e| {
            let t = e.text.to_lowercase();
            ["sign in", "log in", "login", "institutional login", "access through your institution", "sign in via", "shibboleth", "openathens"].iter().any(|w| t.contains(w))
        })
        .and_then(|e| e.attr("href").and_then(|h| resolve(base.as_ref(), h)));
    let document = web_reflow::assemble(html).document;
    let body_words: usize = document.items.iter().filter(|i| matches!(i.kind.as_str(), "paragraph" | "list")).map(|i| i.text.split_whitespace().count()).sum();
    let headings: Vec<String> = document.items.iter().filter(|i| i.kind == "heading").map(|i| strip_numbering(&i.text).to_lowercase()).collect();
    let body_headings = headings.iter().filter(|h| BODY_HEADINGS.iter().any(|b| h.as_str() == *b || h.starts_with(&format!("{b} ")))).count();
    let has_abstract = meta(&["citation_abstract", "dc.description", "description", "og:description"]).is_some() || headings.iter().any(|h| h == "abstract" || h == "summary");
    let full_text = body_words >= 1200 && (body_headings >= 2 || headings.len() >= 4);
    let abstract_only = !full_text && (has_abstract || body_words >= 40);
    Landing {
        links,
        wall,
        abstract_only,
        full_text,
        words: body_words,
        sign_in: wall.then_some(sign_in).flatten(),
        title: meta(&["citation_title", "dc.title", "og:title"]),
        doi: meta(&["citation_doi", "dc.identifier", "prism.doi"]).and_then(|d| d.find("10.").map(|i| d[i..].to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LANDING: &str = r#"<!doctype html><html><head><title>Rivers and towns</title>
      <meta name="citation_title" content="Rivers and towns">
      <meta name="citation_doi" content="10.5555/rivers">
      <meta name="citation_abstract" content="We study rivers.">
      </head><body>
      <nav><a href="/journal/about.pdf">About the journal (PDF)</a></nav>
      <main><h1>Rivers and towns</h1><h2>Abstract</h2><p>We study rivers and the towns along them, with data from many places.</p>
      <div class="tools"><a class="btn" href="/doi/epdf/10.5555/rivers" aria-label="View PDF"><svg></svg></a>
      <a href="/doi/suppl/10.5555/rivers/appendix.pdf">Supplementary material (PDF)</a>
      <a href="/doi/10.5555/rivers/download?format=pdf" download>Download</a>
      <a href="/cite">Cite</a></div>
      <p>Access through your institution</p><a href="/action/login">Sign in</a></main></body></html>"#;

    #[test]
    fn finds_the_pdf_links_by_structure() {
        let landing = read_landing(LANDING, "https://journal.example/doi/10.5555/rivers");
        let urls: Vec<&str> = landing.links.iter().map(|l| l.url.as_str()).collect();
        assert_eq!(urls, ["https://journal.example/doi/epdf/10.5555/rivers", "https://journal.example/doi/10.5555/rivers/download?format=pdf"], "{landing:#?}");
        assert_eq!(landing.links[0].label, "View PDF");
        assert!(landing.wall);
        assert_eq!(landing.sign_in.as_deref(), Some("https://journal.example/action/login"));
        assert!(landing.abstract_only && !landing.full_text);
        assert_eq!(landing.doi.as_deref(), Some("10.5555/rivers"));
    }

    #[test]
    fn prefers_the_citation_pdf_url_and_reads_a_full_text_page() {
        let mut body = String::from(r#"<html><head><meta name="citation_pdf_url" content="/files/rivers.pdf"><link rel="alternate" type="application/pdf" href="/files/rivers.pdf"></head><body><article><h1>Rivers</h1>"#);
        for section in ["Introduction", "Methods", "Results", "Discussion"] {
            body.push_str(&format!("<h2>{section}</h2>"));
            for _ in 0..12 {
                body.push_str("<p>Rivers carry water and goods between towns, and the towns along them grow with the trade that the water brings to their markets every season of the year.</p>");
            }
        }
        body.push_str(r#"<a href="/files/rivers.pdf">Download PDF</a></article></body></html>"#);
        let landing = read_landing(&body, "https://repo.example/rivers");
        assert_eq!(landing.links.len(), 1);
        assert_eq!((landing.links[0].url.as_str(), landing.links[0].why, landing.links[0].label.as_str()), ("https://repo.example/files/rivers.pdf", "meta", "Download PDF"));
        assert!(landing.full_text && !landing.abstract_only && !landing.wall);
    }

    #[test]
    fn a_page_without_pdf_links_has_none() {
        let landing = read_landing("<html><body><p>Hello</p><a href='/x'>Next</a></body></html>", "https://x.example/");
        assert!(landing.links.is_empty());
        assert!(!landing.wall);
    }
}
