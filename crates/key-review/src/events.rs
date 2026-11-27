// The append-only event log (docs/review-sync.md): every change to a review is an event with a
// globally unique, time-ordered id (UUIDv7), its author, device, time and the protocol version in
// force. Events from several devices merge by id; replay order is (at, id).
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The event format version written in exports and sync batches.
pub const FORMAT: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub review_id: String,
    pub at: i64,
    pub actor: String,
    #[serde(default)]
    pub device: String,
    pub kind: String,
    /// The protocol version (its `protocol.set` event id) in force.
    #[serde(default)]
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    #[serde(default)]
    pub payload: Json,
}

/// The kinds Key writes. Unknown kinds (from a newer Key) are kept and ignored when deriving.
pub const KINDS: &[&str] = &[
    "review.create",
    "review.rename",
    "review.archive",
    "protocol.set",
    "criteria.alias",
    "team.set",
    "batch.add",
    "batch.remove",
    "records.add",
    "dedup.candidates",
    "dedup.set",
    "decision",
    "decision.retract",
    "resolve",
    "note",
    "labels",
    "fulltext.set",
    "assign",
    "pilot.set",
    "rescreen.flag",
    "extract.value",
    "extract.final",
    "ai.suggest",
    "record.remove",
    "batch.classify",
    "record.edit",
    "record.enrich",
    "study.link",
    "extract.complete",
    "analysis.set",
];

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 64 bits that differ between calls, processes and machines (no RNG crate in the tree).
pub fn random_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    hasher.write_u32(std::process::id());
    hasher.finish()
}

/// A UUIDv7 (RFC 9562): 48-bit ms time, version, 12 bits that keep ids made in the same
/// millisecond in order on this device, variant, 62 random bits.
pub fn uuid7_at(ms: i64) -> String {
    static LAST: AtomicU64 = AtomicU64::new(0);
    // Same millisecond: count up in the 12 "rand_a" bits so local ids stay ordered.
    let ms = ms.max(0) as u64;
    let packed = loop {
        let last = LAST.load(Ordering::Relaxed);
        let (last_ms, last_seq) = (last >> 12, last & 0xfff);
        let next = if ms > last_ms { ms << 12 } else if last_seq < 0xfff { (last_ms << 12) | (last_seq + 1) } else { (last_ms + 1) << 12 };
        if LAST.compare_exchange(last, next, Ordering::Relaxed, Ordering::Relaxed).is_ok() {
            break next;
        }
    };
    let time = packed >> 12;
    let seq = packed & 0xfff;
    let rand = random_u64();
    let hi: u64 = (time << 16) | 0x7000 | seq;
    let lo: u64 = (rand & 0x3fff_ffff_ffff_ffff) | 0x8000_0000_0000_0000;
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        hi >> 32,
        (hi >> 16) & 0xffff,
        hi & 0xffff,
        lo >> 48,
        lo & 0xffff_ffff_ffff
    )
}

pub fn uuid7() -> String {
    uuid7_at(now_ms())
}

/// A short id for things inside a protocol (criteria, reasons, fields).
pub fn short_id(prefix: &str) -> String {
    format!("{prefix}{:010x}", random_u64() & 0xff_ffff_ffff)
}

impl Event {
    pub fn new(review_id: &str, kind: &str, actor: &str, device: &str, version: &str, record_id: Option<&str>, payload: Json) -> Self {
        let at = now_ms();
        Event { id: uuid7_at(at), review_id: review_id.into(), at, actor: actor.into(), device: device.into(), kind: kind.into(), version: version.into(), record_id: record_id.map(Into::into), payload }
    }
    /// The replay order.
    pub fn order_key(&self) -> (i64, &str) {
        (self.at, self.id.as_str())
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.id.len() != 36 || self.review_id.is_empty() || self.kind.is_empty() || self.actor.is_empty() {
            return Err(format!("Malformed event {}", self.id));
        }
        Ok(())
    }
}

/// A small seeded PRNG (SplitMix64) for reproducible samples and splits.
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { (self.next() % n as u64) as usize }
    }
    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.below(i + 1);
            items.swap(i, j);
        }
    }
}

/// A stable 64-bit hash of text (FNV-1a), for seeded per-record choices.
pub fn hash64(seed: u64, text: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ seed;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    let mut r = Rng::new(h);
    r.next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid7_is_ordered_and_well_formed() {
        let a = uuid7_at(1_700_000_000_000);
        let b = uuid7_at(1_700_000_000_000);
        let c = uuid7_at(1_700_000_000_001);
        assert!(a < b && b < c, "{a} {b} {c}");
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "7");
        assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"));
        // The time prefix reads back (later when other tests made newer ids first: ids never go
        // back in time).
        let hex: String = a.replace('-', "")[..12].to_string();
        assert!(u64::from_str_radix(&hex, 16).unwrap() >= 1_700_000_000_000);
    }

    #[test]
    fn rng_is_reproducible() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        assert_eq!((0..5).map(|_| a.next()).collect::<Vec<_>>(), (0..5).map(|_| b.next()).collect::<Vec<_>>());
        assert_eq!(hash64(1, "x"), hash64(1, "x"));
        assert_ne!(hash64(1, "x"), hash64(2, "x"));
    }
}
