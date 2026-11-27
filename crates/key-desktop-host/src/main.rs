mod backend;
/// Requests admitted at once per executor (the bridge keeps fewer in flight than this).
const ADMISSION: usize = 16;
mod events;
mod ipc;
mod layout_helper;
mod priority;
use priority::Class;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

/// One executor per kind of work, so a click never waits for a worker that bulk work holds:
/// interactive (its own threads, never used for anything else), foreground and background.
struct Lane {
    runtime: tokio::runtime::Runtime,
    admission: Arc<tokio::sync::Semaphore>,
}

fn lane(name: &str, workers: usize, blocking: usize, class: Class) -> Result<Lane, String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .thread_name(format!("key-{name}"))
        .worker_threads(workers)
        .max_blocking_threads(blocking)
        // Every thread of the lane (workers, block_in_place and spawn_blocking threads) carries
        // its class, so the store's locks and the OS scheduler know who is asking.
        .on_thread_start(move || key_store::priority::set_thread_class(class))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(Lane { runtime, admission: Arc::new(tokio::sync::Semaphore::new(ADMISSION)) })
}

/// Newer requests with the same `x-key-supersede` key (a search per keystroke) make older
/// ones that have not started answer "Superseded" at once, and cancel the one that is running
/// (its read queries stop, see key_store::cancel).
#[derive(Default)]
struct Supersede(Mutex<HashMap<String, (u64, key_store::cancel::Token)>>);
impl Supersede {
    fn issue(&self, key: &str) -> (u64, key_store::cancel::Token) {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > 256 {
            map.clear();
        }
        let token = key_store::cancel::Token::new();
        let next = match map.get(key) {
            Some((generation, older)) => {
                older.cancel();
                generation + 1
            }
            None => 1,
        };
        map.insert(key.to_string(), (next, token.clone()));
        (next, token)
    }
    fn current(&self, key: &str, generation: u64) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).get(key).is_none_or(|(g, _)| *g == generation)
    }
}

fn main() {
    if let Some(code) = layout_helper::maybe_run_layout_helper()
        .or_else(backend::maybe_run_interactive_helper)
        .or_else(backend::maybe_run_semantic_helper)
        .or_else(backend::maybe_run_preprocess_helper)
    {
        std::process::exit(code)
    }
    if let Err(error) = run() {
        eprintln!("Key backend: {error}");
        std::process::exit(1)
    }
}
fn run() -> Result<(), String> {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--library")) {
        return Err("Usage: key-desktop-host --library WORKSPACE_DATABASE_DIRECTORY".into());
    }
    let root = PathBuf::from(arguments.next().ok_or("Missing library directory")?);
    if !root.is_absolute() {
        return Err("Library directory must be absolute".into());
    }
    // Each request holds a thread while it runs (see below), so the pools are roomy.
    let interactive = lane("interactive", 2, 64, Class::Interactive)?;
    let foreground = lane("foreground", 4, 64, Class::Foreground)?;
    let background = lane("background", key_store::priority::background_threads(), 32, Class::Background)?;
    // The workers the host starts (indexing, lookups, feeds…) inherit this thread's class.
    key_store::priority::set_thread_class(Class::Background);
    let host = Arc::new(backend::Host::new(root)?);
    // The request loop reads at the user's pace.
    key_store::priority::set_thread_class(Class::Interactive);
    let out = Arc::new(Mutex::new(std::io::stdout()));
    events::start(out.clone());
    let supersede = Arc::new(Supersede::default());
    let mut input = std::io::stdin().lock();
    while let Some((envelope, binary)) = ipc::read_request(&mut input)? {
        if envelope.command == "host_priority_table" {
            ipc::write_response(&mut *out.lock().unwrap(), envelope.id, ipc::json_output(priority::table()))?;
            continue;
        }
        if envelope.command == "host_can_suspend" {
            let idle = [&interactive, &foreground, &background].iter().all(|l| l.admission.available_permits() == ADMISSION) && host.can_suspend();
            ipc::write_response(
                &mut *out.lock().unwrap(),
                envelope.id,
                ipc::json_output(idle),
            )?;
            continue;
        }
        if let Some(result) = host.immediate(&envelope.command, &envelope.args) {
            ipc::write_response(&mut *out.lock().unwrap(), envelope.id, result)?;
            continue;
        }
        let class = priority::resolve(&envelope.command, envelope.headers.get("x-key-class").map(String::as_str));
        let lane = match class {
            Class::Interactive => &interactive,
            Class::Foreground | Class::Visible => &foreground,
            Class::Background | Class::Idle => &background,
        };
        let generation = envelope.headers.get("x-key-supersede").map(|key| (key.clone(), supersede.issue(key)));
        let permit = lane.admission.clone().try_acquire_owned();
        let permit = match permit {
            Ok(p) => p,
            Err(_) => {
                ipc::write_response(
                    &mut *out.lock().unwrap(),
                    envelope.id,
                    Err("Backend busy; retry request".into()),
                )?;
                continue;
            }
        };
        let host = host.clone();
        let out = out.clone();
        let supersede = supersede.clone();
        lane.runtime.spawn(async move {
            let _permit = permit;
            // Counted while it runs: background loops pause for user actions.
            let _active = key_store::priority::begin(class);
            if let Some((key, (generation, _))) = &generation {
                if !supersede.current(key, *generation) {
                    let _ = ipc::write_response(&mut *out.lock().unwrap(), envelope.id, Err("Superseded by a newer request".into()));
                    return;
                }
            }
            let mut headers = http::HeaderMap::new();
            for (name, value) in envelope.headers {
                let parsed = name
                    .parse::<http::header::HeaderName>()
                    .map_err(|_| ())
                    .and_then(|name| {
                        value
                            .parse::<http::HeaderValue>()
                            .map(|value| (name, value))
                            .map_err(|_| ())
                    });
                // Header parsing failures are returned without invoking a backend command.
                match parsed {
                    Ok((name, value)) => {
                        headers.insert(name, value);
                    }
                    Err(_) => {
                        let _ = ipc::write_response(
                            &mut *out.lock().unwrap(),
                            envelope.id,
                            Err("Invalid IPC header".into()),
                        );
                        return;
                    }
                }
            }
            // The class follows the request, also where its lane's thread says otherwise
            // (a visible-class read on a foreground thread).
            let started = std::time::Instant::now();
            let command = envelope.command.clone();
            let token = generation.as_ref().map(|(_, (_, token))| token.clone()).unwrap_or_default();
            let result = key_store::priority::with_class(class, || {
                tokio::task::block_in_place(|| {
                    key_store::cancel::run(&token, || tokio::runtime::Handle::current().block_on(host.dispatch(&envelope.command, &envelope.args, &binary, &headers)))
                })
            });
            // A query a newer one replaced stopped part way ("interrupted"): say why.
            let result = if token.is_cancelled() && result.is_err() { Err(key_store::cancel::SUPERSEDED.into()) } else { result };
            if result.is_ok() && priority::changes_sources(&command) {
                events::library_changed();
            }
            // KEY_LOCK_TRACE_MS: user actions slower than this are reported (stderr).
            if class == Class::Interactive && std::env::var("KEY_LOCK_TRACE_MS").ok().and_then(|v| v.parse::<u128>().ok()).is_some_and(|ms| started.elapsed().as_millis() > ms) {
                eprintln!("key slow: {command} took {:?}", started.elapsed());
            }
            if let Err(error) = ipc::write_response(&mut *out.lock().unwrap(), envelope.id, result)
            {
                eprintln!("Key IPC output: {error}");
            }
        });
    }
    // Electron owns this process. EOF must also end helper ownership promptly.
    key_embed::shutdown();
    std::process::exit(0)
}
