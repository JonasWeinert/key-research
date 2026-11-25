// The web search providers, in the order their results interleave.
//
// To add a provider: write one file next to this one that exports a `WebProvider`
// (see provider.ts; openalex.ts is a small example: build the request, map each record to a
// `WebResult` with a parse function you can test against a recorded response), then add it
// to this list. Settings (on/off, API key), the Web pill on the search page, merging,
// retries, caching and "Add to library" pick it up from here; nothing else needs to change.
// Let its base URL be overridden by an environment variable so smokes can point it at a mock.
import { openalex } from "./openalex";
import type { WebProvider } from "./provider";
import { semanticScholar } from "./semantic-scholar";

export const PROVIDERS: WebProvider[] = [openalex, semanticScholar];
