// Reading mode's figures and tables for PDFs whose stored structure was made without the layout
// model (older analyses, or the model was off): the model's regions for them, found in the
// background when the PDF is read (the host's reflow_regions.rs runs it page by page), put into
// the reflowed text as crops of the page (`apply_regions`), and kept for the 20 PDFs read last
// (`RegionCache`). A PDF whose structure the model made has its regions already and never uses
// the cache.
use crate::Layout;
use crate::reflow::{Caption, Crop, Document, Item, OutlineEntry, Run, caption_kind};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A figure or table the model found: [x, y, width, height] on the 0..65535 page scale.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub page: i64,
    /// figure | table
    pub kind: String,
    pub rect: [u16; 4],
}

/// The regions found so far for one PDF, and which pages were analysed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRegions {
    pub file_hash: String,
    pub page_count: usize,
    pub analysed: Vec<i64>,
    pub regions: Vec<Region>,
}

impl PageRegions {
    pub fn complete(&self) -> bool {
        self.page_count > 0 && self.analysed.len() >= self.page_count
    }
    /// Adds a page's regions (once).
    pub fn add_page(&mut self, page: i64, regions: impl IntoIterator<Item = Region>) {
        if self.analysed.contains(&page) {
            return;
        }
        self.analysed.push(page);
        self.analysed.sort_unstable();
        self.regions.extend(regions);
        self.regions.sort_by_key(|r| (r.page, r.rect[1], r.rect[0]));
    }
}

/// Whether reading mode needs the model's regions for a stored structure: one made without the
/// model has no reliable figure and table regions.
pub fn needs_regions(layout: &Layout) -> bool {
    layout.engine != "layout-onnx"
}

/// The regions the PDF's reading mode uses, from the cache; none (and the cache untouched) when
/// its stored structure has them already.
pub fn cached_regions(layout: &Layout, cache: &RegionCache, hash: &str) -> Option<PageRegions> {
    if !needs_regions(layout) {
        return None;
    }
    cache.get(hash)
}

/// The most recently read PDFs' regions, one small file each, in a folder of the workspace.
pub struct RegionCache {
    dir: PathBuf,
    capacity: usize,
}

#[derive(Default, Serialize, Deserialize)]
struct Recency {
    next: u64,
    /// (hash, last use), any order.
    entries: Vec<(String, u64)>,
}

pub const CACHE_SIZE: usize = 20;

impl RegionCache {
    pub fn new(dir: impl AsRef<Path>, capacity: usize) -> Self {
        RegionCache { dir: dir.as_ref().to_path_buf(), capacity: capacity.max(1) }
    }
    fn name(hash: &str) -> String {
        hash.chars().filter(|c| c.is_ascii_alphanumeric()).take(80).collect()
    }
    fn file(&self, hash: &str) -> PathBuf {
        self.dir.join(format!("{}.json", Self::name(hash)))
    }
    fn recency(&self) -> Recency {
        std::fs::read(self.dir.join("recency.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    fn save(&self, recency: &Recency) {
        let _ = std::fs::create_dir_all(&self.dir);
        let path = self.dir.join("recency.json");
        let temporary = self.dir.join("recency.json.tmp");
        if serde_json::to_vec(recency).ok().is_some_and(|b| std::fs::write(&temporary, b).is_ok()) {
            let _ = std::fs::rename(temporary, path);
        }
    }
    fn touch(&self, hash: &str) -> Recency {
        let mut recency = self.recency();
        recency.next += 1;
        let now = recency.next;
        let name = Self::name(hash);
        match recency.entries.iter_mut().find(|(h, _)| *h == name) {
            Some(entry) => entry.1 = now,
            None => recency.entries.push((name, now)),
        }
        recency
    }
    /// A PDF's regions, now the most recently used.
    pub fn get(&self, hash: &str) -> Option<PageRegions> {
        let found: PageRegions = serde_json::from_slice(&std::fs::read(self.file(hash)).ok()?).ok()?;
        self.save(&self.touch(hash));
        Some(found)
    }
    /// Whether a PDF is cached (its recency unchanged).
    pub fn contains(&self, hash: &str) -> bool {
        self.file(hash).is_file()
    }
    /// Keeps a PDF's regions; the least recently used beyond the capacity go.
    pub fn put(&self, hash: &str, regions: &PageRegions) {
        let _ = std::fs::create_dir_all(&self.dir);
        let Ok(bytes) = serde_json::to_vec(regions) else { return };
        let temporary = self.dir.join(format!("{}.tmp", Self::name(hash)));
        if std::fs::write(&temporary, bytes).is_err() || std::fs::rename(&temporary, self.file(hash)).is_err() {
            return;
        }
        let mut recency = self.touch(hash);
        recency.entries.sort_by_key(|(_, used)| std::cmp::Reverse(*used));
        for (old, _) in recency.entries.drain(self.capacity.min(recency.entries.len())..) {
            let _ = std::fs::remove_file(self.dir.join(format!("{old}.json")));
        }
        self.save(&recency);
    }
    pub fn len(&self) -> usize {
        self.recency().entries.iter().filter(|(h, _)| self.dir.join(format!("{h}.json")).is_file()).count()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

const FULL: f32 = u16::MAX as f32;

fn area(r: &[u16; 4]) -> f32 {
    (r[2] as f32 / FULL) * (r[3] as f32 / FULL)
}
fn shared(a: &[u16; 4], b: &[u16; 4]) -> f32 {
    let w = ((a[0] as f32 + a[2] as f32).min(b[0] as f32 + b[2] as f32) - (a[0] as f32).max(b[0] as f32)).max(0.0) / FULL;
    let h = ((a[1] as f32 + a[3] as f32).min(b[1] as f32 + b[3] as f32) - (a[1] as f32).max(b[1] as f32)).max(0.0) / FULL;
    w * h
}
/// How much of the smaller box the two share.
fn cover(a: &[u16; 4], b: &[u16; 4]) -> f32 {
    shared(a, b) / area(a).min(area(b)).max(1e-6)
}
fn overlaps_x(a: &[u16; 4], b: &[u16; 4]) -> bool {
    (a[0] as u32).max(b[0] as u32) < (a[0] as u32 + a[2] as u32).min(b[0] as u32 + b[2] as u32)
}

/// Where an item starts: page, and its first box.
fn position(item: &Item) -> (i64, [u16; 4]) {
    if let Some(run) = item.runs.first() {
        return (run.page, run.rects.first().copied().unwrap_or([0, 0, u16::MAX, 0]));
    }
    if let Some(crop) = &item.crop {
        return (crop.page, crop.rect);
    }
    if let Some(run) = item.caption.as_ref().and_then(|c| c.runs.first()) {
        return (run.page, run.rects.first().copied().unwrap_or([0; 4]));
    }
    (item.page, [0, 0, u16::MAX, 0])
}

/// Text the region holds: every box of it inside.
fn inside(item: &Item, region: &Region) -> bool {
    item.crop.is_none()
        && !item.runs.is_empty()
        && matches!(item.kind.as_str(), "paragraph" | "list" | "equation" | "footnote")
        && item.runs.iter().all(|r| r.page == region.page && !r.rects.is_empty() && r.rects.iter().all(|b| shared(b, &region.rect) >= 0.7 * area(b).max(1e-6)))
}

fn as_caption(item: Item) -> Caption {
    Caption { text: item.text, runs: item.runs, ..Default::default() }
}

/// The model's figures and tables put into reading mode's text: an item already showing the
/// region takes its exact box; otherwise a crop of the region goes where it is in reading order,
/// the text found inside it leaves the flow (a table keeps it, for "Show as text"), and the
/// "Figure 2." or "Table 1" paragraph beside it becomes its caption. Text items keep their order.
pub fn apply_regions(doc: &mut Document, regions: &[Region]) {
    let mut items = std::mem::take(&mut doc.items);
    let mut sorted: Vec<&Region> = regions.iter().filter(|r| matches!(r.kind.as_str(), "figure" | "table") && r.rect[2] > 0 && r.rect[3] > 0).collect();
    sorted.sort_by_key(|r| (r.page, r.rect[1], r.rect[0]));
    for region in sorted {
        // The text found inside the region leaves the flow.
        let mut held: Vec<Item> = Vec::new();
        let mut kept: Vec<Item> = Vec::with_capacity(items.len());
        for item in items {
            if inside(&item, region) {
                held.push(item);
            } else {
                kept.push(item);
            }
        }
        items = kept;
        // A table's cells as the analyser read them, shown only on request ("Show as text").
        let cells = |item: &mut Item, held: Vec<Item>| {
            for part in held {
                let shift = item.text.encode_utf16().count() + usize::from(!item.text.is_empty());
                if !item.text.is_empty() {
                    item.text.push('\n');
                }
                item.text.push_str(&part.text);
                item.runs.extend(part.runs.into_iter().map(|r| Run { start: r.start + shift, end: r.end + shift, ..r }));
            }
        };
        // Crops the analyser made of parts of the region (a table in two pieces): one is kept
        // and takes the whole region, the others go (their captions to the one kept).
        let parts: Vec<usize> = items.iter().enumerate().filter(|(_, i)| matches!(i.kind.as_str(), "figure" | "table") && i.crop.as_ref().is_some_and(|c| c.page == region.page && cover(&c.rect, &region.rect) >= 0.5)).map(|(k, _)| k).collect();
        if parts.len() > 1 {
            let first = parts[0];
            for &k in parts[1..].iter().rev() {
                let extra = items.remove(k);
                let keep = &mut items[first];
                if keep.caption.is_none() {
                    keep.caption = extra.caption;
                }
                if keep.kind == "table" && extra.kind == "table" && !extra.text.is_empty() {
                    let shift = keep.text.encode_utf16().count() + usize::from(!keep.text.is_empty());
                    if !keep.text.is_empty() {
                        keep.text.push('\n');
                    }
                    keep.text.push_str(&extra.text);
                    keep.runs.extend(extra.runs.into_iter().map(|r| Run { start: r.start + shift, end: r.end + shift, ..r }));
                } else if keep.text.is_empty() {
                    keep.text = extra.text;
                    keep.runs = extra.runs;
                }
            }
        }
        if let Some(item) = items.iter_mut().find(|i| matches!(i.kind.as_str(), "figure" | "table") && i.crop.as_ref().is_some_and(|c| c.page == region.page && cover(&c.rect, &region.rect) >= 0.5)) {
            item.crop = Some(Crop { page: region.page, rect: region.rect });
            if item.kind != region.kind {
                // A table the analyser thought a picture (or the reverse): the caption moves along.
                if region.kind == "table" && item.caption.is_none() && !item.text.is_empty() {
                    item.caption = Some(Caption { text: std::mem::take(&mut item.text), ..Default::default() });
                }
                item.kind = region.kind.clone();
            }
            if item.kind == "table" && item.text.is_empty() {
                cells(item, held);
            }
            continue;
        }
        let mut item = Item { kind: region.kind.clone(), page: region.page, crop: Some(Crop { page: region.page, rect: region.rect }), ..Default::default() };
        if region.kind == "table" {
            cells(&mut item, held);
        }
        let at = items
            .iter()
            .position(|i| {
                let (page, rect) = position(i);
                page > region.page || (page == region.page && rect[1] >= region.rect[1] && overlaps_x(&rect, &region.rect))
            })
            .unwrap_or(items.len());
        items.insert(at, item);
        // Its caption: a figure's usually below it, a table's above (or below).
        let is_caption = |i: &Item| i.kind == "paragraph" && i.text.chars().count() < 700 && caption_kind(&i.text) == Some(if region.kind == "table" { "table" } else { "figure" }) && position(i).0 == region.page;
        let below = items.get(at + 1).is_some_and(is_caption);
        let above = region.kind == "table" && at > 0 && items.get(at - 1).is_some_and(is_caption);
        let caption = if below {
            Some(as_caption(items.remove(at + 1)))
        } else if above {
            let c = as_caption(items.remove(at - 1));
            Some(c)
        } else {
            None
        };
        if let Some(caption) = caption {
            let index = if above { at - 1 } else { at };
            let item = &mut items[index];
            if item.kind == "figure" {
                item.text = caption.text.clone();
            }
            item.caption = Some(caption);
        }
    }
    // A caption that is only its label ("Fig 1"): the paragraph right after the crop is the rest.
    let mut k = 0;
    while k + 1 < items.len() {
        let bare = items[k].crop.is_some() && matches!(items[k].kind.as_str(), "figure" | "table") && items[k].caption.as_ref().is_some_and(|c| bare_label(&c.text));
        let next = &items[k + 1];
        if bare && next.kind == "paragraph" && next.text.chars().count() < 700 && position(next).0 == items[k].crop.as_ref().map_or(-1, |c| c.page) {
            let next = items.remove(k + 1);
            let item = &mut items[k];
            let caption = item.caption.as_mut().expect("bare caption");
            let shift = caption.text.encode_utf16().count() + 1;
            caption.text = format!("{} {}", caption.text, next.text);
            caption.runs.extend(next.runs.into_iter().map(|r| Run { start: r.start + shift, end: r.end + shift, ..r }));
            if item.kind == "figure" {
                item.text = caption.text.clone();
            }
        }
        k += 1;
    }
    for (id, item) in items.iter_mut().enumerate() {
        item.id = id;
    }
    doc.outline = items.iter().filter(|i| i.kind == "heading").map(|i| OutlineEntry { item: i.id, level: i.level.unwrap_or(2), text: i.text.clone(), page: i.page }).collect();
    doc.items = items;
}

/// "Fig 1", "Figure 2.", "Table 3:" and nothing more.
fn bare_label(text: &str) -> bool {
    let t = text.trim();
    t.chars().count() <= 12 && caption_kind(t).is_some() && t.split_whitespace().nth(1).is_some_and(|n| n.trim_end_matches(['.', ':']).chars().all(|c| c.is_ascii_alphanumeric()))
}

/// A model detection on a page (in points, y down) as a region, when it is a figure or table.
pub fn region_of(page: i64, kind: &str, [x, y, w, h]: [f32; 4], page_width: f32, page_height: f32) -> Option<Region> {
    let kind = match kind {
        "Figure" => "figure",
        "Table" => "table",
        _ => return None,
    };
    let q = |v: f32, size: f32| ((v / size.max(1.0)).clamp(0.0, 1.0) * FULL).round() as u16;
    let rect = [q(x, page_width), q(y, page_height), q(w, page_width), q(h, page_height)];
    (rect[2] > 300 && rect[3] > 300).then(|| Region { page, kind: kind.into(), rect })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reflow::assemble;
    use crate::{LayoutBlock, LayoutPage, LayoutSentence};

    fn q(x: f32, y: f32, w: f32, h: f32) -> [u16; 4] {
        [(x * FULL) as u16, (y * FULL) as u16, (w * FULL) as u16, (h * FULL) as u16]
    }
    fn block(page: i64, kind: &str, rect: [u16; 4], text: &str) -> LayoutBlock {
        LayoutBlock { page, kind: kind.into(), text: text.into(), bounds: rect, sentences: vec![LayoutSentence { text: text.into(), rects: vec![rect] }], level: (kind == "heading").then_some(1), ..Default::default() }
    }
    fn regions(page_count: usize, list: Vec<Region>) -> PageRegions {
        PageRegions { file_hash: "f".into(), page_count, analysed: (0..page_count as i64).collect(), regions: list }
    }

    /// A page analysed without the model: its table read as paragraphs, its chart's labels as text.
    fn without_model() -> Layout {
        let blocks = vec![
            block(0, "heading", q(0.1, 0.05, 0.8, 0.04), "Prices and wages"),
            block(0, "paragraph", q(0.1, 0.12, 0.8, 0.2), "Wages rose with prices over the decade, as the table shows."),
            block(0, "paragraph", q(0.1, 0.35, 0.8, 0.03), "Table 1. Prices by year."),
            block(0, "paragraph", q(0.12, 0.40, 0.7, 0.03), "Year Price"),
            block(0, "paragraph", q(0.12, 0.44, 0.7, 0.03), "2020 10"),
            block(0, "paragraph", q(0.1, 0.52, 0.8, 0.08), "Both grew steadily, and the figure below shows it."),
            block(0, "paragraph", q(0.3, 0.70, 0.1, 0.02), "0.5"),
            block(0, "paragraph", q(0.1, 0.86, 0.8, 0.03), "Figure 1. Wages over time."),
            block(1, "paragraph", q(0.1, 0.1, 0.8, 0.2), "A second page of discussion."),
        ];
        Layout { engine: "layout".into(), page_count: 2, markdown: String::new(), blocks, pages: vec![LayoutPage { page: 0, width: 600.0, height: 800.0, images: vec![] }] }
    }

    #[test]
    fn regions_become_crops_in_reading_order_with_their_captions() {
        let layout = without_model();
        let mut doc = assemble(&layout);
        let before: Vec<String> = doc.items.iter().filter(|i| i.kind == "paragraph").map(|i| i.text.clone()).collect();
        assert!(before.iter().any(|t| t == "Year Price 2020 10"), "the table read as text: {before:?}");
        let table = Region { page: 0, kind: "table".into(), rect: q(0.1, 0.39, 0.8, 0.1) };
        let figure = Region { page: 0, kind: "figure".into(), rect: q(0.1, 0.62, 0.8, 0.22) };
        apply_regions(&mut doc, &[figure, table.clone()]);
        let kinds: Vec<&str> = doc.items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, ["heading", "paragraph", "table", "paragraph", "figure", "paragraph"], "{:#?}", doc.items);
        let t = &doc.items[2];
        assert_eq!(t.crop.as_ref().unwrap().rect, table.rect);
        assert_eq!(t.caption.as_ref().unwrap().text, "Table 1. Prices by year.");
        assert_eq!(t.text, "Year Price 2020 10", "the table's text, for Show as text");
        assert!(!t.runs.is_empty());
        let f = &doc.items[4];
        assert_eq!(f.text, "Figure 1. Wages over time.");
        assert!(!doc.items.iter().any(|i| i.text == "0.5"), "the chart's labels leave the text");
        assert_eq!(doc.items.last().unwrap().text, "A second page of discussion.");
        assert!(doc.items.iter().enumerate().all(|(k, i)| i.id == k));
        assert_eq!(doc.outline[0].item, 0);
        // Again with the same regions: nothing moves.
        let again = doc.items.clone();
        apply_regions(&mut doc, &[Region { page: 0, kind: "table".into(), rect: q(0.1, 0.39, 0.8, 0.1) }]);
        assert_eq!(doc.items, again);
    }

    #[test]
    fn a_guessed_figure_takes_the_models_box() {
        let blocks = vec![
            block(0, "paragraph", q(0.1, 0.1, 0.8, 0.2), "Text above the figure."),
            block(0, "paragraph", q(0.1, 0.62, 0.8, 0.03), "Figure 2. A chart."),
            block(0, "paragraph", q(0.1, 0.7, 0.8, 0.2), "Text below."),
        ];
        let layout = Layout { engine: "layout".into(), page_count: 1, markdown: String::new(), blocks, pages: vec![] };
        let mut doc = assemble(&layout);
        let guessed = doc.items.iter().find(|i| i.kind == "figure").expect("a guessed figure").crop.clone().unwrap();
        let model = q(0.15, 0.33, 0.7, 0.27);
        apply_regions(&mut doc, &[Region { page: 0, kind: "figure".into(), rect: model }]);
        let figures: Vec<&Item> = doc.items.iter().filter(|i| i.kind == "figure").collect();
        assert_eq!(figures.len(), 1);
        assert_ne!(guessed.rect, model);
        assert_eq!(figures[0].crop.as_ref().unwrap().rect, model);
        assert_eq!(figures[0].text, "Figure 2. A chart.");
    }

    #[test]
    fn a_table_in_pieces_becomes_one_and_a_bare_label_takes_its_text() {
        let blocks = vec![
            block(0, "paragraph", q(0.1, 0.05, 0.8, 0.1), "Text before the table."),
            block(0, "table", q(0.1, 0.2, 0.8, 0.1), "Age 64 73"),
            block(0, "table", q(0.5, 0.31, 0.4, 0.1), "HFrEF 70 75"),
            block(0, "paragraph", q(0.1, 0.45, 0.8, 0.05), "Text after the table."),
            block(1, "paragraph", q(0.1, 0.62, 0.2, 0.02), "Fig 1"),
            block(1, "paragraph", q(0.1, 0.65, 0.8, 0.04), "Comparison of the two systems."),
            block(1, "paragraph", q(0.1, 0.75, 0.8, 0.2), "And the discussion goes on."),
        ];
        let layout = Layout { engine: "layout".into(), page_count: 2, markdown: String::new(), blocks, pages: vec![] };
        let mut doc = assemble(&layout);
        assert_eq!(doc.items.iter().filter(|i| i.kind == "table").count(), 2);
        let table = q(0.1, 0.19, 0.8, 0.23);
        apply_regions(&mut doc, &[Region { page: 0, kind: "table".into(), rect: table }, Region { page: 1, kind: "figure".into(), rect: q(0.1, 0.2, 0.8, 0.4) }]);
        let tables: Vec<&Item> = doc.items.iter().filter(|i| i.kind == "table").collect();
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].crop.as_ref().unwrap().rect, table);
        assert_eq!(tables[0].text, "Age 64 73\nHFrEF 70 75");
        let figure = doc.items.iter().find(|i| i.kind == "figure").unwrap();
        assert_eq!(figure.text, "Fig 1 Comparison of the two systems.");
        assert_eq!(doc.items.last().unwrap().text, "And the discussion goes on.");
    }

    #[test]
    fn the_cache_keeps_the_twenty_read_last() {
        let dir = tempfile::tempdir().unwrap();
        let cache = RegionCache::new(dir.path().join("reading-regions"), CACHE_SIZE);
        for n in 0..20 {
            cache.put(&format!("hash{n}"), &regions(1, vec![]));
        }
        assert_eq!(cache.len(), 20);
        // Reading the first again makes it recent: the 21st evicts the second instead.
        assert!(cache.get("hash0").is_some());
        cache.put("hash20", &regions(1, vec![]));
        assert_eq!(cache.len(), 20);
        assert!(cache.contains("hash0"));
        assert!(!cache.contains("hash1"));
        assert!(cache.contains("hash20"));
        // A partial result is replaced as pages come in.
        let mut partial = regions(3, vec![]);
        partial.analysed = vec![0];
        cache.put("hash20", &partial);
        assert!(!cache.get("hash20").unwrap().complete());
        partial.add_page(1, [Region { page: 1, kind: "table".into(), rect: q(0.1, 0.1, 0.5, 0.2) }]);
        partial.add_page(2, []);
        partial.add_page(2, []);
        assert_eq!(partial.analysed, [0, 1, 2]);
        cache.put("hash20", &partial);
        assert!(cache.get("hash20").unwrap().complete());
    }

    #[test]
    fn a_structure_made_by_the_model_bypasses_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache = RegionCache::new(dir.path(), CACHE_SIZE);
        cache.put("same", &regions(1, vec![]));
        let modelled = Layout { engine: "layout-onnx".into(), ..without_model() };
        assert!(!needs_regions(&modelled));
        assert_eq!(cached_regions(&modelled, &cache, "same"), None);
        assert!(needs_regions(&without_model()));
        assert!(cached_regions(&without_model(), &cache, "same").is_some());
        assert_eq!(region_of(0, "Table", [60.0, 80.0, 300.0, 100.0], 600.0, 800.0).unwrap().rect, [6554, 6554, 32768, 8192]);
        assert_eq!(region_of(0, "Caption", [0.0, 0.0, 10.0, 10.0], 600.0, 800.0), None);
    }
}
