#!/usr/bin/env node
// Opens, updates and closes one GitHub issue per database connector from a live health report
// (`tools/connectors/test --live --report live.json`), compared with the same tests replayed on
// the recorded fixtures (`--report fixtures.json`, the last answers known to be good).
//
//   node tools/connectors/health-issues.mjs live.json fixtures.json
//
// Needs GITHUB_TOKEN (issues: write) and GITHUB_REPOSITORY. With DRY_RUN=1 it prints instead.
import { readFileSync } from "node:fs";

const [livePath, goodPath] = process.argv.slice(2);
if (!livePath) {
  console.error("usage: health-issues.mjs live.json [fixtures.json]");
  process.exit(2);
}
const read = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
};
const live = read(livePath);
const good = goodPath ? read(goodPath) : [];
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const dry = process.env.DRY_RUN === "1" || !token || !repo;
const LABEL = "connector-health";

async function api(method, path, body) {
  if (dry) {
    console.log(`[dry run] ${method} ${path}`, body ? JSON.stringify(body).slice(0, 400) : "");
    return method === "GET" ? [] : {};
  }
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "key-connectors-health" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? {} : res.json();
}

const byConnector = new Map();
for (const o of live) {
  if (!byConnector.has(o.connector)) byConnector.set(o.connector, []);
  byConnector.get(o.connector).push(o);
}

const fence = (text) => "```\n" + String(text ?? "").replaceAll("```", "'''").slice(0, 3000) + "\n```";

function body(id, outcomes) {
  const failing = outcomes.filter((o) => !o.passed);
  const lines = [
    `The scheduled live check of the **${id}** connector failed (${new Date().toISOString().slice(0, 10)}).`,
    "",
    "| test | live | last good (fixture) |",
    "| --- | --- | --- |",
  ];
  for (const o of outcomes) {
    const g = good.find((x) => x.connector === id && x.test === o.test);
    const show = (x) => (x ? `${x.passed ? "ok" : "failed"}: total ${x.total ?? "n/a"}, ${x.records} records` : "n/a");
    lines.push(`| ${o.test} | ${show(o)} | ${show(g)} |`);
  }
  for (const o of failing) {
    lines.push("", `### ${o.test}`, "", "Failures:", fence(o.failures.join("\n")));
    if (o.request) lines.push("Request (keys removed):", fence(o.request));
    if (o.excerpt) lines.push("Start of the answer:", fence(o.excerpt));
    lines.push(`Native query: \`${o.native}\``);
  }
  lines.push(
    "",
    "Reproduce:",
    fence(`tools/connectors/test --live --id ${id}`),
    "If the service changed, fix `connectors/specs/" + id + ".json`, bump its version, record new fixtures with `tools/connectors/test --record --id " + id + "`, and open a pull request. The **connectors-autofix** workflow can propose one.",
    "",
    "<!-- key-connector-health -->",
  );
  return lines.join("\n");
}

const open = await api("GET", `/repos/${repo}/issues?state=open&labels=${LABEL}&per_page=100`);
const issueFor = (id) => open.find((i) => i.title.startsWith(`Connector ${id}:`));

let failures = 0;
for (const [id, outcomes] of byConnector) {
  const failing = outcomes.filter((o) => !o.passed);
  const existing = issueFor(id);
  if (failing.length) {
    failures += 1;
    const title = `Connector ${id}: live check failing`;
    const labels = [LABEL, `connector:${id}`];
    if (existing) {
      await api("PATCH", `/repos/${repo}/issues/${existing.number}`, { body: body(id, outcomes) });
      await api("POST", `/repos/${repo}/issues/${existing.number}/comments`, { body: `Still failing on ${new Date().toISOString().slice(0, 10)}: ${failing.map((o) => o.failures[0]).join("; ").slice(0, 500)}` });
    } else {
      await api("POST", `/repos/${repo}/issues`, { title, body: body(id, outcomes), labels });
    }
  } else if (existing) {
    await api("POST", `/repos/${repo}/issues/${existing.number}/comments`, { body: `The live check passes again (${new Date().toISOString().slice(0, 10)}). Closing.` });
    await api("PATCH", `/repos/${repo}/issues/${existing.number}`, { state: "closed", state_reason: "completed" });
  }
}
console.log(`${byConnector.size} connectors checked, ${failures} failing`);
