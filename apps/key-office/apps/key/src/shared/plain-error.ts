// Errors in words a researcher can act on: what happened, why, and what to do next. A
// technical error (a socket code, an HTTP status, a file system code) becomes a plain
// sentence; anything else is kept as the host or service wrote it, without the IPC prefix.

const PREFIX = /^(Error invoking remote method '[^']+': )?(\w*Error: )*/;

/** The error's own text, without "Error invoking remote method …: Error: ". */
export const rawError = (error: unknown) => String((error as Error)?.message ?? error ?? "").replace(PREFIX, "").trim();

const RULES: [RegExp, string][] = [
  [
    /ENOTFOUND|EAI_AGAIN|ENETUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|getaddrinfo|fetch failed|network is unreachable|no internet|dns error|failed to lookup address/i,
    "Key could not reach the internet. Check that this Mac is online, then try again.",
  ],
  [/ECONNREFUSED|ECONNRESET|socket hang up|connection (was )?(reset|refused|closed)|EPIPE/i, "The connection to the service was cut off. Try again in a moment; if it keeps happening, the service may be down."],
  [/ETIMEDOUT|timed? ?out|deadline has elapsed/i, "The service took too long to answer. Try again; a slow or busy network can cause this."],
  [/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|api key (is )?(invalid|missing|wrong)/i, "The service turned the request down. Its API key may be missing, wrong or expired: check it in Key Settings › Services."],
  [/\b429\b|too many requests|rate.?limit/i, "The service asked Key to slow down. Wait a minute, then try again."],
  [/\b50[0234]\b|bad gateway|service unavailable|internal server error/i, "The service had a problem on its side. Nothing is wrong with your library; try again later."],
  [/ENOSPC|no space left/i, "This Mac’s disk is full. Free up some space, then try again."],
  [/EACCES|EPERM|permission denied|operation not permitted/i, "macOS did not let Key open this. Check the file’s permissions, or allow Key in System Settings › Privacy & Security."],
  [/ENOENT|no such file|not found on disk|file is missing/i, "The file is not where Key expected it. It may have been moved or renamed, or it is on a disk that is not connected."],
  [/host (is not running|exited|stopped)|channel closed|broken pipe|the library host/i, "Key’s library engine stopped. It starts again by itself; try again in a moment."],
];

/** A plain sentence for a technical error, or the error's own text when it already reads as one. */
export function plainError(error: unknown): string {
  const raw = rawError(error);
  for (const [pattern, text] of RULES) if (pattern.test(raw)) return text;
  return raw || "Something unexpected stopped it. Try again; if it keeps happening, restart Key.";
}

/** "Could not save the page. Key could not reach the internet. …" */
export function couldNot(doing: string, error: unknown): string {
  const text = plainError(error);
  return `Could not ${doing}. ${/[.!?”]$/.test(text) ? text : `${text}.`}`;
}
