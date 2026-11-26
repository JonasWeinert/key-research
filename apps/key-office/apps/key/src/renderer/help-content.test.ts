// Every help id the code names exists in help-content.ts with the right kind, every entry
// is used somewhere, and no entry outgrows its length budget.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUDGET, HELP, type HelpEntry } from "./help-content";

const root = __dirname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(tsx?|ts)$/.test(name) && !/\.test\./.test(name) && name !== "help-content.ts" ? [path] : [];
  });
const sources = files(root).map((path) => ({ path, text: readFileSync(path, "utf8") }));
const ID = /"([a-z][a-z0-9-]*\.[a-z0-9.-]+)"/g;

/** A JSX opening tag's attributes: up to its closing `>`, skipping braces and strings. */
function attributes(text: string, from: number) {
  let depth = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}
const COMPONENT_KIND: Record<string, HelpEntry["kind"]> = { Hint: "hint", Explain: "explain", EmptyState: "empty", Guide: "empty", FirstUseTip: "tip", Group: "explain", Row: "explain", SettingsFrame: "explain" };

/** Ids by the prop or call that names them, so each can be checked for its kind. */
function referenced() {
  const found: { id: string; kind: HelpEntry["kind"] | "any"; where: string }[] = [];
  for (const { path, text } of sources) {
    const where = path.slice(root.length + 1);
    // <Hint help=…>, <Explain help=…>, <EmptyState help=…> (also as Guide), <FirstUseTip help=…>,
    // Group/Row help= and intro=, EmptyState learnMore=, SettingsFrame scopeHelp=.
    for (const tag of text.matchAll(/<(Hint|Explain|EmptyState|Guide|FirstUseTip|Group|Row|SettingsFrame)\b/g)) {
      const attrs = attributes(text, tag.index! + tag[0].length);
      for (const m of attrs.matchAll(/(?:^|\s)(help|intro|learnMore|scopeHelp)=("[^"]*"|\{[^}]*\})/g)) {
        const kind = m[1] === "intro" ? "hint" : m[1] === "learnMore" ? "explain" : COMPONENT_KIND[tag[1]];
        for (const id of m[2].matchAll(ID)) found.push({ id: id[1], kind, where });
      }
    }
    for (const m of text.matchAll(/\bhintText\("([^"]+)"\)/g)) found.push({ id: m[1], kind: "hint", where });
  }
  return found;
}

describe("help content", () => {
  const refs = referenced();

  it("finds the help the code names", () => {
    expect(refs.length).toBeGreaterThan(60);
  });

  it("has every id the code names, of the kind its component shows", () => {
    const wrong = refs.filter((r) => !(r.id in HELP) || (r.kind !== "any" && HELP[r.id as keyof typeof HELP].kind !== r.kind));
    expect(wrong).toEqual([]);
  });

  it("has an explainer for every keyed service", () => {
    const registry = readFileSync(join(root, "../main/services/registry.ts"), "utf8");
    const ids = [...registry.slice(registry.indexOf("export const SERVICES")).matchAll(/^\s{4}id: "([^"]+)"/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => HELP[`settings.services.${id}` as keyof typeof HELP]?.kind !== "explain")).toEqual([]);
  });

  it("uses every entry somewhere", () => {
    const used = new Set(refs.map((r) => r.id));
    // Terms are read by the glossary, services' explainers by a built id.
    const unused = Object.entries(HELP).filter(([id, e]) => e.kind !== "term" && !id.startsWith("settings.services.") && !used.has(id));
    expect(unused.map(([id]) => id)).toEqual([]);
  });

  it("keeps every entry within its length budget", () => {
    const over: string[] = [];
    const check = (id: string, what: string, text: string, max: number) => text.length > max && over.push(`${id} ${what}: ${text.length} > ${max}`);
    for (const [id, entry] of Object.entries(HELP) as [string, HelpEntry][]) {
      if (entry.kind === "hint") check(id, "hint", entry.text, BUDGET.hint);
      if (entry.kind === "tip") check(id, "tip", entry.title + entry.body, BUDGET.tip);
      if (entry.kind === "term") check(id, "term", entry.text, BUDGET.term);
      if (entry.kind === "empty") for (const [k, v] of Object.entries({ title: entry.title, what: entry.what, todo: entry.todo })) check(id, k, v, BUDGET.empty);
      if (entry.kind === "explain") {
        check(id, "title", entry.title, BUDGET.title);
        entry.body.forEach((p, i) => check(id, `paragraph ${i + 1}`, p, BUDGET.sentence));
        check(id, "body", [...entry.body, ...(entry.steps ?? []), entry.example ?? "", entry.privacy ?? ""].join(""), BUDGET.explain);
        if ((entry.steps?.length ?? 0) > BUDGET.steps) over.push(`${id}: ${entry.steps!.length} steps`);
        entry.steps?.forEach((s, i) => check(id, `step ${i + 1}`, s, BUDGET.step));
        if (entry.body.length > 4) over.push(`${id}: ${entry.body.length} paragraphs`);
      }
    }
    expect(over).toEqual([]);
  });

  it("writes in Key's voice: sentence case, no exclamation marks", () => {
    const loud = (Object.entries(HELP) as [string, HelpEntry][]).filter(([, e]) => JSON.stringify(e).includes("!"));
    expect(loud.map(([id]) => id)).toEqual([]);
    const titles = (Object.entries(HELP) as [string, HelpEntry][]).flatMap(([id, e]) => ("title" in e ? [[id, e.title] as const] : []));
    // After the first word, a capital starts only a name (OpenAlex, Zotero, API, DOI …).
    const shouty = titles.filter(([, t]) => /\s(?:The|And|Of|To|For|With|Your|In)\s/.test(` ${t.split(" ").slice(1).join(" ")} `));
    expect(shouty).toEqual([]);
  });
});
