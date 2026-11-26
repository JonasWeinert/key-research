#!/usr/bin/env node
// Builds the context pack a coding agent gets to repair a broken connector: the spec, the
// format (SPEC.md), the failing live test output, the start of the service's answer, the last
// good fixture (trimmed) and a prompt. The agent edits connectors/specs/<id>.json only; the
// workflow then validates, re-records fixtures, runs the tests and opens a pull request for a
// person to review. Nothing is merged or signed automatically.
//
//   node tools/connectors/fix-context.mjs <id> live.json out-dir
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [id, livePath, out] = process.argv.slice(2);
if (!id || !out) {
  console.error("usage: fix-context.mjs <connector-id> live.json out-dir");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const spec = `connectors/specs/${id}.json`;
cpSync(spec, join(out, `${id}.json`));
cpSync("connectors/SPEC.md", join(out, "SPEC.md"));
cpSync("connectors/schema/connector-1.schema.json", join(out, "connector-1.schema.json"));
let live = [];
try {
  live = JSON.parse(readFileSync(livePath, "utf8")).filter((o) => o.connector === id);
} catch {}
writeFileSync(join(out, "failing-tests.json"), JSON.stringify(live, null, 2));
const fixtures = `connectors/fixtures/${id}`;
if (existsSync(fixtures)) {
  for (const f of readdirSync(fixtures)) {
    const fixture = JSON.parse(readFileSync(join(fixtures, f), "utf8"));
    for (const e of fixture.exchanges ?? []) e.body = String(e.body ?? "").slice(0, 20000);
    writeFileSync(join(out, `last-good-${f}`), JSON.stringify(fixture, null, 2));
  }
}
const failures = live.filter((o) => !o.passed).map((o) => `- ${o.test}: ${o.failures.join("; ")}`).join("\n");
writeFileSync(
  join(out, "PROMPT.md"),
  `# Repair the ${id} database connector

The scheduled live check of the Key connector \`${id}\` fails:

${failures || "(see failing-tests.json)"}

Files here: \`${id}.json\` (the spec, a copy of \`${spec}\`), \`SPEC.md\` (the format),
\`connector-1.schema.json\`, \`failing-tests.json\` (the failing request with keys removed and the
start of the service's answer), \`last-good-*.json\` (answers recorded when it last worked).

Do this:
1. Work out what the service changed (URL, parameters, answer structure, field names).
2. Edit \`${spec}\` only, using the operations SPEC.md describes. No code, no new hosts unless the
   service really moved (say so in the pull request), keep the tests generic.
3. Bump the spec's \`version\` (patch for a fix).
4. Run \`tools/connectors/validate\` and \`tools/connectors/test --record --id ${id}\` until they pass.
5. Summarise the cause and the change in a few lines for the pull request.

If the service is gone or now needs a login, do not guess: write that in the summary instead.
`,
);
console.log(`context pack for ${id} in ${out}`);
