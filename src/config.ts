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
  slackState: (workspace: string) => join(REMY_DIR, `slack-state.${workspace}.json`),
  tokenFile: (workspace: string, kind: TokenKind) => join(REMY_DIR, `slack-${kind}-token.${workspace}`),
};

export type TokenKind = "bot" | "app";
export type Transport = "poll" | "socket";

export type Workspace = {
  /** Short label, e.g. "work" or "personal". Names the keychain entries and state file. */
  name: string;
  /** Your Slack member ID (U…) in this workspace. Only messages from this user reach the coordinator. */
  slackUserId: string;
  /**
   * How remy reads your DMs. "poll" works when teammates share the Slack app.
   * "socket" (Socket Mode) is instant but only for an app nobody else runs remy with:
   * Slack hands each event to any one open connection.
   */
  transport: Transport;
  /** GitHub repos whose sessions report here, as "owner/name"; `*` matches anything, e.g. "acme-corp/*". Follows a repo into its worktrees. */
  repos?: string[];
  /** Sessions whose folder is under one of these report here. */
  paths?: string[];
};

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
};

export const DEFAULTS: Config = {
  workspaces: [],
  repoRoots: [join(homedir(), "Repositories")],
  spawnTemplate: "{task}",
  spawnPermissionMode: "auto",
  spawnWorktree: true,
  digestMinutes: 15,
  coordinatorName: "remy",
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

const keychainService = (workspace: string, kind: TokenKind) => `remy-slack-${kind}-token:${workspace}`;

export function readToken(workspace: string, kind: TokenKind): string | undefined {
  const envName = `REMY_SLACK_${kind.toUpperCase()}_TOKEN_${workspace.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
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

/** Store a token, asking for it without echo. macOS: keychain. Elsewhere: a 0600 file in ~/.remy. */
export function storeTokenInteractive(workspace: string, kind: TokenKind): boolean {
  ensureDir();
  if (process.platform === "darwin") {
    // `security … -w` with no value prompts for it without echoing.
    const r = Bun.spawnSync(["security", "add-generic-password", "-U", "-a", "remy", "-s", keychainService(workspace, kind), "-w"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return r.exitCode === 0;
  }
  const t = prompt(`${kind} token:`)?.trim();
  if (!t) return false;
  writeFileSync(PATHS.tokenFile(workspace, kind), t + "\n", { mode: 0o600 });
  return true;
}
