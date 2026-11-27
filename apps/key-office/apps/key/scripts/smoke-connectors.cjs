// Database search connectors end to end, on the Rust host alone (the page is db-ui's smoke):
// a local mock stands in for PubMed, Crossref and EconStor (their recorded fixtures) and for
// the connector update server. Checks: the built-in connectors load; a newer dev-signed bundle
// is accepted and activated; a tampered one is refused and the active one kept; a search over
// all three streams, merges and reports; saved searches re-run and mark nothing new.
//
//   node scripts/smoke-connectors.cjs [host binary] [key-connectors binary]
//
// Defaults: KEY_HOST_EXECUTABLE and KEY_CONNECTORS_BIN, else the worktree's target-agent builds.
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const { tmpdir } = require("node:os");
const path = require("node:path");

const repo = path.resolve(__dirname, "../../../../..");
const hostBin = process.argv[2] || process.env.KEY_HOST_EXECUTABLE || path.join(repo, "target-agent/debug/key-desktop-host");
const toolBin = process.argv[3] || process.env.KEY_CONNECTORS_BIN || path.join(repo, "target-agent/debug/key-connectors");
const pdfium = path.join(repo, "vendor/pdfium/lib/libpdfium.dylib");
const temp = fs.mkdtempSync(path.join(tmpdir(), "key-smoke-connectors-"));
const fail = (m) => {
  console.error("FAIL", m);
  process.exitCode = 1;
  throw Error(m);
};
const ok = (cond, m) => (cond ? console.log("ok  ", m) : fail(m));

// ── Fixtures as a mock service: host + path + sorted parameters (keys ignored), like fixtures.rs.
const IGNORED = new Set(["api_key", "apikey", "apiKey", "insttoken", "email", "mailto", "tool", "key", "token"]);
const matchKey = (method, url) => {
  const pairs = [...url.searchParams].filter(([k]) => !IGNORED.has(k)).sort((a, b) => (a[0] + "=" + a[1] < b[0] + "=" + b[1] ? -1 : 1));
  return `${method} ${url.host}${url.pathname}?${pairs.map(([k, v]) => `${k}=${v}`).join("&")}`;
};
const answers = new Map();
const fixturesDir = path.join(repo, "connectors/fixtures");
for (const id of fs.readdirSync(fixturesDir)) {
  for (const f of fs.readdirSync(path.join(fixturesDir, id))) {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, id, f), "utf8"));
    for (const e of fixture.exchanges) if (e.status < 400) answers.set(matchKey(e.method || "GET", new URL(e.url)), e);
  }
}

// ── Bundles: v5 (EconStor bumped to 1.0.1), and a tampered v6.
const specsCopy = path.join(temp, "specs");
fs.mkdirSync(specsCopy);
for (const f of fs.readdirSync(path.join(repo, "connectors/specs"))) {
  let text = fs.readFileSync(path.join(repo, "connectors/specs", f), "utf8");
  if (f === "econstor.json") text = text.replace('"version": "1.0.0"', '"version": "1.0.1"').replace('"name": "EconStor"', '"name": "EconStor (updated)"');
  fs.writeFileSync(path.join(specsCopy, f), text);
}
const tool = (...args) => execFileSync(toolBin, args, { cwd: repo, encoding: "utf8" });
const good = path.join(temp, "bundle-good");
tool("dev-bundle", "--specs", specsCopy, "--out", good, "--sequence", "5");
// v6 really changes EconStor (so it is downloaded, not copied from the active bundle), then the
// file is altered after signing.
const econstorCopy = path.join(specsCopy, "econstor.json");
fs.writeFileSync(econstorCopy, fs.readFileSync(econstorCopy, "utf8").replace('"version": "1.0.1"', '"version": "1.0.2"'));
const tampered = path.join(temp, "bundle-tampered");
tool("dev-bundle", "--specs", specsCopy, "--out", tampered, "--sequence", "6");
const evil = path.join(tampered, "specs/econstor.json");
fs.writeFileSync(evil, fs.readFileSync(evil, "utf8").replace("EconStor (updated)", "EconStor (tampered)"));
let serving = good;
let updateRequests = 0;

const server = http.createServer((req, res) => {
  const url = new URL(`https:/${req.url}`);
  if (url.host === "connectors.test") {
    updateRequests++;
    const file = path.join(serving, url.pathname.replace(/^\/bundle\//, ""));
    if (!file.startsWith(serving) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(fs.readFileSync(file));
    return;
  }
  const e = answers.get(matchKey(req.method, url));
  // Pages after the recorded ones: the end of each list.
  if (!e && url.searchParams.has("resumptionToken")) {
    res.writeHead(200, { "content-type": "text/xml" }).end('<?xml version="1.0"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><error code="noRecordsMatch"/></OAI-PMH>');
    return;
  }
  if (!e && url.pathname.endsWith("/efetch.fcgi")) {
    res.writeHead(200, { "content-type": "text/xml" }).end('<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>');
    return;
  }
  if (!e && url.host === "api.crossref.org" && url.searchParams.get("cursor") !== "*") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok","message":{"items":[]}}');
    return;
  }
  if (!e) {
    console.error("mock: no answer for", matchKey(req.method, url));
    res.writeHead(404, { "content-type": "text/plain" }).end("no fixture");
    return;
  }
  res.writeHead(e.status, { "content-type": e.headers?.["content-type"] || "application/octet-stream" }).end(e.body);
});

function host(port) {
  const library = path.join(temp, "library");
  const child = spawn(hostBin, ["--library", library], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      PDFIUM_DYNAMIC_LIB_PATH: pdfium,
      PDFIUM_LIB_PATH: pdfium,
      KEY_OPENALEX_FIXTURES: path.join(temp, "openalex"),
      KEY_CONNECTORS_MOCK: `http://127.0.0.1:${port}`,
      KEY_CONNECTORS_DEV_TRUST: "1",
      KEY_CONNECTORS_NO_AUTO_CHECK: "1",
      KEY_CONNECTORS_UPDATE_URL: "https://connectors.test/bundle",
      KEY_CONNECTORS_DIR: path.join(temp, "connectors"),
    },
  });
  let buffer = Buffer.alloc(0);
  let next = 1;
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const n = buffer.readUInt32LE(0);
      if (buffer.length < 4 + n) return;
      const header = JSON.parse(buffer.subarray(4, 4 + n));
      const total = 4 + n + (header.binaryLength ?? 0);
      if (buffer.length < total) return;
      buffer = buffer.subarray(total);
      const p = pending.get(header.id);
      if (!p) continue;
      pending.delete(header.id);
      header.ok ? p.resolve(header.result) : p.reject(new Error(String(header.error)));
    }
  });
  const send = (command, args) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      const header = Buffer.from(JSON.stringify({ id, command, args, headers: {}, binaryLength: 0 }));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(header.length);
      child.stdin.write(Buffer.concat([prefix, header]));
    });
  const invoke = async (command, args = {}) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(command, args);
      } catch (e) {
        if (!/busy/i.test(String(e)) || attempt > 500) throw e;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  };
  return { child, invoke };
}

const specOf = (id) => JSON.parse(fs.readFileSync(path.join(repo, "connectors/specs", `${id}.json`), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const h = host(port);
  try {
    let list = await h.invoke("db_connectors");
    ok(["pubmed", "crossref-series", "econstor"].every((id) => list.some((c) => c.id === id && c.origin === "baseline")), "built-in connectors load");

    let check = await h.invoke("db_connectors_check", { force: true });
    ok(check.state === "updated" && check.sequence === 5, `a newer signed bundle is accepted (${JSON.stringify(check)})`);
    list = await h.invoke("db_connectors");
    const econstor = list.find((c) => c.id === "econstor");
    ok(econstor.version === "1.0.1" && econstor.origin === "update" && econstor.name === "EconStor (updated)", "the updated connector is active");

    serving = tampered;
    check = await h.invoke("db_connectors_check", { force: true });
    ok(check.state === "failed" && /hash/.test(check.error || ""), `a tampered bundle is refused (${JSON.stringify(check)})`);
    list = await h.invoke("db_connectors");
    ok(list.find((c) => c.id === "econstor").name === "EconStor (updated)", "the verified bundle stays active");
    const status = await h.invoke("db_connectors_status");
    ok(status.sequence === 5 && status.lastResult === "failed", "status reports the refused update");

    // A search over all three, with each connector's recorded test query and options.
    const queries = ["pubmed", "crossref-series", "econstor"].map((id) => [id, specOf(id).tests[0]]);
    const runIds = [];
    for (const [id, test] of queries) {
      const t = await h.invoke("db_translate", { query: test.query, connectors: [id], options: { [id]: test.options || {} } });
      if (test.native) ok(t[0].native === test.native, `${id} translates as recorded`);
      const { runId } = await h.invoke("db_search_start", { query: test.query, connectors: [id], options: { [id]: test.options || {} }, limit: 20, label: `smoke ${id}` });
      runIds.push([id, runId]);
    }
    for (const [id, runId] of runIds) {
      let r;
      for (let i = 0; i < 200; i++) {
        r = await h.invoke("db_results", { runId, limit: 0 });
        if (r.state !== "running") break;
        await sleep(100);
      }
      const p = r.progress[0];
      ok(r.state === "done" && p.fetched > 0, `${id} search finishes with ${p.fetched} records (total ${p.total})`);
      const page = await h.invoke("db_results", { runId, limit: 5 });
      ok(page.records.length > 0 && page.records[0].foundBy[0] === id && page.records[0].provenance[0].connector === id, `${id} records carry provenance`);
    }
    const [, pubmedRun] = runIds[0];
    const md = await h.invoke("db_report", { runId: pubmedRun, format: "markdown" });
    ok(md.content.includes("PubMed") && md.content.includes("Unique records"), "the run report renders");
    const csv = await h.invoke("db_report", { runId: pubmedRun, format: "csv" });
    ok(csv.content.startsWith("key,title"), "the CSV report renders");

    const [, pubmedTest] = queries[0];
    const saved = await h.invoke("db_saved_save", { name: "Smoke", query: pubmedTest.query, connectors: ["pubmed"], options: { pubmed: pubmedTest.options } });
    for (let round = 0; round < 2; round++) {
      const { runId } = await h.invoke("db_saved_run", { id: saved.id });
      let r;
      for (let i = 0; i < 200; i++) {
        r = await h.invoke("db_results", { runId, limit: 100 });
        if (r.state !== "running") break;
        await sleep(100);
      }
      if (round === 1) ok(r.records.every((x) => x.isNew === false), "a re-run marks nothing new");
    }
    const savedList = await h.invoke("db_saved_list");
    ok(savedList[0].lastCount > 0 && savedList[0].newCount === 0, "the saved search remembers its last run");

    const parsed = await h.invoke("db_parse", { text: '("school meals"[tiab] OR lunch*[ti]) AND attendance[tiab]', dialect: "auto" });
    ok(parsed.query?.concepts?.length === 2, "a pasted PubMed string becomes blocks");
    const problem = await h.invoke("db_report_problem", { connector: "econstor", error: "EconStor answered 500" });
    ok(problem.url.startsWith("https://github.com/") && problem.url.includes("connector%3Aeconstor"), "Report problem builds an issue link");
    ok(updateRequests > 0, "updates came from the configured address only");
    console.log("smoke-connectors passed");
  } catch (e) {
    process.exitCode = 1;
    console.error(e);
  } finally {
    h.child.kill();
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})();
