// The AI providers Key can use (Key Settings › AI assistant): how each is reached, where a
// key comes from, and a few suggested models with a plain word on cost and speed. Any other
// model id the provider offers can be typed or picked from its live list. Prices are rough
// list prices in US dollars per million tokens, for the up-front estimate only.

export type Protocol = "anthropic" | "openai";

export interface ModelInfo {
  id: string;
  label: string;
  /** One line: what it is good for, how fast and how costly. */
  summary: string;
  /** $ per million input / output tokens (0 for local models). */
  price?: [number, number];
  recommended?: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  /** The base URL can be changed (local servers, gateways). */
  editableUrl?: boolean;
  /** Runs on this Mac: no key, nothing leaves the computer. */
  local?: boolean;
  keyRequired: boolean;
  keyUrl?: string;
  keyUrlLabel?: string;
  /** How to get a key, in two or three short steps. */
  keySteps?: string[];
  summary: string;
  models: ModelInfo[];
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    keyRequired: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyUrlLabel: "console.anthropic.com",
    keySteps: ["Sign in at console.anthropic.com and add a little credit under Billing.", "Open API keys and choose Create key.", "Copy the key (it starts with sk-ant-) and paste it here."],
    summary: "Claude models. Careful readers of long papers.",
    models: [
      { id: "claude-haiku-4-5", label: "Claude Haiku", summary: "Fast and inexpensive. Good for most fill recipes.", price: [1, 5], recommended: true },
      { id: "claude-sonnet-4-5", label: "Claude Sonnet", summary: "More careful with hard extractions; slower and costs more.", price: [3, 15] },
      { id: "claude-opus-4-1", label: "Claude Opus", summary: "The most capable; slow and expensive. Rarely needed.", price: [15, 75] },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyRequired: true,
    keyUrl: "https://platform.openai.com/api-keys",
    keyUrlLabel: "platform.openai.com",
    keySteps: ["Sign in at platform.openai.com and add credit under Billing.", "Open API keys and choose Create new secret key.", "Copy the key (it starts with sk-) and paste it here."],
    summary: "GPT models.",
    models: [
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", summary: "Fast and inexpensive. Good for most fill recipes.", price: [0.4, 1.6], recommended: true },
      { id: "gpt-4.1", label: "GPT-4.1", summary: "More careful; costs about five times as much.", price: [2, 8] },
      { id: "gpt-4.1-nano", label: "GPT-4.1 nano", summary: "The cheapest; fine for simple yes/no and labels.", price: [0.1, 0.4] },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyRequired: true,
    keyUrl: "https://aistudio.google.com/apikey",
    keyUrlLabel: "aistudio.google.com",
    keySteps: ["Sign in at aistudio.google.com with a Google account.", "Choose Get API key, then Create API key.", "Copy the key and paste it here."],
    summary: "Gemini models, with a free tier for light use.",
    models: [
      { id: "gemini-2.5-flash", label: "Gemini Flash", summary: "Fast and inexpensive, with a free tier.", price: [0.3, 2.5], recommended: true },
      { id: "gemini-2.5-pro", label: "Gemini Pro", summary: "More careful; slower and costs more.", price: [1.25, 10] },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keyRequired: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyUrlLabel: "platform.deepseek.com",
    keySteps: ["Sign in at platform.deepseek.com and top up a small balance.", "Open API keys and create one.", "Copy the key and paste it here."],
    summary: "Low-cost models.",
    models: [{ id: "deepseek-chat", label: "DeepSeek Chat", summary: "Very inexpensive; good general quality.", price: [0.27, 1.1], recommended: true }],
  },
  {
    id: "kimi",
    name: "Kimi (Moonshot)",
    protocol: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    keyRequired: true,
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    keyUrlLabel: "platform.moonshot.ai",
    summary: "Kimi models with long context.",
    models: [{ id: "kimi-latest", label: "Kimi", summary: "Long context; moderate cost.", price: [0.6, 2.5], recommended: true }],
  },
  {
    id: "glm",
    name: "GLM (Zhipu)",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyRequired: true,
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    keyUrlLabel: "open.bigmodel.cn",
    summary: "GLM models.",
    models: [{ id: "glm-4-flash", label: "GLM Flash", summary: "Fast and inexpensive.", price: [0.1, 0.1], recommended: true }],
  },
  {
    id: "ollama",
    name: "Ollama (on this Mac)",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1",
    editableUrl: true,
    local: true,
    keyRequired: false,
    keyUrl: "https://ollama.com/download",
    keyUrlLabel: "ollama.com",
    keySteps: ["Install Ollama from ollama.com and open it.", "In Terminal, run: ollama pull llama3.1", "Choose Test: Key lists the models Ollama has."],
    summary: "Runs models on this Mac. Free, private, slower.",
    models: [{ id: "llama3.1", label: "Llama 3.1 8B", summary: "Runs locally; nothing leaves this Mac. Slower than cloud models.", price: [0, 0], recommended: true }],
  },
  {
    id: "lmstudio",
    name: "LM Studio (on this Mac)",
    protocol: "openai",
    baseUrl: "http://localhost:1234/v1",
    editableUrl: true,
    local: true,
    keyRequired: false,
    keyUrl: "https://lmstudio.ai",
    keyUrlLabel: "lmstudio.ai",
    keySteps: ["Install LM Studio from lmstudio.ai and download a model.", "Open the Developer tab and start the server.", "Choose Test: Key lists the loaded models."],
    summary: "Runs models on this Mac. Free, private, slower.",
    models: [],
  },
  {
    id: "custom",
    name: "Other (OpenAI-compatible)",
    protocol: "openai",
    baseUrl: "",
    editableUrl: true,
    keyRequired: false,
    summary: "Any service or gateway that speaks the OpenAI chat API.",
    models: [],
  },
];

export const providerInfo = (id: string) => PROVIDERS.find((p) => p.id === id);

/** A base URL a provider may use: HTTPS, or HTTP to this Mac only; no credentials in it. */
export function checkBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw Error("Enter the server's address, like http://localhost:11434/v1");
  }
  if (url.username || url.password) throw Error("Leave the user name and password out of the address");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw Error("Use https:// for servers that are not on this Mac");
  if (!["http:", "https:"].includes(url.protocol)) throw Error("The address must start with https:// (or http:// for this Mac)");
  return url.toString().replace(/\/$/, "");
}

/** Rough cost in US dollars, or undefined when the model's price is not known. */
export function estimateCost(providerId: string, model: string, tokensIn: number, tokensOut: number): number | undefined {
  const info = providerInfo(providerId);
  if (info?.local) return 0;
  const price = info?.models.find((m) => m.id === model)?.price;
  if (!price) return undefined;
  return (tokensIn * price[0] + tokensOut * price[1]) / 1_000_000;
}
