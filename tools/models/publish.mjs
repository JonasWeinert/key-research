// Publishes Key's models to their Hugging Face repos and pins the app to the new revisions.
//
//   hf auth login                         (once, as the owner of the repos)
//   node tools/models/fetch.mjs           (the verified files, in the dev cache)
//   node tools/models/publish.mjs [ids…] [--dry-run]
//
// For each model: stages <scratch>/<repo name>/ with README.md (tools/models/cards/<id>.md),
// LICENSE (Apache-2.0 text) and the files, checked against the manifest; creates the public
// repo if needed; uploads in one commit; then writes that commit's id into
// crates/key-models/manifest.json as the model's revision. Commit the manifest afterwards.
// --dry-run stages and prints the commands without running them.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { REPO, manifest, devCache, sha256, modelDir } = require("./models.cjs");

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const ids = args.filter((a) => !a.startsWith("--"));
const root = process.env.KEY_DEV_MODEL_DIR ?? devCache();
const manifestPath = join(REPO, "crates/key-models/manifest.json");
const licence = join(REPO, "apps/key-office/LICENSE");
const run = (command, argv) => {
  console.log(`$ ${command} ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  return dry ? "" : execFileSync(command, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
};

if (!dry) run("hf", ["auth", "whoami"]);
const pinned = {};
for (const spec of manifest().filter((s) => !ids.length || ids.includes(s.id))) {
  const stage = join(tmpdir(), "key-models-publish", spec.repo.split("/")[1]);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  copyFileSync(join(REPO, "tools/models/cards", `${spec.id}.md`), join(stage, "README.md"));
  copyFileSync(licence, join(stage, "LICENSE"));
  for (const file of spec.files) {
    const source = join(modelDir(root, spec), file.path);
    if (sha256(source) !== file.sha256) throw new Error(`${spec.id}: ${source} does not match the manifest; run fetch.mjs first`);
    mkdirSync(dirname(join(stage, file.path)), { recursive: true });
    copyFileSync(source, join(stage, file.path));
  }
  console.log(`\n${spec.id}: staged in ${stage}`);
  run("hf", ["repos", "create", spec.repo, "--type", "model", "--public", "--exist-ok"]);
  run("hf", ["upload", spec.repo, stage, ".", "--commit-message", `Add ${spec.title} for Key (unmodified from ${spec.upstream})`]);
  if (dry) continue;
  const info = JSON.parse(execFileSync("curl", ["-fsSL", `https://huggingface.co/api/models/${spec.repo}`], { encoding: "utf8" }));
  pinned[spec.id] = info.sha;
  console.log(`${spec.id}: https://huggingface.co/${spec.repo}/tree/${info.sha}`);
}

if (Object.keys(pinned).length) {
  const data = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const model of data.models) if (pinned[model.id]) model.revision = pinned[model.id];
  writeFileSync(manifestPath, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`\nPinned ${Object.keys(pinned).join(", ")} in crates/key-models/manifest.json. Move the dev cache folders too:`);
  for (const [id, sha] of Object.entries(pinned)) console.log(`  mv ${join(root, id, "main")} ${join(root, id, sha)}`);
}
