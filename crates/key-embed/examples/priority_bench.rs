// Query latency and bulk throughput of the shared embedding server under three policies:
// `normal` (everything at normal priority), `switch` (background while only bulk work is in
// flight, foreground while a query is: what Key does) and `low` (the server always in the
// background) and `second` (bulk on a second server at background priority). Needs the model downloaded and a llama-server (KEY_LLAMA_SERVER).
//
//   KEY_LLAMA_SERVER=/opt/homebrew/bin/llama-server KEY_MODEL_DIR=~/Library/Caches/Key/dev-models \
//     cargo run --release -p key-embed --example priority_bench
use key_embed::{Embedder, ModelDir, set_process_background};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

fn passage(i: usize) -> String {
    format!(
        "Passage {i}. Rivers supplied water, food and a road for trade, and settlements that grew along them could feed far more people than those inland. \
         Floods were a hazard, but they also renewed the soil every year, which made the floodplain the most fertile land for miles. {}",
        "Bridges and fords decided where roads crossed, so markets formed at the crossings and towns followed the markets. ".repeat(6)
    )
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

fn main() {
    let dir = ModelDir::from_env();
    let embedder = Arc::new(Embedder::load(&dir).expect("embedder"));
    embedder.embed_query("warm up").unwrap();
    let pid = embedder.server_process().expect("server pid");
    println!("server pid {pid}");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let policies: Vec<String> = if args.is_empty() { ["alone", "normal", "switch", "low"].map(String::from).to_vec() } else { args };
    for policy in policies.iter().map(String::as_str) {
        // `normal` and `low` fix the server's priority; `switch` lets the embedder move it.
        set_process_background(pid, policy == "low");
        if policy == "second" {
            // Started before measuring, as it is once bulk work is under way.
            embedder.embed_bulk(&[("warm", "up")]).unwrap();
        }
        let stop = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();
        if policy != "alone" {
            for w in 0..2 {
                let (embedder, stop, done) = (embedder.clone(), stop.clone(), done.clone());
                let policy = policy.to_string();
                let bulk = policy == "switch" || policy == "second";
                workers.push(std::thread::spawn(move || {
                    let texts: Vec<String> = (0..32).map(|i| passage(w * 1000 + i)).collect();
                    let items: Vec<(&str, &str)> = texts.iter().map(|t| ("A study of rivers", t.as_str())).collect();
                    while !stop.load(Ordering::SeqCst) {
                        let result = if bulk { embedder.embed_bulk(&items) } else { embedder.embed_documents(&items) };
                        if result.is_ok() {
                            done.fetch_add(items.len(), Ordering::SeqCst);
                        }
                        if policy == "low" {
                            // embed_documents leaves the priority alone; keep it low.
                            set_process_background(pid, true);
                        }
                    }
                }));
            }
            std::thread::sleep(Duration::from_millis(800));
        }
        let started = Instant::now();
        let before = done.load(Ordering::SeqCst);
        let mut times = Vec::new();
        for i in 0..25 {
            let t = Instant::now();
            embedder.embed_query(&format!("fertile floodplain soil {i}")).unwrap();
            times.push(t.elapsed().as_secs_f64() * 1000.0);
            if policy == "low" {
                set_process_background(pid, true);
            }
            std::thread::sleep(Duration::from_millis(120));
        }
        let span = started.elapsed().as_secs_f64();
        let throughput = (done.load(Ordering::SeqCst) - before) as f64 / span;
        stop.store(true, Ordering::SeqCst);
        for w in workers {
            let _ = w.join();
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "{policy:>6}: query median {:.0} ms, p90 {:.0} ms, max {:.0} ms; bulk {:.0} passages/s",
            percentile(&times, 0.5),
            percentile(&times, 0.9),
            times[times.len() - 1],
            throughput
        );
    }
    set_process_background(pid, false);
}
