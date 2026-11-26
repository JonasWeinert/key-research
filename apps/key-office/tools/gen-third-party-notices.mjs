// Writes apps/key/build/THIRD-PARTY-NOTICES.txt, the acknowledgements the packaged app ships.
//
// Which npm packages ship is worked out from the code, not from package.json: electron-vite
// bundles everything the app's sources import into out/, and no node_modules folder is
// packaged. So the sources' bare imports are collected and closed over each package's runtime
// dependencies. Rust crates come from `cargo metadata` for the desktop host; native binaries,
// models and citation data have sections of their own.
//
//   node tools/gen-third-party-notices.mjs [--out <file>]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // apps/key-office
const REPO = resolve(ROOT, "../..");
const MODULES = join(ROOT, "node_modules");
const read = (path) => readFileSync(path, "utf8").trim();
const readRepo = (path) => read(join(REPO, path));

// Sources that end up in the app's bundles (tests and build scripts do not ship).
const SOURCES = [join(ROOT, "apps/key/src"), join(REPO, "apps/key/src"), ...readdirSync(join(ROOT, "packages")).map((p) => join(ROOT, "packages", p, "src"))];
const SKIP_DIRS = new Set(["node_modules", "out", "dist", "release", "target", "tests", "__tests__"]);
const SKIP_FILES = /\.(test|spec)\.[cm]?[jt]sx?$/;
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|css)$/;
const IMPORT = /(?<![.\w])(?:from|import|require)\s*\(?\s*["']([^"'\n]+)["']/g;
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const BUILTINS = new Set(builtinModules);
// Always present at run time without being imported by name.
const IMPLICIT = ["electron"];

function* files(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* files(path);
    } else if (CODE.test(entry.name) && !SKIP_FILES.test(entry.name)) yield path;
  }
}

function packageOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (BUILTINS.has(name) || name.startsWith("@key/") || name.startsWith("@key-reader/") || !PACKAGE_NAME.test(name)) return null;
  return name;
}

/** Where a package is installed: hoisted at the root, or in a workspace's own node_modules. */
function packageDir(name) {
  for (const base of [MODULES, join(ROOT, "apps/key/node_modules"), join(REPO, "apps/key/node_modules")]) {
    const dir = join(base, name);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return null;
}

const manifest = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

function shippedPackages() {
  const seeds = new Set(IMPLICIT);
  for (const source of SOURCES)
    for (const file of files(source))
      for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const name = packageOf(match[1]);
        if (name) seeds.add(name);
      }
  const found = new Map();
  const missing = [];
  const queue = [...seeds].map((name) => [name, false]);
  while (queue.length) {
    const [name, optional] = queue.shift();
    if (found.has(name)) continue;
    const dir = packageDir(name);
    found.set(name, dir && { dir, pkg: manifest(dir) });
    // A string that only looks like an import, or a platform variant for another machine.
    if (!dir) {
      if (!optional && seeds.has(name) === false) missing.push(name);
      continue;
    }
    const pkg = found.get(name).pkg;
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push([dep, false]);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push([dep, true]);
  }
  const shipped = [...found].filter(([, value]) => value).sort(([a], [b]) => a.localeCompare(b));
  return { shipped, missing };
}

const LICENSE_FILE = /^(licen[sc]e|copying)([._-].*)?$/i;
function licenseFile(dir) {
  const candidates = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort((a, b) => a.length - b.length);
  return candidates.length ? read(join(dir, candidates[0])) : null;
}
function noticeFile(dir) {
  const name = ["NOTICE", "NOTICE.txt", "NOTICE.md"].find((f) => existsSync(join(dir, f)));
  return name ? read(join(dir, name)) : null;
}
const LICENSE_AT = { electron: "dist/LICENSE" };
// Platform builds that publish no licence of their own: their parent package's applies.
const LICENSE_OF_PARENT = { "@esbuild/darwin-arm64": "esbuild", "@rollup/rollup-darwin-arm64": "rollup" };

const APACHE = readRepo("vendor/hayagriva/LICENSE-APACHE");
const MIT = readRepo("LICENSE");

/** A permissive package that declares its licence but publishes no text: the standard text. */
function standardText(spdx, pkg) {
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  const holder = (author ?? `the ${pkg.name} authors`).replace(/\s*<[^>]*>/, "").replace(/\s*\([^)]*\)/, "");
  const note = `[${pkg.name} publishes no licence file; this is the standard ${spdx} text, with the holder its package.json names.]\n\n`;
  if (spdx === "MIT") return note + MIT.replace(/^Copyright .*$/m, `Copyright (c) ${holder}`);
  if (spdx === "Apache-2.0") return note + APACHE;
  if (spdx === "ISC")
    return (
      note +
      `ISC License\n\nCopyright (c) ${holder}\n\nPermission to use, copy, modify, and/or distribute this software for any purpose\nwith or without fee is hereby granted, provided that the above copyright notice\nand this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH\nREGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND\nFITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,\nINDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS\nOF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER\nTORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF\nTHIS SOFTWARE.`
    );
  return null;
}

const spdx = (pkg) => (typeof pkg.license === "string" ? pkg.license : pkg.license?.type) ?? "see the licence text";
const repository = (pkg) => {
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return url?.replace(/^git\+/, "").replace(/\.git$/, "");
};

function rustCrates() {
  try {
    const meta = JSON.parse(
      execFileSync("cargo", ["metadata", "--format-version", "1", "--manifest-path", join(REPO, "crates/key-desktop-host/Cargo.toml")], {
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    // Key's own crates are covered by Key's licence; vendored path crates keep their own entry.
    const own = (p) => p.source == null && (p.name === "key" || p.name.startsWith("key-"));
    return meta.packages
      .filter((p) => !own(p))
      .map((p) => ({ name: p.name, version: p.version, license: p.license ?? "see repository", url: p.repository ?? `https://crates.io/crates/${p.name}`, dir: dirname(p.manifest_path) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  } catch {
    return null;
  }
}

const rule = (c) => c.repeat(72);
const section = (title) => `\n${rule("=")}\n${title}\n${rule("=")}\n`;
const entry = (title) => `\n${rule("-")}\n${title}\n${rule("-")}\n`;

let out = `Key: third-party software notices

Key's own code is MIT licensed (section 0). Key includes the third-party software, data and
binaries below; each keeps its own licence, reproduced here. LICENSES.md in Key's source
repository maps every component to its licence. Chromium, which Electron bundles, is under
BSD-style and other licences: see LICENSES.chromium.html next to this file.
`

out += section("0. Key") + entry("Key: MIT") + MIT + "\n";

// GenOffice-derived AI packages still bundled until Key's own AI client replaces them.
const genOffice = ["agent-core", "ai-provider"].filter((p) => existsSync(join(ROOT, "packages", p)));
if (genOffice.length)
  out +=
    entry(`Agent packages (${genOffice.map((p) => `packages/${p}`).join(", ")}): Apache-2.0`) +
    "Derived from GenOffice (https://github.com/genspark-ai/genoffice), Copyright 2026 Mainfunc, Inc.,\nmodified by Key. They stay under the Apache License 2.0 (text in section 5).\n";

const { shipped, missing } = shippedPackages();
out += section(`1. npm packages (${shipped.length})`);
const withoutText = [];
for (const [name, { dir, pkg }] of shipped) {
  out += entry(`${name} ${pkg.version}: ${spdx(pkg)}`);
  const parent = LICENSE_OF_PARENT[name] && packageDir(LICENSE_OF_PARENT[name]);
  const text =
    (LICENSE_AT[name] && existsSync(join(dir, LICENSE_AT[name])) ? read(join(dir, LICENSE_AT[name])) : null) ??
    licenseFile(dir) ??
    (parent ? licenseFile(parent) : null) ??
    standardText(spdx(pkg), pkg);
  if (text) out += text + "\n";
  else {
    withoutText.push(name);
    out += `Licensed under ${spdx(pkg)}.${repository(pkg) ? `\n${repository(pkg)}` : ""}\n`;
  }
  const notice = noticeFile(dir);
  if (notice) out += `\nNOTICE:\n${notice}\n`;
}

const crates = rustCrates();
out += section("2. Rust crates (Key's desktop host)");
if (!crates) out += "\ncargo metadata was not available when this file was generated; see Cargo.lock.\n";
else {
  out += `\n${crates.length} crates:\n\n` + crates.map((c) => `  ${c.name} ${c.version}: ${c.license}\n    ${c.url}\n`).join("");
  const texts = new Map();
  for (const c of crates) {
    const text = existsSync(c.dir) ? licenseFile(c.dir) : null;
    if (text && !texts.has(text)) texts.set(text, c.name);
  }
  out += entry("Crate licence texts (each text once)");
  for (const [text, first] of texts) out += `\n[as published by ${first}]\n${text}\n`;
  const notices = crates.filter((c) => existsSync(c.dir) && noticeFile(c.dir));
  if (notices.length) {
    out += entry("Crate NOTICE files");
    for (const c of notices) out += `\n[${c.name} ${c.version}]\n${noticeFile(c.dir)}\n`;
  }
}

out += section("3. Source code adapted inside Key");
out += entry("beUI (motion drawer, table and design-system primitives, adapted by Key): MIT") + "https://beui.dev\n" + read(join(ROOT, "apps/key/src/renderer/motion/BEUI-LICENSE.txt")) + "\n";

out += section("4. Native binaries");
out += entry("PDFium (Chromium build 7763, via bblanchon/pdfium-binaries)") + readRepo("vendor/pdfium/LICENSE") + "\n";
for (const f of readdirSync(join(REPO, "vendor/pdfium/licenses")).sort()) out += `\n--- Bundled in PDFium: ${f}\n` + readRepo(`vendor/pdfium/licenses/${f}`) + "\n";
const llama = ["release", "debug"].map((p) => join(REPO, "apps/key/src-tauri/target", p, "llama/LICENSE")).find(existsSync);
out +=
  entry("llama.cpp server (ggml-org/llama.cpp release build): MIT") +
  "https://github.com/ggml-org/llama.cpp\n" +
  (llama ? read(llama) : "MIT License, Copyright (c) 2023-2026 The ggml authors (fetch the release to include its LICENSE).") +
  "\n";
out +=
  entry("ONNX Runtime (linked into the Key host by the ort crate): MIT") +
  "https://github.com/microsoft/onnxruntime\nIts own third-party notices: https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt\n\n" +
  MIT.replace(/^Copyright .*$/m, "Copyright (c) Microsoft Corporation") +
  "\n";

out += section("5. Machine-learning models (downloaded on first need, not shipped)");
out += `Key includes no model weights. When a feature first needs one, Key downloads it from its
Hugging Face repository at the pinned revision, checks each file's SHA-256 and keeps it on this
computer. Each repository's model card and LICENSE name the original authors.
`;
for (const model of JSON.parse(readRepo("crates/key-models/manifest.json")).models)
  out +=
    entry(`${model.title}: ${model.license}`) +
    `${model.purpose}\nOriginal model: ${model.upstream}\nDownloaded from: https://huggingface.co/${model.repo} (revision ${model.revision})\n` +
    model.files.map((f) => `  ${f.path}  ${f.size} bytes  SHA-256 ${f.sha256}`).join("\n") +
    "\n";
out += entry("Apache License 2.0 (models above, and Apache-2.0 components without a text of their own)") + APACHE + "\n";

out += section("6. Citation Style Language styles and locales: CC BY-SA 3.0");
out += readRepo("data/citation/NOTICE") + "\n";
out += `
Licence: Creative Commons Attribution-ShareAlike 3.0 Unported,
https://creativecommons.org/licenses/by-sa/3.0/legalcode
These files ship unmodified beside the app (Key.app/Contents/Resources/citation) and are read
at run time; they are not compiled into Key's program. The same files are in Key's source
repository (data/citation). The CC BY-SA licence applies to these files, not to Key's code.
`;
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
const names = (info, tag) => [...info.matchAll(new RegExp(`<${tag}>[\\s\\S]*?<name>([^<]*)</name>[\\s\\S]*?</${tag}>`, "g"))].map((m) => unescape(m[1]));
function credits(dir, title) {
  const lines = readdirSync(join(REPO, dir))
    .filter((f) => /\.(csl|xml)$/.test(f))
    .sort()
    .map((f) => {
      const info = /<info>([\s\S]*?)<\/info>/.exec(readFileSync(join(REPO, dir, f), "utf8"))?.[1] ?? "";
      const by = [...names(info, "author"), ...names(info, "translator")];
      const helped = names(info, "contributor");
      return `${f}: ${unescape(/<title>([^<]*)<\/title>/.exec(info)?.[1] ?? f)}` + (by.length ? `\n    by ${by.join(", ")}` : "") + (helped.length ? `\n    contributors: ${helped.join(", ")}` : "");
    });
  return entry(title) + lines.join("\n") + "\n";
}
out += credits("data/citation/styles", "Styles (https://github.com/citation-style-language/styles)");
out += credits("data/citation/locales", "Locales (https://github.com/citation-style-language/locales)");

const at = process.argv.indexOf("--out");
const dest = at > 0 ? resolve(process.argv[at + 1]) : join(ROOT, "apps/key/build/THIRD-PARTY-NOTICES.txt");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, out);
console.log(`written: ${relative(ROOT, dest)} (${Math.round(out.length / 1024)} KB), ${shipped.length} npm packages, ${crates?.length ?? 0} crates`);
if (withoutText.length) console.warn(`no licence text published: ${withoutText.join(", ")}`);
if (missing.length) console.warn(`dependencies not installed: ${missing.join(", ")}`);
