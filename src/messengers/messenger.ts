/**
 * What the channel server needs from a chat app (Slack or Telegram): post and edit messages, ask the user to approve
 * the coordinator's own tool calls, and read the user's messages. Each workspace in the config gets one; workspaces.ts
 * builds it.
 *
 * Ids are opaque strings each messenger makes and reads back: the coordinator copies them from event tags into
 * `thread` and `update`. Text is Slack mrkdwn everywhere; a messenger that formats differently converts it.
 */

export type PostOptions = {
  /** Answer in this thread: the `thread` or `id` from an event tag, or the id `post` returned. */
  thread?: string;
  /** Agent session the message is about; the user's replies to it come back tagged with it. */
  session?: string;
  /** A question: watch for the user's answer. */
  expect_reply?: boolean;
};

export type PermissionRequest = { request_id: string; tool_name: string; description: string; input_preview: string };

export interface Messenger {
  /** The workspace's name. */
  readonly workspace: string;
  /** Returns the new message's id. */
  post(text: string, opts?: PostOptions): Promise<string>;
  update(id: string, text: string): Promise<void>;
  /** Keep a message at the top of the chat, where the app can; quietly. */
  pin?(id: string): Promise<void>;
  askPermission(p: PermissionRequest): Promise<void>;
  /** The user answered `session`'s question somewhere else; stop treating it as open here. */
  answered(session: string): void;
  /** Start reading the user's messages in the background. */
  start(): Promise<void>;
}

/** How a bridge hands things to the coordinator session. */
export type Sink = {
  push(kind: string, content: string, meta?: Record<string, string>): Promise<void>;
  permission(requestId: string, behavior: "allow" | "deny"): Promise<void>;
  /** The answer when `text` is a command an extension registered (`/queue`), "" for one with no answer; else undefined. */
  command?(workspace: string, text: string): Promise<string | undefined>;
  /** The registered commands, for an app that lists them (Telegram's `/` menu). */
  commands?(): { name: string; description: string }[];
  log(...a: unknown[]): void;
};

/** One line of `remy doctor`. A failing `optional` check warns instead of failing. */
export type Check = { label: string; ok: boolean; hint?: string; optional?: boolean };

/** The checks that keep something from working. */
export const blocking = <C extends Check>(checks: C[]) => checks.filter((c) => !c.ok && !c.optional);

/** How long an agent's question counts as open, so a plain message may be its answer. */
export const AWAIT_ANSWER_MS = 30 * 60_000;

const VERDICT = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

/** "yes abcde" / "no abcde" answers a permission request. */
export function parseVerdict(text: string): { requestId: string; behavior: "allow" | "deny" } | undefined {
  const v = VERDICT.exec(text);
  return v ? { requestId: v[2]!.toLowerCase(), behavior: v[1]!.toLowerCase().startsWith("y") ? "allow" : "deny" } : undefined;
}

/** The permission request, in mrkdwn like every message. */
export function permissionText(p: PermissionRequest) {
  const preview = p.input_preview.length > 1500 ? `${p.input_preview.slice(0, 1500)}…` : p.input_preview;
  return `🔒 *remy wants to run ${p.tool_name}*: ${p.description}\n\`\`\`${preview}\`\`\``;
}
