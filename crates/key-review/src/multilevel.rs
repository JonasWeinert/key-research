// Linear mixed models for meta-analysis, the general engine behind meta-regression, three-level
// models and robust variance estimation. The model is y = Xβ + u + e with Var(e) = V (sampling
// variances, possibly correlated within a study) and Var(u) = Σ_k σ²_k G_k (G_k: 0/1 matrices,
// one per level of random effects). Variance components by REML (Fisher scoring with step
// halving, as metafor's rma.mv/rma.uni maximise the same restricted likelihood; Viechtbauer
// 2010), fixed effects by generalised least squares.
//
// Cluster-robust variance: CR2 ("bias-reduced linearisation", Bell & McCaffrey 2002) with the
// fitted model as working model and Satterthwaite degrees of freedom per coefficient, as in
// clubSandwich (Pustejovsky & Tipton 2018, J Bus Econ Stat 36(4); Tipton 2015, Psychol
// Methods 20(3)). The tests check documented clubSandwich results printed in metafor's
// robust() reference page.
use crate::linalg::Mat;
use crate::stats::{beta_inc, norm_p2, norm_quantile, t_p2, t_quantile};
use serde::Serialize;

pub struct Design {
    pub y: Vec<f64>,
    /// Sampling covariance (n × n).
    pub v: Mat,
    /// Fixed-effects design (n × p), first column usually the intercept.
    pub x: Mat,
    /// Random-effects structure matrices G_k (n × n).
    pub g: Vec<Mat>,
}

#[derive(Clone, Debug)]
pub struct Fit {
    pub beta: Vec<f64>,
    /// Model-based covariance of beta, (X'WX)^-1.
    pub vb: Mat,
    pub sigma2: Vec<f64>,
    /// Marginal covariance V + Σ σ²G and its inverse.
    pub vm: Mat,
    pub w: Mat,
    pub resid: Vec<f64>,
    /// REML log-likelihood, with metafor's constants.
    pub ll: f64,
    pub n: usize,
    pub p: usize,
}

/// Indicator matrix of rows sharing a label (random effect of a grouping).
pub fn same_group(labels: &[String]) -> Mat {
    let n = labels.len();
    let mut m = Mat::zeros(n, n);
    for i in 0..n {
        for j in 0..n {
            if labels[i] == labels[j] {
                m[(i, j)] = 1.0;
            }
        }
    }
    m
}

fn marginal(d: &Design, s: &[f64]) -> Mat {
    let mut v = d.v.clone();
    for (g, s) in d.g.iter().zip(s) {
        v = v.add(&g.scale(*s));
    }
    v
}

struct Parts {
    vm: Mat,
    w: Mat,
    beta: Vec<f64>,
    vb: Mat,
    p: Mat,
    ll: f64,
}

fn parts(d: &Design, s: &[f64]) -> Option<Parts> {
    let vm = marginal(d, s);
    let w = vm.inv_spd()?;
    let xt = d.x.t();
    let xtw = xt.mul(&w);
    let xtwx = xtw.mul(&d.x);
    let vb = xtwx.inv_spd()?;
    let beta = vb.mul(&xtw).mul(&Mat::col(&d.y)).v;
    // P = W - W X (X'WX)^-1 X' W
    let wx = w.mul(&d.x);
    let p = w.sub(&wx.mul(&vb).mul(&xtw));
    let y = Mat::col(&d.y);
    let rss = y.t().mul(&p).mul(&y).v[0];
    let n = d.y.len() as f64;
    let pp = d.x.c as f64;
    let ll = -0.5 * (n - pp) * (2.0 * std::f64::consts::PI).ln() + 0.5 * xt.mul(&d.x).logdet_spd()? - 0.5 * vm.logdet_spd()? - 0.5 * xtwx.logdet_spd()? - 0.5 * rss;
    Some(Parts { vm, w, beta, vb, p, ll })
}

/// Fits by REML. `start` gives starting values (else a share of the residual variance).
pub fn fit_reml(d: &Design, start: Option<&[f64]>) -> Result<Fit, String> {
    let n = d.y.len();
    let p = d.x.c;
    if n <= p {
        return Err(format!("Needs more than {p} estimates for this model"));
    }
    let m = d.g.len();
    let mut s: Vec<f64> = match start {
        Some(x) => x.to_vec(),
        None => {
            let mean = d.y.iter().sum::<f64>() / n as f64;
            let var = d.y.iter().map(|y| (y - mean).powi(2)).sum::<f64>() / (n as f64 - 1.0);
            let vbar = (0..n).map(|i| d.v[(i, i)]).sum::<f64>() / n as f64;
            vec![((var - vbar).max(0.01 * var.max(1e-8))) / m.max(1) as f64; m]
        }
    };
    let mut cur = parts(d, &s).ok_or("The model could not be fitted (a variance matrix is not positive definite)")?;
    for _ in 0..500 {
        if m == 0 {
            break;
        }
        // Score and expected information of the restricted likelihood.
        let py = cur.p.mul(&Mat::col(&d.y));
        let pg: Vec<Mat> = d.g.iter().map(|g| cur.p.mul(g)).collect();
        let score: Vec<f64> = (0..m).map(|k| -0.5 * pg[k].trace() + 0.5 * py.t().mul(&d.g[k]).mul(&py).v[0]).collect();
        let mut info = Mat::zeros(m, m);
        for a in 0..m {
            for b in a..m {
                let t: f64 = (0..n).map(|i| (0..n).map(|j| pg[a][(i, j)] * pg[b][(j, i)]).sum::<f64>()).sum();
                info[(a, b)] = 0.5 * t;
                info[(b, a)] = 0.5 * t;
            }
        }
        // Components at 0 with a negative score stay at the boundary.
        let free: Vec<usize> = (0..m).filter(|k| s[*k] > 0.0 || score[*k] > 0.0).collect();
        if free.is_empty() {
            break;
        }
        let sub = info.select(&free, &free);
        let step_free = match sub.inv_spd() {
            Some(inv) => inv.mul(&Mat::col(&free.iter().map(|k| score[*k]).collect::<Vec<_>>())).v,
            None => free.iter().map(|k| score[*k] / info[(*k, *k)].max(1e-12)).collect(),
        };
        let mut step = vec![0.0; m];
        for (i, k) in free.iter().enumerate() {
            step[*k] = step_free[i];
        }
        let mut factor = 1.0;
        let mut next = None;
        for _ in 0..30 {
            let trial: Vec<f64> = s.iter().zip(&step).map(|(a, b)| (a + factor * b).max(0.0)).collect();
            if let Some(pt) = parts(d, &trial)
                && pt.ll >= cur.ll - 1e-12
            {
                next = Some((trial, pt));
                break;
            }
            factor /= 2.0;
        }
        let Some((trial, pt)) = next else { break };
        let change = trial.iter().zip(&s).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
        let gain = pt.ll - cur.ll;
        s = trial;
        cur = pt;
        if change < 1e-10 * (1.0 + s.iter().fold(0.0f64, |a, b| a.max(*b))) || (gain.abs() < 1e-14 && change < 1e-8) {
            break;
        }
    }
    let resid: Vec<f64> = (0..n).map(|i| d.y[i] - (0..p).map(|j| d.x[(i, j)] * cur.beta[j]).sum::<f64>()).collect();
    Ok(Fit { beta: cur.beta, vb: cur.vb, sigma2: s, vm: cur.vm, w: cur.w, resid, ll: cur.ll, n, p })
}

/// Fits with known variance components (fixed effect: none).
pub fn fit_fixed(d: &Design, s: &[f64]) -> Result<Fit, String> {
    let cur = parts(d, s).ok_or("The model could not be fitted (a variance matrix is not positive definite)")?;
    let (n, p) = (d.y.len(), d.x.c);
    let resid: Vec<f64> = (0..n).map(|i| d.y[i] - (0..p).map(|j| d.x[(i, j)] * cur.beta[j]).sum::<f64>()).collect();
    Ok(Fit { beta: cur.beta, vb: cur.vb, sigma2: s.to_vec(), vm: cur.vm, w: cur.w, resid, ll: cur.ll, n, p })
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Coef {
    pub name: String,
    pub estimate: f64,
    pub se: f64,
    /// z, or t with `df`.
    pub statistic: f64,
    pub df: Option<f64>,
    pub p: f64,
    pub lower: f64,
    pub upper: f64,
}

/// Coefficients with z tests (df None) or t tests on `df`.
pub fn coefs(names: &[String], beta: &[f64], vb: &Mat, df: &[Option<f64>], level: f64) -> Vec<Coef> {
    let alpha = 1.0 - level;
    beta.iter()
        .enumerate()
        .map(|(j, b)| {
            let se = vb[(j, j)].sqrt();
            let stat = b / se;
            let (crit, p) = match df[j] {
                Some(df) => (t_quantile(1.0 - alpha / 2.0, df), t_p2(stat, df)),
                None => (norm_quantile(1.0 - alpha / 2.0), norm_p2(stat)),
            };
            Coef { name: names.get(j).cloned().unwrap_or_default(), estimate: *b, se, statistic: stat, df: df[j], p, lower: b - crit * se, upper: b + crit * se }
        })
        .collect()
}

/// Upper tail of the F distribution.
pub fn f_sf(f: f64, d1: f64, d2: f64) -> f64 {
    if !(f > 0.0) {
        return 1.0;
    }
    beta_inc(d2 / 2.0, d1 / 2.0, d2 / (d2 + d1 * f))
}

#[derive(Clone, Debug)]
pub struct Robust {
    /// CR2 covariance of beta.
    pub vcov: Mat,
    /// Satterthwaite degrees of freedom per coefficient.
    pub df: Vec<f64>,
    pub clusters: usize,
}

/// CR2 cluster-robust covariance with Satterthwaite df, the fitted marginal covariance as the
/// working model (clubSandwich's `vcovCR(type = "CR2")` and `coef_test(test = "Satterthwaite")`).
/// `cluster` gives each row's cluster; the model's covariance must not link rows of different
/// clusters.
pub fn cr2(d: &Design, fit: &Fit, cluster: &[String]) -> Result<Robust, String> {
    let n = fit.n;
    let mut ids: Vec<String> = cluster.to_vec();
    ids.sort();
    ids.dedup();
    let groups: Vec<Vec<usize>> = ids.iter().map(|c| (0..n).filter(|i| &cluster[*i] == c).collect()).collect();
    for i in 0..n {
        for j in 0..n {
            if cluster[i] != cluster[j] && fit.vm[(i, j)].abs() > 1e-14 {
                return Err("Estimates that are correlated in the model must be in the same cluster".into());
            }
        }
    }
    if groups.len() < 2 {
        return Err("Robust variance needs at least two studies".into());
    }
    let phi = &fit.vm;
    let w = &fit.w;
    let m = &fit.vb;
    let x = &d.x;
    // I - H, with H = X M X' W.
    let ih = Mat::eye(n).sub(&x.mul(m).mul(&x.t()).mul(w));
    let mut a_list = Vec::new();
    for g in &groups {
        let phi_j = phi.select(g, g);
        // Upper-triangular D with Φ_j = D'D.
        let d_up = phi_j.cholesky().ok_or("A study's covariance is not positive definite")?.t();
        let ih_j = ih.rows(g);
        let b = d_up.mul(&ih_j).mul(phi).mul(&ih_j.t()).mul(&d_up.t());
        let a = d_up.t().mul(&b.sym_pow(-0.5)).mul(&d_up);
        a_list.push(a);
    }
    let p = x.c;
    // Per cluster: E_j = M X_j' W_j A_j (p × n_j); its product with the residuals is the cluster's
    // contribution to the estimating equation.
    let mut meat = Mat::zeros(p, p);
    let mut e_list = Vec::new();
    for (g, a) in groups.iter().zip(&a_list) {
        let xj = x.rows(g);
        let wj = w.select(g, g);
        let ej = m.mul(&xj.t()).mul(&wj).mul(a);
        let r = Mat::col(&g.iter().map(|i| fit.resid[*i]).collect::<Vec<_>>());
        let u = ej.mul(&r);
        meat = meat.add(&u.mul(&u.t()));
        e_list.push(ej);
    }
    // Satterthwaite: for coefficient c, g_j = (I − H)_j' E_j' c (n-vector).
    let mut df = Vec::with_capacity(p);
    for c in 0..p {
        let gs: Vec<Vec<f64>> = groups
            .iter()
            .zip(&e_list)
            .map(|(g, ej)| {
                let row: Vec<f64> = (0..ej.c).map(|k| ej[(c, k)]).collect();
                let ih_j = ih.rows(g);
                (0..n).map(|col| (0..g.len()).map(|k| ih_j[(k, col)] * row[k]).sum()).collect()
            })
            .collect();
        let pg: Vec<Vec<f64>> = gs.iter().map(|gv| phi.mul(&Mat::col(gv)).v).collect();
        let dot = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f64>();
        let num: f64 = gs.iter().zip(&pg).map(|(a, b)| dot(a, b)).sum::<f64>().powi(2);
        let mut den = 0.0;
        for i in 0..gs.len() {
            for j in 0..gs.len() {
                den += dot(&gs[i], &pg[j]).powi(2);
            }
        }
        df.push(if den > 0.0 { num / den } else { f64::NAN });
    }
    Ok(Robust { vcov: meat, df, clusters: groups.len() })
}

#[cfg(test)]
pub(crate) mod testdata {
    /// metafor/metadat `dat.konstantopoulos2011` (Konstantopoulos 2011, Res Synth Methods 2:61):
    /// district, school, yi, vi.
    pub const KONSTANTOPOULOS: &str = include_str!("testdata/konstantopoulos2011.csv");
    /// metadat `dat.bangertdrowns2004` (Bangert-Drowns et al. 2004, Rev Educ Res 74:29): id,
    /// length (NA for two studies), yi, vi.
    pub const BANGERTDROWNS: &str = include_str!("testdata/bangertdrowns2004.csv");

    pub fn rows(text: &str) -> Vec<Vec<String>> {
        text.lines().skip(1).filter(|l| !l.trim().is_empty()).map(|l| l.split(',').map(|c| c.trim().trim_matches('"').to_string()).collect()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::testdata::*;
    use super::*;

    fn close(a: f64, b: f64, tol: f64, what: &str) {
        assert!((a - b).abs() <= tol, "{what}: {a} vs {b}");
    }

    fn konst() -> (Design, Vec<String>) {
        let r = rows(KONSTANTOPOULOS);
        let y: Vec<f64> = r.iter().map(|x| x[4].parse().unwrap()).collect();
        let v: Vec<f64> = r.iter().map(|x| x[5].parse().unwrap()).collect();
        let district: Vec<String> = r.iter().map(|x| x[0].clone()).collect();
        let school: Vec<String> = r.iter().map(|x| format!("{}/{}", x[0], x[1])).collect();
        let n = y.len();
        (Design { y, v: Mat::diag(&v), x: Mat { r: n, c: 1, v: vec![1.0; n] }, g: vec![same_group(&district), same_group(&school)] }, district)
    }

    // metafor 5.2-1, rma.mv(yi, vi, random = ~ 1 | district/school, data = dat.konstantopoulos2011)
    // run locally: b, se, sigma2, logLik. Tolerance 1e-6 (metafor's optimiser stops near there).
    #[test]
    fn three_level_model_matches_metafor() {
        let (d, district) = konst();
        let f = fit_reml(&d, None).unwrap();
        close(f.beta[0], 0.1847131636774042, 1e-6, "b");
        close(f.vb[(0, 0)].sqrt(), 0.0845559187732407, 1e-6, "se");
        close(f.sigma2[0], 0.0650619443355097, 1e-6, "sigma2 district");
        close(f.sigma2[1], 0.0327365170146650, 1e-6, "sigma2 school");
        close(f.ll, -7.9587240337109399, 1e-6, "logLik");
        // robust(res, cluster = district, clubSandwich = TRUE), as printed in metafor's robust()
        // reference page: se 0.0845, t 2.1870, df 9.86, p 0.0540, CI −0.0038 to 0.3733 (4 dp).
        let r = cr2(&d, &f, &district).unwrap();
        let c = coefs(&["intrcpt".into()], &f.beta, &r.vcov, &[Some(r.df[0])], 0.95);
        close(c[0].se, 0.0845, 5e-5, "CR2 se");
        close(c[0].statistic, 2.1870, 5e-4, "CR2 t");
        close(r.df[0], 9.86, 5e-3, "CR2 df");
        close(c[0].p, 0.0540, 5e-5, "CR2 p");
        close(c[0].lower, -0.0038, 5e-5, "CR2 lower");
        close(c[0].upper, 0.3733, 5e-5, "CR2 upper");
    }

    fn bd(with_length: bool) -> (Design, Vec<String>) {
        let r: Vec<Vec<String>> = rows(BANGERTDROWNS).into_iter().filter(|x| !with_length || x[1] != "NA").collect();
        let y: Vec<f64> = r.iter().map(|x| x[2].parse().unwrap()).collect();
        let v: Vec<f64> = r.iter().map(|x| x[3].parse().unwrap()).collect();
        let n = y.len();
        let x = if with_length { Mat::from_rows(&r.iter().map(|x| vec![1.0, x[1].parse().unwrap()]).collect::<Vec<_>>()) } else { Mat { r: n, c: 1, v: vec![1.0; n] } };
        (Design { y, v: Mat::diag(&v), x, g: vec![Mat::eye(n)] }, r.iter().map(|x| x[0].clone()).collect())
    }

    // metafor's robust() reference page, dat.bangertdrowns2004, `clubSandwich = TRUE` (CR2,
    // Satterthwaite), printed to 4 decimals (df to 2): tolerance half a unit in the last place.
    #[test]
    fn cr2_matches_clubsandwich_on_bangert_drowns() {
        let (d, id) = bd(false);
        let f = fit_reml(&d, None).unwrap();
        // rma(yi, vi, control = list(threshold = 1e-14)) run locally (metafor's default
        // threshold stops earlier).
        close(f.beta[0], 0.2219286216846572, 1e-8, "b (rma)");
        close(f.sigma2[0], 0.0499386743451695, 1e-8, "tau2 (rma)");
        let r = cr2(&d, &f, &id).unwrap();
        let c = coefs(&["intrcpt".into()], &f.beta, &r.vcov, &[Some(r.df[0])], 0.95);
        close(c[0].se, 0.0460, 5e-5, "se");
        close(c[0].statistic, 4.8280, 5e-4, "t");
        close(r.df[0], 41.04, 5e-3, "df");
        close(c[0].lower, 0.1291, 5e-5, "lower");
        close(c[0].upper, 0.3148, 5e-5, "upper");
        let (d, id) = bd(true);
        let f = fit_reml(&d, None).unwrap();
        close(f.beta[1], 0.0149416774999058, 1e-8, "b length (rma)");
        close(f.sigma2[0], 0.0440990042877396, 1e-8, "tau2 mods (rma)");
        let r = cr2(&d, &f, &id).unwrap();
        let c = coefs(&["intrcpt".into(), "length".into()], &f.beta, &r.vcov, &[Some(r.df[0]), Some(r.df[1])], 0.95);
        close(c[0].se, 0.0655, 5e-5, "intercept se");
        close(r.df[0], 16.51, 5e-3, "intercept df");
        close(c[0].p, 0.3062, 5e-5, "intercept p");
        close(c[1].se, 0.0059, 5e-5, "length se");
        close(c[1].statistic, 2.5290, 5e-4, "length t");
        close(r.df[1], 19.16, 5e-3, "length df");
        close(c[1].p, 0.0204, 5e-5, "length p");
        close(c[1].lower, 0.0026, 5e-5, "length lower");
        close(c[1].upper, 0.0273, 5e-5, "length upper");
    }
}
