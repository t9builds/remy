/**
 * The coordinator link: how the daemon and the coordinator's channel talk, over a Unix socket in ~/.remy.
 *
 * One JSON message per line. A connection that says `hello` is the coordinator; only the newest one is, and an older
 * one is closed. While no coordinator is connected, the daemon holds what it pushes and delivers it, in order, when
 * one connects. Other connections (`remy doctor`, `remy start`, `remy daemon stop`) only send requests.
 */
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import plugin from "../../.claude-plugin/plugin.json" with { type: "json" };
import type { PermissionRequest } from "../messengers/messenger";

export const VERSION: string = plugin.version;

/** What the daemon pushes into the coordinator session. */
export type LinkEvent = { kind: string; content: string; meta: Record<string, string> };

/** What `status` returns: enough for `remy doctor` and `remy start` to judge the daemon. */
export type DaemonStatus = {
  pid: number;
  version: string;
  startedAt: number;
  /** `configStamp()` of the config the daemon loaded. */
  config: number;
  /** Run by launchd or systemd, which start it again after `restart`. */
  supervised: boolean;
  coordinator: boolean;
  held: number;
  workspaces: string[];
  /** Extensions it loaded, and why any failed. */
  extensions: { name: string; from: string; error?: string }[];
};

/** `restart` exits with this code, so launchd or systemd start the daemon again; `stop` exits with 0, so they don't. */
export const RESTART_EXIT = 75;

export type Request = "tools" | "call" | "status" | "stop" | "restart";

type ToDaemon =
  | { type: "hello" }
  | { type: "permission_request"; params: PermissionRequest }
  | { type: "request"; id: number; request: Request; args?: any };

type ToClient =
  | { type: "event"; event: LinkEvent }
  | { type: "permission"; request_id: string; behavior: "allow" | "deny" }
  | { type: "replaced" }
  | { type: "response"; id: number; result?: unknown; error?: string };

/** Most events held for an absent coordinator; the oldest go first. */
export const HOLD_MAX = 500;

/** Split a stream into lines of JSON; a bad line is skipped. */
function readLines(socket: Socket, onMessage: (m: any) => void) {
  let partial = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const l of lines) {
      if (!l) continue;
      let m: unknown;
      try {
        m = JSON.parse(l);
      } catch {
        continue;
      }
      onMessage(m);
    }
  });
}

const send = (socket: Socket, m: ToDaemon | ToClient) => {
  if (!socket.destroyed) socket.write(JSON.stringify(m) + "\n");
};

/** The tools the coordinator gets. `working` lists the workspaces that work, for the `workspace` description. */
export function coordinatorTools(working: string) {
  return [
    {
      name: "post",
      description:
        "Send the user a message in a workspace: their Slack DM with the bot (or a Slack channel thread), or their Telegram chat. Returns the message id.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Slack mrkdwn text, in every workspace" },
          workspace: { type: "string", description: `Workspace from the event tag. Working: ${working || "none"}` },
          thread: { type: "string", description: "Answer in this thread: thread or id from the event tag, or an id post returned" },
          session: {
            type: "string",
            description:
              "Agent session this message is about; the user's replies come back tagged with it. For an agent started from a Slack channel thread, leave thread out: the message goes to that thread.",
          },
          expect_reply: { type: "boolean", description: "A question: watch for the user's answer" },
        },
        required: ["text"],
      },
    },
    {
      name: "update",
      description: "Edit a message the bot posted earlier.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The id post returned" },
          text: { type: "string" },
          workspace: { type: "string" },
        },
        required: ["id", "text"],
      },
    },
  ];
}

export type ServerHandlers = {
  /** Answer a request; a thrown error goes back to the caller. */
  request(request: Request, args: any): Promise<unknown>;
  permissionRequest(p: PermissionRequest): Promise<void>;
  /** Events every newly connected coordinator gets first, before the held ones (e.g. which workspaces are off). */
  greeting?(): Promise<LinkEvent[]>;
  /** What's held changed; keep it somewhere that outlives a crash. */
  held?(events: readonly LinkEvent[]): void;
  log(...a: unknown[]): void;
};

/** Whether something answers on the socket. */
function answers(path: string, timeoutMs = 1_000) {
  return new Promise<boolean>((resolve) => {
    const s = createConnection(path);
    const done = (ok: boolean) => (s.destroy(), resolve(ok));
    s.setTimeout(timeoutMs, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}

/** The daemon's end. */
export class LinkServer {
  private server?: Server;
  private coordinator?: Socket;
  private held: LinkEvent[] = [];

  constructor(
    readonly path: string,
    private handlers: ServerHandlers,
  ) {}

  get connected() {
    return !!this.coordinator;
  }

  /** What waits for the coordinator, oldest first. */
  get heldEvents(): readonly LinkEvent[] {
    return this.held;
  }

  /** Take over events another daemon held (they keep their `queued_at`). */
  hold(events: LinkEvent[]) {
    this.held.unshift(...events);
    this.held.splice(0, Math.max(0, this.held.length - HOLD_MAX));
    this.handlers.held?.(this.held);
  }

  /** Listen on the socket. Fails when another daemon already answers there; a stale socket file is replaced. */
  async listen() {
    if (existsSync(this.path)) {
      if (await answers(this.path)) throw new Error(`a remy daemon is already running (${this.path})`);
      unlinkSync(this.path);
    }
    this.server = createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.path, () => resolve());
    });
    chmodSync(this.path, 0o600);
  }

  close() {
    this.coordinator?.destroy();
    this.server?.close();
    try {
      unlinkSync(this.path);
    } catch {}
  }

  /** Deliver to the coordinator, or hold until one connects. */
  push(event: LinkEvent) {
    if (this.coordinator) return send(this.coordinator, { type: "event", event });
    this.held.push({ ...event, meta: { ...event.meta, queued_at: new Date().toISOString() } });
    if (this.held.length > HOLD_MAX) this.handlers.log("link: dropped held event", this.held.shift()!.kind);
    this.handlers.held?.(this.held);
  }

  /** A verdict on the coordinator's permission prompt. Without a coordinator, the session that asked is gone. */
  permission(request_id: string, behavior: "allow" | "deny") {
    if (this.coordinator) send(this.coordinator, { type: "permission", request_id, behavior });
    else this.handlers.log("link: permission verdict with no coordinator", request_id);
  }

  private accept(socket: Socket) {
    socket.on("error", (e) => this.handlers.log("link: socket error", e.message));
    socket.on("close", () => {
      if (this.coordinator !== socket) return;
      this.coordinator = undefined;
      this.handlers.log("link: coordinator disconnected");
    });
    readLines(socket, (m: ToDaemon) => {
      if (m.type === "hello") return void this.hello(socket);
      if (m.type === "permission_request")
        return void this.handlers.permissionRequest(m.params).catch((e) => this.handlers.log("link: permission request failed", e?.message ?? e));
      if (m.type === "request")
        this.handlers.request(m.request, m.args).then(
          (result) => send(socket, { type: "response", id: m.id, result }),
          (e) => send(socket, { type: "response", id: m.id, error: String(e?.message ?? e) }),
        );
    });
  }

  private async hello(socket: Socket) {
    // Until the greeting is ready, what's pushed is held, so it arrives after the greeting.
    const greeting = (await this.handlers.greeting?.().catch(() => [])) ?? [];
    if (socket.destroyed) return;
    if (this.coordinator && this.coordinator !== socket) {
      this.handlers.log("link: a newer coordinator connected; closing the old one");
      this.coordinator.end(JSON.stringify({ type: "replaced" } satisfies ToClient) + "\n");
    }
    this.coordinator = socket;
    const held = this.held;
    this.held = [];
    this.handlers.log("link: coordinator connected", held.length ? `delivering ${held.length} held` : "");
    for (const event of [...greeting, ...held]) send(socket, { type: "event", event });
    if (held.length) this.handlers.held?.(this.held);
  }
}

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
      const settle = (fn: () => void) => (clearTimeout(timer), fn());
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
