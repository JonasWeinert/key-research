// Battery and Low Power Mode. Electron main reports the Mac's power state (`store_power_state`);
// the policy is here: bulk indexing and back-fill are held back on battery below a level, or
// in Low Power Mode, as the workspace's setting says. What the user opens, selects or has on
// screen is never held back (key-index only holds unprioritised sources), and "Continue
// anyway" lets bulk work run until the Mac is plugged in again.
use super::{json_output, library_store::Library};
use crate::ipc::{Output, arg};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

/// Below this battery level the default policy holds bulk work.
pub const LOW_BATTERY: f64 = 0.3;
pub const MODES: [&str; 3] = ["low", "battery", "never"];

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PowerState {
    #[serde(default)]
    pub on_battery: bool,
    /// 0–1, when known.
    #[serde(default)]
    pub level: Option<f64>,
    #[serde(default)]
    pub low_power: bool,
}

static STATE: Mutex<PowerState> = Mutex::new(PowerState { on_battery: false, level: None, low_power: false });
static CONTINUED: AtomicBool = AtomicBool::new(false);

/// Why bulk work is held, if it is: "battery" or "low-power".
/// - `low` (the default): in Low Power Mode, or on battery below 30%.
/// - `battery`: whenever on battery (or in Low Power Mode).
/// - `never`: never held.
pub fn hold_reason(mode: &str, state: &PowerState, continued: bool) -> Option<&'static str> {
    if continued || mode == "never" {
        return None;
    }
    if state.low_power {
        return Some("low-power");
    }
    let low = state.level.is_some_and(|l| l < LOW_BATTERY);
    (state.on_battery && (mode == "battery" || low)).then_some("battery")
}

fn mode(library: &Library) -> String {
    super::workspace_settings::own(&library.store).battery.filter(|m| MODES.contains(&m.as_str())).unwrap_or_else(|| "low".into())
}

/// Applies the policy to this workspace's indexer; answers why it holds, if it does.
pub fn apply(library: &Library) -> Option<&'static str> {
    let state = STATE.lock().map(|s| *s).unwrap_or_default();
    let reason = hold_reason(&mode(library), &state, CONTINUED.load(Ordering::SeqCst));
    library.indexer.set_held(reason.is_some());
    reason
}

/// The policy's state for the status bar (`store_status`).
pub fn status(library: &Library) -> Json {
    let state = STATE.lock().map(|s| *s).unwrap_or_default();
    let held = apply(library);
    json!({ "held": held, "mode": mode(library), "continued": CONTINUED.load(Ordering::SeqCst), "state": state })
}

pub fn dispatch(library: &Library, command: &str, args: &Json) -> Option<Result<Output, String>> {
    let result = match command {
        // { onBattery, level?, lowPower } from Electron main's power monitor.
        "store_power_state" => (|| {
            let state: PowerState = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
            if let Ok(mut slot) = STATE.lock() {
                *slot = state;
            }
            // Plugged in again: "Continue anyway" is spent.
            if !state.on_battery && !state.low_power {
                CONTINUED.store(false, Ordering::SeqCst);
            }
            json_output(status(library))
        })(),
        // The status bar's "Continue anyway": bulk work runs until the Mac is plugged in.
        "store_power_continue" => (|| {
            CONTINUED.store(arg::<Option<bool>>(args, "on")?.unwrap_or(true), Ordering::SeqCst);
            json_output(status(library))
        })(),
        "store_power_status" => json_output(status(library)),
        _ => return None,
    };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(on_battery: bool, level: f64, low_power: bool) -> PowerState {
        PowerState { on_battery, level: Some(level), low_power }
    }

    #[test]
    fn holds_bulk_work_by_mode() {
        assert_eq!(hold_reason("low", &state(false, 1.0, false), false), None);
        assert_eq!(hold_reason("low", &state(true, 0.8, false), false), None);
        assert_eq!(hold_reason("low", &state(true, 0.2, false), false), Some("battery"));
        assert_eq!(hold_reason("low", &state(false, 1.0, true), false), Some("low-power"));
        assert_eq!(hold_reason("battery", &state(true, 0.9, false), false), Some("battery"));
        assert_eq!(hold_reason("never", &state(true, 0.05, true), false), None);
        // Continue anyway lets it run.
        assert_eq!(hold_reason("low", &state(true, 0.1, false), true), None);
        // An unknown level on battery holds only in the battery mode.
        assert_eq!(hold_reason("low", &PowerState { on_battery: true, level: None, low_power: false }, false), None);
    }
}
