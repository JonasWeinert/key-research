// Shared by fetch.mjs, publish.mjs and the smokes: Key's model manifest
// (crates/key-models/manifest.json), the folder layout the host expects, a verified copy of a
// model into that layout, and a local mock of Hugging Face's resolve endpoint (Range support).
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "../..");
const manifest = () => JSON.parse(fs.readFileSync(path.join(REPO, "crates/key-models/manifest.json"), "utf8")).models;

/** The machine-wide cache dev runs and smokes use (shared by worktrees), or KEY_DEV_MODEL_DIR. */
function devCache() {
  if (process.env.KEY_DEV_MODEL_DIR) return process.env.KEY_DEV_MODEL_DIR;
  const base = process.platform === "darwin" ? path.join(os.homedir(), "Library/Caches/Key") : path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "key");
  return path.join(base, "dev-models");
}

const sha256 = (file) => {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(1 << 20);
  for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0; ) hash.update(buffer.subarray(0, n));
  fs.closeSync(fd);
  return hash.digest("hex");
};

const modelDir = (root, spec) => path.join(root, spec.id, spec.revision);

/** Whether `root` holds the model, complete and verified (what the host's `ready` checks). */
function isReady(root, spec) {
  let stamp = {};
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(modelDir(root, spec), ".verified"), "utf8"));
  } catch {
    return false;
  }
  return spec.files.every((f) => stamp[f.path] === f.sha256 && fs.statSync(path.join(modelDir(root, spec), f.path), { throwIfNoEntry: false })?.size === f.size);
}

/** Records a verified file in the model's stamp. */
function stamp(root, spec, file) {
  const at = path.join(modelDir(root, spec), ".verified");
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(at, "utf8"));
  } catch {}
  current[file.path] = file.sha256;
  fs.writeFileSync(at, JSON.stringify(current));
}

/** Copies every model ready in `from` into `to` (a smoke's empty models folder). */
function copyReady(from, to, ids) {
  for (const spec of manifest().filter((s) => !ids || ids.includes(s.id))) {
    if (!isReady(from, spec)) continue;
    fs.cpSync(modelDir(from, spec), modelDir(to, spec), { recursive: true });
  }
}

/** A mock of `https://huggingface.co/<repo>/resolve/<revision>/<file>` serving the dev cache,
 *  with byte ranges. `delayMs` slows each response so a smoke can watch progress. */
function mockHub({ root = devCache(), delayMs = 0, ids } = {}) {
  const files = new Map();
  for (const spec of manifest().filter((s) => !ids || ids.includes(s.id)))
    for (const file of spec.files) files.set(`/${spec.repo}/resolve/${spec.revision}/${file.path}`, path.join(modelDir(root, spec), file.path));
  const requests = [];
  const server = http.createServer((req, res) => {
    const file = files.get(req.url);
    requests.push({ url: req.url, range: req.headers.range });
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const size = fs.statSync(file).size;
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    setTimeout(() => {
      res.writeHead(match ? 206 : 200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": end - start + 1,
        ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    }, delayMs);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) })),
  );
}

module.exports = { REPO, manifest, devCache, sha256, modelDir, isReady, stamp, copyReady, mockHub };
