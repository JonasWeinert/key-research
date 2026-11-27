// Keeps the library's stored formula values current (key_store formula_values.rs): drains the
// sources whose inputs changed and refills edited formulas, one small transaction at a time
// at background class, and marks the library changed when values did change so open views
// refresh. Idle, it looks again every second (that also notices a new day for formulas that
// use today).
use key_store::Store;
use std::time::Duration;

const BATCH: usize = 200;

pub fn start(store: Store) {
    let _ = std::thread::Builder::new().name("key-formulas".into()).spawn(move || {
        key_store::priority::set_thread_class(key_store::priority::Class::Background);
        loop {
            key_store::priority::yield_if_needed();
            match store.formula_recalc_step(BATCH) {
                Ok(stats) => {
                    if stats.changed > 0 {
                        crate::events::library_changed();
                    }
                    if !stats.remaining {
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
                Err(_) => std::thread::sleep(Duration::from_secs(5)),
            }
        }
    });
}
