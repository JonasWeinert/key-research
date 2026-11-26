// Reading feeds: RSS 2.0, RSS 1.0 (RDF, as arXiv and many journal tables of contents send
// it) and Atom, into works shaped like web search results; the feed links a web page names
// (feed discovery); and OPML outlines, both ways. Feeds in the wild are sloppy, so the XML is
// read leniently into a small tree (mismatched end tags and stray ampersands are tolerated)
// and whatever parses before an error is kept.
use quick_xml::{Reader, events::Event};
use serde_json::{Map, Value as Json, json};
use url::Url;

#[derive(Clone, Debug, Default)]
pub struct Node {
    /// The qualified name, lower case ("dc:creator").
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
    pub text: String,
}

impl Node {
    fn local(&self) -> &str {
        self.name.rsplit(':').next().unwrap_or(&self.name)
    }
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k.eq_ignore_ascii_case(name) || k.rsplit(':').next().is_some_and(|l| l.eq_ignore_ascii_case(name))).map(|(_, v)| v.as_str())
    }
    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.is(name))
    }
    fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |c| c.is(name))
    }
    /// `name` is "local" (any prefix) or "prefix:local".
    fn is(&self, name: &str) -> bool {
        if name.contains(':') { self.name == name } else { self.local() == name }
    }
    /// All text inside, markup and all.
    fn content(&self) -> String {
        let mut out = self.text.clone();
        for c in &self.children {
            out.push_str(&c.content());
        }
        out
    }
    fn text_of(&self, names: &[&str]) -> Option<String> {
        names.iter().find_map(|n| self.child(n).map(|c| c.content().trim().to_string()).filter(|t| !t.is_empty()))
    }
}

fn entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "ndash" => "–",
        "mdash" => "—",
        "hellip" => "…",
        "rsquo" => "’",
        "lsquo" => "‘",
        "rdquo" => "”",
        "ldquo" => "“",
        _ => return None,
    })
}

/// The XML as a tree (its root), or none when nothing parses.
pub fn tree(text: &str) -> Option<Node> {
    let mut reader = Reader::from_str(text);
    let config = reader.config_mut();
    config.check_end_names = false;
    config.allow_dangling_amp = true;
    config.trim_text(false);
    let mut stack: Vec<Node> = vec![Node { name: "#document".into(), ..Default::default() }];
    let open = |e: &quick_xml::events::BytesStart| Node {
        name: String::from_utf8_lossy(e.name().as_ref()).to_lowercase(),
        attrs: e
            .html_attributes()
            .filter_map(Result::ok)
            .map(|a| (String::from_utf8_lossy(a.key.as_ref()).to_lowercase(), a.unescape_value().map(|v| v.into_owned()).unwrap_or_else(|_| String::from_utf8_lossy(&a.value).into_owned())))
            .collect(),
        ..Default::default()
    };
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                if stack.len() > 200 {
                    break;
                }
                stack.push(open(&e));
            }
            Ok(Event::Empty(e)) => {
                let node = open(&e);
                if let Some(top) = stack.last_mut() {
                    top.children.push(node);
                }
            }
            // An end tag closes the nearest open element of its name, and any left open inside
            // it (`<title>One</item>`); a stray one is ignored.
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                if let Some(at) = stack.iter().rposition(|n| n.name == name).filter(|at| *at > 0) {
                    while stack.len() > at {
                        let node = stack.pop().unwrap();
                        stack.last_mut().unwrap().children.push(node);
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if let (Some(top), Ok(text)) = (stack.last_mut(), t.decode()) {
                    top.text.push_str(&text);
                }
            }
            Ok(Event::CData(t)) => {
                if let (Some(top), Ok(text)) = (stack.last_mut(), t.decode()) {
                    top.text.push_str(&text);
                }
            }
            Ok(Event::GeneralRef(r)) => {
                let resolved = match r.resolve_char_ref() {
                    Ok(Some(c)) => c.to_string(),
                    _ => {
                        let name = String::from_utf8_lossy(&r).to_string();
                        entity(&name).map(String::from).unwrap_or_else(|| format!("&{name};"))
                    }
                };
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&resolved);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            Ok(_) => {}
        }
    }
    while stack.len() > 1 {
        let node = stack.pop().unwrap();
        stack.last_mut().unwrap().children.push(node);
    }
    let document = stack.pop()?;
    document.children.into_iter().find(|c| !c.name.starts_with('#'))
}

/// Text from HTML: tags dropped, entities decoded, white space collapsed.
pub fn plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut chars = html.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '<' => {
                let mut tag = String::new();
                for t in chars.by_ref() {
                    if t == '>' {
                        break;
                    }
                    tag.push(t);
                }
                let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("").to_lowercase();
                if matches!(name.as_str(), "p" | "br" | "div" | "li" | "h1" | "h2" | "h3" | "h4" | "tr") {
                    out.push(' ');
                }
            }
            '&' => {
                let mut name = String::new();
                while let Some(&n) = chars.peek() {
                    if n == ';' || name.len() > 10 || n.is_whitespace() {
                        break;
                    }
                    name.push(n);
                    chars.next();
                }
                if chars.peek() == Some(&';') {
                    chars.next();
                    let decoded = if let Some(num) = name.strip_prefix('#') {
                        let code = num.strip_prefix(['x', 'X']).map(|h| u32::from_str_radix(h, 16).ok()).unwrap_or_else(|| num.parse().ok());
                        code.and_then(char::from_u32).map(String::from)
                    } else {
                        entity(&name).map(String::from)
                    };
                    out.push_str(&decoded.unwrap_or_else(|| format!("&{name};")));
                } else {
                    out.push('&');
                    out.push_str(&name);
                }
            }
            c => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// A date as YYYY-MM-DD: ISO 8601 ("2025-06-10T04:00:00Z"), RFC 822 ("Tue, 10 Jun 2025 …")
/// or a bare year.
pub fn date(text: &str) -> Option<String> {
    let t = text.trim();
    let b = t.as_bytes();
    if b.len() >= 10 && b[4] == b'-' && b[7] == b'-' && t[..4].parse::<u32>().is_ok() {
        return Some(t[..10].to_string());
    }
    if b.len() >= 7 && b[4] == b'-' && t[..4].parse::<u32>().is_ok() && t[5..7].parse::<u32>().is_ok() {
        return Some(format!("{}-01", &t[..7]));
    }
    let words: Vec<&str> = t.split(|c: char| c.is_whitespace() || c == ',').filter(|w| !w.is_empty()).collect();
    let month = words.iter().position(|w| MONTHS.iter().any(|m| w.to_lowercase().starts_with(m)));
    let year = words.iter().find_map(|w| w.parse::<u32>().ok().filter(|y| (1000..3000).contains(y)));
    match (month, year) {
        (Some(at), Some(year)) => {
            let m = MONTHS.iter().position(|m| words[at].to_lowercase().starts_with(m))? + 1;
            let day = words.iter().find_map(|w| w.parse::<u32>().ok().filter(|d| (1..=31).contains(d))).unwrap_or(1);
            Some(format!("{year:04}-{m:02}-{day:02}"))
        }
        (None, Some(year)) if words.len() == 1 => Some(format!("{year:04}-01-01")),
        _ => None,
    }
}

/// The first DOI in a text (a link, an identifier, a description).
pub fn find_doi(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find("10.").map(|i| i + from) {
        let rest = &lower[at..];
        let slash = rest.find('/')?;
        let prefix = &rest[3..slash];
        if (4..=9).contains(&prefix.len()) && prefix.chars().all(|c| c.is_ascii_digit() || c == '.') {
            let end = rest.find(|c: char| c.is_whitespace() || matches!(c, '"' | '<' | '>' | '\'' | '?' | '#' | '&')).unwrap_or(rest.len());
            let doi = rest[..end].trim_end_matches(['.', ',', ';', ')', ']', '/']);
            if doi.len() > slash + 1 {
                return Some(doi.to_string());
            }
        }
        from = at + 3;
    }
    None
}

fn arxiv_of(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    for marker in ["arxiv.org/abs/", "arxiv.org/pdf/", "oai:arxiv.org:", "arxiv:"] {
        if let Some(at) = lower.find(marker) {
            let id: String = lower[at + marker.len()..].chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '/' | '-')).collect();
            let id = id.trim_end_matches(".pdf").trim_end_matches('/');
            let id = match id.rfind('v') {
                Some(v) if v > 0 && id[v + 1..].chars().all(|c| c.is_ascii_digit()) && !id[v + 1..].is_empty() => &id[..v],
                _ => id,
            };
            if id.chars().any(|c| c.is_ascii_digit()) {
                return Some(id.to_string());
            }
        }
    }
    None
}

/// "Ada Lovelace, Charles Babbage" (arXiv's dc:creator) as two names; "Lovelace, Ada" stays one.
fn names(text: &str) -> Vec<String> {
    let text = plain(text);
    let text = text.trim();
    if text.is_empty() {
        return vec![];
    }
    let parts: Vec<&str> = text.split([',', ';']).map(str::trim).filter(|p| !p.is_empty()).collect();
    let split = parts.len() > 1 && parts.iter().all(|p| p.contains(' ')) || text.contains(';');
    let mut out: Vec<String> = if split { parts.iter().map(|p| p.to_string()).collect() } else { vec![text.to_string()] };
    // "and Grace Hopper" at the end of a list.
    for name in out.iter_mut() {
        if let Some(rest) = name.strip_prefix("and ") {
            *name = rest.to_string();
        }
    }
    out.retain(|n| !n.is_empty());
    out
}

/// RSS's author is often "mail@example.org (Ada Lovelace)".
fn rss_author(text: &str) -> String {
    let t = text.trim();
    match (t.find('('), t.rfind(')')) {
        (Some(a), Some(b)) if a < b && t[..a].contains('@') => t[a + 1..b].trim().to_string(),
        _ if t.contains('@') && !t.contains(' ') => String::new(),
        _ => t.to_string(),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Feed {
    pub title: Option<String>,
    pub link: Option<String>,
    /// Works shaped like web search results, with `published` (YYYY-MM-DD).
    pub items: Vec<Json>,
}

fn resolve(base: Option<&Url>, link: &str) -> String {
    match base.and_then(|b| b.join(link.trim()).ok()) {
        Some(url) => url.to_string(),
        None => link.trim().to_string(),
    }
}

/// A feed's works, or none when the text is not a feed (a web page, say).
pub fn feed(text: &str, base: Option<&Url>) -> Option<Feed> {
    let root = tree(text)?;
    let (channel, items): (Option<&Node>, Vec<&Node>) = match root.local() {
        "rss" => {
            let channel = root.child("channel")?;
            (Some(channel), channel.all("item").collect())
        }
        "rdf" => (root.child("channel"), root.all("item").chain(root.child("channel").into_iter().flat_map(|c| c.all("item"))).collect()),
        "feed" => (Some(&root), root.all("entry").collect()),
        _ => return None,
    };
    let feed_title = channel.and_then(|c| c.text_of(&["title"])).map(|t| plain(&t));
    let feed_link = channel.and_then(|c| atom_link(c).or_else(|| c.text_of(&["link"])));
    let venue_default = channel.and_then(|c| c.text_of(&["prism:publicationname", "dc:source"])).map(|t| plain(&t));
    let mut works = Vec::new();
    for item in items.into_iter().take(500) {
        let Some(title) = item.text_of(&["title"]).map(|t| plain(&t)).filter(|t| !t.is_empty()) else { continue };
        // arXiv's listing feeds append "(arXiv:2506.01234v2 [cs.LG] UPDATED)".
        let title = match title.find(" (arXiv:") {
            Some(at) if at > 0 => title[..at].trim_end_matches('.').trim().to_string(),
            _ => title,
        };
        let link = atom_link(item).or_else(|| item.text_of(&["link"])).or_else(|| item.attr("rdf:about").map(String::from)).map(|l| resolve(base, &l));
        let guid = item.text_of(&["guid", "id", "dc:identifier", "prism:doi", "prism:url"]).unwrap_or_default();
        let identifiers: Vec<String> = ["prism:doi", "dc:identifier", "guid", "id", "prism:url"].iter().filter_map(|n| item.text_of(&[n])).collect();
        let summary = item.text_of(&["content:encoded", "description", "summary", "content", "dc:description"]).map(|t| plain(&t)).filter(|t| !t.is_empty());
        let doi = identifiers.iter().chain(link.iter()).find_map(|t| find_doi(t)).or_else(|| summary.as_deref().and_then(find_doi));
        let arxiv = link.as_deref().and_then(arxiv_of).or_else(|| arxiv_of(&guid)).or_else(|| doi.as_deref().and_then(|d| d.strip_prefix("10.48550/arxiv.").map(String::from)));
        let mut authors: Vec<String> = item.all("author").map(|a| a.text_of(&["name"]).unwrap_or_else(|| rss_author(&a.content()))).flat_map(|n| names(&n)).collect();
        for creator in item.all("dc:creator").chain(item.all("dc:contributor")) {
            authors.extend(names(&creator.content()));
        }
        authors.retain(|a| !a.is_empty());
        authors.dedup();
        let published = item
            .text_of(&["prism:publicationdate", "prism:coverdate", "published", "pubdate", "dc:date", "issued", "updated"])
            .and_then(|d| date(&d));
        let venue = item.text_of(&["prism:publicationname", "dc:source"]).map(|t| plain(&t)).or_else(|| venue_default.clone()).or_else(|| feed_title.clone());
        let year = published.as_deref().and_then(|d| d[..4].parse::<i64>().ok());
        let mut ids = Map::new();
        if let Some(a) = &arxiv {
            ids.insert("arxiv".into(), json!(a));
        }
        let mut work = json!({
            "provider": "feed",
            "providerId": guid,
            "title": title,
            "authors": authors.into_iter().take(100).collect::<Vec<_>>(),
            "ids": ids,
        });
        let put = |work: &mut Json, key: &str, value: Option<Json>| {
            if let Some(v) = value {
                work[key] = v;
            }
        };
        put(&mut work, "year", year.map(Json::from));
        put(&mut work, "venue", venue.map(Json::from));
        put(&mut work, "abstract", summary.map(|s| json!(s.chars().take(4000).collect::<String>())));
        put(&mut work, "doi", doi.clone().map(Json::from));
        put(&mut work, "published", published.map(Json::from));
        let landing = doi.as_ref().filter(|_| link.is_none()).map(|d| format!("https://doi.org/{d}")).or(link);
        put(&mut work, "landingUrl", landing.map(Json::from));
        if let Some(a) = &arxiv {
            put(&mut work, "pdfUrl", Some(json!(format!("https://arxiv.org/pdf/{a}"))));
            put(&mut work, "type", Some(json!("preprint")));
        }
        works.push(work);
    }
    Some(Feed { title: feed_title, link: feed_link.map(|l| resolve(base, &l)), items: works })
}

fn atom_link(node: &Node) -> Option<String> {
    let links: Vec<&Node> = node.all("link").filter(|l| l.attr("href").is_some()).collect();
    links
        .iter()
        .find(|l| l.attr("rel").is_none_or(|r| r == "alternate"))
        .or(links.first())
        .and_then(|l| l.attr("href"))
        .map(String::from)
}

/// Feed links a web page names (`<link rel="alternate" type="application/rss+xml" href=…>`).
pub fn discover(html: &str, base: &Url) -> Vec<(String, Option<String>)> {
    let lower = html.to_lowercase();
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    let mut from = 0;
    while let Some(at) = lower[from..].find("<link").map(|i| i + from) {
        let end = lower[at..].find('>').map_or(lower.len(), |e| at + e);
        let attrs = attributes(&html[at + 5..end]);
        from = end;
        let get = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        let rel = get("rel").unwrap_or("").to_lowercase();
        let kind = get("type").unwrap_or("").to_lowercase();
        let feedy = kind.contains("rss") || kind.contains("atom") || kind.contains("rdf");
        if rel.split_whitespace().any(|r| r == "alternate") && feedy {
            if let Some(href) = get("href").and_then(|h| base.join(h.trim()).ok()) {
                let url = href.to_string();
                if !out.iter().any(|(u, _)| *u == url) {
                    out.push((url, get("title").map(|t| plain(t)).filter(|t| !t.is_empty())));
                }
            }
        }
    }
    out
}

/// `name="value" name='value' name=value` pairs of a tag, names lower case, entities decoded.
fn attributes(tag: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut chars = tag.char_indices().peekable();
    while let Some(&(i, c)) = chars.peek() {
        if c.is_whitespace() || c == '/' {
            chars.next();
            continue;
        }
        let start = i;
        while chars.peek().is_some_and(|&(_, c)| !c.is_whitespace() && c != '=' && c != '/') {
            chars.next();
        }
        let name = tag[start..chars.peek().map_or(tag.len(), |&(j, _)| j)].to_lowercase();
        while chars.peek().is_some_and(|&(_, c)| c.is_whitespace()) {
            chars.next();
        }
        let mut value = String::new();
        if chars.peek().is_some_and(|&(_, c)| c == '=') {
            chars.next();
            while chars.peek().is_some_and(|&(_, c)| c.is_whitespace()) {
                chars.next();
            }
            match chars.peek().map(|&(_, c)| c) {
                Some(q @ ('"' | '\'')) => {
                    chars.next();
                    for (_, c) in chars.by_ref() {
                        if c == q {
                            break;
                        }
                        value.push(c);
                    }
                }
                _ => {
                    while let Some(&(_, c)) = chars.peek().filter(|&&(_, c)| !c.is_whitespace()) {
                        value.push(c);
                        chars.next();
                    }
                }
            }
        }
        if !name.is_empty() {
            out.push((name, plain(&value)));
        }
    }
    out
}

/// One subscription as an OPML outline: a feed, or (with Key's own attributes) an alert.
#[derive(Clone, Debug, PartialEq)]
pub struct Outline {
    pub kind: String,
    pub title: String,
    pub config: Map<String, Json>,
    pub interval_minutes: Option<i64>,
}

/// The subscriptions in an OPML file: every outline with a feed address, and Key's alerts.
pub fn opml(text: &str) -> Vec<Outline> {
    let Some(root) = tree(text) else { return vec![] };
    let mut out = Vec::new();
    fn walk(node: &Node, out: &mut Vec<Outline>) {
        for child in node.all("outline") {
            let title = child.attr("title").or(child.attr("text")).unwrap_or("").trim().to_string();
            let interval = child.attr("key:interval").and_then(|v| v.parse().ok());
            if let (Some(kind), Some(config)) = (child.attr("key:kind"), child.attr("key:config").and_then(|c| serde_json::from_str::<Map<String, Json>>(c).ok())) {
                out.push(Outline { kind: kind.to_string(), title, config, interval_minutes: interval });
            } else if let Some(url) = child.attr("xmlurl").filter(|u| u.starts_with("http")) {
                let mut config = Map::new();
                config.insert("url".into(), json!(url.trim()));
                if let Some(site) = child.attr("htmlurl") {
                    config.insert("site".into(), json!(site));
                }
                out.push(Outline { kind: "rss".into(), title, config, interval_minutes: interval });
            }
            walk(child, out);
        }
    }
    if let Some(body) = root.child("body") {
        walk(body, &mut out);
    }
    out
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Subscriptions as OPML 2.0: feeds as ordinary outlines any reader takes, alerts with Key's
/// own attributes (other readers skip them).
pub fn to_opml(subscriptions: &[key_store::feeds::Subscription]) -> String {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\" xmlns:key=\"https://key.app/opml\">\n  <head>\n    <title>Key feeds and alerts</title>\n  </head>\n  <body>\n");
    for s in subscriptions {
        let title = escape(&s.title);
        let interval = s.interval_minutes;
        if s.kind == "rss" {
            let url = escape(s.config.get("url").and_then(Json::as_str).unwrap_or(""));
            let site = s.config.get("site").and_then(Json::as_str).map(|h| format!(" htmlUrl=\"{}\"", escape(h))).unwrap_or_default();
            out.push_str(&format!("    <outline type=\"rss\" text=\"{title}\" title=\"{title}\" xmlUrl=\"{url}\"{site} key:interval=\"{interval}\"/>\n"));
        } else {
            let config = escape(&Json::Object(s.config.clone()).to_string());
            out.push_str(&format!("    <outline type=\"key-alert\" text=\"{title}\" title=\"{title}\" key:kind=\"{}\" key:config=\"{config}\" key:interval=\"{interval}\"/>\n", escape(&s.kind)));
        }
    }
    out.push_str("  </body>\n</opml>\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_journal_table_of_contents_rss_feed() {
        let feed = feed(include_str!("fixtures/journal-toc.rss"), None).unwrap();
        assert_eq!(feed.title.as_deref(), Some("Nature Methods: latest research"));
        let [first, second] = feed.items.as_slice() else { panic!("two items: {:?}", feed.items) };
        assert_eq!(first["title"], "Deep learning for cell segmentation & tracking");
        assert_eq!(first["doi"], "10.1038/s41592-025-01234-5");
        assert_eq!(first["authors"], json!(["Ada Lovelace", "Grace Hopper"]));
        assert_eq!(first["published"], "2025-06-10");
        assert_eq!(first["year"], 2025);
        assert_eq!(first["venue"], "Nature Methods");
        assert_eq!(first["abstract"], "We present a method for segmenting cells.");
        assert_eq!(second["authors"], json!(["Alan Turing"]));
        assert_eq!(second["landingUrl"], "https://www.nature.com/articles/s41592-025-09999-x");
    }

    #[test]
    fn reads_arxiv_rdf_and_atom() {
        let arxiv = feed(include_str!("fixtures/arxiv.rdf"), None).unwrap();
        assert_eq!(arxiv.items.len(), 2);
        assert_eq!(arxiv.items[0]["ids"]["arxiv"], "2506.01234");
        assert_eq!(arxiv.items[0]["type"], "preprint");
        assert_eq!(arxiv.items[0]["authors"], json!(["Jane Doe", "John Smith"]));
        assert_eq!(arxiv.items[0]["pdfUrl"], "https://arxiv.org/pdf/2506.01234");
        let atom = feed(include_str!("fixtures/blog.atom"), Some(&Url::parse("https://blog.example.org/").unwrap())).unwrap();
        assert_eq!(atom.title.as_deref(), Some("A research blog"));
        assert_eq!(atom.items[0]["landingUrl"], "https://blog.example.org/posts/first");
        assert_eq!(atom.items[0]["authors"], json!(["Emmy Noether"]));
        assert_eq!(atom.items[0]["published"], "2025-05-01");
        assert!(atom.items[0]["abstract"].as_str().unwrap().starts_with("Symmetry and"));
        assert!(feed("<html><body>hi</body></html>", None).is_none());
    }

    #[test]
    fn survives_sloppy_feeds() {
        let sloppy = "<rss><channel><title>A & B</title><item><title>One &amp; two</item><item><title>Three</title><link>https://x.org/3</link></item></channel>";
        let parsed = feed(sloppy, None).unwrap();
        assert!(parsed.items.iter().any(|i| i["title"] == "Three"));
    }

    #[test]
    fn finds_feeds_a_page_links_to() {
        let html = r#"<html><head><link rel="stylesheet" href="/s.css"><LINK REL="alternate" type="application/rss+xml" title="Latest &amp; greatest" href="/rss/current.xml"><link rel=alternate type=application/atom+xml href=https://feeds.example.org/atom></head></html>"#;
        let found = discover(html, &Url::parse("https://journal.example.org/toc").unwrap());
        assert_eq!(found, [("https://journal.example.org/rss/current.xml".to_string(), Some("Latest & greatest".to_string())), ("https://feeds.example.org/atom".into(), None)]);
    }

    #[test]
    fn reads_dates_and_dois() {
        assert_eq!(date("Tue, 10 Jun 2025 04:00:00 +0000").as_deref(), Some("2025-06-10"));
        assert_eq!(date("2025-06-10T04:00:00Z").as_deref(), Some("2025-06-10"));
        assert_eq!(date("2024").as_deref(), Some("2024-01-01"));
        assert_eq!(find_doi("doi:10.1000/xyz123. More").as_deref(), Some("10.1000/xyz123"));
        assert_eq!(find_doi("https://doi.org/10.1038/s41586-020-2649-2?utm=1").as_deref(), Some("10.1038/s41586-020-2649-2"));
        assert_eq!(find_doi("version 10.5 of it"), None);
    }

    #[test]
    fn opml_round_trips_feeds_and_alerts() {
        let text = r#"<?xml version="1.0"?><opml version="1.0"><body><outline text="Science"><outline text="Nature" type="rss" xmlUrl="https://www.nature.com/nature.rss" htmlUrl="https://www.nature.com"/></outline><outline text="No feed"/></body></opml>"#;
        let outlines = opml(text);
        assert_eq!(outlines.len(), 1);
        assert_eq!((outlines[0].kind.as_str(), outlines[0].title.as_str(), outlines[0].config["url"].as_str()), ("rss", "Nature", Some("https://www.nature.com/nature.rss")));
        let subscription = |kind: &str, title: &str, config: Json| key_store::feeds::Subscription {
            id: "x".into(),
            kind: kind.into(),
            title: title.into(),
            config: config.as_object().cloned().unwrap(),
            interval_minutes: 180,
            paused: false,
            created_at: 0,
            checked_at: None,
            next_at: None,
            failures: 0,
            last_error: None,
            etag: None,
            last_modified: None,
            cursor: None,
            unread: 0,
            total: 0,
        };
        let written = to_opml(&[subscription("rss", "Nature & co", json!({ "url": "https://www.nature.com/nature.rss?a=1&b=2" })), subscription("openalex", "Search \"x\"", json!({ "query": "graph neural", "filters": { "yearFrom": 2020 } }))]);
        let back = opml(&written);
        assert_eq!(back.len(), 2);
        assert_eq!((back[0].title.as_str(), back[0].config["url"].as_str()), ("Nature & co", Some("https://www.nature.com/nature.rss?a=1&b=2")));
        assert_eq!((back[1].kind.as_str(), back[1].title.as_str(), back[1].config["filters"]["yearFrom"].as_i64(), back[1].interval_minutes), ("openalex", "Search \"x\"", Some(2020), Some(180)));
    }
}
