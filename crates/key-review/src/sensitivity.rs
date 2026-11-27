// Sensitivity tools for one pooled outcome: case-deletion influence diagnostics (Viechtbauer &
// Cheung 2010, Res Synth Methods 1:112; metafor's influence.rma.uni: externally studentised
// residuals, DFFITS, Cook's distance, covariance ratio, DFBETAS, τ² and Q when left out, hat
// values), the Baujat plot (Baujat et al. 2002, Stat Med 21:2641; metafor's baujat()),
// cumulative meta-analysis (metafor's cumul()) and a comparison of the fixed-effect and
// random-effects models. The tests reproduce metafor 5.2-1 on dat.bcg.
use crate::meta::{Effect, Method, Pooled, pool};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Influence {
    pub id: String,
    pub label: String,
    pub rstudent: f64,
    pub dffits: f64,
    pub cook_d: f64,
    pub cov_r: f64,
    pub dfbetas: f64,
    pub tau2_del: f64,
    pub qe_del: f64,
    pub hat: f64,
    /// Percent weight.
    pub weight: f64,
    /// metafor's rule: |DFFITS| > 3√(p/(k−p)), P(χ²₁ ≤ Cook's D) > .5, hat > 3p/k or |DFBETAS| > 1.
    pub influential: bool,
    /// Baujat: contribution to heterogeneity (x) and influence on the result (y).
    pub baujat_x: f64,
    pub baujat_y: f64,
}

struct Fit {
    mu: f64,
    vb: f64,
    tau2: f64,
    s2w: f64,
    q: f64,
}

fn fit(e: &[Effect], method: Method, hk: bool) -> Result<Fit, String> {
    let p = pool(e, method, false, 0.95)?;
    let w: Vec<f64> = e.iter().map(|x| 1.0 / (x.vi + p.tau2)).collect();
    let sw: f64 = w.iter().sum();
    let s2w = if hk && method != Method::Fe && e.len() > 1 { e.iter().zip(&w).map(|(x, w)| w * (x.yi - p.estimate).powi(2)).sum::<f64>() / (e.len() - 1) as f64 } else { 1.0 };
    Ok(Fit { mu: p.estimate, vb: s2w / sw, tau2: p.tau2, s2w, q: p.q })
}

pub fn influence(ids: &[String], labels: &[String], e: &[Effect], method: Method, hk: bool) -> Result<Vec<Influence>, String> {
    let k = e.len();
    if k < 3 {
        return Err("Influence diagnostics need at least three studies".into());
    }
    let full = fit(e, method, hk)?;
    let w: Vec<f64> = e.iter().map(|x| 1.0 / (x.vi + full.tau2)).collect();
    let sw: f64 = w.iter().sum();
    let pf = 1.0f64;
    let kf = k as f64;
    let chi1_cdf = |x: f64| 1.0 - crate::stats::chisq_sf(x, 1.0);
    let mut out = Vec::with_capacity(k);
    for i in 0..k {
        let rest: Vec<Effect> = e.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, x)| *x).collect();
        let del = fit(&rest, method, hk)?;
        // The full-data estimator's variance with the left-out τ² (metafor's vb.del).
        let vdel = 1.0 / e.iter().map(|x| 1.0 / (x.vi + del.tau2)).sum::<f64>();
        let diff = full.mu - del.mu;
        let hat = w[i] / sw;
        let dffits = diff / (del.s2w * hat * (del.tau2 + e[i].vi)).sqrt();
        let dfbetas = diff / (del.s2w * vdel).sqrt();
        let resid = e[i].yi - del.mu;
        let rstudent = resid / (e[i].vi * del.s2w + del.vb + del.tau2 * del.s2w).sqrt();
        let cook_d = diff * diff / full.vb;
        let cov_r = del.vb / full.vb;
        let influential = dffits.abs() > 3.0 * (pf / (kf - pf)).sqrt() || chi1_cdf(cook_d) > 0.5 || hat > 3.0 * pf / kf || dfbetas.abs() > 1.0;
        // Baujat (metafor): x = (yi − μ)² / (τ² + vi); y = (μ(−i) − μ)² / Var(μ(−i)).
        let baujat_x = (e[i].yi - full.mu).powi(2) / (full.tau2 + e[i].vi);
        let baujat_y = diff * diff / del.vb;
        out.push(Influence { id: ids[i].clone(), label: labels[i].clone(), rstudent, dffits, cook_d, cov_r, dfbetas, tau2_del: del.tau2, qe_del: del.q, hat, weight: 100.0 * hat, influential, baujat_x, baujat_y });
    }
    Ok(out)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CumulativeStep {
    pub id: String,
    pub label: String,
    pub pooled: Pooled,
}

/// Pooled results as studies are added in `order` (indices into `e`).
pub fn cumulative(ids: &[String], labels: &[String], e: &[Effect], order: &[usize], method: Method, hk: bool, level: f64) -> Vec<CumulativeStep> {
    let mut out = Vec::new();
    let mut acc = Vec::new();
    for &i in order {
        acc.push(e[i]);
        if let Ok(p) = pool(&acc, method, hk, level) {
            out.push(CumulativeStep { id: ids[i].clone(), label: labels[i].clone(), pooled: p });
        }
    }
    out
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub model: String,
    pub pooled: Pooled,
}

/// The same data under the fixed-effect model and the random-effects estimators.
pub fn model_comparison(e: &[Effect], level: f64) -> Vec<ModelRow> {
    [("Fixed effect", Method::Fe, false), ("Random effects, DerSimonian–Laird", Method::Dl, false), ("Random effects, REML", Method::Reml, false), ("Random effects, REML with Hartung–Knapp", Method::Reml, true)]
        .into_iter()
        .filter_map(|(name, m, hk)| pool(e, m, hk, level).ok().map(|p| ModelRow { model: name.into(), pooled: p }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64, what: &str) {
        assert!((a - b).abs() <= tol * (1.0 + b.abs()), "{what}: {a} vs {b}");
    }

    fn bcg() -> (Vec<String>, Vec<Effect>, Vec<f64>) {
        let (yi, vi, ..) = crate::metareg::tests::bcg();
        let year = vec![1948., 1949., 1960., 1977., 1973., 1953., 1973., 1980., 1968., 1961., 1974., 1969., 1976.];
        ((0..13).map(|i| format!("{}", i + 1)).collect(), yi.iter().zip(&vi).map(|(y, v)| Effect { yi: *y, vi: *v }).collect(), year)
    }

    // metafor 5.2-1 run locally: influence(rma(yi, vi, data = escalc("RR", ..., dat.bcg),
    // control = list(threshold = 1e-14))) and baujat(); relative tolerance 1e-6.
    #[test]
    fn influence_and_baujat_match_metafor() {
        let (ids, e, _) = bcg();
        let r = influence(&ids, &ids, &e, Method::Reml, false).unwrap();
        close(r[0].rstudent, -0.218142485736089, 1e-6, "rstudent 1");
        close(r[3].rstudent, -1.451200664251022, 1e-6, "rstudent 4");
        close(r[0].dffits, -0.0407075475012596, 1e-6, "dffits 1");
        close(r[7].dffits, 0.4774600073741751, 1e-6, "dffits 8");
        close(r[3].cook_d, 0.229481639115786784, 1e-6, "cook 4");
        close(r[5].cov_r, 1.240716427038805, 1e-6, "cov.r 6");
        close(r[0].tau2_del, 0.336156701803629, 1e-6, "tau2.del 1");
        close(r[7].qe_del, 67.9858114990849, 1e-9, "QE.del 8");
        close(r[7].hat, 0.1018943903709569, 1e-7, "hat 8");
        close(r[11].weight, 3.82162906298955, 1e-7, "weight 12");
        close(r[0].dfbetas, -0.0402658891701821, 1e-6, "dfbetas 1");
        close(r[1].dfbetas, -0.3458623099512142, 1e-6, "dfbetas 2");
        assert!(r.iter().all(|x| !x.influential));
        close(r[0].baujat_x, 0.0478183405467932, 1e-6, "baujat x 1");
        close(r[7].baujat_x, 1.6638459497329343, 1e-6, "baujat x 8");
        close(r[3].baujat_y, 0.237773641745486097, 1e-6, "baujat y 4");
        // test = "knha"
        let r = influence(&ids, &ids, &e, Method::Reml, true).unwrap();
        close(r[0].rstudent, -0.213597850407729, 1e-6, "knha rstudent");
        close(r[1].dffits, -0.3422683132878898, 1e-6, "knha dffits");
        close(r[2].cook_d, 0.0256907964841634, 1e-6, "knha cook");
        close(r[0].cov_r, 1.15148565410540, 1e-6, "knha cov.r");
    }

    // cumul(rma(...), order = year): metafor refits each step with its default REML threshold
    // (1e-5), so tolerance 1e-5; DL steps are closed-form (1e-9).
    #[test]
    fn cumulative_matches_metafor() {
        let (ids, e, year) = bcg();
        let mut order: Vec<usize> = (0..13).collect();
        order.sort_by(|a, b| year[*a].partial_cmp(&year[*b]).unwrap().then(a.cmp(b)));
        let c = cumulative(&ids, &ids, &e, &order, Method::Reml, false, 0.95);
        close(c[0].pooled.estimate, -0.889311333920205, 1e-9, "step 1");
        close(c[2].pooled.estimate, -0.972079931813350, 1e-5, "step 3");
        close(c[2].pooled.tau2, 0.0872067928388532, 1e-5, "step 3 tau2");
        close(c[7].pooled.i2, 72.3903628269220, 1e-5, "step 8 I2");
        close(c[12].pooled.upper, -0.362167045505928, 1e-5, "step 13 ub");
        let order: Vec<usize> = (0..13).collect();
        let c = cumulative(&ids, &ids, &e, &order, Method::Dl, false, 0.95);
        close(c[4].pooled.estimate, -1.065989641827538, 1e-9, "DL step 5");
        close(c[4].pooled.tau2, 0.422872072605276, 1e-9, "DL tau2 5");
        assert_eq!(model_comparison(&e, 0.95).len(), 4);
    }
}
