// LaTeX in BibTeX values, both ways. Reading: accents (`\'e`, `{\"u}`, `\c{c}`), named
// letters (`\ss`, `\o`), escapes, dashes and quotes, text commands (`\emph{x}` → x) and
// simple maths (`$\alpha$` → α) become Unicode; grouping braces go. Maths that has no
// Unicode spelling and commands we do not know stay as written, so nothing is lost.
// Writing: TeX's special characters are escaped; with `ascii`, letters outside ASCII
// become LaTeX accents, and title words whose case matters are protected with braces.
use unicode_normalization::UnicodeNormalization;

/// Accent commands and the combining mark each adds.
const ACCENTS: &[(char, char)] = &[
    ('\'', '\u{301}'),
    ('`', '\u{300}'),
    ('^', '\u{302}'),
    ('"', '\u{308}'),
    ('~', '\u{303}'),
    ('=', '\u{304}'),
    ('.', '\u{307}'),
    ('u', '\u{306}'),
    ('v', '\u{30C}'),
    ('H', '\u{30B}'),
    ('c', '\u{327}'),
    ('k', '\u{328}'),
    ('r', '\u{30A}'),
    ('d', '\u{323}'),
    ('b', '\u{331}'),
];

/// Control words that are a character.
const SYMBOLS: &[(&str, &str)] = &[
    ("ss", "ß"),
    ("SS", "SS"),
    ("o", "ø"),
    ("O", "Ø"),
    ("ae", "æ"),
    ("AE", "Æ"),
    ("oe", "œ"),
    ("OE", "Œ"),
    ("aa", "å"),
    ("AA", "Å"),
    ("l", "ł"),
    ("L", "Ł"),
    ("i", "ı"),
    ("j", "ȷ"),
    ("dh", "ð"),
    ("DH", "Ð"),
    ("th", "þ"),
    ("TH", "Þ"),
    ("ng", "ŋ"),
    ("NG", "Ŋ"),
    ("dj", "đ"),
    ("DJ", "Đ"),
    ("textendash", "–"),
    ("textemdash", "—"),
    ("textquoteleft", "‘"),
    ("textquoteright", "’"),
    ("textquotedblleft", "“"),
    ("textquotedblright", "”"),
    ("quotedblbase", "„"),
    ("guillemotleft", "«"),
    ("guillemotright", "»"),
    ("guillemetleft", "«"),
    ("guillemetright", "»"),
    ("ldots", "…"),
    ("dots", "…"),
    ("textellipsis", "…"),
    ("S", "§"),
    ("P", "¶"),
    ("copyright", "©"),
    ("textcopyright", "©"),
    ("textregistered", "®"),
    ("texttrademark", "™"),
    ("pounds", "£"),
    ("textsterling", "£"),
    ("euro", "€"),
    ("texteuro", "€"),
    ("textdegree", "°"),
    ("textbackslash", "\\"),
    ("textasciitilde", "~"),
    ("textasciicircum", "^"),
    ("textunderscore", "_"),
    ("textbar", "|"),
    ("textless", "<"),
    ("textgreater", ">"),
    ("textbullet", "•"),
    ("textdagger", "†"),
    ("dag", "†"),
    ("textperiodcentered", "·"),
    ("textexclamdown", "¡"),
    ("textquestiondown", "¿"),
    ("LaTeX", "LaTeX"),
    ("TeX", "TeX"),
    ("BibTeX", "BibTeX"),
    ("textmu", "µ"),
    ("textpm", "±"),
    ("texttimes", "×"),
];

/// Maths commands with a Unicode spelling.
const MATH: &[(&str, &str)] = &[
    ("alpha", "α"),
    ("beta", "β"),
    ("gamma", "γ"),
    ("delta", "δ"),
    ("epsilon", "ϵ"),
    ("varepsilon", "ε"),
    ("zeta", "ζ"),
    ("eta", "η"),
    ("theta", "θ"),
    ("vartheta", "ϑ"),
    ("iota", "ι"),
    ("kappa", "κ"),
    ("lambda", "λ"),
    ("mu", "μ"),
    ("nu", "ν"),
    ("xi", "ξ"),
    ("pi", "π"),
    ("varpi", "ϖ"),
    ("rho", "ρ"),
    ("varrho", "ϱ"),
    ("sigma", "σ"),
    ("varsigma", "ς"),
    ("tau", "τ"),
    ("upsilon", "υ"),
    ("phi", "ϕ"),
    ("varphi", "φ"),
    ("chi", "χ"),
    ("psi", "ψ"),
    ("omega", "ω"),
    ("Gamma", "Γ"),
    ("Delta", "Δ"),
    ("Theta", "Θ"),
    ("Lambda", "Λ"),
    ("Xi", "Ξ"),
    ("Pi", "Π"),
    ("Sigma", "Σ"),
    ("Upsilon", "Υ"),
    ("Phi", "Φ"),
    ("Psi", "Ψ"),
    ("Omega", "Ω"),
    ("pm", "±"),
    ("mp", "∓"),
    ("times", "×"),
    ("cdot", "·"),
    ("div", "÷"),
    ("leq", "≤"),
    ("le", "≤"),
    ("geq", "≥"),
    ("ge", "≥"),
    ("neq", "≠"),
    ("ne", "≠"),
    ("approx", "≈"),
    ("sim", "∼"),
    ("simeq", "≃"),
    ("equiv", "≡"),
    ("infty", "∞"),
    ("partial", "∂"),
    ("nabla", "∇"),
    ("sum", "∑"),
    ("prod", "∏"),
    ("int", "∫"),
    ("sqrt", "√"),
    ("rightarrow", "→"),
    ("to", "→"),
    ("leftarrow", "←"),
    ("leftrightarrow", "↔"),
    ("Rightarrow", "⇒"),
    ("Leftrightarrow", "⇔"),
    ("in", "∈"),
    ("notin", "∉"),
    ("subset", "⊂"),
    ("subseteq", "⊆"),
    ("cup", "∪"),
    ("cap", "∩"),
    ("emptyset", "∅"),
    ("forall", "∀"),
    ("exists", "∃"),
    ("neg", "¬"),
    ("wedge", "∧"),
    ("vee", "∨"),
    ("ell", "ℓ"),
    ("hbar", "ℏ"),
    ("circ", "∘"),
    ("prime", "′"),
    ("degree", "°"),
    ("langle", "⟨"),
    ("rangle", "⟩"),
    ("ldots", "…"),
    ("cdots", "⋯"),
    ("propto", "∝"),
];

/// One-argument commands whose argument is the text.
const TEXT_COMMANDS: &[&str] = &[
    "textbf", "textit", "emph", "textsc", "textrm", "texttt", "textsf", "textup", "textsl", "textmd", "textnormal", "mbox", "text", "uppercase",
    "lowercase", "MakeUppercase", "MakeLowercase", "textsuperscript", "textsubscript", "ensuremath", "mathrm", "mathit", "mathbf", "mathsf",
    "mathtt", "operatorname", "hbox", "underline", "nocite", "foreignlanguage", "hyphenation", "bibstring", "NoCaseChange",
];
/// Font switches and spacing that carry no text.
const DROPPED: &[&str] = &[
    "bf", "it", "em", "sc", "rm", "tt", "sf", "sl", "normalfont", "small", "footnotesize", "scriptsize", "tiny", "large", "Large", "relax",
    "protect", "noindent", "newblock", "hfill", "quad", "qquad", "allowbreak", "xspace", "/", "@", "nobreak", "unskip", "null", "displaystyle",
];

const SUPERSCRIPTS: &[(char, char)] = &[
    ('0', '⁰'), ('1', '¹'), ('2', '²'), ('3', '³'), ('4', '⁴'), ('5', '⁵'), ('6', '⁶'), ('7', '⁷'), ('8', '⁸'), ('9', '⁹'), ('+', '⁺'), ('-', '⁻'), ('n', 'ⁿ'), ('i', 'ⁱ'),
];
const SUBSCRIPTS: &[(char, char)] = &[
    ('0', '₀'), ('1', '₁'), ('2', '₂'), ('3', '₃'), ('4', '₄'), ('5', '₅'), ('6', '₆'), ('7', '₇'), ('8', '₈'), ('9', '₉'), ('+', '₊'), ('-', '₋'),
];

struct Reader<'a> {
    chars: Vec<char>,
    at: usize,
    _text: &'a str,
}

/// LaTeX → Unicode (also removes grouping braces).
pub fn decode(text: &str) -> String {
    if !text.contains(['\\', '{', '}', '$', '~', '-', '`', '\'']) {
        return collapse(text);
    }
    let mut reader = Reader { chars: text.chars().collect(), at: 0, _text: text };
    let out = reader.run(None);
    collapse(&out.nfc().collect::<String>())
}

/// A verbatim field (URL, DOI, file): only braces and escaped specials go.
pub fn decode_verbatim(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' | '}' => {}
            '\\' if chars.peek().is_some_and(|n| matches!(n, '_' | '%' | '&' | '#' | '$' | '{' | '}' | '~')) => out.push(chars.next().unwrap()),
            c => out.push(c),
        }
    }
    out.trim().to_string()
}

fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() && c != '\u{a0}' {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    out
}

impl Reader<'_> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }
    fn peek_at(&self, n: usize) -> Option<char> {
        self.chars.get(self.at + n).copied()
    }

    /// Reads until `until` (a closing brace) or the end.
    fn run(&mut self, until: Option<char>) -> String {
        let mut out = String::new();
        while let Some(c) = self.peek() {
            if Some(c) == until {
                self.at += 1;
                return out;
            }
            self.at += 1;
            match c {
                '{' => out.push_str(&self.run(Some('}'))),
                '}' => {}
                '\\' => out.push_str(&self.command()),
                '$' => out.push_str(&self.math()),
                '~' => out.push(' '),
                '-' if self.peek() == Some('-') => {
                    self.at += 1;
                    if self.peek() == Some('-') {
                        self.at += 1;
                        out.push('—');
                    } else {
                        out.push('–');
                    }
                }
                '`' if self.peek() == Some('`') => {
                    self.at += 1;
                    out.push('“');
                }
                '\'' if self.peek() == Some('\'') => {
                    self.at += 1;
                    out.push('”');
                }
                '`' => out.push('‘'),
                c => out.push(c),
            }
        }
        out
    }

    /// One argument: a group, a control sequence or a single character.
    fn argument(&mut self) -> String {
        while self.peek() == Some(' ') {
            self.at += 1;
        }
        match self.peek() {
            Some('{') => {
                self.at += 1;
                self.run(Some('}'))
            }
            Some('\\') => {
                self.at += 1;
                self.command()
            }
            Some(c) => {
                self.at += 1;
                c.to_string()
            }
            None => String::new(),
        }
    }

    /// Raw text of a braced argument, braces balanced (for URLs).
    fn raw_argument(&mut self) -> String {
        while self.peek() == Some(' ') {
            self.at += 1;
        }
        if self.peek() != Some('{') {
            return String::new();
        }
        self.at += 1;
        let mut depth = 1;
        let mut out = String::new();
        while let Some(c) = self.peek() {
            self.at += 1;
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            out.push(c);
        }
        out
    }

    fn skip_space_after_word(&mut self) {
        while self.peek().is_some_and(|c| c == ' ' || c == '\n' || c == '\t') {
            self.at += 1;
        }
        // `\ss{}` and `\o{}`: an empty group ends the word.
        if self.peek() == Some('{') && self.peek_at(1) == Some('}') {
            self.at += 2;
        }
    }

    fn command(&mut self) -> String {
        let Some(first) = self.peek() else { return "\\".into() };
        if !first.is_ascii_alphabetic() {
            self.at += 1;
            if let Some((_, mark)) = ACCENTS.iter().find(|(c, _)| *c == first) {
                return accent(&self.argument(), *mark);
            }
            return match first {
                '&' | '%' | '$' | '#' | '_' | '{' | '}' | '~' | '^' => first.to_string(),
                ' ' | ',' | ';' | ':' | '!' => " ".into(),
                '\\' => " ".into(),
                '-' => String::new(),
                '/' | '@' => String::new(),
                c => format!("\\{c}"),
            };
        }
        let start = self.at;
        while self.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
            self.at += 1;
        }
        let name: String = self.chars[start..self.at].iter().collect();
        // Letter accents (`\c{c}`, `\v s`) are single letters.
        if name.len() == 1 {
            if let Some((_, mark)) = ACCENTS.iter().find(|(c, _)| c.to_string() == name) {
                let has_argument = self.peek().is_some_and(|c| c == '{' || c == ' ');
                if has_argument && !(name == "i" || name == "j" || name == "o" || name == "O" || name == "l" || name == "L" || name == "S" || name == "P") {
                    return accent(&self.argument(), *mark);
                }
            }
        }
        if let Some((_, value)) = SYMBOLS.iter().find(|(n, _)| *n == name) {
            self.skip_space_after_word();
            return value.to_string();
        }
        if TEXT_COMMANDS.contains(&name.as_str()) {
            let inner = self.argument();
            return match name.as_str() {
                "uppercase" | "MakeUppercase" => inner.to_uppercase(),
                "lowercase" | "MakeLowercase" => inner.to_lowercase(),
                "textsuperscript" => script(&inner, SUPERSCRIPTS).unwrap_or(inner),
                "textsubscript" => script(&inner, SUBSCRIPTS).unwrap_or(inner),
                "foreignlanguage" => self.argument(),
                "nocite" | "hyphenation" => String::new(),
                _ => inner,
            };
        }
        if DROPPED.contains(&name.as_str()) {
            self.skip_space_after_word();
            return String::new();
        }
        match name.as_str() {
            "url" | "path" => return self.raw_argument(),
            "href" => {
                let _url = self.raw_argument();
                return self.argument();
            }
            "enquote" => return format!("“{}”", self.argument()),
            "noopsort" | "sortnoop" | "ignore" => {
                self.argument();
                return String::new();
            }
            _ => {}
        }
        if let Some((_, value)) = MATH.iter().find(|(n, _)| *n == name) {
            self.skip_space_after_word();
            return value.to_string();
        }
        // Unknown: kept as written, argument and all.
        let mut out = format!("\\{name}");
        if self.peek() == Some('{') {
            out.push('{');
            out.push_str(&self.raw_argument());
            out.push('}');
        } else if self.peek() == Some(' ') {
            out.push(' ');
            self.at += 1;
        }
        out
    }

    /// `$…$`: Unicode where every part has a spelling, else kept as written.
    fn math(&mut self) -> String {
        let start = self.at;
        let mut depth = 0;
        let mut end = None;
        let mut i = self.at;
        while i < self.chars.len() {
            match self.chars[i] {
                '\\' => i += 1,
                '{' => depth += 1,
                '}' => depth -= 1,
                '$' if depth <= 0 => {
                    end = Some(i);
                    break;
                }
                _ => {}
            }
            i += 1;
        }
        let Some(end) = end else { return "$".into() };
        self.at = end + 1;
        let body: String = self.chars[start..end].iter().collect();
        math_unicode(&body).unwrap_or_else(|| format!("${body}$"))
    }
}

fn accent(base: &str, mark: char) -> String {
    let mut chars = base.chars();
    let Some(first) = chars.next() else { return mark.to_string() };
    let first = match first {
        'ı' => 'i',
        'ȷ' => 'j',
        c => c,
    };
    let mut out: String = [first, mark].iter().collect::<String>().nfc().collect();
    out.extend(chars);
    out
}

fn script(text: &str, table: &[(char, char)]) -> Option<String> {
    text.chars().map(|c| table.iter().find(|(from, _)| *from == c).map(|(_, to)| *to)).collect()
}

fn math_unicode(body: &str) -> Option<String> {
    let chars: Vec<char> = body.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        i += 1;
        match c {
            '\\' => {
                let start = i;
                while i < chars.len() && chars[i].is_ascii_alphabetic() {
                    i += 1;
                }
                let name: String = chars[start..i].iter().collect();
                if name.is_empty() {
                    let next = *chars.get(i)?;
                    i += 1;
                    match next {
                        ',' | ';' | ' ' | '!' => out.push(' '),
                        '%' | '&' | '#' | '_' | '{' | '}' | '$' => out.push(next),
                        _ => return None,
                    }
                    continue;
                }
                if matches!(name.as_str(), "mathrm" | "text" | "mathit" | "mathbf" | "rm" | "operatorname" | "mathsf") {
                    continue;
                }
                out.push_str(MATH.iter().find(|(n, _)| *n == name)?.1);
                while i < chars.len() && chars[i] == ' ' {
                    i += 1;
                }
            }
            '^' | '_' => {
                let table = if c == '^' { SUPERSCRIPTS } else { SUBSCRIPTS };
                let argument: String = if chars.get(i) == Some(&'{') {
                    let end = chars[i..].iter().position(|c| *c == '}')? + i;
                    let a = chars[i + 1..end].iter().collect();
                    i = end + 1;
                    a
                } else if chars.get(i) == Some(&'\\') {
                    let start = i;
                    i += 1;
                    while i < chars.len() && chars[i].is_ascii_alphabetic() {
                        i += 1;
                    }
                    chars[start..i].iter().collect()
                } else {
                    i += 1;
                    chars.get(i - 1)?.to_string()
                };
                if c == '^' && argument == "\\circ" {
                    out.push('°');
                    continue;
                }
                out.push_str(&script(&argument, table)?);
            }
            '{' | '}' => {}
            c if c.is_alphanumeric() || " +-=()[]/.,:;<>|!'*".contains(c) => out.push(if c == '-' { '−' } else { c }),
            _ => return None,
        }
    }
    Some(out.replace('−', "-"))
}

/// How text is written into a BibTeX value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    /// UTF-8 with only TeX's special characters escaped (biber, modern BibTeX).
    Unicode,
    /// Letters outside ASCII as LaTeX accents and commands (classic BibTeX).
    Latex,
}

/// Unicode → a BibTeX value body (without the outer braces).
pub fn encode(text: &str, encoding: Encoding) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // Maths kept from the import goes back as it was.
        if c == '$' {
            if let Some(end) = chars[i + 1..].iter().position(|c| *c == '$').map(|p| p + i + 1) {
                let segment: String = chars[i..=end].iter().collect();
                if segment.contains('\\') || segment.contains('^') || segment.contains('_') {
                    out.push_str(&segment);
                    i = end + 1;
                    continue;
                }
            }
        }
        // A kept unknown command (`\foo{bar}`) also goes back as written.
        if c == '\\' && chars.get(i + 1).is_some_and(|c| c.is_ascii_alphabetic()) {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_ascii_alphabetic() {
                j += 1;
            }
            out.extend(&chars[i..j]);
            i = j;
            continue;
        }
        i += 1;
        match c {
            '&' | '%' | '#' | '_' | '$' => {
                out.push('\\');
                out.push(c);
            }
            '{' | '}' => {
                out.push('\\');
                out.push(c);
            }
            '\\' => out.push_str("\\textbackslash{}"),
            '~' => out.push_str("\\textasciitilde{}"),
            '^' => out.push_str("\\textasciicircum{}"),
            '–' => out.push_str("--"),
            '—' => out.push_str("---"),
            '\u{a0}' => out.push('~'),
            c if c.is_ascii() => out.push(c),
            c if encoding == Encoding::Unicode => out.push(c),
            c => out.push_str(&latex_char(c)),
        }
    }
    out
}

fn latex_char(c: char) -> String {
    match c {
        '“' => return "``".into(),
        '”' => return "''".into(),
        '‘' => return "`".into(),
        '’' => return "'".into(),
        _ => {}
    }
    if let Some((name, _)) = SYMBOLS.iter().find(|(name, value)| value.chars().count() == 1 && value.starts_with(c) && !matches!(*name, "j" | "dots" | "textellipsis" | "pounds" | "euro" | "copyright")) {
        return format!("{{\\{name}}}");
    }
    if let Some((name, _)) = MATH.iter().find(|(_, value)| value.starts_with(c) && value.chars().count() == 1) {
        return format!("$\\{name}$");
    }
    let decomposed: Vec<char> = c.to_string().nfd().collect();
    if decomposed.len() >= 2 {
        let mut base = decomposed[0].to_string();
        if base == "i" {
            base = "\\i".into();
        } else if base == "j" {
            base = "\\j".into();
        }
        let mut out = base;
        for mark in &decomposed[1..] {
            let Some((command, _)) = ACCENTS.iter().find(|(_, m)| m == mark) else { return c.to_string() };
            out = if command.is_ascii_alphabetic() { format!("\\{command}{{{out}}}") } else { format!("\\{command}{out}") };
        }
        return format!("{{{out}}}");
    }
    c.to_string()
}

/// A title for BibTeX: words whose capitals must survive a style's sentence case
/// (acronyms, "iPhone", "McDonald") go in braces.
pub fn protect_case(encoded: &str) -> String {
    let mut out = String::with_capacity(encoded.len() + 8);
    let mut depth = 0;
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String, depth: i32| {
        if word.is_empty() {
            return;
        }
        let letters: Vec<char> = word.chars().filter(|c| c.is_alphabetic()).collect();
        let needs = depth == 0 && !word.starts_with('\\') && letters.iter().skip(1).any(|c| c.is_uppercase()) && !word.contains('$');
        if needs {
            out.push('{');
            out.push_str(word);
            out.push('}');
        } else {
            out.push_str(word);
        }
        word.clear();
    };
    for c in encoded.chars() {
        match c {
            '{' => {
                flush(&mut word, &mut out, depth);
                depth += 1;
                out.push(c);
            }
            '}' => {
                flush(&mut word, &mut out, depth);
                depth -= 1;
                out.push(c);
            }
            c if c.is_whitespace() || c == ':' || c == ',' || c == '(' || c == ')' || c == '/' => {
                flush(&mut word, &mut out, depth);
                out.push(c);
            }
            c if depth > 0 => out.push(c),
            c => word.push(c),
        }
    }
    flush(&mut word, &mut out, depth);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_accents_symbols_and_maths() {
        assert_eq!(decode(r#"Schr{\"o}dinger's {\'E}quation"#), "Schrödinger's Équation");
        assert_eq!(decode(r#"\"{u}ber \'{\i}ndice \c{c}a \v{S}koda \H{o} \k{a} \r{a}"#), "über índice ça Škoda ő ą å");
        assert_eq!(decode(r#"Stra{\ss}e and {\o}l \AA{}ngstr\"om"#), "Straße and øl Ångström");
        assert_eq!(decode("pages 1--10 and---so ``quoted''"), "pages 1–10 and—so “quoted”");
        assert_eq!(decode(r"The $\alpha$-helix and $H_2O$ at 37$^\circ$C"), "The α-helix and H₂O at 37°C");
        assert_eq!(decode(r"Kept $\mathcal{O}(n \log n)$ maths"), r"Kept $\mathcal{O}(n \log n)$ maths");
        assert_eq!(decode(r"{{DNA}} and \emph{in vivo} \textbf{bold} 50\% \& more"), "DNA and in vivo bold 50% & more");
        assert_eq!(decode(r"\unknown{arg} stays"), r"\unknown{arg} stays");
        assert_eq!(decode("Fig.~1"), "Fig. 1");
    }

    #[test]
    fn encodes_back() {
        assert_eq!(encode("Schrödinger 50% & co_op", Encoding::Latex), r#"Schr{\"o}dinger 50\% \& co\_op"#);
        assert_eq!(encode("Schrödinger 50%", Encoding::Unicode), r"Schrödinger 50\%");
        assert_eq!(encode("Straße ça", Encoding::Latex), r"Stra{\ss}e {\c{c}}a");
        assert_eq!(decode(&encode("Škoda ő índice Ångström 1–10 α", Encoding::Latex)), "Škoda ő índice Ångström 1–10 α");
        assert_eq!(encode(r"Kept $\mathcal{O}(n)$", Encoding::Unicode), r"Kept $\mathcal{O}(n)$");
        assert_eq!(protect_case("The DNA of iPhone users: a study"), "The {DNA} of {iPhone} users: a study");
        assert_eq!(protect_case("Already {NASA} protected"), "Already {NASA} protected");
    }
}
