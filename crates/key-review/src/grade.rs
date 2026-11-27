// Certainty of the evidence (GRADE) per outcome and the Summary of findings table. This is the
// GRADE method as Key understands it, in Key's own words (the GRADE handbook and GRADEpro are
// not reproduced): the body of evidence for an outcome starts high (randomised trials) or low
// (non-randomised studies), goes down one or two levels for each of risk of bias,
// inconsistency, indirectness, imprecision and publication bias, and, for non-randomised
// evidence, may go up for a large effect, a dose–response gradient or confounding that would
// only shrink the effect. Each judgement carries a footnote.
//
// Key suggests judgements from the data (the analysis of the outcome and the risk-of-bias
// assessments) with its reasons; a suggestion is never applied by itself: the reviewer
// chooses, and a judgement other than "not serious", or one that differs from the suggestion,
// needs a footnote. The rules behind the suggestions are Key's reading of the guidance (links
// below), stated in the reasons so they can be checked:
//   GRADE handbook: https://gdt.gradepro.org/app/handbook/handbook.html
//   Cochrane Handbook ch. 14 (Summary of findings, GRADE): https://training.cochrane.org/handbook/current/chapter-14
//   Core GRADE (BMJ 2025 series): https://www.bmj.com/core-grade
use crate::derive::State;
use crate::events::Event;
use crate::meta::{Analysis, Measure, StudyData};
use crate::rob;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::collections::BTreeMap;

pub const DOWN: &[(&str, &str)] = &[("riskOfBias", "Risk of bias"), ("inconsistency", "Inconsistency"), ("indirectness", "Indirectness"), ("imprecision", "Imprecision"), ("publicationBias", "Publication bias")];
pub const UP: &[(&str, &str)] = &[("largeEffect", "Large effect"), ("doseResponse", "Dose–response gradient"), ("confounding", "Plausible confounding would reduce the effect")];

/// One domain's judgement for an outcome.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DomainRating {
    /// Downgrading: none | serious | verySerious. Upgrading: none | large | veryLarge (large
    /// effect) or none | present.
    pub judgement: String,
    pub footnote: String,
    /// What Key suggested when it was judged (kept for the record).
    pub suggested: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AnalysisChoice {
    pub measure: String,
    pub method: String,
    pub hartung_knapp: bool,
}

/// The certainty rating of one outcome (`grade.set`).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Rating {
    pub outcome: String,
    pub timepoint: String,
    /// The outcome's name in the table (default: outcome and time point).
    pub label: String,
    /// 1–9: 7–9 critical, 4–6 important, 1–3 of limited importance.
    pub importance: Option<u8>,
    pub analysis: AnalysisChoice,
    /// randomised | nonRandomised
    pub design: String,
    /// high | low (non-randomised evidence rated with ROBINS-I may start high).
    pub start: String,
    pub domains: BTreeMap<String, DomainRating>,
    /// The smallest difference that matters to people: per 1,000 for dichotomous outcomes, in
    /// the outcome's units for mean differences, in SDs for standardised ones.
    pub mid: Option<f64>,
    /// Optimal information size (participants); None: computed where it can be.
    pub ois: Option<f64>,
    /// Assumed risk without the intervention, per 1,000; None: the studies' median control risk.
    pub assumed_risk: Option<f64>,
    pub comment: String,
    /// The plain-language statement as the reviewer wrote it ("" = Key's suggestion).
    pub statement: String,
    #[serde(skip)]
    pub at: i64,
    #[serde(skip)]
    pub by: String,
    #[serde(skip)]
    pub changes: usize,
    #[serde(skip)]
    pub rob_used: bool,
}

#[derive(Clone, Debug, Default)]
pub struct GradeState {
    pub outcomes: BTreeMap<String, Rating>,
    /// The Summary of findings order (outcome keys).
    pub order: Vec<String>,
}

impl GradeState {
    pub fn apply(&mut self, e: &Event) {
        let p = &e.payload;
        match e.kind.as_str() {
            "grade.set" => {
                let key = p.get("key").and_then(Json::as_str).unwrap_or("").to_string();
                if key.is_empty() {
                    return;
                }
                if p.get("deleted").and_then(Json::as_bool).unwrap_or(false) {
                    self.outcomes.remove(&key);
                    self.order.retain(|k| k != &key);
                    return;
                }
                if let Ok(mut r) = serde_json::from_value::<Rating>(p.get("rating").cloned().unwrap_or(Json::Null)) {
                    r.at = e.at;
                    r.by = e.actor.clone();
                    r.changes = self.outcomes.get(&key).map(|x| x.changes).unwrap_or(0) + 1;
                    r.rob_used = r.domains.get("riskOfBias").and_then(|d| d.suggested.as_ref()).is_some();
                    if !self.order.contains(&key) {
                        self.order.push(key.clone());
                    }
                    self.outcomes.insert(key, r);
                }
            }
            "grade.order" => {
                if let Some(Json::Array(keys)) = p.get("order") {
                    let mut order: Vec<String> = keys.iter().filter_map(Json::as_str).map(str::to_string).collect();
                    for k in &self.order {
                        if !order.contains(k) {
                            order.push(k.clone());
                        }
                    }
                    self.order = order;
                }
            }
            _ => {}
        }
    }
}

pub fn level_name(score: i32) -> &'static str {
    match score {
        4.. => "high",
        3 => "moderate",
        2 => "low",
        _ => "veryLow",
    }
}

pub fn level_label(level: &str) -> &'static str {
    match level {
        "high" => "High",
        "moderate" => "Moderate",
        "low" => "Low",
        _ => "Very low",
    }
}

/// The GRADE symbols for a level (filled and empty circles), for exports.
pub fn symbols(level: &str) -> String {
    let n = match level {
        "high" => 4,
        "moderate" => 3,
        "low" => 2,
        _ => 1,
    };
    format!("{}{}", "⊕".repeat(n), "◯".repeat(4 - n))
}

fn steps(domain: &str, judgement: &str) -> i32 {
    match (domain, judgement) {
        (_, "serious") | (_, "large") | (_, "present") => 1,
        (_, "verySerious") | (_, "veryLarge") => 2,
        _ => 0,
    }
}

/// The resulting certainty and how it was reached, in words.
pub fn certainty(r: &Rating) -> (String, String) {
    let randomised = r.design != "nonRandomised";
    let start_high = if r.start.is_empty() { randomised } else { r.start == "high" };
    let mut score = if start_high { 4 } else { 2 };
    let mut parts = vec![format!("Starts {} ({})", if start_high { "high" } else { "low" }, if randomised { "randomised trials" } else { "non-randomised studies" })];
    for (id, name) in DOWN {
        let n = steps(id, r.domains.get(*id).map(|d| d.judgement.as_str()).unwrap_or(""));
        if n > 0 {
            score -= n;
            parts.push(format!("down {} for {}", if n == 2 { "two" } else { "one" }, name.to_lowercase()));
        }
    }
    if !randomised || !start_high {
        for (id, name) in UP {
            let n = steps(id, r.domains.get(*id).map(|d| d.judgement.as_str()).unwrap_or(""));
            if n > 0 {
                score += n;
                parts.push(format!("up {} for {}", if n == 2 { "two" } else { "one" }, name.to_lowercase()));
            }
        }
    }
    let level = level_name(score.clamp(1, 4));
    (level.to_string(), format!("{}: {}.", parts.join(", "), level_label(level).to_lowercase()))
}

/// Plain-words reasons a rating cannot be saved.
pub fn validate(r: &Rating) -> Result<(), String> {
    if r.outcome.trim().is_empty() {
        return Err("Choose the outcome".into());
    }
    if !matches!(r.design.as_str(), "randomised" | "nonRandomised") {
        return Err("Say whether the evidence comes from randomised or non-randomised studies".into());
    }
    if let Some(i) = r.importance {
        if !(1..=9).contains(&i) {
            return Err("Importance goes from 1 to 9".into());
        }
    }
    for (id, name) in DOWN.iter().chain(UP) {
        let Some(d) = r.domains.get(*id) else { continue };
        let allowed: &[&str] = match *id {
            "largeEffect" => &["", "none", "large", "veryLarge"],
            "doseResponse" | "confounding" => &["", "none", "present"],
            _ => &["", "none", "serious", "verySerious"],
        };
        if !allowed.contains(&d.judgement.as_str()) {
            return Err(format!("Unknown judgement for {}", name.to_lowercase()));
        }
        let moved = !d.judgement.is_empty() && d.judgement != "none";
        let overrides = d.suggested.as_ref().is_some_and(|s| !d.judgement.is_empty() && s != &d.judgement);
        if (moved || overrides) && d.footnote.trim().is_empty() {
            return Err(format!("{}: add a footnote saying why{}", name, if overrides && !moved { " (it differs from Key's suggestion)" } else { "" }));
        }
    }
    if r.mid.is_some_and(|m| !(m > 0.0)) {
        return Err("The smallest important difference must be above 0".into());
    }
    if r.assumed_risk.is_some_and(|a| !(0.0..=1000.0).contains(&a)) {
        return Err("The assumed risk is per 1,000: between 0 and 1,000".into());
    }
    Ok(())
}

// ── Absolute effects ────────────────────────────────────────────────────────────────

/// The risk with the intervention for an assumed control risk `acr` (a proportion) and a
/// relative effect on its natural scale (RR, OR or RD).
/// RR: acr × RR. OR: OR × acr / (1 − acr + OR × acr) (Cochrane Handbook ch. 14 §14.1.5.1 and
/// ch. 15 §15.4.4: an odds ratio is turned into a risk through the odds, not by multiplying).
/// RD: acr + RD. Clamped to 0–1.
pub fn corresponding_risk(measure: Measure, acr: f64, effect: f64) -> f64 {
    let r = match measure {
        Measure::RR => acr * effect,
        Measure::OR => effect * acr / (1.0 - acr + effect * acr),
        Measure::RD => acr + effect,
        _ => f64::NAN,
    };
    r.clamp(0.0, 1.0)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Absolute {
    /// Per 1,000: assumed risk, risk with the intervention and the difference, each difference
    /// and risk with its interval (lower, upper).
    pub assumed: f64,
    pub corresponding: (f64, f64, f64),
    pub difference: (f64, f64, f64),
}

/// Per-1,000 effects for a dichotomous outcome, from the pooled relative effect (estimate and
/// interval on the natural scale) and the assumed risk per 1,000.
pub fn absolute(measure: Measure, assumed_per_1000: f64, est: f64, lower: f64, upper: f64) -> Option<Absolute> {
    if !matches!(measure, Measure::RR | Measure::OR | Measure::RD) {
        return None;
    }
    let acr = assumed_per_1000 / 1000.0;
    let at = |x: f64| corresponding_risk(measure, acr, x) * 1000.0;
    let (c, a, b) = (at(est), at(lower), at(upper));
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    Some(Absolute { assumed: assumed_per_1000, corresponding: (c, lo, hi), difference: (c - assumed_per_1000, lo - assumed_per_1000, hi - assumed_per_1000) })
}

/// "50 fewer per 1,000 (from 80 fewer to 14 fewer)".
pub fn difference_text(d: (f64, f64, f64)) -> String {
    let one = |v: f64| {
        let n = v.round();
        if n == 0.0 { "0".to_string() } else if n < 0.0 { format!("{} fewer", -n as i64) } else { format!("{} more", n as i64) }
    };
    format!("{} per 1,000 (from {} to {})", one(d.0), one(d.1), one(d.2))
}

/// "0.45 higher (0.10 lower to 1.00 higher)" for mean differences (units) and SMDs (SDs).
pub fn mean_text(est: f64, lower: f64, upper: f64, unit: &str) -> String {
    let one = |v: f64| if v.abs() < 0.005 { "0.00".to_string() } else if v < 0.0 { format!("{:.2} lower", -v) } else { format!("{v:.2} higher") };
    format!("{}{unit} ({} to {})", one(est), one(lower), one(upper))
}

// ── Suggestions from the data ───────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggested {
    /// None: Key cannot judge this from the data (the reasons say what to consider).
    pub judgement: Option<String>,
    pub why: Vec<String>,
}

fn s(j: Option<&str>, why: Vec<String>) -> Suggested {
    Suggested { judgement: j.map(str::to_string), why }
}

fn pct(x: f64) -> String {
    format!("{:.0}%", x)
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    v.retain(|x| x.is_finite());
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    Some(if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 })
}

/// The studies' median control-group risk, per 1,000.
pub fn control_risk(input: &[StudyData]) -> Option<f64> {
    median(input.iter().filter_map(|s| Some(s.e2? / s.n2.filter(|n| *n > 0.0)? * 1000.0)).collect())
}

pub fn participants(input: &[StudyData], used: &[String]) -> Option<f64> {
    let sum: f64 = input.iter().filter(|s| used.contains(&s.id)).filter_map(|s| Some(s.n1? + s.n2?)).sum();
    (sum > 0.0).then_some(sum)
}

/// Pooled SD of the studies' groups (for the information size of a continuous outcome).
fn pooled_sd(input: &[StudyData]) -> Option<f64> {
    let (mut num, mut den) = (0.0, 0.0);
    for s in input {
        for (sd, n) in [(s.sd1, s.n1), (s.sd2, s.n2)] {
            if let (Some(sd), Some(n)) = (sd, n) {
                if n > 1.0 {
                    num += (n - 1.0) * sd * sd;
                    den += n - 1.0;
                }
            }
        }
    }
    (den > 0.0).then(|| (num / den).sqrt())
}

/// Optimal information size (participants, both groups) for α = 0.05 two-sided and 80% power:
/// dichotomous with a 25% relative risk reduction from the control risk, continuous with the
/// smallest important difference and the pooled SD. The usual sample-size formulas (GRADE
/// handbook §5.2.2; Guyatt et al., J Clin Epidemiol 2011;64:1283).
pub fn information_size(dichotomous: bool, control_per_1000: Option<f64>, mid: Option<f64>, sd: Option<f64>) -> Option<f64> {
    let z: f64 = 1.959_964 + 0.841_621;
    if dichotomous {
        let p0 = control_per_1000? / 1000.0;
        let p1 = p0 * 0.75;
        if !(p0 > 0.0 && p0 < 1.0) {
            return None;
        }
        let n = z * z * (p0 * (1.0 - p0) + p1 * (1.0 - p1)) / (p0 - p1).powi(2);
        Some(2.0 * n.ceil())
    } else {
        let (d, sd) = (mid?, sd?);
        let n = 2.0 * z * z * sd * sd / (d * d);
        Some(2.0 * n.ceil())
    }
}

pub struct Context<'a> {
    pub analysis: &'a Analysis,
    pub input: &'a [StudyData],
    /// Study id → overall risk of bias for this result.
    pub rob: &'a BTreeMap<String, rob::Covariate>,
    pub rating: &'a Rating,
    /// An analysis without the studies at high risk, when there are some.
    pub without_high: Option<&'a Analysis>,
}

fn crosses(lower: f64, upper: f64, null: f64) -> bool {
    lower < null && upper > null
}

pub fn suggest(c: &Context) -> BTreeMap<String, Suggested> {
    let mut out = BTreeMap::new();
    let a = c.analysis;
    let m = &a.main;
    let dichotomous = matches!(a.measure, Measure::RR | Measure::OR | Measure::RD);

    // Risk of bias: the share of the weight from studies at high (or some) risk.
    let (mut high, mut critical, mut some, mut none) = (0.0, 0.0, 0.0, 0.0);
    for st in &a.studies {
        match c.rob.get(&st.id).map(|x| x.rank) {
            Some(3) => {
                critical += st.weight;
                high += st.weight;
            }
            Some(2) => high += st.weight,
            Some(1) => some += st.weight,
            Some(_) => {}
            None => none += st.weight,
        }
    }
    let mut why = vec![format!("Weight from studies at high risk: {}; some concerns: {}; low: {}{}", pct(high), pct(some), pct((100.0 - high - some - none).max(0.0)), if none > 0.0 { format!("; not assessed: {}", pct(none)) } else { String::new() })];
    if let Some(w) = c.without_high {
        let tr = |v: f64| if a.ratio { v.exp() } else { v };
        why.push(format!("Without the studies at high risk: {:.2} [{:.2}, {:.2}] (all studies: {:.2} [{:.2}, {:.2}])", tr(w.main.estimate), tr(w.main.lower), tr(w.main.upper), tr(m.estimate), tr(m.lower), tr(m.upper)));
    }
    out.insert(
        "riskOfBias".into(),
        if none > 50.0 {
            why.push("Most of the weight has no risk-of-bias assessment yet: assess those studies first".into());
            s(None, why)
        } else if critical >= 50.0 {
            why.push("Half or more of the weight comes from studies at critical risk: suggested very serious".into());
            s(Some("verySerious"), why)
        } else if high >= 50.0 || (high >= 25.0 && high + some >= 50.0) {
            why.push("A large share of the weight comes from studies at high risk: suggested serious".into());
            s(Some("serious"), why)
        } else {
            why.push("Most of the weight comes from studies at low risk or with some concerns only".into());
            s(Some("none"), why)
        },
    );

    // Inconsistency: I², the prediction interval and how far the studies' intervals overlap.
    let k = a.studies.len();
    if k < 2 {
        out.insert("inconsistency".into(), s(Some("none"), vec!["A single study: inconsistency cannot be judged".into()]));
    } else {
        let max_lower = a.studies.iter().map(|x| x.lower).fold(f64::NEG_INFINITY, f64::max);
        let min_upper = a.studies.iter().map(|x| x.upper).fold(f64::INFINITY, f64::min);
        let overlap = max_lower <= min_upper;
        let both_sides = a.studies.iter().any(|x| x.yi > 0.0) && a.studies.iter().any(|x| x.yi < 0.0);
        let pi_crosses = matches!((m.pi_lower, m.pi_upper), (Some(l), Some(u)) if crosses(l, u, 0.0)) && !crosses(m.lower, m.upper, 0.0);
        let mut why = vec![format!("I² = {:.0}%, τ² = {:.3}", m.i2, m.tau2)];
        if let (Some(l), Some(u)) = (m.pi_lower, m.pi_upper) {
            let tr = |v: f64| if a.ratio { v.exp() } else { v };
            why.push(format!("Prediction interval {:.2} to {:.2}{}", tr(l), tr(u), if pi_crosses { ", crossing no effect while the pooled interval does not" } else { "" }));
        }
        why.push(if overlap { "The studies' confidence intervals all overlap".into() } else { "Some studies' confidence intervals do not overlap".into() });
        if both_sides {
            why.push("Point estimates fall on both sides of no effect".into());
        }
        let j = if m.i2 >= 75.0 && both_sides && !overlap {
            "verySerious"
        } else if m.i2 >= 75.0 || (m.i2 >= 50.0 && (pi_crosses || !overlap)) {
            "serious"
        } else {
            "none"
        };
        why.push("Key's rule: serious at I² of 75% or more, or 50% or more with intervals that do not overlap or a prediction interval crossing no effect; very serious when, in addition, estimates point both ways".into());
        out.insert("inconsistency".into(), s(Some(j), why));
    }

    // Imprecision: the interval against no effect and the smallest important difference, and
    // the information size.
    let mut why = Vec::new();
    let used: Vec<String> = a.studies.iter().map(|x| x.id.clone()).collect();
    let total = participants(c.input, &used);
    let control = c.rating.assumed_risk.or_else(|| control_risk(c.input));
    let mut level = 0;
    let crosses_null = crosses(m.lower, m.upper, 0.0);
    let abs = if dichotomous {
        control.and_then(|acr| {
            let nat = |v: f64| if a.ratio { v.exp() } else { v };
            absolute(a.measure, acr, nat(m.estimate), nat(m.lower), nat(m.upper))
        })
    } else {
        None
    };
    match (c.rating.mid, &abs) {
        (Some(mid), Some(abs)) => {
            let (_, lo, hi) = abs.difference;
            let below = lo < -mid;
            let above = hi > mid;
            why.push(format!("Difference per 1,000 from {:.0} to {:.0}; smallest important difference {mid:.0}", lo, hi));
            if below && above {
                level = 2;
                why.push("The interval includes both an important benefit and an important harm".into());
            } else if (below || above) && crosses(lo, hi, 0.0) {
                level = 1;
                why.push("The interval includes both no effect and an important effect".into());
            } else if crosses(lo, hi, 0.0) || (lo.abs() < mid && hi.abs() < mid && !crosses(lo, hi, 0.0)) {
                why.push("The interval lies within the range of unimportant effects".into());
            }
        }
        (Some(mid), None) if !dichotomous => {
            let nat_lo = m.lower;
            let nat_hi = m.upper;
            why.push(format!("Interval {nat_lo:.2} to {nat_hi:.2}; smallest important difference {mid}"));
            if nat_lo < -mid && nat_hi > mid {
                level = 2;
                why.push("The interval includes both an important benefit and an important harm".into());
            } else if (nat_lo < -mid || nat_hi > mid) && crosses(nat_lo, nat_hi, 0.0) {
                level = 1;
                why.push("The interval includes both no effect and an important effect".into());
            }
        }
        _ => {
            if crosses_null {
                level = 1;
                why.push("The confidence interval includes no effect (add the smallest important difference for a finer judgement)".into());
            } else {
                why.push("The confidence interval rules out no effect".into());
            }
        }
    }
    let ois = c.rating.ois.or_else(|| information_size(dichotomous, control, c.rating.mid, pooled_sd(c.input)));
    match (total, ois) {
        (Some(n), Some(o)) => {
            why.push(format!("{} participants; optimal information size about {}", n as i64, o as i64));
            if n < o {
                level += 1;
                why.push("Fewer participants than the optimal information size".into());
            }
        }
        (Some(n), None) => why.push(format!("{} participants (no information size: give the assumed risk or the smallest important difference)", n as i64)),
        _ => {}
    }
    out.insert("imprecision".into(), s(Some(["none", "serious", "verySerious"][level.min(2)]), why));

    // Publication bias: a funnel test only with ten or more studies.
    out.insert(
        "publicationBias".into(),
        match &a.egger {
            Some(e) if k >= 10 => {
                let j = if e.p < 0.10 { "serious" } else { "none" };
                let mut why = vec![format!("Egger's test: p = {:.3} with {k} studies{}", e.p, if e.p < 0.10 { ": the funnel plot may be asymmetric (small studies show larger effects)" } else { "" })];
                // std-D: the corrected estimates beside it (pubbias.rs), on the outcome's scale.
                let y: Vec<f64> = a.studies.iter().map(|x| x.yi).collect();
                let v: Vec<f64> = a.studies.iter().map(|x| x.vi).collect();
                let tr = |x: f64| crate::meta::back_transform(x, &a.transform, a.harmonic_n);
                if let Ok(pp) = crate::pubbias::pet_peese(&y, &v, None, 0.05, false) {
                    why.push(format!("PET-PEESE ({}): {:.2} [{:.2}, {:.2}] against {:.2} pooled", pp.chosen, tr(pp.estimate.estimate), tr(pp.estimate.lower), tr(pp.estimate.upper), tr(m.estimate)));
                }
                if let Ok(t) = crate::pubbias::trim_fill(&y, &v, m.method, "L0") {
                    why.push(if t.k0 == 0 { "Trim and fill imputes no missing studies".to_string() } else { format!("Trim and fill imputes {} missing {} on the {}; adjusted {:.2} [{:.2}, {:.2}]", t.k0, if t.k0 == 1 { "study" } else { "studies" }, t.side, tr(t.pooled.estimate), tr(t.pooled.lower), tr(t.pooled.upper)) });
                }
                s(Some(j), why)
            }
            _ => s(None, vec![format!("{k} {}: too few for a funnel test (10 or more are needed). Consider whether small, unpublished or sponsor-run studies could be missing (search of registers, grey literature).", if k == 1 { "study" } else { "studies" })]),
        },
    );

    // Indirectness: Key cannot see it in the data.
    out.insert(
        "indirectness".into(),
        s(None, vec!["Do the studies' people, interventions, comparators and outcomes match the question? Are outcomes surrogates? Are comparisons made only indirectly?".into()]),
    );

    // Upgrading (non-randomised evidence only): a large effect on a ratio measure.
    if c.rating.design == "nonRandomised" && a.ratio {
        let (e, l, u) = (m.estimate.exp(), m.lower.exp(), m.upper.exp());
        let (big, very) = if e >= 1.0 { (l >= 2.0, l >= 5.0) } else { (u <= 0.5, u <= 0.2) };
        let j = if very { "veryLarge" } else if big { "large" } else { "none" };
        out.insert(
            "largeEffect".into(),
            s(Some(j), vec![format!("Pooled ratio {e:.2} [{l:.2}, {u:.2}]; Key's rule: large when the whole interval is beyond 2 (or 0.5), very large beyond 5 (or 0.2), and only when there are no serious concerns otherwise")]),
        );
    }
    out
}

// ── Plain-language statement ────────────────────────────────────────────────────────

/// A statement in the style GRADE recommends (Santesso et al., J Clin Epidemiol 2020;119:126):
/// how sure ("probably", "may", "very uncertain") and how large ("little or no difference"),
/// in Key's own words. `small`: the effect is too small to matter (within the smallest
/// important difference, or near no effect without one).
pub fn statement(certainty: &str, intervention: &str, outcome: &str, direction: i32, small: bool) -> String {
    let outcome = outcome.to_lowercase();
    if certainty == "veryLow" {
        return format!("The evidence is very uncertain about the effect of {intervention} on {outcome}.");
    }
    let (verb3, verb) = match direction {
        d if d < 0 => ("reduces", "reduce"),
        _ => ("increases", "increase"),
    };
    let cap = |t: String| {
        let mut c = t.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
    };
    cap(match (certainty, small) {
        ("high", true) => format!("{intervention} results in little or no difference in {outcome}."),
        ("high", false) => format!("{intervention} {verb3} {outcome}."),
        ("moderate", true) => format!("{intervention} probably results in little or no difference in {outcome}."),
        ("moderate", false) => format!("{intervention} probably {verb3} {outcome}."),
        (_, true) => format!("{intervention} may result in little or no difference in {outcome}."),
        (_, false) => format!("{intervention} may {verb} {outcome}."),
    })
}

/// Whether the pooled effect is too small to matter, and its direction (−1 lower, +1 higher).
pub fn effect_size(a: &Analysis, mid: Option<f64>, abs: Option<&Absolute>) -> (i32, bool) {
    let m = &a.main;
    let direction = if m.estimate < 0.0 { -1 } else { 1 };
    let small = match (mid, abs) {
        (Some(mid), Some(abs)) => abs.difference.0.abs() < mid,
        (Some(mid), None) if !a.ratio => m.estimate.abs() < mid,
        _ => {
            let near = if a.ratio { m.estimate.abs() < 0.1_f64.ln_1p() } else if a.measure == Measure::SMD { m.estimate.abs() < 0.1 } else { false };
            crosses(m.lower, m.upper, 0.0) && near
        }
    };
    (direction, small)
}

// ── For the checklist (std-A) ───────────────────────────────────────────────────────

pub fn reporting_facts(state: &State) -> Json {
    let rated: Vec<&Rating> = state.grade.order.iter().filter_map(|k| state.grade.outcomes.get(k)).collect();
    if rated.is_empty() {
        return json!({ "outcomes": 0, "sof": false });
    }
    let results: Vec<String> = rated.iter().map(|r| format!("{}: {}", if r.label.is_empty() { &r.outcome } else { &r.label }, level_label(&certainty(r).0).to_lowercase())).collect();
    json!({
        "statement": "The certainty of the evidence for each outcome was rated with GRADE: evidence from randomised trials started as high certainty and from non-randomised studies as low, and was rated down for risk of bias, inconsistency, indirectness, imprecision and publication bias, or up for a large effect, a dose–response gradient or residual confounding, with the reason for each judgement given in footnotes.",
        "results": format!("Certainty of the evidence: {}.", results.join("; ")),
        "outcomes": rated.len(),
        "sof": true,
    })
}
