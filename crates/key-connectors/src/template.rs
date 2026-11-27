// Templates: text with `{name}` (required) and `{name?}` (optional) variables; `{{` and `}}`
// are literal braces. Nothing else: no expressions, no functions.
use std::collections::BTreeMap;

pub type Vars = BTreeMap<String, String>;

enum Piece<'a> {
    Text(String),
    Var { name: &'a str, optional: bool },
}

fn pieces(template: &str) -> Result<Vec<Piece<'_>>, String> {
    let mut out = Vec::new();
    let mut text = String::new();
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' if bytes.get(i + 1) == Some(&b'{') => {
                text.push('{');
                i += 2;
            }
            b'}' if bytes.get(i + 1) == Some(&b'}') => {
                text.push('}');
                i += 2;
            }
            b'{' => {
                let end = template[i..].find('}').ok_or("an unclosed {")? + i;
                let inner = &template[i + 1..end];
                let (name, optional) = match inner.strip_suffix('?') {
                    Some(n) => (n, true),
                    None => (inner, false),
                };
                if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
                    return Err(format!("bad variable {{{inner}}}"));
                }
                if !text.is_empty() {
                    out.push(Piece::Text(std::mem::take(&mut text)));
                }
                out.push(Piece::Var { name, optional });
                i = end + 1;
            }
            b'}' => return Err("a lone }".into()),
            _ => {
                let ch = template[i..].chars().next().unwrap_or(' ');
                text.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    if !text.is_empty() {
        out.push(Piece::Text(text));
    }
    Ok(out)
}

pub fn check(template: &str) -> Result<(), String> {
    if template.len() > 4096 {
        return Err("the template is longer than 4 KB".into());
    }
    pieces(template).map(|_| ())
}

/// The variables a template uses (without `?`).
pub fn variables(template: &str) -> Vec<String> {
    pieces(template).unwrap_or_default().into_iter().filter_map(|p| if let Piece::Var { name, .. } = p { Some(name.to_string()) } else { None }).collect()
}

/// The template with every variable replaced by `x` (to check a URL's shape).
pub fn blank(template: &str) -> String {
    pieces(template).unwrap_or_default().into_iter().map(|p| match p {
        Piece::Text(t) => t,
        Piece::Var { .. } => "x".into(),
    }).collect()
}

/// Whether the template is exactly one variable (`"{offset}"`), and which.
pub fn sole_variable(template: &str) -> Option<String> {
    match pieces(template).ok()?.as_slice() {
        [Piece::Var { name, .. }] => Some(name.to_string()),
        _ => None,
    }
}

/// Fills the template. `Ok(None)` when an optional variable is missing (the parameter is left
/// out); an error when a required one is. An empty value counts as missing.
pub fn render(template: &str, vars: &Vars) -> Result<Option<String>, String> {
    let mut out = String::new();
    for piece in pieces(template)? {
        match piece {
            Piece::Text(t) => out.push_str(&t),
            Piece::Var { name, optional } => match vars.get(name).filter(|v| !v.is_empty()) {
                Some(v) => out.push_str(v),
                None if optional => return Ok(None),
                None => return Err(format!("{{{name}}} has no value")),
            },
        }
    }
    Ok(Some(out))
}

/// Fills the template; missing variables (required or not) become empty.
pub fn render_lenient(template: &str, vars: &Vars) -> String {
    pieces(template).unwrap_or_default().into_iter().map(|p| match p {
        Piece::Text(t) => t,
        Piece::Var { name, .. } => vars.get(name).cloned().unwrap_or_default(),
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vars {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn fills_required_and_drops_on_missing_optional() {
        let v = vars(&[("q", "cancer"), ("cred.api_key", "")]);
        assert_eq!(render("{q}[tiab]", &v).unwrap().as_deref(), Some("cancer[tiab]"));
        assert_eq!(render("{cred.api_key?}", &v).unwrap(), None);
        assert!(render("{missing}", &v).is_err());
        assert_eq!(render("{{x}} {q}", &v).unwrap().as_deref(), Some("{x} cancer"));
        assert_eq!(variables("a {b} {c.d?}"), vec!["b", "c.d"]);
        assert!(check("{unclosed").is_err() && check("lone }").is_err());
        assert_eq!(sole_variable("{offset}").as_deref(), Some("offset"));
        assert_eq!(sole_variable("x{offset}"), None);
    }
}
