// Shared pieces of the performance benchmark (bench-electron.cjs) and the perf budget smoke
// (perf-budget.cjs): launching Key on a temp profile, the process tree with RSS, macOS
// physical footprint and cumulative CPU per process, and in-page timing helpers.
const { _electron: electron } = require("playwright-core");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXTURES = path.resolve(__dirname, "../../../../../tests/fixtures");

/** Launches Key with an isolated profile; resolves once Home is on screen, with startup timings. */
async function launch({ profile, workspaces, env = {}, size = [1280, 820] }) {
  const t0 = Date.now();
  const app = await electron.launch({
    executablePath: process.env.KEY_ELECTRON_EXECUTABLE,
    // KEY_BENCH_APP: another copy of the app folder (package.json + out/), e.g. a saved build to compare against.
    args: process.env.KEY_ELECTRON_EXECUTABLE ? [] : [process.env.KEY_BENCH_APP ?? path.resolve(__dirname, "..")],
    env: {
      PDFIUM_DYNAMIC_LIB_PATH: path.resolve(__dirname, "../../../../../vendor/pdfium/lib/libpdfium.dylib"),
      ...process.env,
      KEY_SKIP_ONBOARDING: "1",
      KEY_NO_WINDOW_RESTORE: "1",
      KEY_USER_DATA: profile,
      KEY_WORKSPACE_PARENT: workspaces,
      ...env,
    },
  });
  const shell = await app.firstWindow();
  shell.setDefaultTimeout(60000);
  // Home is interactive once its region and the sidebar are rendered.
  const ready = await shell.waitForFunction(
    () => document.querySelector('[aria-label="Home"]') && document.querySelector(".key-sidebar") && performance.timeOrigin + performance.now(),
    undefined,
    { polling: "raf", timeout: 60000 },
  );
  const readyAt = await ready.jsonValue();
  const page = await shell.evaluate(() => {
    const paint = Object.fromEntries(performance.getEntriesByType("paint").map((e) => [e.name, e.startTime]));
    const nav = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource").filter((r) => /\.(js|css|mjs)$/.test(r.name));
    return {
      origin: performance.timeOrigin,
      fcp: paint["first-contentful-paint"],
      fp: paint["first-paint"],
      domContentLoaded: nav?.domContentLoadedEventEnd,
      loaded: nav?.loadEventEnd,
      scripts: resources.map((r) => ({ name: r.name.split("/").pop(), ms: Math.round(r.duration) })),
    };
  });
  const main = await app.evaluate(({ app }) => ({ pid: process.pid, start: Date.now() - process.uptime() * 1000, isPackaged: app.isPackaged, marks: globalThis.__keyStartup ?? {} }));
  if (size) await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]?.setSize(s[0], s[1]), size);
  const timings = {
    spawnToMainMs: Math.round(main.start - t0),
    mainToRendererMs: Math.round(page.origin - main.start),
    firstPaintMs: page.fp == null ? null : Math.round(page.origin + page.fp - t0),
    firstContentfulPaintMs: page.fcp == null ? null : Math.round(page.origin + page.fcp - t0),
    domContentLoadedMs: page.domContentLoaded == null ? null : Math.round(page.origin + page.domContentLoaded - t0),
    interactiveMs: Math.round(readyAt - t0),
    // Main-process steps, ms since its process started (src/main/startup-marks.ts).
    mainMarks: main.marks,
    rendererScripts: page.scripts,
  };
  return { app, shell, mainPid: main.pid, timings, isPackaged: main.isPackaged };
}

async function close(app) {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}

/** `ps` for every process, as a map pid → { ppid, rssKiB, cpuSec, command }. */
function psTable() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], { encoding: "utf8", maxBuffer: 64 << 20 });
  const table = new Map();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.-]+)\s+(.*)$/);
    if (!m) continue;
    table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), rssKiB: Number(m[3]), cpuSec: cpuSeconds(m[4]), command: m[5] });
  }
  return table;
}
function cpuSeconds(text) {
  // [[dd-]hh:]mm:ss.cc
  let days = 0;
  if (text.includes("-")) [days, text] = [Number(text.split("-")[0]), text.split("-")[1]];
  const parts = text.split(":").map(Number);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s + days * 86400;
}
function descendants(table, root) {
  const out = [];
  const walk = (pid) => {
    for (const p of table.values())
      if (p.ppid === pid) {
        out.push(p);
        walk(p.pid);
      }
  };
  const self = table.get(root);
  if (self) out.push(self);
  walk(root);
  return out;
}
/** macOS phys_footprint (what Activity Monitor calls Memory), bytes per pid. */
function footprints(pids) {
  if (process.platform !== "darwin" || !pids.length) return {};
  const result = {};
  try {
    const out = execFileSync("footprint", ["--noCategories", "-f", "bytes", ...pids.map(String)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 });
    for (const m of out.matchAll(/\[(\d+)\].*?Footprint:\s*([\d,]+)\s*B/g)) result[Number(m[1])] = Number(m[2].replace(/,/g, ""));
  } catch {}
  return result;
}

/** Every process of the app with a role: Electron's types and pages, the Rust host and its children. */
async function processes(app, mainPid, { footprint = true } = {}) {
  const meta = await app.evaluate(({ app, webContents }) => ({
    metrics: app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, serviceName: m.serviceName, name: m.name, wakeups: m.cpu.idleWakeupsPerSecond })),
    pages: webContents.getAllWebContents().map((w) => ({ pid: w.getOSProcessId(), url: w.getURL(), type: w.getType() })),
  }));
  const table = psTable();
  const tree = descendants(table, mainPid);
  const fp = footprint ? footprints(tree.map((p) => p.pid)) : {};
  const roles = tree.map((p) => {
    const m = meta.metrics.find((x) => x.pid === p.pid);
    const pages = meta.pages.filter((x) => x.pid === p.pid);
    let role;
    if (p.pid === mainPid) role = "main";
    else if (m?.type === "GPU") role = "gpu";
    else if (m?.type === "Utility") role = `utility:${m.serviceName ?? m.name ?? "?"}`;
    else if (m?.type === "Tab" || m?.type === "Renderer" || pages.length)
      role = `renderer:${pages.map((x) => pageName(x.url)).join("+") || "spare"}`;
    else if (m) role = m.type.toLowerCase();
    else role = `native:${path.basename(p.command.split(" ")[0])}${p.command.match(/\s(--key-[a-z-]+)/)?.[1]?.replace("--key-", " ") ?? ""}`;
    return { pid: p.pid, role, rssMiB: mib(p.rssKiB * 1024), footprintMiB: fp[p.pid] == null ? null : mib(fp[p.pid]), cpuSec: p.cpuSec, wakeupsPerSec: m?.wakeups };
  });
  const sum = (k) => Math.round(roles.reduce((s, r) => s + (r[k] ?? 0), 0) * 10) / 10;
  return { processes: roles, totalRssMiB: sum("rssMiB"), totalFootprintMiB: sum("footprintMiB") };
}
function pageName(url) {
  if (!url) return "blank";
  if (url.endsWith("/pdf.html")) return "pdf";
  if (/\/index\.html(#.*)?$/.test(url) || /^http:\/\/localhost:5199\/?$/.test(url)) return "shell";
  if (url.startsWith("file:") && url.includes("/modules/")) return "office";
  try {
    return `web(${new URL(url).host || url.slice(0, 24)})`;
  } catch {
    return url.slice(0, 24);
  }
}
const mib = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

/** CPU % per process over `ms` of wall time (from cumulative CPU time, so not a decaying average). */
async function cpuOver(app, mainPid, ms) {
  const before = new Map(descendants(psTable(), mainPid).map((p) => [p.pid, p.cpuSec]));
  const roles = await processes(app, mainPid, { footprint: false });
  const start = Date.now();
  await delay(ms);
  const wall = (Date.now() - start) / 1000;
  const after = descendants(psTable(), mainPid);
  const per = after.map((p) => ({
    pid: p.pid,
    role: roles.processes.find((r) => r.pid === p.pid)?.role ?? "new",
    cpuPct: Math.round(((p.cpuSec - (before.get(p.pid) ?? p.cpuSec)) / wall) * 1000) / 10,
  }));
  const wake = (await processes(app, mainPid, { footprint: false })).processes;
  for (const p of per) p.wakeupsPerSec = wake.find((w) => w.pid === p.pid)?.wakeupsPerSec;
  return { seconds: Math.round(wall), totalPct: Math.round(per.reduce((s, p) => s + p.cpuPct, 0) * 10) / 10, processes: per.filter((p) => p.cpuPct > 0 || p.wakeupsPerSec > 1) };
}

/** Wall-clock ms from `start` (Date.now) until `predicate` holds in `page`, checked every frame. */
async function until(page, predicate, arg, start, timeout = 60000) {
  const handle = await page.waitForFunction(
    ({ src, arg }) => (new Function("arg", `return (${src})(arg)`))(arg) && performance.timeOrigin + performance.now(),
    { src: predicate.toString(), arg },
    { polling: "raf", timeout },
  );
  return Math.round((await handle.jsonValue()) - start);
}

/** Frame times and long tasks while `scroller` (selector) is scrolled down in steps; one step per frame. */
async function scrollProbe(page, selector, { steps = 120, stepPx = 120 } = {}) {
  return page.evaluate(
    async ({ selector, steps, stepPx }) => {
      const el = document.querySelector(selector);
      if (!el) return { error: `no ${selector}` };
      const long = [];
      const obs = new PerformanceObserver((list) => long.push(...list.getEntries().map((e) => e.duration)));
      try {
        obs.observe({ type: "longtask", buffered: false });
      } catch {}
      const frames = [];
      let last = performance.now();
      const t0 = last;
      for (let i = 0; i < steps; i++) {
        el.scrollTop += stepPx;
        el.dispatchEvent(new Event("scroll"));
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        frames.push(now - last);
        last = now;
      }
      await new Promise((r) => setTimeout(r, 50));
      obs.disconnect();
      frames.sort((a, b) => a - b);
      const total = last - t0;
      return {
        frames: frames.length,
        fps: Math.round((frames.length / total) * 1000 * 10) / 10,
        p50FrameMs: Math.round(frames[Math.floor(frames.length * 0.5)] * 10) / 10,
        p95FrameMs: Math.round(frames[Math.floor(frames.length * 0.95)] * 10) / 10,
        maxFrameMs: Math.round(frames[frames.length - 1] * 10) / 10,
        framesOver50Ms: frames.filter((f) => f > 50).length,
        longTasks: long.length,
        longTaskMs: Math.round(long.reduce((s, d) => s + d, 0)),
        scrolledPx: el.scrollTop,
      };
    },
    { selector, steps, stepPx },
  );
}

/** Chromium CPU throttling on a page (1 = off). */
async function throttle(page, rate) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  return cdp;
}

module.exports = { launch, close, processes, cpuOver, until, scrollProbe, throttle, delay, FIXTURES, mib, psTable, descendants };
