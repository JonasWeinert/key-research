// The Boolean search tree: nested AND/OR groups of terms, each item optionally negated. This is
// the one definition the builder, the text mode, the planner, the local evaluation and the
// exported strategy share. Text syntax (parse/format round-trip):
//
//   (health OR doctor) AND ((AI OR ML) NOT regression)
//   title:"machine learning" OR abstract:(deep learning) OR vaccin* OR "hand washing"~3
//   mesh:"Health Personnel" AND year:2015-2024 AND type:review AND lang:en
//
// AND binds tighter than OR; NOT between two items means AND NOT; adjacent words are one term
// (all of its words). Operators are read in any case; quote a word to search for "and" itself.
use crate::query::{self, Term};
use crate::record::Record;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    #[default]
    And,
    Or,
}

impl Op {
    pub fn word(self) -> &'static str {
        match self {
            Op::And => "AND",
            Op::Or => "OR",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Node {
    Term {
        #[serde(flatten)]
        term: Term,
        #[serde(default, skip_serializing_if = "is_false")]
        not: bool,
    },
    #[serde(rename_all = "camelCase")]
    Group {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default)]
        op: Op,
        #[serde(default)]
        items: Vec<Node>,
        #[serde(default, skip_serializing_if = "is_false")]
        not: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl Default for Node {
    fn default() -> Self {
        Node::group(Op::And, Vec::new())
    }
}

impl Node {
    pub fn group(op: Op, items: Vec<Node>) -> Node {
        Node::Group { id: None, op, items, not: false, label: None }
    }

    pub fn term(term: Term) -> Node {
        Node::Term { term, not: false }
    }

    pub fn is_not(&self) -> bool {
        match self {
            Node::Term { not, .. } | Node::Group { not, .. } => *not,
        }
    }

    pub fn negated(mut self, value: bool) -> Node {
        match &mut self {
            Node::Term { not, .. } | Node::Group { not, .. } => *not = value,
        }
        self
    }

    pub fn is_empty(&self) -> bool {
        match self {
            Node::Term { term, .. } => term.text.trim().is_empty(),
            Node::Group { items, .. } => items.iter().all(Node::is_empty),
        }
    }

    /// Every term, in reading order.
    pub fn terms(&self) -> Vec<&Term> {
        let mut out = Vec::new();
        fn walk<'a>(n: &'a Node, out: &mut Vec<&'a Term>) {
            match n {
                Node::Term { term, .. } => out.push(term),
                Node::Group { items, .. } => items.iter().for_each(|i| walk(i, out)),
            }
        }
        walk(self, &mut out);
        out
    }

    /// How deep the groups go: a term is 0, a group of terms 1.
    pub fn depth(&self) -> usize {
        match self {
            Node::Term { .. } => 0,
            Node::Group { items, .. } => 1 + items.iter().map(Node::depth).max().unwrap_or(0),
        }
    }

    /// Without empty terms and groups; a group of one item becomes the item; a group inside a
    /// group with the same operator is merged into it.
    pub fn normalized(&self) -> Option<Node> {
        match self {
            Node::Term { term, not } => {
                let text = term.text.trim();
                if text.is_empty() {
                    return None;
                }
                let mut term = term.clone();
                term.text = text.to_string();
                if term.field.is_empty() {
                    term.field = "all".into();
                }
                Some(Node::Term { term, not: *not })
            }
            Node::Group { id, op, items, not, label } => {
                let mut out: Vec<Node> = Vec::new();
                for item in items.iter().filter_map(Node::normalized) {
                    match item {
                        Node::Group { op: inner, items: inner_items, not: false, .. } if inner == *op => out.extend(inner_items),
                        other => out.push(other),
                    }
                }
                match out.len() {
                    0 => None,
                    1 => {
                        let only = out.pop().unwrap();
                        let n = only.is_not() != *not;
                        Some(only.negated(n))
                    }
                    _ => Some(Node::Group { id: id.clone(), op: *op, items: out, not: *not, label: label.clone() }),
                }
            }
        }
    }

    /// Negation pushed down to the terms (De Morgan), so only terms carry NOT.
    pub fn nnf(&self) -> Node {
        fn go(n: &Node, negate: bool) -> Node {
            match n {
                Node::Term { term, not } => Node::Term { term: term.clone(), not: *not != negate },
                Node::Group { id, op, items, not, label } => {
                    let flip = *not != negate;
                    let op = if flip { if *op == Op::And { Op::Or } else { Op::And } } else { *op };
                    Node::Group { id: id.clone(), op, items: items.iter().map(|i| go(i, flip)).collect(), not: false, label: label.clone() }
                }
            }
        }
        go(self, false).normalized().unwrap_or_default()
    }
}

// ── Fields ──

/// Neutral field ids with their text tags (the first tag is the one written out).
pub const FIELDS: &[(&str, &[&str], &str)] = &[
    ("all", &["all", "any", "anywhere"], "Anywhere"),
    ("title", &["title", "ti"], "Title"),
    ("abstract", &["abstract", "ab", "abs"], "Abstract"),
    ("title_abstract", &["tiab", "title-abstract", "titleabstract", "tiabs"], "Title or abstract"),
    ("keywords", &["keywords", "keyword", "kw"], "Keywords"),
    ("subject", &["subject", "mesh", "mh", "su", "heading"], "Subject headings (MeSH)"),
    ("author", &["author", "au"], "Author"),
    ("journal", &["journal", "so", "source", "ta"], "Journal"),
    ("affiliation", &["affiliation", "ad", "aff"], "Affiliation"),
    ("fulltext", &["fulltext", "ft", "text"], "Full text"),
    ("identifier", &["id", "doi", "identifier"], "Identifier"),
    ("year", &["year", "py", "dp"], "Year"),
    ("type", &["type", "pt"], "Document type"),
    ("language", &["lang", "language", "la"], "Language"),
];

pub fn field_of_tag(tag: &str) -> Option<&'static str> {
    let t = tag.trim().to_ascii_lowercase();
    FIELDS.iter().find(|(id, tags, _)| *id == t || tags.contains(&t.as_str())).map(|(id, _, _)| *id)
}

pub fn tag_of_field(field: &str) -> &str {
    FIELDS.iter().find(|(id, _, _)| *id == field).map(|(_, tags, _)| tags[0]).unwrap_or(field)
}

pub fn field_label(field: &str) -> &str {
    FIELDS.iter().find(|(id, _, _)| *id == field).map(|(_, _, l)| *l).unwrap_or(field)
}

// ── Text mode: parse ──

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseError {
    pub message: String,
    /// Character offsets of the problem in the text.
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Parsed {
    pub tree: Node,
    /// Plain-language notes that are not errors (how a mix of AND and OR was read).
    pub notes: Vec<ParseError>,
    /// The tree written back in canonical form.
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Open,
    Close,
    And,
    Or,
    Not,
    Term(Term),
    /// A field tag waiting for what it scopes: `title:(`
    Scope(String),
}

#[derive(Clone, Debug)]
struct Spanned {
    tok: Tok,
    start: usize,
    end: usize,
}

fn err(message: impl Into<String>, start: usize, end: usize) -> ParseError {
    ParseError { message: message.into(), start, end }
}

fn known_tags() -> String {
    "title:, abstract:, tiab:, keywords:, mesh:, author:, journal:, year:, type:, lang:".into()
}

fn is_word_char(c: char) -> bool {
    !c.is_whitespace() && !matches!(c, '(' | ')' | '"' | '[' | '\u{201c}' | '\u{201d}')
}

fn lex(text: &str) -> Result<Vec<Spanned>, ParseError> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<Spanned> = Vec::new();
    let mut i = 0;
    let mut pending_field: Option<(String, usize)> = None;
    // A field tag after a term or group: `[ti]`.
    let suffix = |i: &mut usize| -> Result<Option<String>, ParseError> {
        if *i < chars.len() && chars[*i] == '[' {
            let start = *i;
            let close = chars[*i..].iter().position(|c| *c == ']').map(|p| p + *i).ok_or_else(|| err("This [ is never closed", start, start + 1))?;
            let tag: String = chars[*i + 1..close].iter().collect();
            let tag = tag.split(':').next().unwrap_or("").to_string();
            let field = field_of_tag(&tag).ok_or_else(|| err(format!("Unknown field [{tag}]. Use one of {}", known_tags()), start, close + 1))?;
            *i = close + 1;
            return Ok(Some(field.to_string()));
        }
        Ok(None)
    };
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        if c == '(' {
            if let Some((f, s)) = pending_field.take() {
                out.push(Spanned { tok: Tok::Scope(f), start: s, end: i + 1 });
            }
            out.push(Spanned { tok: Tok::Open, start, end: i + 1 });
            i += 1;
            continue;
        }
        if c == ')' {
            if let Some((_, s)) = pending_field.take() {
                return Err(err("A field tag needs a word, a \"phrase\" or a group after it", s, i));
            }
            i += 1;
            out.push(Spanned { tok: Tok::Close, start, end: i });
            // `(a OR b)[ti]`: scope the group just closed.
            if let Some(f) = suffix(&mut i)? {
                let mut depth = 0;
                let mut at = None;
                for (k, t) in out.iter().enumerate().rev() {
                    match t.tok {
                        Tok::Close => depth += 1,
                        Tok::Open => {
                            depth -= 1;
                            if depth == 0 {
                                at = Some(k);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(k) = at {
                    let s = out[k].start;
                    out.insert(k, Spanned { tok: Tok::Scope(f), start: s, end: s });
                }
            }
            continue;
        }
        if c == '"' || c == '\u{201c}' || c == '\u{201d}' {
            let close = chars[i + 1..].iter().position(|c| matches!(c, '"' | '\u{201c}' | '\u{201d}')).map(|p| p + i + 1).ok_or_else(|| err("This quotation mark is never closed", start, start + 1))?;
            let inner: String = chars[i + 1..close].iter().collect();
            i = close + 1;
            let mut term = Term { text: inner.trim().to_string(), mode: "phrase".into(), ..Default::default() };
            if term.text.ends_with('*') {
                term.text = term.text.trim_end_matches('*').trim().to_string();
                term.truncate = true;
            }
            if i < chars.len() && chars[i] == '*' {
                term.truncate = true;
                i += 1;
            }
            if i < chars.len() && chars[i] == '~' {
                let digits: String = chars[i + 1..].iter().take_while(|c| c.is_ascii_digit()).collect();
                if digits.is_empty() {
                    return Err(err("Put the number of words after ~, for example \"hand washing\"~3", i, i + 1));
                }
                term.proximity = digits.parse().ok();
                i += 1 + digits.len();
            }
            if term.text.is_empty() {
                return Err(err("These quotation marks are empty", start, i));
            }
            if let Some(f) = suffix(&mut i)? {
                term.field = f;
            } else if let Some((f, _)) = pending_field.take() {
                term.field = f;
            }
            let s = out_start(&pending_field, start);
            pending_field = None;
            out.push(Spanned { tok: Tok::Term(term), start: s, end: i });
            continue;
        }
        if c == '[' {
            return Err(err("A field tag in [ ] belongs right after a word, phrase or group", start, start + 1));
        }
        // A word (maybe `tag:word`, `tag:` alone, or an operator).
        let mut j = i;
        while j < chars.len() && is_word_char(chars[j]) {
            j += 1;
        }
        let word: String = chars[i..j].iter().collect();
        i = j;
        if pending_field.is_none() {
            match word.to_ascii_uppercase().as_str() {
                "AND" | "&&" => {
                    out.push(Spanned { tok: Tok::And, start, end: i });
                    continue;
                }
                "OR" | "||" => {
                    out.push(Spanned { tok: Tok::Or, start, end: i });
                    continue;
                }
                "NOT" => {
                    out.push(Spanned { tok: Tok::Not, start, end: i });
                    continue;
                }
                _ => {}
            }
        }
        let (field, body) = match word.find(':') {
            Some(p) if p > 0 && word[..p].chars().all(|c| c.is_ascii_alphabetic() || c == '-') => {
                let tag = &word[..p];
                let field = field_of_tag(tag).ok_or_else(|| err(format!("Unknown field \"{tag}\". Use one of {}", known_tags()), start, start + tag.chars().count() + 1))?;
                (Some(field.to_string()), word[p + 1..].to_string())
            }
            _ => (None, word.clone()),
        };
        if let Some(f) = &field {
            if pending_field.is_some() {
                return Err(err("Two field tags in a row", start, i));
            }
            if body.is_empty() {
                pending_field = Some((f.clone(), start));
                continue;
            }
        }
        let field = field.or_else(|| pending_field.take().map(|(f, _)| f));
        let mut term = Term { text: body.clone(), ..Default::default() };
        if body.ends_with('*') && body.len() > 1 {
            term.text = body.trim_end_matches('*').to_string();
            term.truncate = true;
        }
        if let Some(f) = suffix(&mut i)? {
            term.field = f;
        } else if let Some(f) = field {
            term.field = f;
        }
        out.push(Spanned { tok: Tok::Term(term), start, end: i });
    }
    if let Some((_, s)) = pending_field {
        return Err(err("A field tag needs a word, a \"phrase\" or a group after it", s, chars.len()));
    }
    Ok(merge_words(out))
}

fn out_start(pending: &Option<(String, usize)>, start: usize) -> usize {
    pending.as_ref().map(|(_, s)| *s).unwrap_or(start)
}

/// Adjacent plain words in the same field become one term ("health workers").
fn merge_words(toks: Vec<Spanned>) -> Vec<Spanned> {
    let mut out: Vec<Spanned> = Vec::new();
    for t in toks {
        if let (Some(last), Tok::Term(next)) = (out.last_mut(), &t.tok) {
            if let Tok::Term(prev) = &mut last.tok {
                let plain = |x: &Term| x.mode == "words" && x.proximity.is_none() && !x.truncate;
                if plain(prev) && next.mode == "words" && next.proximity.is_none() && prev.field == next.field {
                    prev.text = format!("{} {}", prev.text, next.text);
                    prev.truncate = next.truncate;
                    last.end = t.end;
                    continue;
                }
            }
        }
        out.push(t);
    }
    out
}

struct P<'a> {
    toks: &'a [Spanned],
    at: usize,
    len: usize,
    notes: Vec<ParseError>,
}

impl P<'_> {
    fn peek(&self) -> Option<&Spanned> {
        self.toks.get(self.at)
    }

    fn op_name(t: &Tok) -> &'static str {
        match t {
            Tok::And => "AND",
            Tok::Or => "OR",
            Tok::Not => "NOT",
            _ => "",
        }
    }

    fn or_expr(&mut self, field: Option<&str>) -> Result<Node, ParseError> {
        let first_at = self.peek().map(|t| t.start).unwrap_or(self.len);
        let mut items = vec![self.and_expr(field)?];
        let mut mixed: Option<(usize, usize)> = None;
        while let Some(t) = self.peek() {
            if t.tok != Tok::Or {
                break;
            }
            let (s, e) = (t.start, t.end);
            self.at += 1;
            self.expect_operand("OR", s, e)?;
            items.push(self.and_expr(field)?);
            if mixed.is_none() && items.iter().any(|i| matches!(i, Node::Group { op: Op::And, not: false, .. }) && !self.was_bracketed(i)) {
                mixed = Some((s, e));
            }
        }
        if let Some((s, e)) = mixed {
            let _ = first_at;
            self.notes.push(err("AND is applied before OR here. Add brackets if you meant something else", s, e));
        }
        Ok(if items.len() == 1 { items.pop().unwrap() } else { Node::group(Op::Or, items) })
    }

    fn was_bracketed(&self, n: &Node) -> bool {
        matches!(n, Node::Group { label: Some(l), .. } if l == "\u{0}bracketed")
    }

    fn expect_operand(&self, op: &str, s: usize, e: usize) -> Result<(), ParseError> {
        match self.peek().map(|t| &t.tok) {
            None => Err(err(format!("{op} needs a term after it"), s, e)),
            Some(Tok::Close) => Err(err(format!("{op} needs a term after it, before the closing bracket"), s, e)),
            Some(t @ (Tok::And | Tok::Or)) => {
                let n = self.peek().unwrap();
                Err(err(format!("Two operators in a row: {} right after {op}", Self::op_name(t)), n.start, n.end))
            }
            _ => Ok(()),
        }
    }

    fn and_expr(&mut self, field: Option<&str>) -> Result<Node, ParseError> {
        let mut items = vec![self.unary(field)?];
        loop {
            let Some(t) = self.peek() else { break };
            let (s, e) = (t.start, t.end);
            match t.tok {
                Tok::And => {
                    self.at += 1;
                    // AND NOT
                    if self.peek().is_some_and(|t| t.tok == Tok::Not) {
                        let n = self.peek().unwrap().clone();
                        self.at += 1;
                        self.expect_operand("NOT", n.start, n.end)?;
                        items.push(self.unary(field)?.negated(true));
                        continue;
                    }
                    self.expect_operand("AND", s, e)?;
                    items.push(self.unary(field)?);
                }
                Tok::Not => {
                    self.at += 1;
                    self.expect_operand("NOT", s, e)?;
                    let n = self.unary(field)?;
                    let flipped = !n.is_not();
                    items.push(n.negated(flipped));
                }
                Tok::Open | Tok::Term(_) | Tok::Scope(_) => items.push(self.unary(field)?),
                _ => break,
            }
        }
        Ok(if items.len() == 1 { items.pop().unwrap() } else { Node::group(Op::And, items) })
    }

    fn unary(&mut self, field: Option<&str>) -> Result<Node, ParseError> {
        let Some(t) = self.peek().cloned() else {
            return Err(err("The search ends where a term was expected", self.len, self.len));
        };
        match &t.tok {
            Tok::Not => {
                self.at += 1;
                self.expect_operand("NOT", t.start, t.end)?;
                let n = self.unary(field)?;
                let flipped = !n.is_not();
                Ok(n.negated(flipped))
            }
            Tok::And | Tok::Or => Err(err(format!("{} needs a term before it", Self::op_name(&t.tok)), t.start, t.end)),
            Tok::Close => Err(err("This closing bracket has no matching opening bracket", t.start, t.end)),
            Tok::Scope(f) => {
                self.at += 1;
                let f = f.clone();
                self.unary(Some(&f))
            }
            Tok::Open => {
                self.at += 1;
                if self.peek().is_some_and(|n| n.tok == Tok::Close) {
                    let close = self.peek().unwrap().end;
                    return Err(err("Empty brackets: put a term inside or remove them", t.start, close));
                }
                if self.peek().is_none() {
                    return Err(err("This bracket is never closed: add a ) after what it groups", t.start, t.end));
                }
                let inner = self.or_expr(field)?;
                match self.peek() {
                    Some(c) if c.tok == Tok::Close => {
                        self.at += 1;
                    }
                    _ => return Err(err("This bracket is never closed: add a ) after what it groups", t.start, t.end)),
                }
                Ok(match inner {
                    Node::Group { id, op, items, not, .. } => Node::Group { id, op, items, not, label: Some("\u{0}bracketed".into()) },
                    other => other,
                })
            }
            Tok::Term(term) => {
                self.at += 1;
                let mut term = term.clone();
                if let Some(f) = field {
                    if term.field == "all" {
                        term.field = f.to_string();
                    }
                }
                Ok(Node::term(term))
            }
        }
    }
}

fn strip_marks(n: Node) -> Node {
    match n {
        Node::Term { .. } => n,
        Node::Group { id, op, items, not, label } => Node::Group { id, op, items: items.into_iter().map(strip_marks).collect(), not, label: label.filter(|l| !l.starts_with('\u{0}')) },
    }
}

/// Reads the text mode into a tree. Errors point at the place of the problem.
pub fn parse(text: &str) -> Result<Parsed, ParseError> {
    let toks = lex(text)?;
    let len = text.chars().count();
    if toks.is_empty() {
        return Ok(Parsed::default());
    }
    let mut p = P { toks: &toks, at: 0, len, notes: Vec::new() };
    let tree = p.or_expr(None)?;
    if let Some(t) = p.peek() {
        return Err(match t.tok {
            Tok::Close => err("This closing bracket has no matching opening bracket", t.start, t.end),
            _ => err("This part could not be read", t.start, t.end),
        });
    }
    let tree = strip_marks(tree).normalized().unwrap_or_default();
    let tree = match tree {
        g @ Node::Group { not: false, .. } => g,
        other => Node::group(Op::And, vec![other]),
    };
    let text = format(&tree);
    Ok(Parsed { tree, notes: p.notes, text })
}

// ── Text mode: format ──

fn needs_quotes(word: &str) -> bool {
    matches!(word.to_ascii_uppercase().as_str(), "AND" | "OR" | "NOT") || word.contains(':') || word.chars().any(|c| !is_word_char(c) || c == ']')
}

pub fn format_term(term: &Term) -> String {
    let words: Vec<&str> = term.text.split_whitespace().collect();
    let star = if term.truncate { "*" } else { "" };
    let body = if term.mode == "phrase" || term.proximity.is_some() || words.iter().any(|w| needs_quotes(w)) {
        let prox = term.proximity.map(|n| format!("~{n}")).unwrap_or_default();
        format!("\"{}{}\"{}", term.text.replace('"', ""), star, prox)
    } else if words.len() > 1 && term.field != "all" {
        format!("({}{star})", words.join(" "))
    } else {
        format!("{}{star}", words.join(" "))
    };
    if term.field == "all" || term.field.is_empty() { body } else { format!("{}:{body}", tag_of_field(&term.field)) }
}

fn format_node(n: &Node, nested: bool) -> String {
    match n {
        Node::Term { term, .. } => format_term(term),
        Node::Group { op, items, .. } => {
            let mut out = String::new();
            for (i, item) in items.iter().enumerate() {
                let inner = format_node(item, true);
                if i == 0 {
                    if item.is_not() {
                        out.push_str("NOT ");
                    }
                } else {
                    out.push_str(match (op, item.is_not()) {
                        (Op::And, false) => " AND ",
                        (Op::And, true) => " NOT ",
                        (Op::Or, false) => " OR ",
                        (Op::Or, true) => " OR NOT ",
                    });
                }
                out.push_str(&inner);
            }
            if nested && items.len() > 1 { format!("({out})") } else { out }
        }
    }
}

/// The canonical text for a tree (what the text mode shows for the blocks).
pub fn format(n: &Node) -> String {
    match n.normalized() {
        None => String::new(),
        Some(n @ Node::Group { not: false, .. }) => format_node(&n, false),
        Some(n @ Node::Group { .. }) => format!("NOT {}", format_node(&n, true)),
        Some(n) => {
            let t = format_node(&n, false);
            if n.is_not() { format!("NOT {t}") } else { t }
        }
    }
}

// ── Local evaluation ──

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Truth {
    True,
    False,
    /// The record lacks the field the term is about (no abstract, no keywords...).
    Unknown,
}

impl Truth {
    fn not(self) -> Truth {
        match self {
            Truth::True => Truth::False,
            Truth::False => Truth::True,
            Truth::Unknown => Truth::Unknown,
        }
    }
}

fn year_range(text: &str) -> Option<(i64, i64)> {
    let t = text.trim();
    let parse = |s: &str| s.trim().parse::<i64>().ok();
    if let Some((a, b)) = t.split_once(['-', '\u{2013}', ':']) {
        Some((parse(a).unwrap_or(i64::MIN), parse(b).unwrap_or(i64::MAX)))
    } else {
        parse(t).map(|y| (y, y))
    }
}

/// Whether the record has anything to check this term against.
pub fn field_present(field: &str, record: &Record) -> bool {
    match field {
        "abstract" => record.abstract_.as_deref().is_some_and(|a| !a.trim().is_empty()),
        "keywords" | "subject" => !record.keywords.is_empty(),
        "author" => !record.authors.is_empty(),
        "journal" => record.venue.is_some() || record.series.is_some(),
        "year" => record.year.is_some(),
        "type" => record.kind.is_some(),
        "language" => record.language.is_some(),
        "affiliation" | "fulltext" | "identifier" => false,
        _ => true,
    }
}

pub fn term_truth(term: &Term, record: &Record) -> Truth {
    match term.field.as_str() {
        "year" => {
            let Some(y) = record.year else { return Truth::Unknown };
            return match year_range(&term.text) {
                Some((a, b)) if y >= a && y <= b => Truth::True,
                Some(_) => Truth::False,
                None => Truth::Unknown,
            };
        }
        "type" => return record.kind.as_ref().map(|k| if query::fold(k) == query::fold(&term.text) { Truth::True } else { Truth::False }).unwrap_or(Truth::Unknown),
        "language" => {
            return record.language.as_ref().map(|l| if query::fold(l).starts_with(&query::fold(&term.text)) || query::fold(&term.text).starts_with(&query::fold(l)) { Truth::True } else { Truth::False }).unwrap_or(Truth::Unknown);
        }
        _ => {}
    }
    if !field_present(&term.field, record) {
        return Truth::Unknown;
    }
    if query::term_matches(term, record) {
        return Truth::True;
    }
    // Anywhere / title-or-abstract without an abstract: the words may be in what is missing.
    if matches!(term.field.as_str(), "all" | "title_abstract") && !field_present("abstract", record) {
        return Truth::Unknown;
    }
    Truth::False
}

/// Evaluates the tree on a record. `known` says which parts (by path, see [`paths`]) the
/// service already checked for this record: those count as true.
pub fn eval(n: &Node, record: &Record, known: &dyn Fn(&str) -> bool) -> Truth {
    fn go(n: &Node, path: &str, record: &Record, known: &dyn Fn(&str) -> bool) -> Truth {
        let raw = if known(path) {
            // `known` is about the item as written, negation included.
            return Truth::True;
        } else {
            match n {
                Node::Term { term, .. } => term_truth(term, record),
                Node::Group { op, items, .. } => {
                    let mut unknown = false;
                    let mut out = match op {
                        Op::And => Truth::True,
                        Op::Or => Truth::False,
                    };
                    for (i, item) in items.iter().enumerate() {
                        let t = go(item, &format!("{path}.{i}"), record, known);
                        match (op, t) {
                            (Op::And, Truth::False) => {
                                out = Truth::False;
                                break;
                            }
                            (Op::Or, Truth::True) => {
                                out = Truth::True;
                                break;
                            }
                            (_, Truth::Unknown) => unknown = true,
                            _ => {}
                        }
                    }
                    if unknown && !matches!((op, out), (Op::And, Truth::False) | (Op::Or, Truth::True)) { Truth::Unknown } else { out }
                }
            }
        };
        if n.is_not() { raw.not() } else { raw }
    }
    go(n, "r", record, known)
}

/// Every node's path ("r", "r.0", "r.0.1"), in the order [`eval`] uses.
pub fn paths(n: &Node) -> Vec<(String, &Node)> {
    let mut out = Vec::new();
    fn walk<'a>(n: &'a Node, path: String, out: &mut Vec<(String, &'a Node)>) {
        if let Node::Group { items, .. } = n {
            for (i, item) in items.iter().enumerate() {
                walk(item, format!("{path}.{i}"), out);
            }
        }
        out.push((path, n));
    }
    walk(n, "r".into(), &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> Node {
        parse(text).unwrap_or_else(|e| panic!("{text}: {e:?}")).tree
    }

    fn rt(text: &str) -> String {
        format(&p(text))
    }

    #[test]
    fn nested_logic_parses_and_round_trips() {
        assert_eq!(rt("(health OR doctor) AND ((AI OR ML) AND NOT regression)"), "(health OR doctor) AND (AI OR ML) NOT regression");
        assert_eq!(rt("(Heath Or doctor) and ((ai or ml) not regression)"), "(Heath OR doctor) AND (ai OR ml) NOT regression");
        let t = p("(health OR doctor) AND ((AI OR ML) NOT regression)");
        let Node::Group { op: Op::And, items, .. } = &t else { panic!() };
        assert_eq!(items.len(), 3);
        assert!(items[2].is_not());
        // Round trip is stable.
        for text in [
            "a OR (b AND (c OR NOT d))",
            "title:\"machine learning\" OR abstract:(deep learning) OR vaccin* OR \"hand washing\"~3",
            "mesh:\"Health Personnel\" AND year:2015-2024 AND type:review AND lang:en",
            "NOT (a OR b) AND c",
            "\"and\" OR x",
        ] {
            let once = rt(text);
            assert_eq!(rt(&once), once, "{text}");
            assert_eq!(p(&once), p(text), "{text}");
        }
    }

    #[test]
    fn fields_scope_words_phrases_and_groups() {
        let t = p("ti:(a OR \"b c\") AND d[tiab] AND (e OR f)[au] AND title:x y");
        let terms = t.terms();
        assert_eq!(terms.iter().map(|t| t.field.as_str()).collect::<Vec<_>>(), ["title", "title", "title_abstract", "author", "author", "title", "all"]);
        assert_eq!(terms[1].mode, "phrase");
        let t = p("health workers OR nurse*");
        assert_eq!(t.terms()[0].text, "health workers");
        assert!(t.terms()[1].truncate);
    }

    #[test]
    fn errors_point_at_the_problem() {
        let e = parse("(a OR b AND c").unwrap_err();
        assert_eq!((e.start, e.end), (0, 1));
        assert!(e.message.contains("never closed"));
        let e = parse("a OR b)").unwrap_err();
        assert_eq!(e.start, 6);
        let e = parse("a AND OR b").unwrap_err();
        assert!(e.message.contains("OR right after AND"), "{e:?}");
        assert!(parse("a AND").unwrap_err().message.contains("after"));
        assert!(parse("OR a").unwrap_err().message.contains("before"));
        assert!(parse("\"open").unwrap_err().message.contains("quotation"));
        assert!(parse("foo:bar").unwrap_err().message.contains("Unknown field"));
        assert!(parse("()").unwrap_err().message.contains("Empty"));
        assert_eq!(parse("a b OR c AND d").unwrap().notes.len(), 1);
        assert!(parse("").unwrap().tree.is_empty());
    }

    #[test]
    fn evaluation_is_three_valued() {
        let r = Record { title: "Machine learning for doctors".into(), year: Some(2020), ..Default::default() };
        let yes = |_: &str| false;
        assert_eq!(eval(&p("(health OR doctor*) AND (AI OR \"machine learning\")"), &r, &yes), Truth::True);
        assert_eq!(eval(&p("doctors NOT regression"), &r, &yes), Truth::Unknown);
        assert_eq!(eval(&p("title:doctors NOT title:regression"), &r, &yes), Truth::True);
        assert_eq!(eval(&p("title:doctors AND abstract:x"), &r, &yes), Truth::Unknown);
        assert_eq!(eval(&p("title:doctors AND year:2021-2024"), &r, &yes), Truth::False);
        assert_eq!(eval(&p("title:nurses AND abstract:x"), &r, &yes), Truth::False);
        assert_eq!(eval(&p("title:nurses"), &r, &|path: &str| path == "r"), Truth::True);
    }

    #[test]
    fn nnf_pushes_negation_to_terms() {
        let t = p("NOT (a OR b) AND c").nnf();
        assert_eq!(format(&t), "NOT a NOT b AND c");
        let t = p("x AND NOT (a AND b)").nnf();
        assert_eq!(format(&t), "x AND (NOT a OR NOT b)");
    }

    #[test]
    fn serde_shape_is_tagged() {
        let t = p("a OR title:b");
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["type"], "group");
        assert_eq!(v["op"], "or");
        assert_eq!(v["items"][1]["type"], "term");
        assert_eq!(v["items"][1]["field"], "title");
        let back: Node = serde_json::from_value(v).unwrap();
        assert_eq!(back, t);
    }
}
