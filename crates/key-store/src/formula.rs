// Formula properties: a small deterministic expression language over a source's properties
// and a few of its fields (`[year] + 1`, `if([read], upper([title]), "pending")`). No code
// execution or I/O; bounded in length, tokens, nesting and output. The library evaluates
// it for the table, the details, sorting and filtering (as the SQL function `key_formula`),
// batch edits ("set to formula") and exports, so every place agrees on one value.
use crate::{Creator, Result, Source};
use rusqlite::functions::{Context, FunctionFlags};
use rusqlite::{Connection, types::ValueRef};
use serde_json::{Map, Value as Json};

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
}

impl Value {
    pub fn to_json(&self) -> Json {
        match self {
            Value::Null => Json::Null,
            Value::Bool(b) => Json::Bool(*b),
            Value::Num(n) if n.fract() == 0.0 && n.abs() < 9.0e15 => Json::from(*n as i64),
            Value::Num(n) => serde_json::Number::from_f64(*n).map_or(Json::Null, Json::Number),
            Value::Str(s) => Json::String(s.clone()),
        }
    }
    fn truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Num(n) => *n != 0.0 && !n.is_nan(),
            Value::Str(s) => !s.is_empty(),
        }
    }
    /// The value as text the way the formula language shows it (`String(v ?? "")`).
    pub fn text(&self) -> String {
        match self {
            Value::Null => String::new(),
            Value::Bool(b) => b.to_string(),
            Value::Num(n) => number_text(*n),
            Value::Str(s) => s.clone(),
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

fn number(v: Option<&Value>) -> Result<f64> {
    let n = match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Num(n)) => *n,
        Some(Value::Str(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else if t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E')) {
                t.parse().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
    };
    if n.is_finite() { Ok(n) } else { Err("Expected a finite number".into()) }
}

fn from_json(value: &Json) -> Result<Value> {
    Ok(match value {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => Value::Num(n.as_f64().unwrap_or(f64::NAN)),
        Json::String(s) => Value::Str(s.clone()),
        _ => return Err("Formula properties must be scalar".into()),
    })
}

fn tokenize(source: &str) -> Result<Vec<String>> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    let near = |i: usize| chars[i..].iter().take(15).collect::<String>();
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        let c = chars[i];
        let start = i;
        match c {
            '[' | '{' => {
                let close = if c == '[' { ']' } else { '}' };
                let end = chars[i + 1..].iter().position(|&x| x == close).map(|p| i + 1 + p);
                match end {
                    Some(end) if end > i + 1 && end - i - 1 <= 128 => i = end + 1,
                    _ => return Err(format!("Invalid formula near {}", near(start))),
                }
            }
            '"' | '\'' => {
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err(format!("Invalid formula near {}", near(start))),
                        Some('\\') => i += 2,
                        Some(&q) if q == c => {
                            i += 1;
                            break;
                        }
                        Some(_) => i += 1,
                    }
                }
                if i > chars.len() {
                    return Err(format!("Invalid formula near {}", near(start)));
                }
            }
            '0'..='9' | '.' => {
                if c == '.' && !chars.get(i + 1).is_some_and(char::is_ascii_digit) {
                    return Err(format!("Invalid formula near {}", near(start)));
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
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                while chars.get(i).is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_') {
                    i += 1;
                }
            }
            _ => {
                let rest: String = chars[i..].iter().take(3).collect();
                let op = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||"].into_iter().find(|op| rest.starts_with(op));
                match op {
                    Some(op) => i += op.chars().count(),
                    None if "+-*/%(),<>!".contains(c) => i += 1,
                    None => return Err(format!("Invalid formula near {}", near(start))),
                }
            }
        }
        tokens.push(chars[start..i].iter().collect());
        if tokens.len() > 512 {
            return Err("Formula is too complex".into());
        }
    }
    Ok(tokens)
}

fn precedence(token: &str) -> Option<u8> {
    Some(match token {
        "||" => 1,
        "&&" => 2,
        "==" | "===" | "!=" | "!==" => 3,
        "<" | ">" | "<=" | ">=" => 4,
        "+" | "-" => 5,
        "*" | "/" | "%" => 6,
        _ => return None,
    })
}

fn apply(op: &str, a: Value, b: Value) -> Result<Value> {
    let (x, y) = (Some(&a), Some(&b));
    Ok(match op {
        "+" if matches!(a, Value::Str(_)) || matches!(b, Value::Str(_)) => Value::Str(a.text() + &b.text()),
        "+" => Value::Num(number(x)? + number(y)?),
        "-" => Value::Num(number(x)? - number(y)?),
        "*" => Value::Num(number(x)? * number(y)?),
        "/" | "%" => {
            let (n, d) = (number(x)?, number(y)?);
            if d == 0.0 {
                return Err("Division by zero".into());
            }
            Value::Num(if op == "/" { n / d } else { n % d })
        }
        "==" | "===" => Value::Bool(a == b),
        "!=" | "!==" => Value::Bool(a != b),
        "<" => Value::Bool(number(x)? < number(y)?),
        ">" => Value::Bool(number(x)? > number(y)?),
        "<=" => Value::Bool(number(x)? <= number(y)?),
        ">=" => Value::Bool(number(x)? >= number(y)?),
        "&&" => Value::Bool(a.truthy() && b.truthy()),
        "||" => Value::Bool(a.truthy() || b.truthy()),
        _ => return Err("Unknown operator".into()),
    })
}

struct Parser<'a> {
    tokens: Vec<String>,
    index: usize,
    depth: usize,
    properties: &'a Map<String, Json>,
}

impl Parser<'_> {
    fn next(&mut self) -> Option<String> {
        let t = self.tokens.get(self.index).cloned();
        self.index += 1;
        t
    }
    fn peek(&self) -> Option<&str> {
        self.tokens.get(self.index).map(String::as_str)
    }

    fn property(&self, name: &str) -> Result<Value> {
        let raw = self.properties.get(name).or_else(|| self.properties.iter().find(|(k, _)| k.to_lowercase() == name.to_lowercase()).map(|(_, v)| v));
        raw.map_or(Ok(Value::Null), from_json)
    }

    fn expression(&mut self, minimum: u8) -> Result<Value> {
        self.depth += 1;
        if self.depth > 32 {
            return Err("Formula nesting exceeds 32".into());
        }
        let t = self.next().ok_or("Expected a value")?;
        let mut value = if t == "(" {
            let v = self.expression(0)?;
            if self.next().as_deref() != Some(")") {
                return Err("Expected )".into());
            }
            v
        } else if t == "-" || t == "+" || t == "!" {
            let rhs = self.expression(7)?;
            match t.as_str() {
                "!" => Value::Bool(!rhs.truthy()),
                "-" => Value::Num(-number(Some(&rhs))?),
                _ => Value::Num(number(Some(&rhs))?),
            }
        } else if t.starts_with('[') || t.starts_with('{') {
            self.property(&t[1..t.len() - 1])?
        } else if t.starts_with(|c: char| c.is_ascii_digit() || c == '.') {
            Value::Num(t.parse().map_err(|_| format!("Invalid number {t}"))?)
        } else if t.starts_with('"') {
            Value::Str(serde_json::from_str(&t).map_err(|_| format!("Invalid text {t}"))?)
        } else if t.starts_with('\'') {
            Value::Str(t[1..t.len() - 1].replace("\\'", "'").replace("\\\\", "\\"))
        } else if t == "true" || t == "false" {
            Value::Bool(t == "true")
        } else if t == "null" {
            Value::Null
        } else {
            if self.next().as_deref() != Some("(") {
                return Err(format!("Use [{t}] to reference a property"));
            }
            let mut args = Vec::new();
            if self.peek() != Some(")") {
                loop {
                    args.push(self.expression(0)?);
                    if self.peek() != Some(",") {
                        break;
                    }
                    self.index += 1;
                }
            }
            if self.next().as_deref() != Some(")") {
                return Err("Expected )".into());
            }
            let text = |i: usize| args.get(i).map(Value::text).unwrap_or_default();
            match t.to_lowercase().as_str() {
                "concat" => Value::Str(args.iter().map(Value::text).collect()),
                "lower" => Value::Str(text(0).to_lowercase()),
                "upper" => Value::Str(text(0).to_uppercase()),
                "length" => Value::Num(text(0).chars().count() as f64),
                "round" => {
                    let x = number(args.first())?;
                    let f = x.floor();
                    Value::Num(if x - f >= 0.5 { f + 1.0 } else { f })
                }
                "contains" => Value::Bool(text(0).contains(&text(1))),
                "if" => {
                    if args.len() != 3 {
                        return Err("if requires condition, true value, false value".into());
                    }
                    let mut args = args;
                    let otherwise = args.pop().unwrap_or(Value::Null);
                    let then = args.pop().unwrap_or(Value::Null);
                    if args[0].truthy() { then } else { otherwise }
                }
                "coalesce" => args.into_iter().find(|v| *v != Value::Null).unwrap_or(Value::Null),
                _ => return Err(format!("Unknown function {t}")),
            }
        };
        while let Some(p) = self.peek().and_then(precedence).filter(|p| *p >= minimum) {
            let op = self.next().unwrap_or_default();
            let rhs = self.expression(p + 1)?;
            value = apply(&op, value, rhs)?;
        }
        self.depth -= 1;
        match &value {
            Value::Str(s) if s.chars().count() > 65536 => Err("Formula output too long".into()),
            Value::Num(n) if !n.is_finite() => Err("Formula result is not finite".into()),
            _ => Ok(value),
        }
    }
}

/// Evaluates a formula over named values (the source's properties and fields).
pub fn evaluate(source: &str, properties: &Map<String, Json>) -> Result<Value> {
    if source.encode_utf16().count() > 4096 {
        return Err("Formula exceeds 4,096 characters".into());
    }
    let tokens = tokenize(source)?;
    let mut parser = Parser { tokens, index: 0, depth: 0, properties };
    let result = parser.expression(0)?;
    if parser.index != parser.tokens.len() {
        return Err("Unexpected trailing expression".into());
    }
    Ok(result)
}

fn creator_names(creators: &[Creator]) -> String {
    creators
        .iter()
        .filter_map(|c| {
            c.literal.clone().filter(|l| !l.trim().is_empty()).or_else(|| {
                let name = [c.given.as_deref(), c.family.as_deref()].into_iter().flatten().filter(|p| !p.trim().is_empty()).collect::<Vec<_>>().join(" ");
                (!name.is_empty()).then_some(name)
            })
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// What a formula sees for a source: its properties, then (taking precedence) `title`,
/// `year`, `pages`, `authors` and `journal`.
pub fn context(properties: &Map<String, Json>, title: Option<&str>, year: Option<i64>, pages: Option<i64>, creators: &[Creator], journal: Option<&str>) -> Map<String, Json> {
    let mut out = properties.clone();
    let title = Json::from(title.unwrap_or(""));
    let year = year.map_or(Json::Null, Json::from);
    let pages = Json::from(pages.unwrap_or(0));
    for (key, value) in [("title", &title), ("Title", &title), ("year", &year), ("Year", &year), ("pages", &pages), ("Pages", &pages)] {
        out.insert(key.into(), value.clone());
    }
    out.insert("authors".into(), Json::from(creator_names(creators)));
    out.insert("journal".into(), Json::from(journal.unwrap_or("")));
    out
}

pub fn source_context(source: &Source) -> Map<String, Json> {
    let page_count = source.fields.get("pageCount").and_then(Json::as_i64);
    let year = source.fields.get("year").and_then(Json::as_i64);
    context(&source.properties, Some(source.title()), year, page_count, &source.creators, source.field("containerTitle"))
}

/// The formula properties' values for a source: `{name: value}`, or `{name: {"error": …}}`.
pub fn values_for(source: &Source, formulas: &[(String, String)]) -> Map<String, Json> {
    let context = source_context(source);
    formulas
        .iter()
        .map(|(name, formula)| {
            let value = match evaluate(formula, &context) {
                Ok(v) => v.to_json(),
                Err(error) => serde_json::json!({ "error": error }),
            };
            (name.clone(), value)
        })
        .collect()
}

/// The defined formula properties, `(name, formula)`.
pub(crate) fn definitions(db: &Connection) -> Result<Vec<(String, String)>> {
    let mut statement = db
        .prepare("SELECT name, json_extract(config, '$.formula') FROM property_definitions WHERE json_extract(config, '$.type') = 'formula' ORDER BY name")
        .map_err(crate::e)?;
    let rows = statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default()))).map_err(crate::e)?;
    rows.collect::<std::result::Result<_, _>>().map_err(crate::e)
}

/// Puts each formula property's value on the sources as `formulaValues` (what the table,
/// details and exports show).
pub(crate) fn decorate(db: &Connection, sources: &mut [Source]) -> Result<()> {
    let formulas = definitions(db)?;
    if formulas.is_empty() {
        return Ok(());
    }
    for source in sources {
        let values = values_for(source, &formulas);
        source.fields.insert("formulaValues".into(), Json::Object(values));
    }
    Ok(())
}

/// `key_formula(formula, properties, title, year, page_count, creators, container_title)`:
/// the value, or NULL when the formula fails.
pub(crate) fn register(db: &Connection) -> Result<()> {
    db.create_scalar_function("key_formula", 7, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx: &Context| {
        let text = |i: usize| -> Option<String> {
            match ctx.get_raw(i) {
                ValueRef::Text(t) => std::str::from_utf8(t).ok().map(String::from),
                _ => None,
            }
        };
        let int = |i: usize| -> Option<i64> {
            match ctx.get_raw(i) {
                ValueRef::Integer(n) => Some(n),
                ValueRef::Real(f) => Some(f as i64),
                _ => None,
            }
        };
        let Some(formula) = text(0) else { return Ok(rusqlite::types::Value::Null) };
        let properties: Map<String, Json> = text(1).and_then(|p| serde_json::from_str(&p).ok()).unwrap_or_default();
        let creators: Vec<Creator> = text(5).and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default();
        let context = context(&properties, text(2).as_deref(), int(3), int(4), &creators, text(6).as_deref());
        Ok(match evaluate(&formula, &context) {
            Ok(Value::Null) | Err(_) => rusqlite::types::Value::Null,
            Ok(Value::Bool(b)) => rusqlite::types::Value::Integer(i64::from(b)),
            Ok(Value::Num(n)) if n.fract() == 0.0 && n.abs() < 9.0e15 => rusqlite::types::Value::Integer(n as i64),
            Ok(Value::Num(n)) => rusqlite::types::Value::Real(n),
            Ok(Value::Str(s)) => rusqlite::types::Value::Text(s),
        })
    })
    .map_err(crate::e)
}

/// SQL for a property's value on `sources s`: the formula's result for a formula
/// property, else the stored value.
pub(crate) fn property_sql(name: &str) -> String {
    let path: String = name.chars().filter(|c| !matches!(c, '"' | '\\' | '\0')).collect::<String>().replace('\'', "''");
    let literal = name.replace('\'', "''");
    format!(
        "(CASE WHEN (SELECT json_extract(config, '$.type') FROM property_definitions WHERE name = '{literal}') = 'formula' \
         THEN key_formula((SELECT json_extract(config, '$.formula') FROM property_definitions WHERE name = '{literal}'), s.properties, s.title, s.year, s.page_count, s.creators, s.container_title) \
         ELSE json_extract(s.properties, '$.\"{path}\"') END)"
    )
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
        assert_eq!(formula("year", json!({})), Err("Use [year] to reference a property".into()));
        assert_eq!(formula("nope(1)", json!({})), Err("Unknown function nope".into()));
        assert_eq!(formula("1 2", json!({})), Err("Unexpected trailing expression".into()));
        assert!(formula(&"1+".repeat(300), json!({})).is_err());
        assert!(formula("[a] * 2", json!({"a": "abc"})).is_err());
    }

    #[test]
    fn absent_fields_are_null_and_coalesce() {
        assert_eq!(formula("coalesce([missing], \"unknown\")", json!({})), Ok(json!("unknown")));
        assert_eq!(formula("[missing]", json!({})), Ok(Json::Null));
    }

    #[test]
    fn sorts_and_filters_by_a_formula_property() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::Store::open(dir.path()).unwrap();
        for (title, pages) in [("Short", 3), ("Long", 40), ("Medium", 12)] {
            let input: crate::SourceInput = serde_json::from_value(json!({"kind": "reference", "title": title, "properties": {"pages read": pages}})).unwrap();
            store.insert_source(input).unwrap();
        }
        store.save_property_definition("Left", &json!({"type": "formula", "formula": "100 - [pages read]"})).unwrap();
        let query: crate::ListQuery = serde_json::from_value(json!({"sorts": [{"field": "property:Left"}]})).unwrap();
        let titles: Vec<String> = store.list_sources(&query).unwrap().items.iter().map(|s| s.title().to_string()).collect();
        assert_eq!(titles, ["Long", "Medium", "Short"]);
        let query: crate::ListQuery = serde_json::from_value(json!({"filters": [{"field": "property", "key": "Left", "op": "is", "value": "88"}]})).unwrap();
        let page = store.list_sources(&query).unwrap();
        assert_eq!(page.items.iter().map(|s| s.title()).collect::<Vec<_>>(), ["Medium"]);
        assert_eq!(page.items[0].fields["formulaValues"], json!({"Left": 88}));
    }
}
