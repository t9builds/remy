import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const REMY_DIR = process.env.REMY_DIR ?? join(homedir(), ".remy");
export const PATHS = {
  config: join(REMY_DIR, "config.json"),
  events: join(REMY_DIR, "events.jsonl"),
  snapshot: join(REMY_DIR, "snapshot.json"),
  spawned: join(REMY_DIR, "spawned.json"),
  mcpConfig: join(REMY_DIR, "mcp.json"),
  log: join(REMY_DIR, "channel.log"),
  /** One folder per Slack task: task.json plus files downloaded from the thread. */
  taskDir: (id: string) => join(REMY_DIR, "tasks", id),
  slackState: (workspace: string) => join(REMY_DIR, `slack-state.${workspace}.json`),
  telegramState: (workspace: string) => join(REMY_DIR, `telegram-state.${workspace}.json`),
  tokenFile: (workspace: string, kind: TokenKind) => join(REMY_DIR, `${kind}-token.${workspace}`),
};

/** Slack bot token (xoxb-), Slack app-level token (xapp-), Telegram bot token. */
export type TokenKind = "slack-bot" | "slack-app" | "telegram-bot";
export type Transport = "poll" | "socket";

/** Which sessions report to a workspace. */
export type Routing = {
  /** Short label, e.g. "work" or "personal". Names the keychain entries and state file. */
  name: string;
  /** GitHub repos whose sessions report here, as "owner/name"; `*` matches anything, e.g. "acme-corp/*". Follows a repo into its worktrees. */
  repos?: string[];
  /** Sessions whose folder is under one of these report here. */
  paths?: string[];
};

/** A Slack workspace. Configs from before Telegram have no `messenger`. */
export type SlackWorkspace = Routing & {
  messenger?: "slack";
  /** Your Slack member ID (U…) in this workspace. Only messages from this user reach the coordinator. */
  slackUserId: string;
  /**
   * How remy reads your DMs. "poll" works when teammates share the Slack app.
   * "socket" (Socket Mode) is instant but only for an app nobody else runs remy with:
   * Slack hands each event to any one open connection.
   */
  transport: Transport;
  /** Default repo per Slack channel for tasks started from a thread, e.g. { "bugs": "api" }. Repo as for `remy spawn --repo`. */
  channelRepos?: Record<string, string>;
};

/** Your private chat with your own Telegram bot. A bot serves one remy: Telegram hands its updates to a single reader. */
export type TelegramWorkspace = Routing & {
  messenger: "telegram";
  /** Your Telegram user ID. Only messages from this user reach the coordinator; it is also the chat remy writes to. */
  telegramUserId: number;
};

export type Workspace = SlackWorkspace | TelegramWorkspace;
export const isTelegram = (w: Workspace): w is TelegramWorkspace => w.messenger === "telegram";

export type Config = {
  workspaces: Workspace[];
  /** Folders that hold your repos; `remy spawn --repo <name>` looks here. */
  repoRoots: string[];
  /** Prompt sent to a spawned agent. `{task}` is replaced with the task text. */
  spawnTemplate: string;
  /** Permission mode for spawned agents. */
  spawnPermissionMode: string;
  /** Create a git worktree for each spawned agent (`claude -w`). */
  spawnWorktree: boolean;
  /** Minutes between change digests. */
  digestMinutes: number;
  /** Session name of the coordinator itself. */
  coordinatorName: string;
  /** Reacting with this emoji (Slack name, no colons) to a message starts a task, like mentioning the bot. */
  triggerEmoji: string;
};

export const DEFAULTS: Config = {
  workspaces: [],
  repoRoots: [join(homedir(), "Repositories")],
  spawnTemplate: "{task}",
  spawnPermissionMode: "auto",
  spawnWorktree: true,
  digestMinutes: 15,
  coordinatorName: "remy",
  triggerEmoji: "mouse",
};

export function ensureDir() {
  if (!existsSync(REMY_DIR)) mkdirSync(REMY_DIR, { recursive: true, mode: 0o700 });
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write via a temp file so a reader never sees half a file. */
export function writeJson(path: string, value: unknown, mode = 0o600) {
  ensureDir();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  renameSync(tmp, path);
}

export function expandHome(p: string) {
  return resolve(p.trim().replace(/^~(?=$|\/)/, homedir()));
}

export function loadConfig(): Config {
  const raw = readJson<Partial<Config> & { slackUserId?: string }>(PATHS.config, {});
  const config = { ...DEFAULTS, ...raw };
  // 0.1 configs had a single top-level slackUserId.
  if (!raw.workspaces && raw.slackUserId) config.workspaces = [{ name: "default", slackUserId: raw.slackUserId, transport: "poll" }];
  delete (config as any).slackUserId;
  return config;
}

export function saveConfig(config: Config) {
  writeJson(PATHS.config, config);
}

const isCatchAll = (w: Workspace) => !w.repos?.length && !w.paths?.length;

function globMatch(pattern: string, value: string) {
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return re.test(value);
}

/**
 * The workspace a session reports to: a `repos` match on its GitHub repo, else the longest `paths` match on its
 * folder, else the first workspace with neither (the catch-all), else the first workspace.
 */
export function workspaceFor(where: { cwd?: string; repo?: string }, config: Config): Workspace | undefined {
  const { cwd, repo } = where;
  if (repo) {
    const byRepo = config.workspaces.find((w) => w.repos?.some((p) => globMatch(p, repo)));
    if (byRepo) return byRepo;
  }
  let best: { ws: Workspace; len: number } | undefined;
  if (cwd) {
    for (const ws of config.workspaces) {
      for (const p of ws.paths ?? []) {
        const root = expandHome(p);
        if ((cwd === root || cwd.startsWith(root + sep)) && root.length > (best?.len ?? -1)) best = { ws, len: root.length };
      }
    }
  }
  return best?.ws ?? config.workspaces.find(isCatchAll) ?? config.workspaces[0];
}

const keychainService = (workspace: string, kind: TokenKind) => `remy-${kind}-token:${workspace}`;

/** Env `REMY_SLACK_BOT_TOKEN_<WS>`, `REMY_SLACK_APP_TOKEN_<WS>` or `REMY_TELEGRAM_BOT_TOKEN_<WS>`, then the keychain, then a file. */
export function readToken(workspace: string, kind: TokenKind): string | undefined {
  const envName = `REMY_${kind.toUpperCase().replace("-", "_")}_TOKEN_${workspace.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  if (process.env[envName]) return process.env[envName];
  if (process.platform === "darwin") {
    const r = Bun.spawnSync(["security", "find-generic-password", "-s", keychainService(workspace, kind), "-w"]);
    if (r.exitCode === 0) return r.stdout.toString().trim() || undefined;
  }
  try {
    return readFileSync(PATHS.tokenFile(workspace, kind), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** What each kind of token looks like, to catch a paste of the wrong one. */
export const TOKEN_FORMAT: Record<TokenKind, { pattern: RegExp; example: string }> = {
  "slack-bot": { pattern: /^xoxb-[\w-]+$/, example: "xoxb-…" },
  "slack-app": { pattern: /^xapp-[\w-]+$/, example: "xapp-…" },
  "telegram-bot": { pattern: /^\d+:[\w-]{30,}$/, example: "123456789:AA…" },
};

/** Store a token. macOS: keychain, handed over on stdin so it never shows in the process list. Elsewhere: a 0600 file in ~/.remy. */
export function storeToken(workspace: string, kind: TokenKind, token: string) {
  ensureDir();
  if (!TOKEN_FORMAT[kind].pattern.test(token)) throw new Error(`That doesn't look like a ${kind} token (${TOKEN_FORMAT[kind].example})`);
  if (process.platform === "darwin") {
    const cmd = `add-generic-password -U -a remy -s "${keychainService(workspace, kind)}" -w "${token}"\n`;
    const r = Bun.spawnSync(["security", "-i"], { stdin: new TextEncoder().encode(cmd), stdout: "pipe", stderr: "pipe" });
    const saved = Bun.spawnSync(["security", "find-generic-password", "-s", keychainService(workspace, kind), "-w"]).stdout.toString().trim();
    if (r.exitCode !== 0 || saved !== token) throw new Error(`Saving the ${kind} token to the keychain failed: ${r.stderr.toString().trim()}`);
    return;
  }
  writeFileSync(PATHS.tokenFile(workspace, kind), token + "\n", { mode: 0o600 });
}
