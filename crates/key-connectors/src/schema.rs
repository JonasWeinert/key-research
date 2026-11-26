// The JSON Schema for connector specs (connectors/schema/connector-1.schema.json), embedded,
// and the subset of JSON Schema (2020-12) it uses: type, properties, required,
// additionalProperties, items, enum, const, pattern, minimum/maximum, minLength/maxLength,
// minItems/maxItems, anyOf/oneOf and local $ref. Editors use the same file for completion.
use regex::Regex;
use serde_json::Value as Json;
use std::sync::OnceLock;

pub const SCHEMA_TEXT: &str = include_str!("../../../connectors/schema/connector-1.schema.json");

fn schema() -> &'static Json {
    static SCHEMA: OnceLock<Json> = OnceLock::new();
    SCHEMA.get_or_init(|| serde_json::from_str(SCHEMA_TEXT).expect("the embedded connector schema is JSON"))
}

/// Problems with `value` against the connector schema, as "path: problem".
pub fn validate(value: &Json) -> Vec<String> {
    validate_with(schema(), value)
}

pub fn validate_with(root: &Json, value: &Json) -> Vec<String> {
    let mut out = Vec::new();
    check(root, root, value, "$", &mut out);
    out.truncate(50);
    out
}

fn type_name(v: &Json) -> &'static str {
    match v {
        Json::Null => "null",
        Json::Bool(_) => "boolean",
        Json::Number(n) if n.is_i64() || n.is_u64() => "integer",
        Json::Number(_) => "number",
        Json::String(_) => "string",
        Json::Array(_) => "array",
        Json::Object(_) => "object",
    }
}

fn type_ok(want: &str, v: &Json) -> bool {
    let have = type_name(v);
    want == have || (want == "number" && have == "integer")
}

fn resolve<'a>(root: &'a Json, reference: &str) -> Option<&'a Json> {
    let path = reference.strip_prefix("#/")?;
    path.split('/').try_fold(root, |node, part| node.get(part))
}

fn check(root: &Json, schema: &Json, value: &Json, at: &str, out: &mut Vec<String>) {
    if let Some(Json::Bool(false)) = Some(schema) {
        out.push(format!("{at}: not allowed"));
        return;
    }
    let Some(s) = schema.as_object() else { return };
    if let Some(r) = s.get("$ref").and_then(Json::as_str) {
        match resolve(root, r) {
            Some(target) => check(root, target, value, at, out),
            None => out.push(format!("{at}: schema reference {r} not found")),
        }
    }
    if let Some(t) = s.get("type") {
        let ok = match t {
            Json::String(t) => type_ok(t, value),
            Json::Array(list) => list.iter().filter_map(Json::as_str).any(|t| type_ok(t, value)),
            _ => true,
        };
        if !ok {
            out.push(format!("{at}: expected {}, found {}", t.as_str().map(String::from).unwrap_or_else(|| t.to_string()), type_name(value)));
            return;
        }
    }
    if let Some(c) = s.get("const") {
        if c != value {
            out.push(format!("{at}: must be {c}"));
        }
    }
    if let Some(Json::Array(options)) = s.get("enum") {
        if !options.contains(value) {
            let list: Vec<String> = options.iter().map(|o| o.to_string()).collect();
            out.push(format!("{at}: must be one of {}", list.join(", ")));
        }
    }
    for (key, any) in [("anyOf", true), ("oneOf", false)] {
        if let Some(Json::Array(options)) = s.get(key) {
            let passing = options.iter().filter(|o| {
                let mut e = Vec::new();
                check(root, o, value, at, &mut e);
                e.is_empty()
            }).count();
            if (any && passing == 0) || (!any && passing != 1) {
                // Say why the closest option failed.
                let mut best: Option<Vec<String>> = None;
                for o in options {
                    let mut e = Vec::new();
                    check(root, o, value, at, &mut e);
                    if best.as_ref().is_none_or(|b| e.len() < b.len()) {
                        best = Some(e);
                    }
                }
                match best.filter(|b| !b.is_empty()) {
                    Some(b) => out.extend(b),
                    None => out.push(format!("{at}: matches more than one form")),
                }
            }
        }
    }
    match value {
        Json::String(text) => {
            let len = text.chars().count() as u64;
            if s.get("minLength").and_then(Json::as_u64).is_some_and(|m| len < m) {
                out.push(format!("{at}: too short"));
            }
            if s.get("maxLength").and_then(Json::as_u64).is_some_and(|m| len > m) {
                out.push(format!("{at}: longer than {} characters", s["maxLength"]));
            }
            if let Some(p) = s.get("pattern").and_then(Json::as_str) {
                if Regex::new(p).map(|r| !r.is_match(text)).unwrap_or(true) {
                    out.push(format!("{at}: {text:?} does not match {p}"));
                }
            }
        }
        Json::Number(n) => {
            let v = n.as_f64().unwrap_or(0.0);
            if s.get("minimum").and_then(Json::as_f64).is_some_and(|m| v < m) {
                out.push(format!("{at}: at least {}", s["minimum"]));
            }
            if s.get("maximum").and_then(Json::as_f64).is_some_and(|m| v > m) {
                out.push(format!("{at}: at most {}", s["maximum"]));
            }
        }
        Json::Array(items) => {
            if s.get("minItems").and_then(Json::as_u64).is_some_and(|m| (items.len() as u64) < m) {
                out.push(format!("{at}: needs at least {} items", s["minItems"]));
            }
            if s.get("maxItems").and_then(Json::as_u64).is_some_and(|m| (items.len() as u64) > m) {
                out.push(format!("{at}: at most {} items", s["maxItems"]));
            }
            if let Some(item) = s.get("items") {
                for (i, v) in items.iter().enumerate() {
                    check(root, item, v, &format!("{at}[{i}]"), out);
                }
            }
        }
        Json::Object(map) => {
            if let Some(Json::Array(required)) = s.get("required") {
                for r in required.iter().filter_map(Json::as_str) {
                    if !map.contains_key(r) {
                        out.push(format!("{at}: `{r}` is required"));
                    }
                }
            }
            let props = s.get("properties").and_then(Json::as_object);
            for (k, v) in map {
                let child = format!("{at}.{k}");
                match props.and_then(|p| p.get(k)) {
                    Some(p) => check(root, p, v, &child, out),
                    None => match s.get("additionalProperties") {
                        Some(Json::Bool(false)) => out.push(format!("{child}: unknown property")),
                        Some(extra @ Json::Object(_)) => check(root, extra, v, &child, out),
                        _ => {}
                    },
                }
            }
            if s.get("maxProperties").and_then(Json::as_u64).is_some_and(|m| (map.len() as u64) > m) {
                out.push(format!("{at}: too many properties"));
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks_the_subset() {
        let s = json!({"$defs": {"id": {"type": "string", "pattern": "^[a-z]+$"}}, "type": "object", "required": ["id"], "additionalProperties": false,
            "properties": {"id": {"$ref": "#/$defs/id"}, "n": {"type": "integer", "minimum": 1}, "x": {"anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]}, "k": {"enum": ["a", "b"]}}});
        assert!(validate_with(&s, &json!({"id": "abc", "n": 2, "x": ["y"], "k": "a"})).is_empty());
        let e = validate_with(&s, &json!({"id": "A", "n": 0, "x": 3, "k": "c", "z": 1}));
        assert_eq!(e.len(), 5, "{e:?}");
        assert!(validate_with(&s, &json!({})).iter().any(|m| m.contains("`id` is required")));
    }

    #[test]
    fn the_embedded_schema_is_valid_json() {
        assert!(schema().get("$defs").is_some());
    }
}
