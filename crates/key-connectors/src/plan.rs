// Capability-aware planning: which queries a service is sent for a Boolean tree, and how Key
// reconstructs the exact result from them.
//
// Everything the service can do is pushed down. What it cannot do is relaxed to a superset it
// can answer (a phrase becomes its words, an unsupported field a broader one, a NOT or a
// year/type scope is dropped), the tree is split into one query per conjunct (disjunctive
// normal form) when the service has no OR or no nesting, or into one query per term of the
// narrowest concept when it has no AND. Key then evaluates the full original tree on every
// returned record, counting as true the parts the service already checked for the query that
// returned it, and de-duplicates across the queries. Only fields the service returns can be
// checked: such limits make the plan "approximate", with the reason.
use crate::boolean::{self, Node, Op};
use crate::query::Term;
use crate::spec::Spec;
use serde::{Deserialize, Serialize};

/// What a service's query language can combine (spec `capabilities.boolean`).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoolCaps {
    #[serde(default = "yes")]
    pub and: bool,
    #[serde(default = "yes")]
    pub or: bool,
    #[serde(default = "yes")]
    pub not: bool,
    /// How deep brackets may go: 1 = one flat group ("a AND b AND c"), 2 = "(a OR b) AND c".
    #[serde(default = "deep")]
    pub nesting: usize,
}

fn yes() -> bool {
    true
}
fn deep() -> usize {
    8
}

impl BoolCaps {
    pub const FULL: BoolCaps = BoolCaps { and: true, or: true, not: true, nesting: 8 };
    pub const NONE: BoolCaps = BoolCaps { and: false, or: false, not: false, nesting: 0 };
}

impl Default for BoolCaps {
    fn default() -> Self {
        Self::FULL
    }
}

/// The spec's declaration, or what its query mode implies.
pub fn caps_of(spec: &Spec) -> BoolCaps {
    spec.capabilities.boolean.unwrap_or(match spec.query.mode.as_str() {
        "native" => BoolCaps::FULL,
        _ => BoolCaps::NONE,
    })
}

/// One query sent to the service, still in neutral form (rendered by `query::translate`).
#[derive(Clone, Debug)]
pub struct SubQuery {
    pub tree: Node,
    /// Paths of the original tree's parts the service checks exactly with this query.
    pub verified: Vec<String>,
    pub exact: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// tooMany | tooBroad | nothing
    pub kind: String,
    pub message: String,
    pub queries: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SubQueryInfo {
    pub native: String,
    /// The same query in Key's text syntax.
    pub neutral: String,
    pub verified: Vec<String>,
    pub exact: bool,
}

/// How a search is run on one service, for the preview and the exported strategy.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Strategy {
    /// The full search in Key's text syntax.
    pub original: String,
    /// single | split | terms | harvest | typed
    pub kind: String,
    pub subqueries: Vec<SubQueryInfo>,
    /// Key evaluates the full search on the returned records.
    pub post_filter: bool,
    /// Records whose missing fields leave a part undecided are kept (and counted).
    pub keep_unknown: bool,
    /// How the result is reconstructed, in plain words, in order.
    pub steps: Vec<String>,
    /// Why the result may differ from running the full search on the service itself.
    pub approximate: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<Decision>,
    /// The tree Key evaluates (negations moved onto terms); paths in `verified` refer to it.
    pub logic: Node,
}

#[derive(Clone, Debug)]
struct Pushed {
    node: Node,
    exact: bool,
    path: String,
    parts: Vec<Pushed>,
}

enum R {
    True,
    N(Pushed),
}

struct Ctx<'a> {
    spec: &'a Spec,
    caps: BoolCaps,
    /// Second pass when nothing could be pushed as a superset: push the closest thing.
    narrow: bool,
    steps: Vec<String>,
    approximate: Vec<String>,
}

fn push_unique(list: &mut Vec<String>, text: String) {
    if !list.contains(&text) {
        list.push(text);
    }
}

fn broader(field: &str) -> &'static [&'static str] {
    match field {
        "title" | "abstract" => &["title_abstract", "all"],
        "all" => &[],
        _ => &["all"],
    }
}

fn label(term: &Term) -> String {
    boolean::format_term(term)
}

impl Ctx<'_> {
    fn has_field(&self, f: &str) -> bool {
        self.spec.query.fields.contains_key(f)
    }

    /// The term as the service can search it: (term, exact), or None when it cannot at all.
    fn push_term(&mut self, term: &Term) -> Option<(Term, bool)> {
        let name = self.spec.name.clone();
        if matches!(term.field.as_str(), "year" | "type" | "language") && !self.has_field(&term.field) {
            push_unique(&mut self.steps, format!("{} is checked by Key on the records ({name} cannot search it inside a query)", label(term)));
            return None;
        }
        let mut out = term.clone();
        let mut exact = true;
        if !self.has_field(&term.field) {
            match broader(&term.field).iter().find(|f| self.has_field(f)) {
                Some(f) => {
                    out.field = f.to_string();
                    exact = false;
                    push_unique(&mut self.steps, format!("{} is searched in {} on {name}; Key keeps the records where it is in the {}", label(term), boolean::field_label(f).to_lowercase(), boolean::field_label(&term.field).to_lowercase()));
                }
                None if self.narrow => {
                    exact = false;
                    push_unique(&mut self.approximate, format!("{name} cannot search {}; it is searched in {} only", boolean::field_label(&term.field).to_lowercase(), boolean::field_label(&self.spec.query.default_field).to_lowercase()));
                }
                None => {
                    push_unique(&mut self.steps, format!("{} is left out of the query sent to {name} ({} cannot be searched there) and checked by Key", label(term), boolean::field_label(&term.field).to_lowercase()));
                    return None;
                }
            }
        }
        let caps = &self.spec.capabilities;
        let words = term.text.split_whitespace().count();
        if term.proximity.is_some() && words > 1 && !(caps.proximity && self.spec.query.proximity.is_some()) {
            out.proximity = None;
            out.mode = "words".into();
            exact = false;
            push_unique(&mut self.steps, format!("{name} has no proximity search: all words of {} are searched, and Key checks how close they are", label(term)));
        } else if term.mode == "phrase" && words > 1 && !caps.phrase {
            out.mode = "words".into();
            exact = false;
            push_unique(&mut self.steps, format!("{name} has no phrase search: the words of {} are searched, and Key checks the exact phrase", label(term)));
        }
        if term.truncate && !caps.truncation {
            if !self.narrow {
                push_unique(&mut self.steps, format!("{name} has no truncation: {} is left out of the query and checked by Key", label(term)));
                return None;
            }
            out.truncate = false;
            exact = false;
            push_unique(&mut self.approximate, format!("{name} has no truncation: {} is searched as the word \"{}\" only", label(term), term.text));
        }
        Some((out, exact))
    }

    fn sup(&mut self, n: &Node, path: &str) -> R {
        match n {
            Node::Term { term, not: false } => match self.push_term(term) {
                Some((t, exact)) => R::N(Pushed { node: Node::term(t), exact, path: path.into(), parts: Vec::new() }),
                None => R::True,
            },
            Node::Term { term, not: true } => {
                if !self.caps.not {
                    push_unique(&mut self.steps, format!("{} has no NOT: NOT {} is left out of the query and applied by Key", self.spec.name, label(term)));
                    return R::True;
                }
                let was = self.narrow;
                self.narrow = false;
                let (steps, approx) = (self.steps.len(), self.approximate.len());
                let pushed = self.push_term(term);
                self.steps.truncate(steps);
                self.approximate.truncate(approx);
                self.narrow = was;
                match pushed {
                    // Leaving out more than asked would be wrong: only an exact NOT is sent.
                    Some((t, true)) => R::N(Pushed { node: Node::term(t).negated(true), exact: true, path: path.into(), parts: Vec::new() }),
                    _ => {
                        push_unique(&mut self.steps, format!("NOT {} is left out of the query sent to {} and applied by Key", label(term), self.spec.name));
                        R::True
                    }
                }
            }
            Node::Group { op, items, .. } => {
                let mut parts = Vec::new();
                let mut dropped = false;
                for (i, item) in items.iter().enumerate() {
                    match self.sup(item, &format!("{path}.{i}")) {
                        R::True => {
                            dropped = true;
                            if *op == Op::Or {
                                return R::True;
                            }
                        }
                        R::N(p) => {
                            if *op == Op::Or && p.node.is_not() {
                                push_unique(&mut self.steps, format!("\"OR NOT\" cannot be sent to {}; that group is applied by Key", self.spec.name));
                                return R::True;
                            }
                            parts.push(p);
                        }
                    }
                }
                if !parts.iter().any(|p| !p.node.is_not()) {
                    if !parts.is_empty() {
                        push_unique(&mut self.steps, format!("A group with only NOT parts cannot be sent to {}; it is applied by Key", self.spec.name));
                    }
                    return R::True;
                }
                if parts.len() == 1 {
                    let mut only = parts.pop().unwrap();
                    only.exact = only.exact && !dropped;
                    if dropped {
                        // The one part left stands for the group only as a superset.
                        return R::N(Pushed { node: only.node.clone(), exact: false, path: path.into(), parts: vec![only] });
                    }
                    return R::N(only);
                }
                let exact = !dropped && parts.iter().all(|p| p.exact);
                R::N(Pushed { node: Node::group(*op, parts.iter().map(|p| p.node.clone()).collect()), exact, path: path.into(), parts })
            }
        }
    }
}

/// The paths a query checks exactly: the query itself when exact, else its exact top-level
/// AND parts.
fn verified_of(p: &Pushed) -> Vec<String> {
    if p.exact {
        return vec![p.path.clone()];
    }
    if p.parts.len() == 1 {
        return verified_of(&p.parts[0]);
    }
    if matches!(p.node, Node::Group { op: Op::And, .. }) { p.parts.iter().flat_map(verified_of).collect() } else { Vec::new() }
}

/// Literals of one conjunct of the disjunctive normal form.
type Conj = Vec<Pushed>;

fn dnf_count(p: &Pushed) -> usize {
    match &p.node {
        Node::Term { .. } => 1,
        Node::Group { op: Op::And, .. } => p.parts.iter().map(dnf_count).fold(1usize, |a, b| a.saturating_mul(b)),
        Node::Group { op: Op::Or, .. } => p.parts.iter().map(dnf_count).fold(0usize, |a, b| a.saturating_add(b)),
    }
}

fn dnf(p: &Pushed) -> Vec<Conj> {
    match &p.node {
        Node::Term { .. } if p.parts.len() == 1 => dnf(&p.parts[0]),
        Node::Term { .. } => vec![vec![p.clone()]],
        Node::Group { op: Op::Or, .. } => p.parts.iter().flat_map(dnf).collect(),
        Node::Group { op: Op::And, .. } => {
            let mut out: Vec<Conj> = vec![Vec::new()];
            for part in &p.parts {
                let options = dnf(part);
                out = out.iter().flat_map(|c| options.iter().map(move |o| c.iter().chain(o.iter()).cloned().collect())).collect();
            }
            out
        }
    }
}

/// Conjunctive normal form clauses (only computed while small).
fn cnf(p: &Pushed, cap: usize) -> Option<Vec<Conj>> {
    match &p.node {
        Node::Term { .. } if p.parts.len() == 1 => cnf(&p.parts[0], cap),
        Node::Term { .. } => Some(vec![vec![p.clone()]]),
        Node::Group { op: Op::And, .. } => {
            let mut out = Vec::new();
            for part in &p.parts {
                out.extend(cnf(part, cap)?);
            }
            Some(out)
        }
        Node::Group { op: Op::Or, .. } => {
            let mut out: Vec<Conj> = vec![Vec::new()];
            for part in &p.parts {
                let clauses = cnf(part, cap)?;
                out = out.iter().flat_map(|c| clauses.iter().map(move |o| c.iter().chain(o.iter()).cloned().collect())).collect();
                if out.len() > cap {
                    return None;
                }
            }
            Some(out)
        }
    }
}

/// Replaces the OR group that multiplies the number of conjuncts most by "anything" (a
/// superset), returning false when there is none left to drop.
fn drop_biggest_or(p: &mut Pushed) -> bool {
    fn candidates(p: &Pushed, at: Vec<usize>, out: &mut Vec<(usize, Vec<usize>)>, parent_and: bool) {
        if parent_and && matches!(p.node, Node::Group { op: Op::Or, .. }) {
            out.push((dnf_count(p), at.clone()));
        }
        let is_and = matches!(p.node, Node::Group { op: Op::And, .. });
        for (i, part) in p.parts.iter().enumerate() {
            let mut next = at.clone();
            next.push(i);
            candidates(part, next, out, is_and);
        }
    }
    let mut found = Vec::new();
    candidates(p, Vec::new(), &mut found, false);
    let Some((_, at)) = found.into_iter().max_by_key(|(n, _)| *n) else { return false };
    fn remove(p: &mut Pushed, at: &[usize]) {
        if at.len() == 1 {
            p.parts.remove(at[0]);
        } else {
            remove(&mut p.parts[at[0]], &at[1..]);
        }
        p.exact = false;
        if p.parts.len() == 1 {
            let only = p.parts.pop().unwrap();
            *p = Pushed { exact: false, ..only };
        } else if let Node::Group { op, .. } = p.node {
            p.node = Node::group(op, p.parts.iter().map(|x| x.node.clone()).collect());
        }
    }
    remove(p, &at);
    true
}

fn conj_query(c: &Conj) -> SubQuery {
    let tree = if c.len() == 1 { c[0].node.clone() } else { Node::group(Op::And, c.iter().map(|l| l.node.clone()).collect()) };
    SubQuery { tree, verified: c.iter().filter(|l| l.exact).map(|l| l.path.clone()).collect(), exact: c.iter().all(|l| l.exact) }
}

/// The plan for one service: the queries and the strategy around them (`subqueries` is
/// filled in by the translation, which renders the native strings).
pub fn plan(logic: &Node, spec: &Spec) -> (Vec<SubQuery>, Strategy) {
    let caps = caps_of(spec);
    let max = spec.query.max_chunks.max(1);
    let mut strategy = Strategy { logic: logic.clone(), keep_unknown: spec.query.mode == "native", ..Default::default() };
    let mut ctx = Ctx { spec, caps, narrow: false, steps: Vec::new(), approximate: Vec::new() };
    let top = |r: R| match r {
        R::N(p) if !p.node.is_not() => Some(p),
        _ => None,
    };
    let mut pushed = top(ctx.sup(logic, "r"));
    if pushed.is_none() && !logic.is_empty() {
        ctx.narrow = true;
        ctx.steps.clear();
        pushed = top(ctx.sup(logic, "r"));
    }
    let name = spec.name.clone();
    let mut queries: Vec<SubQuery> = Vec::new();
    let mut whole_exact = false;
    match pushed {
        None => {
            strategy.kind = "single".into();
            if !logic.is_empty() {
                strategy.decision = Some(Decision { kind: "nothing".into(), message: format!("None of this search can be sent to {name}: it would return everything. Add a term {name} can search, or leave {name} out."), queries: 0 });
            }
        }
        Some(mut p) => {
            let depth = p.node.depth();
            if caps.and && caps.or && depth <= caps.nesting.max(1) || (depth == 0) || (depth == 1 && single_op_ok(&p.node, caps)) {
                strategy.kind = "single".into();
                whole_exact = p.exact;
                queries.push(SubQuery { tree: p.node.clone(), verified: verified_of(&p), exact: p.exact });
            } else if caps.and {
                strategy.kind = "split".into();
                let mut relaxed = false;
                while dnf_count(&p) > max {
                    if !drop_biggest_or(&mut p) {
                        break;
                    }
                    relaxed = true;
                }
                if relaxed {
                    push_unique(&mut ctx.steps, format!("To stay within {max} queries, the largest OR groups are left out of what is sent to {name} and checked by Key"));
                }
                let conjs = dnf(&p);
                whole_exact = p.exact && !relaxed;
                let n = conjs.len();
                if caps.or && conjs.iter().all(|c| c.len() == 1 && !c[0].node.is_not()) {
                    // One flat OR query.
                    let exact = conjs.iter().all(|c| c[0].exact);
                    queries.push(SubQuery { tree: Node::group(Op::Or, conjs.iter().map(|c| c[0].node.clone()).collect()), verified: if exact && whole_exact { vec!["r".into()] } else { Vec::new() }, exact });
                    strategy.kind = "single".into();
                } else {
                    queries.extend(conjs.iter().map(conj_query));
                    ctx.steps.insert(0, format!("{name} cannot combine AND and OR in one query: the search is split into {n} queries (one per combination of alternatives), run one after the other"));
                    if n > max {
                        strategy.decision = Some(Decision { kind: "tooMany".into(), message: format!("{name} would need {n} separate queries for this search. Run them anyway, or simplify the search for {name}."), queries: n });
                    }
                }
            } else {
                strategy.kind = "terms".into();
                // No AND: every match contains one term of each concept, so the terms of the
                // narrowest concept are sent and Key checks the rest.
                let clauses = cnf(&p, 200).unwrap_or_default();
                let best = clauses.iter().filter(|c| c.iter().all(|l| !l.node.is_not())).min_by_key(|c| (c.len(), c.iter().map(|l| usize::MAX - l.node.terms().iter().map(|t| t.text.len()).sum::<usize>()).min().unwrap_or(0)));
                match best {
                    Some(clause) => {
                        let single_or = clauses.len() == 1;
                        whole_exact = single_or && p.exact;
                        if caps.or && clause.len() > 1 {
                            queries.push(SubQuery { tree: Node::group(Op::Or, clause.iter().map(|l| l.node.clone()).collect()), verified: if whole_exact { vec!["r".into()] } else { Vec::new() }, exact: whole_exact });
                        } else {
                            queries.extend(clause.iter().map(|l| SubQuery { tree: l.node.clone(), verified: if l.exact { vec![l.path.clone()] } else { Vec::new() }, exact: l.exact }));
                        }
                        let words: Vec<String> = clause.iter().map(|l| boolean::format(&l.node)).collect();
                        ctx.steps.insert(0, format!("{name} searches one term at a time: Key sends {} ({}), the narrowest part every match must contain", if queries.len() == 1 { "one query".to_string() } else { format!("{} queries", queries.len()) }, words.join(", ")));
                        if queries.len() > max {
                            strategy.decision = Some(Decision { kind: "tooMany".into(), message: format!("{name} would need {} separate queries for this search. Run them anyway, or simplify the search for {name}.", queries.len()), queries: queries.len() });
                        }
                    }
                    None => {
                        strategy.decision = Some(Decision { kind: "nothing".into(), message: format!("This search cannot be sent to {name} one term at a time."), queries: 0 });
                    }
                }
            }
        }
    }
    strategy.post_filter = !whole_exact || spec.query.mode != "native";
    if strategy.post_filter && !queries.is_empty() {
        if queries.len() > 1 {
            ctx.steps.push("Records found by more than one query are kept once".into());
        }
        ctx.steps.push(format!("Key keeps only the records that match the full search: {}", boolean::format(logic)));
        // What Key cannot check.
        let returns = |f: &str| spec.capabilities.export_fields.iter().any(|x| x == f);
        for (path, node) in boolean::paths(logic) {
            let Node::Term { term, .. } = node else { continue };
            if queries.iter().all(|q| q.verified.iter().any(|v| path == *v || path.starts_with(&format!("{v}.")))) {
                continue;
            }
            let missing = match term.field.as_str() {
                "abstract" if !returns("abstract") => Some("abstracts"),
                "title_abstract" | "all" if !returns("abstract") => Some("abstracts (only titles can be checked)"),
                "keywords" | "subject" if !returns("keywords") => Some("keywords or subject headings"),
                "subject" => Some("its subject headings as such (Key checks the keywords it returns)"),
                "author" if !returns("authors") => Some("authors"),
                "journal" if !returns("venue") => Some("journal names"),
                "affiliation" => Some("affiliations"),
                "fulltext" => Some("full texts"),
                "language" if !returns("language") => Some("languages"),
                "type" if !returns("type") => Some("document types"),
                _ => None,
            };
            if let Some(m) = missing {
                push_unique(&mut ctx.approximate, format!("{} cannot be checked exactly: {name} does not return {m}", label(term)));
            }
        }
        if spec.query.mode == "native" {
            push_unique(&mut ctx.steps, format!("Key matches words as written (case and accents ignored); {name}'s own word stemming is not repeated"));
        }
    }
    strategy.steps = ctx.steps;
    strategy.approximate = ctx.approximate;
    (queries, strategy)
}

fn single_op_ok(n: &Node, caps: BoolCaps) -> bool {
    match n {
        Node::Group { op: Op::And, items, .. } => caps.and && (caps.not || !items.iter().any(Node::is_not)),
        Node::Group { op: Op::Or, .. } => caps.or,
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boolean::{Truth, eval, parse};
    use crate::record::Record;
    use std::collections::BTreeSet;

    fn spec(fields: &[&str], caps: serde_json::Value, boolean: Option<serde_json::Value>, exports: &[&str]) -> Spec {
        let mut c = caps;
        if let Some(b) = boolean {
            c["boolean"] = b;
        }
        c["exportFields"] = serde_json::json!(exports);
        let f: serde_json::Map<String, serde_json::Value> = fields.iter().map(|f| (f.to_string(), serde_json::json!(format!("{{q}}[{f}]")))).collect();
        serde_json::from_value(serde_json::json!({
            "format": 1, "id": "t", "version": "1.0.0", "name": "T", "kind": "manual",
            "manual": {"url": "https://example.org/?q={query}"}, "capabilities": c, "query": {"fields": f, "maxChunks": 64}
        }))
        .unwrap()
    }

    const ALL_EXPORTS: &[&str] = &["title", "abstract", "keywords", "authors", "venue", "type", "language"];

    fn profiles() -> Vec<(&'static str, Spec)> {
        let full_caps = serde_json::json!({"phrase": true, "truncation": true, "proximity": false});
        let fields = ["all", "title", "abstract", "title_abstract", "keywords", "author"];
        vec![
            ("full", spec(&fields, full_caps.clone(), None, ALL_EXPORTS)),
            ("and-only", spec(&fields, full_caps.clone(), Some(serde_json::json!({"or": false, "nesting": 1})), ALL_EXPORTS)),
            ("flat", spec(&fields, full_caps.clone(), Some(serde_json::json!({"nesting": 1})), ALL_EXPORTS)),
            ("no-not", spec(&fields, full_caps.clone(), Some(serde_json::json!({"not": false})), ALL_EXPORTS)),
            ("single-term", spec(&fields, serde_json::json!({"phrase": false, "truncation": false}), Some(serde_json::json!({"and": false, "or": false, "not": false})), ALL_EXPORTS)),
            ("no-fields", spec(&["all"], serde_json::json!({"phrase": true}), Some(serde_json::json!({"nesting": 1, "or": false})), ALL_EXPORTS)),
        ]
    }

    /// A tiny deterministic random source.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
            &xs[(self.next() % xs.len() as u64) as usize]
        }
    }

    const WORDS: &[&str] = &["health", "doctor", "nurse", "learning", "model", "regression", "school", "meals", "trial", "survey"];

    fn random_tree(r: &mut Rng, depth: usize) -> Node {
        if depth == 0 || r.next() % 3 == 0 {
            let field = *r.pick(&["all", "title", "abstract", "title_abstract", "keywords", "author", "year"]);
            let mut t = Term { field: field.into(), ..Default::default() };
            if field == "year" {
                t.text = format!("{}-{}", 2015 + r.next() % 5, 2019 + r.next() % 5);
            } else if r.next() % 4 == 0 {
                t.text = format!("{} {}", r.pick(WORDS), r.pick(WORDS));
                t.mode = "phrase".into();
            } else {
                let w = *r.pick(WORDS);
                if r.next() % 5 == 0 {
                    t.text = w[..3].to_string();
                    t.truncate = true;
                } else {
                    t.text = w.into();
                }
            }
            return Node::term(t).negated(r.next() % 6 == 0);
        }
        let n = 2 + (r.next() % 3) as usize;
        let op = if r.next() % 2 == 0 { Op::And } else { Op::Or };
        Node::group(op, (0..n).map(|_| random_tree(r, depth - 1)).collect()).negated(r.next() % 8 == 0)
    }

    fn corpus(r: &mut Rng) -> Vec<Record> {
        (0..120)
            .map(|i| {
                let mut words = |n: usize| (0..n).map(|_| *r.pick(WORDS)).collect::<Vec<_>>().join(" ");
                Record {
                    source_id: format!("r{i}"),
                    title: words(4),
                    abstract_: Some(words(12)),
                    keywords: vec![words(1), words(1)],
                    authors: vec![format!("{}, A.", words(1))],
                    year: Some(2014 + (i % 11) as i64),
                    ..Default::default()
                }
            })
            .collect()
    }

    /// What a service with these capabilities returns for a pushed query: the records that
    /// match it (the simulated service searches the same fields Key checks).
    fn service(q: &Node, records: &[Record]) -> Vec<Record> {
        records.iter().filter(|rec| eval(q, rec, &|_| false) == Truth::True).cloned().collect()
    }

    fn run(logic: &Node, spec: &Spec, records: &[Record]) -> (BTreeSet<String>, Strategy) {
        let (queries, strategy) = plan(logic, spec);
        let mut kept = BTreeSet::new();
        for q in &queries {
            for rec in service(&q.tree, records) {
                if kept.contains(&rec.source_id) {
                    continue;
                }
                let truth = if strategy.post_filter { eval(logic, &rec, &|p| q.verified.iter().any(|v| v == p)) } else { Truth::True };
                if truth == Truth::True || (truth == Truth::Unknown && strategy.keep_unknown) {
                    kept.insert(rec.source_id.clone());
                }
            }
        }
        (kept, strategy)
    }

    #[test]
    fn decomposed_plans_reconstruct_the_direct_result() {
        let mut r = Rng(0x9e37_79b9_7f4a_7c15);
        let records = corpus(&mut r);
        let mut checked = 0;
        for round in 0..400 {
            let Some(tree) = random_tree(&mut r, 3).normalized() else { continue };
            let logic = tree.nnf();
            let direct: BTreeSet<String> = records.iter().filter(|rec| eval(&logic, rec, &|_| false) == Truth::True).map(|r| r.source_id.clone()).collect();
            for (name, spec) in profiles() {
                let (got, strategy) = run(&logic, &spec, &records);
                if strategy.decision.is_some() || !strategy.approximate.is_empty() {
                    continue;
                }
                checked += 1;
                assert_eq!(got, direct, "round {round}, profile {name}: {}\n{strategy:#?}", boolean::format(&tree));
            }
        }
        assert!(checked > 1000, "{checked}");
    }

    #[test]
    fn missing_fields_make_plans_approximate_but_never_lose_records() {
        let mut r = Rng(42);
        let mut records = corpus(&mut r);
        for rec in records.iter_mut().step_by(2) {
            rec.abstract_ = None;
        }
        let s = spec(&["all", "title"], serde_json::json!({"phrase": true}), Some(serde_json::json!({"not": false})), &["title"]);
        let logic = parse("title:health AND abstract:model NOT abstract:trial").unwrap().tree.nnf();
        let (got, strategy) = run(&logic, &s, &records);
        assert!(strategy.approximate.iter().any(|a| a.contains("abstracts")), "{strategy:#?}");
        let direct: BTreeSet<String> = records.iter().filter(|rec| eval(&logic, rec, &|_| false) == Truth::True).map(|r| r.source_id.clone()).collect();
        assert!(direct.is_subset(&got));
    }

    #[test]
    fn plans_read_naturally() {
        let profiles = profiles();
        let logic = parse("(health OR doctor) AND ((AI OR ML) NOT regression)").unwrap().tree.nnf();
        let (q, s) = plan(&logic, &profiles[0].1);
        assert_eq!((q.len(), s.kind.as_str(), s.post_filter), (1, "single", false));
        let (q, s) = plan(&logic, &profiles[1].1);
        assert_eq!((q.len(), s.kind.as_str(), s.post_filter), (4, "split", false), "{s:#?}");
        assert!(s.steps[0].contains("split into 4 queries"));
        let (q, s) = plan(&logic, &profiles[4].1);
        assert_eq!((q.len(), s.kind.as_str(), s.post_filter), (2, "terms", true));
        assert!(s.steps.iter().any(|x| x.contains("match the full search")));
        let (q, s) = plan(&logic, &profiles[3].1);
        assert_eq!(q.len(), 1);
        assert!(s.post_filter && s.steps.iter().any(|x| x.contains("NOT")), "{s:#?}");
        let (_, s) = plan(&parse("NOT a").unwrap().tree.nnf(), &profiles[0].1);
        assert_eq!(s.decision.unwrap().kind, "nothing");
    }

    #[test]
    fn too_many_queries_are_capped_and_reported() {
        let mut s = profiles()[1].1.clone();
        s.query.max_chunks = 4;
        let logic = parse("(a OR b OR c) AND (d OR e OR f) AND (g OR h)").unwrap().tree.nnf();
        let (q, strategy) = plan(&logic, &s);
        assert!(q.len() <= 4, "{}", q.len());
        assert!(strategy.post_filter && strategy.steps.iter().any(|x| x.contains("largest OR")));
    }
}
