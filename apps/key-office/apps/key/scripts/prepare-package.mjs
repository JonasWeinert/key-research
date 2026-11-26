import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(appRoot, "../..");
const config = JSON.parse(
  readFileSync(resolve(appRoot, "package.json"), "utf8"),
);
execFileSync(process.execPath, ["tools/gen-third-party-notices.mjs"], {
  cwd: workspaceRoot,
  stdio: "inherit",
});
// The Key Sync plugin for Zotero, carried in the app for the Zotero sheet.
execFileSync(process.execPath, [resolve(appRoot, "../../../../integrations/zotero-key-sync/build.mjs")], { stdio: "inherit" });
const paths = [
  "out/main/index.js",
  "out/preload/index.js",
  "out/renderer/index.html",
  "out/renderer/pdf.html",
  ...config.build.extraResources.map((resource) => resource.from),
];
// Models are downloaded on first need (crates/key-models), never packaged.
const weights = config.build.extraResources.filter((resource) => /\.(onnx|gguf|safetensors)$|(^|\/)models(\/|$)/.test(`${resource.from} ${resource.to}`));
if (weights.length)
  throw new Error(`Model weights must not be packaged (they download on demand): ${weights.map((r) => r.from).join(", ")}`);
for (const path of paths)
  if (!existsSync(resolve(appRoot, path)))
    throw new Error(
      `Packaging input missing: ${path}. Build the Key shell and the Rust host first.`,
    );
console.log(
  "Packaging an unsigned development Key.app with the release Rust host.",
);
