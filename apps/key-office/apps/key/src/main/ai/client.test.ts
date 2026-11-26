import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiError, Throttle, complete, listModels } from "./client";
import { AiService, migrateSettings, secretFor } from "./service";
import { checkBaseUrl, estimateCost } from "./providers";

type Handler = (request: IncomingMessage, body: any) => { status?: number; json?: unknown; headers?: Record<string, string> };

let server: Server;
let base = "";
let handler: Handler;
const seen: { url: string; headers: IncomingMessage["headers"]; body: any }[] = [];

beforeEach(async () => {
  seen.length = 0;
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      const body = text ? JSON.parse(text) : undefined;
      seen.push({ url: request.url ?? "", headers: request.headers, body });
      const out = handler(request, body);
      response.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
      response.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

const request = { system: "Be brief", prompt: "Hello", maxTokens: 50, json: true };

describe("Key's AI client", () => {
  it("speaks the OpenAI chat API and reports tokens", async () => {
    handler = () => ({ json: { model: "m1", choices: [{ message: { content: '{"value": 1}' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } } });
    const answer = await complete({ protocol: "openai", baseUrl: `${base}/v1`, model: "m1", apiKey: "sk-test" }, request);
    expect(answer).toEqual({ content: '{"value": 1}', tokensIn: 12, tokensOut: 3, model: "m1" });
    expect(seen[0].url).toBe("/v1/chat/completions");
    expect(seen[0].headers.authorization).toBe("Bearer sk-test");
    expect(seen[0].body.messages[0]).toEqual({ role: "system", content: "Be brief" });
    expect(seen[0].body.response_format).toEqual({ type: "json_object" });
  });

  it("speaks Anthropic's Messages API", async () => {
    handler = () => ({ json: { model: "claude", content: [{ type: "text", text: "Hi" }], usage: { input_tokens: 5, output_tokens: 1 } } });
    const answer = await complete({ protocol: "anthropic", baseUrl: base, model: "claude", apiKey: "sk-ant" }, request);
    expect(answer.content).toBe("Hi");
    expect(seen[0].url).toBe("/v1/messages");
    expect(seen[0].headers["x-api-key"]).toBe("sk-ant");
    expect(seen[0].body.system).toBe("Be brief");
  });

  it("retries rate limits and server errors, then gives up with a plain message", async () => {
    let calls = 0;
    handler = () => (++calls < 3 ? { status: calls === 1 ? 429 : 503, json: { error: { message: "slow down" } } } : { json: { choices: [{ message: { content: "ok" } }] } });
    const answer = await complete({ protocol: "openai", baseUrl: base, model: "m" }, request, { baseDelayMs: 5 });
    expect(answer.content).toBe("ok");
    expect(calls).toBe(3);
    handler = () => ({ status: 503 });
    await expect(complete({ protocol: "openai", baseUrl: base, model: "m" }, request, { baseDelayMs: 5, name: "Mock" })).rejects.toThrow("Mock had a problem (HTTP 503)");
  });

  it("does not retry a refused key, and asks again without JSON mode when a server rejects it", async () => {
    handler = () => ({ status: 401, json: { error: { message: "bad key" } } });
    const error = await complete({ protocol: "openai", baseUrl: base, model: "m" }, request, { name: "Mock" }).catch((e) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error.message).toBe("Mock refused the key: bad key");
    expect(seen).toHaveLength(1);
    seen.length = 0;
    handler = (_r, body) => (body.response_format ? { status: 400, json: { error: { message: "response_format is not supported" } } } : { json: { choices: [{ message: { content: "plain" } }] } });
    expect((await complete({ protocol: "openai", baseUrl: base, model: "m" }, request)).content).toBe("plain");
    expect(seen).toHaveLength(2);
  });

  it("lists models and says when a local server is not running", async () => {
    handler = () => ({ json: { data: [{ id: "llama3.1" }, { id: "qwen" }] } });
    expect(await listModels({ protocol: "openai", baseUrl: `${base}/v1` })).toEqual(["llama3.1", "qwen"]);
    await expect(listModels({ protocol: "openai", baseUrl: "http://127.0.0.1:1", local: true }, { name: "Ollama" })).rejects.toThrow("Couldn't reach Ollama. Is it running?");
  });

  it("throttles concurrency", async () => {
    const throttle = new Throttle(2, 0);
    let active = 0;
    let most = 0;
    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        throttle.run(async () => {
          most = Math.max(most, ++active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(most).toBe(2);
  });

  it("checks addresses and estimates cost", () => {
    expect(checkBaseUrl("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
    expect(() => checkBaseUrl("http://example.com/v1")).toThrow("https://");
    expect(() => checkBaseUrl("https://user:pw@example.com")).toThrow("password");
    expect(estimateCost("openai", "gpt-4.1-mini", 1_000_000, 0)).toBeCloseTo(0.4);
    expect(estimateCost("ollama", "anything", 5, 5)).toBe(0);
  });
});

class MemorySecrets {
  values = new Map<string, string>();
  get(name: string) {
    return this.values.get(name);
  }
  info(name: string) {
    const v = this.values.get(name);
    return v ? { set: true, hint: v.slice(-4) } : { set: false };
  }
  status() {
    return { backend: "local", reason: "tests", locked: false };
  }
  async set(name: string, value: string) {
    this.values.set(name, value);
  }
  async delete(name: string) {
    this.values.delete(name);
  }
}

describe("AI settings", () => {
  it("move keys out of older settings files into the secret store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "key-ai-"));
    const path = join(dir, "ai-settings.json");
    await writeFile(path, JSON.stringify({ provider: "openai", providers: { openai: { apiKey: " sk-old ", model: "gpt-4.1" }, codex: { apiKey: "" } } }));
    const secrets = new MemorySecrets();
    const service = new AiService({ settingsPath: path, secrets: () => secrets as any, invoke: (async () => ({})) as any, emit: () => {}, noTimers: true });
    const status: any = await service.handle("ai_status", {});
    expect(status).toMatchObject({ configured: true, provider: "openai", model: "gpt-4.1" });
    expect(secrets.get(secretFor("openai"))).toBe("sk-old");
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(JSON.stringify(saved)).not.toContain("sk-old");
    expect(migrateSettings({ baseUrl: "http://localhost:1234/v1", model: "x" }).settings.provider).toBe("custom");
  });

  it("drives a fill run: sends the host's requests and hands back the answers", async () => {
    handler = () => ({ json: { choices: [{ message: { content: '{"value": "A"}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } } });
    const dir = await mkdtemp(join(tmpdir(), "key-ai-"));
    const secrets = new MemorySecrets();
    const answers: any[] = [];
    let asked = false;
    const invoke = async (command: string, args: any) => {
      if (command === "store_fill_run_create") return { id: "run1", status: "running", recipe: args.recipe };
      if (command === "store_fill_run") return { run: { id: "run1", status: asked && answers.length === 2 ? "done" : "running", recipe: { method: "ai" } } };
      if (command === "store_fill_run_next") {
        if (asked) return { requests: [], status: "done" };
        asked = true;
        return { requests: ["s1", "s2"].map((sourceId) => ({ sourceId, system: "s", prompt: "p", maxTokens: 20 })), status: "running" };
      }
      if (command === "store_fill_run_answer") return answers.push(args), { status: "running" };
      return [];
    };
    const events: any[] = [];
    const service = new AiService({ settingsPath: join(dir, "ai.json"), secrets: () => secrets as any, invoke: invoke as any, emit: (_e, v) => events.push(v), noTimers: true });
    await service.handle("ai_choose", { provider: "custom" });
    await service.handle("ai_set_base_url", { provider: "custom", baseUrl: `${base}/v1` });
    await service.handle("ai_set_model", { provider: "custom", model: "mock" });
    await service.handle("fill_start", { recipe: { method: "ai" }, ids: ["s1", "s2"] }, "w1");
    for (let i = 0; i < 40 && events.at(-1)?.run?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 50));
    expect(answers.map((a) => [a.sourceId, a.content, a.tokensIn])).toEqual([
      ["s1", '{"value": "A"}', 10],
      ["s2", '{"value": "A"}', 10],
    ]);
    expect(events.at(-1).run.status).toBe("done");
  });
});
