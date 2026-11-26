// EndNote XML (File › Export › XML): `<records><record>` with contributors, titles, dates,
// periodical, keywords and urls. Read with a small XML reader (elements, attributes,
// entities, CDATA); text inside `<style>` wrappers is joined.
use crate::fields::{self, keep, put};
use crate::{Record, Warning};
use key_store::Creator;

const NS: &str = "endnote";

#[derive(Debug, Default)]
struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<Node>,
    text: String,
}

impl Node {
    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }
    fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }
    fn content(&self) -> String {
        let mut out = self.text.clone();
        for child in &self.children {
            out.push_str(&child.content());
        }
        out
    }
    fn path(&self, path: &[&str]) -> Option<&Node> {
        let mut node = self;
        for name in path {
            node = node.child(name)?;
        }
        Some(node)
    }
    fn text_at(&self, path: &[&str]) -> Option<String> {
        self.path(path).map(|n| n.content().trim().to_string()).filter(|t| !t.is_empty())
    }
}

fn entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let Some(end) = tail.find(';').filter(|e| *e < 12) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            e if e.starts_with("#x") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(c) => out.push(c),
            None => out.push_str(&tail[..=end]),
        }
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    out
}

fn parse_xml(text: &str) -> Result<Node, String> {
    let mut stack = vec![Node { name: "#root".into(), ..Default::default() }];
    let mut rest = text;
    while !rest.is_empty() {
        let Some(at) = rest.find('<') else {
            stack.last_mut().unwrap().text.push_str(&entities(rest));
            break;
        };
        if at > 0 {
            stack.last_mut().unwrap().text.push_str(&entities(&rest[..at]));
        }
        rest = &rest[at..];
        if let Some(body) = rest.strip_prefix("<![CDATA[") {
            let end = body.find("]]>").ok_or("Unclosed CDATA section")?;
            stack.last_mut().unwrap().text.push_str(&body[..end]);
            rest = &body[end + 3..];
            continue;
        }
        if let Some(body) = rest.strip_prefix("<!--") {
            let end = body.find("-->").ok_or("Unclosed comment")?;
            rest = &body[end + 3..];
            continue;
        }
        let end = rest.find('>').ok_or("Unclosed tag")?;
        let tag = &rest[1..end];
        rest = &rest[end + 1..];
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        if let Some(name) = tag.strip_prefix('/') {
            let node = stack.pop().ok_or("Unbalanced XML")?;
            if node.name != name.trim() || stack.is_empty() {
                return Err(format!("Expected </{}> but found </{}>", node.name, name.trim()));
            }
            stack.last_mut().unwrap().children.push(node);
            continue;
        }
        let self_closing = tag.ends_with('/');
        let tag = tag.trim_end_matches('/');
        let (name, attrs_text) = tag.split_once(char::is_whitespace).unwrap_or((tag, ""));
        let mut attrs = Vec::new();
        let mut a = attrs_text;
        while let Some(eq) = a.find('=') {
            let key = a[..eq].trim().to_string();
            let after = a[eq + 1..].trim_start();
            let quote = after.chars().next().unwrap_or('"');
            let close = after[1..].find(quote).map(|p| p + 1).unwrap_or(after.len());
            attrs.push((key, entities(&after[1.min(after.len())..close])));
            a = &after[(close + 1).min(after.len())..];
        }
        let node = Node { name: name.to_string(), attrs, ..Default::default() };
        if self_closing {
            stack.last_mut().unwrap().children.push(node);
        } else {
            stack.push(node);
        }
    }
    while stack.len() > 1 {
        let node = stack.pop().unwrap();
        stack.last_mut().unwrap().children.push(node);
    }
    Ok(stack.pop().unwrap())
}

fn find_records(node: &Node, out: &mut Vec<*const Node>) {
    for child in &node.children {
        if child.name == "record" {
            out.push(child as *const Node);
        } else {
            find_records(child, out);
        }
    }
}

fn item_type(name: &str) -> &'static str {
    match name.to_lowercase().as_str() {
        "journal article" | "electronic article" => "article",
        "book" | "edited book" | "electronic book" => "book",
        "book section" | "electronic book section" => "chapter",
        "conference proceedings" | "conference paper" => "conference-paper",
        "report" | "government document" => "report",
        "thesis" => "thesis",
        "web page" | "online database" => "webpage",
        "dataset" => "dataset",
        "computer program" => "software",
        "magazine article" => "magazine-article",
        "newspaper article" => "newspaper-article",
        "unpublished work" | "manuscript" => "manuscript",
        "patent" => "patent",
        "audiovisual material" | "film or broadcast" => "video",
        "figure" | "artwork" => "image",
        _ => "document",
    }
}

fn person(text: &str, role: &str) -> Creator {
    match text.split_once(',') {
        Some((family, given)) => Creator { family: Some(family.trim().into()), given: Some(given.trim().into()).filter(|g: &String| !g.is_empty()), role: role.into(), ..Default::default() },
        None => Creator { literal: Some(text.trim().into()), role: role.into(), ..Default::default() },
    }
}

/// Fields read directly, by path from `<record>`.
const FIELD_MAP: &[(&[&str], &str)] = &[
    (&["titles", "title"], "title"),
    (&["titles", "short-title"], "shortTitle"),
    (&["titles", "secondary-title"], "containerTitle"),
    (&["periodical", "full-title"], "containerTitle"),
    (&["periodical", "abbr-1"], "containerShort"),
    (&["titles", "alt-title"], "containerShort"),
    (&["titles", "tertiary-title"], "series"),
    (&["pages"], "pages"),
    (&["volume"], "volume"),
    (&["number"], "issue"),
    (&["issue"], "issue"),
    (&["edition"], "edition"),
    (&["publisher"], "publisher"),
    (&["pub-location"], "place"),
    (&["isbn"], "isbn"),
    (&["electronic-resource-num"], "doi"),
    (&["abstract"], "abstract"),
    (&["language"], "language"),
    (&["work-type"], "genre"),
    (&["access-date"], "accessed"),
    (&["label"], "citationKey"),
];

pub fn parse(text: &str) -> Result<(Vec<Record>, Vec<Warning>), String> {
    let root = parse_xml(text)?;
    let mut found = Vec::new();
    find_records(&root, &mut found);
    let mut records = Vec::new();
    let warnings = Vec::new();
    for (index, pointer) in found.into_iter().enumerate() {
        // SAFETY: the pointers point into `root`, which outlives this loop and is not changed.
        let record_node = unsafe { &*pointer };
        let type_name = record_node.child("ref-type").and_then(|n| n.attrs.iter().find(|(k, _)| k == "name").map(|(_, v)| v.clone())).unwrap_or_default();
        let mut input = fields::reference_input(item_type(&type_name));
        if item_type(&type_name) == "document" && !type_name.is_empty() {
            keep(&mut input, NS, "ref-type", &type_name);
        }
        let mut record = Record { line: 0, ..Default::default() };
        if let Some(contributors) = record_node.child("contributors") {
            for (group, role) in [("authors", "author"), ("secondary-authors", "editor"), ("tertiary-authors", "series-editor"), ("translated-authors", "translator"), ("subsidiary-authors", "contributor")] {
                for node in contributors.child(group).into_iter().flat_map(|g| g.all("author")) {
                    let name = node.content();
                    if !name.trim().is_empty() {
                        input.creators.push(person(&name, role));
                    }
                }
            }
        }
        for (path, column) in FIELD_MAP {
            if let Some(value) = record_node.text_at(path) {
                if column == &"containerShort" && fields::text(&input.fields, "containerTitle").is_none() {
                    put(&mut input, "containerTitle", &value);
                } else {
                    put(&mut input, column, &value);
                }
            }
        }
        if let Some(year) = record_node.text_at(&["dates", "year"]) {
            let date = record_node.text_at(&["dates", "pub-dates", "date"]);
            let month = date.as_deref().and_then(|d| d.split_whitespace().next());
            put(&mut input, "date", &fields::iso_date(&year, month, date.as_deref().and_then(|d| d.split_whitespace().nth(1))));
        }
        if let Some(sn) = record_node.text_at(&["isbn"]) {
            if sn.len() == 9 && sn.as_bytes().get(4) == Some(&b'-') {
                input.fields.remove("isbn");
                put(&mut input, "issn", &sn);
            }
        }
        for node in record_node.path(&["urls", "related-urls"]).into_iter().flat_map(|n| n.all("url")) {
            let url = node.content().trim().to_string();
            if fields::text(&input.fields, "url").is_none() {
                put(&mut input, "url", &url);
            } else {
                keep(&mut input, NS, "url", &url);
            }
        }
        for node in record_node.path(&["urls", "pdf-urls"]).into_iter().flat_map(|n| n.all("url")) {
            let url = node.content().trim().to_string();
            record.files.push(url.strip_prefix("file://").unwrap_or(&url).to_string());
        }
        for node in record_node.child("keywords").into_iter().flat_map(|k| k.all("keyword")) {
            fields::add_tags(&mut input, fields::keywords(&node.content()));
        }
        for field in ["notes", "research-notes"] {
            if let Some(note) = record_node.text_at(&[field]) {
                record.notes.push(note);
            }
        }
        for child in &record_node.children {
            let known = matches!(
                child.name.as_str(),
                "ref-type" | "contributors" | "titles" | "periodical" | "pages" | "volume" | "number" | "issue" | "edition" | "publisher" | "pub-location"
                    | "isbn" | "electronic-resource-num" | "abstract" | "language" | "work-type" | "access-date" | "label" | "dates" | "urls" | "keywords"
                    | "notes" | "research-notes" | "database" | "source-app" | "rec-number" | "foreign-keys"
            );
            if !known {
                keep(&mut input, NS, &child.name, child.content().trim());
            }
        }
        record.line = index + 1;
        record.source = input;
        records.push(record);
    }
    Ok((records, warnings))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_records() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?><xml><records><record><database name="My.enl">My.enl</database><ref-type name="Journal Article">17</ref-type>
<contributors><authors><author><style face="normal">Smith, John</style></author><author>World Health Organization</author></authors></contributors>
<titles><title><style>Malaria &amp; mosquitoes</style></title><secondary-title>Lancet</secondary-title></titles>
<pages>1-9</pages><volume>3</volume><keywords><keyword>malaria</keyword></keywords><dates><year>2018</year><pub-dates><date>Mar</date></pub-dates></dates>
<electronic-resource-num>10.1/abc</electronic-resource-num><urls><pdf-urls><url>internal-pdf://x.pdf</url></pdf-urls></urls><custom1>c1</custom1></record></records></xml>"#;
        let (records, _) = parse(xml).unwrap();
        let r = &records[0];
        assert_eq!(r.title(), "Malaria & mosquitoes");
        assert_eq!(r.source.creators[1].literal.as_deref(), Some("World Health Organization"));
        assert_eq!(fields::text(&r.source.fields, "date"), Some("2018-03"));
        assert_eq!(fields::text(&r.source.fields, "doi"), Some("10.1/abc"));
        assert_eq!(r.source.tags, ["malaria"]);
        assert_eq!(r.files, ["internal-pdf://x.pdf"]);
        assert!(r.source.properties.contains_key("endnote.custom1"));
    }
}
