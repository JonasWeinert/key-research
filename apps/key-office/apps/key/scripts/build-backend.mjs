import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchLlama } from "./fetch-llama.mjs";
// `--release` builds the optimised host the packaged app ships (dist:mac); without it, the
// debug host development runs use.
const release = process.argv.includes("--release");
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
execFileSync(
  "cargo",
  ["build", ...(release ? ["--release"] : []), "--manifest-path", "crates/key-desktop-host/Cargo.toml"],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: "apps/key/src-tauri/target" },
  },
);

await fetchLlama(`${root}apps/key/src-tauri/target/${release ? "release" : "debug"}`);
