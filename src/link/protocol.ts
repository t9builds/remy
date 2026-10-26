/**
 * The coordinator link: how the daemon and the coordinator's channel talk, over a Unix socket in ~/.remy.
 *
 * One JSON message per line. A connection that says `hello` is the coordinator; only the newest one is, and an older
 * one is closed. While no coordinator is connected, the daemon holds what it pushes and delivers it, in order, when
 * one connects. Other connections (`remy doctor`, `remy start`, `remy daemon stop`) only send requests.
 */
import type { Socket } from "node:net";
import type { PermissionRequest } from "../messengers/messenger";

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

export type ToDaemon =
  | { type: "hello" }
  | { type: "permission_request"; params: PermissionRequest }
  | { type: "request"; id: number; request: Request; args?: any };

export type ToClient =
  | { type: "event"; event: LinkEvent }
  | { type: "permission"; request_id: string; behavior: "allow" | "deny" }
  | { type: "replaced" }
  | { type: "response"; id: number; result?: unknown; error?: string };

/** Most events held for an absent coordinator; the oldest go first. */
export const HOLD_MAX = 500;

/** Split a stream into lines of JSON; a bad line is skipped. */
export function readLines(socket: Socket, onMessage: (m: any) => void) {
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

export const send = (socket: Socket, m: ToDaemon | ToClient) => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(m)}\n`);
};
