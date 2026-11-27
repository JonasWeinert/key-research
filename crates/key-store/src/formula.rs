// Formula properties: a small deterministic expression language over a source's fields,
// custom properties and related records (`{Year} + 1`, `if({Has PDF}, "Ready", "Find PDF")`,
// `days_since({Date added})`, `has({Tags}, "to read")`). No code execution or I/O; bounded in
// length, tokens, nesting and output; regular expressions use the linear-time `regex` crate.
//
// A formula is parsed once into a tree (cached per text), type-checked for the editor and
// evaluated lazily (`if`, `and`, `coalesce` only evaluate what they need). Every source's
// value is stored and kept up to date incrementally (formula_values.rs), and the table, the
// details, sorting, filtering, grouping, batch edits and exports all read that one value.
// The catalog of fields, functions and templates is formula_catalog.rs.
use crate::Result;
use crate::formula_catalog::{FUNCTIONS, FnSpec, function};
use serde::Serialize;
use serde_json::{Map, Value as Json, json};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

pub use crate::formula_scope::{context, definitions, property_sql, register, result_type, source_context, values_for};
pub use crate::formula_values::{RecalcStats, decorate};
pub(crate) use crate::formula_scope::{evaluate_on, rename_reference};

const MAX_CHARS: usize = 4096;
const MAX_TOKENS: usize = 1024;
const MAX_DEPTH: usize = 32;
const MAX_TEXT: usize = 65536;
const MAX_LIST: usize = 10_000;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    /// Days since 1970-01-01 (UTC).
    Date(i64),
    List(Vec<Value>),
}

impl Value {
    pub fn to_json(&self) -> Json {
        match self {
            Value::Null => Json::Null,
            Value::Bool(b) => Json::Bool(*b),
            Value::Num(n) if n.fract() == 0.0 && n.abs() < 9.0e15 => Json::from(*n as i64),
            Value::Num(n) => serde_json::Number::from_f64(*n).map_or(Json::Null, Json::Number),
            Value::Str(s) => Json::String(s.clone()),
            Value::Date(d) => Json::String(date_text(*d)),
            Value::List(items) => Json::Array(items.iter().map(Value::to_json).collect()),
        }
    }
    pub(crate) fn truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Num(n) => *n != 0.0 && !n.is_nan(),
            Value::Str(s) => !s.is_empty(),
            Value::Date(_) => true,
            Value::List(items) => !items.is_empty(),
        }
    }
    pub(crate) fn is_empty(&self) -> bool {
        match self {
            Value::Null => true,
            Value::Str(s) => s.trim().is_empty(),
            Value::List(items) => items.is_empty(),
            _ => false,
        }
    }
    /// The value as text the way the formula language shows it.
    pub fn text(&self) -> String {
        match self {
            Value::Null => String::new(),
            Value::Bool(b) => b.to_string(),
            Value::Num(n) => number_text(*n),
            Value::Str(s) => s.clone(),
            Value::Date(d) => date_text(*d),
            Value::List(items) => items.iter().map(Value::text).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(", "),
        }
    }
    /// The result type name the editor and the table use.
    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "empty",
            Value::Bool(_) => "boolean",
            Value::Num(_) => "number",
            Value::Str(_) => "text",
            Value::Date(_) => "date",
            Value::List(_) => "list",
        }
    }
}

/// A number as JavaScript prints it: integers without a fraction, exponents past 1e21.
fn number_text(n: f64) -> String {
    if n == 0.0 {
        return "0".into();
    }
    if n.abs() >= 1e21 || n.abs() < 1e-6 {
        let text = format!("{n:e}");
        return match text.split_once('e') {
            Some((m, x)) if !x.starts_with('-') => format!("{m}e+{x}"),
            _ => text,
        };
    }
    format!("{n}")
}

// ---- Dates -------------------------------------------------------------------------------

pub(crate) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let (y, m) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + day - 1;
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
}

pub(crate) fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn date_text(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/// "2021", "2021-03", "2021-03-04", "2021/3/4", "2021-03-04T10:00", "March 2021", "4 March 2021".
pub(crate) fn parse_date(text: &str) -> Option<i64> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let digits: Vec<i64> = t.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).take(3).filter_map(|p| p.parse().ok()).collect();
    let month_name = MONTHS.iter().position(|m| t.to_lowercase().contains(&m[..3].to_lowercase())).map(|i| i as i64 + 1);
    let (year, month, day) = match (month_name, digits.as_slice()) {
        (Some(m), [a, b, ..]) if *a > 31 => (*a, m, *b),
        (Some(m), [a, b, ..]) => (*b, m, *a),
        (Some(m), [y]) => (*y, m, 1),
        (None, [y, m, d, ..]) if *y > 31 => (*y, *m, *d),
        (None, [d, m, y, ..]) if *y > 31 => (*y, *m, *d),
        (None, [y, m]) => (*y, *m, 1),
        (None, [y]) => (*y, 1, 1),
        _ => return None,
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(1000..=9999).contains(&year) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

pub(crate) fn today() -> i64 {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    ms.div_euclid(86_400_000)
}

fn format_date(days: i64, pattern: &str) -> String {
    let (y, m, d) = civil_from_days(days);
    let name = MONTHS[(m - 1) as usize];
    let pattern = match pattern.trim().to_lowercase().as_str() {
        "" | "iso" => "YYYY-MM-DD".to_string(),
        "short" => "D MMM YYYY".into(),
        "long" => "D MMMM YYYY".into(),
        "month" => "MMMM YYYY".into(),
        "year" => "YYYY".into(),
        _ => pattern.to_string(),
    };
    let mut out = String::new();
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let run = chars[i..].iter().take_while(|c| **c == chars[i]).count();
        match (chars[i], run) {
            ('Y', 4..) => out.push_str(&format!("{y:04}")),
            ('Y', 2..=3) => out.push_str(&format!("{:02}", y % 100)),
            ('M', 4..) => out.push_str(name),
            ('M', 3) => out.push_str(&name[..3]),
            ('M', 2) => out.push_str(&format!("{m:02}")),
            ('M', 1) => out.push_str(&m.to_string()),
            ('D', 2..) => out.push_str(&format!("{d:02}")),
            ('D', 1) => out.push_str(&d.to_string()),
            (c, n) => out.extend(std::iter::repeat_n(c, n)),
        }
        i += run;
    }
    out
}

// ---- Errors ------------------------------------------------------------------------------

/// A problem with a formula, in plain language, with where it is (character offsets).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FormulaError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    pub start: usize,
    pub end: usize,
}

impl FormulaError {
    fn at(message: impl Into<String>, start: usize, end: usize) -> Self {
        Self { message: message.into(), hint: None, start, end }
    }
    fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

type Eval<T> = std::result::Result<T, FormulaError>;

// ---- Tokens ------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Tok {
    Num(f64),
    Str(String),
    Ref(String),
    Ident(String),
    Op(&'static str),
    Open,
    Close,
    Comma,
}

#[derive(Clone, Debug)]
pub(crate) struct Token {
    pub tok: Tok,
    pub start: usize,
    pub end: usize,
}

const OPERATORS: [&str; 18] = ["===", "!==", "==", "!=", "<>", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "!", "&"];

pub(crate) fn tokenize(source: &str) -> Eval<Vec<Token>> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let c = chars[i];
        let start = i;
        let tok = match c {
            '[' | '{' => {
                let close = if c == '[' { ']' } else { '}' };
                let end = chars[i + 1..].iter().position(|&x| x == close).map(|p| i + 1 + p);
                match end {
                    Some(end) if end > i + 1 && end - i - 1 <= 128 => {
                        i = end + 1;
                        Tok::Ref(chars[start + 1..end].iter().collect::<String>().trim().to_string())
                    }
                    Some(end) if end == i + 1 => return Err(FormulaError::at("An empty property reference", start, end + 1).hint(format!("Put a property name inside, like {c}Year{close}"))),
                    _ => return Err(FormulaError::at(format!("This property name is missing its closing {close}"), start, chars.len()).hint(format!("Write {c}Name{close}"))),
                }
            }
            '"' | '\'' => {
                i += 1;
                let mut text = String::new();
                loop {
                    match chars.get(i) {
                        None => return Err(FormulaError::at("This text is missing its closing quote", start, chars.len()).hint(format!("End the text with {c}"))),
                        Some('\\') => {
                            match chars.get(i + 1) {
                                Some('n') => text.push('\n'),
                                Some('t') => text.push('\t'),
                                Some(&other) => text.push(other),
                                None => {}
                            }
                            i += 2;
                        }
                        Some(&q) if q == c => {
                            i += 1;
                            break;
                        }
                        Some(&other) => {
                            text.push(other);
                            i += 1;
                        }
                    }
                }
                Tok::Str(text)
            }
            '0'..='9' | '.' => {
                if c == '.' && !chars.get(i + 1).is_some_and(char::is_ascii_digit) {
                    return Err(FormulaError::at("A stray full stop", start, start + 1));
                }
                while chars.get(i).is_some_and(char::is_ascii_digit) {
                    i += 1;
                }
                if chars.get(i) == Some(&'.') {
                    i += 1;
                    while chars.get(i).is_some_and(char::is_ascii_digit) {
                        i += 1;
                    }
                }
                let text: String = chars[start..i].iter().collect();
                Tok::Num(text.parse().map_err(|_| FormulaError::at(format!("{text} is not a number"), start, i))?)
            }
            c if c.is_alphabetic() || c == '_' => {
                while chars.get(i).is_some_and(|c| c.is_alphanumeric() || *c == '_') {
                    i += 1;
                }
                Tok::Ident(chars[start..i].iter().collect())
            }
            '(' => {
                i += 1;
                Tok::Open
            }
            ')' => {
                i += 1;
                Tok::Close
            }
            ',' | ';' => {
                i += 1;
                Tok::Comma
            }
            '=' => {
                // `=` and `==` both compare (spreadsheet habit).
                i += if chars.get(i + 1) == Some(&'=') { if chars.get(i + 2) == Some(&'=') { 3 } else { 2 } } else { 1 };
                Tok::Op("==")
            }
            _ => {
                let rest: String = chars[i..].iter().take(3).collect();
                match OPERATORS.into_iter().find(|op| rest.starts_with(op)) {
                    Some(op) => {
                        i += op.chars().count();
                        Tok::Op(match op {
                            "===" => "==",
                            "!==" | "<>" => "!=",
                            other => other,
                        })
                    }
                    None => return Err(FormulaError::at(format!("“{c}” can't be used in a formula"), start, start + 1).hint("Put text in quotes and property names in {curly braces}")),
                }
            }
        };
        tokens.push(Token { tok, start, end: i });
        if tokens.len() > MAX_TOKENS {
            return Err(FormulaError::at("This formula is too long to work out", 0, chars.len()));
        }
    }
    Ok(tokens)
}

// ---- Tree --------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) enum Kind {
    Lit(Value),
    Ref(String),
    Call(&'static FnSpec, Vec<Node>),
    Unary(&'static str, Box<Node>),
    Binary(&'static str, Box<Node>, Box<Node>),
}

#[derive(Clone, Debug)]
pub(crate) struct Node {
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
}

fn precedence(op: &str) -> Option<u8> {
    Some(match op {
        "||" => 1,
        "&&" => 2,
        "==" | "!=" => 3,
        "<" | ">" | "<=" | ">=" => 4,
        "&" => 5,
        "+" | "-" => 6,
        "*" | "/" | "%" => 7,
        _ => return None,
    })
}
const UNARY: u8 = 8;

/// Word forms of operators (`and`, `or`, `not`) for people who do not write code.
fn word_operator(token: &Token) -> Option<&'static str> {
    match &token.tok {
        Tok::Op(op) => Some(op),
        Tok::Ident(word) => match word.to_lowercase().as_str() {
            "and" => Some("&&"),
            "or" => Some("||"),
            _ => None,
        },
        _ => None,
    }
}

struct Parser {
    tokens: Vec<Token>,
    index: usize,
    depth: usize,
    length: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.index)
    }
    fn end_of(&self) -> usize {
        self.tokens.last().map_or(0, |t| t.end)
    }
    fn expect_close(&mut self, open: usize) -> Eval<usize> {
        match self.peek() {
            Some(Token { tok: Tok::Close, end, .. }) => {
                let end = *end;
                self.index += 1;
                Ok(end)
            }
            Some(t) => Err(FormulaError::at("Expected a closing bracket here", t.start, t.end).hint("Check that every ( has a matching ) and that arguments are separated by commas")),
            None => Err(FormulaError::at("A bracket is never closed", open, self.length).hint("Add a ) at the end")),
        }
    }

    fn expression(&mut self, minimum: u8) -> Eval<Node> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(FormulaError::at("This formula nests too deeply (more than 32 levels)", 0, self.length));
        }
        let mut node = self.operand()?;
        while let Some((op, p)) = self.peek().and_then(word_operator).and_then(|op| precedence(op).map(|p| (op, p))).filter(|(_, p)| *p >= minimum) {
            self.index += 1;
            let rhs = self.expression(p + 1)?;
            let (start, end) = (node.start, rhs.end);
            node = Node { kind: Kind::Binary(op, Box::new(node), Box::new(rhs)), start, end };
        }
        self.depth -= 1;
        Ok(node)
    }

    fn operand(&mut self) -> Eval<Node> {
        let Some(token) = self.tokens.get(self.index).cloned() else {
            let at = self.end_of();
            return Err(FormulaError::at(if at == 0 { "The formula is empty" } else { "Something is missing at the end" }, at, at.max(self.length)));
        };
        self.index += 1;
        let (start, end) = (token.start, token.end);
        let lit = |v: Value| Ok(Node { kind: Kind::Lit(v), start, end });
        match token.tok {
            Tok::Open => {
                let inner = self.expression(0)?;
                let end = self.expect_close(start)?;
                Ok(Node { end, start, ..inner })
            }
            Tok::Op(op @ ("-" | "+" | "!")) => {
                let rhs = self.expression(UNARY)?;
                let end = rhs.end;
                Ok(Node { kind: Kind::Unary(op, Box::new(rhs)), start, end })
            }
            Tok::Ident(word) if word.eq_ignore_ascii_case("not") && !matches!(self.peek(), Some(Token { tok: Tok::Open, .. })) => {
                let rhs = self.expression(UNARY)?;
                let end = rhs.end;
                Ok(Node { kind: Kind::Unary("!", Box::new(rhs)), start, end })
            }
            Tok::Ref(name) => Ok(Node { kind: Kind::Ref(name), start, end }),
            Tok::Num(n) => lit(Value::Num(n)),
            Tok::Str(s) => lit(Value::Str(s)),
            Tok::Ident(word) => match word.to_lowercase().as_str() {
                "true" => lit(Value::Bool(true)),
                "false" => lit(Value::Bool(false)),
                "null" | "empty" if !matches!(self.peek(), Some(Token { tok: Tok::Open, .. })) => lit(Value::Null),
                _ => {
                    if !matches!(self.peek(), Some(Token { tok: Tok::Open, .. })) {
                        return Err(FormulaError::at(format!("“{word}” is not a value"), start, end).hint(format!("To use a property, write {{{word}}}. To write text, put it in quotes: \"{word}\"")));
                    }
                    let Some(spec) = function(&word) else {
                        let suggestion = closest(&word, FUNCTIONS.iter().map(|f| f.name));
                        let error = FormulaError::at(format!("There is no function called “{word}”"), start, end);
                        return Err(match suggestion {
                            Some(s) => error.hint(format!("Did you mean {s}()?")),
                            None => error.hint("Open the function list to see what is available"),
                        });
                    };
                    self.index += 1;
                    let mut args = Vec::new();
                    if !matches!(self.peek(), Some(Token { tok: Tok::Close, .. })) {
                        loop {
                            args.push(self.expression(0)?);
                            if matches!(self.peek(), Some(Token { tok: Tok::Comma, .. })) {
                                self.index += 1;
                                continue;
                            }
                            break;
                        }
                    }
                    let close = self.expect_close(end)?;
                    if args.len() < spec.min || args.len() > spec.max {
                        let wanted = if spec.min == spec.max { format!("{}", spec.min) } else if spec.max == usize::MAX { format!("at least {}", spec.min) } else { format!("{} to {}", spec.min, spec.max) };
                        return Err(FormulaError::at(format!("{}() takes {wanted} value{}, not {}", spec.name, if wanted == "1" { "" } else { "s" }, args.len()), start, close).hint(format!("Write it like {}", spec.example)));
                    }
                    Ok(Node { kind: Kind::Call(spec, args), start, end: close })
                }
            },
            Tok::Comma => Err(FormulaError::at("A comma is out of place", start, end).hint("Commas separate the values inside a function's brackets")),
            Tok::Close => Err(FormulaError::at("A closing bracket without an opening one", start, end)),
            Tok::Op(op) => Err(FormulaError::at(format!("“{op}” needs a value before it"), start, end)),
        }
    }
}

/// The closest of `names` to `word`, if it is close enough to be a likely typo.
pub(crate) fn closest<'a>(word: &str, names: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let word = word.to_lowercase();
    names
        .map(|n| (distance(&word, &n.to_lowercase()), n))
        .filter(|(d, n)| *d <= (n.chars().count() / 3).max(if n.chars().count() >= 4 { 2 } else { 1 }))
        .min_by_key(|(d, _)| *d)
        .map(|(_, n)| n)
}

fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let current = row[j + 1];
            row[j + 1] = (previous + usize::from(ca != *cb)).min(row[j] + 1).min(row[j + 1] + 1);
            previous = current;
        }
    }
    row[b.len()]
}

pub(crate) fn parse(source: &str) -> Eval<Rc<Node>> {
    thread_local! {
        static CACHE: RefCell<HashMap<String, Rc<Node>>> = RefCell::new(HashMap::new());
    }
    if let Some(node) = CACHE.with(|c| c.borrow().get(source).cloned()) {
        return Ok(node);
    }
    let length = source.chars().count();
    if source.encode_utf16().count() > MAX_CHARS {
        return Err(FormulaError::at("A formula can be at most 4,096 characters", 0, length));
    }
    let tokens = tokenize(source)?;
    let mut parser = Parser { tokens, index: 0, depth: 0, length };
    let node = parser.expression(0)?;
    if let Some(extra) = parser.peek() {
        return Err(FormulaError::at("Something follows the end of the formula", extra.start, length).hint("Join parts with an operator such as + or &, or put them in a function like concat()"));
    }
    let node = Rc::new(node);
    CACHE.with(|c| {
        let mut cache = c.borrow_mut();
        if cache.len() > 512 {
            cache.clear();
        }
        cache.insert(source.to_string(), node.clone());
    });
    Ok(node)
}

// ---- Evaluation --------------------------------------------------------------------------

/// What a formula can read: fields and properties by name.
pub trait Scope {
    /// The value of `{name}`; `Ok(Null)` for a name nothing defines.
    fn lookup(&self, name: &str) -> std::result::Result<Value, String>;
}

/// A plain map of values (the editor's preview without a source, and tests).
pub struct MapScope<'a>(pub &'a Map<String, Json>);

impl Scope for MapScope<'_> {
    fn lookup(&self, name: &str) -> std::result::Result<Value, String> {
        let raw = self.0.get(name).or_else(|| self.0.iter().find(|(k, _)| k.to_lowercase() == name.to_lowercase()).map(|(_, v)| v));
        raw.map_or(Ok(Value::Null), from_json)
    }
}

pub(crate) fn from_json(value: &Json) -> std::result::Result<Value, String> {
    Ok(match value {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => Value::Num(n.as_f64().unwrap_or(f64::NAN)),
        Json::String(s) => Value::Str(s.clone()),
        Json::Array(items) => Value::List(items.iter().take(MAX_LIST).map(from_json).collect::<std::result::Result<_, _>>()?),
        _ => return Err("Formula properties must be scalar".into()),
    })
}

fn number_of(v: &Value) -> Option<f64> {
    let n = match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Num(n) => *n,
        Value::Date(d) => *d as f64,
        Value::Str(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else if t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E')) {
                t.parse().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
        Value::List(items) => items.len() as f64,
    };
    n.is_finite().then_some(n)
}

fn date_of(v: &Value) -> Option<i64> {
    match v {
        Value::Date(d) => Some(*d),
        Value::Str(s) => parse_date(s),
        // A bare year (`{Year}`) is that year's first day; larger numbers are milliseconds.
        Value::Num(n) if (1000.0..=9999.0).contains(n) => Some(days_from_civil(*n as i64, 1, 1)),
        Value::Num(n) if n.abs() > 1e9 => Some((*n as i64).div_euclid(86_400_000)),
        _ => None,
    }
}

fn list_of(v: Value) -> Vec<Value> {
    match v {
        Value::List(items) => items,
        Value::Null => Vec::new(),
        Value::Str(s) if s.contains(';') => s.split(';').map(|p| Value::Str(p.trim().to_string())).filter(|v| !v.is_empty()).collect(),
        other => vec![other],
    }
}

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Date(d), other) | (other, Value::Date(d)) => date_of(other) == Some(*d),
        (Value::Str(x), Value::Str(y)) => x == y,
        _ => a == b,
    }
}

thread_local! {
    static REGEXES: RefCell<HashMap<String, Rc<regex::Regex>>> = RefCell::new(HashMap::new());
}

fn regex_for(pattern: &str) -> std::result::Result<Rc<regex::Regex>, String> {
    if pattern.chars().count() > 512 {
        return Err("A pattern can be at most 512 characters".into());
    }
    if let Some(r) = REGEXES.with(|c| c.borrow().get(pattern).cloned()) {
        return Ok(r);
    }
    let compiled = regex::RegexBuilder::new(pattern)
        .size_limit(1 << 20)
        .dfa_size_limit(1 << 20)
        .build()
        .map_err(|e| match e {
            regex::Error::CompiledTooBig(_) => "This pattern is too complicated".to_string(),
            regex::Error::Syntax(text) => format!("The pattern is not valid: {}", text.lines().last().unwrap_or("").trim_start_matches("error: ")),
            _ => "The pattern is not valid".to_string(),
        })?;
    let compiled = Rc::new(compiled);
    REGEXES.with(|c| {
        let mut cache = c.borrow_mut();
        if cache.len() > 128 {
            cache.clear();
        }
        cache.insert(pattern.to_string(), compiled.clone());
    });
    Ok(compiled)
}

struct Evaluator<'a> {
    scope: &'a dyn Scope,
}

impl Evaluator<'_> {
    fn eval(&self, node: &Node) -> Eval<Value> {
        let fail = |message: String| FormulaError::at(message, node.start, node.end);
        let value = match &node.kind {
            Kind::Lit(v) => v.clone(),
            Kind::Ref(name) => self.scope.lookup(name).map_err(fail)?,
            Kind::Unary(op, rhs) => {
                let v = self.eval(rhs)?;
                match *op {
                    "!" => Value::Bool(!v.truthy()),
                    "-" => Value::Num(-self.number(&v, rhs)?),
                    _ => Value::Num(self.number(&v, rhs)?),
                }
            }
            Kind::Binary(op, a, b) => match *op {
                "&&" => Value::Bool(self.eval(a)?.truthy() && self.eval(b)?.truthy()),
                "||" => Value::Bool(self.eval(a)?.truthy() || self.eval(b)?.truthy()),
                _ => {
                    let (x, y) = (self.eval(a)?, self.eval(b)?);
                    self.binary(op, x, y, a, b).map_err(|e| if e.start == 0 && e.end == 0 { fail(e.message) } else { e })?
                }
            },
            Kind::Call(spec, args) => self.call(spec, args, node)?,
        };
        match &value {
            Value::Str(s) if s.len() > MAX_TEXT => Err(fail("The result is too long".into())),
            Value::Num(n) if !n.is_finite() => Err(fail("The result is not a finite number".into())),
            Value::List(items) if items.len() > MAX_LIST => Err(fail("The result has too many items".into())),
            _ => Ok(value),
        }
    }

    fn number(&self, v: &Value, node: &Node) -> Eval<f64> {
        number_of(v).ok_or_else(|| {
            FormulaError::at(format!("Expected a number, but {} is {}", describe(node), shown(v)), node.start, node.end).hint("Use number(…) to read a number from text, or coalesce(…, 0) for empty values")
        })
    }

    fn binary(&self, op: &str, x: Value, y: Value, a: &Node, b: &Node) -> Eval<Value> {
        Ok(match op {
            "&" => Value::Str(x.text() + &y.text()),
            "+" if matches!(x, Value::Date(_)) => Value::Date(date_of(&x).unwrap_or(0) + self.number(&y, b)?.round() as i64),
            "+" if matches!(x, Value::Str(_)) || matches!(y, Value::Str(_)) => Value::Str(x.text() + &y.text()),
            "+" => Value::Num(self.number(&x, a)? + self.number(&y, b)?),
            "-" if matches!(x, Value::Date(_)) && matches!(y, Value::Date(_)) => Value::Num((date_of(&x).unwrap_or(0) - date_of(&y).unwrap_or(0)) as f64),
            "-" if matches!(x, Value::Date(_)) => Value::Date(date_of(&x).unwrap_or(0) - self.number(&y, b)?.round() as i64),
            "-" => Value::Num(self.number(&x, a)? - self.number(&y, b)?),
            "*" => Value::Num(self.number(&x, a)? * self.number(&y, b)?),
            "/" | "%" => {
                let (n, d) = (self.number(&x, a)?, self.number(&y, b)?);
                if d == 0.0 {
                    return Err(FormulaError::at("Division by zero", b.start, b.end).hint("Wrap it in if(… = 0, 0, …) when the divisor can be zero"));
                }
                Value::Num(if op == "/" { n / d } else { n % d })
            }
            "==" => Value::Bool(same(&x, &y)),
            "!=" => Value::Bool(!same(&x, &y)),
            "<" | ">" | "<=" | ">=" => {
                let (l, r) = match (&x, &y) {
                    (Value::Date(_), _) | (_, Value::Date(_)) => (date_of(&x).map(|d| d as f64), date_of(&y).map(|d| d as f64)),
                    (Value::Str(p), Value::Str(q)) if number_of(&x).is_none() || number_of(&y).is_none() => {
                        let order = p.to_lowercase().cmp(&q.to_lowercase());
                        return Ok(Value::Bool(match op {
                            "<" => order.is_lt(),
                            ">" => order.is_gt(),
                            "<=" => order.is_le(),
                            _ => order.is_ge(),
                        }));
                    }
                    _ => (Some(self.number(&x, a)?), Some(self.number(&y, b)?)),
                };
                let (Some(l), Some(r)) = (l, r) else { return Ok(Value::Bool(false)) };
                Value::Bool(match op {
                    "<" => l < r,
                    ">" => l > r,
                    "<=" => l <= r,
                    _ => l >= r,
                })
            }
            _ => return Err(FormulaError::at("Unknown operator", 0, 0)),
        })
    }

    fn call(&self, spec: &FnSpec, args: &[Node], node: &Node) -> Eval<Value> {
        let fail = |message: String| FormulaError::at(message, node.start, node.end);
        let arg = |i: usize| -> Eval<Value> { args.get(i).map_or(Ok(Value::Null), |a| self.eval(a)) };
        let num = |i: usize| -> Eval<f64> {
            match args.get(i) {
                Some(a) => self.number(&self.eval(a)?, a),
                None => Ok(0.0),
            }
        };
        let text = |i: usize| -> Eval<String> { arg(i).map(|v| v.text()) };
        let date = |i: usize| -> Eval<Option<i64>> { arg(i).map(|v| date_of(&v)) };
        let all = || -> Eval<Vec<Value>> { args.iter().map(|a| self.eval(a)).collect() };
        let regex = |i: usize| -> Eval<Rc<regex::Regex>> {
            let pattern = text(i)?;
            regex_for(&pattern).map_err(|m| {
                let a = &args[i];
                FormulaError::at(m, a.start, a.end).hint("Patterns use regular-expression syntax: \\d+ is digits, (…) captures a part")
            })
        };
        Ok(match spec.name {
            // Logic
            "if" => {
                if arg(0)?.truthy() {
                    arg(1)?
                } else {
                    arg(2)?
                }
            }
            "ifs" => {
                let mut i = 0;
                while i + 1 < args.len() {
                    if arg(i)?.truthy() {
                        return arg(i + 1);
                    }
                    i += 2;
                }
                if i < args.len() { arg(i)? } else { Value::Null }
            }
            "and" => {
                for i in 0..args.len() {
                    if !arg(i)?.truthy() {
                        return Ok(Value::Bool(false));
                    }
                }
                Value::Bool(true)
            }
            "or" => {
                for i in 0..args.len() {
                    if arg(i)?.truthy() {
                        return Ok(Value::Bool(true));
                    }
                }
                Value::Bool(false)
            }
            "not" => Value::Bool(!arg(0)?.truthy()),
            "coalesce" => {
                for i in 0..args.len() {
                    let v = arg(i)?;
                    if !v.is_empty() {
                        return Ok(v);
                    }
                }
                Value::Null
            }
            "empty" => Value::Bool(arg(0)?.is_empty()),
            "filled" => Value::Bool(!arg(0)?.is_empty()),
            // Text
            "concat" => Value::Str(all()?.iter().map(Value::text).collect()),
            "join" => {
                let separator = if args.len() > 1 { text(1)? } else { ", ".into() };
                Value::Str(list_of(arg(0)?).iter().map(Value::text).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(&separator))
            }
            "lower" => Value::Str(text(0)?.to_lowercase()),
            "upper" => Value::Str(text(0)?.to_uppercase()),
            "capitalize" => Value::Str(
                text(0)?
                    .split(' ')
                    .map(|w| {
                        let mut c = w.chars();
                        c.next().map(|f| f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase()).unwrap_or_default()
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            "trim" => Value::Str(text(0)?.split_whitespace().collect::<Vec<_>>().join(" ")),
            "length" => match arg(0)? {
                Value::List(items) => Value::Num(items.len() as f64),
                v => Value::Num(v.text().chars().count() as f64),
            },
            "left" => Value::Str(text(0)?.chars().take(num(1)?.max(0.0) as usize).collect()),
            "right" => {
                let t: Vec<char> = text(0)?.chars().collect();
                let n = (num(1)?.max(0.0) as usize).min(t.len());
                Value::Str(t[t.len() - n..].iter().collect())
            }
            "slice" => {
                let t: Vec<char> = text(0)?.chars().collect();
                let start = (num(1)?.max(1.0) as usize - 1).min(t.len());
                let length = if args.len() > 2 { num(2)?.max(0.0) as usize } else { t.len() };
                Value::Str(t[start..(start + length).min(t.len())].iter().collect())
            }
            "replace" => Value::Str(text(0)?.replace(&text(1)?, &text(2)?)),
            "contains" => match arg(0)? {
                Value::List(items) => {
                    let needle = text(1)?.to_lowercase();
                    Value::Bool(items.iter().any(|i| i.text().to_lowercase().contains(&needle)))
                }
                v => Value::Bool(v.text().to_lowercase().contains(&text(1)?.to_lowercase())),
            },
            "starts_with" => Value::Bool(text(0)?.to_lowercase().starts_with(&text(1)?.to_lowercase())),
            "ends_with" => Value::Bool(text(0)?.to_lowercase().ends_with(&text(1)?.to_lowercase())),
            "split" => {
                let separator = if args.len() > 1 { text(1)? } else { ";".into() };
                let t = text(0)?;
                if separator.is_empty() {
                    return Err(fail("split() needs a separator".into()));
                }
                Value::List(t.split(separator.as_str()).map(|p| p.trim()).filter(|p| !p.is_empty()).take(MAX_LIST).map(|p| Value::Str(p.into())).collect())
            }
            "matches" => {
                let r = regex(1)?;
                Value::Bool(r.is_match(&text(0)?))
            }
            "extract" => {
                let r = regex(1)?;
                let t = text(0)?;
                let group = if args.len() > 2 { num(2)?.max(0.0) as usize } else { usize::from(r.captures_len() > 1) };
                r.captures(&t).and_then(|c| c.get(group)).map_or(Value::Null, |m| Value::Str(m.as_str().into()))
            }
            "replace_pattern" => {
                let r = regex(1)?;
                Value::Str(r.replace_all(&text(0)?, text(2)?.as_str()).into_owned())
            }
            "extract_year" => {
                let r = regex_for(r"\b(1[5-9]\d\d|20\d\d)\b").map_err(fail)?;
                r.captures(&text(0)?).and_then(|c| c.get(1)).and_then(|m| m.as_str().parse::<f64>().ok()).map_or(Value::Null, Value::Num)
            }
            "first_author" => {
                let v = if args.is_empty() { self.scope.lookup("first author").map_err(fail)? } else { arg(0)? };
                let first = list_of(v).into_iter().next().map(|v| v.text()).unwrap_or_default();
                // "Family, Given" → Family; "Given Family" → Family.
                let family = match first.split_once(',') {
                    Some((family, _)) => family.trim().to_string(),
                    None => first.split_whitespace().last().unwrap_or("").to_string(),
                };
                if family.is_empty() { Value::Null } else { Value::Str(family) }
            }
            "text" => match arg(0)? {
                Value::Null => Value::Str(String::new()),
                v => Value::Str(v.text()),
            },
            "number" => {
                let v = arg(0)?;
                match number_of(&v) {
                    Some(n) => Value::Num(n),
                    None => {
                        let t = v.text().replace(',', "");
                        let r = regex_for(r"-?\d+(\.\d+)?").map_err(fail)?;
                        r.find(&t).and_then(|m| m.as_str().parse::<f64>().ok()).map_or(Value::Null, Value::Num)
                    }
                }
            }
            "format_number" => {
                let n = num(0)?;
                let digits = if args.len() > 1 { num(1)?.clamp(0.0, 10.0) as usize } else { 0 };
                let fixed = format!("{n:.digits$}");
                let (int, frac) = fixed.split_once('.').map_or((fixed.as_str(), None), |(i, f)| (i, Some(f)));
                let (sign, int) = int.strip_prefix('-').map_or(("", int), |i| ("-", i));
                let grouped: Vec<String> = int.as_bytes().rchunks(3).rev().map(|c| String::from_utf8_lossy(c).into_owned()).collect();
                Value::Str(format!("{sign}{}{}", grouped.join(","), frac.map(|f| format!(".{f}")).unwrap_or_default()))
            }
            // Numbers
            "round" => {
                let x = num(0)?;
                let digits = if args.len() > 1 { num(1)?.clamp(-10.0, 10.0) as i32 } else { 0 };
                let scale = 10f64.powi(digits);
                let scaled = x * scale;
                let f = scaled.floor();
                Value::Num((if scaled - f >= 0.5 { f + 1.0 } else { f }) / scale)
            }
            "floor" => Value::Num(num(0)?.floor()),
            "ceil" => Value::Num(num(0)?.ceil()),
            "abs" => Value::Num(num(0)?.abs()),
            "sqrt" => {
                let x = num(0)?;
                if x < 0.0 {
                    return Err(fail("sqrt() needs a number that is not negative".into()));
                }
                Value::Num(x.sqrt())
            }
            "pow" => Value::Num(num(0)?.powf(num(1)?)),
            "min" | "max" | "sum" | "average" => {
                let mut values = Vec::new();
                for (i, a) in args.iter().enumerate() {
                    match arg(i)? {
                        Value::List(items) => values.extend(items.iter().filter_map(number_of)),
                        Value::Null => {}
                        v => values.push(self.number(&v, a)?),
                    }
                }
                if values.is_empty() {
                    return Ok(if spec.name == "sum" { Value::Num(0.0) } else { Value::Null });
                }
                Value::Num(match spec.name {
                    "min" => values.iter().copied().fold(f64::INFINITY, f64::min),
                    "max" => values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                    "sum" => values.iter().sum(),
                    _ => values.iter().sum::<f64>() / values.len() as f64,
                })
            }
            "clamp" => Value::Num(num(0)?.clamp(num(1)?.min(num(2)?), num(2)?.max(num(1)?))),
            "percent" => {
                let whole = num(1)?;
                if whole == 0.0 { Value::Num(0.0) } else { Value::Num((num(0)? / whole * 100.0).clamp(-1e12, 1e12)) }
            }
            // Lists
            "count" => Value::Num(list_of(arg(0)?).len() as f64),
            "has" => {
                let items = list_of(arg(0)?);
                let mut found = false;
                for i in 1..args.len() {
                    let wanted = text(i)?.to_lowercase();
                    if items.iter().any(|v| v.text().to_lowercase() == wanted) {
                        found = true;
                        break;
                    }
                }
                Value::Bool(found)
            }
            "has_all" => {
                let items: Vec<String> = list_of(arg(0)?).iter().map(|v| v.text().to_lowercase()).collect();
                let mut every = true;
                for i in 1..args.len() {
                    if !items.contains(&text(i)?.to_lowercase()) {
                        every = false;
                    }
                }
                Value::Bool(every)
            }
            "first" => list_of(arg(0)?).into_iter().next().unwrap_or(Value::Null),
            "last" => list_of(arg(0)?).pop().unwrap_or(Value::Null),
            "list" => Value::List(all()?.into_iter().filter(|v| !v.is_empty()).collect()),
            // Dates
            "today" => Value::Date(today()),
            "date" => {
                if args.len() >= 2 {
                    let (y, m, d) = (num(0)? as i64, num(1)? as i64, if args.len() > 2 { num(2)? as i64 } else { 1 });
                    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
                        return Err(fail("That is not a real date".into()));
                    }
                    Value::Date(days_from_civil(y, m, d))
                } else {
                    date(0)?.map_or(Value::Null, Value::Date)
                }
            }
            "year" | "month" | "day" => match date(0)? {
                Some(d) => {
                    let (y, m, day) = civil_from_days(d);
                    Value::Num(match spec.name {
                        "year" => y,
                        "month" => m,
                        _ => day,
                    } as f64)
                }
                None => Value::Null,
            },
            "days_since" => date(0)?.map_or(Value::Null, |d| Value::Num((today() - d) as f64)),
            "days_until" => date(0)?.map_or(Value::Null, |d| Value::Num((d - today()) as f64)),
            "days_between" => match (date(0)?, date(1)?) {
                (Some(a), Some(b)) => Value::Num((b - a) as f64),
                _ => Value::Null,
            },
            "add_days" => match date(0)? {
                Some(d) => Value::Date(d + num(1)?.round() as i64),
                None => Value::Null,
            },
            "format_date" => match date(0)? {
                Some(d) => Value::Str(format_date(d, &if args.len() > 1 { text(1)? } else { String::new() })),
                None => Value::Null,
            },
            other => return Err(fail(format!("{other}() is not available"))),
        })
    }
}

fn describe(node: &Node) -> String {
    match &node.kind {
        Kind::Ref(name) => format!("{{{name}}}"),
        Kind::Call(spec, _) => format!("{}()", spec.name),
        _ => "this value".into(),
    }
}

fn shown(v: &Value) -> String {
    match v {
        Value::Str(s) => format!("the text “{}”", s.chars().take(30).collect::<String>()),
        Value::List(_) => "a list".into(),
        Value::Date(_) => "a date".into(),
        _ => v.text(),
    }
}

/// Evaluates a parsed formula in `scope`.
pub(crate) fn evaluate_node(node: &Node, scope: &dyn Scope) -> Eval<Value> {
    Evaluator { scope }.eval(node)
}

/// Evaluates in `scope`, with errors that say where.
pub fn evaluate_in(source: &str, scope: &dyn Scope) -> std::result::Result<Value, FormulaError> {
    let node = parse(source)?;
    evaluate_node(&node, scope)
}

/// Evaluates a formula over named values (the source's properties and fields).
pub fn evaluate(source: &str, properties: &Map<String, Json>) -> Result<Value> {
    evaluate_in(source, &MapScope(properties)).map_err(|e| e.message)
}

// ---- Analysis (the editor) ---------------------------------------------------------------

/// The static type of an expression, as far as it can be told without a source.
fn infer(node: &Node, types: &dyn Fn(&str) -> &'static str) -> &'static str {
    match &node.kind {
        Kind::Lit(v) => match v {
            Value::Null => "any",
            other => other.type_name(),
        },
        Kind::Ref(name) => types(name),
        Kind::Unary("!", _) => "boolean",
        Kind::Unary(..) => "number",
        Kind::Binary(op, a, b) => match *op {
            "&&" | "||" | "==" | "!=" | "<" | ">" | "<=" | ">=" => "boolean",
            "&" => "text",
            "+" | "-" => match (infer(a, types), infer(b, types)) {
                ("date", "date") => "number",
                ("date", _) => "date",
                ("text", _) | (_, "text") if *op == "+" => "text",
                _ => "number",
            },
            _ => "number",
        },
        Kind::Call(spec, args) => match spec.result {
            "branches" => {
                let branches: Vec<&'static str> = match spec.name {
                    "if" => args.iter().skip(1).map(|a| infer(a, types)).collect(),
                    "ifs" => args.iter().enumerate().filter(|(i, _)| i % 2 == 1 || *i == args.len() - 1).map(|(_, a)| infer(a, types)).collect(),
                    _ => args.iter().map(|a| infer(a, types)).collect(),
                };
                let known: Vec<&str> = branches.iter().copied().filter(|t| *t != "any").collect();
                match known.first() {
                    Some(first) if known.iter().all(|t| t == first) => first,
                    Some(_) => "any",
                    None => "any",
                }
            }
            "item" => "any",
            other => other,
        },
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub kind: &'static str,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub name: String,
    pub start: usize,
    pub end: usize,
    /// field | property | formula | unknown
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub ok: bool,
    pub highlights: Vec<Highlight>,
    pub references: Vec<Reference>,
    pub functions: Vec<String>,
    /// number | text | boolean | date | list | any
    pub result_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<FormulaError>,
    /// Problems that do not stop the formula (an unknown property is empty).
    pub warnings: Vec<FormulaError>,
    /// The formula as blocks (see `to_blocks`), when it parses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Json>,
}

/// What the editor knows about the names a formula may use.
pub struct Names<'a> {
    /// `(name, kind, type)`: kind is field | property | formula.
    pub known: &'a [(String, &'static str, &'static str)],
}

impl Names<'_> {
    fn find(&self, name: &str) -> Option<&(String, &'static str, &'static str)> {
        let key = crate::formula_catalog::normalize(name);
        self.known.iter().find(|(n, ..)| n == name).or_else(|| self.known.iter().find(|(n, ..)| crate::formula_catalog::normalize(n) == key))
    }
}

pub fn analyze(source: &str, names: &Names) -> Analysis {
    let mut highlights = Vec::new();
    let mut warnings = Vec::new();
    let tokens = match tokenize(source) {
        Ok(tokens) => tokens,
        Err(error) => {
            return Analysis { ok: false, highlights: vec![Highlight { kind: "error", start: error.start, end: error.end }], references: vec![], functions: vec![], result_type: "any", error: Some(error), warnings, blocks: None };
        }
    };
    let mut references = Vec::new();
    for (i, t) in tokens.iter().enumerate() {
        let kind = match &t.tok {
            Tok::Num(_) => "number",
            Tok::Str(_) => "text",
            Tok::Ref(name) => {
                let found = names.find(name);
                let suggestion = if found.is_none() { closest(name, names.known.iter().map(|(n, ..)| n.as_str())).map(String::from) } else { None };
                if found.is_none() {
                    let mut w = FormulaError::at(format!("Nothing is called “{name}” yet, so it is empty"), t.start, t.end);
                    if let Some(s) = &suggestion {
                        w = w.hint(format!("Did you mean {{{s}}}?"));
                    }
                    warnings.push(w);
                }
                references.push(Reference { name: name.clone(), start: t.start, end: t.end, kind: found.map_or("unknown", |f| f.1), suggestion });
                if found.is_some() { "field" } else { "unknown" }
            }
            Tok::Ident(word) => {
                let lower = word.to_lowercase();
                if matches!(tokens.get(i + 1), Some(Token { tok: Tok::Open, .. })) {
                    if function(word).is_some() { "function" } else { "error" }
                } else if ["true", "false", "null", "empty", "and", "or", "not"].contains(&lower.as_str()) {
                    "keyword"
                } else {
                    "error"
                }
            }
            Tok::Op(_) => "operator",
            Tok::Open | Tok::Close => "paren",
            Tok::Comma => "comma",
        };
        highlights.push(Highlight { kind, start: t.start, end: t.end });
    }
    match parse(source) {
        Ok(node) => {
            let mut functions = Vec::new();
            collect_functions(&node, &mut functions);
            let types = |name: &str| names.find(name).map_or("any", |f| f.2);
            let result_type = infer(&node, &types);
            Analysis { ok: true, highlights, references, functions, result_type, error: None, warnings, blocks: Some(to_blocks(&node)) }
        }
        Err(error) => Analysis { ok: false, highlights, references, functions: vec![], result_type: "any", error: Some(error), warnings, blocks: None },
    }
}

fn collect_functions(node: &Node, out: &mut Vec<String>) {
    match &node.kind {
        Kind::Call(spec, args) => {
            if !out.iter().any(|f| f == spec.name) {
                out.push(spec.name.into());
            }
            args.iter().for_each(|a| collect_functions(a, out));
        }
        Kind::Unary(_, a) => collect_functions(a, out),
        Kind::Binary(_, a, b) => {
            collect_functions(a, out);
            collect_functions(b, out);
        }
        _ => {}
    }
}

/// The names a formula refers to (for dependency order and cycle checks).
pub(crate) fn references(source: &str) -> Vec<String> {
    tokenize(source).map(|tokens| tokens.into_iter().filter_map(|t| if let Tok::Ref(n) = t.tok { Some(n) } else { None }).collect()).unwrap_or_default()
}

/// What a formula reads, for the stored values' dependency graph (formula_values.rs): the
/// names it refers to (`first_author()` reads `{First author}`), and whether it depends on
/// the day (`today()`, `days_since`, `days_until`). `None` when it does not parse.
pub(crate) fn dependencies(source: &str) -> Option<(Vec<String>, bool)> {
    fn walk(node: &Node, names: &mut Vec<String>, volatile: &mut bool) {
        match &node.kind {
            Kind::Ref(name) => names.push(name.clone()),
            Kind::Call(spec, args) => {
                match spec.name {
                    "today" | "days_since" | "days_until" => *volatile = true,
                    "first_author" if args.is_empty() => names.push("first author".into()),
                    _ => {}
                }
                args.iter().for_each(|a| walk(a, names, volatile));
            }
            Kind::Unary(_, a) => walk(a, names, volatile),
            Kind::Binary(_, a, b) => {
                walk(a, names, volatile);
                walk(b, names, volatile);
            }
            Kind::Lit(_) => {}
        }
    }
    let node = parse(source).ok()?;
    let (mut names, mut volatile) = (Vec::new(), false);
    walk(&node, &mut names, &mut volatile);
    Some((names, volatile))
}

/// The result type a formula has with the given field and property types.
pub fn infer_type(source: &str, types: &dyn Fn(&str) -> &'static str) -> &'static str {
    parse(source).map_or("any", |node| infer(&node, types))
}

// ---- Blocks: the formula as a tree the visual builder edits ------------------------------
//
// `{"t":"field","name":"Year"}`, `{"t":"text","v":"…"}`, `{"t":"number","v":2}`,
// `{"t":"bool","v":true}`, `{"t":"empty"}`, `{"t":"fn","name":"if","args":[…]}`,
// `{"t":"op","op":"+","args":[a, b]}` (one argument for `!` and unary `-`).

pub(crate) fn to_blocks(node: &Node) -> Json {
    match &node.kind {
        Kind::Lit(Value::Null) => json!({"t": "empty"}),
        Kind::Lit(Value::Bool(b)) => json!({"t": "bool", "v": b}),
        Kind::Lit(Value::Num(n)) => json!({"t": "number", "v": Value::Num(*n).to_json()}),
        Kind::Lit(v) => json!({"t": "text", "v": v.text()}),
        Kind::Ref(name) => json!({"t": "field", "name": name}),
        Kind::Call(spec, args) => json!({"t": "fn", "name": spec.name, "args": args.iter().map(to_blocks).collect::<Vec<_>>()}),
        Kind::Unary(op, a) => json!({"t": "op", "op": op, "args": [to_blocks(a)]}),
        Kind::Binary(op, a, b) => json!({"t": "op", "op": op, "args": [to_blocks(a), to_blocks(b)]}),
    }
}

fn quote(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn field_text(name: &str) -> String {
    if name.contains('}') { format!("[{name}]") } else { format!("{{{name}}}") }
}

/// Blocks back to formula text (`print(to_blocks(parse(x)))` means the same as `x`).
pub fn print(block: &Json) -> Result<String> {
    print_at(block, 0, 0)
}

fn print_at(block: &Json, parent: u8, depth: usize) -> Result<String> {
    if depth > MAX_DEPTH {
        return Err("These blocks nest too deeply".into());
    }
    let args = || block.get("args").and_then(Json::as_array).cloned().unwrap_or_default();
    Ok(match block.get("t").and_then(Json::as_str).unwrap_or("") {
        "empty" | "" => "empty".into(),
        "bool" => block.get("v").and_then(Json::as_bool).unwrap_or(false).to_string(),
        "number" => {
            let n = block.get("v").and_then(Json::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0);
            let text = number_text(n.abs());
            if n < 0.0 { format!("(-{text})") } else { text }
        }
        "text" => quote(block.get("v").and_then(Json::as_str).unwrap_or("")),
        "field" => {
            let name = block.get("name").and_then(Json::as_str).unwrap_or("").trim();
            if name.is_empty() || name.len() > 128 || (name.contains(']') && name.contains('}')) {
                return Err("Choose a property for every slot".into());
            }
            field_text(name)
        }
        "fn" => {
            let name = block.get("name").and_then(Json::as_str).unwrap_or("");
            let spec = function(name).ok_or_else(|| format!("There is no function called “{name}”"))?;
            let printed = args().iter().map(|a| print_at(a, 0, depth + 1)).collect::<Result<Vec<_>>>()?;
            format!("{}({})", spec.name, printed.join(", "))
        }
        "op" => {
            let op = block.get("op").and_then(Json::as_str).unwrap_or("");
            let args = args();
            match (op, args.as_slice()) {
                ("!" | "-", [a]) => {
                    let inner = print_at(a, UNARY, depth + 1)?;
                    if op == "!" { format!("not {inner}") } else { format!("-{inner}") }
                }
                (op, [a, b]) => {
                    let p = precedence(op).ok_or_else(|| format!("Unknown operator {op}"))?;
                    let shown = match op {
                        "&&" => "and",
                        "||" => "or",
                        other => other,
                    };
                    let text = format!("{} {shown} {}", print_at(a, p, depth + 1)?, print_at(b, p + 1, depth + 1)?);
                    if p < parent { format!("({text})") } else { text }
                }
                _ => return Err("An operator is missing a value".into()),
            }
        }
        other => return Err(format!("Unknown block {other}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn formula(source: &str, properties: Json) -> Result<Json> {
        evaluate(source, properties.as_object().unwrap()).map(|v| v.to_json())
    }

    #[test]
    fn typed_fields_and_arithmetic_precedence() {
        assert_eq!(formula("[year] + 2 * 3", json!({"year": 2020})), Ok(json!(2026)));
        assert_eq!(formula("([year] + 2) * 3", json!({"year": 2020})), Ok(json!(6066)));
        assert_eq!(formula("-2 * 3 + 10 % 4", json!({})), Ok(json!(-4)));
        assert_eq!(formula("1 / 4", json!({})), Ok(json!(0.25)));
    }

    #[test]
    fn curly_references_and_field_casing() {
        assert_eq!(formula("{Year} + {Pages}", json!({"year": 2020, "pages": 6})), Ok(json!(2026)));
    }

    #[test]
    fn text_and_predicates() {
        assert_eq!(formula("if([reviewed], upper([title]), \"pending\")", json!({"reviewed": true, "title": "Memory"})), Ok(json!("MEMORY")));
        assert_eq!(formula("contains(lower([title]), \"memory\")", json!({"title": "MEMORY systems"})), Ok(json!(true)));
        assert_eq!(formula("concat([a], '-', [b], 1.5)", json!({"a": "x", "b": null})), Ok(json!("x-1.5")));
        assert_eq!(formula("'it\\'s' + 1", json!({})), Ok(json!("it's1")));
        assert_eq!(formula("length(\"héllo\") == 5 && !false", json!({})), Ok(json!(true)));
        assert_eq!(formula("round(2.5) + round(-2.5)", json!({})), Ok(json!(1)));
        assert_eq!(formula("[n] >= 3 || [n] < 0", json!({"n": "4"})), Ok(json!(true)));
        assert_eq!(formula("[a] == [b]", json!({"a": 1, "b": "1"})), Ok(json!(false)));
    }

    #[test]
    fn rejects_executable_unknown_nonfinite_and_unbounded_expressions() {
        assert!(formula("process.exit()", json!({})).is_err());
        assert_eq!(formula("1 / 0", json!({})), Err("Division by zero".into()));
        assert!(formula(&format!("{}1{}", "(".repeat(40), ")".repeat(40)), json!({})).is_err());
        assert_eq!(formula("[obj]", json!({"obj": {"value": 1}})), Err("Formula properties must be scalar".into()));
        assert_eq!(formula("year", json!({})), Err("“year” is not a value".into()));
        assert_eq!(formula("nope(1)", json!({})), Err("There is no function called “nope”".into()));
        assert_eq!(formula("1 2", json!({})), Err("Something follows the end of the formula".into()));
        assert!(formula(&"1+".repeat(600), json!({})).is_err());
        assert!(formula("[a] * 2", json!({"a": "abc"})).is_err());
    }

    #[test]
    fn absent_fields_are_null_and_coalesce() {
        assert_eq!(formula("coalesce([missing], \"unknown\")", json!({})), Ok(json!("unknown")));
        assert_eq!(formula("[missing]", json!({})), Ok(Json::Null));
    }

    #[test]
    fn conditionals_are_lazy_and_words_work_as_operators() {
        // The untaken branch would divide by zero.
        assert_eq!(formula("if({n} = 0, 0, 10 / {n})", json!({"n": 0})), Ok(json!(0)));
        assert_eq!(formula("{a} > 1 and not {b}", json!({"a": 2, "b": false})), Ok(json!(true)));
        assert_eq!(formula("ifs({n} > 10, \"high\", {n} > 5, \"mid\", \"low\")", json!({"n": 7})), Ok(json!("mid")));
        assert_eq!(formula("{a} <> {b}", json!({"a": 1, "b": 2})), Ok(json!(true)));
        assert_eq!(formula("\"a\" & 1 & \"b\"", json!({})), Ok(json!("a1b")));
    }

    #[test]
    fn text_tools_and_safe_patterns() {
        assert_eq!(formula("first_author(\"Curie, Marie; Bohr, Niels\")", json!({})), Ok(json!("Curie")));
        assert_eq!(formula("first_author({authors})", json!({"authors": "Ada Lovelace; Alan Turing"})), Ok(json!("Lovelace")));
        assert_eq!(formula("extract_year(\"Published in March 2019 (v2)\")", json!({})), Ok(json!(2019)));
        assert_eq!(formula("extract({t}, \"n ?= ?(\\\\d+)\")", json!({"t": "We enrolled n = 120 adults"})), Ok(json!("120")));
        assert_eq!(formula("matches({t}, \"(?i)random\")", json!({"t": "A Randomised trial"})), Ok(json!(true)));
        assert_eq!(formula("replace_pattern(\"a1b22\", \"\\\\d+\", \"#\")", json!({})), Ok(json!("a#b#")));
        let error = evaluate_in("matches(\"x\", \"(\")", &MapScope(&Map::new())).unwrap_err();
        assert!(error.message.starts_with("The pattern is not valid"), "{error:?}");
        assert_eq!((error.start, error.end), (13, 16));
        assert_eq!(formula("left(\"abcdef\", 2) & right(\"abcdef\", 2) & slice(\"abcdef\", 3, 2)", json!({})), Ok(json!("abefcd")));
        assert_eq!(formula("capitalize(\"hello wORLD\")", json!({})), Ok(json!("Hello World")));
        assert_eq!(formula("format_number(1234567.891, 2)", json!({})), Ok(json!("1,234,567.89")));
        assert_eq!(formula("number(\"about 1,200 people\")", json!({})), Ok(json!(1200)));
        assert_eq!(formula("round(2.345, 2)", json!({})), Ok(json!(2.35)));
    }

    #[test]
    fn lists_and_counts() {
        let tags = json!({"tags": ["Method", "to read"]});
        assert_eq!(formula("has({tags}, \"TO READ\")", tags.clone()), Ok(json!(true)));
        assert_eq!(formula("count({tags})", tags.clone()), Ok(json!(2)));
        assert_eq!(formula("join({tags}, \" / \")", tags.clone()), Ok(json!("Method / to read")));
        assert_eq!(formula("has_all({tags}, \"method\", \"missing\")", tags.clone()), Ok(json!(false)));
        assert_eq!(formula("count(split(\"a; b;; c\"))", json!({})), Ok(json!(3)));
        assert_eq!(formula("sum(list(1, 2, 3)) + max(4, 9) + average(list(2, 4))", json!({})), Ok(json!(18)));
    }

    #[test]
    fn date_maths() {
        assert_eq!(formula("date(\"2024-03-01\") - date(\"2024-02-01\")", json!({})), Ok(json!(29)));
        assert_eq!(formula("year(\"4 March 2021\") * 100 + month(\"4 March 2021\")", json!({})), Ok(json!(202103)));
        assert_eq!(formula("add_days(date(2024, 12, 30), 3)", json!({})), Ok(json!("2025-01-02")));
        assert_eq!(formula("format_date(date(2024, 3, 5), \"short\")", json!({})), Ok(json!("5 Mar 2024")));
        assert_eq!(formula("days_between(\"2020\", \"2021\")", json!({})), Ok(json!(366)));
        assert_eq!(formula("days_since(today())", json!({})), Ok(json!(0)));
        assert_eq!(formula("date(\"2024-01-02\") > date(\"2023-12-31\")", json!({})), Ok(json!(true)));
        assert_eq!(formula("date(\"2024-01-02\") = \"2024-01-02\"", json!({})), Ok(json!(true)));
        for days in [-1000, 0, 19_000, 25_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
    }

    #[test]
    fn errors_say_what_and_where_in_plain_words() {
        let error = evaluate_in("{Year} + \"abc\" * 2", &MapScope(&Map::new())).unwrap_err();
        assert_eq!(error.message, "Expected a number, but this value is the text “abc”");
        assert_eq!((error.start, error.end), (9, 14));
        let error = parse("iff({a}, 1, 2)").unwrap_err();
        assert_eq!(error.hint.as_deref(), Some("Did you mean if()?"));
        let error = parse("round()").unwrap_err();
        assert_eq!(error.message, "round() takes 1 to 2 values, not 0");
        let error = parse("if({a}, 1").unwrap_err();
        assert_eq!(error.message, "A bracket is never closed");
        let error = parse("\"open").unwrap_err();
        assert_eq!(error.message, "This text is missing its closing quote");
    }

    #[test]
    fn analysis_types_highlights_and_unknown_names() {
        let known = vec![("Year".to_string(), "field", "number"), ("Title".to_string(), "field", "text"), ("Date added".to_string(), "field", "date")];
        let names = Names { known: &known };
        let a = analyze("if({Yaer} > 2000, upper({Title}), \"old\")", &names);
        assert!(a.ok);
        assert_eq!(a.result_type, "text");
        assert_eq!(a.references[0].suggestion.as_deref(), Some("Year"));
        assert_eq!(a.warnings.len(), 1);
        assert_eq!(a.highlights[0].kind, "function");
        assert_eq!(analyze("days_since({date added}) > 30", &names).result_type, "boolean");
        assert_eq!(analyze("{Date added} + 7", &names).result_type, "date");
        assert_eq!(analyze("round({Year} / 3, 1)", &names).result_type, "number");
        assert!(!analyze("1 +", &names).ok);
    }

    #[test]
    fn blocks_round_trip_through_text() {
        for source in [
            "if({Has PDF}, \"Ready\", \"Find PDF\")",
            "({a} + 2) * 3",
            "{a} + 2 * 3",
            "not {Read} and days_since({Date added}) > 30",
            "concat(first_author(), \" \", {Year})",
            "\"say \\\"hi\\\"\" & {x}",
            "-{n} + 1",
        ] {
            let node = parse(source).unwrap();
            let printed = print(&to_blocks(&node)).unwrap();
            let again = parse(&printed).unwrap();
            assert_eq!(to_blocks(&again), to_blocks(&node), "{source} → {printed}");
        }
        assert_eq!(print(&json!({"t": "op", "op": "*", "args": [{"t": "op", "op": "+", "args": [{"t": "number", "v": 1}, {"t": "number", "v": 2}]}, {"t": "number", "v": 3}]})).unwrap(), "(1 + 2) * 3");
        assert!(print(&json!({"t": "fn", "name": "nope", "args": []})).is_err());
    }
}
