#!/usr/bin/env bun
/**
 * remy: the coordinator's channel. Runs only inside the coordinator session (loaded by `remy start`).
 * A thin client of the daemon (daemon/daemon.ts), which owns Slack, Telegram, session events, the waiting list and the
 * notices it posts itself: it connects over the link (link/), pushes the daemon's events into the session, forwards
 * Claude's post / update calls, and relays the coordinator's own permission prompts both ways. When the daemon goes away it reconnects;
 * what the daemon pushed meanwhile arrives then.
 */
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LinkClient } from "./link/client";
import { coordinatorTools } from "./link/coordinator-tools";
import { PATHS } from "./shared/paths";
import { VERSION } from "./shared/version";

const log = (...a: unknown[]) => {
  try {
    appendFileSync(PATHS.log, `${new Date().toISOString()} channel ${a.map(String).join(" ")}\n`);
  } catch {}
};

const INSTRUCTIONS = `You are the remy coordinator. Events arrive as <channel source="remy" kind="..." workspace="...">. A workspace talks to the user in Slack, in Telegram, or both; post once and remy delivers it as the workspace is set up. With both, events carry via (the app the user wrote from); pass ids and threads back unchanged.
- kind="user_message": the user wrote to you. Answer with post, passing the same workspace, and thread when the tag has it. If it has session, the user is replying to that agent. If it has awaiting instead, that agent asked the user a question recently: if the message reads like the answer, treat it as a reply to that agent.
- kind="task_request": the user mentioned you, or reacted with the trigger emoji, in a Slack channel thread. Follow "Tasks from Slack threads" in your instructions.
- kind="agent_needs_input": a session is blocked waiting for the user. Post it with post(workspace, session=<name>, expect_reply=true).
- kind="agent_finished": a background agent ended its turn, or its session, on a question. Post the question with post(workspace, session=<name>, expect_reply=true).
- kind="system": a note from the remy daemon itself.
- kind="extension": one of the user's extensions (extension= names it) hands you something to handle. Do it as it asks, within your rules.
Remy itself keeps the pinned waiting-on-you list and posts merged PRs and ended sessions; don't post those.
An event with queued_at waited in the daemon while no coordinator was connected; check \`remy status\` before acting on an old one.
Always pass the event's workspace to post. Write Slack mrkdwn in every workspace (Telegram messages are converted): *bold*, _italic_, \`code\`, <https://url|label>. Use emoji characters, not :shortcodes:. Keep messages short.`;

const mcp = new Server(
  { name: "remy", version: VERSION },
  {
    capabilities: {
      experimental: { "claude/channel": {}, "claude/channel/permission": {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
);

const notify = (kind: string, content: string, meta: Record<string, string> = {}) =>
  mcp.notification({ method: "notifications/claude/channel", params: { content, meta: { kind, ...meta } } });

/** How long the daemon may be away before the coordinator hears about it; a restart takes less. */
const DOWN_NOTICE_MS = 15_000;
let downTimer: ReturnType<typeof setTimeout> | undefined;
let toldDown = false;
let replaced = false;

const link = new LinkClient(PATHS.socket, {
  event: (e) => notify(e.kind, e.content, e.meta),
  permission: (request_id, behavior) =>
    mcp.notification({ method: "notifications/claude/channel/permission", params: { request_id, behavior } }),
  state: (up) => {
    log(up ? "connected to the daemon" : "lost the daemon");
    clearTimeout(downTimer);
    if (up && toldDown) {
      toldDown = false;
      void notify("system", "The remy daemon is back; Slack and Telegram work again.");
    }
    if (!up && !replaced) downTimer = setTimeout(daemonDown, DOWN_NOTICE_MS);
  },
  replaced: () => {
    replaced = true;
    log("replaced by a newer coordinator");
    void notify(
      "system",
      "Another coordinator connected to the remy daemon, so this session no longer gets messages or can post. Tell the user in this terminal.",
    );
  },
  log,
});

function daemonDown() {
  if (link.connected || toldDown) return;
  toldDown = true;
  void notify(
    "system",
    "The remy daemon isn't running, so Slack and Telegram are off; messages wait in it once it's back. Tell the user in this terminal: `remy daemon` starts it (or `remy start` in a new terminal), `remy doctor` checks it.",
  );
}

// ---------- Tools ----------

// Claude asks for tools right after connecting, which can be before the link is up.
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: (await link.connectedWithin(3_000))
    ? await link.request("tools").catch(() => coordinatorTools("unknown (the remy daemon didn't answer)"))
    : coordinatorTools("none (the remy daemon isn't running)"),
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    await link.connectedWithin(3_000);
    return await link.request<any>("call", { name: req.params.name, arguments: req.params.arguments ?? {} });
  } catch (e: any) {
    return { isError: true, content: [{ type: "text", text: `${req.params.name} failed: ${e?.message ?? e}` }] };
  }
});

// Permission relay: the daemon asks in the workspace the user last wrote from; "yes abcde" / "no abcde" answers.
const PermissionRequestNotification = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});
mcp.setNotificationHandler(PermissionRequestNotification, async ({ params }) => {
  if (!link.permissionRequest(params)) log("permission request with no daemon", params.request_id);
});

// ---------- Start ----------

// Notifications sent before the client finishes initializing are dropped, so connect to the daemon after it.
const initialized = new Promise<void>((r) => (mcp.oninitialized = () => r()));
// Stop as soon as the coordinator goes away; the daemon holds what comes next.
mcp.onclose = () => process.exit(0);
process.stdin.on("close", () => process.exit(0));
await mcp.connect(new StdioServerTransport());
await initialized;
link.start();
downTimer = setTimeout(daemonDown, DOWN_NOTICE_MS);
log("started");
