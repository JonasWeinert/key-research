// Formula properties' values, stored per source and kept up to date incrementally.
//
// - `formula_values` holds every source's value of every formula property (its SQL value for
//   sorting, filtering and grouping, indexed by property and value; its JSON for display; or
//   the error), stamped with the version of the formula it was worked out with.
// - `formula_props` is each formula's dependency record: the version (raised whenever its
//   text or what its names refer to changes, and each day for formulas that use today), and
//   the inputs it reads: source columns (`year`), custom properties (`property:score`), related
//   tables (`collections`, `notes`, `highlights`, `reading`, `cited`, `refs`) and other
//   formulas (`f:name`), which give the order they are worked out in.
// - The shared change log (changes.rs) says which input of which source changed, fanned out
//   across rows where an input is another row's (a collection renamed marks its members; a
//   citation found marks the cited source); the changes some formula reads go into
//   `formula_dirty`.
// - `step` (run by the host's background worker, ~200 sources a transaction) recomputes only
//   the dirty sources' formulas that read a changed input, then the formulas depending on
//   those whose value changed; and refills formulas whose version changed, in rowid order.
// - Reads never wait for that: a listed page shows stored values where they are current and
//   works out the rest on the spot (and asks the worker to store those first); a sort or
//   filter on a formula first settles a small backlog (`settle`), else uses the last values.
use crate::formula::{dependencies, today};
use crate::formula_catalog::{CORE, field, normalize};
use crate::formula_scope::{Env, Related, SourceScope, definitions, json_result, sql_value};
use crate::{Result, Source, Store, e};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value as Json, json};
use std::collections::{HashMap, HashSet};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS formula_props (
  name TEXT PRIMARY KEY,
  formula TEXT NOT NULL,
  version INTEGER NOT NULL,
  inputs TEXT NOT NULL,
  volatile INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 0,
  filled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS formula_values (
  property TEXT NOT NULL,
  source_id TEXT NOT NULL,
  value,
  json TEXT,
  error TEXT,
  version INTEGER NOT NULL,
  PRIMARY KEY (property, source_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS formula_values_sorted ON formula_values(property, value);
CREATE INDEX IF NOT EXISTS formula_values_source ON formula_values(source_id);
CREATE TABLE IF NOT EXISTS formula_dirty (
  source_id TEXT NOT NULL,
  input TEXT NOT NULL,
  PRIMARY KEY (source_id, input)
) WITHOUT ROWID;
";

/// The change-log consumer (changes.rs) that feeds `formula_dirty`.
const CONSUMER: &str = "formulas";

/// Creates the tables and syncs the formulas (after the change log exists).
pub(crate) fn ensure_schema(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA).map_err(e)?;
    db.execute("DROP TABLE IF EXISTS formula_inputs", []).map_err(e)?;
    let tx = db.unchecked_transaction().map_err(e)?;
    // A log that lost changes this consumer had not read: refill everything.
    let since = crate::changes::cursor(&tx, CONSUMER)?;
    if !crate::changes::complete_since(&tx, since)? {
        tx.execute("DELETE FROM formula_props", []).map_err(e)?;
        crate::changes::ack(&tx, CONSUMER, crate::changes::latest(&tx)?)?;
    }
    sync(&tx)?;
    tx.commit().map_err(e)
}

/// Moves logged changes some formula reads into `formula_dirty` (and drops deleted sources'
/// values), up to `limit` log rows.
fn take_changes(db: &Connection, plan: &Plan, limit: usize) -> Result<()> {
    let changes = crate::changes::read_since(db, CONSUMER, limit)?;
    let Some(last) = changes.last().map(|c| c.seq) else { return Ok(()) };
    let wanted: HashSet<&str> = plan.inputs.iter().flatten().map(String::as_str).collect();
    let any = wanted.contains("any");
    let mut insert = db.prepare_cached("INSERT OR IGNORE INTO formula_dirty(source_id, input) VALUES (?1, ?2)").map_err(e)?;
    for change in &changes {
        let input = match change.kind.as_str() {
            "removed" => {
                db.execute("DELETE FROM formula_values WHERE source_id = ?", [&change.source_id]).map_err(e)?;
                db.execute("DELETE FROM formula_dirty WHERE source_id = ?", [&change.source_id]).map_err(e)?;
                continue;
            }
            "added" => "*".to_string(),
            // Property names compare as formulas resolve them (case, spaces).
            kind => match kind.strip_prefix("property:") {
                Some(name) => format!("property:{}", normalize(name)),
                None => kind.to_string(),
            },
        };
        if plan.len() > 0 && (input == "*" || any || wanted.contains(input.as_str())) {
            insert.execute(params![change.source_id, input]).map_err(e)?;
        }
    }
    crate::changes::ack(db, CONSUMER, last)
}

/// The change kinds (changes.rs) a built-in field reads.
fn field_inputs(id: &str) -> Vec<String> {
    let kinds = |list: &[&str]| list.iter().map(|k| k.to_string()).collect::<Vec<_>>();
    match id {
        "authors" | "authorList" | "firstAuthor" | "authorCount" => kinds(&["creators"]),
        "published" => kinds(&["date", "year"]),
        "journal" => kinds(&["containerTitle"]),
        "type" => kinds(&["itemType"]),
        // Any change moves the modification date.
        "modified" => kinds(&["any"]),
        "status" => kinds(&["readState"]),
        "pages" => kinds(&["pageCount"]),
        "hasPdf" => kinds(&["files", "kind"]),
        "hasFile" => kinds(&["files"]),
        "indexed" => kinds(&["text"]),
        "isOpenAccess" => kinds(&["oaStatus", "oaUrl"]),
        "retracted" => kinds(&["retracted", "retractionKind"]),
        "retraction" => kinds(&["retractionKind"]),
        "lastOpened" | "lastRead" => kinds(&["reading"]),
        "citedInLibrary" => kinds(&["cited"]),
        "referencesInLibrary" => kinds(&["references"]),
        // The rest read the field of their own name (title, year, added, tags, doi, …).
        other => vec![other.to_string()],
    }
}

/// The workspace's formulas with what each reads, in the order they are worked out.
pub(crate) struct Plan {
    pub env: Env,
    /// Sorted; `f:<name>` for another formula.
    pub inputs: Vec<Vec<String>>,
    pub deps: Vec<Vec<usize>>,
    /// Reads the day, directly or through another formula.
    pub volatile: Vec<bool>,
    /// Formulas before the formulas that read them (a loop's members last).
    pub order: Vec<usize>,
    /// The stored versions (`sync` sets them; 0 when unknown).
    pub versions: Vec<i64>,
    pub filled: Vec<bool>,
}

impl Plan {
    pub(crate) fn new(defs: Vec<(String, String)>) -> Self {
        let env = Env::new(defs);
        let n = env.len();
        let (mut inputs, mut deps, mut volatile) = (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
        for i in 0..n {
            let (names, reads_day) = dependencies(env.text(i)).unwrap_or_default();
            let (mut reads, mut uses) = (Vec::new(), Vec::new());
            for name in names {
                // As SourceScope::lookup resolves it: a core field, a formula, else a property
                // (which a source may lack, falling back to the field of that name).
                let key = normalize(&name);
                let builtin = field(&name);
                if let Some(f) = builtin.filter(|f| CORE.contains(&f.id) && normalize(f.label) == key) {
                    reads.extend(field_inputs(f.id));
                } else if let Some(j) = env.find(&name) {
                    uses.push(j);
                    reads.push(format!("f:{}", env.name(j).to_lowercase()));
                } else {
                    reads.push(format!("property:{key}"));
                    reads.extend(builtin.map(|f| field_inputs(f.id)).unwrap_or_default());
                }
            }
            reads.sort();
            reads.dedup();
            uses.sort_unstable();
            uses.dedup();
            inputs.push(reads);
            deps.push(uses);
            volatile.push(reads_day);
        }
        // Depth-first: every formula after the ones it reads.
        let mut order = Vec::with_capacity(n);
        let mut state = vec![0u8; n];
        fn visit(i: usize, deps: &[Vec<usize>], state: &mut [u8], order: &mut Vec<usize>) {
            if state[i] != 0 {
                return;
            }
            state[i] = 1;
            for &j in &deps[i] {
                visit(j, deps, state, order);
            }
            state[i] = 2;
            order.push(i);
        }
        for i in 0..n {
            visit(i, &deps, &mut state, &mut order);
        }
        for &i in &order {
            if deps[i].iter().any(|&j| volatile[j]) {
                volatile[i] = true;
            }
        }
        Plan { env, inputs, deps, volatile, order, versions: vec![0; n], filled: vec![false; n] }
    }

    pub(crate) fn len(&self) -> usize {
        self.env.len()
    }

    fn inputs_text(&self, i: usize) -> String {
        serde_json::to_string(&self.inputs[i]).unwrap_or_default()
    }

    /// Whether a change to `dirty` can change formula `i` directly.
    fn reads_any(&self, i: usize, dirty: &HashSet<String>) -> bool {
        dirty.contains("*") || self.inputs[i].iter().any(|input| input == "any" || dirty.contains(input))
    }
}

struct Props {
    formula: String,
    version: i64,
    inputs: String,
    day: i64,
    filled: i64,
}

fn props(db: &Connection) -> Result<HashMap<String, Props>> {
    let mut statement = db.prepare_cached("SELECT name, formula, version, inputs, day, filled FROM formula_props").map_err(e)?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, Props { formula: r.get(1)?, version: r.get(2)?, inputs: r.get(3)?, day: r.get(4)?, filled: r.get(5)? })))
        .map_err(e)?;
    rows.collect::<std::result::Result<_, _>>().map_err(e)
}

fn meta_i64(db: &Connection, key: &str) -> Result<i64> {
    Ok(db.query_row("SELECT value FROM meta WHERE key = ?", [key], |r| r.get::<_, String>(0)).optional().map_err(e)?.and_then(|v| v.parse().ok()).unwrap_or(0))
}

fn set_meta(db: &Connection, key: &str, value: i64) -> Result<()> {
    db.execute("INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value.to_string()]).map(|_| ()).map_err(e)
}

/// Brings `formula_props` in line with the definitions: a formula whose text or references
/// changed, or that reads the day and the day changed, gets a new version (as do the
/// formulas reading it), which makes all its stored values stale and starts a refill.
pub(crate) fn sync(db: &Connection) -> Result<Plan> {
    let mut plan = Plan::new(definitions(db)?);
    let stored = props(db)?;
    let day = today();
    let n = plan.len();
    let mut bump: Vec<bool> = (0..n)
        .map(|i| match stored.get(plan.env.name(i)) {
            None => true,
            Some(p) => p.formula != plan.env.text(i) || p.inputs != plan.inputs_text(i) || (plan.volatile[i] && p.day != day),
        })
        .collect();
    for &i in &plan.order {
        if !bump[i] && plan.deps[i].iter().any(|&j| bump[j]) {
            bump[i] = true;
        }
    }
    if bump.iter().any(|b| *b) {
        let version = meta_i64(db, "formula_seq")? + 1;
        set_meta(db, "formula_seq", version)?;
        set_meta(db, "formula_fill_cursor", 0)?;
        let mut upsert = db
            .prepare_cached(
                "INSERT INTO formula_props(name, formula, version, inputs, volatile, day, filled) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
                 ON CONFLICT(name) DO UPDATE SET formula = excluded.formula, version = excluded.version, inputs = excluded.inputs, volatile = excluded.volatile, day = excluded.day, filled = 0",
            )
            .map_err(e)?;
        for i in (0..n).filter(|i| bump[*i]) {
            upsert.execute(params![plan.env.name(i), plan.env.text(i), version, plan.inputs_text(i), plan.volatile[i], day]).map_err(e)?;
        }
    }
    let names: HashSet<&str> = (0..n).map(|i| plan.env.name(i)).collect();
    for gone in stored.keys().filter(|k| !names.contains(k.as_str())) {
        db.execute("DELETE FROM formula_props WHERE name = ?", [gone]).map_err(e)?;
        db.execute("DELETE FROM formula_values WHERE property = ?", [gone]).map_err(e)?;
    }
    if n == 0 {
        db.execute("DELETE FROM formula_dirty", []).map_err(e)?;
    }
    let stored = props(db)?;
    for i in 0..n {
        if let Some(p) = stored.get(plan.env.name(i)) {
            plan.versions[i] = p.version;
            plan.filled[i] = p.filled >= p.version;
        }
    }
    Ok(plan)
}

/// What one recalculation step did.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecalcStats {
    /// Sources looked at.
    pub sources: usize,
    /// Formula values worked out.
    pub evaluated: usize,
    /// Of those, values that differ from what was stored.
    pub changed: usize,
    /// Whether more work is waiting.
    pub remaining: bool,
}

impl RecalcStats {
    fn add(&mut self, other: &RecalcStats) {
        self.sources += other.sources;
        self.evaluated += other.evaluated;
        self.changed += other.changed;
        self.remaining = other.remaining;
    }
}

struct Stored {
    json: Option<String>,
    error: Option<String>,
    version: i64,
}

fn stored_values(db: &Connection, ids: &str) -> Result<HashMap<(String, String), Stored>> {
    let mut statement = db
        .prepare_cached("SELECT property, source_id, json, error, version FROM formula_values WHERE source_id IN (SELECT value FROM json_each(?1))")
        .map_err(e)?;
    let rows = statement
        .query_map([ids], |r| Ok(((r.get::<_, String>(0)?, r.get::<_, String>(1)?), Stored { json: r.get(2)?, error: r.get(3)?, version: r.get(4)? })))
        .map_err(e)?;
    rows.collect::<std::result::Result<_, _>>().map_err(e)
}

/// One batch of at most `limit` sources: the ones a read asked for (`first`), then dirty
/// ones, else the next part of a refill.
pub(crate) fn step(db: &Connection, first: Vec<String>, limit: usize) -> Result<RecalcStats> {
    let tx = db.unchecked_transaction().map_err(e)?;
    let plan = sync(&tx)?;
    take_changes(&tx, &plan, 20 * limit)?;
    let mut stats = RecalcStats::default();
    if plan.len() == 0 {
        tx.commit().map_err(e)?;
        return Ok(stats);
    }
    let mut seen = HashSet::new();
    let mut ids: Vec<String> = first.into_iter().filter(|id| seen.insert(id.clone())).take(limit).collect();
    if ids.len() < limit {
        let mut statement = tx.prepare_cached("SELECT DISTINCT source_id FROM formula_dirty LIMIT ?").map_err(e)?;
        for id in statement.query_map([(limit - ids.len()) as i64], |r| r.get::<_, String>(0)).map_err(e)? {
            let id = id.map_err(e)?;
            if seen.insert(id.clone()) {
                ids.push(id);
            }
        }
    }
    let mut fill_done = false;
    if ids.is_empty() && plan.filled.iter().any(|f| !f) {
        let cursor = meta_i64(&tx, "formula_fill_cursor")?;
        let rows: Vec<(i64, String)> = {
            let mut statement = tx.prepare_cached("SELECT rowid, id FROM sources WHERE rowid > ? ORDER BY rowid LIMIT ?").map_err(e)?;
            statement.query_map(params![cursor, limit as i64], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        fill_done = rows.len() < limit;
        set_meta(&tx, "formula_fill_cursor", if fill_done { 0 } else { rows.last().map_or(cursor, |r| r.0) })?;
        ids = rows.into_iter().map(|r| r.1).collect();
    }
    if !ids.is_empty() {
        let list = serde_json::to_string(&ids).map_err(e)?;
        let mut dirty: HashMap<String, HashSet<String>> = HashMap::new();
        {
            let mut statement = tx.prepare_cached("SELECT source_id, input FROM formula_dirty WHERE source_id IN (SELECT value FROM json_each(?1))").map_err(e)?;
            for row in statement.query_map([&list], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)? {
                let (id, input) = row.map_err(e)?;
                dirty.entry(id).or_default().insert(input);
            }
        }
        recompute(&tx, &plan, &ids, &list, &dirty, &mut stats)?;
        tx.execute("DELETE FROM formula_dirty WHERE source_id IN (SELECT value FROM json_each(?1))", [&list]).map_err(e)?;
    }
    if fill_done {
        tx.execute("UPDATE formula_props SET filled = version", []).map_err(e)?;
    }
    stats.remaining = tx
        .query_row("SELECT EXISTS (SELECT 1 FROM formula_dirty) OR EXISTS (SELECT 1 FROM formula_props WHERE filled < version)
               OR EXISTS (SELECT 1 FROM source_input_changes WHERE seq > (SELECT seq FROM source_change_cursors WHERE consumer = ?1))",
            [CONSUMER],
            |r| r.get(0),
        )
        .map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(stats)
}

fn recompute(db: &Connection, plan: &Plan, ids: &[String], list: &str, dirty: &HashMap<String, HashSet<String>>, stats: &mut RecalcStats) -> Result<()> {
    let sources: Vec<Source> = {
        let mut statement = db.prepare_cached(&format!("{} WHERE s.id IN (SELECT value FROM json_each(?1)) AND s.merged_into IS NULL", crate::select_sources())).map_err(e)?;
        statement.query_map([list], crate::read_source).map_err(e)?.collect::<std::result::Result<_, _>>().map_err(e)?
    };
    let related = Related::load(db, &plan.env, Some(ids))?;
    let stored = stored_values(db, list)?;
    let mut upsert = db
        .prepare_cached(
            "INSERT INTO formula_values(property, source_id, value, json, error, version) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(property, source_id) DO UPDATE SET value = excluded.value, json = excluded.json, error = excluded.error, version = excluded.version",
        )
        .map_err(e)?;
    let n = plan.len();
    for source in &sources {
        let scope = SourceScope::new(source, &related, &plan.env);
        let inputs = dirty.get(&source.id);
        let mut changed = vec![false; n];
        for &i in &plan.order {
            let name = plan.env.name(i);
            let old = stored.get(&(name.to_string(), source.id.clone()));
            let stale = old.is_none_or(|o| o.version != plan.versions[i]);
            let direct = inputs.is_some_and(|d| plan.reads_any(i, d));
            let upstream = plan.deps[i].iter().any(|&j| changed[j]);
            if !(stale || direct || upstream) {
                continue;
            }
            let result = scope.formula(i);
            stats.evaluated += 1;
            let (json, error) = match &result {
                Ok(v) => (Some(v.to_json().to_string()), None),
                Err(message) => (None, Some(message.clone())),
            };
            let same = old.is_some_and(|o| o.json == json && o.error == error);
            if !same {
                changed[i] = true;
                stats.changed += 1;
            }
            if !same || stale {
                let value = result.ok().map_or(rusqlite::types::Value::Null, sql_value);
                upsert.execute(params![name, source.id, value, json, error, plan.versions[i]]).map_err(e)?;
            }
        }
        stats.sources += 1;
    }
    Ok(())
}

/// Puts each formula property's value on the sources as `formulaValues` (what the table,
/// details and exports show): the stored value where it is current, else worked out now.
/// Returns the sources worked out now, for the worker to store first.
pub fn decorate(db: &Connection, sources: &mut [Source]) -> Result<Vec<String>> {
    let defs = definitions(db)?;
    if defs.is_empty() || sources.is_empty() {
        return Ok(Vec::new());
    }
    let plan = Plan::new(defs);
    let stored_props = props(db)?;
    let day = today();
    let current: Vec<Option<i64>> = (0..plan.len())
        .map(|i| {
            stored_props
                .get(plan.env.name(i))
                .filter(|p| p.formula == plan.env.text(i) && p.inputs == plan.inputs_text(i) && !(plan.volatile[i] && p.day != day))
                .map(|p| p.version)
        })
        .collect();
    let ids: Vec<String> = sources.iter().map(|s| s.id.clone()).collect();
    let list = serde_json::to_string(&ids).map_err(e)?;
    let stored = stored_values(db, &list)?;
    // Queued, or changed since the worker last read the change log.
    let mut dirty: HashSet<String> = {
        let mut statement = db.prepare_cached("SELECT DISTINCT source_id FROM formula_dirty WHERE source_id IN (SELECT value FROM json_each(?1))").map_err(e)?;
        statement.query_map([&list], |r| r.get(0)).map_err(e)?.collect::<std::result::Result<_, _>>().map_err(e)?
    };
    dirty.extend(crate::changes::pending_for(db, CONSUMER, &ids)?);
    let mut related: Option<Related> = None;
    let mut worked_out = Vec::new();
    for source in sources.iter_mut() {
        let mut values: Vec<Option<Json>> = vec![None; plan.len()];
        if !dirty.contains(&source.id) {
            for (i, slot) in values.iter_mut().enumerate() {
                let Some(version) = current[i] else { continue };
                if let Some(row) = stored.get(&(plan.env.name(i).to_string(), source.id.clone())).filter(|row| row.version == version) {
                    *slot = Some(match (&row.json, &row.error) {
                        (Some(text), _) => serde_json::from_str(text).unwrap_or(Json::Null),
                        (None, Some(error)) => json!({ "error": error }),
                        (None, None) => Json::Null,
                    });
                }
            }
        }
        if values.iter().any(Option::is_none) {
            if related.is_none() {
                related = Some(Related::load(db, &plan.env, Some(&ids))?);
            }
            let scope = SourceScope::new(source, related.as_ref().unwrap_or_else(|| unreachable!()), &plan.env);
            for (i, slot) in values.iter_mut().enumerate() {
                if slot.is_none() {
                    *slot = Some(json_result(scope.formula(i)));
                }
            }
            worked_out.push(source.id.clone());
        }
        let map = values.into_iter().enumerate().map(|(i, v)| (plan.env.name(i).to_string(), v.unwrap_or(Json::Null))).collect();
        source.fields.insert("formulaValues".into(), Json::Object(map));
    }
    Ok(worked_out)
}

/// A formula property renamed: its stored values keep their place.
pub(crate) fn rename(db: &Connection, from: &str, to: &str) -> Result<()> {
    db.execute("UPDATE formula_props SET name = ?2 WHERE name = ?1", params![from, to]).map_err(e)?;
    db.execute("UPDATE formula_values SET property = ?2 WHERE property = ?1", params![from, to]).map_err(e)?;
    Ok(())
}

/// Sources a sort or filter waits for before it reads stored values: a small backlog.
const SETTLE_ROWS: usize = 1000;
const BATCH: usize = crate::WRITE_BATCH;

impl Store {
    /// One background step (the host's formula worker): the sources a read worked out, then
    /// dirty ones, else part of a refill, at most `limit` in one transaction.
    pub fn formula_recalc_step(&self, limit: usize) -> Result<RecalcStats> {
        let first = self.formula_first.lock().map(|mut f| std::mem::take(&mut *f)).unwrap_or_default();
        let db = self.db()?;
        step(&db, first, limit.max(1))
    }

    /// Steps until nothing is left (tests, tools).
    pub fn formula_recalc_all(&self) -> Result<RecalcStats> {
        let mut total = RecalcStats::default();
        loop {
            let stats = self.formula_recalc_step(BATCH)?;
            total.add(&stats);
            if !stats.remaining {
                return Ok(total);
            }
            crate::priority::yield_if_needed();
        }
    }

    /// Whether stored values are waiting to be worked out (read side, never waits on writes).
    pub fn formula_pending(&self) -> Result<bool> {
        let db = self.read()?;
        db.query_row(
            "SELECT EXISTS (SELECT 1 FROM formula_dirty) OR EXISTS (SELECT 1 FROM formula_props WHERE filled < version)
               OR (SELECT count(*) FROM formula_props) <> (SELECT count(*) FROM property_definitions WHERE json_extract(config, '$.type') = 'formula')
               OR EXISTS (SELECT 1 FROM source_input_changes WHERE seq > (SELECT seq FROM source_change_cursors WHERE consumer = ?1))",
            [CONSUMER],
            |r| r.get(0),
        )
        .map_err(e)
    }

    /// Before a sort, filter or grouping by a formula: stores a small backlog first, so an
    /// edit shows in the order at once; a large refill stays in the background.
    pub(crate) fn formula_settle(&self) -> Result<()> {
        if !self.formula_pending()? {
            return Ok(());
        }
        let mut done = 0;
        while done < SETTLE_ROWS {
            let stats = self.formula_recalc_step(BATCH)?;
            done += stats.sources.max(1);
            if !stats.remaining {
                break;
            }
        }
        Ok(())
    }

    /// Sources a read worked out because their stored values were missing or stale.
    pub(crate) fn formula_ask_first(&self, ids: Vec<String>) {
        if ids.is_empty() {
            return;
        }
        if let Ok(mut first) = self.formula_first.lock() {
            first.retain(|id| !ids.contains(id));
            first.splice(0..0, ids);
            first.truncate(2000);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ListQuery, SourceInput};
    use serde_json::Map;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }

    fn add(store: &Store, value: Json) -> String {
        let input: SourceInput = serde_json::from_value(value).unwrap();
        store.insert_source(input).unwrap().id
    }

    fn patch(store: &Store, id: &str, value: Json) {
        store.update_source(id, serde_json::from_value::<Map<String, Json>>(value).as_ref().unwrap()).unwrap();
    }

    fn stored(store: &Store, property: &str, id: &str) -> Option<Json> {
        let db = store.read().unwrap();
        db.query_row("SELECT json, error FROM formula_values WHERE property = ?1 AND source_id = ?2", params![property, id], |r| {
            Ok(match (r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?) {
                (Some(j), _) => serde_json::from_str(&j).unwrap(),
                (None, Some(error)) => json!({ "error": error }),
                _ => Json::Null,
            })
        })
        .optional()
        .unwrap()
    }

    fn bulk(store: &Store, n: usize) {
        let db = store.db().unwrap();
        let tx = db.unchecked_transaction().unwrap();
        for i in 0..n {
            tx.execute(
                "INSERT INTO sources(id, kind, title, year, creators, tags, properties, added_at, updated_at) VALUES (?1, 'reference', ?2, ?3, '[]', ?4, ?5, 0, 0)",
                params![format!("s{i}"), format!("Work {i}"), 1950 + (i % 70) as i64, if i % 3 == 0 { "[\"a\"]" } else { "[]" }, json!({"score": i % 97}).to_string()],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }

    #[test]
    fn edits_recalculate_only_the_formulas_that_read_them() {
        let (_dir, store) = store();
        bulk(&store, 20_000);
        store.save_property_definition("Next year", &json!({"type": "formula", "formula": "{Year} + 1"})).unwrap();
        store.save_property_definition("Tagged", &json!({"type": "formula", "formula": "has({Tags}, \"a\")"})).unwrap();
        store.save_property_definition("Double", &json!({"type": "formula", "formula": "{score} * 2"})).unwrap();
        store.save_property_definition("Rank", &json!({"type": "formula", "formula": "{Double} + {Next year}"})).unwrap();
        let started = std::time::Instant::now();
        let fill = store.formula_recalc_all().unwrap();
        eprintln!("first fill of 4 formulas × 20k sources: {:?} ({} values)", started.elapsed(), fill.evaluated);
        assert_eq!(fill.evaluated, 80_000);
        assert!(!store.formula_pending().unwrap());
        // Nothing to do when nothing changed.
        assert_eq!(store.formula_recalc_all().unwrap().evaluated, 0);

        // Tags: only "Tagged", on that one source.
        patch(&store, "s1", json!({"tags": ["a"]}));
        let stats = store.formula_recalc_all().unwrap();
        assert_eq!((stats.sources, stats.evaluated, stats.changed), (1, 1, 1));
        assert_eq!(stored(&store, "Tagged", "s1"), Some(json!(true)));

        // A property read by "Double", which "Rank" reads: both, once.
        patch(&store, "s2", json!({"properties": {"score": 50}}));
        let stats = store.formula_recalc_all().unwrap();
        assert_eq!((stats.sources, stats.evaluated, stats.changed), (1, 2, 2));
        assert_eq!(stored(&store, "Rank", "s2"), Some(json!(100 + 1953)));

        // A change nothing reads (an unrelated property, the abstract) does no work.
        patch(&store, "s3", json!({"abstract": "New", "properties": {"other": 1}}));
        assert_eq!(store.formula_recalc_all().unwrap().evaluated, 0);

        // Year: "Next year", then "Rank" through it.
        patch(&store, "s4", json!({"year": 2000}));
        let stats = store.formula_recalc_all().unwrap();
        assert_eq!((stats.evaluated, stats.changed), (2, 2));
        assert_eq!(stored(&store, "Rank", "s4"), Some(json!(4 * 2 + 2001)));

        // Sort, filter and group read stored values.
        let query = |q: Json| serde_json::from_value::<ListQuery>(q).unwrap();
        let started = std::time::Instant::now();
        let page = store.list_sources(&query(json!({"sorts": [{"field": "property:Rank", "descending": true}], "limit": 50}))).unwrap();
        let sort = started.elapsed();
        assert_eq!(page.items.len(), 50);
        let started = std::time::Instant::now();
        let filtered = store.list_sources(&query(json!({"filters": [{"field": "property", "key": "Double", "op": "gte", "value": "180"}], "limit": 50}))).unwrap();
        let filter = started.elapsed();
        assert!(filtered.total > 0);
        let started = std::time::Instant::now();
        let grouped = store.list_sources(&query(json!({"group": "property:Tagged", "limit": 50}))).unwrap();
        let group = started.elapsed();
        assert_eq!(grouped.groups.len(), 2);
        assert_eq!(grouped.groups.iter().map(|g| g.count).sum::<usize>(), 20_000);
        eprintln!("20k sources by a formula: sort {sort:?}, filter {filter:?}, group {group:?}");
    }

    #[test]
    fn stored_values_match_direct_evaluation_after_random_edits() {
        let (_dir, store) = store();
        let ids: Vec<String> = (0..60).map(|i| add(&store, json!({"kind": "reference", "title": format!("Work {i}"), "year": 1990 + i, "tags": if i % 2 == 0 { json!(["x"]) } else { json!([]) }, "properties": {"score": i}}))).collect();
        let collection = store.create_collection("Thesis", None, None).unwrap();
        for (name, formula) in [
            ("A", "{score} * 2 + {Year}"),
            ("B", "if(has({Tags}, \"x\"), upper({Title}), lower({Title}))"),
            ("C", "concat({B}, \" \", text({A}))"),
            ("D", "has({Collections}, \"Thesis\") or {Starred}"),
            ("E", "{Notes} + {Highlights}"),
        ] {
            store.save_property_definition(name, &json!({"type": "formula", "formula": formula})).unwrap();
        }
        store.formula_recalc_all().unwrap();
        let mut seed: u64 = 7;
        let mut next = |n: u64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) % n
        };
        for round in 0..200 {
            let id = &ids[next(ids.len() as u64) as usize];
            match next(7) {
                0 => patch(&store, id, json!({"year": 1900 + next(200)})),
                1 => patch(&store, id, json!({"tags": if next(2) == 0 { json!(["x"]) } else { json!(["y"]) }})),
                2 => patch(&store, id, json!({"properties": {"score": next(1000)}})),
                3 => patch(&store, id, json!({"title": format!("Retitled {round}")})),
                4 => store.file_sources(&collection.id, std::slice::from_ref(id), next(2) == 0).map(|_| ()).unwrap(),
                5 => patch(&store, id, json!({"starred": next(2) == 0})),
                _ => {
                    store.save_note(None, Some(id), "", "A note", None).unwrap();
                }
            }
            if round % 25 == 0 {
                // Renaming the collection reaches every member.
                store.update_collection(&collection.id, Some(if round % 50 == 0 { "Thesis" } else { "Other" }), None).unwrap();
            }
            if round % 3 == 0 {
                store.formula_recalc_all().unwrap();
            }
        }
        store.formula_recalc_all().unwrap();
        let defs = definitions(&store.read().unwrap()).unwrap();
        for id in &ids {
            let source = store.source(id).unwrap().unwrap();
            for (name, formula) in &defs {
                let direct = store.formula_evaluate(formula, id).unwrap();
                let expected = direct.get("value").cloned().unwrap_or_else(|| json!({"error": direct["error"]}));
                assert_eq!(stored(&store, name, id), Some(expected.clone()), "{name} on {id}");
                assert_eq!(source.fields["formulaValues"][name], expected, "{name} on {id}");
            }
        }
    }

    #[test]
    fn cross_row_inputs_mark_only_the_sources_they_change() {
        let (_dir, store) = store();
        let ids: Vec<String> = (0..50).map(|i| add(&store, json!({"kind": "reference", "title": format!("Work {i}")}))).collect();
        let thesis = store.create_collection("Thesis", None, None).unwrap();
        store.file_sources(&thesis.id, &ids[..3], true).unwrap();
        store.save_property_definition("In thesis", &json!({"type": "formula", "formula": "has({Collections}, \"Thesis\")"})).unwrap();
        store.save_property_definition("Cited", &json!({"type": "formula", "formula": "{Cited in library}"})).unwrap();
        store.formula_recalc_all().unwrap();
        // Renaming the collection marks its three members, nothing else.
        store.update_collection(&thesis.id, Some("Chapter"), None).unwrap();
        let stats = store.formula_recalc_all().unwrap();
        assert_eq!((stats.sources, stats.evaluated, stats.changed), (3, 3, 3));
        assert_eq!(stored(&store, "In thesis", &ids[0]), Some(json!(false)));
        // A citation found in source 10 matching source 20 changes source 20's count.
        store
            .db()
            .unwrap()
            .execute("INSERT INTO source_cites(source_id, seq, openalex_id, matched_source_id) VALUES (?1, 0, 'W1', ?2)", params![ids[10], ids[20]])
            .unwrap();
        let stats = store.formula_recalc_all().unwrap();
        // Source 10's references changed too, but no formula reads them.
        assert_eq!((stats.sources, stats.evaluated, stats.changed), (1, 1, 1));
        assert_eq!(stored(&store, "Cited", &ids[20]), Some(json!(1)));
    }

    #[test]
    fn editing_a_formula_refills_it_and_its_dependents_and_reads_never_wait() {
        let (_dir, store) = store();
        bulk(&store, 3_000);
        store.save_property_definition("Base", &json!({"type": "formula", "formula": "{score}"})).unwrap();
        store.save_property_definition("Plus", &json!({"type": "formula", "formula": "{Base} + 1"})).unwrap();
        store.save_property_definition("Other", &json!({"type": "formula", "formula": "{Year}"})).unwrap();
        store.formula_recalc_all().unwrap();
        store.save_property_definition("Base", &json!({"type": "formula", "formula": "{score} * 10"})).unwrap();
        // A page read before the refill shows the new values, worked out on the spot.
        let page = store.list_sources(&serde_json::from_value::<ListQuery>(json!({"ids": ["s5"]})).unwrap()).unwrap();
        assert_eq!(page.items[0].fields["formulaValues"]["Plus"], json!(51));
        let stats = store.formula_recalc_all().unwrap();
        // Base and Plus on every source; Other untouched.
        assert_eq!(stats.evaluated, 6_000);
        assert_eq!(stored(&store, "Plus", "s7"), Some(json!(71)));
        // Deleting a formula removes its values.
        store.delete_property("Other", false).unwrap();
        assert_eq!(stored(&store, "Other", "s7"), None);
        // Renaming keeps them.
        store.rename_property("Plus", "Plus one").unwrap();
        assert_eq!(stored(&store, "Plus one", "s7"), Some(json!(71)));
        assert_eq!(store.formula_recalc_all().unwrap().evaluated, 0);
    }

    #[test]
    fn formulas_that_read_the_day_refresh_when_it_changes() {
        let (_dir, store) = store();
        let id = add(&store, json!({"kind": "reference", "title": "A"}));
        store.save_property_definition("Age", &json!({"type": "formula", "formula": "days_since({Date added})"})).unwrap();
        store.save_property_definition("Old", &json!({"type": "formula", "formula": "{Age} > 30"})).unwrap();
        store.save_property_definition("Plain", &json!({"type": "formula", "formula": "{Title}"})).unwrap();
        store.formula_recalc_all().unwrap();
        assert_eq!(store.formula_recalc_all().unwrap().evaluated, 0);
        // As if the values were stored yesterday.
        store.db().unwrap().execute("UPDATE formula_props SET day = day - 1 WHERE volatile = 1", []).unwrap();
        let stats = store.formula_recalc_all().unwrap();
        assert_eq!(stats.evaluated, 2);
        assert_eq!(stored(&store, "Age", &id), Some(json!(0)));
    }
}
