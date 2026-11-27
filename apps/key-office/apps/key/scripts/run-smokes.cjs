#!/usr/bin/env node
// Runs the real-Electron smokes: in parallel, each in its own temp folder and environment,
// with a timeout each, and a short summary at the end. See scripts/README.md.
//
//   node scripts/run-smokes.cjs [name ...] [--jobs N] [--repeat N] [--retries N] [--timeout S]
//                               [--out DIR] [--keep] [--list] [--visible]
//
// Names are smoke names with or without the `smoke-` prefix and `.cjs` suffix (no names: all).
const { spawn, execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, createWriteStream, existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { killTree, testRunMarker } = require("./lib/processes.cjs");

const here = __dirname;
const argv = process.argv.slice(2);
const opts = { jobs: 0, repeat: 1, retries: 0, timeout: 0, out: "", keep: false, list: false, visible: false, names: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => {
    const v = a.includes("=") ? a.split("=").slice(1).join("=") : argv[++i];
    if (v === undefined) throw Error(`${a} needs a value`);
    return v;
  };
  if (a.startsWith("--jobs") || a === "-j") opts.jobs = Number(value());
  else if (a.startsWith("--repeat")) opts.repeat = Number(value());
  else if (a.startsWith("--retries")) opts.retries = Number(value());
  else if (a.startsWith("--timeout")) opts.timeout = Number(value());
  else if (a.startsWith("--out")) opts.out = path.resolve(value());
  else if (a === "--keep") opts.keep = true;
  else if (a === "--list") opts.list = true;
  else if (a === "--visible") opts.visible = true;
  else if (a === "--help" || a === "-h") {
    console.log(readFileSync(__filename, "utf8").split("\n").slice(1, 9).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(0);
  } else if (a.startsWith("-")) throw Error(`Unknown option ${a}`);
  else opts.names.push(a);
}

const all = readdirSync(here)
  .filter((f) => /^smoke-.*\.cjs$/.test(f))
  .map((f) => f.slice("smoke-".length, -".cjs".length))
  .sort();
if (opts.list) {
  console.log(all.join("\n"));
  process.exit(0);
}
const names = opts.names.length ? opts.names.map((n) => n.replace(/^smoke-/, "").replace(/\.cjs$/, "")) : all;
const unknown = names.filter((n) => !all.includes(n));
if (unknown.length) {
  console.error(`No such smoke: ${unknown.join(", ")} (see --list)`);
  process.exit(2);
}

/** Bounded by cores and by what the machine is already doing: each smoke is an Electron app
 *  plus a Rust host, two to three busy cores at peaks. */
function defaultJobs() {
  const cores = os.cpus().length;
  const load = os.loadavg()[0];
  const free = Math.max(1, cores - load);
  return Math.max(1, Math.min(6, Math.floor(free / 3), Math.floor(os.freemem() / 1.5e9) || 1));
}
const jobs = Math.max(1, opts.jobs || defaultJobs());

/** A smoke can ask for more time with a `// smoke-timeout: <seconds>` line near the top. */
function timeoutOf(name) {
  if (opts.timeout) return opts.timeout * 1000;
  const head = readFileSync(path.join(here, `smoke-${name}.cjs`), "utf8").slice(0, 4000);
  const asked = head.match(/smoke-timeout:\s*(\d+)/);
  return (asked ? Number(asked[1]) : 300) * 1000;
}

const token = Math.random().toString(36).slice(2, 8);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = opts.out || path.join(os.tmpdir(), "key-smokes", stamp);
mkdirSync(out, { recursive: true });

const queue = [];
for (let r = 1; r <= opts.repeat; r++) for (const name of names) queue.push({ name, run: r });
const results = new Map(); // name -> [{ ok, ms, reason, log, dir, attempt, run }]
const live = new Map(); // child -> job id

function failureLine(text, name) {
  const lines = text.split("\n");
  const at = lines.find((l) => l.includes(`smoke-${name}.cjs:`) && /\bat\b/.test(l));
  const where = at?.match(/smoke-[\w-]+\.cjs:(\d+)/)?.[0];
  // The error's first line: "AssertionError …", "Error: …", "locator.click: Timeout …".
  const reason =
    lines.find((l) => /^\s*(?:\[?\w*Error\b\]?|\w+(?:\.\w+)+: \S)/.test(l) && !/^\s+at /.test(l))?.trim() ||
    lines.reverse().find((l) => l.trim() && !/^\s+at /.test(l) && !/^[\s{}\[\],]*$/.test(l))?.trim() ||
    "failed";
  return { reason: reason.slice(0, 240), where };
}

function runOne(job, attempt) {
  return new Promise((resolve) => {
    const label = `${job.name}${opts.repeat > 1 ? `#${job.run}` : ""}${attempt > 1 ? ` (retry ${attempt - 1})` : ""}`;
    const id = `${job.name}-${job.run}-${attempt}`;
    const logPath = path.join(out, `${id}.log`);
    // A short temp root per job (macOS keeps Unix socket paths under 104 bytes): every
    // mkdtemp in the smoke, the app, Chromium and the host lands in it.
    const dir = mkdtempSync(path.join(os.tmpdir(), "ks-"));
    const log = createWriteStream(logPath);
    const started = Date.now();
    const env = {
      ...process.env,
      TMPDIR: dir + path.sep,
      KEY_TEST_RUN_DIR: dir,
      KEY_TEST_RUN_ID: `${id}.${token}`,
      KEY_TEST_MODE: opts.visible ? "0" : (process.env.KEY_TEST_MODE ?? "1"),
      KEY_SMOKE_ARTIFACTS: path.join(out, id),
    };
    const child = spawn(process.execPath, [path.join(here, `smoke-${job.name}.cjs`)], { env, cwd: path.resolve(here, ".."), stdio: ["ignore", "pipe", "pipe"] });
    live.set(child, id);
    let text = "";
    const take = (d) => {
      log.write(d);
      if (text.length < 2e6) text += d;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const limit = timeoutOf(job.name);
    const timer = setTimeout(() => {
      timedOut = true;
      take(`\n[run-smokes] timed out after ${limit / 1000}s\n`);
      killTree(child.pid, { marker: testRunMarker(`${id}.${token}`) });
    }, limit);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      live.delete(child);
      // Whatever the smoke left behind (an app it did not close, a host) goes too.
      const leftovers = killTree(child.pid, { marker: testRunMarker(`${id}.${token}`) });
      if (leftovers) take(`\n[run-smokes] killed ${leftovers} leftover process(es)\n`);
      log.end();
      const ms = Date.now() - started;
      // Exit code 77: the smoke cannot run here (a missing prerequisite); it says why.
      const skipped = code === 77 && !timedOut;
      const ok = (code === 0 || skipped) && !timedOut;
      const { reason, where } = ok ? {} : timedOut ? { reason: `timed out after ${limit / 1000}s` } : failureLine(text, job.name);
      const artifacts = path.join(out, id);
      if (!ok) {
        // Keep the screenshots and profile of a failure next to its log.
        try {
          mkdirSync(artifacts, { recursive: true });
          execFileSync("/bin/cp", ["-R", dir + "/.", artifacts], { stdio: "ignore" });
        } catch {}
      }
      if (!opts.keep) rmSync(dir, { recursive: true, force: true });
      const result = { ok, skipped, ms, reason, where, log: logPath, dir: !ok ? artifacts : opts.keep ? dir : undefined, attempt, run: job.run, code: signal ?? code };
      process.stdout.write(`${skipped ? "skip" : ok ? "pass" : "FAIL"}  ${label.padEnd(34)} ${(ms / 1000).toFixed(1).padStart(6)}s${ok ? "" : `  ${where ? `${where}  ` : ""}${reason}`}\n`);
      resolve(result);
    });
  });
}

async function worker() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    let attempt = 1;
    for (;;) {
      const result = await runOne(job, attempt);
      if (!results.has(job.name)) results.set(job.name, []);
      results.get(job.name).push(result);
      if (result.ok || attempt > opts.retries) break;
      attempt++;
    }
  }
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    queue.length = 0;
    for (const [child, id] of live) killTree(child.pid, { marker: testRunMarker(`${id}.${token}`) });
    process.exit(130);
  });

(async () => {
  const started = Date.now();
  console.log(`Running ${queue.length} smoke run(s), ${jobs} at a time${opts.retries ? `, ${opts.retries} retr${opts.retries > 1 ? "ies" : "y"}` : ""}. Logs: ${out}`);
  if (!process.env.KEY_HOST_EXECUTABLE) console.log("Note: KEY_HOST_EXECUTABLE is not set; the app looks for the host in its default build folder.");
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
  let failed = 0;
  let flaky = 0;
  let failedRuns = 0;
  const rows = [];
  for (const name of names) {
    const rs = results.get(name) ?? [];
    const passes = rs.filter((r) => r.ok).length;
    // Per run: the last attempt decides it; a run that passed only on a retry is flaky.
    const runs = new Map();
    for (const r of rs) runs.set(r.run, r);
    const finalFails = [...runs.values()].filter((r) => !r.ok).length;
    const status = rs.length && rs.every((r) => r.skipped) ? "skip" : finalFails === 0 ? (passes < rs.length ? "flaky" : "pass") : finalFails < runs.size ? "flaky" : "fail";
    // Flaky: passed on a retry, or failed in some of the repeats (which still fails the run).
    if (status === "fail") failed++;
    else if (status === "flaky") flaky++;
    if (finalFails) failedRuns++;
    const ms = rs.map((r) => r.ms);
    const firstFail = rs.find((r) => !r.ok);
    rows.push({ name, status, passes, total: rs.length, avg: ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length), firstFail });
  }
  console.log(`\n${"smoke".padEnd(28)} ${"result".padEnd(6)} ${"passed".padStart(7)} ${"avg".padStart(7)}`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(28)} ${r.status.padEnd(6)} ${`${r.passes}/${r.total}`.padStart(7)} ${`${(r.avg / 1000).toFixed(1)}s`.padStart(7)}`);
    if (r.firstFail) {
      console.log(`    ${r.firstFail.where ? `${r.firstFail.where}: ` : ""}${r.firstFail.reason}`);
      console.log(`    log ${r.firstFail.log}${r.firstFail.dir ? `\n    files ${r.firstFail.dir}` : ""}`);
    }
  }
  const total = rows.length;
  console.log(`\n${total - failed - flaky} passed, ${flaky} flaky, ${failed} failed of ${total} in ${((Date.now() - started) / 1000).toFixed(0)}s. Logs: ${out}`);
  if (!existsSync(out)) mkdirSync(out, { recursive: true });
  process.exit(failedRuns ? 1 : 0);
})();
