// Paths into an answer: JSONPath-like for JSON, XPath-like for XML, CSS-like for HTML, column
// names for CSV (connectors/SPEC.md, "Extraction"). A fixed, small grammar evaluated here;
// nothing in a path can run code.
use crate::xml::XmlDoc;
use key_store::html_dom::Dom;
use serde_json::Value as Json;

pub struct HtmlDoc {
    pub dom: Dom,
    pub base: Option<url::Url>,
}

pub struct CsvDoc {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

pub enum Doc {
    Json(Json),
    Xml(XmlDoc),
    Html(HtmlDoc),
    Csv(CsvDoc),
}

#[derive(Clone)]
pub enum Node<'a> {
    Json(&'a Json),
    Xml(&'a XmlDoc, usize),
    Html(&'a HtmlDoc, usize),
    CsvAll(&'a CsvDoc),
    Row(&'a CsvDoc, usize),
    Text(String),
}

impl Doc {
    pub fn parse(format: &str, body: &[u8], base: Option<&url::Url>) -> Result<Doc, String> {
        let text = String::from_utf8_lossy(body);
        let text = text.trim_start_matches('\u{feff}');
        match format {
            "json" => serde_json::from_str(text).map(Doc::Json).map_err(|e| format!("The answer is not JSON: {e}")),
            "xml" => XmlDoc::parse(text).map(Doc::Xml),
            "html" => Ok(Doc::Html(HtmlDoc { dom: Dom::parse(text), base: base.cloned() })),
            "csv" => Ok(Doc::Csv(parse_csv(text))),
            other => Err(format!("Unknown format {other}")),
        }
    }

    pub fn root(&self) -> Node<'_> {
        match self {
            Doc::Json(j) => Node::Json(j),
            Doc::Xml(x) => Node::Xml(x, 0),
            Doc::Html(h) => Node::Html(h, key_store::html_dom::ROOT),
            Doc::Csv(c) => Node::CsvAll(c),
        }
    }
}

fn parse_csv(text: &str) -> CsvDoc {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    let mut any = false;
    while let Some(c) = chars.next() {
        any = true;
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' => quoted = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                any = false;
            }
            _ => field.push(c),
        }
    }
    if any {
        row.push(field);
        rows.push(row);
    }
    rows.retain(|r| !(r.len() == 1 && r[0].trim().is_empty()));
    let headers = if rows.is_empty() { Vec::new() } else { rows.remove(0).into_iter().map(|h| h.trim().to_string()).collect() };
    CsvDoc { headers, rows }
}

/// The node's text (XML/HTML: everything inside), or None for nothing (JSON null, objects).
pub fn text(node: &Node) -> Option<String> {
    match node {
        Node::Json(j) => json_text(j),
        Node::Xml(doc, id) => Some(doc.text(*id)),
        Node::Html(doc, id) => Some(doc.dom.text(*id)),
        Node::CsvAll(_) => None,
        Node::Row(doc, i) => Some(doc.rows[*i].join(", ")),
        Node::Text(t) => Some(t.clone()),
    }
}

fn json_text(j: &Json) -> Option<String> {
    match j {
        Json::String(s) => Some(s.clone()),
        Json::Number(n) => Some(n.to_string()),
        Json::Bool(b) => Some(b.to_string()),
        Json::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(json_text).filter(|s| !s.is_empty()).collect();
            (!parts.is_empty()).then(|| parts.join(" "))
        }
        _ => None,
    }
}

/// The JSON value, when the node is JSON (for `inverted-index`).
pub fn json_of<'a>(node: &Node<'a>) -> Option<&'a Json> {
    if let Node::Json(j) = node { Some(j) } else { None }
}

/// The base URL of an HTML node (to resolve links).
pub fn base_of(node: &Node) -> Option<url::Url> {
    if let Node::Html(doc, _) = node { doc.base.clone() } else { None }
}

pub fn check(path: &str, format: &str) -> Result<(), String> {
    match format {
        "json" => json_parse(path).map(|_| ()),
        "xml" => xml_parse(path).map(|_| ()),
        "html" => css_parse(path).map(|_| ()),
        _ => Ok(()),
    }
}

/// Everything the path selects from `node`.
pub fn select<'a>(node: &Node<'a>, path: &str) -> Result<Vec<Node<'a>>, String> {
    let path = path.trim();
    match node {
        Node::Json(j) => {
            let segs = json_parse(path)?;
            Ok(json_eval(j, &segs).into_iter().map(Node::Json).collect())
        }
        Node::Xml(doc, id) => {
            let steps = xml_parse(path)?;
            Ok(xml_eval(doc, *id, &steps))
        }
        Node::Html(doc, id) => css_eval(doc, *id, path),
        Node::CsvAll(doc) => Ok((0..doc.rows.len()).map(|i| Node::Row(doc, i)).collect()),
        Node::Row(doc, i) => {
            if path == "$" {
                return Ok(vec![node.clone()]);
            }
            let name = path.strip_prefix("$[\"").and_then(|p| p.strip_suffix("\"]")).unwrap_or(path);
            let column = doc.headers.iter().position(|h| h == name).or_else(|| doc.headers.iter().position(|h| h.eq_ignore_ascii_case(name)));
            Ok(column.and_then(|c| doc.rows[*i].get(c)).map(|v| Node::Text(v.clone())).into_iter().collect())
        }
        Node::Text(t) => Ok(if path == "$" || path == ":scope" { vec![Node::Text(t.clone())] } else { Vec::new() }),
    }
}

// ── JSON ──

#[derive(Debug, Clone, PartialEq)]
enum JSeg {
    Key(String),
    Index(usize),
    /// Array elements, or an object's values.
    All,
    /// Array elements, or a lone value as a one-item list.
    List,
    Filter(String, String),
}

fn json_parse(path: &str) -> Result<Vec<JSeg>, String> {
    let rest = path.strip_prefix('$').ok_or("a JSON path starts with $")?;
    let chars: Vec<char> = rest.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < chars.len() {
        match chars[i] {
            '.' => {
                let start = i + 1;
                i = start;
                while i < chars.len() && chars[i] != '.' && chars[i] != '[' {
                    i += 1;
                }
                let key: String = chars[start..i].iter().collect();
                if key.is_empty() {
                    return Err("an empty key".into());
                }
                out.push(JSeg::Key(key));
            }
            '[' => {
                let end = (i..chars.len()).find(|&j| chars[j] == ']' && !in_quotes(&chars[i..j])).ok_or("an unclosed [")?;
                let inner: String = chars[i + 1..end].iter().collect();
                let inner = inner.trim();
                let seg = if inner == "*" {
                    JSeg::All
                } else if inner == "#" {
                    JSeg::List
                } else if let Ok(n) = inner.parse::<usize>() {
                    JSeg::Index(n)
                } else if let Some(f) = inner.strip_prefix('?') {
                    let (k, v) = f.split_once('=').ok_or("a filter is [?key=value]")?;
                    JSeg::Filter(k.trim().to_string(), unquote(v.trim()))
                } else if (inner.starts_with('"') && inner.ends_with('"') || inner.starts_with('\'') && inner.ends_with('\'')) && inner.len() >= 2 {
                    JSeg::Key(inner[1..inner.len() - 1].to_string())
                } else {
                    return Err(format!("bad [{inner}]"));
                };
                out.push(seg);
                i = end + 1;
            }
            c => return Err(format!("unexpected {c:?}")),
        }
    }
    Ok(out)
}

fn in_quotes(chars: &[char]) -> bool {
    let mut quote = None;
    for c in chars {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(*c),
            (Some(q), c) if q == *c => quote = None,
            _ => {}
        }
    }
    quote.is_some()
}

fn unquote(v: &str) -> String {
    if v.len() >= 2 && (v.starts_with('"') && v.ends_with('"') || v.starts_with('\'') && v.ends_with('\'')) { v[1..v.len() - 1].to_string() } else { v.to_string() }
}

fn json_eval<'a>(root: &'a Json, segs: &[JSeg]) -> Vec<&'a Json> {
    let mut current = vec![root];
    for seg in segs {
        let mut next = Vec::new();
        for value in current {
            match (seg, value) {
                (JSeg::Key(k), Json::Object(o)) => next.extend(o.get(k)),
                // A key on a list reads it from every element.
                (JSeg::Key(k), Json::Array(a)) => next.extend(a.iter().filter_map(|e| e.get(k))),
                (JSeg::Index(n), Json::Array(a)) => next.extend(a.get(*n)),
                (JSeg::Index(0), Json::Object(_)) => next.push(value),
                (JSeg::All, Json::Array(a)) | (JSeg::List, Json::Array(a)) => next.extend(a.iter()),
                (JSeg::All, Json::Object(o)) => next.extend(o.values()),
                (JSeg::List, Json::Null) => {}
                (JSeg::List, v) => next.push(v),
                (JSeg::Filter(k, v), Json::Array(a)) => next.extend(a.iter().filter(|e| e.get(k).and_then(json_text).as_deref() == Some(v.as_str()))),
                (JSeg::Filter(k, v), Json::Object(_)) => {
                    if value.get(k).and_then(json_text).as_deref() == Some(v.as_str()) {
                        next.push(value);
                    }
                }
                _ => {}
            }
        }
        current = next;
    }
    current.into_iter().filter(|v| !v.is_null()).collect()
}

// ── XML ──

#[derive(Debug, Clone)]
enum Pred {
    AttrEq(String, String),
    HasAttr(String),
    ChildEq(String, String),
    Index(usize),
}

#[derive(Debug, Clone)]
enum XStep {
    Element { descendant: bool, name: String, preds: Vec<Pred> },
    Attr(String),
    Parent,
    SelfNode,
}

fn xml_parse(path: &str) -> Result<Vec<XStep>, String> {
    let path = path.trim();
    if path == "$" || path == "." || path.is_empty() {
        return Ok(vec![XStep::SelfNode]);
    }
    let mut out = Vec::new();
    let mut rest = path.strip_prefix("$/").or_else(|| path.strip_prefix("./")).unwrap_or(path);
    let mut descendant = false;
    if let Some(r) = rest.strip_prefix("//") {
        descendant = true;
        rest = r;
    } else if let Some(r) = rest.strip_prefix('/') {
        rest = r;
    }
    let parts = split_outside_brackets(rest, '/');
    for part in parts {
        let part = part.trim();
        if part.is_empty() {
            descendant = true;
            continue;
        }
        if part == "text()" {
            continue;
        }
        if part == ".." {
            out.push(XStep::Parent);
        } else if part == "." {
            out.push(XStep::SelfNode);
        } else if let Some(attr) = part.strip_prefix('@') {
            out.push(XStep::Attr(attr.to_string()));
        } else {
            let (name, preds_text) = match part.find('[') {
                Some(at) => (&part[..at], &part[at..]),
                None => (part, ""),
            };
            if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '*' || c == ':') {
                return Err(format!("bad step {part:?}"));
            }
            let name = name.rsplit(':').next().unwrap_or(name).to_string();
            let mut preds = Vec::new();
            let mut p = preds_text;
            while let Some(r) = p.strip_prefix('[') {
                let end = r.find(']').ok_or("an unclosed [")?;
                let inner = r[..end].trim();
                preds.push(if let Ok(n) = inner.parse::<usize>() {
                    if n == 0 {
                        return Err("XML positions start at 1".into());
                    }
                    Pred::Index(n)
                } else if let Some(a) = inner.strip_prefix('@') {
                    match a.split_once('=') {
                        Some((k, v)) => Pred::AttrEq(k.trim().to_string(), unquote(v.trim())),
                        None => Pred::HasAttr(a.trim().to_string()),
                    }
                } else if let Some((k, v)) = inner.split_once('=') {
                    Pred::ChildEq(k.trim().to_string(), unquote(v.trim()))
                } else {
                    return Err(format!("bad predicate [{inner}]"));
                });
                p = &r[end + 1..];
            }
            if !p.is_empty() {
                return Err(format!("bad step {part:?}"));
            }
            out.push(XStep::Element { descendant, name, preds });
        }
        descendant = false;
    }
    Ok(out)
}

fn split_outside_brackets(text: &str, sep: char) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut depth, mut start) = (0i32, 0);
    let mut quote: Option<char> = None;
    for (i, c) in text.char_indices() {
        match c {
            '"' | '\'' if quote.is_none() => quote = Some(c),
            c2 if Some(c2) == quote => quote = None,
            '[' | '(' if quote.is_none() => depth += 1,
            ']' | ')' if quote.is_none() => depth -= 1,
            c2 if c2 == sep && depth == 0 && quote.is_none() => {
                out.push(&text[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    out.push(&text[start..]);
    out
}

fn xml_eval<'a>(doc: &'a XmlDoc, start: usize, steps: &[XStep]) -> Vec<Node<'a>> {
    let mut current = vec![start];
    let mut attrs: Option<Vec<String>> = None;
    for step in steps {
        match step {
            XStep::SelfNode => {}
            XStep::Parent => current = current.into_iter().filter_map(|n| doc.nodes[n].parent).collect(),
            XStep::Attr(name) => {
                attrs = Some(current.iter().filter_map(|n| doc.attr(*n, name).map(str::to_string)).collect());
                break;
            }
            XStep::Element { descendant, name, preds } => {
                let mut next = Vec::new();
                for n in &current {
                    let candidates: Vec<usize> = if *descendant { doc.descendants(*n) } else { doc.elements(*n).collect() };
                    let mut matched: Vec<usize> = candidates.into_iter().filter(|c| name == "*" || doc.nodes[*c].name == *name).collect();
                    for pred in preds {
                        matched = match pred {
                            Pred::Index(i) => matched.get(i - 1).copied().into_iter().collect(),
                            Pred::HasAttr(a) => matched.into_iter().filter(|c| doc.attr(*c, a).is_some()).collect(),
                            Pred::AttrEq(a, v) => matched.into_iter().filter(|c| doc.attr(*c, a) == Some(v.as_str())).collect(),
                            Pred::ChildEq(k, v) => matched.into_iter().filter(|c| doc.elements(*c).any(|e| doc.nodes[e].name == *k && doc.text(e).trim() == v)).collect(),
                        };
                    }
                    for m in matched {
                        if !next.contains(&m) {
                            next.push(m);
                        }
                    }
                }
                current = next;
            }
        }
    }
    match attrs {
        Some(values) => values.into_iter().map(Node::Text).collect(),
        None => current.into_iter().map(|n| Node::Xml(doc, n)).collect(),
    }
}

// ── HTML (CSS-like) ──

#[derive(Debug, Clone, Default)]
struct Compound {
    tag: Option<String>,
    id: Option<String>,
    classes: Vec<String>,
    attrs: Vec<(String, String, Option<String>)>,
    contains: Vec<String>,
    first_child: bool,
    nth_of_type: Option<usize>,
}

#[derive(Debug, Clone)]
struct Selector {
    scope: bool,
    /// (child combinator, compound)
    parts: Vec<(bool, Compound)>,
    attr: Option<String>,
}

fn css_parse(path: &str) -> Result<Vec<Selector>, String> {
    let mut out = Vec::new();
    for alternative in split_outside_brackets(path, ',') {
        let mut text = alternative.trim().to_string();
        if text.is_empty() {
            return Err("an empty selector".into());
        }
        let mut attr = None;
        // A trailing @attr (outside brackets and parentheses).
        let at = {
            let (mut depth, mut found) = (0i32, None);
            for (i, c) in text.char_indices() {
                match c {
                    '[' | '(' => depth += 1,
                    ']' | ')' => depth -= 1,
                    '@' if depth == 0 => found = Some(i),
                    _ => {}
                }
            }
            found
        };
        if let Some(at) = at {
            attr = Some(text[at + 1..].trim().to_string());
            text.truncate(at);
        }
        let mut scope = false;
        let mut body = text.trim();
        for prefix in [":scope", "$"] {
            if let Some(r) = body.strip_prefix(prefix) {
                scope = true;
                body = r.trim();
            }
        }
        let mut parts = Vec::new();
        let mut child = false;
        for token in split_outside_brackets(&body.replace('>', " > "), ' ') {
            let token = token.trim();
            if token.is_empty() {
                continue;
            }
            if token == ">" {
                child = true;
                continue;
            }
            parts.push((child, compound(token)?));
            child = false;
        }
        if parts.is_empty() && !scope && attr.is_none() {
            return Err(format!("bad selector {alternative:?}"));
        }
        out.push(Selector { scope: scope || parts.is_empty(), parts, attr });
    }
    Ok(out)
}

fn compound(token: &str) -> Result<Compound, String> {
    let mut c = Compound::default();
    let chars: Vec<char> = token.chars().collect();
    let mut i = 0;
    let ident = |i: &mut usize| {
        let start = *i;
        while *i < chars.len() && (chars[*i].is_alphanumeric() || chars[*i] == '-' || chars[*i] == '_') {
            *i += 1;
        }
        chars[start..*i].iter().collect::<String>()
    };
    if i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '*') {
        if chars[i] == '*' {
            i += 1;
        } else {
            c.tag = Some(ident(&mut i).to_ascii_lowercase());
        }
    }
    while i < chars.len() {
        match chars[i] {
            '.' => {
                i += 1;
                c.classes.push(ident(&mut i));
            }
            '#' => {
                i += 1;
                c.id = Some(ident(&mut i));
            }
            '[' => {
                let end = (i..chars.len()).find(|&j| chars[j] == ']').ok_or("an unclosed [")?;
                let inner: String = chars[i + 1..end].iter().collect();
                let ops = ["^=", "$=", "*=", "~=", "="];
                let found = ops.iter().find_map(|op| inner.find(op).map(|at| (at, *op)));
                match found {
                    Some((at, op)) => c.attrs.push((inner[..at].trim().to_ascii_lowercase(), op.to_string(), Some(unquote(inner[at + op.len()..].trim())))),
                    None => c.attrs.push((inner.trim().to_ascii_lowercase(), String::new(), None)),
                }
                i = end + 1;
            }
            ':' => {
                i += 1;
                let name = ident(&mut i);
                let mut arg = None;
                if i < chars.len() && chars[i] == '(' {
                    let end = (i..chars.len()).find(|&j| chars[j] == ')').ok_or("an unclosed (")?;
                    arg = Some(unquote(chars[i + 1..end].iter().collect::<String>().trim()));
                    i = end + 1;
                }
                match (name.as_str(), arg) {
                    ("contains", Some(a)) => c.contains.push(a.to_lowercase()),
                    ("first-child", None) => c.first_child = true,
                    ("nth-of-type", Some(a)) => c.nth_of_type = Some(a.parse().map_err(|_| "nth-of-type needs a number")?),
                    (other, _) => return Err(format!("unsupported :{other}")),
                }
            }
            other => return Err(format!("unexpected {other:?} in {token:?}")),
        }
    }
    Ok(c)
}

fn css_matches(dom: &Dom, id: usize, c: &Compound) -> bool {
    let node = &dom.nodes[id];
    if node.tag.is_empty() || c.tag.as_ref().is_some_and(|t| *t != node.tag) {
        return false;
    }
    if c.id.as_ref().is_some_and(|x| dom.attr(id, "id") != Some(x.as_str())) {
        return false;
    }
    if !c.classes.iter().all(|cl| dom.has_class(id, cl)) {
        return false;
    }
    for (name, op, value) in &c.attrs {
        let Some(have) = dom.attr(id, name) else { return false };
        let ok = match (op.as_str(), value) {
            ("", _) | (_, None) => true,
            ("=", Some(v)) => have == v,
            ("^=", Some(v)) => have.starts_with(v.as_str()),
            ("$=", Some(v)) => have.ends_with(v.as_str()),
            ("*=", Some(v)) => have.contains(v.as_str()),
            ("~=", Some(v)) => have.split_ascii_whitespace().any(|w| w == v),
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    if !c.contains.is_empty() {
        let text = dom.text(id).to_lowercase();
        if !c.contains.iter().all(|t| text.contains(t.as_str())) {
            return false;
        }
    }
    let siblings = || node.parent.map(|p| dom.element_children(p)).unwrap_or_default();
    if c.first_child && siblings().first() != Some(&id) {
        return false;
    }
    if let Some(n) = c.nth_of_type {
        let same: Vec<usize> = siblings().into_iter().filter(|s| dom.nodes[*s].tag == node.tag).collect();
        if same.get(n.saturating_sub(1)) != Some(&id) {
            return false;
        }
    }
    true
}

fn css_eval<'a>(doc: &'a HtmlDoc, start: usize, path: &str) -> Result<Vec<Node<'a>>, String> {
    let mut out: Vec<Node<'a>> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for selector in css_parse(path)? {
        let mut current = vec![start];
        for (child, compound) in &selector.parts {
            let mut next = Vec::new();
            for n in &current {
                let candidates = if *child { doc.dom.element_children(*n) } else { doc.dom.descendants(*n) };
                for c in candidates {
                    if css_matches(&doc.dom, c, compound) && !next.contains(&c) {
                        next.push(c);
                    }
                }
            }
            current = next;
        }
        for n in current {
            if let Some(attr) = &selector.attr {
                if let Some(v) = doc.dom.attr(n, attr) {
                    out.push(Node::Text(v.to_string()));
                }
            } else if seen.insert(n) {
                out.push(Node::Html(doc, n));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(nodes: &[Node]) -> Vec<String> {
        nodes.iter().filter_map(text).collect()
    }

    #[test]
    fn json_paths_keys_indexes_wildcards_filters_and_lone_objects() {
        let doc = Doc::parse("json", br#"{"a":{"b":[{"c":1},{"c":2}]},"search-results":{"cursor":{"@next":"X"}},
            "documents":{"D1":{"id":"1"},"D2":{"id":"2"},"facets":{}},
            "ids":[{"type":"doi","value":"10.1/x"},{"type":"pmid","value":"9"}],"lone":{"type":"doi","value":"10.2/y"}}"#, None).unwrap();
        let root = doc.root();
        assert_eq!(texts(&select(&root, "$.a.b[*].c").unwrap()), vec!["1", "2"]);
        assert_eq!(texts(&select(&root, "$.a.b[1].c").unwrap()), vec!["2"]);
        assert_eq!(texts(&select(&root, r#"$["search-results"].cursor["@next"]"#).unwrap()), vec!["X"]);
        assert_eq!(texts(&select(&root, "$.documents[*].id").unwrap()), vec!["1", "2"]);
        assert_eq!(texts(&select(&root, "$.ids[?type=doi].value").unwrap()), vec!["10.1/x"]);
        assert_eq!(texts(&select(&root, "$.lone[?type=doi].value").unwrap()), vec!["10.2/y"]);
        assert_eq!(texts(&select(&root, "$.lone[#].value").unwrap()), vec!["10.2/y"]);
        assert_eq!(texts(&select(&root, "$.lone[0].value").unwrap()), vec!["10.2/y"]);
        assert!(json_parse("a.b").is_err());
    }

    #[test]
    fn xml_paths_descendants_predicates_attributes() {
        let doc = Doc::parse("xml", br#"<Set><PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>A <i>b</i></ArticleTitle></Article></MedlineCitation>
            <PubmedData><ArticleIdList><ArticleId IdType="pubmed">1</ArticleId><ArticleId IdType="doi">10.1/a</ArticleId></ArticleIdList></PubmedData></PubmedArticle>
            <PubmedArticle><MedlineCitation><PMID>2</PMID></MedlineCitation></PubmedArticle></Set>"#, None).unwrap();
        let items = select(&doc.root(), "//PubmedArticle").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(texts(&select(&items[0], "MedlineCitation/Article/ArticleTitle").unwrap()), vec!["A b"]);
        assert_eq!(texts(&select(&items[0], ".//ArticleId[@IdType='doi']").unwrap()), vec!["10.1/a"]);
        assert_eq!(texts(&select(&items[0], "//ArticleId[2]/@IdType").unwrap()), vec!["doi"]);
        assert_eq!(texts(&select(&items[1], "MedlineCitation/PMID").unwrap()), vec!["2"]);
    }

    #[test]
    fn css_selectors_classes_children_contains_and_attributes() {
        let base = url::Url::parse("https://example.org/list").unwrap();
        let doc = Doc::parse("html", br#"<div class="teaser"><h3><a href="/s/1">One</a></h3><div class="tag"><span>Country</span><a>Kenya</a></div><div class="tag"><span>Researchers</span><a>Ann</a><a>Bo</a></div></div>
            <div class="teaser"><h3><a href="/s/2">Two</a></h3></div>"#, Some(&base)).unwrap();
        let items = select(&doc.root(), "div.teaser").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(texts(&select(&items[0], "h3 > a@href").unwrap()), vec!["/s/1"]);
        assert_eq!(texts(&select(&items[0], ".tag:contains(researchers) a").unwrap()), vec!["Ann", "Bo"]);
        assert_eq!(texts(&select(&items[0], ".tag:nth-of-type(2) span").unwrap()), vec!["Country"]);
        assert_eq!(texts(&select(&items[1], ":scope").unwrap()), vec!["Two"]);
        assert!(css_parse("div:hover").is_err());
    }

    #[test]
    fn csv_rows_and_columns_by_header() {
        let doc = Doc::parse("csv", "Title,RCT_ID,First registered on\n\"A, quoted \"\"title\"\"\",AEARCTR-1,2020-01-01\nB,AEARCTR-2,2021\n".as_bytes(), None).unwrap();
        let rows = select(&doc.root(), "$").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(texts(&select(&rows[0], "Title").unwrap()), vec!["A, quoted \"title\""]);
        assert_eq!(texts(&select(&rows[1], "First registered on").unwrap()), vec!["2021"]);
    }
}
