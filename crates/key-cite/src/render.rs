//! Citations and bibliographies through hayagriva's CSL processor, written out as plain text,
//! HTML and RTF. One call renders a whole document's citations so numbering, disambiguation
//! and positions (ibid, subsequent) come out right.
use citationberg::{
    Display, FontStyle, FontVariant, FontWeight, IndependentStyle, LocaleCode, StyleClass, TextDecoration, VerticalAlign,
    json::Item, taxonomy::Locator,
};
use hayagriva::{
    BibliographyDriver, BibliographyRequest, CitationItem, CitationRequest, CitePurpose, Elem, ElemChild, ElemChildren, ElemMeta,
    Formatted as Run, Formatting, LocatorPayload, SpecificLocator,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::{fmt::Write as _, str::FromStr};

/// One cited work inside a citation.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiteItem {
    pub id: String,
    /// "12", "12–14": where in the work.
    #[serde(default)]
    pub locator: Option<String>,
    /// The locator's CSL label: page (default), chapter, section, paragraph, figure, line, …
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub suffix: Option<String>,
    /// "(2021, p. 4)": the author is named in the sentence.
    #[serde(default)]
    pub suppress_author: bool,
    /// Only the author's name.
    #[serde(default)]
    pub author_only: bool,
    /// For prose: "Narang et al. (2021)".
    #[serde(default)]
    pub narrative: bool,
}

/// One citation (one footnote, or one parenthetical) of one or more works.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationInput {
    pub items: Vec<CiteItem>,
    /// The footnote it sits in (note styles); numbered in order when left out.
    #[serde(default)]
    pub note_number: Option<usize>,
}

/// The same text three ways.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Formatted {
    pub text: String,
    pub html: String,
    pub rtf: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibEntry {
    pub id: String,
    #[serde(flatten)]
    pub formatted: Formatted,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bibliography {
    pub entries: Vec<BibEntry>,
    pub hanging_indent: bool,
    /// The whole list, entries one per line (text), as `<div class="csl-bib-body">` (html)
    /// and as an RTF document.
    #[serde(flatten)]
    pub formatted: Formatted,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderOutput {
    /// One per requested citation, in order.
    pub citations: Vec<Formatted>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bibliography: Option<Bibliography>,
    /// `note` styles put citations in footnotes.
    pub note_style: bool,
    /// Ids that were asked for but not given.
    pub missing: Vec<String>,
}

/// What to render.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    #[serde(default)]
    pub citations: Vec<CitationInput>,
    /// Render the bibliography of everything cited (and of `uncited`).
    #[serde(default)]
    pub bibliography: bool,
    /// Works listed in the bibliography without being cited.
    #[serde(default)]
    pub uncited: Vec<String>,
}

fn parse_items(items: &[Json]) -> Vec<Item> {
    items.iter().filter_map(|item| serde_json::from_value::<Item>(sanitize(item.clone())).ok()).collect()
}

/// Keeps what the engine cannot take out of an item: dates beyond a range's start and end, and
/// empty values.
fn sanitize(mut item: Json) -> Json {
    if let Some(map) = item.as_object_mut() {
        map.retain(|_, v| !matches!(v, Json::Null) && v.as_str().is_none_or(|s| !s.trim().is_empty()));
        for value in map.values_mut() {
            if let Some(parts) = value.get_mut("date-parts").and_then(Json::as_array_mut) {
                parts.truncate(2);
            }
        }
    }
    item
}

/// hayagriva adds given names to disambiguate only under the `by-cite` rule (the CSL
/// default); the global rules (`primary-name-with-initials`, APA's, …) silently do nothing,
/// leaving "(Smith, 2019; Smith, 2019)". Rendering them as `by-cite` gives "(A. Smith, 2019;
/// B. Smith, 2019)", which is what the global rules produce for ambiguous cites.
fn engine_style(style: &IndependentStyle) -> std::borrow::Cow<'_, IndependentStyle> {
    use citationberg::DisambiguationRule;
    if style.citation.disambiguate_add_givenname && style.citation.givenname_disambiguation_rule != DisambiguationRule::ByCite {
        let mut adjusted = style.clone();
        adjusted.citation.givenname_disambiguation_rule = DisambiguationRule::ByCite;
        std::borrow::Cow::Owned(adjusted)
    } else {
        std::borrow::Cow::Borrowed(style)
    }
}

pub fn render(style: &IndependentStyle, locale: Option<&str>, items: &[Json], request: &RenderRequest) -> Result<RenderOutput, String> {
    render_in(&crate::data::CitationData::global(), style, locale, items, request)
}

/// `render` with the locales of a given data folder.
pub fn render_in(data: &crate::data::CitationData, style: &IndependentStyle, locale: Option<&str>, items: &[Json], request: &RenderRequest) -> Result<RenderOutput, String> {
    let style = engine_style(style);
    let style: &IndependentStyle = &style;
    let entries = parse_items(items);
    let find = |id: &str| entries.iter().find(|e| e.id().as_deref() == Some(id));
    let mut missing: Vec<String> = Vec::new();
    let locale = crate::styles::locale_code(locale);
    let effective = locale.clone().or_else(|| style.default_locale.clone()).unwrap_or_else(citationberg::LocaleCode::en_us);
    let locale_files = data.locales_for(&effective);
    let locale_files: &[citationberg::Locale] = &locale_files;
    let note_style = style.settings.class == StyleClass::Note;

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut driver: BibliographyDriver<'_, Item> = BibliographyDriver::new();
        // Which driver citations answer which request (a citation of only unknown ids has none).
        let mut slots: Vec<Option<usize>> = Vec::new();
        let mut count = 0usize;
        let mut cites = request.citations.clone();
        if cites.is_empty() && request.bibliography {
            // A bibliography of a selection: each work "cited" once, in the order given.
            cites = request.uncited.iter().map(|id| CitationInput { items: vec![CiteItem { id: id.clone(), ..Default::default() }], note_number: None }).collect();
        }
        let only_bibliography = request.citations.is_empty();
        let mut note = 0usize;
        for cite in &cites {
            let mut list = Vec::new();
            for item in &cite.items {
                let Some(entry) = find(&item.id) else {
                    if !missing.contains(&item.id) {
                        missing.push(item.id.clone());
                    }
                    continue;
                };
                let locator = item.locator.as_deref().map(str::trim).filter(|l| !l.is_empty()).map(|l| {
                    let label = item.label.as_deref().and_then(|l| Locator::from_str(l).ok()).unwrap_or(Locator::Page);
                    SpecificLocator(label, LocatorPayload::Str(l))
                });
                let purpose = if item.author_only {
                    Some(CitePurpose::Author)
                } else if item.narrative {
                    Some(CitePurpose::Prose)
                } else {
                    None
                };
                list.push(CitationItem::new(entry, locator, None, false, purpose));
            }
            if list.is_empty() {
                slots.push(None);
                continue;
            }
            note = cite.note_number.unwrap_or(note + 1);
            driver.citation(CitationRequest::new(list, style, locale.clone(), locale_files, Some(note)));
            slots.push(Some(count));
            count += 1;
        }
        if !only_bibliography {
            let hidden: Vec<_> = request
                .uncited
                .iter()
                .filter(|id| !request.citations.iter().any(|c| c.items.iter().any(|i| &i.id == *id)))
                .filter_map(|id| find(id))
                .map(|entry| CitationItem::new(entry, None, None, true, None))
                .collect();
            if !hidden.is_empty() {
                driver.citation(CitationRequest::new(hidden, style, locale.clone(), locale_files, Some(note + 1)));
            }
        }
        let rendered = driver.finish(BibliographyRequest::new(style, locale.clone(), locale_files));
        (rendered, slots, cites)
    }));
    let (rendered, slots, cites) = outcome.map_err(|_| "The citation engine could not render this style".to_string())?;

    let citations = if request.citations.is_empty() {
        Vec::new()
    } else {
        slots
            .iter()
            .zip(&cites)
            .map(|(slot, cite)| match slot.and_then(|i| rendered.citations.get(i)) {
                Some(out) => {
                    let known: Vec<&CiteItem> = cite.items.iter().filter(|i| find(&i.id).is_some()).collect();
                    formatted(&adjust(out.citation.clone(), &known), false)
                }
                None => Formatted::default(),
            })
            .collect()
    };

    let bibliography = if request.bibliography {
        rendered.bibliography.map(|bib| {
            let entries: Vec<BibEntry> = bib
                .items
                .iter()
                .map(|item| {
                    let mut children = ElemChildren(Vec::new());
                    if let Some(first) = &item.first_field {
                        children.0.push(first.clone());
                        children.0.push(ElemChild::Text(Run { text: " ".into(), formatting: Formatting::default() }));
                    }
                    children.0.extend(item.content.0.iter().cloned());
                    BibEntry { id: item.key.clone(), formatted: formatted(&children, true) }
                })
                .collect();
            let text = entries.iter().map(|e| e.formatted.text.as_str()).collect::<Vec<_>>().join("\n");
            let html = format!(
                "<div class=\"csl-bib-body\">{}</div>",
                entries.iter().map(|e| format!("<div class=\"csl-entry\">{}</div>", e.formatted.html)).collect::<String>()
            );
            let rtf = rtf_document(&entries.iter().map(|e| e.formatted.rtf.clone()).collect::<Vec<_>>(), bib.hanging_indent);
            Bibliography { entries, hanging_indent: bib.hanging_indent, formatted: Formatted { text, html, rtf } }
        })
    } else {
        None
    };
    Ok(RenderOutput { citations, bibliography, note_style, missing })
}

/// Where a quotation is from, for "“…” — <attribution>" outside a document: the in-text
/// citation without its brackets for author-date styles ("Narang et al., 2021, p. 4"), the
/// first note for note styles, and the reference itself for numeric ones (a bare "[1]" means
/// nothing on its own), with the page after it.
pub fn attribution(style: &IndependentStyle, locale: Option<&str>, item: &Json, locator: Option<&str>, label: Option<&str>) -> Result<Formatted, String> {
    let id = item.get("id").and_then(Json::as_str).unwrap_or_default().to_string();
    let cite = CiteItem { id: id.clone(), locator: locator.map(String::from), label: label.map(String::from), ..Default::default() };
    let numeric = style.settings.class != StyleClass::Note
        && style.info.category.iter().any(|c| {
            matches!(c, citationberg::StyleCategory::CitationFormat { format: citationberg::CitationFormat::Numeric | citationberg::CitationFormat::Label })
        });
    if numeric {
        let request = RenderRequest { bibliography: true, uncited: vec![id], ..Default::default() };
        let out = render(style, locale, std::slice::from_ref(item), &request)?;
        let entry = out.bibliography.and_then(|b| b.entries.into_iter().next()).ok_or("This style has no reference list")?;
        let mut text = strip_label(&entry.formatted.text);
        let mut html = entry.formatted.html.clone();
        if let Some(page) = locator.map(str::trim).filter(|p| !p.is_empty()) {
            text = format!("{}, p. {page}", text.trim_end_matches('.'));
            html = format!("{html}, p. {}", escape_html(page));
        }
        return Ok(Formatted { rtf: escape_rtf(&text), text, html });
    }
    let request = RenderRequest { citations: vec![CitationInput { items: vec![cite], note_number: None }], ..Default::default() };
    let out = render(style, locale, std::slice::from_ref(item), &request)?;
    let mut formatted = out.citations.into_iter().next().unwrap_or_default();
    if style.settings.class != StyleClass::Note {
        formatted.text = strip_brackets(&formatted.text);
        formatted.html = strip_brackets(&formatted.html);
        formatted.rtf = strip_brackets(&formatted.rtf);
    }
    Ok(formatted)
}

/// "(Doe, 2020, p. 4)" -> "Doe, 2020, p. 4", when the brackets enclose the whole citation.
fn strip_brackets(text: &str) -> String {
    let t = text.trim();
    for (open, close) in [('(', ')'), ('[', ']')] {
        if t.starts_with(open) && t.ends_with(close) {
            let inner = &t[open.len_utf8()..t.len() - close.len_utf8()];
            let mut depth = 0i32;
            let balanced = inner.chars().all(|c| {
                if c == open {
                    depth += 1;
                } else if c == close {
                    depth -= 1;
                }
                depth >= 0
            });
            if balanced && depth == 0 {
                return inner.trim().to_string();
            }
        }
    }
    t.to_string()
}

/// "[1] A. Narang, …" / "1. Narang A, …" -> the reference without its number.
fn strip_label(text: &str) -> String {
    let t = text.trim_start();
    let rest = if let Some(r) = t.strip_prefix('[').and_then(|r| r.split_once(']')).map(|(_, r)| r) {
        r
    } else {
        let digits = t.len() - t.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits > 0 { t[digits..].trim_start_matches(['.', ')']) } else { t }
    };
    rest.trim().to_string()
}

/// Renders a sample work once so a style the engine cannot use is known before it is used.
pub fn check(style: &IndependentStyle) -> Result<(), String> {
    let item = serde_json::json!({
        "id": "check", "type": "article-journal", "title": "A sample title",
        "author": [{ "family": "Doe", "given": "Jane" }], "issued": { "date-parts": [[2020]] },
        "container-title": "Journal", "volume": "1", "page": "1-2"
    });
    let request = RenderRequest {
        citations: vec![CitationInput { items: vec![CiteItem { id: "check".into(), locator: Some("2".into()), ..Default::default() }], note_number: None }],
        bibliography: true,
        uncited: vec![],
    };
    render(style, None, &[item], &request).map(|_| ())
}

// ── Prefixes, suffixes and suppressed authors ────────────────────────────────

/// hayagriva has no per-item affixes or "suppress author"; both are applied to each item's
/// part of the rendered citation (the element it marks with the item's index).
fn adjust(mut children: ElemChildren, items: &[&CiteItem]) -> ElemChildren {
    let mut placed = vec![false; items.len()];
    for child in children.0.iter_mut() {
        if let ElemChild::Elem(elem) = child
            && let Some(ElemMeta::Entry(index)) = elem.meta
            && let Some(item) = items.get(index)
        {
            placed[index] = true;
            if item.suppress_author {
                remove_names(&mut elem.children);
                trim_leading(&mut elem.children);
            }
            affix(&mut elem.children, item);
        }
    }
    // Items folded into a collapsed range keep their affixes at the citation's edges.
    for (index, item) in items.iter().enumerate() {
        if !placed[index] && (item.prefix.is_some() || item.suffix.is_some()) {
            affix(&mut children, item);
        }
    }
    children
}

fn affix(children: &mut ElemChildren, item: &CiteItem) {
    if let Some(prefix) = item.prefix.as_deref().filter(|p| !p.trim().is_empty()) {
        let text = if prefix.ends_with(char::is_whitespace) { prefix.to_string() } else { format!("{prefix} ") };
        children.0.insert(0, ElemChild::Text(Run { text, formatting: Formatting::default() }));
    }
    if let Some(suffix) = item.suffix.as_deref().filter(|s| !s.trim().is_empty()) {
        let text = if suffix.starts_with(|c: char| c.is_whitespace() || ",.;:)]".contains(c)) { suffix.to_string() } else { format!(" {suffix}") };
        children.0.push(ElemChild::Text(Run { text, formatting: Formatting::default() }));
    }
}

fn remove_names(children: &mut ElemChildren) -> bool {
    let before = children.0.len();
    children.0.retain(|c| !matches!(c, ElemChild::Elem(Elem { meta: Some(ElemMeta::Names(_)), .. })));
    if children.0.len() != before {
        return true;
    }
    children.0.iter_mut().any(|c| match c {
        ElemChild::Elem(e) => remove_names(&mut e.children),
        _ => false,
    })
}

/// Drops the delimiter a removed name leaves at the start: ", 2021" -> "2021".
fn trim_leading(children: &mut ElemChildren) -> bool {
    while let Some(first) = children.0.first_mut() {
        match first {
            ElemChild::Text(run) => {
                let trimmed = run.text.trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == ':');
                if trimmed.is_empty() {
                    children.0.remove(0);
                    continue;
                }
                run.text = trimmed.to_string();
                return true;
            }
            ElemChild::Elem(elem) => {
                if trim_leading(&mut elem.children) {
                    return true;
                }
                children.0.remove(0);
            }
            _ => return true,
        }
    }
    false
}

// ── Writers ───────────────────────────────────────────────────────────────────

fn runs_mut<'a>(children: &'a mut ElemChildren, out: &mut Vec<&'a mut Run>) {
    for child in children.0.iter_mut() {
        match child {
            ElemChild::Text(run) => out.push(run),
            ElemChild::Link { text, .. } => out.push(text),
            ElemChild::Elem(elem) => runs_mut(&mut elem.children, out),
            _ => {}
        }
    }
}

/// CSL drops a period that follows a title's own "?" or "!" (or a period): "more? PLoS",
/// not "more?. PLoS". hayagriva leaves them doubled when they come from different variables.
fn fix_punctuation(children: &mut ElemChildren) {
    let mut runs = Vec::new();
    runs_mut(children, &mut runs);
    let mut previous_end: Option<char> = None;
    for run in runs {
        if run.text.is_empty() {
            continue;
        }
        if run.text.starts_with('.') && !run.text.starts_with("..") && matches!(previous_end, Some('.' | '?' | '!')) {
            run.text.remove(0);
        }
        for (from, to) in [("?.", "?"), ("!.", "!")] {
            if run.text.contains(from) {
                run.text = run.text.replace(from, to);
            }
        }
        // Closing quotes are looked through: “Is it?”. -> “Is it?”
        if let Some(last) = run.text.trim_end_matches(['”', '’', '"', '\'']).chars().last() {
            previous_end = Some(last);
        }
    }
}

fn formatted(children: &ElemChildren, entry: bool) -> Formatted {
    let mut children = children.clone();
    fix_punctuation(&mut children);
    let children = &children;
    let mut text = String::new();
    let mut html = String::new();
    let mut rtf = String::new();
    for child in &children.0 {
        write_child(child, &mut text, &mut html, &mut rtf);
    }
    let text = text.split('\n').map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(if entry { " " } else { "\n" });
    Formatted { text: tidy(&text), html: html.trim().to_string(), rtf: rtf.trim().to_string() }
}

fn tidy(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if c == ' ' {
            if !space {
                out.push(c);
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out.trim().to_string()
}

fn write_child(child: &ElemChild, text: &mut String, html: &mut String, rtf: &mut String) {
    match child {
        ElemChild::Text(run) => write_run(run, None, text, html, rtf),
        ElemChild::Markup(markup) => write_run(&Run { text: markup.clone(), formatting: Formatting::default() }, None, text, html, rtf),
        ElemChild::Link { text: run, url } => write_run(run, Some(url), text, html, rtf),
        ElemChild::Transparent { .. } => {}
        ElemChild::Elem(elem) => {
            let block = matches!(elem.display, Some(Display::Block | Display::Indent));
            if block {
                text.push('\n');
                html.push_str(if elem.display == Some(Display::Indent) { "<div class=\"csl-indent\">" } else { "<div class=\"csl-block\">" });
                rtf.push_str("\\line ");
            } else if elem.display == Some(Display::LeftMargin) {
                html.push_str("<span class=\"csl-left-margin\">");
            } else if elem.display == Some(Display::RightInline) {
                html.push_str("<span class=\"csl-right-inline\">");
            }
            for c in &elem.children.0 {
                write_child(c, text, html, rtf);
            }
            match elem.display {
                Some(Display::Block | Display::Indent) => {
                    text.push('\n');
                    html.push_str("</div>");
                }
                Some(Display::LeftMargin) => {
                    html.push_str("</span> ");
                    text.push(' ');
                    rtf.push(' ');
                }
                Some(Display::RightInline) => html.push_str("</span>"),
                None => {}
            }
        }
    }
}

fn write_run(run: &Run, url: Option<&String>, text: &mut String, html: &mut String, rtf: &mut String) {
    text.push_str(&run.text);
    let f = &run.formatting;
    let mut open = String::new();
    let mut close = String::new();
    let mut tag = |name: &str| {
        open.push_str(&format!("<{name}>"));
        close.insert_str(0, &format!("</{name}>"));
    };
    if f.font_style == FontStyle::Italic {
        tag("i");
    }
    if f.font_weight == FontWeight::Bold {
        tag("b");
    }
    if f.text_decoration == TextDecoration::Underline {
        tag("u");
    }
    match f.vertical_align {
        VerticalAlign::Sup => tag("sup"),
        VerticalAlign::Sub => tag("sub"),
        _ => {}
    }
    if f.font_variant == FontVariant::SmallCaps {
        open.push_str("<span style=\"font-variant:small-caps\">");
        close.insert_str(0, "</span>");
    }
    if let Some(url) = url {
        let _ = write!(html, "<a href=\"{}\">{open}{}{close}</a>", escape_html(url), escape_html(&run.text));
    } else {
        let _ = write!(html, "{open}{}{close}", escape_html(&run.text));
    }
    let mut codes = String::new();
    if f.font_style == FontStyle::Italic {
        codes.push_str("\\i");
    }
    if f.font_weight == FontWeight::Bold {
        codes.push_str("\\b");
    }
    if f.text_decoration == TextDecoration::Underline {
        codes.push_str("\\ul");
    }
    if f.font_variant == FontVariant::SmallCaps {
        codes.push_str("\\scaps");
    }
    match f.vertical_align {
        VerticalAlign::Sup => codes.push_str("\\super"),
        VerticalAlign::Sub => codes.push_str("\\sub"),
        _ => {}
    }
    if codes.is_empty() {
        rtf.push_str(&escape_rtf(&run.text));
    } else {
        let _ = write!(rtf, "{{{codes} {}}}", escape_rtf(&run.text));
    }
}

pub fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// RTF text: control characters escaped, everything past ASCII as `\uN?`.
pub fn escape_rtf(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' | '{' | '}' => {
                out.push('\\');
                out.push(c);
            }
            '\n' => out.push_str("\\line "),
            '\t' => out.push_str("\\tab "),
            c if (c as u32) < 0x80 => out.push(c),
            c => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    let _ = write!(out, "\\u{}?", *unit as i16);
                }
            }
        }
    }
    out
}

/// A whole RTF document of paragraphs (bibliography entries, or one citation).
pub fn rtf_document(paragraphs: &[String], hanging_indent: bool) -> String {
    let indent = if hanging_indent { "\\fi-720\\li720" } else { "" };
    let body: String = paragraphs.iter().map(|p| format!("{{\\pard{indent}\\sa120 {p}\\par}}\n")).collect();
    format!("{{\\rtf1\\ansi\\deff0{{\\fonttbl{{\\f0 Times New Roman;}}}}\\f0\\fs24\n{body}}}")
}

/// Unused codes stay accepted; kept for callers building their own requests.
pub fn locale(code: &str) -> LocaleCode {
    LocaleCode(code.to_string())
}
