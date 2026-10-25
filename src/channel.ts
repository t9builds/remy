#!/usr/bin/env bun
/**
 * remy: the coordinator's channel. Runs only inside the coordinator session (loaded by `remy start`).
 * - Reads your messages in each configured workspace and pushes them into the session. A workspace is a Slack
 *   workspace (slack-bridge.ts, which also starts tasks from channel threads) or a Telegram chat (telegram-bridge.ts).
 * - Tails ~/.remy/events.jsonl and pushes "agent needs input" / "background agent finished" right away.
 * - Every `digestMinutes`, diffs the session/PR snapshot and pushes the changes, if any.
 * - Exposes post / update so Claude can answer, and relays the coordinator's own permission prompts.
 * Sessions are routed to a workspace by GitHub repo or folder (see `workspaceFor`).
 */
import { appendFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { messengerName, openWorkspaces } from "./bridges";
import { loadConfig, PATHS, readJson, workspaceFor, type Config } from "./config";
import type { RemyEvent } from "./hook";
import type { Messenger, Sink } from "./messenger";
import { threadRef } from "./slack-bridge";
import { formatTable, githubRepoOf, listAgents, snapshotDiff, type Spawned } from "./snapshot";

const config = loadConfig();
const log = (...a: unknown[]) => {
  try {
    appendFileSync(PATHS.log, `${new Date().toISOString()} ${a.map(String).join(" ")}\n`);
  } catch {}
};

const INSTRUCTIONS = `You are the remy coordinator. Events arrive as <channel source="remy" kind="..." workspace="...">. A workspace is a Slack workspace or a Telegram chat; the post tool sends to the right one.
- kind="user_message": the user wrote to you. Answer with post, passing the same workspace, and thread when the tag has it. If it has session, the user is replying to that agent. If it has awaiting instead, that agent asked the user a question recently: if the message reads like the answer, treat it as a reply to that agent.
- kind="task_request": the user mentioned you, or reacted with the trigger emoji, in a Slack channel thread. Follow "Tasks from Slack threads" in your instructions.
- kind="agent_needs_input": a session is blocked waiting for the user. Post it with post(workspace, session=<name>, expect_reply=true).
- kind="agent_finished": a background agent ended its turn. Report it (name, PR link, status) with post(workspace, session=<name>).
- kind="digest": sessions or PRs changed since the last digest. Post one compact summary to that workspace.
- kind="system": a note from the remy server itself.
Always pass the event's workspace to post. Write Slack mrkdwn in every workspace (Telegram messages are converted): *bold*, _italic_, \`code\`, <https://url|label>. Use emoji characters, not :shortcodes:. Keep messages short.`;

const mcp = new Server(
  { name: "remy", version: "0.5.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {}, "claude/channel/permission": {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
);

/** The workspace the user last wrote from; the coordinator's permission prompts go there. */
let lastActive = "";

async function push(kind: string, content: string, meta: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v));
  if (kind === "user_message" && meta.workspace) lastActive = meta.workspace;
  log("push", kind, meta.workspace ?? "", content.slice(0, 120).replace(/\n/g, " "));
  await mcp.notification({ method: "notifications/claude/channel", params: { content, meta: { kind, ...clean } } });
}

const sink: Sink = {
  push,
  permission: (request_id, behavior) => mcp.notification({ method: "notifications/claude/channel/permission", params: { request_id, behavior } }),
  log,
};

let bridges = new Map<string, Messenger>();
let off: { name: string; reason: string }[] = [];
/** The config with only the workspaces that work, so sessions of a broken one route to a working one. */
let active: Config = { ...config, workspaces: [] };
const ready = openWorkspaces(config.workspaces, sink, { triggerEmoji: config.triggerEmoji }).then((r) => {
  bridges = r.bridges;
  off = r.off;
  active = { ...config, workspaces: config.workspaces.filter((w) => bridges.has(w.name)) };
});

const workspaceOf = (cwd?: string, repo?: string) => workspaceFor({ cwd, repo: repo ?? githubRepoOf(cwd) }, active)?.name ?? "";

function bridgeFor(workspace?: string, cwd?: string): Messenger {
  const b = (workspace && bridges.get(workspace)) || bridges.get(workspaceOf(cwd)) || bridges.values().next().value;
  if (!b) throw new Error("No workspace is set up. Tell the user to run `remy setup` in a terminal.");
  return b;
}

// ---------- Tools ----------

mcp.setRequestHandler(ListToolsRequestSchema, async () => (await ready, {
  tools: [
    {
      name: "post",
      description:
        "Send the user a message in a workspace: their Slack DM with the bot (or a Slack channel thread), or their Telegram chat. Returns the message id.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Slack mrkdwn text, in every workspace" },
          workspace: {
            type: "string",
            description: `Workspace from the event tag. Working: ${active.workspaces.map((w) => `${w.name} (${messengerName(w)})`).join(", ") || "none"}`,
          },
          thread: { type: "string", description: "Answer in this thread: thread or id from the event tag, or an id post returned" },
          session: {
            type: "string",
            description:
              "Agent session this message is about; the user's replies come back tagged with it. For an agent started from a Slack channel thread, leave thread out: the message goes to that thread.",
          },
          expect_reply: { type: "boolean", description: "A question: watch for the user's answer" },
        },
        required: ["text"],
      },
    },
    {
      name: "update",
      description: "Edit a message the bot posted earlier.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The id post returned" },
          text: { type: "string" },
          workspace: { type: "string" },
        },
        required: ["id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  await ready;
  const a = (req.params.arguments ?? {}) as Record<string, any>;
  // An agent started from a Slack channel thread reports in that thread.
  const origin = a.session && !a.thread ? readJson<Spawned>(PATHS.spawned, {})[a.session]?.slack : undefined;
  if (origin) Object.assign(a, { workspace: origin.workspace, thread: threadRef(origin.channel, origin.threadTs) });
  const bridge = bridgeFor(a.workspace, a.session ? await cwdOfSession(a.session) : undefined);
  const rerouted = a.workspace && a.workspace !== bridge.ws.name ? ` ("${a.workspace}" is off, so this went to "${bridge.ws.name}")` : "";
  try {
    if (req.params.name === "post") {
      const id = await bridge.post(String(a.text), { thread: a.thread, session: a.session, expect_reply: a.expect_reply });
      return { content: [{ type: "text", text: `posted to ${bridge.ws.name} id=${id}${rerouted}` }] };
    }
    if (req.params.name === "update") {
      await bridge.update(String(a.id), String(a.text));
      return { content: [{ type: "text", text: "updated" }] };
    }
  } catch (e: any) {
    // Slack and Telegram errors carry their own `code`, which isn't a JSON-RPC one: report them as a failed call.
    return { isError: true, content: [{ type: "text", text: `${req.params.name} to ${bridge.ws.name} failed: ${e?.message ?? e}` }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

// Permission relay: the coordinator's own tool prompts go where the user last wrote from; "yes abcde" / "no abcde" answers.
const PermissionRequestNotification = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
});
mcp.setNotificationHandler(PermissionRequestNotification, async ({ params }) => {
  await ready;
  await bridgeFor(lastActive).askPermission(params);
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
    const names = new Set(bridges.keys());
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
// Stop polling as soon as the coordinator goes away.
mcp.onclose = () => process.exit(0);
process.stdin.on("close", () => process.exit(0));
await mcp.connect(new StdioServerTransport());
await initialized;
await ready;
log("started", [...bridges.keys()].join(","), off.length ? `off: ${off.map((o) => o.name).join(",")}` : "");

if (!config.workspaces.length) await push("system", "No workspace is configured. Tell the user in this terminal to run `remy setup`, then `remy start`.");
else if (!bridges.size) await push("system", `No workspace works: ${off.map((o) => `"${o.name}" (${o.reason})`).join("; ")}. Tell the user in this terminal; \`remy doctor\` shows what to fix.`);
else {
  const fallback = workspaceFor({}, active)?.name;
  for (const o of off)
    await push(
      "system",
      `Workspace "${o.name}" is off: ${o.reason}. Until it's fixed (\`remy setup ${o.name}\`, then restart), its sessions report to "${fallback}" and posts to "${o.name}" go there too. Don't post a separate hello for "${o.name}"; mention it in the hello to "${fallback}".`,
    );
}
for (const b of bridges.values())
  b.start().catch((e) => push("system", `Workspace "${b.ws.name}" failed to start: ${e?.message ?? e}. Tell the user in this terminal.`));
tailEvents();
await digest(); // stores the baseline on first run
setInterval(digest, config.digestMinutes * 60_000);
