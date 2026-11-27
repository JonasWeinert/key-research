// EmbeddingGemma 2 for search, served by llama.cpp's `llama-server`, which uses Metal
// on macOS and CUDA, Vulkan or the CPU elsewhere. The GGUF model is downloaded once, on
// first need, into the shared models directory (key-models); one server per machine is
// shared by all workspace hosts and is restarted on demand if it goes away.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

pub type Result<T> = std::result::Result<T, String>;

pub const MODEL_REPO: &str = "google/embeddinggemma-2";
pub const MODEL_NAME: &str = "embeddinggemma-2";
pub const DIMENSIONS: usize = 768;
const MODEL_FILE: &str = "embeddinggemma-2-Q8_0.gguf";
const BATCH: usize = 32;
/// Each of the server's 8 slots holds 4,096 tokens; longer inputs are rejected. Text past
/// this many characters (roughly 2,000–2,700 tokens) adds little to one passage's meaning.
const MAX_INPUT_CHARS: usize = 8000;

fn clip(text: &str) -> &str {
    text.char_indices().nth(MAX_INPUT_CHARS).map_or(text, |(at, _)| &text[..at])
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    /// missing | downloading | ready | failed | unavailable (no llama-server)
    pub state: String,
    pub model: String,
    pub received: u64,
    pub total: u64,
    pub error: Option<String>,
    /// metal | cuda | vulkan | cpu, once the server reports it
    pub accelerator: Option<String>,
}

/// Where the model lives: the shared models folder (key-models), one copy per machine,
/// downloaded on first need from its pinned Hugging Face revision.
#[derive(Clone, Debug)]
pub struct ModelDir(key_models::Models);

impl ModelDir {
    pub fn new(models_root: impl AsRef<Path>) -> Self {
        Self(key_models::Models::new(models_root.as_ref()))
    }
    /// `KEY_MODEL_DIR` if the shell set it, otherwise the user's application data folder.
    pub fn from_env() -> Self {
        Self(key_models::Models::from_env())
    }
    pub fn models(&self) -> &key_models::Models {
        &self.0
    }
    /// The model's folder (its server state and log live here too).
    pub fn path(&self) -> PathBuf {
        self.0.root().join(key_models::EMBEDDINGS)
    }
    pub fn model(&self) -> PathBuf {
        self.0.dir(key_models::EMBEDDINGS).map(|d| d.join(MODEL_FILE)).unwrap_or_default()
    }
    pub fn is_ready(&self) -> bool {
        self.0.ready(key_models::EMBEDDINGS)
    }
    fn server_file(&self) -> PathBuf {
        self.path().join(".server.json")
    }

    pub fn status(&self) -> ModelStatus {
        let model = MODEL_REPO.to_string();
        if self.is_ready() {
            if server_binary().is_none() {
                return ModelStatus {
                    state: "unavailable".into(),
                    model,
                    error: Some("llama-server is not bundled with this build".into()),
                    ..Default::default()
                };
            }
            let accelerator = fs::read(self.server_file())
                .ok()
                .and_then(|bytes| serde_json::from_slice::<ServerInfo>(&bytes).ok())
                .and_then(|info| info.accelerator);
            return ModelStatus { state: "ready".into(), model, accelerator, ..Default::default() };
        }
        match self.0.status(key_models::EMBEDDINGS) {
            Ok(status) => ModelStatus { state: status.state, model, received: status.received, total: status.total, error: status.error, accelerator: None },
            Err(error) => ModelStatus { state: "failed".into(), model, error: Some(error), ..Default::default() },
        }
    }

    /// Asks for the model in the background (when automatic downloads are on, or `explicit`);
    /// `then` runs once it is ready. Returns whether it is ready now.
    pub fn request(&self, explicit: bool, then: Option<Box<dyn FnOnce() + Send>>) -> bool {
        self.0.request(key_models::EMBEDDINGS, explicit, then)
    }
}

/// Servers this process started; `shutdown` stops them because the host exits without
/// running destructors.
static SPAWNED: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// Stops any llama-server this process started. Call before the process exits.
pub fn shutdown() {
    let pids = SPAWNED.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default();
    for pid in pids {
        let _ = if cfg!(windows) {
            Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).status()
        } else {
            Command::new("kill").arg(pid.to_string()).status()
        };
    }
}

#[derive(Serialize, Deserialize)]
struct ServerInfo {
    port: u16,
    pid: u32,
    accelerator: Option<String>,
    /// The llama-server process itself (`pid` is its watchdog shell).
    #[serde(default)]
    server_pid: Option<u32>,
}

/// What the shared server is working on, so bulk work runs at background priority and a
/// person's search never waits behind it: the server is put in the background while only
/// bulk batches are in flight and back in the foreground while a query is (macOS
/// `PRIO_DARWIN_BG`: lower CPU and GPU priority and throttled disk I/O, reversible).
#[derive(Default)]
struct Lanes {
    bulk: usize,
    waiting: usize,
    background: bool,
}

/// Puts a process in the background or back (macOS); elsewhere does nothing.
pub fn set_process_background(pid: u32, background: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn setpriority(which: i32, who: u32, prio: i32) -> i32;
        }
        const PRIO_DARWIN_PROCESS: i32 = 4;
        const PRIO_DARWIN_BG: i32 = 0x1000;
        // SAFETY: plain system call on a process id; no pointers.
        unsafe { setpriority(PRIO_DARWIN_PROCESS, pid, if background { PRIO_DARWIN_BG } else { 0 }) == 0 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (pid, background);
        false
    }
}

/// Lowers a process's CPU priority (Unix nice; raising it again needs privileges).
pub fn set_process_nice(pid: u32, nice: i32) -> bool {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn setpriority(which: i32, who: u32, prio: i32) -> i32;
        }
        const PRIO_PROCESS: i32 = 0;
        // SAFETY: plain system call on a process id; no pointers.
        unsafe { setpriority(PRIO_PROCESS, pid, nice) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, nice);
        false
    }
}

/// The child process a watchdog shell started (the server itself).
fn child_of(shell: u32) -> Option<u32> {
    let output = Command::new("pgrep").args(["-P", &shell.to_string()]).output().ok()?;
    String::from_utf8_lossy(&output.stdout).lines().filter_map(|l| l.trim().parse().ok()).next()
}

/// `llama-server` next to the host binary (`llama/llama-server`), or `KEY_LLAMA_SERVER`.
pub fn server_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("KEY_LLAMA_SERVER").map(PathBuf::from) {
        return path.is_file().then_some(path);
    }
    let name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join("llama").join(name);
    path.is_file().then_some(path)
}

pub struct Embedder {
    dir: ModelDir,
    client: reqwest::blocking::Client,
    port: Mutex<Option<u16>>,
    child: Mutex<Option<Child>>,
    /// The server's process, for its priority.
    server_pid: Mutex<Option<u32>>,
    lanes: Mutex<Lanes>,
    /// Bulk work may lower the server's priority (`KEY_EMBED_BACKGROUND=0` turns it off).
    lower: bool,
    /// Bulk work runs on a second server (`KEY_EMBED_BULK_SERVER=0` turns it off).
    second: bool,
    bulk: Mutex<Option<BulkServer>>,
}

struct BulkServer {
    port: u16,
    child: Child,
    /// The server under its watchdog shell.
    pid: Option<u32>,
    used: Instant,
}

impl BulkServer {
    fn stop(mut self) {
        // The server first (the shell's trap does not run when the shell is killed).
        if let Some(pid) = self.pid {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Embedder {
    pub fn load(dir: &ModelDir) -> Result<Self> {
        if !dir.is_ready() {
            return Err("The search model has not been downloaded yet".into());
        }
        if server_binary().is_none() {
            return Err("llama-server is not bundled with this build".into());
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;
        let lower = std::env::var("KEY_EMBED_BACKGROUND").map_or(true, |v| v != "0");
        let second = std::env::var("KEY_EMBED_BULK_SERVER").map_or(true, |v| v != "0");
        let embedder = Self { dir: dir.clone(), client, port: Mutex::new(None), child: Mutex::new(None), server_pid: Mutex::new(None), lanes: Mutex::default(), lower, second, bulk: Mutex::new(None) };
        embedder.port()?;
        Ok(embedder)
    }

    /// Document embeddings with the model's corpus prefix (`title: … | text: …`), as work
    /// someone is waiting for (an opened document).
    pub fn embed_documents(&self, items: &[(&str, &str)]) -> Result<Vec<Vec<f32>>> {
        self.embed_documents_as(items, false)
    }

    /// The same as bulk work (indexing in the background, back-fill): the server runs at
    /// background priority while only bulk batches are in flight.
    pub fn embed_bulk(&self, items: &[(&str, &str)]) -> Result<Vec<Vec<f32>>> {
        self.embed_documents_as(items, true)
    }

    fn embed_documents_as(&self, items: &[(&str, &str)], bulk: bool) -> Result<Vec<Vec<f32>>> {
        let inputs: Vec<String> = items
            .iter()
            .map(|(title, text)| {
                let title = title.trim();
                format!("title: {} | text: {}", if title.is_empty() { "none" } else { clip(title) }, clip(text.trim()))
            })
            .collect();
        let mut out = Vec::with_capacity(inputs.len());
        for batch in inputs.chunks(BATCH) {
            // Bulk work goes to a second server of its own, at background priority, so a
            // query never queues behind a bulk batch; the shared one if that cannot start.
            if bulk && self.second {
                if let Some(vectors) = self.bulk_port().and_then(|port| self.request_at(port, batch).ok()) {
                    out.extend(vectors);
                    continue;
                }
            }
            let _lane = self.enter(bulk);
            out.extend(self.run(batch)?);
        }
        Ok(out)
    }

    /// The bulk server's port, started on first need and stopped after a minute unused.
    fn bulk_port(&self) -> Option<u16> {
        let mut slot = self.bulk.lock().ok()?;
        if let Some(server) = slot.as_mut() {
            if server.child.try_wait().ok().flatten().is_none() {
                server.used = Instant::now();
                return Some(server.port);
            }
            *slot = None;
        }
        let binary = server_binary()?;
        let port = TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).ok()?.port();
        let child = match self.launch(&binary, port, "bulk-server.log", 8) {
            Ok(child) => child,
            Err(error) => {
                eprintln!("Key embedding: the bulk server did not start ({error})");
                return None;
            }
        };
        let pid = if cfg!(unix) { child_of(child.id()) } else { Some(child.id()) };
        // Lower CPU priority (nice 10), not the background band: that throttles its GPU work
        // and disk reads so much bulk indexing slows several times over (priority_bench).
        if let Some(pid) = pid.filter(|_| self.lower) {
            match std::env::var("KEY_EMBED_BULK_PRIORITY").as_deref() {
                Ok("background") => {
                    set_process_background(pid, true);
                }
                Ok("normal") => {}
                _ => {
                    set_process_nice(pid, 10);
                }
            }
        }
        if let Ok(mut pids) = SPAWNED.lock() {
            pids.push(child.id());
        }
        *slot = Some(BulkServer { port, child, pid, used: Instant::now() });
        Some(port)
    }

    /// Stops the bulk server once it has been idle for `idle` (the indexer calls this as it
    /// goes idle; a minute is the default).
    pub fn stop_bulk_server_if_idle(&self, idle: Duration) -> bool {
        let Ok(mut slot) = self.bulk.lock() else { return false };
        if slot.as_ref().is_some_and(|s| s.used.elapsed() >= idle) {
            if let Some(server) = slot.take() {
                server.stop();
                return true;
            }
        }
        false
    }

    /// Whether the bulk server is running (tests, benchmarks).
    pub fn has_bulk_server(&self) -> bool {
        self.bulk.lock().map(|s| s.is_some()).unwrap_or(false)
    }

    /// Counts a request in for its lane and sets the server's priority to match; the
    /// returned guard counts it out again.
    fn enter(&self, bulk: bool) -> LaneGuard<'_> {
        if let Ok(mut lanes) = self.lanes.lock() {
            if bulk {
                lanes.bulk += 1;
            } else {
                lanes.waiting += 1;
            }
            self.settle(&mut lanes);
        }
        LaneGuard { embedder: self, bulk }
    }

    fn settle(&self, lanes: &mut Lanes) {
        let background = self.lower && lanes.bulk > 0 && lanes.waiting == 0;
        if background == lanes.background {
            return;
        }
        let Some(pid) = self.server_process() else { return };
        if set_process_background(pid, background) {
            lanes.background = background;
        }
    }

    /// Whether the server runs at background priority now (tests, benchmarks).
    pub fn is_background(&self) -> bool {
        self.lanes.lock().map(|l| l.background).unwrap_or(false)
    }

    /// The llama-server process, found once per server.
    pub fn server_process(&self) -> Option<u32> {
        let mut slot = self.server_pid.lock().ok()?;
        if slot.is_none_or(|pid| !process_alive(pid)) {
            let info = fs::read(self.dir.server_file()).ok().and_then(|b| serde_json::from_slice::<ServerInfo>(&b).ok())?;
            *slot = info.server_pid.filter(|&pid| process_alive(pid)).or_else(|| child_of(info.pid)).or(Some(info.pid));
        }
        *slot
    }

    /// A search query embedding with the retrieval task prefix.
    pub fn embed_query(&self, query: &str) -> Result<Vec<f32>> {
        let input = format!("task: search result | query: {}", clip(query.trim()));
        let _lane = self.enter(false);
        self.run(std::slice::from_ref(&input))?.pop().ok_or_else(|| "No embedding returned".into())
    }

    fn run(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        match self.request(inputs) {
            Ok(vectors) => Ok(vectors),
            // The shared server may have exited with the host that started it; start our own.
            Err(_) => {
                *self.port.lock().map_err(|_| "Embedding server lock poisoned")? = None;
                self.request(inputs)
            }
        }
    }

    fn request(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        let port = self.port()?;
        self.request_at(port, inputs)
    }

    fn request_at(&self, port: u16, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        #[derive(Deserialize)]
        struct Item {
            embedding: Vec<f32>,
            index: usize,
        }
        #[derive(Deserialize)]
        struct Response {
            data: Vec<Item>,
        }
        let body = serde_json::to_vec(&serde_json::json!({ "input": inputs })).map_err(|e| e.to_string())?;
        let response = self
            .client
            .post(format!("http://127.0.0.1:{port}/v1/embeddings"))
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            let status = response.status();
            return Err(format!("Embedding server: HTTP {status} {}", response.text().unwrap_or_default()));
        }
        let mut parsed: Response = serde_json::from_str(&response.text().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        parsed.data.sort_by_key(|item| item.index);
        parsed
            .data
            .into_iter()
            .map(|item| {
                if item.embedding.len() != DIMENSIONS {
                    return Err(format!("Unexpected embedding width {}", item.embedding.len()));
                }
                Ok(normalize(&item.embedding))
            })
            .collect()
    }

    /// The port of a healthy server: the shared one if it answers, otherwise our own.
    fn port(&self) -> Result<u16> {
        let mut slot = self.port.lock().map_err(|_| "Embedding server lock poisoned")?;
        if let Some(port) = *slot {
            return Ok(port);
        }
        if let Some(info) = fs::read(self.dir.server_file()).ok().and_then(|b| serde_json::from_slice::<ServerInfo>(&b).ok()) {
            if self.healthy(info.port) {
                *slot = Some(info.port);
                return Ok(info.port);
            }
        }
        // One host starts the server; others wait for it instead of starting their own.
        let lock = self.dir.path().join(".server.lock");
        // A lock counts only while it is recent and the process that took it is still running,
        // so a host that quit mid-start never leaves the others waiting.
        let fresh = |path: &Path| {
            let recent = fs::metadata(path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|age| age < Duration::from_secs(90));
            recent && fs::read_to_string(path).ok().and_then(|pid| pid.trim().parse::<u32>().ok()).is_none_or(process_alive)
        };
        if fresh(&lock) || fs::OpenOptions::new().write(true).create_new(true).open(&lock).is_err() && fresh(&lock) {
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(90) {
                std::thread::sleep(Duration::from_millis(300));
                if let Some(info) = fs::read(self.dir.server_file()).ok().and_then(|b| serde_json::from_slice::<ServerInfo>(&b).ok()) {
                    if self.healthy(info.port) {
                        *slot = Some(info.port);
                        return Ok(info.port);
                    }
                }
                if !fresh(&lock) {
                    break;
                }
            }
        }
        let _ = fs::write(&lock, std::process::id().to_string());
        let result = self.spawn();
        let _ = fs::remove_file(&lock);
        let port = result?;
        *slot = Some(port);
        Ok(port)
    }

    fn healthy(&self, port: u16) -> bool {
        self.client
            .get(format!("http://127.0.0.1:{port}/health"))
            .timeout(Duration::from_secs(2))
            .send()
            .is_ok_and(|r| r.status().is_success())
    }

    fn spawn(&self) -> Result<u16> {
        let binary = server_binary().ok_or("llama-server is not bundled with this build")?;
        let port = TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
        let child = self.launch(&binary, port, "server.log", 8)?;
        if let Ok(mut pids) = SPAWNED.lock() {
            pids.push(child.id());
        }
        let accelerator = Some(accelerator(&binary));
        let server_pid = if cfg!(unix) { child_of(child.id()) } else { Some(child.id()) };
        let info = ServerInfo { port, pid: child.id(), accelerator, server_pid };
        if let Ok(mut slot) = self.server_pid.lock() {
            *slot = server_pid;
        }
        let _ = fs::write(self.dir.server_file(), serde_json::to_vec(&info).unwrap_or_default());
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut old) = slot.replace(child) {
                let _ = old.kill();
            }
        }
        Ok(port)
    }
}

struct LaneGuard<'a> {
    embedder: &'a Embedder,
    bulk: bool,
}

impl Drop for LaneGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut lanes) = self.embedder.lanes.lock() {
            if self.bulk {
                lanes.bulk = lanes.bulk.saturating_sub(1);
            } else {
                lanes.waiting = lanes.waiting.saturating_sub(1);
            }
            // Idle, the server goes back to normal priority, ready for the next query.
            if lanes.bulk == 0 && lanes.background {
                lanes.background = false;
                if let Some(pid) = self.embedder.server_process() {
                    set_process_background(pid, false);
                }
            } else {
                self.embedder.settle(&mut lanes);
            }
        }
    }
}

impl Embedder {
    /// Starts a llama-server on `port` and waits until it answers.
    fn launch(&self, binary: &Path, port: u16, log_name: &str, parallel: usize) -> Result<Child> {
        let log_path = self.dir.path().join(log_name);
        let log = fs::File::create(&log_path).map_err(|e| e.to_string())?;
        let mut arguments: Vec<String> = vec!["--model".into(), self.dir.model().to_string_lossy().into_owned()];
        let parallel = parallel.to_string();
        arguments.extend(
            ["--embedding", "--pooling", "mean", "--host", "127.0.0.1", "--port", &port.to_string()]
                .into_iter()
                .chain(["--n-gpu-layers", "999", "--ctx-size", &(4096 * parallel.parse::<usize>().unwrap_or(8)).to_string(), "--batch-size", "8192", "--ubatch-size", "8192", "--parallel", &parallel])
                .map(String::from),
        );
        let mut command = if cfg!(unix) {
            // A watchdog shell stops the server as soon as the host process is gone, however
            // the host exits (Electron may kill it without running any cleanup).
            let mut command = Command::new("/bin/sh");
            command
                .arg("-c")
                .arg(r#"server="$1"; shift; "$server" "$@" & child=$!; trap 'kill $child 2>/dev/null' EXIT TERM INT; while kill -0 "$KEY_HOST_PID" 2>/dev/null && kill -0 $child 2>/dev/null; do sleep 2; done"#)
                .arg("key-llama-watchdog")
                .arg(binary)
                .args(&arguments)
                .env("KEY_HOST_PID", std::process::id().to_string());
            command
        } else {
            let mut command = Command::new(binary);
            command.args(&arguments);
            command
        };
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(log);
        if let Some(dir) = binary.parent() {
            command.current_dir(dir);
        }
        let mut child = command.spawn().map_err(|e| format!("Could not start llama-server: {e}"))?;
        let started = Instant::now();
        while !self.healthy(port) {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("llama-server exited ({status}); see {}", log_path.display()));
            }
            if started.elapsed() > Duration::from_secs(90) {
                let _ = child.kill();
                return Err("llama-server did not become ready".into());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        Ok(child)
    }
}

impl Drop for Embedder {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.bulk.lock() {
            if let Some(server) = slot.take() {
                server.stop();
            }
        }
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// The first compute device llama.cpp reports, e.g. "Metal · Apple M2 Max".
fn accelerator(binary: &Path) -> String {
    let output = Command::new(binary)
        .arg("--list-devices")
        .current_dir(binary.parent().unwrap_or(Path::new(".")))
        .output()
        .map(|o| format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
        .unwrap_or_default();
    for line in output.lines().map(str::trim) {
        let Some((device, name)) = line.split_once(": ") else { continue };
        let name = name.split(" (").next().unwrap_or(name);
        let kind = match device.trim_end_matches(char::is_numeric) {
            "MTL" | "Metal" => "Metal",
            "CUDA" => "CUDA",
            "Vulkan" => "Vulkan",
            "ROCm" => "ROCm",
            _ => continue,
        };
        return format!("{kind} · {name}");
    }
    "CPU".into()
}

fn normalize(vector: &[f32]) -> Vec<f32> {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-12);
    vector.iter().map(|v| v / norm).collect()
}

/// Whether a process is still running (Unix); elsewhere assume it is.
fn process_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    if cfg!(unix) {
        Command::new("kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success())
    } else {
        true
    }
}

#[cfg(test)]
mod clip_tests {
    #[test]
    fn clips_long_inputs_on_character_boundaries() {
        let long = "ä".repeat(super::MAX_INPUT_CHARS + 10);
        assert_eq!(super::clip(&long).chars().count(), super::MAX_INPUT_CHARS);
        assert_eq!(super::clip("short"), "short");
    }

    #[test]
    fn a_lock_from_a_finished_process_is_not_alive() {
        assert!(super::process_alive(std::process::id()));
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!super::process_alive(pid));
    }
}
