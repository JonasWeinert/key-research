// Reading mode: a PDF as clean, reflowed text, assembled from the structure layout analysis
// stored for it (layout.rs `Layout`). Paragraphs merge across columns and pages, words broken
// at line ends join again, running headers, footers and page numbers go, headings keep their
// levels, and figures, tables, formulas and algorithms stay as crops of their page with their
// captions. Every piece of text keeps the page and rectangles it came from (`Run`), so a place
// or a selection in the text maps back to the PDF (`pieces`, `locate`) and highlights made on
// the page find their words in the text (`marks`). The renderer only displays the result.
use crate::{Layout, LayoutBlock, LayoutPage};
use serde::Serialize;
use serde_json::Value as Json;

/// Where a stretch of an item's text is on the page: UTF-16 offsets (as the renderer counts).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub start: usize,
    pub end: usize,
    pub page: i64,
    /// [x, y, width, height] on the 0..65535 page scale.
    pub rects: Vec<[u16; 4]>,
    /// A saved web page's: where the run's text starts in the page's text (UTF-16, as the web
    /// reader's text index counts); the run is that text exactly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub page: i64,
    pub rect: [u16; 4],
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub text: String,
    pub runs: Vec<Run>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub spans: Vec<Span>,
}

/// Inline markup over `start..end` (UTF-16) of a text: emphasis, code, a link (to an address or
/// to another item), a citation of a reference, MathML, or a small picture standing for one
/// character (U+FFFC) of the text. Web pages only; PDF text has none.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start: usize,
    pub end: usize,
    /// em | strong | code | sup | sub | link | cite | math | image
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    /// The item a link inside the page goes to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<usize>,
    /// Sanitised MathML.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub math: Option<String>,
    /// A picture by its resource number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
}

/// A picture of a saved web page, by its resource number (the page's own inlined copy).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<usize>,
    pub alt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub text: String,
    pub runs: Vec<Run>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub spans: Vec<Span>,
    pub header: bool,
    #[serde(skip_serializing_if = "is_one")]
    pub colspan: u32,
    #[serde(skip_serializing_if = "is_one")]
    pub rowspan: u32,
}
fn is_one(n: &u32) -> bool {
    *n == 1
}

/// A web page's table as text, cell by cell.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub rows: Vec<Vec<Cell>>,
}

/// What a web page says about itself, shown under its title.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: usize,
    /// heading | paragraph | list | references | footnote | figure | table | equation | algorithm
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
    pub text: String,
    /// The page it starts on (zero-based).
    pub page: i64,
    pub runs: Vec<Run>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crop: Option<Crop>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<Caption>,
    // Web pages only (web_reflow.rs).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub spans: Vec<Span>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<Image>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<Table>,
    /// An equation's MathML (sanitised).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub math: Option<String>,
    /// A list item's bullet or number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    /// The page's element ids that start in this item (in-page links go there).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub anchors: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineEntry {
    pub item: usize,
    pub level: u8,
    pub text: String,
    pub page: i64,
}

/// Whether the text is worth showing: "good", "poor" (say why instead of showing garbage) or
/// "empty" (nothing to show).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    pub level: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub page_count: usize,
    pub engine: String,
    pub quality: Quality,
    pub items: Vec<Item>,
    pub outline: Vec<OutlineEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Meta>,
}

const FULL: f32 = u16::MAX as f32;
/// Top and bottom bands of a page where running headers and footers live.
const BAND: f32 = 0.08;

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn top(r: &[u16; 4]) -> f32 {
    r[1] as f32 / FULL
}
fn bottom(r: &[u16; 4]) -> f32 {
    (r[1] as f32 + r[3] as f32) / FULL
}
fn overlaps_x(a: &[u16; 4], b: &[u16; 4]) -> bool {
    let (a0, a1) = (a[0] as u32, a[0] as u32 + a[2] as u32);
    let (b0, b1) = (b[0] as u32, b[0] as u32 + b[2] as u32);
    a0.max(b0) < a1.min(b1)
}
fn area(r: &[u16; 4]) -> f32 {
    (r[2] as f32 / FULL) * (r[3] as f32 / FULL)
}
fn union(a: [u16; 4], b: [u16; 4]) -> [u16; 4] {
    let x = a[0].min(b[0]);
    let y = a[1].min(b[1]);
    let right = (a[0] as u32 + a[2] as u32).max(b[0] as u32 + b[2] as u32).min(65535) as u16;
    let bottom = (a[1] as u32 + a[3] as u32).max(b[1] as u32 + b[3] as u32).min(65535) as u16;
    [x, y, right - x, bottom - y]
}

/// The area two boxes share, as a fraction of the page.
fn intersection(a: &[u16; 4], b: &[u16; 4]) -> f32 {
    let w = ((a[0] as f32 + a[2] as f32).min(b[0] as f32 + b[2] as f32) - (a[0] as f32).max(b[0] as f32)).max(0.0) / FULL;
    let h = ((a[1] as f32 + a[3] as f32).min(b[1] as f32 + b[3] as f32) - (a[1] as f32).max(b[1] as f32)).max(0.0) / FULL;
    w * h
}

/// Many words, few numbers: sentences, not a table's cells.
fn prose_like(text: &str) -> bool {
    let words = text.split_whitespace().count();
    let chars = text.chars().filter(|c| !c.is_whitespace()).count().max(1);
    let digits = text.chars().filter(char::is_ascii_digit).count();
    words >= 60 && (digits as f32 / chars as f32) < 0.12 && text.matches(". ").count() >= 3
}

const CONJUNCTIONS: &[&str] = &["and", "or", "nor", "to", "but", "versus", "vs"];

/// One line of extracted text made readable: soft hyphens out, whitespace collapsed, and a word
/// broken at a line end ("compar- ison") joined again. A hyphen before "and"/"or" stays
/// ("short- and long-term").
pub fn clean_text(text: &str) -> String {
    let text = text.replace('\u{00AD}', "");
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < words.len() {
        let mut word = words[i].to_string();
        while i + 1 < words.len() && joins(&word, words[i + 1]) {
            word.pop();
            word.push_str(words[i + 1]);
            i += 1;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&word);
        i += 1;
    }
    out
}

/// "compar-" + "ison" read as one word.
fn joins(left: &str, right: &str) -> bool {
    let mut chars = left.chars().rev();
    let (Some('-'), Some(before)) = (chars.next(), chars.next()) else { return false };
    if !before.is_alphabetic() || left.chars().filter(|c| c.is_alphabetic()).count() < 2 {
        return false;
    }
    let first = right.chars().next();
    let bare: String = right.chars().take_while(|c| c.is_alphabetic()).collect();
    first.is_some_and(|c| c.is_lowercase()) && !CONJUNCTIONS.contains(&bare.as_str())
}

/// Text that ends a sentence: the next block starts a new paragraph.
fn finished(text: &str) -> bool {
    let trimmed = text.trim_end_matches(|c: char| c.is_whitespace() || matches!(c, '"' | '\u{201D}' | '\u{2019}' | '\'' | ')' | ']'));
    trimmed.ends_with(['.', '!', '?', ':', ';', '\u{2026}'])
}

/// Is `next` the rest of a paragraph that stopped at a column or page break?
fn continues(previous: &str, next: &str) -> bool {
    if previous.trim().is_empty() || finished(previous) {
        return false;
    }
    let first = next.trim_start().chars().next();
    previous.trim_end().ends_with(['-', ',', '(']) || first.is_some_and(char::is_lowercase) || citation_marker(next)
}

/// A citation's superscript the analyser left as a block of its own ("1", "2,3", "[4]").
fn citation_marker(text: &str) -> bool {
    let t = text.trim();
    !t.is_empty() && t.chars().count() <= 12 && t.chars().any(|c| c.is_ascii_digit()) && t.chars().all(|c| c.is_ascii_digit() || ",-–[]() ".contains(c))
}

/// "Figure 2.", "Fig. 3:", "Table 1", "Scheme 4" at the start of a block.
pub(crate) fn caption_kind(text: &str) -> Option<&'static str> {
    let lower = text.trim_start().to_lowercase();
    let (kind, rest) = [("figure", "figure"), ("fig.", "figure"), ("fig", "figure"), ("table", "table"), ("tab.", "table"), ("scheme", "figure"), ("chart", "figure"), ("exhibit", "figure")]
        .iter()
        .find_map(|(prefix, kind)| lower.strip_prefix(prefix).map(|rest| (*kind, rest)))?;
    let rest = rest.trim_start();
    let label: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    let numbered = label.chars().next().is_some_and(|c| c.is_ascii_digit()) || (!label.is_empty() && label.chars().all(|c| "ivxlc".contains(c)) && label.len() <= 5);
    let after = rest[label.len()..].chars().next();
    (numbered && after.is_none_or(|c| matches!(c, '.' | ':' | ' ' | '|' | '\u{2013}' | '\u{2014}' | '-' | ')'))).then_some(kind)
}

/// Running heads the analyser left as paragraphs: short lines in a page's top or bottom band
/// that repeat (numbers aside) on several pages, and bare page numbers there.
fn running_furniture(blocks: &[LayoutBlock], page_count: usize) -> Vec<bool> {
    let key = |b: &LayoutBlock| -> Option<String> {
        let text = b.text.trim();
        let banded = bottom(&b.bounds) <= BAND + 0.02 || top(&b.bounds) >= 1.0 - BAND - 0.02;
        (banded && b.kind == "paragraph" && text.chars().count() <= 140)
            .then(|| text.to_lowercase().chars().filter(|c| c.is_alphabetic() || c.is_whitespace()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" "))
    };
    let mut pages: std::collections::HashMap<String, std::collections::HashSet<i64>> = Default::default();
    for block in blocks {
        if let Some(k) = key(block).filter(|k| !k.is_empty()) {
            pages.entry(k).or_default().insert(block.page);
        }
    }
    let needed = if page_count >= 6 { 3 } else { 2 };
    blocks
        .iter()
        .map(|b| match key(b) {
            Some(k) if k.is_empty() => is_page_number(&b.text),
            Some(k) => pages.get(&k).is_some_and(|p| p.len() >= needed),
            None => false,
        })
        .collect()
}

fn is_page_number(text: &str) -> bool {
    let t = text.trim().trim_start_matches(|c: char| c == '-' || c == '\u{2013}').trim_end_matches(|c: char| c == '-' || c == '\u{2013}').trim();
    let t = t.strip_prefix("page ").or_else(|| t.strip_prefix("Page ")).unwrap_or(t);
    !t.is_empty() && t.len() <= 8 && (t.chars().all(|c| c.is_ascii_digit() || c == ' ' || c == '/') || t.chars().all(|c| "ivxlcIVXLC".contains(c)))
}

/// Text with its runs, built piece by piece.
#[derive(Default)]
struct Builder {
    text: String,
    runs: Vec<Run>,
}

impl Builder {
    /// Appends `piece` (cleaned) from `page`; `sep` between it and what came before, unless a
    /// broken word joins across the two.
    fn push(&mut self, piece: &str, page: i64, rects: Vec<[u16; 4]>, sep: &str) {
        let piece = clean_text(piece);
        if piece.is_empty() {
            return;
        }
        if !self.text.is_empty() {
            let last = self.text.rsplit(' ').next().unwrap_or("").to_string();
            let first = piece.split(' ').next().unwrap_or("");
            if sep == " " && joins(&last, first) {
                self.text.pop();
                if let Some(run) = self.runs.last_mut() {
                    run.end -= 1;
                }
            } else {
                self.text.push_str(sep);
            }
        }
        let start = utf16_len(&self.text);
        self.text.push_str(&piece);
        let end = utf16_len(&self.text);
        self.runs.push(Run { start, end, page, rects, at: None });
    }

    fn block(&mut self, block: &LayoutBlock, sep: &str) {
        if block.sentences.is_empty() || matches!(block.kind.as_str(), "list" | "reference_list" | "endnote_list") {
            let lines: Vec<&str> = block.text.lines().filter(|l| !l.trim().is_empty()).collect();
            // A reference list whose entries are known (html_align.rs): an entry's lines join.
            let entries = &block.entries;
            for (i, line) in lines.iter().enumerate() {
                let next = if entries.is_empty() || entries.contains(&(i as u32)) { "\n" } else { " " };
                self.push(line, block.page, vec![block.bounds], if i == 0 { sep } else { next });
            }
        } else {
            for (i, sentence) in block.sentences.iter().enumerate() {
                let rects = if sentence.rects.is_empty() { vec![block.bounds] } else { sentence.rects.clone() };
                self.push(&sentence.text, block.page, rects, if i == 0 { sep } else { " " });
            }
        }
    }
}

/// One element of the flow before items are numbered.
enum Element<'a> {
    Block(usize, &'a LayoutBlock),
    Figure(i64, [u16; 4]),
}

/// Pictures worth showing: big enough, overlapping ones merged.
fn figures(page: &LayoutPage) -> Vec<[u16; 4]> {
    let mut out: Vec<[u16; 4]> = Vec::new();
    for rect in page.images.iter().filter(|r| area(r) >= 0.012 && r[2] as f32 / FULL >= 0.08 && r[3] as f32 / FULL >= 0.04) {
        if let Some(existing) = out.iter_mut().find(|o| overlaps_x(o, rect) && top(o).max(top(rect)) <= bottom(o).min(bottom(rect)) + 0.01) {
            *existing = union(*existing, *rect);
        } else {
            out.push(*rect);
        }
    }
    out
}

/// The document as reading mode shows it.
pub fn assemble(layout: &Layout) -> Document {
    let blocks = &layout.blocks;
    let page_count = layout.page_count.max(blocks.iter().map(|b| b.page as usize + 1).max().unwrap_or(0));
    let furniture = running_furniture(blocks, page_count);
    let dropped = |i: usize, b: &LayoutBlock| furniture[i] || matches!(b.kind.as_str(), "header" | "footer" | "page_number");

    // Captions: attached to the figure or table nearest them on their page.
    let mut caption_of: std::collections::HashMap<usize, (&'static str, usize)> = Default::default(); // block -> (kind, caption block)
    let mut figure_list: Vec<(i64, [u16; 4], Option<usize>)> = layout.pages.iter().flat_map(|p| figures(p).into_iter().map(move |r| (p.page, r, None))).collect();
    let mut captions: Vec<usize> = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        if block.kind != "paragraph" || dropped(i, block) {
            continue;
        }
        let Some(kind) = block.caption.as_deref().map(|c| if c == "table" { "table" } else { "figure" }).or_else(|| caption_kind(&block.text)) else { continue };
        let distance = |r: &[u16; 4]| (top(&block.bounds) - bottom(r)).abs().min((top(r) - bottom(&block.bounds)).abs());
        if kind == "table" {
            let table = blocks
                .iter()
                .enumerate()
                .filter(|(j, b)| b.kind == "table" && b.page == block.page && !caption_of.contains_key(j))
                .min_by(|a, b| distance(&a.1.bounds).total_cmp(&distance(&b.1.bounds)))
                .filter(|(_, b)| distance(&b.bounds) < 0.25);
            if let Some((j, _)) = table {
                caption_of.insert(j, ("table", i));
                captions.push(i);
                continue;
            }
        }
        let near = figure_list
            .iter_mut()
            .filter(|(page, _, caption)| *page == block.page && caption.is_none())
            .min_by(|a, b| distance(&a.1).total_cmp(&distance(&b.1)))
            .filter(|f| distance(&f.1) < 0.25);
        if let Some(figure) = near {
            figure.2 = Some(i);
            captions.push(i);
            continue;
        }
        // No picture found: the figure is the drawing between the caption and the text above it
        // (a table's, below it), in the caption's column.
        let column = {
            let width = (block.bounds[2] as f32 / FULL).max(0.3);
            let centre = (block.bounds[0] as f32 + block.bounds[2] as f32 / 2.0) / FULL;
            let x = (centre - width / 2.0).clamp(0.0, 1.0 - width);
            [(x * FULL) as u16, 0, (width * FULL) as u16, 0]
        };
        let same_page = || blocks.iter().enumerate().filter(|(j, b)| *j != i && b.page == block.page && !dropped(*j, b) && overlaps_x(&b.bounds, &column));
        let region = if kind == "table" {
            let below = same_page().filter(|(_, b)| top(&b.bounds) > bottom(&block.bounds)).map(|(_, b)| top(&b.bounds)).fold(1.0 - BAND, f32::min);
            (bottom(&block.bounds), below)
        } else {
            let above = same_page().filter(|(_, b)| bottom(&b.bounds) < top(&block.bounds)).map(|(_, b)| bottom(&b.bounds)).fold(BAND, f32::max);
            (above, top(&block.bounds))
        };
        if region.1 - region.0 >= 0.05 {
            let rect = [column[0], (region.0 * FULL) as u16, column[2], ((region.1 - region.0) * FULL) as u16];
            figure_list.push((block.page, rect, Some(i)));
            captions.push(i);
        }
    }
    let is_caption = |i: usize| captions.contains(&i);

    // The flow: blocks in reading order, each figure after the last block above it on its page.
    let mut flow: Vec<Element> = Vec::new();
    let mut placed = vec![false; figure_list.len()];
    for (i, block) in blocks.iter().enumerate() {
        // A figure comes before the first block below its top in its column (often its caption).
        for (f, (page, rect, _)) in figure_list.iter().enumerate() {
            if !placed[f] && *page == block.page && top(rect) <= top(&block.bounds) && overlaps_x(rect, &block.bounds) {
                placed[f] = true;
                flow.push(Element::Figure(f as i64, *rect));
            }
        }
        // A new page: figures left on the pages before it.
        if i > 0 && blocks[i - 1].page != block.page {
            for (f, (page, rect, _)) in figure_list.iter().enumerate() {
                if !placed[f] && *page < block.page {
                    placed[f] = true;
                    flow.push(Element::Figure(f as i64, *rect));
                }
            }
        }
        flow.push(Element::Block(i, block));
    }
    for (f, (_, rect, _)) in figure_list.iter().enumerate() {
        if !placed[f] {
            flow.push(Element::Figure(f as i64, *rect));
        }
    }

    let caption_for = |index: usize| -> Option<Caption> {
        let mut b = Builder::default();
        b.block(&blocks[index], "");
        (!b.text.is_empty()).then(|| Caption { text: b.text, runs: b.runs, ..Default::default() })
    };
    let levels: Vec<u8> = {
        let mut seen: Vec<u8> = blocks.iter().filter(|b| b.kind == "heading").filter_map(|b| b.level).collect();
        seen.sort_unstable();
        seen.dedup();
        seen
    };
    let level_of = |b: &LayoutBlock| b.level.and_then(|l| levels.iter().position(|x| *x == l)).map_or(2, |rank| (rank as u8 + 1).min(4));

    let mut items: Vec<Item> = Vec::new();
    let mut open: Option<(Builder, i64)> = None;
    let mut pending: Vec<Item> = Vec::new();
    let new_item = |kind: &str, builder: Builder, page: i64| Item { kind: kind.into(), text: builder.text, page, runs: builder.runs, ..Default::default() };
    let flush = |open: &mut Option<(Builder, i64)>, pending: &mut Vec<Item>, items: &mut Vec<Item>| {
        if let Some((builder, page)) = open.take() {
            if !builder.text.is_empty() {
                items.push(new_item("paragraph", builder, page));
            }
        }
        items.append(pending);
    };
    for element in flow {
        match element {
            Element::Figure(f, rect) => {
                let (page, _, caption) = figure_list[f as usize];
                let mut item = new_item("figure", Builder::default(), page);
                item.crop = Some(Crop { page, rect });
                item.caption = caption.and_then(caption_for);
                item.text = item.caption.as_ref().map(|c| c.text.clone()).unwrap_or_default();
                item.runs = Vec::new();
                if open.as_ref().is_some_and(|(b, _)| !finished(&b.text)) {
                    pending.push(item);
                } else {
                    flush(&mut open, &mut pending, &mut items);
                    items.push(item);
                }
            }
            Element::Block(i, block) => {
                if dropped(i, block) || is_caption(i) {
                    continue;
                }
                match block.kind.as_str() {
                    "heading" => {
                        flush(&mut open, &mut pending, &mut items);
                        let mut b = Builder::default();
                        b.block(block, "");
                        if !b.text.is_empty() {
                            let mut item = new_item("heading", b, block.page);
                            item.level = Some(level_of(block));
                            items.push(item);
                        }
                    }
                    "paragraph" => {
                        let first = block.sentences.first().map_or(block.text.as_str(), |s| s.text.as_str());
                        if let Some((builder, _)) = open.as_mut().filter(|(b, _)| continues(&b.text, first)) {
                            builder.block(block, " ");
                        } else {
                            flush(&mut open, &mut pending, &mut items);
                            let mut b = Builder::default();
                            b.block(block, "");
                            open = Some((b, block.page));
                        }
                    }
                    "table" if !caption_of.contains_key(&i) && prose_like(&block.text) => {
                        // Running text the analyser boxed as a table (back matter in columns): its
                        // words are in the paragraphs around it when those cover it, else read it as text.
                        let covered: f32 = blocks
                            .iter()
                            .enumerate()
                            .filter(|(j, b)| *j != i && b.page == block.page && b.kind == "paragraph")
                            .map(|(_, b)| intersection(&b.bounds, &block.bounds))
                            .sum();
                        if covered < 0.5 * area(&block.bounds) {
                            flush(&mut open, &mut pending, &mut items);
                            let mut b = Builder::default();
                            b.block(block, "");
                            if !b.text.is_empty() {
                                items.push(new_item("paragraph", b, block.page));
                            }
                        }
                    }
                    "table" | "equation" | "algorithm" | "footnote" => {
                        let kind = block.kind.as_str();
                        let mut b = Builder::default();
                        b.block(block, "");
                        let mut item = new_item(kind, b, block.page);
                        if kind != "footnote" {
                            item.crop = Some(Crop { page: block.page, rect: block.bounds });
                        }
                        if let Some((_, caption)) = caption_of.get(&i) {
                            item.caption = caption_for(*caption);
                        }
                        // Formulas and algorithms sit in the sentence's flow; tables and notes float.
                        let floats = matches!(kind, "table" | "footnote");
                        if floats && open.as_ref().is_some_and(|(b, _)| !finished(&b.text)) {
                            pending.push(item);
                        } else {
                            flush(&mut open, &mut pending, &mut items);
                            items.push(item);
                        }
                    }
                    other => {
                        flush(&mut open, &mut pending, &mut items);
                        let mut b = Builder::default();
                        b.block(block, "");
                        if !b.text.is_empty() {
                            let kind = match other {
                                "reference_list" => "references",
                                "endnote_list" => "footnote",
                                "list" => "list",
                                _ => "paragraph",
                            };
                            items.push(new_item(kind, b, block.page));
                        }
                    }
                }
            }
        }
    }
    flush(&mut open, &mut pending, &mut items);
    for (id, item) in items.iter_mut().enumerate() {
        item.id = id;
    }
    let outline = items
        .iter()
        .filter(|i| i.kind == "heading")
        .map(|i| OutlineEntry { item: i.id, level: i.level.unwrap_or(2), text: i.text.clone(), page: i.page })
        .collect();
    let quality = quality(&items, page_count);
    Document { page_count, engine: layout.engine.clone(), quality, items, outline, meta: None }
}

fn quality(items: &[Item], page_count: usize) -> Quality {
    let prose: Vec<&Item> = items.iter().filter(|i| matches!(i.kind.as_str(), "paragraph" | "heading" | "list")).collect();
    let chars: usize = prose.iter().map(|i| i.text.chars().filter(|c| !c.is_whitespace()).count()).sum();
    if chars < 40 {
        return Quality { level: "empty", reason: Some("Key found no text to show in this PDF. It may be a scan whose text was never recognised (OCR).".into()) };
    }
    if page_count > 0 && chars / page_count < 80 {
        return Quality { level: "poor", reason: Some("Most pages of this PDF have little text Key can read. It may be a scan without recognised text (OCR), or mostly pictures.".into()) };
    }
    let symbols = prose.iter().flat_map(|i| i.text.chars()).filter(|c| !c.is_alphanumeric() && !c.is_whitespace() && !".,;:!?'\"()[]-\u{2013}\u{2014}\u{2019}\u{201C}\u{201D}%/".contains(*c)).count();
    let equations = items.iter().filter(|i| i.kind == "equation").count();
    if symbols as f32 / chars as f32 > 0.18 || (equations >= 8 && equations * 2 >= prose.len()) {
        return Quality { level: "poor", reason: Some("This document is mostly mathematics or symbols, which reading mode cannot show reliably. The page view shows it as printed.".into()) };
    }
    Quality { level: "good", reason: None }
}

/// Letters and digits only, lowercased, with each folded char's owner (an index into `owners`'
/// source: a UTF-16 offset for item text, a character index for PDF text).
fn fold_into(value: &str, owner: usize, out: &mut Vec<char>, owners: &mut Vec<usize>) {
    for c in value.chars() {
        let expanded: &str = match c {
            '\u{FB00}' => "ff",
            '\u{FB01}' => "fi",
            '\u{FB02}' => "fl",
            '\u{FB03}' => "ffi",
            '\u{FB04}' => "ffl",
            _ => "",
        };
        if !expanded.is_empty() {
            for e in expanded.chars() {
                out.push(e);
                owners.push(owner);
            }
            continue;
        }
        if c.is_alphanumeric() {
            for lower in c.to_lowercase() {
                out.push(lower);
                owners.push(owner);
            }
        }
    }
}

fn fold(value: &str) -> Vec<char> {
    let (mut out, mut owners) = (Vec::new(), Vec::new());
    fold_into(value, 0, &mut out, &mut owners);
    out
}

/// Folded text of an item with, per folded char, the UTF-16 offset of its source char.
fn fold_item(text: &str) -> (Vec<char>, Vec<usize>) {
    let (mut out, mut owners) = (Vec::new(), Vec::new());
    let mut offset = 0;
    for c in text.chars() {
        let mut buffer = [0u8; 4];
        fold_into(c.encode_utf8(&mut buffer), offset, &mut out, &mut owners);
        offset += c.len_utf16();
    }
    (out, owners)
}

fn find_all(haystack: &[char], needle: &[char]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return Vec::new();
    }
    (0..=haystack.len() - needle.len()).filter(|&i| haystack[i..i + needle.len()] == *needle).collect()
}

/// A highlight made on the page, shown on the words it covers in reading mode.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub annotation_id: String,
    pub item: usize,
    /// Which text of the item, when not its own: "caption", or a table cell "cell:row:column".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
    pub start: usize,
    pub end: usize,
    pub color: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

/// Where each annotation's text is in the document (annotations as the reader stores them:
/// `id`, `text`, `color`, `comment`, `range.start.page`, `range.end.page`).
pub fn marks(document: &Document, annotations: &[Json]) -> Vec<Mark> {
    let mut out = Vec::new();
    for annotation in annotations {
        let (Some(id), Some(text)) = (annotation["id"].as_str(), annotation["text"].as_str()) else { continue };
        let first = annotation["range"]["start"]["page"].as_i64().unwrap_or(-1);
        let last = annotation["range"]["end"]["page"].as_i64().unwrap_or(first);
        let mark = |item: usize, start: usize, end: usize| Mark {
            annotation_id: id.to_string(),
            item,
            part: None,
            start,
            end,
            color: annotation["color"].as_str().unwrap_or("orange").to_string(),
            comment: annotation["comment"].as_str().filter(|c| !c.trim().is_empty()).map(str::to_string),
        };
        let needle = fold(text);
        if needle.len() < 3 {
            continue;
        }
        let candidates: Vec<&Item> = document.items.iter().filter(|i| i.runs.iter().any(|r| r.page >= first && r.page <= last) || (i.runs.is_empty() && i.page >= first && i.page <= last)).collect();
        let folded: Vec<(Vec<char>, Vec<usize>)> = candidates.iter().map(|i| fold_item(&i.text)).collect();
        let end_of = |item: &Item, owners: &[usize], at: usize| owners.get(at + 1).copied().unwrap_or_else(|| utf16_len(&item.text)).min(next_char_end(&item.text, owners[at]));
        let mut found = false;
        for (k, (hay, owners)) in folded.iter().enumerate() {
            if let Some(&at) = find_all(hay, &needle).first() {
                let item = candidates[k];
                out.push(mark(item.id, owners[at], end_of(item, owners, at + needle.len() - 1)));
                found = true;
                break;
            }
        }
        if found {
            continue;
        }
        // Across a paragraph break: its opening in one item, its close in a later one.
        let probe = needle.len().min(24);
        if probe < 12 {
            continue;
        }
        let head = &needle[..probe];
        let tail = &needle[needle.len() - probe..];
        let Some((a, at)) = folded.iter().enumerate().find_map(|(k, (hay, _))| find_all(hay, head).first().map(|at| (k, *at))) else { continue };
        let Some((b, end)) = folded.iter().enumerate().skip(a + 1).find_map(|(k, (hay, _))| find_all(hay, tail).first().map(|at| (k, *at + probe - 1))) else { continue };
        for k in a..=b {
            let item = candidates[k];
            let owners = &folded[k].1;
            let start = if k == a { owners[at] } else { 0 };
            let stop = if k == b { end_of(item, owners, end) } else { utf16_len(&item.text) };
            out.push(mark(item.id, start, stop));
        }
    }
    out
}

/// The UTF-16 offset just past the char starting at `offset`.
fn next_char_end(text: &str, offset: usize) -> usize {
    let mut at = 0;
    for c in text.chars() {
        let next = at + c.len_utf16();
        if at >= offset {
            return next;
        }
        at = next;
    }
    at
}

fn slice16(text: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16_lossy(&units[start.min(units.len())..end.min(units.len())])
}

/// The part of a selection on one page, with the rectangles its words came from.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Piece {
    pub page: i64,
    pub text: String,
    pub rects: Vec<[u16; 4]>,
}

/// A selection `start..end` (UTF-16) in item `item` (its caption with `caption`), cut at page
/// changes: what to look for on each page of the PDF.
pub fn pieces(document: &Document, item: usize, caption: bool, start: usize, end: usize) -> Vec<Piece> {
    let Some(item) = document.items.get(item) else { return Vec::new() };
    let (text, runs) = match (caption, &item.caption) {
        (true, Some(c)) => (&c.text, &c.runs),
        _ => (&item.text, &item.runs),
    };
    let mut out: Vec<Piece> = Vec::new();
    for run in runs.iter().filter(|r| r.start < end && r.end > start) {
        let part = slice16(text, run.start.max(start), run.end.min(end));
        match out.last_mut() {
            Some(last) if last.page == run.page => {
                last.text.push(' ');
                last.text.push_str(&part);
                last.rects.extend(run.rects.iter().copied());
            }
            _ => out.push(Piece { page: run.page, text: part, rects: run.rects.clone() }),
        }
    }
    out
}

/// A page's text as the reader indexes it: each char's text and box in points
/// [left, top, right, bottom], with the page size.
pub struct PageChars {
    pub page: i64,
    pub width: f32,
    pub height: f32,
    pub chars: Vec<(String, Option<[f32; 4]>)>,
}

/// Where `piece` is in the page's chars (first and last char index), when that is certain:
/// found once, or once inside the rectangles it came from.
pub fn locate(page: &PageChars, piece: &Piece) -> Option<(usize, usize)> {
    let needle = fold(&piece.text);
    if needle.is_empty() {
        return None;
    }
    let (mut hay, mut owners) = (Vec::new(), Vec::new());
    for (index, (value, _)) in page.chars.iter().enumerate() {
        fold_into(value, index, &mut hay, &mut owners);
    }
    let found = find_all(&hay, &needle);
    let span = |at: usize| (owners[at], owners[at + needle.len() - 1]);
    match found.len() {
        0 => None,
        1 => Some(span(found[0])),
        _ => {
            let inside = |at: usize| {
                let Some(Some(b)) = page.chars.get(owners[at]).map(|c| c.1) else { return false };
                let (x, y) = ((b[0] + b[2]) / 2.0 / page.width.max(1.0) * FULL, (b[1] + b[3]) / 2.0 / page.height.max(1.0) * FULL);
                piece.rects.iter().any(|r| x >= r[0] as f32 - 400.0 && x <= r[0] as f32 + r[2] as f32 + 400.0 && y >= r[1] as f32 - 400.0 && y <= r[1] as f32 + r[3] as f32 + 400.0)
            };
            let within: Vec<usize> = found.into_iter().filter(|at| inside(*at)).collect();
            (within.len() == 1).then(|| span(within[0]))
        }
    }
}

/// The boxes of chars `first..=last` on the page, one per line, on the 0..65535 page scale.
pub fn span_rects(page: &PageChars, (first, last): (usize, usize)) -> Vec<[u16; 4]> {
    let mut lines: Vec<[f32; 4]> = Vec::new();
    for (_, bounds) in page.chars.iter().take(last + 1).skip(first) {
        let Some(b) = bounds else { continue };
        match lines.last_mut() {
            Some(line) if b[1] < line[3] && b[3] > line[1] && b[0] >= line[0] - 2.0 => {
                line[0] = line[0].min(b[0]);
                line[1] = line[1].min(b[1]);
                line[2] = line[2].max(b[2]);
                line[3] = line[3].max(b[3]);
            }
            _ => lines.push(*b),
        }
    }
    let (w, h) = (page.width.max(1.0), page.height.max(1.0));
    let q = |v: f32, size: f32| ((v / size).clamp(0.0, 1.0) * FULL).round() as u16;
    lines.iter().map(|l| [q(l[0], w), q(l[1], h), q(l[2] - l[0], w), q(l[3] - l[1], h)]).collect()
}

/// The first item at or after a place on the page view (page, fraction down it).
pub fn item_at(document: &Document, page: i64, fraction: f32) -> Option<usize> {
    let y = (fraction.clamp(0.0, 1.0) * FULL) as u32;
    let position = |item: &Item| -> (i64, u32) {
        item.runs.iter().map(|r| (r.page, r.rects.first().map_or(0, |b| b[1] as u32 + b[3] as u32))).max_by_key(|p| *p).or_else(|| item.crop.as_ref().map(|c| (c.page, c.rect[1] as u32 + c.rect[3] as u32))).unwrap_or((item.page, 0))
    };
    document.items.iter().find(|item| position(item) >= (page, y)).or(document.items.last()).map(|i| i.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{LayoutSentence, LayoutPage};

    fn q(x: f32, y: f32, w: f32, h: f32) -> [u16; 4] {
        [(x * FULL) as u16, (y * FULL) as u16, (w * FULL) as u16, (h * FULL) as u16]
    }
    fn block(page: i64, kind: &str, rect: [u16; 4], sentences: &[&str]) -> LayoutBlock {
        LayoutBlock {
            page,
            kind: kind.into(),
            text: sentences.join(" "),
            bounds: rect,
            sentences: sentences.iter().map(|s| LayoutSentence { text: s.to_string(), rects: vec![rect] }).collect(),
            level: (kind == "heading").then_some(1),
            ..Default::default()
        }
    }
    const LEFT: f32 = 0.08;
    const RIGHT: f32 = 0.52;

    /// A two-column paper over two pages, in the analyser's reading order: running head, title,
    /// left column, a figure between the columns' text, right column, page number; page two
    /// carries on mid-sentence.
    fn two_column() -> Layout {
        let blocks = vec![
            block(0, "header", q(0.08, 0.03, 0.84, 0.02), &["Journal of Examples 12 (2024) 1-20"]),
            block(0, "heading", q(0.08, 0.08, 0.84, 0.04), &["Income and health"]),
            block(0, "heading", q(LEFT, 0.14, 0.4, 0.02), &["1 Introduction"]),
            block(0, "paragraph", q(LEFT, 0.17, 0.4, 0.3), &["Health and income move together.", "This compar- ison is old, and the evi- dence"]),
            block(0, "paragraph", q(LEFT, 0.5, 0.4, 0.06), &["Figure 1. Income by age."]),
            block(0, "paragraph", q(RIGHT, 0.17, 0.4, 0.3), &["is mixed across countries."]),
            block(0, "paragraph", q(RIGHT, 0.5, 0.4, 0.3), &["We study why.", "Short- and long-term effects differ, and"]),
            block(0, "paragraph", q(0.45, 0.95, 0.1, 0.02), &["Journal of Examples"]),
            block(0, "page_number", q(0.48, 0.97, 0.04, 0.02), &["1"]),
            block(1, "paragraph", q(0.08, 0.03, 0.84, 0.02), &["Journal of Examples"]),
            block(1, "paragraph", q(LEFT, 0.1, 0.4, 0.2), &["both matter."]),
            block(1, "table", q(RIGHT, 0.1, 0.4, 0.2), &["Year Income 2020 10"]),
            block(1, "paragraph", q(RIGHT, 0.32, 0.4, 0.03), &["Table 1: Incomes."]),
            block(1, "paragraph", q(0.45, 0.95, 0.1, 0.02), &["Journal of Examples"]),
            block(2, "paragraph", q(0.08, 0.03, 0.84, 0.02), &["Journal of Examples"]),
            block(2, "paragraph", q(LEFT, 0.1, 0.4, 0.2), &["A last page."]),
        ];
        let pages = vec![
            LayoutPage { page: 0, width: 600.0, height: 800.0, images: vec![q(LEFT, 0.38, 0.4, 0.11)] },
            LayoutPage { page: 1, width: 600.0, height: 800.0, images: vec![] },
        ];
        Layout { engine: "layout".into(), page_count: 3, markdown: String::new(), blocks, pages }
    }

    #[test]
    fn reads_two_columns_in_order_and_merges_paragraphs_across_columns_and_pages() {
        let doc = assemble(&two_column());
        let kinds: Vec<&str> = doc.items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, ["heading", "heading", "paragraph", "figure", "paragraph", "table", "paragraph"], "{:#?}", doc.items);
        assert_eq!(doc.items[0].level, Some(1));
        assert_eq!(doc.items[2].text, "Health and income move together. This comparison is old, and the evidence is mixed across countries.");
        assert_eq!(doc.items[2].runs.last().unwrap().page, 0);
        // The figure sits where it floated, with its caption.
        assert_eq!(doc.items[3].caption.as_ref().unwrap().text, "Figure 1. Income by age.");
        assert_eq!(doc.items[3].crop.as_ref().unwrap().page, 0);
        // A paragraph broken by a page (and a table) goes on; the table follows it.
        assert_eq!(doc.items[4].text, "We study why. Short- and long-term effects differ, and both matter.");
        assert_eq!(doc.items[4].runs.iter().map(|r| r.page).collect::<Vec<_>>(), [0, 0, 1]);
        assert_eq!(doc.items[5].caption.as_ref().unwrap().text, "Table 1: Incomes.");
        assert_eq!(doc.outline.iter().map(|o| o.text.as_str()).collect::<Vec<_>>(), ["Income and health", "1 Introduction"]);
        assert_eq!(doc.quality.level, "poor", "three pages with a few lines each");
    }

    #[test]
    fn drops_running_headers_footers_and_page_numbers() {
        let doc = assemble(&two_column());
        let all: String = doc.items.iter().map(|i| format!("{} {}", i.text, i.caption.as_ref().map_or("", |c| c.text.as_str()))).collect();
        assert!(!all.contains("Journal of Examples"), "{all}");
        assert!(!all.contains("1-20"));
        assert!(running_furniture(&[block(0, "paragraph", q(0.5, 0.96, 0.05, 0.02), &["12"])], 1)[0]);
        // A line that repeats in the middle of pages is text, not furniture.
        let middle: Vec<LayoutBlock> = (0..4).map(|p| block(p, "paragraph", q(0.1, 0.5, 0.8, 0.02), &["See above."])).collect();
        assert!(running_furniture(&middle, 4).iter().all(|f| !f));
    }

    #[test]
    fn reads_prose_boxed_as_a_table_once() {
        let prose = "Funding came from the trust. The authors thank the nurses who took part in the study. Data are available on request from the authors. ".repeat(4);
        let inside = q(0.1, 0.1, 0.8, 0.3);
        let blocks = vec![block(0, "table", inside, &[prose.as_str()]), block(0, "paragraph", q(0.1, 0.1, 0.8, 0.29), &[prose.as_str()])];
        let doc = assemble(&Layout { engine: "layout".into(), page_count: 1, markdown: String::new(), blocks, pages: vec![] });
        assert_eq!(doc.items.iter().map(|i| i.kind.as_str()).collect::<Vec<_>>(), ["paragraph"]);
        let alone = vec![block(0, "table", inside, &[prose.as_str()])];
        let doc = assemble(&Layout { engine: "layout".into(), page_count: 1, markdown: String::new(), blocks: alone, pages: vec![] });
        assert!(doc.items[0].kind == "paragraph" && doc.items[0].crop.is_none());
        let cells = vec![block(0, "table", inside, &["Year Income 2020 10 2021 12 2022 14"])];
        assert_eq!(assemble(&Layout { engine: "layout".into(), page_count: 1, markdown: String::new(), blocks: cells, pages: vec![] }).items[0].kind, "table");
    }

    #[test]
    fn keeps_citation_numbers_with_their_sentence() {
        let blocks = vec![
            block(0, "paragraph", q(0.1, 0.1, 0.8, 0.03), &["Prior work established the first result"]),
            block(0, "paragraph", q(0.9, 0.1, 0.02, 0.02), &["1"]),
            block(0, "paragraph", q(0.1, 0.15, 0.8, 0.03), &["Further evidence supports it."]),
        ];
        let doc = assemble(&Layout { engine: "layout".into(), page_count: 1, markdown: String::new(), blocks, pages: vec![] });
        assert_eq!(doc.items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), ["Prior work established the first result 1", "Further evidence supports it."]);
    }

    #[test]
    fn joins_words_broken_at_line_ends() {
        assert_eq!(clean_text("compar- ison of evi-\ndence"), "comparison of evidence");
        assert_eq!(clean_text("short- and long-term"), "short- and long-term");
        assert_eq!(clean_text("Covid- 19 and Anglo- Saxon"), "Covid- 19 and Anglo- Saxon");
        assert_eq!(clean_text("soft\u{AD}ware  is\tfine"), "software is fine");
        // Across two sentences' pieces the run ends move with the hyphen.
        let mut b = Builder::default();
        b.push("the evi-", 0, vec![[0; 4]], "");
        b.push("dence is", 1, vec![[1; 4]], " ");
        assert_eq!(b.text, "the evidence is");
        assert_eq!((b.runs[0].start, b.runs[0].end, b.runs[1].start, b.runs[1].end), (0, 7, 7, 15));
    }

    #[test]
    fn says_when_there_is_nothing_to_read() {
        let empty = Layout { engine: "layout".into(), page_count: 4, markdown: String::new(), blocks: vec![], pages: vec![] };
        assert_eq!(assemble(&empty).quality.level, "empty");
        let maths: Vec<LayoutBlock> = (0..30).map(|i| block(i / 10, "paragraph", q(0.1, 0.1 + (i % 10) as f32 * 0.08, 0.8, 0.05), &["∑ αβ ∫ ∂x/∂y ≤ ∞ ∀ε>0 ∃δ"])).collect();
        let doc = assemble(&Layout { engine: "layout".into(), page_count: 3, markdown: String::new(), blocks: maths, pages: vec![] });
        assert_eq!(doc.quality.level, "poor");
    }

    #[test]
    fn maps_a_selection_to_the_pdf_and_highlights_back_to_the_text() {
        let doc = assemble(&two_column());
        let paragraph = &doc.items[4];
        // "long-term effects differ, and both" crosses the page break.
        let start = paragraph.text.find("long-term").unwrap();
        let end = paragraph.text.find(" matter").unwrap();
        let pieces = pieces(&doc, paragraph.id, false, start, end);
        assert_eq!(pieces.iter().map(|p| (p.page, p.text.as_str())).collect::<Vec<_>>(), [(0, "long-term effects differ, and"), (1, "both")]);
        // The PDF's own text for those pages, as the reader indexes it (one char per entry).
        let chars = |text: &str, y: f32| text.chars().enumerate().map(|(i, c)| (c.to_string(), Some([10.0 + i as f32, y, 11.0 + i as f32, y + 8.0]))).collect::<Vec<_>>();
        let page0 = PageChars { page: 0, width: 600.0, height: 800.0, chars: chars("We study why. Short- and long-term effects differ, and", 420.0) };
        let page1 = PageChars { page: 1, width: 600.0, height: 800.0, chars: chars("both matter.", 90.0) };
        let first = locate(&page0, &pieces[0]).unwrap();
        let last = locate(&page1, &pieces[1]).unwrap();
        assert_eq!(first, (25, 53));
        assert_eq!(span_rects(&page0, first).len(), 1);
        assert_eq!(last, (0, 3));
        // Stored as the reader stores highlights, it shows on the same words.
        let quote = slice16(&paragraph.text, start, end);
        let annotation = serde_json::json!({ "id": "a1", "text": quote, "color": "green", "range": { "start": { "page": 0, "index": first.0 }, "end": { "page": 1, "index": last.1 } } });
        let found = marks(&doc, &[annotation]);
        assert_eq!(found, vec![Mark { annotation_id: "a1".into(), item: paragraph.id, part: None, start, end, color: "green".into(), comment: None }]);
        // Twice on a page and not inside the selection's rectangles: not certain.
        let twice = PageChars { page: 0, width: 600.0, height: 800.0, chars: chars("both both", 700.0) };
        assert_eq!(locate(&twice, &Piece { page: 0, text: "both".into(), rects: vec![q(0.1, 0.1, 0.1, 0.05)] }), None);
        assert_eq!(locate(&twice, &Piece { page: 0, text: "both".into(), rects: vec![[0, (700.0 / 800.0 * FULL) as u16, 1000, 1500]] }), Some((0, 3)));
        // A place in the page view finds its item, and an item gives its place.
        assert_eq!(item_at(&doc, 1, 0.0), Some(paragraph.id));
        assert_eq!(item_at(&doc, 0, 0.16), Some(2));
    }
}
