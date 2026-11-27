// Several estimates per study. Three ways, as a chooser in the Analysis stage:
// - "three-level": a multilevel random-effects model, estimates nested in studies (REML;
//   Konstantopoulos 2011; Van den Noortgate et al. 2013), metafor's
//   `rma.mv(yi, vi, random = ~ 1 | study/estimate)`.
// - "che": correlated and hierarchical effects with robust variance (Pustejovsky & Tipton 2022,
//   Prev Sci 23:425): sampling errors within a study correlated at a value the reviewer sets
//   (metafor's vcalc(rho = …)), the three-level model on that covariance, and CR2 cluster-robust
//   standard errors with Satterthwaite df clustered by study (clubSandwich).
// - "aggregate": one effect per study, combining its estimates under the same assumed
//   correlation (metafor's aggregate.escalc(rho = …)), then the usual model.
// Moderators may be added (meta-regression with dependent effects).
use crate::linalg::Mat;
use crate::meta::{Effect, Method, Pooled, pool};
use crate::metareg::{Moderator, design};
use crate::multilevel::{Coef, Design, coefs, cr2, fit_reml, same_group};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DepOptions {
    /// "three-level" | "che" | "aggregate"
    pub model: String,
    /// Assumed correlation of estimates within a study (che, aggregate).
    pub rho: f64,
    /// Add CR2 robust standard errors to the three-level model too.
    pub robust: bool,
    /// For "aggregate": the model for the per-study effects.
    pub method: Method,
    pub hartung_knapp: bool,
    pub level: f64,
}

impl Default for DepOptions {
    fn default() -> Self {
        DepOptions { model: "che".into(), rho: 0.6, robust: true, method: Method::Reml, hartung_knapp: false, level: 0.95 }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepResult {
    pub model: String,
    pub model_label: String,
    pub k: usize,
    pub studies: usize,
    /// Model-based coefficients (z tests).
    pub coefficients: Vec<Coef>,
    /// CR2 robust coefficients (t tests on Satterthwaite df), when computed.
    pub robust: Option<Vec<Coef>>,
    /// Between-study and within-study variance components (three-level, che).
    pub sigma2: Option<(f64, f64)>,
    pub rho: Option<f64>,
    /// For "aggregate": the per-study effects and their pooled result.
    pub aggregated: Option<Vec<(String, f64, f64)>>,
    pub pooled: Option<Pooled>,
    pub warnings: Vec<String>,
}

/// Constant-correlation sampling covariance within clusters (metafor's vcalc with `rho`).
pub fn within_cov(cluster: &[String], vi: &[f64], rho: f64) -> Mat {
    let n = vi.len();
    let mut v = Mat::zeros(n, n);
    for i in 0..n {
        for j in 0..n {
            if i == j {
                v[(i, j)] = vi[i];
            } else if cluster[i] == cluster[j] {
                v[(i, j)] = rho * (vi[i] * vi[j]).sqrt();
            }
        }
    }
    v
}

/// One effect per cluster under an assumed correlation: (cluster, yi, vi).
pub fn aggregate(cluster: &[String], yi: &[f64], vi: &[f64], rho: f64) -> Result<Vec<(String, f64, f64)>, String> {
    let mut order: Vec<String> = Vec::new();
    for c in cluster {
        if !order.contains(c) {
            order.push(c.clone());
        }
    }
    order
        .into_iter()
        .map(|c| {
            let idx: Vec<usize> = (0..yi.len()).filter(|i| cluster[*i] == c).collect();
            let v = within_cov(&idx.iter().map(|_| c.clone()).collect::<Vec<_>>(), &idx.iter().map(|i| vi[*i]).collect::<Vec<_>>(), rho);
            let w = v.inv_spd().ok_or("A study's estimates cannot be combined at this correlation")?;
            let ones = Mat { r: idx.len(), c: 1, v: vec![1.0; idx.len()] };
            let y = Mat::col(&idx.iter().map(|i| yi[*i]).collect::<Vec<_>>());
            let s = ones.t().mul(&w).mul(&ones).v[0];
            let num = ones.t().mul(&w).mul(&y).v[0];
            Ok((c, num / s, 1.0 / s))
        })
        .collect()
}

pub fn analyse(ids: &[String], cluster: &[String], yi: &[f64], vi: &[f64], mods: &[Moderator], o: &DepOptions) -> Result<DepResult, String> {
    let k = yi.len();
    let mut studies: Vec<&String> = cluster.iter().collect();
    studies.sort();
    studies.dedup();
    let m = studies.len();
    let mut warnings = Vec::new();
    if m == k {
        warnings.push("Every study gives one estimate here, so there is no dependence to model; the usual analysis gives the same answer.".into());
    }
    if o.model == "aggregate" {
        if !mods.is_empty() {
            return Err("Moderators need the multilevel or robust model (aggregation keeps one effect per study)".into());
        }
        let agg = aggregate(cluster, yi, vi, o.rho)?;
        let effects: Vec<Effect> = agg.iter().map(|(_, y, v)| Effect { yi: *y, vi: *v }).collect();
        let pooled = pool(&effects, o.method, o.hartung_knapp, o.level)?;
        let c = Coef { name: "Intercept".into(), estimate: pooled.estimate, se: pooled.se, statistic: pooled.statistic, df: pooled.hartung_knapp.then_some(pooled.df as f64), p: pooled.p, lower: pooled.lower, upper: pooled.upper };
        warnings.push(format!("Estimates within a study were combined assuming they correlate at {}; try other values to see whether it matters.", o.rho));
        return Ok(DepResult { model: o.model.clone(), model_label: "One effect per study (aggregated)".into(), k, studies: m, coefficients: vec![c], robust: None, sigma2: None, rho: Some(o.rho), aggregated: Some(agg), pooled: Some(pooled), warnings });
    }
    let rows: Vec<usize> = (0..k).collect();
    let (x, names) = if mods.is_empty() { (Mat { r: k, c: 1, v: vec![1.0; k] }, vec!["Intercept".to_string()]) } else { design(mods, &rows)? };
    let che = o.model == "che";
    let v = if che { within_cov(cluster, vi, o.rho) } else { Mat::diag(vi) };
    let d = Design { y: yi.to_vec(), v, x, g: vec![same_group(cluster), Mat::eye(k)] };
    let fit = fit_reml(&d, None)?;
    let p = d.x.c;
    let coefficients = coefs(&names, &fit.beta, &fit.vb, &vec![None; p], o.level);
    let robust = if che || o.robust {
        let r = cr2(&d, &fit, cluster)?;
        if r.df.iter().any(|df| *df < 4.0) {
            warnings.push("Some robust degrees of freedom are below 4: the robust tests are unreliable there (Tipton 2015), so read those p-values with caution.".into());
        }
        Some(coefs(&names, &fit.beta, &r.vcov, &r.df.iter().map(|d| Some(*d)).collect::<Vec<_>>(), o.level))
    } else {
        None
    };
    if m < 10 {
        warnings.push(format!("Only {m} studies: variance components and robust standard errors are imprecise with this few."));
    }
    if che {
        warnings.push(format!("Estimates within a study were assumed to correlate at {}; the robust standard errors stay valid if that is wrong, but try other values.", o.rho));
    }
    let _ = ids;
    Ok(DepResult {
        model: o.model.clone(),
        model_label: if che { "Correlated and hierarchical effects (REML) with robust CR2 standard errors".into() } else { "Three-level random-effects model (REML)".into() },
        k,
        studies: m,
        coefficients,
        robust,
        sigma2: Some((fit.sigma2[0], fit.sigma2[1])),
        rho: che.then_some(o.rho),
        aggregated: None,
        pooled: None,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metareg::ModValue;
    use crate::multilevel::testdata::rows;

    const ASSINK: &str = include_str!("testdata/assink2016.csv");

    fn close(a: f64, b: f64, tol: f64, what: &str) {
        assert!((a - b).abs() <= tol * (1.0 + b.abs()), "{what}: {a} vs {b}");
    }

    fn assink() -> (Vec<String>, Vec<String>, Vec<f64>, Vec<f64>, Vec<String>) {
        let r = rows(ASSINK);
        (r.iter().map(|x| format!("{}-{}", x[0], x[1])).collect(), r.iter().map(|x| x[0].clone()).collect(), r.iter().map(|x| x[2].parse().unwrap()).collect(), r.iter().map(|x| x[3].parse().unwrap()).collect(), r.iter().map(|x| x[5].clone()).collect())
    }

    // metafor 5.2-1 run locally on dat.assink2016 (Assink et al. 2016; 100 estimates in 17
    // studies), rma.mv(..., random = ~ 1 | study/esid, control = list(optimizer = "optim",
    // optmethod = "BFGS", reltol = 1e-14)). Relative tolerance 1e-5 (two optimisers).
    #[test]
    fn three_level_and_che_match_metafor() {
        let (ids, study, y, v, deltype) = assink();
        let r = analyse(&ids, &study, &y, &v, &[], &DepOptions { model: "three-level".into(), robust: false, ..Default::default() }).unwrap();
        assert_eq!((r.k, r.studies), (100, 17));
        close(r.coefficients[0].estimate, 0.426799356347604, 1e-5, "3L b");
        close(r.coefficients[0].se, 0.118429198429025, 1e-5, "3L se");
        let (s3, s2) = r.sigma2.unwrap();
        close(s3, 0.187870269308318, 1e-5, "3L sigma2 study");
        close(s2, 0.111991991949917, 1e-5, "3L sigma2 esid");
        // V <- vcalc(vi, cluster = study, obs = esid, rho = 0.6); rma.mv(yi, V, ...).
        let c = analyse(&ids, &study, &y, &v, &[], &DepOptions::default()).unwrap();
        close(c.coefficients[0].estimate, 0.3677548848000652, 1e-5, "CHE b");
        close(c.coefficients[0].se, 0.0965318168224243, 1e-5, "CHE se");
        let (s3, s2) = c.sigma2.unwrap();
        close(s3, 0.0807329782299248, 1e-5, "CHE sigma2 study");
        close(s2, 0.1545432103197295, 1e-5, "CHE sigma2 esid");
        let rb = c.robust.unwrap();
        assert!(rb[0].df.unwrap() > 4.0 && rb[0].df.unwrap() < 16.0);
        // Moderator: rma.mv(yi, vi, mods = ~ deltype, random = ~ 1 | study/esid).
        let m = Moderator { name: "deltype".into(), kind: "categorical".into(), values: deltype.iter().map(|s| ModValue::Cat(s.clone())).collect() };
        let r = analyse(&ids, &study, &y, &v, &[m], &DepOptions { model: "three-level".into(), robust: false, ..Default::default() }).unwrap();
        close(r.coefficients[0].estimate, -0.2594069687369597, 1e-4, "3L mods b0");
        close(r.coefficients[1].estimate, 0.7296558674564020, 1e-4, "3L mods b1");
        close(r.coefficients[2].estimate, 0.5077643260199761, 1e-4, "3L mods b2");
        close(r.coefficients[1].se, 0.1923138831454392, 1e-4, "3L mods se1");
        let (s3, s2) = r.sigma2.unwrap();
        close(s3, 0.1898905783263373, 1e-4, "3L mods sigma2 study");
        close(s2, 0.0846878193754917, 1e-4, "3L mods sigma2 esid");
    }

    // aggregate(escalc(yi, vi, data = dat.assink2016), cluster = study, rho = 0.6) and rma() of
    // the result (threshold 1e-14), metafor 5.2-1 run locally. Tolerance 1e-9.
    #[test]
    fn aggregation_matches_metafor() {
        let (ids, study, y, v, _) = assink();
        let r = analyse(&ids, &study, &y, &v, &[], &DepOptions { model: "aggregate".into(), ..Default::default() }).unwrap();
        let agg = r.aggregated.unwrap();
        assert_eq!(agg.len(), 17);
        close(agg[0].1, 0.16287697188644051, 1e-9, "agg y1");
        close(agg[2].1, 1.07900330258294508, 1e-9, "agg y3");
        close(agg[1].2, 0.00557233129339825, 1e-9, "agg v2");
        let p = r.pooled.unwrap();
        close(p.estimate, 0.28447053421472290, 1e-8, "agg pooled");
        close(p.se, 0.08013040383519569, 1e-8, "agg se");
        close(p.tau2, 0.08388502826172789, 1e-8, "agg tau2");
    }
}
