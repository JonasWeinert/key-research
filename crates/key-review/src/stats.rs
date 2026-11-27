// Distributions (normal, t, chi-square) and agreement statistics (percent agreement, Cohen's and
// Fleiss' kappa). Special functions follow the standard series and continued fractions
// (Lanczos log-gamma, incomplete gamma and beta), accurate to about 1e-12.
use serde::Serialize;
use std::collections::BTreeMap;

pub fn ln_gamma(x: f64) -> f64 {
    const G: f64 = 7.0;
    const C: [f64; 9] = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    if x < 0.5 {
        let pi = std::f64::consts::PI;
        return (pi / (pi * x).sin()).ln() - ln_gamma(1.0 - x);
    }
    let x = x - 1.0;
    let mut a = C[0];
    let t = x + G + 0.5;
    for (i, c) in C.iter().enumerate().skip(1) {
        a += c / (x + i as f64);
    }
    0.5 * (2.0 * std::f64::consts::PI).ln() + (x + 0.5) * t.ln() - t + a.ln()
}

/// Regularised lower incomplete gamma P(a, x).
pub fn gamma_p(a: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x < a + 1.0 {
        let mut sum = 1.0 / a;
        let mut term = sum;
        let mut n = a;
        for _ in 0..1000 {
            n += 1.0;
            term *= x / n;
            sum += term;
            if term.abs() < sum.abs() * 1e-16 {
                break;
            }
        }
        (sum.ln() - x + a * x.ln() - ln_gamma(a)).exp()
    } else {
        1.0 - gamma_q_cf(a, x)
    }
}

fn gamma_q_cf(a: f64, x: f64) -> f64 {
    let tiny = 1e-300;
    let mut b = x + 1.0 - a;
    let mut c = 1.0 / tiny;
    let mut d = 1.0 / b;
    let mut h = d;
    for i in 1..1000 {
        let an = -(i as f64) * (i as f64 - a);
        b += 2.0;
        d = an * d + b;
        if d.abs() < tiny {
            d = tiny;
        }
        c = b + an / c;
        if c.abs() < tiny {
            c = tiny;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < 1e-16 {
            break;
        }
    }
    (-x + a * x.ln() - ln_gamma(a)).exp() * h
}

/// Upper tail Q(a, x) = 1 − P(a, x), accurate in the far tail.
pub fn gamma_q(a: f64, x: f64) -> f64 {
    if x <= 0.0 {
        1.0
    } else if x < a + 1.0 {
        1.0 - gamma_p(a, x)
    } else {
        gamma_q_cf(a, x)
    }
}

/// Standard normal distribution function.
pub fn norm_cdf(z: f64) -> f64 {
    if z.is_nan() {
        return f64::NAN;
    }
    let half = gamma_q(0.5, z * z / 2.0) / 2.0;
    if z >= 0.0 { 1.0 - half } else { half }
}

/// Two-sided p-value of a z statistic.
pub fn norm_p2(z: f64) -> f64 {
    gamma_q(0.5, z * z / 2.0)
}

/// Standard normal quantile (Acklam's approximation refined by one Halley step).
pub fn norm_quantile(p: f64) -> f64 {
    if p <= 0.0 {
        return f64::NEG_INFINITY;
    }
    if p >= 1.0 {
        return f64::INFINITY;
    }
    let a = [-3.969_683_028_665_376e1, 2.209_460_984_245_205e2, -2.759_285_104_469_687e2, 1.383_577_518_672_69e2, -3.066_479_806_614_716e1, 2.506_628_277_459_239];
    let b = [-5.447_609_879_822_406e1, 1.615_858_368_580_409e2, -1.556_989_798_598_866e2, 6.680_131_188_771_972e1, -1.328_068_155_288_572e1];
    let c = [-7.784_894_002_430_293e-3, -3.223_964_580_411_365e-1, -2.400_758_277_161_838, -2.549_732_539_343_734, 4.374_664_141_464_968, 2.938_163_982_698_783];
    let d = [7.784_695_709_041_462e-3, 3.224_671_290_700_398e-1, 2.445_134_137_142_996, 3.754_408_661_907_416];
    let low = 0.024_25;
    let x = if p < low {
        let q = (-2.0 * p.ln()).sqrt();
        (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
    } else if p <= 1.0 - low {
        let q = p - 0.5;
        let r = q * q;
        (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)
    } else {
        let q = (-2.0 * (1.0 - p).ln()).sqrt();
        -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
    };
    let e = norm_cdf(x) - p;
    let u = e * (2.0 * std::f64::consts::PI).sqrt() * (x * x / 2.0).exp();
    x - u / (1.0 + x * u / 2.0)
}

/// Upper tail of the chi-square distribution.
pub fn chisq_sf(x: f64, df: f64) -> f64 {
    if df <= 0.0 { f64::NAN } else { gamma_q(df / 2.0, x / 2.0) }
}

fn beta_cf(a: f64, b: f64, x: f64) -> f64 {
    let tiny = 1e-300;
    let (qab, qap, qam) = (a + b, a + 1.0, a - 1.0);
    let mut c = 1.0;
    let mut d = 1.0 - qab * x / qap;
    if d.abs() < tiny {
        d = tiny;
    }
    d = 1.0 / d;
    let mut h = d;
    for m in 1..1000 {
        let m = m as f64;
        let m2 = 2.0 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1.0 + aa * d;
        if d.abs() < tiny {
            d = tiny;
        }
        c = 1.0 + aa / c;
        if c.abs() < tiny {
            c = tiny;
        }
        d = 1.0 / d;
        h *= d * c;
        let aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1.0 + aa * d;
        if d.abs() < tiny {
            d = tiny;
        }
        c = 1.0 + aa / c;
        if c.abs() < tiny {
            c = tiny;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < 1e-16 {
            break;
        }
    }
    h
}

/// Regularised incomplete beta I_x(a, b).
pub fn beta_inc(a: f64, b: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let front = (ln_gamma(a + b) - ln_gamma(a) - ln_gamma(b) + a * x.ln() + b * (1.0 - x).ln()).exp();
    if x < (a + 1.0) / (a + b + 2.0) { front * beta_cf(a, b, x) / a } else { 1.0 - front * beta_cf(b, a, 1.0 - x) / b }
}

/// Student t distribution function.
pub fn t_cdf(t: f64, df: f64) -> f64 {
    let tail = 0.5 * beta_inc(df / 2.0, 0.5, df / (df + t * t));
    if t >= 0.0 { 1.0 - tail } else { tail }
}

pub fn t_p2(t: f64, df: f64) -> f64 {
    beta_inc(df / 2.0, 0.5, df / (df + t * t))
}

/// Student t quantile, by bisection on the distribution function.
pub fn t_quantile(p: f64, df: f64) -> f64 {
    if !(0.0..=1.0).contains(&p) || df <= 0.0 {
        return f64::NAN;
    }
    let (mut lo, mut hi) = (-1e4, 1e4);
    for _ in 0..200 {
        let mid = (lo + hi) / 2.0;
        if t_cdf(mid, df) < p {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo + hi) / 2.0
}

// ── Agreement ───────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Agreement {
    /// Records rated by every rater in the set.
    pub n: usize,
    pub percent: Option<f64>,
    /// Cohen's kappa (two raters) or Fleiss' kappa (more).
    pub kappa: Option<f64>,
    pub method: String,
    /// "slight" … "almost perfect" (Landis and Koch's bands).
    pub band: String,
}

pub fn band(kappa: Option<f64>) -> String {
    match kappa {
        None => String::new(),
        Some(k) if k < 0.0 => "poor".into(),
        Some(k) if k <= 0.2 => "slight".into(),
        Some(k) if k <= 0.4 => "fair".into(),
        Some(k) if k <= 0.6 => "moderate".into(),
        Some(k) if k <= 0.8 => "substantial".into(),
        Some(_) => "almost perfect".into(),
    }
}

/// Cohen's kappa for paired ratings (categories are any strings).
pub fn cohen(pairs: &[(String, String)]) -> Agreement {
    let n = pairs.len();
    if n == 0 {
        return Agreement { n, percent: None, kappa: None, method: "Cohen's kappa".into(), band: String::new() };
    }
    let agree = pairs.iter().filter(|(a, b)| a == b).count() as f64 / n as f64;
    let mut ma: BTreeMap<&str, f64> = BTreeMap::new();
    let mut mb: BTreeMap<&str, f64> = BTreeMap::new();
    for (a, b) in pairs {
        *ma.entry(a).or_default() += 1.0;
        *mb.entry(b).or_default() += 1.0;
    }
    let pe: f64 = ma.iter().map(|(k, ca)| ca / n as f64 * mb.get(k).copied().unwrap_or(0.0) / n as f64).sum();
    let kappa = if (1.0 - pe).abs() < 1e-12 { if agree == 1.0 { Some(1.0) } else { None } } else { Some((agree - pe) / (1.0 - pe)) };
    Agreement { n, percent: Some(agree * 100.0), kappa, method: "Cohen's kappa".into(), band: band(kappa) }
}

/// Fleiss' kappa: each item rated by the same number of raters (m ≥ 2).
pub fn fleiss(items: &[Vec<String>]) -> Agreement {
    let items: Vec<&Vec<String>> = items.iter().filter(|r| r.len() >= 2).collect();
    let n = items.len();
    if n == 0 {
        return Agreement { n, percent: None, kappa: None, method: "Fleiss' kappa".into(), band: String::new() };
    }
    let m = items[0].len() as f64;
    let mut totals: BTreeMap<&str, f64> = BTreeMap::new();
    let mut p_bar = 0.0;
    let mut all_agree = 0usize;
    for ratings in &items {
        let mut counts: BTreeMap<&str, f64> = BTreeMap::new();
        for r in ratings.iter() {
            *counts.entry(r).or_default() += 1.0;
            *totals.entry(r).or_default() += 1.0;
        }
        if counts.len() == 1 {
            all_agree += 1;
        }
        p_bar += (counts.values().map(|c| c * c).sum::<f64>() - m) / (m * (m - 1.0));
    }
    p_bar /= n as f64;
    let pe: f64 = totals.values().map(|t| (t / (n as f64 * m)).powi(2)).sum();
    let kappa = if (1.0 - pe).abs() < 1e-12 { if p_bar >= 1.0 - 1e-12 { Some(1.0) } else { None } } else { Some((p_bar - pe) / (1.0 - pe)) };
    Agreement { n, percent: Some(all_agree as f64 / n as f64 * 100.0), kappa, method: "Fleiss' kappa".into(), band: band(kappa) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distributions_match_r() {
        // Values from R: qnorm(0.975), pnorm(-1.5), qt(0.975, 12), pt(2.1, 5), pchisq(152.233, 12, lower=FALSE).
        assert!((norm_quantile(0.975) - 1.959_963_984_540_054).abs() < 1e-12);
        assert!((norm_cdf(-1.5) - 0.066_807_201_268_858_06).abs() < 1e-12);
        assert!((t_quantile(0.975, 12.0) - 2.178_812_829_667_228).abs() < 1e-9);
        assert!((t_cdf(2.1, 5.0) - 0.955_123_375_057_700_6).abs() < 1e-9);
        assert!((chisq_sf(30.0, 12.0) - 0.002_792_429_332_700_916).abs() < 1e-12);
        assert!((ln_gamma(10.0) - 362_880f64.ln()).abs() < 1e-12);
    }

    #[test]
    fn kappa_matches_worked_example() {
        // A 2x2 table: both include 20, both exclude 15, disagreements 5 and 10 (n = 50):
        // po = 0.70, pe = 0.5 → kappa = 0.40.
        let mut pairs = Vec::new();
        let add = |pairs: &mut Vec<(String, String)>, a: &str, b: &str, n: usize| (0..n).for_each(|_| pairs.push((a.into(), b.into())));
        add(&mut pairs, "i", "i", 20);
        add(&mut pairs, "e", "e", 15);
        add(&mut pairs, "i", "e", 5);
        add(&mut pairs, "e", "i", 10);
        let k = cohen(&pairs);
        assert!((k.percent.unwrap() - 70.0).abs() < 1e-9);
        assert!((k.kappa.unwrap() - 0.4).abs() < 1e-9, "{:?}", k.kappa);
        assert_eq!(k.band, "fair");
        // Fleiss with two raters on the same data agrees in sign and size closely.
        let items: Vec<Vec<String>> = pairs.iter().map(|(a, b)| vec![a.clone(), b.clone()]).collect();
        let f = fleiss(&items);
        assert!((f.kappa.unwrap() - 0.3939).abs() < 1e-3, "{:?}", f.kappa);
    }
}
