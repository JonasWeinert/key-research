// Extraction pilots and contacts with authors (std-B). A pilot round is a seeded sample of
// included studies that every chosen extractor completes independently; agreement is computed
// per field (percent agreement; Cohen's or Fleiss' kappa for categorical fields; ICC(2,1) and
// the mean absolute difference for numbers) and closing the round records "forms piloted on
// ‹date› with ‹n› studies" (`form.piloted`), with each form's hash so later changes to a piloted
// form show as protocol versions after the pilot. The contact log keeps, per study, who was
// asked what and when, the reply and whether data came: it feeds the missing-data reporting.
use crate::conduct::{StdB, iso_date, parse_date};
use crate::derive::State;
use crate::events::{Event, Rng, random_u64};
use crate::model::*;
use crate::stats;
use crate::store::{Result, Reviews};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct XPilot {
    pub id: String,
    pub name: String,
    pub form_ids: Vec<String>,
    pub records: Vec<String>,
    pub extractors: Vec<String>,
    pub open: bool,
    pub seed: u64,
    /// Each form's hash when the pilot started (to tell later changes).
    pub form_hashes: BTreeMap<String, String>,
    pub at: i64,
    pub closed_at: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FormPiloted {
    pub pilot_id: String,
    pub form_ids: Vec<String>,
    pub n: usize,
    pub extractors: usize,
    pub form_hashes: BTreeMap<String, String>,
    pub percent: Option<f64>,
    pub kappa: Option<f64>,
    pub at: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Contact {
    pub id: String,
    pub record_id: String,
    /// When they were contacted: "YYYY-MM-DD".
    pub date: String,
    /// Who was contacted (the corresponding author, a trial's sponsor …).
    pub person: String,
    /// email | form | phone | other
    pub method: String,
    pub asked: String,
    pub reply: String,
    pub reply_date: String,
    /// waiting | replied | noReply
    pub status: String,
    pub data_received: bool,
    pub by: String,
    pub at: i64,
    pub deleted: bool,
}

pub fn observe(s: &mut StdB, e: &Event) {
    let p = &e.payload;
    match e.kind.as_str() {
        "xpilot.set" => {
            if let Ok(mut x) = serde_json::from_value::<XPilot>(p.clone()) {
                if x.at == 0 {
                    x.at = e.at;
                }
                if !x.open && x.closed_at == 0 {
                    x.closed_at = e.at;
                }
                match s.xpilots.iter_mut().find(|o| o.id == x.id) {
                    Some(o) => *o = x,
                    None => s.xpilots.push(x),
                }
            }
        }
        "form.piloted" => {
            if let Ok(mut f) = serde_json::from_value::<FormPiloted>(p.clone()) {
                f.at = e.at;
                s.piloted.push(f);
            }
        }
        "contact.log" => {
            if let Ok(mut c) = serde_json::from_value::<Contact>(p.clone()) {
                c.by = e.actor.clone();
                c.at = e.at;
                if c.record_id.is_empty() {
                    c.record_id = e.record_id.clone().unwrap_or_default();
                }
                s.contacts.retain(|o| o.id != c.id);
                if !c.deleted {
                    s.contacts.push(c);
                }
            }
        }
        _ => {}
    }
}

pub fn form_hash(form: &Form) -> String {
    crate::ai_audit::sha256(&serde_json::to_string(form).unwrap_or_default())
}

// ── Agreement for numbers ─────────────────────────────────────────────────────────────

/// ICC(2,1): two-way random effects, absolute agreement, single rater (Shrout & Fleiss 1979,
/// Psychol Bull 86:420, case 2; McGraw & Wong 1996 "ICC(A,1)"). `rows` are targets (studies),
/// each with one value per rater, all the same length k ≥ 2. None when it is not defined.
pub fn icc_2_1(rows: &[Vec<f64>]) -> Option<f64> {
    let n = rows.len();
    let k = rows.first()?.len();
    if n < 2 || k < 2 || rows.iter().any(|r| r.len() != k) {
        return None;
    }
    let (nf, kf) = (n as f64, k as f64);
    let grand = rows.iter().flatten().sum::<f64>() / (nf * kf);
    let row_means: Vec<f64> = rows.iter().map(|r| r.iter().sum::<f64>() / kf).collect();
    let col_means: Vec<f64> = (0..k).map(|j| rows.iter().map(|r| r[j]).sum::<f64>() / nf).collect();
    let ssr = kf * row_means.iter().map(|m| (m - grand).powi(2)).sum::<f64>();
    let ssc = nf * col_means.iter().map(|m| (m - grand).powi(2)).sum::<f64>();
    let sst: f64 = rows.iter().flatten().map(|x| (x - grand).powi(2)).sum();
    let sse = sst - ssr - ssc;
    let msr = ssr / (nf - 1.0);
    let msc = ssc / (kf - 1.0);
    let mse = sse / ((nf - 1.0) * (kf - 1.0));
    let denom = msr + (kf - 1.0) * mse + kf * (msc - mse) / nf;
    if denom.abs() < 1e-12 {
        // Every value the same: perfect agreement.
        return (sst.abs() < 1e-12).then_some(1.0);
    }
    Some((msr - mse) / denom)
}

/// Mean over targets of the mean absolute difference between pairs of raters.
pub fn mean_abs_diff(rows: &[Vec<f64>]) -> Option<f64> {
    let mut total = 0.0;
    let mut count = 0usize;
    for r in rows {
        let mut s = 0.0;
        let mut c = 0;
        for i in 0..r.len() {
            for j in i + 1..r.len() {
                s += (r[i] - r[j]).abs();
                c += 1;
            }
        }
        if c > 0 {
            total += s / c as f64;
            count += 1;
        }
    }
    (count > 0).then(|| total / count as f64)
}

fn canonical(v: &Json) -> String {
    match v {
        Json::String(s) => s.trim().to_lowercase(),
        Json::Null => String::new(),
        Json::Array(a) => {
            let mut items: Vec<String> = a.iter().map(canonical).collect();
            items.sort();
            items.join("|")
        }
        Json::Number(n) => n.as_f64().map(|x| format!("{x}")).unwrap_or_default(),
        other => other.to_string(),
    }
}

fn number(v: &Json) -> Option<f64> {
    match v {
        Json::Number(n) => n.as_f64(),
        Json::String(s) => s.trim().replace(',', ".").parse().ok(),
        _ => None,
    }
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldPilot {
    pub form_id: String,
    pub field_id: String,
    pub label: String,
    pub kind: String,
    /// Studies every extractor answered.
    pub n: usize,
    /// Studies some but not all extractors answered.
    pub missing: usize,
    pub percent: Option<f64>,
    pub kappa: Option<f64>,
    pub kappa_method: String,
    pub icc: Option<f64>,
    pub mean_abs_diff: Option<f64>,
    pub band: String,
}

/// Agreement per field between `extractors` over `records`.
pub fn field_agreement(state: &State, forms: &[&Form], records: &[String], extractors: &[String]) -> Vec<FieldPilot> {
    let mut out = Vec::new();
    for form in forms {
        for f in form.fields() {
            let key = (form.id.clone(), f.id.clone());
            let mut sets: Vec<Vec<&Json>> = Vec::new();
            let mut missing = 0;
            for r in records {
                let given: Vec<&Json> = extractors
                    .iter()
                    .filter_map(|who| state.extraction.get(r).and_then(|e| e.values.get(&key)).and_then(|v| v.get(who)).map(|x| &x.value))
                    .filter(|v| !canonical(v).is_empty())
                    .collect();
                if given.len() == extractors.len() && !given.is_empty() {
                    sets.push(given);
                } else if !given.is_empty() {
                    missing += 1;
                }
            }
            let n = sets.len();
            let mut row = FieldPilot { form_id: form.id.clone(), field_id: f.id.clone(), label: f.label.clone(), kind: f.kind.clone(), n, missing, ..Default::default() };
            if n == 0 {
                out.push(row);
                continue;
            }
            let texts: Vec<Vec<String>> = sets.iter().map(|s| s.iter().map(|v| canonical(v)).collect()).collect();
            row.percent = Some(texts.iter().filter(|t| t.iter().all(|x| *x == t[0])).count() as f64 / n as f64 * 100.0);
            match f.kind.as_str() {
                "number" => {
                    let nums: Vec<Vec<f64>> = sets.iter().filter_map(|s| s.iter().map(|v| number(v)).collect::<Option<Vec<f64>>>()).collect();
                    row.icc = icc_2_1(&nums);
                    row.mean_abs_diff = mean_abs_diff(&nums);
                    row.band = stats::band(row.icc);
                }
                "choice" | "yesno" | "multi" => {
                    let a = if extractors.len() == 2 { stats::cohen(&texts.iter().map(|t| (t[0].clone(), t[1].clone())).collect::<Vec<_>>()) } else { stats::fleiss(&texts) };
                    row.kappa = a.kappa;
                    row.kappa_method = a.method;
                    row.band = a.band;
                }
                _ => {}
            }
            out.push(row);
        }
    }
    out
}

/// One pilot's report: progress, fields, and the overall percent and pooled kappa.
pub fn pilot_report(state: &State, p: &XPilot) -> Json {
    let forms: Vec<&Form> = state.protocol.forms.iter().filter(|f| p.form_ids.is_empty() || p.form_ids.contains(&f.id)).collect();
    let fields = field_agreement(state, &forms, &p.records, &p.extractors);
    let done = p.records.iter().filter(|r| p.extractors.iter().all(|who| state.extraction.get(*r).is_some_and(|e| forms.iter().all(|f| e.completed.get(&f.id).is_some_and(|w| w.contains(who)))))).count();
    let (percent, kappa) = overall(state, &forms, p, &fields);
    let changed: Vec<Json> = forms.iter().filter(|f| p.form_hashes.get(&f.id).is_some_and(|h| *h != form_hash(f))).map(|f| json!({ "formId": f.id, "name": f.name, "versions": versions_after(state, f, p.closed_at.max(p.at)) })).collect();
    json!({
        "pilot": p,
        "done": done,
        "fields": fields,
        "percent": percent,
        "kappa": kappa,
        "extractorNames": p.extractors.iter().map(|e| state.member_name(e)).collect::<Vec<_>>(),
        "changedSince": changed,
    })
}

/// Mean percent agreement over fields with data, and kappa pooled over every categorical field's
/// paired ratings (two extractors) or Fleiss' kappa over all of them (more).
fn overall(state: &State, forms: &[&Form], p: &XPilot, fields: &[FieldPilot]) -> (Option<f64>, Option<f64>) {
    let with: Vec<f64> = fields.iter().filter_map(|f| f.percent).collect();
    let percent = (!with.is_empty()).then(|| with.iter().sum::<f64>() / with.len() as f64);
    let mut ratings: Vec<Vec<String>> = Vec::new();
    for form in forms {
        for f in form.fields().filter(|f| matches!(f.kind.as_str(), "choice" | "yesno" | "multi")) {
            let key = (form.id.clone(), f.id.clone());
            for r in &p.records {
                let given: Vec<String> = p.extractors.iter().filter_map(|who| state.extraction.get(r).and_then(|e| e.values.get(&key)).and_then(|v| v.get(who)).map(|x| canonical(&x.value))).filter(|s| !s.is_empty()).map(|s| format!("{}:{s}", f.id)).collect();
                if given.len() == p.extractors.len() && given.len() >= 2 {
                    ratings.push(given);
                }
            }
        }
    }
    let kappa = if ratings.is_empty() {
        None
    } else if p.extractors.len() == 2 {
        stats::cohen(&ratings.iter().map(|r| (r[0].clone(), r[1].clone())).collect::<Vec<_>>()).kappa
    } else {
        stats::fleiss(&ratings).kappa
    };
    (percent, kappa)
}

/// Protocol versions after `since` in which the form changed (its later versions).
fn versions_after(state: &State, form: &Form, since: i64) -> Vec<Json> {
    let mut out = Vec::new();
    let mut previous: Option<String> = None;
    for v in &state.versions {
        let h = v.protocol.forms.iter().find(|f| f.id == form.id).map(form_hash);
        if v.at > since && previous.is_some() && h != previous {
            out.push(json!({ "number": v.number, "at": v.at, "note": v.note }));
        }
        previous = h;
    }
    out
}

pub fn pilot_facts(state: &State) -> Json {
    let Some(last) = state.std_b.piloted.last() else { return Json::Null };
    let kappa = last.kappa.map(|k| format!("; pooled κ = {k:.2}")).unwrap_or_default();
    let pct = last.percent.map(|p| format!(", with {p:.0} % agreement across fields{kappa}")).unwrap_or_default();
    json!({
        "statement": format!("The extraction {} piloted on {} with {} {} by {} extractors working independently{pct}.", if last.form_ids.len() == 1 { "form was" } else { "forms were" }, iso_date(last.at), last.n, if last.n == 1 { "study" } else { "studies" }, last.extractors),
        "kappa": last.kappa,
        "percent": last.percent,
        "at": last.at,
        "n": last.n,
    })
}

pub fn contact_facts(state: &State) -> Json {
    let c = &state.std_b.contacts;
    if c.is_empty() {
        return Json::Null;
    }
    let studies: BTreeSet<&String> = c.iter().map(|x| &x.record_id).collect();
    let replied: BTreeSet<&String> = c.iter().filter(|x| x.status == "replied" || !x.reply.trim().is_empty()).map(|x| &x.record_id).collect();
    let data: BTreeSet<&String> = c.iter().filter(|x| x.data_received).map(|x| &x.record_id).collect();
    json!({
        "statement": format!("We contacted the authors of {} {} ({} {}) for missing or unclear information; {} replied and {} provided data.", studies.len(), if studies.len() == 1 { "study" } else { "studies" }, c.len(), if c.len() == 1 { "contact" } else { "contacts" }, replied.len(), data.len()),
        "count": c.len(),
        "studies": studies.len(),
        "replied": replied.len(),
        "dataReceived": data.len(),
    })
}

impl Reviews {
    /// A pilot round: `size` included studies drawn at random (seeded), for `extractors`.
    #[allow(clippy::too_many_arguments)]
    pub fn xpilot_create(&self, review: &str, size: usize, extractors: Vec<String>, form_ids: Vec<String>, name: &str, seed: Option<u64>, actor: &str) -> Result<XPilot> {
        if extractors.len() < 2 {
            return Err("A pilot needs at least two people who extract".into());
        }
        self.write(review, |state, _, b| {
            for e in &extractors {
                state.member(e).ok_or("Choose people on the review's team")?;
            }
            if state.std_b.xpilots.iter().any(|p| p.open) {
                return Err("A pilot round is open already: close it first".into());
            }
            let forms: Vec<&Form> = state.protocol.forms.iter().filter(|f| form_ids.is_empty() || form_ids.contains(&f.id)).collect();
            if forms.is_empty() {
                return Err("Add an extraction form first".into());
            }
            let mut pool: Vec<String> = state.included().iter().map(|r| r.id.clone()).collect();
            if pool.is_empty() {
                return Err("No study is included yet".into());
            }
            let seed = seed.unwrap_or_else(random_u64);
            Rng::new(seed).shuffle(&mut pool);
            pool.truncate(size.max(1));
            let n = state.std_b.xpilots.len() + 1;
            let p = XPilot {
                id: format!("xp{n}"),
                name: if name.trim().is_empty() { format!("Extraction pilot {n}") } else { name.trim().into() },
                form_ids: forms.iter().map(|f| f.id.clone()).collect(),
                records: pool,
                extractors,
                open: true,
                seed,
                form_hashes: forms.iter().map(|f| (f.id.clone(), form_hash(f))).collect(),
                at: 0,
                closed_at: 0,
            };
            Ok((vec![b.event("xpilot.set", actor, None, serde_json::to_value(&p).map_err(|e| e.to_string())?)], p))
        })
    }

    /// Closes a pilot; with `piloted`, records the forms as piloted (date, studies, agreement).
    pub fn xpilot_close(&self, review: &str, id: &str, piloted: bool, actor: &str) -> Result<()> {
        self.write(review, |state, _, b| {
            let mut p = state.std_b.xpilots.iter().find(|p| p.id == id).cloned().ok_or("This pilot no longer exists")?;
            p.open = false;
            p.closed_at = crate::events::now_ms();
            let mut events = vec![b.event("xpilot.set", actor, None, serde_json::to_value(&p).map_err(|e| e.to_string())?)];
            if piloted {
                let forms: Vec<&Form> = state.protocol.forms.iter().filter(|f| p.form_ids.contains(&f.id)).collect();
                let fields = field_agreement(state, &forms, &p.records, &p.extractors);
                let (percent, kappa) = overall(state, &forms, &p, &fields);
                let n = p.records.iter().filter(|r| p.extractors.iter().all(|who| state.extraction.get(*r).is_some_and(|e| e.values.values().any(|v| v.contains_key(who))))).count();
                if n == 0 {
                    return Err("Nobody has extracted from the pilot's studies yet".into());
                }
                let f = FormPiloted { pilot_id: p.id.clone(), form_ids: p.form_ids.clone(), n, extractors: p.extractors.len(), form_hashes: forms.iter().map(|f| (f.id.clone(), form_hash(f))).collect(), percent, kappa, at: 0 };
                events.push(b.event("form.piloted", actor, None, serde_json::to_value(&f).map_err(|e| e.to_string())?));
            }
            Ok((events, ()))
        })
    }

    pub fn xpilots(&self, review: &str) -> Result<Json> {
        self.read(review, |state, conn| {
            let ids: Vec<String> = state.std_b.xpilots.iter().flat_map(|p| p.records.clone()).collect();
            let metas = crate::store::metas(conn, review, &ids)?;
            let pilots: Vec<Json> = state
                .std_b
                .xpilots
                .iter()
                .map(|p| {
                    let mut r = pilot_report(state, p);
                    r["studies"] = json!(p.records.iter().map(|id| json!({ "id": id, "label": crate::export::study_label(state, metas.get(id), id), "title": metas.get(id).map(|m| m.title.clone()).unwrap_or_default() })).collect::<Vec<_>>());
                    r
                })
                .collect();
            Ok(json!({ "pilots": pilots, "piloted": state.std_b.piloted, "facts": pilot_facts(state), "included": state.included().len() }))
        })
    }

    /// Adds or edits (same id) or removes a contact with a study's authors.
    pub fn contact_save(&self, review: &str, mut contact: Contact, actor: &str) -> Result<Contact> {
        if contact.id.is_empty() {
            contact.id = crate::events::short_id("c");
        }
        if !contact.deleted {
            if contact.person.trim().is_empty() {
                return Err("Say who was contacted".into());
            }
            if parse_date(&contact.date).is_none() {
                return Err("Give the date of the contact (YYYY-MM-DD)".into());
            }
            if !["", "waiting", "replied", "noReply"].contains(&contact.status.as_str()) {
                return Err("Unknown status".into());
            }
            if contact.status.is_empty() {
                contact.status = if contact.reply.trim().is_empty() { "waiting".into() } else { "replied".into() };
            }
        }
        self.write(review, |state, _, b| {
            state.record(&contact.record_id).ok_or("This record no longer exists")?;
            let rec = contact.record_id.clone();
            Ok((vec![b.event("contact.log", actor, Some(&rec), serde_json::to_value(&contact).map_err(|e| e.to_string())?)], contact.clone()))
        })
    }

    pub fn contacts(&self, review: &str, record: Option<&str>) -> Result<Json> {
        self.read(review, |state, conn| {
            let list: Vec<&Contact> = state.std_b.contacts.iter().filter(|c| record.is_none_or(|r| c.record_id == r)).collect();
            let ids: Vec<String> = list.iter().map(|c| c.record_id.clone()).collect();
            let metas = crate::store::metas(conn, review, &ids)?;
            let rows: Vec<Json> = list.iter().map(|c| json!({ "contact": c, "study": crate::export::study_label(state, metas.get(&c.record_id), &c.record_id), "byName": state.member_name(&c.by) })).collect();
            Ok(json!({ "contacts": rows, "facts": contact_facts(state) }))
        })
    }
}

pub fn contacts_csv(state: &State) -> String {
    let mut out = String::from("Study record,Date contacted,Who,How,What was asked,Reply,Reply date,Status,Data received,Logged by\n");
    for c in &state.std_b.contacts {
        let cells = [c.record_id.clone(), c.date.clone(), c.person.clone(), c.method.clone(), c.asked.clone(), c.reply.clone(), c.reply_date.clone(), c.status.clone(), if c.data_received { "yes".into() } else { "no".into() }, state.member_name(&c.by)];
        out.push_str(&cells.iter().map(|x| crate::export::csv_cell(x)).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    out
}

pub fn pilot_markdown(state: &State) -> String {
    let mut out = String::from("# Extraction pilot\n\n");
    if state.std_b.xpilots.is_empty() {
        out.push_str("No extraction pilot was run.\n");
        return out;
    }
    if let Some(s) = pilot_facts(state).get("statement").and_then(Json::as_str) {
        out.push_str(s);
        out.push_str("\n\n");
    }
    for p in &state.std_b.xpilots {
        let r = pilot_report(state, p);
        out.push_str(&format!("## {}\n\n{} studies, extractors: {}. Started {}{}.\n\n", p.name, p.records.len(), p.extractors.iter().map(|e| state.member_name(e)).collect::<Vec<_>>().join(", "), iso_date(p.at), if p.open { String::new() } else { format!(", closed {}", iso_date(p.closed_at)) }));
        out.push_str("| Field | Type | Studies | Agreement | κ | ICC(2,1) | Mean abs. difference |\n|---|---|---|---|---|---|---|\n");
        let forms: Vec<&Form> = state.protocol.forms.iter().filter(|f| p.form_ids.is_empty() || p.form_ids.contains(&f.id)).collect();
        for f in field_agreement(state, &forms, &p.records, &p.extractors) {
            let opt = |x: Option<f64>, d: usize| x.map(|v| format!("{v:.d$}")).unwrap_or_else(|| "–".into());
            out.push_str(&format!("| {} | {} | {} | {} | {} | {} | {} |\n", f.label, f.kind, f.n, f.percent.map(|p| format!("{p:.0} %")).unwrap_or_else(|| "–".into()), opt(f.kappa, 2), opt(f.icc, 2), opt(f.mean_abs_diff, 2)));
        }
        if let Some(changed) = r["changedSince"].as_array().filter(|a| !a.is_empty()) {
            out.push_str("\nForms changed after the pilot: ");
            out.push_str(&changed.iter().map(|c| c["name"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>().join(", "));
            out.push_str(" (see the protocol's versions).\n");
        }
        out.push('\n');
    }
    out.push_str("Agreement: share of studies where every extractor gave the same value. κ: Cohen's (two extractors) or Fleiss' (more), for choices. ICC(2,1): two-way random, absolute agreement, single rater (Shrout and Fleiss 1979), for numbers.\n");
    out
}
