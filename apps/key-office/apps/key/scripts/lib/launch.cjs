// The one way smokes, the screenshot recorder and the benchmarks start Key: Playwright's
// `_electron.launch` with the app's test mode on (src/main/test-mode.ts), so a run never
// shows a window, takes focus, reads or writes the system clipboard, or sees the person
// using the Mac. Use it as Playwright's `_electron`:
//   const { electron } = require("./lib/launch.cjs");
//   const app = await electron.launch({ args, env });
// What it adds:
// - KEY_TEST_MODE=1 (KEY_TEST_MODE=0 in the environment runs the app visibly, as before);
// - a per-run temp folder (KEY_TEST_RUN_DIR) and defaults that keep the app off the person's
//   data: Zotero folders, browser profiles to import from, the workspace parent;
// - no network but loopback: other hosts fail to resolve (Chromium) and attempts are listed in
//   the run's network log; `network: "allow"` in the launch options (or KEY_TEST_NETWORK=allow)
//   opts a smoke out;
// - `app.close()` that always ends the app's whole process tree, also when the smoke throws;
// - `page.bringToFront()` that focuses the page's window virtually instead of activating it.
const { _electron } = require("playwright-core");
const { mkdirSync, mkdtempSync, readFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { killTree, testRunMarker } = require("./processes.cjs");

const launched = new Set();
process.on("exit", () => {
  for (const app of launched) {
    try {
      killTree(app.__keyPid, { marker: app.__keyMarker });
    } catch {}
  }
});

/** Chromium's resolver: only loopback, plus whatever the smoke maps itself. */
function resolverRules(args) {
  const i = args.findIndex((a) => a.startsWith("--host-resolver-rules="));
  const own = i >= 0 ? args[i].slice("--host-resolver-rules=".length) : "";
  const rules = [own, "MAP * ~NOTFOUND", "EXCLUDE localhost", "EXCLUDE 127.0.0.1", "EXCLUDE [::1]", "EXCLUDE *.localhost"].filter(Boolean).join(", ");
  const rest = args.filter((_, j) => j !== i);
  return [...rest, `--host-resolver-rules=${rules}`];
}

function defaults(env, dir) {
  const set = (key, value) => {
    if (env[key] === undefined || env[key] === "") env[key] = value;
  };
  const sub = (name) => {
    const p = path.join(dir, name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  set("KEY_USER_DATA", sub("profile"));
  set("KEY_WORKSPACE_PARENT", sub("workspaces"));
  // The person's Zotero and browsers are never read.
  set("KEY_ZOTERO_PROFILE_ROOT", sub("zotero-profiles"));
  set("KEY_ZOTERO_DATA_DIR", sub("zotero-data"));
  set("KEY_COOKIE_IMPORT_HOME", sub("home"));
  set("KEY_PROXY_IMPORT_HOME", sub("home"));
}

async function launch(options = {}) {
  const { network, ...rest } = options;
  const env = { ...(rest.env ?? process.env) };
  const test = (env.KEY_TEST_MODE ?? process.env.KEY_TEST_MODE) !== "0";
  let args = [...(rest.args ?? [])];
  const id = env.KEY_TEST_RUN_ID || `${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const marker = testRunMarker(id);
  if (test) {
    const dir = env.KEY_TEST_RUN_DIR || mkdtempSync(path.join(os.tmpdir(), "key-run-"));
    mkdirSync(dir, { recursive: true });
    env.KEY_TEST_MODE = "1";
    env.KEY_TEST_RUN_DIR = dir;
    env.KEY_TEST_RUN_ID = id;
    defaults(env, dir);
    if ((network ?? env.KEY_TEST_NETWORK) !== "allow") args = resolverRules(args);
  }
  // The marker finds the app (and its tree) later, even after it lost its parent.
  args.push(marker);
  // With no executable given, the app folder comes first (Playwright runs the bundled Electron).
  const app = await _electron.launch({ ...rest, args, env });
  app.__keyMarker = marker;
  const pid = app.process().pid;
  app.__keyPid = pid;
  launched.add(app);
  const close = app.close.bind(app);
  app.close = async () => {
    try {
      await Promise.race([close(), new Promise((resolve) => setTimeout(resolve, 15_000))]);
    } finally {
      killTree(pid, { marker });
      launched.delete(app);
      if (test) reportNetwork(env);
    }
  };
  if (test) patchPages(app);
  return app;
}

/** Hosts the app tried to reach (main/test-mode.ts logs them). KEY_TEST_NETWORK=strict fails
 *  the smoke for them. */
function reportNetwork(env) {
  let lines = [];
  try {
    lines = readFileSync(path.join(env.KEY_TEST_RUN_DIR, "test-mode.log"), "utf8")
      .split("\n")
      .filter((l) => l.includes(" network: "))
      .map((l) => l.split(" network: ")[1]);
  } catch {}
  if (!lines.length) return;
  console.error(`[launch] the app tried to reach hosts other than loopback (blocked):\n  ${lines.join("\n  ")}`);
  if (env.KEY_TEST_NETWORK === "strict") process.exitCode = 1;
}

/** `page.bringToFront()` would activate the app and put its window over the person's work;
 *  in test mode it focuses that window in the app's virtual model. */
function patchPages(app) {
  const patch = (page) => {
    const proto = Object.getPrototypeOf(page);
    if (proto.__keyPatched) return;
    proto.__keyPatched = true;
    const original = proto.bringToFront;
    proto.bringToFront = async function () {
      const owner = this.context?.()?._keyElectronApp;
      if (!owner) return original.call(this);
      const mark = `kx-front-${Math.random().toString(36).slice(2)}`;
      await this.evaluate((m) => void (window.__keyFrontMark = m), mark);
      await owner.evaluate(async ({ BrowserWindow, webContents }, m) => {
        for (const contents of webContents.getAllWebContents()) {
          if (contents.isDestroyed()) continue;
          const found = await contents.executeJavaScript("window.__keyFrontMark", false).catch(() => undefined);
          if (found !== m) continue;
          const window = BrowserWindow.fromWebContents(contents) ?? BrowserWindow.getAllWindows().find((w) => w.contentView.children.some((v) => v.webContents === contents));
          window?.focus();
          contents.focus();
          return;
        }
      }, mark);
    };
  };
  app.context()._keyElectronApp = app;
  for (const page of app.windows()) patch(page);
  app.on("window", patch);
}

module.exports = { electron: { launch }, launch };
