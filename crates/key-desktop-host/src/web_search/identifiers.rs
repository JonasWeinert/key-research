// Add by identifier: DOIs, ISBNs, PMIDs, PMCIDs and arXiv ids, one or many pasted at once.
// Each is looked for in the library first (`store_match_identifiers`), then looked up: a DOI
// in OpenAlex, else Crossref; a PMID or PMCID in OpenAlex, else (a PMID) NCBI's E-utilities;
// an arXiv id in arXiv's API, else OpenAlex by its arXiv DOI; an ISBN in Open Library. Base
// URLs can point at a test's mock (KEY_WEB_CROSSREF_URL, KEY_WEB_ARXIV_URL, KEY_WEB_NCBI_URL,
// KEY_WEB_OPENLIBRARY_URL), as the web search providers' can.
use super::http::Base;
use super::library::{creator_of, source_input};
use super::types::{Ids, WebResult};
use super::{Library, WebSearch};
use key_safe_http::CancellationToken;
use key_store::smart_query::{Identifier, read_identifiers};
use serde_json::{Value as Json, json};

fn get(web: &WebSearch, base: &Base, path: &str, query: &[(&str, &str)], accept: &str, label: &str) -> Result<(u16, Vec<u8>), String> {
    let url = base.url(path, query)?;
    let headers: Vec<(&str, &str)> = if accept.is_empty() { vec![] } else { vec![("accept", accept)] };
    match (web.transport)(base, &url, &headers, &CancellationToken::active()) {
        Ok(response) => Ok((response.status, response.body)),
        Err(_) => Err(format!("Couldn't reach {label}")),
    }
}

fn get_json(web: &WebSearch, base: &Base, path: &str, query: &[(&str, &str)], label: &str) -> Result<Option<Json>, String> {
    let (status, body) = get(web, base, path, query, "", label)?;
    match status {
        200..=299 => serde_json::from_slice(&body).map(Some).map_err(|_| format!("{label} sent an unreadable answer")),
        404 => Ok(None),
        status => Err(format!("{label} returned HTTP {status}")),
    }
}

fn text(value: &Json) -> Option<String> {
    match value {
        Json::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Json::Array(items) => items.iter().find_map(text),
        _ => None,
    }
}

fn year_in(text: &str) -> Option<i64> {
    let digits: Vec<char> = text.chars().collect();
    digits.windows(4).find_map(|w| {
        let s: String = w.iter().collect();
        s.parse::<i64>().ok().filter(|y| (1400..=2100).contains(y) && w.iter().all(char::is_ascii_digit))
    })
}

// ── Crossref (a DOI OpenAlex does not know) ──────────────────────────────────

pub fn crossref_work(body: &Json) -> Option<WebResult> {
    let m = body.get("message")?;
    let title = text(m.get("title")?)?;
    let authors = m
        .get("author")
        .and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    let name = [a.get("given").and_then(Json::as_str), a.get("family").and_then(Json::as_str)].into_iter().flatten().collect::<Vec<_>>().join(" ");
                    Some(name).filter(|n| !n.trim().is_empty()).or_else(|| a.get("name").and_then(Json::as_str).map(String::from))
                })
                .collect()
        })
        .unwrap_or_default();
    let year = ["published", "issued", "published-print", "published-online", "created"]
        .iter()
        .find_map(|k| m.get(*k)?.get("date-parts")?.get(0)?.get(0)?.as_i64());
    Some(WebResult {
        provider: "crossref".into(),
        provider_id: m.get("DOI").and_then(Json::as_str).unwrap_or("").to_lowercase(),
        title,
        authors,
        year,
        venue: m.get("container-title").and_then(text),
        abstract_: m.get("abstract").and_then(Json::as_str).map(|a| super::types::strip_tags(a).trim().to_string()),
        doi: m.get("DOI").and_then(Json::as_str).map(str::to_lowercase),
        landing_url: m.get("URL").and_then(Json::as_str).map(String::from),
        kind: m.get("type").and_then(Json::as_str).map(|t| match t {
            "journal-article" => "article".to_string(),
            other => other.to_string(),
        }),
        ..Default::default()
    })
}

// ── arXiv's API (Atom) ───────────────────────────────────────────────────────

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#39;", "'").replace("&amp;", "&")
}

/// The text of each `<tag …>…</tag>` in `xml`, in order.
fn elements<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let (open, close) = (format!("<{tag}"), format!("</{tag}>"));
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = xml[from..].find(&open) {
        let start = from + at;
        let after = &xml[start + open.len()..];
        if !after.starts_with(['>', ' ', '\n', '\t', '/']) {
            from = start + open.len();
            continue;
        }
        let Some(gt) = after.find('>') else { break };
        if after[..gt].ends_with('/') {
            from = start + open.len() + gt + 1;
            continue;
        }
        let body_start = start + open.len() + gt + 1;
        let Some(end) = xml[body_start..].find(&close) else { break };
        out.push(&xml[body_start..body_start + end]);
        from = body_start + end + close.len();
    }
    out
}

fn squash(text: &str) -> String {
    unescape(&text.split_whitespace().collect::<Vec<_>>().join(" "))
}

pub fn arxiv_work(xml: &str, id: &str) -> Option<WebResult> {
    let entry = *elements(xml, "entry").first()?;
    let title = squash(elements(entry, "title").first()?);
    // arXiv answers an unknown id with an "Error" entry.
    if title.is_empty() || title.eq_ignore_ascii_case("error") {
        return None;
    }
    let authors = elements(entry, "author").iter().filter_map(|a| elements(a, "name").first().map(|n| squash(n))).collect();
    let year = elements(entry, "published").first().and_then(|p| year_in(p));
    let doi = elements(entry, "arxiv:doi").first().map(|d| squash(d).to_lowercase());
    Some(WebResult {
        provider: "arxiv".into(),
        provider_id: id.into(),
        title,
        authors,
        year,
        venue: elements(entry, "arxiv:journal_ref").first().map(|j| squash(j)).or(Some("arXiv".into())),
        abstract_: elements(entry, "summary").first().map(|s| squash(s)),
        doi,
        ids: Ids { arxiv: Some(id.into()), ..Default::default() },
        open_access: Some(true),
        pdf_url: Some(format!("https://arxiv.org/pdf/{id}")),
        landing_url: Some(format!("https://arxiv.org/abs/{id}")),
        kind: Some("preprint".into()),
        ..Default::default()
    })
}

// ── NCBI E-utilities (a PMID OpenAlex does not know) ─────────────────────────

pub fn pubmed_work(body: &Json, pmid: &str) -> Option<WebResult> {
    let item = body.get("result")?.get(pmid)?;
    let title = item.get("title").and_then(Json::as_str).map(|t| t.trim().trim_end_matches('.').to_string()).filter(|t| !t.is_empty())?;
    let authors = item.get("authors").and_then(Json::as_array).map(|a| a.iter().filter_map(|x| x.get("name")?.as_str().map(String::from)).collect()).unwrap_or_default();
    let ids = item.get("articleids").and_then(Json::as_array).cloned().unwrap_or_default();
    let id_of = |kind: &str| ids.iter().find(|i| i.get("idtype").and_then(Json::as_str) == Some(kind)).and_then(|i| i.get("value")?.as_str().map(String::from));
    Some(WebResult {
        provider: "pubmed".into(),
        provider_id: pmid.into(),
        title,
        authors,
        year: item.get("pubdate").and_then(Json::as_str).and_then(year_in),
        venue: item.get("fulljournalname").and_then(Json::as_str).or(item.get("source").and_then(Json::as_str)).map(String::from),
        doi: id_of("doi").map(|d| d.to_lowercase()),
        ids: Ids { pmid: Some(pmid.into()), pmcid: id_of("pmc"), ..Default::default() },
        landing_url: Some(format!("https://pubmed.ncbi.nlm.nih.gov/{pmid}/")),
        kind: Some("article".into()),
        ..Default::default()
    })
}

// ── Open Library (ISBN) ──────────────────────────────────────────────────────

/// A book: the work, and the fields a web result has no place for (ISBN, publisher, place).
pub fn open_library_book(body: &Json, isbn: &str) -> Option<(WebResult, Json)> {
    let book = body.get(format!("ISBN:{isbn}"))?;
    let mut title = book.get("title").and_then(Json::as_str)?.trim().to_string();
    if let Some(subtitle) = book.get("subtitle").and_then(Json::as_str).filter(|s| !s.trim().is_empty()) {
        title = format!("{title}: {}", subtitle.trim());
    }
    let names = |key: &str| -> Vec<String> { book.get(key).and_then(Json::as_array).map(|l| l.iter().filter_map(|x| x.get("name")?.as_str().map(String::from)).collect()).unwrap_or_default() };
    let work = WebResult {
        provider: "openlibrary".into(),
        provider_id: isbn.into(),
        title,
        authors: names("authors"),
        year: book.get("publish_date").and_then(Json::as_str).and_then(year_in),
        landing_url: book.get("url").and_then(Json::as_str).map(String::from),
        kind: Some("book".into()),
        ..Default::default()
    };
    let extra = json!({
        "isbn": isbn,
        "publisher": names("publishers").first(),
        "place": names("publish_places").first(),
        "itemType": "book",
    });
    Some((work, extra))
}

// ── Resolving and adding ─────────────────────────────────────────────────────

/// The work an identifier names, with any extra fields for its source; None when unknown.
pub fn resolve(web: &WebSearch, id: &Identifier) -> Result<Option<(WebResult, Json)>, String> {
    let plain = |w: Option<WebResult>| w.filter(|w| !w.title.trim().is_empty()).map(|w| (w, json!({})));
    match id.kind {
        "doi" => {
            if let Some(found) = plain(web.lookup("openalex", &id.value).ok().flatten()) {
                return Ok(Some(found));
            }
            let base = Base::from_env("KEY_WEB_CROSSREF_URL", "https://api.crossref.org");
            let mailto = web.mailto();
            Ok(get_json(web, &base, &format!("works/{}", id.value), &[("mailto", &mailto)], "Crossref")?.as_ref().and_then(crossref_work).map(|w| (w, json!({}))))
        }
        "pmid" | "pmcid" => {
            let key = format!("{}:{}", id.kind, id.value);
            let found = web.lookup("openalex", &key).ok().flatten();
            if let Some(found) = plain(found) {
                return Ok(Some(found));
            }
            if id.kind != "pmid" {
                return Ok(None);
            }
            let base = Base::from_env("KEY_WEB_NCBI_URL", "https://eutils.ncbi.nlm.nih.gov");
            let body = get_json(web, &base, "entrez/eutils/esummary.fcgi", &[("db", "pubmed"), ("id", &id.value), ("retmode", "json")], "PubMed")?;
            Ok(body.as_ref().and_then(|b| pubmed_work(b, &id.value)).map(|w| (w, json!({}))))
        }
        "arxiv" => {
            let base = Base::from_env("KEY_WEB_ARXIV_URL", "https://export.arxiv.org");
            if let Ok((200, body)) = get(web, &base, "api/query", &[("id_list", &id.value), ("max_results", "1")], "application/atom+xml", "arXiv") {
                if let Some(work) = arxiv_work(&String::from_utf8_lossy(&body), &id.value) {
                    return Ok(Some((work, json!({}))));
                }
            }
            let found = web.lookup("openalex", &format!("10.48550/arxiv.{}", id.value))?;
            Ok(plain(found).map(|(mut w, extra)| {
                w.ids.arxiv.get_or_insert(id.value.clone());
                (w, extra)
            }))
        }
        "isbn" => {
            let base = Base::from_env("KEY_WEB_OPENLIBRARY_URL", "https://openlibrary.org");
            let key = format!("ISBN:{}", id.value);
            let body = get_json(web, &base, "api/books", &[("bibkeys", &key), ("format", "json"), ("jscmd", "data")], "Open Library")?;
            Ok(body.as_ref().and_then(|b| open_library_book(b, &id.value)))
        }
        _ => Ok(None),
    }
}

fn match_query(id: &Identifier) -> Json {
    let mut q = json!({ "key": "id" });
    q[id.kind] = json!(id.value);
    q
}

/// Adds every identifier in `text` that the library does not have; one result per entry.
pub fn add_all(web: &WebSearch, library: &dyn Library, text: &str, collection: Option<&str>, find_pdf: bool) -> Vec<Json> {
    let mut seen: Vec<(String, String)> = Vec::new();
    let mut out = Vec::new();
    for pasted in read_identifiers(text) {
        let Some(id) = pasted.identifier else {
            out.push(json!({ "text": pasted.text, "status": "invalid", "message": "Not a DOI, ISBN, PMID, PMCID or arXiv ID" }));
            continue;
        };
        let base = json!({ "text": pasted.text, "kind": id.kind, "value": id.value });
        let with = |extra: Json| {
            let mut value = base.clone();
            if let (Some(v), Some(e)) = (value.as_object_mut(), extra.as_object()) {
                v.extend(e.clone());
            }
            value
        };
        if seen.iter().any(|(k, v)| k == id.kind && *v == id.value) {
            continue;
        }
        seen.push((id.kind.to_string(), id.value.clone()));
        let existing = library.match_works(&[match_query(&id)]).unwrap_or_default().into_iter().find(|h| h["certain"].as_bool() == Some(true));
        if let Some(hit) = existing {
            out.push(with(json!({ "status": "exists", "sourceId": hit["sourceId"], "title": hit["title"] })));
            continue;
        }
        let (work, extra) = match resolve(web, &id) {
            Ok(Some(found)) => found,
            Ok(None) => {
                out.push(with(json!({ "status": "notFound", "message": "No record of it was found" })));
                continue;
            }
            Err(message) => {
                out.push(with(json!({ "status": "failed", "message": message })));
                continue;
            }
        };
        // Found under another identifier the library has (an arXiv id whose DOI it knows).
        let asked = super::library::Asked::from(&work);
        if let Some(id) = super::library::existing(library, &[asked], true).get("work").and_then(Json::as_str) {
            let title = library.source(id).ok().and_then(|s| s["title"].as_str().map(String::from)).unwrap_or(work.title.clone());
            out.push(with(json!({ "status": "exists", "sourceId": id, "title": title })));
            continue;
        }
        let mut input = source_input(&work, collection);
        if let (Some(fields), Some(extra)) = (input.as_object_mut(), extra.as_object()) {
            for (k, v) in extra {
                if !v.is_null() {
                    fields.insert(k.clone(), v.clone());
                }
            }
            if id.kind == "pmcid" {
                fields.entry("pmcid").or_insert(json!(id.value));
            }
            if id.kind == "pmid" {
                fields.entry("pmid").or_insert(json!(id.value));
            }
            if fields.get("creators").is_none() && !work.authors.is_empty() {
                fields.insert("creators".into(), Json::Array(work.authors.iter().map(|a| creator_of(a)).collect()));
            }
        }
        match library.create(input) {
            Ok(source) => {
                let source_id = source["id"].as_str().unwrap_or("").to_string();
                let pdf = find_pdf && web.find_pdf(library, &source_id, None).is_ok_and(|f| f["status"] == "attached");
                out.push(with(json!({ "status": "added", "sourceId": source_id, "title": work.title, "pdf": pdf })));
            }
            Err(message) => out.push(with(json!({ "status": "failed", "message": message }))),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::tests::{Recorded, fixture};
    use std::sync::Mutex;

    const ARXIV: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title type="html">ArXiv Query: id_list=1706.03762</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need</title>
    <summary>  The dominant sequence transduction models &amp; more.  </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:comment>15 pages</arxiv:comment>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
  </entry>
</feed>"#;

    const OPEN_LIBRARY: &str = r#"{"ISBN:9780262033848": {"title": "Introduction to Algorithms", "subtitle": "Third edition",
        "authors": [{"name": "Thomas H. Cormen"}, {"name": "Charles E. Leiserson"}], "publish_date": "July 31, 2009",
        "publishers": [{"name": "MIT Press"}], "publish_places": [{"name": "Cambridge, Mass"}], "url": "https://openlibrary.org/books/OL1M/x"}}"#;

    const PUBMED: &str = r#"{"result": {"uids": ["33599681"], "33599681": {"title": "A trial of something.", "pubdate": "2021 Feb 18",
        "fulljournalname": "The New England journal of medicine", "authors": [{"name": "Smith J"}],
        "articleids": [{"idtype": "pubmed", "value": "33599681"}, {"idtype": "doi", "value": "10.1056/NEJMoa2034577"}, {"idtype": "pmc", "value": "PMC8190434"}]}}}"#;

    const CROSSREF: &str = r#"{"message": {"DOI": "10.5555/XYZ", "title": ["A Crossref-only paper"], "author": [{"given": "Ada", "family": "Lovelace"}],
        "issued": {"date-parts": [[1843, 1]]}, "container-title": ["Notes"], "type": "journal-article", "URL": "https://doi.org/10.5555/xyz"}}"#;

    #[test]
    fn reads_each_services_record() {
        let a = arxiv_work(ARXIV, "1706.03762").unwrap();
        assert_eq!((a.title.as_str(), a.year, a.authors.len()), ("Attention Is All You Need", Some(2017), 2));
        assert_eq!(a.abstract_.as_deref(), Some("The dominant sequence transduction models & more."));
        assert!(arxiv_work("<feed><entry><title>Error</title></entry></feed>", "x").is_none());
        let (book, extra) = open_library_book(&serde_json::from_str(OPEN_LIBRARY).unwrap(), "9780262033848").unwrap();
        assert_eq!((book.title.as_str(), book.year), ("Introduction to Algorithms: Third edition", Some(2009)));
        assert_eq!((extra["publisher"].as_str(), extra["place"].as_str()), (Some("MIT Press"), Some("Cambridge, Mass")));
        let p = pubmed_work(&serde_json::from_str(PUBMED).unwrap(), "33599681").unwrap();
        assert_eq!((p.title.as_str(), p.year, p.doi.as_deref(), p.ids.pmcid.as_deref()), ("A trial of something", Some(2021), Some("10.1056/nejmoa2034577"), Some("PMC8190434")));
        let c = crossref_work(&serde_json::from_str(CROSSREF).unwrap()).unwrap();
        assert_eq!((c.title.as_str(), c.year, c.authors[0].as_str(), c.venue.as_deref()), ("A Crossref-only paper", Some(1843), "Ada Lovelace", Some("Notes")));
    }

    struct Shelf(Mutex<Vec<Json>>);
    impl Library for Shelf {
        fn find(&self, _: &str) -> Vec<super::super::library::Stored> {
            Vec::new()
        }
        fn source(&self, id: &str) -> Result<Json, String> {
            self.0.lock().unwrap().iter().find(|s| s["id"] == id).cloned().ok_or("gone".into())
        }
        fn create(&self, input: Json) -> Result<Json, String> {
            let mut source = input;
            source["id"] = json!(format!("s{}", self.0.lock().unwrap().len() + 1));
            self.0.lock().unwrap().push(source.clone());
            Ok(source)
        }
        // The shelf matches by DOI and ISBN only.
        fn match_works(&self, queries: &[Json]) -> Option<Vec<Json>> {
            let shelf = self.0.lock().unwrap();
            Some(
                queries
                    .iter()
                    .filter_map(|q| {
                        let s = shelf.iter().find(|s| ["doi", "isbn"].iter().any(|k| q[*k].is_string() && q[*k].as_str().map(str::to_lowercase) == s[*k].as_str().map(str::to_lowercase)))?;
                        Some(json!({ "key": q["key"], "sourceId": s["id"], "title": s["title"], "certain": true }))
                    })
                    .collect(),
            )
        }
    }

    #[test]
    fn adds_a_pasted_list_and_says_what_became_of_each() {
        let bert = fixture("openalex-search.json")["results"][1].to_string();
        let (_calls, web) = Recorded::routed(move |url| match (url.host_str().unwrap_or(""), url.path()) {
            ("api.crossref.org", "/works/10.5555/xyz") => (200, CROSSREF.into()),
            ("api.crossref.org", _) => (404, "{}".into()),
            (_, "/works/doi:10.18653/v1/n19-1423") => (200, bert.clone()),
            (_, p) if p.starts_with("/works/") => (404, "{}".into()),
            ("export.arxiv.org", _) => (200, ARXIV.into()),
            ("openlibrary.org", _) => (200, OPEN_LIBRARY.into()),
            ("eutils.ncbi.nlm.nih.gov", _) => (200, PUBMED.into()),
            other => panic!("unexpected request {other:?}"),
        })
        .search();
        let shelf = Shelf(Mutex::new(vec![json!({ "id": "s0", "title": "Mine", "doi": "10.1234/mine" })]));
        let results = add_all(&web, &shelf, "10.18653/v1/N19-1423\n10.1234/mine, 10.5555/xyz\narXiv:1706.03762\nISBN 0-262-03384-4; PMID 33599681\n10.9999/nothing\nhello world\n10.1234/MINE", Some("c1"), false);
        let got: Vec<String> = results.iter().map(|r| format!("{} {}", r["status"].as_str().unwrap(), r["value"].as_str().or(r["text"].as_str()).unwrap())).collect();
        assert_eq!(
            got,
            [
                "added 10.18653/v1/n19-1423",
                "exists 10.1234/mine",
                "added 10.5555/xyz",
                "added 1706.03762",
                "added 9780262033848",
                "added 33599681",
                "notFound 10.9999/nothing",
                "invalid hello world",
            ]
        );
        let shelf = shelf.0.lock().unwrap();
        let book = shelf.iter().find(|s| s["isbn"] == "9780262033848").unwrap();
        assert_eq!((book["itemType"].as_str(), book["publisher"].as_str(), book["collections"][0].as_str()), (Some("book"), Some("MIT Press"), Some("c1")));
        let paper = shelf.iter().find(|s| s["pmid"] == "33599681").unwrap();
        assert_eq!(paper["doi"], "10.1056/nejmoa2034577");
        assert_eq!(shelf.iter().find(|s| s["arxivId"] == "1706.03762").unwrap()["itemType"], "preprint");
    }
}
