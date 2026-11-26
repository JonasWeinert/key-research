//! Cooperative cancellation: a request a newer one replaced (a search per keystroke) stops
//! where it is. The host gives the request's thread a `Token` (`run`) and cancels it when a
//! newer request with the same key arrives. Queries on the store's read connections stop at
//! once (an SQLite progress handler asks `requested()`), and long Rust loops call `check()`.
use std::{
    cell::RefCell,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

/// The error a cancelled request answers with (the bridge treats it as superseded).
pub const SUPERSEDED: &str = "Superseded by a newer request";

#[derive(Clone, Debug, Default)]
pub struct Token(Arc<AtomicBool>);

impl Token {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

thread_local! {
    static CURRENT: RefCell<Option<Token>> = const { RefCell::new(None) };
}

/// Runs `f` with `token` as this thread's cancellation, then restores the previous one.
pub fn run<T>(token: &Token, f: impl FnOnce() -> T) -> T {
    let previous = CURRENT.with(|c| c.replace(Some(token.clone())));
    struct Restore(Option<Token>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|c| *c.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(previous);
    f()
}

/// Whether this thread's request was cancelled.
pub fn requested() -> bool {
    CURRENT.with(|c| c.borrow().as_ref().is_some_and(Token::is_cancelled))
}

/// For loops: stop with `SUPERSEDED` when this thread's request was cancelled.
pub fn check() -> crate::Result<()> {
    if requested() { Err(SUPERSEDED.into()) } else { Ok(()) }
}

/// SQLite asks this every few thousand steps of a query on a read connection.
pub(crate) fn install(db: &rusqlite::Connection) {
    let _ = db.progress_handler(4_000, Some(requested));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cancelled_query_stops_and_others_run_on() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::Store::open(dir.path()).unwrap();
        let slow = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000000) SELECT count(*) FROM n";
        let token = Token::new();
        let cancel = token.clone();
        let timer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            cancel.cancel();
        });
        let started = std::time::Instant::now();
        let result = run(&token, || store.read().unwrap().query_row(slow, [], |r| r.get::<_, i64>(0)));
        timer.join().unwrap();
        assert!(result.is_err(), "the query ran to the end");
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert!(!requested(), "the token is only for the request it was given to");
        assert!(check().is_ok());
        // Without a token (or with one not cancelled) the same connection answers.
        let quick = "SELECT count(*) FROM sources";
        assert_eq!(store.read().unwrap().query_row(quick, [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(run(&Token::new(), || store.read().unwrap().query_row(quick, [], |r| r.get::<_, i64>(0)).unwrap()), 0);
        assert_eq!(run(&token, check), Err(SUPERSEDED.to_string()));
    }
}
