/** Where Remy keeps its files: the plugin's own folder, and ~/.remy (or $REMY_DIR) for state. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The plugin's folder, the nearest one up with `.claude-plugin/plugin.json`: the bundle runs from dist/, the source
 * from src/ and below.
 */
export const PLUGIN_ROOT = (() => {
  for (let dir = import.meta.dir; dir !== dirname(dir); dir = dirname(dir))
    if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) return dir;
  return resolve(import.meta.dir, "..");
})();

export const REMY_DIR = process.env.REMY_DIR ?? join(homedir(), ".remy");
export const PATHS = {
  config: join(REMY_DIR, "config.json"),
  events: join(REMY_DIR, "events.jsonl"),
  snapshot: join(REMY_DIR, "snapshot.json"),
  /** Per workspace, the pinned "waiting on you" message: its id and what it says. */
  waitingList: join(REMY_DIR, "queue.json"),
  spawned: join(REMY_DIR, "spawned.json"),
  nicknames: join(REMY_DIR, "nicknames.json"),
  mcpConfig: join(REMY_DIR, "mcp.json"),
  /** The daemon's log; the coordinator's channel writes here too. */
  log: join(REMY_DIR, "daemon.log"),
  /** Where the daemon listens for the coordinator's channel (link/). */
  socket: join(REMY_DIR, "daemon.sock"),
  /** Events held for the coordinator when the daemon stopped, delivered by the next daemon. */
  held: join(REMY_DIR, "held.json"),
  /** Verdicts factory agents report with `remy report`, and `remy factory retry` requests, one JSON line each. */
  reports: join(REMY_DIR, "reports.jsonl"),
  /** Where each PR stands in its factory pipeline; written only by the daemon's factory extension. */
  factory: join(REMY_DIR, "state", "builtin_factory.json"),
  /** One folder per Slack task: task.json plus files downloaded from the thread. */
  taskDir: (id: string) => join(REMY_DIR, "tasks", id),
  slackState: (workspace: string) => join(REMY_DIR, `slack-state.${workspace}.json`),
  telegramState: (workspace: string) => join(REMY_DIR, `telegram-state.${workspace}.json`),
  /** `kind` is a `TokenKind` (config/config.ts). */
  tokenFile: (workspace: string, kind: string) => join(REMY_DIR, `${kind}-token.${workspace}`),
};
