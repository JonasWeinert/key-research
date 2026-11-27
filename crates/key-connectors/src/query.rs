// The neutral query (what the visual builder makes), its translation into a service's own
// syntax by the spec's `query` block, chunking of long queries, and local evaluation of the
// query on a record (relevance-only and harvest connectors, and `localFilter`).
use crate::boolean::{self, Node, Op, Truth};
use crate::plan::{self, Strategy, SubQueryInfo};
use crate::record::Record;
use crate::spec::{QuerySpec, Spec};
use crate::template::{self, Vars};
use serde::{Deserialize, Serialize};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

pub type Field = String;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    /// The Boolean tree (see `boolean`). When present it is the search; `concepts` and
    /// `exclude` are the older AND-of-ORs form, still read from saved searches.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expr: Option<Node>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub concepts: Vec<Concept>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<Term>,
    pub filters: Filters,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Concept {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub terms: Vec<Term>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Term {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub text: String,
    /// "phrase" or "words".
    pub mode: String,
    pub truncate: bool,
    pub field: Field,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proximity: Option<u32>,
}

impl Default for Term {
    fn default() -> Self {
        Self { id: None, text: String::new(), mode: "words".into(), truncate: false, field: "all".into(), proximity: None }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Filters {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year_from: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year_to: Option<i64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub types: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub languages: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_access: Option<bool>,
}

impl Query {
    pub fn from_tree(tree: Node, filters: Filters) -> Query {
        Query { expr: Some(tree), concepts: Vec::new(), exclude: Vec::new(), filters }
    }

    /// The search as a tree (normalized; the older concept form converted).
    pub fn tree(&self) -> Node {
        if let Some(e) = &self.expr {
            return e.normalized().unwrap_or_default();
        }
        let mut items: Vec<Node> = self.concepts.iter().map(|c| Node::Group { id: c.id.clone(), op: Op::Or, items: c.terms.iter().cloned().map(Node::term).collect(), not: false, label: c.label.clone() }).collect();
        items.extend(self.exclude.iter().cloned().map(|t| Node::term(t).negated(true)));
        Node::group(Op::And, items).normalized().unwrap_or_default()
    }

    pub fn terms(&self) -> Vec<Term> {
        self.tree().terms().into_iter().cloned().collect()
    }

    /// The query without empty terms and groups, always in tree form.
    pub fn cleaned(&self) -> Query {
        Query::from_tree(self.tree(), self.filters.clone())
    }

    /// The top-level AND parts ("concepts"), for per-part counts.
    pub fn parts(&self) -> Vec<Node> {
        match self.tree() {
            Node::Group { op: Op::And, items, not: false, .. } => items,
            other if other.is_empty() => Vec::new(),
            other => vec![other],
        }
    }

    /// Only one top-level part (and the filters).
    pub fn only_part(&self, index: usize) -> Query {
        Query::from_tree(self.parts().get(index).cloned().map(|n| n.negated(false)).unwrap_or_default(), self.filters.clone())
    }
}

/// What a connector is sent for a query.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Translation {
    pub connector: String,
    pub mode: String,
    /// The whole query in the service's syntax (`chunks` joined for display when split).
    pub native: String,
    /// What is actually sent, one request series each: the native string, its parts when it
    /// was too long, one term each (`terms`), or one empty harvest.
    pub chunks: Vec<String>,
    pub warnings: Vec<String>,
    pub length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<usize>,
    /// The results are filtered with the neutral query on Key's side.
    pub local_filter: bool,
    /// Derived template variables (dates, filters, `query.vars`).
    #[serde(skip)]
    pub vars: Vars,
    /// The user typed the native string (an override).
    #[serde(default)]
    pub overridden: bool,
    /// The queries in order, what Key checks afterwards and why (see `plan`).
    #[serde(default)]
    pub strategy: Strategy,
}

struct Render<'a> {
    spec: &'a QuerySpec,
    caps: &'a crate::spec::Capabilities,
    warnings: Vec<String>,
}

impl Render<'_> {
    fn warn(&mut self, text: String) {
        if !self.warnings.contains(&text) {
            self.warnings.push(text);
        }
    }

    fn escape(&self, text: &str) -> String {
        let mut out = text.trim().to_string();
        for r in &self.spec.escape {
            out = out.replace(&r.find, &r.with);
        }
        out
    }

    fn field_template(&mut self, field: &str) -> String {
        if let Some(t) = self.spec.fields.get(field) {
            return t.clone();
        }
        if let Some(t) = self.spec.fallback.get(field).and_then(|f| self.spec.fields.get(f)) {
            let to = self.spec.fallback[field].replace('_', "/");
            self.warn(format!("Field {} is searched as {to}", field.replace('_', "/")));
            return t.clone();
        }
        if field != self.spec.default_field {
            self.warn(format!("Field {} is not available; searched in {}", field.replace('_', "/"), self.spec.default_field.replace('_', "/")));
        }
        self.spec.fields.get(&self.spec.default_field).cloned().unwrap_or_else(|| "{q}".into())
    }

    fn fill(&self, t: &str, pairs: &[(&str, &str)]) -> String {
        let vars: Vars = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        template::render_lenient(t, &vars)
    }

    fn term(&mut self, term: &Term) -> String {
        let text = self.escape(&term.text);
        let words: Vec<&str> = text.split_whitespace().collect();
        let mut phrase = term.mode == "phrase" && words.len() > 1;
        if phrase && !self.caps.phrase {
            self.warn("Phrases are not supported; their words are searched together".into());
            phrase = false;
        }
        let mut truncate = term.truncate;
        if truncate && !self.caps.truncation {
            self.warn("Truncation (*) is not supported; searched as typed".into());
            truncate = false;
        }
        let truncated = |r: &Self, word: &str| if truncate { r.fill(&r.spec.truncate, &[("text", word)]) } else { word.to_string() };
        let last_truncated = |r: &Self, words: &[&str]| {
            let mut out: Vec<String> = words.iter().map(|w| w.to_string()).collect();
            if let Some(last) = out.last_mut() {
                *last = truncated(r, last);
            }
            out
        };
        if let Some(n) = term.proximity {
            match (&self.spec.proximity, self.caps.proximity) {
                (Some(crate::spec::Proximity::Template(t)), true) if words.len() > 1 => {
                    let joined = last_truncated(self, &words).join(" ");
                    return self.fill(&t.clone(), &[("text", &joined), ("n", &n.to_string()), ("field", &term.field)]);
                }
                (Some(crate::spec::Proximity::Join { word_join }), true) if words.len() > 1 => {
                    let op = self.fill(&word_join.clone(), &[("n", &n.to_string())]);
                    let joined = last_truncated(self, &words).join(&op);
                    let field = self.field_template(&term.field);
                    return self.fill(&field, &[("q", &joined)]);
                }
                _ if words.len() > 1 => {
                    self.warn("Proximity is not supported; searched as a phrase".into());
                    phrase = self.caps.phrase;
                }
                _ => {}
            }
        }
        let field = self.field_template(&term.field);
        if phrase {
            let joined = last_truncated(self, &words).join(" ");
            let q = self.fill(&self.spec.phrase, &[("text", &joined)]);
            return self.fill(&field, &[("q", &q)]);
        }
        let parts = last_truncated(self, &words);
        if self.spec.per_word_field && parts.len() > 1 {
            let items: Vec<String> = parts.iter().map(|w| self.fill(&field, &[("q", w)])).collect();
            return self.fill(&self.spec.group, &[("q", &items.join(&self.spec.and))]);
        }
        let q = self.fill(&self.spec.words, &[("text", &parts.join(&self.spec.word_join))]);
        self.fill(&field, &[("q", &q)])
    }

    /// A pushed tree in the service's syntax. Negated items only appear in AND groups that
    /// also have a positive item (the planner sees to that).
    fn node(&mut self, n: &Node, nested: bool) -> String {
        match n {
            Node::Term { term, .. } => self.term(term),
            Node::Group { op, items, .. } => {
                let positives: Vec<String> = items.iter().filter(|i| !i.is_not()).map(|i| self.node(i, true)).collect();
                let negatives: Vec<String> = items.iter().filter(|i| i.is_not()).map(|i| self.node(i, true)).collect();
                let join = if *op == Op::And { self.spec.and.clone() } else { self.spec.or.clone() };
                let mut out = positives.join(&join);
                if !negatives.is_empty() {
                    if positives.len() > 1 {
                        out = self.fill(&self.spec.group, &[("q", &out)]);
                    }
                    for neg in negatives {
                        out = format!("{out}{}{neg}", self.spec.not);
                    }
                }
                if (nested || *op == Op::Or) && items.len() > 1 { self.fill(&self.spec.group, &[("q", &out)]) } else { out }
            }
        }
    }
}

fn count_terms(tree: &Node) -> usize {
    tree.terms().iter().map(|t| t.text.split_whitespace().count().max(1)).sum()
}

/// The service's query for one connector. `options` are the connector's option values.
pub fn translate(spec: &Spec, query: &Query, options: &Vars) -> Translation {
    let query = query.cleaned();
    let q = &spec.query;
    let mut spec_q = q.clone();
    if q.lowercase_operators {
        spec_q.and = spec_q.and.to_lowercase();
        spec_q.or = spec_q.or.to_lowercase();
        spec_q.not = spec_q.not.to_lowercase();
    }
    let mut render = Render { spec: &spec_q, caps: &spec.capabilities, warnings: Vec::new() };
    let mut out = Translation { connector: spec.id.clone(), mode: q.mode.clone(), max_length: q.max_length, ..Default::default() };
    let filters = &query.filters;
    let mut vars = Vars::new();
    if let Some(y) = filters.year_from {
        vars.insert("yearFrom".into(), y.to_string());
    }
    if let Some(y) = filters.year_to {
        vars.insert("yearTo".into(), y.to_string());
    }
    for (k, v) in options {
        vars.insert(format!("opt.{k}"), v.clone());
    }
    let mut local = q.local_filter || q.mode != "native";
    let tree = query.tree();
    let logic = tree.nnf();
    if tree.is_empty() && q.mode != "harvest" {
        render.warn("The query has no terms".into());
    }
    // Neutral filters: into the native string, into a variable, or applied locally.
    let mut clauses: Vec<(String, String)> = Vec::new();
    let mut filter_values: Vec<(&str, Vec<String>)> = vec![("types", filters.types.clone()), ("languages", filters.languages.clone())];
    if filters.open_access == Some(true) {
        filter_values.push(("openAccess", vec!["true".into()]));
    }
    for (name, values) in filter_values {
        if values.is_empty() {
            continue;
        }
        match q.filters.get(name) {
            Some(f) => {
                let mapped: Vec<String> = values
                    .iter()
                    .filter_map(|v| {
                        if f.values.is_empty() {
                            return Some(v.clone());
                        }
                        let m = f.values.get(v).cloned();
                        if m.is_none() {
                            render.warn(format!("Filter {name} = {v} is not available here"));
                        }
                        m
                    })
                    .collect();
                if mapped.is_empty() {
                    continue;
                }
                let joined = mapped.join(&f.join);
                match &f.var {
                    Some(var) => {
                        vars.insert(var.clone(), template::render_lenient(&f.template, &[("v".to_string(), joined)].into_iter().collect()));
                    }
                    None => clauses.push((f.template.clone(), joined)),
                }
            }
            None => {
                local = true;
                render.warn(if spec.kind == "manual" { format!("Set the {name} filter on the site") } else { format!("Filter {name} is applied by Key to the results (the service cannot)") });
            }
        }
    }
    for (name, var) in &q.vars {
        if let Ok(Some(v)) = template::render(&var.template, &vars) {
            vars.insert(name.clone(), v);
        } else {
            vars.insert(name.clone(), var.otherwise.clone());
        }
    }
    let wrap = |native: String, render: &Render| -> String {
        let mut native = native;
        for (t, v) in &clauses {
            native = render.fill(t, &[("q", &native), ("v", v)]);
        }
        if filters.year_from.is_some() || filters.year_to.is_some() {
            if let Some(d) = q.dates.as_ref().and_then(|d| d.template.as_ref().map(|t| (d, t))) {
                let (dates, t) = d;
                let from = filters.year_from.map(|y| render.fill(dates.from.as_deref().unwrap_or("{yearFrom}"), &[("yearFrom", &y.to_string())])).unwrap_or_else(|| dates.open_from.clone().unwrap_or_else(|| "1000".into()));
                let to = filters.year_to.map(|y| render.fill(dates.to.as_deref().unwrap_or("{yearTo}"), &[("yearTo", &y.to_string())])).unwrap_or_else(|| dates.open_to.clone().unwrap_or_else(|| "3000".into()));
                native = render.fill(t, &[("q", &native), ("from", &from), ("to", &to)]);
            }
        }
        native
    };
    let dates_native = q.dates.as_ref().is_some_and(|d| d.template.is_some());
    let dates_var = spec_uses_year_vars(spec);
    if (filters.year_from.is_some() || filters.year_to.is_some()) && !dates_native && !dates_var {
        local = true;
        render.warn(if spec.kind == "manual" { "Set the years on the site".into() } else { "Years are filtered by Key on the results (the service cannot)".into() });
    }
    let original = boolean::format(&tree);
    if q.mode == "harvest" {
        out.chunks = vec![String::new()];
        out.native = String::new();
        if !tree.is_empty() {
            render.warn("This source is harvested; Key applies the query to every record it reads".into());
        }
        out.strategy = Strategy {
            original,
            kind: "harvest".into(),
            subqueries: vec![SubQueryInfo::default()],
            post_filter: true,
            steps: vec![format!("{} has no search: Key reads every record of the chosen scope and keeps those that match the full search", spec.name)],
            logic,
            ..Default::default()
        };
    } else {
        let (queries, mut strategy) = plan::plan(&logic, spec);
        strategy.original = original;
        let too_long = |text: &str, part: &Node| {
            q.max_length.is_some_and(|m| text.chars().count() > m) || q.max_terms.is_some_and(|m| count_terms(part) > m) || q.max_operators.is_some_and(|m| count_terms(part) > m + 1)
        };
        let mut infos: Vec<SubQueryInfo> = Vec::new();
        for sq in &queries {
            let native = wrap(render.node(&sq.tree, false), &render);
            let mut parts = vec![(native.clone(), sq.tree.clone())];
            if too_long(&native, &sq.tree) {
                if q.chunk == "or-split" {
                    match or_split(&sq.tree, &mut render, &wrap, &too_long, q.max_chunks) {
                        Some(split) => {
                            render.warn(format!("The query is too long for this service; it is sent in {} parts and the results are combined", split.len()));
                            parts = split;
                        }
                        None => render.warn("The query is too long for this service even when split".into()),
                    }
                } else {
                    render.warn("The query may be too long for this service".into());
                }
            }
            for (native, tree) in parts {
                // A part of a split OR implies the whole OR: what was checked stays checked.
                infos.push(SubQueryInfo { native, neutral: boolean::format(&tree), verified: sq.verified.clone(), exact: sq.exact });
            }
        }
        if infos.len() > queries.len() && strategy.kind == "single" {
            strategy.kind = "split".into();
            strategy.steps.insert(0, format!("The search is too long for {} in one go: it is sent in {} parts and the results are combined", spec.name, infos.len()));
        }
        if queries.len() > 1 || strategy.kind == "terms" {
            render.warn(match strategy.kind.as_str() {
                "terms" => "This source has no Boolean search; Key sends each term and applies the full query to the results".into(),
                _ => format!("Sent as {} queries; Key combines them and applies the full query to the results", infos.len()),
            });
        }
        if strategy.post_filter {
            local = true;
        }
        out.native = match infos.len() {
            0 => String::new(),
            1 => infos[0].native.clone(),
            _ if strategy.kind == "split" && queries.len() == 1 => wrap(render.node(&queries[0].tree, false), &render),
            _ => infos.iter().map(|i| i.native.as_str()).collect::<Vec<_>>().join(" | "),
        };
        out.chunks = infos.iter().map(|i| i.native.clone()).collect();
        for a in &strategy.approximate {
            render.warn(a.clone());
        }
        strategy.subqueries = infos;
        out.strategy = strategy;
    }
    out.length = out.native.chars().count();
    out.local_filter = local;
    out.vars = vars;
    out.warnings = render.warnings;
    out
}

/// Whether the plan's templates read yearFrom/yearTo (directly or through query.vars).
fn spec_uses_year_vars(spec: &Spec) -> bool {
    let mut templates: Vec<String> = Vec::new();
    for plan in [&spec.search, &spec.count].into_iter().flatten() {
        for p in plan.request.params.values().chain(plan.request.form.values()) {
            templates.extend(p.templates().into_iter().map(String::from));
        }
        if let Some(body) = &plan.request.body {
            templates.push(body.to_string());
        }
    }
    if let Some(manual) = &spec.manual {
        templates.push(manual.url.clone());
    }
    let vars_with_years: Vec<&String> = spec.query.vars.iter().filter(|(_, v)| v.template.contains("{year")).map(|(k, _)| k).collect();
    templates.iter().any(|t| t.contains("{yearFrom") || t.contains("{yearTo") || vars_with_years.iter().any(|v| t.contains(&format!("{{{v}"))))
}

/// Splits the largest OR group (the root, or a top-level AND part) into parts short enough.
fn or_split(tree: &Node, render: &mut Render, wrap: &dyn Fn(String, &Render) -> String, too_long: &dyn Fn(&str, &Node) -> bool, max_chunks: usize) -> Option<Vec<(String, Node)>> {
    let (at, alternatives): (Option<usize>, Vec<Node>) = match tree {
        Node::Group { op: Op::Or, items, .. } => (None, items.clone()),
        Node::Group { op: Op::And, items, .. } => {
            let (i, n) = items.iter().enumerate().filter_map(|(i, n)| match n {
                Node::Group { op: Op::Or, items, not: false, .. } => Some((i, items.len())),
                _ => None,
            }).max_by_key(|(_, n)| *n)?;
            let _ = n;
            let Node::Group { items: inner, .. } = &items[i] else { return None };
            (Some(i), inner.clone())
        }
        _ => return None,
    };
    let n = alternatives.len();
    for parts in 2..=n.min(max_chunks.max(2)) {
        let size = n.div_ceil(parts);
        let mut chunks = Vec::new();
        let mut ok = true;
        for group in alternatives.chunks(size) {
            let or = if group.len() == 1 { group[0].clone() } else { Node::group(Op::Or, group.to_vec()) };
            let part = match (at, tree) {
                (Some(i), Node::Group { items, .. }) => {
                    let mut items = items.clone();
                    items[i] = or;
                    Node::group(Op::And, items)
                }
                _ => or,
            };
            let text = wrap(render.node(&part, false), render);
            if too_long(&text, &part) {
                ok = false;
                break;
            }
            chunks.push((text, part));
        }
        if ok {
            return Some(chunks);
        }
    }
    None
}

// ── Local evaluation ──

pub fn fold(text: &str) -> String {
    text.nfkd().filter(|c| !is_combining_mark(*c)).flat_map(char::to_lowercase).collect()
}

fn tokens(text: &str) -> Vec<String> {
    fold(text).split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).map(String::from).collect()
}

fn field_text(record: &Record, field: &str) -> String {
    let abstract_ = record.abstract_.clone().unwrap_or_default();
    match field {
        "title" => record.title.clone(),
        "title_abstract" => format!("{} {}", record.title, abstract_),
        "abstract" => abstract_,
        "keywords" | "subject" => record.keywords.join(" ; "),
        "author" => record.authors.join(" ; "),
        "journal" => format!("{} {}", record.venue.clone().unwrap_or_default(), record.series.clone().unwrap_or_default()),
        _ => format!(
            "{} {} {} {} {} {}",
            record.title,
            abstract_,
            record.keywords.join(" "),
            record.authors.join(" "),
            record.venue.clone().unwrap_or_default(),
            record.series.clone().unwrap_or_default()
        ),
    }
}

fn word_matches(have: &str, want: &str, prefix: bool) -> bool {
    if prefix { have.starts_with(want) } else { have == want }
}

pub fn term_matches(term: &Term, record: &Record) -> bool {
    let have = tokens(&field_text(record, &term.field));
    let mut want = tokens(&term.text.replace('*', " "));
    let trailing_star = term.text.trim_end().ends_with('*');
    if want.is_empty() {
        return false;
    }
    let truncate = term.truncate || trailing_star;
    let last = want.len() - 1;
    let matches_at = |i: usize, j: usize, want: &[String]| word_matches(&have[i], &want[j], truncate && j == last);
    if let Some(n) = term.proximity.filter(|_| want.len() > 1) {
        // Every word within a window of n words around the first.
        let window = n as usize + want.len();
        return (0..have.len()).any(|start| {
            let end = (start + window).min(have.len());
            (0..want.len()).all(|j| (start..end).any(|i| matches_at(i, j, &want)))
        });
    }
    if term.mode == "phrase" && want.len() > 1 {
        return have.len() >= want.len() && (0..=have.len() - want.len()).any(|i| (0..want.len()).all(|j| matches_at(i + j, j, &want)));
    }
    want.dedup();
    let last = want.len() - 1;
    (0..want.len()).all(|j| (0..have.len()).any(|i| word_matches(&have[i], &want[j], truncate && j == last)))
}

/// Whether the record meets the query (and the year, type and language filters).
pub fn matches(query: &Query, record: &Record) -> bool {
    let tree = query.tree();
    (tree.is_empty() || boolean::eval(&tree, record, &|_| false) == Truth::True) && passes_filters(&query.filters, record)
}

pub fn passes_filters(filters: &Filters, record: &Record) -> bool {
    if let Some(year) = record.year {
        if filters.year_from.is_some_and(|f| year < f) || filters.year_to.is_some_and(|t| year > t) {
            return false;
        }
    }
    if !filters.types.is_empty() {
        if let Some(kind) = &record.kind {
            if !filters.types.iter().any(|t| t.eq_ignore_ascii_case(kind)) {
                return false;
            }
        }
    }
    if !filters.languages.is_empty() {
        if let Some(language) = &record.language {
            if !filters.languages.iter().any(|l| l.eq_ignore_ascii_case(language)) {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(query: serde_json::Value, caps: serde_json::Value) -> Spec {
        serde_json::from_value(serde_json::json!({
            "format": 1, "id": "t", "version": "1.0.0", "name": "T", "kind": "manual",
            "manual": {"url": "https://example.org/?q={query}"}, "capabilities": caps, "query": query
        }))
        .unwrap()
    }

    fn q(json: serde_json::Value) -> Query {
        serde_json::from_value(json).unwrap()
    }

    fn pubmed() -> Spec {
        spec(
            serde_json::json!({
                "fields": {"all": "{q}[all]", "title": "{q}[ti]", "title_abstract": "{q}[tiab]", "subject": "{q}[mh]"},
                "fallback": {"keywords": "title_abstract"},
                "proximity": "\"{text}\"[tiab:~{n}]",
                "dates": {"template": "{q} AND ({from}:{to}[dp])", "openFrom": "1800", "openTo": "3000"},
                "filters": {"types": {"template": "{q} AND ({v})", "values": {"review": "review[pt]"}}},
                "maxLength": 80, "chunk": "or-split"
            }),
            serde_json::json!({"fields": ["all", "title", "title_abstract", "subject"], "phrase": true, "truncation": true, "proximity": true, "dates": "year"}),
        )
    }

    #[test]
    fn translates_concepts_fields_phrases_truncation_dates_and_filters() {
        let query = q(serde_json::json!({
            "concepts": [
                {"terms": [{"text": "vaccine hesitancy", "mode": "phrase", "field": "title_abstract"}, {"text": "vaccin", "truncate": true, "field": "title"}]},
                {"terms": [{"text": "Health Personnel", "field": "subject", "mode": "phrase"}]}
            ],
            "exclude": [{"text": "mice", "field": "keywords"}],
            "filters": {"yearFrom": 2020, "types": ["review"]}
        }));
        let mut s = pubmed();
        s.query.max_length = None;
        let t = translate(&s, &query, &Vars::new());
        // The test spec cannot search keywords: the NOT is applied by Key afterwards.
        assert_eq!(t.native, "(\"vaccine hesitancy\"[tiab] OR vaccin*[ti]) AND \"Health Personnel\"[mh] AND (review[pt]) AND (2020:3000[dp])");
        assert!(t.strategy.steps.iter().any(|w| w.contains("NOT keywords:mice")), "{:?}", t.strategy);
        assert!(t.local_filter && t.strategy.post_filter);
        assert_eq!(t.strategy.subqueries[0].verified, vec!["r.0", "r.1"]);
        let exact = translate(&s, &q(serde_json::json!({"expr": {"type": "group", "op": "and", "items": [
            {"type": "group", "op": "or", "items": [{"type": "term", "text": "health"}, {"type": "term", "text": "doctor"}]},
            {"type": "group", "op": "or", "items": [{"type": "term", "text": "ai"}, {"type": "term", "text": "ml"}]},
            {"type": "term", "text": "regression", "field": "title", "not": true}
        ]}})), &Vars::new());
        assert_eq!(exact.native, "((health[all] OR doctor[all]) AND (ai[all] OR ml[all])) NOT regression[ti]");
        assert!(!exact.local_filter);
    }

    #[test]
    fn proximity_and_unsupported_features_warn() {
        let t = translate(&pubmed(), &q(serde_json::json!({"concepts": [{"terms": [{"text": "hand washing", "proximity": 3, "field": "title_abstract"}]}]})), &Vars::new());
        assert_eq!(t.native, "\"hand washing\"[tiab:~3]");
        let plain = spec(serde_json::json!({"fields": {"all": "{q}"}}), serde_json::json!({}));
        let t = translate(&plain, &q(serde_json::json!({"concepts": [{"terms": [{"text": "school meals", "mode": "phrase", "truncate": true, "field": "title"}]}], "filters": {"yearFrom": 2001}})), &Vars::new());
        assert_eq!(t.native, "school meals");
        assert!(t.local_filter);
        assert!(t.strategy.approximate.iter().any(|a| a.contains("truncation")), "{:?}", t.strategy);
        assert!(t.strategy.steps.iter().any(|a| a.contains("phrase")), "{:?}", t.strategy);
        assert!(t.warnings.iter().any(|w| w.contains("years")), "{:?}", t.warnings);
    }

    #[test]
    fn long_queries_are_split_on_the_largest_or_group() {
        let terms: Vec<serde_json::Value> = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].iter().map(|w| serde_json::json!({"text": w, "field": "title"})).collect();
        let t = translate(&pubmed(), &q(serde_json::json!({"concepts": [{"terms": terms}, {"terms": [{"text": "trial", "field": "title"}]}]})), &Vars::new());
        assert!(t.chunks.len() >= 2, "{:?}", t.chunks);
        assert!(t.chunks.iter().all(|c| c.chars().count() <= 80 && c.contains("trial[ti]")));
    }

    #[test]
    fn local_matching_folds_case_and_diacritics() {
        let record = Record { title: "Vaccine hesitancy among health workers in São Paulo".into(), abstract_: Some("We surveyed nurses about vaccines.".into()), year: Some(2021), ..Default::default() };
        let m = |j| matches(&q(j), &record);
        assert!(m(serde_json::json!({"concepts": [{"terms": [{"text": "vaccine hesitancy", "mode": "phrase", "field": "title"}]}, {"terms": [{"text": "sao paulo", "mode": "phrase"}]}]})));
        assert!(m(serde_json::json!({"concepts": [{"terms": [{"text": "nurs", "truncate": true, "field": "title_abstract"}]}]})));
        assert!(!m(serde_json::json!({"concepts": [{"terms": [{"text": "nurs", "field": "title_abstract"}]}]})));
        assert!(m(serde_json::json!({"concepts": [{"terms": [{"text": "hesitancy workers", "proximity": 3, "field": "title"}]}]})));
        assert!(!m(serde_json::json!({"concepts": [{"terms": [{"text": "vaccine"}]}], "exclude": [{"text": "nurses"}]})));
        assert!(!m(serde_json::json!({"concepts": [{"terms": [{"text": "vaccine"}]}], "filters": {"yearFrom": 2022}})));
    }
}
