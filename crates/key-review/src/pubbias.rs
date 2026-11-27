// Small-study effects and publication bias beyond Egger's test:
// - FAT-PET and PEESE (Stanley 2008, Oxf Bull Econ Stat 70:103; Stanley & Doucouliagos 2014,
//   Res Synth Methods 5:60): weighted least squares of the estimate on its standard error
//   (PET) or its variance (PEESE), weights 1/vi, multiplicative dispersion (R's
//   `lm(yi ~ sei, weights = 1/vi)`); the conditional PET-PEESE estimator; standard errors either
//   model-based or cluster-robust (CR2, Satterthwaite df) when studies give several estimates.
// - UWLS (Stanley & Doucouliagos 2015, Stat Med 34:2116; 2017, Res Synth Methods 8:19) and WAAP
//   (Ioannidis, Stanley & Doucouliagos 2017, Econ J 127:F236): the unrestricted WLS average of
//   the adequately powered estimates (SE ≤ |UWLS| / 2.8).
// - Trim and fill (Duval & Tweedie 2000, Biometrics 56:455) with the L0 and R0 estimators, as
//   metafor's trimfill().
// - The three-parameter selection model (Vevea & Hedges 1995, Psychometrika 60:419; one step
//   at one-sided p = .025, ML, as metafor's `selmodel(type = "stepfun", steps = 0.025)`).
// The tests reproduce R's lm() and metafor 5.2-1 on dat.hackshaw1998 and dat.bcg.
use crate::linalg::Mat;
use crate::meta::{Effect, Method, Pooled, pool};
use crate::metareg::core;
use crate::multilevel::{Coef, Design, coefs, cr2, fit_fixed};
use crate::stats::{norm_cdf, norm_p2, norm_quantile, t_p2};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Regression {
    /// The estimate when the standard error is 0 (PET/PEESE's corrected effect).
    pub intercept: Coef,
    /// The small-study term (FAT: a slope different from 0 means funnel asymmetry).
    pub slope: Coef,
    /// "model" (multiplicative dispersion) or "CR2".
    pub se_type: String,
}

fn regression(y: &[f64], v: &[f64], x2: &[f64], clusters: Option<&[String]>) -> Result<Regression, String> {
    let k = y.len();
    if k < 3 {
        return Err("Needs at least three estimates".into());
    }
    let x = Mat::from_rows(&x2.iter().map(|s| vec![1.0, *s]).collect::<Vec<_>>());
    let d = Design { y: y.to_vec(), v: Mat::diag(v), x, g: vec![] };
    let fit = fit_fixed(&d, &[])?;
    let names = ["Intercept".to_string(), "Slope".to_string()];
    let c = match clusters {
        Some(cl) if cl.iter().collect::<std::collections::BTreeSet<_>>().len() < k => {
            let r = cr2(&d, &fit, cl)?;
            coefs(&names, &fit.beta, &r.vcov, &[Some(r.df[0]), Some(r.df[1])], 0.95)
        }
        _ => {
            let rss: f64 = fit.resid.iter().zip(v).map(|(e, v)| e * e / v).sum();
            let s2 = rss / (k - 2) as f64;
            coefs(&names, &fit.beta, &fit.vb.scale(s2), &[Some((k - 2) as f64); 2], 0.95)
        }
    };
    let robust = clusters.is_some_and(|cl| cl.iter().collect::<std::collections::BTreeSet<_>>().len() < k);
    Ok(Regression { intercept: c[0].clone(), slope: c[1].clone(), se_type: if robust { "CR2".into() } else { "model".into() } })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPeese {
    pub pet: Regression,
    pub peese: Regression,
    /// "PET" or "PEESE": the estimate the conditional rule picks.
    pub chosen: String,
    pub estimate: Coef,
    /// The rule as applied, in words.
    pub rule: String,
}

/// FAT-PET, PEESE and the conditional estimator: PEESE when PET's intercept is significantly
/// different from 0 at `alpha` (two-sided unless `one_sided`, which tests in the direction of the
/// PET estimate), else PET.
pub fn pet_peese(y: &[f64], v: &[f64], clusters: Option<&[String]>, alpha: f64, one_sided: bool) -> Result<PetPeese, String> {
    let se: Vec<f64> = v.iter().map(|v| v.sqrt()).collect();
    let pet = regression(y, v, &se, clusters)?;
    let peese = regression(y, v, v, clusters)?;
    let p = if one_sided { pet.intercept.p / 2.0 } else { pet.intercept.p };
    let use_peese = p < alpha;
    let rule = format!(
        "PET's corrected effect {} significantly different from 0 ({} p = {:.3}, α = {alpha}), so the {} estimate is used.",
        if use_peese { "is" } else { "is not" },
        if one_sided { "one-sided" } else { "two-sided" },
        p,
        if use_peese { "PEESE" } else { "PET" }
    );
    Ok(PetPeese { estimate: if use_peese { peese.intercept.clone() } else { pet.intercept.clone() }, chosen: if use_peese { "PEESE".into() } else { "PET".into() }, pet, peese, rule })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Uwls {
    pub uwls: Coef,
    /// Estimates with SE ≤ |UWLS| / 2.8 (80% power at α = .05, two-sided).
    pub adequately_powered: usize,
    /// WAAP when at least two are adequately powered.
    pub waap: Option<Coef>,
    pub note: String,
}

fn uwls_of(y: &[f64], v: &[f64]) -> Coef {
    // lm(yi/sei ~ 0 + I(1/sei)): the fixed-effect estimate with the regression's dispersion.
    let k = y.len();
    let sw: f64 = v.iter().map(|v| 1.0 / v).sum();
    let b = y.iter().zip(v).map(|(y, v)| y / v).sum::<f64>() / sw;
    let rss: f64 = y.iter().zip(v).map(|(y, v)| (y - b).powi(2) / v).sum();
    let s2 = if k > 1 { rss / (k - 1) as f64 } else { f64::NAN };
    coefs(&["UWLS".into()], &[b], &Mat::diag(&[s2 / sw]), &[Some((k - 1) as f64)], 0.95).remove(0)
}

pub fn uwls_waap(y: &[f64], v: &[f64]) -> Uwls {
    let all = uwls_of(y, v);
    let idx: Vec<usize> = (0..y.len()).filter(|i| v[*i].sqrt() <= all.estimate.abs() / 2.8).collect();
    let waap = (idx.len() >= 2).then(|| {
        let mut c = uwls_of(&idx.iter().map(|i| y[*i]).collect::<Vec<_>>(), &idx.iter().map(|i| v[*i]).collect::<Vec<_>>());
        c.name = "WAAP".into();
        c
    });
    let note = match idx.len() {
        0 => "No estimate is adequately powered (SE at most |UWLS| / 2.8), so WAAP cannot be computed; Ioannidis, Stanley and Doucouliagos (2017) then report UWLS of all estimates.".into(),
        1 => "Only one estimate is adequately powered; WAAP needs at least two, so UWLS of all estimates is the reference.".into(),
        n => format!("{n} of {} estimates are adequately powered.", y.len()),
    };
    Uwls { uwls: all, adequately_powered: idx.len(), waap, note }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimFill {
    pub estimator: String,
    /// The side the missing studies are imputed on: "left" or "right".
    pub side: String,
    pub k0: usize,
    pub se_k0: f64,
    /// R0 only: p of the test that k0 = 0.
    pub p_k0: Option<f64>,
    /// Filled-in estimates and variances (analysis scale).
    pub filled: Vec<(f64, f64)>,
    pub pooled: Pooled,
}

/// Duval and Tweedie's trim and fill, following metafor's trimfill.rma.uni step by step.
pub fn trim_fill(y: &[f64], v: &[f64], method: Method, estimator: &str) -> Result<TrimFill, String> {
    let k = y.len();
    if k < 3 {
        return Err("Trim and fill needs at least three studies".into());
    }
    let mname = match method {
        Method::Fe => "fe",
        Method::Dl => "dl",
        Method::Reml => "reml",
    };
    let x = Mat::from_rows(&v.iter().map(|v| vec![1.0, v.sqrt()]).collect::<Vec<_>>());
    let side_right = core(y, v, &x, mname, false)?.beta[1] < 0.0;
    let sgn = if side_right { -1.0 } else { 1.0 };
    let mut idx: Vec<usize> = (0..k).collect();
    idx.sort_by(|a, b| (sgn * y[*a]).partial_cmp(&(sgn * y[*b])).unwrap_or(std::cmp::Ordering::Equal));
    let ys: Vec<f64> = idx.iter().map(|i| sgn * y[*i]).collect();
    let vs: Vec<f64> = idx.iter().map(|i| v[*i]).collect();
    let kf = k as f64;
    let (mut k0, mut k0_prev) = (0usize, usize::MAX);
    let (mut beta, mut se_k0) = (0.0, 0.0);
    let mut iter = 0;
    while k0 != k0_prev {
        k0_prev = k0;
        iter += 1;
        if iter > 100 {
            return Err("Trim and fill did not converge".into());
        }
        let n = k - k0;
        let effects: Vec<Effect> = (0..n).map(|i| Effect { yi: ys[i], vi: vs[i] }).collect();
        beta = pool(&effects, method, false, 0.95)?.estimate;
        let c: Vec<f64> = ys.iter().map(|y| y - beta).collect();
        // rank(abs(c), ties.method = "first")
        let mut order: Vec<usize> = (0..k).collect();
        order.sort_by(|a, b| c[*a].abs().partial_cmp(&c[*b].abs()).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(b)));
        let mut rank = vec![0.0; k];
        for (r, i) in order.iter().enumerate() {
            rank[*i] = (r + 1) as f64;
        }
        let signed: Vec<f64> = (0..k).map(|i| c[i].signum() * rank[i]).collect();
        let est = if estimator == "R0" {
            let m = signed.iter().filter(|s| **s < 0.0).map(|s| -s).fold(f64::NEG_INFINITY, f64::max);
            let m = if m.is_finite() { m } else { 0.0 };
            let k0 = kf - m - 1.0;
            se_k0 = (2.0 * k0.max(0.0) + 2.0).sqrt();
            k0
        } else {
            let sr: f64 = signed.iter().filter(|s| **s > 0.0).sum();
            let k0 = (4.0 * sr - kf * (kf + 1.0)) / (2.0 * kf - 1.0);
            let var_sr = (kf * (kf + 1.0) * (2.0 * kf + 1.0) + 10.0 * k0.powi(3) + 27.0 * k0 * k0 + 17.0 * k0 - 18.0 * kf * k0 * k0 - 18.0 * kf * k0 + 6.0 * kf * kf * k0) / 24.0;
            se_k0 = 4.0 * var_sr.max(0.0).sqrt() / (2.0 * kf - 1.0);
            k0
        };
        k0 = est.round().max(0.0).min((k - 1) as f64) as usize;
        se_k0 = se_k0.max(0.0);
    }
    // The k0 largest (on the imputation side) are mirrored around the trimmed estimate.
    let filled: Vec<(f64, f64)> = (k - k0..k).map(|i| (sgn * (2.0 * beta - ys[i]), vs[i])).collect();
    let mut all: Vec<Effect> = (0..k).map(|i| Effect { yi: y[i], vi: v[i] }).collect();
    all.extend(filled.iter().map(|(y, v)| Effect { yi: *y, vi: *v }));
    let pooled = pool(&all, method, false, 0.95)?;
    let p_k0 = (estimator == "R0").then(|| {
        // 1 − Σ_{m=-1}^{k0-1} choose(m+1, m+1) 0.5^(m+2)
        1.0 - (-1..k0 as i64).map(|m| 0.5f64.powi((m + 2) as i32)).sum::<f64>()
    });
    Ok(TrimFill { estimator: estimator.into(), side: if side_right { "right".into() } else { "left".into() }, k0, se_k0, p_k0, filled, pooled })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub estimate: f64,
    pub se: f64,
    pub lower: f64,
    pub upper: f64,
    pub p: f64,
    pub tau2: f64,
    /// Relative likelihood of publication for p > .025 (one-sided) versus p ≤ .025.
    pub delta: f64,
    pub delta_se: Option<f64>,
    /// Likelihood ratio test against no selection (1 df).
    pub lrt: f64,
    pub lrt_p: f64,
    /// Estimates with one-sided p ≤ .025 and above.
    pub counts: (usize, usize),
}

fn sel_ll(y: &[f64], v: &[f64], mu: f64, tau2: f64, delta: f64, z: f64) -> f64 {
    let mut ll = 0.0;
    for (y, v) in y.iter().zip(v) {
        let s = v.sqrt();
        let sd = (v + tau2).sqrt();
        let p = 1.0 - norm_cdf(y / s);
        let w = if p <= 0.025 { 1.0 } else { delta };
        let p0 = 1.0 - norm_cdf((s * z - mu) / sd);
        let a = p0 + delta * (1.0 - p0);
        ll += w.ln() - 0.5 * (2.0 * std::f64::consts::PI).ln() - sd.ln() - 0.5 * ((y - mu) / sd).powi(2) - a.ln();
    }
    ll
}

/// Nelder–Mead minimisation.
pub fn nelder_mead(f: &dyn Fn(&[f64]) -> f64, start: &[f64], step: f64, iters: usize) -> Vec<f64> {
    let n = start.len();
    let mut pts: Vec<Vec<f64>> = vec![start.to_vec()];
    for i in 0..n {
        let mut p = start.to_vec();
        p[i] += if p[i].abs() > 1e-8 { step * p[i].abs().max(0.1) } else { step };
        pts.push(p);
    }
    let mut vals: Vec<f64> = pts.iter().map(|p| f(p)).collect();
    for _ in 0..iters {
        let mut order: Vec<usize> = (0..=n).collect();
        order.sort_by(|a, b| vals[*a].partial_cmp(&vals[*b]).unwrap_or(std::cmp::Ordering::Equal));
        pts = order.iter().map(|i| pts[*i].clone()).collect();
        vals = order.iter().map(|i| vals[*i]).collect();
        if (vals[n] - vals[0]).abs() < 1e-14 * (1.0 + vals[0].abs()) {
            let spread = (0..n).map(|j| pts.iter().map(|p| p[j]).fold(f64::NEG_INFINITY, f64::max) - pts.iter().map(|p| p[j]).fold(f64::INFINITY, f64::min)).fold(0.0, f64::max);
            if spread < 1e-10 {
                break;
            }
        }
        let centroid: Vec<f64> = (0..n).map(|j| pts[..n].iter().map(|p| p[j]).sum::<f64>() / n as f64).collect();
        let at = |t: f64| -> Vec<f64> { (0..n).map(|j| centroid[j] + t * (pts[n][j] - centroid[j])).collect() };
        let r = at(-1.0);
        let fr = f(&r);
        if fr < vals[0] {
            let e = at(-2.0);
            let fe = f(&e);
            if fe < fr {
                pts[n] = e;
                vals[n] = fe;
            } else {
                pts[n] = r;
                vals[n] = fr;
            }
        } else if fr < vals[n - 1] {
            pts[n] = r;
            vals[n] = fr;
        } else {
            let c = if fr < vals[n] { at(-0.5) } else { at(0.5) };
            let fc = f(&c);
            if fc < vals[n].min(fr) {
                pts[n] = c;
                vals[n] = fc;
            } else {
                for i in 1..=n {
                    pts[i] = (0..n).map(|j| pts[0][j] + 0.5 * (pts[i][j] - pts[0][j])).collect();
                    vals[i] = f(&pts[i]);
                }
            }
        }
    }
    let best = (0..=n).min_by(|a, b| vals[*a].partial_cmp(&vals[*b]).unwrap_or(std::cmp::Ordering::Equal)).unwrap_or(0);
    pts[best].clone()
}

fn hessian(f: &dyn Fn(&[f64]) -> f64, x: &[f64]) -> Mat {
    let n = x.len();
    let h: Vec<f64> = x.iter().map(|v| 1e-4 * v.abs().max(1e-2)).collect();
    let mut m = Mat::zeros(n, n);
    for i in 0..n {
        for j in i..n {
            let e = |di: f64, dj: f64| {
                let mut p = x.to_vec();
                p[i] += di * h[i];
                p[j] += dj * h[j];
                f(&p)
            };
            let val = if i == j { (e(1.0, 0.0) - 2.0 * f(x) + e(-1.0, 0.0)) / (h[i] * h[i]) } else { (e(1.0, 1.0) - e(1.0, -1.0) - e(-1.0, 1.0) + e(-1.0, -1.0)) / (4.0 * h[i] * h[j]) };
            m[(i, j)] = val;
            m[(j, i)] = val;
        }
    }
    m
}

/// The Vevea–Hedges step-function selection model with one cut at one-sided p = .025.
pub fn selection_model(y: &[f64], v: &[f64]) -> Result<Selection, String> {
    let k = y.len();
    let z = norm_quantile(0.975);
    let sig = y.iter().zip(v).filter(|(y, v)| 1.0 - norm_cdf(*y / v.sqrt()) <= 0.025).count();
    if sig == 0 || sig == k {
        return Err("Every estimate falls on the same side of p = .025, so the selection model cannot be estimated".into());
    }
    if k < 10 {
        return Err("The selection model needs at least 10 studies".into());
    }
    // Start from the ML random-effects fit.
    let ml = |t: &[f64]| -sel_ll(y, v, t[0], t[1] * t[1], 1.0, z);
    let s0 = nelder_mead(&ml, &[y.iter().sum::<f64>() / k as f64, 0.1], 0.5, 4000);
    let s0 = nelder_mead(&ml, &s0, 0.05, 4000);
    let ll0 = -ml(&s0);
    let neg = |t: &[f64]| -sel_ll(y, v, t[0], t[1] * t[1], t[2].exp(), z);
    let mut best = nelder_mead(&neg, &[s0[0], s0[1], 0.0], 0.5, 8000);
    for _ in 0..3 {
        best = nelder_mead(&neg, &best, 0.05, 8000);
    }
    let (mu, tau2, delta) = (best[0], best[1] * best[1], best[2].exp());
    let ll1 = -neg(&best);
    let lrt = (2.0 * (ll1 - ll0)).max(0.0);
    // Standard errors from the Hessian on the (μ, τ², δ) scale.
    let orig = |t: &[f64]| -sel_ll(y, v, t[0], t[1].max(0.0), t[2].max(1e-12), z);
    let cov = hessian(&orig, &[mu, tau2, delta]).inv_spd();
    let (se, delta_se) = match &cov {
        Some(c) => (c[(0, 0)].sqrt(), Some(c[(2, 2)].sqrt())),
        None => {
            let c = hessian(&|t: &[f64]| orig(&[t[0], tau2, t[1]]), &[mu, delta]).inv_spd().ok_or("The selection model's information matrix is singular")?;
            (c[(0, 0)].sqrt(), Some(c[(1, 1)].sqrt()))
        }
    };
    let zc = norm_quantile(0.975);
    Ok(Selection { estimate: mu, se, lower: mu - zc * se, upper: mu + zc * se, p: norm_p2(mu / se), tau2, delta, delta_se, lrt, lrt_p: crate::stats::chisq_sf(lrt, 1.0), counts: (sig, k - sig) })
}

/// A plain-language caution about power when there are few studies.
pub fn power_caution(k: usize) -> Option<String> {
    (k < 10).then(|| format!("Only {k} studies: tests for small-study effects and publication bias have little power below about 10 studies, so a non-significant result does not show the absence of bias, and the corrected estimates are imprecise."))
}

/// t-test p from a coefficient and df (kept for callers that format results).
pub fn two_sided(t: f64, df: f64) -> f64 {
    t_p2(t, df)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// metadat dat.hackshaw1998 (Hackshaw et al. 1997, BMJ 315:980): log odds ratios and variances.
    pub fn hackshaw() -> (Vec<f64>, Vec<f64>) {
        let yi = [0.165514438477573, 0.371563556432483, 0.703097511413113, 0.182321556793955, -0.287682072451781, 0.727548607277278, 0.756121979721334, -0.22314355131421, -0.23572233352107, 0.698134722070984, 0.207014169384326, 0.182321556793955, 0.418710334858185, 0.0295588022415444, 0.438254930931155, 0.0295588022415444, 0.85015092936961, 0.500775287912489, 0.173953307123438, 0.418710334858185, 0.770108221696074, 0.0769610411361284, 0.936093359170335, 0.482426149244293, 0.0582689081239758, -0.23572233352107, -0.301105092783922, 0.819779831493311, -0.0304592074847086, 0.470003629245736, 0.173953307123438, 0.506817602368452, 0.231111720963387, 0.0953101798043249, 0.506817602368452, 0.148420005118273, 0.104360015324243];
        let vi = [0.0187768854850681, 0.033044038905788, 0.540195865342449, 0.0312676144886663, 0.0796556541020111, 0.227320591670482, 0.0889215627069803, 0.192679603117081, 0.339016347538589, 0.0980662024387636, 0.0455555485775347, 0.231749969641464, 0.0796429220192453, 0.217395024672567, 0.0769579740386881, 0.0715017635257731, 0.292565772065689, 0.0324375074298712, 0.0362733466418536, 0.483851241822467, 0.123816201921842, 0.071085191722119, 0.398195433354185, 0.089623124068944, 0.0337198883325506, 0.0161294909173902, 0.180233473435612, 0.317147722864399, 0.0125468451490273, 0.113696292350967, 0.0893367804165667, 0.175985594791832, 0.0100290474315282, 0.0862143558865863, 0.0398749675436979, 0.0363997555696295, 0.0664195066219777];
        (yi.to_vec(), vi.to_vec())
    }

    fn close(a: f64, b: f64, tol: f64, what: &str) {
        assert!((a - b).abs() <= tol * (1.0 + b.abs()), "{what}: {a} vs {b}");
    }

    // R 4.6.1 base lm() run locally: lm(yi ~ sqrt(vi), weights = 1/vi) (PET),
    // lm(yi ~ vi, weights = 1/vi) (PEESE) and lm(yi/sqrt(vi) ~ 0 + I(1/sqrt(vi))) (UWLS) on
    // dat.hackshaw1998 and escalc("RR", data = dat.bcg). Relative tolerance 1e-9.
    #[test]
    fn pet_peese_uwls_waap_match_lm() {
        let (y, v) = hackshaw();
        let r = pet_peese(&y, &v, None, 0.05, false).unwrap();
        close(r.pet.intercept.estimate, 0.00503732307546357, 1e-9, "PET b0");
        close(r.pet.intercept.se, 0.0859023266068647, 1e-9, "PET se0");
        close(r.pet.slope.estimate, 0.90193265385540100, 1e-9, "FAT b1");
        close(r.pet.slope.p, 0.0227641997034067, 1e-8, "FAT p");
        close(r.peese.intercept.estimate, 0.120080764664311, 1e-9, "PEESE b0");
        close(r.peese.intercept.se, 0.0519033989199978, 1e-9, "PEESE se0");
        close(r.peese.slope.estimate, 1.275654852950555, 1e-9, "PEESE b1");
        assert_eq!(r.chosen, "PET");
        let u = uwls_waap(&y, &v);
        close(u.uwls.estimate, 0.185760203646786, 1e-9, "UWLS");
        close(u.uwls.se, 0.042848283192035, 1e-9, "UWLS se");
        assert_eq!(u.adequately_powered, 0);
        assert!(u.waap.is_none());
        let (y, v, ..) = crate::metareg::tests::bcg();
        let r = pet_peese(&y, &v, None, 0.05, false).unwrap();
        close(r.pet.intercept.estimate, -0.19092864235982, 1e-9, "bcg PET");
        close(r.pet.intercept.p, 0.404183981705597, 1e-8, "bcg PET p");
        close(r.peese.intercept.estimate, -0.379953506428271, 1e-9, "bcg PEESE");
        let u = uwls_waap(&y, &v);
        assert_eq!(u.adequately_powered, 4);
        let w = u.waap.unwrap();
        close(w.estimate, -0.398279953096043, 1e-9, "WAAP");
        close(w.se, 0.27407592425793, 1e-9, "WAAP se");
        close(w.p, 0.242129459903461, 1e-8, "WAAP p");
    }

    // PET with CR2 standard errors equals the regression with each estimate its own cluster
    // when every cluster has one estimate (HC2), and runs with clusters of several.
    #[test]
    fn pet_with_clusters() {
        let (y, v) = hackshaw();
        let cl: Vec<String> = (0..y.len()).map(|i| format!("s{}", i / 2)).collect();
        let r = pet_peese(&y, &v, Some(&cl), 0.05, false).unwrap();
        assert_eq!(r.pet.se_type, "CR2");
        close(r.pet.intercept.estimate, 0.00503732307546357, 1e-9, "PET b0 clustered");
        assert!(r.pet.intercept.df.unwrap() < 19.0);
    }

    // metafor 5.2-1 trimfill() run locally on rma(yi, vi, data = dat.hackshaw1998, method = m,
    // control = list(threshold = 1e-14)) for FE, REML and DL with L0 and R0, and on dat.bcg.
    #[test]
    fn trim_and_fill_matches_metafor() {
        let (y, v) = hackshaw();
        let t = trim_fill(&y, &v, Method::Fe, "L0").unwrap();
        assert_eq!((t.k0, t.side.as_str()), (7, "left"));
        close(t.pooled.estimate, 0.1555995778997082, 1e-9, "FE L0");
        close(t.pooled.se, 0.0364351242781106, 1e-9, "FE L0 se");
        close(t.se_k0, 4.0404958482684217, 1e-9, "se k0");
        close(t.filled[0].0, -0.391898355613697, 1e-9, "filled");
        close(t.filled[6].0, -0.624894203370918, 1e-9, "filled last");
        let t = trim_fill(&y, &v, Method::Fe, "R0").unwrap();
        assert_eq!(t.k0, 7);
        close(t.p_k0.unwrap(), 0.00390625, 1e-12, "p k0");
        let t = trim_fill(&y, &v, Method::Reml, "L0").unwrap();
        close(t.pooled.estimate, 0.1744711038948986, 1e-7, "REML L0");
        close(t.pooled.tau2, 0.0244557384435084, 1e-7, "REML tau2");
        close(t.pooled.lower, 0.0795466499665471, 1e-7, "REML lb");
        let t = trim_fill(&y, &v, Method::Dl, "L0").unwrap();
        close(t.pooled.estimate, 0.1739235284410204, 1e-9, "DL L0");
        close(t.se_k0, 4.0407613563821663, 1e-9, "DL se k0");
        let (y, v, ..) = crate::metareg::tests::bcg();
        let t = trim_fill(&y, &v, Method::Fe, "L0").unwrap();
        assert_eq!((t.k0, t.side.as_str()), (4, "right"));
        close(t.pooled.estimate, -0.291025992106353, 1e-9, "bcg FE");
        let t = trim_fill(&y, &v, Method::Reml, "L0").unwrap();
        assert_eq!(t.k0, 1);
        // trimfill refits the filled data with metafor's default REML threshold (1e-5), so
        // these two are checked to 1e-5.
        close(t.pooled.estimate, -0.657082800759582, 1e-5, "bcg REML");
        close(t.pooled.tau2, 0.331288037337963, 1e-5, "bcg REML tau2");
    }

    // metafor 5.2-1 run locally: selmodel(rma(yi, vi, data = dat.hackshaw1998, method = "ML"),
    // type = "stepfun", steps = 0.025). Tolerances: estimates 1e-5 (both optimise numerically),
    // Hessian-based SEs 1e-3 relative.
    #[test]
    fn selection_model_matches_metafor() {
        let (y, v) = hackshaw();
        let s = selection_model(&y, &v).unwrap();
        assert_eq!(s.counts, (7, 30));
        close(s.estimate, 0.1944015384483643, 1e-5, "mu");
        close(s.tau2, 0.0166226297124721, 1e-5, "tau2");
        close(s.delta, 0.7643952430381112, 1e-4, "delta");
        close(s.lrt, 0.1170527274824593, 1e-5, "LRT");
        close(s.lrt_p, 0.7322532918273646, 1e-5, "LRT p");
        close(s.se, 0.0797834814774927, 1e-3, "se mu");
        close(s.delta_se.unwrap(), 0.5989381992914546, 1e-3, "se delta");
        close(s.p, 0.0148255003931176, 1e-3, "p mu");
    }
}
