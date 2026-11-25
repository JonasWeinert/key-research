import type { WebPage, WebResult } from "../../shared/web-search";
import type { Fetch } from "./http";

/** What a provider is told about the user's settings and the app. */
export interface ProviderContext {
  /** The provider's API key from Settings, if any. */
  apiKey?: string;
  /** For providers with a polite pool (OpenAlex). */
  mailto: string;
  fetch?: Fetch;
}

export interface SearchRequest {
  limit: number;
  /** From the previous page. */
  cursor?: string;
  signal?: AbortSignal;
  filters?: { yearFrom?: number; yearTo?: number; openAccess?: boolean };
}

/** A scholarly catalogue the search page can ask. See registry.ts to add one. */
export interface WebProvider {
  id: string;
  label: string;
  /** An icon from the renderer's icon set. */
  icon: string;
  capabilities: {
    /** Takes an API key (Settings shows a field). */
    apiKey: boolean;
    keyRequired?: boolean;
    keyHelp?: string;
    /** On unless the user turns it off. */
    enabledByDefault: boolean;
  };
  search(query: string, request: SearchRequest, context: ProviderContext): Promise<WebPage>;
  /** One work by DOI or the provider's own id. */
  lookup?(id: string, context: ProviderContext & { signal?: AbortSignal }): Promise<WebResult | undefined>;
}
