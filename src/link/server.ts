/** The daemon's end of the link (protocol.ts): it listens, holds events while no coordinator is connected, and answers requests. */
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { PermissionRequest } from "../messengers/messenger";
import { HOLD_MAX, type LinkEvent, type Request, readLines, send, type ToClient, type ToDaemon } from "./protocol";

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
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
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
      this.coordinator.end(`${JSON.stringify({ type: "replaced" } satisfies ToClient)}\n`);
    }
    this.coordinator = socket;
    const held = this.held;
    this.held = [];
    this.handlers.log("link: coordinator connected", held.length ? `delivering ${held.length} held` : "");
    for (const event of [...greeting, ...held]) send(socket, { type: "event", event });
    if (held.length) this.handlers.held?.(this.held);
  }
}
