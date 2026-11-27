// Records the README screenshots from the real app: a demo library built from invented data
// (scripts/screenshot-demo.cjs), recorded OpenAlex answers, a local mock of the web services
// and of a journal site (every *.example host resolves to it), and no other network. Each
// scene is captured at 1440×860 points (2× on a Retina Mac) with the reader and browser views
// composited in, reduced to 256 dithered colours with ImageMagick when it is installed, and
// written to assets/readme/ (or --out). The library and the reader are also taken in dark mode.
// Dates in the app ("Today", "Saved 26 Nov") are the day of the run. Database search uses the
// sample engine and Fill with AI a mock provider on the same local server. Before each capture
// the pointer moves to the empty end of the tab strip, so no hover card or tint is left over.
// A scene that fails or writes nothing is listed at the end and the run exits non-zero: an old
// image is never kept silently. Run after `npm run build -w @key/electron`, with
// KEY_HOST_EXECUTABLE set as for the smokes (and KEY_MODEL_DIR for reading mode):
//
//   node scripts/record-screenshots.cjs [--only=library,batch-edit] [--out=dir] [--keep]
//
// Scene names are the image names without "key-" (see SCENES); an unknown name is an error.
const { _electron: electron } = require("playwright-core");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { tmpdir } = require("node:os");
const demo = require("./screenshot-demo.cjs");

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
// Every scene, named after its image (key-<name>.png, plus key-<name>-dark.png where taken).
const SCENES = [
  "library", "reader", "note", "search", "web-search", "relation-map", "browser", "web-page", "tags", "batch-edit",
  "inbox", "settings-citations", "zotero", "formula", "database-search", "reading-mode", "tab-switcher", "ai-fill", "review",
  "duplicates", "canvas",
];
const only = (arg("only") || "").split(",").filter(Boolean);
const unknown = only.filter((name) => !SCENES.includes(name));
if (unknown.length) {
  console.error(`Unknown scene(s): ${unknown.join(", ")}. Scenes: ${SCENES.join(", ")}`);
  process.exit(2);
}
const want = (name) => !only.length || only.includes(name);
const OUT = path.resolve(arg("out") || path.resolve(__dirname, "../../../../../assets/readme"));
const WIDTH = 1440;
// 860 rather than 900: with its title bar a taller window does not fit a 13" screen, and macOS
// would shrink it by a few points, differently from run to run.
const HEIGHT = 860;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await wait(150);
  }
}

// ── The mock web: services, a journal behind an EZproxy-style login, a feed, a blog ──

function serve(pdfs) {
  const { WORKS, CITED_ELSEWHERE, openalexWork, articleHtml, savedPageHtml, byN, VENUES, doi } = demo;
  const searchable = [...WORKS.filter((w) => w[0] !== 16), ...CITED_ELSEWHERE].map(openalexWork);
  const s2 = (w) => ({
    paperId: `s2demo${w.id.slice(-4)}`,
    externalIds: { DOI: w.doi.replace("https://doi.org/", "") },
    url: `https://www.semanticscholar.example/paper/${w.id.slice(-6)}`,
    title: w.display_name,
    abstract: null,
    venue: w.primary_location.source.display_name,
    year: w.publication_year,
    citationCount: w.cited_by_count,
    isOpenAccess: w.open_access.is_oa,
    openAccessPdf: null,
    authors: w.authorships.map((a, i) => ({ authorId: String(i), name: a.author.display_name })),
  });
  const matches = (q) => {
    const words = (q || "").toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    return searchable.filter((w) => words.some((t) => `${w.display_name} ${Object.keys(w.abstract_inverted_index ?? {}).join(" ")}`.toLowerCase().includes(t)));
  };
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:15px system-ui;padding:24px">${body}</body></html>`;
  const article = (n) => {
    const w = byN(n);
    if (!w) return null;
    return articleHtml({
      title: w[1],
      n,
      authors: w[3].map((a) => `${demo.PEOPLE[a][1]}, ${demo.PEOPLE[a][0]}`),
      date: `${w[2]}/05/14`,
      abstract: w.length === 8 ? w[7] : w[10],
      body: `<h2>1. Introduction</h2><p>A data set rarely dictates one analysis. Researchers choose which participants to exclude, which covariates to adjust for, how to code an outcome and which test to run. Each choice is defensible on its own, yet together they let the same data support quite different conclusions.</p><p>This article counts those choices in a sample of published studies and asks how much the reported results depend on them. We describe the sample, then the paths each analysis could have taken, and finally what the spread of results means for readers of a single study.</p><h2>2. Sample</h2><p>We drew 120 articles at random from four journals in 2012 and coded every analytic decision their methods sections reported.</p>`,
    });
  };
  const feedItem = (w, day) =>
    `<item><title>${w[1]}</title><link>http://${demo.ARTICLE_HOST}/articles/${w[0]}</link><description>${w[w.length - 1]}</description>${w[3].map((a) => `<dc:creator>${demo.name(a)}</dc:creator>`).join("")}<pubDate>${day} Nov 2026 08:00:00 +0000</pubDate><prism:doi>${doi(w[0])}</prism:doi></item>`;
  const FEED_NEW = [
    [93, "Effect size benchmarks for preregistered research", 2026, ["A11", "A3"], "S1", ["T1"], 0, "Typical effect sizes in preregistered studies, by subfield, as a guide for planning sample sizes."],
    [94, "Do open materials get reused? A citation analysis", 2026, ["A4", "A12"], "S1", ["T3"], 0, "Materials shared with 900 articles were downloaded often but cited rarely; we propose a simple way to credit reuse."],
    [95, "Plan specificity scores for preregistrations", 2026, ["A2", "A1"], "S1", ["T1"], 0, "A ten-item score for how specific a preregistration is, with agreement between raters and a validation on 300 plans."],
    [96, "Signed peer review and reviewer recruitment", 2026, ["A8"], "S1", ["T4"], 0, "Journals that moved to signed reviews needed slightly more invitations per review, mostly among early-career reviewers."],
  ];
  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const url = new URL(req.url, `http://${host || "mock"}`);
    const send = (body, type = "text/html; charset=utf-8", status = 200, headers = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    const json = (body, status = 200) => send(JSON.stringify(body), "application/json", status);
    // OpenAlex and Semantic Scholar (KEY_WEB_OPENALEX_URL / KEY_WEB_S2_URL point here).
    if (url.pathname === "/works") {
      const found = matches(url.searchParams.get("search") ?? url.searchParams.get("filter"));
      return json({ meta: { count: found.length, next_cursor: null }, results: found });
    }
    if (url.pathname === "/graph/v1/paper/search") return json({ total: matches(url.searchParams.get("query")).length, offset: 0, data: matches(url.searchParams.get("query")).map(s2) });
    // The feed of the journal.
    if (url.pathname === "/feed.xml")
      return send(
        `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/"><channel><title>${VENUES.S1}</title>${FEED_NEW.map((w, i) => feedItem(w, 25 - i)).join("")}</channel></rss>`,
        "application/rss+xml",
      );
    // The library's EZproxy: the login sends on to the proxied host.
    if (host === "login.ezproxy.northbridge.example") {
      const target = new URL(url.searchParams.get("qurl"));
      return send("", "text/plain", 302, { server: "EZproxy", location: `http://${target.hostname.replace(/-/g, "--").replace(/\./g, "-")}.ezproxy.northbridge.example${target.pathname}` });
    }
    if (host.endsWith(".ezproxy.northbridge.example") || host === demo.ARTICLE_HOST) {
      const proxied = host !== demo.ARTICLE_HOST;
      const headers = proxied ? { server: "EZproxy" } : {};
      if (url.pathname === "/") return send(page(VENUES.S1, `<h1>${VENUES.S1}</h1><link rel="alternate" type="application/rss+xml" href="/feed.xml">`), undefined, 200, headers);
      const a = url.pathname.match(/^\/articles\/(\d+)$/);
      if (a && article(Number(a[1]))) return send(article(Number(a[1])), undefined, 200, headers);
      const m = url.pathname.match(/^\/articles\/(\d+)\.pdf$/);
      if (m && pdfs[m[1]]) return send(pdfs[m[1]], "application/pdf", 200, headers);
    }
    if (host === "blog.methods-notebook.example" && url.pathname === "/vague-plans") return send(savedPageHtml());
    // A mock OpenAI-compatible provider for Fill with AI: the answer follows the abstract it
    // was sent, with a quote from it as evidence. No real provider is ever asked.
    if (url.pathname === "/v1/models") return json({ data: [{ id: "demo-small" }, { id: "demo-large" }] });
    if (url.pathname === "/v1/chat/completions") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || "{}");
      const prompt = parsed.messages?.find((m) => m.role === "user")?.content ?? "";
      const text = prompt.split("Source material:")[1] ?? prompt;
      const value = /survey/i.test(text)
        ? "Survey"
        : /simulat/i.test(text)
          ? "Simulation study"
          : /re-analys|analysis path/i.test(text)
            ? "Re-analysis of data"
            : /review of|projects/i.test(text)
              ? "Review"
              : "Other";
      const quote = (text.match(/\] Abstract\n([^\n]+)/)?.[1] ?? "").split(" ").slice(0, 7).join(" ");
      const answer = { value, confidence: 0.84, evidence: quote ? [{ passage: "P2", quote }] : [] };
      return json({ model: parsed.model, choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 410, completion_tokens: 28 } });
    }
    send(page("Not found", "<h1>Not found</h1>"), undefined, 404);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// ── Capture ──

/** The window as it looks: the shell plus every visible reader and browser view on top. */
// The sidebar is translucent (vibrancy): it is shown over a plain backdrop like the one macOS
// gives it over an empty desktop, so the image has no transparency.
const BACKDROP = { light: "rgb(226, 226, 230)", dark: "rgb(52, 52, 56)" };

async function capture(app, shell, scheme) {
  const layers = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.isVisible()) ?? BrowserWindow.getAllWindows()[0];
    const out = [];
    for (const v of w.contentView.children) {
      if (!v.getVisible?.() || !v.webContents || v.webContents === w.webContents) continue;
      const b = v.getBounds();
      if (b.width < 2 || b.height < 2) continue;
      let image;
      for (let i = 0; !image; i++) {
        try {
          image = await v.webContents.capturePage();
        } catch (e) {
          if (i >= 5) throw e;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      out.push({ ...b, image: image.toDataURL() });
    }
    return out;
  });
  const base = await shell.screenshot();
  const png = await shell.evaluate(
    async ({ base, layers, backdrop }) => {
      const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
      const first = await load(base);
      const scale = first.width / innerWidth;
      const canvas = document.createElement("canvas");
      canvas.width = first.width;
      canvas.height = first.height;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = backdrop;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(first, 0, 0);
      for (const l of layers) ctx.drawImage(await load(l.image), l.x * scale, l.y * scale, l.width * scale, l.height * scale);
      return canvas.toDataURL("image/png").split(",")[1];
    },
    { base: `data:image/png;base64,${base.toString("base64")}`, layers, backdrop: BACKDROP[scheme] },
  );
  return Buffer.from(png, "base64");
}

function optimise(file) {
  try {
    // 256 dithered colours: about a third of the size, with no visible banding in shadows.
    execFileSync("magick", [file, "-strip", "-colors", "256", "-define", "png:compression-level=9", `PNG8:${file}`]);
  } catch {
    // ImageMagick is optional: the PNG stays as captured.
  }
}

(async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "key-readme-shots-"));
  const fixtures = path.join(temp, "openalex");
  await mkdir(fixtures, { recursive: true });
  await mkdir(OUT, { recursive: true });
  for (const [file, body] of Object.entries(demo.openalexFixtures())) await writeFile(path.join(fixtures, file), JSON.stringify(body));
  const pdfs = {};
  const server = await serve(pdfs);
  const port = server.address().port;
  const mock = `http://127.0.0.1:${port}`;
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    args: [...(process.env.KEY_ELECTRON_EXECUTABLE ? [] : [path.resolve(__dirname, "..")]), `--host-resolver-rules=MAP *.example 127.0.0.1:${port}`],
    env: {
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_BROWSER_SMOKE: "1",
      KEY_NO_WINDOW_RESTORE: "1",
      KEY_USER_DATA: path.join(temp, "profile"),
      KEY_WORKSPACE_PARENT: path.join(temp, "workspaces"),
      KEY_OPENALEX_FIXTURES: fixtures,
      KEY_WEB_OPENALEX_URL: mock,
      KEY_WEB_S2_URL: mock,
      KEY_WEB_CROSSREF_URL: mock,
      KEY_WEB_UNPAYWALL_URL: mock,
      KEY_WEB_SERPAPI_URL: mock,
      KEY_FEEDS_ALLOW_LOOPBACK: "1",
      KEY_FEEDS_START_DELAY_MS: "500",
      KEY_FEEDS_TICK_MS: "1500",
      // Database search runs on the built-in sample engine (made-up counts and works).
      KEY_DB_SEARCH_MOCK: "1",
      // Anything not mocked fails instead of reaching the network.
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
    },
  });
  if (process.env.KEY_SMOKE_VERBOSE) app.process().stderr.on("data", (d) => process.stderr.write(`[main] ${d}`));
  const written = [];
  let shell;
  try {
    shell = await app.firstWindow();
    shell.setDefaultTimeout(30000);
    await shell.waitForFunction(() => window.key);
    await app.evaluate(({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(w, h);
      win.center();
    }, [WIDTH, HEIGHT]);
    await shell.getByRole("region", { name: "Home", exact: true }).waitFor();
    await until(async () => (await shell.evaluate(([w, h]) => innerWidth === w && innerHeight === h, [WIDTH, HEIGHT])) || null, `the window to be ${WIDTH}×${HEIGHT}`, 5000);
    const [ws] = await shell.evaluate(() => window.key.workspaces());
    const call = (command, args = {}) => shell.evaluate(({ command, args, id }) => window.key.invoke(command, args, id), { command, args, id: ws.id });
    const tabAction = (action, payload = {}) => shell.evaluate(({ action, payload }) => window.key.tabAction(action, payload), { action, payload });
    const pages = () => app.windows();
    let scheme = "light";
    const theme = async (next) => {
      scheme = next;
      await shell.evaluate((t) => window.key.setAppSettings({ theme: t }), next);
      for (const p of pages()) await p.emulateMedia({ colorScheme: next }).catch(() => {});
      await wait(450);
    };
    const shot = async (name, opts = {}) => {
      const file = path.join(OUT, `${name}.png`);
      // Toasts ("Saved to your library", "Following …") have their moment and go.
      await until(async () => !(await shell.locator(".kx-toast").count()), "toasts to go", 10000).catch(() => {});
      // Background work in the status bar ("Looking up references · 8 of 9") finishes first.
      const busy = /Looking up|Indexing|Analysing|Analyzing|Importing|Checking|Saving/;
      await until(async () => !busy.test((await shell.getByRole("contentinfo", { name: "Status" }).innerText().catch(() => "")) || ""), "background work to settle", 60000).catch(() => {});
      // The pointer rests on the empty end of the tab strip, so no row keeps a hover card or a
      // hover tint (the reader and browser views keep their own pointer).
      if (!opts.keepPointer) {
        await shell.mouse.move(WIDTH - 340, 8);
        await until(async () => !(await shell.locator(".kx-hover-card, .kx-peek-card, [data-hover-card]").count()), "hover cards to close", 3000).catch(() => {});
      }
      await wait(300);
      await writeFile(file, await capture(app, shell, scheme));
      optimise(file);
      written.push(file);
      console.log("wrote", path.relative(process.cwd(), file));
    };
    const closeAll = async () => {
      const t = await shell.evaluate(() => window.key.tabs());
      for (const tab of t.tabs) await tabAction("close", { tabId: tab.id }).catch(() => {});
      await wait(300);
    };

    // ── Seed ──
    const scholarlyDb = path.join(ws.root, ".key", "library.sqlite3");
    await until(async () => existsSync(scholarlyDb), "the workspace database");
    const now = Date.now();
    const rows = [...demo.WORKS.filter((w) => w[0] !== 16), ...demo.CITED_ELSEWHERE].map((w) => {
      const payload = JSON.stringify(demo.scholarly(w)).replace(/'/g, "''");
      return `INSERT OR REPLACE INTO scholarly_cache(key,payload,error,fetched_at,retry_after,expires_at,attempts,updated_at) VALUES ('doi:${demo.doi(w[0])}','${payload}',NULL,${now},0,${now + 3e11},0,${now});`;
    });
    await until(async () => {
      execFileSync("/usr/bin/sqlite3", ["-cmd", ".timeout 5000", scholarlyDb, `BEGIN; ${rows.join("\n")} COMMIT;`]);
      return true;
    }, "the lookup cache");

    // PDFs, rendered by the app from the demo's HTML.
    const render = (html) =>
      app.evaluate(async ({ BrowserWindow }, html) => {
        const w = new BrowserWindow({ show: false, width: 900, height: 1200 });
        await w.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
        const data = await w.webContents.printToPDF({ pageSize: "A4", printBackground: true, preferCSSPageSize: true, generateDocumentOutline: true });
        w.destroy();
        return data.toString("base64");
      }, html);
    const files = {};
    for (const n of [1, 3, 5, 12, 91]) {
      const bytes = Buffer.from(await render(n === 1 ? demo.mainPaperHtml() : demo.shortPaperHtml(n)), "base64");
      pdfs[n] = bytes;
      files[n] = path.join(temp, `${demo.byN(n)[1].split(":")[0].slice(0, 40)}.pdf`);
      await writeFile(files[n], bytes);
    }

    const thesis = await call("store_collection_create", { name: "Thesis", parentId: null });
    const chapter = await call("store_collection_create", { name: "Chapter 2: Preregistration", parentId: thesis.id });
    const reading = await call("store_collection_create", { name: "Reading group", parentId: null });
    const collectionIds = { thesis: thesis.id, ch2: chapter.id, reading: reading.id };
    const ids = {};
    const fieldsOf = (w) => {
      const [n, title, year, authors, venue, , tags, , collections] = w;
      const o = demo.openalexWork(w);
      return {
        itemType: "article",
        title,
        year,
        date: o.publication_date,
        containerTitle: demo.VENUES[venue],
        volume: o.biblio.volume,
        issue: o.biblio.issue,
        pages: `${o.biblio.first_page}–${o.biblio.last_page}`,
        ...(n === 16 ? {} : { doi: demo.doi(n) }),
        abstract: w[10] || undefined,
        tags,
        creators: authors.map((a) => ({ given: demo.PEOPLE[a][0], family: demo.PEOPLE[a][1], role: "author" })),
        collections: collections.map((c) => collectionIds[c]),
      };
    };
    // Oldest first, so "Added" reads naturally.
    for (const w of demo.WORKS) {
      const n = w[0];
      if (n === 16) continue; // the duplicate arrives in its own scene
      const fields = fieldsOf(w);
      if (files[n]) {
        const [created] = await shell.evaluate(({ id, files }) => window.key.importPaths(id, files), { id: ws.id, files: [files[n]] });
        const { tags, creators, collections, ...rest } = fields;
        await call("store_update", { id: created.id, patch: { ...rest, tags, creators, collections } });
        ids[n] = created.id;
      } else {
        ids[n] = (await call("store_create", { source: { kind: "reference", ...fields } })).id;
      }
    }
    await call("store_update", { id: ids[1], patch: { starred: true } }).catch(() => {});
    // Looked up (from the recorded answers) and indexed.
    await until(async () => {
      const states = await Promise.all(Object.entries(ids).filter(([n]) => n !== "16").map(([, id]) => call("store_source", { id }).then((s) => s.enrichStatus)));
      return states.every((s) => s === "done" || s === "failed");
    }, "the OpenAlex lookups", 120000);
    await until(async () => (await call("store_status")).counts.ready >= 4, "indexing", 180000);

    // Notes and a canvas, so the sidebar and the note scene have something to show.
    const cite = (n, text) => `[${text}](key://source/${ids[n]})`;
    const chapterNote = await call("store_note_save", {
      id: null,
      sourceId: null,
      title: "Chapter 2: what preregistration changes",
      body: [
        `Preregistered studies report effects about half as large as matched studies without a plan ${cite(1, "(Okafor et al., 2023)")}, and the gap depends on how specific the plan was.`,
        "",
        `\`\`\`quote source="${ids[1]}" page="1" color="yellow"`,
        "Preregistered studies reported a median effect of g = 0.24, against 0.48 for their matched counterparts.",
        "```",
        "",
        `This fits the size of analytic flexibility measured directly ${cite(3, "(Brenner & Raman, 2018)")} and the replication rates of multi-site projects ${cite(5, "(Okafor & Lund, 2021)")}. Specification curves make the same point visible in a single figure ${cite(12, "(Brenner et al., 2022)")}.`,
        "",
        "## Open questions",
        "",
        "- Do registered reports select easier questions, or only report more honestly?",
        `- How often are plans followed? Compare with sample size justifications ${cite(7, "(Tanaka & Petersen, 2020)")}.`,
        "",
        "```bibliography",
        "References",
        "```",
      ].join("\n"),
    });
    await call("store_note_save", { id: null, sourceId: null, title: "Reading group, 14 November", body: "Discussed open data badges and what happens to the data afterwards." });
    await call("store_note_save", { id: null, sourceId: null, title: "Methods checklist", body: "- [ ] Power analysis\n- [ ] Exclusion rules as code\n- [x] Primary outcome named" });
    const card = (n, x, y, face = "abstract") => ({ id: `n${n}`, type: "item", ref: { kind: "source", id: ids[n] }, title: demo.byN(n)[1], x, y, w: 300, h: 210, face });
    await call("store_canvas_save", {
      id: null,
      title: "Argument map: chapter 2",
      doc: {
        version: 1,
        nodes: [
          { id: "f1", type: "shape", shape: "frame", text: "Why effects shrink", color: "blue", x: 40, y: 40, w: 720, h: 560 },
          card(3, 80, 110),
          card(9, 420, 110),
          card(1, 250, 360),
          { id: "t1", type: "text", text: "Flexibility inflates published effects", color: "ink", x: 830, y: 40, w: 300, h: 50 },
          { id: "c1", type: "item", ref: { kind: "note", id: chapterNote.id }, title: "Chapter 2: what preregistration changes", x: 820, y: 110, w: 320, h: 300 },
          card(5, 830, 450),
        ],
        edges: [
          { id: "e1", from: { node: "n3" }, to: { node: "n1" }, color: "blue" },
          { id: "e2", from: { node: "n9" }, to: { node: "n1" }, color: "blue" },
          { id: "e3", from: { node: "n1" }, to: { node: "c1" }, color: "ink", label: "summarised in" },
          { id: "e4", from: { node: "n5" }, to: { node: "c1" }, color: "orange" },
        ],
      },
    });
    // Page details start open; the sidebar reads collections and notes when it loads.
    await shell.evaluate(() => localStorage.setItem("key.page.details.open", "1"));
    await shell.reload();
    await shell.getByRole("region", { name: "Home", exact: true }).waitFor();
    const sidebar = shell.locator(".key-sidebar");
    const showCollections = sidebar.locator(".kx-library-row").getByRole("button", { name: "Show collections" });
    if (await showCollections.count()) await showCollections.click();

    const readerPage = () => until(async () => app.windows().find((p) => p.url().endsWith("/pdf.html") && !p.isClosed()), "the reader");
    const openPdf = async (n) => {
      const source = await call("store_source", { id: ids[n] });
      await shell.evaluate((s) => window.key.openSource({ ...s, documentHash: s.fileHash ?? s.hash, workspaceId: s.workspaceId }), { ...source, workspaceId: ws.id });
      const pdf = await readerPage();
      await pdf.getByRole("button", { name: "Zoom in", exact: true }).waitFor({ timeout: 30000 });
      await pdf.waitForFunction(() => document.querySelectorAll(".pdfjs-text-run").length > 100, undefined, { timeout: 30000 });
      await wait(800);
      return pdf;
    };
    /** Drags across a phrase of the reader's text runs (runs are words). */
    const selectPhrase = async (pdf, phrase) => {
      const find = () =>
        pdf
          .waitForFunction(
            (phrase) => {
              const runs = [...document.querySelectorAll(".pdfjs-text-run")];
              let text = "";
              const starts = runs.map((r) => {
                const at = text.length;
                text += `${r.textContent.trim()} `;
                return at;
              });
              const at = text.indexOf(phrase);
              if (at < 0) return false;
              const run = (offset) => starts.findLastIndex((s) => s <= offset);
              const range = [run(at), run(at + phrase.length - 1)];
              runs[range[0]].scrollIntoView({ block: "center" });
              return range;
            },
            phrase,
            { timeout: 20000 },
          )
          .then((h) => h.jsonValue());
      await find();
      await wait(600);
      const [a, b] = await find();
      const first = await pdf.locator(".pdfjs-text-run").nth(a).boundingBox();
      const last = await pdf.locator(".pdfjs-text-run").nth(b).boundingBox();
      await pdf.mouse.move(first.x + 1, first.y + first.height / 2);
      await pdf.mouse.down();
      await pdf.mouse.move(last.x + last.width - 1, last.y + last.height / 2, { steps: 20 });
      await pdf.mouse.up();
      return pdf.getByRole("toolbar", { name: "Text selection actions" }).waitFor({ timeout: 5000 });
    };
    const highlight = async (pdf, phrase, color, comment) => {
      await selectPhrase(pdf, phrase);
      await pdf.getByRole("toolbar", { name: "Text selection actions" }).getByRole("button", { name: `${color} highlight` }).click();
      await wait(400);
      if (!comment) return;
      const marker = pdf.locator(`.pdfjs-highlight-marker.color-${color}`).last();
      await marker.waitFor();
      await pdf.keyboard.press("Escape");
      await marker.click();
      const info = pdf.locator(".key-highlight-info");
      await info.waitFor();
      await info.getByRole("button", { name: "Add comment" }).click();
      const editor = pdf.getByRole("dialog", { name: "Comment editor" });
      await editor.waitFor();
      await pdf.keyboard.type(comment);
      await editor.getByRole("button", { name: "Save comment" }).click();
      await editor.waitFor({ state: "detached" });
      await pdf.keyboard.press("Escape");
      await pdf.mouse.click(5, 400);
    };
    const scrollReader = (pdf, top) => pdf.evaluate((top) => document.querySelector(".pdfjs-scroll").scrollTo({ top, behavior: "instant" }), top);
    const settings = shell.locator(".kx-settings");
    const openSettings = async (section) => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("open-settings")));
      await settings.waitFor();
      await settings.getByRole("button", { name: section, exact: true }).click();
      await wait(600);
    };
    const both = async (name, before, opts) => {
      await theme("light");
      if (before) await before();
      await shot(name, opts);
      await theme("dark");
      if (before) await before();
      await shot(`${name}-dark`, opts);
      await theme("light");
    };
    const one = async (name, before, opts) => {
      if (before) await before();
      await shot(name, opts);
    };

    // ── Scenes ── (one failing scene is reported and the others still run)
    const failed = [];
    const ran = new Set();
    const scene = async (name, body) => {
      if (!SCENES.includes(name)) throw Error(`Scene ${name} is missing from SCENES`);
      if (!want(name)) return;
      ran.add(name);
      const before = written.length;
      try {
        await body();
        // A scene that returns without writing an image would leave an old file in place.
        if (written.length === before) throw Error("wrote no image");
      } catch (error) {
        failed.push(name);
        console.error(`Scene ${name} failed:`, error.message.split("\n")[0]);
        await shell.screenshot({ path: path.join(temp, `failure-${name}.png`) }).catch(() => {});
        for (let i = 0; i < 3; i++) await shell.keyboard.press("Escape").catch(() => {});
        await theme("light").catch(() => {});
      }
    };
    await theme("light");

    // (a) The library with a source's details beside it.
    await scene("library", async () => {
      await closeAll();
      await tabAction("open-content", { section: "sources", workspaceId: ws.id });
      await shell.getByRole("heading", { name: "All sources", exact: true }).waitFor();
      await shell.getByRole("button", { name: "Table", exact: true }).click().catch(() => {});
      // Newest first by year.
      const year = shell.locator(".kx-table-head [role=columnheader]", { hasText: /^Year/ });
      const newest = () => shell.evaluate(() => !!document.querySelector(".kx-table-row .kx-cell-title")?.textContent?.includes("Teaching"));
      for (let i = 0; i < 3 && !(await newest()); i++) {
        await year.click();
        await wait(600);
      }
      await shell.locator(".kx-table-row", { hasText: demo.byN(1)[1] }).first().click();
      await shell.locator(".kx-inspector").waitFor();
      await wait(1500);
      await both("key-library");
    });

    // (b) The reader: highlights with margin markers, the references beside it, a citation card.
    await scene("reader", async () => {
      await closeAll();
      const pdf = await openPdf(1);
      await highlight(pdf, "Each choice is defensible on its own,", "orange");
      await highlight(pdf, "Preregistration answers this by fixing the analysis before the data are seen.", "green", "The core claim of the chapter.");
      await highlight(pdf, "Registered reports go further", "blue");
      await scrollReader(pdf, 0);
      await pdf.mouse.move(600, 20);
      await pdf.getByRole("button", { name: "References", exact: true }).click();
      const panel = shell.locator(".key-reader-panel");
      await panel.locator(".key-ref-list li").first().waitFor({ timeout: 90000 });
      await wait(1500);
      const hover = async () => {
        // Scrolling down puts the reader's toolbar away (once nothing in it has focus).
        await pdf.evaluate(() => document.activeElement?.blur());
        await scrollReader(pdf, 0);
        await wait(300);
        await pdf.mouse.move(5, 600);
        await scrollReader(pdf, 200);
        await wait(100);
        await scrollReader(pdf, 420);
        await wait(600);
        const box = await pdf.locator(".pdfjs-link-overlay.citation").nth(2).boundingBox();
        await pdf.mouse.move(5, 600);
        await wait(300);
        await pdf.mouse.move(box.x + box.width / 2 - 2, box.y + box.height / 2 + 1, { steps: 3 });
        await pdf.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 2 });
        await pdf.locator(".pdfjs-cite-card").waitFor({ timeout: 5000 });
        await pdf.waitForFunction(() => !document.querySelector(".pdfjs-cite-skeleton"), undefined, { timeout: 10000 });
        await wait(600);
      };
      await both("key-reader", hover);
    });

    // (c) A note with citations, a quote that links back, and its bibliography.
    await scene("note", async () => {
      await closeAll();
      // The note beside the paper it quotes, its details folded.
      await shell.evaluate(() => localStorage.setItem("key.page.details.open", "0"));
      const pdf = await openPdf(1);
      await tabAction("open-content", { section: "note", workspaceId: ws.id, noteId: chapterNote.id, title: "Chapter 2: what preregistration changes" });
      const editor = shell.locator(".kx-note-page .ProseMirror").last();
      await editor.locator(".ne-bibliography-list p").first().waitFor();
      await editor.locator(".ne-squote").waitFor();
      const t = await shell.evaluate(() => window.key.tabs());
      const pdfView = t.tabs.flatMap((x) => x.views).find((v) => v.kind === "pdf");
      if (pdfView) await tabAction("split", { viewId: pdfView.id, edge: "right" });
      await wait(1500);
      await scrollReader(pdf, 0);
      await pdf.mouse.move(5, 600);
      await scrollReader(pdf, 150);
      await wait(100);
      await scrollReader(pdf, 330);
      await wait(800);
      await one("key-note");
      await shell.evaluate(() => localStorage.setItem("key.page.details.open", "1"));
    });

    // (d) Search: filters as tokens, marks in titles and details; then the web beside it.
    const openSearch = async () => {
      await closeAll();
      await tabAction("open-content", { section: "search", workspaceId: ws.id });
      const tab = shell.locator(".kx-search-page");
      await tab.waitFor();
      return { tab, field: tab.getByRole("combobox", { name: "Search everything" }) };
    };
    await scene("search", async () => {
      const { tab, field } = await openSearch();
      await field.click();
      await field.pressSequentially("brenner", { delay: 30 });
      await shell.locator(".kx-suggest-item", { hasText: "Lukas Brenner" }).first().click();
      await field.fill("analysis plan");
      await field.press("Escape");
      await tab.locator(".kx-found-hit").first().waitFor();
      await wait(2000);
      await one("key-search");
    });
    await scene("web-search", async () => {
      const { tab, field } = await openSearch();
      await field.click();
      await field.fill("replication effect sizes");
      await field.press("Escape");
      await tab.locator('.kx-web-pill button[data-kind="web"]').click();
      const web = tab.locator(".kx-web");
      await web.locator(".kx-web-hit").first().waitFor();
      await web.locator(".kx-web-skeleton").waitFor({ state: "detached" }).catch(() => {});
      const hit = web.locator(".kx-web-hit", { hasText: "Hidden moderators" });
      await hit.locator(".kx-found-open").click();
      await tab.locator(".kx-web-preview .kx-web-preview-title").waitFor();
      await wait(1200);
      await one("key-web-search");
      await shell.keyboard.press("Escape");
    });

    // (e) A topic's page with its relation map.
    await scene("relation-map", async () => {
      await closeAll();
      await tabAction("open-content", { section: "topic", workspaceId: ws.id, entityId: "T1", title: "Reproducibility in Science" });
      const mapBox = shell.locator(".kx-entity-page:visible .kx-map");
      await mapBox.locator(".kx-map-node.kx-map-center").waitFor();
      await mapBox.scrollIntoViewIfNeeded();
      // Scrolled just past the page's title (not half through it), the map's foot in view.
      await mapBox.evaluate((map) => {
        const page = map.closest(".kx-entity-page");
        const title = page?.querySelector("h1");
        let scroller = map.parentElement;
        while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
        if (!scroller || !title) return;
        const top = title.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop + 8;
        const need = map.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientHeight + 12;
        if (need > scroller.scrollTop) scroller.scrollTop = Math.max(need, top);
        else if (title.getBoundingClientRect().top < scroller.getBoundingClientRect().top) scroller.scrollTop = top;
      });
      await shell.mouse.move(5, 5);
      await wait(1500);
      await one("key-relation-map");
    });

    // (f) The in-app browser on an article page through the library's proxy.
    await scene("browser", async () => {
      await closeAll();
      const open = (url) => tabAction("open-url", { url });
      const activeView = async () => {
        const t = await shell.evaluate(() => window.key.tabs());
        return t.tabs.find((x) => x.id === t.activeTabId)?.views[0];
      };
      await open(`http://login.ezproxy.northbridge.example/login?qurl=${encodeURIComponent(`http://${demo.ARTICLE_HOST}/`)}`);
      await until(async () => (await activeView())?.web?.proxy?.offer, "the offer to remember the proxy");
      await shell.getByRole("button", { name: "Remember" }).click();
      await until(async () => (await shell.evaluate(() => window.key.proxies("get"))).proxies[0], "the remembered proxy");
      await closeAll();
      await open(`http://${demo.ARTICLE_HOST}/articles/91`);
      // The mock journal lets anyone in, so Key loads it directly and offers the proxy instead.
      await until(async () => (await activeView())?.web?.proxy?.via || (await shell.getByRole("button", { name: "Use proxy" }).count()), "the page or the proxy offer");
      if (!(await activeView())?.web?.proxy?.via) await shell.getByRole("button", { name: "Use proxy" }).click();
      await until(async () => (await activeView())?.web?.proxy?.via, "the page through the proxy");
      await until(async () => (await activeView())?.web?.article?.doi, "the article detected");
      await shell.locator(".key-web-article").first().waitFor();
      await wait(1500);
      await one("key-browser");
    });

    // (g) A saved web page, highlighted and commented in the web page reader.
    await scene("web-page", async () => {
      await closeAll();
      await tabAction("open-url", { url: "http://blog.methods-notebook.example/vague-plans" });
      const save = shell.locator(".key-web-bar .key-web-save", { hasText: "Save to library" });
      await save.waitFor();
      await until(async () => !(await save.isDisabled()), "the page to load");
      await save.click();
      const saved = shell.locator(".key-web-bar .key-web-save", { hasText: "In library" });
      await saved.waitFor({ timeout: 30000 });
      await saved.click();
      const reader = shell.locator(".kx-web-reader");
      await reader.locator("iframe").waitFor();
      const frame = await until(async () => {
        const f = shell.frames().find((x) => x.url() === "about:srcdoc");
        return f && (await f.evaluate(() => !!document.querySelector("#p2"))) && f;
      }, "the saved page in the reader");
      const select = (id, text) =>
        frame.evaluate(
          ({ id, text }) => {
            const node = document.getElementById(id).firstChild;
            const at = node.data.indexOf(text);
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + text.length);
            document.getSelection().removeAllRanges();
            document.getSelection().addRange(range);
            document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          },
          { id, text },
        );
      const toolbar = shell.locator(".kx-web-toolbar");
      await select("p2", "the benefits of preregistration depend almost entirely on this specificity");
      await toolbar.getByRole("button", { name: "blue highlight" }).click();
      await until(() => frame.evaluate(() => document.querySelectorAll("mark.key-hl").length === 1), "the first highlight");
      await select("p3", "readers should not treat the word “preregistered” as a quality badge on its own");
      await toolbar.getByRole("button", { name: "Add comment" }).click();
      await shell.locator(".kx-web-comment textarea").fill("Quote this in the discussion.");
      await shell.locator(".kx-web-comment").getByRole("button", { name: "Save" }).click();
      await until(() => frame.evaluate(() => document.querySelectorAll("mark.key-hl[data-comment]").length === 1), "the comment");
      await select("p4", "write the analysis code before collecting data");
      await toolbar.getByRole("button", { name: "green highlight" }).click();
      await reader.getByRole("button", { name: "Highlights" }).click();
      await shell.locator(".kx-web-panel .kx-web-highlights li").nth(2).waitFor();
      await frame.evaluate(() => document.getSelection().removeAllRanges());
      await shell.mouse.move(5, 500);
      // The "Saved to your library" toast goes first.
      await until(async () => !(await shell.getByText("Saved to your library").count()), "the toast to go", 15000).catch(() => {});
      await wait(1000);
      await shell.evaluate(() => document.activeElement?.blur?.());
      await one("key-web-page");
    });

    // (h) The tag manager's suggestions.
    await scene("tags", async () => {
      await closeAll();
      await tabAction("open-content", { section: "sources", workspaceId: ws.id });
      await shell.getByRole("heading", { name: "All sources", exact: true }).waitFor();
      await shell.locator(".kx-tag-picker > summary").click();
      await shell.getByRole("button", { name: /Manage, merge and clean up tags/ }).click();
      const manager = shell.getByRole("dialog", { name: "Manage tags" });
      await manager.locator(".kx-tm-card").first().waitFor();
      await wait(1000);
      await shell.evaluate(() => document.activeElement?.blur?.());
      await one("key-tags");
      await shell.keyboard.press("Escape");
    });

    // (i) Editing several sources at once.
    await scene("batch-edit", async () => {
      await closeAll();
      await tabAction("open-content", { section: "sources", workspaceId: ws.id });
      await shell.getByRole("heading", { name: "All sources", exact: true }).waitFor();
      await shell.getByRole("button", { name: "Table", exact: true }).click().catch(() => {});
      const row = (n) => shell.locator(".kx-table-row", { hasText: demo.byN(n)[1] }).first();
      await row(3).click();
      for (const n of [7, 12, 9]) await row(n).click({ modifiers: ["Meta"] });
      // Four selected: the details panel gives way to the selection panel and its overview.
      const panel = shell.getByLabel("4 sources selected", { exact: true });
      await panel.getByRole("heading", { name: "4 sources selected" }).waitFor();
      await panel.locator(".kx-selection-loading").waitFor({ state: "detached" }).catch(() => {});
      await panel.locator(".kx-selection-facts").waitFor();
      await wait(1000);
      await one("key-batch-edit");
      await shell.keyboard.press("Escape");
    });

    // (j) The Inbox: a followed journal's new articles.
    await scene("inbox", async () => {
      await closeAll();
      const row = shell.locator(".kx-inbox-row button");
      await row.click();
      const inbox = shell.locator(".kx-inbox");
      await inbox.getByRole("heading", { name: "Nothing followed yet" }).waitFor();
      await inbox.getByRole("button", { name: /Feeds & alerts/ }).click();
      const sheet = shell.getByRole("dialog", { name: "Feeds and alerts" });
      await sheet.waitFor();
      // The feed is read by the library host, which reaches the mock by its loopback address.
      await sheet.getByLabel("Follow a journal, author, topic or search").fill(`${mock}/feed.xml`);
      const follow = sheet.getByRole("button", { name: "Follow", exact: true });
      await until(async () => (await follow.count()) && (await follow.isEnabled()), "the feed's preview");
      await follow.click();
      await sheet.getByRole("button", { name: "Following", exact: true }).waitFor().catch(() => {});
      await shell.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });
      await inbox.locator(".kx-inbox-list > li").nth(3).waitFor({ timeout: 60000 });
      await inbox.locator(".kx-inbox-list > li").first().click();
      await wait(1200);
      await one("key-inbox");
    });

    // (k) Settings: citation styles with a live preview.
    await scene("settings-citations", async () => {
      await closeAll();
      await tabAction("open-content", { section: "sources", workspaceId: ws.id });
      await shell.locator(".kx-table-row, .kx-row", { hasText: demo.byN(1)[1] }).first().click();
      await openSettings("Citations");
      await shell.locator("[data-preview=citation]").waitFor();
      await wait(800);
      await one("key-settings-citations");
      await shell.keyboard.press("Escape");
      await settings.waitFor({ state: "detached" });
    });

    // (l) The Zotero sheet.
    await scene("zotero", async () => {
      await closeAll();
      await tabAction("open-content", { section: "sources", workspaceId: ws.id });
      await shell.locator('summary[aria-label="More ways to add"]').click();
      await shell.getByRole("button", { name: "Import from Zotero…" }).click();
      await shell.locator(".kx-zotero-import").waitFor();
      await shell.getByRole("heading", { name: "Bring in your Zotero library" }).waitFor();
      await wait(800);
      await one("key-zotero");
      await shell.keyboard.press("Escape");
    });

    // (n) The formula builder: an if() built from blocks, its preview on the library's sources.
    await scene("formula", async () => {
      await closeAll();
      await tabAction("open-content", { section: "sources", workspaceId: ws.id });
      await shell.getByRole("heading", { name: "All sources", exact: true }).waitFor();
      await shell.getByRole("button", { name: "Table", exact: true }).click().catch(() => {});
      await shell.getByRole("button", { name: "Columns", exact: true }).click();
      await shell.getByRole("button", { name: "New property…" }).click();
      const sheet = shell.getByRole("dialog", { name: "New property", exact: true });
      await sheet.waitFor();
      await sheet.getByRole("textbox", { name: "Property name" }).fill("Era");
      await sheet.getByRole("button", { name: /Formula/ }).click();
      const builder = shell.getByRole("dialog", { name: "Formula builder", exact: true });
      await builder.getByRole("region", { name: "Start from an example" }).locator(".kx-fb-template").first().waitFor();
      await builder.getByRole("button", { name: "Start from scratch" }).click();
      const side = builder.getByRole("complementary", { name: "Formula reference" });
      await side.locator('[data-ref="if"]').click();
      await builder.locator(".kx-fb-tree .kx-fb-group[data-kind='fn']").first().waitFor();
      const number = builder.getByRole("textbox", { name: "Number" });
      await number.fill("2020");
      await number.press("Enter");
      const texts = builder.getByRole("textbox", { name: "Text" });
      await texts.nth(0).fill("Recent");
      await texts.nth(0).press("Enter");
      await texts.nth(1).fill("Earlier");
      await texts.nth(1).press("Enter");
      await builder.locator(".kx-fb-summary", { hasText: 'if({Year} > 2020, "Recent", "Earlier")' }).waitFor();
      await builder.getByRole("tablist", { name: "Show as" }).getByRole("tab", { name: "Coloured label", exact: true }).click();
      await builder.locator(".kx-fb-rows .kx-fv-badge").nth(3).waitFor();
      // The reference explains the function under the pointer.
      await side.locator('[data-ref="if"]').hover();
      await side.locator(".kx-fb-detail").first().waitFor().catch(() => {});
      // The list opens at the functions, not part-way through a property.
      await side.locator(".kx-fb-side-list").evaluate((list) => {
        const head = [...list.querySelectorAll("h3, h4, [role=heading], .kx-fb-side-head")].find((h) => /Functions/.test(h.textContent ?? ""));
        if (head) list.scrollTop = head.offsetTop - list.offsetTop - 6;
      }).catch(() => {});
      await shell.evaluate(() => document.activeElement?.blur?.());
      await wait(600);
      await both("key-formula", undefined, { keepPointer: true });
      for (let i = 0; i < 3 && (await shell.getByRole("dialog").count()); i++) {
        await shell.keyboard.press("Escape");
        await wait(300);
      }
      const discard = shell.getByRole("button", { name: /Discard/ });
      if (await discard.count()) await discard.first().click();
    });

    // (o) Database search: a nested Boolean query typed as text, read into blocks, translated
    // for each database (on the sample engine: no network).
    await scene("database-search", async () => {
      await closeAll();
      await tabAction("open-content", { section: "databases", workspaceId: ws.id });
      const db = shell.getByRole("region", { name: "Database search" });
      await db.waitFor();
      await db.getByRole("tablist", { name: "Edit the search as" }).getByRole("tab", { name: "Blocks", exact: true }).click();
      const concepts = db.locator(".kx-db-concept");
      // A comma ends a term. Concept 2 nests: (replication OR reproducib*) NOT protocol.
      const first = concepts.first().getByRole("textbox", { name: /Add a term/ });
      for (const w of ["preregistration,", "registered report*,"]) await first.fill(w);
      await db.getByRole("button", { name: "Add concept" }).click();
      await concepts.nth(1).getByRole("textbox", { name: /Name of concept 2/ }).fill("Replication", { timeout: 3000 }).catch(() => {});
      const second = concepts.nth(1).getByRole("textbox", { name: /Add a term/ });
      for (const w of ["replication,", "reproducib*,", "protocol,"]) await second.fill(w);
      await concepts.first().getByRole("textbox", { name: /Name of concept 1/ }).fill("Preregistration", { timeout: 3000 }).catch(() => {});
      await concepts.nth(1).locator(".kx-db-joiner").nth(1).click();
      await shell.getByRole("dialog", { name: "Operator" }).getByRole("menuitemradio", { name: /NOT/ }).click();
      await concepts.nth(1).locator(".kx-db-group").waitFor();
      await db.locator('.kx-db-how-item[data-connector="pubmed"] .kx-db-native').waitFor();
      await shell.waitForFunction(() => /NOT protocol/.test(document.querySelector('.kx-db-how-item[data-connector="pubmed"] .kx-db-native')?.textContent ?? ""));
      await shell.waitForFunction(() => /\d/.test(document.querySelector('.kx-db-how-item[data-connector="openalex"] .kx-db-how-count')?.textContent ?? ""), undefined, { timeout: 30000 }).catch(() => {});
      await shell.evaluate(() => document.activeElement?.blur?.());
      await wait(800);
      await both("key-database-search");
    });

    // (p) Reading mode: the paper reflowed as text from its stored structure.
    await scene("reading-mode", async () => {
      await closeAll();
      const source = await call("store_source", { id: ids[1] });
      await until(async () => (await call("store_reflow_document", { hash: source.fileHash ?? source.hash })).status === "ready", "the paper's structure", 240000);
      const pdf = await openPdf(1);
      await pdf.getByRole("button", { name: "Reading mode", exact: true }).click();
      await pdf.locator(".kx-reading-article").waitFor();
      // At the top in both themes (a theme change reflows the text).
      const top = async () => {
        await pdf.evaluate(() => document.querySelector(".kx-reading-scroll")?.scrollTo({ top: 0, behavior: "instant" }));
        await pdf.mouse.move(5, 600);
        await wait(1200);
      };
      await both("key-reading-mode", top);
      await pdf.getByRole("button", { name: "Reading mode", exact: true }).click().catch(() => {});
    });

    // (q) Ctrl-Tab: every open tab, most recent first, held open while Control is down.
    await scene("tab-switcher", async () => {
      await closeAll();
      await tabAction("open-content", { section: "sources", workspaceId: ws.id });
      await shell.getByRole("heading", { name: "All sources", exact: true }).waitFor();
      await shell.locator(".kx-nav-item", { hasText: "Argument map" }).first().click();
      await shell.locator(".kx-canvas").waitFor();
      await tabAction("open-content", { section: "note", workspaceId: ws.id, noteId: chapterNote.id, title: "Chapter 2: what preregistration changes" });
      await shell.locator(".kx-note-page .ProseMirror").last().waitFor();
      await tabAction("open-content", { section: "search", workspaceId: ws.id });
      await shell.locator(".kx-search-page").waitFor();
      await openPdf(1);
      await wait(800);
      const send = (events) =>
        app.evaluate(async ({ BrowserWindow }, events) => {
          const contents = BrowserWindow.getAllWindows()[0].webContents;
          contents.focus();
          for (const e of events) contents.sendInputEvent(e);
        }, events);
      await shell.bringToFront();
      await shell.mouse.click(WIDTH - 340, 8);
      await send([
        { type: "keyDown", keyCode: "Control", modifiers: ["control"] },
        { type: "keyDown", keyCode: "Tab", modifiers: ["control"] },
        { type: "keyUp", keyCode: "Tab", modifiers: ["control"] },
      ]);
      await shell.locator(".kx-switcher-row").nth(3).waitFor();
      await wait(500);
      await one("key-tab-switcher");
      await send([{ type: "keyDown", keyCode: "Escape", modifiers: ["control"] }, { type: "keyUp", keyCode: "Control" }]);
      await shell.locator(".kx-switcher").waitFor({ state: "detached" }).catch(() => {});
    });

    // (r) Fill with AI: a property filled from each source's abstract by a mock provider,
    // the answers waiting for review with the passage each came from.
    await scene("ai-fill", async () => {
      await closeAll();
      await openSettings("AI assistant");
      await settings.getByRole("radio", { name: /Other \(OpenAI-compatible\)/ }).click();
      await settings.getByRole("textbox", { name: "Server address" }).fill(`${mock}/v1`);
      await settings.getByRole("button", { name: "Save address" }).click();
      await settings.locator("[data-ai-test]", { hasText: "answered" }).waitFor();
      await settings.getByRole("combobox", { name: "Another model" }).selectOption("demo-small");
      await settings.locator("[data-ai-ready]").waitFor();
      await shell.keyboard.press("Escape");
      await settings.waitFor({ state: "detached" });
      await call("workspace_save_attribute", { name: "Study design", config: { type: "select", options: ["Survey", "Re-analysis of data", "Simulation study", "Review", "Interview study", "Other"] } });
      await tabAction("open-content", { section: "sources", workspaceId: ws.id });
      await shell.getByRole("heading", { name: "All sources", exact: true }).waitFor();
      await shell.getByRole("button", { name: "Table", exact: true }).click().catch(() => {});
      const row = (n) => shell.locator(".kx-table-row", { hasText: demo.byN(n)[1] }).first();
      await row(2).click();
      for (const n of [3, 9, 5]) await row(n).click({ modifiers: ["Meta"] });
      await shell.getByRole("button", { name: /Fill with AI/ }).first().click();
      const sheet = shell.getByRole("dialog", { name: "Fill a property" });
      await sheet.waitFor();
      await sheet.locator('[data-recipe="Study design"]').click();
      await sheet.getByRole("button", { name: "Continue" }).click();
      await sheet.getByRole("button", { name: "Continue" }).click();
      await sheet.getByRole("button", { name: "Continue" }).click();
      await sheet.getByRole("button", { name: /^Test on/ }).click();
      await sheet.locator(".kx-fill-item[data-status=proposed]").first().waitFor({ timeout: 60000 });
      await sheet.getByRole("button", { name: "Continue" }).click();
      await sheet.getByRole("button", { name: /^Fill \d+ source/ }).click();
      await sheet.locator('.kx-fill-review[data-status="done"]').waitFor({ timeout: 60000 });
      await sheet.locator(".kx-fill-item[data-status=proposed]").nth(3).waitFor();
      // One answer shows the passage it came from.
      await sheet.locator(".kx-fill-item").first().getByRole("button", { name: "Evidence" }).click().catch(() => {});
      await sheet.locator(".kx-fill-quote").first().waitFor({ timeout: 5000 }).catch(() => {});
      await wait(800);
      await both("key-ai-fill");
      // Accepted, so later scenes do not show proposals waiting in the status bar.
      await sheet.getByRole("button", { name: /^Accept all/ }).click();
      await sheet.locator(".kx-fill-message", { hasText: /Saved/ }).waitFor();
      await until(async () => !/proposals? to review/.test((await shell.getByRole("contentinfo", { name: "Status" }).innerText().catch(() => "")) || ""), "the proposals to be accepted", 10000).catch(() => {});
      await sheet.locator(".kx-sheet-close").click().catch(() => shell.keyboard.press("Escape"));
      await sheet.waitFor({ state: "detached" }).catch(() => {});
    });

    // (s) A systematic review with invented records: criteria, screening with a rule's
    // suggestion, the meta-analysis and the PRISMA diagram.
    await scene("review", async () => {
      await closeAll();
      const STUDIES = [
        ["Walking groups and blood pressure in older adults: a randomised trial", "Rivera, Ana", 2016, "10.5555/walk.1", "We randomised 240 adults aged over 65 to weekly walking groups or usual care. Systolic blood pressure fell more with walking."],
        ["Walking groups and blood pressure in older adults: a randomised trial", "Rivera, Ana", 2016, "10.5555/walk.1", "The same record from a second database."],
        ["Stretching breaks at work: a cluster randomised trial", "Larsen, Ben", 2019, "10.5555/stretch.2", "Offices were randomised to stretching breaks. Back pain at six months was lower in stretching offices."],
        ["Exercise habits in rats fed a high-salt diet", "Lind, Cara", 2015, "10.5555/rats.3", "Rats exercised on wheels; blood pressure was measured weekly."],
        ["Cycling to school and fitness in children", "Haas, Dev", 2021, "10.5555/cycle.4", "A cohort of children who cycled to school had higher fitness scores."],
        ["Yoga for chronic low back pain: a randomised trial", "Moreau, Eli", 2018, "10.5555/yoga.5", "Adults with chronic low back pain were randomised to yoga or a booklet. Pain improved more with yoga."],
        ["Tai chi and balance in older people: randomised controlled trial", "Ito, Fay", 2017, "10.5555/taichi.6", "Older people were randomised to tai chi or stretching. Falls were fewer with tai chi."],
        ["A survey of gym membership", "Berg, Gus", 1987, "", "A survey of 400 gym members about their habits."],
        ["Pilates versus usual care for neck pain: a randomised trial", "Silva, Hana", 2020, "10.5555/pilates.8", "Adults with neck pain were randomised to pilates or usual care."],
        ["Editorial: why we should all walk more", "Kerr, Ian", 2022, "10.5555/ed.9", "An editorial on walking."],
        ["Aquatic exercise for knee osteoarthritis: a randomised trial", "Novak, Jon", 2019, "10.5555/aqua.10", "Adults with knee osteoarthritis were randomised to pool exercise or education."],
      ];
      const risFile = path.join(temp, "pubmed-search.ris");
      await writeFile(risFile, STUDIES.map(([title, author, year, d, abstract]) => ["TY  - JOUR", `TI  - ${title}`, `AU  - ${author}`, `PY  - ${year}`, d && `DO  - ${d}`, `AB  - ${abstract}`, "JO  - Journal of Invented Examples", "ER  - "].filter(Boolean).join("\n")).join("\n"));
      const dismissNotices = async () => {
        for (const notice of await shell.locator(".kx-rv-notice").all()) await notice.click({ position: { x: 4, y: 4 } }).catch(() => {});
      };
      await shell.getByRole("navigation", { name: "Systematic reviews" }).getByRole("button", { name: "Reviews", exact: true }).click();
      const create = shell.getByRole("dialog", { name: "New systematic review" });
      await create.waitFor();
      await create.getByRole("textbox", { name: "Review name" }).fill("Exercise for pain and blood pressure");
      await create.getByRole("textbox", { name: "Your name" }).fill("Mei Tanaka");
      await create.getByRole("button", { name: "Create review" }).click();
      await shell.getByRole("heading", { name: "Exercise for pain and blood pressure" }).waitFor();
      const reviewId = (await call("review_list")).find((r) => r.name === "Exercise for pain and blood pressure")?.id ?? (await call("review_list"))[0].id;
      const summary = () => call("review_get", { reviewId, viewer: "" });
      await shell.getByRole("tab", { name: /Sources/ }).click();
      await shell.locator(".kx-rv-sources input[type=file]").setInputFiles(risFile);
      const importSheet = shell.getByRole("dialog", { name: "Import records" });
      await importSheet.getByText("11 records", { exact: true }).waitFor();
      await importSheet.getByRole("textbox", { name: "Search strategy" }).fill("(exercise OR walking OR yoga) AND (randomised OR randomized)");
      await importSheet.getByRole("button", { name: /Import 11 records/ }).click();
      await shell.getByText(/1 duplicate removed/).first().waitFor();
      let s = await summary();
      const protocol = s.protocol;
      protocol.keywords = { include: ["randomi*", "trial"], exclude: ["rats", "editorial", "survey"] };
      protocol.criteria = [
        { id: "c-rct", element: "design", label: "Randomised controlled trial", reason: "Wrong study design", guidance: "Individually or cluster randomised.", stages: ["ta", "ft"], link: null },
        { id: "c-year", element: "other", label: "Published 2000 or later", reason: "Published before 2000", guidance: "", stages: ["ta"], link: { conditions: [{ field: "year", op: "ge", value: 2000 }], all: true, effect: "suggest" } },
        { id: "c-humans", element: "population", label: "Studies of people", reason: "Animal studies", guidance: "", stages: ["ta", "ft"], link: null },
      ];
      protocol.forms.push((await call("review_form_templates")).find((f) => f.id === "f-outcomes"));
      await call("review_protocol_save", { reviewId, protocol, note: "", actor: s.team[0].id, rescreen: false });
      // Setup: the criteria, one linked to the publication year.
      await shell.getByRole("tab", { name: /Setup/ }).click();
      await shell.getByRole("button", { name: "Criteria", exact: false }).first().click();
      await shell.locator(".kx-rv-criterion").nth(2).waitFor();
      await shell.locator(".kx-rv-criterion").nth(1).getByRole("button", { name: "Show details" }).click();
      await dismissNotices();
      await shell.evaluate(() => document.activeElement?.blur?.());
      await wait(500);
      await one("key-review-setup");
      // Title and abstract screening with the keyboard, stopping at the rule's suggestion.
      await shell.getByRole("tab", { name: /Title & abstract/ }).click();
      const title = shell.locator(".kx-rv-record-title");
      await title.waitFor();
      for (let i = 0; i < 10; i++) {
        const t = await title.textContent();
        if (/survey of gym/.test(t)) break;
        await shell.keyboard.press(/rats|Editorial|Cycling/.test(t) ? "e" : /Pilates/.test(t) ? "m" : "i");
        await shell.waitForFunction((b) => document.querySelector(".kx-rv-record-title")?.textContent !== b, t);
      }
      await shell.locator(".kx-rv-suggestion").getByText("Not met: Year is 2000 or later").waitFor();
      await dismissNotices();
      await wait(500);
      await one("key-review-screening");
      for (let i = 0; i < 10 && !(await shell.locator(".kx-rv-done").count()); i++) {
        const t = await title.textContent();
        await shell.keyboard.press(/rats|Editorial|survey|Cycling/.test(t) ? "e" : /Pilates/.test(t) ? "m" : "i");
        await shell.waitForFunction((b) => document.querySelector(".kx-rv-record-title")?.textContent !== b || document.querySelector(".kx-rv-done"), t);
      }
      // Full text: everything left goes in, but for Pilates (it fails criterion 2, studies of people).
      await shell.getByRole("tab", { name: /Full text/ }).click();
      await title.waitFor();
      for (let i = 0; i < 12 && !(await shell.locator(".kx-rv-done").count()); i++) {
        const t = await title.textContent();
        if (/Pilates/.test(t)) {
          await shell.keyboard.press("e");
          await shell.locator(".kx-rv-criteria-pick[data-picking]").waitFor();
          await shell.keyboard.press("2");
        } else await shell.keyboard.press("i");
        await shell.waitForFunction((b) => document.querySelector(".kx-rv-record-title")?.textContent !== b || document.querySelector(".kx-rv-done"), t);
      }
      s = await summary();
      const studies = (await call("review_studies", { reviewId, viewer: s.team[0].id })).studies;
      const data = [[12, 120, 20, 118], [8, 60, 15, 62], [30, 150, 41, 149], [5, 40, 9, 42], [14, 98, 19, 101]];
      for (const [i, st] of studies.entries()) {
        const [e1, n1, e2, n2] = data[i % data.length];
        await call("review_extract", { reviewId, recordId: st.id, formId: "f-outcomes", fieldId: "outcomes", value: [{ outcome: "Pain persisting", type: "Dichotomous", e1, n1, e2, n2 }], quote: "Table 2", page: 5, actor: s.team[0].id });
      }
      await shell.getByRole("tab", { name: /Analysis/ }).click();
      await shell.locator(".kx-forest").waitFor();
      await dismissNotices();
      await wait(600);
      await one("key-review-analysis");
      await shell.getByRole("tab", { name: "Overview" }).click();
      await shell.getByRole("img", { name: "PRISMA 2020 flow diagram" }).waitFor();
      await dismissNotices();
      await wait(600);
      await one("key-review-prisma");
    });

    // (i) Duplicates review. Last but one: the duplicate stays in the library afterwards.
    await scene("duplicates", async () => {
      await closeAll();
      const w = demo.byN(16);
      const fields = fieldsOf(w);
      await call("store_create", { source: { kind: "reference", ...fields } });
      await tabAction("open-content", { section: "sources", workspaceId: ws.id });
      await shell.getByRole("heading", { name: "All sources", exact: true }).waitFor();
      const tabs = shell.locator(".kx-scope-tabs");
      await tabs.getByRole("tab", { name: /Duplicates/ }).waitFor({ timeout: 60000 });
      await tabs.getByRole("tab", { name: /Duplicates/ }).click();
      const view = shell.getByLabel("Duplicates", { exact: true });
      await view.locator(".kx-dup-group").first().waitFor();
      await view.locator(".kx-dup-group").first().getByRole("button", { name: "Review…" }).click();
      const sheet = shell.locator('div[role=dialog][aria-label="Merge sources"]');
      await sheet.locator(".kx-merge-fields").waitFor();
      await wait(1000);
      await one("key-duplicates");
      await sheet.getByRole("button", { name: "Cancel" }).click().catch(() => shell.keyboard.press("Escape"));
      await sheet.waitFor({ state: "detached" }).catch(() => {});
    });

    // (m) A canvas.
    await scene("canvas", async () => {
      await closeAll();
      await shell.locator(".kx-nav-item", { hasText: "Argument map" }).first().click();
      await shell.locator(".kx-canvas").waitFor();
      await shell.locator(".kx-canvas-node").nth(5).waitFor();
      await wait(1000);
      await shell.locator(".kx-canvas-node").first().click({ position: { x: 2, y: 2 } });
      await shell.keyboard.press("Escape");
      await shell.keyboard.press("Shift+1");
      await wait(1200);
      await one("key-canvas");
    });

    for (const name of only) if (!ran.has(name) && !failed.includes(name)) failed.push(name);
    console.log(JSON.stringify({ ok: !failed.length, failed, temp, written: written.map((f) => path.basename(f)) }, null, 1));
    if (failed.length) {
      console.error(`\nFAILED: ${failed.length} scene(s) did not finish (their images may be missing or old): ${failed.join(", ")}`);
      process.exitCode = 1;
    }
  } catch (error) {
    if (shell) await shell.screenshot({ path: path.join(temp, "failure.png") }).catch(() => {});
    console.error("Artifacts in", temp);
    throw error;
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    server.close();
    if (!process.argv.includes("--keep")) await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
