// What to follow, found from what the user types: journals, people and topics from OpenAlex's
// sources/authors/topics search (with how many of each the library has), arXiv categories, a
// saved OpenAlex or PubMed search, and a page or feed address; the library's own top journals,
// people and topics; and a preview of any of them before it is followed (the latest items,
// how often it posts). PubMed searches are asked through NCBI's E-utilities.
use super::{Failure, Inner, Response, address, civil, config_text, parse, short};
use crate::backend::web_search::types::fold;
use key_safe_http::CancellationToken;
use key_store::feeds::Subscription;
use serde_json::{Map, Value as Json, json};
use url::Url;

/// arXiv's listings: code and name (the common ones; any code can be typed).
pub const ARXIV: &[(&str, &str)] = &[
    ("cs.AI", "Artificial Intelligence"),
    ("cs.CL", "Computation and Language"),
    ("cs.CV", "Computer Vision and Pattern Recognition"),
    ("cs.CY", "Computers and Society"),
    ("cs.DS", "Data Structures and Algorithms"),
    ("cs.HC", "Human-Computer Interaction"),
    ("cs.IR", "Information Retrieval"),
    ("cs.LG", "Machine Learning"),
    ("cs.RO", "Robotics"),
    ("cs.SE", "Software Engineering"),
    ("stat.ML", "Machine Learning (Statistics)"),
    ("stat.ME", "Statistics Methodology"),
    ("math.PR", "Probability"),
    ("math.ST", "Statistics Theory"),
    ("math.OC", "Optimization and Control"),
    ("physics.soc-ph", "Physics and Society"),
    ("quant-ph", "Quantum Physics"),
    ("cond-mat", "Condensed Matter"),
    ("astro-ph", "Astrophysics"),
    ("hep-th", "High Energy Physics – Theory"),
    ("gr-qc", "General Relativity and Quantum Cosmology"),
    ("q-bio.NC", "Neurons and Cognition"),
    ("q-bio.PE", "Populations and Evolution"),
    ("q-bio.GN", "Genomics"),
    ("q-fin.GN", "General Finance"),
    ("econ.EM", "Econometrics"),
    ("econ.GN", "General Economics"),
    ("eess.SP", "Signal Processing"),
    ("eess.IV", "Image and Video Processing"),
];

pub fn arxiv_feed(code: &str) -> String {
    format!("https://rss.arxiv.org/rss/{code}")
}

fn pubmed_base() -> String {
    std::env::var("KEY_FEEDS_PUBMED_URL").ok().filter(|u| !u.trim().is_empty()).unwrap_or_else(|| "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/".into())
}

/// Text that reads as an address rather than words: "nature.com/nature.rss", "https://…".
pub fn looks_like_address(text: &str) -> bool {
    let t = text.trim();
    if t.contains("://") {
        return true;
    }
    !t.contains(char::is_whitespace) && t.contains('.') && t.rsplit('.').next().is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphanumeric() || c == '/'))
        || (!t.contains(char::is_whitespace) && t.contains('/') && t.contains('.'))
}

/// Items per week from their dates (YYYY-MM-DD), newest to oldest.
pub fn per_week(dates: &[String]) -> Option<f64> {
    let mut days: Vec<i64> = dates.iter().filter_map(|d| day_number(d)).collect();
    if days.len() < 2 {
        return None;
    }
    days.sort_unstable();
    let span = (days[days.len() - 1] - days[0]).max(1) as f64;
    Some(((days.len() - 1) as f64 * 7.0 / span * 10.0).round() / 10.0)
}

fn day_number(date: &str) -> Option<i64> {
    let mut parts = date.get(..10)?.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

/// What a failing subscription's error means, as a code the app explains with a fix.
pub fn problem(error: &str) -> &'static str {
    let e = error.to_lowercase();
    if e.contains("limiting") {
        "limited"
    } else if e.contains("did not answer") || e.contains("couldn't reach") {
        "unreachable"
    } else if e.contains("no longer has") {
        "gone"
    } else if e.contains("http 401") || e.contains("http 403") {
        "blocked"
    } else if e.contains("does not serve a feed") || e.contains("no feed found") {
        "not-a-feed"
    } else if e.contains("no openalex") || e.contains("no words") || e.contains("none of these sources") || e.contains("no pubmed search") {
        "nothing-to-follow"
    } else {
        "other"
    }
}

fn s(v: &Json, key: &str) -> Option<String> {
    v.get(key).and_then(Json::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

impl Inner {
    fn following(&self, kind: &str, config: &Map<String, Json>) -> bool {
        self.store.find_feed_subscription(kind, config).ok().flatten().is_some()
    }

    fn suggestion(&self, kind: &str, title: &str, config: Json, extra: Json) -> Json {
        let config = config.as_object().cloned().unwrap_or_default();
        let mut out = json!({ "kind": kind, "title": title, "following": self.following(kind, &config), "config": config });
        if let (Some(out), Some(extra)) = (out.as_object_mut(), extra.as_object()) {
            for (k, v) in extra {
                if !v.is_null() {
                    out.insert(k.clone(), v.clone());
                }
            }
        }
        out
    }

    fn openalex_search(&self, path: &str, query: &str, select: &str, per_page: &str, cancel: &CancellationToken) -> Result<Vec<Json>, String> {
        let body = self.web.openalex_json(path, &[("search", query), ("per-page", per_page), ("select", select)], cancel).map_err(|e| e.message)?;
        Ok(body["results"].as_array().cloned().unwrap_or_default())
    }

    /// Everything that could be followed for what was typed.
    pub(super) fn suggest(&self, text: &str) -> Result<Json, String> {
        let query = text.trim();
        if query.chars().count() < 2 {
            return Ok(json!({ "query": query, "journals": [], "people": [], "topics": [], "arxiv": [], "searches": [] }));
        }
        if looks_like_address(query) {
            return Ok(json!({ "query": query, "address": true }));
        }
        let cancel = CancellationToken::active();
        let (journals, people, topics) = std::thread::scope(|scope| {
            let journals = scope.spawn(|| self.openalex_search("sources", query, "id,display_name,host_organization_name,issn_l,issn,works_count,homepage_url,type", "6", &cancel));
            let people = scope.spawn(|| self.openalex_search("authors", query, "id,display_name,orcid,works_count,last_known_institutions", "5", &cancel));
            let topics = scope.spawn(|| self.openalex_search("topics", query, "id,display_name,works_count,field,subfield", "4", &cancel));
            let join = |h: std::thread::ScopedJoinHandle<'_, Result<Vec<Json>, String>>| h.join().unwrap_or_else(|_| Err("The search stopped".into()));
            (join(journals), join(people), join(topics))
        });
        let error = [&journals, &people, &topics].iter().find_map(|r| r.as_ref().err().cloned());
        let (journals, people, topics) = (journals.unwrap_or_default(), people.unwrap_or_default(), topics.unwrap_or_default());
        let ids: Vec<String> = journals.iter().chain(&people).filter_map(|v| s(v, "id")).map(|id| short(&id)).collect();
        let counts = self.store.library_counts_for_openalex(&ids).unwrap_or_default();
        let in_library = |id: &str| counts.get(id).and_then(Json::as_i64).unwrap_or(0);
        let journals: Vec<Json> = journals
            .iter()
            .filter_map(|v| {
                let id = short(&s(v, "id")?);
                let name = s(v, "display_name")?;
                let mut config = json!({ "openalexId": id, "issn": s(v, "issn_l"), "homepage": s(v, "homepage_url") });
                if let Some(c) = config.as_object_mut() {
                    c.retain(|_, v| !v.is_null());
                }
                Some(self.suggestion(
                    "venue",
                    &name,
                    config,
                    json!({ "publisher": s(v, "host_organization_name"), "issn": s(v, "issn_l"), "worksCount": v["works_count"], "type": s(v, "type"), "inLibrary": in_library(&id), "homepage": s(v, "homepage_url") }),
                ))
            })
            .collect();
        let people: Vec<Json> = people
            .iter()
            .filter_map(|v| {
                let id = short(&s(v, "id")?);
                let name = s(v, "display_name")?;
                let orcid = s(v, "orcid").map(|o| o.rsplit('/').next().unwrap_or(&o).to_string());
                let affiliation = v["last_known_institutions"].as_array().and_then(|a| a.first()).and_then(|i| s(i, "display_name"));
                Some(self.suggestion("author", &name, json!({ "openalexId": id }), json!({ "affiliation": affiliation, "orcid": orcid, "worksCount": v["works_count"], "inLibrary": in_library(&id) })))
            })
            .collect();
        let topics: Vec<Json> = topics
            .iter()
            .filter_map(|v| {
                let id = short(&s(v, "id")?);
                let name = s(v, "display_name")?;
                let field = v.get("subfield").and_then(|f| s(f, "display_name")).or_else(|| v.get("field").and_then(|f| s(f, "display_name")));
                Some(self.suggestion("topic", &name, json!({ "openalexId": id }), json!({ "field": field, "worksCount": v["works_count"] })))
            })
            .collect();
        let folded = fold(query);
        let arxiv: Vec<Json> = ARXIV
            .iter()
            .filter(|(code, name)| fold(code).contains(&folded) || fold(name).contains(&folded) || folded.split(' ').all(|w| w.len() > 2 && fold(name).contains(w)))
            .take(4)
            .map(|(code, name)| self.suggestion("rss", &format!("arXiv {code}: {name}"), json!({ "url": arxiv_feed(code), "arxiv": code }), json!({ "code": code, "name": name })))
            .collect();
        let searches = vec![
            self.suggestion("openalex", query, json!({ "query": query }), json!({})),
            self.suggestion("pubmed", &format!("PubMed: {query}"), json!({ "query": query }), json!({})),
        ];
        Ok(json!({ "query": query, "journals": journals, "people": people, "topics": topics, "arxiv": arxiv, "searches": searches, "error": error }))
    }

    /// The library's most frequent journals, people and topics, ready to follow.
    pub(super) fn from_library(&self) -> Result<Json, String> {
        let picks = self.store.followable_in_library(6)?;
        let list = |key: &str| picks[key].as_array().cloned().unwrap_or_default();
        let mut out = Vec::new();
        for v in list("journals") {
            let (Some(name), count) = (s(&v, "name"), v["count"].clone()) else { continue };
            let config = match (s(&v, "openalexId"), s(&v, "detail")) {
                (Some(id), _) => json!({ "openalexId": short(&id) }),
                (None, Some(issn)) => json!({ "issn": issn }),
                _ => continue,
            };
            out.push(self.suggestion("venue", &name, config, json!({ "count": count, "issn": s(&v, "detail") })));
        }
        for v in list("people") {
            let (Some(name), count) = (s(&v, "name"), v["count"].clone()) else { continue };
            let config = match (s(&v, "openalexId"), s(&v, "detail")) {
                (Some(id), _) => json!({ "openalexId": short(&id) }),
                (None, Some(orcid)) => json!({ "orcid": orcid }),
                _ => continue,
            };
            out.push(self.suggestion("author", &name, config, json!({ "count": count, "orcid": s(&v, "detail") })));
        }
        for v in list("topics") {
            let (Some(name), Some(id)) = (s(&v, "name"), s(&v, "id")) else { continue };
            out.push(self.suggestion("topic", &name, json!({ "openalexId": id }), json!({ "count": v["count"], "level": s(&v, "detail") })));
        }
        Ok(json!(out))
    }

    /// A feed from an address: itself, or the first one the page links to. Answers the
    /// feed's address, the response and the parsed feed, and the page when it was one.
    pub(super) fn resolve_feed(&self, typed: &str, cancel: &CancellationToken) -> Result<(Url, Response, parse::Feed, Option<String>), String> {
        let url = address(typed)?;
        let response = self.get(&url, None, None, cancel).map_err(|f| f.message)?;
        let body = String::from_utf8_lossy(&response.body).into_owned();
        if let Some(feed) = parse::feed(&body, Some(&url)) {
            return Ok((url, response, feed, None));
        }
        let found = parse::discover(&body, &url);
        let (feed_url, _) = found.first().ok_or("No feed found at this address")?;
        let feed_url = address(feed_url)?;
        let (response, feed) = self.fetch_feed(&feed_url, None, None, cancel).map_err(|f| f.message)?;
        Ok((feed_url, response, feed.ok_or("No feed found at this address")?, Some(url.to_string())))
    }

    /// What following this would bring: the latest few items, how often it posts, and for a
    /// journal its own feed when its home page offers one.
    pub(super) fn preview(&self, kind: &str, config: &Map<String, Json>) -> Result<Json, String> {
        let cancel = CancellationToken::active();
        let latest = |items: &[Json]| items.iter().filter_map(|i| s(i, "published")).max();
        if kind == "rss" {
            let typed = config_text(config, "url").ok_or("Enter a feed or page address")?;
            let (url, _, feed, site) = self.resolve_feed(&typed, &cancel)?;
            let dates: Vec<String> = feed.items.iter().filter_map(|i| s(i, "published")).collect();
            let items: Vec<Json> = feed.items.iter().take(5).cloned().collect();
            let title = feed.title.clone().or_else(|| url.host_str().map(String::from));
            let mut out_config = config.clone();
            out_config.insert("url".into(), json!(url.to_string()));
            if let Some(site) = &site {
                out_config.insert("site".into(), json!(site));
            }
            return Ok(json!({
                "kind": "rss", "title": title, "config": out_config, "items": items, "count": feed.items.len(),
                "perWeek": per_week(&dates), "latest": latest(&feed.items), "following": self.following("rss", &out_config),
            }));
        }
        let probe = Subscription { id: String::new(), kind: kind.into(), title: String::new(), config: config.clone(), interval_minutes: 0, paused: false, created_at: 0, checked_at: None, next_at: None, failures: 0, last_error: None, etag: None, last_modified: None, cursor: None, unread: 0, total: 0, last_item_at: None };
        let year_ago = civil(key_store::now_ms() - 365 * 86_400_000);
        let (items, per_year) = if kind == "pubmed" {
            let query = config_text(config, "query").ok_or("This PubMed search has no words")?;
            let (items, count) = self.pubmed(&query, 5, Some(365), &cancel).map_err(|f| f.message)?;
            (items, count)
        } else {
            let (query, requests) = self.openalex_query(&probe)?;
            let select = format!("{},publication_date", crate::backend::web_search::openalex::FIELDS);
            let mut filters = requests.into_iter().next().unwrap_or_default();
            filters.push(format!("from_publication_date:{year_ago}"));
            let filter = filters.join(",");
            let mut params: Vec<(&str, &str)> = vec![("filter", &filter), ("sort", "publication_date:desc"), ("per-page", "5"), ("select", &select)];
            if let Some(q) = &query {
                params.push(("search", q));
            }
            let body = self.web.openalex_json("works", &params, &cancel).map_err(|e| e.message)?;
            let items = body["results"].as_array().into_iter().flatten().filter_map(|raw| {
                let mut value = serde_json::to_value(crate::backend::web_search::openalex::parse_work(raw)?).ok()?;
                if let Some(date) = raw["publication_date"].as_str() {
                    value["published"] = json!(date);
                }
                Some(value)
            });
            (items.collect::<Vec<_>>(), body["meta"]["count"].as_i64())
        };
        // A journal's own table-of-contents feed, when its home page links to one.
        let alternative = (kind == "venue")
            .then(|| config_text(config, "homepage"))
            .flatten()
            .and_then(|home| self.resolve_feed(&home, &cancel).ok())
            .map(|(url, _, feed, _)| json!({ "url": url.to_string(), "title": feed.title, "count": feed.items.len() }));
        Ok(json!({
            "kind": kind, "config": config, "items": items, "perYear": per_year,
            "perWeek": per_year.map(|n| (n as f64 / 52.0 * 10.0).round() / 10.0), "latest": latest(&items),
            "alternative": alternative, "following": self.following(kind, config),
        }))
    }

    /// A PubMed search's newest records (within `days` when given) and how many match.
    pub(super) fn pubmed(&self, query: &str, max: usize, days: Option<i64>, cancel: &CancellationToken) -> Result<(Vec<Json>, Option<i64>), Failure> {
        let base = pubmed_base();
        let max = max.to_string();
        let days = days.map(|d| d.to_string());
        let mut pairs: Vec<(&str, &str)> = vec![("db", "pubmed"), ("term", query), ("sort", "pub_date"), ("retmax", &max), ("retmode", "json"), ("tool", "Key")];
        if let Some(days) = &days {
            pairs.extend([("datetype", "edat"), ("reldate", days.as_str())]);
        }
        let search = Url::parse_with_params(&format!("{base}esearch.fcgi"), &pairs).map_err(|e| Failure::from(e.to_string()))?;
        let found: Json = serde_json::from_slice(&self.get(&search, None, None, cancel)?.body).map_err(|_| Failure::from("PubMed sent something Key could not read".to_string()))?;
        let count = found["esearchresult"]["count"].as_str().and_then(|c| c.parse().ok());
        let ids: Vec<String> = found["esearchresult"]["idlist"].as_array().into_iter().flatten().filter_map(Json::as_str).map(String::from).collect();
        if ids.is_empty() {
            return Ok((Vec::new(), count));
        }
        std::thread::sleep(std::time::Duration::from_millis(350));
        let joined = ids.join(",");
        let summary = Url::parse_with_params(&format!("{base}esummary.fcgi"), &[("db", "pubmed"), ("id", joined.as_str()), ("retmode", "json"), ("tool", "Key")]).map_err(|e| Failure::from(e.to_string()))?;
        let body: Json = serde_json::from_slice(&self.get(&summary, None, None, cancel)?.body).map_err(|_| Failure::from("PubMed sent something Key could not read".to_string()))?;
        Ok((ids.iter().filter_map(|id| pubmed_work(&body["result"][id])).collect(), count))
    }
}

/// One esummary record as a web-search-shaped work.
pub fn pubmed_work(r: &Json) -> Option<Json> {
    let uid = s(r, "uid")?;
    let title = s(r, "title")?.trim_end_matches('.').to_string();
    let authors: Vec<String> = r["authors"].as_array().into_iter().flatten().filter(|a| a["authtype"].as_str().is_none_or(|t| t == "Author")).filter_map(|a| s(a, "name")).collect();
    let doi = r["articleids"].as_array().into_iter().flatten().find(|a| a["idtype"] == "doi").and_then(|a| s(a, "value"));
    let published = s(r, "sortpubdate").and_then(|d| d.get(..10).map(|d| d.replace('/', "-")));
    let year = s(r, "pubdate").and_then(|d| d.get(..4).and_then(|y| y.parse::<i64>().ok()));
    Some(json!({
        "provider": "pubmed", "title": title, "authors": authors, "year": year, "venue": s(r, "fulljournalname").or_else(|| s(r, "source")),
        "doi": doi.map(|d| d.to_lowercase()), "ids": { "pmid": uid }, "landingUrl": format!("https://pubmed.ncbi.nlm.nih.gov/{uid}/"), "published": published,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_dates_and_problems() {
        assert!(looks_like_address("https://x.org/feed"));
        assert!(looks_like_address("nature.com/nature.rss"));
        assert!(looks_like_address("journalofecology.org"));
        assert!(!looks_like_address("journal of ecology"));
        assert!(!looks_like_address("Bengio"));
        assert_eq!(per_week(&["2025-01-15".into(), "2025-01-08".into(), "2025-01-01".into()]), Some(1.0));
        assert_eq!(per_week(&["2025-01-15".into()]), None);
        assert_eq!(problem("journal.org is limiting requests"), "limited");
        assert_eq!(problem("Couldn't reach x.org: dns"), "unreachable");
        assert_eq!(problem("x.org no longer has this feed (HTTP 404)"), "gone");
        assert_eq!(problem("This address does not serve a feed"), "not-a-feed");
    }

    #[test]
    fn reads_pubmed_summaries() {
        let body: Json = serde_json::from_str(include_str!("fixtures/pubmed-esummary.json")).unwrap();
        let uid = body["result"]["uids"][0].as_str().unwrap();
        let work = pubmed_work(&body["result"][uid]).unwrap();
        assert!(work["title"].as_str().unwrap().starts_with("Five-year monitoring of coral nursery"));
        assert!(!work["title"].as_str().unwrap().ends_with('.'));
        assert_eq!(work["authors"][0], "Nazurally N");
        assert_eq!(work["venue"], "Marine pollution bulletin");
        assert_eq!(work["ids"]["pmid"], uid);
        assert_eq!(work["year"], 2027);
    }
}
