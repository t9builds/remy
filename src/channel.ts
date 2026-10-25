#!/usr/bin/env bun
/**
 * remy-slack: the coordinator's channel. Runs only inside the coordinator session (loaded by `remy start`).
 * - Reads your Slack DM with the bot in each configured workspace (polling or Socket Mode) and pushes
 *   your messages into the session.
 * - Watches the channels the bot is in for your mentions of it and your trigger-emoji reactions, and turns
 *   each into a task request (see watch.ts and task.ts). Agents started for one report in its thread.
 * - Tails ~/.remy/events.jsonl and pushes "agent needs input" / "background agent finished" right away.
 * - Every `digestMinutes`, diffs the session/PR snapshot and pushes the changes, if any.
 * - Exposes slack_post / slack_update so Claude can answer, and relays the coordinator's own permission prompts.
 * Sessions are routed to a workspace by GitHub repo or folder (see `workspaceFor`).
 */
import { appendFileSync, openSync, readSync, closeSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig, PATHS, readJson, readToken, workspaceFor, writeJson, type Workspace } from "./config";
import type { RemyEvent } from "./hook";
import { Slack, socketMode, type SlackMessage } from "./slack";
import { formatTable, githubRepoOf, listAgents, snapshotDiff, type Spawned } from "./snapshot";
import { formatTranscript, requestText, taskEvent, taskId, type SlackTask } from "./task";
import { ChannelWatcher, type Trigger, type WatchState } from "./watch";

/** A thread Remy follows, keyed by its root ts. `channel` is set for channel threads; DM threads leave it out. */
type ThreadInfo = { session?: string; expectReply: boolean; postedAt: number; lastSeen: string; channel?: string; task?: string };
type State = { lastTs?: string; threads: Record<string, ThreadInfo>; watch?: WatchState };

const config = loadConfig();
const log = (...a: unknown[]) => {
  try {
    appendFileSync(PATHS.log, `${new Date().toISOString()} ${a.map(String).join(" ")}\n`);
  } catch {}
};

const INSTRUCTIONS = `You are the remy coordinator. Events arrive as <channel source="remy-slack" kind="..." workspace="...">:
- kind="user_message": the user wrote to you in Slack. Answer with slack_post, passing the same workspace, and channel and thread_ts when the tag has them. If it has session, the user is replying in that agent's thread.
- kind="task_request": the user mentioned you, or reacted with the trigger emoji, in a channel thread. Follow "Tasks from Slack threads" in your instructions.
- kind="agent_needs_input": a session is blocked waiting for the user. Post it with slack_post(workspace, session=<name>, expect_reply=true).
- kind="agent_finished": a background agent ended its turn. Report it (name, PR link, status) with slack_post(workspace, session=<name>).
- kind="digest": sessions or PRs changed since the last digest. Post one compact summary to that workspace.
- kind="system": a note from the remy-slack server itself.
Always pass the event's workspace to slack_post. Slack text uses mrkdwn: *bold*, _italic_, \`code\`, <https://url|label>. Keep messages short.`;

const mcp = new Server(
  { name: "remy-slack", version: "0.3.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {}, "claude/channel/permission": {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
);

async function push(kind: string, content: string, meta: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v));
  log("push", kind, meta.workspace ?? "", content.slice(0, 120).replace(/\n/g, " "));
  await mcp.notification({ method: "notifications/claude/channel", params: { content, meta: { kind, ...clean } } });
}

const VERDICT = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

/** One Slack workspace: its DM with the bot, its threads, and how it reads new messages. */
class Bridge {
  readonly slack: Slack;
  private dm = "";
  private state: State;
  private lastInboundAt = 0;
  private tick = 0;

  constructor(readonly ws: Workspace, botToken: string) {
    this.slack = new Slack(botToken);
    this.state = readJson<State>(PATHS.slackState(ws.name), { threads: {} });
  }

  private save() {
    writeJson(PATHS.slackState(this.ws.name), this.state);
  }

  async ensureDm() {
    if (!this.dm) this.dm = await this.slack.openDm(this.ws.slackUserId);
    return this.dm;
  }

  /** Post to the DM, or to `channel` (a channel thread a task came from). */
  async post(text: string, opts: { channel?: string; thread_ts?: string; session?: string; expect_reply?: boolean } = {}) {
    const channel = opts.channel || undefined;
    const ts = await this.slack.post(channel ?? (await this.ensureDm()), text, opts.thread_ts || undefined);
    const root = opts.thread_ts || ts;
    const prev = this.state.threads[root];
    if (opts.session || opts.expect_reply || prev) {
      this.state.threads[root] = {
        ...prev,
        channel: channel ?? prev?.channel,
        session: opts.session ?? prev?.session,
        expectReply: !!opts.expect_reply || !!prev?.expectReply,
        postedAt: Date.now(),
        lastSeen: prev?.lastSeen ?? ts,
      };
      // DM threads matter for a day; a task's channel thread for as long as its agent might run.
      const now = Date.now();
      for (const [k, t] of Object.entries(this.state.threads)) if (t.postedAt < now - (t.channel ? 7 : 1) * 24 * 3600_000) delete this.state.threads[k];
      this.save();
    }
    if (opts.expect_reply) this.lastInboundAt = Date.now(); // poll fast while an answer is due
    return ts;
  }

  async update(ts: string, text: string, channel?: string) {
    await this.slack.update(channel || (await this.ensureDm()), ts, text);
  }

  private async handleInbound(m: SlackMessage, threadRoot?: string, channel?: string) {
    if (m.user !== this.ws.slackUserId || m.bot_id) return; // gate on sender, never on the channel
    if (m.subtype && m.subtype !== "thread_broadcast") return;
    this.lastInboundAt = Date.now();
    const v = VERDICT.exec(m.text);
    if (v) {
      await mcp.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id: v[2]!.toLowerCase(), behavior: v[1]!.toLowerCase().startsWith("y") ? "allow" : "deny" },
      });
      return;
    }
    const root = threadRoot ?? (m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined);
    const text = this.botUserId ? requestText(m.text, this.botUserId) : m.text;
    await push("user_message", text, {
      workspace: this.ws.name,
      ts: m.ts,
      channel: channel ?? "",
      thread_ts: root ?? "",
      session: root ? this.state.threads[root]?.session ?? "" : "",
    });
  }

  /** Socket Mode delivers thread replies as events too, so it needs no thread polling. */
  startSocket(appToken: string) {
    socketMode(appToken, (m) => this.handleInbound(m), (...a) => log(`[${this.ws.name}]`, ...a));
  }

  startPolling() {
    this.state.lastTs ??= (Date.now() / 1000).toFixed(6); // skip DM history from before the first start
    this.save();
    (async () => {
      let failures = 0;
      for (;;) {
        let delay = this.pollDelay();
        try {
          await this.pollOnce();
          failures = 0;
        } catch (e: any) {
          log(`[${this.ws.name}] poll error`, e?.message ?? e);
          delay = Math.max(delay, (e?.retryAfter || 30) * 1000);
          if (++failures === 3)
            await push("system", `Reading Slack workspace "${this.ws.name}" keeps failing: ${e?.message ?? e}. Tell the user in this terminal; check the bot scopes and that the app's Messages tab is on.`);
        }
        await Bun.sleep(delay);
      }
    })();
  }

  private async pollOnce() {
    const channel = await this.ensureDm();
    for (const m of await this.slack.history(channel, this.state.lastTs!)) {
      this.state.lastTs = m.ts;
      await this.handleInbound(m);
    }
    // Thread replies don't show up in history; check the threads that wait for an answer.
    if (this.tick++ % 2 === 0) {
      const waiting = Object.entries(this.state.threads)
        .filter(([, t]) => t.expectReply && !t.channel)
        .sort(([, a], [, b]) => b.postedAt - a.postedAt)
        .slice(0, 5);
      for (const [root, t] of waiting) {
        for (const m of await this.slack.replies(channel, root, t.lastSeen)) {
          t.lastSeen = m.ts;
          await this.handleInbound(m, root);
        }
      }
    }
    this.save();
  }

  // ---------- Channel threads: task triggers and replies in task threads ----------

  private botUserId = "";
  private watcher?: ChannelWatcher;

  /** Every 15 s: task threads waiting for an answer. Every 45 s: all channels, reactions and every task thread. */
  async startWatching() {
    let me: { userId: string; scopes: string[] };
    try {
      me = await this.slack.whoami();
    } catch (e: any) {
      log(`[${this.ws.name}] auth.test failed`, e?.message ?? e);
      return;
    }
    this.botUserId = me.userId;
    const missing = ["channels:read", "groups:read", "channels:history", "groups:history"].filter((s) => !me.scopes.includes(s));
    if (missing.length === 4) return log(`[${this.ws.name}] no channel scopes; channel tasks off`);
    if (missing.length) log(`[${this.ws.name}] missing ${missing.join(", ")}; some channels may not be readable`);

    this.state.watch ??= { channels: {}, handled: {} };
    this.watcher = new ChannelWatcher(this.slack, {
      me: this.ws.slackUserId,
      bot: this.botUserId,
      emoji: config.triggerEmoji,
      state: this.state.watch,
      isTracked: (channel, root) => this.state.threads[root]?.channel === channel,
      onTrigger: (t) => this.startTask(t),
      log: (...a) => log(`[${this.ws.name}]`, ...a),
    });
    let tick = 0;
    let failures = 0;
    for (;;) {
      const full = tick++ % 3 === 0;
      try {
        if (full) await this.watcher.scan();
        await this.pollChannelThreads(full);
        failures = 0;
      } catch (e: any) {
        log(`[${this.ws.name}] watch error`, e?.message ?? e);
        if (++failures === 5)
          await push("system", `Watching Slack channels in workspace "${this.ws.name}" keeps failing: ${e?.message ?? e}. Tell the user in this terminal.`);
        if (e?.retryAfter) await Bun.sleep(e.retryAfter * 1000);
      }
      this.save();
      await Bun.sleep(15_000);
    }
  }

  /** The user's replies in task threads. `all`: every task thread, else only those waiting for an answer. */
  private async pollChannelThreads(all: boolean) {
    const due = Object.entries(this.state.threads)
      .filter(([, t]) => t.channel && (all || (t.expectReply && Date.now() - t.postedAt < 30 * 60_000)))
      .sort(([, a], [, b]) => b.postedAt - a.postedAt)
      .slice(0, 10);
    for (const [root, t] of due) {
      for (const m of await this.slack.replies(t.channel!, root, t.lastSeen)) {
        t.lastSeen = m.ts;
        await this.handleInbound(m, root, t.channel);
      }
    }
  }

  /** Package the thread as a task: transcript, attachments, task.json, an :eyes: ack, then tell the coordinator. */
  private async startTask(t: Trigger) {
    const id = taskId(t.channel, t.root);
    const dir = PATHS.taskDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { messages, truncated } = await this.slack.thread(t.channel, t.root);
    const thread = messages.length ? messages : [t.message];

    const names = new Map<string, string>();
    for (const m of thread) for (const uid of [m.user, ...(m.text?.match(/<@([A-Z0-9]+)/g) ?? []).map((x) => x.slice(2))]) {
      if (uid && !names.has(uid)) names.set(uid, await this.slack.userName(uid));
    }

    const files = new Map<string, string[]>();
    let saved = 0;
    for (const m of thread) for (const f of m.files ?? []) {
      if (!f.url_private_download || (f.size ?? 0) > 20_000_000 || saved >= 10) continue;
      const path = join(dir, `${++saved}-${(f.name ?? "file").replace(/[^\w.-]+/g, "_")}`);
      try {
        await this.slack.download(f.url_private_download, path);
        files.set(m.ts, [...(files.get(m.ts) ?? []), path]);
      } catch (e: any) {
        log(`[${this.ws.name}] file download failed`, e?.message ?? e);
      }
    }

    const requester = await this.slack.userName(this.ws.slackUserId);
    const task: SlackTask = {
      id,
      workspace: this.ws.name,
      channel: t.channel,
      channelName: t.channelName,
      threadTs: t.root,
      triggerTs: t.message.ts,
      trigger: t.kind,
      permalink: await this.slack.permalink(t.channel, t.root).catch(() => ""),
      requester,
      request: t.kind === "mention" ? requestText(t.message.text, this.botUserId) : "",
      defaultRepo: this.ws.channelRepos?.[t.channelName],
      transcript: formatTranscript(thread, names, {
        triggerTs: t.message.ts,
        triggerNote: t.kind === "mention" ? `${requester} asked you here` : `${requester} reacted :${config.triggerEmoji}: here`,
        files,
      }),
      truncated,
      filesDir: saved ? dir : undefined,
      createdAt: Date.now(),
    };
    writeJson(join(dir, "task.json"), task);
    await this.slack.react(t.channel, t.message.ts, "eyes").catch(() => {});
    this.state.threads[t.root] = { channel: t.channel, task: id, expectReply: false, postedAt: Date.now(), lastSeen: thread.at(-1)!.ts };
    this.save();
    await push("task_request", taskEvent(task), {
      workspace: this.ws.name,
      task: id,
      channel: t.channel,
      thread_ts: t.root,
      default_repo: task.defaultRepo ?? "",
    });
  }

  private pollDelay() {
    const recentThread = Object.values(this.state.threads).some((t) => t.expectReply && Date.now() - t.postedAt < 30 * 60_000);
    return Date.now() - this.lastInboundAt < 10 * 60_000 || recentThread ? 4_000 : 15_000;
  }
}

const bridges = new Map<string, Bridge>();
const setupProblems: string[] = [];
for (const ws of config.workspaces) {
  const bot = readToken(ws.name, "bot");
  if (!bot || !ws.slackUserId) {
    setupProblems.push(`workspace "${ws.name}" has no bot token or Slack user ID`);
    continue;
  }
  bridges.set(ws.name, new Bridge(ws, bot));
}
if (!config.workspaces.length) setupProblems.push("no Slack workspace is configured");

const workspaceOf = (cwd?: string, repo?: string) => workspaceFor({ cwd, repo: repo ?? githubRepoOf(cwd) }, config)?.name ?? "";

function bridgeFor(workspace?: string, cwd?: string): Bridge {
  const b = (workspace && bridges.get(workspace)) || bridges.get(workspaceOf(cwd)) || bridges.values().next().value;
  if (!b) throw new Error("No Slack workspace is set up. Tell the user to run `remy setup` in a terminal.");
  return b;
}

// ---------- Tools ----------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "slack_post",
      description: "Post a message to the user's Slack DM with the bot, or in a channel thread. Returns the message ts.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Slack mrkdwn text" },
          workspace: { type: "string", description: `Workspace from the event tag. Configured: ${[...bridges.keys()].join(", ") || "none"}` },
          channel: { type: "string", description: "Channel ID from the event tag, to answer in a channel thread. Leave out for the DM." },
          thread_ts: { type: "string", description: "Reply in this thread" },
          session: {
            type: "string",
            description:
              "Agent session this message is about; replies in its thread come back tagged with it. For an agent started from a channel thread, leave channel and thread_ts out: the message goes to that thread.",
          },
          expect_reply: { type: "boolean", description: "Watch this message's thread for the user's reply (use for questions)" },
        },
        required: ["text"],
      },
    },
    {
      name: "slack_update",
      description: "Edit a message the bot posted earlier.",
      inputSchema: {
        type: "object",
        properties: { ts: { type: "string" }, text: { type: "string" }, workspace: { type: "string" }, channel: { type: "string" } },
        required: ["ts", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = (req.params.arguments ?? {}) as Record<string, any>;
  // An agent started from a channel thread reports in that thread.
  const origin = a.session && !a.channel && !a.thread_ts ? readJson<Spawned>(PATHS.spawned, {})[a.session]?.slack : undefined;
  if (origin) Object.assign(a, { workspace: origin.workspace, channel: origin.channel, thread_ts: origin.threadTs });
  const bridge = bridgeFor(a.workspace, a.session ? await cwdOfSession(a.session) : undefined);
  if (req.params.name === "slack_post") {
    const ts = await bridge.post(String(a.text), { channel: a.channel, thread_ts: a.thread_ts, session: a.session, expect_reply: a.expect_reply });
    return { content: [{ type: "text", text: `posted to ${bridge.ws.name}${a.channel ? ` ${a.channel}` : ""} ts=${ts}` }] };
  }
  if (req.params.name === "slack_update") {
    await bridge.update(String(a.ts), String(a.text), a.channel);
    return { content: [{ type: "text", text: "updated" }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

// Permission relay: the coordinator's own tool prompts go to the default workspace; "yes abcde" / "no abcde" answers.
const PermissionRequest = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
});
mcp.setNotificationHandler(PermissionRequest, async ({ params }) => {
  const preview = params.input_preview.length > 1500 ? params.input_preview.slice(0, 1500) + "…" : params.input_preview;
  await bridgeFor().post(
    `:lock: *remy wants to run ${params.tool_name}*: ${params.description}\n\`\`\`${preview}\`\`\`\nReply \`yes ${params.request_id}\` or \`no ${params.request_id}\``,
    { expect_reply: true },
  );
});

// ---------- Session events ----------

let agentsCache: { at: number; rows: Awaited<ReturnType<typeof listAgents>> } = { at: 0, rows: [] };
const cwdById = new Map<string, string>(); // latest cwd seen in hook events (sessions move into worktrees)

async function agents(maxAgeMs = 20_000) {
  if (Date.now() - agentsCache.at > maxAgeMs) {
    try {
      agentsCache = { at: Date.now(), rows: await listAgents() };
    } catch {}
  }
  return agentsCache.rows;
}

async function cwdOfSession(name: string) {
  const row = (await agents()).find((r) => r.name === name);
  return row ? cwdById.get(row.sessionId) ?? row.cwd : undefined;
}

async function sessionInfo(sessionId: string) {
  const row = (await agents()).find((r) => r.sessionId === sessionId);
  const spawned = readJson<Spawned>(PATHS.spawned, {});
  const isSpawned = !!row && (row.name in spawned || Object.values(spawned).some((s) => s.id && sessionId.startsWith(s.id)));
  return { name: row?.name ?? sessionId.slice(0, 8), status: row?.status, unattended: isSpawned || row?.kind === "background" };
}

const lastPushed = new Map<string, number>();
function debounced(key: string, ms = 60_000) {
  if (Date.now() - (lastPushed.get(key) ?? 0) < ms) return true;
  lastPushed.set(key, Date.now());
  return false;
}

const NEEDS_INPUT = new Set(["permission_prompt", "agent_needs_input", "elicitation_dialog"]);

async function onEvent(e: RemyEvent) {
  if (e.cwd) cwdById.set(e.session_id, e.cwd);
  const workspace = workspaceOf(e.cwd);
  if (e.event === "Notification" && e.type && NEEDS_INPUT.has(e.type)) {
    // Give whoever sits at that terminal a chance first; ping only if it's still blocked.
    setTimeout(async () => {
      agentsCache.at = 0;
      const s = await sessionInfo(e.session_id);
      if (s.status && s.status !== "waiting") return;
      if (debounced(`input:${e.session_id}`)) return;
      await push("agent_needs_input", e.message ?? "waiting for input", { workspace, session: s.name, reason: e.type ?? "", cwd: e.cwd ?? "" });
    }, 45_000);
    return;
  }
  if (e.event === "Stop" || e.event === "SessionEnd") {
    const s = await sessionInfo(e.session_id);
    if (!s.unattended || debounced(`done:${e.session_id}`, 30_000)) return;
    const what = e.event === "Stop" ? "finished its turn" : `ended (${e.type ?? "exit"})`;
    await push("agent_finished", `${s.name} ${what}.\n\nLast message:\n${e.last ?? "(none)"}`, { workspace, session: s.name, cwd: e.cwd ?? "" });
  }
}

function tailEvents() {
  let offset = 0;
  try {
    offset = statSync(PATHS.events).size; // only events from now on
  } catch {}
  let partial = "";
  setInterval(() => {
    let size = 0;
    try {
      size = statSync(PATHS.events).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // rotated
    if (size === offset) return;
    const fd = openSync(PATHS.events, "r");
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    const lines = (partial + buf.toString("utf8")).split("\n");
    partial = lines.pop() ?? "";
    for (const l of lines) {
      if (!l) continue;
      try {
        onEvent(JSON.parse(l)).catch((err) => log("event error", err));
      } catch {}
    }
  }, 2_000);
}

// ---------- Digest ----------

async function digest() {
  try {
    const { snapshot, changes, first } = await snapshotDiff();
    if (first || !changes.length) return;
    // One digest per workspace, each listing only that workspace's sessions.
    const names = new Set(config.workspaces.map((w) => w.name));
    if (!names.size) names.add("");
    for (const name of names) {
      const mine = changes.filter((c) => workspaceOf(c.cwd, c.repo) === name);
      if (!mine.length) continue;
      const sessions = snapshot.sessions.filter((s) => workspaceOf(s.cwd, s.repo) === name);
      const lines = mine.map((c) => `- ${c.session}: ${c.what} — ${c.detail}${c.pr ? ` (${c.pr})` : ""}`);
      await push("digest", `Changes since last digest:\n${lines.join("\n")}\n\nSessions in this workspace:\n${formatTable({ ...snapshot, sessions })}`, {
        workspace: name,
      });
    }
  } catch (e: any) {
    log("digest error", e?.message ?? e);
  }
}

// ---------- Start ----------

// Notifications sent before the client finishes initializing are dropped, so wait for it.
const initialized = new Promise<void>((r) => (mcp.oninitialized = () => r()));
// Stop polling Slack as soon as the coordinator goes away.
mcp.onclose = () => process.exit(0);
process.stdin.on("close", () => process.exit(0));
await mcp.connect(new StdioServerTransport());
await initialized;
log("started", [...bridges.keys()].join(","));

if (setupProblems.length) await push("system", `remy-slack setup is incomplete: ${setupProblems.join("; ")}. Tell the user to run \`remy setup\` in a terminal, then restart with \`remy start\`.`);
for (const b of bridges.values()) {
  const app = b.ws.transport === "socket" ? readToken(b.ws.name, "app") : undefined;
  if (b.ws.transport === "socket" && !app) {
    await push("system", `Workspace "${b.ws.name}" is set to Socket Mode but has no app-level token (xapp-…); reading it by polling instead.`);
  }
  if (app) b.startSocket(app);
  else b.startPolling();
  b.startWatching();
}
tailEvents();
await digest(); // stores the baseline on first run
setInterval(digest, config.digestMinutes * 60_000);
