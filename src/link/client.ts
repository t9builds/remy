/** The clients' end of the link (protocol.ts): the coordinator's channel, and one-off requests from the CLI. */
import { createConnection, type Socket } from "node:net";
import type { PermissionRequest } from "../messengers/messenger";
import { type LinkEvent, type Request, readLines, send, type ToClient } from "./protocol";

export type ClientHandlers = {
  event(e: LinkEvent): void | Promise<void>;
  permission(request_id: string, behavior: "allow" | "deny"): void | Promise<void>;
  /** The link came up (`true`) or went down (`false`). */
  state?(up: boolean): void;
  /** A newer coordinator took over; this one won't reconnect. */
  replaced?(): void;
  log(...a: unknown[]): void;
};

/** The coordinator's end: connects, says hello, and reconnects whenever the daemon goes away. */
export class LinkClient {
  private socket?: Socket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(
    readonly path: string,
    private handlers: ClientHandlers,
    private retryMs = 2_000,
  ) {}

  get connected() {
    return !!this.socket;
  }

  start() {
    this.connect();
    return this;
  }

  /** Whether the link is up, waiting up to `ms` for it. */
  async connectedWithin(ms: number) {
    for (const until = Date.now() + ms; !this.socket && Date.now() < until; ) await Bun.sleep(50);
    return this.connected;
  }

  close() {
    this.closed = true;
    this.socket?.destroy();
  }

  private connect() {
    if (this.closed) return;
    const s = createConnection(this.path);
    s.on("connect", () => {
      this.socket = s;
      send(s, { type: "hello" });
      this.handlers.state?.(true);
    });
    s.on("error", () => {});
    s.on("close", () => {
      const wasUp = this.socket === s;
      if (wasUp) this.socket = undefined;
      for (const p of this.pending.values()) p.reject(new Error("the remy daemon went away"));
      this.pending.clear();
      if (wasUp) this.handlers.state?.(false);
      if (!this.closed) setTimeout(() => this.connect(), this.retryMs);
    });
    readLines(s, (m: ToClient) => {
      if (m.type === "event") return void Promise.resolve(this.handlers.event(m.event)).catch((e) => this.handlers.log("link: event failed", e?.message ?? e));
      if (m.type === "permission") return void Promise.resolve(this.handlers.permission(m.request_id, m.behavior)).catch(() => {});
      if (m.type === "replaced") {
        this.closed = true;
        return this.handlers.replaced?.();
      }
      if (m.type === "response") {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error !== undefined) p?.reject(new Error(m.error));
        else p?.resolve(m.result);
      }
    });
  }

  request<T = unknown>(request: Request, args?: unknown, timeoutMs = 60_000): Promise<T> {
    const s = this.socket;
    if (!s) return Promise.reject(new Error("the remy daemon isn't running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the remy daemon didn't answer within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      this.pending.set(id, { resolve: (v) => settle(() => resolve(v)), reject: (e) => settle(() => reject(e)) });
      send(s, { type: "request", id, request, args });
    });
  }

  permissionRequest(params: PermissionRequest) {
    if (!this.socket) return false;
    send(this.socket, { type: "permission_request", params });
    return true;
  }
}

/** One request on a fresh connection, without saying hello: for the CLI. Undefined when no daemon answers. */
export function askDaemon<T = unknown>(path: string, request: Request, args?: unknown, timeoutMs = 5_000) {
  return new Promise<T | undefined>((resolve, reject) => {
    const s = createConnection(path);
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      s.destroy();
      fn();
    };
    s.setTimeout(timeoutMs, () => done(() => resolve(undefined)));
    s.on("error", () => done(() => resolve(undefined)));
    s.on("close", () => done(() => resolve(undefined)));
    s.on("connect", () => send(s, { type: "request", id: 1, request, args }));
    readLines(s, (m: ToClient) => {
      if (m.type !== "response") return;
      done(() => (m.error !== undefined ? reject(new Error(m.error)) : resolve(m.result as T)));
    });
  });
}
