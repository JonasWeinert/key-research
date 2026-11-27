// Meta-analysis of extracted outcomes: effect sizes (RR, OR, RD from 2x2 counts; MD and SMD
// (Hedges' g) from means; generic inverse variance from an estimate with its SE or 95% CI),
// fixed-effect and random-effects pooling (DerSimonian–Laird, REML; Hartung–Knapp adjustment),
// heterogeneity (Q, I², H², τ², prediction interval), subgroups with a test for differences,
// leave-one-out and Egger's regression test.
//
// The formulas follow metafor (Viechtbauer 2010, J Stat Softw 36(3)) so results can be checked
// against R: escalc's default 1/2 correction for 2x2 tables with a zero cell, the exact bias
// correction of Hedges' g with the large-sample variance, REML by Fisher scoring, I² from τ² and
// the "typical" within-study variance, prediction intervals with z (t with k − 1 df under
// Hartung–Knapp). The tests at the end reproduce metafor 5.2-1's results on its own example data.
// std-D added correlations (r, Fisher's z, partial r from t and df), the response ratio, incidence
// rate ratios, proportions (logit, Freeman–Tukey) with back-transformation, the standardised mean
// change and hazard ratios, each checked against escalc().
use crate::stats::{chisq_sf, ln_gamma, norm_p2, norm_quantile, t_p2, t_quantile};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Measure {
    RR,
    OR,
    RD,
    MD,
    SMD,
    /// An estimate and its standard error as reported (ratio measures on the log scale).
    GEN,
    // std-D: more effect sizes (metafor's escalc names).
    /// Correlation coefficient.
    COR,
    /// Fisher's r-to-z transformed correlation.
    ZCOR,
    /// Partial correlation from a regression's t statistic and residual df (metafor's variance).
    PCOR,
    /// Partial correlation with the economics standard error √((1 − r²)/df) (Stanley & Doucouliagos 2012).
    PCORSD,
    /// Log response ratio (ratio of means).
    ROM,
    /// Log incidence rate ratio (events over person-time).
    IRR,
    /// Logit-transformed proportion (one group).
    PLO,
    /// Freeman–Tukey double-arcsine proportion (one group).
    PFT,
    /// Standardised mean change, raw-score standardisation (Becker 1988).
    SMCR,
    /// Hazard ratio from HR and its interval or SE (generic inverse variance, log scale).
    HR,
}

impl Measure {
    pub fn parse(text: &str) -> Result<Measure, String> {
        Ok(match text.to_ascii_uppercase().as_str() {
            "RR" => Measure::RR,
            "OR" => Measure::OR,
            "RD" => Measure::RD,
            "MD" => Measure::MD,
            "SMD" | "G" | "HEDGES" => Measure::SMD,
            "GEN" | "GENERIC" | "IV" => Measure::GEN,
            "COR" => Measure::COR,
            "ZCOR" => Measure::ZCOR,
            "PCOR" => Measure::PCOR,
            "PCORSD" => Measure::PCORSD,
            "ROM" => Measure::ROM,
            "IRR" => Measure::IRR,
            "PLO" => Measure::PLO,
            "PFT" => Measure::PFT,
            "SMCR" => Measure::SMCR,
            "HR" => Measure::HR,
            other => return Err(format!("Unknown effect measure {other}")),
        })
    }
    /// Analysed on the log scale and shown as ratios.
    pub fn is_ratio(self) -> bool {
        matches!(self, Measure::RR | Measure::OR | Measure::ROM | Measure::IRR | Measure::HR)
    }
    /// How pooled values are shown: "exp" (ratios), "tanh" (Fisher's z to r), "expit" (logit to
    /// a proportion), "ipft" (double arcsine to a proportion, Miller 1978) or "none".
    pub fn transform(self) -> &'static str {
        match self {
            m if m.is_ratio() => "exp",
            Measure::ZCOR => "tanh",
            Measure::PLO => "expit",
            Measure::PFT => "ipft",
            _ => "none",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Measure::RR => "Risk ratio",
            Measure::OR => "Odds ratio",
            Measure::RD => "Risk difference",
            Measure::MD => "Mean difference",
            Measure::SMD => "Standardised mean difference (Hedges' g)",
            Measure::GEN => "Effect estimate",
            Measure::COR => "Correlation",
            Measure::ZCOR => "Correlation (Fisher's z)",
            Measure::PCOR => "Partial correlation",
            Measure::PCORSD => "Partial correlation (economics SE)",
            Measure::ROM => "Response ratio",
            Measure::IRR => "Incidence rate ratio",
            Measure::PLO => "Proportion (logit)",
            Measure::PFT => "Proportion (double arcsine)",
            Measure::SMCR => "Standardised mean change",
            Measure::HR => "Hazard ratio",
        }
    }
}

/// One study's data for one outcome.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StudyData {
    pub id: String,
    pub label: String,
    pub e1: Option<f64>,
    pub n1: Option<f64>,
    pub e2: Option<f64>,
    pub n2: Option<f64>,
    pub m1: Option<f64>,
    pub sd1: Option<f64>,
    pub m2: Option<f64>,
    pub sd2: Option<f64>,
    /// A reported estimate (ratios as ratios when `ratio`), with its SE or 95% interval.
    pub estimate: Option<f64>,
    pub se: Option<f64>,
    pub lower: Option<f64>,
    pub upper: Option<f64>,
    /// The reported estimate is a ratio (OR, RR, HR): analysed as its log.
    pub ratio: bool,
    pub subgroup: Option<String>,
    // std-D: inputs of the further effect sizes.
    /// A correlation (COR/ZCOR), or the pre–post correlation (SMCR).
    pub r: Option<f64>,
    /// A t statistic and its degrees of freedom (PCOR).
    pub t: Option<f64>,
    pub df: Option<f64>,
    /// Person-time per group (IRR).
    pub time1: Option<f64>,
    pub time2: Option<f64>,
    /// The table row this came from (several estimates per study).
    pub row: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    /// Fixed (common) effect, inverse variance.
    Fe,
    /// Random effects, DerSimonian–Laird.
    Dl,
    /// Random effects, restricted maximum likelihood.
    Reml,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub measure: Measure,
    pub method: Method,
    /// Hartung–Knapp(–Sidik–Jonkman) adjustment of the random-effects interval.
    pub hartung_knapp: bool,
    /// Confidence level (0.95).
    pub level: f64,
}

impl Default for Options {
    fn default() -> Self {
        Options { measure: Measure::RR, method: Method::Reml, hartung_knapp: false, level: 0.95 }
    }
}

/// An effect size: the estimate yi and its sampling variance vi on the analysis scale.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Effect {
    pub yi: f64,
    pub vi: f64,
}

/// escalc for one study, or why it cannot be computed.
pub fn effect(s: &StudyData, measure: Measure) -> Result<Effect, String> {
    let need = |v: Option<f64>, what: &str| v.filter(|x| x.is_finite()).ok_or_else(|| format!("{}: missing {what}", s.label));
    match measure {
        Measure::RR | Measure::OR | Measure::RD => {
            let (e1, n1, e2, n2) = (need(s.e1, "events (group 1)")?, need(s.n1, "total (group 1)")?, need(s.e2, "events (group 2)")?, need(s.n2, "total (group 2)")?);
            if n1 <= 0.0 || n2 <= 0.0 || e1 < 0.0 || e2 < 0.0 || e1 > n1 || e2 > n2 {
                return Err(format!("{}: events must be between 0 and the total", s.label));
            }
            let (mut a, mut b, mut c, mut d) = (e1, n1 - e1, e2, n2 - e2);
            if a == 0.0 || b == 0.0 || c == 0.0 || d == 0.0 {
                a += 0.5;
                b += 0.5;
                c += 0.5;
                d += 0.5;
            }
            let (n1, n2) = (a + b, c + d);
            Ok(match measure {
                Measure::OR => Effect { yi: (a * d / (b * c)).ln(), vi: 1.0 / a + 1.0 / b + 1.0 / c + 1.0 / d },
                Measure::RR => Effect { yi: ((a / n1) / (c / n2)).ln(), vi: 1.0 / a - 1.0 / n1 + 1.0 / c - 1.0 / n2 },
                _ => {
                    let (p1, p2) = (a / n1, c / n2);
                    Effect { yi: p1 - p2, vi: p1 * (1.0 - p1) / n1 + p2 * (1.0 - p2) / n2 }
                }
            })
        }
        Measure::MD | Measure::SMD => {
            let (m1, sd1, n1) = (need(s.m1, "mean (group 1)")?, need(s.sd1, "SD (group 1)")?, need(s.n1, "number (group 1)")?);
            let (m2, sd2, n2) = (need(s.m2, "mean (group 2)")?, need(s.sd2, "SD (group 2)")?, need(s.n2, "number (group 2)")?);
            if n1 < 2.0 || n2 < 2.0 || sd1 < 0.0 || sd2 < 0.0 {
                return Err(format!("{}: needs at least 2 per group and SDs of 0 or more", s.label));
            }
            if measure == Measure::MD {
                return Ok(Effect { yi: m1 - m2, vi: sd1 * sd1 / n1 + sd2 * sd2 / n2 });
            }
            let df = n1 + n2 - 2.0;
            let sp = (((n1 - 1.0) * sd1 * sd1 + (n2 - 1.0) * sd2 * sd2) / df).sqrt();
            if sp <= 0.0 {
                return Err(format!("{}: the pooled SD is 0", s.label));
            }
            let j = (ln_gamma(df / 2.0) - 0.5 * (df / 2.0).ln() - ln_gamma((df - 1.0) / 2.0)).exp();
            let g = j * (m1 - m2) / sp;
            Ok(Effect { yi: g, vi: 1.0 / n1 + 1.0 / n2 + g * g / (2.0 * (n1 + n2)) })
        }
        Measure::COR | Measure::ZCOR => {
            let (r, n) = (need(s.r, "correlation")?, need(s.n1, "sample size (group 1 total)")?);
            if !(-1.0 < r && r < 1.0) || n < 4.0 {
                return Err(format!("{}: needs a correlation between −1 and 1 and at least 4 participants", s.label));
            }
            Ok(if measure == Measure::COR { Effect { yi: r, vi: (1.0 - r * r).powi(2) / (n - 1.0) } } else { Effect { yi: r.atanh(), vi: 1.0 / (n - 3.0) } })
        }
        Measure::PCOR | Measure::PCORSD => {
            let (t, df) = (need(s.t, "t statistic")?, need(s.df, "degrees of freedom")?);
            if df <= 0.0 {
                return Err(format!("{}: degrees of freedom must be above 0", s.label));
            }
            let r = t / (t * t + df).sqrt();
            // df = n − m − 1 (m predictors); metafor's large-sample variance divides by n − m = df + 1.
            Ok(Effect { yi: r, vi: if measure == Measure::PCOR { (1.0 - r * r).powi(2) / (df + 1.0) } else { (1.0 - r * r) / df } })
        }
        Measure::ROM => {
            let (m1, sd1, n1) = (need(s.m1, "mean (group 1)")?, need(s.sd1, "SD (group 1)")?, need(s.n1, "number (group 1)")?);
            let (m2, sd2, n2) = (need(s.m2, "mean (group 2)")?, need(s.sd2, "SD (group 2)")?, need(s.n2, "number (group 2)")?);
            if m1 <= 0.0 || m2 <= 0.0 {
                return Err(format!("{}: a response ratio needs means above 0", s.label));
            }
            // With metafor's default small-sample bias correction (Lajeunesse 2015, Ecology 96:2056).
            let (c1, c2) = (sd1 * sd1 / (n1 * m1 * m1), sd2 * sd2 / (n2 * m2 * m2));
            Ok(Effect { yi: (m1 / m2).ln() + 0.5 * (c1 - c2), vi: c1 + c2 })
        }
        Measure::IRR => {
            let (mut x1, t1, mut x2, t2) = (need(s.e1, "events (group 1)")?, need(s.time1, "person-time (group 1)")?, need(s.e2, "events (group 2)")?, need(s.time2, "person-time (group 2)")?);
            if t1 <= 0.0 || t2 <= 0.0 || x1 < 0.0 || x2 < 0.0 {
                return Err(format!("{}: needs events of 0 or more and person-time above 0", s.label));
            }
            if x1 == 0.0 || x2 == 0.0 {
                x1 += 0.5;
                x2 += 0.5;
            }
            Ok(Effect { yi: ((x1 / t1) / (x2 / t2)).ln(), vi: 1.0 / x1 + 1.0 / x2 })
        }
        Measure::PLO | Measure::PFT => {
            let (mut x, mut n) = (need(s.e1, "events")?, need(s.n1, "total")?);
            if n <= 0.0 || x < 0.0 || x > n {
                return Err(format!("{}: events must be between 0 and the total", s.label));
            }
            if measure == Measure::PFT {
                return Ok(Effect { yi: 0.5 * ((x / (n + 1.0)).sqrt().asin() + ((x + 1.0) / (n + 1.0)).sqrt().asin()), vi: 1.0 / (4.0 * n + 2.0) });
            }
            if x == 0.0 || x == n {
                x += 0.5;
                n += 1.0;
            }
            let p = x / n;
            Ok(Effect { yi: (p / (1.0 - p)).ln(), vi: 1.0 / (n * p) + 1.0 / (n * (1.0 - p)) })
        }
        Measure::SMCR => {
            let (m1, m2, sd1, n, r) = (need(s.m1, "follow-up mean")?, need(s.m2, "baseline mean")?, need(s.sd1, "baseline SD")?, need(s.n1, "number")?, need(s.r, "pre–post correlation")?);
            if sd1 <= 0.0 || n < 3.0 {
                return Err(format!("{}: needs a baseline SD above 0 and at least 3 participants", s.label));
            }
            let df = n - 1.0;
            let j = (ln_gamma(df / 2.0) - 0.5 * (df / 2.0).ln() - ln_gamma((df - 1.0) / 2.0)).exp();
            let yi = j * (m1 - m2) / sd1;
            Ok(Effect { yi, vi: 2.0 * (1.0 - r) / n + yi * yi / (2.0 * n) })
        }
        Measure::GEN | Measure::HR => {
            let est = need(s.estimate, "estimate")?;
            let z = norm_quantile(0.975);
            let ratio = s.ratio || measure == Measure::HR;
            let scale = |v: f64| if ratio { v.ln() } else { v };
            if ratio && est <= 0.0 {
                return Err(format!("{}: a ratio must be above 0", s.label));
            }
            let yi = scale(est);
            let se = match (s.se, s.lower, s.upper) {
                (Some(se), _, _) if se > 0.0 => se,
                (_, Some(l), Some(u)) if u > l && (!ratio || l > 0.0) => (scale(u) - scale(l)) / (2.0 * z),
                _ => return Err(format!("{}: needs a standard error or a 95% interval", s.label)),
            };
            Ok(Effect { yi, vi: se * se })
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pooled {
    pub estimate: f64,
    pub se: f64,
    pub lower: f64,
    pub upper: f64,
    /// z, or t under Hartung–Knapp.
    pub statistic: f64,
    pub p: f64,
    pub tau2: f64,
    pub tau: f64,
    pub q: f64,
    pub df: usize,
    pub q_p: f64,
    pub i2: f64,
    pub h2: f64,
    pub pi_lower: Option<f64>,
    pub pi_upper: Option<f64>,
    pub k: usize,
    pub method: Method,
    pub hartung_knapp: bool,
}

/// Pools effects with inverse-variance weights.
pub fn pool(effects: &[Effect], method: Method, hartung_knapp: bool, level: f64) -> Result<Pooled, String> {
    let k = effects.len();
    if k == 0 {
        return Err("No studies with data".into());
    }
    if effects.iter().any(|e| !(e.vi > 0.0) || !e.yi.is_finite()) {
        return Err("Every study needs a variance above 0".into());
    }
    let w: Vec<f64> = effects.iter().map(|e| 1.0 / e.vi).collect();
    let sw: f64 = w.iter().sum();
    let sw2: f64 = w.iter().map(|x| x * x).sum();
    let mu_fe = effects.iter().zip(&w).map(|(e, w)| w * e.yi).sum::<f64>() / sw;
    let q: f64 = effects.iter().zip(&w).map(|(e, w)| w * (e.yi - mu_fe).powi(2)).sum();
    let df = k.saturating_sub(1);
    let tau2 = match method {
        Method::Fe => 0.0,
        Method::Dl => {
            if k > 1 {
                ((q - df as f64) / (sw - sw2 / sw)).max(0.0)
            } else {
                0.0
            }
        }
        Method::Reml => {
            if k > 1 {
                reml(effects)?
            } else {
                0.0
            }
        }
    };
    let ws: Vec<f64> = effects.iter().map(|e| 1.0 / (e.vi + tau2)).collect();
    let sws: f64 = ws.iter().sum();
    let mu = effects.iter().zip(&ws).map(|(e, w)| w * e.yi).sum::<f64>() / sws;
    let alpha = 1.0 - level;
    let hk = hartung_knapp && method != Method::Fe && k > 1;
    let (se, crit, statistic, p) = if hk {
        let s2 = effects.iter().zip(&ws).map(|(e, w)| w * (e.yi - mu).powi(2)).sum::<f64>() / df as f64;
        let se = (s2 / sws).sqrt();
        let t = mu / se;
        (se, t_quantile(1.0 - alpha / 2.0, df as f64), t, t_p2(t, df as f64))
    } else {
        let se = (1.0 / sws).sqrt();
        let z = mu / se;
        (se, norm_quantile(1.0 - alpha / 2.0), z, norm_p2(z))
    };
    // I² and H² from τ² and the typical within-study variance (Higgins & Thompson); with no
    // τ² (fixed effect) from Q.
    let (i2, h2) = if method == Method::Fe || k < 2 {
        let i2 = if q > 0.0 { ((q - df as f64) / q).max(0.0) * 100.0 } else { 0.0 };
        (i2, if df > 0 { q / df as f64 } else { 1.0 })
    } else {
        let vt = df as f64 * sw / (sw * sw - sw2);
        (100.0 * tau2 / (tau2 + vt), (tau2 + vt) / vt)
    };
    let (pi_lower, pi_upper) = if method != Method::Fe && k > 1 {
        let crit = if hk { t_quantile(1.0 - alpha / 2.0, df as f64) } else { norm_quantile(1.0 - alpha / 2.0) };
        let half = crit * (se * se + tau2).sqrt();
        (Some(mu - half), Some(mu + half))
    } else {
        (None, None)
    };
    Ok(Pooled {
        estimate: mu,
        se,
        lower: mu - crit * se,
        upper: mu + crit * se,
        statistic,
        p,
        tau2,
        tau: tau2.sqrt(),
        q,
        df,
        q_p: if df > 0 { chisq_sf(q, df as f64) } else { 1.0 },
        i2,
        h2,
        pi_lower,
        pi_upper,
        k,
        method,
        hartung_knapp: hk,
    })
}

/// τ² by REML (Fisher scoring, as metafor), truncated at 0.
fn reml(effects: &[Effect]) -> Result<f64, String> {
    // Start from the DerSimonian–Laird estimate.
    let w: Vec<f64> = effects.iter().map(|e| 1.0 / e.vi).collect();
    let sw: f64 = w.iter().sum();
    let sw2: f64 = w.iter().map(|x| x * x).sum();
    let mu = effects.iter().zip(&w).map(|(e, w)| w * e.yi).sum::<f64>() / sw;
    let q: f64 = effects.iter().zip(&w).map(|(e, w)| w * (e.yi - mu).powi(2)).sum();
    let mut tau2 = ((q - (effects.len() as f64 - 1.0)) / (sw - sw2 / sw)).max(0.0);
    for _ in 0..1000 {
        let w: Vec<f64> = effects.iter().map(|e| 1.0 / (e.vi + tau2)).collect();
        let sw: f64 = w.iter().sum();
        let sw2: f64 = w.iter().map(|x| x * x).sum();
        let sw3: f64 = w.iter().map(|x| x * x * x).sum();
        let mu = effects.iter().zip(&w).map(|(e, w)| w * e.yi).sum::<f64>() / sw;
        let ypp: f64 = effects.iter().zip(&w).map(|(e, w)| w * w * (e.yi - mu).powi(2)).sum();
        let tr_p = sw - sw2 / sw;
        let tr_pp = sw2 - 2.0 * sw3 / sw + (sw2 / sw).powi(2);
        let step = (ypp - tr_p) / tr_pp;
        let mut next = tau2 + step;
        if next < 0.0 {
            next = 0.0;
        }
        if (next - tau2).abs() < 1e-10 * (1.0 + tau2) {
            return Ok(next);
        }
        tau2 = next;
    }
    Err("The REML estimate of τ² did not converge".into())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyResult {
    pub id: String,
    pub label: String,
    pub yi: f64,
    pub vi: f64,
    pub lower: f64,
    pub upper: f64,
    /// Percent weight in the chosen model.
    pub weight: f64,
    pub subgroup: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subgroup {
    pub name: String,
    pub pooled: Pooled,
    pub studies: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubgroupTest {
    pub q: f64,
    pub df: usize,
    pub p: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaveOneOut {
    pub id: String,
    pub label: String,
    pub estimate: f64,
    pub lower: f64,
    pub upper: f64,
    pub tau2: f64,
    pub i2: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Egger {
    /// The test of funnel asymmetry (t on k − 2 df).
    pub t: f64,
    pub df: usize,
    pub p: f64,
    /// The intercept: the estimate as the standard error goes to 0.
    pub limit: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub measure: Measure,
    pub measure_label: String,
    pub ratio: bool,
    pub studies: Vec<StudyResult>,
    /// Studies left out, and why.
    pub skipped: Vec<(String, String)>,
    pub fixed: Pooled,
    pub random: Option<Pooled>,
    /// The model chosen in the options.
    pub main: Pooled,
    pub subgroups: Vec<Subgroup>,
    pub subgroup_test: Option<SubgroupTest>,
    pub leave_one_out: Vec<LeaveOneOut>,
    pub egger: Option<Egger>,
    /// std-D: how to show values on the outcome's scale ("exp", "tanh", "expit", "ipft", "none")
    /// and, for "ipft", the harmonic mean of the sample sizes (Miller 1978).
    pub transform: String,
    pub harmonic_n: Option<f64>,
}

/// Egger's regression test: weighted least squares of yi on sei with weights 1/vi
/// (metafor's `regtest(model = "lm")`), testing the slope.
pub fn egger(effects: &[Effect]) -> Option<Egger> {
    let k = effects.len();
    if k < 3 {
        return None;
    }
    let (mut sw, mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for e in effects {
        let w = 1.0 / e.vi;
        let x = e.vi.sqrt();
        sw += w;
        sx += w * x;
        sy += w * e.yi;
        sxx += w * x * x;
        sxy += w * x * e.yi;
    }
    let det = sw * sxx - sx * sx;
    if det.abs() < 1e-300 {
        return None;
    }
    let b1 = (sw * sxy - sx * sy) / det;
    let b0 = (sy - b1 * sx) / sw;
    let rss: f64 = effects.iter().map(|e| (e.yi - b0 - b1 * e.vi.sqrt()).powi(2) / e.vi).sum();
    let df = k - 2;
    let sigma2 = rss / df as f64;
    let se_b1 = (sigma2 * sw / det).sqrt();
    let t = b1 / se_b1;
    Some(Egger { t, df, p: t_p2(t, df as f64), limit: b0 })
}

/// The whole analysis of one outcome.
pub fn analyse(studies: &[StudyData], options: &Options) -> Result<Analysis, String> {
    let mut used: Vec<(&StudyData, Effect)> = Vec::new();
    let mut skipped = Vec::new();
    for s in studies {
        match effect(s, options.measure) {
            Ok(e) if e.vi > 0.0 && e.yi.is_finite() => used.push((s, e)),
            Ok(_) => skipped.push((s.label.clone(), "Variance of 0".into())),
            Err(why) => skipped.push((s.label.clone(), why)),
        }
    }
    let effects: Vec<Effect> = used.iter().map(|(_, e)| *e).collect();
    let fixed = pool(&effects, Method::Fe, false, options.level)?;
    let random = if options.method == Method::Fe { None } else { Some(pool(&effects, options.method, options.hartung_knapp, options.level)?) };
    let main = random.clone().unwrap_or_else(|| fixed.clone());
    let z = norm_quantile(1.0 - (1.0 - options.level) / 2.0);
    let weights: Vec<f64> = effects.iter().map(|e| 1.0 / (e.vi + main.tau2)).collect();
    let total: f64 = weights.iter().sum();
    let studies_out = used
        .iter()
        .zip(&weights)
        .map(|((s, e), w)| StudyResult { id: s.id.clone(), label: s.label.clone(), yi: e.yi, vi: e.vi, lower: e.yi - z * e.vi.sqrt(), upper: e.yi + z * e.vi.sqrt(), weight: 100.0 * w / total, subgroup: s.subgroup.clone() })
        .collect();
    // Subgroups: each pooled on its own (its own τ²), then a test for differences between them.
    let mut groups: BTreeMap<String, Vec<(&StudyData, Effect)>> = BTreeMap::new();
    for (s, e) in &used {
        if let Some(g) = s.subgroup.as_ref().filter(|g| !g.trim().is_empty()) {
            groups.entry(g.trim().to_string()).or_default().push((s, *e));
        }
    }
    let mut subgroups = Vec::new();
    if groups.len() > 1 {
        for (name, members) in &groups {
            let effects: Vec<Effect> = members.iter().map(|(_, e)| *e).collect();
            if let Ok(pooled) = pool(&effects, options.method, options.hartung_knapp, options.level) {
                subgroups.push(Subgroup { name: name.clone(), pooled, studies: members.iter().map(|(s, _)| s.id.clone()).collect() });
            }
        }
    }
    let subgroup_test = (subgroups.len() > 1).then(|| {
        let w: Vec<f64> = subgroups.iter().map(|g| 1.0 / (g.pooled.se * g.pooled.se)).collect();
        let sw: f64 = w.iter().sum();
        let mean = subgroups.iter().zip(&w).map(|(g, w)| w * g.pooled.estimate).sum::<f64>() / sw;
        let q: f64 = subgroups.iter().zip(&w).map(|(g, w)| w * (g.pooled.estimate - mean).powi(2)).sum();
        let df = subgroups.len() - 1;
        SubgroupTest { q, df, p: chisq_sf(q, df as f64) }
    });
    let leave_one_out = if used.len() > 2 {
        (0..used.len())
            .filter_map(|i| {
                let rest: Vec<Effect> = effects.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, e)| *e).collect();
                pool(&rest, options.method, options.hartung_knapp, options.level)
                    .ok()
                    .map(|p| LeaveOneOut { id: used[i].0.id.clone(), label: used[i].0.label.clone(), estimate: p.estimate, lower: p.lower, upper: p.upper, tau2: p.tau2, i2: p.i2 })
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(Analysis {
        measure: options.measure,
        measure_label: options.measure.label().into(),
        ratio: options.measure.is_ratio() || (options.measure == Measure::GEN && studies.iter().any(|s| s.ratio)),
        transform: if options.measure.is_ratio() || (options.measure == Measure::GEN && studies.iter().any(|s| s.ratio)) { "exp".into() } else { options.measure.transform().into() },
        harmonic_n: (options.measure == Measure::PFT && !used.is_empty()).then(|| used.len() as f64 / used.iter().filter_map(|(s, _)| s.n1).map(|n| 1.0 / n).sum::<f64>()),
        studies: studies_out,
        skipped,
        fixed,
        random,
        main,
        subgroups,
        subgroup_test,
        leave_one_out,
        egger: egger(&effects),
    })
}

/// The inverse of the Freeman–Tukey double arcsine for a sample size n (Miller 1978, Am Stat
/// 32:138; metafor's transf.ipft), clamped to 0 and 1 at the ends of the scale.
pub fn ipft(x: f64, n: f64) -> f64 {
    let pft = |p: f64| {
        let xi = p * n;
        0.5 * ((xi / (n + 1.0)).sqrt().asin() + ((xi + 1.0) / (n + 1.0)).sqrt().asin())
    };
    if x > pft(1.0) {
        return 1.0;
    }
    if x < pft(0.0) {
        return 0.0;
    }
    let s = (2.0 * x).sin();
    0.5 * (1.0 - (2.0 * x).cos().signum() * (1.0 - (s + (s - 1.0 / s) / n).powi(2)).sqrt())
}

/// A value on the analysis scale shown on the outcome's scale.
pub fn back_transform(v: f64, transform: &str, harmonic_n: Option<f64>) -> f64 {
    match transform {
        "exp" => v.exp(),
        "tanh" => v.tanh(),
        "expit" => 1.0 / (1.0 + (-v).exp()),
        "ipft" => ipft(v, harmonic_n.unwrap_or(1.0)),
        _ => v,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// metafor's `dat.bcg` (Colditz et al. 1994: BCG vaccine trials): tpos, tneg, cpos, cneg, alloc.
    const BCG: [(f64, f64, f64, f64, &str); 13] = [
        (4., 119., 11., 128., "random"),
        (6., 300., 29., 274., "random"),
        (3., 228., 11., 209., "random"),
        (62., 13536., 248., 12619., "random"),
        (33., 5036., 47., 5761., "alternate"),
        (180., 1361., 372., 1079., "alternate"),
        (8., 2537., 10., 619., "random"),
        (505., 87886., 499., 87892., "random"),
        (29., 7470., 45., 7232., "random"),
        (17., 1699., 65., 1600., "systematic"),
        (186., 50448., 141., 27197., "systematic"),
        (5., 2493., 3., 2338., "systematic"),
        (27., 16886., 29., 17825., "systematic"),
    ];

    fn bcg() -> Vec<StudyData> {
        BCG.iter()
            .enumerate()
            .map(|(i, (a, b, c, d, alloc))| StudyData { id: format!("s{i}"), label: format!("Trial {}", i + 1), e1: Some(*a), n1: Some(a + b), e2: Some(*c), n2: Some(c + d), subgroup: Some(alloc.to_string()), ..Default::default() })
            .collect()
    }

    /// metafor's `dat.normand1999` (stroke unit care, length of stay): m1, sd1, n1, m2, sd2, n2.
    const NORMAND: [(f64, f64, f64, f64, f64, f64); 9] = [
        (55., 47., 155., 75., 64., 156.),
        (27., 7., 31., 29., 4., 32.),
        (64., 17., 75., 119., 29., 71.),
        (66., 20., 18., 137., 48., 18.),
        (14., 8., 8., 18., 11., 13.),
        (19., 7., 57., 18., 4., 52.),
        (52., 45., 34., 41., 34., 33.),
        (21., 16., 110., 31., 27., 183.),
        (30., 27., 60., 23., 20., 52.),
    ];

    fn normand() -> Vec<StudyData> {
        NORMAND
            .iter()
            .enumerate()
            .map(|(i, (m1, sd1, n1, m2, sd2, n2))| StudyData { id: format!("n{i}"), label: format!("Study {}", i + 1), m1: Some(*m1), sd1: Some(*sd1), n1: Some(*n1), m2: Some(*m2), sd2: Some(*sd2), n2: Some(*n2), ..Default::default() })
            .collect()
    }

    fn close(a: f64, b: f64, tol: f64, what: &str) {
        assert!((a - b).abs() <= tol, "{what}: {a} vs {b}");
    }

    fn run(data: &[StudyData], measure: Measure, method: Method, hk: bool) -> Analysis {
        analyse(data, &Options { measure, method, hartung_knapp: hk, level: 0.95 }).unwrap()
    }

    // Reference values: metafor 5.2-1, `rma(ai=tpos, bi=tneg, ci=cpos, di=cneg, data=dat.bcg,
    // measure=..., method=...)` and `predict()`; the REML/RR numbers are the worked example in the
    // metafor documentation and Viechtbauer (2010).
    #[test]
    fn bcg_risk_ratio_matches_metafor() {
        let fe = run(&bcg(), Measure::RR, Method::Fe, false).main;
        close(fe.estimate, -0.430285163654, 1e-9, "FE estimate");
        close(fe.se, 0.0404987517109, 1e-9, "FE se");
        close(fe.q, 152.233008082, 1e-6, "Q");
        close(fe.i2, 92.1173468546, 1e-6, "FE I2");
        let dl = run(&bcg(), Measure::RR, Method::Dl, false).main;
        close(dl.estimate, -0.714117222073, 1e-9, "DL estimate");
        close(dl.se, 0.178742089535, 1e-9, "DL se");
        close(dl.tau2, 0.308760262862, 1e-9, "DL tau2");
        close(dl.i2, 92.1173468546, 1e-6, "DL I2");
        close(dl.pi_lower.unwrap(), -1.85815375273, 1e-8, "DL PI lower");
        close(dl.pi_upper.unwrap(), 0.429919308586, 1e-8, "DL PI upper");
        let reml = run(&bcg(), Measure::RR, Method::Reml, false).main;
        close(reml.estimate, -0.714532348365, 1e-7, "REML estimate");
        close(reml.se, 0.17978153178, 1e-7, "REML se");
        close(reml.tau2, 0.313243325981, 1e-7, "REML tau2");
        close(reml.i2, 92.221386075, 1e-5, "REML I2");
        close(reml.lower, -1.06689767574, 1e-7, "REML lower");
        close(reml.upper, -0.36216702099, 1e-7, "REML upper");
        close(reml.pi_lower.unwrap(), -1.86669234661, 1e-6, "REML PI lower");
        close(reml.pi_upper.unwrap(), 0.437627649877, 1e-6, "REML PI upper");
        // Hartung–Knapp: `test = "knha"`.
        let hk = run(&bcg(), Measure::RR, Method::Reml, true).main;
        close(hk.se, 0.180791745519, 1e-7, "HK se");
        close(hk.lower, -1.108443723, 1e-6, "HK lower");
        close(hk.upper, -0.32062097373, 1e-6, "HK upper");
        close(hk.p, 0.00192001508513, 1e-8, "HK p");
        close(hk.pi_lower.unwrap(), -1.99601696702, 1e-6, "HK PI lower");
        close(hk.pi_upper.unwrap(), 0.566952270292, 1e-6, "HK PI upper");
    }

    #[test]
    fn bcg_odds_ratio_and_risk_difference_match_metafor() {
        let or = run(&bcg(), Measure::OR, Method::Dl, false).main;
        close(or.estimate, -0.747392349732, 1e-9, "OR DL");
        close(or.tau2, 0.366343406726, 1e-9, "OR DL tau2");
        let or = run(&bcg(), Measure::OR, Method::Reml, false).main;
        close(or.estimate, -0.745177771837, 1e-7, "OR REML");
        close(or.tau2, 0.337772045077, 1e-7, "OR REML tau2");
        let rd = run(&bcg(), Measure::RD, Method::Dl, false).main;
        close(rd.estimate, -0.0070552635661, 1e-10, "RD DL");
        close(rd.se, 0.00156339020719, 1e-10, "RD DL se");
        close(rd.q, 276.473712704, 1e-5, "RD Q");
        let rd = run(&bcg(), Measure::RD, Method::Reml, false).main;
        // metafor's default REML threshold (1e-5) stops early on these tiny variances; these are
        // its values with `control = list(threshold = 1e-14)`.
        close(rd.estimate, -0.025173288143291, 1e-9, "RD REML");
        close(rd.tau2, 0.0014214030956741, 1e-10, "RD REML tau2");
    }

    #[test]
    fn zero_cells_get_the_half_correction() {
        // escalc(measure=..., ai=c(0,3), bi=c(10,7), ci=c(2,1), di=c(8,9))
        let s = |a: f64, b: f64, c: f64, d: f64| StudyData { label: "x".into(), e1: Some(a), n1: Some(a + b), e2: Some(c), n2: Some(c + d), ..Default::default() };
        let or = effect(&s(0., 10., 2., 8.), Measure::OR).unwrap();
        close(or.yi, -1.8207470061, 1e-9, "OR yi");
        close(or.vi, 2.61288515406, 1e-9, "OR vi");
        let rr = effect(&s(0., 10., 2., 8.), Measure::RR).unwrap();
        close(rr.yi, -1.60943791243, 1e-9, "RR yi");
        close(rr.vi, 2.21818181818, 1e-9, "RR vi");
        let rd = effect(&s(0., 10., 2., 8.), Measure::RD).unwrap();
        close(rd.yi, -0.181818181818, 1e-9, "RD yi");
        close(rd.vi, 0.0199098422239, 1e-9, "RD vi");
        let or2 = effect(&s(3., 7., 1., 9.), Measure::OR).unwrap();
        close(or2.yi, 1.34992671695, 1e-9, "OR yi no zero");
    }

    #[test]
    fn continuous_outcomes_match_metafor() {
        // rma(m1i, sd1i, n1i, m2i, sd2i, n2i, data = dat.normand1999, measure = "MD" / "SMD").
        let md = run(&normand(), Measure::MD, Method::Reml, false).main;
        close(md.estimate, -15.1060274744, 1e-5, "MD");
        close(md.se, 8.94655284569, 1e-5, "MD se");
        close(md.tau2, 684.646152882, 1e-3, "MD tau2");
        close(md.q, 238.915810862, 1e-6, "MD Q");
        let e = effect(&normand()[0], Measure::SMD).unwrap();
        close(e.yi, -0.35516964094, 1e-9, "g1");
        close(e.vi, 0.0130646755415, 1e-9, "v1");
        let smd = run(&normand(), Measure::SMD, Method::Reml, false).main;
        close(smd.estimate, -0.537108258567, 1e-6, "SMD");
        close(smd.se, 0.308661491598, 1e-6, "SMD se");
        close(smd.tau2, 0.790842921048, 1e-6, "SMD tau2");
        close(smd.i2, 95.4949371131, 1e-4, "SMD I2");
    }

    #[test]
    fn egger_subgroups_leave_one_out_and_generic() {
        let a = run(&bcg(), Measure::RR, Method::Dl, false);
        // regtest(rma(..., method = "DL"), model = "lm")
        let e = a.egger.unwrap();
        close(e.t, -1.40128200229, 1e-7, "Egger t");
        close(e.p, 0.188706995082, 1e-7, "Egger p");
        assert_eq!(e.df, 11);
        close(e.limit, -0.19092864236, 1e-7, "Egger limit");
        // leave1out(): first trial left out.
        close(a.leave_one_out[0].estimate, -0.705125198417, 1e-8, "LOO estimate");
        close(a.leave_one_out[0].tau2, 0.312171499041, 1e-8, "LOO tau2");
        // rma(..., subset = alloc == g), DL.
        let get = |n: &str| a.subgroups.iter().find(|g| g.name == n).unwrap().pooled.clone();
        close(get("random").estimate, -1.004161354, 1e-8, "random");
        close(get("alternate").estimate, -0.540792961849, 1e-8, "alternate");
        close(get("systematic").tau2, 0.284970681807, 1e-8, "systematic tau2");
        assert_eq!(a.subgroup_test.as_ref().unwrap().df, 2);
        // Generic inverse variance from the same yi and SE gives the same pooled result.
        let generic: Vec<StudyData> = bcg()
            .iter()
            .map(|s| {
                let e = effect(s, Measure::RR).unwrap();
                StudyData { id: s.id.clone(), label: s.label.clone(), estimate: Some(e.yi.exp()), se: Some(e.vi.sqrt()), ratio: true, ..Default::default() }
            })
            .collect();
        let g = run(&generic, Measure::GEN, Method::Dl, false).main;
        close(g.estimate, -0.714117222073, 1e-9, "generic DL");
        assert!(run(&generic, Measure::GEN, Method::Dl, false).ratio);
    }

    // std-D: escalc() in metafor 5.2-1 run locally on invented values (inputs in each call):
    // PCOR (ti, ni, mi), ZCOR/COR (ri, ni), ROM, IRR (x, t), PLO/PFT (xi, ni), SMCR (m1i post,
    // m2i pre, sd1i pre, ni, ri). Tolerance 1e-12.
    #[test]
    fn more_effect_sizes_match_escalc() {
        let e = |s: StudyData, m: Measure| effect(&StudyData { label: "x".into(), ..s }, m).unwrap();
        let pc = e(StudyData { t: Some(2.5), df: Some(120.0 - 4.0 - 1.0), ..Default::default() }, Measure::PCOR);
        close(pc.yi, 0.22703830459324992, 1e-12, "PCOR yi");
        close(pc.vi, 0.00775486419825479, 1e-12, "PCOR vi");
        let pc2 = e(StudyData { t: Some(-1.2), df: Some(60.0 - 2.0 - 1.0), ..Default::default() }, Measure::PCOR);
        close(pc2.vi, 0.0164021697898821, 1e-12, "PCOR vi 2");
        // Stanley & Doucouliagos' SE: √((1 − r²)/df), checked by arithmetic.
        let sd = e(StudyData { t: Some(2.5), df: Some(115.0), ..Default::default() }, Measure::PCORSD);
        close(sd.vi, (1.0 - pc.yi * pc.yi) / 115.0, 1e-15, "PCOR S&D vi");
        let z = e(StudyData { r: Some(0.3), n1: Some(50.0), ..Default::default() }, Measure::ZCOR);
        close(z.yi, 0.3095196042031118, 1e-12, "ZCOR yi");
        close(z.vi, 0.0212765957446809, 1e-12, "ZCOR vi");
        let c = e(StudyData { r: Some(-0.1), n1: Some(200.0), ..Default::default() }, Measure::COR);
        close(c.vi, 0.0049251256281407, 1e-12, "COR vi");
        let rom = e(StudyData { m1: Some(10.0), sd1: Some(2.0), n1: Some(30.0), m2: Some(8.0), sd2: Some(2.5), n2: Some(28.0), ..Default::default() }, Measure::ROM);
        close(rom.yi, 0.22206635637373356, 1e-12, "ROM yi");
        close(rom.vi, 0.00482105654761905, 1e-12, "ROM vi");
        let irr = e(StudyData { e1: Some(0.0), time1: Some(500.0), e2: Some(4.0), time2: Some(480.0), ..Default::default() }, Measure::IRR);
        close(irr.yi, -2.23804657185647, 1e-12, "IRR yi zero");
        close(irr.vi, 2.22222222222222, 1e-12, "IRR vi zero");
        let irr = e(StudyData { e1: Some(12.0), time1: Some(1000.0), e2: Some(20.0), time2: Some(1100.0), ..Default::default() }, Measure::IRR);
        close(irr.yi, -0.415515443961666, 1e-12, "IRR yi");
        let plo = e(StudyData { e1: Some(0.0), n1: Some(40.0), ..Default::default() }, Measure::PLO);
        close(plo.yi, -4.39444915467244, 1e-12, "PLO yi zero");
        close(plo.vi, 2.02469135802469, 1e-12, "PLO vi zero");
        let pft = e(StudyData { e1: Some(15.0), n1: Some(60.0), ..Default::default() }, Measure::PFT);
        close(pft.yi, 0.52826828837943030, 1e-12, "PFT yi");
        close(pft.vi, 0.00413223140495868, 1e-12, "PFT vi");
        let smcr = e(StudyData { m1: Some(12.0), m2: Some(10.0), sd1: Some(3.0), n1: Some(25.0), r: Some(0.6), ..Default::default() }, Measure::SMCR);
        close(smcr.yi, 0.645576822298478, 1e-12, "SMCR yi");
        close(smcr.vi, 0.040335388669780, 1e-12, "SMCR vi");
        let hr = e(StudyData { estimate: Some(0.8), lower: Some(0.6), upper: Some(1.1), ..Default::default() }, Measure::HR);
        close(hr.yi, 0.8f64.ln(), 1e-15, "HR log");
    }

    // rma() on escalc("PFT"/"PLO", xi = c(15, 3, 40, 8), ni = c(60, 40, 150, 50)) and
    // transf.ipft.hm()/transf.ilogit() of the estimate and interval, metafor 5.2-1 run locally.
    #[test]
    fn proportions_back_transform_like_metafor() {
        let data: Vec<StudyData> = [(15., 60.), (3., 40.), (40., 150.), (8., 50.)].iter().map(|(x, n)| StudyData { label: "p".into(), e1: Some(*x), n1: Some(*n), ..Default::default() }).collect();
        let a = run(&data, Measure::PFT, Method::Reml, false);
        close(a.main.estimate, 0.458958935143211, 1e-8, "PFT pooled");
        let hn = a.harmonic_n;
        assert_eq!(a.transform, "ipft");
        close(back_transform(a.main.estimate, "ipft", hn), 0.191142524551338, 1e-8, "PFT back");
        close(back_transform(a.main.lower, "ipft", hn), 0.111711692499405, 1e-8, "PFT back lb");
        close(back_transform(a.main.upper, "ipft", hn), 0.284999257136760, 1e-8, "PFT back ub");
        let a = run(&data, Measure::PLO, Method::Reml, false);
        close(back_transform(a.main.estimate, &a.transform, None), 0.200081398974198, 1e-8, "PLO back");
        close(back_transform(a.main.upper, &a.transform, None), 0.296671397088986, 1e-8, "PLO back ub");
    }

    #[test]
    fn missing_data_is_skipped_with_a_reason() {
        let mut data = bcg();
        data[0].e1 = None;
        let a = run(&data, Measure::RR, Method::Dl, false);
        assert_eq!(a.studies.len(), 12);
        assert!(a.skipped[0].1.contains("missing"));
    }
}
