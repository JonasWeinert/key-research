// Downloads against a local mock of Hugging Face's resolve endpoint: ranges and resume,
// checksum mismatches, one shared download for concurrent callers, offline, remove, import.
use key_models::{FileSpec, Models, Spec, sha256_file};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
};

#[derive(Default)]
struct Behaviour {
    /// Requests for a path that answer with corrupted bytes.
    corrupt: usize,
    /// Requests that send only half of the range and then close.
    drop_after_half: usize,
}

struct Mock {
    base: String,
    requests: Arc<Mutex<Vec<(String, String)>>>,
    behaviour: Arc<Mutex<Behaviour>>,
    hits: Arc<AtomicUsize>,
}

fn mock(files: HashMap<String, Vec<u8>>) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let behaviour = Arc::new(Mutex::new(Behaviour::default()));
    let hits = Arc::new(AtomicUsize::new(0));
    let (log, how, count) = (requests.clone(), behaviour.clone(), hits.clone());
    let files = Arc::new(files);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (files, log, how, count) = (files.clone(), log.clone(), how.clone(), count.clone());
            thread::spawn(move || serve(stream, &files, &log, &how, &count));
        }
    });
    Mock { base, requests, behaviour, hits }
}

fn serve(mut stream: TcpStream, files: &HashMap<String, Vec<u8>>, log: &Mutex<Vec<(String, String)>>, how: &Mutex<Behaviour>, count: &AtomicUsize) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).unwrap_or(0) == 0 {
            return;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
    let range = head
        .lines()
        .find_map(|l| l.strip_prefix("Range: bytes="))
        .unwrap_or("")
        .to_string();
    count.fetch_add(1, Ordering::SeqCst);
    log.lock().unwrap().push((path.clone(), range.clone()));
    let Some(bytes) = files.get(&path) else {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        return;
    };
    let (start, end) = range
        .split_once('-')
        .map(|(a, b)| (a.parse::<usize>().unwrap(), b.parse::<usize>().unwrap().min(bytes.len() - 1)))
        .unwrap_or((0, bytes.len() - 1));
    let mut body = bytes[start..=end].to_vec();
    let mut behaviour = how.lock().unwrap();
    let mut cut = None;
    if behaviour.corrupt > 0 {
        behaviour.corrupt -= 1;
        body[0] ^= 0xff;
    } else if behaviour.drop_after_half > 0 {
        behaviour.drop_after_half -= 1;
        cut = Some(body.len() / 2);
    }
    drop(behaviour);
    let header = format!(
        "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\n\r\n",
        body.len(),
        bytes.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&body[..cut.unwrap_or(body.len())]);
}

fn hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn spec(id: &str, files: &[(&str, &[u8])]) -> Spec {
    Spec {
        id: id.into(),
        name: "Test model".into(),
        title: "Test".into(),
        purpose: "Tests".into(),
        repo: format!("JonasWeinert/{id}"),
        revision: "abc123".into(),
        license: "Apache-2.0".into(),
        license_url: "https://www.apache.org/licenses/LICENSE-2.0".into(),
        upstream: "https://example.org".into(),
        files: files
            .iter()
            .map(|(path, bytes)| FileSpec { path: path.to_string(), size: bytes.len() as u64, sha256: hash(bytes), upstream: None, legacy: None })
            .collect(),
    }
}

fn payload(len: usize, seed: u8) -> Vec<u8> {
    (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
}

fn setup(id: &str, files: &[(&str, Vec<u8>)]) -> (tempfile::TempDir, Models, Mock) {
    let served = files.iter().map(|(p, b)| (format!("/JonasWeinert/{id}/resolve/abc123/{p}"), b.clone())).collect();
    let server = mock(served);
    let root = tempfile::tempdir().unwrap();
    let borrowed: Vec<(&str, &[u8])> = files.iter().map(|(p, b)| (*p, b.as_slice())).collect();
    let models = Models::with_manifest(root.path(), vec![spec(id, &borrowed)], Some(server.base.clone())).with_chunk(1000);
    (root, models, server)
}

#[test]
fn downloads_in_ranges_verifies_and_is_reused() {
    let model = payload(4500, 1);
    let tokenizer = payload(300, 2);
    let (_root, models, server) = setup("m1", &[("onnx/model.onnx", model.clone()), ("tokenizer.json", tokenizer)]);
    assert_eq!(models.status("m1").unwrap().state, "missing");
    let dir = models.ensure("m1").unwrap();
    assert_eq!(std::fs::read(dir.join("onnx/model.onnx")).unwrap(), model);
    let status = models.status("m1").unwrap();
    assert_eq!((status.state.as_str(), status.received, status.total), ("ready", 4800, 4800));
    // Which source it came from is kept and shown.
    assert!(status.source.as_deref().is_some_and(|s| s.starts_with("Key’s repository (")), "{:?}", status.source);
    assert!(!status.from_upstream);
    let ranges: Vec<String> = server.requests.lock().unwrap().iter().filter(|(p, _)| p.ends_with("model.onnx")).map(|(_, r)| r.clone()).collect();
    assert_eq!(ranges, ["0-999", "1000-1999", "2000-2999", "3000-3999", "4000-4499"]);
    // Ready models are not fetched again, by this or a fresh handle.
    let before = server.hits.load(Ordering::SeqCst);
    models.ensure("m1").unwrap();
    assert!(models.clone().ready("m1"));
    assert_eq!(server.hits.load(Ordering::SeqCst), before);
}

#[test]
fn a_dropped_connection_resumes_where_it_stopped() {
    let model = payload(3000, 3);
    let (_root, models, server) = setup("m2", &[("model.onnx", model.clone())]);
    server.behaviour.lock().unwrap().drop_after_half = 1;
    let dir = models.ensure("m2").unwrap();
    assert_eq!(std::fs::read(dir.join("model.onnx")).unwrap(), model);
    let ranges: Vec<String> = server.requests.lock().unwrap().iter().map(|(_, r)| r.clone()).collect();
    assert_eq!(ranges[..2], ["0-999".to_string(), "500-1499".to_string()]);
}

#[test]
fn a_partial_file_from_an_earlier_run_is_resumed() {
    let model = payload(2500, 4);
    let (root, models, server) = setup("m3", &[("model.onnx", model.clone())]);
    let dir = root.path().join("m3/abc123");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("model.onnx.part"), &model[..1200]).unwrap();
    assert_eq!(models.status("m3").unwrap().received, 1200);
    models.ensure("m3").unwrap();
    let ranges: Vec<String> = server.requests.lock().unwrap().iter().map(|(_, r)| r.clone()).collect();
    assert_eq!(ranges, ["1200-2199", "2200-2499"]);
}

#[test]
fn a_checksum_mismatch_is_rejected_and_fetched_again() {
    let model = payload(1500, 5);
    let (root, models, server) = setup("m4", &[("model.onnx", model.clone())]);
    server.behaviour.lock().unwrap().corrupt = 1;
    let dir = models.ensure("m4").unwrap();
    assert_eq!(sha256_file(&dir.join("model.onnx")).unwrap(), hash(&model));
    assert_eq!(server.hits.load(Ordering::SeqCst), 4);
    // Corrupt every time: the model is not installed and says why.
    let (_r, models, server) = setup("m5", &[("model.onnx", model)]);
    server.behaviour.lock().unwrap().corrupt = 100;
    let error = models.ensure("m5").unwrap_err();
    assert!(error.contains("checksum"), "{error}");
    let status = models.status("m5").unwrap();
    assert_eq!(status.state, "failed");
    assert!(!root.path().join("m5/abc123/model.onnx").exists());
}

#[test]
fn concurrent_callers_share_one_download() {
    let model = payload(5000, 6);
    let (_root, models, server) = setup("m6", &[("model.onnx", model)]);
    let handles: Vec<_> = (0..4).map(|_| {
        let models = models.clone();
        thread::spawn(move || models.ensure("m6").unwrap())
    }).collect();
    for handle in handles {
        handle.join().unwrap();
    }
    assert_eq!(server.hits.load(Ordering::SeqCst), 5);
}

#[test]
fn another_process_holding_the_lock_is_waited_for() {
    let model = payload(800, 7);
    let (root, models, server) = setup("m7", &[("model.onnx", model.clone())]);
    let lock = root.path().join("m7/.lock");
    std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
    std::fs::write(&lock, "1").unwrap();
    assert_eq!(models.status("m7").unwrap().state, "downloading");
    // "The other process" finishes: it installs the file and releases the lock.
    let other = models.clone();
    let finisher = thread::spawn(move || {
        thread::sleep(std::time::Duration::from_millis(600));
        let source = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(source.path(), &model).unwrap();
        std::fs::remove_file(&lock).unwrap();
        other.import(source.path()).unwrap();
    });
    let waiter = models.clone();
    let dir = thread::spawn(move || waiter.ensure("m7").unwrap()).join().unwrap();
    finisher.join().unwrap();
    assert!(dir.join("model.onnx").is_file());
    assert!(server.hits.load(Ordering::SeqCst) <= 1);
}

#[test]
fn offline_fails_cleanly_and_the_model_stays_missing() {
    let root = tempfile::tempdir().unwrap();
    // Nothing listens on this port.
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let model = payload(100, 8);
    let models = Models::with_manifest(root.path(), vec![spec("m8", &[("model.onnx", &model)])], Some(format!("http://127.0.0.1:{port}")));
    let error = models.ensure("m8").unwrap_err();
    assert!(error.contains("Couldn't reach"), "{error}");
    assert_eq!(models.status("m8").unwrap().state, "failed");
    assert!(models.path("m8").is_none());
}

#[test]
fn remove_frees_the_disk_and_the_model_downloads_again() {
    let model = payload(1200, 9);
    let (root, models, server) = setup("m9", &[("model.onnx", model)]);
    models.ensure("m9").unwrap();
    assert!(models.status("m9").unwrap().disk_bytes >= 1200);
    models.remove("m9").unwrap();
    assert!(!root.path().join("m9").exists());
    let status = models.status("m9").unwrap();
    assert_eq!((status.state.as_str(), status.disk_bytes), ("missing", 0));
    let before = server.hits.load(Ordering::SeqCst);
    models.ensure("m9").unwrap();
    assert!(server.hits.load(Ordering::SeqCst) > before);
}

#[test]
fn a_file_added_by_hand_is_installed_only_when_its_hash_matches() {
    let model = payload(700, 10);
    let root = tempfile::tempdir().unwrap();
    let models = Models::with_manifest(root.path(), vec![spec("m10", &[("model.onnx", &model)])], Some("http://127.0.0.1:9".into()));
    let wrong = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(wrong.path(), payload(700, 11)).unwrap();
    assert!(models.import(wrong.path()).is_err());
    let right = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(right.path(), &model).unwrap();
    assert_eq!(models.import(right.path()).unwrap(), ["m10"]);
    assert_eq!(models.status("m10").unwrap().state, "ready");
}

#[test]
fn an_older_copy_in_the_legacy_place_is_adopted() {
    let model = payload(900, 12);
    let root = tempfile::tempdir().unwrap();
    let mut spec = spec("m11", &[("model.gguf", &model)]);
    spec.files[0].legacy = Some("old/model.gguf".into());
    std::fs::create_dir_all(root.path().join("old")).unwrap();
    std::fs::write(root.path().join("old/model.gguf"), &model).unwrap();
    let models = Models::with_manifest(root.path(), vec![spec], Some("http://127.0.0.1:9".into()));
    assert_eq!(models.file("m11", "model.gguf").unwrap(), root.path().join("m11/abc123/model.gguf"));
    assert!(!root.path().join("old/model.gguf").exists());
}

#[test]
fn a_background_request_downloads_and_calls_back() {
    let model = payload(2100, 13);
    let (_root, models, _server) = setup("m12", &[("model.onnx", model)]);
    let (tx, rx) = std::sync::mpsc::channel();
    assert!(!models.request("m12", true, Some(Box::new(move || tx.send(()).unwrap()))));
    rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
    assert!(models.ready("m12"));
}

// The real Hub (HTTPS, redirects to its CDN, ranges, upstream fallback):
// `cargo test -p key-models -- --ignored`.
#[test]
#[ignore]
fn the_real_hub_serves_the_reader_model() {
    let root = tempfile::tempdir().unwrap();
    let spec = key_models::manifest().iter().find(|s| s.id == key_models::READER_EMBEDDINGS).unwrap().clone();
    let models = Models::with_manifest(root.path(), vec![spec], None);
    let dir = models.ensure(key_models::READER_EMBEDDINGS).unwrap();
    assert!(dir.join("onnx/model_quantized.onnx").is_file());
}
