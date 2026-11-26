// Citation keys: one per source, generated from a small pattern (`auth.lower + year`),
// unique across the library (a later source takes the next free suffix: a, b, … z, aa),
// and kept as they are when metadata changes. A key the user typed or that came from an
// imported file is pinned; "regenerate" unpins it. A key generated before the source had
// an author and a year is provisional and is generated again once both arrive.
//
// Pattern language: terms joined by `+`, each a field with optional `.modifier`s, or a
// quoted literal.
//   auth            first author's family name (an organisation: its initials)
//   authors(n)      the first n family names, joined
//   authorsetal(n)  as authors(n), then "EtAl" when there are more
//   year            the year
//   shorttitle(n)   the first n significant title words, capitalised and joined
//   veryshorttitle  the first significant title word
//   title           every title word, capitalised and joined
//   "text"          literal text
// Modifiers: lower, upper, capitalize, ascii (folded by default), raw (keep accents),
// clean (drop characters keys cannot hold; applied by default), substring(start,length).
use crate::{Creator, Result, Source, Store, e};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::HashSet;
use unicode_normalization::UnicodeNormalization;

pub const DEFAULT_PATTERN: &str = "auth.lower + year";
const PATTERN_META: &str = "citationKey.pattern";
const REVISION_META: &str = "citationKey.revision";
/// Words a short title skips.
const STOP_WORDS: &[&str] = &[
    "a", "an", "the", "and", "or", "of", "on", "in", "into", "to", "for", "from", "with", "by", "at", "as", "is", "are", "via", "its", "how", "what",
    "why", "when", "der", "die", "das", "le", "la", "les", "el", "los", "un", "une", "de", "et", "und",
];

pub(crate) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS citation_key_state (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  pinned INTEGER NOT NULL DEFAULT 0,
  provisional INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sources_citation_key ON sources(citation_key COLLATE NOCASE);";

#[derive(Clone, Debug, PartialEq)]
enum Term {
    Literal(String),
    Field { name: String, args: Vec<usize>, modifiers: Vec<(String, Vec<usize>)> },
}

#[derive(Clone, Debug, PartialEq)]
pub struct KeyPattern {
    terms: Vec<Term>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CitationKeyInfo {
    pub key: Option<String>,
    pub pinned: bool,
    pub provisional: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternPreview {
    pub pattern: String,
    pub valid: bool,
    pub error: Option<String>,
    pub examples: Vec<(String, String)>,
}

impl KeyPattern {
    pub fn parse(text: &str) -> Result<Self> {
        let mut terms = Vec::new();
        for part in split_plus(text) {
            let part = part.trim();
            if part.is_empty() {
                return Err("Empty term in the key pattern".into());
            }
            if let Some(inner) = part.strip_prefix('"').and_then(|p| p.strip_suffix('"')).or_else(|| part.strip_prefix('\'').and_then(|p| p.strip_suffix('\''))) {
                terms.push(Term::Literal(inner.to_string()));
                continue;
            }
            let mut pieces = split_dots(part).into_iter();
            let (name, args) = call(pieces.next().unwrap_or_default())?;
            let name = name.to_ascii_lowercase();
            if !matches!(name.as_str(), "auth" | "authors" | "authorsetal" | "year" | "shorttitle" | "veryshorttitle" | "title") {
                return Err(format!("Unknown key field “{name}”"));
            }
            let mut modifiers = Vec::new();
            for piece in pieces {
                let (modifier, args) = call(piece)?;
                let modifier = modifier.to_ascii_lowercase();
                if !matches!(modifier.as_str(), "lower" | "upper" | "capitalize" | "ascii" | "raw" | "clean" | "substring") {
                    return Err(format!("Unknown key modifier “{modifier}”"));
                }
                modifiers.push((modifier, args));
            }
            terms.push(Term::Field { name, args, modifiers });
        }
        if terms.is_empty() {
            return Err("The key pattern is empty".into());
        }
        Ok(Self { terms })
    }

    /// The key a source's metadata gives, before uniqueness (may be empty).
    pub fn apply(&self, source: &KeySourceFields) -> String {
        let mut out = String::new();
        for term in &self.terms {
            match term {
                Term::Literal(text) => out.push_str(text),
                Term::Field { name, args, modifiers } => {
                    let n = args.first().copied();
                    let mut value = match name.as_str() {
                        "auth" => source.families.first().cloned().unwrap_or_default(),
                        "authors" => source.families.iter().take(n.unwrap_or(usize::MAX)).cloned().collect::<String>(),
                        "authorsetal" => {
                            let n = n.unwrap_or(1);
                            let mut names: String = source.families.iter().take(n).cloned().collect();
                            if source.families.len() > n {
                                names.push_str("EtAl");
                            }
                            names
                        }
                        "year" => source.year.map(|y| y.to_string()).unwrap_or_default(),
                        "shorttitle" => title_words(&source.title).into_iter().take(n.unwrap_or(3)).map(|w| capitalize(&w)).collect(),
                        "veryshorttitle" => title_words(&source.title).into_iter().next().map(|w| capitalize(&w)).unwrap_or_default(),
                        "title" => title_words_all(&source.title).into_iter().map(|w| capitalize(&w)).collect(),
                        _ => String::new(),
                    };
                    let raw = modifiers.iter().any(|(m, _)| m == "raw");
                    if !raw {
                        value = fold_ascii(&value);
                    }
                    for (modifier, args) in modifiers {
                        value = match modifier.as_str() {
                            "lower" => value.to_lowercase(),
                            "upper" => value.to_uppercase(),
                            "capitalize" => capitalize(&value),
                            "ascii" => fold_ascii(&value),
                            "substring" => {
                                let start = args.first().copied().unwrap_or(1).max(1) - 1;
                                let length = args.get(1).copied().unwrap_or(usize::MAX);
                                value.chars().skip(start).take(length).collect()
                            }
                            _ => value,
                        };
                    }
                    out.push_str(&value);
                }
            }
        }
        clean_key(&out)
    }
}

fn split_plus(text: &str) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut quote = None;
    for c in text.chars() {
        match (c, quote) {
            ('"' | '\'', None) => quote = Some(c),
            (q, Some(open)) if q == open => quote = None,
            ('+', None) => {
                parts.push(String::new());
                continue;
            }
            _ => {}
        }
        parts.last_mut().unwrap().push(c);
    }
    parts
}

fn split_dots(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0;
    let mut start = 0;
    for (i, c) in text.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            '.' if depth == 0 => {
                out.push(&text[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&text[start..]);
    out
}

fn call(text: &str) -> Result<(String, Vec<usize>)> {
    let text = text.trim();
    let Some(open) = text.find('(') else { return Ok((text.to_string(), vec![])) };
    let inner = text[open + 1..].strip_suffix(')').ok_or_else(|| format!("Missing “)” in “{text}”"))?;
    let args = inner
        .split(',')
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(|a| a.parse::<usize>().map_err(|_| format!("“{a}” is not a number")))
        .collect::<Result<Vec<_>>>()?;
    Ok((text[..open].trim().to_string(), args))
}

/// What a key is generated from.
#[derive(Clone, Debug, Default)]
pub struct KeySourceFields {
    pub families: Vec<String>,
    pub year: Option<i64>,
    pub title: String,
}

impl KeySourceFields {
    pub fn of(creators: &[Creator], year: Option<i64>, title: &str) -> Self {
        let authors: Vec<&Creator> = creators.iter().filter(|c| c.role == "author").collect();
        let list: Vec<&Creator> = if authors.is_empty() {
            let editors: Vec<&Creator> = creators.iter().filter(|c| c.role == "editor").collect();
            if editors.is_empty() { creators.iter().collect() } else { editors }
        } else {
            authors
        };
        let families = list.iter().map(|c| family_part(c)).filter(|f| !f.is_empty()).collect();
        Self { families, year, title: title.to_string() }
    }
    pub fn from_source(source: &Source) -> Self {
        Self::of(&source.creators, source.fields.get("year").and_then(Json::as_i64), source.title())
    }
    fn complete(&self) -> bool {
        !self.families.is_empty() && self.year.is_some()
    }
}

/// A family name for keys: particles dropped ("van Gogh" → "Gogh" stays readable as "vanGogh"
/// in BibTeX tools; we keep the particle joined), organisations as initials.
fn family_part(c: &Creator) -> String {
    if let Some(family) = c.family.as_deref().filter(|f| !f.trim().is_empty()) {
        return family.split_whitespace().collect();
    }
    if let Some(literal) = c.literal.as_deref().filter(|f| !f.trim().is_empty()) {
        let words: Vec<&str> = literal.split_whitespace().filter(|w| !STOP_WORDS.contains(&w.to_lowercase().as_str())).collect();
        if words.len() > 2 {
            return words.iter().filter_map(|w| w.chars().find(|c| c.is_alphanumeric())).flat_map(char::to_uppercase).collect();
        }
        return words.concat();
    }
    c.given.as_deref().unwrap_or("").split_whitespace().collect()
}

fn title_words_all(title: &str) -> Vec<String> {
    title
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

fn title_words(title: &str) -> Vec<String> {
    title_words_all(title).into_iter().filter(|w| !STOP_WORDS.contains(&w.to_lowercase().as_str())).collect()
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Accents removed and a few letters spelled out (ß → ss, ø → o, æ → ae).
pub fn fold_ascii(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            'ß' => out.push_str("ss"),
            'ø' => out.push('o'),
            'Ø' => out.push('O'),
            'æ' => out.push_str("ae"),
            'Æ' => out.push_str("AE"),
            'œ' => out.push_str("oe"),
            'Œ' => out.push_str("OE"),
            'ł' => out.push('l'),
            'Ł' => out.push('L'),
            'đ' | 'ð' => out.push('d'),
            'Đ' | 'Ð' => out.push('D'),
            'þ' => out.push_str("th"),
            'Þ' => out.push_str("Th"),
            'ı' => out.push('i'),
            c if c.is_ascii() => out.push(c),
            c => out.extend(c.to_string().nfkd().filter(|c| !unicode_normalization::char::is_combining_mark(*c))),
        }
    }
    out
}

/// Characters a key can hold in BibTeX, biber and pandoc.
fn clean_key(key: &str) -> String {
    key.chars().filter(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | ':' | '.' | '/')).collect()
}

pub fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 200 && key.chars().all(|c| !c.is_whitespace() && !matches!(c, ',' | '{' | '}' | '(' | ')' | '"' | '#' | '%' | '~' | '\\' | '\'' | '=' | '@'))
}

/// a, b, … z, aa, ab …
fn suffix(n: usize) -> String {
    let mut n = n;
    let mut out = Vec::new();
    loop {
        out.push((b'a' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    out.iter().rev().collect()
}

/// `base` itself when free, else base + the first free suffix.
pub fn unique_key(base: &str, taken: &HashSet<String>) -> String {
    let base = if base.is_empty() { "item" } else { base };
    if !taken.contains(&base.to_lowercase()) {
        return base.to_string();
    }
    (0..).map(|n| format!("{base}{}", suffix(n))).find(|k| !taken.contains(&k.to_lowercase())).unwrap()
}

pub(crate) fn ensure_schema(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA).map_err(e)
}

fn taken_keys(db: &Connection, except: Option<&str>) -> Result<HashSet<String>> {
    let mut statement = db.prepare("SELECT lower(citation_key) FROM sources WHERE citation_key IS NOT NULL AND citation_key <> '' AND id IS NOT ?1").map_err(e)?;
    let rows = statement.query_map([except], |r| r.get::<_, String>(0)).map_err(e)?;
    rows.collect::<std::result::Result<_, _>>().map_err(e)
}

fn bump_revision(db: &Connection) -> Result<()> {
    db.execute(
        "INSERT INTO meta(key, value) VALUES (?1, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
        [REVISION_META],
    )
    .map(|_| ())
    .map_err(e)
}

fn write_key(db: &Connection, id: &str, key: &str, pinned: bool, provisional: bool) -> Result<()> {
    db.execute("UPDATE sources SET citation_key = ?2 WHERE id = ?1", params![id, key]).map_err(e)?;
    db.execute(
        "INSERT INTO citation_key_state(source_id, pinned, provisional) VALUES (?1, ?2, ?3)
         ON CONFLICT(source_id) DO UPDATE SET pinned = excluded.pinned, provisional = excluded.provisional",
        params![id, pinned, provisional],
    )
    .map_err(e)?;
    Ok(())
}

pub(crate) fn decorate(db: &Connection, source: &mut Source) -> Result<()> {
    let state: Option<(bool, bool)> = db
        .query_row("SELECT pinned, provisional FROM citation_key_state WHERE source_id = ?", [&source.id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .unwrap_or(None);
    if let Some((pinned, _)) = state {
        source.fields.insert("citationKeyPinned".into(), Json::from(pinned));
    }
    Ok(())
}

impl Store {
    pub fn citation_key_pattern(&self) -> Result<String> {
        Ok(self.meta(PATTERN_META)?.filter(|p| KeyPattern::parse(p).is_ok()).unwrap_or_else(|| DEFAULT_PATTERN.into()))
    }

    /// Changes the pattern; keys already given stay unless `regenerate` (unpinned ones only).
    pub fn set_citation_key_pattern(&self, pattern: &str, regenerate: bool) -> Result<usize> {
        KeyPattern::parse(pattern)?;
        self.set_meta(PATTERN_META, pattern.trim())?;
        if !regenerate {
            return Ok(0);
        }
        let ids: Vec<String> = {
            let db = self.db()?;
            let mut statement = db
                .prepare("SELECT s.id FROM sources s LEFT JOIN citation_key_state k ON k.source_id = s.id WHERE coalesce(k.pinned, 0) = 0 ORDER BY s.added_at, s.rowid")
                .map_err(e)?;
            let rows = statement.query_map([], |r| r.get(0)).map_err(e)?;
            rows.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        {
            let db = self.db()?;
            let tx = db.unchecked_transaction().map_err(e)?;
            for id in &ids {
                tx.execute("UPDATE sources SET citation_key = NULL WHERE id = ?", [id]).map_err(e)?;
            }
            tx.commit().map_err(e)?;
        }
        self.ensure_citation_keys()
    }

    /// What `pattern` gives for a few of the library's sources.
    pub fn preview_citation_key_pattern(&self, pattern: &str) -> Result<PatternPreview> {
        let parsed = KeyPattern::parse(pattern);
        let mut preview = PatternPreview { pattern: pattern.into(), valid: parsed.is_ok(), error: parsed.as_ref().err().cloned(), examples: vec![] };
        if let Ok(parsed) = parsed {
            let db = self.read()?;
            let mut statement = db.prepare("SELECT title, creators, year FROM sources WHERE trashed_at IS NULL AND title <> '' ORDER BY added_at DESC LIMIT 4").map_err(e)?;
            let rows = statement
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?)))
                .map_err(e)?;
            for row in rows {
                let (title, creators, year) = row.map_err(e)?;
                let creators: Vec<Creator> = serde_json::from_str(&creators).unwrap_or_default();
                preview.examples.push((title.clone(), parsed.apply(&KeySourceFields::of(&creators, year, &title))));
            }
        }
        Ok(preview)
    }

    /// Gives every source without a key one (and provisional keys whose source is now
    /// complete a proper one). Returns how many keys were written.
    pub fn ensure_citation_keys(&self) -> Result<usize> {
        let pattern = KeyPattern::parse(&self.citation_key_pattern()?)?;
        let db = self.db()?;
        let rows: Vec<(String, String, String, Option<i64>, bool)> = {
            let mut statement = db
                .prepare(
                    "SELECT s.id, s.title, s.creators, s.year, coalesce(k.provisional, 0) FROM sources s
                     LEFT JOIN citation_key_state k ON k.source_id = s.id
                     WHERE (s.citation_key IS NULL OR s.citation_key = '' OR (k.provisional = 1 AND k.pinned = 0))
                       AND (s.title <> '' OR s.creators <> '[]')
                     ORDER BY s.added_at, s.rowid",
                )
                .map_err(e)?;
            let rows = statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
                .map_err(e)?;
            rows.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        if rows.is_empty() {
            return Ok(0);
        }
        let mut taken = taken_keys(&db, None)?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let mut written = 0;
        for (id, title, creators, year, provisional) in rows {
            let creators: Vec<Creator> = serde_json::from_str(&creators).unwrap_or_default();
            let fields = KeySourceFields::of(&creators, year, &title);
            if provisional && !fields.complete() {
                continue;
            }
            let current: Option<String> = tx.query_row("SELECT citation_key FROM sources WHERE id = ?", [&id], |r| r.get(0)).map_err(e)?;
            if let Some(current) = current.as_deref().filter(|c| !c.is_empty()) {
                taken.remove(&current.to_lowercase());
            }
            let key = unique_key(&pattern.apply(&fields), &taken);
            taken.insert(key.to_lowercase());
            if current.as_deref() != Some(key.as_str()) || provisional != !fields.complete() {
                write_key(&tx, &id, &key, false, !fields.complete())?;
                written += 1;
            }
        }
        if written > 0 {
            bump_revision(&tx)?;
        }
        tx.commit().map_err(e)?;
        Ok(written)
    }

    pub fn citation_key(&self, id: &str) -> Result<CitationKeyInfo> {
        let db = self.read()?;
        let key: Option<String> = db.query_row("SELECT citation_key FROM sources WHERE id = ?", [id], |r| r.get(0)).optional().map_err(e)?.ok_or("Source not found")?;
        let (pinned, provisional): (bool, bool) = db
            .query_row("SELECT pinned, provisional FROM citation_key_state WHERE source_id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(e)?
            .unwrap_or((false, false));
        Ok(CitationKeyInfo { key: key.filter(|k| !k.is_empty()), pinned, provisional })
    }

    /// Sets a key the user chose (pinned unless `pinned` is false). A key another source
    /// holds is refused.
    pub fn set_citation_key(&self, id: &str, key: &str, pinned: bool) -> Result<CitationKeyInfo> {
        let key = key.trim();
        if !valid_key(key) {
            return Err("A citation key cannot be empty or contain spaces, commas, braces or quotes".into());
        }
        {
            let db = self.db()?;
            let holder: Option<String> = db
                .query_row("SELECT title FROM sources WHERE lower(citation_key) = lower(?1) AND id <> ?2 LIMIT 1", params![key, id], |r| r.get(0))
                .optional()
                .map_err(e)?;
            if let Some(title) = holder {
                return Err(format!("“{key}” is already the key of “{}”", if title.is_empty() { "Untitled" } else { &title }));
            }
            let tx = db.unchecked_transaction().map_err(e)?;
            write_key(&tx, id, key, pinned, false)?;
            tx.execute("UPDATE sources SET updated_at = ?2 WHERE id = ?1", params![id, crate::now_ms()]).map_err(e)?;
            bump_revision(&tx)?;
            tx.commit().map_err(e)?;
        }
        self.citation_key(id)
    }

    pub fn pin_citation_key(&self, id: &str, pinned: bool) -> Result<CitationKeyInfo> {
        {
            let db = self.db()?;
            db.execute(
                "INSERT INTO citation_key_state(source_id, pinned, provisional) VALUES (?1, ?2, 0)
                 ON CONFLICT(source_id) DO UPDATE SET pinned = excluded.pinned",
                params![id, pinned],
            )
            .map_err(e)?;
        }
        self.citation_key(id)
    }

    /// Generates the keys of `ids` again from the pattern and unpins them.
    pub fn regenerate_citation_keys(&self, ids: &[String]) -> Result<Vec<CitationKeyInfo>> {
        let pattern = KeyPattern::parse(&self.citation_key_pattern()?)?;
        {
            let db = self.db()?;
            let tx = db.unchecked_transaction().map_err(e)?;
            let mut taken = taken_keys(&tx, None)?;
            for id in ids {
                let Some((title, creators, year, current)) = tx
                    .query_row("SELECT title, creators, year, citation_key FROM sources WHERE id = ?", [id], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, Option<String>>(3)?))
                    })
                    .optional()
                    .map_err(e)?
                else {
                    continue;
                };
                if let Some(current) = current {
                    taken.remove(&current.to_lowercase());
                }
                let creators: Vec<Creator> = serde_json::from_str(&creators).unwrap_or_default();
                let fields = KeySourceFields::of(&creators, year, &title);
                let key = unique_key(&pattern.apply(&fields), &taken);
                taken.insert(key.to_lowercase());
                write_key(&tx, id, &key, false, !fields.complete())?;
                tx.execute("UPDATE sources SET updated_at = ?2 WHERE id = ?1", params![id, crate::now_ms()]).map_err(e)?;
            }
            bump_revision(&tx)?;
            tx.commit().map_err(e)?;
        }
        ids.iter().map(|id| self.citation_key(id)).collect()
    }

    /// An imported key, pinned. Taken by another source, it gets the next free suffix;
    /// the key it ended up with comes back.
    pub fn claim_citation_key(&self, id: &str, wanted: &str) -> Result<String> {
        let wanted: String = wanted.trim().chars().filter(|c| !c.is_whitespace()).collect();
        if !valid_key(&wanted) {
            return Err(format!("“{wanted}” cannot be a citation key"));
        }
        let db = self.db()?;
        let taken = taken_keys(&db, Some(id))?;
        let key = unique_key(&wanted, &taken);
        write_key(&db, id, &key, true, false)?;
        bump_revision(&db)?;
        Ok(key)
    }

    /// Changes whenever a source, a collection, a note or a key changes: what the
    /// auto-exporter watches.
    pub fn library_fingerprint(&self) -> Result<String> {
        let db = self.read()?;
        db.query_row(
            "SELECT (SELECT count(*) || ':' || coalesce(max(updated_at), 0) || ':' || coalesce(sum(trashed_at IS NOT NULL), 0) FROM sources)
              || '/' || (SELECT count(*) || ':' || coalesce(sum(rowid), 0) FROM source_collections)
              || '/' || (SELECT count(*) || ':' || group_concat(id || name || coalesce(parent_id, ''), '') FROM collections)
              || '/' || (SELECT count(*) || ':' || coalesce(max(updated_at), 0) FROM notes)
              || '/' || coalesce((SELECT value FROM meta WHERE key = ?1), '0')",
            [REVISION_META],
            |r| r.get::<_, String>(0),
        )
        .map_err(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(family: &str) -> Creator {
        Creator { family: Some(family.into()), given: Some("A".into()), role: "author".into(), ..Default::default() }
    }

    #[test]
    fn patterns_parse_and_apply() {
        let fields = KeySourceFields::of(&[person("Müller"), person("van der Berg"), person("Ødegaard")], Some(2021), "The Rise of Deep Learning in Ecology");
        let key = |p: &str| KeyPattern::parse(p).unwrap().apply(&fields);
        assert_eq!(key(DEFAULT_PATTERN), "muller2021");
        assert_eq!(key("auth + year + shorttitle(2)"), "Muller2021RiseDeep");
        assert_eq!(key("authors(2).lower + \"_\" + year"), "mullervanderberg_2021");
        assert_eq!(key("authorsetal(1) + year"), "MullerEtAl2021");
        assert_eq!(key("auth.raw.lower + veryshorttitle.lower"), "müllerrise");
        assert_eq!(key("auth.substring(1,3).upper + year"), "MUL2021");
        assert!(KeyPattern::parse("auth + nope").is_err());
        assert!(KeyPattern::parse("auth.shout").is_err());
        let org = KeySourceFields::of(&[Creator { literal: Some("World Health Organization".into()), role: "author".into(), ..Default::default() }], Some(2020), "Report");
        assert_eq!(KeyPattern::parse(DEFAULT_PATTERN).unwrap().apply(&org), "who2020");
    }

    #[test]
    fn suffixes_are_stable_and_unique() {
        let taken: HashSet<String> = ["smith2020", "smith2020a"].iter().map(|s| s.to_string()).collect();
        assert_eq!(unique_key("smith2020", &taken), "smith2020b");
        assert_eq!(unique_key("jones2020", &taken), "jones2020");
        assert_eq!(suffix(0), "a");
        assert_eq!(suffix(25), "z");
        assert_eq!(suffix(26), "aa");
    }
}
