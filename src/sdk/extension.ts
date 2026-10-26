/**
 * The extension API (ADR-0003). An extension is a module whose default export is `(remy: Remy) => void`; it reacts to
 * Remy's events and acts through `remy`. Remy's own behaviors beyond the relay (closing merged agents, tasks from
 * Slack threads, `/queue`, the factory) are extensions written against this same API, in src/extensions/.
 *
 * ```ts
 * import type { Remy } from "<remy plugin>/src/sdk/extension";
 * export default (remy: Remy) => {
 *   remy.on("pr.ci", async ({ session, pr }) => {
 *     if (pr.ci === "fail") await remy.post(`CI failed on ${pr.url}`, { session: session.name });
 *   });
 * };
 * ```
 */
import type { Config } from "./config";

export type Ci = "pass" | "fail" | "pending" | "none";

export type Pr = {
  number: number;
  url: string;
  title: string;
  state: string; // OPEN | MERGED | CLOSED
  draft: boolean;
  review: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  ci: Ci;
  failing: string[];
  /** Commit at the head of the PR branch. */
  head?: string;
};

/** A started agent: its name, its worktree label, the session id `claude --bg` printed, and its folder. */
export type SpawnResult = { name: string; label: string; id?: string; cwd: string; worktree: boolean; output: string };

/** A Claude Code session as extensions see it. */
export type SessionRef = {
  name: string;
  sessionId: string;
  cwd: string;
  /** GitHub "owner/name" when the checkout has a GitHub origin. */
  repo?: string;
  branch?: string;
  /** Remy started it (an agent), rather than you. */
  spawned: boolean;
  /** What it's for: an agent's task, else the session's first prompt. */
  about?: string;
  /** Set for an agent started with a `role` (e.g. the factory's step agents). */
  role?: string;
  /** As last seen: idle, busy or waiting. */
  status: string;
  /** Its branch's PR, as last seen. */
  pr?: Pr;
  /** The workspace it reports to. */
  workspace: string;
};

export type Events = {
  /** A session appeared. */
  "session.started": { session: SessionRef };
  /** A session waits for the user: it ended its turn on a question, or has been blocked on input for a while. */
  "session.asks": { session: SessionRef; question: string; reason: "question" | "permission_prompt" | "input" };
  /** A session ended its turn. */
  "session.stopped": { session: SessionRef; last?: string };
  /** A session is gone. `merged`: Remy closed it because its PR merged. */
  "session.ended": { session: SessionRef; reason?: string; merged?: boolean };
  /** A session's branch got a PR. */
  "pr.opened": { session: SessionRef; pr: Pr };
  /** A PR left draft (or was opened ready). */
  "pr.ready": { session: SessionRef; pr: Pr };
  /** A PR's CI finished: `pr.ci` is "pass" or "fail". */
  "pr.ci": { session: SessionRef; pr: Pr };
  "pr.merged": { session: SessionRef; pr: Pr };
  /**
   * The user wrote in a workspace. `kind` is "user_message", or "task_request" for a Slack channel thread the user
   * mentioned the bot in or reacted to (`task` is its id; see messengers/slack/task.ts). `session` is set when it's a reply to an agent.
   */
  message: { workspace: string; text: string; kind: "user_message" | "task_request"; session?: string; thread?: string; meta: Record<string, string> };
  /** Every `tickSeconds`, after Remy looked at the sessions again. */
  tick: { at: number };
};

export type EventName = keyof Events;

export type PostOptions = {
  /** Workspace to post in; else the session's, else the first. */
  workspace?: string;
  /** Agent session (or any label) the message is about: replies in its thread come back with `session` set. */
  session?: string;
  /** Answer in this thread (an id `post` returned, or an event's `thread`). */
  thread?: string;
};

/** One line of the waiting list. Rank 0 is the most urgent: 0 question, 1 red CI, 2 changes requested, 3 ready, 4 stopped. */
export type WaitingEntry = {
  /** Unique per extension; adding the same key again replaces it. */
  key: string;
  rank: 0 | 1 | 2 | 3 | 4;
  /** Why it waits on the user, e.g. `release check: "touches billing"`. */
  why: string;
  /** The one thing to do about it. */
  action: string;
  /** Shown as the line's name, e.g. a session name or "api#212". */
  label: string;
  /**
   * Which workspace's list: by session, else this workspace, else every workspace. An entry with a session replaces
   * that session's own line, unless that line is a question (rank 0).
   */
  session?: string;
  workspace?: string;
  url?: string;
  /** Show nothing, only keep `session`'s own line off the list: the extension is handling it. */
  hide?: boolean;
};

export type CommandContext = { workspace: string; session?: string; thread?: string };

export type Command = {
  description: string;
  /** What to answer; nothing posts nothing. */
  run(args: string, ctx: CommandContext): Promise<string | void> | string | void;
};

/** A small JSON store of the extension's own, kept across restarts in ~/.remy/state/. */
export type State = {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
};

export interface Remy {
  /** The extension's name: "builtin:<name>", the file name, or the package name. */
  readonly name: string;
  on<E extends EventName>(event: E, handler: (e: Events[E]) => void | Promise<void>): void;
  /** Post to the user. Returns the message id. */
  post(text: string, opts?: PostOptions): Promise<string>;
  /**
   * Ask the user and wait for the answer: the question is posted, sits on the waiting list as a judgment call until
   * answered, and the user's reply in its thread resolves the promise instead of reaching the coordinator.
   * `session` names the thread: an agent's name, or any label such as "factory:api#212".
   */
  ask(question: string, opts: PostOptions & { session: string }): Promise<string>;
  /**
   * Start a background agent, as `remy spawn` does. `prompt` replaces `spawnTemplate` with a whole prompt of your own;
   * `role` marks an agent that reports through `remy report` rather than its own PR, and keeps it off the waiting list.
   */
  spawn(opts: { repo: string; task: string; name?: string; worktree?: boolean; permissionMode?: string; prompt?: string; role?: string; pr?: string }): Promise<SpawnResult>;
  /**
   * Close a session: `claude rm` (session and worktree), or `claude stop` when the worktree has work left. Returns
   * what happened. `merged`: an agent closed because this PR merged; it then counts as merged (`remy status --merged`).
   */
  close(session: string, opts?: { merged?: Pr }): Promise<string>;
  waitingList: {
    add(entry: WaitingEntry): void;
    remove(key: string): void;
    /** The workspace's waiting list as the pinned message shows it. */
    text(workspace: string): Promise<string>;
  };
  coordinator: {
    /** Hand something to the coordinator for an LLM turn; `meta.kind` is the event kind it sees (default "extension"). */
    tell(text: string, meta?: Record<string, string>): void;
  };
  /** A command the user sends as `/name args` in any workspace; answered without the coordinator. */
  registerCommand(name: string, command: Command): void;
  state: State;
  /** Sessions as Remy last saw them. */
  sessions(): SessionRef[];
  /** The repos in `extensions.repos` that were found: whose own code (`.remy/`) you trust to run in your daemon. */
  trustedRepos(): { repo: string; root: string }[];
  /** Your ~/.remy/config.json, as the daemon loaded it. */
  readonly config: Readonly<Config>;
  log(...a: unknown[]): void;
}

export type Extension = (remy: Remy) => void | Promise<void>;
