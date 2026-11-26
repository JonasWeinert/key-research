// Every explanation Key shows, keyed by id, so the wording stays consistent and can be read in
// one place. Voice: second person, plain words, sentence case, no exclamation marks, no
// marketing; say what happens and what does not. Gloss a technical word the first time, or
// point to its glossary entry. Length budgets are checked by help-content.test.ts.
//
//   hint     one sentence under a control or heading           <Hint help="…" />
//   explain  the (i) popover: title, 2–4 sentences, steps …     <Explain help="…" />
//   empty    an empty view: what this is, what to do            <EmptyState help="…" />
//   tip      a first-use coach mark, shown once                 <FirstUseTip help="…" />
//   term     a glossary entry (Settings › General › Glossary)

export interface HelpLink {
  label: string;
  url: string;
}
export interface HintEntry {
  kind: "hint";
  text: string;
}
export interface ExplainEntry {
  kind: "explain";
  title: string;
  body: string[];
  /** "How to": short numbered steps. */
  steps?: string[];
  example?: string;
  links?: HelpLink[];
  /** What leaves this Mac, if anything. */
  privacy?: string;
}
export interface EmptyEntry {
  kind: "empty";
  title: string;
  /** What this place is. */
  what: string;
  /** What to do to fill it. */
  todo: string;
}
export interface TipEntry {
  kind: "tip";
  title: string;
  body: string;
}
export interface TermEntry {
  kind: "term";
  term: string;
  text: string;
}
export type HelpEntry = HintEntry | ExplainEntry | EmptyEntry | TipEntry | TermEntry;

const hint = (text: string): HintEntry => ({ kind: "hint", text });
const explain = (title: string, body: string[], more: Omit<ExplainEntry, "kind" | "title" | "body"> = {}): ExplainEntry => ({ kind: "explain", title, body, ...more });
const empty = (title: string, what: string, todo: string): EmptyEntry => ({ kind: "empty", title, what, todo });
const tip = (title: string, body: string): TipEntry => ({ kind: "tip", title, body });
const term = (name: string, text: string): TermEntry => ({ kind: "term", term: name, text });

export const HELP = {
  // ── Settings: General ────────────────────────────────────────────────────────────────
  "settings.general.appearance": hint("Light, dark, or follow your Mac. PDFs, notes and web pages keep their own colours."),
  "settings.general.tips": hint("Short tips point out features that are easy to miss, once each. Show again brings back the ones you closed."),
  "settings.general.glossary": hint("Words Key uses, in plain terms."),

  "settings.scope.app": explain(
    "Key Settings and Workspace Settings",
    [
      "Key Settings apply to Key on this Mac, whichever workspace is open: appearance, models, privacy, web, API keys and the AI assistant.",
      "Workspace Settings apply to one workspace only: its Zotero link, indexing, citation keys, exports, files and feeds. Open them from a workspace’s window or from Workspaces here.",
    ],
  ),
  "settings.scope.workspace": explain(
    "Settings for this workspace",
    [
      "These settings belong to this workspace alone and travel with its folder. Other workspaces keep their own.",
      "Where a row says Using app default, the workspace follows Key Settings until you choose Change.",
    ],
  ),
  "settings.override": explain(
    "App default or this workspace’s own",
    [
      "Some settings, such as the citation style or automatic lookups, have a default in Key Settings that every workspace follows.",
      "Change gives this workspace its own value without touching the others. Use app default makes it follow Key Settings again.",
    ],
  ),

  // ── Settings: Libraries ──────────────────────────────────────────────────────────────
  "settings.libraries.intro": hint("A library is a folder on this Mac that holds your sources, notes and collections."),
  "settings.libraries.what": explain(
    "What is a library?",
    [
      "A library (also called a workspace) is one folder on this Mac. It holds the list of your sources, their notes and highlights, your collections, tags and the search index.",
      "PDFs you add are kept in the library folder, or left where they are if you link them. You can have several libraries, for example one per project, and each opens in its own window.",
    ],
    { privacy: "A library stays on this Mac. Key has no account and no cloud copy." },
  ),
  "settings.libraries.add-from-source": explain(
    "Works added from another source",
    [
      "When you add a work from a source’s reference list, its related works or a citation inside its PDF, Key can file the new work in the same collections as the source you found it in.",
      "Ask lets you choose each time. The other choices skip the question.",
    ],
  ),
  "settings.libraries.find-pdf": explain(
    "Finding PDFs automatically",
    [
      "When you add a reference that has no PDF, Key looks for a free, legal copy (open access) and attaches it if one exists.",
      "It looks in OpenAlex, Unpaywall, arXiv and PubMed Central, quietly in the background. When none is found, the source says so and Find PDF on its page can open the publisher’s site for you.",
    ],
    { privacy: "Only the work’s DOI or title is sent to these services." },
  ),

  // ── Settings: Search & indexing ─────────────────────────────────────────────────────
  "settings.search.indexing": explain(
    "Indexing",
    [
      "Indexing means reading each source once so search can find it. New sources are indexed in the background; the ones you open or scroll to go first.",
      "Pausing stops new reading but keeps search working on what is already indexed. A source that needs attention usually has a damaged or password-protected PDF.",
    ],
  ),
  "settings.search.layout": explain(
    "Layout analysis",
    [
      "Many PDFs are laid out in columns, with tables, figures and footnotes. Layout analysis uses a second small model to work out the reading order and which part is a heading, a table or a caption.",
      "It makes highlights, references and search more accurate. It takes about a second per page and runs on this Mac.",
    ],
  ),
  "settings.search.metadata": explain(
    "Metadata lookup",
    [
      "Metadata is the information about a work: its title, authors, journal, year, abstract and identifiers. Key can look this up in OpenAlex, a free open catalogue of scholarly works, when a source arrives with a DOI.",
      "It also fills in citation counts, topics and whether a work was retracted. You can turn it off and look sources up only when you ask.",
    ],
    { privacy: "Only identifiers and titles are sent to OpenAlex and Crossref, never your files or notes." },
  ),
  "settings.search.email": explain(
    "Why OpenAlex asks for an email",
    [
      "OpenAlex serves requests that include a contact email from a faster, more reliable queue (its “polite pool”), so it can reach you if something goes wrong.",
      "This is optional. Without it, Key uses its own address. OpenAlex does not send you mail.",
    ],
  ),
  "settings.search.people": explain(
    "Possible duplicate people",
    [
      "The same author can appear under slightly different names, such as “J. Smith” and “Jane Smith”. Key lists pairs that might be one person.",
      "Nothing is merged until you review a pair and choose Merge. Merging keeps every source of both and the fuller name.",
    ],
  ),

  // ── Settings: Web & browser, library access ─────────────────────────────────────────
  "settings.web.search": explain(
    "Web search",
    [
      "Web search looks for works you do not have yet, in scholarly catalogues such as OpenAlex, Semantic Scholar, Crossref and arXiv. Results show which ones are already in your library.",
      "Turn off a catalogue to stop asking it. Some, like Google Scholar, need an API key; see Services & API keys.",
    ],
    { privacy: "Only what you type in the search field is sent, and only when you search the web." },
  ),
  "settings.web.browser": hint("Key’s built-in browser keeps its own cookies and sign-ins, separate from Safari or Chrome."),
  "settings.web.access": explain(
    "What is library access?",
    [
      "Universities and many employers pay for journals. Off campus, you reach them through a library proxy: a sign-in page run by your library (often EZproxy or OpenAthens) that opens the article as if you were on campus.",
      "Key remembers your library’s proxy and uses it only where you need it. On your library’s network an article loads directly; elsewhere it opens “via proxy”, and you sign in once with your library account.",
      "Sources you save keep the publisher’s normal address, so links work for anyone.",
    ],
    { privacy: "Your sign-in goes only to your library. Key never sees or stores your password." },
  ),
  "settings.web.recognise": explain(
    "Recognising proxies",
    [
      "When a page you open looks like a library proxy sign-in (an EZproxy or OpenAthens address), Key offers to remember it, so later articles on that site open through it.",
      "Nothing is remembered without you saying so.",
    ],
    { example: "www-nature-com.ezproxy.uni.edu or go.openathens.net/redirector/uni.edu" },
  ),
  "settings.web.proxy-add": explain(
    "Adding your library’s proxy",
    [
      "Your library’s website usually explains off-campus access and shows a link that starts with its proxy address.",
    ],
    {
      steps: [
        "Search your library’s site for “off-campus access”, “EZproxy” or “OpenAthens”.",
        "Copy the start of a proxied link, for example https://ezproxy.uni.edu/login?url=",
        "Paste it here and pick the kind. Add the sites it covers, or let Key learn them as you browse.",
      ],
      example: "https://ezproxy.uni.edu/login?url=",
    },
  ),

  "settings.web.proxy-mode": explain(
    "When Key uses your proxy",
    [
      "Automatic: on campus, or on your university’s VPN, journals already let you in, so pages load directly. Elsewhere they go through your proxy. Key finds out by trying: a page that loads with its full text marks the network as direct; a page that asks you to sign in reopens through the proxy, and the network is remembered as needing it.",
      "Always sends every site of the proxy through it. Never loads pages directly and offers the proxy when a page asks you to sign in.",
      "The bar above the page says what happened, with one click to do the other thing. That choice is kept for the site on that network.",
    ],
    { privacy: "Networks are told apart by a scrambled code made from the router and DNS settings, kept on this Mac only. No location, no Wi-Fi name, nothing sent." },
  ),
  "settings.web.networks": explain(
    "Networks Key has learned",
    [
      "Each network where you opened a proxy’s sites, and whether they loaded directly there or needed the proxy. A network is named by its domain when it has one, otherwise by when Key first saw it.",
      "Forget clears what was learned, so Key tries again there. Always proxy here and Never proxy here fix the choice for that network. A wrong guess also corrects itself the next time a page loads.",
    ],
  ),
  "settings.web.auto-reload": hint("When a page that loaded directly asks you to sign in, it reopens through your proxy at once."),
  "settings.web.campus-domains": hint("Pages load directly when your network’s domain or this Mac’s name contains one of these, as on campus."),
  "browser.proxy.direct": hint("Loaded directly: this network seems to have your library’s access. Use proxy if the page asks you to sign in."),
  "browser.proxy.signin": hint("Loaded directly, this page asked you to sign in, so Key opened it through your library’s proxy."),
  "browser.proxy.network": hint("On this network, this site needs your library’s proxy, so Key opened it through the proxy."),
  "browser.proxy.suggest": hint("This page asks you to sign in or buy access. Your library’s proxy may let you in."),

  // ── Settings: Services & API keys ───────────────────────────────────────────────────
  "settings.services.intro": hint("Optional keys that give Key a higher allowance at some scholarly services. Key works without them."),
  "settings.services.api-key": explain(
    "What is an API key?",
    [
      "An API key is a long code that a service gives you so that the requests Key makes on your behalf are counted under your name. It works like a library card number for a website’s data.",
      "You do not need one: without a key, Key shares the free allowance every app gets. A key of your own gives you your own allowance, which helps with large libraries or busy days.",
      "By default the key is used only when a normal request is limited or refused. Set it to Always to send it with every request.",
    ],
    { privacy: "Your key is stored encrypted on this Mac and sent only to the service it belongs to." },
  ),
  "settings.services.openalex": explain(
    "An OpenAlex key",
    ["OpenAlex is a free, open catalogue of scholarly works. A key is free and gives you your own daily allowance for lookups and web search."],
    {
      steps: ["Open openalex.org and sign in or create a free account.", "Go to Settings, then API.", "Copy the key and paste it here, then press Save."],
      links: [{ label: "Get a key at openalex.org", url: "https://openalex.org/settings/api" }],
    },
  ),
  "settings.services.scholar-serpapi": explain(
    "A Google Scholar key through SerpApi",
    [
      "Google Scholar has no public way for apps to search it. SerpApi, a paid third-party service, runs the searches for you. Its free plan allows about 100 searches a month; more costs money.",
      "Google Scholar is only asked when you search the web, and only with this key.",
    ],
    {
      steps: ["Open serpapi.com and create an account.", "Open Manage API key in your account.", "Copy the key and paste it here, then press Save."],
      links: [{ label: "Get a key at serpapi.com", url: "https://serpapi.com/manage-api-key" }],
      privacy: "Your search words go to SerpApi, which passes them to Google Scholar.",
    },
  ),
  "settings.services.semantic-scholar": explain(
    "A Semantic Scholar key",
    ["Semantic Scholar is a free catalogue run by the Allen Institute for AI. Without a key, all apps share a low rate limit. A key is free and raises yours."],
    {
      steps: ["Open the Semantic Scholar API page.", "Fill in the key request form; approval usually takes a few days by email.", "Paste the key here and press Save."],
      links: [{ label: "Request a key at semanticscholar.org", url: "https://www.semanticscholar.org/product/api#api-key-form" }],
    },
  ),

  // ── Settings: AI ─────────────────────────────────────────────────────────────────────
  "settings.ai.provider": explain(
    "AI assistant",
    [
      "Some tasks, like filling in missing details of a reference from its PDF, can use a large language model. You choose which one: a local app such as Ollama or LM Studio that runs on this Mac, or a hosted service you have an account with.",
      "Nothing is sent until you start such a task, and then only the passages that task needs.",
    ],
    { privacy: "With a local model nothing leaves this Mac. With a hosted one, the passages go to that provider." },
  ),
  "settings.ai.endpoint": explain(
    "Connecting a provider",
    ["Any service that speaks the OpenAI format works. For a local model, start Ollama or LM Studio first."],
    {
      steps: ["Enter the endpoint, the address the service answers on.", "Enter the model’s name as the service lists it.", "Add an API key if the service needs one, then press Save provider."],
      example: "Ollama: http://localhost:11434/v1 with model llama3.1:8b",
    },
  ),

  // ── Settings: Zotero ─────────────────────────────────────────────────────────────────
  "settings.zotero.intro": hint("Bring your Zotero library into Key once, or keep following it. Key never changes your Zotero library."),
  "zotero.import-vs-sync": explain(
    "Import or keep in sync?",
    [
      "Import copies what is in Zotero today into Key, once. Afterwards the two are separate: what you change in Zotero does not reach Key until you import again.",
      "Keep in sync follows Zotero from then on: items you add, edit, move or delete in Zotero follow into Key while both apps are open. It needs a small plugin, Key Sync, that Key installs into Zotero for you.",
      "Either way, Key only reads from Zotero. Where both apps changed the same item, Key keeps its own version and lists the conflict.",
    ],
  ),
  "zotero.this-workspace": explain(
    "A Zotero workspace or this one?",
    [
      "A workspace named Zotero keeps what comes from Zotero apart from your other work. That is how Key did it at first, and it stays like that if you set it up so.",
      "You can also bring Zotero’s items into this workspace, beside what is already here, and keep it in sync. Sources Key already has are matched, not added twice.",
      "Each workspace keeps its own Zotero set-up: what it covers, when it last synced and its conflicts.",
    ],
  ),
  "zotero.plugin": explain(
    "The Key Sync plugin",
    [
      "Key Sync is a small add-on for Zotero 7. It tells Key when something changes in your Zotero library, so Key can follow along without reading Zotero’s database directly.",
      "It only reads. You can remove it any time in Zotero under Tools, Plugins.",
    ],
    { privacy: "It talks only to Key on this Mac, never to the internet." },
  ),
  "zotero.bring": explain(
    "What to bring along",
    [
      "PDFs and other files are linked where Zotero keeps them, so no space is used twice. Notes become Markdown notes. PDF annotations become a note of quotes for each PDF.",
      "Zotero collections are recreated as Key collections. Library proxies copies your EZproxy or OpenAthens set-up for Key’s browser.",
    ],
  ),
  "zotero.scope": hint("Everything, chosen collections or chosen papers. You can change this later."),

  // ── Settings: Citations, citation keys, export ──────────────────────────────────────
  "settings.citations.style": explain(
    "What is a citation style?",
    [
      "A citation style is the set of rules for how a reference looks in your text and bibliography: the order of names, where the year goes, italics and punctuation. Journals and universities each ask for one.",
      "Key uses CSL (Citation Style Language) styles, the same files Zotero and Mendeley use, so over 10,000 styles are available.",
    ],
    { example: "APA: Smith, J. (2020). Title. Journal, 4(2), 1–9.\nChicago: Smith, Jane. 2020. “Title.” Journal 4 (2): 1–9." },
  ),
  "settings.keys.what": explain(
    "Citation keys and auto-export",
    [
      "A citation key is a short, unique name for a reference, such as smith2020sleep. People who write in LaTeX, Markdown (with Pandoc) or Overleaf type it in their text to cite a work.",
      "Auto-export keeps a bibliography file (BibTeX, BibLaTeX or CSL JSON) up to date whenever your library changes, so your writing tools always see the latest references.",
      "If you write in Word or Google Docs, you probably do not need this.",
    ],
    { example: "\\cite{smith2020sleep}  or  [@smith2020sleep]" },
  ),
  "settings.keys.pattern": hint("How new keys are made. Existing keys never change unless you regenerate them."),
  "settings.markdown.what": explain(
    "Markdown export",
    [
      "Markdown is plain text with light formatting, the format note apps like Obsidian and Logseq use. Key can write one Markdown file per source, with its details, highlights and notes, into a folder of your choice such as an Obsidian vault.",
      "Key only rewrites its own section of each file. What you write around it, and under each highlight, stays. If you edit Key’s section by hand, Key leaves the file alone and writes its version beside it.",
    ],
  ),
  "settings.files.what": explain(
    "Stored and linked files",
    [
      "A stored file is copied into the library folder and looked after by Key. A linked file stays where it is on your Mac (added from Finder or a linked folder), and Key only remembers where it is. Both open, search and highlight the same way.",
      "The file name rule gives files readable names, such as Smith - 2020 - Sleep and memory.pdf. Stored files are shown, dragged out and mirrored under it; linked files are renamed on disk only when you choose Apply.",
    ],
  ),
  "settings.files.mirror": explain(
    "The mirror folder",
    [
      "The mirror is an ordinary folder that shows your PDFs arranged by collection, so you can reach them from Finder, an iPad app or DEVONthink.",
      "On the same disk it uses hard links, a second name for the same file, so it takes no extra space and editing one edits the other. On another disk it makes copies. Key only changes files it put there.",
    ],
  ),

  // ── Settings: Feeds & alerts, Inbox ─────────────────────────────────────────────────
  "feeds.what": explain(
    "What are feeds and alerts?",
    [
      "A feed (also called RSS) is a list a website publishes of its newest articles, for example a journal’s latest issue or an arXiv category. Key checks the feeds you follow and puts new items in your Inbox.",
      "Alerts work the same way for things Key can watch for you: new works by an author, in a journal or a topic, new results for a web search, and new works that cite a source.",
      "Key checks only while it is open, on the schedule you set for each, and never adds anything to your library until you say so.",
    ],
    { privacy: "Key asks each website or OpenAlex for its newest items. Nothing about your library is sent." },
  ),
  "feeds.address": explain(
    "Finding a feed’s address",
    [
      "Paste the address of a journal’s page, a blog or an arXiv listing. If the page links to a feed, Key finds it for you.",
    ],
    { example: "https://www.nature.com/nature.rss\nhttps://arxiv.org/rss/cs.CL\nhttps://journals.plos.org/plosone/" },
  ),
  "feeds.kinds": explain(
    "Kinds of alerts",
    [
      "Feed: a journal, arXiv listing or blog by its address. Author, Journal, Topic: new works found in OpenAlex. Search alert: new results for a web search. Citation alert: new works that cite a source.",
      "Start an alert with Follow on a person’s, journal’s or topic’s page, or Alert me on a web search, a source or a collection.",
    ],
  ),
  "feeds.interval": hint("How often Key checks, while it is open. Daily suits most journals."),
  "feeds.intro": hint("New articles from journals, authors, topics and searches you follow arrive in your Inbox."),
  "feeds.opml-what": explain("OPML files", ["OPML is the file feed readers such as Feedly, NetNewsWire or Inoreader use to move a list of feeds. Export one from your old reader and import it here, or export Key’s list to use elsewhere."]),
  "feeds.keeping": hint("Old Inbox items are cleared after this long. Items you saved or added to the library always stay."),
  "inbox.triage": explain(
    "Going through the Inbox",
    [
      "Each item is a new work from something you follow. Add puts it in your library, Save keeps it here for later, and Dismiss removes it and it will not come back from the same feed.",
      "You can do it all from the keyboard.",
    ],
    { steps: ["j or ↓ next, k or ↑ previous", "a add to library, s save, e dismiss", "u read or unread, o open its page beside the Inbox"] },
  ),
  "empty.inbox": empty(
    "Nothing followed yet",
    "The Inbox collects new articles from journals, authors, topics and searches you follow.",
    "Add a feed by its address, or press Follow on an author’s, journal’s or topic’s page.",
  ),
  "empty.inbox-caught-up": empty("All caught up", "You have gone through every new item.", "New items appear here when your feeds and alerts bring them."),
  "empty.inbox-saved": empty("Nothing saved", "Items you keep for later collect here.", "Press s on an item, or choose Save, to keep it."),
  "empty.inbox-none": empty("No items yet", "Items your feeds and alerts bring in collect here.", "Press Check now, or wait for the next check while Key is open."),
  "empty.feeds": empty("Not following anything", "Feeds and alerts you follow are listed here.", "Paste a journal’s, blog’s or arXiv listing’s address above."),

  // ── Import, export, duplicates, metadata ────────────────────────────────────────────
  "import.formats": explain(
    "Import formats",
    [
      "BibTeX or BibLaTeX (.bib): the LaTeX format, from Google Scholar, Overleaf or JabRef. RIS (.ris): from EndNote, Mendeley, Web of Science and most publishers. CSL-JSON: from Zotero and Pandoc. EndNote XML from EndNote. CSV or TSV: a spreadsheet with a column per field.",
      "Key reads the references and adds them as sources. Attached files come along when the file names them and they are on this Mac. Fields Key has no place for are kept as properties.",
    ],
  ),
  "import.duplicates": explain(
    "Duplicates",
    [
      "A reference that is already in your library (the same DOI, or the same title, year and first author) is a duplicate.",
      "Skip leaves your copy as it is. Merge fills your copy’s empty fields from the file and adds its tags and notes. Import anyway keeps both, and you can merge them later.",
    ],
  ),
  "export.formats": explain(
    "Export formats",
    [
      "BibTeX and BibLaTeX for LaTeX and Overleaf. RIS for EndNote, Mendeley and most reference managers. CSL-JSON for Zotero and Pandoc. CSV for a spreadsheet.",
      "Keep exported rewrites the file whenever your library changes, so a LaTeX or Pandoc project always has the latest references. For a formatted reference list, use Copy bibliography instead.",
    ],
  ),
  "duplicates.what": explain(
    "Finding duplicates",
    [
      "Duplicates are two entries for the same work, often from importing twice or from two catalogues. Key matches them by DOI, title, year and authors.",
      "Merging keeps one entry. It keeps the fuller details of both, every PDF, note, highlight, tag and collection, and moves the other entry to the Trash, so you can undo it.",
    ],
  ),
  "metadata.update": explain(
    "Updating details",
    [
      "Key looked this work up in catalogues such as OpenAlex and Crossref and found details that differ from yours. Each change is shown as before and after.",
      "Tick the ones you want. Nothing changes until you press Update, and your own notes, tags and files are never touched.",
    ],
  ),
  "retraction.what": explain(
    "Retracted works",
    [
      "A retraction means the journal withdrew the paper, usually because of serious errors or misconduct. Its findings should not be relied on.",
      "Key checks retractions through OpenAlex and Crossref (which includes the Retraction Watch database) and marks affected sources so you notice before citing them.",
    ],
  ),
  "findpdf.where": explain(
    "Where Find PDF looks",
    [
      "Key looks for a free, legal (open-access) copy: the link the source already has, then OpenAlex, Unpaywall, arXiv and PubMed Central. It checks that what it gets really is a PDF and attaches it.",
      "If none is found, it opens the publisher’s page in Key’s browser, through your library proxy when your network needs it. A PDF you open there is attached to the same source.",
    ],
    { privacy: "Only the work’s DOI or title is sent." },
  ),
  "reading.status": hint("Unread, in progress or read: Key moves it along as you read, unless you set it yourself."),

  // ── Tags, relation map ──────────────────────────────────────────────────────────────
  "tags.suggestions": explain(
    "Tag suggestions",
    [
      "Key reads your tags and proposes tidying them. Merge duplicates joins spellings of one tag (Sleep, sleep, sleeping) and tags always used together. Nest under puts narrower tags inside a broader one. Hierarchy from names turns names like Methods/Survey into a tree.",
      "Convert to property turns tags that are really yes/no or a set of values (Read, To read) into a property. Clean up finds noise and tags used once.",
      "Nothing changes until you apply a suggestion, and every change can be undone.",
    ],
  ),
  "relations.map": explain(
    "Reading the relation map",
    [
      "The map puts one thing in the middle, such as a source, a person or a topic, and around it what it shares sources with in your library: topics, fields, people, journals, tags and collections. Each kind has its own colour, shape and sector.",
      "The nearer and larger a node, the more sources they share. Click a kind in the legend to show only that kind, hover a node to see what goes with it, and click it to search, open it or centre the map there.",
    ],
  ),
  "library.organise": explain(
    "Collections, tags and properties",
    [
      "A collection is a folder-like group, such as a project or a chapter. A source can be in several collections.",
      "A tag is a label you can put on any source, such as a theme or method. A property is a field with a value, such as Rating, Status or Read on.",
    ],
  ),
  "search.syntax": explain(
    "Searching",
    [
      "Type words to search titles, authors, the full text of your PDFs and your notes. Key also searches by meaning, so passages that use other words for the same idea are found.",
      "Key recognises what you type: a DOI, arXiv ID or link finds or adds that work, a year or a range of years narrows by year, and a tag, collection or kind (notes, highlights) is offered as a filter. Pick the suggestion to apply it.",
      "Web looks for works you do not have yet in scholarly catalogues such as OpenAlex. With Web off, nothing leaves this Mac.",
    ],
    { example: "sleep memory 2018-2022\n10.1038/nature12373\n\"a quoted title\"" },
  ),

  // ── Empty states: library and reader ────────────────────────────────────────────────
  "empty.library": empty("No sources yet", "Sources are the papers, books, web pages, videos and files you collect, read and cite.", "Drop files here, or use the Add menu to import from Zotero or a reference file, or search the web."),
  "empty.results": empty("No matches", "Nothing in this view matches your search or filters.", "Try fewer words, clear a filter, or search the web for works you do not have."),
  "empty.scope": empty("Nothing here yet", "This view gathers sources by how you marked them, such as starred, to read or recently read.", "Sources appear here as you mark or read them."),
  "empty.collection": empty("This collection is empty", "A collection groups sources, for example for one project or chapter. A source can be in several.", "Drag sources onto the collection in the sidebar, or add files straight into it."),
  "empty.highlights": empty("No highlights yet", "Highlights and comments you make in PDFs and web pages collect here.", "Open a PDF, select text and choose a colour."),
  "empty.trash": empty("Trash is empty", "Sources, notes and collections you delete wait here before they are gone for good.", "Nothing to do. Items in the Trash can be put back."),
  "empty.references": empty("No reference list found", "Key looks for a numbered or author–year reference list near the end of a paper and links each entry to the work it names.", "This PDF may have none, or it is a scanned image without text."),
  "empty.references-page": empty("No references on this page", "Key looks for a list of references or links to scholarly works on a saved page.", "Pages like blog posts and news often have none."),
  "model.download": explain(
    "Model download",
    [
      "Some features use small AI models that run on this Mac: one to search by meaning (so “sleep and memory” also finds “consolidation during rest”) (about 310 MB), one to understand PDF layouts (about 66 MB) and one for search inside the reader (about 24 MB). Each is downloaded once, the first time it is needed, from Hugging Face, a public site that hosts models, and checked before use.",
      "After that they work without the internet. Remove deletes them; Key downloads them again when needed. On a Mac without internet, add a model from a file.",
    ],
    { privacy: "Downloading is a plain file download. Nothing about you or your library is sent, and the models never send anything." },
  ),

  // ── First-use tips ──────────────────────────────────────────────────────────────────
  "tip.cite": tip("Cite what you select", "Cite copies the passage as a quote with its source and page, ready to paste into a note or a document."),
  "tip.citation-hover": tip("Look up a citation", "In the PDF, point at a citation like [12] or (Smith, 2020) to see the work it names, and add it to your library."),
  "tip.note-cite": tip("Cite in notes", "Type @ in a note and start typing a title or author to cite a source from your library."),
  "tip.split-tabs": tip("Read side by side", "Drag a tab to the left or right edge of the window to show two things side by side."),
  "tip.map-legend": tip("Filter the map", "Click a kind in the legend, such as People or Topics, to show only that kind. Click it again to show all."),
  "tip.inbox-keys": tip("Triage with the keyboard", "Press j and k to move, a to add, s to save and e to dismiss."),
  "tip.tag-suggestions": tip("Tidy your tags", "Key suggests merging duplicates and nesting related tags. Nothing changes until you apply one."),
  "tip.find-pdf": tip("Find the PDF", "Find PDF looks for a free legal copy, and opens the publisher’s page through your library if there is none."),
  "tip.proxies": tip("Library access", "This site can open through your library’s proxy, so you see articles your library pays for."),

  // ── Glossary ────────────────────────────────────────────────────────────────────────
  "term.api-key": term("API key", "A code a service gives you so the requests an app makes for you count under your own allowance. Optional in Key."),
  "term.doi": term("DOI", "Digital Object Identifier: a permanent ID for a published work, like 10.1038/nature12373. Key uses it to find details and PDFs."),
  "term.metadata": term("Metadata lookup", "Filling in a work’s title, authors, journal, year and abstract from a catalogue, using its DOI or title."),
  "term.openalex": term("OpenAlex", "A free, open catalogue of over 250 million scholarly works, authors and journals. Key’s main source for details and alerts."),
  "term.semantic-scholar": term("Semantic Scholar", "A free catalogue of scholarly works from the Allen Institute for AI, used for web search and related works."),
  "term.crossref": term("Crossref", "The organisation most publishers register DOIs with. Key asks it for details and retractions."),
  "term.csl": term("Citation style (CSL)", "Rules for how citations and bibliographies look, such as APA or Chicago, written in the Citation Style Language."),
  "term.citekey": term("Citation key", "A short unique name for a reference, such as smith2020sleep, typed in LaTeX or Markdown to cite it."),
  "term.bibtex": term("BibTeX and RIS", "Plain-text files for moving references between apps. BibTeX is used with LaTeX; RIS by EndNote, Mendeley and publishers."),
  "term.proxy": term("Library proxy", "A sign-in service run by your library (EZproxy, OpenAthens) that gives you its journal access off campus."),
  "term.feed": term("Feed (RSS)", "A list a website publishes of its newest articles. Key checks the feeds you follow and fills your Inbox."),
  "term.alert": term("Alert", "Key watching for new works by an author, in a journal or topic, for a search, or citing a source."),
  "term.index": term("Index", "What Key builds by reading your sources once, so search is instant. Stays on this Mac."),
  "term.fulltext": term("Full-text search", "Searching the words inside your PDFs and notes, not just titles and authors."),
  "term.semantic": term("Semantic search", "Searching by meaning: finds passages about your words even when they use different ones."),
  "term.layout": term("Layout analysis", "Working out a PDF’s reading order, headings, tables and captions, with a small model on this Mac."),
  "term.model": term("Model download", "A one-time download of a small AI model that then runs on this Mac without the internet."),
  "term.sync-import": term("Sync and import", "Import copies data once. Sync keeps following the other app as it changes."),
  "term.workspace": term("Library (workspace)", "One folder on this Mac with your sources, notes, collections and index. Each opens in its own window."),
  "term.organise": term("Collection, tag, property", "A collection groups sources; a tag labels them; a property gives them a field with a value, like Status."),
  "term.retraction": term("Retraction", "A journal withdrawing a paper, usually for serious errors. Key marks retracted works."),
  "term.preprint": term("Preprint", "A version of a paper shared before peer review, for example on arXiv. It may change before it is published."),
  "term.open-access": term("Open access", "A work anyone can read for free, legally. Find PDF looks for these copies."),
  "term.markdown": term("Markdown and Obsidian vault", "Markdown is plain text with light formatting. An Obsidian vault is a folder of such files."),
  "term.mirror": term("Mirror folder", "A Finder folder showing your PDFs by collection, using hard links so it takes no extra space."),
} satisfies Record<string, HelpEntry>;

export type HelpId = keyof typeof HELP;
type IdOf<K extends HelpEntry["kind"]> = { [Id in HelpId]: (typeof HELP)[Id] extends { kind: K } ? Id : never }[HelpId];
export type HintId = IdOf<"hint">;
export type ExplainId = IdOf<"explain">;
export type EmptyId = IdOf<"empty">;
export type TipId = IdOf<"tip">;
export type TermId = IdOf<"term">;

/** The entry for an id, typed by its kind. */
export const help = <Id extends HelpId>(id: Id) => HELP[id] as (typeof HELP)[Id];
/** A hint's sentence, for places that take a string (a row's detail, a title). */
export const hintText = (id: HintId) => (HELP[id] as HintEntry).text;

/** Length budgets, so explanations stay explanations (help-content.test.ts). */
export const BUDGET = { hint: 140, title: 48, sentence: 420, explain: 900, steps: 5, step: 130, empty: 140, tip: 150, term: 160 };
