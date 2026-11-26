// What a typed or pasted query looks like: a DOI, an arXiv id, a PMID, an ISBN, a link, a
// year or a range of years, a citation ("Smith et al. 2020"), a quoted title, a kind of
// item, or the name of a tag or collection. Each reading is only offered: the search
// field lists it above its suggestions and the query stays as typed until one is picked.
// Matching is written out by hand (no regex engine): offsets are byte offsets into the text.
use crate::{Result, Store, e};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueryFilter {
    pub field: String,
    pub op: String,
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Detection {
    /// Stable id of the reading ("doi", "years", "citation" …).
    pub id: &'static str,
    pub filters: Vec<QueryFilter>,
    /// Kinds of item the search tab should show (only where kinds can be picked).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<&'static str>>,
    /// The query once the detected part is taken out (what is still searched as text).
    pub rest: String,
    /// The query is only this identifier: the library can offer to add the work it names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add: Option<Identifier>,
}

/// A work's identifier as pasted: doi | arxiv | pmid | pmcid | isbn, normalised.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Identifier {
    pub kind: &'static str,
    pub value: String,
}

/// One pasted entry of a list of identifiers: what it is, or `None` when it names none.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PastedIdentifier {
    pub text: String,
    pub identifier: Option<Identifier>,
}

const ADDABLE: [&str; 5] = ["doi", "arxiv", "pmid", "pmcid", "isbn"];

fn addable(found: &Detection) -> Option<Identifier> {
    let kind = ADDABLE.iter().copied().find(|k| *k == found.id)?;
    let value = found.filters.first()?.value.clone();
    // Books are looked up and matched by ISBN-13.
    let value = if kind == "isbn" { crate::matching::bare_isbn(&value).unwrap_or(value) } else { value };
    Some(Identifier { kind, value })
}

/// Identifiers pasted one per line, or separated by commas, semicolons or spaces, in order;
/// an entry that names none is kept so the list can say so. At most 200.
pub fn read_identifiers(text: &str) -> Vec<PastedIdentifier> {
    let mut out = Vec::new();
    for piece in text.split(['\n', '\r', ',', ';', '\t']).map(str::trim).filter(|p| !p.is_empty()) {
        let mut rest = piece.to_string();
        // Several on one line ("PMID 123 PMID 456", "10.1/a 10.2/b"): taken one at a time.
        for _ in 0..50 {
            let trimmed = rest.trim().to_string();
            if trimmed.is_empty() {
                break;
            }
            let found = identifier(&trimmed).and_then(|d| addable(&d).map(|i| (i, d.rest)));
            match found {
                Some((identifier, left)) if left.trim().len() < trimmed.len() => {
                    out.push(PastedIdentifier { text: identifier.value.clone(), identifier: Some(identifier) });
                    rest = left;
                }
                _ => {
                    // An ISBN written with spaces ("978 0 262 03384 8") reads as one once joined.
                    let joined: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
                    match identifier(&joined).and_then(|d| addable(&d).filter(|_| d.rest.trim().is_empty())) {
                        Some(identifier) => out.push(PastedIdentifier { text: trimmed.clone(), identifier: Some(identifier) }),
                        None => out.push(PastedIdentifier { text: trimmed.clone(), identifier: None }),
                    }
                    break;
                }
            }
        }
        if out.len() >= 200 {
            out.truncate(200);
            break;
        }
    }
    out
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct KnownCollection {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct KnownNames {
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub collections: Vec<KnownCollection>,
}

const MIN_YEAR: i64 = 1500;
const MAX_YEAR: i64 = 2100;
fn is_year(y: i64) -> bool {
    (MIN_YEAR..=MAX_YEAR).contains(&y)
}

fn filter(field: &str, value: &str, label: &str, op: &str) -> QueryFilter {
    QueryFilter { field: field.into(), op: op.into(), value: value.into(), label: label.into() }
}

// ── Text helpers ─────────────────────────────────────────────────────────────

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn prev_char(text: &str, at: usize) -> Option<char> {
    text[..at].chars().next_back()
}

fn next_char(text: &str, at: usize) -> Option<char> {
    text[at..].chars().next()
}

/// A `\b` before `at` for a match that starts with a word character.
fn boundary_before(text: &str, at: usize) -> bool {
    !prev_char(text, at).is_some_and(is_word)
}

/// `text[at..]` starts with `prefix`, ignoring ASCII case.
fn starts_ci(text: &str, at: usize, prefix: &str) -> bool {
    text.len() >= at + prefix.len() && text.as_bytes()[at..at + prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn skip_ws(text: &str, mut at: usize) -> usize {
    while let Some(c) = next_char(text, at).filter(|c| c.is_whitespace()) {
        at += c.len_utf8();
    }
    at
}

fn count_digits(text: &str, at: usize) -> usize {
    text.as_bytes()[at..].iter().take_while(|b| b.is_ascii_digit()).count()
}

fn char_starts(text: &str) -> impl Iterator<Item = usize> + '_ {
    text.char_indices().map(|(i, _)| i).chain(std::iter::once(text.len()))
}

/// Lower case with the same byte layout (a character whose lower case is longer stays).
fn lower_same_layout(text: &str) -> String {
    text.chars()
        .map(|c| {
            let mut lower = c.to_lowercase();
            match (lower.next(), lower.next()) {
                (Some(l), None) if l.len_utf8() == c.len_utf8() => l,
                _ => c,
            }
        })
        .collect()
}

fn replace_escaped_slash(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(at) = rest.find('%') {
        out.push_str(&rest[..at]);
        if rest[at..].len() >= 3 && rest.as_bytes()[at + 1] == b'2' && rest.as_bytes()[at + 2].eq_ignore_ascii_case(&b'f') {
            out.push('/');
            rest = &rest[at + 3..];
        } else {
            out.push('%');
            rest = &rest[at + 1..];
        }
    }
    out.push_str(rest);
    out
}

fn tidy(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let collapsed = if text.starts_with(char::is_whitespace) && !collapsed.is_empty() { format!(" {collapsed}") } else { collapsed };
    // Punctuation left on its own where something was taken out.
    let lone = |t: &str| !t.is_empty() && t.chars().all(|c| ".,;:!?)]".contains(c));
    let joined = collapsed.split(' ').map(|t| if lone(t) { "" } else { t }).collect::<Vec<_>>().join(" ");
    joined
        .trim_start_matches(|c: char| c.is_whitespace() || ",;:.·-".contains(c))
        .trim_end_matches(|c: char| c.is_whitespace() || ",;:·-".contains(c))
        .trim()
        .to_string()
}

fn floor_boundary(text: &str, mut at: usize) -> usize {
    at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// The query without `[start, end)`.
fn cut(text: &str, start: usize, end: usize) -> String {
    let (start, end) = (floor_boundary(text, start), floor_boundary(text, end.max(start)));
    tidy(&format!("{} {}", &text[..start], &text[end..]))
}

/// Sentence punctuation and unbalanced closing brackets after an identifier.
fn trim_tail(value: &str) -> &str {
    let mut v = value;
    loop {
        let Some(last) = v.chars().next_back() else { return v };
        let count = |c: char| v.matches(c).count();
        if ".,;:!?'\"”’".contains(last) || (last == ')' && count('(') < count(')')) || (last == ']' && count('[') < count(']')) {
            v = &v[..v.len() - last.len_utf8()];
        } else {
            return v;
        }
    }
}

// ── Identifiers ──────────────────────────────────────────────────────────────

pub struct DoiMatch {
    pub doi: String,
    pub start: usize,
    pub end: usize,
}

/// `10.NNNN(.N)*/\S+` at `at`: the end of the match.
fn doi_core(text: &str, at: usize) -> Option<usize> {
    if !text[at..].starts_with("10.") {
        return None;
    }
    let mut i = at + 3;
    let digits = count_digits(text, i);
    if !(4..=9).contains(&digits) {
        return None;
    }
    i += digits;
    while text[i..].starts_with('.') && count_digits(text, i + 1) > 0 {
        i += 1 + count_digits(text, i + 1);
    }
    if !text[i..].starts_with('/') {
        return None;
    }
    i += 1;
    let tail: usize = text[i..].chars().take_while(|c| !c.is_whitespace()).map(char::len_utf8).sum();
    (tail > 0).then_some(i + tail)
}

/// A DOI as typed or pasted: bare, "doi:"-prefixed or a doi.org link; lowercased.
pub fn read_doi(input: &str) -> Option<DoiMatch> {
    // Links escape the slash ("10.1038%2Fs41591…"). Offsets are into the unescaped text.
    let text = replace_escaped_slash(input);
    for at in text.char_indices().map(|(i, _)| i) {
        // A prefix that leads straight into a DOI starts the match.
        let mut core = None;
        for prefix in ["https://dx.doi.org/", "http://dx.doi.org/", "https://doi.org/", "http://doi.org/"] {
            if starts_ci(&text, at, prefix) && doi_core(&text, at + prefix.len()).is_some() {
                core = Some(at + prefix.len());
                break;
            }
        }
        if core.is_none() && starts_ci(&text, at, "doi") && boundary_before(&text, at) {
            let after = at + 3;
            if text[after..].starts_with(':') {
                core = Some(skip_ws(&text, after + 1)).filter(|&c| doi_core(&text, c).is_some());
            } else if skip_ws(&text, after) > after {
                core = Some(skip_ws(&text, after)).filter(|&c| doi_core(&text, c).is_some());
            }
        }
        let core = match core {
            Some(c) => c,
            None if doi_core(&text, at).is_some() => at,
            None => continue,
        };
        let end = doi_core(&text, core)?;
        let doi = trim_tail(&text[core..end]);
        if doi.len() < doi.find('/').unwrap_or(0) + 2 {
            return None;
        }
        return Some(DoiMatch { doi: doi.to_lowercase(), start: at, end: core + doi.len() });
    }
    None
}

fn isbn_valid(digits: &str) -> bool {
    let d: Vec<char> = digits.chars().collect();
    if d.len() == 13 {
        if !(digits.starts_with("978") || digits.starts_with("979")) || !d.iter().all(char::is_ascii_digit) {
            return false;
        }
        let sum: u32 = d.iter().enumerate().map(|(i, c)| c.to_digit(10).unwrap_or(0) * if i % 2 == 1 { 3 } else { 1 }).sum();
        return sum % 10 == 0;
    }
    if d.len() == 10 {
        if !d[..9].iter().all(char::is_ascii_digit) || !(d[9].is_ascii_digit() || d[9] == 'X') {
            return false;
        }
        let sum: u32 = d.iter().enumerate().map(|(i, &c)| (if c == 'X' { 10 } else { c.to_digit(10).unwrap_or(0) }) * (10 - i as u32)).sum();
        return sum % 11 == 0;
    }
    false
}

/// arXiv's id after a prefix: "2101.00001" or "hep-th/9901001", then "v2" and ".pdf".
fn arxiv_id(text: &str, at: usize) -> Option<(usize, usize)> {
    let b = text.as_bytes();
    let id_end = if count_digits(text, at) == 4 && b.get(at + 4) == Some(&b'.') && count_digits(text, at + 5) >= 4 {
        at + 5 + count_digits(text, at + 5).min(5)
    } else {
        let letters = b[at..].iter().take_while(|c| c.is_ascii_alphabetic() || **c == b'-').count();
        if letters == 0 {
            return None;
        }
        let mut i = at + letters;
        if b.get(i) == Some(&b'.') && b.get(i + 1).is_some_and(u8::is_ascii_alphabetic) && b.get(i + 2).is_some_and(u8::is_ascii_alphabetic) && b.get(i + 3) == Some(&b'/') {
            i += 3;
        }
        if b.get(i) != Some(&b'/') || count_digits(text, i + 1) < 7 {
            return None;
        }
        i + 8
    };
    let mut end = id_end;
    if b.get(end).is_some_and(|c| *c == b'v' || *c == b'V') && count_digits(text, end + 1) > 0 {
        end += 1 + count_digits(text, end + 1);
    }
    if starts_ci(text, end, ".pdf") {
        end += 4;
    }
    Some((id_end, end))
}

fn detection(id: &'static str, filters: Vec<QueryFilter>, rest: String) -> Detection {
    Detection { id, filters, kinds: None, rest, add: None }
}

/// `key:smith2020` or `@smith2020`: a citation key.
fn citation_key(text: &str) -> Option<Detection> {
    if !text.contains('@') && !text.as_bytes().windows(4).any(|w| w.eq_ignore_ascii_case(b"key:")) {
        return None;
    }
    let key_char = |c: char| c.is_alphanumeric() || matches!(c, '_' | '-' | ':' | '.' | '/');
    for at in char_starts(text) {
        if !prev_char(text, at).is_none_or(char::is_whitespace) {
            continue;
        }
        let start = if starts_ci(text, at, "key:") {
            at + 4
        } else if text[at..].starts_with('@') {
            at + 1
        } else {
            continue;
        };
        let length: usize = text[start..].chars().take_while(|c| key_char(*c)).map(char::len_utf8).sum();
        let key = text[start..start + length].trim_end_matches(['.', ':', '/']);
        if key.is_empty() || !next_char(text, start + key.len()).is_none_or(char::is_whitespace) {
            continue;
        }
        return Some(detection("citationKey", vec![filter("citationKey", key, &format!("@{key}"), "is")], cut(text, at, start + key.len())));
    }
    None
}

/// Identifiers: DOI, arXiv, PMID, PMCID, ISBN, then any other link. At most one.
fn identifier(query: &str) -> Option<Detection> {
    if let Some(key) = citation_key(query) {
        return Some(key);
    }
    let text = replace_escaped_slash(query);
    let text = text.as_str();
    let doi = read_doi(text);
    // An arXiv DOI is better found by its arXiv id (that is how preprints are stored).
    if let Some(d) = doi.filter(|d| !d.doi.starts_with("10.48550/arxiv.")) {
        return Some(detection("doi", vec![filter("doi", &d.doi, &d.doi, "is")], cut(text, d.start, d.end)));
    }
    // arXiv
    for at in char_starts(text) {
        let mut id_at = None;
        if starts_ci(text, at, "arxiv:") && boundary_before(text, at) {
            id_at = Some(skip_ws(text, at + 6));
        }
        for prefix in ["https://www.arxiv.org/", "http://www.arxiv.org/", "https://arxiv.org/", "http://arxiv.org/"] {
            if id_at.is_none() && starts_ci(text, at, prefix) {
                for kind in ["abs/", "pdf/"] {
                    if starts_ci(text, at + prefix.len(), kind) {
                        id_at = Some(at + prefix.len() + 4);
                    }
                }
            }
        }
        if id_at.is_none() && starts_ci(text, at, "10.48550/arxiv.") && boundary_before(text, at) {
            id_at = Some(at + 15);
        }
        if let Some((start, (id_end, end))) = id_at.and_then(|i| arxiv_id(text, i).map(|r| (i, r))) {
            let id = &text[start..id_end];
            return Some(detection("arxiv", vec![filter("arxiv", &id.to_lowercase(), id, "is")], cut(text, at, end)));
        }
    }
    let trimmed = text.trim();
    if count_digits(trimmed, 0) == 4 && trimmed.as_bytes().get(4) == Some(&b'.') && (4..=5).contains(&count_digits(trimmed, 5)) {
        let id_end = 5 + count_digits(trimmed, 5);
        let rest = &trimmed[id_end..];
        if rest.is_empty() || (rest.starts_with('v') && rest.len() > 1 && rest[1..].bytes().all(|b| b.is_ascii_digit())) {
            let id = &trimmed[..id_end];
            let start = text.find(trimmed).unwrap_or(0);
            return Some(detection("arxiv", vec![filter("arxiv", &id.to_lowercase(), id, "is")], cut(text, start, start + trimmed.len())));
        }
    }
    // PMCID
    for at in char_starts(text) {
        if !boundary_before(text, at) {
            continue;
        }
        let mut id_at = at;
        if starts_ci(text, at, "pmcid:") {
            id_at = skip_ws(text, at + 6);
        }
        if starts_ci(text, id_at, "pmc") {
            let digits = count_digits(text, id_at + 3);
            if (4..=9).contains(&digits) && !next_char(text, id_at + 3 + digits).is_some_and(is_word) {
                let id = text[id_at..id_at + 3 + digits].to_uppercase();
                return Some(detection("pmcid", vec![filter("pmcid", &id, &id, "is")], cut(text, at, id_at + 3 + digits)));
            }
        }
    }
    // PMID: labelled, or a PubMed link.
    let pmid = char_starts(text)
        .find_map(|at| {
            if !starts_ci(text, at, "pmid") || !boundary_before(text, at) {
                return None;
            }
            let mut i = at + 4;
            if text[i..].starts_with(':') {
                i += 1;
            }
            i = skip_ws(text, i);
            let digits = count_digits(text, i);
            (digits >= 1 && digits <= 9 && !next_char(text, i + digits).is_some_and(is_word)).then(|| (at, i, i + digits))
        })
        .or_else(|| {
            char_starts(text).find_map(|at| {
                let prefixes = [
                    "https://pubmed.ncbi.nlm.nih.gov/",
                    "http://pubmed.ncbi.nlm.nih.gov/",
                    "https://www.ncbi.nlm.nih.gov/pubmed/",
                    "http://www.ncbi.nlm.nih.gov/pubmed/",
                    "https://ncbi.nlm.nih.gov/pubmed/",
                    "http://ncbi.nlm.nih.gov/pubmed/",
                ];
                let prefix = prefixes.iter().find(|p| starts_ci(text, at, p))?;
                let i = at + prefix.len();
                let digits = count_digits(text, i).min(9);
                if digits == 0 {
                    return None;
                }
                let end = if text[i + digits..].starts_with('/') { i + digits + 1 } else { i + digits };
                Some((at, i, end))
            })
        });
    if let Some((start, digits_at, end)) = pmid {
        let digits = count_digits(text, digits_at).min(9);
        let id = &text[digits_at..digits_at + digits];
        return Some(detection("pmid", vec![filter("pmid", id, id, "is")], cut(text, start, end)));
    }
    // ISBN: labelled, or a number that checks out as one (13 digits from 978/979, or 10).
    if let Some((whole_start, group_start, group_end, labelled)) = labelled_isbn(text).or_else(|| bare_isbn(text)) {
        let group = &text[group_start..group_end];
        let digits: String = group.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_uppercase();
        if isbn_valid(&digits) && (labelled || digits.len() == 13 || group.contains('-')) {
            return Some(detection("isbn", vec![filter("isbn", &digits, &digits, "is")], cut(text, whole_start, group_end)));
        }
    }
    // A bare PMID: a whole query of 6 to 9 digits (shorter ones are years, counts, pages).
    let bare = text.trim();
    if (6..=9).contains(&bare.len()) && bare.bytes().all(|b| b.is_ascii_digit()) {
        return Some(detection("pmid", vec![filter("pmid", bare, bare, "is")], String::new()));
    }
    // Any other link.
    for at in char_starts(text) {
        if !(starts_ci(text, at, "http://") || starts_ci(text, at, "https://") || starts_ci(text, at, "www.")) || !boundary_before(text, at) {
            continue;
        }
        let len: usize = text[at..].chars().take_while(|c| !c.is_whitespace() && !"<>\"".contains(*c)).map(char::len_utf8).sum();
        let link = trim_tail(&text[at..at + len]);
        let mut value = link;
        for scheme in ["https://", "http://"] {
            if starts_ci(value, 0, scheme) {
                value = &value[scheme.len()..];
            }
        }
        if starts_ci(value, 0, "www.") {
            value = &value[4..];
        }
        let value = value.trim_end_matches(['/', '#', '?']);
        if value.contains('.') {
            return Some(detection("url", vec![filter("url", value, value, "contains")], cut(text, at, at + link.len())));
        }
        return None;
    }
    None
}

/// "isbn 978-…": (match start, number start, number end, labelled).
fn labelled_isbn(text: &str) -> Option<(usize, usize, usize, bool)> {
    let is_mid = |c: char| c.is_ascii_digit() || c.is_whitespace() || c == '-';
    let is_end = |c: char| c.is_ascii_digit() || c == 'X' || c == 'x';
    for at in char_starts(text) {
        if !starts_ci(text, at, "isbn") || !boundary_before(text, at) {
            continue;
        }
        let mut i = at + 4;
        if text[i..].starts_with("-10") || text[i..].starts_with("-13") {
            i += 3;
        }
        if text[i..].starts_with(':') {
            i += 1;
        }
        i = skip_ws(text, i);
        if !next_char(text, i).is_some_and(is_end) {
            continue;
        }
        let chars: Vec<(usize, char)> = text[i + 1..].char_indices().map(|(k, c)| (i + 1 + k, c)).take(17).collect();
        for middle in (8..=16).rev() {
            if chars.len() <= middle || !chars[..middle].iter().all(|(_, c)| is_mid(*c)) {
                continue;
            }
            let (last_at, last) = chars[middle];
            if is_end(last) && !next_char(text, last_at + 1).is_some_and(is_word) {
                return Some((at, i, last_at + 1, true));
            }
        }
    }
    None
}

/// A number that may be an ISBN, not inside a longer number.
fn bare_isbn(text: &str) -> Option<(usize, usize, usize, bool)> {
    let b = text.as_bytes();
    let dash_digit = |c: u8| c.is_ascii_digit() || c == b'-';
    for at in 0..b.len() {
        if !b[at].is_ascii_digit() || (at > 0 && dash_digit(b[at - 1])) {
            continue;
        }
        let free_after = |end: usize| !b.get(end).is_some_and(|&c| dash_digit(c));
        // 97[89] then 10–14 digits or dashes, then a digit.
        if b[at..].starts_with(b"978") || b[at..].starts_with(b"979") {
            for middle in (10..=14).rev() {
                let end = at + 3 + middle + 1;
                if end <= b.len() && b[at + 3..at + 3 + middle].iter().all(|&c| dash_digit(c)) && b[end - 1].is_ascii_digit() && free_after(end) {
                    return Some((at, at, end, false));
                }
            }
        }
        for middle in (8..=11).rev() {
            let end = at + 1 + middle + 1;
            if end <= b.len() && b[at + 1..at + 1 + middle].iter().all(|&c| dash_digit(c)) && (b[end - 1].is_ascii_digit() || b[end - 1] == b'X' || b[end - 1] == b'x') && free_after(end) {
                return Some((at, at, end, false));
            }
        }
    }
    None
}

// ── Years ────────────────────────────────────────────────────────────────────

fn year_digits(text: &str, at: usize) -> Option<i64> {
    (count_digits(text, at) >= 4).then(|| text[at..at + 4].parse().ok()).flatten()
}

/// Not part of a longer number, date or path: `[\d./-]` on neither side.
fn free(c: Option<char>) -> bool {
    !c.is_some_and(|c| c.is_ascii_digit() || ".-/".contains(c))
}

/// Years: "2015-2020", ">2018", ">= 2018", "since 2020", "before 2010", "2019".
fn years(text: &str) -> Option<Detection> {
    for at in char_starts(text) {
        if !free(prev_char(text, at)) {
            continue;
        }
        let Some(from) = year_digits(text, at) else { continue };
        let mut i = skip_ws(text, at + 4);
        let separator = ["-", "–", "—", "to", "until"].iter().find(|s| starts_ci(text, i, s));
        let Some(separator) = separator else { continue };
        i = skip_ws(text, i + separator.len());
        let Some(to) = year_digits(text, i) else { continue };
        if !free(next_char(text, i + 4)) {
            continue;
        }
        let (from, to) = (from.min(to), from.max(to));
        if is_year(from) && is_year(to) && from != to {
            return Some(detection(
                "years",
                vec![filter("year", &from.to_string(), &format!("{from} or later"), "gte"), filter("year", &to.to_string(), &format!("{to} or earlier"), "lte")],
                cut(text, at, i + 4),
            ));
        }
        break;
    }
    const WORDS: &[&str] = &[">=", "<=", ">", "<", "≥", "≤", "since", "from", "after", "before", "until", "till", "up to", "in or after", "in or before"];
    for at in char_starts(text) {
        let word_at = if at == 0 && !text.starts_with(char::is_whitespace) {
            0
        } else if next_char(text, at).is_some_and(char::is_whitespace) {
            at + next_char(text, at).map(char::len_utf8).unwrap_or(1)
        } else {
            continue;
        };
        let found = WORDS.iter().find_map(|w| {
            if !starts_ci(text, word_at, w) {
                return None;
            }
            let digits_at = skip_ws(text, word_at + w.len());
            let year = year_digits(text, digits_at)?;
            free(next_char(text, digits_at + 4)).then_some((w, year, digits_at + 4))
        });
        let Some((word, year, end)) = found else { continue };
        if !is_year(year) {
            break;
        }
        let word = word.to_lowercase();
        let (op, value, label) = match word.as_str() {
            ">" | "after" => ("gte", year + 1, format!("{} or later", year + 1)),
            "<" | "before" => ("lte", year - 1, format!("{} or earlier", year - 1)),
            ">=" | "≥" | "since" | "from" | "in or after" => ("gte", year, format!("{year} or later")),
            _ => ("lte", year, format!("{year} or earlier")),
        };
        return Some(detection("years", vec![filter("year", &value.to_string(), &label, op)], cut(text, word_at, end)));
    }
    for at in char_starts(text) {
        if !free(prev_char(text, at)) || count_digits(text, at) < 4 || !free(next_char(text, at + 4)) {
            continue;
        }
        let year: i64 = text[at..at + 4].parse().unwrap_or(0);
        // A year alone is the store's own suggestion; within words it is a reading.
        if is_year(year) && text.trim() != &text[at..at + 4] {
            return Some(detection("year", vec![filter("year", &text[at..at + 4], &text[at..at + 4], "is")], cut(text, at, at + 4)));
        }
        return None;
    }
    None
}

// ── Citations ────────────────────────────────────────────────────────────────

/// Ends of a capitalised word (`[\p{Lu}][\p{L}'’-]+`) at `at`, longest first.
fn word_ends(text: &str, at: usize) -> Vec<usize> {
    let mut chars = text[at..].char_indices();
    match chars.next() {
        Some((_, c)) if c.is_uppercase() => {}
        _ => return vec![],
    }
    let mut ends = Vec::new();
    for (k, c) in chars {
        if c.is_alphabetic() || "'’-".contains(c) {
            ends.push(at + k + c.len_utf8());
        } else {
            break;
        }
    }
    ends.reverse();
    ends
}

/// Ends of a name: a word, or two with an optional particle ("de Vries"), in the order a
/// backtracking match would try them.
fn name_ends(text: &str, at: usize) -> Vec<usize> {
    let mut out = Vec::new();
    for first in word_ends(text, at) {
        if next_char(text, first).is_some_and(|c| c == ' ' || c == '-') {
            let after = first + 1;
            let mut starts = Vec::new();
            for particle in ["van", "von", "de", "der", "den", "da", "di", "le", "la"] {
                if text[after..].starts_with(particle) {
                    let p = after + particle.len();
                    if next_char(text, p).is_some_and(|c| c == ' ' || c == '-') {
                        starts.push(p + 1);
                    }
                    starts.push(p);
                }
            }
            if next_char(text, after).is_some_and(|c| c == ' ' || c == '-') {
                starts.push(after + 1);
            }
            starts.push(after);
            for start in starts {
                out.extend(word_ends(text, start));
            }
        }
        out.push(first);
    }
    out
}

/// `,?\s+\(?(\d{4})[a-z]?\)?\s*$` at `at`: the year.
fn citation_tail(text: &str, mut at: usize) -> Option<String> {
    if text[at..].starts_with(',') {
        at += 1;
    }
    let ws = skip_ws(text, at);
    if ws == at {
        return None;
    }
    at = ws;
    if text[at..].starts_with('(') {
        at += 1;
    }
    if count_digits(text, at) < 4 {
        return None;
    }
    let year = text[at..at + 4].to_string();
    at += 4;
    if text.as_bytes().get(at).is_some_and(u8::is_ascii_lowercase) {
        at += 1;
    }
    if text[at..].starts_with(')') {
        at += 1;
    }
    (skip_ws(text, at) == text.len()).then_some(year)
}

/// "Smith 2020", "Smith et al. 2020", "Smith and Jones (2019)", "Smith & Jones, 2019a".
fn citation(text: &str) -> Option<Detection> {
    let start = skip_ws(text, 0);
    let mut found: Option<(String, Option<String>, String)> = None;
    'names: for end in name_ends(text, start) {
        // "et al."
        let ws = skip_ws(text, end);
        if ws > end && text[ws..].starts_with("et") {
            let al = skip_ws(text, ws + 2);
            if al > ws + 2 && text[al..].starts_with("al") {
                let after = if text[al + 2..].starts_with('.') { al + 3 } else { al + 2 };
                if let Some(year) = citation_tail(text, after) {
                    found = Some((text[start..end].into(), None, year));
                    break 'names;
                }
            }
        }
        // "and" / "&" and a second name.
        if ws > end {
            for joiner in ["and", "&"] {
                if text[ws..].starts_with(joiner) {
                    let second = skip_ws(text, ws + joiner.len());
                    if second > ws + joiner.len() {
                        for second_end in name_ends(text, second) {
                            if let Some(year) = citation_tail(text, second_end) {
                                found = Some((text[start..end].into(), Some(text[second..second_end].into()), year));
                                break 'names;
                            }
                        }
                    }
                }
            }
        }
        if let Some(year) = citation_tail(text, end) {
            found = Some((text[start..end].into(), None, year));
            break;
        }
    }
    let (first, second, year) = found?;
    if !is_year(year.parse().unwrap_or(0)) || STOP.contains(&first.to_lowercase().as_str()) || kind_word_entry(&first).is_some() {
        return None;
    }
    let mut filters: Vec<QueryFilter> = std::iter::once(first).chain(second).map(|name| filter("creator", &name, &name, "contains")).collect();
    filters.push(filter("year", &year, &year, "is"));
    Some(detection("citation", filters, String::new()))
}

/// Words a query starts with that are not names.
const STOP: &[&str] = &[
    "since", "from", "after", "before", "until", "in", "the", "a", "an", "of", "on", "for", "and", "or", "about", "year", "published", "papers", "paper", "articles", "article", "review",
    "reviews", "covid", "data",
];

/// "a phrase in quotes": the exact title.
fn quoted(text: &str) -> Option<Detection> {
    let excluded = |c: char| "\"“”„«»".contains(c);
    for (at, open) in text.char_indices() {
        if !"\"“„«".contains(open) {
            continue;
        }
        let inner = at + open.len_utf8();
        let run: usize = text[inner..].chars().take_while(|c| !excluded(*c)).map(char::len_utf8).sum();
        let count = text[inner..inner + run].chars().count();
        match next_char(text, inner + run) {
            Some(close) if count >= 3 && "\"”«»".contains(close) => {
                let title = text[inner..inner + run].trim();
                return Some(detection("title", vec![filter("title", title, title, "is")], cut(text, at, inner + run + close.len_utf8())));
            }
            _ => continue,
        }
    }
    None
}

// ── Kinds and names ──────────────────────────────────────────────────────────

/// A word naming a kind of item: the library kind (with its label), or the search tab's kind.
fn kind_word_entry(word: &str) -> Option<(Option<(&'static str, &'static str)>, Option<&'static str>)> {
    let w = word.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    match w.as_str() {
        "pdf" | "pdfs" => Some((Some(("pdf", "PDF")), None)),
        "web page" | "web pages" | "webpage" | "webpages" | "website" | "websites" => Some((Some(("web", "Web page")), None)),
        "notes" => Some((None, Some("note"))),
        "highlights" => Some((None, Some("highlight"))),
        "canvas" | "canvases" => Some((None, Some("canvas"))),
        _ => None,
    }
}

/// The kind word at `at` (followed by a space or the end): its end.
fn kind_word_at(text: &str, at: usize) -> Option<usize> {
    let ends_ok = |end: usize| next_char(text, end).is_none_or(char::is_whitespace);
    let try_word = |word: &str, plural: bool| -> Option<usize> {
        if !starts_ci(text, at, word) {
            return None;
        }
        let end = at + word.len();
        if plural && starts_ci(text, end, "s") && ends_ok(end + 1) {
            return Some(end + 1);
        }
        ends_ok(end).then_some(end)
    };
    // "web\s+pages?"
    if starts_ci(text, at, "web") {
        let p = skip_ws(text, at + 3);
        if p > at + 3 && starts_ci(text, p, "page") {
            let end = p + 4;
            if starts_ci(text, end, "s") && ends_ok(end + 1) {
                return Some(end + 1);
            }
            if ends_ok(end) {
                return Some(end);
            }
        }
    }
    try_word("webpage", true)
        .or_else(|| try_word("website", true))
        .or_else(|| try_word("pdf", true))
        .or_else(|| try_word("notes", false))
        .or_else(|| try_word("highlights", false))
        .or_else(|| {
            if starts_ci(text, at, "canvases") && ends_ok(at + 8) {
                Some(at + 8)
            } else {
                try_word("canvas", false)
            }
        })
}

fn kind_word(text: &str, kinds: bool) -> Option<Detection> {
    for at in char_starts(text) {
        if !(at == 0 || prev_char(text, at).is_some_and(char::is_whitespace)) {
            continue;
        }
        let Some(end) = kind_word_at(text, at) else { continue };
        let Some((kind, find)) = kind_word_entry(&text[at..end]) else { continue };
        let rest = cut(text, at, end);
        if let Some((kind, label)) = kind {
            return Some(detection("kind", vec![filter("kind", kind, label, "is")], rest));
        }
        if let Some(find) = find.filter(|_| kinds) {
            return Some(Detection { id: "kind", filters: vec![], kinds: Some(vec![find]), rest, add: None });
        }
    }
    None
}

/// A tag ("#review" or its name) or a collection named in the query.
fn known_name(text: &str, known: Option<&KnownNames>) -> Option<Detection> {
    let known = known?;
    let lower = lower_same_layout(text);
    let find = |name: &str| -> Option<usize> {
        let n = name.trim().to_lowercase();
        if n.encode_utf16().count() < 3 {
            return None;
        }
        let mut from = 0;
        while let Some(found) = lower[from..].find(&n) {
            let at = from + found;
            let before = prev_char(&lower, at);
            let after = next_char(&lower, at + n.len());
            if before.is_none_or(|c| c.is_whitespace() || c == '#') && after.is_none_or(char::is_whitespace) {
                return Some(if before == Some('#') { at - 1 } else { at });
            }
            from = at + lower[at..].chars().next().map(char::len_utf8).unwrap_or(1);
        }
        None
    };
    // Whole-query names are already the store's suggestions; only names within a longer query.
    let whole = lower.trim();
    let within = |name: &str| {
        let n = name.trim().to_lowercase();
        whole != n && whole != format!("#{n}")
    };
    let mut tags: Vec<&String> = known.tags.iter().collect();
    tags.sort_by_key(|t| std::cmp::Reverse(t.encode_utf16().count()));
    let tag = tags.into_iter().find(|t| find(t).is_some());
    let hashed = char_starts(text).find_map(|at| {
        if !text[at..].starts_with('#') || !(at == 0 || prev_char(text, at).is_some_and(char::is_whitespace)) {
            return None;
        }
        let len: usize = text[at + 1..].chars().take_while(|c| c.is_alphabetic() || c.is_ascii_digit() || *c == '_' || *c == '-').map(char::len_utf8).sum();
        (len > 0).then(|| (at, &text[at + 1..at + 1 + len]))
    });
    if let (Some((start, name)), None) = (hashed, tag) {
        return Some(detection("tag", vec![filter("tag", name, name, "is")], cut(text, start, start + name.len() + 1)));
    }
    if let Some(tag) = tag.filter(|t| within(t) || text.trim().starts_with('#')) {
        let at = find(tag)?;
        let length = tag.len() + usize::from(lower[at..].starts_with('#'));
        return Some(detection("tag", vec![filter("tag", tag, tag, "is")], cut(text, at, at + length)));
    }
    let mut collections: Vec<&KnownCollection> = known.collections.iter().collect();
    collections.sort_by_key(|c| std::cmp::Reverse(c.name.encode_utf16().count()));
    let collection = collections.into_iter().find(|c| find(&c.name).is_some())?;
    if !within(&collection.name) {
        return None;
    }
    let at = find(&collection.name)?;
    Some(detection("collection", vec![filter("collection", &collection.id, &collection.name, "is")], cut(text, at, at + collection.name.len())))
}

/// Every reading of `text`, best first. An identifier stands alone; the others can combine.
/// `status:unread|reading|read` and `read:>2026-01-01` (when last read; also `<`, `>=`, `<=`).
fn reading_token(text: &str) -> Option<Detection> {
    if !text.contains(':') {
        return None;
    }
    for at in char_starts(text).filter(|at| boundary_before(text, *at)) {
        for (prefix, field) in [("status:", "status"), ("read:", "read")] {
            if !starts_ci(text, at, prefix) {
                continue;
            }
            let start = at + prefix.len();
            let end = text[start..].find(char::is_whitespace).map_or(text.len(), |n| start + n);
            let raw = &text[start..end];
            if field == "status" {
                let value = match raw.to_lowercase().as_str() {
                    "unread" | "new" => "unread",
                    "reading" | "in-progress" | "progress" | "started" => "reading",
                    "read" | "finished" | "done" => "read",
                    _ => continue,
                };
                let label = match value {
                    "unread" => "Unread",
                    "reading" => "In progress",
                    _ => "Read",
                };
                return Some(detection("status", vec![filter("status", value, label, "is")], cut(text, at, end)));
            }
            let (op, date) = [(">=", "gte"), ("<=", "lte"), (">", "gt"), ("<", "lt")]
                .iter()
                .find_map(|(sign, op)| raw.strip_prefix(sign).map(|d| (*op, d)))
                .unwrap_or(("gte", raw));
            if crate::reading::date_ms(date).is_none() {
                continue;
            }
            let label = match op {
                "gt" | "gte" => format!("Read since {date}"),
                _ => format!("Last read before {date}"),
            };
            return Some(detection("read", vec![filter("read", date, &label, op)], cut(text, at, end)));
        }
    }
    None
}

pub fn detect_query(text: &str, kinds: bool, known: Option<&KnownNames>) -> Vec<Detection> {
    let query = text.trim();
    if query.encode_utf16().count() < 3 {
        return vec![];
    }
    if let Some(mut id) = identifier(query) {
        if id.rest.trim().is_empty() {
            id.add = addable(&id);
        }
        return vec![id];
    }
    // A reading token is taken out first; the rest reads as usual, with it.
    if let Some(token) = reading_token(query) {
        let mut out = vec![token.clone()];
        for mut found in detect_query(&token.rest, kinds, known) {
            found.filters.splice(0..0, token.filters.clone());
            found.add = None;
            out.push(found);
        }
        return out;
    }
    let readers: [&dyn Fn(&str) -> Option<Detection>; 4] = [&quoted, &years, &|t| kind_word(t, kinds), &|t| known_name(t, known)];
    let mut out = Vec::new();
    let cite = citation(query);
    if let Some(c) = &cite {
        out.push(c.clone());
    }
    for (i, read) in readers.iter().enumerate() {
        if cite.is_some() && i == 1 {
            continue;
        }
        if let Some(found) = read(query) {
            out.push(found);
        }
    }
    // Several readings: also all at once ("pdf since 2020 malaria" → PDF, 2020 or later, "malaria").
    if out.len() > 1 && cite.is_none() {
        let mut rest = query.to_string();
        let mut all = Detection { id: "all", filters: vec![], kinds: None, rest: String::new(), add: None };
        for read in readers {
            let Some(found) = read(&rest) else { continue };
            all.filters.extend(found.filters);
            if let Some(k) = found.kinds {
                all.kinds.get_or_insert_with(Vec::new).extend(k);
            }
            rest = found.rest;
        }
        all.rest = rest;
        if all.filters.len() + all.kinds.as_ref().map_or(0, Vec::len) > 1 {
            out.insert(0, all);
        }
    }
    out
}

impl Store {
    /// The tag and collection names a query can name.
    pub fn known_names(&self) -> Result<KnownNames> {
        let db = self.read()?;
        let mut statement = db.prepare("SELECT DISTINCT t.value FROM sources s, json_each(s.tags) t WHERE s.trashed_at IS NULL AND s.tags <> '[]'").map_err(e)?;
        let tags = statement.query_map([], |r| r.get::<_, String>(0)).map_err(e)?.filter_map(|r| r.ok()).collect();
        let mut statement = db.prepare("SELECT id, name FROM collections").map_err(e)?;
        let collections = statement.query_map([], |r| Ok(KnownCollection { id: r.get(0)?, name: r.get(1)? })).map_err(e)?.filter_map(|r| r.ok()).collect();
        Ok(KnownNames { tags, collections })
    }

    /// The readings of a search query, with the workspace's own tag and collection names.
    pub fn parse_query(&self, text: &str, kinds: bool) -> Result<Vec<Detection>> {
        if text.trim().encode_utf16().count() < 3 {
            return Ok(vec![]);
        }
        let known = self.known_names()?;
        Ok(detect_query(text, kinds, Some(&known)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brief(d: &Detection) -> (String, Vec<String>, Option<Vec<&'static str>>, String) {
        let filters = d.filters.iter().map(|f| format!("{}{}{}", f.field, if f.op == "is" { "=".to_string() } else { format!(" {} ", f.op) }, f.value)).collect();
        (d.id.to_string(), filters, d.kinds.clone(), d.rest.clone())
    }
    fn first_with(text: &str, kinds: bool, known: Option<&KnownNames>) -> Option<(String, Vec<String>, Option<Vec<&'static str>>, String)> {
        detect_query(text, kinds, known).first().map(brief)
    }
    fn first(text: &str) -> Option<(String, Vec<String>, Option<Vec<&'static str>>, String)> {
        first_with(text, false, None)
    }
    fn filters(text: &str) -> Vec<String> {
        first(text).map(|d| d.1).unwrap_or_default()
    }
    fn one(id: &str, filters: &[&str], rest: &str) -> Option<(String, Vec<String>, Option<Vec<&'static str>>, String)> {
        Some((id.into(), filters.iter().map(|s| s.to_string()).collect(), None, rest.into()))
    }

    #[test]
    fn reads_citation_keys() {
        let found = detect_query("@smith2020a", false, None);
        assert_eq!(found[0].id, "citationKey");
        assert_eq!(found[0].filters[0].value, "smith2020a");
        let found = detect_query("malaria key:doe:2019", false, None);
        assert_eq!(found[0].filters[0].value, "doe:2019");
        assert_eq!(found[0].rest.trim(), "malaria");
        assert!(detect_query("mail me@example.org", false, None).iter().all(|d| d.id != "citationKey"));
    }

    #[test]
    fn reads_a_pasted_doi_however_it_is_written() {
        for text in [
            "10.1038/s41591-021-01384-9",
            "doi:10.1038/S41591-021-01384-9",
            "https://doi.org/10.1038/s41591-021-01384-9.",
            "DOI 10.1038/s41591-021-01384-9",
            "https://dx.doi.org/10.1038%2Fs41591-021-01384-9",
        ] {
            assert_eq!(first(text), one("doi", &["doi=10.1038/s41591-021-01384-9"], ""), "{text}");
        }
        assert_eq!(read_doi("(see doi:10.1016/S0140-6736(20)30183-5)").unwrap().doi, "10.1016/s0140-6736(20)30183-5");
        assert_eq!(first("malaria 10.1000/abc").unwrap().3, "malaria");
        assert_eq!(first("see https://doi.org/10.5555/Interaction.2022.").unwrap().3, "see");
    }

    #[test]
    fn offers_to_add_a_lone_identifier_and_reads_pasted_lists() {
        let add = |t: &str| detect_query(t, false, None).first().and_then(|d| d.add.clone()).map(|i| format!("{}={}", i.kind, i.value));
        assert_eq!(add("https://doi.org/10.1038/S41591-021-01384-9").as_deref(), Some("doi=10.1038/s41591-021-01384-9"));
        assert_eq!(add("ISBN 978-0-262-03384-8").as_deref(), Some("isbn=9780262033848"));
        assert_eq!(add("PMID: 33599681").as_deref(), Some("pmid=33599681"));
        assert_eq!(add("malaria 10.1038/s41591-021-01384-9"), None);
        let list = read_identifiers("10.1234/abc\narXiv:1706.03762, PMC8190434; PMID 33599681 PMID 12345\n978 0 262 03384 8\nnot an id\n\n");
        let got: Vec<String> = list.iter().map(|p| p.identifier.as_ref().map_or(format!("? {}", p.text), |i| format!("{}={}", i.kind, i.value))).collect();
        assert_eq!(got, ["doi=10.1234/abc", "arxiv=1706.03762", "pmcid=PMC8190434", "pmid=33599681", "pmid=12345", "isbn=9780262033848", "? not an id"]);
    }

    #[test]
    fn reads_arxiv_pubmed_and_isbn_identifiers_and_links() {
        assert_eq!(filters("arXiv:1706.03762v7"), ["arxiv=1706.03762"]);
        assert_eq!(filters("https://arxiv.org/abs/2101.00001"), ["arxiv=2101.00001"]);
        assert_eq!(filters("1706.03762"), ["arxiv=1706.03762"]);
        assert_eq!(filters("10.48550/arXiv.1706.03762"), ["arxiv=1706.03762"]);
        assert_eq!(filters("PMID: 33599681"), ["pmid=33599681"]);
        assert_eq!(filters("https://pubmed.ncbi.nlm.nih.gov/33599681/"), ["pmid=33599681"]);
        assert_eq!(filters("33599681"), ["pmid=33599681"]);
        assert_eq!(filters("pmc8190434"), ["pmcid=PMC8190434"]);
        assert_eq!(filters("ISBN 978-0-262-03384-8"), ["isbn=9780262033848"]);
        assert_eq!(filters("9780262033848"), ["isbn=9780262033848"]);
        assert_eq!(filters("isbn 0-262-03384-4"), ["isbn=0262033844"]);
        // A number that fails the ISBN checksum is not one.
        assert_ne!(first("9780262033849").map(|d| d.0), Some("isbn".into()));
        assert_eq!(first("https://www.nature.com/articles/s41591-021/"), one("url", &["url contains nature.com/articles/s41591-021"], ""));
    }

    #[test]
    fn reads_years_and_ranges_of_years() {
        assert_eq!(filters("2015-2020"), ["year gte 2015", "year lte 2020"]);
        assert_eq!(first("malaria 2020–2015"), one("years", &["year gte 2015", "year lte 2020"], "malaria"));
        assert_eq!(filters(">2018"), ["year gte 2019"]);
        assert_eq!(filters(">= 2018 trials"), ["year gte 2018"]);
        assert_eq!(first("since 2020"), one("years", &["year gte 2020"], ""));
        assert_eq!(first("vaccines before 2010"), one("years", &["year lte 2009"], "vaccines"));
        assert_eq!(first("malaria 2019"), one("year", &["year=2019"], "malaria"));
        let read = detect_query("status:reading malaria", false, None);
        assert_eq!((read[0].id, read[0].filters[0].value.as_str(), read[0].rest.as_str()), ("status", "reading", "malaria"));
        let since = detect_query("read:>2026-01-01", false, None);
        assert_eq!((since[0].filters[0].op.as_str(), since[0].filters[0].value.as_str()), ("gt", "2026-01-01"));
        // A year alone is the store's suggestion already; other numbers are not years.
        assert!(detect_query("2019", false, None).is_empty());
        assert_eq!(first("cohort of 3000 patients"), None);
    }

    #[test]
    fn reads_citations_as_author_and_year() {
        assert_eq!(first("Narang 2021"), one("citation", &["creator contains Narang", "year=2021"], ""));
        assert_eq!(filters("Narang et al. 2021"), ["creator contains Narang", "year=2021"]);
        assert_eq!(filters("Narang et al., (2021)"), ["creator contains Narang", "year=2021"]);
        assert_eq!(filters("Smith and Jones 2019a"), ["creator contains Smith", "creator contains Jones", "year=2019"]);
        assert_eq!(filters("Van der Berg 2020"), ["creator contains Van der Berg", "year=2020"]);
        assert_ne!(first("van der Berg 2020").map(|d| d.0), Some("citation".into()));
        assert_eq!(first("Since 2020").unwrap().0, "years");
        assert_eq!(first("malaria 2019").unwrap().0, "year");
    }

    #[test]
    fn reads_a_quoted_phrase_as_the_exact_title() {
        assert_eq!(first("\"Attention is all you need\""), one("title", &["title=Attention is all you need"], ""));
        assert_eq!(first("“Deep learning” review").unwrap().3, "review");
    }

    #[test]
    fn reads_kinds_of_items() {
        assert_eq!(first("malaria pdfs"), one("kind", &["kind=pdf"], "malaria"));
        assert_eq!(first("web pages about falls"), one("kind", &["kind=web"], "about falls"));
        assert_eq!(first("notes on falls"), None);
        assert_eq!(first_with("notes on falls", true, None), Some(("kind".into(), vec![], Some(vec!["note"]), "on falls".into())));
    }

    #[test]
    fn names_tags_and_collections_within_a_longer_query() {
        let known = KnownNames { tags: vec!["to read".into(), "review".into()], collections: vec![KnownCollection { id: "c1".into(), name: "Falls project".into() }] };
        let k = Some(&known);
        assert_eq!(first_with("to read malaria", false, k), one("tag", &["tag=to read"], "malaria"));
        assert_eq!(first_with("#review sepsis", false, k).unwrap().1, ["tag=review"]);
        assert_eq!(first_with("#unknown sepsis", false, k).unwrap().1, ["tag=unknown"]);
        assert_eq!(first_with("Falls project video", false, k), one("collection", &["collection=c1"], "video"));
        // The whole query as a name is already the store's suggestion; part of a word is no name.
        assert!(detect_query("review", false, k).is_empty());
        assert_eq!(first_with("reviewers agree", false, k), None);
    }

    #[test]
    fn offers_every_reading_at_once_when_there_are_several() {
        let all = detect_query("pdf since 2020 malaria", false, None);
        assert_eq!(Some(brief(&all[0])), one("all", &["year gte 2020", "kind=pdf"], "malaria"));
        assert_eq!(all[1..].iter().map(|d| d.id).collect::<Vec<_>>(), ["years", "kind"]);
    }

    #[test]
    fn leaves_plain_text_alone() {
        for text in ["deep learning", "falls in memory care", "ab", "covid 19 vaccines", "Ünïcödé — façade ✓ 日本語"] {
            assert!(detect_query(text, true, None).is_empty(), "{text}");
        }
    }

    #[test]
    fn never_panics_on_odd_input() {
        let known = KnownNames { tags: vec!["İstanbul".into(), "ß-tag".into()], collections: vec![] };
        for text in ["İstanbul 2020 x", "10.", "doi:", "\"ab\"", "isbn", "#", "“", "web  ", "pmc", "arxiv:", "10.1234/", "1999-", "Ⅻ 2020"] {
            let _ = detect_query(text, true, Some(&known));
        }
    }

    #[test]
    fn is_fast() {
        let known = KnownNames { tags: (0..5000).map(|i| format!("topic number {i}")).collect(), collections: vec![] };
        let start = std::time::Instant::now();
        for _ in 0..100 {
            detect_query("pdf since 2020 malaria topic number 4999", true, Some(&known));
        }
        assert!(start.elapsed().as_millis() < 2000, "{:?}", start.elapsed());
    }
}
