// Explanations for the advanced synthesis, the conversion helper and the exports (spread into
// review-help.ts). Plain language first; the method's name and source after.
import type { HelpEntry } from "../help-content";

export const SYNTHESIS_HELP = {
  "review.dependence": {
    kind: "explain",
    title: "Several estimates per study",
    body: [
      "Use this when some studies give more than one estimate for the outcome (several measures, time points or comparisons). Counting them as separate studies overstates how much you know.",
      "Robust (recommended): a correlated and hierarchical effects model with cluster-robust CR2 standard errors (Pustejovsky and Tipton 2022). It stays valid if the correlation you assume is wrong. Three-level model: estimates nested in studies, REML. One per study: combines each study's estimates first, the simplest choice.",
    ],
    privacy: "Validated against metafor's rma.mv and the clubSandwich results printed in metafor's documentation.",
  },
  "review.metareg": {
    kind: "explain",
    title: "Meta-regression",
    body: [
      "Use this when you want to know whether a study characteristic (dose, year, setting, risk of bias) explains why effects differ. Each coefficient is how much the effect changes per unit, or compared with the first category.",
      "It is observational: studies differ in many ways at once. Plan moderators in the protocol, aim for about ten studies per moderator term, and read R² (the share of between-study variance explained) with care. Knapp–Hartung tests are the safer default.",
    ],
    privacy: "Mixed-effects model by REML, validated against metafor's rma(mods = …).",
  },
  "review.bias": {
    kind: "explain",
    title: "Small-study effects and publication bias",
    body: [
      "Use these when you worry that small studies with null results went unpublished. PET-PEESE regresses estimates on their standard errors and reports the effect a perfectly precise study would find (Stanley and Doucouliagos 2014).",
      "UWLS and WAAP average the well-powered studies (Ioannidis, Stanley and Doucouliagos 2017). Trim and fill imputes missing studies (Duval and Tweedie 2000). The selection model estimates how much less likely non-significant results were to appear (Vevea and Hedges 1995). Agreement across methods is more convincing than any one.",
    ],
    privacy: "Each is checked against R (lm, metafor's trimfill and selmodel).",
  },
  "review.sensitivity": {
    kind: "explain",
    title: "Sensitivity analyses",
    body: [
      "Use these to see whether the result rests on one or two studies. Influence diagnostics flag studies that move the pooled result (Cook's distance, DFBETAS) or fit poorly (studentised residuals); the Baujat plot shows each study's contribution to heterogeneity against its influence.",
      "The cumulative analysis adds studies one at a time, by year or precision. The model table shows the result under fixed and random effects side by side.",
    ],
  },
  "review.convert": {
    kind: "explain",
    title: "Converting reported statistics",
    body: [
      "Papers often report a median and IQR, a confidence interval or a p-value instead of what the analysis needs. The helper computes it with a published method and stores the method and its source with the value, so your report can say what was done.",
      "Medians assume roughly symmetric data: Key warns when the numbers look skewed. Assumed correlations (change scores) and ICCs (cluster trials) should be reported and varied in a sensitivity analysis.",
    ],
    links: [{ label: "Cochrane Handbook, chapter 6", url: "https://training.cochrane.org/handbook/current/chapter-06" }],
  },
  "review.exports": {
    kind: "explain",
    title: "Exports others can use",
    body: [
      "R script: data and a metafor script that reproduces this analysis and checks each number against Key's. RevMan Web: the study-data CSVs and references RevMan imports, checked against its documented rules. Replication bundle: everything a journal or OSF asks for in one zip with a README and checksums.",
    ],
  },
  "review.migrate": {
    kind: "explain",
    title: "Moving a review into Key",
    body: [
      "Bring records and screening decisions from a Covidence or Rayyan export, or any CSV. Check the column mapping on the preview; decisions are recorded as imported, with reasons kept as Other where they do not match a criterion.",
    ],
  },
  "review.metareg.pick": { kind: "hint", text: "Pick a study characteristic below. Number fields become slopes; text or choice fields become categories." },
} satisfies Record<string, HelpEntry>;
