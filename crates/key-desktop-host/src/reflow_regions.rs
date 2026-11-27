// Reading mode's figures and tables for a PDF whose stored structure was made without the
// layout model: the model runs on its pages in the background while it is read (key-index
// reflow_regions.rs puts the regions into the text). The pages near the reader's place go first,
// at visible priority; the rest follow at background priority, yielding to the user's work and
// held on battery as the workspace's power setting says. Results are kept, page by page, in the
// workspace's cache of the 20 PDFs read last, so a second opening is instant.
//   store_reflow_regions {hash, page?} → {status: stored|missing|unavailable|running|held|ready|failed, version, analysed, pageCount}
use super::library_store::Library;
use key_index::reflow_regions::{CACHE_SIZE, PageRegions, RegionCache, needs_regions};
use key_store::priority::{self, Class};
use serde_json::{Value as Json, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A reader stops asking (closed, or reading mode left): its job ends after this.
const IDLE: Duration = Duration::from_secs(90);
/// Pages either side of the reader's that run at visible priority.
const NEAR: i64 = 2;
/// Pages per helper run in the background.
const BATCH: usize = 4;

struct Job {
    regions: PageRegions,
    near: i64,
    held: bool,
    seen: Instant,
    running: bool,
    error: Option<String>,
    version: u64,
}

type Jobs = Mutex<HashMap<String, Job>>;
static JOBS: std::sync::OnceLock<Jobs> = std::sync::OnceLock::new();
fn jobs() -> &'static Jobs {
    JOBS.get_or_init(Default::default)
}
/// One model run at a time across the host (it is heavy).
static RUN: Mutex<()> = Mutex::new(());
/// Cache files are written from the worker and read from commands.
static CACHE: Mutex<()> = Mutex::new(());

pub fn cache(library: &Library) -> RegionCache {
    RegionCache::new(library.store.root().join("reading-regions"), CACHE_SIZE)
}

fn key(library: &Library, hash: &str) -> String {
    format!("{}\u{0}{hash}", library.store.root().display())
}

/// The regions to show now for a PDF: the running job's, else the cache's. None when its stored
/// structure has its own (made by the model).
pub fn current(library: &Library, hash: &str, layout: &key_index::Layout) -> Option<PageRegions> {
    if !needs_regions(layout) {
        return None;
    }
    if let Some(job) = jobs().lock().ok()?.get(&key(library, hash)) {
        return Some(job.regions.clone());
    }
    let _guard = CACHE.lock().ok()?;
    cache(library).get(hash).filter(|r| r.file_hash == hash)
}

/// Starts (or steers) the model for a PDF read in reading mode and says how far it is.
pub fn poll(library: &Library, hash: &str, page: Option<i64>) -> Result<Json, String> {
    let source = library.store.source_by_hash(hash)?.ok_or("This PDF is not in the library")?;
    let stored = library.store.structure(&source.id)?.filter(|s| source.file_hash().is_none_or(|h| h == s.file_hash));
    let Some(stored) = stored else { return Ok(json!({ "status": "missing" })) };
    let layout: key_index::Layout = serde_json::from_str(&stored.layout).map_err(|e| e.to_string())?;
    if !needs_regions(&layout) {
        return Ok(json!({ "status": "stored" }));
    }
    let k = key(library, hash);
    let held = super::power::apply(library).is_some();
    let mut all = jobs().lock().map_err(|e| e.to_string())?;
    if let Some(job) = all.get_mut(&k) {
        job.seen = Instant::now();
        job.held = held;
        if let Some(page) = page {
            job.near = page;
        }
        return Ok(state(job));
    }
    let cached = {
        let _guard = CACHE.lock().map_err(|e| e.to_string())?;
        cache(library).get(hash).filter(|r| r.file_hash == hash)
    };
    if let Some(done) = cached.as_ref().filter(|r| r.complete()) {
        return Ok(json!({ "status": "ready", "version": 0, "analysed": done.analysed.len(), "pageCount": done.page_count }));
    }
    let Some(model) = crate::layout_helper::model_path().filter(|_| library.indexer.layout_model()) else {
        return Ok(json!({ "status": "unavailable" }));
    };
    let Some(path) = source.file_path() else { return Ok(json!({ "status": "unavailable" })) };
    let page_count = layout.page_count.max(layout.blocks.iter().map(|b| b.page as usize + 1).max().unwrap_or(0));
    let regions = cached.unwrap_or_else(|| PageRegions { file_hash: hash.to_string(), page_count, ..Default::default() });
    let job = Job { regions, near: page.unwrap_or(0), held, seen: Instant::now(), running: true, error: None, version: 0 };
    let reply = state(&job);
    all.insert(k.clone(), job);
    drop(all);
    let dir = library.store.root().join("reading-regions");
    let hash = hash.to_string();
    std::thread::Builder::new()
        .name("reading-regions".into())
        .spawn(move || work(k, hash, path, model, dir))
        .map_err(|e| e.to_string())?;
    Ok(reply)
}

fn state(job: &Job) -> Json {
    let status = if job.error.is_some() {
        "failed"
    } else if job.regions.complete() {
        "ready"
    } else if job.held {
        "held"
    } else {
        "running"
    };
    json!({ "status": status, "version": job.version, "analysed": job.regions.analysed.len(), "pageCount": job.regions.page_count, "error": job.error })
}

/// Pages not analysed yet, nearest the reader's first.
fn next_pages(job: &Job) -> (Vec<i64>, Class) {
    let mut open: Vec<i64> = (0..job.regions.page_count as i64).filter(|p| !job.regions.analysed.contains(p)).collect();
    open.sort_by_key(|p| ((p - job.near).abs(), *p));
    let near: Vec<i64> = open.iter().copied().filter(|p| (p - job.near).abs() <= NEAR).collect();
    if !near.is_empty() {
        return (near, Class::Visible);
    }
    (open.into_iter().take(BATCH).collect(), Class::Background)
}

fn work(k: String, hash: String, path: PathBuf, model: PathBuf, dir: PathBuf) {
    let cache = Arc::new(RegionCache::new(dir, CACHE_SIZE));
    loop {
        let (pages, class) = {
            let Ok(mut all) = jobs().lock() else { return };
            let Some(job) = all.get_mut(&k) else { return };
            if job.regions.complete() || job.seen.elapsed() > IDLE {
                job.running = false;
                // Finished (or nobody reads it): the cache has what was found.
                all.remove(&k);
                return;
            }
            let (pages, class) = next_pages(job);
            // On battery the background pages wait; what the reader is looking at does not.
            if class == Class::Background && job.held {
                drop(all);
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            (pages, class)
        };
        if class >= Class::Background {
            priority::with_class(class, priority::yield_if_needed);
        }
        let run = || {
            let _one = RUN.lock();
            priority::with_class(class, || {
                crate::layout_helper::regions(&path, &model, &pages, |found| {
                    let Ok(mut all) = jobs().lock() else { return };
                    let Some(job) = all.get_mut(&k) else { return };
                    job.regions.add_page(found.page, found.regions);
                    job.version += 1;
                    let snapshot = job.regions.clone();
                    drop(all);
                    if let Ok(_guard) = CACHE.lock() {
                        cache.put(&hash, &snapshot);
                    }
                })
            })
        };
        if let Err(error) = run() {
            if let Ok(mut all) = jobs().lock() {
                if let Some(job) = all.get_mut(&k) {
                    // A page the model cannot read is skipped, not retried forever.
                    for page in &pages {
                        job.regions.add_page(*page, []);
                    }
                    job.error = Some(error);
                    job.version += 1;
                }
            }
            return;
        }
        // Pages the helper skipped (out of range) count as done.
        if let Ok(mut all) = jobs().lock() {
            if let Some(job) = all.get_mut(&k) {
                for page in &pages {
                    if !job.regions.analysed.contains(page) {
                        job.regions.add_page(*page, []);
                        job.version += 1;
                    }
                }
            }
        }
    }
}
