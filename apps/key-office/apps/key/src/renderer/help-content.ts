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
  "settings.web.signin": explain(
    "Passkeys and sign-ins",
    [
      "A passkey replaces a password: your phone, your Mac or a security key proves it is you, with your fingerprint, face or PIN. Many universities now ask for one when you sign in.",
      "Key’s browser can use a USB or NFC security key. It can’t show the QR code for signing in with your phone, or reach passkeys saved in iCloud Keychain or a password manager: macOS offers those only to web browsers Apple has approved. A signed copy of Key can also keep passkeys on this Mac, with Touch ID.",
      "When a sign-in waits for a passkey, the bar says so. Continue in your browser opens the page there; once you are signed in, Bring sign-in over copies the cookies of just the sites that sign-in went through. Key lists them and asks first.",
    ],
    { privacy: "Only the cookies of the listed sites are read, from a copy of your browser’s cookie file. Nothing is sent anywhere, and nothing in your browser changes." },
  ),
  "settings.web.signin-browser": hint("Where Continue in your browser opens the sign-in, and whose cookies Bring sign-in over reads."),
  "browser.signin.waiting": hint("This page asked for a passkey. Touch your security key if you use one, or continue in your browser."),
  "browser.signin.handoff": hint("Sign in there as usual. Then bring the sign-in over: Key shows which sites’ cookies it copies first."),

  // ── Settings: Database connectors ───────────────────────────────────────────────────
  "settings.services.connectors": explain(
    "Database connectors",
    [
      "A connector tells Key how to search one database, such as PubMed or EconStor. Key ships with a set of them and can download newer versions when a database changes how it answers.",
      "Updates are not signed yet. Key still checks every downloaded file against the update’s list and never installs an older update, but it cannot prove who published it. Signing comes later; nothing changes for you then.",
    ],
    { privacy: "Checking for updates downloads a small list from Key’s update address. Your searches are not sent." },
  ),
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
  "settings.services.ncbi": explain(
    "A PubMed (NCBI) key",
    ["PubMed is free and works without a key. A free NCBI key lets Key send 10 requests a second instead of 3, so large PubMed searches finish sooner."],
    {
      steps: ["Sign in at ncbi.nlm.nih.gov (a free NCBI account, or your institution's login).", "Open Account settings and find API Key Management.", "Create a key, paste it here and press Save."],
      links: [{ label: "Get a key at ncbi.nlm.nih.gov", url: "https://account.ncbi.nlm.nih.gov/settings/" }],
    },
  ),
  "settings.services.elsevier": explain(
    "A Scopus key",
    [
      "Scopus is Elsevier's subscription database. With a free Elsevier API key, Key can search it for you, but only if your institution subscribes to Scopus: from the institution's network, or anywhere with an institutional token.",
      "Each key may make 20,000 search requests a week. A large search with abstracts uses one request per 25 records.",
    ],
    {
      steps: ["Open dev.elsevier.com and sign in with your institutional e-mail address.", "Choose My API Key, then Create API Key, give it a label and accept the API terms.", "Copy the key, paste it here and press Save. Testing it uses one request."],
      links: [{ label: "Get a key at dev.elsevier.com", url: "https://dev.elsevier.com/apikey/manage" }],
      privacy: "Your search goes to Elsevier with your key.",
    },
  ),
  "settings.services.elsevier-insttoken": explain(
    "A Scopus institutional token",
    ["An institutional token lets your Scopus key work outside your institution's network. Only your library can request one from Elsevier, and it must be kept private. You do not need it on campus."],
    {
      steps: ["Ask your library whether they can give you an Elsevier institutional token for API use.", "Paste it here and press Save. Key sends it with your Scopus key on the next search."],
      links: [{ label: "Elsevier API support", url: "https://dev.elsevier.com/support.html" }],
    },
  ),
  "settings.services.clarivate-wos": explain(
    "A Web of Science key",
    [
      "Key searches Web of Science through Clarivate's Web of Science Starter API. It returns titles, authors, journals and DOIs, but no abstracts.",
      "The free trial plan allows 50 requests a day (about 2,500 records). If your institution subscribes to Web of Science, choose the institutional plan for 5,000 a day.",
    ],
    {
      steps: ["Open developer.clarivate.com and create an account.", "Open Web of Science Starter API and subscribe to a plan.", "Register an application, copy its API key, paste it here and press Save. Testing it uses one request."],
      links: [{ label: "Get a key at developer.clarivate.com", url: "https://developer.clarivate.com/apis/wos-starter" }],
      privacy: "Your search goes to Clarivate with your key.",
    },
  ),
  "settings.services.clarivate-wos-expanded": explain(
    "A Web of Science Expanded key",
    ["The Expanded API returns full Web of Science records with abstracts. Clarivate issues its keys to institutions with an API licence, so ask your library or research office; a Starter key does not work here."],
    {
      steps: ["Ask your library whether your institution licenses the Web of Science Expanded API.", "Paste the key they give you here and press Save."],
      links: [{ label: "About the Expanded API", url: "https://developer.clarivate.com/apis/wos" }],
      privacy: "Your search goes to Clarivate with your key.",
    },
  ),

  // ── Settings: Web search engines (WebSearchSettings.tsx) and their keys ────────────
  "settings.web.engines-intro": hint("Optional search engines for the whole web, beyond scholarly catalogues. Each needs its own key, and none is on until you turn it on."),
  "settings.web.engines": explain(
    "Web search engines",
    [
      "Scholarly catalogues find papers. A web search engine finds everything else too: reports, policy documents, news, blog posts and project pages. Key can use engines such as Tavily, Firecrawl, Exa or Brave Search with a key from each.",
      "Key asks one engine at a time, in the order shown. If it fails or its key runs out of credits, the next one that is on is asked, unless you choose Stop. In a search you can pick another engine for that search.",
      "An engine that cannot apply a filter you set, such as a language, is passed over for one that can.",
    ],
    { privacy: "Your search words go only to the engines you turn on here, and only when you search the web. Turning an engine off stops every request to it." },
  ),
  "settings.services.tavily": explain(
    "A Tavily key",
    ["Tavily is a search engine built for research and AI tools. It searches the whole web and answers with the most relevant pages. It has a free monthly allowance; larger plans cost money. Each basic search uses one credit."],
    {
      steps: ["Open tavily.com and sign up (an e-mail address is enough).", "Your key is shown on the dashboard's home page; copy it.", "Paste it here and press Save. Testing it reads your usage and runs no search.", "Turn Tavily on under Web & browser › Web search engines."],
      links: [
        { label: "Get a key at tavily.com", url: "https://app.tavily.com/home" },
        { label: "Tavily pricing", url: "https://www.tavily.com/pricing" },
      ],
      privacy: "Your search words go to Tavily with your key, only while Tavily is on.",
    },
  ),
  "settings.services.firecrawl": explain(
    "A Firecrawl key",
    [
      "Firecrawl searches the web and can read a web page as clean text. Key uses the second to save a page into your library when its own browser cannot open it, or when you choose Firecrawl for it.",
      "It has a free allowance of credits; more costs money. A search or a saved page uses credits.",
    ],
    {
      steps: ["Open firecrawl.dev and sign up.", "Open API Keys in your dashboard and copy the key.", "Paste it here and press Save. Testing it reads your credits and runs no search.", "Turn Firecrawl on under Web & browser › Web search engines."],
      links: [
        { label: "Get a key at firecrawl.dev", url: "https://www.firecrawl.dev/app/api-keys" },
        { label: "Firecrawl pricing", url: "https://www.firecrawl.dev/pricing" },
      ],
      privacy: "Your search words, or the address of a page you save, go to Firecrawl with your key.",
    },
  ),
  "settings.services.exa": explain(
    "An Exa key",
    ["Exa finds pages by what they mean rather than by matching words, and can keep to scholarly publications. New accounts get some free credit; after that it is paid per search."],
    {
      steps: ["Open exa.ai and sign up.", "Open API Keys in the dashboard and create a key.", "Paste it here and press Save. Testing it runs one small search, which uses a little credit.", "Turn Exa on under Web & browser › Web search engines."],
      links: [
        { label: "Get a key at exa.ai", url: "https://dashboard.exa.ai/api-keys" },
        { label: "Exa pricing", url: "https://exa.ai/pricing" },
      ],
      privacy: "Your search words go to Exa with your key, only while Exa is on.",
    },
  ),
  "settings.services.brave": explain(
    "A Brave Search key",
    ["The Brave Search API searches Brave's own index of the web, independent of Google and Bing. Brave offers a plan with a small free allowance; you choose a plan when you create the key."],
    {
      steps: ["Open the Brave Search API dashboard and sign up.", "Choose a plan (a card may be asked for, even for the free one).", "Open API Keys, copy the key, paste it here and press Save. Testing it runs one search."],
      links: [
        { label: "Get a key at brave.com", url: "https://api-dashboard.search.brave.com/app/keys" },
        { label: "Brave Search API plans", url: "https://brave.com/search/api/" },
      ],
      privacy: "Your search words go to Brave with your key, only while Brave Search is on.",
    },
  ),
  "settings.services.perplexity": explain(
    "A Perplexity key",
    ["Perplexity's Search API answers with ranked web pages, not a written answer. It is paid per request from credit you add to your API account."],
    {
      steps: ["Open perplexity.ai, sign in and open API in your account settings.", "Add credit and create an API key.", "Paste it here and press Save. Testing it runs one search."],
      links: [
        { label: "Get a key at perplexity.ai", url: "https://www.perplexity.ai/account/api/keys" },
        { label: "Perplexity pricing", url: "https://docs.perplexity.ai/getting-started/pricing" },
      ],
      privacy: "Your search words go to Perplexity with your key, only while it is on.",
    },
  ),
  "settings.services.you": explain(
    "A You.com key",
    ["You.com's Search API answers with web pages from its own index. New accounts usually get some free credit; after that it is paid."],
    {
      steps: ["Open you.com/platform and sign up.", "Create an API key and copy it.", "Paste it here and press Save. Testing it runs one search."],
      links: [
        { label: "Get a key at you.com", url: "https://you.com/platform" },
        { label: "You.com billing", url: "https://you.com/docs/administration/billing" },
      ],
      privacy: "Your search words go to You.com with your key, only while it is on.",
    },
  ),
  "settings.services.jina": explain(
    "A Jina key",
    ["Jina Search finds pages on the web, and Jina Reader turns a page into clean text, which Key can use to save a page it cannot open itself. A new key comes with free tokens; a search uses far more of them than reading a page."],
    {
      steps: ["Open jina.ai; a key with free tokens is shown on the Reader page.", "Copy it, paste it here and press Save. Testing it reads one small page, a few tokens.", "Turn Jina on under Web & browser › Web search engines."],
      links: [
        { label: "Get a key at jina.ai", url: "https://jina.ai/api-dashboard/key-manager" },
        { label: "Jina pricing", url: "https://jina.ai/reader/#pricing" },
      ],
      privacy: "Your search words, or the address of a page you save, go to Jina with your key.",
    },
  ),

  // ── Settings: AI ─────────────────────────────────────────────────────────────────────
  "settings.ai.intro": hint("Three steps: choose a provider, connect it, pick a model. Key uses it only for tasks you start, such as Fill with AI."),
  "settings.ai.provider": explain(
    "AI assistant",
    [
      "Some tasks, like filling a property from each source’s abstract or drafting a formula from a sentence, can use a large language model. You choose which one: a local app such as Ollama or LM Studio that runs on this Mac, or a hosted service you have an account with.",
      "Nothing is sent until you start such a task, and then only the passages that task needs. A fill recipe shows exactly which parts of each source it sends before it runs.",
    ],
    { privacy: "With a local model nothing leaves this Mac. With a hosted one, the passages go to that provider." },
  ),
  "settings.ai.choose": explain(
    "Which provider?",
    [
      "Hosted providers (Anthropic, OpenAI, Google and others) are fast and careful, and charge a few cents per hundred sources. You need an account and an API key.",
      "Ollama and LM Studio run a model on this Mac: free and private, but slower and less careful with long papers. Other connects any service that speaks the OpenAI chat format.",
    ],
  ),
  "settings.ai.key": explain(
    "An API key",
    ["An API key is a long password that lets Key use your account with the provider. The provider bills that account for what Key asks; nobody else can use the key."],
    {
      steps: ["Choose Get a key and sign in at the provider.", "Create a key and copy it.", "Paste it here and choose Save. Key tests it straight away."],
      privacy: "The key stays in your Keychain (or encrypted in Key’s data folder) and is sent only to that provider.",
    },
  ),
  "settings.ai.local": explain(
    "A model on this Mac",
    ["Ollama and LM Studio are free apps that download a model and run it on this Mac. Key talks to them at a local address, so the text never leaves the computer."],
    {
      steps: ["Install the app and download a model in it.", "Start it (LM Studio: start the server in its Developer tab).", "Choose Test here: Key lists the models it finds."],
      example: "Ollama answers on http://localhost:11434/v1",
    },
  ),
  "settings.ai.model": explain(
    "Choosing a model",
    [
      "Smaller models are faster and cheaper and do well at short answers: a label, a number, yes or no. Larger ones are more careful with long methods sections and subtle classifications.",
      "You can test a recipe on three sources before a full run, so it is easy to try the cheaper model first.",
    ],
  ),
  "settings.ai.privacy": explain(
    "What the AI assistant sends",
    [
      "Only what a task you start needs. For a fill recipe that is, per source, the parts you chose: metadata, abstract, the beginning of the PDF’s text or named sections, your notes or highlights. For a drafted formula, your description and the names of your properties.",
      "Key never sends your whole library in the background, and never sends files.",
    ],
    { privacy: "Hosted providers receive the text under their own terms; a local model keeps it on this Mac." },
  ),

  // ── Formulas ─────────────────────────────────────────────────────────────────────────
  "formula.builder": explain(
    "Formula properties",
    [
      "A formula works out a value for every source from its fields and properties: a short citation, the days since you added it, whether it has a PDF, a priority score. It stays up to date as the library changes, and you can sort, filter and group by it.",
      "Start from a template or a building block, then change any part with its menu. Text shows the same formula as you would type it.",
    ],
    { example: 'if({Has PDF}, "Ready", "Find PDF")' },
  ),
  "formula.describe": explain(
    "Drafting a formula from words",
    ["Describe what you want, and the AI assistant drafts a formula from Key’s list of functions and your property names. Check the preview before you use it; you can still change every part."],
    { privacy: "Your description and the names of your properties go to the AI provider you chose. No source content is sent." },
  ),
  "formula.text": hint("Type { for fields and properties, or a few letters for functions. Errors point to the exact spot."),

  // ── Fill recipes ─────────────────────────────────────────────────────────────────────
  "fill.intro": hint("Fill a property on many sources at once, from an AI model or a rule. You review every value before it is saved."),
  "fill.what": explain(
    "What to fill",
    [
      "Pick a starter recipe, such as a one-sentence summary or the study design, or describe your own in a sentence. The answer goes into a property: an existing one, or a new one Key creates for the recipe.",
      "Rules fill without AI: a formula, or a pattern that finds text such as “n = 120” in the abstract.",
    ],
  ),
  "fill.source": explain(
    "Where the answer comes from",
    [
      "Choose what the model reads for each source: its metadata, the abstract, the beginning of the PDF’s text, named sections such as Methods (found when the PDF was indexed), your notes or your highlights.",
      "Less text is faster and cheaper; sections are the best way to point the model at the right part of a paper.",
    ],
    { privacy: "Only the parts you tick are sent, to the provider in Key Settings › AI assistant. With a local model nothing leaves this Mac." },
  ),
  "fill.shape": explain(
    "The shape of the answer",
    ["The answer is checked before it becomes a proposal: a number must be a number, a choice must be one of your options, a date a real date. Answers that do not fit are listed as failed instead of guessed."],
  ),
  "fill.test": explain(
    "Test before running",
    ["The test runs the recipe on three sources and shows each answer next to the passages it came from. Adjust the instruction until the answers are right, then run it on the selection, a collection or the whole library."],
  ),
  "fill.review": explain(
    "Reviewing proposals",
    [
      "Nothing is saved until you accept it. Accept all, or go through the list: accept, edit or reject each value. Quotes marked as found appear in the source; the others could not be checked.",
      "Values you typed yourself are never proposed over. Accepted values form one change you can undo, and Undo run takes back everything a run saved.",
    ],
  ),
  "fill.auto": explain(
    "Keep filled automatically",
    ["With this on, the recipe also runs on sources you add from now on, and saves answers straight into empty cells. They are marked as filled by the recipe and can be undone like any run."],
  ),
  "fill.recipes": explain(
    "Saved recipes",
    ["A recipe remembers what to fill, from where and how. Copy it as text to share it or to use it in another workspace, and paste one to import it."],
  ),
  "fill.onchange": explain(
    "When a source changes",
    [
      "Key remembers what each answer was worked out from: the recipe, the model and the exact text it read. When that text changes (you edit the abstract, the PDF is read again, a note is added) or you change the recipe, the answer may no longer fit.",
      "Choose to do nothing, to mark such answers as out of date with a small clock so you can fill them again when you like, or to fill them again automatically in the background, within a daily limit. Changes the recipe does not read mark nothing, and values you edited yourself are never replaced.",
    ],
    { privacy: "Filling again sends the same parts of the source as the first fill, to the same provider." },
  ),
  "fill.cell": explain(
    "Your value and the AI answer",
    [
      "When you change a value the AI filled in, Key keeps both: your value is what the library shows, exports and cites; the AI's answer stays beside it with the passages it came from, so you can compare them later.",
      "Use AI answer again puts the AI's answer back (undoable). Keep mine leaves your value and clears the out-of-date mark. Earlier answers show what the recipe said before it was filled again.",
    ],
  ),
  "fill.cost": explain(
    "Tokens and cost",
    ["Models count text in tokens, roughly four characters each. The estimate adds up the text a run would send and the answers it expects, priced at the provider’s list price. Local models cost nothing."],
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
  "model.sources": explain(
    "Where models come from",
    [
      "Key keeps a copy of every model in its own repositories on Hugging Face, pinned to one version, and checks each file against its published checksum.",
      "If Key’s copy cannot be reached, Key can fetch the same file from the publisher of the original model instead. It must match the same checksum, so it is the same file.",
      "Turn this on to use Key’s repositories only, for example where your institution allows only known sources. Each model shows where it came from.",
    ],
  ),
  "markdown.removed": explain(
    "Files you deleted",
    [
      "When you delete one of Key’s Markdown files from the export folder, Key takes that as your choice and does not write it again, even when you export everything.",
      "Moving or renaming a file inside the folder is not deleting it: Key finds it and keeps writing there.",
      "Restore brings a file back with the next export, with your notes from Key in it.",
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
  "feeds.kinds": explain(
    "Kinds of alerts",
    [
      "Journals, people and topics: new works, found in OpenAlex, a free catalogue of scholarly works. Search alerts: new results for words, in OpenAlex or PubMed. Citation alerts: new works that cite your sources.",
      "Feeds and listings: a journal’s own table of contents, an arXiv listing or a blog, read from the site itself.",
      "Search for any of them above, or press Follow on a person’s, journal’s or topic’s page.",
    ],
  ),
  "feeds.interval": hint("How often Key checks, while it is open. Once a day suits most journals."),
  "feeds.intro": hint("New articles from journals, people, topics and searches you follow arrive in your Inbox."),
  "feeds.follow-search": hint("Type a journal’s name, a person, a topic or any words. You can also paste a journal’s or blog’s web address."),
  "feeds.from-library": explain("Suggestions from your library", ["These are the journals, people and topics your library has the most sources from. Choose one to see what following it would bring."]),
  "feeds.journal-feed": hint("This journal publishes its own table of contents. It often lists new articles a few days before OpenAlex does."),
  "feeds.preview-empty": hint("Nothing new in the last year. Following it still works: new items will arrive when there are some."),
  "feeds.auto-collection": hint("New items also go into this collection on their own, as well as the Inbox. Off unless you choose one."),
  "feeds.citing": hint("New works that cite sources in a collection, or anywhere in your library."),
  "feeds.arxiv": hint("arXiv shares new preprints in each subject every weekday."),
  "feeds.opml": hint("Bring over the journals and blogs you follow in Feedly, NetNewsWire or another reader."),
  "feeds.when": hint("Key checks only while it is open, not while the Mac is offline or saving power. Nothing goes into your library unless you add it."),
  "feeds.problem.limited": hint("The site asked Key to slow down. Key waits and tries again on its own; nothing to do."),
  "feeds.problem.unreachable": hint("Key could not reach the site. Check that you are online; Key tries again later on its own."),
  "feeds.problem.gone": hint("The site no longer offers this feed. Remove it, and search for the journal by name to follow it again."),
  "feeds.problem.blocked": hint("The site refused Key. Some publishers block feed readers; follow the journal by name instead."),
  "feeds.problem.not-a-feed": hint("This address shows a web page, not a feed. Search for the journal by name, or paste its feed’s address."),
  "feeds.problem.nothing-to-follow": hint("There is nothing to look for yet, for example no sources with an OpenAlex record. Key tries again later."),
  "feeds.problem.other": hint("The last check failed. Try again; if it keeps failing, remove it and follow it again."),
  "inbox.saved-by-you": hint("Works you saved from a search, a reference list or a page wait here until you add them to the library or dismiss them."),
  "feeds.opml-what": explain("OPML files", ["OPML is the file feed readers such as Feedly, NetNewsWire or Inoreader use to move a list of feeds. Export one from your old reader and import it here, or export Key’s list to use elsewhere."]),
  "feeds.keeping": hint("Old Inbox items are cleared after this long. Items you saved or added to the library always stay."),
  "inbox.triage": explain(
    "Going through the Inbox",
    [
      "Each item is a new work from something you follow, or one you saved yourself with Add to Inbox. Add puts it in your library, Save keeps it here for later, and Dismiss removes it and it will not come back from the same feed.",
      "Select several with x or ⇧-click to act on them at once. You can do it all from the keyboard.",
    ],
    { steps: ["j or ↓ next, k or ↑ previous", "a add to library, s save, e dismiss", "u read or unread, o open its page beside the Inbox", "x select, then a, s, e or u act on every selected item"] },
  ),
  "empty.inbox": empty(
    "Nothing followed yet",
    "The Inbox collects new articles from journals, authors, topics and searches you follow.",
    "Follow a journal, person or topic by name, or choose Add to Inbox on a search result or reference to keep it for later.",
  ),
  "empty.inbox-caught-up": empty("All caught up", "You have gone through every new item.", "New items appear here when your feeds and alerts bring them."),
  "empty.inbox-saved": empty("Nothing saved", "Works you save from searches and reference lists, and items you keep, collect here.", "Press s on an item, or Add to Inbox on a search result or reference."),
  "empty.inbox-none": empty("No items yet", "Items your feeds and alerts bring in collect here.", "Press Check now, or wait for the next check while Key is open."),
  "empty.feeds": empty("Not following anything", "Journals, people, topics and searches you follow are listed here.", "Search above for a journal, a person or a topic to follow."),
  "empty.follow-results": empty("Nothing found", "No journal, person or topic matches these words.", "Try fewer words, or follow them as a search alert below."),

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

  "search.filters": explain(
    "Typing filters",
    [
      "Any field can be typed as a filter: the field's name, a colon and a value. Your own properties work by their name; put names with spaces in quotes.",
      "Compare with > and <, give a range with two dots, leave out matches with a minus, and join choices with |. Empty and any find blank or filled fields.",
      "Key shows what it read as a chip. Nothing applies until you pick it, and words it does not know stay text.",
    ],
    { example: "rating>3 added:last-week\n-tag:draft year:2015..2020\n\"reading status\":done has:pdf" },
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

  // ── Database search ─────────────────────────────────────────────────────────────────
  "dbsearch.intro": hint("Search PubMed, Scopus, OpenAlex and other databases at once, with one query built from blocks."),
  "dbsearch.concepts": explain(
    "Building a search",
    [
      "Split your question into its main ideas, such as who (teenagers), what (mindfulness) and the outcome (anxiety). Each idea is a card: list every word authors use for it. A work needs one of them (OR), and must match every card (AND).",
      "The word between two items is a button: click it to choose AND (both), OR (either) or NOT (leave out). Groups can sit inside groups, like brackets: (health OR doctor) AND ((AI OR machine learning) NOT regression).",
      "The count on a card is what it finds alone. The narrowest card limits the search most: add synonyms there.",
    ],
    { example: "(teenager* OR adolescen*) AND (mindfulness OR meditation) NOT protocol", steps: ["Type a word and press Return or a comma", "Click AND / OR / NOT to change it", "⌘-click items, then Group, to bracket them", "Drag terms and groups between groups", "Text shows the same search as a line you can type"] },
  ),
  "dbsearch.term": explain(
    "Phrase, endings and fields",
    [
      "Phrase finds the words together and in order (“social capital”); All words finds them anywhere in the field.",
      "Any ending, written child*, also finds child, children and childhood. This is called truncation. Use it on the word stem, not on very short words.",
      "Search in decides where the words must appear. Title and abstract is the usual choice. Subject headings are labels indexers give each article, such as MeSH in PubMed: they find works whatever words the authors used.",
      "Near finds a phrase's words a few words apart (“school … attendance”), where the database supports it.",
    ],
  ),
  "dbsearch.exclude": explain("Leaving works out", ["Works that match any term here are removed from every database's results, for example protocols or animal studies.", "Use it sparingly: a word in an abstract can remove a relevant study."]),
  "dbsearch.translation": explain(
    "How each database runs the query",
    [
      "Each database has its own way of writing a search. Key writes your blocks in each one's syntax, shown here so you can check it, copy it into a protocol, or edit it by hand (marked Customised).",
      "Counts differ between databases because each covers different journals, and some search abstracts or subject headings that others lack. A warning says when a database cannot do something you asked, and what Key does instead.",
      "Counts are estimates asked a moment after you stop typing.",
    ],
  ),
  "dbsearch.databases": explain(
    "Choosing databases",
    [
      "A systematic search uses several databases, because none covers everything: PubMed for medicine, Scopus or Web of Science across fields, working-paper series for economics.",
      "Scopus and Web of Science need an API key from your institution, added in Key Settings › Services & API keys. Manual databases have no API: Key writes the query and opens their search page for you.",
      "Save a set you use often, and make it this library's default.",
    ],
  ),
  "dbsearch.progress": explain("While a search runs", ["Key asks each database in turn, a page at a time. Some limit how often they may be asked, so Key pauses between requests: this is normal and keeps your access working.", "Works found by more than one database are merged, so you screen each work once. Stop keeps what has arrived; Resume carries on."]),
  "dbsearch.provenance": explain("Where it was found", ["Each database that returned this work, with its id there, its position in that database's results and when it was fetched. This is the record a systematic review keeps."]),
  "dbsearch.report": explain(
    "The search report",
    [
      "A systematic review reports every database searched, the date, the exact query and how many records each gave. The PRISMA flow diagram starts from these numbers, and duplicates removed is its next box.",
      "Export it as Markdown for your methods section, CSV for a spreadsheet of the works, or JSON for the full log.",
    ],
  ),
  "dbsearch.saved": explain("Saved searches", ["A saved search keeps the query and databases. Run it again later to see what is new since the last run, for example before you submit a review."]),
  "dbsearch.sample": hint("Showing sample data: this build's library has no database search engine yet. Counts and works are made up."),
  "dbsearch.syntax": explain(
    "Writing a search as text",
    [
      "AND needs both words, OR either, NOT leaves out what follows. Brackets group: (health OR doctor) AND (AI OR ML). Without brackets AND goes first, so add them when you mix the two.",
      "Quotes keep words together: \"machine learning\". A star finds every ending: nurs* finds nurse, nurses, nursing. Words written side by side must all appear.",
      "Say where to look with a tag before a word or bracket: title:, abstract:, tiab: (title or abstract), keywords:, mesh: (subject headings), author:, journal:, year:2015-2024, type:review, lang:en.",
    ],
    { example: "tiab:(\"vaccine hesitancy\" OR vaccin*) AND (nurse* OR doctor*) NOT title:protocol" },
  ),
  "dbsearch.strategy": explain(
    "The search strategy",
    [
      "Reviews report the exact search run in each database, with the date and how many records it gave. This is that record, ready for a methods section or a PRISMA appendix.",
      "Some databases cannot run every search: no OR, no brackets, one word at a time. Key then sends several simpler queries, combines what they return and keeps only the works that match the whole search. The strategy lists those queries in order and says how the result was put together.",
      "Approximate means Key could not check a part, for example words in abstracts a database does not return. The JSON file can be imported to run the same search again.",
    ],
  ),
  "empty.dbsearch-saved": empty("No saved searches", "Saved searches keep a query and its databases, to run again later.", "Build a query and choose Save search."),
  "empty.dbsearch-results": empty("No search run yet", "Results of a database search show here, without duplicates.", "Build a query, choose databases and press Search."),

  // ── First-use tips ──────────────────────────────────────────────────────────────────
  "tip.cite": tip("Cite what you select", "Cite copies the passage as a quote with its source and page, ready to paste into a note or a document."),
  "tip.citation-hover": tip("Look up a citation", "In the PDF, point at a citation like [12] or (Smith, 2020) to see the work it names, and add it to your library."),
  "tip.note-cite": tip("Cite in notes", "Type @ in a note and start typing a title or author to cite a source from your library."),
  "tip.split-tabs": tip("Read side by side", "Drag a tab to the left or right edge of the window to show two things side by side."),
  "tip.map-legend": tip("Filter the map", "Click a kind in the legend, such as People or Topics, to show only that kind. Click it again to show all."),
  "tip.inbox-keys": tip("Triage with the keyboard", "Press j and k to move, a to add, s to save and e to dismiss. x selects several."),
  "tip.tag-suggestions": tip("Tidy your tags", "Key suggests merging duplicates and nesting related tags. Nothing changes until you apply one."),
  "tip.find-pdf": tip("Find the PDF", "Find PDF looks for a free legal copy, and opens the publisher’s page through your library if there is none."),
  "tip.passkey": tip("Passkeys in Key’s browser", "Key’s browser can use a security key, but not your phone or saved passkeys. Continue in your browser to use those."),
  "tip.proxies": tip("Library access", "This site can open through your library’s proxy, so you see articles your library pays for."),
  "tip.reading-mode": tip("Read as text", "Reading mode shows this PDF as clean text in your font and size. Highlights you make there are kept on the PDF."),

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
  "term.passkey": term("Passkey", "A sign-in without a password: your phone, Mac or security key proves it is you with your fingerprint, face or PIN."),
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
  "term.boolean": term("Boolean search", "Combining terms with AND (all must match), OR (any may match) and NOT (leave out). The query builder writes these for you."),
  "term.truncation": term("Truncation", "An asterisk at the end of a word stem, child*, finds every ending: child, children, childhood."),
  "term.mesh": term("MeSH", "Medical Subject Headings: the labels PubMed's indexers give each article, so a search finds it whatever words its authors used."),
  "term.grey-literature": term("Grey literature", "Reports, working papers, theses and registrations published outside journals. Reviews search it to avoid publication bias."),
  "term.mirror": term("Mirror folder", "A Finder folder showing your PDFs by collection, using hard links so it takes no extra space."),

  // ── Workspaces window and the notes list ───────────────────────────────────────────────
  "launcher.workspaces": explain(
    "What is a workspace?",
    [
      "A workspace is one folder on this Mac that holds a library: its sources and their files, notes, highlights, collections and search index. Each workspace opens in its own window and knows nothing of the others.",
      "Use one for everything, or one per project, course or team. This list is only Key’s list of the workspaces it knows about; the folders themselves live wherever you put them.",
    ],
    { steps: ["Double-click a workspace, or press Return, to open it.", "Press ⌘Return to open it in a new window.", "Right-click a workspace to rename it, change its look, show it in Finder, move it or remove it from this list."] },
  ),
  "launcher.remove": explain(
    "What does Remove from list do?",
    [
      "It takes the workspace off this list and nothing else. Its folder, with every source, file, note and highlight in it, stays on this Mac exactly as it is.",
      "To use it again, choose Open folder as workspace and pick the folder. To delete a workspace for good, remove it from the list, then move its folder to the Bin in Finder.",
    ],
  ),
  "launcher.move": explain(
    "Moving a workspace",
    [
      "Move… moves the workspace’s whole folder to another place on this Mac, for example to a synced or external drive, and Key follows it there. Close the workspace’s window first.",
      "If you moved or renamed the folder in Finder yourself, the workspace shows as missing: choose Locate… and pick the folder where it is now.",
    ],
  ),
  "launcher.opening": hint("What Key shows when you start it. Workspaces you open later always open in their own windows."),
  "settings.indexing.battery": explain(
    "Indexing on battery",
    [
      "Indexing reads every source once so search can find it. It is the heaviest work Key does, and on a laptop it uses battery.",
      "By default Key waits while the battery is below 30% or Low Power Mode is on, and carries on once the Mac is plugged in. A source you open, select or scroll to is always indexed straight away, and search keeps working on what is already indexed.",
      "While it waits, the status bar says Indexing paused on battery; click it and choose Continue anyway to index now, until the Mac is plugged in again.",
    ],
  ),
  "empty.notes-list": empty("No notes yet", "Notes, canvases and pages you write in this workspace are listed here, in folders you arrange.", "Create one with New note, or link a folder of Markdown files with +."),
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
