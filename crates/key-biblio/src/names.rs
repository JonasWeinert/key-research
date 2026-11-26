// BibTeX name lists: "First von Last", "von Last, First", "von Last, Jr, First",
// `{Corporate Name}` and "and others". Particles stay with the family name ("van Gogh");
// a suffix is kept at the end of the given name ("Martin Luther, Jr.") and written back
// in the third position.
use crate::latex;
use key_store::Creator;

/// The names of a raw (undecoded) BibTeX value, and whether the list ended in "and others".
pub fn parse_list(raw: &str, role: &str) -> (Vec<Creator>, bool) {
    let mut etal = false;
    let mut creators = Vec::new();
    for name in split_and(raw) {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if name.eq_ignore_ascii_case("others") {
            etal = true;
            continue;
        }
        creators.push(parse_name(name, role));
    }
    (creators, etal)
}

/// Splits on " and " outside braces (any case, any whitespace).
fn split_and(raw: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
        if depth == 0 && c.is_whitespace() && i + 4 < chars.len() {
            let word: String = chars[i + 1..i + 4].iter().collect();
            if word.eq_ignore_ascii_case("and") && chars[i + 4].is_whitespace() {
                parts.push(std::mem::take(&mut current));
                i += 5;
                continue;
            }
        }
        current.push(c);
        i += 1;
    }
    parts.push(current);
    parts
}

fn split_top(raw: &str, separator: impl Fn(char) -> bool) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut depth = 0;
    for c in raw.chars() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
        if depth == 0 && separator(c) {
            parts.push(String::new());
        } else {
            parts.last_mut().unwrap().push(c);
        }
    }
    parts.into_iter().map(|p| p.trim().to_string()).collect()
}

/// Lower case at the start (outside braces, accents looked through) makes a particle.
fn is_particle(token: &str) -> bool {
    // `{Van}` is caseless; `{\"u}ber` counts its letter.
    if token.starts_with('{') && !token[1..].starts_with('\\') {
        return false;
    }
    latex::decode(token).chars().find(|c| c.is_alphabetic()).is_some_and(char::is_lowercase)
}

fn join(tokens: &[String]) -> String {
    latex::decode(&tokens.join(" "))
}

pub fn parse_name(raw: &str, role: &str) -> Creator {
    let raw = raw.trim();
    // `{World Health Organization}`: one group is a literal name.
    if raw.starts_with('{') && raw.ends_with('}') && balanced_outer(raw) {
        return Creator { literal: Some(latex::decode(raw)), role: role.into(), ..Default::default() };
    }
    let parts = split_top(raw, |c| c == ',');
    let tokens = |s: &str| split_top(s, |c| c.is_whitespace() || c == '~').into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>();
    let (first, von_last, jr): (Vec<String>, Vec<String>, Option<String>) = match parts.len() {
        1 => {
            let words = tokens(&parts[0]);
            if words.len() <= 1 {
                return Creator { family: Some(join(&words)).filter(|f| !f.is_empty()), role: role.into(), ..Default::default() };
            }
            // First von Last: von starts at the first lower-case word (not the last word).
            let von_start = words[..words.len() - 1].iter().position(|w| is_particle(w));
            match von_start {
                Some(start) => (words[..start].to_vec(), words[start..].to_vec(), None),
                None => (words[..words.len() - 1].to_vec(), words[words.len() - 1..].to_vec(), None),
            }
        }
        2 => (tokens(&parts[1]), tokens(&parts[0]), None),
        _ => (tokens(&parts[2..].join(", ")), tokens(&parts[0]), Some(latex::decode(&parts[1])).filter(|s| !s.is_empty())),
    };
    let family = join(&von_last);
    let mut given = join(&first);
    if let Some(jr) = jr {
        given = if given.is_empty() { jr } else { format!("{given}, {jr}") };
    }
    Creator {
        family: Some(family).filter(|f| !f.is_empty()),
        given: Some(given).filter(|g| !g.is_empty()),
        role: role.into(),
        ..Default::default()
    }
}

fn balanced_outer(raw: &str) -> bool {
    let mut depth = 0;
    for (i, c) in raw.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 && i + 1 < raw.len() {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}

const SUFFIXES: &[&str] = &["Jr.", "Jr", "Sr.", "Sr", "II", "III", "IV", "V"];

/// A given name's trailing suffix: ("Martin Luther", Some("Jr.")).
pub fn split_suffix(given: &str) -> (String, Option<String>) {
    if let Some((head, tail)) = given.rsplit_once(',') {
        let tail = tail.trim();
        if SUFFIXES.contains(&tail) {
            return (head.trim().to_string(), Some(tail.to_string()));
        }
    }
    (given.to_string(), None)
}

/// One creator as a BibTeX name (already encoded).
pub fn format_name(creator: &Creator, encode: &dyn Fn(&str) -> String) -> String {
    if let Some(literal) = creator.literal.as_deref().filter(|l| !l.trim().is_empty()) {
        return format!("{{{}}}", encode(literal.trim()));
    }
    let family = creator.family.as_deref().unwrap_or("").trim();
    let given = creator.given.as_deref().unwrap_or("").trim();
    if family.is_empty() {
        return encode(given);
    }
    // "van Gogh" reads back as particle + family; "Van Gogh" or "Le Pen" needs braces.
    let words: Vec<&str> = family.split_whitespace().collect();
    let readable = words.len() == 1 || words[..words.len() - 1].iter().all(|w| w.chars().next().is_some_and(char::is_lowercase));
    let family = if readable { encode(family) } else { format!("{{{}}}", encode(family)) };
    let (given, suffix) = split_suffix(given);
    match (given.is_empty(), suffix) {
        (true, _) => family,
        (false, Some(suffix)) => format!("{family}, {}, {}", encode(&suffix), encode(&given)),
        (false, None) => format!("{family}, {}", encode(&given)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(raw: &str) -> Vec<String> {
        parse_list(raw, "author").0.iter().map(|c| format!("{}|{}|{}", c.family.clone().unwrap_or_default(), c.given.clone().unwrap_or_default(), c.literal.clone().unwrap_or_default())).collect()
    }

    #[test]
    fn parses_name_forms() {
        assert_eq!(names("Donald E. Knuth and Lamport, Leslie"), ["Knuth|Donald E.|", "Lamport|Leslie|"]);
        assert_eq!(names("Ludwig van Beethoven and de la Fontaine, Jean"), ["van Beethoven|Ludwig|", "de la Fontaine|Jean|"]);
        assert_eq!(names("King, Jr., Martin Luther"), ["King|Martin Luther, Jr.|"]);
        assert_eq!(names("{World Health Organization} and {\\\"O}zt{\\\"u}rk, Ay{\\c{s}}e"), ["||World Health Organization", "Öztürk|Ayşe|"]);
        assert_eq!(names("{Barnes and Noble} AND Plato"), ["||Barnes and Noble", "Plato||"]);
        let (list, etal) = parse_list("Smith, John and others", "author");
        assert_eq!(list.len(), 1);
        assert!(etal);
        assert_eq!(names("Jean-Paul {Le Pen}"), ["Le Pen|Jean-Paul|"]);
    }

    #[test]
    fn formats_names_that_parse_back() {
        let id = |s: &str| s.to_string();
        for raw in ["van Beethoven, Ludwig", "King, Jr., Martin Luther", "{Le Pen}, Jean-Paul", "{World Health Organization}", "Plato"] {
            let creator = parse_name(raw, "author");
            assert_eq!(format_name(&creator, &id), raw);
        }
    }
}
