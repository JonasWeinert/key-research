// Fails when an added or changed line of the shell's renderer CSS uses a raw color
// (#hex, rgb(), hsl(), oklch()…) outside a custom-property definition. Chrome colors go
// through native.css's kx-* tokens (see CLAUDE.md); only lines that define a token
// (`--name: …;`) may hold raw values. Only the diff is checked, so old lines never fail.
//
//   node tools/check-theme-colors.mjs [--base <ref>]   (default base: main)
import { spawnSync } from "node:child_process";

const at = process.argv.indexOf("--base");
const base = at > 0 ? process.argv[at + 1] : process.env.THEME_BASE_REF || "main";
const SCOPE = /^apps\/key-office\/apps\/key\/src\/renderer\/.+\.css$/;
const RAW = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/i;
const DEFINITION = /^\s*--[\w-]+\s*:/;
const COMMENT = /^\s*(\/\*|\*)/;

const git = (...args) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
};

const root = git("rev-parse", "--show-toplevel").trim();
// Committed changes since the merge base, plus whatever is not committed yet.
const diff = git("-C", root, "diff", "--unified=0", "--no-color", `${git("-C", root, "merge-base", base, "HEAD").trim()}`, "--", "*.css");
const problems = [];
let file = null;
let line = 0;
for (const text of diff.split("\n")) {
  if (text.startsWith("+++ ")) file = text.startsWith("+++ b/") ? text.slice(6) : null;
  else if (text.startsWith("@@")) line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0);
  else if (text.startsWith("+") && file) {
    const body = text.slice(1);
    if (SCOPE.test(file) && RAW.test(body) && !DEFINITION.test(body) && !COMMENT.test(body)) problems.push(`${file}:${line}: ${body.trim()}`);
    line++;
  }
}
if (problems.length) {
  console.error(`Raw colors in renderer CSS (use kx-* tokens, or define a token):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("Theme colors: no raw colors in changed renderer CSS.");
