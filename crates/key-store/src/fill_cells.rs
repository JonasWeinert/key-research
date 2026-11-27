// What each filled value was worked out from, and what became of it. A cell (source ×
// property) keeps the AI's answer (value, recipe and its version, model, the passages it came
// from and a hash of exactly that material), the value the user typed over it (when they did),
// a few earlier answers, and whether it is out of date. `sync` follows the shared change log
// (changes.rs) as consumer "fill", reads only filled sources that changed (their details, PDF
// text, notes or highlights), works out each recipe's material again and compares hashes, so
// an edit that leaves a recipe's material alone marks nothing. Cell rows are journaled with the edit that writes
// them, so undo puts both the value and its record back.
use crate::fill::{Passage, Recipe, build_request, material, rule_value};
use crate::{Result, Store, e, now_ms, patch_source_row, refresh_fts};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Earlier AI answers kept per cell.
pub const HISTORY: usize = 5;
/// The default for automatic fills of one recipe in 24 hours, in tokens.
pub const DAILY_TOKENS: u64 = 250_000;
const DAY_MS: i64 = 86_400_000;

pub(crate) fn ensure_schema(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS fill_cells (
           source_id TEXT NOT NULL, property TEXT NOT NULL, recipe_id TEXT NOT NULL, recipe_hash TEXT NOT NULL, method TEXT NOT NULL,
           provider TEXT, model TEXT, run_id TEXT, input_hash TEXT NOT NULL, value TEXT NOT NULL, confidence REAL,
           evidence TEXT NOT NULL DEFAULT '[]', passages TEXT NOT NULL DEFAULT '[]', filled_at INTEGER NOT NULL,
           user_value TEXT, edited_at INTEGER, stale TEXT, stale_at INTEGER, history TEXT NOT NULL DEFAULT '[]',
           PRIMARY KEY (source_id, property));
         CREATE INDEX IF NOT EXISTS fill_cells_recipe ON fill_cells(recipe_id, stale);",
    )
    .map_err(e)
}

fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// The recipe's version: only what changes its answers (not its name or automation).
pub fn recipe_hash(recipe: &Recipe) -> String {
    let answer = json!([recipe.property, recipe.shape, recipe.options, recipe.method, recipe.instruction.trim(), recipe.inputs, recipe.sections, recipe.rule, recipe.budget]);
    digest(&answer.to_string())
}

/// The hash of the exact material sent.
pub fn passages_hash(passages: &[Passage]) -> String {
    digest(&passages.iter().map(|p| format!("{}\u{1f}{}", p.label, p.text)).collect::<Vec<_>>().join("\u{1e}"))
}

/// What a recipe reads on a source now, hashed: its passages; for a formula, its result.
pub(crate) fn input_hash(db: &Connection, id: &str, recipe: &Recipe) -> Result<String> {
    if recipe.method == "rule" {
        if recipe.rule.kind == "formula" {
            let value = rule_value(db, id, recipe).map(|a| a.value).unwrap_or(Json::Null);
            return Ok(digest(&value.to_string()));
        }
        return Ok(passages_hash(&material(db, id, recipe, std::slice::from_ref(&recipe.rule.input))?));
    }
    Ok(passages_hash(&material(db, id, recipe, &recipe.inputs)?))
}

fn parse(text: Option<String>) -> Json {
    text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Json::Null)
}

fn is_empty(value: &Json) -> bool {
    value.is_null() || value.as_str().is_some_and(|s| s.trim().is_empty()) || value.as_array().is_some_and(Vec::is_empty)
}

/// Values compare loosely: 40 and 40.0, or a list in another order, are the same answer.
pub(crate) fn same_value(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        (Json::Array(x), Json::Array(y)) => {
            let mut x: Vec<String> = x.iter().map(Json::to_string).collect();
            let mut y: Vec<String> = y.iter().map(Json::to_string).collect();
            x.sort();
            y.sort();
            x == y
        }
        _ => a == b || (is_empty(a) && is_empty(b)),
    }
}

fn property_value(db: &Connection, id: &str, property: &str) -> Result<Json> {
    let properties: Option<String> = db.query_row("SELECT properties FROM sources WHERE id = ?", [id], |r| r.get(0)).optional().map_err(e)?;
    Ok(properties.and_then(|p| serde_json::from_str::<Map<String, Json>>(&p).ok()).and_then(|m| m.get(property).cloned()).unwrap_or(Json::Null))
}

/// A new AI answer for a cell, from a run.
pub(crate) struct NewAnswer<'a> {
    pub source: &'a str,
    pub recipe: &'a Recipe,
    pub run: &'a str,
    pub provider: Option<&'a str>,
    pub model: Option<&'a str>,
    pub value: &'a Json,
    pub confidence: Option<f64>,
    pub evidence: &'a str,
    pub passages: &'a str,
    pub input_hash: &'a str,
}

/// What happens to the user's side of the cell.
pub(crate) enum UserSide<'a> {
    /// The answer became the value: nothing typed over it.
    Clear,
    /// The user's value stays; only the AI's answer is new.
    Keep,
    /// The user changed the proposal before accepting it (the review's edit).
    Set(&'a Json),
}

/// Records an answer; the one before it goes to the history.
pub(crate) fn record_answer(db: &Connection, answer: &NewAnswer, user: UserSide) -> Result<()> {
    // Follow changes from the first answer on.
    crate::changes::cursor(db, CONSUMER)?;
    let now = now_ms();
    let before = db
        .query_row(
            "SELECT recipe_id, model, value, evidence, filled_at, history, recipe_hash FROM fill_cells WHERE source_id = ?1 AND property = ?2",
            params![answer.source, answer.recipe.property],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?, r.get::<_, String>(5)?, r.get::<_, String>(6)?)),
        )
        .optional()
        .map_err(e)?;
    let mut history: Vec<Json> = Vec::new();
    if let Some((recipe, model, value, evidence, filled_at, earlier, recipe_version)) = before {
        history = serde_json::from_str(&earlier).unwrap_or_default();
        history.insert(
            0,
            json!({ "value": parse(Some(value)), "recipeId": recipe, "recipeHash": recipe_version, "model": model, "filledAt": filled_at, "evidence": parse(Some(evidence)) }),
        );
        history.truncate(HISTORY);
    }
    let (user_value, edited_at) = match user {
        UserSide::Clear => (None, None),
        UserSide::Set(value) => (Some(value.to_string()), Some(now)),
        UserSide::Keep => db
            .query_row("SELECT user_value, edited_at FROM fill_cells WHERE source_id = ?1 AND property = ?2", params![answer.source, answer.recipe.property], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(e)?
            .unwrap_or((None, None)),
    };
    db.execute(
        "INSERT OR REPLACE INTO fill_cells(source_id, property, recipe_id, recipe_hash, method, provider, model, run_id, input_hash, value, confidence, evidence, passages, filled_at, user_value, edited_at, stale, stale_at, history)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, NULL, NULL, ?17)",
        params![
            answer.source,
            answer.recipe.property,
            answer.recipe.id,
            recipe_hash(answer.recipe),
            answer.recipe.method,
            answer.provider,
            answer.model,
            answer.run,
            answer.input_hash,
            answer.value.to_string(),
            answer.confidence,
            answer.evidence,
            answer.passages,
            now,
            user_value,
            edited_at,
            serde_json::to_string(&history).map_err(e)?,
        ],
    )
    .map_err(e)?;
    Ok(())
}

/// A cell's state for a run: whether it exists for this recipe and whether the user edited it.
pub(crate) fn cell_state(db: &Connection, source: &str, recipe: &Recipe) -> Result<Option<bool>> {
    db.query_row("SELECT edited_at IS NOT NULL FROM fill_cells WHERE source_id = ?1 AND property = ?2 AND recipe_id = ?3", params![source, recipe.property, recipe.id], |r| r.get(0))
        .optional()
        .map_err(e)
}

/// This module's name in the shared change log.
const CONSUMER: &str = "fill";
/// Changes that never alter what a recipe reads or a cell's value.
const IGNORED: &[&str] = &["reading", "cited", "references", "collections", "added", "starred", "readState", "citedByCount", "fwci"];

/// Brings cells up to date with the sources that changed: edits by hand are noted, and an
/// answer whose material (or recipe) changed is marked out of date. Returns the sources read.
pub(crate) fn sync(db: &Connection, recipes: &[Recipe], limit: usize) -> Result<usize> {
    let log = crate::changes::read_since(db, CONSUMER, limit)?;
    let Some(last) = log.last().map(|c| c.seq) else { return Ok(0) };
    let at = now_ms();
    let mut changed: Vec<String> = Vec::new();
    for change in &log {
        if change.kind == "removed" {
            db.execute("DELETE FROM fill_cells WHERE source_id = ?", [&change.source_id]).map_err(e)?;
        } else if !IGNORED.contains(&change.kind.as_str()) && !changed.contains(&change.source_id) {
            changed.push(change.source_id.clone());
        }
    }
    let by_id: HashMap<&str, &Recipe> = recipes.iter().map(|r| (r.id.as_str(), r)).collect();
    for source in &changed {
        crate::priority::yield_if_needed();
        let cells: Vec<(String, String, String, String, Option<String>, Option<i64>, Option<String>, String)> = {
            let mut statement = db
                .prepare_cached("SELECT property, recipe_id, input_hash, value, user_value, edited_at, stale, recipe_hash FROM fill_cells WHERE source_id = ?")
                .map_err(e)?;
            let rows = statement.query_map([source], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))).map_err(e)?;
            rows.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        for (property, recipe_id, stored_hash, value, user_value, edited_at, stale, version) in cells {
            let current = property_value(db, source, &property)?;
            let answer = parse(Some(value));
            if same_value(&current, &answer) {
                if edited_at.is_some() {
                    db.execute("UPDATE fill_cells SET user_value = NULL, edited_at = NULL WHERE source_id = ?1 AND property = ?2", params![source, property]).map_err(e)?;
                }
            } else if edited_at.is_none() || !same_value(&parse(user_value), &current) {
                db.execute("UPDATE fill_cells SET user_value = ?3, edited_at = ?4 WHERE source_id = ?1 AND property = ?2", params![source, property, current.to_string(), at]).map_err(e)?;
            }
            let Some(recipe) = by_id.get(recipe_id.as_str()) else { continue };
            let reason = if recipe.on_change == "nothing" {
                None
            } else if version != recipe_hash(recipe) {
                Some("recipe")
            } else {
                match input_hash(db, source, recipe) {
                    Ok(hash) if hash != stored_hash => Some("inputs"),
                    Ok(_) => None,
                    Err(_) => stale.as_deref().map(|_| "inputs"),
                }
            };
            match (reason, stale.as_deref()) {
                (Some(reason), _) => {
                    db.execute("UPDATE fill_cells SET stale = ?3, stale_at = ?4 WHERE source_id = ?1 AND property = ?2", params![source, property, reason, at]).map_err(e)?;
                }
                (None, Some(_)) => {
                    db.execute("UPDATE fill_cells SET stale = NULL, stale_at = NULL WHERE source_id = ?1 AND property = ?2", params![source, property]).map_err(e)?;
                }
                (None, None) => {}
            }
        }
    }
    crate::changes::ack(db, CONSUMER, last)?;
    Ok(log.len())
}

/// A saved recipe changed: its cells from another version are out of date (or no longer,
/// when it is changed back); a recipe set to do nothing marks none.
pub(crate) fn recipe_changed(db: &Connection, recipe: &Recipe) -> Result<()> {
    if recipe.on_change == "nothing" {
        db.execute("UPDATE fill_cells SET stale = NULL, stale_at = NULL WHERE recipe_id = ?1", [&recipe.id]).map_err(e)?;
        return Ok(());
    }
    let version = recipe_hash(recipe);
    db.execute("UPDATE fill_cells SET stale = 'recipe', stale_at = ?3 WHERE recipe_id = ?1 AND recipe_hash <> ?2", params![recipe.id, version, now_ms()]).map_err(e)?;
    db.execute("UPDATE fill_cells SET stale = NULL, stale_at = NULL WHERE recipe_id = ?1 AND recipe_hash = ?2 AND stale = 'recipe'", params![recipe.id, version]).map_err(e)?;
    Ok(())
}

/// Tokens a recipe's automatic runs used in the last 24 hours.
pub(crate) fn tokens_today(db: &Connection, recipe_id: &str) -> Result<u64> {
    db.query_row(
        "SELECT coalesce(sum(tokens_in + tokens_out), 0) FROM fill_runs WHERE recipe_id = ?1 AND auto = 1 AND created_at > ?2",
        params![recipe_id, now_ms() - DAY_MS],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n.max(0) as u64)
    .map_err(e)
}

/// About how many tokens one source costs with this recipe (characters / 4, half the answer).
pub(crate) fn tokens_for(db: &Connection, id: &str, recipe: &Recipe) -> Result<u64> {
    if recipe.method == "rule" {
        return Ok(0);
    }
    let request = build_request(recipe, &material(db, id, recipe, &recipe.inputs)?);
    let input = request["prompt"].as_str().map_or(0, str::len) + request["system"].as_str().map_or(0, str::len);
    Ok((input / 4) as u64 + request["maxTokens"].as_u64().unwrap_or(200) / 2)
}

impl Store {
    /// Applies pending change notes to the cells (bounded; the rest wait for the next call).
    pub fn fill_sync(&self) -> Result<usize> {
        let recipes = self.fill_recipes()?;
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let n = sync(&tx, &recipes, 400)?;
        tx.commit().map_err(e)?;
        Ok(n)
    }

    /// The cells to mark in the table (out of date, or edited), and per recipe how many are
    /// out of date.
    pub fn fill_marks(&self) -> Result<Json> {
        self.fill_sync()?;
        let recipes = self.fill_recipes()?;
        let db = self.read()?;
        let mut cells: Map<String, Json> = Map::new();
        let mut statement = db
            .prepare("SELECT source_id, property, recipe_id, stale IS NOT NULL, edited_at IS NOT NULL FROM fill_cells WHERE stale IS NOT NULL OR edited_at IS NOT NULL LIMIT 20000")
            .map_err(e)?;
        let rows = statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?, r.get::<_, bool>(4)?))).map_err(e)?;
        let mut stale: HashMap<String, (u64, Vec<String>)> = HashMap::new();
        for row in rows {
            let (source, property, recipe, is_stale, edited) = row.map_err(e)?;
            if is_stale && !edited {
                let entry = stale.entry(recipe.clone()).or_default();
                entry.0 += 1;
                entry.1.push(source.clone());
            }
            let entry = cells.entry(source).or_insert_with(|| json!({}));
            entry[&property] = json!({ "stale": is_stale, "edited": edited, "recipe": recipe });
        }
        let recipes: Vec<Json> = recipes
            .iter()
            .filter_map(|r| stale.get(&r.id).map(|(n, ids)| json!({ "id": r.id, "name": r.name, "property": r.property, "onChange": r.on_change, "stale": n, "ids": ids })))
            .collect();
        Ok(json!({ "cells": cells, "recipes": recipes }))
    }

    /// The AI-filled cells of one source (for its details panel).
    pub fn fill_source_cells(&self, id: &str) -> Result<Json> {
        self.fill_sync()?;
        let db = self.read()?;
        let mut statement = db.prepare("SELECT property, stale IS NOT NULL, edited_at IS NOT NULL, recipe_id FROM fill_cells WHERE source_id = ?").map_err(e)?;
        let rows = statement.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?, r.get::<_, bool>(2)?, r.get::<_, String>(3)?))).map_err(e)?;
        let mut out = Map::new();
        for row in rows {
            let (property, stale, edited, recipe) = row.map_err(e)?;
            out.insert(property, json!({ "stale": stale, "edited": edited, "recipe": recipe }));
        }
        Ok(Json::Object(out))
    }

    /// Everything kept about one cell: the AI's answer and where it came from, the user's
    /// value, whether it is out of date, and the earlier answers.
    pub fn fill_cell(&self, id: &str, property: &str) -> Result<Json> {
        self.fill_sync()?;
        let recipes = self.fill_recipes()?;
        let db = self.read()?;
        let row = db
            .query_row(
                "SELECT recipe_id, method, provider, model, value, confidence, evidence, passages, filled_at, user_value, edited_at, stale, stale_at, history, run_id FROM fill_cells WHERE source_id = ?1 AND property = ?2",
                params![id, property],
                |r| {
                    Ok(json!({
                        "recipeId": r.get::<_, String>(0)?, "method": r.get::<_, String>(1)?, "provider": r.get::<_, Option<String>>(2)?, "model": r.get::<_, Option<String>>(3)?,
                        "value": parse(r.get(4)?), "confidence": r.get::<_, Option<f64>>(5)?, "evidence": parse(r.get(6)?), "passages": parse(r.get(7)?), "filledAt": r.get::<_, i64>(8)?,
                        "userValue": parse(r.get(9)?), "editedAt": r.get::<_, Option<i64>>(10)?, "edited": r.get::<_, Option<i64>>(10)?.is_some(),
                        "stale": r.get::<_, Option<String>>(11)?, "staleAt": r.get::<_, Option<i64>>(12)?, "history": parse(r.get(13)?), "runId": r.get::<_, Option<String>>(14)?,
                    }))
                },
            )
            .optional()
            .map_err(e)?;
        let Some(mut cell) = row else { return Ok(Json::Null) };
        let recipe = recipes.iter().find(|r| Some(r.id.as_str()) == cell["recipeId"].as_str());
        cell["recipe"] = recipe.map_or(Json::Null, |r| json!({ "id": r.id, "name": r.name, "onChange": r.on_change, "method": r.method }));
        cell["current"] = property_value(&db, id, property)?;
        cell["property"] = json!(property);
        cell["sourceId"] = json!(id);
        Ok(cell)
    }

    /// "Use AI answer again": the AI's answer becomes the value again (undoable).
    pub fn fill_cell_use_answer(&self, id: &str, property: &str) -> Result<Json> {
        let ids = vec![id.to_string()];
        let ((), entry) = self.journaled("fill", &format!("Use the AI answer for “{property}”"), &ids, |db, rec| {
            rec.watch_in(db, "fill_cells", "source_id", &ids)?;
            let value: Option<String> = db.query_row("SELECT value FROM fill_cells WHERE source_id = ?1 AND property = ?2", params![id, property], |r| r.get(0)).optional().map_err(e)?;
            let value = parse(Some(value.ok_or("This value has no AI answer")?));
            let mut properties = Map::new();
            properties.insert(property.to_string(), value);
            let mut patch = Map::new();
            patch.insert("properties".into(), Json::Object(properties));
            patch_source_row(db, id, &patch, now_ms())?;
            crate::properties::sync_choices(db, id)?;
            refresh_fts(db, id)?;
            db.execute("UPDATE fill_cells SET user_value = NULL, edited_at = NULL WHERE source_id = ?1 AND property = ?2", params![id, property]).map_err(e)?;
            Ok(())
        })?;
        Ok(json!({ "entry": entry }))
    }

    /// "Keep mine": the user's value stays and the cell is no longer marked out of date.
    pub fn fill_cell_keep(&self, id: &str, property: &str) -> Result<Json> {
        let ids = vec![id.to_string()];
        let ((), entry) = self.journaled("fill", &format!("Keep your value for “{property}”"), &ids, |db, rec| {
            rec.watch_in(db, "fill_cells", "source_id", &ids)?;
            db.execute("UPDATE fill_cells SET stale = NULL, stale_at = NULL WHERE source_id = ?1 AND property = ?2", params![id, property]).map_err(e)?;
            Ok(())
        })?;
        Ok(json!({ "entry": entry }))
    }

    /// Out-of-date cells of a recipe (among `ids` when given): what "Fill again" runs over.
    pub fn fill_again_ids(&self, recipe_id: &str, ids: &[String], include_edited: bool) -> Result<Vec<String>> {
        self.fill_sync()?;
        let db = self.read()?;
        let mut statement = db
            .prepare("SELECT source_id FROM fill_cells WHERE recipe_id = ?1 AND stale IS NOT NULL AND (?2 OR edited_at IS NULL) ORDER BY stale_at LIMIT 20000")
            .map_err(e)?;
        let rows = statement.query_map(params![recipe_id, include_edited], |r| r.get::<_, String>(0)).map_err(e)?;
        let all: Vec<String> = rows.collect::<std::result::Result<_, _>>().map_err(e)?;
        Ok(if ids.is_empty() { all } else { all.into_iter().filter(|id| ids.contains(id)).collect() })
    }
}

#[cfg(test)]
mod tests {
    use crate::fill::{Recipe, Rule};
    use crate::{SourceInput, Store};
    use serde_json::{Map, Value as Json, json};

    fn add(store: &Store, title: &str, abstract_text: &str) -> String {
        let input: SourceInput = serde_json::from_value(json!({"kind": "reference", "title": title, "abstract": abstract_text})).unwrap();
        store.insert_source(input).unwrap().id
    }

    fn patch(value: Json) -> Map<String, Json> {
        serde_json::from_value(value).unwrap()
    }

    fn ai_recipe(store: &Store, on_change: &str) -> Recipe {
        store
            .save_fill_recipe(Recipe {
                property: "Sample size".into(),
                shape: "number".into(),
                method: "ai".into(),
                instruction: "How many?".into(),
                inputs: vec!["abstract".into()],
                on_change: on_change.into(),
                ..Default::default()
            })
            .unwrap()
    }

    /// Runs a recipe over ids with the given answers and accepts them all.
    fn fill(store: &Store, recipe: &Recipe, ids: &[String], answers: &[&str], again: bool, auto: bool) -> String {
        let run = store.fill_run_create_again(recipe.clone(), ids, false, auto, again, Some("mock"), Some("m1")).unwrap();
        let next = store.fill_run_next(&run.id, 10).unwrap();
        for (request, answer) in next["requests"].as_array().unwrap().iter().zip(answers) {
            store.fill_run_answer(&run.id, request["sourceId"].as_str().unwrap(), Some(answer), None, (100, 10)).unwrap();
        }
        if !auto {
            store.fill_review(&run.id, &[], &[], &Map::new(), true).unwrap();
        }
        run.id
    }

    #[test]
    fn hashes_follow_the_material_and_the_recipe_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = add(&store, "Alpha", "A trial with n = 40.");
        let recipe = ai_recipe(&store, "mark");
        let db = store.read().unwrap();
        let first = super::input_hash(&db, &a, &recipe).unwrap();
        assert_eq!(first, super::input_hash(&db, &a, &recipe).unwrap());
        drop(db);
        store.update_source(&a, &patch(json!({"abstract": "A trial with n = 41."}))).unwrap();
        assert_ne!(first, super::input_hash(&store.read().unwrap(), &a, &recipe).unwrap());
        let renamed = Recipe { name: "Another name".into(), on_change: "refill".into(), auto: true, ..recipe.clone() };
        assert_eq!(super::recipe_hash(&recipe), super::recipe_hash(&renamed));
        let changed = Recipe { instruction: "How many adults?".into(), ..recipe.clone() };
        assert_ne!(super::recipe_hash(&recipe), super::recipe_hash(&changed));
    }

    #[test]
    fn only_a_change_to_what_the_recipe_reads_marks_a_cell_out_of_date() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = add(&store, "Alpha", "A trial with n = 40.");
        let recipe = ai_recipe(&store, "mark");
        fill(&store, &recipe, std::slice::from_ref(&a), &["{\"value\": 40}"], false, false);
        assert_eq!(store.fill_cell(&a, "Sample size").unwrap()["value"], json!(40));
        // The title is not read by this recipe (abstract only): nothing goes out of date.
        store.update_source(&a, &patch(json!({"title": "Alpha, revised"}))).unwrap();
        assert_eq!(store.fill_marks().unwrap()["cells"], json!({}));
        // The abstract is.
        store.update_source(&a, &patch(json!({"abstract": "A trial with n = 44."}))).unwrap();
        let marks = store.fill_marks().unwrap();
        assert_eq!(marks["cells"][&a]["Sample size"]["stale"], json!(true));
        assert_eq!(marks["recipes"][0]["stale"], json!(1));
        assert_eq!(store.fill_cell(&a, "Sample size").unwrap()["stale"], json!("inputs"));
        // Changed back: up to date again.
        store.update_source(&a, &patch(json!({"abstract": "A trial with n = 40."}))).unwrap();
        assert_eq!(store.fill_marks().unwrap()["cells"], json!({}));
        // A new instruction makes every answer of the recipe out of date; a new name does not.
        store.save_fill_recipe(Recipe { name: "Renamed".into(), ..recipe.clone() }).unwrap();
        assert_eq!(store.fill_marks().unwrap()["cells"], json!({}));
        store.save_fill_recipe(Recipe { instruction: "How many adults?".into(), ..recipe.clone() }).unwrap();
        assert_eq!(store.fill_cell(&a, "Sample size").unwrap()["stale"], json!("recipe"));
        // A recipe told to do nothing marks nothing.
        store.save_fill_recipe(Recipe { on_change: "nothing".into(), instruction: "How many adults?".into(), ..recipe }).unwrap();
        store.update_source(&a, &patch(json!({"abstract": "Changed again."}))).unwrap();
        assert_eq!(store.fill_marks().unwrap()["cells"], json!({}));
    }

    #[test]
    fn notes_and_highlights_count_when_the_recipe_reads_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = add(&store, "Alpha", "");
        let recipe = store
            .save_fill_recipe(Recipe { property: "Gist".into(), shape: "text".into(), method: "ai".into(), instruction: "Gist".into(), inputs: vec!["notes".into(), "highlights".into()], ..Default::default() })
            .unwrap();
        let note = store.save_note(None, Some(&a), "First", "It works.", None).unwrap();
        store.apply_annotations(&a, &[json!({"id": "h1", "text": "works well"})], &[]).unwrap();
        fill(&store, &recipe, std::slice::from_ref(&a), &["{\"value\": \"Works\"}"], false, false);
        assert_eq!(store.fill_marks().unwrap()["cells"], json!({}));
        // A note's body edited.
        store.save_note(Some(&note.id), Some(&a), "First", "It does not.", None).unwrap();
        assert_eq!(store.fill_marks().unwrap()["cells"][&a]["Gist"]["stale"], json!(true));
        store.save_note(Some(&note.id), Some(&a), "First", "It works.", None).unwrap();
        assert_eq!(store.fill_marks().unwrap()["cells"], json!({}));
        // A highlight's comment edited.
        store.apply_annotations(&a, &[json!({"id": "h1", "text": "works well", "comment": "but slowly"})], &[]).unwrap();
        assert_eq!(store.fill_marks().unwrap()["cells"][&a]["Gist"]["stale"], json!(true));
        // A new note.
        store.save_note(None, Some(&a), "Second", "Another.", None).unwrap();
        assert_eq!(store.fill_marks().unwrap()["cells"][&a]["Gist"]["stale"], json!(true));
    }

    #[test]
    fn edits_keep_both_values_and_history_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = add(&store, "Alpha", "n = 40");
        let recipe = ai_recipe(&store, "mark");
        fill(&store, &recipe, std::slice::from_ref(&a), &["{\"value\": 40, \"evidence\": [{\"passage\": \"P1\", \"quote\": \"n = 40\"}]}"], false, false);
        store.edit_sources(std::slice::from_ref(&a), &serde_json::from_value(json!({"patch": {"properties": {"Sample size": 42}}, "byHand": true})).unwrap(), None).unwrap();
        let cell = store.fill_cell(&a, "Sample size").unwrap();
        assert_eq!((cell["value"].clone(), cell["userValue"].clone(), cell["edited"].clone()), (json!(40), json!(42), json!(true)));
        assert_eq!(cell["evidence"][0]["quote"], json!("n = 40"));
        assert_eq!(cell["passages"][0]["label"], json!("Abstract"));
        // Use the AI answer again, then undo that: the edit comes back, both sides kept.
        store.fill_cell_use_answer(&a, "Sample size").unwrap();
        assert_eq!(store.source(&a).unwrap().unwrap().properties["Sample size"], json!(40));
        assert_eq!(store.fill_cell(&a, "Sample size").unwrap()["edited"], json!(false));
        store.undo().unwrap();
        assert_eq!(store.source(&a).unwrap().unwrap().properties["Sample size"], json!(42));
        let cell = store.fill_cell(&a, "Sample size").unwrap();
        assert_eq!((cell["value"].clone(), cell["userValue"].clone()), (json!(40), json!(42)));
        // Fill again, many times: the user's value stays, the history keeps the last five.
        for n in 0..7 {
            store.update_source(&a, &patch(json!({"abstract": format!("n = {}", 50 + n)}))).unwrap();
            let ids = store.fill_again_ids(&recipe.id, &[], true).unwrap();
            assert_eq!(ids, vec![a.clone()]);
            fill(&store, &recipe, &ids, &[&format!("{{\"value\": {}}}", 50 + n)], true, false);
        }
        let cell = store.fill_cell(&a, "Sample size").unwrap();
        assert_eq!((cell["value"].clone(), cell["userValue"].clone(), cell["stale"].clone()), (json!(56), json!(42), Json::Null));
        assert_eq!(cell["history"].as_array().unwrap().len(), super::HISTORY);
        assert_eq!(cell["history"][0]["value"], json!(55));
        assert_eq!(store.source(&a).unwrap().unwrap().properties["Sample size"], json!(42));
    }

    #[test]
    fn a_review_edit_records_both_and_undo_takes_the_cell_back() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = add(&store, "Alpha", "n = 40");
        let recipe = ai_recipe(&store, "mark");
        let run = store.fill_run_create_again(recipe.clone(), std::slice::from_ref(&a), false, false, false, Some("mock"), Some("m1")).unwrap();
        store.fill_run_next(&run.id, 10).unwrap();
        store.fill_run_answer(&run.id, &a, Some("{\"value\": 40}"), None, (1, 1)).unwrap();
        let edits: Map<String, Json> = [(a.clone(), json!(39))].into_iter().collect();
        store.fill_review(&run.id, &[], &[], &edits, false).unwrap();
        let cell = store.fill_cell(&a, "Sample size").unwrap();
        assert_eq!((cell["value"].clone(), cell["userValue"].clone(), cell["current"].clone()), (json!(40), json!(39), json!(39)));
        store.fill_run_undo(&run.id).unwrap();
        assert_eq!(store.fill_cell(&a, "Sample size").unwrap(), Json::Null);
        assert!(store.source(&a).unwrap().unwrap().properties.get("Sample size").is_none());
    }

    #[test]
    fn automatic_refills_never_overwrite_edits_and_stop_at_the_daily_limit() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = add(&store, "Alpha", "n = 40");
        let b = add(&store, "Beta", "n = 50");
        let mut recipe = ai_recipe(&store, "refill");
        fill(&store, &recipe, &[a.clone(), b.clone()], &["{\"value\": 40}", "{\"value\": 50}"], false, false);
        // Beta's value is edited by hand; both abstracts change.
        store.update_source(&b, &patch(json!({"properties": {"Sample size": 55}}))).unwrap();
        store.update_source(&a, &patch(json!({"abstract": "n = 41"}))).unwrap();
        store.update_source(&b, &patch(json!({"abstract": "n = 51"}))).unwrap();
        // Still settling: nothing yet.
        assert_eq!(store.fill_auto_candidates_settled(10, 60_000).unwrap(), json!([]));
        let candidates = store.fill_auto_candidates_settled(10, 0).unwrap();
        assert_eq!(candidates[0]["ids"], json!([a.clone()]));
        assert_eq!(candidates[0]["again"], json!(true));
        // The automatic run writes directly, and leaves the edited value alone even if asked.
        let run = fill(&store, &recipe, &[a.clone(), b.clone()], &["{\"value\": 41}"], true, true);
        assert_eq!(store.source(&a).unwrap().unwrap().properties["Sample size"], json!(41));
        assert_eq!(store.source(&b).unwrap().unwrap().properties["Sample size"], json!(55));
        assert_eq!(store.fill_run_summary(&run).unwrap().counts["skipped"], json!(1));
        assert_eq!(store.fill_cell(&a, "Sample size").unwrap()["history"][0]["value"], json!(40));
        // The daily limit: the tokens used so far leave no room for another source.
        store.db().unwrap().execute("UPDATE fill_runs SET tokens_in = 950 WHERE id = ?", [&run]).unwrap();
        recipe.daily_tokens = 1_000;
        recipe = store.save_fill_recipe(recipe).unwrap();
        store.update_source(&a, &patch(json!({"abstract": "n = 42"}))).unwrap();
        let capped = store.fill_auto_candidates_settled(10, 0).unwrap();
        assert_eq!((capped[0]["ids"].clone(), capped[0]["capped"].clone()), (json!([]), json!(true)));
        recipe.daily_tokens = 1_000_000;
        store.save_fill_recipe(recipe).unwrap();
        assert_eq!(store.fill_auto_candidates_settled(10, 0).unwrap()[0]["ids"], json!([a.clone()]));
        // Undo the automatic run: the earlier answer and value come back.
        store.fill_run_undo(&run).unwrap();
        assert_eq!(store.source(&a).unwrap().unwrap().properties["Sample size"], json!(40));
        assert_eq!(store.fill_cell(&a, "Sample size").unwrap()["value"], json!(40));
    }

    #[test]
    fn rule_recipes_go_out_of_date_when_their_result_would_change() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let a = add(&store, "Alpha", "");
        let recipe = store
            .save_fill_recipe(Recipe { property: "Shout".into(), shape: "text".into(), method: "rule".into(), rule: Rule { kind: "formula".into(), formula: "upper({Title})".into(), ..Default::default() }, ..Default::default() })
            .unwrap();
        fill(&store, &recipe, std::slice::from_ref(&a), &[], false, false);
        assert_eq!(store.source(&a).unwrap().unwrap().properties["Shout"], json!("ALPHA"));
        store.update_source(&a, &patch(json!({"abstract": "Not read"}))).unwrap();
        assert_eq!(store.fill_marks().unwrap()["cells"], json!({}));
        store.update_source(&a, &patch(json!({"title": "Beta"}))).unwrap();
        assert_eq!(store.fill_marks().unwrap()["cells"][&a]["Shout"]["stale"], json!(true));
    }
}
