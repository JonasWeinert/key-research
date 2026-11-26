// Signed connector bundles: an index (ids, versions, hashes, engine version, sequence) signed
// with Ed25519, the spec files it lists, and the certificates of the signing keys. The app
// trusts root public keys (connectors/trust.json, compiled in); a root signs signing keys for a
// period (key rotation), a signing key signs the index. Nothing unsigned, tampered, expired,
// revoked, older than what is active, or needing a newer engine is ever activated.
//
// On disk (<dir>): active/ (the verified bundle in use), previous/ (the one before, for
// rollback), staging-<n>/ (a download being checked), state.json (last check, ETag, errors).
use crate::spec::Spec;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const BUNDLE_FORMAT: u64 = 1;
const INDEX_CONTEXT: &[u8] = b"key-connectors bundle v1\n";
const CERT_CONTEXT: &str = "key-connectors signing key v1\n";
pub const TRUST_TEXT: &str = include_str!("../../../connectors/trust.json");

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub bundle: u64,
    pub sequence: u64,
    pub created: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    #[serde(default = "engine_one")]
    pub min_engine: String,
    pub connectors: Vec<IndexEntry>,
}

fn engine_one() -> String {
    "1.0.0".into()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub id: String,
    pub version: String,
    pub sha256: String,
    pub size: u64,
    pub path: String,
    #[serde(default = "engine_one")]
    pub min_engine: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSignature {
    pub key_id: String,
    pub signature: String,
}

/// A signing key, certified by a root key for a period.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Certificate {
    pub key_id: String,
    pub public_key: String,
    pub not_before: String,
    pub not_after: String,
    pub root_key_id: String,
    pub signature: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Keys {
    #[serde(default)]
    pub keys: Vec<Certificate>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedKey {
    pub key_id: String,
    pub public_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trust {
    #[serde(default)]
    pub roots: Vec<TrustedKey>,
    #[serde(default)]
    pub revoked: Vec<String>,
    /// Where updates are published (index.json, index.sig, keys.json, specs/...).
    #[serde(default)]
    pub update_url: String,
}

impl Trust {
    /// The compiled-in trust, plus the dev root when asked (tests and smokes only).
    pub fn embedded(dev: bool) -> Trust {
        let mut trust: Trust = serde_json::from_str(TRUST_TEXT).unwrap_or_default();
        if dev {
            let key = dev_root();
            trust.roots.push(TrustedKey { key_id: key_id(&key.verifying_key()), public_key: b64(key.verifying_key().as_bytes()), not_before: None, not_after: None, note: Some("dev root: tests only".into()) });
        }
        trust
    }

    pub fn configured(&self) -> bool {
        !self.roots.is_empty()
    }
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD.decode(text.trim()).map_err(|_| "bad base64".to_string())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn key_id(key: &VerifyingKey) -> String {
    sha256_hex(key.as_bytes())[..16].to_string()
}

pub fn verifying_key(text: &str) -> Result<VerifyingKey, String> {
    let bytes: [u8; 32] = unb64(text)?.try_into().map_err(|_| "a public key is 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| "not an Ed25519 public key".into())
}

/// The development root key: derived from a fixed text, so it is public by design. It is only
/// trusted when a test or smoke asks (`Trust::embedded(true)`), never in a normal run.
pub fn dev_root() -> SigningKey {
    SigningKey::from_bytes(&Sha256::digest(b"key-connectors dev root key: PUBLIC, tests only, never trusted by default").into())
}

/// A development signing key (certified by the dev root in tests).
pub fn dev_signing() -> SigningKey {
    SigningKey::from_bytes(&Sha256::digest(b"key-connectors dev signing key: PUBLIC, tests only, never trusted by default").into())
}

/// A secret key file: {"keyId", "publicKey", "secretKey"} (base64; written by `keygen`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFile {
    pub key_id: String,
    pub public_key: String,
    pub secret_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl KeyFile {
    pub fn of(key: &SigningKey, note: &str) -> KeyFile {
        KeyFile { key_id: key_id(&key.verifying_key()), public_key: b64(key.verifying_key().as_bytes()), secret_key: b64(&key.to_bytes()), note: Some(note.into()) }
    }
    pub fn signing_key(&self) -> Result<SigningKey, String> {
        let bytes: [u8; 32] = unb64(&self.secret_key)?.try_into().map_err(|_| "a secret key is 32 bytes".to_string())?;
        let key = SigningKey::from_bytes(&bytes);
        if b64(key.verifying_key().as_bytes()) != self.public_key {
            return Err("The key file's public key does not match its secret key".into());
        }
        Ok(key)
    }
}

/// A new key from the system's random source.
pub fn generate() -> Result<SigningKey, String> {
    let mut seed = [0u8; 32];
    let mut f = std::fs::File::open("/dev/urandom").map_err(|e| format!("No random source: {e}"))?;
    std::io::Read::read_exact(&mut f, &mut seed).map_err(|e| e.to_string())?;
    Ok(SigningKey::from_bytes(&seed))
}

fn cert_message(c: &Certificate) -> String {
    format!("{CERT_CONTEXT}{}\n{}\n{}\n{}\n", c.key_id, c.public_key, c.not_before, c.not_after)
}

/// A root certifies a signing key for [not_before, not_after].
pub fn certify(root: &SigningKey, key: &VerifyingKey, not_before: &str, not_after: &str) -> Certificate {
    let mut c = Certificate { key_id: key_id(key), public_key: b64(key.as_bytes()), not_before: not_before.into(), not_after: not_after.into(), root_key_id: key_id(&root.verifying_key()), signature: String::new() };
    c.signature = b64(&root.sign(cert_message(&c).as_bytes()).to_bytes());
    c
}

pub fn sign_index(key: &SigningKey, index: &[u8]) -> IndexSignature {
    let mut message = INDEX_CONTEXT.to_vec();
    message.extend_from_slice(index);
    IndexSignature { key_id: key_id(&key.verifying_key()), signature: b64(&key.sign(&message).to_bytes()) }
}

fn within(now: i64, from: Option<&str>, to: Option<&str>) -> Result<(), String> {
    if let Some(from) = from {
        let t = crate::time::parse(from).ok_or("a bad date in a key")?;
        if now < t {
            return Err("the signing key is not valid yet".into());
        }
    }
    if let Some(to) = to {
        let t = crate::time::parse(to).ok_or("a bad date in a key")?;
        if now > t {
            return Err("the signing key has expired".into());
        }
    }
    Ok(())
}

/// The key that may verify an index signed by `key_id`: a trusted root, or a signing key with
/// a valid certificate from one.
fn signer(trust: &Trust, keys: &Keys, key_id_: &str, now: i64) -> Result<VerifyingKey, String> {
    if trust.revoked.iter().any(|r| r == key_id_) {
        return Err(format!("key {key_id_} is revoked"));
    }
    if let Some(root) = trust.roots.iter().find(|r| r.key_id == key_id_) {
        within(now, root.not_before.as_deref(), root.not_after.as_deref())?;
        let key = verifying_key(&root.public_key)?;
        if key_id(&key) != root.key_id {
            return Err("a trusted root's id does not match its key".into());
        }
        return Ok(key);
    }
    let cert = keys.keys.iter().find(|c| c.key_id == key_id_).ok_or_else(|| format!("no certificate for key {key_id_}"))?;
    if trust.revoked.iter().any(|r| *r == cert.root_key_id) {
        return Err("the certifying root is revoked".into());
    }
    let root = trust.roots.iter().find(|r| r.key_id == cert.root_key_id).ok_or("the signing key is not certified by a trusted root")?;
    within(now, root.not_before.as_deref(), root.not_after.as_deref())?;
    let root_key = verifying_key(&root.public_key)?;
    let signature = Signature::from_slice(&unb64(&cert.signature)?).map_err(|_| "a bad certificate signature")?;
    root_key.verify(cert_message(cert).as_bytes(), &signature).map_err(|_| "the signing key's certificate does not verify")?;
    within(now, Some(&cert.not_before), Some(&cert.not_after))?;
    let key = verifying_key(&cert.public_key)?;
    if key_id(&key) != cert.key_id {
        return Err("a certificate's id does not match its key".into());
    }
    Ok(key)
}

/// A verified bundle, ready to use.
#[derive(Clone, Debug)]
pub struct Verified {
    pub index: Index,
    pub specs: Vec<(Spec, String)>,
    pub warnings: Vec<String>,
}

/// Checks a bundle read through `read` (a path relative to the bundle root -> bytes).
/// `active_sequence`: what is in use now (an older bundle is refused, the same one accepted).
pub fn verify(read: &dyn Fn(&str) -> Option<Vec<u8>>, trust: &Trust, now: i64, active_sequence: Option<u64>) -> Result<Verified, String> {
    let index_bytes = read("index.json").ok_or("index.json is missing")?;
    let sig: IndexSignature = serde_json::from_slice(&read("index.sig").ok_or("index.sig is missing")?).map_err(|e| format!("index.sig: {e}"))?;
    let keys: Keys = match read("keys.json") {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("keys.json: {e}"))?,
        None => Keys::default(),
    };
    let key = signer(trust, &keys, &sig.key_id, now)?;
    let signature = Signature::from_slice(&unb64(&sig.signature)?).map_err(|_| "a bad index signature")?;
    let mut message = INDEX_CONTEXT.to_vec();
    message.extend_from_slice(&index_bytes);
    key.verify(&message, &signature).map_err(|_| "the index signature does not verify")?;
    let index: Index = serde_json::from_slice(&index_bytes).map_err(|e| format!("index.json: {e}"))?;
    if index.bundle != BUNDLE_FORMAT {
        return Err(format!("bundle format {} is not supported", index.bundle));
    }
    if !crate::version_at_least(crate::ENGINE_VERSION, &index.min_engine) {
        return Err(format!("the bundle needs engine {} (this app has {})", index.min_engine, crate::ENGINE_VERSION));
    }
    if let Some(expires) = &index.expires {
        if crate::time::parse(expires).is_some_and(|t| now > t) {
            return Err("the bundle has expired".into());
        }
    }
    if let Some(active) = active_sequence {
        if index.sequence < active {
            return Err(format!("bundle {} is older than the active one ({active})", index.sequence));
        }
    }
    let mut specs = Vec::new();
    let mut warnings = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for entry in &index.connectors {
        if !ids.insert(entry.id.clone()) {
            return Err(format!("{} is listed twice", entry.id));
        }
        if entry.path.contains("..") || entry.path.starts_with('/') || !entry.path.ends_with(".json") {
            return Err(format!("{}: bad path {}", entry.id, entry.path));
        }
        let bytes = read(&entry.path).ok_or_else(|| format!("{} is missing", entry.path))?;
        if bytes.len() as u64 != entry.size || sha256_hex(&bytes) != entry.sha256 {
            return Err(format!("{} does not match its hash", entry.path));
        }
        if !crate::version_at_least(crate::ENGINE_VERSION, &entry.min_engine) {
            warnings.push(format!("{} {} needs a newer Key; the built-in version is used", entry.id, entry.version));
            continue;
        }
        let text = String::from_utf8(bytes).map_err(|_| format!("{} is not UTF-8", entry.path))?;
        let spec = Spec::parse(&text).map_err(|p| format!("{}: {}", entry.id, p.join("; ")))?;
        if spec.id != entry.id || spec.version != entry.version {
            return Err(format!("{}: the index says {} {}, the file {} {}", entry.path, entry.id, entry.version, spec.id, spec.version));
        }
        specs.push((spec, entry.sha256.clone()));
    }
    Ok(Verified { index, specs, warnings })
}

pub fn read_dir(dir: &Path) -> impl Fn(&str) -> Option<Vec<u8>> + '_ {
    move |rel: &str| std::fs::read(dir.join(rel)).ok()
}

/// Builds the bundle files for specs in `specs_dir` into `out` (index.json; not signed).
pub fn build(specs_dir: &Path, out: &Path, sequence: u64, created: &str) -> Result<Index, String> {
    let mut entries = Vec::new();
    let mut names: Vec<PathBuf> = std::fs::read_dir(specs_dir).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    names.sort();
    std::fs::create_dir_all(out.join("specs")).map_err(|e| e.to_string())?;
    let mut min_engine = "1.0.0".to_string();
    for path in names {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let text = String::from_utf8(bytes.clone()).map_err(|_| format!("{} is not UTF-8", path.display()))?;
        let spec = Spec::parse(&text).map_err(|p| format!("{}: {}", path.display(), p.join("; ")))?;
        let rel = format!("specs/{}.json", spec.id);
        std::fs::write(out.join(&rel), &bytes).map_err(|e| e.to_string())?;
        if crate::version_at_least(&spec.min_engine, &min_engine) {
            min_engine = spec.min_engine.clone();
        }
        entries.push(IndexEntry { id: spec.id.clone(), version: spec.version.clone(), sha256: sha256_hex(&bytes), size: bytes.len() as u64, path: rel, min_engine: spec.min_engine.clone() });
    }
    let _ = min_engine;
    let index = Index { bundle: BUNDLE_FORMAT, sequence, created: created.into(), expires: None, min_engine: "1.0.0".into(), connectors: entries };
    let text = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    std::fs::write(out.join("index.json"), text).map_err(|e| e.to_string())?;
    Ok(index)
}

/// Signs `<dir>/index.json` into `<dir>/index.sig` (and writes `keys.json` from `certs`).
pub fn sign_dir(dir: &Path, key: &SigningKey, certs: &Keys) -> Result<IndexSignature, String> {
    let index = std::fs::read(dir.join("index.json")).map_err(|e| format!("index.json: {e}"))?;
    let sig = sign_index(key, &index);
    std::fs::write(dir.join("index.sig"), serde_json::to_string_pretty(&sig).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("keys.json"), serde_json::to_string_pretty(certs).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(sig)
}

// ── The on-disk store ──

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoreState {
    pub last_check_at: Option<i64>,
    pub last_result: Option<String>,
    pub last_error: Option<String>,
    pub etag: Option<String>,
    pub activated_at: Option<i64>,
    pub sequence: Option<u64>,
}

pub struct Store {
    pub dir: PathBuf,
}

/// Everything a check downloads: a path relative to the update URL -> bytes (None: absent).
pub type Fetch<'a> = dyn Fn(&str) -> Result<Option<Vec<u8>>, String> + 'a;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub state: String,
    pub sequence: u64,
    pub changed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn state(&self) -> StoreState {
        std::fs::read(self.dir.join("state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save_state(&self, state: &StoreState) {
        let _ = std::fs::create_dir_all(&self.dir);
        let tmp = self.dir.join("state.json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(state).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(tmp, self.dir.join("state.json"));
        }
    }

    /// The active bundle, verified again (a damaged or tampered folder falls back to the
    /// previous one, and that to none: the baseline).
    pub fn load(&self, trust: &Trust, now: i64) -> Option<Verified> {
        let active = self.dir.join("active");
        if !active.exists() && self.dir.join("previous").exists() {
            let _ = std::fs::rename(self.dir.join("previous"), &active);
        }
        for name in ["active", "previous"] {
            let dir = self.dir.join(name);
            if !dir.exists() {
                continue;
            }
            match verify(&read_dir(&dir), trust, now, None) {
                Ok(v) => return Some(v),
                Err(e) => {
                    let mut state = self.state();
                    state.last_error = Some(format!("The downloaded connectors ({name}) could not be verified: {e}"));
                    self.save_state(&state);
                }
            }
        }
        None
    }

    /// Downloads, verifies and activates a newer bundle. `force`: ignore the once-a-day limit.
    pub fn check(&self, trust: &Trust, fetch: &Fetch, now: i64, force: bool, conditional: &dyn Fn(Option<&str>) -> Result<Option<(Vec<u8>, Option<String>)>, String>) -> CheckResult {
        let mut state = self.state();
        let active_seq = self.load(trust, now).map(|v| v.index.sequence);
        let result = |s: &str, seq: u64, changed: Vec<String>, error: Option<String>| CheckResult { state: s.into(), sequence: seq, changed, error };
        if !trust.configured() {
            return result("unconfigured", active_seq.unwrap_or(0), Vec::new(), None);
        }
        if !force && state.last_check_at.is_some_and(|t| now - t < 24 * 3600) {
            return result("skipped", active_seq.unwrap_or(0), Vec::new(), None);
        }
        state.last_check_at = Some(now);
        let outcome = self.try_update(trust, fetch, now, active_seq, &mut state, conditional);
        let out = match outcome {
            Ok(Some((seq, changed))) => {
                state.last_result = Some("updated".into());
                state.last_error = None;
                state.activated_at = Some(now);
                state.sequence = Some(seq);
                result("updated", seq, changed, None)
            }
            Ok(None) => {
                state.last_result = Some("current".into());
                state.last_error = None;
                result("current", active_seq.unwrap_or(0), Vec::new(), None)
            }
            Err(e) => {
                state.last_result = Some("failed".into());
                state.last_error = Some(e.clone());
                result("failed", active_seq.unwrap_or(0), Vec::new(), Some(e))
            }
        };
        self.save_state(&state);
        out
    }

    fn try_update(&self, trust: &Trust, fetch: &Fetch, now: i64, active_seq: Option<u64>, state: &mut StoreState, conditional: &dyn Fn(Option<&str>) -> Result<Option<(Vec<u8>, Option<String>)>, String>) -> Result<Option<(u64, Vec<String>)>, String> {
        let etag = if active_seq.is_some() { state.etag.clone() } else { None };
        let Some((index_bytes, new_etag)) = conditional(etag.as_deref())? else { return Ok(None) };
        let index: Index = serde_json::from_slice(&index_bytes).map_err(|e| format!("index.json: {e}"))?;
        if active_seq.is_some_and(|a| index.sequence <= a) {
            state.etag = new_etag;
            return Ok(None);
        }
        let staging = self.dir.join(format!("staging-{}", index.sequence));
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(staging.join("specs")).map_err(|e| e.to_string())?;
        let write = |rel: &str, bytes: &[u8]| std::fs::write(staging.join(rel), bytes).map_err(|e| e.to_string());
        write("index.json", &index_bytes)?;
        write("index.sig", &fetch("index.sig")?.ok_or("index.sig is missing")?)?;
        if let Some(keys) = fetch("keys.json")? {
            write("keys.json", &keys)?;
        }
        // Spec files unchanged since the active bundle are copied, not downloaded again.
        let active = self.dir.join("active");
        let old: Option<Index> = std::fs::read(active.join("index.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let mut changed = Vec::new();
        for entry in &index.connectors {
            if entry.path.contains("..") || entry.path.starts_with('/') {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(format!("bad path {}", entry.path));
            }
            let same = old.as_ref().and_then(|o| o.connectors.iter().find(|c| c.id == entry.id)).filter(|c| c.sha256 == entry.sha256);
            let bytes = match same.and_then(|c| std::fs::read(active.join(&c.path)).ok()) {
                Some(b) => b,
                None => {
                    changed.push(entry.id.clone());
                    fetch(&entry.path)?.ok_or_else(|| format!("{} is missing", entry.path))?
                }
            };
            write(&entry.path, &bytes)?;
        }
        match verify(&read_dir(&staging), trust, now, active_seq) {
            Ok(_) => {}
            Err(e) => {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(format!("The update was not accepted: {e}"));
            }
        }
        // Activate: active -> previous, staging -> active.
        let previous = self.dir.join("previous");
        let _ = std::fs::remove_dir_all(&previous);
        if active.exists() {
            std::fs::rename(&active, &previous).map_err(|e| e.to_string())?;
        }
        if let Err(e) = std::fs::rename(&staging, &active) {
            // Roll back.
            let _ = std::fs::rename(&previous, &active);
            return Err(format!("Couldn't activate the update: {e}"));
        }
        state.etag = new_etag;
        Ok(Some((index.sequence, changed)))
    }

    /// Goes back to the previous bundle (after a bad update was reported).
    pub fn rollback(&self) -> Result<(), String> {
        let previous = self.dir.join("previous");
        if !previous.exists() {
            return Err("There is no previous version".into());
        }
        let active = self.dir.join("active");
        let broken = self.dir.join("rolled-back");
        let _ = std::fs::remove_dir_all(&broken);
        if active.exists() {
            std::fs::rename(&active, &broken).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&previous, &active).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const SPEC: &str = r#"{"format":1,"id":"demo","version":"1.0.0","name":"Demo","kind":"manual","manual":{"url":"https://example.org/?q={query}"}}"#;

    fn dev_trust() -> Trust {
        Trust::embedded(true)
    }

    fn now() -> i64 {
        crate::time::parse("2026-11-26T12:00:00Z").unwrap()
    }

    /// A bundle in memory, signed with the dev signing key certified by the dev root.
    fn bundle(sequence: u64, spec: &str, cert_window: (&str, &str)) -> HashMap<String, Vec<u8>> {
        let mut files = HashMap::new();
        let bytes = spec.as_bytes().to_vec();
        let parsed = Spec::parse(spec).unwrap();
        let index = Index {
            bundle: 1,
            sequence,
            created: "2026-11-26T00:00:00Z".into(),
            expires: None,
            min_engine: "1.0.0".into(),
            connectors: vec![IndexEntry { id: parsed.id.clone(), version: parsed.version.clone(), sha256: sha256_hex(&bytes), size: bytes.len() as u64, path: format!("specs/{}.json", parsed.id), min_engine: "1.0.0".into() }],
        };
        let index_bytes = serde_json::to_vec(&index).unwrap();
        let key = dev_signing();
        let cert = certify(&dev_root(), &key.verifying_key(), cert_window.0, cert_window.1);
        files.insert("index.sig".into(), serde_json::to_vec(&sign_index(&key, &index_bytes)).unwrap());
        files.insert("keys.json".into(), serde_json::to_vec(&Keys { keys: vec![cert] }).unwrap());
        files.insert("index.json".into(), index_bytes);
        files.insert(format!("specs/{}.json", parsed.id), bytes);
        files
    }

    fn reader(files: &HashMap<String, Vec<u8>>) -> impl Fn(&str) -> Option<Vec<u8>> + '_ {
        move |p| files.get(p).cloned()
    }

    const WINDOW: (&str, &str) = ("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z");

    #[test]
    fn a_signed_bundle_verifies() {
        let files = bundle(1, SPEC, WINDOW);
        let v = verify(&reader(&files), &dev_trust(), now(), None).unwrap();
        assert_eq!(v.specs.len(), 1);
        assert_eq!(v.index.sequence, 1);
    }

    #[test]
    fn untrusted_tampered_expired_revoked_and_older_bundles_are_refused() {
        let files = bundle(2, SPEC, WINDOW);
        // Not trusted without the dev root.
        assert!(verify(&reader(&files), &Trust::default(), now(), None).is_err());
        // A changed spec no longer matches its hash.
        let mut tampered = files.clone();
        tampered.insert("specs/demo.json".into(), SPEC.replace("Demo", "Evil").into_bytes());
        assert!(verify(&reader(&tampered), &dev_trust(), now(), None).unwrap_err().contains("hash"));
        // A changed index no longer matches its signature.
        let mut tampered = files.clone();
        let index = String::from_utf8(files["index.json"].clone()).unwrap().replace("\"sequence\":2", "\"sequence\":9");
        tampered.insert("index.json".into(), index.into_bytes());
        assert!(verify(&reader(&tampered), &dev_trust(), now(), None).unwrap_err().contains("signature"));
        // An expired signing key.
        let old = bundle(2, SPEC, ("2024-01-01T00:00:00Z", "2025-01-01T00:00:00Z"));
        assert!(verify(&reader(&old), &dev_trust(), now(), None).unwrap_err().contains("expired"));
        // A revoked key.
        let mut trust = dev_trust();
        trust.revoked.push(key_id(&dev_signing().verifying_key()));
        assert!(verify(&reader(&files), &trust, now(), None).unwrap_err().contains("revoked"));
        // Older than the active bundle.
        assert!(verify(&reader(&files), &dev_trust(), now(), Some(3)).unwrap_err().contains("older"));
        // A certificate made by a key that is not a trusted root.
        let mut forged = files.clone();
        let rogue = generate().unwrap();
        let cert = certify(&rogue, &dev_signing().verifying_key(), WINDOW.0, WINDOW.1);
        forged.insert("keys.json".into(), serde_json::to_vec(&Keys { keys: vec![cert] }).unwrap());
        assert!(verify(&reader(&forged), &dev_trust(), now(), None).is_err());
    }

    #[test]
    fn rotated_signing_keys_verify_while_their_certificate_is_valid() {
        // A second signing key, certified for 2027, signs a later bundle.
        let next = SigningKey::from_bytes(&[7u8; 32]);
        let mut files = bundle(5, SPEC, WINDOW);
        let index = files["index.json"].clone();
        let cert = certify(&dev_root(), &next.verifying_key(), "2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z");
        files.insert("index.sig".into(), serde_json::to_vec(&sign_index(&next, &index)).unwrap());
        files.insert("keys.json".into(), serde_json::to_vec(&Keys { keys: vec![cert] }).unwrap());
        assert!(verify(&reader(&files), &dev_trust(), now(), None).unwrap_err().contains("not valid yet"));
        assert!(verify(&reader(&files), &dev_trust(), crate::time::parse("2027-06-01T00:00:00Z").unwrap(), None).is_ok());
    }

    fn write_bundle(dir: &Path, files: &HashMap<String, Vec<u8>>) {
        for (rel, bytes) in files {
            let path = dir.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
    }

    #[test]
    fn the_store_activates_newer_bundles_refuses_bad_ones_and_rolls_back() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::new(tmp.path().join("connectors"));
        let trust = dev_trust();
        let serve = |files: HashMap<String, Vec<u8>>| {
            move |p: &str| -> Result<Option<Vec<u8>>, String> { Ok(files.get(p).cloned()) }
        };
        let v1 = bundle(1, SPEC, WINDOW);
        let index1 = v1["index.json"].clone();
        let r = store.check(&trust, &serve(v1.clone()), now(), true, &|_| Ok(Some((index1.clone(), Some("e1".into())))));
        assert_eq!(r.state, "updated", "{r:?}");
        assert_eq!(store.load(&trust, now()).unwrap().index.sequence, 1);
        // The same index again: current.
        let r = store.check(&trust, &serve(v1.clone()), now(), true, &|etag| {
            assert_eq!(etag, Some("e1"));
            Ok(None)
        });
        assert_eq!(r.state, "current");
        // A tampered newer bundle is refused; the active one stays.
        let mut v2 = bundle(2, &SPEC.replace("1.0.0", "1.1.0"), WINDOW);
        v2.insert("specs/demo.json".into(), SPEC.replace("1.0.0", "1.1.0").replace("Demo", "Evil").into_bytes());
        let index2 = v2["index.json"].clone();
        let r = store.check(&trust, &serve(v2), now(), true, &|_| Ok(Some((index2.clone(), None))));
        assert_eq!(r.state, "failed");
        assert_eq!(store.load(&trust, now()).unwrap().index.sequence, 1);
        assert!(!tmp.path().join("connectors/staging-2").exists());
        // A good newer one is activated, and can be rolled back.
        let v3 = bundle(3, &SPEC.replace("1.0.0", "1.2.0"), WINDOW);
        let index3 = v3["index.json"].clone();
        let r = store.check(&trust, &serve(v3), now(), true, &|_| Ok(Some((index3.clone(), None))));
        assert_eq!((r.state.as_str(), r.changed.clone()), ("updated", vec!["demo".to_string()]));
        assert_eq!(store.load(&trust, now()).unwrap().specs[0].0.version, "1.2.0");
        store.rollback().unwrap();
        assert_eq!(store.load(&trust, now()).unwrap().index.sequence, 1);
        // Without force, at most once a day.
        let r = store.check(&trust, &serve(HashMap::new()), now() + 60, false, &|_| Ok(None));
        assert_eq!(r.state, "skipped");
        // A damaged active folder falls back to the previous one.
        let tmp2 = tempfile::tempdir().unwrap();
        let store2 = Store::new(tmp2.path());
        write_bundle(&tmp2.path().join("previous"), &bundle(1, SPEC, WINDOW));
        let mut broken = bundle(4, SPEC, WINDOW);
        broken.insert("index.sig".into(), b"{}".to_vec());
        write_bundle(&tmp2.path().join("active"), &broken);
        assert_eq!(store2.load(&trust, now()).unwrap().index.sequence, 1);
    }

    #[test]
    fn without_a_trusted_root_updates_are_not_configured() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::new(tmp.path());
        let r = store.check(&Trust::default(), &|_| Ok(None), now(), true, &|_| Ok(None));
        assert_eq!(r.state, "unconfigured");
    }
}
