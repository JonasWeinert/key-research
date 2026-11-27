// Data conversions for extraction: when a paper reports something other than what the analysis
// needs ("I have a median and IQR"), compute the missing value and record how. Every result
// carries the method, its formula in words and the source, and the extraction stores it with the
// value (`_conversions` on the outcome row), so exports and the methods text can report it.
//
// Sources:
// - SE, CI, t and p: Cochrane Handbook (version 6.5, 2024), chapter 6, section 6.3 and 6.5.2
//   (obtaining SDs from standard errors, confidence intervals, t statistics and P values; t with
//   n − 1 df below 60 participants); ratios on the log scale (section 6.3.2).
// - Mean and SD from the median with the IQR and/or range: Luo et al. (2018, Stat Methods Med Res
//   27:1785) for the mean, Wan et al. (2014, BMC Med Res Methodol 14:135) and Shi et al. (2020,
//   Res Synth Methods 11:641) for the SD, the normal-distribution estimators as implemented in
//   metafor's conv.fivenum(); the skewness check is Shi et al. (2023, Stat Methods Med Res
//   32:1338), also as in conv.fivenum().
// - Change-from-baseline SD with an assumed correlation and the correlation implied by a study
//   that reports all three SDs: Cochrane Handbook section 6.5.2.8.
// - Combining two groups: Cochrane Handbook Table 6.5.a.
// - Multi-arm trials (splitting a shared comparison group, or combining arms): Cochrane Handbook
//   section 23.3.4. Cluster trials (design effect 1 + (M − 1) ICC, effective sample size):
//   Cochrane Handbook section 23.1.4.
// The tests check metafor's conv.fivenum() and R arithmetic.
use crate::stats::{norm_quantile, t_quantile};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConvertRequest {
    pub kind: String,
    pub inputs: BTreeMap<String, f64>,
    /// "1" (intervention) or "2" (comparison): which outcome columns a group value fills.
    pub group: String,
    /// Values are ratios (OR, RR, HR): work on the log scale.
    pub ratio: bool,
    /// Confidence level of a reported interval (0.95).
    pub level: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversion {
    pub kind: String,
    /// Short name ("SD from IQR (Wan et al. 2014)").
    pub method: String,
    /// The formula in words.
    pub formula: String,
    pub citation: String,
    pub inputs: BTreeMap<String, f64>,
    /// Computed values by name (sd, mean, se …).
    pub outputs: BTreeMap<String, f64>,
    /// Outcome-table columns to fill (sd1, m1, se …).
    pub fill: BTreeMap<String, f64>,
    pub warnings: Vec<String>,
}

const HANDBOOK6: &str = "Cochrane Handbook for Systematic Reviews of Interventions, version 6.5 (2024), chapter 6";
const HANDBOOK23: &str = "Cochrane Handbook for Systematic Reviews of Interventions, version 6.5 (2024), chapter 23";

/// The conversions the helper offers, for the UI: (kind, title, inputs).
pub fn catalogue() -> Vec<(&'static str, &'static str, &'static [&'static str])> {
    vec![
        ("mean-sd-from-median-iqr", "Median and IQR → mean and SD", &["median", "q1", "q3", "n"]),
        ("mean-sd-from-median-range", "Median and range → mean and SD", &["median", "min", "max", "n"]),
        ("mean-sd-from-five", "Median, IQR and range → mean and SD", &["median", "q1", "q3", "min", "max", "n"]),
        ("sd-from-se", "SE of a mean → SD", &["se", "n"]),
        ("sd-from-ci", "95% CI of a mean → SD", &["lower", "upper", "n"]),
        ("se-from-ci", "Estimate's CI → SE", &["estimate", "lower", "upper"]),
        ("se-from-p", "Estimate and p-value → SE", &["estimate", "p"]),
        ("se-from-t", "Estimate and t statistic → SE", &["estimate", "t"]),
        ("ci-from-se", "Estimate and SE → CI and p", &["estimate", "se"]),
        ("sd-change", "Change-from-baseline SD (assumed correlation)", &["sdBaseline", "sdFinal", "r"]),
        ("correlation-from-change", "Correlation implied by baseline, final and change SDs", &["sdBaseline", "sdFinal", "sdChange"]),
        ("combine-groups", "Combine two groups (means and SDs, or events)", &["n1", "m1", "sd1", "n2", "m2", "sd2"]),
        ("events-from-percent", "Percentage → number of events", &["percent", "n"]),
        ("split-shared-group", "Multi-arm trial: split a shared comparison group", &["n", "comparisons"]),
        ("cluster-adjust", "Cluster trial: effective sample size", &["n", "clusterSize", "icc"]),
    ]
}

fn need(inputs: &BTreeMap<String, f64>, k: &str) -> Result<f64, String> {
    inputs.get(k).copied().filter(|v| v.is_finite()).ok_or_else(|| format!("Enter {}", label(k)))
}

fn label(k: &str) -> &str {
    match k {
        "q1" => "the first quartile",
        "q3" => "the third quartile",
        "min" => "the minimum",
        "max" => "the maximum",
        "n" => "the number of participants",
        "se" => "the standard error",
        "lower" => "the lower limit",
        "upper" => "the upper limit",
        "estimate" => "the estimate",
        "p" => "the p-value",
        "t" => "the t statistic",
        "r" => "the correlation",
        "sdBaseline" => "the baseline SD",
        "sdFinal" => "the final SD",
        "sdChange" => "the SD of the change",
        "percent" => "the percentage",
        "comparisons" => "the number of comparisons",
        "clusterSize" => "the average cluster size",
        "icc" => "the intracluster correlation",
        other => other,
    }
}

/// Wan et al.'s ξ(n) and η(n): expected range and IQR of n standard normal draws.
fn xi(n: f64) -> f64 {
    2.0 * norm_quantile((n - 0.375) / (n + 0.25))
}
fn eta(n: f64) -> f64 {
    2.0 * norm_quantile((0.75 * n - 0.125) / (n + 0.25))
}

pub fn convert(req: &ConvertRequest) -> Result<Conversion, String> {
    let i = &req.inputs;
    let g = if req.group == "2" { "2" } else { "1" };
    let mut out = BTreeMap::new();
    let mut fill = BTreeMap::new();
    let mut warnings = Vec::new();
    let level = req.level.unwrap_or(0.95);
    let z = norm_quantile(1.0 - (1.0 - level) / 2.0);
    let scale = |v: f64| if req.ratio { v.ln() } else { v };
    let (method, formula, citation): (String, String, String) = match req.kind.as_str() {
        "mean-sd-from-median-iqr" | "mean-sd-from-median-range" | "mean-sd-from-five" => {
            let (med, n) = (need(i, "median")?, need(i, "n")?);
            if n < 2.0 {
                return Err("Needs at least 2 participants".into());
            }
            let five = req.kind == "mean-sd-from-five";
            let (mean, sd, t, crit, m_text, s_text, cite) = if req.kind == "mean-sd-from-median-iqr" {
                let (q1, q3) = (need(i, "q1")?, need(i, "q3")?);
                if !(q1 <= med && med <= q3 && q1 < q3) {
                    return Err("The quartiles must surround the median".into());
                }
                let w = 0.7 + 0.39 / n;
                (w * (q1 + q3) / 2.0 + (1.0 - w) * med, (q3 - q1) / eta(n), ((q1 + q3 - 2.0 * med) / (q3 - q1)).abs(), 2.65 / n.sqrt() - 6.0 / n.powi(2), "mean = w (q1 + q3)/2 + (1 − w) median, w = 0.7 + 0.39/n", "SD = (q3 − q1) / η(n), η(n) = 2 Φ⁻¹((0.75n − 0.125)/(n + 0.25))", "Luo et al. 2018 (mean); Wan et al. 2014 (SD)")
            } else if !five {
                let (lo, hi) = (need(i, "min")?, need(i, "max")?);
                if !(lo <= med && med <= hi && lo < hi) {
                    return Err("The range must surround the median".into());
                }
                let w = 4.0 / (4.0 + n.powf(0.75));
                (w * (lo + hi) / 2.0 + (1.0 - w) * med, (hi - lo) / xi(n), ((lo + hi - 2.0 * med) / (hi - lo)).abs(), 1.0 / (n + 9.0).ln() + 2.5 / (n + 1.0), "mean = w (min + max)/2 + (1 − w) median, w = 4/(4 + n^0.75)", "SD = (max − min) / ξ(n), ξ(n) = 2 Φ⁻¹((n − 0.375)/(n + 0.25))", "Luo et al. 2018 (mean); Wan et al. 2014 (SD)")
            } else {
                let (q1, q3, lo, hi) = (need(i, "q1")?, need(i, "q3")?, need(i, "min")?, need(i, "max")?);
                if !(lo <= q1 && q1 <= med && med <= q3 && q3 <= hi && q1 < q3) {
                    return Err("The values must be in order: minimum, first quartile, median, third quartile, maximum".into());
                }
                let w1 = 2.2 / (2.2 + n.powf(0.75));
                let w2 = 0.7 - 0.72 / n.powf(0.55);
                let ws = 1.0 / (1.0 + 0.07 * n.powf(0.6));
                let t = (2.65 * (0.6 * n).ln() / n.sqrt() * ((lo + hi - 2.0 * med) / (hi - lo)).abs()).max(((q1 + q3 - 2.0 * med) / (q3 - q1)).abs());
                (
                    w1 * (lo + hi) / 2.0 + w2 * (q1 + q3) / 2.0 + (1.0 - w1 - w2) * med,
                    ws * (hi - lo) / xi(n) + (1.0 - ws) * (q3 - q1) / eta(n),
                    t,
                    3.0 / n.sqrt() - 40.0 / n.powi(3),
                    "mean = w1 (min + max)/2 + w2 (q1 + q3)/2 + (1 − w1 − w2) median, w1 = 2.2/(2.2 + n^0.75), w2 = 0.7 − 0.72/n^0.55",
                    "SD = w (max − min)/ξ(n) + (1 − w)(q3 − q1)/η(n), w = 1/(1 + 0.07 n^0.6)",
                    "Luo et al. 2018 (mean); Shi et al. 2020 (SD)",
                )
            };
            if t >= crit {
                warnings.push("The median is far from the middle of the quartiles or range: the data look skewed (Shi et al. 2023's test), and these estimates assume a roughly normal distribution. Consider leaving this study out in a sensitivity analysis.".into());
            }
            out.insert("mean".into(), mean);
            out.insert("sd".into(), sd);
            fill.insert(format!("m{g}"), mean);
            fill.insert(format!("sd{g}"), sd);
            fill.insert(format!("n{g}"), n);
            (format!("Mean and SD from the median ({cite})"), format!("{m_text}; {s_text}"), format!("{cite}; as in metafor's conv.fivenum()"))
        }
        "sd-from-se" => {
            let (se, n) = (need(i, "se")?, need(i, "n")?);
            let sd = se * n.sqrt();
            out.insert("sd".into(), sd);
            fill.insert(format!("sd{g}"), sd);
            fill.insert(format!("n{g}"), n);
            ("SD from the SE of a mean".into(), "SD = SE × √n".into(), format!("{HANDBOOK6}, section 6.5.2.2"))
        }
        "sd-from-ci" => {
            let (lo, hi, n) = (need(i, "lower")?, need(i, "upper")?, need(i, "n")?);
            if hi <= lo || n < 2.0 {
                return Err("Needs an interval with the upper limit above the lower one and at least 2 participants".into());
            }
            let small = n < 60.0;
            let crit = if small { t_quantile(1.0 - (1.0 - level) / 2.0, n - 1.0) } else { z };
            let sd = n.sqrt() * (hi - lo) / (2.0 * crit);
            out.insert("sd".into(), sd);
            fill.insert(format!("sd{g}"), sd);
            fill.insert(format!("n{g}"), n);
            ("SD from the CI of a mean".into(), if small { format!("SD = √n × (upper − lower) / (2 × t), t with n − 1 df (= {crit:.4}) because n < 60") } else { format!("SD = √n × (upper − lower) / (2 × {crit:.4})") }, format!("{HANDBOOK6}, section 6.5.2.2"))
        }
        "se-from-ci" => {
            let (lo, hi) = (need(i, "lower")?, need(i, "upper")?);
            if hi <= lo || (req.ratio && lo <= 0.0) {
                return Err("Needs an interval with the upper limit above the lower one (above 0 for ratios)".into());
            }
            let se = (scale(hi) - scale(lo)) / (2.0 * z);
            out.insert("se".into(), se);
            fill.insert("se".into(), se);
            if let Some(e) = i.get("estimate") {
                fill.insert("estimate".into(), *e);
            }
            fill.insert("lower".into(), lo);
            fill.insert("upper".into(), hi);
            ("SE from a confidence interval".into(), format!("SE = ({}upper − {}lower) / (2 × {z:.4})", if req.ratio { "ln " } else { "" }, if req.ratio { "ln " } else { "" }), format!("{HANDBOOK6}, sections 6.3.1 and 6.3.2"))
        }
        "se-from-p" => {
            let (e, p) = (need(i, "estimate")?, need(i, "p")?);
            if !(0.0 < p && p < 1.0) {
                return Err("The p-value must be between 0 and 1".into());
            }
            if req.ratio && e <= 0.0 {
                return Err("A ratio must be above 0".into());
            }
            let df = i.get("df").copied();
            let crit = match df {
                Some(df) if df > 0.0 => t_quantile(1.0 - p / 2.0, df),
                _ => norm_quantile(1.0 - p / 2.0),
            };
            let se = scale(e).abs() / crit;
            if p >= 0.05 && i.get("exact").copied().unwrap_or(1.0) == 0.0 {
                warnings.push("A p-value reported only as a threshold (\"p > 0.05\") gives no SE; use the exact value.".into());
            }
            out.insert("se".into(), se);
            fill.insert("estimate".into(), e);
            fill.insert("se".into(), se);
            ("SE from a two-sided p-value".into(), format!("SE = |{}estimate| / {} quantile at 1 − p/2 (= {crit:.4})", if req.ratio { "ln " } else { "" }, if df.is_some() { "t" } else { "normal" }), format!("{HANDBOOK6}, section 6.3.2"))
        }
        "se-from-t" => {
            let (e, t) = (need(i, "estimate")?, need(i, "t")?);
            if t == 0.0 {
                return Err("A t statistic of 0 gives no SE".into());
            }
            let se = (scale(e) / t).abs();
            out.insert("se".into(), se);
            fill.insert("estimate".into(), e);
            fill.insert("se".into(), se);
            ("SE from a t statistic".into(), "SE = |estimate / t|".into(), format!("{HANDBOOK6}, section 6.3.2"))
        }
        "ci-from-se" => {
            let (e, se) = (need(i, "estimate")?, need(i, "se")?);
            let y = scale(e);
            let (lo, hi) = (y - z * se, y + z * se);
            let (lo, hi) = if req.ratio { (lo.exp(), hi.exp()) } else { (lo, hi) };
            out.insert("lower".into(), lo);
            out.insert("upper".into(), hi);
            out.insert("p".into(), crate::stats::norm_p2(y / se));
            fill.insert("estimate".into(), e);
            fill.insert("se".into(), se);
            fill.insert("lower".into(), lo);
            fill.insert("upper".into(), hi);
            ("CI and p from an SE".into(), format!("CI = estimate ± {z:.4} × SE{}; p from z = estimate / SE", if req.ratio { " on the log scale" } else { "" }), format!("{HANDBOOK6}, section 6.3.1"))
        }
        "sd-change" => {
            let (b, f, r) = (need(i, "sdBaseline")?, need(i, "sdFinal")?, need(i, "r")?);
            if !(-1.0..=1.0).contains(&r) {
                return Err("The correlation must be between −1 and 1".into());
            }
            let sd = (b * b + f * f - 2.0 * r * b * f).sqrt();
            out.insert("sd".into(), sd);
            fill.insert(format!("sd{g}"), sd);
            warnings.push("The correlation is assumed: report it and try other values in a sensitivity analysis.".into());
            ("Change-from-baseline SD with an assumed correlation".into(), format!("SD_change = √(SD_baseline² + SD_final² − 2 × {r} × SD_baseline × SD_final)"), format!("{HANDBOOK6}, section 6.5.2.8"))
        }
        "correlation-from-change" => {
            let (b, f, c) = (need(i, "sdBaseline")?, need(i, "sdFinal")?, need(i, "sdChange")?);
            let r = (b * b + f * f - c * c) / (2.0 * b * f);
            if !(-1.0..=1.0).contains(&r) {
                warnings.push("These SDs imply a correlation outside −1 to 1; check them.".into());
            }
            out.insert("r".into(), r);
            fill.insert("r".into(), r);
            ("Correlation implied by baseline, final and change SDs".into(), "r = (SD_baseline² + SD_final² − SD_change²) / (2 × SD_baseline × SD_final)".into(), format!("{HANDBOOK6}, section 6.5.2.8"))
        }
        "combine-groups" => {
            let (n1, n2) = (need(i, "n1")?, need(i, "n2")?);
            let n = n1 + n2;
            fill.insert(format!("n{g}"), n);
            out.insert("n".into(), n);
            if let (Some(e1), Some(e2)) = (i.get("e1"), i.get("e2")) {
                out.insert("events".into(), e1 + e2);
                fill.insert(format!("e{g}"), e1 + e2);
            }
            if let (Some(m1), Some(m2), Some(s1), Some(s2)) = (i.get("m1"), i.get("m2"), i.get("sd1"), i.get("sd2")) {
                let m = (n1 * m1 + n2 * m2) / n;
                let sd = (((n1 - 1.0) * s1 * s1 + (n2 - 1.0) * s2 * s2 + n1 * n2 / n * (m1 - m2).powi(2)) / (n - 1.0)).sqrt();
                out.insert("mean".into(), m);
                out.insert("sd".into(), sd);
                fill.insert(format!("m{g}"), m);
                fill.insert(format!("sd{g}"), sd);
            } else if !out.contains_key("events") {
                return Err("Enter means and SDs, or events, for both groups".into());
            }
            warnings.push("Combining arms into one group: count each participant once, and do not also use these arms separately in the same analysis.".into());
            ("Two groups combined into one".into(), "N = N₁ + N₂; M = (N₁M₁ + N₂M₂)/N; SD = √(((N₁ − 1)SD₁² + (N₂ − 1)SD₂² + N₁N₂/N (M₁ − M₂)²) / (N − 1)); events added".into(), format!("{HANDBOOK6}, Table 6.5.a; {HANDBOOK23}, section 23.3.4"))
        }
        "events-from-percent" => {
            let (pct, n) = (need(i, "percent")?, need(i, "n")?);
            if !(0.0..=100.0).contains(&pct) {
                return Err("The percentage must be between 0 and 100".into());
            }
            let exact = pct / 100.0 * n;
            let e = exact.round();
            if (exact - e).abs() > 0.05 {
                warnings.push(format!("{pct}% of {n} is {exact:.2}, rounded to {e}; check the denominator the percentage was taken of."));
            }
            out.insert("events".into(), e);
            fill.insert(format!("e{g}"), e);
            fill.insert(format!("n{g}"), n);
            ("Events from a percentage".into(), "events = round(percentage / 100 × n)".into(), format!("{HANDBOOK6}, section 6.4"))
        }
        "split-shared-group" => {
            let (n, k) = (need(i, "n")?, need(i, "comparisons")?);
            if k < 2.0 {
                return Err("A shared group is split across at least 2 comparisons".into());
            }
            out.insert("n".into(), n / k);
            fill.insert(format!("n{g}"), (n / k).floor().max(1.0));
            if let Some(e) = i.get("events") {
                out.insert("events".into(), e / k);
                fill.insert(format!("e{g}"), (e / k).round());
            }
            warnings.push("Splitting keeps the shared group's mean and SD and divides its participants (and events) between the comparisons, so it is not counted twice; the comparisons are still correlated, which a multilevel model or combining the arms handles more fully.".into());
            ("Multi-arm trial: shared comparison group split".into(), format!("n per comparison = n / {k}; events per comparison = events / {k}"), format!("{HANDBOOK23}, section 23.3.4"))
        }
        "cluster-adjust" => {
            let (n, m, icc) = (need(i, "n")?, need(i, "clusterSize")?, need(i, "icc")?);
            if m < 1.0 || !(0.0..1.0).contains(&icc) {
                return Err("Needs an average cluster size of 1 or more and an ICC from 0 to below 1".into());
            }
            let de = 1.0 + (m - 1.0) * icc;
            out.insert("designEffect".into(), de);
            out.insert("n".into(), n / de);
            fill.insert(format!("n{g}"), (n / de).round().max(1.0));
            if let Some(e) = i.get("events") {
                out.insert("events".into(), e / de);
                fill.insert(format!("e{g}"), (e / de).round());
            }
            warnings.push("Use this only when the trial was analysed as if individuals were randomised; report the ICC you assumed and its source.".into());
            ("Cluster trial: effective sample size".into(), format!("design effect = 1 + (M − 1) × ICC = {de:.4}; effective n = n / design effect (events likewise)"), format!("{HANDBOOK23}, section 23.1.4"))
        }
        other => return Err(format!("Unknown conversion {other}")),
    };
    Ok(Conversion { kind: req.kind.clone(), method, formula, citation, inputs: req.inputs.clone(), outputs: out, fill, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(kind: &str, kv: &[(&str, f64)]) -> ConvertRequest {
        ConvertRequest { kind: kind.into(), inputs: kv.iter().map(|(k, v)| (k.to_string(), *v)).collect(), group: "1".into(), ratio: false, level: None }
    }

    fn close(a: f64, b: f64, tol: f64, what: &str) {
        assert!((a - b).abs() <= tol * (1.0 + b.abs()), "{what}: {a} vs {b}");
    }

    // metafor 5.2-1 conv.fivenum(min = c(2, NA, 1), q1 = c(NA, 4, 3), median = c(6, 6, 5),
    // q3 = c(NA, 9, 8), max = c(15, NA, 14), n = c(20, 35, 60), test = FALSE) run locally
    // (default method "luo/wan/shi", normal distribution). Tolerance 1e-12.
    #[test]
    fn median_conversions_match_conv_fivenum() {
        let a = convert(&req("mean-sd-from-median-range", &[("min", 2.0), ("median", 6.0), ("max", 15.0), ("n", 20.0)])).unwrap();
        close(a.outputs["mean"], 6.74308470014591, 1e-12, "range mean");
        close(a.outputs["sd"], 3.47920729798384, 1e-12, "range sd");
        assert_eq!(a.fill["sd1"], a.outputs["sd"]);
        let b = convert(&req("mean-sd-from-median-iqr", &[("q1", 4.0), ("median", 6.0), ("q3", 9.0), ("n", 35.0)])).unwrap();
        close(b.outputs["mean"], 6.35557142857143, 1e-12, "iqr mean");
        close(b.outputs["sd"], 3.86489721703034, 1e-12, "iqr sd");
        let c = convert(&req("mean-sd-from-five", &[("min", 1.0), ("q1", 3.0), ("median", 5.0), ("q3", 8.0), ("max", 14.0), ("n", 60.0)])).unwrap();
        close(c.outputs["mean"], 5.54362647054714, 1e-12, "five mean");
        close(c.outputs["sd"], 3.25448273423313, 1e-12, "five sd");
        // conv.fivenum(test = TRUE) leaves the third study out as skewed; the first two pass.
        assert!(c.warnings.iter().any(|w| w.contains("skewed")));
        assert!(a.warnings.is_empty() && b.warnings.is_empty());
    }

    // R arithmetic run locally (qt(0.975, 24) = 2.06389856162803, qnorm(0.975) =
    // 1.95996398454005) for the Cochrane Handbook formulas.
    #[test]
    fn handbook_formulas() {
        let s = convert(&req("sd-from-ci", &[("lower", 30.0), ("upper", 34.2), ("n", 25.0)])).unwrap();
        close(s.outputs["sd"], 5.08745933313578, 1e-9, "sd from ci (t)");
        let s = convert(&req("sd-from-ci", &[("lower", 30.0), ("upper", 34.2), ("n", 100.0)])).unwrap();
        close(s.outputs["sd"], 10.71448259541774, 1e-9, "sd from ci (z)");
        let mut r = req("se-from-ci", &[("estimate", 1.5), ("lower", 1.1), ("upper", 2.1)]);
        r.ratio = true;
        close(convert(&r).unwrap().outputs["se"], 0.1649589405788997, 1e-9, "se from ratio ci");
        close(convert(&req("se-from-p", &[("estimate", 0.4), ("p", 0.03)])).unwrap().outputs["se"], 0.1843241203830524, 1e-9, "se from p");
        close(convert(&req("se-from-p", &[("estimate", 0.4), ("p", 0.03), ("df", 40.0)])).unwrap().outputs["se"], 0.1777563372959287, 1e-9, "se from p, t");
        close(convert(&req("sd-change", &[("sdBaseline", 4.1), ("sdFinal", 4.5), ("r", 0.6)])).unwrap().outputs["sd"], 3.86264158316559, 1e-12, "sd change");
        close(convert(&req("correlation-from-change", &[("sdBaseline", 4.1), ("sdFinal", 4.5), ("sdChange", 3.8)])).unwrap().outputs["r"], 0.613008130081301, 1e-12, "r");
        let c = convert(&req("combine-groups", &[("n1", 30.0), ("m1", 12.5), ("sd1", 3.2), ("n2", 25.0), ("m2", 10.1), ("sd2", 2.9)])).unwrap();
        close(c.outputs["mean"], 11.4090909090909, 1e-12, "combined mean");
        close(c.outputs["sd"], 3.2697985399077, 1e-12, "combined sd");
        let k = convert(&req("cluster-adjust", &[("n", 400.0), ("clusterSize", 20.0), ("icc", 0.05), ("events", 60.0)])).unwrap();
        close(k.outputs["designEffect"], 1.95, 1e-12, "design effect");
        close(k.outputs["n"], 400.0 / 1.95, 1e-12, "effective n");
        assert_eq!(k.fill["e1"], (60.0f64 / 1.95).round());
        let sp = convert(&ConvertRequest { group: "2".into(), ..req("split-shared-group", &[("n", 90.0), ("comparisons", 2.0), ("events", 15.0)]) }).unwrap();
        assert_eq!(sp.fill["n2"], 45.0);
        assert_eq!(sp.fill["e2"], 8.0);
        let e = convert(&req("events-from-percent", &[("percent", 12.5), ("n", 40.0)])).unwrap();
        assert_eq!(e.fill["e1"], 5.0);
        assert!(convert(&req("mean-sd-from-median-iqr", &[("q1", 7.0), ("median", 6.0), ("q3", 9.0), ("n", 35.0)])).is_err());
    }
}
