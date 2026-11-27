// std-A: small text helpers for the reporting documents (PRISMA checklist, protocol, PRISMA-S
// report): dates without a clock crate, lists in words, and the little Markdown these documents
// use turned into HTML that word processors open (headings, paragraphs, lists, tables, code).

/// Key's version, as reports cite the software.
pub const KEY_VERSION: &str = env!("CARGO_PKG_VERSION");

/// "Key v0.1.0".
pub fn software() -> String {
    format!("Key v{KEY_VERSION}")
}

/// ms since the epoch → "2026-11-27" (UTC).
pub fn date(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let (y, m, d) = civil(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Days since 1970-01-01 → (year, month, day) (H. Hinnant's civil_from_days).
fn civil(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// "2026-11-27" → ms at midnight UTC.
pub fn parse_date(text: &str) -> Option<i64> {
    let t = text.trim();
    let mut parts = t.get(..10)?.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let (yy, mm) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy.rem_euclid(400);
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400_000)
}

/// A batch's "searched at": ms (from a database search run) or a date as typed.
pub fn when_text(value: &str) -> String {
    let v = value.trim();
    match v.parse::<i64>() {
        Ok(ms) if ms > 100_000_000_000 => date(ms),
        _ => v.to_string(),
    }
}

/// ms for a "searched at" value, when it can be read.
pub fn when_ms(value: &str) -> Option<i64> {
    let v = value.trim();
    match v.parse::<i64>() {
        Ok(ms) if ms > 100_000_000_000 => Some(ms),
        _ => parse_date(v),
    }
}

pub fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{} {}", thousands(n), if n == 1 { one } else { many })
}

/// 12345 → "12,345".
pub fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Small numbers in words, as journals prefer ("two reviewers").
pub fn count_word(n: usize) -> String {
    ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].get(n).map(|s| s.to_string()).unwrap_or_else(|| n.to_string())
}

pub fn capital(text: &str) -> String {
    let mut c = text.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// "a, b and c".
pub fn join_and(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        n => format!("{} and {}", items[..n - 1].join(", "), items[n - 1]),
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Inline Markdown: **bold**, `code`, [text](url).
fn inline(text: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let rest: String = chars[i..].iter().collect();
        if rest.starts_with("**") {
            if let Some(end) = rest[2..].find("**") {
                out.push_str(&format!("<strong>{}</strong>", escape(&rest[2..2 + end])));
                i += 2 + rest[2..2 + end].chars().count() + 2;
                continue;
            }
        }
        if chars[i] == '`' {
            if let Some(end) = rest[1..].find('`') {
                out.push_str(&format!("<code>{}</code>", escape(&rest[1..1 + end])));
                i += 1 + rest[1..1 + end].chars().count() + 1;
                continue;
            }
        }
        if chars[i] == '[' {
            if let (Some(close), true) = (rest.find("]("), true) {
                if let Some(end) = rest[close..].find(')') {
                    let label = &rest[1..close];
                    let url = &rest[close + 2..close + end];
                    if url.starts_with("http") {
                        out.push_str(&format!("<a href=\"{}\">{}</a>", escape(url), escape(label)));
                        i += rest[..close + end + 1].chars().count();
                        continue;
                    }
                }
            }
        }
        out.push_str(&escape(&chars[i].to_string()));
        i += 1;
    }
    out
}

fn cells(line: &str) -> Vec<String> {
    let t = line.trim().trim_start_matches('|').trim_end_matches('|');
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev = '\0';
    for c in t.chars() {
        if c == '|' && prev != '\\' {
            out.push(cur.trim().to_string());
            cur.clear();
        } else {
            if c == '|' {
                cur.pop();
            }
            cur.push(c);
        }
        prev = c;
    }
    out.push(cur.trim().to_string());
    out
}

/// Escapes a cell for a Markdown table.
pub fn md_cell(text: &str) -> String {
    text.replace('|', "\\|").replace('\n', "<br>")
}

/// The Markdown these documents write, as a standalone HTML page (opens in Word and Pages).
pub fn html(title: &str, markdown: &str) -> String {
    let mut body = String::new();
    let lines: Vec<&str> = markdown.lines().collect();
    let mut i = 0;
    let mut para: Vec<String> = Vec::new();
    let flush = |para: &mut Vec<String>, body: &mut String| {
        if !para.is_empty() {
            body.push_str(&format!("<p>{}</p>\n", para.join(" ")));
            para.clear();
        }
    };
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim();
        if t.is_empty() {
            flush(&mut para, &mut body);
            i += 1;
            continue;
        }
        if let Some(h) = t.strip_prefix('#') {
            flush(&mut para, &mut body);
            let level = 1 + h.chars().take_while(|c| *c == '#').count();
            let text = h.trim_start_matches('#').trim();
            body.push_str(&format!("<h{level}>{}</h{level}>\n", inline(text)));
            i += 1;
            continue;
        }
        if t.starts_with("```") {
            flush(&mut para, &mut body);
            let mut code = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].trim().starts_with("```") {
                code.push(escape(lines[i]));
                i += 1;
            }
            body.push_str(&format!("<pre>{}</pre>\n", code.join("\n")));
            i += 1;
            continue;
        }
        if t.starts_with('|') {
            flush(&mut para, &mut body);
            let mut rows = Vec::new();
            while i < lines.len() && lines[i].trim().starts_with('|') {
                rows.push(lines[i]);
                i += 1;
            }
            body.push_str("<table>\n");
            for (n, row) in rows.iter().enumerate() {
                if n == 1 && row.contains("---") {
                    continue;
                }
                let tag = if n == 0 { "th" } else { "td" };
                let cells: Vec<String> = cells(row).iter().map(|c| format!("<{tag}>{}</{tag}>", inline(c).replace("&lt;br&gt;", "<br>"))).collect();
                body.push_str(&format!("<tr>{}</tr>\n", cells.join("")));
            }
            body.push_str("</table>\n");
            continue;
        }
        if t.starts_with("- ") || t.chars().next().is_some_and(|c| c.is_ascii_digit()) && t.contains(". ") && t.split_once(". ").is_some_and(|(n, _)| n.chars().all(|c| c.is_ascii_digit())) {
            flush(&mut para, &mut body);
            let ordered = !t.starts_with("- ");
            body.push_str(if ordered { "<ol>\n" } else { "<ul>\n" });
            while i < lines.len() {
                let l = lines[i].trim();
                let item = if ordered { l.split_once(". ").filter(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())).map(|(_, r)| r) } else { l.strip_prefix("- ") };
                match item {
                    Some(text) => body.push_str(&format!("<li>{}</li>\n", inline(text))),
                    None => break,
                }
                i += 1;
            }
            body.push_str(if ordered { "</ol>\n" } else { "</ul>\n" });
            continue;
        }
        para.push(inline(t));
        i += 1;
    }
    flush(&mut para, &mut body);
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>{}</title>\n<style>body{{font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:11pt;line-height:1.45;max-width:46em;margin:2em auto;color:#111}}table{{border-collapse:collapse;width:100%;margin:0.6em 0 1.2em}}th,td{{border:1px solid #999;padding:4px 6px;vertical-align:top;text-align:left;font-size:10pt}}th{{background:#eee}}pre{{white-space:pre-wrap;font-size:9.5pt;background:#f4f4f4;padding:6px}}code{{font-size:9.5pt}}h1{{font-size:16pt}}h2{{font-size:13pt;margin-top:1.4em}}h3{{font-size:11.5pt}}</style></head><body>\n{}</body></html>\n",
        escape(title),
        body
    )
}

/// One CSV line (cells guarded like the review's other CSVs).
pub fn csv_line(cells: &[String]) -> String {
    let mut line = cells.iter().map(|c| crate::export::csv_cell(c)).collect::<Vec<_>>().join(",");
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip() {
        // 2026-11-27T00:00:00Z = 1_795_737_600_000 ms (date -u -d 2026-11-27 +%s).
        assert_eq!(date(1_795_737_600_000), "2026-11-27");
        assert_eq!(parse_date("2026-11-27"), Some(1_795_737_600_000));
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(parse_date("2000-02-29").map(date).as_deref(), Some("2000-02-29"));
        assert_eq!(when_text("1795737600000"), "2026-11-27");
        assert_eq!(when_text("March 2026"), "March 2026");
    }

    #[test]
    fn words_and_html() {
        assert_eq!(join_and(&["a".into(), "b".into(), "c".into()]), "a, b and c");
        assert_eq!(thousands(12345), "12,345");
        let h = html("T", "# Title\n\nSome **bold** text.\n\n| A | B |\n| --- | --- |\n| 1 | x \\| y |\n\n- one\n- two\n");
        assert!(h.contains("<h1>Title</h1>") && h.contains("<strong>bold</strong>") && h.contains("<td>x | y</td>") && h.contains("<li>two</li>"), "{h}");
    }
}
