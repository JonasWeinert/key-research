// Find PDF for a library source without a file: a chain of places an open-access copy may
// be, tried in order (the source's stored OpenAlex open-access link, OpenAlex's record of its
// DOI, Unpaywall by DOI when the user gave a contact email, arXiv and PubMed Central by id).
// Each answer must be a PDF (its type, then its first bytes, `%PDF`); the first one is
// attached to the source and indexed. When none is, the answer is the landing page for the
// in-app browser, where a login or a captcha can be dealt with and the PDF captured.
use super::http::{self, Base, SendError};
use super::{Library, WebSearch, types::bare_doi};
use key_safe_http::CancellationToken;
use serde::Serialize;
use serde_json::{Value as Json, json};
use std::path::PathBuf;

pub fn unpaywall_base() -> Base {
    Base::from_env("KEY_WEB_UNPAYWALL_URL", "https://api.unpaywall.org")
}

/// A test's mock may serve PDFs from a loopback address (only while a provider is mocked).
fn loopback_allowed() -> bool {
    ["KEY_WEB_OPENALEX_URL", "KEY_WEB_UNPAYWALL_URL"].iter().any(|v| std::env::var(v).is_ok_and(|v| !v.trim().is_empty()))
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Candidate {
    pub url: String,
    /// openalex | unpaywall | arxiv | pmc | source
    pub via: &'static str,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Tried {
    pub url: String,
    pub via: &'static str,
    pub reason: String,
}

fn field<'a>(source: &'a Json, name: &str) -> Option<&'a str> {
    source.get(name).and_then(Json::as_str).map(str::trim).filter(|v| !v.is_empty())
}

fn web_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// Unpaywall's PDF links for a DOI: the best location's first, then the others'.
pub fn unpaywall_pdfs(body: &Json) -> (Vec<String>, Option<String>) {
    let mut pdfs = Vec::new();
    let best = body.get("best_oa_location");
    let locations = body.get("oa_locations").and_then(Json::as_array).cloned().unwrap_or_default();
    for location in best.into_iter().chain(locations.iter()) {
        if let Some(url) = location.get("url_for_pdf").and_then(Json::as_str).filter(|u| web_url(u)) {
            if !pdfs.iter().any(|p| p == url) {
                pdfs.push(url.to_string());
            }
        }
    }
    let landing = best.and_then(|b| b.get("url_for_landing_page")).and_then(Json::as_str).filter(|u| web_url(u)).map(String::from);
    (pdfs, landing)
}

impl WebSearch {
    /// The places to try for this source, best first, and the page to open when none works.
    pub fn pdf_candidates(&self, source: &Json, email: Option<&str>) -> (Vec<Candidate>, Option<String>) {
        let mut out: Vec<Candidate> = Vec::new();
        let mut push = |url: String, via: &'static str| {
            if web_url(&url) && !out.iter().any(|c| c.url == url) {
                out.push(Candidate { url, via });
            }
        };
        let doi = bare_doi(field(source, "doi")).filter(|d| d.starts_with("10."));
        let mut landing = None;
        if let Some(url) = field(source, "oaUrl") {
            push(url.to_string(), "openalex");
        }
        // OpenAlex's record of the DOI, for a reference added before its lookup (or without one).
        if field(source, "oaUrl").is_none() {
            let id = doi.clone().or_else(|| field(source, "openalexId").map(String::from));
            if let Some(Ok(Some(work))) = id.map(|id| self.lookup("openalex", &id)) {
                if let Some(url) = work.pdf_url.clone() {
                    push(url, "openalex");
                }
                landing = work.landing_url.clone().filter(|u| !u.ends_with(".pdf"));
            }
        }
        if let (Some(doi), Some(email)) = (doi.as_deref(), email.filter(|e| e.contains('@'))) {
            let base = unpaywall_base();
            if let Ok(url) = base.url(&format!("v2/{doi}"), &[("email", email)]) {
                if let Ok((body, _)) = http::json_of((self.transport)(&base, &url, &[], &CancellationToken::active()), "Unpaywall") {
                    let (pdfs, page) = unpaywall_pdfs(&body);
                    for pdf in pdfs {
                        push(pdf, "unpaywall");
                    }
                    landing = landing.or(page);
                }
            }
        }
        let arxiv = field(source, "arxivId")
            .map(String::from)
            .or_else(|| doi.as_deref().and_then(|d| d.strip_prefix("10.48550/arxiv.")).map(String::from));
        if let Some(id) = arxiv {
            push(format!("https://arxiv.org/pdf/{id}"), "arxiv");
        }
        if let Some(pmcid) = field(source, "pmcid") {
            let digits: String = pmcid.chars().filter(char::is_ascii_digit).collect();
            if !digits.is_empty() {
                push(format!("https://europepmc.org/backend/ptpmcrender.fcgi?accid=PMC{digits}&blobtype=pdf"), "pmc");
            }
        }
        // A reference whose own link is a PDF.
        if let Some(url) = field(source, "url").filter(|u| u.to_ascii_lowercase().ends_with(".pdf")) {
            push(url.to_string(), "source");
        }
        let own = field(source, "url").filter(|u| web_url(u) && !u.to_ascii_lowercase().ends_with(".pdf")).map(String::from);
        let landing = own.or_else(|| doi.as_ref().map(|d| format!("https://doi.org/{d}"))).or(landing);
        (out, landing)
    }

    /// One PDF, checked: its bytes when it is one, else why not (in words for the user).
    pub fn fetch_pdf(&self, url: &str) -> Result<Vec<u8>, String> {
        let parsed = url::Url::parse(url).map_err(|_| "Not a web address".to_string())?;
        let base = Base { url: url.to_string(), overridden: loopback_allowed() };
        let response = match (self.transport)(&base, &parsed, &[("accept", "application/pdf,application/octet-stream;q=0.8")], &CancellationToken::active()) {
            Ok(response) => response,
            Err(SendError::Timeout) => return Err("It took too long to answer".into()),
            Err(SendError::Cancelled) => return Err("Cancelled".into()),
            Err(SendError::Failed(message)) if message.contains("content type") || message.contains("media type") || message.contains("text/html") => {
                return Err("It answered with a web page, not a PDF".into());
            }
            Err(SendError::Failed(message)) => return Err(message),
        };
        if !(200..300).contains(&response.status) {
            return Err(match response.status {
                401 | 403 => "It needs a login or blocked the download".into(),
                404 | 410 => "It has no PDF there".into(),
                status => format!("It answered HTTP {status}"),
            });
        }
        let kind = response.header("content-type").unwrap_or("").to_ascii_lowercase();
        if kind.contains("html") {
            return Err("It answered with a web page, not a PDF".into());
        }
        let head = &response.body[..response.body.len().min(1024)];
        if !head.windows(5).any(|w| w == b"%PDF-") {
            return Err("What it sent is not a PDF".into());
        }
        Ok(response.body)
    }

    /// Finds a PDF for the source and attaches it; else says where a person could get one.
    pub fn find_pdf(&self, library: &dyn Library, id: &str, email: Option<&str>) -> Result<Json, String> {
        let source = library.source(id)?;
        if source.is_null() {
            return Err("Source not found".into());
        }
        if field(&source, "filePath").is_some() {
            return Ok(json!({ "status": "hasFile", "source": source }));
        }
        let email = email.map(String::from).or_else(|| self.options().mailto);
        let (candidates, landing) = self.pdf_candidates(&source, email.as_deref());
        let mut tried = Vec::new();
        for candidate in candidates {
            match self.fetch_pdf(&candidate.url) {
                Ok(bytes) => {
                    let path = temp_pdf(&bytes)?;
                    let attached = library.attach(id, &path);
                    if let Some(directory) = path.parent() {
                        let _ = std::fs::remove_dir_all(directory);
                    }
                    let source = attached?;
                    return Ok(json!({ "status": "attached", "via": candidate.via, "url": candidate.url, "source": source, "tried": tried }));
                }
                Err(reason) => tried.push(Tried { url: candidate.url, via: candidate.via, reason }),
            }
        }
        Ok(match landing {
            Some(url) => json!({ "status": "browser", "url": url, "tried": tried }),
            None => json!({ "status": "notFound", "tried": tried }),
        })
    }
}

/// A downloaded PDF in the system's temporary folder (the library copies it into the workspace).
fn temp_pdf(bytes: &[u8]) -> Result<PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let directory = std::env::temp_dir().join(format!("key-find-pdf-{}-{stamp}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join("Found paper.pdf");
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::web_search::tests::{Recorded, fixture};
    use std::sync::Mutex;

    struct One(Mutex<Json>, Mutex<Vec<Vec<u8>>>);
    impl Library for One {
        fn find(&self, _: &str) -> Vec<crate::backend::web_search::library::Stored> {
            Vec::new()
        }
        fn source(&self, _: &str) -> Result<Json, String> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn create(&self, input: Json) -> Result<Json, String> {
            Ok(input)
        }
        fn attach(&self, _: &str, path: &std::path::Path) -> Result<Json, String> {
            self.1.lock().unwrap().push(std::fs::read(path).unwrap());
            let mut source = self.0.lock().unwrap();
            source["filePath"] = json!("/library/files/x.pdf");
            Ok(source.clone())
        }
    }

    const PDF: &str = "%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF";

    #[test]
    fn reads_unpaywall_locations() {
        let body = json!({
            "best_oa_location": { "url_for_pdf": "https://repo.example/a.pdf", "url_for_landing_page": "https://repo.example/a" },
            "oa_locations": [{ "url_for_pdf": "https://repo.example/a.pdf" }, { "url_for_pdf": null }, { "url_for_pdf": "https://other.example/b.pdf" }]
        });
        assert_eq!(unpaywall_pdfs(&body), (vec!["https://repo.example/a.pdf".to_string(), "https://other.example/b.pdf".to_string()], Some("https://repo.example/a".into())));
    }

    #[test]
    fn tries_each_place_in_turn_and_attaches_the_first_real_pdf() {
        let work = fixture("openalex-search.json")["results"][1].clone();
        let (calls, web) = Recorded::routed(move |url| match (url.host_str().unwrap_or(""), url.path()) {
            (_, p) if p.starts_with("/works/") => (200, work.to_string()),
            ("api.unpaywall.org", _) => (200, json!({ "best_oa_location": { "url_for_pdf": "https://repo.example/bert.pdf" } }).to_string()),
            // OpenAlex's link answers a web page; Unpaywall's is the PDF.
            ("aclanthology.org", _) => (200, "<html>Sign in</html>".into()),
            ("repo.example", _) => (200, PDF.into()),
            other => panic!("unexpected request {other:?}"),
        })
        .search();
        web.set_options(&json!({ "mailto": "me@example.org" }));
        let library = One(Mutex::new(json!({ "id": "s1", "title": "BERT", "doi": "10.18653/v1/n19-1423" })), Mutex::default());
        let found = web.find_pdf(&library, "s1", None).unwrap();
        assert_eq!(found["status"], "attached");
        assert_eq!((found["via"].as_str(), found["url"].as_str()), (Some("unpaywall"), Some("https://repo.example/bert.pdf")));
        assert_eq!(found["tried"][0]["reason"], "What it sent is not a PDF");
        assert_eq!(library.1.lock().unwrap()[0], PDF.as_bytes());
        let urls: Vec<String> = calls.lock().unwrap().urls.iter().map(|u| u.to_string()).collect();
        assert!(urls.iter().any(|u| u.starts_with("https://api.unpaywall.org/v2/10.18653/v1/n19-1423?email=me%40example.org")), "{urls:?}");
        // A source with its file already is left alone.
        assert_eq!(web.find_pdf(&library, "s1", None).unwrap()["status"], "hasFile");
    }

    #[test]
    fn skips_unpaywall_without_an_email_and_falls_back_to_the_landing_page() {
        let (calls, web) = Recorded::routed(|url| match url.path() {
            p if p.starts_with("/works/") => (404, "{}".into()),
            p if p.starts_with("/pdf/") => (403, "Forbidden".into()),
            _ => (500, "".into()),
        })
        .search();
        let library = One(Mutex::new(json!({ "id": "s2", "title": "A preprint", "doi": "10.1/x", "arxivId": "2101.00001" })), Mutex::default());
        let found = web.find_pdf(&library, "s2", None).unwrap();
        assert_eq!(found["status"], "browser");
        assert_eq!(found["url"], "https://doi.org/10.1/x");
        assert_eq!(found["tried"][0], json!({ "url": "https://arxiv.org/pdf/2101.00001", "via": "arxiv", "reason": "It needs a login or blocked the download" }));
        assert!(!calls.lock().unwrap().urls.iter().any(|u| u.host_str() == Some("api.unpaywall.org")));
        let nothing = One(Mutex::new(json!({ "id": "s3", "title": "Notes" })), Mutex::default());
        assert_eq!(web.find_pdf(&nothing, "s3", None).unwrap()["status"], "notFound");
    }

    #[test]
    fn asks_europe_pmc_for_a_pubmed_central_copy() {
        let web = WebSearch::default();
        let (candidates, _) = web.pdf_candidates(&json!({ "pmcid": "PMC8190434", "oaUrl": "https://x.example/a.pdf" }), None);
        assert_eq!(candidates.iter().map(|c| c.via).collect::<Vec<_>>(), ["openalex", "pmc"]);
        assert!(candidates[1].url.contains("accid=PMC8190434"));
    }
}
