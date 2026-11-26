// Downloads Key's on-device models into a local cache for development and smokes, in the
// layout the host reads (<root>/<id>/<revision>/…, with its .verified stamp), so pointing
// KEY_MODEL_DIR at it makes the models ready without the app downloading anything.
//
//   node tools/models/fetch.mjs [ids…] [--root DIR] [--from DIR]
//
// --root   where to put them (default KEY_DEV_MODEL_DIR or ~/Library/Caches/Key/dev-models)
// --from   a folder holding the files already (an older checkout's model folders, a manual
//          download); a file is taken from there when its SHA-256 matches, else downloaded
// Sources, in order: KEY_MODELS_BASE_URL (a mirror), Key's Hugging Face repos at the pinned
// revision, then each file's upstream source. Every file is checked against the manifest.
import { createRequire } from "node:module";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const require = createRequire(import.meta.url);
const { manifest, devCache, sha256, modelDir, isReady, stamp } = require("./models.cjs");

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args.splice(at, 2)[1];
};
const root = option("--root") ?? devCache();
const from = option("--from");
const ids = args.filter((a) => !a.startsWith("--"));
const specs = manifest().filter((s) => !ids.length || ids.includes(s.id));
if (ids.length && specs.length !== ids.length) throw new Error(`Unknown model: ${ids.filter((id) => !specs.some((s) => s.id === id)).join(", ")}`);

/** Files under `dir` (a few levels), by size, for --from. */
function local(dir, depth = 4, out = new Map()) {
  if (!dir || depth < 0 || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) local(full, depth - 1, out);
    else if (entry.isFile()) out.set(statSync(full).size, [...(out.get(statSync(full).size) ?? []), full]);
  }
  return out;
}
const candidates = local(from);

async function download(url, target) {
  const response = await fetch(url, { headers: { "user-agent": "Key/0.1 (dev model fetch)" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
}

for (const spec of specs) {
  if (isReady(root, spec)) {
    console.log(`${spec.id}: ready in ${modelDir(root, spec)}`);
    continue;
  }
  for (const file of spec.files) {
    const target = join(modelDir(root, spec), file.path);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target) && statSync(target).size === file.size && sha256(target) === file.sha256) {
      stamp(root, spec, file);
      continue;
    }
    const part = `${target}.fetch`;
    const known = (candidates.get(file.size) ?? []).find((p) => sha256(p) === file.sha256);
    if (known) {
      copyFileSync(known, part);
    } else {
      const base = process.env.KEY_MODELS_BASE_URL?.replace(/\/$/, "");
      const sources = [`${base ?? "https://huggingface.co"}/${spec.repo}/resolve/${spec.revision}/${file.path}`, ...(base ? [] : [file.upstream].filter(Boolean))];
      let done = false;
      for (const url of sources) {
        try {
          console.log(`${spec.id}: ${file.path} from ${url}`);
          await download(url, part);
          done = true;
          break;
        } catch (error) {
          console.warn(`  ${error.message}`);
        }
      }
      if (!done) throw new Error(`${spec.id}: could not download ${file.path}`);
    }
    const digest = sha256(part);
    if (digest !== file.sha256) {
      rmSync(part, { force: true });
      throw new Error(`${spec.id}: ${file.path} has SHA-256 ${digest}, expected ${file.sha256}`);
    }
    renameSync(part, target);
    stamp(root, spec, file);
  }
  console.log(`${spec.id}: ready in ${modelDir(root, spec)}`);
}
console.log(`\nexport KEY_MODEL_DIR=${root}`);
