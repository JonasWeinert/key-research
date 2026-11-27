// Key's own minimal AI client: one completion request in a provider-neutral shape, sent to
// Anthropic's Messages API or any OpenAI-compatible chat endpoint (OpenAI, Gemini, DeepSeek,
// local servers such as Ollama and LM Studio). Retries rate limits and server errors with
// backoff, times out, caps the answer, and reports token use. Prompts are built and answers
// validated by the library host (key-store's fill.rs); this only carries them.
import type { Protocol } from "./providers";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface Endpoint {
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** A local server: longer timeout, one request at a time. */
  local?: boolean;
}

/** What the host hands over for one answer. */
export interface CompletionRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object where the endpoint supports it. */
  json?: boolean;
}

export interface Completion {
  content: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Worth trying again later (rate limit, server busy, network). */
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const MAX_ANSWER = 64 * 1024;
const trim = (url: string) => url.replace(/\/+$/, "");

function headers(endpoint: Endpoint): Record<string, string> {
  if (endpoint.protocol === "anthropic")
    return { "content-type": "application/json", "x-api-key": endpoint.apiKey ?? "", "anthropic-version": "2023-06-01" };
  return { "content-type": "application/json", ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) };
}

function body(endpoint: Endpoint, request: CompletionRequest, json: boolean) {
  const maxTokens = Math.min(Math.max(request.maxTokens ?? 400, 16), 4096);
  if (endpoint.protocol === "anthropic")
    return {
      model: endpoint.model,
      max_tokens: maxTokens,
      system: request.system,
      temperature: request.temperature ?? 0,
      messages: [{ role: "user", content: request.prompt }],
    };
  return {
    model: endpoint.model,
    max_tokens: maxTokens,
    temperature: request.temperature ?? 0,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.prompt },
    ],
    ...(json ? { response_format: { type: "json_object" } } : {}),
  };
}

/** A provider's error as one plain sentence. */
async function failure(response: Response, name: string): Promise<AiError> {
  let detail = "";
  try {
    const data = (await response.json()) as { error?: { message?: string } | string; message?: string };
    detail = typeof data.error === "string" ? data.error : (data.error?.message ?? data.message ?? "");
  } catch {
    /* not JSON */
  }
  detail = detail.slice(0, 200);
  const after = Number(response.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 60_000) : undefined;
  switch (response.status) {
    case 401:
    case 403:
      return new AiError(`${name} refused the key${detail ? `: ${detail}` : ""}`, response.status);
    case 404:
      return new AiError(`${name} does not know this model or address${detail ? `: ${detail}` : ""}`, 404);
    case 429:
      return new AiError(`${name} is rate limiting requests${detail ? `: ${detail}` : ""}`, 429, true, retryAfterMs);
    default:
      if (response.status >= 500) return new AiError(`${name} had a problem (HTTP ${response.status})`, response.status, true, retryAfterMs);
      return new AiError(`${name} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
  }
}

function read(endpoint: Endpoint, data: any): Completion {
  if (endpoint.protocol === "anthropic") {
    const content = (Array.isArray(data?.content) ? data.content : [])
      .filter((part: any) => part?.type === "text")
      .map((part: any) => String(part.text ?? ""))
      .join("");
    return { content, tokensIn: Number(data?.usage?.input_tokens) || 0, tokensOut: Number(data?.usage?.output_tokens) || 0, model: String(data?.model ?? endpoint.model) };
  }
  const message = data?.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((p: any) => p?.text ?? "").join("") : "";
  return { content, tokensIn: Number(data?.usage?.prompt_tokens) || 0, tokensOut: Number(data?.usage?.completion_tokens) || 0, model: String(data?.model ?? endpoint.model) };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new AiError("Stopped"));
    });
  });

/** One completion, retried up to `attempts` times on rate limits, server errors and network
 * failures (exponential backoff, or the provider's Retry-After). */
export async function complete(
  endpoint: Endpoint,
  request: CompletionRequest,
  options: { fetch?: Fetch; signal?: AbortSignal; attempts?: number; name?: string; baseDelayMs?: number } = {},
): Promise<Completion> {
  const name = options.name ?? "The AI provider";
  const url = endpoint.protocol === "anthropic" ? `${trim(endpoint.baseUrl)}/v1/messages` : `${trim(endpoint.baseUrl)}/chat/completions`;
  const attempts = options.attempts ?? 3;
  let json = request.json === true;
  let last: AiError | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.signal?.aborted) throw new AiError("Stopped");
    const timeout = AbortSignal.timeout(endpoint.local ? 180_000 : 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(url, { method: "POST", headers: headers(endpoint), body: JSON.stringify(body(endpoint, request, json)), signal });
    } catch (error) {
      if (options.signal?.aborted) throw new AiError("Stopped");
      last = new AiError(
        timeout.aborted ? `${name} did not answer in time` : endpoint.local ? `Couldn't reach ${name}. Is it running?` : `Couldn't reach ${name}`,
        undefined,
        true,
      );
      await sleep((options.baseDelayMs ?? 800) * 2 ** attempt, options.signal);
      continue;
    }
    if (!response.ok) {
      const error = await failure(response, name);
      // Some OpenAI-compatible servers do not know `response_format`: ask again without it.
      if (json && response.status === 400 && /response_format|json/i.test(error.message)) {
        json = false;
        attempt--;
        continue;
      }
      if (!error.retryable) throw error;
      last = error;
      await sleep(error.retryAfterMs ?? (options.baseDelayMs ?? 800) * 2 ** attempt, options.signal);
      continue;
    }
    const text = await response.text();
    if (text.length > 4 * MAX_ANSWER) throw new AiError(`${name} sent an answer that is too long`);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new AiError(`${name} sent an answer Key could not read`);
    }
    const completion = read(endpoint, data);
    if (completion.content.length > MAX_ANSWER) completion.content = completion.content.slice(0, MAX_ANSWER);
    return completion;
  }
  throw last ?? new AiError(`${name} did not answer`);
}

/** The models an endpoint offers (its live list), or an error that says why not. */
export async function listModels(endpoint: Omit<Endpoint, "model">, options: { fetch?: Fetch; name?: string } = {}): Promise<string[]> {
  const name = options.name ?? "The AI provider";
  const url = endpoint.protocol === "anthropic" ? `${trim(endpoint.baseUrl)}/v1/models?limit=100` : `${trim(endpoint.baseUrl)}/models`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { method: "GET", headers: headers({ ...endpoint, model: "" }), signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new AiError(endpoint.local ? `Couldn't reach ${name}. Is it running?` : `Couldn't reach ${name}`, undefined, true);
  }
  if (!response.ok) throw await failure(response, name);
  const data = (await response.json().catch(() => ({}))) as { data?: { id?: string }[]; models?: { name?: string; id?: string }[] };
  const list = data.data ?? data.models ?? [];
  return [...new Set(list.map((m: any) => String(m.id ?? m.name ?? "")).filter(Boolean))].slice(0, 300);
}

/** Runs at most `limit` tasks at once and starts them at least `spacingMs` apart; a rate
 * limit (`slowDown`) doubles the spacing for a while. */
export class Throttle {
  private active = 0;
  private queue: (() => void)[] = [];
  private nextAt = 0;
  constructor(
    private limit: number,
    private spacingMs: number,
  ) {}
  slowDown() {
    this.spacingMs = Math.min(Math.max(this.spacingMs * 2, 500), 20_000);
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      const wait = this.nextAt - Date.now();
      this.nextAt = Math.max(Date.now(), this.nextAt) + this.spacingMs;
      if (wait > 0) await sleep(wait);
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
