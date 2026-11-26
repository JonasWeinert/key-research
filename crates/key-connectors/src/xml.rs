// A small XML tree (local names only, namespaces dropped) for the XML paths of a spec. Built
// with quick-xml; DTDs and external entities are never read.
use quick_xml::Reader;
use quick_xml::events::Event;

#[derive(Debug, Default)]
pub struct XmlNode {
    /// Local name; empty for a text node.
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<usize>,
    pub parent: Option<usize>,
    pub text: String,
}

#[derive(Debug)]
pub struct XmlDoc {
    pub nodes: Vec<XmlNode>,
}

fn local(name: &[u8]) -> String {
    let name = String::from_utf8_lossy(name);
    match name.rsplit_once(':') {
        Some((_, local)) => local.to_string(),
        None => name.to_string(),
    }
}

fn entity(name: &str) -> Option<String> {
    Some(match name {
        "amp" => "&".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        "quot" => "\"".into(),
        "apos" => "'".into(),
        "nbsp" => "\u{a0}".into(),
        _ => {
            let code = name.strip_prefix('#')?;
            let n = match code.strip_prefix('x').or_else(|| code.strip_prefix('X')) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => code.parse().ok()?,
            };
            char::from_u32(n)?.to_string()
        }
    })
}

fn unescape_attr(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        match rest[at..].find(';') {
            Some(end) if end < 12 => {
                let name = &rest[at + 1..at + end];
                match entity(name) {
                    Some(text) => out.push_str(&text),
                    None => out.push_str(&rest[at..at + end + 1]),
                }
                rest = &rest[at + end + 1..];
            }
            _ => {
                out.push('&');
                rest = &rest[at + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

impl XmlDoc {
    pub fn parse(text: &str) -> Result<XmlDoc, String> {
        let mut doc = XmlDoc { nodes: vec![XmlNode { name: "#document".into(), ..Default::default() }] };
        let mut stack = vec![0usize];
        let mut reader = Reader::from_str(text);
        reader.config_mut().trim_text(false);
        let push_text = |doc: &mut XmlDoc, stack: &[usize], text: &str| {
            let parent = *stack.last().unwrap_or(&0);
            if let Some(&last) = doc.nodes[parent].children.last() {
                if doc.nodes[last].name.is_empty() {
                    doc.nodes[last].text.push_str(text);
                    return;
                }
            }
            let id = doc.nodes.len();
            doc.nodes.push(XmlNode { text: text.to_string(), parent: Some(parent), ..Default::default() });
            doc.nodes[parent].children.push(id);
        };
        loop {
            match reader.read_event() {
                Ok(Event::Start(e)) => {
                    let id = doc.element(&e, *stack.last().unwrap_or(&0));
                    stack.push(id);
                }
                Ok(Event::Empty(e)) => {
                    doc.element(&e, *stack.last().unwrap_or(&0));
                }
                Ok(Event::End(_)) => {
                    if stack.len() > 1 {
                        stack.pop();
                    }
                }
                Ok(Event::Text(t)) => {
                    let text = t.decode().map_err(|e| e.to_string())?;
                    push_text(&mut doc, &stack, &text);
                }
                Ok(Event::CData(t)) => {
                    let text = String::from_utf8_lossy(&t.into_inner()).to_string();
                    push_text(&mut doc, &stack, &text);
                }
                Ok(Event::GeneralRef(r)) => {
                    let name = r.decode().map_err(|e| e.to_string())?;
                    let text = entity(&name).unwrap_or_default();
                    push_text(&mut doc, &stack, &text);
                }
                Ok(Event::Eof) => break,
                Ok(_) => {}
                Err(e) => return Err(format!("Unreadable XML at byte {}: {e}", reader.buffer_position())),
            }
        }
        Ok(doc)
    }

    fn element(&mut self, e: &quick_xml::events::BytesStart, parent: usize) -> usize {
        let attrs = e
            .attributes()
            .flatten()
            .map(|a| (local(a.key.as_ref()), unescape_attr(&String::from_utf8_lossy(&a.value))))
            .collect();
        let id = self.nodes.len();
        self.nodes.push(XmlNode { name: local(e.name().as_ref()), attrs, parent: Some(parent), ..Default::default() });
        self.nodes[parent].children.push(id);
        id
    }

    pub fn attr(&self, id: usize, name: &str) -> Option<&str> {
        self.nodes[id].attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    pub fn elements(&self, id: usize) -> impl Iterator<Item = usize> + '_ {
        self.nodes[id].children.iter().copied().filter(|c| !self.nodes[*c].name.is_empty())
    }

    /// Every element below `id` (not `id` itself), in document order.
    pub fn descendants(&self, id: usize) -> Vec<usize> {
        let mut out = Vec::new();
        let mut stack: Vec<usize> = self.nodes[id].children.iter().rev().copied().collect();
        while let Some(n) = stack.pop() {
            if !self.nodes[n].name.is_empty() {
                out.push(n);
                stack.extend(self.nodes[n].children.iter().rev().copied());
            }
        }
        out
    }

    /// The text of the node and everything below it.
    pub fn text(&self, id: usize) -> String {
        let node = &self.nodes[id];
        if node.name.is_empty() {
            return node.text.clone();
        }
        let mut out = String::new();
        for c in &node.children {
            out.push_str(&self.text(*c));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_names_text_attributes_and_entities() {
        let doc = XmlDoc::parse(r#"<?xml version="1.0"?><o:root xmlns:o="x"><a id="1&amp;2">Tom &amp; <b>Jerry</b><![CDATA[ <raw> ]]></a><c/></o:root>"#).unwrap();
        let root = doc.elements(0).next().unwrap();
        assert_eq!(doc.nodes[root].name, "root");
        let a = doc.elements(root).next().unwrap();
        assert_eq!(doc.attr(a, "id"), Some("1&2"));
        assert_eq!(doc.text(a), "Tom & Jerry <raw> ");
        assert_eq!(doc.descendants(root).len(), 3);
    }
}
