// Identifying a PDF added to the library. The indexer gathers the evidence (the document's
// metadata, the text of its first pages and its last) and asks `document_doi` for the DOI
// the document carries: one in a dedicated metadata field, else one printed on the first
// page or in a "cite as" box at the end, else an arXiv watermark; DOIs in reference lists
// do not count. Without a DOI, `title_candidates` gives the titles it can be looked up by,
// and the OpenAlex worker accepts a search result only through `accept_title`. What was
// found is kept per source (`Identification`, in `meta`), so each file is identified once.
use crate::{Result, Source, Store, e, graph::name_key, links, now_ms};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// arXiv's DataCite DOIs: 10.48550/arxiv.<id>.
pub const ARXIV_DOI: &str = "10.48550/arxiv.";

// ── DOIs in text ─────────────────────────────────────────────

/// A DOI found in text: canonical (lowercase, no resolver prefix or trailing punctuation),
/// with readings it may also be (a line break read the other way, text glued to its end).
#[derive(Clone, Debug, PartialEq)]
pub struct DoiHit {
    pub doi: String,
    pub alternates: Vec<String>,
    /// Introduced as a DOI ("doi:", "DOI", "doi.org/").
    pub labelled: bool,
    /// Character offset in the prepared text.
    pub at: usize,
}

/// Undoes what PDF text extraction does to identifiers: unicode dashes and slashes, soft
/// hyphens and zero-width marks, odd spaces, escaped slashes, Springer's hidden glyph run.
fn prepare(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.replace("\r\n", "\n").chars() {
        match c {
            '\u{00AD}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}' => {}
            '\u{2010}'..='\u{2015}' | '\u{2212}' | '\u{FE63}' | '\u{FF0D}' => out.push('-'),
            '\u{FF0F}' | '\u{2215}' | '\u{2044}' => out.push('/'),
            '\u{00A0}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\t' => out.push(' '),
            '\r' => out.push('\n'),
            c => out.push(c),
        }
    }
    out.replace("(0123456789().,-volV)", "").replace("%2F", "/").replace("%2f", "/")
}

/// Characters a DOI suffix is read through. `<`, `>`, `;` and `:` stay: SICI DOIs use them.
fn suffix_char(c: char) -> bool {
    !c.is_whitespace() && !matches!(c, '"' | '\'' | '«' | '»' | '{' | '}' | '|' | '\\' | '^' | '`' | '\u{2018}' | '\u{2019}' | '\u{201C}' | '\u{201D}')
}

/// Drops sentence punctuation and closing brackets that do not belong to the DOI.
fn trim_suffix(suffix: &str) -> &str {
    let mut s = suffix;
    loop {
        let count = |c: char| s.chars().filter(|x| *x == c).count();
        let Some(last) = s.chars().last() else { return s };
        let drop = match last {
            '.' | ',' | ';' | ':' | '!' | '?' => true,
            ')' => count('(') < count(')'),
            ']' => count('[') < count(']'),
            '>' => count('<') < count('>'),
            _ => false,
        };
        if !drop {
            return s;
        }
        s = &s[..s.len() - last.len_utf8()];
    }
}

/// Whether the text after a line break goes on with a DOI that ended in `last`.
fn continues(last: char, token: &str) -> bool {
    let Some(first) = token.chars().next() else { return false };
    if !first.is_alphanumeric() {
        return false;
    }
    match last {
        '.' => first.is_ascii_digit() || token.contains(['.', '/']),
        '-' | '/' | '_' => token.chars().any(|c| c.is_ascii_digit()) || !token.chars().any(char::is_uppercase),
        _ => false,
    }
}

/// From `index` (just after the DOI so far): the start of the next line when only one line
/// break (and spaces) lies between.
fn next_line(chars: &[char], index: usize) -> Option<usize> {
    let mut j = index;
    let mut breaks = 0;
    while j < chars.len() && chars[j].is_whitespace() {
        breaks += usize::from(chars[j] == '\n');
        j += 1;
    }
    (breaks == 1 && j < chars.len()).then_some(j)
}

fn read_doi(chars: &[char], start: usize) -> Option<(DoiHit, usize)> {
    let len = chars.len();
    let mut j = start + 3;
    let digits = j;
    while j < len && chars[j].is_ascii_digit() {
        j += 1;
    }
    if !(4..=9).contains(&(j - digits)) {
        return None;
    }
    // Registrant subdivisions (10.1000.10/…).
    while j + 1 < len && chars[j] == '.' && chars[j + 1].is_ascii_digit() {
        j += 1;
        while j < len && chars[j].is_ascii_digit() {
            j += 1;
        }
    }
    let prefix: String = chars[start..j].iter().collect();
    while j < len && chars[j] == ' ' && j - prefix.len() - start < 2 {
        j += 1;
    }
    if chars.get(j) != Some(&'/') {
        return None;
    }
    j += 1;
    // Extraction often breaks the line, or puts a space, right after the slash.
    let after_slash = j;
    while j < len && chars[j].is_whitespace() && j - after_slash < 3 {
        j += 1;
    }
    let mut suffix = String::new();
    let mut alternates = Vec::new();
    let mut joins = 0;
    loop {
        while j < len && suffix_char(chars[j]) {
            suffix.push(chars[j]);
            j += 1;
        }
        let Some(last) = suffix.chars().last() else { break };
        if joins < 2 && matches!(last, '.' | '-' | '/' | '_') {
            if let Some(next) = next_line(chars, j) {
                let token: String = chars[next..].iter().take_while(|c| suffix_char(**c)).collect();
                if continues(last, &token) {
                    alternates.push(suffix.clone());
                    j = next;
                    joins += 1;
                    continue;
                }
            }
        }
        break;
    }
    let canonical = |suffix: &str| -> Option<String> {
        let mut suffix = trim_suffix(suffix);
        // Supplementary material (10.2337/dc18-0148/-/DC1) belongs to the article.
        if let Some(cut) = suffix.find("/-/") {
            suffix = &suffix[..cut];
        }
        let alphanumeric = suffix.chars().filter(|c| c.is_alphanumeric()).count();
        (alphanumeric >= 1 && suffix.chars().count() >= 2 && suffix.chars().next().is_some_and(|c| c.is_alphanumeric() || c == '(')).then(|| format!("{prefix}/{suffix}").to_lowercase())
    };
    let doi = canonical(&suffix)?;
    // Text glued to the end without a space: "…20917898Surgical".
    let trimmed = trim_suffix(&suffix);
    let mut glued = None;
    let tail: Vec<char> = trimmed.chars().collect();
    if let Some(p) = (1..tail.len()).rev().find(|p| tail[*p].is_uppercase() && tail[*p - 1].is_ascii_digit()) {
        if tail.len() - p >= 3 && tail[p + 1..].iter().all(|c| c.is_lowercase()) {
            glued = Some(tail[..p].iter().collect::<String>());
        }
    }
    let mut readings: Vec<String> = glued.into_iter().chain(alternates.into_iter().rev()).filter_map(|s| canonical(&s)).collect();
    readings.dedup();
    readings.retain(|r| *r != doi);
    let before: String = chars[start.saturating_sub(20)..start].iter().collect::<String>().to_lowercase();
    Some((DoiHit { doi, alternates: readings, labelled: before.contains("doi"), at: start }, j))
}

fn scan(chars: &[char]) -> Vec<DoiHit> {
    let mut hits = Vec::new();
    let mut i = 0;
    while i + 3 < chars.len() {
        let starts = chars[i] == '1' && chars[i + 1] == '0' && chars[i + 2] == '.';
        let joined = i > 0 && (chars[i - 1].is_ascii_digit() || chars[i - 1] == '.');
        if starts && !joined {
            if let Some((hit, end)) = read_doi(chars, i) {
                hits.push(hit);
                i = end.max(i + 1);
                continue;
            }
        }
        i += 1;
    }
    hits
}

/// Every DOI in `text`, in order.
pub fn find_dois(text: &str) -> Vec<DoiHit> {
    scan(&prepare(text).chars().collect::<Vec<_>>())
}

/// A DOI on its own, as typed or stored ("https://doi.org/10.1/X." → "10.1/x").
pub fn normalize_doi(text: &str) -> Option<String> {
    find_dois(text).into_iter().next().map(|h| h.doi)
}

/// The id in an arXiv watermark ("arXiv:2101.00001v2 [cs.LG] 3 Jan 2021"), without its
/// version. Bare "arXiv:…" mentions are citations, not the document.
pub fn arxiv_watermark(text: &str) -> Option<String> {
    let lower = prepare(text).to_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("arxiv:") {
        let start = from + found + "arxiv:".len();
        from = start;
        let rest = lower[start..].trim_start();
        let take = |s: &str, f: fn(char) -> bool| s.chars().take_while(|c| f(*c)).collect::<String>();
        let version = |s: &str| -> usize {
            let digits = s.strip_prefix('v').map(|r| take(r, |c| c.is_ascii_digit()).len()).unwrap_or(0);
            if digits > 0 { 1 + digits } else { 0 }
        };
        // 2101.00001 (since 2007): the watermark names the category in brackets.
        let year_month = take(rest, |c| c.is_ascii_digit());
        if year_month.len() == 4 && rest[4..].starts_with('.') {
            let number = take(&rest[5..], |c| c.is_ascii_digit());
            if (4..=5).contains(&number.len()) {
                let after = &rest[5 + number.len()..];
                let after = after[version(after)..].trim_start();
                if after.starts_with('[') {
                    return Some(format!("{year_month}.{number}"));
                }
            }
            continue;
        }
        // hep-th/9901001v1: the old form always carries its version on the watermark.
        let archive = take(rest, |c| c.is_ascii_lowercase() || c == '-' || c == '.');
        if !archive.is_empty() && rest[archive.len()..].starts_with('/') {
            let number = take(&rest[archive.len() + 1..], |c| c.is_ascii_digit());
            if number.len() == 7 && version(&rest[archive.len() + 1 + 7..]) > 0 {
                return Some(format!("{archive}/{number}"));
            }
        }
    }
    None
}

// ── The document's own DOI ───────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct EvidenceLine {
    pub text: String,
    /// The line's height relative to the page (0 when unknown).
    pub size: f32,
}

#[derive(Clone, Debug, Default)]
pub struct EvidencePage {
    /// Zero-based.
    pub index: usize,
    pub lines: Vec<EvidenceLine>,
}

impl EvidencePage {
    pub fn plain(index: usize, text: &str) -> Self {
        Self { index, lines: text.lines().map(|l| EvidenceLine { text: l.to_string(), size: 0.0 }).collect() }
    }
    pub fn text(&self) -> String {
        self.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n")
    }
}

/// What a PDF says about itself.
#[derive(Clone, Debug, Default)]
pub struct Evidence {
    /// Fields meant for the identifier: XMP prism:doi, dc:identifier…, an Info /doi entry.
    pub tagged: Vec<String>,
    /// The other document information values (title, subject, keywords …).
    pub metadata: Vec<String>,
    /// The document information title.
    pub title: Option<String>,
    /// The first pages and the last, in order.
    pub pages: Vec<EvidencePage>,
    pub page_count: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FoundDoi {
    pub doi: String,
    /// metadata | page | arxiv
    pub via: &'static str,
    pub alternates: Vec<String>,
}

/// Lines that start a bibliography.
fn references_heading(line: &str) -> bool {
    let line = line.trim().trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '.' | ' ' | '|' | 'I' | 'V' | 'X')).trim().to_lowercase();
    let line = line.trim_end_matches([':', '.']);
    line.chars().count() <= 30
        && ["references", "bibliography", "literature cited", "works cited", "reference list", "references and notes", "notes and references", "literatur", "références"]
            .iter()
            .any(|h| line == *h)
}

/// Lines that open a "how to cite this" box, which names the document's own DOI.
fn cite_marker(line: &str) -> bool {
    let line = line.trim().to_lowercase();
    ["please cite", "cite this article", "to cite this", "cite as:", "how to cite", "cite this paper"].iter().any(|m| line.contains(m)) || line.starts_with("citation:")
}

/// The DOIs of one page with where its bibliography starts and its "cite as" box, in the
/// character offsets of `find_dois`.
fn page_hits(text: &str) -> (Vec<DoiHit>, usize, Option<usize>) {
    let prepared = prepare(text);
    let (mut references, mut cite) = (usize::MAX, None);
    let mut offset = 0;
    for line in prepared.split('\n') {
        if references == usize::MAX && references_heading(line) {
            references = offset;
        }
        if cite.is_none() && cite_marker(line) {
            cite = Some(offset);
        }
        offset += line.chars().count() + 1;
    }
    (scan(&prepared.chars().collect::<Vec<_>>()), references, cite)
}

#[derive(Debug)]
struct Tally {
    doi: String,
    score: f64,
    order: (usize, usize),
    labelled: bool,
    first_page: bool,
    metadata: bool,
    alternates: Vec<String>,
}

/// The DOI that belongs to the document itself, when the evidence is clear. Metadata fields
/// and the first page count most; a DOI repeated in running heads counts again; reference
/// lists count not at all; the last page counts only in a "cite as" box or to confirm.
pub fn document_doi(evidence: &Evidence) -> Option<FoundDoi> {
    let mut tallies: Vec<Tally> = Vec::new();
    let mut add = |hit: &DoiHit, points: f64, order: (usize, usize), metadata: bool, first_page: bool, confirm_only: bool| {
        match tallies.iter_mut().find(|t| t.doi == hit.doi) {
            Some(t) => {
                t.score += points;
                t.labelled |= hit.labelled;
                t.metadata |= metadata;
                t.first_page |= first_page;
                t.order = t.order.min(order);
                for a in &hit.alternates {
                    if !t.alternates.contains(a) {
                        t.alternates.push(a.clone());
                    }
                }
            }
            None if !confirm_only => tallies.push(Tally {
                doi: hit.doi.clone(),
                score: points,
                order,
                labelled: hit.labelled,
                first_page,
                metadata,
                alternates: hit.alternates.clone(),
            }),
            None => {}
        }
    };
    let mut seen = std::collections::HashSet::new();
    for value in &evidence.tagged {
        for hit in find_dois(value) {
            if seen.insert(("tagged", hit.doi.clone())) {
                add(&hit, 6.0, (usize::MAX, 0), true, false, false);
            }
        }
    }
    for value in evidence.metadata.iter().chain(evidence.title.iter()) {
        for hit in find_dois(value) {
            if seen.insert(("metadata", hit.doi.clone())) {
                add(&hit, 4.0, (usize::MAX, 0), true, false, false);
            }
        }
    }
    let last = evidence.page_count.max(evidence.pages.iter().map(|p| p.index + 1).max().unwrap_or(0));
    for page in &evidence.pages {
        let (hits, references, cite) = page_hits(&page.text());
        let mut counted = std::collections::HashSet::new();
        for hit in &hits {
            let in_cite_box = cite.is_some_and(|c| hit.at >= c);
            if hit.at >= references && !in_cite_box {
                continue;
            }
            let label = if hit.labelled { 1.0 } else { 0.0 };
            let first = counted.insert(hit.doi.clone());
            let order = (page.index, hit.at);
            match page.index {
                0 => add(hit, if first { 3.0 + label } else { 1.0 }, order, false, true, false),
                1 => add(hit, if first { 1.0 + label } else { 0.5 }, order, false, false, false),
                i if i + 1 == last && in_cite_box => add(hit, 3.0 + label, order, false, false, false),
                _ => add(hit, 0.5, order, false, false, true),
            }
        }
    }
    // A glued or wrapped reading that another occurrence shows whole is that DOI.
    let keys: Vec<String> = tallies.iter().map(|t| t.doi.clone()).collect();
    let mut index = 0;
    while index < tallies.len() {
        let target = tallies[index].alternates.iter().find(|a| keys.contains(a) && **a != tallies[index].doi).cloned();
        match target.and_then(|a| tallies.iter().position(|t| t.doi == a)) {
            Some(into) if into != index => {
                let from = tallies.remove(index);
                let into = if into > index { into - 1 } else { into };
                let t = &mut tallies[into];
                t.score += from.score;
                t.labelled |= from.labelled;
                t.metadata |= from.metadata;
                t.first_page |= from.first_page;
                t.order = t.order.min(from.order);
            }
            _ => index += 1,
        }
    }
    tallies.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.order.cmp(&b.order)));
    let best = tallies.first().filter(|b| b.score >= 2.5);
    let clear = best.filter(|b| match tallies.get(1) {
        Some(second) if (b.score - second.score).abs() < 0.01 => b.labelled && !second.labelled,
        _ => true,
    });
    let found = clear.map(|b| FoundDoi { doi: b.doi.clone(), via: if b.metadata { "metadata" } else { "page" }, alternates: b.alternates.clone() });
    // An arXiv preprint: its watermark names it unless the metadata says otherwise (DOIs
    // printed on a preprint are other works, or the version published later).
    let watermark = evidence.pages.iter().find(|p| p.index == 0).and_then(|p| arxiv_watermark(&p.text()));
    match (found, watermark) {
        (Some(found), _) if found.via == "metadata" => Some(found),
        (_, Some(id)) => Some(FoundDoi { doi: format!("{ARXIV_DOI}{id}"), via: "arxiv", alternates: Vec::new() }),
        (found, None) => found,
    }
}

/// DOI-bearing fields of an XMP packet (and Info entries such as /doi) read straight from
/// the file's bytes: the values of prism:doi, pdfx:doi, crossmark:DOI, dc:identifier and
/// prism:url, and of uncompressed /doi entries.
pub fn tagged_values(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let lower = text.to_ascii_lowercase();
    let mut out = Vec::new();
    for tag in ["prism:doi", "pdfx:doi", "crossmark:doi", "dc:identifier", "prism:url", "pdfx:wps-articledoi"] {
        let mut from = 0;
        while let Some(found) = lower[from..].find(tag) {
            let start = from + found + tag.len();
            from = start;
            if lower[..start - tag.len()].ends_with('/') {
                continue;
            }
            // <prism:doi>…</prism:doi>, a nested rdf:li, or prism:doi="…".
            let window: String = text[start..].chars().take(300).collect();
            let value = match window.chars().next() {
                Some('=') => window[1..].trim_start().trim_start_matches(['"', '\'']).split(['"', '\'']).next().unwrap_or(""),
                _ => window.split(&format!("</{}", &text[start - tag.len()..start])).next().unwrap_or(&window),
            };
            // Nested elements (rdf:Bag, rdf:li) become spaces.
            let mut plain = String::new();
            let mut inside = false;
            for c in value.chars() {
                match c {
                    '<' => inside = true,
                    '>' => {
                        inside = false;
                        plain.push(' ');
                    }
                    c if !inside => plain.push(c),
                    _ => {}
                }
            }
            if plain.contains("10.") {
                out.push(plain.split_whitespace().collect::<Vec<_>>().join(" "));
            }
        }
    }
    let mut from = 0;
    while let Some(found) = lower[from..].find("/doi") {
        let start = from + found + 4;
        from = start;
        let rest = text[start..].trim_start();
        if let Some(rest) = rest.strip_prefix('(') {
            out.push(rest.chars().take_while(|c| *c != ')').take(200).collect());
        }
    }
    out.retain(|v| normalize_doi(v).is_some());
    out.dedup();
    out
}

// ── Titles ───────────────────────────────────────────────────

/// A title worth searching for: a few words of text, not a file name, a converter's label,
/// an identifier or a running head.
pub fn plausible_title(text: &str, placeholder: Option<&str>) -> Option<String> {
    let title = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = title.trim_matches(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '*' | '\u{2020}' | '\u{2021}'));
    let key = name_key(title);
    let words = key.split_whitespace().count();
    let length = title.chars().count();
    if !(3..=40).contains(&words) || !(12..=300).contains(&length) {
        return None;
    }
    let lower = title.to_lowercase();
    let noise = [
        "microsoft word", "untitled", "http", "www.", ".pdf", ".doc", ".tex", ".dvi", "doi:", "arxiv:", "©", "copyright", "all rights reserved",
        "downloaded from", "creative commons", "this article is", "accepted manuscript", "author manuscript",
    ];
    if noise.iter().any(|n| lower.contains(n)) || !find_dois(title).is_empty() {
        return None;
    }
    let visible = title.chars().filter(|c| !c.is_whitespace()).count();
    if title.chars().filter(|c| c.is_alphabetic()).count() * 10 < visible * 7 {
        return None;
    }
    if placeholder.is_some_and(|p| name_key(p) == key) {
        return None;
    }
    Some(title.to_string())
}

/// The title as typeset: the first run of lines in the largest type on the first page that
/// reads like a title (a journal's name above it is too short or too large to be one).
fn typeset_title(page: &EvidencePage, placeholder: Option<&str>) -> Option<String> {
    let lines: Vec<&EvidenceLine> = page.lines.iter().filter(|l| l.size > 0.0 && l.text.chars().filter(|c| c.is_alphabetic()).count() >= 2).collect();
    // Text without geometry: the first line that reads like a title.
    if lines.is_empty() {
        return page.lines.iter().take(5).find_map(|l| plausible_title(&l.text, placeholder));
    }
    let mut sizes: Vec<f32> = lines.iter().map(|l| l.size).collect();
    sizes.sort_by(|a, b| b.total_cmp(a));
    sizes.dedup_by(|a, b| (*a - *b).abs() <= *b * 0.12);
    for size in sizes.into_iter().take(4) {
        let same = |l: &EvidenceLine| (l.size - size).abs() <= size * 0.15 && l.text.chars().filter(|c| c.is_alphabetic()).count() >= 2;
        let mut run: Vec<&str> = Vec::new();
        let mut candidates = Vec::new();
        for line in &page.lines {
            if same(line) && run.len() < 5 {
                run.push(line.text.trim());
            } else if !run.is_empty() {
                candidates.push(std::mem::take(&mut run));
            }
        }
        if !run.is_empty() {
            candidates.push(run);
        }
        for run in candidates {
            let mut text = String::new();
            for piece in run {
                if text.ends_with('-') && piece.chars().next().is_some_and(char::is_lowercase) {
                    text.pop();
                } else if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(piece);
            }
            if let Some(title) = plausible_title(&text, placeholder) {
                return Some(title);
            }
        }
    }
    None
}

/// Titles to look the document up by, best first: the document information title when it
/// is a real one, and the title as typeset on the first page.
pub fn title_candidates(evidence: &Evidence, placeholder: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let typeset = evidence.pages.iter().find(|p| p.index == 0).and_then(|p| typeset_title(p, placeholder));
    let info = evidence.title.as_deref().and_then(|t| plausible_title(t, placeholder));
    for title in typeset.into_iter().chain(info) {
        push_title(&mut out, title);
    }
    out
}

/// Adds a title unless one like it is there already.
pub fn push_title(titles: &mut Vec<String>, title: String) {
    if !titles.iter().any(|t| title_similarity(t, &title) >= 0.9) {
        titles.push(title);
    }
    titles.truncate(3);
}

fn bigrams(text: &str) -> Vec<(char, char)> {
    let chars: Vec<char> = text.chars().filter(|c| !c.is_whitespace()).collect();
    let mut grams: Vec<(char, char)> = chars.windows(2).map(|w| (w[0], w[1])).collect();
    grams.sort();
    grams
}

/// How alike two titles are, 0 to 1, after folding case, accents and punctuation: the mean
/// of word overlap and letter-pair overlap (Dice).
pub fn title_similarity(a: &str, b: &str) -> f64 {
    let (a, b) = (name_key(a), name_key(b));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let words = |s: &str| s.split_whitespace().map(String::from).collect::<std::collections::BTreeSet<_>>();
    let (wa, wb) = (words(&a), words(&b));
    let word_dice = 2.0 * wa.intersection(&wb).count() as f64 / (wa.len() + wb.len()) as f64;
    let (ga, gb) = (bigrams(&a), bigrams(&b));
    let (mut i, mut j, mut shared) = (0, 0, 0);
    while i < ga.len() && j < gb.len() {
        match ga[i].cmp(&gb[j]) {
            std::cmp::Ordering::Equal => {
                shared += 1;
                i += 1;
                j += 1;
            }
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
        }
    }
    let gram_dice = if ga.len() + gb.len() == 0 { 0.0 } else { 2.0 * shared as f64 / (ga.len() + gb.len()) as f64 };
    (word_dice + gram_dice) / 2.0
}

/// A search result to weigh against the title the document was looked up by.
#[derive(Clone, Debug, Default)]
pub struct TitleCandidate {
    pub title: String,
    pub year: Option<i64>,
    /// Authors' family names, first author first.
    pub surnames: Vec<String>,
}

/// What is known of the document to confirm a match with.
#[derive(Clone, Debug, Default)]
pub struct TitleContext {
    pub year: Option<i64>,
    /// Family names the source already lists.
    pub surnames: Vec<String>,
    /// The text of the first page.
    pub page_text: Option<String>,
}

/// Notices, replies and corrections share their title with the work they are about.
fn notice(key: &str) -> bool {
    let first = key.split_whitespace().next().unwrap_or("");
    matches!(first, "erratum" | "correction" | "corrigendum" | "retraction" | "retracted" | "reply" | "comment" | "response" | "re" | "expression" | "withdrawn" | "addendum")
}

/// A score when `candidate` is the document looked up by `query`, else None. Strict: a
/// near-identical title with the first author's name on the first page (or among the
/// source's creators), or an identical title of some length that nothing contradicts. A
/// year more than one off, or authors the page does not name, rule a candidate out.
pub fn accept_title(query: &str, candidate: &TitleCandidate, context: &TitleContext) -> Option<f64> {
    let (qk, ck) = (name_key(query), name_key(&candidate.title));
    if notice(&qk) != notice(&ck) {
        return None;
    }
    let similarity = title_similarity(query, &candidate.title);
    if similarity < 0.85 {
        return None;
    }
    let page = context.page_text.as_deref().map(name_key);
    let year = match (context.year, candidate.year) {
        (Some(a), Some(b)) => Some((a - b).abs() <= 1),
        (None, Some(b)) => page
            .as_deref()
            .filter(|p| [b - 1, b, b + 1].iter().any(|y| p.split_whitespace().any(|w| w == y.to_string())))
            .map(|_| true),
        _ => None,
    };
    let surnames: Vec<String> = candidate.surnames.iter().take(3).map(|s| name_key(s)).filter(|s| s.chars().count() >= 2).collect();
    let author = if surnames.is_empty() {
        None
    } else if !context.surnames.is_empty() {
        let known: Vec<String> = context.surnames.iter().map(|s| name_key(s)).collect();
        Some(surnames.iter().any(|s| known.iter().any(|k| k == s || k.split_whitespace().last() == s.split_whitespace().last())))
    } else {
        page.as_deref().map(|p| {
            // Affiliation marks stick to names: "Bayen1,2".
            let words: std::collections::HashSet<&str> = p.split_whitespace().map(|w| w.trim_matches(|c: char| c.is_ascii_digit())).collect();
            surnames.iter().any(|s| s.split_whitespace().last().is_some_and(|last| words.contains(last)))
        })
    };
    if year == Some(false) || author == Some(false) {
        return None;
    }
    let words = qk.split_whitespace().count();
    let accepted = (similarity >= 0.90 && author == Some(true)) || (similarity >= 0.97 && qk.chars().count() >= 12 && (words >= 4 || year == Some(true)));
    accepted.then(|| similarity + if author == Some(true) { 0.05 } else { 0.0 } + if year == Some(true) { 0.02 } else { 0.0 })
}

// ── The record ───────────────────────────────────────────────

/// How a source was identified, kept per source.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Identification {
    /// The file this record is about; a different file is identified again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// The title the source was given from its file name, replaced once identified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// metadata | page | arxiv (the DOI the PDF carries) or title (a title search).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    /// Other readings of that DOI, tried when it is not found.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alternates: Vec<String>,
    /// Titles to search for when the PDF carries no DOI.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub titles: Vec<String>,
    /// The start of the first page, to confirm a title match by its authors and year.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_page: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    /// The `BACKFILL_VERSION` that last looked at this source in the background pass over
    /// older PDFs; it is not looked at again until the version goes up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backfill: Option<u32>,
}

/// Raised when the background pass over older PDFs learns something new (e.g. another
/// service to search), so sources it gave up on are tried once more.
pub const BACKFILL_VERSION: u32 = 1;

/// The background pass over PDFs added before they were identified on arrival, or never
/// matched: how many wait to be read, and how many wait for a lookup.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackfillStatus {
    pub identify: i64,
    pub lookup: i64,
}

/// PDFs with a file and no identifier that the current backfill has not looked at, and
/// are not already waiting for a lookup.
const BACKFILL_CANDIDATES: &str = "FROM sources s LEFT JOIN meta m ON m.key = 'identify:' || s.id
     WHERE s.kind = 'pdf' AND s.trashed_at IS NULL AND coalesce(s.file_path, '') <> '' AND s.index_status IN ('ready', 'no_text')
       AND coalesce(nullif(s.doi, ''), nullif(s.pmid, ''), nullif(s.openalex_id, '')) IS NULL
       AND coalesce(s.enrich_status, '') NOT IN ('requested', 'pending', 'backfill')
       AND (m.value IS NULL OR NOT json_valid(m.value) OR coalesce(json_extract(m.value, '$.backfill'), 0) < ?1)";

fn record_key(id: &str) -> String {
    format!("identify:{id}")
}

/// Adds `identifiedBy` to a source read on its own.
pub(crate) fn decorate(db: &Connection, source: &mut Source) -> Result<()> {
    let record: Option<String> = db.query_row("SELECT value FROM meta WHERE key = ?", [record_key(&source.id)], |r| r.get(0)).optional().map_err(e)?;
    let via = record.and_then(|r| serde_json::from_str::<Identification>(&r).ok()).and_then(|r| r.via);
    if let Some(via) = via {
        source.fields.insert("identifiedBy".into(), Json::String(via));
    }
    Ok(())
}

impl Store {
    pub fn identification(&self, id: &str) -> Result<Option<Identification>> {
        Ok(self.meta(&record_key(id))?.and_then(|r| serde_json::from_str(&r).ok()))
    }

    pub fn set_identification(&self, id: &str, record: &Identification) -> Result<()> {
        let mut record = record.clone();
        record.at = Some(now_ms());
        self.set_meta(&record_key(id), &serde_json::to_string(&record).map_err(e)?)
    }

    /// A metadata-only source for the same work (by OpenAlex id or DOI) that an added PDF
    /// should join instead of standing beside it.
    pub fn file_less_source_for(&self, except: &str, openalex_id: Option<&str>, doi: Option<&str>) -> Result<Option<String>> {
        let doi = doi.and_then(normalize_doi);
        if openalex_id.is_none() && doi.is_none() {
            return Ok(None);
        }
        self.read()?
            .query_row(
                "SELECT id FROM sources WHERE id <> ?1 AND trashed_at IS NULL AND coalesce(file_path, '') = ''
                   AND ((?2 IS NOT NULL AND openalex_id = ?2) OR (?3 IS NOT NULL AND (lower(doi) = ?3 OR lower(doi) = 'https://doi.org/' || ?3 OR lower(doi) = 'doi:' || ?3)))
                 ORDER BY added_at LIMIT 1",
                params![except, openalex_id, doi],
                |r| r.get(0),
            )
            .optional()
            .map_err(e)
    }

    /// Joins an added file (`from`, just imported) to the existing source `into`: `into`
    /// keeps its metadata and gains the file, with `from`'s collections, tags, notes,
    /// highlights and links; `from` is removed. `into` is indexed again.
    pub fn adopt_file(&self, into: &str, from: &str) -> Result<()> {
        {
            let db = self.db()?;
            let tx = db.unchecked_transaction().map_err(e)?;
            let (kind, path, hash, mime, size, pages, tags): (String, Option<String>, Option<String>, Option<String>, Option<i64>, Option<i64>, String) = tx
                .query_row("SELECT kind, file_path, file_hash, mime, file_size, page_count, tags FROM sources WHERE id = ?", [from], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
                })
                .map_err(e)?;
            let existing: String = tx.query_row("SELECT tags FROM sources WHERE id = ?", [into], |r| r.get(0)).map_err(e)?;
            let mut all: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();
            for tag in serde_json::from_str::<Vec<String>>(&tags).unwrap_or_default() {
                if !all.iter().any(|t| t.eq_ignore_ascii_case(&tag)) {
                    all.push(tag);
                }
            }
            tx.execute("UPDATE sources SET file_path = NULL, file_hash = NULL WHERE id = ?", [from]).map_err(e)?;
            tx.execute(
                "UPDATE sources SET file_path = ?2, file_hash = ?3, mime = ?4, file_size = ?5, page_count = coalesce(?6, page_count), tags = ?7,
                   kind = CASE WHEN kind IN ('reference', 'web') THEN ?8 ELSE kind END, index_status = 'pending', index_error = NULL, updated_at = ?9
                 WHERE id = ?1",
                params![into, path, hash, mime, size, pages, serde_json::to_string(&all).map_err(e)?, kind, now_ms()],
            )
            .map_err(e)?;
            tx.execute("INSERT OR IGNORE INTO source_collections(source_id, collection_id) SELECT ?1, collection_id FROM source_collections WHERE source_id = ?2", params![into, from])
                .map_err(e)?;
            for table in ["notes", "annotations", "linked_files"] {
                tx.execute(&format!("UPDATE {table} SET source_id = ?1 WHERE source_id = ?2"), params![into, from]).map_err(e)?;
            }
            tx.execute("UPDATE links SET from_id = ?1 WHERE from_kind = ?3 AND from_id = ?2", params![into, from, links::SOURCE]).map_err(e)?;
            tx.execute("UPDATE links SET to_id = ?1 WHERE to_kind = ?3 AND to_id = ?2", params![into, from, links::SOURCE]).map_err(e)?;
            // The record follows the file.
            tx.execute("DELETE FROM meta WHERE key = ?", [record_key(into)]).map_err(e)?;
            tx.execute("UPDATE meta SET key = ?1 WHERE key = ?2", params![record_key(into), record_key(from)]).map_err(e)?;
            crate::refresh_fts(&tx, into)?;
            tx.commit().map_err(e)?;
        }
        self.delete(&[from.to_string()])?;
        Ok(())
    }

    /// Replaces a DOI read from the PDF with the one it turned out to be, unless the user
    /// changed it meanwhile. Not a new identifier for the lookup queue.
    pub fn correct_doi(&self, id: &str, read: &str, actual: &str) -> Result<bool> {
        let db = self.db()?;
        let changed = db.execute("UPDATE sources SET doi = ?3 WHERE id = ?1 AND lower(doi) = ?2", params![id, read, actual]).map_err(e)?;
        if changed > 0 {
            crate::refresh_fts(&db, id)?;
        }
        Ok(changed > 0)
    }

    /// Queues a lookup for a source without identifiers (by the titles of its record).
    pub fn queue_lookup(&self, id: &str) -> Result<()> {
        self.db()?
            .execute(
                "UPDATE sources SET enrich_status = 'pending', enrich_error = NULL, enrich_attempts = 0, enrich_after = NULL WHERE id = ? AND enrich_status IS NULL",
                [id],
            )
            .map(|_| ())
            .map_err(e)
    }

    // ── The background pass over older PDFs ─────────────────

    /// The next older PDF to identify in the background, most recently added first.
    pub fn next_backfill_identification(&self) -> Result<Option<String>> {
        self.read()?
            .query_row(&format!("SELECT s.id {BACKFILL_CANDIDATES} ORDER BY s.added_at DESC LIMIT 1"), [BACKFILL_VERSION], |r| r.get(0))
            .optional()
            .map_err(e)
    }

    /// Records that the current backfill looked at a source, so it is not taken again.
    pub fn mark_backfilled(&self, id: &str) -> Result<()> {
        let mut record = self.identification(id)?.unwrap_or_default();
        record.backfill = Some(BACKFILL_VERSION);
        self.set_identification(id, &record)
    }

    /// Queues a background lookup: one only taken when nothing else waits. A lookup just
    /// queued for the source (a DOI attached by the backfill) moves to the back with it.
    pub fn queue_backfill_lookup(&self, id: &str) -> Result<bool> {
        let changed = self
            .db()?
            .execute(
                "UPDATE sources SET enrich_status = 'backfill', enrich_error = NULL, enrich_attempts = 0, enrich_after = NULL
                 WHERE id = ? AND trashed_at IS NULL AND (enrich_status IS NULL OR enrich_status IN ('pending', 'not_found', 'failed'))",
                [id],
            )
            .map_err(e)?;
        Ok(changed > 0)
    }

    /// The next background lookup, most recently added first.
    pub fn next_backfill_enrichment(&self) -> Result<Option<crate::EnrichJob>> {
        self.read()?
            .query_row(
                "SELECT id, doi, pmid, openalex_id, title, year, enrich_attempts FROM sources
                 WHERE trashed_at IS NULL AND enrich_status = 'backfill' AND coalesce(enrich_after, 0) <= ?1 ORDER BY added_at DESC LIMIT 1",
                [now_ms()],
                |r| {
                    Ok(crate::EnrichJob {
                        id: r.get(0)?,
                        doi: r.get(1)?,
                        pmid: r.get(2)?,
                        openalex_id: r.get(3)?,
                        title: r.get(4)?,
                        year: r.get(5)?,
                        attempts: r.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(e)
    }

    pub fn backfill_status(&self) -> Result<BackfillStatus> {
        let db = self.read()?;
        let identify = db.query_row(&format!("SELECT count(*) {BACKFILL_CANDIDATES}"), [BACKFILL_VERSION], |r| r.get(0)).map_err(e)?;
        let lookup = db.query_row("SELECT count(*) FROM sources WHERE trashed_at IS NULL AND enrich_status = 'backfill'", [], |r| r.get(0)).map_err(e)?;
        Ok(BackfillStatus { identify, lookup })
    }

    /// Gives a source the title of the work it was identified as, when its title is still
    /// the one made from its file name (the user's own title is kept).
    pub fn adopt_title(&self, id: &str, title: &str) -> Result<bool> {
        let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
        let Some(placeholder) = self.identification(id)?.and_then(|r| r.placeholder) else { return Ok(false) };
        if title.is_empty() {
            return Ok(false);
        }
        let db = self.db()?;
        let changed = db
            .execute(
                "UPDATE sources SET title = ?2, updated_at = ?3 WHERE id = ?1 AND (trim(title) = '' OR title = ?4)",
                params![id, title, now_ms(), placeholder],
            )
            .map_err(e)?;
        if changed > 0 {
            crate::refresh_fts(&db, id)?;
        }
        Ok(changed > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doi(text: &str) -> Option<String> {
        normalize_doi(text)
    }

    #[test]
    fn reads_dois_through_prefixes_case_and_punctuation() {
        assert_eq!(doi("doi:10.1001/JAMACARDIO.2021.0185").as_deref(), Some("10.1001/jamacardio.2021.0185"));
        assert_eq!(doi("https://doi.org/10.1186/s12936-018-2493-0.").as_deref(), Some("10.1186/s12936-018-2493-0"));
        assert_eq!(doi("http://dx.doi.org/10.1016/j.cell.2020.01.001;").as_deref(), Some("10.1016/j.cell.2020.01.001"));
        assert_eq!(doi("(see doi:10.1038/nature12373)").as_deref(), Some("10.1038/nature12373"));
        assert_eq!(doi("DOI 10.1371/journal.pone.0123456, 2015").as_deref(), Some("10.1371/journal.pone.0123456"));
        assert_eq!(doi("<https://doi.org/10.5555/abc>").as_deref(), Some("10.5555/abc"));
        assert_eq!(doi("https://api.crossref.org/works/10.1000%2FEncoded.Work").as_deref(), Some("10.1000/encoded.work"));
        assert_eq!(doi("DOI10.1016/j.jelectrocard.2005.06.011").as_deref(), Some("10.1016/j.jelectrocard.2005.06.011"));
    }

    #[test]
    fn keeps_brackets_that_belong_to_the_doi() {
        assert_eq!(
            doi("doi:10.1002/(SICI)1097-4636(199601)30:1<1::AID-JBM1>3.0.CO;2-X.").as_deref(),
            Some("10.1002/(sici)1097-4636(199601)30:1<1::aid-jbm1>3.0.co;2-x")
        );
        assert_eq!(doi("(doi:10.1016/S0140-6736(20)30183-5)").as_deref(), Some("10.1016/s0140-6736(20)30183-5"));
        assert_eq!(doi("Lancet. 2020;395(10223):497-506. doi:10.1016/S0140-6736(20)30183-5.").as_deref(), Some("10.1016/s0140-6736(20)30183-5"));
    }

    #[test]
    fn mends_what_extraction_does_to_a_doi() {
        // A unicode dash, a soft hyphen, a non-breaking space after the slash.
        assert_eq!(doi("10.1007/s00500\u{2010}020\u{2011}05275\u{2013}y").as_deref(), Some("10.1007/s00500-020-05275-y"));
        assert_eq!(doi("10.1000/ab\u{00AD}cd\u{200B}ef").as_deref(), Some("10.1000/abcdef"));
        assert_eq!(doi("10.2337/\u{00A0}dc06-1509").as_deref(), Some("10.2337/dc06-1509"));
        // Broken over lines after a dot, a hyphen or the slash.
        assert_eq!(doi("DOI https://doi.\norg/10.1200/JCO.20.\n01688\n3652 Volume 38").as_deref(), Some("10.1200/jco.20.01688"));
        assert_eq!(doi("https://doi.org/10.1186/s12936-018-\n2493-0").as_deref(), Some("10.1186/s12936-018-2493-0"));
        assert_eq!(doi("doi: 10.1016/\nj.cell.2020.01.001").as_deref(), Some("10.1016/j.cell.2020.01.001"));
        // A sentence after the DOI is not part of it.
        assert_eq!(doi("doi:10.1000/abc.\nReceived 5 May 2020").as_deref(), Some("10.1000/abc"));
        assert_eq!(doi("doi:10.1000/xyz-\nThe next paragraph").as_deref(), Some("10.1000/xyz-"));
        // Springer's hidden glyph run.
        assert_eq!(doi("https://doi.org/10.1007/s00500-020-05275-y(0123456789().,-volV)(0123456789().,-volV)").as_deref(), Some("10.1007/s00500-020-05275-y"));
        // Supplementary material belongs to the article.
        assert_eq!(doi("doi:10.2337/dc18-0148/-/DC1.").as_deref(), Some("10.2337/dc18-0148"));
    }

    #[test]
    fn offers_other_readings_of_an_ambiguous_doi() {
        let hit = &find_dois("10.1177/1553350620917898Surgical Innovation")[0];
        assert_eq!(hit.doi, "10.1177/1553350620917898surgical");
        assert_eq!(hit.alternates, vec!["10.1177/1553350620917898"]);
        let hit = &find_dois("doi:10.1200/JCO.20.\n01688")[0];
        assert_eq!(hit.alternates, vec!["10.1200/jco.20"]);
        assert!(hit.labelled);
        assert!(!find_dois("https://doi.org/10.1200/x1")[0].alternates.iter().any(|a| a.is_empty()));
    }

    #[test]
    fn rejects_what_only_looks_like_a_doi() {
        assert_eq!(doi("version 10.12/no"), None);
        assert_eq!(doi("in 2010.1234/5678 cases"), None);
        assert_eq!(doi("10.1234/"), None);
        assert_eq!(doi("10.1234/..."), None);
        assert_eq!(doi("p = 10.12345 / 2"), None);
    }

    #[test]
    fn reads_arxiv_watermarks_not_arxiv_citations() {
        assert_eq!(arxiv_watermark("arXiv:2101.00001v2  [cs.LG]  3 Jan 2021").as_deref(), Some("2101.00001"));
        assert_eq!(arxiv_watermark("arXiv:1706.03762v7 [cs.CL] 2 Aug 2023").as_deref(), Some("1706.03762"));
        assert_eq!(arxiv_watermark("arXiv:hep-th/9901001v1 4 Jan 1999").as_deref(), Some("hep-th/9901001"));
        assert_eq!(arxiv_watermark("as shown in [12] (arXiv:1706.03762)."), None);
        assert_eq!(arxiv_watermark("Vaswani et al. arXiv:1706.03762, 2017"), None);
    }

    fn page(index: usize, text: &str) -> EvidencePage {
        EvidencePage::plain(index, text)
    }

    #[test]
    fn prefers_the_documents_doi_over_its_references() {
        // JAMA: the article's DOI under the abstract; the last page lists cited works.
        let evidence = Evidence {
            pages: vec![
                page(0, "Utility of a Deep-Learning Algorithm\nJAMA Cardiol. 2021;6(6):624-632. doi:10.1001/jamacardio.2021.0185\nPublished online"),
                page(1, "Methods\nWe enrolled patients"),
                page(8, "References\n1. Smith J. Echo. doi:10.1016/j.echo.2019.01.001\n2. Doe J. doi:10.1001/jama.2019.1234"),
            ],
            page_count: 9,
            ..Default::default()
        };
        let found = document_doi(&evidence).unwrap();
        assert_eq!((found.doi.as_str(), found.via), ("10.1001/jamacardio.2021.0185", "page"));
    }

    #[test]
    fn a_reference_list_alone_identifies_nothing() {
        let evidence = Evidence {
            pages: vec![
                page(0, "Synthetic Scientific Paper\nPrior work established the first result 1"),
                page(2, "References\n1. A. doi:10.1000/one\n2. B. doi:10.1000/two"),
            ],
            page_count: 3,
            ..Default::default()
        };
        assert_eq!(document_doi(&evidence), None);
        // Nor does a short paper with its references on the first page.
        let evidence = Evidence { pages: vec![page(0, "A note\nText.\nREFERENCES\n1. doi:10.1000/one")], page_count: 1, ..Default::default() };
        assert_eq!(document_doi(&evidence), None);
    }

    #[test]
    fn metadata_settles_a_garbled_first_page() {
        // Springer: the Info /doi entry, and the first-page DOI glued to hidden glyphs.
        let evidence = Evidence {
            tagged: vec!["10.1007/s00500-020-05275-y".into()],
            metadata: vec!["Soft Computing, https://doi.org/10.1007/s00500-020-05275-y".into()],
            pages: vec![page(0, "https://doi.org/10.1007/s00500-020-05275-y(0123456789().,-volV)")],
            page_count: 9,
            ..Default::default()
        };
        assert_eq!(document_doi(&evidence).unwrap(), FoundDoi { doi: "10.1007/s00500-020-05275-y".into(), via: "metadata", alternates: vec![] });
        // Elsevier puts it in the title field.
        let evidence = Evidence { title: Some("doi:10.1016/j.jelectrocard.2005.06.011".into()), page_count: 7, ..Default::default() };
        assert_eq!(document_doi(&evidence).unwrap().doi, "10.1016/j.jelectrocard.2005.06.011");
    }

    #[test]
    fn running_heads_outvote_a_glued_reading() {
        let evidence = Evidence {
            pages: vec![page(0, "DOI: 10.1177/1553350620917898Surgical Innovation\nAbstract"), page(1, "https://doi.org/10.1177/1553350620917898")],
            page_count: 7,
            ..Default::default()
        };
        assert_eq!(document_doi(&evidence).unwrap().doi, "10.1177/1553350620917898");
    }

    #[test]
    fn a_cite_as_box_on_the_last_page_names_the_document() {
        // JMIR prints no DOI on the first page; the last page's "Please cite as" box does.
        let evidence = Evidence {
            pages: vec![
                page(0, "Original Paper\nReduction of Time on the Ground"),
                page(9, "References\n33. Doe. doi:10.1000/cited\nAbbreviations\nPlease cite as:\nBayen E\nJ Med Internet Res 2021;23(6):e17551\ndoi: 10.2196/17551\nPMID:"),
            ],
            page_count: 10,
            ..Default::default()
        };
        assert_eq!(document_doi(&evidence).unwrap().doi, "10.2196/17551");
    }

    #[test]
    fn two_unlabelled_dois_on_the_first_page_are_too_close_to_call() {
        let evidence = Evidence { pages: vec![page(0, "Title\n10.1000/first and 10.1000/second")], page_count: 4, ..Default::default() };
        assert_eq!(document_doi(&evidence), None);
        let evidence = Evidence { pages: vec![page(0, "Title\nDOI: 10.1000/first\nsee 10.1000/second")], page_count: 4, ..Default::default() };
        assert_eq!(document_doi(&evidence).unwrap().doi, "10.1000/first");
    }

    #[test]
    fn an_arxiv_watermark_names_a_preprint() {
        let evidence = Evidence {
            pages: vec![page(0, "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023\nAttention Is All You Need\nas in [3] https://doi.org/10.1000/other")],
            page_count: 15,
            ..Default::default()
        };
        assert_eq!(document_doi(&evidence).unwrap(), FoundDoi { doi: "10.48550/arxiv.1706.03762".into(), via: "arxiv", alternates: vec![] });
        let evidence = Evidence { tagged: vec!["10.1103/PhysRevLett.1.1".into()], ..evidence };
        assert_eq!(document_doi(&evidence).unwrap().doi, "10.1103/physrevlett.1.1");
    }

    #[test]
    fn reads_doi_fields_from_xmp_and_info_entries() {
        let bytes = br#"<x:xmpmeta><rdf:Description prism:doi="10.1016/J.CELL.2020.01.001" /><dc:identifier><rdf:Bag><rdf:li>doi:10.1016/j.cell.2020.01.001</rdf:li></rdf:Bag></dc:identifier>
            <prism:url>https://doi.org/10.1016/j.cell.2020.01.001</prism:url></x:xmpmeta> 12 0 obj << /doi (10.1038/s41591-021-01384-9) /Title (x) >>"#;
        let values: Vec<String> = tagged_values(bytes).iter().filter_map(|v| normalize_doi(v)).collect();
        assert!(values.iter().all(|v| v == "10.1016/j.cell.2020.01.001" || v == "10.1038/s41591-021-01384-9"), "{values:?}");
        assert!(values.contains(&"10.1038/s41591-021-01384-9".to_string()));
        assert_eq!(values.iter().filter(|v| v.starts_with("10.1016")).count(), 3);
    }

    #[test]
    fn finds_the_typeset_title_and_skips_noise() {
        let line = |text: &str, size: f32| EvidenceLine { text: text.into(), size };
        let first = EvidencePage {
            index: 0,
            lines: vec![
                line("JAMA Cardiology", 0.03),
                line("Original Investigation", 0.014),
                line("Utility of a Deep-Learning Algorithm to Guide Novices", 0.022),
                line("to Acquire Echocardiograms for Limited Diagnostic Use", 0.021),
                line("Akhil Narang, MD; Richard Bae, MD", 0.012),
            ],
        };
        let evidence = Evidence { title: Some("Microsoft Word - paper.docx".into()), pages: vec![first], ..Default::default() };
        assert_eq!(title_candidates(&evidence, Some("PUBMED 33599681")), vec!["Utility of a Deep-Learning Algorithm to Guide Novices to Acquire Echocardiograms for Limited Diagnostic Use"]);
        assert_eq!(plausible_title("Untitled", None), None);
        assert_eq!(plausible_title("doi:10.1016/j.jelectrocard.2005.06.011", None), None);
        assert_eq!(plausible_title("Downloaded paper", None), None);
        assert_eq!(plausible_title("my paper final v2", Some("my_paper-final v2")), None);
        assert!(plausible_title("Big data, medicines safety and pharmacovigilance", None).is_some());
    }

    #[test]
    fn title_similarity_folds_case_accents_and_punctuation() {
        assert_eq!(title_similarity("Deep learning of HIV field-based rapid tests", "Deep Learning of HIV Field-Based Rapid Tests."), 1.0);
        assert_eq!(title_similarity("Évaluation précoce", "evaluation precoce"), 1.0);
        assert!(title_similarity("Deep learning of HIV field-based rapid tests", "Deep learning of HIV field based rapid test") > 0.9);
        assert!(title_similarity("Deep learning for malaria", "Deep learning for tuberculosis") < 0.8);
        assert!(title_similarity("Attention is all you need", "Attention is not all you need") < 0.97);
    }

    #[test]
    fn accepts_a_title_only_with_agreeing_authors_or_an_exact_long_title() {
        let title = "Reduction of Time on the Ground Related to Real-Time Video Detection of Falls in Memory Care Facilities: Observational Study";
        let page = TitleContext { page_text: Some(format!("Original Paper\n{title}\nEleonore Bayen1,2, MD, PhD; Shirley Nickels3")), ..Default::default() };
        let work = TitleCandidate { title: title.into(), year: Some(2021), surnames: vec!["Bayen".into(), "Nickels".into()] };
        assert!(accept_title(title, &work, &page).is_some());
        // The same title by other people is another work.
        let other = TitleCandidate { surnames: vec!["Smith".into()], ..work.clone() };
        assert_eq!(accept_title(title, &other, &page), None);
        // A reply or correction shares the title.
        let reply = TitleCandidate { title: format!("Reply: {title}"), ..work.clone() };
        assert_eq!(accept_title(title, &reply, &page), None);
        // A near title needs the authors; a year far off rules it out.
        let near = TitleCandidate { title: "Reduction of time on the ground related to real time video detection of falls in memory care facilities".into(), ..work.clone() };
        assert!(accept_title(title, &near, &page).is_some());
        assert_eq!(accept_title(title, &near, &TitleContext::default()), None);
        assert_eq!(accept_title(title, &work, &TitleContext { year: Some(2015), ..page.clone() }), None);
        // Without a page: an identical title of four words or more, nothing contradicting.
        let reference = TitleContext { year: Some(2021), ..Default::default() };
        assert!(accept_title(title, &TitleCandidate { surnames: vec![], ..work.clone() }, &reference).is_some());
        assert!(accept_title(title, &work, &TitleContext { surnames: vec!["Bayen".into()], ..Default::default() }).is_some());
        assert_eq!(accept_title(title, &work, &TitleContext { surnames: vec!["Jones".into()], ..Default::default() }), None);
        assert_eq!(accept_title("Deep learning", &TitleCandidate { title: "Deep learning".into(), year: Some(2015), surnames: vec![] }, &TitleContext::default()), None);
    }

    #[test]
    fn an_identified_pdf_joins_the_reference_it_belongs_to() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let input = |value: Json| serde_json::from_value::<crate::SourceInput>(value).unwrap();
        let shelf = store.create_collection("Reading", None, None).unwrap();
        let reference = store
            .insert_source(input(serde_json::json!({"kind": "reference", "title": "My title for it", "doi": "https://doi.org/10.2196/17551", "tags": ["falls"]})))
            .unwrap();
        let added = store
            .insert_source(input(serde_json::json!({
                "kind": "pdf", "title": "PUBMED 34137723", "filePath": "/tmp/PUBMED_34137723.pdf", "fileHash": "abc", "mime": "application/pdf",
                "tags": ["inbox"], "collections": [shelf.id]
            })))
            .unwrap();
        store.set_identification(&added.id, &Identification { placeholder: Some("PUBMED 34137723".into()), via: Some("page".into()), ..Default::default() }).unwrap();
        assert_eq!(store.file_less_source_for(&added.id, None, Some("10.2196/17551")).unwrap(), Some(reference.id.clone()));
        assert_eq!(store.file_less_source_for(&added.id, None, Some("10.2196/other")).unwrap(), None);

        store.adopt_file(&reference.id, &added.id).unwrap();
        assert!(store.source(&added.id).unwrap().is_none(), "no duplicate is left");
        let joined = store.source(&reference.id).unwrap().unwrap();
        assert_eq!((joined.kind.as_str(), joined.file_hash(), joined.index_status.as_str()), ("pdf", Some("abc"), "pending"));
        assert_eq!(joined.title(), "My title for it", "the reference keeps its metadata");
        assert_eq!(joined.tags, vec!["falls", "inbox"]);
        assert_eq!(joined.collections, vec![shelf.id]);
        assert_eq!(joined.fields["identifiedBy"], "page");
        assert_eq!(store.source_by_hash("abc").unwrap().unwrap().id, reference.id, "the reader finds the file under the reference");
        // The user's title stays; only the file-name title is replaced.
        assert!(!store.adopt_title(&reference.id, "Reduction of Time on the Ground").unwrap());
        let other = store.insert_source(input(serde_json::json!({"kind": "pdf", "title": "Downloaded paper"}))).unwrap();
        store.set_identification(&other.id, &Identification { placeholder: Some("Downloaded paper".into()), ..Default::default() }).unwrap();
        assert!(store.adopt_title(&other.id, "Deep learning of HIV field-based rapid tests").unwrap());
        assert_eq!(store.source(&other.id).unwrap().unwrap().title(), "Deep learning of HIV field-based rapid tests");
    }
}
