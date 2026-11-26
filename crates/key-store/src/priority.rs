//! Who goes first. Every piece of work runs at a class: what the user just clicked or typed
//! (`Interactive`), what the focused view shows (`Foreground`), other open views (`Visible`),
//! bulk work nobody waits on (`Background`) and maintenance (`Idle`).
//!
//! - A thread carries its class (`set_thread_class`, which also sets its macOS QoS), so the
//!   store's locks know who is asking.
//! - `PriorityPool` hands out the store's connections best class first, oldest first within a
//!   class; a waiter gains one class per `AGING` of waiting, so background work still moves.
//! - Background loops call `yield_if_needed()` between small steps: while a user action runs or
//!   waits for a connection, they pause (at most `MAX_YIELD` at a time).
use std::{
    cell::Cell,
    collections::BTreeMap,
    ops::{Deref, DerefMut},
    sync::{
        Condvar, Mutex, MutexGuard,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    Interactive = 0,
    Foreground = 1,
    Visible = 2,
    Background = 3,
    Idle = 4,
}

impl Class {
    pub const ALL: [Class; 5] = [Class::Interactive, Class::Foreground, Class::Visible, Class::Background, Class::Idle];
    pub fn parse(name: &str) -> Option<Class> {
        Self::ALL.into_iter().find(|c| c.name() == name)
    }
    pub fn name(self) -> &'static str {
        match self {
            Class::Interactive => "interactive",
            Class::Foreground => "foreground",
            Class::Visible => "visible",
            Class::Background => "background",
            Class::Idle => "idle",
        }
    }
    fn rank(self) -> usize {
        self as usize
    }
    /// One class better (aging), never past interactive.
    pub fn raised(self) -> Class {
        Self::ALL[self.rank().saturating_sub(1)]
    }
}

/// Waiting this long for a connection counts as one class better.
pub const AGING: Duration = Duration::from_millis(400);
/// The longest one `yield_if_needed` pauses.
pub const MAX_YIELD: Duration = Duration::from_millis(250);

thread_local! {
    static CLASS: Cell<Option<Class>> = const { Cell::new(None) };
}

/// This thread's class; threads that never said are foreground.
pub fn current() -> Class {
    CLASS.with(|c| c.get()).unwrap_or(Class::Foreground)
}

/// Sets this thread's class from now on, and its QoS on macOS (worker threads at start).
pub fn set_thread_class(class: Class) {
    CLASS.with(|c| c.set(Some(class)));
    qos::apply(class);
}

/// Runs `f` at `class` on this thread (QoS unchanged), then restores the thread's class.
pub fn with_class<T>(class: Class, f: impl FnOnce() -> T) -> T {
    let previous = CLASS.with(|c| c.replace(Some(class)));
    struct Restore(Option<Class>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CLASS.with(|c| c.set(self.0));
        }
    }
    let _restore = Restore(previous);
    f()
}

// ── What is running ─────────────────────────────────────────

static ACTIVE: [AtomicUsize; 5] = [const { AtomicUsize::new(0) }; 5];
/// Waiters for any priority pool, per class.
static WAITING: [AtomicUsize; 5] = [const { AtomicUsize::new(0) }; 5];

/// Counts one piece of work of `class` as running until dropped (a host command).
pub struct Active(Class);
pub fn begin(class: Class) -> Active {
    ACTIVE[class.rank()].fetch_add(1, Ordering::SeqCst);
    Active(class)
}
impl Drop for Active {
    fn drop(&mut self) {
        ACTIVE[self.0.rank()].fetch_sub(1, Ordering::SeqCst);
    }
}

/// How many commands of `class` run now.
pub fn active(class: Class) -> usize {
    ACTIVE[class.rank()].load(Ordering::SeqCst)
}

/// Whether work that should go before `class` runs or waits: a user action, or a waiter of a
/// better class at one of the store's locks.
pub fn pressure_above(class: Class) -> bool {
    if class == Class::Interactive {
        return false;
    }
    active(Class::Interactive) > 0 || (0..class.rank()).any(|r| WAITING[r].load(Ordering::SeqCst) > 0)
}

/// A checkpoint for background loops between small steps: pauses while better work runs or
/// waits, up to `MAX_YIELD`. Answers how long it paused.
pub fn yield_if_needed() -> Duration {
    let class = current();
    if class < Class::Background {
        return Duration::ZERO;
    }
    let started = Instant::now();
    while pressure_above(class) && started.elapsed() < MAX_YIELD {
        std::thread::sleep(Duration::from_millis(3));
    }
    started.elapsed()
}

// ── A pool of resources handed out by class ─────────────────

struct State {
    free: Vec<usize>,
    /// Waiting tickets: (class rank, sequence) → when it began waiting.
    waiting: BTreeMap<(usize, u64), Instant>,
    next: u64,
}

/// A few interchangeable resources (one connection: a mutex) handed out best class first.
pub struct PriorityPool<T> {
    slots: Vec<Mutex<T>>,
    state: Mutex<State>,
    freed: Condvar,
}

pub struct Guard<'a, T> {
    pool: &'a PriorityPool<T>,
    slot: usize,
    inner: Option<MutexGuard<'a, T>>,
    since: Instant,
    /// This hold raised a background thread's QoS (see `take`).
    boosted: bool,
}

thread_local! {
    /// Connections this thread holds now.
    static HELD: Cell<u32> = const { Cell::new(0) };
}

impl<T> Deref for Guard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.inner.as_ref().expect("held")
    }
}
impl<T> DerefMut for Guard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        self.inner.as_mut().expect("held")
    }
}
/// `KEY_LOCK_TRACE_MS`: report holds of the store's connections longer than this (stderr),
/// with where they were let go, to find transactions that keep user actions waiting.
fn trace_threshold() -> Option<Duration> {
    static THRESHOLD: std::sync::OnceLock<Option<Duration>> = std::sync::OnceLock::new();
    *THRESHOLD.get_or_init(|| std::env::var("KEY_LOCK_TRACE_MS").ok().and_then(|v| v.parse().ok()).map(Duration::from_millis))
}

impl<T> Drop for Guard<'_, T> {
    fn drop(&mut self) {
        if let Some(threshold) = trace_threshold() {
            let held = self.since.elapsed();
            if held > threshold {
                let trace = std::backtrace::Backtrace::force_capture().to_string();
                let frames: Vec<&str> = trace.lines().map(str::trim).filter(|l| l.contains("key_") && !l.contains("priority") && !l.starts_with("at ")).take(4).collect();
                eprintln!("key lock: held {held:?} by {} ({}) {}", std::thread::current().name().unwrap_or("?"), current().name(), frames.join(" < "));
            }
        }
        self.inner.take();
        HELD.with(|h| h.set(h.get().saturating_sub(1)));
        if self.boosted {
            qos::apply(current());
        }
        let mut state = self.pool.state.lock().unwrap_or_else(|e| e.into_inner());
        state.free.push(self.slot);
        drop(state);
        self.pool.freed.notify_all();
    }
}

fn effective(rank: usize, since: Instant, now: Instant) -> usize {
    let aged = (now.duration_since(since).as_millis() / AGING.as_millis().max(1)) as usize;
    rank.saturating_sub(aged)
}

impl<T> PriorityPool<T> {
    pub fn new(items: Vec<T>) -> Self {
        assert!(!items.is_empty());
        let free = (0..items.len()).rev().collect();
        Self { slots: items.into_iter().map(Mutex::new).collect(), state: Mutex::new(State { free, waiting: BTreeMap::new(), next: 0 }), freed: Condvar::new() }
    }

    pub fn single(item: T) -> Self {
        Self::new(vec![item])
    }

    /// A resource, at this thread's class.
    pub fn lock(&self) -> Result<Guard<'_, T>, String> {
        self.lock_as(current())
    }

    pub fn lock_as(&self, class: Class) -> Result<Guard<'_, T>, String> {
        let mut state = self.state.lock().map_err(|_| "Library database lock poisoned".to_string())?;
        // Free and nobody better waiting: take it.
        if !state.free.is_empty() && !state.waiting.keys().any(|(rank, _)| *rank <= class.rank()) {
            let slot = state.free.pop().expect("free slot");
            drop(state);
            return self.take(slot);
        }
        let ticket = (class.rank(), state.next);
        state.next += 1;
        let since = Instant::now();
        state.waiting.insert(ticket, since);
        WAITING[class.rank()].fetch_add(1, Ordering::SeqCst);
        let slot = loop {
            if !state.free.is_empty() {
                let now = Instant::now();
                let mine = (effective(ticket.0, since, now), ticket.1);
                let best = state.waiting.iter().map(|(&(rank, seq), &at)| (effective(rank, at, now), seq)).min().expect("own ticket");
                if best == mine {
                    break state.free.pop().expect("free slot");
                }
            }
            // Timed, so aging is seen even when nothing is released.
            state = match self.freed.wait_timeout(state, AGING / 4) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        };
        state.waiting.remove(&ticket);
        WAITING[class.rank()].fetch_sub(1, Ordering::SeqCst);
        let more = !state.free.is_empty() && !state.waiting.is_empty();
        drop(state);
        if more {
            self.freed.notify_all();
        }
        self.take(slot)
    }

    fn take(&self, slot: usize) -> Result<Guard<'_, T>, String> {
        match self.slots[slot].lock() {
            Ok(inner) => {
                // A background thread holding a connection runs at the user's QoS until it lets
                // go: on a loaded machine the OS would otherwise park it mid-transaction while a
                // click waits for the connection (priority inversion).
                let boosted = HELD.with(|h| {
                    h.set(h.get() + 1);
                    h.get() == 1
                }) && current() >= Class::Background;
                if boosted {
                    qos::apply(Class::Foreground);
                }
                Ok(Guard { pool: self, slot, inner: Some(inner), since: Instant::now(), boosted })
            }
            Err(_) => {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state.free.push(slot);
                drop(state);
                self.freed.notify_all();
                Err("Library database lock poisoned".into())
            }
        }
    }

    /// Waiters now, per class (tests and status).
    pub fn waiting(&self) -> usize {
        self.state.lock().map(|s| s.waiting.len()).unwrap_or(0)
    }
}

// ── Thread QoS ──────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod qos {
    use super::Class;
    unsafe extern "C" {
        fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
    }
    const USER_INTERACTIVE: u32 = 0x21;
    const USER_INITIATED: u32 = 0x19;
    const UTILITY: u32 = 0x11;
    const BACKGROUND: u32 = 0x09;
    pub fn apply(class: Class) {
        let qos = match class {
            Class::Interactive => USER_INTERACTIVE,
            Class::Foreground | Class::Visible => USER_INITIATED,
            // Utility, not background: background QoS throttles disk reads hard.
            Class::Background => UTILITY,
            Class::Idle => BACKGROUND,
        };
        // SAFETY: sets the calling thread's own QoS; no pointers involved.
        unsafe {
            pthread_set_qos_class_self_np(qos, 0);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod qos {
    pub fn apply(_class: super::Class) {}
}

/// Worker threads for CPU-heavy background work on this machine: fewer on small machines, so
/// the user's own work keeps a core.
pub fn background_threads() -> usize {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    match cores {
        0..=2 => 1,
        3..=4 => 1,
        5..=8 => 2,
        _ => (cores / 3).clamp(2, 4),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::AtomicBool};

    fn hold_then_queue(order: &[Class]) -> Vec<Class> {
        let pool = Arc::new(PriorityPool::single(()));
        let got = Arc::new(Mutex::new(Vec::new()));
        let guard = pool.lock_as(Class::Background).unwrap();
        let mut threads = Vec::new();
        for (i, class) in order.iter().copied().enumerate() {
            let (p, g) = (pool.clone(), got.clone());
            threads.push(std::thread::spawn(move || {
                let _x = p.lock_as(class).unwrap();
                g.lock().unwrap().push(class);
            }));
            // Queue in this order.
            while pool.waiting() < i + 1 {
                std::thread::yield_now();
            }
        }
        drop(guard);
        for t in threads {
            t.join().unwrap();
        }
        Arc::try_unwrap(got).unwrap().into_inner().unwrap()
    }

    #[test]
    fn best_class_goes_first_then_oldest() {
        let order = hold_then_queue(&[Class::Background, Class::Idle, Class::Visible, Class::Interactive, Class::Foreground, Class::Background]);
        assert_eq!(order, [Class::Interactive, Class::Foreground, Class::Visible, Class::Background, Class::Background, Class::Idle]);
    }

    #[test]
    fn a_free_resource_is_not_taken_past_a_better_waiter() {
        let pool = PriorityPool::new(vec![1, 2]);
        let a = pool.lock_as(Class::Background).unwrap();
        let b = pool.lock_as(Class::Background).unwrap();
        assert_ne!(*a, *b);
        drop((a, b));
        assert_eq!(pool.waiting(), 0);
    }

    #[test]
    fn waiting_background_work_ages_past_newer_better_work() {
        let pool = Arc::new(PriorityPool::single(()));
        let guard = pool.lock_as(Class::Foreground).unwrap();
        let got = Arc::new(Mutex::new(Vec::new()));
        let (p, g) = (pool.clone(), got.clone());
        let old = std::thread::spawn(move || {
            let _x = p.lock_as(Class::Background).unwrap();
            g.lock().unwrap().push("background");
        });
        // Two classes of aging later, it ranks with the visible work that arrives now.
        std::thread::sleep(AGING * 3);
        let (p, g) = (pool.clone(), got.clone());
        let new = std::thread::spawn(move || {
            let _x = p.lock_as(Class::Visible).unwrap();
            g.lock().unwrap().push("visible");
        });
        while pool.waiting() < 2 {
            std::thread::yield_now();
        }
        drop(guard);
        old.join().unwrap();
        new.join().unwrap();
        assert_eq!(*got.lock().unwrap(), ["background", "visible"]);
    }

    #[test]
    fn background_yields_while_a_user_action_runs_and_resumes_after() {
        let done = Arc::new(AtomicBool::new(false));
        let d = done.clone();
        let worker = std::thread::spawn(move || {
            set_thread_class(Class::Background);
            // Let the action start first.
            std::thread::sleep(Duration::from_millis(20));
            let paused = yield_if_needed();
            d.store(true, Ordering::SeqCst);
            paused
        });
        let action = begin(Class::Interactive);
        std::thread::sleep(Duration::from_millis(120));
        assert!(!done.load(Ordering::SeqCst), "background work went on during a user action");
        drop(action);
        let paused = worker.join().unwrap();
        assert!(paused >= Duration::from_millis(80) && paused < MAX_YIELD + Duration::from_millis(100), "{paused:?}");
    }

    #[test]
    fn yielding_is_bounded_so_background_work_never_starves() {
        let _action = begin(Class::Interactive);
        let paused = std::thread::spawn(|| {
            set_thread_class(Class::Idle);
            yield_if_needed()
        })
        .join()
        .unwrap();
        assert!(paused >= MAX_YIELD && paused < MAX_YIELD * 2, "{paused:?}");
    }

    #[test]
    fn user_work_never_yields() {
        let _action = begin(Class::Interactive);
        assert_eq!(with_class(Class::Interactive, yield_if_needed), Duration::ZERO);
        assert_eq!(with_class(Class::Foreground, yield_if_needed), Duration::ZERO);
    }

    #[test]
    fn classes_parse_and_age() {
        assert_eq!(Class::parse("visible"), Some(Class::Visible));
        assert_eq!(Class::parse("urgent"), None);
        assert_eq!(Class::Idle.raised(), Class::Background);
        assert_eq!(Class::Interactive.raised(), Class::Interactive);
    }
}
