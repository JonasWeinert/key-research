// Maintenance tool for connector specs (wrapped by tools/connectors/*):
//   validate [files...]                 check specs against the schema and the engine
//   test [--live|--record] [--id X] [--report out.json]
//                                        run embedded tests on fixtures (default) or live
//   translate <id> <query.json>          print the native query and warnings
//   bundle --out DIR --sequence N        index + spec files (unsigned)
//   sign --dir DIR [--key FILE]          sign DIR/index.json (key: --key, or the
//                                        KEY_CONNECTORS_SIGNING_KEY environment variable)
//   certify --root FILE --key FILE --not-before T --not-after T [--out keys.json]
//   keygen --out FILE [--note TEXT]      a new Ed25519 key file (secret: never commit it)
//   verify --dir DIR [--dev]             verify a bundle as the app would
//   dev-bundle --out DIR --sequence N    bundle signed with the public dev keys (smokes)
use key_connectors::bundle::{self, KeyFile, Keys, Trust};
use key_connectors::engine::{Credentials, Engine, RunControl};
use key_connectors::fixtures::{Fixture, Recorder, Replay};
use key_connectors::net::SafeTransport;
use key_connectors::spec::Spec;
use key_connectors::{query, testing};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

fn root() -> PathBuf {
    // tools/connectors run from the repository root; fall back to the crate's location.
    let here = PathBuf::from("connectors");
    if here.exists() { PathBuf::from(".") } else { Path::new(env!("CARGO_MANIFEST_DIR")).join("../..") }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn spec_files(args: &[String]) -> Vec<PathBuf> {
    let explicit: Vec<PathBuf> = args.iter().filter(|a| a.ends_with(".json")).map(PathBuf::from).collect();
    if !explicit.is_empty() {
        return explicit;
    }
    let dir = flag(args, "--specs").map(PathBuf::from).unwrap_or_else(|| root().join("connectors/specs"));
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).map(|d| d.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect()).unwrap_or_default();
    files.sort();
    files
}

fn load(path: &Path) -> Result<Spec, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Spec::parse(&text).map_err(|p| format!("{}:\n  {}", path.display(), p.join("\n  ")))
}

fn validate(args: &[String]) -> ExitCode {
    let mut bad = 0;
    let files = spec_files(args);
    for path in &files {
        match load(path) {
            Ok(spec) => {
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
                if stem != spec.id {
                    bad += 1;
                    eprintln!("{}: the file name must be the id ({}.json)", path.display(), spec.id);
                } else {
                    println!("ok    {} {}", spec.id, spec.version);
                }
            }
            Err(e) => {
                bad += 1;
                eprintln!("FAIL  {e}");
            }
        }
    }
    println!("{} specs, {} with problems", files.len(), bad);
    if bad == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

/// Credentials for live tests: KEY_CONNECTOR_<SECRET> (e.g. KEY_CONNECTOR_ELSEVIER).
fn creds_from_env(spec: &Spec) -> Credentials {
    spec.credentials
        .iter()
        .filter_map(|c| {
            let var = format!("KEY_CONNECTOR_{}", c.secret.to_ascii_uppercase().replace(['-', '.'], "_"));
            std::env::var(var).ok().filter(|v| !v.trim().is_empty()).map(|v| (c.id.clone(), v.trim().to_string()))
        })
        .collect()
}

fn fixture_path(id: &str, name: &str) -> PathBuf {
    root().join("connectors/fixtures").join(id).join(format!("{name}.json"))
}

fn test(args: &[String]) -> ExitCode {
    let live = has(args, "--live") || has(args, "--record");
    let record = has(args, "--record");
    let only = flag(args, "--id");
    let mut outcomes = Vec::new();
    let mut failed = 0;
    for path in spec_files(args) {
        let spec = match load(&path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("FAIL  {e}");
                failed += 1;
                continue;
            }
        };
        if only.as_ref().is_some_and(|o| *o != spec.id) {
            continue;
        }
        let creds = creds_from_env(&spec);
        let missing_required = spec.credentials.iter().any(|c| c.required && !creds.contains_key(&c.id));
        for t in &spec.tests {
            if live && t.offline_only {
                continue;
            }
            if live && missing_required {
                println!("skip  {} / {}: no credentials (set KEY_CONNECTOR_<SECRET>)", spec.id, t.name);
                continue;
            }
            let fixture_name = t.fixture.clone().unwrap_or_else(|| t.name.clone());
            let (engine, recorder) = if live {
                let recorder = Arc::new(Recorder::new(Arc::new(SafeTransport::from_env())));
                (Engine::new(recorder.clone()), Some(recorder))
            } else {
                let text = match std::fs::read_to_string(fixture_path(&spec.id, &fixture_name)) {
                    Ok(t) => t,
                    Err(_) if spec.kind == "manual" => String::from("{}"),
                    Err(_) => {
                        println!("skip  {} / {}: no fixture (record with --record)", spec.id, t.name);
                        continue;
                    }
                };
                let fixture: Fixture = match serde_json::from_str(&text) {
                    Ok(f) => f,
                    Err(e) => {
                        eprintln!("FAIL  {} / {}: fixture: {e}", spec.id, t.name);
                        failed += 1;
                        continue;
                    }
                };
                (Engine::new(Arc::new(Replay::new(&[fixture]))), None)
            };
            if let Ok(mailto) = std::env::var("KEY_CONNECTORS_MAILTO") {
                *engine.mailto.lock().unwrap() = Some(mailto);
            }
            let ctl = if live { RunControl::new(key_connectors::engine::CancellationToken::active()) } else { RunControl::instant() };
            let outcome = testing::run_test(&engine, &spec, t, &creds, &ctl);
            if outcome.passed {
                println!("ok    {} / {}: total {:?}, {} records, {} requests", spec.id, t.name, outcome.total, outcome.records, outcome.requests);
                if let (true, Some(recorder)) = (record, recorder) {
                    let path = fixture_path(&spec.id, &fixture_name);
                    let _ = std::fs::create_dir_all(path.parent().unwrap());
                    std::fs::write(&path, serde_json::to_string_pretty(&recorder.fixture()).unwrap_or_default()).ok();
                    println!("      recorded {}", path.display());
                }
            } else {
                failed += 1;
                println!("FAIL  {} / {}:\n      {}", spec.id, t.name, outcome.failures.join("\n      "));
            }
            outcomes.push(outcome);
        }
    }
    if let Some(out) = flag(args, "--report") {
        std::fs::write(&out, serde_json::to_string_pretty(&outcomes).unwrap_or_default()).ok();
    }
    println!("{} tests, {} failed", outcomes.len(), failed);
    if failed == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

fn translate(args: &[String]) -> ExitCode {
    let (Some(id), Some(file)) = (args.first(), args.get(1)) else {
        eprintln!("usage: translate <id> <query.json>");
        return ExitCode::FAILURE;
    };
    let spec = match load(&root().join("connectors/specs").join(format!("{id}.json"))) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let query: query::Query = match std::fs::read_to_string(file).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
        Ok(q) => q,
        Err(e) => {
            eprintln!("{file}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let t = query::translate(&spec, &query, &Default::default());
    println!("{}", serde_json::to_string_pretty(&t).unwrap_or_default());
    ExitCode::SUCCESS
}

fn read_key(args: &[String], flag_name: &str, env: &str) -> Result<KeyFile, String> {
    let text = match flag(args, flag_name) {
        Some(path) => std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?,
        None => std::env::var(env).map_err(|_| format!("give {flag_name} FILE or set {env}"))?,
    };
    serde_json::from_str(&text).map_err(|e| format!("not a key file: {e}"))
}

fn now_text() -> String {
    key_connectors::time::format(key_connectors::time::now_secs())
}

fn run() -> Result<ExitCode, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first() else {
        eprintln!("commands: validate, test, translate, bundle, sign, certify, keygen, verify, dev-bundle");
        return Ok(ExitCode::FAILURE);
    };
    let rest = &args[1..];
    match command.as_str() {
        "validate" => Ok(validate(rest)),
        "test" => Ok(test(rest)),
        "translate" => Ok(translate(rest)),
        "bundle" | "dev-bundle" => {
            let out = PathBuf::from(flag(rest, "--out").ok_or("--out DIR")?);
            let sequence: u64 = flag(rest, "--sequence").ok_or("--sequence N")?.parse().map_err(|_| "--sequence is a number")?;
            let specs = flag(rest, "--specs").map(PathBuf::from).unwrap_or_else(|| root().join("connectors/specs"));
            let _ = std::fs::remove_dir_all(&out);
            let index = bundle::build(&specs, &out, sequence, &now_text())?;
            println!("bundle {} with {} connectors in {}", index.sequence, index.connectors.len(), out.display());
            if command == "dev-bundle" {
                let key = bundle::dev_signing();
                let cert = bundle::certify(&bundle::dev_root(), &key.verifying_key(), "2020-01-01T00:00:00Z", "2099-01-01T00:00:00Z");
                bundle::sign_dir(&out, &key, &Keys { keys: vec![cert] })?;
                println!("signed with the PUBLIC dev key (trusted only with KEY_CONNECTORS_DEV_TRUST=1)");
            }
            Ok(ExitCode::SUCCESS)
        }
        "sign" => {
            let dir = PathBuf::from(flag(rest, "--dir").ok_or("--dir DIR")?);
            let key = read_key(rest, "--key", "KEY_CONNECTORS_SIGNING_KEY")?.signing_key()?;
            let certs: Keys = match flag(rest, "--certs").or_else(|| std::env::var("KEY_CONNECTORS_CERTS_FILE").ok()) {
                Some(path) => serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?).map_err(|e| e.to_string())?,
                None => {
                    let fallback = root().join("connectors/keys.json");
                    std::fs::read_to_string(&fallback).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
                }
            };
            let sig = bundle::sign_dir(&dir, &key, &certs)?;
            println!("signed {} with key {}", dir.join("index.json").display(), sig.key_id);
            Ok(ExitCode::SUCCESS)
        }
        "certify" => {
            let root_key = read_key(rest, "--root", "KEY_CONNECTORS_ROOT_KEY")?.signing_key()?;
            let key_file: KeyFile = serde_json::from_str(&std::fs::read_to_string(flag(rest, "--key").ok_or("--key FILE (the signing key file or its .pub.json)")?).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            let public = bundle::verifying_key(&key_file.public_key)?;
            let cert = bundle::certify(&root_key, &public, &flag(rest, "--not-before").unwrap_or_else(now_text), &flag(rest, "--not-after").ok_or("--not-after T (e.g. 2027-12-31T00:00:00Z)")?);
            let out = flag(rest, "--out").map(PathBuf::from).unwrap_or_else(|| root().join("connectors/keys.json"));
            let mut keys: Keys = std::fs::read_to_string(&out).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
            keys.keys.retain(|k| k.key_id != cert.key_id);
            keys.keys.push(cert);
            std::fs::write(&out, serde_json::to_string_pretty(&keys).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            println!("certified {} in {}", key_file.key_id, out.display());
            Ok(ExitCode::SUCCESS)
        }
        "keygen" => {
            let out = PathBuf::from(flag(rest, "--out").ok_or("--out FILE")?);
            if out.exists() {
                return Err(format!("{} exists; not overwritten", out.display()));
            }
            let key = bundle::generate()?;
            let file = KeyFile::of(&key, &flag(rest, "--note").unwrap_or_else(|| "Key connectors signing key: SECRET, never commit".into()));
            std::fs::write(&out, serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o600));
            }
            let public = serde_json::json!({ "keyId": file.key_id, "publicKey": file.public_key });
            let pub_path = out.with_extension("pub.json");
            std::fs::write(&pub_path, serde_json::to_string_pretty(&public).unwrap_or_default()).map_err(|e| e.to_string())?;
            println!("secret key: {} (keep it out of git)\npublic key: {}\n{}", out.display(), pub_path.display(), public);
            Ok(ExitCode::SUCCESS)
        }
        "verify" => {
            let dir = PathBuf::from(flag(rest, "--dir").ok_or("--dir DIR")?);
            let trust = Trust::embedded(has(rest, "--dev"));
            let v = bundle::verify(&bundle::read_dir(&dir), &trust, key_connectors::time::now_secs(), None)?;
            println!("ok: bundle {} with {} connectors", v.index.sequence, v.specs.len());
            for w in v.warnings {
                println!("warning: {w}");
            }
            Ok(ExitCode::SUCCESS)
        }
        other => Err(format!("unknown command {other}")),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
