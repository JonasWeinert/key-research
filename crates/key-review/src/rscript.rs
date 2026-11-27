// A self-contained R script per analysis: the data it reads (one row per estimate, the columns
// metafor's escalc() takes), metafor/clubSandwich calls with Key's settings (measure, model,
// estimator, Hartung–Knapp, subgroups, moderators, dependence model, bias and sensitivity
// methods) and Key's own results as numbers the script checks with all.equal(), so running it
// shows whether R reproduces Key. It doubles as PRISMA 2020 item 27's analytic code.
use crate::meta::{Measure, Method, StudyData};
use crate::metareg::{ModValue, Moderator};
use serde_json::Value as Json;

/// What the script reproduces: the analysis request as the Analysis stage sends it, the
/// advanced request, and Key's results for both.
pub struct ScriptInput<'a> {
    pub title: &'a str,
    pub key_version: &'a str,
    pub data: &'a [StudyData],
    pub moderators: &'a [Moderator],
    pub measure: Measure,
    pub method: Method,
    pub hartung_knapp: bool,
    pub subgroups: bool,
    /// Key's base analysis (meta::Analysis as JSON).
    pub analysis: &'a Json,
    /// Key's advanced results (synthesis JSON), with the request that made them.
    pub synthesis: Option<(&'a Json, &'a Json)>,
}

fn num(v: Option<f64>) -> String {
    v.filter(|x| x.is_finite()).map(|x| format!("{x}")).unwrap_or_else(|| "NA".into())
}

fn rstr(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\n']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() }
}

/// The data the script reads: one row per estimate, in Key's order.
pub fn data_csv(data: &[StudyData], mods: &[Moderator], measure: Measure) -> String {
    let mut head = vec!["study", "record_id", "esid", "subgroup", "e1", "n1", "e2", "n2", "m1", "sd1", "m2", "sd2", "estimate", "se", "lower", "upper", "ratio", "r", "t", "df", "time1", "time2"].into_iter().map(String::from).collect::<Vec<_>>();
    for (i, _) in mods.iter().enumerate() {
        head.push(format!("mod_{}", i + 1));
    }
    let mut out = head.join(",") + "\n";
    for (i, d) in data.iter().enumerate() {
        let ratio = d.ratio || measure == Measure::HR;
        let mut cells = vec![csv_cell(&d.label), csv_cell(&d.id), (i + 1).to_string(), csv_cell(d.subgroup.as_deref().unwrap_or("")), num(d.e1), num(d.n1), num(d.e2), num(d.n2), num(d.m1), num(d.sd1), num(d.m2), num(d.sd2), num(d.estimate), num(d.se), num(d.lower), num(d.upper), if ratio { "1".into() } else { "0".into() }, num(d.r), num(d.t), num(d.df), num(d.time1), num(d.time2)];
        for m in mods {
            cells.push(match m.values.get(i) {
                Some(ModValue::Num(x)) => format!("{x}"),
                Some(ModValue::Cat(s)) => csv_cell(s),
                _ => "NA".into(),
            });
        }
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    out
}

fn escalc(measure: Measure) -> String {
    let m = format!("{measure:?}");
    match measure {
        Measure::RR | Measure::OR | Measure::RD => format!("dat <- escalc(measure = \"{m}\", ai = e1, n1i = n1, ci = e2, n2i = n2, data = dat)"),
        Measure::MD | Measure::SMD | Measure::ROM => format!("dat <- escalc(measure = \"{m}\", m1i = m1, sd1i = sd1, n1i = n1, m2i = m2, sd2i = sd2, n2i = n2, data = dat)"),
        Measure::COR | Measure::ZCOR => format!("dat <- escalc(measure = \"{m}\", ri = r, ni = n1, data = dat)"),
        // df = n − m − 1: any n and m with that difference give metafor the same values.
        Measure::PCOR => "dat <- escalc(measure = \"PCOR\", ti = t, ni = df + 2, mi = df * 0 + 1, data = dat)".into(),
        Measure::PCORSD => "dat$yi <- dat$t / sqrt(dat$t^2 + dat$df)\ndat$vi <- (1 - dat$yi^2) / dat$df  # Stanley & Doucouliagos (2012)\ndat <- escalc(measure = \"GEN\", yi = yi, vi = vi, data = dat)".into(),
        Measure::IRR => "dat <- escalc(measure = \"IRR\", x1i = e1, t1i = time1, x2i = e2, t2i = time2, data = dat)".into(),
        Measure::PLO | Measure::PFT => format!("dat <- escalc(measure = \"{m}\", xi = e1, ni = n1, data = dat)"),
        Measure::SMCR => "dat <- escalc(measure = \"SMCR\", m1i = m1, m2i = m2, sd1i = sd1, ni = n1, ri = r, data = dat)".into(),
        Measure::GEN | Measure::HR => "# Reported estimates (ratios on the log scale) with their SE, or the SE from the 95% CI.\ndat$yi <- ifelse(dat$ratio == 1, log(dat$estimate), dat$estimate)\nci_se <- ifelse(dat$ratio == 1, log(dat$upper) - log(dat$lower), dat$upper - dat$lower) / (2 * qnorm(0.975))\ndat$vi <- ifelse(!is.na(dat$se) & dat$se > 0, dat$se, ci_se)^2\ndat <- escalc(measure = \"GEN\", yi = yi, vi = vi, data = dat)".into(),
    }
}

fn method_r(m: Method) -> &'static str {
    match m {
        Method::Fe => "FE",
        Method::Dl => "DL",
        Method::Reml => "REML",
    }
}

fn f(v: &Json, path: &str) -> Option<f64> {
    v.pointer(path).and_then(Json::as_f64)
}

fn vec_r(v: &[Option<f64>]) -> String {
    format!("c({})", v.iter().map(|x| num(*x)).collect::<Vec<_>>().join(", "))
}

fn check(out: &mut String, what: &str, r_expr: &str, key: &[Option<f64>], tol: &str) {
    if key.iter().all(|k| k.is_none()) {
        return;
    }
    out.push_str(&format!("check({}, {r_expr}, {}, {tol})\n", rstr(what), vec_r(key)));
}

/// The moderators as an R formula, with categorical levels in Key's order.
fn mods_formula(mods: &[Moderator]) -> String {
    let terms: Vec<String> = mods
        .iter()
        .enumerate()
        .map(|(i, m)| {
            if m.kind == "categorical" {
                let mut levels: Vec<String> = m.values.iter().filter_map(|v| if let ModValue::Cat(s) = v { Some(s.clone()) } else { None }).collect();
                levels.sort();
                levels.dedup();
                format!("factor(mod_{}, levels = c({}))", i + 1, levels.iter().map(|l| rstr(l)).collect::<Vec<_>>().join(", "))
            } else {
                format!("mod_{}", i + 1)
            }
        })
        .collect();
    format!("~ {}", terms.join(" + "))
}

pub fn script(input: &ScriptInput) -> String {
    let a = input.analysis;
    let method = method_r(input.method);
    let test = if input.hartung_knapp && input.method != Method::Fe { "knha" } else { "z" };
    let needs_cs = input.synthesis.is_some_and(|(req, res)| {
        req.pointer("/dependence/model").and_then(Json::as_str).is_some_and(|m| m != "aggregate") || res.get("multipleEstimates").and_then(Json::as_bool).unwrap_or(false) && req.pointer("/bias/petPeese").and_then(Json::as_bool).unwrap_or(false)
    });
    let mut s = String::new();
    s.push_str(&format!("## {}\n", input.title.replace('\n', " ")));
    s.push_str(&format!("## Exported by Key {}. Key's meta-analysis is validated against metafor 5.2-1 (R 4.6.1).\n", input.key_version));
    s.push_str("## Run it from this folder: Rscript analysis.R  (each check prints \"matches Key\" or the difference)\n");
    s.push_str(&format!("## Needs the metafor package{}.\n\n", if needs_cs { " and, for the robust standard errors, clubSandwich" } else { "" }));
    s.push_str("suppressPackageStartupMessages(library(metafor))\n");
    s.push_str("dat <- read.csv(\"data.csv\", stringsAsFactors = FALSE, check.names = FALSE, encoding = \"UTF-8\", na.strings = c(\"NA\", \"\"))\n");
    s.push_str("dat$subgroup[is.na(dat$subgroup)] <- \"\"\n");
    s.push_str("ok <- TRUE\n");
    s.push_str("check <- function(what, r, key, tol) {\n  same <- isTRUE(all.equal(as.numeric(unname(r)), as.numeric(unname(key)), tolerance = tol))\n  if (!same) ok <<- FALSE\n  cat(sprintf(\"%-44s %s\\n\", what, if (same) \"matches Key\" else paste(\"DIFFERS: R\", paste(signif(as.numeric(r), 8), collapse = \" \"), \"| Key\", paste(signif(as.numeric(key), 8), collapse = \" \"))))\n}\n");
    s.push_str("ctl <- list(threshold = 1e-12, maxiter = 1000)\n\n");
    s.push_str(&format!("## Effect sizes: {}\n", input.measure.label()));
    s.push_str(&escalc(input.measure));
    s.push_str("\ndat <- dat[!is.na(dat$yi) & !is.na(dat$vi) & dat$vi > 0, ]\n\n");
    s.push_str(&format!("## Main model: {}\n", crate::synthesis::model_text(&crate::meta::Options { measure: input.measure, method: input.method, hartung_knapp: input.hartung_knapp, level: 0.95 })));
    s.push_str(&format!("res <- rma(yi, vi, data = dat, method = \"{method}\", test = \"{test}\", slab = study, control = ctl)\nprint(res)\n"));
    let m = "/main";
    check(&mut s, "Pooled estimate, SE, CI", "c(coef(res), res$se, res$ci.lb, res$ci.ub)", &[f(a, &format!("{m}/estimate")), f(a, &format!("{m}/se")), f(a, &format!("{m}/lower")), f(a, &format!("{m}/upper"))], "1e-6");
    check(&mut s, "Heterogeneity: tau2, I2, Q", "c(res$tau2, res$I2, res$QE)", &[f(a, &format!("{m}/tau2")), f(a, &format!("{m}/i2")), f(a, &format!("{m}/q"))], "1e-6");
    if input.method != Method::Fe {
        check(&mut s, "Prediction interval", "c(predict(res)$pi.lb, predict(res)$pi.ub)", &[f(a, &format!("{m}/piLower")), f(a, &format!("{m}/piUpper"))], "1e-6");
    }
    if let Some(Json::Array(groups)) = a.get("subgroups").filter(|g| input.subgroups && g.as_array().is_some_and(|x| x.len() > 1)) {
        s.push_str("\n## Subgroups: each pooled on its own, then a test for differences between them\n");
        s.push_str("groups <- sort(unique(dat$subgroup[dat$subgroup != \"\"]))\n");
        s.push_str(&format!("sub <- lapply(groups, function(g) rma(yi, vi, data = dat, subset = subgroup == g, method = \"{method}\", test = \"{test}\", control = ctl))\n"));
        let mut names: Vec<(String, Option<f64>)> = groups.iter().map(|g| (g.get("name").and_then(Json::as_str).unwrap_or("").to_string(), f(g, "/pooled/estimate"))).collect();
        names.sort_by(|x, y| x.0.cmp(&y.0));
        check(&mut s, "Subgroup estimates", "sapply(sub, coef)", &names.iter().map(|x| x.1).collect::<Vec<_>>(), "1e-6");
        s.push_str("between <- rma(sapply(sub, coef), sei = sapply(sub, function(r) r$se), method = \"FE\")\n");
        check(&mut s, "Test for subgroup differences (Q)", "between$QE", &[f(a, "/subgroupTest/q")], "1e-6");
    }
    if let Some(Json::Array(loo)) = a.get("leaveOneOut").filter(|l| l.as_array().is_some_and(|x| !x.is_empty())) {
        s.push_str("\n## Leave one out\n");
        s.push_str("l1 <- leave1out(res)\n");
        check(&mut s, "Leave-one-out estimates", "l1$estimate", &loo.iter().map(|l| l.get("estimate").and_then(Json::as_f64)).collect::<Vec<_>>(), "1e-6");
    }
    if a.get("egger").is_some_and(|e| !e.is_null()) {
        s.push_str("\n## Egger's regression test (weighted regression with multiplicative dispersion)\n");
        s.push_str("eg <- regtest(res, model = \"lm\")\n");
        check(&mut s, "Egger's test t and p", "c(eg$zval, eg$pval)", &[f(a, "/egger/t"), f(a, "/egger/p")], "1e-6");
    }
    if let Some((req, res)) = input.synthesis {
        advanced(&mut s, input, req, res, method, test);
    }
    s.push_str("\ncat(if (ok) \"\\nEvery check matches Key.\\n\" else \"\\nSome checks differ from Key (see above).\\n\")\n");
    s.push_str("## The R session this was run in, for the record:\nprint(sessionInfo())\n");
    s
}

fn advanced(s: &mut String, input: &ScriptInput, req: &Json, res: &Json, method: &str, test: &str) {
    let multiple = res.get("multipleEstimates").and_then(Json::as_bool).unwrap_or(false);
    let formula = (!input.moderators.is_empty()).then(|| mods_formula(input.moderators));
    if let (Some(mr), Some(formula)) = (res.get("metaRegression").filter(|m| m.get("coefficients").is_some()), &formula) {
        let o = req.get("metareg").cloned().unwrap_or(Json::Null);
        let rm = match o.get("method").and_then(Json::as_str).unwrap_or("reml") {
            "fe" => "FE",
            "dl" => "DL",
            _ => "REML",
        };
        let kh = o.get("knappHartung").and_then(Json::as_bool).unwrap_or(true) && rm != "FE";
        s.push_str("\n## Meta-regression\n");
        s.push_str(&format!("mr <- rma(yi, vi, mods = {formula}, data = dat, method = \"{rm}\", test = \"{}\", control = ctl)\nprint(mr)\n", if kh { "knha" } else { "z" }));
        let coefs: Vec<&Json> = mr.get("coefficients").and_then(Json::as_array).map(|a| a.iter().collect()).unwrap_or_default();
        check(s, "Meta-regression coefficients", "coef(mr)", &coefs.iter().map(|c| c.get("estimate").and_then(Json::as_f64)).collect::<Vec<_>>(), "1e-6");
        check(s, "Meta-regression SEs", "mr$se", &coefs.iter().map(|c| c.get("se").and_then(Json::as_f64)).collect::<Vec<_>>(), "1e-6");
        check(s, "Residual tau2, QE, QM", "c(mr$tau2, mr$QE, mr$QM)", &[f(mr, "/tau2"), f(mr, "/qe"), f(mr, "/qm")], "1e-6");
        if let Some(r2) = f(mr, "/r2") {
            check(s, "R2 (share of tau2 explained)", "mr$R2", &[Some(r2)], "1e-5");
        }
        if let Some(p) = mr.get("permutation").filter(|p| !p.is_null()) {
            if p.get("exact").and_then(Json::as_bool).unwrap_or(false) {
                s.push_str("pm <- permutest(mr, exact = TRUE, control = ctl)\n");
                check(s, "Exact permutation p-values", "pm$pval", &p.get("p").and_then(Json::as_array).map(|a| a.iter().map(Json::as_f64).collect::<Vec<_>>()).unwrap_or_default(), "1e-9");
            } else {
                s.push_str(&format!("## Key ran {} random permutations with its own generator; R's differ, so p-values agree only roughly.\npm <- permutest(mr, iter = {}, control = ctl)\nprint(pm)\n", p.get("iterations").and_then(Json::as_u64).unwrap_or(1000), p.get("iterations").and_then(Json::as_u64).unwrap_or(1000)));
            }
        }
    }
    if let Some(d) = res.get("dependence").filter(|d| d.get("model").is_some()) {
        let model = d.get("model").and_then(Json::as_str).unwrap_or("");
        let rho = f(d, "/rho").or_else(|| f(req, "/dependence/rho")).unwrap_or(0.6);
        s.push_str("\n## Several estimates per study\n");
        if model == "aggregate" {
            let dm = match req.pointer("/dependence/method").and_then(Json::as_str).unwrap_or("reml") {
                "fe" => "FE",
                "dl" => "DL",
                _ => "REML",
            };
            let hk = req.pointer("/dependence/hartungKnapp").and_then(Json::as_bool).unwrap_or(false) && dm != "FE";
            s.push_str(&format!("agg <- aggregate(dat, cluster = record_id, rho = {rho})\nra <- rma(yi, vi, data = agg, method = \"{dm}\", test = \"{}\", control = ctl)\nprint(ra)\n", if hk { "knha" } else { "z" }));
            check(s, "Aggregated: estimate, SE, tau2", "c(coef(ra), ra$se, ra$tau2)", &[f(d, "/pooled/estimate"), f(d, "/pooled/se"), f(d, "/pooled/tau2")], "1e-6");
        } else {
            let mods = formula.as_ref().filter(|_| req.get("metareg").is_some_and(|m| !m.is_null())).map(|f| format!(", mods = {f}")).unwrap_or_default();
            if model == "che" {
                s.push_str(&format!("V <- vcalc(vi, cluster = record_id, obs = esid, rho = {rho}, data = dat)\nml <- rma.mv(yi, V{mods}, random = ~ 1 | record_id/esid, data = dat)\n"));
            } else {
                s.push_str(&format!("ml <- rma.mv(yi, vi{mods}, random = ~ 1 | record_id/esid, data = dat)\n"));
            }
            s.push_str("print(ml)\n");
            let coefs: Vec<&Json> = d.get("coefficients").and_then(Json::as_array).map(|a| a.iter().collect()).unwrap_or_default();
            check(s, "Multilevel coefficients", "coef(ml)", &coefs.iter().map(|c| c.get("estimate").and_then(Json::as_f64)).collect::<Vec<_>>(), "1e-4");
            check(s, "Variance components (between, within)", "ml$sigma2", &[f(d, "/sigma2/0"), f(d, "/sigma2/1")], "1e-4");
            if let Some(Json::Array(rb)) = d.get("robust") {
                s.push_str("if (requireNamespace(\"clubSandwich\", quietly = TRUE)) {\n  rb <- robust(ml, cluster = record_id, clubSandwich = TRUE)\n  print(rb)\n  ");
                check(s, "Robust (CR2) SEs", "rb$se", &rb.iter().map(|c| c.get("se").and_then(Json::as_f64)).collect::<Vec<_>>(), "1e-4");
                s.push_str("  ");
                check(s, "Robust Satterthwaite df", "rb$dfs", &rb.iter().map(|c| c.get("df").and_then(Json::as_f64)).collect::<Vec<_>>(), "1e-4");
                s.push_str("} else cat(\"Install clubSandwich to check the robust standard errors.\\n\")\n");
            }
        }
    }
    if let Some(b) = res.get("bias") {
        s.push_str("\n## Small-study effects and publication bias\n");
        if let Some(pp) = b.get("petPeese").filter(|p| p.get("pet").is_some()) {
            s.push_str("pet <- lm(yi ~ sqrt(vi), weights = 1 / vi, data = dat)\npeese <- lm(yi ~ vi, weights = 1 / vi, data = dat)\n");
            if multiple {
                s.push_str("if (requireNamespace(\"clubSandwich\", quietly = TRUE)) {\n  ct <- clubSandwich::coef_test(pet, vcov = \"CR2\", cluster = dat$record_id)\n  ");
                check(s, "PET intercept and robust SE", "c(ct$beta[1], ct$SE[1])", &[f(pp, "/pet/intercept/estimate"), f(pp, "/pet/intercept/se")], "1e-6");
                s.push_str("}\n");
            } else {
                check(s, "PET (FAT-PET) intercept and SE", "coef(summary(pet))[1, 1:2]", &[f(pp, "/pet/intercept/estimate"), f(pp, "/pet/intercept/se")], "1e-8");
                check(s, "FAT slope and p", "coef(summary(pet))[2, c(1, 4)]", &[f(pp, "/pet/slope/estimate"), f(pp, "/pet/slope/p")], "1e-8");
                check(s, "PEESE intercept and SE", "coef(summary(peese))[1, 1:2]", &[f(pp, "/peese/intercept/estimate"), f(pp, "/peese/intercept/se")], "1e-8");
            }
            s.push_str(&format!("## Key's conditional rule: {}\n", pp.get("rule").and_then(Json::as_str).unwrap_or("").replace('\n', " ")));
        }
        if let Some(u) = b.get("uwls").filter(|u| u.get("uwls").is_some()) {
            s.push_str("uw <- lm(I(yi / sqrt(vi)) ~ 0 + I(1 / sqrt(vi)), data = dat)\n");
            check(s, "UWLS estimate and SE", "coef(summary(uw))[1, 1:2]", &[f(u, "/uwls/estimate"), f(u, "/uwls/se")], "1e-8");
            if u.get("waap").is_some_and(|w| !w.is_null()) {
                s.push_str("ap <- sqrt(dat$vi) <= abs(coef(uw)[1]) / 2.8\nwaap <- lm(I(yi / sqrt(vi)) ~ 0 + I(1 / sqrt(vi)), data = dat[ap, ])\n");
                check(s, "WAAP estimate and SE", "coef(summary(waap))[1, 1:2]", &[f(u, "/waap/estimate"), f(u, "/waap/se")], "1e-8");
            }
        }
        if let Some(t) = b.get("trimFill").filter(|t| t.get("k0").is_some()) {
            s.push_str(&format!("tf <- trimfill(rma(yi, vi, data = dat, method = \"{method}\", control = ctl), estimator = \"{}\")\nprint(tf)\n", t.get("estimator").and_then(Json::as_str).unwrap_or("L0")));
            check(s, "Trim and fill: missing studies", "tf$k0", &[f(t, "/k0")], "1e-9");
            check(s, "Trim and fill: adjusted estimate", "coef(tf)", &[f(t, "/pooled/estimate")], "1e-5");
        }
        if let Some(sel) = b.get("selection").filter(|t| t.get("estimate").is_some()) {
            s.push_str("sm <- selmodel(rma(yi, vi, data = dat, method = \"ML\"), type = \"stepfun\", steps = 0.025)\nprint(sm)\n");
            check(s, "Selection model: estimate, tau2, delta", "c(coef(sm)[1], sm$tau2, sm$delta[2])", &[f(sel, "/estimate"), f(sel, "/tau2"), f(sel, "/delta")], "1e-4");
        }
    }
    if let Some(sens) = res.get("sensitivity") {
        s.push_str("\n## Sensitivity\n");
        if let Some(Json::Array(inf)) = sens.get("influence") {
            s.push_str("inf <- influence(res)\n");
            check(s, "Studentised residuals", "inf$inf$rstudent", &inf.iter().map(|x| x.get("rstudent").and_then(Json::as_f64)).collect::<Vec<_>>(), "1e-6");
            check(s, "Cook's distances", "inf$inf$cook.d", &inf.iter().map(|x| x.get("cookD").and_then(Json::as_f64)).collect::<Vec<_>>(), "1e-6");
            check(s, "DFBETAS", "inf$dfbs[[1]]", &inf.iter().map(|x| x.get("dfbetas").and_then(Json::as_f64)).collect::<Vec<_>>(), "1e-6");
        }
        if let Some(Json::Array(cu)) = sens.get("cumulative") {
            let order = match sens.get("cumulativeOrder").and_then(Json::as_str).unwrap_or("listed") {
                "year" => "dat$year_for_order",
                "precision" => "dat$vi",
                _ => "seq_len(nrow(dat))",
            };
            if order.contains("year_for_order") {
                let years: Vec<String> = res.get("points").and_then(Json::as_array).map(|p| p.iter().map(|x| x.get("year").and_then(Json::as_i64).map(|y| y.to_string()).unwrap_or_else(|| "Inf".into())).collect()).unwrap_or_default();
                s.push_str(&format!("dat$year_for_order <- c({})\n", years.join(", ")));
            }
            s.push_str(&format!("cu <- cumul(res, order = {order})\n"));
            check(s, "Cumulative estimates", "cu$estimate", &cu.iter().map(|x| f(x, "/pooled/estimate")).collect::<Vec<_>>(), "1e-4");
        }
    }
    let _ = test;
}

/// A Stata do-file for the basic model (Stata 16+ `meta` commands), without checks.
pub fn stata(measure: Measure, method: Method, hk: bool) -> Option<String> {
    let set = match measure {
        Measure::RR => "meta esize e1 ne1 e2 ne2, esize(lnrratio)",
        Measure::OR => "meta esize e1 ne1 e2 ne2, esize(lnoratio)",
        Measure::RD => "meta esize e1 ne1 e2 ne2, esize(rdiff)",
        Measure::MD => "meta esize n1 m1 sd1 n2 m2 sd2, esize(mdiff)",
        Measure::SMD => "meta esize n1 m1 sd1 n2 m2 sd2, esize(hedgesg, exact)",
        _ => return None,
    };
    let model = match method {
        Method::Fe => "common".to_string(),
        Method::Dl => format!("random(dlaird){}", if hk { " se(khartung)" } else { "" }),
        Method::Reml => format!("random(reml){}", if hk { " se(khartung)" } else { "" }),
    };
    Some(format!(
        "* Exported by Key: the basic model only (not checked against Key's numbers).\nimport delimited using \"data.csv\", clear varnames(1)\ngen ne1 = n1 - e1\ngen ne2 = n2 - e2\n{set} studylabel(study)\nmeta summarize, {model}\nmeta forestplot, {model}\n"
    ))
}
