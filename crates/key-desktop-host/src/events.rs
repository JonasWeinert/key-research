// Events the host sends without being asked: background work (DOI backfill, OpenAlex
// lookups) marks the library changed and, at most once per `THROTTLE`, Electron gets a
// `library-changed` frame (id 0, see rust-bridge.ts) so open views refresh instead of polling.
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const THROTTLE: Duration = Duration::from_millis(1500);
static LIBRARY_CHANGED: AtomicBool = AtomicBool::new(false);

/// Background work changed sources the user may be looking at.
pub fn library_changed() {
    LIBRARY_CHANGED.store(true, Ordering::Relaxed);
}

/// The frame of an event (shares the response framing; id 0 is never a request's).
pub fn frame(name: &str) -> Vec<u8> {
    let header = serde_json::to_vec(&serde_json::json!({ "id": 0, "ok": true, "event": name, "binaryLength": 0 })).unwrap_or_default();
    let mut out = (header.len() as u32).to_le_bytes().to_vec();
    out.extend(header);
    out
}

/// Starts the thread that sends the throttled events on `out`.
pub fn start<W: Write + Send + 'static>(out: Arc<Mutex<W>>) {
    std::thread::Builder::new()
        .name("key-host-events".into())
        .spawn(move || loop {
            std::thread::sleep(THROTTLE);
            if LIBRARY_CHANGED.swap(false, Ordering::Relaxed) {
                let Ok(mut out) = out.lock() else { return };
                if out.write_all(&frame("library-changed")).and_then(|()| out.flush()).is_err() {
                    return;
                }
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    #[test]
    fn frames_like_a_response() {
        let frame = super::frame("library-changed");
        let length = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(&frame[4..]).unwrap();
        assert_eq!(length, frame.len() - 4);
        assert_eq!(header["event"], "library-changed");
        assert_eq!(header["id"], 0);
    }
}
