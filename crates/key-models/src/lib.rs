// Key's on-device models (search embeddings, PDF layout) are not shipped in the app: each is
// downloaded on first need from a pinned Hugging Face revision, verified by SHA-256 and kept
// once per machine in a shared folder that every workspace host uses.
//
//   <root>/<id>/<revision>/<files>      the model, complete and verified
//   <root>/<id>/<revision>/.verified    hashes of the files that passed verification
//   <root>/<id>/.lock                   held by the process downloading it (heartbeat)
//   <root>/<id>/.progress.json          its progress, read by every process's status()
//
// The root is `KEY_MODEL_DIR` (Electron passes it) or the platform's app data folder.
// `KEY_MODELS_BASE_URL` replaces https://huggingface.co (a mirror, or a test's mock); without
// it a file whose Hugging Face copy cannot be reached is fetched from its upstream source,
// which must match the same hash.
mod fetch;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;

pub const ROOT_ENV: &str = "KEY_MODEL_DIR";
pub const BASE_URL_ENV: &str = "KEY_MODELS_BASE_URL";
pub const AUTO_ENV: &str = "KEY_MODELS_AUTO_DOWNLOAD";
const HUB: &str = "https://huggingface.co";
/// Each request asks for this many bytes (well inside the safe client's response cap).
const CHUNK: u64 = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
/// A lock not touched for this long belongs to a process that went away.
const LOCK_STALE: Duration = Duration::from_secs(20);
/// Background retries after a failure; then the model waits for the user (or the next launch).
const RETRY_DELAYS: [u64; 4] = [5, 30, 120, 600];
const GIVE_UP_FOR: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileSpec {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    /// The same bytes at their original source, pinned to a revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// Where an older Key kept this file, relative to the root; adopted when it verifies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub id: String,
    pub name: String,
    pub title: String,
    pub purpose: String,
    pub repo: String,
    pub revision: String,
    pub license: String,
    pub license_url: String,
    pub upstream: String,
    pub files: Vec<FileSpec>,
}

impl Spec {
    pub fn size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
    pub fn card_url(&self) -> String {
        format!("{HUB}/{}", self.repo)
    }
}

#[derive(Deserialize)]
struct Manifest {
    models: Vec<Spec>,
}

/// The models this build knows: compiled in from manifest.json.
pub fn manifest() -> &'static [Spec] {
    static MANIFEST: OnceLock<Vec<Spec>> = OnceLock::new();
    MANIFEST.get_or_init(|| serde_json::from_str::<Manifest>(include_str!("../manifest.json")).expect("valid model manifest").models)
}

pub const EMBEDDINGS: &str = "embeddinggemma-2-q8";
pub const LAYOUT: &str = "pp-doclayoutv3-fp16";
pub const READER_EMBEDDINGS: &str = "arctic-embed-xs-q";

/// The platform's shared app data folder for models.
pub fn default_root() -> PathBuf {
    if let Some(root) = std::env::var_os(ROOT_ENV).filter(|v| !v.is_empty()) {
        return PathBuf::from(root);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Key/models")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or(home).join("Key/models")
    } else {
        home.join(".local/share/key/models")
    }
}

static AUTO: AtomicU8 = AtomicU8::new(0);

/// Whether models download by themselves when first needed: the user's setting (passed as
/// `KEY_MODELS_AUTO_DOWNLOAD`, or changed while running), on by default; test runs
/// (`KEY_SKIP_ONBOARDING=1`, `KEY_TEST`) never download unless they opt in.
pub fn auto_download() -> bool {
    match AUTO.load(Ordering::SeqCst) {
        1 => return true,
        2 => return false,
        _ => {}
    }
    match std::env::var(AUTO_ENV).ok().as_deref() {
        Some("0") => false,
        Some("1") => true,
        _ => !(std::env::var("KEY_SKIP_ONBOARDING").as_deref() == Ok("1") || std::env::var_os("KEY_TEST").is_some()),
    }
}

pub fn set_auto_download(enabled: bool) {
    AUTO.store(if enabled { 1 } else { 2 }, Ordering::SeqCst);
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub name: String,
    pub title: String,
    pub purpose: String,
    pub repo: String,
    pub revision: String,
    pub card_url: String,
    pub license: String,
    pub license_url: String,
    pub upstream: String,
    /// Bytes to download.
    pub size: u64,
    /// missing | downloading | ready | failed
    pub state: String,
    pub received: u64,
    pub total: u64,
    pub error: Option<String>,
    /// Seconds since the epoch when the next automatic attempt starts.
    pub retry_at: Option<u64>,
    /// The folder holding the model, once ready.
    pub path: Option<String>,
    pub disk_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub root: String,
    pub auto_download: bool,
    pub disk_bytes: u64,
    pub models: Vec<Status>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    state: String,
    received: u64,
    total: u64,
    error: Option<String>,
    retry_at: Option<u64>,
}

/// The shared models folder and the manifest it follows.
#[derive(Clone, Debug)]
pub struct Models {
    root: PathBuf,
    specs: Arc<Vec<Spec>>,
    base: Option<String>,
    chunk: u64,
}

impl Models {
    /// The built-in manifest at `root`, with the base URL from the environment.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let base = std::env::var(BASE_URL_ENV).ok().map(|v| v.trim().trim_end_matches('/').to_string()).filter(|v| !v.is_empty());
        Self { root: root.into(), specs: Arc::new(manifest().to_vec()), base, chunk: CHUNK }
    }
    pub fn from_env() -> Self {
        Self::new(default_root())
    }
    /// A custom manifest and base URL (tests).
    pub fn with_manifest(root: impl Into<PathBuf>, specs: Vec<Spec>, base: Option<String>) -> Self {
        Self { root: root.into(), specs: Arc::new(specs), base, chunk: CHUNK }
    }
    pub fn with_chunk(mut self, chunk: u64) -> Self {
        self.chunk = chunk.max(1);
        self
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn spec(&self, id: &str) -> Result<&Spec> {
        self.specs.iter().find(|s| s.id == id).ok_or_else(|| format!("Unknown model {id}"))
    }
    fn model_root(&self, spec: &Spec) -> PathBuf {
        self.root.join(&spec.id)
    }
    /// The folder a model's files live in.
    pub fn dir(&self, id: &str) -> Result<PathBuf> {
        let spec = self.spec(id)?;
        Ok(self.model_root(spec).join(&spec.revision))
    }
    fn lock_path(&self, spec: &Spec) -> PathBuf {
        self.model_root(spec).join(".lock")
    }
    fn progress_path(&self, spec: &Spec) -> PathBuf {
        self.model_root(spec).join(".progress.json")
    }
    fn stamp_path(&self, spec: &Spec) -> PathBuf {
        self.model_root(spec).join(&spec.revision).join(".verified")
    }
    fn key(&self, spec: &Spec) -> String {
        self.model_root(spec).to_string_lossy().into_owned()
    }

    fn stamp(&self, spec: &Spec) -> BTreeMap<String, String> {
        fs::read(self.stamp_path(spec)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    fn write_stamp(&self, spec: &Spec, stamp: &BTreeMap<String, String>) -> Result<()> {
        let path = self.stamp_path(spec);
        let temp = path.with_extension("tmp");
        fs::write(&temp, serde_json::to_vec(stamp).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&temp, &path).map_err(|e| e.to_string())
    }
    fn file_verified(&self, spec: &Spec, stamp: &BTreeMap<String, String>, file: &FileSpec) -> bool {
        stamp.get(&file.path) == Some(&file.sha256)
            && fs::metadata(self.model_root(spec).join(&spec.revision).join(&file.path)).is_ok_and(|m| m.len() == file.size)
    }

    /// Every file is present and verified (adopting an older Key's copy first, once).
    pub fn ready(&self, id: &str) -> bool {
        let Ok(spec) = self.spec(id) else { return false };
        let stamp = self.stamp(spec);
        if spec.files.iter().all(|f| self.file_verified(spec, &stamp, f)) {
            return true;
        }
        self.adopt_legacy(spec);
        let stamp = self.stamp(spec);
        spec.files.iter().all(|f| self.file_verified(spec, &stamp, f))
    }

    /// The folder holding a ready model.
    pub fn path(&self, id: &str) -> Option<PathBuf> {
        self.ready(id).then(|| self.dir(id).ok()).flatten()
    }

    /// One file of a ready model.
    pub fn file(&self, id: &str, file: &str) -> Option<PathBuf> {
        self.path(id).map(|dir| dir.join(file))
    }

    fn adopt_legacy(&self, spec: &Spec) {
        static TRIED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
        let tried = TRIED.get_or_init(Default::default);
        let key = self.key(spec);
        if !tried.lock().map(|mut t| t.insert(key)).unwrap_or(false) {
            return;
        }
        for file in &spec.files {
            let Some(legacy) = file.legacy.as_ref().map(|l| self.root.join(l)) else { continue };
            if !fs::metadata(&legacy).is_ok_and(|m| m.len() == file.size) {
                continue;
            }
            if sha256_file(&legacy).ok().as_deref() != Some(file.sha256.as_str()) {
                continue;
            }
            let target = self.model_root(spec).join(&spec.revision).join(&file.path);
            if let Some(parent) = target.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if fs::rename(&legacy, &target).is_ok() {
                let mut stamp = self.stamp(spec);
                stamp.insert(file.path.clone(), file.sha256.clone());
                let _ = self.write_stamp(spec, &stamp);
            }
        }
    }

    pub fn status(&self, id: &str) -> Result<Status> {
        let spec = self.spec(id)?;
        let mut status = Status {
            id: spec.id.clone(),
            name: spec.name.clone(),
            title: spec.title.clone(),
            purpose: spec.purpose.clone(),
            repo: spec.repo.clone(),
            revision: spec.revision.clone(),
            card_url: spec.card_url(),
            license: spec.license.clone(),
            license_url: spec.license_url.clone(),
            upstream: spec.upstream.clone(),
            size: spec.size(),
            total: spec.size(),
            disk_bytes: dir_size(&self.model_root(spec)),
            ..Default::default()
        };
        if self.ready(id) {
            status.state = "ready".into();
            status.received = status.total;
            status.path = self.dir(id).ok().map(|p| p.to_string_lossy().into_owned());
            return Ok(status);
        }
        let progress: Option<Progress> = fs::read(self.progress_path(spec)).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let live = lock_is_live(&self.lock_path(spec));
        match progress {
            Some(p) if p.state == "downloading" && live => {
                status.state = "downloading".into();
                status.received = p.received;
            }
            Some(p) if p.state == "failed" => {
                status.state = "failed".into();
                status.error = p.error;
                status.retry_at = p.retry_at;
                status.received = self.received(spec);
            }
            _ if live => status.state = "downloading".into(),
            _ => {
                status.state = "missing".into();
                status.received = self.received(spec);
            }
        }
        Ok(status)
    }

    /// Bytes already on disk: verified files and partial downloads.
    fn received(&self, spec: &Spec) -> u64 {
        let dir = self.model_root(spec).join(&spec.revision);
        let stamp = self.stamp(spec);
        spec.files
            .iter()
            .map(|f| {
                if self.file_verified(spec, &stamp, f) {
                    f.size
                } else {
                    fs::metadata(dir.join(format!("{}.part", f.path))).map(|m| m.len().min(f.size)).unwrap_or(0)
                }
            })
            .sum()
    }

    pub fn list(&self) -> Listing {
        let models: Vec<Status> = self.specs.iter().filter_map(|s| self.status(&s.id).ok()).collect();
        Listing {
            root: self.root.to_string_lossy().into_owned(),
            auto_download: auto_download(),
            disk_bytes: models.iter().map(|m| m.disk_bytes).sum(),
            models,
        }
    }

    /// Downloads the model if it is missing and returns its folder; blocks until done. Callers
    /// in this process share one download; another process's download is waited for.
    pub fn ensure(&self, id: &str) -> Result<PathBuf> {
        let spec = self.spec(id)?.clone();
        let gate = gate(&self.key(&spec));
        let _held = gate.lock().map_err(|_| "model lock poisoned".to_string())?;
        let mut waited = false;
        loop {
            if self.ready(id) {
                return self.dir(id);
            }
            fs::create_dir_all(self.model_root(&spec)).map_err(|e| e.to_string())?;
            match Lock::acquire(&self.lock_path(&spec)) {
                Some(lock) => {
                    // Another process may have finished while this one waited.
                    if waited && self.ready(id) {
                        return self.dir(id);
                    }
                    let result = self.download_locked(&spec, &lock);
                    drop(lock);
                    return result.map(|()| self.model_root(&spec).join(&spec.revision));
                }
                None => {
                    waited = true;
                    thread::sleep(Duration::from_millis(400));
                }
            }
        }
    }

    fn write_progress(&self, spec: &Spec, progress: &Progress) {
        if let Ok(bytes) = serde_json::to_vec(progress) {
            let path = self.progress_path(spec);
            let temp = path.with_extension("tmp");
            if fs::write(&temp, bytes).is_ok() {
                let _ = fs::rename(&temp, &path);
            }
        }
    }

    fn download_locked(&self, spec: &Spec, lock: &Lock) -> Result<()> {
        let dir = self.model_root(spec).join(&spec.revision);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut progress = Progress { state: "downloading".into(), received: self.received(spec), total: spec.size(), ..Default::default() };
        self.write_progress(spec, &progress);
        let result: Result<()> = (|| {
            for file in &spec.files {
                let stamp = self.stamp(spec);
                if self.file_verified(spec, &stamp, file) {
                    continue;
                }
                self.fetch_file(spec, file, &dir, &mut progress, lock)?;
                let mut stamp = self.stamp(spec);
                stamp.insert(file.path.clone(), file.sha256.clone());
                self.write_stamp(spec, &stamp)?;
            }
            Ok(())
        })();
        match &result {
            Ok(()) => {
                let _ = fs::remove_file(self.progress_path(spec));
            }
            Err(error) => {
                progress.state = "failed".into();
                progress.error = Some(error.clone());
                progress.received = self.received(spec);
                self.write_progress(spec, &progress);
            }
        }
        result
    }

    /// Where a file comes from: the pinned Hugging Face revision (or the configured mirror),
    /// then, without a mirror, its upstream source.
    fn sources(&self, spec: &Spec, file: &FileSpec) -> Vec<String> {
        let base = self.base.clone().unwrap_or_else(|| HUB.to_string());
        let mut sources = vec![format!("{base}/{}/resolve/{}/{}", spec.repo, spec.revision, file.path)];
        if self.base.is_none() {
            sources.extend(file.upstream.clone());
        }
        sources
    }

    fn fetch_file(&self, spec: &Spec, file: &FileSpec, dir: &Path, progress: &mut Progress, lock: &Lock) -> Result<()> {
        let target = dir.join(&file.path);
        let part = dir.join(format!("{}.part", file.path));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut last = String::new();
        for source in self.sources(spec, file) {
            // A file that arrives with the wrong hash is thrown away and fetched once more.
            for _ in 0..2 {
                match self.fetch_part(spec, file, &source, &part, progress, lock) {
                    Ok(()) => {}
                    Err(error) => {
                        last = error;
                        break;
                    }
                }
                let digest = sha256_file(&part)?;
                if digest == file.sha256 {
                    fs::rename(&part, &target).map_err(|e| e.to_string())?;
                    return Ok(());
                }
                let _ = fs::remove_file(&part);
                progress.received = self.received(spec);
                last = format!("{} did not match its checksum (got {digest})", file.path);
            }
        }
        Err(last)
    }

    fn fetch_part(&self, spec: &Spec, file: &FileSpec, source: &str, part: &Path, progress: &mut Progress, lock: &Lock) -> Result<()> {
        let mut offset = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
        if offset > file.size {
            let _ = fs::remove_file(part);
            offset = 0;
        }
        let mut out = fs::OpenOptions::new().create(true).append(true).open(part).map_err(|e| e.to_string())?;
        let mut current = source.to_string();
        let mut drops = 0;
        let mut reported = Instant::now();
        while offset < file.size {
            let end = (offset + self.chunk).min(file.size) - 1;
            let chunk = match fetch::range(&current, offset, end, REQUEST_TIMEOUT) {
                Ok(chunk) => chunk,
                // A CDN address from an earlier range may have expired: ask the source again.
                Err(_) if current != source => {
                    current = source.to_string();
                    continue;
                }
                Err(error) => return Err(friendly(&error.to_string(), matches!(error, fetch::FetchError::Offline(_)))),
            };
            let want = (end - offset + 1) as usize;
            let take = match chunk.status {
                206 => chunk.body.len().min(want),
                200 if offset == 0 && chunk.body.len() as u64 <= file.size => chunk.body.len(),
                200 => return Err("The server cannot resume downloads".into()),
                _ if current != source => {
                    current = source.to_string();
                    continue;
                }
                404 => return Err(format!("{} was not found at {}", file.path, host_of(source))),
                status => return Err(format!("{} answered HTTP {status}", host_of(source))),
            };
            out.write_all(&chunk.body[..take]).map_err(|e| e.to_string())?;
            offset += take as u64;
            progress.received += take as u64;
            if chunk.truncated || (chunk.status == 206 && take < want) {
                drops += 1;
                if drops > 5 {
                    out.sync_all().ok();
                    return Err(friendly("the connection kept dropping", true));
                }
            }
            if chunk.status == 200 && offset < file.size {
                return Err("The server sent an incomplete file".into());
            }
            current = chunk.final_url;
            if reported.elapsed() > Duration::from_millis(250) {
                self.write_progress(spec, progress);
                lock.touch();
                reported = Instant::now();
            }
        }
        out.sync_all().map_err(|e| e.to_string())?;
        self.write_progress(spec, progress);
        Ok(())
    }

    /// Starts a background download (with retries and backoff) unless the model is ready, one
    /// is running, or the user turned automatic downloads off. `explicit` is the user asking
    /// (Download, Retry): it ignores the setting and any pause after failures. `then` runs
    /// once the model is ready. Returns whether the model is ready now.
    pub fn request(&self, id: &str, explicit: bool, then: Option<Box<dyn FnOnce() + Send>>) -> bool {
        let Ok(spec) = self.spec(id).cloned() else { return false };
        if self.ready(id) {
            return true;
        }
        let key = self.key(&spec);
        if let Some(then) = then {
            waiters().lock().unwrap_or_else(|e| e.into_inner()).entry(key.clone()).or_default().push(then);
        }
        if !explicit && !auto_download() {
            return false;
        }
        {
            let mut paused = paused().lock().unwrap_or_else(|e| e.into_inner());
            if explicit {
                paused.remove(&key);
            } else if paused.get(&key).is_some_and(|until| Instant::now() < *until) {
                return false;
            }
        }
        if !running().lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone()) {
            return false;
        }
        let models = self.clone();
        let id = id.to_string();
        thread::spawn(move || {
            let mut attempt = 0;
            let outcome = loop {
                match models.ensure(&id) {
                    Ok(_) => break true,
                    Err(error) => {
                        eprintln!("Key model {id}: {error}");
                        let Some(delay) = RETRY_DELAYS.get(attempt).copied() else { break false };
                        attempt += 1;
                        let mut progress: Progress = fs::read(models.progress_path(&spec)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
                        progress.state = "failed".into();
                        progress.error.get_or_insert(error);
                        progress.retry_at = Some(now_secs() + delay);
                        models.write_progress(&spec, &progress);
                        thread::sleep(Duration::from_secs(delay));
                        // Removed or cancelled meanwhile: the user decides again.
                        if !running().lock().map(|r| r.contains(&models.key(&spec))).unwrap_or(false) {
                            break false;
                        }
                    }
                }
            };
            let key = models.key(&spec);
            running().lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
            if outcome {
                let callbacks = waiters().lock().unwrap_or_else(|e| e.into_inner()).remove(&key).unwrap_or_default();
                for callback in callbacks {
                    callback();
                }
            } else {
                let mut progress: Progress = fs::read(models.progress_path(&spec)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
                progress.retry_at = None;
                models.write_progress(&spec, &progress);
                paused().lock().unwrap_or_else(|e| e.into_inner()).insert(key, Instant::now() + GIVE_UP_FOR);
            }
        });
        false
    }

    /// Deletes a model's files; it downloads again when next needed.
    pub fn remove(&self, id: &str) -> Result<()> {
        let spec = self.spec(id)?.clone();
        if lock_is_live(&self.lock_path(&spec)) {
            return Err("The model is downloading; try again when it finishes".into());
        }
        let key = self.key(&spec);
        running().lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
        paused().lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
        let root = self.model_root(&spec);
        if root.exists() {
            fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
        }
        for legacy in spec.files.iter().filter_map(|f| f.legacy.as_ref()) {
            let _ = fs::remove_file(self.root.join(legacy));
        }
        Ok(())
    }

    /// Adds model files the user downloaded by hand (a file or a folder of them): each file
    /// whose SHA-256 matches one in the manifest is copied into place. Returns the ids of
    /// models that gained a file.
    pub fn import(&self, path: &Path) -> Result<Vec<String>> {
        let mut candidates = Vec::new();
        collect_files(path, 3, &mut candidates);
        let mut added = Vec::new();
        for candidate in candidates {
            let Ok(len) = fs::metadata(&candidate).map(|m| m.len()) else { continue };
            let matches: Vec<(Spec, FileSpec)> = self
                .specs
                .iter()
                .flat_map(|s| s.files.iter().filter(|f| f.size == len).map(move |f| (s.clone(), f.clone())))
                .collect();
            if matches.is_empty() {
                continue;
            }
            let digest = sha256_file(&candidate)?;
            for (spec, file) in matches.into_iter().filter(|(_, f)| f.sha256 == digest) {
                let dir = self.model_root(&spec).join(&spec.revision);
                let target = dir.join(&file.path);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let temp = dir.join(format!("{}.import", file.path));
                fs::copy(&candidate, &temp).map_err(|e| e.to_string())?;
                fs::rename(&temp, &target).map_err(|e| e.to_string())?;
                let mut stamp = self.stamp(&spec);
                stamp.insert(file.path.clone(), file.sha256.clone());
                self.write_stamp(&spec, &stamp)?;
                let _ = fs::remove_file(self.progress_path(&spec));
                if !added.contains(&spec.id) {
                    added.push(spec.id.clone());
                }
            }
        }
        if added.is_empty() {
            return Err("That file is not one of Key's models: its checksum matches none of them".into());
        }
        Ok(added)
    }
}

fn friendly(error: &str, offline: bool) -> String {
    if offline {
        format!("Couldn't reach Hugging Face ({error}). Key will try again")
    } else {
        error.to_string()
    }
}

fn host_of(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| url.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn gate(key: &str) -> Arc<Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    GATES.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner()).entry(key.to_string()).or_default().clone()
}
fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}
fn paused() -> &'static Mutex<HashMap<String, Instant>> {
    static PAUSED: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    PAUSED.get_or_init(Default::default)
}
type Waiters = HashMap<String, Vec<Box<dyn FnOnce() + Send>>>;
fn waiters() -> &'static Mutex<Waiters> {
    static WAITERS: OnceLock<Mutex<Waiters>> = OnceLock::new();
    WAITERS.get_or_init(Default::default)
}

fn lock_is_live(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < LOCK_STALE)
}

/// The cross-process download lock: created exclusively, kept fresh by a heartbeat thread
/// while held, removed on drop. A stale one (its process died) is taken over.
struct Lock {
    path: PathBuf,
    stop: Arc<AtomicBool>,
}

impl Lock {
    fn acquire(path: &Path) -> Option<Self> {
        for _ in 0..2 {
            match fs::OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(mut file) => {
                    let _ = write!(file, "{}", std::process::id());
                    let stop = Arc::new(AtomicBool::new(false));
                    let (beat, flag) = (path.to_path_buf(), stop.clone());
                    thread::spawn(move || {
                        while !flag.load(Ordering::SeqCst) {
                            thread::sleep(Duration::from_secs(2));
                            if !flag.load(Ordering::SeqCst) {
                                let _ = fs::write(&beat, std::process::id().to_string());
                            }
                        }
                    });
                    return Some(Self { path: path.to_path_buf(), stop });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if lock_is_live(path) {
                        return None;
                    }
                    let _ = fs::remove_file(path);
                }
                Err(_) => return None,
            }
        }
        None
    }
    fn touch(&self) {
        let _ = fs::write(&self.path, std::process::id().to_string());
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = fs::remove_file(&self.path);
    }
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

fn collect_files(path: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if path.is_file() {
        out.push(path.to_path_buf());
    } else if depth > 0
        && let Ok(entries) = fs::read_dir(path)
    {
        for entry in entries.flatten() {
            collect_files(&entry.path(), depth - 1, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_built_in_manifest_is_complete() {
        for spec in manifest() {
            assert!(spec.repo.starts_with("JonasWeinert/key-"), "{}", spec.id);
            assert!(!spec.revision.is_empty());
            assert_eq!(spec.license, "Apache-2.0");
            for file in &spec.files {
                assert_eq!(file.sha256.len(), 64, "{}", file.path);
                assert!(file.size > 0);
            }
        }
        assert!(manifest().iter().any(|s| s.id == LAYOUT));
        assert!(manifest().iter().any(|s| s.id == EMBEDDINGS));
        assert!(manifest().iter().any(|s| s.id == READER_EMBEDDINGS));
    }
}
