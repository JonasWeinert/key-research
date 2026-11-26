#!/usr/bin/env node
// Keeps vendored third-party code in step with upstream (see vendor/README.md).
//
//   node tools/vendor-update.mjs check [name] [--strict]
//       Reports vendored trees with a newer upstream release. Offline-tolerant: an
//       unreachable registry is a warning. --strict exits 1 when something is outdated
//       (or could not be checked), for CI.
//   node tools/vendor-update.mjs verify <name>
//       Rebuilds pristine upstream + the patch series in a temporary directory and fails
//       when the vendored tree differs (someone edited it by hand).
//   node tools/vendor-update.mjs update <name> [--version X] [--no-test]
//       Fetches upstream version X (default: the recorded one), replaces the vendored
//       tree, re-applies the patch series (failing loudly on any conflict), updates the
//       version pins and vendor/upstream.json, and runs the crate's tests.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "vendor/upstream.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const USER_AGENT = "key-vendor-check (vendor-update.mjs)";

const fail = (message) => {
  console.error(`vendor-update: ${message}`);
  process.exit(1);
};

function entry(name) {
  const e = manifest[name];
  if (!e || name.startsWith("$")) fail(`unknown vendored tree "${name}" (see vendor/upstream.json)`);
  return e;
}

const semver = (v) => v.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

async function getJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function latest(e) {
  if (e.kind === "crate") return (await getJson(`https://crates.io/api/v1/crates/${e.crate}`)).crate.max_stable_version;
  if (e.kind === "binary" && e.latest) {
    const tag = (await getJson(e.latest)).tag_name; // "chromium/7763"
    return tag;
  }
  return undefined;
}

async function check(only, strict) {
  let outdated = 0,
    unknown = 0;
  for (const [name, e] of Object.entries(manifest)) {
    if (name.startsWith("$") || (only && name !== only) || e.kind === "original") continue;
    try {
      const current = e.kind === "binary" ? e.build : e.version;
      const found = await latest(e);
      if (!found) continue;
      const isNewer = e.kind === "binary" ? found !== current && Number(found.split("/").pop()) > Number(current.split("/").pop()) : newer(found, current);
      if (isNewer) {
        outdated++;
        console.log(`${name}: ${current} → ${found} available`);
      } else console.log(`${name}: ${current} is current`);
    } catch (error) {
      unknown++;
      console.warn(`${name}: could not check upstream (${error.message}); skipped`);
    }
  }
  if (strict && (outdated || unknown)) process.exit(1);
}

/** The crate archive: Cargo's download cache when it has it, else crates.io. */
async function crateArchive(e, version) {
  const registry = join(homedir(), ".cargo/registry/cache");
  if (existsSync(registry)) {
    for (const index of readdirSync(registry)) {
      const cached = join(registry, index, `${e.crate}-${version}.crate`);
      if (existsSync(cached)) return readFileSync(cached);
    }
  }
  const url = `https://static.crates.io/crates/${e.crate}/${e.crate}-${version}.crate`;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) fail(`could not download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function patchSeries(e) {
  const dir = join(root, e.patches);
  const series = join(dir, "series");
  if (!existsSync(series)) return [];
  return readFileSync(series, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => join(dir, line.split("|")[0].trim()));
}

/** Pristine upstream (pruned) with the patch series applied, in a temporary directory. */
async function build(name, e, version) {
  const archive = await crateArchive(e, version);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (version === e.version && e.sha256 && sha256 !== e.sha256) fail(`${e.crate} ${version}: checksum ${sha256} does not match the recorded ${e.sha256}`);
  const work = mkdtempSync(join(tmpdir(), `vendor-${name}-`));
  writeFileSync(join(work, "crate.tgz"), archive);
  execFileSync("tar", ["-xzf", join(work, "crate.tgz"), "-C", work]);
  const tree = join(work, `${e.crate}-${version}`);
  let commit;
  try {
    commit = JSON.parse(readFileSync(join(tree, ".cargo_vcs_info.json"), "utf8")).git?.sha1;
  } catch {}
  for (const path of e.prune ?? []) rmSync(join(tree, path), { recursive: true, force: true });
  for (const patch of patchSeries(e)) {
    const args = ["-p1", "--forward", "--batch", "--fuzz=0", "-d", tree, "-i", patch];
    const dry = spawnSync("patch", ["--dry-run", ...args], { encoding: "utf8" });
    if (dry.status !== 0) fail(`patch ${patch} does not apply to ${e.crate} ${version}:\n${dry.stdout}${dry.stderr}\nRefresh it against the new upstream (or drop it if upstream fixed the issue).`);
    execFileSync("patch", ["--quiet", ...args]);
  }
  return { work, tree, sha256, commit };
}

function upstreamNote(e, version, commit) {
  return `# ${e.crate} (vendored)

- Upstream: ${e.crate} ${version} from crates.io (https://static.crates.io/crates/${e.crate}/${e.crate}-${version}.crate),
  repository ${e.repository}${commit ? `, commit ${commit}` : ""}.
- This tree is that crate, pruned (${(e.prune ?? []).join(", ")}), with the patches in
  \`${e.patches}/series\` applied in order. Do not edit it by hand: add a patch and
  run \`node tools/vendor-update.mjs update ${Object.keys(manifest).find((k) => manifest[k] === e)} --version <same version>\`.
- Wired in through \`[patch.crates-io]\` in the root \`Cargo.toml\` and
  \`crates/key-desktop-host/Cargo.toml\`; dropping the fork is deleting those lines.

Generated by tools/vendor-update.mjs.
`;
}

async function verify(name) {
  const e = entry(name);
  if (e.kind !== "crate" || !e.patches) fail(`${name} has no patch series to verify`);
  const { work, tree } = await build(name, e, e.version);
  writeFileSync(join(tree, "UPSTREAM.md"), readFileSync(join(root, e.path, "UPSTREAM.md")));
  const diff = spawnSync("diff", ["-r", "-q", "-x", ".cargo-ok", "-x", ".gitattributes", "-x", ".github", "-x", ".gitignore", tree, join(root, e.path)], { encoding: "utf8" });
  rmSync(work, { recursive: true, force: true });
  if (diff.status !== 0) fail(`${e.path} differs from ${e.crate} ${e.version} + patches:\n${diff.stdout}${diff.stderr}`);
  console.log(`${name}: matches ${e.crate} ${e.version} + ${patchSeries(e).length} patches`);
}

async function update(name, version, test) {
  const e = entry(name);
  if (e.kind !== "crate") fail(`${name} is a ${e.kind}; update it with ${e.fetch ?? "its own script"}`);
  version ||= e.version;
  const { work, tree, sha256, commit } = await build(name, e, version);
  writeFileSync(join(tree, "UPSTREAM.md"), upstreamNote(e, version, commit));
  const target = join(root, e.path);
  rmSync(target, { recursive: true, force: true });
  cpSync(tree, target, { recursive: true });
  rmSync(work, { recursive: true, force: true });
  for (const pin of e.pins ?? []) {
    const path = join(root, pin);
    const text = readFileSync(path, "utf8");
    const next = text.replace(new RegExp(`(^${e.crate}\\s*=\\s*\\{[^}\\n]*version\\s*=\\s*")=?[^"]+(")`, "m"), `$1=${version}$2`);
    if (next === text && !text.includes(`"=${version}"`)) fail(`could not update the ${e.crate} pin in ${pin}`);
    writeFileSync(path, next);
  }
  Object.assign(e, { version, sha256, commit, source: `https://static.crates.io/crates/${e.crate}/${e.crate}-${version}.crate` });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${name}: now ${e.crate} ${version} + ${patchSeries(e).length} patches`);
  if (test && e.test) {
    const run = spawnSync(e.test[0], e.test.slice(1), { cwd: root, stdio: "inherit" });
    if (run.status !== 0) fail(`${e.test.join(" ")} failed`);
  }
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const option = (name) => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : undefined;
};
const positional = rest.filter((arg, i) => !arg.startsWith("--") && !(i > 0 && rest[i - 1] === "--version"))[0];

if (command === "check") await check(positional, flag("--strict"));
else if (command === "verify") await verify(positional ?? fail("verify <name>"));
else if (command === "update") await update(positional ?? fail("update <name> [--version X]"), option("--version"), !flag("--no-test"));
else {
  console.log("usage: vendor-update.mjs check [name] [--strict] | verify <name> | update <name> [--version X] [--no-test]");
  process.exit(command ? 1 : 0);
}
