// UTC times as RFC 3339 text ("2026-11-26T20:15:00Z"), without a date library.
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

/// Seconds since 1970 for "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS(.fff)Z" (UTC only).
pub fn parse(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, time) = text.split_once('T').unwrap_or((text, "00:00:00Z"));
    let parts: Vec<i64> = date.split('-').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let [y, m, d] = parts.as_slice() else { return None };
    if !(1..=12).contains(m) || !(1..=31).contains(d) {
        return None;
    }
    let time = time.strip_suffix('Z').or_else(|| time.strip_suffix("+00:00"))?;
    let time = time.split('.').next()?;
    let hms: Vec<i64> = time.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let (h, mi, s) = match hms.as_slice() {
        [h, mi, s] => (*h, *mi, *s),
        [h, mi] => (*h, *mi, 0),
        _ => return None,
    };
    Some(days_from_civil(*y, *m, *d) * 86400 + h * 3600 + mi * 60 + s)
}

pub fn format(secs: i64) -> String {
    let (y, m, d) = civil_from_days(secs.div_euclid(86400));
    let rest = secs.rem_euclid(86400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

pub fn current_year() -> i64 {
    civil_from_days(now_secs().div_euclid(86400)).0
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trips() {
        let t = super::parse("2026-11-26T20:15:07Z").unwrap();
        assert_eq!(super::format(t), "2026-11-26T20:15:07Z");
        assert_eq!(super::parse("1970-01-02"), Some(86400));
        assert!(super::parse("2026-13-01").is_none());
        assert!(super::current_year() >= 2026);
    }
}
