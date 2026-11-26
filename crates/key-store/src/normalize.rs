// One normalisation for everything that decides whether two records are the same work:
// the "in library" matcher (matching.rs), the duplicate engine (duplicates.rs), the
// bibliography importer's within-file index (key-biblio), web pages saved from the browser
// (`page_key`) and the metadata writers. Identifiers come out in one canonical form, links
// without tracking or proxy rewriting, titles and names folded.
use crate::graph::name_key;

pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A DOI however it is written: bare, lower-case, without `doi:` or a doi.org link. Text
/// that only mentions a DOI after other words ("see 10.1/x") is not one.
pub fn doi(text: &str) -> Option<String> {
    let lower = percent_decode(text.trim()).to_lowercase();
    let at = lower.find("10.")?;
    let head = lower[..at].trim_end();
    let allowed = head.is_empty() || head.ends_with("doi:") || head.ends_with("doi.org/") || head.ends_with("doi") || head.ends_with("doi.org/doi:");
    if !allowed {
        // A single token the scanner can still read ("https://dx.doi.org/10.1/x" variants, odd dashes).
        return (!text.trim().contains(char::is_whitespace)).then(|| crate::identify::normalize_doi(text)).flatten().filter(|d| head.contains("doi") && d.starts_with("10."));
    }
    let doi: String = lower[at..].split(|c: char| c.is_whitespace() || c == '#' || c == '?').next().unwrap_or("").to_string();
    let doi = doi.trim_end_matches(['.', ',', ';', ')', ']', '/']).to_string();
    (doi.contains('/') && doi.len() > doi.find('/').unwrap_or(0) + 1).then_some(doi)
}

/// A stored DOI field as compared by the metadata writers: the canonical DOI, or the text
/// lower-cased without a doi.org prefix when it is not a well-formed one.
pub fn doi_or_text(text: &str) -> String {
    doi(text).unwrap_or_else(|| {
        let lower = text.trim().to_ascii_lowercase();
        let rest = ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/"].iter().find_map(|p| lower.strip_prefix(p)).unwrap_or(&lower);
        rest.strip_prefix("doi:").map(str::trim_start).unwrap_or(rest).to_string()
    })
}

/// An arXiv id without "arXiv:", a link's path or a version: 2101.00001, hep-th/9901001.
pub fn arxiv(text: &str) -> Option<String> {
    let mut t = text.trim().to_lowercase();
    for prefix in ["https://", "http://", "www.", "arxiv.org/abs/", "arxiv.org/pdf/", "export.arxiv.org/abs/", "arxiv:", "10.48550/arxiv."] {
        if let Some(rest) = t.strip_prefix(prefix) {
            t = rest.trim_start().to_string();
        }
    }
    let t = t.trim().trim_end_matches(".pdf").trim_end_matches('/');
    let t = match t.rfind('v') {
        Some(at) if at > 0 && t[at + 1..].chars().all(|c| c.is_ascii_digit()) && !t[at + 1..].is_empty() && t[..at].chars().last().is_some_and(|c| c.is_ascii_digit()) => &t[..at],
        _ => t,
    };
    let valid = t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '/' | '-')) && t.chars().filter(char::is_ascii_digit).count() >= 7;
    (valid && !t.is_empty()).then(|| t.to_string())
}

/// A PubMed id: its digits without leading zeros (a link's or label's text around them dropped).
pub fn pmid(text: &str) -> Option<String> {
    let digits: String = text.trim().trim_start_matches(|c: char| !c.is_ascii_digit()).chars().take_while(char::is_ascii_digit).collect();
    let digits = digits.trim_start_matches('0').to_string();
    (!digits.is_empty() && digits.len() <= 9).then_some(digits)
}

pub fn pmcid(text: &str) -> Option<String> {
    let lower = text.trim().to_ascii_lowercase();
    let rest = lower.rsplit('/').find(|s| !s.is_empty()).unwrap_or("");
    let digits: String = rest.trim_start_matches("pmc").chars().take_while(char::is_ascii_digit).collect();
    let digits = digits.trim_start_matches('0');
    (!digits.is_empty()).then(|| format!("PMC{digits}"))
}

pub fn openalex(text: &str) -> Option<String> {
    let t = text.trim().trim_end_matches('/');
    let id = t.rsplit('/').next().unwrap_or(t).to_uppercase();
    (id.starts_with('W') && id.len() > 1 && id[1..].chars().all(|c| c.is_ascii_digit())).then_some(id)
}

/// An ISBN as ISBN-13 digits (an ISBN-10 is converted), when its checksum holds.
pub fn isbn(text: &str) -> Option<String> {
    let chars: String = text.chars().filter(|c| c.is_ascii_digit() || *c == 'X' || *c == 'x').map(|c| c.to_ascii_uppercase()).collect();
    let valid13 = |d: &str| d.len() == 13 && d.chars().all(|c| c.is_ascii_digit()) && d.chars().enumerate().map(|(i, c)| c.to_digit(10).unwrap_or(0) * if i % 2 == 1 { 3 } else { 1 }).sum::<u32>() % 10 == 0;
    if valid13(&chars) {
        return Some(chars);
    }
    if chars.len() == 10 {
        let d: Vec<char> = chars.chars().collect();
        if !d[..9].iter().all(char::is_ascii_digit) {
            return None;
        }
        let sum: u32 = d.iter().enumerate().map(|(i, &c)| (if c == 'X' { 10 } else { c.to_digit(10).unwrap_or(99) }) * (10 - i as u32)).sum();
        if sum % 11 != 0 {
            return None;
        }
        let body = format!("978{}", &chars[..9]);
        let check: u32 = body.chars().enumerate().map(|(i, c)| c.to_digit(10).unwrap_or(0) * if i % 2 == 1 { 3 } else { 1 }).sum();
        return Some(format!("{body}{}", (10 - check % 10) % 10));
    }
    None
}

/// The ISBNs in a field that may hold several ("978-0-262-03384-8, 0262033844"), as ISBN-13.
/// A malformed one whose digits still look like an ISBN is kept converted, without its
/// checksum, so two records with the same typo still meet.
pub fn isbns(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |v: String| {
        if !out.contains(&v) {
            out.push(v);
        }
    };
    if let Some(one) = isbn(text) {
        push(one);
    }
    for part in text.split([',', ';', ' ', '/']) {
        let digits: String = part.chars().filter(|c| c.is_ascii_digit() || *c == 'X' || *c == 'x').collect::<String>().to_uppercase();
        if let Some(valid) = isbn(&digits) {
            push(valid);
            continue;
        }
        match digits.len() {
            13 if digits.chars().all(|c| c.is_ascii_digit()) => push(digits),
            10 if digits[..9].chars().all(|c| c.is_ascii_digit()) => {
                let body = format!("978{}", &digits[..9]);
                let sum: u32 = body.chars().enumerate().map(|(i, c)| c.to_digit(10).unwrap_or(0) * if i % 2 == 0 { 1 } else { 3 }).sum();
                push(format!("{body}{}", (10 - sum % 10) % 10));
            }
            _ => {}
        }
    }
    out
}

/// Query parameters that only say where a click came from.
pub fn tracking(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with("utm_")
        || n.starts_with("_hs")
        || matches!(
            n.as_str(),
            "fbclid" | "gclid" | "dclid" | "msclkid" | "mc_cid" | "mc_eid" | "ref" | "ref_src" | "referrer" | "src" | "source" | "via" | "igshid" | "si" | "spm" | "cmpid" | "campaign" | "sessionid" | "jsessionid" | "sid" | "casa_token" | "__cf_chl_tk" | "__cf_chl_rt_tk" | "s_kwcid" | "ito" | "trk"
        )
}

/// What a link stands for: a DOI, arXiv id or PubMed id when it is one, else the address
/// without scheme, `www.`, fragment, tracking parameters or trailing slash, with a library
/// proxy's rewriting undone (EZproxy's `www-nature-com.ezproxy.uni.edu` and
/// `…/login?url=https://…`).
#[derive(Clone, Debug, PartialEq)]
pub enum LinkKey {
    Doi(String),
    Arxiv(String),
    Pmid(String),
    Url(String),
}

impl LinkKey {
    /// One string per work: `doi:…`, `arxiv:…`, `pmid:…` or the normalised address.
    pub fn text(&self) -> String {
        match self {
            LinkKey::Doi(d) => format!("doi:{d}"),
            LinkKey::Arxiv(a) => format!("arxiv:{a}"),
            LinkKey::Pmid(p) => format!("pmid:{p}"),
            LinkKey::Url(u) => u.clone(),
        }
    }
}

pub fn link_key(text: &str) -> Option<LinkKey> {
    let raw = text.trim();
    let (scheme_less, had_scheme) = match raw.find("://") {
        Some(at) if raw[..at].chars().all(|c| c.is_ascii_alphabetic()) => (&raw[at + 3..], true),
        _ => (raw, false),
    };
    if !had_scheme && !scheme_less.contains('.') {
        return None;
    }
    let (rest, _fragment) = scheme_less.split_once('#').unwrap_or((scheme_less, ""));
    let (host_path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (host, path) = host_path.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((host_path, String::new()));
    let host = host.rsplit('@').next().unwrap_or(host).to_lowercase();
    let host = host.split(':').next().unwrap_or(&host).to_string();
    let pairs: Vec<(String, String)> = query.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())).unwrap_or((p.to_string(), String::new()))).collect();
    // EZproxy's login link carries the address it opens.
    if host.contains("proxy") || path.ends_with("/login") {
        if let Some((_, target)) = pairs.iter().find(|(k, _)| matches!(k.to_ascii_lowercase().as_str(), "url" | "qurl")) {
            let target = percent_decode(target);
            if target.contains("://") && target != raw {
                return link_key(&target);
            }
        }
    }
    // A host rewritten by a proxy: the labels before the proxy's, hyphens back to dots.
    let labels: Vec<&str> = host.split('.').collect();
    let host = match labels.iter().position(|l| l.contains("ezproxy") || *l == "proxy" || l.starts_with("proxy-") || l.ends_with("-proxy")) {
        Some(at) if at > 0 && labels[..at].iter().any(|l| l.contains('-')) => labels[..at].join(".").replace("--", "\u{0}").replace('-', ".").replace('\u{0}', "-"),
        _ => host,
    };
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    let path = percent_decode(&path);
    if host == "doi.org" || host == "dx.doi.org" {
        return doi(path.trim_start_matches('/')).map(LinkKey::Doi);
    }
    if host == "arxiv.org" || host == "export.arxiv.org" {
        if let Some(id) = path.strip_prefix("/abs/").or_else(|| path.strip_prefix("/pdf/")).and_then(arxiv) {
            return Some(LinkKey::Arxiv(id));
        }
    }
    if host == "pubmed.ncbi.nlm.nih.gov" {
        let id = path.trim_matches('/');
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
            if let Some(id) = pmid(id) {
                return Some(LinkKey::Pmid(id));
            }
        }
    }
    let path = path.split(';').next().unwrap_or("").trim_end_matches('/').to_string();
    let mut kept: Vec<String> = pairs.into_iter().filter(|(k, _)| !tracking(k)).map(|(k, v)| if v.is_empty() { k } else { format!("{k}={v}") }).collect();
    kept.sort();
    let query = if kept.is_empty() { String::new() } else { format!("?{}", kept.join("&")) };
    (!host.is_empty()).then(|| LinkKey::Url(format!("{host}{path}{query}")))
}

/// A web page's identity for saving and "already saved": the link's key as text
/// (`doi:…` for a DOI landing page), or the trimmed text when it is not a link.
pub fn page_key(url: &str) -> String {
    link_key(url).map(|k| k.text()).unwrap_or_else(|| url.trim().to_string())
}

/// A title as matched: markup dropped, case, diacritics and punctuation folded.
pub fn title_key(title: &str) -> String {
    let mut plain = String::with_capacity(title.len());
    let mut in_tag = false;
    for c in title.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => plain.push(c),
            _ => {}
        }
    }
    name_key(&plain)
}

/// A title key with the spaces taken out too ("Deep-learning" and "Deep learning" meet).
pub fn compact_title_key(title: &str) -> String {
    title_key(title).replace(' ', "")
}

/// The family name in "Family, Given" or "Given Family", folded.
pub fn family_key(name: &str) -> String {
    let name = name.trim();
    let family = match name.split_once(',') {
        Some((family, _)) => family,
        None => name.split_whitespace().last().unwrap_or(""),
    };
    name_key(family)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_form_per_identifier() {
        assert_eq!(doi("https://doi.org/10.1038/S41591-021-01384-9.").as_deref(), Some("10.1038/s41591-021-01384-9"));
        assert_eq!(doi("doi: 10.1000%2Fxyz").as_deref(), Some("10.1000/xyz"));
        assert_eq!(doi("https://dx.doi.org/10.1/ABC").as_deref(), Some("10.1/abc"));
        assert_eq!(doi("see 10.1/x"), None);
        assert_eq!(doi_or_text("https://doi.org/not-a-doi"), "not-a-doi");
        assert_eq!(arxiv("arXiv: 1706.03762v7").as_deref(), Some("1706.03762"));
        assert_eq!(arxiv("10.48550/arXiv.2101.00001").as_deref(), Some("2101.00001"));
        assert_eq!(pmid("PMID: 0033599681").as_deref(), Some("33599681"));
        assert_eq!(pmcid("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8190434/").as_deref(), Some("PMC8190434"));
        assert_eq!(isbns("978-0-262-03384-8; 0262033844"), vec!["9780262033848"]);
        assert_eq!(isbn("9780262033849"), None);
        assert_eq!(title_key("<i>Attention</i> is all you need."), "attention is all you need");
        assert_eq!(family_key("Vaswani, Ashish"), "vaswani");
        assert_eq!(family_key("Ashish Vaswani"), "vaswani");
        assert_eq!(page_key("https://www.example.org/post/?utm_campaign=z#top"), "example.org/post");
        assert_eq!(page_key("https://doi.org/10.1/ABC"), "doi:10.1/abc");
    }
}
