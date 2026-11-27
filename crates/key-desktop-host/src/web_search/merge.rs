// Provider pages merged into one list: duplicates (by DOI, then arXiv id, then title and
// year) become one hit that names every provider and keeps the richest details; ranked by
// each work's best rank with any provider, works more providers agree on first among equals,
// then by the provider order, so the lists interleave.
use super::types::{WebHit, WebResult, near_years, title_key};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize)]
pub struct ProviderList {
    pub provider: String,
    #[serde(default)]
    pub results: Vec<WebResult>,
}

fn fill<T: Clone>(into: &mut Option<T>, from: &Option<T>) {
    if into.is_none() {
        into.clone_from(from);
    }
}
fn fill_text(into: &mut Option<String>, from: &Option<String>) {
    if into.as_deref().is_none_or(str::is_empty) && from.as_deref().is_some_and(|f| !f.is_empty()) {
        into.clone_from(from);
    }
}

pub fn merge(lists: &[ProviderList]) -> Vec<WebHit> {
    let mut hits: Vec<WebHit> = Vec::new();
    let mut by_doi: HashMap<String, usize> = HashMap::new();
    let mut by_arxiv: HashMap<String, usize> = HashMap::new();
    let mut by_title: HashMap<String, Vec<usize>> = HashMap::new();
    let order: Vec<&str> = lists.iter().map(|l| l.provider.as_str()).collect();
    for list in lists {
        for (rank, result) in list.results.iter().enumerate() {
            // A fallback provider can answer in the place of the one asked (Google Scholar).
            let provider = if result.fallback_for.is_some() { result.provider.clone() } else { list.provider.clone() };
            let title = title_key(&result.title);
            let arxiv = result.ids.arxiv.as_ref().map(|a| a.to_lowercase());
            let mut at = result.doi.as_ref().and_then(|d| by_doi.get(d).copied());
            if at.is_none() {
                at = arxiv.as_ref().and_then(|a| by_arxiv.get(a).copied());
            }
            if at.is_none() {
                // A title match only joins works whose DOIs do not disagree.
                at = by_title.get(&title).and_then(|candidates| {
                    candidates.iter().copied().find(|&i| {
                        let h = &hits[i].work;
                        !(h.doi.is_some() && result.doi.is_some() && h.doi != result.doi) && near_years(h.year, result.year)
                    })
                });
            }
            let index = match at {
                None => {
                    let key = match &result.doi {
                        Some(doi) => format!("doi:{doi}"),
                        None => format!("{provider}:{}", result.provider_id),
                    };
                    hits.push(WebHit { work: result.clone(), key, found_by: vec![provider], rank });
                    let index = hits.len() - 1;
                    by_title.entry(title).or_default().push(index);
                    index
                }
                Some(index) => {
                    let hit = &mut hits[index];
                    if !hit.found_by.contains(&provider) {
                        hit.found_by.push(provider);
                    }
                    hit.rank = hit.rank.min(rank);
                    let w = &mut hit.work;
                    let ids = result.ids.clone();
                    {
                        let mut merged = w.ids.clone();
                        merged_fill(&mut merged, &ids);
                        w.ids = merged;
                    }
                    fill(&mut w.fallback_for, &result.fallback_for);
                    fill(&mut w.year, &result.year);
                    fill_text(&mut w.venue, &result.venue);
                    fill_text(&mut w.abstract_, &result.abstract_);
                    fill_text(&mut w.doi, &result.doi);
                    fill(&mut w.cited_by, &result.cited_by);
                    fill(&mut w.open_access, &result.open_access);
                    fill_text(&mut w.oa_status, &result.oa_status);
                    fill_text(&mut w.pdf_url, &result.pdf_url);
                    fill_text(&mut w.landing_url, &result.landing_url);
                    fill_text(&mut w.kind, &result.kind);
                    if w.authors.is_empty() {
                        w.authors = result.authors.clone();
                    }
                    if result.abstract_.as_ref().map_or(0, String::len) > w.abstract_.as_ref().map_or(0, String::len) {
                        w.abstract_.clone_from(&result.abstract_);
                    }
                    if result.cited_by.unwrap_or(-1) > w.cited_by.unwrap_or(-1) {
                        w.cited_by = result.cited_by;
                    }
                    if result.open_access == Some(true) {
                        w.open_access = Some(true);
                    }
                    if let Some(doi) = &w.doi {
                        if !hit.key.starts_with("doi:") {
                            hit.key = format!("doi:{doi}");
                        }
                    }
                    index
                }
            };
            let work = &hits[index].work;
            if let Some(doi) = &work.doi {
                by_doi.insert(doi.clone(), index);
            }
            if let Some(arxiv) = &work.ids.arxiv {
                by_arxiv.insert(arxiv.to_lowercase(), index);
            }
        }
    }
    let first = |h: &WebHit| order.iter().position(|p| *p == h.found_by[0]).unwrap_or(usize::MAX);
    hits.sort_by(|a, b| a.rank.cmp(&b.rank).then(b.found_by.len().cmp(&a.found_by.len())).then(first(a).cmp(&first(b))));
    hits
}

fn merged_fill(into: &mut super::types::Ids, from: &super::types::Ids) {
    for (a, b) in [
        (&mut into.openalex, &from.openalex),
        (&mut into.s2, &from.s2),
        (&mut into.arxiv, &from.arxiv),
        (&mut into.pmid, &from.pmid),
        (&mut into.pmcid, &from.pmcid),
        (&mut into.mag, &from.mag),
    ] {
        fill_text(a, b);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::tests::fixture;
    use crate::backend::web_search::{openalex, semantic_scholar};

    fn result(id: &str, title: &str, f: impl FnOnce(&mut WebResult)) -> WebResult {
        let mut r = WebResult { provider: "a".into(), provider_id: id.into(), title: title.into(), ..Default::default() };
        f(&mut r);
        r
    }
    fn list(provider: &str, results: Vec<WebResult>) -> ProviderList {
        ProviderList { provider: provider.into(), results }
    }

    #[test]
    fn joins_the_same_work_by_doi_arxiv_id_then_title_and_year() {
        let merged = merge(&[
            list("openalex", openalex::parse_page(&fixture("openalex-search.json")).results),
            list("s2", semantic_scholar::parse_page(&fixture("s2-search.json")).results),
        ]);
        let titles: Vec<&str> = merged.iter().map(|h| h.work.title.as_str()).collect();
        assert_eq!(
            titles,
            [
                "Attention Is All You Need",
                "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
                "Highly accurate protein structure prediction with AlphaFold",
                "Language Models are Few-Shot Learners",
            ]
        );
        let (attention, bert) = (&merged[0], &merged[1]);
        assert_eq!(attention.found_by, ["openalex", "s2"]);
        assert_eq!(attention.work.ids.openalex.as_deref(), Some("W2963403868"));
        assert_eq!(attention.work.ids.s2.as_deref(), Some("204e3073870fae3d05bcbc2f6a8e263d9b72e776"));
        assert_eq!(attention.work.ids.arxiv.as_deref(), Some("1706.03762"));
        // The richer abstract and the higher count win.
        assert!(attention.work.abstract_.as_deref().unwrap().ends_with("attention mechanism."));
        assert_eq!(attention.work.cited_by, Some(120000));
        assert_eq!(attention.work.open_access, Some(true));
        assert_eq!(bert.key, "doi:10.18653/v1/n19-1423");
        assert_eq!(bert.found_by, ["openalex", "s2"]);
    }

    #[test]
    fn keeps_works_apart_whose_dois_differ_or_whose_years_are_far_apart() {
        let merged = merge(&[
            list("a", vec![result("1", "Review", |r| (r.doi, r.year) = (Some("10.1/a".into()), Some(2020))), result("2", "Same name", |r| r.year = Some(1990))]),
            list("b", vec![result("1", "Review", |r| (r.doi, r.year) = (Some("10.1/b".into()), Some(2020))), result("3", "Same name", |r| r.year = Some(2020))]),
        ]);
        assert_eq!(merged.len(), 4);
        // Titles that differ only in case, a year apart, are the same work.
        let near = merge(&[list("a", vec![result("1", "X", |r| r.year = Some(2001))]), list("b", vec![result("2", "x", |r| r.year = Some(2002))])]);
        assert_eq!((near.len(), near[0].found_by.clone()), (1, vec!["a".to_string(), "b".to_string()]));
    }

    #[test]
    fn interleaves_by_rank_agreement_first_among_equals() {
        let merged = merge(&[list("a", vec![result("a1", "One", |_| {}), result("a2", "Two", |_| {})]), list("b", vec![result("b1", "Three", |_| {}), result("b2", "Two", |_| {})])]);
        assert_eq!(merged.iter().map(|h| h.work.title.as_str()).collect::<Vec<_>>(), ["One", "Three", "Two"]);
        assert_eq!(merged[2].found_by, ["a", "b"]);
    }
}
