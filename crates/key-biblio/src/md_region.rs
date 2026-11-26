// The parts of an exported Markdown file Key owns, and merging a new export into a file the
// user has written in.
//
//   ---
//   key-id: <source id>            (how Key finds the file again after a rename or move)
//   title: …                        (the managed front-matter keys; the user's own stay)
//   ---
//   <!-- key:begin id=<source id> -->
//   … rendered from the template …
//   <!-- key:ann id=<annotation id> -->
//   > the highlight
//   <!-- key:notes -->
//   the user's notes on it (kept)
//   <!-- key:ann-end -->
//   <!-- key:end -->
//   Anything outside the begin/end markers is the user's and is never changed.
use serde_json::Value as Json;
use std::collections::HashMap;

pub const BEGIN: &str = "<!-- key:begin";
pub const END: &str = "<!-- key:end -->";
pub const ANN: &str = "<!-- key:ann id=";
pub const NOTES: &str = "<!-- key:notes -->";
pub const ANN_END: &str = "<!-- key:ann-end -->";
pub const ID_KEY: &str = "key-id";
const DELETED_LINE: &str = "*Removed in Key*";

/// The front matter's text (without its fences) and where the rest begins.
pub fn split_front_matter(text: &str) -> Option<(&str, usize)> {
    let rest = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n"))?;
    let offset = text.len() - rest.len();
    let mut at = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" || line.trim_end() == "..." {
            return Some((&rest[..at], offset + at + line.len()));
        }
        at += line.len();
    }
    None
}

/// A top-level front-matter value as text (`key-id: abc` → "abc").
pub fn front_matter_value(text: &str, key: &str) -> Option<String> {
    let (fm, _) = split_front_matter(text)?;
    fm.lines().find_map(|line| {
        let (k, v) = line.split_once(':')?;
        (k.trim() == key && !line.starts_with(char::is_whitespace)).then(|| v.trim().trim_matches('"').trim_matches('\'').to_string())
    })
}

/// A YAML entry: `key: value`, or a list.
pub fn yaml_entry(key: &str, value: &Json) -> String {
    match value {
        Json::Array(items) if items.is_empty() => format!("{key}: []\n"),
        Json::Array(items) => {
            let mut out = format!("{key}:\n");
            for item in items {
                out.push_str(&format!("  - {}\n", crate::template::yaml_scalar(&crate::template::text(item))));
            }
            out
        }
        Json::Number(n) => format!("{key}: {n}\n"),
        Json::Bool(b) => format!("{key}: {b}\n"),
        Json::Null => format!("{key}:\n"),
        other => format!("{key}: {}\n", crate::template::yaml_scalar(&crate::template::text(other))),
    }
}

/// Top-level entries of a front matter, in order: (key, its text with continuation lines).
fn entries(fm: &str) -> Vec<(Option<String>, String)> {
    let mut out: Vec<(Option<String>, String)> = Vec::new();
    for line in fm.split_inclusive('\n') {
        let continuation = line.starts_with(char::is_whitespace) || line.starts_with("- ") || line.trim().is_empty();
        let key = (!continuation).then(|| line.split_once(':').map(|(k, _)| k.trim().to_string())).flatten();
        match (key, out.last_mut()) {
            (None, Some(last)) => last.1.push_str(line),
            (key, _) => out.push((key, line.to_string())),
        }
    }
    out
}

/// The front matter with Key's entries replaced or added; the user's keys stay as they are,
/// in their order. `previous` are keys Key wrote before and no longer writes (removed).
pub fn merge_front_matter(existing: Option<&str>, managed: &[(String, Json)], previous: &[String]) -> String {
    let mut out = String::from("---\n");
    let mut written: Vec<&str> = Vec::new();
    for (key, text) in existing.map(entries).unwrap_or_default() {
        let mut text = text;
        if !text.ends_with('\n') {
            text.push('\n');
        }
        match key {
            Some(k) => {
                if let Some((name, value)) = managed.iter().find(|(name, _)| *name == k) {
                    if !written.contains(&name.as_str()) {
                        out.push_str(&yaml_entry(name, value));
                        written.push(name);
                    }
                } else if !previous.contains(&k) {
                    out.push_str(&text);
                }
            }
            None => out.push_str(&text),
        }
    }
    for (name, value) in managed {
        if !written.contains(&name.as_str()) {
            out.push_str(&yaml_entry(name, value));
        }
    }
    out.push_str("---\n");
    out
}

/// Where Key's part is: from the start of its begin marker to the end of its end marker.
pub fn find_region(text: &str) -> Result<Option<(usize, usize)>, String> {
    let Some(start) = text.find(BEGIN) else {
        return Ok(None);
    };
    let end = text[start..].find(END).ok_or("Key's section has no end marker")? + start + END.len();
    if text[end..].contains(BEGIN) {
        return Err("The file has more than one Key section".into());
    }
    Ok(Some((start, end)))
}

pub fn region(id: &str, body: &str) -> String {
    let body = body.trim_matches('\n');
    format!("{BEGIN} id={id} -->\n{body}\n{END}")
}

/// One annotation's block in a region.
#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    pub id: String,
    pub deleted: bool,
    /// The whole block, markers included.
    pub text: String,
    /// What the user wrote under "notes" (trimmed of the blank line Key leaves).
    pub notes: String,
}

/// The annotation blocks in a region, in order.
pub fn blocks(region: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut rest = region;
    while let Some(start) = rest.find(ANN) {
        let after = &rest[start..];
        let Some(end) = after.find(ANN_END) else { break };
        let text = &after[..end + ANN_END.len()];
        let head_end = text.find("-->").unwrap_or(text.len());
        let head = &text[ANN.len()..head_end];
        let mut parts = head.split_whitespace();
        let id = parts.next().unwrap_or("").to_string();
        let deleted = parts.any(|p| p == "deleted");
        let notes = text.find(NOTES).map(|n| text[n + NOTES.len()..text.len() - ANN_END.len()].trim_matches('\n').to_string()).unwrap_or_default();
        out.push(Block { id, deleted, text: text.to_string(), notes });
        rest = &after[end + ANN_END.len()..];
    }
    out
}

/// The region as Key wrote it: the user's notes taken out, line endings made plain, so an
/// edit the user made to Key's own text shows as a change.
pub fn fingerprint(region: &str) -> String {
    let mut plain = String::with_capacity(region.len());
    let mut rest = region.replace("\r\n", "\n");
    while let Some(n) = rest.find(NOTES) {
        let after = n + NOTES.len();
        let close = rest[after..].find(ANN_END).map_or(rest.len(), |e| after + e);
        plain.push_str(&rest[..after]);
        rest = rest[close..].to_string();
    }
    plain.push_str(&rest);
    let plain: String = plain.lines().map(str::trim_end).collect::<Vec<_>>().join("\n");
    format!("{:016x}", fnv(plain.trim().as_bytes()))
}

pub fn fnv(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// The markers around one annotation's output, with the user's notes kept in between.
pub fn block_markers(id: &str, notes: Option<&str>, with_notes: bool) -> (String, String) {
    let begin = format!("{ANN}{id} -->\n");
    let end = match (with_notes, notes.filter(|n| !n.trim().is_empty())) {
        (_, Some(notes)) => format!("{NOTES}\n{}\n{ANN_END}\n", notes.trim_matches('\n')),
        (true, None) => format!("{NOTES}\n{ANN_END}\n"),
        (false, None) => format!("{ANN_END}\n"),
    };
    (begin, end)
}

/// A block whose annotation is gone from Key, marked so (once).
pub fn mark_deleted(block: &Block) -> String {
    if block.deleted {
        return block.text.clone();
    }
    let head_end = block.text.find("-->").map_or(0, |n| n + 3);
    let rest = block.text[head_end..].trim_start_matches('\n');
    format!("{ANN}{} deleted -->\n{DELETED_LINE}\n{rest}", block.id)
}

/// What a merge produced.
#[derive(Debug, PartialEq)]
pub enum Merge {
    /// The new file text.
    Write(String),
    /// Key's own text in the file was edited since the last export (or its markers are
    /// broken): the file stays as it is; the new export is written beside it.
    Conflict { reason: String, fresh: String },
}

/// Inputs for one file.
pub struct Export<'a> {
    pub id: &'a str,
    /// Managed front-matter entries (key-id comes first on its own).
    pub front: Vec<(String, Json)>,
    /// Keys Key wrote last time; ones it no longer writes are removed.
    pub previous_front: &'a [String],
    /// The rendered region body (with annotation markers and kept notes).
    pub body: String,
    /// Blocks to carry over at the end (annotations deleted in Key).
    pub carried: Vec<String>,
}

/// The notes the user wrote per annotation, and the blocks in the old region.
pub fn old_blocks(existing: Option<&str>) -> Vec<Block> {
    let Some(text) = existing else { return Vec::new() };
    match find_region(text) {
        Ok(Some((start, end))) => blocks(&text[start..end]),
        _ => Vec::new(),
    }
}

pub fn notes_by_id(blocks: &[Block]) -> HashMap<String, String> {
    blocks.iter().filter(|b| !b.notes.trim().is_empty()).map(|b| (b.id.clone(), b.notes.clone())).collect()
}

/// Merges an export into the file's current text. `expected` is the fingerprint of the
/// region Key last wrote (None: never written, or forced).
pub fn merge(existing: Option<&str>, export: &Export, expected: Option<&str>) -> Merge {
    let mut front = vec![(ID_KEY.to_string(), Json::String(export.id.to_string()))];
    front.extend(export.front.iter().filter(|(k, _)| k != ID_KEY).cloned());
    let mut body = export.body.trim_end_matches('\n').to_string();
    for carried in &export.carried {
        body.push_str("\n\n");
        body.push_str(carried.trim_end_matches('\n'));
    }
    let new_region = region(export.id, &body);
    let fresh = |existing: Option<&str>| {
        let fm = merge_front_matter(existing.and_then(split_front_matter).map(|(f, _)| f), &front, export.previous_front);
        format!("{fm}\n{new_region}\n")
    };
    let Some(text) = existing else {
        return Merge::Write(fresh(None));
    };
    let (start, end) = match find_region(text) {
        Ok(Some(found)) => found,
        Ok(None) => return Merge::Conflict { reason: "Key's section markers were removed from the file".into(), fresh: fresh(Some(text)) },
        Err(reason) => return Merge::Conflict { reason, fresh: fresh(Some(text)) },
    };
    if let Some(expected) = expected {
        if fingerprint(&text[start..end]) != expected {
            return Merge::Conflict { reason: "Key's section was edited since the last export".into(), fresh: fresh(Some(text)) };
        }
    }
    let (fm, body_start) = match split_front_matter(text) {
        Some((fm, at)) if at <= start => (Some(fm), at),
        _ => (None, 0),
    };
    let front_text = merge_front_matter(fm, &front, export.previous_front);
    let mut out = String::with_capacity(text.len() + new_region.len());
    out.push_str(&front_text);
    if fm.is_none() && !text[..start].starts_with('\n') {
        out.push('\n');
    }
    out.push_str(&text[body_start..start]);
    out.push_str(&new_region);
    out.push_str(&text[end..]);
    Merge::Write(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn export<'a>(body: &str, previous: &'a [String]) -> Export<'a> {
        Export { id: "S1", front: vec![("title".into(), json!("A: B")), ("tags".into(), json!(["x", "y z"]))], previous_front: previous, body: body.into(), carried: vec![] }
    }

    #[test]
    fn new_file_has_front_matter_and_region() {
        let Merge::Write(text) = merge(None, &export("Hello", &[]), None) else { panic!() };
        assert_eq!(text, "---\nkey-id: S1\ntitle: \"A: B\"\ntags:\n  - x\n  - y z\n---\n\n<!-- key:begin id=S1 -->\nHello\n<!-- key:end -->\n");
        assert_eq!(front_matter_value(&text, "key-id").as_deref(), Some("S1"));
    }

    #[test]
    fn keeps_user_text_and_keys() {
        let Merge::Write(first) = merge(None, &export("One", &[]), None) else { panic!() };
        let edited = first.replace("---\n\n<!--", "---\nMy intro.\n\n<!--").replace("tags:", "mine: kept\ntags:") + "\nMy conclusion.\n";
        let previous = vec!["title".to_string(), "tags".to_string()];
        let expected = fingerprint(&first[find_region(&first).unwrap().unwrap().0..find_region(&first).unwrap().unwrap().1]);
        let Merge::Write(second) = merge(Some(&edited), &export("Two", &previous), Some(&expected)) else { panic!() };
        assert!(second.contains("My intro.\n\n<!-- key:begin id=S1 -->\nTwo\n<!-- key:end -->\n\nMy conclusion.\n"), "{second}");
        assert!(second.contains("mine: kept\n"));
        assert_eq!(second.matches("title:").count(), 1);
    }

    #[test]
    fn an_edit_inside_keys_text_is_a_conflict() {
        let Merge::Write(first) = merge(None, &export("One", &[]), None) else { panic!() };
        let (s, e) = find_region(&first).unwrap().unwrap();
        let expected = fingerprint(&first[s..e]);
        let edited = first.replace("One", "One, changed by hand");
        assert!(matches!(merge(Some(&edited), &export("Two", &[]), Some(&expected)), Merge::Conflict { .. }));
        let unmarked = first.replace(END, "");
        assert!(matches!(merge(Some(&unmarked), &export("Two", &[]), Some(&expected)), Merge::Conflict { .. }));
    }

    #[test]
    fn notes_under_annotations_do_not_count_as_edits() {
        let (b, e) = block_markers("A1", None, true);
        let body = format!("{b}> quote\n{e}");
        let Merge::Write(first) = merge(None, &export(&body, &[]), None) else { panic!() };
        let (s, end) = find_region(&first).unwrap().unwrap();
        let expected = fingerprint(&first[s..end]);
        let edited = first.replace(&format!("{NOTES}\n"), &format!("{NOTES}\nMy thought.\n"));
        let (s2, e2) = find_region(&edited).unwrap().unwrap();
        assert_eq!(fingerprint(&edited[s2..e2]), expected);
        let kept = notes_by_id(&old_blocks(Some(&edited)));
        assert_eq!(kept.get("A1").map(String::as_str), Some("My thought."));
        let marked = mark_deleted(&blocks(&edited[s2..e2])[0]);
        assert!(marked.starts_with("<!-- key:ann id=A1 deleted -->\n*Removed in Key*\n> quote"), "{marked}");
        assert_eq!(blocks(&marked)[0].notes, "My thought.");
    }

    #[test]
    fn removed_keys_go() {
        let text = "---\nkey-id: S1\ndoi: 10.1/x\nmine: 1\n---\nbody";
        assert_eq!(merge_front_matter(split_front_matter(text).map(|f| f.0), &[("key-id".into(), json!("S1"))], &["doi".into()]), "---\nkey-id: S1\nmine: 1\n---\n");
    }
}
