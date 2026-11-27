// Meta-regression: a mixed-effects model with continuous and categorical moderators (metafor's
// `rma(yi, vi, mods = ~ ..., method = "REML", test = "knha")`; Viechtbauer 2010), the R²
// analogue (Raudenbush 2009: share of τ² accounted for), residual heterogeneity (QE, I², H²),
// the omnibus test of the moderators (QM, or F under Knapp–Hartung), a permutation test
// (Higgins & Thompson 2004; metafor's permutest: exact when every permutation can be run, else
// random permutations with a fixed seed) and the data for a bubble plot.
//
// Categorical moderators use treatment contrasts with the first level (in sorted order) as the
// reference, as R does for a factor. The tests reproduce metafor 5.2-1 on dat.bcg.
use crate::linalg::Mat;
use crate::multilevel::{Coef, coefs, f_sf};
use crate::stats::chisq_sf;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ModValue {
    Num(f64),
    Cat(String),
    Missing,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Moderator {
    pub name: String,
    /// "continuous" | "categorical"
    pub kind: String,
    pub values: Vec<ModValue>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BubblePoint {
    pub id: String,
    pub label: String,
    pub x: f64,
    pub yi: f64,
    /// Percent weight in the model.
    pub weight: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BubbleLine {
    pub x: f64,
    pub fit: f64,
    pub lower: f64,
    pub upper: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bubble {
    pub moderator: String,
    pub points: Vec<BubblePoint>,
    pub line: Vec<BubbleLine>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permutation {
    pub iterations: usize,
    pub exact: bool,
    /// Per coefficient.
    pub p: Vec<f64>,
    pub qm_p: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaReg {
    pub coefficients: Vec<Coef>,
    pub method: String,
    pub test: String,
    pub k: usize,
    pub p: usize,
    pub tau2: f64,
    pub i2: f64,
    pub h2: f64,
    /// Percent of τ² accounted for by the moderators (None for a fixed-effect model).
    pub r2: Option<f64>,
    pub qe: f64,
    pub qe_df: usize,
    pub qe_p: f64,
    pub qm: f64,
    pub qm_df: (usize, Option<usize>),
    pub qm_p: f64,
    pub permutation: Option<Permutation>,
    pub bubble: Option<Bubble>,
    /// Studies left out (missing moderator values), by label.
    pub left_out: Vec<String>,
    pub warnings: Vec<String>,
}

/// The design matrix: intercept, then each moderator (dummies for categories).
pub fn design(mods: &[Moderator], rows: &[usize]) -> Result<(Mat, Vec<String>), String> {
    let mut cols: Vec<Vec<f64>> = vec![vec![1.0; rows.len()]];
    let mut names = vec!["Intercept".to_string()];
    for m in mods {
        if m.kind == "categorical" {
            let mut levels: Vec<String> = rows.iter().filter_map(|i| if let ModValue::Cat(s) = &m.values[*i] { Some(s.clone()) } else { None }).collect();
            levels.sort();
            levels.dedup();
            if levels.len() < 2 {
                return Err(format!("{} has only one category among these studies", m.name));
            }
            for l in &levels[1..] {
                cols.push(rows.iter().map(|i| if m.values[*i] == ModValue::Cat(l.clone()) { 1.0 } else { 0.0 }).collect());
                names.push(format!("{}: {l}", m.name));
            }
        } else {
            let c: Vec<f64> = rows.iter().map(|i| if let ModValue::Num(x) = m.values[*i] { x } else { f64::NAN }).collect();
            if c.iter().any(|x| !x.is_finite()) {
                return Err(format!("{} needs a number for every study", m.name));
            }
            let first = c[0];
            if c.iter().all(|x| (x - first).abs() < 1e-12) {
                return Err(format!("{} has the same value in every study", m.name));
            }
            cols.push(c);
            names.push(m.name.clone());
        }
    }
    let n = rows.len();
    let mut x = Mat::zeros(n, cols.len());
    for (j, c) in cols.iter().enumerate() {
        for i in 0..n {
            x[(i, j)] = c[i];
        }
    }
    Ok((x, names))
}

struct Wls {
    beta: Vec<f64>,
    vb: Mat,
    resid: Vec<f64>,
    w: Vec<f64>,
}

fn wls(y: &[f64], x: &Mat, w: &[f64]) -> Option<Wls> {
    let (n, p) = (y.len(), x.c);
    let mut xtwx = Mat::zeros(p, p);
    let mut xtwy = vec![0.0; p];
    for i in 0..n {
        for a in 0..p {
            xtwy[a] += w[i] * x[(i, a)] * y[i];
            for b in 0..p {
                xtwx[(a, b)] += w[i] * x[(i, a)] * x[(i, b)];
            }
        }
    }
    let vb = xtwx.inv_spd()?;
    let beta = vb.mul(&Mat::col(&xtwy)).v;
    let resid = (0..n).map(|i| y[i] - (0..p).map(|j| x[(i, j)] * beta[j]).sum::<f64>()).collect();
    Some(Wls { beta, vb, resid, w: w.to_vec() })
}

/// P = W − W X (X'WX)^-1 X' W for diagonal W.
fn p_matrix(x: &Mat, w: &[f64], vb: &Mat) -> Mat {
    let n = w.len();
    let wx = Mat { r: n, c: x.c, v: (0..n).flat_map(|i| (0..x.c).map(move |j| (i, j))).map(|(i, j)| w[i] * x[(i, j)]).collect() };
    let mut p = wx.mul(vb).mul(&wx.t()).scale(-1.0);
    for i in 0..n {
        p[(i, i)] += w[i];
    }
    p
}

/// τ² by REML (Fisher scoring as metafor's rma.uni), truncated at 0.
pub fn reml_tau2(y: &[f64], v: &[f64], x: &Mat) -> Result<f64, String> {
    let n = y.len();
    let mut tau2 = {
        // Start: a method-of-moments value from the fixed-effect residuals.
        let w: Vec<f64> = v.iter().map(|v| 1.0 / v).collect();
        let f = wls(y, x, &w).ok_or("The moderators are collinear")?;
        let p = p_matrix(x, &w, &f.vb);
        let qe: f64 = f.resid.iter().zip(&w).map(|(e, w)| w * e * e).sum();
        ((qe - (n - x.c) as f64) / p.trace()).max(0.0)
    };
    for _ in 0..1000 {
        let w: Vec<f64> = v.iter().map(|v| 1.0 / (v + tau2)).collect();
        let f = wls(y, x, &w).ok_or("The moderators are collinear")?;
        let p = p_matrix(x, &w, &f.vb);
        let py = p.mul(&Mat::col(y)).v;
        let ypp: f64 = py.iter().map(|a| a * a).sum();
        let tr_p = p.trace();
        let tr_pp: f64 = p.v.iter().map(|a| a * a).sum();
        let next = (tau2 + (ypp - tr_p) / tr_pp).max(0.0);
        if (next - tau2).abs() < 1e-12 * (1.0 + tau2) {
            return Ok(next);
        }
        tau2 = next;
    }
    Err("The REML estimate of τ² did not converge".into())
}

struct Core {
    beta: Vec<f64>,
    vb: Mat,
    stat: Vec<f64>,
    qm: f64,
    tau2: f64,
    s2: f64,
    w: Vec<f64>,
}

fn core(y: &[f64], v: &[f64], x: &Mat, random: bool, knha: bool) -> Result<Core, String> {
    let (k, p) = (y.len(), x.c);
    let tau2 = if random { reml_tau2(y, v, x)? } else { 0.0 };
    let w: Vec<f64> = v.iter().map(|v| 1.0 / (v + tau2)).collect();
    let f = wls(y, x, &w).ok_or("The moderators are collinear")?;
    let s2 = if knha { f.resid.iter().zip(&f.w).map(|(e, w)| w * e * e).sum::<f64>() / (k - p) as f64 } else { 1.0 };
    let vb = f.vb.scale(s2);
    let stat: Vec<f64> = (0..p).map(|j| f.beta[j] / vb[(j, j)].sqrt()).collect();
    // Omnibus test of every coefficient but the intercept.
    let qm = if p > 1 {
        let idx: Vec<usize> = (1..p).collect();
        let sub = vb.select(&idx, &idx).inv_spd().ok_or("The moderators are collinear")?;
        let b = Mat::col(&idx.iter().map(|j| f.beta[*j]).collect::<Vec<_>>());
        let q = b.t().mul(&sub).mul(&b).v[0];
        if knha { q / (p - 1) as f64 } else { q }
    } else {
        0.0
    };
    Ok(Core { beta: f.beta, vb, stat, qm, tau2, s2, w })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RegOptions {
    /// "reml" (default) or "fe".
    pub method: String,
    pub knapp_hartung: bool,
    pub permutations: usize,
    pub level: f64,
    pub seed: u64,
}

impl Default for RegOptions {
    fn default() -> Self {
        RegOptions { method: "reml".into(), knapp_hartung: true, permutations: 0, level: 0.95, seed: 20_240_601 }
    }
}

/// A small deterministic generator (splitmix64) for random permutations.
pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    pub fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            let j = self.below(i + 1);
            v.swap(i, j);
        }
    }
}

fn permutations(k: usize) -> Vec<Vec<usize>> {
    // Heap's algorithm.
    let mut a: Vec<usize> = (0..k).collect();
    let mut out = vec![a.clone()];
    let mut c = vec![0; k];
    let mut i = 0;
    while i < k {
        if c[i] < i {
            if i % 2 == 0 { a.swap(0, i) } else { a.swap(c[i], i) }
            out.push(a.clone());
            c[i] += 1;
            i = 0;
        } else {
            c[i] = 0;
            i += 1;
        }
    }
    out
}

/// Meta-regression of effects `yi` (variances `vi`) on the moderators.
pub fn metareg(ids: &[String], labels: &[String], yi: &[f64], vi: &[f64], mods: &[Moderator], o: &RegOptions) -> Result<MetaReg, String> {
    if mods.is_empty() {
        return Err("Choose at least one moderator".into());
    }
    let rows: Vec<usize> = (0..yi.len()).filter(|i| mods.iter().all(|m| m.values.get(*i).is_some_and(|v| *v != ModValue::Missing))).collect();
    let left_out: Vec<String> = (0..yi.len()).filter(|i| !rows.contains(i)).map(|i| labels[i].clone()).collect();
    let (x, names) = design(mods, &rows)?;
    let y: Vec<f64> = rows.iter().map(|i| yi[*i]).collect();
    let v: Vec<f64> = rows.iter().map(|i| vi[*i]).collect();
    let (k, p) = (y.len(), x.c);
    if k <= p + 1 {
        return Err(format!("A model with {} coefficients needs more than {} studies with values", p, p + 1));
    }
    let random = o.method != "fe";
    let knha = o.knapp_hartung && random;
    let c = core(&y, &v, &x, random, knha)?;
    let df = if knha { Some((k - p) as f64) } else { None };
    let coefficients = coefs(&names, &c.beta, &c.vb, &vec![df; p], o.level);
    // Residual heterogeneity from the fixed-effect fit.
    let w0: Vec<f64> = v.iter().map(|v| 1.0 / v).collect();
    let fe = wls(&y, &x, &w0).ok_or("The moderators are collinear")?;
    let qe: f64 = fe.resid.iter().zip(&w0).map(|(e, w)| w * e * e).sum();
    let p0 = p_matrix(&x, &w0, &fe.vb);
    let vt = (k - p) as f64 / p0.trace();
    let (i2, h2) = if random { (100.0 * c.tau2 / (c.tau2 + vt), (c.tau2 + vt) / vt) } else { (((qe - (k - p) as f64) / qe).max(0.0) * 100.0, qe / (k - p) as f64) };
    let r2 = if random {
        let ones = Mat { r: k, c: 1, v: vec![1.0; k] };
        let t0 = reml_tau2(&y, &v, &ones)?;
        Some(if t0 > 0.0 { (100.0 * (t0 - c.tau2) / t0).max(0.0) } else { 0.0 })
    } else {
        None
    };
    let m = p - 1;
    let (qm_df, qm_p) = if knha { ((m, Some(k - p)), f_sf(c.qm, m as f64, (k - p) as f64)) } else { ((m, None), chisq_sf(c.qm, m as f64)) };
    // Permutation test: permute the moderators' rows against (yi, vi).
    let permutation = (o.permutations > 0).then(|| {
        let exact_count = (1..=k).try_fold(1usize, |a, b| a.checked_mul(b));
        let exact = exact_count.is_some_and(|n| n <= o.permutations.max(1));
        let perms: Vec<Vec<usize>> = if exact {
            permutations(k)
        } else {
            let mut rng = Rng(o.seed);
            let mut out = vec![(0..k).collect::<Vec<_>>()];
            while out.len() < o.permutations {
                let mut a: Vec<usize> = (0..k).collect();
                rng.shuffle(&mut a);
                out.push(a);
            }
            out
        };
        let tol = f64::EPSILON.sqrt();
        let mut hits = vec![0usize; p];
        let mut qm_hits = 0usize;
        let mut done = 0usize;
        for perm in &perms {
            let xp = x.rows(perm);
            let Ok(r) = core(&y, &v, &xp, random, knha) else { continue };
            done += 1;
            for j in 0..p {
                if r.stat[j].abs() >= c.stat[j].abs() - tol {
                    hits[j] += 1;
                }
            }
            if r.qm >= c.qm - tol {
                qm_hits += 1;
            }
        }
        Permutation { iterations: done, exact, p: hits.iter().map(|h| *h as f64 / done.max(1) as f64).collect(), qm_p: qm_hits as f64 / done.max(1) as f64 }
    });
    // Bubble plot: one continuous moderator.
    let bubble = (mods.len() == 1 && mods[0].kind != "categorical").then(|| {
        let total: f64 = c.w.iter().sum();
        let xs: Vec<f64> = (0..k).map(|i| x[(i, 1)]).collect();
        let (lo, hi) = xs.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), v| (a.min(*v), b.max(*v)));
        let crit = coefficients[0].upper - coefficients[0].estimate;
        let crit = crit / coefficients[0].se;
        let line = (0..=40)
            .map(|s| {
                let xv = lo + (hi - lo) * s as f64 / 40.0;
                let fit = c.beta[0] + c.beta[1] * xv;
                let var = c.vb[(0, 0)] + 2.0 * xv * c.vb[(0, 1)] + xv * xv * c.vb[(1, 1)];
                BubbleLine { x: xv, fit, lower: fit - crit * var.sqrt(), upper: fit + crit * var.sqrt() }
            })
            .collect();
        Bubble { moderator: mods[0].name.clone(), points: rows.iter().enumerate().map(|(j, i)| BubblePoint { id: ids[*i].clone(), label: labels[*i].clone(), x: xs[j], yi: y[j], weight: 100.0 * c.w[j] / total }).collect(), line }
    });
    let mut warnings = Vec::new();
    let covariates = p - 1;
    if k < 10 * covariates {
        warnings.push(format!(
            "{k} studies for {covariates} moderator term{}: a common rule of thumb asks for about 10 studies per term (Cochrane Handbook, section 10.11.5), so treat these results as exploratory.",
            if covariates == 1 { "" } else { "s" }
        ));
    }
    if !left_out.is_empty() {
        warnings.push(format!("Left out for missing moderator values: {}.", left_out.join(", ")));
    }
    let _ = c.s2;
    Ok(MetaReg {
        coefficients,
        method: if random { "REML".into() } else { "Fixed effect".into() },
        test: if knha { "Knapp–Hartung t (and F)".into() } else { "z (and χ²)".into() },
        k,
        p,
        tau2: c.tau2,
        i2,
        h2,
        r2,
        qe,
        qe_df: k - p,
        qe_p: chisq_sf(qe, (k - p) as f64),
        qm: c.qm,
        qm_df,
        qm_p,
        permutation,
        bubble,
        left_out,
        warnings,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// dat.bcg log risk ratios (escalc "RR") with absolute latitude, year and allocation.
    pub fn bcg() -> (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>, Vec<String>) {
        let tbl: [(f64, f64, f64, f64); 13] = [(4., 119., 11., 128.), (6., 300., 29., 274.), (3., 228., 11., 209.), (62., 13536., 248., 12619.), (33., 5036., 47., 5761.), (180., 1361., 372., 1079.), (8., 2537., 10., 619.), (505., 87886., 499., 87892.), (29., 7470., 45., 7232.), (17., 1699., 65., 1600.), (186., 50448., 141., 27197.), (5., 2493., 3., 2338.), (27., 16886., 29., 17825.)];
        let ablat = [44., 55., 42., 52., 13., 44., 19., 13., 27., 42., 18., 33., 33.];
        let year = [1948., 1949., 1960., 1977., 1973., 1953., 1973., 1980., 1968., 1961., 1974., 1969., 1976.];
        let alloc = ["random", "random", "random", "random", "alternate", "alternate", "random", "random", "random", "systematic", "systematic", "systematic", "systematic"];
        let yi = tbl.iter().map(|(a, b, c, d)| ((a / (a + b)) / (c / (c + d))).ln()).collect();
        let vi = tbl.iter().map(|(a, b, c, d)| 1.0 / a - 1.0 / (a + b) + 1.0 / c - 1.0 / (c + d)).collect();
        (yi, vi, ablat.to_vec(), year.to_vec(), alloc.iter().map(|s| s.to_string()).collect())
    }

    fn close(a: f64, b: f64, tol: f64, what: &str) {
        assert!((a - b).abs() <= tol * (1.0 + b.abs()), "{what}: {a} vs {b}");
    }

    fn num(name: &str, v: &[f64]) -> Moderator {
        Moderator { name: name.into(), kind: "continuous".into(), values: v.iter().map(|x| ModValue::Num(*x)).collect() }
    }

    fn run(mods: &[Moderator], n: usize, o: &RegOptions) -> MetaReg {
        let (yi, vi, ..) = bcg();
        let ids: Vec<String> = (0..n).map(|i| format!("s{i}")).collect();
        let mods: Vec<Moderator> = mods.iter().map(|m| Moderator { values: m.values[..n].to_vec(), ..m.clone() }).collect();
        metareg(&ids, &ids, &yi[..n], &vi[..n], &mods, o).unwrap()
    }

    // Reference: metafor 5.2-1 run locally, `rma(yi, vi, mods = ..., data = escalc("RR", ...,
    // data = dat.bcg), test = ..., control = list(threshold = 1e-14))`. Relative tolerance 1e-7.
    #[test]
    fn meta_regression_matches_metafor() {
        let (_, _, ablat, year, alloc) = bcg();
        let z = RegOptions { knapp_hartung: false, ..Default::default() };
        let r = run(&[num("ablat", &ablat)], 13, &z);
        close(r.coefficients[0].estimate, 0.2514682100073686, 1e-7, "b0");
        close(r.coefficients[1].estimate, -0.0291017250116496, 1e-7, "b1");
        close(r.coefficients[1].se, 0.00719532722090451, 1e-7, "se1");
        close(r.coefficients[1].p, 5.24279397380937e-05, 1e-6, "p1");
        close(r.tau2, 0.0763479639552026, 1e-7, "tau2");
        close(r.i2, 68.3912248381823, 1e-7, "I2");
        close(r.h2, 3.16367842436351, 1e-7, "H2");
        close(r.r2.unwrap(), 75.6266218116217, 1e-6, "R2");
        close(r.qe, 30.7330900107493, 1e-9, "QE");
        close(r.qe_p, 0.00121429098742, 1e-7, "QEp");
        close(r.qm, 16.3582321471645, 1e-7, "QM");
        let h = run(&[num("ablat", &ablat)], 13, &RegOptions::default());
        close(h.coefficients[0].se, 0.2839252837433832, 1e-7, "knha se0");
        close(h.coefficients[1].se, 0.0082014174110366, 1e-7, "knha se1");
        close(h.coefficients[1].p, 0.00456505154154006, 1e-6, "knha p1");
        close(h.coefficients[1].lower, -0.0471529230250583, 1e-7, "knha lb1");
        close(h.coefficients[1].upper, -0.0110505269982409, 1e-7, "knha ub1");
        close(h.qm, 12.5909828844264, 1e-7, "F");
        close(h.qm_p, 0.00456505154154006, 1e-6, "F p");
        assert_eq!(h.qm_df, (1, Some(11)));
        assert!(h.bubble.is_some());
        let cat = Moderator { name: "alloc".into(), kind: "categorical".into(), values: alloc.iter().map(|s| ModValue::Cat(s.clone())).collect() };
        let a = run(&[cat], 13, &RegOptions::default());
        assert_eq!(a.coefficients[1].name, "alloc: random");
        close(a.coefficients[0].estimate, -0.5179557771552931, 1e-7, "alloc b0");
        close(a.coefficients[1].estimate, -0.4478184013905528, 1e-7, "alloc random");
        close(a.coefficients[2].estimate, 0.0890382162317167, 1e-7, "alloc systematic");
        close(a.coefficients[2].se, 0.535603661854896, 1e-7, "alloc se2");
        close(a.tau2, 0.361503664324021, 1e-7, "alloc tau2");
        close(a.r2.unwrap(), 0.0, 1e-12, "alloc R2 truncated");
        close(a.qm, 0.966220844813434, 1e-7, "alloc F");
        close(a.qm_p, 0.41338374572162, 1e-6, "alloc F p");
        close(a.qe, 132.367638262708, 1e-9, "alloc QE");
        let two = run(&[num("ablat", &ablat), num("year", &year)], 13, &RegOptions::default());
        close(two.coefficients[0].estimate, -3.54535301991095331, 1e-6, "2 b0");
        close(two.coefficients[1].estimate, -0.02801132944421413, 1e-7, "2 b1");
        close(two.coefficients[2].se, 0.0162788048736501, 1e-6, "2 se2");
        close(two.tau2, 0.110784696947626, 1e-7, "2 tau2");
        close(two.r2.unwrap(), 64.6330147353542, 1e-6, "2 R2");
        close(two.qm_p, 0.0318035012858451, 1e-6, "2 F p");
        assert!(two.warnings.iter().any(|w| w.contains("10 studies per term")));
        let fe = run(&[num("ablat", &ablat)], 13, &RegOptions { method: "fe".into(), ..Default::default() });
        close(fe.coefficients[0].estimate, 0.3435645774465904, 1e-9, "FE b0");
        close(fe.coefficients[1].se, 0.00265242943424623, 1e-9, "FE se1");
        close(fe.qm, 121.499918071624, 1e-9, "FE QM");
        close(fe.i2, 64.2079595766238, 1e-9, "FE I2");
    }

    // permutest(rma(yi, vi, mods = ~ ablat, data = dat[1:7, ], test = ...), exact = TRUE),
    // metafor 5.2-1 run locally: exact p-values (2520 unique permutations; enumerating all 5040
    // gives the same proportions). Tolerance 1e-12.
    #[test]
    fn exact_permutation_test_matches_metafor() {
        let (_, _, ablat, ..) = bcg();
        let o = RegOptions { permutations: 10_000, ..Default::default() };
        let r = run(&[num("ablat", &ablat)], 7, &o);
        close(r.tau2, 0.130446824954758, 1e-7, "tau2 (7)");
        close(r.r2.unwrap(), 41.0782891382342, 1e-6, "R2 (7)");
        let p = r.permutation.unwrap();
        assert!(p.exact);
        close(p.p[0], 0.925, 1e-12, "perm p0");
        close(p.p[1], 0.200396825396825, 1e-12, "perm p1");
        close(p.qm_p, 0.200396825396825, 1e-12, "perm QM");
        let z = run(&[num("ablat", &ablat)], 7, &RegOptions { knapp_hartung: false, ..o });
        let p = z.permutation.unwrap();
        close(p.p[0], 0.917063492063492, 1e-12, "perm z p0");
        close(p.p[1], 0.184126984126984, 1e-12, "perm z p1");
    }
}
