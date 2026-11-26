// A small, forgiving HTML tree builder: enough of the HTML parsing rules (void elements,
// raw-text elements, implied end tags for p / li / dt / dd / tr / td / option, misnested
// end tags ignored) to read saved web pages the way a browser lays out their elements.
// No scripting, no CSS. Used to find a page's reference list (web_references.rs).

pub type NodeId = usize;

#[derive(Debug, Default)]
pub struct Node {
    /// Lower-case tag name; empty for a text node.
    pub tag: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<NodeId>,
    pub parent: Option<NodeId>,
    pub text: String,
}

#[derive(Debug)]
pub struct Dom {
    pub nodes: Vec<Node>,
}

const VOID: &[&str] = &["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen"];
const RAW: &[&str] = &["script", "style", "textarea", "title", "xmp", "noembed", "iframe", "plaintext"];
/// Elements that end an open paragraph.
const CLOSES_P: &[&str] = &[
    "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
    "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul",
];

pub const ROOT: NodeId = 0;

impl Dom {
    pub fn parse(html: &str) -> Dom {
        let mut dom = Dom { nodes: vec![Node { tag: "#document".into(), ..Default::default() }] };
        let mut stack: Vec<NodeId> = vec![ROOT];
        let bytes = html.as_bytes();
        let mut i = 0;
        let mut text_start = 0;
        while i < bytes.len() {
            if bytes[i] != b'<' {
                i += 1;
                continue;
            }
            let next = bytes.get(i + 1).copied().unwrap_or(0);
            let is_tag = next.is_ascii_alphabetic() || next == b'/' || next == b'!' || next == b'?';
            if !is_tag {
                i += 1;
                continue;
            }
            if text_start < i {
                dom.add_text(&stack, &html[text_start..i]);
            }
            if html[i..].starts_with("<!--") {
                i = html[i + 4..].find("-->").map(|e| i + 4 + e + 3).unwrap_or(bytes.len());
            } else if next == b'!' || next == b'?' {
                i = html[i..].find('>').map(|e| i + e + 1).unwrap_or(bytes.len());
            } else if next == b'/' {
                let name_end = html[i + 2..].find(|c: char| c.is_whitespace() || c == '>' || c == '/').map(|e| i + 2 + e).unwrap_or(bytes.len());
                let name = html[i + 2..name_end].to_ascii_lowercase();
                i = html[name_end..].find('>').map(|e| name_end + e + 1).unwrap_or(bytes.len());
                dom.end(&mut stack, &name);
            } else {
                let (end, name, attrs, self_closing) = parse_start(html, i);
                i = end;
                dom.implied_ends(&mut stack, &name);
                let parent = *stack.last().unwrap_or(&ROOT);
                let id = dom.push(parent, Node { tag: name.clone(), attrs, ..Default::default() });
                if RAW.contains(&name.as_str()) {
                    let close = format!("</{name}");
                    let lower_rest = &html[i..];
                    let at = find_ci(lower_rest, &close).map(|e| i + e).unwrap_or(bytes.len());
                    if at > i {
                        let raw = &html[i..at];
                        let text = if name == "textarea" || name == "title" { decode(raw) } else { raw.to_string() };
                        dom.push(id, Node { text, ..Default::default() });
                    }
                    i = html[at..].find('>').map(|e| at + e + 1).unwrap_or(bytes.len());
                } else if !self_closing && !VOID.contains(&name.as_str()) {
                    stack.push(id);
                }
            }
            text_start = i;
        }
        if text_start < bytes.len() {
            dom.add_text(&stack, &html[text_start..]);
        }
        dom
    }

    fn push(&mut self, parent: NodeId, mut node: Node) -> NodeId {
        let id = self.nodes.len();
        node.parent = Some(parent);
        self.nodes.push(node);
        self.nodes[parent].children.push(id);
        id
    }

    fn add_text(&mut self, stack: &[NodeId], raw: &str) {
        let parent = *stack.last().unwrap_or(&ROOT);
        let text = decode(raw);
        if let Some(&last) = self.nodes[parent].children.last() {
            if self.nodes[last].tag.is_empty() {
                self.nodes[last].text.push_str(&text);
                return;
            }
        }
        self.push(parent, Node { text, ..Default::default() });
    }

    fn open(&self, stack: &[NodeId], tag: &str, scope: &[&str]) -> Option<usize> {
        for (k, &id) in stack.iter().enumerate().rev() {
            let t = self.nodes[id].tag.as_str();
            if t == tag {
                return Some(k);
            }
            if scope.contains(&t) {
                return None;
            }
        }
        None
    }

    fn implied_ends(&self, stack: &mut Vec<NodeId>, name: &str) {
        let close = |stack: &mut Vec<NodeId>, at: Option<usize>| {
            if let Some(k) = at {
                stack.truncate(k);
            }
        };
        if CLOSES_P.contains(&name) {
            close(stack, self.open(stack, "p", &["button", "table", "td", "th", "li", "div", "section", "article", "blockquote"]));
        }
        match name {
            "li" => close(stack, self.open(stack, "li", &["ol", "ul", "menu", "table"])),
            "dt" | "dd" => {
                let at = self.open(stack, "dd", &["dl", "table"]).into_iter().chain(self.open(stack, "dt", &["dl", "table"])).min();
                close(stack, at)
            }
            "tr" => close(stack, self.open(stack, "tr", &["table", "tbody", "thead", "tfoot"])),
            "td" | "th" => {
                let at = self.open(stack, "td", &["tr", "table"]).into_iter().chain(self.open(stack, "th", &["tr", "table"])).min();
                close(stack, at)
            }
            "option" => close(stack, self.open(stack, "option", &["select", "datalist"])),
            _ => {}
        }
    }

    fn end(&self, stack: &mut Vec<NodeId>, name: &str) {
        // An end tag with no open element of that name is ignored.
        if let Some(k) = stack.iter().rposition(|&id| self.nodes[id].tag == name) {
            if k > 0 {
                stack.truncate(k);
            }
        }
    }

    // ── Queries ──

    pub fn tag(&self, id: NodeId) -> &str {
        &self.nodes[id].tag
    }

    pub fn attr(&self, id: NodeId, name: &str) -> Option<&str> {
        self.nodes[id].attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    pub fn id(&self, id: NodeId) -> &str {
        self.attr(id, "id").unwrap_or_default()
    }

    pub fn has_class(&self, id: NodeId, class: &str) -> bool {
        self.attr(id, "class").is_some_and(|c| c.split_ascii_whitespace().any(|x| x == class))
    }

    /// Element descendants in document order (not `id` itself).
    pub fn descendants(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut stack: Vec<NodeId> = self.nodes[id].children.iter().rev().copied().collect();
        while let Some(n) = stack.pop() {
            if self.nodes[n].tag.is_empty() {
                continue;
            }
            out.push(n);
            stack.extend(self.nodes[n].children.iter().rev());
        }
        out
    }

    pub fn element_children(&self, id: NodeId) -> Vec<NodeId> {
        self.nodes[id].children.iter().copied().filter(|&c| !self.nodes[c].tag.is_empty()).collect()
    }

    /// The nearest element from `id` up (itself included) that `test` accepts.
    pub fn closest(&self, id: NodeId, test: impl Fn(NodeId) -> bool) -> Option<NodeId> {
        let mut at = Some(id);
        while let Some(n) = at {
            if n == ROOT {
                return None;
            }
            if test(n) {
                return Some(n);
            }
            at = self.nodes[n].parent;
        }
        None
    }

    /// `inner` is `outer` or inside it.
    pub fn contains(&self, outer: NodeId, inner: NodeId) -> bool {
        let mut at = Some(inner);
        while let Some(n) = at {
            if n == outer {
                return true;
            }
            at = self.nodes[n].parent;
        }
        false
    }

    pub fn next_element_sibling(&self, id: NodeId) -> Option<NodeId> {
        let parent = self.nodes[id].parent?;
        let siblings = &self.nodes[parent].children;
        let at = siblings.iter().position(|&s| s == id)?;
        siblings[at + 1..].iter().copied().find(|&s| !self.nodes[s].tag.is_empty())
    }

    /// The text of everything inside, leaving out subtrees `skip` accepts.
    pub fn text_without(&self, id: NodeId, skip: &dyn Fn(NodeId) -> bool) -> String {
        let mut out = String::new();
        let mut stack: Vec<NodeId> = self.nodes[id].children.iter().rev().copied().collect();
        while let Some(n) = stack.pop() {
            let node = &self.nodes[n];
            if node.tag.is_empty() {
                out.push_str(&node.text);
            } else if !skip(n) {
                stack.extend(node.children.iter().rev());
            }
        }
        out
    }

    pub fn text(&self, id: NodeId) -> String {
        self.text_without(id, &|_| false)
    }
}

fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let (h, n) = (haystack.as_bytes(), needle.as_bytes());
    if n.len() > h.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

/// A start tag at `at`: where it ends, its name, attributes and whether it closes itself.
fn parse_start(html: &str, at: usize) -> (usize, String, Vec<(String, String)>, bool) {
    let bytes = html.as_bytes();
    let mut i = at + 1;
    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' && bytes[i] != b'/' {
        i += 1;
    }
    let name = html[at + 1..i].to_ascii_lowercase();
    let mut attrs = Vec::new();
    let mut self_closing = false;
    loop {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            self_closing = bytes[i] == b'/';
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        if bytes[i] == b'>' {
            i += 1;
            break;
        }
        self_closing = false;
        let start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && !matches!(bytes[i], b'=' | b'>' | b'/') {
            i += 1;
        }
        if i == start {
            i += 1;
            continue;
        }
        let key = html[start..i].to_ascii_lowercase();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if bytes.get(i) == Some(&b'=') {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            match bytes.get(i) {
                Some(&q) if q == b'"' || q == b'\'' => {
                    let end = html[i + 1..].find(q as char).map(|e| i + 1 + e).unwrap_or(bytes.len());
                    value = decode(&html[i + 1..end]);
                    i = (end + 1).min(bytes.len());
                }
                _ => {
                    let start = i;
                    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                        i += 1;
                    }
                    value = decode(&html[start..i]);
                }
            }
        }
        if !attrs.iter().any(|(k, _): &(String, String)| *k == key) {
            attrs.push((key, value));
        }
    }
    (i, name, attrs, self_closing)
}

/// Character references: numeric ones and the named ones pages commonly use.
pub fn decode(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let end = rest[1..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '#')).map(|e| e + 1).unwrap_or(rest.len());
        let name = &rest[1..end];
        let decoded = if let Some(num) = name.strip_prefix('#') {
            let value = if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) { u32::from_str_radix(hex, 16).ok() } else { num.parse().ok() };
            value.and_then(char::from_u32).map(String::from)
        } else {
            named(name).map(String::from)
        };
        match decoded {
            Some(d) => {
                out.push_str(&d);
                rest = &rest[end..];
                if rest.starts_with(';') {
                    rest = &rest[1..];
                }
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn named(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" | "AMP" => "&",
        "lt" | "LT" => "<",
        "gt" | "GT" => ">",
        "quot" | "QUOT" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "ndash" => "–",
        "mdash" => "—",
        "hellip" => "…",
        "lsquo" => "‘",
        "rsquo" => "’",
        "ldquo" => "“",
        "rdquo" => "”",
        "laquo" => "«",
        "raquo" => "»",
        "copy" => "©",
        "reg" => "®",
        "middot" => "·",
        "bull" => "•",
        "thinsp" => "\u{2009}",
        "ensp" => "\u{2002}",
        "emsp" => "\u{2003}",
        "zwj" => "\u{200d}",
        "zwnj" => "\u{200c}",
        "shy" => "\u{ad}",
        "times" => "×",
        "minus" => "−",
        "deg" => "°",
        "aacute" => "á",
        "eacute" => "é",
        "iacute" => "í",
        "oacute" => "ó",
        "uacute" => "ú",
        "agrave" => "à",
        "egrave" => "è",
        "auml" => "ä",
        "ouml" => "ö",
        "uuml" => "ü",
        "Auml" => "Ä",
        "Ouml" => "Ö",
        "Uuml" => "Ü",
        "szlig" => "ß",
        "ccedil" => "ç",
        "ntilde" => "ñ",
        "oslash" => "ø",
        "aring" => "å",
        _ => return None,
    })
}
