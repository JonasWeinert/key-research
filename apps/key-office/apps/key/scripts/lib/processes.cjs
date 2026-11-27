// Process-tree helpers for smoke runs: a smoke's Electron app is detached from the node
// process that drives it (Playwright starts it in its own process group), so killing the
// driver leaves the app, its helpers and its Rust host running. These find them by ancestry
// and by the `--key-test-run=<id>` switch the launch helper puts on the app's command line.
const { execFileSync } = require("node:child_process");

const testRunMarker = (id) => `--key-test-run=${id}`;

function table() {
  try {
    return execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 32 << 20 })
      .split("\n")
      .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
  } catch {
    return [];
  }
}

/** `root` and every descendant, plus processes whose command line holds `marker` (an app that
 *  lost its parent) and theirs. Returns the pids, deepest last. */
function treeOf(root, marker) {
  const rows = table();
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid).push(r.pid);
  }
  const seeds = [root, ...(marker ? rows.filter((r) => r.pid !== process.pid && r.command.includes(marker)).map((r) => r.pid) : [])].filter(Boolean);
  const found = [];
  const seen = new Set();
  const walk = (pid) => {
    if (seen.has(pid) || pid === process.pid) return;
    seen.add(pid);
    found.push(pid);
    for (const c of children.get(pid) ?? []) walk(c);
  };
  for (const s of seeds) walk(s);
  return found;
}

/** SIGKILLs the tree; returns how many processes were still alive. Synchronous, so it also
 *  works from an `exit` handler. */
function killTree(root, { marker } = {}) {
  let killed = 0;
  for (const pid of treeOf(root, marker)) {
    try {
      process.kill(pid, "SIGKILL");
      killed++;
    } catch {}
  }
  return killed;
}

/** Test apps whose driver is gone (parent is launchd): marked ones, and Playwright-started
 *  Electron apps from a Key checkout (older runs, before the marker; any worktree). Returns their count. */
function reapOrphans(appDir) {
  let n = 0;
  for (const r of table()) {
    if (r.ppid !== 1) continue;
    const ours = r.command.includes("--key-test-run=") || ((r.command.includes(appDir) || r.command.includes("apps/key-office/apps/key")) && /Electron/.test(r.command) && /--remote-debugging-port=0|--inspect=0/.test(r.command));
    if (ours) n += killTree(r.pid);
  }
  return n;
}

module.exports = { killTree, treeOf, testRunMarker, reapOrphans };
