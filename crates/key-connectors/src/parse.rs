// Reading a pasted Boolean search string (PubMed, Scopus, Web of Science) back into the neutral
// query tree, so the visual builder can show it as blocks, however deeply it is nested.
use crate::boolean::{Node, Op};
use crate::query::{Query, Term};

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Open,
    Close,
    And,
    Or,
    Not,
    /// W/n, NEAR/n, PRE/n
    Near(u32),
    Word(String),
    Phrase(String),
    /// A field tag after a term: [tiab]
    Tag(String),
    /// A field that scopes a group: TITLE-ABS-KEY( or TS=(
    Scope(String),
}

#[derive(Clone, Debug)]
enum Expr {
    Term(Term),
    And(Vec<Expr>),
    Or(Vec<Expr>),
    Not(Box<Expr>, Box<Expr>),
}

fn field_of(dialect: &str, tag: &str) -> Option<&'static str> {
    let t = tag.trim().to_ascii_lowercase();
    let t = t.split(':').next().unwrap_or(&t).trim().to_string();
    Some(match dialect {
        "scopus" => match t.as_str() {
            "title-abs-key" | "title-abs" | "title-abs-key-auth" => "title_abstract",
            "title" => "title",
            "abs" => "abstract",
            "key" | "authkey" | "indexterms" => "keywords",
            "auth" | "author-name" | "authlastname" => "author",
            "srctitle" | "exactsrctitle" => "journal",
            "affil" | "affilorg" => "affiliation",
            "all" => "all",
            "doi" => "identifier",
            _ => return None,
        },
        "wos" => match t.as_str() {
            "ts" | "tp" => "title_abstract",
            "ti" => "title",
            "ab" => "abstract",
            "au" | "ai" => "author",
            "so" => "journal",
            "ak" | "kp" => "keywords",
            "og" | "ad" | "oo" => "affiliation",
            "all" => "all",
            "do" => "identifier",
            _ => return None,
        },
        _ => match t.as_str() {
            "tiab" | "title/abstract" | "tw" | "text word" => "title_abstract",
            "ti" | "title" => "title",
            "ab" | "abstract" => "abstract",
            "mh" | "mesh" | "mesh terms" | "majr" | "mesh major topic" | "sh" => "subject",
            "ot" | "other term" | "kw" => "keywords",
            "au" | "author" | "fau" => "author",
            "ta" | "journal" | "jour" => "journal",
            "ad" | "affiliation" => "affiliation",
            "all" | "all fields" => "all",
            "aid" | "doi" => "identifier",
            _ => return None,
        },
    })
}

fn detect(text: &str) -> &'static str {
    let upper = text.to_ascii_uppercase();
    if upper.contains("TITLE-ABS-KEY(") || upper.contains("TITLE-ABS-KEY (") || upper.contains(" W/") || upper.contains("AND NOT") && upper.contains("TITLE") {
        "scopus"
    } else if ["TS=", "TI=", "AB=", "AU=", "SO=", "TS =", " NEAR/"].iter().any(|p| upper.contains(p)) {
        "wos"
    } else {
        "pubmed"
    }
}

fn tokenize(text: &str, dialect: &str) -> Result<Vec<Tok>, String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '(' {
            out.push(Tok::Open);
            i += 1;
        } else if c == ')' {
            out.push(Tok::Close);
            i += 1;
        } else if c == '"' || (c == '{' && dialect == "scopus") {
            let close = if c == '"' { '"' } else { '}' };
            let end = (i + 1..chars.len()).find(|&j| chars[j] == close).ok_or("A quote is not closed")?;
            out.push(Tok::Phrase(chars[i + 1..end].iter().collect()));
            i = end + 1;
        } else if c == '[' {
            let end = (i + 1..chars.len()).find(|&j| chars[j] == ']').ok_or("A [field] is not closed")?;
            out.push(Tok::Tag(chars[i + 1..end].iter().collect()));
            i = end + 1;
        } else {
            let start = i;
            while i < chars.len() && !chars[i].is_whitespace() && !"()\"[".contains(chars[i]) && !(chars[i] == '=' && dialect == "wos") {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            // WoS: TS=( or TS=term
            if i < chars.len() && chars[i] == '=' {
                i += 1;
                out.push(Tok::Scope(word));
                continue;
            }
            let upper = word.to_ascii_uppercase();
            let near = ["W/", "NEAR/", "PRE/"].iter().find_map(|p| upper.strip_prefix(p)).and_then(|n| n.parse().ok());
            if let Some(n) = near {
                out.push(Tok::Near(n));
            } else if upper == "NEAR" {
                out.push(Tok::Near(15));
            } else if upper == "AND" {
                out.push(Tok::And);
            } else if upper == "OR" {
                out.push(Tok::Or);
            } else if upper == "NOT" {
                out.push(Tok::Not);
            } else if i < chars.len() && chars[i] == '(' && dialect == "scopus" && field_of("scopus", &word).is_some() {
                out.push(Tok::Scope(word));
            } else {
                out.push(Tok::Word(word));
            }
        }
    }
    // "AND NOT" is NOT.
    let mut merged = Vec::new();
    for t in out {
        if t == Tok::Not && merged.last() == Some(&Tok::And) {
            merged.pop();
        }
        merged.push(t);
    }
    Ok(merged)
}

struct Parser<'a> {
    toks: &'a [Tok],
    at: usize,
    dialect: &'a str,
    warnings: Vec<String>,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.at)
    }

    fn not_expr(&mut self, field: &str) -> Result<Expr, String> {
        let mut left = self.and_expr(field)?;
        while self.peek() == Some(&Tok::Not) {
            self.at += 1;
            let right = self.and_expr(field)?;
            left = Expr::Not(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn and_expr(&mut self, field: &str) -> Result<Expr, String> {
        let mut items = vec![self.or_expr(field)?];
        loop {
            match self.peek() {
                Some(Tok::And) => {
                    self.at += 1;
                    items.push(self.or_expr(field)?);
                }
                // Terms side by side: AND.
                Some(Tok::Word(_) | Tok::Phrase(_) | Tok::Open | Tok::Scope(_)) => items.push(self.or_expr(field)?),
                _ => break,
            }
        }
        Ok(if items.len() == 1 { items.remove(0) } else { Expr::And(items) })
    }

    fn or_expr(&mut self, field: &str) -> Result<Expr, String> {
        let mut items = vec![self.primary(field)?];
        while self.peek() == Some(&Tok::Or) {
            self.at += 1;
            items.push(self.primary(field)?);
        }
        Ok(if items.len() == 1 { items.remove(0) } else { Expr::Or(items) })
    }

    fn primary(&mut self, field: &str) -> Result<Expr, String> {
        match self.toks.get(self.at).cloned() {
            Some(Tok::Open) => {
                self.at += 1;
                let e = self.not_expr(field)?;
                if self.peek() != Some(&Tok::Close) {
                    return Err("A bracket is not closed".into());
                }
                self.at += 1;
                Ok(e)
            }
            Some(Tok::Scope(name)) => {
                self.at += 1;
                let f = match field_of(self.dialect, &name) {
                    Some(f) => f.to_string(),
                    None => {
                        self.warnings.push(format!("Field {name} is searched in all fields"));
                        "all".into()
                    }
                };
                self.primary(&f)
            }
            Some(Tok::Word(w)) => {
                self.at += 1;
                let mut words = vec![w];
                let mut proximity = None;
                // a W/3 b: one term with proximity.
                while let (Some(Tok::Near(n)), Some(Tok::Word(next) | Tok::Phrase(next))) = (self.toks.get(self.at).cloned(), self.toks.get(self.at + 1).cloned()) {
                    proximity = Some(n);
                    words.push(next);
                    self.at += 2;
                }
                Ok(Expr::Term(self.term(words.join(" "), "words", field, proximity)))
            }
            Some(Tok::Phrase(p)) => {
                self.at += 1;
                Ok(Expr::Term(self.term(p, "phrase", field, None)))
            }
            Some(other) => Err(format!("Unexpected {other:?}")),
            None => Err("The query ends too early".into()),
        }
    }

    fn term(&mut self, text: String, mode: &str, field: &str, proximity: Option<u32>) -> Term {
        let mut field = field.to_string();
        let mut proximity = proximity;
        if let Some(Tok::Tag(tag)) = self.peek().cloned() {
            self.at += 1;
            if let Some(n) = tag.split(":~").nth(1).and_then(|n| n.trim().parse().ok()) {
                proximity = Some(n);
            }
            match field_of(self.dialect, &tag) {
                Some(f) => field = f.into(),
                None => self.warnings.push(format!("Field [{tag}] is searched in all fields")),
            }
        }
        let truncate = text.ends_with('*') || text.ends_with('$');
        let text = text.trim_end_matches(['*', '$']).to_string();
        let mode = if text.split_whitespace().count() > 1 && proximity.is_none() { mode } else { "words" };
        Term { id: None, text, mode: mode.into(), truncate, field, proximity }
    }
}

fn to_node(e: Expr) -> Node {
    match e {
        Expr::Term(t) => Node::term(t),
        Expr::And(items) => Node::group(Op::And, items.into_iter().map(to_node).collect()),
        Expr::Or(items) => Node::group(Op::Or, items.into_iter().map(to_node).collect()),
        Expr::Not(pos, neg) => Node::group(Op::And, vec![to_node(*pos), to_node(*neg).negated(true)]),
    }
}

/// The neutral query for a pasted string, with warnings.
pub fn parse(text: &str, dialect: &str) -> Result<(Query, Vec<String>), String> {
    let dialect = if dialect == "auto" || dialect.is_empty() { detect(text) } else { dialect };
    let toks = tokenize(text, dialect)?;
    if toks.is_empty() {
        return Err("The query is empty".into());
    }
    let mut p = Parser { toks: &toks, at: 0, dialect, warnings: Vec::new() };
    let expr = p.not_expr("all")?;
    if p.at < toks.len() {
        return Err("Part of the query could not be read (a bracket too many?)".into());
    }
    let tree = to_node(expr).normalized().unwrap_or_default();
    let mut warnings = p.warnings;
    warnings.dedup();
    Ok((Query::from_tree(tree, Default::default()), warnings))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pubmed_strings_become_blocks() {
        let (q, w) = parse("(\"vaccine hesitancy\"[tiab] OR vaccin*[ti]) AND (nurses[mh] OR \"health personnel\"[tiab:~2]) NOT mice[tiab]", "auto").unwrap();
        assert!(w.is_empty(), "{w:?}");
        let t = q.terms();
        assert_eq!(q.parts().len(), 3);
        assert_eq!(t[0].mode, "phrase");
        assert_eq!(t[1].text, "vaccin");
        assert!(t[1].truncate);
        assert_eq!(t[2].field, "subject");
        assert_eq!(t[3].proximity, Some(2));
        assert_eq!(t[4].text, "mice");
        assert!(q.parts()[2].is_not());
    }

    #[test]
    fn scopus_and_wos_scopes_apply_to_their_groups() {
        let (q, _) = parse("TITLE-ABS-KEY(\"school meals\" OR lunch*) AND TITLE(attendance W/3 rates) AND NOT AUTH(smith)", "auto").unwrap();
        let t = q.terms();
        assert_eq!(q.parts().len(), 3);
        assert_eq!(t[0].field, "title_abstract");
        assert_eq!(t[2].proximity, Some(3));
        assert_eq!(t[2].text, "attendance rates");
        assert_eq!(t[3].field, "author");
        let (q, _) = parse("TS=(remittances OR \"migrant transfers\") AND TI=household*", "auto").unwrap();
        assert_eq!(q.terms().len(), 3);
        assert_eq!(q.terms()[2].field, "title");
    }

    #[test]
    fn deep_nesting_becomes_a_tree() {
        let (q, _) = parse("(a AND (b OR (c AND d)))", "pubmed").unwrap();
        assert_eq!(crate::boolean::format(&q.tree()), "a AND (b OR (c AND d))");
        assert!(parse("(a OR b", "pubmed").is_err());
    }
}
