// Reading mode for a saved web page: the article in the snapshot as clean text, in the same
// document shape as a PDF's reading mode (reflow.rs), so one view shows both.
//
// The page is parsed with html5ever, exactly as the browser parses it, and the elements the web
// reader's sanitiser takes out (scripts, frames, plugins …) are left out here too. The page's text
// is then the same string, character for character, as the reader's text index (web-anchors.ts:
// the body's text nodes in order, without script, style, noscript, template and textarea text),
// so every piece of reading-mode text keeps its exact place there (`Run::at`, UTF-16 offsets).
// That is what highlights on the page are anchored to: they show on their words in reading
// mode (`marks`), a selection in reading mode becomes a highlight at the real place (`locate`),
// and places and search hits go both ways (`item_at`, `project`).
//
// Finding the article is readability-style: boilerplate (navigation, cookie and consent banners,
// share bars, ads, newsletter boxes, comments, related links, hidden elements) is dropped, the
// deepest element holding most of the remaining prose is the article, and its content becomes
// headings, paragraphs, lists, quotes, code, tables, figures with captions (their pictures from
// the snapshot's own inlined copies), equations (MathML kept), footnotes and a reference list,
// with in-text citation links pointing at their reference.
use crate::reflow::{Caption, Cell, Document, Image, Item, Mark, Meta, OutlineEntry, Quality, Run, Span, Table, caption_kind};
use html5ever::tendril::TendrilSink;
use html5ever::tree_builder::TreeBuilderOpts;
use html5ever::{ParseOpts, parse_document};
use markup5ever_rcdom::{Handle, NodeData, RcDom};
use serde::Serialize;
use serde_json::Value as Json;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq)]
enum Space {
    Html,
    Svg,
    Math,
    Other,
}

#[derive(Debug)]
struct Node {
    /// Local name; empty for a text node.
    tag: String,
    space: Space,
    attrs: Vec<(String, String)>,
    children: Vec<usize>,
    parent: Option<usize>,
    text: String,
    /// A text node's place in the page's text (UTF-16), when it is in the reader's index.
    at: Option<usize>,
    depth: usize,
}

/// Elements the reader's sanitiser removes (WebPageReader.tsx `sanitizeSnapshot`).
const REMOVED: &[&str] = &["script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "portal", "base", "link"];
/// Text the reader's index skips: its parent is one of these (HTML elements only).
const UNINDEXED: &[&str] = &["script", "style", "noscript", "template", "textarea"];

struct Page {
    nodes: Vec<Node>,
    body: Option<usize>,
    head: Option<usize>,
    /// The reader's text index, as UTF-16.
    text: Vec<u16>,
}

impl Page {
    fn parse(html: &str) -> Page {
        let opts = ParseOpts { tree_builder: TreeBuilderOpts { scripting_enabled: false, ..Default::default() }, ..Default::default() };
        let dom = parse_document(RcDom::default(), opts).one(html);
        let mut page = Page { nodes: Vec::new(), body: None, head: None, text: Vec::new() };
        page.nodes.push(Node { tag: "#document".into(), space: Space::Other, attrs: Vec::new(), children: Vec::new(), parent: None, text: String::new(), at: None, depth: 0 });
        // Depth first, in document order; `indexed` says the subtree's text is in the reader's index.
        let mut stack: Vec<(Handle, usize, bool)> = dom.document.children.borrow().iter().rev().map(|h| (h.clone(), 0, false)).collect();
        while let Some((handle, parent, in_body)) = stack.pop() {
            let depth = page.nodes[parent].depth + 1;
            match &handle.data {
                NodeData::Text { contents } => {
                    let text = contents.borrow().to_string();
                    let p = &page.nodes[parent];
                    let skipped = p.space == Space::Html && UNINDEXED.contains(&p.tag.as_str());
                    let at = (in_body && !skipped).then(|| {
                        let at = page.text.len();
                        page.text.extend(text.encode_utf16());
                        at
                    });
                    let id = page.nodes.len();
                    page.nodes.push(Node { tag: String::new(), space: Space::Other, attrs: Vec::new(), children: Vec::new(), parent: Some(parent), text, at, depth });
                    page.nodes[parent].children.push(id);
                }
                NodeData::Element { name, attrs, .. } => {
                    let tag = name.local.to_string();
                    let space = if &*name.ns == "http://www.w3.org/1999/xhtml" {
                        Space::Html
                    } else if &*name.ns == "http://www.w3.org/2000/svg" {
                        Space::Svg
                    } else if &*name.ns == "http://www.w3.org/1998/Math/MathML" {
                        Space::Math
                    } else {
                        Space::Other
                    };
                    let attrs: Vec<(String, String)> = attrs
                        .borrow()
                        .iter()
                        .map(|a| (a.name.prefix.as_ref().map_or_else(|| a.name.local.to_string(), |p| format!("{p}:{}", a.name.local)), a.value.to_string()))
                        .collect();
                    if REMOVED.contains(&tag.as_str()) || (tag == "meta" && attrs.iter().any(|(k, _)| k == "http-equiv")) {
                        continue;
                    }
                    let id = page.nodes.len();
                    let body = space == Space::Html && tag == "body" && page.body.is_none() && page.nodes[parent].tag == "html";
                    if body {
                        page.body = Some(id);
                    }
                    if space == Space::Html && tag == "head" && page.head.is_none() {
                        page.head = Some(id);
                    }
                    page.nodes.push(Node { tag, space, attrs, children: Vec::new(), parent: Some(parent), text: String::new(), at: None, depth });
                    page.nodes[parent].children.push(id);
                    for child in handle.children.borrow().iter().rev() {
                        stack.push((child.clone(), id, in_body || body));
                    }
                }
                _ => {}
            }
        }
        page
    }

    fn is_text(&self, id: usize) -> bool {
        self.nodes[id].tag.is_empty()
    }
    fn html(&self, id: usize, tag: &str) -> bool {
        let n = &self.nodes[id];
        n.space == Space::Html && n.tag == tag
    }
    fn attr(&self, id: usize, name: &str) -> Option<&str> {
        self.nodes[id].attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    /// Class and id words, lowercased, each also split at `-` and `_`.
    fn words(&self, id: usize) -> (Vec<String>, Vec<String>) {
        let whole: Vec<String> = [self.attr(id, "class"), self.attr(id, "id")].into_iter().flatten().flat_map(|v| v.split_whitespace()).map(str::to_lowercase).collect();
        let parts = whole.iter().flat_map(|w| w.split(['-', '_']).filter(|p| !p.is_empty()).map(str::to_string).collect::<Vec<_>>()).collect();
        (whole, parts)
    }
    fn has_word(&self, id: usize, list: &[&str]) -> bool {
        let (whole, parts) = self.words(id);
        whole.iter().chain(parts.iter()).any(|w| list.contains(&w.as_str()))
    }
    fn descendants(&self, id: usize) -> Vec<usize> {
        let mut out = Vec::new();
        let mut stack: Vec<usize> = self.nodes[id].children.iter().rev().copied().collect();
        while let Some(n) = stack.pop() {
            out.push(n);
            stack.extend(self.nodes[n].children.iter().rev());
        }
        out
    }
    fn raw_text(&self, id: usize) -> String {
        if self.is_text(id) {
            return self.nodes[id].text.clone();
        }
        self.descendants(id).into_iter().filter(|&n| self.is_text(n)).map(|n| self.nodes[n].text.as_str()).collect()
    }
    fn collapsed(&self, id: usize) -> String {
        collapse(&self.raw_text(id))
    }
    fn ancestors(&self, id: usize) -> impl Iterator<Item = usize> + '_ {
        std::iter::successors(self.nodes[id].parent, move |&p| self.nodes[p].parent)
    }
    fn hidden(&self, id: usize) -> bool {
        if self.attr(id, "hidden").is_some() || self.attr(id, "aria-hidden") == Some("true") || self.attr(id, "type") == Some("hidden") {
            return true;
        }
        if let Some(style) = self.attr(id, "style") {
            let s: String = style.to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
            if s.contains("display:none") || s.contains("visibility:hidden") {
                return true;
            }
        }
        self.attr(id, "class").is_some_and(|c| c.split_whitespace().any(|w| matches!(w, "sr-only" | "visually-hidden" | "screen-reader-text" | "screen-reader-only" | "hidden" | "d-none" | "u-hidden" | "is-hidden" | "offscreen")))
    }
    fn metas(&self) -> Vec<(String, String)> {
        let Some(head) = self.head else { return Vec::new() };
        let mut out = Vec::new();
        for n in self.descendants(head).into_iter().chain(self.body.map(|b| self.descendants(b)).unwrap_or_default()) {
            if self.html(n, "meta") {
                let key = self.attr(n, "name").or_else(|| self.attr(n, "property")).or_else(|| self.attr(n, "itemprop")).unwrap_or("").to_lowercase();
                if let (false, Some(content)) = (key.is_empty(), self.attr(n, "content")) {
                    out.push((key, content.trim().to_string()));
                }
            }
        }
        out
    }
}

fn collapse(text: &str) -> String {
    text.split_ascii_whitespace().collect::<Vec<_>>().join(" ")
}
fn is_html_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{c}')
}
fn is_js_space(u: u16) -> bool {
    matches!(u, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

// ---------------------------------------------------------------------------------------------
// Inline text with its mapping to the page.

#[derive(Default)]
struct Inline {
    text: Vec<u16>,
    /// Per UTF-16 unit, its place in the page's text.
    units: Vec<Option<usize>>,
    spans: Vec<Span>,
    /// Whitespace waiting to become one space (with the place of the space it came from, when
    /// that was a plain space).
    space: Option<Option<usize>>,
}

impl Inline {
    fn len(&self) -> usize {
        self.text.len()
    }
    fn push(&mut self, c: char, at: Option<usize>) {
        let mut buf = [0u16; 2];
        for (k, u) in c.encode_utf16(&mut buf).iter().enumerate() {
            self.text.push(*u);
            self.units.push(at.map(|a| a + k));
        }
    }
    fn flush_space(&mut self) {
        if let Some(at) = self.space.take() {
            if self.text.last().is_some_and(|&u| u != b' ' as u16 && u != b'\n' as u16) {
                self.push(' ', at);
            }
        }
    }
    fn add(&mut self, s: &str, at: Option<usize>, pre: bool) {
        let mut offset = 0;
        for c in s.chars() {
            let here = at.map(|a| a + offset);
            offset += c.len_utf16();
            if pre {
                self.push(c, here);
            } else if is_html_space(c) {
                if self.space.is_none() {
                    self.space = Some(if c == ' ' { here } else { None });
                }
            } else {
                self.flush_space();
                self.push(c, here);
            }
        }
    }
    /// Text that is not on the page as such (a line break, a picture's stand-in character).
    fn add_unmapped(&mut self, c: char) {
        if c != '\n' {
            self.flush_space();
        } else {
            self.space = None;
            while self.text.last() == Some(&(b' ' as u16)) {
                self.text.pop();
                self.units.pop();
            }
        }
        self.push(c, None);
    }
    fn is_empty(&self) -> bool {
        self.text.iter().all(|&u| is_js_space(u))
    }
    /// Closes a span opened at `start` (skipping a space that landed at its start).
    fn close_span(&mut self, mut span: Span, start: usize) {
        let mut start = start;
        while start < self.len() && self.text[start] == b' ' as u16 {
            start += 1;
        }
        let end = self.len();
        if end > start {
            span.start = start;
            span.end = end;
            self.spans.push(span);
        }
    }
    fn finish(mut self) -> (String, Vec<Run>, Vec<Span>) {
        while self.text.last().is_some_and(|&u| u == b' ' as u16 || u == b'\n' as u16) {
            self.text.pop();
            self.units.pop();
        }
        let lead = self.text.iter().take_while(|&&u| u == b' ' as u16 || u == b'\n' as u16).count();
        if lead > 0 {
            self.text.drain(..lead);
            self.units.drain(..lead);
        }
        let len = self.text.len();
        let spans = self
            .spans
            .into_iter()
            .filter_map(|mut s| {
                s.start = s.start.saturating_sub(lead).min(len);
                s.end = s.end.saturating_sub(lead).min(len);
                (s.end > s.start).then_some(s)
            })
            .collect();
        let mut runs: Vec<Run> = Vec::new();
        for (i, unit) in self.units.iter().enumerate() {
            let Some(at) = *unit else { continue };
            match runs.last_mut() {
                Some(run) if run.end == i && run.at.map(|a| a + (i - run.start)) == Some(at) => run.end = i + 1,
                _ => runs.push(Run { start: i, end: i + 1, page: 0, rects: Vec::new(), at: Some(at) }),
            }
        }
        (String::from_utf16_lossy(&self.text), runs, spans)
    }
}

// ---------------------------------------------------------------------------------------------
// Boilerplate and the article.

/// Class or id words of things that are never the article.
const BOILERPLATE: &[&str] = &[
    "cookie", "cookies", "consent", "gdpr", "cmp", "newsletter", "subscribe", "subscription", "signup", "share", "sharing", "sharebar", "social", "socials",
    "advert", "advertisement", "advertising", "ad", "ads", "adslot", "adunit", "sponsor", "sponsored", "promo", "outbrain", "taboola", "popup", "modal",
    "overlay", "paywall", "comments", "comment", "disqus", "related", "recommended", "recommendations", "trending", "breadcrumb", "breadcrumbs",
    "pagination", "pager", "skiplink", "toc", "toolbar", "tools", "kicker", "eyebrow",
];
/// Whole class or id names of a site's own chrome.
fn chrome_name(word: &str) -> bool {
    let w = word.trim_start_matches(|c: char| !c.is_alphanumeric());
    let w = ["site", "global", "page", "main", "top", "primary", "nav"].iter().find_map(|p| w.strip_prefix(p).map(|r| r.trim_start_matches(['-', '_']))).filter(|r| !r.is_empty()).unwrap_or(w);
    matches!(w, "header" | "footer" | "nav" | "navbar" | "navigation" | "menu" | "sidebar" | "masthead" | "banner" | "widget" | "widgets" | "aside")
}
const KEEP: &[&str] = &["footnote", "footnotes", "fn", "endnotes", "box", "boxed", "callout", "note", "notes", "textbox", "references", "ref", "bibliography"];
const REFERENCE_WORDS: &[&str] = &["references", "reference-list", "ref-list", "reflist", "bibliography", "bibl", "citations", "literature-cited", "works-cited", "refs"];
const FOOTNOTE_WORDS: &[&str] = &["footnote", "footnotes", "fn-group", "fn", "endnotes", "notes"];
const FIGURE_WORDS: &[&str] = &["fig", "figure", "figures", "fig-wrap", "figure-wrap", "graphic", "image-wrap", "table-wrap", "tablewrap", "media"];
const FORMULA_WORDS: &[&str] = &["disp-formula", "display-formula", "equation", "formula", "math-display", "displaymath", "ltx_equation", "ltx_equationgroup"];
const CAPTION_WORDS: &[&str] = &["caption", "figcaption", "fig-caption", "figure-caption", "legend", "caption-text", "ltx_caption", "label", "fig-label", "table-caption"];
const BYLINE_WORDS: &[&str] = &["byline", "author", "authors", "author-name", "authors-list", "contrib-group", "contributors", "article-author", "ltx_authors"];

fn references_heading(text: &str) -> bool {
    let t = text.trim().trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ' ').to_lowercase();
    matches!(t.trim_end_matches(':'), "references" | "reference list" | "bibliography" | "works cited" | "literature cited" | "notes and references" | "references and notes" | "cited literature" | "citations" | "sources" | "literatur")
}

struct Article {
    dropped: Vec<bool>,
    root: usize,
}

fn link_density(page: &Page, id: usize) -> f32 {
    let total = page.collapsed(id).chars().count().max(1);
    let links: usize = page.descendants(id).into_iter().filter(|&n| page.html(n, "a")).map(|n| page.collapsed(n).chars().count()).sum();
    links as f32 / total as f32
}

fn find_article(page: &Page) -> Option<Article> {
    let body = page.body?;
    let count = page.nodes.len();
    // Prose each element holds directly: paragraph-like blocks of real sentences.
    let mut own = vec![0usize; count];
    for id in page.descendants(body) {
        if page.is_text(id) {
            continue;
        }
        let n = &page.nodes[id];
        if n.space != Space::Html {
            continue;
        }
        let text = || page.collapsed(id).chars().count();
        let len = match n.tag.as_str() {
            "p" | "pre" | "figcaption" | "dd" => text(),
            "li" | "blockquote" => Some(text()).filter(|&l| l >= 60).unwrap_or(0),
            "td" => Some(text()).filter(|&l| l >= 80).unwrap_or(0),
            "div" | "section" | "article" | "main" | "span" => n.children.iter().filter(|&&c| page.is_text(c)).map(|&c| collapse(&page.nodes[c].text).chars().count()).sum::<usize>(),
            _ => 0,
        };
        if len >= 25 && link_density(page, id) < 0.5 {
            own[id] = len;
        }
    }
    let mut total = own.clone();
    for id in (0..count).rev() {
        if let Some(p) = page.nodes[id].parent {
            total[p] += total[id];
        }
    }
    let all = total[body].max(1);
    // Boilerplate, unless it holds much of the page's prose.
    let mut dropped = vec![false; count];
    for id in page.descendants(body) {
        if page.is_text(id) {
            continue;
        }
        if page.nodes[id].parent.is_some_and(|p| dropped[p]) {
            dropped[id] = true;
            continue;
        }
        dropped[id] = page.hidden(id) || (boilerplate(page, id) && total[id] * 5 < all * 2);
    }
    let mut kept = vec![0usize; count];
    for id in (0..count).rev() {
        if dropped[id] {
            continue;
        }
        kept[id] += own[id];
        if let Some(p) = page.nodes[id].parent {
            kept[p] += kept[id];
        }
    }
    let wanted = kept[body] * 4 / 5;
    let mut root = body;
    for id in page.descendants(body) {
        if !page.is_text(id) && !dropped[id] && kept[id] >= wanted.max(1) && page.nodes[id].depth > page.nodes[root].depth {
            root = id;
        }
    }
    // Up through wrappers, and to take in sections beside it (references, notes) that hold little.
    let first = kept[root];
    while let Some(parent) = page.nodes[root].parent.filter(|&p| p != body && page.nodes[p].tag != "html" && kept[p] * 2 <= first * 3) {
        root = parent;
    }
    // An article element around it is the article.
    if let Some(article) = page.ancestors(root).take_while(|&a| a != body).filter(|&a| page.html(a, "article") || page.html(a, "main") || page.attr(a, "role") == Some("main") || page.attr(a, "itemprop") == Some("articleBody")).last() {
        if kept[article] <= first * 2 {
            root = article;
        }
    }
    Some(Article { dropped, root })
}

fn boilerplate(page: &Page, id: usize) -> bool {
    let n = &page.nodes[id];
    if n.space != Space::Html {
        return false;
    }
    let keep = || page.has_word(id, KEEP) || matches!(page.attr(id, "role"), Some("doc-footnote" | "doc-endnotes" | "doc-bibliography" | "note"));
    let has_heading = || page.descendants(id).into_iter().any(|d| page.html(d, "h1"));
    match n.tag.as_str() {
        "nav" | "form" | "button" | "select" | "input" | "textarea" | "dialog" | "menu" | "label" | "option" => return true,
        "aside" => return !keep() || page.words(id).1.iter().any(|w| BOILERPLATE.contains(&w.as_str())),
        "footer" => return !keep() && !page.descendants(id).into_iter().any(|d| page.html(d, "ol") || (page.nodes[d].tag.starts_with('h') && references_heading(&page.collapsed(d)))),
        "header" => return !has_heading() && !page.ancestors(id).any(|a| page.html(a, "article") || page.html(a, "main")),
        "body" | "html" | "article" | "main" => return false,
        _ => {}
    }
    if let Some(role) = page.attr(id, "role") {
        if matches!(role, "navigation" | "contentinfo" | "complementary" | "search" | "dialog" | "alertdialog" | "menu" | "menubar" | "toolbar" | "tablist") || (role == "banner" && !has_heading()) {
            return true;
        }
    }
    if keep() {
        return false;
    }
    let (whole, parts) = page.words(id);
    whole.iter().any(|w| chrome_name(w)) || parts.iter().any(|w| BOILERPLATE.contains(&w.as_str()))
}

// ---------------------------------------------------------------------------------------------
// The document.

/// A saved web page in reading mode: the document, the page's text (to place anchors in) and the
/// pictures the document refers to by number.
pub struct WebDocument {
    pub document: Document,
    pub text: Vec<u16>,
    pub resources: Vec<String>,
}

impl WebDocument {
    /// The page text's length and a checksum (FNV-1a over UTF-16 units), so the reader can
    /// check that its own text index is the same text.
    pub fn fingerprint(&self) -> (usize, u32) {
        let mut h: u32 = 0x811c_9dc5;
        for &u in &self.text {
            h ^= u as u32;
            h = h.wrapping_mul(16_777_619);
        }
        (self.text.len(), h)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Flow {
    Paragraph,
    Quote,
    Footnote,
    References,
    List,
}
impl Flow {
    fn kind(self) -> &'static str {
        match self {
            Flow::Paragraph => "paragraph",
            Flow::Quote => "quote",
            Flow::Footnote => "footnote",
            Flow::References => "references",
            Flow::List => "list",
        }
    }
}

#[derive(Clone, Copy)]
struct Ctx {
    flow: Flow,
    depth: u8,
    pre: bool,
    /// Everything inline (a heading's or caption's content).
    flat: bool,
}

struct Emitter<'p> {
    page: &'p Page,
    dropped: &'p [bool],
    consumed: HashSet<usize>,
    items: Vec<Item>,
    resources: Vec<String>,
    resource_of: HashMap<u64, usize>,
    anchors: Vec<String>,
    marker: Option<String>,
    /// Inside a "References" section: until a heading of this level or higher.
    references_until: Option<u8>,
    base: Option<String>,
    depth: usize,
}

const MAX_DEPTH: usize = 300;

impl<'p> Emitter<'p> {
    fn push_item(&mut self, mut item: Item) -> usize {
        item.anchors.append(&mut self.anchors);
        item.id = self.items.len();
        self.items.push(item);
        self.items.len() - 1
    }

    fn flush(&mut self, inl: &mut Inline, ctx: &Ctx) {
        let taken = std::mem::take(inl);
        if taken.is_empty() {
            return;
        }
        let (text, runs, spans) = taken.finish();
        if text.is_empty() {
            return;
        }
        let mut flow = ctx.flow;
        if self.references_until.is_some() && matches!(flow, Flow::Paragraph | Flow::List) {
            flow = Flow::References;
        }
        let item = Item { kind: flow.kind().into(), level: (flow == Flow::List).then_some(ctx.depth.max(1)), text, runs, spans, marker: self.marker.take(), ..Default::default() };
        self.push_item(item);
    }

    fn children(&mut self, id: usize, ctx: &Ctx, inl: &mut Inline) {
        self.depth += 1;
        let page = self.page;
        for &child in &page.nodes[id].children {
            self.node(child, ctx, inl);
        }
        self.depth -= 1;
    }

    /// A container's content as blocks of their own.
    fn flow(&mut self, id: usize, ctx: &Ctx) {
        let mut inl = Inline::default();
        self.children(id, ctx, &mut inl);
        self.flush(&mut inl, ctx);
    }

    fn node(&mut self, id: usize, ctx: &Ctx, inl: &mut Inline) {
        let page = self.page;
        let n = &page.nodes[id];
        if n.tag.is_empty() {
            inl.add(&n.text, n.at, ctx.pre);
            return;
        }
        if self.dropped[id] || self.consumed.contains(&id) {
            return;
        }
        // A date standing on its own line is the page's date, shown under the title already.
        if page.html(id, "time") && !ctx.flat && n.parent.is_some_and(|p| page.collapsed(p) == page.collapsed(id) || !matches!(page.nodes[p].tag.as_str(), "p" | "li" | "td" | "span" | "a" | "em" | "strong" | "dd")) {
            return;
        }
        let block = !ctx.flat && self.depth < MAX_DEPTH && self.is_block(id);
        if block {
            self.flush(inl, ctx);
        }
        if let Some(anchor) = page.attr(id, "id").or_else(|| page.html(id, "a").then(|| page.attr(id, "name")).flatten()) {
            if !anchor.is_empty() {
                self.anchors.push(anchor.to_string());
            }
        }
        if block {
            self.block(id, ctx);
        } else {
            self.inline(id, ctx, inl);
        }
    }

    fn is_block(&self, id: usize) -> bool {
        let page = self.page;
        let n = &page.nodes[id];
        match n.space {
            Space::Html => {
                if matches!(
                    n.tag.as_str(),
                    "p" | "div" | "section" | "article" | "main" | "header" | "footer" | "hgroup" | "address" | "center" | "details" | "summary" | "fieldset" | "dl" | "dt" | "dd" | "li"
                        | "ul" | "ol" | "menu" | "blockquote" | "pre" | "table" | "figure" | "figcaption" | "hr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "aside" | "nav" | "form"
                        | "caption" | "tr" | "td" | "th" | "tbody" | "thead" | "tfoot"
                ) {
                    return true;
                }
                if n.tag == "img" {
                    return self.big_image(id);
                }
                false
            }
            Space::Svg => n.tag == "svg" && self.svg_size(id).is_none_or(|(w, h)| w >= 120.0 && h >= 60.0),
            Space::Math => n.tag == "math" && page.attr(id, "display") == Some("block"),
            Space::Other => self.math_in(id).is_some_and(|m| page.attr(m, "display") == Some("block") || page.attr(id, "display") == Some("true")),
        }
    }

    fn heading_level(&self, id: usize) -> Option<u8> {
        let n = &self.page.nodes[id];
        if n.space != Space::Html {
            return None;
        }
        match n.tag.as_str() {
            "h1" => Some(1),
            "h2" => Some(2),
            "h3" => Some(3),
            "h4" => Some(4),
            "h5" => Some(5),
            "h6" => Some(6),
            _ => None,
        }
    }

    fn block(&mut self, id: usize, ctx: &Ctx) {
        let page = self.page;
        let tag = page.nodes[id].tag.clone();
        if let Some(level) = self.heading_level(id) {
            return self.heading(id, level, ctx);
        }
        if page.nodes[id].space == Space::Svg {
            if let Some(resource) = self.svg_resource(id) {
                let alt = page.descendants(id).into_iter().find(|&d| page.nodes[d].tag == "title").map(|d| page.collapsed(d)).unwrap_or_default();
                self.push_item(Item { kind: "figure".into(), images: vec![Image { resource: Some(resource), alt, width: self.svg_size(id).map(|s| s.0 as u32), height: self.svg_size(id).map(|s| s.1 as u32) }], ..Default::default() });
            }
            return;
        }
        if page.nodes[id].space != Space::Html {
            return self.equation(id, None);
        }
        let mut inner = *ctx;
        match tag.as_str() {
            "hr" => {}
            "img" => {
                let image = self.image(id);
                if image.resource.is_some() {
                    self.push_item(Item { kind: "figure".into(), images: vec![image], ..Default::default() });
                }
            }
            "ul" | "ol" | "menu" => self.list(id, ctx),
            "blockquote" => {
                inner.flow = if ctx.flow == Flow::Paragraph { Flow::Quote } else { ctx.flow };
                self.flow(id, &inner);
            }
            "pre" => {
                let mut inl = Inline::default();
                self.children(id, &Ctx { pre: true, flat: true, ..*ctx }, &mut inl);
                let (text, runs, spans) = inl.finish();
                if !text.is_empty() {
                    self.push_item(Item { kind: "code".into(), text, runs, spans, ..Default::default() });
                }
            }
            "table" => self.table(id, None),
            "figure" => self.figure(id, ctx),
            _ => {
                if self.has_formula_words(id) && (self.math_in(id).is_some() || page.descendants(id).into_iter().any(|d| page.html(d, "img"))) {
                    return self.equation(id, None);
                }
                if page.has_word(id, FIGURE_WORDS) && page.descendants(id).into_iter().any(|d| page.html(d, "img") || page.html(d, "table") || page.nodes[d].tag == "svg") {
                    return self.figure(id, ctx);
                }
                if page.has_word(id, REFERENCE_WORDS) || page.attr(id, "role") == Some("doc-bibliography") {
                    inner.flow = Flow::References;
                } else if page.has_word(id, FOOTNOTE_WORDS) || matches!(page.attr(id, "role"), Some("doc-footnote" | "doc-endnotes")) {
                    inner.flow = Flow::Footnote;
                }
                if inner.flow == Flow::References && page.nodes[id].tag != "ol" {
                    // Each entry of a reference list in divs is an item of its own.
                    self.flow(id, &inner);
                } else {
                    self.flow(id, &inner);
                }
            }
        }
    }

    fn has_formula_words(&self, id: usize) -> bool {
        self.page.has_word(id, FORMULA_WORDS)
    }

    fn heading(&mut self, id: usize, level: u8, ctx: &Ctx) {
        let mut inl = Inline::default();
        self.children(id, &Ctx { flat: true, ..*ctx }, &mut inl);
        let (text, runs, spans) = inl.finish();
        if text.is_empty() {
            return;
        }
        if self.references_until.is_some_and(|l| level <= l) {
            self.references_until = None;
        }
        if references_heading(&text) {
            self.references_until = Some(level);
        }
        self.push_item(Item { kind: "heading".into(), level: Some(level), text, runs, spans, ..Default::default() });
    }

    fn list(&mut self, id: usize, ctx: &Ctx) {
        let page = self.page;
        let ordered = page.html(id, "ol");
        let items: Vec<usize> = page.nodes[id].children.iter().copied().filter(|&c| page.html(c, "li")).collect();
        let in_references = ctx.flow == Flow::References || self.references_until.is_some() || page.has_word(id, REFERENCE_WORDS);
        // A list of links (a table of contents, more stories) is navigation.
        if !in_references && !items.is_empty() && link_density(page, id) > 0.6 {
            let average = page.collapsed(id).chars().count() / items.len();
            if average < 80 {
                return;
            }
        }
        let mut number: i64 = page.attr(id, "start").and_then(|s| s.trim().parse().ok()).unwrap_or(1);
        let flow = if in_references {
            Flow::References
        } else if matches!(ctx.flow, Flow::Footnote | Flow::Quote) {
            ctx.flow
        } else {
            Flow::List
        };
        let inner = Ctx { flow, depth: ctx.depth + 1, ..*ctx };
        let mut inl = Inline::default();
        for &child in &page.nodes[id].children {
            if !page.html(child, "li") {
                self.node(child, &inner, &mut inl);
                continue;
            }
            if self.dropped[child] {
                continue;
            }
            self.flush(&mut inl, &inner);
            if let Some(value) = page.attr(child, "value").and_then(|v| v.trim().parse().ok()) {
                number = value;
            }
            let numbered = ordered && !page.attr(id, "style").is_some_and(|s| s.contains("none")) && !page.has_word(id, &["no-bullets", "unstyled", "list-none"]);
            self.marker = Some(if numbered { format!("{number}.") } else if flow == Flow::References { String::new() } else { "\u{2022}".into() }).filter(|m| !m.is_empty());
            if let Some(anchor) = page.attr(child, "id") {
                self.anchors.push(anchor.to_string());
            }
            self.flow(child, &inner);
            self.marker = None;
            number += 1;
        }
        self.flush(&mut inl, &inner);
    }

    fn inline(&mut self, id: usize, ctx: &Ctx, inl: &mut Inline) {
        let page = self.page;
        let n = &page.nodes[id];
        match n.space {
            Space::Html => {}
            Space::Math if n.tag == "math" => return self.inline_math(id, inl),
            Space::Svg if n.tag == "svg" => {
                if self.svg_size(id).is_some_and(|(w, h)| w >= 20.0 && h >= 14.0) {
                    if let Some(resource) = self.svg_resource(id) {
                        inl.add_unmapped('\u{fffc}');
                        let at = inl.len() - 1;
                        inl.spans.push(Span { start: at, end: at + 1, kind: "image".into(), resource: Some(resource), ..Default::default() });
                    }
                }
                return;
            }
            Space::Other => {
                if let Some(math) = self.math_in(id) {
                    return self.inline_math(math, inl);
                }
                return self.children(id, ctx, inl);
            }
            _ => return,
        }
        let kind = match n.tag.as_str() {
            "br" => return inl.add_unmapped('\n'),
            "wbr" => return,
            "img" => {
                let image = self.image(id);
                if let Some(resource) = image.resource {
                    inl.add_unmapped('\u{fffc}');
                    let at = inl.len() - 1;
                    inl.spans.push(Span { start: at, end: at + 1, kind: "image".into(), resource: Some(resource), alt: Some(image.alt).filter(|a| !a.is_empty()), ..Default::default() });
                }
                return;
            }
            "em" | "i" | "cite" | "dfn" | "var" => "em",
            "strong" | "b" => "strong",
            "code" | "kbd" | "samp" | "tt" => "code",
            "sup" => "sup",
            "sub" => "sub",
            "a" => "link",
            "svg" | "math" | "video" | "audio" | "canvas" | "picture" | "source" | "track" | "map" | "area" => {
                if n.tag == "picture" {
                    return self.children(id, ctx, inl);
                }
                return;
            }
            _ => "",
        };
        let start = inl.len();
        self.children(id, ctx, inl);
        if kind.is_empty() {
            return;
        }
        let mut span = Span { kind: kind.into(), ..Default::default() };
        if kind == "link" {
            let Some(href) = page.attr(id, "href").and_then(|h| self.href(h)) else { return };
            span.href = Some(href);
        }
        inl.close_span(span, start);
    }

    /// A link's address: `#anchor` within the page, else an absolute web or mail address.
    fn href(&self, href: &str) -> Option<String> {
        let href = href.trim();
        if href.is_empty() || href.to_lowercase().starts_with("javascript:") {
            return None;
        }
        if let Some(anchor) = href.strip_prefix('#') {
            return (!anchor.is_empty()).then(|| format!("#{anchor}"));
        }
        let absolute = if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("mailto:") {
            href.to_string()
        } else {
            let base = self.base.as_deref()?;
            join_url(base, href)?
        };
        // The page's own address with a fragment is a link within the page.
        if let (Some(base), Some((page_part, anchor))) = (self.base.as_deref(), absolute.split_once('#')) {
            if page_part == base.split('#').next().unwrap_or(base) && !anchor.is_empty() {
                return Some(format!("#{anchor}"));
            }
        }
        Some(absolute)
    }

    fn math_in(&self, id: usize) -> Option<usize> {
        let page = self.page;
        if page.nodes[id].space == Space::Math && page.nodes[id].tag == "math" {
            return Some(id);
        }
        page.descendants(id).into_iter().find(|&d| page.nodes[d].space == Space::Math && page.nodes[d].tag == "math")
    }

    fn inline_math(&mut self, id: usize, inl: &mut Inline) {
        let markup = mathml(self.page, id, false);
        inl.flush_space();
        let start = inl.len();
        math_text(self.page, id, inl);
        if inl.len() > start {
            inl.spans.push(Span { start, end: inl.len(), kind: "math".into(), math: Some(markup), ..Default::default() });
        }
    }

    fn equation(&mut self, id: usize, caption: Option<Caption>) {
        let page = self.page;
        let math = self.math_in(id);
        let mut item = Item { kind: "equation".into(), caption, ..Default::default() };
        if let Some(m) = math {
            item.math = Some(mathml(page, m, true));
        } else if let Some(img) = page.descendants(id).into_iter().find(|&d| page.html(d, "img")) {
            let image = self.image(img);
            if image.resource.is_none() {
                return;
            }
            item.images.push(image);
        } else {
            return;
        }
        // Its number, "(3)", as the caption.
        if item.caption.is_none() {
            let label = page
                .descendants(id)
                .into_iter()
                .filter(|&d| !page.is_text(d) && Some(d) != math && !math.is_some_and(|m| page.ancestors(d).any(|a| a == m)) && (page.has_word(d, &["label", "eq-label", "ltx_tag", "number", "eqn-num"]) || page.html(d, "span") && is_equation_number(&page.collapsed(d))))
                .find(|&d| is_equation_number(&page.collapsed(d)));
            if let Some(label) = label {
                let mut inl = Inline::default();
                self.children(label, &Ctx { flow: Flow::Paragraph, depth: 0, pre: false, flat: true }, &mut inl);
                let (text, runs, spans) = inl.finish();
                item.caption = Some(Caption { text, runs, spans });
            }
        }
        self.push_item(item);
    }

    fn figure(&mut self, id: usize, ctx: &Ctx) {
        let page = self.page;
        let all = page.descendants(id);
        let captions: Vec<usize> = all
            .iter()
            .copied()
            .filter(|&d| !page.is_text(d) && (page.html(d, "figcaption") || page.has_word(d, CAPTION_WORDS)) && !page.ancestors(d).take_while(|&a| a != id).any(|a| page.html(a, "figcaption") || page.has_word(a, CAPTION_WORDS)))
            .collect();
        let in_caption = |d: usize| captions.iter().any(|&c| c == d || page.ancestors(d).any(|a| a == c));
        let caption = (!captions.is_empty()).then(|| {
            let mut inl = Inline::default();
            let flat = Ctx { flow: Flow::Paragraph, depth: 0, pre: false, flat: true };
            for &c in &captions {
                if !inl.is_empty() {
                    inl.space.get_or_insert(None);
                }
                self.children(c, &flat, &mut inl);
                inl.space.get_or_insert(None);
            }
            let (text, runs, spans) = inl.finish();
            Caption { text, runs, spans }
        });
        if let Some(table) = all.iter().copied().find(|&d| page.html(d, "table") && !in_caption(d)) {
            self.consumed.insert(id);
            return self.table(table, caption);
        }
        let images: Vec<usize> = all.iter().copied().filter(|&d| (page.html(d, "img") || (page.nodes[d].space == Space::Svg && page.nodes[d].tag == "svg" && !page.ancestors(d).any(|a| page.nodes[a].tag == "svg"))) && !in_caption(d)).collect();
        if images.is_empty() {
            if self.math_in(id).is_some() {
                return self.equation(id, caption);
            }
            // A figure with only text: read it as text (a pull quote, a code listing).
            return self.flow(id, ctx);
        }
        let mut item = Item { kind: "figure".into(), ..Default::default() };
        for img in images {
            let image = if page.html(img, "img") { self.image(img) } else { Image { resource: self.svg_resource(img), alt: String::new(), width: self.svg_size(img).map(|s| s.0 as u32), height: self.svg_size(img).map(|s| s.1 as u32) } };
            if !image.resource.is_some() && image.alt.is_empty() && item.images.iter().any(|i| i.resource.is_some()) {
                continue;
            }
            item.images.push(image);
        }
        if let Some(c) = caption {
            item.text = c.text;
            item.runs = c.runs;
            item.spans = c.spans;
        }
        self.push_item(item);
    }

    fn table(&mut self, id: usize, caption: Option<Caption>) {
        let page = self.page;
        let flat = Ctx { flow: Flow::Paragraph, depth: 0, pre: false, flat: true };
        let in_this = |d: usize| page.ancestors(d).find(|&a| page.html(a, "table")) == Some(id);
        let rows: Vec<usize> = page.descendants(id).into_iter().filter(|&d| page.html(d, "tr") && in_this(d) && !self.dropped[d]).collect();
        let cells_of = |tr: usize| -> Vec<usize> { page.nodes[tr].children.iter().copied().filter(|&c| page.html(c, "td") || page.html(c, "th")).collect() };
        let columns = rows.iter().map(|&r| cells_of(r).len()).max().unwrap_or(0);
        let blocky = page.descendants(id).into_iter().filter(|&d| in_this(d) && (page.html(d, "p") || page.html(d, "div") || page.html(d, "ul") || page.html(d, "h2") || page.html(d, "h3"))).count();
        let layout = page.attr(id, "role").is_some_and(|r| r == "presentation" || r == "none") || columns <= 1 || rows.is_empty() || blocky > rows.len() * 2 + 2;
        if layout {
            return self.flow(id, &flat_container());
        }
        let mut table = Table::default();
        for &tr in &rows {
            let in_head = page.ancestors(tr).take_while(|&a| a != id).any(|a| page.html(a, "thead"));
            let mut row = Vec::new();
            for td in cells_of(tr) {
                let mut inl = Inline::default();
                self.children(td, &flat, &mut inl);
                let (text, runs, spans) = inl.finish();
                let span_of = |name: &str| page.attr(td, name).and_then(|v| v.trim().parse::<u32>().ok()).filter(|&v| v >= 1).unwrap_or(1).min(100);
                row.push(Cell { text, runs, spans, header: page.html(td, "th") || in_head, colspan: span_of("colspan"), rowspan: span_of("rowspan") });
            }
            table.rows.push(row);
        }
        let caption = caption.or_else(|| {
            let c = page.nodes[id].children.iter().copied().find(|&c| page.html(c, "caption"))?;
            let mut inl = Inline::default();
            self.children(c, &flat, &mut inl);
            let (text, runs, spans) = inl.finish();
            (!text.is_empty()).then_some(Caption { text, runs, spans })
        });
        self.push_item(Item { kind: "table".into(), table: Some(table), caption, ..Default::default() });
    }

    fn image(&mut self, id: usize) -> Image {
        let page = self.page;
        let size = |name: &str| page.attr(id, name).and_then(|v| v.trim().trim_end_matches("px").parse::<f32>().ok()).map(|v| v as u32);
        let src = page.attr(id, "src").unwrap_or("");
        Image { resource: self.resource(src), alt: page.attr(id, "alt").map(collapse).unwrap_or_default(), width: size("width"), height: size("height") }
    }

    /// A picture big enough to stand on its own (not an icon, a spacer or an inline formula).
    fn big_image(&self, id: usize) -> bool {
        let page = self.page;
        if page.has_word(id, &["inline-formula", "inline-graphic", "icon", "emoji", "avatar", "logo", "ltx_math"]) {
            return false;
        }
        let size = |name: &str| page.attr(id, name).and_then(|v| v.trim().trim_end_matches("px").parse::<f32>().ok());
        match (size("width"), size("height")) {
            (Some(w), Some(h)) => w >= 120.0 && h >= 60.0,
            (Some(w), None) | (None, Some(w)) => w >= 120.0,
            (None, None) => page.attr(id, "src").is_some_and(|s| s.len() > 2000),
        }
    }

    fn resource(&mut self, src: &str) -> Option<usize> {
        let src = src.trim();
        let lower = src.get(..16).unwrap_or(src).to_ascii_lowercase();
        if !lower.starts_with("data:image/") {
            return None;
        }
        let key = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            src.hash(&mut h);
            h.finish()
        };
        if let Some(&n) = self.resource_of.get(&key) {
            return Some(n);
        }
        self.resources.push(src.to_string());
        let n = self.resources.len() - 1;
        self.resource_of.insert(key, n);
        Some(n)
    }

    fn svg_size(&self, id: usize) -> Option<(f32, f32)> {
        let page = self.page;
        let num = |name: &str| page.attr(id, name).and_then(|v| v.trim().trim_end_matches("px").parse::<f32>().ok());
        if let (Some(w), Some(h)) = (num("width"), num("height")) {
            return Some((w, h));
        }
        let view: Vec<f32> = page.attr(id, "viewBox")?.split([' ', ',']).filter_map(|v| v.parse().ok()).collect();
        (view.len() == 4).then(|| (view[2], view[3]))
    }

    fn svg_resource(&mut self, id: usize) -> Option<usize> {
        let mut xml = String::new();
        svg_xml(self.page, id, &mut xml, true);
        if xml.len() < 40 {
            return None;
        }
        let data = format!("data:image/svg+xml;base64,{}", base64(xml.as_bytes()));
        self.resource(&data)
    }
}

fn flat_container() -> Ctx {
    Ctx { flow: Flow::Paragraph, depth: 0, pre: false, flat: false }
}

fn is_equation_number(text: &str) -> bool {
    let t = text.trim();
    t.len() <= 12 && t.starts_with('(') && t.ends_with(')') && t.chars().any(|c| c.is_ascii_digit())
}

fn join_url(base: &str, href: &str) -> Option<String> {
    let scheme_end = base.find("://")? + 3;
    let origin_end = base[scheme_end..].find('/').map_or(base.len(), |i| scheme_end + i);
    let origin = &base[..origin_end];
    if let Some(rest) = href.strip_prefix("//") {
        return Some(format!("{}{rest}", &base[..scheme_end]));
    }
    if href.starts_with('/') {
        return Some(format!("{origin}{href}"));
    }
    let path = base[origin_end..].split(['?', '#']).next().unwrap_or("");
    let dir = path.rfind('/').map_or("/", |i| &path[..=i]);
    Some(format!("{origin}{dir}{href}"))
}

fn escape(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
}

const MATH_ELEMENTS: &[&str] = &[
    "math", "mrow", "mi", "mo", "mn", "ms", "mtext", "mspace", "msub", "msup", "msubsup", "munder", "mover", "munderover", "mfrac", "msqrt", "mroot", "mstyle", "merror",
    "mpadded", "mphantom", "mfenced", "menclose", "mtable", "mtr", "mtd", "mlabeledtr", "mmultiscripts", "mprescripts", "none",
];
const MATH_TOKENS: &[&str] = &["mi", "mo", "mn", "ms", "mtext"];
const MATH_ATTRS: &[&str] = &[
    "mathvariant", "stretchy", "fence", "separator", "lspace", "rspace", "accent", "accentunder", "linethickness", "columnalign", "rowalign", "columnspacing", "rowspacing",
    "displaystyle", "scriptlevel", "open", "close", "separators", "notation", "columnlines", "rowlines", "frame", "width", "height", "depth", "voffset", "form", "movablelimits",
    "largeop", "symmetric", "minsize", "maxsize", "rowspan", "columnspan", "mathsize", "mathcolor", "dir",
];

/// MathML with only presentation elements and attributes: what reading mode renders. Token text
/// is trimmed, and nothing else is text, so its text is exactly `math_text`.
fn mathml(page: &Page, id: usize, display: bool) -> String {
    fn walk(page: &Page, id: usize, out: &mut String) {
        let n = &page.nodes[id];
        if n.tag.is_empty() {
            let parent = n.parent.map(|p| page.nodes[p].tag.as_str()).unwrap_or("");
            if MATH_TOKENS.contains(&parent) {
                escape(n.text.trim_matches(is_html_space), out);
            }
            return;
        }
        if n.space != Space::Math {
            return;
        }
        match n.tag.as_str() {
            "annotation" | "annotation-xml" => return,
            "semantics" | "maction" => {
                if let Some(&first) = n.children.iter().find(|&&c| !page.is_text(c)) {
                    walk(page, first, out);
                }
                return;
            }
            _ => {}
        }
        let known = MATH_ELEMENTS.contains(&n.tag.as_str()) && n.tag != "math";
        if known {
            out.push('<');
            out.push_str(&n.tag);
            for (k, v) in &n.attrs {
                if MATH_ATTRS.contains(&k.as_str()) {
                    out.push(' ');
                    out.push_str(k);
                    out.push_str("=\"");
                    escape(v, out);
                    out.push('"');
                }
            }
            out.push('>');
        }
        for &c in &n.children {
            walk(page, c, out);
        }
        if known {
            out.push_str("</");
            out.push_str(&n.tag);
            out.push('>');
        }
    }
    let mut out = format!("<math xmlns=\"http://www.w3.org/1998/Math/MathML\" display=\"{}\">", if display { "block" } else { "inline" });
    for &c in &page.nodes[id].children {
        walk(page, c, &mut out);
    }
    out.push_str("</math>");
    out
}

/// The text of `mathml`'s tokens, each mapped to its place on the page.
fn math_text(page: &Page, id: usize, inl: &mut Inline) {
    let n = &page.nodes[id];
    if n.tag.is_empty() {
        let parent = n.parent.map(|p| page.nodes[p].tag.as_str()).unwrap_or("");
        if MATH_TOKENS.contains(&parent) {
            let lead = n.text.len() - n.text.trim_start_matches(is_html_space).len();
            let trimmed = n.text.trim_matches(is_html_space);
            let at = n.at.map(|a| a + n.text[..lead].encode_utf16().count());
            inl.add(trimmed, at, true);
        }
        return;
    }
    if n.space != Space::Math || matches!(n.tag.as_str(), "annotation" | "annotation-xml") {
        return;
    }
    if matches!(n.tag.as_str(), "semantics" | "maction") {
        if let Some(&first) = n.children.iter().find(|&&c| !page.is_text(c)) {
            math_text(page, first, inl);
        }
        return;
    }
    for &c in &n.children {
        math_text(page, c, inl);
    }
}

fn svg_xml(page: &Page, id: usize, out: &mut String, root: bool) {
    let n = &page.nodes[id];
    if n.tag.is_empty() {
        escape(&n.text, out);
        return;
    }
    if n.space != Space::Svg || matches!(n.tag.as_str(), "foreignObject" | "script") {
        return;
    }
    out.push('<');
    out.push_str(&n.tag);
    if root {
        out.push_str(" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\"");
    }
    for (k, v) in &n.attrs {
        if k.to_lowercase().starts_with("on") || k == "xmlns" || k == "xmlns:xlink" || ((k == "href" || k == "xlink:href") && !v.starts_with('#') && !v.starts_with("data:")) {
            continue;
        }
        out.push(' ');
        out.push_str(k);
        out.push_str("=\"");
        escape(v, out);
        out.push('"');
    }
    out.push('>');
    for &c in &n.children {
        svg_xml(page, c, out, false);
    }
    out.push_str("</");
    out.push_str(&n.tag);
    out.push('>');
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/// "2021-05-04" (or "2021/05/04", an ISO time) as "4 May 2021"; a year alone as itself.
fn readable_date(value: &str) -> Option<String> {
    let v = value.trim();
    let parts: Vec<&str> = v.split(|c: char| c == '-' || c == '/' || c == 'T' || c == ' ').collect();
    let year: u32 = parts.first()?.parse().ok().filter(|y| (1000..3000).contains(y))?;
    let month: Option<usize> = parts.get(1).and_then(|m| m.parse().ok()).filter(|m| (1..=12).contains(m));
    let day: Option<u32> = parts.get(2).and_then(|d| d.parse().ok()).filter(|d| (1..=31).contains(d));
    Some(match (month, day) {
        (Some(m), Some(d)) => format!("{d} {} {year}", MONTHS[m - 1]),
        (Some(m), None) => format!("{} {year}", MONTHS[m - 1]),
        _ => year.to_string(),
    })
}

fn snapshot_url(page: &Page, metas: &[(String, String)]) -> Option<String> {
    let info = metas.iter().find(|(k, _)| k == "key-snapshot").and_then(|(_, v)| serde_json::from_str::<Json>(v).ok());
    info.and_then(|i| i["url"].as_str().map(str::to_string))
        .or_else(|| metas.iter().find(|(k, _)| k == "og:url" || k == "citation_fulltext_html_url" || k == "citation_abstract_html_url").map(|(_, v)| v.clone()))
        .filter(|u| u.starts_with("http"))
        .or_else(|| page.attr(0, "data-url").map(str::to_string))
}

/// Reading mode for a saved web page's HTML.
pub fn assemble(html: &str) -> WebDocument {
    let page = Page::parse(html);
    let metas = page.metas();
    let meta_of = |keys: &[&str]| keys.iter().find_map(|k| metas.iter().find(|(m, v)| m == k && !v.is_empty()).map(|(_, v)| collapse(v)));
    let url = snapshot_url(&page, &metas);
    let empty = |reason: &str| WebDocument {
        document: Document { page_count: 1, engine: "web".into(), quality: Quality { level: "empty", reason: Some(reason.into()) }, items: Vec::new(), outline: Vec::new(), meta: None },
        text: page.text.clone(),
        resources: Vec::new(),
    };
    let Some(article) = find_article(&page) else { return empty("Key found no text on this saved page.") };
    let mut emitter = Emitter {
        page: &page,
        dropped: &article.dropped,
        consumed: HashSet::new(),
        items: Vec::new(),
        resources: Vec::new(),
        resource_of: HashMap::new(),
        anchors: Vec::new(),
        marker: None,
        references_until: None,
        base: url.clone(),
        depth: 0,
    };
    let body = page.body.unwrap_or(0);
    let in_body: Vec<usize> = page.descendants(body);
    let html_title = page.head.and_then(|h| page.descendants(h).into_iter().find(|&d| page.html(d, "title"))).map(|t| page.collapsed(t)).filter(|t| !t.is_empty());
    let title_meta = meta_of(&["citation_title", "dc.title", "og:title", "twitter:title"]).or(html_title);
    // The title: the page's first top heading, when it says what the metadata does (or there is
    // no metadata); else the metadata's, as text of its own.
    let h1s: Vec<usize> = in_body.iter().copied().filter(|&d| page.html(d, "h1") && !page.hidden(d)).collect();
    let fold = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let title_node = match &title_meta {
        Some(t) => h1s.iter().copied().find(|&h| {
            let (a, b) = (fold(&page.collapsed(h)), fold(t));
            !a.is_empty() && (b.contains(&a) || a.contains(&b))
        }),
        None => None,
    }
    .or_else(|| h1s.iter().copied().find(|&h| !article.dropped[h] && page.ancestors(h).any(|a| a == article.root)))
    .or_else(|| h1s.first().copied().filter(|_| title_meta.is_none()));
    let title_text = title_node.map(|h| page.collapsed(h)).or(title_meta.clone());
    if let Some(h) = title_node {
        emitter.consumed.insert(h);
        let mut inl = Inline::default();
        emitter.children(h, &Ctx { flow: Flow::Paragraph, depth: 0, pre: false, flat: true }, &mut inl);
        let (text, runs, spans) = inl.finish();
        let anchors = page.attr(h, "id").map(|a| vec![a.to_string()]).unwrap_or_default();
        emitter.push_item(Item { kind: "heading".into(), level: Some(1), text, runs, spans, anchors, ..Default::default() });
    } else if let Some(t) = &title_text {
        emitter.push_item(Item { kind: "heading".into(), level: Some(1), text: t.clone(), ..Default::default() });
    }
    // The byline: the page's own line, else the authors its metadata names.
    let byline_node = in_body.iter().copied().find(|&d| {
        !page.is_text(d) && !page.hidden(d) && (page.has_word(d, BYLINE_WORDS) || page.attr(d, "rel") == Some("author") || page.attr(d, "itemprop") == Some("author")) && {
            let t = page.collapsed(d);
            (4..=240).contains(&t.chars().count()) && Some(&t) != title_text.as_ref()
        } && !page.ancestors(d).any(|a| emitter.consumed.contains(&a) || page.has_word(a, BYLINE_WORDS))
    });
    let authors: Vec<String> = metas.iter().filter(|(k, _)| k == "citation_author" || k == "dc.creator" || k == "author").map(|(_, v)| flip_name(v)).collect();
    let meta_byline = (!authors.is_empty()).then(|| if authors.len() > 6 { format!("{} et al.", authors[..6].join(", ")) } else { join_names(&authors) });
    if let Some(b) = byline_node {
        emitter.consumed.insert(b);
        let mut inl = Inline::default();
        emitter.children(b, &Ctx { flow: Flow::Paragraph, depth: 0, pre: false, flat: true }, &mut inl);
        let (text, runs, spans) = inl.finish();
        emitter.push_item(Item { kind: "byline".into(), text, runs, spans, ..Default::default() });
    }
    let date = meta_of(&["citation_publication_date", "citation_date", "dc.date", "article:published_time", "datepublished", "date", "og:published_time"])
        .or_else(|| in_body.iter().find(|&&d| page.html(d, "time")).and_then(|&t| page.attr(t, "datetime").map(str::to_string)))
        .and_then(|d| readable_date(&d).or(Some(d)))
        .filter(|d| d.chars().count() <= 40);
    let site = meta_of(&["og:site_name", "citation_journal_title", "citation_publisher", "dc.publisher", "application-name"])
        .or_else(|| url.as_deref().and_then(|u| u.split("://").nth(1)).and_then(|h| h.split('/').next()).map(|h| h.trim_start_matches("www.").to_string()));

    emitter.flow(article.root, &flat_container());
    let resources = std::mem::take(&mut emitter.resources);
    let mut items = std::mem::take(&mut emitter.items);
    drop(emitter);

    attach_captions(&mut items);
    resolve_links(&mut items);
    // Heading levels: the title first, then each level the page uses, in order.
    let mut levels: Vec<u8> = items.iter().skip(1).filter(|i| i.kind == "heading").filter_map(|i| i.level).collect();
    levels.sort_unstable();
    levels.dedup();
    for (k, item) in items.iter_mut().enumerate() {
        if item.kind == "heading" && !(k == 0 && item.level == Some(1)) {
            let rank = item.level.and_then(|l| levels.iter().position(|x| *x == l)).unwrap_or(0) as u8;
            item.level = Some((rank + 2).min(4));
        }
    }
    for (id, item) in items.iter_mut().enumerate() {
        item.id = id;
    }
    let outline = items.iter().filter(|i| i.kind == "heading").map(|i| OutlineEntry { item: i.id, level: i.level.unwrap_or(2), text: i.text.clone(), page: 0 }).collect();
    let quality = quality(&page, &items);
    let meta = Meta { title: title_text, byline: meta_byline.filter(|_| byline_node.is_none()), date, site, url };
    WebDocument { document: Document { page_count: 1, engine: "web".into(), quality, items, outline, meta: Some(meta) }, text: page.text, resources }
}

/// "Okafor, Adaeze" as "Adaeze Okafor".
fn flip_name(name: &str) -> String {
    match name.split_once(',') {
        Some((family, given)) if name.matches(',').count() == 1 && !given.trim().is_empty() && !family.trim().is_empty() => format!("{} {}", given.trim(), family.trim()),
        _ => collapse(name),
    }
}
fn join_names(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// A picture followed by its "Figure 3." paragraph (or a table after its "Table 2" line): the
/// paragraph is its caption.
fn attach_captions(items: &mut Vec<Item>) {
    let mut i = 0;
    while i + 1 < items.len() {
        let (a, b) = (&items[i], &items[i + 1]);
        let figure_caption = a.kind == "figure" && a.text.is_empty() && b.kind == "paragraph" && caption_kind(&b.text) == Some("figure");
        if figure_caption {
            let caption = items.remove(i + 1);
            let figure = &mut items[i];
            figure.text = caption.text;
            figure.runs = caption.runs;
            figure.spans = caption.spans;
            figure.anchors.extend(caption.anchors);
        } else if b.kind == "table" && b.caption.is_none() && a.kind == "paragraph" && caption_kind(&a.text) == Some("table") && a.text.chars().count() < 400 {
            let caption = items.remove(i);
            let table = &mut items[i];
            table.caption = Some(Caption { text: caption.text, runs: caption.runs, spans: caption.spans });
            let mut anchors = caption.anchors;
            anchors.append(&mut table.anchors);
            table.anchors = anchors;
            continue;
        }
        i += 1;
    }
}

/// Links within the page go to the item holding their anchor; a link to a reference is a
/// citation of it. Links to anchors reading mode does not show are dropped (their text stays).
fn resolve_links(items: &mut [Item]) {
    let mut at: HashMap<String, usize> = HashMap::new();
    for (k, item) in items.iter().enumerate() {
        for a in &item.anchors {
            at.entry(a.clone()).or_insert(k);
        }
    }
    let kinds: Vec<String> = items.iter().map(|i| i.kind.clone()).collect();
    let fix = |spans: &mut Vec<Span>| {
        spans.retain_mut(|s| {
            let Some(anchor) = s.href.as_deref().and_then(|h| h.strip_prefix('#')) else { return true };
            let decoded = percent_decode(anchor);
            let Some(&target) = at.get(anchor).or_else(|| at.get(&decoded)) else { return false };
            s.target = Some(target);
            s.href = None;
            if kinds[target] == "references" {
                s.kind = "cite".into();
            }
            true
        });
    };
    for (k, item) in items.iter_mut().enumerate() {
        fix(&mut item.spans);
        if let Some(c) = item.caption.as_mut() {
            fix(&mut c.spans);
        }
        if let Some(t) = item.table.as_mut() {
            for cell in t.rows.iter_mut().flatten() {
                fix(&mut cell.spans);
            }
        }
        // Positions are fixed up after (ids are indices), so `target` is already right.
        let _ = k;
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            if let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn quality(page: &Page, items: &[Item]) -> Quality {
    let prose: Vec<&Item> = items.iter().filter(|i| matches!(i.kind.as_str(), "paragraph" | "list" | "quote")).collect();
    let chars: usize = prose.iter().map(|i| i.text.chars().filter(|c| !c.is_whitespace()).count()).sum();
    let paragraphs = prose.iter().filter(|i| i.text.chars().count() >= 40).count();
    let page_text = String::from_utf16_lossy(&page.text).to_lowercase();
    let walled = ["subscribe to continue", "subscribe to read", "to continue reading", "already a subscriber", "sign in to continue", "sign in to read", "log in to continue", "log in to read", "create a free account to", "purchase this article", "buy this article", "get full access", "become a member to read", "this content is for subscribers"]
        .iter()
        .any(|p| page_text.contains(p));
    if chars < 120 {
        return Quality { level: "empty", reason: Some("Key found almost no article text on this saved page. It may be an app or a page that builds itself with scripts, which a saved copy cannot run.".into()) };
    }
    if walled && chars < 2500 {
        return Quality { level: "poor", reason: Some("This saved page seems to hold only the start of the article: the rest is behind a sign-in or a paywall.".into()) };
    }
    if chars < 400 || paragraphs < 2 {
        return Quality { level: "poor", reason: Some("This page has too little running text for reading mode. It reads better as it was saved.".into()) };
    }
    let controls = page.nodes.iter().filter(|n| n.space == Space::Html && matches!(n.tag.as_str(), "button" | "input" | "select")).count();
    if controls > 25 && chars < 1500 {
        return Quality { level: "poor", reason: Some("This page is mostly buttons and links (an app or a list of pages), not an article.".into()) };
    }
    Quality { level: "good", reason: None }
}

// ---------------------------------------------------------------------------------------------
// Between reading mode and the page.

/// The texts of an item, each with its part name ("" for the item's own text).
pub fn parts(item: &Item) -> Vec<(String, &str, &[Run])> {
    let mut out = vec![(String::new(), item.text.as_str(), item.runs.as_slice())];
    if let Some(c) = &item.caption {
        out.push(("caption".into(), c.text.as_str(), c.runs.as_slice()));
    }
    if let Some(t) = &item.table {
        for (r, row) in t.rows.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                out.push((format!("cell:{r}:{c}"), cell.text.as_str(), cell.runs.as_slice()));
            }
        }
    }
    out
}

/// A stretch of reading-mode text: item, part ("" for its own text), UTF-16 offsets.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stretch {
    pub item: usize,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub part: String,
    pub start: usize,
    pub end: usize,
}

/// Where page text `start..end` shows in reading mode (none of it, if it is boilerplate).
pub fn project(doc: &WebDocument, start: usize, end: usize) -> Vec<Stretch> {
    let mut out = Vec::new();
    for item in &doc.document.items {
        for (part, _, runs) in parts(item) {
            let mut from: Option<usize> = None;
            let mut to = 0;
            for run in runs {
                let Some(at) = run.at else { continue };
                let (a, b) = (at, at + (run.end - run.start));
                if b <= start || a >= end {
                    continue;
                }
                let s = run.start + start.saturating_sub(a);
                let e = run.start + (end.min(b) - a);
                from = Some(from.map_or(s, |f: usize| f.min(s)));
                to = to.max(e);
            }
            if let Some(from) = from.filter(|f| *f < to) {
                out.push(Stretch { item: item.id, part, start: from, end: to });
            }
        }
    }
    out
}

/// The first item whose text is at or after page offset `offset` (where the page view was).
pub fn item_at(doc: &WebDocument, offset: usize) -> Option<usize> {
    doc.document.items.iter().find(|item| parts(item).iter().any(|(_, _, runs)| runs.iter().any(|r| r.at.is_some_and(|a| a + (r.end - r.start) > offset)))).map(|i| i.id)
}

fn quote_selector<'a>(anchor: &'a Json, kind: &str) -> Option<&'a Json> {
    anchor["selectors"].as_array()?.iter().find(|s| s["type"] == kind)
}

fn find_all16(hay: &[u16], needle: &[u16]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return Vec::new();
    }
    let first = needle[0];
    (0..=hay.len() - needle.len()).filter(|&i| hay[i] == first && hay[i..i + needle.len()] == *needle).collect()
}

/// Where a web annotation's anchor is in the page text, as the reader finds it (web-anchors.ts
/// `locate`): by position when the text there still matches, else by the quote and its context,
/// else by the quote with spacing ignored.
pub fn anchor_range(text: &[u16], anchor: &Json, fallback: &str) -> Option<(usize, usize)> {
    let quote = quote_selector(anchor, "TextQuoteSelector");
    let position = quote_selector(anchor, "TextPositionSelector");
    let exact: Vec<u16> = quote.and_then(|q| q["exact"].as_str()).unwrap_or(fallback).encode_utf16().collect();
    if let Some(p) = position {
        if let (Some(s), Some(e)) = (p["start"].as_u64(), p["end"].as_u64()) {
            let (s, e) = (s as usize, e as usize);
            if s <= e && e <= text.len() && (exact.is_empty() || text[s..e] == exact[..]) {
                return Some((s, e));
            }
        }
    }
    if exact.iter().all(|&u| is_js_space(u)) {
        return None;
    }
    let prefix: Vec<u16> = quote.and_then(|q| q["prefix"].as_str()).unwrap_or("").encode_utf16().collect();
    let suffix: Vec<u16> = quote.and_then(|q| q["suffix"].as_str()).unwrap_or("").encode_utf16().collect();
    let near = position.and_then(|p| p["start"].as_u64()).map(|s| s as f64);
    let overlap_end = |a: &[u16], b: &[u16]| a.iter().rev().zip(b.iter().rev()).take_while(|(x, y)| x == y).count();
    let overlap_start = |a: &[u16], b: &[u16]| a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
    let mut best: Option<(usize, f64)> = None;
    for at in find_all16(text, &exact) {
        let before = &text[at.saturating_sub(prefix.len())..at];
        let after = &text[at + exact.len()..(at + exact.len() + suffix.len()).min(text.len())];
        let distance = near.map_or(0.0, |n| (at as f64 - n).abs() / text.len().max(1) as f64);
        let score = (overlap_end(before, &prefix) + overlap_start(after, &suffix)) as f64 - distance;
        if best.is_none_or(|(_, b)| score > b) {
            best = Some((at, score));
        }
    }
    if let Some((at, _)) = best {
        return Some((at, at + exact.len()));
    }
    // Spacing ignored.
    let (page, map) = collapse16(text);
    let wanted = collapse16(&exact).0;
    let trimmed: Vec<u16> = {
        let s = wanted.iter().position(|&u| u != b' ' as u16).unwrap_or(wanted.len());
        let e = wanted.iter().rposition(|&u| u != b' ' as u16).map_or(s, |e| e + 1);
        wanted[s..e].to_vec()
    };
    let at = *find_all16(&page, &trimmed).first()?;
    Some((map[at], map[at + trimmed.len() - 1] + 1))
}

fn collapse16(text: &[u16]) -> (Vec<u16>, Vec<usize>) {
    let mut out = Vec::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len());
    let mut space = false;
    for (i, &u) in text.iter().enumerate() {
        if is_js_space(u) {
            if space {
                continue;
            }
            space = true;
            out.push(b' ' as u16);
        } else {
            space = false;
            out.push(u);
        }
        map.push(i);
    }
    (out, map)
}

/// Highlights stored on the page (web annotations), on their words in reading mode.
pub fn marks(doc: &WebDocument, annotations: &[Json]) -> Vec<Mark> {
    let mut out = Vec::new();
    for a in annotations {
        if a["anchor"]["kind"] != "web" {
            continue;
        }
        let Some(id) = a["id"].as_str() else { continue };
        let Some((start, end)) = anchor_range(&doc.text, &a["anchor"], a["text"].as_str().unwrap_or("")) else { continue };
        for s in project(doc, start, end) {
            out.push(Mark {
                annotation_id: id.to_string(),
                item: s.item,
                part: (!s.part.is_empty()).then_some(s.part),
                start: s.start,
                end: s.end,
                color: a["color"].as_str().unwrap_or("orange").to_string(),
                comment: a["comment"].as_str().filter(|c| !c.trim().is_empty()).map(str::to_string),
            });
        }
    }
    out
}

/// A selection in reading mode, placed on the page: certain when both its ends are page text and
/// the page text between them is the selected text (spacing aside); then `start..end` and the
/// quote with its context are what the reader stores (web-anchors.ts `describeRange`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Located {
    pub certain: bool,
    /// The selected text, as reading mode shows it.
    pub quote: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
}

const CONTEXT: usize = 32;

pub fn locate(doc: &WebDocument, item: usize, part: &str, start: usize, end: usize) -> Located {
    let Some(item) = doc.document.items.get(item) else { return Located { certain: false, quote: String::new(), start: None, end: None, exact: None, prefix: None, suffix: None } };
    let all = parts(item);
    let Some((_, text, runs)) = all.iter().find(|(p, _, _)| p == part) else { return Located { certain: false, quote: String::new(), start: None, end: None, exact: None, prefix: None, suffix: None } };
    let units: Vec<u16> = text.encode_utf16().collect();
    let (start, end) = (start.min(units.len()), end.min(units.len()));
    let quote = String::from_utf16_lossy(&units[start..end]);
    let uncertain = Located { certain: false, quote: quote.trim().to_string(), start: None, end: None, exact: None, prefix: None, suffix: None };
    let place = |offset: usize| runs.iter().find(|r| r.start <= offset && offset < r.end).and_then(|r| r.at.map(|a| a + offset - r.start));
    let Some(first) = (start..end).find_map(place) else { return uncertain };
    let Some(last) = (start..end).rev().find_map(place) else { return uncertain };
    let (s, e) = (first, last + 1);
    if e <= s || e > doc.text.len() {
        return uncertain;
    }
    let squeeze = |u: &[u16]| u.iter().copied().filter(|&c| !is_js_space(c) && c != 0xfffc).collect::<Vec<u16>>();
    if squeeze(&doc.text[s..e]) != squeeze(&units[start..end]) {
        return uncertain;
    }
    let slice = |a: usize, b: usize| String::from_utf16_lossy(&doc.text[a..b]);
    Located {
        certain: true,
        quote: uncertain.quote,
        start: Some(s),
        end: Some(e),
        exact: Some(slice(s, e)),
        prefix: Some(slice(s.saturating_sub(CONTEXT), s)),
        suffix: Some(slice(e, (e + CONTEXT).min(doc.text.len()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEWS: &str = include_str!("../tests/fixtures/web/news-article.html");
    const PAPER: &str = include_str!("../tests/fixtures/web/journal-article.html");
    const BLOG: &str = include_str!("../tests/fixtures/web/blog-post.html");
    const STUB: &str = include_str!("../tests/fixtures/web/paywall-stub.html");

    fn all_text(doc: &WebDocument) -> String {
        doc.document
            .items
            .iter()
            .flat_map(|i| parts(i).into_iter().map(|(_, t, _)| t.to_string()).collect::<Vec<_>>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Every run is the page's text, exactly.
    fn assert_runs_exact(doc: &WebDocument) {
        for item in &doc.document.items {
            for (part, text, runs) in parts(item) {
                let units: Vec<u16> = text.encode_utf16().collect();
                for run in runs {
                    let at = run.at.expect("web runs are placed");
                    assert_eq!(&units[run.start..run.end], &doc.text[at..at + run.end - run.start], "item {} {part:?}: {:?}", item.id, String::from_utf16_lossy(&units[run.start..run.end]));
                }
            }
        }
    }

    #[test]
    fn reads_a_news_article_without_its_boilerplate() {
        let doc = assemble(NEWS);
        let text = all_text(&doc);
        assert_eq!(doc.document.quality.level, "good", "{:?}", doc.document.quality);
        for gone in ["We use cookies", "Sign up for our newsletter", "Share on", "Advertisement", "Most read", "Comments (", "All rights reserved", "Skip to content", "Sections"] {
            assert!(!text.contains(gone), "{gone:?} is boilerplate:\n{text}");
        }
        let items = &doc.document.items;
        assert_eq!(items[0].kind, "heading");
        assert_eq!(items[0].level, Some(1));
        assert!(items[0].text.starts_with("Harbour town"), "{}", items[0].text);
        assert!(items[0].runs.len() == 1, "the title is the page's heading");
        assert_eq!(items[1].kind, "byline");
        let meta = doc.document.meta.as_ref().unwrap();
        assert_eq!(meta.date.as_deref(), Some("14 March 2026"));
        assert_eq!(meta.site.as_deref(), Some("The Coastal Ledger"));
        // In order: standfirst, the paragraphs, the subheading, the quote, the list.
        let order = ["The council voted", "Tidal power", "Engineers say", "“We are not", "Next steps", "survey the seabed"];
        let at: Vec<usize> = order.iter().map(|o| text.find(o).unwrap_or_else(|| panic!("{o:?} missing:\n{text}"))).collect();
        assert!(at.windows(2).all(|w| w[0] < w[1]), "{order:?} out of order: {at:?}");
        let figure = items.iter().find(|i| i.kind == "figure").expect("the photo");
        assert!(figure.text.starts_with("The proposed site"), "{}", figure.text);
        assert!(figure.images[0].resource.is_some());
        assert!(items.iter().any(|i| i.kind == "quote"));
        assert!(items.iter().any(|i| i.kind == "list" && i.marker.as_deref() == Some("1.")));
        // Emphasis and links come along.
        assert!(items.iter().flat_map(|i| &i.spans).any(|s| s.kind == "em"));
        assert!(items.iter().flat_map(|i| &i.spans).any(|s| s.kind == "link" && s.href.as_deref().is_some_and(|h| h.starts_with("https://"))));
        assert_runs_exact(&doc);
    }

    #[test]
    fn reads_a_journal_article_with_sections_figures_tables_equations_and_references() {
        let doc = assemble(PAPER);
        let text = all_text(&doc);
        let items = &doc.document.items;
        assert_eq!(doc.document.quality.level, "good");
        for gone in ["Download PDF", "Similar articles", "Accept all cookies", "Journal home", "Cited by"] {
            assert!(!text.contains(gone), "{gone:?} is boilerplate");
        }
        let headings: Vec<&str> = doc.document.outline.iter().map(|o| o.text.as_str()).collect();
        assert_eq!(headings, ["Soil moisture memory and the timing of first flowering in upland meadows", "Abstract", "1. Introduction", "2. Methods", "2.1 Study sites", "2.2 Model", "3. Results", "4. Discussion", "References"]);
        let levels: Vec<u8> = doc.document.outline.iter().map(|o| o.level).collect();
        assert_eq!(levels, [1, 2, 2, 2, 3, 3, 2, 2, 2]);
        let figure = items.iter().find(|i| i.kind == "figure").expect("figure 1");
        assert!(figure.text.starts_with("Figure 1."), "{}", figure.text);
        assert!(figure.images.iter().all(|i| i.resource.is_some()));
        assert!(figure.anchors.contains(&"F1".to_string()));
        let table = items.iter().find(|i| i.kind == "table").expect("table 1");
        assert!(table.caption.as_ref().unwrap().text.starts_with("Table 1."));
        let rows = &table.table.as_ref().unwrap().rows;
        assert_eq!(rows.len(), 4);
        assert!(rows[0].iter().all(|c| c.header));
        assert_eq!(rows[1][0].text, "North slope");
        let equation = items.iter().find(|i| i.kind == "equation").expect("equation 1");
        let math = equation.math.as_deref().unwrap();
        assert!(math.contains("<mfrac>") && !math.contains("annotation") && !math.contains("\\frac"), "{math}");
        assert_eq!(equation.caption.as_ref().map(|c| c.text.as_str()), Some("(1)"));
        // Inline maths, mapped too.
        assert!(items.iter().flat_map(|i| &i.spans).any(|s| s.kind == "math"));
        // References, each its own entry, and citations pointing at them.
        let references: Vec<&Item> = items.iter().filter(|i| i.kind == "references").collect();
        assert_eq!(references.len(), 5, "{:#?}", references.iter().map(|r| &r.text).collect::<Vec<_>>());
        assert!(references[0].anchors.contains(&"B1".to_string()));
        let cites: Vec<&Span> = items.iter().flat_map(|i| &i.spans).filter(|s| s.kind == "cite").collect();
        assert!(cites.len() >= 4);
        assert!(cites.iter().all(|c| items[c.target.unwrap()].kind == "references"));
        // A link to the figure goes to it.
        assert!(items.iter().flat_map(|i| &i.spans).any(|s| s.kind == "link" && s.target == Some(figure.id)));
        assert!(items.iter().any(|i| i.kind == "footnote"));
        assert_runs_exact(&doc);
    }

    #[test]
    fn reads_a_short_blog_post() {
        let doc = assemble(BLOG);
        assert_eq!(doc.document.quality.level, "good", "{:?}", doc.document.quality);
        let kinds: Vec<&str> = doc.document.items.iter().map(|i| i.kind.as_str()).collect();
        assert!(kinds.starts_with(&["heading"]), "{kinds:?}");
        assert!(kinds.contains(&"code"));
        let code = doc.document.items.iter().find(|i| i.kind == "code").unwrap();
        assert!(code.text.contains("\n    "), "code keeps its lines and indents: {:?}", code.text);
        assert!(!all_text(&doc).contains("Older posts"));
        assert_runs_exact(&doc);
    }

    #[test]
    fn says_when_a_page_is_a_paywalled_stub() {
        let doc = assemble(STUB);
        assert_ne!(doc.document.quality.level, "good");
        assert!(doc.document.quality.reason.as_deref().unwrap().contains("paywall"));
        let app = assemble("<!doctype html><html><head><title>App</title></head><body><div id=root><button>Open</button></div></body></html>");
        assert_eq!(app.document.quality.level, "empty");
    }

    /// The page text is the reader's text index: hidden scripts, styles, templates and removed
    /// elements as the reader leaves them out.
    #[test]
    fn page_text_is_the_readers_text_index() {
        let html = "<!doctype html><html><head><title>T</title><style>p{}</style></head><body>A<script>x()</script><style>.b{}</style>B<noscript><p>no</p></noscript>C<iframe>frame</iframe><template>t</template>D<textarea>ta</textarea><svg><style>s</style></svg>E<object>fallback</object></body></html>";
        let doc = assemble(html);
        assert_eq!(String::from_utf16_lossy(&doc.text), "ABCDsE");
        // A misnested page parses as a browser parses it: the table's stray text moves before it.
        let doc = assemble("<body><table>stray<tr><td>cell</td></tr></table></body>");
        assert_eq!(String::from_utf16_lossy(&doc.text), "straycell");
    }

    #[test]
    fn maps_selections_highlights_and_places_both_ways() {
        let doc = assemble(PAPER);
        // Every word of every paragraph: selected in reading mode, it is certain and exact.
        let mut checked = 0;
        for item in doc.document.items.iter().filter(|i| i.kind == "paragraph") {
            let units: Vec<u16> = item.text.encode_utf16().collect();
            let (start, end) = (units.len() / 4, units.len() * 3 / 4);
            let found = locate(&doc, item.id, "", start, end);
            if item.spans.iter().any(|s| s.kind == "math" && s.start < end && s.end > start) {
                continue;
            }
            assert!(found.certain, "item {}: {:?}", item.id, item.text);
            let exact = found.exact.clone().unwrap();
            assert_eq!(collapse(&exact), collapse(&String::from_utf16_lossy(&units[start..end])));
            // Stored as the reader stores it, it shows on the same words.
            let annotation = serde_json::json!({ "id": "h", "text": exact, "color": "green", "anchor": { "version": 1, "kind": "web", "selectors": [
                { "type": "TextQuoteSelector", "exact": exact, "prefix": found.prefix, "suffix": found.suffix },
                { "type": "TextPositionSelector", "start": found.start, "end": found.end } ] } });
            let shown = marks(&doc, &[annotation]);
            assert_eq!(shown.len(), 1);
            let trimmed_start = start + units[start..end].iter().take_while(|&&u| u == 32).count();
            let trimmed_end = end - units[start..end].iter().rev().take_while(|&&u| u == 32).count();
            let m = &shown[0];
            assert!(m.item == item.id && m.start >= start && m.start <= trimmed_start && m.end >= trimmed_end && m.end <= end, "{m:?} for {start}..{end}");
            checked += 1;
        }
        assert!(checked >= 6);
        // A highlight whose stored position is stale is found by its quote.
        let target = doc.document.items.iter().find(|i| i.text.contains("snowmelt")).unwrap();
        let annotation = serde_json::json!({ "id": "q", "text": "snowmelt", "anchor": { "kind": "web", "selectors": [
            { "type": "TextQuoteSelector", "exact": "snowmelt", "prefix": "", "suffix": "" }, { "type": "TextPositionSelector", "start": 3, "end": 11 } ] } });
        let shown = marks(&doc, &[annotation]);
        assert_eq!(shown[0].item, target.id);
        // A place on the page finds its item; a cell of a table is a part of its own.
        let run = &target.runs[0];
        assert_eq!(item_at(&doc, run.at.unwrap()), Some(target.id));
        let table = doc.document.items.iter().find(|i| i.kind == "table").unwrap();
        let cell = &table.table.as_ref().unwrap().rows[1][0];
        let found = locate(&doc, table.id, "cell:1:0", 0, cell.text.encode_utf16().count());
        assert!(found.certain && found.exact.as_deref() == Some("North slope"));
        let projected = project(&doc, found.start.unwrap(), found.end.unwrap());
        assert_eq!(projected, vec![Stretch { item: table.id, part: "cell:1:0".into(), start: 0, end: 11 }]);
        // Text reading mode adds (a line break, a picture) is not on the page: a selection of
        // only that is not certain.
        let byline = &doc.document.items[1];
        assert!(!locate(&doc, byline.id, "nope", 0, 2).certain);
    }

    #[test]
    fn small_helpers() {
        assert_eq!(readable_date("2021-05-04"), Some("4 May 2021".into()));
        assert_eq!(readable_date("2021-05-04T10:00:00Z"), Some("4 May 2021".into()));
        assert_eq!(readable_date("2019"), Some("2019".into()));
        assert_eq!(flip_name("Okafor, Adaeze"), "Adaeze Okafor");
        assert_eq!(join_names(&["A".into(), "B".into(), "C".into()]), "A, B and C");
        assert_eq!(join_url("https://ex.org/a/b.html?x", "c.png").as_deref(), Some("https://ex.org/a/c.png"));
        assert_eq!(join_url("https://ex.org/a/b", "/d").as_deref(), Some("https://ex.org/d"));
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert!(chrome_name("site-header") && chrome_name("nav") && !chrome_name("article-header"));
        let mut inl = Inline::default();
        inl.add("  a \n b  ", Some(0), false);
        let (text, runs, _) = inl.finish();
        assert_eq!(text, "a b");
        assert_eq!(runs.iter().map(|r| (r.start, r.end, r.at.unwrap())).collect::<Vec<_>>(), [(0, 2, 2), (2, 3, 6)]);
    }
}
