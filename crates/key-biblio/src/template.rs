// A small Handlebars-like template language, shared by the Markdown export (highlights and
// notes) and file naming rules.
//
//   {{title}}  {{source.doi}}  {{{raw}}} (the same: nothing is escaped)
//   {{title | truncate 60 | lower}}  {{title truncate=60}}  {{tags | join ", "}}
//   {{#each annotations}} {{text}} {{@index}} {{/each}}   (`this` is the item; outer names
//   are found too)   {{#if comment}} … {{else}} … {{/if}}   {{#unless x}} … {{/unless}}
//   {{! a comment }}
//
// A block tag alone on its line takes its line with it, so templates can be laid out
// readably. Filters: truncate N, lower, upper, capitalize, trim, default "x", join ", ",
// first, last, count, quote (prefixes every line with "> "), yaml (a quoted YAML scalar),
// ascii (removes diacritics), replace "a" "b", prefix "x", suffix "x".
//
// An object in an `each` list may carry `__begin` and `__end` strings: they are written
// around that item's output (the export's per-annotation id comments).
use serde_json::Value as Json;
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, PartialEq)]
enum Node {
    Text(String),
    Var { path: String, filters: Vec<Filter> },
    Each { path: String, body: Vec<Node>, otherwise: Vec<Node> },
    If { path: String, negate: bool, body: Vec<Node>, otherwise: Vec<Node> },
}

#[derive(Clone, Debug, PartialEq)]
struct Filter {
    name: String,
    args: Vec<String>,
}

const FILTERS: &[&str] = &["truncate", "lower", "upper", "capitalize", "trim", "default", "join", "first", "last", "count", "quote", "yaml", "ascii", "replace", "prefix", "suffix"];

/// A parsed template.
#[derive(Clone, Debug)]
pub struct Template {
    nodes: Vec<Node>,
}

#[derive(Debug)]
enum Token {
    Text(String),
    Tag { body: String, line: usize, block: bool },
}

impl Template {
    pub fn parse(source: &str) -> Result<Self, String> {
        let tokens = standalone(tokenize(source)?);
        let mut at = 0;
        let nodes = parse_nodes(&tokens, &mut at, None)?;
        Ok(Self { nodes })
    }

    pub fn render(&self, data: &Json) -> String {
        let mut out = String::new();
        let scopes = vec![Scope { value: data, index: None }];
        render_nodes(&self.nodes, &scopes, &mut out);
        out
    }
}

/// Parses and renders in one go.
pub fn render(source: &str, data: &Json) -> Result<String, String> {
    Ok(Template::parse(source)?.render(data))
}

fn tokenize(source: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut rest = source;
    let mut line = 1;
    while let Some(start) = rest.find("{{") {
        if start > 0 {
            tokens.push(Token::Text(rest[..start].to_string()));
        }
        line += rest[..start].matches('\n').count();
        let after = &rest[start..];
        let (open, close) = if after.starts_with("{{{") { (3, "}}}") } else { (2, "}}") };
        let end = after[open..].find(close).ok_or_else(|| format!("Line {line}: a tag is not closed with {close}"))?;
        let body = after[open..open + end].trim().to_string();
        let block = body.starts_with('#') || body.starts_with('/') || body.starts_with('!') || body == "else";
        line += after[..open + end].matches('\n').count();
        tokens.push(Token::Tag { body, line, block });
        rest = &after[open + end + close.len()..];
    }
    if !rest.is_empty() {
        tokens.push(Token::Text(rest.to_string()));
    }
    Ok(tokens)
}

/// Drops the line of a block tag that stands alone on it.
fn standalone(mut tokens: Vec<Token>) -> Vec<Token> {
    let alone: Vec<bool> = (0..tokens.len()).map(|i| is_standalone(&tokens, i)).collect();
    for (i, alone) in alone.into_iter().enumerate() {
        if !alone {
            continue;
        }
        if let Some(Token::Text(t)) = i.checked_sub(1).map(|j| &mut tokens[j]) {
            let keep = t.rfind('\n').map_or(0, |n| n + 1);
            t.truncate(keep);
        }
        if let Some(Token::Text(t)) = tokens.get_mut(i + 1) {
            *t = match t.find('\n') {
                Some(n) => t[n + 1..].to_string(),
                None => String::new(),
            };
        }
    }
    tokens
}

fn is_standalone(tokens: &[Token], i: usize) -> bool {
    {
        if !matches!(tokens[i], Token::Tag { block: true, .. }) {
            return false;
        }
        let before_ok = match i.checked_sub(1).map(|j| &tokens[j]) {
            None => true,
            Some(Token::Text(t)) => {
                let tail = t.rsplit('\n').next().unwrap_or("");
                tail.chars().all(|c| c == ' ' || c == '\t') && (t.contains('\n') || i == 1)
            }
            Some(_) => false,
        };
        let after_ok = match tokens.get(i + 1) {
            None => true,
            Some(Token::Text(t)) => {
                let head = t.split('\n').next().unwrap_or("");
                head.chars().all(|c| c == ' ' || c == '\t' || c == '\r') && (t.contains('\n') || i + 2 == tokens.len())
            }
            Some(_) => false,
        };
        before_ok && after_ok
    }
}

fn parse_nodes(tokens: &[Token], at: &mut usize, open: Option<(&str, usize)>) -> Result<Vec<Node>, String> {
    let mut nodes = Vec::new();
    while *at < tokens.len() {
        match &tokens[*at] {
            Token::Text(t) => {
                if !t.is_empty() {
                    nodes.push(Node::Text(t.clone()));
                }
                *at += 1;
            }
            Token::Tag { body, line, .. } => {
                let line = *line;
                if body.starts_with('!') {
                    *at += 1;
                } else if body == "else" {
                    if open.is_none() {
                        return Err(format!("Line {line}: {{{{else}}}} outside a block"));
                    }
                    return Ok(nodes);
                } else if let Some(name) = body.strip_prefix('/') {
                    let name = name.trim();
                    return match open {
                        Some((kind, _)) if kind == name => Ok(nodes),
                        Some((kind, _)) => Err(format!("Line {line}: {{{{/{name}}}}} closes a {{{{#{kind}}}}} block")),
                        None => Err(format!("Line {line}: {{{{/{name}}}}} has no opening tag")),
                    };
                } else if let Some(rest) = body.strip_prefix('#') {
                    let (kind, path) = rest.split_once(char::is_whitespace).map(|(k, p)| (k, p.trim())).unwrap_or((rest, ""));
                    if !matches!(kind, "each" | "if" | "unless") {
                        return Err(format!("Line {line}: unknown block {{{{#{kind}}}}}"));
                    }
                    if path.is_empty() {
                        return Err(format!("Line {line}: {{{{#{kind}}}}} needs a name"));
                    }
                    *at += 1;
                    let body_nodes = parse_nodes(tokens, at, Some((kind, line)))?;
                    let mut otherwise = Vec::new();
                    match tokens.get(*at) {
                        Some(Token::Tag { body, .. }) if body == "else" => {
                            *at += 1;
                            otherwise = parse_nodes(tokens, at, Some((kind, line)))?;
                            if !matches!(tokens.get(*at), Some(Token::Tag { body, .. }) if body.starts_with('/')) {
                                return Err(format!("Line {line}: {{{{#{kind}}}}} is not closed"));
                            }
                        }
                        Some(Token::Tag { body, .. }) if body.starts_with('/') => {}
                        _ => return Err(format!("Line {line}: {{{{#{kind}}}}} is not closed")),
                    }
                    *at += 1;
                    let path = path.to_string();
                    nodes.push(match kind {
                        "each" => Node::Each { path, body: body_nodes, otherwise },
                        _ => Node::If { path, negate: kind == "unless", body: body_nodes, otherwise },
                    });
                } else {
                    nodes.push(parse_var(body, line)?);
                    *at += 1;
                }
            }
        }
    }
    match open {
        Some((kind, line)) => Err(format!("Line {line}: {{{{#{kind}}}}} is not closed")),
        None => Ok(nodes),
    }
}

/// Splits on whitespace, keeping "quoted strings" whole.
fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        let mut word = String::new();
        if c == '"' || c == '\'' {
            chars.next();
            for d in chars.by_ref() {
                if d == c {
                    break;
                }
                word.push(d);
            }
        } else {
            while let Some(&d) = chars.peek() {
                if d.is_whitespace() {
                    break;
                }
                word.push(d);
                chars.next();
            }
            // name="value with spaces"
            if word.ends_with('=') && matches!(chars.peek(), Some('"') | Some('\'')) {
                let quote = chars.next().unwrap_or('"');
                for d in chars.by_ref() {
                    if d == quote {
                        break;
                    }
                    word.push(d);
                }
            }
        }
        out.push(word);
    }
    out
}

fn parse_var(body: &str, line: usize) -> Result<Node, String> {
    let mut parts = body.split('|');
    let head = words(parts.next().unwrap_or(""));
    let path = head.first().cloned().ok_or_else(|| format!("Line {line}: an empty tag"))?;
    let mut filters = Vec::new();
    // `{{title truncate=60}}`
    for word in &head[1..] {
        let (name, arg) = word.split_once('=').ok_or_else(|| format!("Line {line}: “{word}” — use {{{{{path} | {word}}}}}"))?;
        filters.push(Filter { name: name.into(), args: vec![arg.into()] });
    }
    for part in parts {
        let mut w = words(part);
        if w.is_empty() {
            return Err(format!("Line {line}: an empty filter after |"));
        }
        let name = w.remove(0);
        filters.push(Filter { name, args: w });
    }
    for filter in &filters {
        if !FILTERS.contains(&filter.name.as_str()) {
            return Err(format!("Line {line}: unknown filter “{}”", filter.name));
        }
    }
    Ok(Node::Var { path, filters })
}

struct Scope<'a> {
    value: &'a Json,
    index: Option<(usize, usize)>,
}

fn lookup<'a>(path: &str, scopes: &'a [Scope<'a>]) -> Option<Json> {
    let top = scopes.last()?;
    match path {
        "this" | "." => return Some(top.value.clone()),
        "@index" => return top.index.map(|(i, _)| Json::from(i)),
        "@number" => return top.index.map(|(i, _)| Json::from(i + 1)),
        "@first" => return top.index.map(|(i, _)| Json::Bool(i == 0)),
        "@last" => return top.index.map(|(i, n)| Json::Bool(i + 1 == n)),
        _ => {}
    }
    let path = path.strip_prefix("this.").unwrap_or(path);
    let mut segments = path.split('.');
    let first = segments.next()?;
    let start = scopes.iter().rev().find_map(|s| s.value.as_object().and_then(|o| o.get(first)))?;
    let mut value = start;
    for segment in segments {
        value = match value {
            Json::Object(o) => o.get(segment)?,
            Json::Array(a) => a.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(value.clone())
}

pub fn truthy(value: &Json) -> bool {
    match value {
        Json::Null => false,
        Json::Bool(b) => *b,
        Json::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Json::String(s) => !s.is_empty(),
        Json::Array(a) => !a.is_empty(),
        Json::Object(o) => !o.is_empty(),
    }
}

pub fn text(value: &Json) -> String {
    match value {
        Json::Null => String::new(),
        Json::String(s) => s.clone(),
        Json::Bool(b) => b.to_string(),
        Json::Number(n) => n.to_string(),
        Json::Array(a) => a.iter().map(text).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", "),
        Json::Object(o) => o.get("name").or_else(|| o.get("title")).map(text).unwrap_or_default(),
    }
}

fn render_nodes(nodes: &[Node], scopes: &[Scope], out: &mut String) {
    for node in nodes {
        match node {
            Node::Text(t) => out.push_str(t),
            Node::Var { path, filters } => {
                let mut value = lookup(path, scopes).unwrap_or(Json::Null);
                for filter in filters {
                    value = apply(filter, value);
                }
                out.push_str(&text(&value));
            }
            Node::If { path, negate, body, otherwise } => {
                let on = lookup(path, scopes).is_some_and(|v| truthy(&v)) != *negate;
                render_nodes(if on { body } else { otherwise }, scopes, out);
            }
            Node::Each { path, body, otherwise } => {
                let value = lookup(path, scopes).unwrap_or(Json::Null);
                let items: Vec<Json> = match value {
                    Json::Array(a) => a,
                    Json::Null => Vec::new(),
                    Json::Object(o) => o.into_iter().map(|(k, v)| serde_json::json!({ "key": k, "value": v })).collect(),
                    other => vec![other],
                };
                if items.is_empty() {
                    render_nodes(otherwise, scopes, out);
                    continue;
                }
                let n = items.len();
                for (i, item) in items.iter().enumerate() {
                    let mut inner: Vec<Scope> = scopes.iter().map(|s| Scope { value: s.value, index: s.index }).collect();
                    inner.push(Scope { value: item, index: Some((i, n)) });
                    let wrap = |key: &str| item.get(key).and_then(Json::as_str).map(String::from);
                    if let Some(begin) = wrap("__begin") {
                        out.push_str(&begin);
                    }
                    render_nodes(body, &inner, out);
                    if let Some(end) = wrap("__end") {
                        if !out.ends_with('\n') && !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(&end);
                    }
                }
            }
        }
    }
}

fn arg_usize(filter: &Filter, at: usize) -> Option<usize> {
    filter.args.get(at).and_then(|a| a.parse().ok())
}

fn apply(filter: &Filter, value: Json) -> Json {
    let s = || text(&value);
    let arg = |i: usize| filter.args.get(i).cloned().unwrap_or_default();
    match filter.name.as_str() {
        "truncate" => Json::String(truncate(&s(), arg_usize(filter, 0).unwrap_or(60))),
        "lower" => Json::String(s().to_lowercase()),
        "upper" => Json::String(s().to_uppercase()),
        "capitalize" => {
            let t = s();
            let mut c = t.chars();
            Json::String(c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default())
        }
        "trim" => Json::String(s().trim().to_string()),
        "default" => if truthy(&value) { value } else { Json::String(arg(0)) },
        "join" => match &value {
            Json::Array(a) => Json::String(a.iter().map(text).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(&if filter.args.is_empty() { ", ".to_string() } else { arg(0) })),
            _ => value,
        },
        "first" => match value {
            Json::Array(a) => a.into_iter().next().unwrap_or(Json::Null),
            other => other,
        },
        "last" => match value {
            Json::Array(a) => a.into_iter().last().unwrap_or(Json::Null),
            other => other,
        },
        "count" => Json::from(match &value {
            Json::Array(a) => a.len(),
            Json::Object(o) => o.len(),
            Json::Null => 0,
            other => text(other).chars().count(),
        }),
        "quote" => Json::String(s().lines().map(|l| if l.is_empty() { ">".to_string() } else { format!("> {l}") }).collect::<Vec<_>>().join("\n")),
        "yaml" => Json::String(yaml_scalar(&s())),
        "ascii" => Json::String(fold_ascii(&s())),
        "replace" => Json::String(s().replace(&arg(0), &arg(1))),
        "prefix" => if truthy(&value) { Json::String(format!("{}{}", arg(0), s())) } else { value },
        "suffix" => if truthy(&value) { Json::String(format!("{}{}", s(), arg(0))) } else { value },
        _ => value,
    }
}

/// At most `max` characters, cut at a word boundary when one is near the end.
pub fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    let boundary = cut.rfind(char::is_whitespace).filter(|&b| cut[..b].chars().count() * 10 >= max * 6);
    let out = match boundary {
        Some(b) => &cut[..b],
        None => &cut,
    };
    out.trim_end_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | ':' | '-' | '–' | '—')).to_string()
}

/// Removes diacritics and spells out letters that have no ASCII form (ß → ss, Ø → O).
pub fn fold_ascii(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        let mapped = match c {
            'ß' => Some("ss"),
            'æ' => Some("ae"),
            'Æ' => Some("AE"),
            'œ' => Some("oe"),
            'Œ' => Some("OE"),
            'ø' => Some("o"),
            'Ø' => Some("O"),
            'ł' => Some("l"),
            'Ł' => Some("L"),
            'đ' | 'ð' => Some("d"),
            'Đ' | 'Ð' => Some("D"),
            'þ' => Some("th"),
            'Þ' => Some("Th"),
            'ı' => Some("i"),
            '‘' | '’' | '‚' | '′' => Some("'"),
            '“' | '”' | '„' | '″' => Some("\""),
            '–' | '—' | '‐' | '‑' => Some("-"),
            '…' => Some("..."),
            _ => None,
        };
        if let Some(m) = mapped {
            out.push_str(m);
            continue;
        }
        for d in c.to_string().nfd() {
            if !unicode_normalization::char::is_combining_mark(d) {
                out.push(d);
            }
        }
    }
    out
}

/// A YAML scalar: plain when that is safe, else double-quoted.
pub fn yaml_scalar(text: &str) -> String {
    let plain = !text.is_empty()
        && !text.starts_with(|c: char| c.is_whitespace() || "-?:,[]{}#&*!|>'\"%@`".contains(c))
        && !text.ends_with(char::is_whitespace)
        && !text.contains(": ")
        && !text.contains(" #")
        && !text.contains('\n')
        && !matches!(text.to_ascii_lowercase().as_str(), "true" | "false" | "yes" | "no" | "null" | "~" | "on" | "off")
        && text.parse::<f64>().is_err();
    if plain {
        return text.to_string();
    }
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn variables_filters_and_paths() {
        let data = json!({ "title": "Über die Natur der Dinge", "source": { "doi": "10.1/x" }, "tags": ["a", "b"] });
        assert_eq!(render("{{title}} — {{source.doi}}", &data).unwrap(), "Über die Natur der Dinge — 10.1/x");
        assert_eq!(render("{{title | truncate 12}}", &data).unwrap(), "Über die");
        assert_eq!(render("{{title truncate=12 | ascii}}", &data).unwrap(), "Uber die");
        assert_eq!(render("{{tags | join \"; \"}}", &data).unwrap(), "a; b");
        assert_eq!(render("{{missing | default \"n.d.\"}}", &data).unwrap(), "n.d.");
        assert_eq!(render("{{{title | upper}}}", &data).unwrap(), "ÜBER DIE NATUR DER DINGE");
    }

    #[test]
    fn blocks_and_standalone_lines() {
        let data = json!({ "items": [{ "t": "one", "c": "note" }, { "t": "two" }], "name": "outer" });
        let template = "List\n{{#each items}}\n- {{t}} ({{@number}}/{{name}})\n{{#if c}}\n  {{c}}\n{{/if}}\n{{/each}}\nEnd";
        assert_eq!(render(template, &data).unwrap(), "List\n- one (1/outer)\n  note\n- two (2/outer)\nEnd");
        assert_eq!(render("{{#if none}}x{{else}}y{{/if}}", &data).unwrap(), "y");
        assert_eq!(render("{{#unless none}}x{{/unless}}", &data).unwrap(), "x");
        assert_eq!(render("{{#each none}}x{{else}}empty{{/each}}", &data).unwrap(), "empty");
    }

    #[test]
    fn wraps_items_that_ask_for_it() {
        let data = json!({ "a": [{ "x": 1, "__begin": "<b>\n", "__end": "</b>\n" }] });
        assert_eq!(render("{{#each a}}\n{{x}}\n{{/each}}\n", &data).unwrap(), "<b>\n1\n</b>\n");
    }

    #[test]
    fn errors_name_the_line() {
        assert!(render("{{#each a}}\nx", &json!({})).unwrap_err().contains("Line 1"));
        assert!(render("a\n{{x | nope}}", &json!({})).unwrap_err().contains("Line 2"));
        assert!(render("{{/if}}", &json!({})).is_err());
        assert!(render("{{x", &json!({})).is_err());
    }

    #[test]
    fn quoting() {
        assert_eq!(yaml_scalar("Plain title"), "Plain title");
        assert_eq!(yaml_scalar("A: subtitle"), "\"A: subtitle\"");
        assert_eq!(yaml_scalar("2020"), "\"2020\"");
        assert_eq!(render("{{t | quote}}", &json!({ "t": "a\nb" })).unwrap(), "> a\n> b");
        assert_eq!(fold_ascii("Łódź – Straße, Øresund"), "Lodz - Strasse, Oresund");
    }
}
