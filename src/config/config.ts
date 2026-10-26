/** `~/.remy/config.json`: loading, defaults and saving it, which workspace a session belongs to, and the tokens beside it. */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Config, MessengerKind, Workspace } from "../sdk/config";
import { ensureDir, readJson, writeJson } from "../shared/json-file";
import { PATHS } from "../shared/paths";

/** Slack bot token (xoxb-), Slack app-level token (xapp-), Telegram bot token. */
export type TokenKind = "slack-bot" | "slack-app" | "telegram-bot";

const MESSENGERS: MessengerKind[] = ["slack", "telegram"];
export const messengerLabel = (k: MessengerKind) => (k === "slack" ? "Slack" : "Telegram");

export const messengersOf = (ws: Workspace) => MESSENGERS.filter((k) => ws[k]);

/** Configs from before 0.6 had one messenger per workspace, as flat fields. */
function migrateWorkspace(w: any): Workspace {
  if (w.slack || w.telegram) return w;
  const { messenger, slackUserId, transport, channelRepos, telegramUserId, ...routing } = w;
  if (messenger === "telegram") return { ...routing, telegram: { userId: telegramUserId } };
  return { ...routing, slack: { userId: slackUserId ?? "", transport: transport ?? "poll", channelRepos } };
}

export const DEFAULTS: Config = {
  workspaces: [],
  repoRoots: [join(homedir(), "Repositories")],
  spawnTemplate: "{task}",
  spawnPermissionMode: "auto",
  spawnWorktree: true,
  digestMinutes: 15,
  coordinatorName: "remy",
  coordinatorCompactPct: 50,
  triggerEmoji: "mouse",
  tickSeconds: 60,
  autonomy: "notify",
  maxFactoryAgents: 2,
};

/** `coordinatorCompactPct` as a whole percentage from 1 to 100, else undefined: Claude Code's default. */
export function compactPct(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : undefined;
}

/** What the coordinator's environment gets for compaction. A value already set in the shell wins over the config. */
export function compactEnv(
  value: unknown,
  shell: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const pct = compactPct(value);
  return pct && !shell.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(pct) } : {};
}

export function expandHome(p: string) {
  return resolve(p.trim().replace(/^~(?=$|\/)/, homedir()));
}

export function loadConfig(): Config {
  const raw = readJson<Partial<Config> & { slackUserId?: string }>(PATHS.config, {});
  const config = { ...DEFAULTS, ...raw };
  // 0.1 configs had a single top-level slackUserId.
  if (!raw.workspaces && raw.slackUserId)
    config.workspaces = [{ name: "default", slack: { userId: raw.slackUserId, transport: "poll" } }];
  config.workspaces = config.workspaces.map(migrateWorkspace);
  delete (config as any).slackUserId;
  return config;
}

/** When the config was last written, so a daemon started before a change can be told apart. 0 when there is none. */
export function configStamp() {
  try {
    return statSync(PATHS.config).mtimeMs;
  } catch {
    return 0;
  }
}

export function saveConfig(config: Config) {
  writeJson(PATHS.config, config);
}

const isCatchAll = (w: Workspace) => !w.repos?.length && !w.paths?.length;

function globMatch(pattern: string, value: string) {
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "i",
  );
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
        if ((cwd === root || cwd.startsWith(root + sep)) && root.length > (best?.len ?? -1))
          best = { ws, len: root.length };
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
  if (!TOKEN_FORMAT[kind].pattern.test(token))
    throw new Error(`That doesn't look like a ${kind} token (${TOKEN_FORMAT[kind].example})`);
  if (process.platform === "darwin") {
    const cmd = `add-generic-password -U -a remy -s "${keychainService(workspace, kind)}" -w "${token}"\n`;
    const r = Bun.spawnSync(["security", "-i"], {
      stdin: new TextEncoder().encode(cmd),
      stdout: "pipe",
      stderr: "pipe",
    });
    const saved = Bun.spawnSync(["security", "find-generic-password", "-s", keychainService(workspace, kind), "-w"])
      .stdout.toString()
      .trim();
    if (r.exitCode !== 0 || saved !== token)
      throw new Error(`Saving the ${kind} token to the keychain failed: ${r.stderr.toString().trim()}`);
    return;
  }
  writeFileSync(PATHS.tokenFile(workspace, kind), `${token}\n`, { mode: 0o600 });
}
