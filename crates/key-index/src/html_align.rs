// A publisher's HTML page folded into a PDF's layout: when Find PDF landed on the article's web
// page and the person then got the PDF from it, the page's structure (its headings and their
// levels, figure and table captions, reference list, footnotes, the order of its paragraphs, and
// metadata such as the abstract) is aligned to the blocks layout analysis found in the PDF, by
// text similarity, and used to label them. The PDF's text is never replaced: only a block's kind,
// heading level, caption role, reference entry starts and order on its page change, each marked
// as coming from the HTML. An alignment that does not hold (another article, too few matches) is
// discarded and the layout stays as it was.
use crate::landing::{collapse, elements, metas, strip_numbering};
use crate::reflow::clean_text;
use crate::{Layout, LayoutBlock, web_reflow};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// What the page says about the article itself.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(rename = "abstract", skip_serializing_if = "Option::is_none")]
    pub abstract_text: Option<String>,
}

/// The parts of the page that can label the PDF, each with its place in the page's order.
#[derive(Clone, Debug, Default)]
pub struct HtmlOutline {
    pub title: Option<String>,
    pub headings: Vec<(usize, u8, String)>,
    pub paragraphs: Vec<(usize, String)>,
    pub captions: Vec<(usize, &'static str, String)>,
    pub references: Vec<(usize, String)>,
    pub footnotes: Vec<(usize, String)>,
    pub meta: HtmlMeta,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Count {
    pub html: usize,
    pub matched: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub block: usize,
    pub page: i64,
    /// heading | demoted | caption | references | footnote | title
    pub what: &'static str,
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
    pub score: f32,
}

/// What the alignment found and whether it was used.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alignment {
    pub accepted: bool,
    pub confidence: f32,
    pub reason: String,
    /// The page's title or abstract is the PDF's.
    pub same_article: bool,
    pub headings: Count,
    pub captions: Count,
    pub references: Count,
    pub footnotes: Count,
    pub paragraphs: Count,
    pub labels: Vec<Label>,
    pub reordered_pages: Vec<i64>,
    pub meta: HtmlMeta,
}

const ORIGIN: &str = "html";
const HEADING_MATCH: f32 = 0.8;
const TITLE_MATCH: f32 = 0.75;
const CONTAINED: f32 = 0.7;
const ACCEPT: f32 = 0.45;

fn norm(text: &str) -> String {
    let text = clean_text(text).replace(['\u{fb01}'], "fi").replace(['\u{fb02}'], "fl").to_lowercase();
    text.chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn trigrams(text: &str) -> HashSet<[char; 3]> {
    let chars: Vec<char> = format!(" {text} ").chars().collect();
    chars.windows(3).map(|w| [w[0], w[1], w[2]]).collect()
}

/// Dice similarity of two short texts by their character trigrams.
fn dice(a: &str, b: &str) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let (x, y) = (trigrams(a), trigrams(b));
    2.0 * x.intersection(&y).count() as f32 / (x.len() + y.len()).max(1) as f32
}

fn word_set(text: &str) -> HashSet<String> {
    norm(text).split(' ').filter(|w| w.chars().count() >= 3).map(String::from).collect()
}

/// How much of `part`'s words are in `whole`'s.
fn contained(part: &HashSet<String>, whole: &HashSet<String>) -> f32 {
    if part.is_empty() {
        return 0.0;
    }
    part.iter().filter(|w| whole.contains(*w)).count() as f32 / part.len() as f32
}

fn first_words(text: &str, n: usize) -> String {
    text.split_whitespace().take(n).collect::<Vec<_>>().join(" ")
}

/// The page read for alignment (web_reflow.rs finds the article in it).
pub fn read_html(html: &str) -> HtmlOutline {
    let document = web_reflow::assemble(html).document;
    let elements = elements(html);
    let metas = metas(&elements);
    let meta = |names: &[&str]| names.iter().find_map(|n| metas.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone()));
    let title = meta(&["citation_title", "dc.title", "og:title"]).or_else(|| document.meta.as_ref().and_then(|m| m.title.clone()));
    let mut out = HtmlOutline { title: title.clone(), ..Default::default() };
    let mut abstract_parts: Vec<String> = Vec::new();
    let mut in_abstract = false;
    for item in &document.items {
        let text = collapse(&item.text);
        match item.kind.as_str() {
            "heading" => {
                in_abstract = matches!(strip_numbering(&text).to_lowercase().as_str(), "abstract" | "summary");
                if title.as_deref().is_some_and(|t| dice(&norm(t), &norm(&text)) >= 0.9) {
                    continue;
                }
                if !text.is_empty() {
                    out.headings.push((item.id, item.level.unwrap_or(2), text));
                }
            }
            "paragraph" | "list" => {
                if in_abstract {
                    abstract_parts.push(text.clone());
                }
                if text.split_whitespace().count() >= 8 {
                    out.paragraphs.push((item.id, text));
                }
            }
            "figure" | "table" => {
                // A figure's caption is its text; a table's is its caption.
                let caption = item.caption.as_ref().map(|c| collapse(&c.text)).or_else(|| (item.kind == "figure").then(|| text.clone()));
                if let Some(caption) = caption.filter(|c| c.split_whitespace().count() >= 3) {
                    out.captions.push((item.id, if item.kind == "table" { "table" } else { "figure" }, caption));
                }
            }
            "references" if !text.is_empty() => out.references.push((item.id, text)),
            "footnote" if !text.is_empty() => out.footnotes.push((item.id, text)),
            _ => {}
        }
    }
    let authors: Vec<String> = metas.iter().filter(|(k, _)| k == "citation_author" || k == "dc.creator").map(|(_, v)| v.clone()).collect();
    out.meta = HtmlMeta {
        title,
        doi: meta(&["citation_doi", "dc.identifier", "prism.doi"]).and_then(|d| d.find("10.").map(|i| d[i..].trim().to_string())),
        authors: authors.into_iter().fold(Vec::new(), |mut all, a| {
            if !all.contains(&a) {
                all.push(a);
            }
            all
        }),
        abstract_text: meta(&["citation_abstract", "dc.description"]).or_else(|| (!abstract_parts.is_empty()).then(|| abstract_parts.join("\n\n"))).or_else(|| meta(&["description", "og:description"])),
    };
    out
}

fn furniture(block: &LayoutBlock) -> bool {
    matches!(block.kind.as_str(), "header" | "footer" | "page_number")
}

/// The heaviest chain of (html, block, score) pairs increasing in both: headings keep their order.
fn ordered_chain(mut pairs: Vec<(usize, usize, f32)>) -> Vec<(usize, usize, f32)> {
    pairs.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let n = pairs.len();
    let mut best = vec![0f32; n];
    let mut prev = vec![usize::MAX; n];
    for i in 0..n {
        best[i] = pairs[i].2;
        for j in 0..i {
            if pairs[j].0 < pairs[i].0 && pairs[j].1 < pairs[i].1 && best[j] + pairs[i].2 > best[i] {
                best[i] = best[j] + pairs[i].2;
                prev[i] = j;
            }
        }
    }
    let Some(mut at) = (0..n).max_by(|a, b| best[*a].total_cmp(&best[*b])) else { return Vec::new() };
    let mut chain = Vec::new();
    loop {
        chain.push(pairs[at]);
        if prev[at] == usize::MAX {
            break;
        }
        at = prev[at];
    }
    chain.reverse();
    chain
}

/// Aligns the page to the layout: the labelled layout when the alignment holds (the layout as it
/// was otherwise), and what was found.
pub fn align(layout: &Layout, html: &str) -> (Layout, Alignment) {
    align_outline(layout, &read_html(html))
}

pub fn align_outline(layout: &Layout, outline: &HtmlOutline) -> (Layout, Alignment) {
    let blocks = &layout.blocks;
    let texts: Vec<String> = blocks.iter().map(|b| norm(&b.text)).collect();
    let words: Vec<HashSet<String>> = blocks.iter().map(|b| word_set(&b.text)).collect();
    let mut report = Alignment { meta: outline.meta.clone(), ..Default::default() };
    let mut out = layout.clone();
    let mut used: HashSet<usize> = HashSet::new();
    let mut labels: Vec<Label> = Vec::new();
    // Where each block is in the page's order (for reading order).
    let mut position: HashMap<usize, usize> = HashMap::new();

    // The article itself: its title near the top of the first page, or its abstract there.
    let mut title_block = None;
    if let Some(title) = outline.title.as_deref().map(norm).filter(|t| !t.is_empty()) {
        title_block = blocks
            .iter()
            .enumerate()
            .filter(|(i, b)| b.page <= 1 && !furniture(b) && texts[*i].len() <= title.len() * 2 + 40)
            .take(40)
            .map(|(i, _)| (i, dice(&title, &texts[i])))
            .filter(|(_, s)| *s >= TITLE_MATCH)
            .max_by(|a, b| a.1.total_cmp(&b.1));
    }
    let abstract_match = outline.meta.abstract_text.as_deref().map(word_set).is_some_and(|abstract_words| {
        abstract_words.len() >= 12 && blocks.iter().enumerate().filter(|(i, b)| b.page <= 1 && words[*i].len() >= 12).any(|(i, _)| contained(&words[i], &abstract_words) >= 0.8)
    });
    report.same_article = title_block.is_some() || abstract_match;
    if let Some((i, score)) = title_block {
        used.insert(i);
        if out.blocks[i].kind != "heading" || out.blocks[i].level != Some(1) {
            labels.push(Label { block: i, page: blocks[i].page, what: "title", from: blocks[i].kind.clone(), to: "heading".into(), level: Some(1), score });
            out.blocks[i].kind = "heading".into();
            out.blocks[i].level = Some(1);
            out.blocks[i].origin = Some(ORIGIN.into());
        }
    }

    // Headings, in order.
    report.headings.html = outline.headings.len();
    let mut pairs = Vec::new();
    for (h, (_, _, heading)) in outline.headings.iter().enumerate() {
        let wanted = norm(&strip_numbering(heading));
        if wanted.is_empty() {
            continue;
        }
        for (i, block) in blocks.iter().enumerate() {
            if furniture(block) || used.contains(&i) || texts[i].len() > (wanted.len() * 2 + 30).min(260) {
                continue;
            }
            let score = dice(&wanted, &norm(&strip_numbering(&block.text)));
            if score >= HEADING_MATCH {
                pairs.push((h, i, score));
            }
        }
    }
    let chain = ordered_chain(pairs);
    let section_levels: Vec<u8> = chain.iter().map(|(h, _, _)| outline.headings[*h].1).collect();
    let top = section_levels.iter().copied().min().unwrap_or(2);
    let first_level = if title_block.is_some() { 2 } else { 1 };
    let mut heading_blocks = HashSet::new();
    for (h, i, score) in &chain {
        let (item, level, _) = outline.headings[*h];
        let level = (level.saturating_sub(top) + first_level).min(4);
        used.insert(*i);
        heading_blocks.insert(*i);
        position.insert(*i, item);
        let block = &mut out.blocks[*i];
        if block.kind != "heading" || block.level != Some(level) {
            labels.push(Label { block: *i, page: block.page, what: "heading", from: block.kind.clone(), to: "heading".into(), level: Some(level), score: *score });
            block.kind = "heading".into();
            block.level = Some(level);
            block.origin = Some(ORIGIN.into());
        }
    }
    report.headings.matched = chain.len();

    // Paragraphs: which of the page's paragraphs each PDF paragraph is part of.
    let html_paragraphs: Vec<(usize, HashSet<String>)> = outline.paragraphs.iter().map(|(item, text)| (*item, word_set(text))).collect();
    let mut by_word: HashMap<&str, Vec<usize>> = HashMap::new();
    for (p, (_, set)) in html_paragraphs.iter().enumerate() {
        for word in set {
            by_word.entry(word.as_str()).or_default().push(p);
        }
    }
    let mut body_blocks = 0;
    for (i, block) in blocks.iter().enumerate() {
        if block.kind != "paragraph" || words[i].len() < 8 || used.contains(&i) {
            continue;
        }
        body_blocks += 1;
        let mut votes: HashMap<usize, usize> = HashMap::new();
        for word in &words[i] {
            for p in by_word.get(word.as_str()).into_iter().flatten() {
                *votes.entry(*p).or_default() += 1;
            }
        }
        let best = votes.into_iter().max_by_key(|(p, n)| (*n, usize::MAX - p)).map(|(p, _)| p);
        if let Some(p) = best.filter(|p| contained(&words[i], &html_paragraphs[*p].1) >= 0.6) {
            position.insert(i, html_paragraphs[p].0);
            report.paragraphs.matched += 1;
        }
    }
    report.paragraphs.html = if html_paragraphs.len() >= 5 { body_blocks } else { 0 };
    let full_text = html_paragraphs.len() >= 8;

    // Headings the analyser saw that the page shows as running text: a bold first line.
    if full_text {
        for (i, block) in blocks.iter().enumerate() {
            if block.kind != "heading" || used.contains(&i) || words[i].len() < 3 {
                continue;
            }
            if outline.title.as_deref().is_some_and(|t| dice(&norm(t), &texts[i]) >= 0.6) {
                continue;
            }
            let inside = html_paragraphs.iter().any(|(_, set)| contained(&words[i], set) >= 0.95);
            let a_heading = outline.headings.iter().any(|(_, _, h)| dice(&norm(&strip_numbering(h)), &norm(&strip_numbering(&block.text))) >= 0.6);
            if inside && !a_heading {
                labels.push(Label { block: i, page: block.page, what: "demoted", from: "heading".into(), to: "paragraph".into(), level: None, score: 1.0 });
                out.blocks[i].kind = "paragraph".into();
                out.blocks[i].level = None;
                out.blocks[i].origin = Some(ORIGIN.into());
            }
        }
    }

    // Captions: the block that starts like the page's caption.
    report.captions.html = outline.captions.len();
    for (item, kind, caption) in &outline.captions {
        let wanted = word_set(&first_words(caption, 40));
        if wanted.len() < 3 {
            continue;
        }
        let best = blocks
            .iter()
            .enumerate()
            .filter(|(i, b)| !furniture(b) && !used.contains(i) && matches!(b.kind.as_str(), "paragraph" | "heading" | "list" | "footnote"))
            .map(|(i, b)| (i, contained(&word_set(&first_words(&b.text, 40)), &wanted)))
            .filter(|(i, s)| *s >= CONTAINED && words[*i].len() >= 3)
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((i, score)) = best {
            used.insert(i);
            position.insert(i, *item);
            report.captions.matched += 1;
            let block = &mut out.blocks[i];
            labels.push(Label { block: i, page: block.page, what: "caption", from: block.kind.clone(), to: format!("{kind} caption"), level: None, score });
            block.kind = "paragraph".into();
            block.level = None;
            block.caption = Some((*kind).to_string());
            block.origin = Some(ORIGIN.into());
        }
    }

    // The reference list: where each of the page's entries starts among the PDF's lines.
    report.references.html = outline.references.len();
    if outline.references.len() >= 3 {
        let lines: Vec<(usize, usize, HashSet<String>)> = blocks
            .iter()
            .enumerate()
            .filter(|(i, b)| !furniture(b) && !heading_blocks.contains(i) && b.caption.is_none() && out.blocks[*i].caption.is_none())
            .flat_map(|(i, b)| b.text.lines().enumerate().map(move |(l, line)| (i, l, word_set(line))).collect::<Vec<_>>())
            .collect();
        let mut at = 0;
        let mut starts: HashMap<usize, Vec<u32>> = HashMap::new();
        let mut matched = 0;
        for (_, entry) in &outline.references {
            let head = word_set(&first_words(entry, 10));
            let whole = word_set(entry);
            if head.len() < 3 {
                continue;
            }
            // The next line, in order, that starts this entry (looking a little ahead).
            let found = lines[at..].iter().enumerate().take(400).find(|(_, (_, _, line))| line.len() >= 2 && contained(line, &whole) >= 0.8 && contained(&head, line) >= 0.5);
            if let Some((offset, (i, l, _))) = found {
                starts.entry(*i).or_default().push(*l as u32);
                at += offset + 1;
                matched += 1;
            }
        }
        report.references.matched = matched;
        if matched >= 3 && matched * 2 >= outline.references.len() {
            for (i, entries) in starts {
                let block = &mut out.blocks[i];
                let lines = block.text.lines().count();
                // A block of references: most of its lines belong to entries the page lists.
                if lines > entries.len() * 4 {
                    continue;
                }
                labels.push(Label { block: i, page: block.page, what: "references", from: block.kind.clone(), to: "reference_list".into(), level: None, score: entries.len() as f32 });
                block.kind = "reference_list".into();
                block.entries = entries;
                block.origin = Some(ORIGIN.into());
                used.insert(i);
            }
        }
    }

    // Footnotes.
    report.footnotes.html = outline.footnotes.len();
    for (_, note) in &outline.footnotes {
        let wanted = word_set(note);
        if wanted.len() < 4 {
            continue;
        }
        let best = blocks
            .iter()
            .enumerate()
            .filter(|(i, b)| !used.contains(i) && b.kind == "paragraph" && words[*i].len() >= 4)
            .map(|(i, _)| (i, contained(&words[i], &wanted)))
            .filter(|(_, s)| *s >= 0.85)
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((i, score)) = best {
            used.insert(i);
            report.footnotes.matched += 1;
            position.remove(&i);
            let block = &mut out.blocks[i];
            labels.push(Label { block: i, page: block.page, what: "footnote", from: block.kind.clone(), to: "footnote".into(), level: None, score });
            block.kind = "footnote".into();
            block.origin = Some(ORIGIN.into());
        }
    }

    // How much of it holds.
    let rate = |c: Count| (c.html >= 2).then(|| c.matched as f32 / c.html as f32);
    let parts = [(rate(report.paragraphs), 0.4), (rate(report.headings), 0.3), (rate(report.captions), 0.15), (rate(report.references), 0.15)];
    let (sum, weight) = parts.iter().filter_map(|(r, w)| r.map(|r| (r.min(1.0) * w, *w))).fold((0.0, 0.0), |(s, t), (a, b)| (s + a, t + b));
    // A page with nothing to align but the article's title and abstract still says which
    // article it is: its metadata (and the title) hold when it is this one.
    let mut confidence = if weight > 0.0 { sum / weight } else if report.same_article { 0.5 } else { 0.0 };
    if !report.same_article {
        confidence *= 0.5;
    }
    report.confidence = (confidence * 100.0).round() / 100.0;
    let anchors = report.headings.matched + report.captions.matched + report.references.matched + report.footnotes.matched;
    report.accepted = report.confidence >= ACCEPT && (report.same_article || anchors >= 5) && (!labels.is_empty() || report.paragraphs.matched > 0);
    if !report.accepted {
        report.reason = if !report.same_article && anchors < 5 { "The page does not seem to be this PDF’s article".into() } else { "Too little of the page matched the PDF".into() };
        report.labels.clear();
        return (layout.clone(), report);
    }

    // Reading order on each page, where the page's order clearly differs (two columns read
    // across): the positioned body blocks take their slots in the page's order.
    if report.paragraphs.html > 0 && report.paragraphs.matched * 2 >= report.paragraphs.html {
        let pages: Vec<i64> = {
            let mut p: Vec<i64> = out.blocks.iter().map(|b| b.page).collect();
            p.dedup();
            p
        };
        for page in pages {
            let slots: Vec<usize> = (0..out.blocks.len())
                .filter(|i| out.blocks[*i].page == page && matches!(out.blocks[*i].kind.as_str(), "paragraph" | "heading" | "list") && out.blocks[*i].caption.is_none() && position.contains_key(i))
                .collect();
            if slots.len() < 3 {
                continue;
            }
            let order: Vec<usize> = slots.iter().map(|i| position[i]).collect();
            if order.windows(2).all(|w| w[0] <= w[1]) {
                continue;
            }
            let mut sorted = slots.clone();
            sorted.sort_by_key(|i| (position[i], *i));
            let moved: Vec<LayoutBlock> = sorted.iter().map(|i| out.blocks[*i].clone()).collect();
            for (slot, mut block) in slots.iter().zip(moved) {
                block.origin = Some(ORIGIN.into());
                out.blocks[*slot] = block;
            }
            report.reordered_pages.push(page);
        }
    }
    report.labels = labels;
    report.reason = "Aligned".into();
    (out, report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LayoutSentence;

    const FULL: f32 = 65535.0;
    fn block(page: i64, kind: &str, x: f32, y: f32, w: f32, h: f32, text: &str) -> LayoutBlock {
        LayoutBlock {
            page,
            kind: kind.into(),
            text: text.into(),
            bounds: [(x * FULL) as u16, (y * FULL) as u16, (w * FULL) as u16, (h * FULL) as u16],
            sentences: text.split(". ").map(|s| LayoutSentence { text: s.into(), rects: Vec::new() }).collect(),
            level: (kind == "heading").then_some(1),
            ..Default::default()
        }
    }

    const P1: &str = "Towns along rivers grew with the trade that boats carried between their markets over many centuries of exchange";
    const P2: &str = "We collected records of market sizes from archives in twelve river valleys and compared them with distance to water";
    const P3: &str = "Larger markets sat closer to navigable water and the effect remained after accounting for soil quality and climate";
    const P4: &str = "These results suggest that river transport shaped where towns prospered and how their trade networks developed";
    const P5: &str = "Future work could follow the same towns through the arrival of railways that changed the value of river access";
    const P6: &str = "Records were digitised by hand and checked twice against the original ledgers held in regional archives";
    const P7: &str = "Distances were measured along the shortest path to a navigable stretch of river using historical maps";
    const P8: &str = "Market size was taken as the number of licensed stalls recorded for each town in the decade studied";

    fn html() -> String {
        format!(
            r#"<!doctype html><html><head><title>Rivers and markets</title>
            <meta name="citation_title" content="Rivers and the growth of market towns">
            <meta name="citation_doi" content="10.5555/rivers.2024">
            <meta name="citation_author" content="Ada Example"><meta name="citation_author" content="Ben Sample">
            </head><body><article>
            <h1>Rivers and the growth of market towns</h1>
            <section><h2>Abstract</h2><p>We ask whether river access explains the size of historical market towns, using archival records from twelve valleys.</p></section>
            <h2>1. Introduction</h2><p>{P1}.</p>
            <h2>2. Data and methods</h2><p>{P2}.</p>
            <h3>2.1 Archival sources</h3><p>{P6}.</p><p>{P7}.</p><p>{P8}.</p>
            <figure><img src="data:image/png;base64,AAAA" alt="map"><figcaption>Figure 1. Market towns and navigable rivers in the twelve valleys studied.</figcaption></figure>
            <h2>3. Results</h2><p>{P3}.</p>
            <table><caption>Table 1. Market size by distance to the nearest navigable river.</caption><tr><td>0-5 km</td><td>42</td></tr></table>
            <h2>4. Discussion</h2><p>{P4}.</p><p>{P5}.</p>
            <section class="references"><h2>References</h2><ol>
              <li>Abbott, C. (1990). Boats and barter in early river trade. Journal of Old Markets 12, 1-20.</li>
              <li>Bell, D., &amp; Cole, E. (2001). Water, soil and the size of towns. Rural History Review 4, 33-51.</li>
              <li>Dunn, F. (2015). Railways and the decline of river ports. Transport Past 9, 100-118.</li>
              <li>Evans, G. (2019). Mapping navigable rivers from historical charts. Cartography Quarterly 30, 5-22.</li>
            </ol></section>
            </article></body></html>"#
        )
    }

    /// The same article as a two-column PDF's layout, with the analyser's usual slips: a section
    /// heading read as a paragraph, a caption read as a heading, a right-column paragraph read
    /// before the left column's last one, and the reference list as plain paragraphs.
    fn layout() -> Layout {
        let (l, r) = (0.08, 0.52);
        let blocks = vec![
            block(0, "header", 0.08, 0.02, 0.84, 0.02, "Journal of Example Studies 12 (2024)"),
            block(0, "paragraph", 0.08, 0.08, 0.84, 0.05, "Rivers and the growth of market towns"),
            block(0, "paragraph", 0.08, 0.15, 0.84, 0.06, "We ask whether river access explains the size of historical market towns, using archival records from twelve valleys."),
            block(0, "heading", l, 0.25, 0.4, 0.02, "1 Introduction"),
            block(0, "paragraph", l, 0.28, 0.4, 0.15, &format!("{P1}.")),
            block(0, "paragraph", l, 0.45, 0.4, 0.02, "2 Data and methods"),
            block(0, "paragraph", r, 0.25, 0.4, 0.15, &format!("{P6}.")),
            block(0, "paragraph", l, 0.48, 0.4, 0.15, &format!("{P2}.")),
            block(0, "heading", l, 0.65, 0.4, 0.02, "2.1 Archival sources"),
            block(0, "paragraph", r, 0.42, 0.4, 0.12, &format!("{P7}.")),
            block(0, "paragraph", r, 0.56, 0.4, 0.12, &format!("{P8}.")),
            block(0, "page_number", 0.48, 0.96, 0.04, 0.02, "1"),
            block(1, "heading", l, 0.40, 0.4, 0.03, "Figure 1. Market towns and navigable rivers in the twelve valleys studied."),
            block(1, "heading", l, 0.45, 0.4, 0.02, "3 Results"),
            block(1, "paragraph", l, 0.48, 0.4, 0.15, &format!("{P3}.")),
            block(1, "paragraph", r, 0.08, 0.4, 0.03, "Table 1. Market size by distance to the nearest navigable river."),
            block(1, "table", r, 0.12, 0.4, 0.1, "0-5 km 42"),
            block(1, "heading", r, 0.25, 0.4, 0.02, "4 Discussion"),
            block(1, "paragraph", r, 0.28, 0.4, 0.12, &format!("{P4}.")),
            block(1, "paragraph", r, 0.42, 0.4, 0.12, &format!("{P5}.")),
            block(1, "heading", r, 0.56, 0.4, 0.02, "References"),
            block(
                1,
                "paragraph",
                r,
                0.6,
                0.4,
                0.3,
                "Abbott, C. (1990). Boats and barter in early river\ntrade. Journal of Old Markets 12, 1-20.\nBell, D., & Cole, E. (2001). Water, soil and the size\nof towns. Rural History Review 4, 33-51.\nDunn, F. (2015). Railways and the decline of river\nports. Transport Past 9, 100-118.\nEvans, G. (2019). Mapping navigable rivers from\nhistorical charts. Cartography Quarterly 30, 5-22.",
            ),
        ];
        Layout { engine: "layout".into(), page_count: 2, markdown: String::new(), blocks, pages: Vec::new() }
    }

    fn texts(layout: &Layout) -> Vec<String> {
        let mut t: Vec<String> = layout.blocks.iter().map(|b| b.text.clone()).collect();
        t.sort();
        t
    }

    #[test]
    fn labels_headings_captions_and_references_from_the_page() {
        let before = layout();
        let (after, report) = align(&before, &html());
        assert!(report.accepted, "{report:#?}");
        assert!(report.same_article);
        assert!(report.confidence >= 0.6, "{}", report.confidence);
        // Never a word of the PDF's text changed: the same blocks, only labelled (and reordered).
        assert_eq!(texts(&before), texts(&after));
        let find = |text: &str| after.blocks.iter().find(|b| b.text.starts_with(text)).unwrap();
        // Title and headings with the page's levels.
        assert_eq!((find("Rivers and the growth").kind.as_str(), find("Rivers and the growth").level), ("heading", Some(1)));
        let headings: Vec<(&str, Option<u8>)> = after.blocks.iter().filter(|b| b.kind == "heading").map(|b| (b.text.as_str(), b.level)).collect();
        assert_eq!(
            headings,
            [
                ("Rivers and the growth of market towns", Some(1)),
                ("1 Introduction", Some(2)),
                ("2 Data and methods", Some(2)),
                ("2.1 Archival sources", Some(3)),
                ("3 Results", Some(2)),
                ("4 Discussion", Some(2)),
                ("References", Some(2)),
            ],
            "{:#?}",
            report.labels
        );
        assert_eq!(find("2 Data and methods").origin.as_deref(), Some("html"));
        // Captions: precision — only the two caption blocks, each with its kind.
        let captions: Vec<(&str, &str)> = after.blocks.iter().filter_map(|b| b.caption.as_deref().map(|c| (c, &b.text[..8]))).collect();
        assert_eq!(captions, [("figure", "Figure 1"), ("table", "Table 1.")]);
        assert_eq!(find("Figure 1.").kind, "paragraph");
        // The reference list, one entry per reference.
        let refs = find("Abbott");
        assert_eq!((refs.kind.as_str(), refs.entries.clone()), ("reference_list", vec![0, 2, 4, 6]));
        assert_eq!(report.references, Count { html: 4, matched: 4 });
        // Page 1's right column was read before the left's last paragraph: the page's order now.
        assert_eq!(report.reordered_pages, [0]);
        let order: Vec<&str> = after.blocks.iter().filter(|b| b.page == 0 && b.kind == "paragraph").map(|b| &b.text[..12]).collect();
        assert_eq!(order[1..], [&P1[..12], &P2[..12], &P6[..12], &P7[..12], &P8[..12]]);
        // Metadata the page gives.
        assert_eq!(report.meta.doi.as_deref(), Some("10.5555/rivers.2024"));
        assert_eq!(report.meta.authors, ["Ada Example", "Ben Sample"]);
        assert!(report.meta.abstract_text.as_deref().unwrap().starts_with("We ask whether"));
        // Reading mode follows the new labels: contents and a reference entry per line group.
        let document = crate::reflow::assemble(&after);
        let outline: Vec<&str> = document.outline.iter().map(|o| o.text.as_str()).collect();
        assert!(outline.contains(&"2 Data and methods") && !outline.iter().any(|o| o.starts_with("Figure")), "{outline:?}");
        let references = document.items.iter().find(|i| i.kind == "references").unwrap();
        assert_eq!(references.text.lines().count(), 4, "{}", references.text);
    }

    #[test]
    fn discards_a_page_of_another_article() {
        let other = r#"<html><head><meta name="citation_title" content="Glaciers and alpine farming"></head><body><article>
            <h1>Glaciers and alpine farming</h1><h2>Introduction</h2><p>Glaciers shape the valleys where alpine farmers keep their herds through the summer months each year.</p>
            <h2>Methods</h2><p>We surveyed farms above two thousand metres and recorded their distance from the ice margin in each valley.</p>
            <h2>Results</h2><p>Farms near the ice had shorter seasons but richer pasture than the farms lower down the valleys we visited.</p>
            <figure><figcaption>Figure 1. Farms and glaciers in the surveyed valleys.</figcaption></figure>
            <ol class="references"><li>Alp, H. (2000). Ice and grass. Mountain Studies 1, 1-9.</li><li>Berg, I. (2010). Herds. Alpine Review 2, 3-8.</li><li>Col, J. (2012). Summer pasture. Farming Past 3, 4-7.</li></ol>
            </article></body></html>"#;
        let before = layout();
        let (after, report) = align(&before, other);
        assert!(!report.accepted, "{report:#?}");
        assert!(!report.same_article);
        assert!(report.labels.is_empty());
        assert_eq!(serde_json::to_string(&after).unwrap(), serde_json::to_string(&before).unwrap());
    }

    #[test]
    fn an_abstract_page_gives_the_title_and_metadata_only() {
        let page = r#"<html><head><meta name="citation_title" content="Rivers and the growth of market towns">
            <meta name="citation_abstract" content="We ask whether river access explains the size of historical market towns, using archival records from twelve valleys.">
            </head><body><h1>Rivers and the growth of market towns</h1><h2>Abstract</h2><p>We ask whether river access explains the size of historical market towns, using archival records from twelve valleys.</p>
            <p>Access through your institution to read the full article.</p></body></html>"#;
        let before = layout();
        let (after, report) = align(&before, page);
        assert!(report.accepted && report.same_article, "{report:#?}");
        assert_eq!(texts(&before), texts(&after));
        assert_eq!(after.blocks[1].kind, "heading");
        assert_eq!(report.labels.iter().map(|l| l.what).collect::<Vec<_>>(), ["title"]);
        assert!(report.meta.abstract_text.is_some());
        // No paragraphs to order by: the layout's order stays.
        assert!(report.reordered_pages.is_empty());
    }
}
