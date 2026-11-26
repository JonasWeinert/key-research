# Connector spec, format 1

A connector tells Key's database search engine (`crates/key-connectors`) how to search one
scholarly database or grey-literature source: what it can do, how a neutral query becomes the
service's own syntax, which HTTP requests to send, and how to read the answers into Key's work
record. Specs are JSON data only. They never contain code: anything that needs real logic is a
named built-in adapter in Rust (list below), referenced by name.

- One file per connector: `connectors/specs/<id>.json`.
- Recorded test answers: `connectors/fixtures/<id>/<test>.json`.
- JSON Schema: `connectors/schema/connector-1.schema.json` (the engine checks every spec against it,
  then checks the meaning: hosts, templates, paths, adapters).
- Tools: `tools/connectors/validate`, `test`, `bundle`, `sign` (see `tools/connectors/README.md`).
- Every change to a spec bumps its `version` (semver). The bundle index carries a sha256 per spec.

## Top level

```jsonc
{
  "format": 1,                      // this document
  "id": "pubmed",                   // [a-z0-9][a-z0-9-]*, stable forever
  "version": "1.0.0",               // semver, bump on every change
  "minEngine": "1.0.0",             // engine version needed (adapters, ops)
  "name": "PubMed",
  "description": "Biomedical literature from MEDLINE, life-science journals and online books.",
  "homepage": "https://pubmed.ncbi.nlm.nih.gov/",
  "category": "biomedical",         // biomedical | multidisciplinary | economics | social-science |
                                    // grey-literature | preprints | registries | other
  "coverage": "36M+ citations, 1946 onwards (some older).",
  "terms": "Free; NCBI asks for at most 3 requests/s without a key, 10/s with one.",
  "kind": "api",                    // api | harvest (no server query: harvest a scope and filter
                                    // locally) | manual (no machine access: guidance + export import)
  "credentials": [ /* see Credentials */ ],
  "hosts": ["eutils.ncbi.nlm.nih.gov"],   // the ONLY hosts any request may go to (https only)
  "politeness": { /* see Politeness */ },
  "capabilities": { /* see Capabilities */ },
  "query": { /* see Query translation */ },
  "search": { /* a Plan: see Request plans */ },
  "count": { /* optional Plan for estimates; default: search with one item */ },
  "lookup": { /* optional Plan to fetch one record by its sourceId: {id} */ },
  "manual": { /* kind=manual only: {"url": "...", "steps": ["..."], "exportFormats": ["ris"]} */ },
  "tests": [ /* see Tests */ ]
}
```

## Credentials

```jsonc
"credentials": [
  { "id": "api_key", "label": "NCBI API key", "required": false,
    "secret": "ncbi",          // the key's name in Key's secrets store (Electron main pushes it)
    "help": "Optional. Raises the rate limit from 3 to 10 requests per second.",
    "url": "https://account.ncbi.nlm.nih.gov/settings/" }
]
```

Templates read a credential as `{cred.api_key}`. A `required` credential that is missing makes the
connector unavailable ("needs key"). Scopus: `{ "id": "apikey", "secret": "elsevier" }` plus optional
`{ "id": "insttoken", "secret": "elsevier-insttoken" }`; Web of Science Starter: `{ "id": "apikey",
"secret": "clarivate-wos" }`. Key never reads the keychain in Rust: the app pushes values with
`db_options`.

## Politeness

```jsonc
"politeness": {
  "minIntervalMs": 350,          // between requests to this connector (without a key)
  "minIntervalMsWithKey": 110,   // when every credential is present (optional)
  "retries": 4,                  // on 429, 5xx, timeouts
  "backoffMs": 2000,             // doubles each try; Retry-After wins when sent
  "maxPages": 100,               // hard ceiling per query per run
  "mailtoParam": "email"         // optional: add the user's contact address as this parameter
}
```

## Capabilities

What the visual query builder may offer for this connector (and what the engine warns about).

```jsonc
"capabilities": {
  "fields": ["all", "title", "title_abstract", "author", "journal", "keywords", "subject", "affiliation"],
  "phrase": true, "truncation": true, "proximity": false,
  "dates": "year",               // none | year | day
  "filters": ["types", "languages"],
  "maxResults": 10000,           // what one query can return; above it the engine chunks (query.chunk)
  "sort": ["relevance", "date"],
  "exportFields": ["title", "authors", "year", "venue", "abstract", "doi", "pmid", "keywords"]
}
```

Neutral fields: `all`, `title`, `title_abstract`, `abstract`, `keywords`, `subject` (controlled
vocabulary such as MeSH or JEL), `fulltext`, `author`, `journal`, `affiliation`, `identifier`.

## The neutral query (what the builder sends)

```jsonc
{
  "concepts": [                                  // AND between concepts
    { "id": "c1", "label": "Population",
      "terms": [                                 // OR between terms
        { "id": "t1", "text": "school children", "mode": "phrase",   // phrase | words
          "truncate": false, "field": "title_abstract", "proximity": null }
      ] }
  ],
  "exclude": [ /* terms, NOT */ ],
  "filters": { "yearFrom": 2020, "yearTo": 2025, "types": ["article"], "languages": ["en"],
               "openAccess": null }
}
```

`mode: "words"` means all words of the term (AND) in the field; `phrase` the exact phrase.
`truncate` adds the service's wildcard to the last word. `proximity: n` asks for words within n
of each other (only where `capabilities.proximity`; otherwise a warning and a phrase).

## Query translation

```jsonc
"query": {
  "mode": "native",              // native: send the translated boolean string
                                 // terms: one request per term (services with relevance-only
                                 //   search, e.g. Crossref query.bibliographic); results are
                                 //   unioned, then filtered locally with the full query
                                 // harvest: no query sent (OAI-PMH); every record is filtered locally
  "fields": {                    // one term in a field; {q} is the term after phrase/words/truncation
    "all": "{q}[all]", "title": "{q}[ti]", "title_abstract": "{q}[tiab]",
    "author": "{q}[au]", "journal": "{q}[ta]", "subject": "{q}[mh]"
  },
  "fallback": { "keywords": "title_abstract", "abstract": "title_abstract" },  // else default + warning
  "defaultField": "all",
  "phrase": "\"{text}\"",        // {text}: the term's text after escaping
  "words": "{text}",             // several words: joined by "wordJoin" inside the field
  "wordJoin": " ",               // " " (service ANDs words), or e.g. " AND " with per-word fields
  "perWordField": false,         // true: apply the field template to each word ("a[tiab] AND b[tiab]")
  "truncate": "{text}*",
  "proximity": "\"{text}\"[tiab:~{n}]",   // optional
  "and": " AND ", "or": " OR ", "not": " NOT ",
  "group": "({q})",
  "notStyle": "binary",          // binary: "(A) NOT (B)"; andNot: "(A) AND NOT (B)" (Scopus);
                                 // prefix: "(A) -(B)"
  "escape": [ { "find": "\"", "replace": "" } ],      // literal find/replace on term text
  "lowercaseOperators": false,
  "dates": { "template": "{q} AND ({from}:{to}[dp])", "from": "{yearFrom}", "to": "{yearTo}",
             "openFrom": "1800", "openTo": "3000" },  // ANDed into the native string
  "vars": {                      // derived template variables: `template` when all its variables
                                 // are present, else `else` (default empty)
    "dateFrom": { "template": ",from-pub-date:{yearFrom}" },
    "dateTo":   { "template": ",until-pub-date:{yearTo}" }
  },
  "filters": {                   // neutral filter value -> native clause, ANDed (or params)
    "types": { "join": " OR ", "template": "{q} AND ({v})",
               "values": { "article": "journal article[pt]", "review": "review[pt]" } }
  },
  "maxLength": 4000,             // characters; longer queries are chunked
  "chunk": "or-split",           // none | or-split (split the largest OR group into parts, union
                                 //   the results) | year-split (split the date range by year when a
                                 //   query returns more than maxResults)
  "maxChunks": 20
}
```

Translation returns the native string (or strings, when chunked) and warnings ("Proximity is not
supported by EconStor; searched as a phrase", "Field keywords searched as title/abstract").

Local filtering (modes `terms` and `harvest`, and `"localFilter": true` in native mode) evaluates the
neutral query on the record: `title` against title, `title_abstract` against title + abstract,
`keywords`/`subject` against keywords, `author` against authors, `all` against everything; phrase,
words, truncation and proximity are honoured, case and diacritics folded.

## Request plans

```jsonc
"search": {
  "adapter": "paged",            // paged (default) | ncbi-history | oai-pmh | html-listing
  "request": {
    "method": "GET",             // GET | POST
    "url": "https://api.crossref.org/works",
    "params": { "query.bibliographic": "{query}", "rows": "{pageSize}", "cursor": "{cursor}",
                "filter": "prefix:{opt.prefix}{dateFrom}{dateTo}", "mailto": "{mailto?}" },
    "headers": { "X-ELS-APIKey": "{cred.apikey}" },
    "form": { },                 // POST application/x-www-form-urlencoded
    "body": null,                // POST JSON body (an object whose strings are templates)
    "format": "json"             // json | xml | html
  },
  "pageSize": 100,
  "paging": {
    "style": "cursor",           // none | offset | page | cursor | token
    "start": 0,                  // first offset/page (offset: 0, page: 1)
    "firstCursor": "*",          // cursor: the first value
    "next": "$.message.next-cursor",   // cursor/token: where the next value is (path)
    "stopWhenFewer": true        // stop when a page returns fewer items than pageSize
  },
  "total": "$.message.total-results",  // path to the total count (optional)
  "items": "$.message.items[*]",       // path to the list of records
  "record": { /* field -> Extract, see Extraction */ },
  "detail": {                    // optional second step: the list gives ids, details come in batches
    "ids": "$.esearchresult.idlist[*]",
    "batch": 200,
    "request": { "url": "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
                 "params": { "db": "pubmed", "id": "{ids}", "retmode": "xml" }, "format": "xml" },
    "items": "//PubmedArticle",
    "record": { }
  }
}
```

### Template variables

`{query}` native query (chunk), `{pageSize}`, `{offset}`, `{page}`, `{cursor}`, `{token}`,
`{ids}` (comma-joined, detail step), `{id}` (lookup), `{yearFrom}`, `{yearTo}`, `{mailto}`,
`{cred.<id>}`, `{webenv}`, `{queryKey}` (ncbi-history), `{set}`, `{from}` (oai-pmh), and
`{opt.<name>}` (connector options, below), and the names in `query.vars`. A variable ending in `?` is optional: a parameter or
header whose template uses a missing optional variable is left out. A missing required variable is
an error. Values are URL-encoded by the engine; templates never build URLs by concatenation of
user text (the URL's host must be in `hosts`).

### Options

```jsonc
"options": [ { "id": "set", "label": "Community", "default": "", "choices": [ {"value": "", "label": "All"} ] } ]
```

Choices shown by the builder (e.g. an OAI set, a Crossref prefix); read as `{opt.set}`.

### Built-in adapters (Rust, versioned with the engine)

| adapter | what it does |
| --- | --- |
| `paged` | the generic loop above: offset, page, cursor or token paging, optional `detail` step |
| `ncbi-history` | NCBI E-utilities: `esearch` with `usehistory=y` (total + WebEnv + query_key), then `efetch` batches from the history server (`{webenv}`, `{queryKey}`, `{offset}`, `{pageSize}`); `request` is the esearch call, `detail.request` the efetch call |
| `oai-pmh` | OAI-PMH `ListRecords`: `request` with `verb`, `metadataPrefix`, `set`, `from`; follows `resumptionToken` (only `verb` + `resumptionToken` on later pages); `completeListSize` is the total; `noRecordsMatch` is an empty answer. Always used with `query.mode: "harvest"` |
| `html-listing` | a listing page (search results or a sitemap) with links to item pages: `request` fetches the listing (with `paging`), `links` is the selector for item URLs (same host only), `detail.record` reads each item page (`detail.request.url: "{link}"`) |

Adapters read the same `request`/`paging`/`items`/`record` keys; there is no other configuration.

### Retries, throttling, caching

The engine waits `minIntervalMs` between a connector's requests, retries 429/5xx/timeouts with
backoff (honouring Retry-After), stops on 4xx (401/403 = "key rejected"), and caches answers per
(connector version, request) for a day for counts and pages. Requests go through `key-safe-http`:
https only, exact host allowlist (`hosts`), public addresses only, bounded size and time.

## Extraction

`record` maps Key's work fields to extractors. An extractor is a path string or an object:

```jsonc
"title":    "$.title[0]",
"authors":  { "path": "$.author[*]", "all": true, "name": { "family": "$.family", "given": "$.given", "literal": "$.name" } },
"year":     { "path": "$.issued.date-parts[0][0]", "type": "year" },
"date":     { "first": ["$.published.date-parts[0]", "$.issued.date-parts[0]"], "type": "date" },
"venue":    "$.container-title[0]",
"abstract": { "path": "$.abstract", "type": "text" },          // tags stripped, whitespace folded
"doi":      { "path": "$.DOI", "type": "doi" },
"url":      { "path": "$.DOI", "template": "https://doi.org/{value}" },
"keywords": { "path": "$.subject[*]", "all": true },
"sourceId": "$.DOI"                                            // required: the record's id at the source
```

Object keys: `path` (one path), `first` (several paths, first non-empty wins), `all` (a list, not the
first match), `join` (join a list into one string), `regex` (keep the first capture group, or the
match), `replace` (list of `{ "find": "regex", "with": "text" }`), `template` (`{value}`), `map`
(exact value -> value, e.g. type names), `default`, `name` (author parts, each a path relative to the
match), `type` (`text` | `year` | `date` | `doi` | `int` | `url` | `language`).

Paths by format:
- JSON: `$.a.b`, `$.a[0]`, `$.a[*]`, `$["key with.dots"]`, relative `$.x` inside an item.
- XML: `//PubmedArticle` (any depth), `MedlineCitation/Article/ArticleTitle` (relative to the item),
  `ArticleId[@IdType='doi']`, `@attr`, `*` (any element); namespaces are ignored (local names). The
  value is the element's text including descendants.
- HTML: CSS selectors: `tag`, `.class`, `#id`, `[attr]`, `[attr=value]`, `a b` (descendant),
  `a > b` (child), with `@attr` at the end for an attribute (`a.title@href`); links are resolved
  against the page URL.

Normalised record fields: `sourceId`, `title`, `authors` (list of "Family, Given" or a literal name),
`year`, `date` (YYYY or YYYY-MM or YYYY-MM-DD), `venue` (journal or series), `series`, `number`
(report number), `publisher`, `abstract`, `doi`, `pmid`, `pmcid`, `arxiv`, `openalex`, `handle`,
`isbn`, `issn`, `url`, `pdfUrl`, `type` (article, preprint, working-paper, report, book, chapter,
dataset, trial, thesis, other), `language`, `keywords`, and `extras` (an object of extractors:
anything source-specific, kept as text).

## Tests

```jsonc
"tests": [
  { "name": "covid-vaccine-hesitancy",
    "query": { "concepts": [ { "terms": [ { "text": "vaccine hesitancy", "mode": "phrase", "field": "title_abstract" } ] } ],
               "filters": { "yearFrom": 2021, "yearTo": 2021 } },
    "native": "\"vaccine hesitancy\"[tiab] AND (2021:2021[dp])",   // optional: exact translation
    "minTotal": 500,                // live: the count is at least this
    "minResults": 20,               // records read in the first pages
    "pages": 1,
    "mustFind": [ { "doi": "10.1016/j.vaccine.2021.01.010" }, { "title": "..." } ],
    "fields": ["title", "authors", "year", "doi"],   // present in at least 80% of records
    "fixture": "covid-vaccine-hesitancy" }          // connectors/fixtures/<id>/<fixture>.json
]
```

Fixture files are recorded answers: `{ "recorded": "2026-11-26", "exchanges": [ { "method": "GET",
"url": "https://...", "status": 200, "headers": { "content-type": "..." }, "body": "..." } ] }`.
Replay matches method, host, path and query parameters (credentials and `mailto`/`tool`/`email` are
ignored). `tools/connectors/test --record` refreshes them from the live service.

Tests must use generic topics. Never put a private project's search strings in a spec.

## Limits

- At most 200 KB per spec; at most 64 record fields; templates at most 4 KB.
- No arbitrary code, no expressions beyond the operations above, no host outside `hosts`, no
  plain http, no redirects to other hosts (except `html-listing` item links on the same hosts).
