// Web search lives in the Rust library host (crates/key-desktop-host/src/web_search): the
// providers, filters, merging, caching, retries and the keyed fallback. The main process only
// routes the renderer's `web_*` commands to the host of the right workspace, and tells every
// host the user's keys and Settings over its IPC channel (`web_options`, see services/setup.ts).
import type { AppSettings } from "../app-settings";
import type { WebResult } from "../../shared/web-search";

type Invoke = (command: string, args: Record<string, unknown>, workspaceId: string, options?: { binary?: Uint8Array }) => Promise<any>;

/** What a host is told about web search: the polite `mailto`, providers turned on or off,
 *  and each service's key with how it is used. */
export function webOptions(settings: AppSettings, keys: Record<string, { key?: string; mode: string }>) {
  const providers: Record<string, { enabled?: boolean; baseUrl?: string }> = {};
  for (const [id, entry] of Object.entries(settings.webProviders ?? {})) providers[id] = { enabled: entry.enabled, ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}) };
  // The engines' order, fallback and scholarly narrowing (the host's "web" chain).
  const engines = settings.webEngines ?? { order: [], fallback: "next", scholarly: false };
  return { mailto: settings.openalexMailto ?? "", providers, keys, engines };
}

export class WebSearch {
  constructor(
    private readonly deps: {
      invoke: Invoke;
      emit: (event: string, value?: unknown) => void;
      /** The library to ask when the caller named none (web search needs no particular one). */
      anyWorkspace: () => string | undefined;
    },
  ) {}

  handles(command: string) {
    return command.startsWith("web_") && command !== "web_options" && command !== "web_key_usage";
  }

  async handle(command: string, args: any, workspaceId: string): Promise<unknown> {
    const target = workspaceId || this.deps.anyWorkspace();
    if (!target) throw Error("Choose a workspace");
    // A merge carries every page so far: as JSON in the binary frame, which has room.
    const result =
      command === "web_merge" ? await this.deps.invoke(command, {}, target, { binary: new TextEncoder().encode(JSON.stringify(args ?? {})) }) : await this.deps.invoke(command, args ?? {}, target);
    if (command === "web_add_to_library" && result && !result.existed) this.deps.emit("library-changed");
    if (command === "web_find_pdf" && result?.status === "attached") this.deps.emit("library-changed");
    if (command === "web_add_identifiers" && Array.isArray(result) && result.some((r) => r?.status === "added")) this.deps.emit("library-changed");
    return result;
  }

  /** Adds a work (looked up by its DOI first, when it has one) as the search page does. */
  add(workspaceId: string, work: WebResult, lookup = false) {
    return this.handle("web_add_to_library", { work, lookup }, workspaceId) as Promise<{ source: { id: string }; existed: boolean; work: WebResult }>;
  }
}
