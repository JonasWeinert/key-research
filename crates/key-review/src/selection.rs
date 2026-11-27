// A passage selected in a review's reader, read for extraction: the numbers in it the way papers
// write them (parse), and where it can go in the study's forms (targets). The reader's selection
// menu shows the targets in this order; choosing one fills the field(s) given, with the passage
// as their source.
//
// Numbers: "12.3 (4.5)" mean and SD, "24.1 ± 3.2", "45/120" events and total, "n = 120", "37.5%",
// "0.52 (95% CI 0.31 to 0.88)", "OR 1.8, 95% CI 1.2–3.4", "(1.2–3.4)", "median 12 (IQR 8–15)",
// "p < 0.001", with a unicode minus, thin or no-break spaces (also as thousands separators), the
// Lancet's middle-dot decimal and decimal commas ("12,3 (4,5)") read as papers mean them.
use crate::logic::visible_fields;
use crate::model::{Field, Form};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};
use std::collections::BTreeMap;

const MARK: char = '\u{1}';

/// One number in the passage and where it was.
#[derive(Clone, Copy, Debug)]
struct Num {
    value: f64,
}

/// The passage with each number replaced by MARK, the numbers in order, and the text tidied.
fn skeleton(text: &str) -> (String, Vec<Num>) {
    // Thin, narrow and no-break spaces between digit groups are thousands separators ("1 234").
    let chars: Vec<char> = text.chars().collect();
    let thin = |c: char| matches!(c, '\u{00A0}' | '\u{2009}' | '\u{202F}' | '\u{2007}' | '\u{200A}');
    let mut t = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        if thin(c) {
            let before = i > 0 && chars[i - 1].is_ascii_digit();
            let group = chars.get(i + 1..i + 4).is_some_and(|g| g.iter().all(|d| d.is_ascii_digit())) && !chars.get(i + 4).is_some_and(|d| d.is_ascii_digit());
            if before && group {
                continue;
            }
            t.push(' ');
            continue;
        }
        t.push(match c {
            '\u{2212}' | '\u{FE63}' | '\u{FF0D}' => '-',
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' => '–',
            '\u{00B7}' if i > 0 && chars[i - 1].is_ascii_digit() && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()) => '.',
            '\u{2264}' => '<',
            '\u{2265}' => '>',
            c if c.is_whitespace() => ' ',
            c => c,
        });
    }
    let t = t.replace("+/-", "±").replace("+/–", "±").replace("+-", "±");
    let chars: Vec<char> = t.chars().collect();
    let mut out = String::with_capacity(t.len());
    let mut nums = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // A sign belongs to the number when nothing number-like is right before it.
        let signed = c == '-' && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()) && (i == 0 || !(chars[i - 1].is_ascii_alphanumeric() || chars[i - 1] == '.' || chars[i - 1] == ')'));
        if c.is_ascii_digit() || signed {
            let start = i;
            if signed {
                i += 1;
            }
            while i < chars.len() && (chars[i].is_ascii_digit() || ((chars[i] == '.' || chars[i] == ',') && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()))) {
                i += 1;
            }
            let token: String = chars[start..i].iter().collect();
            for value in read_number(&token) {
                nums.push(Num { value });
                out.push(MARK);
            }
            continue;
        }
        // A hyphen between two numbers is a range ("0.31-0.88").
        out.push(if c == '-' && out.ends_with(MARK) && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()) { '–' } else { c });
        i += 1;
    }
    (out, nums)
}

/// A number as written: decimal point or comma, thousands separators; "0.31,0.88" is two.
fn read_number(token: &str) -> Vec<f64> {
    let (sign, digits) = token.strip_prefix('-').map_or((1.0, token), |d| (-1.0, d));
    let parse = |s: &str| s.parse::<f64>().ok().map(|v| v * sign);
    let dots = digits.matches('.').count();
    let commas = digits.matches(',').count();
    let value = match (dots, commas) {
        (0, 0) => parse(digits),
        (1, 0) => parse(digits),
        (_, 0) => parse(&digits.replace('.', "")),
        (0, 1) => {
            let (whole, frac) = digits.split_once(',').unwrap();
            // "1,234" is a thousand; "12,3" and "0,52" are decimals.
            if frac.len() == 3 && whole != "0" && !whole.starts_with('0') { parse(&format!("{whole}{frac}")) } else { parse(&format!("{whole}.{frac}")) }
        }
        (0, _) => parse(&digits.replace(',', "")),
        (_, 1) if digits.split(',').all(|p| p.contains('.')) => {
            // Two decimals run together: "0.31,0.88".
            return digits.split(',').filter_map(|p| p.parse::<f64>().ok()).map(|v| v * sign).collect();
        }
        _ => {
            // Both: the last one is the decimal mark ("1,234.5", "1.234,5").
            let last = digits.rfind(['.', ',']).unwrap();
            let whole: String = digits[..last].chars().filter(char::is_ascii_digit).collect();
            parse(&format!("{whole}.{}", &digits[last + 1..]))
        }
    };
    value.into_iter().collect()
}

/// The values in a passage selected in the reader.
pub fn parse(text: &str) -> Json {
    let (sk, nums) = skeleton(text);
    let low = sk.to_lowercase();
    let re = |p: &str| regex::Regex::new(&p.replace('N', &format!("({MARK})"))).unwrap();
    let at = |m: regex::Match| low[..m.start()].matches(MARK).count();
    let val = |i: usize| nums.get(i).map(|n| n.value);
    let mut out = Map::new();
    let mut parts: Vec<(&str, f64)> = Vec::new();
    let mut put = |out: &mut Map<String, Json>, key: &'static str, v: Option<f64>| {
        if let Some(v) = v
            && !out.contains_key(key)
        {
            out.insert(key.into(), json!(v));
            parts.push((key, v));
        }
    };
    let mut skip = vec![false; nums.len()];
    let sep = r"\s*(?:to|,|;|–|\.\.)\s*";
    let ci = r"(?:N\s*%\s*)?(?:ci|ki|confidence interval|cri|credible interval)\b\s*[:=,]?\s*";
    // An interval with its level: "(95% CI 0.31 to 0.88)", "95% CI: 1.2–3.4".
    if let Some(c) = re(&format!(r"(?:N\s*[,;]?\s*[\(\[]?\s*)?N\s*%\s*(?:ci|ki|confidence interval|cri|credible interval)\b\s*[:=,]?\s*[\(\[]?\s*N{sep}N")).captures(&low) {
        let groups: Vec<usize> = (1..c.len()).filter_map(|g| c.get(g)).map(at).collect();
        let (est, level, lo, hi) = if groups.len() == 4 { (Some(groups[0]), groups[1], groups[2], groups[3]) } else { (None, groups[0], groups[1], groups[2]) };
        if let Some(e) = est {
            put(&mut out, "estimate", val(e));
        }
        put(&mut out, "lower", val(lo));
        put(&mut out, "upper", val(hi));
        out.insert("level".into(), json!(val(level)));
        skip[level] = true;
    } else if let Some(c) = re(&format!(r"N\s*[\(\[]\s*(?:{ci})?N{sep}N\s*[\)\]]")).captures(&low) {
        // An estimate with its interval: 0.52 (0.31 to 0.88), 0.52 [0.31, 0.88], 1.8 (1.2–3.4).
        let g: Vec<usize> = (1..c.len()).filter_map(|i| c.get(i)).map(at).collect();
        let (e, lo, hi) = if g.len() == 4 { (g[0], g[2], g[3]) } else { (g[0], g[1], g[2]) };
        if g.len() == 4 {
            skip[g[1]] = true;
            out.insert("level".into(), json!(val(g[1])));
        }
        // "median 12 (IQR 8–15)" and "12 (range 8–15)" are not intervals of an estimate.
        let before = &low[..c.get(0).unwrap().start()];
        let inside = &low[c.get(0).unwrap().start()..c.get(0).unwrap().end()];
        if inside.contains("iqr") || inside.contains("interquartile") || before.trim_end().ends_with("median") {
            put(&mut out, "median", val(e));
            put(&mut out, "q1", val(lo));
            put(&mut out, "q3", val(hi));
        } else if inside.contains("range") {
            put(&mut out, "median", val(e));
            put(&mut out, "min", val(lo));
            put(&mut out, "max", val(hi));
        } else {
            put(&mut out, "estimate", val(e));
            put(&mut out, "lower", val(lo));
            put(&mut out, "upper", val(hi));
        }
    }
    // Median with its quartiles or range written out.
    if let Some(c) = re(r"median\s*[:=]?\s*N\s*[\(\[,;]?\s*(iqr|interquartile range|range)?\s*[:=]?\s*N\s*(?:to|,|;|–)\s*N").captures(&low) {
        let g: Vec<usize> = [1, 3, 4].iter().filter_map(|&i| c.get(i)).map(at).collect();
        put(&mut out, "median", val(g[0]));
        if c.get(2).is_some_and(|m| m.as_str() == "range") {
            put(&mut out, "min", val(g[1]));
            put(&mut out, "max", val(g[2]));
        } else {
            put(&mut out, "q1", val(g[1]));
            put(&mut out, "q3", val(g[2]));
        }
    }
    // Mean (SD): "12.3 (4.5)", "mean 12.3 (SD 4.5)", "12.3 ± 4.5"; "45 (37.5%)" is a count.
    if !out.contains_key("estimate") && !out.contains_key("median") {
        if let Some(c) = re(r"N\s*\(\s*(?:sd|s\.d\.|standard deviation)?\s*[:=]?\s*N\s*(%)?\s*\)").captures(&low) {
            let (a, b) = (at(c.get(1).unwrap()), at(c.get(2).unwrap()));
            if c.get(3).is_some() {
                put(&mut out, "n", val(a));
                put(&mut out, "percent", val(b));
            } else {
                put(&mut out, "mean", val(a));
                put(&mut out, "sd", val(b));
            }
        } else if let Some(c) = re(r"N\s*±\s*N").captures(&low) {
            put(&mut out, "mean", val(at(c.get(1).unwrap())));
            put(&mut out, "sd", val(at(c.get(2).unwrap())));
        }
    }
    if let Some(c) = re(r"\b(?:se|s\.e\.|standard error)\s*[:=]?\s*N").captures(&low) {
        put(&mut out, "se", val(at(c.get(1).unwrap())));
    }
    if let Some(c) = re(r"(?:^|[^a-z])n\s*[:=]\s*N").captures(&low) {
        put(&mut out, "n", val(at(c.get(1).unwrap())));
    }
    if let Some(c) = re(r"N\s*/\s*N").captures(&low) {
        let (e, t) = (val(at(c.get(1).unwrap())), val(at(c.get(2).unwrap())));
        if let (Some(e), Some(t)) = (e, t)
            && e <= t
        {
            put(&mut out, "events", Some(e));
            put(&mut out, "total", Some(t));
        }
    }
    for c in re(r"N\s*%").captures_iter(&low) {
        let i = at(c.get(1).unwrap());
        if !skip[i] {
            put(&mut out, "percent", val(i));
            break;
        }
    }
    if let Some(c) = re(r"\bp\s*([=<>])\s*N").captures(&low) {
        let i = at(c.get(2).unwrap());
        skip[i] = true;
        out.insert("p".into(), json!(val(i)));
        out.insert("pOp".into(), json!(&c[1]));
    }
    // A bare range: "0.31–0.88", "(1.2–3.4)".
    if !out.contains_key("lower") && !out.contains_key("q1") && !out.contains_key("min")
        && let Some(c) = re(r"^\s*[\(\[]?\s*N\s*(?:–|to)\s*N\s*[\)\]]?\s*$").captures(&low)
    {
        put(&mut out, "lower", val(at(c.get(1).unwrap())));
        put(&mut out, "upper", val(at(c.get(2).unwrap())));
    }
    let numbers: Vec<f64> = nums.iter().enumerate().filter(|(i, _)| !skip[*i]).map(|(_, n)| n.value).collect();
    out.insert("numbers".into(), json!(numbers));
    out.insert("parts".into(), json!(parts.iter().map(|(k, v)| json!({ "key": k, "label": stat_label(k), "value": v })).collect::<Vec<_>>()));
    Json::Object(out)
}

fn stat_label(key: &str) -> &'static str {
    match key {
        "mean" => "mean",
        "sd" => "SD",
        "se" => "SE",
        "n" => "n",
        "events" => "events",
        "total" => "total",
        "percent" => "%",
        "estimate" => "estimate",
        "lower" => "lower",
        "upper" => "upper",
        "median" => "median",
        "q1" => "Q1",
        "q3" => "Q3",
        "min" => "min",
        "max" => "max",
        _ => "value",
    }
}

/// Plain: "12.3", "120", "0.001".
fn show(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 { format!("{}", v as i64) } else { format!("{v}") }
}

// ── Where the passage can go ────────────────────────────────────────────────────

/// Which statistic a numeric field (or table column) holds, from its id, label and unit.
fn stat_of(field: &Field) -> Option<&'static str> {
    let id = field.id.to_lowercase();
    let label = field.label.to_lowercase();
    let words = format!(" {} {} ", label.replace(['(', ')', ',', '/', '-', '_'], " "), id.replace(['_', '-'], " "));
    let has = |w: &str| words.contains(&format!(" {w} "));
    let id_is = |p: &str| id == p || (id.starts_with(p) && id[p.len()..].chars().all(|c| c.is_ascii_digit()));
    if id_is("sd") || has("sd") || label.contains("standard deviation") {
        return Some("sd");
    }
    if id_is("se") || has("se") || label.contains("standard error") {
        return Some("se");
    }
    if id_is("lower") || label.contains("lower") || has("lcl") {
        return Some("lower");
    }
    if id_is("upper") || label.contains("upper") || has("ucl") {
        return Some("upper");
    }
    if id_is("e") || label.contains("events") || has("cases") {
        return Some("events");
    }
    if id_is("m") || has("mean") || has("average") {
        return Some("mean");
    }
    if has("median") {
        return Some("median");
    }
    if has("iqr") || label.contains("quartile") {
        return Some("q1");
    }
    if id_is("estimate") || label.contains("estimate") || label.contains("effect") || label.contains("ratio") || ["or", "rr", "hr", "md", "smd"].contains(&label.trim()) {
        return Some("estimate");
    }
    if label.contains('%') || label.contains("percent") || label.contains("proportion") || field.unit.contains('%') {
        return Some("percent");
    }
    if id_is("n") || has("n") || label.contains("total") || label.contains("participants") || label.contains("sample size") || label.contains("number") || label.contains("randomised") || label.contains("randomized") || label.contains("enrolled") {
        return Some("n");
    }
    None
}

/// The values of a statistic in the passage, also under another name ("total" for n).
fn stat_value(parsed: &Json, stat: &str) -> Option<f64> {
    let get = |k: &str| parsed.get(k).and_then(Json::as_f64);
    match stat {
        "n" => get("n").or_else(|| get("total")),
        "mean" => get("mean").or_else(|| get("median")),
        "median" => get("median").or_else(|| get("mean")),
        s => get(s),
    }
}

/// What travels with a statistic ("mean" brings "sd").
fn partners(stat: &str) -> &'static [&'static str] {
    match stat {
        "mean" | "sd" => &["mean", "sd", "n"],
        "events" | "total" | "n" => &["events", "n", "percent"],
        "estimate" | "lower" | "upper" => &["estimate", "lower", "upper", "se"],
        "median" | "q1" => &["median", "q1"],
        _ => &[],
    }
}

/// A label without its statistic's words: "Mean (intervention)" → "intervention".
fn remainder(label: &str) -> String {
    let stop = ["mean", "sd", "se", "standard", "deviation", "error", "events", "total", "n", "number", "of", "lower", "upper", "95%", "ci", "reported", "estimate", "median", "%"];
    label
        .to_lowercase()
        .replace(['(', ')', ',', '/', '-'], " ")
        .split_whitespace()
        .filter(|w| !stop.contains(w))
        .collect::<Vec<_>>()
        .join(" ")
}

fn closest_option(options: &[String], text: &str) -> Option<String> {
    let t = text.to_lowercase();
    if let Some(o) = options.iter().filter(|o| !o.is_empty() && t.contains(&o.to_lowercase())).max_by_key(|o| o.len()) {
        return Some(o.clone());
    }
    // Most words in common ("a cluster-randomised trial" → "Cluster randomised trial").
    let words = |s: &str| s.to_lowercase().replace(['-', ',', '.', '(', ')'], " ").split_whitespace().filter(|w| w.len() > 2).map(|w| w.trim_end_matches('s').to_string()).collect::<Vec<_>>();
    let tw = words(text);
    options
        .iter()
        .map(|o| (words(o).iter().filter(|w| tw.contains(w)).count(), o))
        .filter(|(n, _)| *n > 0)
        .max_by_key(|(n, o)| (*n, std::cmp::Reverse(o.len())))
        .map(|(_, o)| o.clone())
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Focus {
    pub form_id: String,
    pub field_id: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TargetsRequest {
    pub text: String,
    pub forms: Vec<Form>,
    /// The study's answers, "formId/fieldId" → value (for what shows and which rows exist).
    pub values: BTreeMap<String, Json>,
    pub focus: Option<Focus>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fill {
    pub field_id: String,
    pub label: String,
    pub value: Json,
    pub display: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub form_id: String,
    pub field_id: String,
    pub form: String,
    pub section: String,
    pub label: String,
    pub kind: String,
    /// The fields it fills (one, or a statistic with its partners: mean and SD), in a table the
    /// row's columns.
    pub fills: Vec<Fill>,
    /// "→ mean 12.3, SD 4.5".
    pub preview: String,
    pub focused: bool,
    /// A table's row: None for a new one.
    pub row: Option<usize>,
    pub new_row: bool,
    /// The passage fits no value of this field: choosing it keeps the passage as the field's
    /// source only (its value stays as it is).
    pub source_only: bool,
    pub score: i32,
}

/// A passage's words as a value: whitespace as one space, words broken at a line's end joined
/// ("rando- mised" → "randomised").
pub fn clean_text(text: &str) -> String {
    let joined = regex::Regex::new(r"(\p{L})[-\u{00AD}\u{2010}]\s+(\p{Ll})").unwrap().replace_all(text, "$1$2");
    joined.split_whitespace().collect::<Vec<_>>().join(" ").trim_matches(|c: char| c == '"' || c == '“' || c == '”').to_string()
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// The dates a passage names, in order, as ISO dates to the precision given: "2015-03-12",
/// "12 March 2015" and "March 12, 2015" → 2015-03-12; "March 2015", "2015-03", "03/2015" →
/// 2015-03; a year alone (1900–2099) → 2015. "between 2012 and 2014" gives two.
pub fn dates(text: &str) -> Vec<String> {
    let t = text.to_lowercase().replace(['–', '—'], "-");
    let month = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?";
    let year = r"((?:19|20)\d{2})";
    let m = |name: &str| MONTHS.iter().position(|x| name.starts_with(x)).map(|i| i + 1).unwrap_or(1);
    let mut found: Vec<(usize, usize, String)> = Vec::new();
    let mut take = |start: usize, end: usize, value: String, found: &mut Vec<(usize, usize, String)>| {
        if !found.iter().any(|(a, b, _)| start < *b && *a < end) {
            found.push((start, end, value));
        }
    };
    let rx = |p: String| regex::Regex::new(&p).unwrap();
    for c in rx(format!(r"\b{year}-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?\b")).captures_iter(&t) {
        let all = c.get(0).unwrap();
        let v = match c.get(3) { Some(d) => format!("{}-{}-{}", &c[1], &c[2], d.as_str()), None => format!("{}-{}", &c[1], &c[2]) };
        take(all.start(), all.end(), v, &mut found);
    }
    for c in rx(format!(r"\b([0-3]?\d)(?:st|nd|rd|th)?\s+{month}\s*,?\s+{year}\b")).captures_iter(&t) {
        let all = c.get(0).unwrap();
        take(all.start(), all.end(), format!("{}-{:02}-{:02}", &c[3], m(&c[2]), c[1].parse::<u32>().unwrap_or(1)), &mut found);
    }
    for c in rx(format!(r"\b{month}\s+([0-3]?\d)(?:st|nd|rd|th)?,?\s+{year}\b")).captures_iter(&t) {
        let all = c.get(0).unwrap();
        take(all.start(), all.end(), format!("{}-{:02}-{:02}", &c[3], m(&c[1]), c[2].parse::<u32>().unwrap_or(1)), &mut found);
    }
    for c in rx(format!(r"\b{month}\s*,?\s*{year}\b")).captures_iter(&t) {
        let all = c.get(0).unwrap();
        take(all.start(), all.end(), format!("{}-{:02}", &c[2], m(&c[1])), &mut found);
    }
    for c in rx(format!(r"\b(0?[1-9]|1[0-2])/{year}\b")).captures_iter(&t) {
        let all = c.get(0).unwrap();
        take(all.start(), all.end(), format!("{}-{:02}", &c[2], c[1].parse::<u32>().unwrap_or(1)), &mut found);
    }
    for c in rx(format!(r"(^|[^\d.,/])({year})($|[^\d.,%])")).captures_iter(&t) {
        let y = c.get(2).unwrap();
        take(y.start(), y.end(), y.as_str().to_string(), &mut found);
    }
    found.sort_by_key(|(a, _, _)| *a);
    let mut out: Vec<String> = Vec::new();
    for (_, _, v) in found {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}

/// "Start of recruitment" / "End of follow-up": which end of a range a date field holds.
fn date_end(field: &Field) -> Option<bool> {
    let l = format!(" {} {} ", field.label.to_lowercase(), field.id.to_lowercase().replace('_', " "));
    if ["start", "begin", "from", "first", "onset"].iter().any(|w| l.contains(w)) {
        Some(false)
    } else if ["end", "until", "finish", "last", "stop", "completion"].iter().any(|w| l.contains(w)) {
        Some(true)
    } else {
        None
    }
}

fn display(v: &Json) -> String {
    match v {
        Json::Number(n) => n.as_f64().map(show).unwrap_or_default(),
        Json::String(s) => {
            let s: String = s.chars().take(60).collect();
            if s.len() < 60 { s } else { format!("{s}…") }
        }
        Json::Bool(b) => if *b { "Yes" } else { "No" }.into(),
        Json::Array(a) => a.iter().map(display).collect::<Vec<_>>().join(", "),
        _ => String::new(),
    }
}

/// Where a passage can go in the study's forms: the focused field first, then the fields that
/// fit what it says (numbers into numeric fields and outcome cells, words into text and choice
/// fields with the closest option), new and existing rows of repeating groups. Hidden fields are
/// not offered.
pub fn targets(req: &TargetsRequest) -> Json {
    let parsed = parse(&req.text);
    let numbers: Vec<f64> = parsed["numbers"].as_array().map(|a| a.iter().filter_map(Json::as_f64).collect()).unwrap_or_default();
    let has_words = req.text.chars().filter(|c| c.is_alphabetic()).count() >= 3;
    let text = clean_text(&req.text);
    let named_dates = dates(&req.text);
    let mut out: Vec<Target> = Vec::new();
    for form in &req.forms {
        let answers: crate::logic::Answers = req.values.iter().filter_map(|(k, v)| k.strip_prefix(&format!("{}/", form.id)).map(|f| (f.to_string(), v.clone()))).collect();
        let shown = visible_fields(form, &answers);
        for section in &form.sections {
            let fields: Vec<&Field> = section.fields.iter().filter(|f| shown.contains(&f.id)).collect();
            for field in &fields {
                let focused = req.focus.as_ref().is_some_and(|f| f.form_id == form.id && f.field_id == field.id);
                let base = |fills: Vec<Fill>, score: i32, row: Option<usize>, new_row: bool, label: String| Target {
                    id: format!("{}/{}{}", form.id, field.id, if new_row { "/new".to_string() } else { row.map(|r| format!("/{r}")).unwrap_or_default() }),
                    form_id: form.id.clone(),
                    field_id: field.id.clone(),
                    form: form.name.clone(),
                    section: section.title.clone(),
                    label,
                    kind: field.kind.clone(),
                    preview: fills.iter().map(|f| if fills.len() > 1 || f.label != field.label { format!("{} {}", f.label, f.display) } else { f.display.clone() }).collect::<Vec<_>>().join(", "),
                    fills,
                    focused,
                    row,
                    new_row,
                    source_only: false,
                    // The focused field first when the passage fits it; a weak fit (words into a
                    // text field when the passage is a date) only moves it up a little.
                    score: score + if !focused { 0 } else if score >= 30 { 1000 } else { 50 },
                };
                let before = out.len();
                let fill = |f: &Field, value: Json| Fill { field_id: f.id.clone(), label: f.label.clone(), display: display(&value), value };
                'fit: { match field.kind.as_str() {
                    "number" => {
                        let stat = stat_of(field);
                        let own = stat.and_then(|s| stat_value(&parsed, s));
                        let value = own.or_else(|| {
                            // A field we cannot name takes the passage's main value.
                            ["mean", "estimate", "n", "events", "percent", "median"].iter().find_map(|k| parsed.get(*k).and_then(Json::as_f64)).or(numbers.first().copied())
                        });
                        let Some(value) = value else { break 'fit };
                        if !focused && own.is_none() && stat.is_some() {
                            break 'fit;
                        }
                        let mut fills = vec![fill(field, json!(value))];
                        // Its partners in the same section: "Mean (intervention)" brings "SD (intervention)".
                        if let Some(s) = stat.or(if focused { parsed.get("mean").map(|_| "mean") } else { None }) {
                            let rest = remainder(&field.label);
                            for p in partners(s).iter().filter(|p| **p != s) {
                                let Some(v) = stat_value(&parsed, p).filter(|_| p != &"n" || parsed.get("n").is_some() || parsed.get("total").is_some()) else { continue };
                                let candidates: Vec<&&Field> = fields.iter().filter(|f| f.id != field.id && f.kind == "number" && stat_of(f) == Some(p)).collect();
                                let best = candidates.iter().max_by_key(|f| (remainder(&f.label) == rest) as u8);
                                if let Some(f) = best
                                    && (candidates.len() == 1 || remainder(&f.label) == rest)
                                {
                                    let f: &Field = f;
                                    fills.push(fill(f, json!(v)));
                                }
                            }
                        }
                        let score = if own.is_some() { 100 + fills.len() as i32 } else { 30 };
                        out.push(base(fills, score, None, false, field.label.clone()));
                    }
                    "text" | "longtext" => {
                        if !has_words {
                            break 'fit;
                        }
                        let score = 20 + (field.kind == "longtext") as i32 * (text.len() > 80) as i32 * 10;
                        out.push(base(vec![fill(field, json!(text))], score, None, false, field.label.clone()));
                    }
                    "date" => {
                        let Some(first) = named_dates.first() else { break 'fit };
                        let last = named_dates.last().unwrap_or(first);
                        // A range ("between 2012 and 2014") fills its start and its end.
                        let end = date_end(field);
                        let own = if end == Some(true) { last } else { first };
                        let mut fills = vec![fill(field, json!(own))];
                        if named_dates.len() > 1
                            && let Some(e) = end
                            && let Some(partner) = fields.iter().find(|f| f.id != field.id && f.kind == "date" && date_end(f) == Some(!e))
                        {
                            fills.push(fill(partner, json!(if e { first } else { last })));
                        }
                        out.push(base(fills, 90, None, false, field.label.clone()));
                    }
                    "choice" | "multi" => {
                        let option = closest_option(&field.options, &text);
                        if option.is_none() {
                            break 'fit;
                        }
                        let value = match (&option, field.kind.as_str()) {
                            (Some(o), "multi") => {
                                let mut list: Vec<Json> = answers.get(&field.id).and_then(Json::as_array).cloned().unwrap_or_default();
                                if !list.contains(&json!(o)) {
                                    list.push(json!(o));
                                }
                                json!(list)
                            }
                            (Some(o), _) => json!(o),
                            (None, _) => Json::Null,
                        };
                        let fills = if value.is_null() { vec![] } else { vec![fill(field, value)] };
                        out.push(base(fills, if option.is_some() { 80 } else { 5 }, None, false, field.label.clone()));
                    }
                    "table" => {
                        let rows: Vec<Map<String, Json>> = answers.get(&field.id).and_then(Json::as_array).map(|a| a.iter().filter_map(|r| r.as_object().cloned()).collect()).unwrap_or_default();
                        let (cells, score) = row_from(field, &parsed, &numbers, &text);
                        if cells.is_empty() {
                            break 'fit;
                        }
                        let fills: Vec<Fill> = cells.iter().map(|(c, v)| fill(c, v.clone())).collect();
                        let group = field.label.clone();
                        out.push(base(fills.clone(), score, None, true, format!("New row in {group}")));
                        for (i, row) in rows.iter().enumerate() {
                            // An existing row gets what it still lacks.
                            let missing: Vec<Fill> = fills.iter().filter(|f| row.get(&f.field_id).is_none_or(|v| v.is_null() || v == "")).cloned().collect();
                            if missing.is_empty() {
                                continue;
                            }
                            let name = field.columns.iter().filter(|c| c.kind == "text" || c.kind == "choice").find_map(|c| row.get(&c.id).and_then(Json::as_str).filter(|s| !s.is_empty())).unwrap_or("");
                            let label = if name.is_empty() { format!("Row {} of {group}", i + 1) } else { format!("Row {}: {name}", i + 1) };
                            out.push(base(missing, score - 1, Some(i), false, label));
                        }
                    }
                    _ => {}
                } }
                // Nothing in the passage fits it: offered further down as "source only".
                if out.len() == before && field.kind != "table" {
                    let mut t = base(vec![], -100, None, false, field.label.clone());
                    t.source_only = true;
                    t.score = -100;
                    t.id = format!("{}/source", t.id);
                    out.push(t);
                }
            }
        }
    }
    // Stable within a score: the forms' order.
    let mut order: Vec<(usize, Target)> = out.into_iter().enumerate().collect();
    order.sort_by(|(i, a), (j, b)| b.score.cmp(&a.score).then(i.cmp(j)));
    let targets: Vec<Target> = order.into_iter().map(|(_, t)| t).collect();
    json!({ "parsed": parsed, "targets": targets })
}

/// A table row from the passage: named statistics into their columns, then (for a run of
/// numbers, as in a table's row) the rest left to right into the number columns still empty.
fn row_from<'a>(field: &'a Field, parsed: &Json, numbers: &[f64], text: &str) -> (Vec<(&'a Field, Json)>, i32) {
    let mut cells: Vec<(&Field, Json)> = Vec::new();
    let mut used = 0usize;
    for c in field.columns.iter().filter(|c| c.kind == "number") {
        let stat = stat_of(c);
        // "1" columns are the first group's: the passage fills those unless it says otherwise.
        let first_group = !c.id.ends_with('2');
        if let Some(v) = stat.and_then(|s| stat_value(parsed, s)).filter(|_| first_group) {
            cells.push((c, json!(v)));
            used += 1;
        }
    }
    let structured = used > 0;
    if numbers.len() >= 3 && used < numbers.len() {
        // Table-ish: fill left to right.
        cells.clear();
        let mut it = numbers.iter();
        for c in field.columns.iter().filter(|c| c.kind == "number") {
            match it.next() {
                Some(v) => cells.push((c, json!(v))),
                None => break,
            }
        }
        return (cells, 60);
    }
    if !structured {
        if let Some(c) = field.columns.iter().find(|c| c.kind == "text")
            && text.chars().any(char::is_alphabetic)
        {
            cells.push((c, json!(text)));
            return (cells, 10);
        }
        return (cells, 0);
    }
    (cells, 70 + used as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Json {
        parse(s)
    }
    fn f(j: &Json, k: &str) -> Option<f64> {
        j.get(k).and_then(Json::as_f64)
    }

    #[test]
    fn means_and_sds() {
        let j = p("12.3 (4.5)");
        assert_eq!((f(&j, "mean"), f(&j, "sd")), (Some(12.3), Some(4.5)));
        let j = p("24.1 ± 3.2");
        assert_eq!((f(&j, "mean"), f(&j, "sd")), (Some(24.1), Some(3.2)));
        let j = p("mean 12.3 (SD 4.5)");
        assert_eq!((f(&j, "mean"), f(&j, "sd")), (Some(12.3), Some(4.5)));
        let j = p("−1.2 (0.8)");
        assert_eq!((f(&j, "mean"), f(&j, "sd")), (Some(-1.2), Some(0.8)));
        let j = p("12,3 (4,5)");
        assert_eq!((f(&j, "mean"), f(&j, "sd")), (Some(12.3), Some(4.5)));
        let j = p("24.1 +/- 3.2 years");
        assert_eq!(f(&j, "sd"), Some(3.2));
        let j = p("12·3 (4·5)");
        assert_eq!((f(&j, "mean"), f(&j, "sd")), (Some(12.3), Some(4.5)));
        assert_eq!(p("12.3 (4.5)")["parts"][0]["label"], "mean");
    }

    #[test]
    fn counts_and_percentages() {
        let j = p("45/120");
        assert_eq!((f(&j, "events"), f(&j, "total")), (Some(45.0), Some(120.0)));
        let j = p("12/120 (10%)");
        assert_eq!((f(&j, "events"), f(&j, "total"), f(&j, "percent")), (Some(12.0), Some(120.0), Some(10.0)));
        assert_eq!(f(&p("(n = 120)"), "n"), Some(120.0));
        assert_eq!(f(&p("N=120"), "n"), Some(120.0));
        assert_eq!(f(&p("45%"), "percent"), Some(45.0));
        assert_eq!(f(&p("37,5 %"), "percent"), Some(37.5));
        let j = p("45 (37.5%)");
        assert_eq!((f(&j, "n"), f(&j, "percent"), f(&j, "mean")), (Some(45.0), Some(37.5), None));
        // Thousands: thin space, no-break space, comma.
        assert_eq!(f(&p("n = 1\u{2009}234"), "n"), Some(1234.0));
        assert_eq!(f(&p("n = 1\u{00A0}234"), "n"), Some(1234.0));
        assert_eq!(f(&p("n = 1,234"), "n"), Some(1234.0));
        assert_eq!(f(&p("1,234.5"), "n"), None);
        assert_eq!(p("1,234.5")["numbers"][0], 1234.5);
        assert_eq!(p("1.234,5")["numbers"][0], 1234.5);
        // Events over a smaller total are not a fraction of it.
        assert_eq!(f(&p("120/45"), "events"), None);
    }

    #[test]
    fn intervals() {
        let j = p("0.52 (95% CI 0.31 to 0.88)");
        assert_eq!((f(&j, "estimate"), f(&j, "lower"), f(&j, "upper"), f(&j, "level")), (Some(0.52), Some(0.31), Some(0.88), Some(95.0)));
        assert_eq!(f(&j, "percent"), None, "the level is not a percentage");
        assert_eq!(j["numbers"], json!([0.52, 0.31, 0.88]));
        let j = p("RR 0.52 [0.31, 0.88]");
        assert_eq!((f(&j, "estimate"), f(&j, "upper")), (Some(0.52), Some(0.88)));
        let j = p("OR 1.8, 95% CI 1.2 to 3.4");
        assert_eq!((f(&j, "estimate"), f(&j, "lower"), f(&j, "upper")), (Some(1.8), Some(1.2), Some(3.4)));
        let j = p("95% CI 1.2 to 3.4");
        assert_eq!((f(&j, "estimate"), f(&j, "lower"), f(&j, "upper")), (None, Some(1.2), Some(3.4)));
        let j = p("(1.2–3.4)");
        assert_eq!((f(&j, "lower"), f(&j, "upper")), (Some(1.2), Some(3.4)));
        let j = p("0.31–0.88");
        assert_eq!((f(&j, "lower"), f(&j, "upper")), (Some(0.31), Some(0.88)));
        assert_eq!(j["numbers"], json!([0.31, 0.88]), "a range, not a negative number");
        let j = p("0.31-0.88");
        assert_eq!((f(&j, "lower"), f(&j, "upper")), (Some(0.31), Some(0.88)));
        let j = p("1.8 (1.2–3.4)");
        assert_eq!((f(&j, "estimate"), f(&j, "lower"), f(&j, "upper")), (Some(1.8), Some(1.2), Some(3.4)));
        let j = p("MD −2.3 (95% CI −4.1 to −0.5)");
        assert_eq!((f(&j, "estimate"), f(&j, "lower"), f(&j, "upper")), (Some(-2.3), Some(-4.1), Some(-0.5)));
        let j = p("HR 0,81 (95 % KI 0,70–0,94)");
        assert_eq!((f(&j, "estimate"), f(&j, "lower"), f(&j, "upper")), (Some(0.81), Some(0.70), Some(0.94)));
        let j = p("HR 0.81 (95%\u{00A0}CI 0.70\u{2009}–\u{2009}0.94)");
        assert_eq!((f(&j, "estimate"), f(&j, "lower"), f(&j, "upper")), (Some(0.81), Some(0.70), Some(0.94)));
    }

    #[test]
    fn medians_p_values_and_errors() {
        let j = p("median 12 (IQR 8–15)");
        assert_eq!((f(&j, "median"), f(&j, "q1"), f(&j, "q3"), f(&j, "estimate")), (Some(12.0), Some(8.0), Some(15.0), None));
        let j = p("median 12 (range 3 to 40)");
        assert_eq!((f(&j, "median"), f(&j, "min"), f(&j, "max")), (Some(12.0), Some(3.0), Some(40.0)));
        let j = p("p < 0.001");
        assert_eq!((f(&j, "p"), j["pOp"].as_str()), (Some(0.001), Some("<")));
        let j = p("p = 0.03");
        assert_eq!(j["numbers"], json!([]), "a p-value is not a number to extract");
        let j = p("beta 0.4, SE 0.12");
        assert_eq!(f(&j, "se"), Some(0.12));
        let j = p("Participants were adolescents aged 12 to 16 at one school.");
        assert_eq!(j["numbers"], json!([12.0, 16.0]));
        assert_eq!(f(&j, "mean"), None);
    }

    fn num(id: &str, label: &str) -> Field {
        Field { id: id.into(), label: label.into(), kind: "number".into(), ..Default::default() }
    }

    fn study_forms() -> Vec<Form> {
        use crate::model::Section;
        let text = |id: &str, label: &str| Field { id: id.into(), label: label.into(), kind: "text".into(), ..Default::default() };
        let choice = |id: &str, label: &str, o: &[&str]| Field { id: id.into(), label: label.into(), kind: "choice".into(), options: o.iter().map(|s| s.to_string()).collect(), ..Default::default() };
        vec![
            Form {
                id: "f1".into(),
                name: "Study".into(),
                kind: "custom".into(),
                sections: vec![
                    Section { id: "s1".into(), title: "Design".into(), fields: vec![choice("design", "Design", &["Randomised controlled trial", "Cluster randomised trial", "Cohort"]), text("country", "Country")], ..Default::default() },
                    Section { id: "s2".into(), title: "Pain".into(), fields: vec![num("mean_pain", "Mean pain score"), num("sd_pain", "SD pain score"), num("n_total", "Participants randomised")], ..Default::default() },
                ],
            },
            Form {
                id: "f-outcomes".into(),
                name: "Outcome data".into(),
                kind: "outcomes".into(),
                sections: vec![Section { id: "so".into(), title: "Outcomes".into(), fields: vec![Field { id: "outcomes".into(), label: "Outcome data".into(), kind: "table".into(), columns: crate::templates::outcome_columns(), ..Default::default() }], ..Default::default() }],
            },
        ]
    }

    fn req(text: &str, focus: Option<(&str, &str)>, values: BTreeMap<String, Json>) -> TargetsRequest {
        TargetsRequest { text: text.into(), forms: study_forms(), values, focus: focus.map(|(a, b)| Focus { form_id: a.into(), field_id: b.into() }) }
    }

    #[test]
    fn a_mean_and_sd_fill_both_fields() {
        let out = targets(&req("12.3 (4.5)", Some(("f1", "mean_pain")), BTreeMap::new()));
        let first = &out["targets"][0];
        assert_eq!(first["fieldId"], "mean_pain");
        assert_eq!(first["focused"], true);
        assert_eq!(first["fills"].as_array().unwrap().iter().map(|f| (f["fieldId"].as_str().unwrap(), f["value"].as_f64().unwrap())).collect::<Vec<_>>(), vec![("mean_pain", 12.3), ("sd_pain", 4.5)]);
        assert_eq!(first["preview"], "Mean pain score 12.3, SD pain score 4.5");
        // The outcome table offers a new row with the first group's mean and SD.
        let row = out["targets"].as_array().unwrap().iter().find(|t| t["newRow"] == true).unwrap();
        assert_eq!(row["label"], "New row in Outcome data");
        assert_eq!(row["fills"].as_array().unwrap().iter().map(|f| f["fieldId"].as_str().unwrap()).collect::<Vec<_>>(), vec!["m1", "sd1"]);
    }

    #[test]
    fn counts_go_to_counts_and_words_to_options() {
        let out = targets(&req("45/120", None, BTreeMap::new()));
        let t = out["targets"].as_array().unwrap();
        // No count field in Study but participants: total 120 goes there.
        assert!(t.iter().any(|x| x["fieldId"] == "n_total" && x["fills"][0]["value"] == 120.0));
        assert!(t.iter().filter(|x| x["fieldId"] == "sd_pain").all(|x| x["sourceOnly"] == true), "no SD in the passage: its source only");
        let row = t.iter().find(|x| x["newRow"] == true).unwrap();
        assert_eq!(row["fills"].as_array().unwrap().iter().map(|f| f["fieldId"].as_str().unwrap()).collect::<Vec<_>>(), vec!["e1", "n1"]);
        let out = targets(&req("This was a cluster-randomised trial in 12 schools", None, BTreeMap::new()));
        let first = &out["targets"][0];
        assert_eq!((first["fieldId"].as_str(), first["fills"][0]["value"].as_str()), (Some("design"), Some("Cluster randomised trial")));
    }

    #[test]
    fn dates_and_words() {
        assert_eq!(dates("Recruitment ran from March 2015 to 12 June 2016."), vec!["2015-03", "2016-06-12"]);
        assert_eq!(dates("between 2012 and 2014"), vec!["2012", "2014"]);
        assert_eq!(dates("2015-03"), vec!["2015-03"]);
        assert_eq!(dates("on 2015-03-12"), vec!["2015-03-12"]);
        assert_eq!(dates("June 3, 2019"), vec!["2019-06-03"]);
        assert_eq!(dates("03/2015"), vec!["2015-03"]);
        assert!(dates("Uruguay").is_empty());
        assert!(dates("n = 2015 participants (95% CI 1.2 to 3.4)").len() <= 1);
        assert!(dates("12.3 (4.5)").is_empty());
        assert_eq!(clean_text("  a cluster-rando-\n mised   trial "), "a cluster-randomised trial");
    }

    #[test]
    fn a_date_field_takes_dates_only_and_both_ends_of_a_range() {
        use crate::model::Section;
        let date = |id: &str, label: &str| Field { id: id.into(), label: label.into(), kind: "date".into(), ..Default::default() };
        let forms = vec![Form {
            id: "f".into(),
            name: "Study".into(),
            kind: "custom".into(),
            sections: vec![Section { id: "s".into(), title: "Dates".into(), fields: vec![date("start", "Start of recruitment"), date("end", "End of recruitment"), Field { id: "country".into(), label: "Country".into(), kind: "text".into(), ..Default::default() }], ..Default::default() }],
        }];
        let r = |text: &str, focus: Option<&str>| targets(&TargetsRequest { text: text.into(), forms: forms.clone(), values: BTreeMap::new(), focus: focus.map(|f| Focus { form_id: "f".into(), field_id: f.into() }) });
        // "Uruguay" fits the country; the dates only as its source, after everything else.
        let out = r("Uruguay", Some("start"));
        let t = out["targets"].as_array().unwrap();
        assert_eq!(t[0]["fieldId"], "country");
        let start = t.iter().find(|x| x["fieldId"] == "start").unwrap();
        assert_eq!((start["sourceOnly"].as_bool(), start["fills"].as_array().unwrap().len()), (Some(true), 0));
        // Focused on the country, a date still goes to the date field first.
        let out = r("between 2012 and 2014", Some("country"));
        assert_eq!(out["targets"][0]["fieldId"], "start");
        // A range fills both ends.
        let out = r("between 2012 and 2014", None);
        let first = &out["targets"][0];
        assert_eq!(first["fieldId"], "start");
        assert_eq!(first["fills"], json!([{ "fieldId": "start", "label": "Start of recruitment", "value": "2012", "display": "2012" }, { "fieldId": "end", "label": "End of recruitment", "value": "2014", "display": "2014" }]));
    }

    #[test]
    fn rows_left_to_right_existing_rows_and_hidden_fields() {
        let mut values = BTreeMap::new();
        values.insert("f-outcomes/outcomes".into(), json!([{ "outcome": "Pain", "e1": 12 }]));
        let out = targets(&req("12 120 20 118", None, values));
        let t = out["targets"].as_array().unwrap();
        let new = t.iter().find(|x| x["newRow"] == true).unwrap();
        assert_eq!(new["preview"], "Events (intervention) 12, Total (intervention) 120, Events (comparison) 20, Total (comparison) 118");
        let existing = t.iter().find(|x| x["row"] == 0).unwrap();
        assert_eq!(existing["label"], "Row 1: Pain");
        assert!(existing["fills"].as_array().unwrap().iter().all(|f| f["fieldId"] != "e1"), "only what the row lacks");
        // A field hidden by another answer is not offered.
        let mut forms = study_forms();
        forms[0].sections[0].fields[1].show_when = Some(crate::model::ShowWhen { conditions: vec![crate::model::FieldCondition { field: "design".into(), op: "is".into(), value: json!("Cohort") }], all: true });
        let r = TargetsRequest { text: "Norway".into(), forms, values: BTreeMap::new(), focus: None };
        assert!(!targets(&r)["targets"].as_array().unwrap().iter().any(|x| x["fieldId"] == "country"));
    }
}
