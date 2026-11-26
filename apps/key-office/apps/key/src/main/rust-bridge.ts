import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface RustHostOptions {
  executable: string;
  libraryRoot: string;
  pdfiumPath?: string;
  /** Extra environment for this host only (e.g. KEY_INDEX_EMBEDDINGS=0). */
  env?: Record<string, string>;
  /** Requests sent first whenever the process starts (again): how the host learns the
   *  user's API keys, which never go through its environment. */
  prelude?: () => HostRequest[];
  /** Events the host sends unasked (id 0 frames: `library-changed` while lookups fill sources in). */
  onEvent?: (name: string) => void;
}
export interface HostRequest {
  command: string;
  args: Record<string, unknown>;
}
/** Never inherited by a host (or what it starts): keys travel over the IPC channel. */
const SECRET_ENV = /^(KEY_OPENALEX_API_KEY|KEY_.*_API_KEY|KEY_SECRET_.*)$/;
export interface InvokeOptions {
  binary?: Uint8Array;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** The call follows a click or keystroke (the preload passes `navigator.userActivation`). */
  gesture?: boolean;
  /** A priority class for this call (see the host's priority.rs); else the host's table. */
  priority?: PriorityClass;
}
/** The host's priority classes, best first (crates/key-store/src/priority.rs). */
export type PriorityClass = "interactive" | "foreground" | "visible" | "background" | "idle";
const CLASSES: PriorityClass[] = ["interactive", "foreground", "visible", "background", "idle"];
/** The host's table of command classes (`host_priority_table`, crates/key-desktop-host/src/priority.rs). */
type PriorityTable = { default: PriorityClass; classes: Record<string, PriorityClass>; slowPrefixes: string[]; quick: string[] };
type Response = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  binaryLength: number;
  /** The body is the JSON result (too large for the control frame). */
  json?: boolean;
};
type Pending = {
  id: number;
  command: string;
  args: Record<string, unknown>;
  options: InvokeOptions;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  urgent: boolean;
  /** Work nobody is waiting on (polls, cache refreshes): never ahead of a user action. */
  background: boolean;
  /** Index into CLASSES: lower goes first. */
  rank: number;
  /** Waits on the network or runs long: a few at a time, so quick calls always find a slot. */
  slow: boolean;
  queuedAt: number;
  /** A newer request with the same key replaces this one while it waits (`$supersede`). */
  supersede?: string;
  /** Identical background requests waiting together share one answer. */
  key?: string;
  followers?: { resolve: (value: any) => void; reject: (error: Error) => void }[];
  bytes: number;
};
const MAX_JSON = 1024 * 1024;
const MAX_BINARY = 32 * 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const URGENT = new Set(["native_cancel_render", "processing_interaction"]);
/** Commands that are always background work. Any other call can mark itself with
 *  `$background: true` in its arguments (taken out before it is sent). */
const BACKGROUND = new Set(["store_status", "store_refresh", "store_zotero_sync", "store_zotero_progress", "store_zotero_status", "store_zotero_plugin_status", "store_linked_sync", "store_index_priority", "store_enrich_options"]);
/** In flight at once: regular requests, and how many of those may be background or slow work,
 *  so a user action always finds a free slot; interactive calls have headroom beyond that. */
const IN_FLIGHT = 6;
const INTERACTIVE_HEADROOM = 4;
const BACKGROUND_IN_FLIGHT = 2;
const SLOW_IN_FLIGHT = 3;
const BACKGROUND_QUEUED = 64;
/** Waiting this long counts as one class better, so background work still moves. */
const AGING_MS = 2000;
/** Network commands, until the host's table says otherwise. */
const SLOW_FALLBACK = /^(web_search|web_lookup|web_find_pdf|web_add_identifiers|scholarly_|global_search|store_zotero_|store_import_zotero|feeds_refresh|feeds_discover|feeds_subscribe|store_openalex_)/;

/** One supervised host per workspace. Failed operations are never replayed implicitly. */
export class RustHost {
  private child?: ChildProcessWithoutNullStreams;
  private queue: Pending[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private queuedBytes = 0;
  private closed = false;
  private stderr = "";
  private chunks: Buffer[] = [];
  private chunkOffset = 0;
  private available = 0;
  private headerLength?: number;
  private response?: Response;
  private table?: PriorityTable;
  constructor(private readonly options: RustHostOptions) {}

  /** The class and lane of a call: the caller's hint, then the host's table. */
  private classify(command: string, args: Record<string, unknown>, options: InvokeOptions): { rank: number; slow: boolean } {
    const table = this.table;
    const slow = table ? !table.quick.includes(command) && table.slowPrefixes.some((p) => command.startsWith(p)) : SLOW_FALLBACK.test(command);
    let name: PriorityClass | undefined =
      (typeof args.$priority === "string" && CLASSES.includes(args.$priority as PriorityClass) ? (args.$priority as PriorityClass) : undefined) ?? options.priority;
    if (!name && (args.$background === true || BACKGROUND.has(command))) name = "background";
    if (!name) name = table?.classes[command] ?? table?.default ?? "foreground";
    if (options.gesture && (name === "foreground" || name === "visible")) name = "interactive";
    // Network work never counts as interactive (it would hold the user's lane for seconds).
    if (slow && name === "interactive") name = "foreground";
    return { rank: CLASSES.indexOf(name), slow };
  }

  /** Replaces the requests sent on (re)start; a running process is not told (send it yourself). */
  setPrelude(prelude: () => HostRequest[]): void {
    this.options.prelude = prelude;
  }
  isRunning(): boolean {
    return !!this.child;
  }

  invoke<T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
    options: InvokeOptions = {},
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("Workspace backend is closed"));
    if (options.binary && options.binary.byteLength > MAX_BINARY)
      return Promise.reject(
        new Error("Binary request exceeds 32 MiB; use ranges"),
      );
    const binary = options.binary ? Buffer.from(options.binary) : undefined;
    if (binary && binary.length > MAX_BINARY)
      return Promise.reject(
        new Error("Binary request exceeds 32 MiB; use ranges"),
      );
    const bytes =
      (binary?.length ?? 0) + Buffer.byteLength(JSON.stringify(args));
    if (bytes - (binary?.length ?? 0) > MAX_JSON - 1024)
      return Promise.reject(new Error("Control request exceeds 1 MiB"));
    const urgent = URGENT.has(command);
    const { rank, slow } = this.classify(command, args, options);
    const background = !urgent && rank >= CLASSES.indexOf("background");
    const supersede = typeof args.$supersede === "string" ? args.$supersede : undefined;
    if ("$background" in args || "$priority" in args || "$supersede" in args) {
      args = { ...args };
      delete args.$background;
      delete args.$priority;
      delete args.$supersede;
    }
    // A newer keystroke's query replaces the one still waiting to be sent.
    if (supersede)
      for (const old of this.queue.filter((p) => p.supersede === supersede)) {
        this.queue.splice(this.queue.indexOf(old), 1);
        this.queuedBytes -= old.bytes;
        clearTimeout(old.timer);
        this.settle(old, undefined, new Error("Superseded by a newer request"));
      }
    // The same background request already waiting: share its answer.
    const key = background ? `${command}\u0000${JSON.stringify(args)}` : undefined;
    const twin = key && this.queue.find((p) => p.key === key);
    if (twin)
      return new Promise<T>((resolve, reject) => (twin.followers ??= []).push({ resolve, reject }));
    // User actions are never turned away for being many; background work is, and makes room.
    if (background && this.queue.filter((p) => p.background).length >= BACKGROUND_QUEUED)
      return Promise.reject(new Error("Background work is queued; skipped this round"));
    while (this.queuedBytes + bytes > MAX_QUEUED_BYTES && this.dropBackground()) {}
    if (
      (urgent && [...this.queue, ...this.pending.values()].filter((p) => p.urgent).length >= 8) ||
      this.queuedBytes + bytes > MAX_QUEUED_BYTES + (urgent ? 64 * 1024 : 0)
    )
      return Promise.reject(
        new Error("Workspace request queue is full; retry shortly"),
      );
    return new Promise<T>((resolve, reject) => {
      const request: Pending = {
        id: this.nextId++,
        command,
        args,
        options: { ...options, binary },
        resolve,
        reject,
        urgent,
        background,
        rank,
        slow,
        queuedAt: Date.now(),
        supersede,
        key,
        bytes,
      };
      this.queuedBytes += bytes;
      // Deadlines include queue time. A timed-out sent mutation has an unknown outcome and is not replayed.
      request.timer = setTimeout(
        () => {
          const index = this.queue.indexOf(request);
          if (index >= 0) {
            this.queue.splice(index, 1);
            this.queuedBytes -= request.bytes;
            this.settle(request, undefined, new Error(`${command} timed out while queued`));
            return;
          }
          if (this.pending.has(request.id))
            this.fail(
              new Error(`${command} timed out; reload state before retrying`),
            );
        },
        options.timeoutMs ??
          (command === "workspace_scan_linked_folder" ? 300_000 : 60_000),
      );
      // Urgent first, then by class (interactive, foreground, visible, background, idle),
      // in order within a class.
      if (request.urgent) this.queue.unshift(request);
      else {
        const after = this.queue.findIndex((p) => !p.urgent && p.rank > request.rank);
        this.queue.splice(after < 0 ? this.queue.length : after, 0, request);
      }
      try {
        this.start();
        this.drain();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private start(): void {
    if (this.child) return;
    this.stderr = "";
    const child = spawn(
      this.options.executable,
      ["--library", this.options.libraryRoot],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !SECRET_ENV.test(name))),
          ...(this.options.pdfiumPath
            ? {
                PDFIUM_DYNAMIC_LIB_PATH: this.options.pdfiumPath,
                // The semantic extractor uses its own PDFium binding.
                PDFIUM_LIB_PATH: this.options.pdfiumPath,
              }
            : {}),
          ...this.options.env,
        },
      },
    );
    this.child = child;
    this.queuePrelude();
    this.fetchTable();
    child.stdout.on("data", (data: Buffer) => {
      if (this.child !== child) return;
      this.chunks.push(data);
      this.available += data.length;
      try {
        this.parse();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-8192);
    });
    child.on("error", (error) => {
      if (this.child === child) this.fail(error);
    });
    child.on("exit", (code, signal) => {
      if (this.child === child)
        this.fail(
          new Error(
            `Workspace backend exited (${signal ?? code}): ${this.stderr.slice(-1000)}`,
          ),
        );
    });
    child.stdin.on("error", (error) => {
      if (this.child === child) this.fail(error);
    });
  }
  /** The prelude goes ahead of everything waiting; its answers are not awaited by anyone. */
  private queuePrelude(): void {
    let requests: HostRequest[] = [];
    try {
      requests = this.options.prelude?.() ?? [];
    } catch {}
    for (const { command, args } of requests.reverse()) {
      const bytes = Buffer.byteLength(JSON.stringify(args));
      this.queuedBytes += bytes;
      this.queue.unshift({ id: this.nextId++, command, args, options: {}, resolve: () => {}, reject: () => {}, urgent: true, background: false, rank: 0, slow: false, queuedAt: Date.now(), bytes });
    }
  }
  /** Asks the host for its priority table (an older host does not know it: the fallbacks stay). */
  private fetchTable(): void {
    const child = this.child;
    const request: Pending = {
      id: this.nextId++,
      command: "host_priority_table",
      args: {},
      options: {},
      resolve: (value: unknown) => {
        const table = value as Partial<PriorityTable> | undefined;
        if (this.child === child && table && typeof table.classes === "object" && Array.isArray(table.slowPrefixes) && Array.isArray(table.quick))
          this.table = { default: table.default ?? "foreground", classes: table.classes, slowPrefixes: table.slowPrefixes, quick: table.quick };
      },
      reject: () => {},
      urgent: true,
      background: false,
      rank: 0,
      slow: false,
      queuedAt: Date.now(),
      bytes: 2,
    };
    this.queuedBytes += request.bytes;
    this.queue.unshift(request);
  }
  /** The class a waiting request goes at now: one better per AGING_MS waited. */
  private effectiveRank(request: Pending, now: number): number {
    return Math.max(0, request.rank - Math.floor((now - request.queuedAt) / AGING_MS));
  }
  private drain(): void {
    if (!this.child) return;
    while (this.queue.length) {
      const sent = [...this.pending.values()];
      const regular = sent.filter((p) => !p.urgent).length;
      const background = sent.filter((p) => p.background).length;
      const slow = sent.filter((p) => p.slow && !p.urgent).length;
      const urgent = sent.length - regular;
      const allowed = (p: Pending) =>
        p.urgent
          ? urgent < 8
          : p.slow && slow >= SLOW_IN_FLIGHT
            ? false
            : p.background
              ? regular < IN_FLIGHT && background < BACKGROUND_IN_FLIGHT
              : regular < IN_FLIGHT + (p.rank === 0 && !p.slow ? INTERACTIVE_HEADROOM : 0);
      // The best request that may go now: urgent, then by class with aging, then in order.
      const now = Date.now();
      let index = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const p = this.queue[i];
        if (!allowed(p)) continue;
        if (index < 0 || (!this.queue[index].urgent && (p.urgent || this.effectiveRank(p, now) < this.effectiveRank(this.queue[index], now)))) index = i;
        if (p.urgent) break;
      }
      if (index < 0) break;
      const [request] = this.queue.splice(index, 1);
      // Once sent it is no longer a twin later requests can join.
      request.key = undefined;
      this.pending.set(request.id, request);
      const header = Buffer.from(
        JSON.stringify({
          id: request.id,
          command: request.command,
          args: request.args,
          headers: { "x-key-class": request.urgent ? "interactive" : CLASSES[request.rank], ...(request.supersede ? { "x-key-supersede": request.supersede } : {}), ...(request.options.headers ?? {}) },
          binaryLength: request.options.binary?.length ?? 0,
        }),
      );
      if (header.length > MAX_JSON) {
        this.fail(new Error("Control frame exceeds 1 MiB"));
        return;
      }
      const prefix = Buffer.allocUnsafe(4);
      prefix.writeUInt32LE(header.length);
      // Writes are synchronous queue operations, so frames from different invocations cannot interleave.
      this.child.stdin.cork();
      this.child.stdin.write(prefix);
      this.child.stdin.write(header);
      if (request.options.binary?.length)
        this.child.stdin.write(request.options.binary);
      this.child.stdin.uncork();
    }
  }
  private take(length: number): Buffer {
    const out = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const first = this.chunks[0];
      const count = Math.min(length - written, first.length - this.chunkOffset);
      first.copy(out, written, this.chunkOffset, this.chunkOffset + count);
      written += count;
      this.chunkOffset += count;
      if (this.chunkOffset === first.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }
    this.available -= length;
    return out;
  }
  private parse(): void {
    while (true) {
      if (this.headerLength === undefined && !this.response) {
        if (this.available < 4) return;
        this.headerLength = this.take(4).readUInt32LE();
        if (this.headerLength === 0 || this.headerLength > MAX_JSON)
          throw new Error("Invalid backend control frame");
      }
      if (!this.response) {
        if (this.available < this.headerLength!) return;
        const response = JSON.parse(
          this.take(this.headerLength!).toString(),
        ) as Response & { event?: string };
        this.headerLength = undefined;
        if (response.id === 0 && typeof response.event === "string" && !response.binaryLength) {
          try {
            this.options.onEvent?.(response.event);
          } catch {}
          continue;
        }
        if (
          !Number.isSafeInteger(response.id) ||
          typeof response.ok !== "boolean" ||
          !Number.isSafeInteger(response.binaryLength) ||
          response.binaryLength < 0 ||
          response.binaryLength > MAX_BINARY
        )
          throw new Error("Invalid backend response");
        this.response = response;
      }
      if (this.available < this.response.binaryLength) return;
      const response = this.response;
      this.response = undefined;
      const binary = response.binaryLength
        ? this.take(response.binaryLength)
        : undefined;
      const request = this.pending.get(response.id);
      if (!request) throw new Error("Unexpected backend response identifier");
      this.pending.delete(response.id);
      this.queuedBytes -= request.bytes;
      clearTimeout(request.timer);
      if (response.ok)
        this.settle(
          request,
          // A large JSON answer arrives as the body (see the host's ipc.rs).
          response.json && binary
            ? JSON.parse(binary.toString())
            : binary
              ? new Uint8Array(
                  binary.buffer,
                  binary.byteOffset,
                  binary.byteLength,
                )
              : response.result,
        );
      else
        this.settle(request, undefined, new Error(response.error ?? "Workspace operation failed"));
      this.drain();
    }
  }
  private fail(error: Error): void {
    const child = this.child;
    this.child = undefined;
    child?.stdin.destroy();
    child?.kill();
    for (const request of [...this.queue, ...this.pending.values()]) {
      clearTimeout(request.timer);
      this.settle(request, undefined, error);
    }
    this.queue = [];
    this.pending.clear();
    this.queuedBytes = 0;
    this.chunks = [];
    this.chunkOffset = 0;
    this.available = 0;
    this.headerLength = undefined;
    this.response = undefined;
  }
  /** Answers a request and everyone who joined it. */
  private settle(request: Pending, value: unknown, error?: Error): void {
    for (const waiter of [request, ...(request.followers ?? [])]) {
      if (error) waiter.reject(error);
      else waiter.resolve(value);
    }
  }
  /** Makes room by giving up the newest queued background request. */
  private dropBackground(): boolean {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const request = this.queue[i];
      if (!request.background) continue;
      this.queue.splice(i, 1);
      this.queuedBytes -= request.bytes;
      clearTimeout(request.timer);
      this.settle(request, undefined, new Error(`${request.command} skipped to make room`));
      return true;
    }
    return false;
  }
  isIdle(): boolean {
    return this.queue.length === 0 && this.pending.size === 0;
  }
  close(): void {
    this.closed = true;
    this.fail(new Error("Workspace backend closed"));
  }
}
