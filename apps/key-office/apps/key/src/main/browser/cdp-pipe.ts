// The DevTools protocol over a pipe (`--remote-debugging-pipe`): the browser reads commands on
// its fd 3 and writes replies and events on fd 4, each a JSON message ended by a NUL byte. No
// port is opened, so no other process on this Mac can reach the browser this way.
import type { Readable, Writable } from "node:stream";

export type CdpEvent = (method: string, params: Record<string, any>, sessionId?: string) => void;

export class CdpPipe {
  private next = 1;
  private calls = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private buffer = "";
  private listeners = new Set<CdpEvent>();
  closed = false;

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\0")) >= 0) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        this.receive(raw);
      }
    });
    const close = () => this.close();
    input.on("close", close);
    input.on("error", close);
    out.on("error", close);
  }

  private receive(raw: string) {
    let message: { id?: number; method?: string; params?: Record<string, any>; result?: any; error?: { message?: string }; sessionId?: string };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const call = this.calls.get(message.id);
      this.calls.delete(message.id);
      if (message.error) call?.reject(Error(message.error.message || "DevTools error"));
      else call?.resolve(message.result ?? {});
    } else if (message.method) for (const listener of this.listeners) listener(message.method, message.params ?? {}, message.sessionId);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(Error("The sign-in window is closed"));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(Error(`${method} timed out`));
      }, timeoutMs);
      this.calls.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      this.out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }

  on(listener: CdpEvent) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.calls.values()) call.reject(Error("The sign-in window is closed"));
    this.calls.clear();
  }
}
