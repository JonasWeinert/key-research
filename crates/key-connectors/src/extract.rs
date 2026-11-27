// Reading one record out of one item of an answer: paths, then the fixed operations in their
// fixed order (path -> drop -> split -> regex -> replace -> template -> map -> type).
use crate::paths::{self, Node};
use crate::record::Record;
use crate::spec::{Extract, RecordMap, Rule};
use regex::Regex;

pub fn record(item: &Node, map: &RecordMap) -> Result<Record, String> {
    let mut out = Record::default();
    for (field, extract) in map {
        if field == "extras" {
            if let Extract::Rule(rule) = extract {
                for (name, inner) in &rule.fields {
                    let values = values(item, inner, true)?;
                    if !values.is_empty() {
                        out.extras.insert(name.clone(), values.join("; "));
                    }
                }
            }
            continue;
        }
        let list = matches!(field.as_str(), "authors" | "keywords");
        let values = values(item, extract, list)?;
        out.set(field, values);
    }
    if out.doi.is_some() {
        out.doi = out.doi.as_deref().and_then(key_store::normalize::doi);
    }
    Ok(out)
}

/// The values an extractor reads from the item (`list`: keep all, else at most one).
pub fn values(item: &Node, extract: &Extract, list: bool) -> Result<Vec<String>, String> {
    let rule = match extract {
        Extract::Path(path) => Rule { path: Some(path.clone()), all: list, ..Default::default() },
        Extract::Rule(rule) => (**rule).clone(),
    };
    let all = rule.all || list;
    let paths: Vec<&String> = rule.path.iter().chain(rule.first.iter()).collect();
    let mut raw: Vec<String> = Vec::new();
    for path in paths {
        let nodes = paths::select(item, path)?;
        let texts: Vec<String> = if rule.kind.as_deref() == Some("inverted-index") {
            nodes.iter().filter_map(paths::json_of).filter_map(key_store::abstract_text).collect()
        } else if let Some(parts) = &rule.name {
            nodes.iter().map(|n| name_of(n, parts)).collect::<Result<Vec<_>, _>>()?.into_iter().flatten().collect()
        } else {
            nodes.iter().filter_map(paths::text).collect()
        };
        let texts: Vec<String> = texts.into_iter().filter(|t| !t.trim().is_empty()).collect();
        if !texts.is_empty() {
            raw = texts;
            break;
        }
    }
    let base = paths::base_of(item);
    let mut out = Vec::new();
    for value in raw {
        let pieces: Vec<String> = match &rule.split {
            Some(sep) => match sep.strip_prefix("re:") {
                Some(re) => Regex::new(re).map_err(|e| e.to_string())?.split(&value).map(str::to_string).collect(),
                None => value.split(sep.as_str()).map(str::to_string).collect(),
            },
            None => vec![value],
        };
        for piece in pieces {
            if let Some(v) = transform(item, &rule, &piece, base.as_ref())? {
                out.push(v);
            }
        }
        if !all && !out.is_empty() {
            break;
        }
    }
    if out.is_empty() {
        if let Some(default) = &rule.default {
            out.push(default.clone());
        }
    }
    if let Some(join) = &rule.join {
        if !out.is_empty() {
            out = vec![out.join(join)];
        }
    }
    if !all {
        out.truncate(1);
    }
    Ok(out)
}

fn name_of(node: &Node, parts: &crate::spec::NameParts) -> Result<Option<String>, String> {
    let read = |path: &Option<String>| -> Result<Option<String>, String> {
        let Some(path) = path else { return Ok(None) };
        Ok(paths::select(node, path)?.iter().filter_map(paths::text).map(|t| fold_space(&t)).find(|t| !t.is_empty()))
    };
    let family = read(&parts.family)?;
    let given = read(&parts.given)?;
    if let Some(family) = family {
        return Ok(Some(match given {
            Some(g) => format!("{family}, {g}"),
            None => family,
        }));
    }
    if let Some(literal) = read(&parts.literal)? {
        return Ok(Some(literal));
    }
    Ok(paths::text(node).map(|t| fold_space(&t)).filter(|t| !t.is_empty() && parts.literal.is_none() && parts.family.is_none()))
}

fn transform(item: &Node, rule: &Rule, value: &str, base: Option<&url::Url>) -> Result<Option<String>, String> {
    let mut v = fold_space(value);
    if v.is_empty() || rule.drop.iter().any(|d| d.eq_ignore_ascii_case(&v)) {
        return Ok(None);
    }
    if let Some(re) = &rule.regex {
        let re = Regex::new(re).map_err(|e| e.to_string())?;
        match re.captures(&v) {
            Some(c) => v = c.get(1).or_else(|| c.get(0)).map(|m| m.as_str().to_string()).unwrap_or_default(),
            None => return Ok(None),
        }
    }
    for r in &rule.replace {
        v = Regex::new(&r.find).map_err(|e| e.to_string())?.replace_all(&v, r.with.as_str()).into_owned();
    }
    if let Some(template) = &rule.template {
        v = fill(item, template, &v)?;
    }
    if !rule.map.is_empty() {
        if let Some(mapped) = rule.map.get(&v).or_else(|| rule.map.iter().find(|(k, _)| k.eq_ignore_ascii_case(&v)).map(|(_, m)| m)) {
            v = mapped.clone();
        }
    }
    let v = match rule.kind.as_deref() {
        None | Some("inverted-index") => Some(v),
        Some("text") => Some(clean_text(&v)),
        Some("year") => year(&v).map(|y| y.to_string()),
        Some("date") => date(&v),
        Some("doi") => key_store::normalize::doi(&v).filter(|d| doi_shape(d)),
        Some("int") => {
            let digits: String = v.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
            Some(digits)
        }
        Some("url") => resolve(&v, base),
        Some("language") => Some(language(&v)),
        Some(_) => Some(v),
    };
    Ok(v.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()))
}

/// `{value}` and `{$.path}` (relative to the item).
fn fill(item: &Node, template: &str, value: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(at) = rest.find('{') {
        out.push_str(&rest[..at]);
        let end = rest[at..].find('}').map(|e| e + at).ok_or("an unclosed { in a template")?;
        let name = &rest[at + 1..end];
        if name == "value" {
            out.push_str(value);
        } else if name.starts_with('$') || name.starts_with('/') || name.starts_with('.') {
            let text = paths::select(item, name)?.iter().filter_map(paths::text).map(|t| fold_space(&t)).find(|t| !t.is_empty()).unwrap_or_default();
            out.push_str(&text);
        } else {
            return Err(format!("unknown {{{name}}} in an extractor template"));
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

pub fn fold_space(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Text without markup: tags dropped, character references decoded, spaces folded.
pub fn clean_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for c in text.chars() {
        match c {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let decoded = key_store::html_dom::decode(&out);
    // Inline markup leaves spaces before punctuation ("<i>x</i>.").
    let folded = fold_space(&decoded);
    folded.replace(" .", ".").replace(" ,", ",").replace(" ;", ";").replace(" :", ":").replace("( ", "(").replace(" )", ")")
}

fn doi_shape(doi: &str) -> bool {
    let Some((prefix, suffix)) = doi.split_once('/') else { return false };
    let registrant = prefix.strip_prefix("10.").unwrap_or("");
    (4..=9).contains(&registrant.split('.').next().unwrap_or("").len()) && registrant.chars().all(|c| c.is_ascii_digit() || c == '.') && !suffix.is_empty()
}

pub fn year(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    for i in 0..bytes.len().saturating_sub(3) {
        let w = &text[i..i + 4];
        let boundary = |j: Option<&u8>| j.is_none_or(|b| !b.is_ascii_digit());
        if w.bytes().all(|b| b.is_ascii_digit()) && boundary(if i == 0 { None } else { bytes.get(i - 1) }) && boundary(bytes.get(i + 4)) {
            let y: i64 = w.parse().ok()?;
            if (1500..=2100).contains(&y) {
                return Some(y);
            }
        }
    }
    None
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// YYYY, YYYY-MM or YYYY-MM-DD from "2021-03-04", "2021/3/4", "2021 Mar 4", "4 March 2021",
/// "[2021, 3, 4]" (date-parts), "20210304".
pub fn date(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if lower.len() == 8 && lower.bytes().all(|b| b.is_ascii_digit()) {
        return Some(format!("{}-{}-{}", &lower[..4], &lower[4..6], &lower[6..]));
    }
    let tokens: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).collect();
    let y = tokens.iter().position(|t| t.len() == 4 && t.parse::<i64>().is_ok_and(|y| (1500..=2100).contains(&y)))?;
    let year = tokens[y];
    let month_of = |t: &str| -> Option<u32> {
        if let Ok(n) = t.parse::<u32>() {
            return (1..=12).contains(&n).then_some(n);
        }
        MONTHS.iter().position(|m| t.starts_with(m)).map(|i| i as u32 + 1)
    };
    let rest: Vec<&str> = tokens.iter().enumerate().filter(|(i, _)| *i != y).map(|(_, t)| *t).collect();
    // Year first ("2021-03-04", "2021 Mar 4"), or day month year ("4 March 2021").
    let (month, day) = if y == 0 {
        (rest.first().and_then(|t| month_of(t)), rest.get(1).and_then(|t| t.parse::<u32>().ok()))
    } else {
        let named = rest.iter().position(|t| t.parse::<u32>().is_err() && month_of(t).is_some());
        match named {
            Some(i) => (month_of(rest[i]), rest.iter().enumerate().find(|(j, t)| *j != i && t.parse::<u32>().is_ok()).and_then(|(_, t)| t.parse().ok())),
            // "03/04/2021": month/day order is ambiguous; keep the year only.
            None => (None, None),
        }
    };
    Some(match (month, day.filter(|d| (1..=31).contains(d))) {
        (Some(m), Some(d)) => format!("{year}-{m:02}-{d:02}"),
        (Some(m), None) => format!("{year}-{m:02}"),
        _ => year.to_string(),
    })
}

fn resolve(text: &str, base: Option<&url::Url>) -> Option<String> {
    let url = match base {
        Some(base) => base.join(text.trim()).ok()?,
        None => url::Url::parse(text.trim()).ok()?,
    };
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

pub fn language(text: &str) -> String {
    let t = text.trim().to_lowercase();
    let code = match t.as_str() {
        "eng" | "english" | "en-us" | "en-gb" => "en",
        "ger" | "deu" | "german" | "deutsch" => "de",
        "fre" | "fra" | "french" | "français" => "fr",
        "spa" | "spanish" | "español" => "es",
        "por" | "portuguese" => "pt",
        "ita" | "italian" => "it",
        "dut" | "nld" | "dutch" => "nl",
        "chi" | "zho" | "chinese" => "zh",
        "jpn" | "japanese" => "ja",
        "rus" | "russian" => "ru",
        other => return other.split(['-', '_']).next().unwrap_or(other).to_string(),
    };
    code.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Doc;

    fn rule(json: serde_json::Value) -> Extract {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn operations_run_in_order() {
        let doc = Doc::parse("json", br#"{"url":"https://www.nber.org/papers/w12345","doi":"No DOI","authors":"<a href='/p/a'>Ann Lee</a>, Bo Ng","src":"MED","id":"42",
            "date":{"date-parts":[[2021,3,4]]},"inv":{"Hello":[0],"world":[1]}}"#, None).unwrap();
        let item = doc.root();
        let v = |j| values(&item, &rule(j), false).unwrap();
        assert_eq!(v(serde_json::json!({"path": "$.url", "regex": "/papers/(w\\d+)", "template": "10.3386/{value}", "type": "doi"})), vec!["10.3386/w12345"]);
        assert!(v(serde_json::json!({"path": "$.doi", "type": "doi"})).is_empty());
        assert!(v(serde_json::json!({"path": "$.doi", "drop": ["no doi"]})).is_empty());
        assert_eq!(values(&item, &rule(serde_json::json!({"path": "$.authors", "split": ",", "type": "text"})), true).unwrap(), vec!["Ann Lee", "Bo Ng"]);
        assert_eq!(v(serde_json::json!({"path": "$.id", "template": "https://europepmc.org/article/{$.src}/{value}"})), vec!["https://europepmc.org/article/MED/42"]);
        assert_eq!(v(serde_json::json!({"path": "$.date.date-parts[0]", "type": "date"})), vec!["2021-03-04"]);
        assert_eq!(v(serde_json::json!({"path": "$.inv", "type": "inverted-index"})), vec!["Hello world"]);
        assert_eq!(v(serde_json::json!({"path": "$.missing", "default": "report"})), vec!["report"]);
    }

    #[test]
    fn dates_years_and_text() {
        assert_eq!(date("2021 Mar 4").as_deref(), Some("2021-03-04"));
        assert_eq!(date("4 March 2021").as_deref(), Some("2021-03-04"));
        assert_eq!(date("2021-03").as_deref(), Some("2021-03"));
        assert_eq!(date("20210304").as_deref(), Some("2021-03-04"));
        assert_eq!(date("Winter 2019").as_deref(), Some("2019"));
        assert_eq!(year("MedlineDate 2019 Dec-2020 Jan"), Some(2019));
        assert_eq!(year("no 12345 here"), None);
        assert_eq!(clean_text("<jats:p>Tom &amp; <i>Jerry</i>.</jats:p>"), "Tom & Jerry.");
        assert_eq!(language("English"), "en");
    }
}
