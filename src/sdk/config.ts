/** The shape of ~/.remy/config.json. Extensions read it as `remy.config`; config/config.ts loads and saves it. */
import type { Level } from "./factory";

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

export type MessengerKind = "slack" | "telegram";

export type SlackSettings = {
  /** Your Slack member ID (U…) in this workspace. Only messages from this user reach the coordinator. */
  userId: string;
  /**
   * How remy reads your DMs. "poll" works when teammates share the Slack app.
   * "socket" (Socket Mode) is instant but only for an app nobody else runs remy with:
   * Slack hands each event to any one open connection.
   */
  transport: Transport;
  /** Default repo per Slack channel for tasks started from a thread, e.g. { "bugs": "api" }. Repo as for `remy spawn --repo`. */
  channelRepos?: Record<string, string>;
  /**
   * Slack app IDs (A…) whose posts as you count as yours. Slack marks a message an app posts with your token as the
   * app's, and Remy ignores those unless the app is listed here; verify-remy drives Slack through its own app this way.
   */
  trustedApps?: string[];
};

/** Your private chat with your own Telegram bot. A bot serves one remy: Telegram hands its updates to a single reader. */
export type TelegramSettings = {
  /** Your Telegram user ID. Only messages from this user reach the coordinator; it is also the chat remy writes to. */
  userId: number;
};

/**
 * With Slack and Telegram both connected:
 * - "mirror": everything goes to both, and what you write in one shows in the other.
 * - "pings": everything goes to `main`; the other gets only questions and permission prompts.
 * - "follow": messages go to whichever you last wrote from (`main` until you have).
 */
export type BothMode = "mirror" | "pings" | "follow";

/** Where remy talks to you about a set of sessions: Slack, Telegram, or both. */
export type Workspace = Routing & {
  slack?: SlackSettings;
  telegram?: TelegramSettings;
  /** How Slack and Telegram work together when both are set. Default "mirror". */
  both?: BothMode;
  /** The app that gets everything with "pings", and that "follow" starts with. Default "slack". */
  main?: MessengerKind;
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
  /**
   * Context-window percentage (1–100) at which the coordinator compacts, passed as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.
   * 0 keeps Claude Code's default; a value already set in the shell wins.
   */
  coordinatorCompactPct: number;
  /** Reacting with this emoji (Slack name, no colons) to a message starts a task, like mentioning the bot. */
  triggerEmoji: string;
  /** Seconds between looks at the sessions and their PRs, which raise extension events; also the `tick` interval. */
  tickSeconds: number;
  /**
   * The most you allow your own Remy to do with a change (ADR-0006): "notify", "verify", "merge", "deploy-dev" or
   * "deploy-prod". A repo's factory.ts sets the most its team allows; the lower of the two applies.
   */
  autonomy: Level;
  /** Factory agents (verifiers, checks) running at once, on your subscription. */
  maxFactoryAgents: number;
  /** Extensions beyond your own in ~/.remy/extensions (extension-host/load.ts). */
  extensions?: {
    /** Repos whose .remy/extensions run in your daemon: paths, or names under `repoRoots`. */
    repos?: string[];
    /** npm packages installed in ~/.remy. */
    packages?: string[];
    /** Extensions not to load, by name: a built-in ("merged-cleanup", "slack-tasks", "queue", "factory"), a file name, "<repo>/<file>" or a package. */
    disabled?: string[];
  };
};
