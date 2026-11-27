// Layout analysis for indexing, in a helper process: PDFium and the layout model run
// outside the host so a crash or a runaway document cannot take the library down.
// The helper writes the document's blocks (reading order, kind, geometry, sentences)
// and its Markdown as JSON; the indexer turns them into passages.
use key_index::{Layout, LayoutBlock, LayoutSentence};
use opendataloader_pdf::{
    ConvertOptions,
    model::{BBox, Block, Page},
};
use std::{
    env,
    ffi::OsStr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const FLAG: &str = "--key-layout-helper";
/// A document that takes longer than this falls back to plain PDF text.
const TIMEOUT: Duration = Duration::from_secs(600);

/// The layout model's file in the shared models folder (key-models).
pub const MODEL_FILE: &str = "model_fp16.onnx";

/// The layout model: `KEY_LAYOUT_MODEL` (a developer's own copy), else the downloaded one
/// in the shared models folder, else a copy a developer put next to the extraction crate.
/// None until it has been downloaded: analysis then runs without it.
pub fn model_path() -> Option<PathBuf> {
    env::var_os("KEY_LAYOUT_MODEL")
        .map(PathBuf::from)
        .into_iter()
        .chain(key_models::Models::from_env().file(key_models::LAYOUT, MODEL_FILE))
        .chain([opendataloader_pdf::bundled_onnx_model_path()])
        .find(|path| path.is_file())
}

/// The helper writes "phase done total" here per page; the host polls it for progress.
const PROGRESS_ENV: &str = "KEY_LAYOUT_PROGRESS";
/// The priority class the helper runs at (key-store's priority.rs).
const CLASS_ENV: &str = "KEY_LAYOUT_CLASS";
static PROGRESS_FILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn write_progress(phase: &str, done: usize, total: usize) {
    if let Some(file) = PROGRESS_FILE.get() {
        let _ = std::fs::write(file, format!("{phase} {done} {total}"));
    }
}

/// Analyses one PDF in a helper process.
pub fn analyze(path: &Path, model: bool) -> Result<Layout, String> {
    analyze_with_progress(path, model, &|_, _, _| {})
}

/// `analyze`, calling `progress(phase, done, total)` as the helper reports pages.
pub fn analyze_with_progress(path: &Path, model: bool, progress: &dyn Fn(&str, usize, usize)) -> Result<Layout, String> {
    let output = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let progress_file = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut command = Command::new(env::current_exe().map_err(|e| e.to_string())?);
    command.arg(FLAG).arg(path).arg(output.path()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    if model {
        if let Some(model) = model_path() {
            command.arg("--model").arg(model);
        }
    }
    // Half the cores at most for the document the user opened; bulk indexing fewer still
    // (one on small machines), and at a lower QoS, so the user's own work keeps the CPU.
    let class = key_store::priority::current();
    let threads = if class <= key_store::priority::Class::Foreground {
        std::thread::available_parallelism().map(|n| (n.get() / 2).clamp(1, 4)).unwrap_or(2)
    } else {
        key_store::priority::background_threads()
    };
    command.env("KEY_LAYOUT_THREADS", threads.to_string());
    command.env(CLASS_ENV, class.name());
    command.env(PROGRESS_ENV, progress_file.path());
    let mut child = command.spawn().map_err(|e| format!("layout helper: {e}"))?;
    let started = Instant::now();
    let mut last = String::new();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if let Ok(line) = std::fs::read_to_string(progress_file.path()) {
            if line != last {
                let mut parts = line.split_whitespace();
                if let (Some(phase), Some(Ok(done)), Some(Ok(total))) =
                    (parts.next(), parts.next().map(str::parse::<usize>), parts.next().map(str::parse::<usize>))
                {
                    progress(phase, done, total);
                }
                last = line;
            }
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("layout analysis took too long".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    if !status.success() {
        let mut message = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = std::io::Read::read_to_string(&mut stderr, &mut message);
        }
        return Err(format!("layout helper failed: {}", message.trim().lines().last().unwrap_or("no output")));
    }
    let bytes = std::fs::read(output.path()).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub fn maybe_run_layout_helper() -> Option<i32> {
    let mut arguments = env::args_os().skip(1);
    if arguments.next().as_deref() != Some(OsStr::new(FLAG)) {
        return None;
    }
    let input = arguments.next().map(PathBuf::from);
    let output = arguments.next().map(PathBuf::from);
    let model = match (arguments.next(), arguments.next()) {
        (Some(flag), Some(path)) if flag == "--model" => Some(PathBuf::from(path)),
        _ => None,
    };
    let (Some(input), Some(output)) = (input, output) else {
        eprintln!("usage: {FLAG} INPUT OUTPUT [--model PATH]");
        return Some(2);
    };
    // The helper runs at the class of the indexing that asked. A thread's QoS is not passed
    // on to the threads it starts (ps -M showed the worker and the model's threads at the
    // default priority), so the worker sets it again, and background work also lowers the
    // whole process (nice 10), which reaches the layout model's own threads.
    let class = env::var(CLASS_ENV).ok().as_deref().and_then(key_store::priority::Class::parse);
    if let Some(class) = class {
        key_store::priority::set_thread_class(class);
        if class >= key_store::priority::Class::Background {
            key_embed::set_process_nice(std::process::id(), 10);
        }
    }
    // PDFium gets a thread with a generous stack; deep structure trees recurse.
    let worker = std::thread::Builder::new().stack_size(64 << 20).spawn(move || {
        if let Some(class) = class {
            key_store::priority::set_thread_class(class);
        }
        run(&input, &output, model)
    });
    match worker.map_err(|e| e.to_string()).and_then(|w| w.join().map_err(|_| "layout helper panicked".to_string())) {
        Ok(Ok(())) => Some(0),
        Ok(Err(error)) | Err(error) => {
            eprintln!("{error}");
            Some(1)
        }
    }
}

fn run(input: &Path, output: &Path, model: Option<PathBuf>) -> Result<(), String> {
    if let Some(file) = env::var_os(PROGRESS_ENV) {
        let _ = PROGRESS_FILE.set(PathBuf::from(file));
        opendataloader_pdf::set_progress_hook(write_progress);
    }
    let mut options = ConvertOptions::default();
    let engine = if model.is_some() { "layout-onnx" } else { "layout" };
    options.onnx_model = model;
    // Rotated pages are analysed upright, then their geometry is turned back.
    let normalized = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let rotations = opendataloader_pdf::extract::normalize_page_rotations(input, normalized.path()).map_err(|e| format!("{e:#}"))?;
    let path = if rotations.iter().any(|r| *r != 0) { normalized.path() } else { input };
    let document = opendataloader_pdf::convert(path, &options).map_err(|e| format!("{e:#}"))?;
    let markdown = opendataloader_pdf::to_markdown(&document);
    let mut blocks = Vec::new();
    for page in &document.pages {
        let rotation = rotations.get(page.number.saturating_sub(1)).copied().unwrap_or(0);
        blocks.extend(page_blocks(page, rotation));
    }
    let layout = Layout { engine: engine.into(), page_count: document.number_of_pages, markdown, blocks };
    std::fs::write(output, serde_json::to_vec(&layout).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn page_blocks(page: &Page, rotation: u16) -> Vec<LayoutBlock> {
    let rect = |b: BBox| rotate(quantize(b, page.width, page.height), rotation);
    page.blocks
        .iter()
        .enumerate()
        .map(|(index, block)| LayoutBlock {
            page: page.number.saturating_sub(1) as i64,
            kind: kind(block).into(),
            text: block.text(),
            bounds: rect(block.bbox()),
            sentences: page
                .sentences
                .iter()
                .filter(|s| s.block_index == index)
                .map(|s| LayoutSentence { text: s.text.clone(), rects: s.rects.iter().map(|r| rect(*r)).collect() })
                .collect(),
        })
        .collect()
}

fn kind(block: &Block) -> &'static str {
    match block {
        Block::Paragraph { .. } => "paragraph",
        Block::Heading { .. } => "heading",
        Block::Table { .. } => "table",
        Block::List { .. } => "list",
        Block::Equation { .. } => "equation",
        Block::Algorithm { .. } => "algorithm",
        Block::Header { .. } => "header",
        Block::Footer { .. } => "footer",
        Block::PageNumber { .. } => "page_number",
        Block::ReferenceList { .. } => "reference_list",
        Block::Footnote { .. } => "footnote",
        Block::EndnoteList { .. } => "endnote_list",
    }
}

/// [x, y, width, height] on a 0..65535 page scale.
fn quantize(b: BBox, width: f32, height: f32) -> [u16; 4] {
    let q = |v: f32| (v.clamp(0.0, 1.0) * u16::MAX as f32).round() as u16;
    let (w, h) = (width.max(1.0), height.max(1.0));
    let (x, y) = (q(b.x / w), q(b.y / h));
    [x, y, q(b.right() / w).saturating_sub(x), q(b.bottom() / h).saturating_sub(y)]
}

fn rotate([x, y, width, height]: [u16; 4], rotation: u16) -> [u16; 4] {
    let right = x.saturating_add(width);
    let bottom = y.saturating_add(height);
    match rotation {
        90 => [u16::MAX - bottom, x, height, width],
        180 => [u16::MAX - right, u16::MAX - bottom, width, height],
        270 => [y, u16::MAX - right, height, width],
        _ => [x, y, width, height],
    }
}
