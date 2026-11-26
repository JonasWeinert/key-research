// Checks the plugin's scripts and packs src/ into dist/key-sync.xpi (a zip).
//   node integrations/zotero-key-sync/build.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const out = join(root, "dist", "key-sync.xpi");

const files = readdirSync(src).filter((f) => !f.startsWith("."));
for (const file of files.filter((f) => f.endsWith(".js"))) execFileSync(process.execPath, ["--check", join(src, file)], { stdio: "inherit" });
const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
if (!manifest.applications?.zotero?.id) throw new Error("manifest.json needs applications.zotero.id");
for (const required of ["bootstrap.js", "key-sync.js", "key-sync-core.js", "prefs.js", "preferences.xhtml", "preferences.js"])
  if (!files.includes(required)) throw new Error(`Missing ${required}`);

mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
// -X leaves out extended attributes; -D no directory entries; files sorted for a stable archive.
execFileSync("zip", ["-q", "-X", "-D", out, ...files.sort()], { cwd: src, stdio: "inherit" });
console.log(`Built ${out} (Key Sync ${manifest.version})`);
