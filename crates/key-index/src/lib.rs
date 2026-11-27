// Background indexing for a key-store workspace. Sources are hashed, their text is
// extracted (PDF pages through the host's PDFium service, HTML snapshots, plain
// text), cut into overlapping chunks that keep page geometry for highlighting,
// and embedded with EmbeddingGemma 2 when the model is available. Text becomes
// keyword-searchable immediately; vectors are back-filled once the model arrives.
//
// Scheduling: one source is extracted while the previous one is embedded. What the
// user is working with goes first (opened in the reader, then selected, then on
// screen); everything else follows files-before-references, newest first.
//
// Notes are cut into passages as they are saved (cheap, so keyword search is current);
// their vectors follow through the same back-fill once a note has been left alone.
//
// Files in indexed linked folders are read between sources, a few per round, opened ones
// first (`prioritize` with `file:<id>`); their vectors also come from the back-fill.
mod chunk;
mod layout;
mod links;
mod note;
pub use chunk::{PageText, TextChar, chunk_pages, page_lines};
pub use layout::{Layout, LayoutBlock, LayoutSentence, chunk_layout};
pub use links::{note_links, parse_href};
pub use note::chunk_note;

use key_embed::{Embedder, ModelDir};
use key_store::{
    ChunkInput, Evidence, EvidenceLine, EvidencePage, Identification, LinkedFile, Note, Source, Store, document_doi, plausible_title, push_title, tagged_values,
    title_candidates,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    path::Path,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, String>;
use key_store::priority::{self, Class};

/// The class a document is indexed at: what the user opened or selected is foreground work,
/// rows on screen visible work, the rest background.
pub fn job_class(priority: Option<Priority>) -> Class {
    match priority {
        Some(Priority::Opened | Priority::Selected) => Class::Foreground,
        Some(Priority::Visible) => Class::Visible,
        None => Class::Background,
    }
}

/// A checkpoint for long steps of indexing (between pages): pauses background documents
/// while a user action runs.
pub fn checkpoint() {
    priority::yield_if_needed();
}

/// Page text for a PDF on disk. Implemented by the host, which owns PDFium.
/// `progress(done, total)` is called as pages are read.
pub trait PdfText: Send + Sync + 'static {
    fn pages(&self, path: &Path, hash: &str, progress: &dyn Fn(usize, usize)) -> Result<Vec<PageText>>;
    /// Layout analysis (blocks in reading order, Markdown), with the layout model when
    /// `model` is set. `None` when the host has none; errors fall back to `pages`.
    fn layout(&self, _path: &Path, _hash: &str, _model: bool) -> Result<Option<Layout>> {
        Ok(None)
    }
    /// `layout`, reporting `progress(phase, done, total)` per page as it goes: phase
    /// "layout" reads the page geometry, "layout-model" runs the layout model.
    fn layout_with_progress(&self, path: &Path, hash: &str, model: bool, _progress: &dyn Fn(&str, usize, usize)) -> Result<Option<Layout>> {
        self.layout(path, hash, model)
    }
    /// The document information and the text of the first pages and the last, for
    /// identifying an added PDF. `None` when the host cannot read them.
    fn document_info(&self, _path: &Path) -> Result<Option<DocumentInfo>> {
        Ok(None)
    }
}

/// What a PDF says about itself (see `PdfText::document_info`).
#[derive(Clone, Debug, Default)]
pub struct DocumentInfo {
    /// The document information title.
    pub title: Option<String>,
    /// All document information values.
    pub metadata: Vec<String>,
    /// The first two pages and the last.
    pub pages: Vec<PageText>,
    pub page_count: usize,
}

/// Why a source jumps the queue, strongest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Visible,
    Selected,
    Opened,
}
impl Priority {
    pub fn parse(reason: &str) -> Option<Self> {
        match reason {
            "visible" => Some(Self::Visible),
            "selected" => Some(Self::Selected),
            "opened" => Some(Self::Opened),
            _ => None,
        }
    }
    /// How long a request stays in force: rows scroll away, selections change.
    fn lifetime(self) -> Duration {
        Duration::from_secs(match self {
            Self::Visible => 120,
            Self::Selected => 600,
            Self::Opened => 3600,
        })
    }
}

/// One source moving through a stage.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub title: String,
    pub kind: String,
    /// opening | identifying | analysing | reading | chunking | embedding
    pub stage: String,
    /// Pages read, or passages embedded, so far.
    pub done: u64,
    pub total: u64,
    pub priority: Option<Priority>,
    /// Within `analysing`: "layout" (page geometry) or "layout-model"; `done`/`total` are
    /// that pass's pages, and `step` of `steps` says which pass it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<u8>,
}

/// What indexing is doing right now, for progress displays.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub paused: bool,
    pub reading: Option<Job>,
    pub embedding: Option<Job>,
    pub up_next: Vec<Job>,
    /// Sources finished since indexing last went idle, and that batch's size.
    pub batch_done: u64,
    pub batch_total: u64,
    /// Recent average time per source, once a few have finished.
    pub seconds_per_source: Option<f64>,
    /// Passages waiting for vectors (indexed before the search model was ready).
    pub vectors_pending: u64,
}

#[derive(Default)]
struct Live {
    reading: Option<Job>,
    embedding: Option<Job>,
    batch_done: u64,
    finishes: VecDeque<Instant>,
}

#[derive(Default)]
struct Signal {
    wake: Mutex<bool>,
    condvar: Condvar,
}

/// One indexing worker per workspace store.
#[derive(Clone)]
pub struct Indexer {
    store: Store,
    models: ModelDir,
    embedder: Arc<Mutex<Option<Arc<Embedder>>>>,
    signal: Arc<Signal>,
    paused: Arc<AtomicBool>,
    busy: Arc<AtomicBool>,
    finished: Arc<Mutex<Vec<String>>>,
    live: Arc<Mutex<Live>>,
    priorities: Arc<Mutex<HashMap<String, (Priority, Instant)>>>,
    /// Run the layout model during layout analysis (on by default).
    layout_model: Arc<AtomicBool>,
    /// Embed passages for semantic search (on by default). Off (`KEY_INDEX_EMBEDDINGS=0`),
    /// sources are still analysed and keyword-indexed, but no model is loaded or fetched.
    embeddings: Arc<AtomicBool>,
    /// Sources being indexed now, by either lane.
    working: Arc<Mutex<std::collections::HashSet<String>>>,
    /// The opened-document lane: a document the user opens while bulk indexing reads another
    /// one is indexed at once beside it instead of after it.
    opened_lane: Arc<AtomicBool>,
    pdf: Arc<Mutex<Option<Arc<dyn PdfText>>>>,
}

impl Indexer {
    pub fn start(store: Store, models: ModelDir, pdf: Arc<dyn PdfText>) -> Self {
        let indexer = Self {
            working: Arc::default(),
            opened_lane: Arc::default(),
            pdf: Arc::new(Mutex::new(Some(pdf.clone()))),
            store,
            models,
            embedder: Arc::default(),
            signal: Arc::default(),
            paused: Arc::default(),
            busy: Arc::default(),
            finished: Arc::default(),
            live: Arc::default(),
            priorities: Arc::default(),
            layout_model: Arc::new(AtomicBool::new(true)),
            embeddings: Arc::new(AtomicBool::new(std::env::var("KEY_INDEX_EMBEDDINGS").map_or(true, |v| v != "0"))),
        };
        let worker = indexer.clone();
        thread::Builder::new()
            .name("key-index".into())
            .spawn(move || worker.run(pdf))
            .expect("spawn indexer");
        indexer
    }

    pub fn wake(&self) {
        if let Ok(mut wake) = self.signal.wake.lock() {
            *wake = true;
            self.signal.condvar.notify_all();
        }
    }
    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
        self.wake();
    }
    /// Whether layout analysis uses the layout model; applies to sources analysed from now on.
    pub fn set_layout_model(&self, enabled: bool) {
        self.layout_model.store(enabled, Ordering::SeqCst);
    }
    pub fn layout_model(&self) -> bool {
        self.layout_model.load(Ordering::SeqCst)
    }
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    /// Moves sources ahead in the queue. A stronger reason is never downgraded by a weaker one.
    pub fn prioritize(&self, ids: &[String], priority: Priority) {
        let Ok(mut wanted) = self.priorities.lock() else { return };
        let now = Instant::now();
        for id in ids {
            let entry = wanted.entry(id.clone()).or_insert((priority, now));
            if priority >= entry.0 || entry.1.elapsed() > entry.0.lifetime() {
                *entry = (priority, now);
            }
        }
        drop(wanted);
        self.wake();
        if priority == Priority::Opened {
            self.start_opened_lane();
        }
    }

    /// Claims a source for indexing; false when a lane already has it.
    fn claim(&self, id: &str) -> bool {
        self.working.lock().map(|mut w| w.insert(id.to_string())).unwrap_or(false)
    }
    fn release(&self, id: &str) {
        if let Ok(mut working) = self.working.lock() {
            working.remove(id);
        }
    }
    fn working(&self) -> Vec<String> {
        self.working.lock().map(|w| w.iter().cloned().collect()).unwrap_or_default()
    }

    /// While bulk indexing is busy with another document, indexes the opened ones on a lane
    /// of their own at foreground priority (one lane at most).
    fn start_opened_lane(&self) {
        if !self.is_busy() || self.is_paused() || self.opened_lane.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(pdf) = self.pdf.lock().ok().and_then(|p| p.clone()) else {
            self.opened_lane.store(false, Ordering::SeqCst);
            return;
        };
        let lane = self.clone();
        let spawned = thread::Builder::new().name("key-index-opened".into()).spawn(move || {
            priority::set_thread_class(Class::Foreground);
            while let Some(id) = lane.next_opened() {
                if let Err(error) = lane.index(&id, pdf.as_ref()) {
                    let _ = lane.store.set_index_status(&id, "failed", Some(&error), 0, 0);
                }
                lane.release(&id);
                lane.wake();
            }
            lane.opened_lane.store(false, Ordering::SeqCst);
        });
        if spawned.is_err() {
            self.opened_lane.store(false, Ordering::SeqCst);
        }
    }

    /// The next opened source no lane has, claimed.
    fn next_opened(&self) -> Option<String> {
        let (id, _) = self.queue(1, &self.working()).into_iter().find(|(_, p)| *p == Some(Priority::Opened))?;
        self.claim(&id).then_some(id)
    }

    /// The stage `id` is in right now (reading before embedding), if it is being indexed.
    pub fn job(&self, id: &str) -> Option<Job> {
        let live = self.live.lock().ok()?;
        [&live.reading, &live.embedding].into_iter().flatten().find(|job| job.id == id).cloned()
    }

    pub fn activity(&self) -> Activity {
        let (reading, embedding, batch_done, seconds_per_source) = match self.live.lock() {
            Ok(live) => {
                let pace = (live.finishes.len() >= 3).then(|| {
                    let span = live.finishes.back().unwrap().duration_since(*live.finishes.front().unwrap());
                    span.as_secs_f64() / (live.finishes.len() - 1) as f64
                });
                (live.reading.clone(), live.embedding.clone(), live.batch_done, pace)
            }
            Err(_) => Default::default(),
        };
        let queued = self.store.index_queue_len().unwrap_or(0).max(0) as u64;
        let busy = [&reading, &embedding].into_iter().flatten().map(|j| j.id.as_str()).collect::<Vec<_>>();
        let up_next = self
            .queue(6, &busy.iter().map(|s| s.to_string()).collect::<Vec<_>>())
            .into_iter()
            .take(5)
            .filter_map(|(id, priority)| {
                let source = self.store.source(&id).ok()??;
                Some(Job { title: source.title().to_string(), kind: source.kind.clone(), stage: "queued".into(), priority, id, ..Default::default() })
            })
            .collect();
        Activity {
            paused: self.paused.load(Ordering::SeqCst),
            reading,
            embedding,
            up_next,
            batch_done,
            batch_total: if queued > 0 { batch_done + queued } else { 0 },
            seconds_per_source,
            vectors_pending: self.store.unembedded_chunks().unwrap_or(0).max(0) as u64,
        }
    }

    /// The next sources to index: requested ones first, then the store's order.
    fn queue(&self, limit: usize, skip: &[String]) -> Vec<(String, Option<Priority>)> {
        let mut out: Vec<(String, Option<Priority>)> = Vec::new();
        if let Ok(mut wanted) = self.priorities.lock() {
            wanted.retain(|_, (priority, at)| at.elapsed() <= priority.lifetime());
            let mut ranked: Vec<(String, Priority, Instant)> = wanted.iter().map(|(id, (p, at))| (id.clone(), *p, *at)).collect();
            ranked.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
            for (id, priority, _) in ranked {
                if out.len() == limit {
                    break;
                }
                if skip.contains(&id) || id.starts_with(FILE_PREFIX) {
                    continue;
                }
                match self.store.source(&id) {
                    Ok(Some(s)) if s.trashed_at.is_none() && matches!(s.index_status.as_str(), "pending" | "indexing") => {
                        out.push((id, Some(priority)))
                    }
                    // Already indexed (or gone): the request is spent.
                    _ => {
                        wanted.remove(&id);
                    }
                }
            }
        }
        if out.len() < limit {
            let rest = self.store.pending_sources(limit + skip.len() + out.len(), false).unwrap_or_default();
            for id in rest {
                if out.len() == limit {
                    break;
                }
                if !skip.contains(&id) && !out.iter().any(|(o, _)| *o == id) {
                    out.push((id, None));
                }
            }
        }
        out
    }

    fn priority_of(&self, id: &str) -> Option<Priority> {
        self.priorities.lock().ok()?.get(id).map(|(p, _)| *p)
    }
    pub fn model_status(&self) -> key_embed::ModelStatus {
        self.models.status()
    }

    /// Stops the search model (its files were removed); it starts again when next needed.
    pub fn unload_embedder(&self) {
        if let Ok(mut slot) = self.embedder.lock() {
            *slot = None;
        }
    }

    /// The loaded embedder, loading it once the files exist.
    pub fn embedder(&self) -> Option<Arc<Embedder>> {
        if !self.embeddings.load(Ordering::SeqCst) {
            return None;
        }
        if !self.models.is_ready() {
            // First need: fetch the model in the background (if the user allows automatic
            // downloads); passages keep their place and get vectors once it is here.
            let signal = self.clone();
            self.models.request(false, Some(Box::new(move || {
                let _ = signal.embedder();
                signal.wake();
            })));
            return None;
        }
        let mut slot = self.embedder.lock().ok()?;
        if slot.is_none() {
            match Embedder::load(&self.models) {
                Ok(embedder) => *slot = Some(Arc::new(embedder)),
                Err(error) => eprintln!("Key search model: {error}"),
            }
        }
        slot.clone()
    }

    /// Cuts a note into passages and records its links. Unchanged passages keep their
    /// vectors; the rest are embedded by the back-fill once the note settles.
    pub fn index_note(&self, note: &Note) -> Result<()> {
        let title = note.title.trim();
        let markdown = if title.is_empty() { note.body.clone() } else { format!("{title}\n\n{}", note.body) };
        self.store.replace_note_links(&note.id, note.updated_at, &note_links(&note.id, &note.body))?;
        self.store.replace_note_chunks(&note.id, note.updated_at, &chunk_note(&markdown))
    }

    /// Notes saved without passing through `index_note` (imports, older libraries).
    fn index_stale_notes(&self) {
        for note in self.store.stale_notes(50).unwrap_or_default() {
            if let Err(error) = self.index_note(&note) {
                eprintln!("Key note indexing for {}: {error}", note.id);
            }
        }
    }

    /// Reads a few changed files of indexed linked folders: opened ones first, then the most
    /// recently changed. Answers whether any were read, so the loop comes back for more.
    fn index_linked_files(&self, pdf: &dyn PdfText) -> bool {
        let wanted: Vec<String> = self
            .priorities
            .lock()
            .map(|p| p.keys().filter_map(|id| id.strip_prefix(FILE_PREFIX).map(String::from)).collect())
            .unwrap_or_default();
        let files = self.store.stale_linked_files(LINKED_FILES_PER_ROUND, &wanted).unwrap_or_default();
        for file in &files {
            let job = Job { id: format!("{FILE_PREFIX}{}", file.id), title: file.name.clone(), kind: "file".into(), stage: "reading".into(), ..Default::default() };
            self.set_reading(Some(job));
            let (chunks, error) = match linked_chunks(file, pdf) {
                Ok(chunks) => (chunks, None),
                Err(error) => (Vec::new(), Some(error)),
            };
            if let Err(error) = self.store.replace_file_chunks(&file.id, file.mtime, &chunks, error.as_deref()) {
                eprintln!("Key linked file indexing for {}: {error}", file.abs_path);
            }
            if let Ok(mut wanted) = self.priorities.lock() {
                wanted.remove(&format!("{FILE_PREFIX}{}", file.id));
            }
        }
        self.set_reading(None);
        !files.is_empty()
    }

    pub fn embed_query(&self, text: &str) -> Option<Vec<f32>> {
        self.embedder()?.embed_query(text).ok()
    }

    fn wait(&self, timeout: Duration) {
        if let Ok(guard) = self.signal.wake.lock() {
            if let Ok((mut guard, _)) = self.signal.condvar.wait_timeout_while(guard, timeout, |wake| !*wake) {
                *guard = false;
            }
        }
    }

    fn run(self, pdf: Arc<dyn PdfText>) {
        // A model already on disk starts now, so the first search does not wait for it.
        if self.embeddings.load(Ordering::SeqCst) && self.models.is_ready() {
            let signal = self.clone();
            thread::spawn(move || {
                let _ = signal.embedder();
            });
        }
        // Two stages: extraction of the next documents overlaps embedding of the current one.
        let (sender, receiver) = mpsc::sync_channel::<Prepared>(2);
        let embedding = self.clone();
        thread::Builder::new()
            .name("key-embed".into())
            .spawn(move || embedding.embed_stage(receiver))
            .expect("spawn embedder");
        let mut in_flight: Vec<String> = Vec::new();
        loop {
            // Between documents: bulk indexing makes way for what the user is doing.
            priority::set_thread_class(Class::Background);
            priority::yield_if_needed();
            if self.paused.load(Ordering::SeqCst) {
                self.wait(Duration::from_secs(30));
                continue;
            }
            if let Ok(done) = self.finished.lock().map(|mut done| std::mem::take(&mut *done)) {
                in_flight.retain(|id| !done.contains(id));
            }
            self.index_stale_notes();
            let read_files = self.index_linked_files(pdf.as_ref());
            let mut skip = self.working();
            skip.extend(in_flight.iter().cloned());
            let next = self.queue(1, &skip).into_iter().next().map(|(id, _)| id);
            if next.as_ref().is_some_and(|id| !self.claim(id)) {
                continue;
            }
            let Some(id) = next else {
                if read_files {
                    continue;
                }
                if in_flight.is_empty() {
                    self.busy.store(false, Ordering::SeqCst);
                    if let Ok(mut live) = self.live.lock() {
                        *live = Live::default();
                    }
                    // Idle: older PDFs are identified in the background, one at a time with
                    // a pause between, so anything new or wanted goes first.
                    if self.backfill_identify(pdf.as_ref()) {
                        self.wait(BACKFILL_PAUSE);
                        continue;
                    }
                }
                self.wait(Duration::from_secs(if in_flight.is_empty() { 60 } else { 2 }));
                continue;
            };
            self.busy.store(true, Ordering::SeqCst);
            // The document the user opened is read as foreground work (its layout helper too).
            priority::set_thread_class(job_class(self.priority_of(&id)));
            match self.prepare(&id, pdf.as_ref()) {
                Ok(Some(prepared)) => {
                    in_flight.push(id);
                    if sender.send(prepared).is_err() {
                        return;
                    }
                }
                Ok(None) => self.release(&id),
                Err(error) => {
                    let _ = self.store.set_index_status(&id, "failed", Some(&error), 0, 0);
                    self.release(&id);
                }
            }
        }
    }

    fn embed_stage(self, receiver: mpsc::Receiver<Prepared>) {
        priority::set_thread_class(Class::Background);
        loop {
            match receiver.recv_timeout(Duration::from_secs(3)) {
                Ok(prepared) => {
                    let id = prepared.id.clone();
                    if let Err(error) = self.embed(prepared) {
                        let _ = self.store.set_index_status(&id, "failed", Some(&error), 0, 0);
                    }
                    self.finish(id);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // Idle: give chunks indexed before the model was ready their vectors, one
                    // batch at a time so newly prepared documents are never kept waiting.
                    while !self.paused.load(Ordering::SeqCst) && self.backfill_vectors() {
                        if let Ok(prepared) = receiver.try_recv() {
                            let id = prepared.id.clone();
                            if let Err(error) = self.embed(prepared) {
                                let _ = self.store.set_index_status(&id, "failed", Some(&error), 0, 0);
                            }
                            self.finish(id);
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn finish(&self, id: String) {
        if let Ok(mut live) = self.live.lock() {
            live.batch_done += 1;
            live.finishes.push_back(Instant::now());
            while live.finishes.len() > 20 {
                live.finishes.pop_front();
            }
        }
        self.release(&id);
        if let Ok(mut done) = self.finished.lock() {
            done.push(id);
        }
        self.wake();
    }

    fn set_reading(&self, job: Option<Job>) {
        if let Ok(mut live) = self.live.lock() {
            live.reading = job;
        }
    }

    /// Embeds up to one batch of chunks that were indexed before the model was ready.
    fn backfill_vectors(&self) -> bool {
        let Some(embedder) = self.embedder() else { return false };
        let Ok(rows) = self.store.chunks_without_vectors(64) else { return false };
        if rows.is_empty() {
            return false;
        }
        let items: Vec<(&str, &str)> = rows.iter().map(|(_, title, text)| (title.as_str(), text.as_str())).collect();
        match embedder.embed_documents(&items) {
            Ok(vectors) => {
                let pairs: Vec<(i64, Vec<f32>)> = rows.iter().map(|(id, _, _)| *id).zip(vectors).collect();
                self.store.set_chunk_vectors(&pairs).is_ok()
            }
            Err(error) => {
                eprintln!("Key embedding: {error}");
                false
            }
        }
    }

    /// Indexes one source synchronously (both stages).
    pub fn index(&self, id: &str, pdf: &dyn PdfText) -> Result<()> {
        match self.prepare(id, pdf)? {
            Some(prepared) => self.embed(prepared),
            None => Ok(()),
        }
    }

    /// Stage one: hash, extract and chunk. Chunks are saved so keyword search works at once.
    fn prepare(&self, id: &str, pdf: &dyn PdfText) -> Result<Option<Prepared>> {
        let result = self.prepare_inner(id, pdf);
        self.set_reading(None);
        result
    }

    fn prepare_inner(&self, id: &str, pdf: &dyn PdfText) -> Result<Option<Prepared>> {
        let Some(source) = self.store.source(id)? else { return Ok(None) };
        self.store.set_index_status(id, "indexing", None, 0, 0)?;
        let job = Job {
            id: id.to_string(),
            title: source.title().to_string(),
            kind: source.kind.clone(),
            stage: "opening".into(),
            priority: self.priority_of(id),
            ..Default::default()
        };
        self.set_reading(Some(job.clone()));
        let mut chunks = abstract_chunk(&source).into_iter().collect::<Vec<_>>();
        let mut status = "ready";
        let mut analysis = None;
        if let Some(path) = source.file_path() {
            if !path.is_file() {
                self.store.replace_chunks(id, &chunks)?;
                self.store.set_index_status(id, "missing", Some("The linked file was moved or deleted"), 0, 0)?;
                return Ok(None);
            }
            let hash = file_hash(&path)?;
            // An added PDF that carries the DOI of a reference already in the library joins
            // it; that reference is indexed next in its place.
            if source.kind == "pdf" && self.identify(&source, &path, &hash, pdf, &job)? {
                return Ok(None);
            }
            let mut patch = serde_json::Map::new();
            if source.file_hash() != Some(hash.as_str()) {
                patch.insert("fileHash".into(), serde_json::Value::from(hash.clone()));
            }
            // PDFs go through layout analysis (reading order, sections, no page furniture);
            // plain PDF text is the fallback when it is unavailable or fails.
            let mut analysed = None;
            // The same file analysed elsewhere already (a web PDF read before it was added).
            let carried = if source.kind == "pdf" { self.store.take_carried_analysis(&hash)? } else { None };
            if carried.is_none() && source.kind == "pdf" {
                self.set_reading(Some(Job { stage: "analysing".into(), ..job.clone() }));
                let model = self.layout_model();
                let steps = if model { 2 } else { 1 };
                let progress = |phase: &str, done: usize, total: usize| {
                    let step = if phase == "layout-model" { 2 } else { 1 };
                    self.set_reading(Some(Job {
                        stage: "analysing".into(),
                        done: done as u64,
                        total: total as u64,
                        phase: Some(phase.to_string()),
                        step: Some(step),
                        steps: Some(steps.max(step)),
                        ..job.clone()
                    }))
                };
                match pdf.layout_with_progress(&path, &hash, model, &progress) {
                    Ok(layout) => analysed = layout,
                    Err(error) => eprintln!("Key layout analysis for {id} fell back to PDF text: {error}"),
                }
            }
            if let Some(layout) = &analysed {
                self.identify_by_heading(&source, &hash, layout)?;
            }
            let (body, page_count, engine, markdown) = match (carried, analysed) {
                (Some(carried), _) => {
                    let pages = carried.page_count.unwrap_or_else(|| carried.chunks.iter().filter_map(|c| c.page).max().map_or(0, |p| p + 1)) as usize;
                    (carried.chunks, pages, carried.engine, carried.markdown)
                }
                (None, Some(layout)) => {
                    self.set_reading(Some(Job { stage: "chunking".into(), done: layout.page_count as u64, total: layout.page_count as u64, ..job.clone() }));
                    (chunk_layout(&layout.blocks), layout.page_count, layout.engine, Some(layout.markdown))
                }
                (None, None) => {
                    let pages = match source.kind.as_str() {
                        "pdf" => pdf.pages(&path, &hash, &|done, total| {
                            self.set_reading(Some(Job { stage: "reading".into(), done: done as u64, total: total as u64, ..job.clone() }))
                        })?,
                        "web" | "file" if is_text_like(&path, source.field("mime")) => vec![PageText::plain(read_text(&path)?)],
                        _ => Vec::new(),
                    };
                    self.set_reading(Some(Job { stage: "chunking".into(), done: pages.len() as u64, total: pages.len() as u64, ..job.clone() }));
                    let engine = if source.kind == "pdf" { "pdfium" } else { "text" };
                    (chunk_pages(&pages), pages.len(), engine.to_string(), None)
                }
            };
            if source.kind == "pdf" {
                patch.insert("pageCount".into(), serde_json::Value::from(page_count));
            }
            if !patch.is_empty() {
                self.store.update_source(id, &patch)?;
            }
            if body.is_empty() && matches!(source.kind.as_str(), "pdf" | "web") {
                status = "no_text";
            }
            chunks.extend(body);
            analysis = Some((engine, markdown, source.kind == "pdf"));
        }
        self.store.replace_chunks(id, &chunks)?;
        // A saved web page's references come from its HTML (the shell stores them as "html"):
        // indexing its text again keeps them.
        let html_references = source.kind == "web" && self.store.analysis(id)?.is_some_and(|a| a.engine == "html");
        if let Some((engine, markdown, references)) = analysis.filter(|_| !html_references) {
            self.store.set_analysis(id, &engine, markdown.as_deref(), references && status == "ready")?;
        }
        self.store.set_index_status(id, "indexing", None, 0, chunks.len() as i64)?;
        Ok(Some(Prepared { id: id.to_string(), title: source.title().to_string(), kind: source.kind.clone(), chunks, status }))
    }

    /// Identifies an added PDF once per file (see key_store::identify): a DOI it carries is
    /// attached (which queues the metadata lookup), or the PDF joins a metadata-only source
    /// with that DOI (answers true); without one, the titles to search for are kept and a
    /// title lookup is queued when the source has little metadata of its own.
    fn identify(&self, source: &Source, path: &Path, hash: &str, pdf: &dyn PdfText, job: &Job) -> Result<bool> {
        let known = ["doi", "pmid", "openalexId"].iter().any(|f| source.field(f).is_some_and(|v| !v.trim().is_empty()));
        let mut record = self.store.identification(&source.id)?.unwrap_or_default();
        if known || record.hash.as_deref() == Some(hash) {
            return Ok(false);
        }
        self.set_reading(Some(Job { stage: "identifying".into(), ..job.clone() }));
        let info = match pdf.document_info(path) {
            Ok(Some(info)) => info,
            Ok(None) => return Ok(false),
            Err(error) => {
                eprintln!("Key identification of {}: {error}", source.id);
                return Ok(false);
            }
        };
        let pages: Vec<EvidencePage> = info
            .pages
            .iter()
            .enumerate()
            .map(|(order, page)| EvidencePage {
                index: page.page.map_or(order, |p| p.max(0) as usize),
                lines: page_lines(page).into_iter().map(|(text, size)| EvidenceLine { text, size }).collect(),
            })
            .collect();
        let evidence = Evidence { tagged: tagged_values(&head_and_tail(path)), metadata: info.metadata, title: info.title, pages, page_count: info.page_count };
        record.hash = Some(hash.to_string());
        record.first_page = evidence.pages.iter().find(|p| p.index == 0).map(|p| p.text().chars().take(4000).collect());
        match document_doi(&evidence) {
            Some(found) => {
                record.via = Some(found.via.to_string());
                record.doi = Some(found.doi.clone());
                record.alternates = found.alternates;
                record.titles.clear();
                self.store.set_identification(&source.id, &record)?;
                if let Some(reference) = self.store.file_less_source_for(&source.id, None, Some(&found.doi))? {
                    self.store.adopt_file(&reference, &source.id)?;
                    return Ok(true);
                }
                let mut patch = serde_json::Map::new();
                patch.insert("doi".into(), serde_json::Value::from(found.doi));
                self.store.update_source(&source.id, &patch)?;
            }
            None => {
                record.titles = title_candidates(&evidence, record.placeholder.as_deref());
                self.store.set_identification(&source.id, &record)?;
                if !record.titles.is_empty() && thin(source, &record) {
                    self.store.queue_lookup(&source.id)?;
                }
            }
        }
        Ok(false)
    }

    /// The background pass over PDFs in the library from before they were identified on
    /// arrival (or never matched): identifies one (as `identify` does for an added PDF) and
    /// queues a background lookup by its DOI or titles, behind every other lookup. Answers
    /// whether one was taken.
    fn backfill_identify(&self, pdf: &dyn PdfText) -> bool {
        let Ok(Some(id)) = self.store.next_backfill_identification() else { return false };
        if let Err(error) = self.backfill_one(&id, pdf) {
            eprintln!("Key identification backfill of {id}: {error}");
        }
        self.set_reading(None);
        // Marked whatever happened, so a file that cannot be read is not taken again.
        if self.store.source(&id).ok().flatten().is_some() {
            let _ = self.store.mark_backfilled(&id);
        }
        true
    }

    fn backfill_one(&self, id: &str, pdf: &dyn PdfText) -> Result<()> {
        let Some(source) = self.store.source(id)? else { return Ok(()) };
        let Some(path) = source.file_path().filter(|p| p.is_file()) else { return Ok(()) };
        let hash = file_hash(&path)?;
        // Identified before and its identifier since removed: the user's edit stands.
        if self.store.identification(id)?.is_some_and(|r| r.hash.as_deref() == Some(hash.as_str()) && (r.doi.is_some() || r.via.is_some())) {
            return Ok(());
        }
        // Added before file-name titles were recorded: a title that is still the file's name
        // may give way to the work's, as for a PDF added now.
        let mut record = self.store.identification(id)?.unwrap_or_default();
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if record.placeholder.is_none() && !source.title().trim().is_empty() && key_store::name_key(source.title()) == key_store::name_key(&stem) {
            record.placeholder = Some(source.title().to_string());
            self.store.set_identification(id, &record)?;
        }
        let job = Job { id: id.to_string(), title: source.title().to_string(), kind: source.kind.clone(), stage: "identifying".into(), ..Default::default() };
        // Joined a reference: that one is indexed again and gets its own lookup.
        if self.identify(&source, &path, &hash, pdf, &job)? {
            return Ok(());
        }
        let Some(source) = self.store.source(id)? else { return Ok(()) };
        let record = self.store.identification(id)?.unwrap_or_default();
        let has_doi = source.field("doi").is_some_and(|d| !d.trim().is_empty());
        let own_title = plausible_title(source.title(), record.placeholder.as_deref()).is_some();
        if has_doi || !record.titles.is_empty() || own_title {
            self.store.queue_backfill_lookup(id)?;
        }
        Ok(())
    }

    /// The first heading layout analysis found on the first page is the best title to
    /// search for, when the PDF carried no DOI.
    fn identify_by_heading(&self, source: &Source, hash: &str, layout: &Layout) -> Result<()> {
        let Some(mut record) = self.store.identification(&source.id)? else { return Ok(()) };
        if record.hash.as_deref() != Some(hash) || record.doi.is_some() || record.via.is_some() {
            return Ok(());
        }
        let heading = layout
            .blocks
            .iter()
            .take_while(|b| b.page == 0)
            .filter(|b| b.kind == "heading")
            .find_map(|b| plausible_title(&b.text, record.placeholder.as_deref()));
        let Some(heading) = heading else { return Ok(()) };
        let had = !record.titles.is_empty();
        let mut titles = vec![heading];
        for title in std::mem::take(&mut record.titles) {
            push_title(&mut titles, title);
        }
        record.titles = titles;
        self.store.set_identification(&source.id, &record)?;
        if !had && thin(source, &record) {
            self.store.queue_lookup(&source.id)?;
        }
        Ok(())
    }

    /// Stage two: embed the chunks and mark the source ready.
    fn embed(&self, prepared: Prepared) -> Result<()> {
        let result = self.embed_inner(prepared);
        if let Ok(mut live) = self.live.lock() {
            live.embedding = None;
        }
        result
    }

    fn embed_inner(&self, mut prepared: Prepared) -> Result<()> {
        let total = prepared.chunks.len() as i64;
        let job = Job {
            id: prepared.id.clone(),
            title: prepared.title.clone(),
            kind: prepared.kind.clone(),
            stage: "embedding".into(),
            total: total as u64,
            priority: self.priority_of(&prepared.id),
            ..Default::default()
        };
        if let Some(embedder) = self.embedder().filter(|_| total > 0) {
            if let Ok(mut live) = self.live.lock() {
                live.embedding = Some(job.clone());
            }
            let mut done = 0;
            let class = job_class(job.priority);
            for batch in prepared.chunks.chunks_mut(32) {
                priority::with_class(class, priority::yield_if_needed);
                let items: Vec<(&str, &str)> = batch.iter().map(|c| (prepared.title.as_str(), c.text.as_str())).collect();
                let vectors = embedder.embed_documents(&items)?;
                for (chunk, vector) in batch.iter_mut().zip(vectors) {
                    chunk.embedding = Some(vector);
                }
                done += batch.len() as i64;
                self.store.set_index_status(&prepared.id, "indexing", None, done, total)?;
                if let Ok(mut live) = self.live.lock() {
                    live.embedding = Some(Job { done: done as u64, ..job.clone() });
                }
            }
            self.store.replace_chunks(&prepared.id, &prepared.chunks)?;
        }
        self.store.set_index_status(&prepared.id, prepared.status, None, total, total)
    }
}

struct Prepared {
    id: String,
    title: String,
    kind: String,
    chunks: Vec<ChunkInput>,
    status: &'static str,
}

/// A source with little metadata of its own: its title still the file name, or no authors
/// and no year. Only these are looked up by title.
fn thin(source: &Source, record: &Identification) -> bool {
    record.placeholder.as_deref().is_some_and(|p| p == source.title()) || (source.creators.is_empty() && source.fields.get("year").is_none_or(|y| y.is_null()))
}

/// The start and end of a file, where its XMP packet and document information sit.
fn head_and_tail(path: &Path) -> Vec<u8> {
    const WHOLE: u64 = 32 << 20;
    const PART: usize = 4 << 20;
    let Ok(mut file) = std::fs::File::open(path) else { return Vec::new() };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut bytes = Vec::new();
    if size <= WHOLE {
        let _ = file.read_to_end(&mut bytes);
        return bytes;
    }
    use std::io::{Seek, SeekFrom};
    let mut head = vec![0; PART];
    let read = file.read(&mut head).unwrap_or(0);
    head.truncate(read);
    let mut tail = Vec::new();
    if file.seek(SeekFrom::End(-(PART as i64))).is_ok() {
        let _ = file.read_to_end(&mut tail);
    }
    head.extend(tail);
    head
}

/// Title + abstract as one chunk, so metadata-only references are semantically searchable.
fn abstract_chunk(source: &Source) -> Option<ChunkInput> {
    let text = source.field("abstract")?.trim();
    (!text.is_empty()).then(|| ChunkInput { text: text.to_string(), ..Default::default() })
}

const FILE_PREFIX: &str = "file:";
const LINKED_FILES_PER_ROUND: usize = 8;
/// Between two older PDFs identified in the background (cut short by new work).
const BACKFILL_PAUSE: Duration = Duration::from_secs(2);

/// A linked file's passages: Markdown by blocks like a note, text as paragraphs, PDFs by page.
fn linked_chunks(file: &LinkedFile, pdf: &dyn PdfText) -> Result<Vec<ChunkInput>> {
    let path = Path::new(&file.abs_path);
    match file.kind.as_str() {
        "pdf" => {
            let hash = file.hash.clone().unwrap_or_default();
            Ok(chunk_pages(&pdf.pages(path, &hash, &|_, _| {})?))
        }
        "markdown" | "text" => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            if bytes.iter().take(8192).any(|b| *b == 0) {
                return Err("Not a text file".into());
            }
            let text = String::from_utf8_lossy(&bytes);
            if file.kind == "markdown" {
                Ok(chunk_note(&format!("{}\n\n{text}", file.name)))
            } else {
                let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
                let text = if matches!(extension.as_str(), "html" | "htm") { chunk::html_text(&text) } else { text.into_owned() };
                Ok(chunk_pages(&[PageText::plain(text)]))
            }
        }
        _ => Ok(Vec::new()),
    }
}

pub fn file_hash(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
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

fn is_text_like(path: &Path, mime: Option<&str>) -> bool {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    mime.is_some_and(|m| m.starts_with("text/")) || matches!(extension.as_str(), "html" | "htm" | "txt" | "md" | "markdown")
}

fn read_text(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    Ok(if matches!(extension.as_str(), "html" | "htm") { chunk::html_text(&text) } else { text })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An indexer without its worker threads, to inspect scheduling.
    fn idle(store: &Store, models: &Path) -> Indexer {
        Indexer {
            store: store.clone(),
            models: ModelDir::new(models),
            embedder: Arc::default(),
            signal: Arc::default(),
            paused: Arc::default(),
            busy: Arc::default(),
            finished: Arc::default(),
            live: Arc::default(),
            priorities: Arc::default(),
            layout_model: Arc::new(AtomicBool::new(true)),
            // No model downloads from unit tests.
            embeddings: Arc::new(AtomicBool::new(false)),
            working: Arc::default(),
            opened_lane: Arc::default(),
            pdf: Arc::default(),
        }
    }

    #[test]
    fn an_opened_document_is_claimed_once_and_ahead_of_bulk_work() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let add = |title: &str| {
            let input = serde_json::from_value(serde_json::json!({"kind": "reference", "title": title, "indexStatus": "pending"})).unwrap();
            store.insert_source(input).unwrap().id
        };
        let (bulk, opened) = (add("Bulk"), add("Opened"));
        let indexer = idle(&store, dir.path());
        // Bulk indexing has the first one; the user opens the second.
        assert!(indexer.claim(&bulk));
        indexer.prioritize(std::slice::from_ref(&opened), Priority::Opened);
        assert_eq!(indexer.next_opened().as_deref(), Some(opened.as_str()));
        // Neither lane takes what the other has.
        assert_eq!(indexer.next_opened(), None);
        assert!(!indexer.claim(&opened));
        assert_eq!(job_class(indexer.priority_of(&opened)), Class::Foreground);
        assert_eq!(job_class(indexer.priority_of(&bulk)), Class::Background);
    }

    #[test]
    fn what_the_user_works_with_goes_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let add = |title: &str| {
            let input = serde_json::from_value(serde_json::json!({"kind": "reference", "title": title, "indexStatus": "pending"})).unwrap();
            let id = store.insert_source(input).unwrap().id;
            thread::sleep(Duration::from_millis(5));
            id
        };
        let (old, middle, new) = (add("old"), add("middle"), add("new"));
        let indexer = idle(&store, dir.path());
        let order = |indexer: &Indexer| indexer.queue(3, &[]).into_iter().map(|(id, p)| (id, p)).collect::<Vec<_>>();

        // Default: newest first.
        assert_eq!(order(&indexer)[0].0, new);
        // A selected row, then an opened one, move ahead in that order.
        indexer.prioritize(&[old.clone()], Priority::Selected);
        indexer.prioritize(&[middle.clone()], Priority::Opened);
        assert_eq!(order(&indexer), vec![(middle.clone(), Some(Priority::Opened)), (old.clone(), Some(Priority::Selected)), (new.clone(), None)]);
        // Scrolling past never downgrades a stronger request.
        indexer.prioritize(&[middle.clone()], Priority::Visible);
        assert_eq!(order(&indexer)[0].1, Some(Priority::Opened));
        // Once indexed, the request is spent.
        store.set_index_status(&middle, "ready", None, 1, 1).unwrap();
        assert_eq!(order(&indexer)[0].0, old);
        assert!(indexer.priority_of(&middle).is_none());
    }

    #[test]
    fn saving_a_note_records_its_links_and_edits_replace_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let indexer = idle(&store, dir.path());
        let input = serde_json::from_value(serde_json::json!({"kind": "pdf", "title": "Palma 2022"})).unwrap();
        let paper = store.insert_source(input).unwrap();
        let note = store.save_note(None, None, "Reading", &format!("See [Palma](key://source/{}) on income.", paper.id), None).unwrap();
        indexer.index_note(&note).unwrap();
        let back = store.item_links("source", &paper.id).unwrap().backlinks;
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].from.title, "Reading");
        assert_eq!(back[0].context.as_deref(), Some("See Palma on income."));

        thread::sleep(Duration::from_millis(2));
        let note = store.save_note(Some(&note.id), None, "Reading", "No more links.", None).unwrap();
        indexer.index_note(&note).unwrap();
        assert!(store.item_links("source", &paper.id).unwrap().backlinks.is_empty());
    }

    struct NoPdf;
    impl PdfText for NoPdf {
        fn pages(&self, _: &Path, _: &str, _: &dyn Fn(usize, usize)) -> Result<Vec<PageText>> {
            Err("no PDFs here".into())
        }
    }

    #[test]
    fn files_of_indexed_linked_folders_become_searchable_passages() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("field notes.md"), "# Visit\n\nThe clinic hands out bed nets.").unwrap();
        std::fs::write(outside.path().join("scan.pdf"), "%PDF").unwrap();
        let store = Store::open(dir.path().join(".key")).unwrap();
        let indexer = idle(&store, dir.path());
        let folder = store.link_folder(outside.path()).unwrap();
        store.sync_linked_folder(&folder.id, &[]).unwrap();
        assert!(!indexer.index_linked_files(&NoPdf), "not indexed: nothing to read");
        store.set_linked_folder(&folder.id, None, Some(true)).unwrap();
        assert!(indexer.index_linked_files(&NoPdf));
        // Read once; the PDF that failed is not retried until it changes.
        assert!(!indexer.index_linked_files(&NoPdf));
        let found = store.search(&key_store::SearchQuery { text: "bed nets".into(), ..Default::default() }, None).unwrap();
        assert_eq!(found.files.len(), 1);
        assert_eq!(found.files[0].name, "field notes.md");
        let folders = store.linked_folders().unwrap();
        assert_eq!((folders[0].indexed_files, folders[0].pending_files), (1, 0));
    }

    /// A PDF whose first page and last page are given as text.
    struct Paper(&'static str, &'static str);
    impl PdfText for Paper {
        fn pages(&self, _: &Path, _: &str, _: &dyn Fn(usize, usize)) -> Result<Vec<PageText>> {
            Ok(vec![PageText { page: Some(0), ..PageText::plain(self.0.into()) }])
        }
        fn document_info(&self, _: &Path) -> Result<Option<DocumentInfo>> {
            let page = |index: i64, text: &str| PageText { page: Some(index), ..PageText::plain(text.into()) };
            Ok(Some(DocumentInfo { title: Some("Untitled".into()), metadata: vec![], pages: vec![page(0, self.0), page(5, self.1)], page_count: 6 }))
        }
    }

    fn add_pdf(store: &Store, dir: &Path, name: &str) -> Source {
        let path = dir.join(format!("{name}.pdf"));
        std::fs::write(&path, format!("%PDF-1.7 {name}")).unwrap();
        let input = serde_json::from_value(serde_json::json!({"kind": "pdf", "title": name, "filePath": path, "indexStatus": "pending"})).unwrap();
        let source = store.insert_source(input).unwrap();
        store.set_identification(&source.id, &Identification { placeholder: Some(name.into()), ..Default::default() }).unwrap();
        source
    }

    #[test]
    fn an_added_pdf_gets_the_doi_it_carries_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join(".key")).unwrap();
        let indexer = idle(&store, dir.path());
        let paper = Paper("Utility of a Deep-Learning Algorithm\nJAMA Cardiol. 2021;6(6):624-632. doi:10.1001/jamacardio.2021.0185", "References\n1. doi:10.1000/cited");
        let source = add_pdf(&store, dir.path(), "PUBMED 33599681");
        indexer.prepare(&source.id, &paper).unwrap();
        let identified = store.source(&source.id).unwrap().unwrap();
        assert_eq!(identified.field("doi"), Some("10.1001/jamacardio.2021.0185"));
        assert_eq!(identified.field("enrichStatus"), Some("pending"), "the metadata lookup is queued");
        assert_eq!(identified.field("identifiedBy"), Some("page"));
        // Indexed again (the same file): not identified again, the user's DOI edit stands.
        let mut patch = serde_json::Map::new();
        patch.insert("doi".into(), serde_json::json!(""));
        store.update_source(&source.id, &patch).unwrap();
        indexer.prepare(&source.id, &paper).unwrap();
        assert_eq!(store.source(&source.id).unwrap().unwrap().field("doi"), None);
    }

    #[test]
    fn an_added_pdf_joins_the_reference_with_its_doi() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join(".key")).unwrap();
        let indexer = idle(&store, dir.path());
        let input = serde_json::from_value(serde_json::json!({"kind": "reference", "title": "Falls in memory care", "doi": "10.2196/17551"})).unwrap();
        let reference = store.insert_source(input).unwrap();
        let source = add_pdf(&store, dir.path(), "PUBMED 34137723");
        let paper = Paper("Original Paper\nReduction of Time on the Ground", "Please cite as:\nBayen E\ndoi: 10.2196/17551\nPMID:");
        assert!(indexer.prepare(&source.id, &paper).unwrap().is_none());
        assert!(store.source(&source.id).unwrap().is_none());
        let joined = store.source(&reference.id).unwrap().unwrap();
        assert_eq!((joined.kind.as_str(), joined.index_status.as_str(), joined.title()), ("pdf", "pending", "Falls in memory care"));
        assert!(joined.file_path().is_some_and(|p| p.ends_with("PUBMED 34137723.pdf")));
    }

    #[test]
    fn a_pdf_without_a_doi_is_looked_up_by_its_title_only_when_its_metadata_is_thin() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join(".key")).unwrap();
        let indexer = idle(&store, dir.path());
        let paper = Paper("Synthetic Scientific Paper About Things\nPrior work established the first result", "References\n1. doi:10.1000/one\n2. doi:10.1000/two");
        let source = add_pdf(&store, dir.path(), "scientific unlinked");
        indexer.prepare(&source.id, &paper).unwrap();
        let looked = store.source(&source.id).unwrap().unwrap();
        assert_eq!(looked.field("doi"), None, "reference DOIs are not the document's");
        assert_eq!(looked.field("enrichStatus"), Some("pending"));
        assert_eq!(store.identification(&source.id).unwrap().unwrap().titles, vec!["Synthetic Scientific Paper About Things"]);
        // Titled and authored by the user (or Zotero): no title search.
        let other = add_pdf(&store, dir.path(), "zotero item");
        let mut patch = serde_json::Map::new();
        patch.insert("title".into(), serde_json::json!("A curated title"));
        patch.insert("creators".into(), serde_json::json!([{"family": "Doe"}]));
        store.update_source(&other.id, &patch).unwrap();
        indexer.prepare(&other.id, &paper).unwrap();
        assert_eq!(store.source(&other.id).unwrap().unwrap().field("enrichStatus"), None);
    }

    /// A PDF already in the library, indexed before identification existed.
    fn older_pdf(store: &Store, dir: &Path, name: &str, fields: serde_json::Value) -> Source {
        let path = dir.join(format!("{name}.pdf"));
        std::fs::write(&path, format!("%PDF-1.7 {name}")).unwrap();
        let mut input = serde_json::json!({"kind": "pdf", "title": name, "filePath": path, "indexStatus": "ready"});
        input.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
        store.insert_source(serde_json::from_value(input).unwrap()).unwrap()
    }

    #[test]
    fn older_pdfs_are_identified_in_the_background_once_and_looked_up_last() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join(".key")).unwrap();
        let indexer = idle(&store, dir.path());
        let carries = Paper("Utility of a Deep-Learning Algorithm\nJAMA Cardiol. 2021;6(6):624-632. doi:10.1001/jamacardio.2021.0185", "End");
        let jama = older_pdf(&store, dir.path(), "jama", serde_json::json!({}));
        assert_eq!(store.backfill_status().unwrap(), key_store::BackfillStatus { identify: 1, lookup: 0 });
        assert!(indexer.backfill_identify(&carries));
        let s = store.source(&jama.id).unwrap().unwrap();
        assert_eq!(s.field("doi"), Some("10.1001/jamacardio.2021.0185"));
        assert_eq!(s.field("enrichStatus"), Some("backfill"), "behind every other lookup");
        assert_eq!(store.identification(&jama.id).unwrap().unwrap().placeholder.as_deref(), Some("jama"), "the file-name title may be replaced");
        assert!(store.next_enrichment(true, &[]).unwrap().is_none());
        assert_eq!(store.next_backfill_enrichment().unwrap().unwrap().id, jama.id);
        assert_eq!(store.backfill_status().unwrap(), key_store::BackfillStatus { identify: 0, lookup: 1 });
        assert!(!indexer.backfill_identify(&carries), "nothing else to do");

        // Without a DOI: looked up by its title, even with authors of its own; tried once.
        let paper = Paper("Synthetic Scientific Paper About Things\nPrior work established the first result", "References\n1. doi:10.1000/one");
        let curated = older_pdf(&store, dir.path(), "curated", serde_json::json!({"title": "A curated title", "creators": [{"family": "Doe"}]}));
        assert!(indexer.backfill_identify(&paper));
        assert_eq!(store.source(&curated.id).unwrap().unwrap().field("enrichStatus"), Some("backfill"));
        assert_eq!(store.source(&curated.id).unwrap().unwrap().title(), "A curated title");
        assert_eq!(store.identification(&curated.id).unwrap().unwrap().placeholder, None, "the user's title stays");
        store.enrichment_failed(&curated.id, "not_found", "none", None).unwrap();
        assert!(!indexer.backfill_identify(&paper), "the version stamp stops a retry");

        // A DOI the user removed from an identified PDF is not looked for again.
        let mut patch = serde_json::Map::new();
        patch.insert("doi".into(), serde_json::json!(""));
        store.update_source(&jama.id, &patch).unwrap();
        let mut record = store.identification(&jama.id).unwrap().unwrap();
        record.backfill = None;
        store.set_identification(&jama.id, &record).unwrap();
        assert!(indexer.backfill_identify(&carries));
        let s = store.source(&jama.id).unwrap().unwrap();
        assert_eq!((s.field("doi"), s.field("enrichStatus")), (None, None));

        // Paused, the indexer's loop takes none (the loop checks before it gets here).
        indexer.set_paused(true);
        assert!(indexer.is_paused());
    }
}
