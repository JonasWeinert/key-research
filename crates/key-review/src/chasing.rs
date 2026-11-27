// Citation searching (std-B; MECIR C30, PRISMA 2020 "other methods", TARCiS): from seed studies,
// the works they cite (backward, their reference lists) and the works that cite them (forward),
// through the open scholarly graph (OpenAlex, which the host reaches with its paced, cached
// requests). A seed OpenAlex does not know falls back to the reference list Key read from the
// seed's own PDF or saved page. What is found is de-duplicated within itself and against the
// review, counted (found, already in the review, new) before anything is imported, and the new
// ones become one batch under PRISMA's other methods, "Citation searching", with a `chase.round`
// event recording the direction, seeds, service, date and counts for the PRISMA-S report.
// Rounds repeat on the newly included studies; a round that adds nothing is the hint to stop.
use crate::derive::State;
use crate::events::uuid7;
use crate::import::dedup;
use crate::model::*;
use crate::ops::{ImportReport, Library};
use crate::store::{Result, Reviews, all_metas};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const BATCH_NAME: &str = "Citation searching";
/// OpenAlex filters take at most this many ids or DOIs joined with `|`.
pub const BATCH: usize = 50;
/// Forward citations kept per round (the shared daily budget is small; most seeds have far fewer).
pub const FORWARD_LIMIT: usize = 2000;

/// A work as the scholarly graph lists it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphWork {
    /// The graph's own id ("W123…").
    pub id: String,
    pub doi: String,
    pub title: String,
    pub year: Option<i64>,
    pub authors: Vec<String>,
    pub journal: String,
    pub abstract_text: String,
    pub item_type: String,
    /// Ids of the works it cites.
    pub references: Vec<String>,
}

impl GraphWork {
    pub fn meta(&self) -> RecordMeta {
        let mut extra = serde_json::Map::new();
        if !self.id.is_empty() {
            extra.insert("openalexId".into(), json!(self.id));
        }
        RecordMeta {
            id: uuid7(),
            title: self.title.clone(),
            abstract_text: self.abstract_text.clone(),
            authors: self.authors.clone(),
            year: self.year,
            journal: self.journal.clone(),
            doi: self.doi.clone(),
            item_type: if self.item_type.is_empty() || self.item_type == "article" { "journalArticle".into() } else { self.item_type.clone() },
            extra,
            ..Default::default()
        }
    }
}

/// The graph the host reaches (OpenAlex), mocked in tests. Each call is one request at most:
/// callers pass at most `BATCH` keys.
pub trait Graph {
    fn by_dois(&self, dois: &[String]) -> Result<Vec<GraphWork>>;
    fn by_ids(&self, ids: &[String]) -> Result<Vec<GraphWork>>;
    /// Candidates for a title (the caller decides which, if any, is the same work).
    fn by_title(&self, title: &str) -> Result<Vec<GraphWork>>;
    /// Works citing any of `ids` (with their reference lists), at most `limit`.
    fn citing(&self, ids: &[String], limit: usize) -> Result<Vec<GraphWork>>;
    /// The references Key read from a seed's own full text (its library source), as records.
    fn local_references(&self, _seed: &RecordMeta) -> Vec<RecordMeta> {
        Vec::new()
    }
    fn name(&self) -> String {
        "OpenAlex".into()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Backward,
    Forward,
    Both,
}

impl Direction {
    pub fn parse(text: &str) -> Direction {
        match text {
            "backward" => Direction::Backward,
            "forward" => Direction::Forward,
            _ => Direction::Both,
        }
    }
    fn backward(self) -> bool {
        self != Direction::Forward
    }
    fn forward(self) -> bool {
        self != Direction::Backward
    }
    pub fn words(self) -> &'static str {
        match self {
            Direction::Backward => "Backward (reference lists)",
            Direction::Forward => "Forward (citing works)",
            Direction::Both => "Backward (reference lists) and forward (citing works)",
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedOutcome {
    pub record_id: String,
    pub title: String,
    /// The graph's id it resolved to.
    pub work: Option<String>,
    /// doi | title | fulltext | none
    pub via: String,
    pub backward: usize,
    pub forward: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub meta: RecordMeta,
    /// backward | forward | both
    pub direction: String,
    /// The seeds it is linked to (cited by, or citing).
    pub seeds: Vec<String>,
    /// How many seeds it links to: co-citation (cited by several seeds) and bibliographic
    /// coupling (citing several seeds) both raise it. Optional screening order.
    pub links: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaseResult {
    pub direction: String,
    pub seeds: Vec<SeedOutcome>,
    pub candidates: Vec<Candidate>,
    pub requests: usize,
    pub cancelled: bool,
    pub tool: String,
    pub at: i64,
}

/// What a background run reports while it works; answering false cancels it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: &'static str,
    pub done: usize,
    pub total: usize,
}

fn key_of(meta: &RecordMeta) -> String {
    if let Some(id) = meta.extra.get("openalexId").and_then(Json::as_str).filter(|s| !s.is_empty()) {
        return format!("w:{}", id.to_ascii_uppercase());
    }
    if let Some(doi) = key_store::normalize::doi(&meta.doi) {
        return format!("d:{doi}");
    }
    let title: String = meta.title.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
    format!("t:{title}:{}", meta.year.unwrap_or(0))
}

/// The graph work that is a seed found by its title: the existing matcher must call them the
/// same work (exact, or likely with a high score).
fn same_work(seed: &RecordMeta, candidates: &[GraphWork]) -> Option<GraphWork> {
    for c in candidates {
        let mut m = c.meta();
        m.id = format!("cand-{}", c.id);
        let out = dedup(std::slice::from_ref(seed), std::slice::from_ref(&m));
        if !out.exact.is_empty() || out.likely.iter().any(|(_, _, score, _)| *score >= 0.9) {
            return Some(c.clone());
        }
    }
    None
}

/// Chases citations from `seeds`. Requests are batched (`BATCH` keys each); `progress` is asked
/// between requests and stops the run when it answers false (what was found so far is kept).
pub fn chase(seeds: &[RecordMeta], direction: Direction, graph: &dyn Graph, progress: &mut dyn FnMut(Progress) -> bool) -> Result<ChaseResult> {
    let mut out = ChaseResult { direction: format!("{direction:?}").to_lowercase(), tool: graph.name(), at: crate::events::now_ms(), ..Default::default() };
    let mut requests = 0usize;
    // 1. Seeds to graph works: by DOI in batches, then by title one at a time.
    let mut resolved: BTreeMap<String, GraphWork> = BTreeMap::new();
    let mut via: HashMap<String, &'static str> = HashMap::new();
    let with_doi: Vec<(&RecordMeta, String)> = seeds.iter().filter_map(|s| key_store::normalize::doi(&s.doi).map(|d| (s, d))).collect();
    let total_seed_steps = with_doi.len().div_ceil(BATCH) + seeds.len().saturating_sub(with_doi.len());
    let mut step = 0;
    for chunk in with_doi.chunks(BATCH) {
        if !progress(Progress { phase: "seeds", done: step, total: total_seed_steps }) {
            out.cancelled = true;
            break;
        }
        let dois: Vec<String> = chunk.iter().map(|(_, d)| d.clone()).collect();
        let found = graph.by_dois(&dois)?;
        requests += 1;
        step += 1;
        for (seed, doi) in chunk {
            if let Some(w) = found.iter().find(|w| key_store::normalize::doi(&w.doi).as_deref() == Some(doi.as_str())) {
                resolved.insert(seed.id.clone(), w.clone());
                via.insert(seed.id.clone(), "doi");
            }
        }
    }
    let by_title: Vec<&RecordMeta> = seeds.iter().filter(|s| !resolved.contains_key(&s.id) && !s.title.trim().is_empty()).collect();
    for seed in by_title {
        if out.cancelled || !progress(Progress { phase: "seeds", done: step, total: total_seed_steps }) {
            out.cancelled = true;
            break;
        }
        let candidates = graph.by_title(&seed.title)?;
        requests += 1;
        step += 1;
        if let Some(w) = same_work(seed, &candidates) {
            resolved.insert(seed.id.clone(), w);
            via.insert(seed.id.clone(), "title");
        }
    }
    // Found works: key → (meta, seeds, backward?, forward?)
    let mut found: BTreeMap<String, (RecordMeta, BTreeSet<String>, bool, bool)> = BTreeMap::new();
    let add = |meta: RecordMeta, seed: &str, backward: bool, found: &mut BTreeMap<String, (RecordMeta, BTreeSet<String>, bool, bool)>| {
        let entry = found.entry(key_of(&meta)).or_insert_with(|| (meta, BTreeSet::new(), false, false));
        entry.1.insert(seed.to_string());
        if backward {
            entry.2 = true;
        } else {
            entry.3 = true;
        }
    };
    let seed_works: BTreeSet<String> = resolved.values().map(|w| w.id.to_ascii_uppercase()).collect();
    let mut counts: HashMap<String, (usize, usize)> = HashMap::new();
    // 2. Backward: every resolved seed's reference list, fetched in batches.
    if direction.backward() && !out.cancelled {
        let mut cited_by: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for (seed, w) in &resolved {
            for r in &w.references {
                let id = r.rsplit('/').next().unwrap_or(r).to_ascii_uppercase();
                cited_by.entry(id).or_default().insert(seed.clone());
            }
        }
        let ids: Vec<String> = cited_by.keys().filter(|id| !seed_works.contains(*id)).cloned().collect();
        let total = ids.len().div_ceil(BATCH);
        for (i, chunk) in ids.chunks(BATCH).enumerate() {
            if !progress(Progress { phase: "references", done: i, total }) {
                out.cancelled = true;
                break;
            }
            let works = graph.by_ids(chunk)?;
            requests += 1;
            for w in works {
                let id = w.id.to_ascii_uppercase();
                for seed in cited_by.get(&id).into_iter().flatten() {
                    counts.entry(seed.clone()).or_default().0 += 1;
                    add(w.meta(), seed, true, &mut found);
                }
            }
        }
        // Seeds the graph does not know: the reference list read from their own full text.
        for seed in seeds.iter().filter(|s| !resolved.contains_key(&s.id)) {
            let refs = graph.local_references(seed);
            if !refs.is_empty() {
                via.insert(seed.id.clone(), "fulltext");
            }
            for mut r in refs {
                if r.id.is_empty() {
                    r.id = uuid7();
                }
                counts.entry(seed.id.clone()).or_default().0 += 1;
                add(r, &seed.id, true, &mut found);
            }
        }
    }
    // 3. Forward: works citing the resolved seeds, several seeds per request.
    if direction.forward() && !out.cancelled {
        let ids: Vec<String> = resolved.values().map(|w| w.id.clone()).collect();
        let by_work: HashMap<String, String> = resolved.iter().map(|(seed, w)| (w.id.to_ascii_uppercase(), seed.clone())).collect();
        let total = ids.len().div_ceil(BATCH);
        let mut kept = 0;
        for (i, chunk) in ids.chunks(BATCH).enumerate() {
            if kept >= FORWARD_LIMIT || !progress(Progress { phase: "citing", done: i, total }) {
                out.cancelled |= kept < FORWARD_LIMIT;
                break;
            }
            let works = graph.citing(chunk, FORWARD_LIMIT - kept)?;
            requests += 1;
            for w in works {
                if seed_works.contains(&w.id.to_ascii_uppercase()) {
                    continue;
                }
                kept += 1;
                let cites: Vec<&String> = w.references.iter().filter_map(|r| by_work.get(&r.rsplit('/').next().unwrap_or(r).to_ascii_uppercase())).collect();
                for seed in cites {
                    counts.entry(seed.clone()).or_default().1 += 1;
                    add(w.meta(), seed, false, &mut found);
                }
            }
        }
    }
    let _ = progress(Progress { phase: "done", done: 1, total: 1 });
    out.seeds = seeds
        .iter()
        .map(|s| {
            let (b, f) = counts.get(&s.id).copied().unwrap_or_default();
            SeedOutcome { record_id: s.id.clone(), title: s.title.clone(), work: resolved.get(&s.id).map(|w| w.id.clone()), via: via.get(&s.id).copied().unwrap_or("none").into(), backward: b, forward: f }
        })
        .collect();
    out.candidates = found
        .into_values()
        .map(|(meta, seeds, b, f)| Candidate { links: seeds.len(), direction: match (b, f) { (true, true) => "both", (true, false) => "backward", _ => "forward" }.into(), seeds: seeds.into_iter().collect(), meta })
        .collect();
    // Most linked first, then newest.
    out.candidates.sort_by(|a, b| b.links.cmp(&a.links).then(b.meta.year.cmp(&a.meta.year)).then(a.meta.title.cmp(&b.meta.title)));
    out.requests = requests;
    Ok(out)
}

/// The counts shown before importing.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub found: usize,
    /// Already in the review (same DOI, PMID, OpenAlex id, or the same title, year and first author).
    pub in_review: usize,
    pub new: usize,
    /// New but possibly the same as a record already there (to check under Duplicates).
    pub possible_duplicates: usize,
    /// Candidate index → the review record it is already.
    #[serde(skip)]
    pub known: HashMap<usize, String>,
}

/// One round as recorded in the log.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Round {
    pub round: usize,
    pub batch_id: String,
    pub direction: String,
    pub seeds: Vec<String>,
    pub tool: String,
    pub at: i64,
    pub found: usize,
    pub in_review: usize,
    pub new: usize,
    pub possible_duplicates: usize,
    pub fallback_seeds: Vec<String>,
    pub unresolved_seeds: Vec<String>,
    pub ordered_by_links: bool,
    pub actor: String,
}

fn known_records(state: &State, conn: &rusqlite::Connection, review: &str) -> Result<Vec<RecordMeta>> {
    Ok(all_metas(conn, review)?.into_iter().filter(|m| state.record(&m.id).is_some_and(|r| !state.removed_batches.contains(&r.batch))).collect())
}

/// Candidates against the review's records.
pub fn preview(existing: &[RecordMeta], result: &ChaseResult) -> Preview {
    let metas: Vec<RecordMeta> = result.candidates.iter().map(|c| c.meta.clone()).collect();
    let by_oa: HashMap<String, &RecordMeta> = existing.iter().filter_map(|m| m.extra.get("openalexId").and_then(Json::as_str).map(|id| (id.to_ascii_uppercase(), m))).collect();
    let out = dedup(existing, &metas);
    let ids: HashMap<&str, usize> = metas.iter().enumerate().map(|(i, m)| (m.id.as_str(), i)).collect();
    let mut known: HashMap<usize, String> = HashMap::new();
    for (id, of) in &out.exact {
        if let Some(i) = ids.get(id.as_str()) {
            if existing.iter().any(|m| &m.id == of) {
                known.insert(*i, of.clone());
            }
        }
    }
    for (i, m) in metas.iter().enumerate() {
        if let Some(e) = m.extra.get("openalexId").and_then(Json::as_str).and_then(|id| by_oa.get(&id.to_ascii_uppercase())) {
            known.entry(i).or_insert_with(|| e.id.clone());
        }
    }
    let likely: BTreeSet<usize> = out.likely.iter().filter(|(_, of, _, _)| existing.iter().any(|m| &m.id == of)).filter_map(|(id, _, _, _)| ids.get(id.as_str()).copied()).filter(|i| !known.contains_key(i)).collect();
    Preview { found: metas.len(), in_review: known.len(), new: metas.len() - known.len(), possible_duplicates: likely.len(), known }
}

/// Seeds offered for the next round: studies included after full-text screening that no earlier
/// round used as a seed (round 1: every included study).
pub fn default_seeds(state: &State) -> Vec<String> {
    let used: BTreeSet<&String> = state.std_b.rounds.iter().flat_map(|r| r.seeds.iter()).collect();
    state.included().into_iter().map(|r| r.id.clone()).filter(|id| !used.contains(id)).collect()
}

/// A plain hint about whether to go on: none before the first round; after one that added
/// nothing, that citation searching can stop.
pub fn stop_hint(state: &State) -> Option<String> {
    let last = state.std_b.rounds.last()?;
    if last.new == 0 {
        return Some(format!("Round {} found nothing new, so you can stop searching citations here.", last.round));
    }
    let fresh = default_seeds(state).len();
    if fresh == 0 {
        return Some(format!("Round {} added {} records. Screen them; once any are included, chase those in a new round.", last.round, last.new));
    }
    Some(format!("{} newly included {} not chased yet: run another round on them.", fresh, if fresh == 1 { "study is" } else { "studies are" }))
}

/// The strategy line kept on the batch (PRISMA-S item 5 reads it).
pub fn strategy_text(result: &ChaseResult, preview: &Preview, round: usize) -> String {
    let dir = Direction::parse(&result.direction).words();
    let date = crate::conduct::iso_date(result.at);
    let fallback = result.seeds.iter().filter(|s| s.via == "fulltext").count();
    let fb = if fallback > 0 { format!("; for {fallback} not in {} the reference list read from its full text", result.tool) } else { String::new() };
    format!(
        "{dir} citation searching in {} on {date}, round {round}, from {} seed {}{fb}. Found {}, {} already in the review, {} new.",
        result.tool,
        result.seeds.len(),
        if result.seeds.len() == 1 { "study" } else { "studies" },
        preview.found,
        preview.in_review,
        preview.new
    )
}

impl Reviews {
    pub fn chase_preview(&self, review: &str, result: &ChaseResult) -> Result<Preview> {
        self.read(review, |state, conn| Ok(preview(&known_records(state, conn, review)?, result)))
    }

    /// Imports a round's new records as one "Citation searching" batch (other methods), most
    /// linked first when `order_by_links` (the queue follows import order), and records the round.
    pub fn chase_import(&self, review: &str, result: &ChaseResult, order_by_links: bool, actor: &str, library: &dyn Library) -> Result<(Round, Option<ImportReport>)> {
        let (p, round_no) = self.read(review, |state, conn| Ok((preview(&known_records(state, conn, review)?, result), state.std_b.rounds.len() + 1)))?;
        let mut fresh: Vec<(usize, &Candidate)> = result.candidates.iter().enumerate().filter(|(i, _)| !p.known.contains_key(i)).collect();
        if !order_by_links {
            fresh.sort_by(|a, b| a.1.meta.title.to_lowercase().cmp(&b.1.meta.title.to_lowercase()));
        }
        let records: Vec<RecordMeta> = fresh
            .iter()
            .map(|(_, c)| {
                let mut m = c.meta.clone();
                m.id = uuid7();
                m.extra.insert("citationSearch".into(), json!({ "direction": c.direction, "links": c.links, "seeds": c.seeds, "round": round_no }));
                m
            })
            .collect();
        let strategy = strategy_text(result, &p, round_no);
        let report = if records.is_empty() {
            None
        } else {
            let batch = Batch {
                kind: "other".into(),
                group: "other".into(),
                name: BATCH_NAME.into(),
                strategy: strategy.clone(),
                searched_at: crate::conduct::iso_date(result.at),
                count: records.len(),
                note: format!("Round {round_no}: {} already in the review were left out", p.in_review),
                ..Default::default()
            };
            Some(self.import(review, batch, records, actor, library)?)
        };
        let round = Round {
            round: round_no,
            batch_id: report.as_ref().map(|r| r.batch_id.clone()).unwrap_or_default(),
            direction: result.direction.clone(),
            seeds: result.seeds.iter().map(|s| s.record_id.clone()).collect(),
            tool: result.tool.clone(),
            at: result.at,
            found: p.found,
            in_review: p.in_review,
            new: p.new,
            possible_duplicates: p.possible_duplicates,
            fallback_seeds: result.seeds.iter().filter(|s| s.via == "fulltext").map(|s| s.record_id.clone()).collect(),
            unresolved_seeds: result.seeds.iter().filter(|s| s.via == "none").map(|s| s.record_id.clone()).collect(),
            ordered_by_links: order_by_links,
            actor: actor.into(),
        };
        let payload = serde_json::to_value(&round).map_err(|e| e.to_string())?;
        self.write(review, |_, _, b| Ok((vec![b.event("chase.round", actor, None, json!({ "round": payload, "strategy": strategy }))], ())))?;
        Ok((round, report))
    }

    /// The Citation searching view: rounds so far, the seeds offered next, the stop hint.
    pub fn chase_view(&self, review: &str) -> Result<Json> {
        self.read(review, |state, conn| {
            let seeds = default_seeds(state);
            let metas = crate::store::metas(conn, review, &state.included().iter().map(|r| r.id.clone()).collect::<Vec<_>>())?;
            let included: Vec<Json> = state
                .included()
                .iter()
                .map(|r| {
                    let m = metas.get(&r.id);
                    json!({ "id": r.id, "title": m.map(|m| m.title.clone()).unwrap_or_default(), "byline": m.map(|m| m.byline()).unwrap_or_default(), "doi": m.map(|m| m.doi.clone()).unwrap_or_default(), "chased": !seeds.contains(&r.id) })
                })
                .collect();
            let rounds: Vec<Json> = state
                .std_b
                .rounds
                .iter()
                .map(|r| {
                    let included = state.records.iter().filter(|x| x.batch == r.batch_id && !r.batch_id.is_empty() && matches!(state.status(x, Stage::Ft), crate::derive::Status::Final { value: Choice::Include, .. })).count();
                    let screened = state.records.iter().filter(|x| x.batch == r.batch_id && !r.batch_id.is_empty() && state.status(x, Stage::Ta).is_final()).count();
                    json!({ "round": r, "included": included, "screened": screened, "actorName": state.member_name(&r.actor) })
                })
                .collect();
            Ok(json!({ "included": included, "defaultSeeds": seeds, "rounds": rounds, "hint": stop_hint(state) }))
        })
    }
}

/// A graph from fixed works, for tests.
#[cfg(test)]
pub struct MockGraph {
    pub works: Vec<GraphWork>,
    pub local: HashMap<String, Vec<RecordMeta>>,
    pub calls: std::cell::RefCell<Vec<String>>,
}

#[cfg(test)]
impl Graph for MockGraph {
    fn by_dois(&self, dois: &[String]) -> Result<Vec<GraphWork>> {
        assert!(dois.len() <= BATCH);
        self.calls.borrow_mut().push(format!("doi:{}", dois.len()));
        Ok(self.works.iter().filter(|w| dois.iter().any(|d| w.doi.eq_ignore_ascii_case(d))).cloned().collect())
    }
    fn by_ids(&self, ids: &[String]) -> Result<Vec<GraphWork>> {
        assert!(ids.len() <= BATCH);
        self.calls.borrow_mut().push(format!("ids:{}", ids.len()));
        Ok(self.works.iter().filter(|w| ids.iter().any(|i| i.eq_ignore_ascii_case(&w.id))).cloned().collect())
    }
    fn by_title(&self, title: &str) -> Result<Vec<GraphWork>> {
        self.calls.borrow_mut().push("title".into());
        Ok(self.works.iter().filter(|w| w.title.eq_ignore_ascii_case(title)).cloned().collect())
    }
    fn citing(&self, ids: &[String], limit: usize) -> Result<Vec<GraphWork>> {
        self.calls.borrow_mut().push(format!("cites:{}", ids.len()));
        Ok(self.works.iter().filter(|w| w.references.iter().any(|r| ids.contains(r))).take(limit).cloned().collect())
    }
    fn local_references(&self, seed: &RecordMeta) -> Vec<RecordMeta> {
        self.local.get(&seed.id).cloned().unwrap_or_default()
    }
}
